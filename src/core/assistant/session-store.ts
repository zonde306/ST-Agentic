import type { HostBridge } from '@/core/bridge';
import {
    estimateRequestTokens,
    groupLayer1Turns,
    TrajectoryStore,
    type EffectiveContextBudget,
    type FrozenStaticPrefix,
    type Layer1TurnGroup,
    type TrajectoryMessageTransformState,
} from '@/core/context';
import type {
    AssistantAttachment,
    AssistantCompactOptions,
    AssistantCompactReport,
    AssistantCompactionNotice,
    AssistantInterruptedCheckpoint,
    AssistantMessage,
    AssistantMode,
    AssistantSession,
    AssistantSessionTokenStatus,
    AssistantTokenLevel,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';

export const ASSISTANT_THREAD_PREFIX = 'assistant:';
export const ASSISTANT_SESSIONS_STORAGE_KEY = 'agentic_assistant_sessions';
export const DEFAULT_ASSISTANT_WATERMARK = { high: 24000, low: 12000 } as const;
export const ASSISTANT_FOLD_THRESHOLD_CHARS = 400;
export const ASSISTANT_DEFAULT_KEEP_RECENT_TURNS = 2;
export const ASSISTANT_FOLDED_OUTPUT_PREFIX = '[已折叠助手只读输出:';
export const ASSISTANT_ARCHIVE_DIR = '/side/.assistant-archive';

const ASSISTANT_SUMMARY_TAG = '<assistant-history-summary>';
const MAX_DETERMINISTIC_SUMMARY_CHARS = 2400;
const MAX_LLM_SUMMARY_TRANSCRIPT_CHARS = 24000;
const MAX_SUMMARY_PREVIEW_CHARS = 600;

export function toAssistantThreadId(sessionId: string): string {
    return `${ASSISTANT_THREAD_PREFIX}${sessionId}`;
}

export interface CreateAssistantSessionOptions {
    id?: string;
    title?: string;
    mode?: AssistantMode;
    stAdminEnabled?: boolean;
    autoApproveAuthor?: boolean;
    autoApproveChatDelete?: boolean;
    connectionId?: string;
}

export type AssistantSessionPatch = Partial<
    Pick<
        AssistantSession,
        | 'title'
        | 'mode'
        | 'stAdminEnabled'
        | 'autoApproveAuthor'
        | 'autoApproveChatDelete'
        | 'connectionId'
    >
>;

export type AssistantPersistenceMode = 'memory' | 'metadata' | 'extension_data';

export type AssistantLLMSummarizer = (input: {
    transcript: string;
    previousSummary?: string;
    focusInstruction?: string;
    signal?: AbortSignal;
}) => Promise<string>;

export type AssistantArchiveWriter = (
    path: string,
    content: string,
) => Promise<void> | void;

export interface AssistantUsageAnchor {
    actualInputTokens: number;
    estimatedTokensAtCall: number;
    trajectoryLen: number;
    updatedAt: number;
}

export interface AssistantSessionTokenStatusExtra {
    layer0?: readonly CanonicalMessage[];
    tools?: readonly CanonicalToolSchema[];
    inFlightMessages?: readonly CanonicalMessage[];
    tailMessages?: readonly CanonicalMessage[];
    isCompacting?: boolean;
    keepRecentTurns?: number;
    foldThresholdChars?: number;
}

export interface AssistantCompactSessionOptions extends AssistantCompactOptions {
    reason?: AssistantCompactReport['reason'];
    watermark?: { high: number; low: number };
    /** Bypass high-watermark gating check (defaults to true unless reason is 'auto_watermark'). */
    force?: boolean;
    keepRecentTurns?: number;
    foldThresholdChars?: number;
    summarizeWithLLM?: AssistantLLMSummarizer;
    archiveWriter?: AssistantArchiveWriter;
    layer0?: readonly CanonicalMessage[];
    tools?: readonly CanonicalToolSchema[];
    /** Attach `compactionNotice` onto the latest UI message when compacted (default true). */
    attachNotice?: boolean;
}

export interface AssistantSessionStoreOptions {
    bridge?: HostBridge;
    trajectoryStore?: TrajectoryStore;
    persistenceMode?: AssistantPersistenceMode;
    storageKey?: string;
    watermark?: { high: number; low: number };
    archiveWriter?: AssistantArchiveWriter;
    now?: () => number;
    idGenerator?: () => string;
}

export interface AssistantRequestAssembly {
    messages: CanonicalMessage[];
    tools: CanonicalToolSchema[];
    cacheBreakpoints: number[];
    estimatedTokens: number;
}

export interface AssistantCompactionResult {
    compacted: boolean;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    archivedTurnCount: number;
}

export interface AssistantRetractResult {
    session: AssistantSession;
    removedMessages: AssistantMessage[];
}

interface UiTurnGroup {
    user: AssistantMessage | null;
    assistants: AssistantMessage[];
}

function isEmptyInterruptedAssistantMessage(msg: AssistantMessage): boolean {
    return (
        msg.role === 'assistant'
        && Boolean(msg.interrupted)
        && !msg.content.trim()
        && !msg.think?.trim()
        && !(msg.toolCalls && msg.toolCalls.length > 0)
    );
}

function groupUiMessagesIntoTurns(messages: readonly AssistantMessage[]): UiTurnGroup[] {
    const turns: UiTurnGroup[] = [];
    let current: UiTurnGroup | null = null;

    const flush = () => {
        if (current && (current.user !== null || current.assistants.length > 0)) {
            turns.push(current);
        }
        current = null;
    };

    for (const msg of messages) {
        if (msg.role === 'user') {
            flush();
            current = { user: msg, assistants: [] };
            continue;
        }
        if (isEmptyInterruptedAssistantMessage(msg)) {
            continue;
        }
        if (!current) {
            current = { user: null, assistants: [] };
        }
        current.assistants.push(msg);
    }

    flush();
    return turns;
}

const AUDIO_EXTENSION_FORMAT_MAP: Readonly<Record<string, string>> = {
    mp3: 'mp3',
    mpeg: 'mp3',
    mpga: 'mp3',
    wav: 'wav',
    wave: 'wav',
    ogg: 'ogg',
    oga: 'ogg',
    opus: 'ogg',
    flac: 'flac',
    aac: 'aac',
    m4a: 'm4a',
    mp4: 'm4a',
    webm: 'webm',
};

const AUDIO_MIME_FORMAT_MAP: Readonly<Record<string, string>> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/webm': 'webm',
};

export function stripDataUrlBase64Prefix(dataOrUrl: string): string {
    if (!dataOrUrl.startsWith('data:')) {
        return dataOrUrl;
    }
    const commaIdx = dataOrUrl.indexOf(',');
    return commaIdx >= 0 ? dataOrUrl.slice(commaIdx + 1) : dataOrUrl;
}

export function inferAudioFormat(mimeType?: string, filename?: string): string {
    const cleanMime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (cleanMime && AUDIO_MIME_FORMAT_MAP[cleanMime]) {
        return AUDIO_MIME_FORMAT_MAP[cleanMime];
    }
    if (cleanMime.startsWith('audio/')) {
        const sub = cleanMime.slice('audio/'.length).replace(/^x-/, '');
        if (AUDIO_EXTENSION_FORMAT_MAP[sub]) {
            return AUDIO_EXTENSION_FORMAT_MAP[sub];
        }
    }
    const extMatch = /\.([a-z0-9]+)$/i.exec((filename ?? '').trim());
    if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (AUDIO_EXTENSION_FORMAT_MAP[ext]) {
            return AUDIO_EXTENSION_FORMAT_MAP[ext];
        }
    }
    return 'mp3';
}

/**
 * Build canonical `user` message content from plain prompt text and optional multimodal attachments.
 */
export function buildAssistantUserContent(
    prompt: string,
    attachments?: readonly AssistantAttachment[],
): string | CanonicalContentPart[] {
    if (!attachments || attachments.length === 0) {
        return prompt;
    }

    const parts: CanonicalContentPart[] = [];
    if (prompt.trim().length > 0) {
        parts.push({ type: 'text', text: prompt });
    }

    for (const att of attachments) {
        if (att.kind === 'image') {
            parts.push({
                type: 'image_url',
                imageUrl: att.dataUrl,
            });
        } else if (att.kind === 'audio') {
            parts.push({
                type: 'input_audio',
                data: stripDataUrlBase64Prefix(att.dataUrl),
                format: inferAudioFormat(att.mimeType, att.name),
                mimeType: att.mimeType,
                filename: att.name,
            });
        } else if (att.kind === 'video') {
            parts.push({
                type: 'video_url',
                videoUrl: att.dataUrl,
                mimeType: att.mimeType,
                filename: att.name,
            });
        } else if (att.textContent !== undefined) {
            parts.push({
                type: 'text',
                text: `[Attachment: ${att.name}]\n${att.textContent}`,
            });
        } else {
            parts.push({
                type: 'file',
                data: att.dataUrl,
                mimeType: att.mimeType,
                filename: att.name,
            });
        }
    }

    return parts;
}

function synthesizeTurnMessages(uiTurn: UiTurnGroup): CanonicalMessage[] {
    const out: CanonicalMessage[] = [];
    if (uiTurn.user) {
        out.push({
            role: 'user',
            content: buildAssistantUserContent(uiTurn.user.content, uiTurn.user.attachments),
        });
    }
    for (const ast of uiTurn.assistants) {
        if (!ast.content.trim() && !ast.think?.trim()) {
            continue;
        }
        out.push({
            role: 'assistant',
            content: ast.content,
            ...(ast.think?.trim() ? { reasoningContent: ast.think } : {}),
        });
    }
    return out;
}

function reconcileTurnMessages(
    uiTurn: UiTurnGroup,
    existingTurn: Layer1TurnGroup | undefined,
): CanonicalMessage[] {
    if (!existingTurn || existingTurn.messages.length === 0 || !uiTurn.user) {
        return synthesizeTurnMessages(uiTurn);
    }

    const firstExisting = existingTurn.messages[0];
    if (firstExisting.role !== 'user') {
        return synthesizeTurnMessages(uiTurn);
    }

    const desiredUserContent = buildAssistantUserContent(
        uiTurn.user.content,
        uiTurn.user.attachments,
    );
    const userMatches =
        canonicalStringify(firstExisting.content) === canonicalStringify(desiredUserContent);
    const nonEmptyAssistants = uiTurn.assistants.filter(
        (ast) => ast.content.trim().length > 0 || Boolean(ast.think?.trim()),
    );

    if (nonEmptyAssistants.length === 0) {
        if (existingTurn.messages.length === 1 && userMatches) {
            return [...existingTurn.messages];
        }
        return [{ role: 'user', content: desiredUserContent }];
    }

    if (nonEmptyAssistants.length === 1) {
        const finalUiAssistant = nonEmptyAssistants[0];
        const lastExisting = existingTurn.messages[existingTurn.messages.length - 1];
        const canPreserveTail =
            existingTurn.messages.length >= 2
            && lastExisting.role === 'assistant'
            && !(lastExisting.toolCalls && lastExisting.toolCalls.length > 0);

        if (canPreserveTail) {
            const existingAssistantText = contentToPlainText(lastExisting.content);
            if (userMatches && existingAssistantText === finalUiAssistant.content) {
                return [...existingTurn.messages];
            }
            const nextMsgs = [...existingTurn.messages];
            if (!userMatches) {
                nextMsgs[0] = {
                    ...canonicalClone(firstExisting),
                    content: canonicalClone(desiredUserContent),
                };
            }
            if (existingAssistantText !== finalUiAssistant.content) {
                nextMsgs[nextMsgs.length - 1] = {
                    ...canonicalClone(lastExisting),
                    content: finalUiAssistant.content,
                };
            }
            return nextMsgs;
        }
    }

    return synthesizeTurnMessages(uiTurn);
}

function contentToPlainText(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .map((part) => {
            if (part.type === 'text') return part.text;
            if (part.type === 'image_url') return `[image:${part.imageUrl}]`;
            if (part.type === 'input_audio') return `[audio:${part.filename ?? part.format}]`;
            if (part.type === 'video_url') {
                return `[video:${part.filename ?? part.mimeType ?? 'video'}]`;
            }
            return `[file:${part.filename ?? part.mimeType ?? 'attachment'}]`;
        })
        .join('\n');
}

function extractExistingSummaryBody(messages: readonly CanonicalMessage[]): string {
    for (const msg of messages) {
        if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(ASSISTANT_SUMMARY_TAG)) {
            return msg.content
                .replace(/^<assistant-history-summary>\s*/i, '')
                .replace(/\s*<\/assistant-history-summary>\s*$/i, '')
                .trim();
        }
    }
    return '';
}

function sanitizeArchiveSegment(raw: string): string {
    const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
    return cleaned || 'session';
}

function formatArchiveChunkPath(sessionId: string, chunkNumber: number): string {
    const safeSession = sanitizeArchiveSegment(sessionId);
    const chunkName = `chunk-${String(chunkNumber).padStart(3, '0')}.md`;
    return `${ASSISTANT_ARCHIVE_DIR}/${safeSession}/${chunkName}`;
}

export function isFoldedAssistantToolContent(content: string): boolean {
    return (
        content.startsWith(ASSISTANT_FOLDED_OUTPUT_PREFIX)
        || content.startsWith('[已折叠只读输出:')
        || content.startsWith('[输出因触发模型上下文上限')
    );
}

function parseJsonObjectSafe(raw: string | undefined): Record<string, unknown> {
    if (!raw || !raw.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Ignore malformed JSON arguments
    }
    return {};
}

function extractToolCallLabel(toolCall?: CanonicalToolCall): string {
    if (!toolCall) {
        return 'output';
    }
    const args = parseJsonObjectSafe(toolCall.arguments);
    const preferredKeys = [
        'path',
        'keyPath',
        'bookName',
        'scope',
        'name',
        'query',
        'pattern',
        'agentId',
        'sessionId',
        'chid',
        'uid',
    ];
    for (const key of preferredKeys) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) {
            const clean = val.replace(/\s+/g, ' ').trim();
            return clean.length > 48 ? `${clean.slice(0, 45)}...` : clean;
        }
        if (typeof val === 'number' && Number.isFinite(val)) {
            return `${key}=${val}`;
        }
    }
    for (const [key, val] of Object.entries(args)) {
        if (typeof val === 'string' && val.trim()) {
            const clean = `${key}=${val.replace(/\s+/g, ' ').trim()}`;
            return clean.length > 48 ? `${clean.slice(0, 45)}...` : clean;
        }
    }
    return 'output';
}

export function formatFoldedAssistantToolPlaceholder(
    toolName: string,
    label: string,
    originalLength: number,
): string {
    return `${ASSISTANT_FOLDED_OUTPUT_PREFIX} ${toolName} (${label}, 原长约 ${originalLength} 字)；如需细节可按精确过滤条件重读]`;
}

function buildToolCallLookup(messages: readonly CanonicalMessage[]): Map<string, CanonicalToolCall> {
    const map = new Map<string, CanonicalToolCall>();
    for (const msg of messages) {
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            for (const tc of msg.toolCalls) {
                if (tc.id) {
                    map.set(tc.id, tc);
                }
            }
        }
    }
    return map;
}

function foldToolResultsInTurn(
    turn: Layer1TurnGroup,
    options: {
        foldThresholdChars: number;
        /** Number of trailing tool rounds to keep unfolded within this turn (0 folds all). */
        keepRecentRounds: number;
    },
): { turn: Layer1TurnGroup; foldedCount: number } {
    const toolCallMap = buildToolCallLookup(turn.messages);
    let totalToolRounds = 0;
    const msgRoundIndices: number[] = new Array<number>(turn.messages.length).fill(-1);

    for (let i = 0; i < turn.messages.length; i += 1) {
        const msg = turn.messages[i];
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            totalToolRounds += 1;
        } else if (msg.role === 'tool') {
            msgRoundIndices[i] = Math.max(0, totalToolRounds - 1);
        }
    }

    const cutoffRound =
        options.keepRecentRounds <= 0
            ? Number.POSITIVE_INFINITY
            : totalToolRounds - options.keepRecentRounds;

    if (cutoffRound <= 0) {
        return { turn, foldedCount: 0 };
    }

    let foldedCount = 0;
    const nextMessages = turn.messages.map((msg, idx) => {
        if (msg.role !== 'tool') {
            return msg;
        }
        const msgRound = msgRoundIndices[idx];
        if (msgRound >= cutoffRound) {
            return msg;
        }
        const rawText = contentToPlainText(msg.content);
        if (rawText.length <= options.foldThresholdChars || isFoldedAssistantToolContent(rawText)) {
            return msg;
        }
        const matchedCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
        const toolName = msg.toolName || matchedCall?.name || 'tool';
        const label = extractToolCallLabel(matchedCall);
        foldedCount += 1;
        return {
            ...canonicalClone(msg),
            content: formatFoldedAssistantToolPlaceholder(toolName, label, rawText.length),
        };
    });

    if (foldedCount === 0) {
        return { turn, foldedCount: 0 };
    }

    return {
        turn: {
            index: turn.index,
            messages: nextMessages,
        },
        foldedCount,
    };
}

function foldStaleToolResultsAcrossTurns(
    turns: readonly Layer1TurnGroup[],
    options: {
        keepRecentTurns: number;
        foldThresholdChars: number;
        /** When true, also fold earlier tool rounds inside recent turns if needed. */
        urgent?: boolean;
        /** When true, fold even the latest tool round (emergency overflow recovery). */
        foldAll?: boolean;
    },
): { turns: Layer1TurnGroup[]; foldedCount: number } {
    if (turns.length === 0) {
        return { turns: [], foldedCount: 0 };
    }

    let totalFolded = 0;
    const nextTurns = turns.map((turn, idx) => {
        if (options.foldAll) {
            const res = foldToolResultsInTurn(turn, {
                foldThresholdChars: options.foldThresholdChars,
                keepRecentRounds: 0,
            });
            totalFolded += res.foldedCount;
            return res.turn;
        }

        if (turns.length === 1) {
            // Single-turn folding: fold earlier tool rounds older than the latest 1 tool round.
            const res = foldToolResultsInTurn(turn, {
                foldThresholdChars: options.foldThresholdChars,
                keepRecentRounds: 1,
            });
            totalFolded += res.foldedCount;
            return res.turn;
        }

        const staleTurnCutoff = Math.max(0, turns.length - Math.max(0, options.keepRecentTurns));
        if (idx < staleTurnCutoff) {
            const res = foldToolResultsInTurn(turn, {
                foldThresholdChars: options.foldThresholdChars,
                keepRecentRounds: 0,
            });
            totalFolded += res.foldedCount;
            return res.turn;
        }

        if (options.urgent) {
            // Under urgent pressure, fold earlier turns (< last turn) completely and earlier rounds of the last turn.
            const keepRounds = idx < turns.length - 1 ? 0 : 1;
            const res = foldToolResultsInTurn(turn, {
                foldThresholdChars: options.foldThresholdChars,
                keepRecentRounds: keepRounds,
            });
            totalFolded += res.foldedCount;
            return res.turn;
        }

        return turn;
    });

    return { turns: nextTurns, foldedCount: totalFolded };
}

function countFoldableToolResults(
    turns: readonly Layer1TurnGroup[],
    keepRecentTurns: number,
    foldThresholdChars: number,
): number {
    return foldStaleToolResultsAcrossTurns(turns, {
        keepRecentTurns,
        foldThresholdChars,
        urgent: false,
    }).foldedCount;
}

function formatArchivedTurnsTranscript(
    turns: readonly Layer1TurnGroup[],
    meta: { sessionId: string; chunkNumber: number; timestamp: number },
): string {
    const lines: string[] = [
        '---',
        'delivery: none',
        'status: resolved',
        `title: Assistant Archive Chunk ${String(meta.chunkNumber).padStart(3, '0')}`,
        '---',
        '',
        `# Assistant Archive Chunk ${String(meta.chunkNumber).padStart(3, '0')}`,
        `- sessionId: ${meta.sessionId}`,
        `- archivedAt: ${new Date(meta.timestamp).toISOString()}`,
        `- turns: ${turns.length}`,
        '',
    ];

    turns.forEach((turn, idx) => {
        lines.push(`## Turn ${idx + 1}`);
        for (const msg of turn.messages) {
            if (msg.role === 'user') {
                lines.push(`### User\n${contentToPlainText(msg.content)}`);
            } else if (msg.role === 'assistant') {
                const body = contentToPlainText(msg.content);
                if (body.trim()) {
                    lines.push(`### Assistant\n${body}`);
                }
                if (msg.toolCalls?.length) {
                    const calls = msg.toolCalls
                        .map((tc) => `- ${tc.name}(${tc.arguments})`)
                        .join('\n');
                    lines.push(`### Assistant Tool Calls\n${calls}`);
                }
            } else if (msg.role === 'tool') {
                lines.push(
                    `### Tool (${msg.toolName ?? 'tool'} / ${msg.toolCallId ?? ''})\n${contentToPlainText(msg.content)}`,
                );
            } else {
                lines.push(`### System\n${contentToPlainText(msg.content)}`);
            }
            lines.push('');
        }
    });

    return lines.join('\n');
}

function formatTranscriptForLLMSummary(turns: readonly Layer1TurnGroup[]): string {
    const parts: string[] = [];
    let totalChars = 0;

    for (let i = 0; i < turns.length; i += 1) {
        const turn = turns[i];
        const blockLines: string[] = [`[Turn ${i + 1}]`];
        for (const msg of turn.messages) {
            const raw = contentToPlainText(msg.content).trim();
            if (msg.role === 'user') {
                blockLines.push(`User: ${raw.slice(0, 1200)}`);
            } else if (msg.role === 'assistant') {
                if (raw) {
                    blockLines.push(`Assistant: ${raw.slice(0, 1200)}`);
                }
                if (msg.toolCalls?.length) {
                    const toolList = msg.toolCalls
                        .map((tc) => `${tc.name}(${extractToolCallLabel(tc)})`)
                        .join(', ');
                    blockLines.push(`Assistant Tools: ${toolList}`);
                }
            } else if (msg.role === 'tool') {
                blockLines.push(
                    `Tool[${msg.toolName ?? 'tool'}]: ${raw.slice(0, 500)}${raw.length > 500 ? '...(truncated)' : ''}`,
                );
            }
        }
        const block = blockLines.join('\n');
        if (totalChars + block.length > MAX_LLM_SUMMARY_TRANSCRIPT_CHARS) {
            const remaining = MAX_LLM_SUMMARY_TRANSCRIPT_CHARS - totalChars;
            if (remaining > 120) {
                parts.push(`${block.slice(0, remaining)}\n...[transcript truncated]`);
            }
            break;
        }
        parts.push(block);
        totalChars += block.length + 2;
    }

    return parts.join('\n\n');
}

/**
 * Deterministic 0-token structured handoff summary builder used as the guaranteed
 * fallback whenever LLM summarization is disabled, fails, or times out.
 */
export function buildDeterministicSummary(
    turns: readonly Layer1TurnGroup[],
    options?: {
        priorSummary?: string;
        focusInstruction?: string;
        archivedChunkPath?: string;
        maxLength?: number;
    },
): string {
    const maxLength = Math.max(400, options?.maxLength ?? MAX_DETERMINISTIC_SUMMARY_CHARS);
    const sections: string[] = [];
    const focus = options?.focusInstruction?.trim();
    if (focus) {
        sections.push(`【保留重点】${focus}`);
    }

    const prior = options?.priorSummary?.trim();
    if (prior) {
        const priorBudget = Math.floor(maxLength * 0.45);
        const trimmedPrior =
            prior.length > priorBudget
                ? `…${prior.slice(prior.length - priorBudget + 1)}`
                : prior;
        sections.push(trimmedPrior);
    }

    const touchedObjects = new Set<string>();
    const errorHints: string[] = [];
    const turnLines: string[] = [];

    for (const turn of turns) {
        const userMsg = turn.messages.find((m) => m.role === 'user');
        const assistantMsgs = turn.messages.filter((m) => m.role === 'assistant');
        const finalAssistant = assistantMsgs[assistantMsgs.length - 1];
        const toolNames = new Set<string>();

        for (const msg of turn.messages) {
            if (msg.role === 'assistant' && msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    toolNames.add(tc.name);
                    const label = extractToolCallLabel(tc);
                    if (label !== 'output') {
                        touchedObjects.add(`${tc.name}:${label}`);
                    }
                }
            }
            if (msg.role === 'tool') {
                const txt = contentToPlainText(msg.content);
                if (txt.includes('"ok":false') || txt.includes('[Error]')) {
                    errorHints.push(
                        `${msg.toolName ?? 'tool'}: ${txt.replace(/\s+/g, ' ').trim().slice(0, 90)}`,
                    );
                }
            }
        }

        const userText = userMsg
            ? contentToPlainText(userMsg.content).replace(/\s+/g, ' ').trim().slice(0, 80)
            : '';
        const assistantText = finalAssistant
            ? contentToPlainText(finalAssistant.content).replace(/\s+/g, ' ').trim().slice(0, 100)
            : '';
        if (assistantText.includes('[Error]')) {
            errorHints.push(assistantText.slice(0, 100));
        }
        const toolsPart = toolNames.size > 0 ? ` [${Array.from(toolNames).join(',')}]` : '';
        turnLines.push(`- U: ${userText} -> A${toolsPart}: ${assistantText}`);
    }

    if (turnLines.length > 0) {
        sections.push(`【归档回合提要】\n${turnLines.join('\n')}`);
    }
    if (touchedObjects.size > 0) {
        sections.push(
            `【涉及文件/对象】${Array.from(touchedObjects).slice(0, 12).join('、')}`,
        );
    }
    if (errorHints.length > 0) {
        sections.push(`【报错线索】${errorHints.slice(-3).join(' | ')}`);
    }
    if (options?.archivedChunkPath) {
        sections.push(`【归档原文】${options.archivedChunkPath}`);
    }

    const combined = sections.join('\n').trim();
    if (combined.length <= maxLength) {
        return combined;
    }

    // Preserve focus instruction header when trimming oversized summaries.
    if (focus) {
        const focusHeader = `【保留重点】${focus}\n`;
        const bodyBudget = Math.max(120, maxLength - focusHeader.length);
        const bodyWithoutFocus = combined.startsWith(focusHeader)
            ? combined.slice(focusHeader.length)
            : combined;
        return `${focusHeader}${bodyWithoutFocus.slice(Math.max(0, bodyWithoutFocus.length - bodyBudget))}`;
    }

    return combined.slice(combined.length - maxLength);
}

interface CompactionUiAnchor {
    archivedUiTurnCount: number;
    archivedTurnFingerprints: string[];
}

function fingerprintUiTurn(turn: UiTurnGroup): string {
    const userPart = turn.user
        ? canonicalStringify(buildAssistantUserContent(turn.user.content, turn.user.attachments))
        : '';
    const assistantParts = turn.assistants.map((a) => a.content).join('\u0000');
    return `${userPart}\u0001${assistantParts}`;
}

function isAbortErrorLike(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const err = error as { name?: unknown; code?: unknown };
    return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}

function cloneSession(session: AssistantSession): AssistantSession {
    return canonicalClone(session);
}

function isValidAssistantSession(raw: unknown): raw is AssistantSession {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return false;
    }
    const rec = raw as Partial<AssistantSession>;
    return (
        typeof rec.id === 'string'
        && rec.id.length > 0
        && typeof rec.title === 'string'
        && (rec.mode === 'chat' || rec.mode === 'adjust' || rec.mode === 'author' || rec.mode === 'full')
        && Array.isArray(rec.messages)
    );
}

/**
 * Stores `AssistantSession` records and messages (in memory with optional `HostBridge`
 * metadata or extension-data persistence) and manages KV-cache-friendly per-session
 * `TrajectoryStore` threads keyed by `assistant:<sessionId>`.
 */
export class AssistantSessionStore {
    public readonly trajectoryStore: TrajectoryStore;

    private readonly sessions = new Map<string, AssistantSession>();
    private readonly usageAnchors = new Map<string, AssistantUsageAnchor>();
    private readonly compactionAnchors = new Map<string, CompactionUiAnchor>();
    private readonly compactionCycleCounts = new Map<string, number>();
    private readonly bridge?: HostBridge;
    private readonly persistenceMode: AssistantPersistenceMode;
    private readonly storageKey: string;
    private readonly defaultWatermark: { high: number; low: number };
    private readonly customWatermarkConfigured: boolean;
    private readonly defaultArchiveWriter?: AssistantArchiveWriter;
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private persistChain: Promise<void> = Promise.resolve();
    private seq = 0;

    constructor(options: AssistantSessionStoreOptions = {}) {
        this.bridge = options.bridge;
        this.trajectoryStore = options.trajectoryStore ?? new TrajectoryStore();
        this.persistenceMode =
            options.persistenceMode ?? (options.bridge ? 'metadata' : 'memory');
        this.storageKey = options.storageKey?.trim() || ASSISTANT_SESSIONS_STORAGE_KEY;
        this.customWatermarkConfigured = Boolean(options.watermark);
        this.defaultWatermark = options.watermark
            ? {
                high: Math.max(100, Math.floor(options.watermark.high)),
                low: Math.max(50, Math.floor(options.watermark.low)),
            }
            : { ...DEFAULT_ASSISTANT_WATERMARK };
        this.defaultArchiveWriter = options.archiveWriter;
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `ast_${this.now()}_${this.seq}`;
            });

        if (this.persistenceMode === 'metadata' && this.bridge) {
            this.hydrateFromMetadata();
        }
    }

    public getDefaultWatermark(): { high: number; low: number } {
        return { ...this.defaultWatermark };
    }

    public hasCustomWatermark(): boolean {
        return this.customWatermarkConfigured;
    }

    /** Load persisted sessions from configured storage (metadata or extension_data). */
    public async load(): Promise<AssistantSession[]> {
        if (!this.bridge || this.persistenceMode === 'memory') {
            return this.listSessions();
        }
        if (this.persistenceMode === 'metadata') {
            this.hydrateFromMetadata();
            return this.listSessions();
        }
        const loaded = await this.bridge.loadExtensionData<AssistantSession[]>(
            this.storageKey,
            [],
        );
        this.sessions.clear();
        if (Array.isArray(loaded)) {
            for (const item of loaded) {
                if (isValidAssistantSession(item)) {
                    this.sessions.set(item.id, cloneSession(item));
                }
            }
        }
        return this.listSessions();
    }

    /** Wait for any queued async persistence operations to complete. */
    public async flush(): Promise<void> {
        await this.persistChain;
    }

    public createSession(options: CreateAssistantSessionOptions = {}): AssistantSession {
        const id = options.id?.trim() || this.idGenerator();
        if (this.sessions.has(id)) {
            throw new Error(`Assistant session "${id}" already exists.`);
        }
        const now = this.now();
        const mode: AssistantMode = options.mode ?? 'chat';
        const session: AssistantSession = {
            id,
            title: options.title?.trim() || '新助手会话',
            mode,
            stAdminEnabled: mode === 'full' ? Boolean(options.stAdminEnabled) : false,
            autoApproveAuthor: Boolean(options.autoApproveAuthor),
            autoApproveChatDelete: Boolean(options.autoApproveChatDelete),
            connectionId: options.connectionId?.trim() || 'inherit',
            updatedAt: now,
            messages: [],
        };
        this.sessions.set(id, session);
        this.trajectoryStore.ensureThread(toAssistantThreadId(id));
        this.persist();
        return cloneSession(session);
    }

    public getSession(sessionId: string): AssistantSession | null {
        const found = this.sessions.get(sessionId);
        return found ? cloneSession(found) : null;
    }

    public listSessions(): AssistantSession[] {
        return Array.from(this.sessions.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(cloneSession);
    }

    public updateSession(
        sessionId: string,
        patch: AssistantSessionPatch,
    ): AssistantSession | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        if (patch.title !== undefined) {
            session.title = patch.title.trim() || session.title;
        }
        if (patch.mode !== undefined) {
            session.mode = patch.mode;
            if (patch.mode !== 'full') {
                session.stAdminEnabled = false;
            }
        }
        if (patch.stAdminEnabled !== undefined) {
            session.stAdminEnabled = session.mode === 'full' ? Boolean(patch.stAdminEnabled) : false;
        }
        if (patch.autoApproveAuthor !== undefined) {
            session.autoApproveAuthor = Boolean(patch.autoApproveAuthor);
        }
        if (patch.autoApproveChatDelete !== undefined) {
            session.autoApproveChatDelete = Boolean(patch.autoApproveChatDelete);
        }
        if (patch.connectionId !== undefined) {
            session.connectionId = patch.connectionId.trim() || 'inherit';
        }
        session.updatedAt = this.now();
        this.persist();
        return cloneSession(session);
    }

    public deleteSession(sessionId: string): boolean {
        const existed = this.sessions.delete(sessionId);
        this.usageAnchors.delete(sessionId);
        this.compactionAnchors.delete(sessionId);
        this.compactionCycleCounts.delete(sessionId);
        this.trajectoryStore.clearThread(toAssistantThreadId(sessionId));
        if (existed) {
            this.persist();
        }
        return existed;
    }

    /**
     * Clear all messages and model trajectory for an existing session while preserving its
     * configuration (title, mode, connectionId), and reset calibration/compaction anchors.
     */
    public clearSession(sessionId: string): AssistantSession | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        session.messages = [];
        delete session.interruptedCheckpoint;
        session.updatedAt = this.now();
        this.usageAnchors.delete(sessionId);
        this.compactionAnchors.delete(sessionId);
        this.compactionCycleCounts.delete(sessionId);
        const threadId = toAssistantThreadId(sessionId);
        this.trajectoryStore.clearThread(threadId);
        this.trajectoryStore.ensureThread(threadId);
        this.persist();
        return cloneSession(session);
    }

    public setInterruptedCheckpoint(
        sessionId: string,
        checkpoint: AssistantInterruptedCheckpoint | undefined,
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        if (checkpoint === undefined && session.interruptedCheckpoint === undefined) {
            return;
        }
        if (checkpoint) {
            session.interruptedCheckpoint = canonicalClone(checkpoint);
        } else {
            delete session.interruptedCheckpoint;
        }
        session.updatedAt = this.now();
        this.persist();
    }

    public getInterruptedCheckpoint(sessionId: string): AssistantInterruptedCheckpoint | null {
        const cp = this.sessions.get(sessionId)?.interruptedCheckpoint;
        return cp ? canonicalClone(cp) : null;
    }

    public appendMessage(sessionId: string, message: AssistantMessage): AssistantMessage {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        const copy = canonicalClone(message);
        session.messages.push(copy);
        session.updatedAt = this.now();
        this.persist();
        return canonicalClone(copy);
    }

    public updateMessage(
        sessionId: string,
        messageId: string,
        updater: (prev: AssistantMessage) => AssistantMessage,
    ): AssistantMessage | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const updated = canonicalClone(updater(canonicalClone(session.messages[idx])));
        session.messages[idx] = updated;
        session.updatedAt = this.now();
        this.persist();
        return canonicalClone(updated);
    }

    /**
     * Retract `messageId` and all subsequent messages from `session.messages`,
     * syncing `TrajectoryStore` Layer 1 while preserving earlier turns verbatim.
     */
    public retractFromMessage(
        sessionId: string,
        messageId: string,
    ): AssistantRetractResult | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const removedMessages = session.messages.slice(idx).map((m) => canonicalClone(m));
        session.messages = session.messages.slice(0, idx);
        if (
            session.interruptedCheckpoint
            && session.messages[session.messages.length - 1]?.id !== session.interruptedCheckpoint.messageId
        ) {
            delete session.interruptedCheckpoint;
        }
        session.updatedAt = this.now();
        this.syncTrajectoryToMessages(sessionId);
        this.persist();
        return {
            session: cloneSession(session),
            removedMessages,
        };
    }

    /**
     * Remove all messages strictly after `messageId`, keeping `messageId` intact,
     * and synchronize `TrajectoryStore` Layer 1.
     */
    public truncateAfterMessage(
        sessionId: string,
        messageId: string,
    ): AssistantRetractResult | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const removedMessages = session.messages.slice(idx + 1).map((m) => canonicalClone(m));
        session.messages = session.messages.slice(0, idx + 1);
        if (
            session.interruptedCheckpoint
            && session.messages[session.messages.length - 1]?.id !== session.interruptedCheckpoint.messageId
        ) {
            delete session.interruptedCheckpoint;
        }
        session.updatedAt = this.now();
        this.syncTrajectoryToMessages(sessionId);
        this.persist();
        return {
            session: cloneSession(session),
            removedMessages,
        };
    }

    /**
     * Reconcile `TrajectoryStore` Layer 1 with `session.messages` (or a prefix up to `upToMessageIndex`),
     * preserving unmodified prior turns (including tool-call chains and folded outputs) verbatim for KV
     * cache stability. Safely drops stale compaction headers if archived turns were edited or retracted,
     * and always resets the calibrated usage anchor.
     */
    public syncTrajectoryToMessages(
        sessionId: string,
        options?: { upToMessageIndex?: number },
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        // Always reset calibrated usage anchor whenever the trajectory is rewritten/reconciled.
        this.resetUsageAnchor(sessionId);

        const endIdx =
            options?.upToMessageIndex !== undefined
                ? Math.max(0, Math.min(session.messages.length, options.upToMessageIndex))
                : session.messages.length;

        const uiTurns = groupUiMessagesIntoTurns(session.messages.slice(0, endIdx));
        const threadId = toAssistantThreadId(sessionId);
        const existingLayer1 = this.trajectoryStore.getMessages(threadId);
        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);

        const { headerMessages, turns: existingTurns } = groupLayer1Turns(
            existingLayer1,
            headerCount > 0 ? headerCount : undefined,
        );

        let retainedHeaders: CanonicalMessage[] = [];
        let reconcileUiTurns: UiTurnGroup[] = uiTurns;
        let reconcileExistingTurns: readonly Layer1TurnGroup[] = existingTurns;
        let anchorStillValid = false;

        if (headerMessages.length > 0) {
            const anchor = this.compactionAnchors.get(sessionId);
            if (anchor && anchor.archivedUiTurnCount > 0) {
                if (uiTurns.length >= anchor.archivedUiTurnCount) {
                    let archivedUnchanged = true;
                    for (let i = 0; i < anchor.archivedUiTurnCount; i += 1) {
                        if (fingerprintUiTurn(uiTurns[i]) !== anchor.archivedTurnFingerprints[i]) {
                            archivedUnchanged = false;
                            break;
                        }
                    }
                    if (archivedUnchanged) {
                        retainedHeaders = [...headerMessages];
                        reconcileUiTurns = uiTurns.slice(anchor.archivedUiTurnCount);
                        reconcileExistingTurns = existingTurns;
                        anchorStillValid = true;
                    }
                }
            } else if (existingTurns.length > 0) {
                const firstExistingUser = existingTurns[0].messages.find((m) => m.role === 'user');
                if (firstExistingUser) {
                    const needle = contentToPlainText(firstExistingUser.content);
                    const approxStart = Math.max(0, uiTurns.length - existingTurns.length - 2);
                    let offset = -1;
                    const matchesTurnUser = (turn: UiTurnGroup): boolean => {
                        if (!turn.user) {
                            return false;
                        }
                        const turnPlain = contentToPlainText(
                            buildAssistantUserContent(turn.user.content, turn.user.attachments),
                        );
                        return turnPlain === needle || turn.user.content === needle;
                    };
                    for (let i = approxStart; i < uiTurns.length; i += 1) {
                        if (matchesTurnUser(uiTurns[i])) {
                            offset = i;
                            break;
                        }
                    }
                    if (offset < 0) {
                        for (let i = 0; i < approxStart; i += 1) {
                            if (matchesTurnUser(uiTurns[i])) {
                                offset = i;
                                break;
                            }
                        }
                    }
                    if (offset >= 0 && offset < uiTurns.length) {
                        retainedHeaders = [...headerMessages];
                        reconcileUiTurns = uiTurns.slice(offset);
                        reconcileExistingTurns = existingTurns;
                        anchorStillValid = true;
                    }
                }
            }

            if (!anchorStillValid) {
                // Archived turns were edited/retracted: rebuild cleanly from remaining UI turns
                // without stale summary headers or mismatched existingTurns.
                this.compactionAnchors.delete(sessionId);
                retainedHeaders = [];
                reconcileUiTurns = uiTurns;
                reconcileExistingTurns = [];
            }
        }

        const compactedMessages: CanonicalMessage[] = [...retainedHeaders];
        const turnEndCounts: number[] = [];
        let runningLen = retainedHeaders.length;

        for (let i = 0; i < reconcileUiTurns.length; i += 1) {
            const uiTurn = reconcileUiTurns[i];
            const existingTurn =
                i < reconcileExistingTurns.length ? reconcileExistingTurns[i] : undefined;
            const turnMsgs = reconcileTurnMessages(uiTurn, existingTurn);
            if (turnMsgs.length > 0) {
                compactedMessages.push(...turnMsgs);
                runningLen += turnMsgs.length;
                turnEndCounts.push(runningLen);
            }
        }

        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: prevChunk,
                compactionHeaderCount: retainedHeaders.length,
                turnEndCounts,
            },
            threadId,
        );
        if (compactedMessages.length === 0 && session.messages.length === 0) {
            this.trajectoryStore.setFrozenPrefix(null, threadId);
        }
    }

    /** Return the `TrajectoryStore` thread ID (`assistant:<sessionId>`). */
    public getThreadId(sessionId: string): string {
        return toAssistantThreadId(sessionId);
    }

    /**
     * Ensure Layer 0 static prefix (`systemPrompt` + canonically ordered `tools`) is frozen
     * on `assistant:<sessionId>` for KV cache prefix invariance across multi-turn requests.
     * Only recompiles when the frozen prefix is absent or the prompt/toolset actually changed.
     */
    public ensureFrozenPrefix(
        sessionId: string,
        systemPrompt: string,
        tools: readonly CanonicalToolSchema[],
        forceRecompile: boolean = false,
        extraPrefixMessages: readonly CanonicalMessage[] = [],
        prefixFingerprint?: string,
        omitSystemMessage: boolean = false,
    ): FrozenStaticPrefix {
        const threadId = toAssistantThreadId(sessionId);
        const existing = this.trajectoryStore.getFrozenPrefix(threadId);
        const desiredMessages: CanonicalMessage[] = [
            ...(omitSystemMessage ? [] : [{ role: 'system' as const, content: systemPrompt }]),
            ...extraPrefixMessages.map((msg) => canonicalClone(msg)),
        ];
        const desiredTools = canonicalClone([...tools]);

        if (
            !forceRecompile
            && existing
            && (prefixFingerprint === undefined || existing.prefixFingerprint === prefixFingerprint)
            && canonicalStringify(existing.messages) === canonicalStringify(desiredMessages)
            && canonicalStringify(existing.tools) === canonicalStringify(desiredTools)
        ) {
            return existing;
        }

        const nextPrefix: FrozenStaticPrefix = {
            messages: desiredMessages,
            tools: desiredTools,
            layer0EndIndex: desiredMessages.length > 0 ? desiredMessages.length - 1 : -1,
            ...(prefixFingerprint !== undefined ? { prefixFingerprint } : {}),
        };
        this.trajectoryStore.setFrozenPrefix(nextPrefix, threadId);
        return this.trajectoryStore.getFrozenPrefix(threadId)!;
    }

    /**
     * Assemble a KV-cache-friendly `LLMRequest` payload for `assistant:<sessionId>`:
     * Layer 0 (frozen system prefix) + Layer 1 (append-only committed trajectory) + in-flight turn messages
     * + optional ephemeral tail messages.
     */
    public buildRequestMessages(
        sessionId: string,
        systemPrompt: string,
        tools: readonly CanonicalToolSchema[],
        inFlightMessages: readonly CanonicalMessage[] = [],
        options?: {
            extraPrefixMessages?: readonly CanonicalMessage[];
            tailMessages?: readonly CanonicalMessage[];
            overrideLayer1Messages?: readonly CanonicalMessage[];
            prefixFingerprint?: string;
            omitSystemMessage?: boolean;
        },
    ): AssistantRequestAssembly {
        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.ensureFrozenPrefix(
            sessionId,
            systemPrompt,
            tools,
            false,
            options?.extraPrefixMessages ?? [],
            options?.prefixFingerprint,
            Boolean(options?.omitSystemMessage),
        );
        const layer0 = canonicalClone([...frozen.messages]);
        const layer1 = canonicalClone([
            ...(options?.overrideLayer1Messages ?? this.trajectoryStore.getMessages(threadId)),
        ]);
        const inFlight = canonicalClone([...inFlightMessages]);
        const tail = canonicalClone([...(options?.tailMessages ?? [])]);

        const messages: CanonicalMessage[] = [...layer0, ...layer1, ...inFlight, ...tail];
        const canonicalTools = canonicalClone([...frozen.tools]);

        const cacheBreakpoints: number[] = [];
        if (layer0.length > 0) {
            cacheBreakpoints.push(layer0.length - 1);
        }
        if (layer1.length > 0) {
            cacheBreakpoints.push(layer0.length + layer1.length - 1);
        }

        const estimatedTokens = estimateRequestTokens(messages, canonicalTools);
        return {
            messages,
            tools: canonicalTools,
            cacheBreakpoints,
            estimatedTokens,
        };
    }

    /** Append finalized turn messages to Layer 1 of `assistant:<sessionId>` without mutating prior items. */
    public appendTrajectoryTurn(
        sessionId: string,
        messages: readonly CanonicalMessage[],
        transformStates?: ReadonlyArray<TrajectoryMessageTransformState | undefined>,
    ): void {
        if (messages.length === 0) {
            return;
        }
        const threadId = toAssistantThreadId(sessionId);
        this.trajectoryStore.appendTurn(messages, threadId, transformStates);
    }

    /**
     * Record a real upstream `usage.inputTokens` calibration anchor for `sessionId`
     * so token status & pre-flight checks track actual tokenizer / multimodal costs accurately.
     */
    public recordUsageAnchor(
        sessionId: string,
        actualInputTokens: number,
        estimatedTokensAtCall: number,
        trajectoryLen?: number,
    ): void {
        if (!Number.isFinite(actualInputTokens) || actualInputTokens <= 0) {
            return;
        }
        const threadId = toAssistantThreadId(sessionId);
        this.usageAnchors.set(sessionId, {
            actualInputTokens: Math.floor(actualInputTokens),
            estimatedTokensAtCall: Math.max(
                0,
                Number.isFinite(estimatedTokensAtCall) ? Math.floor(estimatedTokensAtCall) : 0,
            ),
            trajectoryLen:
                trajectoryLen !== undefined && Number.isFinite(trajectoryLen)
                    ? Math.max(0, Math.floor(trajectoryLen))
                    : this.trajectoryStore.getMessageCount(threadId),
            updatedAt: this.now(),
        });
    }

    /** Retrieve the current in-memory usage calibration anchor for `sessionId`, if any. */
    public getUsageAnchor(sessionId: string): AssistantUsageAnchor | null {
        const anchor = this.usageAnchors.get(sessionId);
        return anchor ? { ...anchor } : null;
    }

    /** Reset the usage calibration anchor (called on compact, edit, retract, regenerate, clear). */
    public resetUsageAnchor(sessionId: string): void {
        this.usageAnchors.delete(sessionId);
    }

    /**
     * Calibrated token estimate:
     * `max(estimatedTotal, anchorActual + (estimatedTotal - anchorEstimated))`
     */
    public estimateCalibratedTokens(sessionId: string, estimatedTotal: number): number {
        const base = Math.max(0, Number.isFinite(estimatedTotal) ? Math.floor(estimatedTotal) : 0);
        const anchor = this.usageAnchors.get(sessionId);
        if (!anchor) {
            return base;
        }
        const calibrated = anchor.actualInputTokens + (base - anchor.estimatedTokensAtCall);
        return Math.max(base, calibrated);
    }

    /**
     * Compute real-time calibrated token status, severity level, foldable tool count,
     * and summary preview for `sessionId` against the resolved `EffectiveContextBudget`.
     */
    public getSessionTokenStatus(
        sessionId: string,
        budget: EffectiveContextBudget,
        extra?: AssistantSessionTokenStatusExtra,
    ): AssistantSessionTokenStatus | null {
        if (!this.sessions.has(sessionId)) {
            return null;
        }

        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        const layer0 = extra?.layer0 ?? frozen?.messages ?? [];
        const tools = extra?.tools ?? frozen?.tools ?? [];
        const layer1 = this.trajectoryStore.getMessages(threadId);
        const inFlight = extra?.inFlightMessages ?? [];
        const tail = extra?.tailMessages ?? [];

        const estimatedTotal = estimateRequestTokens(
            [...layer0, ...layer1, ...inFlight, ...tail],
            tools,
        );
        const currentTokens = this.estimateCalibratedTokens(sessionId, estimatedTotal);
        const contextLimit = Math.max(1, Math.floor(budget.safeInputBudget));
        const highWatermark = Math.max(1, Math.floor(budget.autoHighWatermark));
        const lowWatermark = Math.max(1, Math.floor(budget.autoLowWatermark));
        const usagePercent = Math.min(
            100,
            Math.max(0, Math.round((currentTokens / contextLimit) * 100)),
        );

        let level: AssistantTokenLevel = 'normal';
        if (usagePercent >= 90 || currentTokens >= highWatermark) {
            level = 'danger';
        } else if (usagePercent >= 70) {
            level = 'warning';
        }

        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const { headerMessages, turns } = groupLayer1Turns(
            layer1,
            headerCount > 0 ? headerCount : undefined,
        );

        const keepRecentTurns = extra?.keepRecentTurns ?? ASSISTANT_DEFAULT_KEEP_RECENT_TURNS;
        const foldThresholdChars = extra?.foldThresholdChars ?? ASSISTANT_FOLD_THRESHOLD_CHARS;
        const foldableToolResultCount = countFoldableToolResults(
            turns,
            keepRecentTurns,
            foldThresholdChars,
        );

        const archivedChunks = this.trajectoryStore.getArchivedUpToChunk(threadId);
        const compactedCount = Math.max(
            archivedChunks,
            this.compactionCycleCounts.get(sessionId) ?? 0,
        );

        const rawSummary = extractExistingSummaryBody(headerMessages);
        const summaryPreview = rawSummary
            ? rawSummary.length > MAX_SUMMARY_PREVIEW_CHARS
                ? `${rawSummary.slice(0, MAX_SUMMARY_PREVIEW_CHARS - 1).trimEnd()}…`
                : rawSummary
            : undefined;

        return {
            sessionId,
            currentTokens,
            contextLimit,
            highWatermark,
            lowWatermark,
            usagePercent,
            level,
            activeTurnCount: turns.length,
            activeMessageCount: layer1.length,
            foldableToolResultCount,
            compactedCount,
            ...(summaryPreview ? { summaryPreview } : {}),
            ...(extra?.isCompacting !== undefined ? { isCompacting: extra.isCompacting } : {}),
        };
    }

    /**
     * Three-stage lossless compaction for `assistant:<sessionId>`:
     * - Stage 1: In-place fold stale large (`> 400` chars) `role === 'tool'` results while preserving `toolCallId` pairing.
     * - Stage 2: Cut earliest complete turns (via `groupLayer1Turns`, keeping >= 1 latest turn), persist raw archive
     *   to `/side/.assistant-archive/<sessionId>/chunk-NNN.md` when archiver is available, and generate structured
     *   handoff summary via LLM (with deterministic fallback on any failure/timeout).
     * - Stage 3: Preserve 100% of UI `session.messages`, attach `compactionNotice`, and reset usage calibration anchor.
     */
    public async compactSession(
        sessionId: string,
        options: AssistantCompactSessionOptions = {},
    ): Promise<AssistantCompactReport> {
        const now = this.now();
        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        const layer0 = options.layer0 ?? frozen?.messages ?? [];
        const tools = options.tools ?? frozen?.tools ?? [];
        const layer1 = this.trajectoryStore.getMessages(threadId);

        const mode = options.mode ?? 'auto';
        const reason: NonNullable<AssistantCompactReport['reason']> =
            options.reason ?? (options.force === false ? 'auto_watermark' : 'manual');
        const force = options.force ?? (reason !== 'auto_watermark');
        const watermark = options.watermark ?? this.defaultWatermark;
        const targetLowTokens = Math.max(1, Math.floor(options.targetLowTokens ?? watermark.low));
        const keepRecentTurns = Math.max(
            0,
            Math.floor(options.keepRecentTurns ?? ASSISTANT_DEFAULT_KEEP_RECENT_TURNS),
        );
        const foldThresholdChars = Math.max(
            1,
            Math.floor(options.foldThresholdChars ?? ASSISTANT_FOLD_THRESHOLD_CHARS),
        );
        const focusInstruction = options.focusInstruction?.trim() || undefined;

        const estimatedTokensBefore = estimateRequestTokens([...layer0, ...layer1], tools);
        const tokensBefore = this.estimateCalibratedTokens(sessionId, estimatedTokensBefore);

        if (!force && tokensBefore <= watermark.high) {
            return {
                compacted: false,
                reason: 'below_threshold',
                tokensBefore,
                tokensAfter: tokensBefore,
                foldedToolResults: 0,
                archivedTurns: 0,
                summaryMode: 'none',
                timestamp: now,
            };
        }

        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);
        const { headerMessages, turns } = groupLayer1Turns(
            layer1,
            headerCount > 0 ? headerCount : undefined,
        );

        if (turns.length === 0) {
            return {
                compacted: false,
                reason: 'nothing_to_compact',
                tokensBefore,
                tokensAfter: tokensBefore,
                foldedToolResults: 0,
                archivedTurns: 0,
                summaryMode: 'none',
                timestamp: now,
            };
        }

        const isUrgent =
            reason === 'preflight' || reason === 'overflow_recovery' || mode === 'full';

        // Stage 1: In-place fold stale large tool results without deleting tool nodes or breaking pairing.
        const stage1 = foldStaleToolResultsAcrossTurns(turns, {
            keepRecentTurns,
            foldThresholdChars,
            urgent: isUrgent,
            foldAll: false,
        });

        let workingTurns = stage1.turns;
        let foldedToolResults = stage1.foldedCount;
        let tokensAfterStage1 = estimateRequestTokens(
            [...layer0, ...headerMessages, ...workingTurns.flatMap((t) => t.messages)],
            tools,
        );

        if (reason === 'overflow_recovery' && tokensAfterStage1 > targetLowTokens) {
            const emergencyFold = foldStaleToolResultsAcrossTurns(workingTurns, {
                keepRecentTurns: 0,
                foldThresholdChars,
                urgent: true,
                foldAll: true,
            });
            workingTurns = emergencyFold.turns;
            foldedToolResults += emergencyFold.foldedCount;
            tokensAfterStage1 = estimateRequestTokens(
                [...layer0, ...headerMessages, ...workingTurns.flatMap((t) => t.messages)],
                tools,
            );
        } else if (mode === 'auto' && !isUrgent && tokensAfterStage1 > targetLowTokens) {
            const urgentFold = foldStaleToolResultsAcrossTurns(workingTurns, {
                keepRecentTurns,
                foldThresholdChars,
                urgent: true,
                foldAll: false,
            });
            workingTurns = urgentFold.turns;
            foldedToolResults += urgentFold.foldedCount;
            tokensAfterStage1 = estimateRequestTokens(
                [...layer0, ...headerMessages, ...workingTurns.flatMap((t) => t.messages)],
                tools,
            );
        }

        const commitFoldOnly = (): AssistantCompactReport => {
            if (foldedToolResults === 0) {
                return {
                    compacted: false,
                    reason: 'nothing_to_compact',
                    tokensBefore,
                    tokensAfter: tokensBefore,
                    foldedToolResults: 0,
                    archivedTurns: 0,
                    summaryMode: 'none',
                    timestamp: now,
                };
            }

            const compactedMessages: CanonicalMessage[] = [
                ...headerMessages,
                ...workingTurns.flatMap((t) => t.messages),
            ];
            const turnEndCounts: number[] = [];
            let runningLen = headerMessages.length;
            for (const turn of workingTurns) {
                runningLen += turn.messages.length;
                turnEndCounts.push(runningLen);
            }

            this.trajectoryStore.applyCompaction(
                {
                    compactedMessages,
                    archivedUpToChunk: prevChunk,
                    compactionHeaderCount: headerMessages.length,
                    turnEndCounts,
                },
                threadId,
            );

            this.resetUsageAnchor(sessionId);
            this.incrementCompactionCycle(sessionId);

            const tokensAfter = estimateRequestTokens([...layer0, ...compactedMessages], tools);
            const report: AssistantCompactReport = {
                compacted: true,
                reason,
                tokensBefore,
                tokensAfter,
                foldedToolResults,
                archivedTurns: 0,
                summaryMode: 'fold_only',
                timestamp: now,
            };

            if (options.attachNotice !== false) {
                this.attachCompactionNoticeToLatestMessage(sessionId, {
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults,
                    archivedTurns: 0,
                    summaryMode: 'fold_only',
                    ...(focusInstruction ? { focusInstruction } : {}),
                    timestamp: now,
                });
            }

            return report;
        };

        // If fold_only, or auto already met targetLowTokens, or only 1 turn exists -> finish after Stage 1.
        if (
            mode === 'fold_only'
            || (mode === 'auto' && tokensAfterStage1 <= targetLowTokens)
            || workingTurns.length <= 1
        ) {
            return commitFoldOnly();
        }

        // Stage 2: Cut earliest complete turns (keeping at least 1 latest complete turn).
        const priorSummary = extractExistingSummaryBody(headerMessages);
        const maxArchive = workingTurns.length - 1;
        let archiveCount = mode === 'full' ? maxArchive : 1;

        if (mode !== 'full') {
            const calcProjected = (count: number): number => {
                const draftSummary = buildDeterministicSummary(workingTurns.slice(0, count), {
                    priorSummary,
                    focusInstruction,
                });
                const hdr: CanonicalMessage = {
                    role: 'system',
                    content: `${ASSISTANT_SUMMARY_TAG}\n${draftSummary}\n</assistant-history-summary>`,
                };
                const retained = workingTurns.slice(count).flatMap((t) => t.messages);
                return estimateRequestTokens([...layer0, hdr, ...retained], tools);
            };

            let projected = calcProjected(archiveCount);
            while (projected > targetLowTokens && archiveCount < maxArchive) {
                archiveCount += 1;
                projected = calcProjected(archiveCount);
            }
        }

        const archivedTurns = workingTurns.slice(0, archiveCount);
        const retainedTurns = workingTurns.slice(archiveCount);
        const nextChunkNumber = prevChunk + 1;

        // Persist raw archive transcript when archiveWriter is available.
        let archivedChunkPath: string | undefined;
        const archiveWriter = options.archiveWriter ?? this.defaultArchiveWriter;
        if (archiveWriter) {
            const candidatePath = formatArchiveChunkPath(sessionId, nextChunkNumber);
            const rawTranscript = formatArchivedTurnsTranscript(archivedTurns, {
                sessionId,
                chunkNumber: nextChunkNumber,
                timestamp: now,
            });
            try {
                await archiveWriter(candidatePath, rawTranscript);
                archivedChunkPath = candidatePath;
            } catch (err) {
                if (options.signal?.aborted && isAbortErrorLike(err)) {
                    throw err;
                }
                // Non-fatal archive write failure must never block compaction.
            }
        }

        // Generate structured handoff summary (LLM with guaranteed deterministic fallback).
        let summaryText = '';
        let summaryMode: 'llm' | 'deterministic' = 'deterministic';

        if (
            options.useLLMSummary !== false
            && typeof options.summarizeWithLLM === 'function'
            && reason !== 'overflow_recovery'
        ) {
            if (options.signal?.aborted) {
                const abortErr = new Error('Assistant compaction aborted');
                abortErr.name = 'AbortError';
                throw abortErr;
            }
            try {
                const llmSummary = await options.summarizeWithLLM({
                    transcript: formatTranscriptForLLMSummary(archivedTurns),
                    ...(priorSummary ? { previousSummary: priorSummary } : {}),
                    ...(focusInstruction ? { focusInstruction } : {}),
                    ...(options.signal ? { signal: options.signal } : {}),
                });
                const trimmed = typeof llmSummary === 'string' ? llmSummary.trim() : '';
                if (trimmed) {
                    summaryText = trimmed;
                    summaryMode = 'llm';
                }
            } catch (err) {
                if (options.signal?.aborted && isAbortErrorLike(err)) {
                    throw err;
                }
                // Fall back deterministically so compaction never fails due to LLM summary errors.
            }
        }

        if (!summaryText) {
            summaryText = buildDeterministicSummary(archivedTurns, {
                priorSummary,
                focusInstruction,
                archivedChunkPath,
            });
            summaryMode = 'deterministic';
        }

        const archiveFooter =
            archivedChunkPath && !summaryText.includes(archivedChunkPath)
                ? `\n\n[Archived transcript: ${archivedChunkPath}]`
                : '';
        const summaryMsg: CanonicalMessage = {
            role: 'system',
            content: `${ASSISTANT_SUMMARY_TAG}\n${summaryText}${archiveFooter}\n</assistant-history-summary>`,
        };

        const compactedMessages: CanonicalMessage[] = [
            summaryMsg,
            ...retainedTurns.flatMap((t) => t.messages),
        ];
        const turnEndCounts: number[] = [];
        let runningLen = 1;
        for (const turn of retainedTurns) {
            runningLen += turn.messages.length;
            turnEndCounts.push(runningLen);
        }

        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: nextChunkNumber,
                compactionHeaderCount: 1,
                turnEndCounts,
            },
            threadId,
        );

        this.recordCompactionUiAnchor(sessionId, {
            archiveCount,
            hadPriorHeader: headerMessages.length > 0,
            retainedTurns,
        });
        this.resetUsageAnchor(sessionId);
        this.incrementCompactionCycle(sessionId);

        const tokensAfter = estimateRequestTokens([...layer0, ...compactedMessages], tools);

        // Stage 3: NEVER delete UI session.messages; attach compactionNotice metadata.
        if (options.attachNotice !== false) {
            this.attachCompactionNoticeToLatestMessage(sessionId, {
                tokensBefore,
                tokensAfter,
                foldedToolResults,
                archivedTurns: archiveCount,
                summaryMode,
                summaryText,
                ...(focusInstruction ? { focusInstruction } : {}),
                ...(archivedChunkPath ? { archivedChunkPath } : {}),
                timestamp: now,
            });
        }

        return {
            compacted: true,
            reason,
            tokensBefore,
            tokensAfter,
            foldedToolResults,
            archivedTurns: archiveCount,
            ...(archivedChunkPath ? { archivedChunkPath } : {}),
            summaryMode,
            summaryText,
            timestamp: now,
        };
    }

    /**
     * Synchronous hysteresis watermark compaction for `assistant:<sessionId>` (backwards-compatible).
     * Runs Stage 1 tool folding + Stage 2 deterministic turn archiving, never splits `tool_calls -> tool`
     * turn groups, never deletes UI messages, and resets the calibrated usage anchor.
     */
    public compactIfNeeded(
        sessionId: string,
        options?: { watermark?: { high: number; low: number }; force?: boolean },
    ): AssistantCompactionResult {
        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        const layer0 = frozen?.messages ?? [];
        const tools = frozen?.tools ?? [];
        const layer1 = this.trajectoryStore.getMessages(threadId);

        const watermark = options?.watermark ?? this.defaultWatermark;
        const estimatedTokensBefore = estimateRequestTokens([...layer0, ...layer1], tools);

        if (!options?.force && estimatedTokensBefore <= watermark.high) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
            };
        }

        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);
        const { headerMessages, turns } = groupLayer1Turns(
            layer1,
            headerCount > 0 ? headerCount : undefined,
        );

        if (turns.length === 0) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
            };
        }

        // Stage 1: fold stale large tool outputs first
        const stage1 = foldStaleToolResultsAcrossTurns(turns, {
            keepRecentTurns: ASSISTANT_DEFAULT_KEEP_RECENT_TURNS,
            foldThresholdChars: ASSISTANT_FOLD_THRESHOLD_CHARS,
            urgent: false,
        });
        const workingTurns = stage1.turns;
        const tokensAfterStage1 = estimateRequestTokens(
            [...layer0, ...headerMessages, ...workingTurns.flatMap((t) => t.messages)],
            tools,
        );

        if (tokensAfterStage1 <= watermark.low || workingTurns.length <= 1) {
            if (stage1.foldedCount === 0) {
                return {
                    compacted: false,
                    estimatedTokensBefore,
                    estimatedTokensAfter: estimatedTokensBefore,
                    archivedTurnCount: 0,
                };
            }
            const compactedMessages: CanonicalMessage[] = [
                ...headerMessages,
                ...workingTurns.flatMap((t) => t.messages),
            ];
            const turnEndCounts: number[] = [];
            let runningLen = headerMessages.length;
            for (const turn of workingTurns) {
                runningLen += turn.messages.length;
                turnEndCounts.push(runningLen);
            }
            this.trajectoryStore.applyCompaction(
                {
                    compactedMessages,
                    archivedUpToChunk: prevChunk,
                    compactionHeaderCount: headerMessages.length,
                    turnEndCounts,
                },
                threadId,
            );
            this.resetUsageAnchor(sessionId);
            this.incrementCompactionCycle(sessionId);
            const estimatedTokensAfter = estimateRequestTokens(
                [...layer0, ...compactedMessages],
                tools,
            );
            return {
                compacted: true,
                estimatedTokensBefore,
                estimatedTokensAfter,
                archivedTurnCount: 0,
            };
        }

        const priorSummary = extractExistingSummaryBody(headerMessages);
        const maxArchive = workingTurns.length - 1;
        let archiveCount = 1;
        let summaryText = buildDeterministicSummary(workingTurns.slice(0, archiveCount), {
            priorSummary,
        });
        let summaryMsg: CanonicalMessage = {
            role: 'system',
            content: `${ASSISTANT_SUMMARY_TAG}\n${summaryText}\n</assistant-history-summary>`,
        };

        const calcTokens = (count: number, hdr: CanonicalMessage): number => {
            const retained = workingTurns.slice(count).flatMap((t) => t.messages);
            return estimateRequestTokens([...layer0, hdr, ...retained], tools);
        };

        let projected = calcTokens(archiveCount, summaryMsg);
        while (projected > watermark.low && archiveCount < maxArchive) {
            archiveCount += 1;
            summaryText = buildDeterministicSummary(workingTurns.slice(0, archiveCount), {
                priorSummary,
            });
            summaryMsg = {
                role: 'system',
                content: `${ASSISTANT_SUMMARY_TAG}\n${summaryText}\n</assistant-history-summary>`,
            };
            projected = calcTokens(archiveCount, summaryMsg);
        }

        const retainedTurns = workingTurns.slice(archiveCount);
        const compactedMessages: CanonicalMessage[] = [
            summaryMsg,
            ...retainedTurns.flatMap((t) => t.messages),
        ];
        const turnEndCounts: number[] = [];
        let runningLen = 1;
        for (const turn of retainedTurns) {
            runningLen += turn.messages.length;
            turnEndCounts.push(runningLen);
        }

        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: prevChunk + 1,
                compactionHeaderCount: 1,
                turnEndCounts,
            },
            threadId,
        );

        this.recordCompactionUiAnchor(sessionId, {
            archiveCount,
            hadPriorHeader: headerMessages.length > 0,
            retainedTurns,
        });
        this.resetUsageAnchor(sessionId);
        this.incrementCompactionCycle(sessionId);

        const estimatedTokensAfter = estimateRequestTokens(
            [...layer0, ...compactedMessages],
            tools,
        );

        return {
            compacted: true,
            estimatedTokensBefore,
            estimatedTokensAfter,
            archivedTurnCount: archiveCount,
        };
    }

    private recordCompactionUiAnchor(
        sessionId: string,
        params: {
            archiveCount: number;
            hadPriorHeader: boolean;
            retainedTurns: readonly Layer1TurnGroup[];
        },
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        const uiTurns = groupUiMessagesIntoTurns(session.messages);
        if (uiTurns.length === 0) {
            return;
        }

        const prevAnchor = this.compactionAnchors.get(sessionId);
        let newArchivedCount: number;

        if (prevAnchor) {
            newArchivedCount = prevAnchor.archivedUiTurnCount + params.archiveCount;
        } else if (!params.hadPriorHeader) {
            newArchivedCount = params.archiveCount;
        } else {
            // Hydrated trajectory with an existing header and no in-memory anchor:
            // locate the first retained turn in uiTurns to compute exact archived offset.
            const firstRetainedUser = params.retainedTurns[0]?.messages.find((m) => m.role === 'user');
            let offset = -1;
            if (firstRetainedUser) {
                const needle = contentToPlainText(firstRetainedUser.content);
                const approxStart = Math.max(0, uiTurns.length - params.retainedTurns.length - 2);
                const matchesTurnUser = (turn: UiTurnGroup): boolean => {
                    if (!turn.user) {
                        return false;
                    }
                    const turnPlain = contentToPlainText(
                        buildAssistantUserContent(turn.user.content, turn.user.attachments),
                    );
                    return turnPlain === needle || turn.user.content === needle;
                };
                for (let i = approxStart; i < uiTurns.length; i += 1) {
                    if (matchesTurnUser(uiTurns[i])) {
                        offset = i;
                        break;
                    }
                }
                if (offset < 0) {
                    for (let i = 0; i < approxStart; i += 1) {
                        if (matchesTurnUser(uiTurns[i])) {
                            offset = i;
                            break;
                        }
                    }
                }
            }
            newArchivedCount =
                offset >= 0
                    ? offset
                    : Math.max(0, uiTurns.length - params.retainedTurns.length);
        }

        const clampedCount = Math.min(Math.max(0, newArchivedCount), uiTurns.length);
        if (clampedCount <= 0) {
            return;
        }

        this.compactionAnchors.set(sessionId, {
            archivedUiTurnCount: clampedCount,
            archivedTurnFingerprints: uiTurns.slice(0, clampedCount).map(fingerprintUiTurn),
        });
    }

    private incrementCompactionCycle(sessionId: string): void {
        this.compactionCycleCounts.set(
            sessionId,
            (this.compactionCycleCounts.get(sessionId) ?? 0) + 1,
        );
    }

    private attachCompactionNoticeToLatestMessage(
        sessionId: string,
        notice: AssistantCompactionNotice,
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session || session.messages.length === 0) {
            return;
        }
        const lastIdx = session.messages.length - 1;
        session.messages[lastIdx] = {
            ...session.messages[lastIdx],
            compactionNotice: canonicalClone(notice),
        };
        session.updatedAt = this.now();
        this.persist();
    }

    private hydrateFromMetadata(): void {
        if (!this.bridge) {
            return;
        }
        const meta = this.bridge.getMetadata();
        const raw = meta[this.storageKey];
        if (!Array.isArray(raw)) {
            return;
        }
        this.sessions.clear();
        for (const item of raw) {
            if (isValidAssistantSession(item)) {
                this.sessions.set(item.id, cloneSession(item));
            }
        }
    }

    private persist(): void {
        if (!this.bridge || this.persistenceMode === 'memory') {
            return;
        }
        const snapshot = this.listSessions();
        if (this.persistenceMode === 'metadata') {
            const meta = this.bridge.getMetadata();
            meta[this.storageKey] = snapshot;
            this.bridge.saveChatDebounced();
            return;
        }

        const bridge = this.bridge;
        const key = this.storageKey;
        this.persistChain = this.persistChain
            .catch(() => {
                // Keep persistence chain healthy
            })
            .then(async () => {
                await bridge.saveExtensionData(key, snapshot);
            });
    }
}
