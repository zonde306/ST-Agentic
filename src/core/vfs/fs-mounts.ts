import type { HostBridge, ToolEditResult } from '@/core/bridge';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    VARIABLES_DOC_KEY,
} from '@/core/store';
import {
    type BranchKey,
    type MessageTarget,
    type VfsEntryStat,
    parseBranchKey,
    toBranchKey,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import {
    VfsError,
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    VfsReadOnlyError,
    type VfsSearchDocument,
    type VfsTargetOptions,
    type VfsWriteOptions,
    basenameOf,
    sanitizeFileName,
    sliceLines,
    sortStats,
    utf8ByteLength,
} from './fs-base';
import { parseInitVarEntries } from './fs-worldinfo';
import { isChatBaseWorkspacePath } from './workspace-policy';

export const GLOBAL_MOUNT = 'global';
export const PERSONA_MOUNT = 'persona';
export const CHARACTER_MOUNT = 'character';
export const PRESET_MOUNT = 'preset';
export const HISTORY_MOUNT = 'history';
export const STATE_MOUNT = 'state';
export const VARIABLES_FILE_NAME = 'variables.json';
export const OUTPUT_FILE_NAME = 'output.md';
export const OUTPUT_FILE_PATH = '/output.md';

export const GLOBAL_VFS_EXTENSION_KEY = 'agentic_global_files';
export const AGENTIC_HISTORY_KEY = 'agentic_history';

/** Overlay allowlist for `/character/*` and `/persona/*`. */
export const OVERLAY_WRITES = new Set(['CONSTRAINTS.md', 'LESSONS.md']);

const CHARACTER_FIELD_FILE_MAP: Record<string, string> = {
    description: 'description.md',
    personality: 'personality.md',
    scenario: 'scenario.md',
    mes_example: 'example_dialogue.md',
    example_dialogue: 'example_dialogue.md',
    creator_notes: 'creator_notes.md',
    creatorcomment: 'creator_notes.md',
    system_prompt: 'system_prompt.md',
    post_history_instructions: 'post_history_instructions.md',
    depth_prompt: 'depth_prompt.md',
    sd_character_prompt: 'sd_character_prompt.md',
};

const SKIPPED_CHARACTER_FIELDS = new Set(['first_mes', 'firstMes']);

/** Build read-only `/character/*` snapshot from `HostBridge.getCharacterFields()`. */
export async function characterSnapshot(bridge: HostBridge): Promise<Map<string, string>> {
    const fields = bridge.getCharacterFields();
    const files = new Map<string, string>();

    for (const [key, rawValue] of Object.entries(fields)) {
        if (SKIPPED_CHARACTER_FIELDS.has(key)) {
            continue;
        }
        const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
        if (!value.trim()) {
            continue;
        }

        const mapped = CHARACTER_FIELD_FILE_MAP[key];
        const fileName = mapped ?? (key.endsWith('.md') ? sanitizeFileName(key) : `${sanitizeFileName(key)}.md`);
        if (!files.has(fileName)) {
            files.set(fileName, value);
        }
    }

    return files;
}

/** Build read-only `/persona/*` snapshot from `HostBridge.getPersonaDescription()`. */
export async function personaSnapshot(bridge: HostBridge): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    const description = String(bridge.getPersonaDescription() ?? '');
    if (description.trim()) {
        files.set('description.md', description);
    }
    return files;
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

function listDirFromFlatMap(
    entries: Iterable<[string, { content: string; source?: string }]>,
    relDir: string,
    mountPrefix: string,
    mountName: string,
    writable: boolean,
): VfsEntryStat[] {
    const cleanDir = relDir.replace(/^\/+|\/+$/g, '');
    const dirs = new Set<string>();
    const files = new Map<string, { content: string; source?: string }>();

    for (const [rawKey, info] of entries) {
        const key = rawKey.replace(/^\/+/, '');
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
    const basePrefix = mountPrefix ? `${mountPrefix}${cleanDir ? `/${cleanDir}` : ''}` : (cleanDir ? `/${cleanDir}` : '');

    for (const dirName of dirs) {
        stats.push({
            path: `${basePrefix}/${dirName}`,
            name: dirName,
            kind: 'directory',
            size: 0,
            writable,
            mount: mountName,
        });
    }

    for (const [fileName, info] of files.entries()) {
        stats.push({
            path: `${basePrefix}/${fileName}`,
            name: fileName,
            kind: 'file',
            size: utf8ByteLength(info.content),
            writable,
            mount: mountName,
            source: info.source,
        });
    }

    return sortStats(stats);
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
 * `/` workspace root backed by `ChatDataStore` (`files` namespace).
 */
export class WorkspaceMount implements VfsMount {
    public readonly mountName = 'workspace';
    public readonly writable = true;

    constructor(private readonly store: ChatDataStore) {}

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        const clean = relPath.replace(/^\/+/, '');
        if (!clean) {
            return {
                path: '/',
                name: '/',
                kind: 'directory',
                size: 0,
                writable: true,
                mount: this.mountName,
            };
        }

        const entry = this.readStored(clean, opts);
        if (entry) {
            return {
                path: `/${clean}`,
                name: basenameOf(`/${clean}`),
                kind: 'file',
                size: utf8ByteLength(entry.content),
                writable: true,
                mount: this.mountName,
                source: entry.source,
            };
        }

        const snapshot = this.snapshotMap(opts);
        if (hasDirectoryPrefix(snapshot.keys(), clean)) {
            return {
                path: `/${clean}`,
                name: basenameOf(`/${clean}`),
                kind: 'directory',
                size: 0,
                writable: true,
                mount: this.mountName,
            };
        }

        return null;
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const snapshot = this.snapshotMap(opts);
        return listDirFromFlatMap(snapshot.entries(), relPath, '', this.mountName, true);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const clean = relPath.replace(/^\/+/, '');
        const entry = this.readStored(clean, opts);
        if (!entry) {
            throw new VfsNotFoundError(`/${clean}`);
        }
        return sliceLines(entry.content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const clean = relPath.replace(/^\/+/, '');
        if (!clean) {
            throw new VfsError('Cannot overwrite root directory "/"', 'EISDIR', '/');
        }
        const useBase = this.shouldUseBaseLayer(clean, opts);
        if (useBase) {
            this.store.setBase(
                DATA_NAMESPACES.FILES,
                clean,
                opts.source ?? 'vfs',
                content,
            );
            return;
        }
        const existing = this.readStored(clean, opts);
        if (existing && existing.content === content) {
            return;
        }
        this.store.set(
            DATA_NAMESPACES.FILES,
            clean,
            opts.source ?? 'vfs',
            content,
            { target: opts.target, staged: opts.staged },
        );
    }

    async appendFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const clean = relPath.replace(/^\/+/, '');
        if (!clean) {
            throw new VfsError('Cannot append to root directory "/"', 'EISDIR', '/');
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
        const clean = relPath.replace(/^\/+/, '');
        const fullPath = `/${clean}`;
        const existing = this.readStored(clean, opts);
        if (!existing) {
            return { ok: false, path: fullPath, message: `File not found: ${fullPath}` };
        }
        if (!oldText || !existing.content.includes(oldText)) {
            return { ok: false, path: fullPath, message: `Target text not found in ${fullPath}` };
        }

        const updated = existing.content.replace(oldText, newText);
        if (updated !== existing.content) {
            if (this.shouldUseBaseLayer(clean, opts)) {
                this.store.setBase(
                    DATA_NAMESPACES.FILES,
                    clean,
                    opts.source ?? 'vfs',
                    updated,
                );
            } else {
                this.store.set(
                    DATA_NAMESPACES.FILES,
                    clean,
                    opts.source ?? 'vfs',
                    updated,
                    { target: opts.target, staged: opts.staged },
                );
            }
        }
        return { ok: true, path: fullPath, message: `Edited ${fullPath}` };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        const clean = relPath.replace(/^\/+/, '');
        if (!clean) {
            return false;
        }
        if (this.shouldUseBaseLayer(clean, opts)) {
            return this.store.removeBase(DATA_NAMESPACES.FILES, clean);
        }
        return this.store.erase(
            DATA_NAMESPACES.FILES,
            clean,
            opts.source ?? 'vfs-delete',
            { target: opts.target, staged: opts.staged },
        );
    }

    private shouldUseBaseLayer(cleanKey: string, opts?: VfsWriteOptions): boolean {
        if (opts?.layerMode === 'base') {
            return true;
        }
        if (opts?.layerMode === 'branch') {
            return false;
        }
        return isChatBaseWorkspacePath(`/${cleanKey}`);
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const snapshot = this.snapshotMap(opts);
        const stats: VfsEntryStat[] = [];
        for (const [key, info] of snapshot.entries()) {
            const fullPath = `/${key}`;
            stats.push({
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(info.content),
                writable: true,
                mount: this.mountName,
                source: info.source,
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const snapshot = this.snapshotMap(opts);
        const docs: VfsSearchDocument[] = [];
        for (const [key, info] of snapshot.entries()) {
            const fullPath = `/${key}`;
            docs.push({
                path: fullPath,
                title: basenameOf(fullPath),
                content: info.content,
            });
        }
        return docs;
    }

    private readStored(key: string, opts?: VfsTargetOptions) {
        if (opts?.staged === false) {
            return this.store.get(DATA_NAMESPACES.FILES, key, { target: opts.target });
        }
        return this.store.getPending(DATA_NAMESPACES.FILES, key, { target: opts?.target });
    }

    private snapshotMap(opts?: VfsTargetOptions): Map<string, { content: string; source: string }> {
        const map = new Map<string, { content: string; source: string }>();
        const rows = this.store.lookup(DATA_NAMESPACES.FILES, {
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

/**
 * `/state/variables.json` (`rw`, `variables` namespace, aligned with `[InitVar]` & legacy variables).
 */
export class VariablesMount implements VfsMount {
    public readonly mountName = STATE_MOUNT;
    public readonly writable = true;
    public readonly canonicalPath = `/${STATE_MOUNT}/${VARIABLES_FILE_NAME}`;

    constructor(
        private readonly bridge: HostBridge,
        private readonly store: ChatDataStore,
    ) {}

    async readVariables(opts?: VfsTargetOptions): Promise<Record<string, unknown>> {
        const raw = await this.readSerialized(opts);
        try {
            const parsed = JSON.parse(raw) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Fall through to empty object
        }
        return {};
    }

    async writeVariables(
        vars: Record<string, unknown>,
        opts: VfsWriteOptions = {},
    ): Promise<void> {
        const serialized = JSON.stringify(canonicalClone(vars), null, 2);
        this.store.set(
            DATA_NAMESPACES.VARIABLES,
            VARIABLES_DOC_KEY,
            opts.source ?? 'vfs-vars',
            serialized,
            { target: opts.target, staged: opts.staged },
        );
    }

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${STATE_MOUNT}`,
                name: STATE_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: STATE_MOUNT,
            };
        }
        if (relPath !== VARIABLES_FILE_NAME) {
            return null;
        }
        const content = await this.readSerialized(opts);
        const stored = this.readLayerEntry(opts);
        return {
            path: this.canonicalPath,
            name: VARIABLES_FILE_NAME,
            kind: 'file',
            size: utf8ByteLength(content),
            writable: true,
            mount: STATE_MOUNT,
            source: stored?.source ?? 'initvar',
        };
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        if (relPath) {
            return [];
        }
        const entry = await this.stat(VARIABLES_FILE_NAME, opts);
        return entry ? [entry] : [];
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        if (relPath !== VARIABLES_FILE_NAME) {
            throw new VfsNotFoundError(`/${STATE_MOUNT}/${relPath}`);
        }
        const content = await this.readSerialized(opts);
        return sliceLines(content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        if (relPath !== VARIABLES_FILE_NAME) {
            throw new VfsNotFoundError(`/${STATE_MOUNT}/${relPath}`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (error) {
            throw new VfsError(
                `Invalid JSON for ${this.canonicalPath}: ${(error as Error).message}`,
                'EINVAL',
                this.canonicalPath,
            );
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new VfsError(
                `${this.canonicalPath} must contain a JSON object`,
                'EINVAL',
                this.canonicalPath,
            );
        }

        await this.writeVariables(parsed as Record<string, unknown>, opts);
    }

    async editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts: VfsWriteOptions = {},
    ): Promise<ToolEditResult> {
        if (relPath !== VARIABLES_FILE_NAME) {
            return {
                ok: false,
                path: `/${STATE_MOUNT}/${relPath}`,
                message: `File not found: /${STATE_MOUNT}/${relPath}`,
            };
        }

        const current = await this.readSerialized(opts);
        if (!oldText || !current.includes(oldText)) {
            return {
                ok: false,
                path: this.canonicalPath,
                message: `Target text not found in ${this.canonicalPath}`,
            };
        }

        const candidate = current.replace(oldText, newText);
        let parsed: unknown;
        try {
            parsed = JSON.parse(candidate);
        } catch (error) {
            return {
                ok: false,
                path: this.canonicalPath,
                message: `Edit produced invalid JSON: ${(error as Error).message}`,
            };
        }

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                ok: false,
                path: this.canonicalPath,
                message: `${this.canonicalPath} must remain a JSON object`,
            };
        }

        await this.writeVariables(parsed as Record<string, unknown>, opts);
        return {
            ok: true,
            path: this.canonicalPath,
            message: `Updated ${this.canonicalPath}`,
        };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        if (relPath !== VARIABLES_FILE_NAME) {
            return false;
        }
        this.store.setDeleted(
            DATA_NAMESPACES.VARIABLES,
            VARIABLES_DOC_KEY,
            opts.source ?? 'vfs-delete',
            { target: opts.target, staged: opts.staged },
        );
        return true;
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const entry = await this.stat(VARIABLES_FILE_NAME, opts);
        return entry ? [entry] : [];
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const content = await this.readSerialized(opts);
        return [
            {
                path: this.canonicalPath,
                title: VARIABLES_FILE_NAME,
                content,
            },
        ];
    }

    private readLayerEntry(opts?: VfsTargetOptions) {
        const readOpts = {
            target: opts?.target,
            includeDeleted: true,
            excludeLegacyMetadataVariables: true,
        };
        if (opts?.staged === false) {
            return this.store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, readOpts);
        }
        return this.store.getPending(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, readOpts);
    }

    private async readSerialized(opts?: VfsTargetOptions): Promise<string> {
        const stored = this.readLayerEntry(opts);
        if (stored) {
            if (stored.deleted) {
                return '{}';
            }
            try {
                const parsed = JSON.parse(stored.content) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return JSON.stringify(canonicalClone(parsed), null, 2);
                }
            } catch {
                return stored.content;
            }
            return stored.content;
        }

        const books = await this.bridge.listEnabledLorebooks();
        const initVars = parseInitVarEntries(books);
        const metaVars = this.store.getLegacyMetadataVariables();
        const merged = { ...initVars, ...(metaVars ?? {}) };
        return JSON.stringify(canonicalClone(merged), null, 2);
    }
}

/**
 * Read-only base snapshot with scoped writable overlay allowlist (`CONSTRAINTS.md`, `LESSONS.md`).
 * Used for `/character/*` and `/persona/*`.
 */
export class HybridMount implements VfsMount {
    public readonly writable = true;

    constructor(
        public readonly mountName: string,
        private readonly baseProvider: () => Promise<Map<string, string>>,
        private readonly store: ChatDataStore,
        private readonly namespace: string,
        private readonly scopeProvider: () => string,
        private readonly allowlist: ReadonlySet<string> = OVERLAY_WRITES,
    ) {}

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${this.mountName}`,
                name: this.mountName,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: this.mountName,
            };
        }

        const files = await this.snapshot(opts);
        const info = files.get(relPath);
        if (!info) {
            return null;
        }

        return {
            path: `/${this.mountName}/${relPath}`,
            name: relPath,
            kind: 'file',
            size: utf8ByteLength(info.content),
            writable: info.writable,
            mount: this.mountName,
            source: info.source,
        };
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        if (relPath) {
            return [];
        }
        return await this.listFiles(opts);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const files = await this.snapshot(opts);
        const info = files.get(relPath);
        if (!info) {
            throw new VfsNotFoundError(`/${this.mountName}/${relPath}`);
        }
        return sliceLines(info.content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const fullPath = `/${this.mountName}/${relPath}`;
        if (!(await this.canWrite(relPath))) {
            throw new VfsReadOnlyError(fullPath, this.rejectionMessage(relPath));
        }
        this.store.set(
            this.namespace,
            this.scopedKey(relPath),
            opts.source ?? 'vfs',
            content,
            { target: opts.target, staged: opts.staged },
        );
    }

    async editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts: VfsWriteOptions = {},
    ): Promise<ToolEditResult> {
        const fullPath = `/${this.mountName}/${relPath}`;
        if (!(await this.canWrite(relPath))) {
            throw new VfsReadOnlyError(fullPath, this.rejectionMessage(relPath));
        }

        const current = this.readOverlayEntry(relPath, opts)?.content;
        if (current === undefined) {
            return { ok: false, path: fullPath, message: `File not found: ${fullPath}` };
        }
        if (!oldText || !current.includes(oldText)) {
            return { ok: false, path: fullPath, message: `Target text not found in ${fullPath}` };
        }

        this.store.set(
            this.namespace,
            this.scopedKey(relPath),
            opts.source ?? 'vfs',
            current.replace(oldText, newText),
            { target: opts.target, staged: opts.staged },
        );
        return { ok: true, path: fullPath, message: `Edited ${fullPath}` };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        const fullPath = `/${this.mountName}/${relPath}`;
        if (!(await this.canWrite(relPath))) {
            throw new VfsReadOnlyError(fullPath, this.rejectionMessage(relPath));
        }
        return this.store.erase(
            this.namespace,
            this.scopedKey(relPath),
            opts.source ?? 'vfs-delete',
            { target: opts.target, staged: opts.staged },
        );
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const files = await this.snapshot(opts);
        const stats: VfsEntryStat[] = [];
        for (const [name, info] of files.entries()) {
            stats.push({
                path: `/${this.mountName}/${name}`,
                name,
                kind: 'file',
                size: utf8ByteLength(info.content),
                writable: info.writable,
                mount: this.mountName,
                source: info.source,
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const files = await this.snapshot(opts);
        const docs: VfsSearchDocument[] = [];
        for (const [name, info] of files.entries()) {
            docs.push({
                path: `/${this.mountName}/${name}`,
                title: name,
                content: info.content,
            });
        }
        return docs;
    }

    private scopePrefix(): string {
        const raw = (this.scopeProvider() || 'default').replace(/\//g, '_');
        return `${raw}/`;
    }

    private scopedKey(relPath: string): string {
        return `${this.scopePrefix()}${relPath}`;
    }

    private async canWrite(relPath: string): Promise<boolean> {
        if (!this.allowlist.has(relPath)) {
            return false;
        }
        const base = await this.baseProvider();
        return !base.has(relPath);
    }

    private rejectionMessage(relPath: string): string {
        const allowed = Array.from(this.allowlist).join(', ');
        return `Cannot modify "/${this.mountName}/${relPath}". Only [${allowed}] are writable in /${this.mountName}; snapshot fields are read-only.`;
    }

    private readOverlayEntry(relPath: string, opts?: VfsTargetOptions) {
        const key = this.scopedKey(relPath);
        if (opts?.staged === false) {
            return this.store.get(this.namespace, key, { target: opts.target });
        }
        return this.store.getPending(this.namespace, key, { target: opts?.target });
    }

    private async snapshot(
        opts?: VfsTargetOptions,
    ): Promise<Map<string, { content: string; writable: boolean; source: string }>> {
        const base = await this.baseProvider();
        const result = new Map<string, { content: string; writable: boolean; source: string }>();

        for (const [name, content] of base.entries()) {
            result.set(name, {
                content,
                writable: false,
                source: `${this.mountName}-snapshot`,
            });
        }

        const prefix = this.scopePrefix();
        const rows = this.store.lookup(this.namespace, {
            target: opts?.target,
            includeStaged: opts?.staged !== false,
        });

        for (const row of rows) {
            if (!row.key.startsWith(prefix)) {
                continue;
            }
            const rel = row.key.slice(prefix.length);
            // Snapshot always wins; overlays never shadow card/persona fields.
            if (!result.has(rel)) {
                result.set(rel, {
                    content: row.entry.content,
                    writable: this.allowlist.has(rel),
                    source: row.entry.source,
                });
            }
        }

        return result;
    }
}

/**
 * `/preset/*` — read-only files bundled with the active preset.
 */
export class PresetMount implements VfsMount {
    public readonly mountName = PRESET_MOUNT;
    public readonly writable = false;

    constructor(private filesProvider: () => Record<string, string>) {}

    setFilesProvider(provider: () => Record<string, string>): void {
        this.filesProvider = provider;
    }

    async stat(relPath: string): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${PRESET_MOUNT}`,
                name: PRESET_MOUNT,
                kind: 'directory',
                size: 0,
                writable: false,
                mount: PRESET_MOUNT,
            };
        }

        const map = this.normalizedFiles();
        const content = map.get(relPath);
        if (content !== undefined) {
            return {
                path: `/${PRESET_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'file',
                size: utf8ByteLength(content),
                writable: false,
                mount: PRESET_MOUNT,
                source: 'preset',
            };
        }

        if (hasDirectoryPrefix(map.keys(), relPath)) {
            return {
                path: `/${PRESET_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'directory',
                size: 0,
                writable: false,
                mount: PRESET_MOUNT,
            };
        }

        return null;
    }

    async listDir(relPath: string): Promise<VfsEntryStat[]> {
        const entries = Array.from(this.normalizedFiles().entries()).map(
            ([k, content]): [string, { content: string; source: string }] => [
                k,
                { content, source: 'preset' },
            ],
        );
        return listDirFromFlatMap(entries, relPath, `/${PRESET_MOUNT}`, PRESET_MOUNT, false);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const content = this.normalizedFiles().get(relPath);
        if (content === undefined) {
            throw new VfsNotFoundError(`/${PRESET_MOUNT}/${relPath}`);
        }
        return sliceLines(content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string): Promise<void> {
        throw new VfsReadOnlyError(`/${PRESET_MOUNT}/${relPath}`);
    }

    async editFile(relPath: string): Promise<ToolEditResult> {
        throw new VfsReadOnlyError(`/${PRESET_MOUNT}/${relPath}`);
    }

    async deleteFile(relPath: string): Promise<boolean> {
        throw new VfsReadOnlyError(`/${PRESET_MOUNT}/${relPath}`);
    }

    async listFiles(): Promise<VfsEntryStat[]> {
        const stats: VfsEntryStat[] = [];
        for (const [relPath, content] of this.normalizedFiles().entries()) {
            const fullPath = `/${PRESET_MOUNT}/${relPath}`;
            stats.push({
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(content),
                writable: false,
                mount: PRESET_MOUNT,
                source: 'preset',
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(): Promise<VfsSearchDocument[]> {
        const docs: VfsSearchDocument[] = [];
        for (const [relPath, content] of this.normalizedFiles().entries()) {
            const fullPath = `/${PRESET_MOUNT}/${relPath}`;
            docs.push({
                path: fullPath,
                title: basenameOf(fullPath),
                content,
            });
        }
        return docs;
    }

    private normalizedFiles(): Map<string, string> {
        const raw = this.filesProvider() ?? {};
        const map = new Map<string, string>();
        for (const [key, value] of Object.entries(raw)) {
            const clean = key.replace(/^\/+/, '');
            if (clean && typeof value === 'string') {
                map.set(clean, value);
            }
        }
        return map;
    }
}

/**
 * `/global/*` — cross-chat persistent writable storage backed by `HostBridge` extension data.
 */
export class GlobalMount implements VfsMount {
    public readonly mountName = GLOBAL_MOUNT;
    public readonly writable = true;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly bridge: HostBridge,
        private readonly storageKey: string = GLOBAL_VFS_EXTENSION_KEY,
    ) {}

    async stat(relPath: string): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${GLOBAL_MOUNT}`,
                name: GLOBAL_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: GLOBAL_MOUNT,
            };
        }

        const data = await this.loadAll();
        if (Object.hasOwn(data, relPath)) {
            const content = data[relPath];
            return {
                path: `/${GLOBAL_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'file',
                size: utf8ByteLength(content),
                writable: true,
                mount: GLOBAL_MOUNT,
                source: 'global',
            };
        }

        if (hasDirectoryPrefix(Object.keys(data), relPath)) {
            return {
                path: `/${GLOBAL_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'directory',
                size: 0,
                writable: true,
                mount: GLOBAL_MOUNT,
            };
        }

        return null;
    }

    async listDir(relPath: string): Promise<VfsEntryStat[]> {
        const data = await this.loadAll();
        const entries = Object.entries(data).map(
            ([k, content]): [string, { content: string; source: string }] => [
                k,
                { content, source: 'global' },
            ],
        );
        return listDirFromFlatMap(entries, relPath, `/${GLOBAL_MOUNT}`, GLOBAL_MOUNT, true);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const data = await this.loadAll();
        if (!Object.hasOwn(data, relPath)) {
            throw new VfsNotFoundError(`/${GLOBAL_MOUNT}/${relPath}`);
        }
        return sliceLines(data[relPath], opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string): Promise<void> {
        if (!relPath) {
            throw new VfsError('Cannot write to /global directory', 'EISDIR', `/${GLOBAL_MOUNT}`);
        }
        await this.enqueueMutation(async () => {
            const data = await this.loadAll();
            data[relPath] = content;
            await this.bridge.saveExtensionData(this.storageKey, data);
        });
    }

    async editFile(relPath: string, oldText: string, newText: string): Promise<ToolEditResult> {
        const fullPath = `/${GLOBAL_MOUNT}/${relPath}`;
        return await this.enqueueMutation(async () => {
            const data = await this.loadAll();
            if (!Object.hasOwn(data, relPath)) {
                return { ok: false, path: fullPath, message: `File not found: ${fullPath}` };
            }
            const current = data[relPath];
            if (!oldText || !current.includes(oldText)) {
                return { ok: false, path: fullPath, message: `Target text not found in ${fullPath}` };
            }
            data[relPath] = current.replace(oldText, newText);
            await this.bridge.saveExtensionData(this.storageKey, data);
            return { ok: true, path: fullPath, message: `Edited ${fullPath}` };
        });
    }

    async deleteFile(relPath: string): Promise<boolean> {
        return await this.enqueueMutation(async () => {
            const data = await this.loadAll();
            if (!Object.hasOwn(data, relPath)) {
                return false;
            }
            delete data[relPath];
            await this.bridge.saveExtensionData(this.storageKey, data);
            return true;
        });
    }

    async listFiles(): Promise<VfsEntryStat[]> {
        const data = await this.loadAll();
        const stats: VfsEntryStat[] = [];
        for (const [relPath, content] of Object.entries(data)) {
            const fullPath = `/${GLOBAL_MOUNT}/${relPath}`;
            stats.push({
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(content),
                writable: true,
                mount: GLOBAL_MOUNT,
                source: 'global',
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(): Promise<VfsSearchDocument[]> {
        const data = await this.loadAll();
        const docs: VfsSearchDocument[] = [];
        for (const [relPath, content] of Object.entries(data)) {
            const fullPath = `/${GLOBAL_MOUNT}/${relPath}`;
            docs.push({
                path: fullPath,
                title: basenameOf(fullPath),
                content,
            });
        }
        return docs;
    }

    private async loadAll(): Promise<Record<string, string>> {
        const raw = await this.bridge.loadExtensionData<Record<string, unknown>>(this.storageKey, {});
        const result: Record<string, string> = {};
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [k, v] of Object.entries(raw)) {
                const clean = k.replace(/^\/+/, '');
                if (clean && typeof v === 'string') {
                    result[clean] = v;
                }
            }
        }
        return result;
    }

    private enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.writeQueue.then(fn, fn);
        this.writeQueue = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }
}

/**
 * `/history/*` — compacted conversation chunks (`/history/chunk-*.md`) and `/history/summary.md`.
 * Strictly read-only for normal agents; updated internally by watermark compaction.
 */
export class HistoryMount implements VfsMount {
    public readonly mountName = HISTORY_MOUNT;
    public readonly writable = false;

    constructor(private readonly bridge: HostBridge) {}

    /** Internal write entry point reserved for context watermark compaction. */
    async writeInternal(relPath: string, content: string): Promise<void> {
        const clean = relPath.replace(/^\/+/, '');
        if (!clean) {
            throw new VfsError('Invalid /history target path', 'EINVAL', `/${HISTORY_MOUNT}`);
        }
        const map = this.getHistoryRecord(true);
        map[clean] = content;
        this.bridge.saveChatDebounced();
    }

    /** Internal delete entry point reserved for compaction/reset. */
    async deleteInternal(relPath: string): Promise<boolean> {
        const clean = relPath.replace(/^\/+/, '');
        const map = this.getHistoryRecord(false);
        if (!map || !Object.hasOwn(map, clean)) {
            return false;
        }
        delete map[clean];
        this.bridge.saveChatDebounced();
        return true;
    }

    async stat(relPath: string): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${HISTORY_MOUNT}`,
                name: HISTORY_MOUNT,
                kind: 'directory',
                size: 0,
                writable: false,
                mount: HISTORY_MOUNT,
            };
        }

        const map = this.getHistoryRecord(false) ?? {};
        if (Object.hasOwn(map, relPath)) {
            return {
                path: `/${HISTORY_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'file',
                size: utf8ByteLength(map[relPath]),
                writable: false,
                mount: HISTORY_MOUNT,
                source: 'compaction',
            };
        }

        if (hasDirectoryPrefix(Object.keys(map), relPath)) {
            return {
                path: `/${HISTORY_MOUNT}/${relPath}`,
                name: basenameOf(`/${relPath}`),
                kind: 'directory',
                size: 0,
                writable: false,
                mount: HISTORY_MOUNT,
            };
        }

        return null;
    }

    async listDir(relPath: string): Promise<VfsEntryStat[]> {
        const map = this.getHistoryRecord(false) ?? {};
        const entries = Object.entries(map).map(
            ([k, content]): [string, { content: string; source: string }] => [
                k,
                { content, source: 'compaction' },
            ],
        );
        return listDirFromFlatMap(entries, relPath, `/${HISTORY_MOUNT}`, HISTORY_MOUNT, false);
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const map = this.getHistoryRecord(false);
        if (!map || !Object.hasOwn(map, relPath)) {
            throw new VfsNotFoundError(`/${HISTORY_MOUNT}/${relPath}`);
        }
        return sliceLines(map[relPath], opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string): Promise<void> {
        throw new VfsReadOnlyError(
            `/${HISTORY_MOUNT}/${relPath}`,
            `/${HISTORY_MOUNT} is read-only for agents; only internal watermark compaction may write archived history.`,
        );
    }

    async editFile(relPath: string): Promise<ToolEditResult> {
        throw new VfsReadOnlyError(
            `/${HISTORY_MOUNT}/${relPath}`,
            `/${HISTORY_MOUNT} is read-only for agents.`,
        );
    }

    async deleteFile(relPath: string): Promise<boolean> {
        throw new VfsReadOnlyError(
            `/${HISTORY_MOUNT}/${relPath}`,
            `/${HISTORY_MOUNT} is read-only for agents.`,
        );
    }

    async listFiles(): Promise<VfsEntryStat[]> {
        const map = this.getHistoryRecord(false) ?? {};
        const stats: VfsEntryStat[] = [];
        for (const [relPath, content] of Object.entries(map)) {
            const fullPath = `/${HISTORY_MOUNT}/${relPath}`;
            stats.push({
                path: fullPath,
                name: basenameOf(fullPath),
                kind: 'file',
                size: utf8ByteLength(content),
                writable: false,
                mount: HISTORY_MOUNT,
                source: 'compaction',
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(): Promise<VfsSearchDocument[]> {
        const map = this.getHistoryRecord(false) ?? {};
        const docs: VfsSearchDocument[] = [];
        for (const [relPath, content] of Object.entries(map)) {
            const fullPath = `/${HISTORY_MOUNT}/${relPath}`;
            docs.push({
                path: fullPath,
                title: basenameOf(fullPath),
                content,
            });
        }
        return docs;
    }

    private getHistoryRecord(create: true): Record<string, string>;
    private getHistoryRecord(create: false): Record<string, string> | null;
    private getHistoryRecord(create: boolean): Record<string, string> | null {
        const metadata = this.bridge.getMetadata();
        const raw = metadata[AGENTIC_HISTORY_KEY];
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as Record<string, string>;
        }
        if (!create) {
            return null;
        }
        const created: Record<string, string> = {};
        metadata[AGENTIC_HISTORY_KEY] = created;
        return created;
    }
}

/**
 * `/output.md` — non-layered per-`(messageId, swipeId)` output mount backed directly
 * by `HostBridge.readChatMessage` / `writeChatMessage`, with a `preCreateBuffers`
 * map for companion-mode `before_turn` writes before the host creates the AI bubble.
 */
export class OutputMount implements VfsMount {
    public readonly mountName = 'output';
    public readonly writable = true;
    private readonly preCreateBuffers = new Map<BranchKey, string>();

    constructor(private readonly bridge: HostBridge) {}

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            return null;
        }
        const target = this.resolveTarget(opts);
        if (!target) {
            return null;
        }
        const hostContent = this.bridge.readChatMessage(target);
        const current = hostContent ?? this.preCreateBuffers.get(toBranchKey(target)) ?? '';
        return {
            path: OUTPUT_FILE_PATH,
            name: OUTPUT_FILE_NAME,
            kind: 'file',
            size: utf8ByteLength(current),
            writable: true,
            mount: this.mountName,
        };
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        if (relPath !== '') {
            return [];
        }
        const entry = await this.stat(OUTPUT_FILE_NAME, opts);
        return entry ? [entry] : [];
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            throw new VfsNotFoundError(`/${relPath}`);
        }
        const target = this.resolveTarget(opts);
        if (!target) {
            return sliceLines('', opts.startLine, opts.endLine);
        }

        const branchKey = toBranchKey(target);
        const raw = this.bridge.readChatMessage(target);
        if (raw !== null) {
            this.preCreateBuffers.delete(branchKey);
            return sliceLines(raw, opts.startLine, opts.endLine);
        }

        const buffered = this.preCreateBuffers.get(branchKey) ?? '';
        return sliceLines(buffered, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            throw new VfsNotFoundError(`/${relPath}`);
        }
        const target = this.resolveTarget(opts);
        if (!target) {
            throw new VfsError(
                'No target message available for /output.md',
                'EINVAL',
                OUTPUT_FILE_PATH,
            );
        }

        const branchKey = toBranchKey(target);
        if (this.bridge.readChatMessage(target) !== null) {
            this.preCreateBuffers.delete(branchKey);
            await this.bridge.writeChatMessage(target, content, { emitEvent: false });
        } else {
            this.preCreateBuffers.set(branchKey, content);
        }
    }

    async appendFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            throw new VfsNotFoundError(`/${relPath}`);
        }
        const current = await this.readFile(relPath, opts);
        await this.writeFile(relPath, `${current}${content}`, opts);
    }

    async editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts: VfsWriteOptions = {},
    ): Promise<ToolEditResult> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            return { ok: false, path: `/${relPath}`, message: `File not found: /${relPath}` };
        }
        const current = await this.readFile(relPath, opts);
        if (!oldText || !current.includes(oldText)) {
            return {
                ok: false,
                path: OUTPUT_FILE_PATH,
                message: `Target text not found in ${OUTPUT_FILE_PATH}`,
            };
        }
        const updated = current.replace(oldText, newText);
        if (updated !== current) {
            await this.writeFile(relPath, updated, opts);
        }
        return {
            ok: true,
            path: OUTPUT_FILE_PATH,
            message: `Edited ${OUTPUT_FILE_PATH}`,
        };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        if (relPath !== '' && relPath !== OUTPUT_FILE_NAME) {
            return false;
        }
        const target = this.resolveTarget(opts);
        if (!target) {
            return false;
        }
        this.preCreateBuffers.delete(toBranchKey(target));
        if (this.bridge.readChatMessage(target) !== null) {
            await this.bridge.writeChatMessage(target, '', { emitEvent: false });
        }
        return true;
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const entry = await this.stat(OUTPUT_FILE_NAME, opts);
        return entry ? [entry] : [];
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const target = this.resolveTarget(opts);
        if (!target) {
            return [];
        }
        const hostContent = this.bridge.readChatMessage(target);
        const current = hostContent ?? this.preCreateBuffers.get(toBranchKey(target)) ?? '';
        if (!current) {
            return [];
        }
        return [
            {
                path: OUTPUT_FILE_PATH,
                title: OUTPUT_FILE_NAME,
                content: current,
            },
        ];
    }

    /** Retrieve and clear any buffered `before_turn` output for `target`. */
    flushPreCreateBuffer(target: MessageTarget): string | undefined {
        const key = toBranchKey(target);
        const buffered = this.preCreateBuffers.get(key);
        if (buffered !== undefined) {
            this.preCreateBuffers.delete(key);
        }
        return buffered;
    }

    /** Inspect any buffered `before_turn` output for `target` without clearing it. */
    peekPreCreateBuffer(target: MessageTarget): string | undefined {
        return this.preCreateBuffers.get(toBranchKey(target));
    }

    /** Discard all pre-create buffers belonging to messages `>= messageId`. */
    clearPreCreateBuffersFrom(messageId: number): void {
        if (!Number.isInteger(messageId) || messageId < 0) {
            return;
        }
        for (const key of Array.from(this.preCreateBuffers.keys())) {
            const parsed = parseBranchKey(key);
            if (parsed && parsed.messageId >= messageId) {
                this.preCreateBuffers.delete(key);
            }
        }
    }

    private resolveTarget(opts?: VfsTargetOptions): MessageTarget | null {
        if (
            opts?.target
            && Number.isInteger(opts.target.messageId)
            && opts.target.messageId >= 0
            && Number.isInteger(opts.target.swipeId)
            && opts.target.swipeId >= 0
        ) {
            return {
                messageId: opts.target.messageId,
                swipeId: opts.target.swipeId,
            };
        }

        const chat = this.bridge.getChat();
        if (!Array.isArray(chat) || chat.length === 0) {
            return null;
        }
        const messageId = chat.length - 1;
        const swipeId = chat[messageId]?.swipeId ?? 0;
        if (!Number.isInteger(swipeId) || swipeId < 0) {
            return null;
        }
        return { messageId, swipeId };
    }
}
