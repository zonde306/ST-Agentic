import type { HostBridge, ToolSideCluesApi } from '@/core/bridge';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import {
    type ExportWorldInfoOptions,
    type ExportWorldInfoResult,
    type MessageTarget,
    type SideClueDelivery,
    type SideClueDoc,
    type SideClueMeta,
    type SideClueStatus,
    type SideClueWriteInput,
    type WorldInfoEntryUpsert,
    toBranchKey,
} from '@/core/types';
import {
    DEFAULT_SIDE_CLUE_DELIVERY,
    DEFAULT_SIDE_CLUE_STATUS,
    isValidSideClueDelivery,
    isValidSideClueStatus,
    normalizeVfsPath,
    parseSideClue,
    serializeSideClueWithHash,
} from '@/core/utils';

export const SIDE_CLUE_MOUNT_PREFIX = '/side';

export interface NormalizedSideCluePath {
    /** Canonical VFS path starting with `/side/`. */
    path: string;
    /** Key relative to `/side/`, matching `DATA_NAMESPACES.SIDE_FILES` storage keys. */
    relKey: string;
}

/**
 * Storage abstraction backing `/side/*` clues so `SideCluesFacade` works identically
 * against `ChatDataStore` (`DATA_NAMESPACES.SIDE_FILES`) or a mounted `VirtualFileSystem`.
 */
export interface SideClueStorageAdapter {
    readRaw(path: string, target?: MessageTarget): Promise<string | null>;
    writeRaw(
        path: string,
        content: string,
        opts?: { target?: MessageTarget; source?: string },
    ): Promise<void>;
    deleteRaw(path: string, target?: MessageTarget): Promise<boolean>;
    listRaw(target?: MessageTarget): Promise<Array<{ path: string; content: string }>>;
}

/** Minimal VFS subset accepted by `createVfsSideClueStorage` without tight coupling to mounts. */
export interface SideClueVfsLike {
    readFile(path: string, opts?: { target?: MessageTarget; staged?: boolean }): Promise<string>;
    writeFile(
        path: string,
        content: string,
        opts?: { target?: MessageTarget; staged?: boolean; source?: string },
    ): Promise<void>;
    deleteFile(
        path: string,
        opts?: { target?: MessageTarget; staged?: boolean; source?: string },
    ): Promise<boolean>;
    listFiles?(opts?: {
        target?: MessageTarget;
        staged?: boolean;
    }): Promise<Array<{ path: string; kind: 'file' | 'directory' }>>;
    listDir?(
        path: string,
        opts?: { target?: MessageTarget; staged?: boolean },
    ): Promise<Array<{ path: string; kind: 'file' | 'directory' }>>;
}

export interface SideCluesFacadeOptions {
    bridge: HostBridge;
    store?: ChatDataStore;
    vfs?: SideClueVfsLike;
    storage?: SideClueStorageAdapter;
    defaultDelivery?: SideClueDelivery;
    resolveAnchor?: () => MessageTarget;
    now?: () => number;
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
 * Normalize a `/side/*` clue path (rejecting traversal and paths outside `/side/*`).
 * Relative paths without a leading `/` are automatically anchored under `/side/`.
 */
export function normalizeSideCluePath(inputPath: string): NormalizedSideCluePath {
    if (typeof inputPath !== 'string') {
        throw new Error('Side clue path must be a non-empty string');
    }
    const trimmed = inputPath.trim();
    if (!trimmed) {
        throw new Error('Side clue path must not be empty');
    }

    const isAbsolute = trimmed.startsWith('/') || trimmed.startsWith('\\');
    const normalized = normalizeVfsPath(trimmed);

    let fullPath: string;
    if (isAbsolute) {
        if (!normalized.startsWith(`${SIDE_CLUE_MOUNT_PREFIX}/`)) {
            throw new Error(`Side clue path must be under ${SIDE_CLUE_MOUNT_PREFIX}/*: ${inputPath}`);
        }
        fullPath = normalized;
    } else if (normalized === SIDE_CLUE_MOUNT_PREFIX) {
        throw new Error(`Side clue path must name a file under ${SIDE_CLUE_MOUNT_PREFIX}/*: ${inputPath}`);
    } else if (normalized.startsWith(`${SIDE_CLUE_MOUNT_PREFIX}/`)) {
        fullPath = normalized;
    } else {
        fullPath = `${SIDE_CLUE_MOUNT_PREFIX}${normalized}`;
    }

    const relKey = fullPath.slice(`${SIDE_CLUE_MOUNT_PREFIX}/`.length);
    if (!relKey || relKey.endsWith('/')) {
        throw new Error(`Side clue path must name a file under ${SIDE_CLUE_MOUNT_PREFIX}/*: ${inputPath}`);
    }

    return { path: fullPath, relKey };
}

function isNotFoundError(err: unknown): boolean {
    if (!err || typeof err !== 'object') {
        return false;
    }
    const record = err as { code?: unknown; name?: unknown; message?: unknown };
    if (record.code === 'ENOENT' || record.name === 'VfsNotFoundError') {
        return true;
    }
    return typeof record.message === 'string' && /not found/i.test(record.message);
}

/**
 * Default branch-safe `/side/*` storage backed directly by `ChatDataStore`
 * (`DATA_NAMESPACES.SIDE_FILES`), matching the key layout of `SideMount`.
 */
export function createStoreSideClueStorage(store: ChatDataStore): SideClueStorageAdapter {
    return {
        async readRaw(path: string, target?: MessageTarget): Promise<string | null> {
            const { path: fullPath, relKey } = normalizeSideCluePath(path);
            const entry =
                store.get(DATA_NAMESPACES.SIDE_FILES, relKey, { target, includeStaged: true })
                ?? store.get(DATA_NAMESPACES.SIDE_FILES, fullPath, { target, includeStaged: true });
            return entry ? entry.content : null;
        },

        async writeRaw(
            path: string,
            content: string,
            opts?: { target?: MessageTarget; source?: string },
        ): Promise<void> {
            const { relKey } = normalizeSideCluePath(path);
            store.set(
                DATA_NAMESPACES.SIDE_FILES,
                relKey,
                opts?.source ?? 'sidegen',
                content,
                { target: opts?.target, staged: false },
            );
        },

        async deleteRaw(path: string, target?: MessageTarget): Promise<boolean> {
            const { path: fullPath, relKey } = normalizeSideCluePath(path);
            const erasedRel = store.erase(DATA_NAMESPACES.SIDE_FILES, relKey, 'sidegen-delete', {
                target,
                staged: false,
            });
            const erasedFull = store.erase(DATA_NAMESPACES.SIDE_FILES, fullPath, 'sidegen-delete', {
                target,
                staged: false,
            });
            return erasedRel || erasedFull;
        },

        async listRaw(target?: MessageTarget): Promise<Array<{ path: string; content: string }>> {
            const entries = store.lookup(DATA_NAMESPACES.SIDE_FILES, {
                target,
                includeStaged: true,
            });
            const byPath = new Map<string, string>();
            for (const item of entries) {
                try {
                    const { path } = normalizeSideCluePath(item.key);
                    byPath.set(path, item.entry.content);
                } catch {
                    // Ignore malformed legacy keys outside /side/*
                }
            }
            return Array.from(byPath.entries())
                .sort(([a], [b]) => compareCodeUnits(a, b))
                .map(([path, content]) => ({ path, content }));
        },
    };
}

/**
 * Optional VFS-backed `/side/*` storage adapter for wiring with a mounted `VirtualFileSystem`.
 */
export function createVfsSideClueStorage(vfs: SideClueVfsLike): SideClueStorageAdapter {
    const collectPathsRecursive = async (
        dirPath: string,
        target?: MessageTarget,
    ): Promise<string[]> => {
        if (!vfs.listDir) {
            return [];
        }
        let entries: Array<{ path: string; kind: 'file' | 'directory' }>;
        try {
            entries = await vfs.listDir(dirPath, { target, staged: false });
        } catch (err) {
            if (isNotFoundError(err)) {
                return [];
            }
            throw err;
        }
        const files: string[] = [];
        for (const entry of entries) {
            if (entry.kind === 'directory') {
                const nested = await collectPathsRecursive(entry.path, target);
                files.push(...nested);
            } else if (entry.path.startsWith(`${SIDE_CLUE_MOUNT_PREFIX}/`)) {
                files.push(entry.path);
            }
        }
        return files;
    };

    return {
        async readRaw(path: string, target?: MessageTarget): Promise<string | null> {
            const { path: fullPath } = normalizeSideCluePath(path);
            try {
                return await vfs.readFile(fullPath, { target, staged: false });
            } catch (err) {
                if (isNotFoundError(err)) {
                    return null;
                }
                throw err;
            }
        },

        async writeRaw(
            path: string,
            content: string,
            opts?: { target?: MessageTarget; source?: string },
        ): Promise<void> {
            const { path: fullPath } = normalizeSideCluePath(path);
            await vfs.writeFile(fullPath, content, {
                target: opts?.target,
                staged: false,
                source: opts?.source ?? 'sidegen',
            });
        },

        async deleteRaw(path: string, target?: MessageTarget): Promise<boolean> {
            const { path: fullPath } = normalizeSideCluePath(path);
            try {
                return await vfs.deleteFile(fullPath, {
                    target,
                    staged: false,
                    source: 'sidegen-delete',
                });
            } catch (err) {
                if (isNotFoundError(err)) {
                    return false;
                }
                throw err;
            }
        },

        async listRaw(target?: MessageTarget): Promise<Array<{ path: string; content: string }>> {
            let paths: string[];
            if (vfs.listDir) {
                paths = await collectPathsRecursive(SIDE_CLUE_MOUNT_PREFIX, target);
            } else if (vfs.listFiles) {
                const all = await vfs.listFiles({ target, staged: false });
                paths = all
                    .filter((item) => item.kind === 'file' && item.path.startsWith(`${SIDE_CLUE_MOUNT_PREFIX}/`))
                    .map((item) => item.path);
            } else {
                paths = [];
            }

            const uniqueSorted = Array.from(new Set(paths)).sort(compareCodeUnits);
            const results: Array<{ path: string; content: string }> = [];
            for (const path of uniqueSorted) {
                try {
                    const content = await vfs.readFile(path, { target, staged: false });
                    results.push({ path, content });
                } catch (err) {
                    if (!isNotFoundError(err)) {
                        throw err;
                    }
                }
            }
            return results;
        },
    };
}

/**
 * Branch-safe `/side/*` clue management facade implementing `ToolSideCluesApi`.
 */
export class SideCluesFacade implements ToolSideCluesApi {
    private readonly bridge: HostBridge;
    private readonly storage: SideClueStorageAdapter;
    private readonly defaultDelivery: SideClueDelivery;
    private readonly resolveAnchorFn?: () => MessageTarget;
    private readonly nowFn: () => number;

    constructor(options: SideCluesFacadeOptions) {
        this.bridge = options.bridge;
        if (options.storage) {
            this.storage = options.storage;
        } else if (options.vfs) {
            this.storage = createVfsSideClueStorage(options.vfs);
        } else {
            const store = options.store ?? new ChatDataStore(options.bridge);
            this.storage = createStoreSideClueStorage(store);
        }
        this.defaultDelivery = options.defaultDelivery ?? DEFAULT_SIDE_CLUE_DELIVERY;
        this.resolveAnchorFn = options.resolveAnchor;
        this.nowFn = options.now ?? (() => Date.now());
    }

    async write(input: SideClueWriteInput): Promise<SideClueDoc> {
        const { path } = normalizeSideCluePath(input.path);
        const target = this.resolveTarget(input.target);
        const existing = await this.read(path, target);
        const now = Math.floor(this.nowFn());

        if (input.delivery !== undefined && !isValidSideClueDelivery(input.delivery)) {
            throw new Error(`Invalid side clue delivery policy: ${String(input.delivery)}`);
        }
        if (input.status !== undefined && !isValidSideClueStatus(input.status)) {
            throw new Error(`Invalid side clue status: ${String(input.status)}`);
        }

        const delivery = input.delivery ?? existing?.meta.delivery ?? this.defaultDelivery;
        const status = input.status ?? existing?.meta.status ?? DEFAULT_SIDE_CLUE_STATUS;

        const meta: SideClueMeta = {
            id: input.id?.trim() || existing?.meta.id || '',
            title: input.title?.trim() || existing?.meta.title || '',
            delivery,
            status,
            keywords: input.keywords !== undefined ? [...input.keywords] : [...(existing?.meta.keywords ?? [])],
            ...(input.secondaryKeys !== undefined
                ? { secondaryKeys: [...input.secondaryKeys] }
                : existing?.meta.secondaryKeys !== undefined
                    ? { secondaryKeys: [...existing.meta.secondaryKeys] }
                    : {}),
            ...(input.scanDepth !== undefined
                ? { scanDepth: input.scanDepth }
                : existing?.meta.scanDepth !== undefined
                    ? { scanDepth: existing.meta.scanDepth }
                    : {}),
            ...(input.order !== undefined
                ? { order: input.order }
                : existing?.meta.order !== undefined
                    ? { order: existing.meta.order }
                    : {}),
            summary: input.summary !== undefined ? input.summary : (existing?.meta.summary ?? ''),
            ...(input.sourceSessionId !== undefined
                ? { sourceSessionId: input.sourceSessionId }
                : existing?.meta.sourceSessionId !== undefined
                    ? { sourceSessionId: existing.meta.sourceSessionId }
                    : {}),
            anchor: input.anchor?.trim() || toBranchKey(target),
            createdAt: existing?.meta.createdAt ?? now,
            updatedAt: now,
            ...(delivery === 'next_turn_brief'
                ? {}
                : existing?.meta.consumedByTurn !== undefined
                    ? { consumedByTurn: existing.meta.consumedByTurn }
                    : {}),
        };

        const { content, doc } = await serializeSideClueWithHash(path, meta, input.body);
        await this.storage.writeRaw(path, content, { target, source: 'sidegen' });
        return doc;
    }

    async read(path: string, target?: MessageTarget): Promise<SideClueDoc | null> {
        const { path: normalizedPath } = normalizeSideCluePath(path);
        const effectiveTarget = this.resolveTarget(target);
        const raw = await this.storage.readRaw(normalizedPath, effectiveTarget);
        if (raw === null) {
            return null;
        }
        return parseSideClue(normalizedPath, raw);
    }

    async list(target?: MessageTarget): Promise<SideClueDoc[]> {
        const effectiveTarget = this.resolveTarget(target);
        const rawItems = await this.storage.listRaw(effectiveTarget);
        const docs = await Promise.all(
            rawItems.map((item) => parseSideClue(item.path, item.content)),
        );
        return docs.sort((a, b) => compareCodeUnits(a.path, b.path));
    }

    async updateDelivery(
        path: string,
        delivery: SideClueDelivery,
        target?: MessageTarget,
    ): Promise<SideClueDoc | null> {
        if (!isValidSideClueDelivery(delivery)) {
            throw new Error(`Invalid side clue delivery policy: ${String(delivery)}`);
        }
        const { path: normalizedPath } = normalizeSideCluePath(path);
        const effectiveTarget = this.resolveTarget(target);
        const existing = await this.read(normalizedPath, effectiveTarget);
        if (!existing) {
            return null;
        }

        const nextMeta: SideClueMeta = {
            ...existing.meta,
            delivery,
            updatedAt: Math.floor(this.nowFn()),
        };
        if (delivery === 'next_turn_brief') {
            delete nextMeta.consumedByTurn;
        }

        const { content, doc } = await serializeSideClueWithHash(
            normalizedPath,
            nextMeta,
            existing.body,
        );
        await this.storage.writeRaw(normalizedPath, content, {
            target: effectiveTarget,
            source: 'sidegen',
        });
        return doc;
    }

    async updateStatus(
        path: string,
        status: SideClueStatus,
        target?: MessageTarget,
    ): Promise<SideClueDoc | null> {
        if (!isValidSideClueStatus(status)) {
            throw new Error(`Invalid side clue status: ${String(status)}`);
        }
        const { path: normalizedPath } = normalizeSideCluePath(path);
        const effectiveTarget = this.resolveTarget(target);
        const existing = await this.read(normalizedPath, effectiveTarget);
        if (!existing) {
            return null;
        }

        const nextMeta: SideClueMeta = {
            ...existing.meta,
            status,
            updatedAt: Math.floor(this.nowFn()),
        };
        const { content, doc } = await serializeSideClueWithHash(
            normalizedPath,
            nextMeta,
            existing.body,
        );
        await this.storage.writeRaw(normalizedPath, content, {
            target: effectiveTarget,
            source: 'sidegen',
        });
        return doc;
    }

    async delete(path: string, target?: MessageTarget): Promise<boolean> {
        const { path: normalizedPath } = normalizeSideCluePath(path);
        const effectiveTarget = this.resolveTarget(target);
        return this.storage.deleteRaw(normalizedPath, effectiveTarget);
    }

    async exportToWorldInfo(
        path: string,
        options: ExportWorldInfoOptions = {},
    ): Promise<ExportWorldInfoResult> {
        const author = this.bridge.author;
        if (!author) {
            throw new Error(
                'HostAuthorBridge is unavailable; cannot export side clue to World Info',
            );
        }

        const { path: normalizedPath } = normalizeSideCluePath(path);
        const effectiveTarget = this.resolveTarget(options.target);
        const doc = await this.read(normalizedPath, effectiveTarget);
        if (!doc) {
            throw new Error(`Side clue not found: ${normalizedPath}`);
        }

        const primaryWorld = options.bookName?.trim() || (await author.getPrimaryWorldName());
        if (!primaryWorld) {
            throw new Error(
                'No target World Info book specified and active character has no primary bound World Info book',
            );
        }

        const keys =
            options.keys !== undefined
                ? [...options.keys]
                : doc.meta.keywords.length > 0
                    ? [...doc.meta.keywords]
                    : [doc.meta.title];
        const keysecondary =
            options.secondaryKeys !== undefined
                ? [...options.secondaryKeys]
                : doc.meta.secondaryKeys
                    ? [...doc.meta.secondaryKeys]
                    : [];

        const entryContent = doc.body.trim() || doc.meta.summary.trim();
        const entry: WorldInfoEntryUpsert = {
            comment: options.comment?.trim() || doc.meta.title,
            content: entryContent,
            keys,
            keysecondary,
            constant: options.constant ?? false,
            selective: options.selective ?? keysecondary.length > 0,
            ...(options.position !== undefined ? { position: options.position } : {}),
            ...(options.depth !== undefined ? { depth: options.depth } : {}),
            order: options.order ?? doc.meta.order ?? 100,
            ...(options.role !== undefined ? { role: options.role } : {}),
            disable: options.disable ?? false,
            ...(doc.meta.scanDepth !== undefined ? { scanDepth: doc.meta.scanDepth } : {}),
        };

        const saved = await author.upsertWorldInfoEntry(primaryWorld, entry, {
            rawDirect: true,
            undoMeta: {
                reason: `Export side clue ${doc.path} to World Info (${primaryWorld})`,
            },
        });

        if (options.markResolved) {
            await this.updateStatus(doc.path, 'resolved', effectiveTarget);
        }

        return {
            bookName: primaryWorld,
            uid: saved.uid,
            comment: saved.comment,
            cluePath: doc.path,
        };
    }

    private resolveTarget(target?: MessageTarget): MessageTarget {
        if (target) {
            return { messageId: target.messageId, swipeId: target.swipeId };
        }
        if (this.resolveAnchorFn) {
            const anchor = this.resolveAnchorFn();
            return { messageId: anchor.messageId, swipeId: anchor.swipeId };
        }
        const chat = this.bridge.getChat();
        if (chat.length === 0) {
            return { messageId: 0, swipeId: 0 };
        }
        const lastIndex = chat.length - 1;
        return {
            messageId: lastIndex,
            swipeId: chat[lastIndex]?.swipeId ?? 0,
        };
    }
}
