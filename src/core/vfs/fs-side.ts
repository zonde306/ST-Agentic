import type { ToolEditResult } from '@/core/bridge';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import {
    type SideClueDelivery,
    type SideClueDoc,
    type SideClueMeta,
    type SideClueStatus,
    type SideClueWriteInput,
    type VfsEntryStat,
    toBranchKey,
} from '@/core/types';
import {
    normalizeSideClueMeta,
    normalizeVfsPath,
    parseSideClue,
    parseSideClueRaw,
    serializeSideClueWithHash,
} from '@/core/utils';
import {
    VfsError,
    VfsInvalidPathError,
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    type VfsSearchDocument,
    type VfsTargetOptions,
    type VfsWriteOptions,
    basenameOf,
    sliceLines,
    sortStats,
    utf8ByteLength,
} from './fs-base';

export const SIDE_MOUNT = 'side';
export const SIDE_MOUNT_PREFIX = `/${SIDE_MOUNT}`;

/** Conventional subdirectories exposed under `/side/*`. */
export const SIDE_SUBDIRS = ['comms', 'rumors', 'notes'] as const;
export type SideSubdir = (typeof SIDE_SUBDIRS)[number];

const SIDE_SUBDIR_SET: ReadonlySet<string> = new Set(SIDE_SUBDIRS);

export interface SideClueListOptions extends VfsTargetOptions {
    /** Optional subdirectory filter (e.g. `'comms'`, `'rumors'`, `'notes'`). */
    subdir?: SideSubdir | string;
    /** Optional delivery policy filter. */
    delivery?: SideClueDelivery;
    /** Optional clue status filter. */
    status?: SideClueStatus;
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

function getImmediateChild(prefix: string, fullRelPath: string): { name: string; isDir: boolean } | null {
    const cleanRel = fullRelPath.replace(/^\/+/, '');
    if (!cleanRel) {
        return null;
    }

    if (prefix) {
        const prefixWithSlash = `${prefix}/`;
        if (!cleanRel.startsWith(prefixWithSlash)) {
            return null;
        }
        const remainder = cleanRel.slice(prefixWithSlash.length);
        const slashIdx = remainder.indexOf('/');
        if (slashIdx < 0) {
            return { name: remainder, isDir: false };
        }
        return { name: remainder.slice(0, slashIdx), isDir: true };
    }

    const slashIdx = cleanRel.indexOf('/');
    if (slashIdx < 0) {
        return { name: cleanRel, isDir: false };
    }
    return { name: cleanRel.slice(0, slashIdx), isDir: true };
}

function hasDirectoryPrefix(keys: Iterable<string>, relDir: string): boolean {
    if (!relDir) {
        return true;
    }
    const prefix = `${relDir.replace(/^\/+|\/+$/g, '')}/`;
    for (const k of keys) {
        if (k.replace(/^\/+/, '').startsWith(prefix)) {
            return true;
        }
    }
    return false;
}

/**
 * Normalize either a full `/side/...` VFS path or a mount-relative path (`comms/linwan.md`)
 * into a clean relative key (no leading/trailing slashes), rejecting traversal or out-of-mount paths.
 */
export function normalizeSideRelPath(pathOrRel: string): string {
    const raw = typeof pathOrRel === 'string' ? pathOrRel.trim() : '';
    if (!raw || raw === '/' || raw === SIDE_MOUNT_PREFIX || raw === `${SIDE_MOUNT_PREFIX}/`) {
        return '';
    }

    let normalized: string;
    try {
        normalized = normalizeVfsPath(raw.startsWith('/') ? raw : `/${raw}`);
    } catch (error) {
        throw new VfsInvalidPathError(pathOrRel, (error as Error).message);
    }

    if (raw.startsWith('/')) {
        if (normalized === SIDE_MOUNT_PREFIX) {
            return '';
        }
        if (!normalized.startsWith(`${SIDE_MOUNT_PREFIX}/`)) {
            throw new VfsInvalidPathError(
                pathOrRel,
                `SideMount path must reside under ${SIDE_MOUNT_PREFIX}/: ${pathOrRel}`,
            );
        }
        return normalized.slice(SIDE_MOUNT_PREFIX.length + 1);
    }

    return normalized === '/' ? '' : normalized.slice(1);
}

/**
 * Branch-safe `/side/*` VFS mount backed by `ChatDataStore` (`DATA_NAMESPACES.SIDE_FILES`).
 *
 * Exposes `/side/comms/*`, `/side/rumors/*`, and `/side/notes/*` (plus any custom nested paths)
 * with causal `(messageId, swipeId)` isolation, Frontmatter codec helpers, and BM25 search metadata.
 */
export class SideMount implements VfsMount {
    public readonly mountName = SIDE_MOUNT;
    public readonly writable = true;

    constructor(private readonly store: ChatDataStore) {}

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        const clean = normalizeSideRelPath(relPath);
        if (!clean) {
            return {
                path: SIDE_MOUNT_PREFIX,
                name: SIDE_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: SIDE_MOUNT,
            };
        }

        const entry = this.readStored(clean, opts);
        if (entry) {
            const fullPath = `${SIDE_MOUNT_PREFIX}/${clean}`;
            return {
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(entry.content),
                writable: true,
                mount: SIDE_MOUNT,
                source: entry.source,
            };
        }

        const snapshot = this.snapshotMap(opts);
        if (SIDE_SUBDIR_SET.has(clean) || hasDirectoryPrefix(snapshot.keys(), clean)) {
            const fullPath = `${SIDE_MOUNT_PREFIX}/${clean}`;
            return {
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'directory',
                size: 0,
                writable: true,
                mount: SIDE_MOUNT,
            };
        }

        return null;
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const cleanDir = normalizeSideRelPath(relPath);
        const snapshot = this.snapshotMap(opts);

        const dirs = new Set<string>();
        const files = new Map<string, { content: string; source: string }>();

        if (!cleanDir) {
            for (const subdir of SIDE_SUBDIRS) {
                dirs.add(subdir);
            }
        }

        for (const [key, info] of snapshot.entries()) {
            const child = getImmediateChild(cleanDir, key);
            if (!child) {
                continue;
            }
            if (child.isDir) {
                dirs.add(child.name);
            } else {
                files.set(child.name, info);
            }
        }

        const stats: VfsEntryStat[] = [];
        const basePrefix = cleanDir ? `${SIDE_MOUNT_PREFIX}/${cleanDir}` : SIDE_MOUNT_PREFIX;

        for (const dirName of dirs) {
            stats.push({
                path: `${basePrefix}/${dirName}`,
                name: dirName,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: SIDE_MOUNT,
            });
        }

        for (const [fileName, info] of files.entries()) {
            stats.push({
                path: `${basePrefix}/${fileName}`,
                name: fileName,
                kind: 'file',
                size: utf8ByteLength(info.content),
                writable: true,
                mount: SIDE_MOUNT,
                source: info.source,
            });
        }

        return sortStats(stats);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const clean = normalizeSideRelPath(relPath);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            const fullPath = clean ? `${SIDE_MOUNT_PREFIX}/${clean}` : SIDE_MOUNT_PREFIX;
            throw new VfsError(`Path is a directory: ${fullPath}`, 'EISDIR', fullPath);
        }

        const entry = this.readStored(clean, opts);
        if (!entry) {
            const snapshot = this.snapshotMap(opts);
            const fullPath = `${SIDE_MOUNT_PREFIX}/${clean}`;
            if (hasDirectoryPrefix(snapshot.keys(), clean)) {
                throw new VfsError(`Path is a directory: ${fullPath}`, 'EISDIR', fullPath);
            }
            throw new VfsNotFoundError(fullPath);
        }

        return sliceLines(entry.content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const clean = normalizeSideRelPath(relPath);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            const fullPath = clean ? `${SIDE_MOUNT_PREFIX}/${clean}` : SIDE_MOUNT_PREFIX;
            throw new VfsError(`Cannot write to directory: ${fullPath}`, 'EISDIR', fullPath);
        }

        const existing = this.readStored(clean, opts);
        if (existing && existing.content === content) {
            return;
        }

        this.store.set(
            DATA_NAMESPACES.SIDE_FILES,
            clean,
            opts.source ?? 'side-vfs',
            content,
            { target: opts.target, staged: opts.staged },
        );
    }

    async appendFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const clean = normalizeSideRelPath(relPath);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            const fullPath = clean ? `${SIDE_MOUNT_PREFIX}/${clean}` : SIDE_MOUNT_PREFIX;
            throw new VfsError(`Cannot append to directory: ${fullPath}`, 'EISDIR', fullPath);
        }

        const existing = this.readStored(clean, opts);
        const nextContent = `${existing?.content ?? ''}${content}`;
        await this.writeFile(clean, nextContent, opts);
    }

    async editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts: VfsWriteOptions = {},
    ): Promise<ToolEditResult> {
        const clean = normalizeSideRelPath(relPath);
        const fullPath = clean ? `${SIDE_MOUNT_PREFIX}/${clean}` : SIDE_MOUNT_PREFIX;
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            return { ok: false, path: fullPath, message: `Path is a directory: ${fullPath}` };
        }

        const existing = this.readStored(clean, opts);
        if (!existing) {
            return { ok: false, path: fullPath, message: `File not found: ${fullPath}` };
        }
        if (!oldText || !existing.content.includes(oldText)) {
            return { ok: false, path: fullPath, message: `Target text not found in ${fullPath}` };
        }

        const updated = existing.content.replace(oldText, newText);
        if (updated !== existing.content) {
            this.store.set(
                DATA_NAMESPACES.SIDE_FILES,
                clean,
                opts.source ?? 'side-vfs',
                updated,
                { target: opts.target, staged: opts.staged },
            );
        }

        return { ok: true, path: fullPath, message: `Edited ${fullPath}` };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        const clean = normalizeSideRelPath(relPath);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            return false;
        }
        return this.store.erase(
            DATA_NAMESPACES.SIDE_FILES,
            clean,
            opts.source ?? 'side-vfs-delete',
            { target: opts.target, staged: opts.staged },
        );
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const snapshot = this.snapshotMap(opts);
        const stats: VfsEntryStat[] = [];
        for (const [key, info] of snapshot.entries()) {
            const fullPath = `${SIDE_MOUNT_PREFIX}/${key}`;
            stats.push({
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(info.content),
                writable: true,
                mount: SIDE_MOUNT,
                source: info.source,
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const snapshot = this.snapshotMap(opts);
        const docs: VfsSearchDocument[] = [];
        for (const [key, info] of snapshot.entries()) {
            const fullPath = `${SIDE_MOUNT_PREFIX}/${key}`;
            const parsed = parseSideClueRaw(fullPath, info.content);
            const keys = parsed.meta.keywords.length > 0 ? parsed.meta.keywords.join(', ') : undefined;
            const keysecondary = parsed.meta.secondaryKeys && parsed.meta.secondaryKeys.length > 0
                ? parsed.meta.secondaryKeys.join(', ')
                : undefined;

            docs.push({
                path: fullPath,
                title: parsed.meta.title || basenameOf(fullPath),
                content: info.content,
                ...(keys ? { keys } : {}),
                ...(keysecondary ? { keysecondary } : {}),
            });
        }
        return docs;
    }

    /**
     * Read and parse a single `/side/*` clue document (with `xxHash` `contentHash`),
     * returning `null` if the file does not exist on the requested branch.
     */
    async readSideClue(pathOrRel: string, opts?: VfsTargetOptions): Promise<SideClueDoc | null> {
        const clean = normalizeSideRelPath(pathOrRel);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            return null;
        }

        const entry = this.readStored(clean, opts);
        if (!entry) {
            return null;
        }

        const fullPath = `${SIDE_MOUNT_PREFIX}/${clean}`;
        return await parseSideClue(fullPath, entry.content);
    }

    /**
     * Enumerate all visible `/side/*` clues for `opts.target`, parsed with `side-clue-codec`
     * and sorted deterministically by canonical VFS path.
     */
    async listSideClues(opts?: SideClueListOptions): Promise<SideClueDoc[]> {
        const snapshot = this.snapshotMap(opts);
        const subdirPrefix = opts?.subdir
            ? `${opts.subdir.replace(/^\/+|\/+$/g, '')}/`
            : '';

        const keys = Array.from(snapshot.keys())
            .filter((key) => !subdirPrefix || key.startsWith(subdirPrefix))
            .sort(compareCodeUnits);

        const docs: SideClueDoc[] = [];
        for (const key of keys) {
            const info = snapshot.get(key);
            if (!info) {
                continue;
            }
            const fullPath = `${SIDE_MOUNT_PREFIX}/${key}`;
            const doc = await parseSideClue(fullPath, info.content);
            if (opts?.delivery !== undefined && doc.meta.delivery !== opts.delivery) {
                continue;
            }
            if (opts?.status !== undefined && doc.meta.status !== opts.status) {
                continue;
            }
            docs.push(doc);
        }

        return docs;
    }

    /**
     * Normalize, canonically serialize (with YAML Frontmatter), persist into `DATA_NAMESPACES.SIDE_FILES`,
     * and return the resulting `SideClueDoc` (including its `xxHash` `contentHash`).
     */
    async writeSideClue(input: SideClueWriteInput, opts: VfsWriteOptions = {}): Promise<SideClueDoc> {
        const clean = normalizeSideRelPath(input.path);
        if (!clean || SIDE_SUBDIR_SET.has(clean)) {
            const fullPath = clean ? `${SIDE_MOUNT_PREFIX}/${clean}` : SIDE_MOUNT_PREFIX;
            throw new VfsError(`Cannot write clue to directory: ${fullPath}`, 'EISDIR', fullPath);
        }

        const fullPath = `${SIDE_MOUNT_PREFIX}/${clean}`;
        const effectiveTarget = opts.target ?? input.target;
        const effectiveWriteOpts: VfsWriteOptions = {
            ...opts,
            target: effectiveTarget,
            source: opts.source ?? 'side-clue',
        };

        const existingRaw = this.readStored(clean, effectiveWriteOpts);
        const existingMeta = existingRaw
            ? parseSideClueRaw(fullPath, existingRaw.content).meta
            : undefined;

        const now = Date.now();
        const defaultAnchor = input.anchor
            ?? (effectiveTarget ? toBranchKey(effectiveTarget) : existingMeta?.anchor ?? '0#0');

        const rawFields: Record<string, unknown> = {
            createdAt: existingMeta?.createdAt && existingMeta.createdAt > 0 ? existingMeta.createdAt : now,
            updatedAt: now,
        };

        if (input.id !== undefined) rawFields.id = input.id;
        if (input.title !== undefined) rawFields.title = input.title;
        if (input.delivery !== undefined) rawFields.delivery = input.delivery;
        if (input.status !== undefined) rawFields.status = input.status;
        if (input.keywords !== undefined) rawFields.keywords = input.keywords;
        if (input.secondaryKeys !== undefined) rawFields.secondaryKeys = input.secondaryKeys;
        if (input.scanDepth !== undefined) rawFields.scanDepth = input.scanDepth;
        if (input.order !== undefined) rawFields.order = input.order;
        if (input.summary !== undefined) rawFields.summary = input.summary;
        if (input.sourceSessionId !== undefined) rawFields.sourceSessionId = input.sourceSessionId;
        if (input.anchor !== undefined) rawFields.anchor = input.anchor;

        const defaults: Partial<SideClueMeta> = {
            ...existingMeta,
            anchor: defaultAnchor,
            createdAt: rawFields.createdAt as number,
            updatedAt: now,
        };

        const normalizedMeta = normalizeSideClueMeta(rawFields, fullPath, defaults, input.body);
        const serialized = await serializeSideClueWithHash(fullPath, normalizedMeta, input.body);

        await this.writeFile(clean, serialized.content, effectiveWriteOpts);
        return serialized.doc;
    }

    /**
     * Patch Frontmatter metadata fields of an existing `/side/*` clue while preserving its Markdown body.
     * Returns `null` if the clue does not exist on the target branch.
     */
    async updateSideClueMeta(
        pathOrRel: string,
        patch: Partial<SideClueMeta>,
        opts: VfsWriteOptions = {},
    ): Promise<SideClueDoc | null> {
        const existing = await this.readSideClue(pathOrRel, opts);
        if (!existing) {
            return null;
        }

        const nextMeta: SideClueMeta = {
            ...existing.meta,
            ...patch,
            updatedAt: patch.updatedAt ?? Date.now(),
        };
        const serialized = await serializeSideClueWithHash(existing.path, nextMeta, existing.body);
        const clean = normalizeSideRelPath(existing.path);
        await this.writeFile(clean, serialized.content, {
            ...opts,
            source: opts.source ?? 'side-clue-meta',
        });
        return serialized.doc;
    }

    /**
     * Mark a list of `next_turn_brief` `/side/*` clues as surfaced/consumed so subsequent
     * main-line turns do not re-inject the same `<side-brief>`.
     */
    async markSideCluesConsumed(
        paths: readonly string[],
        turnNumber?: number,
        opts: VfsWriteOptions = {},
    ): Promise<SideClueDoc[]> {
        const updated: SideClueDoc[] = [];
        for (const path of paths) {
            const existing = await this.readSideClue(path, opts);
            if (!existing) {
                continue;
            }
            const nextStatus: SideClueStatus = existing.meta.status === 'resolved'
                ? 'resolved'
                : 'surfaced';
            const nextConsumedByTurn = turnNumber !== undefined
                ? Math.max(0, Math.floor(turnNumber))
                : (existing.meta.consumedByTurn ?? 0);

            const doc = await this.updateSideClueMeta(
                existing.path,
                {
                    status: nextStatus,
                    consumedByTurn: nextConsumedByTurn,
                },
                opts,
            );
            if (doc) {
                updated.push(doc);
            }
        }
        return updated;
    }

    private readStored(key: string, opts?: VfsTargetOptions) {
        if (opts?.staged === false) {
            return this.store.get(DATA_NAMESPACES.SIDE_FILES, key, { target: opts.target });
        }
        return this.store.getPending(DATA_NAMESPACES.SIDE_FILES, key, { target: opts?.target });
    }

    private snapshotMap(opts?: VfsTargetOptions): Map<string, { content: string; source: string }> {
        const map = new Map<string, { content: string; source: string }>();
        const rows = this.store.lookup(DATA_NAMESPACES.SIDE_FILES, {
            target: opts?.target,
            includeStaged: opts?.staged !== false,
        });
        for (const row of rows) {
            const clean = row.key.replace(/^\/+/, '');
            if (!clean) {
                continue;
            }
            map.set(clean, { content: row.entry.content, source: row.entry.source });
        }
        return map;
    }
}
