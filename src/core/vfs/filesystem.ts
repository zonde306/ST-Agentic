import MiniSearch from 'minisearch';
import { type HostBridge, type ToolEditResult, runPromptTransform } from '@/core/bridge';
import type { DocsRegistry } from '@/core/docs';
import { ChatDataStore } from '@/core/store';
import type {
    LoreReadHook,
    MessageTarget,
    ScopedPermissions,
    SideClueDoc,
    SideClueMeta,
    SideClueWriteInput,
    VfsEntryStat,
    VfsSearchHit,
} from '@/core/types';
import { matchGlob, normalizeVfsPath } from '@/core/utils';
import {
    VfsError,
    type VfsEditOptions,
    VfsInvalidPathError,
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    VfsReadOnlyError,
    type VfsSearchDocument,
    type VfsTargetOptions,
    type VfsTemplateEvaluator,
    type VfsWriteOptions,
    sliceLines,
    sortStats,
} from './fs-base';
import { countLines, grepLinesInText, lineNumberAtOffset } from './text-ops';
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
    VARIABLES_FILE_NAMES,
    VariablesMount,
    WorkspaceMount,
    characterSnapshot,
    personaSnapshot,
    variablesFileNameToScope,
} from './fs-mounts';
import {
    LOREBOOK_MOUNT,
    SKILLS_MOUNT,
    SkillsMount,
    WorldInfoMount,
} from './fs-worldinfo';
import {
    SIDE_MOUNT,
    SideMount,
    type SideClueListOptions,
} from './fs-side';
import { BuiltinDocsMount, DOCS_MOUNT } from './fs-docs';
import { ScopedToolGuard } from './fs-scopes';

export interface VirtualFileSystemOptions {
    bridge: HostBridge;
    store?: ChatDataStore;
    loreReadHook?: LoreReadHook;
    getPresetFiles?: () => Record<string, string>;
    docsRegistry?: DocsRegistry;
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
    contextLines?: number;
    maxMatchesPerFile?: number;
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
        return docs.slice(0, cap).map((doc) => {
            const fullText = doc.frontmatter ? `${doc.frontmatter}${doc.content}` : doc.content;
            const totalLines = countLines(fullText);
            return {
                path: doc.path,
                score: 0,
                title: doc.title,
                ...(totalLines > 0 ? { line: 1 } : {}),
                totalLines,
                snippet: buildSnippet(doc.content, []),
                matchedTerms: [],
            };
        });
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
        const sourceDoc = docs[Number(res.id)];
        const content = sourceDoc?.content ?? String(res.content ?? '');
        const frontmatter = sourceDoc?.frontmatter ?? '';
        const contentLineOffset = sourceDoc?.contentLineOffset ?? 0;
        const fullText = frontmatter ? `${frontmatter}${content}` : content;
        const totalLines = countLines(fullText);
        const terms = Array.isArray(res.terms) ? res.terms : [];

        const bodyHitIdx = findFirstTermOffset(content, terms, trimmed);
        let line: number | undefined;
        let matchedIn: 'content' | 'meta';
        if (bodyHitIdx >= 0) {
            line = lineNumberAtOffset(content, bodyHitIdx) + contentLineOffset;
            matchedIn = 'content';
        } else if (frontmatter) {
            const fmHitIdx = findFirstTermOffset(frontmatter, terms, trimmed);
            line = fmHitIdx >= 0 ? lineNumberAtOffset(frontmatter, fmHitIdx) : 1;
            matchedIn = 'meta';
        } else {
            line = totalLines > 0 ? 1 : undefined;
            matchedIn = 'meta';
        }

        return {
            path: String(res.path ?? ''),
            score: res.score,
            title: typeof res.title === 'string' ? res.title : undefined,
            ...(line !== undefined ? { line } : {}),
            totalLines,
            matchedIn,
            snippet: buildSnippet(content, terms, trimmed),
            matchedTerms: terms,
        };
    });
}

function findFirstTermOffset(
    text: string,
    matchedTerms: readonly string[],
    rawQuery: string = '',
): number {
    if (!text) {
        return -1;
    }
    const lower = text.toLowerCase();
    const candidates = [
        rawQuery.trim().toLowerCase(),
        ...matchedTerms.map((t) => t.toLowerCase()),
    ].filter(Boolean);

    for (const term of candidates) {
        const idx = lower.indexOf(term);
        if (idx >= 0) {
            return idx;
        }
    }
    return -1;
}

function buildSnippet(content: string, matchedTerms: string[], rawQuery: string = ''): string {
    if (!content) {
        return '';
    }
    const maxLen = 140;
    const hitIdx = findFirstTermOffset(content, matchedTerms, rawQuery);

    if (hitIdx < 0 || content.length <= maxLen) {
        return content.slice(0, maxLen).replace(/\s+/g, ' ').trim();
    }

    const start = Math.max(0, hitIdx - 40);
    const end = Math.min(content.length, start + maxLen);
    const slice = content.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '...' : ''}${slice}${end < content.length ? '...' : ''}`;
}

const MAX_VFS_READ_TRANSFORM_CACHE = 256;

function stringifyMacroVar(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
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
 * - `/side/*` (`rw`, `side-files` branch-safe off-mainline clues: `comms/*`, `rumors/*`, `notes/*`)
 * - `/docs/*` (`ro`, built-in ST-Agentic & SillyTavern reference docs)
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
    private readonly sideMount: SideMount;
    private readonly docsMount: BuiltinDocsMount;
    private readonly namedMounts: Map<string, VfsMount>;

    private readonly defaultTarget?: MessageTarget;
    private readonly defaultStaged?: boolean;
    private readonly readTransformCache = new Map<string, string>();

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
        const templateEvaluator: VfsTemplateEvaluator = (text, evalOpts) =>
            this.evaluateTemplateText(text, evalOpts);
        this.worldInfoMount = new WorldInfoMount(
            this.bridge,
            this.store,
            options.loreReadHook,
            templateEvaluator,
        );
        this.skillsMount = new SkillsMount(this.bridge, templateEvaluator);
        this.presetMount = new PresetMount(options.getPresetFiles ?? (() => ({})));
        this.globalMount = new GlobalMount(this.bridge);
        this.historyMount = new HistoryMount(this.bridge);
        this.sideMount = new SideMount(this.store);
        this.docsMount = new BuiltinDocsMount(options.docsRegistry);

        this.namedMounts = new Map<string, VfsMount>([
            [CHARACTER_MOUNT, this.characterMount],
            [PERSONA_MOUNT, this.personaMount],
            [LOREBOOK_MOUNT, this.worldInfoMount],
            [SKILLS_MOUNT, this.skillsMount],
            [PRESET_MOUNT, this.presetMount],
            [GLOBAL_MOUNT, this.globalMount],
            [HISTORY_MOUNT, this.historyMount],
            [SIDE_MOUNT, this.sideMount],
            [DOCS_MOUNT, this.docsMount],
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
        const merged = this.mergeReadOpts(opts);
        if (!merged.raw && this.shouldEvaluatePlainMount(routed.mount)) {
            const { startLine, endLine, ...fullReadOpts } = merged;
            const rawContent = await routed.mount.readFile(routed.relPath, fullReadOpts);
            const evaluated = await this.evaluateTemplateText(rawContent, {
                ...fullReadOpts,
                path: routed.normalizedPath,
                mount: routed.mount.mountName,
            });
            return sliceLines(evaluated, startLine, endLine);
        }
        return await routed.mount.readFile(routed.relPath, merged);
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
            current = await routed.mount.readFile(routed.relPath, {
                ...this.mergeReadOpts(opts),
                raw: true,
            });
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
        opts?: VfsEditOptions,
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

        if (opts.regex) {
            try {
                new RegExp(query, caseSensitive ? '' : 'i');
            } catch (error) {
                throw new VfsError(`Invalid grep regex: ${(error as Error).message}`, 'EINVAL', prefix);
            }
        }

        const docs = await this.collectScopedSearchDocs(prefix, merged);
        const hits: VfsSearchHit[] = [];

        for (const doc of docs) {
            const remaining = limit - hits.length;
            if (remaining <= 0) {
                break;
            }
            const perFileMax =
                opts.maxMatchesPerFile !== undefined
                    ? Math.min(remaining, Math.max(1, Math.floor(opts.maxMatchesPerFile)))
                    : remaining;
            const fullText = doc.frontmatter ? `${doc.frontmatter}${doc.content}` : doc.content;
            const fileHits = grepLinesInText({
                path: doc.path,
                title: doc.title,
                content: fullText,
                query,
                caseSensitive,
                regex: Boolean(opts.regex),
                contextLines: opts.contextLines,
                maxMatches: perFileMax,
            });
            hits.push(...fileHits);
            if (hits.length >= limit) {
                return hits.slice(0, limit);
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

    /** Enumerate parsed `/side/*` clue documents for a causal branch target or filter options. */
    async listSideClues(targetOrOpts?: MessageTarget | SideClueListOptions): Promise<SideClueDoc[]> {
        const opts: SideClueListOptions = isMessageTargetArg(targetOrOpts)
            ? { target: targetOrOpts }
            : (targetOrOpts ?? {});
        return await this.sideMount.listSideClues(this.mergeReadOpts(opts));
    }

    /** Read and parse a single `/side/*` clue document (or `null` when absent). */
    async readSideClue(
        path: string,
        targetOrOpts?: MessageTarget | VfsTargetOptions,
    ): Promise<SideClueDoc | null> {
        const opts: VfsTargetOptions = isMessageTargetArg(targetOrOpts)
            ? { target: targetOrOpts }
            : (targetOrOpts ?? {});
        return await this.sideMount.readSideClue(path, this.mergeReadOpts(opts));
    }

    /** Canonically serialize and write a `/side/*` clue document into branch-safe storage. */
    async writeSideClue(input: SideClueWriteInput, opts?: VfsWriteOptions): Promise<SideClueDoc> {
        const merged = this.mergeWriteOpts({
            ...opts,
            target: opts?.target ?? input.target,
        });
        return await this.sideMount.writeSideClue(input, merged);
    }

    /** Patch Frontmatter metadata of an existing `/side/*` clue while preserving its Markdown body. */
    async updateSideClueMeta(
        path: string,
        patch: Partial<SideClueMeta>,
        opts?: VfsWriteOptions,
    ): Promise<SideClueDoc | null> {
        return await this.sideMount.updateSideClueMeta(path, patch, this.mergeWriteOpts(opts));
    }

    /** Mark surfaced `next_turn_brief` `/side/*` clues as consumed on the target branch. */
    async markSideCluesConsumed(
        paths: readonly string[],
        turnNumber?: number,
        opts?: VfsWriteOptions,
    ): Promise<SideClueDoc[]> {
        return await this.sideMount.markSideCluesConsumed(paths, turnNumber, this.mergeWriteOpts(opts));
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
        if (normalized.startsWith(`/${STATE_MOUNT}/`)) {
            const relState = normalized.slice(STATE_MOUNT.length + 2);
            if (variablesFileNameToScope(relState) !== null) {
                return {
                    mount: this.variablesMount,
                    relPath: relState,
                    normalizedPath: normalized,
                };
            }
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
            this.sideMount,
            this.docsMount,
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
            // Keep built-in /docs/* out of default root searches so mainline RP queries stay clean.
            return this.allMounts().filter((m) => m !== this.docsMount);
        }
        if (prefix === OUTPUT_FILE_PATH) {
            return [this.outputMount];
        }
        if (VARIABLES_FILE_NAMES.some((name) => prefix === `/${STATE_MOUNT}/${name}`)) {
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

    private shouldEvaluatePlainMount(mount: VfsMount): boolean {
        return (
            mount === this.characterMount
            || mount === this.personaMount
            || mount === this.presetMount
            || mount === this.workspaceMount
            || mount === this.globalMount
        );
    }

    private async evaluateTemplateText(
        rawText: string,
        opts?: VfsReadOptions & { path?: string; mount?: string },
    ): Promise<string> {
        const hasTransformHook = Boolean(this.bridge.transformPromptText || this.bridge.evaluateOptionalEjs);
        if (!rawText) {
            return rawText;
        }
        if (!rawText.includes('{{') && !rawText.includes('<%') && !this.bridge.transformPromptText) {
            return rawText;
        }

        const rawMetaVars = this.bridge.getMetadata()?.variables;
        const metadataVars: Record<string, unknown> =
            rawMetaVars && typeof rawMetaVars === 'object' && !Array.isArray(rawMetaVars)
                ? { ...(rawMetaVars as Record<string, unknown>) }
                : {};

        let messageVars: Record<string, unknown> = {};
        try {
            messageVars = await this.variablesMount.readVariables({
                target: opts?.target,
                staged: opts?.staged,
                scope: 'message',
            });
        } catch {
            messageVars = {};
        }

        const effectiveVars: Record<string, unknown> = {
            ...metadataVars,
            ...messageVars,
        };

        const macroOverrides: Record<string, string> = {};
        for (const [k, v] of Object.entries(effectiveVars)) {
            macroOverrides[`var:${k}`] = stringifyMacroVar(v);
        }

        const workingText = rawText.includes('{{')
            ? this.bridge.substituteMacros(
                rawText,
                Object.keys(macroOverrides).length > 0 ? macroOverrides : undefined,
            )
            : rawText;

        if (!hasTransformHook) {
            return workingText;
        }

        const editable = Boolean(opts?.editable);
        const writable = Boolean(opts?.writable);
        const path = opts?.path ?? '';
        const mount = opts?.mount ?? '';
        const effectiveTarget: MessageTarget | undefined =
            opts?.target
            ?? this.defaultTarget
            ?? (() => {
                const chatList = this.bridge.getChat();
                if (chatList.length === 0) {
                    return undefined;
                }
                const lastIdx = chatList.length - 1;
                return {
                    messageId: lastIdx,
                    swipeId: chatList[lastIdx]?.swipeId ?? 0,
                };
            })();
        const targetKey = effectiveTarget
            ? `${effectiveTarget.messageId}:${effectiveTarget.swipeId}`
            : '';
        const cacheKey = `${path}\x00${mount}\x00${targetKey}\x00${editable ? '1' : '0'}\x00${writable ? '1' : '0'}\x00${workingText}`;
        const cached = this.readTransformCache.get(cacheKey);
        if (cached !== undefined) {
            return cached;
        }

        const result = await runPromptTransform(this.bridge, {
            text: workingText,
            source: 'vfs_read',
            layer: 'tool_read',
            dryRun: false,
            meta: {
                sessionId: opts?.transformSessionId ?? 'vfs_read',
                ...(opts?.transformAgentId ? { agentId: opts.transformAgentId } : {}),
                ...(opts?.transformPhase ? { phase: opts.transformPhase } : {}),
                ...(effectiveTarget ? { target: effectiveTarget } : {}),
                ...(path ? { path } : {}),
                ...(mount ? { mount } : {}),
                editable,
                writable,
                vars: effectiveVars,
            },
            ...(opts?.transformSessionBag ? { sessionBag: opts.transformSessionBag } : {}),
            onError: 'fallback',
        });

        if (result.cacheable && Object.keys(result.cacheKeys).length === 0) {
            if (this.readTransformCache.size >= MAX_VFS_READ_TRANSFORM_CACHE) {
                const oldestKey = this.readTransformCache.keys().next().value;
                if (oldestKey !== undefined) {
                    this.readTransformCache.delete(oldestKey);
                }
            }
            this.readTransformCache.set(cacheKey, result.text);
        }

        return result.text;
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

function isMessageTargetArg(value: unknown): value is MessageTarget {
    return Boolean(
        value
        && typeof value === 'object'
        && 'messageId' in value
        && 'swipeId' in value,
    );
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
