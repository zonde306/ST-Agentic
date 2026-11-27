import type { MessageTarget } from '../types';
import type { HostBridge } from './host-bridge';
import type { PromptTransformErrorEntry } from './prompt-transform';
import type {
    ToolEphemeralMessagesApi,
    ToolEventPayload,
    ToolPostprocessControl,
    ToolPostprocessOutput,
} from './tool-context';

export type MessageHookRunnerKind = 'agent' | 'assistant' | 'sidegen';

export interface PromptPreprocessLayerIndices {
    readonly layer0End: number;
    readonly layer1End: number;
    readonly turnStart: number;
    readonly floatingTailStart: number;
}

export interface PromptPreprocessHookMeta {
    readonly runner: MessageHookRunnerKind;
    readonly runId: string;
    readonly phase?: string;
    readonly agentId?: string;
    readonly agentName?: string;
    readonly triggerId?: string;
    readonly target?: MessageTarget;
    readonly messageId?: number;
    readonly swipeId?: number;
    readonly round: number;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly model?: string;
    readonly connectionId?: string;
    readonly providerFormat?: string;
    readonly vars?: Readonly<Record<string, unknown>>;
}

export interface PromptPreprocessHookPayload {
    /** Safe ephemeral message controller (`list`/`set`/`rollbackToolRounds`/`dropHistoryTurns`/`replaceContent`/`appendHint`/`toMessages`). */
    readonly messages: ToolEphemeralMessagesApi;
    /** Mutable request body parameter overrides applied only to the current LLM attempt. */
    readonly body: Record<string, unknown>;
    /** Current layer boundary indices (updates dynamically when `messages` drops/rolls back turns). */
    readonly layers: PromptPreprocessLayerIndices;
    /** Canonical event snapshot (`type: 'prompt_preprocess'`). */
    readonly event: ToolEventPayload;
    /** Run metadata aligned with `agentic_prompt_transform` / `agentic_output_process`. */
    readonly meta: PromptPreprocessHookMeta;
    readonly signal?: AbortSignal;
    readonly errors: PromptTransformErrorEntry[];
    reportError(error: unknown, extId?: string): void;
}

export type PromptPreprocessListener = (
    payload: PromptPreprocessHookPayload,
) => void | Promise<void>;

export interface OutputPostprocessHookMeta {
    readonly runner: MessageHookRunnerKind;
    readonly runId: string;
    readonly phase?: string;
    readonly agentId?: string;
    readonly agentName?: string;
    readonly triggerId?: string;
    readonly target?: MessageTarget;
    readonly messageId?: number;
    readonly swipeId?: number;
    readonly round: number;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly fixAttempt: number;
    readonly maxFixAttempts: number;
    readonly model?: string;
    readonly connectionId?: string;
    readonly providerFormat?: string;
    readonly finishReason?: string;
    readonly vars?: Readonly<Record<string, unknown>>;
}

export interface OutputPostprocessHookPayload {
    /** Mutable per-round LLM response (`text`, `content`, `reasoningContent`, `toolCalls`, readonly `originalText`). */
    readonly output: ToolPostprocessOutput;
    /** Monotonic flow control (`abort` > `retry` > `fix` > `accept`). */
    readonly control: ToolPostprocessControl;
    /** Canonical event snapshot (`type: 'output_postprocess'`). */
    readonly event: ToolEventPayload;
    /** Run metadata aligned with `agentic_prompt_transform` / `agentic_output_process`. */
    readonly meta: OutputPostprocessHookMeta;
    readonly signal?: AbortSignal;
    readonly errors: PromptTransformErrorEntry[];
    reportError(error: unknown, extId?: string): void;
}

export type OutputPostprocessListener = (
    payload: OutputPostprocessHookPayload,
) => void | Promise<void>;

function isAbortLikeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const name = (error as { name?: unknown }).name;
    return name === 'AbortError';
}

function toNormalizedError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function normalizeOptionalExtId(extId?: string): string | undefined {
    if (typeof extId !== 'string') {
        return undefined;
    }
    const trimmed = extId.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

export interface CreatePromptPreprocessPayloadInput {
    messages: ToolEphemeralMessagesApi;
    body: Record<string, unknown>;
    layers: PromptPreprocessLayerIndices;
    getLayers?: () => PromptPreprocessLayerIndices;
    event: ToolEventPayload;
    meta: PromptPreprocessHookMeta;
    signal?: AbortSignal;
}

/**
 * Build the mutable payload passed to `agentic_prompt_preprocess` `eventSource` listeners.
 */
export function createPromptPreprocessPayload(
    input: CreatePromptPreprocessPayloadInput,
): PromptPreprocessHookPayload {
    const errors: PromptTransformErrorEntry[] = [];
    const getLayers = input.getLayers;
    const staticLayers = { ...input.layers };
    const resolvedTarget: MessageTarget | undefined =
        input.meta.target
        ?? (input.meta.messageId !== undefined && input.meta.swipeId !== undefined
            ? { messageId: input.meta.messageId, swipeId: input.meta.swipeId }
            : undefined);
    const resolvedMessageId = input.meta.messageId ?? resolvedTarget?.messageId;
    const resolvedSwipeId = input.meta.swipeId ?? resolvedTarget?.swipeId;

    const payload: PromptPreprocessHookPayload = {
        messages: input.messages,
        body: input.body,
        get layers(): PromptPreprocessLayerIndices {
            return getLayers ? { ...getLayers() } : { ...staticLayers };
        },
        event: input.event,
        meta: {
            ...input.meta,
            ...(resolvedTarget ? { target: { ...resolvedTarget } } : {}),
            ...(resolvedMessageId !== undefined ? { messageId: resolvedMessageId } : {}),
            ...(resolvedSwipeId !== undefined ? { swipeId: resolvedSwipeId } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
        errors,
        reportError(error: unknown, extId?: string) {
            const cleanExtId = normalizeOptionalExtId(extId);
            errors.push({
                ...(cleanExtId ? { extId: cleanExtId } : {}),
                error: toNormalizedError(error),
            });
        },
    };

    return payload;
}

export interface CreateOutputPostprocessPayloadInput {
    output: ToolPostprocessOutput;
    control: ToolPostprocessControl;
    event: ToolEventPayload;
    meta: OutputPostprocessHookMeta;
    signal?: AbortSignal;
}

/**
 * Build the mutable payload passed to `agentic_output_postprocess` `eventSource` listeners.
 */
export function createOutputPostprocessPayload(
    input: CreateOutputPostprocessPayloadInput,
): OutputPostprocessHookPayload {
    const errors: PromptTransformErrorEntry[] = [];
    const resolvedTarget: MessageTarget | undefined =
        input.meta.target
        ?? (input.meta.messageId !== undefined && input.meta.swipeId !== undefined
            ? { messageId: input.meta.messageId, swipeId: input.meta.swipeId }
            : undefined);
    const resolvedMessageId = input.meta.messageId ?? resolvedTarget?.messageId;
    const resolvedSwipeId = input.meta.swipeId ?? resolvedTarget?.swipeId;

    return {
        output: input.output,
        control: input.control,
        event: input.event,
        meta: {
            ...input.meta,
            ...(resolvedTarget ? { target: { ...resolvedTarget } } : {}),
            ...(resolvedMessageId !== undefined ? { messageId: resolvedMessageId } : {}),
            ...(resolvedSwipeId !== undefined ? { swipeId: resolvedSwipeId } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
        errors,
        reportError(error: unknown, extId?: string) {
            const cleanExtId = normalizeOptionalExtId(extId);
            errors.push({
                ...(cleanExtId ? { extId: cleanExtId } : {}),
                error: toNormalizedError(error),
            });
        },
    };
}

/**
 * Invoke `bridge.preprocessPromptMessages` safely: propagates `AbortError` while isolating
 * non-fatal external extension errors inside `payload.errors`.
 */
export async function runPromptPreprocessHook(
    bridge: Pick<HostBridge, 'preprocessPromptMessages' | 'hasPromptPreprocessListeners'>,
    payload: PromptPreprocessHookPayload,
): Promise<void> {
    if (!bridge.preprocessPromptMessages) {
        return;
    }
    if (bridge.hasPromptPreprocessListeners && !bridge.hasPromptPreprocessListeners()) {
        return;
    }
    try {
        await bridge.preprocessPromptMessages(payload);
    } catch (error) {
        if (isAbortLikeError(error) || payload.signal?.aborted) {
            throw error;
        }
        payload.reportError(error);
    }
}

/**
 * Invoke `bridge.postprocessOutputResponse` safely: propagates `AbortError` while isolating
 * non-fatal external extension errors inside `payload.errors`.
 */
export async function runOutputPostprocessHook(
    bridge: Pick<HostBridge, 'postprocessOutputResponse' | 'hasOutputPostprocessListeners'>,
    payload: OutputPostprocessHookPayload,
): Promise<void> {
    if (!bridge.postprocessOutputResponse) {
        return;
    }
    if (bridge.hasOutputPostprocessListeners && !bridge.hasOutputPostprocessListeners()) {
        return;
    }
    try {
        await bridge.postprocessOutputResponse(payload);
    } catch (error) {
        if (isAbortLikeError(error) || payload.signal?.aborted) {
            throw error;
        }
        payload.reportError(error);
    }
}
