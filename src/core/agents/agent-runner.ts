import { z } from 'zod';
import type {
    HostBridge,
    LLMRequest,
    LLMStreamChunk,
    LLMToolChoice,
    LLMTransport,
    ToolExecutionContext,
    ToolSideGenApi,
} from '@/core/bridge';
import {
    createDefaultMainAgent,
    createDefaultSettings,
    matchesPromptTriggers,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import {
    buildLayer2MacroOverrides,
    buildWorkspaceNotices,
    ContextAssembler,
    DEFAULT_FOLD_THRESHOLD_CHARS,
    estimateMessageTokens,
    estimateRequestTokens,
    prerenderPromptBlocks,
    resolveEffectiveContextBudget,
    TrajectoryStore,
    TransientToolSpillStore,
    WatermarkCompactor,
    type InterruptedTurnCheckpoint,
    type RegexSource,
} from '@/core/context';
import {
    computeRoundRetryDelayMs,
    delayWithAbort,
    isLengthFinishReason,
    isRetryableRoundError,
    isValidJsonObjectString,
    LLMTransportError,
    parseContextOverflowError,
    ROUND_RETRY_ERROR_CODES,
    type ContextOverflowInfo,
} from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import {
    DecoratorParser,
    LoreReadEvaluator,
    TailRadar,
    type LoreOverrideSource,
} from '@/core/lore';
import { applyRegexRules, RegexPipeline } from '@/core/regex';
import { ChatDataStore, DATA_NAMESPACES, worldInfoKey } from '@/core/store';
import {
    compileCustomToolConfig,
    compileLoreToolEntry,
    createAbortError,
    createBuiltinToolRegistry,
    createToolExecutionContext,
    isAbortError,
    throwIfAborted,
    ToolRegistry,
    type DynamicVariableSchema,
    type ScriptSandbox,
    type ToolDefinition,
} from '@/core/tools';
import type {
    AgentProfile,
    AgentRunTrace,
    ApiConnection,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    ChatMessageSnapshot,
    ClassifiedLoreEntry,
    InterruptedReason,
    MessageTarget,
    PipelinePhase,
    Preset,
    PromptBlock,
    PromptTriggerContext,
    RadarScanResult,
    RawLoreEntry,
    RegexRule,
    ScopedPermissions,
    Settings,
    TokenUsage,
    ToolStepLog,
} from '@/core/types';
import { canonicalClone, canonicalStringify, normalizeVfsPath } from '@/core/utils';
import { OUTPUT_FILE_PATH, VirtualFileSystem } from '@/core/vfs';
import {
    FinishTurnStreamExtractor,
    IncrementalOutputStreamExtractor,
    type ToolCallDeltaInput,
} from './output-stream-extractor';

export const FINISH_TURN_TOOL_NAME = 'finish_turn';
const FINISH_TURN_DESCRIPTION = 'Complete the current turn and submit the final result.';

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'read_variables',
    'search_history',
    'read_history',
]);

export const DEFAULT_SUBAGENT_TOOLS: readonly string[] = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'read_variables',
    'search_history',
    'read_history',
];

export const REQUIRED_OUTPUT_MODE_TOOLS: readonly string[] = [
    'read_file',
    'write_file',
    'append_file',
    'edit_file',
];

const EMPTY_OUTPUT_CHECK_PROMPT =
    '[System Check] /output.md is still empty. Plain assistant text is NOT displayed to the user. Write the final response to /output.md via write_file and review it before finishing.';

const EMPTY_OUTPUT_FINISH_ERROR =
    '/output.md is still empty. Call write_file("/output.md", ...) first.';

const PREFLIGHT_FOLDED_TOOL_PREFIX = '[已折叠本轮早期工具输出:';
const OVERFLOW_CROPPED_TOOL_PREFIX = '[输出因触发模型上下文上限';

const LIKELY_REFUSAL_RE =
    /^(?:(?:i(?:'m|\s+am)\s+sorry|sorry|apologies)[,.\s!]*)?(?:i\s+(?:can(?:'t|not)|am\s+unable\s+to|won't|will\s+not|must\s+decline)|as\s+an\s+ai|抱歉|对不起|很抱歉|作为(?:一个)?(?:ai|人工智能)|我(?:无法|不能|不便)(?:满足|协助|完成|生成|继续|回答|提供|执行))/i;

type FinishTurnMode = 'main_output' | 'side_effect' | 'return_value';

/**
 * Resolve effective strict tool loop enablement from agent override and connection default.
 */
export function resolveStrictToolLoop(
    agent: Pick<AgentProfile, 'strictToolLoop'>,
    connection: Pick<ApiConnection, 'strictToolLoop'>,
): boolean {
    if (agent.strictToolLoop === 'on') {
        return true;
    }
    if (agent.strictToolLoop === 'off') {
        return false;
    }
    return Boolean(connection.strictToolLoop);
}

export interface SubAgentDescriptor {
    name: string;
    toolName: string;
    description: string;
    instructions: string;
    paramNames: string[];
    presetName?: string;
    sourceEntry?: RawLoreEntry;
}

export class AgentExecutionError extends Error {
    public readonly trace: AgentRunTrace;

    constructor(message: string, trace: AgentRunTrace, causeError?: unknown) {
        super(message, causeError !== undefined ? { cause: causeError } : undefined);
        this.name = 'AgentExecutionError';
        this.trace = trace;
    }
}

export class MaxToolRoundsError extends AgentExecutionError {
    public readonly maxToolRounds: number;

    constructor(maxToolRounds: number, trace: AgentRunTrace) {
        super(`Agent "${trace.agentName}" exceeded maxToolRounds (${maxToolRounds}).`, trace);
        this.name = 'MaxToolRoundsError';
        this.maxToolRounds = maxToolRounds;
    }
}

export class TurnInterruptedError extends Error {
    public readonly reason: InterruptedReason;
    public readonly salvagedOutput: string;
    public readonly checkpoint: InterruptedTurnCheckpoint;
    public readonly trace: AgentRunTrace;
    public readonly causeError?: string;

    constructor(params: {
        reason: InterruptedReason;
        salvagedOutput: string;
        checkpoint: InterruptedTurnCheckpoint;
        trace: AgentRunTrace;
        errorMessage?: string;
    }) {
        super(params.errorMessage ?? `Agent turn interrupted (${params.reason}).`);
        this.name = 'TurnInterruptedError';
        this.reason = params.reason;
        this.salvagedOutput = params.salvagedOutput;
        this.checkpoint = params.checkpoint;
        this.trace = params.trace;
        if (params.errorMessage !== undefined) {
            this.causeError = params.errorMessage;
        }
    }
}

export interface AgentRunnerDependencies {
    bridge: HostBridge;
    transport: LLMTransport;
    settings?: Settings | (() => Settings);
    toolRegistry?: ToolRegistry;
    contextAssembler?: ContextAssembler;
    trajectoryStore?: TrajectoryStore;
    watermarkCompactor?: WatermarkCompactor;
    spillStore?: TransientToolSpillStore;
    vfs?: VirtualFileSystem;
    store?: ChatDataStore;
    regexPipeline?: RegexPipeline | (() => RegexSource | undefined);
    loreReadEvaluator?: LoreReadEvaluator;
    tailRadar?: TailRadar;
    traceLogger?: TraceLogger;
    sandbox?: ScriptSandbox;
    sideGen?: ToolSideGenApi;
    maxDelegationDepth?: number;
    roundRetryInitialDelayMs?: number;
    roundRetryMaxDelayMs?: number;
}

export interface AgentRunInput {
    agent: AgentProfile | string;
    target: MessageTarget;
    phase: PipelinePhase;
    userInput?: string | CanonicalContentPart[];
    userName?: string;
    turnBrief?: string;
    dynamicReminders?: readonly string[];
    includeCategory4DynamicEntries?: boolean;
    loreEntries?: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
    loreHint?: string | RadarScanResult;
    runTailRadar?: boolean;
    recentChatMessages?: readonly (CanonicalMessage | ChatMessageSnapshot)[];
    includeRecentChat?: boolean;
    preset?: Preset;
    connection?: ApiConnection;
    regex?: RegexSource;
    extraTools?: readonly ToolDefinition[];
    enabledToolNames?: readonly string[];
    permissions?: ScopedPermissions;
    getVariableSchema?: () => DynamicVariableSchema | undefined;
    subAgents?: readonly SubAgentDescriptor[];
    allowSubAgentDelegation?: boolean;
    includeSubAgentTools?: boolean;
    triggerId?: string;
    triggerLabel?: string;
    staged?: boolean;
    stream?: boolean;
    signal?: AbortSignal;
    vars?: Record<string, unknown>;
    macroOverrides?: Record<string, string>;
    characterFields?: Record<string, string>;
    personaDescription?: string;
    systemBasePrompt?: string;
    generationAction?: 'normal' | 'continue' | 'regenerate' | 'swipe';
    promptTriggerContext?: PromptTriggerContext;
    forceRecompilePrefix?: boolean;
    /** Force mandatory `/output.md` mode (defaults to `phase === 'main_turn' && delegationDepth === 0`). */
    requireOutputFile?: boolean;
    /** Prior in-flight turn messages used when resuming from an `InterruptedTurnCheckpoint`. */
    resumeMessages?: readonly CanonicalMessage[];
    /** Prior `Read-Set` snapshot restored on resume without scanning `TrajectoryStore`. */
    initialReadSet?: ReadonlyMap<string, string> | Record<string, string>;
    /** Internal recursion guard for nested `@@agent` delegation. */
    delegationDepth?: number;
    onTextDelta?: (delta: string) => void;
    onOutputPreview?: (previewText: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolStart?: (step: ToolStepLog) => void;
    onToolComplete?: (step: ToolStepLog) => void;
}

export interface AgentRunResult {
    runId: string;
    target: MessageTarget;
    phase: PipelinePhase;
    agentProfileId: string;
    content: string;
    reasoningContent?: string;
    toolSteps: ToolStepLog[];
    usage: TokenUsage;
    trace: AgentRunTrace;
    rounds: number;
    requestSnapshot?: AgentRunTrace['requestSnapshot'];
}

function sanitizeSubAgentToolSuffix(name: string): string {
    const cleaned = name
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_]+/gu, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || 'subagent';
}

/**
 * Extract `@@agent <name> [param1] [param2]...` descriptors from World Info entries.
 */
export function extractSubAgentDescriptors(
    entries: readonly (RawLoreEntry | ClassifiedLoreEntry)[],
): SubAgentDescriptor[] {
    const descriptors: SubAgentDescriptor[] = [];
    const seenToolNames = new Set<string>();

    for (const item of entries) {
        const rawEntry = 'entry' in item ? item.entry : item;
        if (rawEntry.disable) {
            continue;
        }

        const parsed = DecoratorParser.parseEntry(rawEntry);
        const agentDec = parsed.decorators.find((d) => d.name === '@@agent');
        if (!agentDec) {
            continue;
        }

        const name = (agentDec.args[0] || rawEntry.comment || `agent_${rawEntry.uid}`).trim();
        if (!name) {
            continue;
        }

        const suffix = sanitizeSubAgentToolSuffix(name);
        const toolName = `delegate_agent_${suffix}`;
        if (seenToolNames.has(toolName)) {
            continue;
        }
        seenToolNames.add(toolName);

        const paramNames = agentDec.args
            .slice(1)
            .map((p) => p.trim())
            .filter(Boolean);
        const presetDec = parsed.decorators.find((d) => d.name === '@@preset');
        const presetName = presetDec?.args[0]?.trim() || undefined;
        const description =
            rawEntry.comment?.trim() || `Delegate a focused sub-task to sub-agent "${name}"`;
        const instructions = parsed.cleanContent.trim();

        descriptors.push({
            name,
            toolName,
            description,
            instructions,
            paramNames,
            ...(presetName ? { presetName } : {}),
            sourceEntry: rawEntry,
        });
    }

    return descriptors;
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

function addUsage(acc: TokenUsage, round: TokenUsage): TokenUsage {
    const inputTokens = acc.inputTokens + round.inputTokens;
    const cachedTokens = acc.cachedTokens + round.cachedTokens;
    const outputTokens = acc.outputTokens + round.outputTokens;
    const totalTokens = (acc.totalTokens ?? 0) + (round.totalTokens ?? round.inputTokens + round.outputTokens);
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens,
        cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    };
}

function parseArgsForLog(rawArgs: string): Record<string, unknown> | string {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Preserve raw string if malformed so diagnostics show what the model produced.
    }
    return rawArgs;
}

function formatSubAgentTaskInput(
    desc: SubAgentDescriptor,
    args: Record<string, unknown>,
): string {
    if (desc.paramNames.length === 0) {
        const task = typeof args.task === 'string' ? args.task : JSON.stringify(args);
        return desc.instructions ? `${desc.instructions}\n\nTask:\n${task}` : task;
    }

    const lines: string[] = [];
    if (desc.instructions) {
        lines.push(desc.instructions, '');
    }
    lines.push('Parameters:');
    for (const paramName of desc.paramNames) {
        lines.push(`- ${paramName}: ${String(args[paramName] ?? '')}`);
    }
    return lines.join('\n');
}

function unwrapRawLoreEntries(
    entries: readonly (RawLoreEntry | ClassifiedLoreEntry)[],
): RawLoreEntry[] {
    return entries.map((item) => ('entry' in item ? item.entry : item));
}

function assertValidTarget(target: MessageTarget): MessageTarget {
    if (
        !target
        || !Number.isInteger(target.messageId)
        || target.messageId < 0
        || !Number.isInteger(target.swipeId)
        || target.swipeId < 0
    ) {
        throw new Error(
            `Invalid MessageTarget { messageId: ${String(target?.messageId)}, swipeId: ${String(target?.swipeId)} }`,
        );
    }
    return Object.freeze({ messageId: target.messageId, swipeId: target.swipeId });
}

function resolveFinishTurnMode(
    isMainOutputMode: boolean,
    promptTriggerContext: PromptTriggerContext,
): FinishTurnMode {
    if (isMainOutputMode) {
        return 'main_output';
    }
    if (
        promptTriggerContext.kind === 'trigger'
        && (promptTriggerContext.targetPaths?.length ?? 0) > 0
    ) {
        return 'side_effect';
    }
    return 'return_value';
}

function createFinishTurnDefinition(mode: FinishTurnMode): {
    definition: ToolDefinition;
    propertyOrdering: string[];
} {
    if (mode === 'main_output') {
        return {
            definition: {
                name: FINISH_TURN_TOOL_NAME,
                description: FINISH_TURN_DESCRIPTION,
                parameters: z.object({
                    step_brief: z
                        .string()
                        .min(1)
                        .describe('Concise summary of the completed work in /output.md.'),
                }),
                source: 'builtin',
                execute: () => ({ ok: true }),
            },
            propertyOrdering: ['step_brief'],
        };
    }

    if (mode === 'side_effect') {
        return {
            definition: {
                name: FINISH_TURN_TOOL_NAME,
                description: FINISH_TURN_DESCRIPTION,
                parameters: z.object({
                    step_brief: z
                        .string()
                        .min(1)
                        .describe('Concise summary of the completed side-effect updates.'),
                    status: z
                        .string()
                        .optional()
                        .describe('Optional short completion status note.'),
                }),
                source: 'builtin',
                execute: () => ({ ok: true }),
            },
            propertyOrdering: ['step_brief', 'status'],
        };
    }

    return {
        definition: {
            name: FINISH_TURN_TOOL_NAME,
            description: FINISH_TURN_DESCRIPTION,
            parameters: z.object({
                step_brief: z
                    .string()
                    .min(1)
                    .describe('Concise internal plan or completion brief.'),
                response: z
                    .string()
                    .min(1)
                    .describe('Final response text to return to the caller.'),
            }),
            source: 'builtin',
            execute: () => ({ ok: true }),
        },
        propertyOrdering: ['step_brief', 'response'],
    };
}

function parseFinishTurnArgs(
    rawArgs: string,
    schema: z.ZodTypeAny,
): { ok: true; data: Record<string, unknown> } | { ok: false } {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return { ok: false };
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return { ok: false };
        }
        const validated = schema.safeParse(parsed);
        if (!validated.success) {
            return { ok: false };
        }
        return { ok: true, data: validated.data as Record<string, unknown> };
    } catch {
        return { ok: false };
    }
}

function buildToolCallSignature(toolName: string, rawArgs: string): string {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return `${toolName}:{}`;
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        return `${toolName}:${canonicalStringify(parsed)}`;
    } catch {
        return `${toolName}:${trimmed}`;
    }
}

function decorateStrictToolResult(
    rawOutput: string,
    turnState: { round: string; output_ready: boolean },
    warning?: string,
): string {
    const trimmed = rawOutput.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return JSON.stringify({
                    ...(parsed as Record<string, unknown>),
                    ...(warning ? { _warning: warning } : {}),
                    _turn_state: turnState,
                });
            }
        } catch {
            // Fall through to text suffix.
        }
    }

    const parts: string[] = [rawOutput];
    if (warning) {
        parts.push(`[Warning] ${warning}`);
    }
    parts.push(`_turn_state: ${JSON.stringify(turnState)}`);
    return parts.join('\n\n');
}

function isPrefillAssistantMessage(msg: CanonicalMessage | undefined): boolean {
    if (!msg || msg.role !== 'assistant') {
        return false;
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
        return false;
    }
    return msg.extraFields?.partial === true || msg.extraFields?.prefix === true;
}

function extractMessageText(content: CanonicalMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
}

function isLikelyRefusalText(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
        return false;
    }
    return LIKELY_REFUSAL_RE.test(trimmed);
}

function formatRoundRetryReason(error: unknown): string {
    if (error instanceof LLMTransportError && error.code) {
        return error.code;
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message.trim();
    }
    return String(error);
}

function isOutputMutationToolCall(
    toolCallName: string,
    parsedArgs: Record<string, unknown> | string,
): boolean {
    if (toolCallName === 'append_reply_view' || toolCallName === 'replace_reply_view') {
        return true;
    }
    if (
        (toolCallName === 'write_file' || toolCallName === 'append_file' || toolCallName === 'edit_file')
        && typeof parsedArgs === 'object'
        && parsedArgs !== null
        && typeof parsedArgs.path === 'string'
    ) {
        try {
            return normalizeVfsPath(parsedArgs.path) === OUTPUT_FILE_PATH;
        } catch {
            return false;
        }
    }
    return false;
}

function resolveInitialReadSet(
    initialReadSet: ReadonlyMap<string, string> | Record<string, string> | undefined,
    sessionMode: AgentProfile['sessionMode'],
    trajectoryStore: TrajectoryStore,
    agentId: string,
): Map<string, string> {
    if (initialReadSet) {
        if (
            initialReadSet instanceof Map
            || typeof (initialReadSet as { entries?: unknown }).entries === 'function'
        ) {
            return new Map((initialReadSet as ReadonlyMap<string, string>).entries());
        }
        const map = new Map<string, string>();
        for (const [path, hash] of Object.entries(initialReadSet as Record<string, string>)) {
            if (typeof hash === 'string') {
                map.set(path, hash);
            }
        }
        return map;
    }
    return sessionMode === 'persistent'
        ? trajectoryStore.getReadSet(agentId)
        : new Map<string, string>();
}

function buildOutputModePermissions(base: ScopedPermissions): ScopedPermissions {
    return {
        read: base.read.includes(OUTPUT_FILE_PATH)
            ? [...base.read]
            : [...base.read, OUTPUT_FILE_PATH],
        write: base.write.includes(OUTPUT_FILE_PATH)
            ? [...base.write]
            : [...base.write, OUTPUT_FILE_PATH],
    };
}

function measureToolContentChars(content: string | CanonicalContentPart[]): number {
    if (typeof content === 'string') {
        return content.length;
    }
    let total = 0;
    for (const part of content) {
        if (part.type === 'text') {
            total += part.text.length;
        } else if (part.type === 'image_url') {
            total += Math.max(256, part.imageUrl.length);
        } else if (part.type === 'video_url') {
            total += Math.max(512, part.videoUrl.length);
        } else {
            total += Math.max(512, part.data.length);
        }
    }
    return total;
}

function isAlreadyCompactedToolContent(
    content: string | CanonicalContentPart[],
    prefixes: readonly string[],
): boolean {
    if (typeof content !== 'string') {
        return false;
    }
    return prefixes.some((prefix) => content.startsWith(prefix));
}

function findLatestToolRoundStartIndex(messages: readonly CanonicalMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
            return i;
        }
    }
    return -1;
}

function syncToolContentToCompleted(
    completedMessages: CanonicalMessage[],
    toolMsg: CanonicalMessage,
    replacement: string,
): void {
    if (!toolMsg.toolCallId) {
        return;
    }
    for (let i = completedMessages.length - 1; i >= 0; i -= 1) {
        const candidate = completedMessages[i];
        if (candidate.role === 'tool' && candidate.toolCallId === toolMsg.toolCallId) {
            candidate.content = replacement;
            return;
        }
    }
}

/**
 * Fold oversized `role === 'tool'` messages in `inFlightMessages` in-place to meet the
 * pre-flight token threshold. Prioritizes earlier tool rounds first and NEVER deletes
 * tool nodes or mutates `toolCallId` pairing.
 */
function foldInFlightToolMessagesForPreflight(params: {
    turnMessages: CanonicalMessage[];
    completedTurnMessages: CanonicalMessage[];
    currentTokens: number;
    targetTokens: number;
    thresholdChars?: number;
}): { foldedCount: number; freedTokens: number } {
    const thresholdChars = params.thresholdChars ?? DEFAULT_FOLD_THRESHOLD_CHARS;
    const latestToolRoundIdx = findLatestToolRoundStartIndex(params.turnMessages);

    interface Candidate {
        index: number;
        chars: number;
        tokens: number;
        isEarlierRound: boolean;
    }

    const earlier: Candidate[] = [];
    const latest: Candidate[] = [];

    for (let i = 0; i < params.turnMessages.length; i += 1) {
        const msg = params.turnMessages[i];
        if (msg.role !== 'tool') {
            continue;
        }
        if (isAlreadyCompactedToolContent(msg.content, [PREFLIGHT_FOLDED_TOOL_PREFIX, OVERFLOW_CROPPED_TOOL_PREFIX])) {
            continue;
        }
        const chars = measureToolContentChars(msg.content);
        if (chars <= thresholdChars) {
            continue;
        }
        const candidate: Candidate = {
            index: i,
            chars,
            tokens: estimateMessageTokens(msg),
            isEarlierRound: latestToolRoundIdx >= 0 && i < latestToolRoundIdx,
        };
        if (candidate.isEarlierRound) {
            earlier.push(candidate);
        } else {
            latest.push(candidate);
        }
    }

    earlier.sort((a, b) => b.tokens - a.tokens || a.index - b.index);
    latest.sort((a, b) => b.tokens - a.tokens || a.index - b.index);

    let remainingTokens = params.currentTokens;
    let foldedCount = 0;
    let freedTokens = 0;

    for (const candidate of [...earlier, ...latest]) {
        if (remainingTokens < params.targetTokens) {
            break;
        }
        const msg = params.turnMessages[candidate.index];
        const toolLabel = msg.toolName ?? 'tool';
        const replacement =
            `${PREFLIGHT_FOLDED_TOOL_PREFIX} ${toolLabel} (原输出约 ${candidate.tokens} tokens / ${candidate.chars} chars)；为满足上下文预算已自动折叠，如需细节请使用精确范围重新查询]`;
        msg.content = replacement;
        syncToolContentToCompleted(params.completedTurnMessages, msg, replacement);

        const newTokens = estimateMessageTokens(msg);
        const delta = Math.max(0, candidate.tokens - newTokens);
        remainingTokens -= delta;
        freedTokens += delta;
        foldedCount += 1;
    }

    return { foldedCount, freedTokens };
}

/**
 * Crop oversized `role === 'tool'` messages in `inFlightMessages` in-place during
 * emergency `ContextOverflowError` recovery. Replaces `content` only and strictly
 * preserves `toolCallId` / `assistant.toolCalls` pairing.
 */
function cropInFlightToolMessagesForOverflow(params: {
    turnMessages: CanonicalMessage[];
    completedTurnMessages: CanonicalMessage[];
    limitTokens: number;
    thresholdChars?: number;
}): { croppedCount: number; freedTokens: number } {
    const thresholdChars = params.thresholdChars ?? DEFAULT_FOLD_THRESHOLD_CHARS;
    let croppedCount = 0;
    let freedTokens = 0;

    for (const msg of params.turnMessages) {
        if (msg.role !== 'tool') {
            continue;
        }
        if (isAlreadyCompactedToolContent(msg.content, [OVERFLOW_CROPPED_TOOL_PREFIX])) {
            continue;
        }
        const chars = measureToolContentChars(msg.content);
        if (chars <= thresholdChars) {
            continue;
        }
        const origTokens = estimateMessageTokens(msg);
        const toolLabel = msg.toolName ?? 'tool';
        const replacement =
            `${OVERFLOW_CROPPED_TOOL_PREFIX} (${params.limitTokens} tokens) 已被自动裁剪: ${toolLabel}；原输出约 ${origTokens} tokens (${chars} chars)。请改用指定路径、行号范围 (start_line/end_line) 或更精确的过滤条件分段查询]`;
        msg.content = replacement;
        syncToolContentToCompleted(params.completedTurnMessages, msg, replacement);

        const newTokens = estimateMessageTokens(msg);
        freedTokens += Math.max(0, origTokens - newTokens);
        croppedCount += 1;
    }

    return { croppedCount, freedTokens };
}

/**
 * Multi-round Agent runtime executing `LLMTransport` <-> `ToolRegistry` loops
 * over `ContextAssembler` + `TrajectoryStore`, emitting live events and recording
 * complete `AgentRunTrace` telemetry in `TraceLogger`.
 */
export class AgentRunner {
    public readonly bridge: HostBridge;
    public readonly transport: LLMTransport;
    public readonly store: ChatDataStore;
    public readonly vfs: VirtualFileSystem;
    public readonly contextAssembler: ContextAssembler;
    public readonly trajectoryStore: TrajectoryStore;
    public readonly watermarkCompactor: WatermarkCompactor;
    public readonly spillStore: TransientToolSpillStore;
    public readonly traceLogger: TraceLogger;
    public readonly baseToolRegistry: ToolRegistry;
    public readonly loreReadEvaluator: LoreReadEvaluator;
    public readonly tailRadar: TailRadar;

    private readonly settingsProvider: () => Settings;
    private readonly regexProvider?: RegexPipeline | (() => RegexSource | undefined);
    private readonly sandbox?: ScriptSandbox;
    private readonly sideGen?: ToolSideGenApi;
    private readonly maxDelegationDepth: number;
    private readonly roundRetryInitialDelayMs: number;
    private readonly roundRetryMaxDelayMs: number;
    private runSequence = 0;

    constructor(deps: AgentRunnerDependencies) {
        this.bridge = deps.bridge;
        this.transport = deps.transport;
        this.settingsProvider =
            typeof deps.settings === 'function'
                ? deps.settings
                : deps.settings
                    ? () => deps.settings as Settings
                    : () => createDefaultSettings();
        this.regexProvider = deps.regexPipeline;
        this.sandbox = deps.sandbox;
        this.sideGen = deps.sideGen;
        this.maxDelegationDepth = Math.max(0, deps.maxDelegationDepth ?? 1);
        this.roundRetryInitialDelayMs = Math.max(0, deps.roundRetryInitialDelayMs ?? 1200);
        this.roundRetryMaxDelayMs = Math.max(
            this.roundRetryInitialDelayMs,
            deps.roundRetryMaxDelayMs ?? 10_000,
        );

        this.store = deps.store ?? deps.vfs?.store ?? new ChatDataStore(deps.bridge);
        this.traceLogger = deps.traceLogger ?? new TraceLogger();
        this.trajectoryStore = deps.trajectoryStore ?? new TrajectoryStore();
        this.contextAssembler = deps.contextAssembler ?? new ContextAssembler();
        this.baseToolRegistry = deps.toolRegistry ?? createBuiltinToolRegistry();

        const resolveRegexForLore = (): RegexSource | undefined => {
            if (typeof this.regexProvider === 'function') {
                return this.regexProvider();
            }
            if (this.regexProvider) {
                return this.regexProvider;
            }
            return resolveActivePreset(this.settingsProvider()).regexRules;
        };

        const defaultGetOverride = (world: string, uid: number, target?: MessageTarget) =>
            this.store.get(DATA_NAMESPACES.WORLDINFO, worldInfoKey(world, uid), {
                target,
                includeStaged: true,
            })?.content ?? null;

        this.loreReadEvaluator =
            deps.loreReadEvaluator
            ?? new LoreReadEvaluator(this.bridge, {
                getOverride: defaultGetOverride,
                applyLoreReadRegex: (text) => {
                    const rules = resolveRegexForLore();
                    if (!rules) {
                        return text;
                    }
                    if (rules instanceof RegexPipeline) {
                        return rules.run(text, { stage: 'lore_read', sender: 'lore' });
                    }
                    return applyRegexRules(text, rules, { stage: 'lore_read', sender: 'lore' });
                },
            });

        this.tailRadar = deps.tailRadar ?? new TailRadar(this.loreReadEvaluator);

        this.vfs =
            deps.vfs
            ?? new VirtualFileSystem({
                bridge: this.bridge,
                store: this.store,
                loreReadHook: this.loreReadEvaluator.toLoreReadHook(),
                getPresetFiles: () => resolveActivePreset(this.settingsProvider()).files,
            });

        this.spillStore =
            deps.spillStore
            ?? this.baseToolRegistry.getSpillStore()
            ?? new TransientToolSpillStore();

        this.watermarkCompactor =
            deps.watermarkCompactor
            ?? new WatermarkCompactor({
                vfs: this.vfs,
                bridge: this.bridge,
            });
    }

    /** Execute a full single-agent or multi-round tool-calling turn. */
    async run(input: AgentRunInput): Promise<AgentRunResult> {
        return await this.runInternal(input);
    }

    private async runInternal(input: AgentRunInput): Promise<AgentRunResult> {
        const target = assertValidTarget(input.target);
        const signal = input.signal ?? new AbortController().signal;
        throwIfAborted(signal);

        const settings = this.settingsProvider();
        const preset = input.preset ?? resolveActivePreset(settings);
        const agent = this.resolveAgent(input.agent, preset);
        const connection = input.connection ?? resolveConnection(settings, agent.connectionId);
        const delegationDepth = input.delegationDepth ?? 0;
        const isMainOutputMode =
            input.requireOutputFile ?? (input.phase === 'main_turn' && delegationDepth === 0);

        const promptTriggerContext: PromptTriggerContext = input.promptTriggerContext ?? (
            delegationDepth > 0
                ? { kind: 'subagent', phase: input.phase }
                : input.phase === 'main_turn'
                    ? { kind: 'main', action: input.generationAction ?? 'normal' }
                    : {
                          kind: 'trigger',
                          phase: input.phase,
                          ...(input.triggerId
                              ? {
                                    triggerIds: input.triggerId
                                        .split(',')
                                        .map((id) => id.trim())
                                        .filter(Boolean),
                                }
                              : {}),
                      }
        );

        let effectiveAgent = agent;
        if (agent.id !== preset.mainAgentId) {
            const mainAgent = preset.agents[preset.mainAgentId];
            const inheritedBlocks = (mainAgent?.promptBlocks ?? []).filter(
                (b) =>
                    b.enabled
                    && b.content.trim().length > 0
                    && matchesPromptTriggers(b.triggers, promptTriggerContext, {
                        requireExplicit: true,
                    }),
            );
            if (inheritedBlocks.length > 0) {
                const existingIds = new Set((agent.promptBlocks ?? []).map((b) => b.id));
                const extraBlocks: PromptBlock[] = [];
                for (const block of inheritedBlocks) {
                    if (block.id === 'system_base' && existingIds.has('system_base')) {
                        if (!existingIds.has('__preset_main_system_base')) {
                            existingIds.add('__preset_main_system_base');
                            extraBlocks.push({ ...block, id: '__preset_main_system_base' });
                        }
                        continue;
                    }
                    if (!existingIds.has(block.id)) {
                        existingIds.add(block.id);
                        extraBlocks.push(block);
                    }
                }
                if (extraBlocks.length > 0) {
                    effectiveAgent = {
                        ...agent,
                        promptBlocks: [...(agent.promptBlocks ?? []), ...extraBlocks],
                    };
                }
            }
        }

        this.runSequence += 1;
        const runId = `run_${target.messageId}_${target.swipeId}_${this.runSequence}`;
        const startedAt = Date.now();

        const regex = this.resolveRegexSource(input.regex, preset);
        const loreEntries = input.loreEntries ?? (await this.loadRawLoreEntries());
        throwIfAborted(signal);

        const characterFields = input.characterFields ?? this.bridge.getCharacterFields();
        const personaDescription = input.personaDescription ?? this.bridge.getPersonaDescription();
        const basePermissions: ScopedPermissions = input.permissions ?? agent.permissions;
        const permissions: ScopedPermissions = isMainOutputMode
            ? buildOutputModePermissions(basePermissions)
            : basePermissions;
        const staged = input.staged ?? (input.phase === 'before_turn' || input.phase === 'main_turn');
        const effectiveReadSet = resolveInitialReadSet(
            input.initialReadSet,
            agent.sessionMode,
            this.trajectoryStore,
            agent.id,
        );

        const workingVars =
            input.vars ?? (await this.vfs.readVariables({ target, staged }).catch(() => ({})));
        throwIfAborted(signal);

        // Compile tool registry for this run (built-ins + preset customTools + @@tool + @@agent + extraTools)
        const { registry, autoAttachedToolNames } = await this.buildRunRegistry({
            agent,
            preset,
            loreEntries,
            extraTools: input.extraTools,
            subAgents: input.subAgents,
            allowSubAgentDelegation:
                input.allowSubAgentDelegation
                ?? (input.phase === 'main_turn'
                    || agent.enabledTools.some(
                        (t) => t === 'call_agent' || t === 'delegate_agent_*' || t.startsWith('delegate_agent_'),
                    )),
            includeSubAgentTools: input.includeSubAgentTools ?? true,
            delegationDepth,
            parentPhase: input.phase,
            target,
            connection,
            presetFiles: preset.files,
            signal,
        });

        const strictToolLoop = resolveStrictToolLoop(effectiveAgent, connection);
        const finishTurnMode: FinishTurnMode = resolveFinishTurnMode(
            isMainOutputMode,
            promptTriggerContext,
        );
        let finishTurnSpec: ReturnType<typeof createFinishTurnDefinition> | undefined;
        if (strictToolLoop) {
            finishTurnSpec = createFinishTurnDefinition(finishTurnMode);
            registry.register(finishTurnSpec.definition, { replace: true });
        }

        const requiredOutputTools = isMainOutputMode ? REQUIRED_OUTPUT_MODE_TOOLS : [];
        const enabledToolNames = this.resolveEnabledToolNames(
            input.enabledToolNames ?? agent.enabledTools,
            [...autoAttachedToolNames, ...requiredOutputTools],
            preset,
        );
        if (strictToolLoop && !enabledToolNames.includes(FINISH_TURN_TOOL_NAME)) {
            enabledToolNames.push(FINISH_TURN_TOOL_NAME);
        }

        const effectiveBuiltinToolSettings =
            strictToolLoop && preset.builtinToolSettings && FINISH_TURN_TOOL_NAME in preset.builtinToolSettings
                ? Object.fromEntries(
                    Object.entries(preset.builtinToolSettings).filter(
                        ([key]) => key !== FINISH_TURN_TOOL_NAME,
                    ),
                )
                : preset.builtinToolSettings;

        const canonicalTools: CanonicalToolSchema[] = registry
            .toCanonicalSchemas(enabledToolNames, effectiveBuiltinToolSettings)
            .map((schema) => {
                if (finishTurnSpec && schema.name === FINISH_TURN_TOOL_NAME) {
                    return canonicalClone({
                        ...schema,
                        parameters: {
                            ...schema.parameters,
                            propertyOrdering: [...finishTurnSpec.propertyOrdering],
                        },
                    });
                }
                return schema;
            });
        const allCanonicalToolNames = canonicalTools.map((t) => t.name);

        const recentChatMessages =
            input.recentChatMessages
            ?? (agent.sessionMode === 'ephemeral' && input.includeRecentChat !== false
                ? this.snapshotRecentChat(target, input.phase, agent.ephemeralWindowSize)
                : undefined);

        const toolSteps: ToolStepLog[] = [];
        let cumulativeUsage: TokenUsage = {
            inputTokens: 0,
            cachedTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cacheHitRate: 0,
        };
        let lastRequestSnapshot: AgentRunTrace['requestSnapshot'] | undefined;
        let lastContent = '';
        let lastReasoning = '';
        let roundsCompleted = 0;

        this.traceLogger.emit({
            kind: 'phase_started',
            target: { ...target },
            timestamp: startedAt,
            phase: input.phase,
            runId,
            agentProfileId: agent.id,
        });

        this.traceLogger.recordTrace(
            {
                runId,
                target: { ...target },
                phase: input.phase,
                agentProfileId: agent.id,
                agentName: agent.name,
                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
                connectionId: connection.id,
                model: connection.model,
                status: 'running',
                startedAt,
                durationMs: 0,
                usage: { ...cumulativeUsage },
                toolSteps: [],
            },
            false,
        );

        const toolCtx = createToolExecutionContext({
            bridge: this.bridge,
            vfs: this.vfs,
            store: this.store,
            ...(this.sideGen ? { sideGen: this.sideGen } : {}),
            target,
            signal,
            permissions,
            readSet: effectiveReadSet,
            staged,
            source: `agent:${agent.id}`,
            getVariableSchema: input.getVariableSchema,
        });

        const loreOverrides = this.collectWorldInfoOverrides(target, staged);
        const initialOutput = isMainOutputMode
            ? await this.vfs.readFile(OUTPUT_FILE_PATH, { target, staged }).catch(() => '')
            : '';
        const extractor = isMainOutputMode
            ? new IncrementalOutputStreamExtractor({
                initialOutput,
                onPreview: (fullText) => {
                    this.traceLogger.emit({
                        kind: 'output_preview',
                        target: { ...target },
                        timestamp: Date.now(),
                        phase: input.phase,
                        runId,
                        agentProfileId: agent.id,
                        outputPreview: fullText,
                    });
                    input.onOutputPreview?.(fullText);
                },
            })
            : undefined;

        const finishExtractor =
            strictToolLoop && finishTurnMode === 'return_value' && input.onTextDelta
                ? new FinishTurnStreamExtractor({
                    onResponseDelta: (delta) => {
                        input.onTextDelta?.(delta);
                    },
                })
                : undefined;

        const turnMessages: CanonicalMessage[] = input.resumeMessages
            ? canonicalClone([...input.resumeMessages])
            : [];
        const completedTurnMessages: CanonicalMessage[] = input.resumeMessages
            ? canonicalClone([...input.resumeMessages])
            : [];
        let bestSalvageableOutput: string | null = null;

        const recordFailureAndThrow = (
            aborted: boolean,
            message: string,
            originalError?: unknown,
        ): never => {
            const endedAt = Date.now();
            const failTrace = this.traceLogger.recordTrace(
                {
                    runId,
                    target: { ...target },
                    phase: input.phase,
                    agentProfileId: agent.id,
                    agentName: agent.name,
                    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                    ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
                    connectionId: connection.id,
                    model: connection.model,
                    status: aborted ? 'aborted' : 'error',
                    startedAt,
                    endedAt,
                    durationMs: Math.max(0, endedAt - startedAt),
                    usage: cumulativeUsage,
                    toolSteps: canonicalClone(toolSteps),
                    ...(lastContent ? { outputPreview: lastContent.slice(0, 240) } : {}),
                    ...(lastReasoning && !lastContent
                        ? { outputPreview: lastReasoning.slice(0, 240) }
                        : {}),
                    error: message,
                    requestSnapshot: lastRequestSnapshot,
                },
                true,
            );

            if (aborted) {
                throw originalError instanceof Error && isAbortError(originalError)
                    ? originalError
                    : createAbortError(message);
            }
            if (originalError instanceof AgentExecutionError) {
                throw originalError;
            }
            throw new AgentExecutionError(message, failTrace, originalError);
        };

        const salvageAndInterrupt = async (
            reason: InterruptedReason,
            errorMessage?: string,
            originalError?: unknown,
        ): Promise<never> => {
            const salvaged = extractor?.getSalvageableOutput() ?? bestSalvageableOutput ?? null;
            if (salvaged !== null && salvaged.length > 0) {
                await this.vfs.writeFile(OUTPUT_FILE_PATH, salvaged, {
                    target,
                    staged,
                    source: 'salvage',
                });
                this.traceLogger.emit({
                    kind: 'output_preview',
                    target: { ...target },
                    timestamp: Date.now(),
                    phase: input.phase,
                    runId,
                    agentProfileId: agent.id,
                    outputPreview: salvaged,
                });
                input.onOutputPreview?.(salvaged);
            }

            const currentOutput = await this.vfs
                .readFile(OUTPUT_FILE_PATH, { target, staged })
                .catch(() => '');

            const hasCompletedToolRounds =
                toolSteps.length > 0 || input.resumeMessages !== undefined;
            const hasProgress =
                currentOutput.length > 0
                || hasCompletedToolRounds
                || this.store.hasPending(target)
                || reason === 'empty_output';

            if (!hasProgress) {
                const isAborted =
                    reason === 'user_stop' || isAbortError(originalError) || signal.aborted;
                const fallbackMsg = isAborted
                    ? 'Agent run aborted'
                    : errorMessage
                        ?? (reason === 'length'
                            ? 'Generation hit max_tokens length limit before producing any output'
                            : 'Agent execution failed');
                return recordFailureAndThrow(isAborted, fallbackMsg, originalError);
            }

            const resolvedErrorMessage =
                errorMessage
                ?? (reason === 'user_stop'
                    ? 'Generation interrupted by user'
                    : reason === 'length'
                        ? 'Generation interrupted by max_tokens length limit'
                        : reason === 'empty_output'
                            ? 'Model finished without writing to /output.md'
                            : 'Generation interrupted due to error');

            const endedAt = Date.now();
            const interruptedTrace = this.traceLogger.recordTrace(
                {
                    runId,
                    target: { ...target },
                    phase: input.phase,
                    agentProfileId: agent.id,
                    agentName: agent.name,
                    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                    ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
                    connectionId: connection.id,
                    model: connection.model,
                    status: 'interrupted',
                    interruptedReason: reason,
                    startedAt,
                    endedAt,
                    durationMs: Math.max(0, endedAt - startedAt),
                    usage: cumulativeUsage,
                    toolSteps: canonicalClone(toolSteps),
                    ...(currentOutput
                        ? { outputPreview: currentOutput.slice(0, 240) }
                        : lastContent
                            ? { outputPreview: lastContent.slice(0, 240) }
                            : {}),
                    error: resolvedErrorMessage,
                    requestSnapshot: lastRequestSnapshot,
                },
                true,
            );

            if (completedTurnMessages.length === 0 && input.userInput !== undefined) {
                completedTurnMessages.push({
                    role: 'user',
                    content: canonicalClone(input.userInput),
                    ...(input.userName ? { name: input.userName } : {}),
                });
            }

            const checkpoint: InterruptedTurnCheckpoint = {
                agentId: agent.id,
                target: { messageId: target.messageId, swipeId: target.swipeId },
                reason,
                errorMessage: resolvedErrorMessage,
                completedTurnMessages: canonicalClone(completedTurnMessages),
                readSetSnapshot: Object.fromEntries(effectiveReadSet.entries()),
                stagedSnapshot: this.store.snapshotStagedData(target),
                createdAt: endedAt,
            };

            throw new TurnInterruptedError({
                reason,
                salvagedOutput: currentOutput,
                checkpoint,
                trace: interruptedTrace,
                errorMessage: resolvedErrorMessage,
            });
        };

        try {
            let activeRecentChatMessages = recentChatMessages ? [...recentChatMessages] : undefined;

            // Pre-render matching Layer 0 `prefix` blocks (EJS + Track A/B custom JSON) once per run
            // whenever Layer 0 will not reuse a frozen prefix, so Round 2+ synchronous `reassembleInFlight()`
            // preserves exact byte-for-byte Layer 0 KV-cache invariance for ephemeral & trigger runs.
            const promptBlocks = effectiveAgent.promptBlocks ?? [];
            const isPersistent = effectiveAgent.sessionMode === 'persistent';
            const hasTriggerScopedBlocks = promptBlocks.some(
                (b) => b.triggers && b.triggers.length > 0,
            );
            const isNonMainTriggerRun =
                isPersistent
                && promptTriggerContext.kind !== 'main'
                && hasTriggerScopedBlocks;
            const willUseFrozenPrefix =
                isPersistent
                && !input.forceRecompilePrefix
                && !isNonMainTriggerRun
                && Boolean(this.trajectoryStore.getFrozenPrefix(effectiveAgent.id));

            let preRenderedBlocks: Map<string, CanonicalMessage[]> | undefined;
            if (!willUseFrozenPrefix) {
                const prefixBlocksToRender: PromptBlock[] = [];
                const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
                if (
                    input.systemBasePrompt === undefined
                    && systemBaseBlock
                    && systemBaseBlock.enabled
                    && systemBaseBlock.content.trim().length > 0
                    && matchesPromptTriggers(systemBaseBlock.triggers, promptTriggerContext)
                ) {
                    prefixBlocksToRender.push(systemBaseBlock);
                }
                for (const block of promptBlocks) {
                    if (
                        block.enabled
                        && block.placement === 'prefix'
                        && block.id !== 'system_base'
                        && block.content.trim().length > 0
                        && matchesPromptTriggers(block.triggers, promptTriggerContext)
                    ) {
                        prefixBlocksToRender.push(block);
                    }
                }
                if (prefixBlocksToRender.length > 0) {
                    preRenderedBlocks = await prerenderPromptBlocks(prefixBlocksToRender, {
                        hostBridge: this.bridge,
                        vars: workingVars,
                    });
                    throwIfAborted(signal);
                }
            }

            const floatingTailBlocksToRender = promptBlocks.filter(
                (block) =>
                    block.enabled
                    && block.placement === 'floating_tail'
                    && block.content.trim().length > 0
                    && matchesPromptTriggers(block.triggers, promptTriggerContext),
            );
            if (floatingTailBlocksToRender.length > 0) {
                const floatingMacroOverrides = buildLayer2MacroOverrides(
                    workingVars,
                    input.macroOverrides,
                );
                const renderedFloating = await prerenderPromptBlocks(floatingTailBlocksToRender, {
                    hostBridge: this.bridge,
                    macroOverrides: floatingMacroOverrides,
                    vars: workingVars,
                });
                throwIfAborted(signal);
                if (!preRenderedBlocks) {
                    preRenderedBlocks = renderedFloating;
                } else {
                    for (const [blockId, messages] of renderedFloating.entries()) {
                        preRenderedBlocks.set(blockId, messages);
                    }
                }
            }

            const baseAssembleInput = {
                agent: effectiveAgent,
                connectionId: connection.id,
                tools: canonicalTools,
                characterFields,
                personaDescription,
                loreEntries,
                wiRouterOverrides: preset.wiRouterOverrides,
                presetFiles: preset.files,
                systemBasePrompt: input.systemBasePrompt,
                promptTriggerContext,
                ...(preRenderedBlocks ? { preRenderedBlocks } : {}),
                trajectoryStore: agent.sessionMode === 'persistent' ? this.trajectoryStore : undefined,
                recentChatMessages: activeRecentChatMessages,
                hostBridge: this.bridge,
                regex,
                vars: workingVars,
                macroOverrides: input.macroOverrides,
                signal,
            };

            const isMainTurnRoot = input.phase === 'main_turn' && delegationDepth === 0;
            const workspaceNotices = input.resumeMessages === undefined
                ? await buildWorkspaceNotices({
                    vfs: this.vfs,
                    permissions,
                    readSet: effectiveReadSet,
                    target,
                    staged,
                    hashText: (text) => this.bridge.hashText(text),
                }).catch(() => ({
                    noticeXml: '',
                    unreadIndexPaths: [] as string[],
                    updatedIndexPaths: [] as string[],
                    staleDocPaths: [] as string[],
                    sharedUpdatePaths: [] as string[],
                }))
                : { noticeXml: '' };
            throwIfAborted(signal);

            let currentAssembled = input.resumeMessages !== undefined
                ? this.contextAssembler.assemble({
                    ...baseAssembleInput,
                    forceRecompilePrefix: input.forceRecompilePrefix,
                    inFlightMessages: turnMessages,
                })
                : await this.contextAssembler.assembleWithHost({
                    ...baseAssembleInput,
                    forceRecompilePrefix: input.forceRecompilePrefix,
                    userInput: input.userInput,
                    userName: input.userName,
                    turnBrief: input.turnBrief,
                    dynamicReminders: input.dynamicReminders,
                    includeCategory4DynamicEntries:
                        input.includeCategory4DynamicEntries ?? (input.phase === 'main_turn'),
                    loreHint: input.loreHint,
                    runTailRadar: input.runTailRadar ?? (input.phase === 'main_turn'),
                    target,
                    tailRadar: this.tailRadar,
                    ...(workspaceNotices.noticeXml ? { workspaceNotice: workspaceNotices.noticeXml } : {}),
                    ...(isMainTurnRoot ? { vfs: this.vfs } : {}),
                });

            const consumedSideBriefPaths =
                input.resumeMessages === undefined && isMainTurnRoot
                    ? [...currentAssembled.consumedSideBriefPaths]
                    : [];

            // Sync read-time overrides into TailRadar if needed (already handled by loreReadEvaluator.getOverride).
            void loreOverrides;

            if (input.resumeMessages === undefined) {
                const initialLayer2 = canonicalClone(currentAssembled.layer2Messages);
                turnMessages.push(...initialLayer2);
                completedTurnMessages.push(...canonicalClone(initialLayer2));
            }

            const contextBudget = resolveEffectiveContextBudget(
                connection,
                agent.watermark ? { configuredWatermark: agent.watermark } : undefined,
            );

            const reassembleInFlight = () =>
                this.contextAssembler.assemble({
                    ...baseAssembleInput,
                    recentChatMessages: activeRecentChatMessages,
                    inFlightMessages: turnMessages,
                });

            const compactHistoryDeterministic = async (params: {
                high: number;
                low: number;
                keepRecentTurns: number;
                minRetainedTurns: number;
            }): Promise<boolean> => {
                throwIfAborted(signal);
                if (agent.sessionMode === 'persistent') {
                    const inFlightTokens = estimateRequestTokens(turnMessages);
                    const historyLow = Math.max(50, params.low - inFlightTokens);
                    const historyHigh = Math.max(historyLow + 1, params.high);
                    const result = await this.watermarkCompactor.compact(this.trajectoryStore, {
                        agentId: agent.id,
                        watermark: { high: historyHigh, low: historyLow },
                        keepRecentTurns: params.keepRecentTurns,
                        minRetainedTurns: params.minRetainedTurns,
                        layer0Messages: currentAssembled.layer0Messages,
                        tools: currentAssembled.request.tools,
                        triggers: preset.triggers,
                        loreEntries,
                        force: true,
                        signal,
                    });
                    if (result.evictedReadPaths.length > 0) {
                        for (const evictedPath of result.evictedReadPaths) {
                            effectiveReadSet.delete(evictedPath);
                        }
                    }
                    return result.compacted;
                }

                if (!activeRecentChatMessages || activeRecentChatMessages.length === 0) {
                    return false;
                }

                let trimmed = false;
                while (activeRecentChatMessages.length > 0) {
                    throwIfAborted(signal);
                    const dropCount = Math.max(1, Math.ceil(activeRecentChatMessages.length / 2));
                    activeRecentChatMessages = activeRecentChatMessages.slice(dropCount);
                    trimmed = true;
                    const candidate = reassembleInFlight();
                    if (candidate.stats.estimatedTokens <= params.low) {
                        break;
                    }
                }
                return trimmed;
            };

            const runPreflightBudgetGuard = async (): Promise<void> => {
                const estimated = estimateRequestTokens(
                    currentAssembled.request.messages,
                    currentAssembled.request.tools,
                );
                if (estimated < contextBudget.preFlightThreshold) {
                    return;
                }

                throwIfAborted(signal);
                const compactedGentle = await compactHistoryDeterministic({
                    high: contextBudget.autoHighWatermark,
                    low: contextBudget.autoLowWatermark,
                    keepRecentTurns: 1,
                    minRetainedTurns: 1,
                });
                if (compactedGentle) {
                    currentAssembled = reassembleInFlight();
                }

                if (currentAssembled.stats.estimatedTokens >= contextBudget.preFlightThreshold) {
                    const folded = foldInFlightToolMessagesForPreflight({
                        turnMessages,
                        completedTurnMessages,
                        currentTokens: currentAssembled.stats.estimatedTokens,
                        targetTokens: contextBudget.preFlightThreshold,
                    });
                    if (folded.foldedCount > 0) {
                        currentAssembled = reassembleInFlight();
                    }
                }

                if (
                    currentAssembled.stats.estimatedTokens >= contextBudget.preFlightThreshold
                    && agent.sessionMode === 'persistent'
                    && this.trajectoryStore.getMessageCount(agent.id) > 0
                ) {
                    const compactedDeep = await compactHistoryDeterministic({
                        high: contextBudget.autoHighWatermark,
                        low: contextBudget.autoLowWatermark,
                        keepRecentTurns: 0,
                        minRetainedTurns: 0,
                    });
                    if (compactedDeep) {
                        currentAssembled = reassembleInFlight();
                    }
                }
            };

            const runEmergencyOverflowRecovery = async (
                overflow: ContextOverflowInfo,
            ): Promise<void> => {
                throwIfAborted(signal);
                const effectiveLimit = overflow.limitTokens ?? contextBudget.safeInputBudget;
                const emergencyLowTarget = Math.max(256, Math.floor(effectiveLimit * 0.4));
                const emergencyHighTarget = Math.max(
                    emergencyLowTarget + 1,
                    Math.floor(effectiveLimit * 0.6),
                );

                // 1. Crop oversized in-flight tool results IN-PLACE (strictly preserving toolCallId).
                cropInFlightToolMessagesForOverflow({
                    turnMessages,
                    completedTurnMessages,
                    limitTokens: effectiveLimit,
                });

                // 2. Run deterministic emergency history compaction with ZERO LLM summary calls.
                await compactHistoryDeterministic({
                    high: emergencyHighTarget,
                    low: emergencyLowTarget,
                    keepRecentTurns: 0,
                    minRetainedTurns: 0,
                });

                // 3. Reset any partial streaming buffer from the failed attempt.
                if (extractor) {
                    const currentOut = await this.vfs
                        .readFile(OUTPUT_FILE_PATH, { target, staged })
                        .catch(() => '');
                    extractor.resetRound(currentOut);
                }

                // 4. Re-assemble compacted request before retrying invokeLLM once.
                currentAssembled = reassembleInFlight();
            };

            const hasToolRoundLimit =
                typeof agent.maxToolRounds === 'number'
                && Number.isFinite(agent.maxToolRounds)
                && agent.maxToolRounds > 0;
            const maxToolRounds = hasToolRoundLimit
                ? Math.floor(agent.maxToolRounds)
                : Number.POSITIVE_INFINITY;
            const maxRoundRetries = Math.max(0, Math.floor(connection.roundMaxRetries ?? 2));
            let toolRoundsExecuted = 0;
            let emptyOutputRetried = false;
            let overflowRecoveryAttempted = false;

            // Per-turn strict tool loop state (causally bound to this target & AbortSignal)
            const readSignatureCounts = new Map<string, number>();
            const blockedReadTools = new Set<string>();
            let consecutiveDuplicateReadOnlyRounds = 0;
            let shrinkToWriteAndFinish = false;
            let hasWriteToolExecuted = false;

            const readCurrentOutputSafe = async (): Promise<string> =>
                await this.vfs.readFile(OUTPUT_FILE_PATH, { target, staged }).catch(() => '');

            const computeRoundToolChoice = async (): Promise<LLMToolChoice | undefined> => {
                if (!strictToolLoop || allCanonicalToolNames.length === 0) {
                    return undefined;
                }

                let canFinish = true;
                if (finishTurnMode === 'main_output') {
                    const currentOut = await readCurrentOutputSafe();
                    canFinish = currentOut.trim().length > 0;
                } else if (finishTurnMode === 'side_effect') {
                    canFinish = hasWriteToolExecuted || toolRoundsExecuted > 0;
                }

                let currentAllowed: string[];
                if (hasToolRoundLimit && toolRoundsExecuted >= maxToolRounds && canFinish) {
                    currentAllowed = allCanonicalToolNames.includes(FINISH_TURN_TOOL_NAME)
                        ? [FINISH_TURN_TOOL_NAME]
                        : [...allCanonicalToolNames];
                } else {
                    currentAllowed = allCanonicalToolNames.filter((name) => {
                        if (name === FINISH_TURN_TOOL_NAME) {
                            return canFinish;
                        }
                        if (shrinkToWriteAndFinish && READ_ONLY_TOOL_NAMES.has(name)) {
                            return false;
                        }
                        if (blockedReadTools.has(name)) {
                            return false;
                        }
                        return true;
                    });

                    if (currentAllowed.length === 0) {
                        if (canFinish && allCanonicalToolNames.includes(FINISH_TURN_TOOL_NAME)) {
                            currentAllowed = [FINISH_TURN_TOOL_NAME];
                        } else {
                            const nonFinish = allCanonicalToolNames.filter(
                                (name) => name !== FINISH_TURN_TOOL_NAME,
                            );
                            currentAllowed = nonFinish.length > 0
                                ? nonFinish
                                : [...allCanonicalToolNames];
                        }
                    }
                }

                return {
                    mode: 'required',
                    allowedToolNames: currentAllowed,
                };
            };

            const buildTurnState = async (): Promise<{ round: string; output_ready: boolean }> => {
                const outputReady =
                    finishTurnMode === 'main_output'
                        ? (await readCurrentOutputSafe()).trim().length > 0
                        : finishTurnMode === 'side_effect'
                            ? hasWriteToolExecuted
                            : true;
                return {
                    round: hasToolRoundLimit
                        ? `${toolRoundsExecuted}/${maxToolRounds}`
                        : `${toolRoundsExecuted}`,
                    output_ready: outputReady,
                };
            };

            const finalizeSuccessfulTurn = async (params: {
                finalContent: string;
                persistedAssistantContent: string;
                reasoningContent?: string;
            }): Promise<AgentRunResult> => {
                if (consumedSideBriefPaths.length > 0) {
                    await this.vfs.markSideCluesConsumed(
                        consumedSideBriefPaths,
                        target.messageId + 1,
                        {
                            target,
                            staged,
                            source: `agent:${agent.id}`,
                        },
                    );
                }

                if (agent.sessionMode === 'persistent') {
                    this.trajectoryStore.setReadSet(effectiveReadSet, agent.id);
                    this.contextAssembler.finalizeTurn({
                        trajectoryStore: this.trajectoryStore,
                        agentId: agent.id,
                        target,
                        turnMessages,
                        finalAssistantMessage: {
                            role: 'assistant',
                            content: params.persistedAssistantContent,
                            ...(params.reasoningContent
                                ? { reasoningContent: params.reasoningContent }
                                : {}),
                        },
                        regex,
                    });
                }

                const endedAt = Date.now();
                const finalTrace = this.traceLogger.recordTrace(
                    {
                        runId,
                        target: { ...target },
                        phase: input.phase,
                        agentProfileId: agent.id,
                        agentName: agent.name,
                        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                        ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
                        connectionId: connection.id,
                        model: connection.model,
                        status: 'completed',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: cumulativeUsage,
                        toolSteps: canonicalClone(toolSteps),
                        outputPreview: params.finalContent.slice(0, 240),
                        requestSnapshot: lastRequestSnapshot,
                    },
                    true,
                );

                this.traceLogger.emit({
                    kind: 'phase_completed',
                    target: { ...target },
                    timestamp: endedAt,
                    phase: input.phase,
                    runId,
                    agentProfileId: agent.id,
                });

                return {
                    runId,
                    target,
                    phase: input.phase,
                    agentProfileId: agent.id,
                    content: params.finalContent,
                    ...(params.reasoningContent
                        ? { reasoningContent: params.reasoningContent }
                        : {}),
                    toolSteps,
                    usage: cumulativeUsage,
                    trace: finalTrace,
                    rounds: roundsCompleted,
                    requestSnapshot: lastRequestSnapshot,
                };
            };

            const throwMaxToolRounds = (): never => {
                const endedAt = Date.now();
                const errorMessage = `Agent "${agent.name}" exceeded maxToolRounds (${maxToolRounds}).`;
                const errorTrace = this.traceLogger.recordTrace(
                    {
                        runId,
                        target: { ...target },
                        phase: input.phase,
                        agentProfileId: agent.id,
                        agentName: agent.name,
                        ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                        ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
                        connectionId: connection.id,
                        model: connection.model,
                        status: 'error',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: cumulativeUsage,
                        toolSteps: canonicalClone(toolSteps),
                        ...(lastContent ? { outputPreview: lastContent.slice(0, 240) } : {}),
                        error: errorMessage,
                        requestSnapshot: lastRequestSnapshot,
                    },
                    true,
                );
                throw new MaxToolRoundsError(maxToolRounds, errorTrace);
            };

            // eslint-disable-next-line no-constant-condition
            while (true) {
                throwIfAborted(signal);

                await runPreflightBudgetGuard();

                const roundToolChoice = await computeRoundToolChoice();
                let roundRetriesUsed = 0;
                let nonStrictRefusalRetried = false;
                let turnOutput: Awaited<ReturnType<AgentRunner['invokeLLM']>>;

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    throwIfAborted(signal);

                    const llmRequest: LLMRequest = {
                        ...currentAssembled.request,
                        connectionId: connection.id,
                        connection,
                        ...(roundToolChoice ? { toolChoice: roundToolChoice } : {}),
                        stream: input.stream ?? connection.stream ?? true,
                        signal,
                    };

                    lastRequestSnapshot = {
                        messages: canonicalClone(llmRequest.messages),
                        tools: canonicalClone(llmRequest.tools),
                        ...(llmRequest.cacheBreakpoints
                            ? { cacheBreakpoints: [...llmRequest.cacheBreakpoints] }
                            : {}),
                    };

                    const onToolCallDelta =
                        extractor || finishExtractor
                            ? (idx: number, delta: ToolCallDeltaInput) => {
                                extractor?.feedToolCallDelta(idx, delta);
                                finishExtractor?.feedToolCallDelta(idx, delta);
                            }
                            : undefined;

                    try {
                        turnOutput = await this.invokeLLM({
                            request: llmRequest,
                            useStream: Boolean(llmRequest.stream),
                            target,
                            phase: input.phase,
                            runId,
                            agentId: agent.id,
                            signal,
                            onTextDelta:
                                isMainOutputMode || strictToolLoop ? undefined : input.onTextDelta,
                            onReasoningDelta: input.onReasoningDelta,
                            onToolCallDelta,
                        });

                        if (!isLengthFinishReason(turnOutput.finishReason)) {
                            if (turnOutput.toolCalls.length === 0 && !turnOutput.content.trim()) {
                                throw new LLMTransportError(
                                    'Model returned an empty response with no tool calls.',
                                    {
                                        code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE,
                                        retryable: true,
                                    },
                                );
                            }
                            if (
                                llmRequest.toolChoice?.mode === 'required'
                                && turnOutput.toolCalls.length === 0
                            ) {
                                throw new LLMTransportError(
                                    'Model violated required toolChoice by returning plain text without tool calls.',
                                    {
                                        code: ROUND_RETRY_ERROR_CODES.TOOL_CHOICE_VIOLATION,
                                        retryable: true,
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
                                    'Model produced malformed non-JSON-object tool call arguments.',
                                    {
                                        code: ROUND_RETRY_ERROR_CODES.MALFORMED_TOOL_CALL,
                                        retryable: true,
                                    },
                                );
                            }
                            if (
                                !strictToolLoop
                                && isMainOutputMode
                                && turnOutput.toolCalls.length === 0
                                && !nonStrictRefusalRetried
                                && roundRetriesUsed < maxRoundRetries
                                && isLikelyRefusalText(turnOutput.content)
                            ) {
                                const currentOut = await readCurrentOutputSafe();
                                if (currentOut.trim().length === 0) {
                                    nonStrictRefusalRetried = true;
                                    throw new LLMTransportError(
                                        'Model returned a refusal in plain text without writing /output.md.',
                                        {
                                            code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE,
                                            retryable: true,
                                        },
                                    );
                                }
                            }
                        }

                        bestSalvageableOutput = null;
                        break;
                    } catch (error) {
                        if (isAbortError(error) || signal.aborted) {
                            throw error;
                        }
                        const overflowInfo = parseContextOverflowError(error);
                        if (overflowInfo && !overflowRecoveryAttempted) {
                            overflowRecoveryAttempted = true;
                            await runEmergencyOverflowRecovery(overflowInfo);
                            continue;
                        }

                        if (roundRetriesUsed < maxRoundRetries && isRetryableRoundError(error)) {
                            const attemptSalvage = extractor?.getSalvageableOutput() ?? null;
                            if (
                                attemptSalvage
                                && (!bestSalvageableOutput
                                    || attemptSalvage.length > bestSalvageableOutput.length)
                            ) {
                                bestSalvageableOutput = attemptSalvage;
                            }

                            roundRetriesUsed += 1;
                            const retryDelayMs = computeRoundRetryDelayMs({
                                error,
                                attempt: roundRetriesUsed,
                                initialDelayMs: this.roundRetryInitialDelayMs,
                                maxDelayMs: this.roundRetryMaxDelayMs,
                                jitterRatio: 0.25,
                            });
                            const retryReason = formatRoundRetryReason(error);

                            if (extractor) {
                                const committedOutput = await readCurrentOutputSafe();
                                extractor.resetRound(committedOutput);
                                this.traceLogger.emit({
                                    kind: 'output_preview',
                                    target: { ...target },
                                    timestamp: Date.now(),
                                    phase: input.phase,
                                    runId,
                                    agentProfileId: agent.id,
                                    outputPreview: committedOutput,
                                });
                                input.onOutputPreview?.(committedOutput);
                            }
                            finishExtractor?.resetRound();

                            this.traceLogger.emit({
                                kind: 'turn_retrying',
                                target: { ...target },
                                timestamp: Date.now(),
                                phase: input.phase,
                                runId,
                                agentProfileId: agent.id,
                                retryAttempt: roundRetriesUsed,
                                retryMaxAttempts: maxRoundRetries,
                                retryDelayMs,
                                retryReason,
                            });

                            await delayWithAbort(retryDelayMs, signal);
                            continue;
                        }

                        throw error;
                    }
                }

                roundsCompleted += 1;
                cumulativeUsage = addUsage(cumulativeUsage, turnOutput.usage);
                lastContent = turnOutput.content;
                if (turnOutput.reasoningContent) {
                    lastReasoning = turnOutput.reasoningContent;
                }

                // Intercept max_tokens length truncation BEFORE attempting to parse/execute partial tool JSON.
                if (isMainOutputMode && isLengthFinishReason(turnOutput.finishReason)) {
                    return await salvageAndInterrupt('length');
                }

                // Multi-round Prefill (`partial: true` / `prefix: true`) auto-consumption folding:
                // Pop the transient trailing prefill placeholder and prepend its prefix text into
                // the clean assistant turn output before writing into history (prevents Round 2 HTTP 400).
                const trailingTurnMsg = turnMessages[turnMessages.length - 1];
                if (isPrefillAssistantMessage(trailingTurnMsg)) {
                    const prefixText = extractMessageText(trailingTurnMsg.content);
                    turnMessages.pop();
                    if (
                        isPrefillAssistantMessage(
                            completedTurnMessages[completedTurnMessages.length - 1],
                        )
                    ) {
                        completedTurnMessages.pop();
                    }
                    turnOutput = {
                        ...turnOutput,
                        content: `${prefixText}${turnOutput.content ?? ''}`,
                    };
                    lastContent = turnOutput.content;
                } else {
                    const lastFloatingMsg =
                        currentAssembled.floatingTailMessages[
                            currentAssembled.floatingTailMessages.length - 1
                        ];
                    if (isPrefillAssistantMessage(lastFloatingMsg)) {
                        const prefixText = extractMessageText(lastFloatingMsg.content);
                        turnOutput = {
                            ...turnOutput,
                            content: `${prefixText}${turnOutput.content ?? ''}`,
                        };
                        lastContent = turnOutput.content;
                    }
                }

                if (turnOutput.toolCalls.length === 0) {
                    let finalContent = turnOutput.content;
                    if (isMainOutputMode) {
                        const currentOutput = await readCurrentOutputSafe();

                        if (currentOutput.trim().length === 0) {
                            if (
                                !emptyOutputRetried
                                && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds)
                            ) {
                                emptyOutputRetried = true;
                                toolRoundsExecuted += 1;

                                const emptyAssistantMsg: CanonicalMessage = {
                                    role: 'assistant',
                                    content: turnOutput.content ?? '',
                                    ...(turnOutput.reasoningContent
                                        ? { reasoningContent: turnOutput.reasoningContent }
                                        : {}),
                                };
                                const systemCheckMsg: CanonicalMessage = {
                                    role: 'user',
                                    content: EMPTY_OUTPUT_CHECK_PROMPT,
                                };
                                turnMessages.push(emptyAssistantMsg, systemCheckMsg);
                                completedTurnMessages.push(
                                    canonicalClone(emptyAssistantMsg),
                                    canonicalClone(systemCheckMsg),
                                );

                                currentAssembled = reassembleInFlight();
                                continue;
                            }

                            return await salvageAndInterrupt(
                                'empty_output',
                                'Model finished without writing to /output.md',
                            );
                        }

                        finalContent = currentOutput;
                    }

                    return await finalizeSuccessfulTurn({
                        finalContent,
                        persistedAssistantContent: turnOutput.content,
                        reasoningContent: turnOutput.reasoningContent,
                    });
                }

                // Strict tool loop: check pure `finish_turn` completion BEFORE `maxToolRounds` guardrail.
                if (
                    strictToolLoop
                    && finishTurnSpec
                    && turnOutput.toolCalls.every((tc) => tc.name === FINISH_TURN_TOOL_NAME)
                ) {
                    const primaryFinish = turnOutput.toolCalls[0];
                    const parsedFinish = parseFinishTurnArgs(
                        primaryFinish.arguments,
                        finishTurnSpec.definition.parameters,
                    );

                    if (parsedFinish.ok) {
                        if (finishTurnMode === 'main_output') {
                            const currentOutput = await readCurrentOutputSafe();
                            if (currentOutput.trim().length > 0) {
                                const stepBrief = String(parsedFinish.data.step_brief ?? '').trim();
                                return await finalizeSuccessfulTurn({
                                    finalContent: currentOutput,
                                    persistedAssistantContent:
                                        turnOutput.content.trim() || stepBrief,
                                    reasoningContent: turnOutput.reasoningContent,
                                });
                            }
                            // Fall through below to reject empty `/output.md` `finish_turn` and continue loop.
                        } else if (finishTurnMode === 'side_effect') {
                            if (hasWriteToolExecuted || toolRoundsExecuted > 0) {
                                const statusText =
                                    typeof parsedFinish.data.status === 'string'
                                    && parsedFinish.data.status.trim().length > 0
                                        ? parsedFinish.data.status.trim()
                                        : String(parsedFinish.data.step_brief ?? '').trim();
                                return await finalizeSuccessfulTurn({
                                    finalContent: statusText,
                                    persistedAssistantContent: statusText,
                                    reasoningContent: turnOutput.reasoningContent,
                                });
                            }
                            // Fall through below to reject premature round-1 side-effect `finish_turn`.
                        } else {
                            const responseText = String(parsedFinish.data.response ?? '');
                            return await finalizeSuccessfulTurn({
                                finalContent: responseText,
                                persistedAssistantContent: responseText,
                                reasoningContent: turnOutput.reasoningContent,
                            });
                        }
                    }
                }

                // Enforce maxToolRounds guardrail before executing another round of tool calls.
                if (hasToolRoundLimit && toolRoundsExecuted >= maxToolRounds) {
                    throwMaxToolRounds();
                }

                toolRoundsExecuted += 1;

                const assistantToolMsg: CanonicalMessage = {
                    role: 'assistant',
                    content: turnOutput.content ?? '',
                    ...(turnOutput.reasoningContent
                        ? { reasoningContent: turnOutput.reasoningContent }
                        : {}),
                    toolCalls: canonicalClone(turnOutput.toolCalls),
                };
                turnMessages.push(assistantToolMsg);
                const roundToolResults: CanonicalMessage[] = [];
                const hasOtherToolsInRound = turnOutput.toolCalls.some(
                    (tc) => tc.name !== FINISH_TURN_TOOL_NAME,
                );

                let roundNonFinishCount = 0;
                let roundAllDuplicateReadOnly = true;
                let roundHadSuccessfulWrite = false;

                for (const toolCall of turnOutput.toolCalls) {
                    throwIfAborted(signal);
                    const stepIndex = toolSteps.length;
                    const stepStartedAt = Date.now();
                    const parsedArgs = parseArgsForLog(toolCall.arguments);

                    const startedStep: ToolStepLog = {
                        stepIndex,
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: parsedArgs,
                        result: '',
                        ok: true,
                        durationMs: 0,
                        startedAt: stepStartedAt,
                    };

                    this.traceLogger.emit({
                        kind: 'tool_started',
                        target: { ...target },
                        timestamp: stepStartedAt,
                        phase: input.phase,
                        runId,
                        agentProfileId: agent.id,
                        toolStep: canonicalClone(startedStep),
                    });
                    input.onToolStart?.(startedStep);

                    let execResult: Awaited<ReturnType<ToolRegistry['executeToolCall']>>;
                    let duplicateReadWarning: string | undefined;

                    if (strictToolLoop && toolCall.name === FINISH_TURN_TOOL_NAME) {
                        if (hasOtherToolsInRound) {
                            let errorMsg =
                                'Other tools ran in this round. Review their outputs first, then call finish_turn in the next round.';
                            if (finishTurnMode === 'main_output') {
                                const currentOut = await readCurrentOutputSafe();
                                if (currentOut.trim().length === 0) {
                                    errorMsg = EMPTY_OUTPUT_FINISH_ERROR;
                                }
                            }
                            execResult = {
                                ok: false,
                                toolName: toolCall.name,
                                output: JSON.stringify({
                                    ok: false,
                                    ...(errorMsg !== EMPTY_OUTPUT_FINISH_ERROR
                                        ? { deferred: true }
                                        : {}),
                                    error: errorMsg,
                                }),
                                error: errorMsg,
                                durationMs: Math.max(0, Date.now() - stepStartedAt),
                            };
                        } else if (finishTurnSpec) {
                            const parsedFinish = parseFinishTurnArgs(
                                toolCall.arguments,
                                finishTurnSpec.definition.parameters,
                            );
                            if (!parsedFinish.ok) {
                                execResult = await registry.executeToolCall(
                                    toolCall.name,
                                    toolCall.arguments,
                                    toolCtx,
                                    {
                                        toolCallId: toolCall.id,
                                        spillStore: registry.getSpillStore() ?? this.spillStore,
                                        scopeId: `${agent.id}:${target.messageId}#${target.swipeId}`,
                                    },
                                );
                            } else if (finishTurnMode === 'main_output') {
                                execResult = {
                                    ok: false,
                                    toolName: toolCall.name,
                                    output: JSON.stringify({
                                        ok: false,
                                        error: EMPTY_OUTPUT_FINISH_ERROR,
                                    }),
                                    error: EMPTY_OUTPUT_FINISH_ERROR,
                                    durationMs: Math.max(0, Date.now() - stepStartedAt),
                                };
                            } else {
                                const sideEffectErr =
                                    'Target path(s) have not been inspected or updated yet. Call tools first before calling finish_turn.';
                                execResult = {
                                    ok: false,
                                    toolName: toolCall.name,
                                    output: JSON.stringify({
                                        ok: false,
                                        error: sideEffectErr,
                                    }),
                                    error: sideEffectErr,
                                    durationMs: Math.max(0, Date.now() - stepStartedAt),
                                };
                            }
                        } else {
                            execResult = await registry.executeToolCall(
                                toolCall.name,
                                toolCall.arguments,
                                toolCtx,
                                {
                                    toolCallId: toolCall.id,
                                    spillStore: registry.getSpillStore() ?? this.spillStore,
                                    scopeId: `${agent.id}:${target.messageId}#${target.swipeId}`,
                                },
                            );
                        }
                    } else {
                        roundNonFinishCount += 1;
                        execResult = await registry.executeToolCall(
                            toolCall.name,
                            toolCall.arguments,
                            toolCtx,
                            {
                                toolCallId: toolCall.id,
                                spillStore: registry.getSpillStore() ?? this.spillStore,
                                scopeId: `${agent.id}:${target.messageId}#${target.swipeId}`,
                            },
                        );

                        if (
                            extractor
                            && execResult.ok
                            && isOutputMutationToolCall(toolCall.name, parsedArgs)
                        ) {
                            const currentOut = await readCurrentOutputSafe();
                            extractor.markToolExecuted(currentOut);
                        }

                        if (strictToolLoop) {
                            if (READ_ONLY_TOOL_NAMES.has(toolCall.name)) {
                                const signature = buildToolCallSignature(
                                    toolCall.name,
                                    toolCall.arguments,
                                );
                                const seenCount = (readSignatureCounts.get(signature) ?? 0) + 1;
                                readSignatureCounts.set(signature, seenCount);
                                if (seenCount >= 2) {
                                    blockedReadTools.add(toolCall.name);
                                    duplicateReadWarning =
                                        `Repeated identical read-only call "${toolCall.name}" (${seenCount}x). Do not re-read the same data; proceed with writing or calling finish_turn.`;
                                } else {
                                    roundAllDuplicateReadOnly = false;
                                }
                            } else {
                                roundAllDuplicateReadOnly = false;
                                if (execResult.ok) {
                                    hasWriteToolExecuted = true;
                                    roundHadSuccessfulWrite = true;
                                }
                            }
                        }
                    }

                    throwIfAborted(signal);

                    const completedStep: ToolStepLog = {
                        stepIndex,
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: parsedArgs,
                        result: execResult.output,
                        ok: execResult.ok,
                        ...(execResult.error !== undefined ? { error: execResult.error } : {}),
                        durationMs: execResult.durationMs,
                        startedAt: stepStartedAt,
                    };
                    toolSteps.push(completedStep);

                    this.traceLogger.emit({
                        kind: 'tool_completed',
                        target: { ...target },
                        timestamp: Date.now(),
                        phase: input.phase,
                        runId,
                        agentProfileId: agent.id,
                        toolStep: canonicalClone(completedStep),
                    });
                    input.onToolComplete?.(completedStep);

                    // Append tool result (including structured self-healing errors & strict `_turn_state`)
                    const toolResultContent = strictToolLoop
                        ? decorateStrictToolResult(
                            execResult.output,
                            await buildTurnState(),
                            duplicateReadWarning,
                        )
                        : execResult.output;

                    const toolResultMsg: CanonicalMessage = {
                        role: 'tool',
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        content: toolResultContent,
                    };
                    turnMessages.push(toolResultMsg);
                    roundToolResults.push(toolResultMsg);
                }

                if (strictToolLoop) {
                    if (roundNonFinishCount > 0 && roundAllDuplicateReadOnly) {
                        consecutiveDuplicateReadOnlyRounds += 1;
                        if (consecutiveDuplicateReadOnlyRounds >= 2) {
                            shrinkToWriteAndFinish = true;
                        }
                    } else {
                        consecutiveDuplicateReadOnlyRounds = 0;
                        if (roundHadSuccessfulWrite) {
                            shrinkToWriteAndFinish = false;
                        }
                    }
                }

                // Append closed assistant(tool_calls) -> tool_results round ONLY after all calls succeed.
                completedTurnMessages.push(
                    canonicalClone(assistantToolMsg),
                    ...roundToolResults.map((msg) => canonicalClone(msg)),
                );

                if (extractor) {
                    const currentOut = await readCurrentOutputSafe();
                    extractor.resetRound(currentOut);
                }
                finishExtractor?.resetRound();

                // Re-assemble with frozen Layer 0 + frozen Layer 1 + appended inFlightMessages.
                currentAssembled = reassembleInFlight();
            }
        } catch (error) {
            if (error instanceof MaxToolRoundsError || error instanceof TurnInterruptedError) {
                throw error;
            }

            const aborted = isAbortError(error) || signal.aborted;
            const message = aborted
                ? 'Agent run aborted'
                : error instanceof Error
                    ? error.message
                    : String(error);

            if (isMainOutputMode) {
                return await salvageAndInterrupt(
                    aborted ? 'user_stop' : 'error',
                    message,
                    error,
                );
            }

            return recordFailureAndThrow(aborted, message, error);
        }
    }

    private async invokeLLM(params: {
        request: LLMRequest;
        useStream: boolean;
        target: MessageTarget;
        phase: PipelinePhase;
        runId: string;
        agentId: string;
        signal: AbortSignal;
        onTextDelta?: (delta: string) => void;
        onReasoningDelta?: (delta: string) => void;
        onToolCallDelta?: (index: number, delta: ToolCallDeltaInput) => void;
    }): Promise<{
        content: string;
        reasoningContent?: string;
        toolCalls: CanonicalToolCall[];
        usage: TokenUsage;
        finishReason?: string;
    }> {
        throwIfAborted(params.signal);

        if (!params.useStream) {
            const resp = await racePromiseWithAbort(
                this.transport.complete(params.request),
                params.signal,
                'LLM request aborted',
            );
            throwIfAborted(params.signal);
            const toolCalls = resp.toolCalls ?? [];
            if (params.onToolCallDelta && toolCalls.length > 0) {
                toolCalls.forEach((tc, idx) => {
                    params.onToolCallDelta?.(idx, {
                        name: tc.name,
                        argumentsDelta: tc.arguments,
                    });
                });
            }
            return {
                content: resp.content ?? '',
                ...(resp.reasoningContent ? { reasoningContent: resp.reasoningContent } : {}),
                toolCalls,
                usage: normalizeUsage(resp.usage),
                finishReason: resp.finishReason,
            };
        }

        let content = '';
        let reasoningContent = '';
        const toolCallMap = new Map<number, CanonicalToolCall>();
        let usage: TokenUsage = normalizeUsage();
        let finishReason: string | undefined;

        const iterator = this.transport.stream(params.request)[Symbol.asyncIterator]();
        try {
            // eslint-disable-next-line no-constant-condition
            while (true) {
                throwIfAborted(params.signal);
                const nextResult = await racePromiseWithAbort(
                    iterator.next(),
                    params.signal,
                    'LLM stream aborted',
                );
                if (nextResult.done) {
                    break;
                }
                const chunk = nextResult.value;
                throwIfAborted(params.signal);
                this.consumeStreamChunk(chunk, {
                    onText: (delta) => {
                        content += delta;
                        this.traceLogger.emit({
                            kind: 'text_delta',
                            target: { ...params.target },
                            timestamp: Date.now(),
                            phase: params.phase,
                            runId: params.runId,
                            agentProfileId: params.agentId,
                            textDelta: delta,
                        });
                        params.onTextDelta?.(delta);
                    },
                    onReasoning: (delta) => {
                        reasoningContent += delta;
                        this.traceLogger.emit({
                            kind: 'reasoning_delta',
                            target: { ...params.target },
                            timestamp: Date.now(),
                            phase: params.phase,
                            runId: params.runId,
                            agentProfileId: params.agentId,
                            reasoningDelta: delta,
                        });
                        params.onReasoningDelta?.(delta);
                    },
                    toolCallMap,
                    onToolCallDelta: params.onToolCallDelta,
                    onUsage: (u) => {
                        usage = normalizeUsage(u);
                    },
                    onDone: (reason) => {
                        if (reason) {
                            finishReason = reason;
                        }
                    },
                });
            }
        } finally {
            if (typeof iterator.return === 'function') {
                // Do not await iterator.return(): an aborted generator suspended on a hanging
                // upstream await won't advance .return() until that underlying promise settles.
                void iterator.return().catch(() => {});
            }
        }

        throwIfAborted(params.signal);

        const toolCalls = Array.from(toolCallMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, call]) => call);

        return {
            content,
            ...(reasoningContent ? { reasoningContent } : {}),
            toolCalls,
            usage,
            finishReason,
        };
    }

    private consumeStreamChunk(
        chunk: LLMStreamChunk,
        handlers: {
            onText: (delta: string) => void;
            onReasoning: (delta: string) => void;
            toolCallMap: Map<number, CanonicalToolCall>;
            onToolCallDelta?: (index: number, delta: ToolCallDeltaInput) => void;
            onUsage: (usage: TokenUsage) => void;
            onDone: (finishReason?: string) => void;
        },
    ): void {
        if (chunk.type === 'text_delta' && chunk.textDelta) {
            handlers.onText(chunk.textDelta);
            return;
        }
        if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
            handlers.onReasoning(chunk.reasoningDelta);
            return;
        }
        if (chunk.type === 'tool_call_delta') {
            const idx = chunk.toolCallIndex ?? 0;
            const existing = handlers.toolCallMap.get(idx) ?? {
                id: `call_${idx}`,
                name: '',
                arguments: '',
            };
            if (chunk.toolCallId) {
                existing.id = chunk.toolCallId;
            }
            if (chunk.toolName) {
                existing.name = chunk.toolName;
            }
            if (chunk.argumentsDelta) {
                existing.arguments += chunk.argumentsDelta;
            }
            if (chunk.thoughtSignature) {
                existing.thoughtSignature = chunk.thoughtSignature;
            }
            handlers.toolCallMap.set(idx, existing);
            handlers.onToolCallDelta?.(idx, {
                ...(chunk.toolName !== undefined ? { name: chunk.toolName } : {}),
                ...(chunk.argumentsDelta !== undefined ? { argumentsDelta: chunk.argumentsDelta } : {}),
            });
            return;
        }
        if (chunk.type === 'usage' && chunk.usage) {
            handlers.onUsage(chunk.usage);
            return;
        }
        if (chunk.type === 'done') {
            handlers.onDone(chunk.finishReason);
        }
    }

    private resolveAgent(agentInput: AgentProfile | string, preset: Preset): AgentProfile {
        if (typeof agentInput !== 'string') {
            return agentInput;
        }
        const found = preset.agents[agentInput];
        if (found) {
            return found;
        }
        if (agentInput === preset.mainAgentId) {
            return createDefaultMainAgent({ id: agentInput });
        }
        throw new Error(`AgentProfile "${agentInput}" not found in preset "${preset.name}".`);
    }

    private resolveRegexSource(
        override: RegexSource | undefined,
        preset: Preset,
    ): RegexSource | undefined {
        if (override !== undefined) {
            return override;
        }
        if (typeof this.regexProvider === 'function') {
            return this.regexProvider();
        }
        if (this.regexProvider !== undefined) {
            return this.regexProvider;
        }
        return preset.regexRules;
    }

    private async loadRawLoreEntries(): Promise<RawLoreEntry[]> {
        const books = await this.bridge.listEnabledLorebooks();
        const raw: RawLoreEntry[] = [];
        for (const [world, entries] of books.entries()) {
            for (const entry of entries) {
                raw.push(entry.world ? entry : { ...entry, world });
            }
        }
        return raw;
    }

    private snapshotRecentChat(
        target: MessageTarget,
        phase: PipelinePhase,
        windowSize?: number,
    ): ChatMessageSnapshot[] {
        const chat = this.bridge.getChat();
        if (!chat.length) {
            return [];
        }
        const limit = Math.max(0, windowSize ?? 6);
        if (limit === 0) {
            return [];
        }
        const includeTarget = phase === 'after_turn' || phase === 'maintenance';
        const eligible: ChatMessageSnapshot[] = [];
        for (const msg of chat) {
            if (msg.isSystem) {
                continue;
            }
            if (includeTarget ? msg.id > target.messageId : msg.id >= target.messageId) {
                continue;
            }
            const text =
                msg.id === target.messageId
                    ? (msg.swipes?.[target.swipeId] ?? msg.mes)
                    : msg.mes;
            if (!text?.trim()) {
                continue;
            }
            eligible.push(
                msg.id === target.messageId && text !== msg.mes
                    ? { ...msg, mes: text }
                    : msg,
            );
        }
        return eligible.slice(-(limit * 4 + 4));
    }

    private collectWorldInfoOverrides(
        target: MessageTarget,
        staged: boolean,
    ): LoreOverrideSource | undefined {
        const rows = this.store.lookup(DATA_NAMESPACES.WORLDINFO, {
            target,
            includeStaged: staged,
        });
        if (rows.length === 0) {
            return undefined;
        }
        const map = new Map<string, string>();
        for (const row of rows) {
            map.set(row.key, row.entry.content);
        }
        return map;
    }

    private async buildRunRegistry(params: {
        agent: AgentProfile;
        preset: Preset;
        loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
        extraTools?: readonly ToolDefinition[];
        subAgents?: readonly SubAgentDescriptor[];
        allowSubAgentDelegation: boolean;
        includeSubAgentTools: boolean;
        delegationDepth: number;
        parentPhase: PipelinePhase;
        target: MessageTarget;
        connection: ApiConnection;
        presetFiles: Record<string, string>;
        signal: AbortSignal;
    }): Promise<{ registry: ToolRegistry; autoAttachedToolNames: string[] }> {
        const registry = this.baseToolRegistry.clone();
        const autoAttachedToolNames: string[] = [];

        // 1. Register preset customTools allowed for this agent
        for (const custom of params.preset.customTools ?? []) {
            if (!custom.enabled) {
                continue;
            }
            if (
                custom.allowedAgents?.length
                && !custom.allowedAgents.includes(params.agent.id)
            ) {
                continue;
            }
            if (custom.kind === 'js' && !this.sandbox) {
                continue;
            }
            try {
                const compiled = await compileCustomToolConfig(custom, this.sandbox, {
                    signal: params.signal,
                });
                for (const tool of compiled) {
                    registry.register(tool, { replace: true });
                }
            } catch {
                // Skip invalid custom tools without breaking the run; logged if invoked.
            }
        }

        // 2. Register @@tool World Info entries when ScriptSandbox is available
        const rawLore = unwrapRawLoreEntries(params.loreEntries);
        if (this.sandbox) {
            for (const entry of rawLore) {
                if (entry.disable) {
                    continue;
                }
                const parsed = DecoratorParser.parseEntry(entry);
                if (!parsed.decorators.some((d) => d.name === '@@tool')) {
                    continue;
                }
                try {
                    const compiled = await compileLoreToolEntry(entry, this.sandbox, {
                        signal: params.signal,
                    });
                    for (const tool of compiled) {
                        registry.register(tool, { replace: true });
                        if (params.parentPhase === 'main_turn') {
                            autoAttachedToolNames.push(tool.name);
                        }
                    }
                } catch {
                    // Ignore malformed @@tool entry during tool compilation.
                }
            }
        }

        // 3. Register explicit extraTools
        if (params.extraTools?.length) {
            registry.registerAll(params.extraTools, { replace: true });
        }

        // 4. Register dynamic @@agent sub-agent delegation tools when within depth limit
        if (
            params.includeSubAgentTools
            && params.allowSubAgentDelegation
            && params.delegationDepth < this.maxDelegationDepth
        ) {
            const subAgents =
                params.subAgents
                ?? extractSubAgentDescriptors(params.loreEntries);

            if (subAgents.length > 0) {
                const lookupByName = new Map<string, SubAgentDescriptor>();
                for (const desc of subAgents) {
                    lookupByName.set(desc.name, desc);
                    lookupByName.set(desc.toolName, desc);
                    lookupByName.set(desc.name.toLowerCase(), desc);

                    const toolDef = this.createSubAgentTool(desc, params);
                    registry.register(toolDef, { replace: true });
                    autoAttachedToolNames.push(desc.toolName);
                }

                const callAgentTool = this.createGenericCallAgentTool(subAgents, lookupByName, params);
                registry.register(callAgentTool, { replace: true });
            }
        }

        return { registry, autoAttachedToolNames };
    }

    private createSubAgentTool(
        desc: SubAgentDescriptor,
        parentParams: {
            preset: Preset;
            loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
            target: MessageTarget;
            parentPhase: PipelinePhase;
            connection: ApiConnection;
            delegationDepth: number;
        },
    ): ToolDefinition {
        const schema = desc.paramNames.length > 0
            ? z.object(
                Object.fromEntries(
                    desc.paramNames.map((param) => [
                        param,
                        z.string().describe(`Input argument "${param}" for sub-agent "${desc.name}".`),
                    ]),
                ),
            )
            : z.object({
                task: z
                    .string()
                    .min(1)
                    .describe(`Concise research or analysis task for sub-agent "${desc.name}".`),
            });

        return {
            name: desc.toolName,
            description: desc.description,
            parameters: schema,
            source: 'agent',
            execute: async (args, ctx) => {
                throwIfAborted(ctx.signal);
                const taskPrompt = formatSubAgentTaskInput(desc, args as Record<string, unknown>);
                return await this.executeChildSubAgent({
                    desc,
                    taskPrompt,
                    ctx,
                    parentParams,
                });
            },
        };
    }

    private createGenericCallAgentTool(
        subAgents: readonly SubAgentDescriptor[],
        lookupByName: ReadonlyMap<string, SubAgentDescriptor>,
        parentParams: {
            preset: Preset;
            loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
            target: MessageTarget;
            parentPhase: PipelinePhase;
            connection: ApiConnection;
            delegationDepth: number;
        },
    ): ToolDefinition {
        const availableNames = subAgents.map((s) => s.name).join(', ');
        const schema = z.object({
            agent: z
                .string()
                .min(1)
                .describe(`Sub-agent name to invoke (${availableNames}).`),
            task: z
                .string()
                .min(1)
                .describe('Concise task or question for the sub-agent to resolve and summarize.'),
            params: z
                .record(z.string(), z.unknown())
                .optional()
                .describe('Optional named arguments when the sub-agent declares custom parameters.'),
        });

        return {
            name: 'call_agent',
            description: `Delegate an isolated sub-task to a specialized sub-agent (${availableNames}) and return its concise summary.`,
            parameters: schema,
            source: 'agent',
            execute: async (rawArgs, ctx) => {
                throwIfAborted(ctx.signal);
                const args = rawArgs as {
                    agent: string;
                    task: string;
                    params?: Record<string, unknown>;
                };
                const key = args.agent.trim();
                const desc =
                    lookupByName.get(key)
                    ?? lookupByName.get(key.toLowerCase())
                    ?? lookupByName.get(`delegate_agent_${sanitizeSubAgentToolSuffix(key)}`);

                if (!desc) {
                    return JSON.stringify({
                        ok: false,
                        error: `Unknown sub-agent "${args.agent}". Available sub-agents: ${availableNames}`,
                    });
                }

                const taskPrompt = args.params
                    ? formatSubAgentTaskInput(desc, { ...args.params, task: args.task })
                    : (desc.instructions ? `${desc.instructions}\n\nTask:\n${args.task}` : args.task);

                return await this.executeChildSubAgent({
                    desc,
                    taskPrompt,
                    ctx,
                    parentParams,
                });
            },
        };
    }

    private async executeChildSubAgent(params: {
        desc: SubAgentDescriptor;
        taskPrompt: string;
        ctx: ToolExecutionContext;
        parentParams: {
            preset: Preset;
            loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
            target: MessageTarget;
            parentPhase: PipelinePhase;
            connection: ApiConnection;
            delegationDepth: number;
        };
    }): Promise<string> {
        const { desc, taskPrompt, ctx, parentParams } = params;
        const referencedProfile = desc.presetName
            ? parentParams.preset.agents[desc.presetName]
            : parentParams.preset.agents[desc.name];

        const childProfile: AgentProfile = referencedProfile
            ? {
                ...canonicalClone(referencedProfile),
                id: referencedProfile.id,
                sessionMode: 'ephemeral',
                ephemeralWindowSize: 0,
            }
            : {
                id: `subagent_${sanitizeSubAgentToolSuffix(desc.name)}`,
                name: desc.name,
                connectionId: parentParams.connection.id,
                sessionMode: 'ephemeral',
                ephemeralWindowSize: 0,
                promptBlocks: [
                    {
                        id: 'subagent_system',
                        name: `${desc.name} Instructions`,
                        role: 'system',
                        placement: 'prefix',
                        content:
                            'You are an isolated specialist sub-agent. Use read-only VFS tools to inspect relevant files and return a concise, factual summary for the parent agent.',
                        enabled: true,
                    },
                ],
                enabledTools: [...DEFAULT_SUBAGENT_TOOLS],
                permissions: { read: ['/**'], write: [] },
                maxToolRounds: 0,
                description: desc.description,
            };

        try {
            const childResult = await this.runInternal({
                agent: childProfile,
                preset: parentParams.preset,
                target: parentParams.target,
                phase: parentParams.parentPhase,
                promptTriggerContext: { kind: 'subagent', phase: parentParams.parentPhase },
                userInput: taskPrompt,
                loreEntries: parentParams.loreEntries,
                includeCategory4DynamicEntries: false,
                runTailRadar: false,
                includeRecentChat: false,
                includeSubAgentTools: false,
                allowSubAgentDelegation: false,
                delegationDepth: parentParams.delegationDepth + 1,
                staged: false,
                stream: false,
                signal: ctx.signal,
            });

            const summary = childResult.content.trim();
            return summary || `Sub-agent "${desc.name}" completed with an empty response.`;
        } catch (error) {
            if (isAbortError(error) || ctx.signal.aborted) {
                throw error instanceof Error && isAbortError(error) ? error : createAbortError();
            }
            const msg = error instanceof Error ? error.message : String(error);
            return JSON.stringify({
                ok: false,
                agent: desc.name,
                error: msg,
            });
        }
    }

    private resolveEnabledToolNames(
        baseTools: readonly string[],
        autoAttached: readonly string[],
        preset: Preset,
    ): string[] {
        const merged = new Set<string>(baseTools);
        for (const name of autoAttached) {
            const override = preset.builtinToolSettings?.[name];
            if (override && override.enabled === false) {
                continue;
            }
            merged.add(name);
        }
        return Array.from(merged);
    }
}

function racePromiseWithAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    message: string,
): Promise<T> {
    if (signal.aborted) {
        return Promise.reject(
            signal.reason instanceof Error && isAbortError(signal.reason)
                ? signal.reason
                : createAbortError(message),
        );
    }

    return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
            reject(
                signal.reason instanceof Error && isAbortError(signal.reason)
                    ? signal.reason
                    : createAbortError(message),
            );
        };
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(
            (val) => {
                signal.removeEventListener('abort', onAbort);
                resolve(val);
            },
            (err) => {
                signal.removeEventListener('abort', onAbort);
                reject(err);
            },
        );
    });
}

export type { RegexRule };
