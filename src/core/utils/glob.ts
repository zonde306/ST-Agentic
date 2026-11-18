/**
 * Normalize a VFS path to canonical POSIX form starting with `/`.
 * Rejects null bytes and `..` path traversal segments.
 */
export function normalizeVfsPath(inputPath: string): string {
    if (typeof inputPath !== 'string' || inputPath.includes('\0')) {
        throw new Error('Invalid VFS path');
    }

    const posix = inputPath.replace(/\\/g, '/');
    const rawSegments = posix.split('/');
    const resolved: string[] = [];

    for (const seg of rawSegments) {
        if (!seg || seg === '.') {
            continue;
        }
        if (seg === '..') {
            throw new Error(`Path traversal ("..") is not allowed in VFS path: ${inputPath}`);
        }
        resolved.push(seg);
    }

    return resolved.length === 0 ? '/' : `/${resolved.join('/')}`;
}

function normalizeGlobPattern(pattern: string): string | null {
    if (typeof pattern !== 'string' || pattern.includes('\0')) {
        return null;
    }

    const trimmed = pattern.trim();
    if (!trimmed) {
        return null;
    }

    const posix = trimmed.replace(/\\/g, '/');
    const rawSegments = posix.split('/');
    const segments: string[] = [];

    for (const seg of rawSegments) {
        if (!seg || seg === '.') {
            continue;
        }
        if (seg === '..') {
            return null;
        }
        // Collapse consecutive '**' segments into one.
        if (seg === '**' && segments[segments.length - 1] === '**') {
            continue;
        }
        segments.push(seg);
    }

    return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function escapeRegExpChar(ch: string): string {
    return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function compileGlobRegExp(normalizedPattern: string): RegExp {
    if (normalizedPattern === '/**') {
        return /^\/.*$/;
    }

    let regexSource = '^';
    let i = 0;

    while (i < normalizedPattern.length) {
        if (normalizedPattern.startsWith('/**/', i)) {
            regexSource += '(?:/.+|)/';
            i += 4;
            continue;
        }

        if (normalizedPattern.startsWith('/**', i) && i + 3 === normalizedPattern.length) {
            regexSource += '/.*';
            i += 3;
            continue;
        }

        if (normalizedPattern.startsWith('**', i)) {
            regexSource += '.*';
            i += 2;
            continue;
        }

        const ch = normalizedPattern[i];
        if (ch === '*') {
            regexSource += '[^/]*';
        } else if (ch === '?') {
            regexSource += '[^/]';
        } else {
            regexSource += escapeRegExpChar(ch);
        }
        i += 1;
    }

    regexSource += '$';
    return new RegExp(regexSource);
}

/**
 * Match a VFS path against a glob pattern supporting `*`, `**`, `?`, and root `/`.
 * Returns `false` if either pattern or path contains invalid/traversal (`..`) segments.
 */
export function matchGlob(pattern: string, targetPath: string): boolean {
    let normalizedPath: string;
    try {
        normalizedPath = normalizeVfsPath(targetPath);
    } catch {
        return false;
    }

    const normalizedPattern = normalizeGlobPattern(pattern);
    if (!normalizedPattern) {
        return false;
    }

    return compileGlobRegExp(normalizedPattern).test(normalizedPath);
}

/**
 * Evaluate whether `targetPath` is permitted by an ordered list of glob patterns.
 * Supports `!pattern` negation rules; traversal (`..`) paths are always denied.
 */
export function isPathAllowed(patterns: readonly string[], targetPath: string): boolean {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }

    let normalizedPath: string;
    try {
        normalizedPath = normalizeVfsPath(targetPath);
    } catch {
        return false;
    }

    let allowed = false;
    for (const rawPattern of patterns) {
        if (typeof rawPattern !== 'string') {
            continue;
        }

        const trimmed = rawPattern.trim();
        if (!trimmed) {
            continue;
        }

        if (trimmed.startsWith('!')) {
            if (allowed && matchGlob(trimmed.slice(1), normalizedPath)) {
                allowed = false;
            }
        } else if (!allowed && matchGlob(trimmed, normalizedPath)) {
            allowed = true;
        }
    }

    return allowed;
}
