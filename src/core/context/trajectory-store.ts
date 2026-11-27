import type { HostBridge, PromptTransformSource } from '@/core/bridge';
import { DEFAULT_MAIN_AGENT_ID } from '@/core/config';
import {
    type BranchKey,
    type CanonicalContentPart,
    type CanonicalMessage,
    type CanonicalToolSchema,
    type InterruptedReason,
    type MessageTarget,
    type NamespaceDataMap,
    type PipelinePhase,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';

/** Metadata key where `TrajectoryStore` persists causal agent trajectories. */
export const AGENTIC_TRAJECTORIES_KEY = 'agentic_trajectories';

const trajectoryTextEncoder = new TextEncoder();

/** Frozen Layer 0 static prefix cached once per persistent agent session. */
export interface FrozenStaticPrefix {
    tools: readonly CanonicalToolSchema[];
    messages: readonly CanonicalMessage[];
    layer0EndIndex: number;
    prefixFingerprint?: string;
    cachedPrefixBlocks?: Readonly<Record<string, readonly CanonicalMessage[]>>;
    cachedSystemRules?: Readonly<Record<string, string>>;
    nonCacheablePrefixBlockIds?: readonly string[];
    nonCacheableSystemRuleKeys?: readonly string[];
    prefixHookCacheKeys?: Readonly<Record<string, string>>;
}

export interface TrajectoryMessageTransformMeta {
    source?: PromptTransformSource;
    isChatMessage?: boolean;
    messageId?: number;
    swipeId?: number;
    name?: string;
    isUser?: boolean;
    toolName?: string;
    toolCallId?: string;
    path?: string;
    mount?: string;
    editable?: boolean;
    writable?: boolean;
}

export interface TrajectoryMessageTransformState {
    cached: boolean;
    rawContent?: string | CanonicalContentPart[];
    meta?: TrajectoryMessageTransformMeta;
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
    /** Parallel prompt-transform cache states aligned with `messagesSnapshot`. */
    transformStatesSnapshot?: ReadonlyArray<TrajectoryMessageTransformState | undefined>;
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
    transformStates?: Array<TrajectoryMessageTransformState | null>;
}

export interface SerializedAgentTrajectory {
    agentId: string;
    messagePool: CanonicalMessage[];
    activeMessageIndices: number[];
    transformStates?: Array<TrajectoryMessageTransformState | null>;
    readSet: Record<string, string>;
    archivedUpToChunk: number;
    turnEndCounts: number[];
    compactionHeaderCount: number;
    checkpoints: Record<string, SerializedBranchCheckpoint>;
    frozenPrefix?: {
        tools: CanonicalToolSchema[];
        messages: CanonicalMessage[];
        layer0EndIndex: number;
        prefixFingerprint?: string;
        cachedPrefixBlocks?: Record<string, CanonicalMessage[]>;
        cachedSystemRules?: Record<string, string>;
        nonCacheablePrefixBlockIds?: string[];
        nonCacheableSystemRuleKeys?: string[];
        prefixHookCacheKeys?: Record<string, string>;
    } | null;
}

export interface InterruptedPreviousRoundSnapshot {
    completedTurnMessages: CanonicalMessage[];
    readSetSnapshot: Record<string, string>;
    stagedSnapshot: NamespaceDataMap;
    outputText: string;
    rolledBackToolSummary?: string;
}

export interface InterruptedCheckpointScope {
    phase?: PipelinePhase;
    triggerId?: string;
}

export type InterruptedCheckpointKey = BranchKey | `${BranchKey}::${string}`;

export interface InterruptedTurnCheckpoint {
    agentId: string;
    target: MessageTarget;
    reason: InterruptedReason;
    errorMessage?: string;
    phase?: PipelinePhase;
    triggerId?: string;
    runId?: string;
    completedTurnMessages: CanonicalMessage[];
    readSetSnapshot: Record<string, string>;
    stagedSnapshot: NamespaceDataMap;
    previousRoundSnapshot?: InterruptedPreviousRoundSnapshot;
    createdAt: number;
}

export interface SerializedTrajectoryStore {
    version: 1;
    threads: Record<string, SerializedAgentTrajectory>;
    interrupted?: Record<string, InterruptedTurnCheckpoint>;
}

const VALID_PIPELINE_PHASES = new Set<PipelinePhase>([
    'before_turn',
    'main_turn',
    'after_turn',
    'maintenance',
]);

/**
 * Compute a deterministic composite storage key for an interrupted checkpoint.
 * `main_turn` checkpoints without `triggerId` use the plain `BranchKey` (`${messageId}#${swipeId}`)
 * for 100% backward compatibility; other phases or specific triggers use `${branchKey}::${phase}[::${triggerId}]`.
 */
export function toInterruptedCheckpointKey(
    target: MessageTarget,
    scope?: InterruptedCheckpointScope,
): InterruptedCheckpointKey {
    const base = toBranchKey(target);
    const phase = scope?.phase && VALID_PIPELINE_PHASES.has(scope.phase) ? scope.phase : undefined;
    const triggerId =
        typeof scope?.triggerId === 'string' && scope.triggerId.trim().length > 0
            ? scope.triggerId.trim()
            : undefined;
    const hasNonMainPhase = Boolean(phase && phase !== 'main_turn');
    if (!hasNonMainPhase && !triggerId) {
        return base;
    }
    const effectivePhase: PipelinePhase = phase ?? 'main_turn';
    return triggerId
        ? (`${base}::${effectivePhase}::${triggerId}` as InterruptedCheckpointKey)
        : (`${base}::${effectivePhase}` as InterruptedCheckpointKey);
}

/** Parse a composite interrupted checkpoint key back into `{ target, phase?, triggerId? }`. */
export function parseInterruptedCheckpointKey(
    key: string,
): { target: MessageTarget; phase?: PipelinePhase; triggerId?: string } | null {
    if (typeof key !== 'string' || !key) {
        return null;
    }
    const parts = key.split('::');
    const target = parseBranchKey(parts[0]);
    if (!target) {
        return null;
    }
    if (parts.length === 1) {
        return { target };
    }
    const rawPhase = parts[1];
    const phase = VALID_PIPELINE_PHASES.has(rawPhase as PipelinePhase)
        ? (rawPhase as PipelinePhase)
        : undefined;
    const rawTrigger = parts.length >= 3 ? parts.slice(2).join('::').trim() : '';
    const triggerId = rawTrigger.length > 0 ? rawTrigger : undefined;
    return {
        target,
        ...(phase ? { phase } : {}),
        ...(triggerId ? { triggerId } : {}),
    };
}

interface InternalTrajectoryState {
    agentId: string;
    messages: CanonicalMessage[];
    transformStates: Array<TrajectoryMessageTransformState | undefined>;
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
        ...(typeof prefix.prefixFingerprint === 'string'
            ? { prefixFingerprint: prefix.prefixFingerprint }
            : {}),
        ...(prefix.cachedPrefixBlocks
            ? { cachedPrefixBlocks: canonicalClone(prefix.cachedPrefixBlocks) }
            : {}),
        ...(prefix.cachedSystemRules
            ? { cachedSystemRules: { ...prefix.cachedSystemRules } }
            : {}),
        ...(prefix.nonCacheablePrefixBlockIds?.length
            ? { nonCacheablePrefixBlockIds: [...prefix.nonCacheablePrefixBlockIds] }
            : {}),
        ...(prefix.nonCacheableSystemRuleKeys?.length
            ? { nonCacheableSystemRuleKeys: [...prefix.nonCacheableSystemRuleKeys] }
            : {}),
        ...(prefix.prefixHookCacheKeys && Object.keys(prefix.prefixHookCacheKeys).length > 0
            ? { prefixHookCacheKeys: { ...prefix.prefixHookCacheKeys } }
            : {}),
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
        transformStates: [],
        readSet: new Map<string, string>(),
        checkpoints: new Map<BranchKey, BranchCheckpoint>(),
        archivedUpToChunk: 0,
        turnEndCounts: [],
        compactionHeaderCount: 0,
        frozenPrefix: null,
    };
}

function cloneTransformState(
    state: TrajectoryMessageTransformState | undefined,
): TrajectoryMessageTransformState | undefined {
    if (!state) {
        return undefined;
    }
    return {
        cached: Boolean(state.cached),
        ...(state.rawContent !== undefined
            ? { rawContent: canonicalClone(state.rawContent) }
            : {}),
        ...(state.meta ? { meta: { ...state.meta } } : {}),
    };
}

function alignTransformStates(
    states: ReadonlyArray<TrajectoryMessageTransformState | undefined> | undefined,
    length: number,
): Array<TrajectoryMessageTransformState | undefined> {
    const out: Array<TrajectoryMessageTransformState | undefined> = [];
    for (let i = 0; i < length; i += 1) {
        out.push(cloneTransformState(states?.[i]));
    }
    return out;
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
    private readonly interrupted = new Map<InterruptedCheckpointKey, InterruptedTurnCheckpoint>();

    constructor(initial?: SerializedTrajectoryStore) {
        if (initial && initial.version === 1 && initial.threads) {
            for (const [agentId, rawThread] of Object.entries(initial.threads)) {
                this.threads.set(agentId, deserializeThread(agentId, rawThread));
            }
            if (initial.interrupted && typeof initial.interrupted === 'object' && !Array.isArray(initial.interrupted)) {
                for (const [key, rawCp] of Object.entries(initial.interrupted)) {
                    const cp = deserializeInterruptedCheckpoint(key, rawCp);
                    if (cp) {
                        const cpKey = toInterruptedCheckpointKey(cp.target, {
                            phase: cp.phase,
                            triggerId: cp.triggerId,
                        });
                        this.interrupted.set(cpKey, cp);
                    }
                }
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

    /** Return defensive copies of per-message prompt-transform cache states for `agentId`. */
    getTransformStates(
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): ReadonlyArray<TrajectoryMessageTransformState | undefined> {
        const state = this.threads.get(agentId);
        return state ? alignTransformStates(state.transformStates, state.messages.length) : [];
    }

    /** Update prompt-transform state (and optional promoted content) for a single Layer 1 message. */
    updateMessageTransformState(
        index: number,
        nextState: TrajectoryMessageTransformState,
        nextContent?: string | CanonicalContentPart[],
        agentId: string = DEFAULT_MAIN_AGENT_ID,
    ): void {
        const state = this.threads.get(agentId);
        if (!state || index < 0 || index >= state.messages.length) {
            return;
        }
        if (nextContent !== undefined) {
            const current = canonicalClone(state.messages[index]);
            current.content = canonicalClone(nextContent);
            state.messages[index] = freezeCanonicalMessage(current);
        }
        while (state.transformStates.length < state.messages.length) {
            state.transformStates.push(undefined);
        }
        state.transformStates[index] = cloneTransformState(nextState);
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
     * Clear cached Layer 0 `frozenPrefix` across all threads without removing Layer 1
     * conversation history, Read-Set, or checkpoints. Returns the number of cleared threads.
     */
    clearAllFrozenPrefixes(): number {
        let cleared = 0;
        for (const state of this.threads.values()) {
            if (state.frozenPrefix !== null) {
                state.frozenPrefix = null;
                cleared += 1;
            }
        }
        return cleared;
    }

    /**
     * Append finalized messages to Layer 1 without mutating any existing element.
     * Records a turn-end checkpoint boundary at the resulting Layer 1 length.
     */
    appendMessages(
        messages: readonly CanonicalMessage[],
        agentId: string = DEFAULT_MAIN_AGENT_ID,
        transformStates?: ReadonlyArray<TrajectoryMessageTransformState | undefined>,
    ): void {
        if (messages.length === 0) {
            return;
        }
        const state = this.getOrCreateThread(agentId);
        while (state.transformStates.length < state.messages.length) {
            state.transformStates.push(undefined);
        }
        for (let i = 0; i < messages.length; i += 1) {
            state.messages.push(freezeCanonicalMessage(messages[i]));
            state.transformStates.push(cloneTransformState(transformStates?.[i]));
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
        transformStates?: ReadonlyArray<TrajectoryMessageTransformState | undefined>,
    ): void {
        this.appendMessages(messages, agentId, transformStates);
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
        const oldMessages = state.messages;
        const oldStates = state.transformStates;
        const frozenCompacted = update.compactedMessages.map(freezeCanonicalMessage);
        const headerCount = Math.max(0, Math.min(frozenCompacted.length, update.compactionHeaderCount ?? 0));

        const nextStates: Array<TrajectoryMessageTransformState | undefined> = new Array(
            frozenCompacted.length,
        ).fill(undefined);
        for (let i = 0; i < headerCount; i += 1) {
            nextStates[i] = { cached: true };
        }
        const tailCount = frozenCompacted.length - headerCount;
        const oldOffset = oldMessages.length - tailCount;
        const oldSerialized = oldMessages.map((m) => canonicalStringify(m));
        let scanStart = 0;
        for (let j = 0; j < tailCount; j += 1) {
            const newIdx = headerCount + j;
            const targetKey = canonicalStringify(frozenCompacted[newIdx]);
            const suffixIdx = oldOffset + j;
            if (suffixIdx >= scanStart && suffixIdx < oldMessages.length && oldSerialized[suffixIdx] === targetKey) {
                nextStates[newIdx] = cloneTransformState(oldStates[suffixIdx]);
                scanStart = suffixIdx + 1;
                continue;
            }
            const matchedIdx = oldSerialized.indexOf(targetKey, scanStart);
            if (matchedIdx >= 0) {
                nextStates[newIdx] = cloneTransformState(oldStates[matchedIdx]);
                scanStart = matchedIdx + 1;
            }
        }

        state.messages = frozenCompacted;
        state.transformStates = nextStates;
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
            transformStatesSnapshot: alignTransformStates(
                state.transformStates,
                state.messages.length,
            ),
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
            state.transformStates = alignTransformStates(state.transformStates, cp.messageCount);
        } else if (cp.messagesSnapshot) {
            state.messages = cp.messagesSnapshot.slice(0, cp.messageCount);
            state.transformStates = alignTransformStates(cp.transformStatesSnapshot, cp.messageCount);
        } else {
            state.messages = state.messages.slice(0, Math.min(state.messages.length, cp.messageCount));
            state.transformStates = alignTransformStates(
                cp.transformStatesSnapshot ?? state.transformStates,
                state.messages.length,
            );
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
        state.transformStates = [];
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

        for (const [key, cp] of Array.from(this.interrupted.entries())) {
            if (
                cp.target.messageId >= messageId
                && (agentId === undefined || cp.agentId === agentId)
            ) {
                this.interrupted.delete(key);
            }
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

        for (const [key, interruptedCp] of Array.from(this.interrupted.entries())) {
            if (
                interruptedCp.target.messageId === target.messageId
                && interruptedCp.target.swipeId === target.swipeId
                && (agentId === undefined || interruptedCp.agentId === agentId)
            ) {
                this.interrupted.delete(key);
            }
        }

        return removedCount;
    }

    /** Count stored causal branch checkpoints across `agentId` (or all threads if omitted). */
    countCheckpoints(agentId?: string): number {
        const targetIds = agentId !== undefined ? [agentId] : Array.from(this.threads.keys());
        let total = 0;
        for (const id of targetIds) {
            const state = this.threads.get(id);
            if (state) {
                total += state.checkpoints.size;
            }
        }
        return total;
    }

    /** Estimate serialized UTF-8 byte size of the trajectory store. */
    estimateBytes(): number {
        if (this.threads.size === 0 && this.interrupted.size === 0) {
            return 0;
        }
        return trajectoryTextEncoder.encode(canonicalStringify(this.serialize())).length;
    }

    /**
     * Prune cold branch checkpoints with `messageId < coldEnd` so obsolete message
     * snapshots no longer pin evicted turns in `messagePool`.
     * Preserves all hot checkpoints (`>= coldEnd`), or the single latest anchor if all are cold.
     */
    pruneColdCheckpoints(
        coldEnd: number,
        agentId?: string,
    ): { removedCheckpoints: number; remainingCheckpoints: number } {
        const cutoff = Math.max(0, Math.floor(coldEnd));
        const targetIds = agentId !== undefined ? [agentId] : Array.from(this.threads.keys());
        let removedCheckpoints = 0;
        let remainingCheckpoints = 0;

        for (const id of targetIds) {
            const state = this.threads.get(id);
            if (!state) {
                continue;
            }

            const hotKeys: BranchKey[] = [];
            const coldEntries: Array<{ key: BranchKey; target: MessageTarget }> = [];
            for (const key of state.checkpoints.keys()) {
                const parsed = parseBranchKey(key);
                if (!parsed) {
                    continue;
                }
                if (parsed.messageId >= cutoff) {
                    hotKeys.push(key);
                } else {
                    coldEntries.push({ key, target: parsed });
                }
            }

            if (hotKeys.length > 0) {
                for (const item of coldEntries) {
                    if (state.checkpoints.delete(item.key)) {
                        removedCheckpoints += 1;
                    }
                }
            } else if (coldEntries.length > 1) {
                coldEntries.sort(
                    (a, b) =>
                        b.target.messageId - a.target.messageId
                        || b.target.swipeId - a.target.swipeId,
                );
                for (let i = 1; i < coldEntries.length; ++i) {
                    if (state.checkpoints.delete(coldEntries[i].key)) {
                        removedCheckpoints += 1;
                    }
                }
            }

            remainingCheckpoints += state.checkpoints.size;
        }

        for (const [key, cp] of Array.from(this.interrupted.entries())) {
            if (
                cp.target.messageId < cutoff
                && (agentId === undefined || cp.agentId === agentId)
            ) {
                this.interrupted.delete(key);
            }
        }

        return { removedCheckpoints, remainingCheckpoints };
    }

    /** Clear a persistent thread completely (including frozen Layer 0 prefix). */
    clearThread(agentId: string = DEFAULT_MAIN_AGENT_ID): void {
        this.threads.delete(agentId);
        for (const [key, cp] of Array.from(this.interrupted.entries())) {
            if (cp.agentId === agentId) {
                this.interrupted.delete(key);
            }
        }
    }

    /** Save an interrupted turn checkpoint bound to `checkpoint.target` (+ optional `phase`/`triggerId`). */
    saveInterruptedCheckpoint(checkpoint: InterruptedTurnCheckpoint): void {
        assertValidTarget(checkpoint.target);
        const stored = storeInterruptedCheckpoint(checkpoint);
        const key = toInterruptedCheckpointKey(stored.target, {
            phase: stored.phase,
            triggerId: stored.triggerId,
        });
        this.interrupted.set(key, stored);
    }

    /** Read a defensive clone of the interrupted turn checkpoint for `target` (+ optional `phase`/`triggerId`), if any. */
    getInterruptedCheckpoint(
        target: MessageTarget,
        scope?: InterruptedCheckpointScope,
    ): InterruptedTurnCheckpoint | undefined {
        const cp = this.interrupted.get(toInterruptedCheckpointKey(target, scope));
        return cp ? cloneInterruptedCheckpoint(cp) : undefined;
    }

    /** List defensive clones of persisted interrupted turn checkpoints (optionally filtered). */
    listInterruptedCheckpoints(filter?: {
        target?: MessageTarget;
        phase?: PipelinePhase;
        triggerId?: string;
        agentId?: string;
    }): Map<InterruptedCheckpointKey, InterruptedTurnCheckpoint> {
        const result = new Map<InterruptedCheckpointKey, InterruptedTurnCheckpoint>();
        for (const [key, cp] of this.interrupted.entries()) {
            if (filter?.target) {
                if (
                    cp.target.messageId !== filter.target.messageId
                    || cp.target.swipeId !== filter.target.swipeId
                ) {
                    continue;
                }
            }
            if (filter?.phase !== undefined && (cp.phase ?? 'main_turn') !== filter.phase) {
                continue;
            }
            if (filter?.triggerId !== undefined && cp.triggerId !== filter.triggerId) {
                continue;
            }
            if (filter?.agentId !== undefined && cp.agentId !== filter.agentId) {
                continue;
            }
            result.set(key, cloneInterruptedCheckpoint(cp));
        }
        return result;
    }

    /** Remove the interrupted turn checkpoint bound to `target` (+ optional `phase`/`triggerId`). */
    clearInterruptedCheckpoint(
        target: MessageTarget,
        scope?: InterruptedCheckpointScope,
    ): boolean {
        return this.interrupted.delete(toInterruptedCheckpointKey(target, scope));
    }

    /**
     * Replace all thread states (including checkpoints, frozenPrefix, readSet, messages)
     * and interrupted turn checkpoints with defensive copies from `source`.
     */
    replaceFrom(source: TrajectoryStore): void {
        if (source === this) {
            return;
        }
        this.threads.clear();
        this.interrupted.clear();

        for (const [agentId, sourceState] of source.threads.entries()) {
            const clonedCheckpoints = new Map<BranchKey, BranchCheckpoint>();
            for (const [key, cp] of sourceState.checkpoints.entries()) {
                clonedCheckpoints.set(key, cloneCheckpoint(cp));
            }
            this.threads.set(agentId, {
                agentId: sourceState.agentId,
                messages: [...sourceState.messages],
                transformStates: alignTransformStates(
                    sourceState.transformStates,
                    sourceState.messages.length,
                ),
                readSet: new Map(sourceState.readSet),
                checkpoints: clonedCheckpoints,
                archivedUpToChunk: sourceState.archivedUpToChunk,
                turnEndCounts: [...sourceState.turnEndCounts],
                compactionHeaderCount: sourceState.compactionHeaderCount,
                frozenPrefix: sourceState.frozenPrefix
                    ? freezeStaticPrefix(sourceState.frozenPrefix)
                    : null,
            });
        }

        for (const [key, cp] of source.interrupted.entries()) {
            this.interrupted.set(key, storeInterruptedCheckpoint(cp));
        }
    }

    /** Serialize all persistent threads with deduplicated message pools for metadata persistence. */
    serialize(): SerializedTrajectoryStore {
        const threads: Record<string, SerializedAgentTrajectory> = {};

        for (const [agentId, state] of this.threads.entries()) {
            threads[agentId] = serializeThread(state);
        }

        const serialized: SerializedTrajectoryStore = {
            version: 1,
            threads,
        };

        if (this.interrupted.size > 0) {
            const interrupted: Record<string, InterruptedTurnCheckpoint> = {};
            const sortedKeys = Array.from(this.interrupted.keys()).sort((a, b) =>
                a < b ? -1 : a > b ? 1 : 0,
            );
            for (const key of sortedKeys) {
                const cp = this.interrupted.get(key);
                if (cp) {
                    interrupted[key] = cloneInterruptedCheckpoint(cp);
                }
            }
            serialized.interrupted = interrupted;
        }

        return serialized;
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
        ...(cp.transformStatesSnapshot
            ? {
                  transformStatesSnapshot: alignTransformStates(
                      cp.transformStatesSnapshot,
                      cp.messagesSnapshot?.length ?? cp.messageCount,
                  ),
              }
            : {}),
    };
}

const VALID_INTERRUPTED_REASONS = new Set<InterruptedReason>([
    'user_stop',
    'length',
    'error',
    'empty_output',
]);

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidTargetObject(target: unknown): target is MessageTarget {
    if (!isPlainObjectRecord(target)) {
        return false;
    }
    return (
        typeof target.messageId === 'number'
        && Number.isInteger(target.messageId)
        && target.messageId >= 0
        && typeof target.swipeId === 'number'
        && Number.isInteger(target.swipeId)
        && target.swipeId >= 0
    );
}

function storePreviousRoundSnapshot(
    snapshot: InterruptedPreviousRoundSnapshot,
): InterruptedPreviousRoundSnapshot {
    return {
        completedTurnMessages: (snapshot.completedTurnMessages ?? []).map(freezeCanonicalMessage),
        readSetSnapshot: canonicalClone(snapshot.readSetSnapshot ?? {}),
        stagedSnapshot: canonicalClone(snapshot.stagedSnapshot ?? {}),
        outputText: typeof snapshot.outputText === 'string' ? snapshot.outputText : '',
        ...(typeof snapshot.rolledBackToolSummary === 'string'
            ? { rolledBackToolSummary: snapshot.rolledBackToolSummary }
            : {}),
    };
}

function clonePreviousRoundSnapshot(
    snapshot: InterruptedPreviousRoundSnapshot,
): InterruptedPreviousRoundSnapshot {
    return {
        completedTurnMessages: snapshot.completedTurnMessages.map((msg) => canonicalClone(msg)),
        readSetSnapshot: canonicalClone(snapshot.readSetSnapshot),
        stagedSnapshot: canonicalClone(snapshot.stagedSnapshot),
        outputText: snapshot.outputText,
        ...(snapshot.rolledBackToolSummary !== undefined
            ? { rolledBackToolSummary: snapshot.rolledBackToolSummary }
            : {}),
    };
}

function deserializePreviousRoundSnapshot(
    raw: unknown,
): InterruptedPreviousRoundSnapshot | undefined {
    if (!isPlainObjectRecord(raw)) {
        return undefined;
    }

    const completedTurnMessages = Array.isArray(raw.completedTurnMessages)
        ? raw.completedTurnMessages.map(freezeCanonicalMessage)
        : [];
    const readSetSnapshot: Record<string, string> = {};
    if (isPlainObjectRecord(raw.readSetSnapshot)) {
        for (const [path, hash] of Object.entries(raw.readSetSnapshot)) {
            if (typeof hash === 'string') {
                readSetSnapshot[path] = hash;
            }
        }
    }
    const stagedSnapshot: NamespaceDataMap = isPlainObjectRecord(raw.stagedSnapshot)
        ? canonicalClone(raw.stagedSnapshot as NamespaceDataMap)
        : {};
    const outputText = typeof raw.outputText === 'string' ? raw.outputText : '';

    return {
        completedTurnMessages,
        readSetSnapshot: canonicalClone(readSetSnapshot),
        stagedSnapshot,
        outputText,
        ...(typeof raw.rolledBackToolSummary === 'string'
            ? { rolledBackToolSummary: raw.rolledBackToolSummary }
            : {}),
    };
}

function storeInterruptedCheckpoint(cp: InterruptedTurnCheckpoint): InterruptedTurnCheckpoint {
    const phase = cp.phase && VALID_PIPELINE_PHASES.has(cp.phase) ? cp.phase : undefined;
    const triggerId =
        typeof cp.triggerId === 'string' && cp.triggerId.trim().length > 0
            ? cp.triggerId.trim()
            : undefined;
    const runId =
        typeof cp.runId === 'string' && cp.runId.trim().length > 0
            ? cp.runId.trim()
            : undefined;
    return {
        agentId: cp.agentId,
        target: { messageId: cp.target.messageId, swipeId: cp.target.swipeId },
        reason: cp.reason,
        ...(cp.errorMessage !== undefined ? { errorMessage: cp.errorMessage } : {}),
        ...(phase !== undefined ? { phase } : {}),
        ...(triggerId !== undefined ? { triggerId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        completedTurnMessages: cp.completedTurnMessages.map(freezeCanonicalMessage),
        readSetSnapshot: canonicalClone(cp.readSetSnapshot ?? {}),
        stagedSnapshot: canonicalClone(cp.stagedSnapshot ?? {}),
        ...(cp.previousRoundSnapshot
            ? { previousRoundSnapshot: storePreviousRoundSnapshot(cp.previousRoundSnapshot) }
            : {}),
        createdAt: cp.createdAt,
    };
}

function cloneInterruptedCheckpoint(cp: InterruptedTurnCheckpoint): InterruptedTurnCheckpoint {
    return {
        agentId: cp.agentId,
        target: { messageId: cp.target.messageId, swipeId: cp.target.swipeId },
        reason: cp.reason,
        ...(cp.errorMessage !== undefined ? { errorMessage: cp.errorMessage } : {}),
        ...(cp.phase !== undefined ? { phase: cp.phase } : {}),
        ...(cp.triggerId !== undefined ? { triggerId: cp.triggerId } : {}),
        ...(cp.runId !== undefined ? { runId: cp.runId } : {}),
        completedTurnMessages: cp.completedTurnMessages.map((msg) => canonicalClone(msg)),
        readSetSnapshot: canonicalClone(cp.readSetSnapshot),
        stagedSnapshot: canonicalClone(cp.stagedSnapshot),
        ...(cp.previousRoundSnapshot
            ? { previousRoundSnapshot: clonePreviousRoundSnapshot(cp.previousRoundSnapshot) }
            : {}),
        createdAt: cp.createdAt,
    };
}

function deserializeInterruptedCheckpoint(
    key: string,
    raw: unknown,
): InterruptedTurnCheckpoint | null {
    if (!isPlainObjectRecord(raw)) {
        return null;
    }

    const parsedKey = parseInterruptedCheckpointKey(key);
    const target = isValidTargetObject(raw.target)
        ? { messageId: raw.target.messageId, swipeId: raw.target.swipeId }
        : (parsedKey?.target ?? null);
    if (!target) {
        return null;
    }

    const agentId =
        typeof raw.agentId === 'string' && raw.agentId.length > 0
            ? raw.agentId
            : DEFAULT_MAIN_AGENT_ID;
    const reason: InterruptedReason =
        typeof raw.reason === 'string' && VALID_INTERRUPTED_REASONS.has(raw.reason as InterruptedReason)
            ? (raw.reason as InterruptedReason)
            : 'error';
    const phase: PipelinePhase | undefined =
        typeof raw.phase === 'string' && VALID_PIPELINE_PHASES.has(raw.phase as PipelinePhase)
            ? (raw.phase as PipelinePhase)
            : parsedKey?.phase;
    const triggerId =
        typeof raw.triggerId === 'string' && raw.triggerId.trim().length > 0
            ? raw.triggerId.trim()
            : parsedKey?.triggerId;
    const runId =
        typeof raw.runId === 'string' && raw.runId.trim().length > 0
            ? raw.runId.trim()
            : undefined;
    const completedTurnMessages = Array.isArray(raw.completedTurnMessages)
        ? raw.completedTurnMessages.map(freezeCanonicalMessage)
        : [];

    const readSetSnapshot: Record<string, string> = {};
    if (isPlainObjectRecord(raw.readSetSnapshot)) {
        for (const [path, hash] of Object.entries(raw.readSetSnapshot)) {
            if (typeof hash === 'string') {
                readSetSnapshot[path] = hash;
            }
        }
    }

    const stagedSnapshot: NamespaceDataMap = isPlainObjectRecord(raw.stagedSnapshot)
        ? canonicalClone(raw.stagedSnapshot as NamespaceDataMap)
        : {};

    const previousRoundSnapshot = deserializePreviousRoundSnapshot(raw.previousRoundSnapshot);

    const createdAt =
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)
            ? raw.createdAt
            : 0;

    return {
        agentId,
        target,
        reason,
        ...(typeof raw.errorMessage === 'string' ? { errorMessage: raw.errorMessage } : {}),
        ...(phase !== undefined ? { phase } : {}),
        ...(triggerId !== undefined ? { triggerId } : {}),
        ...(runId !== undefined ? { runId } : {}),
        completedTurnMessages,
        readSetSnapshot: canonicalClone(readSetSnapshot),
        stagedSnapshot,
        ...(previousRoundSnapshot ? { previousRoundSnapshot } : {}),
        createdAt,
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
            ...(cp.transformStatesSnapshot?.some((s) => s !== undefined)
                ? {
                      transformStates: alignTransformStates(
                          cp.transformStatesSnapshot,
                          cp.messagesSnapshot?.length ?? cp.messageCount,
                      ).map((s) => s ?? null),
                  }
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
        ...(state.transformStates.some((s) => s !== undefined)
            ? {
                  transformStates: alignTransformStates(
                      state.transformStates,
                      state.messages.length,
                  ).map((s) => s ?? null),
              }
            : {}),
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
                ...(typeof state.frozenPrefix.prefixFingerprint === 'string'
                    ? { prefixFingerprint: state.frozenPrefix.prefixFingerprint }
                    : {}),
                ...(state.frozenPrefix.cachedPrefixBlocks
                    ? {
                          cachedPrefixBlocks: canonicalClone(
                              state.frozenPrefix.cachedPrefixBlocks,
                          ) as Record<string, CanonicalMessage[]>,
                      }
                    : {}),
                ...(state.frozenPrefix.cachedSystemRules
                    ? { cachedSystemRules: { ...state.frozenPrefix.cachedSystemRules } }
                    : {}),
                ...(state.frozenPrefix.nonCacheablePrefixBlockIds?.length
                    ? { nonCacheablePrefixBlockIds: [...state.frozenPrefix.nonCacheablePrefixBlockIds] }
                    : {}),
                ...(state.frozenPrefix.nonCacheableSystemRuleKeys?.length
                    ? { nonCacheableSystemRuleKeys: [...state.frozenPrefix.nonCacheableSystemRuleKeys] }
                    : {}),
                ...(state.frozenPrefix.prefixHookCacheKeys
                    && Object.keys(state.frozenPrefix.prefixHookCacheKeys).length > 0
                    ? { prefixHookCacheKeys: { ...state.frozenPrefix.prefixHookCacheKeys } }
                    : {}),
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
    state.transformStates = alignTransformStates(
        Array.isArray(raw.transformStates)
            ? raw.transformStates.map((s) => (s && typeof s === 'object' ? s : undefined))
            : undefined,
        state.messages.length,
    );
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
                ...(Array.isArray(rawCp.transformStates)
                    ? {
                          transformStatesSnapshot: alignTransformStates(
                              rawCp.transformStates.map((s) =>
                                  s && typeof s === 'object' ? s : undefined,
                              ),
                              snapshotMsgs?.length ?? messageCount,
                          ),
                      }
                    : {}),
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
            ...(typeof raw.frozenPrefix.prefixFingerprint === 'string'
                ? { prefixFingerprint: raw.frozenPrefix.prefixFingerprint }
                : {}),
            ...(raw.frozenPrefix.cachedPrefixBlocks && typeof raw.frozenPrefix.cachedPrefixBlocks === 'object'
                ? { cachedPrefixBlocks: raw.frozenPrefix.cachedPrefixBlocks }
                : {}),
            ...(raw.frozenPrefix.cachedSystemRules && typeof raw.frozenPrefix.cachedSystemRules === 'object'
                ? { cachedSystemRules: raw.frozenPrefix.cachedSystemRules }
                : {}),
            ...(Array.isArray(raw.frozenPrefix.nonCacheablePrefixBlockIds)
                ? { nonCacheablePrefixBlockIds: raw.frozenPrefix.nonCacheablePrefixBlockIds }
                : {}),
            ...(Array.isArray(raw.frozenPrefix.nonCacheableSystemRuleKeys)
                ? { nonCacheableSystemRuleKeys: raw.frozenPrefix.nonCacheableSystemRuleKeys }
                : {}),
            ...(raw.frozenPrefix.prefixHookCacheKeys && typeof raw.frozenPrefix.prefixHookCacheKeys === 'object'
                ? { prefixHookCacheKeys: raw.frozenPrefix.prefixHookCacheKeys }
                : {}),
        });
    }

    return state;
}
