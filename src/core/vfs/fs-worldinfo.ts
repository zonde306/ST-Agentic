import yaml from 'yaml';
import type { HostBridge, ToolEditResult } from '@/core/bridge';
import {
    DecoratorParser,
    KNOWN_DECORATORS,
    isEjsEntryEnabled,
    isEjsForceDisabledEntry,
    isEjsSpecialEntry,
} from '@/core/lore/decorators';
import { ChatDataStore, DATA_NAMESPACES, worldInfoKey } from '@/core/store';
import type { LoreReadHook, RawLoreEntry, VfsEntryStat } from '@/core/types';
import {
    VfsError,
    type VfsEditOptions,
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    VfsReadOnlyError,
    type VfsSearchDocument,
    type VfsTargetOptions,
    type VfsTemplateEvaluator,
    type VfsWriteOptions,
    sanitizeFileName,
    sliceLines,
    sortStats,
    utf8ByteLength,
} from './fs-base';
import { applyTextEdits, countLines, resolveEditOperations } from './text-ops';

export const LOREBOOK_MOUNT = 'lorebooks';
export const SKILLS_MOUNT = 'skills';

const FRONTMATTER_FENCE = '---';
const UNSAFE_SEGMENT = /[%#?\\]/g;

const NON_LORE_MOUNT_DECORATORS = new Set([
    '@@skill',
    '@@tool',
    '@@script',
    '@@agent',
    '@@trigger',
    '@@system',
    '@@json_schema',
    '@@zod_schema',
    '@@variables_json',
    '@@variables_json_before',
    '@@variables_yaml',
    '@@variables_yaml_before',
    '@@variables_jsonpatch',
    '@@variables_jsonpatch_before',
    '@@append_output',
    '@@append_output_before',
    '@@append_output_ejs',
    '@@append_output_ejs_before',
    '@@replace_output',
    '@@replace_output_before',
    '@@replace_output_ejs',
    '@@replace_output_ejs_before',
    '@@evaluate_ejs',
    '@@evaluate_ejs_before',
    '@@replace_ejs',
    '@@replace_ejs_before',
]);

const KNOWN_LORE_DECORATORS = new Set<string>([
    ...KNOWN_DECORATORS,
    ...NON_LORE_MOUNT_DECORATORS,
    '@@replace',
    '@@replace_before',
    '@@replace_diff',
    '@@replace_diff_before',
    '@@replace_search',
    '@@replace_search_before',
    '@@batch_order',
    '@@preset',
    '@@json_schema',
    '@@zod_schema',
    '@@group',
]);

/** Percent-encode segment characters (`%`, `#`, `?`, `\`) that confuse path parsing. */
export function encodeSegment(name: string): string {
    return name.replace(
        UNSAFE_SEGMENT,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    );
}

/** Decode percent-encoded segment characters. */
export function decodeSegment(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/** Cosmetic file name part; `-<uid>.md` is the authoritative entry ID. */
export function slugify(comment: string): string {
    const slug = (comment ?? '')
        .trim()
        .replace(/[\s/\\]+/g, '-')
        .replace(/[^\p{L}\p{N}_.-]+/gu, '')
        .replace(/^[.-]+/, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 60)
        .replace(/-+$/, '');

    return slug || 'entry';
}

export function entryFileName(entry: Pick<RawLoreEntry, 'comment' | 'uid'>): string {
    return `${slugify(entry.comment)}-${entry.uid}.md`;
}

/** Escape leading `@@` lines so model-written overrides cannot escalate to decorators. */
export function escapeAt(content: string): string {
    return mapLeadingRun(content, /^@@/, (line) => `@${line}`);
}

/** Undo {@link escapeAt} when reading back model-written overrides. */
export function unescapeAt(content: string): string {
    return mapLeadingRun(content, /^@@@/, (line) => line.slice(1));
}

function mapLeadingRun(content: string, test: RegExp, fn: (line: string) => string): string {
    if (!content || !test.test(content)) {
        return content;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; ++i) {
        if (!test.test(lines[i])) {
            break;
        }
        lines[i] = fn(lines[i]);
    }
    return lines.join('\n');
}

/** Strip leading `@@` decorator lines from raw lorebook content. */
export function stripLeadingDecorators(
    rawContent: string,
    preparsedDecorators?: string[],
): { decorators: string[]; cleanContent: string } {
    if (preparsedDecorators && preparsedDecorators.length > 0 && !rawContent.startsWith('@@')) {
        return { decorators: [...preparsedDecorators], cleanContent: rawContent };
    }

    if (!rawContent.startsWith('@@')) {
        return { decorators: preparsedDecorators ? [...preparsedDecorators] : [], cleanContent: rawContent };
    }

    const decorators: string[] = [];
    let lineStart = 0;
    let fallbacked = false;

    while (lineStart < rawContent.length) {
        if (!rawContent.startsWith('@@', lineStart)) {
            break;
        }

        let lineEnd = rawContent.indexOf('\n', lineStart);
        if (lineEnd === -1) {
            lineEnd = rawContent.length;
        }

        let line = rawContent.substring(lineStart, lineEnd);
        if (line.endsWith('\r')) {
            line = line.slice(0, -1);
        }

        const isEscaped = line.startsWith('@@@');
        if (isEscaped && !fallbacked) {
            break;
        }

        const candidate = isEscaped ? line.substring(1) : line;
        const spaceIdx = candidate.indexOf(' ');
        const base = spaceIdx !== -1 ? candidate.substring(0, spaceIdx) : candidate;

        if (KNOWN_LORE_DECORATORS.has(base)) {
            decorators.push(candidate);
            fallbacked = false;
        } else {
            fallbacked = true;
        }

        if (lineEnd === rawContent.length) {
            lineStart = rawContent.length;
            break;
        }
        lineStart = lineEnd + 1;
    }

    return {
        decorators: preparsedDecorators?.length ? [...preparsedDecorators] : decorators,
        cleanContent: rawContent.slice(lineStart),
    };
}

function getEntryDecorators(entry: RawLoreEntry): string[] {
    return stripLeadingDecorators(entry.content ?? '', entry.decorators).decorators;
}

function getDecoratorBase(decoratorLine: string): string {
    const trimmed = decoratorLine.trim();
    const spaceIdx = trimmed.indexOf(' ');
    return spaceIdx !== -1 ? trimmed.slice(0, spaceIdx) : trimmed;
}

export function isInitVarEntry(
    entry: RawLoreEntry,
    options?: { invertEnabled?: boolean },
): boolean {
    const parsed = DecoratorParser.parseEntry(entry);
    const hasInitialVarDecorator = parsed.decorators.some((d) => d.name === '@@initial_variables');
    const hasInitVarComment = /\[(?:initvar|initialvariables)\]/i.test(entry.comment ?? '');
    const hasInitVarBody = /^\s*\[(?:initvar|initialvariables)\]/i.test(parsed.cleanContent);

    if (!hasInitialVarDecorator && !hasInitVarComment && !hasInitVarBody) {
        return false;
    }

    return isEjsEntryEnabled(entry, parsed.decorators, options);
}

/** Parse and merge all enabled `[InitVar]` / `[InitialVariables]` / `@@initial_variables` lorebook entries in ascending `order`. */
export function parseInitVarEntries(
    books: Map<string, RawLoreEntry[]>,
    options?: { invertEnabled?: boolean },
): Record<string, unknown> {
    const candidates: RawLoreEntry[] = [];
    for (const entries of books.values()) {
        for (const entry of entries) {
            if (isInitVarEntry(entry, options)) {
                candidates.push(entry);
            }
        }
    }

    candidates.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const merged: Record<string, unknown> = {};
    for (const entry of candidates) {
        const { cleanContent } = stripLeadingDecorators(entry.content ?? '', entry.decorators);
        const body = stripInitVarFence(cleanContent);
        if (!body) {
            continue;
        }
        const parsed = parseObjectPayload(body);
        if (parsed) {
            Object.assign(merged, parsed);
        }
    }

    return merged;
}

function stripInitVarFence(text: string): string {
    let body = text.replace(/^\s*\[(?:initvar|initialvariables)\]\s*/i, '').trim();
    const fenceMatch = /^```(?:json|yaml|yml)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(body);
    if (fenceMatch) {
        body = fenceMatch[1].trim();
    }
    return body;
}

function parseObjectPayload(body: string): Record<string, unknown> | null {
    try {
        const jsonVal = JSON.parse(body) as unknown;
        if (jsonVal && typeof jsonVal === 'object' && !Array.isArray(jsonVal)) {
            return jsonVal as Record<string, unknown>;
        }
    } catch {
        // Fall through to YAML parser
    }

    try {
        const yamlVal = yaml.parse(body) as unknown;
        if (yamlVal && typeof yamlVal === 'object' && !Array.isArray(yamlVal)) {
            return yamlVal as Record<string, unknown>;
        }
    } catch {
        // Ignore unparseable InitVar payload
    }

    return null;
}

export function isSkillEntry(entry: RawLoreEntry): boolean {
    if (entry.disable) {
        return false;
    }
    return getEntryDecorators(entry).some((d) => getDecoratorBase(d) === '@@skill');
}

export function extractSkillInfo(
    entry: RawLoreEntry,
): { name: string; description: string; body: string } | null {
    if (!isSkillEntry(entry)) {
        return null;
    }
    const { decorators, cleanContent } = stripLeadingDecorators(entry.content ?? '', entry.decorators);
    const skillDecorator = decorators.find((d) => getDecoratorBase(d) === '@@skill') ?? '';
    const argName = skillDecorator.slice('@@skill'.length).trim();
    const name = (argName || entry.comment || `skill-${entry.uid}`).trim();
    if (!name) {
        return null;
    }

    const lines = cleanContent.trim().split('\n');
    const description = (lines[0] ?? '').trim();
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : '';

    return { name, description, body };
}

export function isLorebookMountableEntry(entry: RawLoreEntry): boolean {
    if (entry.disable) {
        return false;
    }
    if (isInitVarEntry(entry)) {
        return false;
    }
    const parsed = DecoratorParser.parseEntry(entry);
    if (isEjsForceDisabledEntry(parsed.decorators) || isEjsSpecialEntry(entry, parsed.decorators)) {
        return false;
    }
    const decorators = getEntryDecorators(entry);
    for (const dec of decorators) {
        if (NON_LORE_MOUNT_DECORATORS.has(getDecoratorBase(dec))) {
            return false;
        }
    }
    return true;
}

/** Build YAML frontmatter + body for a World Info entry. */
export function withFrontmatter(entry: RawLoreEntry, body: string): string {
    const meta = yaml.stringify({
        world: entry.world,
        uid: entry.uid,
        comment: entry.comment ?? '',
        keys: entry.keys ?? [],
        keysecondary: entry.keysecondary ?? [],
        constant: Boolean(entry.constant),
        position: entry.position ?? 0,
        depth: entry.depth ?? 0,
        order: entry.order ?? 0,
        probability: entry.probability ?? 100,
        group: entry.group ?? '',
        role: entry.role ?? 0,
    });

    return `${FRONTMATTER_FENCE}\n${meta}${FRONTMATTER_FENCE}\n\n${body}`;
}

/** Strip YAML frontmatter when writing an override, enforcing immutable `world` and `uid`. */
export function stripFrontmatter(content: string, entry: RawLoreEntry): string {
    if (!content.startsWith(`${FRONTMATTER_FENCE}\n`)) {
        return content;
    }

    const end = content.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
    if (end < 0) {
        return content;
    }

    const header = content.slice(FRONTMATTER_FENCE.length + 1, end + 1);
    const rest = content.slice(end + FRONTMATTER_FENCE.length + 1).replace(/^\r?\n/, '');

    let parsed: Record<string, unknown> = {};
    try {
        const result = yaml.parse(header) as unknown;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            parsed = result as Record<string, unknown>;
        }
    } catch (error) {
        throw new VfsError(
            `Invalid frontmatter: ${(error as Error).message}`,
            'EINVAL',
            `/${LOREBOOK_MOUNT}/${encodeSegment(entry.world)}/${encodeSegment(entryFileName(entry))}`,
        );
    }

    if (parsed.world != null && String(parsed.world) !== String(entry.world)) {
        throw new VfsError(
            `Frontmatter "world" (${String(parsed.world)}) does not match "${entry.world}". Metadata is read-only.`,
            'EINVAL',
            `/${LOREBOOK_MOUNT}/${encodeSegment(entry.world)}/${encodeSegment(entryFileName(entry))}`,
        );
    }

    if (parsed.uid != null && String(parsed.uid) !== String(entry.uid)) {
        throw new VfsError(
            `Frontmatter "uid" (${String(parsed.uid)}) does not match "${String(entry.uid)}". Metadata is read-only.`,
            'EINVAL',
            `/${LOREBOOK_MOUNT}/${encodeSegment(entry.world)}/${encodeSegment(entryFileName(entry))}`,
        );
    }

    return rest;
}

interface ResolvedLorePath {
    book: string;
    entries: RawLoreEntry[];
    rest: string;
}

/**
 * `/lorebooks/<book>/<slug>-<uid>.md`
 *
 * Base lorebooks are read-only; writes create causal overrides in the `worldinfo`
 * namespace of `ChatDataStore`. Deleting a file removes/tombstones the override
 * and restores the base book text. Reading invokes an optional `LoreReadHook`.
 */
export class WorldInfoMount implements VfsMount {
    public readonly mountName = LOREBOOK_MOUNT;
    public readonly writable = true;
    private loreReadHook?: LoreReadHook;

    constructor(
        private readonly bridge: HostBridge,
        private readonly store: ChatDataStore,
        loreReadHook?: LoreReadHook,
        private readonly defaultTemplateEvaluator?: VfsTemplateEvaluator,
    ) {
        this.loreReadHook = loreReadHook;
    }

    setLoreReadHook(hook?: LoreReadHook): void {
        this.loreReadHook = hook;
    }

    async stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${LOREBOOK_MOUNT}`,
                name: LOREBOOK_MOUNT,
                kind: 'directory',
                size: 0,
                writable: true,
                mount: LOREBOOK_MOUNT,
            };
        }

        const resolved = await this.resolveBook(relPath);
        if (!resolved) {
            return null;
        }

        if (!resolved.rest) {
            return {
                path: `/${LOREBOOK_MOUNT}/${encodeSegment(resolved.book)}`,
                name: encodeSegment(resolved.book),
                kind: 'directory',
                size: 0,
                writable: true,
                mount: LOREBOOK_MOUNT,
            };
        }

        if (resolved.rest.includes('/')) {
            return null;
        }

        const entry = this.findEntry(resolved.entries.filter(isLorebookMountableEntry), resolved.rest);
        if (!entry) {
            return null;
        }

        return this.buildEntryStat(resolved.book, entry, opts);
    }

    async listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const books = await this.loadBooks();
        if (!relPath) {
            const dirs: VfsEntryStat[] = [];
            for (const book of books.keys()) {
                if (book === '.' || book === '..') {
                    continue;
                }
                const encoded = encodeSegment(book);
                dirs.push({
                    path: `/${LOREBOOK_MOUNT}/${encoded}`,
                    name: encoded,
                    kind: 'directory',
                    size: 0,
                    writable: true,
                    mount: LOREBOOK_MOUNT,
                });
            }
            return sortStats(dirs);
        }

        const resolved = await this.resolveBook(relPath);
        if (!resolved || resolved.rest) {
            return [];
        }

        const mountable = resolved.entries.filter(isLorebookMountableEntry);
        return sortStats(mountable.map((entry) => this.buildEntryStat(resolved.book, entry, opts)));
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const fullPath = `/${LOREBOOK_MOUNT}/${relPath}`;
        const resolved = await this.resolveEntry(relPath);
        if (!resolved) {
            throw new VfsNotFoundError(fullPath);
        }

        const { book, entry } = resolved;
        const normalizedEntry: RawLoreEntry = entry.world ? entry : { ...entry, world: book };
        const rawContent = unescapeAt(
            stripLeadingDecorators(normalizedEntry.content ?? '', normalizedEntry.decorators).cleanContent,
        );

        const override = this.readOverrideEntry(normalizedEntry, opts);
        const overriddenContent = override ? unescapeAt(override.content) : undefined;
        const canonicalPath = this.entryPath(book, normalizedEntry);

        let body: string;
        if (opts.raw) {
            body = overriddenContent ?? rawContent;
        } else if (this.loreReadHook) {
            body = await this.loreReadHook({
                world: normalizedEntry.world,
                uid: normalizedEntry.uid,
                path: canonicalPath,
                target: opts.target,
                rawContent,
                overriddenContent,
            });
        } else if (this.defaultTemplateEvaluator) {
            body = await this.defaultTemplateEvaluator(overriddenContent ?? rawContent, opts);
        } else {
            body = overriddenContent ?? rawContent;
        }

        const fullDoc = withFrontmatter(normalizedEntry, body);
        return sliceLines(fullDoc, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string, content: string, opts: VfsWriteOptions = {}): Promise<void> {
        const fullPath = `/${LOREBOOK_MOUNT}/${relPath}`;
        const resolved = await this.resolveEntry(relPath);
        if (!resolved) {
            throw new VfsReadOnlyError(
                fullPath,
                `Cannot create new lorebook entry at "${fullPath}": base lorebooks are read-only; only existing entries can be overridden.`,
            );
        }

        const { book, entry } = resolved;
        const normalizedEntry: RawLoreEntry = entry.world ? entry : { ...entry, world: book };
        const body = escapeAt(stripFrontmatter(content, normalizedEntry));
        this.store.set(
            DATA_NAMESPACES.WORLDINFO,
            worldInfoKey(normalizedEntry.world, normalizedEntry.uid),
            opts.source ?? 'vfs',
            body,
            { target: opts.target, staged: opts.staged },
        );
    }

    async editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts: VfsEditOptions = {},
    ): Promise<ToolEditResult> {
        const fullPath = `/${LOREBOOK_MOUNT}/${relPath}`;
        const resolved = await this.resolveEntry(relPath);
        if (!resolved) {
            return {
                ok: false,
                code: 'ENOENT',
                path: fullPath,
                message: `Lorebook entry not found: ${fullPath}`,
            };
        }

        const { book, entry } = resolved;
        const normalizedEntry: RawLoreEntry = entry.world ? entry : { ...entry, world: book };
        const canonicalPath = this.entryPath(book, normalizedEntry);
        const currentBody = this.currentStoredBody(normalizedEntry, opts);
        const frontmatter = withFrontmatter(normalizedEntry, '');
        const lineOffset = frontmatter.split('\n').length - 1;
        const ops = resolveEditOperations(oldText, newText, opts);
        const applied = applyTextEdits({
            path: canonicalPath,
            content: currentBody,
            edits: ops,
            lineOffset,
            readonlyHeaderLabel: 'YAML frontmatter',
        });

        if (!applied.ok || applied.updatedContent === undefined) {
            return applied;
        }

        const updatedBody = applied.updatedContent;
        this.store.set(
            DATA_NAMESPACES.WORLDINFO,
            worldInfoKey(normalizedEntry.world, normalizedEntry.uid),
            opts.source ?? 'vfs',
            escapeAt(updatedBody),
            { target: opts.target, staged: opts.staged },
        );

        const finalDoc = withFrontmatter(normalizedEntry, updatedBody);
        return {
            ok: true,
            path: canonicalPath,
            message: `Updated override for ${canonicalPath}`,
            replacements: applied.replacements,
            changedRanges: applied.changedRanges,
            totalLines: countLines(finalDoc),
            bytes: utf8ByteLength(finalDoc),
        };
    }

    async deleteFile(relPath: string, opts: VfsWriteOptions = {}): Promise<boolean> {
        const resolved = await this.resolveEntry(relPath);
        if (!resolved) {
            return false;
        }

        const { book, entry } = resolved;
        const world = entry.world || book;
        return this.store.erase(
            DATA_NAMESPACES.WORLDINFO,
            worldInfoKey(world, entry.uid),
            opts.source ?? 'vfs-delete',
            { target: opts.target, staged: opts.staged },
        );
    }

    async listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]> {
        const books = await this.loadBooks();
        const stats: VfsEntryStat[] = [];
        for (const [book, entries] of books.entries()) {
            if (book === '.' || book === '..') {
                continue;
            }
            for (const entry of entries) {
                if (!isLorebookMountableEntry(entry)) {
                    continue;
                }
                stats.push(this.buildEntryStat(book, entry, opts));
            }
        }
        return sortStats(stats);
    }

    async collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]> {
        const books = await this.loadBooks();
        const docs: VfsSearchDocument[] = [];
        for (const [book, entries] of books.entries()) {
            if (book === '.' || book === '..') {
                continue;
            }
            for (const entry of entries) {
                if (!isLorebookMountableEntry(entry)) {
                    continue;
                }
                const normalizedEntry: RawLoreEntry = entry.world ? entry : { ...entry, world: book };
                const body = this.currentStoredBody(normalizedEntry, opts);
                const frontmatter = withFrontmatter(normalizedEntry, '');
                const contentLineOffset = frontmatter.split('\n').length - 1;
                docs.push({
                    path: this.entryPath(book, normalizedEntry),
                    title: normalizedEntry.comment || entryFileName(normalizedEntry),
                    content: body,
                    frontmatter,
                    contentLineOffset,
                    keys: (normalizedEntry.keys ?? []).join(' '),
                    keysecondary: (normalizedEntry.keysecondary ?? []).join(' '),
                    world: book,
                    uid: String(normalizedEntry.uid),
                });
            }
        }
        return docs;
    }

    private async loadBooks(): Promise<Map<string, RawLoreEntry[]>> {
        return await this.bridge.listEnabledLorebooks();
    }

    private async resolveBook(relPath: string): Promise<ResolvedLorePath | null> {
        const books = await this.loadBooks();
        const rawSegments = relPath.split('/').filter(Boolean);
        if (rawSegments.length === 0) {
            return null;
        }

        const decodedSegments = rawSegments.map(decodeSegment);

        for (let take = rawSegments.length; take > 0; --take) {
            const candidateRaw = rawSegments.slice(0, take).join('/');
            const candidateDecoded = decodedSegments.slice(0, take).join('/');
            const entries = books.get(candidateDecoded) ?? books.get(candidateRaw);
            if (entries) {
                const bookName = books.has(candidateDecoded) ? candidateDecoded : candidateRaw;
                return {
                    book: bookName,
                    entries,
                    rest: rawSegments.slice(take).join('/'),
                };
            }
        }

        return null;
    }

    private findEntry(entries: RawLoreEntry[], fileName: string): RawLoreEntry | null {
        const decoded = decodeSegment(fileName);
        const name = decoded.replace(/\.md$/i, '');
        const uidMatch = /-(\d+)$/.exec(name);

        if (uidMatch) {
            const uid = Number(uidMatch[1]);
            const byUid = entries.find((entry) => entry.uid === uid);
            if (byUid) {
                return byUid;
            }
        }

        return entries.find((entry) => entry.comment === name || slugify(entry.comment) === name) ?? null;
    }

    private async resolveEntry(relPath: string): Promise<{ book: string; entry: RawLoreEntry } | null> {
        const resolved = await this.resolveBook(relPath);
        if (!resolved || !resolved.rest || resolved.rest.includes('/')) {
            return null;
        }

        const entry = this.findEntry(resolved.entries.filter(isLorebookMountableEntry), resolved.rest);
        if (!entry) {
            return null;
        }

        return { book: resolved.book, entry };
    }

    private readOverrideEntry(entry: RawLoreEntry, opts?: VfsTargetOptions) {
        const key = worldInfoKey(entry.world, entry.uid);
        if (opts?.staged === false) {
            return this.store.get(DATA_NAMESPACES.WORLDINFO, key, { target: opts.target });
        }
        return this.store.getPending(DATA_NAMESPACES.WORLDINFO, key, { target: opts?.target });
    }

    private currentStoredBody(entry: RawLoreEntry, opts?: VfsTargetOptions): string {
        const raw = unescapeAt(
            stripLeadingDecorators(entry.content ?? '', entry.decorators).cleanContent,
        );
        const override = this.readOverrideEntry(entry, opts);
        return override ? unescapeAt(override.content) : raw;
    }

    private entryPath(book: string, entry: RawLoreEntry): string {
        return `/${LOREBOOK_MOUNT}/${encodeSegment(book)}/${encodeSegment(entryFileName(entry))}`;
    }

    private buildEntryStat(book: string, entry: RawLoreEntry, opts?: VfsTargetOptions): VfsEntryStat {
        const normalizedEntry: RawLoreEntry = entry.world ? entry : { ...entry, world: book };
        const override = this.readOverrideEntry(normalizedEntry, opts);
        const body = override
            ? unescapeAt(override.content)
            : unescapeAt(stripLeadingDecorators(normalizedEntry.content ?? '', normalizedEntry.decorators).cleanContent);
        const doc = withFrontmatter(normalizedEntry, body);
        const fileName = encodeSegment(entryFileName(normalizedEntry));

        return {
            path: this.entryPath(book, normalizedEntry),
            name: fileName,
            kind: 'file',
            size: utf8ByteLength(doc),
            writable: true,
            mount: LOREBOOK_MOUNT,
            source: override ? override.source : `lorebook:${book}`,
            overridden: Boolean(override),
        };
    }
}

/**
 * `/skills/<name>.md` — read-only view of enabled `@@skill` World Info entries.
 */
export class SkillsMount implements VfsMount {
    public readonly mountName = SKILLS_MOUNT;
    public readonly writable = false;

    constructor(
        private readonly bridge: HostBridge,
        private readonly templateEvaluator?: VfsTemplateEvaluator,
    ) {}

    async stat(relPath: string): Promise<VfsEntryStat | null> {
        if (!relPath) {
            return {
                path: `/${SKILLS_MOUNT}`,
                name: SKILLS_MOUNT,
                kind: 'directory',
                size: 0,
                writable: false,
                mount: SKILLS_MOUNT,
            };
        }

        const snapshot = await this.snapshot();
        const content = snapshot.get(relPath);
        if (content === undefined) {
            return null;
        }

        return {
            path: `/${SKILLS_MOUNT}/${relPath}`,
            name: relPath,
            kind: 'file',
            size: utf8ByteLength(content),
            writable: false,
            mount: SKILLS_MOUNT,
            source: 'worldinfo:skill',
        };
    }

    async listDir(relPath: string): Promise<VfsEntryStat[]> {
        if (relPath) {
            return [];
        }
        return await this.listFiles();
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const entries = await this.snapshotEntries();
        const entry = entries.get(relPath);
        if (!entry) {
            throw new VfsNotFoundError(`/${SKILLS_MOUNT}/${relPath}`);
        }
        let body = entry.body;
        if (!opts.raw && this.templateEvaluator) {
            body = await this.templateEvaluator(body, opts);
        }
        return sliceLines(`${entry.frontmatter}\n\n${body}`, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string): Promise<void> {
        throw new VfsReadOnlyError(`/${SKILLS_MOUNT}/${relPath}`);
    }

    async editFile(relPath: string): Promise<ToolEditResult> {
        throw new VfsReadOnlyError(`/${SKILLS_MOUNT}/${relPath}`);
    }

    async deleteFile(relPath: string): Promise<boolean> {
        throw new VfsReadOnlyError(`/${SKILLS_MOUNT}/${relPath}`);
    }

    async listFiles(): Promise<VfsEntryStat[]> {
        const snapshot = await this.snapshot();
        const stats: VfsEntryStat[] = [];
        for (const [name, content] of snapshot.entries()) {
            stats.push({
                path: `/${SKILLS_MOUNT}/${name}`,
                name,
                kind: 'file',
                size: utf8ByteLength(content),
                writable: false,
                mount: SKILLS_MOUNT,
                source: 'worldinfo:skill',
            });
        }
        return sortStats(stats);
    }

    async collectSearchDocs(): Promise<VfsSearchDocument[]> {
        const snapshot = await this.snapshot();
        const docs: VfsSearchDocument[] = [];
        for (const [name, content] of snapshot.entries()) {
            docs.push({
                path: `/${SKILLS_MOUNT}/${name}`,
                title: name.replace(/\.md$/i, ''),
                content,
            });
        }
        return docs;
    }

    private async snapshotEntries(): Promise<Map<string, { frontmatter: string; body: string }>> {
        const books = await this.bridge.listEnabledLorebooks();
        const files = new Map<string, { frontmatter: string; body: string }>();

        for (const entries of books.values()) {
            for (const entry of entries) {
                const info = extractSkillInfo(entry);
                if (!info) {
                    continue;
                }
                const fileName = `${sanitizeFileName(info.name)}.md`;
                const frontmatter = [
                    '---',
                    `skill: ${info.name}`,
                    `activation: call add_skill("${info.name}") to keep this skill in context`,
                    '---',
                ].join('\n');
                const body = info.body
                    ? `${info.description}\n\n${info.body}`
                    : info.description;
                files.set(fileName, { frontmatter, body });
            }
        }

        return files;
    }

    private async snapshot(): Promise<Map<string, string>> {
        const entries = await this.snapshotEntries();
        const files = new Map<string, string>();
        for (const [fileName, entry] of entries.entries()) {
            files.set(fileName, `${entry.frontmatter}\n\n${entry.body}`);
        }
        return files;
    }
}
