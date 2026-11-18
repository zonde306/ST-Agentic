import type { HostBridge } from '@/core/bridge';
import type {
    ClassifiedLoreEntry,
    LoreReadContext,
    LoreReadHook,
    MessageTarget,
    RawLoreEntry,
} from '@/core/types';
import { buildLoreOverrideKey, buildLoreVfsPath } from './classifier';
import { DecoratorParser } from './decorators';

const EJS_DETECT_PATTERN = /<%[\s\S]*?%>/;

export type LoreOverrideSource = ReadonlyMap<string, string> | Record<string, string>;

export type LoreOverrideResolver = (
    world: string,
    uid: number,
    target?: MessageTarget,
) => string | null | undefined | Promise<string | null | undefined>;

export type LoreReadRegexCallback = (
    text: string,
    context: { world: string; uid: number; path: string },
) => string | Promise<string>;

export interface LoreReadEvaluatorOptions {
    /** Optional resolver reading the active `worldinfo` override for `(world, uid, target)`. */
    getOverride?: LoreOverrideResolver;
    /** Optional override map/record keyed by VFS path or `${world}/${uid}`. */
    overrides?: LoreOverrideSource;
    /** Optional `lore_read` regex stage callback applied after macro and EJS rendering. */
    applyLoreReadRegex?: LoreReadRegexCallback;
    /** Error policy when `HostBridge.evaluateOptionalEjs` throws (default `'fallback'`). */
    onEjsError?: 'fallback' | 'throw';
}

export interface LoreEvaluateOptions {
    target?: MessageTarget;
    overrideContent?: string | null;
    getOverride?: LoreOverrideResolver;
    overrides?: LoreOverrideSource;
    vars?: Record<string, unknown>;
    macroOverrides?: Record<string, string>;
    applyLoreReadRegex?: LoreReadRegexCallback;
    onEjsError?: 'fallback' | 'throw';
}

export interface LoreReadResult {
    path: string;
    world: string;
    uid: number;
    text: string;
    contentHash: string;
    charCount: number;
    overridden: boolean;
    ejsEvaluated: boolean;
    ejsError?: string;
}

function isClassifiedEntry(
    input: RawLoreEntry | ClassifiedLoreEntry,
): input is ClassifiedLoreEntry {
    return 'entry' in input && 'vfsPath' in input;
}

function stringifyMacroVar(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function extractMetadataVariables(metadata: Record<string, unknown>): Record<string, unknown> {
    const raw = metadata?.variables;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { ...(raw as Record<string, unknown>) };
    }
    return {};
}

function lookupStaticOverride(
    source: LoreOverrideSource | undefined,
    world: string,
    uid: number,
    vfsPath: string,
): string | undefined {
    if (!source) {
        return undefined;
    }

    const candidateKeys = [
        vfsPath,
        buildLoreOverrideKey(world, uid),
        `${world}:${uid}`,
        `${world}#${uid}`,
    ];

    if (source instanceof Map) {
        for (const key of candidateKeys) {
            if (source.has(key)) {
                return source.get(key);
            }
        }
        return undefined;
    }

    const record = source as Record<string, string>;
    for (const key of candidateKeys) {
        if (Object.hasOwn(record, key)) {
            return record[key];
        }
    }
    return undefined;
}

/**
 * Read-time sandbox pipeline for World Info entries:
 * `worldinfo` override -> `HostBridge.substituteMacros` -> optional `HostBridge.evaluateOptionalEjs`
 * -> `lore_read` regex callback -> `HostBridge.hashText` (`xxHash`).
 */
export class LoreReadEvaluator {
    public readonly hostBridge: HostBridge;
    private readonly options: LoreReadEvaluatorOptions;

    constructor(hostBridge: HostBridge, options: LoreReadEvaluatorOptions = {}) {
        this.hostBridge = hostBridge;
        this.options = { ...options };
    }

    public async evaluate(
        input: RawLoreEntry | ClassifiedLoreEntry,
        callOptions?: LoreEvaluateOptions,
    ): Promise<LoreReadResult> {
        let rawEntry: RawLoreEntry;
        let baseClean: string;
        let vfsPath: string;

        if (isClassifiedEntry(input)) {
            rawEntry = input.entry;
            baseClean = input.cleanContent;
            vfsPath = input.vfsPath;
        } else {
            rawEntry = input;
            const parsed = DecoratorParser.parseEntry(rawEntry);
            baseClean = parsed.cleanContent;
            vfsPath = buildLoreVfsPath(rawEntry, parsed.decorators);
        }

        const resolvedOverride = await this.resolveOverride(
            rawEntry.world,
            rawEntry.uid,
            vfsPath,
            callOptions,
        );

        const initialText = resolvedOverride !== null ? resolvedOverride : baseClean;
        return this.runPipeline({
            world: rawEntry.world,
            uid: rawEntry.uid,
            path: vfsPath,
            initialText,
            overridden: resolvedOverride !== null,
            callOptions,
        });
    }

    public async evaluateFromContext(
        context: LoreReadContext,
        callOptions?: Omit<LoreEvaluateOptions, 'overrideContent' | 'target'>,
    ): Promise<LoreReadResult> {
        const hasOverride = context.overriddenContent !== undefined;
        const initialText = hasOverride
            ? context.overriddenContent!
            : DecoratorParser.parse(context.rawContent ?? '').cleanContent;

        return this.runPipeline({
            world: context.world,
            uid: context.uid,
            path: context.path,
            initialText,
            overridden: hasOverride,
            callOptions: {
                ...callOptions,
                target: context.target,
            },
        });
    }

    /** Create a `LoreReadHook` adapter compatible with VFS `/lorebooks/*` reads. */
    public toLoreReadHook(
        baseOptions?: Omit<LoreEvaluateOptions, 'overrideContent' | 'target'>,
    ): LoreReadHook {
        return async (context: LoreReadContext): Promise<string> => {
            const result = await this.evaluateFromContext(context, baseOptions);
            return result.text;
        };
    }

    private async resolveOverride(
        world: string,
        uid: number,
        vfsPath: string,
        callOptions?: LoreEvaluateOptions,
    ): Promise<string | null> {
        if (callOptions?.overrideContent !== undefined && callOptions.overrideContent !== null) {
            return callOptions.overrideContent;
        }

        const target = callOptions?.target;
        const callResolver = callOptions?.getOverride;
        if (callResolver) {
            const resolved = await callResolver(world, uid, target);
            if (resolved !== undefined && resolved !== null) {
                return resolved;
            }
        }

        const instanceResolver = this.options.getOverride;
        if (instanceResolver) {
            const resolved = await instanceResolver(world, uid, target);
            if (resolved !== undefined && resolved !== null) {
                return resolved;
            }
        }

        const callMapOverride = lookupStaticOverride(callOptions?.overrides, world, uid, vfsPath);
        if (callMapOverride !== undefined) {
            return callMapOverride;
        }

        const instanceMapOverride = lookupStaticOverride(this.options.overrides, world, uid, vfsPath);
        if (instanceMapOverride !== undefined) {
            return instanceMapOverride;
        }

        return null;
    }

    private async runPipeline(params: {
        world: string;
        uid: number;
        path: string;
        initialText: string;
        overridden: boolean;
        callOptions?: LoreEvaluateOptions;
    }): Promise<LoreReadResult> {
        const { world, uid, path, initialText, overridden, callOptions } = params;

        const metadataVars = extractMetadataVariables(this.hostBridge.getMetadata());
        const effectiveVars: Record<string, unknown> = {
            ...metadataVars,
            ...(callOptions?.vars ?? {}),
        };

        const macroOverrides: Record<string, string> = {};
        if (callOptions?.vars) {
            for (const [k, v] of Object.entries(callOptions.vars)) {
                macroOverrides[`var:${k}`] = stringifyMacroVar(v);
            }
        }
        if (callOptions?.macroOverrides) {
            Object.assign(macroOverrides, callOptions.macroOverrides);
        }

        const hasMacroOverrides = Object.keys(macroOverrides).length > 0;
        let workingText = this.hostBridge.substituteMacros(
            initialText,
            hasMacroOverrides ? macroOverrides : undefined,
        );

        let ejsEvaluated = false;
        let ejsError: string | undefined;

        if (this.hostBridge.evaluateOptionalEjs && EJS_DETECT_PATTERN.test(workingText)) {
            const errorPolicy = callOptions?.onEjsError ?? this.options.onEjsError ?? 'fallback';
            try {
                workingText = await this.hostBridge.evaluateOptionalEjs(workingText, effectiveVars);
                ejsEvaluated = true;
            } catch (error) {
                if (errorPolicy === 'throw') {
                    throw error;
                }
                ejsError = error instanceof Error ? error.message : String(error);
            }
        }

        const regexCallback = callOptions?.applyLoreReadRegex ?? this.options.applyLoreReadRegex;
        if (regexCallback) {
            workingText = await regexCallback(workingText, { world, uid, path });
        }

        const contentHash = await this.hostBridge.hashText(workingText);

        return {
            path,
            world,
            uid,
            text: workingText,
            contentHash,
            charCount: workingText.length,
            overridden,
            ejsEvaluated,
            ...(ejsError !== undefined ? { ejsError } : {}),
        };
    }
}
