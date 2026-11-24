import type { HostBridge } from '@/core/bridge';
import {
    type CompactionReport,
    type NamespaceDataMap,
    type StoredDataEntry,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalStringify } from '@/core/utils';
import {
    type AgenticPersistedData,
    ChatDataStore,
    HOT_WINDOW,
    invalidateHeadIndex,
    isCompactableNamespace,
    readPersistedAgenticData,
} from './chat-data-store';

export interface CompactColdLayersOptions {
    /** When true, computes the full report without mutating metadata or calling save. */
    dryRun?: boolean;
    /** Number of trailing hot messages whose per-swipe layers remain untouched. */
    keepDepth?: number;
    /** Include legacy `cg_data` / `wi_overrides` / `message.variables` inside cold range (default true). */
    includeLegacy?: boolean;
    /** Prune cold `/scratch/**` temporary drafts no longer touched in the hot window (default true). */
    pruneColdScratch?: boolean;
}

export const DEFAULT_KEEP_DEPTH = 32;

const textEncoder = new TextEncoder();

function isScratchFileKey(key: string): boolean {
    return key.replace(/^\/+/, '').toLowerCase().startsWith('scratch/');
}

function measureUtf8Bytes(value: unknown): number {
    if (value == null) {
        return 0;
    }
    return textEncoder.encode(canonicalStringify(value)).length;
}

function cloneNamespaceDataMap(source: NamespaceDataMap | undefined): NamespaceDataMap {
    const copy: NamespaceDataMap = {};
    if (!source) {
        return copy;
    }
    for (const [ns, entries] of Object.entries(source)) {
        copy[ns] = {};
        for (const [key, entry] of Object.entries(entries)) {
            copy[ns][key] = { ...entry };
        }
    }
    return copy;
}

function cloneLayersMap(
    source: Record<string, NamespaceDataMap> | undefined,
): Record<string, NamespaceDataMap> {
    const copy: Record<string, NamespaceDataMap> = {};
    if (!source) {
        return copy;
    }
    for (const [branchKey, nsMap] of Object.entries(source)) {
        copy[branchKey] = cloneNamespaceDataMap(nsMap);
    }
    return copy;
}

function collectCompactableNamespacesInLayer(
    store: ChatDataStore,
    metadata: Record<string, unknown>,
    chat: ReturnType<HostBridge['getChat']>,
    messageId: number,
    swipeId: number,
    persisted: AgenticPersistedData | null,
    includeLegacy: boolean,
): Set<string> {
    const namespaces = new Set<string>();
    const branchKey = toBranchKey({ messageId, swipeId });
    const agenticLayer = persisted?.layers[branchKey];

    if (agenticLayer) {
        for (const ns of Object.keys(agenticLayer)) {
            if (isCompactableNamespace(ns)) {
                namespaces.add(ns);
            }
        }
    }

    if (includeLegacy) {
        const msg = chat[messageId];
        const swipeInfo = msg?.swipeInfo?.[swipeId];
        if (swipeInfo) {
            for (const ns of Object.keys(swipeInfo.cg_data ?? {})) {
                if (isCompactableNamespace(ns)) {
                    namespaces.add(ns);
                }
            }
            if (swipeInfo.wi_overrides && Object.keys(swipeInfo.wi_overrides).length > 0) {
                namespaces.add('worldinfo');
            }
        }
        const legacyVars = msg?.variables?.[swipeId];
        if (
            legacyVars
            && typeof legacyVars === 'object'
            && !Array.isArray(legacyVars)
            && Object.keys(legacyVars).length > 0
        ) {
            namespaces.add('variables');
        }
    }

    // Keep reference to store used in caller; helper stays pure.
    void store;
    return namespaces;
}

/**
 * Cold-layer physical compactor for `ChatDataStore`.
 *
 * Losslessly flattens cold `[0 .. chat.length - keepDepth)` layered entries along
 * each message's active swipe chain into `metadata.agentic_data.base` (preserving
 * `deleted: true` tombstones), drops cold swipe branches for compactable namespaces,
 * and preserves the trailing `keepDepth` hot window and non-layered `message` overrides.
 */
export class DataCompactor {
    private readonly store: ChatDataStore;

    constructor(private readonly bridge: HostBridge) {
        this.store = new ChatDataStore(bridge);
    }

    /** Current compacted message watermark (`chat[0 .. watermark)` already flattened). */
    getWatermark(): number {
        const persisted = readPersistedAgenticData(this.bridge.getMetadata(), false);
        return persisted?.watermark ?? 0;
    }

    /** Estimated serialized byte size of `metadata.agentic_data`. */
    estimateBytes(): number {
        const persisted = readPersistedAgenticData(this.bridge.getMetadata(), false);
        return measureUtf8Bytes(persisted);
    }

    /** Count total stored entry keys across all active layer branches. */
    countLayers(): number {
        const persisted = readPersistedAgenticData(this.bridge.getMetadata(), false);
        if (!persisted) {
            return 0;
        }
        let count = 0;
        for (const nsMap of Object.values(persisted.layers)) {
            for (const entries of Object.values(nsMap)) {
                count += Object.keys(entries).length;
            }
        }
        return count;
    }

    /**
     * Flatten cold layers older than `keepDepth` into `metadata.agentic_data.base`.
     * Supports `dryRun` for non-mutating byte/layer estimation.
     */
    compactColdLayers(options: CompactColdLayersOptions = {}): CompactionReport {
        const dryRun = options.dryRun === true;
        const keepDepth = Math.max(0, options.keepDepth ?? DEFAULT_KEEP_DEPTH);
        const includeLegacy = options.includeLegacy !== false;
        const pruneColdScratch = options.pruneColdScratch !== false;

        const chat = this.bridge.getChat();
        const metadata = this.bridge.getMetadata();
        const current = readPersistedAgenticData(metadata, false);
        const previousWatermark = current?.watermark ?? 0;
        const coldEnd = Math.max(0, chat.length - keepDepth);
        const estimatedBytesBefore = measureUtf8Bytes(current);

        const hotScratchKeys = new Set<string>();
        if (pruneColdScratch && coldEnd > 0 && current) {
            for (const branchKey of Object.keys(current.layers)) {
                const parsed = parseBranchKey(branchKey);
                if (!parsed || parsed.messageId < coldEnd) {
                    continue;
                }
                const fileEntries = current.layers[branchKey]?.files;
                if (!fileEntries) {
                    continue;
                }
                for (const key of Object.keys(fileEntries)) {
                    if (isScratchFileKey(key)) {
                        hotScratchKeys.add(key);
                    }
                }
            }
        }

        const hasLingeringColdLayer = current
            ? Object.keys(current.layers).some((branchKey) => {
                const parsed = parseBranchKey(branchKey);
                if (!parsed || parsed.messageId >= coldEnd) {
                    return false;
                }
                return Object.keys(current.layers[branchKey]).some((ns) => isCompactableNamespace(ns));
            })
            : false;

        const hasColdScratchInBase =
            pruneColdScratch && coldEnd > 0 && current?.base?.files
                ? Object.keys(current.base.files).some(
                    (key) => isScratchFileKey(key) && !hotScratchKeys.has(key),
                )
                : false;

        if (coldEnd <= previousWatermark && !hasLingeringColdLayer && !hasColdScratchInBase) {
            return {
                dryRun,
                compactedMessages: 0,
                removedLayers: 0,
                flattenedEntries: 0,
                estimatedBytesBefore,
                estimatedBytesAfter: estimatedBytesBefore,
                freedBytes: 0,
                previousWatermark,
                newWatermark: previousWatermark,
                prunedScratchFiles: 0,
            };
        }

        const newWatermark = Math.max(previousWatermark, coldEnd);
        const workingBase = cloneNamespaceDataMap(current?.base);
        const workingLayers = cloneLayersMap(current?.layers);

        // 1. Collect newest visible entry per (ns, key) along the active swipe chain
        // in the newly cold range [previousWatermark .. coldEnd), plus any uncompacted
        // agentic_data layers below previousWatermark.
        const collected: Record<string, Record<string, StoredDataEntry>> = {};

        for (let i = coldEnd - 1; i >= 0; --i) {
            const msg = chat[i];
            const swipeId = msg?.swipeId ?? 0;
            const allowLegacyAtI = includeLegacy && i >= previousWatermark;
            const namespaces = collectCompactableNamespacesInLayer(
                this.store,
                metadata,
                chat,
                i,
                swipeId,
                current,
                allowLegacyAtI,
            );

            for (const ns of namespaces) {
                if (!collected[ns]) {
                    collected[ns] = {};
                }
                const entries = allowLegacyAtI
                    ? this.store.readLayerEntries(metadata, chat, i, swipeId, ns)
                    : (current?.layers[toBranchKey({ messageId: i, swipeId })]?.[ns] ?? {});

                for (const [key, entry] of Object.entries(entries)) {
                    if (!Object.hasOwn(collected[ns], key)) {
                        collected[ns][key] = entry.deleted
                            ? { source: entry.source, content: '', deleted: true }
                            : { source: entry.source, content: entry.content };
                    }
                }
            }
        }

        let flattenedEntries = 0;
        const prunedScratchKeys = new Set<string>();
        for (const [ns, entries] of Object.entries(collected)) {
            if (!workingBase[ns]) {
                workingBase[ns] = {};
            }
            for (const [key, entry] of Object.entries(entries)) {
                if (
                    pruneColdScratch
                    && coldEnd > 0
                    && ns === 'files'
                    && isScratchFileKey(key)
                    && !hotScratchKeys.has(key)
                ) {
                    prunedScratchKeys.add(key);
                    delete workingBase[ns][key];
                    continue;
                }
                workingBase[ns][key] = entry;
                flattenedEntries += 1;
            }
        }

        if (pruneColdScratch && coldEnd > 0 && workingBase.files) {
            for (const key of Object.keys(workingBase.files)) {
                if (isScratchFileKey(key) && !hotScratchKeys.has(key)) {
                    delete workingBase.files[key];
                    prunedScratchKeys.add(key);
                }
            }
        }

        // 2. Drop all compactable layers (across ALL swipe branches) below coldEnd.
        let removedLayers = 0;
        for (const branchKey of Object.keys(workingLayers)) {
            const parsed = parseBranchKey(branchKey);
            if (!parsed || parsed.messageId >= coldEnd) {
                continue;
            }
            const layer = workingLayers[branchKey];
            for (const ns of Object.keys(layer)) {
                if (!isCompactableNamespace(ns)) {
                    continue;
                }
                removedLayers += Object.keys(layer[ns]).length;
                delete layer[ns];
            }
            if (Object.keys(layer).length === 0) {
                delete workingLayers[branchKey];
            }
        }

        const nextPersisted: AgenticPersistedData = {
            version: 1,
            watermark: newWatermark,
            base: workingBase,
            layers: workingLayers,
        };

        const estimatedBytesAfter = measureUtf8Bytes(nextPersisted);
        const freedBytes = Math.max(0, estimatedBytesBefore - estimatedBytesAfter);
        const compactedMessages = Math.max(0, coldEnd - previousWatermark);
        const prunedScratchFiles = prunedScratchKeys.size;

        if (!dryRun) {
            const target = readPersistedAgenticData(metadata, true);
            if (!target) {
                throw new Error('HostBridge.getMetadata() did not return a writable metadata object');
            }
            target.version = 1;
            target.watermark = nextPersisted.watermark;
            target.base = nextPersisted.base;
            target.layers = nextPersisted.layers;

            invalidateHeadIndex();
            this.bridge.saveChatDebounced();
        }

        return {
            dryRun,
            compactedMessages,
            removedLayers,
            flattenedEntries,
            estimatedBytesBefore,
            estimatedBytesAfter,
            freedBytes,
            previousWatermark,
            newWatermark,
            prunedScratchFiles,
        };
    }

    /** Convenience helper matching `HOT_WINDOW` minimum when caller wants default safe depth. */
    static get minRecommendedKeepDepth(): number {
        return HOT_WINDOW + 1;
    }
}

/** Functional wrapper around `new DataCompactor(bridge).compactColdLayers(options)`. */
export function compactColdLayers(
    bridge: HostBridge,
    options?: CompactColdLayersOptions,
): CompactionReport {
    return new DataCompactor(bridge).compactColdLayers(options);
}
