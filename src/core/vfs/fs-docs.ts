import type { ToolEditResult } from '@/core/bridge';
import { type BuiltinDocEntry, defaultDocsRegistry, type DocsRegistry } from '@/core/docs';
import type { VfsEntryStat } from '@/core/types';
import {
    type VfsMount,
    VfsNotFoundError,
    type VfsReadOptions,
    VfsReadOnlyError,
    type VfsSearchDocument,
    sliceLines,
    sortStats,
    utf8ByteLength,
} from './fs-base';

export const DOCS_MOUNT = 'docs';

function docSourceTag(entry: BuiltinDocEntry): string {
    return entry.source === 'extension' && entry.namespace
        ? `extension:${entry.namespace}`
        : 'builtin:docs';
}

/**
 * `/docs/*` (`ro`): built-in ST-Agentic guides and third-party extension docs
 * registered under `/docs/extensions/<namespace>/...`.
 *
 * Excluded from default root (`/`) searches in `VirtualFileSystem.selectMountsForPrefix`
 * so mainline RP agents are not distracted by dev docs unless explicitly reading `/docs/*`.
 */
export class BuiltinDocsMount implements VfsMount {
    public readonly mountName = DOCS_MOUNT;
    public readonly writable = false;

    constructor(private readonly registry: DocsRegistry = defaultDocsRegistry) {}

    async stat(relPath: string): Promise<VfsEntryStat | null> {
        const clean = relPath.replace(/^\/+|\/+$/g, '');
        if (!clean) {
            return {
                path: `/${DOCS_MOUNT}`,
                name: DOCS_MOUNT,
                kind: 'directory',
                size: 0,
                writable: false,
                mount: DOCS_MOUNT,
            };
        }

        const doc = this.registry.getByMountRelPath(clean);
        if (doc) {
            return {
                path: doc.path,
                name: doc.fileName,
                kind: 'file',
                size: utf8ByteLength(doc.content),
                writable: false,
                mount: DOCS_MOUNT,
                source: docSourceTag(doc),
            };
        }

        if (this.registry.hasDirectoryPrefix(clean)) {
            const slashIdx = clean.lastIndexOf('/');
            const dirName = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean;
            return {
                path: `/${DOCS_MOUNT}/${clean}`,
                name: dirName,
                kind: 'directory',
                size: 0,
                writable: false,
                mount: DOCS_MOUNT,
            };
        }

        return null;
    }

    async listDir(relPath: string): Promise<VfsEntryStat[]> {
        const cleanDir = relPath.replace(/^\/+|\/+$/g, '');
        const dirPrefix = cleanDir ? `${cleanDir}/` : '';
        const items = this.registry.listAllMountEntries();

        const entries = new Map<string, VfsEntryStat>();
        for (const { mountRelPath, entry } of items) {
            if (dirPrefix && !mountRelPath.startsWith(dirPrefix)) {
                continue;
            }
            const remainder = dirPrefix ? mountRelPath.slice(dirPrefix.length) : mountRelPath;
            if (!remainder) {
                continue;
            }
            const slashIdx = remainder.indexOf('/');
            if (slashIdx < 0) {
                entries.set(remainder, {
                    path: entry.path,
                    name: remainder,
                    kind: 'file',
                    size: utf8ByteLength(entry.content),
                    writable: false,
                    mount: DOCS_MOUNT,
                    source: docSourceTag(entry),
                });
            } else {
                const subDir = remainder.slice(0, slashIdx);
                if (!entries.has(subDir)) {
                    const subDirPath = cleanDir
                        ? `/${DOCS_MOUNT}/${cleanDir}/${subDir}`
                        : `/${DOCS_MOUNT}/${subDir}`;
                    entries.set(subDir, {
                        path: subDirPath,
                        name: subDir,
                        kind: 'directory',
                        size: 0,
                        writable: false,
                        mount: DOCS_MOUNT,
                    });
                }
            }
        }

        return sortStats(Array.from(entries.values()));
    }

    async readFile(relPath: string, opts: VfsReadOptions = {}): Promise<string> {
        const clean = relPath.replace(/^\/+/, '');
        const doc = this.registry.getByMountRelPath(clean);
        if (!doc) {
            throw new VfsNotFoundError(`/${DOCS_MOUNT}/${clean}`);
        }
        return sliceLines(doc.content, opts.startLine, opts.endLine);
    }

    async writeFile(relPath: string): Promise<void> {
        throw new VfsReadOnlyError(`/${DOCS_MOUNT}/${relPath.replace(/^\/+/, '')}`);
    }

    async editFile(relPath: string): Promise<ToolEditResult> {
        throw new VfsReadOnlyError(`/${DOCS_MOUNT}/${relPath.replace(/^\/+/, '')}`);
    }

    async deleteFile(relPath: string): Promise<boolean> {
        throw new VfsReadOnlyError(`/${DOCS_MOUNT}/${relPath.replace(/^\/+/, '')}`);
    }

    async listFiles(): Promise<VfsEntryStat[]> {
        const stats: VfsEntryStat[] = this.registry.listAllMountEntries().map(({ entry }) => ({
            path: entry.path,
            name: entry.fileName,
            kind: 'file',
            size: utf8ByteLength(entry.content),
            writable: false,
            mount: DOCS_MOUNT,
            source: docSourceTag(entry),
        }));
        return sortStats(stats);
    }

    async collectSearchDocs(): Promise<VfsSearchDocument[]> {
        return this.registry.listAllMountEntries().map(({ entry }) => ({
            path: entry.path,
            title: entry.title,
            content: entry.content,
        }));
    }
}
