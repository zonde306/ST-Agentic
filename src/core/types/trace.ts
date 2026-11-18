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
}

export type AgentRunStatus = 'running' | 'completed' | 'aborted' | 'error';

export interface AgentRunTrace {
    runId: string;
    target: MessageTarget;
    phase: PipelinePhase;
    agentProfileId: string;
    agentName: string;
    triggerId?: string;
    triggerLabel?: string;
    connectionId: string;
    model: string;
    status: AgentRunStatus;
    startedAt: number;
    endedAt?: number;
    durationMs: number;
    usage: TokenUsage;
    toolSteps: ToolStepLog[];
    outputPreview?: string;
    error?: string;
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
    toolStep?: ToolStepLog;
    task?: BackgroundTaskStatus;
    trace?: AgentRunTrace;
    error?: string;
}

export type ConsoleTabId =
    | 'files'
    | 'logs'
    | 'cache'
    | 'agents'
    | 'pipeline'
    | 'tools'
    | 'regex'
    | 'wi'
    | 'connections';
