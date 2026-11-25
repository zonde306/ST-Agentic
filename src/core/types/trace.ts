import type { CanonicalMessage, CanonicalToolSchema, MessageTarget } from './messages';
import type { BarrierPolicy, PipelinePhase } from './settings';

export interface TokenUsage {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    totalTokens?: number;
    cacheHitRate?: number;
}

export interface ToolStepLog {
    stepIndex: number;
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown> | string;
    result: string;
    ok: boolean;
    error?: string;
    durationMs: number;
    startedAt: number;
    redacted?: boolean;
    undoId?: string;
}

export type InterruptedReason = 'user_stop' | 'length' | 'error' | 'empty_output';

export type AgentRunStatus = 'running' | 'completed' | 'interrupted' | 'aborted' | 'error';

export type OffMainlineRunKind = 'assistant' | 'sidegen_once' | 'sidegen_session';

export interface AgentRunTrace {
    runId: string;
    target: MessageTarget;
    phase: PipelinePhase;
    agentProfileId: string;
    agentName: string;
    triggerId?: string;
    triggerLabel?: string;
    triggerSource?: 'preset' | 'worldinfo';
    lorebookNames?: string[];
    connectionId: string;
    model: string;
    status: AgentRunStatus;
    startedAt: number;
    endedAt?: number;
    durationMs: number;
    usage: TokenUsage;
    toolSteps: ToolStepLog[];
    outputPreview?: string;
    interruptedReason?: InterruptedReason;
    error?: string;
    offMainlineKind?: OffMainlineRunKind;
    offMainlineSessionId?: string;
    redacted?: boolean;
    requestSnapshot?: {
        messages: CanonicalMessage[];
        tools: CanonicalToolSchema[];
        cacheBreakpoints?: number[];
    };
}

export type BackgroundTaskState = 'queued' | 'running' | 'completed' | 'aborted' | 'error';

export interface BackgroundTaskStatus {
    taskId: string;
    target: MessageTarget;
    phase: PipelinePhase;
    barrier: BarrierPolicy;
    agentProfileId: string;
    label: string;
    state: BackgroundTaskState;
    startedAt: number;
    endedAt?: number;
    currentStep?: string;
    error?: string;
}

export type GenerationEventKind =
    | 'turn_started'
    | 'phase_started'
    | 'phase_completed'
    | 'tool_started'
    | 'tool_completed'
    | 'text_delta'
    | 'reasoning_delta'
    | 'output_preview'
    | 'turn_retrying'
    | 'turn_interrupted'
    | 'turn_resumed'
    | 'background_task_updated'
    | 'trace_recorded'
    | 'turn_completed'
    | 'turn_aborted'
    | 'turn_error';

export interface GenerationEventPayload {
    kind: GenerationEventKind;
    target: MessageTarget;
    timestamp: number;
    phase?: PipelinePhase;
    runId?: string;
    agentProfileId?: string;
    textDelta?: string;
    reasoningDelta?: string;
    outputPreview?: string;
    interruptedReason?: InterruptedReason;
    retryAttempt?: number;
    retryMaxAttempts?: number;
    retryDelayMs?: number;
    retryReason?: string;
    toolStep?: ToolStepLog;
    task?: BackgroundTaskStatus;
    trace?: AgentRunTrace;
    error?: string;
}

export type ConsoleTabId =
    | 'assistant'
    | 'sidegen'
    | 'files'
    | 'logs'
    | 'cache'
    | 'prompts'
    | 'agents'
    | 'pipeline'
    | 'tools'
    | 'regex'
    | 'wi'
    | 'connections';
