import type { MessageTarget } from '../types';
import type { HostBridge } from './host-bridge';
import type { PromptTransformErrorEntry } from './prompt-transform';

export const DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS = 3;

export type OutputProcessStage = 'output_mutation' | 'turn_finish';
export type OutputProcessOperation =
    | 'write_file'
    | 'append_file'
    | 'edit_file'
    | 'append_reply_view'
    | 'replace_reply_view'
    | 'finish_turn'
    | 'plain_finish';
export type OutputProcessAction = 'accept' | 'fix' | 'retry';
export type OutputProcessRunnerKind = 'agent' | 'assistant' | 'sidegen';
export type OutputProcessFinishMode = 'strict_tool' | 'plain_text';

export interface OutputProcessMeta {
    readonly runner: OutputProcessRunnerKind;
    readonly stage: OutputProcessStage;
    readonly operation: OutputProcessOperation;
    readonly finishMode?: OutputProcessFinishMode;
    readonly sessionId: string;
    readonly round: number;
    readonly retryAttempt: number;
    readonly maxRetries: number;
    readonly fixAttempt: number;
    readonly maxFixAttempts: number;
    readonly target?: MessageTarget;
    readonly messageId?: number;
    readonly swipeId?: number;
    readonly filePath?: string;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly agentId?: string;
    readonly agentName?: string;
    readonly triggerId?: string;
    readonly surface?: string;
    readonly targetId?: string;
    readonly stream?: boolean;
    readonly hasPrefill?: boolean;
    readonly previousText?: string;
    readonly sessionBag?: Record<string, unknown>;
}

export interface OutputProcessControl {
    retry(reason?: string, extId?: string): void;
    requestFix(message: string, options?: { rejectWrite?: boolean; extId?: string }): void;
    readonly action: OutputProcessAction;
    readonly retryReason?: string;
    readonly fixMessage?: string;
    readonly rejectWrite: boolean;
    readonly requestedBy?: string;
}

export interface OutputProcessPayload {
    text: string;
    readonly originalText: string;
    readonly meta: OutputProcessMeta;
    readonly control: OutputProcessControl;
}

export interface OutputProcessInput {
    readonly text: string;
    readonly meta: OutputProcessMeta;
}

export interface OutputProcessResult {
    readonly text: string;
    readonly changed: boolean;
    readonly action: OutputProcessAction;
    readonly retryReason?: string;
    readonly fixMessage?: string;
    readonly rejectWrite: boolean;
    readonly requestedBy?: string;
    readonly errors: readonly PromptTransformErrorEntry[];
}

export type OutputProcessListener = (
    payload: OutputProcessPayload,
) => void | Promise<void>;

interface MutableOutputControlState {
    action: OutputProcessAction;
    retryReason?: string;
    fixMessage?: string;
    rejectWrite: boolean;
    requestedBy?: string;
}

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Create a monotonic control interface for `agentic_output_process` listeners.
 * Priority is strictly monotonic: `retry` > `fix` > `accept`.
 */
export function createOutputProcessControl(): OutputProcessControl {
    const state: MutableOutputControlState = {
        action: 'accept',
        rejectWrite: false,
    };

    return {
        retry(reason?: string, extId?: string) {
            state.action = 'retry';
            state.retryReason = normalizeOptionalString(reason) ?? state.retryReason;
            state.requestedBy = normalizeOptionalString(extId) ?? state.requestedBy;
        },
        requestFix(message: string, options?: { rejectWrite?: boolean; extId?: string }) {
            const normalizedMessage = normalizeOptionalString(message)
                ?? 'Output validation requested a revision.';
            if (options?.rejectWrite === true) {
                state.rejectWrite = true;
            }
            if (state.action === 'retry') {
                // Keep higher-priority retry action, but append context if retryReason is empty.
                if (!state.retryReason) {
                    state.retryReason = normalizedMessage;
                }
                return;
            }
            state.action = 'fix';
            state.fixMessage = state.fixMessage
                ? `${state.fixMessage}\n${normalizedMessage}`
                : normalizedMessage;
            state.requestedBy = normalizeOptionalString(options?.extId) ?? state.requestedBy;
        },
        get action() {
            return state.action;
        },
        get retryReason() {
            return state.retryReason;
        },
        get fixMessage() {
            return state.fixMessage;
        },
        get rejectWrite() {
            return state.rejectWrite;
        },
        get requestedBy() {
            return state.requestedBy;
        },
    };
}

/**
 * Build the mutable payload passed to `agentic_output_process` listeners.
 */
export function createOutputProcessPayload(input: OutputProcessInput): OutputProcessPayload {
    const originalText = typeof input.text === 'string' ? input.text : '';
    const control = createOutputProcessControl();
    const resolvedTarget: MessageTarget | undefined =
        input.meta.target
        ?? (input.meta.messageId !== undefined && input.meta.swipeId !== undefined
            ? { messageId: input.meta.messageId, swipeId: input.meta.swipeId }
            : undefined);
    const resolvedMessageId = input.meta.messageId ?? resolvedTarget?.messageId;
    const resolvedSwipeId = input.meta.swipeId ?? resolvedTarget?.swipeId;
    return {
        text: originalText,
        originalText,
        meta: {
            ...input.meta,
            ...(resolvedTarget ? { target: { ...resolvedTarget } } : {}),
            ...(resolvedMessageId !== undefined ? { messageId: resolvedMessageId } : {}),
            ...(resolvedSwipeId !== undefined ? { swipeId: resolvedSwipeId } : {}),
        },
        control,
    };
}

/**
 * Normalize listener mutations safely and convert to `OutputProcessResult`.
 */
export function finalizeOutputProcessPayload(
    payload: OutputProcessPayload,
    originalText: string,
    errors: readonly PromptTransformErrorEntry[] = [],
): OutputProcessResult {
    const resolvedText = typeof payload.text === 'string' ? payload.text : originalText;
    return {
        text: resolvedText,
        changed: resolvedText !== originalText,
        action: payload.control.action,
        retryReason: payload.control.retryReason,
        fixMessage: payload.control.fixMessage,
        rejectWrite: payload.control.rejectWrite,
        requestedBy: payload.control.requestedBy,
        errors,
    };
}

/**
 * Return an identity result when no host hook is attached or all limits are bypassed.
 */
export function createNoopOutputProcessResult(text: string): OutputProcessResult {
    return {
        text,
        changed: false,
        action: 'accept',
        rejectWrite: false,
        errors: [],
    };
}

/**
 * Invoke `bridge.processOutputText` safely with fallback to identity accept on hook error.
 */
export async function runOutputProcess(
    bridge: Pick<HostBridge, 'processOutputText'>,
    input: OutputProcessInput,
): Promise<OutputProcessResult> {
    if (!bridge.processOutputText) {
        return createNoopOutputProcessResult(input.text);
    }
    try {
        return await bridge.processOutputText(input);
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        return {
            text: input.text,
            changed: false,
            action: 'accept',
            rejectWrite: false,
            errors: [{ error: normalizedError }],
        };
    }
}

/**
 * Format feedback sent back to the model when an extension requests a fix.
 */
export function formatOutputFixFeedback(
    message: string,
    options?: {
        stage?: OutputProcessStage;
        operation?: OutputProcessOperation;
        rejectWrite?: boolean;
        requestedBy?: string;
    },
): string {
    const trimmed = normalizeOptionalString(message) ?? 'Output validation requested a revision.';
    const source = options?.requestedBy ? ` (${options.requestedBy})` : '';
    if (options?.stage === 'output_mutation') {
        const verb = options.rejectWrite
            ? 'was rejected and NOT saved'
            : 'needs revision';
        return `[Output validation${source}] Your update to /output.md (${options.operation ?? 'output'}) ${verb}: ${trimmed} Please fix /output.md before finishing.`;
    }
    if (options?.operation === 'finish_turn') {
        return `[Output validation${source}] Finish rejected: ${trimmed} Please revise your output before calling finish_turn again.`;
    }
    return `[Output validation${source}] Response rejected: ${trimmed} Please provide a corrected response.`;
}
