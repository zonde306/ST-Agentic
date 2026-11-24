import { matchGlob, normalizeVfsPath } from '@/core/utils';

export const WORKSPACE_AGENTS_MD_PATH = '/workspace/AGENTS.md';
export const WORKSPACE_DOCS_PREFIX = '/workspace/docs/';
export const WORKSPACE_SHARED_PREFIX = '/workspace/shared/';
export const GLOBAL_AGENTS_MD_PATH = '/global/AGENTS.md';
export const GLOBAL_DOCS_PREFIX = '/global/docs/';
export const PRESET_AGENTS_MD_PATH = '/preset/AGENTS.md';
export const ROOT_AGENTS_MD_PATH = '/AGENTS.md';

export const AGENT_WORKSPACE_MAX_FILE_BYTES = 64 * 1024;
export const AGENT_WORKSPACE_MAX_TOTAL_BYTES = 256 * 1024;
export const AGENT_WORKSPACE_MAX_FILES = 32;

function safeNormalizePath(rawPath: string): string | null {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return null;
    }
    try {
        return normalizeVfsPath(rawPath);
    } catch {
        return null;
    }
}

/** Whether `rawPath` is a top-level `AGENTS.md` instruction index path across any scope. */
export function isInstructionIndexPath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    const lower = normalized.toLowerCase();
    return (
        lower === '/global/agents.md'
        || lower === '/preset/agents.md'
        || lower === '/workspace/agents.md'
        || lower === '/agents.md'
    );
}

/** Whether `rawPath` is an on-demand reference sub-document (`docs/**`, `/preset/*`, or `/global/*`). */
export function isInstructionDocPath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    const lower = normalized.toLowerCase();
    if (lower.startsWith('/workspace/docs/') && lower.length > '/workspace/docs/'.length) {
        return true;
    }
    if (lower.startsWith('/preset/') && lower !== '/preset/agents.md') {
        return true;
    }
    if (lower.startsWith('/global/') && lower !== '/global/agents.md') {
        return true;
    }
    return false;
}

/**
 * Whether `rawPath` is a protected instruction/reference path that must never be
 * writable through wildcard permissions (`/**`, `/workspace/**`, `/global/**`).
 */
export function isProtectedSpecWritePath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    const lower = normalized.toLowerCase();
    if (
        lower === '/agents.md'
        || lower === '/workspace/agents.md'
        || lower === '/preset/agents.md'
        || lower === '/global/agents.md'
    ) {
        return true;
    }
    if (lower.startsWith('/workspace/') && lower.endsWith('/agents.md')) {
        return true;
    }
    if (
        lower === '/workspace/docs'
        || lower.startsWith('/workspace/docs/')
        || lower === '/global/docs'
        || lower.startsWith('/global/docs/')
        || lower === '/preset'
        || lower.startsWith('/preset/')
    ) {
        return true;
    }
    return false;
}

/**
 * Whether a workspace `files` path belongs in the chat-wide `base` layer
 * (persists across swipes/regenerations rather than being bound per-branch).
 */
export function isChatBaseWorkspacePath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    const lower = normalized.toLowerCase();
    return (
        lower === '/workspace/agents.md'
        || lower === '/agents.md'
        || lower.startsWith('/workspace/docs/')
    );
}

/** Whether `rawPath` resides in the cross-agent shared collaboration workspace `/workspace/shared/**`. */
export function isSharedWorkspacePath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    return normalized.toLowerCase().startsWith('/workspace/shared/');
}

/** Whether `rawPath` resides in the temporary `/scratch/**` directory. */
export function isScratchWorkspacePath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    return normalized.toLowerCase().startsWith('/scratch/');
}

/** Whether modifying `rawPath` via Assistant tools requires mandatory explicit user confirmation. */
export function isAgentsMdApprovalRequiredPath(rawPath: string): boolean {
    const normalized = safeNormalizePath(rawPath);
    if (!normalized) {
        return false;
    }
    const lower = normalized.toLowerCase();
    return (
        lower === '/workspace/agents.md'
        || lower === '/agents.md'
        || (lower.startsWith('/workspace/') && lower.endsWith('/agents.md'))
    );
}

/** Whether `rawPath` is subject to agent free-write storage quotas (`/workspace/shared/**` or `/scratch/**`). */
export function isAgentQuotaScopedPath(rawPath: string): boolean {
    return isSharedWorkspacePath(rawPath) || isScratchWorkspacePath(rawPath);
}

/**
 * Evaluate ordered `patterns` (supporting `!` negation) and return `true` ONLY when
 * the final allowed state came from an explicit non-wildcard literal pattern
 * (case-insensitive normalized path match, zero `*` or `?` globs).
 */
export function isLiteralNonWildcardAllowMatch(
    patterns: readonly string[],
    targetPath: string,
): boolean {
    if (!Array.isArray(patterns) || patterns.length === 0) {
        return false;
    }
    const normalizedTarget = safeNormalizePath(targetPath);
    if (!normalizedTarget) {
        return false;
    }
    const lowerTarget = normalizedTarget.toLowerCase();

    let allowed = false;
    let literalMatched = false;

    for (const rawPattern of patterns) {
        if (typeof rawPattern !== 'string') {
            continue;
        }
        const trimmed = rawPattern.trim();
        if (!trimmed) {
            continue;
        }

        if (trimmed.startsWith('!')) {
            if (!allowed) {
                continue;
            }
            const neg = trimmed.slice(1).trim();
            if (!neg) {
                continue;
            }
            const isNegLiteral = !neg.includes('*') && !neg.includes('?');
            if (isNegLiteral) {
                const normNeg = safeNormalizePath(neg);
                if (normNeg && normNeg.toLowerCase() === lowerTarget) {
                    allowed = false;
                    literalMatched = false;
                }
            } else if (matchGlob(neg, normalizedTarget)) {
                allowed = false;
                literalMatched = false;
            }
            continue;
        }

        const isLiteral = !trimmed.includes('*') && !trimmed.includes('?');
        if (isLiteral) {
            const normPattern = safeNormalizePath(trimmed);
            if (normPattern && normPattern.toLowerCase() === lowerTarget) {
                allowed = true;
                literalMatched = true;
            }
        } else if (!allowed && matchGlob(trimmed, normalizedTarget)) {
            allowed = true;
            literalMatched = false;
        }
    }

    return allowed && literalMatched;
}
