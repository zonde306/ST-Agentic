import { FinishTurnStreamExtractor } from '@/core/agents';
import type {
    HostBridge,
    LLMRequest,
    LLMToolChoice,
    LLMTransport,
    OutputProcessResult,
    ToolSideCluesApi,
    ToolSideGenApi,
} from '@/core/bridge';
import {
    DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS,
    formatOutputFixFeedback,
    runOutputProcess,
} from '@/core/bridge';
import {
    DEFAULT_CONNECTION_ID,
    resolveActivePreset,
    selectPresetBlocksForContext,
} from '@/core/config';
import {
    type RegexSource,
    type Layer1TurnGroup,
    TrajectoryStore,
    applyIngestRegexText,
    buildAutoPromptMacroOverrides,
    buildSideGenMacroOverrides,
    estimateRequestTokens,
    extractAutoPromptMacroKeys,
    groupLayer1Turns,
    renderPromptBlocks,
} from '@/core/context';
import {
    RegexPipeline,
    applyRegexRulesWithReport,
    type RegexSender,
} from '@/core/regex';
import {
    LLMTransportError,
    ROUND_RETRY_ERROR_CODES,
    computeRoundRetryDelayMs,
    delayWithAbort,
    isAbortError,
    isLengthFinishReason,
    isRetryableRoundError,
    isValidJsonObjectString,
} from '@/core/llm';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    VARIABLES_DOC_KEY,
} from '@/core/store';
import {
    type AgentRunTrace,
    type ApiConnection,
    type CanonicalContentPart,
    type CanonicalMessage,
    type CanonicalToolCall,
    type CanonicalToolSchema,
    type CreateSideSessionOptions,
    type MessageTarget,
    type Settings,
    type SideClueDelivery,
    type SideGenOnceOptions,
    type SideGenResult,
    type SideGenSendOptions,
    type SideSessionAutoBridge,
    type SideSessionConfig,
    type SideSessionFilter,
    type SideSessionInfo,
    type SideSessionTranscriptEntry,
    type TokenUsage,
    toBranchKey,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';
import {
    SideCluesFacade,
    type SideClueStorageAdapter,
    type SideClueVfsLike,
    normalizeSideCluePath,
} from './side-clues-facade';
import {
    DEFAULT_SIDE_SESSION_WATERMARK,
    type SideSessionRollbackOptions,
    type SideSessionRollbackResult,
    SideSessionStore,
    toSideThreadId,
} from './side-session-store';

export type SideCompactionSummarizer = (
    chunkText: string,
    signal?: AbortSignal,
) => Promise<string> | string;

export interface SideGenRoundRetryOptions {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
}

export interface SideGenServiceOptions {
    bridge: HostBridge;
    transport: LLMTransport;
    trajectoryStore?: TrajectoryStore;
    sessionStore?: SideSessionStore;
    dataStore?: ChatDataStore;
    clues?: SideCluesFacade;
    vfs?: SideClueVfsLike;
    clueStorage?: SideClueStorageAdapter;
    getDefaultConnectionId?: () => string;
    getSettings?: () => Settings | undefined;
    resolveConnection?: (connectionId: string) => ApiConnection | undefined;
    regexPipeline?: RegexPipeline | (() => RegexSource | undefined);
    defaultDelivery?: SideClueDelivery;
    defaultWatermark?: { high: number; low: number };
    summarizeCompaction?: SideCompactionSummarizer;
    roundRetry?: SideGenRoundRetryOptions;
    onTrace?: (trace: AgentRunTrace) => void;
    now?: () => number;
    generateId?: () => string;
}

interface SideGenRoundOutput {
    content: string;
    reasoningContent: string;
    toolCalls: CanonicalToolCall[];
    usage: TokenUsage;
    finishReason?: string;
}

const MAX_CACHE_BREAKPOINTS = 4;
const SIDE_SUMMARY_TAG = '<side-session-summary';
const MAX_SUMMARY_SNIPPET_CHARS = 160;
const MAX_DETERMINISTIC_SUMMARY_CHARS = 1200;
const DEFAULT_SIDEGEN_ROUND_MAX_RETRIES = 2;
const MAX_SIDEGEN_STRICT_ROUNDS = 4;

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
                description: 'Final Markdown response to return.',
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
        // Return empty object when malformed.
    }
    return {};
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
    baseMessages: CanonicalMessage[],
): string {
    if (activeTailMessages.length > 0) {
        const lastTail = activeTailMessages[activeTailMessages.length - 1];
        if (isTrailingPrefillAssistantMessage(lastTail)) {
            const popped = activeTailMessages.pop()!;
            return contentToText(popped.content);
        }
        return '';
    }
    if (inFlightMessages.length > 0) {
        const lastInFlight = inFlightMessages[inFlightMessages.length - 1];
        if (isTrailingPrefillAssistantMessage(lastInFlight)) {
            const popped = inFlightMessages.pop()!;
            return contentToText(popped.content);
        }
        return '';
    }
    if (baseMessages.length > 0) {
        const lastBase = baseMessages[baseMessages.length - 1];
        if (isTrailingPrefillAssistantMessage(lastBase)) {
            const popped = baseMessages.pop()!;
            return contentToText(popped.content);
        }
    }
    return '';
}

function peekTrailingPrefill(
    activeTailMessages: readonly CanonicalMessage[],
    inFlightMessages: readonly CanonicalMessage[],
    baseMessages: readonly CanonicalMessage[],
): string {
    if (activeTailMessages.length > 0) {
        const lastTail = activeTailMessages[activeTailMessages.length - 1];
        return isTrailingPrefillAssistantMessage(lastTail)
            ? contentToText(lastTail.content)
            : '';
    }
    if (inFlightMessages.length > 0) {
        const lastInFlight = inFlightMessages[inFlightMessages.length - 1];
        return isTrailingPrefillAssistantMessage(lastInFlight)
            ? contentToText(lastInFlight.content)
            : '';
    }
    if (baseMessages.length > 0) {
        const lastBase = baseMessages[baseMessages.length - 1];
        return isTrailingPrefillAssistantMessage(lastBase)
            ? contentToText(lastBase.content)
            : '';
    }
    return '';
}

function createAbortError(message: string = 'SideGen operation aborted'): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

function throwIfAborted(signal?: AbortSignal, message?: string): void {
    if (signal?.aborted) {
        throw createAbortError(message);
    }
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

function deriveCompactSummary(text: string, maxChars: number = MAX_SUMMARY_SNIPPET_CHARS): string {
    const singleLine = text.replace(/\s+/g, ' ').trim();
    if (singleLine.length <= maxChars) {
        return singleLine;
    }
    return `${singleLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function formatCacheHitRate(inputTokens: number, cachedTokens: number): string {
    if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
        return '0.0%';
    }
    const clampedCached = Math.max(0, Math.min(inputTokens, cachedTokens));
    return `${((clampedCached / inputTokens) * 100).toFixed(1)}%`;
}

function normalizeWatermark(
    requested: { high: number; low: number } | undefined,
    fallback: { high: number; low: number },
): { high: number; low: number } {
    const rawHigh =
        requested && Number.isFinite(requested.high) && requested.high > 0
            ? Math.floor(requested.high)
            : fallback.high;
    const rawLow =
        requested && Number.isFinite(requested.low) && requested.low > 0
            ? Math.floor(requested.low)
            : Math.min(fallback.low, Math.max(1, Math.floor(rawHigh / 2)));
    const low = rawLow < rawHigh ? rawLow : Math.max(1, Math.floor(rawHigh / 2));
    return { high: rawHigh, low };
}

function extractPriorSummaryBody(headerMessages: readonly CanonicalMessage[]): string {
    for (const msg of headerMessages) {
        if (msg.role !== 'system' || typeof msg.content !== 'string') {
            continue;
        }
        if (!msg.content.startsWith(SIDE_SUMMARY_TAG)) {
            continue;
        }
        const match = /^<side-session-summary[^>]*>\n?([\s\S]*?)\n?<\/side-session-summary>$/.exec(
            msg.content.trim(),
        );
        if (match?.[1]?.trim()) {
            return match[1].trim();
        }
    }
    return '';
}

function renderTurnsForSummarizer(turns: readonly Layer1TurnGroup[]): string {
    const lines: string[] = [];
    turns.forEach((turn, idx) => {
        lines.push(`## Turn ${idx + 1}`);
        for (const msg of turn.messages) {
            const text = contentToText(msg.content).trim();
            if (!text) {
                continue;
            }
            lines.push(`[${msg.role}]: ${text}`);
        }
        lines.push('');
    });
    return lines.join('\n').trim();
}

function buildDeterministicSideSummary(
    chunkNumber: number,
    turns: readonly Layer1TurnGroup[],
    priorSummary: string,
): string {
    const lines: string[] = [];
    if (priorSummary.trim()) {
        const trimmedPrior = priorSummary.trim();
        const cappedPrior =
            trimmedPrior.length > Math.floor(MAX_DETERMINISTIC_SUMMARY_CHARS / 2)
                ? trimmedPrior.slice(-Math.floor(MAX_DETERMINISTIC_SUMMARY_CHARS / 2))
                : trimmedPrior;
        lines.push(cappedPrior);
    }

    const digestLines: string[] = [];
    turns.forEach((turn, idx) => {
        const userMsg = turn.messages.find((m) => m.role === 'user');
        const assistantMsgs = turn.messages.filter((m) => m.role === 'assistant');
        const lastAssistant = assistantMsgs[assistantMsgs.length - 1];
        const u = userMsg ? deriveCompactSummary(contentToText(userMsg.content), 80) : '';
        const a = lastAssistant ? deriveCompactSummary(contentToText(lastAssistant.content), 100) : '';
        digestLines.push(`- [C${chunkNumber}.T${idx + 1}] ${u} => ${a}`);
    });

    lines.push(...digestLines);
    const combined = lines.join('\n').trim();
    if (combined.length <= MAX_DETERMINISTIC_SUMMARY_CHARS) {
        return combined;
    }
    return combined.slice(-MAX_DETERMINISTIC_SUMMARY_CHARS);
}

function formatSideSummaryMessage(
    sessionId: string,
    chunkNumber: number,
    summaryText: string,
): CanonicalMessage {
    return {
        role: 'system',
        content: [
            `<side-session-summary session="${sessionId}" chunk="${chunkNumber}">`,
            summaryText.trim(),
            '</side-session-summary>',
        ].join('\n'),
    };
}

function computeSideCacheBreakpoints(
    layer0Count: number,
    layer0EndIndex: number,
    layer1Count: number,
    turnEndCounts: readonly number[],
): number[] {
    const breakpoints: number[] = [];
    const seen = new Set<number>();
    const addPoint = (idx: number) => {
        if (idx >= 0 && !seen.has(idx)) {
            seen.add(idx);
            breakpoints.push(idx);
        }
    };

    if (layer0Count > 0 && layer0EndIndex >= 0) {
        addPoint(layer0EndIndex);
    }

    if (layer1Count > 0) {
        const layer1EndIndex = layer0Count + layer1Count - 1;
        const candidateIndices: number[] = [];
        for (const count of turnEndCounts) {
            const globalIdx = layer0Count + count - 1;
            if (globalIdx > layer0EndIndex && globalIdx <= layer1EndIndex) {
                candidateIndices.push(globalIdx);
            }
        }
        if (
            layer1EndIndex > layer0EndIndex
            && candidateIndices[candidateIndices.length - 1] !== layer1EndIndex
        ) {
            candidateIndices.push(layer1EndIndex);
        }

        const remainingBudget = Math.max(0, MAX_CACHE_BREAKPOINTS - breakpoints.length);
        const tailCandidates =
            candidateIndices.length > remainingBudget
                ? candidateIndices.slice(-remainingBudget)
                : candidateIndices;
        for (const idx of tailCandidates) {
            addPoint(idx);
        }
    }

    return breakpoints;
}

/**
 * Off-mainline SideGen Core Runtime implementing `ToolSideGenApi`.
 *
 * - `runOnce`: stateless zero-residue generation with optional read-only main chat / vars snapshot
 *   and optional `/side/*` clue bridging.
 * - `createSession` / `send`: persistent off-mainline conversation reusing `TrajectoryStore`
 *   (`side:<sessionId>`) with frozen Layer 0 prefix, explicit cache breakpoints, independent
 *   high/low watermark compaction, optional `autoBridge`, and causal branch rollback safety.
 * - `clues`: branch-safe `/side/*` clue facade (`ToolSideCluesApi`) with World Info export.
 */
export class SideGenService implements ToolSideGenApi {
    public readonly clues: ToolSideCluesApi;
    public readonly sessionStore: SideSessionStore;
    public readonly trajectoryStore: TrajectoryStore;

    private readonly bridge: HostBridge;
    private readonly transport: LLMTransport;
    private readonly dataStore: ChatDataStore;
    private readonly getDefaultConnectionIdFn?: () => string;
    private readonly getSettingsFn?: () => Settings | undefined;
    private readonly resolveConnectionFn?: (connectionId: string) => ApiConnection | undefined;
    private readonly regexProvider?: RegexPipeline | (() => RegexSource | undefined);
    private readonly defaultWatermark: { high: number; low: number };
    private readonly summarizeCompactionFn?: SideCompactionSummarizer;
    private readonly roundRetryOptions?: SideGenRoundRetryOptions;
    private readonly onTraceFn?: (trace: AgentRunTrace) => void;
    private readonly nowFn: () => number;
    private readonly generateIdFn: () => string;

    private serviceAbortController = new AbortController();
    private readonly inFlightControllers = new Set<AbortController>();
    private idCounter = 0;

    constructor(options: SideGenServiceOptions) {
        this.bridge = options.bridge;
        this.transport = options.transport;
        this.dataStore = options.dataStore ?? new ChatDataStore(options.bridge);

        this.sessionStore =
            options.sessionStore
            ?? new SideSessionStore({
                bridge: options.bridge,
                trajectoryStore: options.trajectoryStore,
                now: options.now,
            });
        this.trajectoryStore = this.sessionStore.trajectoryStore;

        this.clues =
            options.clues
            ?? new SideCluesFacade({
                bridge: options.bridge,
                store: this.dataStore,
                vfs: options.vfs,
                storage: options.clueStorage,
                defaultDelivery: options.defaultDelivery,
                resolveAnchor: () => this.resolveCurrentAnchor(),
                now: options.now,
            });

        this.getDefaultConnectionIdFn = options.getDefaultConnectionId;
        this.getSettingsFn = options.getSettings;
        this.resolveConnectionFn = options.resolveConnection;
        this.regexProvider = options.regexPipeline;
        this.defaultWatermark = normalizeWatermark(
            options.defaultWatermark,
            { ...DEFAULT_SIDE_SESSION_WATERMARK },
        );
        this.summarizeCompactionFn = options.summarizeCompaction;
        this.roundRetryOptions = options.roundRetry;
        this.onTraceFn = options.onTrace;
        this.nowFn = options.now ?? (() => Date.now());
        this.generateIdFn =
            options.generateId
            ?? (() => {
                this.idCounter += 1;
                return `side_${Math.floor(this.nowFn()).toString(36)}_${this.idCounter}`;
            });
    }

    /**
     * Abort all currently in-flight SideGen requests (used on cancel, swipe, regenerate,
     * or chat switch) and rotate the service-level controller for future requests.
     */
    abortAll(reason?: string): void {
        const prev = this.serviceAbortController;
        this.serviceAbortController = new AbortController();
        prev.abort(reason);
        for (const ctrl of Array.from(this.inFlightControllers)) {
            ctrl.abort(reason);
        }
        this.inFlightControllers.clear();
    }

    /**
     * Causal branch switch handler: aborts all in-flight SideGen requests so no stale response
     * can commit, then rolls back `branch`-scoped sessions to the latest valid ancestor of `anchor`.
     */
    onBranchChanged(
        anchor: MessageTarget,
        opts?: SideSessionRollbackOptions,
    ): SideSessionRollbackResult {
        this.abortAll('branch_changed');
        return this.sessionStore.rollbackToAnchor(anchor, opts);
    }

    /**
     * Message deletion / hard regeneration handler: aborts in-flight requests and prunes
     * `branch`-scoped session checkpoints at and after `messageId`.
     */
    onMessagesPruned(messageId: number): number {
        this.abortAll('messages_pruned');
        return this.sessionStore.pruneFromMessage(messageId);
    }

    /**
     * Chat switch handler: aborts in-flight requests and reloads persisted sessions from
     * the newly active chat metadata.
     */
    onChatChanged(opts: { reloadTrajectory?: boolean } = {}): void {
        this.abortAll('chat_changed');
        this.sessionStore.reloadFromHost({ reloadTrajectory: opts.reloadTrajectory ?? false });
    }

    /**
     * Stateless one-shot off-mainline generation.
     * Zero `TrajectoryStore` thread created, zero writes to main chat.
     * Optionally bridges the output to `/side/*` when `opts.bridge` is specified.
     */
    async runOnce(opts: SideGenOnceOptions): Promise<SideGenResult> {
        const startedAt = this.nowFn();
        const startAnchor = this.resolveCurrentAnchor();
        const startMetadataRef = this.bridge.getMetadata();
        const { signal, cleanup } = this.createLinkedSignal(opts.signal);

        try {
            throwIfAborted(signal, 'SideGen runOnce aborted before request');

            const { connectionId, connection } = this.resolveRequestConnection(opts.connectionId);
            const ingestedPrompt = this.applyIngestRegex(opts.prompt, 'user');
            const presetPrompts = await this.resolvePresetPromptMessages('once', startAnchor, {
                historyMessages: [],
                currentPrompt: ingestedPrompt,
                generationType: 'quiet',
                connection,
                systemPrompt: opts.systemPrompt ?? '',
            });
            const baseMessages: CanonicalMessage[] = [];
            if (!presetPrompts.suppressAutoSystemPrompt && opts.systemPrompt && opts.systemPrompt.trim()) {
                baseMessages.push({
                    role: 'system',
                    content: opts.systemPrompt.trim(),
                });
            }
            for (const msg of presetPrompts.prefixMessages) {
                baseMessages.push(canonicalClone(msg));
            }

            const userContent = this.composeUserContent(
                ingestedPrompt,
                opts.mainChatDepth,
                opts.includeVars,
                startAnchor,
            );
            baseMessages.push({
                role: 'user',
                content: userContent,
            });

            const turnResult = await this.executeSideGenTurn({
                connectionId,
                connection,
                baseMessages,
                tailMessages: presetPrompts.tailMessages,
                anchor: startAnchor,
                signal,
            });

            // Re-check abort, chat switch, and branch anchor (when bridging) before committing.
            throwIfAborted(signal, 'SideGen runOnce aborted before commit');
            if (this.bridge.getMetadata() !== startMetadataRef) {
                throw createAbortError('SideGen runOnce aborted: active chat changed');
            }

            const ingestedText = this.applyIngestRegex(turnResult.text, 'assistant');
            const displayText = this.applyDisplayRegex(turnResult.text, 'assistant');

            let bridgedPath: string | undefined;
            if (opts.bridge) {
                this.assertAnchorUnchanged(startAnchor, 'runOnce bridge commit');
                const written = await this.clues.write({
                    path: opts.bridge.path,
                    body: ingestedText,
                    delivery: opts.bridge.delivery,
                    title: opts.bridge.title,
                    keywords: opts.bridge.keywords,
                    summary: opts.bridge.summary ?? deriveCompactSummary(ingestedText),
                    anchor: toBranchKey(startAnchor),
                    target: startAnchor,
                });
                bridgedPath = written.path;
            }

            const durationMs = Math.max(0, Math.floor(this.nowFn() - startedAt));
            this.emitTrace({
                kind: 'sidegen_once',
                target: startAnchor,
                connectionId,
                model: connection?.model ?? '',
                startedAt,
                durationMs,
                usage: turnResult.usage,
                outputPreview: displayText.slice(0, 200),
                request: turnResult.request,
            });

            return {
                text: displayText,
                ...(bridgedPath ? { bridgedPath } : {}),
                usage: {
                    inputTokens: turnResult.usage.inputTokens,
                    cachedTokens: turnResult.usage.cachedTokens,
                    outputTokens: turnResult.usage.outputTokens,
                },
                durationMs,
            };
        } finally {
            cleanup();
        }
    }

    /** Create a persistent off-mainline `SideSession` with a frozen Layer 0 `systemPrompt`. */
    async createSession(opts: CreateSideSessionOptions): Promise<SideSessionInfo> {
        const id = opts.id?.trim() || this.generateIdFn();
        if (!id) {
            throw new Error('SideSession id must not be empty');
        }
        if (this.sessionStore.hasSession(id)) {
            throw new Error(`SideSession already exists: ${id}`);
        }

        const now = Math.floor(this.nowFn());
        const anchor = this.resolveCurrentAnchor();
        const scope = opts.scope === 'chat' ? 'chat' : 'branch';
        const watermark = normalizeWatermark(opts.watermark, this.defaultWatermark);
        const autoBridge = this.normalizeAutoBridge(opts.autoBridge);
        const systemPrompt = opts.systemPrompt ?? '';
        const threadId = toSideThreadId(id);

        const { connection } = this.resolveRequestConnection(opts.connectionId);
        const presetPrompts = await this.resolvePresetPromptMessages('session', anchor, {
            skipTail: true,
            historyMessages: [],
            generationType: 'normal',
            connection,
            systemPrompt,
        });
        const layer0Messages = this.buildLayer0Messages(
            presetPrompts.suppressAutoSystemPrompt ? '' : systemPrompt,
            presetPrompts.prefixMessages,
        );
        const initialTools = connection?.strictToolLoop
            ? [canonicalClone(FINISH_TURN_TOOL_SCHEMA)]
            : [];
        this.trajectoryStore.ensureThread(threadId);
        this.trajectoryStore.setFrozenPrefix(
            {
                tools: initialTools,
                messages: layer0Messages,
                layer0EndIndex: layer0Messages.length - 1,
            },
            threadId,
        );

        const estimatedTokens = estimateRequestTokens(layer0Messages, initialTools);
        const config: SideSessionConfig = {
            id,
            title: opts.title.trim() || id,
            scope,
            systemPrompt,
            connectionId: opts.connectionId?.trim() || 'inherit',
            watermark,
            ...(autoBridge ? { autoBridge } : {}),
            anchor,
            turns: 0,
            estimatedTokens,
            createdAt: now,
            updatedAt: now,
        };

        return this.sessionStore.saveSession(config, {
            recordCheckpoint: scope === 'branch',
            checkpointTarget: anchor,
        });
    }

    /**
     * Send a turn to a persistent off-mainline `SideSession`.
     * Preserves frozen Layer 0 prefix & append-only Layer 1 history, computes explicit
     * cache breakpoints, triggers independent watermark compaction when `>= watermark.high`,
     * and optionally updates the configured `autoBridge` `/side/*` clue.
     */
    async send(
        sessionId: string,
        prompt: string,
        opts: SideGenSendOptions = {},
    ): Promise<SideGenResult> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`SideSession not found: ${sessionId}`);
        }

        const startedAt = this.nowFn();
        const startAnchor = this.resolveCurrentAnchor();
        const startMetadataRef = this.bridge.getMetadata();
        const { signal, cleanup } = this.createLinkedSignal(opts.signal);
        const threadId = toSideThreadId(session.id);

        try {
            throwIfAborted(signal, `SideGen send(${sessionId}) aborted before request`);

            const { connectionId, connection } = this.resolveRequestConnection(
                opts.connectionId ?? session.connectionId,
            );
            const ingestedPrompt = this.applyIngestRegex(prompt, 'user');
            const hasFrozenPrefix = Boolean(this.trajectoryStore.getFrozenPrefix(threadId));
            const layer1Messages = this.trajectoryStore
                .getMessages(threadId)
                .map((m) => canonicalClone(m));
            const presetPrompts = await this.resolvePresetPromptMessages('session', startAnchor, {
                skipPrefix: hasFrozenPrefix,
                historyMessages: layer1Messages,
                currentPrompt: ingestedPrompt,
                generationType: 'normal',
                connection,
                systemPrompt: session.systemPrompt,
            });
            const layer0Messages = await this.ensureFrozenLayer0(
                threadId,
                presetPrompts.suppressAutoSystemPrompt ? '' : session.systemPrompt,
                presetPrompts.prefixMessages,
                startAnchor,
                connection,
            );

            const userContent = this.composeUserContent(
                ingestedPrompt,
                opts.mainChatDepth,
                opts.includeVars,
                startAnchor,
            );
            const userMessage: CanonicalMessage = {
                role: 'user',
                content: userContent,
            };

            const baseMessages: CanonicalMessage[] = [
                ...layer0Messages.map((m) => canonicalClone(m)),
                ...layer1Messages,
                canonicalClone(userMessage),
            ];

            const cacheBreakpoints = computeSideCacheBreakpoints(
                layer0Messages.length,
                layer0Messages.length - 1,
                layer1Messages.length,
                this.trajectoryStore.getTurnEndCounts(threadId),
            );

            const turnResult = await this.executeSideGenTurn({
                connectionId,
                connection,
                baseMessages,
                tailMessages: presetPrompts.tailMessages,
                cacheBreakpoints: cacheBreakpoints.length > 0 ? cacheBreakpoints : undefined,
                sessionId,
                anchor: startAnchor,
                signal,
            });

            // Guard against abort, chat switch, or branch divergence before committing ANY state.
            throwIfAborted(signal, `SideGen send(${sessionId}) aborted before commit`);
            if (this.bridge.getMetadata() !== startMetadataRef) {
                throw createAbortError(`SideGen send(${sessionId}) aborted: active chat changed`);
            }
            if (session.scope === 'branch') {
                this.assertAnchorUnchanged(startAnchor, `send(${sessionId}) commit`);
            }
            if (!this.sessionStore.hasSession(session.id)) {
                throw createAbortError(`SideGen send(${sessionId}) aborted: session was deleted`);
            }

            const ingestedText = this.applyIngestRegex(turnResult.text, 'assistant');
            const displayText = this.applyDisplayRegex(turnResult.text, 'assistant');

            // Persist clean unwrapped assistant message (zero `finish_turn` pseudo tool-calls/results).
            const assistantMessage: CanonicalMessage = {
                role: 'assistant',
                content: ingestedText,
                ...(turnResult.reasoningContent
                    ? { reasoningContent: turnResult.reasoningContent }
                    : {}),
            };

            // Append finalized turn to TrajectoryStore (immutable Layer 1 append).
            this.trajectoryStore.appendTurn([userMessage, assistantMessage], threadId);

            let estimatedTokens = estimateRequestTokens(
                [...layer0Messages, ...this.trajectoryStore.getMessages(threadId)],
                turnResult.request.tools,
            );

            // Automatic independent off-mainline compaction when reaching watermark.high.
            if (estimatedTokens >= session.watermark.high) {
                const compaction = await this.compactThreadInternal(
                    session,
                    layer0Messages,
                    { force: false, signal, startAnchor, startMetadataRef },
                );
                estimatedTokens = compaction.estimatedTokens;
            }

            // Re-check abort/anchor after potential async compaction before persisting.
            throwIfAborted(signal, `SideGen send(${sessionId}) aborted after compaction`);
            if (this.bridge.getMetadata() !== startMetadataRef) {
                throw createAbortError(`SideGen send(${sessionId}) aborted: active chat changed`);
            }
            if (session.scope === 'branch') {
                this.assertAnchorUnchanged(startAnchor, `send(${sessionId}) persist`);
            }

            const updatedConfig: SideSessionConfig = {
                ...session,
                anchor: startAnchor,
                turns: session.turns + 1,
                estimatedTokens,
                lastCacheHitRate: formatCacheHitRate(
                    turnResult.usage.inputTokens,
                    turnResult.usage.cachedTokens,
                ),
                updatedAt: Math.floor(this.nowFn()),
            };

            this.sessionStore.saveSession(updatedConfig, {
                recordCheckpoint: updatedConfig.scope === 'branch',
                checkpointTarget: startAnchor,
            });

            let bridgedPath: string | undefined;
            if (updatedConfig.autoBridge) {
                bridgedPath = await this.applyAutoBridge(
                    updatedConfig,
                    ingestedPrompt,
                    ingestedText,
                    startAnchor,
                );
            }

            const durationMs = Math.max(0, Math.floor(this.nowFn() - startedAt));
            this.emitTrace({
                kind: 'sidegen_session',
                sessionId: updatedConfig.id,
                target: startAnchor,
                connectionId,
                model: connection?.model ?? '',
                startedAt,
                durationMs,
                usage: turnResult.usage,
                outputPreview: displayText.slice(0, 200),
                request: turnResult.request,
            });

            return {
                text: displayText,
                sessionId: updatedConfig.id,
                ...(bridgedPath ? { bridgedPath } : {}),
                usage: {
                    inputTokens: turnResult.usage.inputTokens,
                    cachedTokens: turnResult.usage.cachedTokens,
                    outputTokens: turnResult.usage.outputTokens,
                },
                durationMs,
            };
        } finally {
            cleanup();
        }
    }

    async getSession(sessionId: string): Promise<SideSessionInfo | null> {
        return this.sessionStore.getSession(sessionId);
    }

    async listSessions(filter?: SideSessionFilter): Promise<SideSessionInfo[]> {
        return this.sessionStore.listSessions(filter);
    }

    async getTranscript(sessionId: string): Promise<SideSessionTranscriptEntry[]> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            return [];
        }

        const threadId = toSideThreadId(session.id);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        const layer0 = frozen?.messages ?? this.buildLayer0Messages(session.systemPrompt);
        const layer1 = this.trajectoryStore.getMessages(threadId);
        const all = [...layer0, ...layer1];

        const transcript: SideSessionTranscriptEntry[] = [];
        for (const msg of all) {
            if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
                transcript.push({
                    role: msg.role,
                    content: contentToText(msg.content),
                });
            }
        }
        return transcript;
    }

    async compactSession(
        sessionId: string,
    ): Promise<{ compacted: boolean; estimatedTokens: number }> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`SideSession not found: ${sessionId}`);
        }

        const threadId = toSideThreadId(session.id);
        const startAnchor = this.resolveCurrentAnchor();
        const startMetadataRef = this.bridge.getMetadata();
        const { signal, cleanup } = this.createLinkedSignal(undefined);

        try {
            const layer0 = await this.ensureFrozenLayer0(
                threadId,
                session.systemPrompt,
                undefined,
                startAnchor,
            );
            const result = await this.compactThreadInternal(session, layer0, {
                force: true,
                signal,
                startAnchor,
                startMetadataRef,
            });

            if (result.compacted) {
                const updated: SideSessionConfig = {
                    ...session,
                    estimatedTokens: result.estimatedTokens,
                    updatedAt: Math.floor(this.nowFn()),
                };
                this.sessionStore.saveSession(updated, {
                    recordCheckpoint: updated.scope === 'branch',
                    checkpointTarget: updated.anchor,
                });
            }

            return result;
        } finally {
            cleanup();
        }
    }

    async deleteSession(sessionId: string): Promise<boolean> {
        return this.sessionStore.deleteSession(sessionId);
    }

    private async compactThreadInternal(
        session: SideSessionConfig,
        layer0Messages: readonly CanonicalMessage[],
        opts: {
            force: boolean;
            signal?: AbortSignal;
            startAnchor: MessageTarget;
            startMetadataRef: Record<string, unknown>;
        },
    ): Promise<{ compacted: boolean; estimatedTokens: number }> {
        throwIfAborted(opts.signal, `SideSession(${session.id}) compaction aborted`);
        const threadId = toSideThreadId(session.id);
        const layer1 = this.trajectoryStore.getMessages(threadId);
        const estimatedBefore = estimateRequestTokens([...layer0Messages, ...layer1], []);

        if (!opts.force && estimatedBefore < session.watermark.high) {
            return { compacted: false, estimatedTokens: estimatedBefore };
        }

        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const { headerMessages, turns } = groupLayer1Turns(
            layer1,
            headerCount > 0 ? headerCount : undefined,
        );

        // Retain at least the most recent turn so ongoing dialogue stays coherent.
        if (turns.length <= 1) {
            return { compacted: false, estimatedTokens: estimatedBefore };
        }

        const priorSummary = extractPriorSummaryBody(headerMessages);
        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);
        const nextChunk = prevChunk + 1;
        const maxArchiveTurns = turns.length - 1;

        let chosenArchiveCount = 1;
        while (chosenArchiveCount < maxArchiveTurns) {
            const previewArchived = turns.slice(0, chosenArchiveCount);
            const previewRetained = turns.slice(chosenArchiveCount).flatMap((t) => t.messages);
            const previewSummary = buildDeterministicSideSummary(
                nextChunk,
                previewArchived,
                priorSummary,
            );
            const previewHeader = formatSideSummaryMessage(session.id, nextChunk, previewSummary);
            const projected = estimateRequestTokens(
                [...layer0Messages, previewHeader, ...previewRetained],
                [],
            );
            if (projected <= session.watermark.low) {
                break;
            }
            chosenArchiveCount += 1;
        }

        const archivedTurns = turns.slice(0, chosenArchiveCount);
        const retainedTurns = turns.slice(chosenArchiveCount);

        let summaryText: string;
        if (this.summarizeCompactionFn) {
            const chunkInput = priorSummary
                ? `Prior summary:\n${priorSummary}\n\nNew archived turns:\n${renderTurnsForSummarizer(archivedTurns)}`
                : renderTurnsForSummarizer(archivedTurns);
            summaryText = (await this.summarizeCompactionFn(chunkInput, opts.signal)).trim();
            if (!summaryText) {
                summaryText = buildDeterministicSideSummary(nextChunk, archivedTurns, priorSummary);
            }
        } else {
            summaryText = buildDeterministicSideSummary(nextChunk, archivedTurns, priorSummary);
        }

        throwIfAborted(opts.signal, `SideSession(${session.id}) compaction aborted before apply`);
        if (this.bridge.getMetadata() !== opts.startMetadataRef) {
            throw createAbortError(`SideSession(${session.id}) compaction aborted: chat changed`);
        }
        if (session.scope === 'branch') {
            this.assertAnchorUnchanged(opts.startAnchor, `compact(${session.id})`);
        }

        const summaryHeader = formatSideSummaryMessage(session.id, nextChunk, summaryText);
        const compactedMessages: CanonicalMessage[] = [summaryHeader];
        const turnEndCounts: number[] = [];

        for (const turn of retainedTurns) {
            for (const msg of turn.messages) {
                compactedMessages.push(msg);
            }
            turnEndCounts.push(compactedMessages.length);
        }

        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: nextChunk,
                compactionHeaderCount: 1,
                turnEndCounts,
            },
            threadId,
        );

        const estimatedAfter = estimateRequestTokens(
            [...layer0Messages, ...this.trajectoryStore.getMessages(threadId)],
            [],
        );

        return {
            compacted: true,
            estimatedTokens: estimatedAfter,
        };
    }

    private async applyAutoBridge(
        session: SideSessionConfig,
        prompt: string,
        responseText: string,
        anchor: MessageTarget,
    ): Promise<string> {
        const autoBridge = session.autoBridge!;
        const { path } = normalizeSideCluePath(autoBridge.path);

        let body: string;
        if (autoBridge.mode === 'replace') {
            body = responseText.trim();
        } else {
            const existing = await this.clues.read(path, anchor);
            const identity = this.bridge.getActiveIdentity();
            const userLabel = identity.userName?.trim() || 'User';
            const turnBlock = [
                `- [${userLabel}]: ${prompt.trim()}`,
                `- [${session.title}]: ${responseText.trim()}`,
            ].join('\n');
            body = existing?.body?.trim()
                ? `${existing.body.trimEnd()}\n${turnBlock}`
                : turnBlock;
        }

        const summary = `${autoBridge.summaryPrefix ?? ''}${deriveCompactSummary(responseText)}`;
        const doc = await this.clues.write({
            path,
            body,
            title: autoBridge.title,
            delivery: autoBridge.delivery,
            keywords: autoBridge.keywords,
            summary,
            sourceSessionId: session.id,
            anchor: toBranchKey(anchor),
            target: anchor,
        });
        return doc.path;
    }

    private async executeSideGenTurn(params: {
        connectionId: string;
        connection?: ApiConnection;
        baseMessages: CanonicalMessage[];
        tailMessages: readonly CanonicalMessage[];
        cacheBreakpoints?: number[];
        sessionId?: string;
        anchor?: MessageTarget;
        signal: AbortSignal;
    }): Promise<{
        text: string;
        reasoningContent?: string;
        usage: TokenUsage;
        request: LLMRequest;
    }> {
        const strictToolLoop = Boolean(params.connection?.strictToolLoop);
        const tools: CanonicalToolSchema[] = strictToolLoop
            ? [canonicalClone(FINISH_TURN_TOOL_SCHEMA)]
            : [];
        const toolChoice: LLMToolChoice | undefined = strictToolLoop
            ? { mode: 'required', allowedToolNames: [FINISH_TURN_TOOL_NAME] }
            : undefined;
        const maxRoundRetries =
            typeof params.connection?.roundMaxRetries === 'number'
            && Number.isFinite(params.connection.roundMaxRetries)
                ? Math.max(0, Math.min(10, Math.floor(params.connection.roundMaxRetries)))
                : DEFAULT_SIDEGEN_ROUND_MAX_RETRIES;
        const useStream = Boolean(params.connection?.stream);
        const maxRounds = strictToolLoop ? MAX_SIDEGEN_STRICT_ROUNDS : 1;

        const baseMessages = canonicalClone(params.baseMessages);
        const inFlightMessages: CanonicalMessage[] = [];
        const activeTailMessages: CanonicalMessage[] = canonicalClone([...params.tailMessages]);
        let cumulativeUsage = normalizeUsage();
        let lastRequest!: LLMRequest;
        let nonFixRounds = 0;
        let roundIndex = 0;
        let outputFixAttempts = 0;
        const maxOutputFixAttempts = DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS;
        const outputSessionBag: Record<string, unknown> = {};
        const outputSessionId = params.sessionId ?? 'sidegen_once';

        while (nonFixRounds < maxRounds) {
            roundIndex += 1;
            throwIfAborted(params.signal, 'SideGen turn aborted before LLM call');

            const messages: CanonicalMessage[] = [
                ...canonicalClone(baseMessages),
                ...canonicalClone(inFlightMessages),
                ...canonicalClone(activeTailMessages),
            ];

            const request: LLMRequest = {
                connectionId: params.connectionId,
                ...(params.connection ? { connection: params.connection } : {}),
                messages,
                tools: canonicalClone(tools),
                ...(toolChoice ? { toolChoice: { ...toolChoice } } : {}),
                ...(params.cacheBreakpoints && params.cacheBreakpoints.length > 0
                    ? { cacheBreakpoints: [...params.cacheBreakpoints] }
                    : {}),
                stream: useStream,
                signal: params.signal,
            };
            lastRequest = request;

            let roundOutput!: SideGenRoundOutput;
            let roundRetriesUsed = 0;
            let sideTurnOutputOutcome: {
                operation: 'finish_turn' | 'plain_finish';
                result: OutputProcessResult;
            } | undefined;
            let streamedFinishResponse = '';
            let streamedFinishStepBrief = '';
            const finishTurnExtractor = strictToolLoop
                ? new FinishTurnStreamExtractor({
                      onResponseDelta: (delta) => {
                          streamedFinishResponse += delta;
                      },
                      onStepBriefDelta: (delta) => {
                          streamedFinishStepBrief += delta;
                      },
                      onSuppressed: () => {
                          streamedFinishResponse = '';
                          streamedFinishStepBrief = '';
                      },
                  })
                : undefined;

            // eslint-disable-next-line no-constant-condition
            while (true) {
                throwIfAborted(params.signal, 'SideGen round aborted');
                streamedFinishResponse = '';
                streamedFinishStepBrief = '';
                sideTurnOutputOutcome = undefined;
                finishTurnExtractor?.resetRound();

                try {
                    roundOutput = await this.invokeLLM(request, useStream, {
                        onToolCallDelta: finishTurnExtractor
                            ? (index, delta) => {
                                  finishTurnExtractor.feedToolCallDelta(index, delta);
                              }
                            : undefined,
                    });

                    if (!isLengthFinishReason(roundOutput.finishReason)) {
                        if (
                            roundOutput.toolCalls.length === 0
                            && !roundOutput.content.trim()
                        ) {
                            throw new LLMTransportError(
                                'SideGen 模型返回了空响应（EMPTY_RESPONSE）',
                                {
                                    retryable: true,
                                    code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE,
                                },
                            );
                        }
                        if (
                            request.toolChoice?.mode === 'required'
                            && roundOutput.toolCalls.length === 0
                        ) {
                            throw new LLMTransportError(
                                'SideGen 模型未按强约束要求调用工具（TOOL_CHOICE_VIOLATION）',
                                {
                                    retryable: true,
                                    code: ROUND_RETRY_ERROR_CODES.TOOL_CHOICE_VIOLATION,
                                },
                            );
                        }
                        if (
                            strictToolLoop
                            && roundOutput.toolCalls.some(
                                (tc) => !isValidJsonObjectString(tc.arguments),
                            )
                        ) {
                            throw new LLMTransportError(
                                'SideGen 模型返回了格式损坏的工具参数 JSON（MALFORMED_TOOL_CALL）',
                                {
                                    retryable: true,
                                    code: ROUND_RETRY_ERROR_CODES.MALFORMED_TOOL_CALL,
                                },
                            );
                        }
                        if (
                            strictToolLoop
                            && roundOutput.toolCalls.length === 1
                            && roundOutput.toolCalls[0].name === FINISH_TURN_TOOL_NAME
                        ) {
                            const parsedFinish = safeParseJsonObject(
                                roundOutput.toolCalls[0].arguments,
                            );
                            const candidateResp =
                                typeof parsedFinish.response === 'string'
                                    ? parsedFinish.response
                                    : '';
                            if (!candidateResp.trim()) {
                                throw new LLMTransportError(
                                    'SideGen finish_turn 缺少非空 response 参数（MALFORMED_TOOL_CALL）',
                                    {
                                        retryable: true,
                                        code: ROUND_RETRY_ERROR_CODES.MALFORMED_TOOL_CALL,
                                    },
                                );
                            }
                        }
                    }

                    if (
                        this.bridge.processOutputText
                        && !isLengthFinishReason(roundOutput.finishReason)
                    ) {
                        const isSoloFinish =
                            strictToolLoop
                            && roundOutput.toolCalls.length === 1
                            && roundOutput.toolCalls[0].name === FINISH_TURN_TOOL_NAME;
                        const isPlainFinish = !strictToolLoop && roundOutput.toolCalls.length === 0;
                        if (isSoloFinish || isPlainFinish) {
                            const prefillPrefix = peekTrailingPrefill(
                                activeTailMessages,
                                inFlightMessages,
                                baseMessages,
                            );
                            let candidateText: string;
                            if (isSoloFinish) {
                                const parsedArgs = safeParseJsonObject(
                                    roundOutput.toolCalls[0].arguments,
                                );
                                const parsedResponse =
                                    typeof parsedArgs.response === 'string'
                                        ? parsedArgs.response
                                        : '';
                                const extractedResponse =
                                    finishTurnExtractor && !finishTurnExtractor.isSuppressed()
                                        ? finishTurnExtractor.getDecodedResponse()
                                            || streamedFinishResponse
                                        : '';
                                candidateText = parsedResponse || extractedResponse;
                            } else {
                                candidateText = `${prefillPrefix}${roundOutput.content ?? ''}`;
                            }
                            const resolvedAnchor = params.anchor ?? this.resolveCurrentAnchor();
                            const res = await runOutputProcess(this.bridge, {
                                text: candidateText,
                                meta: {
                                    runner: 'sidegen',
                                    stage: 'turn_finish',
                                    operation: isSoloFinish ? 'finish_turn' : 'plain_finish',
                                    finishMode: strictToolLoop ? 'strict_tool' : 'plain_text',
                                    sessionId: outputSessionId,
                                    round: roundIndex,
                                    retryAttempt: roundRetriesUsed,
                                    maxRetries: maxRoundRetries,
                                    fixAttempt: outputFixAttempts,
                                    maxFixAttempts: maxOutputFixAttempts,
                                    target: { ...resolvedAnchor },
                                    messageId: resolvedAnchor.messageId,
                                    swipeId: resolvedAnchor.swipeId,
                                    ...(isSoloFinish
                                        ? {
                                              toolCallId: roundOutput.toolCalls[0].id,
                                              toolName: FINISH_TURN_TOOL_NAME,
                                          }
                                        : {}),
                                    surface: 'sidegen',
                                    stream: useStream,
                                    hasPrefill: prefillPrefix.length > 0,
                                    sessionBag: outputSessionBag,
                                },
                            });
                            if (
                                res.action === 'retry'
                                && roundRetriesUsed < maxRoundRetries
                            ) {
                                throw new LLMTransportError(
                                    res.retryReason ?? 'Output validation requested retry.',
                                    {
                                        retryable: true,
                                        code: ROUND_RETRY_ERROR_CODES.OUTPUT_VALIDATION_RETRY,
                                    },
                                );
                            }
                            sideTurnOutputOutcome = {
                                operation: isSoloFinish ? 'finish_turn' : 'plain_finish',
                                result: res,
                            };
                        }
                    }

                    break;
                } catch (llmError) {
                    if (isAbortError(llmError) || params.signal.aborted) {
                        throw llmError;
                    }
                    if (
                        roundRetriesUsed < maxRoundRetries
                        && isRetryableRoundError(llmError)
                    ) {
                        roundRetriesUsed += 1;
                        streamedFinishResponse = '';
                        streamedFinishStepBrief = '';
                        finishTurnExtractor?.resetRound();

                        const delayMs = computeRoundRetryDelayMs({
                            error: llmError,
                            attempt: roundRetriesUsed,
                            initialDelayMs: this.roundRetryOptions?.initialDelayMs,
                            maxDelayMs: this.roundRetryOptions?.maxDelayMs,
                            backoffFactor: this.roundRetryOptions?.backoffFactor,
                            jitterRatio: 0.25,
                        });
                        if (delayMs > 0) {
                            await delayWithAbort(delayMs, params.signal);
                        }
                        throwIfAborted(params.signal, 'SideGen retry aborted');
                        continue;
                    }
                    throw llmError;
                }
            }

            cumulativeUsage = addTokenUsage(cumulativeUsage, roundOutput.usage);

            // Multi-round Prefill (`partial: true` / `prefix: true`) auto-consumption folding:
            const consumedPrefill = consumeTrailingPrefill(
                activeTailMessages,
                inFlightMessages,
                baseMessages,
            );
            if (consumedPrefill) {
                roundOutput.content = `${consumedPrefill}${roundOutput.content}`;
            }

            if (!strictToolLoop) {
                if (
                    sideTurnOutputOutcome?.result.action === 'fix'
                    && outputFixAttempts < maxOutputFixAttempts
                ) {
                    outputFixAttempts += 1;
                    const feedback = formatOutputFixFeedback(
                        sideTurnOutputOutcome.result.fixMessage
                            ?? 'Output validation requested a revision.',
                        {
                            stage: 'turn_finish',
                            operation: 'plain_finish',
                            requestedBy: sideTurnOutputOutcome.result.requestedBy,
                        },
                    );
                    inFlightMessages.push(
                        {
                            role: 'assistant',
                            content: roundOutput.content ?? '',
                            ...(roundOutput.reasoningContent
                                ? { reasoningContent: roundOutput.reasoningContent }
                                : {}),
                        },
                        {
                            role: 'user',
                            content: feedback,
                        },
                    );
                    continue;
                }
                const resolvedPlainText = sideTurnOutputOutcome?.result.changed
                    ? sideTurnOutputOutcome.result.text
                    : roundOutput.content;
                return {
                    text: resolvedPlainText,
                    ...(roundOutput.reasoningContent
                        ? { reasoningContent: roundOutput.reasoningContent }
                        : {}),
                    usage: cumulativeUsage,
                    request: lastRequest,
                };
            }

            const isSoloFinishTurn =
                roundOutput.toolCalls.length === 1
                && roundOutput.toolCalls[0].name === FINISH_TURN_TOOL_NAME;

            if (isSoloFinishTurn) {
                if (
                    sideTurnOutputOutcome?.result.action === 'fix'
                    && outputFixAttempts < maxOutputFixAttempts
                ) {
                    outputFixAttempts += 1;
                    const feedback = formatOutputFixFeedback(
                        sideTurnOutputOutcome.result.fixMessage
                            ?? 'Output validation requested a revision.',
                        {
                            stage: 'turn_finish',
                            operation: 'finish_turn',
                            requestedBy: sideTurnOutputOutcome.result.requestedBy,
                        },
                    );
                    inFlightMessages.push(
                        {
                            role: 'assistant',
                            content: roundOutput.content,
                            ...(roundOutput.reasoningContent
                                ? { reasoningContent: roundOutput.reasoningContent }
                                : {}),
                            toolCalls: canonicalClone(roundOutput.toolCalls),
                        },
                        {
                            role: 'tool',
                            toolCallId: roundOutput.toolCalls[0].id,
                            toolName: FINISH_TURN_TOOL_NAME,
                            content: JSON.stringify({
                                ok: false,
                                error: feedback,
                            }),
                        },
                    );
                    continue;
                }
                const parsedArgs = safeParseJsonObject(roundOutput.toolCalls[0].arguments);
                const parsedResponse =
                    typeof parsedArgs.response === 'string' ? parsedArgs.response : '';
                const extractedResponse =
                    finishTurnExtractor && !finishTurnExtractor.isSuppressed()
                        ? finishTurnExtractor.getDecodedResponse() || streamedFinishResponse
                        : '';
                const rawFinalResponse = parsedResponse || extractedResponse;
                const finalResponse = sideTurnOutputOutcome?.result.changed
                    ? sideTurnOutputOutcome.result.text
                    : rawFinalResponse;
                const parsedStepBrief =
                    typeof parsedArgs.step_brief === 'string'
                        ? parsedArgs.step_brief
                        : finishTurnExtractor && !finishTurnExtractor.isSuppressed()
                            ? finishTurnExtractor.getDecodedStepBrief() || streamedFinishStepBrief
                            : '';
                const effectiveReasoning = roundOutput.reasoningContent || parsedStepBrief;

                return {
                    text: finalResponse,
                    ...(effectiveReasoning ? { reasoningContent: effectiveReasoning } : {}),
                    usage: cumulativeUsage,
                    request: lastRequest,
                };
            }

            // Length truncation with no valid solo finish_turn
            if (isLengthFinishReason(roundOutput.finishReason) && roundOutput.toolCalls.length === 0) {
                return {
                    text: roundOutput.content,
                    ...(roundOutput.reasoningContent
                        ? { reasoningContent: roundOutput.reasoningContent }
                        : {}),
                    usage: cumulativeUsage,
                    request: lastRequest,
                };
            }

            nonFixRounds += 1;
            // Mixed-call / unexpected tool deferral: push assistantToolMessage (no prefill flags)
            // + deferred/error tool responses and ask the model to call solo finish_turn next round.
            const assistantToolMessage: CanonicalMessage = {
                role: 'assistant',
                content: roundOutput.content,
                ...(roundOutput.reasoningContent
                    ? { reasoningContent: roundOutput.reasoningContent }
                    : {}),
                toolCalls: canonicalClone(roundOutput.toolCalls),
            };
            const roundToolResults: CanonicalMessage[] = roundOutput.toolCalls.map((tc) => ({
                role: 'tool',
                toolCallId: tc.id,
                toolName: tc.name,
                content:
                    tc.name === FINISH_TURN_TOOL_NAME
                        ? DEFERRED_FINISH_TURN_PAYLOAD
                        : JSON.stringify({
                              ok: false,
                              error: `Tool "${tc.name}" is unavailable in SideGen. Call finish_turn with your final response.`,
                          }),
            }));
            inFlightMessages.push(assistantToolMessage, ...roundToolResults);
        }

        throw new LLMTransportError(
            `SideGen strictToolLoop exceeded maximum ${maxRounds} rounds without a clean solo finish_turn.`,
            { retryable: false, code: ROUND_RETRY_ERROR_CODES.TOOL_CHOICE_VIOLATION },
        );
    }

    private async invokeLLM(
        request: LLMRequest,
        useStream: boolean,
        callbacks: {
            onToolCallDelta?: (
                index: number,
                delta: { name?: string; argumentsDelta?: string },
            ) => void;
        },
    ): Promise<SideGenRoundOutput> {
        throwIfAborted(request.signal, 'SideGen LLM call aborted');

        if (!useStream) {
            const resp = await this.transport.complete(request);
            throwIfAborted(request.signal, 'SideGen LLM call aborted');
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
            throwIfAborted(request.signal, 'SideGen stream aborted');
            if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
            } else if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoningContent += chunk.reasoningDelta;
            } else if (chunk.type === 'tool_call_delta') {
                const idx = chunk.toolCallIndex ?? 0;
                const prev = toolMap.get(idx) ?? {
                    id: `call_${Math.floor(this.nowFn())}_${idx}`,
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

    private async resolvePresetPromptMessages(
        mode: 'once' | 'session',
        anchor: MessageTarget,
        options?: {
            skipPrefix?: boolean;
            skipTail?: boolean;
            historyMessages?: readonly CanonicalMessage[];
            currentPrompt?: string;
            generationType?: 'normal' | 'quiet';
            connection?: ApiConnection;
            systemPrompt?: string;
        },
    ): Promise<{
        prefixMessages: CanonicalMessage[];
        tailMessages: CanonicalMessage[];
        suppressAutoSystemPrompt: boolean;
    }> {
        const settings = this.getSettingsFn?.();
        if (!settings) {
            return { prefixMessages: [], tailMessages: [], suppressAutoSystemPrompt: false };
        }
        const preset = resolveActivePreset(settings);
        const selected = selectPresetBlocksForContext(
            preset,
            { kind: 'sidegen', mode },
            { requireExplicit: true },
        );
        let suppressAutoSystemPrompt = false;
        for (const block of [...selected.prefix, ...selected.tail]) {
            if (extractAutoPromptMacroKeys(block.content).has('systemBase')) {
                suppressAutoSystemPrompt = true;
                break;
            }
        }

        const needPrefix = !options?.skipPrefix && selected.prefix.length > 0;
        const needTail = !options?.skipTail && selected.tail.length > 0;
        if (!needPrefix && !needTail) {
            return { prefixMessages: [], tailMessages: [], suppressAutoSystemPrompt };
        }

        const vars = this.readVarsObject(anchor);
        const baseMacroOverrides = buildSideGenMacroOverrides({
            mode,
            historyMessages: options?.historyMessages,
            currentPrompt: options?.currentPrompt,
            bridge: this.bridge,
            generationType: options?.generationType,
            connection: options?.connection,
            vars,
        });
        const macroOverrides: Record<string, string> =
            options?.systemPrompt !== undefined
                ? {
                      ...baseMacroOverrides,
                      ...buildAutoPromptMacroOverrides({
                          systemBase: options.systemPrompt,
                      }),
                  }
                : baseMacroOverrides;
        const prefixMessages = needPrefix
            ? await renderPromptBlocks(selected.prefix, {
                  hostBridge: this.bridge,
                  macroOverrides,
                  vars,
                  transformSessionId: `sidegen_${mode}`,
                  transformPhase: 'sidegen',
                  transformTarget: anchor,
                  transformLayer: 'layer0_prefix',
              })
            : [];
        const tailMessages = needTail
            ? await renderPromptBlocks(selected.tail, {
                  hostBridge: this.bridge,
                  macroOverrides,
                  vars,
                  transformSessionId: `sidegen_${mode}`,
                  transformPhase: 'sidegen',
                  transformTarget: anchor,
                  transformLayer: 'layer2_tail',
              })
            : [];

        return { prefixMessages, tailMessages, suppressAutoSystemPrompt };
    }

    private async ensureFrozenLayer0(
        threadId: string,
        systemPrompt: string,
        extraPrefixMessages?: readonly CanonicalMessage[],
        anchor?: MessageTarget,
        connection?: ApiConnection,
    ): Promise<readonly CanonicalMessage[]> {
        const existing = this.trajectoryStore.getFrozenPrefix(threadId);
        if (existing) {
            return existing.messages;
        }
        let resolvedSystemPrompt = systemPrompt;
        let resolvedExtra = extraPrefixMessages;
        if (resolvedExtra === undefined) {
            const presetPrompts = await this.resolvePresetPromptMessages(
                'session',
                anchor ?? this.resolveCurrentAnchor(),
                {
                    skipTail: true,
                    historyMessages: [],
                    generationType: 'normal',
                    connection,
                    systemPrompt,
                },
            );
            resolvedExtra = presetPrompts.prefixMessages;
            if (presetPrompts.suppressAutoSystemPrompt) {
                resolvedSystemPrompt = '';
            }
        }
        const layer0Messages = this.buildLayer0Messages(resolvedSystemPrompt, resolvedExtra);
        this.trajectoryStore.ensureThread(threadId);
        this.trajectoryStore.setFrozenPrefix(
            {
                tools: [],
                messages: layer0Messages,
                layer0EndIndex: layer0Messages.length - 1,
            },
            threadId,
        );
        return this.trajectoryStore.getFrozenPrefix(threadId)?.messages ?? layer0Messages;
    }

    private buildLayer0Messages(
        systemPrompt: string,
        extraPrefixMessages: readonly CanonicalMessage[] = [],
    ): CanonicalMessage[] {
        const messages: CanonicalMessage[] = [];
        const trimmed = systemPrompt.trim();
        if (trimmed) {
            messages.push({
                role: 'system',
                content: trimmed,
            });
        }
        for (const msg of extraPrefixMessages) {
            messages.push(canonicalClone(msg));
        }
        return messages;
    }

    private normalizeAutoBridge(
        autoBridge: SideSessionAutoBridge | undefined,
    ): SideSessionAutoBridge | undefined {
        if (!autoBridge) {
            return undefined;
        }
        const { path } = normalizeSideCluePath(autoBridge.path);
        return {
            path,
            delivery: autoBridge.delivery,
            keywords: [...autoBridge.keywords],
            title: autoBridge.title,
            mode: autoBridge.mode === 'replace' ? 'replace' : 'append',
            ...(autoBridge.summaryPrefix !== undefined
                ? { summaryPrefix: autoBridge.summaryPrefix }
                : {}),
        };
    }

    private composeUserContent(
        prompt: string,
        mainChatDepth: number | undefined,
        includeVars: boolean | undefined,
        anchor: MessageTarget,
    ): string {
        const blocks: string[] = [];

        if (typeof mainChatDepth === 'number' && Number.isFinite(mainChatDepth) && mainChatDepth > 0) {
            const chatContext = this.buildReadOnlyChatTail(Math.floor(mainChatDepth));
            if (chatContext) {
                blocks.push(chatContext);
            }
        }

        if (includeVars) {
            const varsSnapshot = this.buildReadOnlyVarsSnapshot(anchor);
            if (varsSnapshot) {
                blocks.push(varsSnapshot);
            }
        }

        blocks.push(prompt);
        return blocks.join('\n\n');
    }

    private buildReadOnlyChatTail(depth: number): string {
        const chat = this.bridge.getChat();
        if (!chat.length || depth <= 0) {
            return '';
        }

        const visible = chat.filter((msg) => !msg.isSystem);
        const tail = visible.slice(-depth);
        if (tail.length === 0) {
            return '';
        }

        const lines = tail.map((msg) => {
            const sender: Extract<RegexSender, 'user' | 'assistant'> = msg.isUser
                ? 'user'
                : 'assistant';
            const roleLabel = msg.isUser ? 'User' : 'Assistant';
            const speaker = msg.name?.trim() ? `${roleLabel} (${msg.name.trim()})` : roleLabel;
            const cleanedMes = this.applyIngestRegex(msg.mes ?? '', sender);
            return `[#${msg.id} ${speaker}]: ${cleanedMes}`;
        });
        return `<main-chat-context>\n${lines.join('\n')}\n</main-chat-context>`;
    }

    private resolveRegexSource(): RegexSource | undefined {
        if (typeof this.regexProvider === 'function') {
            return this.regexProvider();
        }
        if (this.regexProvider !== undefined) {
            return this.regexProvider;
        }
        const settings = this.getSettingsFn?.();
        return settings ? resolveActivePreset(settings).regexRules : undefined;
    }

    private applyIngestRegex(
        text: string,
        sender: Extract<RegexSender, 'user' | 'assistant'>,
    ): string {
        return applyIngestRegexText(text, sender, this.resolveRegexSource());
    }

    private applyDisplayRegex(
        text: string,
        sender: Extract<RegexSender, 'user' | 'assistant'>,
    ): string {
        if (!text) {
            return text;
        }
        const regex = this.resolveRegexSource();
        if (!regex) {
            return text;
        }
        const report = regex instanceof RegexPipeline
            ? regex.runWithReport(text, { stage: 'display', sender })
            : applyRegexRulesWithReport(text, regex, { stage: 'display', sender });
        if (report.appliedRuleIds.length === 0) {
            return text;
        }
        return this.bridge.substituteMacros(report.output);
    }

    private readVarsObject(anchor: MessageTarget): Record<string, unknown> {
        const stored = this.dataStore.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, {
            target: anchor,
            includeStaged: true,
        });

        if (stored?.content) {
            try {
                const parsed = JSON.parse(stored.content) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return canonicalClone(parsed as Record<string, unknown>);
                }
            } catch {
                // Fall through to metadata variables.
            }
        }

        const metaVars = this.bridge.getMetadata()?.variables;
        if (metaVars && typeof metaVars === 'object' && !Array.isArray(metaVars)) {
            return canonicalClone(metaVars as Record<string, unknown>);
        }

        return {};
    }

    private buildReadOnlyVarsSnapshot(anchor: MessageTarget): string {
        const varsObj = this.readVarsObject(anchor);
        if (Object.keys(varsObj).length === 0) {
            return '';
        }

        return `<main-vars-snapshot>\n${canonicalStringify(varsObj)}\n</main-vars-snapshot>`;
    }

    private resolveRequestConnection(requestedConnectionId?: string): {
        connectionId: string;
        connection?: ApiConnection;
    } {
        const normalized = requestedConnectionId?.trim();
        const connectionId =
            !normalized || normalized === 'inherit'
                ? this.getDefaultConnectionIdFn?.() || DEFAULT_CONNECTION_ID
                : normalized;
        const connection = this.resolveConnectionFn?.(connectionId);
        return {
            connectionId,
            ...(connection ? { connection: canonicalClone(connection) } : {}),
        };
    }

    private resolveCurrentAnchor(): MessageTarget {
        const chat = this.bridge.getChat();
        if (chat.length === 0) {
            return { messageId: 0, swipeId: 0 };
        }
        const lastIndex = chat.length - 1;
        return {
            messageId: lastIndex,
            swipeId: chat[lastIndex]?.swipeId ?? 0,
        };
    }

    private assertAnchorUnchanged(expected: MessageTarget, contextLabel: string): void {
        const current = this.resolveCurrentAnchor();
        if (current.messageId !== expected.messageId || current.swipeId !== expected.swipeId) {
            throw createAbortError(
                `SideGen ${contextLabel} aborted: branch anchor changed from ${toBranchKey(expected)} to ${toBranchKey(current)}`,
            );
        }
    }

    private createLinkedSignal(callerSignal?: AbortSignal): {
        signal: AbortSignal;
        cleanup: () => void;
    } {
        const controller = new AbortController();
        const serviceSignal = this.serviceAbortController.signal;
        this.inFlightControllers.add(controller);

        if (serviceSignal.aborted) {
            controller.abort(serviceSignal.reason);
        } else if (callerSignal?.aborted) {
            controller.abort(callerSignal.reason);
        }

        const onServiceAbort = () => controller.abort(serviceSignal.reason);
        const onCallerAbort = () => controller.abort(callerSignal?.reason);

        if (!controller.signal.aborted) {
            serviceSignal.addEventListener('abort', onServiceAbort, { once: true });
            callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
        }

        const cleanup = () => {
            serviceSignal.removeEventListener('abort', onServiceAbort);
            callerSignal?.removeEventListener('abort', onCallerAbort);
            this.inFlightControllers.delete(controller);
        };

        return { signal: controller.signal, cleanup };
    }

    private emitTrace(params: {
        kind: 'sidegen_once' | 'sidegen_session';
        sessionId?: string;
        target: MessageTarget;
        connectionId: string;
        model: string;
        startedAt: number;
        durationMs: number;
        usage: AgentRunTrace['usage'];
        outputPreview: string;
        request: LLMRequest;
    }): void {
        if (!this.onTraceFn) {
            return;
        }
        this.onTraceFn({
            runId: this.generateIdFn(),
            target: { ...params.target },
            phase: 'maintenance',
            agentProfileId: params.sessionId ? toSideThreadId(params.sessionId) : 'sidegen:once',
            agentName: params.sessionId ? `SideSession (${params.sessionId})` : 'SideGen Once',
            connectionId: params.connectionId,
            model: params.model,
            status: 'completed',
            startedAt: Math.floor(params.startedAt),
            endedAt: Math.floor(params.startedAt + params.durationMs),
            durationMs: params.durationMs,
            usage: { ...params.usage },
            toolSteps: [],
            outputPreview: params.outputPreview,
            offMainlineKind: params.kind,
            ...(params.sessionId ? { offMainlineSessionId: params.sessionId } : {}),
            requestSnapshot: {
                messages: canonicalClone(params.request.messages),
                tools: canonicalClone(params.request.tools),
                ...(params.request.cacheBreakpoints
                    ? { cacheBreakpoints: [...params.request.cacheBreakpoints] }
                    : {}),
            },
        });
    }
}
