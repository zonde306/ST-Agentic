import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** OpenAI-compatible token usage payload including prompt cache metrics. */
export interface MockUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens: number;
    };
}

/** Incremental tool call delta shape emitted in OpenAI SSE chunks. */
export interface MockToolCallDelta {
    index: number;
    id?: string;
    type?: 'function';
    function?: {
        name?: string;
        arguments?: string;
    };
}

/** Non-streaming OpenAI assistant tool call object. */
export interface MockNonStreamToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

/** Single scripted SSE chunk or control gate in a mock response sequence. */
export interface MockSseChunk {
    content?: string;
    reasoningContent?: string;
    toolCalls?: MockToolCallDelta[];
    finishReason?: 'stop' | 'tool_calls' | 'length' | null;
    /** Optional delay before emitting this chunk (cancelled immediately on abort). */
    delayMs?: number;
    /** Optional gate waiter paused before emitting this chunk (cancelled immediately on abort). */
    waitGate?: () => Promise<void>;
}

/** Scripted completion scenario for either SSE streaming or JSON non-stream mode. */
export interface MockScenario {
    id?: string;
    model?: string;
    status?: number;
    errorBody?: unknown;
    chunks?: MockSseChunk[];
    nonStreamContent?: string;
    nonStreamReasoning?: string;
    nonStreamToolCalls?: MockNonStreamToolCall[];
    finishReason?: 'stop' | 'tool_calls' | 'length';
    usage?: MockUsage;
    /** Keep SSE connection open after scripted chunks until the client aborts. */
    keepOpenUntilAborted?: boolean;
    /** Optional gate waiter paused before returning a non-stream JSON response. */
    waitGate?: () => Promise<void>;
}

/** Reusable asynchronous gate for deterministically holding/releasing in-flight streams. */
export interface MockGate {
    promise: Promise<void>;
    release: () => void;
}

/** Create a one-shot async gate that resolves when `release()` is called. */
export function createMockGate(): MockGate {
    let releaseFn: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
        releaseFn = resolve;
    });
    return {
        promise,
        release: releaseFn,
    };
}

/** Recorded HTTP request observed by `MockOpenAISseServer`. */
export interface RecordedLlmRequest {
    id: number;
    method: string;
    path: string;
    origin: 'browser' | 'server';
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown>;
    stream: boolean;
    aborted: boolean;
    startedAt: number;
    endedAt?: number;
    waitForAbort: () => Promise<void>;
}

interface InternalRecordedRequest extends RecordedLlmRequest {
    markAborted: () => void;
    markEnded: () => void;
}

interface MatcherRule {
    predicate: (req: RecordedLlmRequest) => boolean;
    handler: MockScenario | ((req: RecordedLlmRequest) => MockScenario | Promise<MockScenario>);
    once: boolean;
}

const CORS_HEADERS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
};

const DEFAULT_USAGE: MockUsage = {
    prompt_tokens: 120,
    completion_tokens: 16,
    total_tokens: 136,
    prompt_tokens_details: {
        cached_tokens: 64,
    },
};

const DEFAULT_SCENARIO: MockScenario = {
    nonStreamContent: 'OK',
    chunks: [{ content: 'Mock assistant response.' }],
    finishReason: 'stop',
    usage: DEFAULT_USAGE,
};

function setCorsHeaders(res: ServerResponse): void {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        res.setHeader(key, value);
    }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
    setCorsHeaders(res);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Fallback to empty object if caller sent malformed JSON.
    }
    return {};
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
    if (ms <= 0) {
        return !signal.aborted;
    }
    if (signal.aborted) {
        return false;
    }
    return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve(true);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function waitGateAbortable(
    waitGate: () => Promise<void>,
    signal: AbortSignal,
): Promise<boolean> {
    if (signal.aborted) {
        return false;
    }
    return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
            if (settled) {
                return;
            }
            settled = true;
            signal.removeEventListener('abort', onAbort);
            resolve(ok);
        };
        const onAbort = () => finish(false);
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(waitGate())
            .then(() => finish(!signal.aborted))
            .catch(() => finish(false));
    });
}

function writeSseEvent(res: ServerResponse, data: unknown): void {
    if (res.writableEnded || res.destroyed) {
        return;
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    res.write(`data: ${payload}\n\n`);
}

/**
 * Local Node HTTP mock OpenAI-compatible server for browser + SillyTavern backend E2E tests.
 * Supports CORS preflight, `/v1/models`, `/v1/chat/completions`, streaming SSE chunks,
 * reasoning deltas, incremental tool calls, prompt-cache usage reporting, and abort tracking.
 */
export class MockOpenAISseServer {
    private readonly server: http.Server;
    private readonly recordedRequests: InternalRecordedRequest[] = [];
    private readonly scenarioQueue: MockScenario[] = [];
    private readonly matchRules: MatcherRule[] = [];
    private readonly requestWaiters: Array<{
        predicate: (req: RecordedLlmRequest) => boolean;
        resolve: (req: RecordedLlmRequest) => void;
    }> = [];
    private fallbackHandler?: (req: RecordedLlmRequest) => MockScenario | Promise<MockScenario>;
    private nextReqId = 1;
    private closed = false;

    readonly port: number;
    readonly baseUrl: string;
    readonly v1Url: string;

    private constructor(server: http.Server, port: number) {
        this.server = server;
        this.port = port;
        this.baseUrl = `http://127.0.0.1:${port}`;
        this.v1Url = `${this.baseUrl}/v1`;
        this.server.on('request', (req, res) => {
            void this.handleHttpRequest(req, res);
        });
    }

    /** Start an isolated Mock OpenAI SSE Server on `127.0.0.1:0`. */
    static async start(): Promise<MockOpenAISseServer> {
        const server = http.createServer();

        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });

        const addr = server.address() as AddressInfo | null;
        if (!addr || typeof addr.port !== 'number') {
            throw new Error('Failed to bind MockOpenAISseServer to an ephemeral port');
        }
        return new MockOpenAISseServer(server, addr.port);
    }

    /** Snapshot of all captured `/chat/completions` requests in arrival order. */
    get requests(): readonly RecordedLlmRequest[] {
        return this.recordedRequests;
    }

    /** Enqueue one or more scripted scenarios into the FIFO queue. */
    enqueue(scenario: MockScenario | MockScenario[]): void {
        if (Array.isArray(scenario)) {
            this.scenarioQueue.push(...scenario);
        } else {
            this.scenarioQueue.push(scenario);
        }
    }

    /** Register a predicate-matched scenario rule checked before the FIFO queue. */
    when(
        predicate: (req: RecordedLlmRequest) => boolean,
        handler: MockScenario | ((req: RecordedLlmRequest) => MockScenario | Promise<MockScenario>),
        options: { once?: boolean } = {},
    ): void {
        this.matchRules.push({
            predicate,
            handler,
            once: options.once ?? false,
        });
    }

    /** Set or clear the fallback handler used when matchers and FIFO queue are empty. */
    setFallbackHandler(
        handler?: (req: RecordedLlmRequest) => MockScenario | Promise<MockScenario>,
    ): void {
        this.fallbackHandler = handler;
    }

    /** Clear captured request logs without altering scripted scenarios. */
    clearRequests(): void {
        this.recordedRequests.length = 0;
    }

    /** Clear predicate matchers, FIFO queue, and fallback handler. */
    clearScenarios(): void {
        this.scenarioQueue.length = 0;
        this.matchRules.length = 0;
        this.fallbackHandler = undefined;
    }

    /** Reset all captured requests and scripted scenarios. */
    reset(): void {
        this.clearRequests();
        this.clearScenarios();
    }

    /** Resolve with the first existing or future request matching `predicate`. */
    async waitForRequest(
        predicate: (req: RecordedLlmRequest) => boolean = () => true,
        timeoutMs = 15000,
    ): Promise<RecordedLlmRequest> {
        const existing = this.recordedRequests.find((r) => predicate(r));
        if (existing) {
            return existing;
        }
        return await new Promise<RecordedLlmRequest>((resolve, reject) => {
            const entry = {
                predicate,
                resolve: (req: RecordedLlmRequest) => {
                    clearTimeout(timer);
                    resolve(req);
                },
            };
            const timer = setTimeout(() => {
                const idx = this.requestWaiters.indexOf(entry);
                if (idx >= 0) {
                    this.requestWaiters.splice(idx, 1);
                }
                reject(new Error(`Timed out after ${timeoutMs}ms waiting for mock LLM request`));
            }, timeoutMs);
            this.requestWaiters.push(entry);
        });
    }

    /** Close the server and force-close any active keep-alive or streaming sockets. */
    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve());
            if (typeof this.server.closeAllConnections === 'function') {
                this.server.closeAllConnections();
            }
        });
    }

    private createRequestRecord(
        req: IncomingMessage,
        pathname: string,
        body: Record<string, unknown>,
    ): InternalRecordedRequest {
        let abortResolved = false;
        let resolveAbort!: () => void;
        const abortPromise = new Promise<void>((resolve) => {
            resolveAbort = resolve;
        });

        const record: InternalRecordedRequest = {
            id: this.nextReqId++,
            method: (req.method ?? 'GET').toUpperCase(),
            path: pathname,
            origin: typeof req.headers.origin === 'string' ? 'browser' : 'server',
            headers: { ...req.headers },
            body,
            stream: body.stream === true,
            aborted: false,
            startedAt: Date.now(),
            waitForAbort: () => abortPromise,
            markAborted: () => {
                if (abortResolved) {
                    return;
                }
                abortResolved = true;
                record.aborted = true;
                record.endedAt = Date.now();
                resolveAbort();
            },
            markEnded: () => {
                record.endedAt = Date.now();
            },
        };
        return record;
    }

    private notifyRequestWaiters(record: RecordedLlmRequest): void {
        for (let i = this.requestWaiters.length - 1; i >= 0; i -= 1) {
            const waiter = this.requestWaiters[i];
            if (waiter.predicate(record)) {
                this.requestWaiters.splice(i, 1);
                waiter.resolve(record);
            }
        }
    }

    private async resolveScenario(record: RecordedLlmRequest): Promise<MockScenario> {
        for (let i = 0; i < this.matchRules.length; i += 1) {
            const rule = this.matchRules[i];
            if (!rule.predicate(record)) {
                continue;
            }
            if (rule.once) {
                this.matchRules.splice(i, 1);
            }
            return typeof rule.handler === 'function'
                ? await rule.handler(record)
                : rule.handler;
        }

        const queued = this.scenarioQueue.shift();
        if (queued) {
            return queued;
        }

        if (this.fallbackHandler) {
            return await this.fallbackHandler(record);
        }

        return DEFAULT_SCENARIO;
    }

    private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
        setCorsHeaders(res);

        const method = (req.method ?? 'GET').toUpperCase();
        const urlObj = new URL(req.url ?? '/', this.baseUrl);
        const pathname = urlObj.pathname;

        if (method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }

        if (method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
            sendJson(res, 200, {
                object: 'list',
                data: [
                    {
                        id: 'mock-gpt',
                        object: 'model',
                        created: 1700000000,
                        owned_by: 'st-agentic-e2e',
                    },
                ],
            });
            return;
        }

        if (
            method === 'POST'
            && (pathname === '/v1/chat/completions' || pathname === '/chat/completions')
        ) {
            await this.handleChatCompletions(req, res, pathname);
            return;
        }

        sendJson(res, 404, {
            error: {
                message: `MockOpenAISseServer: unsupported route ${method} ${pathname}`,
                type: 'invalid_request_error',
            },
        });
    }

    private async handleChatCompletions(
        req: IncomingMessage,
        res: ServerResponse,
        pathname: string,
    ): Promise<void> {
        const body = await readJsonBody(req);
        const record = this.createRequestRecord(req, pathname, body);
        this.recordedRequests.push(record);
        this.notifyRequestWaiters(record);

        const abortController = new AbortController();
        let completedNormally = false;

        const onClientClose = () => {
            if (!completedNormally) {
                record.markAborted();
                abortController.abort();
            }
        };

        res.on('close', onClientClose);

        try {
            const scenario = await this.resolveScenario(record);
            if (abortController.signal.aborted) {
                return;
            }

            if (scenario.status && scenario.status >= 400) {
                completedNormally = true;
                record.markEnded();
                sendJson(
                    res,
                    scenario.status,
                    scenario.errorBody ?? { error: { message: 'Mock HTTP error' } },
                );
                return;
            }

            const model =
                scenario.model
                ?? (typeof body.model === 'string' && body.model ? body.model : 'mock-gpt');
            const usage = scenario.usage ?? DEFAULT_USAGE;

            if (!record.stream) {
                if (scenario.waitGate) {
                    const ok = await waitGateAbortable(scenario.waitGate, abortController.signal);
                    if (!ok) {
                        return;
                    }
                }
                for (const chunk of scenario.chunks ?? []) {
                    if (chunk.delayMs && chunk.delayMs > 0) {
                        const ok = await sleepAbortable(chunk.delayMs, abortController.signal);
                        if (!ok) {
                            return;
                        }
                    }
                    if (chunk.waitGate) {
                        const ok = await waitGateAbortable(chunk.waitGate, abortController.signal);
                        if (!ok) {
                            return;
                        }
                    }
                }
                if (abortController.signal.aborted) {
                    return;
                }
                const content =
                    scenario.nonStreamContent
                    ?? scenario.chunks?.map((c) => c.content ?? '').join('')
                    ?? 'OK';
                const message: Record<string, unknown> = {
                    role: 'assistant',
                    content,
                };
                if (scenario.nonStreamReasoning !== undefined) {
                    message.reasoning_content = scenario.nonStreamReasoning;
                }
                if (scenario.nonStreamToolCalls && scenario.nonStreamToolCalls.length > 0) {
                    message.tool_calls = scenario.nonStreamToolCalls;
                }
                completedNormally = true;
                record.markEnded();
                sendJson(res, 200, {
                    id: `chatcmpl-mock-${record.id}`,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                        {
                            index: 0,
                            message,
                            finish_reason: scenario.finishReason ?? 'stop',
                        },
                    ],
                    usage,
                });
                return;
            }

            setCorsHeaders(res);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            const completionId = `chatcmpl-mock-${record.id}`;
            const created = Math.floor(Date.now() / 1000);

            writeSseEvent(res, {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            });

            const chunks = scenario.chunks ?? [];
            let sawExplicitFinishReason = false;

            for (const chunk of chunks) {
                if (chunk.delayMs && chunk.delayMs > 0) {
                    const ok = await sleepAbortable(chunk.delayMs, abortController.signal);
                    if (!ok) {
                        return;
                    }
                }
                if (chunk.waitGate) {
                    const ok = await waitGateAbortable(chunk.waitGate, abortController.signal);
                    if (!ok) {
                        return;
                    }
                }
                if (abortController.signal.aborted) {
                    return;
                }

                const delta: Record<string, unknown> = {};
                if (chunk.content !== undefined) {
                    delta.content = chunk.content;
                }
                if (chunk.reasoningContent !== undefined) {
                    delta.reasoning_content = chunk.reasoningContent;
                }
                if (chunk.toolCalls !== undefined) {
                    delta.tool_calls = chunk.toolCalls;
                }
                if (chunk.finishReason !== undefined && chunk.finishReason !== null) {
                    sawExplicitFinishReason = true;
                }

                writeSseEvent(res, {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta,
                            finish_reason: chunk.finishReason ?? null,
                        },
                    ],
                });
            }

            if (scenario.keepOpenUntilAborted) {
                await new Promise<void>((resolve) => {
                    if (abortController.signal.aborted) {
                        resolve();
                        return;
                    }
                    abortController.signal.addEventListener('abort', () => resolve(), {
                        once: true,
                    });
                });
                return;
            }

            if (abortController.signal.aborted) {
                return;
            }

            if (!sawExplicitFinishReason) {
                writeSseEvent(res, {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model,
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: scenario.finishReason ?? 'stop',
                        },
                    ],
                });
            }

            writeSseEvent(res, {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [],
                usage,
            });

            completedNormally = true;
            record.markEnded();
            writeSseEvent(res, '[DONE]');
            if (!res.writableEnded) {
                res.end();
            }
        } catch (error) {
            if (!res.headersSent) {
                completedNormally = true;
                record.markEnded();
                sendJson(res, 500, {
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                    },
                });
            } else if (!res.writableEnded) {
                res.end();
            }
        }
    }
}
