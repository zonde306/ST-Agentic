import type { HostBridge } from '@/core/bridge';
import { DEFAULT_MAIN_AGENT_ID, DEFAULT_WATERMARK } from '@/core/config';
import { classifyEntry } from '@/core/lore';
import type {
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    ClassifiedLoreEntry,
    RawLoreEntry,
    TriggerRule,
} from '@/core/types';
import { canonicalStringify, hashText as computeXxHash, normalizeVfsPath } from '@/core/utils';
import { VfsNotFoundError, type VirtualFileSystem } from '@/core/vfs';
import {
    TrajectoryStore,
    freezeCanonicalMessage,
} from './trajectory-store';

export const DEFAULT_FOLD_THRESHOLD_CHARS = 400;
export const DEFAULT_KEEP_RECENT_TURNS = 2;

export const FOLDED_OUTPUT_PREFIX = '[已折叠只读输出:';

/** Read-only VFS/history tools eligible for Action B stale `tool_result` folding. */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'read_file',
    'search_files',
    'grep_search',
    'list_dir',
    'glob_files',
    'read_history',
]);

const SUMMARY_TRIGGER_PATTERN =
    /\b(summary|summarize|outline|chronicle|important[-_\s]?table|status[-_\s]?table|story[-_\s]?memo)\b|摘要|总结|前情|大纲|重要信息|信息表|表格|纪要|伏笔/i;

const CJK_OR_FULLWIDTH_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

const HISTORY_HEADER_ARCHIVE_TAG = '<history-archive-index>';
const HISTORY_HEADER_SUMMARY_TAG = '<history-summary';

export interface WatermarkConfig {
    high: number;
    low: number;
}

export interface Layer1TurnGroup {
    index: number;
    messages: CanonicalMessage[];
}

export type ChunkSummarizer = (
    chunkText: string,
    signal?: AbortSignal,
) => Promise<string> | string;

export type TokenEstimator = (
    messages: readonly CanonicalMessage[],
    tools: readonly CanonicalToolSchema[],
) => number;

export interface CompactionOptions {
    agentId?: string;
    watermark?: WatermarkConfig;
    /** Number of trailing turns whose read-only `tool_result`s remain unfolded (default 2). */
    keepRecentTurns?: number;
    /** Minimum character length for Action B read-only `tool_result` folding (default 400). */
    foldThresholdChars?: number;
    /** Minimum number of earliest turns to archive when compaction triggers (default 1). */
    minArchiveTurns?: number;
    /** Minimum number of turns to keep in active Layer 1 window (default 1). */
    minRetainedTurns?: number;
    /** Force summary mode or auto-detect from card/preset summary triggers (default `'auto'`). */
    summaryMode?: 'auto' | 'bridge' | 'fallback';
    /** Explicit override indicating card/preset has summary/outline/table triggers. */
    hasExternalSummaryTriggers?: boolean;
    /** Active preset/WI triggers checked in `'auto'` mode. */
    triggers?: readonly TriggerRule[];
    /** Active lore entries checked in `'auto'` mode for summary/outline triggers. */
    loreEntries?: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
    /** Explicit summary/outline file paths referenced in Bridge Summary Mode. */
    summaryPaths?: readonly string[];
    /** Optional LLM summarizer callback invoked ONLY in Fallback Summary Mode. */
    summarizeChunk?: ChunkSummarizer;
    /** Optional custom token estimator. */
    estimateTokens?: TokenEstimator;
    /** Optional Layer 0 messages counted in total token budget. */
    layer0Messages?: readonly CanonicalMessage[];
    /** Optional tool schemas counted in total token budget. */
    tools?: readonly CanonicalToolSchema[];
    /** Force compaction even when below `watermark.high` (e.g. manual console trigger). */
    force?: boolean;
    /** AbortSignal honoring swipe/regenerate/stop cancellation. */
    signal?: AbortSignal;
}

export interface WatermarkCompactionResult {
    compacted: boolean;
    mode?: 'bridge' | 'fallback';
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    archivedChunkPath?: string;
    chunkNumber?: number;
    archivedTurnCount: number;
    archivedMessageCount: number;
    foldedToolResultCount: number;
    evictedReadPaths: string[];
    summaryPath?: string;
    referencedSummaryPaths: string[];
}

/** Deterministic, zero-dependency token estimator for CJK/ASCII mixed payloads. */
export function estimateStringTokens(text: string): number {
    if (!text) {
        return 0;
    }

    let cjkChars = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (CJK_OR_FULLWIDTH_RE.test(text[i])) {
            cjkChars += 1;
        }
    }
    const otherChars = text.length - cjkChars;
    return cjkChars + Math.ceil(otherChars / 4);
}

function estimateContentTokens(content: string | CanonicalContentPart[]): number {
    if (typeof content === 'string') {
        return estimateStringTokens(content);
    }
    let total = 0;
    for (const part of content) {
        if (part.type === 'text') {
            total += estimateStringTokens(part.text);
        } else if (part.type === 'image_url') {
            total += 85;
        } else if (part.type === 'input_audio') {
            total += Math.min(4096, Math.max(128, Math.ceil(part.data.length / 2048)));
        } else if (part.type === 'video_url') {
            total += Math.min(8192, Math.max(256, Math.ceil(part.videoUrl.length / 2048)));
        } else {
            total += Math.max(100, Math.ceil(part.data.length / 4));
        }
    }
    return total;
}

/** Estimate tokens for a single `CanonicalMessage`. */
export function estimateMessageTokens(message: CanonicalMessage): number {
    let tokens = 4;
    tokens += estimateContentTokens(message.content);
    if (message.name) {
        tokens += estimateStringTokens(message.name);
    }
    if (message.reasoningContent) {
        tokens += estimateStringTokens(message.reasoningContent);
    }
    if (message.toolCallId) {
        tokens += estimateStringTokens(message.toolCallId);
    }
    if (message.toolName) {
        tokens += estimateStringTokens(message.toolName);
    }
    if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
            tokens += 4
                + estimateStringTokens(call.id)
                + estimateStringTokens(call.name)
                + estimateStringTokens(call.arguments)
                + (call.thoughtSignature ? estimateStringTokens(call.thoughtSignature) : 0);
        }
    }
    return tokens;
}

/** Estimate total tokens across messages and canonically serialized tool schemas. */
export function estimateRequestTokens(
    messages: readonly CanonicalMessage[],
    tools: readonly CanonicalToolSchema[] = [],
): number {
    let total = tools.length > 0 ? estimateStringTokens(canonicalStringify(tools)) : 0;
    for (const msg of messages) {
        total += estimateMessageTokens(msg);
    }
    return total;
}

function isCompactionHeaderMessage(msg: CanonicalMessage): boolean {
    if (msg.role !== 'system' || typeof msg.content !== 'string') {
        return false;
    }
    return (
        msg.content.startsWith(HISTORY_HEADER_ARCHIVE_TAG)
        || msg.content.startsWith(HISTORY_HEADER_SUMMARY_TAG)
    );
}

/**
 * Group Layer 1 messages into atomic turn groups, ensuring a `tool_calls -> tool`
 * execution chain is NEVER split across turn boundaries.
 */
export function groupLayer1Turns(
    messages: readonly CanonicalMessage[],
    explicitHeaderCount?: number,
): { headerMessages: CanonicalMessage[]; turns: Layer1TurnGroup[] } {
    let headerEnd = 0;
    if (explicitHeaderCount !== undefined && explicitHeaderCount > 0) {
        headerEnd = Math.min(messages.length, explicitHeaderCount);
    } else {
        while (headerEnd < messages.length && isCompactionHeaderMessage(messages[headerEnd])) {
            headerEnd += 1;
        }
    }

    const headerMessages = messages.slice(0, headerEnd);
    const body = messages.slice(headerEnd);

    const turns: Layer1TurnGroup[] = [];
    let currentMessages: CanonicalMessage[] = [];
    const pendingToolCallIds = new Set<string>();

    const flushCurrent = () => {
        if (currentMessages.length > 0) {
            turns.push({
                index: turns.length,
                messages: currentMessages,
            });
            currentMessages = [];
        }
    };

    for (const msg of body) {
        if (pendingToolCallIds.size > 0 || msg.role === 'tool') {
            currentMessages.push(msg);
            if (msg.role === 'tool' && msg.toolCallId) {
                pendingToolCallIds.delete(msg.toolCallId);
            }
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    if (tc.id) {
                        pendingToolCallIds.add(tc.id);
                    }
                }
            }
            continue;
        }

        if (msg.role === 'user' && currentMessages.length > 0) {
            flushCurrent();
        }

        currentMessages.push(msg);
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            for (const tc of msg.toolCalls) {
                if (tc.id) {
                    pendingToolCallIds.add(tc.id);
                }
            }
        }
    }

    flushCurrent();
    return { headerMessages, turns };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        const err = new Error('Watermark compaction aborted');
        err.name = 'AbortError';
        throw err;
    }
}

function formatChunkFileName(chunkNumber: number): string {
    return `chunk-${String(chunkNumber).padStart(3, '0')}.md`;
}

function formatChunkVfsPath(chunkNumber: number): string {
    return `/history/${formatChunkFileName(chunkNumber)}`;
}

function parseToolCallArguments(rawArgs: string | undefined): Record<string, unknown> {
    if (!rawArgs || !rawArgs.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(rawArgs) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Ignore malformed JSON args
    }
    return {};
}

function tryNormalizePath(rawPath: unknown): string | null {
    if (typeof rawPath !== 'string' || !rawPath.trim()) {
        return null;
    }
    try {
        return normalizeVfsPath(rawPath.trim());
    } catch {
        return null;
    }
}

function extractToolPathLabel(toolName: string, args: Record<string, unknown>): string {
    const candidate =
        args.path
        ?? args.filePath
        ?? args.dirPath
        ?? args.pathPrefix
        ?? args.pattern;
    if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
    }
    if (typeof args.query === 'string' && args.query.trim()) {
        return `${toolName}:${args.query.trim()}`;
    }
    return toolName;
}

function extractEvictableVfsPath(toolName: string, args: Record<string, unknown>): string | null {
    if (toolName === 'read_file' || toolName === 'read_history') {
        return tryNormalizePath(args.path ?? args.filePath);
    }
    return null;
}

function contentToText(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .map((part) => {
            if (part.type === 'text') {
                return part.text;
            }
            if (part.type === 'image_url') {
                return `[image:${part.imageUrl}]`;
            }
            if (part.type === 'input_audio') {
                return `[audio:${part.filename ?? part.format}]`;
            }
            if (part.type === 'video_url') {
                return `[video:${part.filename ?? part.mimeType ?? 'video'}]`;
            }
            return `[file:${part.filename ?? part.mimeType ?? 'attachment'}]`;
        })
        .join('\n');
}

function collectToolCallsFromTurns(turns: readonly Layer1TurnGroup[]): Map<string, CanonicalToolCall> {
    const map = new Map<string, CanonicalToolCall>();
    for (const turn of turns) {
        for (const msg of turn.messages) {
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
                for (const call of msg.toolCalls) {
                    if (call.id) {
                        map.set(call.id, call);
                    }
                }
            }
        }
    }
    return map;
}

function collectReadFilePathsFromTurns(turns: readonly Layer1TurnGroup[]): Set<string> {
    const toolMap = collectToolCallsFromTurns(turns);
    const paths = new Set<string>();
    for (const turn of turns) {
        for (const msg of turn.messages) {
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
                for (const call of msg.toolCalls) {
                    const args = parseToolCallArguments(call.arguments);
                    const p = extractEvictableVfsPath(call.name, args);
                    if (p) {
                        paths.add(p);
                    }
                }
            } else if (msg.role === 'tool') {
                const call = msg.toolCallId ? toolMap.get(msg.toolCallId) : undefined;
                const toolName = msg.toolName ?? call?.name ?? '';
                const args = parseToolCallArguments(call?.arguments);
                const p = extractEvictableVfsPath(toolName, args);
                if (p) {
                    paths.add(p);
                }
            }
        }
    }
    return paths;
}

function renderChunkMarkdown(chunkNumber: number, turns: readonly Layer1TurnGroup[]): string {
    const totalMessages = turns.reduce((acc, t) => acc + t.messages.length, 0);
    const lines: string[] = [
        `# Archived History Chunk ${String(chunkNumber).padStart(3, '0')}`,
        '',
        `- Turns: ${turns.length}`,
        `- Messages: ${totalMessages}`,
        '',
    ];

    turns.forEach((turn, idx) => {
        lines.push(`## Turn ${idx + 1}`);
        for (const msg of turn.messages) {
            const text = contentToText(msg.content).trim();
            if (msg.role === 'user') {
                lines.push(`### User${msg.name ? ` (${msg.name})` : ''}`);
                if (text) {
                    lines.push(text);
                }
            } else if (msg.role === 'assistant') {
                lines.push(`### Assistant${msg.name ? ` (${msg.name})` : ''}`);
                if (text) {
                    lines.push(text);
                }
                if (msg.toolCalls?.length) {
                    for (const tc of msg.toolCalls) {
                        lines.push(`- ToolCall \`${tc.name}\` (${tc.id}): \`${tc.arguments}\``);
                    }
                }
            } else if (msg.role === 'tool') {
                const label = msg.toolName ?? msg.toolCallId ?? 'tool';
                lines.push(`### Tool Result (${label})`);
                if (text) {
                    lines.push(text);
                }
            } else {
                lines.push('### System');
                if (text) {
                    lines.push(text);
                }
            }
            lines.push('');
        }
    });

    return lines.join('\n').trimEnd() + '\n';
}

function buildDeterministicFallbackSummary(
    chunkNumber: number,
    turns: readonly Layer1TurnGroup[],
    priorSummary: string,
): string {
    const lines: string[] = [];
    if (priorSummary.trim()) {
        lines.push(priorSummary.trim());
        lines.push('');
    }
    lines.push(`### 归档块 Chunk-${String(chunkNumber).padStart(3, '0')} (${turns.length} 轮)`);
    turns.forEach((turn, idx) => {
        const userMsg = turn.messages.find((m) => m.role === 'user');
        const assistantMsgs = turn.messages.filter((m) => m.role === 'assistant');
        const finalAssistant = assistantMsgs[assistantMsgs.length - 1];
        const userSnippet = userMsg
            ? contentToText(userMsg.content).replace(/\s+/g, ' ').trim().slice(0, 120)
            : '';
        const assistantSnippet = finalAssistant
            ? contentToText(finalAssistant.content).replace(/\s+/g, ' ').trim().slice(0, 140)
            : '';
        lines.push(`- Turn ${idx + 1}: 用户「${userSnippet}」 → 回复「${assistantSnippet}」`);
    });
    return lines.join('\n');
}

function hasSummaryTriggerInRules(triggers: readonly TriggerRule[] | undefined): boolean {
    if (!triggers || triggers.length === 0) {
        return false;
    }
    for (const rule of triggers) {
        if (!rule.enabled) {
            continue;
        }
        const fields = [rule.label, rule.tag ?? '', rule.targetPath ?? '', rule.instructionTemplate];
        if (fields.some((f) => SUMMARY_TRIGGER_PATTERN.test(f))) {
            return true;
        }
        if (rule.targetPath && rule.targetPath.startsWith('/memory/')) {
            return true;
        }
    }
    return false;
}

function hasSummaryTriggerInLore(
    loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[] | undefined,
): boolean {
    if (!loreEntries || loreEntries.length === 0) {
        return false;
    }
    for (const item of loreEntries) {
        const classified = 'category' in item ? item : classifyEntry(item);
        if (classified.entry.disable) {
            continue;
        }
        if (classified.category !== 'dynamic_or_trigger') {
            continue;
        }
        if (classified.reason === 'init_var' || classified.reason === 'dynamic_at_depth') {
            continue;
        }
        const comment = classified.entry.comment ?? '';
        const content = classified.cleanContent ?? '';
        if (SUMMARY_TRIGGER_PATTERN.test(comment) || SUMMARY_TRIGGER_PATTERN.test(content)) {
            return true;
        }
    }
    return false;
}

function formatArchiveIndexMessage(
    archivedUpToChunk: number,
    summaryPaths: readonly string[],
): CanonicalMessage {
    const chunkList: string[] = [];
    for (let i = 1; i <= archivedUpToChunk; i += 1) {
        chunkList.push(formatChunkVfsPath(i));
    }

    const lines: string[] = [
        HISTORY_HEADER_ARCHIVE_TAG,
        '早期对话已按高水位分块归档（当前处于自建摘要衔接模式，已复用卡片/预设摘要体系，未发起额外摘要模型请求）：',
        `- 已归档历史原文块：${chunkList.join(', ')}`,
    ];

    if (summaryPaths.length > 0) {
        lines.push(`- 已有剧情摘要 / 大纲 / 状态表文件：${summaryPaths.join(', ')}`);
    }

    lines.push('如需核对早期原文或完整摘要细节，请按需调用 read_file、read_history 或 search_history 查阅。');
    lines.push('</history-archive-index>');

    return {
        role: 'system',
        content: lines.join('\n'),
    };
}

function formatFallbackSummaryMessage(
    archivedUpToChunk: number,
    summaryText: string,
): CanonicalMessage {
    const chunkList: string[] = [];
    for (let i = 1; i <= archivedUpToChunk; i += 1) {
        chunkList.push(formatChunkVfsPath(i));
    }
    const content = [
        `<history-summary path="/history/summary.md" chunks="${chunkList.join(',')}">`,
        '早期对话已分块归档，以下为保留的前情提要（如需细节可调用 read_history / search_history 查阅归档块）：',
        summaryText.trim(),
        '</history-summary>',
    ].join('\n');

    return {
        role: 'system',
        content,
    };
}

/**
 * Hysteresis High/Low Watermark Compactor:
 * - No mutations while `estimatedTokens <= watermark.high`.
 * - When `estimatedTokens > watermark.high`, executes a single atomic batch:
 *   - Action A: Archive earliest complete turn groups (never splitting `tool_calls -> tool`) to `/history/chunk-NNN.md`.
 *   - Action B: Fold large (>400 char) read-only `tool_result`s in retained turns older than recent `K` turns.
 *   - Action C: Evict archived and folded VFS paths from `Read-Set`.
 * - Coordinates Bridge Summary Mode (zero extra LLM calls) vs Fallback Summary Mode (`/history/summary.md`).
 */
export class WatermarkCompactor {
    private readonly vfs: VirtualFileSystem;
    private readonly hashTextFn: (text: string) => Promise<string>;

    constructor(options: {
        vfs: VirtualFileSystem;
        bridge?: HostBridge;
        hashText?: (text: string) => Promise<string>;
    }) {
        this.vfs = options.vfs;
        const bridge = options.bridge ?? options.vfs.bridge;
        this.hashTextFn = options.hashText ?? ((text: string) => bridge.hashText(text));
    }

    /** Check whether `estimatedTokens` exceeds `watermark.high`. */
    shouldCompact(
        estimatedTokens: number,
        watermark: WatermarkConfig = DEFAULT_WATERMARK,
    ): boolean {
        const { high } = normalizeWatermark(watermark);
        return estimatedTokens > high;
    }

    /**
     * Estimate tokens for an agent's current Layer 1 trajectory plus optional Layer 0 and tools.
     */
    estimateCurrentTokens(
        trajectoryStore: TrajectoryStore,
        options: Pick<CompactionOptions, 'agentId' | 'layer0Messages' | 'tools' | 'estimateTokens'> = {},
    ): number {
        const agentId = options.agentId ?? DEFAULT_MAIN_AGENT_ID;
        const layer1 = trajectoryStore.getMessages(agentId);
        const layer0 = options.layer0Messages ?? trajectoryStore.getFrozenPrefix(agentId)?.messages ?? [];
        const tools = options.tools ?? trajectoryStore.getFrozenPrefix(agentId)?.tools ?? [];
        const estimator = options.estimateTokens ?? estimateRequestTokens;
        return estimator([...layer0, ...layer1], tools);
    }

    /**
     * Run hysteresis watermark compaction if `estimatedTokens > watermark.high` (or `force: true`).
     */
    async compact(
        trajectoryStore: TrajectoryStore,
        options: CompactionOptions = {},
    ): Promise<WatermarkCompactionResult> {
        throwIfAborted(options.signal);

        const agentId = options.agentId ?? DEFAULT_MAIN_AGENT_ID;
        const watermark = normalizeWatermark(options.watermark);
        const keepRecentTurns = Math.max(0, options.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS);
        const foldThresholdChars = Math.max(0, options.foldThresholdChars ?? DEFAULT_FOLD_THRESHOLD_CHARS);
        const minRetainedTurns = Math.max(0, options.minRetainedTurns ?? 1);
        const estimator = options.estimateTokens ?? estimateRequestTokens;

        const frozenPrefix = trajectoryStore.getFrozenPrefix(agentId);
        const layer0 = options.layer0Messages ?? frozenPrefix?.messages ?? [];
        const tools = options.tools ?? frozenPrefix?.tools ?? [];
        const layer1 = trajectoryStore.getMessages(agentId);

        const estimatedTokensBefore = estimator([...layer0, ...layer1], tools);

        if (!options.force && estimatedTokensBefore <= watermark.high) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
                archivedMessageCount: 0,
                foldedToolResultCount: 0,
                evictedReadPaths: [],
                referencedSummaryPaths: [],
            };
        }

        const headerCount = trajectoryStore.getCompactionHeaderCount(agentId);
        const { turns } = groupLayer1Turns(layer1, headerCount > 0 ? headerCount : undefined);

        if (turns.length === 0) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
                archivedMessageCount: 0,
                foldedToolResultCount: 0,
                evictedReadPaths: [],
                referencedSummaryPaths: [],
            };
        }

        const mode = this.resolveSummaryMode(options);
        const prevChunk = trajectoryStore.getArchivedUpToChunk(agentId);
        const maxArchiveTurns = Math.max(0, turns.length - Math.min(turns.length, minRetainedTurns));
        const minArchiveTurns = maxArchiveTurns >= 1
            ? Math.min(maxArchiveTurns, Math.max(1, options.minArchiveTurns ?? 1))
            : 0;

        // Pre-discover bridge summary paths so header token estimation is accurate.
        const referencedSummaryPaths = mode === 'bridge'
            ? await this.discoverSummaryPaths(options)
            : [];

        throwIfAborted(options.signal);

        // Find smallest `archiveCount` in [minArchiveTurns .. maxArchiveTurns] that + Action B <= watermark.low.
        let chosenSplit = minArchiveTurns;
        let chosenFoldResult = await this.foldTurnsActionB(
            turns.slice(chosenSplit),
            keepRecentTurns,
            foldThresholdChars,
        );

        const previewHeader = mode === 'bridge'
            ? formatArchiveIndexMessage(prevChunk + (chosenSplit > 0 ? 1 : 0), referencedSummaryPaths)
            : formatFallbackSummaryMessage(prevChunk + (chosenSplit > 0 ? 1 : 0), 'Summary placeholder');

        const calcTotal = (foldedTurns: Layer1TurnGroup[], hasArchived: boolean): number => {
            const retainedFlat = foldedTurns.flatMap((t) => t.messages);
            const hdr = hasArchived || headerCount > 0 ? [previewHeader] : [];
            return estimator([...layer0, ...hdr, ...retainedFlat], tools);
        };

        let projectedTokens = calcTotal(chosenFoldResult.turns, chosenSplit > 0);
        while (projectedTokens > watermark.low && chosenSplit < maxArchiveTurns) {
            chosenSplit += 1;
            chosenFoldResult = await this.foldTurnsActionB(
                turns.slice(chosenSplit),
                keepRecentTurns,
                foldThresholdChars,
            );
            projectedTokens = calcTotal(chosenFoldResult.turns, chosenSplit > 0);
        }

        throwIfAborted(options.signal);

        const archivedTurns = turns.slice(0, chosenSplit);
        const retainedFoldedTurns = chosenFoldResult.turns;
        const archivedMessageCount = archivedTurns.reduce((sum, t) => sum + t.messages.length, 0);

        // If nothing could be archived AND nothing was folded, return without modifying store.
        if (archivedTurns.length === 0 && chosenFoldResult.foldedCount === 0) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
                archivedMessageCount: 0,
                foldedToolResultCount: 0,
                evictedReadPaths: [],
                referencedSummaryPaths: [],
            };
        }

        const nextChunkNumber = archivedTurns.length > 0 ? prevChunk + 1 : prevChunk;
        const chunkPath = archivedTurns.length > 0 ? formatChunkVfsPath(nextChunkNumber) : undefined;
        const chunkMarkdown = archivedTurns.length > 0
            ? renderChunkMarkdown(nextChunkNumber, archivedTurns)
            : '';

        let headerMessage: CanonicalMessage | null = null;
        let summaryPath: string | undefined;
        let summaryContentToWrite: string | undefined;

        if (nextChunkNumber > 0) {
            if (mode === 'bridge') {
                headerMessage = formatArchiveIndexMessage(nextChunkNumber, referencedSummaryPaths);
            } else {
                summaryPath = '/history/summary.md';
                const priorSummary = await this.readExistingSummary(summaryPath);
                throwIfAborted(options.signal);

                if (archivedTurns.length > 0) {
                    if (options.summarizeChunk) {
                        const chunkPromptInput = priorSummary.trim()
                            ? `已有前情提要：\n${priorSummary.trim()}\n\n新增归档历史 (${chunkPath})：\n${chunkMarkdown}`
                            : chunkMarkdown;
                        summaryContentToWrite = await options.summarizeChunk(chunkPromptInput, options.signal);
                    } else {
                        summaryContentToWrite = buildDeterministicFallbackSummary(
                            nextChunkNumber,
                            archivedTurns,
                            priorSummary,
                        );
                    }
                    throwIfAborted(options.signal);
                } else {
                    summaryContentToWrite = priorSummary;
                }

                headerMessage = formatFallbackSummaryMessage(
                    nextChunkNumber,
                    summaryContentToWrite || '早期历史已归档至 /history/。',
                );
            }
        }

        throwIfAborted(options.signal);

        // Commit atomic VFS writes for Action A and Fallback Summary.
        if (chunkPath && chunkMarkdown) {
            await this.vfs.writeHistoryInternal(chunkPath, chunkMarkdown);
        }
        if (summaryPath && summaryContentToWrite !== undefined) {
            await this.vfs.writeHistoryInternal(summaryPath, summaryContentToWrite);
        }

        // Compute Action C Read-Set eviction set:
        // Evict paths from archived turns + paths folded in Action B + checkpoint paths before archive boundary,
        // minus any paths still present in unfolded `read_file` results in the retained active window.
        const evictCandidates = new Set<string>();
        for (const p of collectReadFilePathsFromTurns(archivedTurns)) {
            evictCandidates.add(p);
        }
        for (const p of chosenFoldResult.foldedPaths) {
            evictCandidates.add(p);
        }
        if (archivedMessageCount > 0) {
            const archiveEndLimit = headerCount + archivedMessageCount;
            for (const cp of trajectoryStore.listCheckpoints(agentId).values()) {
                if (cp.messageCount <= archiveEndLimit) {
                    for (const p of cp.readSetSnapshot.keys()) {
                        evictCandidates.add(p);
                    }
                }
            }
        }

        for (const activePath of chosenFoldResult.activeUnfoldedReadPaths) {
            evictCandidates.delete(activePath);
        }

        // Assemble compacted Layer 1 messages and recompute turn-end boundaries.
        const compactedMessages: CanonicalMessage[] = [];
        const newTurnEndCounts: number[] = [];
        let newHeaderCount = 0;

        if (headerMessage) {
            compactedMessages.push(headerMessage);
            newHeaderCount = 1;
        }
        for (const turn of retainedFoldedTurns) {
            compactedMessages.push(...turn.messages);
            newTurnEndCounts.push(compactedMessages.length);
        }

        const evictedReadPaths = trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: nextChunkNumber,
                evictedPaths: evictCandidates,
                compactionHeaderCount: newHeaderCount,
                turnEndCounts: newTurnEndCounts,
            },
            agentId,
        );

        const finalLayer1 = trajectoryStore.getMessages(agentId);
        const estimatedTokensAfter = estimator([...layer0, ...finalLayer1], tools);

        return {
            compacted: true,
            mode,
            estimatedTokensBefore,
            estimatedTokensAfter,
            ...(chunkPath ? { archivedChunkPath: chunkPath, chunkNumber: nextChunkNumber } : {}),
            archivedTurnCount: archivedTurns.length,
            archivedMessageCount,
            foldedToolResultCount: chosenFoldResult.foldedCount,
            evictedReadPaths,
            ...(summaryPath ? { summaryPath } : {}),
            referencedSummaryPaths,
        };
    }

    private resolveSummaryMode(options: CompactionOptions): 'bridge' | 'fallback' {
        if (options.summaryMode === 'bridge' || options.summaryMode === 'fallback') {
            return options.summaryMode;
        }
        if (options.hasExternalSummaryTriggers !== undefined) {
            return options.hasExternalSummaryTriggers ? 'bridge' : 'fallback';
        }
        if (hasSummaryTriggerInRules(options.triggers) || hasSummaryTriggerInLore(options.loreEntries)) {
            return 'bridge';
        }
        return 'fallback';
    }

    private async discoverSummaryPaths(options: CompactionOptions): Promise<string[]> {
        const discovered = new Set<string>();

        if (options.summaryPaths) {
            for (const rawPath of options.summaryPaths) {
                const norm = tryNormalizePath(rawPath);
                if (norm) {
                    discovered.add(norm);
                }
            }
        }

        if (options.triggers) {
            for (const rule of options.triggers) {
                if (!rule.enabled || !rule.targetPath) {
                    continue;
                }
                const norm = tryNormalizePath(rule.targetPath);
                if (norm && (norm.startsWith('/memory/') || SUMMARY_TRIGGER_PATTERN.test(norm))) {
                    discovered.add(norm);
                }
            }
        }

        try {
            const memoryEntries = await this.vfs.listDir('/memory');
            for (const entry of memoryEntries) {
                if (entry.kind === 'file') {
                    discovered.add(entry.path);
                }
            }
        } catch {
            // /memory directory may not exist yet
        }

        for (const commonPath of ['/memory/summary.md', '/memory/outline.md', '/memory/important.md']) {
            if (await this.vfs.exists(commonPath)) {
                discovered.add(commonPath);
            }
        }

        if (discovered.size === 0) {
            discovered.add('/memory/summary.md');
            discovered.add('/memory/outline.md');
        }

        return Array.from(discovered).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    private async readExistingSummary(summaryPath: string): Promise<string> {
        try {
            return await this.vfs.readFile(summaryPath);
        } catch (error) {
            if (error instanceof VfsNotFoundError) {
                return '';
            }
            return '';
        }
    }

    private async foldTurnsActionB(
        retainedTurns: readonly Layer1TurnGroup[],
        keepRecentTurns: number,
        foldThresholdChars: number,
    ): Promise<{
        turns: Layer1TurnGroup[];
        foldedCount: number;
        foldedPaths: Set<string>;
        activeUnfoldedReadPaths: Set<string>;
    }> {
        const foldableLimit = Math.max(0, retainedTurns.length - keepRecentTurns);
        const toolCallMap = collectToolCallsFromTurns(retainedTurns);
        const foldedPaths = new Set<string>();
        const activeUnfoldedReadPaths = new Set<string>();
        let foldedCount = 0;

        const outTurns: Layer1TurnGroup[] = [];

        for (let t = 0; t < retainedTurns.length; t += 1) {
            const turn = retainedTurns[t];
            const isFoldableTurn = t < foldableLimit;
            const outMessages: CanonicalMessage[] = [];

            for (const msg of turn.messages) {
                if (msg.role !== 'tool') {
                    outMessages.push(msg);
                    continue;
                }

                const toolCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
                const toolName = msg.toolName ?? toolCall?.name ?? '';
                const args = parseToolCallArguments(toolCall?.arguments);
                const readFilePath = extractEvictableVfsPath(toolName, args);

                const rawText = contentToText(msg.content);
                const alreadyFolded = rawText.startsWith(FOLDED_OUTPUT_PREFIX);

                if (
                    isFoldableTurn
                    && !alreadyFolded
                    && READ_ONLY_TOOL_NAMES.has(toolName)
                    && rawText.length > foldThresholdChars
                ) {
                    const label = extractToolPathLabel(toolName, args);
                    const fullHash = await this.computeHash(rawText);
                    const shortHash = fullHash.slice(0, 8);
                    const placeholder =
                        `${FOLDED_OUTPUT_PREFIX} ${label} (约 ${rawText.length} 字，内容哈希 ${shortHash})；如需重温请重新 read_file]`;

                    outMessages.push(
                        freezeCanonicalMessage({
                            ...msg,
                            content: placeholder,
                        }),
                    );
                    foldedCount += 1;
                    if (readFilePath) {
                        foldedPaths.add(readFilePath);
                    }
                } else {
                    outMessages.push(msg);
                    if (!alreadyFolded && readFilePath) {
                        activeUnfoldedReadPaths.add(readFilePath);
                    }
                }
            }

            outTurns.push({
                index: t,
                messages: outMessages,
            });
        }

        return {
            turns: outTurns,
            foldedCount,
            foldedPaths,
            activeUnfoldedReadPaths,
        };
    }

    private async computeHash(text: string): Promise<string> {
        try {
            return await this.hashTextFn(text);
        } catch {
            return await computeXxHash(text);
        }
    }
}

function normalizeWatermark(watermark?: WatermarkConfig): WatermarkConfig {
    const rawHigh = watermark?.high ?? DEFAULT_WATERMARK.high;
    const rawLow = watermark?.low ?? DEFAULT_WATERMARK.low;
    const high = Math.max(100, Math.floor(rawHigh));
    const low = Math.max(50, Math.min(high, Math.floor(rawLow)));
    return { high, low };
}
