import MiniSearch from 'minisearch';
import type { HostBridge, ToolEditResult } from '@/core/bridge';
import { ChatDataStore } from '@/core/store';
import type {
    LoreReadHook,
    MessageTarget,
    ScopedPermissions,
    VfsEntryStat,
    VfsSearchHit,
} from '@/core/types';
import { matchGlob, normalizeVfsPath } from '@/core/utils';
import {
    VfsError,
    VfsInvalidPathError,
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    VfsReadOnlyError,
    type VfsSearchDocument,
    type VfsTargetOptions,
    type VfsWriteOptions,
    sortStats,
} from './fs-base';
import {
    CHARACTER_MOUNT,
    GLOBAL_MOUNT,
    GlobalMount,
    HISTORY_MOUNT,
    HistoryMount,
    HybridMount,
    OUTPUT_FILE_NAME,
    OUTPUT_FILE_PATH,
    OutputMount,
    PERSONA_MOUNT,
    PRESET_MOUNT,
    PresetMount,
    STATE_MOUNT,
    VARIABLES_FILE_NAME,
    VariablesMount,
    WorkspaceMount,
    characterSnapshot,
    personaSnapshot,
} from './fs-mounts';
import {
    LOREBOOK_MOUNT,
    SKILLS_MOUNT,
    SkillsMount,
    WorldInfoMount,
} from './fs-worldinfo';
import { ScopedToolGuard } from './fs-scopes';

export interface VirtualFileSystemOptions {
    bridge: HostBridge;
    store?: ChatDataStore;
    loreReadHook?: LoreReadHook;
    getPresetFiles?: () => Record<string, string>;
    defaultTarget?: MessageTarget;
    defaultStaged?: boolean;
}

export interface VfsSearchOptions extends VfsTargetOptions {
    pathPrefix?: string;
    limit?: number;
}

export interface VfsGrepOptions extends VfsTargetOptions {
    pathPrefix?: string;
    caseSensitive?: boolean;
    regex?: boolean;
    limit?: number;
}

interface RoutedTarget {
    mount: VfsMount;
    relPath: string;
    normalizedPath: string;
    isVirtualStateDir?: boolean;
}

/**
 * Tokenize text into search terms: preserves emoji sequences, emits ASCII words,
 * and produces bigrams (plus singletons for 1-char runs) for CJK text.
 */
export function smartTokenize(text: string): string[] {
    if (!text) {
        return [];
    }

    const tokens: string[] = [];
    const emojiRegex = /\p{Extended_Pictographic}(\u200d\p{Extended_Pictographic})*/gu;
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = emojiRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
            tokens.push(...tokenizePlainSegment(text.slice(lastIndex, match.index)));
        }
        tokens.push(match[0]);
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
        tokens.push(...tokenizePlainSegment(text.slice(lastIndex)));
    }

    return tokens;
}

function tokenizePlainSegment(segment: string): string[] {
    const tokens: string[] = [];
    for (const part of segment.split(/[\s\u3000/\\.,:;!?()[\]{}"'`~|<>+=*&^%$#@_-]+/)) {
        if (!part) {
            continue;
        }

        // Split alternating ASCII alphanumeric runs from CJK/other script runs.
        const subRuns = part.match(/[a-zA-Z0-9]+|[^a-zA-Z0-9]+/g);
        if (!subRuns) {
            continue;
        }

        for (const run of subRuns) {
            if (/^[a-zA-Z0-9]+$/.test(run)) {
                tokens.push(run.toLowerCase());
                continue;
            }
            if (run.length === 1) {
                tokens.push(run);
                continue;
            }
            for (let i = 0; i <= run.length - 2; ++i) {
                tokens.push(run.slice(i, i + 2));
            }
        }
    }
    return tokens;
}

/** Run MiniSearch BM25 + fuzzy ranking over VFS search documents. */
export function searchDocuments(
    docs: VfsSearchDocument[],
    query: string,
    limit: number = 25,
): VfsSearchHit[] {
    const cap = Math.max(1, limit);
    const trimmed = query.trim();
    if (!trimmed || docs.length === 0) {
        return docs.slice(0, cap).map((doc) => ({
            path: doc.path,
            score: 0,
            title: doc.title,
            snippet: buildSnippet(doc.content, []),
            matchedTerms: [],
        }));
    }

    const index = new MiniSearch<VfsSearchDocument & { id: number }>({
        fields: ['path', 'title', 'keys', 'keysecondary', 'content', 'world', 'uid'],
        storeFields: ['path', 'title', 'content'],
        tokenize: smartTokenize,
        extractField: (doc, field) => {
            const val = (doc as unknown as Record<string, unknown>)[field];
            return val == null ? '' : String(val);
        },
    });

    const indexedDocs = docs.map((doc, idx) => ({ ...doc, id: idx }));
    index.addAll(indexedDocs);

    const results = index.search(trimmed, {
        combineWith: 'OR',
        prefix: true,
        fuzzy: 0.2,
        boost: {
            keys: 2.5,
            title: 2.0,
            uid: 2.0,
            path: 1.8,
            keysecondary: 1.5,
            world: 0.5,
            content: 1.0,
        },
    });

    return results.slice(0, cap).map((res) => {
        const content = String(res.content ?? '');
        const terms = Array.isArray(res.terms) ? res.terms : [];
        return {
            path: String(res.path ?? ''),
            score: res.score,
            title: typeof res.title === 'string' ? res.title : undefined,
            snippet: buildSnippet(content, terms, trimmed),
            matchedTerms: terms,
        };
    });
}

function buildSnippet(content: string, matchedTerms: string[], rawQuery: string = ''): string {
    if (!content) {
        return '';
    }
    const maxLen = 140;
    const lower = content.toLowerCase();
    const candidates = [rawQuery.trim().toLowerCase(), ...matchedTerms.map((t) => t.toLowerCase())].filter(Boolean);

    let hitIdx = -1;
    for (const term of candidates) {
        const idx = lower.indexOf(term);
        if (idx >= 0) {
            hitIdx = idx;
            break;
        }
    }

    if (hitIdx < 0 || content.length <= maxLen) {
        return content.slice(0, maxLen).replace(/\s+/g, ' ').trim();
    }

    const start = Math.max(0, hitIdx - 40);
    const end = Math.min(content.length, start + maxLen);
    const slice = content.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '...' : ''}${slice}${end < content.length ? '...' : ''}`;
}

/**
 * Full-topology Virtual File System for ST-Agentic.
 *
 * Mounts:
 * - `/` workspace root (`rw`, `files` namespace)
 * - `/output.md` (`rw`, non-layered per-target host chat message output)
 * - `/state/variables.json` (`rw`, `variables` namespace, aligned with `[InitVar]` / legacy)
 * - `/character/*` (`ro` snapshot + `character-files` overlay)
 * - `/persona/*` (`ro` snapshot + `persona-files` overlay)
 * - `/lorebooks/<book>/<slug>-<uid>.md` (`ro` base + `worldinfo` `rw` override + `LoreReadHook`)
 * - `/skills/<name>.md` (`ro`, `@@skill` entries)
 * - `/preset/*` (`ro`, `Preset.files`)
 * - `/global/*` (`rw`, `HostBridge` global extension storage)
 * - `/history/*` (`ro` for agents, internal write API for compaction)
 */
export class VirtualFileSystem {
    public readonly bridge: HostBridge;
    public readonly store: ChatDataStore;

    private readonly workspaceMount: WorkspaceMount;
    private readonly outputMount: OutputMount;
    private readonly variablesMount: VariablesMount;
    private readonly characterMount: HybridMount;
    private readonly personaMount: HybridMount;
    private readonly worldInfoMount: WorldInfoMount;
    private readonly skillsMount: SkillsMount;
    private readonly presetMount: PresetMount;
    private readonly globalMount: GlobalMount;
    private readonly historyMount: HistoryMount;
    private readonly namedMounts: Map<string, VfsMount>;

    private readonly defaultTarget?: MessageTarget;
    private readonly defaultStaged?: boolean;

    constructor(options: VirtualFileSystemOptions) {
        this.bridge = options.bridge;
        this.store = options.store ?? new ChatDataStore(options.bridge);
        this.defaultTarget = options.defaultTarget;
        this.defaultStaged = options.defaultStaged;

        this.workspaceMount = new WorkspaceMount(this.store);
        this.outputMount = new OutputMount(this.bridge);
        this.variablesMount = new VariablesMount(this.bridge, this.store);
        this.characterMount = new HybridMount(
            CHARACTER_MOUNT,
            () => characterSnapshot(this.bridge),
            this.store,
            'character-files',
            () => this.bridge.getActiveIdentity().characterAvatar || 'default',
        );
        this.personaMount = new HybridMount(
            PERSONA_MOUNT,
            () => personaSnapshot(this.bridge),
            this.store,
            'persona-files',
            () => this.bridge.getActiveIdentity().personaAvatar || 'default',
        );
        this.worldInfoMount = new WorldInfoMount(this.bridge, this.store, options.loreReadHook);
        this.skillsMount = new SkillsMount(this.bridge);
        this.presetMount = new PresetMount(options.getPresetFiles ?? (() => ({})));
        this.globalMount = new GlobalMount(this.bridge);
        this.historyMount = new HistoryMount(this.bridge);

        this.namedMounts = new Map<string, VfsMount>([
            [CHARACTER_MOUNT, this.characterMount],
            [PERSONA_MOUNT, this.personaMount],
            [LOREBOOK_MOUNT, this.worldInfoMount],
            [SKILLS_MOUNT, this.skillsMount],
            [PRESET_MOUNT, this.presetMount],
            [GLOBAL_MOUNT, this.globalMount],
            [HISTORY_MOUNT, this.historyMount],
        ]);
    }

    /** Inject or replace the `LoreReadHook` used when reading `/lorebooks/*` files. */
    setLoreReadHook(hook?: LoreReadHook): void {
        this.worldInfoMount.setLoreReadHook(hook);
    }

    /** Update the preset files provider feeding `/preset/*`. */
    setPresetFilesProvider(provider: () => Record<string, string>): void {
        this.presetMount.setFilesProvider(provider);
    }

    /** Normalize a VFS path (rejecting `..` traversal and null bytes). */
    normalizePath(path: string): string {
        try {
            return normalizeVfsPath(path);
        } catch (error) {
            throw new VfsInvalidPathError(path, (error as Error).message);
        }
    }

    async stat(path: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir) {
            return {
                path: `/${STATE_MOUNT}`,
                name: STATE_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: STATE_MOUNT,
            };
        }
        return await routed.mount.stat(routed.relPath, this.mergeReadOpts(opts));
    }

    async exists(path: string, opts?: VfsTargetOptions): Promise<boolean> {
        return (await this.stat(path, opts)) !== null;
    }

    async listDir(dirPath: string = '/', opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const merged = this.mergeReadOpts(opts);
        const routed = this.route(dirPath);

        if (routed.normalizedPath === '/') {
            const workspaceItems = await this.workspaceMount.listDir('', merged);
            const mergedMap = new Map<string, VfsEntryStat>();
            for (const item of workspaceItems) {
                mergedMap.set(item.name, item);
            }
            const outputStat = await this.outputMount.stat('', merged);
            if (outputStat) {
                mergedMap.set(OUTPUT_FILE_NAME, outputStat);
            }
            for (const [mountName, mount] of this.namedMounts.entries()) {
                mergedMap.set(mountName, {
                    path: `/${mountName}`,
                    name: mountName,
                    kind: 'directory',
                    size: 0,
                    writable: mount.writable,
                    mount: mountName,
                });
            }
            mergedMap.set(STATE_MOUNT, {
                path: `/${STATE_MOUNT}`,
                name: STATE_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: STATE_MOUNT,
            });
            return sortStats(Array.from(mergedMap.values()));
        }

        if (routed.isVirtualStateDir) {
            const varEntries = await this.variablesMount.listDir('', merged);
            const wsEntries = await this.workspaceMount.listDir(STATE_MOUNT, merged);
            const combined = new Map<string, VfsEntryStat>();
            for (const item of wsEntries) {
                combined.set(item.name, item);
            }
            for (const item of varEntries) {
                combined.set(item.name, item);
            }
            return sortStats(Array.from(combined.values()));
        }

        return await routed.mount.listDir(routed.relPath, merged);
    }

    async readFile(path: string, opts?: VfsReadOptions): Promise<string> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir || (!routed.relPath && routed.mount !== this.workspaceMount)) {
            throw new VfsError(`Path is a directory: ${routed.normalizedPath}`, 'EISDIR', routed.normalizedPath);
        }
        if (routed.normalizedPath === '/') {
            throw new VfsError('Path is a directory: /', 'EISDIR', '/');
        }
        return await routed.mount.readFile(routed.relPath, this.mergeReadOpts(opts));
    }

    async writeFile(path: string, content: string, opts?: VfsWriteOptions): Promise<void> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir || !routed.relPath) {
            throw new VfsError(`Cannot write to directory: ${routed.normalizedPath}`, 'EISDIR', routed.normalizedPath);
        }
        await routed.mount.writeFile(routed.relPath, content, this.mergeWriteOpts(opts));
    }

    async appendFile(path: string, content: string, opts?: VfsWriteOptions): Promise<void> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir || !routed.relPath) {
            throw new VfsError(`Cannot append to directory: ${routed.normalizedPath}`, 'EISDIR', routed.normalizedPath);
        }
        if (!routed.mount.writable) {
            throw new VfsReadOnlyError(routed.normalizedPath);
        }
        const mergedWriteOpts = this.mergeWriteOpts(opts);
        if (typeof routed.mount.appendFile === 'function') {
            await routed.mount.appendFile(routed.relPath, content, mergedWriteOpts);
            return;
        }
        let current = '';
        try {
            current = await routed.mount.readFile(routed.relPath, this.mergeReadOpts(opts));
        } catch (error) {
            if (!(error instanceof VfsNotFoundError)) {
                throw error;
            }
        }
        await routed.mount.writeFile(routed.relPath, `${current}${content}`, mergedWriteOpts);
    }

    async editFile(
        path: string,
        oldText: string,
        newText: string,
        opts?: VfsWriteOptions,
    ): Promise<ToolEditResult> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir || !routed.relPath) {
            throw new VfsError(`Cannot edit directory: ${routed.normalizedPath}`, 'EISDIR', routed.normalizedPath);
        }
        return await routed.mount.editFile(routed.relPath, oldText, newText, this.mergeWriteOpts(opts));
    }

    async deleteFile(path: string, opts?: VfsWriteOptions): Promise<boolean> {
        const routed = this.route(path);
        if (routed.isVirtualStateDir || !routed.relPath) {
            throw new VfsError(`Cannot delete directory: ${routed.normalizedPath}`, 'EISDIR', routed.normalizedPath);
        }
        return await routed.mount.deleteFile(routed.relPath, this.mergeWriteOpts(opts));
    }

    async globFiles(pattern: string, opts?: VfsTargetOptions): Promise<string[]> {
        if (typeof pattern !== 'string' || pattern.includes('\0') || pattern.split(/[\\/]/).includes('..')) {
            throw new VfsInvalidPathError(pattern, `Invalid or traversal glob pattern: ${pattern}`);
        }

        const merged = this.mergeReadOpts(opts);
        const allStats = await this.collectAllFileStats(merged);
        const matched = new Set<string>();

        for (const stat of allStats) {
            if (matchGlob(pattern, stat.path)) {
                matched.add(stat.path);
            }
        }

        return Array.from(matched).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    async grepSearch(
        query: string,
        optsOrPrefix?: string | VfsGrepOptions,
    ): Promise<VfsSearchHit[]> {
        const opts: VfsGrepOptions =
            typeof optsOrPrefix === 'string' ? { pathPrefix: optsOrPrefix } : (optsOrPrefix ?? {});
        const prefix = this.normalizePath(opts.pathPrefix ?? '/');
        const caseSensitive = opts.caseSensitive !== false;
        const limit = Math.max(1, opts.limit ?? 100);
        const merged = this.mergeReadOpts(opts);

        let matcher: (line: string) => boolean;
        if (opts.regex) {
            let re: RegExp;
            try {
                re = new RegExp(query, caseSensitive ? '' : 'i');
            } catch (error) {
                throw new VfsError(`Invalid grep regex: ${(error as Error).message}`, 'EINVAL', prefix);
            }
            matcher = (line) => re.test(line);
        } else {
            const needle = caseSensitive ? query : query.toLowerCase();
            matcher = (line) => (caseSensitive ? line : line.toLowerCase()).includes(needle);
        }

        const docs = await this.collectScopedSearchDocs(prefix, merged);
        const hits: VfsSearchHit[] = [];

        for (const doc of docs) {
            const text = doc.keys || doc.title
                ? `${doc.title ? `# ${doc.title}\n` : ''}${doc.keys ? `keys: ${doc.keys}\n` : ''}${doc.content}`
                : doc.content;
            const lines = text.split('\n');
            for (let idx = 0; idx < lines.length; ++idx) {
                if (matcher(lines[idx])) {
                    hits.push({
                        path: doc.path,
                        score: 1,
                        title: doc.title,
                        line: idx + 1,
                        snippet: lines[idx].trim().slice(0, 160),
                    });
                    if (hits.length >= limit) {
                        return hits;
                    }
                }
            }
        }

        return hits;
    }

    async searchFiles(query: string, opts: VfsSearchOptions = {}): Promise<VfsSearchHit[]> {
        const prefix = this.normalizePath(opts.pathPrefix ?? '/');
        const limit = opts.limit ?? 25;
        const merged = this.mergeReadOpts(opts);
        const docs = await this.collectScopedSearchDocs(prefix, merged);
        return searchDocuments(docs, query, limit);
    }

    /** Convenience helper to read parsed `/state/variables.json`. */
    async readVariables(opts?: VfsTargetOptions): Promise<Record<string, unknown>> {
        return await this.variablesMount.readVariables(this.mergeReadOpts(opts));
    }

    /** Convenience helper to write `/state/variables.json` deterministically. */
    async writeVariables(vars: Record<string, unknown>, opts?: VfsWriteOptions): Promise<void> {
        await this.variablesMount.writeVariables(vars, this.mergeWriteOpts(opts));
    }

    /**
     * Internal write channel for `/history/*`, reserved for watermark compaction.
     * Normal `writeFile('/history/...')` calls are always rejected.
     */
    async writeHistoryInternal(path: string, content: string): Promise<void> {
        const relPath = this.resolveInternalHistoryPath(path);
        await this.historyMount.writeInternal(relPath, content);
    }

    /** Internal delete channel for `/history/*`, reserved for compaction/reset. */
    async deleteHistoryInternal(path: string): Promise<boolean> {
        const relPath = this.resolveInternalHistoryPath(path);
        return await this.historyMount.deleteInternal(relPath);
    }

    /** Retrieve and clear any buffered `before_turn` `/output.md` content for `target`. */
    flushPreCreateBuffer(target: MessageTarget): string | undefined {
        return this.outputMount.flushPreCreateBuffer(target);
    }

    /** Inspect any buffered `before_turn` `/output.md` content for `target` without clearing it. */
    peekPreCreateBuffer(target: MessageTarget): string | undefined {
        return this.outputMount.peekPreCreateBuffer(target);
    }

    /** Discard all `/output.md` pre-create buffers belonging to messages `>= messageId`. */
    clearPreCreateBuffersFrom(messageId: number): void {
        this.outputMount.clearPreCreateBuffersFrom(messageId);
    }

    /** Create a `ScopedToolGuard` enforcing `ScopedPermissions` over this VFS. */
    createScopedGuard(
        permissions: ScopedPermissions,
        opts?: { target?: MessageTarget; staged?: boolean; source?: string },
    ): ScopedToolGuard {
        return new ScopedToolGuard(this, permissions, {
            target: opts?.target ?? this.defaultTarget,
            staged: opts?.staged ?? this.defaultStaged,
            source: opts?.source,
        });
    }

    private resolveInternalHistoryPath(path: string): string {
        const raw = path.trim();
        const prefixed = raw.startsWith('/') ? raw : `/${HISTORY_MOUNT}/${raw}`;
        const normalized = this.normalizePath(prefixed);
        if (!normalized.startsWith(`/${HISTORY_MOUNT}/`)) {
            throw new VfsInvalidPathError(
                path,
                `Internal history write path must reside inside /${HISTORY_MOUNT}/: ${path}`,
            );
        }
        return normalized.slice(HISTORY_MOUNT.length + 2);
    }

    private route(rawPath: string): RoutedTarget {
        const normalized = this.normalizePath(rawPath);
        if (normalized === `/${STATE_MOUNT}/${VARIABLES_FILE_NAME}`) {
            return {
                mount: this.variablesMount,
                relPath: VARIABLES_FILE_NAME,
                normalizedPath: normalized,
            };
        }

        if (normalized === OUTPUT_FILE_PATH) {
            return {
                mount: this.outputMount,
                relPath: OUTPUT_FILE_NAME,
                normalizedPath: OUTPUT_FILE_PATH,
            };
        }

        if (normalized === `/${STATE_MOUNT}`) {
            return {
                mount: this.workspaceMount,
                relPath: STATE_MOUNT,
                normalizedPath: normalized,
                isVirtualStateDir: true,
            };
        }

        if (normalized === '/') {
            return {
                mount: this.workspaceMount,
                relPath: '',
                normalizedPath: '/',
            };
        }

        const slash = normalized.indexOf('/', 1);
        const firstSeg = slash >= 0 ? normalized.slice(1, slash) : normalized.slice(1);
        const named = this.namedMounts.get(firstSeg);
        if (named) {
            return {
                mount: named,
                relPath: slash >= 0 ? normalized.slice(slash + 1) : '',
                normalizedPath: normalized,
            };
        }

        return {
            mount: this.workspaceMount,
            relPath: normalized.slice(1),
            normalizedPath: normalized,
        };
    }

    private allMounts(): VfsMount[] {
        return [
            this.workspaceMount,
            this.outputMount,
            this.variablesMount,
            this.characterMount,
            this.personaMount,
            this.worldInfoMount,
            this.skillsMount,
            this.presetMount,
            this.globalMount,
            this.historyMount,
        ];
    }

    private async collectAllFileStats(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const lists = await Promise.all(this.allMounts().map((m) => m.listFiles(opts)));
        return lists.flat();
    }

    private async collectScopedSearchDocs(
        prefix: string,
        opts?: VfsTargetOptions,
    ): Promise<VfsSearchDocument[]> {
        const targetMounts = this.selectMountsForPrefix(prefix);
        const docLists = await Promise.all(targetMounts.map((m) => m.collectSearchDocs(opts)));
        const all = docLists.flat();

        if (prefix === '/') {
            return all;
        }
        const dirPrefix = `${prefix}/`;
        return all.filter((doc) => doc.path === prefix || doc.path.startsWith(dirPrefix));
    }

    private selectMountsForPrefix(prefix: string): VfsMount[] {
        if (prefix === '/') {
            return this.allMounts();
        }
        if (prefix === OUTPUT_FILE_PATH) {
            return [this.outputMount];
        }
        if (prefix === `/${STATE_MOUNT}/${VARIABLES_FILE_NAME}`) {
            return [this.variablesMount];
        }
        if (prefix === `/${STATE_MOUNT}`) {
            return [this.variablesMount, this.workspaceMount];
        }

        const slash = prefix.indexOf('/', 1);
        const firstSeg = slash >= 0 ? prefix.slice(1, slash) : prefix.slice(1);
        const named = this.namedMounts.get(firstSeg);
        if (named) {
            return [named];
        }
        return [this.workspaceMount];
    }

    private mergeReadOpts<T extends VfsTargetOptions>(opts?: T): T {
        return {
            ...(opts ?? ({} as T)),
            target: opts?.target ?? this.defaultTarget,
            staged: opts?.staged ?? this.defaultStaged,
        };
    }

    private mergeWriteOpts(opts?: VfsWriteOptions): VfsWriteOptions {
        const target = opts?.target ?? this.defaultTarget;
        let staged = opts?.staged ?? this.defaultStaged;
        if (staged === undefined && !target && this.bridge.getChat().length === 0) {
            staged = true;
        }
        return {
            ...(opts ?? {}),
            target,
            staged,
        };
    }
}

export {
    VfsError,
    VfsInvalidPathError,
    VfsNotFoundError,
    VfsPermissionError,
    VfsReadOnlyError,
    type VfsReadOptions,
    type VfsTargetOptions,
    type VfsWriteOptions,
} from './fs-base';
