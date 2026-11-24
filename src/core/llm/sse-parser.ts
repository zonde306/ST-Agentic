import type { LLMResponse, LLMStreamChunk } from '../bridge';
import type { ApiProviderFormat, CanonicalToolCall, TokenUsage } from '../types';
import {
    createAbortError,
    isAbortError,
    isContextOverflowError,
    isRetryableStatus,
    LLMTransportError,
} from './errors';

export interface SSEEvent {
    event: string;
    data: string;
    id?: string;
}

export interface SSEParserOptions {
    /** Hint for provider format ('openai' | 'anthropic' | 'gemini'); auto-detected per frame when omitted. */
    providerFormat?: ApiProviderFormat;
    /** Parse inline `<think>...</think>` blocks inside text deltas into `reasoning_delta` (default: true). */
    parseThinkTags?: boolean;
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

function trailingPrefixLength(text: string, tag: string): number {
    const maxLen = Math.min(text.length, tag.length - 1);
    for (let len = maxLen; len >= 1; len -= 1) {
        if (text.endsWith(tag.slice(0, len))) {
            return len;
        }
    }
    return 0;
}

class ThinkTagSplitter {
    private inThink = false;
    private buffer = '';

    feed(text: string): Array<{ kind: 'text' | 'reasoning'; value: string }> {
        if (!text) {
            return [];
        }
        this.buffer += text;
        const out: Array<{ kind: 'text' | 'reasoning'; value: string }> = [];

        while (this.buffer.length > 0) {
            if (!this.inThink) {
                const openIdx = this.buffer.indexOf(THINK_OPEN);
                if (openIdx >= 0) {
                    if (openIdx > 0) {
                        out.push({ kind: 'text', value: this.buffer.slice(0, openIdx) });
                    }
                    this.buffer = this.buffer.slice(openIdx + THINK_OPEN.length);
                    this.inThink = true;
                    continue;
                }
                const holdLen = trailingPrefixLength(this.buffer, THINK_OPEN);
                const emitLen = this.buffer.length - holdLen;
                if (emitLen > 0) {
                    out.push({ kind: 'text', value: this.buffer.slice(0, emitLen) });
                    this.buffer = this.buffer.slice(emitLen);
                }
                break;
            } else {
                const closeIdx = this.buffer.indexOf(THINK_CLOSE);
                if (closeIdx >= 0) {
                    if (closeIdx > 0) {
                        out.push({ kind: 'reasoning', value: this.buffer.slice(0, closeIdx) });
                    }
                    this.buffer = this.buffer.slice(closeIdx + THINK_CLOSE.length);
                    this.inThink = false;
                    continue;
                }
                const holdLen = trailingPrefixLength(this.buffer, THINK_CLOSE);
                const emitLen = this.buffer.length - holdLen;
                if (emitLen > 0) {
                    out.push({ kind: 'reasoning', value: this.buffer.slice(0, emitLen) });
                    this.buffer = this.buffer.slice(emitLen);
                }
                break;
            }
        }

        return out;
    }

    flush(): Array<{ kind: 'text' | 'reasoning'; value: string }> {
        if (!this.buffer) {
            return [];
        }
        const value = this.buffer;
        this.buffer = '';
        return [{ kind: this.inThink ? 'reasoning' : 'text', value }];
    }

    reset(): void {
        this.inThink = false;
        this.buffer = '';
    }
}

export function splitThinkTagsStatic(text: string): { content: string; reasoning: string } {
    const splitter = new ThinkTagSplitter();
    const parts = [...splitter.feed(text), ...splitter.flush()];
    let content = '';
    let reasoning = '';
    for (const part of parts) {
        if (part.kind === 'reasoning') {
            reasoning += part.value;
        } else {
            content += part.value;
        }
    }
    return { content, reasoning };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const PERMANENT_STREAM_ERROR_CODES = new Set([
    'invalid_api_key',
    'authentication_error',
    'permission_error',
    'invalid_request_error',
    'insufficient_quota',
    'billing_hard_limit_reached',
    'not_found_error',
    'invalid_argument',
    'unauthenticated',
    'permission_denied',
    'not_found',
    'failed_precondition',
]);

const RETRYABLE_STREAM_ERROR_CODES = new Set([
    'overloaded_error',
    'rate_limit_error',
    'api_error',
    'server_error',
    'internal_error',
    'service_unavailable',
    'timeout',
    'request_timeout',
    'bad_gateway',
    'gateway_timeout',
    'temporarily_unavailable',
    'resource_exhausted',
    'unavailable',
    'internal',
    'deadline_exceeded',
    'aborted',
]);

const PERMANENT_STREAM_ERROR_MSG_RE =
    /\b(invalid[\s_-]?api[\s_-]?key|authentication|unauthorized|forbidden|permission|quota[\s_-]?exceeded|insufficient[\s_-]?quota|invalid[\s_-]?request)\b/i;

const RETRYABLE_STREAM_ERROR_MSG_RE =
    /\b(overloaded|rate[\s_-]?limit|too many requests|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway timeout|timed?\s*out|connection reset|try again|upstream)\b/i;

function isRetryableStreamError(rawError: unknown, message: string): boolean {
    if (isContextOverflowError(message) || (isRecord(rawError) && isContextOverflowError(rawError))) {
        return false;
    }

    if (isRecord(rawError)) {
        const status = asNumber(rawError.status) ?? asNumber(rawError.code);
        if (status !== undefined) {
            if (isRetryableStatus(status)) {
                return true;
            }
            if (status >= 400 && status < 500) {
                return false;
            }
        }

        const typeStr = asNonEmptyString(rawError.type)?.trim().toLowerCase() ?? '';
        const codeStr = asNonEmptyString(rawError.code)?.trim().toLowerCase() ?? '';
        const statusStr = asNonEmptyString(rawError.status)?.trim().toLowerCase() ?? '';
        if (
            PERMANENT_STREAM_ERROR_CODES.has(typeStr)
            || PERMANENT_STREAM_ERROR_CODES.has(codeStr)
            || PERMANENT_STREAM_ERROR_CODES.has(statusStr)
        ) {
            return false;
        }
        if (
            RETRYABLE_STREAM_ERROR_CODES.has(typeStr)
            || RETRYABLE_STREAM_ERROR_CODES.has(codeStr)
            || RETRYABLE_STREAM_ERROR_CODES.has(statusStr)
        ) {
            return true;
        }
    }

    if (PERMANENT_STREAM_ERROR_MSG_RE.test(message)) {
        return false;
    }

    return RETRYABLE_STREAM_ERROR_MSG_RE.test(message);
}

function createStreamErrorFromPayload(
    parsed: Record<string, unknown>,
    message: string,
    extra?: { responseBody?: string },
): LLMTransportError {
    const rawErrObj = isRecord(parsed.error)
        ? parsed.error
        : isRecord(parsed.detail) && isRecord(parsed.detail.error)
            ? parsed.detail.error
            : parsed;
    const status = asNumber(rawErrObj.status) ?? asNumber(rawErrObj.code) ?? asNumber(parsed.status);
    const code =
        asNonEmptyString(rawErrObj.code)
        ?? asNonEmptyString(rawErrObj.type)
        ?? asNonEmptyString(rawErrObj.status);
    return new LLMTransportError(message, {
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
        retryable: isRetryableStreamError(rawErrObj, message),
        ...(extra?.responseBody !== undefined ? { responseBody: extra.responseBody } : {}),
    });
}

function extractStreamErrorMessage(parsed: Record<string, unknown>): string | null {
    if (parsed.quota_error) {
        return 'Quota exceeded';
    }

    const rawError = parsed.error ?? (isRecord(parsed.detail) ? parsed.detail.error : undefined);
    if (rawError !== undefined && rawError !== null) {
        if (typeof rawError === 'string') {
            return rawError || 'Unknown API error';
        }
        if (isRecord(rawError)) {
            return (
                asNonEmptyString(rawError.message)
                ?? asNonEmptyString(rawError.code)
                ?? asNonEmptyString(rawError.type)
                ?? asNonEmptyString(rawError.status)
                ?? 'Unknown API error'
            );
        }
    }

    const looksLikeChunk =
        Array.isArray(parsed.choices)
        || Array.isArray(parsed.candidates)
        || isRecord(parsed.usageMetadata)
        || isRecord(parsed.promptFeedback)
        || isRecord(parsed.content_block)
        || isRecord(parsed.delta)
        || isRecord(parsed.message)
        || typeof parsed.type === 'string';

    if (looksLikeChunk) {
        return null;
    }

    if (typeof parsed.detail === 'string' && parsed.detail) {
        return parsed.detail;
    }
    if (typeof parsed.message === 'string' && parsed.message) {
        return parsed.message;
    }

    return null;
}

function extractThoughtSignatureFromToolDelta(tc: Record<string, unknown>): string | undefined {
    const direct =
        asNonEmptyString(tc.thoughtSignature)
        ?? asNonEmptyString(tc.thought_signature)
        ?? asNonEmptyString(tc.signature);
    if (direct) {
        return direct;
    }

    if (isRecord(tc.extra_content) && isRecord(tc.extra_content.google)) {
        const googleSig =
            asNonEmptyString(tc.extra_content.google.thought_signature)
            ?? asNonEmptyString(tc.extra_content.google.thoughtSignature);
        if (googleSig) {
            return googleSig;
        }
    }

    if (isRecord(tc.function)) {
        const fnSig =
            asNonEmptyString(tc.function.thoughtSignature)
            ?? asNonEmptyString(tc.function.thought_signature);
        if (fnSig) {
            return fnSig;
        }
    }

    return undefined;
}

function buildUsage(
    inputTokens: number,
    cachedTokens: number,
    outputTokens: number,
    totalTokens?: number,
): TokenUsage {
    const computedTotal = totalTokens ?? inputTokens + outputTokens;
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens: computedTotal,
        cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    };
}

function parseOpenAIUsage(rawUsage: Record<string, unknown>, prev?: TokenUsage): TokenUsage {
    const promptDetails = isRecord(rawUsage.prompt_tokens_details)
        ? rawUsage.prompt_tokens_details
        : isRecord(rawUsage.input_tokens_details)
            ? rawUsage.input_tokens_details
            : undefined;

    const cached =
        asNumber(promptDetails?.cached_tokens)
        ?? asNumber(rawUsage.prompt_cache_hit_tokens)
        ?? asNumber(rawUsage.cached_tokens)
        ?? asNumber(rawUsage.cache_read_input_tokens)
        ?? prev?.cachedTokens
        ?? 0;

    const input =
        asNumber(rawUsage.prompt_tokens)
        ?? asNumber(rawUsage.input_tokens)
        ?? prev?.inputTokens
        ?? 0;

    const output =
        asNumber(rawUsage.completion_tokens)
        ?? asNumber(rawUsage.output_tokens)
        ?? prev?.outputTokens
        ?? 0;

    const total = asNumber(rawUsage.total_tokens);
    return buildUsage(input, cached, output, total);
}

function parseAnthropicUsage(rawUsage: Record<string, unknown>, prev?: TokenUsage): TokenUsage {
    const uncachedInput = asNumber(rawUsage.input_tokens);
    const cacheRead = asNumber(rawUsage.cache_read_input_tokens);
    const cacheCreate = asNumber(rawUsage.cache_creation_input_tokens);

    let inputTokens = prev?.inputTokens ?? 0;
    let cachedTokens = prev?.cachedTokens ?? 0;

    if (uncachedInput !== undefined || cacheRead !== undefined || cacheCreate !== undefined) {
        const readVal = cacheRead ?? prev?.cachedTokens ?? 0;
        const createVal = cacheCreate ?? 0;
        const uncachedVal = uncachedInput ?? 0;
        cachedTokens = readVal;
        inputTokens = uncachedVal + readVal + createVal;
    }

    const outputTokens = asNumber(rawUsage.output_tokens) ?? prev?.outputTokens ?? 0;
    return buildUsage(inputTokens, cachedTokens, outputTokens);
}

function parseGeminiUsage(rawUsage: Record<string, unknown>, prev?: TokenUsage): TokenUsage {
    const input = asNumber(rawUsage.promptTokenCount) ?? prev?.inputTokens ?? 0;
    const cached = asNumber(rawUsage.cachedContentTokenCount) ?? prev?.cachedTokens ?? 0;
    const candidatesOut = asNumber(rawUsage.candidatesTokenCount);
    const thoughtsOut = asNumber(rawUsage.thoughtsTokenCount);
    const output =
        candidatesOut !== undefined || thoughtsOut !== undefined
            ? (candidatesOut ?? 0) + (thoughtsOut ?? 0)
            : (prev?.outputTokens ?? 0);
    const total = asNumber(rawUsage.totalTokenCount);
    return buildUsage(input, cached, output, total);
}

function parseSSEBlock(block: string): SSEEvent | null {
    const lines = block.split('\n');
    let eventType = 'message';
    let id: string | undefined;
    const dataLines: string[] = [];

    for (const line of lines) {
        if (!line || line.startsWith(':')) {
            continue;
        }
        const colonIdx = line.indexOf(':');
        const field = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
        let value = colonIdx >= 0 ? line.slice(colonIdx + 1) : '';
        if (value.startsWith(' ')) {
            value = value.slice(1);
        }

        if (field === 'event') {
            eventType = value || 'message';
        } else if (field === 'data') {
            dataLines.push(value);
        } else if (field === 'id' && !value.includes('\0')) {
            id = value;
        }
    }

    if (dataLines.length === 0) {
        return null;
    }

    return {
        event: eventType,
        data: dataLines.join('\n'),
        ...(id !== undefined ? { id } : {}),
    };
}

/**
 * Incremental Server-Sent Events parser supporting split UTF-8 network chunks,
 * OpenAI Chat Completions, Anthropic Messages, DeepSeek/OpenRouter reasoning,
 * inline `<think>` blocks, multi-tool incremental assembly, Gemini `thoughtSignature`,
 * and cached token usage reporting.
 */
export class SSEParser {
    private readonly parseThinkTags: boolean;
    private readonly decoder = new TextDecoder('utf-8');
    private readonly thinkSplitter = new ThinkTagSplitter();

    private rawBuffer = '';
    private content = '';
    private reasoningContent = '';
    private readonly toolCalls = new Map<number, CanonicalToolCall>();
    private readonly anthropicBlockToToolIdx = new Map<number, number>();
    private nextAnthropicToolIdx = 0;
    private readonly toolSignaturesById = new Map<string, string>();
    private usage: TokenUsage = {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
    };
    private hasUsage = false;
    private finishReason?: string;
    private doneEmitted = false;

    constructor(options: SSEParserOptions = {}) {
        this.parseThinkTags = options.parseThinkTags ?? true;
        // `providerFormat` option accepted for symmetry/future hints; events self-identify cleanly.
        void options.providerFormat;
    }

    /**
     * Feeds a raw network chunk (UTF-8 bytes or string) and returns all newly parsed `LLMStreamChunk`s.
     */
    feed(chunk: Uint8Array | string): LLMStreamChunk[] {
        const text =
            typeof chunk === 'string'
                ? chunk
                : this.decoder.decode(chunk, { stream: true });

        if (!text) {
            return [];
        }

        this.rawBuffer = (this.rawBuffer + text)
            .replace(/\r\n/g, '\n')
            .replace(/\r(?!$)/g, '\n');

        const events = this.rawBuffer.split('\n\n');
        this.rawBuffer = events.pop() ?? '';

        const emitted: LLMStreamChunk[] = [];
        for (const block of events) {
            const sseEvent = parseSSEBlock(block);
            if (!sseEvent) {
                continue;
            }
            emitted.push(...this.processEvent(sseEvent));
        }

        return emitted;
    }

    /**
     * Flushes any trailing UTF-8 bytes, buffered SSE frame, `<think>` tag buffer, and final `done` marker.
     */
    flush(): LLMStreamChunk[] {
        const emitted: LLMStreamChunk[] = [];

        const decoderTail = this.decoder.decode();
        if (decoderTail) {
            this.rawBuffer += decoderTail;
        }

        this.rawBuffer = this.rawBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (this.rawBuffer.trim().length > 0) {
            const blocks = this.rawBuffer.split('\n\n');
            this.rawBuffer = '';
            for (const block of blocks) {
                const sseEvent = parseSSEBlock(block);
                if (sseEvent) {
                    emitted.push(...this.processEvent(sseEvent));
                }
            }
        } else {
            this.rawBuffer = '';
        }

        if (this.parseThinkTags) {
            for (const part of this.thinkSplitter.flush()) {
                this.pushTextOrReasoningPart(part, emitted);
            }
        }

        if (!this.doneEmitted) {
            this.doneEmitted = true;
            emitted.push({
                type: 'done',
                ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
            });
        }

        return emitted;
    }

    /**
     * Returns the fully assembled `LLMResponse` from all chunks processed so far.
     */
    getResult(): LLMResponse {
        const sortedTools = Array.from(this.toolCalls.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => ({ ...tc }));

        return {
            content: this.content,
            ...(this.reasoningContent ? { reasoningContent: this.reasoningContent } : {}),
            toolCalls: sortedTools,
            usage: { ...this.usage },
            ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
        };
    }

    reset(): void {
        this.rawBuffer = '';
        this.content = '';
        this.reasoningContent = '';
        this.toolCalls.clear();
        this.anthropicBlockToToolIdx.clear();
        this.nextAnthropicToolIdx = 0;
        this.toolSignaturesById.clear();
        this.usage = {
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheHitRate: 0,
        };
        this.hasUsage = false;
        this.finishReason = undefined;
        this.doneEmitted = false;
        this.thinkSplitter.reset();
    }

    private pushTextOrReasoningPart(
        part: { kind: 'text' | 'reasoning'; value: string },
        out: LLMStreamChunk[],
    ): void {
        if (!part.value) {
            return;
        }
        if (part.kind === 'reasoning') {
            this.reasoningContent += part.value;
            out.push({ type: 'reasoning_delta', reasoningDelta: part.value });
        } else {
            this.content += part.value;
            out.push({ type: 'text_delta', textDelta: part.value });
        }
    }

    private emitText(text: string, out: LLMStreamChunk[]): void {
        if (!text) {
            return;
        }
        if (!this.parseThinkTags) {
            this.content += text;
            out.push({ type: 'text_delta', textDelta: text });
            return;
        }
        for (const part of this.thinkSplitter.feed(text)) {
            this.pushTextOrReasoningPart(part, out);
        }
    }

    private emitReasoning(reasoning: string, out: LLMStreamChunk[]): void {
        if (!reasoning) {
            return;
        }
        this.reasoningContent += reasoning;
        out.push({ type: 'reasoning_delta', reasoningDelta: reasoning });
    }

    private processEvent(sseEvent: SSEEvent): LLMStreamChunk[] {
        const rawData = sseEvent.data.trim();
        if (!rawData) {
            return [];
        }

        if (rawData === '[DONE]') {
            const out: LLMStreamChunk[] = [];
            if (this.parseThinkTags) {
                for (const part of this.thinkSplitter.flush()) {
                    this.pushTextOrReasoningPart(part, out);
                }
            }
            if (!this.doneEmitted) {
                this.doneEmitted = true;
                out.push({
                    type: 'done',
                    ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
                });
            }
            return out;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawData);
        } catch {
            return [];
        }

        if (!isRecord(parsed)) {
            return [];
        }

        const errorMsg = extractStreamErrorMessage(parsed);
        if (errorMsg) {
            throw createStreamErrorFromPayload(parsed, errorMsg);
        }

        const out: LLMStreamChunk[] = [];

        if (
            typeof parsed.type === 'string'
            && !Array.isArray(parsed.choices)
            && !Array.isArray(parsed.candidates)
            && !isRecord(parsed.usageMetadata)
            && !isRecord(parsed.promptFeedback)
        ) {
            this.processAnthropicEvent(sseEvent.event, parsed, out);
            return out;
        }

        if (
            Array.isArray(parsed.candidates)
            || isRecord(parsed.usageMetadata)
            || isRecord(parsed.promptFeedback)
        ) {
            this.processGeminiEvent(parsed, out);
            return out;
        }

        if (Array.isArray(parsed.choices) || isRecord(parsed.usage)) {
            this.processOpenAIEvent(parsed, out);
            return out;
        }

        return out;
    }

    private processOpenAIEvent(parsed: Record<string, unknown>, out: LLMStreamChunk[]): void {
        const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
        const choice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;

        if (choice && (typeof choice.index !== 'number' || choice.index === 0)) {
            const delta = isRecord(choice.delta) ? choice.delta : undefined;
            const message = isRecord(choice.message) ? choice.message : undefined;

            // 1. OpenRouter encrypted reasoning_details -> map signatures to tool call IDs
            const reasoningDetails: unknown[] = [
                ...(Array.isArray(delta?.reasoning_details) ? delta.reasoning_details : []),
                ...(Array.isArray(message?.reasoning_details) ? message.reasoning_details : []),
            ];
            const updatedSigIndices = new Set<number>();

            for (const detail of reasoningDetails) {
                if (!isRecord(detail)) {
                    continue;
                }
                if (detail.type === 'reasoning.encrypted' && typeof detail.data === 'string' && detail.data) {
                    const detailId = asNonEmptyString(detail.id);
                    if (detailId) {
                        this.toolSignaturesById.set(detailId, detail.data);
                        for (const [idx, existingCall] of this.toolCalls.entries()) {
                            if (existingCall.id === detailId && existingCall.thoughtSignature !== detail.data) {
                                existingCall.thoughtSignature = detail.data;
                                updatedSigIndices.add(idx);
                            }
                        }
                    }
                }
            }

            // 2. Reasoning fields (DeepSeek, OpenRouter, xAI, Mistral)
            const reasoningText =
                asNonEmptyString(delta?.reasoning_content)
                ?? asNonEmptyString(delta?.reasoning)
                ?? asNonEmptyString(message?.reasoning_content)
                ?? asNonEmptyString(message?.reasoning);

            if (reasoningText) {
                this.emitReasoning(reasoningText, out);
            } else if (Array.isArray(delta?.content)) {
                for (const item of delta.content) {
                    if (isRecord(item) && Array.isArray(item.thinking)) {
                        for (const t of item.thinking) {
                            if (isRecord(t) && typeof t.text === 'string' && t.text) {
                                this.emitReasoning(t.text, out);
                            }
                        }
                    }
                }
            }

            // 3. Text content delta (with optional inline <think> extraction)
            if (typeof delta?.content === 'string' && delta.content.length > 0) {
                this.emitText(delta.content, out);
            } else if (typeof delta?.text === 'string' && delta.text.length > 0) {
                this.emitText(delta.text, out);
            } else if (Array.isArray(delta?.content)) {
                for (const item of delta.content) {
                    if (isRecord(item) && item.type === 'text' && typeof item.text === 'string' && item.text) {
                        this.emitText(item.text, out);
                    }
                }
            } else if (!delta && typeof message?.content === 'string' && message.content.length > 0) {
                this.emitText(message.content, out);
            } else if (typeof choice.text === 'string' && choice.text.length > 0) {
                this.emitText(choice.text, out);
            }

            // 4. Incremental multi-tool call deltas
            const rawToolCalls = Array.isArray(delta?.tool_calls)
                ? delta.tool_calls
                : Array.isArray(message?.tool_calls)
                    ? message.tool_calls
                    : undefined;

            const emittedIndicesThisFrame = new Set<number>();

            if (rawToolCalls) {
                for (let arrIdx = 0; arrIdx < rawToolCalls.length; arrIdx += 1) {
                    const rawTc = rawToolCalls[arrIdx];
                    if (!isRecord(rawTc)) {
                        continue;
                    }
                    const toolIdx =
                        typeof rawTc.index === 'number' && rawTc.index >= 0
                            ? rawTc.index
                            : arrIdx;

                    const existing = this.toolCalls.get(toolIdx) ?? {
                        id: '',
                        name: '',
                        arguments: '',
                    };

                    const incomingId = asNonEmptyString(rawTc.id);
                    if (incomingId && !existing.id) {
                        existing.id = incomingId;
                    }

                    const fn = isRecord(rawTc.function) ? rawTc.function : undefined;
                    const incomingName = asNonEmptyString(fn?.name) ?? asNonEmptyString(rawTc.name);
                    if (incomingName && !existing.name) {
                        existing.name = incomingName;
                    }

                    const argsDelta =
                        typeof fn?.arguments === 'string'
                            ? fn.arguments
                            : typeof rawTc.arguments === 'string'
                                ? rawTc.arguments
                                : undefined;

                    if (argsDelta) {
                        existing.arguments += argsDelta;
                    }

                    const sig =
                        extractThoughtSignatureFromToolDelta(rawTc)
                        ?? (existing.id ? this.toolSignaturesById.get(existing.id) : undefined);

                    if (sig) {
                        existing.thoughtSignature = sig;
                    }

                    this.toolCalls.set(toolIdx, existing);
                    emittedIndicesThisFrame.add(toolIdx);
                    updatedSigIndices.delete(toolIdx);

                    out.push({
                        type: 'tool_call_delta',
                        toolCallIndex: toolIdx,
                        ...(existing.id ? { toolCallId: existing.id } : {}),
                        ...(existing.name ? { toolName: existing.name } : {}),
                        ...(argsDelta !== undefined ? { argumentsDelta: argsDelta } : {}),
                        ...(sig ? { thoughtSignature: sig } : {}),
                    });
                }
            }

            for (const sigIdx of updatedSigIndices) {
                if (emittedIndicesThisFrame.has(sigIdx)) {
                    continue;
                }
                const call = this.toolCalls.get(sigIdx);
                if (call?.thoughtSignature) {
                    out.push({
                        type: 'tool_call_delta',
                        toolCallIndex: sigIdx,
                        ...(call.id ? { toolCallId: call.id } : {}),
                        ...(call.name ? { toolName: call.name } : {}),
                        thoughtSignature: call.thoughtSignature,
                    });
                }
            }

            if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
                this.finishReason = choice.finish_reason;
            }
        }

        if (isRecord(parsed.usage)) {
            this.usage = parseOpenAIUsage(parsed.usage, this.hasUsage ? this.usage : undefined);
            this.hasUsage = true;
            out.push({ type: 'usage', usage: { ...this.usage } });
        }
    }

    private processAnthropicEvent(
        eventName: string,
        parsed: Record<string, unknown>,
        out: LLMStreamChunk[],
    ): void {
        const type = asNonEmptyString(parsed.type) ?? eventName;

        if (type === 'ping') {
            return;
        }

        if (type === 'error') {
            const errObj = isRecord(parsed.error) ? parsed.error : undefined;
            const message =
                asNonEmptyString(errObj?.message)
                ?? asNonEmptyString(errObj?.type)
                ?? 'Anthropic stream error';
            throw createStreamErrorFromPayload(parsed, message);
        }

        if (type === 'message_start') {
            const message = isRecord(parsed.message) ? parsed.message : undefined;
            if (isRecord(message?.usage)) {
                this.usage = parseAnthropicUsage(message.usage, this.hasUsage ? this.usage : undefined);
                this.hasUsage = true;
                out.push({ type: 'usage', usage: { ...this.usage } });
            }
            return;
        }

        if (type === 'content_block_start') {
            const blockIndex = typeof parsed.index === 'number' ? parsed.index : 0;
            const block = isRecord(parsed.content_block) ? parsed.content_block : undefined;
            if (!block) {
                return;
            }

            if (block.type === 'tool_use') {
                const toolIdx = this.nextAnthropicToolIdx;
                this.nextAnthropicToolIdx += 1;
                this.anthropicBlockToToolIdx.set(blockIndex, toolIdx);

                const toolId = asNonEmptyString(block.id) ?? '';
                const toolName = asNonEmptyString(block.name) ?? '';
                let initialArgs = '';
                if (isRecord(block.input) && Object.keys(block.input).length > 0) {
                    initialArgs = JSON.stringify(block.input);
                }

                this.toolCalls.set(toolIdx, {
                    id: toolId,
                    name: toolName,
                    arguments: initialArgs,
                });

                out.push({
                    type: 'tool_call_delta',
                    toolCallIndex: toolIdx,
                    ...(toolId ? { toolCallId: toolId } : {}),
                    ...(toolName ? { toolName } : {}),
                    argumentsDelta: initialArgs,
                });
            } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
                this.emitText(block.text, out);
            } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
                this.emitReasoning(block.thinking, out);
            }
            return;
        }

        if (type === 'content_block_delta') {
            const blockIndex = typeof parsed.index === 'number' ? parsed.index : 0;
            const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
            if (!delta) {
                return;
            }

            if (delta.type === 'text_delta' || (delta.type === undefined && typeof delta.text === 'string')) {
                if (typeof delta.text === 'string' && delta.text) {
                    this.emitText(delta.text, out);
                }
            } else if (
                delta.type === 'thinking_delta'
                || (delta.type === undefined && typeof delta.thinking === 'string')
            ) {
                if (typeof delta.thinking === 'string' && delta.thinking) {
                    this.emitReasoning(delta.thinking, out);
                }
            } else if (delta.type === 'input_json_delta') {
                const toolIdx = this.anthropicBlockToToolIdx.get(blockIndex) ?? blockIndex;
                const existing = this.toolCalls.get(toolIdx) ?? { id: '', name: '', arguments: '' };
                const partial = typeof delta.partial_json === 'string' ? delta.partial_json : '';
                if (partial) {
                    existing.arguments += partial;
                    this.toolCalls.set(toolIdx, existing);
                    out.push({
                        type: 'tool_call_delta',
                        toolCallIndex: toolIdx,
                        ...(existing.id ? { toolCallId: existing.id } : {}),
                        ...(existing.name ? { toolName: existing.name } : {}),
                        argumentsDelta: partial,
                    });
                }
            }
            return;
        }

        if (type === 'content_block_stop') {
            const blockIndex = typeof parsed.index === 'number' ? parsed.index : 0;
            const toolIdx = this.anthropicBlockToToolIdx.get(blockIndex);
            if (toolIdx !== undefined) {
                const call = this.toolCalls.get(toolIdx);
                if (call && call.arguments === '') {
                    call.arguments = '{}';
                    out.push({
                        type: 'tool_call_delta',
                        toolCallIndex: toolIdx,
                        ...(call.id ? { toolCallId: call.id } : {}),
                        ...(call.name ? { toolName: call.name } : {}),
                        argumentsDelta: '{}',
                    });
                }
            }
            return;
        }

        if (type === 'message_delta') {
            const delta = isRecord(parsed.delta) ? parsed.delta : undefined;
            if (typeof delta?.stop_reason === 'string' && delta.stop_reason) {
                this.finishReason = delta.stop_reason;
            }
            if (isRecord(parsed.usage)) {
                this.usage = parseAnthropicUsage(parsed.usage, this.hasUsage ? this.usage : undefined);
                this.hasUsage = true;
                out.push({ type: 'usage', usage: { ...this.usage } });
            }
            return;
        }

        if (type === 'message_stop') {
            if (this.parseThinkTags) {
                for (const part of this.thinkSplitter.flush()) {
                    this.pushTextOrReasoningPart(part, out);
                }
            }
            if (!this.doneEmitted) {
                this.doneEmitted = true;
                out.push({
                    type: 'done',
                    finishReason: this.finishReason ?? 'end_turn',
                });
            }
        }
    }

    private processGeminiEvent(parsed: Record<string, unknown>, out: LLMStreamChunk[]): void {
        const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
        const candidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;

        if (candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts)) {
            for (const part of candidate.content.parts) {
                if (!isRecord(part)) {
                    continue;
                }
                const sig =
                    asNonEmptyString(part.thoughtSignature)
                    ?? asNonEmptyString(part.thought_signature);

                if (isRecord(part.functionCall)) {
                    const toolIdx = this.toolCalls.size;
                    const name = asNonEmptyString(part.functionCall.name) ?? '';
                    const args =
                        part.functionCall.args !== undefined
                            ? JSON.stringify(part.functionCall.args)
                            : '{}';
                    const id = asNonEmptyString(part.functionCall.id) ?? `call_${toolIdx}`;
                    const call: CanonicalToolCall = {
                        id,
                        name,
                        arguments: args,
                        ...(sig ? { thoughtSignature: sig } : {}),
                    };
                    this.toolCalls.set(toolIdx, call);
                    out.push({
                        type: 'tool_call_delta',
                        toolCallIndex: toolIdx,
                        toolCallId: id,
                        toolName: name,
                        argumentsDelta: args,
                        ...(sig ? { thoughtSignature: sig } : {}),
                    });
                } else if (typeof part.text === 'string' && part.text.length > 0) {
                    if (part.thought === true) {
                        this.emitReasoning(part.text, out);
                    } else {
                        this.emitText(part.text, out);
                    }
                }
            }
        }

        const blockReason = isRecord(parsed.promptFeedback)
            ? asNonEmptyString(parsed.promptFeedback.blockReason)
            : undefined;
        if (candidate && typeof candidate.finishReason === 'string' && candidate.finishReason) {
            this.finishReason = candidate.finishReason;
        } else if (!this.finishReason && blockReason) {
            this.finishReason = blockReason;
        }

        if (isRecord(parsed.usageMetadata)) {
            this.usage = parseGeminiUsage(parsed.usageMetadata, this.hasUsage ? this.usage : undefined);
            this.hasUsage = true;
            out.push({ type: 'usage', usage: { ...this.usage } });
        }
    }
}

/**
 * Folds an iterable sequence of `LLMStreamChunk`s into a single `LLMResponse`.
 */
export function assembleStreamChunks(chunks: Iterable<LLMStreamChunk>): LLMResponse {
    let content = '';
    let reasoningContent = '';
    const toolMap = new Map<number, CanonicalToolCall>();
    let usage: TokenUsage = {
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
    };
    let finishReason: string | undefined;

    for (const chunk of chunks) {
        if (chunk.type === 'text_delta' && chunk.textDelta) {
            content += chunk.textDelta;
        } else if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
            reasoningContent += chunk.reasoningDelta;
        } else if (chunk.type === 'tool_call_delta') {
            const idx = chunk.toolCallIndex ?? 0;
            const prev = toolMap.get(idx) ?? { id: '', name: '', arguments: '' };
            if (chunk.toolCallId && !prev.id) {
                prev.id = chunk.toolCallId;
            }
            if (chunk.toolName && !prev.name) {
                prev.name = chunk.toolName;
            }
            if (chunk.argumentsDelta) {
                prev.arguments += chunk.argumentsDelta;
            }
            if (chunk.thoughtSignature) {
                prev.thoughtSignature = chunk.thoughtSignature;
            }
            toolMap.set(idx, prev);
        } else if (chunk.type === 'usage' && chunk.usage) {
            usage = { ...chunk.usage };
        } else if (chunk.type === 'done' && chunk.finishReason) {
            finishReason = chunk.finishReason;
        }
    }

    return {
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls: Array.from(toolMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call),
        usage,
        ...(finishReason !== undefined ? { finishReason } : {}),
    };
}

function foldGeminiResponseChunks(
    chunks: unknown[],
    parseThinkTags: boolean,
    raw: unknown,
): LLMResponse {
    let content = '';
    let reasoningContent = '';
    const toolCalls: CanonicalToolCall[] = [];
    let usage = buildUsage(0, 0, 0, 0);
    let hasUsage = false;
    let finishReason: string | undefined;
    const splitter = parseThinkTags ? new ThinkTagSplitter() : null;
    const serializedRaw = JSON.stringify(raw);

    for (const chunk of chunks) {
        if (!isRecord(chunk)) {
            continue;
        }

        const errorMsg = extractStreamErrorMessage(chunk);
        if (errorMsg) {
            throw createStreamErrorFromPayload(chunk, errorMsg, { responseBody: serializedRaw });
        }

        const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
        const firstCandidate = candidates.length > 0 && isRecord(candidates[0]) ? candidates[0] : undefined;

        if (firstCandidate && isRecord(firstCandidate.content) && Array.isArray(firstCandidate.content.parts)) {
            for (const part of firstCandidate.content.parts) {
                if (!isRecord(part)) {
                    continue;
                }
                const sig =
                    asNonEmptyString(part.thoughtSignature)
                    ?? asNonEmptyString(part.thought_signature);
                if (isRecord(part.functionCall)) {
                    toolCalls.push({
                        id: asNonEmptyString(part.functionCall.id) ?? `call_${toolCalls.length}`,
                        name: asNonEmptyString(part.functionCall.name) ?? '',
                        arguments:
                            part.functionCall.args !== undefined
                                ? JSON.stringify(part.functionCall.args)
                                : '{}',
                        ...(sig ? { thoughtSignature: sig } : {}),
                    });
                } else if (typeof part.text === 'string' && part.text.length > 0) {
                    if (part.thought === true) {
                        reasoningContent += part.text;
                    } else if (splitter) {
                        for (const seg of splitter.feed(part.text)) {
                            if (seg.kind === 'reasoning') {
                                reasoningContent += seg.value;
                            } else {
                                content += seg.value;
                            }
                        }
                    } else {
                        content += part.text;
                    }
                }
            }
        }

        const candidateReason = asNonEmptyString(firstCandidate?.finishReason);
        const blockReason = isRecord(chunk.promptFeedback)
            ? asNonEmptyString(chunk.promptFeedback.blockReason)
            : undefined;
        if (candidateReason) {
            finishReason = candidateReason;
        } else if (!finishReason && blockReason) {
            finishReason = blockReason;
        }

        if (isRecord(chunk.usageMetadata)) {
            usage = parseGeminiUsage(chunk.usageMetadata, hasUsage ? usage : undefined);
            hasUsage = true;
        }
    }

    if (splitter) {
        for (const seg of splitter.flush()) {
            if (seg.kind === 'reasoning') {
                reasoningContent += seg.value;
            } else {
                content += seg.value;
            }
        }
    }

    return {
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls,
        usage,
        ...(finishReason !== undefined ? { finishReason } : {}),
        raw,
    };
}

/**
 * Parses a non-streaming JSON response from OpenAI, Anthropic, or Gemini into `LLMResponse`.
 */
export function parseCompletionResponse(
    data: unknown,
    providerFormat?: ApiProviderFormat,
    options: { parseThinkTags?: boolean } = {},
): LLMResponse {
    const parseThinkTags = options.parseThinkTags ?? true;

    if (Array.isArray(data)) {
        const looksLikeGeminiArray =
            providerFormat === 'gemini'
            || data.some(
                (item) =>
                    isRecord(item)
                    && (Array.isArray(item.candidates)
                        || isRecord(item.usageMetadata)
                        || isRecord(item.promptFeedback)
                        || extractStreamErrorMessage(item) !== null),
            );
        if (looksLikeGeminiArray) {
            return foldGeminiResponseChunks(data, parseThinkTags, data);
        }
        return {
            content: '',
            toolCalls: [],
            usage: buildUsage(0, 0, 0, 0),
            raw: data,
        };
    }

    if (!isRecord(data)) {
        return {
            content: typeof data === 'string' ? data : '',
            toolCalls: [],
            usage: buildUsage(0, 0, 0, 0),
            raw: data,
        };
    }

    const errorMsg = extractStreamErrorMessage(data);
    if (errorMsg) {
        throw createStreamErrorFromPayload(data, errorMsg, { responseBody: JSON.stringify(data) });
    }

    // Anthropic non-streaming Messages response: { type: 'message', content: [...], usage: {...} }
    if (
        (providerFormat === 'anthropic' || data.type === 'message')
        && Array.isArray(data.content)
    ) {
        let content = '';
        let reasoningContent = '';
        const toolCalls: CanonicalToolCall[] = [];

        for (const block of data.content) {
            if (!isRecord(block)) {
                continue;
            }
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
                reasoningContent += block.thinking;
            } else if (block.type === 'text' && typeof block.text === 'string') {
                if (parseThinkTags) {
                    const split = splitThinkTagsStatic(block.text);
                    content += split.content;
                    reasoningContent += split.reasoning;
                } else {
                    content += block.text;
                }
            } else if (block.type === 'tool_use') {
                toolCalls.push({
                    id: asNonEmptyString(block.id) ?? `toolu_${toolCalls.length}`,
                    name: asNonEmptyString(block.name) ?? '',
                    arguments: isRecord(block.input) ? JSON.stringify(block.input) : '{}',
                });
            }
        }

        const usage = isRecord(data.usage) ? parseAnthropicUsage(data.usage) : buildUsage(0, 0, 0, 0);
        const finishReason = asNonEmptyString(data.stop_reason);

        return {
            content,
            ...(reasoningContent ? { reasoningContent } : {}),
            toolCalls,
            usage,
            ...(finishReason !== undefined ? { finishReason } : {}),
            raw: data,
        };
    }

    // Gemini non-streaming response
    if (
        Array.isArray(data.candidates)
        || isRecord(data.usageMetadata)
        || isRecord(data.promptFeedback)
        || (providerFormat === 'gemini' && !Array.isArray(data.choices) && !Array.isArray(data.content))
    ) {
        return foldGeminiResponseChunks([data], parseThinkTags, data);
    }

    // OpenAI Chat Completions non-streaming response
    const choices = Array.isArray(data.choices) ? data.choices : [];
    const firstChoice = choices.length > 0 && isRecord(choices[0]) ? choices[0] : undefined;
    const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : undefined;

    const rawText =
        typeof message?.content === 'string'
            ? message.content
            : typeof firstChoice?.text === 'string'
                ? firstChoice.text
                : '';

    let content = rawText;
    let reasoningContent =
        asNonEmptyString(message?.reasoning_content)
        ?? asNonEmptyString(message?.reasoning)
        ?? '';

    if (parseThinkTags && rawText.includes(THINK_OPEN)) {
        const split = splitThinkTagsStatic(rawText);
        content = split.content;
        if (split.reasoning) {
            reasoningContent = reasoningContent ? `${reasoningContent}\n${split.reasoning}` : split.reasoning;
        }
    }

    const toolSignaturesById = new Map<string, string>();
    if (Array.isArray(message?.reasoning_details)) {
        for (const detail of message.reasoning_details) {
            if (
                isRecord(detail)
                && detail.type === 'reasoning.encrypted'
                && typeof detail.id === 'string'
                && typeof detail.data === 'string'
                && detail.data
            ) {
                toolSignaturesById.set(detail.id, detail.data);
            }
        }
    }

    const toolCalls: CanonicalToolCall[] = [];
    if (Array.isArray(message?.tool_calls)) {
        for (const rawTc of message.tool_calls) {
            if (!isRecord(rawTc)) {
                continue;
            }
            const fn = isRecord(rawTc.function) ? rawTc.function : undefined;
            const id = asNonEmptyString(rawTc.id) ?? `call_${toolCalls.length}`;
            const name = asNonEmptyString(fn?.name) ?? asNonEmptyString(rawTc.name) ?? '';
            const args =
                typeof fn?.arguments === 'string'
                    ? fn.arguments
                    : typeof rawTc.arguments === 'string'
                        ? rawTc.arguments
                        : '{}';
            const sig = extractThoughtSignatureFromToolDelta(rawTc) ?? toolSignaturesById.get(id);

            toolCalls.push({
                id,
                name,
                arguments: args,
                ...(sig ? { thoughtSignature: sig } : {}),
            });
        }
    }

    const usage = isRecord(data.usage) ? parseOpenAIUsage(data.usage) : buildUsage(0, 0, 0, 0);
    const finishReason = asNonEmptyString(firstChoice?.finish_reason);

    return {
        content,
        ...(reasoningContent ? { reasoningContent } : {}),
        toolCalls,
        usage,
        ...(finishReason !== undefined ? { finishReason } : {}),
        raw: data,
    };
}

function readNextWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (!signal) {
        return reader.read();
    }
    if (signal.aborted) {
        return Promise.reject(createAbortError(signal, 'SSE stream aborted'));
    }

    return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        let settled = false;

        const onAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            reader.cancel().catch(() => {});
            reject(createAbortError(signal, 'SSE stream aborted'));
        };

        signal.addEventListener('abort', onAbort, { once: true });

        reader.read().then(
            (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(result);
            },
            (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted && !isAbortError(err)) {
                    reject(createAbortError(signal, 'SSE stream aborted'));
                } else {
                    reject(err);
                }
            },
        );
    });
}

/**
 * Streams `LLMStreamChunk`s incrementally from a Fetch `ReadableStream<Uint8Array>`
 * with immediate `AbortSignal` interruption.
 */
export async function* parseSSEStream(
    body: ReadableStream<Uint8Array>,
    options: SSEParserOptions & { signal?: AbortSignal } = {},
): AsyncIterable<LLMStreamChunk> {
    const { signal, ...parserOptions } = options;
    if (signal?.aborted) {
        throw createAbortError(signal, 'SSE stream aborted');
    }

    const parser = new SSEParser(parserOptions);
    const reader = body.getReader();
    let streamCompleted = false;

    try {
        while (true) {
            if (signal?.aborted) {
                throw createAbortError(signal, 'SSE stream aborted');
            }

            let readResult: ReadableStreamReadResult<Uint8Array>;
            try {
                readResult = await readNextWithAbort(reader, signal);
            } catch (err) {
                if (signal?.aborted || isAbortError(err)) {
                    throw createAbortError(signal, 'SSE stream aborted');
                }
                if (err instanceof LLMTransportError) {
                    throw err;
                }
                const message = err instanceof Error ? err.message : String(err);
                throw new LLMTransportError(`SSE stream read failed: ${message}`, {
                    retryable: true,
                    code: 'STREAM_READ_ERROR',
                    cause: err,
                });
            }
            const { done, value } = readResult;
            if (done) {
                streamCompleted = true;
                break;
            }

            if (value && value.byteLength > 0) {
                const chunks = parser.feed(value);
                for (const chunk of chunks) {
                    yield chunk;
                }
            }
        }

        for (const chunk of parser.flush()) {
            yield chunk;
        }
    } finally {
        if (!streamCompleted) {
            try {
                await reader.cancel();
            } catch {
                // Stream may already be closed or errored.
            }
        }
        try {
            reader.releaseLock();
        } catch {
            // Lock already released.
        }
    }
}
