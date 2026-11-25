import type { BuiltinDocEntry } from './builtin';

export const EXTERNAL_DOCS_ROOT_DIR = 'extensions';

const NAMESPACE_PATTERN = /^[a-zA-Z0-9._-]+$/;

export interface ExternalDocItem {
    /** Relative path under `/docs/extensions/<namespace>/`, e.g. `'guide.md'` or `'api/hooks.md'`. */
    path: string;
    /** Markdown content string or lazy zero-arg provider returning Markdown text. */
    content: string | (() => string);
    /** Optional display title (defaults to filename stem). */
    title?: string;
    /** Optional 1-line summary shown in the Assistant system prompt index. */
    summary?: string;
    /** Whether to list this doc in the Assistant system prompt index (default: `true`). */
    includeInAssistantIndex?: boolean;
}

export type ExternalDocRegistration =
    | ({ namespace: string } & ExternalDocItem)
    | { namespace: string; docs: readonly ExternalDocItem[] };

export interface AgenticDocsPublicApi {
    register(
        input: ExternalDocRegistration | readonly ExternalDocRegistration[],
    ): () => void;
    unregister(namespace: string, relPath: string): boolean;
    unregisterNamespace(namespace: string): number;
    list(namespace?: string): BuiltinDocEntry[];
    get(pathOrFileName: string): BuiltinDocEntry | undefined;
}

interface StoredExternalDoc {
    mountRelPath: string;
    namespace: string;
    relPath: string;
    fileName: string;
    path: string;
    title: string;
    summary: string;
    content: string | (() => string);
    includeInAssistantIndex: boolean;
    token: symbol;
}

/** Validate and normalize an external extension doc namespace (single safe path segment). */
export function normalizeDocNamespace(raw: string): string {
    if (typeof raw !== 'string') {
        throw new Error('Extension doc namespace must be a non-empty string.');
    }
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
        throw new Error(`Invalid extension doc namespace: "${raw}".`);
    }
    if (!NAMESPACE_PATTERN.test(trimmed)) {
        throw new Error(
            `Invalid extension doc namespace "${raw}": only [a-zA-Z0-9._-] characters are allowed.`,
        );
    }
    return trimmed;
}

/** Validate and normalize a relative doc path under `/docs/extensions/<namespace>/`. */
export function normalizeDocRelPath(raw: string): string {
    if (typeof raw !== 'string') {
        throw new Error('Extension doc path must be a non-empty string.');
    }
    if (raw.includes('\0')) {
        throw new Error('Extension doc path cannot contain null bytes.');
    }
    const trimmed = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!trimmed) {
        throw new Error('Extension doc path must be non-empty.');
    }
    const segments = trimmed.split('/');
    for (const seg of segments) {
        if (!seg || seg === '.' || seg === '..') {
            throw new Error(`Invalid extension doc relative path: "${raw}".`);
        }
    }
    return segments.join('/');
}

function defaultTitleFromPath(relPath: string): string {
    const slashIdx = relPath.lastIndexOf('/');
    const base = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : relPath;
    return base.replace(/\.md$/i, '') || base;
}

function buildMountRelPath(namespace: string, relPath: string): string {
    return `${EXTERNAL_DOCS_ROOT_DIR}/${namespace}/${relPath}`;
}

function compareByPath(a: { path: string }, b: { path: string }): number {
    if (a.path < b.path) {
        return -1;
    }
    if (a.path > b.path) {
        return 1;
    }
    return 0;
}

/**
 * Runtime documentation registry backing `/docs/` (built-in guides) and
 * `/docs/extensions/<namespace>/...` (third-party extension guides).
 */
export class DocsRegistry implements AgenticDocsPublicApi {
    private readonly builtinMap: ReadonlyMap<string, BuiltinDocEntry>;
    private readonly externalDocs = new Map<string, StoredExternalDoc>();

    constructor(private readonly builtinDocs: readonly BuiltinDocEntry[] = []) {
        this.builtinMap = new Map(
            builtinDocs.map((doc) => [
                doc.fileName,
                {
                    ...doc,
                    source: 'builtin' as const,
                },
            ]),
        );
    }

    register(
        input: ExternalDocRegistration | readonly ExternalDocRegistration[],
    ): () => void {
        const items = Array.isArray(input)
            ? input
            : [input as ExternalDocRegistration];

        const prepared: StoredExternalDoc[] = [];

        for (const entry of items) {
            if (!entry || typeof entry !== 'object') {
                throw new Error('Extension doc registration entry must be an object.');
            }
            const namespace = normalizeDocNamespace(entry.namespace);
            const docList: readonly ExternalDocItem[] =
                'docs' in entry && Array.isArray(entry.docs)
                    ? entry.docs
                    : [entry as ExternalDocItem];

            for (const item of docList) {
                if (!item || typeof item !== 'object') {
                    throw new Error(`Invalid doc item in namespace "${namespace}".`);
                }
                const relPath = normalizeDocRelPath(item.path);
                if (typeof item.content !== 'string' && typeof item.content !== 'function') {
                    throw new Error(
                        `Doc "${namespace}/${relPath}" requires a string or () => string content.`,
                    );
                }
                const mountRelPath = buildMountRelPath(namespace, relPath);
                const slashIdx = relPath.lastIndexOf('/');
                const fileName = slashIdx >= 0 ? relPath.slice(slashIdx + 1) : relPath;
                const title =
                    typeof item.title === 'string' && item.title.trim()
                        ? item.title.trim()
                        : defaultTitleFromPath(relPath);
                const summary =
                    typeof item.summary === 'string' && item.summary.trim()
                        ? item.summary.trim()
                        : title;

                prepared.push({
                    mountRelPath,
                    namespace,
                    relPath,
                    fileName,
                    path: `/docs/${mountRelPath}`,
                    title,
                    summary,
                    content: item.content,
                    includeInAssistantIndex: item.includeInAssistantIndex !== false,
                    token: Symbol(mountRelPath),
                });
            }
        }

        for (const doc of prepared) {
            this.externalDocs.set(doc.mountRelPath, doc);
        }

        let disposed = false;
        return () => {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const doc of prepared) {
                const current = this.externalDocs.get(doc.mountRelPath);
                if (current && current.token === doc.token) {
                    this.externalDocs.delete(doc.mountRelPath);
                }
            }
        };
    }

    unregister(namespace: string, relPath: string): boolean {
        const ns = normalizeDocNamespace(namespace);
        const cleanRel = normalizeDocRelPath(relPath);
        return this.externalDocs.delete(buildMountRelPath(ns, cleanRel));
    }

    unregisterNamespace(namespace: string): number {
        const ns = normalizeDocNamespace(namespace);
        const prefix = `${EXTERNAL_DOCS_ROOT_DIR}/${ns}/`;
        let removed = 0;
        for (const key of Array.from(this.externalDocs.keys())) {
            if (key.startsWith(prefix)) {
                this.externalDocs.delete(key);
                removed += 1;
            }
        }
        return removed;
    }

    clearExternal(): void {
        this.externalDocs.clear();
    }

    getByMountRelPath(mountRelPath: string): BuiltinDocEntry | undefined {
        const clean = mountRelPath.replace(/^\/+/, '');
        if (!clean) {
            return undefined;
        }
        const builtin = this.builtinMap.get(clean);
        if (builtin) {
            return builtin;
        }
        const ext = this.externalDocs.get(clean);
        return ext ? this.resolveExternal(ext) : undefined;
    }

    hasDirectoryPrefix(mountRelDir: string): boolean {
        const clean = mountRelDir.replace(/^\/+|\/+$/g, '');
        if (!clean) {
            return true;
        }
        const prefix = `${clean}/`;
        for (const key of this.externalDocs.keys()) {
            if (key.startsWith(prefix)) {
                return true;
            }
        }
        return false;
    }

    listAllMountEntries(): Array<{ mountRelPath: string; entry: BuiltinDocEntry }> {
        const out: Array<{ mountRelPath: string; entry: BuiltinDocEntry }> = [];
        for (const doc of this.builtinDocs) {
            out.push({
                mountRelPath: doc.fileName,
                entry: { ...doc, source: 'builtin' },
            });
        }
        for (const ext of this.externalDocs.values()) {
            out.push({
                mountRelPath: ext.mountRelPath,
                entry: this.resolveExternal(ext),
            });
        }
        return out.sort((a, b) => compareByPath(a.entry, b.entry));
    }

    listExternalEntries(namespace?: string): BuiltinDocEntry[] {
        const nsFilter = namespace ? normalizeDocNamespace(namespace) : undefined;
        const out: BuiltinDocEntry[] = [];
        for (const ext of this.externalDocs.values()) {
            if (nsFilter && ext.namespace !== nsFilter) {
                continue;
            }
            out.push(this.resolveExternal(ext));
        }
        return out.sort(compareByPath);
    }

    listExternalIndexEntries(): BuiltinDocEntry[] {
        return this.listExternalEntries().filter(
            (doc) => doc.includeInAssistantIndex !== false,
        );
    }

    list(namespace?: string): BuiltinDocEntry[] {
        if (namespace !== undefined) {
            return this.listExternalEntries(namespace);
        }
        return this.listAllMountEntries().map((item) => item.entry);
    }

    get(pathOrFileName: string): BuiltinDocEntry | undefined {
        if (typeof pathOrFileName !== 'string') {
            return undefined;
        }
        const clean = pathOrFileName.trim().replace(/^\/+/, '').replace(/^docs\//i, '');
        return this.getByMountRelPath(clean);
    }

    private resolveExternal(doc: StoredExternalDoc): BuiltinDocEntry {
        let contentStr: string;
        if (typeof doc.content === 'function') {
            const raw = doc.content();
            contentStr = typeof raw === 'string' ? raw : String(raw ?? '');
        } else {
            contentStr = doc.content;
        }
        return {
            fileName: doc.fileName,
            path: doc.path,
            title: doc.title,
            summary: doc.summary,
            content: contentStr,
            source: 'extension',
            namespace: doc.namespace,
            relPath: doc.relPath,
            includeInAssistantIndex: doc.includeInAssistantIndex,
        };
    }
}
