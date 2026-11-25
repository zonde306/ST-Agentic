import { z } from 'zod';
import type { ToolEditOperation, ToolExecutionContext } from '@/core/bridge';
import { isSpillPath } from '@/core/context';
import type { VfsEntryStat, VfsSearchHit } from '@/core/types';
import { hashText, normalizeVfsPath } from '@/core/utils';
import {
    AGENT_WORKSPACE_MAX_FILES,
    AGENT_WORKSPACE_MAX_FILE_BYTES,
    AGENT_WORKSPACE_MAX_TOTAL_BYTES,
    OUTPUT_FILE_PATH,
    ScopedToolGuard,
    VfsError,
    VfsNotFoundError,
    applyTextEdits,
    countLines,
    formatFileReadResult,
    grepLinesInText,
    isAgentQuotaScopedPath,
    utf8ByteLength,
} from '@/core/vfs';
import type { ToolDefinition } from './registry';
import { createAbortError, isAbortError, throwIfAborted } from './script-sandbox';

function formatFsError(error: unknown, signal?: AbortSignal): string {
    if (isAbortError(error) || signal?.aborted) {
        if (error instanceof Error && isAbortError(error)) {
            throw error;
        }
        throw createAbortError();
    }
    if (error instanceof VfsError) {
        return JSON.stringify({
            ok: false,
            code: error.code,
            path: error.path,
            error: error.message,
        });
    }
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ ok: false, error: message });
}

function normalizeDirectoryInput(rawPath: string | undefined): string {
    const trimmed = (rawPath ?? '/').trim();
    if (!trimmed || trimmed === '.') {
        return '/';
    }
    return normalizeVfsPath(trimmed);
}

function extractHashableBody(normalizedPath: string, content: string): string {
    if (normalizedPath.startsWith('/lorebooks/') && /^---\r?\n/.test(content)) {
        const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/.exec(content);
        if (match) {
            return content.slice(match[0].length);
        }
    }
    return content;
}

async function recordReadSetDigest(
    ctx: ToolExecutionContext,
    normalizedPath: string,
    content: string,
): Promise<void> {
    if (!ctx.readSet || normalizedPath === OUTPUT_FILE_PATH) {
        return;
    }
    const hashable = extractHashableBody(normalizedPath, content);
    const digest = await hashText(hashable);
    ctx.readSet.set(normalizedPath, digest);
}

const KNOWN_MOUNT_PREFIXES = [
    '/workspace/',
    '/preset/',
    '/global/',
    '/character/',
    '/persona/',
    '/lorebooks/',
    '/skills/',
    '/history/',
    '/state/',
    '/side/',
] as const;

type StatCapableFs = ToolExecutionContext['fs'] & {
    stat?: (path: string) => Promise<VfsEntryStat | null>;
};

function getStatFn(
    fs: ToolExecutionContext['fs'],
): ((path: string) => Promise<VfsEntryStat | null>) | undefined {
    const candidate = (fs as StatCapableFs).stat;
    return typeof candidate === 'function' ? candidate.bind(fs) : undefined;
}

async function findMissingPathHints(
    ctx: ToolExecutionContext,
    normalizedPath: string,
): Promise<string[]> {
    const statFn = getStatFn(ctx.fs);
    if (!statFn || normalizedPath === '/') {
        return [];
    }
    const lower = normalizedPath.toLowerCase();
    if (KNOWN_MOUNT_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
        return [];
    }
    const candidates = [
        `/workspace${normalizedPath}`,
        `/preset${normalizedPath}`,
        `/global${normalizedPath}`,
    ];
    const hits: string[] = [];
    for (const candidate of candidates) {
        try {
            const st = await statFn(candidate);
            if (st && st.kind === 'file') {
                hits.push(candidate);
            }
        } catch {
            // Skip unreadable or missing candidate without leaking unauthorized paths.
        }
    }
    return hits;
}

async function checkAgentWorkspaceQuota(
    ctx: ToolExecutionContext,
    normalizedPath: string,
    nextContent: string,
): Promise<string | null> {
    if (!isAgentQuotaScopedPath(normalizedPath)) {
        return null;
    }

    const nextBytes = utf8ByteLength(nextContent);
    if (nextBytes > AGENT_WORKSPACE_MAX_FILE_BYTES) {
        return JSON.stringify({
            ok: false,
            code: 'EINVAL',
            path: normalizedPath,
            error: `Agent workspace file "${normalizedPath}" exceeds single-file quota (${nextBytes} > ${AGENT_WORKSPACE_MAX_FILE_BYTES} bytes). Trim or summarize content.`,
        });
    }

    const seenPaths = new Set<string>();
    if (typeof ctx.fs.glob === 'function') {
        for (const pattern of ['/workspace/shared/**/*', '/scratch/**/*']) {
            try {
                const matched = await ctx.fs.glob(pattern);
                for (const p of matched) {
                    seenPaths.add(p);
                }
            } catch {
                // Ignore quota partition not readable by this agent.
            }
        }
    }

    const statFn = getStatFn(ctx.fs);
    let exists = seenPaths.has(normalizedPath);
    if (!exists && statFn) {
        try {
            const st = await statFn(normalizedPath);
            if (st && st.kind === 'file') {
                exists = true;
            }
        } catch {
            // File does not exist yet.
        }
    }

    if (!exists && seenPaths.size >= AGENT_WORKSPACE_MAX_FILES) {
        return JSON.stringify({
            ok: false,
            code: 'EINVAL',
            path: normalizedPath,
            error: `Agent workspace quota exceeded: maximum ${AGENT_WORKSPACE_MAX_FILES} files across /workspace/shared/** and /scratch/**. Reuse or consolidate existing files.`,
        });
    }

    let otherBytes = 0;
    if (statFn) {
        for (const filePath of seenPaths) {
            if (filePath === normalizedPath) {
                continue;
            }
            try {
                const st = await statFn(filePath);
                if (st && st.kind === 'file') {
                    otherBytes += st.size;
                }
            } catch {
                // Ignore transient stat failure.
            }
        }
    }

    const projectedTotal = otherBytes + nextBytes;
    if (projectedTotal > AGENT_WORKSPACE_MAX_TOTAL_BYTES) {
        return JSON.stringify({
            ok: false,
            code: 'EINVAL',
            path: normalizedPath,
            error: `Agent workspace total quota exceeded (${projectedTotal} > ${AGENT_WORKSPACE_MAX_TOTAL_BYTES} bytes across /workspace/shared/** and /scratch/**). Trim or reuse existing files.`,
        });
    }

    return null;
}

async function fallbackGrep(
    ctx: ToolExecutionContext,
    query: string,
    pathPrefix: string,
    caseSensitive: boolean,
    isRegex: boolean,
    limit: number,
    contextLines?: number,
    maxMatchesPerFile?: number,
): Promise<VfsSearchHit[]> {
    if (isRegex) {
        try {
            new RegExp(query, caseSensitive ? '' : 'i');
        } catch (error) {
            throw new VfsError(`Invalid grep regex: ${(error as Error).message}`, 'EINVAL', pathPrefix);
        }
    }

    const pattern = pathPrefix === '/' ? '/**/*' : `${pathPrefix}/**/*`;
    const files = await ctx.fs.glob(pattern);
    const hits: VfsSearchHit[] = [];

    for (const filePath of files) {
        throwIfAborted(ctx.signal);
        if (pathPrefix !== '/' && filePath !== pathPrefix && !filePath.startsWith(`${pathPrefix}/`)) {
            continue;
        }
        let content: string;
        try {
            content = await ctx.fs.read(filePath);
        } catch {
            continue;
        }
        const remaining = limit - hits.length;
        if (remaining <= 0) {
            break;
        }
        const maxMatches =
            maxMatchesPerFile !== undefined
                ? Math.min(remaining, Math.max(1, Math.floor(maxMatchesPerFile)))
                : remaining;
        const fileHits = grepLinesInText({
            path: filePath,
            content,
            query,
            caseSensitive,
            regex: isRegex,
            contextLines,
            maxMatches,
        });
        hits.push(...fileHits);
        if (hits.length >= limit) {
            return hits.slice(0, limit);
        }
    }

    return hits;
}

const LIST_DIR_SCHEMA = z.object({
    path: z
        .string()
        .optional()
        .default('/')
        .describe(
            'Directory path to list. "/" (or ".") is the workspace root. Mounted scopes: /character, /persona, /lorebooks, /skills, /preset, /state, /global, /history.',
        ),
});

const GLOB_FILES_SCHEMA = z.object({
    pattern: z
        .string()
        .min(1)
        .describe('Glob pattern to match VFS paths, e.g. "/lorebooks/**/*.md" or "**/*.md".'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe('Maximum number of matching file paths to return (1-500).'),
});

const GREP_SEARCH_SCHEMA = z.object({
    query: z.string().min(1).describe('Literal text or regular expression to match line-by-line.'),
    path_prefix: z
        .string()
        .optional()
        .default('/')
        .describe(
            'Optional directory prefix, exact single VFS file path, or /tmp/tool-spill/* path to restrict search, e.g. "/lorebooks" or "/lorebooks/World/city-5.md".',
        ),
    case_sensitive: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether matching is case-sensitive.'),
    regex: z
        .boolean()
        .optional()
        .default(false)
        .describe('Interpret query as a JavaScript regular expression.'),
    context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(2)
        .describe('Number of surrounding lines before and after each hit to include (0-10, default 2).'),
    max_matches_per_file: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Optional cap on matches returned per file so one large file does not exhaust limit.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe('Maximum number of matching lines to return (1-200).'),
});

const SEARCH_FILES_SCHEMA = z.object({
    query: z
        .string()
        .describe('Keywords or natural language query for ranked BM25/fuzzy search across VFS files.'),
    path_prefix: z
        .string()
        .optional()
        .default('/')
        .describe('Optional VFS directory prefix to restrict search, e.g. "/lorebooks".'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(25)
        .describe('Maximum number of ranked hits to return (1-100).'),
});

const READ_FILE_SCHEMA = z.object({
    path: z
        .string()
        .min(1)
        .describe('VFS or /tmp/tool-spill/* file path.'),
    start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based inclusive start line.'),
    end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based inclusive end line.'),
    line_numbers: z
        .boolean()
        .optional()
        .default(true)
        .describe('Prefix lines with "N| ".'),
    char_offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('0-based char offset for huge single lines.'),
    char_limit: z
        .number()
        .int()
        .min(200)
        .max(20_000)
        .optional()
        .describe('Max chars per line (200-20000).'),
});

const WRITE_FILE_SCHEMA = z.object({
    path: z
        .string()
        .min(1)
        .describe(
            'Target VFS path, e.g. "/output.md", "/memory/notes.md", "/global/prefs.md", or "/lorebooks/<book>/<entry>.md".',
        ),
    content: z.string().describe('Full replacement content to write to the file.'),
});

const APPEND_FILE_SCHEMA = z.object({
    content: z.string().describe('Content to append verbatim to the end of the target file.'),
    path: z
        .string()
        .min(1)
        .describe('Writable VFS file path (e.g. "/output.md" or "/memory/notes.md").'),
});

const EDIT_OPERATION_SCHEMA = z.object({
    search: z.string().min(1).describe('Verbatim snippet to match (no "N| " prefix).'),
    replace: z.string().describe('Replacement text.'),
    start_line: z.number().int().min(1).optional().describe('1-based start line.'),
    end_line: z.number().int().min(1).optional().describe('1-based end line.'),
    replace_all: z.boolean().optional().default(false).describe('Replace all matches in scope.'),
});

const EDIT_FILE_SCHEMA = z.object({
    path: z.string().min(1).describe('VFS file path to edit.'),
    search: z
        .string()
        .min(1)
        .optional()
        .describe('Verbatim text to replace (omit if using edits[]; no "N| " prefix).'),
    replace: z
        .string()
        .optional()
        .describe('Replacement text ("" to delete).'),
    start_line: z.number().int().min(1).optional().describe('1-based start line scope.'),
    end_line: z.number().int().min(1).optional().describe('1-based end line scope.'),
    replace_all: z
        .boolean()
        .optional()
        .default(false)
        .describe('Replace all matches in scope.'),
    edits: z
        .array(EDIT_OPERATION_SCHEMA)
        .min(1)
        .max(50)
        .optional()
        .describe('Atomic batch of non-overlapping edits.'),
});

/** Create the 8 built-in VFS tools backed by `ctx.fs` (`ScopedToolGuard`). */
export function createFsTools(): ToolDefinition[] {
    const listDirTool: ToolDefinition<typeof LIST_DIR_SCHEMA> = {
        name: 'list_dir',
        description:
            'List files and subdirectories in the Virtual File System (VFS). Use "/" for workspace root and discover /character, /persona, /lorebooks, /skills, /preset, /state, /global, and /history.',
        parameters: LIST_DIR_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const dirPath = normalizeDirectoryInput(args.path);
                const entries = await ctx.fs.list(dirPath);
                return JSON.stringify({ ok: true, path: dirPath, entries });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const globFilesTool: ToolDefinition<typeof GLOB_FILES_SCHEMA> = {
        name: 'glob_files',
        description:
            'Match VFS file paths against a glob pattern such as "/lorebooks/**/*.md" or "/memory/**".',
        parameters: GLOB_FILES_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const matched = await ctx.fs.glob(args.pattern);
                return JSON.stringify({
                    ok: true,
                    pattern: args.pattern,
                    total: matched.length,
                    results: matched.slice(0, args.limit),
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const grepSearchTool: ToolDefinition<typeof GREP_SEARCH_SCHEMA> = {
        name: 'grep_search',
        description:
            'Search VFS files (or /tmp/tool-spill/*) line-by-line for an exact substring or regex, returning 1-based line numbers aligned with read_file, totalLines, centered snippets, and surrounding context lines.',
        parameters: GREP_SEARCH_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const rawPrefix = (args.path_prefix ?? '/').trim();
                if (isSpillPath(rawPrefix)) {
                    const pathPrefix = normalizeDirectoryInput(rawPrefix);
                    if (!ctx.spillStore) {
                        return JSON.stringify({
                            ok: false,
                            error: `Spill path not found or expired: "${pathPrefix}" (no active spill store).`,
                        });
                    }
                    if (pathPrefix !== '/tmp/tool-spill') {
                        const hasExact = ctx.spillStore.get(pathPrefix) !== null;
                        const prefixWithSlash = `${pathPrefix}/`;
                        const hasPrefix = ctx.spillStore
                            .listPaths()
                            .some((p) => p.startsWith(prefixWithSlash));
                        if (!hasExact && !hasPrefix) {
                            return JSON.stringify({
                                ok: false,
                                error: `Spill entry not found or expired: "${pathPrefix}". It may have been evicted or cleared.`,
                            });
                        }
                    }
                    const hits = ctx.spillStore.grep(pathPrefix, args.query, {
                        caseSensitive: args.case_sensitive,
                        regex: args.regex,
                        limit: args.limit,
                        contextLines: args.context_lines,
                        maxMatchesPerFile: args.max_matches_per_file,
                    });
                    return JSON.stringify({
                        ok: true,
                        query: args.query,
                        pathPrefix,
                        total: hits.length,
                        results: hits,
                    });
                }

                const pathPrefix = normalizeDirectoryInput(args.path_prefix);
                const scoped = ctx.fs as ToolExecutionContext['fs'] & {
                    grep?: ScopedToolGuard['grep'];
                };
                const hits =
                    typeof scoped.grep === 'function'
                        ? await scoped.grep(args.query, {
                            pathPrefix,
                            caseSensitive: args.case_sensitive,
                            regex: args.regex,
                            limit: args.limit,
                            contextLines: args.context_lines,
                            maxMatchesPerFile: args.max_matches_per_file,
                        })
                        : await fallbackGrep(
                            ctx,
                            args.query,
                            pathPrefix,
                            args.case_sensitive,
                            args.regex,
                            args.limit,
                            args.context_lines,
                            args.max_matches_per_file,
                        );
                return JSON.stringify({
                    ok: true,
                    query: args.query,
                    pathPrefix,
                    total: hits.length,
                    results: hits,
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const searchFilesTool: ToolDefinition<typeof SEARCH_FILES_SCHEMA> = {
        name: 'search_files',
        description:
            'Perform ranked full-text and fuzzy search across VFS files (including lorebooks, character sheets, memory, and history). Hits include 1-based line, totalLines, matchedIn, and centered snippet.',
        parameters: SEARCH_FILES_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const pathPrefix = normalizeDirectoryInput(args.path_prefix);
                const hits = await ctx.fs.search(args.query, {
                    pathPrefix,
                    limit: args.limit,
                });
                return JSON.stringify({
                    ok: true,
                    query: args.query,
                    pathPrefix,
                    total: hits.length,
                    results: hits,
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const readFileTool: ToolDefinition<typeof READ_FILE_SCHEMA> = {
        name: 'read_file',
        description:
            'Read a VFS or /tmp/tool-spill/* file with 1-based "N| " line numbers. Soft-paginates at 200 lines / 24 KB; pass start_line/end_line (or char_offset/char_limit) to page. Full reads update Read-Set.',
        parameters: READ_FILE_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            if (
                args.start_line !== undefined
                && args.end_line !== undefined
                && args.start_line > args.end_line
            ) {
                return JSON.stringify({
                    ok: false,
                    error: `Invalid line range: start_line (${args.start_line}) must be <= end_line (${args.end_line}).`,
                });
            }

            try {
                const normalizedPath = normalizeVfsPath(args.path);
                if (isSpillPath(args.path)) {
                    if (!ctx.spillStore) {
                        return JSON.stringify({
                            ok: false,
                            error: `Spill entry not found or expired: "${normalizedPath}" (no active spill store).`,
                        });
                    }
                    const entry = ctx.spillStore.get(normalizedPath);
                    if (!entry) {
                        return JSON.stringify({
                            ok: false,
                            error: `Spill entry not found or expired: "${normalizedPath}". It may have been evicted or cleared.`,
                        });
                    }
                    const formatted = formatFileReadResult({
                        path: normalizedPath,
                        rawContent: entry.content,
                        startLine: args.start_line,
                        endLine: args.end_line,
                        lineNumbers: args.line_numbers,
                        charOffset: args.char_offset,
                        charLimit: args.char_limit,
                    });
                    return formatted.text;
                }

                const rawContent = await ctx.fs.read(normalizedPath);
                const formatted = formatFileReadResult({
                    path: normalizedPath,
                    rawContent,
                    startLine: args.start_line,
                    endLine: args.end_line,
                    lineNumbers: args.line_numbers,
                    charOffset: args.char_offset,
                    charLimit: args.char_limit,
                });

                if (formatted.coveredFullFile) {
                    await recordReadSetDigest(ctx, normalizedPath, rawContent);
                }

                return formatted.text;
            } catch (error) {
                const isNotFoundOrDenied =
                    error instanceof VfsNotFoundError
                    || (error instanceof VfsError && (error.code === 'ENOENT' || error.code === 'EACCES'));
                if (isNotFoundOrDenied) {
                    try {
                        const normalizedPath = normalizeVfsPath(args.path);
                        const hints = await findMissingPathHints(ctx, normalizedPath);
                        if (hints.length > 0) {
                            return JSON.stringify({
                                ok: false,
                                code: error.code,
                                path: error.path,
                                error: error.message,
                                hint: `Did you mean ${hints.map((h) => `"${h}"`).join(' or ')}?`,
                            });
                        }
                    } catch {
                        // Fall through to standard error formatting.
                    }
                }
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const writeFileTool: ToolDefinition<typeof WRITE_FILE_SCHEMA> = {
        name: 'write_file',
        description:
            'Create or overwrite a writable VFS file bound to the current causal branch target. Respects ScopedPermissions and read-only mounts.',
        parameters: WRITE_FILE_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const normalizedPath = normalizeVfsPath(args.path);
                const quotaError = await checkAgentWorkspaceQuota(ctx, normalizedPath, args.content);
                if (quotaError) {
                    return quotaError;
                }
                await ctx.fs.write(normalizedPath, args.content);
                await recordReadSetDigest(ctx, normalizedPath, args.content);
                return JSON.stringify({
                    ok: true,
                    path: normalizedPath,
                    bytes: utf8ByteLength(args.content),
                    totalLines: countLines(args.content),
                    target: ctx.target,
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const appendFileTool: ToolDefinition<typeof APPEND_FILE_SCHEMA> = {
        name: 'append_file',
        description:
            'Append content verbatim to the end of a writable VFS file bound to the current causal branch target (e.g. "/output.md", "/memory/notes.md", or "/workspace/shared/handoff.md").',
        parameters: APPEND_FILE_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const normalizedPath = normalizeVfsPath(args.path);
                let existing = '';
                let hasExisting = false;
                if (isAgentQuotaScopedPath(normalizedPath) || typeof ctx.fs.append !== 'function') {
                    try {
                        existing = await ctx.fs.read(normalizedPath);
                        hasExisting = true;
                    } catch (error) {
                        const isNotFound =
                            (error instanceof VfsError && error.code === 'ENOENT')
                            || /not found|missing|enoent/i.test((error as Error)?.message ?? '');
                        const isWriteOnlySkip =
                            typeof ctx.fs.append === 'function'
                            && error instanceof VfsError
                            && error.code === 'EACCES';
                        if (!isNotFound && !isWriteOnlySkip) {
                            throw error;
                        }
                    }
                    const nextContent = `${hasExisting ? existing : ''}${args.content}`;
                    const quotaError = await checkAgentWorkspaceQuota(ctx, normalizedPath, nextContent);
                    if (quotaError) {
                        return quotaError;
                    }
                }

                if (typeof ctx.fs.append === 'function') {
                    await ctx.fs.append(normalizedPath, args.content);
                } else {
                    await ctx.fs.write(normalizedPath, `${existing}${args.content}`);
                }

                let totalLines: number | undefined;
                try {
                    const finalContent = await ctx.fs.read(normalizedPath);
                    totalLines = countLines(finalContent);
                    if (ctx.readSet && normalizedPath !== OUTPUT_FILE_PATH) {
                        await recordReadSetDigest(ctx, normalizedPath, finalContent);
                    }
                } catch {
                    // Skip Read-Set self-dedup / line count if read permission is absent.
                }

                return JSON.stringify({
                    ok: true,
                    path: normalizedPath,
                    appendedBytes: utf8ByteLength(args.content),
                    ...(totalLines !== undefined ? { totalLines } : {}),
                    target: ctx.target,
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    const editFileTool: ToolDefinition<typeof EDIT_FILE_SCHEMA> = {
        name: 'edit_file',
        description:
            'Safely edit a writable VFS file using verbatim matching. Rejects ambiguous matches unless scoped via start_line/end_line or replace_all, and supports atomic edits[]. Omit "N| " prefixes.',
        parameters: EDIT_FILE_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const ops: ToolEditOperation[] = args.edits && args.edits.length > 0
                    ? args.edits.map((op) => ({
                        search: op.search,
                        replace: op.replace,
                        ...(op.start_line !== undefined ? { startLine: op.start_line } : {}),
                        ...(op.end_line !== undefined ? { endLine: op.end_line } : {}),
                        ...(op.replace_all !== undefined ? { replaceAll: op.replace_all } : {}),
                    }))
                    : args.search !== undefined && args.replace !== undefined
                        ? [
                            {
                                search: args.search,
                                replace: args.replace,
                                ...(args.start_line !== undefined ? { startLine: args.start_line } : {}),
                                ...(args.end_line !== undefined ? { endLine: args.end_line } : {}),
                                ...(args.replace_all !== undefined ? { replaceAll: args.replace_all } : {}),
                            },
                        ]
                        : [];

                if (ops.length === 0) {
                    return JSON.stringify({
                        ok: false,
                        code: 'INVALID_EDITS',
                        path: args.path,
                        error: 'edit_file requires either "search" and "replace", or a non-empty "edits" array.',
                    });
                }

                const normalizedPath = normalizeVfsPath(args.path);
                if (isAgentQuotaScopedPath(normalizedPath)) {
                    try {
                        const existing = await ctx.fs.read(normalizedPath);
                        const preview = applyTextEdits({
                            path: normalizedPath,
                            content: existing,
                            edits: ops,
                        });
                        if (preview.ok && preview.updatedContent !== undefined) {
                            const quotaError = await checkAgentWorkspaceQuota(
                                ctx,
                                normalizedPath,
                                preview.updatedContent,
                            );
                            if (quotaError) {
                                return quotaError;
                            }
                        }
                    } catch {
                        // Let ctx.fs.edit handle missing or unreadable files cleanly.
                    }
                }

                const first = ops[0];
                const result = await ctx.fs.edit(normalizedPath, first.search, first.replace, {
                    ...(first.startLine !== undefined ? { startLine: first.startLine } : {}),
                    ...(first.endLine !== undefined ? { endLine: first.endLine } : {}),
                    ...(first.replaceAll !== undefined ? { replaceAll: first.replaceAll } : {}),
                    edits: ops,
                });
                if (!result.ok) {
                    return JSON.stringify({
                        ok: false,
                        path: result.path,
                        ...(result.code ? { code: result.code } : {}),
                        ...(result.matchLines ? { matchLines: result.matchLines } : {}),
                        error: result.message,
                    });
                }

                if (ctx.readSet && normalizedPath !== OUTPUT_FILE_PATH) {
                    try {
                        const finalContent = await ctx.fs.read(normalizedPath);
                        await recordReadSetDigest(ctx, normalizedPath, finalContent);
                    } catch {
                        // Skip Read-Set self-dedup if read permission is absent.
                    }
                }

                return JSON.stringify({
                    ok: true,
                    path: result.path,
                    message: result.message,
                    ...(result.replacements !== undefined ? { replacements: result.replacements } : {}),
                    ...(result.changedRanges ? { changedRanges: result.changedRanges } : {}),
                    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
                    ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
                    target: ctx.target,
                });
            } catch (error) {
                return formatFsError(error, ctx.signal);
            }
        },
    };

    return [
        listDirTool,
        globFilesTool,
        grepSearchTool,
        searchFilesTool,
        readFileTool,
        writeFileTool,
        appendFileTool,
        editFileTool,
    ];
}
