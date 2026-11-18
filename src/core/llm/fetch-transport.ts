import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMTransport } from '../bridge';
import type { ApiConnection } from '../types';
import { ConcurrencyLimiter } from './concurrency-limiter';
import { createAbortError, isAbortError, isRetryableStatus, LLMTransportError, throwIfAborted } from './errors';
import { type CompiledPayload, PayloadCompiler } from './payload-compiler';
import { type RetryOptions, withRetry } from './retry';
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
    initialDelayMs: 300,
    maxDelayMs: 10_000,
    backoffFactor: 2,
};

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

        let release: (() => void) | undefined;
        if (this.useConcurrencyLimiter) {
            const limiter = this.ensureLimiter(connection);
            release = await limiter.acquire(request.signal);
        }

        try {
            const response = await this.executeWithRetry(
                () => this.performFetch(compiled, request.signal),
                request.signal,
            );

            const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
            if (contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
                const text = await readTextWithAbort(response, request.signal);
                const parsedJson = this.parseJsonOrThrow(text);
                const result = parseCompletionResponse(parsedJson, compiled.providerFormat, {
                    parseThinkTags: this.parseThinkTags,
                });
                yield* this.responseToChunks(result);
                return;
            }

            if (!response.body) {
                throw new LLMTransportError('Streaming response body is empty', {
                    status: response.status,
                    retryable: false,
                });
            }

            yield* parseSSEStream(response.body, {
                providerFormat: compiled.providerFormat,
                parseThinkTags: this.parseThinkTags,
                signal: request.signal,
            });
        } finally {
            release?.();
        }
    }

    private async getConnection(request: LLMRequest): Promise<ApiConnection> {
        const resolved =
            request.connection
            ?? (await this.resolveConnectionFn?.(request.connectionId))
            ?? this.connections[request.connectionId];

        if (!resolved) {
            throw new LLMTransportError(
                `API connection not found: "${request.connectionId}"`,
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

    private async performFetch(compiled: CompiledPayload, signal?: AbortSignal): Promise<Response> {
        throwIfAborted(signal, 'LLM request aborted');

        let response: Response;
        try {
            response = await fetchWithAbortRace(
                this.fetchImpl,
                compiled.url,
                {
                    method: compiled.method,
                    headers: compiled.headers,
                    body: compiled.serializedBody,
                    signal,
                },
                signal,
            );
        } catch (err) {
            if (signal?.aborted || isAbortError(err)) {
                throw createAbortError(signal, 'LLM request aborted');
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new LLMTransportError(`Network request failed: ${message}`, {
                retryable: true,
                cause: err,
            });
        }

        if (!response.ok) {
            let rawText = '';
            try {
                rawText = await readTextWithAbort(response, signal);
            } catch (readErr) {
                if (signal?.aborted || isAbortError(readErr)) {
                    throw createAbortError(signal, 'LLM request aborted');
                }
            }
            const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
            const message = extractHttpErrorMessage(rawText, response.status, response.statusText);
            throw new LLMTransportError(message, {
                status: response.status,
                retryable: isRetryableStatus(response.status),
                retryAfterMs,
                responseBody: rawText,
            });
        }

        return response;
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
