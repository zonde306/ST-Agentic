import type {
    AgentRunStatus,
    AgentRunTrace,
    GenerationEventPayload,
    MessageTarget,
    PipelinePhase,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';

export const DEFAULT_MAX_TRACES = 100;

export interface TraceLoggerOptions {
    /** Maximum number of runs retained in the ring buffer (default 100). */
    maxTraces?: number;
}

export interface TraceQueryFilter {
    target?: Partial<MessageTarget>;
    messageId?: number;
    swipeId?: number;
    phase?: PipelinePhase;
    agentProfileId?: string;
    status?: AgentRunStatus;
    runId?: string;
    limit?: number;
    /** Return newest runs first (`'desc'`, default) or oldest first (`'asc'`). */
    order?: 'desc' | 'asc';
}

export type GenerationEventListener = (event: GenerationEventPayload) => void;

function cloneTrace(trace: AgentRunTrace): AgentRunTrace {
    return canonicalClone(trace);
}

function cloneEvent(event: GenerationEventPayload): GenerationEventPayload {
    return canonicalClone(event);
}

/**
 * 100-run ring buffer storing `AgentRunTrace` records and providing a live
 * `GenerationEventPayload` pub-sub bus for streaming deltas, tool steps,
 * background task updates, and finalized traces.
 */
export class TraceLogger {
    private readonly maxTraces: number;
    private readonly traces: AgentRunTrace[] = [];
    private readonly listeners = new Set<GenerationEventListener>();

    constructor(options: TraceLoggerOptions = {}) {
        const rawMax = options.maxTraces ?? DEFAULT_MAX_TRACES;
        this.maxTraces = Number.isFinite(rawMax) && rawMax >= 1 ? Math.floor(rawMax) : DEFAULT_MAX_TRACES;
    }

    get capacity(): number {
        return this.maxTraces;
    }

    get size(): number {
        return this.traces.length;
    }

    /**
     * Record or update an `AgentRunTrace` in the ring buffer.
     * Evicts the oldest entry when capacity exceeds `maxTraces` (default 100).
     */
    recordTrace(trace: AgentRunTrace, emitEvent: boolean = true): AgentRunTrace {
        const snapshot = cloneTrace(trace);
        const existingIndex = this.traces.findIndex((item) => item.runId === snapshot.runId);

        if (existingIndex >= 0) {
            this.traces[existingIndex] = snapshot;
        } else {
            this.traces.push(snapshot);
            while (this.traces.length > this.maxTraces) {
                this.traces.shift();
            }
        }

        if (emitEvent) {
            this.emit({
                kind: 'trace_recorded',
                target: { ...snapshot.target },
                timestamp: snapshot.endedAt ?? snapshot.startedAt ?? Date.now(),
                phase: snapshot.phase,
                runId: snapshot.runId,
                agentProfileId: snapshot.agentProfileId,
                trace: cloneTrace(snapshot),
                ...(snapshot.error ? { error: snapshot.error } : {}),
            });
        }

        return cloneTrace(snapshot);
    }

    /** Retrieve a stored `AgentRunTrace` by `runId`, if still within the ring buffer. */
    getTrace(runId: string): AgentRunTrace | undefined {
        const found = this.traces.find((item) => item.runId === runId);
        return found ? cloneTrace(found) : undefined;
    }

    /**
     * Query traces filtered by `target` (`messageId` / `swipeId`), `phase`,
     * `agentProfileId`, `status`, or `runId`.
     */
    listTraces(filter: TraceQueryFilter = {}): AgentRunTrace[] {
        const targetMessageId = filter.target?.messageId ?? filter.messageId;
        const targetSwipeId = filter.target?.swipeId ?? filter.swipeId;

        const matched = this.traces.filter((item) => {
            if (targetMessageId !== undefined && item.target.messageId !== targetMessageId) {
                return false;
            }
            if (targetSwipeId !== undefined && item.target.swipeId !== targetSwipeId) {
                return false;
            }
            if (filter.phase !== undefined && item.phase !== filter.phase) {
                return false;
            }
            if (filter.agentProfileId !== undefined && item.agentProfileId !== filter.agentProfileId) {
                return false;
            }
            if (filter.status !== undefined && item.status !== filter.status) {
                return false;
            }
            if (filter.runId !== undefined && item.runId !== filter.runId) {
                return false;
            }
            return true;
        });

        const ordered = filter.order === 'asc' ? matched : [...matched].reverse();
        const sliced =
            filter.limit !== undefined && filter.limit >= 0
                ? ordered.slice(0, filter.limit)
                : ordered;

        return sliced.map(cloneTrace);
    }

    /** Publish a live `GenerationEventPayload` to all subscribers (fault-tolerant). */
    emit(event: GenerationEventPayload): void {
        if (this.listeners.size === 0) {
            return;
        }
        const payload = cloneEvent(event);
        for (const listener of Array.from(this.listeners)) {
            try {
                listener(payload);
            } catch {
                // Keep event bus resilient against subscriber exceptions.
            }
        }
    }

    /** Subscribe to live `GenerationEventPayload` notifications. */
    subscribe(listener: GenerationEventListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Clear all traces or only traces matching an optional message/target filter. */
    clear(filter?: { target?: Partial<MessageTarget>; messageId?: number }): void {
        if (!filter || (filter.target === undefined && filter.messageId === undefined)) {
            this.traces.length = 0;
            return;
        }

        const msgId = filter.target?.messageId ?? filter.messageId;
        const swipeId = filter.target?.swipeId;

        for (let i = this.traces.length - 1; i >= 0; i -= 1) {
            const item = this.traces[i];
            const msgMatch = msgId === undefined || item.target.messageId === msgId;
            const swipeMatch = swipeId === undefined || item.target.swipeId === swipeId;
            if (msgMatch && swipeMatch) {
                this.traces.splice(i, 1);
            }
        }
    }
}
