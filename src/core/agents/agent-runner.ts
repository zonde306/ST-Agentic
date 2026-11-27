import { z } from 'zod';
import type {
    EjsRenderSession,
    HostBridge,
    LLMRequest,
    LLMStreamChunk,
    LLMToolChoice,
    LLMTransport,
    OutputProcessOperation,
    OutputProcessResult,
    PromptInjectionSession,
    ToolEditOperation,
    ToolEventPayload,
    ToolExecutionContext,
    ToolPostprocessAction,
    ToolPostprocessControl,
    ToolPostprocessOutput,
    ToolSideGenApi,
} from '@/core/bridge';
import {
    DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS,
    formatOutputFixFeedback,
    runOutputProcess,
} from '@/core/bridge';
import {
    createDefaultMainAgent,
    createDefaultSettings,
    matchesPromptTriggers,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import {
    applyOutletsToCanonicalMessages,
    buildLayer2MacroOverrides,
    buildMainSurfaceMacroOverrides,
    buildStaticAutoPromptMacroOverrides,
    buildWorkspaceNotices,
    computeLayer0StaticFingerprint,
    ContextAssembler,
    DEFAULT_FOLD_THRESHOLD_CHARS,
    doesFrozenPrefixMatch,
    estimateMessageTokens,
    estimateRequestTokens,
    prerenderPromptBlocks,
    refreshNonCacheableInFlightMessages,
    resolveEffectiveContextBudget,
    resolveTrajectoryLayer1Messages,
    shouldFloatTailPromptBlocks,
    TrajectoryStore,
    transformToolResultBeforeSend,
    TransientToolSpillStore,
    WatermarkCompactor,
    type InterruptedPreviousRoundSnapshot,
    type InterruptedTurnCheckpoint,
    type RegexSource,
    type TrajectoryMessageTransformState,
} from '@/core/context';
import {
    computeRoundRetryDelayMs,
    createEphemeralMessagesController,
    delayWithAbort,
    isLengthFinishReason,
    isRetryableRoundError,
    isValidJsonObjectString,
    LLMTransportError,
    parseContextOverflowError,
    ROUND_RETRY_ERROR_CODES,
    sanitizeToolCallPairs,
    type ContextOverflowInfo,
    type EphemeralMessagesController,
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
    AssistantRoundLog,
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
    RoundRetryLog,
    ScopedPermissions,
    Settings,
    TokenUsage,
    ToolStepLog,
    WICategory,
} from '@/core/types';
import { canonicalClone, canonicalStringify, normalizeVfsPath } from '@/core/utils';
import {
    applyTextEdits,
    OUTPUT_FILE_PATH,
    resolveEditOperations,
    VirtualFileSystem,
} from '@/core/vfs';
import {
    FinishTurnStreamExtractor,
    IncrementalOutputStreamExtractor,
    type ToolCallDeltaInput,
} from './output-stream-extractor';

export const FINISH_TURN_TOOL_NAME = 'finish_turn';
const FINISH_TURN_DESCRIPTION = 'Complete the current turn and submit the final result.';
let agentRunSandboxSeq = 0;

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

const DEFAULT_EMPTY_INPUT_CONTINUATION_PROMPT =
    '[System Notice] The user sent an empty message to advance the scene. Continue the story naturally in a new response and write it to /output.md.';

export const DEFAULT_MAX_ERROR_RECOVERY_ATTEMPTS = 2;

const PREFLIGHT_FOLDED_TOOL_PREFIX = '[已折叠本轮早期工具输出:';
const OVERFLOW_CROPPED_TOOL_PREFIX = '[输出因触发模型上下文上限';

const LIKELY_REFUSAL_RE =
    /^(?:(?:i(?:'m|\s+am)\s+sorry|sorry|apologies)[,.\s!]*)?(?:i\s+(?:can(?:'t|not)|am\s+unable\s+to|won't|will\s+not|must\s+decline)|as\s+an\s+ai|抱歉|对不起|很抱歉|作为(?:一个)?(?:ai|人工智能)|我(?:无法|不能|不便)(?:满足|协助|完成|生成|继续|回答|提供|执行))/i;

type FinishTurnMode = 'main_output' | 'side_effect' | 'return_value';

export interface EphemeralMessageLayerIndices {
    layer0End: number;
    layer1End: number;
    turnStart: number;
    floatingTailStart: number;
}

export interface AgentPreprocessMessagesContext {
    target: MessageTarget;
    phase: PipelinePhase;
    runId: string;
    agentId: string;
    agentName: string;
    triggerId?: string;
    round: number;
    attempt: number;
    maxRetries: number;
    promptTriggerContext: PromptTriggerContext;
    messages: EphemeralMessagesController;
    body: Record<string, unknown>;
    layers: EphemeralMessageLayerIndices;
    request: LLMRequest;
    connection: ApiConnection;
    vars: Record<string, unknown>;
    signal: AbortSignal;
    toolContext: ToolExecutionContext;
}

export interface AgentPostprocessOutput extends ToolPostprocessOutput {
    text: string;
    content: string;
    reasoningContent?: string;
    toolCalls: CanonicalToolCall[];
    readonly originalText: string;
    readonly round: number;
    readonly fixAttempt: number;
    readonly maxFixAttempts: number;
}

export interface AgentPostprocessResponseContext {
    target: MessageTarget;
    phase: PipelinePhase;
    runId: string;
    agentId: string;
    agentName: string;
    triggerId?: string;
    round: number;
    attempt: number;
    maxRetries: number;
    fixAttempt: number;
    maxFixAttempts: number;
    promptTriggerContext: PromptTriggerContext;
    output: AgentPostprocessOutput;
    control: ToolPostprocessControl;
    connection: ApiConnection;
    vars: Record<string, unknown>;
    signal: AbortSignal;
    toolContext: ToolExecutionContext;
}

export interface AgentGenerationErrorInfo {
    readonly name: string;
    readonly message: string;
    readonly status?: number;
    readonly code?: string;
    readonly rawBody?: string;
}

export interface AgentGenerationErrorHookContext {
    readonly target: MessageTarget;
    readonly phase: PipelinePhase;
    readonly runId: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly triggerId?: string;
    readonly round: number;
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly error: AgentGenerationErrorInfo;
    readonly rawError: unknown;
    readonly ephemeralMessages: EphemeralMessagesController;
    readonly layers: EphemeralMessageLayerIndices;
    readonly connection: Readonly<ApiConnection>;
    readonly signal: AbortSignal;
    readonly toolContext: ToolExecutionContext;
}

export type AgentGenerationErrorDecision =
    | {
          action: 'retry';
          reason?: string;
          delayMs?: number;
          messages?: CanonicalMessage[];
          rollbackToolRounds?: number;
          dropHistoryTurns?: number;
          connectionId?: string;
          temperature?: number;
          maxTokens?: number;
      }
    | {
          action: 'abort';
          reason?: string;
      }
    | {
          action: 'pass';
          reason?: string;
      };

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
    public readonly checkpoint?: InterruptedTurnCheckpoint;

    constructor(
        message: string,
        trace: AgentRunTrace,
        causeError?: unknown,
        checkpoint?: InterruptedTurnCheckpoint,
    ) {
        super(message, causeError !== undefined ? { cause: causeError } : undefined);
        this.name = 'AgentExecutionError';
        this.trace = trace;
        if (checkpoint !== undefined) {
            this.checkpoint = checkpoint;
        }
    }
}

export class MaxToolRoundsError extends AgentExecutionError {
    public readonly maxToolRounds: number;

    constructor(
        maxToolRounds: number,
        trace: AgentRunTrace,
        checkpoint?: InterruptedTurnCheckpoint,
    ) {
        super(
            `Agent "${trace.agentName}" exceeded maxToolRounds (${maxToolRounds}).`,
            trace,
            undefined,
            checkpoint,
        );
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
    onPreprocessMessages?: (ctx: AgentPreprocessMessagesContext) => Promise<void> | void;
    onPostprocessResponse?: (ctx: AgentPostprocessResponseContext) => Promise<void> | void;
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
    triggerSource?: 'preset' | 'worldinfo';
    lorebookNames?: readonly string[];
    /** Optional background task identifier propagated onto recorded `AgentRunTrace.taskId`. */
    taskId?: string;
    /** Recursion guard preventing nested error-recovery hooks when running a recovery agent. */
    isErrorRecovery?: boolean;
    /** Explicit composite checkpoint scope (`phase`, `triggerId`) for interrupted turn persistence. */
    checkpointScope?: { phase: PipelinePhase; triggerId?: string };
    /** Optional per-run `ScriptSandbox` override (falls back to `AgentRunnerDependencies.sandbox`). */
    sandbox?: ScriptSandbox;
    /** Optional external pre-send messages hook (e.g. `@@script on=prompt_preprocess`). */
    onPreprocessMessages?: (ctx: AgentPreprocessMessagesContext) => Promise<void> | void;
    /** Optional external post-response hook (e.g. `@@script on=output_postprocess`). */
    onPostprocessResponse?: (ctx: AgentPostprocessResponseContext) => Promise<void> | void;
    /** Optional generation-error recovery hook invoked when retries are exhausted or non-retryable. */
    onGenerationError?: (
        ctx: AgentGenerationErrorHookContext,
    ) => Promise<AgentGenerationErrorDecision | void> | AgentGenerationErrorDecision | void;
    /** Max recovery attempts via `onGenerationError` per run (default 2, 0 disables). */
    maxErrorRecoveryAttempts?: number;
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
    /** Isolated per-turn `injectPrompt` / `getPromptsInjected` session shared across phases. */
    injectionSession?: PromptInjectionSession;
    /** Internal recursion guard for nested `@@agent` delegation. */
    delegationDepth?: number;
    onTextDelta?: (delta: string) => void;
    onOutputPreview?: (previewText: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolStart?: (step: ToolStepLog) => void;
    onToolComplete?: (step: ToolStepLog) => void;
    onRetrying?: (info: RoundRetryLog) => void;
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
        if (
            error.code === ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY
            && error.message.trim()
        ) {
            return `${error.code}: ${error.message.trim()}`;
        }
        return error.code;
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message.trim();
    }
    return String(error);
}

function simulateOutputMutationCandidate(
    toolCallName: string,
    parsedArgs: Record<string, unknown> | string,
    existingOutput: string,
): { operation: OutputProcessOperation; candidateText: string } | null {
    if (typeof parsedArgs !== 'object' || parsedArgs === null) {
        return null;
    }
    if (toolCallName === 'write_file' && typeof parsedArgs.content === 'string') {
        return {
            operation: 'write_file',
            candidateText: parsedArgs.content,
        };
    }
    if (toolCallName === 'append_file' && typeof parsedArgs.content === 'string') {
        return {
            operation: 'append_file',
            candidateText: `${existingOutput}${parsedArgs.content}`,
        };
    }
    if (toolCallName === 'replace_reply_view' && typeof parsedArgs.text === 'string') {
        return {
            operation: 'replace_reply_view',
            candidateText: parsedArgs.text,
        };
    }
    if (toolCallName === 'append_reply_view' && typeof parsedArgs.text === 'string') {
        const text = parsedArgs.text;
        const candidateText = !existingOutput
            ? text
            : existingOutput.endsWith('\n') || text.startsWith('\n')
                ? `${existingOutput}${text}`
                : `${existingOutput}\n${text}`;
        return {
            operation: 'append_reply_view',
            candidateText,
        };
    }
    if (toolCallName === 'edit_file') {
        const rawEdits = Array.isArray(parsedArgs.edits) ? parsedArgs.edits : undefined;
        const mappedEdits: ToolEditOperation[] | undefined = rawEdits
            ? rawEdits
                .filter((item): item is Record<string, unknown> =>
                    Boolean(item && typeof item === 'object'))
                .map((op) => ({
                    search: typeof op.search === 'string' ? op.search : '',
                    replace: typeof op.replace === 'string' ? op.replace : '',
                    ...(typeof op.start_line === 'number' ? { startLine: op.start_line } : {}),
                    ...(typeof op.end_line === 'number' ? { endLine: op.end_line } : {}),
                    ...(typeof op.replace_all === 'boolean' ? { replaceAll: op.replace_all } : {}),
                }))
            : undefined;
        const ops = mappedEdits && mappedEdits.length > 0
            ? mappedEdits
            : typeof parsedArgs.search === 'string' && typeof parsedArgs.replace === 'string'
                ? resolveEditOperations(parsedArgs.search, parsedArgs.replace, {
                    ...(typeof parsedArgs.start_line === 'number'
                        ? { startLine: parsedArgs.start_line }
                        : {}),
                    ...(typeof parsedArgs.end_line === 'number'
                        ? { endLine: parsedArgs.end_line }
                        : {}),
                    ...(typeof parsedArgs.replace_all === 'boolean'
                        ? { replaceAll: parsedArgs.replace_all }
                        : {}),
                })
                : [];
        if (ops.length === 0) {
            return null;
        }
        const preview = applyTextEdits({
            path: OUTPUT_FILE_PATH,
            content: existingOutput,
            edits: ops,
        });
        if (!preview.ok || preview.updatedContent === undefined) {
            return null;
        }
        return {
            operation: 'edit_file',
            candidateText: preview.updatedContent,
        };
    }
    return null;
}

function attachValidationWarningToToolOutput(output: string, warning: string): string {
    try {
        const parsed = JSON.parse(output) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return JSON.stringify({
                ...(parsed as Record<string, unknown>),
                validationWarning: warning,
            });
        }
    } catch {
        // Fallback to text append if tool output is not a JSON object.
    }
    return `${output}\n${warning}`;
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

function summarizeToolBatch(toolCalls: readonly CanonicalToolCall[]): string {
    const parts = toolCalls.map((tc) => {
        const parsed = parseArgsForLog(tc.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const hintKey = (['path', 'query', 'command', 'key', 'agent'] as const).find(
                (k) => typeof parsed[k] === 'string' && String(parsed[k]).trim().length > 0,
            );
            if (hintKey) {
                const rawVal = String(parsed[hintKey]).trim();
                const shortVal = rawVal.length > 48 ? `${rawVal.slice(0, 45)}...` : rawVal;
                return `${tc.name}(${shortVal})`;
            }
        }
        return tc.name;
    });
    return parts.join(', ');
}

function buildMainOutputFinishSummary(
    stepBrief: string,
    roundContent: string,
): string | undefined {
    const cleanBrief = stepBrief.trim();
    const cleanContent = roundContent.trim();
    if (cleanBrief && cleanContent) {
        return cleanBrief === cleanContent ? cleanBrief : `${cleanBrief}\n\n${cleanContent}`;
    }
    return cleanBrief || cleanContent || undefined;
}

function buildSideEffectFinishSummary(
    statusText: string,
    stepBrief: string,
): string | undefined {
    const cleanStatus = statusText.trim();
    const cleanBrief = stepBrief.trim();
    if (cleanStatus && cleanBrief) {
        return cleanStatus === cleanBrief ? cleanStatus : `${cleanStatus}\n${cleanBrief}`;
    }
    return cleanStatus || cleanBrief || undefined;
}

function extractGenerationErrorInfo(error: unknown): AgentGenerationErrorInfo {
    if (error instanceof LLMTransportError) {
        return Object.freeze({
            name: error.name || 'LLMTransportError',
            message: error.message || 'LLM transport error',
            ...(error.status !== undefined ? { status: error.status } : {}),
            ...(error.code !== undefined ? { code: error.code } : {}),
            ...(error.responseBody !== undefined ? { rawBody: error.responseBody } : {}),
        });
    }
    if (error instanceof Error) {
        const rec = error as unknown as Record<string, unknown>;
        const status =
            typeof rec.status === 'number' && Number.isFinite(rec.status)
                ? rec.status
                : typeof rec.statusCode === 'number' && Number.isFinite(rec.statusCode)
                    ? rec.statusCode
                    : undefined;
        const code =
            typeof rec.code === 'string' && rec.code.trim().length > 0
                ? rec.code.trim()
                : undefined;
        const rawBody =
            typeof rec.responseBody === 'string'
                ? rec.responseBody
                : typeof rec.rawBody === 'string'
                    ? rec.rawBody
                    : undefined;
        return Object.freeze({
            name: error.name || 'Error',
            message: error.message || String(error),
            ...(status !== undefined ? { status } : {}),
            ...(code !== undefined ? { code } : {}),
            ...(rawBody !== undefined ? { rawBody } : {}),
        });
    }
    return Object.freeze({
        name: 'Error',
        message: String(error),
    });
}

function createPostprocessControl(): ToolPostprocessControl {
    const state: {
        action: ToolPostprocessAction;
        retryReason?: string;
        fixMessage?: string;
        rejectWrite: boolean;
        abortReason?: string;
    } = {
        action: 'accept',
        rejectWrite: false,
    };

    const normalizeMsg = (val: unknown): string | undefined => {
        if (typeof val !== 'string') {
            return undefined;
        }
        const trimmed = val.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    };

    return {
        retry(reason?: string): void {
            if (state.action === 'abort') {
                return;
            }
            state.action = 'retry';
            state.retryReason = normalizeMsg(reason) ?? state.retryReason;
        },
        requestFix(message: string, options?: { rejectWrite?: boolean }): void {
            if (state.action === 'abort' || state.action === 'retry') {
                return;
            }
            state.action = 'fix';
            state.fixMessage =
                normalizeMsg(message) ?? 'Response postprocess requested a revision.';
            if (options?.rejectWrite === true) {
                state.rejectWrite = true;
            }
        },
        accept(): void {
            // Monotonic: cannot downgrade an already escalated fix/retry/abort action.
        },
        abort(reason?: string): void {
            state.action = 'abort';
            state.abortReason =
                normalizeMsg(reason) ?? 'Response postprocess aborted generation.';
        },
        get action(): ToolPostprocessAction {
            return state.action;
        },
        get retryReason(): string | undefined {
            return state.retryReason;
        },
        get fixMessage(): string | undefined {
            return state.fixMessage;
        },
        get rejectWrite(): boolean {
            return state.rejectWrite;
        },
        get abortReason(): string | undefined {
            return state.abortReason;
        },
    };
}

function normalizePostprocessToolCalls(raw: unknown): CanonicalToolCall[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const result: CanonicalToolCall[] = [];
    for (let idx = 0; idx < raw.length; idx += 1) {
        const item = raw[idx];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }
        const rec = item as Record<string, unknown>;
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!name) {
            continue;
        }
        const rawId = typeof rec.id === 'string' ? rec.id.trim() : '';
        const id = rawId || `call_${idx}`;
        const argsStr =
            typeof rec.arguments === 'string'
                ? rec.arguments
                : JSON.stringify(rec.arguments ?? {});
        result.push({
            id,
            name,
            arguments: argsStr,
            ...(typeof rec.thoughtSignature === 'string'
                ? { thoughtSignature: rec.thoughtSignature }
                : {}),
            ...(rec.extraFields && typeof rec.extraFields === 'object' && !Array.isArray(rec.extraFields)
                ? { extraFields: canonicalClone(rec.extraFields as Record<string, unknown>) }
                : {}),
        });
    }
    return result;
}

const PREPROCESS_STANDARD_BODY_KEYS = new Set<string>([
    'model',
    'temperature',
    'max_tokens',
    'maxTokens',
    'top_p',
    'topP',
    'top_k',
    'topK',
    'frequency_penalty',
    'frequencyPenalty',
    'presence_penalty',
    'presencePenalty',
    'stream',
]);

function buildPreprocessWorkingBody(
    connection: ApiConnection,
    stream: boolean,
): {
    workingBody: Record<string, unknown>;
    baselineBody: Record<string, unknown>;
    baseIncludeKeys: Set<string>;
} {
    const baseIncludeBody =
        connection.includeBody
        && typeof connection.includeBody === 'object'
        && !Array.isArray(connection.includeBody)
            ? canonicalClone(connection.includeBody)
            : {};
    const baseIncludeKeys = new Set(Object.keys(baseIncludeBody));
    const workingBody: Record<string, unknown> = {
        ...baseIncludeBody,
        model: connection.model,
        temperature: connection.temperature,
        max_tokens: connection.maxTokens,
        top_p: connection.topP,
        top_k: connection.topK,
        frequency_penalty: connection.frequencyPenalty,
        presence_penalty: connection.presencePenalty,
        stream,
    };
    return {
        workingBody,
        baselineBody: canonicalClone(workingBody),
        baseIncludeKeys,
    };
}

function applyPreprocessBodyOverrides(
    connection: ApiConnection,
    stream: boolean,
    workingBody: Record<string, unknown>,
    baselineBody: Record<string, unknown>,
    baseIncludeKeys: ReadonlySet<string>,
): { connection: ApiConnection; stream: boolean; changed: boolean } {
    if (canonicalStringify(workingBody) === canonicalStringify(baselineBody)) {
        return { connection, stream, changed: false };
    }

    const nextConnection = canonicalClone(connection);
    let nextStream = stream;

    if (typeof workingBody.model === 'string' && workingBody.model.trim().length > 0 && workingBody.model !== baselineBody.model) {
        nextConnection.model = workingBody.model.trim();
    }
    if (typeof workingBody.temperature === 'number' && Number.isFinite(workingBody.temperature) && workingBody.temperature !== baselineBody.temperature) {
        nextConnection.temperature = workingBody.temperature;
    }
    const nextMaxTokens =
        typeof workingBody.maxTokens === 'number' && Number.isFinite(workingBody.maxTokens) && workingBody.maxTokens > 0
            ? workingBody.maxTokens
            : typeof workingBody.max_tokens === 'number' && Number.isFinite(workingBody.max_tokens) && workingBody.max_tokens > 0 && workingBody.max_tokens !== baselineBody.max_tokens
                ? workingBody.max_tokens
                : undefined;
    if (nextMaxTokens !== undefined) {
        nextConnection.maxTokens = Math.floor(nextMaxTokens);
    }
    const nextTopP =
        typeof workingBody.topP === 'number' && Number.isFinite(workingBody.topP)
            ? workingBody.topP
            : typeof workingBody.top_p === 'number' && Number.isFinite(workingBody.top_p) && workingBody.top_p !== baselineBody.top_p
                ? workingBody.top_p
                : undefined;
    if (nextTopP !== undefined) {
        nextConnection.topP = nextTopP;
    }
    const nextTopK =
        typeof workingBody.topK === 'number' && Number.isFinite(workingBody.topK)
            ? workingBody.topK
            : typeof workingBody.top_k === 'number' && Number.isFinite(workingBody.top_k) && workingBody.top_k !== baselineBody.top_k
                ? workingBody.top_k
                : undefined;
    if (nextTopK !== undefined) {
        nextConnection.topK = nextTopK;
    }
    const nextFreqPenalty =
        typeof workingBody.frequencyPenalty === 'number' && Number.isFinite(workingBody.frequencyPenalty)
            ? workingBody.frequencyPenalty
            : typeof workingBody.frequency_penalty === 'number' && Number.isFinite(workingBody.frequency_penalty) && workingBody.frequency_penalty !== baselineBody.frequency_penalty
                ? workingBody.frequency_penalty
                : undefined;
    if (nextFreqPenalty !== undefined) {
        nextConnection.frequencyPenalty = nextFreqPenalty;
    }
    const nextPresPenalty =
        typeof workingBody.presencePenalty === 'number' && Number.isFinite(workingBody.presencePenalty)
            ? workingBody.presencePenalty
            : typeof workingBody.presence_penalty === 'number' && Number.isFinite(workingBody.presence_penalty) && workingBody.presence_penalty !== baselineBody.presence_penalty
                ? workingBody.presence_penalty
                : undefined;
    if (nextPresPenalty !== undefined) {
        nextConnection.presencePenalty = nextPresPenalty;
    }
    if (typeof workingBody.stream === 'boolean' && workingBody.stream !== baselineBody.stream) {
        nextStream = workingBody.stream;
        nextConnection.stream = workingBody.stream;
    }

    const nextIncludeBody: Record<string, unknown> =
        nextConnection.includeBody
        && typeof nextConnection.includeBody === 'object'
        && !Array.isArray(nextConnection.includeBody)
            ? canonicalClone(nextConnection.includeBody)
            : {};

    for (const key of baseIncludeKeys) {
        if (!PREPROCESS_STANDARD_BODY_KEYS.has(key) && !(key in workingBody)) {
            delete nextIncludeBody[key];
        }
    }
    for (const [key, val] of Object.entries(workingBody)) {
        if (PREPROCESS_STANDARD_BODY_KEYS.has(key) || val === undefined) {
            continue;
        }
        nextIncludeBody[key] = canonicalClone(val);
    }
    nextConnection.includeBody = nextIncludeBody;

    return { connection: nextConnection, stream: nextStream, changed: true };
}

function rollbackTrailingToolRoundsInArray(
    messages: CanonicalMessage[],
    count: number,
    transformStates?: Array<TrajectoryMessageTransformState | undefined>,
): number {
    const target = Math.max(0, Math.floor(count));
    let removed = 0;
    for (let step = 0; step < target; step += 1) {
        let assistantIdx = -1;
        for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
            const msg = messages[idx];
            if (msg.role === 'assistant' && Array.isArray(msg.toolCalls) && msg.toolCalls.length > 0) {
                assistantIdx = idx;
                break;
            }
        }
        if (assistantIdx < 0) {
            break;
        }
        let endIdx = assistantIdx + 1;
        while (endIdx < messages.length && messages[endIdx].role === 'tool') {
            endIdx += 1;
        }
        const removeCount = endIdx - assistantIdx;
        messages.splice(assistantIdx, removeCount);
        if (transformStates) {
            transformStates.splice(assistantIdx, removeCount);
        }
        removed += 1;
    }
    return removed;
}

function isEmptyUserInputValue(
    userInput: string | CanonicalContentPart[] | undefined,
): boolean {
    if (userInput === undefined) {
        return true;
    }
    if (typeof userInput === 'string') {
        return userInput.trim().length === 0;
    }
    if (Array.isArray(userInput)) {
        if (userInput.length === 0) {
            return true;
        }
        return userInput.every(
            (part) => part.type === 'text' && part.text.trim().length === 0,
        );
    }
    return false;
}

function resolveEmptyInputTrailingAssistantFallback(params: {
    input: AgentRunInput;
    target: MessageTarget;
    agent: AgentProfile;
    bridge: HostBridge;
    trajectoryStore: TrajectoryStore;
}): string | CanonicalContentPart[] | undefined {
    const { input, target, agent, bridge, trajectoryStore } = params;
    const action = input.generationAction ?? 'normal';
    if (
        input.phase !== 'main_turn'
        || action !== 'normal'
        || input.resumeMessages !== undefined
        || !isEmptyUserInputValue(input.userInput)
    ) {
        return input.userInput;
    }

    const chat = bridge.getChat();
    let prevNonSystemMsg: ChatMessageSnapshot | undefined;
    if (Array.isArray(chat) && chat.length > 0) {
        const startIdx = Math.min(chat.length - 1, target.messageId - 1);
        for (let i = startIdx; i >= 0; i -= 1) {
            const candidate = chat[i];
            if (candidate && !candidate.isSystem) {
                prevNonSystemMsg = candidate;
                break;
            }
        }
        if (
            !prevNonSystemMsg
            && target.messageId === 0
            && chat[0]
            && !chat[0].isSystem
            && !chat[0].isUser
            && chat[0].mes.trim().length > 0
        ) {
            prevNonSystemMsg = chat[0];
        }
    }

    let trailingIsNonUser = false;
    if (prevNonSystemMsg) {
        trailingIsNonUser = !prevNonSystemMsg.isUser;
    } else if (agent.sessionMode === 'persistent') {
        const layer1 = trajectoryStore.getMessages(agent.id);
        const lastLayer1 = layer1[layer1.length - 1];
        if (lastLayer1 && lastLayer1.role === 'assistant') {
            trailingIsNonUser = true;
        }
    }

    if (!trailingIsNonUser) {
        return input.userInput;
    }

    const hostSendIfEmpty = bridge.getSendIfEmpty?.()?.trim() ?? '';
    return hostSendIfEmpty || DEFAULT_EMPTY_INPUT_CONTINUATION_PROMPT;
}

function clampLayerIndex(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampLayerIndices(
    layers: EphemeralMessageLayerIndices,
    length: number,
): EphemeralMessageLayerIndices {
    const layer0End = clampLayerIndex(layers.layer0End, 0, length);
    const layer1End = clampLayerIndex(layers.layer1End, layer0End, length);
    const turnStart = clampLayerIndex(layers.turnStart, layer1End, length);
    const floatingTailStart = clampLayerIndex(layers.floatingTailStart, turnStart, length);
    return { layer0End, layer1End, turnStart, floatingTailStart };
}

function createLayerTrackingEphemeralController(
    messages: readonly CanonicalMessage[],
    initialLayers: EphemeralMessageLayerIndices,
): {
    controller: EphemeralMessagesController;
    getLayers(): EphemeralMessageLayerIndices;
    getRolledBackRounds(): number;
    getDroppedHistoryTurns(): number;
    wasMutated(): boolean;
} {
    const clampedInit = clampLayerIndices(initialLayers, messages.length);
    const base = createEphemeralMessagesController(messages, clampedInit);
    let layers = { ...clampedInit };
    let rolledBackRounds = 0;
    let droppedHistoryTurns = 0;
    let mutated = false;

    const controller: EphemeralMessagesController = {
        list: () => base.list(),
        set: (next) => {
            mutated = true;
            base.set(next);
            layers = clampLayerIndices(layers, base.list().length);
        },
        rollbackToolRounds: (count) => {
            const beforeLen = base.list().length;
            const rolled = base.rollbackToolRounds(count);
            if (rolled > 0) {
                const afterLen = base.list().length;
                const removedCount = Math.max(0, beforeLen - afterLen);
                rolledBackRounds += rolled;
                mutated = true;
                layers = clampLayerIndices(
                    {
                        ...layers,
                        floatingTailStart: Math.max(
                            layers.turnStart,
                            layers.floatingTailStart - removedCount,
                        ),
                    },
                    afterLen,
                );
            }
            return rolled;
        },
        dropHistoryTurns: (count, opts) => {
            const beforeLen = base.list().length;
            const dropped = base.dropHistoryTurns(count, opts);
            if (dropped > 0) {
                const afterLen = base.list().length;
                const removedCount = Math.max(0, beforeLen - afterLen);
                droppedHistoryTurns += dropped;
                mutated = true;
                const nextLayer1End = Math.max(layers.layer0End, layers.layer1End - removedCount);
                const nextTurnStart = Math.max(nextLayer1End, layers.turnStart - removedCount);
                const nextFloatingStart = Math.max(
                    nextTurnStart,
                    layers.floatingTailStart - removedCount,
                );
                layers = clampLayerIndices(
                    {
                        layer0End: layers.layer0End,
                        layer1End: nextLayer1End,
                        turnStart: nextTurnStart,
                        floatingTailStart: nextFloatingStart,
                    },
                    afterLen,
                );
            }
            return dropped;
        },
        replaceContent: (selector, replacer) => {
            const replaced = base.replaceContent(selector, replacer);
            if (replaced > 0) {
                mutated = true;
            }
            return replaced;
        },
        appendHint: (content, role) => {
            mutated = true;
            base.appendHint(content, role);
        },
        toMessages: () => {
            const sanitized = base.toMessages();
            layers = clampLayerIndices(layers, sanitized.length);
            return sanitized;
        },
    };

    return {
        controller,
        getLayers: () => ({ ...layers }),
        getRolledBackRounds: () => rolledBackRounds,
        getDroppedHistoryTurns: () => droppedHistoryTurns,
        wasMutated: () => mutated,
    };
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
    private readonly onPreprocessMessages?: (
        ctx: AgentPreprocessMessagesContext,
    ) => Promise<void> | void;
    private readonly onPostprocessResponse?: (
        ctx: AgentPostprocessResponseContext,
    ) => Promise<void> | void;
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
        this.onPreprocessMessages = deps.onPreprocessMessages;
        this.onPostprocessResponse = deps.onPostprocessResponse;

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
        const runSandboxIds: string[] = [];
        const effectiveSandbox = input.sandbox ?? this.sandbox;
        try {
            return await this.runInternal(input, runSandboxIds, effectiveSandbox);
        } finally {
            if (effectiveSandbox?.dispose) {
                for (const sbId of runSandboxIds) {
                    effectiveSandbox.dispose(sbId);
                }
            }
        }
    }

    private async runInternal(
        input: AgentRunInput,
        runSandboxIds: string[],
        effectiveSandbox?: ScriptSandbox,
    ): Promise<AgentRunResult> {
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

        const runSandboxScope = `${runId}_s${++agentRunSandboxSeq}`;
        const normalizedLorebookNames = input.lorebookNames
            ? Array.from(new Set(input.lorebookNames.map((n) => n.trim()).filter(Boolean)))
            : [];

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
            lorebookNames: normalizedLorebookNames,
            target,
            connection,
            presetFiles: preset.files,
            sandbox: effectiveSandbox,
            sandboxScope: runSandboxScope,
            createdSandboxIds: runSandboxIds,
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

        const maxRoundRetries = Math.max(0, Math.floor(connection.roundMaxRetries ?? 2));
        const maxErrorRecoveryAttempts = Math.max(
            0,
            Math.floor(input.maxErrorRecoveryAttempts ?? DEFAULT_MAX_ERROR_RECOVERY_ATTEMPTS),
        );
        const effectiveOnPreprocess = input.onPreprocessMessages ?? this.onPreprocessMessages;
        const effectiveOnPostprocess = input.onPostprocessResponse ?? this.onPostprocessResponse;
        const resolvedCheckpointPhase: PipelinePhase = input.checkpointScope?.phase ?? input.phase;
        const resolvedCheckpointTriggerId: string | undefined =
            input.checkpointScope?.triggerId ?? input.triggerId;
        const effectiveUserInput = resolveEmptyInputTrailingAssistantFallback({
            input,
            target,
            agent: effectiveAgent,
            bridge: this.bridge,
            trajectoryStore: this.trajectoryStore,
        });

        const toolSteps: ToolStepLog[] = [];
        const assistantRounds: AssistantRoundLog[] = [];
        let activeAssistantRound: AssistantRoundLog | null = null;
        let previousRoundSnapshot: InterruptedPreviousRoundSnapshot | undefined;
        const retryEvents: RoundRetryLog[] = [];
        const buildTraceRetryFields = () => ({
            retryCount: retryEvents.length,
            roundMaxRetries: maxRoundRetries,
            ...(retryEvents.length > 0 ? { retryEvents: canonicalClone(retryEvents) } : {}),
        });
        const getSnapshotAssistantRounds = (): AssistantRoundLog[] => {
            const list = assistantRounds.map((r) => canonicalClone(r));
            if (
                activeAssistantRound
                && ((activeAssistantRound.reasoning && activeAssistantRound.reasoning.length > 0)
                    || (activeAssistantRound.content && activeAssistantRound.content.length > 0)
                    || activeAssistantRound.isFinishTurn)
            ) {
                list.push(canonicalClone(activeAssistantRound));
            }
            return list;
        };
        const lockAssistantRound = (params: {
            roundIndex: number;
            beforeStepIndex: number;
            timestamp: number;
            reasoning?: string;
            content?: string;
            isFinishTurn?: boolean;
            finishTurnSummary?: string;
        }): void => {
            const cleanReasoning = params.reasoning && params.reasoning.length > 0 ? params.reasoning : undefined;
            const cleanContent = params.content && params.content.length > 0 ? params.content : undefined;
            const cleanSummary =
                params.finishTurnSummary && params.finishTurnSummary.trim().length > 0
                    ? params.finishTurnSummary
                    : undefined;
            if (cleanReasoning || cleanContent || params.isFinishTurn) {
                assistantRounds.push({
                    roundIndex: params.roundIndex,
                    beforeStepIndex: params.beforeStepIndex,
                    ...(cleanReasoning ? { reasoning: cleanReasoning } : {}),
                    ...(cleanContent ? { content: cleanContent } : {}),
                    ...(params.isFinishTurn !== undefined ? { isFinishTurn: params.isFinishTurn } : {}),
                    ...(cleanSummary ? { finishTurnSummary: cleanSummary } : {}),
                    timestamp: params.timestamp,
                });
            }
            activeAssistantRound = null;
        };
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
        let lastOutputPreview = '';
        let activeToolStep: ToolStepLog | null = null;
        let roundsCompleted = 0;

        const traceTriggerMeta = {
            ...(input.triggerId ? { triggerId: input.triggerId } : {}),
            ...(input.triggerLabel ? { triggerLabel: input.triggerLabel } : {}),
            ...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
            ...(normalizedLorebookNames.length > 0 ? { lorebookNames: normalizedLorebookNames } : {}),
            ...(input.taskId ? { taskId: input.taskId } : {}),
        };
        const hasRollbackableRoundNow = (): boolean =>
            Boolean(previousRoundSnapshot && toolSteps.length > 0);

        const publishRunningTrace = (now = Date.now()): void => {
            const liveSteps = activeToolStep ? [...toolSteps, activeToolStep] : toolSteps;
            const previewSource = lastOutputPreview || lastContent || lastReasoning;
            this.traceLogger.recordTrace(
                {
                    runId,
                    target: { ...target },
                    phase: input.phase,
                    agentProfileId: agent.id,
                    agentName: agent.name,
                    ...traceTriggerMeta,
                    connectionId: connection.id,
                    model: connection.model,
                    status: 'running',
                    startedAt,
                    durationMs: Math.max(0, now - startedAt),
                    usage: { ...cumulativeUsage },
                    toolSteps: canonicalClone(liveSteps),
                    assistantRounds: getSnapshotAssistantRounds(),
                    hasRollbackableRound: hasRollbackableRoundNow(),
                    ...buildTraceRetryFields(),
                    ...(previewSource ? { outputPreview: previewSource.slice(0, 240) } : {}),
                    ...(lastRequestSnapshot ? { requestSnapshot: lastRequestSnapshot } : {}),
                },
                true,
            );
        };

        this.traceLogger.emit({
            kind: 'phase_started',
            target: { ...target },
            timestamp: startedAt,
            phase: input.phase,
            runId,
            agentProfileId: agent.id,
        });

        publishRunningTrace(startedAt);

        const canEditFiles = canonicalTools.some((tool) => tool.name === 'edit_file');
        const toolCtx = createToolExecutionContext({
            bridge: this.bridge,
            vfs: this.vfs,
            store: this.store,
            ...(this.sideGen ? { sideGen: this.sideGen } : {}),
            target,
            signal,
            permissions,
            canEditFiles,
            agentId: effectiveAgent.id,
            phase: input.phase,
            readSet: effectiveReadSet,
            spillStore: registry.getSpillStore() ?? this.spillStore,
            staged,
            source: `agent:${agent.id}`,
            getVariableSchema: input.getVariableSchema,
        });
        const toolGuard = toolCtx.fs as { canWrite?: (path: string) => boolean };
        const canWritePath = (path: string): boolean =>
            typeof toolGuard.canWrite === 'function' ? toolGuard.canWrite(path) : false;
        const canEditPath = (path: string): boolean => canEditFiles && canWritePath(path);
        const transformSessionBag: Record<string, unknown> = {};

        const loreOverrides = this.collectWorldInfoOverrides(target, staged);
        const initialOutput = isMainOutputMode
            ? await this.vfs.readFile(OUTPUT_FILE_PATH, { target, staged }).catch(() => '')
            : '';
        const extractor = isMainOutputMode
            ? new IncrementalOutputStreamExtractor({
                initialOutput,
                onPreview: (fullText) => {
                    lastOutputPreview = fullText;
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
        const turnTransformStates: Array<TrajectoryMessageTransformState | undefined> =
            input.resumeMessages
                ? input.resumeMessages.map(() => ({ cached: true }))
                : [];
        const completedTurnMessages: CanonicalMessage[] = input.resumeMessages
            ? canonicalClone([...input.resumeMessages])
            : [];
        let bestSalvageableOutput: string | null = null;

        const buildInterruptedCheckpoint = (
            reason: InterruptedReason,
            errorMessage: string,
            createdAt: number,
        ): InterruptedTurnCheckpoint => {
            const snapshotCompleted = canonicalClone(completedTurnMessages);
            if (snapshotCompleted.length === 0 && effectiveUserInput !== undefined) {
                snapshotCompleted.push({
                    role: 'user',
                    content: canonicalClone(effectiveUserInput),
                    ...(input.userName ? { name: input.userName } : {}),
                });
            }
            return {
                agentId: agent.id,
                target: { messageId: target.messageId, swipeId: target.swipeId },
                reason,
                errorMessage,
                phase: resolvedCheckpointPhase,
                ...(resolvedCheckpointTriggerId ? { triggerId: resolvedCheckpointTriggerId } : {}),
                runId,
                completedTurnMessages: snapshotCompleted,
                readSetSnapshot: Object.fromEntries(effectiveReadSet.entries()),
                stagedSnapshot: this.store.snapshotStagedData(target),
                ...(previousRoundSnapshot && toolSteps.length > 0
                    ? { previousRoundSnapshot: canonicalClone(previousRoundSnapshot) }
                    : {}),
                createdAt,
            };
        };

        const recordFailureAndThrow = (
            aborted: boolean,
            message: string,
            originalError?: unknown,
        ): never => {
            const endedAt = Date.now();
            const hasPhaseProgress =
                !isMainOutputMode
                && (toolSteps.length > 0 || input.resumeMessages !== undefined);
            let savedCheckpoint: InterruptedTurnCheckpoint | undefined;
            if (hasPhaseProgress) {
                savedCheckpoint = buildInterruptedCheckpoint(
                    aborted ? 'user_stop' : 'error',
                    message,
                    endedAt,
                );
                this.trajectoryStore.saveInterruptedCheckpoint(savedCheckpoint);
            }

            const failTrace = this.traceLogger.recordTrace(
                {
                    runId,
                    target: { ...target },
                    phase: input.phase,
                    agentProfileId: agent.id,
                    agentName: agent.name,
                    ...traceTriggerMeta,
                    connectionId: connection.id,
                    model: connection.model,
                    status: aborted ? 'aborted' : 'error',
                    startedAt,
                    endedAt,
                    durationMs: Math.max(0, endedAt - startedAt),
                    usage: cumulativeUsage,
                    toolSteps: canonicalClone(toolSteps),
                    assistantRounds: getSnapshotAssistantRounds(),
                    hasRollbackableRound: hasRollbackableRoundNow(),
                    ...buildTraceRetryFields(),
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
            throw new AgentExecutionError(message, failTrace, originalError, savedCheckpoint);
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
                    emitRenderEvent: true,
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
                    ...traceTriggerMeta,
                    connectionId: connection.id,
                    model: connection.model,
                    status: 'interrupted',
                    interruptedReason: reason,
                    startedAt,
                    endedAt,
                    durationMs: Math.max(0, endedAt - startedAt),
                    usage: cumulativeUsage,
                    toolSteps: canonicalClone(toolSteps),
                    assistantRounds: getSnapshotAssistantRounds(),
                    hasRollbackableRound: hasRollbackableRoundNow(),
                    ...buildTraceRetryFields(),
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

            const checkpoint = buildInterruptedCheckpoint(reason, resolvedErrorMessage, endedAt);
            this.trajectoryStore.saveInterruptedCheckpoint(checkpoint);

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

            const contextBudget = resolveEffectiveContextBudget(
                connection,
                agent.watermark ? { configuredWatermark: agent.watermark } : undefined,
            );
            const fallbackTriggerOverrides: Record<string, string> | undefined =
                promptTriggerContext.kind === 'trigger'
                    ? {
                          triggerLabel: input.triggerLabel ?? '',
                          triggerId:
                              input.triggerId
                              ?? (promptTriggerContext.triggerIds?.join(',') ?? ''),
                          triggerPhase: promptTriggerContext.phase,
                          triggerTargetPath: promptTriggerContext.targetPaths?.join(',') ?? '',
                      }
                    : undefined;
            const effectiveMacroOverrides = buildMainSurfaceMacroOverrides({
                bridge: this.bridge,
                userInput: effectiveUserInput,
                connection,
                budget: contextBudget,
                callerOverrides:
                    fallbackTriggerOverrides || input.macroOverrides
                        ? {
                              ...(fallbackTriggerOverrides ?? {}),
                              ...(input.macroOverrides ?? {}),
                          }
                        : undefined,
            });

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
                && promptTriggerContext !== undefined
                && promptTriggerContext.kind !== 'main'
                && hasTriggerScopedBlocks;
            const staticPrefixFp = computeLayer0StaticFingerprint({
                agent: effectiveAgent,
                tools: canonicalTools,
                presetFiles: preset.files,
                systemBasePrompt: input.systemBasePrompt,
                promptTriggerContext,
            });
            const willUseFrozenPrefix =
                isPersistent
                && !input.forceRecompilePrefix
                && !isNonMainTriggerRun
                && doesFrozenPrefixMatch(
                    this.trajectoryStore.getFrozenPrefix(effectiveAgent.id),
                    staticPrefixFp,
                );

            let preRenderedBlocks: Map<string, CanonicalMessage[]> | undefined;
            if (input.resumeMessages !== undefined) {
                const resumeAutoMacroOverrides = buildStaticAutoPromptMacroOverrides({
                    agent: effectiveAgent,
                    systemBasePrompt: input.systemBasePrompt,
                    promptTriggerContext,
                    characterFields,
                    personaDescription,
                    loreEntries,
                    wiRouterOverrides: preset.wiRouterOverrides,
                    presetFiles: preset.files,
                    hostBridge: this.bridge,
                    macroOverrides: effectiveMacroOverrides,
                });
                const resumePreRenderMacroOverrides = buildLayer2MacroOverrides(workingVars, {
                    ...effectiveMacroOverrides,
                    ...resumeAutoMacroOverrides,
                });
                const resumeEjsSession: EjsRenderSession = {};
                const rawMetaVars = this.bridge.getMetadata()?.variables;
                const resumeVars: Record<string, unknown> = {
                    ...(rawMetaVars && typeof rawMetaVars === 'object' && !Array.isArray(rawMetaVars)
                        ? (rawMetaVars as Record<string, unknown>)
                        : {}),
                    ...workingVars,
                };
                if (input.injectionSession) {
                    input.injectionSession.setForceOutlet(true);
                }
                try {
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
                                macroOverrides: resumePreRenderMacroOverrides,
                                vars: resumeVars,
                                injectionSession: input.injectionSession,
                                ejsSession: resumeEjsSession,
                                transformSessionId: runId,
                                transformAgentId: effectiveAgent.id,
                                transformPhase: input.phase,
                                transformTarget: target,
                                transformSessionBag,
                                transformLayer: 'layer0_prefix',
                                onVariablesMutated: (updates) => {
                                    Object.assign(resumeVars, updates);
                                },
                            });
                            throwIfAborted(signal);
                        }
                    }

                    const floatTailBlocks = shouldFloatTailPromptBlocks(promptTriggerContext);
                    const floatingTailBlocksToRender = promptBlocks.filter(
                        (block) =>
                            block.enabled
                            && (block.placement === 'floating_tail'
                                || (floatTailBlocks && block.placement === 'tail'))
                            && block.content.trim().length > 0
                            && matchesPromptTriggers(block.triggers, promptTriggerContext),
                    );
                    if (floatingTailBlocksToRender.length > 0) {
                        const renderedFloating = await prerenderPromptBlocks(floatingTailBlocksToRender, {
                            hostBridge: this.bridge,
                            macroOverrides: resumePreRenderMacroOverrides,
                            vars: resumeVars,
                            injectionSession: input.injectionSession,
                            ejsSession: resumeEjsSession,
                            transformSessionId: runId,
                            transformAgentId: effectiveAgent.id,
                            transformPhase: input.phase,
                            transformTarget: target,
                            transformSessionBag,
                            transformLayer: 'layer2_floating',
                            onVariablesMutated: (updates) => {
                                Object.assign(resumeVars, updates);
                            },
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
                } finally {
                    if (input.injectionSession) {
                        input.injectionSession.setForceOutlet(false);
                    }
                }

                if (preRenderedBlocks && input.injectionSession) {
                    const promptBlockById = new Map(promptBlocks.map((b) => [b.id, b]));
                    for (const [blockId, msgs] of preRenderedBlocks.entries()) {
                        preRenderedBlocks.set(
                            blockId,
                            applyOutletsToCanonicalMessages(msgs, input.injectionSession, {
                                dropEmptyTextMessages: promptBlockById.get(blockId)?.role !== 'custom',
                            }),
                        );
                    }
                }
            }

            const baseAssembleInput: {
                agent: AgentProfile;
                connectionId: string;
                tools: CanonicalToolSchema[];
                characterFields: Record<string, string>;
                personaDescription: string;
                loreEntries: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
                wiRouterOverrides: Record<string, WICategory>;
                presetFiles: Record<string, string>;
                systemBasePrompt?: string;
                promptTriggerContext: PromptTriggerContext;
                preRenderedBlocks?: ReadonlyMap<string, CanonicalMessage[]>;
                preRenderedSystemRules?: readonly string[];
                trajectoryStore?: TrajectoryStore;
                overrideLayer1Messages?: readonly CanonicalMessage[];
                recentChatMessages?: readonly (CanonicalMessage | ChatMessageSnapshot)[];
                hostBridge: HostBridge;
                regex?: RegexSource;
                vars: Record<string, unknown>;
                macroOverrides?: Record<string, string>;
                signal: AbortSignal;
            } = {
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
                macroOverrides: effectiveMacroOverrides,
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
                    userInput: effectiveUserInput,
                    userName: input.userName,
                    turnBrief: input.turnBrief,
                    dynamicReminders: input.dynamicReminders,
                    includeCategory4DynamicEntries:
                        input.includeCategory4DynamicEntries ?? (input.phase === 'main_turn'),
                    loreHint: input.loreHint,
                    runTailRadar: input.runTailRadar ?? (input.phase === 'main_turn'),
                    target,
                    tailRadar: this.tailRadar,
                    ...(input.injectionSession ? { injectionSession: input.injectionSession } : {}),
                    ...(workspaceNotices.noticeXml ? { workspaceNotice: workspaceNotices.noticeXml } : {}),
                    ...(isMainTurnRoot ? { vfs: this.vfs } : {}),
                    transformSessionId: runId,
                    transformPhase: input.phase,
                    transformSessionBag,
                    canEditPath,
                    canWritePath,
                });

            if (currentAssembled.preRenderedBlocks) {
                baseAssembleInput.preRenderedBlocks = new Map(currentAssembled.preRenderedBlocks);
            }
            if (currentAssembled.preRenderedSystemRules !== undefined) {
                baseAssembleInput.preRenderedSystemRules = currentAssembled.preRenderedSystemRules;
            }
            if (currentAssembled.effectiveMacroOverrides) {
                baseAssembleInput.macroOverrides = currentAssembled.effectiveMacroOverrides;
            }
            if (currentAssembled.transformedRecentChatMessages) {
                activeRecentChatMessages = [...currentAssembled.transformedRecentChatMessages];
            }
            if (currentAssembled.overrideLayer1Messages !== undefined) {
                baseAssembleInput.overrideLayer1Messages = currentAssembled.overrideLayer1Messages;
            }
            const nonCacheableFloatingBlockIds = new Set(
                currentAssembled.nonCacheableFloatingBlockIds ?? [],
            );

            const consumedSideBriefPaths =
                input.resumeMessages === undefined && isMainTurnRoot
                    ? [...currentAssembled.consumedSideBriefPaths]
                    : [];

            // Sync read-time overrides into TailRadar if needed (already handled by loreReadEvaluator.getOverride).
            void loreOverrides;

            if (input.resumeMessages === undefined) {
                const initialLayer2 = canonicalClone(currentAssembled.layer2Messages);
                const startIdx = turnMessages.length;
                turnMessages.push(...initialLayer2);
                for (let i = 0; i < initialLayer2.length; i += 1) {
                    turnTransformStates.push(
                        i === 0 && currentAssembled.userInputTransformState
                            ? currentAssembled.userInputTransformState
                            : { cached: true },
                    );
                }
                void startIdx;
                completedTurnMessages.push(...canonicalClone(initialLayer2));
            }

            const reassembleInFlight = () =>
                this.contextAssembler.assemble({
                    ...baseAssembleInput,
                    recentChatMessages: activeRecentChatMessages,
                    inFlightMessages: turnMessages,
                });

            const refreshFloatingAndReassembleInFlight = async () => {
                if (this.bridge.transformPromptText) {
                    const rawMetaVars = this.bridge.getMetadata()?.variables;
                    const roundVars: Record<string, unknown> = {
                        ...(rawMetaVars && typeof rawMetaVars === 'object' && !Array.isArray(rawMetaVars)
                            ? (rawMetaVars as Record<string, unknown>)
                            : {}),
                        ...workingVars,
                    };
                    await refreshNonCacheableInFlightMessages({
                        bridge: this.bridge,
                        messages: turnMessages,
                        states: turnTransformStates,
                        sessionId: runId,
                        agentId: agent.id,
                        phase: input.phase,
                        target,
                        vars: roundVars,
                        sessionBag: transformSessionBag,
                        signal,
                    });
                }
                if (nonCacheableFloatingBlockIds.size > 0) {
                    const floatTailBlocks = shouldFloatTailPromptBlocks(promptTriggerContext);
                    const blocksToRefresh = (effectiveAgent.promptBlocks ?? []).filter(
                        (b) =>
                            b.enabled
                            && nonCacheableFloatingBlockIds.has(b.id)
                            && (b.placement === 'floating_tail'
                                || (floatTailBlocks && b.placement === 'tail'))
                            && b.content.trim().length > 0
                            && matchesPromptTriggers(b.triggers, promptTriggerContext),
                    );
                    if (blocksToRefresh.length > 0) {
                        const rawMetaVars = this.bridge.getMetadata()?.variables;
                        const roundVars: Record<string, unknown> = {
                            ...(rawMetaVars && typeof rawMetaVars === 'object' && !Array.isArray(rawMetaVars)
                                ? (rawMetaVars as Record<string, unknown>)
                                : {}),
                            ...workingVars,
                        };
                        const roundMacroOverrides = buildLayer2MacroOverrides(
                            roundVars,
                            baseAssembleInput.macroOverrides,
                        );
                        const refreshed = await prerenderPromptBlocks(blocksToRefresh, {
                            hostBridge: this.bridge,
                            macroOverrides: roundMacroOverrides,
                            vars: roundVars,
                            injectionSession: input.injectionSession,
                            transformSessionId: runId,
                            transformAgentId: effectiveAgent.id,
                            transformPhase: input.phase,
                            transformTarget: target,
                            transformSessionBag,
                            transformLayer: 'layer2_floating',
                            signal,
                        });
                        const nextPreRendered = new Map(baseAssembleInput.preRenderedBlocks ?? []);
                        const blockById = new Map(blocksToRefresh.map((b) => [b.id, b]));
                        for (const [blockId, msgs] of refreshed.entries()) {
                            nextPreRendered.set(
                                blockId,
                                input.injectionSession
                                    ? applyOutletsToCanonicalMessages(msgs, input.injectionSession, {
                                        dropEmptyTextMessages: blockById.get(blockId)?.role !== 'custom',
                                    })
                                    : msgs,
                            );
                        }
                        baseAssembleInput.preRenderedBlocks = nextPreRendered;
                    }
                }
                return reassembleInFlight();
            };

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
                    if (result.compacted) {
                        if (this.bridge.transformPromptText) {
                            baseAssembleInput.overrideLayer1Messages = await resolveTrajectoryLayer1Messages({
                                bridge: this.bridge,
                                trajectoryStore: this.trajectoryStore,
                                threadId: agent.id,
                                sessionId: runId,
                                agentId: agent.id,
                                phase: input.phase,
                                target,
                                defaultIsChatMessage:
                                    promptTriggerContext === undefined
                                    || promptTriggerContext.kind === 'main',
                                vars: workingVars,
                                sessionBag: transformSessionBag,
                                signal,
                            });
                        } else {
                            delete baseAssembleInput.overrideLayer1Messages;
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
            let toolRoundsExecuted = 0;
            let emptyOutputRetried = false;
            let overflowRecoveryAttempted = false;
            let outputFixAttempts = 0;
            let postprocessFixAttempts = 0;
            let errorRecoveryAttemptsUsed = 0;
            const maxOutputFixAttempts = DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS;
            const maxPostprocessFixAttempts = DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS;
            const outputSessionBag: Record<string, unknown> = {};
            const outputSessionId = runId;

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
                assistantSummary?: string;
            }): Promise<AgentRunResult> => {
                activeAssistantRound = null;
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
                        turnTransformStates,
                        finalAssistantMessage: {
                            role: 'assistant',
                            content: params.persistedAssistantContent,
                            ...(params.reasoningContent
                                ? { reasoningContent: params.reasoningContent }
                                : {}),
                        },
                        finalAssistantTransformState: this.bridge.transformPromptText
                            ? {
                                  cached: false,
                                  rawContent: params.persistedAssistantContent,
                                  meta: {
                                      source: 'chat_message',
                                      isChatMessage: isMainOutputMode,
                                      messageId: target.messageId,
                                      swipeId: target.swipeId,
                                      name: this.bridge.getActiveIdentity().charName,
                                      isUser: false,
                                  },
                              }
                            : { cached: true },
                        regex,
                    });
                }

                if (input.resumeMessages !== undefined) {
                    this.trajectoryStore.clearInterruptedCheckpoint(target, {
                        phase: resolvedCheckpointPhase,
                        triggerId: resolvedCheckpointTriggerId,
                    });
                }

                const cleanSummary =
                    params.assistantSummary && params.assistantSummary.trim().length > 0
                        ? params.assistantSummary
                        : undefined;
                const endedAt = Date.now();
                const finalTrace = this.traceLogger.recordTrace(
                    {
                        runId,
                        target: { ...target },
                        phase: input.phase,
                        agentProfileId: agent.id,
                        agentName: agent.name,
                        ...traceTriggerMeta,
                        connectionId: connection.id,
                        model: connection.model,
                        status: 'completed',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: cumulativeUsage,
                        toolSteps: canonicalClone(toolSteps),
                        assistantRounds: getSnapshotAssistantRounds(),
                        ...(cleanSummary
                            ? { assistantSummary: cleanSummary, outputPreview: cleanSummary }
                            : {}),
                        hasRollbackableRound: hasRollbackableRoundNow(),
                        ...buildTraceRetryFields(),
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
                const hasAnyProgress =
                    toolSteps.length > 0
                    || input.resumeMessages !== undefined
                    || this.store.hasPending(target);
                let savedCheckpoint: InterruptedTurnCheckpoint | undefined;
                if (hasAnyProgress) {
                    savedCheckpoint = buildInterruptedCheckpoint('error', errorMessage, endedAt);
                    this.trajectoryStore.saveInterruptedCheckpoint(savedCheckpoint);
                }
                const errorTrace = this.traceLogger.recordTrace(
                    {
                        runId,
                        target: { ...target },
                        phase: input.phase,
                        agentProfileId: agent.id,
                        agentName: agent.name,
                        ...traceTriggerMeta,
                        connectionId: connection.id,
                        model: connection.model,
                        status: 'error',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: cumulativeUsage,
                        toolSteps: canonicalClone(toolSteps),
                        assistantRounds: getSnapshotAssistantRounds(),
                        hasRollbackableRound: hasRollbackableRoundNow(),
                        ...buildTraceRetryFields(),
                        ...(lastContent ? { outputPreview: lastContent.slice(0, 240) } : {}),
                        ...(lastReasoning && !lastContent
                            ? { outputPreview: lastReasoning.slice(0, 240) }
                            : {}),
                        error: errorMessage,
                        requestSnapshot: lastRequestSnapshot,
                    },
                    true,
                );
                throw new MaxToolRoundsError(maxToolRounds, errorTrace, savedCheckpoint);
            };

            // eslint-disable-next-line no-constant-condition
            while (true) {
                throwIfAborted(signal);

                await runPreflightBudgetGuard();

                const roundIndexForTurn = roundsCompleted;
                const beforeStepIndexForTurn = toolSteps.length;
                const roundStartedAt = Date.now();
                const roundToolChoice = await computeRoundToolChoice();
                let roundRetriesUsed = 0;
                let pendingPostprocessFixFeedback: string | undefined;
                let pendingRecoveryOverride:
                    | {
                          messages?: CanonicalMessage[];
                          layers?: EphemeralMessageLayerIndices;
                          connection?: ApiConnection;
                      }
                    | undefined;

                interface OutputMutationDirective {
                    toolCallId: string;
                    operation: OutputProcessOperation;
                    result: OutputProcessResult;
                    fixCounted: boolean;
                }
                let pendingMutationDirectives = new Map<string, OutputMutationDirective>();
                let pendingTurnFinishOutcome: {
                    operation: 'finish_turn' | 'plain_finish';
                    result: OutputProcessResult;
                } | undefined;

                const peekPrefillPrefix = (): string => {
                    const trailingTurnMsg = turnMessages[turnMessages.length - 1];
                    if (isPrefillAssistantMessage(trailingTurnMsg)) {
                        return extractMessageText(trailingTurnMsg.content);
                    }
                    const lastFloatingMsg =
                        currentAssembled.floatingTailMessages[
                            currentAssembled.floatingTailMessages.length - 1
                        ];
                    if (isPrefillAssistantMessage(lastFloatingMsg)) {
                        return extractMessageText(lastFloatingMsg.content);
                    }
                    return '';
                };
                let nonStrictRefusalRetried = false;
                let turnOutput: Awaited<ReturnType<AgentRunner['invokeLLM']>>;

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    throwIfAborted(signal);

                    const recoveryOverride = pendingRecoveryOverride;
                    pendingRecoveryOverride = undefined;
                    let attemptConnection = recoveryOverride?.connection ?? connection;
                    let attemptMessages = recoveryOverride?.messages
                        ? canonicalClone(recoveryOverride.messages)
                        : canonicalClone(currentAssembled.request.messages);
                    let attemptStream = input.stream ?? attemptConnection.stream ?? true;

                    const rawLayer0End = currentAssembled.layer0Messages.length;
                    const rawLayer1End = rawLayer0End + currentAssembled.layer1Messages.length;
                    const rawFloatingStart = rawLayer1End + currentAssembled.layer2Messages.length;
                    const baseLayers: EphemeralMessageLayerIndices = recoveryOverride?.layers
                        ? clampLayerIndices(recoveryOverride.layers, attemptMessages.length)
                        : clampLayerIndices(
                            {
                                layer0End: rawLayer0End,
                                layer1End: rawLayer1End,
                                turnStart: rawLayer1End,
                                floatingTailStart: rawFloatingStart,
                            },
                            attemptMessages.length,
                        );
                    let attemptLayers: EphemeralMessageLayerIndices = { ...baseLayers };

                    let llmRequest: LLMRequest = {
                        ...currentAssembled.request,
                        messages: attemptMessages,
                        connectionId: attemptConnection.id,
                        connection: attemptConnection,
                        ...(roundToolChoice ? { toolChoice: roundToolChoice } : {}),
                        stream: attemptStream,
                        signal,
                    };

                    const presetPreprocess = preset.preprocessScript;
                    const shouldRunPresetPreprocess = Boolean(
                        effectiveSandbox
                        && presetPreprocess?.enabled
                        && presetPreprocess.code.trim().length > 0
                        && matchesPromptTriggers(presetPreprocess.triggers, promptTriggerContext),
                    );
                    const shouldRunCallbackPreprocess = typeof effectiveOnPreprocess === 'function';

                    if (shouldRunPresetPreprocess || shouldRunCallbackPreprocess) {
                        const preprocessTracker = createLayerTrackingEphemeralController(
                            attemptMessages,
                            attemptLayers,
                        );
                        const preprocessController = preprocessTracker.controller;
                        const { workingBody, baselineBody, baseIncludeKeys } =
                            buildPreprocessWorkingBody(attemptConnection, attemptStream);
                        const preprocessEvent: ToolEventPayload = {
                            type: 'prompt_preprocess',
                            timestamp: Date.now(),
                            target: { ...target },
                            phase: input.phase,
                            runId,
                            agentId: agent.id,
                            ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                            round: roundIndexForTurn + 1,
                            attempt: roundRetriesUsed,
                            maxAttempts: maxRoundRetries,
                            messageId: target.messageId,
                            swipeId: target.swipeId,
                            data: {
                                layers: { ...attemptLayers },
                                model: attemptConnection.model,
                                connectionId: attemptConnection.id,
                            },
                        };
                        const preprocessToolCtx: ToolExecutionContext = {
                            ...toolCtx,
                            messages: preprocessController,
                            body: workingBody,
                            event: preprocessEvent,
                        };

                        if (shouldRunPresetPreprocess && effectiveSandbox && presetPreprocess) {
                            await effectiveSandbox.evaluateScript(
                                presetPreprocess.code,
                                preprocessToolCtx,
                                {
                                    id: `${runSandboxScope}:preprocess:r${roundIndexForTurn + 1}:a${roundRetriesUsed}`,
                                    signal,
                                },
                            );
                            throwIfAborted(signal);
                        }

                        if (shouldRunCallbackPreprocess && effectiveOnPreprocess) {
                            await effectiveOnPreprocess({
                                target: { ...target },
                                phase: input.phase,
                                runId,
                                agentId: agent.id,
                                agentName: agent.name,
                                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                round: roundIndexForTurn + 1,
                                attempt: roundRetriesUsed,
                                maxRetries: maxRoundRetries,
                                promptTriggerContext,
                                messages: preprocessController,
                                body: workingBody,
                                layers: preprocessTracker.getLayers(),
                                request: llmRequest,
                                connection: attemptConnection,
                                vars: workingVars,
                                signal,
                                toolContext: preprocessToolCtx,
                            });
                            throwIfAborted(signal);
                        }

                        attemptMessages = preprocessController.toMessages();
                        attemptLayers = preprocessTracker.getLayers();
                        const bodyApplied = applyPreprocessBodyOverrides(
                            attemptConnection,
                            attemptStream,
                            workingBody,
                            baselineBody,
                            baseIncludeKeys,
                        );
                        attemptConnection = bodyApplied.connection;
                        attemptStream = bodyApplied.stream;
                        const clampedBreakpoints = llmRequest.cacheBreakpoints?.filter(
                            (bp) => bp >= 0 && bp < attemptMessages.length,
                        );
                        llmRequest = {
                            ...llmRequest,
                            messages: attemptMessages,
                            connectionId: attemptConnection.id,
                            connection: attemptConnection,
                            stream: attemptStream,
                            ...(clampedBreakpoints && clampedBreakpoints.length > 0
                                ? { cacheBreakpoints: clampedBreakpoints }
                                : { cacheBreakpoints: undefined }),
                        };
                    } else if (recoveryOverride?.messages && llmRequest.cacheBreakpoints) {
                        const clampedBreakpoints = llmRequest.cacheBreakpoints.filter(
                            (bp) => bp >= 0 && bp < attemptMessages.length,
                        );
                        llmRequest = {
                            ...llmRequest,
                            ...(clampedBreakpoints.length > 0
                                ? { cacheBreakpoints: clampedBreakpoints }
                                : { cacheBreakpoints: undefined }),
                        };
                    }

                    const lastSentMessages = canonicalClone(llmRequest.messages);
                    const lastSentLayers = { ...attemptLayers };

                    lastRequestSnapshot = {
                        messages: canonicalClone(llmRequest.messages),
                        tools: canonicalClone(llmRequest.tools),
                        ...(llmRequest.cacheBreakpoints
                            ? { cacheBreakpoints: [...llmRequest.cacheBreakpoints] }
                            : {}),
                    };
                    activeAssistantRound = {
                        roundIndex: roundIndexForTurn,
                        beforeStepIndex: beforeStepIndexForTurn,
                        timestamp: Date.now(),
                    };
                    publishRunningTrace();

                    const onToolCallDelta =
                        extractor || finishExtractor
                            ? (idx: number, delta: ToolCallDeltaInput) => {
                                extractor?.feedToolCallDelta(idx, delta);
                                finishExtractor?.feedToolCallDelta(idx, delta);
                            }
                            : undefined;

                    let lastAttemptDiag:
                        | {
                              finishReason?: string;
                              outputTokens?: number;
                              hasReasoning?: boolean;
                          }
                        | undefined;
                    pendingPostprocessFixFeedback = undefined;

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
                            onInternalTextDelta: (delta) => {
                                if (activeAssistantRound) {
                                    activeAssistantRound.content = `${activeAssistantRound.content ?? ''}${delta}`;
                                    publishRunningTrace();
                                }
                            },
                            onInternalReasoningDelta: (delta) => {
                                if (activeAssistantRound) {
                                    activeAssistantRound.reasoning = `${activeAssistantRound.reasoning ?? ''}${delta}`;
                                    publishRunningTrace();
                                }
                            },
                            onToolCallDelta,
                        });

                        if (activeAssistantRound) {
                            if (turnOutput.reasoningContent) {
                                activeAssistantRound.reasoning = turnOutput.reasoningContent;
                            }
                            if (turnOutput.content) {
                                activeAssistantRound.content = turnOutput.content;
                            }
                        }

                        const presetPostprocess = preset.postprocessScript;
                        const shouldRunPresetPostprocess = Boolean(
                            effectiveSandbox
                            && presetPostprocess?.enabled
                            && presetPostprocess.code.trim().length > 0
                            && matchesPromptTriggers(presetPostprocess.triggers, promptTriggerContext),
                        );
                        const shouldRunCallbackPostprocess =
                            typeof effectiveOnPostprocess === 'function';

                        if (
                            (shouldRunPresetPostprocess || shouldRunCallbackPostprocess)
                            && !(isMainOutputMode && isLengthFinishReason(turnOutput.finishReason))
                        ) {
                            const origContent = turnOutput.content ?? '';
                            const postOutput: AgentPostprocessOutput = {
                                text: origContent,
                                content: origContent,
                                ...(turnOutput.reasoningContent !== undefined
                                    ? { reasoningContent: turnOutput.reasoningContent }
                                    : {}),
                                toolCalls: canonicalClone(turnOutput.toolCalls),
                                originalText: origContent,
                                round: roundIndexForTurn + 1,
                                fixAttempt: postprocessFixAttempts,
                                maxFixAttempts: maxPostprocessFixAttempts,
                            };
                            const postControl = createPostprocessControl();
                            const postEvent: ToolEventPayload = {
                                type: 'output_postprocess',
                                timestamp: Date.now(),
                                target: { ...target },
                                phase: input.phase,
                                runId,
                                agentId: agent.id,
                                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                round: roundIndexForTurn + 1,
                                attempt: roundRetriesUsed,
                                maxAttempts: maxRoundRetries,
                                output: origContent,
                                messageId: target.messageId,
                                swipeId: target.swipeId,
                                data: {
                                    content: origContent,
                                    ...(turnOutput.reasoningContent !== undefined
                                        ? { reasoningContent: turnOutput.reasoningContent }
                                        : {}),
                                    toolCalls: canonicalClone(turnOutput.toolCalls),
                                    ...(turnOutput.finishReason
                                        ? { finishReason: turnOutput.finishReason }
                                        : {}),
                                },
                            };
                            const postToolCtx: ToolExecutionContext = {
                                ...toolCtx,
                                output: postOutput,
                                control: postControl,
                                event: postEvent,
                            };

                            const reconcileInPlaceOutput = (
                                prevText: string,
                                prevContent: string,
                            ): void => {
                                if (
                                    typeof postOutput.content === 'string'
                                    && postOutput.content !== prevContent
                                ) {
                                    postOutput.text = postOutput.content;
                                } else if (
                                    typeof postOutput.text === 'string'
                                    && postOutput.text !== prevText
                                ) {
                                    postOutput.content = postOutput.text;
                                }
                            };

                            if (shouldRunPresetPostprocess && effectiveSandbox && presetPostprocess) {
                                const prevText = postOutput.text;
                                const prevContent = postOutput.content;
                                const prevReasoning = postOutput.reasoningContent;
                                const rawReturn = await effectiveSandbox.evaluateScript(
                                    presetPostprocess.code,
                                    postToolCtx,
                                    {
                                        id: `${runSandboxScope}:postprocess:r${roundIndexForTurn + 1}:a${roundRetriesUsed}`,
                                        signal,
                                    },
                                );
                                throwIfAborted(signal);
                                reconcileInPlaceOutput(prevText, prevContent);

                                if (typeof rawReturn === 'string') {
                                    const wasReasoningAssignment =
                                        postOutput.reasoningContent !== prevReasoning
                                        && rawReturn === postOutput.reasoningContent;
                                    if (!wasReasoningAssignment) {
                                        postOutput.content = rawReturn;
                                        postOutput.text = rawReturn;
                                    }
                                } else if (
                                    rawReturn
                                    && typeof rawReturn === 'object'
                                    && !Array.isArray(rawReturn)
                                ) {
                                    const rec = rawReturn as Record<string, unknown>;
                                    if (typeof rec.content === 'string') {
                                        postOutput.content = rec.content;
                                        postOutput.text = rec.content;
                                    } else if (typeof rec.text === 'string') {
                                        postOutput.content = rec.text;
                                        postOutput.text = rec.text;
                                    }
                                    if ('reasoningContent' in rec) {
                                        postOutput.reasoningContent =
                                            typeof rec.reasoningContent === 'string'
                                                ? rec.reasoningContent
                                                : undefined;
                                    }
                                    if (Array.isArray(rec.toolCalls)) {
                                        postOutput.toolCalls = normalizePostprocessToolCalls(
                                            rec.toolCalls,
                                        );
                                    }
                                }
                            }

                            if (shouldRunCallbackPostprocess && effectiveOnPostprocess) {
                                const prevText = postOutput.text;
                                const prevContent = postOutput.content;
                                await effectiveOnPostprocess({
                                    target: { ...target },
                                    phase: input.phase,
                                    runId,
                                    agentId: agent.id,
                                    agentName: agent.name,
                                    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                    round: roundIndexForTurn + 1,
                                    attempt: roundRetriesUsed,
                                    maxRetries: maxRoundRetries,
                                    fixAttempt: postprocessFixAttempts,
                                    maxFixAttempts: maxPostprocessFixAttempts,
                                    promptTriggerContext,
                                    output: postOutput,
                                    control: postControl,
                                    connection: attemptConnection,
                                    vars: workingVars,
                                    signal,
                                    toolContext: postToolCtx,
                                });
                                throwIfAborted(signal);
                                reconcileInPlaceOutput(prevText, prevContent);
                            }

                            const nextContent =
                                typeof postOutput.content === 'string'
                                    ? postOutput.content
                                    : typeof postOutput.text === 'string'
                                        ? postOutput.text
                                        : origContent;
                            const nextReasoning =
                                typeof postOutput.reasoningContent === 'string'
                                && postOutput.reasoningContent.length > 0
                                    ? postOutput.reasoningContent
                                    : undefined;
                            const nextToolCalls = Array.isArray(postOutput.toolCalls)
                                ? normalizePostprocessToolCalls(postOutput.toolCalls)
                                : turnOutput.toolCalls;

                            turnOutput = {
                                ...turnOutput,
                                content: nextContent,
                                toolCalls: nextToolCalls,
                                ...(nextReasoning !== undefined
                                    ? { reasoningContent: nextReasoning }
                                    : {}),
                            };
                            if (nextReasoning === undefined) {
                                delete turnOutput.reasoningContent;
                            }

                            if (activeAssistantRound) {
                                activeAssistantRound.content = nextContent || undefined;
                                activeAssistantRound.reasoning = nextReasoning;
                            }

                            if (postControl.action === 'abort') {
                                throw createAbortError(
                                    postControl.abortReason
                                        ?? 'Response postprocess aborted generation.',
                                );
                            }
                            if (
                                postControl.action === 'retry'
                                && roundRetriesUsed < maxRoundRetries
                            ) {
                                throw new LLMTransportError(
                                    postControl.retryReason
                                        ?? 'Postprocess script requested retry.',
                                    {
                                        code: ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY,
                                        retryable: true,
                                    },
                                );
                            }
                            if (
                                postControl.action === 'fix'
                                && postprocessFixAttempts < maxPostprocessFixAttempts
                                && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds)
                            ) {
                                pendingPostprocessFixFeedback =
                                    postControl.fixMessage
                                    ?? 'Response postprocess requested a revision.';
                            }
                        }

                        lastAttemptDiag = {
                            ...(turnOutput.finishReason
                                ? { finishReason: turnOutput.finishReason }
                                : {}),
                            ...(turnOutput.usage.outputTokens > 0
                                ? { outputTokens: turnOutput.usage.outputTokens }
                                : {}),
                            ...(turnOutput.reasoningContent?.trim()
                                ? { hasReasoning: true }
                                : {}),
                        };

                        if (!pendingPostprocessFixFeedback && !isLengthFinishReason(turnOutput.finishReason)) {
                            if (turnOutput.toolCalls.length === 0 && !turnOutput.content.trim()) {
                                const allowSilentSideEffectFinish =
                                    !strictToolLoop
                                    && !isMainOutputMode
                                    && input.phase !== 'main_turn'
                                    && hasWriteToolExecuted;
                                if (!allowSilentSideEffectFinish) {
                                    if (turnOutput.reasoningContent?.trim()) {
                                        lastReasoning = turnOutput.reasoningContent;
                                    }
                                    throw new LLMTransportError(
                                        'Model returned an empty response with no tool calls.',
                                        {
                                            code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE,
                                            retryable: true,
                                        },
                                    );
                                }
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

                        pendingMutationDirectives = new Map();
                        pendingTurnFinishOutcome = undefined;

                        if (
                            !pendingPostprocessFixFeedback
                            && this.bridge.processOutputText
                            && !isLengthFinishReason(turnOutput.finishReason)
                        ) {
                            const prefillPrefix = peekPrefillPrefix();
                            const hasPrefill = prefillPrefix.length > 0;
                            const buildBaseMeta = (
                                stage: 'output_mutation' | 'turn_finish',
                                operation: OutputProcessOperation,
                            ) => ({
                                runner: 'agent' as const,
                                stage,
                                operation,
                                finishMode: strictToolLoop
                                    ? ('strict_tool' as const)
                                    : ('plain_text' as const),
                                sessionId: outputSessionId,
                                round: roundsCompleted + 1,
                                retryAttempt: roundRetriesUsed,
                                maxRetries: maxRoundRetries,
                                fixAttempt: outputFixAttempts,
                                maxFixAttempts: maxOutputFixAttempts,
                                target: { ...target },
                                messageId: target.messageId,
                                swipeId: target.swipeId,
                                agentId: agent.id,
                                agentName: agent.name,
                                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                stream: Boolean(llmRequest.stream),
                                hasPrefill,
                                sessionBag: outputSessionBag,
                            });

                            if (turnOutput.toolCalls.length === 0) {
                                const currentOut = isMainOutputMode
                                    ? await readCurrentOutputSafe()
                                    : '';
                                const shouldValidatePlain = !isMainOutputMode
                                    || currentOut.trim().length > 0;
                                if (shouldValidatePlain) {
                                    const candidateText = isMainOutputMode
                                        ? currentOut
                                        : `${prefillPrefix}${turnOutput.content ?? ''}`;
                                    const res = await runOutputProcess(this.bridge, {
                                        text: candidateText,
                                        meta: {
                                            ...buildBaseMeta('turn_finish', 'plain_finish'),
                                            ...(isMainOutputMode
                                                ? { filePath: OUTPUT_FILE_PATH }
                                                : {}),
                                        },
                                    });
                                    if (
                                        res.action === 'retry'
                                        && !isMainOutputMode
                                        && roundRetriesUsed < maxRoundRetries
                                    ) {
                                        throw new LLMTransportError(
                                            res.retryReason
                                                ?? 'Output validation requested retry.',
                                            {
                                                code: ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY,
                                                retryable: true,
                                            },
                                        );
                                    }
                                    pendingTurnFinishOutcome = {
                                        operation: 'plain_finish',
                                        result: res,
                                    };
                                }
                            } else if (
                                strictToolLoop
                                && finishTurnSpec
                                && turnOutput.toolCalls.every(
                                    (tc) => tc.name === FINISH_TURN_TOOL_NAME,
                                )
                            ) {
                                const primaryFinish = turnOutput.toolCalls[0];
                                const parsedFinish = parseFinishTurnArgs(
                                    primaryFinish.arguments,
                                    finishTurnSpec.definition.parameters,
                                );
                                if (parsedFinish.ok) {
                                    let ready = false;
                                    let candidateText = '';
                                    if (finishTurnMode === 'main_output') {
                                        const currentOut = await readCurrentOutputSafe();
                                        if (currentOut.trim().length > 0) {
                                            ready = true;
                                            candidateText = currentOut;
                                        }
                                    } else if (finishTurnMode === 'side_effect') {
                                        if (hasWriteToolExecuted || toolRoundsExecuted > 0) {
                                            ready = true;
                                            candidateText =
                                                typeof parsedFinish.data.status === 'string'
                                                && parsedFinish.data.status.trim().length > 0
                                                    ? parsedFinish.data.status.trim()
                                                    : String(parsedFinish.data.step_brief ?? '').trim();
                                        }
                                    } else {
                                        ready = true;
                                        candidateText = String(parsedFinish.data.response ?? '');
                                    }

                                    if (ready) {
                                        const res = await runOutputProcess(this.bridge, {
                                            text: candidateText,
                                            meta: {
                                                ...buildBaseMeta('turn_finish', 'finish_turn'),
                                                toolCallId: primaryFinish.id,
                                                toolName: primaryFinish.name,
                                                ...(isMainOutputMode
                                                    ? { filePath: OUTPUT_FILE_PATH }
                                                    : {}),
                                            },
                                        });
                                        if (
                                            res.action === 'retry'
                                            && !isMainOutputMode
                                            && roundRetriesUsed < maxRoundRetries
                                        ) {
                                            throw new LLMTransportError(
                                                res.retryReason
                                                    ?? 'Output validation requested retry.',
                                                {
                                                    code: ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY,
                                                    retryable: true,
                                                },
                                            );
                                        }
                                        pendingTurnFinishOutcome = {
                                            operation: 'finish_turn',
                                            result: res,
                                        };
                                    }
                                }
                            } else if (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds) {
                                let simulatedOutput = await readCurrentOutputSafe();
                                for (const tc of turnOutput.toolCalls) {
                                    const parsedArgs = parseArgsForLog(tc.arguments);
                                    if (!isOutputMutationToolCall(tc.name, parsedArgs)) {
                                        continue;
                                    }
                                    const sim = simulateOutputMutationCandidate(
                                        tc.name,
                                        parsedArgs,
                                        simulatedOutput,
                                    );
                                    if (!sim) {
                                        continue;
                                    }
                                    const res = await runOutputProcess(this.bridge, {
                                        text: sim.candidateText,
                                        meta: {
                                            ...buildBaseMeta('output_mutation', sim.operation),
                                            filePath: OUTPUT_FILE_PATH,
                                            toolCallId: tc.id,
                                            toolName: tc.name,
                                            previousText: simulatedOutput,
                                        },
                                    });
                                    if (
                                        res.action === 'retry'
                                        && roundRetriesUsed < maxRoundRetries
                                    ) {
                                        throw new LLMTransportError(
                                            res.retryReason
                                                ?? 'Output mutation validation requested retry.',
                                            {
                                                code: ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY,
                                                retryable: true,
                                            },
                                        );
                                    }
                                    pendingMutationDirectives.set(tc.id, {
                                        toolCallId: tc.id,
                                        operation: sim.operation,
                                        result: res,
                                        fixCounted: false,
                                    });
                                    const willRejectWrite =
                                        res.action === 'fix'
                                        && res.rejectWrite
                                        && outputFixAttempts < maxOutputFixAttempts;
                                    if (!willRejectWrite) {
                                        simulatedOutput = res.changed
                                            ? res.text
                                            : sim.candidateText;
                                    }
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
                            const retryTimestamp = Date.now();
                            const retryEntry: RoundRetryLog = {
                                round: roundsCompleted + 1,
                                attempt: roundRetriesUsed,
                                maxAttempts: maxRoundRetries,
                                reason: retryReason,
                                delayMs: retryDelayMs,
                                timestamp: retryTimestamp,
                                ...(lastAttemptDiag?.finishReason
                                    ? { finishReason: lastAttemptDiag.finishReason }
                                    : {}),
                                ...(lastAttemptDiag?.outputTokens !== undefined
                                    ? { outputTokens: lastAttemptDiag.outputTokens }
                                    : {}),
                                ...(lastAttemptDiag?.hasReasoning
                                    ? { hasReasoning: true }
                                    : {}),
                            };
                            retryEvents.push(retryEntry);

                            publishRunningTrace(retryTimestamp);

                            if (extractor) {
                                const committedOutput = await readCurrentOutputSafe();
                                lastOutputPreview = committedOutput;
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
                                timestamp: retryTimestamp,
                                phase: input.phase,
                                runId,
                                agentProfileId: agent.id,
                                retryAttempt: roundRetriesUsed,
                                retryMaxAttempts: maxRoundRetries,
                                retryDelayMs,
                                retryReason,
                            });
                            input.onRetrying?.(canonicalClone(retryEntry));

                            if (recoveryOverride) {
                                pendingRecoveryOverride = recoveryOverride;
                            }

                            await delayWithAbort(retryDelayMs, signal);
                            continue;
                        }

                        if (
                            !input.isErrorRecovery
                            && input.onGenerationError
                            && errorRecoveryAttemptsUsed < maxErrorRecoveryAttempts
                        ) {
                            errorRecoveryAttemptsUsed += 1;
                            const recoveryTracker = createLayerTrackingEphemeralController(
                                lastSentMessages,
                                lastSentLayers,
                            );
                            const trackedEphemeral = recoveryTracker.controller;

                            const errorInfo = extractGenerationErrorInfo(error);
                            const recoveryEvent: ToolEventPayload = {
                                type: 'generation_error',
                                timestamp: Date.now(),
                                target: { ...target },
                                phase: input.phase,
                                runId,
                                agentId: agent.id,
                                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                round: roundIndexForTurn + 1,
                                attempt: errorRecoveryAttemptsUsed,
                                maxAttempts: maxErrorRecoveryAttempts,
                                error: errorInfo.message,
                                ...(errorInfo.code ? { errorCode: errorInfo.code } : {}),
                                ...(errorInfo.status !== undefined
                                    ? { statusCode: errorInfo.status }
                                    : {}),
                                messageId: target.messageId,
                                swipeId: target.swipeId,
                                data: {
                                    layers: { ...lastSentLayers },
                                    ...(errorInfo.rawBody !== undefined
                                        ? { rawBody: errorInfo.rawBody }
                                        : {}),
                                },
                            };
                            const recoveryToolCtx: ToolExecutionContext = {
                                ...toolCtx,
                                messages: trackedEphemeral,
                                event: recoveryEvent,
                            };

                            let decision: AgentGenerationErrorDecision | void;
                            try {
                                decision = await input.onGenerationError({
                                    target: { ...target },
                                    phase: input.phase,
                                    runId,
                                    agentId: agent.id,
                                    agentName: agent.name,
                                    ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                                    round: roundIndexForTurn + 1,
                                    attempt: errorRecoveryAttemptsUsed,
                                    maxAttempts: maxErrorRecoveryAttempts,
                                    error: errorInfo,
                                    rawError: error,
                                    ephemeralMessages: trackedEphemeral,
                                    layers: { ...lastSentLayers },
                                    connection: Object.freeze(canonicalClone(attemptConnection)),
                                    signal,
                                    toolContext: recoveryToolCtx,
                                });
                            } catch (hookError) {
                                if (isAbortError(hookError) || signal.aborted) {
                                    throw hookError;
                                }
                                console.warn(
                                    '[ST-Agentic] onGenerationError hook threw an error; continuing with original failure:',
                                    hookError,
                                );
                                decision = undefined;
                            }
                            throwIfAborted(signal);

                            if (decision?.action === 'abort') {
                                throw createAbortError(
                                    decision.reason?.trim()
                                        || 'Error recovery hook aborted generation.',
                                );
                            }

                            if (decision?.action === 'retry') {
                                if (
                                    recoveryTracker.getRolledBackRounds() === 0
                                    && typeof decision.rollbackToolRounds === 'number'
                                    && decision.rollbackToolRounds > 0
                                ) {
                                    trackedEphemeral.rollbackToolRounds(
                                        decision.rollbackToolRounds,
                                    );
                                }
                                if (
                                    recoveryTracker.getDroppedHistoryTurns() === 0
                                    && typeof decision.dropHistoryTurns === 'number'
                                    && decision.dropHistoryTurns > 0
                                ) {
                                    trackedEphemeral.dropHistoryTurns(decision.dropHistoryTurns);
                                }

                                const totalRolledBackRounds = recoveryTracker.getRolledBackRounds();
                                if (totalRolledBackRounds > 0) {
                                    rollbackTrailingToolRoundsInArray(
                                        turnMessages,
                                        totalRolledBackRounds,
                                        turnTransformStates,
                                    );
                                    rollbackTrailingToolRoundsInArray(
                                        completedTurnMessages,
                                        totalRolledBackRounds,
                                    );
                                    currentAssembled = await refreshFloatingAndReassembleInFlight();
                                }

                                const nextRecoveryMessages = decision.messages
                                    ? sanitizeToolCallPairs(decision.messages)
                                    : recoveryTracker.wasMutated()
                                        ? trackedEphemeral.toMessages()
                                        : undefined;
                                const nextRecoveryLayers = nextRecoveryMessages
                                    ? clampLayerIndices(
                                        recoveryTracker.getLayers(),
                                        nextRecoveryMessages.length,
                                    )
                                    : undefined;

                                let nextRecoveryConn: ApiConnection | undefined;
                                const hasConnOverride = Boolean(
                                    (typeof decision.connectionId === 'string'
                                        && decision.connectionId.trim().length > 0)
                                    || (typeof decision.temperature === 'number'
                                        && Number.isFinite(decision.temperature))
                                    || (typeof decision.maxTokens === 'number'
                                        && Number.isFinite(decision.maxTokens)
                                        && decision.maxTokens > 0),
                                );
                                if (hasConnOverride) {
                                    const baseConn =
                                        typeof decision.connectionId === 'string'
                                        && decision.connectionId.trim().length > 0
                                            ? resolveConnection(
                                                this.settingsProvider(),
                                                decision.connectionId.trim(),
                                            )
                                            : attemptConnection;
                                    nextRecoveryConn = canonicalClone(baseConn);
                                    if (
                                        typeof decision.temperature === 'number'
                                        && Number.isFinite(decision.temperature)
                                    ) {
                                        nextRecoveryConn.temperature = decision.temperature;
                                    }
                                    if (
                                        typeof decision.maxTokens === 'number'
                                        && Number.isFinite(decision.maxTokens)
                                        && decision.maxTokens > 0
                                    ) {
                                        nextRecoveryConn.maxTokens = Math.floor(
                                            decision.maxTokens,
                                        );
                                    }
                                }

                                pendingRecoveryOverride = {
                                    ...(nextRecoveryMessages
                                        ? { messages: nextRecoveryMessages }
                                        : {}),
                                    ...(nextRecoveryLayers ? { layers: nextRecoveryLayers } : {}),
                                    ...(nextRecoveryConn ? { connection: nextRecoveryConn } : {}),
                                };

                                const recoveryDelayMs =
                                    typeof decision.delayMs === 'number'
                                    && Number.isFinite(decision.delayMs)
                                    && decision.delayMs > 0
                                        ? Math.floor(decision.delayMs)
                                        : 0;
                                const recoveryReason =
                                    decision.reason?.trim()
                                    || `error_recovery: ${formatRoundRetryReason(error)}`;
                                const recoveryTs = Date.now();
                                const recoveryRetryEntry: RoundRetryLog = {
                                    round: roundIndexForTurn + 1,
                                    attempt: errorRecoveryAttemptsUsed,
                                    maxAttempts: maxErrorRecoveryAttempts,
                                    reason: recoveryReason,
                                    delayMs: recoveryDelayMs,
                                    timestamp: recoveryTs,
                                    ...(lastAttemptDiag?.finishReason
                                        ? { finishReason: lastAttemptDiag.finishReason }
                                        : {}),
                                    ...(lastAttemptDiag?.outputTokens !== undefined
                                        ? { outputTokens: lastAttemptDiag.outputTokens }
                                        : {}),
                                    ...(lastAttemptDiag?.hasReasoning
                                        ? { hasReasoning: true }
                                        : {}),
                                };
                                retryEvents.push(recoveryRetryEntry);

                                if (extractor) {
                                    const committedOutput = await readCurrentOutputSafe();
                                    lastOutputPreview = committedOutput;
                                    extractor.resetRound(committedOutput);
                                }
                                finishExtractor?.resetRound();
                                activeAssistantRound = null;
                                publishRunningTrace(recoveryTs);

                                this.traceLogger.emit({
                                    kind: 'turn_retrying',
                                    target: { ...target },
                                    timestamp: recoveryTs,
                                    phase: input.phase,
                                    runId,
                                    agentProfileId: agent.id,
                                    retryAttempt: errorRecoveryAttemptsUsed,
                                    retryMaxAttempts: maxErrorRecoveryAttempts,
                                    retryDelayMs: recoveryDelayMs,
                                    retryReason: recoveryReason,
                                });
                                input.onRetrying?.(canonicalClone(recoveryRetryEntry));

                                if (recoveryDelayMs > 0) {
                                    await delayWithAbort(recoveryDelayMs, signal);
                                }
                                continue;
                            }
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
                    turnTransformStates.pop();
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

                if (
                    pendingPostprocessFixFeedback
                    && postprocessFixAttempts < maxPostprocessFixAttempts
                    && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds)
                ) {
                    lockAssistantRound({
                        roundIndex: roundIndexForTurn,
                        beforeStepIndex: beforeStepIndexForTurn,
                        timestamp: roundStartedAt,
                        reasoning: turnOutput.reasoningContent,
                        content: turnOutput.content,
                        isFinishTurn: false,
                    });
                    postprocessFixAttempts += 1;
                    toolRoundsExecuted += 1;

                    const rejectedContent =
                        turnOutput.content.trim().length > 0
                            ? turnOutput.content
                            : turnOutput.toolCalls.length > 0
                                ? `[Proposed tool calls rejected by postprocess validation: ${summarizeToolBatch(turnOutput.toolCalls)}]`
                                : '';
                    const rejectedAssistantMsg: CanonicalMessage = {
                        role: 'assistant',
                        content: rejectedContent,
                        ...(turnOutput.reasoningContent
                            ? { reasoningContent: turnOutput.reasoningContent }
                            : {}),
                    };
                    const feedbackUserMsg: CanonicalMessage = {
                        role: 'user',
                        content: pendingPostprocessFixFeedback,
                    };
                    turnMessages.push(rejectedAssistantMsg, feedbackUserMsg);
                    turnTransformStates.push({ cached: true }, { cached: true });
                    completedTurnMessages.push(
                        canonicalClone(rejectedAssistantMsg),
                        canonicalClone(feedbackUserMsg),
                    );
                    if (extractor) {
                        const currentOut = await readCurrentOutputSafe();
                        extractor.resetRound(currentOut);
                    }
                    finishExtractor?.resetRound();
                    currentAssembled = await refreshFloatingAndReassembleInFlight();
                    continue;
                }

                if (turnOutput.toolCalls.length === 0) {
                    let finalContent = turnOutput.content;
                    let persistedContent = turnOutput.content;
                    if (isMainOutputMode) {
                        const currentOutput = await readCurrentOutputSafe();

                        if (currentOutput.trim().length === 0) {
                            if (
                                !emptyOutputRetried
                                && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds)
                            ) {
                                lockAssistantRound({
                                    roundIndex: roundIndexForTurn,
                                    beforeStepIndex: beforeStepIndexForTurn,
                                    timestamp: roundStartedAt,
                                    reasoning: turnOutput.reasoningContent,
                                    content: turnOutput.content,
                                    isFinishTurn: false,
                                });
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
                                turnTransformStates.push({ cached: true }, { cached: true });
                                completedTurnMessages.push(
                                    canonicalClone(emptyAssistantMsg),
                                    canonicalClone(systemCheckMsg),
                                );

                                currentAssembled = await refreshFloatingAndReassembleInFlight();
                                continue;
                            }

                            return await salvageAndInterrupt(
                                'empty_output',
                                'Model finished without writing to /output.md',
                            );
                        }

                        finalContent = currentOutput;
                    }

                    if (pendingTurnFinishOutcome) {
                        const finishOutcome = pendingTurnFinishOutcome;
                        const wantsFix =
                            finishOutcome.result.action === 'fix'
                            || (isMainOutputMode && finishOutcome.result.action === 'retry');
                        if (
                            wantsFix
                            && outputFixAttempts < maxOutputFixAttempts
                            && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds)
                        ) {
                            lockAssistantRound({
                                roundIndex: roundIndexForTurn,
                                beforeStepIndex: beforeStepIndexForTurn,
                                timestamp: roundStartedAt,
                                reasoning: turnOutput.reasoningContent,
                                content: turnOutput.content,
                                isFinishTurn: false,
                            });
                            outputFixAttempts += 1;
                            toolRoundsExecuted += 1;
                            const feedbackMsg = formatOutputFixFeedback(
                                finishOutcome.result.fixMessage
                                    ?? finishOutcome.result.retryReason
                                    ?? 'Output validation requested a revision.',
                                {
                                    stage: 'turn_finish',
                                    operation: 'plain_finish',
                                    requestedBy: finishOutcome.result.requestedBy,
                                },
                            );
                            const rejectedAssistantMsg: CanonicalMessage = {
                                role: 'assistant',
                                content: turnOutput.content ?? '',
                                ...(turnOutput.reasoningContent
                                    ? { reasoningContent: turnOutput.reasoningContent }
                                    : {}),
                            };
                            const feedbackUserMsg: CanonicalMessage = {
                                role: 'user',
                                content: feedbackMsg,
                            };
                            turnMessages.push(rejectedAssistantMsg, feedbackUserMsg);
                            turnTransformStates.push({ cached: true }, { cached: true });
                            completedTurnMessages.push(
                                canonicalClone(rejectedAssistantMsg),
                                canonicalClone(feedbackUserMsg),
                            );
                            currentAssembled = await refreshFloatingAndReassembleInFlight();
                            continue;
                        }
                        if (finishOutcome.result.changed) {
                            finalContent = finishOutcome.result.text;
                            if (isMainOutputMode) {
                                await this.vfs.writeFile(OUTPUT_FILE_PATH, finishOutcome.result.text, {
                                    target,
                                    staged,
                                    source: 'agentic_output_process',
                                    emitRenderEvent: true,
                                });
                                extractor?.markToolExecuted(finishOutcome.result.text);
                            } else {
                                persistedContent = finishOutcome.result.text;
                            }
                        }
                    }

                    const plainAssistantSummary =
                        persistedContent.trim().length > 0 ? persistedContent : undefined;
                    lockAssistantRound({
                        roundIndex: roundIndexForTurn,
                        beforeStepIndex: beforeStepIndexForTurn,
                        timestamp: roundStartedAt,
                        reasoning: turnOutput.reasoningContent,
                        content: persistedContent,
                        isFinishTurn: false,
                    });

                    return await finalizeSuccessfulTurn({
                        finalContent,
                        persistedAssistantContent: persistedContent,
                        reasoningContent: turnOutput.reasoningContent,
                        assistantSummary: plainAssistantSummary,
                    });
                }

                let turnFinishFixFeedback: string | undefined;

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
                        const finishOutcome = pendingTurnFinishOutcome;
                        const wantsFinishFix =
                            finishOutcome
                            && (finishOutcome.result.action === 'fix'
                                || (isMainOutputMode && finishOutcome.result.action === 'retry'))
                            && outputFixAttempts < maxOutputFixAttempts
                            && (!hasToolRoundLimit || toolRoundsExecuted < maxToolRounds);

                        if (finishTurnMode === 'main_output') {
                            const currentOutput = await readCurrentOutputSafe();
                            if (currentOutput.trim().length > 0) {
                                if (wantsFinishFix) {
                                    outputFixAttempts += 1;
                                    shrinkToWriteAndFinish = false;
                                    consecutiveDuplicateReadOnlyRounds = 0;
                                    turnFinishFixFeedback = formatOutputFixFeedback(
                                        finishOutcome.result.fixMessage
                                            ?? finishOutcome.result.retryReason
                                            ?? 'Output validation requested a revision.',
                                        {
                                            stage: 'turn_finish',
                                            operation: 'finish_turn',
                                            requestedBy: finishOutcome.result.requestedBy,
                                        },
                                    );
                                } else {
                                    let resolvedFinalContent = currentOutput;
                                    if (finishOutcome?.result.changed) {
                                        resolvedFinalContent = finishOutcome.result.text;
                                        await this.vfs.writeFile(
                                            OUTPUT_FILE_PATH,
                                            resolvedFinalContent,
                                            {
                                                target,
                                                staged,
                                                source: 'agentic_output_process',
                                                emitRenderEvent: true,
                                            },
                                        );
                                        extractor?.markToolExecuted(resolvedFinalContent);
                                    }
                                    const stepBrief = String(
                                        parsedFinish.data.step_brief ?? '',
                                    ).trim();
                                    const finishSummary = buildMainOutputFinishSummary(
                                        stepBrief,
                                        turnOutput.content ?? '',
                                    );
                                    lockAssistantRound({
                                        roundIndex: roundIndexForTurn,
                                        beforeStepIndex: beforeStepIndexForTurn,
                                        timestamp: roundStartedAt,
                                        reasoning: turnOutput.reasoningContent,
                                        content: turnOutput.content,
                                        isFinishTurn: true,
                                        finishTurnSummary: finishSummary,
                                    });
                                    return await finalizeSuccessfulTurn({
                                        finalContent: resolvedFinalContent,
                                        persistedAssistantContent:
                                            turnOutput.content.trim() || stepBrief,
                                        reasoningContent: turnOutput.reasoningContent,
                                        assistantSummary: finishSummary,
                                    });
                                }
                            }
                            // Fall through below to reject empty `/output.md` `finish_turn` and continue loop.
                        } else if (finishTurnMode === 'side_effect') {
                            if (hasWriteToolExecuted || toolRoundsExecuted > 0) {
                                if (wantsFinishFix) {
                                    outputFixAttempts += 1;
                                    shrinkToWriteAndFinish = false;
                                    consecutiveDuplicateReadOnlyRounds = 0;
                                    turnFinishFixFeedback = formatOutputFixFeedback(
                                        finishOutcome.result.fixMessage
                                            ?? finishOutcome.result.retryReason
                                            ?? 'Output validation requested a revision.',
                                        {
                                            stage: 'turn_finish',
                                            operation: 'finish_turn',
                                            requestedBy: finishOutcome.result.requestedBy,
                                        },
                                    );
                                } else {
                                    const rawStatus =
                                        typeof parsedFinish.data.status === 'string'
                                            ? parsedFinish.data.status.trim()
                                            : '';
                                    const stepBrief = String(
                                        parsedFinish.data.step_brief ?? '',
                                    ).trim();
                                    const rawStatusText = rawStatus || stepBrief;
                                    const statusText = finishOutcome?.result.changed
                                        ? finishOutcome.result.text
                                        : rawStatusText;
                                    const finishSummary = buildSideEffectFinishSummary(
                                        finishOutcome?.result.changed
                                            ? finishOutcome.result.text
                                            : rawStatus,
                                        stepBrief,
                                    );
                                    lockAssistantRound({
                                        roundIndex: roundIndexForTurn,
                                        beforeStepIndex: beforeStepIndexForTurn,
                                        timestamp: roundStartedAt,
                                        reasoning: turnOutput.reasoningContent,
                                        content: turnOutput.content,
                                        isFinishTurn: true,
                                        finishTurnSummary: finishSummary,
                                    });
                                    return await finalizeSuccessfulTurn({
                                        finalContent: statusText,
                                        persistedAssistantContent: statusText,
                                        reasoningContent: turnOutput.reasoningContent,
                                        assistantSummary: finishSummary,
                                    });
                                }
                            }
                            // Fall through below to reject premature round-1 side-effect `finish_turn`.
                        } else {
                            if (wantsFinishFix) {
                                outputFixAttempts += 1;
                                shrinkToWriteAndFinish = false;
                                consecutiveDuplicateReadOnlyRounds = 0;
                                turnFinishFixFeedback = formatOutputFixFeedback(
                                    finishOutcome.result.fixMessage
                                        ?? finishOutcome.result.retryReason
                                        ?? 'Output validation requested a revision.',
                                    {
                                        stage: 'turn_finish',
                                        operation: 'finish_turn',
                                        requestedBy: finishOutcome.result.requestedBy,
                                    },
                                );
                            } else {
                                const rawResponseText = String(parsedFinish.data.response ?? '');
                                const responseText = finishOutcome?.result.changed
                                    ? finishOutcome.result.text
                                    : rawResponseText;
                                const finishSummary =
                                    responseText.trim().length > 0 ? responseText : undefined;
                                lockAssistantRound({
                                    roundIndex: roundIndexForTurn,
                                    beforeStepIndex: beforeStepIndexForTurn,
                                    timestamp: roundStartedAt,
                                    reasoning: turnOutput.reasoningContent,
                                    content: turnOutput.content,
                                    isFinishTurn: true,
                                    finishTurnSummary: finishSummary,
                                });
                                return await finalizeSuccessfulTurn({
                                    finalContent: responseText,
                                    persistedAssistantContent: responseText,
                                    reasoningContent: turnOutput.reasoningContent,
                                    assistantSummary: finishSummary,
                                });
                            }
                        }
                    }
                }

                // Lock this intermediate assistant round before guardrail / tool execution.
                lockAssistantRound({
                    roundIndex: roundIndexForTurn,
                    beforeStepIndex: beforeStepIndexForTurn,
                    timestamp: roundStartedAt,
                    reasoning: turnOutput.reasoningContent,
                    content: turnOutput.content,
                    isFinishTurn: false,
                });

                // Enforce maxToolRounds guardrail before executing another round of tool calls.
                if (hasToolRoundLimit && toolRoundsExecuted >= maxToolRounds) {
                    throwMaxToolRounds();
                }

                // Snapshot rollback state BEFORE mutating turn messages or executing this tool batch.
                const preBatchOutputText = await readCurrentOutputSafe();
                previousRoundSnapshot = {
                    completedTurnMessages: canonicalClone(completedTurnMessages),
                    readSetSnapshot: Object.fromEntries(effectiveReadSet.entries()),
                    stagedSnapshot: this.store.snapshotStagedData(target),
                    outputText: preBatchOutputText,
                    rolledBackToolSummary: summarizeToolBatch(turnOutput.toolCalls),
                };

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
                turnTransformStates.push({ cached: true });
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
                        status: 'running',
                        durationMs: 0,
                        startedAt: stepStartedAt,
                    };

                    let execResult: Awaited<ReturnType<ToolRegistry['executeToolCall']>>;
                    let duplicateReadWarning: string | undefined;

                    try {
                        activeToolStep = startedStep;
                        publishRunningTrace(stepStartedAt);

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
                                } else if (turnFinishFixFeedback) {
                                    execResult = {
                                        ok: false,
                                        toolName: toolCall.name,
                                        output: JSON.stringify({
                                            ok: false,
                                            error: turnFinishFixFeedback,
                                        }),
                                        error: turnFinishFixFeedback,
                                        durationMs: Math.max(0, Date.now() - stepStartedAt),
                                    };
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
                            const mutationDirective = pendingMutationDirectives.get(toolCall.id);
                            const shouldRejectWrite = Boolean(
                                mutationDirective
                                && mutationDirective.result.action === 'fix'
                                && mutationDirective.result.rejectWrite
                                && outputFixAttempts < maxOutputFixAttempts,
                            );
                            if (shouldRejectWrite && mutationDirective) {
                                outputFixAttempts += 1;
                                mutationDirective.fixCounted = true;
                                const rejectMsg = formatOutputFixFeedback(
                                    mutationDirective.result.fixMessage
                                        ?? 'Output validation rejected this write.',
                                    {
                                        stage: 'output_mutation',
                                        operation: mutationDirective.operation,
                                        rejectWrite: true,
                                        requestedBy: mutationDirective.result.requestedBy,
                                    },
                                );
                                execResult = {
                                    ok: false,
                                    toolName: toolCall.name,
                                    output: JSON.stringify({
                                        ok: false,
                                        rejected: true,
                                        path: OUTPUT_FILE_PATH,
                                        error: rejectMsg,
                                    }),
                                    error: rejectMsg,
                                    durationMs: Math.max(0, Date.now() - stepStartedAt),
                                };
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

                            if (execResult.ok && mutationDirective) {
                                if (mutationDirective.result.changed) {
                                    await this.vfs.writeFile(
                                        OUTPUT_FILE_PATH,
                                        mutationDirective.result.text,
                                        {
                                            target,
                                            staged,
                                            source: 'agentic_output_process',
                                            emitRenderEvent: true,
                                        },
                                    );
                                }
                                if (
                                    mutationDirective.result.action === 'fix'
                                    && !mutationDirective.result.rejectWrite
                                    && !mutationDirective.fixCounted
                                    && outputFixAttempts < maxOutputFixAttempts
                                ) {
                                    outputFixAttempts += 1;
                                    mutationDirective.fixCounted = true;
                                    const softFixMsg = formatOutputFixFeedback(
                                        mutationDirective.result.fixMessage
                                            ?? 'Output validation requested a revision.',
                                        {
                                            stage: 'output_mutation',
                                            operation: mutationDirective.operation,
                                            rejectWrite: false,
                                            requestedBy: mutationDirective.result.requestedBy,
                                        },
                                    );
                                    execResult = {
                                        ...execResult,
                                        output: attachValidationWarningToToolOutput(
                                            execResult.output,
                                            softFixMsg,
                                        ),
                                    };
                                }
                            }

                            if (
                                extractor
                                && execResult.ok
                                && isOutputMutationToolCall(toolCall.name, parsedArgs)
                            ) {
                                const currentOut = await readCurrentOutputSafe();
                                extractor.markToolExecuted(currentOut);
                            }

                            if (!READ_ONLY_TOOL_NAMES.has(toolCall.name) && execResult.ok) {
                                hasWriteToolExecuted = true;
                                roundHadSuccessfulWrite = true;
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
                                }
                            }
                        }

                        throwIfAborted(signal);
                    } finally {
                        activeToolStep = null;
                    }

                    const stepCompletedAt = Date.now();
                    const completedStep: ToolStepLog = {
                        stepIndex,
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        args: parsedArgs,
                        result: execResult.output,
                        ok: execResult.ok,
                        status: execResult.ok ? 'completed' : 'error',
                        ...(execResult.error !== undefined ? { error: execResult.error } : {}),
                        durationMs: execResult.durationMs,
                        startedAt: stepStartedAt,
                    };
                    toolSteps.push(completedStep);

                    publishRunningTrace(stepCompletedAt);

                    this.traceLogger.emit({
                        kind: 'tool_completed',
                        target: { ...target },
                        timestamp: stepCompletedAt,
                        phase: input.phase,
                        runId,
                        agentProfileId: agent.id,
                        toolStep: canonicalClone(completedStep),
                    });
                    input.onToolComplete?.(completedStep);

                    // Append tool result (including structured self-healing errors & strict `_turn_state`)
                    const rawToolResultContent = strictToolLoop
                        ? decorateStrictToolResult(
                            execResult.output,
                            await buildTurnState(),
                            duplicateReadWarning,
                        )
                        : execResult.output;

                    const canEditVariables =
                        allCanonicalToolNames.includes('patch_variables')
                        || canWritePath('/state/variables.json');
                    const preSendTool = await transformToolResultBeforeSend({
                        bridge: this.bridge,
                        toolName: toolCall.name,
                        toolCallId: toolCall.id,
                        toolArgs: parsedArgs,
                        outputText: rawToolResultContent,
                        ok: execResult.ok,
                        sessionId: runId,
                        agentId: agent.id,
                        phase: input.phase,
                        target,
                        canEditVariables,
                        alreadyTransformedByVfs: true,
                        vars: workingVars,
                        sessionBag: transformSessionBag,
                        signal,
                    });

                    const toolResultMsg: CanonicalMessage = {
                        role: 'tool',
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        content: preSendTool.text,
                    };
                    turnMessages.push(toolResultMsg);
                    turnTransformStates.push(preSendTool.transformState);
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
                currentAssembled = await refreshFloatingAndReassembleInFlight();
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
        onInternalTextDelta?: (delta: string) => void;
        onInternalReasoningDelta?: (delta: string) => void;
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
                        params.onInternalTextDelta?.(delta);
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
                        params.onInternalReasoningDelta?.(delta);
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
        lorebookNames?: readonly string[];
        target: MessageTarget;
        connection: ApiConnection;
        presetFiles: Record<string, string>;
        sandbox?: ScriptSandbox;
        sandboxScope: string;
        createdSandboxIds: string[];
        signal: AbortSignal;
    }): Promise<{ registry: ToolRegistry; autoAttachedToolNames: string[] }> {
        const registry = this.baseToolRegistry.clone();
        const autoAttachedToolNames: string[] = [];
        const sandbox = params.sandbox ?? this.sandbox;

        // 1. Register preset customTools allowed for this agent
        let customIdx = 0;
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
            if (custom.kind === 'js' && !sandbox) {
                continue;
            }
            try {
                let sandboxId: string | undefined;
                if (custom.kind === 'js') {
                    sandboxId = `${params.sandboxScope}:custom:${customIdx++}:${custom.id?.trim() || custom.name?.trim() || 'tool'}`;
                    params.createdSandboxIds.push(sandboxId);
                }
                const compiled = await compileCustomToolConfig(custom, sandbox, {
                    ...(sandboxId ? { sandboxId } : {}),
                    signal: params.signal,
                });
                for (const tool of compiled) {
                    registry.register(tool, { replace: true });
                }
            } catch (error) {
                console.warn(
                    `[ST-Agentic] Failed to compile custom tool "${custom.name || custom.id}":`,
                    error,
                );
            }
        }

        // 2. Register @@tool World Info entries when ScriptSandbox is available
        const rawLore = unwrapRawLoreEntries(params.loreEntries);
        if (sandbox) {
            const triggerWorldSet = new Set(
                (params.lorebookNames ?? []).map((n) => n.trim()).filter(Boolean),
            );
            let loreIdx = 0;
            for (const entry of rawLore) {
                if (entry.disable) {
                    continue;
                }
                const parsed = DecoratorParser.parseEntry(entry);
                if (!parsed.decorators.some((d) => d.name === '@@tool')) {
                    continue;
                }
                try {
                    const sandboxId = `${params.sandboxScope}:lore:${loreIdx++}:${entry.world}:${entry.uid}`;
                    params.createdSandboxIds.push(sandboxId);
                    const compiled = await compileLoreToolEntry(entry, sandbox, {
                        sandboxId,
                        signal: params.signal,
                    });
                    const entryWorld = entry.world?.trim() ?? '';
                    const shouldAutoAttach =
                        params.parentPhase === 'main_turn'
                        || (entryWorld.length > 0 && triggerWorldSet.has(entryWorld));
                    for (const tool of compiled) {
                        registry.register(tool, { replace: true });
                        if (shouldAutoAttach) {
                            autoAttachedToolNames.push(tool.name);
                        }
                    }
                } catch (error) {
                    console.warn(
                        `[ST-Agentic] Failed to compile @@tool "${entry.world}/${entry.uid}":`,
                        error,
                    );
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

        const sourceWorld = desc.sourceEntry?.world?.trim();
        try {
            const childResult = await this.run({
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
                macroOverrides: {
                    triggerPrompt: desc.instructions.trim(),
                    triggerLabel: desc.name,
                    triggerId: childProfile.id,
                    triggerPhase: parentParams.parentPhase,
                    triggerTargetPath: '',
                },
                ...(sourceWorld
                    ? { triggerSource: 'worldinfo' as const, lorebookNames: [sourceWorld] }
                    : {}),
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
