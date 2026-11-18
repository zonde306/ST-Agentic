import type {
    LLMRequest,
    LLMResponse,
    LLMStreamChunk,
    LLMTransport,
} from '@/core/bridge';
import type { CanonicalToolCall, TokenUsage } from '@/core/types';
import { canonicalClone } from '@/core/utils';

export interface ScriptedTurnSpec {
    content?: string;
    reasoningContent?: string;
    toolCalls?: CanonicalToolCall[];
    usage?: Partial<TokenUsage>;
    finishReason?: string;
    chunks?: LLMStreamChunk[];
    chunkSize?: number;
    delayMs?: number;
    error?: Error;
    errorAfterChunks?: number;
}

export type ScriptedTurnFactory = (
    request: LLMRequest,
    callIndex: number,
) => ScriptedTurnSpec | Promise<ScriptedTurnSpec>;

export type ScriptedTurnInput = ScriptedTurnSpec | ScriptedTurnFactory;

export class ScriptedLLMTransport implements LLMTransport {
    public readonly requests: LLMRequest[] = [];
    private readonly queue: ScriptedTurnInput[] = [];
    private callIndex = 0;

    constructor(turns: ScriptedTurnInput[] = []) {
        this.enqueue(...turns);
    }

    enqueue(...turns: ScriptedTurnInput[]): this {
        this.queue.push(...turns);
        return this;
    }

    get remainingTurns(): number {
        return this.queue.length;
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        const captured = captureRequest(request);
        this.requests.push(captured);

        throwIfAborted(request.signal);
        const turn = await this.nextTurn(captured);

        if (turn.delayMs && turn.delayMs > 0) {
            await delayWithAbort(turn.delayMs, request.signal);
        }

        if (turn.error) {
            throw turn.error;
        }

        return materializeResponse(turn);
    }

    async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
        const captured = captureRequest(request);
        this.requests.push(captured);

        throwIfAborted(request.signal);
        const turn = await this.nextTurn(captured);

        if (turn.delayMs && turn.delayMs > 0) {
            await delayWithAbort(turn.delayMs, request.signal);
        }

        if (turn.error && turn.errorAfterChunks === undefined) {
            throw turn.error;
        }

        const chunks = turn.chunks ?? buildStreamChunks(turn);
        let emitted = 0;
        for (const chunk of chunks) {
            throwIfAborted(request.signal);
            if (turn.error && turn.errorAfterChunks !== undefined && emitted >= turn.errorAfterChunks) {
                throw turn.error;
            }
            yield chunk;
            emitted += 1;
        }

        if (turn.error && turn.errorAfterChunks !== undefined && emitted >= turn.errorAfterChunks) {
            throw turn.error;
        }
    }

    private async nextTurn(request: LLMRequest): Promise<ScriptedTurnSpec> {
        const next = this.queue.shift();
        const currentIndex = this.callIndex;
        this.callIndex += 1;

        if (!next) {
            throw new Error(`ScriptedLLMTransport queue exhausted at call #${currentIndex}`);
        }

        return typeof next === 'function' ? await next(request, currentIndex) : next;
    }
}

function captureRequest(request: LLMRequest): LLMRequest {
    return {
        connectionId: request.connectionId,
        connection: request.connection ? canonicalClone(request.connection) : undefined,
        messages: canonicalClone(request.messages),
        tools: canonicalClone(request.tools),
        cacheBreakpoints: request.cacheBreakpoints ? [...request.cacheBreakpoints] : undefined,
        stream: request.stream,
        signal: request.signal,
    };
}

function normalizeUsage(partial?: Partial<TokenUsage>): TokenUsage {
    const inputTokens = partial?.inputTokens ?? 100;
    const cachedTokens = partial?.cachedTokens ?? 0;
    const outputTokens = partial?.outputTokens ?? 20;
    const totalTokens = partial?.totalTokens ?? inputTokens + outputTokens;
    const cacheHitRate =
        partial?.cacheHitRate ?? (inputTokens > 0 ? cachedTokens / inputTokens : 0);

    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens,
        cacheHitRate,
    };
}

function materializeResponse(turn: ScriptedTurnSpec): LLMResponse {
    if (turn.chunks && !turn.content && !turn.toolCalls && !turn.reasoningContent) {
        let content = '';
        let reasoningContent = '';
        const toolMap = new Map<number, CanonicalToolCall>();
        let usage = normalizeUsage(turn.usage);
        let finishReason = turn.finishReason;

        for (const chunk of turn.chunks) {
            if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
            } else if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoningContent += chunk.reasoningDelta;
            } else if (chunk.type === 'tool_call_delta') {
                const idx = chunk.toolCallIndex ?? 0;
                const prev = toolMap.get(idx) ?? { id: '', name: '', arguments: '' };
                if (chunk.toolCallId) prev.id = chunk.toolCallId;
                if (chunk.toolName) prev.name = chunk.toolName;
                if (chunk.argumentsDelta) prev.arguments += chunk.argumentsDelta;
                if (chunk.thoughtSignature) prev.thoughtSignature = chunk.thoughtSignature;
                toolMap.set(idx, prev);
            } else if (chunk.type === 'usage' && chunk.usage) {
                usage = normalizeUsage(chunk.usage);
            } else if (chunk.type === 'done' && chunk.finishReason) {
                finishReason = chunk.finishReason;
            }
        }

        return {
            content,
            reasoningContent: reasoningContent || undefined,
            toolCalls: Array.from(toolMap.entries())
                .sort(([a], [b]) => a - b)
                .map(([, call]) => call),
            usage,
            finishReason,
        };
    }

    return {
        content: turn.content ?? '',
        reasoningContent: turn.reasoningContent,
        toolCalls: turn.toolCalls ? canonicalClone(turn.toolCalls) : [],
        usage: normalizeUsage(turn.usage),
        finishReason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop'),
    };
}

function buildStreamChunks(turn: ScriptedTurnSpec): LLMStreamChunk[] {
    const chunks: LLMStreamChunk[] = [];
    const chunkSize = Math.max(1, turn.chunkSize ?? 5);

    if (turn.reasoningContent) {
        for (const part of sliceString(turn.reasoningContent, chunkSize)) {
            chunks.push({ type: 'reasoning_delta', reasoningDelta: part });
        }
    }

    if (turn.content) {
        for (const part of sliceString(turn.content, chunkSize)) {
            chunks.push({ type: 'text_delta', textDelta: part });
        }
    }

    if (turn.toolCalls?.length) {
        turn.toolCalls.forEach((call, index) => {
            const argParts = sliceString(call.arguments, chunkSize);
            if (argParts.length === 0) {
                chunks.push({
                    type: 'tool_call_delta',
                    toolCallIndex: index,
                    toolCallId: call.id,
                    toolName: call.name,
                    argumentsDelta: '',
                    thoughtSignature: call.thoughtSignature,
                });
                return;
            }

            argParts.forEach((part, partIndex) => {
                chunks.push({
                    type: 'tool_call_delta',
                    toolCallIndex: index,
                    toolCallId: partIndex === 0 ? call.id : undefined,
                    toolName: partIndex === 0 ? call.name : undefined,
                    argumentsDelta: part,
                    thoughtSignature: partIndex === 0 ? call.thoughtSignature : undefined,
                });
            });
        });
    }

    chunks.push({
        type: 'usage',
        usage: normalizeUsage(turn.usage),
    });

    chunks.push({
        type: 'done',
        finishReason: turn.finishReason ?? (turn.toolCalls?.length ? 'tool_calls' : 'stop'),
    });

    return chunks;
}

function sliceString(text: string, size: number): string[] {
    if (!text) {
        return [];
    }
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size) {
        parts.push(text.slice(i, i + size));
    }
    return parts;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const err = new Error('LLM request aborted');
        err.name = 'AbortError';
        throw err;
    }
}

function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            const err = new Error('LLM request aborted');
            err.name = 'AbortError';
            reject(err);
            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        function onAbort() {
            clearTimeout(timer);
            const err = new Error('LLM request aborted');
            err.name = 'AbortError';
            reject(err);
        }

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
