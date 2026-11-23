import type { LLMRequest } from '../bridge';
import type {
    ApiConnection,
    ApiProviderFormat,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolSchema,
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
    return proto === Object.prototype || proto === null;
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

function cloneContent(content: string | CanonicalContentPart[]): string | CanonicalContentPart[] {
    if (typeof content === 'string') {
        return content;
    }
    return content.map((part) => ({ ...part }));
}

function cloneMessage(msg: CanonicalMessage): CanonicalMessage {
    return {
        role: msg.role,
        content: cloneContent(msg.content),
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.reasoningContent !== undefined ? { reasoningContent: msg.reasoningContent } : {}),
        ...(msg.toolCalls !== undefined
            ? { toolCalls: msg.toolCalls.map((tc) => ({ ...tc })) }
            : {}),
        ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
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
            && !curr.toolCalls?.length;

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

function buildEndpointUrl(baseUrl: string, providerFormat: ApiProviderFormat): string {
    const base = baseUrl.trim().replace(/\/+$/, '');
    if (!base) {
        throw new LLMTransportError('API connection baseUrl is required', { retryable: false });
    }

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
 * Resolves the `/models` endpoint URL for OpenAI-compatible and Anthropic connections,
 * preserving optional query strings and supporting relative proxy paths.
 */
export function buildModelsEndpointUrl(baseUrl: string, providerFormat: ApiProviderFormat): string {
    const trimmed = baseUrl.trim();
    const queryIdx = trimmed.indexOf('?');
    const rawPath = queryIdx >= 0 ? trimmed.slice(0, queryIdx) : trimmed;
    const querySuffix = queryIdx >= 0 ? trimmed.slice(queryIdx) : '';
    const base = rawPath.replace(/\/+$/, '');
    if (!base) {
        throw new LLMTransportError('API connection baseUrl is required', { retryable: false });
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
        // Default to Layer 0 end: last leading system message, or message 0 if no system prefix.
        let lastLeadingSystem = -1;
        for (let i = 0; i < processedMessages.length; i += 1) {
            if (processedMessages[i].role === 'system') {
                lastLeadingSystem = i;
            } else {
                break;
            }
        }
        candidates = [lastLeadingSystem >= 0 ? lastLeadingSystem : 0];
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

function parseAnthropicImageSource(imageUrl: string): Record<string, unknown> {
    if (imageUrl.startsWith('data:')) {
        const commaIdx = imageUrl.indexOf(',');
        const meta = commaIdx >= 0 ? imageUrl.slice(5, commaIdx) : '';
        const data = commaIdx >= 0 ? imageUrl.slice(commaIdx + 1) : '';
        const mimeType = meta.split(';')[0] || 'image/png';
        return {
            type: 'base64',
            media_type: mimeType,
            data,
        };
    }
    return {
        type: 'url',
        url: imageUrl,
    };
}

function convertPartToAnthropic(part: CanonicalContentPart): Record<string, unknown> {
    if (part.type === 'text') {
        return { type: 'text', text: part.text || '\u200b' };
    }
    if (part.type === 'image_url') {
        return {
            type: 'image',
            source: parseAnthropicImageSource(part.imageUrl),
        };
    }
    return {
        type: 'document',
        source: {
            type: 'base64',
            media_type: part.mimeType ?? 'application/pdf',
            data: part.data,
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
            out.tool_calls = msg.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: tc.arguments,
                },
            }));
        }
        if (msg.role === 'tool' && msg.toolCallId !== undefined) {
            out.tool_call_id = msg.toolCallId;
        }

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
): { body: Record<string, unknown>; cacheBreakpointsApplied: number } {
    const msgs = processed.messages;
    const systemBlocks: Array<Record<string, unknown>> = [];
    const blockRefByProcessedIdx = new Map<number, Record<string, unknown>>();

    let idx = 0;
    while (idx < msgs.length && msgs[idx].role === 'system') {
        const text = extractTextForSystem(msgs[idx].content);
        if (text.length > 0) {
            const block: Record<string, unknown> = { type: 'text', text };
            systemBlocks.push(block);
            blockRefByProcessedIdx.set(idx, block);
        }
        idx += 1;
    }

    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

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
                    blocks.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: safeParseToolInput(tc.arguments),
                    });
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

        const prev = anthropicMessages[anthropicMessages.length - 1];
        if (prev && prev.role === targetRole) {
            prev.content.push(...blocks);
        } else {
            anthropicMessages.push({ role: targetRole, content: blocks });
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

/**
 * Compiles canonical `LLMRequest` + `ApiConnection` into OpenAI Chat Completions
 * or Anthropic Messages HTTP request payloads with KV-cache prefix stabilization
 * and explicit Anthropic cache breakpoint placement (capped at 4).
 */
export class PayloadCompiler {
    private readonly anthropicVersion: string;

    constructor(options: PayloadCompilerOptions = {}) {
        this.anthropicVersion = options.anthropicVersion ?? '2023-06-01';
    }

    compile(request: LLMRequest, connection: ApiConnection): CompiledPayload {
        const providerFormat = connection.providerFormat;
        const url = buildEndpointUrl(connection.baseUrl, providerFormat);
        const headers = buildHeaders(connection, this.anthropicVersion);
        const useStream = request.stream ?? connection.stream;

        const postMode = connection.promptPostProcessing ?? 'none';
        const processed = postProcessCanonicalMessages(request.messages, postMode);

        const compiled =
            providerFormat === 'anthropic'
                ? compileAnthropicPayload(request, connection, processed, useStream)
                : compileOpenAIPayload(request, connection, processed, useStream);

        const body = compiled.body;

        if (connection.includeBody && isPlainObject(connection.includeBody)) {
            deepMergeRecord(body, connection.includeBody);
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
