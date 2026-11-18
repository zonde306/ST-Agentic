import type { HostBridge } from '@/core/bridge';
import { DEFAULT_MAIN_AGENT_ID } from '@/core/config';
import {
    type BranchKey,
    type CanonicalMessage,
    type CanonicalToolSchema,
    type MessageTarget,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';

/** Metadata key where `TrajectoryStore` persists causal agent trajectories. */
export const AGENTIC_TRAJECTORIES_KEY = 'agentic_trajectories';

/** Frozen Layer 0 static prefix cached once per persistent agent session. */
export interface FrozenStaticPrefix {
    tools: readonly CanonicalToolSchema[];
    messages: readonly CanonicalMessage[];
    layer0EndIndex: number;
}

/** Causal branch checkpoint bound to a `(messageId, swipeId)` coordinate. */
export interface BranchCheckpoint {
    messageCount: number;
    readSetSnapshot: Map<string, string>;
    archivedUpToChunk: number;
    /** Turn-end message counts within Layer 1 at this checkpoint. */
    turnEndCounts: number[];
    /** Number of compaction summary/index messages at Layer 1 head. */
    compactionHeaderCount: number;
    /** Immutable snapshot of messages at this branch for lossless swipe switching. */
    messagesSnapshot?: readonly CanonicalMessage[];
}

export interface CompactionUpdateInput {
    compactedMessages: readonly CanonicalMessage[];
    archivedUpToChunk: number;
    evictedPaths?: Iterable<string>;
    compactionHeaderCount?: number;
    turnEndCounts?: readonly number[];
}

export interface SerializedBranchCheckpoint {
    messageCount: number;
    readSetSnapshot: Record<string, string>;
    archivedUpToChunk: number;
    turnEndCounts: number[];
    compactionHeaderCount: number;
    messageIndices?: number[];
}

export interface SerializedAgentTrajectory {
    agentId: string;
    messagePool: CanonicalMessage[];
    activeMessageIndices: number[];
    readSet: Record<string, string>;
    archivedUpToChunk: number;
    turnEndCounts: number[];
    compactionHeaderCount: number;
    checkpoints: Record<string, SerializedBranchCheckpoint>;
    frozenPrefix?: {
        tools: CanonicalToolSchema[];
        messages: CanonicalMessage[];
        layer0EndIndex: number;
    } | null;
}

export interface SerializedTrajectoryStore {
    version: 1;
    threads: Record<string, SerializedAgentTrajectory>;
}

interface InternalTrajectoryState {
    agentId: string;
    messages: CanonicalMessage[];
    readSet: Map<string, string>;
    checkpoints: Map<BranchKey, BranchCheckpoint>;
    archivedUpToChunk: number;
    turnEndCounts: number[];
    compactionHeaderCount: number;
    frozenPrefix: FrozenStaticPrefix | null;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        if (Array.isArray(value)) {
            for (const item of value) {
                deepFreeze(item);
            }
        } else {
            for (const propVal of Object.values(value as Record<string, unknown>)) {
                deepFreeze(propVal);
            }
        }
        Object.freeze(value);
    }
    return value;
}

/** Clone and deeply freeze a `CanonicalMessage` so Layer 1 entries remain immutable. */
export function freezeCanonicalMessage(message: CanonicalMessage): CanonicalMessage {
    return deepFreeze(canonicalClone(message));
}

/** Clone and deeply freeze a `FrozenStaticPrefix`. */
export function freezeStaticPrefix(prefix: FrozenStaticPrefix): FrozenStaticPrefix {
    return deepFreeze({
        tools: canonicalClone(prefix.tools),
        messages: canonicalClone(prefix.messages),
        layer0EndIndex: prefix.layer0EndIndex,
    });
}

function messagesPrefixMatches(
    current: readonly CanonicalMessage[],
    snapshot: readonly CanonicalMessage[] | undefined,
    count: number,
): boolean {
    if (!snapshot || snapshot.length < count || current.length < count) {
        return false;
    }
    for (let i = 0; i < count; i += 1) {
        if (current[i] === snapshot[i]) {
            continue;
        }
        if (canonicalStringify(current[i]) !== canonicalStringify(snapshot[i])) {
            return false;
        }
    }
    return true;
}

function createEmptyThreadState(agentId: string): InternalTrajectoryState {
    return {
        agentId,
        messages: [],
        readSet: new Map<string, string>(),
        checkpoints: new Map<BranchKey, BranchCheckpoint>(),
        archivedUpToChunk: 0,
        turnEndCounts: [],
        compactionHeaderCount: 0,
        frozenPrefix: null,
    };
}

function normalizeTurnEndCounts(
    rawCounts: readonly number[],
    compactionHeaderCount: number,
    maxCount: number,
): number[] {
    const valid: number[] = [];
    let prev = compactionHeaderCount;
    for (const count of rawCounts) {
        if (Number.isInteger(count) && count > prev && count <= maxCount) {
            valid.push(count);
            prev = count;
        }
    }
    return valid;
}

/**
 * Per-persistent-agent immutable append-only trajectory store with `Read-Set`
 * tracking and `(messageId, swipeId)` causal branch checkpoints.
 */
export class TrajectoryStore {
    private readonly threads = new Map<string, InternalTrajectoryState>();

    constructor(initial?: SerializedTrajectoryStore) {
        if (initial && initial.version === 1 && initial.threads) {
            for (const [agentId, rawThread] of Object.entries(initial.threads)) {
                this.threads.set(agentId, deserializeThread(agentId, rawThread));
            }
        }
    }

    /** Ensure a trajectory thread exists for `agentId`. */
    ensureThread(agentId: string = DEFAULT_MAIN_AGENT_ID): void {
        if (!this.threads.has(agentId)) {
            this.threads.set(agentId, createEmptyThreadState(agentId));
        }
    }

    /** Check whether a trajectory thread exists for `agentId`. */
    hasThread(agentId: string = DEFAULT_MAIN_AGENT_ID): boolean {
        return this.threads.has(agentId);
    }

    /** List all registered persistent thread IDs in deterministic order. */
    listAgentIds(): string[] {
        return Array.from(this.threads.keys()).sort();
    }

    /** Return an immutable view of Layer 1 messages for `agentId`. */
    getMessages(agentId: string = DEFAULT_MAIN_AGENT_ID): readonly CanonicalMessage[] {
        const state = this.threads.get(agentId);
        return state ? [...state.messages] : [];
    }

    /** Return current Layer 1 message count for `agentId`. */
    getMessageCount(agentId: string = DEFAULT_MAIN_AGENT_ID): number {
        return this.threads.get(agentId)?.messages.length ?? 0;
    }

    /** Return a defensive copy of the current `Read-Set` (`path -> xxHash`) for `agentId`. */
    getReadSet(agentId: string = DEFAULT_MAIN_AGENT_ID): Map<string, string> {
        const state = this.threads.get(agentId);
        return state ? new Map(state.readSet) : new Map();
    }

    /** Replace the current `Read-Set` for `agentId`. */
    setReadSet(
        entries: ReadonlyMap<string, string> | Record<string, string>,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        const state = this.getOrCreateThread(agentId);
        state.readSet.clear();
        if (entries instanceof Map) {
            for (const [path, hash] of entries.entries()) {
                state.readSet.set(path, hash);
            }
        } else {
            for (const [path, hash] of Object.entries(entries)) {
                state.readSet.set(path, hash);
            }
        }
    }

    /** Record a VFS path and its rendered `xxHash` in the thread's `Read-Set`. */
    markRead(
        path: string,
        contentHash: string,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        const state = this.getOrCreateThread(agentId);
        state.readSet.set(path, contentHash);
    }

    /** Batch-record read paths into the thread's `Read-Set`. */
    markManyRead(
        entries: Iterable<[string, string]> | Record<string, string>,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        const state = this.getOrCreateThread(agentId);
        if (Symbol.iterator in Object(entries)) {
            for (const [path, hash] of entries as Iterable<[string, string]>) {
                state.readSet.set(path, hash);
            }
        } else {
            for (const [path, hash] of Object.entries(entries as Record<string, string>)) {
                state.readSet.set(path, hash);
            }
        }
    }

    /** Evict specific paths from the thread's `Read-Set`, returning evicted paths. */
    evictReadPaths(
        paths: Iterable<string>,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): string[] {
        const state = this.threads.get(agentId);
        if (!state) {
            return [];
        }

        const evicted: string[] = [];
        for (const path of paths) {
            if (state.readSet.delete(path)) {
                evicted.push(path);
            }
        }
        return evicted;
    }

    /** Highest archived chunk number (`/history/chunk-NNN.md`) for `agentId`. */
    getArchivedUpToChunk(agentId: string = DEFAULT_MAIN_AGENT_ID): number {
        return this.threads.get(agentId)?.archivedUpToChunk ?? 0;
    }

    /** Current turn-end message counts within Layer 1 for `agentId`. */
    getTurnEndCounts(agentId: string = DEFAULT_MAIN_AGENT_ID): readonly number[] {
        const state = this.threads.get(agentId);
        return state ? [...state.turnEndCounts] : [];
    }

    /** Number of compaction header messages currently sitting at Layer 1 head. */
    getCompactionHeaderCount(agentId: string = DEFAULT_MAIN_AGENT_ID): number {
        return this.threads.get(agentId)?.compactionHeaderCount ?? 0;
    }

    /** Retrieve the frozen Layer 0 static prefix cached for `agentId`, if any. */
    getFrozenPrefix(agentId: string = DEFAULT_MAIN_AGENT_ID): FrozenStaticPrefix | null {
        return this.threads.get(agentId)?.frozenPrefix ?? null;
    }

    /** Store or clear the frozen Layer 0 static prefix for `agentId`. */
    setFrozenPrefix(
        prefix: FrozenStaticPrefix | null,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        const state = this.getOrCreateThread(agentId);
        state.frozenPrefix = prefix ? freezeStaticPrefix(prefix) : null;
    }

    /**
     * Append finalized messages to Layer 1 without mutating any existing element.
     * Records a turn-end checkpoint boundary at the resulting Layer 1 length.
     */
    appendMessages(
        messages: readonly CanonicalMessage[],
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        if (messages.length === 0) {
            return;
        }
        const state = this.getOrCreateThread(agentId);
        for (const msg of messages) {
            state.messages.push(freezeCanonicalMessage(msg));
        }
        const newEnd = state.messages.length;
        const lastBoundary = state.turnEndCounts[state.turnEndCounts.length - 1] ?? state.compactionHeaderCount;
        if (newEnd > lastBoundary) {
            state.turnEndCounts.push(newEnd);
        }
    }

    /** Alias for `appendMessages` emphasizing turn-level append semantics. */
    appendTurn(
        messages: readonly CanonicalMessage[],
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        this.appendMessages(messages, agentId);
    }

    /**
     * Atomically apply High-Watermark compaction results to Layer 1 and evict
     * archived/folded paths from `Read-Set`. Only `WatermarkCompactor` should call this.
     */
    applyCompaction(
        update: CompactionUpdateInput,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): string[] {
        const state = this.getOrCreateThread(agentId);
        const frozenCompacted = update.compactedMessages.map(freezeCanonicalMessage);
        const headerCount = Math.max(0, Math.min(frozenCompacted.length, update.compactionHeaderCount ?? 0));

        state.messages = frozenCompacted;
        state.archivedUpToChunk = Math.max(state.archivedUpToChunk, update.archivedUpToChunk);
        state.compactionHeaderCount = headerCount;
        state.turnEndCounts = update.turnEndCounts
            ? normalizeTurnEndCounts(update.turnEndCounts, headerCount, frozenCompacted.length)
            : (frozenCompacted.length > headerCount ? [frozenCompacted.length] : []);

        if (update.evictedPaths) {
            return this.evictReadPaths(update.evictedPaths, agentId);
        }
        return [];
    }

    /** Record an immutable branch checkpoint bound to `(messageId, swipeId)`. */
    recordCheckpoint(
        target: MessageTarget,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): BranchCheckpoint {
        assertValidTarget(target);
        const state = this.getOrCreateThread(agentId);
        const key = toBranchKey(target);

        const checkpoint: BranchCheckpoint = {
            messageCount: state.messages.length,
            readSetSnapshot: new Map(state.readSet),
            archivedUpToChunk: state.archivedUpToChunk,
            turnEndCounts: [...state.turnEndCounts],
            compactionHeaderCount: state.compactionHeaderCount,
            messagesSnapshot: [...state.messages],
        };

        state.checkpoints.set(key, checkpoint);
        return cloneCheckpoint(checkpoint);
    }

    /** Read a recorded branch checkpoint for `target`. */
    getCheckpoint(
        target: MessageTarget,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): BranchCheckpoint | undefined {
        const state = this.threads.get(agentId);
        const cp = state?.checkpoints.get(toBranchKey(target));
        return cp ? cloneCheckpoint(cp) : undefined;
    }

    /** List all recorded checkpoints for `agentId`. */
    listCheckpoints(agentId: string = DEFAULT_MAIN_AGENT_ID): Map<BranchKey, BranchCheckpoint> {
        const state = this.threads.get(agentId);
        const result = new Map<BranchKey, BranchCheckpoint>();
        if (!state) {
            return result;
        }
        for (const [key, cp] of state.checkpoints.entries()) {
            result.set(key, cloneCheckpoint(cp));
        }
        return result;
    }

    /**
     * Non-destructively restore the active trajectory to a recorded `target` checkpoint.
     * Preserves common prefix messages untouched and keeps sibling branch checkpoints intact.
     */
    restoreBranch(
        target: MessageTarget,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): boolean {
        assertValidTarget(target);
        const state = this.threads.get(agentId);
        if (!state) {
            return false;
        }

        const cp = state.checkpoints.get(toBranchKey(target));
        if (!cp) {
            return false;
        }

        if (
            state.archivedUpToChunk === cp.archivedUpToChunk
            && state.messages.length >= cp.messageCount
            && (!cp.messagesSnapshot || messagesPrefixMatches(state.messages, cp.messagesSnapshot, cp.messageCount))
        ) {
            state.messages = state.messages.slice(0, cp.messageCount);
        } else if (cp.messagesSnapshot) {
            state.messages = cp.messagesSnapshot.slice(0, cp.messageCount);
        } else {
            state.messages = state.messages.slice(0, Math.min(state.messages.length, cp.messageCount));
        }

        state.readSet = new Map(cp.readSetSnapshot);
        state.archivedUpToChunk = cp.archivedUpToChunk;
        state.compactionHeaderCount = cp.compactionHeaderCount;
        state.turnEndCounts = normalizeTurnEndCounts(
            cp.turnEndCounts,
            cp.compactionHeaderCount,
            state.messages.length,
        );
        return true;
    }

    /**
     * Roll back trajectory state to the latest checkpoint strictly before `messageId`.
     * Used on Swipe (when switching to an uncheckpointed swipe) and Regenerate.
     * Resets to empty Layer 1 when no earlier checkpoint exists.
     */
    restoreBeforeMessage(
        messageId: number,
        agentId: string = DEFAULT_MAIN_AGENT_ID,
        swipeLookup?: (msgId: number) => number,
    ): boolean {
        if (!Number.isInteger(messageId) || messageId < 0) {
            throw new Error(`Invalid messageId for restoreBeforeMessage: ${String(messageId)}`);
        }

        const state = this.threads.get(agentId);
        if (!state) {
            return false;
        }

        const bestTarget = findLatestCheckpointBefore(state.checkpoints, messageId, swipeLookup);
        if (bestTarget) {
            return this.restoreBranch(bestTarget, agentId);
        }

        state.messages = [];
        state.readSet.clear();
        state.archivedUpToChunk = 0;
        state.compactionHeaderCount = 0;
        state.turnEndCounts = [];
        return true;
    }

    /**
     * Permanently prune all checkpoints for `messageId` and all subsequent messages
     * (across all swipes), then roll active state back to before `messageId`.
     * If `agentId` is omitted, prunes every persistent thread in the store.
     */
    pruneFromMessage(messageId: number, agentId?: string): number {
        if (!Number.isInteger(messageId) || messageId < 0) {
            throw new Error(`Invalid messageId for pruneFromMessage: ${String(messageId)}`);
        }

        const targetIds = agentId !== undefined ? [agentId] : Array.from(this.threads.keys());
        let removedCount = 0;

        for (const id of targetIds) {
            const state = this.threads.get(id);
            if (!state) {
                continue;
            }

            let removedInThread = 0;
            for (const key of Array.from(state.checkpoints.keys())) {
                const parsed = parseBranchKey(key);
                if (parsed && parsed.messageId >= messageId) {
                    state.checkpoints.delete(key);
                    removedInThread += 1;
                }
            }

            removedCount += removedInThread;
            this.restoreBeforeMessage(messageId, id);
        }

        return removedCount;
    }

    /** Remove a single `(messageId, swipeId)` checkpoint (for `agentId`, or all threads if omitted). */
    pruneSwipe(target: MessageTarget, agentId?: string): number {
        assertValidTarget(target);
        const branchKey = toBranchKey(target);
        const targetIds = agentId !== undefined ? [agentId] : Array.from(this.threads.keys());
        let removedCount = 0;

        for (const id of targetIds) {
            const state = this.threads.get(id);
            if (state?.checkpoints.delete(branchKey)) {
                removedCount += 1;
            }
        }

        return removedCount;
    }

    /** Clear a persistent thread completely (including frozen Layer 0 prefix). */
    clearThread(agentId: string = DEFAULT_MAIN_AGENT_ID): void {
        this.threads.delete(agentId);
    }

    /** Serialize all persistent threads with deduplicated message pools for metadata persistence. */
    serialize(): SerializedTrajectoryStore {
        const threads: Record<string, SerializedAgentTrajectory> = {};

        for (const [agentId, state] of this.threads.entries()) {
            threads[agentId] = serializeThread(state);
        }

        return {
            version: 1,
            threads,
        };
    }

    /** Restore a `TrajectoryStore` from a serialized snapshot. */
    static deserialize(raw: unknown): TrajectoryStore {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return new TrajectoryStore();
        }
        const record = raw as Partial<SerializedTrajectoryStore>;
        if (record.version !== 1 || !record.threads || typeof record.threads !== 'object') {
            return new TrajectoryStore();
        }
        return new TrajectoryStore(record as SerializedTrajectoryStore);
    }

    /** Persist trajectory state to `HostBridge.getMetadata()` and trigger debounced save. */
    saveToHost(bridge: HostBridge, metadataKey: string = AGENTIC_TRAJECTORIES_KEY): void {
        const metadata = bridge.getMetadata();
        metadata[metadataKey] = this.serialize();
        bridge.saveChatDebounced();
    }

    /** Load trajectory state from `HostBridge.getMetadata()`. */
    static loadFromHost(
        bridge: HostBridge,
        metadataKey: string = AGENTIC_TRAJECTORIES_KEY,
    ): TrajectoryStore {
        const metadata = bridge.getMetadata();
        return TrajectoryStore.deserialize(metadata?.[metadataKey]);
    }

    private getOrCreateThread(agentId: string): InternalTrajectoryState {
        let state = this.threads.get(agentId);
        if (!state) {
            state = createEmptyThreadState(agentId);
            this.threads.set(agentId, state);
        }
        return state;
    }
}

function assertValidTarget(target: MessageTarget): void {
    if (
        !Number.isInteger(target.messageId)
        || target.messageId < 0
        || !Number.isInteger(target.swipeId)
        || target.swipeId < 0
    ) {
        throw new Error(
            `Invalid MessageTarget { messageId: ${String(target.messageId)}, swipeId: ${String(target.swipeId)} }`,
        );
    }
}

function cloneCheckpoint(cp: BranchCheckpoint): BranchCheckpoint {
    return {
        messageCount: cp.messageCount,
        readSetSnapshot: new Map(cp.readSetSnapshot),
        archivedUpToChunk: cp.archivedUpToChunk,
        turnEndCounts: [...cp.turnEndCounts],
        compactionHeaderCount: cp.compactionHeaderCount,
        ...(cp.messagesSnapshot ? { messagesSnapshot: [...cp.messagesSnapshot] } : {}),
    };
}

function findLatestCheckpointBefore(
    checkpoints: ReadonlyMap<BranchKey, BranchCheckpoint>,
    messageId: number,
    swipeLookup?: (msgId: number) => number,
): MessageTarget | null {
    let bestMsgId = -1;
    const candidatesAtBest: MessageTarget[] = [];

    for (const key of checkpoints.keys()) {
        const parsed = parseBranchKey(key);
        if (!parsed || parsed.messageId >= messageId) {
            continue;
        }
        if (parsed.messageId > bestMsgId) {
            bestMsgId = parsed.messageId;
            candidatesAtBest.length = 0;
            candidatesAtBest.push(parsed);
        } else if (parsed.messageId === bestMsgId) {
            candidatesAtBest.push(parsed);
        }
    }

    if (candidatesAtBest.length === 0) {
        return null;
    }

    if (swipeLookup) {
        const preferredSwipe = swipeLookup(bestMsgId);
        const exact = candidatesAtBest.find((c) => c.swipeId === preferredSwipe);
        if (exact) {
            return exact;
        }
    }

    candidatesAtBest.sort((a, b) => b.swipeId - a.swipeId);
    return candidatesAtBest[0];
}

function serializeThread(state: InternalTrajectoryState): SerializedAgentTrajectory {
    const pool: CanonicalMessage[] = [];
    const refMap = new Map<CanonicalMessage, number>();
    const hashMap = new Map<string, number>();

    const internMessage = (msg: CanonicalMessage): number => {
        const byRef = refMap.get(msg);
        if (byRef !== undefined) {
            return byRef;
        }
        const digest = canonicalStringify(msg);
        const byHash = hashMap.get(digest);
        if (byHash !== undefined) {
            refMap.set(msg, byHash);
            return byHash;
        }
        const index = pool.length;
        pool.push(canonicalClone(msg));
        refMap.set(msg, index);
        hashMap.set(digest, index);
        return index;
    };

    const activeMessageIndices = state.messages.map(internMessage);

    const checkpoints: Record<string, SerializedBranchCheckpoint> = {};
    for (const [key, cp] of state.checkpoints.entries()) {
        const readSetObj: Record<string, string> = {};
        for (const [path, hash] of Array.from(cp.readSetSnapshot.entries()).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
        )) {
            readSetObj[path] = hash;
        }
        checkpoints[key] = {
            messageCount: cp.messageCount,
            readSetSnapshot: readSetObj,
            archivedUpToChunk: cp.archivedUpToChunk,
            turnEndCounts: [...cp.turnEndCounts],
            compactionHeaderCount: cp.compactionHeaderCount,
            ...(cp.messagesSnapshot
                ? { messageIndices: cp.messagesSnapshot.map(internMessage) }
                : {}),
        };
    }

    const readSet: Record<string, string> = {};
    for (const [path, hash] of Array.from(state.readSet.entries()).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
    )) {
        readSet[path] = hash;
    }

    return {
        agentId: state.agentId,
        messagePool: pool,
        activeMessageIndices,
        readSet,
        archivedUpToChunk: state.archivedUpToChunk,
        turnEndCounts: [...state.turnEndCounts],
        compactionHeaderCount: state.compactionHeaderCount,
        checkpoints,
        frozenPrefix: state.frozenPrefix
            ? {
                tools: canonicalClone(state.frozenPrefix.tools) as CanonicalToolSchema[],
                messages: canonicalClone(state.frozenPrefix.messages) as CanonicalMessage[],
                layer0EndIndex: state.frozenPrefix.layer0EndIndex,
            }
            : null,
    };
}

function deserializeThread(agentId: string, raw: SerializedAgentTrajectory): InternalTrajectoryState {
    const state = createEmptyThreadState(agentId);
    const pool = Array.isArray(raw.messagePool)
        ? raw.messagePool.map(freezeCanonicalMessage)
        : [];

    const resolveIndices = (indices: unknown): CanonicalMessage[] => {
        if (!Array.isArray(indices)) {
            return [];
        }
        const resolved: CanonicalMessage[] = [];
        for (const idx of indices) {
            if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 && idx < pool.length) {
                resolved.push(pool[idx]);
            }
        }
        return resolved;
    };

    state.messages = resolveIndices(raw.activeMessageIndices);
    state.archivedUpToChunk = typeof raw.archivedUpToChunk === 'number' ? Math.max(0, raw.archivedUpToChunk) : 0;
    state.compactionHeaderCount = typeof raw.compactionHeaderCount === 'number'
        ? Math.max(0, Math.min(state.messages.length, raw.compactionHeaderCount))
        : 0;
    state.turnEndCounts = Array.isArray(raw.turnEndCounts)
        ? normalizeTurnEndCounts(raw.turnEndCounts, state.compactionHeaderCount, state.messages.length)
        : [];

    if (raw.readSet && typeof raw.readSet === 'object') {
        for (const [path, hash] of Object.entries(raw.readSet)) {
            if (typeof hash === 'string') {
                state.readSet.set(path, hash);
            }
        }
    }

    if (raw.checkpoints && typeof raw.checkpoints === 'object') {
        for (const [key, rawCp] of Object.entries(raw.checkpoints)) {
            const parsed = parseBranchKey(key);
            if (!parsed || !rawCp || typeof rawCp !== 'object') {
                continue;
            }
            const readSetSnapshot = new Map<string, string>();
            if (rawCp.readSetSnapshot && typeof rawCp.readSetSnapshot === 'object') {
                for (const [path, hash] of Object.entries(rawCp.readSetSnapshot)) {
                    if (typeof hash === 'string') {
                        readSetSnapshot.set(path, hash);
                    }
                }
            }
            const snapshotMsgs = rawCp.messageIndices
                ? resolveIndices(rawCp.messageIndices)
                : undefined;
            const messageCount = typeof rawCp.messageCount === 'number'
                ? Math.max(0, rawCp.messageCount)
                : (snapshotMsgs?.length ?? 0);
            const compactionHeaderCount = typeof rawCp.compactionHeaderCount === 'number'
                ? Math.max(0, rawCp.compactionHeaderCount)
                : 0;

            state.checkpoints.set(toBranchKey(parsed), {
                messageCount,
                readSetSnapshot,
                archivedUpToChunk: typeof rawCp.archivedUpToChunk === 'number'
                    ? Math.max(0, rawCp.archivedUpToChunk)
                    : 0,
                turnEndCounts: Array.isArray(rawCp.turnEndCounts)
                    ? normalizeTurnEndCounts(rawCp.turnEndCounts, compactionHeaderCount, messageCount)
                    : [],
                compactionHeaderCount,
                ...(snapshotMsgs ? { messagesSnapshot: snapshotMsgs } : {}),
            });
        }
    }

    if (raw.frozenPrefix && typeof raw.frozenPrefix === 'object') {
        state.frozenPrefix = freezeStaticPrefix({
            tools: Array.isArray(raw.frozenPrefix.tools) ? raw.frozenPrefix.tools : [],
            messages: Array.isArray(raw.frozenPrefix.messages) ? raw.frozenPrefix.messages : [],
            layer0EndIndex: typeof raw.frozenPrefix.layer0EndIndex === 'number'
                ? raw.frozenPrefix.layer0EndIndex
                : -1,
        });
    }

    return state;
}
