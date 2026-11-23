import type { HostBridge } from '@/core/bridge';
import { TrajectoryStore, estimateRequestTokens } from '@/core/context';
import {
    type BranchKey,
    type MessageTarget,
    type SideSessionAutoBridge,
    type SideSessionConfig,
    type SideSessionFilter,
    type SideSessionInfo,
    type SideSessionScope,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';

/** Metadata key where `SideSessionStore` persists SideGen session configs and branch checkpoints. */
export const AGENTIC_SIDE_SESSIONS_KEY = 'agentic_side_sessions';

/** `TrajectoryStore` thread key prefix for persistent SideGen sessions. */
export const SIDE_THREAD_PREFIX = 'side:';

export const DEFAULT_SIDE_SESSION_WATERMARK = {
    high: 16000,
    low: 8000,
} as const;

export function toSideThreadId(sessionId: string): string {
    return `${SIDE_THREAD_PREFIX}${sessionId}`;
}

export interface SideSessionBranchCheckpoint {
    target: MessageTarget;
    turns: number;
    estimatedTokens: number;
    lastCacheHitRate?: string;
    updatedAt: number;
}

export interface PersistedSideSessionRecord {
    config: SideSessionConfig;
    checkpoints?: Record<BranchKey, SideSessionBranchCheckpoint>;
}

export interface PersistedSideSessionStore {
    version: 1;
    sessions: Record<string, PersistedSideSessionRecord>;
}

export interface SideSessionStoreOptions {
    bridge: HostBridge;
    trajectoryStore?: TrajectoryStore;
    metadataKey?: string;
    persistTrajectory?: boolean;
    now?: () => number;
}

export interface SaveSideSessionOptions {
    recordCheckpoint?: boolean;
    checkpointTarget?: MessageTarget;
}

export interface SideSessionRollbackOptions {
    /** Prune checkpoints strictly after `anchor.messageId` (default `true`). */
    pruneFuture?: boolean;
    /** Prune sibling swipe checkpoints at `anchor.messageId` with `swipeId !== anchor.swipeId` (default `false`). */
    pruneSiblings?: boolean;
    /** Optional override for resolving active swipe ID at ancestor messages. */
    swipeLookup?: (messageId: number) => number;
}

export interface SideSessionRollbackResult {
    anchor: MessageTarget;
    rolledBackSessionIds: string[];
    skippedChatScopeIds: string[];
    prunedCheckpointCount: number;
}

interface InternalSideSessionEntry {
    config: SideSessionConfig;
    checkpoints: Map<BranchKey, SideSessionBranchCheckpoint>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidTarget(target: unknown): target is MessageTarget {
    if (!isPlainRecord(target)) {
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

function assertValidTarget(target: MessageTarget): void {
    if (!isValidTarget(target)) {
        const raw = target as Partial<MessageTarget> | null | undefined;
        throw new Error(
            `Invalid MessageTarget { messageId: ${String(raw?.messageId)}, swipeId: ${String(raw?.swipeId)} }`,
        );
    }
}

function normalizeScope(value: unknown): SideSessionScope {
    return value === 'chat' ? 'chat' : 'branch';
}

function normalizeWatermark(raw: unknown): { high: number; low: number } {
    if (!isPlainRecord(raw)) {
        return { ...DEFAULT_SIDE_SESSION_WATERMARK };
    }
    const rawHigh =
        typeof raw.high === 'number' && Number.isFinite(raw.high) && raw.high > 0
            ? Math.floor(raw.high)
            : DEFAULT_SIDE_SESSION_WATERMARK.high;
    const rawLow =
        typeof raw.low === 'number' && Number.isFinite(raw.low) && raw.low > 0
            ? Math.floor(raw.low)
            : Math.max(1, Math.floor(rawHigh / 2));
    const low = rawLow < rawHigh ? rawLow : Math.max(1, Math.floor(rawHigh / 2));
    return { high: rawHigh, low };
}

function cloneAutoBridge(bridge: SideSessionAutoBridge | undefined): SideSessionAutoBridge | undefined {
    if (!bridge) {
        return undefined;
    }
    return {
        path: bridge.path,
        delivery: bridge.delivery,
        keywords: [...bridge.keywords],
        title: bridge.title,
        mode: bridge.mode === 'replace' ? 'replace' : 'append',
        ...(bridge.summaryPrefix !== undefined ? { summaryPrefix: bridge.summaryPrefix } : {}),
    };
}

function cloneSessionConfig(config: SideSessionConfig): SideSessionConfig {
    return {
        id: config.id,
        title: config.title,
        scope: normalizeScope(config.scope),
        systemPrompt: config.systemPrompt,
        connectionId: config.connectionId,
        watermark: normalizeWatermark(config.watermark),
        ...(config.autoBridge ? { autoBridge: cloneAutoBridge(config.autoBridge) } : {}),
        anchor: { messageId: config.anchor.messageId, swipeId: config.anchor.swipeId },
        turns: config.turns,
        estimatedTokens: config.estimatedTokens,
        ...(config.lastCacheHitRate !== undefined ? { lastCacheHitRate: config.lastCacheHitRate } : {}),
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
    };
}

function cloneCheckpoint(cp: SideSessionBranchCheckpoint): SideSessionBranchCheckpoint {
    return {
        target: { messageId: cp.target.messageId, swipeId: cp.target.swipeId },
        turns: cp.turns,
        estimatedTokens: cp.estimatedTokens,
        ...(cp.lastCacheHitRate !== undefined ? { lastCacheHitRate: cp.lastCacheHitRate } : {}),
        updatedAt: cp.updatedAt,
    };
}

function deserializeSessionEntry(
    fallbackId: string,
    raw: unknown,
): InternalSideSessionEntry | null {
    if (!isPlainRecord(raw)) {
        return null;
    }

    const rawConfig = isPlainRecord(raw.config) ? raw.config : raw;
    const id = typeof rawConfig.id === 'string' && rawConfig.id.trim() ? rawConfig.id.trim() : fallbackId;
    if (!id) {
        return null;
    }

    const title = typeof rawConfig.title === 'string' ? rawConfig.title : id;
    const systemPrompt = typeof rawConfig.systemPrompt === 'string' ? rawConfig.systemPrompt : '';
    const connectionId =
        typeof rawConfig.connectionId === 'string' && rawConfig.connectionId.trim()
            ? rawConfig.connectionId.trim()
            : 'inherit';
    const anchor = isValidTarget(rawConfig.anchor)
        ? { messageId: rawConfig.anchor.messageId, swipeId: rawConfig.anchor.swipeId }
        : { messageId: 0, swipeId: 0 };
    const turns =
        typeof rawConfig.turns === 'number' && Number.isFinite(rawConfig.turns) && rawConfig.turns >= 0
            ? Math.floor(rawConfig.turns)
            : 0;
    const estimatedTokens =
        typeof rawConfig.estimatedTokens === 'number'
        && Number.isFinite(rawConfig.estimatedTokens)
        && rawConfig.estimatedTokens >= 0
            ? Math.floor(rawConfig.estimatedTokens)
            : 0;
    const createdAt =
        typeof rawConfig.createdAt === 'number' && Number.isFinite(rawConfig.createdAt)
            ? Math.floor(rawConfig.createdAt)
            : 0;
    const updatedAt =
        typeof rawConfig.updatedAt === 'number' && Number.isFinite(rawConfig.updatedAt)
            ? Math.floor(rawConfig.updatedAt)
            : createdAt;

    let autoBridge: SideSessionAutoBridge | undefined;
    if (isPlainRecord(rawConfig.autoBridge) && typeof rawConfig.autoBridge.path === 'string') {
        autoBridge = {
            path: rawConfig.autoBridge.path,
            delivery: rawConfig.autoBridge.delivery as SideSessionAutoBridge['delivery'],
            keywords: Array.isArray(rawConfig.autoBridge.keywords)
                ? rawConfig.autoBridge.keywords.filter((k): k is string => typeof k === 'string')
                : [],
            title:
                typeof rawConfig.autoBridge.title === 'string'
                    ? rawConfig.autoBridge.title
                    : title,
            mode: rawConfig.autoBridge.mode === 'replace' ? 'replace' : 'append',
            ...(typeof rawConfig.autoBridge.summaryPrefix === 'string'
                ? { summaryPrefix: rawConfig.autoBridge.summaryPrefix }
                : {}),
        };
    }

    const config: SideSessionConfig = {
        id,
        title,
        scope: normalizeScope(rawConfig.scope),
        systemPrompt,
        connectionId,
        watermark: normalizeWatermark(rawConfig.watermark),
        ...(autoBridge ? { autoBridge } : {}),
        anchor,
        turns,
        estimatedTokens,
        ...(typeof rawConfig.lastCacheHitRate === 'string'
            ? { lastCacheHitRate: rawConfig.lastCacheHitRate }
            : {}),
        createdAt,
        updatedAt,
    };

    const checkpoints = new Map<BranchKey, SideSessionBranchCheckpoint>();
    if (isPlainRecord(raw.checkpoints)) {
        for (const [key, rawCp] of Object.entries(raw.checkpoints)) {
            if (!isPlainRecord(rawCp)) {
                continue;
            }
            const parsedKey = parseBranchKey(key);
            const cpTarget = isValidTarget(rawCp.target)
                ? { messageId: rawCp.target.messageId, swipeId: rawCp.target.swipeId }
                : parsedKey;
            if (!cpTarget) {
                continue;
            }
            const cpKey = toBranchKey(cpTarget);
            checkpoints.set(cpKey, {
                target: cpTarget,
                turns:
                    typeof rawCp.turns === 'number' && Number.isFinite(rawCp.turns) && rawCp.turns >= 0
                        ? Math.floor(rawCp.turns)
                        : 0,
                estimatedTokens:
                    typeof rawCp.estimatedTokens === 'number'
                    && Number.isFinite(rawCp.estimatedTokens)
                    && rawCp.estimatedTokens >= 0
                        ? Math.floor(rawCp.estimatedTokens)
                        : 0,
                ...(typeof rawCp.lastCacheHitRate === 'string'
                    ? { lastCacheHitRate: rawCp.lastCacheHitRate }
                    : {}),
                updatedAt:
                    typeof rawCp.updatedAt === 'number' && Number.isFinite(rawCp.updatedAt)
                        ? Math.floor(rawCp.updatedAt)
                        : updatedAt,
            });
        }
    }

    return { config, checkpoints };
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

/**
 * Persistent off-mainline SideGen session store.
 *
 * - Persists `SideSessionConfig` & branch metadata checkpoints in `chat_metadata.agentic_side_sessions`.
 * - Reuses `TrajectoryStore` under thread key `side:<sessionId>` without modifying main trajectories.
 * - Supports `scope: 'branch'` causal rollback across swipe switches & regenerations while keeping
 *   `scope: 'chat'` sessions unaffected by branch switches.
 */
export class SideSessionStore {
    public readonly trajectoryStore: TrajectoryStore;
    private readonly bridge: HostBridge;
    private readonly metadataKey: string;
    private readonly persistTrajectory: boolean;
    private readonly ownsTrajectoryStore: boolean;
    private readonly nowFn: () => number;
    private readonly entries = new Map<string, InternalSideSessionEntry>();
    private loadedMetadataRef: Record<string, unknown> | null = null;

    constructor(options: SideSessionStoreOptions) {
        this.bridge = options.bridge;
        this.metadataKey = options.metadataKey ?? AGENTIC_SIDE_SESSIONS_KEY;
        this.persistTrajectory = options.persistTrajectory ?? true;
        this.ownsTrajectoryStore = !options.trajectoryStore;
        this.trajectoryStore =
            options.trajectoryStore ?? TrajectoryStore.loadFromHost(options.bridge);
        this.nowFn = options.now ?? (() => Date.now());
        this.reloadFromHost({ reloadTrajectory: false });
    }

    /** Reload session metadata (and optionally `TrajectoryStore`) from `HostBridge.getMetadata()`. */
    reloadFromHost(opts: { reloadTrajectory?: boolean } = {}): void {
        const metadata = this.bridge.getMetadata();
        this.loadedMetadataRef = metadata;
        this.entries.clear();

        const raw = metadata?.[this.metadataKey];
        if (isPlainRecord(raw)) {
            const rawSessions = isPlainRecord(raw.sessions) ? raw.sessions : null;
            if (rawSessions) {
                for (const [id, record] of Object.entries(rawSessions)) {
                    const entry = deserializeSessionEntry(id, record);
                    if (entry) {
                        this.entries.set(entry.config.id, entry);
                    }
                }
            }
        }

        if (opts.reloadTrajectory) {
            const reloaded = TrajectoryStore.loadFromHost(this.bridge);
            this.trajectoryStore.replaceFrom(reloaded);
        }
    }

    /** Ensure in-memory cache matches current `HostBridge.getMetadata()` reference (e.g. after chat switch). */
    private syncWithHostMetadata(): void {
        const currentMetadata = this.bridge.getMetadata();
        if (currentMetadata !== this.loadedMetadataRef) {
            this.reloadFromHost({ reloadTrajectory: this.ownsTrajectoryStore });
        }
    }

    /** Return a defensive clone of a session's configuration, or `null` if not found. */
    getSession(sessionId: string): SideSessionInfo | null {
        this.syncWithHostMetadata();
        const entry = this.entries.get(sessionId);
        return entry ? cloneSessionConfig(entry.config) : null;
    }

    /** Check whether a session with `sessionId` exists. */
    hasSession(sessionId: string): boolean {
        this.syncWithHostMetadata();
        return this.entries.has(sessionId);
    }

    /** List sessions matching optional `scope` and `branchKey` filters in deterministic order. */
    listSessions(filter?: SideSessionFilter): SideSessionInfo[] {
        this.syncWithHostMetadata();
        const out: SideSessionInfo[] = [];
        for (const entry of this.entries.values()) {
            if (filter?.scope && entry.config.scope !== filter.scope) {
                continue;
            }
            if (filter?.branchKey && toBranchKey(entry.config.anchor) !== filter.branchKey) {
                continue;
            }
            out.push(cloneSessionConfig(entry.config));
        }

        out.sort((a, b) => b.updatedAt - a.updatedAt || compareCodeUnits(a.id, b.id));
        return out;
    }

    /** Create or update a session config and optionally record a causal branch checkpoint. */
    saveSession(config: SideSessionConfig, opts: SaveSideSessionOptions = {}): SideSessionInfo {
        this.syncWithHostMetadata();
        assertValidTarget(config.anchor);

        const existing = this.entries.get(config.id);
        const cloned = cloneSessionConfig(config);
        const checkpoints = existing ? existing.checkpoints : new Map<BranchKey, SideSessionBranchCheckpoint>();

        const entry: InternalSideSessionEntry = {
            config: cloned,
            checkpoints,
        };
        this.entries.set(cloned.id, entry);

        if (cloned.scope === 'branch' && opts.recordCheckpoint) {
            const cpTarget = opts.checkpointTarget ?? cloned.anchor;
            this.recordBranchCheckpointInternal(entry, cpTarget);
        }

        this.persistToHost();
        return cloneSessionConfig(cloned);
    }

    /** Explicitly record a branch checkpoint for a `branch`-scoped session at `target`. */
    recordCheckpoint(sessionId: string, target?: MessageTarget): SideSessionBranchCheckpoint | null {
        this.syncWithHostMetadata();
        const entry = this.entries.get(sessionId);
        if (!entry || entry.config.scope !== 'branch') {
            return null;
        }
        const cpTarget = target ?? entry.config.anchor;
        const cp = this.recordBranchCheckpointInternal(entry, cpTarget);
        this.persistToHost();
        return cloneCheckpoint(cp);
    }

    /** Inspect recorded branch checkpoints for a session. */
    listCheckpoints(sessionId: string): Map<BranchKey, SideSessionBranchCheckpoint> {
        this.syncWithHostMetadata();
        const entry = this.entries.get(sessionId);
        const result = new Map<BranchKey, SideSessionBranchCheckpoint>();
        if (!entry) {
            return result;
        }
        for (const [key, cp] of entry.checkpoints.entries()) {
            result.set(key, cloneCheckpoint(cp));
        }
        return result;
    }

    /** Delete a session's metadata and its `side:<sessionId>` thread in `TrajectoryStore`. */
    deleteSession(sessionId: string): boolean {
        this.syncWithHostMetadata();
        const existed = this.entries.delete(sessionId);
        const threadId = toSideThreadId(sessionId);
        const hadThread = this.trajectoryStore.hasThread(threadId);
        if (hadThread) {
            this.trajectoryStore.clearThread(threadId);
        }
        if (existed || hadThread) {
            this.persistToHost();
            return true;
        }
        return false;
    }

    /**
     * Roll back all `scope === 'branch'` sessions to the latest valid ancestor checkpoint
     * for `anchor` (`{ messageId, swipeId }`), discarding future/sibling branch turns while
     * leaving `scope === 'chat'` sessions completely untouched.
     */
    rollbackToAnchor(
        anchor: MessageTarget,
        opts: SideSessionRollbackOptions = {},
    ): SideSessionRollbackResult {
        this.syncWithHostMetadata();
        assertValidTarget(anchor);

        const pruneFuture = opts.pruneFuture ?? true;
        const pruneSiblings = opts.pruneSiblings ?? false;
        const chat = this.bridge.getChat();
        const resolveActiveSwipe =
            opts.swipeLookup ?? ((msgId: number) => chat[msgId]?.swipeId ?? 0);

        const rolledBackSessionIds: string[] = [];
        const skippedChatScopeIds: string[] = [];
        let prunedCheckpointCount = 0;

        for (const entry of this.entries.values()) {
            if (entry.config.scope === 'chat') {
                skippedChatScopeIds.push(entry.config.id);
                continue;
            }

            const threadId = toSideThreadId(entry.config.id);

            // 1. Find the latest valid ancestor checkpoint along the active swipe chain.
            let bestCp: SideSessionBranchCheckpoint | null = null;
            for (const cp of entry.checkpoints.values()) {
                const isExact =
                    cp.target.messageId === anchor.messageId
                    && cp.target.swipeId === anchor.swipeId;
                const isValidAncestor =
                    cp.target.messageId < anchor.messageId
                    && cp.target.swipeId === resolveActiveSwipe(cp.target.messageId);

                if (!isExact && !isValidAncestor) {
                    continue;
                }
                if (!bestCp || cp.target.messageId > bestCp.target.messageId) {
                    bestCp = cp;
                }
            }

            // 2. Prune future (and optionally sibling) checkpoints.
            for (const [key, cp] of Array.from(entry.checkpoints.entries())) {
                const isFuture = cp.target.messageId > anchor.messageId;
                const isSibling =
                    cp.target.messageId === anchor.messageId
                    && cp.target.swipeId !== anchor.swipeId;

                if ((pruneFuture && isFuture) || (pruneSiblings && isSibling)) {
                    entry.checkpoints.delete(key);
                    this.trajectoryStore.pruneSwipe(cp.target, threadId);
                    prunedCheckpointCount += 1;
                }
            }

            // 3. Restore trajectory & metadata to best valid ancestor, or empty state if none.
            if (bestCp) {
                this.trajectoryStore.restoreBranch(bestCp.target, threadId);
                entry.config.turns = bestCp.turns;
                entry.config.estimatedTokens = bestCp.estimatedTokens;
                entry.config.anchor = { ...bestCp.target };
                entry.config.updatedAt = bestCp.updatedAt;
                if (bestCp.lastCacheHitRate !== undefined) {
                    entry.config.lastCacheHitRate = bestCp.lastCacheHitRate;
                } else {
                    delete entry.config.lastCacheHitRate;
                }
            } else {
                // Reset Layer 1 to empty while keeping frozen Layer 0 prefix intact.
                if (this.trajectoryStore.hasThread(threadId)) {
                    this.trajectoryStore.restoreBeforeMessage(0, threadId);
                }
                const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
                const layer0 = frozen?.messages ?? [
                    { role: 'system' as const, content: entry.config.systemPrompt },
                ];
                entry.config.turns = 0;
                entry.config.estimatedTokens = estimateRequestTokens(layer0, frozen?.tools ?? []);
                entry.config.anchor = { messageId: anchor.messageId, swipeId: anchor.swipeId };
                entry.config.updatedAt = Math.floor(this.nowFn());
                delete entry.config.lastCacheHitRate;
            }

            rolledBackSessionIds.push(entry.config.id);
        }

        if (rolledBackSessionIds.length > 0 || prunedCheckpointCount > 0) {
            this.persistToHost();
        }

        return {
            anchor: { messageId: anchor.messageId, swipeId: anchor.swipeId },
            rolledBackSessionIds: rolledBackSessionIds.sort(compareCodeUnits),
            skippedChatScopeIds: skippedChatScopeIds.sort(compareCodeUnits),
            prunedCheckpointCount,
        };
    }

    /**
     * Permanently prune checkpoints at and after `messageId` for all `branch`-scoped sessions
     * (used on message deletion / hard regenerate) and roll back to the latest valid ancestor
     * strictly before `messageId`. Leaves `chat`-scoped sessions untouched.
     */
    pruneFromMessage(messageId: number): number {
        this.syncWithHostMetadata();
        if (!Number.isInteger(messageId) || messageId < 0) {
            throw new Error(`Invalid messageId for pruneFromMessage: ${String(messageId)}`);
        }

        const chat = this.bridge.getChat();
        const resolveActiveSwipe = (msgId: number) => chat[msgId]?.swipeId ?? 0;
        let pruned = 0;
        let mutated = false;

        for (const entry of this.entries.values()) {
            if (entry.config.scope === 'chat') {
                continue;
            }
            const threadId = toSideThreadId(entry.config.id);
            for (const [key, cp] of Array.from(entry.checkpoints.entries())) {
                if (cp.target.messageId >= messageId) {
                    entry.checkpoints.delete(key);
                    pruned += 1;
                    mutated = true;
                }
            }
            if (this.trajectoryStore.hasThread(threadId)) {
                this.trajectoryStore.pruneFromMessage(messageId, threadId);
                mutated = true;
            }

            let bestCp: SideSessionBranchCheckpoint | null = null;
            for (const cp of entry.checkpoints.values()) {
                if (
                    cp.target.messageId < messageId
                    && cp.target.swipeId === resolveActiveSwipe(cp.target.messageId)
                ) {
                    if (!bestCp || cp.target.messageId > bestCp.target.messageId) {
                        bestCp = cp;
                    }
                }
            }

            if (bestCp) {
                this.trajectoryStore.restoreBranch(bestCp.target, threadId);
                entry.config.turns = bestCp.turns;
                entry.config.estimatedTokens = bestCp.estimatedTokens;
                entry.config.anchor = { ...bestCp.target };
                entry.config.updatedAt = bestCp.updatedAt;
                if (bestCp.lastCacheHitRate !== undefined) {
                    entry.config.lastCacheHitRate = bestCp.lastCacheHitRate;
                } else {
                    delete entry.config.lastCacheHitRate;
                }
            } else {
                const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
                const layer0 = frozen?.messages ?? [
                    { role: 'system' as const, content: entry.config.systemPrompt },
                ];
                const fallbackMsgId = Math.max(0, messageId - 1);
                entry.config.turns = 0;
                entry.config.estimatedTokens = estimateRequestTokens(layer0, frozen?.tools ?? []);
                entry.config.anchor = {
                    messageId: fallbackMsgId,
                    swipeId: resolveActiveSwipe(fallbackMsgId),
                };
                entry.config.updatedAt = Math.floor(this.nowFn());
                delete entry.config.lastCacheHitRate;
            }
        }

        if (mutated) {
            this.persistToHost();
        }
        return pruned;
    }

    /** Serialize store state deterministically for `chat_metadata.agentic_side_sessions`. */
    serialize(): PersistedSideSessionStore {
        const sessions: Record<string, PersistedSideSessionRecord> = {};
        const sortedIds = Array.from(this.entries.keys()).sort(compareCodeUnits);

        for (const id of sortedIds) {
            const entry = this.entries.get(id)!;
            const record: PersistedSideSessionRecord = {
                config: canonicalClone(cloneSessionConfig(entry.config)),
            };
            if (entry.config.scope === 'branch' && entry.checkpoints.size > 0) {
                const cps: Record<BranchKey, SideSessionBranchCheckpoint> = {};
                const sortedKeys = Array.from(entry.checkpoints.keys()).sort(compareCodeUnits);
                for (const key of sortedKeys) {
                    cps[key] = canonicalClone(cloneCheckpoint(entry.checkpoints.get(key)!));
                }
                record.checkpoints = cps;
            }
            sessions[id] = record;
        }

        return {
            version: 1,
            sessions,
        };
    }

    /** Persist session metadata (and optionally `TrajectoryStore`) into `HostBridge.getMetadata()`. */
    persistToHost(): void {
        const metadata = this.bridge.getMetadata();
        this.loadedMetadataRef = metadata;
        metadata[this.metadataKey] = this.serialize();
        if (this.persistTrajectory) {
            this.trajectoryStore.saveToHost(this.bridge);
        } else {
            this.bridge.saveChatDebounced();
        }
    }

    private recordBranchCheckpointInternal(
        entry: InternalSideSessionEntry,
        target: MessageTarget,
    ): SideSessionBranchCheckpoint {
        assertValidTarget(target);
        const threadId = toSideThreadId(entry.config.id);
        this.trajectoryStore.ensureThread(threadId);
        this.trajectoryStore.recordCheckpoint(target, threadId);

        const cp: SideSessionBranchCheckpoint = {
            target: { messageId: target.messageId, swipeId: target.swipeId },
            turns: entry.config.turns,
            estimatedTokens: entry.config.estimatedTokens,
            ...(entry.config.lastCacheHitRate !== undefined
                ? { lastCacheHitRate: entry.config.lastCacheHitRate }
                : {}),
            updatedAt: entry.config.updatedAt,
        };
        entry.checkpoints.set(toBranchKey(target), cp);
        return cp;
    }
}
