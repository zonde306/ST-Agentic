import { z } from 'zod';
import type { ToolExecutionContext } from '@/core/bridge';
import type { VfsSearchHit } from '@/core/types';
import { normalizeVfsPath } from '@/core/utils';
import { ScopedToolGuard, VfsError, sliceLines } from '@/core/vfs';
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

function supportsReadRangeOptions(fs: ToolExecutionContext['fs']): boolean {
    if (fs instanceof ScopedToolGuard) {
        return true;
    }
    return Boolean((fs as { supportsReadOptions?: boolean }).supportsReadOptions);
}

async function grepHistoryFallback(
    ctx: ToolExecutionContext,
    query: string,
    caseSensitive: boolean,
    limit: number,
): Promise<VfsSearchHit[]> {
    const files = await ctx.fs.glob('/history/**');
    const needle = caseSensitive ? query : query.toLowerCase();
    const hits: VfsSearchHit[] = [];

    for (const filePath of files) {
        throwIfAborted(ctx.signal);
        let content: string;
        try {
            content = await ctx.fs.read(filePath);
        } catch {
            continue;
        }
        const lines = content.split('\n');
        for (let idx = 0; idx < lines.length; idx += 1) {
            const line = lines[idx];
            const haystack = caseSensitive ? line : line.toLowerCase();
            if (haystack.includes(needle)) {
                hits.push({
                    path: filePath,
                    score: 1,
                    line: idx + 1,
                    snippet: line.trim().slice(0, 160),
                });
                if (hits.length >= limit) {
                    return hits;
                }
            }
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
                            })
                            : await grepHistoryFallback(ctx, args.query, args.case_sensitive, args.limit);
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
            'Read an archived conversation chunk or summary file from /history/* (e.g. "chunk-001.md" or "/history/summary.md").',
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
                const hasRange = args.start_line !== undefined || args.end_line !== undefined;

                if (hasRange && supportsReadRangeOptions(ctx.fs)) {
                    return await (ctx.fs as ScopedToolGuard).read(targetPath, {
                        startLine: args.start_line,
                        endLine: args.end_line,
                    });
                }

                const raw = await ctx.fs.read(targetPath);
                return hasRange ? sliceLines(raw, args.start_line, args.end_line) : raw;
            } catch (error) {
                return formatHistoryError(error, ctx.signal);
            }
        },
    };

    return [searchHistoryTool, readHistoryTool];
}
