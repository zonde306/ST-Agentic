import { TraceLogger } from '@/core/logger';
import { createAbortError, isAbortError } from '@/core/tools';
import type {
    BackgroundTaskState,
    BackgroundTaskStatus,
    BarrierPolicy,
    MessageTarget,
    PipelinePhase,
} from '@/core/types';

export interface BarrierTaskDescriptor {
    taskId?: string;
    target: MessageTarget;
    phase: PipelinePhase;
    barrier: BarrierPolicy;
    agentProfileId: string;
    label: string;
    targetPath?: string;
    currentStep?: string;
    signal?: AbortSignal;
}

export interface BarrierTaskExecutionContext {
    readonly taskId: string;
    readonly target: MessageTarget;
    readonly signal: AbortSignal;
    setCurrentStep(step: string | undefined): void;
}

export interface DispatchedTaskHandle<T = unknown> {
    readonly taskId: string;
    readonly target: MessageTarget;
    readonly barrier: BarrierPolicy;
    readonly promise: Promise<T>;
    readonly controller: AbortController;
    getStatus(): BackgroundTaskStatus;
    cancel(reason?: string): boolean;
}

export interface BarrierTaskFilter {
    target?: Partial<MessageTarget>;
    messageId?: number;
    swipeId?: number;
    phase?: PipelinePhase;
    barrier?: BarrierPolicy;
    agentProfileId?: string;
    state?: BackgroundTaskState | readonly BackgroundTaskState[];
}

export interface BarrierCoordinatorOptions {
    traceLogger?: TraceLogger;
    maxRetainedTasks?: number;
}

interface InternalTaskRecord {
    status: BackgroundTaskStatus;
    controller: AbortController;
    promise: Promise<unknown>;
    targetPath?: string;
    finalized: boolean;
}

function cloneStatus(status: BackgroundTaskStatus): BackgroundTaskStatus {
    return {
        ...status,
        target: { ...status.target },
    };
}

function freezeTarget(target: MessageTarget): MessageTarget {
    if (
        !target
        || !Number.isInteger(target.messageId)
        || target.messageId < 0
        || !Number.isInteger(target.swipeId)
        || target.swipeId < 0
    ) {
        throw new Error(
            `Invalid MessageTarget { messageId: ${String(target?.messageId)}, swipeId: ${String(target?.swipeId)} }`,
        );
    }
    return Object.freeze({ messageId: target.messageId, swipeId: target.swipeId });
}

function racePredecessorsWithAbort(
    predecessors: readonly Promise<void>[],
    signal: AbortSignal,
    taskId: string,
): Promise<void> {
    if (signal.aborted) {
        return Promise.reject(
            signal.reason instanceof Error && isAbortError(signal.reason)
                ? signal.reason
                : createAbortError(`Task "${taskId}" aborted while queued`),
        );
    }

    if (predecessors.length === 0) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            reject(
                signal.reason instanceof Error && isAbortError(signal.reason)
                    ? signal.reason
                    : createAbortError(`Task "${taskId}" aborted while queued`),
            );
        };

        signal.addEventListener('abort', onAbort, { once: true });

        Promise.allSettled(predecessors).then(
            () => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    onAbort();
                } else {
                    resolve();
                }
            },
            () => {
                signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    onAbort();
                } else {
                    resolve();
                }
            },
        );
    });
}

function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) {
        return promise;
    }
    if (signal.aborted) {
        return Promise.reject(
            signal.reason instanceof Error && isAbortError(signal.reason)
                ? signal.reason
                : createAbortError('Barrier wait aborted'),
        );
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(
                signal.reason instanceof Error && isAbortError(signal.reason)
                    ? signal.reason
                    : createAbortError('Barrier wait aborted'),
            );
        };

        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            },
        );
    });
}

/**
 * Three-tier concurrency barrier coordinator enforcing causal `(messageId, swipeId)` branch safety:
 * - `'turn'`: blocks before the NEXT turn's `before_turn` via `awaitTurnBarriers()` (without locking UI immediately).
 * - `'self'`: FIFO serial queue keyed by `agentProfileId` (and `targetPath` when provided) that NEVER blocks next user turns.
 * - `'none'`: completely detached background execution with an independent per-task `AbortController`.
 */
export class BarrierCoordinator {
    private readonly traceLogger?: TraceLogger;
    private readonly maxRetainedTasks: number;
    private readonly tasks = new Map<string, InternalTaskRecord>();
    private readonly activeTurnTasks = new Map<string, Promise<unknown>>();
    private readonly selfQueueTails = new Map<string, Promise<void>>();
    private taskSequence = 0;

    constructor(options: BarrierCoordinatorOptions = {}) {
        this.traceLogger = options.traceLogger;
        this.maxRetainedTasks = Math.max(20, options.maxRetainedTasks ?? 200);
    }

    /**
     * Dispatch a task under its declared `barrier` policy (`'turn' | 'self' | 'none'`),
     * binding an immutable `target: { messageId, swipeId }` and dedicated `AbortController`.
     */
    dispatch<T>(
        descriptor: BarrierTaskDescriptor,
        executor: (ctx: BarrierTaskExecutionContext) => Promise<T>,
    ): DispatchedTaskHandle<T> {
        const target = freezeTarget(descriptor.target);
        this.taskSequence += 1;
        const taskId = descriptor.taskId?.trim() || `task_${target.messageId}_${target.swipeId}_${this.taskSequence}`;
        const controller = new AbortController();

        const externalSignal = descriptor.signal;
        const onExternalAbort = () => {
            this.abortRecord(record, 'Parent signal aborted');
        };
        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort(
                    externalSignal.reason instanceof Error && isAbortError(externalSignal.reason)
                        ? externalSignal.reason
                        : createAbortError(`Task "${taskId}" aborted before dispatch`),
                );
            } else {
                externalSignal.addEventListener('abort', onExternalAbort, { once: true });
            }
        }

        const queueKeys =
            descriptor.barrier === 'self'
                ? this.buildSelfQueueKeys(descriptor.agentProfileId, descriptor.targetPath)
                : [];
        const predecessors =
            descriptor.barrier === 'self'
                ? queueKeys
                    .map((k) => this.selfQueueTails.get(k))
                    .filter((p): p is Promise<void> => Boolean(p))
                : [];

        const initialState: BackgroundTaskState = controller.signal.aborted
            ? 'aborted'
            : descriptor.barrier === 'self' && predecessors.length > 0
                ? 'queued'
                : 'running';

        const now = Date.now();
        const status: BackgroundTaskStatus = {
            taskId,
            target: { ...target },
            phase: descriptor.phase,
            barrier: descriptor.barrier,
            agentProfileId: descriptor.agentProfileId,
            label: descriptor.label,
            state: initialState,
            startedAt: now,
            ...(initialState === 'aborted' ? { endedAt: now, error: 'Aborted' } : {}),
            ...(descriptor.currentStep ? { currentStep: descriptor.currentStep } : {}),
        };

        let resolveQueueTail!: () => void;
        const queueTailPromise = new Promise<void>((res) => {
            resolveQueueTail = res;
        });

        const record: InternalTaskRecord = {
            status,
            controller,
            promise: Promise.resolve(),
            ...(descriptor.targetPath ? { targetPath: descriptor.targetPath } : {}),
            finalized: initialState === 'aborted',
        };

        this.tasks.set(taskId, record);
        this.trimRetainedTasks();

        if (descriptor.barrier === 'self' && !controller.signal.aborted) {
            for (const key of queueKeys) {
                this.selfQueueTails.set(key, queueTailPromise);
            }
        }

        this.emitTaskUpdated(record.status);

        const execCtx: BarrierTaskExecutionContext = {
            taskId,
            target,
            signal: controller.signal,
            setCurrentStep: (step) => {
                if (record.finalized) {
                    return;
                }
                record.status.currentStep = step;
                this.emitTaskUpdated(record.status);
            },
        };

        const runPromise = (async (): Promise<T> => {
            try {
                if (controller.signal.aborted) {
                    throw controller.signal.reason instanceof Error && isAbortError(controller.signal.reason)
                        ? controller.signal.reason
                        : createAbortError(`Task "${taskId}" aborted`);
                }

                if (descriptor.barrier === 'self' && predecessors.length > 0) {
                    await racePredecessorsWithAbort(predecessors, controller.signal, taskId);
                    if (!record.finalized && record.status.state === 'queued') {
                        record.status.state = 'running';
                        this.emitTaskUpdated(record.status);
                    }
                }

                const result = await executor(execCtx);

                if (controller.signal.aborted) {
                    throw controller.signal.reason instanceof Error && isAbortError(controller.signal.reason)
                        ? controller.signal.reason
                        : createAbortError(`Task "${taskId}" aborted`);
                }

                this.finalizeRecord(record, 'completed');
                return result;
            } catch (error) {
                if (isAbortError(error) || controller.signal.aborted) {
                    this.finalizeRecord(record, 'aborted', error instanceof Error ? error.message : 'Aborted');
                    throw error instanceof Error && isAbortError(error)
                        ? error
                        : createAbortError(`Task "${taskId}" aborted`);
                }

                const msg = error instanceof Error ? error.message : String(error);
                this.finalizeRecord(record, 'error', msg);
                throw error;
            } finally {
                externalSignal?.removeEventListener('abort', onExternalAbort);
                this.activeTurnTasks.delete(taskId);
                if (descriptor.barrier === 'self') {
                    for (const key of queueKeys) {
                        if (this.selfQueueTails.get(key) === queueTailPromise) {
                            this.selfQueueTails.delete(key);
                        }
                    }
                    resolveQueueTail();
                }
            }
        })();

        // Prevent unhandled rejection noise when detached background tasks abort/error.
        runPromise.catch(() => {});

        record.promise = runPromise;

        if (descriptor.barrier === 'turn' && !record.finalized) {
            this.activeTurnTasks.set(taskId, runPromise);
        }

        return {
            taskId,
            target,
            barrier: descriptor.barrier,
            promise: runPromise,
            controller,
            getStatus: () => cloneStatus(record.status),
            cancel: (reason?: string) => this.cancelTask(taskId, reason),
        };
    }

    /**
     * Block before entering the next turn's `before_turn` until all pending/running
     * `'turn'`-barrier tasks settle. NEVER blocks on `'self'` or `'none'` tasks.
     */
    async awaitTurnBarriers(options: { signal?: AbortSignal } = {}): Promise<void> {
        while (this.activeTurnTasks.size > 0) {
            const batch = Array.from(this.activeTurnTasks.values());
            await waitWithAbort(Promise.allSettled(batch), options.signal);
        }
    }

    /** Wait for all currently active tasks matching an optional filter to settle. */
    async awaitAllSettled(filter?: BarrierTaskFilter): Promise<void> {
        const pending: Promise<unknown>[] = [];
        for (const record of this.tasks.values()) {
            if (!isActiveState(record.status.state)) {
                continue;
            }
            if (filter && !matchesFilter(record.status, filter)) {
                continue;
            }
            pending.push(record.promise);
        }
        if (pending.length > 0) {
            await Promise.allSettled(pending);
        }
    }

    getTask(taskId: string): BackgroundTaskStatus | undefined {
        const record = this.tasks.get(taskId);
        return record ? cloneStatus(record.status) : undefined;
    }

    listTasks(filter?: BarrierTaskFilter): BackgroundTaskStatus[] {
        const items: BackgroundTaskStatus[] = [];
        for (const record of this.tasks.values()) {
            if (filter && !matchesFilter(record.status, filter)) {
                continue;
            }
            items.push(cloneStatus(record.status));
        }
        return items;
    }

    hasActiveTasksForTarget(target: MessageTarget, excludeTaskId?: string): boolean {
        for (const record of this.tasks.values()) {
            if (excludeTaskId && record.status.taskId === excludeTaskId) {
                continue;
            }
            if (
                isActiveState(record.status.state)
                && record.status.target.messageId === target.messageId
                && record.status.target.swipeId === target.swipeId
            ) {
                return true;
            }
        }
        return false;
    }

    /** Cancel a single background task by ID without impacting sibling tasks or turns. */
    cancelTask(taskId: string, reason?: string): boolean {
        const record = this.tasks.get(taskId);
        if (!record || !isActiveState(record.status.state)) {
            return false;
        }
        return this.abortRecord(record, reason ?? `Task "${taskId}" cancelled`);
    }

    /** Abort all active tasks bound strictly to `(target.messageId, target.swipeId)`. */
    abortTarget(target: MessageTarget, reason?: string): number {
        let count = 0;
        for (const record of this.tasks.values()) {
            if (
                isActiveState(record.status.state)
                && record.status.target.messageId === target.messageId
                && record.status.target.swipeId === target.swipeId
            ) {
                if (this.abortRecord(record, reason ?? `Target ${target.messageId}#${target.swipeId} aborted`)) {
                    count += 1;
                }
            }
        }
        return count;
    }

    /** Abort all active tasks from `messageId` onwards (used on Regenerate / Delete). */
    abortFromMessage(messageId: number, reason?: string): number {
        let count = 0;
        for (const record of this.tasks.values()) {
            if (isActiveState(record.status.state) && record.status.target.messageId >= messageId) {
                if (this.abortRecord(record, reason ?? `Messages from #${messageId} aborted`)) {
                    count += 1;
                }
            }
        }
        return count;
    }

    /** Abort every active/queued task across all messages and barriers. */
    abortAll(reason?: string): number {
        let count = 0;
        for (const record of this.tasks.values()) {
            if (isActiveState(record.status.state)) {
                if (this.abortRecord(record, reason ?? 'All tasks aborted')) {
                    count += 1;
                }
            }
        }
        return count;
    }

    private buildSelfQueueKeys(agentProfileId: string, targetPath?: string): string[] {
        const keys = [`agent:${agentProfileId}`];
        const trimmedPath = targetPath?.trim();
        if (trimmedPath) {
            keys.push(`path:${trimmedPath}`);
        }
        return keys;
    }

    private abortRecord(record: InternalTaskRecord, reason: string): boolean {
        if (!isActiveState(record.status.state)) {
            return false;
        }
        this.finalizeRecord(record, 'aborted', reason);
        this.activeTurnTasks.delete(record.status.taskId);
        if (!record.controller.signal.aborted) {
            record.controller.abort(createAbortError(reason));
        }
        return true;
    }

    private finalizeRecord(
        record: InternalTaskRecord,
        state: 'completed' | 'aborted' | 'error',
        error?: string,
    ): void {
        if (record.finalized) {
            return;
        }
        record.finalized = true;
        record.status.state = state;
        record.status.endedAt = Date.now();
        if (error !== undefined) {
            record.status.error = error;
        } else {
            delete record.status.error;
        }
        this.emitTaskUpdated(record.status);
    }

    private emitTaskUpdated(status: BackgroundTaskStatus): void {
        this.traceLogger?.emit({
            kind: 'background_task_updated',
            target: { ...status.target },
            timestamp: Date.now(),
            phase: status.phase,
            agentProfileId: status.agentProfileId,
            task: cloneStatus(status),
            ...(status.error ? { error: status.error } : {}),
        });
    }

    private trimRetainedTasks(): void {
        if (this.tasks.size <= this.maxRetainedTasks) {
            return;
        }
        for (const [id, record] of this.tasks.entries()) {
            if (this.tasks.size <= this.maxRetainedTasks) {
                break;
            }
            if (!isActiveState(record.status.state)) {
                this.tasks.delete(id);
            }
        }
    }
}

function isActiveState(state: BackgroundTaskState): boolean {
    return state === 'queued' || state === 'running';
}

function matchesFilter(status: BackgroundTaskStatus, filter: BarrierTaskFilter): boolean {
    const msgId = filter.target?.messageId ?? filter.messageId;
    const swipeId = filter.target?.swipeId ?? filter.swipeId;

    if (msgId !== undefined && status.target.messageId !== msgId) {
        return false;
    }
    if (swipeId !== undefined && status.target.swipeId !== swipeId) {
        return false;
    }
    if (filter.phase !== undefined && status.phase !== filter.phase) {
        return false;
    }
    if (filter.barrier !== undefined && status.barrier !== filter.barrier) {
        return false;
    }
    if (filter.agentProfileId !== undefined && status.agentProfileId !== filter.agentProfileId) {
        return false;
    }
    if (filter.state !== undefined) {
        const states = Array.isArray(filter.state) ? filter.state : [filter.state];
        if (!states.includes(status.state)) {
            return false;
        }
    }
    return true;
}
