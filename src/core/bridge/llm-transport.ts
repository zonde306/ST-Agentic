import type {
    ApiConnection,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    TokenUsage,
} from '../types';

export interface LLMRequest {
    connectionId: string;
    connection?: ApiConnection;
    messages: CanonicalMessage[];
    tools: CanonicalToolSchema[];
    cacheBreakpoints?: number[];
    stream?: boolean;
    signal?: AbortSignal;
}

export interface LLMResponse {
    content: string;
    reasoningContent?: string;
    toolCalls: CanonicalToolCall[];
    usage: TokenUsage;
    finishReason?: string;
    raw?: unknown;
}

export type LLMStreamChunkType =
    | 'text_delta'
    | 'reasoning_delta'
    | 'tool_call_delta'
    | 'usage'
    | 'done';

export interface LLMStreamChunk {
    type: LLMStreamChunkType;
    textDelta?: string;
    reasoningDelta?: string;
    toolCallIndex?: number;
    toolCallId?: string;
    toolName?: string;
    argumentsDelta?: string;
    thoughtSignature?: string;
    usage?: TokenUsage;
    finishReason?: string;
}

export interface LLMTransport {
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}
