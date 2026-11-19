import type { ToolEditResult, ToolFsApi } from '@/core/bridge';
import type {
    MessageTarget,
    ScopedPermissions,
    VfsEntryStat,
    VfsSearchHit,
} from '@/core/types';
import { isPathAllowed, matchGlob, normalizeVfsPath } from '@/core/utils';
import {
    VfsInvalidPathError,
    VfsPermissionError,
    type VfsReadOptions,
} from './fs-base';
import type { VirtualFileSystem, VfsGrepOptions, VfsSearchOptions } from './filesystem';

export interface ScopedToolGuardOptions {
    target?: MessageTarget;
    staged?: boolean;
    source?: string;
}

/**
 * Enforces `ScopedPermissions` (`read` and `write` Glob whitelists) over a
 * `VirtualFileSystem` and implements `ToolFsApi` for sandboxed Agent execution.
 *
 * Rejects path traversal (`..`), null bytes, and out-of-scope file/directory access
 * with explicit `VfsPermissionError` / `VfsInvalidPathError` diagnostics.
 */
export class ScopedToolGuard implements ToolFsApi {
    public readonly permissions: ScopedPermissions;

    constructor(
        private readonly vfs: VirtualFileSystem,
        permissions: ScopedPermissions,
        private readonly options: ScopedToolGuardOptions = {},
    ) {
        this.permissions = {
            read: [...(permissions.read ?? [])],
            write: [...(permissions.write ?? [])],
        };
    }

    /** Check whether `targetPath` is permitted for reading (never throws). */
    canRead(targetPath: string): boolean {
        return isPathAllowed(this.permissions.read, targetPath);
    }

    /** Check whether `targetPath` is permitted for writing (never throws). */
    canWrite(targetPath: string): boolean {
        return isPathAllowed(this.permissions.write, targetPath);
    }

    /** Validate path syntax (no `..`) and enforce `permissions.read`. */
    assertCanRead(targetPath: string): string {
        const normalized = safeNormalizePath(targetPath);
        if (!isPathAllowed(this.permissions.read, normalized)) {
            throw new VfsPermissionError(
                normalized,
                `Unauthorized VFS read access to "${normalized}". Allowed read patterns: ${JSON.stringify(this.permissions.read)}.`,
            );
        }
        return normalized;
    }

    /** Validate path syntax (no `..`) and enforce `permissions.write`. */
    assertCanWrite(targetPath: string): string {
        const normalized = safeNormalizePath(targetPath);
        if (!isPathAllowed(this.permissions.write, normalized)) {
            throw new VfsPermissionError(
                normalized,
                `Unauthorized VFS write access to "${normalized}". Allowed write patterns: ${JSON.stringify(this.permissions.write)}.`,
            );
        }
        return normalized;
    }

    async read(path: string, opts?: Omit<VfsReadOptions, 'target' | 'staged'>): Promise<string> {
        const normalized = this.assertCanRead(path);
        return await this.vfs.readFile(normalized, {
            ...opts,
            target: this.options.target,
            staged: this.options.staged,
        });
    }

    async write(path: string, content: string): Promise<void> {
        const normalized = this.assertCanWrite(path);
        await this.vfs.writeFile(normalized, content, {
            target: this.options.target,
            staged: this.options.staged,
            source: this.options.source ?? 'tool',
        });
    }

    async append(path: string, content: string): Promise<void> {
        const normalized = this.assertCanWrite(path);
        await this.vfs.appendFile(normalized, content, {
            target: this.options.target,
            staged: this.options.staged,
            source: this.options.source ?? 'tool',
        });
    }

    async edit(path: string, oldText: string, newText: string): Promise<ToolEditResult> {
        const normalized = this.assertCanWrite(path);
        return await this.vfs.editFile(normalized, oldText, newText, {
            target: this.options.target,
            staged: this.options.staged,
            source: this.options.source ?? 'tool',
        });
    }

    async delete(path: string): Promise<boolean> {
        const normalized = this.assertCanWrite(path);
        return await this.vfs.deleteFile(normalized, {
            target: this.options.target,
            staged: this.options.staged,
            source: this.options.source ?? 'tool-delete',
        });
    }

    async stat(path: string): Promise<VfsEntryStat | null> {
        const normalized = safeNormalizePath(path);
        if (
            !isPathAllowed(this.permissions.read, normalized)
            && !canDescendIntoDir(this.permissions.read, normalized)
        ) {
            throw new VfsPermissionError(
                normalized,
                `Unauthorized VFS stat access to "${normalized}". Allowed read patterns: ${JSON.stringify(this.permissions.read)}.`,
            );
        }
        const entry = await this.vfs.stat(normalized, {
            target: this.options.target,
            staged: this.options.staged,
        });
        if (!entry) {
            return null;
        }
        if (entry.kind === 'file' && !isPathAllowed(this.permissions.read, entry.path)) {
            throw new VfsPermissionError(
                entry.path,
                `Unauthorized VFS read access to "${entry.path}". Allowed read patterns: ${JSON.stringify(this.permissions.read)}.`,
            );
        }
        if (entry.kind === 'directory' && !canDescendIntoDir(this.permissions.read, entry.path)) {
            throw new VfsPermissionError(
                entry.path,
                `Unauthorized VFS stat access to "${entry.path}". Allowed read patterns: ${JSON.stringify(this.permissions.read)}.`,
            );
        }
        return entry;
    }

    async list(dirPath: string = '/'): Promise<VfsEntryStat[]> {
        const normalizedDir = this.assertCanBrowseDir(dirPath, 'list');
        const entries = await this.vfs.listDir(normalizedDir, {
            target: this.options.target,
            staged: this.options.staged,
        });
        return entries.filter((entry) => {
            if (entry.kind === 'directory') {
                return canDescendIntoDir(this.permissions.read, entry.path);
            }
            return isPathAllowed(this.permissions.read, entry.path);
        });
    }

    async search(
        query: string,
        opts: Omit<VfsSearchOptions, 'target' | 'staged'> = {},
    ): Promise<VfsSearchHit[]> {
        const prefix = opts.pathPrefix ? this.assertCanBrowseDir(opts.pathPrefix, 'search') : '/';
        if (!opts.pathPrefix && !this.hasAnyReadPermission()) {
            throw new VfsPermissionError(
                '/',
                `Unauthorized VFS search access: read whitelist is empty.`,
            );
        }
        const rawHits = await this.vfs.searchFiles(query, {
            pathPrefix: prefix,
            limit: opts.limit ? opts.limit * 3 : 50,
            target: this.options.target,
            staged: this.options.staged,
        });
        const filtered = rawHits.filter((hit) => isPathAllowed(this.permissions.read, hit.path));
        return opts.limit ? filtered.slice(0, opts.limit) : filtered;
    }

    async grep(
        query: string,
        opts: Omit<VfsGrepOptions, 'target' | 'staged'> = {},
    ): Promise<VfsSearchHit[]> {
        const prefix = opts.pathPrefix ? this.assertCanBrowseDir(opts.pathPrefix, 'grep') : '/';
        if (!opts.pathPrefix && !this.hasAnyReadPermission()) {
            throw new VfsPermissionError(
                '/',
                `Unauthorized VFS grep access: read whitelist is empty.`,
            );
        }
        const rawHits = await this.vfs.grepSearch(query, {
            ...opts,
            pathPrefix: prefix,
            target: this.options.target,
            staged: this.options.staged,
        });
        const filtered = rawHits.filter((hit) => isPathAllowed(this.permissions.read, hit.path));
        return opts.limit ? filtered.slice(0, opts.limit) : filtered;
    }

    async glob(pattern: string): Promise<string[]> {
        if (typeof pattern !== 'string' || pattern.includes('\0') || pattern.split(/[\\/]/).includes('..')) {
            throw new VfsInvalidPathError(pattern, `Path traversal ("..") is not allowed in glob pattern: ${pattern}`);
        }
        if (!this.hasAnyReadPermission()) {
            throw new VfsPermissionError(
                pattern,
                `Unauthorized VFS glob access for "${pattern}": read whitelist is empty.`,
            );
        }

        const staticPrefix = extractStaticGlobPrefix(pattern);
        if (staticPrefix !== '/') {
            this.assertCanBrowseDir(staticPrefix, 'glob');
        }

        const matched = await this.vfs.globFiles(pattern, {
            target: this.options.target,
            staged: this.options.staged,
        });
        return matched.filter((filePath) => isPathAllowed(this.permissions.read, filePath));
    }

    private hasAnyReadPermission(): boolean {
        return this.permissions.read.some((p) => typeof p === 'string' && p.trim().length > 0 && !p.trim().startsWith('!'));
    }

    private assertCanBrowseDir(dirPath: string, operation: string): string {
        const normalized = safeNormalizePath(dirPath);
        if (!canDescendIntoDir(this.permissions.read, normalized)) {
            throw new VfsPermissionError(
                normalized,
                `Unauthorized VFS ${operation} access to "${normalized}". Allowed read patterns: ${JSON.stringify(this.permissions.read)}.`,
            );
        }
        return normalized;
    }
}

function safeNormalizePath(rawPath: string): string {
    try {
        return normalizeVfsPath(rawPath);
    } catch (error) {
        throw new VfsInvalidPathError(rawPath, (error as Error).message);
    }
}

function normalizePatternToPosix(pattern: string): string | null {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.includes('\0')) {
        return null;
    }
    const posix = trimmed.replace(/\\/g, '/');
    const rawSegs = posix.split('/');
    const segs: string[] = [];
    for (const seg of rawSegs) {
        if (!seg || seg === '.') {
            continue;
        }
        if (seg === '..') {
            return null;
        }
        if (seg === '**' && segs[segs.length - 1] === '**') {
            continue;
        }
        segs.push(seg);
    }
    return segs.length === 0 ? '/' : `/${segs.join('/')}`;
}

function compileSegmentRegExp(segPattern: string): RegExp {
    let source = '^';
    for (let i = 0; i < segPattern.length; ++i) {
        const ch = segPattern[i];
        if (ch === '*') {
            source += '[^/]*';
        } else if (ch === '?') {
            source += '[^/]';
        } else if (/[\\^$.|+()[\]{}]/.test(ch)) {
            source += `\\${ch}`;
        } else {
            source += ch;
        }
    }
    source += '$';
    return new RegExp(source);
}

function patternMatchesDescendant(normalizedPattern: string, normalizedDir: string): boolean {
    if (normalizedPattern === '/') {
        return false;
    }
    if (normalizedPattern === '/**') {
        return true;
    }
    if (normalizedDir === '/') {
        return true;
    }

    const patSegs = normalizedPattern.slice(1).split('/');
    const dirSegs = normalizedDir.slice(1).split('/');

    const match = (pi: number, di: number): boolean => {
        if (di === dirSegs.length) {
            return pi < patSegs.length;
        }
        if (pi === patSegs.length) {
            return false;
        }
        if (patSegs[pi] === '**') {
            return match(pi + 1, di) || match(pi, di + 1);
        }
        if (compileSegmentRegExp(patSegs[pi]).test(dirSegs[di])) {
            return match(pi + 1, di + 1);
        }
        return false;
    };

    return match(0, 0);
}

function negPatternBlanketsDir(normalizedNeg: string, normalizedDir: string): boolean {
    if (normalizedNeg === '/**') {
        return true;
    }
    if (!normalizedNeg.endsWith('/**') || normalizedDir === '/') {
        return false;
    }

    const prefixPattern = normalizedNeg.slice(0, -3) || '/';
    const dirSegs = normalizedDir.slice(1).split('/');
    for (let k = 1; k <= dirSegs.length; ++k) {
        const prefixDir = `/${dirSegs.slice(0, k).join('/')}`;
        if (matchGlob(prefixPattern, prefixDir)) {
            return true;
        }
    }
    return false;
}

/**
 * Determine whether any pattern sequence in `patterns` allows descending into
 * `dirPath` (i.e. files inside `dirPath` or below could satisfy `isPathAllowed`).
 */
export function canDescendIntoDir(patterns: readonly string[], dirPath: string): boolean {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }

    let normalizedDir: string;
    try {
        normalizedDir = normalizeVfsPath(dirPath);
    } catch {
        return false;
    }

    let reachable = false;
    for (const raw of patterns) {
        if (typeof raw !== 'string') {
            continue;
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            continue;
        }

        if (trimmed.startsWith('!')) {
            const negPat = normalizePatternToPosix(trimmed.slice(1));
            if (reachable && negPat && negPatternBlanketsDir(negPat, normalizedDir)) {
                reachable = false;
            }
        } else {
            const posPat = normalizePatternToPosix(trimmed);
            if (
                !reachable
                && posPat
                && (matchGlob(posPat, normalizedDir) || patternMatchesDescendant(posPat, normalizedDir))
            ) {
                reachable = true;
            }
        }
    }

    return reachable;
}

function extractStaticGlobPrefix(pattern: string): string {
    const posix = pattern.trim().replace(/\\/g, '/');
    const segs = posix.split('/').filter((s) => s && s !== '.');
    const staticSegs: string[] = [];
    for (const seg of segs) {
        if (seg.includes('*') || seg.includes('?')) {
            break;
        }
        staticSegs.push(seg);
    }
    return staticSegs.length === 0 ? '/' : `/${staticSegs.join('/')}`;
}
