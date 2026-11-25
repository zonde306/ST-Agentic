import { z } from 'zod';
import type { ToolExecutionContext } from '@/core/bridge';
import type { VfsSearchHit } from '@/core/types';
import { normalizeVfsPath } from '@/core/utils';
import {
    ScopedToolGuard,
    VfsError,
    formatFileReadResult,
    grepLinesInText,
} from '@/core/vfs';
import type { ToolDefinition } from './registry';
import { createAbortError, isAbortError, throwIfAborted } from './script-sandbox';

function resolveHistoryPath(rawChunk: string): string {
    const trimmed = rawChunk.trim();
    if (!trimmed) {
        throw new VfsError('History chunk path cannot be empty.', 'EINVAL', '/history');
    }

    const normalizedRaw = normalizeVfsPath(trimmed);
    const candidate =
        trimmed.startsWith('/') || normalizedRaw === '/history' || normalizedRaw.startsWith('/history/')
            ? normalizedRaw
            : normalizeVfsPath(`/history/${trimmed}`);

    if (!candidate.startsWith('/history/') || candidate === '/history/') {
        throw new VfsError(
            `History path must reside inside /history/: "${rawChunk}"`,
            'EINVAL',
            candidate,
        );
    }

    return candidate;
}

function formatHistoryError(error: unknown, signal?: AbortSignal): string {
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

async function grepHistoryFallback(
    ctx: ToolExecutionContext,
    query: string,
    caseSensitive: boolean,
    limit: number,
    contextLines?: number,
    maxMatchesPerFile?: number,
): Promise<VfsSearchHit[]> {
    const files = await ctx.fs.glob('/history/**');
    const hits: VfsSearchHit[] = [];

    for (const filePath of files) {
        throwIfAborted(ctx.signal);
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
            regex: false,
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

const SEARCH_HISTORY_SCHEMA = z.object({
    query: z
        .string()
        .describe('Keywords or phrase to search across compacted /history/* conversation chunks. Empty string lists available chunks.'),
    mode: z
        .enum(['fuzzy', 'grep'])
        .optional()
        .default('fuzzy')
        .describe('fuzzy = ranked search across /history/*; grep = exact literal line match.'),
    case_sensitive: z
        .boolean()
        .optional()
        .default(false)
        .describe('Case sensitivity when mode is "grep".'),
    context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(2)
        .describe('Surrounding lines per hit when mode is "grep" (0-10, default 2).'),
    max_matches_per_file: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Optional max matches per chunk file when mode is "grep".'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe('Maximum number of matching hits to return (1-100).'),
});

const READ_HISTORY_SCHEMA = z.object({
    chunk: z
        .string()
        .min(1)
        .describe('Archived history file inside /history/, e.g. "/history/chunk-001.md", "chunk-001.md", or "summary.md".'),
    start_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional 1-based inclusive start line.'),
    end_line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional 1-based inclusive end line.'),
    line_numbers: z
        .boolean()
        .optional()
        .default(true)
        .describe('Include 1-based "N| " line-number prefixes (default true).'),
    char_offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Optional 0-based character offset within very long lines.'),
    char_limit: z
        .number()
        .int()
        .min(200)
        .max(20_000)
        .optional()
        .describe('Optional max characters per line (200-20000, default 4000).'),
});

/** Create built-in `search_history` and `read_history` tools for `/history/*` archives. */
export function createHistoryTools(): ToolDefinition[] {
    const searchHistoryTool: ToolDefinition<typeof SEARCH_HISTORY_SCHEMA> = {
        name: 'search_history',
        description:
            'Search compacted conversation archive chunks and summaries stored under /history/*. Use read_history afterwards to inspect a specific chunk.',
        parameters: SEARCH_HISTORY_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                let results: VfsSearchHit[];
                if (args.mode === 'grep' && args.query.trim().length > 0) {
                    const scoped = ctx.fs as ToolExecutionContext['fs'] & {
                        grep?: ScopedToolGuard['grep'];
                    };
                    results =
                        typeof scoped.grep === 'function'
                            ? await scoped.grep(args.query, {
                                pathPrefix: '/history',
                                caseSensitive: args.case_sensitive,
                                limit: args.limit,
                                contextLines: args.context_lines,
                                maxMatchesPerFile: args.max_matches_per_file,
                            })
                            : await grepHistoryFallback(
                                ctx,
                                args.query,
                                args.case_sensitive,
                                args.limit,
                                args.context_lines,
                                args.max_matches_per_file,
                            );
                } else {
                    results = await ctx.fs.search(args.query, {
                        pathPrefix: '/history',
                        limit: args.limit,
                    });
                }

                return JSON.stringify({
                    ok: true,
                    query: args.query,
                    mode: args.mode,
                    total: results.length,
                    results,
                });
            } catch (error) {
                return formatHistoryError(error, ctx.signal);
            }
        },
    };

    const readHistoryTool: ToolDefinition<typeof READ_HISTORY_SCHEMA> = {
        name: 'read_history',
        description:
            'Read an archived conversation chunk or summary file from /history/* (e.g. "chunk-001.md" or "/history/summary.md") with 1-based line numbers and soft pagination.',
        parameters: READ_HISTORY_SCHEMA,
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
                const targetPath = resolveHistoryPath(args.chunk);
                const rawContent = await ctx.fs.read(targetPath);
                return formatFileReadResult({
                    path: targetPath,
                    rawContent,
                    startLine: args.start_line,
                    endLine: args.end_line,
                    lineNumbers: args.line_numbers,
                    charOffset: args.char_offset,
                    charLimit: args.char_limit,
                }).text;
            } catch (error) {
                return formatHistoryError(error, ctx.signal);
            }
        },
    };

    return [searchHistoryTool, readHistoryTool];
}
