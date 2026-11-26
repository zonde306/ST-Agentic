import type { ToolEditOptions, ToolEditResult } from '@/core/bridge';
import type { MessageTarget, VariableScope, VfsEntryStat } from '@/core/types';

export class VfsError extends Error {
    constructor(
        message: string,
        public readonly code:
            | 'ENOENT'
            | 'EROFS'
            | 'EACCES'
            | 'EINVAL'
            | 'EISDIR',
        public readonly path: string,
    ) {
        super(message);
        this.name = 'VfsError';
    }
}

export class VfsNotFoundError extends VfsError {
    constructor(path: string, detail?: string) {
        super(detail ?? `File not found: ${path}`, 'ENOENT', path);
        this.name = 'VfsNotFoundError';
    }
}

export class VfsReadOnlyError extends VfsError {
    constructor(path: string, detail?: string) {
        super(detail ?? `Read-only path cannot be modified: ${path}`, 'EROFS', path);
        this.name = 'VfsReadOnlyError';
    }
}

export class VfsPermissionError extends VfsError {
    constructor(path: string, detail: string) {
        super(detail, 'EACCES', path);
        this.name = 'VfsPermissionError';
    }
}

export class VfsInvalidPathError extends VfsError {
    constructor(path: string, detail?: string) {
        super(detail ?? `Invalid VFS path: ${path}`, 'EINVAL', path);
        this.name = 'VfsInvalidPathError';
    }
}

export interface VfsTargetOptions {
    target?: MessageTarget;
    staged?: boolean;
    scope?: VariableScope;
}

export type VfsTemplateEvaluator = (
    text: string,
    opts?: VfsTargetOptions,
) => Promise<string>;

export interface VfsReadOptions extends VfsTargetOptions {
    startLine?: number;
    endLine?: number;
    /**
     * When `true`, return raw stored text without macro (`{{...}}`) or
     * optional EJS (`<% ... %>`) evaluation (and bypass `LoreReadHook` on `/lorebooks/*`).
     */
    raw?: boolean;
}

export interface VfsWriteOptions extends VfsTargetOptions {
    source?: string;
    layerMode?: 'auto' | 'base' | 'branch';
}

export interface VfsEditOptions extends VfsWriteOptions, ToolEditOptions {}

export interface VfsSearchDocument {
    path: string;
    title: string;
    content: string;
    frontmatter?: string;
    contentLineOffset?: number;
    keys?: string;
    keysecondary?: string;
    world?: string;
    uid?: string;
}

export interface VfsMount {
    readonly mountName: string;
    readonly writable: boolean;
    stat(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat | null>;
    listDir(relPath: string, opts?: VfsTargetOptions): Promise<VfsEntryStat[]>;
    readFile(relPath: string, opts?: VfsReadOptions): Promise<string>;
    writeFile(relPath: string, content: string, opts?: VfsWriteOptions): Promise<void>;
    appendFile?(relPath: string, content: string, opts?: VfsWriteOptions): Promise<void>;
    editFile(
        relPath: string,
        oldText: string,
        newText: string,
        opts?: VfsEditOptions,
    ): Promise<ToolEditResult>;
    deleteFile(relPath: string, opts?: VfsWriteOptions): Promise<boolean>;
    listFiles(opts?: VfsTargetOptions): Promise<VfsEntryStat[]>;
    collectSearchDocs(opts?: VfsTargetOptions): Promise<VfsSearchDocument[]>;
}

const textEncoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
    return textEncoder.encode(text).length;
}

/** Extract a 1-based inclusive line range from `content`. */
export function sliceLines(content: string, startLine?: number, endLine?: number): string {
    if (startLine === undefined && endLine === undefined) {
        return content;
    }
    const lines = content.split('\n');
    const start = startLine !== undefined ? Math.max(0, startLine - 1) : 0;
    const end = endLine !== undefined ? Math.max(start, endLine) : lines.length;
    return lines.slice(start, end).join('\n');
}

/** Keep file name segments free of path separators and leading dots. */
export function sanitizeFileName(name: string): string {
    const cleaned = name
        .replace(/[/\\%#?]+/g, '-')
        .replace(/^\.+/, '')
        .trim();
    return cleaned || 'untitled';
}

export function basenameOf(vfsPath: string): string {
    if (vfsPath === '/') {
        return '/';
    }
    const idx = vfsPath.lastIndexOf('/');
    return idx >= 0 ? vfsPath.slice(idx + 1) : vfsPath;
}

export function sortStats(stats: VfsEntryStat[]): VfsEntryStat[] {
    return [...stats].sort((a, b) => {
        if (a.kind !== b.kind) {
            return a.kind === 'directory' ? -1 : 1;
        }
        if (a.name < b.name) {
            return -1;
        }
        if (a.name > b.name) {
            return 1;
        }
        return 0;
    });
}
