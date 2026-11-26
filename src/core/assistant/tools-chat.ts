import { z } from 'zod';
import type { HostBridge } from '@/core/bridge';
import { DEFAULT_MAIN_AGENT_ID, resolveActivePreset, resolveConnection } from '@/core/config';
import {
    applyToolOutputGate,
    DEFAULT_MAX_TOOL_RESULT_BYTES,
    estimateRequestTokens,
    isSpillPath,
    utf8ByteLength,
    type TrajectoryStore,
    type TransientToolSpillStore,
} from '@/core/context';
import type { TraceLogger } from '@/core/logger';
import type { ChatDataStore } from '@/core/store';
import {
    formatValidationError,
    formatZodIssues,
    schemaToCanonicalJsonSchema,
    VfsVarsAdapter,
    type DynamicVariableSchema,
} from '@/core/tools';
import type {
    AssistantMode,
    CanonicalToolSchema,
    DiffLine,
    MessageTarget,
    RawLoreEntry,
    Settings,
    VariableScope,
} from '@/core/types';
import { canonicalClone, normalizeVfsPath, stripJsonSchemaMeta } from '@/core/utils';
import {
    formatFileReadResult,
    scopeToVariablesPath,
    VfsError,
    type VirtualFileSystem,
} from '@/core/vfs';
import { redactString, redactWithReport } from './redact';
import type { UndoStore } from './undo-store';

export type AssistantToolTier = 'chat' | 'adjust' | 'author' | 'full' | 'admin';

export interface AssistantToolContext {
    sessionId: string;
    toolCallId: string;
    mode: AssistantMode;
    stAdminEnabled: boolean;
    bridge: HostBridge;
    store: ChatDataStore;
    vfs: VirtualFileSystem;
    undoStore: UndoStore;
    trajectoryStore?: TrajectoryStore;
    traceLogger?: TraceLogger;
    settings?: Settings;
    getLatestSettings?: () => Settings;
    updateSettings?: (updater: (prev: Settings) => Settings) => Promise<Settings> | Settings;
    target: MessageTarget;
    signal: AbortSignal;
    getVariableSchema?: () => DynamicVariableSchema | undefined;
    captureUndo?: boolean;
    getStatusSnapshot?: () => Record<string, unknown>;
    spillStore?: TransientToolSpillStore;
    maxToolResultBytes?: number;
}

export interface AssistantApprovalPreview {
    title: string;
    summary: string;
    targetLabel: string;
    beforeText: string;
    afterText: string;
    rawContent: string;
    diffLines: DiffLine[];
    warnings?: string[];
}

export interface AssistantToolOutputGateConfig {
    toolName: string;
    toolCallId: string;
    maxBytes?: number;
    spillStore?: TransientToolSpillStore;
    scopeId?: string;
}

export interface AssistantToolResult {
    ok: boolean;
    output: string;
    data?: unknown;
    error?: string;
    hasSecretRedaction: boolean;
    redactionCount: number;
    undoId?: string;
    warnings?: string[];
    fileRefs?: string[];
    truncated?: boolean;
    spillPath?: string;
}

export interface AssistantToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    description: string;
    parameters: TParams;
    tier: AssistantToolTier;
    readOnly: boolean;
    preview?: (
        args: z.infer<TParams>,
        ctx: AssistantToolContext,
    ) => Promise<AssistantApprovalPreview> | AssistantApprovalPreview;
    execute: (
        args: z.infer<TParams>,
        ctx: AssistantToolContext,
    ) => Promise<AssistantToolResult> | AssistantToolResult;
}

export function createAssistantAbortError(message: string = 'Assistant operation aborted'): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

export function isAssistantAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    return (error as { name?: string }).name === 'AbortError';
}

export function throwIfAssistantAborted(signal?: AbortSignal, message?: string): void {
    if (signal?.aborted) {
        throw createAssistantAbortError(message);
    }
}

export function truncateSummary(text: string, maxChars: number = 160): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxChars) {
        return clean;
    }
    return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export function finalizeReadToolResult(
    payload: unknown,
    extras?: {
        fileRefs?: string[];
        warnings?: string[];
        gate?: AssistantToolOutputGateConfig;
    },
): AssistantToolResult {
    if (typeof payload === 'string') {
        const report = redactString(payload);
        const gated = extras?.gate
            ? applyToolOutputGate(report.value, {
                toolName: extras.gate.toolName,
                toolCallId: extras.gate.toolCallId,
                maxBytes: extras.gate.maxBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
                spillStore: extras.gate.spillStore,
                scopeId: extras.gate.scopeId,
            })
            : null;
        const finalOutput = gated ? gated.output : report.value;
        return {
            ok: true,
            output: finalOutput,
            data: finalOutput,
            hasSecretRedaction: report.hasSecretRedaction,
            redactionCount: report.redactionCount,
            ...(extras?.fileRefs?.length ? { fileRefs: [...extras.fileRefs] } : {}),
            ...(extras?.warnings?.length ? { warnings: [...extras.warnings] } : {}),
            ...(gated?.truncated ? { truncated: true } : {}),
            ...(gated?.spillPath ? { spillPath: gated.spillPath } : {}),
        };
    }

    const report = redactWithReport(payload);
    const serialized = JSON.stringify(report.value);
    const gated = extras?.gate
        ? applyToolOutputGate(serialized, {
            toolName: extras.gate.toolName,
            toolCallId: extras.gate.toolCallId,
            maxBytes: extras.gate.maxBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
            rawData: report.value,
            spillStore: extras.gate.spillStore,
            scopeId: extras.gate.scopeId,
        })
        : null;
    return {
        ok: true,
        output: gated ? gated.output : serialized,
        data: report.value,
        hasSecretRedaction: report.hasSecretRedaction,
        redactionCount: report.redactionCount,
        ...(extras?.fileRefs?.length ? { fileRefs: [...extras.fileRefs] } : {}),
        ...(extras?.warnings?.length ? { warnings: [...extras.warnings] } : {}),
        ...(gated?.truncated ? { truncated: true } : {}),
        ...(gated?.spillPath ? { spillPath: gated.spillPath } : {}),
    };
}

export function finalizeMutationToolResult(
    payload: Record<string, unknown>,
    extras?: {
        undoId?: string;
        warnings?: string[];
        fileRefs?: string[];
        gate?: AssistantToolOutputGateConfig;
    },
): AssistantToolResult {
    const combined: Record<string, unknown> = {
        ok: true,
        ...payload,
        ...(extras?.undoId ? { undoId: extras.undoId } : {}),
        ...(extras?.warnings?.length ? { warnings: extras.warnings } : {}),
    };
    const report = redactWithReport(combined);
    const serialized = JSON.stringify(report.value);
    const gated = extras?.gate
        ? applyToolOutputGate(serialized, {
            toolName: extras.gate.toolName,
            toolCallId: extras.gate.toolCallId,
            maxBytes: extras.gate.maxBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
            rawData: report.value,
            spillStore: extras.gate.spillStore,
            scopeId: extras.gate.scopeId,
        })
        : null;
    return {
        ok: true,
        output: gated ? gated.output : serialized,
        data: report.value,
        hasSecretRedaction: report.hasSecretRedaction,
        redactionCount: report.redactionCount,
        ...(extras?.undoId ? { undoId: extras.undoId } : {}),
        ...(extras?.warnings?.length ? { warnings: [...extras.warnings] } : {}),
        ...(extras?.fileRefs?.length ? { fileRefs: [...extras.fileRefs] } : {}),
        ...(gated?.truncated ? { truncated: true } : {}),
        ...(gated?.spillPath ? { spillPath: gated.spillPath } : {}),
    };
}

export function finalizeToolError(
    error: unknown,
    signal?: AbortSignal,
    extra?: Record<string, unknown>,
): AssistantToolResult {
    if (isAssistantAbortError(error) || signal?.aborted) {
        if (error instanceof Error && isAssistantAbortError(error)) {
            throw error;
        }
        throw createAssistantAbortError();
    }

    const rawMessage = error instanceof Error ? error.message : String(error);
    const payload: Record<string, unknown> = {
        ok: false,
        error: rawMessage,
        ...(error instanceof VfsError ? { code: error.code, path: error.path } : {}),
        ...(extra ?? {}),
    };
    const report = redactWithReport(payload);
    const redactedObj = report.value as Record<string, unknown>;
    return {
        ok: false,
        output: JSON.stringify(redactedObj),
        data: redactedObj,
        error: String(redactedObj.error ?? rawMessage),
        hasSecretRedaction: report.hasSecretRedaction,
        redactionCount: report.redactionCount,
    };
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Compile assistant tool definitions into deterministically sorted `CanonicalToolSchema[]`
 * for Layer 0 Prefix KV Cache invariance.
 */
export function toCanonicalAssistantToolSchemas(
    tools: readonly AssistantToolDefinition[],
): CanonicalToolSchema[] {
    const sorted = [...tools].sort((a, b) => compareCodeUnits(a.name, b.name));
    return sorted.map((tool) =>
        canonicalClone({
            name: tool.name,
            description: tool.description,
            parameters: schemaToCanonicalJsonSchema(tool.parameters),
        }),
    );
}

/**
 * Validate raw arguments with Zod v4 and execute an `AssistantToolDefinition`.
 * Propagates `AbortError` when `ctx.signal` is aborted; returns structured redacted errors otherwise.
 * Enforces post-redaction `applyToolOutputGate` centrally so every tool (built-in & extraTools)
 * stays within `ctx.maxToolResultBytes` (default 32 KB) and never spills unredacted secrets.
 */
export async function executeAssistantTool(
    tool: AssistantToolDefinition,
    rawArgs: Record<string, unknown>,
    ctx: AssistantToolContext,
): Promise<AssistantToolResult> {
    throwIfAssistantAborted(ctx.signal);

    const validated = tool.parameters.safeParse(rawArgs ?? {});
    if (!validated.success) {
        const issues = formatZodIssues(validated.error);
        const error = formatValidationError(`tool "${tool.name}"`, validated.error);
        return finalizeToolError(error, ctx.signal, { issues });
    }

    try {
        const result = await tool.execute(validated.data, ctx);
        throwIfAssistantAborted(ctx.signal);

        // Ensure secrets are ALWAYS redacted before touching spillStore or output gate,
        // even for custom extraTools that construct AssistantToolResult directly.
        const outputRedaction = redactString(result.output);
        const safeOutput = outputRedaction.value;
        const hasSecretRedaction = result.hasSecretRedaction || outputRedaction.hasSecretRedaction;
        const redactionCount = result.redactionCount + outputRedaction.redactionCount;

        const maxBytes = ctx.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
        if (result.truncated && utf8ByteLength(safeOutput) <= maxBytes) {
            return {
                ...result,
                output: safeOutput,
                hasSecretRedaction,
                redactionCount,
            };
        }

        const safeRawData =
            !outputRedaction.hasSecretRedaction
            && result.data !== undefined
            && result.data !== null
            && typeof result.data === 'object'
                ? result.data
                : undefined;

        const gated = applyToolOutputGate(safeOutput, {
            toolName: tool.name,
            toolCallId: ctx.toolCallId,
            maxBytes,
            rawData: safeRawData,
            spillStore: ctx.spillStore,
            scopeId: ctx.sessionId,
        });

        if (!gated.truncated) {
            return {
                ...result,
                output: safeOutput,
                hasSecretRedaction,
                redactionCount,
            };
        }

        return {
            ...result,
            output: gated.output,
            hasSecretRedaction,
            redactionCount,
            truncated: true,
            ...(gated.spillPath ? { spillPath: gated.spillPath } : {}),
        };
    } catch (error) {
        return finalizeToolError(error, ctx.signal);
    }
}

const DATA_URI_BASE64_RE =
    /(data:[a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+(?:;[a-zA-Z0-9_=.-]+)*;base64,)([A-Za-z0-9+/=]{512,})/g;
const QUOTED_LARGE_BASE64_RE = /(['"`])([A-Za-z0-9+/=]{4096,})\1/g;

/**
 * Fold oversized inline Base64 data URIs or bare quoted blobs without changing `\n`
 * line counts, keeping 1-based line numbers aligned with raw source text.
 */
export function foldInlineBase64(text: string): {
    text: string;
    count: number;
    bytes: number;
} {
    if (!text) {
        return { text: '', count: 0, bytes: 0 };
    }
    let count = 0;
    let bytes = 0;
    let out = text.replace(DATA_URI_BASE64_RE, (_full, prefix: string, payload: string) => {
        count += 1;
        bytes += utf8ByteLength(payload);
        return `${prefix}[BASE64_OMITTED:${payload.length}chars]`;
    });
    out = out.replace(QUOTED_LARGE_BASE64_RE, (_full, quote: string, payload: string) => {
        count += 1;
        bytes += utf8ByteLength(payload);
        return `${quote}[BASE64_OMITTED:${payload.length}chars]${quote}`;
    });
    return { text: out, count, bytes };
}

/**
 * Replace `formatFileReadResult`'s default `read_file` footer hint with a
 * tool-specific continuation instruction.
 */
export function rewriteReadFooterHint(formattedText: string, customInstruction: string): string {
    return formattedText.replace(
        /\[\.\.\. (\d+) more line\(s\) omitted\. Use read_file\([^\]]*\]$/,
        (_match, countStr: string) => `[... ${countStr} more line(s) omitted. ${customInstruction}]`,
    );
}

function normalizeDirectoryInput(rawPath: string | undefined): string {
    const trimmed = (rawPath ?? '/').trim();
    if (!trimmed || trimmed === '.') {
        return '/';
    }
    return normalizeVfsPath(trimmed);
}

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

// ============================================================================
// Zod Parameter Schemas for `chat` Read-Only Base Tools (12 tools)
// ============================================================================

const LIST_DIR_SCHEMA = z.object({
    path: z
        .string()
        .optional()
        .default('/')
        .describe(
            'VFS directory path to list. "/" lists workspace root and mounts (/character, /persona, /lorebooks, /skills, /preset, /state, /global, /history, /side).',
        ),
});

const GLOB_FILES_SCHEMA = z.object({
    pattern: z.string().min(1).describe('Glob pattern to match VFS paths, e.g. "/side/**/*.md".'),
    limit: z.number().int().min(1).max(500).optional().default(100),
});

const GREP_SEARCH_SCHEMA = z.object({
    query: z.string().min(1).describe('Literal substring or regex to match line-by-line.'),
    path_prefix: z
        .string()
        .optional()
        .default('/')
        .describe(
            'Optional directory prefix, exact single VFS file path, or /tmp/tool-spill/* path.',
        ),
    case_sensitive: z.boolean().optional().default(true),
    regex: z.boolean().optional().default(false),
    context_lines: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .default(2)
        .describe('Number of surrounding lines before and after each hit (0-10, default 2).'),
    max_matches_per_file: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('Optional max matches returned per file.'),
    limit: z.number().int().min(1).max(200).optional().default(50),
});

const SEARCH_FILES_SCHEMA = z.object({
    query: z.string().describe('Keywords or natural language query for ranked BM25/fuzzy search.'),
    path_prefix: z.string().optional().default('/'),
    limit: z.number().int().min(1).max(100).optional().default(25),
});

const READ_FILE_SCHEMA = z.object({
    path: z.string().min(1).describe('VFS file path or /tmp/tool-spill/* spilled output path.'),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
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

const READ_VARIABLES_SCHEMA = z.object({
    path: z
        .string()
        .optional()
        .describe('Optional dot-notation or JSON Pointer path (e.g. "player.hp" or "/stats/gold").'),
    scope: z
        .enum(['message', 'chat', 'global'])
        .optional()
        .default('message')
        .describe(
            'Variable scope: "message" (default, /state/variables.json), "chat" (/state/chat_variables.json), or "global" (/state/global_variables.json).',
        ),
    include_schema: z.boolean().optional().default(false),
    default_value: z.unknown().optional(),
});

const SEARCH_HISTORY_SCHEMA = z.object({
    query: z.string().describe('Keywords or phrase to search across /history/* archive chunks.'),
    mode: z.enum(['fuzzy', 'grep']).optional().default('fuzzy'),
    case_sensitive: z.boolean().optional().default(false),
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
    limit: z.number().int().min(1).max(100).optional().default(20),
});

const READ_HISTORY_SCHEMA = z.object({
    chunk: z
        .string()
        .min(1)
        .describe('History file inside /history/, e.g. "chunk-001.md" or "/history/summary.md".'),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
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

const AGENTIC_READ_STATUS_SCHEMA = z.object({});

const AGENTIC_READ_TRACES_SCHEMA = z.object({
    messageId: z.number().int().min(0).optional(),
    swipeId: z.number().int().min(0).optional(),
    phase: z.enum(['before_turn', 'main_turn', 'after_turn', 'maintenance']).optional(),
    agentProfileId: z.string().optional(),
    status: z.enum(['running', 'completed', 'error', 'aborted', 'interrupted']).optional(),
    runId: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional().default(20),
});

const CARD_READ_ACTIVE_SCHEMA = z.object({});

const WI_READ_ENABLED_MAX_CONTENT_BYTES = 24 * 1024;

const WI_READ_ENABLED_SCHEMA = z.object({
    bookName: z.string().optional().describe('Optional enabled World Info book name filter.'),
    query: z.string().optional().describe('Optional keyword/content substring filter.'),
    includeContent: z
        .boolean()
        .optional()
        .default(true)
        .describe(
            'Include entry content when filtered and total matched content is <= 24 KB; automatically degrades to a catalog summary when unfiltered or > 24 KB.',
        ),
    limit: z.number().int().min(1).max(500).optional().default(200),
});

function summarizeLoreEntry(entry: RawLoreEntry, includeContent: boolean): Record<string, unknown> {
    const content = entry.content ?? '';
    return {
        world: entry.world,
        uid: entry.uid,
        comment: entry.comment,
        keys: [...(entry.keys ?? [])],
        keysecondary: [...(entry.keysecondary ?? [])],
        constant: Boolean(entry.constant),
        selective: Boolean(entry.selective),
        disable: Boolean(entry.disable),
        position: entry.position,
        depth: entry.depth,
        order: entry.order,
        role: entry.role,
        contentLength: content.length,
        ...(includeContent ? { content } : {}),
    };
}

/**
 * Create the 12 read-only base tools (`CHAT_READONLY_TOOLS`) inherited by all
 * four assistant modes. Every output passes through `redactWithReport` / `redactString`.
 */
export function createChatReadOnlyTools(): AssistantToolDefinition[] {
    const listDirTool: AssistantToolDefinition<typeof LIST_DIR_SCHEMA> = {
        name: 'list_dir',
        description:
            'List files and subdirectories in the Virtual File System (VFS). Read-only.',
        parameters: LIST_DIR_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const dirPath = normalizeDirectoryInput(args.path);
            const entries = await ctx.vfs.listDir(dirPath, { target: ctx.target, staged: false });
            return finalizeReadToolResult({ ok: true, path: dirPath, entries });
        },
    };

    const globFilesTool: AssistantToolDefinition<typeof GLOB_FILES_SCHEMA> = {
        name: 'glob_files',
        description: 'Match VFS file paths against a glob pattern. Read-only.',
        parameters: GLOB_FILES_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const matched = await ctx.vfs.globFiles(args.pattern, { target: ctx.target, staged: false });
            return finalizeReadToolResult({
                ok: true,
                pattern: args.pattern,
                total: matched.length,
                results: matched.slice(0, args.limit),
            });
        },
    };

    const grepSearchTool: AssistantToolDefinition<typeof GREP_SEARCH_SCHEMA> = {
        name: 'grep_search',
        description:
            'Search VFS files (or /tmp/tool-spill/* transient spilled tool outputs) line-by-line for a literal string or regex. Read-only.',
        parameters: GREP_SEARCH_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const rawPrefix = (args.path_prefix ?? '/').trim();
            if (isSpillPath(rawPrefix)) {
                const pathPrefix = normalizeDirectoryInput(rawPrefix);
                if (!ctx.spillStore) {
                    return finalizeToolError(
                        `Spill path not found or expired: "${pathPrefix}" (no active spill store).`,
                        ctx.signal,
                    );
                }
                if (pathPrefix !== '/tmp/tool-spill') {
                    const hasExact = ctx.spillStore.get(pathPrefix) !== null;
                    const prefixWithSlash = `${pathPrefix}/`;
                    const hasPrefix = ctx.spillStore
                        .listPaths()
                        .some((p) => p.startsWith(prefixWithSlash));
                    if (!hasExact && !hasPrefix) {
                        return finalizeToolError(
                            `Spill entry not found or expired: "${pathPrefix}". It may have been evicted or cleared.`,
                            ctx.signal,
                        );
                    }
                }
                const hits = ctx.spillStore.grep(pathPrefix, args.query, {
                    caseSensitive: args.case_sensitive,
                    regex: args.regex,
                    limit: args.limit,
                    contextLines: args.context_lines,
                    maxMatchesPerFile: args.max_matches_per_file,
                });
                return finalizeReadToolResult({
                    ok: true,
                    query: args.query,
                    pathPrefix,
                    total: hits.length,
                    results: hits,
                });
            }

            const pathPrefix = normalizeDirectoryInput(args.path_prefix);
            const hits = await ctx.vfs.grepSearch(args.query, {
                pathPrefix,
                caseSensitive: args.case_sensitive,
                regex: args.regex,
                limit: args.limit,
                contextLines: args.context_lines,
                maxMatchesPerFile: args.max_matches_per_file,
                target: ctx.target,
                staged: false,
            });
            return finalizeReadToolResult({
                ok: true,
                query: args.query,
                pathPrefix,
                total: hits.length,
                results: hits,
            });
        },
    };

    const searchFilesTool: AssistantToolDefinition<typeof SEARCH_FILES_SCHEMA> = {
        name: 'search_files',
        description:
            'Ranked full-text and fuzzy search across VFS files (returns 1-based line, totalLines, matchedIn, and snippet). Read-only.',
        parameters: SEARCH_FILES_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const pathPrefix = normalizeDirectoryInput(args.path_prefix);
            const hits = await ctx.vfs.searchFiles(args.query, {
                pathPrefix,
                limit: args.limit,
                target: ctx.target,
                staged: false,
            });
            return finalizeReadToolResult({
                ok: true,
                query: args.query,
                pathPrefix,
                total: hits.length,
                results: hits,
            });
        },
    };

    const readFileTool: AssistantToolDefinition<typeof READ_FILE_SCHEMA> = {
        name: 'read_file',
        description:
            'Read a VFS file or /tmp/tool-spill/* spilled tool output with 1-based "N| " line prefixes and metadata header. Soft-paginates at 200 lines / 24 KB; pass start_line/end_line or char_offset/char_limit to page. Returns macro/EJS-evaluated template content in chat (read-only) mode and raw source verbatim in edit-capable modes (adjust/author/full). Read-only.',
        parameters: READ_FILE_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (
                args.start_line !== undefined
                && args.end_line !== undefined
                && args.start_line > args.end_line
            ) {
                return finalizeToolError(
                    `Invalid line range: start_line (${args.start_line}) must be <= end_line (${args.end_line}).`,
                    ctx.signal,
                );
            }
            const normalizedPath = normalizeVfsPath(args.path);
            if (isSpillPath(args.path)) {
                if (!ctx.spillStore) {
                    return finalizeToolError(
                        `Spill entry not found or expired: "${normalizedPath}" (no active spill store).`,
                        ctx.signal,
                    );
                }
                const entry = ctx.spillStore.get(normalizedPath);
                if (!entry) {
                    return finalizeToolError(
                        `Spill entry not found or expired: "${normalizedPath}". It may have been evicted or cleared.`,
                        ctx.signal,
                    );
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
                const res = finalizeReadToolResult(formatted.text, { fileRefs: [normalizedPath] });
                return formatted.truncated ? { ...res, truncated: true } : res;
            }

            const raw = ctx.mode !== 'chat';
            const rawContent = await ctx.vfs.readFile(normalizedPath, {
                target: ctx.target,
                staged: false,
                raw,
            });
            const formatted = formatFileReadResult({
                path: normalizedPath,
                rawContent,
                startLine: args.start_line,
                endLine: args.end_line,
                lineNumbers: args.line_numbers,
                charOffset: args.char_offset,
                charLimit: args.char_limit,
            });
            const res = finalizeReadToolResult(formatted.text, { fileRefs: [normalizedPath] });
            return formatted.truncated ? { ...res, truncated: true } : res;
        },
    };

    const readVariablesTool: AssistantToolDefinition<typeof READ_VARIABLES_SCHEMA> = {
        name: 'read_variables',
        description:
            'Read variables from SillyTavern native storage (/state/variables.json for message branch, /state/chat_variables.json for chat, /state/global_variables.json for global). Read-only.',
        parameters: READ_VARIABLES_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const scope: VariableScope = args.scope ?? 'message';
            const filePath = scopeToVariablesPath(scope);
            const varsAdapter = new VfsVarsAdapter(ctx.vfs, {
                target: ctx.target,
                staged: false,
                signal: ctx.signal,
                getSchema: ctx.getVariableSchema,
            });
            const value = await varsAdapter.get(args.path, { scope });
            const resolvedValue = value === undefined ? args.default_value : value;
            const response: Record<string, unknown> = {
                ok: true,
                scope,
                path: args.path ?? '',
                exists: value !== undefined,
                value: resolvedValue ?? null,
                target: ctx.target,
            };

            if (args.include_schema && scope === 'message') {
                const rawSchema = ctx.getVariableSchema?.();
                if (rawSchema) {
                    if (typeof rawSchema === 'string') {
                        response.schema = rawSchema;
                    } else if (typeof (rawSchema as z.ZodTypeAny).safeParse === 'function') {
                        response.schema = stripJsonSchemaMeta(
                            z.toJSONSchema(rawSchema as z.ZodTypeAny, {
                                io: 'input',
                                unrepresentable: 'any',
                            }),
                        );
                    } else {
                        response.schema = stripJsonSchemaMeta(rawSchema);
                    }
                }
            }

            return finalizeReadToolResult(response, { fileRefs: [filePath] });
        },
    };

    const searchHistoryTool: AssistantToolDefinition<typeof SEARCH_HISTORY_SCHEMA> = {
        name: 'search_history',
        description: 'Search archived conversation chunks under /history/*. Read-only.',
        parameters: SEARCH_HISTORY_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const results =
                args.mode === 'grep' && args.query.trim().length > 0
                    ? await ctx.vfs.grepSearch(args.query, {
                        pathPrefix: '/history',
                        caseSensitive: args.case_sensitive,
                        limit: args.limit,
                        contextLines: args.context_lines,
                        maxMatchesPerFile: args.max_matches_per_file,
                        target: ctx.target,
                        staged: false,
                    })
                    : await ctx.vfs.searchFiles(args.query, {
                        pathPrefix: '/history',
                        limit: args.limit,
                        target: ctx.target,
                        staged: false,
                    });
            return finalizeReadToolResult({
                ok: true,
                query: args.query,
                mode: args.mode,
                total: results.length,
                results,
            });
        },
    };

    const readHistoryTool: AssistantToolDefinition<typeof READ_HISTORY_SCHEMA> = {
        name: 'read_history',
        description:
            'Read a compacted conversation chunk or summary from /history/* with 1-based line numbers and soft pagination. Read-only.',
        parameters: READ_HISTORY_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (
                args.start_line !== undefined
                && args.end_line !== undefined
                && args.start_line > args.end_line
            ) {
                return finalizeToolError(
                    `Invalid line range: start_line (${args.start_line}) must be <= end_line (${args.end_line}).`,
                    ctx.signal,
                );
            }
            const targetPath = resolveHistoryPath(args.chunk);
            const rawContent = await ctx.vfs.readFile(targetPath, {
                target: ctx.target,
                staged: false,
            });
            const formatted = formatFileReadResult({
                path: targetPath,
                rawContent,
                startLine: args.start_line,
                endLine: args.end_line,
                lineNumbers: args.line_numbers,
                charOffset: args.char_offset,
                charLimit: args.char_limit,
            });
            const res = finalizeReadToolResult(formatted.text, { fileRefs: [targetPath] });
            return formatted.truncated ? { ...res, truncated: true } : res;
        },
    };

    const agenticReadStatusTool: AssistantToolDefinition<typeof AGENTIC_READ_STATUS_SCHEMA> = {
        name: 'agentic_read_status',
        description:
            'Inspect ST-Agentic runtime status: runMode, active preset, connection model, mainline watermark, cache hit rate, and causal branch coordinate. Read-only.',
        parameters: AGENTIC_READ_STATUS_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const chat = ctx.bridge.getChat();
            const identity = ctx.bridge.getActiveIdentity();
            const activePreset = ctx.settings ? resolveActivePreset(ctx.settings) : undefined;
            const activeConnection = ctx.settings ? resolveConnection(ctx.settings) : undefined;

            const mainMessages = ctx.trajectoryStore?.getMessages(DEFAULT_MAIN_AGENT_ID) ?? [];
            const mainPrefix = ctx.trajectoryStore?.getFrozenPrefix(DEFAULT_MAIN_AGENT_ID);
            const mainEstimatedTokens = ctx.trajectoryStore
                ? estimateRequestTokens(
                    [...(mainPrefix?.messages ?? []), ...mainMessages],
                    mainPrefix?.tools ?? [],
                )
                : 0;
            const mainWatermark = activePreset?.agents?.[DEFAULT_MAIN_AGENT_ID]?.watermark ?? {
                high: 32000,
                low: 16000,
            };

            const recentTraces = ctx.traceLogger?.listTraces({ limit: 20 }) ?? [];
            let totalInput = 0;
            let totalCached = 0;
            for (const trace of recentTraces) {
                totalInput += trace.usage?.inputTokens ?? 0;
                totalCached += trace.usage?.cachedTokens ?? 0;
            }
            const cacheHitRate =
                totalInput > 0 ? `${((totalCached / totalInput) * 100).toFixed(1)}%` : '0.0%';

            const statusPayload: Record<string, unknown> = {
                ok: true,
                runMode: ctx.settings?.runMode ?? 'takeover',
                themeMode: ctx.settings?.themeMode ?? 'dark',
                activePreset: activePreset
                    ? { id: activePreset.id, name: activePreset.name }
                    : null,
                activeConnection: activeConnection
                    ? {
                        id: activeConnection.id,
                        name: activeConnection.name,
                        providerFormat: activeConnection.providerFormat,
                        model: activeConnection.model,
                        baseUrl: activeConnection.baseUrl,
                    }
                    : null,
                target: ctx.target,
                chatLength: chat.length,
                identity,
                mainline: {
                    messageCount: mainMessages.length,
                    estimatedTokens: mainEstimatedTokens,
                    watermark: mainWatermark,
                    archivedUpToChunk:
                        ctx.trajectoryStore?.getArchivedUpToChunk(DEFAULT_MAIN_AGENT_ID) ?? 0,
                    readSetSize:
                        ctx.trajectoryStore?.getReadSet(DEFAULT_MAIN_AGENT_ID).size ?? 0,
                },
                cacheHitRate,
                recentTraceCount: recentTraces.length,
                assistantSession: {
                    sessionId: ctx.sessionId,
                    mode: ctx.mode,
                    stAdminEnabled: ctx.stAdminEnabled,
                },
                ...(ctx.getStatusSnapshot ? ctx.getStatusSnapshot() : {}),
            };

            return finalizeReadToolResult(statusPayload);
        },
    };

    const agenticReadTracesTool: AssistantToolDefinition<typeof AGENTIC_READ_TRACES_SCHEMA> = {
        name: 'agentic_read_traces',
        description:
            'Read recent ST-Agentic execution traces and tool logs (automatically redacted). Read-only.',
        parameters: AGENTIC_READ_TRACES_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const traces = ctx.traceLogger
                ? ctx.traceLogger.listTraces({
                    messageId: args.messageId,
                    swipeId: args.swipeId,
                    phase: args.phase,
                    agentProfileId: args.agentProfileId,
                    status: args.status,
                    runId: args.runId,
                    limit: args.limit,
                })
                : [];
            return finalizeReadToolResult({
                ok: true,
                total: traces.length,
                traces,
            });
        },
    };

    const cardReadActiveTool: AssistantToolDefinition<typeof CARD_READ_ACTIVE_SCHEMA> = {
        name: 'card_read_active',
        description:
            'Read a read-only snapshot of the currently active character card fields and extensions. Read-only.',
        parameters: CARD_READ_ACTIVE_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (ctx.bridge.author) {
                const active = await ctx.bridge.author.getActiveCharacterFull();
                if (active) {
                    return finalizeReadToolResult({
                        ok: true,
                        character: active,
                    });
                }
            }
            const identity = ctx.bridge.getActiveIdentity();
            const fields = ctx.bridge.getCharacterFields();
            return finalizeReadToolResult({
                ok: true,
                character: {
                    name: identity.charName,
                    avatar: identity.characterAvatar,
                    ...fields,
                },
            });
        },
    };

    const wiReadEnabledTool: AssistantToolDefinition<typeof WI_READ_ENABLED_SCHEMA> = {
        name: 'wi_read_enabled',
        description:
            'Read currently enabled World Info books and their entries (supports bookName/query filters). Returns a catalog summary automatically when unfiltered or when matched content exceeds 24 KB. Read-only.',
        parameters: WI_READ_ENABLED_SCHEMA,
        tier: 'chat',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const books = await ctx.bridge.listEnabledLorebooks();
            const bookFilter = args.bookName?.trim() ?? '';
            const needle = args.query?.trim().toLowerCase() ?? '';
            const hasFilter = bookFilter.length > 0 || needle.length > 0;

            const matchedBooks: Array<{
                bookName: string;
                totalEntries: number;
                entries: RawLoreEntry[];
            }> = [];

            let remaining = args.limit;
            let totalContentBytes = 0;

            for (const [bookName, entries] of books.entries()) {
                if (bookFilter && bookName !== bookFilter) {
                    continue;
                }
                const filtered = needle
                    ? entries.filter((entry) => {
                        const haystack = [
                            entry.comment ?? '',
                            ...(entry.keys ?? []),
                            ...(entry.keysecondary ?? []),
                            entry.content ?? '',
                        ]
                            .join('\n')
                            .toLowerCase();
                        return haystack.includes(needle);
                    })
                    : entries;
                const slice = filtered.slice(0, Math.max(0, remaining));
                remaining -= slice.length;
                for (const entry of slice) {
                    totalContentBytes += utf8ByteLength(entry.content ?? '');
                }
                matchedBooks.push({
                    bookName,
                    totalEntries: filtered.length,
                    entries: slice,
                });
            }

            const autoDegraded =
                args.includeContent
                && (!hasFilter || totalContentBytes > WI_READ_ENABLED_MAX_CONTENT_BYTES);
            const effectiveIncludeContent = args.includeContent && !autoDegraded;

            const summaries = matchedBooks.map((book) => ({
                bookName: book.bookName,
                totalEntries: book.totalEntries,
                entries: book.entries.map((entry) =>
                    summarizeLoreEntry(entry, effectiveIncludeContent),
                ),
            }));

            return finalizeReadToolResult({
                ok: true,
                bookCount: summaries.length,
                catalogOnly: !effectiveIncludeContent,
                ...(autoDegraded
                    ? {
                        degradedToCatalog: true,
                        reason: !hasFilter ? 'unfiltered_request' : 'content_exceeded_24kb',
                        totalContentBytes,
                        hint: 'Returned World Info catalog summary (omitting full content). Specify bookName and/or query to read full content for specific entries, use wi_read_raw_book({ bookName, uid, start_line?, end_line? }) in author/full mode for raw paginated reads, or use read_file("/lorebooks/<bookName>/...") for targeted reads.',
                    }
                    : {}),
                books: summaries,
            });
        },
    };

    return [
        listDirTool,
        globFilesTool,
        grepSearchTool,
        searchFilesTool,
        readFileTool,
        readVariablesTool,
        searchHistoryTool,
        readHistoryTool,
        agenticReadStatusTool,
        agenticReadTracesTool,
        cardReadActiveTool,
        wiReadEnabledTool,
    ];
}
