import { describe, expect, it, vi } from 'vitest';
import type { LLMRequest, LLMStreamChunk } from '@/core/bridge';
import type { ApiConnection } from '@/core/types';
import { FetchLLMTransport, LLMTransportError } from '@/core/llm';
import { DeferredGate } from '../../mocks';

function makeConnection(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return {
        id: 'conn-openai',
        name: 'OpenAI',
        providerFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-live-test',
        model: 'gpt-4o',
        contextSize: 64000,
        maxTokens: 1024,
        temperature: 0.7,
        topK: 0,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        includeHeaders: {},
        includeBody: {},
        excludeBody: {},
        maxConcurrency: 2,
        cachePolicy: 'auto_prefix',
        ...overrides,
    };
}

function makeSSEStream(frames: string[], delayBetweenMs: number = 0): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const frame of frames) {
                if (delayBetweenMs > 0) {
                    await new Promise((r) => setTimeout(r, delayBetweenMs));
                }
                controller.enqueue(encoder.encode(frame));
            }
            controller.close();
        },
    });
}

describe('FetchLLMTransport', () => {
    it('executes complete() and stream() via resolveConnection and parses OpenAI SSE chunks', async () => {
        const conn = makeConnection();
        const calls: Array<{ url: string; init?: RequestInit }> = [];

        const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString();
            calls.push({ url, init });

            const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
            if (parsedBody.stream) {
                const body = makeSSEStream([
                    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Plan "}}]}\n\n',
                    'data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\n',
                    'data: {"choices":[{"index":0,"delta":{"content":"world","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"p\\":"}}]}}]}\n\n',
                    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
                    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
                    'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":900}}}\n\n',
                    'data: [DONE]\n\n',
                ]);
                return new Response(body, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                });
            }

            return new Response(
                JSON.stringify({
                    choices: [
                        {
                            message: {
                                role: 'assistant',
                                content: '<think>hidden</think>Visible reply',
                                tool_calls: [],
                            },
                            finish_reason: 'stop',
                        },
                    ],
                    usage: {
                        prompt_tokens: 500,
                        completion_tokens: 15,
                        prompt_tokens_details: { cached_tokens: 400 },
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            );
        });

        const transport = new FetchLLMTransport({
            fetchImpl: fetchMock,
            resolveConnection: (id) => (id === conn.id ? conn : undefined),
            retry: false,
        });

        const req: LLMRequest = {
            connectionId: conn.id,
            messages: [
                { role: 'system', content: 'Sys' },
                { role: 'user', content: 'Hi' },
            ],
            tools: [],
        };

        const completed = await transport.complete(req);
        expect(completed.content).toBe('Visible reply');
        expect(completed.reasoningContent).toBe('hidden');
        expect(completed.usage.cachedTokens).toBe(400);
        expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');

        const streamed: LLMStreamChunk[] = [];
        for await (const chunk of transport.stream(req)) {
            streamed.push(chunk);
        }

        expect(streamed.filter((c) => c.type === 'text_delta').map((c) => c.textDelta).join('')).toBe(
            'Hello world',
        );
        expect(streamed.filter((c) => c.type === 'reasoning_delta').map((c) => c.reasoningDelta).join('')).toBe(
            'Plan ',
        );
        const toolDeltas = streamed.filter((c) => c.type === 'tool_call_delta');
        expect(toolDeltas.map((c) => c.argumentsDelta).join('')).toBe('{"p":"x"}');
        expect(streamed.find((c) => c.type === 'usage')?.usage?.cachedTokens).toBe(900);
    });

    it('retries transient 429/503 responses and stops immediately on 401', async () => {
        let attempt = 0;
        const fetchMock = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) {
                return new Response(JSON.stringify({ error: { message: 'Rate limited' } }), {
                    status: 429,
                    headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
                });
            }
            if (attempt === 2) {
                return new Response('Bad gateway', { status: 502 });
            }
            return new Response(
                JSON.stringify({
                    type: 'message',
                    content: [{ type: 'text', text: 'Claude OK' }],
                    stop_reason: 'end_turn',
                    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });

        const anthropicConn = makeConnection({
            id: 'claude',
            providerFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            cachePolicy: 'anthropic_explicit',
        });

        const transport = new FetchLLMTransport({
            fetchImpl: fetchMock,
            connections: { [anthropicConn.id]: anthropicConn },
            retry: { maxAttempts: 4, initialDelayMs: 5, backoffFactor: 2 },
        });

        const res = await transport.complete({
            connectionId: 'claude',
            messages: [{ role: 'user', content: 'Hello' }],
            tools: [],
        });

        expect(attempt).toBe(3);
        expect(res.content).toBe('Claude OK');
        expect(res.usage.cachedTokens).toBe(90);
        expect(res.usage.inputTokens).toBe(100);

        const authFailMock = vi.fn(async () =>
            new Response(JSON.stringify({ error: { message: 'Invalid x-api-key' } }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        const failTransport = new FetchLLMTransport({
            fetchImpl: authFailMock,
            connections: { [anthropicConn.id]: anthropicConn },
            retry: { maxAttempts: 4, initialDelayMs: 5 },
        });

        await expect(
            failTransport.complete({
                connectionId: 'claude',
                messages: [{ role: 'user', content: 'Hello' }],
                tools: [],
            }),
        ).rejects.toBeInstanceOf(LLMTransportError);
        expect(authFailMock).toHaveBeenCalledTimes(1);
    });

    it('enforces per-connection maxConcurrency across parallel requests', async () => {
        const gate1 = new DeferredGate<void>();
        const gate2 = new DeferredGate<void>();
        let inFlight = 0;
        let peak = 0;
        let callCount = 0;

        const fetchMock = vi.fn(async () => {
            callCount += 1;
            const current = callCount;
            inFlight += 1;
            peak = Math.max(peak, inFlight);

            if (current === 1) {
                await gate1.wait();
            } else if (current === 2) {
                await gate2.wait();
            }

            inFlight -= 1;
            return new Response(
                JSON.stringify({
                    choices: [{ message: { content: `ok-${current}` }, finish_reason: 'stop' }],
                    usage: { prompt_tokens: 10, completion_tokens: 5 },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
        });

        const conn = makeConnection({ maxConcurrency: 1 });
        const transport = new FetchLLMTransport({
            fetchImpl: fetchMock,
            connections: { [conn.id]: conn },
            retry: false,
        });

        const req: LLMRequest = {
            connectionId: conn.id,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [],
        };

        const p1 = transport.complete(req);
        const p2 = transport.complete(req);

        await gate1.waitUntilWaiting();
        expect(callCount).toBe(1);
        expect(peak).toBe(1);

        gate1.resolve();
        await gate2.waitUntilWaiting();
        expect(callCount).toBe(2);
        expect(peak).toBe(1);

        gate2.resolve();
        const results = await Promise.all([p1, p2]);
        expect(results.map((r) => r.content)).toEqual(['ok-1', 'ok-2']);
        expect(peak).toBe(1);
    });

    it('cancels stalled streaming responses immediately on AbortSignal', async () => {
        const streamCancelSpy = vi.fn();
        const encoder = new TextEncoder();

        const stalledStream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"first "}}]}\n\n'),
                );
                // Intentionally never closes or pushes another chunk unless cancelled
            },
            cancel() {
                streamCancelSpy();
            },
        });

        const fetchMock = vi.fn(async () =>
            new Response(stalledStream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' },
            }),
        );

        const conn = makeConnection();
        const transport = new FetchLLMTransport({
            fetchImpl: fetchMock,
            retry: false,
        });

        const controller = new AbortController();
        const received: string[] = [];

        const startTime = Date.now();
        await expect(
            (async () => {
                for await (const chunk of transport.stream({
                    connectionId: conn.id,
                    connection: conn,
                    messages: [{ role: 'user', content: 'stream' }],
                    tools: [],
                    signal: controller.signal,
                })) {
                    if (chunk.type === 'text_delta' && chunk.textDelta) {
                        received.push(chunk.textDelta);
                        setTimeout(() => controller.abort(), 15);
                    }
                }
            })(),
        ).rejects.toMatchObject({ name: 'AbortError' });

        expect(received).toEqual(['first ']);
        expect(streamCancelSpy).toHaveBeenCalledTimes(1);
        expect(Date.now() - startTime).toBeLessThan(500);

        // Concurrency slot must also be released after aborted stream
        const limiter = transport.getLimiter(conn.id);
        expect(limiter?.activeCount ?? 0).toBe(0);
    });

    it('rejects immediately on unknown connection without invoking fetch', async () => {
        const fetchMock = vi.fn();
        const transport = new FetchLLMTransport({
            fetchImpl: fetchMock,
            retry: false,
        });

        await expect(
            transport.complete({
                connectionId: 'missing-id',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [],
            }),
        ).rejects.toThrow(/missing-id/);

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('aborts hung fetch and retry backoff immediately on AbortSignal, and cleans up on early stream break', async () => {
        const conn = makeConnection({ maxConcurrency: 1 });

        // 1. Hung fetch (ignores init.signal) must still abort promptly
        const hungFetch = vi.fn(() => new Promise<Response>(() => {}));
        const hungTransport = new FetchLLMTransport({
            fetchImpl: hungFetch,
            connections: { [conn.id]: conn },
            retry: false,
        });
        const abortHung = new AbortController();
        setTimeout(() => abortHung.abort(), 15);
        const t0 = Date.now();
        await expect(
            hungTransport.complete({
                connectionId: conn.id,
                messages: [{ role: 'user', content: 'hi' }],
                tools: [],
                signal: abortHung.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(Date.now() - t0).toBeLessThan(500);
        expect(hungTransport.getLimiter(conn.id)?.activeCount).toBe(0);

        // 2. Abort during retry backoff
        const fail503 = vi.fn(async () => new Response('Unavailable', { status: 503 }));
        const retryTransport = new FetchLLMTransport({
            fetchImpl: fail503,
            connections: { [conn.id]: conn },
            retry: { maxAttempts: 5, initialDelayMs: 10_000 },
        });
        const abortRetry = new AbortController();
        setTimeout(() => abortRetry.abort(), 15);
        const t1 = Date.now();
        await expect(
            retryTransport.complete({
                connectionId: conn.id,
                messages: [{ role: 'user', content: 'hi' }],
                tools: [],
                signal: abortRetry.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(fail503).toHaveBeenCalledTimes(1);
        expect(Date.now() - t1).toBeLessThan(500);

        // 3. Early break from stream() cancels reader and frees concurrency slot
        const cancelSpy = vi.fn();
        const multiChunkStream = new ReadableStream<Uint8Array>({
            start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"one"}}]}\n\n'));
                controller.enqueue(enc.encode('data: {"choices":[{"index":0,"delta":{"content":"two"}}]}\n\n'));
            },
            cancel() {
                cancelSpy();
            },
        });
        const streamTransport = new FetchLLMTransport({
            fetchImpl: async () =>
                new Response(multiChunkStream, {
                    status: 200,
                    headers: { 'Content-Type': 'text/event-stream' },
                }),
            connections: { [conn.id]: conn },
            retry: false,
        });
        for await (const chunk of streamTransport.stream({
            connectionId: conn.id,
            messages: [{ role: 'user', content: 'hi' }],
            tools: [],
        })) {
            if (chunk.type === 'text_delta') {
                break;
            }
        }
        expect(cancelSpy).toHaveBeenCalledTimes(1);
        expect(streamTransport.getLimiter(conn.id)?.activeCount).toBe(0);
    });
});
