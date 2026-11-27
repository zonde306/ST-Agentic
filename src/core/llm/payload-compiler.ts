import type { LLMRequest, LLMToolChoice } from '../bridge';
import type {
    ApiConnection,
    ApiProviderFormat,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    SystemInstructionMode,
} from '../types';
import { canonicalClone, canonicalStringify } from '../utils';
import { LLMTransportError } from './errors';

export const MAX_ANTHROPIC_CACHE_BREAKPOINTS = 4;
const PROMPT_PLACEHOLDER = "Let's get started.";
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type PromptPostProcessingMode = NonNullable<ApiConnection['promptPostProcessing']>;

export interface CompiledPayload {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: Record<string, unknown>;
    serializedBody: string;
    providerFormat: ApiProviderFormat;
    cacheBreakpointsApplied: number;
}

export interface CompiledModelsRequest {
    url: string;
    method: 'GET';
    headers: Record<string, string>;
    providerFormat: ApiProviderFormat;
}

export interface PayloadCompilerOptions {
    /** Optional fallback Anthropic API version header (default: '2023-06-01'). */
    anthropicVersion?: string;
}

interface PostProcessResult {
    messages: CanonicalMessage[];
    /** Maps each original message index -> resulting processed message index. */
    indexMap: Map<number, number>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
        return true;
    }
    return (
        Object.prototype.toString.call(value) === '[object Object]' &&
        Object.getPrototypeOf(proto) === null
    );
}

function deepMergeRecord(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(source)) {
        if (FORBIDDEN_MERGE_KEYS.has(key) || value === undefined) {
            continue;
        }
        const existing = target[key];
        if (isPlainObject(value) && isPlainObject(existing)) {
            deepMergeRecord(existing, value);
        } else {
            target[key] = canonicalClone(value);
        }
    }
}

function applyExcludeRecord(target: Record<string, unknown>, exclude: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(exclude)) {
        if (FORBIDDEN_MERGE_KEYS.has(key) || value === false) {
            continue;
        }
        if (isPlainObject(value) && Object.keys(value).length > 0 && isPlainObject(target[key])) {
            applyExcludeRecord(target[key] as Record<string, unknown>, value);
        } else {
            delete target[key];
        }
    }
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
            if (FORBIDDEN_MERGE_KEYS.has(key)) {
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

function sanitizeExtraFields(
    extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
    if (!extra || !isPlainObject(extra)) {
        return undefined;
    }
    const sanitized = sanitizeExtraValue(extra) as Record<string, unknown>;
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function hasNonEmptyExtraFields(extra: Record<string, unknown> | undefined): boolean {
    if (!extra || !isPlainObject(extra)) {
        return false;
    }
    for (const key of Object.keys(extra)) {
        if (FORBIDDEN_MERGE_KEYS.has(key)) {
            continue;
        }
        const val = extra[key];
        if (val !== undefined && typeof val !== 'function' && typeof val !== 'symbol') {
            return true;
        }
    }
    return false;
}

function applyExtraFields(
    target: Record<string, unknown>,
    extra: Record<string, unknown> | undefined,
): void {
    const sanitized = sanitizeExtraFields(extra);
    if (!sanitized) {
        return;
    }
    for (const [key, value] of Object.entries(sanitized)) {
        if (FORBIDDEN_MERGE_KEYS.has(key)) {
            continue;
        }
        target[key] = value;
    }
}

function resolveValidAllowedToolNames(
    toolChoice: LLMToolChoice,
    tools: readonly CanonicalToolSchema[],
): string[] {
    if (!toolChoice.allowedToolNames?.length || tools.length === 0) {
        return [];
    }
    const available = new Set(tools.map((tool) => tool.name));
    const seen = new Set<string>();
    const valid: string[] = [];
    for (const name of toolChoice.allowedToolNames) {
        if (typeof name === 'string' && available.has(name) && !seen.has(name)) {
            seen.add(name);
            valid.push(name);
        }
    }
    return valid;
}

function cloneContent(content: string | CanonicalContentPart[]): string | CanonicalContentPart[] {
    if (typeof content === 'string') {
        return content;
    }
    return content.map((part) => ({ ...part }));
}

function cloneToolCall(tc: CanonicalToolCall): CanonicalToolCall {
    const sanitizedExtra = sanitizeExtraFields(tc.extraFields);
    return {
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        ...(tc.thoughtSignature !== undefined ? { thoughtSignature: tc.thoughtSignature } : {}),
        ...(sanitizedExtra !== undefined ? { extraFields: sanitizedExtra } : {}),
    };
}

function cloneMessage(msg: CanonicalMessage): CanonicalMessage {
    const sanitizedExtra = sanitizeExtraFields(msg.extraFields);
    return {
        role: msg.role,
        content: cloneContent(msg.content),
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.reasoningContent !== undefined ? { reasoningContent: msg.reasoningContent } : {}),
        ...(msg.toolCalls !== undefined
            ? { toolCalls: msg.toolCalls.map(cloneToolCall) }
            : {}),
        ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
        ...(sanitizedExtra !== undefined ? { extraFields: sanitizedExtra } : {}),
    };
}

function contentToParts(content: string | CanonicalContentPart[]): CanonicalContentPart[] {
    if (typeof content === 'string') {
        return content ? [{ type: 'text', text: content }] : [];
    }
    return content.map((p) => ({ ...p }));
}

function mergeTwoContents(
    first: string | CanonicalContentPart[],
    second: string | CanonicalContentPart[],
): string | CanonicalContentPart[] {
    if (typeof first === 'string' && typeof second === 'string') {
        if (!first) return second;
        if (!second) return first;
        return `${first}\n\n${second}`;
    }

    const partsA = contentToParts(first);
    const partsB = contentToParts(second);
    if (partsA.length > 0 && partsB.length > 0) {
        const lastA = partsA[partsA.length - 1];
        const firstB = partsB[0];
        if (lastA.type === 'text' && firstB.type === 'text') {
            partsA[partsA.length - 1] = {
                type: 'text',
                text: lastA.text && firstB.text ? `${lastA.text}\n\n${firstB.text}` : `${lastA.text}${firstB.text}`,
            };
            return [...partsA, ...partsB.slice(1)];
        }
    }
    return [...partsA, ...partsB];
}

function applyNamePrefixToContent(msg: CanonicalMessage): string | CanonicalContentPart[] {
    if (!msg.name || msg.role === 'system' || msg.role === 'tool') {
        return cloneContent(msg.content);
    }
    const prefix = `${msg.name}: `;
    if (typeof msg.content === 'string') {
        return msg.content.startsWith(prefix) ? msg.content : `${prefix}${msg.content}`;
    }
    const parts = msg.content.map((p) => ({ ...p }));
    const firstTextIdx = parts.findIndex((p) => p.type === 'text');
    if (firstTextIdx >= 0) {
        const textPart = parts[firstTextIdx] as { type: 'text'; text: string };
        if (!textPart.text.startsWith(prefix)) {
            parts[firstTextIdx] = { type: 'text', text: `${prefix}${textPart.text}` };
        }
    } else {
        parts.unshift({ type: 'text', text: prefix.trimEnd() });
    }
    return parts;
}

function squashConsecutiveRoles(
    messages: CanonicalMessage[],
    priorIndexMap?: Map<number, number>,
): PostProcessResult {
    const merged: CanonicalMessage[] = [];
    const stepMap = new Map<number, number>();

    for (let i = 0; i < messages.length; i += 1) {
        const curr = cloneMessage(messages[i]);
        const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
        const canMergeWithPrev =
            prev !== undefined
            && prev.role === curr.role
            && curr.role !== 'tool'
            && !prev.toolCalls?.length
            && !curr.toolCalls?.length
            && !hasNonEmptyExtraFields(prev.extraFields)
            && !hasNonEmptyExtraFields(curr.extraFields);

        if (canMergeWithPrev && prev) {
            if (curr.name && curr.role !== 'system') {
                curr.content = applyNamePrefixToContent(curr);
                delete curr.name;
            }
            if (prev.name && prev.role !== 'system') {
                prev.content = applyNamePrefixToContent(prev);
                delete prev.name;
            }
            prev.content = mergeTwoContents(prev.content, curr.content);
            stepMap.set(i, merged.length - 1);
        } else {
            merged.push(curr);
            stepMap.set(i, merged.length - 1);
        }
    }

    if (!priorIndexMap) {
        return { messages: merged, indexMap: stepMap };
    }

    const composed = new Map<number, number>();
    for (const [origIdx, midIdx] of priorIndexMap.entries()) {
        const mapped = stepMap.get(midIdx);
        if (mapped !== undefined) {
            composed.set(origIdx, mapped);
        }
    }
    return { messages: merged, indexMap: composed };
}

/**
 * Rewrites `system` messages into `user` or `assistant` (`model`) when `mode !== 'native'`,
 * preserving 1:1 message index alignment and stripping `name` on converted system messages.
 */
export function applySystemInstructionMode(
    messages: CanonicalMessage[],
    mode: SystemInstructionMode = 'native',
): CanonicalMessage[] {
    if (mode === 'native') {
        return messages;
    }
    const targetRole = mode === 'model' ? 'assistant' : 'user';
    return messages.map((msg) => {
        if (msg.role !== 'system') {
            return msg;
        }
        const cloned = cloneMessage(msg);
        cloned.role = targetRole;
        delete cloned.name;
        return cloned;
    });
}

function findLastLeadingSystemIndex(messages: readonly CanonicalMessage[]): number {
    let last = -1;
    for (let i = 0; i < messages.length; i += 1) {
        if (messages[i].role === 'system') {
            last = i;
        } else {
            break;
        }
    }
    return last;
}

/**
 * Applies SillyTavern-compatible prompt post-processing (`none`/`merge`/`semi`/`strict`/`single`)
 * while preserving `tool` messages, `toolCalls`, and original->output breakpoint index mappings.
 */
export function postProcessCanonicalMessages(
    messages: CanonicalMessage[],
    mode: PromptPostProcessingMode = 'none',
): PostProcessResult {
    const indexMap = new Map<number, number>();
    if (mode === 'none') {
        const cloned = messages.map((m, idx) => {
            indexMap.set(idx, idx);
            return cloneMessage(m);
        });
        return { messages: cloned, indexMap };
    }

    if (mode === 'single') {
        if (messages.length === 0) {
            return {
                messages: [{ role: 'user', content: PROMPT_PLACEHOLDER }],
                indexMap,
            };
        }
        let combinedContent: string | CanonicalContentPart[] = '';
        for (let i = 0; i < messages.length; i += 1) {
            const m = messages[i];
            const prefixed = applyNamePrefixToContent(m);
            combinedContent = i === 0 ? prefixed : mergeTwoContents(combinedContent, prefixed);
            indexMap.set(i, 0);
        }
        return {
            messages: [{ role: 'user', content: combinedContent }],
            indexMap,
        };
    }

    // Step 1: squash consecutive same-role messages.
    let current = squashConsecutiveRoles(messages);

    if (mode === 'merge') {
        if (current.messages.length === 0) {
            current.messages.push({ role: 'user', content: PROMPT_PLACEHOLDER });
        }
        return current;
    }

    // Step 2 ('semi' & 'strict'): convert mid-prompt system messages (index > 0) to 'user', then re-merge.
    const converted = current.messages.map((msg, idx) => {
        if (idx > 0 && msg.role === 'system') {
            return { ...msg, role: 'user' as const };
        }
        return msg;
    });
    current = squashConsecutiveRoles(converted, current.indexMap);

    if (mode === 'semi') {
        if (current.messages.length === 0) {
            current.messages.push({ role: 'user', content: PROMPT_PLACEHOLDER });
        }
        return current;
    }

    // Step 3 ('strict'): ensure user placeholder exists after leading system or at start when needed.
    const msgs = current.messages;
    if (msgs.length === 0) {
        msgs.push({ role: 'user', content: PROMPT_PLACEHOLDER });
    } else if (msgs[0].role === 'system' && (msgs.length === 1 || msgs[1].role !== 'user')) {
        msgs.splice(1, 0, { role: 'user', content: PROMPT_PLACEHOLDER });
        for (const [origIdx, targetIdx] of current.indexMap.entries()) {
            if (targetIdx >= 1) {
                current.indexMap.set(origIdx, targetIdx + 1);
            }
        }
    } else if (msgs[0].role !== 'system' && msgs[0].role !== 'user') {
        msgs.unshift({ role: 'user', content: PROMPT_PLACEHOLDER });
        for (const [origIdx, targetIdx] of current.indexMap.entries()) {
            current.indexMap.set(origIdx, targetIdx + 1);
        }
    }

    return squashConsecutiveRoles(msgs, current.indexMap);
}

function splitUrlQuery(rawUrl: string): { path: string; query: string } {
    const trimmed = rawUrl.trim();
    const queryIdx = trimmed.indexOf('?');
    const rawPath = queryIdx >= 0 ? trimmed.slice(0, queryIdx) : trimmed;
    const query = queryIdx >= 0 ? trimmed.slice(queryIdx + 1) : '';
    const path = rawPath.replace(/\/+$/, '');
    return { path, query };
}

function withQueryParams(
    path: string,
    query: string,
    mutate?: (params: URLSearchParams) => void,
): string {
    if (!mutate) {
        return query ? `${path}?${query}` : path;
    }
    const params = new URLSearchParams(query);
    mutate(params);
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
}

function buildEndpointUrl(
    baseUrl: string,
    providerFormat: ApiProviderFormat,
    options?: { model?: string; stream?: boolean },
): string {
    const { path, query } = splitUrlQuery(baseUrl);
    if (!path) {
        throw new LLMTransportError('API connection baseUrl is required', { retryable: false });
    }

    if (providerFormat === 'gemini') {
        const action = options?.stream ? 'streamGenerateContent' : 'generateContent';
        const actionMatch = /:(streamGenerateContent|generateContent)$/i.exec(path);
        let endpointPath: string;

        if (actionMatch) {
            endpointPath = `${path.slice(0, actionMatch.index)}:${action}`;
        } else {
            const cleanModel = (options?.model ?? '').trim().replace(/^models\//, '').replace(/^\/+/, '');
            const encodedModel = cleanModel
                .split('/')
                .filter(Boolean)
                .map((seg) => encodeURIComponent(seg))
                .join('/');
            if (!encodedModel) {
                throw new LLMTransportError(
                    'API connection model is required for Gemini providerFormat',
                    { retryable: false },
                );
            }

            if (path.endsWith('/models')) {
                endpointPath = `${path}/${encodedModel}:${action}`;
            } else if (/\/v\d+(?:beta\d*|alpha\d*)?$/i.test(path)) {
                endpointPath = `${path}/models/${encodedModel}:${action}`;
            } else {
                endpointPath = `${path}/v1beta/models/${encodedModel}:${action}`;
            }
        }

        return withQueryParams(endpointPath, query, (params) => {
            if (options?.stream) {
                params.set('alt', 'sse');
            } else if (params.get('alt')?.toLowerCase() === 'sse') {
                params.delete('alt');
            }
        });
    }

    const base = baseUrl.trim().replace(/\/+$/, '');
    if (providerFormat === 'anthropic') {
        if (base.endsWith('/messages')) {
            return base;
        }
        if (/\/v\d+$/.test(base)) {
            return `${base}/messages`;
        }
        return `${base}/v1/messages`;
    }

    if (base.endsWith('/chat/completions')) {
        return base;
    }
    return `${base}/chat/completions`;
}

/**
 * Resolves the `/models` endpoint URL for OpenAI-compatible, Anthropic, and Gemini connections,
 * preserving optional query strings and supporting relative proxy paths.
 */
export function buildModelsEndpointUrl(baseUrl: string, providerFormat: ApiProviderFormat): string {
    const { path: base, query } = splitUrlQuery(baseUrl);
    const querySuffix = query ? `?${query}` : '';
    if (!base) {
        throw new LLMTransportError('API connection baseUrl is required', { retryable: false });
    }

    if (providerFormat === 'gemini') {
        const actionMatch = /^(.*\/models)\/[^/]+:(?:streamGenerateContent|generateContent)$/i.exec(base);
        let modelsPath: string;
        if (actionMatch) {
            modelsPath = actionMatch[1];
        } else if (base.endsWith('/models')) {
            modelsPath = base;
        } else if (/\/v\d+(?:beta\d*|alpha\d*)?$/i.test(base)) {
            modelsPath = `${base}/models`;
        } else {
            modelsPath = `${base}/v1beta/models`;
        }

        return withQueryParams(modelsPath, query, (params) => {
            if (params.get('alt')?.toLowerCase() === 'sse') {
                params.delete('alt');
            }
        });
    }

    if (base.endsWith('/models')) {
        return `${base}${querySuffix}`;
    }

    if (providerFormat === 'anthropic') {
        if (base.endsWith('/messages')) {
            return `${base.slice(0, -'/messages'.length)}/models${querySuffix}`;
        }
        if (/\/v\d+$/.test(base)) {
            return `${base}/models${querySuffix}`;
        }
        return `${base}/v1/models${querySuffix}`;
    }

    if (base.endsWith('/chat/completions')) {
        return `${base.slice(0, -'/chat/completions'.length)}/models${querySuffix}`;
    }
    if (base.endsWith('/completions')) {
        return `${base.slice(0, -'/completions'.length)}/models${querySuffix}`;
    }
    return `${base}/models${querySuffix}`;
}

function setHeaderCaseInsensitive(headers: Record<string, string>, name: string, value: string): void {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === lower) {
            delete headers[existing];
        }
    }
    headers[name] = value;
}

function hasHeaderCaseInsensitive(headers: Record<string, string>, name: string): boolean {
    const lower = name.toLowerCase();
    return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function buildHeaders(
    connection: ApiConnection,
    anthropicVersion: string,
    options: { defaultContentType?: boolean } = {},
): Record<string, string> {
    const headers: Record<string, string> =
        options.defaultContentType === false
            ? { Accept: 'application/json' }
            : { 'Content-Type': 'application/json' };

    for (const [rawKey, rawValue] of Object.entries(connection.includeHeaders ?? {})) {
        const key = rawKey.trim();
        if (!key) {
            continue;
        }
        if (rawValue === null) {
            const lower = key.toLowerCase();
            for (const existing of Object.keys(headers)) {
                if (existing.toLowerCase() === lower) {
                    delete headers[existing];
                }
            }
            continue;
        }
        if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
            setHeaderCaseInsensitive(headers, key, String(rawValue));
        }
    }

    const apiKey = connection.apiKey?.trim();
    if (connection.providerFormat === 'anthropic') {
        if (apiKey && !hasHeaderCaseInsensitive(headers, 'x-api-key')) {
            headers['x-api-key'] = apiKey;
        }
        if (!hasHeaderCaseInsensitive(headers, 'anthropic-version')) {
            headers['anthropic-version'] = anthropicVersion;
        }
    } else if (connection.providerFormat === 'gemini') {
        if (
            apiKey
            && !hasHeaderCaseInsensitive(headers, 'x-goog-api-key')
            && !hasHeaderCaseInsensitive(headers, 'authorization')
        ) {
            headers['x-goog-api-key'] = apiKey;
        }
    } else if (apiKey && !hasHeaderCaseInsensitive(headers, 'authorization')) {
        headers.Authorization = `Bearer ${apiKey}`;
    }

    return headers;
}

function selectBreakpointIndices(
    rawIndices: number[] | undefined,
    indexMap: Map<number, number>,
    processedMessages: CanonicalMessage[],
    maxBreakpoints: number,
    origLastLeadingSystemIdx?: number,
): number[] {
    if (maxBreakpoints <= 0 || processedMessages.length === 0) {
        return [];
    }

    let candidates: number[] = [];

    if (rawIndices && rawIndices.length > 0) {
        const seen = new Set<number>();
        for (const origIdx of rawIndices) {
            if (!Number.isInteger(origIdx) || origIdx < 0) {
                continue;
            }
            const mapped = indexMap.get(origIdx);
            if (mapped !== undefined && mapped >= 0 && mapped < processedMessages.length && !seen.has(mapped)) {
                seen.add(mapped);
                candidates.push(mapped);
            }
        }
        candidates.sort((a, b) => a - b);
    }

    if (candidates.length === 0) {
        // Default to Layer 0 end: original leading system end (even if role-converted), or processed leading system, or message 0.
        const origMapped =
            origLastLeadingSystemIdx !== undefined && origLastLeadingSystemIdx >= 0
                ? indexMap.get(origLastLeadingSystemIdx)
                : undefined;
        if (origMapped !== undefined && origMapped >= 0 && origMapped < processedMessages.length) {
            candidates = [origMapped];
        } else {
            const lastLeadingSystem = findLastLeadingSystemIndex(processedMessages);
            candidates = [lastLeadingSystem >= 0 ? lastLeadingSystem : 0];
        }
    }

    if (candidates.length <= maxBreakpoints) {
        return candidates;
    }

    if (maxBreakpoints === 1) {
        return [candidates[0]];
    }

    // Preserve earliest Layer 0 anchor + most recent (maxBreakpoints - 1) checkpoints.
    return [candidates[0], ...candidates.slice(-(maxBreakpoints - 1))];
}

function stripDataUrlPrefix(value: string): string {
    if (!value.startsWith('data:')) {
        return value;
    }
    const commaIdx = value.indexOf(',');
    return commaIdx >= 0 ? value.slice(commaIdx + 1) : value;
}

function convertPartToOpenAI(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'text') {
        return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url') {
        return {
            type: 'image_url',
            image_url: {
                url: part.imageUrl,
                ...(part.detail !== undefined ? { detail: part.detail } : {}),
            },
        };
    }
    if (part.type === 'input_audio') {
        return {
            type: 'input_audio',
            input_audio: {
                data: stripDataUrlPrefix(part.data),
                format: part.format || 'mp3',
            },
        };
    }
    if (part.type === 'video_url') {
        return {
            type: 'video_url',
            video_url: {
                url: part.videoUrl,
            },
        };
    }
    return {
        type: 'file',
        file: {
            file_data: part.data,
            ...(part.filename !== undefined ? { filename: part.filename } : {}),
            ...(part.mimeType !== undefined ? { mime_type: part.mimeType } : {}),
        },
    };
}

function attachCacheControlToOpenAIMessage(msg: Record<string, unknown>): boolean {
    const cacheControl = { type: 'ephemeral' };
    if (typeof msg.content === 'string') {
        msg.content = [
            {
                type: 'text',
                text: msg.content,
                cache_control: cacheControl,
            },
        ];
        return true;
    }
    if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastPart = msg.content[msg.content.length - 1] as Record<string, unknown>;
        if (!lastPart.cache_control) {
            lastPart.cache_control = cacheControl;
            return true;
        }
        return false;
    }
    msg.content = [{ type: 'text', text: '', cache_control: cacheControl }];
    return true;
}

function parseAnthropicMediaSource(
    mediaUrl: string,
    fallbackMimeType: string,
): Record<string, unknown> {
    if (mediaUrl.startsWith('data:')) {
        const commaIdx = mediaUrl.indexOf(',');
        const meta = commaIdx >= 0 ? mediaUrl.slice(5, commaIdx) : '';
        const data = commaIdx >= 0 ? mediaUrl.slice(commaIdx + 1) : '';
        const mimeType = meta.split(';')[0] || fallbackMimeType;
        return {
            type: 'base64',
            media_type: mimeType,
            data,
        };
    }
    return {
        type: 'url',
        url: mediaUrl,
    };
}

function convertPartToAnthropic(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'text') {
        return { type: 'text', text: part.text || '\u200b' };
    }
    if (part.type === 'image_url') {
        return {
            type: 'image',
            source: parseAnthropicMediaSource(part.imageUrl, 'image/png'),
        };
    }
    if (part.type === 'input_audio') {
        return {
            type: 'document',
            source: {
                type: 'base64',
                media_type: part.mimeType ?? `audio/${part.format || 'mpeg'}`,
                data: stripDataUrlPrefix(part.data),
            },
        };
    }
    if (part.type === 'video_url') {
        return {
            type: 'document',
            source: parseAnthropicMediaSource(part.videoUrl, part.mimeType ?? 'video/mp4'),
        };
    }
    return {
        type: 'document',
        source: {
            type: 'base64',
            media_type: part.mimeType ?? 'application/pdf',
            data: stripDataUrlPrefix(part.data),
        },
    };
}

function safeParseToolInput(args: string): Record<string, unknown> {
    const trimmed = args.trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed);
        if (isPlainObject(parsed)) {
            return parsed;
        }
        return { value: parsed };
    } catch {
        return { _raw: args };
    }
}

function extractTextForSystem(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n\n');
}

function compileOpenAIPayload(
    request: LLMRequest,
    connection: ApiConnection,
    processed: PostProcessResult,
    useStream: boolean,
    origLastLeadingSystemIdx?: number,
): { body: Record<string, unknown>; cacheBreakpointsApplied: number } {
    const compiledMessages = processed.messages.map((msg) => {
        const out: Record<string, unknown> = {
            role: msg.role,
            content:
                typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.map(convertPartToOpenAI),
        };

        if (msg.name !== undefined) {
            out.name = msg.name;
        }
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            out.tool_calls = msg.toolCalls.map((tc) => {
                const compiledToolCall: Record<string, unknown> = {
                    id: tc.id,
                    type: 'function',
                    function: {
                        name: tc.name,
                        arguments: tc.arguments,
                    },
                };
                applyExtraFields(compiledToolCall, tc.extraFields);
                return compiledToolCall;
            });
        }
        if (msg.role === 'tool' && msg.toolCallId !== undefined) {
            out.tool_call_id = msg.toolCallId;
        }

        applyExtraFields(out, msg.extraFields);
        return out;
    });

    let cacheBreakpointsApplied = 0;
    if (connection.cachePolicy === 'anthropic_explicit') {
        const maxBreakpoints = Math.max(
            0,
            Math.min(
                MAX_ANTHROPIC_CACHE_BREAKPOINTS,
                Math.floor(connection.maxCacheBreakpoints ?? MAX_ANTHROPIC_CACHE_BREAKPOINTS),
            ),
        );
        const targetIndices = selectBreakpointIndices(
            request.cacheBreakpoints,
            processed.indexMap,
            processed.messages,
            maxBreakpoints,
            origLastLeadingSystemIdx,
        );
        for (const idx of targetIndices) {
            if (attachCacheControlToOpenAIMessage(compiledMessages[idx])) {
                cacheBreakpointsApplied += 1;
            }
        }
    }

    const body: Record<string, unknown> = {
        model: connection.model,
        messages: compiledMessages,
        stream: useStream,
    };

    if (useStream) {
        body.stream_options = { include_usage: true };
    }

    if (request.tools.length > 0) {
        body.tools = request.tools.map((tool: CanonicalToolSchema) => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: canonicalClone(tool.parameters),
                ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            },
        }));
        if (request.toolChoice) {
            const validAllowed = resolveValidAllowedToolNames(request.toolChoice, request.tools);
            if (request.toolChoice.mode === 'none' || request.toolChoice.mode === 'auto') {
                body.tool_choice = request.toolChoice.mode;
            } else {
                body.tool_choice =
                    validAllowed.length === 1
                        ? { type: 'function', function: { name: validAllowed[0] } }
                        : 'required';
            }
        }
    }

    if (Number.isFinite(connection.maxTokens) && connection.maxTokens > 0) {
        body.max_tokens = Math.floor(connection.maxTokens);
    }
    if (Number.isFinite(connection.temperature)) {
        body.temperature = connection.temperature;
    }
    if (Number.isFinite(connection.topP)) {
        body.top_p = connection.topP;
    }
    if (Number.isFinite(connection.topK) && connection.topK > 0) {
        body.top_k = Math.floor(connection.topK);
    }
    if (Number.isFinite(connection.frequencyPenalty)) {
        body.frequency_penalty = connection.frequencyPenalty;
    }
    if (Number.isFinite(connection.presencePenalty)) {
        body.presence_penalty = connection.presencePenalty;
    }

    return { body, cacheBreakpointsApplied };
}

function compileAnthropicPayload(
    request: LLMRequest,
    connection: ApiConnection,
    processed: PostProcessResult,
    useStream: boolean,
    origLastLeadingSystemIdx?: number,
): { body: Record<string, unknown>; cacheBreakpointsApplied: number } {
    const msgs = processed.messages;
    const systemBlocks: Array<Record<string, unknown>> = [];
    const blockRefByProcessedIdx = new Map<number, Record<string, unknown>>();

    let idx = 0;
    while (idx < msgs.length && msgs[idx].role === 'system') {
        const text = extractTextForSystem(msgs[idx].content);
        if (text.length > 0) {
            const block: Record<string, unknown> = { type: 'text', text };
            applyExtraFields(block, msgs[idx].extraFields);
            systemBlocks.push(block);
            blockRefByProcessedIdx.set(idx, block);
        }
        idx += 1;
    }

    const anthropicMessages: Array<
        Record<string, unknown> & {
            role: 'user' | 'assistant';
            content: Array<Record<string, unknown>>;
        }
    > = [];
    const anthropicMessageHasExtra: boolean[] = [];

    for (; idx < msgs.length; idx += 1) {
        const msg = msgs[idx];
        let targetRole: 'user' | 'assistant';
        const blocks: Array<Record<string, unknown>> = [];

        if (msg.role === 'tool') {
            targetRole = 'user';
            const toolContent =
                typeof msg.content === 'string'
                    ? msg.content
                    : msg.content.map(convertPartToAnthropic);
            blocks.push({
                type: 'tool_result',
                tool_use_id: msg.toolCallId ?? '',
                content: toolContent,
            });
        } else if (msg.role === 'assistant') {
            targetRole = 'assistant';
            const contentWithPrefix = msg.name ? applyNamePrefixToContent(msg) : msg.content;
            if (typeof contentWithPrefix === 'string') {
                if (contentWithPrefix.length > 0) {
                    blocks.push({ type: 'text', text: contentWithPrefix });
                }
            } else {
                for (const part of contentWithPrefix) {
                    if (part.type === 'text' && !part.text) {
                        continue;
                    }
                    blocks.push(convertPartToAnthropic(part));
                }
            }
            if (msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    const toolUseBlock: Record<string, unknown> = {
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: safeParseToolInput(tc.arguments),
                    };
                    applyExtraFields(toolUseBlock, tc.extraFields);
                    blocks.push(toolUseBlock);
                }
            }
            if (blocks.length === 0) {
                blocks.push({ type: 'text', text: '\u200b' });
            }
        } else {
            // 'user' or mid-conversation 'system' converted to 'user'
            targetRole = 'user';
            const contentWithPrefix =
                msg.name && msg.role !== 'system' ? applyNamePrefixToContent(msg) : msg.content;
            if (typeof contentWithPrefix === 'string') {
                blocks.push({ type: 'text', text: contentWithPrefix || '\u200b' });
            } else if (contentWithPrefix.length > 0) {
                for (const part of contentWithPrefix) {
                    blocks.push(convertPartToAnthropic(part));
                }
            } else {
                blocks.push({ type: 'text', text: '\u200b' });
            }
        }

        blockRefByProcessedIdx.set(idx, blocks[blocks.length - 1]);

        const currHasExtra = hasNonEmptyExtraFields(msg.extraFields);
        const prevIdx = anthropicMessages.length - 1;
        const prev = prevIdx >= 0 ? anthropicMessages[prevIdx] : undefined;
        const prevHasExtra = prevIdx >= 0 ? anthropicMessageHasExtra[prevIdx] : false;

        if (prev && prev.role === targetRole && !prevHasExtra && !currHasExtra) {
            prev.content.push(...blocks);
        } else {
            const compiledMsg: Record<string, unknown> & {
                role: 'user' | 'assistant';
                content: Array<Record<string, unknown>>;
            } = {
                role: targetRole,
                content: blocks,
            };
            applyExtraFields(compiledMsg, msg.extraFields);
            anthropicMessages.push(compiledMsg);
            anthropicMessageHasExtra.push(currHasExtra);
        }
    }

    if (anthropicMessages.length === 0) {
        anthropicMessages.push({
            role: 'user',
            content: [{ type: 'text', text: PROMPT_PLACEHOLDER }],
        });
    } else if (anthropicMessages[0].role !== 'user') {
        anthropicMessages.unshift({
            role: 'user',
            content: [{ type: 'text', text: PROMPT_PLACEHOLDER }],
        });
    }

    const anthropicTools: Array<Record<string, unknown>> = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: canonicalClone(tool.parameters),
    }));

    let cacheBreakpointsApplied = 0;
    if (connection.cachePolicy === 'anthropic_explicit') {
        const maxBreakpoints = Math.max(
            0,
            Math.min(
                MAX_ANTHROPIC_CACHE_BREAKPOINTS,
                Math.floor(connection.maxCacheBreakpoints ?? MAX_ANTHROPIC_CACHE_BREAKPOINTS),
            ),
        );

        const targetIndices = selectBreakpointIndices(
            request.cacheBreakpoints,
            processed.indexMap,
            msgs,
            maxBreakpoints,
            origLastLeadingSystemIdx,
        );

        // If tools exist and we have spare breakpoint budget after message/system targets,
        // cache the end of tools explicitly while staying strictly <= maxBreakpoints (<= 4).
        if (anthropicTools.length > 0 && targetIndices.length < maxBreakpoints && cacheBreakpointsApplied < maxBreakpoints) {
            anthropicTools[anthropicTools.length - 1].cache_control = { type: 'ephemeral' };
            cacheBreakpointsApplied += 1;
        }

        for (const msgIdx of targetIndices) {
            if (cacheBreakpointsApplied >= maxBreakpoints) {
                break;
            }
            const block = blockRefByProcessedIdx.get(msgIdx);
            if (block && !block.cache_control) {
                block.cache_control = { type: 'ephemeral' };
                cacheBreakpointsApplied += 1;
            }
        }

        // Edge case: messages were empty/non-cacheable and tools exist
        if (anthropicTools.length > 0 && cacheBreakpointsApplied === 0 && maxBreakpoints > 0) {
            const lastTool = anthropicTools[anthropicTools.length - 1];
            if (!lastTool.cache_control) {
                lastTool.cache_control = { type: 'ephemeral' };
                cacheBreakpointsApplied += 1;
            }
        }
    }

    const body: Record<string, unknown> = {
        model: connection.model,
        max_tokens:
            Number.isFinite(connection.maxTokens) && connection.maxTokens > 0
                ? Math.floor(connection.maxTokens)
                : 4096,
        messages: anthropicMessages,
        stream: useStream,
    };

    if (systemBlocks.length > 0) {
        body.system = systemBlocks;
    }
    if (anthropicTools.length > 0) {
        body.tools = anthropicTools;
        if (request.toolChoice) {
            const validAllowed = resolveValidAllowedToolNames(request.toolChoice, request.tools);
            if (request.toolChoice.mode === 'none') {
                body.tool_choice = { type: 'none' };
            } else if (request.toolChoice.mode === 'auto') {
                body.tool_choice = { type: 'auto' };
            } else {
                body.tool_choice =
                    validAllowed.length === 1
                        ? { type: 'tool', name: validAllowed[0] }
                        : { type: 'any' };
            }
        }
    }
    if (Number.isFinite(connection.temperature)) {
        body.temperature = connection.temperature;
    }
    if (Number.isFinite(connection.topP)) {
        body.top_p = connection.topP;
    }
    if (Number.isFinite(connection.topK) && connection.topK > 0) {
        body.top_k = Math.floor(connection.topK);
    }

    return { body, cacheBreakpointsApplied };
}

const GEMINI_SUPPORTED_FORMATS = new Set([
    'enum',
    'date-time',
    'float',
    'double',
    'int32',
    'int64',
]);

const GEMINI_SCALAR_SCHEMA_KEYS = [
    'title',
    'description',
    'nullable',
    'minimum',
    'maximum',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'pattern',
    'default',
    'example',
    'propertyOrdering',
] as const;

const AUDIO_FORMAT_MIME_MAP: Record<string, string> = {
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    webm: 'audio/webm',
};

const EXTENSION_MIME_MAP: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
    svg: 'image/svg+xml',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    avi: 'video/x-msvideo',
    mkv: 'video/x-matroska',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    htm: 'text/html',
};

function parseDataUrl(value: string): { mimeType?: string; data: string } | null {
    if (!value.startsWith('data:')) {
        return null;
    }
    const commaIdx = value.indexOf(',');
    const meta = commaIdx >= 0 ? value.slice(5, commaIdx) : '';
    const data = commaIdx >= 0 ? value.slice(commaIdx + 1) : '';
    const rawMime = meta.split(';')[0]?.trim();
    return {
        ...(rawMime ? { mimeType: rawMime } : {}),
        data,
    };
}

function inferMimeFromUrl(url: string, fallback: string): string {
    const clean = url.split(/[?#]/, 1)[0].toLowerCase();
    const lastSlash = clean.lastIndexOf('/');
    const filename = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
    const dotIdx = filename.lastIndexOf('.');
    if (dotIdx >= 0 && dotIdx < filename.length - 1) {
        const ext = filename.slice(dotIdx + 1);
        if (EXTENSION_MIME_MAP[ext]) {
            return EXTENSION_MIME_MAP[ext];
        }
    }
    return fallback;
}

function mapAudioFormatToMime(format: string | undefined): string {
    const normalized = format?.trim().toLowerCase();
    if (normalized && AUDIO_FORMAT_MIME_MAP[normalized]) {
        return AUDIO_FORMAT_MIME_MAP[normalized];
    }
    if (normalized && normalized.includes('/')) {
        return normalized;
    }
    return `audio/${normalized || 'mpeg'}`;
}

function convertPartToGemini(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'text') {
        return { text: part.text || '\u200b' };
    }
    if (part.type === 'image_url') {
        const parsed = parseDataUrl(part.imageUrl);
        if (parsed) {
            return {
                inlineData: {
                    mimeType: parsed.mimeType || 'image/png',
                    data: parsed.data,
                },
            };
        }
        return {
            fileData: {
                mimeType: inferMimeFromUrl(part.imageUrl, 'image/png'),
                fileUri: part.imageUrl,
            },
        };
    }
    if (part.type === 'input_audio') {
        const parsed = parseDataUrl(part.data);
        return {
            inlineData: {
                mimeType: part.mimeType ?? parsed?.mimeType ?? mapAudioFormatToMime(part.format),
                data: parsed ? parsed.data : stripDataUrlPrefix(part.data),
            },
        };
    }
    if (part.type === 'video_url') {
        const parsed = parseDataUrl(part.videoUrl);
        if (parsed) {
            return {
                inlineData: {
                    mimeType: part.mimeType ?? parsed.mimeType ?? 'video/mp4',
                    data: parsed.data,
                },
            };
        }
        return {
            fileData: {
                mimeType: part.mimeType ?? inferMimeFromUrl(part.videoUrl, 'video/mp4'),
                fileUri: part.videoUrl,
            },
        };
    }
    if (/^(?:https?:\/\/|gs:\/\/)/i.test(part.data)) {
        const mimeType = part.mimeType ?? inferMimeFromUrl(part.data, '');
        return {
            fileData: {
                ...(mimeType ? { mimeType } : {}),
                fileUri: part.data,
            },
        };
    }
    const parsed = parseDataUrl(part.data);
    return {
        inlineData: {
            mimeType: part.mimeType ?? parsed?.mimeType ?? 'application/pdf',
            data: parsed ? parsed.data : stripDataUrlPrefix(part.data),
        },
    };
}

/**
 * Recursively converts a JSON Schema (including Zod v4 `z.toJSONSchema` output) into
 * the OpenAPI 3.0 Schema subset accepted by Gemini `functionDeclarations.parameters`.
 */
export function sanitizeGeminiSchema(schema: unknown): Record<string, unknown> {
    if (!isPlainObject(schema)) {
        return { type: 'object' };
    }

    const raw = schema;
    const out: Record<string, unknown> = {};

    for (const key of GEMINI_SCALAR_SCHEMA_KEYS) {
        const value = raw[key];
        if (value !== undefined) {
            out[key] = canonicalClone(value);
        }
    }

    if (typeof raw.exclusiveMinimum === 'number' && out.minimum === undefined) {
        out.minimum = raw.exclusiveMinimum;
    }
    if (typeof raw.exclusiveMaximum === 'number' && out.maximum === undefined) {
        out.maximum = raw.exclusiveMaximum;
    }

    if (raw.const !== undefined) {
        if (typeof raw.const === 'string') {
            out.type = 'string';
            out.enum = [raw.const];
        } else if (typeof raw.const === 'number') {
            out.type = Number.isInteger(raw.const) ? 'integer' : 'number';
        } else if (typeof raw.const === 'boolean') {
            out.type = 'boolean';
        }
    }

    if (Array.isArray(raw.type)) {
        const nonNull = raw.type.filter((t): t is string => typeof t === 'string' && t !== 'null');
        if (raw.type.includes('null')) {
            out.nullable = true;
        }
        if (nonNull.length === 1) {
            out.type = nonNull[0];
        } else if (nonNull.length > 1) {
            out.anyOf = nonNull.map((t) => ({ type: t }));
        }
    } else if (typeof raw.type === 'string' && raw.type !== 'null' && out.type === undefined) {
        out.type = raw.type;
    }

    const unionSource = Array.isArray(raw.anyOf)
        ? raw.anyOf
        : Array.isArray(raw.oneOf)
            ? raw.oneOf
            : undefined;
    if (unionSource) {
        let hasNullBranch = false;
        const nonNullBranches: Array<Record<string, unknown>> = [];
        for (const branch of unionSource) {
            if (isPlainObject(branch) && branch.type === 'null') {
                hasNullBranch = true;
                continue;
            }
            nonNullBranches.push(sanitizeGeminiSchema(branch));
        }
        if (hasNullBranch) {
            out.nullable = true;
        }
        if (nonNullBranches.length === 1) {
            const single = nonNullBranches[0];
            for (const [k, v] of Object.entries(single)) {
                if (out[k] === undefined) {
                    out[k] = v;
                } else if (k === 'nullable' && v === true) {
                    out.nullable = true;
                }
            }
        } else if (nonNullBranches.length > 1) {
            out.anyOf = nonNullBranches;
        }
    }

    if (typeof raw.format === 'string' && GEMINI_SUPPORTED_FORMATS.has(raw.format)) {
        out.format = raw.format;
    }

    if (Array.isArray(raw.enum) && raw.enum.length > 0 && raw.enum.every((v) => typeof v === 'string')) {
        out.enum = [...raw.enum];
        if (!out.type && !out.anyOf) {
            out.type = 'string';
        }
    }

    if (isPlainObject(raw.properties)) {
        const sanitizedProps: Record<string, unknown> = {};
        for (const [propKey, propSchema] of Object.entries(raw.properties)) {
            if (FORBIDDEN_MERGE_KEYS.has(propKey)) {
                continue;
            }
            sanitizedProps[propKey] = sanitizeGeminiSchema(propSchema);
        }
        if (Object.keys(sanitizedProps).length > 0) {
            out.properties = sanitizedProps;
            if (!out.type && !out.anyOf) {
                out.type = 'object';
            }
            if (Array.isArray(raw.required)) {
                const filteredRequired = raw.required.filter(
                    (req): req is string =>
                        typeof req === 'string'
                        && Object.prototype.hasOwnProperty.call(sanitizedProps, req),
                );
                if (filteredRequired.length > 0) {
                    out.required = filteredRequired;
                }
            }
        }
    }

    if (raw.items !== undefined) {
        const rawItems = Array.isArray(raw.items) ? raw.items[0] : raw.items;
        const sanitizedItems = rawItems !== undefined ? sanitizeGeminiSchema(rawItems) : { type: 'string' };
        if (sanitizedItems.type === undefined && sanitizedItems.anyOf === undefined) {
            sanitizedItems.type = 'string';
        }
        out.items = sanitizedItems;
    } else if (out.type === 'array') {
        out.items = { type: 'string' };
    }

    return out;
}

function parsePlainObjectOrResult(text: string): Record<string, unknown> {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (isPlainObject(parsed)) {
                return parsed;
            }
        } catch {
            // Fall through to string wrapper
        }
    }
    return { result: text };
}

function compileGeminiPayload(
    request: LLMRequest,
    connection: ApiConnection,
    processed: PostProcessResult,
): { body: Record<string, unknown>; cacheBreakpointsApplied: number } {
    const msgs = processed.messages;
    const systemParts: Array<Record<string, unknown>> = [];

    let idx = 0;
    while (idx < msgs.length && msgs[idx].role === 'system') {
        const content = msgs[idx].content;
        if (typeof content === 'string') {
            if (content.length > 0) {
                const part: Record<string, unknown> = { text: content };
                applyExtraFields(part, msgs[idx].extraFields);
                systemParts.push(part);
            }
        } else {
            for (const part of content) {
                if (part.type === 'text' && !part.text) {
                    continue;
                }
                const compiledPart = convertPartToGemini(part);
                applyExtraFields(compiledPart, msgs[idx].extraFields);
                systemParts.push(compiledPart);
            }
        }
        idx += 1;
    }

    const toolCallIdToName = new Map<string, string>();
    const contents: Array<
        Record<string, unknown> & {
            role: 'user' | 'model';
            parts: Array<Record<string, unknown>>;
        }
    > = [];
    const contentHasExtra: boolean[] = [];

    for (; idx < msgs.length; idx += 1) {
        const msg = msgs[idx];
        let targetRole: 'user' | 'model';
        const parts: Array<Record<string, unknown>> = [];

        if (msg.role === 'tool') {
            targetRole = 'user';
            const name =
                msg.toolName
                || (msg.toolCallId ? toolCallIdToName.get(msg.toolCallId) : undefined)
                || 'unknown_tool';

            let responseObj: Record<string, unknown>;
            const extraParts: Array<Record<string, unknown>> = [];

            if (typeof msg.content === 'string') {
                responseObj = parsePlainObjectOrResult(msg.content);
            } else {
                const textSegments: string[] = [];
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        if (part.text) {
                            textSegments.push(part.text);
                        }
                    } else {
                        extraParts.push(convertPartToGemini(part));
                    }
                }
                responseObj = parsePlainObjectOrResult(textSegments.join('\n\n'));
            }

            parts.push({ functionResponse: { name, response: responseObj } }, ...extraParts);
        } else if (msg.role === 'assistant') {
            targetRole = 'model';
            const contentWithPrefix = msg.name ? applyNamePrefixToContent(msg) : msg.content;
            if (typeof contentWithPrefix === 'string') {
                if (contentWithPrefix.length > 0) {
                    parts.push({ text: contentWithPrefix });
                }
            } else {
                for (const part of contentWithPrefix) {
                    if (part.type === 'text' && !part.text) {
                        continue;
                    }
                    parts.push(convertPartToGemini(part));
                }
            }

            if (msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    if (tc.id && tc.name) {
                        toolCallIdToName.set(tc.id, tc.name);
                    }
                    const functionCall: Record<string, unknown> = {
                        name: tc.name,
                        args: safeParseToolInput(tc.arguments),
                    };
                    applyExtraFields(functionCall, tc.extraFields);
                    parts.push({
                        functionCall,
                        ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
                    });
                }
            }

            if (parts.length === 0) {
                parts.push({ text: '\u200b' });
            }
        } else {
            // 'user' or mid-conversation 'system' converted to 'user'
            targetRole = 'user';
            const contentWithPrefix =
                msg.name && msg.role !== 'system' ? applyNamePrefixToContent(msg) : msg.content;
            if (typeof contentWithPrefix === 'string') {
                parts.push({ text: contentWithPrefix || '\u200b' });
            } else if (contentWithPrefix.length > 0) {
                for (const part of contentWithPrefix) {
                    parts.push(convertPartToGemini(part));
                }
            } else {
                parts.push({ text: '\u200b' });
            }
        }

        const currHasExtra = hasNonEmptyExtraFields(msg.extraFields);
        const prevIdx = contents.length - 1;
        const prev = prevIdx >= 0 ? contents[prevIdx] : undefined;
        const prevHasExtra = prevIdx >= 0 ? contentHasExtra[prevIdx] : false;

        if (prev && prev.role === targetRole && !prevHasExtra && !currHasExtra) {
            prev.parts.push(...parts);
        } else {
            const contentEntry: Record<string, unknown> & {
                role: 'user' | 'model';
                parts: Array<Record<string, unknown>>;
            } = {
                role: targetRole,
                parts,
            };
            applyExtraFields(contentEntry, msg.extraFields);
            contents.push(contentEntry);
            contentHasExtra.push(currHasExtra);
        }
    }

    if (contents.length === 0) {
        contents.push({ role: 'user', parts: [{ text: PROMPT_PLACEHOLDER }] });
    } else if (contents[0].role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: PROMPT_PLACEHOLDER }] });
    }

    const body: Record<string, unknown> = {
        contents,
    };

    if (systemParts.length > 0) {
        body.systemInstruction = { parts: systemParts };
    }

    if (request.tools.length > 0) {
        const functionDeclarations = request.tools.map((tool) => {
            const sanitized = sanitizeGeminiSchema(tool.parameters);
            const hasProperties =
                isPlainObject(sanitized.properties) && Object.keys(sanitized.properties).length > 0;
            const hasUnion = Array.isArray(sanitized.anyOf) && sanitized.anyOf.length > 0;
            const omitParameters =
                (!sanitized.type || sanitized.type === 'object') && !hasProperties && !hasUnion;
            return {
                name: tool.name,
                description: tool.description,
                ...(omitParameters ? {} : { parameters: sanitized }),
            };
        });
        body.tools = [{ functionDeclarations }];

        if (request.toolChoice) {
            const validAllowed = resolveValidAllowedToolNames(request.toolChoice, request.tools);
            let functionCallingConfig: Record<string, unknown>;
            if (request.toolChoice.mode === 'none') {
                functionCallingConfig = { mode: 'NONE' };
            } else if (request.toolChoice.mode === 'auto') {
                functionCallingConfig = { mode: 'AUTO' };
            } else {
                functionCallingConfig = {
                    mode: 'ANY',
                    ...(validAllowed.length > 0 ? { allowedFunctionNames: validAllowed } : {}),
                };
            }
            body.toolConfig = { functionCallingConfig };
        }
    }

    const generationConfig: Record<string, unknown> = {};
    if (Number.isFinite(connection.maxTokens) && connection.maxTokens > 0) {
        generationConfig.maxOutputTokens = Math.floor(connection.maxTokens);
    }
    if (Number.isFinite(connection.temperature)) {
        generationConfig.temperature = connection.temperature;
    }
    if (Number.isFinite(connection.topP)) {
        generationConfig.topP = connection.topP;
    }
    if (Number.isFinite(connection.topK) && connection.topK > 0) {
        generationConfig.topK = Math.floor(connection.topK);
    }
    if (Number.isFinite(connection.frequencyPenalty) && connection.frequencyPenalty !== 0) {
        generationConfig.frequencyPenalty = connection.frequencyPenalty;
    }
    if (Number.isFinite(connection.presencePenalty) && connection.presencePenalty !== 0) {
        generationConfig.presencePenalty = connection.presencePenalty;
    }
    if (Object.keys(generationConfig).length > 0) {
        body.generationConfig = generationConfig;
    }

    return { body, cacheBreakpointsApplied: 0 };
}

/**
 * Compiles canonical `LLMRequest` + `ApiConnection` into OpenAI Chat Completions,
 * Anthropic Messages, or Google Gemini `generateContent` HTTP request payloads with
 * KV-cache prefix stabilization and explicit Anthropic cache breakpoint placement (capped at 4).
 */
export class PayloadCompiler {
    private readonly anthropicVersion: string;

    constructor(options: PayloadCompilerOptions = {}) {
        this.anthropicVersion = options.anthropicVersion ?? '2023-06-01';
    }

    compile(request: LLMRequest, connection: ApiConnection): CompiledPayload {
        const providerFormat = connection.providerFormat;
        const useStream = request.stream ?? connection.stream;
        const url = buildEndpointUrl(connection.baseUrl, providerFormat, {
            model: connection.model,
            stream: useStream,
        });
        const headers = buildHeaders(connection, this.anthropicVersion);

        const origLastLeadingSystemIdx = findLastLeadingSystemIndex(request.messages);
        const systemMode = connection.systemInstructionMode ?? 'native';
        const roleNormalizedMessages = applySystemInstructionMode(request.messages, systemMode);

        const postMode = connection.promptPostProcessing ?? 'none';
        const processed = postProcessCanonicalMessages(roleNormalizedMessages, postMode);

        const compiled =
            providerFormat === 'anthropic'
                ? compileAnthropicPayload(request, connection, processed, useStream, origLastLeadingSystemIdx)
                : providerFormat === 'gemini'
                    ? compileGeminiPayload(request, connection, processed)
                    : compileOpenAIPayload(request, connection, processed, useStream, origLastLeadingSystemIdx);

        const body = compiled.body;

        if (connection.includeBody && isPlainObject(connection.includeBody)) {
            deepMergeRecord(body, connection.includeBody);
            if (providerFormat === 'gemini') {
                const includeToolConfig = connection.includeBody.toolConfig;
                const includeFcc = isPlainObject(includeToolConfig)
                    ? includeToolConfig.functionCallingConfig
                    : undefined;
                if (
                    isPlainObject(includeFcc)
                    && (includeFcc.mode === 'AUTO' || includeFcc.mode === 'NONE')
                    && includeFcc.allowedFunctionNames === undefined
                    && isPlainObject(body.toolConfig)
                    && isPlainObject(body.toolConfig.functionCallingConfig)
                ) {
                    delete body.toolConfig.functionCallingConfig.allowedFunctionNames;
                }
            } else if (providerFormat === 'anthropic') {
                const includeToolChoice = connection.includeBody.tool_choice;
                if (
                    isPlainObject(includeToolChoice)
                    && (includeToolChoice.type === 'auto'
                        || includeToolChoice.type === 'none'
                        || includeToolChoice.type === 'any')
                    && includeToolChoice.name === undefined
                    && isPlainObject(body.tool_choice)
                ) {
                    delete body.tool_choice.name;
                }
            }
        }
        if (connection.excludeBody && isPlainObject(connection.excludeBody)) {
            applyExcludeRecord(body, connection.excludeBody);
        }

        const canonicalBody =
            connection.cachePolicy === 'auto_prefix' ? canonicalClone(body) : body;
        const serializedBody =
            connection.cachePolicy === 'auto_prefix'
                ? canonicalStringify(canonicalBody)
                : JSON.stringify(canonicalBody);

        return {
            url,
            method: 'POST',
            headers,
            body: canonicalBody,
            serializedBody,
            providerFormat,
            cacheBreakpointsApplied: compiled.cacheBreakpointsApplied,
        };
    }

    /** Compiles an `ApiConnection` into a `GET /models` discovery request. */
    compileModelsRequest(connection: ApiConnection): CompiledModelsRequest {
        const providerFormat = connection.providerFormat;
        const url = buildModelsEndpointUrl(connection.baseUrl, providerFormat);
        const headers = buildHeaders(connection, this.anthropicVersion, {
            defaultContentType: false,
        });
        return {
            url,
            method: 'GET',
            headers,
            providerFormat,
        };
    }
}
