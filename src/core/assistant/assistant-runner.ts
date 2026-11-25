import { FinishTurnStreamExtractor } from '@/core/agents';
import type {
    ChatMessageRole,
    HostBridge,
    LLMRequest,
    LLMToolChoice,
    LLMTransport,
} from '@/core/bridge';
import {
    createDefaultSettings,
    normalizeConnection,
    normalizeSettings,
    resolveActivePreset,
    resolveConnection,
    selectPresetBlocksForContext,
} from '@/core/config';
import {
    buildAssistantMacroOverrides,
    estimateMessageTokens,
    isSpillPath,
    renderPromptBlocks,
    renderPromptBlockSync,
    resolveEffectiveContextBudget,
    TrajectoryStore,
    TransientToolSpillStore,
    type EffectiveContextBudget,
    type SurfaceGenerationType,
} from '@/core/context';
import {
    type BuiltinDocEntry,
    defaultDocsRegistry,
    type DocsRegistry,
} from '@/core/docs';
import {
    computeRoundRetryDelayMs,
    delayWithAbort,
    isAbortError,
    isLengthFinishReason,
    isRetryableRoundError,
    isValidJsonObjectString,
    LLMTransportError,
    parseContextOverflowError,
    ROUND_RETRY_ERROR_CODES,
} from '@/core/llm';
import type { TraceLogger } from '@/core/logger';
import { ChatDataStore, DATA_NAMESPACES, MESSAGE_OVERRIDE_KEY } from '@/core/store';
import type { DynamicVariableSchema } from '@/core/tools';
import type {
    ApiConnection,
    AssistantAttachment,
    AssistantActivityStep,
    AssistantCompactOptions,
    AssistantCompactReport,
    AssistantCompactionNotice,
    AssistantErrorCode,
    AssistantInterruptedCheckpoint,
    AssistantMessage,
    AssistantMessageUsage,
    AssistantMode,
    AssistantRetryStatus,
    AssistantSession,
    AssistantSessionTokenStatus,
    AssistantToolCallRecord,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    ChatMessageSnapshot,
    HostCharacterCreatePayload,
    HostCharacterPatch,
    HostExtensionCapabilities,
    HostRegexScript,
    HostSettingsScope,
    MessageTarget,
    PendingApproval,
    Preset,
    RawLoreEntry,
    Settings,
    TavernHelperScriptScope,
    TokenUsage,
    UndoRecord,
} from '@/core/types';
import { canonicalClone, canonicalStringify, normalizeVfsPath } from '@/core/utils';
import { VirtualFileSystem } from '@/core/vfs';
import { ApprovalGate, shouldRequireApproval } from './approval';
import {
    evaluateToolPolicy,
    getAllowedToolsForMode,
    isToolAutoApproved,
    type ToolPolicyResult,
} from './policy';
import { redactString, redactWithReport } from './redact';
import {
    ASSISTANT_FOLD_THRESHOLD_CHARS,
    AssistantSessionStore,
    buildAssistantUserContent,
    formatFoldedAssistantToolPlaceholder,
    isFoldedAssistantToolContent,
    toAssistantThreadId,
    type AssistantArchiveWriter,
    type AssistantLLMSummarizer,
    type AssistantRetractResult,
    type AssistantSessionPatch,
    type CreateAssistantSessionOptions,
} from './session-store';
import { createAdjustTools } from './tools-adjust';
import { createFullAgenticConfigTools, preserveRedactedConnectionSecrets } from './tools-agentic';
import {
    createAdminTierTools,
    createStSyncRuntimeTool,
    resolveHostExtensionCapabilities,
} from './tools-admin';
import { createAuthorTools } from './tools-author';
import {
    createAssistantAbortError,
    createChatReadOnlyTools,
    executeAssistantTool,
    isAssistantAbortError,
    throwIfAssistantAborted,
    toCanonicalAssistantToolSchemas,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';
import {
    createUndoKindDispatcher,
    UndoStore,
    type UndoExecutor,
    type UndoRevertResult,
} from './undo-store';

export interface AssistantRetryOptions {
    /** Maximum automatic retries per LLM round on transient/empty-response errors (default: 2). */
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
}

export interface AssistantRunnerOptions {
    bridge: HostBridge;
    transport: LLMTransport;
    store?: ChatDataStore;
    vfs?: VirtualFileSystem;
    docsRegistry?: DocsRegistry;
    trajectoryStore?: TrajectoryStore;
    sessionStore?: AssistantSessionStore;
    approvalGate?: ApprovalGate;
    undoStore?: UndoStore;
    spillStore?: TransientToolSpillStore;
    maxToolResultBytes?: number;
    compactionSummaryTimeoutMs?: number;
    traceLogger?: TraceLogger;
    settings?: Settings | (() => Settings);
    updateSettings?: (updater: (prev: Settings) => Settings) => Promise<Settings> | Settings;
    resolveConnection?: (connectionId: string) => ApiConnection | undefined;
    getActiveTarget?: () => MessageTarget;
    getVariableSchema?: () => DynamicVariableSchema | undefined;
    getStatusSnapshot?: () => Record<string, unknown>;
    extraTools?: readonly AssistantToolDefinition[];
    /** Optional positive cap on tool-calling rounds per turn; omitted or `<= 0` means unlimited. */
    maxToolRounds?: number;
    autoRetry?: AssistantRetryOptions | false;
    stream?: boolean;
    now?: () => number;
    idGenerator?: () => string;
}

export interface AssistantSendOptions {
    target?: MessageTarget;
    attachments?: AssistantAttachment[];
    onDelta?: (delta: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onRetry?: (status: AssistantRetryStatus) => void;
    onUpdate?: (session: AssistantSession) => void;
    signal?: AbortSignal;
    stream?: boolean;
}

interface SuspendedApprovalContext {
    approvalId: string;
    sessionId: string;
    messageId: string;
    toolCall: CanonicalToolCall;
    policy: ToolPolicyResult;
    target: MessageTarget;
    inFlightMessages: CanonicalMessage[];
}

interface TurnLLMOutput {
    content: string;
    reasoningContent: string;
    toolCalls: CanonicalToolCall[];
    usage: TokenUsage;
    finishReason?: string;
}

const DEFAULT_COMPACTION_SUMMARY_TIMEOUT_MS = 25_000;
const DEFAULT_AUTO_RETRY_OPTIONS: Required<AssistantRetryOptions> = {
    maxRetries: 2,
    initialDelayMs: 1200,
    maxDelayMs: 10_000,
    backoffFactor: 2,
};

const FINISH_TURN_TOOL_NAME = 'finish_turn';

const FINISH_TURN_TOOL_SCHEMA: CanonicalToolSchema = canonicalClone({
    name: FINISH_TURN_TOOL_NAME,
    description: 'Complete the current turn and submit the final result.',
    parameters: {
        type: 'object',
        properties: {
            step_brief: {
                type: 'string',
                description: 'Concise 1-line summary of the reasoning or completed step.',
            },
            response: {
                type: 'string',
                description: 'Final Markdown response to present directly to the user.',
            },
        },
        required: ['step_brief', 'response'],
        propertyOrdering: ['step_brief', 'response'],
        additionalProperties: false,
    },
});

const DEFERRED_FINISH_TURN_PAYLOAD = JSON.stringify({
    ok: false,
    deferred: true,
    message:
        'Other tools ran in this round. Review their outputs (or approval result) first, then call finish_turn in the next round.',
});

function compareCodeUnits(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

function appendFinishTurnTool(
    tools: readonly CanonicalToolSchema[],
): CanonicalToolSchema[] {
    if (tools.some((t) => t.name === FINISH_TURN_TOOL_NAME)) {
        return canonicalClone([...tools]);
    }
    return [...canonicalClone([...tools]), canonicalClone(FINISH_TURN_TOOL_SCHEMA)].sort((a, b) =>
        compareCodeUnits(a.name, b.name),
    );
}

function isTrailingPrefillAssistantMessage(msg: CanonicalMessage | undefined): boolean {
    if (!msg || msg.role !== 'assistant') {
        return false;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
        return false;
    }
    return msg.extraFields?.partial === true || msg.extraFields?.prefix === true;
}

function consumeTrailingPrefill(
    activeTailMessages: CanonicalMessage[],
    inFlightMessages: CanonicalMessage[],
): string {
    if (activeTailMessages.length > 0) {
        const lastTail = activeTailMessages[activeTailMessages.length - 1];
        if (isTrailingPrefillAssistantMessage(lastTail)) {
            const popped = activeTailMessages.pop()!;
            return canonicalContentToPlainText(popped.content);
        }
        return '';
    }
    if (inFlightMessages.length > 0) {
        const lastInFlight = inFlightMessages[inFlightMessages.length - 1];
        if (isTrailingPrefillAssistantMessage(lastInFlight)) {
            const popped = inFlightMessages.pop()!;
            return canonicalContentToPlainText(popped.content);
        }
    }
    return '';
}

function classifyAssistantErrorCode(error: unknown): AssistantErrorCode {
    if (parseContextOverflowError(error) !== null) {
        return 'context_overflow';
    }
    if (
        error instanceof LLMTransportError
        && error.code === ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE
    ) {
        return 'empty_response';
    }
    if (isRetryableRoundError(error)) {
        return 'network';
    }
    return 'generic';
}

function stripTrailingErrorBanner(content: string): string {
    const trimmedEnd = content.trimEnd();
    if (trimmedEnd.startsWith('[Error] ')) {
        return '';
    }
    const idx = trimmedEnd.lastIndexOf('\n\n[Error] ');
    if (idx >= 0) {
        return trimmedEnd.slice(0, idx);
    }
    return content;
}

function summarizeLegacyToolCalls(toolCalls: readonly AssistantToolCallRecord[]): string {
    const lines = toolCalls.map((tc) => {
        const statusLabel = tc.status === 'error' ? '失败' : '成功';
        const args = tc.argsSummary ? ` args=${tc.argsSummary}` : '';
        const res = tc.resultSummary ? ` -> ${tc.resultSummary}` : '';
        return `- ${tc.name} [${statusLabel}]${args}${res}`;
    });
    return [
        '[系统恢复提示：上一轮工具调用已完成如下操作，但回复在生成正文前中断，请基于这些已有结果直接继续完成回答（避免无意义重复查询）：]',
        ...lines,
    ].join('\n');
}

function canonicalContentToPlainText(content: CanonicalMessage['content']): string {
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

function buildInFlightToolCallMap(
    messages: readonly CanonicalMessage[],
): Map<string, CanonicalToolCall> {
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

function extractInFlightToolLabel(toolCall?: CanonicalToolCall): string {
    if (!toolCall) {
        return 'output';
    }
    const args = safeParseJsonObject(toolCall.arguments);
    for (const key of ['path', 'keyPath', 'bookName', 'scope', 'name', 'query', 'chid', 'uid']) {
        const val = args[key];
        if (typeof val === 'string' && val.trim()) {
            const clean = val.replace(/\s+/g, ' ').trim();
            return clean.length > 48 ? `${clean.slice(0, 45)}...` : clean;
        }
        if (typeof val === 'number' && Number.isFinite(val)) {
            return `${key}=${val}`;
        }
    }
    return 'output';
}

/**
 * Fold oversized `role === 'tool'` messages inside `inFlightMessages` IN-PLACE,
 * keeping `toolCallId`, `toolName`, and `assistant.toolCalls` pairing 100% intact.
 */
function foldInFlightToolMessages(
    inFlightMessages: CanonicalMessage[],
    options: { keepRecentRounds: number; foldThresholdChars?: number },
): number {
    const threshold = options.foldThresholdChars ?? ASSISTANT_FOLD_THRESHOLD_CHARS;
    const toolCallMap = buildInFlightToolCallMap(inFlightMessages);
    let totalRounds = 0;
    const msgRound: number[] = new Array<number>(inFlightMessages.length).fill(-1);

    for (let i = 0; i < inFlightMessages.length; i += 1) {
        const msg = inFlightMessages[i];
        if (msg.role === 'assistant' && msg.toolCalls?.length) {
            totalRounds += 1;
        } else if (msg.role === 'tool') {
            msgRound[i] = Math.max(0, totalRounds - 1);
        }
    }

    const cutoffRound =
        options.keepRecentRounds <= 0
            ? Number.POSITIVE_INFINITY
            : totalRounds - options.keepRecentRounds;
    if (cutoffRound <= 0) {
        return 0;
    }

    let folded = 0;
    for (let i = 0; i < inFlightMessages.length; i += 1) {
        const msg = inFlightMessages[i];
        if (msg.role !== 'tool' || msgRound[i] >= cutoffRound) {
            continue;
        }
        const rawText = canonicalContentToPlainText(msg.content);
        if (rawText.length <= threshold || isFoldedAssistantToolContent(rawText)) {
            continue;
        }
        const matchedCall = msg.toolCallId ? toolCallMap.get(msg.toolCallId) : undefined;
        const toolName = msg.toolName || matchedCall?.name || 'tool';
        const label = extractInFlightToolLabel(matchedCall);
        inFlightMessages[i] = {
            ...canonicalClone(msg),
            content: formatFoldedAssistantToolPlaceholder(toolName, label, rawText.length),
        };
        folded += 1;
    }

    return folded;
}

/**
 * Emergency in-place crop of oversized `role === 'tool'` messages in `inFlightMessages`
 * after an upstream `ContextOverflowError`. Replaces ONLY `content`, NEVER deleting tool nodes
 * or altering `toolCallId` / `toolName` pairing.
 */
function cropInFlightToolMessagesForOverflow(
    inFlightMessages: CanonicalMessage[],
    options: { limitTokens: number },
): number {
    const cropWithMinChars = (minChars: number): number => {
        let cropped = 0;
        for (let i = 0; i < inFlightMessages.length; i += 1) {
            const msg = inFlightMessages[i];
            if (msg.role !== 'tool') {
                continue;
            }
            const rawText = canonicalContentToPlainText(msg.content);
            if (rawText.length <= minChars || rawText.startsWith('[输出因触发模型上下文上限')) {
                continue;
            }
            const origTokens = estimateMessageTokens(msg);
            inFlightMessages[i] = {
                ...canonicalClone(msg),
                content: `[输出因触发模型上下文上限 (${options.limitTokens} tokens) 已被自动裁剪；原输出约 ${origTokens} tokens (${rawText.length} 字符)。请改用指定 keyPath / bookName / start_line-end_line 分段精确查询]`,
            };
            cropped += 1;
        }
        return cropped;
    };

    const primaryCropped = cropWithMinChars(ASSISTANT_FOLD_THRESHOLD_CHARS);
    if (primaryCropped > 0) {
        return primaryCropped;
    }
    return cropWithMinChars(200);
}

function buildCompactionSummaryMessages(input: {
    transcript: string;
    previousSummary?: string;
    focusInstruction?: string;
}): CanonicalMessage[] {
    const systemPrompt = [
        '你是一个负责压缩对话轨迹的上下文交接摘要助手。请将待归档的对话与工具调用记录提炼为紧凑、准确、无虚构的结构化交接摘要。',
        '请严格按以下 4 个小节输出（每节用简洁要点，不要照抄大段原始文件内容）：',
        '1. 用户核心目标与当前进度',
        '2. 已修改或读取的关键文件与对象',
        '3. 已确认的约束与踩坑经验',
        '4. 待继续步骤',
    ].join('\n');

    const userSections: string[] = [];
    if (input.focusInstruction?.trim()) {
        userSections.push(`【必须重点保留的内容】\n${input.focusInstruction.trim()}`);
    }
    if (input.previousSummary?.trim()) {
        userSections.push(`【既有交接摘要】\n${input.previousSummary.trim()}`);
    }
    userSections.push(`【待归档对话记录】\n${input.transcript}`);

    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userSections.join('\n\n') },
    ];
}

function normalizeUsage(partial?: Partial<TokenUsage>): TokenUsage {
    const inputTokens = partial?.inputTokens ?? 0;
    const cachedTokens = partial?.cachedTokens ?? 0;
    const outputTokens = partial?.outputTokens ?? 0;
    const totalTokens = partial?.totalTokens ?? inputTokens + outputTokens;
    const cacheHitRate =
        partial?.cacheHitRate ?? (inputTokens > 0 ? cachedTokens / inputTokens : 0);
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens,
        cacheHitRate,
    };
}

function addTokenUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
    const inputTokens = acc.inputTokens + next.inputTokens;
    const cachedTokens = acc.cachedTokens + next.cachedTokens;
    const outputTokens = acc.outputTokens + next.outputTokens;
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    };
}

function toAssistantMessageUsage(usage: TokenUsage): AssistantMessageUsage {
    const cacheRate =
        usage.inputTokens > 0
            ? `${((Math.min(usage.inputTokens, usage.cachedTokens) / usage.inputTokens) * 100).toFixed(1)}%`
            : '0.0%';
    return {
        inputTokens: usage.inputTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        cacheRate,
    };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Return empty object; tool schema validation will surface structured errors.
    }
    return {};
}

function buildAssistantSystemPrompt(
    mode: AssistantMode,
    stAdminEnabled: boolean,
    capabilities?: HostExtensionCapabilities,
    externalDocs: readonly BuiltinDocEntry[] = [],
): string {
    const hasEjs = Boolean(capabilities?.ejsTemplate);
    const hasThScripts = Boolean(capabilities?.tavernHelperScripts);
    const decoratorNote = hasEjs
        ? 'raw @@ decorators and <% ... %> EJS are preserved verbatim'
        : 'raw @@ decorators are preserved verbatim';

    const lines: string[] = [
        'You are the ST-Agentic Off-Mainline Assistant operating outside the mainline RP context (0 mainline token overhead).',
        `Current capability mode: ${mode}${mode === 'full' ? ` (stAdminEnabled=${String(stAdminEnabled)})` : ''}.`,
        'Use the provided tools directly to inspect context, diagnose issues, and apply authorized changes.',
    ];
    if (mode === 'chat') {
        lines.push('Mode rule: STRICTLY READ-ONLY. Never attempt mutations.');
    } else if (mode === 'adjust') {
        lines.push(
            'Mode rule: Current-chat adjustments allowed (/workspace/**, /state/**, /lorebooks/**, /side/**, and creating, editing, deleting, hiding, or display-overriding chat messages via chat_create_message, chat_edit_message, chat_delete_message, chat_toggle_hide_message, message_override_display). Deleting chat messages asks for inline confirmation unless auto-approved in this session. Pre-write UndoRecords are captured automatically.',
        );
    } else if (mode === 'author') {
        lines.push(
            `Mode rule: Authoring mode enabled. You may edit the active character card, primary World Info (${decoratorNote}), and character-scoped regex, and call chat_reload_messages for immediate UI re-rendering. Permanent mutations require user diff approval.`,
        );
    } else if (mode === 'full') {
        if (stAdminEnabled) {
            const installedExtParts: string[] = [];
            if (hasThScripts) {
                installedExtParts.push('live JS-Slash-Runner scripts (tavern_helper_scripts_read/upsert)');
            }
            if (hasEjs) {
                installedExtParts.push('ST-Prompt-Template (EjsTemplate) live sync');
            }
            const extClause =
                installedExtParts.length > 0 ? `${installedExtParts.join(', ')}, ` : '';
            lines.push(
                `Mode rule: Full control + ST Admin enabled. You can edit enabled World Info books, ST-Agentic own settings/presets/prompts/agents/triggers/custom_tools/regex/connections (agentic_*), ${extClause}runtime sync (st_sync_runtime), displayed message reload (chat_reload_messages), and SillyTavern global assets/settings/presets/regex/slash/import. High-risk destructive, connection, settings, preset, global regex${hasThScripts ? ', TavernHelper script' : ''}, slash, and import operations always require mandatory manual confirmation.`,
            );
        } else {
            lines.push(
                `Mode rule: Full control over all enabled World Info books (${decoratorNote}) and ST-Agentic own settings/presets/prompts/agents/triggers/custom_tools/regex/connections (agentic_config_read, agentic_settings_patch, agentic_preset_component_upsert/delete, agentic_connection_upsert) plus chat_reload_messages. Permanent writes require user approval.`,
            );
        }
    }
    if (mode !== 'chat') {
        lines.push(
            'Workspace Progressive-Disclosure Convention: Keep persistent user rules/directives under /workspace/AGENTS.md (thin index + core rules, saved chat-wide across swipes; modifying AGENTS.md ALWAYS requires explicit user confirmation). Put lengthy or topic-specific guidelines under /workspace/docs/<topic>.md (saved chat-wide across swipes, directly editable with UndoRecord) and link them from /workspace/AGENTS.md with a brief "when to read" trigger. Use /workspace/shared/<name>.md for cross-agent collaboration/handoff notes.',
        );
    }
    lines.push(
        'Built-in Reference Docs (/docs/, read-only): Before authoring triggers/scripts/tools or routing SillyTavern native assets, read the relevant guide directly with read_file instead of guessing:',
        `- /docs/st-native.md — SillyTavern native asset tools (cards, World Info, regex, ${hasThScripts ? 'TavernHelper scripts, ' : ''}settings/presets, chat messages, slash), mode gates, VFS overlay vs permanent writes, and unified 3-scope variables`,
        '- /docs/triggers.md — TriggerRule phases/barriers/conditions, @@trigger, and all @@ decorators',
        '- /docs/scripts.md — @@script deterministic JS scripts and sandbox APIs',
        '- /docs/js-tools.md — defineTool / @@tool / ctx.* full API and slash_bridge',
        `- /docs/ejs-macros.md — PromptBlock, macros, VFS mounts${hasEjs ? ', and EJS (<% ... %>, @@*_ejs)' : ''}`,
    );
    if (hasEjs) {
        lines.push(
            '- /docs/ejs-reference.md — ST-Prompt-Template full functions/constants/16 decorators/[GENERATE]/[RENDER]/@INJECT reference',
        );
    }
    if (hasThScripts || hasEjs) {
        const uiParts: string[] = [];
        if (hasThScripts) {
            uiParts.push('JS-Slash-Runner');
        }
        if (hasEjs) {
            uiParts.push('@@render_after');
        }
        lines.push(
            `- /docs/status-ui.md — ${uiParts.join(' & ')} status bar / custom HTML UI rendering and iframe variable APIs`,
        );
    }
    lines.push(
        '- /docs/agentic-config.md — agentic_config_read / agentic_settings_patch / agentic_preset_component_* / agentic_connection_upsert',
    );
    if (externalDocs.length > 0) {
        const MAX_INDEXED_EXTERNAL_DOCS = 24;
        lines.push('External Extension Docs (/docs/extensions/, read-only):');
        for (const doc of externalDocs.slice(0, MAX_INDEXED_EXTERNAL_DOCS)) {
            const desc = doc.summary || doc.title;
            lines.push(`- ${doc.path} — ${desc}`);
        }
        if (externalDocs.length > MAX_INDEXED_EXTERNAL_DOCS) {
            lines.push(
                `- ... (${externalDocs.length - MAX_INDEXED_EXTERNAL_DOCS} more; call list_dir('/docs/extensions') to view all)`,
            );
        }
    }
    return lines.join('\n');
}

/**
 * Create the complete `UndoExecutor` handling all 7 `UndoKind`s by executing exact
 * reverse operations against `HostBridge`, `ChatDataStore`, `VirtualFileSystem`,
 * `HostAuthorBridge`, and `HostAdminBridge`.
 */
export function createAssistantUndoExecutor(deps: {
    bridge: HostBridge;
    store: ChatDataStore;
    vfs: VirtualFileSystem;
    updateSettings?: (updater: (prev: Settings) => Settings) => Promise<Settings> | Settings;
}): UndoExecutor {
    const { bridge, store, vfs, updateSettings } = deps;

    return createUndoKindDispatcher({
        chat_message: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            if (action === 'create') {
                if (!bridge.deleteChatMessage) {
                    throw new Error('HostBridge.deleteChatMessage is required to undo chat_create_message.');
                }
                const messageId = Number(snap.messageId ?? record.target?.messageId);
                const chat = bridge.getChat();
                if (!Number.isInteger(messageId) || messageId < 0 || messageId >= chat.length) {
                    throw new Error(
                        `Cannot undo chat_create_message: message #${String(messageId)} not found in chat (length=${chat.length}).`,
                    );
                }
                await bridge.deleteChatMessage(messageId, { emitEvent: true });
                return;
            }
            if (action === 'delete') {
                if (!bridge.createChatMessage) {
                    throw new Error('HostBridge.createChatMessage is required to undo chat_delete_message.');
                }
                const deletedMessages = Array.isArray(snap.deletedMessages)
                    ? (snap.deletedMessages as Array<{
                          messageId: number;
                          snapshot: ChatMessageSnapshot;
                          rawMessage?: Record<string, unknown>;
                      }>)
                    : [];
                if (deletedMessages.length === 0) {
                    throw new Error('Missing deletedMessages in chat_delete_message undo snapshot.');
                }
                const sorted = [...deletedMessages].sort((a, b) => a.messageId - b.messageId);
                for (const item of sorted) {
                    const msgSnap = item.snapshot;
                    const role: ChatMessageRole = msgSnap.isUser
                        ? 'user'
                        : msgSnap.isSystem
                          ? 'system'
                          : 'assistant';
                    const currentLen = bridge.getChat().length;
                    const insertAt = Math.max(0, Math.min(item.messageId, currentLen));
                    await bridge.createChatMessage(
                        {
                            role,
                            content: msgSnap.mes,
                            name: msgSnap.name,
                            insertAt,
                            hidden: Boolean(msgSnap.isSystem),
                            ...(msgSnap.swipeId !== undefined ? { swipeId: msgSnap.swipeId } : {}),
                            ...(msgSnap.swipes ? { swipes: msgSnap.swipes } : {}),
                            ...(msgSnap.swipeInfo ? { swipeInfo: msgSnap.swipeInfo } : {}),
                            ...(msgSnap.sendDate !== undefined ? { sendDate: msgSnap.sendDate } : {}),
                            ...(msgSnap.extra ? { extra: msgSnap.extra } : {}),
                            ...(msgSnap.variables ? { variables: msgSnap.variables } : {}),
                            ...(item.rawMessage ? { rawFields: item.rawMessage } : {}),
                        },
                        { emitEvent: true },
                    );
                }
                return;
            }
            if (action === 'edit') {
                const target = (snap.target ?? record.target) as MessageTarget | undefined;
                if (!target) {
                    throw new Error('Missing target in chat_message undo snapshot.');
                }
                const prevContent = String(snap.previousContent ?? '');
                await bridge.writeChatMessage(target, prevContent, { emitEvent: true });
                return;
            }
            if (action === 'toggle_hide') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo chat_toggle_hide_message.');
                }
                const messageId = Number(snap.messageId ?? record.target?.messageId);
                const previousHidden = Boolean(snap.previousHidden);
                await bridge.author.toggleChatMessageHidden(messageId, previousHidden);
                return;
            }
            if (action === 'override_display') {
                const target = (snap.target ?? record.target) as MessageTarget | undefined;
                if (!target) {
                    throw new Error('Missing target in override_display undo snapshot.');
                }
                if (snap.hadPreviousOverride) {
                    store.set(
                        DATA_NAMESPACES.MESSAGE,
                        MESSAGE_OVERRIDE_KEY,
                        String(snap.previousOverrideSource ?? 'assistant:undo'),
                        String(snap.previousOverrideContent ?? ''),
                        { target, staged: false },
                    );
                } else {
                    store.remove(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, target);
                }
                await bridge.refreshMessageView(target);
                return;
            }
            throw new Error(`Unsupported chat_message undo action: "${String(action)}".`);
        },

        variables: async (record: UndoRecord) => {
            const previousVars = (record.snapshot.previousVars ?? {}) as Record<string, unknown>;
            const rawScope = record.snapshot.scope;
            const scope =
                rawScope === 'chat' || rawScope === 'global' || rawScope === 'message'
                    ? rawScope
                    : 'message';
            await vfs.writeVariables(previousVars, {
                target: record.target,
                staged: false,
                source: 'assistant:undo',
                scope,
            });
        },

        vfs_file: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const path = String(snap.path ?? '');
            if (!path) {
                throw new Error('Missing VFS path in vfs_file undo snapshot.');
            }
            const isLorebook = Boolean(snap.isLorebook) || path.startsWith('/lorebooks/');
            if (isLorebook) {
                if (!snap.hadOverride) {
                    await vfs.deleteFile(path, {
                        target: record.target,
                        staged: false,
                        source: 'assistant:undo',
                    });
                } else {
                    await vfs.writeFile(path, String(snap.previousContent ?? ''), {
                        target: record.target,
                        staged: false,
                        source: 'assistant:undo',
                    });
                }
                return;
            }

            if (!snap.existed) {
                await vfs.deleteFile(path, {
                    target: record.target,
                    staged: false,
                    source: 'assistant:undo',
                });
            } else {
                await vfs.writeFile(path, String(snap.previousContent ?? ''), {
                    target: record.target,
                    staged: false,
                    source: 'assistant:undo',
                });
            }
        },

        character: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const scope = snap.scope;
            if (scope === 'active') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo active character patch.');
                }
                const previousFields = (snap.previousFields ?? {}) as HostCharacterPatch;
                await bridge.author.patchActiveCharacter(previousFields, {
                    sessionId: record.sessionId,
                    toolCallId: record.toolCallId,
                    reason: `undo:${record.id}`,
                });
                return;
            }
            if (!bridge.admin) {
                throw new Error('HostAdminBridge is required to undo admin character operation.');
            }
            if (scope === 'admin_patch') {
                await bridge.admin.patchCharacterById(
                    Number(snap.chid),
                    (snap.previousFields ?? {}) as HostCharacterPatch,
                );
                return;
            }
            if (scope === 'admin_create') {
                await bridge.admin.deleteCharacterById(Number(snap.chid));
                return;
            }
            if (scope === 'admin_delete') {
                const prevChar = snap.previousCharacter as HostCharacterCreatePayload | undefined;
                if (prevChar && typeof prevChar.name === 'string') {
                    await bridge.admin.createCharacter(prevChar);
                }
                return;
            }
            if (scope === 'admin_select') {
                if (typeof snap.previousChid === 'number') {
                    await bridge.admin.selectCharacterById(snap.previousChid);
                }
                return;
            }
            throw new Error(`Unsupported character undo scope: "${String(scope)}".`);
        },

        worldinfo: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            const bookName = String(snap.bookName ?? '');
            if (action === 'update_entry' || action === 'delete_entry') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo World Info entry edit.');
                }
                const prevEntry = snap.previousEntry as RawLoreEntry | null | undefined;
                if (!prevEntry) {
                    throw new Error('Missing previousEntry in worldinfo undo snapshot.');
                }
                await bridge.author.upsertWorldInfoEntry(
                    bookName,
                    {
                        uid: prevEntry.uid,
                        comment: prevEntry.comment,
                        content: prevEntry.content,
                        keys: [...(prevEntry.keys ?? [])],
                        keysecondary: [...(prevEntry.keysecondary ?? [])],
                        constant: prevEntry.constant,
                        selective: prevEntry.selective,
                        selectiveLogic: prevEntry.selectiveLogic,
                        disable: prevEntry.disable,
                        position: prevEntry.position,
                        depth: prevEntry.depth,
                        order: prevEntry.order,
                        role: prevEntry.role,
                        caseSensitive: prevEntry.caseSensitive,
                        matchWholeWords: prevEntry.matchWholeWords,
                        probability: prevEntry.probability,
                        useProbability: prevEntry.useProbability,
                        group: prevEntry.group,
                        groupOverride: prevEntry.groupOverride,
                        groupWeight: prevEntry.groupWeight,
                        scanDepth: prevEntry.scanDepth,
                        extensions: prevEntry.extensions,
                    },
                    {
                        rawDirect: true,
                        undoMeta: {
                            sessionId: record.sessionId,
                            toolCallId: record.toolCallId,
                            reason: `undo:${record.id}`,
                        },
                    },
                );
                return;
            }
            if (action === 'create_entry') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo World Info entry creation.');
                }
                await bridge.author.deleteWorldInfoEntry(bookName, Number(snap.uid));
                return;
            }
            if (action === 'bind_book') {
                if (!bridge.admin) {
                    throw new Error('HostAdminBridge is required to undo bindWorldBook.');
                }
                await bridge.admin.bindWorldBook(bookName, Boolean(snap.previousEnabled));
                return;
            }
            if (action === 'create_book') {
                if (bridge.admin) {
                    await bridge.admin.bindWorldBook(bookName, false);
                }
                return;
            }
            throw new Error(`Unsupported worldinfo undo action: "${String(action)}".`);
        },

        regex: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const previousScripts = (snap.previousScripts ?? []) as HostRegexScript[];
            if (snap.scope === 'scoped') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo scoped regex.');
                }
                await bridge.author.saveScopedRegex(previousScripts);
                return;
            }
            if (snap.scope === 'global') {
                if (!bridge.admin) {
                    throw new Error('HostAdminBridge is required to undo global regex.');
                }
                await bridge.admin.saveGlobalRegex(previousScripts);
                return;
            }
            throw new Error(`Unsupported regex undo scope: "${String(snap.scope)}".`);
        },

        st_setting: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            if (action === 'slash_exec' || action === 'import_url') {
                return;
            }
            if (action === 'agentic_preset_snapshot') {
                if (!updateSettings) {
                    throw new Error('updateSettings is required to undo ST-Agentic preset changes.');
                }
                const presetId = String(snap.presetId ?? '');
                const prevPreset = (snap.previousPreset ?? null) as Preset | null;
                await updateSettings((prev) => {
                    const nextPresets = { ...prev.presets };
                    if (prevPreset) {
                        nextPresets[presetId] = canonicalClone(prevPreset);
                    } else {
                        delete nextPresets[presetId];
                    }
                    return normalizeSettings({
                        ...prev,
                        presets: nextPresets,
                    });
                });
                return;
            }
            if (action === 'agentic_settings_patch') {
                if (!updateSettings) {
                    throw new Error('updateSettings is required to undo ST-Agentic settings changes.');
                }
                const prevGlobals = (snap.previousGlobals ?? {}) as Partial<Settings>;
                const prevPresets = (snap.previousPresets ?? {}) as Record<string, Preset | null>;
                await updateSettings((prev) => {
                    const nextPresets = { ...prev.presets };
                    for (const [presetId, presetVal] of Object.entries(prevPresets)) {
                        if (presetVal) {
                            nextPresets[presetId] = canonicalClone(presetVal);
                        } else {
                            delete nextPresets[presetId];
                        }
                    }
                    return normalizeSettings({
                        ...prev,
                        ...canonicalClone(prevGlobals),
                        connections: prev.connections,
                        presets: nextPresets,
                    });
                });
                return;
            }
            if (action === 'agentic_connection_upsert') {
                if (!updateSettings) {
                    throw new Error('updateSettings is required to undo ST-Agentic connection changes.');
                }
                const connectionId = String(snap.connectionId ?? '');
                const existed = Boolean(snap.existed);
                const prevCurrentId =
                    typeof snap.previousCurrentConnectionId === 'string'
                        ? snap.previousCurrentConnectionId
                        : undefined;
                const prevConn = snap.previousConnection as
                    | (Partial<ApiConnection> & Record<string, unknown>)
                    | null
                    | undefined;
                await updateSettings((prev) => {
                    const nextConnections = { ...prev.connections };
                    if (!existed) {
                        delete nextConnections[connectionId];
                    } else if (prevConn) {
                        const liveExisting = prev.connections[connectionId];
                        const safeRestored = preserveRedactedConnectionSecrets(prevConn, liveExisting);
                        nextConnections[connectionId] = normalizeConnection(
                            {
                                ...(liveExisting ? canonicalClone(liveExisting) : {}),
                                ...safeRestored,
                                id: connectionId,
                            },
                            connectionId,
                        );
                    }
                    return normalizeSettings({
                        ...prev,
                        connections: nextConnections,
                        ...(prevCurrentId && nextConnections[prevCurrentId]
                            ? { currentConnectionId: prevCurrentId }
                            : {}),
                    });
                });
                return;
            }
            if (!bridge.admin) {
                throw new Error('HostAdminBridge is required to undo ST admin setting.');
            }
            if (action === 'tavern_helper_scripts') {
                if (!bridge.admin.replaceTavernHelperScripts) {
                    throw new Error(
                        'HostAdminBridge.replaceTavernHelperScripts is required to undo TavernHelper scripts.',
                    );
                }
                const scope = String(snap.scope ?? 'global') as TavernHelperScriptScope;
                const prevScripts = Array.isArray(snap.previousScripts)
                    ? (snap.previousScripts as Record<string, unknown>[])
                    : [];
                await bridge.admin.replaceTavernHelperScripts(scope, prevScripts);
                return;
            }
            if (action === 'tavern_helper_script_single') {
                if (!bridge.admin.readTavernHelperScripts || !bridge.admin.replaceTavernHelperScripts) {
                    throw new Error(
                        'HostAdminBridge.readTavernHelperScripts and replaceTavernHelperScripts are required to undo TavernHelper script edit.',
                    );
                }
                const scope = String(snap.scope ?? 'global') as TavernHelperScriptScope;
                const targetId = typeof snap.scriptId === 'string' ? snap.scriptId : '';
                const folderId = typeof snap.folderId === 'string' ? snap.folderId : undefined;
                const existed = Boolean(snap.existed);
                const previousScript =
                    snap.previousScript
                    && typeof snap.previousScript === 'object'
                    && !Array.isArray(snap.previousScript)
                        ? canonicalClone(snap.previousScript as Record<string, unknown>)
                        : undefined;

                const current = await bridge.admin.readTavernHelperScripts(scope);
                const nextTrees: Record<string, unknown>[] = [];
                let restored = false;

                for (const item of current.scripts) {
                    if (item.id === targetId) {
                        if (existed && previousScript) {
                            nextTrees.push(previousScript);
                            restored = true;
                        }
                        continue;
                    }
                    if (item.type === 'folder' && Array.isArray(item.scripts)) {
                        const nextChildren: Record<string, unknown>[] = [];
                        for (const child of item.scripts) {
                            if (
                                child
                                && typeof child === 'object'
                                && !Array.isArray(child)
                                && (child as Record<string, unknown>).id === targetId
                            ) {
                                if (existed && previousScript) {
                                    nextChildren.push(previousScript);
                                    restored = true;
                                }
                                continue;
                            }
                            nextChildren.push(child as Record<string, unknown>);
                        }
                        if (!restored && existed && previousScript && folderId && item.id === folderId) {
                            nextChildren.push(previousScript);
                            restored = true;
                        }
                        nextTrees.push({ ...item, scripts: nextChildren });
                        continue;
                    }
                    nextTrees.push(item);
                }

                if (!restored && existed && previousScript) {
                    nextTrees.push(previousScript);
                }

                await bridge.admin.replaceTavernHelperScripts(scope, nextTrees);
                return;
            }
            if (action === 'settings_patch') {
                const scope = String(snap.scope ?? 'all') as HostSettingsScope;
                const prevValues = (snap.previousValues ?? {}) as Record<string, unknown>;
                await bridge.admin.patchHostSettings(scope, prevValues);
                return;
            }
            if (action === 'preset_select') {
                if (typeof snap.previousName === 'string' && snap.previousName) {
                    await bridge.admin.selectPreset(
                        snap.previousName,
                        typeof snap.apiType === 'string' ? snap.apiType : undefined,
                    );
                }
                return;
            }
            if (action === 'preset_patch') {
                await bridge.admin.patchPreset(
                    String(snap.name ?? ''),
                    (snap.previousData ?? {}) as Record<string, unknown>,
                    typeof snap.apiType === 'string' ? snap.apiType : undefined,
                );
                return;
            }
            if (action === 'persona_upsert') {
                const prev = snap.previousPersona as
                    | { key: string; description: string; title?: string }
                    | null
                    | undefined;
                if (prev) {
                    await bridge.admin.upsertPersona(prev.key, prev.description, prev.title);
                }
                return;
            }
            if (action === 'persona_select') {
                if (typeof snap.previousKey === 'string' && snap.previousKey) {
                    await bridge.admin.selectPersona(snap.previousKey);
                }
                return;
            }
            throw new Error(`Unsupported st_setting undo action: "${String(action)}".`);
        },
    });
}

/**
 * Off-mainline Assistant Runtime implementing 4-tier tool execution, KV-cache-friendly
 * multi-turn streaming, inline bubble approval/reject/retry loops, pre-write snapshots,
 * secret redaction, and `AssistantRuntimeBridge` 1:1 compatibility.
 */
export class AssistantRunner {
    public readonly bridge: HostBridge;
    public readonly transport: LLMTransport;
    public readonly store: ChatDataStore;
    public readonly vfs: VirtualFileSystem;
    public readonly trajectoryStore: TrajectoryStore;
    public readonly sessionStore: AssistantSessionStore;
    public readonly approvalGate: ApprovalGate;
    public readonly undoStore: UndoStore;
    public readonly spillStore: TransientToolSpillStore;
    public readonly traceLogger?: TraceLogger;

    private readonly toolsByName = new Map<string, AssistantToolDefinition>();
    private readonly docsRegistry: DocsRegistry;
    private readonly undoExecutor: UndoExecutor;
    private readonly settingsProvider: () => Settings;
    private readonly settingsUpdater?: (
        updater: (prev: Settings) => Settings,
    ) => Promise<Settings> | Settings;
    private readonly customConnectionResolver?: (connectionId: string) => ApiConnection | undefined;
    private readonly activeTargetProvider?: () => MessageTarget;
    private readonly variableSchemaProvider?: () => DynamicVariableSchema | undefined;
    private readonly statusSnapshotProvider?: () => Record<string, unknown>;
    private readonly maxToolResultBytes?: number;
    private readonly compactionSummaryTimeoutMs: number;
    private readonly maxToolRounds: number;
    private readonly autoRetryConfig: Required<AssistantRetryOptions> | false;
    private readonly explicitMaxRetries?: number;
    private readonly defaultStream: boolean;
    private readonly now: () => number;
    private readonly idGenerator: () => string;

    private readonly listeners = new Set<() => void>();
    private readonly activeControllers = new Map<string, AbortController>();
    private readonly suspendedApprovals = new Map<string, SuspendedApprovalContext>();
    private readonly compactingSessions = new Set<string>();
    private seq = 0;

    constructor(options: AssistantRunnerOptions) {
        this.bridge = options.bridge;
        this.transport = options.transport;
        this.docsRegistry = options.docsRegistry ?? defaultDocsRegistry;
        this.store = options.store ?? options.vfs?.store ?? new ChatDataStore(options.bridge);
        this.vfs =
            options.vfs
            ?? new VirtualFileSystem({
                bridge: this.bridge,
                store: this.store,
                docsRegistry: this.docsRegistry,
            });
        this.trajectoryStore =
            options.trajectoryStore
            ?? options.sessionStore?.trajectoryStore
            ?? new TrajectoryStore();
        this.sessionStore =
            options.sessionStore
            ?? new AssistantSessionStore({
                bridge: this.bridge,
                trajectoryStore: this.trajectoryStore,
                now: options.now,
            });
        this.approvalGate = options.approvalGate ?? new ApprovalGate({ now: options.now });
        this.undoStore = options.undoStore ?? new UndoStore({ now: options.now });
        this.spillStore = options.spillStore ?? new TransientToolSpillStore();
        this.maxToolResultBytes = options.maxToolResultBytes;
        this.compactionSummaryTimeoutMs = Math.max(
            500,
            Math.floor(options.compactionSummaryTimeoutMs ?? DEFAULT_COMPACTION_SUMMARY_TIMEOUT_MS),
        );
        this.traceLogger = options.traceLogger;

        this.settingsProvider =
            typeof options.settings === 'function'
                ? options.settings
                : options.settings
                    ? () => options.settings as Settings
                    : () => createDefaultSettings();
        this.settingsUpdater = options.updateSettings;
        this.customConnectionResolver = options.resolveConnection;
        this.activeTargetProvider = options.getActiveTarget;
        this.variableSchemaProvider = options.getVariableSchema;
        this.statusSnapshotProvider = options.getStatusSnapshot;
        this.maxToolRounds =
            typeof options.maxToolRounds === 'number'
            && Number.isFinite(options.maxToolRounds)
            && options.maxToolRounds > 0
                ? Math.max(1, Math.floor(options.maxToolRounds))
                : Number.POSITIVE_INFINITY;
        if (options.autoRetry === false) {
            this.autoRetryConfig = false;
        } else {
            if (options.autoRetry?.maxRetries !== undefined) {
                this.explicitMaxRetries = Math.max(0, Math.floor(options.autoRetry.maxRetries));
            }
            const initDelay = Math.max(
                0,
                Math.floor(options.autoRetry?.initialDelayMs ?? DEFAULT_AUTO_RETRY_OPTIONS.initialDelayMs),
            );
            this.autoRetryConfig = {
                maxRetries: Math.max(
                    0,
                    Math.floor(options.autoRetry?.maxRetries ?? DEFAULT_AUTO_RETRY_OPTIONS.maxRetries),
                ),
                initialDelayMs: initDelay,
                maxDelayMs: Math.max(
                    initDelay,
                    Math.floor(options.autoRetry?.maxDelayMs ?? DEFAULT_AUTO_RETRY_OPTIONS.maxDelayMs),
                ),
                backoffFactor: Math.max(
                    1,
                    options.autoRetry?.backoffFactor ?? DEFAULT_AUTO_RETRY_OPTIONS.backoffFactor,
                ),
            };
        }
        this.defaultStream = options.stream ?? true;
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `ast_msg_${this.now()}_${this.seq}`;
            });

        const allTools: AssistantToolDefinition[] = [
            ...createChatReadOnlyTools(),
            ...createAdjustTools(),
            ...createAuthorTools(),
            ...createFullAgenticConfigTools(),
            ...createAdminTierTools(),
            ...(options.extraTools ?? []),
        ];
        for (const tool of allTools) {
            this.toolsByName.set(tool.name, tool);
        }

        this.undoExecutor = createAssistantUndoExecutor({
            bridge: this.bridge,
            store: this.store,
            vfs: this.vfs,
            updateSettings: this.settingsUpdater,
        });
    }

    // ========================================================================
    // Spill Store, Session Token Status & Manual Compaction
    // ========================================================================

    public getSpillStore(): TransientToolSpillStore {
        return this.spillStore;
    }

    public clearSpillStore(scopeId?: string): void {
        if (scopeId !== undefined) {
            this.spillStore.clearScope(scopeId);
            return;
        }
        this.spillStore.clearAll();
    }

    public getSessionTokenStatus(sessionId: string): AssistantSessionTokenStatus | null {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            return null;
        }
        const budget = this.resolveSessionContextBudget(session);
        const { layer0, tools } = this.resolveSessionLayer0AndTools(session);
        return this.sessionStore.getSessionTokenStatus(sessionId, budget, {
            layer0,
            tools,
            isCompacting: this.compactingSessions.has(sessionId),
        });
    }

    public async compactSession(
        sessionId: string,
        options: AssistantCompactOptions = {},
    ): Promise<AssistantCompactReport> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        if (this.compactingSessions.has(sessionId)) {
            const status = this.getSessionTokenStatus(sessionId);
            const current = status?.currentTokens ?? 0;
            return {
                compacted: false,
                reason: 'nothing_to_compact',
                tokensBefore: current,
                tokensAfter: current,
                foldedToolResults: 0,
                archivedTurns: 0,
                summaryMode: 'none',
                timestamp: this.now(),
            };
        }

        this.compactingSessions.add(sessionId);
        this.notify();

        try {
            const budget = this.resolveSessionContextBudget(session);
            const connection = this.resolveEffectiveConnection(session.connectionId);
            const { layer0, tools } = this.resolveSessionLayer0AndTools(session);
            const archiveWriter = this.createArchiveWriter();

            const summarizeWithLLM: AssistantLLMSummarizer | undefined =
                options.useLLMSummary === false
                    ? undefined
                    : async (input) => await this.runCompactionSummaryLLM(connection, input);

            const report = await this.sessionStore.compactSession(sessionId, {
                ...options,
                reason: 'manual',
                force: true,
                targetLowTokens: options.targetLowTokens ?? budget.autoLowWatermark,
                watermark: {
                    high: budget.autoHighWatermark,
                    low: budget.autoLowWatermark,
                },
                summarizeWithLLM,
                archiveWriter,
                layer0,
                tools,
            });
            return report;
        } finally {
            this.compactingSessions.delete(sessionId);
            this.notify();
        }
    }

    // ========================================================================
    // Session CRUD & Subscription (AssistantRuntimeBridge)
    // ========================================================================

    public listSessions(): AssistantSession[] {
        return this.sessionStore.listSessions();
    }

    public getSession(sessionId: string): AssistantSession | null {
        return this.sessionStore.getSession(sessionId);
    }

    public async createSession(
        options?: CreateAssistantSessionOptions,
    ): Promise<AssistantSession> {
        const session = this.sessionStore.createSession(options);
        this.notify();
        return session;
    }

    public async deleteSession(sessionId: string): Promise<boolean> {
        this.abort(sessionId);
        this.approvalGate.clear(sessionId);
        for (const [apprId, ctx] of Array.from(this.suspendedApprovals.entries())) {
            if (ctx.sessionId === sessionId) {
                this.suspendedApprovals.delete(apprId);
            }
        }
        this.spillStore.clearScope(sessionId);
        const deleted = this.sessionStore.deleteSession(sessionId);
        if (deleted) {
            this.notify();
        }
        return deleted;
    }

    public async clearSession(sessionId: string): Promise<AssistantSession | null> {
        this.abort(sessionId);
        this.approvalGate.clear(sessionId);
        for (const [apprId, ctx] of Array.from(this.suspendedApprovals.entries())) {
            if (ctx.sessionId === sessionId) {
                this.suspendedApprovals.delete(apprId);
            }
        }
        this.spillStore.clearScope(sessionId);
        const cleared = this.sessionStore.clearSession(sessionId);
        if (cleared) {
            this.notify();
        }
        return cleared;
    }

    public async updateSessionConfig(
        sessionId: string,
        patch: AssistantSessionPatch,
    ): Promise<AssistantSession | null> {
        const updated = this.sessionStore.updateSession(sessionId, patch);
        if (updated) {
            this.notify();
        }
        return updated;
    }

    public subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public listApprovals(sessionId?: string): PendingApproval[] {
        return this.approvalGate.list(sessionId ? { sessionId } : undefined);
    }

    public getApproval(approvalId: string): PendingApproval | undefined {
        return this.approvalGate.get(approvalId);
    }

    public listUndoRecords(sessionId?: string): UndoRecord[] {
        return this.undoStore.list(sessionId);
    }

    /**
     * Read a VFS or `/tmp/tool-spill/*` file for UI preview with automatic secret redaction.
     */
    public async readPreviewFile(path: string): Promise<string | null> {
        try {
            const normalized = normalizeVfsPath(path);
            if (isSpillPath(normalized)) {
                const slice = this.spillStore.readSlice(normalized);
                return slice === null ? null : redactString(slice).value;
            }
            const raw = await this.vfs.readFile(normalized, {
                target: this.resolveActiveTarget(),
                staged: false,
            });
            return redactString(raw).value;
        } catch {
            return null;
        }
    }

    /**
     * Probe currently active optional third-party host extension capabilities.
     */
    public getExtensionCapabilities(): HostExtensionCapabilities {
        return resolveHostExtensionCapabilities(this.bridge);
    }

    private resolveToolDefinition(
        name: string,
        capabilities: HostExtensionCapabilities,
    ): AssistantToolDefinition | undefined {
        if (name === 'st_sync_runtime') {
            return createStSyncRuntimeTool(capabilities);
        }
        return this.toolsByName.get(name);
    }

    /**
     * Return canonical sorted tool definitions unlocked for `(mode, stAdminEnabled)`
     * and active optional host extension capabilities.
     */
    public getAllowedToolDefinitions(
        mode: AssistantMode,
        stAdminEnabled: boolean = false,
    ): AssistantToolDefinition[] {
        const capabilities = this.getExtensionCapabilities();
        const allowedNames = getAllowedToolsForMode(mode, stAdminEnabled, capabilities);
        const defs: AssistantToolDefinition[] = [];
        for (const name of allowedNames) {
            const def = this.resolveToolDefinition(name, capabilities);
            if (def) {
                defs.push(def);
            }
        }
        return defs;
    }

    /**
     * Abort an active streaming/tool execution for `sessionId`, or all active sessions when omitted.
     */
    public abort(sessionId?: string): void {
        if (sessionId !== undefined) {
            const controller = this.activeControllers.get(sessionId);
            if (controller && !controller.signal.aborted) {
                controller.abort(createAssistantAbortError(`Assistant session "${sessionId}" aborted`));
            }
            this.activeControllers.delete(sessionId);
            return;
        }
        for (const [id, controller] of Array.from(this.activeControllers.entries())) {
            if (!controller.signal.aborted) {
                controller.abort(createAssistantAbortError(`Assistant session "${id}" aborted`));
            }
            this.activeControllers.delete(id);
        }
    }

    // ========================================================================
    // Multi-Turn Streaming Execution Loop
    // ========================================================================

    public async sendPrompt(
        sessionId: string,
        prompt: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        return await this.executeAssistantTurn(sessionId, prompt, options, {
            appendUserMessage: true,
            generationType: 'normal',
        });
    }

    /**
     * Rewrite an existing user or assistant message in place and reconcile `TrajectoryStore`
     * while preserving prior turns verbatim.
     */
    public async editMessage(
        sessionId: string,
        messageId: string,
        newContent: string,
    ): Promise<AssistantSession | null> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            return null;
        }
        const existingMsg = session.messages.find((m) => m.id === messageId);
        if (!existingMsg) {
            return null;
        }
        const hasAttachments = Boolean(
            existingMsg.attachments && existingMsg.attachments.length > 0,
        );
        if (!newContent.trim() && !hasAttachments) {
            throw new Error('Edited message content cannot be empty.');
        }

        this.abort(sessionId);

        const updatedMsg = this.sessionStore.updateMessage(sessionId, messageId, (prev) => {
            const next: AssistantMessage = {
                ...prev,
                content: newContent,
            };
            if (next.interrupted) {
                next.interrupted = false;
            }
            if (next.canContinue) {
                next.canContinue = false;
            }
            delete next.errorCode;
            delete next.errorMessage;
            delete next.retryStatus;
            return next;
        });
        if (!updatedMsg) {
            return null;
        }
        const existingCp = this.sessionStore.getInterruptedCheckpoint(sessionId);
        if (existingCp && existingCp.messageId === messageId) {
            this.sessionStore.setInterruptedCheckpoint(sessionId, undefined);
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId);
        this.notify();
        return this.sessionStore.getSession(sessionId);
    }

    /**
     * Rewrite a user message, truncate any subsequent messages and pending approvals,
     * sync `TrajectoryStore` strictly before that turn, and stream a fresh assistant reply.
     */
    public async editAndResendMessage(
        sessionId: string,
        messageId: string,
        newContent: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            throw new Error(`Assistant message not found: "${messageId}".`);
        }
        const existingMsg = session.messages[idx];
        if (existingMsg.role !== 'user') {
            throw new Error(`Only user messages can be edited and resent ("${messageId}").`);
        }
        const hasAttachments = Boolean(
            existingMsg.attachments && existingMsg.attachments.length > 0,
        );
        if (!newContent.trim() && !hasAttachments) {
            throw new Error('Edited message content cannot be empty.');
        }

        this.abort(sessionId);

        this.sessionStore.updateMessage(sessionId, messageId, (prev) => ({
            ...prev,
            content: newContent,
        }));

        const truncated = this.sessionStore.truncateAfterMessage(sessionId, messageId);
        if (truncated && truncated.removedMessages.length > 0) {
            this.cleanupApprovalsForMessages(sessionId, truncated.removedMessages);
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId, { upToMessageIndex: idx });
        this.emitSessionUpdate(sessionId, options.onUpdate);

        return await this.executeAssistantTurn(
            sessionId,
            newContent,
            {
                ...options,
                attachments: options.attachments ?? existingMsg.attachments,
            },
            {
                appendUserMessage: false,
                generationType: 'normal',
            },
        );
    }

    /**
     * Retract `messageId` and all following messages from the session, removing any
     * associated pending approvals while keeping historical `UndoRecord`s intact.
     */
    public async retractMessage(
        sessionId: string,
        messageId: string,
    ): Promise<AssistantRetractResult | null> {
        this.abort(sessionId);

        const result = this.sessionStore.retractFromMessage(sessionId, messageId);
        if (!result) {
            return null;
        }

        this.cleanupApprovalsForMessages(sessionId, result.removedMessages);
        this.notify();
        return result;
    }

    /**
     * Regenerate the response for the trailing user turn (truncating any trailing assistant
     * reply/tool approvals first) while preserving earlier turns' KV-cache prefix verbatim.
     */
    public async regenerateLastMessage(
        sessionId: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        if (session.messages.length === 0) {
            throw new Error('No user message available to regenerate.');
        }

        let lastUserIdx = -1;
        for (let i = session.messages.length - 1; i >= 0; i -= 1) {
            if (session.messages[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) {
            throw new Error('No user message available to regenerate.');
        }

        this.abort(sessionId);

        const targetUserMsg = session.messages[lastUserIdx];
        if (lastUserIdx < session.messages.length - 1) {
            const truncated = this.sessionStore.truncateAfterMessage(sessionId, targetUserMsg.id);
            if (truncated && truncated.removedMessages.length > 0) {
                this.cleanupApprovalsForMessages(sessionId, truncated.removedMessages);
            }
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId, { upToMessageIndex: lastUserIdx });
        this.emitSessionUpdate(sessionId, options.onUpdate);

        return await this.executeAssistantTurn(
            sessionId,
            targetUserMsg.content,
            {
                ...options,
                attachments: options.attachments ?? targetUserMsg.attachments,
            },
            {
                appendUserMessage: false,
                generationType: 'regenerate',
            },
        );
    }

    /**
     * Continue an interrupted, truncated, or tool-round-capped trailing assistant response
     * from its saved `AssistantInterruptedCheckpoint` (or legacy fallback when absent),
     * preserving completed tool steps and continuing in-place on the same bubble.
     */
    public async continueLastMessage(
        sessionId: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        if (session.messages.length === 0) {
            throw new Error('No message available to continue.');
        }

        this.abort(sessionId);

        const lastMsg = session.messages[session.messages.length - 1];

        // Case C: Trailing message is a user prompt (e.g. response never started).
        if (lastMsg.role === 'user') {
            return await this.executeAssistantTurn(
                sessionId,
                lastMsg.content,
                {
                    ...options,
                    attachments: options.attachments ?? lastMsg.attachments,
                },
                {
                    appendUserMessage: false,
                    generationType: 'continue',
                },
            );
        }

        const initialUsage = lastMsg.usage
            ? normalizeUsage({
                  inputTokens: lastMsg.usage.inputTokens,
                  cachedTokens: lastMsg.usage.cachedTokens,
                  outputTokens: lastMsg.usage.outputTokens,
              })
            : normalizeUsage();

        // Case A: Exact resumable checkpoint matching the trailing assistant bubble.
        const cp = session.interruptedCheckpoint;
        if (cp && cp.messageId === lastMsg.id) {
            const resumedInFlight = canonicalClone(cp.inFlightMessages);
            let bubbleBaseContent = cp.bubbleBaseContent ?? '';
            const partial = cp.partialContent ?? '';

            if (partial.trim().length > 0) {
                resumedInFlight.push(
                    {
                        role: 'assistant',
                        content: partial,
                        ...(cp.partialThink?.trim() ? { reasoningContent: cp.partialThink } : {}),
                    },
                    {
                        role: 'user',
                        content: '请从上面中断的位置直接接着继续输出，不要重复已经输出的内容。',
                    },
                );
                bubbleBaseContent = `${bubbleBaseContent}${partial}`;
            }

            return await this.executeAssistantTurn(sessionId, '', options, {
                appendUserMessage: false,
                generationType: 'continue',
                resumeState: {
                    existingAssistantMessage: lastMsg,
                    inFlightMessages: resumedInFlight,
                    bubbleBaseContent,
                    initialContentBuffer: bubbleBaseContent,
                    initialThinkBuffer: lastMsg.think ?? '',
                    initialUsage,
                    initialRoundsCompleted: cp.roundsCompleted,
                    target: cp.target,
                },
            });
        }

        // Case B: Legacy fallback (e.g. older persisted session without interruptedCheckpoint).
        let lastUserIdx = -1;
        for (let i = session.messages.length - 1; i >= 0; i -= 1) {
            if (session.messages[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) {
            throw new Error('No user message available to continue.');
        }

        const targetUserMsg = session.messages[lastUserIdx];
        this.sessionStore.syncTrajectoryToMessages(sessionId, { upToMessageIndex: lastUserIdx });
        this.emitSessionUpdate(sessionId, options.onUpdate);

        const cleanContent = stripTrailingErrorBanner(lastMsg.content);
        const resumedInFlight: CanonicalMessage[] = [
            {
                role: 'user',
                content: buildAssistantUserContent(targetUserMsg.content, targetUserMsg.attachments),
            },
        ];
        let bubbleBaseContent = '';
        const hasTools = Boolean(lastMsg.toolCalls && lastMsg.toolCalls.length > 0);

        if (cleanContent.trim().length > 0) {
            const continuePrompt = hasTools
                ? `${summarizeLegacyToolCalls(lastMsg.toolCalls!)}\n\n请从上面中断的位置直接接着继续输出，不要重复已经输出的内容。`
                : '请从上面中断的位置直接接着继续输出，不要重复已经输出的内容。';
            resumedInFlight.push(
                {
                    role: 'assistant',
                    content: cleanContent,
                    ...(lastMsg.think?.trim() ? { reasoningContent: lastMsg.think } : {}),
                },
                {
                    role: 'user',
                    content: continuePrompt,
                },
            );
            bubbleBaseContent = cleanContent;
        } else if (hasTools) {
            resumedInFlight.push({
                role: 'user',
                content: summarizeLegacyToolCalls(lastMsg.toolCalls!),
            });
        }

        return await this.executeAssistantTurn(sessionId, targetUserMsg.content, options, {
            appendUserMessage: false,
            generationType: 'continue',
            resumeState: {
                existingAssistantMessage: lastMsg,
                inFlightMessages: resumedInFlight,
                bubbleBaseContent,
                initialContentBuffer: bubbleBaseContent,
                initialThinkBuffer: lastMsg.think ?? '',
                initialUsage,
                initialRoundsCompleted: 0,
            },
        });
    }

    private async executeAssistantTurn(
        sessionId: string,
        prompt: string,
        options: AssistantSendOptions,
        config: {
            appendUserMessage: boolean;
            generationType?: SurfaceGenerationType;
            resumeState?: {
                existingAssistantMessage: AssistantMessage;
                inFlightMessages: CanonicalMessage[];
                bubbleBaseContent: string;
                initialContentBuffer: string;
                initialThinkBuffer: string;
                initialUsage: TokenUsage;
                initialRoundsCompleted?: number;
                target?: MessageTarget;
            };
        },
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }

        // Cancel any previous in-flight run on the same session cleanly.
        this.abort(sessionId);
        const controller = new AbortController();
        this.activeControllers.set(sessionId, controller);

        const cleanupExternalSignal = this.linkExternalSignal(controller, options.signal);

        const resume = config.resumeState;
        if (!resume) {
            this.sessionStore.setInterruptedCheckpoint(sessionId, undefined);
        }

        const target = resume?.target ?? options.target ?? this.resolveActiveTarget();
        const attachments =
            options.attachments && options.attachments.length > 0
                ? canonicalClone(options.attachments)
                : undefined;

        if (config.appendUserMessage) {
            const userMessage: AssistantMessage = {
                id: this.idGenerator(),
                role: 'user',
                content: prompt,
                ...(attachments ? { attachments } : {}),
                timestamp: this.now(),
            };
            this.sessionStore.appendMessage(sessionId, userMessage);
        }

        let assistantMessage: AssistantMessage;
        let assistantMessageId: string;
        if (resume) {
            assistantMessageId = resume.existingAssistantMessage.id;
            const restoredBase = canonicalClone(resume.existingAssistantMessage);
            delete restoredBase.interrupted;
            delete restoredBase.errorCode;
            delete restoredBase.errorMessage;
            delete restoredBase.canContinue;
            delete restoredBase.retryStatus;
            assistantMessage = {
                ...restoredBase,
                content: resume.initialContentBuffer,
                ...(resume.initialThinkBuffer ? { think: resume.initialThinkBuffer } : {}),
            };
            if (!resume.initialThinkBuffer) {
                delete assistantMessage.think;
            }
            this.sessionStore.setInterruptedCheckpoint(sessionId, undefined);
            this.sessionStore.updateMessage(sessionId, assistantMessageId, () => assistantMessage);
        } else {
            assistantMessageId = this.idGenerator();
            assistantMessage = {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                timestamp: this.now(),
            };
            this.sessionStore.appendMessage(sessionId, assistantMessage);
        }
        this.emitSessionUpdate(sessionId, options.onUpdate);

        const inFlightMessages: CanonicalMessage[] = resume
            ? canonicalClone(resume.inFlightMessages)
            : [
                  {
                      role: 'user',
                      content: buildAssistantUserContent(prompt, attachments),
                  },
              ];
        const toolCallRecords: AssistantToolCallRecord[] = resume?.existingAssistantMessage.toolCalls
            ? canonicalClone(resume.existingAssistantMessage.toolCalls)
            : [];
        const approvalIds: string[] = resume?.existingAssistantMessage.approvalIds
            ? [...resume.existingAssistantMessage.approvalIds]
            : [];
        const fileRefs = new Set<string>(resume?.existingAssistantMessage.fileRefs ?? []);
        let cumulativeUsage: TokenUsage = resume
            ? normalizeUsage(resume.initialUsage)
            : normalizeUsage();
        let thinkBuffer = resume?.initialThinkBuffer ?? '';
        let contentBuffer = resume?.initialContentBuffer ?? '';
        let committedContentPrefixLen = resume ? resume.bubbleBaseContent.length : 0;
        const priorRoundsCompleted = resume?.initialRoundsCompleted ?? 0;
        let rounds = 0;
        let turnCompactionNotice: AssistantCompactionNotice | undefined =
            resume?.existingAssistantMessage.compactionNotice
                ? canonicalClone(resume.existingAssistantMessage.compactionNotice)
                : undefined;
        let activeRetryStatus: AssistantRetryStatus | undefined;
        let currentRoundThinkBuffer = '';

        // Per-round activity timeline (UI-only). Each marker records buffer offsets at round
        // start so every rollback path (which always resets to `roundStart*Buffer`) stays consistent.
        const priorActivity: AssistantActivityStep[] = resume?.existingAssistantMessage.activity
            ? canonicalClone(resume.existingAssistantMessage.activity)
            : [];
        const roundMarkers: Array<{
            id: string;
            startedAt: number;
            thinkStart: number;
            contentStart: number;
            respondedAt?: number;
            preface?: string;
            toolCallIds: string[];
        }> = [];
        const buildActivity = (): AssistantActivityStep[] => {
            const steps: AssistantActivityStep[] = [...priorActivity];
            roundMarkers.forEach((marker, idx) => {
                const next = roundMarkers[idx + 1];
                const think = thinkBuffer.slice(
                    marker.thinkStart,
                    next ? Math.max(marker.thinkStart, next.thinkStart) : thinkBuffer.length,
                );
                const preface = marker.preface ?? '';
                if (!think.trim() && !preface.trim() && marker.toolCallIds.length === 0) {
                    return;
                }
                steps.push({
                    id: marker.id,
                    startedAt: marker.startedAt,
                    ...(think.trim() ? { think } : {}),
                    ...(marker.respondedAt !== undefined
                        ? { thinkMs: Math.max(0, marker.respondedAt - marker.startedAt) }
                        : {}),
                    ...(preface.trim() ? { preface } : {}),
                    toolCallIds: [...marker.toolCallIds],
                });
            });
            return steps;
        };

        const syncAssistantBubble = (patch?: Partial<AssistantMessage>): void => {
            const activity = buildActivity();
            const nextMessage: AssistantMessage = {
                ...assistantMessage,
                content: contentBuffer,
                ...(thinkBuffer ? { think: thinkBuffer } : {}),
                ...(toolCallRecords.length > 0 ? { toolCalls: canonicalClone(toolCallRecords) } : {}),
                ...(activity.length > 0 ? { activity } : {}),
                ...(approvalIds.length > 0 ? { approvalIds: [...approvalIds] } : {}),
                ...(fileRefs.size > 0 ? { fileRefs: Array.from(fileRefs) } : {}),
                ...(cumulativeUsage.inputTokens > 0 || cumulativeUsage.outputTokens > 0
                    ? { usage: toAssistantMessageUsage(cumulativeUsage) }
                    : {}),
                ...(turnCompactionNotice ? { compactionNotice: canonicalClone(turnCompactionNotice) } : {}),
                ...(activeRetryStatus ? { retryStatus: canonicalClone(activeRetryStatus) } : {}),
                ...(patch ?? {}),
            };
            if (!thinkBuffer && 'think' in nextMessage && !(patch && 'think' in patch)) {
                delete nextMessage.think;
            }
            if (!activeRetryStatus && !(patch && patch.retryStatus)) {
                delete nextMessage.retryStatus;
            }
            if (patch) {
                for (const key of [
                    'interrupted',
                    'canContinue',
                    'retryStatus',
                    'errorCode',
                    'errorMessage',
                ] as const) {
                    if (key in patch && patch[key] === undefined) {
                        delete nextMessage[key];
                    }
                }
            }
            assistantMessage = nextMessage;
            this.sessionStore.updateMessage(sessionId, assistantMessageId, () => assistantMessage);
            this.emitSessionUpdate(sessionId, options.onUpdate);
        };

        const saveCheckpoint = (
            reason: AssistantInterruptedCheckpoint['reason'],
            extra?: { errorMessage?: string },
        ): void => {
            const bubbleBaseContent = contentBuffer.slice(0, committedContentPrefixLen);
            const partialContent = contentBuffer.slice(committedContentPrefixLen);
            this.sessionStore.setInterruptedCheckpoint(sessionId, {
                messageId: assistantMessageId,
                reason,
                ...(extra?.errorMessage ? { errorMessage: extra.errorMessage } : {}),
                inFlightMessages: canonicalClone(inFlightMessages),
                ...(bubbleBaseContent ? { bubbleBaseContent } : {}),
                ...(partialContent ? { partialContent } : {}),
                ...(currentRoundThinkBuffer.trim()
                    ? { partialThink: currentRoundThinkBuffer }
                    : {}),
                target: canonicalClone(target),
                roundsCompleted: priorRoundsCompleted + rounds,
                createdAt: this.now(),
            });
        };

        try {
            const currentSession = this.sessionStore.getSession(sessionId) ?? session;
            const connection = this.resolveEffectiveConnection(currentSession.connectionId);
            const strictToolLoop = Boolean(connection.strictToolLoop);
            const effectiveMaxRoundRetries = this.resolveRoundMaxRetries(connection);
            const budget = this.resolveSessionContextBudget(currentSession);
            const capabilities = this.getExtensionCapabilities();
            const systemPrompt = buildAssistantSystemPrompt(
                currentSession.mode,
                currentSession.stAdminEnabled,
                capabilities,
                this.docsRegistry.listExternalIndexEntries(),
            );
            const allowedToolDefs = this.getAllowedToolDefinitions(
                currentSession.mode,
                currentSession.stAdminEnabled,
            );
            const baseCanonicalTools: CanonicalToolSchema[] =
                toCanonicalAssistantToolSchemas(allowedToolDefs);
            const canonicalTools: CanonicalToolSchema[] = strictToolLoop
                ? appendFinishTurnTool(baseCanonicalTools)
                : baseCanonicalTools;

            const threadId = toAssistantThreadId(sessionId);
            const prefixFingerprint = this.computePresetPrefixFingerprint(currentSession);
            const existingFrozenPrefix = this.trajectoryStore.getFrozenPrefix(threadId);
            const hasCommittedHistory = this.trajectoryStore.getMessageCount(threadId) > 0;
            const canReuseFrozenPrefix =
                (Boolean(resume) || hasCommittedHistory)
                && this.isMatchingFrozenPrefix(
                    existingFrozenPrefix,
                    systemPrompt,
                    canonicalTools,
                    prefixFingerprint,
                );
            const presetPrompts = await this.resolvePresetPromptMessages(currentSession, target, {
                skipPrefix: canReuseFrozenPrefix,
                excludeMessageId: assistantMessageId,
                currentUserInput: prompt || undefined,
                generationType: config.generationType ?? (resume ? 'continue' : 'normal'),
                connection,
                budget,
            });
            const effectivePrefixMessages: CanonicalMessage[] = canReuseFrozenPrefix
                ? canonicalClone(existingFrozenPrefix!.messages.slice(1))
                : presetPrompts.prefixMessages;
            const activeTailMessages: CanonicalMessage[] = canonicalClone(
                presetPrompts.tailMessages,
            );
            const useStream = options.stream ?? connection.stream ?? this.defaultStream;
            const archiveWriter = this.createArchiveWriter(target);

            const assembleCurrentRequest = () =>
                this.sessionStore.buildRequestMessages(
                    sessionId,
                    systemPrompt,
                    canonicalTools,
                    inFlightMessages,
                    {
                        extraPrefixMessages: effectivePrefixMessages,
                        tailMessages: activeTailMessages,
                        prefixFingerprint,
                    },
                );

            const commitFinalAssistantTurn = async (
                finalContentForTrajectory: string,
                finalReasoningContent: string,
            ): Promise<AssistantMessage> => {
                const finalCanonicalAssistant: CanonicalMessage = {
                    role: 'assistant',
                    content: finalContentForTrajectory,
                    ...(finalReasoningContent ? { reasoningContent: finalReasoningContent } : {}),
                };
                this.sessionStore.appendTrajectoryTurn(sessionId, [
                    ...inFlightMessages,
                    finalCanonicalAssistant,
                ]);
                this.sessionStore.setInterruptedCheckpoint(sessionId, undefined);
                const autoReport = await this.sessionStore.compactSession(sessionId, {
                    mode: 'auto',
                    reason: 'auto_watermark',
                    force: false,
                    watermark: {
                        high: budget.autoHighWatermark,
                        low: budget.autoLowWatermark,
                    },
                    targetLowTokens: budget.autoLowWatermark,
                    useLLMSummary: true,
                    summarizeWithLLM: async (input) =>
                        await this.runCompactionSummaryLLM(connection, input),
                    archiveWriter,
                    signal: controller.signal,
                    attachNotice: false,
                });
                if (autoReport.compacted) {
                    turnCompactionNotice = {
                        tokensBefore: autoReport.tokensBefore,
                        tokensAfter: autoReport.tokensAfter,
                        foldedToolResults: autoReport.foldedToolResults,
                        archivedTurns: autoReport.archivedTurns,
                        summaryMode:
                            autoReport.summaryMode === 'none'
                                ? 'fold_only'
                                : autoReport.summaryMode,
                        ...(autoReport.summaryText
                            ? { summaryText: autoReport.summaryText }
                            : {}),
                        ...(autoReport.archivedChunkPath
                            ? { archivedChunkPath: autoReport.archivedChunkPath }
                            : {}),
                        timestamp: autoReport.timestamp,
                    };
                }
                activeRetryStatus = undefined;
                syncAssistantBubble({
                    interrupted: undefined,
                    errorCode: undefined,
                    errorMessage: undefined,
                    canContinue: undefined,
                    retryStatus: undefined,
                });
                return canonicalClone(assistantMessage);
            };

            let overflowRecoveryAttempted = false;

            while (rounds < this.maxToolRounds) {
                throwIfAssistantAborted(controller.signal);
                rounds += 1;

                let assembled = assembleCurrentRequest();

                // Pre-flight Context Check (§3.3): compact history & fold earlier in-flight tool outputs
                // before sending when calibrated estimate reaches preFlightThreshold.
                const preflightCalibratedTokens = this.sessionStore.estimateCalibratedTokens(
                    sessionId,
                    assembled.estimatedTokens,
                );
                if (preflightCalibratedTokens >= budget.preFlightThreshold) {
                    const preflightReport = await this.sessionStore.compactSession(sessionId, {
                        mode: 'auto',
                        reason: 'preflight',
                        force: true,
                        useLLMSummary: false,
                        targetLowTokens: budget.autoLowWatermark,
                        watermark: {
                            high: budget.autoHighWatermark,
                            low: budget.autoLowWatermark,
                        },
                        archiveWriter,
                        signal: controller.signal,
                        attachNotice: false,
                    });

                    assembled = assembleCurrentRequest();
                    let foldedInFlight = 0;
                    if (assembled.estimatedTokens >= budget.preFlightThreshold) {
                        foldedInFlight += foldInFlightToolMessages(inFlightMessages, {
                            keepRecentRounds: 1,
                        });
                        assembled = assembleCurrentRequest();
                    }
                    if (assembled.estimatedTokens >= budget.preFlightThreshold) {
                        foldedInFlight += foldInFlightToolMessages(inFlightMessages, {
                            keepRecentRounds: 0,
                        });
                        assembled = assembleCurrentRequest();
                    }

                    if (preflightReport.compacted || foldedInFlight > 0) {
                        turnCompactionNotice = {
                            tokensBefore: preflightCalibratedTokens,
                            tokensAfter: assembled.estimatedTokens,
                            foldedToolResults: preflightReport.foldedToolResults + foldedInFlight,
                            archivedTurns: preflightReport.archivedTurns,
                            summaryMode:
                                preflightReport.summaryMode === 'none'
                                    ? 'fold_only'
                                    : preflightReport.summaryMode,
                            ...(preflightReport.summaryText
                                ? { summaryText: preflightReport.summaryText }
                                : {}),
                            ...(preflightReport.archivedChunkPath
                                ? { archivedChunkPath: preflightReport.archivedChunkPath }
                                : {}),
                            timestamp: this.now(),
                        };
                        syncAssistantBubble();
                    }
                }

                // Invoke LLM with Context Overflow Auto-Recovery (§3.3) + Transient Auto-Retry (§3.5).
                const roundStartContentBuffer = contentBuffer;
                const roundStartThinkBuffer = thinkBuffer;
                const roundMarker = {
                    id: this.idGenerator(),
                    startedAt: this.now(),
                    thinkStart: thinkBuffer.length,
                    contentStart: contentBuffer.length,
                    toolCallIds: [] as string[],
                } as (typeof roundMarkers)[number];
                roundMarkers.push(roundMarker);
                let turnOutput!: TurnLLMOutput;
                let transientRetriesUsed = 0;
                let hasNativeReasoning = false;
                let roundStepBriefThinkBuffer = '';
                let finishTurnStreamedAnyResponse = false;
                let finishTurnStreamedAnyStepBrief = false;
                const finishTurnExtractor = strictToolLoop
                    ? new FinishTurnStreamExtractor({
                          onResponseDelta: (delta) => {
                              finishTurnStreamedAnyResponse = true;
                              contentBuffer += delta;
                              options.onDelta?.(delta);
                              syncAssistantBubble();
                          },
                          onStepBriefDelta: (delta) => {
                              if (!hasNativeReasoning) {
                                  finishTurnStreamedAnyStepBrief = true;
                                  roundStepBriefThinkBuffer += delta;
                                  thinkBuffer += delta;
                                  options.onReasoningDelta?.(delta);
                                  syncAssistantBubble();
                              }
                          },
                          onSuppressed: () => {
                              if (finishTurnStreamedAnyResponse || finishTurnStreamedAnyStepBrief) {
                                  contentBuffer = roundStartContentBuffer;
                                  if (!hasNativeReasoning) {
                                      thinkBuffer = roundStartThinkBuffer;
                                      roundStepBriefThinkBuffer = '';
                                  }
                                  finishTurnStreamedAnyResponse = false;
                                  finishTurnStreamedAnyStepBrief = false;
                                  syncAssistantBubble();
                              }
                          },
                      })
                    : undefined;

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    throwIfAssistantAborted(controller.signal);

                    const allowedToolNames = assembled.tools.map((t) => t.name);
                    const toolChoice: LLMToolChoice | undefined =
                        strictToolLoop && allowedToolNames.length > 0
                            ? { mode: 'required', allowedToolNames }
                            : undefined;

                    const request: LLMRequest = {
                        connectionId: connection.id,
                        connection,
                        messages: assembled.messages,
                        tools: assembled.tools,
                        ...(toolChoice ? { toolChoice } : {}),
                        cacheBreakpoints: assembled.cacheBreakpoints,
                        stream: useStream,
                        signal: controller.signal,
                    };

                    hasNativeReasoning = false;
                    let roundStreamThinkBuffer = '';
                    roundStepBriefThinkBuffer = '';
                    finishTurnStreamedAnyResponse = false;
                    finishTurnStreamedAnyStepBrief = false;
                    finishTurnExtractor?.resetRound();

                    try {
                        turnOutput = await this.invokeLLM(request, useStream, {
                            onTextDelta: strictToolLoop
                                ? undefined
                                : (delta) => {
                                      contentBuffer += delta;
                                      options.onDelta?.(delta);
                                      syncAssistantBubble();
                                  },
                            onReasoningDelta: (delta) => {
                                if (!hasNativeReasoning && finishTurnStreamedAnyStepBrief) {
                                    thinkBuffer = roundStartThinkBuffer;
                                    roundStepBriefThinkBuffer = '';
                                    finishTurnStreamedAnyStepBrief = false;
                                }
                                hasNativeReasoning = true;
                                roundStreamThinkBuffer += delta;
                                thinkBuffer += delta;
                                options.onReasoningDelta?.(delta);
                                syncAssistantBubble();
                            },
                            onToolCallDelta: finishTurnExtractor
                                ? (index, delta) => {
                                      finishTurnExtractor.feedToolCallDelta(index, delta);
                                  }
                                : undefined,
                        });

                        if (!isLengthFinishReason(turnOutput.finishReason)) {
                            if (
                                turnOutput.toolCalls.length === 0
                                && !turnOutput.content.trim()
                            ) {
                                throw new LLMTransportError(
                                    '模型返回了空响应（可能是网络波动或流式连接提前断开）',
                                    { retryable: true, code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE },
                                );
                            }
                            if (
                                request.toolChoice?.mode === 'required'
                                && turnOutput.toolCalls.length === 0
                            ) {
                                throw new LLMTransportError(
                                    '模型未按强约束工具要求调用工具（TOOL_CHOICE_VIOLATION）',
                                    {
                                        retryable: true,
                                        code: ROUND_RETRY_ERROR_CODES.TOOL_CHOICE_VIOLATION,
                                    },
                                );
                            }
                            if (
                                strictToolLoop
                                && turnOutput.toolCalls.some(
                                    (tc) => !isValidJsonObjectString(tc.arguments),
                                )
                            ) {
                                throw new LLMTransportError(
                                    '模型返回了格式损坏的工具参数 JSON（MALFORMED_TOOL_CALL）',
                                    {
                                        retryable: true,
                                        code: ROUND_RETRY_ERROR_CODES.MALFORMED_TOOL_CALL,
                                    },
                                );
                            }
                            if (
                                strictToolLoop
                                && turnOutput.toolCalls.length === 1
                                && turnOutput.toolCalls[0].name === FINISH_TURN_TOOL_NAME
                            ) {
                                const parsedFinish = safeParseJsonObject(
                                    turnOutput.toolCalls[0].arguments,
                                );
                                const candidateResp =
                                    typeof parsedFinish.response === 'string'
                                        ? parsedFinish.response
                                        : '';
                                if (!candidateResp.trim()) {
                                    throw new LLMTransportError(
                                        'finish_turn 缺少非空 response 参数（MALFORMED_TOOL_CALL）',
                                        {
                                            retryable: true,
                                            code: ROUND_RETRY_ERROR_CODES.MALFORMED_TOOL_CALL,
                                        },
                                    );
                                }
                            }
                        }

                        if (activeRetryStatus) {
                            activeRetryStatus = undefined;
                            syncAssistantBubble({ retryStatus: undefined });
                        }
                        if (!useStream && turnOutput.reasoningContent) {
                            hasNativeReasoning = true;
                            roundStreamThinkBuffer = turnOutput.reasoningContent;
                        }
                        currentRoundThinkBuffer =
                            turnOutput.reasoningContent
                            || roundStreamThinkBuffer
                            || roundStepBriefThinkBuffer;
                        break;
                    } catch (llmError) {
                        if (
                            isAssistantAbortError(llmError)
                            || isAbortError(llmError)
                            || controller.signal.aborted
                        ) {
                            throw llmError;
                        }

                        const overflow = parseContextOverflowError(llmError);
                        if (overflow) {
                            if (overflowRecoveryAttempted) {
                                throw llmError;
                            }
                            overflowRecoveryAttempted = true;

                            const effectiveLimit = overflow.limitTokens ?? budget.safeInputBudget;
                            const emergencyTargetLow = Math.max(
                                256,
                                Math.floor(effectiveLimit * 0.4),
                            );
                            const tokensBeforeRecovery =
                                overflow.actualTokens ?? assembled.estimatedTokens;

                            // Emergency compaction MUST disable LLM summary (useLLMSummary: false)
                            // to prevent recursive 400 deadlocks against the overflowed connection.
                            const recoveryReport = await this.sessionStore.compactSession(
                                sessionId,
                                {
                                    mode: 'full',
                                    reason: 'overflow_recovery',
                                    force: true,
                                    useLLMSummary: false,
                                    targetLowTokens: emergencyTargetLow,
                                    archiveWriter,
                                    signal: controller.signal,
                                    attachNotice: false,
                                },
                            );

                            // Crop oversized role==='tool' contents in-place, preserving toolCallId pairing.
                            const croppedInFlight = cropInFlightToolMessagesForOverflow(
                                inFlightMessages,
                                { limitTokens: effectiveLimit },
                            );

                            // Reset partial streaming buffers from the failed overflow attempt.
                            finishTurnExtractor?.resetRound();
                            contentBuffer = roundStartContentBuffer;
                            thinkBuffer = roundStartThinkBuffer;
                            currentRoundThinkBuffer = '';

                            if (!recoveryReport.compacted && croppedInFlight === 0) {
                                // Overflow cannot be relieved by compaction or tool cropping.
                                throw llmError;
                            }

                            assembled = assembleCurrentRequest();
                            turnCompactionNotice = {
                                tokensBefore: tokensBeforeRecovery,
                                tokensAfter: assembled.estimatedTokens,
                                foldedToolResults:
                                    recoveryReport.foldedToolResults + croppedInFlight,
                                archivedTurns: recoveryReport.archivedTurns,
                                summaryMode:
                                    recoveryReport.summaryMode === 'none'
                                        ? 'fold_only'
                                        : recoveryReport.summaryMode,
                                ...(recoveryReport.summaryText
                                    ? { summaryText: recoveryReport.summaryText }
                                    : {}),
                                ...(recoveryReport.archivedChunkPath
                                    ? { archivedChunkPath: recoveryReport.archivedChunkPath }
                                    : {}),
                                timestamp: this.now(),
                            };
                            syncAssistantBubble();
                            continue;
                        }

                        if (
                            this.autoRetryConfig !== false
                            && transientRetriesUsed < effectiveMaxRoundRetries
                            && isRetryableRoundError(llmError)
                        ) {
                            transientRetriesUsed += 1;
                            finishTurnExtractor?.resetRound();
                            contentBuffer = roundStartContentBuffer;
                            thinkBuffer = roundStartThinkBuffer;
                            currentRoundThinkBuffer = '';

                            const delayMs = computeRoundRetryDelayMs({
                                error: llmError,
                                attempt: transientRetriesUsed,
                                initialDelayMs: this.autoRetryConfig.initialDelayMs,
                                maxDelayMs: this.autoRetryConfig.maxDelayMs,
                                backoffFactor: this.autoRetryConfig.backoffFactor,
                                jitterRatio: 0.25,
                            });

                            const rawReason =
                                llmError instanceof Error ? llmError.message : String(llmError);
                            const reason = truncateSummary(redactWithReport(rawReason).value, 120);
                            activeRetryStatus = {
                                attempt: transientRetriesUsed,
                                maxAttempts: effectiveMaxRoundRetries,
                                reason,
                                delayMs,
                            };
                            try {
                                options.onRetry?.(canonicalClone(activeRetryStatus));
                            } catch {
                                // Keep retry loop resilient to callback errors.
                            }
                            syncAssistantBubble({ retryStatus: activeRetryStatus });

                            if (delayMs > 0) {
                                await delayWithAbort(delayMs, controller.signal);
                            }
                            throwIfAssistantAborted(controller.signal);

                            activeRetryStatus = undefined;
                            syncAssistantBubble({ retryStatus: undefined });
                            continue;
                        }

                        throw llmError;
                    }
                }

                // Record real usage calibration anchor after successful LLM response.
                if (turnOutput.usage.inputTokens > 0) {
                    this.sessionStore.recordUsageAnchor(
                        sessionId,
                        turnOutput.usage.inputTokens,
                        assembled.estimatedTokens,
                        this.trajectoryStore.getMessageCount(threadId),
                    );
                }

                roundMarker.respondedAt = this.now();
                cumulativeUsage = addTokenUsage(cumulativeUsage, turnOutput.usage);

                // Protect against max_tokens truncation (both partial text and truncated tool JSON).
                if (isLengthFinishReason(turnOutput.finishReason)) {
                    if (turnOutput.toolCalls.length > 0) {
                        contentBuffer = roundStartContentBuffer;
                        thinkBuffer = roundStartThinkBuffer;
                        currentRoundThinkBuffer = '';
                    } else {
                        const prefillText = consumeTrailingPrefill(
                            activeTailMessages,
                            inFlightMessages,
                        );
                        if (prefillText) {
                            turnOutput.content = `${prefillText}${turnOutput.content}`;
                        }
                        if (!useStream || strictToolLoop) {
                            if (turnOutput.content) {
                                contentBuffer = `${roundStartContentBuffer}${turnOutput.content}`;
                                options.onDelta?.(turnOutput.content);
                            }
                            if (!useStream && turnOutput.reasoningContent) {
                                thinkBuffer += turnOutput.reasoningContent;
                                options.onReasoningDelta?.(turnOutput.reasoningContent);
                            }
                        } else if (prefillText) {
                            contentBuffer = `${roundStartContentBuffer}${prefillText}${contentBuffer.slice(roundStartContentBuffer.length)}`;
                        }
                    }
                    const lengthMsg =
                        turnOutput.toolCalls.length > 0
                            ? '模型输出达到长度上限，工具参数可能已截断，请点击继续生成。'
                            : '模型输出达到长度上限已截断，请点击继续生成。';
                    saveCheckpoint('length', { errorMessage: lengthMsg });
                    activeRetryStatus = undefined;
                    syncAssistantBubble({
                        interrupted: true,
                        errorCode: 'length',
                        errorMessage: lengthMsg,
                        canContinue: true,
                        retryStatus: undefined,
                    });
                    return canonicalClone(assistantMessage);
                }

                // Multi-round Prefill (`partial: true` / `prefix: true`) auto-consumption folding (§3.4 #4):
                // Pop any trailing prefill assistant placeholder and merge its prefix text into
                // this round's assistant output so subsequent tool rounds never send stale prefill flags.
                const consumedPrefillText = consumeTrailingPrefill(
                    activeTailMessages,
                    inFlightMessages,
                );
                if (consumedPrefillText) {
                    turnOutput.content = `${consumedPrefillText}${turnOutput.content}`;
                }

                if (!useStream) {
                    if (!strictToolLoop && turnOutput.content) {
                        contentBuffer += turnOutput.content;
                        options.onDelta?.(turnOutput.content);
                    }
                    if (turnOutput.reasoningContent) {
                        thinkBuffer += turnOutput.reasoningContent;
                        options.onReasoningDelta?.(turnOutput.reasoningContent);
                    }
                } else if (!strictToolLoop && consumedPrefillText) {
                    contentBuffer = `${roundStartContentBuffer}${consumedPrefillText}${contentBuffer.slice(roundStartContentBuffer.length)}`;
                }

                // Clean solo `finish_turn` completion (§3.6): transparent Markdown unwrapping,
                // zero tool-call cards, clean text persisted to TrajectoryStore for reconcileTurnMessages.
                const isSoloFinishTurn =
                    strictToolLoop
                    && turnOutput.toolCalls.length === 1
                    && turnOutput.toolCalls[0].name === FINISH_TURN_TOOL_NAME;

                if (isSoloFinishTurn) {
                    const finishArgs = safeParseJsonObject(turnOutput.toolCalls[0].arguments);
                    const parsedResponse =
                        typeof finishArgs.response === 'string' ? finishArgs.response : '';
                    const streamedResponse =
                        finishTurnExtractor && !finishTurnExtractor.isSuppressed()
                            ? finishTurnExtractor.getDecodedResponse()
                            : '';
                    const finalResponse = parsedResponse || streamedResponse;

                    if (useStream) {
                        if (!finishTurnStreamedAnyResponse) {
                            contentBuffer = `${roundStartContentBuffer}${finalResponse}`;
                            if (finalResponse) {
                                options.onDelta?.(finalResponse);
                            }
                        } else if (finalResponse !== streamedResponse) {
                            if (
                                finalResponse.startsWith(streamedResponse)
                                && finalResponse.length > streamedResponse.length
                            ) {
                                const missingSuffix = finalResponse.slice(streamedResponse.length);
                                contentBuffer = `${roundStartContentBuffer}${finalResponse}`;
                                options.onDelta?.(missingSuffix);
                            } else {
                                contentBuffer = `${roundStartContentBuffer}${finalResponse}`;
                            }
                        }
                    } else {
                        contentBuffer = `${roundStartContentBuffer}${finalResponse}`;
                        if (finalResponse) {
                            options.onDelta?.(finalResponse);
                        }
                    }

                    const parsedStepBrief =
                        typeof finishArgs.step_brief === 'string' ? finishArgs.step_brief : '';
                    const effectiveReasoning = turnOutput.reasoningContent || parsedStepBrief;
                    if (!turnOutput.reasoningContent && parsedStepBrief) {
                        if (!useStream) {
                            thinkBuffer = `${roundStartThinkBuffer}${parsedStepBrief}`;
                            options.onReasoningDelta?.(parsedStepBrief);
                        } else if (roundStepBriefThinkBuffer !== parsedStepBrief) {
                            if (
                                parsedStepBrief.startsWith(roundStepBriefThinkBuffer)
                                && parsedStepBrief.length > roundStepBriefThinkBuffer.length
                            ) {
                                const missingThink = parsedStepBrief.slice(
                                    roundStepBriefThinkBuffer.length,
                                );
                                thinkBuffer = `${roundStartThinkBuffer}${parsedStepBrief}`;
                                options.onReasoningDelta?.(missingThink);
                            } else {
                                thinkBuffer = `${roundStartThinkBuffer}${parsedStepBrief}`;
                            }
                        }
                    }

                    const finalContentForTrajectory =
                        committedContentPrefixLen === 0 ? contentBuffer : finalResponse;
                    return await commitFinalAssistantTurn(
                        finalContentForTrajectory,
                        effectiveReasoning,
                    );
                }

                // Final text-only turn: commit to TrajectoryStore & run adaptive watermark check.
                if (turnOutput.toolCalls.length === 0) {
                    const finalContentForTrajectory =
                        committedContentPrefixLen === 0 ? contentBuffer : turnOutput.content;
                    return await commitFinalAssistantTurn(
                        finalContentForTrajectory,
                        turnOutput.reasoningContent,
                    );
                }

                // Mixed-call anti-jump safeguard (§3.6 #4): if a non-solo round streamed any
                // premature finish_turn text before suppression, ensure buffers are rolled back.
                if (strictToolLoop && contentBuffer !== roundStartContentBuffer) {
                    contentBuffer = roundStartContentBuffer;
                    if (!hasNativeReasoning) {
                        thinkBuffer = roundStartThinkBuffer;
                    }
                    syncAssistantBubble();
                }

                // Bind this round's visible preface + issued tool calls to its timeline step
                // before executing, so the UI can show pending rows immediately.
                roundMarker.preface = contentBuffer.slice(roundMarker.contentStart);
                roundMarker.toolCallIds = turnOutput.toolCalls
                    .filter((tc) => !(strictToolLoop && tc.name === FINISH_TURN_TOOL_NAME))
                    .map((tc) => tc.id);
                syncAssistantBubble();

                // Tool-calling round: execute tools, committing paired assistant(toolCalls)+tool results atomically.
                const assistantToolMessage: CanonicalMessage = {
                    role: 'assistant',
                    content: turnOutput.content,
                    ...(turnOutput.reasoningContent
                        ? { reasoningContent: turnOutput.reasoningContent }
                        : {}),
                    toolCalls: canonicalClone(turnOutput.toolCalls),
                };
                const roundExecutedTools: CanonicalMessage[] = [];
                const roundPendingApprovalIds: string[] = [];

                const liveSession = this.sessionStore.getSession(sessionId) ?? currentSession;
                let suspendedThisRound = false;

                for (const toolCall of turnOutput.toolCalls) {
                    throwIfAssistantAborted(controller.signal);

                    // Built-in `finish_turn` in a mixed round (§3.6 #4): bypass policy/approval,
                    // emit zero UI tool card, and defer until subsequent round after business tools complete.
                    if (strictToolLoop && toolCall.name === FINISH_TURN_TOOL_NAME) {
                        roundExecutedTools.push({
                            role: 'tool',
                            toolCallId: toolCall.id,
                            toolName: FINISH_TURN_TOOL_NAME,
                            content: DEFERRED_FINISH_TURN_PAYLOAD,
                        });
                        continue;
                    }

                    const startedAt = this.now();
                    const parsedArgs = safeParseJsonObject(toolCall.arguments);
                    const capabilities = this.getExtensionCapabilities();
                    const policy = evaluateToolPolicy(toolCall.name, parsedArgs, {
                        mode: liveSession.mode,
                        stAdminEnabled: liveSession.stAdminEnabled,
                        autoApproveAuthor: liveSession.autoApproveAuthor,
                        autoApproveChatDelete: liveSession.autoApproveChatDelete,
                        extensionCapabilities: capabilities,
                    });

                    const redactedArgsSummary = truncateSummary(
                        JSON.stringify(redactWithReport(parsedArgs).value),
                        140,
                    );

                    // 1. Policy denied -> reject without executing
                    if (!policy.allowed) {
                        const deniedPayload = JSON.stringify({
                            ok: false,
                            error: policy.reason ?? `Tool "${toolCall.name}" denied by policy.`,
                        });
                        toolCallRecords.push({
                            id: toolCall.id,
                            name: toolCall.name,
                            scopeLabel: policy.scopeLabel,
                            status: 'error',
                            durationMs: Math.max(0, this.now() - startedAt),
                            argsSummary: redactedArgsSummary,
                            resultSummary: truncateSummary(
                                policy.reason ?? `Denied tool "${toolCall.name}"`,
                            ),
                        });
                        roundExecutedTools.push({
                            role: 'tool',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            content: deniedPayload,
                        });
                        syncAssistantBubble();
                        continue;
                    }

                    const toolDef = this.resolveToolDefinition(toolCall.name, capabilities);
                    if (!toolDef) {
                        const missingMsg = `Tool "${toolCall.name}" is allowed by policy but not registered.`;
                        toolCallRecords.push({
                            id: toolCall.id,
                            name: toolCall.name,
                            scopeLabel: policy.scopeLabel,
                            status: 'error',
                            durationMs: Math.max(0, this.now() - startedAt),
                            argsSummary: redactedArgsSummary,
                            resultSummary: missingMsg,
                        });
                        roundExecutedTools.push({
                            role: 'tool',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            content: JSON.stringify({ ok: false, error: missingMsg }),
                        });
                        syncAssistantBubble();
                        continue;
                    }

                    const toolCtx = this.createToolContext({
                        session: liveSession,
                        toolCallId: toolCall.id,
                        target,
                        signal: controller.signal,
                    });

                    // 2. Requires approval (including non-bypassable mandatoryConfirm) -> suspend into bubble PendingApproval
                    const effectiveAutoApprove = isToolAutoApproved(toolCall.name, {
                        mode: liveSession.mode,
                        stAdminEnabled: liveSession.stAdminEnabled,
                        autoApproveAuthor: liveSession.autoApproveAuthor,
                        autoApproveChatDelete: liveSession.autoApproveChatDelete,
                    });
                    if (shouldRequireApproval(policy, effectiveAutoApprove)) {
                        const validated = toolDef.parameters.safeParse(parsedArgs);
                        if (!validated.success) {
                            const errResult = await executeAssistantTool(toolDef, parsedArgs, toolCtx);
                            toolCallRecords.push({
                                id: toolCall.id,
                                name: toolCall.name,
                                scopeLabel: policy.scopeLabel,
                                status: 'error',
                                durationMs: Math.max(0, this.now() - startedAt),
                                argsSummary: redactedArgsSummary,
                                resultSummary: truncateSummary(errResult.error ?? errResult.output),
                                ...(errResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
                            });
                            roundExecutedTools.push({
                                role: 'tool',
                                toolCallId: toolCall.id,
                                toolName: toolCall.name,
                                content: errResult.output,
                            });
                            syncAssistantBubble();
                            continue;
                        }

                        const preview = await this.buildApprovalPreview(
                            toolDef,
                            validated.data as Record<string, unknown>,
                            policy,
                            toolCtx,
                        );
                        const pending = this.approvalGate.create({
                            sessionId,
                            messageId: assistantMessageId,
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            riskLevel: policy.riskLevel === 'high' ? 'high' : 'medium',
                            mandatoryConfirm: policy.mandatoryConfirm,
                            title: preview.title,
                            summary: preview.summary,
                            targetLabel: preview.targetLabel,
                            rawContent: preview.rawContent,
                            diffLines: preview.diffLines,
                            args: canonicalClone(validated.data as Record<string, unknown>),
                        });

                        approvalIds.push(pending.id);
                        roundPendingApprovalIds.push(pending.id);
                        this.suspendedApprovals.set(pending.id, {
                            approvalId: pending.id,
                            sessionId,
                            messageId: assistantMessageId,
                            toolCall: canonicalClone(toolCall),
                            policy,
                            target,
                            inFlightMessages: canonicalClone([
                                ...inFlightMessages,
                                assistantToolMessage,
                                ...roundExecutedTools,
                            ]),
                        });
                        suspendedThisRound = true;
                        syncAssistantBubble();
                        continue;
                    }

                    // 3. Direct execution (read-only, adjust, or non-mandatory autoApproveAuthor)
                    const execResult = await executeAssistantTool(toolDef, parsedArgs, toolCtx);
                    if (!toolDef.readOnly && execResult.ok && execResult.fileRefs?.length) {
                        for (const ref of execResult.fileRefs) {
                            fileRefs.add(ref);
                        }
                    }

                    toolCallRecords.push({
                        id: toolCall.id,
                        name: toolCall.name,
                        scopeLabel: policy.scopeLabel,
                        status: execResult.ok ? 'ok' : 'error',
                        durationMs: Math.max(0, this.now() - startedAt),
                        argsSummary: redactedArgsSummary,
                        resultSummary: truncateSummary(
                            execResult.ok
                                ? execResult.output
                                : execResult.error ?? execResult.output,
                        ),
                        ...(execResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
                        ...(execResult.undoId ? { undoId: execResult.undoId } : {}),
                    });

                    roundExecutedTools.push({
                        role: 'tool',
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        content: execResult.output,
                    });
                    syncAssistantBubble();
                }

                // Ensure any suspended approvals captured in a mixed round also include all sibling
                // tool responses from this round (e.g., deferred `finish_turn` responses) so
                // `decideApproval` / `retryApproval` always preserve valid tool_call_id pairing.
                if (roundPendingApprovalIds.length > 0) {
                    const fullSuspendedInFlight = canonicalClone([
                        ...inFlightMessages,
                        assistantToolMessage,
                        ...roundExecutedTools,
                    ]);
                    for (const pendingId of roundPendingApprovalIds) {
                        const existingSuspended = this.suspendedApprovals.get(pendingId);
                        if (existingSuspended) {
                            existingSuspended.inFlightMessages = canonicalClone(
                                fullSuspendedInFlight,
                            );
                        }
                    }
                }

                inFlightMessages.push(assistantToolMessage, ...roundExecutedTools);
                committedContentPrefixLen = contentBuffer.length;
                currentRoundThinkBuffer = '';

                // Suspend turn cleanly so the inline bubble approval UI renders without blocking.
                if (suspendedThisRound) {
                    syncAssistantBubble();
                    return canonicalClone(assistantMessage);
                }
            }

            // Reached maxToolRounds: save checkpoint and mark interrupted so user can continue.
            const maxRoundsMsg = `已达到单轮最大工具调用次数上限（${this.maxToolRounds} 轮），可点击继续接着执行。`;
            saveCheckpoint('max_tool_rounds', { errorMessage: maxRoundsMsg });
            activeRetryStatus = undefined;
            syncAssistantBubble({
                interrupted: true,
                errorCode: 'max_tool_rounds',
                errorMessage: maxRoundsMsg,
                canContinue: true,
                retryStatus: undefined,
            });
            return canonicalClone(assistantMessage);
        } catch (error) {
            activeRetryStatus = undefined;
            if (
                isAssistantAbortError(error)
                || isAbortError(error)
                || controller.signal.aborted
            ) {
                saveCheckpoint('user_stop');
                syncAssistantBubble({
                    interrupted: true,
                    errorCode: 'user_stop',
                    canContinue: true,
                    retryStatus: undefined,
                });
                return canonicalClone(assistantMessage);
            }
            const errorCode = classifyAssistantErrorCode(error);
            const isOverflow = errorCode === 'context_overflow';
            const redactedErr = String(
                redactWithReport(error instanceof Error ? error.message : String(error)).value,
            );
            if (!isOverflow) {
                saveCheckpoint(errorCode, { errorMessage: redactedErr });
            }
            contentBuffer = contentBuffer
                ? `${contentBuffer}\n\n[Error] ${redactedErr}`
                : `[Error] ${redactedErr}`;
            syncAssistantBubble({
                interrupted: true,
                errorCode,
                errorMessage: redactedErr,
                canContinue: !isOverflow,
                retryStatus: undefined,
            });
            throw new Error(redactedErr);
        } finally {
            cleanupExternalSignal();
            if (this.activeControllers.get(sessionId) === controller) {
                this.activeControllers.delete(sessionId);
            }
        }
    }

    // ========================================================================
    // Inline Bubble Approval / Reject / Retry / Undo Lifecycle
    // ========================================================================

    public async decideApproval(
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ): Promise<PendingApproval | null> {
        const existing = this.approvalGate.get(approvalId);
        if (!existing) {
            return null;
        }

        if (decision === 'reject') {
            const rejected = this.approvalGate.reject(approvalId, feedback);
            this.notify();
            return rejected;
        }

        // Approve: validate status first before executing write.
        if (existing.status !== 'pending') {
            throw new Error(
                `Cannot approve "${approvalId}" from status "${existing.status}"; expected "pending".`,
            );
        }

        const session = this.sessionStore.getSession(existing.sessionId);
        if (!session) {
            throw new Error(`Session "${existing.sessionId}" not found for approval "${approvalId}".`);
        }

        const capabilities = this.getExtensionCapabilities();
        const policy = evaluateToolPolicy(existing.toolName, existing.args, {
            mode: session.mode,
            stAdminEnabled: session.stAdminEnabled,
            autoApproveAuthor: session.autoApproveAuthor,
            autoApproveChatDelete: session.autoApproveChatDelete,
            extensionCapabilities: capabilities,
        });
        if (!policy.allowed) {
            throw new Error(policy.reason ?? `Tool "${existing.toolName}" is no longer allowed.`);
        }

        const toolDef = this.resolveToolDefinition(existing.toolName, capabilities);
        if (!toolDef) {
            throw new Error(`Tool "${existing.toolName}" is not registered.`);
        }

        const suspended = this.suspendedApprovals.get(approvalId);
        const target = suspended?.target ?? this.resolveActiveTarget();
        const startedAt = this.now();
        const signal = new AbortController().signal;

        const toolCtx = this.createToolContext({
            session,
            toolCallId: existing.toolCallId,
            target,
            signal,
        });

        const execResult = await executeAssistantTool(toolDef, existing.args, toolCtx);
        if (!execResult.ok) {
            throw new Error(execResult.error ?? `Execution of "${existing.toolName}" failed.`);
        }

        const approved = this.approvalGate.approve(approvalId, { undoId: execResult.undoId });

        const toolRecord: AssistantToolCallRecord = {
            id: existing.toolCallId,
            name: existing.toolName,
            scopeLabel: policy.scopeLabel,
            status: 'ok',
            durationMs: Math.max(0, this.now() - startedAt),
            argsSummary: truncateSummary(JSON.stringify(redactWithReport(existing.args).value), 140),
            resultSummary: truncateSummary(execResult.output),
            ...(execResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
            ...(execResult.undoId ? { undoId: execResult.undoId } : {}),
        };

        this.sessionStore.updateMessage(existing.sessionId, existing.messageId, (msg) => {
            const nextCalls = [...(msg.toolCalls ?? [])];
            const idx = nextCalls.findIndex((c) => c.id === toolRecord.id);
            if (idx >= 0) {
                nextCalls[idx] = toolRecord;
            } else {
                nextCalls.push(toolRecord);
            }
            const nextFileRefs =
                !toolDef.readOnly && execResult.fileRefs?.length
                    ? Array.from(new Set([...(msg.fileRefs ?? []), ...execResult.fileRefs]))
                    : msg.fileRefs;
            return {
                ...msg,
                content: msg.content.trim() ? msg.content : `已执行：${approved.title}`,
                toolCalls: nextCalls,
                ...(nextFileRefs?.length ? { fileRefs: nextFileRefs } : {}),
            };
        });

        // Commit the approved tool call + result into the session's TrajectoryStore thread.
        if (suspended) {
            const committedTurn: CanonicalMessage[] = [
                ...suspended.inFlightMessages,
                {
                    role: 'tool',
                    toolCallId: existing.toolCallId,
                    toolName: existing.toolName,
                    content: execResult.output,
                },
                {
                    role: 'assistant',
                    content: `Approved and executed ${existing.toolName}: ${approved.title}`,
                },
            ];
            this.sessionStore.appendTrajectoryTurn(existing.sessionId, committedTurn);
            const budget = this.resolveSessionContextBudget(session);
            this.sessionStore.compactIfNeeded(existing.sessionId, {
                watermark: {
                    high: budget.autoHighWatermark,
                    low: budget.autoLowWatermark,
                },
            });
            this.suspendedApprovals.delete(approvalId);
        }

        this.notify();
        return approved;
    }

    /**
     * Retry a `pending` or `rejected` approval by injecting optional user feedback into
     * the LLM, generating a revised tool proposal and real Diff, and incrementing `revision`.
     */
    public async retryApproval(
        approvalId: string,
        feedback?: string,
    ): Promise<PendingApproval | null> {
        const existing = this.approvalGate.get(approvalId);
        if (!existing) {
            return null;
        }
        if (existing.status === 'approved') {
            throw new Error(
                `Cannot retry already approved item "${approvalId}"; use undo() to revert instead.`,
            );
        }

        const session = this.sessionStore.getSession(existing.sessionId);
        if (!session) {
            throw new Error(`Session "${existing.sessionId}" not found for approval "${approvalId}".`);
        }

        const suspended = this.suspendedApprovals.get(approvalId);
        const target = suspended?.target ?? this.resolveActiveTarget();
        const connection = this.resolveEffectiveConnection(session.connectionId);
        const strictToolLoop = Boolean(connection.strictToolLoop);
        const capabilities = this.getExtensionCapabilities();
        const systemPrompt = buildAssistantSystemPrompt(
            session.mode,
            session.stAdminEnabled,
            capabilities,
            this.docsRegistry.listExternalIndexEntries(),
        );
        const allowedToolDefs = this.getAllowedToolDefinitions(
            session.mode,
            session.stAdminEnabled,
        );
        const baseCanonicalTools = toCanonicalAssistantToolSchemas(allowedToolDefs);
        const canonicalTools = strictToolLoop
            ? appendFinishTurnTool(baseCanonicalTools)
            : baseCanonicalTools;

        const controller = new AbortController();
        this.activeControllers.set(existing.sessionId, controller);

        const feedbackText = feedback?.trim() || existing.rejectionFeedback?.trim() || '';
        const retryInstruction = feedbackText
            ? `User requested a revision for pending tool "${existing.toolName}" (revision #${existing.revision}) with feedback: ${feedbackText}. Call "${existing.toolName}" again with the revised arguments.`
            : `User requested an alternative revised proposal for pending tool "${existing.toolName}" (revision #${existing.revision}). Call "${existing.toolName}" again with revised arguments.`;

        const baseInFlight: CanonicalMessage[] = suspended
            ? canonicalClone(suspended.inFlightMessages)
            : [
                {
                    role: 'assistant',
                    content: existing.summary,
                    toolCalls: [
                        {
                            id: existing.toolCallId,
                            name: existing.toolName,
                            arguments: JSON.stringify(existing.args),
                        },
                    ],
                },
            ];

        const retryInFlight: CanonicalMessage[] = [
            ...baseInFlight,
            {
                role: 'tool',
                toolCallId: existing.toolCallId,
                toolName: existing.toolName,
                content: JSON.stringify({
                    ok: false,
                    status: 'retry_requested',
                    feedback: feedbackText || 'Please propose a revised version.',
                }),
            },
            {
                role: 'user',
                content: retryInstruction,
            },
        ];

        try {
            const threadId = toAssistantThreadId(existing.sessionId);
            const prefixFingerprint = this.computePresetPrefixFingerprint(session);
            const existingFrozenPrefix = this.trajectoryStore.getFrozenPrefix(threadId);
            const canReuseFrozenPrefix = this.isMatchingFrozenPrefix(
                existingFrozenPrefix,
                systemPrompt,
                canonicalTools,
                prefixFingerprint,
            );
            const presetPrompts = await this.resolvePresetPromptMessages(session, target, {
                skipPrefix: canReuseFrozenPrefix,
                excludeMessageId: existing.messageId,
                generationType: 'normal',
                connection,
                budget: this.resolveSessionContextBudget(session),
            });
            const effectivePrefixMessages: CanonicalMessage[] = canReuseFrozenPrefix
                ? canonicalClone(existingFrozenPrefix!.messages.slice(1))
                : presetPrompts.prefixMessages;
            const assembled = this.sessionStore.buildRequestMessages(
                existing.sessionId,
                systemPrompt,
                canonicalTools,
                retryInFlight,
                {
                    extraPrefixMessages: effectivePrefixMessages,
                    tailMessages: presetPrompts.tailMessages,
                    prefixFingerprint,
                },
            );
            const useStream = connection.stream ?? this.defaultStream;
            const request: LLMRequest = {
                connectionId: connection.id,
                connection,
                messages: assembled.messages,
                tools: assembled.tools,
                cacheBreakpoints: assembled.cacheBreakpoints,
                stream: useStream,
                signal: controller.signal,
            };

            const turnOutput = await this.invokeLLM(request, useStream, {});
            if (turnOutput.usage.inputTokens > 0) {
                this.sessionStore.recordUsageAnchor(
                    existing.sessionId,
                    turnOutput.usage.inputTokens,
                    assembled.estimatedTokens,
                    this.trajectoryStore.getMessageCount(threadId),
                );
            }

            const revisedCall =
                turnOutput.toolCalls.find((tc) => tc.name === existing.toolName)
                ?? turnOutput.toolCalls.find((tc) => tc.name !== FINISH_TURN_TOOL_NAME);

            if (revisedCall) {
                const revisedArgsRaw = safeParseJsonObject(revisedCall.arguments);
                const retryCapabilities = this.getExtensionCapabilities();
                const toolDef = this.resolveToolDefinition(revisedCall.name, retryCapabilities);
                const policy = evaluateToolPolicy(revisedCall.name, revisedArgsRaw, {
                    mode: session.mode,
                    stAdminEnabled: session.stAdminEnabled,
                    autoApproveAuthor: session.autoApproveAuthor,
                    autoApproveChatDelete: session.autoApproveChatDelete,
                    extensionCapabilities: retryCapabilities,
                });

                if (toolDef && policy.allowed) {
                    const validated = toolDef.parameters.safeParse(revisedArgsRaw);
                    const finalArgs = validated.success
                        ? (validated.data as Record<string, unknown>)
                        : revisedArgsRaw;
                    const toolCtx = this.createToolContext({
                        session,
                        toolCallId: revisedCall.id,
                        target,
                        signal: controller.signal,
                    });
                    const preview = await this.buildApprovalPreview(
                        toolDef,
                        finalArgs,
                        policy,
                        toolCtx,
                    );

                    const retried = this.approvalGate.retry(approvalId, {
                        rejectionFeedback: feedbackText || undefined,
                        toolCallId: revisedCall.id,
                        title: preview.title,
                        summary: preview.summary,
                        targetLabel: preview.targetLabel,
                        rawContent: preview.rawContent,
                        diffLines: preview.diffLines,
                        args: canonicalClone(finalArgs),
                    });

                    const nextSuspendedInFlight: CanonicalMessage[] = [
                        ...retryInFlight,
                        {
                            role: 'assistant',
                            content: turnOutput.content,
                            ...(turnOutput.reasoningContent
                                ? { reasoningContent: turnOutput.reasoningContent }
                                : {}),
                            toolCalls: [canonicalClone(revisedCall)],
                        },
                    ];

                    this.suspendedApprovals.set(approvalId, {
                        approvalId,
                        sessionId: existing.sessionId,
                        messageId: existing.messageId,
                        toolCall: canonicalClone(revisedCall),
                        policy,
                        target,
                        inFlightMessages: nextSuspendedInFlight,
                    });

                    this.notify();
                    return retried;
                }
            }

            // Fallback when model returned plain text (or solo finish_turn) without calling a business tool:
            // still increment revision and record feedback cleanly.
            const soloFinishCall = turnOutput.toolCalls.find(
                (tc) => tc.name === FINISH_TURN_TOOL_NAME,
            );
            const finishResponseText = soloFinishCall
                ? String(safeParseJsonObject(soloFinishCall.arguments).response ?? '').trim()
                : '';
            const fallbackRawText = finishResponseText || turnOutput.content.trim();
            const fallbackSummary = fallbackRawText
                ? truncateSummary(fallbackRawText, 200)
                : existing.summary;
            const retried = this.approvalGate.retry(approvalId, {
                rejectionFeedback: feedbackText || undefined,
                summary: fallbackSummary,
            });
            this.notify();
            return retried;
        } finally {
            if (this.activeControllers.get(existing.sessionId) === controller) {
                this.activeControllers.delete(existing.sessionId);
            }
        }
    }

    /**
     * Execute the exact reverse operation for `undoId` via `UndoStore` + bridges.
     * Also marks any linked `PendingApproval` as `reverted: true`.
     */
    public async undo(undoId: string): Promise<UndoRevertResult> {
        const result = await this.undoStore.revert(undoId, this.undoExecutor);
        if (result.ok) {
            for (const approval of this.approvalGate.list()) {
                if (approval.undoId === undoId && approval.status === 'approved') {
                    this.approvalGate.markReverted(approval.id, undoId);
                }
            }
            this.notify();
        }
        return result;
    }

    /**
     * `AssistantRuntimeBridge.applyUndo` adapter delegating to `undo(undoId)`.
     */
    public async applyUndo(undoId: string): Promise<UndoRecord | null> {
        const result = await this.undo(undoId);
        return result.ok ? (result.record ?? null) : null;
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    private resolveRoundMaxRetries(connection: ApiConnection): number {
        if (this.autoRetryConfig === false) {
            return 0;
        }
        if (this.explicitMaxRetries !== undefined) {
            return this.explicitMaxRetries;
        }
        if (
            typeof connection.roundMaxRetries === 'number'
            && Number.isFinite(connection.roundMaxRetries)
        ) {
            return Math.max(0, Math.min(10, Math.floor(connection.roundMaxRetries)));
        }
        return this.autoRetryConfig.maxRetries;
    }

    private async readPromptRenderVars(target?: MessageTarget): Promise<Record<string, unknown>> {
        const resolvedTarget = target ?? this.resolveActiveTarget();
        try {
            const vars = await this.vfs.readVariables({ target: resolvedTarget, staged: false });
            if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
                return vars;
            }
        } catch {
            // Fall back to metadata variables when VFS variable read is unavailable.
        }
        const metaVars = this.bridge.getMetadata()?.variables;
        if (metaVars && typeof metaVars === 'object' && !Array.isArray(metaVars)) {
            return canonicalClone(metaVars as Record<string, unknown>);
        }
        return {};
    }

    private computePresetPrefixFingerprint(session: AssistantSession): string {
        const preset = resolveActivePreset(this.settingsProvider());
        const selected = selectPresetBlocksForContext(
            preset,
            {
                kind: 'assistant',
                mode: session.mode,
                stAdminEnabled: session.stAdminEnabled,
            },
            { requireExplicit: true },
        );
        return canonicalStringify({
            presetId: preset.id,
            agentId: preset.mainAgentId,
            blocks: selected.prefix.map((block) => ({
                id: block.id,
                role: block.role,
                placement: block.placement,
                content: block.content,
            })),
        });
    }

    private isMatchingFrozenPrefix(
        frozen: ReturnType<TrajectoryStore['getFrozenPrefix']>,
        systemPrompt: string,
        canonicalTools: readonly CanonicalToolSchema[],
        prefixFingerprint: string,
    ): boolean {
        return Boolean(
            frozen
            && frozen.messages[0]?.role === 'system'
            && frozen.messages[0]?.content === systemPrompt
            && frozen.prefixFingerprint === prefixFingerprint
            && canonicalStringify(frozen.tools) === canonicalStringify(canonicalTools),
        );
    }

    private async resolvePresetPromptMessages(
        session: AssistantSession,
        target?: MessageTarget,
        options?: {
            skipPrefix?: boolean;
            excludeMessageId?: string;
            currentUserInput?: string;
            generationType?: SurfaceGenerationType;
            connection?: ApiConnection;
            budget?: EffectiveContextBudget;
        },
    ): Promise<{
        prefixMessages: CanonicalMessage[];
        tailMessages: CanonicalMessage[];
    }> {
        const preset = resolveActivePreset(this.settingsProvider());
        const selected = selectPresetBlocksForContext(
            preset,
            {
                kind: 'assistant',
                mode: session.mode,
                stAdminEnabled: session.stAdminEnabled,
            },
            { requireExplicit: true },
        );

        const needPrefix = !options?.skipPrefix && selected.prefix.length > 0;
        const needTail = selected.tail.length > 0;
        if (!needPrefix && !needTail) {
            return { prefixMessages: [], tailMessages: [] };
        }

        const vars = await this.readPromptRenderVars(target);
        const macroOverrides = buildAssistantMacroOverrides({
            session,
            bridge: this.bridge,
            excludeMessageId: options?.excludeMessageId,
            currentUserInput: options?.currentUserInput,
            generationType: options?.generationType,
            connection: options?.connection,
            budget: options?.budget,
            vars,
        });
        const prefixMessages = needPrefix
            ? await renderPromptBlocks(selected.prefix, {
                  hostBridge: this.bridge,
                  macroOverrides,
                  vars,
              })
            : [];
        const tailMessages = needTail
            ? await renderPromptBlocks(selected.tail, {
                  hostBridge: this.bridge,
                  macroOverrides,
                  vars,
              })
            : [];

        return { prefixMessages, tailMessages };
    }

    private resolvePresetPromptMessagesSync(
        session: AssistantSession,
        options?: {
            connection?: ApiConnection;
            budget?: EffectiveContextBudget;
        },
    ): {
        prefixMessages: CanonicalMessage[];
        tailMessages: CanonicalMessage[];
    } {
        const preset = resolveActivePreset(this.settingsProvider());
        const selected = selectPresetBlocksForContext(
            preset,
            {
                kind: 'assistant',
                mode: session.mode,
                stAdminEnabled: session.stAdminEnabled,
            },
            { requireExplicit: true },
        );

        const macroOverrides = buildAssistantMacroOverrides({
            session,
            bridge: this.bridge,
            connection: options?.connection,
            budget: options?.budget,
        });

        const toMessages = (
            blocks: readonly (typeof selected.prefix)[number][],
        ): CanonicalMessage[] => {
            const messages: CanonicalMessage[] = [];
            for (const block of blocks) {
                const rendered = renderPromptBlockSync(block, {
                    hostBridge: this.bridge,
                    macroOverrides,
                    precedingMessages: messages,
                });
                messages.push(...rendered);
            }
            return messages;
        };

        return {
            prefixMessages: toMessages(selected.prefix),
            tailMessages: toMessages(selected.tail),
        };
    }

    private cleanupApprovalsForMessages(
        sessionId: string,
        removedMessages: readonly AssistantMessage[],
    ): void {
        if (removedMessages.length === 0) {
            return;
        }
        const removedMsgIds = new Set<string>();
        const targetApprovalIds = new Set<string>();
        for (const msg of removedMessages) {
            removedMsgIds.add(msg.id);
            if (Array.isArray(msg.approvalIds)) {
                for (const apprId of msg.approvalIds) {
                    targetApprovalIds.add(apprId);
                }
            }
        }
        for (const appr of this.approvalGate.list({ sessionId })) {
            if (removedMsgIds.has(appr.messageId)) {
                targetApprovalIds.add(appr.id);
            }
        }
        for (const apprId of targetApprovalIds) {
            this.approvalGate.remove(apprId);
            this.suspendedApprovals.delete(apprId);
        }
    }

    private resolveActiveTarget(): MessageTarget {
        if (this.activeTargetProvider) {
            return this.activeTargetProvider();
        }
        const chat = this.bridge.getChat();
        if (chat.length === 0) {
            return { messageId: 0, swipeId: 0 };
        }
        const lastIdx = chat.length - 1;
        return {
            messageId: lastIdx,
            swipeId: chat[lastIdx]?.swipeId ?? 0,
        };
    }

    private resolveEffectiveConnection(connectionId: string): ApiConnection {
        const settings = this.settingsProvider();
        const trimmed = connectionId?.trim() || 'inherit';
        if (trimmed !== 'inherit' && this.customConnectionResolver) {
            const custom = this.customConnectionResolver(trimmed);
            if (custom) {
                return custom;
            }
        }
        if (trimmed === 'inherit') {
            return resolveConnection(settings);
        }
        return resolveConnection(settings, trimmed);
    }

    private resolveSessionContextBudget(
        session: AssistantSession,
        providerLimitOverride?: number,
    ): EffectiveContextBudget {
        const connection = this.resolveEffectiveConnection(session.connectionId);
        return resolveEffectiveContextBudget(connection, {
            ...(this.sessionStore.hasCustomWatermark()
                ? { configuredWatermark: this.sessionStore.getDefaultWatermark() }
                : {}),
            ...(providerLimitOverride !== undefined ? { providerLimitOverride } : {}),
        });
    }

    private resolveSessionLayer0AndTools(session: AssistantSession): {
        layer0: CanonicalMessage[];
        tools: CanonicalToolSchema[];
    } {
        const threadId = toAssistantThreadId(session.id);
        const connection = this.resolveEffectiveConnection(session.connectionId);
        const capabilities = this.getExtensionCapabilities();
        const systemPrompt = buildAssistantSystemPrompt(
            session.mode,
            session.stAdminEnabled,
            capabilities,
            this.docsRegistry.listExternalIndexEntries(),
        );
        const allowedToolDefs = this.getAllowedToolDefinitions(
            session.mode,
            session.stAdminEnabled,
        );
        const baseTools = toCanonicalAssistantToolSchemas(allowedToolDefs);
        const tools = connection.strictToolLoop ? appendFinishTurnTool(baseTools) : baseTools;
        const prefixFingerprint = this.computePresetPrefixFingerprint(session);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        if (this.isMatchingFrozenPrefix(frozen, systemPrompt, tools, prefixFingerprint)) {
            return {
                layer0: canonicalClone([...frozen!.messages]),
                tools: canonicalClone([...frozen!.tools]),
            };
        }
        const presetPrompts = this.resolvePresetPromptMessagesSync(session, {
            connection,
            budget: this.resolveSessionContextBudget(session),
        });
        const layer0: CanonicalMessage[] = [
            { role: 'system', content: systemPrompt },
            ...presetPrompts.prefixMessages,
        ];
        return { layer0, tools };
    }

    private createArchiveWriter(target?: MessageTarget): AssistantArchiveWriter {
        return async (path: string, content: string) => {
            await this.vfs.writeFile(path, content, {
                target: target ?? this.resolveActiveTarget(),
                staged: false,
                source: 'assistant:archive',
            });
        };
    }

    private async runCompactionSummaryLLM(
        connection: ApiConnection,
        input: {
            transcript: string;
            previousSummary?: string;
            focusInstruction?: string;
            signal?: AbortSignal;
        },
    ): Promise<string> {
        throwIfAssistantAborted(input.signal);

        const timeoutController = new AbortController();
        const unlinkExternal = this.linkExternalSignal(timeoutController, input.signal);
        const timer = setTimeout(() => {
            timeoutController.abort(new Error('Compaction LLM summary timed out'));
        }, this.compactionSummaryTimeoutMs);

        try {
            const summaryConnection: ApiConnection = {
                ...canonicalClone(connection),
                temperature: 0.2,
                stream: false,
            };
            const request: LLMRequest = {
                connectionId: connection.id,
                connection: summaryConnection,
                messages: buildCompactionSummaryMessages(input),
                tools: [],
                stream: false,
                signal: timeoutController.signal,
            };
            const resp = await this.transport.complete(request);
            return (resp.content ?? '').trim();
        } finally {
            clearTimeout(timer);
            unlinkExternal();
        }
    }

    private createToolContext(params: {
        session: AssistantSession;
        toolCallId: string;
        target: MessageTarget;
        signal: AbortSignal;
    }): AssistantToolContext {
        return {
            sessionId: params.session.id,
            toolCallId: params.toolCallId,
            mode: params.session.mode,
            stAdminEnabled: params.session.stAdminEnabled,
            bridge: this.bridge,
            store: this.store,
            vfs: this.vfs,
            undoStore: this.undoStore,
            trajectoryStore: this.trajectoryStore,
            traceLogger: this.traceLogger,
            settings: this.settingsProvider(),
            getLatestSettings: this.settingsProvider,
            ...(this.settingsUpdater ? { updateSettings: this.settingsUpdater } : {}),
            target: params.target,
            signal: params.signal,
            getVariableSchema: this.variableSchemaProvider,
            captureUndo: true,
            getStatusSnapshot: this.statusSnapshotProvider,
            spillStore: this.spillStore,
            ...(this.maxToolResultBytes !== undefined
                ? { maxToolResultBytes: this.maxToolResultBytes }
                : {}),
        };
    }

    private async buildApprovalPreview(
        tool: AssistantToolDefinition,
        args: Record<string, unknown>,
        policy: ToolPolicyResult,
        ctx: AssistantToolContext,
    ) {
        if (tool.preview) {
            return await tool.preview(args, ctx);
        }
        const rawContent = JSON.stringify(redactWithReport(args).value, null, 2);
        return {
            title: `${tool.name} (${policy.scopeLabel})`,
            summary: `Execute ${tool.name} on ${policy.scopeLabel}.`,
            targetLabel: policy.scopeLabel,
            beforeText: '',
            afterText: rawContent,
            rawContent,
            diffLines: rawContent
                ? rawContent.split('\n').map((line) => ({ type: 'add' as const, text: line }))
                : [],
        };
    }

    private async invokeLLM(
        request: LLMRequest,
        useStream: boolean,
        callbacks: {
            onTextDelta?: (delta: string) => void;
            onReasoningDelta?: (delta: string) => void;
            onToolCallDelta?: (
                index: number,
                delta: { name?: string; argumentsDelta?: string },
            ) => void;
        },
    ): Promise<TurnLLMOutput> {
        throwIfAssistantAborted(request.signal);

        if (!useStream) {
            const resp = await this.transport.complete(request);
            throwIfAssistantAborted(request.signal);
            return {
                content: resp.content ?? '',
                reasoningContent: resp.reasoningContent ?? '',
                toolCalls: resp.toolCalls ? canonicalClone(resp.toolCalls) : [],
                usage: normalizeUsage(resp.usage),
                finishReason: resp.finishReason,
            };
        }

        let content = '';
        let reasoningContent = '';
        const toolMap = new Map<number, CanonicalToolCall>();
        let usage = normalizeUsage();
        let finishReason: string | undefined;

        for await (const chunk of this.transport.stream(request)) {
            throwIfAssistantAborted(request.signal);
            if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
                callbacks.onTextDelta?.(chunk.textDelta);
            } else if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoningContent += chunk.reasoningDelta;
                callbacks.onReasoningDelta?.(chunk.reasoningDelta);
            } else if (chunk.type === 'tool_call_delta') {
                const idx = chunk.toolCallIndex ?? 0;
                const prev = toolMap.get(idx) ?? {
                    id: `call_${this.now()}_${idx}`,
                    name: '',
                    arguments: '',
                };
                if (chunk.toolCallId) {
                    prev.id = chunk.toolCallId;
                }
                if (chunk.toolName) {
                    if (!prev.name) {
                        prev.name = chunk.toolName;
                    } else if (
                        chunk.toolName === prev.name
                        || chunk.toolName.startsWith(prev.name)
                    ) {
                        prev.name = chunk.toolName;
                    } else {
                        prev.name += chunk.toolName;
                    }
                }
                if (chunk.argumentsDelta) {
                    prev.arguments += chunk.argumentsDelta;
                }
                if (chunk.thoughtSignature) {
                    prev.thoughtSignature = chunk.thoughtSignature;
                }
                toolMap.set(idx, prev);
                callbacks.onToolCallDelta?.(idx, {
                    ...(chunk.toolName ? { name: chunk.toolName } : {}),
                    ...(chunk.argumentsDelta ? { argumentsDelta: chunk.argumentsDelta } : {}),
                });
            } else if (chunk.type === 'usage' && chunk.usage) {
                usage = normalizeUsage(chunk.usage);
            } else if (chunk.type === 'done' && chunk.finishReason) {
                finishReason = chunk.finishReason;
            }
        }

        const toolCalls = Array.from(toolMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => tc)
            .filter((tc) => tc.name.trim().length > 0);

        return {
            content,
            reasoningContent,
            toolCalls,
            usage,
            finishReason,
        };
    }

    private linkExternalSignal(
        controller: AbortController,
        external?: AbortSignal,
    ): () => void {
        if (!external) {
            return () => {};
        }
        if (external.aborted) {
            controller.abort(external.reason ?? createAssistantAbortError());
            return () => {};
        }
        const onAbort = () => {
            controller.abort(external.reason ?? createAssistantAbortError());
        };
        external.addEventListener('abort', onAbort, { once: true });
        return () => {
            external.removeEventListener('abort', onAbort);
        };
    }

    private emitSessionUpdate(
        sessionId: string,
        onUpdate?: (session: AssistantSession) => void,
    ): void {
        if (onUpdate) {
            const latest = this.sessionStore.getSession(sessionId);
            if (latest) {
                try {
                    onUpdate(latest);
                } catch {
                    // Keep stream resilient to callback errors.
                }
            }
        }
        this.notify();
    }

    private notify(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener();
            } catch {
                // Keep subscriber loop fault-tolerant.
            }
        }
    }
}
