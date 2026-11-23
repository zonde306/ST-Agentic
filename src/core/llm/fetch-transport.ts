import type {
    ListModelsRequest,
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMTransport,
    RemoteModelInfo,
} from '../bridge';
import type { ApiConnection } from '../types';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { createAbortError, isAbortError, isRetryableStatus, LLMTransportError, throwIfAborted } from './errors';
import { type CompiledModelsRequest, type CompiledPayload, PayloadCompiler } from './payload-compiler';
import { type RetryOptions, defaultShouldRetry, delayWithAbort, withRetry } from './retry';
import { assembleStreamChunks, parseCompletionResponse, parseSSEStream } from './sse-parser';

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ConnectionResolver = (
    connectionId: string,
) => ApiConnection | undefined | Promise<ApiConnection | undefined>;

export interface FetchLLMTransportOptions {
    /** Custom fetch implementation (defaults to `globalThis.fetch`). */
    fetchImpl?: FetchImpl;
    /** Dynamic lookup function for `request.connectionId` when `request.connection` is omitted. */
    resolveConnection?: ConnectionResolver;
    /** Static connection map fallback when `resolveConnection` is not provided. */
    connections?: Record<string, ApiConnection>;
    /** Custom PayloadCompiler instance. */
    payloadCompiler?: PayloadCompiler;
    /** Exponential backoff retry config for connection/5xx/429 failures, or `false` to disable. */
    retry?: Omit<RetryOptions, 'signal'> | false;
    /** Enforce per-connection `maxConcurrency` semaphore (default: true). */
    useConcurrencyLimiter?: boolean;
    /** Parse inline `<think>...</think>` blocks into `reasoning_delta` / `reasoningContent` (default: true). */
    parseThinkTags?: boolean;
    /** Optional diagnostic callback invoked with each compiled HTTP payload. */
    onCompiledPayload?: (compiled: CompiledPayload, request: LLMRequest) => void;
}

const DEFAULT_RETRY_OPTIONS: Omit<RetryOptions, 'signal'> = {
    maxAttempts: 3,
    initialDelayMs: 600,
    maxDelayMs: 12_000,
    backoffFactor: 2,
    jitterRatio: 0.2,
};

function computeStreamBackoffDelay(
    error: unknown,
    attempt: number,
    config: Omit<RetryOptions, 'signal'>,
): number {
    const initialDelayMs = Math.max(0, config.initialDelayMs ?? 600);
    const maxDelayMs = Math.max(initialDelayMs, config.maxDelayMs ?? 12_000);
    const backoffFactor = Math.max(1, config.backoffFactor ?? 2);
    const jitterRatio = config.jitterRatio ?? 0;

    const expDelay = initialDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1));
    let delay = Math.min(maxDelayMs, Math.max(0, expDelay));

    if (
        error instanceof LLMTransportError
        && typeof error.retryAfterMs === 'number'
        && Number.isFinite(error.retryAfterMs)
    ) {
        delay = Math.min(maxDelayMs, Math.max(delay, error.retryAfterMs));
    }

    if (jitterRatio > 0 && delay > 0) {
        const clampedJitter = Math.min(1, Math.max(0, jitterRatio));
        const factor = 1 - clampedJitter + Math.random() * clampedJitter;
        delay = Math.round(delay * factor);
    }

    return delay;
}

function parseRetryAfterMs(headerValue: string | null): number | undefined {
    if (!headerValue) {
        return undefined;
    }
    const trimmed = headerValue.trim();
    if (!trimmed) {
        return undefined;
    }
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.round(seconds * 1000);
    }
    const dateMs = Date.parse(trimmed);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, dateMs - Date.now());
    }
    return undefined;
}

export interface ParsedModelsPage {
    models: RemoteModelInfo[];
    hasMore: boolean;
    lastId?: string;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (trimmed) {
                return trimmed;
            }
        }
    }
    return undefined;
}

function firstPositiveInt(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            const floored = Math.floor(value);
            if (floored > 0) {
                return floored;
            }
        }
    }
    return undefined;
}

function extractErrorMessageFromRecord(parsed: Record<string, unknown>): string | undefined {
    const err = parsed.error ?? (parsed.detail as Record<string, unknown> | undefined)?.error;
    if (typeof err === 'string' && err) {
        return err;
    }
    if (err && typeof err === 'object') {
        const errObj = err as Record<string, unknown>;
        if (typeof errObj.message === 'string' && errObj.message) {
            return errObj.message;
        }
        if (typeof errObj.code === 'string' && errObj.code) {
            return errObj.code;
        }
        if (typeof errObj.type === 'string' && errObj.type) {
            return errObj.type;
        }
    }
    if (typeof parsed.detail === 'string' && parsed.detail) {
        return parsed.detail;
    }
    if (typeof parsed.message === 'string' && parsed.message) {
        return parsed.message;
    }
    return undefined;
}

function parseModelEntry(entry: unknown): RemoteModelInfo | null {
    if (typeof entry === 'string') {
        const id = entry.trim();
        return id ? { id } : null;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
    }

    const obj = entry as Record<string, unknown>;
    const rawId = firstNonEmptyString(obj.id);
    const rawName = firstNonEmptyString(obj.name);
    const rawModel = firstNonEmptyString(obj.model);

    let id = rawId;
    if (!id && rawName) {
        id = rawName.startsWith('models/') ? rawName.slice('models/'.length).trim() : rawName;
    }
    if (!id && rawModel) {
        id = rawModel;
    }
    if (!id) {
        return null;
    }

    const explicitDisplay = firstNonEmptyString(obj.display_name, obj.displayName);
    const candidateDisplay = explicitDisplay ?? (rawName && rawName !== id ? rawName : undefined);
    const displayName = candidateDisplay && candidateDisplay !== id ? candidateDisplay : undefined;
    const ownedBy = firstNonEmptyString(obj.owned_by, obj.ownedBy, obj.provider);
    const contextLength = firstPositiveInt(
        obj.context_length,
        obj.contextLength,
        obj.input_token_limit,
        obj.max_context_length,
    );

    return {
        id,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(ownedBy !== undefined ? { ownedBy } : {}),
        ...(contextLength !== undefined ? { contextLength } : {}),
    };
}

/**
 * Parses model discovery payloads across OpenAI (`data`), Anthropic (`data` + `has_more`/`last_id`),
 * Google/Gemini (`models`), and bare array responses.
 */
export function parseModelsResponse(rawJson: unknown): ParsedModelsPage {
    let rawList: unknown[] | null = null;
    let hasMore = false;
    let lastId: string | undefined;

    if (Array.isArray(rawJson)) {
        rawList = rawJson;
    } else if (rawJson && typeof rawJson === 'object') {
        const record = rawJson as Record<string, unknown>;
        if (Array.isArray(record.data)) {
            rawList = record.data;
            hasMore = record.has_more === true;
            lastId = firstNonEmptyString(record.last_id);
        } else if (Array.isArray(record.models)) {
            rawList = record.models;
        } else {
            const inlineError = extractErrorMessageFromRecord(record);
            if (inlineError) {
                throw new LLMTransportError(inlineError, { retryable: false });
            }
        }
    }

    if (!rawList) {
        throw new LLMTransportError('Models response did not contain a valid model list', {
            retryable: false,
        });
    }

    const models: RemoteModelInfo[] = [];
    for (const item of rawList) {
        const parsed = parseModelEntry(item);
        if (parsed) {
            models.push(parsed);
        }
    }

    return { models, hasMore, lastId };
}

function extractHttpErrorMessage(rawText: string, status: number, statusText: string): string {
    const fallback = `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
    if (!rawText) {
        return fallback;
    }
    try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') {
            return rawText.trim() || fallback;
        }
        const extracted = extractErrorMessageFromRecord(parsed);
        if (extracted) {
            return extracted;
        }
    } catch {
        // Not JSON; fall back to plain text body if concise.
    }
    const trimmed = rawText.trim();
    return trimmed ? trimmed.slice(0, 500) : fallback;
}

function fetchWithAbortRace(
    fetchImpl: FetchImpl,
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
): Promise<Response> {
    if (signal?.aborted) {
        return Promise.reject(createAbortError(signal, 'LLM request aborted'));
    }

    const fetchPromise = Promise.resolve().then(() => fetchImpl(url, init));
    if (!signal) {
        return fetchPromise;
    }

    // Prevent unhandled rejection if mock fetch rejects after abort race resolved/rejected.
    fetchPromise.catch(() => {});

    return new Promise<Response>((resolve, reject) => {
        let settled = false;

        const onAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            reject(createAbortError(signal, 'LLM request aborted'));
        };

        signal.addEventListener('abort', onAbort, { once: true });

        fetchPromise.then(
            (res) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(res);
            },
            (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted && !isAbortError(err)) {
                    reject(createAbortError(signal, 'LLM request aborted'));
                } else {
                    reject(err);
                }
            },
        );
    });
}

function readTextWithAbort(response: Response, signal?: AbortSignal): Promise<string> {
    if (!signal) {
        return response.text();
    }
    if (signal.aborted) {
        return Promise.reject(createAbortError(signal, 'LLM response read aborted'));
    }

    const textPromise = response.text();
    textPromise.catch(() => {});

    return new Promise<string>((resolve, reject) => {
        let settled = false;

        const onAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            reject(createAbortError(signal, 'LLM response read aborted'));
        };

        signal.addEventListener('abort', onAbort, { once: true });

        textPromise.then(
            (text) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(text);
            },
            (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                signal.removeEventListener('abort', onAbort);
                reject(err);
            },
        );
    });
}

/**
 * Real HTTP/SSE implementation of `LLMTransport` using injectable `fetchImpl`,
 * `PayloadCompiler`, `SSEParser`, per-connection `ConcurrencyLimiter`, and `withRetry`.
 */
export class FetchLLMTransport implements LLMTransport {
    private readonly fetchImpl: FetchImpl;
    private readonly resolveConnectionFn?: ConnectionResolver;
    private connections: Record<string, ApiConnection>;
    private readonly payloadCompiler: PayloadCompiler;
    private readonly retryConfig: Omit<RetryOptions, 'signal'> | false;
    private readonly useConcurrencyLimiter: boolean;
    private readonly parseThinkTags: boolean;
    private readonly onCompiledPayload?: (compiled: CompiledPayload, request: LLMRequest) => void;
    private readonly limiters = new Map<string, ConcurrencyLimiter>();

    constructor(options: FetchLLMTransportOptions = {}) {
        const defaultFetch =
            typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined;
        const resolvedFetch = options.fetchImpl ?? defaultFetch;
        if (!resolvedFetch) {
            throw new LLMTransportError('No fetch implementation available', { retryable: false });
        }

        this.fetchImpl = resolvedFetch;
        this.resolveConnectionFn = options.resolveConnection;
        this.connections = options.connections ? { ...options.connections } : {};
        this.payloadCompiler = options.payloadCompiler ?? new PayloadCompiler();
        this.retryConfig =
            options.retry === false
                ? false
                : { ...DEFAULT_RETRY_OPTIONS, ...(options.retry ?? {}) };
        this.useConcurrencyLimiter = options.useConcurrencyLimiter ?? true;
        this.parseThinkTags = options.parseThinkTags ?? true;
        this.onCompiledPayload = options.onCompiledPayload;
    }

    setConnections(connections: Record<string, ApiConnection>): void {
        this.connections = { ...connections };
    }

    getLimiter(connectionId: string): ConcurrencyLimiter | undefined {
        return this.limiters.get(connectionId);
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        throwIfAborted(request.signal, 'LLM request aborted');

        const connection = await this.getConnection(request);
        const compiled = this.payloadCompiler.compile(
            { ...request, stream: request.stream ?? false },
            connection,
        );
        this.onCompiledPayload?.(compiled, request);

        const executeRequest = () =>
            this.executeWithRetry(() => this.performCompleteFetch(compiled, request.signal), request.signal);

        if (!this.useConcurrencyLimiter) {
            return executeRequest();
        }

        const limiter = this.ensureLimiter(connection);
        return limiter.run(() => executeRequest(), request.signal);
    }

    async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
        throwIfAborted(request.signal, 'LLM stream request aborted');

        const connection = await this.getConnection(request);
        const compiled = this.payloadCompiler.compile(
            { ...request, stream: true },
            connection,
        );
        this.onCompiledPayload?.(compiled, request);

        const retryCfg = this.retryConfig;
        const maxAttempts =
            retryCfg === false ? 1 : Math.max(1, Math.floor(retryCfg.maxAttempts ?? 3));
        const shouldRetry =
            retryCfg === false ? (() => false) : (retryCfg.shouldRetry ?? defaultShouldRetry);

        let release: (() => void) | undefined;
        if (this.useConcurrencyLimiter) {
            const limiter = this.ensureLimiter(connection);
            release = await limiter.acquire(request.signal);
        }

        let hasYieldedObservableChunk = false;

        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                throwIfAborted(request.signal, 'LLM stream request aborted');

                try {
                    const response = await this.performFetch(compiled, request.signal);
                    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
                    if (
                        contentType.includes('application/json')
                        && !contentType.includes('text/event-stream')
                    ) {
                        const text = await readTextWithAbort(response, request.signal);
                        const parsedJson = this.parseJsonOrThrow(text);
                        const result = parseCompletionResponse(parsedJson, compiled.providerFormat, {
                            parseThinkTags: this.parseThinkTags,
                        });
                        for (const chunk of this.responseToChunks(result)) {
                            if (
                                chunk.type === 'text_delta'
                                || chunk.type === 'reasoning_delta'
                                || chunk.type === 'tool_call_delta'
                            ) {
                                hasYieldedObservableChunk = true;
                            }
                            yield chunk;
                        }
                        return;
                    }

                    if (!response.body) {
                        throw new LLMTransportError('Streaming response body is empty', {
                            status: response.status,
                            retryable: false,
                        });
                    }

                    for await (const chunk of parseSSEStream(response.body, {
                        providerFormat: compiled.providerFormat,
                        parseThinkTags: this.parseThinkTags,
                        signal: request.signal,
                    })) {
                        if (
                            chunk.type === 'text_delta'
                            || chunk.type === 'reasoning_delta'
                            || chunk.type === 'tool_call_delta'
                        ) {
                            hasYieldedObservableChunk = true;
                        }
                        yield chunk;
                    }
                    return;
                } catch (error) {
                    if (request.signal?.aborted || isAbortError(error)) {
                        throw createAbortError(request.signal, 'LLM stream request aborted');
                    }
                    if (
                        hasYieldedObservableChunk
                        || retryCfg === false
                        || attempt >= maxAttempts
                        || !shouldRetry(error, attempt)
                    ) {
                        throw error;
                    }

                    const delayMs = computeStreamBackoffDelay(error, attempt, retryCfg);
                    retryCfg.onRetry?.(error, attempt, delayMs);
                    if (delayMs > 0) {
                        await delayWithAbort(delayMs, request.signal);
                    }
                }
            }
        } finally {
            release?.();
        }
    }

    async listModels(request: ListModelsRequest = {}): Promise<RemoteModelInfo[]> {
        throwIfAborted(request.signal, 'List models request aborted');

        const connection = await this.getConnection(request);
        const compiled = this.payloadCompiler.compileModelsRequest(connection);

        let page = await this.performModelsFetch(compiled, compiled.url, request.signal);
        const allModels: RemoteModelInfo[] = [...page.models];
        const seenCursors = new Set<string>();
        let pageCount = 1;

        while (
            compiled.providerFormat === 'anthropic'
            && page.hasMore
            && page.lastId
            && !seenCursors.has(page.lastId)
            && pageCount < 5
        ) {
            seenCursors.add(page.lastId);
            const separator = compiled.url.includes('?') ? '&' : '?';
            const nextUrl = `${compiled.url}${separator}after_id=${encodeURIComponent(page.lastId)}`;
            page = await this.performModelsFetch(compiled, nextUrl, request.signal);
            allModels.push(...page.models);
            pageCount += 1;
        }

        const deduped = new Map<string, RemoteModelInfo>();
        for (const model of allModels) {
            const existing = deduped.get(model.id);
            if (!existing) {
                deduped.set(model.id, { ...model });
            } else {
                if (!existing.displayName && model.displayName) {
                    existing.displayName = model.displayName;
                }
                if (!existing.ownedBy && model.ownedBy) {
                    existing.ownedBy = model.ownedBy;
                }
                if (existing.contextLength === undefined && model.contextLength !== undefined) {
                    existing.contextLength = model.contextLength;
                }
            }
        }

        return Array.from(deduped.values()).sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }),
        );
    }

    private async getConnection(request: {
        connectionId?: string;
        connection?: ApiConnection;
    }): Promise<ApiConnection> {
        const resolved =
            request.connection
            ?? (request.connectionId !== undefined
                ? (await this.resolveConnectionFn?.(request.connectionId))
                  ?? this.connections[request.connectionId]
                : undefined);

        if (!resolved) {
            throw new LLMTransportError(
                `API connection not found: "${request.connectionId ?? ''}"`,
                { retryable: false },
            );
        }
        return resolved;
    }

    private ensureLimiter(connection: ApiConnection): ConcurrencyLimiter {
        const key = connection.id || connection.name || 'default';
        const existing = this.limiters.get(key);
        if (existing) {
            existing.setMaxConcurrency(connection.maxConcurrency);
            return existing;
        }
        const created = new ConcurrencyLimiter(connection.maxConcurrency);
        this.limiters.set(key, created);
        return created;
    }

    private executeWithRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        if (this.retryConfig === false) {
            return fn();
        }
        return withRetry(() => fn(), {
            ...this.retryConfig,
            signal,
        });
    }

    private async executeHttpFetch(
        url: string,
        init: RequestInit,
        signal: AbortSignal | undefined,
        options: { retryableNetwork: boolean; retryableStatus: boolean; abortMessage: string },
    ): Promise<Response> {
        throwIfAborted(signal, options.abortMessage);

        let response: Response;
        try {
            response = await fetchWithAbortRace(this.fetchImpl, url, init, signal);
        } catch (err) {
            if (signal?.aborted || isAbortError(err)) {
                throw createAbortError(signal, options.abortMessage);
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new LLMTransportError(`Network request failed: ${message}`, {
                retryable: options.retryableNetwork,
                cause: err,
            });
        }

        if (!response.ok) {
            let rawText = '';
            try {
                rawText = await readTextWithAbort(response, signal);
            } catch (readErr) {
                if (signal?.aborted || isAbortError(readErr)) {
                    throw createAbortError(signal, options.abortMessage);
                }
            }
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            const message = extractHttpErrorMessage(rawText, response.status, response.statusText);
            throw new LLMTransportError(message, {
                status: response.status,
                retryable: options.retryableStatus ? isRetryableStatus(response.status) : false,
                retryAfterMs,
                responseBody: rawText,
            });
        }

        return response;
    }

    private performFetch(compiled: CompiledPayload, signal?: AbortSignal): Promise<Response> {
        return this.executeHttpFetch(
            compiled.url,
            {
                method: compiled.method,
                headers: compiled.headers,
                body: compiled.serializedBody,
                signal,
            },
            signal,
            {
                retryableNetwork: true,
                retryableStatus: true,
                abortMessage: 'LLM request aborted',
            },
        );
    }

    private async performModelsFetch(
        compiled: CompiledModelsRequest,
        url: string,
        signal?: AbortSignal,
    ): Promise<ParsedModelsPage> {
        const response = await this.executeHttpFetch(
            url,
            {
                method: compiled.method,
                headers: compiled.headers,
                signal,
            },
            signal,
            {
                retryableNetwork: false,
                retryableStatus: false,
                abortMessage: 'List models request aborted',
            },
        );
        const rawText = await readTextWithAbort(response, signal);
        const parsedJson = this.parseJsonOrThrow(rawText);
        return parseModelsResponse(parsedJson);
    }

    private async performCompleteFetch(compiled: CompiledPayload, signal?: AbortSignal): Promise<LLMResponse> {
        const response = await this.performFetch(compiled, signal);
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

        if (contentType.includes('text/event-stream') && response.body) {
            const chunks: LLMStreamChunk[] = [];
            for await (const chunk of parseSSEStream(response.body, {
                providerFormat: compiled.providerFormat,
                parseThinkTags: this.parseThinkTags,
                signal,
            })) {
                chunks.push(chunk);
            }
            return assembleStreamChunks(chunks);
        }

        const rawText = await readTextWithAbort(response, signal);
        const parsedJson = this.parseJsonOrThrow(rawText);
        return parseCompletionResponse(parsedJson, compiled.providerFormat, {
            parseThinkTags: this.parseThinkTags,
        });
    }

    private parseJsonOrThrow(rawText: string): unknown {
        try {
            return JSON.parse(rawText);
        } catch (err) {
            throw new LLMTransportError('Failed to parse LLM JSON response', {
                retryable: false,
                responseBody: rawText,
                cause: err,
            });
        }
    }

    private *responseToChunks(result: LLMResponse): Iterable<LLMStreamChunk> {
        if (result.reasoningContent) {
            yield { type: 'reasoning_delta', reasoningDelta: result.reasoningContent };
        }
        if (result.content) {
            yield { type: 'text_delta', textDelta: result.content };
        }
        for (let i = 0; i < result.toolCalls.length; i += 1) {
            const tc = result.toolCalls[i];
            yield {
                type: 'tool_call_delta',
                toolCallIndex: i,
                toolCallId: tc.id,
                toolName: tc.name,
                argumentsDelta: tc.arguments,
                ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            };
        }
        yield { type: 'usage', usage: result.usage };
        yield {
            type: 'done',
            ...(result.finishReason !== undefined ? { finishReason: result.finishReason } : {}),
        };
    }
}
