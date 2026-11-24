import type {
    ApiConnection,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    TokenUsage,
} from '../types';

export type LLMToolChoiceMode = 'auto' | 'required' | 'none';

export interface LLMToolChoice {
    mode: LLMToolChoiceMode;
    /**
     * Optional whitelist of tool names allowed in this round (compiler intersects with `request.tools`).
     * Never mutates top-level `request.tools`; maps only to backend decoding config.
     */
    allowedToolNames?: readonly string[];
}

export interface LLMRequest {
    connectionId: string;
    connection?: ApiConnection;
    messages: CanonicalMessage[];
    tools: CanonicalToolSchema[];
    cacheBreakpoints?: number[];
    toolChoice?: LLMToolChoice;
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

export interface RemoteModelInfo {
    id: string;
    displayName?: string;
    ownedBy?: string;
    contextLength?: number;
}

export interface ListModelsRequest {
    connectionId?: string;
    connection?: ApiConnection;
    signal?: AbortSignal;
}

export interface LLMTransport {
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
    listModels?(request: ListModelsRequest): Promise<RemoteModelInfo[]>;
}
