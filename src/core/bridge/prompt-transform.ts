import type { MessageTarget } from '../types';
import type { EjsEvaluateOptions, EjsRenderSession, HostBridge, PromptInjectionSession } from './host-bridge';

export const PROMPT_TRANSFORM_EVENTS = {
    TRANSFORM: 'agentic_prompt_transform',
    TURN_START: 'agentic_turn_transform_start',
    TURN_END: 'agentic_turn_transform_end',
    OUTPUT_PROCESS: 'agentic_output_process',
} as const;

export type PromptTransformSource =
    | 'prompt_block'
    | 'system_rule'
    | 'dynamic_reminder'
    | 'user_input'
    | 'chat_message'
    | 'trigger_prompt'
    | 'vfs_read'
    | 'lore_radar'
    | 'lore_outlet'
    | 'lore_precollect';

export type PromptTransformLayer =
    | 'layer0_prefix'
    | 'layer1_ephemeral'
    | 'layer2_tail'
    | 'layer2_floating'
    | 'tool_read'
    | 'trigger';

export type PromptTransformRole = 'system' | 'user' | 'assistant' | 'tool';

export interface PromptTransformLoreMeta {
    readonly world: string;
    readonly uid: number;
    readonly comment: string;
    readonly overridden: boolean;
}

export interface PromptTransformMeta {
    readonly sessionId: string;
    readonly agentId?: string;
    readonly phase?: string;
    readonly target?: MessageTarget;
    readonly isChatMessage: boolean;
    readonly messageId?: number;
    readonly swipeId?: number;
    readonly name?: string;
    readonly isUser?: boolean;
    readonly blockId?: string;
    readonly blockName?: string;
    readonly placement?: 'prefix' | 'tail' | 'floating_tail';
    readonly path?: string;
    readonly mount?: string;
    readonly editable?: boolean;
    readonly writable?: boolean;
    readonly lore?: PromptTransformLoreMeta;
    readonly vars?: Readonly<Record<string, unknown>>;
    readonly isPrivate?: boolean;
    readonly injectionSession?: PromptInjectionSession;
    readonly ejsSession?: EjsRenderSession;
}

export type PromptTransformInputMeta = Omit<PromptTransformMeta, 'isChatMessage'> & {
    readonly isChatMessage?: boolean;
};

export interface PromptTransformCacheControl {
    readonly cacheable: boolean;
    disable(reason?: string, extId?: string): void;
    addKey(namespace: string, key: string): void;
    readonly reasons: readonly string[];
    getKeys(): Readonly<Record<string, string>>;
}

export interface PromptTransformErrorEntry {
    readonly error: Error;
    readonly extId?: string;
}

export interface PromptTransformPayload {
    readonly version: 1;
    text: string;
    readonly rawText: string;
    readonly source: PromptTransformSource;
    readonly layer: PromptTransformLayer;
    readonly role?: PromptTransformRole;
    readonly dryRun: boolean;
    readonly meta: PromptTransformMeta;
    readonly sessionBag: Record<string, unknown>;
    readonly handledSyntaxes: Set<string>;
    readonly cache: PromptTransformCacheControl;
    readonly signal?: AbortSignal;
    reportError(error: unknown, extId?: string): void;
    readonly errors: ReadonlyArray<PromptTransformErrorEntry>;
}

export interface PromptTransformInput {
    text: string;
    source: PromptTransformSource;
    layer: PromptTransformLayer;
    role?: PromptTransformRole;
    dryRun?: boolean;
    meta: PromptTransformInputMeta;
    sessionBag?: Record<string, unknown>;
    signal?: AbortSignal;
    onError?: 'fallback' | 'throw' | ((error: Error) => void);
}

export interface PromptTransformResult {
    text: string;
    changed: boolean;
    cacheable: boolean;
    cacheKeys: Readonly<Record<string, string>>;
    cacheDisableReasons: readonly string[];
    handledSyntaxes: ReadonlySet<string>;
    errors: ReadonlyArray<PromptTransformErrorEntry>;
}

export interface PromptTransformTurnLifecyclePayload {
    readonly version: 1;
    readonly sessionId: string;
    readonly agentId?: string;
    readonly phase?: string;
    readonly target?: MessageTarget;
    readonly messageId?: number;
    readonly swipeId?: number;
    readonly vars?: Readonly<Record<string, unknown>>;
    readonly sessionBag: Record<string, unknown>;
    readonly signal?: AbortSignal;
}

export type PromptTransformListener = (payload: PromptTransformPayload) => Promise<void> | void;
export type PromptTransformTurnLifecycleListener = (
    payload: PromptTransformTurnLifecyclePayload,
) => Promise<void> | void;

export type EjsTextEvaluator = (
    text: string,
    vars: Record<string, unknown>,
    options?: EjsEvaluateOptions,
) => Promise<string> | string;

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

function toError(err: unknown): Error {
    return err instanceof Error ? err : new Error(String(err));
}

/**
 * Create a monotonic cache-control handle for `agentic_prompt_transform` listeners.
 * Once `disable()` is called by any extension, `cacheable` remains permanently `false`.
 */
export function createPromptTransformCacheControl(): PromptTransformCacheControl {
    let isCacheable = true;
    const reasonsList: string[] = [];
    const keysMap = new Map<string, string>();

    return {
        get cacheable(): boolean {
            return isCacheable;
        },
        disable(reason?: string, extId?: string): void {
            isCacheable = false;
            const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
            const trimmedExtId = typeof extId === 'string' ? extId.trim() : '';
            if (trimmedExtId && trimmedReason) {
                reasonsList.push(`${trimmedExtId}: ${trimmedReason}`);
            } else if (trimmedReason) {
                reasonsList.push(trimmedReason);
            } else if (trimmedExtId) {
                reasonsList.push(trimmedExtId);
            }
        },
        addKey(namespace: string, key: string): void {
            const ns = typeof namespace === 'string' ? namespace.trim() : '';
            const val = typeof key === 'string' ? key : String(key ?? '');
            if (!ns || !val) {
                return;
            }
            keysMap.set(ns, val);
        },
        get reasons(): readonly string[] {
            return reasonsList;
        },
        getKeys(): Readonly<Record<string, string>> {
            const sorted: Record<string, string> = {};
            const namespaces = Array.from(keysMap.keys()).sort(compareCodeUnits);
            for (const ns of namespaces) {
                sorted[ns] = keysMap.get(ns)!;
            }
            return sorted;
        },
    };
}

/** Construct a `PromptTransformPayload` for dispatching `agentic_prompt_transform`. */
export function createPromptTransformPayload(input: PromptTransformInput): PromptTransformPayload {
    const cache = createPromptTransformCacheControl();
    const errorsList: PromptTransformErrorEntry[] = [];
    const sessionBag = input.sessionBag ?? {};
    const handledSyntaxes = new Set<string>();
    const resolvedTarget: MessageTarget | undefined =
        input.meta.target
        ?? (input.meta.messageId !== undefined && input.meta.swipeId !== undefined
            ? { messageId: input.meta.messageId, swipeId: input.meta.swipeId }
            : undefined);
    const resolvedMessageId = input.meta.messageId ?? resolvedTarget?.messageId;
    const resolvedSwipeId = input.meta.swipeId ?? resolvedTarget?.swipeId;

    return {
        version: 1,
        text: input.text,
        rawText: input.text,
        source: input.source,
        layer: input.layer,
        ...(input.role !== undefined ? { role: input.role } : {}),
        dryRun: Boolean(input.dryRun),
        meta: {
            ...input.meta,
            ...(resolvedTarget ? { target: { ...resolvedTarget } } : {}),
            ...(resolvedMessageId !== undefined ? { messageId: resolvedMessageId } : {}),
            ...(resolvedSwipeId !== undefined ? { swipeId: resolvedSwipeId } : {}),
            isChatMessage: Boolean(input.meta.isChatMessage),
        },
        sessionBag,
        handledSyntaxes,
        cache,
        ...(input.signal ? { signal: input.signal } : {}),
        reportError(error: unknown, extId?: string): void {
            errorsList.push({
                error: toError(error),
                ...(extId ? { extId } : {}),
            });
        },
        get errors(): ReadonlyArray<PromptTransformErrorEntry> {
            return errorsList;
        },
    };
}

/** Extract a safe `PromptTransformResult` from a mutated `PromptTransformPayload`. */
export function finalizePromptTransformPayload(
    payload: PromptTransformPayload,
    initialText: string,
): PromptTransformResult {
    const safeText = typeof payload.text === 'string' ? payload.text : initialText;
    return {
        text: safeText,
        changed: safeText !== initialText,
        cacheable: payload.cache.cacheable,
        cacheKeys: payload.cache.getKeys(),
        cacheDisableReasons: [...payload.cache.reasons],
        handledSyntaxes: new Set(payload.handledSyntaxes),
        errors: [...payload.errors],
    };
}

export function createNoopPromptTransformResult(text: string): PromptTransformResult {
    return {
        text,
        changed: false,
        cacheable: true,
        cacheKeys: {},
        cacheDisableReasons: [],
        handledSyntaxes: new Set<string>(),
        errors: [],
    };
}

export interface EjsPromptTransformListenerOptions {
    includeUserInput?: boolean;
    includeChatMessages?: boolean;
    extId?: string;
}

/**
 * Wrap an optional EJS evaluator as a standard `PromptTransformListener`.
 * Yields automatically if another extension already claimed `'ejs'` in `handledSyntaxes`,
 * and skips evaluation when `source === 'vfs_read'` with `meta.editable === true`
 * so `edit_file` always sees verbatim `<% ... %>` source.
 */
export function createEjsPromptTransformListener(
    evaluator: EjsTextEvaluator,
    options: EjsPromptTransformListenerOptions = {},
): PromptTransformListener {
    const extId = options.extId ?? 'builtin-ejs';

    return async (payload: PromptTransformPayload): Promise<void> => {
        if (payload.handledSyntaxes.has('ejs')) {
            return;
        }
        if (typeof payload.text !== 'string' || !payload.text.includes('<%')) {
            return;
        }
        if (payload.source === 'user_input' && !options.includeUserInput) {
            return;
        }
        if (payload.source === 'chat_message' && !options.includeChatMessages) {
            return;
        }
        if (payload.source === 'vfs_read' && payload.meta.editable === true) {
            return;
        }

        const varsRecord: Record<string, unknown> = payload.meta.vars
            ? { ...payload.meta.vars }
            : {};
        const evalOpts: EjsEvaluateOptions = {
            ...(payload.meta.injectionSession
                ? { injectionSession: payload.meta.injectionSession }
                : {}),
            ...(payload.meta.ejsSession ? { ejsSession: payload.meta.ejsSession } : {}),
            ...(payload.meta.isPrivate ? { isPrivate: true } : {}),
        };

        try {
            const evaluated = await evaluator(payload.text, varsRecord, evalOpts);
            payload.text = typeof evaluated === 'string' ? evaluated : String(evaluated ?? '');
            payload.handledSyntaxes.add('ejs');
            if (payload.source === 'vfs_read' || payload.source === 'lore_radar') {
                payload.cache.disable('EJS template evaluated', extId);
            }
        } catch (err) {
            payload.reportError(err, extId);
        }
    };
}

/**
 * Run the prompt transform hook through `HostBridge.transformPromptText`, falling back
 * seamlessly to `HostBridge.evaluateOptionalEjs` for partial bridge mocks, and enforce `onError`.
 */
export async function runPromptTransform(
    bridge: Pick<HostBridge, 'transformPromptText' | 'evaluateOptionalEjs'> | undefined,
    input: PromptTransformInput,
): Promise<PromptTransformResult> {
    let result: PromptTransformResult;

    if (bridge?.transformPromptText) {
        result = await bridge.transformPromptText(input);
    } else if (bridge?.evaluateOptionalEjs) {
        const payload = createPromptTransformPayload(input);
        const listener = createEjsPromptTransformListener(bridge.evaluateOptionalEjs);
        await listener(payload);
        result = finalizePromptTransformPayload(payload, input.text);
    } else {
        result = createNoopPromptTransformResult(input.text);
    }

    if (result.errors.length > 0 && input.onError && input.onError !== 'fallback') {
        if (input.onError === 'throw') {
            throw result.errors[0].error;
        }
        if (typeof input.onError === 'function') {
            for (const entry of result.errors) {
                input.onError(entry.error);
            }
        }
    }

    return result;
}
