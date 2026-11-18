import type { HostBridge } from '@/core/bridge';
import {
    type ChatMessageSnapshot,
    type DataNamespace,
    type MessageTarget,
    type NamespaceDataMap,
    type StoredDataEntry,
    type SwipeDataSnapshot,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';

/** Metadata key under which ST-Agentic persists layered chat data. */
export const AGENTIC_DATA_KEY = 'agentic_data';

/** Legacy ST-CustomGeneration compacted state key in metadata (read-only fallback). */
export const LEGACY_CG_STATE_KEY = 'cg_state';

/** Number of trailing messages bypassed by the cold head index. */
export const HOT_WINDOW = 16;

/** Canonical key used when storing the whole variables snapshot in the `variables` namespace. */
export const VARIABLES_DOC_KEY = 'variables.json';

/** Canonical key used for per-message display overrides in the `message` namespace. */
export const MESSAGE_OVERRIDE_KEY = '';

/** Well-known namespaces in ST-Agentic. */
export const DATA_NAMESPACES = {
    FILES: 'files',
    VARIABLES: 'variables',
    WORLDINFO: 'worldinfo',
    MESSAGE: 'message',
    CHARACTER_FILES: 'character-files',
    PERSONA_FILES: 'persona-files',
} as const;

export interface NamespacePolicy {
    /**
     * `true` = layered namespace (`get`/`lookup` semantics): writes at message N
     * propagate forward along the active swipe chain and can be compacted.
     * `false` = per-message namespace (`scan` / exact target semantics).
     */
    layered: boolean;
}

export const NAMESPACE_POLICY: Record<DataNamespace, NamespacePolicy> = {
    files: { layered: true },
    variables: { layered: true },
    worldinfo: { layered: true },
    message: { layered: false },
    'character-files': { layered: true },
    'persona-files': { layered: true },
};

export interface AgenticPersistedData {
    version: 1;
    watermark: number;
    base: NamespaceDataMap;
    layers: Record<string, NamespaceDataMap>;
}

export interface DataLookupResult {
    key: string;
    entry: StoredDataEntry;
    messageId: number;
    swipeId: number;
}

export interface StoreReadOptions {
    target?: MessageTarget;
    maxDepth?: number;
    includeDeleted?: boolean;
    includeStaged?: boolean;
    excludeLegacyMetadataVariables?: boolean;
}

export interface StoreLookupOptions {
    target?: MessageTarget;
    depth?: number;
    includeDeleted?: boolean;
    includeStaged?: boolean;
}

export interface StoreWriteOptions {
    target?: MessageTarget;
    staged?: boolean;
}

interface LegacyPersistedState {
    base?: NamespaceDataMap;
    watermark?: number;
}

interface HeadIndex {
    heads: Map<string, MessageTarget>;
    coldEnd: number;
    watermark: number;
    chatLength: number;
    coldSwipes: number[];
    epoch: number;
}

type PendingBucketMap = Map<string, NamespaceDataMap>;

const UNBOUND_STAGED_KEY = '__unbound__';

/**
 * In-memory staging buckets keyed by live metadata object so multiple
 * `ChatDataStore` instances over the same chat observe staged writes while
 * uncommitted mutations never leak into persisted `metadata.agentic_data`.
 */
const STAGING_BY_METADATA = new WeakMap<Record<string, unknown>, PendingBucketMap>();

/** Cached cold head indices keyed by metadata object. */
const HEAD_INDEX_CACHE = new WeakMap<Record<string, unknown>, HeadIndex>();
let globalIndexEpoch = 0;

/** Drop all cached head indices across stores. */
export function invalidateHeadIndex(): void {
    globalIndexEpoch += 1;
}

/** Whether a namespace propagates across messages along the active swipe chain. */
export function isLayeredNamespace(ns: string): boolean {
    const policy = NAMESPACE_POLICY[ns as DataNamespace];
    return policy ? policy.layered : true;
}

/** Whether a namespace is eligible for cold-layer compaction. */
export function isCompactableNamespace(ns: string): boolean {
    const policy = NAMESPACE_POLICY[ns as DataNamespace];
    return policy?.layered === true;
}

/** Build the `worldinfo` namespace key for a World Info entry. */
export function worldInfoKey(world: string, uid: string | number): string {
    return `${world}/${String(uid)}`;
}

/** Split a `worldinfo` namespace key back into world name and entry UID. */
export function splitWorldInfoKey(key: string): { world: string; uid: string } {
    const slash = key.lastIndexOf('/');
    return slash >= 0
        ? { world: key.slice(0, slash), uid: key.slice(slash + 1) }
        : { world: key, uid: '' };
}

/** Read (and optionally initialize) `metadata.agentic_data`. */
export function readPersistedAgenticData(
    metadata: Record<string, unknown> | undefined,
    create: boolean = false,
): AgenticPersistedData | null {
    if (!metadata || typeof metadata !== 'object') {
        return null;
    }

    const raw = metadata[AGENTIC_DATA_KEY];
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const record = raw as Partial<AgenticPersistedData>;
        const base: NamespaceDataMap =
            record.base && typeof record.base === 'object' && !Array.isArray(record.base)
                ? record.base
                : {};
        const layers: Record<string, NamespaceDataMap> =
            record.layers && typeof record.layers === 'object' && !Array.isArray(record.layers)
                ? record.layers
                : {};
        const watermark =
            typeof record.watermark === 'number' && Number.isFinite(record.watermark) && record.watermark >= 0
                ? Math.floor(record.watermark)
                : 0;

        if (create) {
            record.version = 1;
            record.base = base;
            record.layers = layers;
            record.watermark = watermark;
            return record as AgenticPersistedData;
        }

        return {
            version: 1,
            watermark,
            base,
            layers,
        };
    }

    if (!create) {
        return null;
    }

    const created: AgenticPersistedData = {
        version: 1,
        watermark: 0,
        base: {},
        layers: {},
    };
    metadata[AGENTIC_DATA_KEY] = created;
    return created;
}

/**
 * Pure `HostBridge`-backed causal layered data store.
 *
 * Persists ST-Agentic data under `metadata.agentic_data` keyed by `(messageId, swipeId)`,
 * maintains in-memory `pending` staged writes with atomic commit/rollback, supports
 * deletion tombstones (`deleted: true`), and reads legacy `cg_data`, `wi_overrides`,
 * `mes_override`, `cg_state`, and per-message `variables` in read-only fallback mode.
 */
export class ChatDataStore {
    constructor(private readonly bridge: HostBridge) {}

    /** Read an entry from committed layers (or including staged when `opts.includeStaged`). */
    get(ns: string, key: string, opts: StoreReadOptions = {}): StoredDataEntry | null {
        const includeDeleted = opts.includeDeleted === true;
        const chat = this.bridge.getChat();
        const metadata = this.bridge.getMetadata();

        if (opts.includeStaged) {
            const staged = this.readStagedEntry(metadata, chat, ns, key, opts.target);
            if (staged) {
                return this.applyVisibility(staged, includeDeleted);
            }
        }

        if (!isLayeredNamespace(ns)) {
            const resolved = this.resolveTarget(chat, opts.target);
            if (!resolved) {
                return null;
            }
            const entry = this.readLayerEntry(metadata, chat, resolved.messageId, resolved.swipeId, ns, key);
            return this.applyVisibility(entry, includeDeleted);
        }

        if (this.canUseIndex(chat, ns, key, opts)) {
            return this.getIndexed(metadata, chat, ns, key, opts.target?.swipeId, includeDeleted, opts);
        }

        return this.getSlow(metadata, chat, ns, key, opts);
    }

    /**
     * Read an entry checking `pending` staged writes first, then committed layers.
     * Tombstones in `pending` mask committed values without falling through.
     */
    getPending(ns: string, key: string, opts: StoreReadOptions = {}): StoredDataEntry | null {
        return this.get(ns, key, { ...opts, includeStaged: true });
    }

    /** Write a value to a committed `(messageId, swipeId)` layer, or stage when `staged: true`. */
    set(
        ns: string,
        key: string,
        source: string,
        content: string,
        optsOrTarget?: StoreWriteOptions | MessageTarget,
    ): void {
        const opts = normalizeWriteOptions(optsOrTarget);
        const entry: StoredDataEntry = { source, content };

        if (opts.staged) {
            this.stageEntry(ns, key, entry, opts.target);
            return;
        }

        const chat = this.bridge.getChat();
        const resolved = this.resolveWriteTarget(chat, opts.target);
        this.writeCommittedLayer(ns, key, entry, resolved);
    }

    /** Write a deletion tombstone so `key` reads as absent from this layer downwards. */
    setDeleted(
        ns: string,
        key: string,
        source: string = 'delete',
        optsOrTarget?: StoreWriteOptions | MessageTarget,
    ): void {
        const opts = normalizeWriteOptions(optsOrTarget);
        const tombstone: StoredDataEntry = { source, content: '', deleted: true };

        if (opts.staged) {
            this.stageEntry(ns, key, tombstone, opts.target);
            return;
        }

        const chat = this.bridge.getChat();
        const resolved = this.resolveWriteTarget(chat, opts.target);
        this.writeCommittedLayer(ns, key, tombstone, resolved);
    }

    /**
     * Physically remove `key` from a single layer without writing a tombstone,
     * allowing older layers or base entries to become visible again.
     */
    remove(ns: string, key: string, target?: MessageTarget): boolean {
        const chat = this.bridge.getChat();
        const metadata = this.bridge.getMetadata();
        const resolved = this.resolveTarget(chat, target);
        if (!resolved) {
            return false;
        }

        const persisted = readPersistedAgenticData(metadata, false);
        if (!persisted) {
            return false;
        }

        const branchKey = toBranchKey(resolved);
        const layer = persisted.layers[branchKey];
        const entries = layer?.[ns];
        if (!entries || !Object.hasOwn(entries, key)) {
            return false;
        }

        delete entries[key];
        if (Object.keys(entries).length === 0) {
            delete layer[ns];
        }
        if (Object.keys(layer).length === 0) {
            delete persisted.layers[branchKey];
        }

        invalidateHeadIndex();
        this.bridge.saveChatDebounced();
        return true;
    }

    /**
     * Delete `key` as seen from the target layer: removes any write on that layer
     * and records a tombstone if an older layer (or base) would otherwise resurface.
     */
    erase(
        ns: string,
        key: string,
        source: string = 'delete',
        optsOrTarget?: StoreWriteOptions | MessageTarget,
    ): boolean {
        const opts = normalizeWriteOptions(optsOrTarget);
        if (opts.staged) {
            return this.stageDelete(ns, key, source, opts.target);
        }

        const chat = this.bridge.getChat();
        const resolved = this.resolveWriteTarget(chat, opts.target);
        const removed = this.remove(ns, key, resolved);

        if (isLayeredNamespace(ns)) {
            const visibleBelow = this.get(ns, key, { target: resolved, includeStaged: false });
            if (visibleBelow !== null) {
                this.writeCommittedLayer(ns, key, { source, content: '', deleted: true }, resolved);
                return true;
            }
        }

        return removed;
    }

    /** Stage a write in `pending` for `target` (or unbound pre-message staging when omitted). */
    stageSet(ns: string, key: string, source: string, content: string, target?: MessageTarget): void {
        this.stageEntry(ns, key, { source, content }, target);
    }

    /**
     * Stage a deletion in `pending` for `target`. Drops the pending key if nothing
     * exists in committed layers underneath; otherwise stages a tombstone.
     */
    stageDelete(ns: string, key: string, source: string = 'delete', target?: MessageTarget): boolean {
        const metadata = this.bridge.getMetadata();
        const chat = this.bridge.getChat();
        const buckets = this.getStagingBuckets(metadata, false);
        const bucketKey = resolveStagingBucketKey(target);
        const bucket = buckets?.get(bucketKey);

        const hadStaged = Boolean(bucket?.[ns] && Object.hasOwn(bucket[ns], key));
        const committedTarget = target && target.messageId >= 0
            ? target
            : this.resolveTarget(chat, undefined) ?? undefined;
        const visibleCommitted = isLayeredNamespace(ns) && committedTarget
            ? this.get(ns, key, { target: committedTarget, includeStaged: false })
            : null;

        if (visibleCommitted === null) {
            if (!hadStaged || !bucket) {
                return false;
            }
            delete bucket[ns][key];
            if (Object.keys(bucket[ns]).length === 0) {
                delete bucket[ns];
            }
            if (Object.keys(bucket).length === 0) {
                buckets?.delete(bucketKey);
            }
            return true;
        }

        this.stageEntry(ns, key, { source, content: '', deleted: true }, target);
        return true;
    }

    /** Whether any staged writes exist for `target` (including unbound pre-message staging). */
    hasPending(target?: MessageTarget): boolean {
        const metadata = this.bridge.getMetadata();
        const buckets = this.getStagingBuckets(metadata, false);
        if (!buckets || buckets.size === 0) {
            return false;
        }

        if (!target) {
            for (const bucket of buckets.values()) {
                if (countBucketEntries(bucket) > 0) {
                    return true;
                }
            }
            return false;
        }

        if (target.messageId >= 0) {
            const targetBucket = buckets.get(toBranchKey(target));
            if (targetBucket && countBucketEntries(targetBucket) > 0) {
                return true;
            }
        }

        const unbound = buckets.get(UNBOUND_STAGED_KEY);
        return Boolean(unbound && countBucketEntries(unbound) > 0);
    }

    /** Enumerate pending staged entries visible for `target`. */
    listPending(target?: MessageTarget): Array<{ ns: string; key: string; entry: StoredDataEntry }> {
        const metadata = this.bridge.getMetadata();
        const buckets = this.getStagingBuckets(metadata, false);
        if (!buckets) {
            return [];
        }

        const merged = this.collectApplicablePending(buckets, target);
        const results: Array<{ ns: string; key: string; entry: StoredDataEntry }> = [];
        for (const [ns, entries] of Object.entries(merged)) {
            for (const [key, entry] of Object.entries(entries)) {
                results.push({ ns, key, entry: { ...entry } });
            }
        }
        return results;
    }

    /**
     * Atomically commit all pending staged writes for `target` (plus any unbound
     * pre-message writes) into `metadata.agentic_data.layers[toBranchKey(target)]`.
     */
    commitStagedData(target: MessageTarget): number {
        assertValidTarget(target);

        const metadata = this.bridge.getMetadata();
        const buckets = this.getStagingBuckets(metadata, false);
        if (!buckets || buckets.size === 0) {
            return 0;
        }

        const branchKey = toBranchKey(target);
        const unboundBucket = buckets.get(UNBOUND_STAGED_KEY);
        const targetBucket = buckets.get(branchKey);

        const planned: Array<{ ns: string; key: string; entry: StoredDataEntry }> = [];
        if (unboundBucket) {
            for (const [ns, entries] of Object.entries(unboundBucket)) {
                for (const [key, entry] of Object.entries(entries)) {
                    planned.push({ ns, key, entry: { ...entry } });
                }
            }
        }
        if (targetBucket) {
            for (const [ns, entries] of Object.entries(targetBucket)) {
                for (const [key, entry] of Object.entries(entries)) {
                    planned.push({ ns, key, entry: { ...entry } });
                }
            }
        }

        if (planned.length === 0) {
            buckets.delete(UNBOUND_STAGED_KEY);
            buckets.delete(branchKey);
            return 0;
        }

        const persisted = readPersistedAgenticData(metadata, true);
        if (!persisted) {
            throw new Error('HostBridge.getMetadata() did not return a writable metadata object');
        }

        if (!persisted.layers[branchKey]) {
            persisted.layers[branchKey] = {};
        }
        const layer = persisted.layers[branchKey];

        for (const item of planned) {
            if (!layer[item.ns]) {
                layer[item.ns] = {};
            }
            layer[item.ns][item.key] = item.entry;
            this.touchIndex(metadata, this.bridge.getChat(), item.ns, item.key, target.messageId, target.swipeId);
        }

        buckets.delete(UNBOUND_STAGED_KEY);
        buckets.delete(branchKey);
        invalidateHeadIndex();
        this.bridge.saveChatDebounced();
        return planned.length;
    }

    /**
     * Discard staged writes for `target`. When `target` is omitted or has
     * `messageId < 0`, discards unbound pre-message staged entries.
     */
    rollbackStagedData(target?: MessageTarget): number {
        const metadata = this.bridge.getMetadata();
        const buckets = this.getStagingBuckets(metadata, false);
        if (!buckets || buckets.size === 0) {
            return 0;
        }

        if (!target || target.messageId < 0) {
            const unbound = buckets.get(UNBOUND_STAGED_KEY);
            const count = unbound ? countBucketEntries(unbound) : 0;
            buckets.delete(UNBOUND_STAGED_KEY);
            return count;
        }

        const branchKey = toBranchKey(target);
        const bucket = buckets.get(branchKey);
        const count = bucket ? countBucketEntries(bucket) : 0;
        buckets.delete(branchKey);
        return count;
    }

    /**
     * Remove all committed layers and pending staged buckets for messages `>= messageId`
     * across all swipe branches (used on message deletion and regeneration).
     */
    pruneFromMessage(messageId: number): number {
        if (!Number.isInteger(messageId) || messageId < 0) {
            throw new Error(`Invalid messageId for pruneFromMessage: ${String(messageId)}`);
        }

        const metadata = this.bridge.getMetadata();
        let removedCount = 0;
        let persistedMutated = false;

        const persisted = readPersistedAgenticData(metadata, false);
        if (persisted) {
            for (const branchKey of Object.keys(persisted.layers)) {
                const parsed = parseBranchKey(branchKey);
                if (parsed && parsed.messageId >= messageId) {
                    removedCount += countBucketEntries(persisted.layers[branchKey]);
                    delete persisted.layers[branchKey];
                    persistedMutated = true;
                }
            }

            if (persisted.watermark > messageId) {
                persisted.watermark = messageId;
                persistedMutated = true;
            }
        }

        const buckets = this.getStagingBuckets(metadata, false);
        if (buckets) {
            for (const [bucketKey, bucket] of Array.from(buckets.entries())) {
                if (bucketKey === UNBOUND_STAGED_KEY) {
                    continue;
                }
                const parsed = parseBranchKey(bucketKey);
                if (parsed && parsed.messageId >= messageId) {
                    removedCount += countBucketEntries(bucket);
                    buckets.delete(bucketKey);
                }
            }
        }

        if (persistedMutated) {
            invalidateHeadIndex();
            this.bridge.saveChatDebounced();
        }

        return removedCount;
    }

    /** Remove committed layer and pending staged data for a single `(messageId, swipeId)` branch. */
    pruneSwipe(target: MessageTarget): number {
        assertValidTarget(target);
        const branchKey = toBranchKey(target);
        const metadata = this.bridge.getMetadata();
        let removedCount = 0;

        const persisted = readPersistedAgenticData(metadata, false);
        if (persisted && persisted.layers[branchKey]) {
            removedCount += countBucketEntries(persisted.layers[branchKey]);
            delete persisted.layers[branchKey];
            invalidateHeadIndex();
            this.bridge.saveChatDebounced();
        }

        const buckets = this.getStagingBuckets(metadata, false);
        const bucket = buckets?.get(branchKey);
        if (bucket) {
            removedCount += countBucketEntries(bucket);
            buckets?.delete(branchKey);
        }

        return removedCount;
    }

    /**
     * Collect the latest visible entry for every key in `ns` along the active swipe
     * chain starting from `opts.target` (first hit wins per key; tombstones mask older layers).
     */
    lookup(ns: string, opts: StoreLookupOptions = {}): DataLookupResult[] {
        const chat = this.bridge.getChat();
        const metadata = this.bridge.getMetadata();
        const includeDeleted = opts.includeDeleted === true;
        const results = new Map<string, DataLookupResult>();
        const seen = new Set<string>();

        if (opts.includeStaged) {
            const buckets = this.getStagingBuckets(metadata, false);
            if (buckets) {
                const staged = this.collectApplicablePending(buckets, opts.target);
                const stagedNs = staged[ns] ?? {};
                const stagedTarget = opts.target && opts.target.messageId >= 0
                    ? opts.target
                    : { messageId: -1, swipeId: 0 };
                for (const [key, entry] of Object.entries(stagedNs)) {
                    seen.add(key);
                    if (entry.deleted && !includeDeleted) {
                        continue;
                    }
                    results.set(key, {
                        key,
                        entry: { ...entry },
                        messageId: stagedTarget.messageId,
                        swipeId: stagedTarget.swipeId,
                    });
                }
            }
        }

        const resolved = this.resolveTarget(chat, opts.target);
        if (!isLayeredNamespace(ns)) {
            if (!resolved) {
                return Array.from(results.values());
            }
            for (const [key, entry] of Object.entries(
                this.readLayerEntries(metadata, chat, resolved.messageId, resolved.swipeId, ns),
            )) {
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                if (entry.deleted && !includeDeleted) {
                    continue;
                }
                results.set(key, {
                    key,
                    entry,
                    messageId: resolved.messageId,
                    swipeId: resolved.swipeId,
                });
            }
            return Array.from(results.values());
        }

        const start = resolved?.messageId ?? chat.length - 1;
        let remainingDepth = opts.depth ?? Number.MAX_SAFE_INTEGER;
        let reachedBottom = true;

        for (let i = start; i >= 0; --i) {
            if (remainingDepth < 0) {
                reachedBottom = false;
                break;
            }

            const swipe = i === start && opts.target ? opts.target.swipeId : chat[i]?.swipeId ?? 0;
            for (const [key, entry] of Object.entries(this.readLayerEntries(metadata, chat, i, swipe, ns))) {
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                if (entry.deleted && !includeDeleted) {
                    continue;
                }
                results.set(key, { key, entry, messageId: i, swipeId: swipe });
            }

            remainingDepth -= 1;
        }

        if (reachedBottom) {
            for (const [key, entry] of Object.entries(this.readBaseEntries(metadata, ns))) {
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);
                if (entry.deleted && !includeDeleted) {
                    continue;
                }
                results.set(key, { key, entry, messageId: -1, swipeId: 0 });
            }
        }

        return Array.from(results.values());
    }

    /**
     * Enumerate per-message entries over the trailing `depth` messages without
     * deduplication across messages (designed for non-layered namespaces like `message`).
     */
    scan(
        ns: string,
        opts: { depth?: number; includeHidden?: boolean; includeStaged?: boolean } = {},
    ): DataLookupResult[] {
        const chat = this.bridge.getChat();
        const metadata = this.bridge.getMetadata();
        const depth = opts.depth ?? 9;
        const includeHidden = opts.includeHidden === true;
        const results: DataLookupResult[] = [];

        const startIndex = Math.max(0, chat.length - 1 - depth);
        for (let i = startIndex; i < chat.length; ++i) {
            const msg = chat[i];
            if (!msg || (!includeHidden && msg.isSystem)) {
                continue;
            }

            const swipeId = msg.swipeId ?? 0;
            const entries = this.readLayerEntries(metadata, chat, i, swipeId, ns);
            for (const [key, entry] of Object.entries(entries)) {
                if (entry.deleted) {
                    continue;
                }
                results.push({ key, entry, messageId: i, swipeId });
            }
        }

        if (opts.includeStaged) {
            const buckets = this.getStagingBuckets(metadata, false);
            if (buckets) {
                for (const [bucketKey, bucket] of buckets.entries()) {
                    const parsed = bucketKey === UNBOUND_STAGED_KEY ? null : parseBranchKey(bucketKey);
                    for (const [key, entry] of Object.entries(bucket[ns] ?? {})) {
                        if (entry.deleted) {
                            continue;
                        }
                        results.push({
                            key,
                            entry: { ...entry },
                            messageId: parsed?.messageId ?? -1,
                            swipeId: parsed?.swipeId ?? 0,
                        });
                    }
                }
            }
        }

        return results;
    }

    /** Return legacy `metadata.variables` as a plain record when present and non-empty. */
    getLegacyMetadataVariables(): Record<string, unknown> | null {
        const raw = this.bridge.getMetadata()?.variables;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return null;
        }
        const record = raw as Record<string, unknown>;
        return Object.keys(record).length > 0 ? record : null;
    }

    /** Read all entries for a single `(messageId, swipeId)` and namespace (including legacy fallback). */
    readLayerEntries(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        messageId: number,
        swipeId: number,
        ns: string,
    ): Record<string, StoredDataEntry> {
        const results: Record<string, StoredDataEntry> = {};
        const msg = chat[messageId];
        const swipeInfo = msg?.swipeInfo?.[swipeId];

        // 1. Legacy fallback (lowest precedence within this layer)
        if (swipeInfo) {
            for (const [key, entry] of Object.entries(readLegacySwipeEntries(swipeInfo, ns))) {
                results[key] = entry;
            }
            for (const [key, entry] of Object.entries(swipeInfo.cg_data?.[ns] ?? {})) {
                results[key] = { ...entry };
            }
        }

        if (ns === DATA_NAMESPACES.VARIABLES && msg?.variables) {
            const legacyVars = msg.variables[swipeId];
            if (isNonEmptyPlainObject(legacyVars)) {
                results[VARIABLES_DOC_KEY] = {
                    source: 'legacy-variables',
                    content: formatVariablesJson(legacyVars),
                };
            }
        }

        // 2. Primary ST-Agentic layer (wins over legacy fields)
        const persisted = readPersistedAgenticData(metadata, false);
        const branchKey = toBranchKey({ messageId, swipeId });
        const agenticEntries = persisted?.layers[branchKey]?.[ns];
        if (agenticEntries) {
            for (const [key, entry] of Object.entries(agenticEntries)) {
                results[key] = { ...entry };
            }
        }

        return results;
    }

    private canUseIndex(
        chat: ChatMessageSnapshot[],
        ns: string,
        key: string,
        opts: StoreReadOptions,
    ): boolean {
        if (!isLayeredNamespace(ns)) {
            return false;
        }
        if (ns === DATA_NAMESPACES.VARIABLES && key !== VARIABLES_DOC_KEY && key !== '') {
            return false;
        }
        if (opts.maxDepth !== undefined) {
            return false;
        }
        if (opts.target && opts.target.messageId !== chat.length - 1) {
            return false;
        }
        return chat.length > 0;
    }

    private getIndexed(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        ns: string,
        key: string,
        swipeOverride: number | undefined,
        includeDeleted: boolean,
        opts: StoreReadOptions = {},
    ): StoredDataEntry | null {
        const index = this.ensureIndex(metadata, chat);
        const start = chat.length - 1;

        for (let i = start; i >= index.coldEnd; --i) {
            const swipe = i === start && swipeOverride !== undefined ? swipeOverride : chat[i]?.swipeId ?? 0;
            const entry = this.readLayerEntry(metadata, chat, i, swipe, ns, key);
            if (entry) {
                return this.applyVisibility(entry, includeDeleted);
            }
        }

        const head = index.heads.get(indexKey(ns, key));
        if (head) {
            const swipe = chat[head.messageId]?.swipeId ?? head.swipeId;
            const entry = this.readLayerEntry(metadata, chat, head.messageId, swipe, ns, key);
            if (entry) {
                return this.applyVisibility(entry, includeDeleted);
            }
            invalidateHeadIndex();
            return this.getSlow(metadata, chat, ns, key, {
                target: swipeOverride !== undefined ? { messageId: start, swipeId: swipeOverride } : undefined,
                includeDeleted,
                excludeLegacyMetadataVariables: opts.excludeLegacyMetadataVariables,
            });
        }

        return this.applyVisibility(
            this.readBaseEntry(metadata, ns, key, opts.excludeLegacyMetadataVariables === true),
            includeDeleted,
        );
    }

    private getSlow(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        ns: string,
        key: string,
        opts: StoreReadOptions,
    ): StoredDataEntry | null {
        const includeDeleted = opts.includeDeleted === true;
        const resolved = this.resolveTarget(chat, opts.target);
        if (resolved) {
            let depth = opts.maxDepth ?? Number.MAX_SAFE_INTEGER;
            for (let i = resolved.messageId; i >= 0; --i) {
                if (depth < 0) {
                    return null;
                }
                const swipe = i === resolved.messageId ? resolved.swipeId : chat[i]?.swipeId ?? 0;
                const entry = this.readLayerEntry(metadata, chat, i, swipe, ns, key);
                if (entry) {
                    return this.applyVisibility(entry, includeDeleted);
                }
                depth -= 1;
            }
        }

        if (opts.maxDepth === undefined) {
            return this.applyVisibility(
                this.readBaseEntry(metadata, ns, key, opts.excludeLegacyMetadataVariables === true),
                includeDeleted,
            );
        }

        return null;
    }

    private readStagedEntry(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        ns: string,
        key: string,
        target?: MessageTarget,
    ): StoredDataEntry | null {
        const buckets = this.getStagingBuckets(metadata, false);
        if (!buckets) {
            return null;
        }

        const effectiveTarget = target ?? this.resolveTarget(chat, undefined) ?? undefined;
        if (effectiveTarget && effectiveTarget.messageId >= 0) {
            const targetBucket = buckets.get(toBranchKey(effectiveTarget));
            const exact = this.readBucketEntry(targetBucket, ns, key);
            if (exact) {
                return exact;
            }
        }

        // Unbound pre-message staging applies when querying the active tip or explicitly unbound.
        const isTipQuery =
            !target
            || target.messageId < 0
            || chat.length === 0
            || target.messageId >= chat.length - 1;
        if (isTipQuery) {
            const unbound = buckets.get(UNBOUND_STAGED_KEY);
            return this.readBucketEntry(unbound, ns, key);
        }

        return null;
    }

    private readBucketEntry(
        bucket: NamespaceDataMap | undefined,
        ns: string,
        key: string,
    ): StoredDataEntry | null {
        if (!bucket?.[ns]) {
            return null;
        }
        const direct = bucket[ns][key];
        if (direct) {
            return { ...direct };
        }
        if (ns === DATA_NAMESPACES.VARIABLES && key !== VARIABLES_DOC_KEY && key !== '') {
            const doc = bucket[ns][VARIABLES_DOC_KEY];
            if (doc) {
                if (doc.deleted) {
                    return { ...doc };
                }
                return extractVariableKeyEntry(doc, key);
            }
        }
        return null;
    }

    private readLayerEntry(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        messageId: number,
        swipeId: number,
        ns: string,
        key: string,
    ): StoredDataEntry | null {
        // 1. Primary ST-Agentic persisted layer
        const persisted = readPersistedAgenticData(metadata, false);
        const branchKey = toBranchKey({ messageId, swipeId });
        const nsMap = persisted?.layers[branchKey]?.[ns];
        if (nsMap) {
            const entry = nsMap[key];
            if (entry) {
                return { ...entry };
            }
            if (ns === DATA_NAMESPACES.VARIABLES && key !== VARIABLES_DOC_KEY && key !== '') {
                const doc = nsMap[VARIABLES_DOC_KEY];
                if (doc) {
                    if (doc.deleted) {
                        return { ...doc };
                    }
                    const extracted = extractVariableKeyEntry(doc, key);
                    if (extracted) {
                        return extracted;
                    }
                }
            }
        }

        // 2. Legacy read-only fallback
        const msg = chat[messageId];
        const info = msg?.swipeInfo?.[swipeId];
        if (info) {
            const cgEntry = info.cg_data?.[ns]?.[key];
            if (cgEntry) {
                return { ...cgEntry };
            }

            if (ns === DATA_NAMESPACES.WORLDINFO) {
                const { world, uid } = splitWorldInfoKey(key);
                if (uid) {
                    const legacy = info.wi_overrides?.[world]?.[uid];
                    if (legacy) {
                        return { source: legacy.type, content: legacy.content };
                    }
                }
            } else if (ns === DATA_NAMESPACES.MESSAGE && key === MESSAGE_OVERRIDE_KEY) {
                if (typeof info.mes_override === 'string') {
                    return { source: 'legacy', content: info.mes_override };
                }
            }
        }

        if (ns === DATA_NAMESPACES.VARIABLES && msg?.variables) {
            const legacyVars = msg.variables[swipeId];
            if (isNonEmptyPlainObject(legacyVars)) {
                if (key === VARIABLES_DOC_KEY || key === '') {
                    return {
                        source: 'legacy-variables',
                        content: formatVariablesJson(legacyVars),
                    };
                }
                if (Object.hasOwn(legacyVars, key)) {
                    const val = legacyVars[key];
                    return {
                        source: 'legacy-variables',
                        content: typeof val === 'string' ? val : canonicalStringify(val),
                    };
                }
            }
        }

        return null;
    }

    private readBaseEntry(
        metadata: Record<string, unknown>,
        ns: string,
        key: string,
        excludeLegacyMetadataVariables: boolean = false,
    ): StoredDataEntry | null {
        const persisted = readPersistedAgenticData(metadata, false);
        const primary = persisted?.base?.[ns]?.[key];
        if (primary) {
            return { ...primary };
        }
        if (ns === DATA_NAMESPACES.VARIABLES && key !== VARIABLES_DOC_KEY && key !== '') {
            const primaryDoc = persisted?.base?.[ns]?.[VARIABLES_DOC_KEY];
            if (primaryDoc) {
                if (primaryDoc.deleted) {
                    return { ...primaryDoc };
                }
                const extracted = extractVariableKeyEntry(primaryDoc, key);
                if (extracted) {
                    return extracted;
                }
            }
        }

        // Legacy cg_state base fallback
        const legacyState = metadata[LEGACY_CG_STATE_KEY] as LegacyPersistedState | undefined;
        const legacyEntry = legacyState?.base?.[ns]?.[key];
        if (legacyEntry) {
            return { ...legacyEntry };
        }

        // Legacy chat metadata.variables fallback
        if (ns === DATA_NAMESPACES.VARIABLES && !excludeLegacyMetadataVariables) {
            const metaVars = this.getLegacyMetadataVariables();
            if (metaVars) {
                if (key === VARIABLES_DOC_KEY || key === '') {
                    return {
                        source: 'legacy-variables',
                        content: formatVariablesJson(metaVars),
                    };
                }
                if (Object.hasOwn(metaVars, key)) {
                    const val = metaVars[key];
                    return {
                        source: 'legacy-variables',
                        content: typeof val === 'string' ? val : canonicalStringify(val),
                    };
                }
            }
        }

        return null;
    }

    private readBaseEntries(metadata: Record<string, unknown>, ns: string): Record<string, StoredDataEntry> {
        const results: Record<string, StoredDataEntry> = {};

        if (ns === DATA_NAMESPACES.VARIABLES) {
            const metaVars = this.getLegacyMetadataVariables();
            if (metaVars) {
                results[VARIABLES_DOC_KEY] = {
                    source: 'legacy-variables',
                    content: formatVariablesJson(metaVars),
                };
            }
        }

        const legacyState = metadata[LEGACY_CG_STATE_KEY] as LegacyPersistedState | undefined;
        for (const [key, entry] of Object.entries(legacyState?.base?.[ns] ?? {})) {
            results[key] = { ...entry };
        }

        const persisted = readPersistedAgenticData(metadata, false);
        for (const [key, entry] of Object.entries(persisted?.base?.[ns] ?? {})) {
            results[key] = { ...entry };
        }

        return results;
    }

    private applyVisibility(entry: StoredDataEntry | null, includeDeleted: boolean): StoredDataEntry | null {
        if (!entry) {
            return null;
        }
        return entry.deleted && !includeDeleted ? null : entry;
    }

    private resolveTarget(chat: ChatMessageSnapshot[], target?: MessageTarget): MessageTarget | null {
        if (target) {
            if (target.messageId < 0 || target.swipeId < 0) {
                return null;
            }
            return target;
        }

        if (chat.length === 0) {
            return null;
        }

        const messageId = chat.length - 1;
        const swipeId = chat[messageId]?.swipeId ?? 0;
        return { messageId, swipeId };
    }

    private resolveWriteTarget(chat: ChatMessageSnapshot[], target?: MessageTarget): MessageTarget {
        if (target) {
            assertValidTarget(target);
            return target;
        }

        if (chat.length === 0) {
            throw new Error('Cannot write committed layer without a target when chat is empty; stage the write instead');
        }

        const messageId = chat.length - 1;
        const swipeId = chat[messageId]?.swipeId ?? 0;
        return { messageId, swipeId };
    }

    private writeCommittedLayer(
        ns: string,
        key: string,
        entry: StoredDataEntry,
        target: MessageTarget,
    ): void {
        const metadata = this.bridge.getMetadata();
        const persisted = readPersistedAgenticData(metadata, true);
        if (!persisted) {
            throw new Error('HostBridge.getMetadata() did not return a writable metadata object');
        }

        const branchKey = toBranchKey(target);
        if (!persisted.layers[branchKey]) {
            persisted.layers[branchKey] = {};
        }
        if (!persisted.layers[branchKey][ns]) {
            persisted.layers[branchKey][ns] = {};
        }

        persisted.layers[branchKey][ns][key] = entry;
        this.touchIndex(metadata, this.bridge.getChat(), ns, key, target.messageId, target.swipeId);
        this.bridge.saveChatDebounced();
    }

    private stageEntry(
        ns: string,
        key: string,
        entry: StoredDataEntry,
        target?: MessageTarget,
    ): void {
        const metadata = this.bridge.getMetadata();
        const buckets = this.getStagingBuckets(metadata, true);
        const bucketKey = resolveStagingBucketKey(target);

        let bucket = buckets.get(bucketKey);
        if (!bucket) {
            bucket = {};
            buckets.set(bucketKey, bucket);
        }
        if (!bucket[ns]) {
            bucket[ns] = {};
        }
        bucket[ns][key] = entry;
    }

    private getStagingBuckets(metadata: Record<string, unknown>, create: true): PendingBucketMap;
    private getStagingBuckets(metadata: Record<string, unknown>, create: false): PendingBucketMap | undefined;
    private getStagingBuckets(
        metadata: Record<string, unknown>,
        create: boolean,
    ): PendingBucketMap | undefined {
        let map = STAGING_BY_METADATA.get(metadata);
        if (!map && create) {
            map = new Map<string, NamespaceDataMap>();
            STAGING_BY_METADATA.set(metadata, map);
        }
        return map;
    }

    private collectApplicablePending(
        buckets: PendingBucketMap,
        target?: MessageTarget,
    ): NamespaceDataMap {
        const merged: NamespaceDataMap = {};
        const mergeBucket = (bucket: NamespaceDataMap | undefined) => {
            if (!bucket) {
                return;
            }
            for (const [ns, entries] of Object.entries(bucket)) {
                if (!merged[ns]) {
                    merged[ns] = {};
                }
                for (const [key, entry] of Object.entries(entries)) {
                    merged[ns][key] = { ...entry };
                }
            }
        };

        const chat = this.bridge.getChat();
        const isTipOrUnbound =
            !target
            || target.messageId < 0
            || chat.length === 0
            || target.messageId >= chat.length - 1;
        if (isTipOrUnbound) {
            mergeBucket(buckets.get(UNBOUND_STAGED_KEY));
        }

        const effectiveTarget = target ?? this.resolveTarget(chat, undefined) ?? undefined;
        if (effectiveTarget && effectiveTarget.messageId >= 0) {
            mergeBucket(buckets.get(toBranchKey(effectiveTarget)));
        }

        return merged;
    }

    private ensureIndex(metadata: Record<string, unknown>, chat: ChatMessageSnapshot[]): HeadIndex {
        const persisted = readPersistedAgenticData(metadata, false);
        const watermark = persisted?.watermark ?? 0;
        const coldEnd = Math.max(watermark, chat.length - HOT_WINDOW);
        const cached = HEAD_INDEX_CACHE.get(metadata);

        if (
            cached
            && cached.epoch === globalIndexEpoch
            && cached.watermark === watermark
            && this.coldSwipesMatch(cached, chat, watermark)
        ) {
            if (cached.chatLength === chat.length) {
                return cached;
            }
            if (chat.length > cached.chatLength && coldEnd >= cached.coldEnd) {
                this.indexRange(metadata, chat, cached, cached.coldEnd, coldEnd);
                cached.coldEnd = coldEnd;
                cached.chatLength = chat.length;
                cached.coldSwipes = snapshotSwipes(chat, watermark, coldEnd);
                return cached;
            }
        }

        const built: HeadIndex = {
            heads: new Map(),
            coldEnd,
            watermark,
            chatLength: chat.length,
            coldSwipes: snapshotSwipes(chat, watermark, coldEnd),
            epoch: globalIndexEpoch,
        };
        this.indexRange(metadata, chat, built, watermark, coldEnd);
        HEAD_INDEX_CACHE.set(metadata, built);
        return built;
    }

    private coldSwipesMatch(
        cached: HeadIndex,
        chat: ChatMessageSnapshot[],
        watermark: number,
    ): boolean {
        const len = cached.coldSwipes.length;
        for (let offset = 0; offset < len; ++offset) {
            const msgIndex = watermark + offset;
            if ((chat[msgIndex]?.swipeId ?? 0) !== cached.coldSwipes[offset]) {
                return false;
            }
        }
        return true;
    }

    private indexRange(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        index: HeadIndex,
        from: number,
        to: number,
    ): void {
        const persisted = readPersistedAgenticData(metadata, false);

        for (let i = to - 1; i >= from; --i) {
            const msg = chat[i];
            if (!msg) {
                continue;
            }
            const swipeId = msg.swipeId ?? 0;
            const namespaces = new Set<string>();

            const agenticLayer = persisted?.layers[toBranchKey({ messageId: i, swipeId })];
            if (agenticLayer) {
                for (const ns of Object.keys(agenticLayer)) {
                    if (isLayeredNamespace(ns)) {
                        namespaces.add(ns);
                    }
                }
            }

            const swipeInfo = msg.swipeInfo?.[swipeId];
            if (swipeInfo) {
                for (const ns of Object.keys(swipeInfo.cg_data ?? {})) {
                    if (isLayeredNamespace(ns)) {
                        namespaces.add(ns);
                    }
                }
                if (swipeInfo.wi_overrides && Object.keys(swipeInfo.wi_overrides).length > 0) {
                    namespaces.add(DATA_NAMESPACES.WORLDINFO);
                }
            }

            if (isNonEmptyPlainObject(msg.variables?.[swipeId])) {
                namespaces.add(DATA_NAMESPACES.VARIABLES);
            }

            for (const ns of namespaces) {
                for (const key of Object.keys(this.readLayerEntries(metadata, chat, i, swipeId, ns))) {
                    const id = indexKey(ns, key);
                    const known = index.heads.get(id);
                    if (!known || known.messageId < i) {
                        index.heads.set(id, { messageId: i, swipeId });
                    }
                }
            }
        }
    }

    private touchIndex(
        metadata: Record<string, unknown>,
        chat: ChatMessageSnapshot[],
        ns: string,
        key: string,
        messageId: number,
        swipeId: number,
    ): void {
        if (!isLayeredNamespace(ns)) {
            return;
        }
        const index = HEAD_INDEX_CACHE.get(metadata);
        if (!index || index.epoch !== globalIndexEpoch) {
            return;
        }
        if (messageId >= index.coldEnd) {
            return;
        }
        if ((chat[messageId]?.swipeId ?? 0) !== swipeId) {
            return;
        }
        const id = indexKey(ns, key);
        const known = index.heads.get(id);
        if (!known || known.messageId <= messageId) {
            index.heads.set(id, { messageId, swipeId });
        }
    }
}

function indexKey(ns: string, key: string): string {
    return `${ns}\u0000${key}`;
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

function normalizeWriteOptions(optsOrTarget?: StoreWriteOptions | MessageTarget): StoreWriteOptions {
    if (!optsOrTarget) {
        return {};
    }
    if ('messageId' in optsOrTarget && 'swipeId' in optsOrTarget) {
        return { target: optsOrTarget };
    }
    return optsOrTarget;
}

function resolveStagingBucketKey(target?: MessageTarget): string {
    if (!target || target.messageId < 0) {
        return UNBOUND_STAGED_KEY;
    }
    assertValidTarget(target);
    return toBranchKey(target);
}

function countBucketEntries(bucket: NamespaceDataMap): number {
    let count = 0;
    for (const entries of Object.values(bucket)) {
        count += Object.keys(entries).length;
    }
    return count;
}

function snapshotSwipes(
    chat: ChatMessageSnapshot[],
    from: number,
    to: number,
): number[] {
    const swipes: number[] = [];
    for (let i = from; i < to; ++i) {
        swipes.push(chat[i]?.swipeId ?? 0);
    }
    return swipes;
}

function isNonEmptyPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(
        value
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.keys(value as Record<string, unknown>).length > 0,
    );
}

function formatVariablesJson(vars: Record<string, unknown>): string {
    return JSON.stringify(canonicalClone(vars), null, 2);
}

function extractVariableKeyEntry(doc: StoredDataEntry, key: string): StoredDataEntry | null {
    try {
        const parsed = JSON.parse(doc.content) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        const record = parsed as Record<string, unknown>;
        if (!Object.hasOwn(record, key)) {
            return null;
        }
        const val = record[key];
        return {
            source: doc.source,
            content: typeof val === 'string' ? val : canonicalStringify(val),
        };
    } catch {
        return null;
    }
}

function readLegacySwipeEntries(
    info: SwipeDataSnapshot,
    ns: string,
): Record<string, StoredDataEntry> {
    const results: Record<string, StoredDataEntry> = {};

    if (ns === DATA_NAMESPACES.WORLDINFO && info.wi_overrides) {
        for (const [world, entries] of Object.entries(info.wi_overrides)) {
            for (const [uid, legacy] of Object.entries(entries)) {
                results[worldInfoKey(world, uid)] = {
                    source: legacy.type,
                    content: legacy.content,
                };
            }
        }
    } else if (ns === DATA_NAMESPACES.MESSAGE && typeof info.mes_override === 'string') {
        results[MESSAGE_OVERRIDE_KEY] = {
            source: 'legacy',
            content: info.mes_override,
        };
    }

    return results;
}
