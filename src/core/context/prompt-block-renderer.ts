import type { EjsRenderSession, HostBridge, PromptInjectionSession } from '@/core/bridge';
import type {
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalRole,
    CanonicalToolCall,
    PromptBlock,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';
import { substituteAutoPromptMacrosFallback } from './auto-prompt-macros';

export interface PromptBlockRenderSyncOptions {
    hostBridge?: Pick<HostBridge, 'substituteMacros'>;
    macroOverrides?: Record<string, string>;
    /** Preceding messages before this block, used to auto-pair omitted `tool_call_id`/`name` on `role: 'tool'`. */
    precedingMessages?: readonly CanonicalMessage[];
    /** Optional non-fatal error observer (e.g. malformed custom JSON or EJS runtime error). */
    onError?: (error: Error, block: PromptBlock) => void;
}

export interface PromptBlockRenderOptions extends PromptBlockRenderSyncOptions {
    hostBridge?: Pick<HostBridge, 'substituteMacros' | 'evaluateOptionalEjs'>
        & Partial<Pick<HostBridge, 'getMetadata'>>;
    /** Variables exposed to `hostBridge.evaluateOptionalEjs(text, vars)`. */
    vars?: Record<string, unknown>;
    /** Isolated per-turn `injectPrompt` / `getPromptsInjected` session. */
    injectionSession?: PromptInjectionSession;
    /** Turn-scoped shared EJS context & variable sync session. */
    ejsSession?: EjsRenderSession;
    /** Optional callback invoked whenever macro or EJS evaluation mutates variables. */
    onVariablesMutated?: (updates: Record<string, unknown>) => void;
}

export type CustomPromptBlockMode = 'json' | 'ejs_template' | 'empty' | 'invalid';

export interface CustomPromptBlockValidationResult {
    valid: boolean;
    mode: CustomPromptBlockMode;
    messageCount: number;
    errors: string[];
    warnings: string[];
}

const FORBIDDEN_EXTRA_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const VALID_CANONICAL_ROLES = new Set<CanonicalRole>(['system', 'user', 'assistant', 'tool']);

const KNOWN_MESSAGE_KEYS = new Set([
    'role',
    'content',
    'name',
    'reasoningContent',
    'reasoning_content',
    'toolCalls',
    'tool_calls',
    'toolCallId',
    'tool_call_id',
    'toolName',
    'tool_name',
    'thoughtSignature',
    'thought_signature',
]);

const KNOWN_TOOL_CALL_KEYS = new Set([
    'id',
    'type',
    'function',
    'name',
    'arguments',
    'thoughtSignature',
    'thought_signature',
    'signature',
    'index',
]);

const VALID_CONTENT_PART_TYPES = new Set([
    'text',
    'image_url',
    'input_audio',
    'video_url',
    'file',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

/**
 * Recursively sanitize an arbitrary JSON-compatible value: strips prototype-pollution keys
 * (`__proto__`, `constructor`, `prototype`) and sorts keys deterministically for KV cache invariance.
 */
function sanitizeExtraValue(value: unknown, seen = new Set<object>()): unknown {
    if (value === null || value === undefined) {
        return value;
    }
    if (typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            return null;
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== 'object') {
        return undefined;
    }
    if (seen.has(value)) {
        return undefined;
    }
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => {
                const sanitized = sanitizeExtraValue(item, seen);
                return sanitized === undefined ? null : sanitized;
            });
        }
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).sort(compareCodeUnits);
        const result: Record<string, unknown> = {};
        for (const key of sortedKeys) {
            if (FORBIDDEN_EXTRA_KEYS.has(key)) {
                continue;
            }
            const sanitized = sanitizeExtraValue(record[key], seen);
            if (sanitized !== undefined) {
                result[key] = sanitized;
            }
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

function sanitizeSafeBlockId(blockId: string | undefined): string {
    const cleaned = (blockId ?? '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
    return cleaned.length > 0 ? cleaned : 'custom';
}

function applyMacros(
    text: string,
    hostBridge?: Pick<HostBridge, 'substituteMacros'>,
    macroOverrides?: Record<string, string>,
): string {
    if (!text) {
        return text;
    }
    if (!hostBridge) {
        return substituteAutoPromptMacrosFallback(text, macroOverrides);
    }
    return hostBridge.substituteMacros(text, macroOverrides);
}

const LOCAL_DOUBLE_COLON_MUTATION_RE = /\{\{\s*(?:set|add|inc|dec)var\s*::\s*([^:}]+?)(?:\s*::|\s*\}\})/gi;
const LOCAL_SINGLE_COLON_MUTATION_RE = /\{\{\s*(?:set|add|inc|dec)var\s*:\s*([^:}]+?)(?:\s*:|\s*\}\})/gi;
const LOCAL_SHORTHAND_MUTATION_RE = /\{\{\s*\.([a-zA-Z_][\w-]*)\s*(?:\+\+|--|[+?-]?=|\|\|=)/g;

/** Extract local variable names mutated by ST macros (`setvar`/`addvar`/`incvar`/`decvar`/`.var=`). */
export function extractMutatedLocalVarNames(text: string): string[] {
    if (!text || !text.includes('{{')) {
        return [];
    }
    const seen = new Set<string>();
    const collect = (re: RegExp) => {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const name = match[1]?.trim();
            if (name) {
                seen.add(name);
            }
        }
    };
    collect(LOCAL_DOUBLE_COLON_MUTATION_RE);
    collect(LOCAL_SINGLE_COLON_MUTATION_RE);
    collect(LOCAL_SHORTHAND_MUTATION_RE);
    return Array.from(seen);
}

/** Stringify a variable value consistently with `buildLayer2MacroOverrides` (`var:<k>`). */
export function stringifyMacroVarValue(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function readMetadataVariablesSnapshot(
    hostBridge?: Partial<Pick<HostBridge, 'getMetadata'>>,
): Map<string, { value: unknown; digest: string }> {
    const snap = new Map<string, { value: unknown; digest: string }>();
    const raw = hostBridge?.getMetadata?.()?.variables;
    if (!isPlainRecord(raw)) {
        return snap;
    }
    for (const [key, val] of Object.entries(raw)) {
        let digest: string;
        try {
            digest = canonicalStringify(val) ?? 'undefined';
        } catch {
            digest = String(val);
        }
        snap.set(key, { value: val, digest });
    }
    return snap;
}

function buildEjsEnv(vars?: Record<string, unknown>): Record<string, unknown> {
    const base: Record<string, unknown> = vars ? { ...vars } : {};
    if (typeof base.json !== 'function') {
        base.json = (val: unknown) => JSON.stringify(val);
    }
    return base;
}

async function evaluateStringLeafAsync(
    raw: string,
    block: PromptBlock,
    options: PromptBlockRenderOptions,
    evalEjs: boolean,
    ejsEnv: Record<string, unknown>,
): Promise<string> {
    const beforeMacroSnap = readMetadataVariablesSnapshot(options.hostBridge);
    let text = applyMacros(raw, options.hostBridge, options.macroOverrides);
    const afterMacroSnap = readMetadataVariablesSnapshot(options.hostBridge);

    const macroDelta: Record<string, unknown> = {};
    for (const [key, entry] of afterMacroSnap.entries()) {
        const prev = beforeMacroSnap.get(key);
        if (!prev || prev.digest !== entry.digest) {
            macroDelta[key] = entry.value;
        }
    }
    for (const mutatedKey of extractMutatedLocalVarNames(raw)) {
        if (!Object.hasOwn(macroDelta, mutatedKey) && afterMacroSnap.has(mutatedKey)) {
            macroDelta[mutatedKey] = afterMacroSnap.get(mutatedKey)!.value;
        }
    }
    if (Object.keys(macroDelta).length > 0) {
        Object.assign(ejsEnv, macroDelta);
        if (options.ejsSession) {
            options.ejsSession.pendingMacroVarUpdates = {
                ...(options.ejsSession.pendingMacroVarUpdates ?? {}),
                ...macroDelta,
            };
        }
        options.onVariablesMutated?.(macroDelta);
    }

    if (evalEjs && options.hostBridge?.evaluateOptionalEjs && text.includes('<%')) {
        const preEjsSnap = readMetadataVariablesSnapshot(options.hostBridge);
        try {
            text = await options.hostBridge.evaluateOptionalEjs(
                text,
                ejsEnv,
                {
                    ...(options.injectionSession
                        ? { injectionSession: options.injectionSession }
                        : {}),
                    ...(options.ejsSession ? { ejsSession: options.ejsSession } : {}),
                },
            );
        } catch (err) {
            options.onError?.(err instanceof Error ? err : new Error(String(err)), block);
        }

        const postEjsSnap = readMetadataVariablesSnapshot(options.hostBridge);
        const ejsDelta: Record<string, unknown> = {};
        for (const [key, entry] of postEjsSnap.entries()) {
            const prev = preEjsSnap.get(key);
            if (!prev || prev.digest !== entry.digest) {
                ejsDelta[key] = entry.value;
            }
        }
        if (options.ejsSession?.lastEjsVarUpdates) {
            Object.assign(ejsDelta, options.ejsSession.lastEjsVarUpdates);
            options.ejsSession.lastEjsVarUpdates = undefined;
        }
        if (Object.keys(ejsDelta).length > 0) {
            Object.assign(ejsEnv, ejsDelta);
            options.onVariablesMutated?.(ejsDelta);
        }
    }
    return text;
}

function evaluateStringLeafSync(
    raw: string,
    options: PromptBlockRenderSyncOptions,
): string {
    return applyMacros(raw, options.hostBridge, options.macroOverrides);
}

type TreeWalkScope = 'message' | 'tool_call' | 'tool_call_function' | 'general';

async function evaluateCustomTreeAsync(
    value: unknown,
    scope: TreeWalkScope,
    block: PromptBlock,
    options: PromptBlockRenderOptions,
    evalEjs: boolean,
    ejsEnv: Record<string, unknown>,
): Promise<unknown> {
    if (typeof value === 'string') {
        return evaluateStringLeafAsync(value, block, options, evalEjs, ejsEnv);
    }
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            out.push(await evaluateCustomTreeAsync(item, scope, block, options, evalEjs, ejsEnv));
        }
        return out;
    }
    if (!isPlainRecord(value)) {
        return value;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_EXTRA_KEYS.has(key)) {
            continue;
        }
        const child = value[key];

        if (scope === 'message' && (key === 'tool_calls' || key === 'toolCalls') && Array.isArray(child)) {
            const evaluatedCalls: unknown[] = [];
            for (const tc of child) {
                evaluatedCalls.push(
                    await evaluateCustomTreeAsync(tc, 'tool_call', block, options, evalEjs, ejsEnv),
                );
            }
            out[key] = evaluatedCalls;
            continue;
        }

        if (scope === 'tool_call' && key === 'function' && isPlainRecord(child)) {
            out[key] = await evaluateCustomTreeAsync(
                child,
                'tool_call_function',
                block,
                options,
                evalEjs,
                ejsEnv,
            );
            continue;
        }

        if ((scope === 'tool_call' || scope === 'tool_call_function') && key === 'arguments') {
            out[key] = await evaluateToolArgumentsAsync(child, block, options, evalEjs, ejsEnv);
            continue;
        }

        out[key] = await evaluateCustomTreeAsync(child, 'general', block, options, evalEjs, ejsEnv);
    }
    return out;
}

async function evaluateToolArgumentsAsync(
    rawArgs: unknown,
    block: PromptBlock,
    options: PromptBlockRenderOptions,
    evalEjs: boolean,
    ejsEnv: Record<string, unknown>,
): Promise<unknown> {
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (isPlainRecord(parsed)) {
                    const evaluatedObj = await evaluateCustomTreeAsync(
                        parsed,
                        'general',
                        block,
                        options,
                        evalEjs,
                        ejsEnv,
                    );
                    return canonicalStringify(sanitizeExtraValue(evaluatedObj));
                }
            } catch {
                // Fall through to plain string leaf evaluation when raw string is not valid JSON yet
            }
        }
        const evaluatedStr = await evaluateStringLeafAsync(rawArgs, block, options, evalEjs, ejsEnv);
        const afterTrimmed = evaluatedStr.trim();
        if (afterTrimmed.startsWith('{') && afterTrimmed.endsWith('}')) {
            try {
                const parsedAfter = JSON.parse(afterTrimmed) as unknown;
                if (isPlainRecord(parsedAfter)) {
                    return canonicalStringify(sanitizeExtraValue(parsedAfter));
                }
            } catch {
                // Keep evaluated string verbatim
            }
        }
        return evaluatedStr;
    }

    return evaluateCustomTreeAsync(rawArgs, 'general', block, options, evalEjs, ejsEnv);
}

function evaluateCustomTreeSync(
    value: unknown,
    scope: TreeWalkScope,
    options: PromptBlockRenderSyncOptions,
): unknown {
    if (typeof value === 'string') {
        return evaluateStringLeafSync(value, options);
    }
    if (Array.isArray(value)) {
        return value.map((item) => evaluateCustomTreeSync(item, scope, options));
    }
    if (!isPlainRecord(value)) {
        return value;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
        if (FORBIDDEN_EXTRA_KEYS.has(key)) {
            continue;
        }
        const child = value[key];

        if (scope === 'message' && (key === 'tool_calls' || key === 'toolCalls') && Array.isArray(child)) {
            out[key] = child.map((tc) => evaluateCustomTreeSync(tc, 'tool_call', options));
            continue;
        }

        if (scope === 'tool_call' && key === 'function' && isPlainRecord(child)) {
            out[key] = evaluateCustomTreeSync(child, 'tool_call_function', options);
            continue;
        }

        if ((scope === 'tool_call' || scope === 'tool_call_function') && key === 'arguments') {
            out[key] = evaluateToolArgumentsSync(child, options);
            continue;
        }

        out[key] = evaluateCustomTreeSync(child, 'general', options);
    }
    return out;
}

function evaluateToolArgumentsSync(
    rawArgs: unknown,
    options: PromptBlockRenderSyncOptions,
): unknown {
    if (typeof rawArgs === 'string') {
        const trimmed = rawArgs.trim();
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
                const parsed = JSON.parse(trimmed) as unknown;
                if (isPlainRecord(parsed)) {
                    const evaluatedObj = evaluateCustomTreeSync(parsed, 'general', options);
                    return canonicalStringify(sanitizeExtraValue(evaluatedObj));
                }
            } catch {
                // Fall through to plain string evaluation
            }
        }
        const evaluatedStr = evaluateStringLeafSync(rawArgs, options);
        const afterTrimmed = evaluatedStr.trim();
        if (afterTrimmed.startsWith('{') && afterTrimmed.endsWith('}')) {
            try {
                const parsedAfter = JSON.parse(afterTrimmed) as unknown;
                if (isPlainRecord(parsedAfter)) {
                    return canonicalStringify(sanitizeExtraValue(parsedAfter));
                }
            } catch {
                // Keep evaluated string verbatim
            }
        }
        return evaluatedStr;
    }
    return evaluateCustomTreeSync(rawArgs, 'general', options);
}

function normalizeContentPart(raw: unknown): CanonicalContentPart | null {
    if (!isPlainRecord(raw) || typeof raw.type !== 'string' || !VALID_CONTENT_PART_TYPES.has(raw.type)) {
        return null;
    }

    switch (raw.type) {
        case 'text':
            return {
                type: 'text',
                text: typeof raw.text === 'string' ? raw.text : String(raw.text ?? ''),
            };
        case 'image_url': {
            let imageUrl = '';
            let detail: 'auto' | 'low' | 'high' | undefined;
            if (typeof raw.imageUrl === 'string') {
                imageUrl = raw.imageUrl;
            } else if (typeof raw.image_url === 'string') {
                imageUrl = raw.image_url;
            } else if (isPlainRecord(raw.image_url) && typeof raw.image_url.url === 'string') {
                imageUrl = raw.image_url.url;
                if (
                    raw.image_url.detail === 'auto'
                    || raw.image_url.detail === 'low'
                    || raw.image_url.detail === 'high'
                ) {
                    detail = raw.image_url.detail;
                }
            }
            if (raw.detail === 'auto' || raw.detail === 'low' || raw.detail === 'high') {
                detail = raw.detail;
            }
            return {
                type: 'image_url',
                imageUrl,
                ...(detail ? { detail } : {}),
            };
        }
        case 'input_audio': {
            const nested = isPlainRecord(raw.input_audio) ? raw.input_audio : undefined;
            const data =
                typeof raw.data === 'string'
                    ? raw.data
                    : typeof nested?.data === 'string'
                        ? nested.data
                        : '';
            const format =
                typeof raw.format === 'string'
                    ? raw.format
                    : typeof nested?.format === 'string'
                        ? nested.format
                        : 'mp3';
            const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : undefined;
            const filename = typeof raw.filename === 'string' ? raw.filename : undefined;
            return {
                type: 'input_audio',
                data,
                format,
                ...(mimeType ? { mimeType } : {}),
                ...(filename ? { filename } : {}),
            };
        }
        case 'video_url': {
            const nested = isPlainRecord(raw.video_url) ? raw.video_url : undefined;
            const videoUrl =
                typeof raw.videoUrl === 'string'
                    ? raw.videoUrl
                    : typeof raw.video_url === 'string'
                        ? raw.video_url
                        : typeof nested?.url === 'string'
                            ? nested.url
                            : '';
            const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : undefined;
            const filename = typeof raw.filename === 'string' ? raw.filename : undefined;
            return {
                type: 'video_url',
                videoUrl,
                ...(mimeType ? { mimeType } : {}),
                ...(filename ? { filename } : {}),
            };
        }
        case 'file': {
            const data = typeof raw.data === 'string' ? raw.data : '';
            const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : undefined;
            const filename = typeof raw.filename === 'string' ? raw.filename : undefined;
            return {
                type: 'file',
                data,
                ...(mimeType ? { mimeType } : {}),
                ...(filename ? { filename } : {}),
            };
        }
        default:
            return null;
    }
}

function normalizeMessageContent(rawContent: unknown, role: CanonicalRole): string | CanonicalContentPart[] {
    if (rawContent === undefined || rawContent === null) {
        return '';
    }
    if (typeof rawContent === 'string') {
        return rawContent;
    }
    if (Array.isArray(rawContent)) {
        if (role !== 'tool' && rawContent.length > 0) {
            const parts: CanonicalContentPart[] = [];
            let allValid = true;
            for (const item of rawContent) {
                const part = normalizeContentPart(item);
                if (!part) {
                    allValid = false;
                    break;
                }
                parts.push(part);
            }
            if (allValid) {
                return parts;
            }
        }
        return canonicalStringify(sanitizeExtraValue(rawContent));
    }
    if (typeof rawContent === 'object') {
        return canonicalStringify(sanitizeExtraValue(rawContent));
    }
    return String(rawContent);
}

function extractThoughtSignatureAndCleanedExtraContent(
    tc: Record<string, unknown>,
): { thoughtSignature?: string; remainingExtraContent?: Record<string, unknown> } {
    const direct =
        (typeof tc.thoughtSignature === 'string' && tc.thoughtSignature.length > 0
            ? tc.thoughtSignature
            : undefined)
        ?? (typeof tc.signature === 'string' && tc.signature.length > 0
            ? tc.signature
            : undefined)
        ?? (typeof tc.thought_signature === 'string' && tc.thought_signature.length > 0
            ? tc.thought_signature
            : undefined);

    if (!isPlainRecord(tc.extra_content)) {
        return direct ? { thoughtSignature: direct } : {};
    }

    const extraContent = sanitizeExtraValue(tc.extra_content) as Record<string, unknown>;
    const google = isPlainRecord(extraContent.google) ? extraContent.google : undefined;
    const nestedSig =
        (typeof google?.thoughtSignature === 'string' && google.thoughtSignature.length > 0
            ? google.thoughtSignature
            : undefined)
        ?? (typeof google?.thought_signature === 'string' && google.thought_signature.length > 0
            ? google.thought_signature
            : undefined);

    const thoughtSignature = direct ?? nestedSig;

    // Strip only the extracted google thoughtSignature key; retain any remaining vendor fields.
    if (nestedSig && google) {
        const remainingGoogle: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(google)) {
            if (k !== 'thoughtSignature' && k !== 'thought_signature') {
                remainingGoogle[k] = v;
            }
        }
        const remainingExtra: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(extraContent)) {
            if (k === 'google') {
                if (Object.keys(remainingGoogle).length > 0) {
                    remainingExtra.google = remainingGoogle;
                }
            } else {
                remainingExtra[k] = v;
            }
        }
        return {
            ...(thoughtSignature ? { thoughtSignature } : {}),
            ...(Object.keys(remainingExtra).length > 0
                ? { remainingExtraContent: remainingExtra }
                : {}),
        };
    }

    return {
        ...(thoughtSignature ? { thoughtSignature } : {}),
        ...(Object.keys(extraContent).length > 0 ? { remainingExtraContent: extraContent } : {}),
    };
}

function collectExtraFields(
    raw: Record<string, unknown>,
    excludedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
    const keys = Object.keys(raw).sort(compareCodeUnits);
    const extra: Record<string, unknown> = {};
    for (const key of keys) {
        if (FORBIDDEN_EXTRA_KEYS.has(key) || excludedKeys.has(key)) {
            continue;
        }
        const sanitized = sanitizeExtraValue(raw[key]);
        if (sanitized !== undefined) {
            extra[key] = sanitized;
        }
    }
    return Object.keys(extra).length > 0 ? extra : undefined;
}

function normalizeToolCall(
    raw: unknown,
    safeBlockId: string,
    msgIdx: number,
    tcIdx: number,
): CanonicalToolCall | null {
    if (!isPlainRecord(raw)) {
        return null;
    }

    const fnObj = isPlainRecord(raw.function) ? raw.function : undefined;
    const rawName = fnObj && typeof fnObj.name === 'string' ? fnObj.name : raw.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) {
        return null;
    }

    const rawId = typeof raw.id === 'string' ? raw.id.trim() : '';
    const id = rawId.length > 0 ? rawId : `call_${safeBlockId}_${msgIdx}_${tcIdx}`;

    const rawArgs = fnObj && 'arguments' in fnObj ? fnObj.arguments : raw.arguments;
    let argsString: string;
    if (rawArgs === undefined || rawArgs === null) {
        argsString = '{}';
    } else if (typeof rawArgs === 'string') {
        argsString = rawArgs;
    } else {
        argsString = canonicalStringify(sanitizeExtraValue(rawArgs));
    }

    const { thoughtSignature, remainingExtraContent } =
        extractThoughtSignatureAndCleanedExtraContent(raw);

    const excluded = new Set(KNOWN_TOOL_CALL_KEYS);
    excluded.add('extra_content');
    const extraFields = collectExtraFields(raw, excluded) ?? {};
    if (remainingExtraContent && Object.keys(remainingExtraContent).length > 0) {
        extraFields.extra_content = remainingExtraContent;
    }
    const canonicalExtra =
        Object.keys(extraFields).length > 0
            ? (canonicalClone(extraFields) as Record<string, unknown>)
            : undefined;

    return {
        id,
        name,
        arguments: argsString,
        ...(thoughtSignature ? { thoughtSignature } : {}),
        ...(canonicalExtra ? { extraFields: canonicalExtra } : {}),
    };
}

function findUnmatchedPrecedingToolCalls(
    history: readonly CanonicalMessage[],
): { allCalls: CanonicalToolCall[]; unmatched: CanonicalToolCall[] } {
    const consumedIds = new Set<string>();
    for (let i = history.length - 1; i >= 0; i -= 1) {
        const msg = history[i];
        if (msg.role === 'tool') {
            if (msg.toolCallId) {
                consumedIds.add(msg.toolCallId);
            }
            continue;
        }
        if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
            const unmatched = msg.toolCalls.filter((tc) => !consumedIds.has(tc.id));
            return { allCalls: msg.toolCalls, unmatched };
        }
    }
    return { allCalls: [], unmatched: [] };
}

function normalizeCustomRole(rawRole: unknown): CanonicalRole | null {
    if (typeof rawRole !== 'string') {
        return null;
    }
    const lower = rawRole.trim().toLowerCase();
    if (lower === 'model') {
        return 'assistant';
    }
    if (VALID_CANONICAL_ROLES.has(lower as CanonicalRole)) {
        return lower as CanonicalRole;
    }
    return null;
}

function normalizeCustomMessages(
    rawItems: readonly unknown[],
    blockId: string,
    precedingMessages: readonly CanonicalMessage[] = [],
): CanonicalMessage[] {
    const safeBlockId = sanitizeSafeBlockId(blockId);
    const emitted: CanonicalMessage[] = [];
    const history: CanonicalMessage[] = [...precedingMessages];

    for (let msgIdx = 0; msgIdx < rawItems.length; msgIdx += 1) {
        const item = rawItems[msgIdx];
        if (!isPlainRecord(item)) {
            continue;
        }

        const role = normalizeCustomRole(item.role);
        if (!role) {
            continue;
        }

        const content = normalizeMessageContent(item.content, role);
        const name =
            typeof item.name === 'string' && item.name.trim().length > 0
                ? item.name.trim()
                : undefined;

        const rawReasoning =
            typeof item.reasoningContent === 'string'
                ? item.reasoningContent
                : typeof item.reasoning_content === 'string'
                    ? item.reasoning_content
                    : undefined;

        const rawToolCalls = Array.isArray(item.toolCalls)
            ? item.toolCalls
            : Array.isArray(item.tool_calls)
                ? item.tool_calls
                : undefined;

        let toolCalls: CanonicalToolCall[] | undefined;
        if (rawToolCalls && rawToolCalls.length > 0) {
            const normalizedCalls: CanonicalToolCall[] = [];
            for (let tcIdx = 0; tcIdx < rawToolCalls.length; tcIdx += 1) {
                const tc = normalizeToolCall(rawToolCalls[tcIdx], safeBlockId, msgIdx, tcIdx);
                if (tc) {
                    normalizedCalls.push(tc);
                }
            }
            if (normalizedCalls.length > 0) {
                toolCalls = normalizedCalls;
            }
        }

        let toolCallId =
            typeof item.toolCallId === 'string' && item.toolCallId.trim().length > 0
                ? item.toolCallId.trim()
                : typeof item.tool_call_id === 'string' && item.tool_call_id.trim().length > 0
                    ? item.tool_call_id.trim()
                    : undefined;

        let toolName =
            typeof item.toolName === 'string' && item.toolName.trim().length > 0
                ? item.toolName.trim()
                : typeof item.tool_name === 'string' && item.tool_name.trim().length > 0
                    ? item.tool_name.trim()
                    : role === 'tool'
                        ? name
                        : undefined;

        if (role === 'tool' && (!toolCallId || !toolName)) {
            const { allCalls, unmatched } = findUnmatchedPrecedingToolCalls(history);
            if (toolCallId) {
                const matchedById = allCalls.find((tc) => tc.id === toolCallId);
                if (matchedById && !toolName) {
                    toolName = matchedById.name;
                }
            } else if (unmatched.length > 0) {
                const matched =
                    (toolName ? unmatched.find((tc) => tc.name === toolName) : undefined)
                    ?? unmatched[0];
                if (matched) {
                    toolCallId = matched.id;
                    if (!toolName) {
                        toolName = matched.name;
                    }
                }
            }
        }

        const extraFields = collectExtraFields(item, KNOWN_MESSAGE_KEYS);

        const message: CanonicalMessage = {
            role,
            content,
            ...(name !== undefined ? { name } : {}),
            ...(rawReasoning !== undefined ? { reasoningContent: rawReasoning } : {}),
            ...(toolCalls ? { toolCalls } : {}),
            ...(toolCallId !== undefined ? { toolCallId } : {}),
            ...(toolName !== undefined ? { toolName } : {}),
            ...(extraFields ? { extraFields } : {}),
        };

        emitted.push(message);
        history.push(message);
    }

    return emitted;
}

function tryParseJsonRoot(raw: string): { ok: true; value: unknown } | { ok: false; error: Error } {
    try {
        return { ok: true, value: JSON.parse(raw) as unknown };
    } catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
        };
    }
}

function extractRawMessageList(parsed: unknown): unknown[] | null {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (isPlainRecord(parsed)) {
        return [parsed];
    }
    return null;
}

/**
 * Synchronously render a single `PromptBlock` into 0..N `CanonicalMessage`s.
 * Supports standard roles (`system`/`user`/`assistant`) and Track A static JSON `custom` blocks.
 * Dynamic outer EJS (`<%`) `custom` blocks require async `renderPromptBlock` / `prerenderPromptBlocks`.
 */
export function renderPromptBlockSync(
    block: PromptBlock,
    options: PromptBlockRenderSyncOptions = {},
): CanonicalMessage[] {
    if (!block.enabled) {
        return [];
    }

    if (block.role !== 'custom') {
        const rendered = applyMacros(
            block.content,
            options.hostBridge,
            options.macroOverrides,
        ).trim();
        return rendered ? [{ role: block.role, content: rendered }] : [];
    }

    const trimmed = block.content.trim();
    if (!trimmed) {
        return [];
    }

    const parsed = tryParseJsonRoot(trimmed);
    if (!parsed.ok) {
        // Outer EJS templates (Track B) cannot be evaluated synchronously; skip cleanly.
        if (!trimmed.includes('<%')) {
            options.onError?.(parsed.error, block);
        }
        return [];
    }

    const rawList = extractRawMessageList(parsed.value);
    if (!rawList || rawList.length === 0) {
        return [];
    }

    const evaluatedItems = rawList.map((item) => evaluateCustomTreeSync(item, 'message', options));
    return normalizeCustomMessages(evaluatedItems, block.id, options.precedingMessages);
}

/**
 * Asynchronously render a single `PromptBlock` into 0..N `CanonicalMessage`s, supporting:
 * - Standard roles (`system`/`user`/`assistant`) with macros + optional `HostBridge.evaluateOptionalEjs`
 * - `role: 'custom'` Track A (valid outer JSON with macro+EJS evaluated on string leaves, quote-safe `arguments`)
 * - `role: 'custom'` Track B (outer `<% ... %>` EJS template with injected `json()` helper -> `JSON.parse` -> macros)
 */
export async function renderPromptBlock(
    block: PromptBlock,
    options: PromptBlockRenderOptions = {},
): Promise<CanonicalMessage[]> {
    if (!block.enabled) {
        return [];
    }

    const liveBlockVars: Record<string, unknown> = options.vars ? { ...options.vars } : {};
    const liveBlockMacroOverrides = options.macroOverrides
        ? { ...options.macroOverrides }
        : undefined;
    const ejsEnv = buildEjsEnv(liveBlockVars);
    const effectiveOptions: PromptBlockRenderOptions = {
        ...options,
        vars: liveBlockVars,
        ...(liveBlockMacroOverrides ? { macroOverrides: liveBlockMacroOverrides } : {}),
        onVariablesMutated: (updates) => {
            Object.assign(liveBlockVars, updates);
            if (liveBlockMacroOverrides) {
                for (const [k, v] of Object.entries(updates)) {
                    liveBlockMacroOverrides[`var:${k}`] = stringifyMacroVarValue(v);
                }
            }
            options.onVariablesMutated?.(updates);
        },
    };

    if (block.role !== 'custom') {
        const text = await evaluateStringLeafAsync(
            block.content,
            block,
            effectiveOptions,
            true,
            ejsEnv,
        );
        const trimmed = text.trim();
        return trimmed ? [{ role: block.role, content: trimmed }] : [];
    }

    const trimmed = block.content.trim();
    if (!trimmed) {
        return [];
    }

    // Track A: Valid outer JSON (object or array)
    const trackA = tryParseJsonRoot(trimmed);
    if (trackA.ok) {
        const rawList = extractRawMessageList(trackA.value);
        if (!rawList || rawList.length === 0) {
            return [];
        }
        const evaluatedItems: unknown[] = [];
        for (const item of rawList) {
            evaluatedItems.push(
                await evaluateCustomTreeAsync(item, 'message', block, effectiveOptions, true, ejsEnv),
            );
        }
        return normalizeCustomMessages(evaluatedItems, block.id, effectiveOptions.precedingMessages);
    }

    // Track B: Outer EJS control-flow template generating JSON
    if (trimmed.includes('<%') && effectiveOptions.hostBridge?.evaluateOptionalEjs) {
        const preEjsSnap = readMetadataVariablesSnapshot(effectiveOptions.hostBridge);
        let evaluated: string;
        try {
            evaluated = await effectiveOptions.hostBridge.evaluateOptionalEjs(
                trimmed,
                ejsEnv,
                {
                    ...(effectiveOptions.injectionSession
                        ? { injectionSession: effectiveOptions.injectionSession }
                        : {}),
                    ...(effectiveOptions.ejsSession
                        ? { ejsSession: effectiveOptions.ejsSession }
                        : {}),
                },
            );
        } catch (err) {
            effectiveOptions.onError?.(err instanceof Error ? err : new Error(String(err)), block);
            return [];
        }

        const postEjsSnap = readMetadataVariablesSnapshot(effectiveOptions.hostBridge);
        const ejsDelta: Record<string, unknown> = {};
        for (const [key, entry] of postEjsSnap.entries()) {
            const prev = preEjsSnap.get(key);
            if (!prev || prev.digest !== entry.digest) {
                ejsDelta[key] = entry.value;
            }
        }
        if (effectiveOptions.ejsSession?.lastEjsVarUpdates) {
            Object.assign(ejsDelta, effectiveOptions.ejsSession.lastEjsVarUpdates);
            effectiveOptions.ejsSession.lastEjsVarUpdates = undefined;
        }
        if (Object.keys(ejsDelta).length > 0) {
            Object.assign(ejsEnv, ejsDelta);
            effectiveOptions.onVariablesMutated?.(ejsDelta);
        }

        const evalTrimmed = evaluated.trim();
        if (!evalTrimmed) {
            return [];
        }

        const trackB = tryParseJsonRoot(evalTrimmed);
        if (!trackB.ok) {
            effectiveOptions.onError?.(trackB.error, block);
            return [];
        }

        const rawList = extractRawMessageList(trackB.value);
        if (!rawList || rawList.length === 0) {
            return [];
        }

        const evaluatedItems: unknown[] = [];
        for (const item of rawList) {
            evaluatedItems.push(
                await evaluateCustomTreeAsync(item, 'message', block, effectiveOptions, false, ejsEnv),
            );
        }
        return normalizeCustomMessages(evaluatedItems, block.id, effectiveOptions.precedingMessages);
    }

    effectiveOptions.onError?.(trackA.error, block);
    return [];
}

function createChainedRenderOptions(
    options: PromptBlockRenderOptions,
): PromptBlockRenderOptions {
    const liveVars: Record<string, unknown> = options.vars ? { ...options.vars } : {};
    const liveMacroOverrides = options.macroOverrides ? { ...options.macroOverrides } : undefined;
    return {
        ...options,
        vars: liveVars,
        ...(liveMacroOverrides ? { macroOverrides: liveMacroOverrides } : {}),
        onVariablesMutated: (updates) => {
            Object.assign(liveVars, updates);
            if (liveMacroOverrides) {
                for (const [k, v] of Object.entries(updates)) {
                    liveMacroOverrides[`var:${k}`] = stringifyMacroVarValue(v);
                }
            }
            options.onVariablesMutated?.(updates);
        },
    };
}

/**
 * Asynchronously render an ordered sequence of `PromptBlock`s into a flat `CanonicalMessage[]`,
 * carrying preceding emitted messages across blocks for cross-block `tool_calls -> tool` auto-pairing.
 */
export async function renderPromptBlocks(
    blocks: readonly PromptBlock[],
    options: PromptBlockRenderOptions = {},
): Promise<CanonicalMessage[]> {
    const allMessages: CanonicalMessage[] = [];
    const preceding: CanonicalMessage[] = [...(options.precedingMessages ?? [])];
    const chainedOptions = createChainedRenderOptions(options);

    for (const block of blocks) {
        const rendered = await renderPromptBlock(block, {
            ...chainedOptions,
            precedingMessages: preceding,
        });
        for (const msg of rendered) {
            allMessages.push(msg);
            preceding.push(msg);
        }
    }

    return allMessages;
}

/**
 * Asynchronously pre-render an ordered list of `PromptBlock`s into a `Map<blockId, CanonicalMessage[]>`
 * suitable for `ContextAssembleInput.preRenderedBlocks`, preserving cross-block `tool` auto-pairing.
 */
export async function prerenderPromptBlocks(
    blocks: readonly PromptBlock[],
    options: PromptBlockRenderOptions = {},
): Promise<Map<string, CanonicalMessage[]>> {
    const result = new Map<string, CanonicalMessage[]>();
    const preceding: CanonicalMessage[] = [...(options.precedingMessages ?? [])];
    const chainedOptions = createChainedRenderOptions(options);

    for (const block of blocks) {
        const rendered = await renderPromptBlock(block, {
            ...chainedOptions,
            precedingMessages: preceding,
        });
        result.set(block.id, rendered);
        for (const msg of rendered) {
            preceding.push(msg);
        }
    }

    return result;
}

function checkEjsTagBalance(text: string): { balanced: boolean; error?: string } {
    let idx = 0;
    let inTag = false;
    let tagCount = 0;

    while (idx < text.length) {
        if (!inTag) {
            const nextOpen = text.indexOf('<%', idx);
            const nextClose = text.indexOf('%>', idx);
            if (nextClose !== -1 && (nextOpen === -1 || nextClose < nextOpen)) {
                return { balanced: false, error: '检测到多余的闭合标签 "%>"。' };
            }
            if (nextOpen === -1) {
                break;
            }
            inTag = true;
            tagCount += 1;
            idx = nextOpen + 2;
        } else {
            const nextClose = text.indexOf('%>', idx);
            if (nextClose === -1) {
                return { balanced: false, error: '检测到未闭合的 "<%" EJS 标签。' };
            }
            inTag = false;
            idx = nextClose + 2;
        }
    }

    if (inTag || tagCount === 0) {
        return { balanced: false, error: '检测到未闭合的 "<%" EJS 标签。' };
    }
    return { balanced: true };
}

/**
 * Static validator for `role === 'custom'` prompt blocks used by Studio editors before saving.
 * Distinguishes valid JSON (Track A) vs balanced outer EJS control-flow templates (Track B),
 * validates message roles and tool calls, and reports pairing/security warnings.
 */
export function validateCustomPromptBlock(rawContent: string): CustomPromptBlockValidationResult {
    const trimmed = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (!trimmed) {
        return {
            valid: true,
            mode: 'empty',
            messageCount: 0,
            errors: [],
            warnings: ['内容为空，上下文组装时将跳过此积木。'],
        };
    }

    const parsed = tryParseJsonRoot(trimmed);
    if (!parsed.ok) {
        if (trimmed.includes('<%')) {
            const balance = checkEjsTagBalance(trimmed);
            if (!balance.balanced) {
                return {
                    valid: false,
                    mode: 'invalid',
                    messageCount: 0,
                    errors: [balance.error ?? 'EJS 模板标签 <% 与 %> 未正确配对闭合。'],
                    warnings: [],
                };
            }
            return {
                valid: true,
                mode: 'ejs_template',
                messageCount: 0,
                errors: [],
                warnings: [
                    '检测到外层 EJS 控制流，将在上下文组装时求值后解析为 JSON 消息。',
                ],
            };
        }

        return {
            valid: false,
            mode: 'invalid',
            messageCount: 0,
            errors: [`JSON 语法错误: ${parsed.error.message}`],
            warnings: [],
        };
    }

    const rawList = extractRawMessageList(parsed.value);
    if (!rawList) {
        return {
            valid: false,
            mode: 'invalid',
            messageCount: 0,
            errors: ['JSON 根节点必须是单个消息对象 {...} 或消息数组 [{...}, ...]。'],
            warnings: [],
        };
    }

    if (rawList.length === 0) {
        return {
            valid: true,
            mode: 'json',
            messageCount: 0,
            errors: [],
            warnings: ['空数组 [] 将在上下文组装时跳过此积木。'],
        };
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    let pendingToolCalls: { id: string; name: string; msgIndex: number }[] = [];

    for (let i = 0; i < rawList.length; i += 1) {
        const item = rawList[i];
        const label = `第 ${i + 1} 条消息`;

        if (!isPlainRecord(item)) {
            errors.push(`${label} 必须是 JSON 对象。`);
            continue;
        }

        for (const key of Object.keys(item)) {
            if (FORBIDDEN_EXTRA_KEYS.has(key)) {
                warnings.push(`${label} 包含受限属性 "${key}"，运行时将自动过滤。`);
            }
        }

        const rawRole = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
        if (rawRole === 'custom') {
            errors.push(`${label} 不允许嵌套使用 role: "custom"。`);
            continue;
        }
        const normalizedRole = normalizeCustomRole(rawRole);
        if (!normalizedRole) {
            errors.push(
                `${label} 的 role 无效 ("${String(item.role ?? '')}")，仅支持 system / user / assistant / tool。`,
            );
            continue;
        }
        if (rawRole === 'model') {
            warnings.push(`${label} 使用了 role: "model"，运行时将自动归一化为 "assistant"。`);
        }

        const rawToolCalls = item.toolCalls ?? item.tool_calls;
        if (rawToolCalls !== undefined) {
            if (!Array.isArray(rawToolCalls)) {
                errors.push(`${label} 的 tool_calls / toolCalls 必须是数组。`);
            } else {
                if (pendingToolCalls.length > 0) {
                    warnings.push(
                        `第 ${pendingToolCalls[0].msgIndex + 1} 条 assistant 消息存在未配对的 tool_calls (${pendingToolCalls.map((c) => c.name).join(', ')})。`,
                    );
                    pendingToolCalls = [];
                }
                const nextPending: { id: string; name: string; msgIndex: number }[] = [];
                for (let tcIdx = 0; tcIdx < rawToolCalls.length; tcIdx += 1) {
                    const tc = rawToolCalls[tcIdx];
                    if (!isPlainRecord(tc)) {
                        errors.push(`${label} 的 tool_calls[${tcIdx}] 必须是对象。`);
                        continue;
                    }
                    const fnObj = isPlainRecord(tc.function) ? tc.function : undefined;
                    const fnName =
                        fnObj && typeof fnObj.name === 'string'
                            ? fnObj.name.trim()
                            : typeof tc.name === 'string'
                                ? tc.name.trim()
                                : '';
                    if (!fnName) {
                        errors.push(`${label} 的 tool_calls[${tcIdx}] 缺少工具名称 name。`);
                        continue;
                    }
                    const rawArgs = fnObj && 'arguments' in fnObj ? fnObj.arguments : tc.arguments;
                    if (
                        typeof rawArgs === 'string'
                        && rawArgs.trim().length > 0
                        && !rawArgs.includes('<%')
                        && !rawArgs.includes('{{')
                    ) {
                        const parsedArgs = tryParseJsonRoot(rawArgs);
                        if (!parsedArgs.ok || !isPlainRecord(parsedArgs.value)) {
                            warnings.push(
                                `${label} 的 tool_calls[${tcIdx}] (${fnName}) 的 arguments 不是合法 JSON 对象字符串。`,
                            );
                        }
                    }
                    const tcId =
                        typeof tc.id === 'string' && tc.id.trim()
                            ? tc.id.trim()
                            : `call_preview_${i}_${tcIdx}`;
                    nextPending.push({ id: tcId, name: fnName, msgIndex: i });
                }
                pendingToolCalls = nextPending;
            }
        } else if (normalizedRole === 'tool') {
            const explicitId =
                typeof item.toolCallId === 'string' && item.toolCallId.trim()
                    ? item.toolCallId.trim()
                    : typeof item.tool_call_id === 'string' && item.tool_call_id.trim()
                        ? item.tool_call_id.trim()
                        : undefined;
            const explicitName =
                typeof item.toolName === 'string' && item.toolName.trim()
                    ? item.toolName.trim()
                    : typeof item.tool_name === 'string' && item.tool_name.trim()
                        ? item.tool_name.trim()
                        : typeof item.name === 'string' && item.name.trim()
                            ? item.name.trim()
                            : undefined;

            if (pendingToolCalls.length > 0) {
                let matchIdx = -1;
                if (explicitId) {
                    matchIdx = pendingToolCalls.findIndex((c) => c.id === explicitId);
                } else if (explicitName) {
                    matchIdx = pendingToolCalls.findIndex((c) => c.name === explicitName);
                }
                if (matchIdx === -1 && !explicitId) {
                    matchIdx = 0;
                }
                if (matchIdx >= 0) {
                    pendingToolCalls.splice(matchIdx, 1);
                } else {
                    warnings.push(
                        `${label} (role: "tool") 的 tool_call_id ("${explicitId}") 未匹配到本积木内前导 assistant.tool_calls。`,
                    );
                }
            } else if (!explicitId || !explicitName) {
                warnings.push(
                    `${label} (role: "tool") 在本积木内缺少前导 assistant.tool_calls，且未显式指定 tool_call_id 与 name。`,
                );
            }
        } else if (pendingToolCalls.length > 0) {
            warnings.push(
                `第 ${pendingToolCalls[0].msgIndex + 1} 条 assistant 消息的 tool_calls (${pendingToolCalls.map((c) => c.name).join(', ')}) 后紧跟了 ${normalizedRole} 消息而未配对 tool 响应。`,
            );
            pendingToolCalls = [];
        }
    }

    if (pendingToolCalls.length > 0) {
        warnings.push(
            `第 ${pendingToolCalls[0].msgIndex + 1} 条 assistant 消息包含未在本积木内闭合的 tool_calls (${pendingToolCalls.map((c) => c.name).join(', ')})，请确认后续存在对应 tool 消息。`,
        );
    }

    return {
        valid: errors.length === 0,
        mode: errors.length === 0 ? 'json' : 'invalid',
        messageCount: rawList.length,
        errors,
        warnings,
    };
}
