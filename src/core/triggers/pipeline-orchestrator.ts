import { z } from 'zod';
import {
    AgentExecutionError,
    AgentRunner,
    DEFAULT_SUBAGENT_TOOLS,
    MaxToolRoundsError,
    TurnInterruptedError,
    type AgentGenerationErrorDecision,
    type AgentGenerationErrorHookContext,
    type AgentPostprocessResponseContext,
    type AgentPreprocessMessagesContext,
    type AgentRunResult,
    type SubAgentDescriptor,
} from '@/core/agents';
import {
    type HostBridge,
    type LLMTransport,
    type PromptInjectionSession,
    type SerializedPromptInjected,
    type ToolAgentApi,
    type ToolAgentRunOptions,
    type ToolAgentRunResult,
    type ToolAgentRunTriggerOptions,
    type ToolEphemeralMessagesApi,
    type ToolErrorRecoveryAction,
    type ToolErrorRecoveryControl,
    type ToolErrorRecoveryRetryOptions,
    type ToolEventPayload,
    type ToolExecutionContext,
    type ToolPostprocessControl,
    type ToolPostprocessOutput,
    type ToolSideGenApi,
    runPromptTransform,
} from '@/core/bridge';
import {
    createDefaultMainAgent,
    createDefaultSettings,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import {
    ContextAssembler,
    LocalPromptInjectionSession,
    TrajectoryStore,
    WatermarkCompactor,
    type ChunkSummarizer,
    type CompactionOptions,
    type WatermarkCompactionResult,
} from '@/core/context';
import { LLMTransportError } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import {
    LoreReadEvaluator,
    evaluateIfConditions,
    parseLoreRegex,
    TailRadar,
    WIClassifier,
} from '@/core/lore';
import { applyRegexRules, compileRegexPattern, RegexPipeline } from '@/core/regex';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    EJS_INJECTIONS_DOC_KEY,
    worldInfoKey,
} from '@/core/store';
import {
    compileJsonSchema,
    compileVariableSchemaEntries,
    createAbortError,
    createBuiltinToolRegistry,
    createToolExecutionContext,
    deepMergeZod,
    isAbortError,
    throwIfAborted,
    ToolRegistry,
    type ScriptSandbox,
} from '@/core/tools';
import type {
    AgentProfile,
    BarrierPolicy,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolCall,
    MessageTarget,
    PipelinePhase,
    Preset,
    RawLoreEntry,
    RegexRule,
    RoundRetryLog,
    ScopedPermissions,
    Settings,
    ToolStepLog,
    TriggerEventType,
    TriggerRule,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { OUTPUT_FILE_PATH, VirtualFileSystem } from '@/core/vfs';
import {
    BarrierCoordinator,
    type DispatchedTaskHandle,
} from './barrier-coordinator';
import {
    DecoratorCompiler,
    groupTriggersForExecution,
    mergeDerivedAgentProfiles,
    type TriggerExecutionUnit,
} from './decorator-compiler';

export type GenerationAction = 'normal' | 'swipe' | 'regenerate' | 'continue';

function mergePresetAndCompiledTriggers(
    presetTriggers: readonly TriggerRule[],
    compiledTriggers: readonly TriggerRule[],
): TriggerRule[] {
    const presetIds = new Set(presetTriggers.map((t) => t.id));
    const presetWorldUidKeys = new Set<string>();
    for (const rule of presetTriggers) {
        if (rule.source === 'worldinfo' && rule.sourceWorld && rule.sourceEntryUid !== undefined) {
            presetWorldUidKeys.add(`${rule.sourceWorld}::${rule.sourceEntryUid}`);
        }
    }
    const filteredCompiled = compiledTriggers.filter((rule) => {
        if (presetIds.has(rule.id)) {
            return false;
        }
        if (
            rule.sourceWorld
            && rule.sourceEntryUid !== undefined
            && presetWorldUidKeys.has(`${rule.sourceWorld}::${rule.sourceEntryUid}`)
        ) {
            return false;
        }
        return true;
    });
    return [...presetTriggers, ...filteredCompiled];
}

export interface PipelineOrchestratorDependencies {
    bridge: HostBridge;
    transport: LLMTransport;
    settings?: Settings | (() => Settings);
    store?: ChatDataStore;
    vfs?: VirtualFileSystem;
    trajectoryStore?: TrajectoryStore;
    contextAssembler?: ContextAssembler;
    watermarkCompactor?: WatermarkCompactor;
    toolRegistry?: ToolRegistry;
    traceLogger?: TraceLogger;
    barrierCoordinator?: BarrierCoordinator;
    agentRunner?: AgentRunner;
    decoratorCompiler?: DecoratorCompiler;
    classifier?: WIClassifier;
    loreReadEvaluator?: LoreReadEvaluator;
    tailRadar?: TailRadar;
    regexPipeline?: RegexPipeline | (() => RegexPipeline | readonly RegexRule[] | undefined);
    sandbox?: ScriptSandbox;
    sideGen?: ToolSideGenApi;
    summarizeChunk?: ChunkSummarizer;
    compactionOptions?: Partial<CompactionOptions>;
}

export interface RunTurnInput {
    action: GenerationAction;
    target: MessageTarget;
    /** Previous `swipeId` switched away from when `action === 'swipe'`. */
    previousSwipeId?: number;
    userInput?: string | CanonicalContentPart[];
    userName?: string;
    /** Internal continuation prompt appended when `action === 'continue'`. */
    continuationPrompt?: string;
    /** Existing partial reply text when `action === 'continue'`. */
    existingContent?: string;
    /** Optional explicit turn index for `'interval'` condition checks. */
    turnNumber?: number;
    signal?: AbortSignal;
    stream?: boolean;
    onTextDelta?: (delta: string) => void;
    onOutputPreview?: (previewText: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolStart?: (step: ToolStepLog) => void;
    onToolComplete?: (step: ToolStepLog) => void;
}

export interface ResumeTurnInput {
    target: MessageTarget;
    /** When true and `previousRoundSnapshot` exists, roll back the last tool round and `/output.md` before retrying. */
    rollbackLastToolRound?: boolean;
    signal?: AbortSignal;
    stream?: boolean;
    onTextDelta?: (delta: string) => void;
    onOutputPreview?: (previewText: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolStart?: (step: ToolStepLog) => void;
    onToolComplete?: (step: ToolStepLog) => void;
}

export interface ResumeTriggerTaskOptions {
    rollbackLastToolRound?: boolean;
    signal?: AbortSignal;
}

export interface CompiledTurnEnvironment {
    loreEntries: RawLoreEntry[];
    effectiveAgents: Record<string, AgentProfile>;
    derivedAgentsByRuleId: Record<string, AgentProfile>;
    allTriggers: TriggerRule[];
    subAgents: SubAgentDescriptor[];
    globalVarSchema: z.ZodTypeAny | undefined;
}

export interface EventHookRuleResult {
    ruleId: string;
    label: string;
    kind: 'agent' | 'script';
    eventType: TriggerEventType;
    target: MessageTarget;
    rawResult?: unknown;
    output: string;
    skipped?: boolean;
    error?: string;
}

export interface EventHookDispatchOptions {
    target?: MessageTarget;
    phase?: PipelinePhase;
    staged?: boolean;
    signal?: AbortSignal;
    preset?: Preset;
    env?: CompiledTurnEnvironment;
    injectionSession?: PromptInjectionSession;
    messages?: ToolEphemeralMessagesApi;
    body?: Record<string, unknown>;
    output?: ToolPostprocessOutput;
    control?: ToolErrorRecoveryControl | ToolPostprocessControl;
    isErrorRecovery?: boolean;
    shouldStop?: (result: EventHookRuleResult) => boolean;
}

export { AgentExecutionError, MaxToolRoundsError, TurnInterruptedError };

export interface TriggerExecutionResult {
    unitId: string;
    phase: PipelinePhase;
    target: MessageTarget;
    kind: 'agent' | 'script';
    triggerIds: string[];
    agentProfileId: string;
    output: string;
    skipped?: boolean;
    warning?: string;
    agentResult?: AgentRunResult;
}

export interface MaintenanceResult {
    checkedAgents: string[];
    compactedAgents: Record<string, WatermarkCompactionResult>;
}

export interface RunTurnResult {
    target: MessageTarget;
    action: GenerationAction;
    content: string;
    deltaContent: string;
    reasoningContent?: string;
    beforeTurnBrief?: string;
    beforeTurnResults: TriggerExecutionResult[];
    mainRun: AgentRunResult;
    afterTurnTasks: DispatchedTaskHandle<TriggerExecutionResult>[];
    maintenanceTasks: DispatchedTaskHandle<WatermarkCompactionResult>[];
}

const DEFAULT_CONTINUATION_PROMPT =
    '[Continue seamlessly from the end of your previous assistant message in /output.md without repeating prior text. Call read_file("/output.md") if needed, then extend or fix /output.md via append_file or edit_file before finishing.]';

function freezeTarget(target: MessageTarget): MessageTarget {
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

function contentToPlainText(input: string | CanonicalContentPart[] | undefined): string {
    if (!input) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    return input
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

function normalizeTriggerSchema(
    schemaSource: TriggerRule['schemaSource'],
    sandbox?: ScriptSandbox,
): Promise<z.ZodTypeAny | undefined> | z.ZodTypeAny | undefined {
    if (!schemaSource || !schemaSource.raw.trim()) {
        return undefined;
    }
    if (schemaSource.kind === 'json') {
        return compileJsonSchema(schemaSource.raw);
    }
    if (!sandbox) {
        throw new Error('@@zod_schema trigger requires a ScriptSandbox instance.');
    }
    return sandbox.evaluateSchema(schemaSource.raw);
}

/**
 * Four-phase Pipeline Orchestrator (`before_turn` -> `main_turn` -> `after_turn` -> `maintenance`)
 * implementing `normal`, `swipe`, `regenerate`, and `continue` causal branch semantics,
 * `@@` decorator compilation, condition evaluation, and 3-tier barrier scheduling.
 */
export class PipelineOrchestrator {
    public readonly bridge: HostBridge;
    public readonly transport: LLMTransport;
    public readonly store: ChatDataStore;
    public readonly vfs: VirtualFileSystem;
    public readonly trajectoryStore: TrajectoryStore;
    public readonly contextAssembler: ContextAssembler;
    public readonly watermarkCompactor: WatermarkCompactor;
    public readonly traceLogger: TraceLogger;
    public readonly barrierCoordinator: BarrierCoordinator;
    public readonly agentRunner: AgentRunner;
    public readonly decoratorCompiler: DecoratorCompiler;
    public readonly classifier: WIClassifier;
    public readonly loreReadEvaluator: LoreReadEvaluator;
    public readonly tailRadar: TailRadar;

    private readonly settingsProvider: () => Settings;
    private readonly regexProvider?:
        | RegexPipeline
        | (() => RegexPipeline | readonly RegexRule[] | undefined);
    private readonly sandbox?: ScriptSandbox;
    private readonly sideGen?: ToolSideGenApi;
    private readonly summarizeChunk?: ChunkSummarizer;
    private readonly compactionOptions: Partial<CompactionOptions>;
    private readonly activeHostEventTypes = new Set<TriggerEventType>();

    constructor(deps: PipelineOrchestratorDependencies) {
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
        this.summarizeChunk = deps.summarizeChunk;
        this.compactionOptions = deps.compactionOptions ? { ...deps.compactionOptions } : {};

        this.store = deps.store ?? deps.vfs?.store ?? new ChatDataStore(deps.bridge);
        this.traceLogger = deps.traceLogger ?? new TraceLogger();
        this.barrierCoordinator =
            deps.barrierCoordinator ?? new BarrierCoordinator({ traceLogger: this.traceLogger });
        this.trajectoryStore = deps.trajectoryStore ?? new TrajectoryStore();
        this.contextAssembler = deps.contextAssembler ?? new ContextAssembler();
        this.decoratorCompiler = deps.decoratorCompiler ?? new DecoratorCompiler();
        this.classifier = deps.classifier ?? new WIClassifier();

        const resolveLoreRegexRules = () => {
            if (typeof this.regexProvider === 'function') {
                return this.regexProvider();
            }
            if (this.regexProvider) {
                return this.regexProvider;
            }
            return resolveActivePreset(this.settingsProvider()).regexRules;
        };

        this.loreReadEvaluator =
            deps.loreReadEvaluator
            ?? new LoreReadEvaluator(this.bridge, {
                getOverride: (world, uid, target) =>
                    this.store.get(DATA_NAMESPACES.WORLDINFO, worldInfoKey(world, uid), {
                        target,
                        includeStaged: true,
                    })?.content ?? null,
                applyLoreReadRegex: (text) => {
                    const rules = resolveLoreRegexRules();
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

        this.watermarkCompactor =
            deps.watermarkCompactor
            ?? new WatermarkCompactor({
                vfs: this.vfs,
                bridge: this.bridge,
            });

        this.agentRunner =
            deps.agentRunner
            ?? new AgentRunner({
                bridge: this.bridge,
                transport: this.transport,
                settings: this.settingsProvider,
                toolRegistry: deps.toolRegistry ?? createBuiltinToolRegistry(),
                contextAssembler: this.contextAssembler,
                trajectoryStore: this.trajectoryStore,
                vfs: this.vfs,
                store: this.store,
                regexPipeline: () => resolveLoreRegexRules(),
                loreReadEvaluator: this.loreReadEvaluator,
                tailRadar: this.tailRadar,
                traceLogger: this.traceLogger,
                sandbox: this.sandbox,
                ...(this.sideGen ? { sideGen: this.sideGen } : {}),
                onPreprocessMessages: async (prepCtx) => {
                    await this.handlePreprocessMessagesHook(prepCtx);
                },
                onPostprocessResponse: async (postCtx) => {
                    await this.handlePostprocessResponseHook(postCtx);
                },
            });
    }

    /**
     * Execute a complete generation turn (`normal`, `swipe`, `regenerate`, or `continue`)
     * following the 4-phase lifecycle and causal branch invariants.
     */
    async runTurn(input: RunTurnInput): Promise<RunTurnResult> {
        const target = freezeTarget(input.target);
        const turnSignal = input.signal ?? new AbortController().signal;
        throwIfAborted(turnSignal);

        if (input.action === 'continue' && this.trajectoryStore.getInterruptedCheckpoint(target)) {
            return await this.resumeTurn({
                target,
                signal: turnSignal,
                stream: input.stream,
                onTextDelta: input.onTextDelta,
                onOutputPreview: input.onOutputPreview,
                onReasoningDelta: input.onReasoningDelta,
                onToolStart: input.onToolStart,
                onToolComplete: input.onToolComplete,
            });
        }

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const rawUserText = contentToPlainText(input.userInput);
        const turnNumber = this.resolveTurnNumber(target.messageId, input.turnNumber);

        this.traceLogger.emit({
            kind: 'turn_started',
            target: { ...target },
            timestamp: Date.now(),
        });

        try {
            // 1. Causal branch preparation per action type
            if (input.action === 'swipe') {
                if (input.previousSwipeId !== undefined && input.previousSwipeId !== target.swipeId) {
                    const oldTarget: MessageTarget = {
                        messageId: target.messageId,
                        swipeId: input.previousSwipeId,
                    };
                    this.barrierCoordinator.abortTarget(oldTarget, 'Message swiped away');
                    this.store.rollbackStagedData(oldTarget);
                    this.trajectoryStore.clearInterruptedCheckpoint(oldTarget);
                }
                this.barrierCoordinator.abortTarget(target, 'Swipe rerun');
                this.store.rollbackStagedData(target);
                this.trajectoryStore.clearInterruptedCheckpoint(target);
                this.restoreTrajectoriesBeforeMessage(target.messageId);
            } else if (input.action === 'regenerate') {
                this.barrierCoordinator.abortFromMessage(target.messageId, 'Regenerated');
                this.store.pruneFromMessage(target.messageId);
                this.clearNativeVariablesFromMessage(target.messageId);
                this.pruneMainlineTrajectoriesFromMessage(target.messageId);
            } else if (input.action === 'continue') {
                this.restoreTrajectoriesForBranch(target);
            }

            // 2. [Barrier Check] Await pending prior `'turn'` barriers before entering `before_turn`
            await this.barrierCoordinator.awaitTurnBarriers({ signal: turnSignal });
            throwIfAborted(turnSignal);

            // 3. Load lorebooks & compile @@ decorators once per turn
            const env = await this.compileTurnEnvironment(preset, turnSignal);

            // Create turn-isolated PromptInjectionSession seeded with parent floor's sticky state
            const parentStickySnapshot = this.loadParentStickyInjections(target);
            const injectionSession =
                this.bridge.createPromptInjectionSession?.(parentStickySnapshot)?.session
                ?? new LocalPromptInjectionSession(parentStickySnapshot);

            // Notify event-driven `turn_started` hooks before entering before_turn
            await this.dispatchEventHooks(
                'turn_started',
                {
                    type: 'turn_started',
                    timestamp: Date.now(),
                    target: { ...target },
                    messageId: target.messageId,
                    swipeId: target.swipeId,
                    phase: 'before_turn',
                    data: { action: input.action },
                },
                {
                    target,
                    phase: 'before_turn',
                    staged: true,
                    signal: turnSignal,
                    preset,
                    env,
                    injectionSession,
                },
            );
            throwIfAborted(turnSignal);

            // 4. [Phase 1: before_turn] (skipped on `'continue'`)
            const beforeTurnResults: TriggerExecutionResult[] = [];
            if (input.action !== 'continue') {
                const beforeRules = env.allTriggers.filter(
                    (t) => t.phase === 'before_turn' && t.enabled && !isEventDrivenTriggerRule(t),
                );
                await this.executeOrderedSyncUnits(beforeRules, {
                    target,
                    turnNumber,
                    userText: rawUserText,
                    assistantText: '',
                    preset,
                    effectiveAgents: env.effectiveAgents,
                    derivedAgentsByRuleId: env.derivedAgentsByRuleId,
                    loreEntries: env.loreEntries,
                    subAgents: env.subAgents,
                    globalVarSchema: env.globalVarSchema,
                    staged: true,
                    injectionSession,
                    signal: turnSignal,
                    resultsOut: beforeTurnResults,
                });
            }

            throwIfAborted(turnSignal);

            const briefParts = beforeTurnResults
                .filter((r) => !r.skipped && r.output.trim().length > 0)
                .map((r) => r.output.trim());
            const beforeTurnBrief = briefParts.length > 0 ? briefParts.join('\n\n') : undefined;

            // 5. [Phase 2: main_turn]
            const existingText =
                input.action === 'continue'
                    ? (input.existingContent ?? this.readExistingChatMessageText(target))
                    : '';

            const mainAgent =
                env.effectiveAgents[preset.mainAgentId]
                ?? createDefaultMainAgent({ id: preset.mainAgentId });
            const mainUserInput =
                input.action === 'continue'
                    ? (input.continuationPrompt ?? DEFAULT_CONTINUATION_PROMPT)
                    : (input.userInput ?? '');

            const mainRun = await this.agentRunner.run({
                agent: mainAgent,
                preset,
                target,
                phase: 'main_turn',
                generationAction: input.action,
                promptTriggerContext: { kind: 'main', action: input.action },
                userInput: mainUserInput,
                userName: input.userName,
                turnBrief: beforeTurnBrief,
                loreEntries: env.loreEntries,
                subAgents: env.subAgents,
                getVariableSchema: env.globalVarSchema ? () => env.globalVarSchema : undefined,
                staged: true,
                injectionSession,
                checkpointScope: { phase: 'main_turn' },
                ...this.buildAgentRunnerHooks({
                    preset,
                    env,
                    injectionSession,
                }),
                stream: input.stream,
                signal: turnSignal,
                onTextDelta: input.onTextDelta,
                onOutputPreview: input.onOutputPreview,
                onReasoningDelta: input.onReasoningDelta,
                onToolStart: input.onToolStart,
                onToolComplete: input.onToolComplete,
            });
            throwIfAborted(turnSignal);

            const combinedContent = mainRun.content;
            const deltaContent =
                input.action === 'continue'
                    ? (existingText && combinedContent.startsWith(existingText)
                        ? combinedContent.slice(existingText.length)
                        : combinedContent)
                    : combinedContent;

            return await this.finalizeCompletedTurn({
                target,
                action: input.action,
                turnNumber,
                rawUserText,
                combinedContent,
                deltaContent,
                beforeTurnBrief,
                beforeTurnResults,
                mainRun,
                preset,
                env,
                injectionSession,
                hadParentSticky: parentStickySnapshot !== undefined,
                signal: turnSignal,
            });
        } catch (error) {
            if (error instanceof TurnInterruptedError) {
                return await this.handleTurnInterrupted(target, error);
            }

            // Roll back uncommitted staged data if before_turn / main_turn failed or aborted
            this.store.rollbackStagedData(target);

            const aborted = isAbortError(error) || turnSignal.aborted;
            if (aborted) {
                const abortMessage = error instanceof Error ? error.message : 'Turn aborted';
                this.traceLogger.emit({
                    kind: 'turn_aborted',
                    target: { ...target },
                    timestamp: Date.now(),
                    error: abortMessage,
                });
                await this.emitAbortedHostEvent({
                    target,
                    phase: 'main_turn',
                    reason: abortMessage,
                });
                throw error instanceof Error && isAbortError(error)
                    ? error
                    : createAbortError('Turn aborted');
            }

            const errMessage = error instanceof Error ? error.message : String(error);
            this.traceLogger.emit({
                kind: 'turn_error',
                target: { ...target },
                timestamp: Date.now(),
                error: errMessage,
            });
            this.emitUnrecoveredErrorHostEvent({
                target,
                phase: 'main_turn',
                error,
            });
            throw error;
        }
    }

    /**
     * Resume an interrupted `main_turn` from its persisted `InterruptedTurnCheckpoint`
     * while preserving 100% byte-for-byte Prefix KV Cache invariance over completed rounds.
     * When `input.rollbackLastToolRound` is true and `previousRoundSnapshot` exists, rolls back
     * the last tool round's staged state and `/output.md` content before prompting a fresh retry.
     */
    async resumeTurn(input: ResumeTurnInput): Promise<RunTurnResult> {
        const target = freezeTarget(input.target);
        const turnSignal = input.signal ?? new AbortController().signal;
        throwIfAborted(turnSignal);

        const cp = this.trajectoryStore.getInterruptedCheckpoint(target);
        if (!cp) {
            throw new Error(
                `No interrupted turn checkpoint found for target ${target.messageId}#${target.swipeId}.`,
            );
        }

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const turnNumber = this.resolveTurnNumber(target.messageId);
        const { userText: rawUserText } = this.readTurnExchangeText(target);

        this.traceLogger.emit({
            kind: 'turn_resumed',
            target: { ...target },
            timestamp: Date.now(),
            agentProfileId: cp.agentId,
            interruptedReason: cp.reason,
        });

        try {
            await this.barrierCoordinator.awaitTurnBarriers({ signal: turnSignal });
            throwIfAborted(turnSignal);

            const env = await this.compileTurnEnvironment(preset, turnSignal);

            const useRollback = Boolean(input.rollbackLastToolRound && cp.previousRoundSnapshot);
            const prevRound = useRollback ? cp.previousRoundSnapshot : undefined;
            const effectiveCompletedMessages = prevRound
                ? prevRound.completedTurnMessages
                : cp.completedTurnMessages;
            const effectiveReadSet = prevRound ? prevRound.readSetSnapshot : cp.readSetSnapshot;
            const effectiveStagedSnapshot = prevRound
                ? prevRound.stagedSnapshot
                : cp.stagedSnapshot;

            this.restoreTrajectoriesBeforeMessage(target.messageId);
            this.store.restoreStagedData(target, effectiveStagedSnapshot);

            let currentOutput: string;
            let recoveryPrompt: string;
            if (prevRound) {
                await this.vfs.writeFile(OUTPUT_FILE_PATH, prevRound.outputText, {
                    target,
                    staged: true,
                    source: 'resume_rollback',
                });
                currentOutput = prevRound.outputText;
                const rolledBackDesc =
                    prevRound.rolledBackToolSummary?.trim() || 'the previous tool round';
                recoveryPrompt = [
                    `[System Recovery - Tool Round Rolled Back] Previous generation was interrupted (reason: ${cp.reason}) and the last tool round (${rolledBackDesc}) has been rolled back along with its staged changes and /output.md state.`,
                    `Current /output.md now has ${currentOutput.length} chars saved (ending with: ${JSON.stringify(currentOutput.slice(-200))}).`,
                    'Do NOT repeat the failed tool step verbatim; choose an alternative approach or corrected arguments, inspect /output.md if needed, and complete the remaining content cleanly before finishing.',
                ].join('\n');
            } else {
                currentOutput = await this.vfs
                    .readFile(OUTPUT_FILE_PATH, { target, staged: true })
                    .catch(() => '');
                recoveryPrompt = [
                    `[System Recovery] Previous generation was interrupted (reason: ${cp.reason}).`,
                    `Current /output.md already has ${currentOutput.length} chars saved (ending with: ${JSON.stringify(currentOutput.slice(-200))}).`,
                    'Inspect /output.md if needed, seamlessly continue writing the remaining content using append_file or edit_file on /output.md WITHOUT repeating already-written text, and review /output.md for completeness and errors before finishing.',
                ].join('\n');
            }

            const mainAgent =
                env.effectiveAgents[cp.agentId]
                ?? env.effectiveAgents[preset.mainAgentId]
                ?? createDefaultMainAgent({ id: preset.mainAgentId });

            const mainRun = await this.agentRunner.run({
                agent: mainAgent,
                preset,
                target,
                phase: 'main_turn',
                generationAction: 'continue',
                promptTriggerContext: { kind: 'main', action: 'continue' },
                resumeMessages: [
                    ...effectiveCompletedMessages,
                    { role: 'user', content: recoveryPrompt },
                ],
                initialReadSet: effectiveReadSet,
                loreEntries: env.loreEntries,
                subAgents: env.subAgents,
                getVariableSchema: env.globalVarSchema ? () => env.globalVarSchema : undefined,
                staged: true,
                checkpointScope: { phase: 'main_turn' },
                ...this.buildAgentRunnerHooks({
                    preset,
                    env,
                }),
                stream: input.stream,
                signal: turnSignal,
                onTextDelta: input.onTextDelta,
                onOutputPreview: input.onOutputPreview,
                onReasoningDelta: input.onReasoningDelta,
                onToolStart: input.onToolStart,
                onToolComplete: input.onToolComplete,
            });
            throwIfAborted(turnSignal);

            this.trajectoryStore.clearInterruptedCheckpoint(target);

            const combinedContent = mainRun.content;
            const deltaContent =
                currentOutput && combinedContent.startsWith(currentOutput)
                    ? combinedContent.slice(currentOutput.length)
                    : combinedContent;

            return await this.finalizeCompletedTurn({
                target,
                action: 'continue',
                turnNumber,
                rawUserText,
                combinedContent,
                deltaContent,
                beforeTurnResults: [],
                mainRun,
                preset,
                env,
                signal: turnSignal,
            });
        } catch (error) {
            if (error instanceof TurnInterruptedError) {
                return await this.handleTurnInterrupted(target, error);
            }

            const aborted = isAbortError(error) || turnSignal.aborted;
            if (aborted) {
                const abortMessage = error instanceof Error ? error.message : 'Turn resume aborted';
                this.traceLogger.emit({
                    kind: 'turn_aborted',
                    target: { ...target },
                    timestamp: Date.now(),
                    error: abortMessage,
                });
                await this.emitAbortedHostEvent({
                    target,
                    phase: 'main_turn',
                    agentId: cp.agentId,
                    reason: abortMessage,
                });
                throw error instanceof Error && isAbortError(error)
                    ? error
                    : createAbortError('Turn resume aborted');
            }

            this.traceLogger.emit({
                kind: 'turn_error',
                target: { ...target },
                timestamp: Date.now(),
                error: error instanceof Error ? error.message : String(error),
            });
            this.emitUnrecoveredErrorHostEvent({
                target,
                phase: 'main_turn',
                agentId: cp.agentId,
                error,
            });
            throw error;
        }
    }

    private loadParentStickyInjections(target: MessageTarget): SerializedPromptInjected | undefined {
        if (target.messageId <= 0) {
            return undefined;
        }
        const chat = this.bridge.getChat();
        const parentId = target.messageId - 1;
        const parentSwipeId = chat[parentId]?.swipeId ?? 0;
        const entry = this.store.get(DATA_NAMESPACES.EJS_INJECTIONS, EJS_INJECTIONS_DOC_KEY, {
            target: { messageId: parentId, swipeId: parentSwipeId },
        });
        if (!entry || entry.deleted || !entry.content.trim()) {
            return undefined;
        }
        try {
            const parsed = JSON.parse(entry.content) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return undefined;
            }
            const record = parsed as SerializedPromptInjected;
            return Object.keys(record).length > 0 ? record : undefined;
        } catch {
            return undefined;
        }
    }

    private async compileTurnEnvironment(
        preset: Preset,
        signal: AbortSignal,
        options?: { includeDisabled?: boolean },
    ): Promise<CompiledTurnEnvironment> {
        const loreEntries = await this.loadRawLoreEntries();
        throwIfAborted(signal);

        const compiled = this.decoratorCompiler.compile(loreEntries, {
            preset,
            ...(options?.includeDisabled ? { includeDisabled: true } : {}),
        });
        const effectiveAgents: Record<string, AgentProfile> = {
            ...compiled.derivedAgents,
            ...preset.agents,
        };
        const allTriggers = mergePresetAndCompiledTriggers(preset.triggers, compiled.triggers);
        const globalVarSchema = await this.compileGlobalVariableSchema(compiled.schemaEntries);
        throwIfAborted(signal);

        return {
            loreEntries,
            effectiveAgents,
            derivedAgentsByRuleId: compiled.derivedAgentsByRuleId,
            allTriggers,
            subAgents: compiled.subAgents,
            globalVarSchema,
        };
    }

    private async handleTurnInterrupted(
        target: MessageTarget,
        error: TurnInterruptedError,
    ): Promise<never> {
        this.trajectoryStore.saveInterruptedCheckpoint(error.checkpoint);
        this.trajectoryStore.saveToHost(this.bridge);
        const now = Date.now();
        this.traceLogger.emit({
            kind: 'turn_interrupted',
            target: { ...target },
            timestamp: now,
            agentProfileId: error.checkpoint.agentId,
            interruptedReason: error.reason,
            outputPreview: error.salvagedOutput,
            ...(error.causeError ? { error: error.causeError } : {}),
        });

        const phase = error.checkpoint.phase ?? 'main_turn';
        const interruptedPayload: ToolEventPayload = {
            type: 'turn_interrupted',
            timestamp: now,
            target: { ...target },
            messageId: target.messageId,
            swipeId: target.swipeId,
            phase,
            runId: error.trace.runId,
            agentId: error.checkpoint.agentId,
            ...(error.checkpoint.triggerId ? { triggerId: error.checkpoint.triggerId } : {}),
            reason: error.reason,
            output: error.salvagedOutput,
            ...(error.causeError ? { error: error.causeError } : {}),
        };
        this.bridge.emitHostEvent?.('agentic_turn_interrupted', interruptedPayload);

        if (error.reason === 'error') {
            const errorPayload: ToolEventPayload = {
                ...interruptedPayload,
                type: 'generation_error',
                error: error.causeError ?? error.message,
            };
            this.bridge.emitHostEvent?.('agentic_generation_error', errorPayload);
        }

        await this.dispatchEventHooks('turn_interrupted', interruptedPayload, {
            target,
            phase,
            staged: true,
            isErrorRecovery: true,
        }).catch((hookErr) => {
            console.warn('[ST-Agentic] turn_interrupted event hook error:', hookErr);
        });

        throw error;
    }

    private async finalizeCompletedTurn(params: {
        target: MessageTarget;
        action: GenerationAction;
        turnNumber: number;
        rawUserText: string;
        combinedContent: string;
        deltaContent: string;
        beforeTurnBrief?: string;
        beforeTurnResults: TriggerExecutionResult[];
        mainRun: AgentRunResult;
        preset: Preset;
        env: {
            loreEntries: RawLoreEntry[];
            effectiveAgents: Record<string, AgentProfile>;
            derivedAgentsByRuleId: Record<string, AgentProfile>;
            allTriggers: TriggerRule[];
            subAgents: SubAgentDescriptor[];
            globalVarSchema: z.ZodTypeAny | undefined;
        };
        injectionSession?: PromptInjectionSession;
        hadParentSticky?: boolean;
        signal: AbortSignal;
    }): Promise<RunTurnResult> {
        if (params.injectionSession) {
            params.injectionSession.tickSticky(1);
            const nextSticky = params.injectionSession.exportSnapshot();
            if (Object.keys(nextSticky).length > 0 || params.hadParentSticky) {
                this.store.set(
                    DATA_NAMESPACES.EJS_INJECTIONS,
                    EJS_INJECTIONS_DOC_KEY,
                    'ejs-injections',
                    JSON.stringify(nextSticky),
                    { target: params.target, staged: true },
                );
            }
        }

        // Commit before_turn + main_turn staged writes atomically to target (messageId, swipeId)
        this.store.commitStagedData(params.target);
        this.trajectoryStore.saveToHost(this.bridge);

        // [Phase 3: after_turn] Non-blocking background dispatch
        const afterTurnTasks = await this.dispatchAfterTurnUnits({
            target: params.target,
            turnNumber: params.turnNumber,
            userText: params.rawUserText,
            assistantText: params.combinedContent,
            preset: params.preset,
            effectiveAgents: params.env.effectiveAgents,
            derivedAgentsByRuleId: params.env.derivedAgentsByRuleId,
            allTriggers: params.env.allTriggers,
            loreEntries: params.env.loreEntries,
            subAgents: params.env.subAgents,
            globalVarSchema: params.env.globalVarSchema,
            injectionSession: params.injectionSession,
            signal: params.signal,
        });

        // [Phase 4: maintenance] Watermark compaction check
        const maintenanceTasks = this.dispatchMaintenanceChecks({
            target: params.target,
            preset: params.preset,
            effectiveAgents: params.env.effectiveAgents,
            allTriggers: params.env.allTriggers,
            loreEntries: params.env.loreEntries,
        });

        this.traceLogger.emit({
            kind: 'turn_completed',
            target: { ...params.target },
            timestamp: Date.now(),
        });

        await this.dispatchEventHooks(
            'turn_completed',
            {
                type: 'turn_completed',
                timestamp: Date.now(),
                target: { ...params.target },
                messageId: params.target.messageId,
                swipeId: params.target.swipeId,
                phase: 'main_turn',
                runId: params.mainRun.runId,
                agentId: params.mainRun.agentProfileId,
                output: params.combinedContent,
                data: { action: params.action },
            },
            {
                target: params.target,
                phase: 'main_turn',
                staged: false,
                signal: params.signal,
                preset: params.preset,
                env: params.env,
                injectionSession: params.injectionSession,
            },
        ).catch((hookErr) => {
            if (isAbortError(hookErr) || params.signal.aborted) {
                return;
            }
            console.warn('[ST-Agentic] turn_completed event hook error:', hookErr);
        });

        return {
            target: params.target,
            action: params.action,
            content: params.combinedContent,
            deltaContent: params.deltaContent,
            ...(params.mainRun.reasoningContent
                ? { reasoningContent: params.mainRun.reasoningContent }
                : {}),
            ...(params.beforeTurnBrief !== undefined
                ? { beforeTurnBrief: params.beforeTurnBrief }
                : {}),
            beforeTurnResults: params.beforeTurnResults,
            mainRun: params.mainRun,
            afterTurnTasks,
            maintenanceTasks,
        };
    }

    /**
     * Execute `before_turn` triggers (used both internally and by Companion mode hooks)
     * with full `groupTriggersForExecution` merging and ordered batch execution.
     */
    async runBeforeTurn(input: {
        target: MessageTarget;
        userText: string;
        turnNumber?: number;
        signal?: AbortSignal;
    }): Promise<{ brief: string; results: TriggerExecutionResult[] }> {
        const target = freezeTarget(input.target);
        const turnSignal = input.signal ?? new AbortController().signal;
        throwIfAborted(turnSignal);

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const turnNumber = this.resolveTurnNumber(target.messageId, input.turnNumber);
        const env = await this.compileTurnEnvironment(preset, turnSignal);
        const beforeRules = env.allTriggers.filter(
            (t) => t.phase === 'before_turn' && t.enabled && !isEventDrivenTriggerRule(t),
        );
        const parentSticky = this.loadParentStickyInjections(target);
        const injectionSession =
            this.bridge.createPromptInjectionSession?.(parentSticky)?.session
            ?? new LocalPromptInjectionSession(parentSticky);

        const results: TriggerExecutionResult[] = [];
        await this.executeOrderedSyncUnits(beforeRules, {
            target,
            turnNumber,
            userText: input.userText,
            assistantText: '',
            preset,
            effectiveAgents: env.effectiveAgents,
            derivedAgentsByRuleId: env.derivedAgentsByRuleId,
            loreEntries: env.loreEntries,
            subAgents: env.subAgents,
            globalVarSchema: env.globalVarSchema,
            staged: true,
            injectionSession,
            signal: turnSignal,
            resultsOut: results,
        });

        const briefParts = results
            .filter((r) => !r.skipped && r.output.trim().length > 0)
            .map((r) => r.output.trim());

        return {
            brief: briefParts.join('\n\n'),
            results,
        };
    }

    /**
     * Manually re-run `after_turn` triggers for a specific `(messageId, swipeId)` target.
     * When `options.triggerIds` is provided, only those trigger rule IDs are re-dispatched
     * without aborting unrelated sibling tasks on the same floor.
     */
    async rerunAfterTurn(
        targetInput: MessageTarget,
        options: {
            turnNumber?: number;
            triggerIds?: readonly string[];
            force?: boolean;
            signal?: AbortSignal;
        } = {},
    ): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const target = freezeTarget(targetInput);
        if (options.signal) {
            throwIfAborted(options.signal);
        }

        const requestedTriggerIds = (options.triggerIds ?? [])
            .map((id) => id.trim())
            .filter(Boolean);
        const onlyTriggerIds =
            requestedTriggerIds.length > 0 ? new Set(requestedTriggerIds) : undefined;
        const allowDisabled = Boolean(options.force && onlyTriggerIds);

        if (!onlyTriggerIds) {
            // Full floor rerun aborts any stuck after_turn tasks for this exact target and clears pending staging.
            this.barrierCoordinator.abortTarget(target, 'Manual rerun of after_turn');
            this.store.rollbackStagedData(target);
        } else if (!this.barrierCoordinator.hasActiveTasksForTarget(target)) {
            this.store.rollbackStagedData(target);
        }

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const loreEntries = await this.loadRawLoreEntries();
        const compiled = this.decoratorCompiler.compile(loreEntries, {
            preset,
            includeDisabled: allowDisabled,
        });
        const effectiveAgents: Record<string, AgentProfile> = {
            ...compiled.derivedAgents,
            ...preset.agents,
        };
        const allTriggers = mergePresetAndCompiledTriggers(preset.triggers, compiled.triggers);
        const globalVarSchema = await this.compileGlobalVariableSchema(compiled.schemaEntries);

        const { userText, assistantText } = this.readTurnExchangeText(target);
        const turnNumber = this.resolveTurnNumber(target.messageId, options.turnNumber);

        return await this.dispatchAfterTurnUnits({
            target,
            turnNumber,
            userText,
            assistantText,
            preset,
            effectiveAgents,
            derivedAgentsByRuleId: compiled.derivedAgentsByRuleId,
            allTriggers,
            loreEntries,
            subAgents: compiled.subAgents,
            globalVarSchema,
            ...(onlyTriggerIds ? { onlyTriggerIds } : {}),
            ...(allowDisabled ? { force: true } : {}),
            signal: options.signal,
        });
    }

    /** Cancel a single background task by ID and discard its uncommitted staged writes if unshared. */
    cancelBackgroundTask(taskId: string, reason?: string): boolean {
        const task = this.barrierCoordinator.getTask(taskId);
        const cancelled = this.barrierCoordinator.cancelTask(taskId, reason);
        if (cancelled && task && !this.barrierCoordinator.hasActiveTasksForTarget(task.target, taskId)) {
            this.store.rollbackStagedData(task.target);
        }
        return cancelled;
    }

    /**
     * Resume an interrupted `after_turn` trigger task from its composite `(target, phase, triggerId)`
     * checkpoint (optionally rolling back the last tool round if `rollbackLastToolRound` is true).
     * Gracefully falls back to `rerunAfterTurn` when no persisted checkpoint exists.
     */
    async resumeTriggerTask(
        targetInput: MessageTarget,
        triggerId: string,
        options: ResumeTriggerTaskOptions = {},
    ): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const target = freezeTarget(targetInput);
        if (options.signal) {
            throwIfAborted(options.signal);
        }

        const trimmedTriggerId = triggerId.trim();
        const requestedTriggerIds = trimmedTriggerId
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);

        let cp = this.trajectoryStore.getInterruptedCheckpoint(target, {
            phase: 'after_turn',
            triggerId: trimmedTriggerId,
        });
        if (!cp && requestedTriggerIds.length === 1) {
            const allAfterCps = this.trajectoryStore.listInterruptedCheckpoints({
                target,
                phase: 'after_turn',
            });
            for (const candidate of allAfterCps.values()) {
                const candidateParts = (candidate.triggerId ?? '')
                    .split(',')
                    .map((id) => id.trim())
                    .filter(Boolean);
                if (candidateParts.includes(requestedTriggerIds[0])) {
                    cp = candidate;
                    break;
                }
            }
        }

        if (!cp) {
            return await this.rerunAfterTurn(target, {
                ...(requestedTriggerIds.length > 0 ? { triggerIds: requestedTriggerIds } : {}),
                force: true,
                signal: options.signal,
            });
        }

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const compileSignal = options.signal ?? new AbortController().signal;
        const env = await this.compileTurnEnvironment(preset, compileSignal, {
            includeDisabled: true,
        });

        const cpScopeTriggerId = cp.triggerId?.trim() || trimmedTriggerId;
        const cpTriggerIds = cpScopeTriggerId
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean);
        const cpTriggerIdSet = new Set(cpTriggerIds);
        const matchedRules = env.allTriggers.filter((rule) => cpTriggerIdSet.has(rule.id));

        const groupedUnits =
            matchedRules.length > 0
                ? groupTriggersForExecution(matchedRules, { includeDisabled: true })
                : [];
        const unit: TriggerExecutionUnit =
            groupedUnits.length === 1
                ? groupedUnits[0]
                : matchedRules.length > 0
                    ? {
                        unitId: `resume:${cpScopeTriggerId}`,
                        phase: cp.phase ?? 'after_turn',
                        order: matchedRules[0].order,
                        barrier: resolveStrictestBarrier(matchedRules),
                        agentProfileId: cp.agentId || matchedRules[0].agentProfileId,
                        kind: 'agent',
                        isGrouped: matchedRules.length > 1,
                        triggers: matchedRules,
                        label:
                            matchedRules.length === 1
                                ? matchedRules[0].label
                                : `${cpScopeTriggerId} (${matchedRules.length})`,
                        ...(matchedRules[0].targetPath
                            ? { targetPath: matchedRules[0].targetPath }
                            : {}),
                    }
                    : {
                        unitId: `resume:${cpScopeTriggerId}`,
                        phase: cp.phase ?? 'after_turn',
                        order: 1,
                        barrier: 'self',
                        agentProfileId: cp.agentId,
                        kind: 'agent',
                        isGrouped: false,
                        triggers: [],
                        label: cpScopeTriggerId || cp.agentId,
                    };

        const useRollback = Boolean(options.rollbackLastToolRound && cp.previousRoundSnapshot);
        const prevRound = useRollback ? cp.previousRoundSnapshot : undefined;
        const effectiveCompletedMessages = prevRound
            ? prevRound.completedTurnMessages
            : cp.completedTurnMessages;
        const effectiveReadSet = prevRound ? prevRound.readSetSnapshot : cp.readSetSnapshot;
        const effectiveStagedSnapshot = prevRound
            ? prevRound.stagedSnapshot
            : cp.stagedSnapshot;
        const recoveryPrompt = prevRound
            ? [
                `[System Recovery - Tool Round Rolled Back] Previous trigger execution (${cpScopeTriggerId}) was interrupted (reason: ${cp.reason}) and the last tool round (${prevRound.rolledBackToolSummary?.trim() || 'the previous tool round'}) has been rolled back along with its staged changes.`,
                'Do NOT repeat the failed tool call verbatim; inspect the current state if needed and retry with a different approach or corrected arguments before finishing.',
            ].join('\n')
            : [
                `[System Recovery] Previous trigger execution (${cpScopeTriggerId}) was interrupted (reason: ${cp.reason}).`,
                'Inspect the current files/variables if needed and complete the remaining trigger work cleanly without duplicating already-finished edits.',
            ].join('\n');

        const { userText, assistantText } = this.readTurnExchangeText(target);
        const checkpointPhase: PipelinePhase = cp.phase ?? 'after_turn';
        const checkpointAgentId = cp.agentId;

        this.traceLogger.emit({
            kind: 'turn_resumed',
            target: { ...target },
            timestamp: Date.now(),
            phase: checkpointPhase,
            agentProfileId: checkpointAgentId,
            interruptedReason: cp.reason,
        });

        const handle = this.barrierCoordinator.dispatch<TriggerExecutionResult>(
            {
                target,
                phase: checkpointPhase,
                barrier: unit.barrier,
                agentProfileId: checkpointAgentId || unit.agentProfileId,
                label: unit.label,
                ...(unit.targetPath ? { targetPath: unit.targetPath } : {}),
                ...(options.signal ? { signal: options.signal } : {}),
            },
            async (taskCtx) => {
                taskCtx.setCurrentStep(`Resuming ${unit.label}`);
                this.store.restoreStagedData(taskCtx.target, effectiveStagedSnapshot);

                if (prevRound) {
                    const currentOutput = await this.vfs
                        .readFile(OUTPUT_FILE_PATH, { target: taskCtx.target, staged: true })
                        .catch(() => '');
                    if (currentOutput !== prevRound.outputText) {
                        await this.vfs.writeFile(OUTPUT_FILE_PATH, prevRound.outputText, {
                            target: taskCtx.target,
                            staged: true,
                            source: 'resume_rollback',
                        });
                    }
                }

                try {
                    const result = await this.executePreparedUnit(unit, {
                        target: taskCtx.target,
                        userText,
                        assistantText,
                        preset,
                        effectiveAgents: env.effectiveAgents,
                        derivedAgentsByRuleId: env.derivedAgentsByRuleId,
                        loreEntries: env.loreEntries,
                        subAgents: env.subAgents,
                        globalVarSchema: env.globalVarSchema,
                        staged: true,
                        taskId: taskCtx.taskId,
                        checkpointScope: {
                            phase: checkpointPhase,
                            triggerId: cpScopeTriggerId,
                        },
                        resumeMessages: [
                            ...effectiveCompletedMessages,
                            { role: 'user', content: recoveryPrompt },
                        ],
                        initialReadSet: effectiveReadSet,
                        overrideAgentProfileId: checkpointAgentId,
                        overrideTriggerId: cpScopeTriggerId,
                        onToolStart: (step) => {
                            taskCtx.setCurrentStep(`${unit.label} · ${step.toolName}`);
                        },
                        onRetrying: (info) => {
                            taskCtx.setCurrentStep(
                                `${unit.label} · 自动重试 (${info.attempt}/${info.maxAttempts}): ${info.reason}`,
                            );
                        },
                        signal: taskCtx.signal,
                    });

                    throwIfAborted(taskCtx.signal);
                    this.trajectoryStore.clearInterruptedCheckpoint(taskCtx.target, {
                        phase: checkpointPhase,
                        triggerId: cpScopeTriggerId,
                    });
                    this.store.commitStagedData(taskCtx.target);
                    this.trajectoryStore.saveToHost(this.bridge);
                    return result;
                } catch (error) {
                    this.handleBackgroundTriggerFailure(error, {
                        target: taskCtx.target,
                        phase: checkpointPhase,
                        agentId: checkpointAgentId || unit.agentProfileId,
                        triggerId: cpScopeTriggerId,
                        signal: taskCtx.signal,
                    });
                    throw error;
                }
            },
        );

        return [handle];
    }

    /**
     * Dispatch enabled preset & World Info event-driven rules (`rule.events?.includes(eventType)`)
     * in ascending `order`, supporting both `kind === 'script'` (sandbox with `ctx.agent`, `ctx.event`,
     * and optional `ctx.messages`/`ctx.control`/`ctx.body`/`ctx.output`) and `kind === 'agent'`.
     */
    async dispatchEventHooks(
        eventType: TriggerEventType,
        payload: ToolEventPayload,
        options: EventHookDispatchOptions = {},
    ): Promise<EventHookRuleResult[]> {
        const signal = options.signal ?? new AbortController().signal;
        throwIfAborted(signal);

        const target = freezeTarget(
            options.target
            ?? payload.target
            ?? this.resolveFallbackTarget(payload.messageId, payload.swipeId),
        );
        const settings = this.settingsProvider();
        const preset = options.preset ?? resolveActivePreset(settings);
        const env = options.env ?? await this.compileTurnEnvironment(preset, signal);

        const matchedRules = env.allTriggers
            .filter(
                (rule) =>
                    rule.enabled
                    && Array.isArray(rule.events)
                    && rule.events.includes(eventType),
            )
            .map((rule, idx) => ({ rule, idx }))
            .sort((a, b) => a.rule.order - b.rule.order || a.idx - b.idx)
            .map((item) => item.rule);

        if (matchedRules.length === 0) {
            return [];
        }

        const { userText, assistantText } = this.readTurnExchangeText(target);
        const scanText =
            (typeof payload.output === 'string' && payload.output.length > 0
                ? payload.output
                : typeof payload.error === 'string' && payload.error.length > 0
                    ? payload.error
                    : assistantText || userText);
        const turnNumber = this.resolveTurnNumber(target.messageId);
        const staged = options.staged ?? false;
        const effectivePhase: PipelinePhase = options.phase ?? payload.phase ?? 'after_turn';
        const isErrorRecovery = Boolean(
            options.isErrorRecovery || eventType === 'generation_error',
        );

        const normalizedPayload: ToolEventPayload = {
            ...payload,
            type: eventType,
            timestamp: payload.timestamp || Date.now(),
            target: { ...target },
            messageId: payload.messageId ?? target.messageId,
            swipeId: payload.swipeId ?? target.swipeId,
            ...(payload.phase ? {} : { phase: effectivePhase }),
        };

        const results: EventHookRuleResult[] = [];

        for (const rule of matchedRules) {
            throwIfAborted(signal);

            let evalRes: { matched: boolean; matchOverrides?: Record<string, string> };
            try {
                evalRes = await this.evaluateCondition(rule, {
                    target,
                    turnNumber,
                    scanText,
                    signal,
                    staged,
                    injectionSession: options.injectionSession,
                });
            } catch (error) {
                if (isAbortError(error) || signal.aborted) {
                    throw error;
                }
                const errMsg = error instanceof Error ? error.message : String(error);
                console.warn(
                    `[ST-Agentic] Event hook condition failed for "${rule.label}" (${eventType}):`,
                    error,
                );
                results.push({
                    ruleId: rule.id,
                    label: rule.label,
                    kind: rule.kind,
                    eventType,
                    target,
                    output: '',
                    error: errMsg,
                });
                continue;
            }

            if (!evalRes.matched) {
                continue;
            }

            if (rule.kind === 'script') {
                const runId = `event_script_${eventType}_${rule.id}_${target.messageId}_${target.swipeId}_${Date.now()}`;
                const code = rule.scriptCode ?? rule.instructionTemplate ?? '';
                const isEjs = Boolean(rule.decorator && rule.decorator.includes('_ejs'));
                const permissions: ScopedPermissions = {
                    read: ['/**'],
                    write: rule.targetPath
                        ? [rule.targetPath]
                        : ['/memory/**', '/scratch/**', '/lorebooks/**', '/state/variables.json'],
                };
                const agentApi = this.createToolAgentApi({
                    defaultTarget: target,
                    defaultPhase: effectivePhase,
                    defaultStaged: staged,
                    parentSignal: signal,
                    isErrorRecovery,
                    preset,
                    env,
                    injectionSession: options.injectionSession,
                });
                const baseToolCtx = createToolExecutionContext({
                    bridge: this.bridge,
                    vfs: this.vfs,
                    store: this.store,
                    ...(this.sideGen ? { sideGen: this.sideGen } : {}),
                    target,
                    signal,
                    permissions,
                    phase: effectivePhase,
                    staged,
                    source: `event:${eventType}:${rule.id}`,
                    getVariableSchema: env.globalVarSchema ? () => env.globalVarSchema : undefined,
                });
                const toolCtx: ToolExecutionContext = {
                    ...baseToolCtx,
                    agent: agentApi,
                    event: normalizedPayload,
                    ...(options.messages ? { messages: options.messages } : {}),
                    ...(options.body ? { body: options.body } : {}),
                    ...(options.output ? { output: options.output } : {}),
                    ...(options.control ? { control: options.control } : {}),
                };

                try {
                    let rawResult: unknown;
                    let output = '';
                    let skipped = false;

                    if (isEjs) {
                        if (!this.bridge.evaluateOptionalEjs) {
                            skipped = true;
                        } else {
                            const vars = await this.vfs
                                .readVariables({ target, staged })
                                .catch(() => ({}));
                            const ejsVars: Record<string, unknown> = {
                                ...vars,
                                ...(evalRes.matchOverrides ?? {}),
                                event: normalizedPayload,
                                input: userText,
                                output: assistantText,
                                target,
                            };
                            const evaluated = await this.bridge.evaluateOptionalEjs(
                                code,
                                ejsVars,
                                options.injectionSession
                                    ? { injectionSession: options.injectionSession }
                                    : undefined,
                            );
                            throwIfAborted(signal);
                            rawResult = evaluated;
                            output = evaluated;
                        }
                    } else {
                        if (!this.sandbox) {
                            throw new Error(
                                `Event script "${rule.label}" (${eventType}) requires a ScriptSandbox instance.`,
                            );
                        }
                        const prevOutText = options.output?.text;
                        const prevOutContent = options.output?.content;
                        const prevOutReasoning = options.output?.reasoningContent;

                        rawResult = await this.sandbox.evaluateScript(code, toolCtx, {
                            id: runId,
                            allowNetwork: true,
                            signal,
                        });
                        throwIfAborted(signal);

                        if (eventType === 'output_postprocess' && options.output) {
                            reconcilePostprocessOutputReturn(
                                options.output,
                                rawResult,
                                prevOutText ?? '',
                                prevOutContent,
                                prevOutReasoning,
                            );
                        }

                        if (typeof rawResult === 'string') {
                            output = rawResult;
                        } else if (rawResult !== undefined && rawResult !== null) {
                            try {
                                output = JSON.stringify(rawResult);
                            } catch {
                                output = String(rawResult);
                            }
                        }
                    }

                    const ruleResult: EventHookRuleResult = {
                        ruleId: rule.id,
                        label: rule.label,
                        kind: 'script',
                        eventType,
                        target,
                        rawResult,
                        output,
                        ...(skipped ? { skipped: true } : {}),
                    };
                    results.push(ruleResult);
                    if (options.shouldStop?.(ruleResult)) {
                        break;
                    }
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) {
                        throw error;
                    }
                    const errMsg = error instanceof Error ? error.message : String(error);
                    console.warn(
                        `[ST-Agentic] Event script "${rule.label}" (${eventType}) failed:`,
                        error,
                    );
                    results.push({
                        ruleId: rule.id,
                        label: rule.label,
                        kind: 'script',
                        eventType,
                        target,
                        output: '',
                        error: errMsg,
                    });
                }
                continue;
            }

            // Event-driven agent rule (`kind === 'agent'`)
            const unit: TriggerExecutionUnit = {
                unitId: `event:${eventType}:${rule.id}`,
                phase: effectivePhase,
                order: rule.order,
                barrier: rule.barrier,
                agentProfileId: rule.agentProfileId,
                kind: 'agent',
                isGrouped: false,
                triggers: [rule],
                label: rule.label,
                ...(rule.targetPath ? { targetPath: rule.targetPath } : {}),
            };
            try {
                const execRes = await this.executePreparedUnit(unit, {
                    target,
                    userText,
                    assistantText,
                    preset,
                    effectiveAgents: env.effectiveAgents,
                    derivedAgentsByRuleId: env.derivedAgentsByRuleId,
                    loreEntries: env.loreEntries,
                    subAgents: env.subAgents,
                    globalVarSchema: env.globalVarSchema,
                    staged,
                    injectionSession: options.injectionSession,
                    matchOverrides: {
                        ...(evalRes.matchOverrides ?? {}),
                        eventType,
                        ...(normalizedPayload.error ? { eventError: normalizedPayload.error } : {}),
                    },
                    isErrorRecovery,
                    forceDisableOutputFile: true,
                    signal,
                });
                const ruleResult: EventHookRuleResult = {
                    ruleId: rule.id,
                    label: rule.label,
                    kind: 'agent',
                    eventType,
                    target,
                    rawResult: execRes.output,
                    output: execRes.output,
                    ...(execRes.skipped ? { skipped: true } : {}),
                };
                results.push(ruleResult);
                if (options.shouldStop?.(ruleResult)) {
                    break;
                }
            } catch (error) {
                if (isAbortError(error) || signal.aborted) {
                    throw error;
                }
                const errMsg = error instanceof Error ? error.message : String(error);
                console.warn(
                    `[ST-Agentic] Event agent trigger "${rule.label}" (${eventType}) failed:`,
                    error,
                );
                results.push({
                    ruleId: rule.id,
                    label: rule.label,
                    kind: 'agent',
                    eventType,
                    target,
                    output: '',
                    error: errMsg,
                });
            }
        }

        return results;
    }

    /**
     * Route a SillyTavern host event (`chat_changed`, `message_sent`, `message_received`,
     * `message_edited`, `message_deleted`, `message_swiped`, `output_updated`, etc.) to
     * matching `@@script on=<event>` / `@@trigger on=<event>` rules with re-entrancy protection.
     */
    async dispatchHostEvent(
        eventType: TriggerEventType,
        payload: Partial<ToolEventPayload> = {},
        options: Omit<EventHookDispatchOptions, 'messages' | 'body' | 'output' | 'control'> = {},
    ): Promise<EventHookRuleResult[]> {
        if (this.activeHostEventTypes.has(eventType)) {
            return [];
        }
        this.activeHostEventTypes.add(eventType);
        try {
            const target = freezeTarget(
                options.target
                ?? payload.target
                ?? this.resolveFallbackTarget(payload.messageId, payload.swipeId),
            );
            const fullPayload: ToolEventPayload = {
                ...payload,
                type: eventType,
                timestamp: payload.timestamp ?? Date.now(),
                target: { ...target },
                messageId: payload.messageId ?? target.messageId,
                swipeId: payload.swipeId ?? target.swipeId,
            };
            return await this.dispatchEventHooks(eventType, fullPayload, {
                ...options,
                target,
                staged: options.staged ?? false,
            });
        } finally {
            this.activeHostEventTypes.delete(eventType);
        }
    }

    private resolveFallbackTarget(messageId?: number, swipeId?: number): MessageTarget {
        const chat = this.bridge.getChat();
        if (
            typeof messageId === 'number'
            && Number.isInteger(messageId)
            && messageId >= 0
        ) {
            const msg = chat[messageId];
            const resolvedSwipe =
                typeof swipeId === 'number' && Number.isInteger(swipeId) && swipeId >= 0
                    ? swipeId
                    : typeof msg?.swipeId === 'number' && Number.isInteger(msg.swipeId) && msg.swipeId >= 0
                        ? msg.swipeId
                        : 0;
            return { messageId, swipeId: resolvedSwipe };
        }
        if (chat.length > 0) {
            const lastIndex = chat.length - 1;
            const lastMsg = chat[lastIndex];
            const resolvedSwipe =
                typeof lastMsg?.swipeId === 'number'
                && Number.isInteger(lastMsg.swipeId)
                && lastMsg.swipeId >= 0
                    ? lastMsg.swipeId
                    : 0;
            return { messageId: lastIndex, swipeId: resolvedSwipe };
        }
        return { messageId: 0, swipeId: 0 };
    }

    private createToolAgentApi(baseCtx: {
        defaultTarget: MessageTarget;
        defaultPhase: PipelinePhase;
        defaultStaged: boolean;
        parentSignal: AbortSignal;
        isErrorRecovery: boolean;
        preset?: Preset;
        env?: CompiledTurnEnvironment;
        injectionSession?: PromptInjectionSession;
    }): ToolAgentApi {
        const run = async (rawOpts: ToolAgentRunOptions): Promise<ToolAgentRunResult> => {
            const optsRecord = (rawOpts ?? {}) as ToolAgentRunOptions & {
                profile?: string;
                tools?: string[];
            };
            const { signal, cleanup } = linkAbortSignals(baseCtx.parentSignal, optsRecord.signal);
            try {
                throwIfAborted(signal);
                const settings = this.settingsProvider();
                const preset = baseCtx.preset ?? resolveActivePreset(settings);
                const env = baseCtx.env ?? await this.compileTurnEnvironment(preset, signal);
                const target = freezeTarget(optsRecord.target ?? baseCtx.defaultTarget);
                const phase: PipelinePhase = optsRecord.phase ?? baseCtx.defaultPhase;
                const staged = optsRecord.staged ?? baseCtx.defaultStaged;
                const requestedAgentId = (optsRecord.agentId ?? optsRecord.profile)?.trim();
                const requestedEnabledTools = optsRecord.enabledTools ?? optsRecord.tools;

                let profile: AgentProfile | undefined;
                let subAgentPromptPrefix = '';

                if (requestedAgentId) {
                    if (preset.agents[requestedAgentId]) {
                        profile = canonicalClone(preset.agents[requestedAgentId]);
                    } else {
                        const lowered = requestedAgentId.toLowerCase();
                        const matchedSub = env.subAgents.find(
                            (sa) =>
                                sa.name === requestedAgentId
                                || sa.name.toLowerCase() === lowered
                                || sa.toolName === requestedAgentId,
                        );
                        if (matchedSub) {
                            const refProfile = matchedSub.presetName
                                ? preset.agents[matchedSub.presetName]
                                : preset.agents[matchedSub.name];
                            if (refProfile) {
                                profile = canonicalClone(refProfile);
                            } else {
                                profile = {
                                    id: `subagent_${sanitizeSegmentLocal(matchedSub.name)}`,
                                    name: matchedSub.name,
                                    connectionId: 'inherit',
                                    sessionMode: 'ephemeral',
                                    ephemeralWindowSize: 0,
                                    promptBlocks: [
                                        {
                                            id: 'system_base',
                                            name: `${matchedSub.name} Instructions`,
                                            role: 'system',
                                            placement: 'prefix',
                                            content:
                                                matchedSub.instructions.trim()
                                                || 'You are a focused specialist sub-agent. Complete the requested task concisely and accurately.',
                                            enabled: true,
                                        },
                                    ],
                                    enabledTools: [...DEFAULT_SUBAGENT_TOOLS],
                                    permissions: { read: ['/**'], write: [] },
                                    maxToolRounds: 0,
                                    description: matchedSub.description,
                                };
                            }
                            if (matchedSub.instructions.trim() && refProfile) {
                                subAgentPromptPrefix = matchedSub.instructions.trim();
                            }
                        } else if (env.effectiveAgents[requestedAgentId]) {
                            profile = canonicalClone(env.effectiveAgents[requestedAgentId]);
                        } else {
                            return {
                                agentId: requestedAgentId,
                                content: '',
                                ok: false,
                                error: `Agent "${requestedAgentId}" not found in active preset or World Info @@agent entries.`,
                            };
                        }
                    }
                } else {
                    profile = {
                        id: 'script_agent',
                        name: 'Script Agent',
                        connectionId: 'inherit',
                        sessionMode: 'ephemeral',
                        ephemeralWindowSize: 4,
                        promptBlocks: [
                            {
                                id: 'system_base',
                                name: 'Script Agent System',
                                role: 'system',
                                placement: 'prefix',
                                content:
                                    'You are a concise helper agent invoked by a script. Complete the requested task accurately.',
                                enabled: true,
                            },
                        ],
                        enabledTools: ['read_file', 'read_variables'],
                        permissions: { read: ['/**'], write: [] },
                        maxToolRounds: 0,
                    };
                }

                // Isolate script-invoked runs from mainline persistent Layer 1 trajectories.
                profile.sessionMode = 'ephemeral';
                if (typeof optsRecord.connectionId === 'string' && optsRecord.connectionId.trim()) {
                    profile.connectionId = optsRecord.connectionId.trim();
                }
                if (
                    typeof optsRecord.maxToolRounds === 'number'
                    && Number.isFinite(optsRecord.maxToolRounds)
                    && optsRecord.maxToolRounds >= 0
                ) {
                    profile.maxToolRounds = Math.floor(optsRecord.maxToolRounds);
                }
                if (optsRecord.permissions) {
                    profile.permissions = {
                        read: [...optsRecord.permissions.read],
                        write: [...optsRecord.permissions.write],
                    };
                }
                const baseTools = Array.isArray(requestedEnabledTools)
                    ? requestedEnabledTools.map((t) => t.trim()).filter(Boolean)
                    : [...profile.enabledTools];
                const extraToolNames = Array.isArray(optsRecord.extraTools)
                    ? optsRecord.extraTools.map((t) => t.trim()).filter(Boolean)
                    : [];
                profile.enabledTools = Array.from(new Set([...baseTools, ...extraToolNames]));

                const userPrompt = subAgentPromptPrefix
                    ? optsRecord.prompt?.trim()
                        ? `${subAgentPromptPrefix}\n\nTask:\n${optsRecord.prompt.trim()}`
                        : subAgentPromptPrefix
                    : (optsRecord.prompt ?? '');

                const systemBasePrompt =
                    typeof optsRecord.systemPrompt === 'string' && optsRecord.systemPrompt.trim()
                        ? optsRecord.systemPrompt.trim()
                        : undefined;

                try {
                    const runResult = await this.agentRunner.run({
                        agent: profile,
                        preset,
                        target,
                        phase,
                        promptTriggerContext: { kind: 'subagent', phase },
                        userInput: userPrompt,
                        ...(systemBasePrompt !== undefined ? { systemBasePrompt } : {}),
                        loreEntries: env.loreEntries,
                        subAgents: env.subAgents,
                        includeCategory4DynamicEntries: false,
                        runTailRadar: false,
                        getVariableSchema: env.globalVarSchema
                            ? () => env.globalVarSchema
                            : undefined,
                        staged,
                        stream: optsRecord.stream ?? false,
                        requireOutputFile: false,
                        ...(optsRecord.vars ? { vars: optsRecord.vars } : {}),
                        ...(optsRecord.macroOverrides
                            ? { macroOverrides: optsRecord.macroOverrides }
                            : {}),
                        ...(baseCtx.injectionSession
                            ? { injectionSession: baseCtx.injectionSession }
                            : {}),
                        ...this.buildAgentRunnerHooks({
                            preset,
                            env,
                            injectionSession: baseCtx.injectionSession,
                            isErrorRecovery: baseCtx.isErrorRecovery,
                        }),
                        signal,
                    });

                    return {
                        runId: runResult.runId,
                        agentId: runResult.agentProfileId,
                        content: runResult.content,
                        ...(runResult.reasoningContent
                            ? { reasoningContent: runResult.reasoningContent }
                            : {}),
                        ok: true,
                        rounds: runResult.rounds,
                        usage: runResult.usage,
                        toolSteps: runResult.toolSteps,
                    };
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) {
                        throw error;
                    }
                    const errMsg = error instanceof Error ? error.message : String(error);
                    return {
                        ...(error instanceof AgentExecutionError
                            ? {
                                runId: error.trace.runId,
                                usage: error.trace.usage,
                                toolSteps: error.trace.toolSteps,
                            }
                            : {}),
                        agentId: profile.id,
                        content: '',
                        ok: false,
                        error: errMsg,
                    };
                }
            } finally {
                cleanup();
            }
        };

        const runTrigger = async (
            ruleId: string,
            rawOpts?: ToolAgentRunTriggerOptions,
        ): Promise<ToolAgentRunResult> => {
            const trimmedId = ruleId.trim();
            if (!trimmedId) {
                return {
                    agentId: '',
                    content: '',
                    ok: false,
                    skipped: true,
                    error: 'Trigger ruleId must not be empty.',
                };
            }
            const { signal, cleanup } = linkAbortSignals(baseCtx.parentSignal, rawOpts?.signal);
            try {
                throwIfAborted(signal);
                const settings = this.settingsProvider();
                const preset = baseCtx.preset ?? resolveActivePreset(settings);
                const env = baseCtx.env ?? await this.compileTurnEnvironment(preset, signal);
                const rule = env.allTriggers.find((item) => item.id === trimmedId);
                if (!rule) {
                    return {
                        agentId: trimmedId,
                        content: '',
                        ok: false,
                        skipped: true,
                        error: `Trigger rule "${trimmedId}" not found.`,
                    };
                }

                const target = freezeTarget(rawOpts?.target ?? baseCtx.defaultTarget);
                const { userText, assistantText } = this.readTurnExchangeText(target);
                const unit: TriggerExecutionUnit = {
                    unitId: `script_trigger:${rule.id}`,
                    phase: rule.phase,
                    order: rule.order,
                    barrier: rule.barrier,
                    agentProfileId: rule.agentProfileId,
                    kind: rule.kind,
                    isGrouped: false,
                    triggers: [rule],
                    label: rule.label,
                    ...(rule.targetPath ? { targetPath: rule.targetPath } : {}),
                };

                try {
                    const execResult = await this.executePreparedUnit(unit, {
                        target,
                        userText,
                        assistantText,
                        preset,
                        effectiveAgents: env.effectiveAgents,
                        derivedAgentsByRuleId: env.derivedAgentsByRuleId,
                        loreEntries: env.loreEntries,
                        subAgents: env.subAgents,
                        globalVarSchema: env.globalVarSchema,
                        staged: baseCtx.defaultStaged,
                        injectionSession: baseCtx.injectionSession,
                        eventPayload: rawOpts?.event,
                        isErrorRecovery: baseCtx.isErrorRecovery,
                        forceDisableOutputFile: true,
                        signal,
                    });

                    return {
                        ...(execResult.agentResult?.runId
                            ? { runId: execResult.agentResult.runId }
                            : {}),
                        agentId: execResult.agentProfileId,
                        content: execResult.output,
                        ...(execResult.agentResult?.reasoningContent
                            ? { reasoningContent: execResult.agentResult.reasoningContent }
                            : {}),
                        ok: true,
                        ...(execResult.skipped ? { skipped: true } : {}),
                        ...(execResult.agentResult?.rounds !== undefined
                            ? { rounds: execResult.agentResult.rounds }
                            : {}),
                        ...(execResult.agentResult?.usage
                            ? { usage: execResult.agentResult.usage }
                            : {}),
                        ...(execResult.agentResult?.toolSteps
                            ? { toolSteps: execResult.agentResult.toolSteps }
                            : {}),
                    };
                } catch (error) {
                    if (isAbortError(error) || signal.aborted) {
                        throw error;
                    }
                    const errMsg = error instanceof Error ? error.message : String(error);
                    return {
                        ...(error instanceof AgentExecutionError
                            ? {
                                runId: error.trace.runId,
                                usage: error.trace.usage,
                                toolSteps: error.trace.toolSteps,
                            }
                            : {}),
                        agentId: rule.agentProfileId,
                        content: '',
                        ok: false,
                        error: errMsg,
                    };
                }
            } finally {
                cleanup();
            }
        };

        return Object.freeze({ run, runTrigger });
    }

    private buildAgentRunnerHooks(hookCtx: {
        preset: Preset;
        env: CompiledTurnEnvironment;
        injectionSession?: PromptInjectionSession;
        isErrorRecovery?: boolean;
    }): {
        sandbox?: ScriptSandbox;
        isErrorRecovery?: boolean;
        onPreprocessMessages: (ctx: AgentPreprocessMessagesContext) => Promise<void>;
        onPostprocessResponse: (ctx: AgentPostprocessResponseContext) => Promise<void>;
        onGenerationError?: (
            ctx: AgentGenerationErrorHookContext,
        ) => Promise<AgentGenerationErrorDecision>;
    } {
        return {
            ...(this.sandbox ? { sandbox: this.sandbox } : {}),
            ...(hookCtx.isErrorRecovery ? { isErrorRecovery: true } : {}),
            onPreprocessMessages: async (prepCtx) => {
                await this.handlePreprocessMessagesHook(prepCtx, hookCtx);
            },
            onPostprocessResponse: async (postCtx) => {
                await this.handlePostprocessResponseHook(postCtx, hookCtx);
            },
            ...(hookCtx.isErrorRecovery
                ? {}
                : {
                    onGenerationError: async (errCtx) =>
                        await this.handleGenerationErrorHook(errCtx, hookCtx),
                }),
        };
    }

    private async handlePreprocessMessagesHook(
        prepCtx: AgentPreprocessMessagesContext,
        hookCtx?: {
            preset: Preset;
            env: CompiledTurnEnvironment;
            injectionSession?: PromptInjectionSession;
            isErrorRecovery?: boolean;
        },
    ): Promise<void> {
        const eventPayload: ToolEventPayload = {
            type: 'prompt_preprocess',
            timestamp: Date.now(),
            target: { ...prepCtx.target },
            messageId: prepCtx.target.messageId,
            swipeId: prepCtx.target.swipeId,
            phase: prepCtx.phase,
            runId: prepCtx.runId,
            agentId: prepCtx.agentId,
            ...(prepCtx.triggerId ? { triggerId: prepCtx.triggerId } : {}),
            round: prepCtx.round,
            attempt: prepCtx.attempt,
            maxAttempts: prepCtx.maxRetries,
            data: {
                layers: { ...prepCtx.layers },
                model: prepCtx.connection.model,
                connectionId: prepCtx.connection.id,
            },
        };
        await this.dispatchEventHooks('prompt_preprocess', eventPayload, {
            target: prepCtx.target,
            phase: prepCtx.phase,
            staged: true,
            signal: prepCtx.signal,
            ...(hookCtx?.preset ? { preset: hookCtx.preset } : {}),
            ...(hookCtx?.env ? { env: hookCtx.env } : {}),
            ...(hookCtx?.injectionSession ? { injectionSession: hookCtx.injectionSession } : {}),
            messages: prepCtx.messages,
            body: prepCtx.body,
            isErrorRecovery: hookCtx?.isErrorRecovery,
        });
    }

    private async handlePostprocessResponseHook(
        postCtx: AgentPostprocessResponseContext,
        hookCtx?: {
            preset: Preset;
            env: CompiledTurnEnvironment;
            injectionSession?: PromptInjectionSession;
            isErrorRecovery?: boolean;
        },
    ): Promise<void> {
        const eventPayload: ToolEventPayload = {
            type: 'output_postprocess',
            timestamp: Date.now(),
            target: { ...postCtx.target },
            messageId: postCtx.target.messageId,
            swipeId: postCtx.target.swipeId,
            phase: postCtx.phase,
            runId: postCtx.runId,
            agentId: postCtx.agentId,
            ...(postCtx.triggerId ? { triggerId: postCtx.triggerId } : {}),
            round: postCtx.round,
            attempt: postCtx.attempt,
            maxAttempts: postCtx.maxRetries,
            output: postCtx.output.text,
            data: {
                content: postCtx.output.content,
                ...(postCtx.output.reasoningContent !== undefined
                    ? { reasoningContent: postCtx.output.reasoningContent }
                    : {}),
                toolCalls: canonicalClone(postCtx.output.toolCalls),
                fixAttempt: postCtx.fixAttempt,
                maxFixAttempts: postCtx.maxFixAttempts,
            },
        };
        await this.dispatchEventHooks('output_postprocess', eventPayload, {
            target: postCtx.target,
            phase: postCtx.phase,
            staged: true,
            signal: postCtx.signal,
            ...(hookCtx?.preset ? { preset: hookCtx.preset } : {}),
            ...(hookCtx?.env ? { env: hookCtx.env } : {}),
            ...(hookCtx?.injectionSession ? { injectionSession: hookCtx.injectionSession } : {}),
            output: postCtx.output,
            control: postCtx.control,
            isErrorRecovery: hookCtx?.isErrorRecovery,
            shouldStop: () =>
                postCtx.control.action === 'abort' || postCtx.control.action === 'retry',
        });
    }

    private async handleGenerationErrorHook(
        errCtx: AgentGenerationErrorHookContext,
        hookCtx: {
            preset: Preset;
            env: CompiledTurnEnvironment;
            injectionSession?: PromptInjectionSession;
        },
    ): Promise<AgentGenerationErrorDecision> {
        const errorControl = createErrorRecoveryControl();
        let hookRolledBackDirectly = false;
        let hookDroppedHistoryDirectly = false;

        const trackedMessagesApi: ToolEphemeralMessagesApi = {
            list: () => errCtx.ephemeralMessages.list(),
            set: (nextMessages) => errCtx.ephemeralMessages.set(nextMessages),
            rollbackToolRounds: (count?: number) => {
                const removed = errCtx.ephemeralMessages.rollbackToolRounds(count);
                if (removed > 0) {
                    hookRolledBackDirectly = true;
                }
                return removed;
            },
            dropHistoryTurns: (count?: number, opts?: { from?: 'newest' | 'oldest' }) => {
                const dropped = errCtx.ephemeralMessages.dropHistoryTurns(count, opts);
                if (dropped > 0) {
                    hookDroppedHistoryDirectly = true;
                }
                return dropped;
            },
            replaceContent: (selector, replacer) =>
                errCtx.ephemeralMessages.replaceContent(selector, replacer),
            appendHint: (content, role) => errCtx.ephemeralMessages.appendHint(content, role),
            toMessages: () => errCtx.ephemeralMessages.toMessages(),
        };

        const eventPayload: ToolEventPayload = {
            type: 'generation_error',
            timestamp: Date.now(),
            target: { ...errCtx.target },
            messageId: errCtx.target.messageId,
            swipeId: errCtx.target.swipeId,
            phase: errCtx.phase,
            runId: errCtx.runId,
            agentId: errCtx.agentId,
            ...(errCtx.triggerId ? { triggerId: errCtx.triggerId } : {}),
            round: errCtx.round,
            attempt: errCtx.attempt,
            maxAttempts: errCtx.maxAttempts,
            error: errCtx.error.message,
            ...(errCtx.error.code ? { errorCode: errCtx.error.code } : {}),
            ...(errCtx.error.status !== undefined ? { statusCode: errCtx.error.status } : {}),
            data: {
                layers: { ...errCtx.layers },
                ...(errCtx.error.rawBody !== undefined ? { rawBody: errCtx.error.rawBody } : {}),
            },
        };

        let resolvedDecision: AgentGenerationErrorDecision | undefined;

        const buildRetryDecision = (params: {
            reason?: string;
            delayMs?: number;
            messages?: CanonicalMessage[];
            rollbackToolRounds?: number;
            dropHistoryTurns?: number;
            connectionId?: string;
            temperature?: number;
            maxTokens?: number;
        }): AgentGenerationErrorDecision => {
            if (
                !hookRolledBackDirectly
                && typeof params.rollbackToolRounds === 'number'
                && params.rollbackToolRounds > 0
            ) {
                errCtx.ephemeralMessages.rollbackToolRounds(params.rollbackToolRounds);
            }
            if (
                !hookDroppedHistoryDirectly
                && typeof params.dropHistoryTurns === 'number'
                && params.dropHistoryTurns > 0
            ) {
                errCtx.ephemeralMessages.dropHistoryTurns(params.dropHistoryTurns);
            }
            const nextMessages = params.messages ?? errCtx.ephemeralMessages.toMessages();
            return {
                action: 'retry',
                ...(params.reason !== undefined ? { reason: params.reason } : {}),
                ...(params.delayMs !== undefined ? { delayMs: params.delayMs } : {}),
                messages: nextMessages,
                ...(params.rollbackToolRounds !== undefined
                    ? { rollbackToolRounds: params.rollbackToolRounds }
                    : {}),
                ...(params.dropHistoryTurns !== undefined
                    ? { dropHistoryTurns: params.dropHistoryTurns }
                    : {}),
                ...(params.connectionId !== undefined ? { connectionId: params.connectionId } : {}),
                ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
                ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
            };
        };

        await this.dispatchEventHooks('generation_error', eventPayload, {
            target: errCtx.target,
            phase: errCtx.phase,
            staged: true,
            signal: errCtx.signal,
            preset: hookCtx.preset,
            env: hookCtx.env,
            injectionSession: hookCtx.injectionSession,
            messages: trackedMessagesApi,
            control: errorControl,
            isErrorRecovery: true,
            shouldStop: (ruleResult) => {
                if (errorControl.action === 'abort') {
                    resolvedDecision = {
                        action: 'abort',
                        ...(errorControl.reason !== undefined
                            ? { reason: errorControl.reason }
                            : {}),
                    };
                    return true;
                }
                if (errorControl.action === 'retry') {
                    resolvedDecision = buildRetryDecision({
                        reason: errorControl.reason,
                        delayMs: errorControl.delayMs,
                        rollbackToolRounds: errorControl.rollbackToolRounds,
                        dropHistoryTurns: errorControl.dropHistoryTurns,
                        connectionId: errorControl.connectionId,
                        temperature: errorControl.temperature,
                        maxTokens: errorControl.maxTokens,
                    });
                    return true;
                }

                const parsedRet = parseErrorRecoveryReturnDecision(ruleResult.rawResult);
                if (parsedRet?.action === 'abort') {
                    resolvedDecision = parsedRet;
                    return true;
                }
                if (parsedRet?.action === 'retry') {
                    resolvedDecision = buildRetryDecision(parsedRet);
                    return true;
                }
                return false;
            },
        });

        return resolvedDecision ?? { action: 'pass' };
    }

    private handleBackgroundTriggerFailure(
        error: unknown,
        ctx: {
            target: MessageTarget;
            phase: PipelinePhase;
            agentId?: string;
            triggerId?: string;
            signal: AbortSignal;
        },
    ): void {
        if (
            (error instanceof AgentExecutionError || error instanceof MaxToolRoundsError)
            && error.checkpoint
        ) {
            this.trajectoryStore.saveInterruptedCheckpoint(error.checkpoint);
            this.trajectoryStore.saveToHost(this.bridge);
        }

        const aborted = isAbortError(error) || ctx.signal.aborted;
        if (aborted) {
            const abortMessage = error instanceof Error ? error.message : 'Background trigger aborted';
            void this.emitAbortedHostEvent({
                target: ctx.target,
                phase: ctx.phase,
                agentId: ctx.agentId,
                triggerId: ctx.triggerId,
                reason: abortMessage,
            }).catch(() => {});
            return;
        }

        this.emitUnrecoveredErrorHostEvent({
            target: ctx.target,
            phase: ctx.phase,
            agentId: ctx.agentId,
            triggerId: ctx.triggerId,
            error,
        });
    }

    private emitUnrecoveredErrorHostEvent(params: {
        target: MessageTarget;
        phase: PipelinePhase;
        agentId?: string;
        triggerId?: string;
        error: unknown;
    }): void {
        const diag = extractErrorDiagnostics(params.error);
        const trace = params.error instanceof AgentExecutionError ? params.error.trace : undefined;
        const payload: ToolEventPayload = {
            type: 'generation_error',
            timestamp: Date.now(),
            target: { ...params.target },
            messageId: params.target.messageId,
            swipeId: params.target.swipeId,
            phase: params.phase,
            ...(trace?.runId ? { runId: trace.runId } : {}),
            ...(params.agentId ?? trace?.agentProfileId
                ? { agentId: params.agentId ?? trace?.agentProfileId }
                : {}),
            ...(params.triggerId ?? trace?.triggerId
                ? { triggerId: params.triggerId ?? trace?.triggerId }
                : {}),
            error: diag.message,
            ...(diag.code ? { errorCode: diag.code } : {}),
            ...(diag.status !== undefined ? { statusCode: diag.status } : {}),
        };
        this.bridge.emitHostEvent?.('agentic_generation_error', payload);
    }

    private async emitAbortedHostEvent(params: {
        target: MessageTarget;
        phase: PipelinePhase;
        agentId?: string;
        triggerId?: string;
        reason: string;
    }): Promise<void> {
        const payload: ToolEventPayload = {
            type: 'turn_aborted',
            timestamp: Date.now(),
            target: { ...params.target },
            messageId: params.target.messageId,
            swipeId: params.target.swipeId,
            phase: params.phase,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.triggerId ? { triggerId: params.triggerId } : {}),
            reason: params.reason,
            error: params.reason,
        };
        this.bridge.emitHostEvent?.('agentic_turn_aborted', payload);
        await this.dispatchEventHooks('turn_aborted', payload, {
            target: params.target,
            phase: params.phase,
            staged: false,
            isErrorRecovery: true,
        }).catch((hookErr) => {
            console.warn('[ST-Agentic] turn_aborted event hook error:', hookErr);
        });
    }

    /** Evaluate whether a `TriggerRule`'s `condition` (and optional `findRegex`) matches. */
    async evaluateCondition(
        rule: TriggerRule,
        context: {
            target: MessageTarget;
            turnNumber: number;
            scanText: string;
            signal: AbortSignal;
            staged?: boolean;
            injectionSession?: PromptInjectionSession;
        },
    ): Promise<{ matched: boolean; matchOverrides?: Record<string, string> }> {
        throwIfAborted(context.signal);
        const cond = rule.condition;
        let matched = false;
        let matchOverrides: Record<string, string> | undefined;

        switch (cond.type) {
            case 'always': {
                matched = true;
                break;
            }
            case 'interval': {
                const interval = Math.max(1, Math.trunc(cond.interval ?? 1));
                matched = context.turnNumber > 0 && context.turnNumber % interval === 0;
                break;
            }
            case 'regex': {
                const pattern = cond.pattern ?? '';
                if (!pattern) {
                    matched = false;
                    break;
                }
                const compiled = compileRegexPattern(pattern);
                if (!compiled.ok || !compiled.regex) {
                    matched = false;
                    break;
                }
                compiled.regex.lastIndex = 0;
                const exec = compiled.regex.exec(context.scanText);
                matched = Boolean(exec);
                if (exec) {
                    matchOverrides = extractRegexMatchOverrides(exec);
                }
                break;
            }
            case 'keyword': {
                const keys = cond.keys ?? [];
                if (keys.length === 0) {
                    matched = false;
                    break;
                }
                matched = keys.some((rawKey) => matchConditionKeyword(rawKey, context.scanText));
                break;
            }
            case 'js_predicate': {
                const code = cond.predicateCode?.trim() ?? '';
                if (!code || !this.sandbox) {
                    matched = false;
                    break;
                }
                const toolCtx = createToolExecutionContext({
                    bridge: this.bridge,
                    vfs: this.vfs,
                    store: this.store,
                    ...(this.sideGen ? { sideGen: this.sideGen } : {}),
                    target: context.target,
                    signal: context.signal,
                    permissions: { read: ['/**'], write: [] },
                    staged: true,
                    source: `predicate:${rule.id}`,
                });
                const evalResult = await this.sandbox.evaluateScript(code, toolCtx, {
                    id: `predicate_${rule.id}_${context.target.messageId}_${context.target.swipeId}`,
                    allowNetwork: false,
                });
                matched = Boolean(evalResult);
                break;
            }
        }

        if (!matched) {
            return { matched: false };
        }

        if (rule.findRegex) {
            const compiledFind = compileRegexPattern(rule.findRegex);
            if (!compiledFind.ok || !compiledFind.regex) {
                return { matched: false };
            }
            compiledFind.regex.lastIndex = 0;
            const exec = compiledFind.regex.exec(context.scanText);
            if (!exec) {
                return { matched: false };
            }
            matchOverrides = {
                ...(matchOverrides ?? {}),
                ...extractRegexMatchOverrides(exec),
            };
        }

        if (rule.ifConditions && rule.ifConditions.length > 0) {
            const vars = await this.vfs
                .readVariables({ target: context.target, staged: context.staged ?? true })
                .catch(() => ({}));
            throwIfAborted(context.signal);
            const ifMatched = await evaluateIfConditions(rule.ifConditions, this.bridge, vars, {
                injectionSession: context.injectionSession,
            });
            if (!ifMatched) {
                return { matched: false };
            }
        }

        return { matched: true, matchOverrides };
    }

    private async executeOrderedSyncUnits(
        rules: readonly TriggerRule[],
        ctx: {
            target: MessageTarget;
            turnNumber: number;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents: Record<string, AgentProfile>;
            derivedAgentsByRuleId: Record<string, AgentProfile>;
            loreEntries: readonly RawLoreEntry[];
            subAgents: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            injectionSession?: PromptInjectionSession;
            signal: AbortSignal;
            resultsOut: TriggerExecutionResult[];
        },
    ): Promise<void> {
        if (rules.length === 0) {
            return;
        }

        const ruleBatches = groupRulesByOrder(rules);
        for (const ruleBatch of ruleBatches) {
            throwIfAborted(ctx.signal);
            const matchedRules: TriggerRule[] = [];
            const matchOverridesByRuleId = new Map<string, Record<string, string>>();

            for (const rule of ruleBatch) {
                if (!rule.enabled) {
                    continue;
                }
                const evalRes = await this.evaluateCondition(rule, {
                    target: ctx.target,
                    turnNumber: ctx.turnNumber,
                    scanText: ctx.userText,
                    signal: ctx.signal,
                    staged: ctx.staged,
                    injectionSession: ctx.injectionSession,
                });
                if (evalRes.matched) {
                    matchedRules.push(rule);
                    if (evalRes.matchOverrides) {
                        matchOverridesByRuleId.set(rule.id, evalRes.matchOverrides);
                    }
                }
            }

            if (matchedRules.length === 0) {
                continue;
            }

            const units = groupTriggersForExecution(matchedRules);
            const batchResults = await Promise.all(
                units.map((unit) =>
                    this.executePreparedUnit(unit, {
                        target: ctx.target,
                        userText: ctx.userText,
                        assistantText: ctx.assistantText,
                        preset: ctx.preset,
                        effectiveAgents: ctx.effectiveAgents,
                        derivedAgentsByRuleId: ctx.derivedAgentsByRuleId,
                        loreEntries: ctx.loreEntries,
                        subAgents: ctx.subAgents,
                        globalVarSchema: ctx.globalVarSchema,
                        staged: ctx.staged,
                        injectionSession: ctx.injectionSession,
                        matchOverrides: mergeUnitMatchOverrides(unit.triggers, matchOverridesByRuleId),
                        signal: ctx.signal,
                    }),
                ),
            );
            for (const res of batchResults) {
                if (res) {
                    ctx.resultsOut.push(res);
                }
            }
        }
    }

    private async matchAfterTurnBatch(
        ruleBatch: readonly TriggerRule[],
        context: {
            target: MessageTarget;
            turnNumber: number;
            scanText: string;
            signal: AbortSignal;
            staged: boolean;
            injectionSession?: PromptInjectionSession;
            onlyTriggerIds?: ReadonlySet<string>;
        },
    ): Promise<{
        matchedRules: TriggerRule[];
        matchOverridesByRuleId: Map<string, Record<string, string>>;
    }> {
        const matchedRules: TriggerRule[] = [];
        const matchOverridesByRuleId = new Map<string, Record<string, string>>();
        for (const rule of ruleBatch) {
            const isForcedSingle = Boolean(context.onlyTriggerIds?.has(rule.id));
            let evaluated: { matched: boolean; matchOverrides?: Record<string, string> };
            try {
                evaluated = await this.evaluateCondition(rule, {
                    target: context.target,
                    turnNumber: context.turnNumber,
                    scanText: context.scanText,
                    signal: context.signal,
                    staged: context.staged,
                    injectionSession: context.injectionSession,
                });
            } catch (error) {
                if (isAbortError(error) || context.signal.aborted || !isForcedSingle) {
                    throw error;
                }
                evaluated = { matched: true };
            }
            if (evaluated.matched || isForcedSingle) {
                matchedRules.push(rule);
                if (evaluated.matchOverrides) {
                    matchOverridesByRuleId.set(rule.id, evaluated.matchOverrides);
                }
            }
        }
        return { matchedRules, matchOverridesByRuleId };
    }

    private async dispatchAfterTurnUnits(params: {
        target: MessageTarget;
        turnNumber: number;
        userText: string;
        assistantText: string;
        preset: Preset;
        effectiveAgents: Record<string, AgentProfile>;
        derivedAgentsByRuleId: Record<string, AgentProfile>;
        allTriggers: readonly TriggerRule[];
        loreEntries: readonly RawLoreEntry[];
        subAgents: readonly SubAgentDescriptor[];
        globalVarSchema?: z.ZodTypeAny;
        injectionSession?: PromptInjectionSession;
        onlyTriggerIds?: ReadonlySet<string>;
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const allowDisabled = Boolean(params.force && params.onlyTriggerIds);
        const afterRules = params.allTriggers.filter(
            (t) =>
                t.phase === 'after_turn'
                && (t.enabled || allowDisabled)
                && (!params.onlyTriggerIds
                    ? !isEventDrivenTriggerRule(t)
                    : params.onlyTriggerIds.has(t.id)),
        );
        if (afterRules.length === 0) {
            return [];
        }

        const scanText = params.assistantText || params.userText;
        const orderBatches = groupRulesByOrder(afterRules);
        const handles: DispatchedTaskHandle<TriggerExecutionResult>[] = [];
        let prevTurnOrderPromise: Promise<unknown> | undefined;
        let prevAnyOrderPromise: Promise<unknown> | undefined;

        for (let batchIdx = 0; batchIdx < orderBatches.length; batchIdx += 1) {
            const ruleBatch = orderBatches[batchIdx];
            const batchHasIf = ruleBatch.some((r) => (r.ifConditions?.length ?? 0) > 0);
            const waitBeforeBatch = prevTurnOrderPromise ?? (batchHasIf ? prevAnyOrderPromise : undefined);

            if (batchIdx === 0 || !waitBeforeBatch) {
                const { matchedRules, matchOverridesByRuleId } = await this.matchAfterTurnBatch(
                    ruleBatch,
                    {
                        target: params.target,
                        turnNumber: params.turnNumber,
                        scanText,
                        signal: params.signal ?? new AbortController().signal,
                        staged: false,
                        injectionSession: params.injectionSession,
                        onlyTriggerIds: params.onlyTriggerIds,
                    },
                );
                if (matchedRules.length === 0) {
                    continue;
                }

                const units = groupTriggersForExecution(matchedRules, {
                    includeDisabled: allowDisabled,
                });
                const batchTurnPromises: Promise<unknown>[] = [];
                const batchAllPromises: Promise<unknown>[] = [];

                for (const unit of units) {
                    const unitOverrides = mergeUnitMatchOverrides(
                        unit.triggers,
                        matchOverridesByRuleId,
                    );
                    const unitTriggerIds = unit.triggers.map((t) => t.id).join(',');
                    const handle = this.barrierCoordinator.dispatch<TriggerExecutionResult>(
                        {
                            target: params.target,
                            phase: 'after_turn',
                            barrier: unit.barrier,
                            agentProfileId: unit.agentProfileId,
                            label: unit.label,
                            ...(unit.targetPath ? { targetPath: unit.targetPath } : {}),
                        },
                        async (taskCtx) => {
                            taskCtx.setCurrentStep(
                                unit.kind === 'script'
                                    ? `Running script (${unit.label})`
                                    : `Running ${unit.agentProfileId}`,
                            );

                            try {
                                const result = await this.executePreparedUnit(unit, {
                                    target: taskCtx.target,
                                    userText: params.userText,
                                    assistantText: params.assistantText,
                                    preset: params.preset,
                                    effectiveAgents: params.effectiveAgents,
                                    derivedAgentsByRuleId: params.derivedAgentsByRuleId,
                                    loreEntries: params.loreEntries,
                                    subAgents: params.subAgents,
                                    globalVarSchema: params.globalVarSchema,
                                    staged: true,
                                    injectionSession: params.injectionSession,
                                    matchOverrides: unitOverrides,
                                    taskId: taskCtx.taskId,
                                    checkpointScope: {
                                        phase: 'after_turn',
                                        triggerId: unitTriggerIds,
                                    },
                                    onToolStart: (step) => {
                                        taskCtx.setCurrentStep(`${unit.label} · ${step.toolName}`);
                                    },
                                    onRetrying: (info) => {
                                        taskCtx.setCurrentStep(
                                            `${unit.label} · 自动重试 (${info.attempt}/${info.maxAttempts}): ${info.reason}`,
                                        );
                                    },
                                    signal: taskCtx.signal,
                                });

                                throwIfAborted(taskCtx.signal);
                                this.store.commitStagedData(taskCtx.target);
                                return result;
                            } catch (error) {
                                this.handleBackgroundTriggerFailure(error, {
                                    target: taskCtx.target,
                                    phase: 'after_turn',
                                    agentId: unit.agentProfileId,
                                    triggerId: unitTriggerIds,
                                    signal: taskCtx.signal,
                                });
                                throw error;
                            }
                        },
                    );
                    batchAllPromises.push(handle.promise);
                    if (unit.barrier === 'turn') {
                        batchTurnPromises.push(handle.promise);
                    }
                    handles.push(handle);
                }

                if (batchAllPromises.length > 0) {
                    prevAnyOrderPromise = Promise.allSettled(batchAllPromises);
                }
                if (batchTurnPromises.length > 0) {
                    prevTurnOrderPromise = Promise.allSettled(batchTurnPromises);
                }
                continue;
            }

            // Subsequent order batch after a prior `turn` barrier: defer filtering & merging until
            // the prior batch commits its variables/files so `@@if` sees the updated state.
            const strictestBarrier = resolveStrictestBarrier(ruleBatch);
            const batchOrder = ruleBatch[0]?.order ?? 1;
            const handle = this.barrierCoordinator.dispatch<TriggerExecutionResult>(
                {
                    target: params.target,
                    phase: 'after_turn',
                    barrier: strictestBarrier,
                    agentProfileId: 'after_turn_batch',
                    label: `after_turn batch (order=${batchOrder})`,
                },
                async (taskCtx) => {
                    await waitBeforeBatch;
                    throwIfAborted(taskCtx.signal);

                    const { matchedRules, matchOverridesByRuleId } =
                        await this.matchAfterTurnBatch(ruleBatch, {
                            target: taskCtx.target,
                            turnNumber: params.turnNumber,
                            scanText,
                            signal: taskCtx.signal,
                            staged: false,
                            injectionSession: params.injectionSession,
                            onlyTriggerIds: params.onlyTriggerIds,
                        });

                    if (matchedRules.length === 0) {
                        return {
                            unitId: `batch:after:${batchOrder}`,
                            phase: 'after_turn',
                            target: taskCtx.target,
                            kind: 'script',
                            triggerIds: [],
                            agentProfileId: 'after_turn_batch',
                            output: '',
                            skipped: true,
                        };
                    }

                    const units = groupTriggersForExecution(matchedRules, {
                        includeDisabled: allowDisabled,
                    });
                    taskCtx.setCurrentStep(
                        units.length === 1
                            ? `Running ${units[0].label}`
                            : `Running ${units.length} after_turn units`,
                    );

                    const unitResults = await Promise.all(
                        units.map(async (unit) => {
                            const unitTriggerIds = unit.triggers.map((t) => t.id).join(',');
                            try {
                                return await this.executePreparedUnit(unit, {
                                    target: taskCtx.target,
                                    userText: params.userText,
                                    assistantText: params.assistantText,
                                    preset: params.preset,
                                    effectiveAgents: params.effectiveAgents,
                                    derivedAgentsByRuleId: params.derivedAgentsByRuleId,
                                    loreEntries: params.loreEntries,
                                    subAgents: params.subAgents,
                                    globalVarSchema: params.globalVarSchema,
                                    staged: true,
                                    injectionSession: params.injectionSession,
                                    matchOverrides: mergeUnitMatchOverrides(
                                        unit.triggers,
                                        matchOverridesByRuleId,
                                    ),
                                    taskId: taskCtx.taskId,
                                    checkpointScope: {
                                        phase: 'after_turn',
                                        triggerId: unitTriggerIds,
                                    },
                                    onToolStart: (step) => {
                                        taskCtx.setCurrentStep(`${unit.label} · ${step.toolName}`);
                                    },
                                    onRetrying: (info) => {
                                        taskCtx.setCurrentStep(
                                            `${unit.label} · 自动重试 (${info.attempt}/${info.maxAttempts}): ${info.reason}`,
                                        );
                                    },
                                    signal: taskCtx.signal,
                                });
                            } catch (error) {
                                this.handleBackgroundTriggerFailure(error, {
                                    target: taskCtx.target,
                                    phase: 'after_turn',
                                    agentId: unit.agentProfileId,
                                    triggerId: unitTriggerIds,
                                    signal: taskCtx.signal,
                                });
                                throw error;
                            }
                        }),
                    );

                    throwIfAborted(taskCtx.signal);
                    this.store.commitStagedData(taskCtx.target);

                    const combinedOutput = unitResults
                        .map((r) => r.output.trim())
                        .filter(Boolean)
                        .join('\n\n');
                    const last = unitResults[unitResults.length - 1];
                    return {
                        unitId: `batch:after:${batchOrder}`,
                        phase: 'after_turn',
                        target: taskCtx.target,
                        kind: last?.kind ?? 'agent',
                        triggerIds: unitResults.flatMap((r) => r.triggerIds),
                        agentProfileId: last?.agentProfileId ?? 'after_turn_batch',
                        output: combinedOutput,
                        ...(last?.agentResult ? { agentResult: last.agentResult } : {}),
                    };
                },
            );

            const handlePromise = Promise.allSettled([handle.promise]);
            prevAnyOrderPromise = handlePromise;
            if (strictestBarrier === 'turn') {
                prevTurnOrderPromise = handlePromise;
            }
            handles.push(handle);
        }

        return handles;
    }

    private dispatchMaintenanceChecks(params: {
        target: MessageTarget;
        preset: Preset;
        effectiveAgents: Record<string, AgentProfile>;
        allTriggers: readonly TriggerRule[];
        loreEntries: readonly RawLoreEntry[];
    }): DispatchedTaskHandle<WatermarkCompactionResult>[] {
        const handles: DispatchedTaskHandle<WatermarkCompactionResult>[] = [];
        const checkedIds = new Set<string>();

        for (const agent of Object.values(params.effectiveAgents)) {
            if (agent.sessionMode !== 'persistent' || checkedIds.has(agent.id)) {
                continue;
            }
            checkedIds.add(agent.id);

            if (this.trajectoryStore.getMessageCount(agent.id) === 0) {
                continue;
            }

            const estimatedTokens = this.watermarkCompactor.estimateCurrentTokens(
                this.trajectoryStore,
                { agentId: agent.id },
            );
            if (!this.watermarkCompactor.shouldCompact(estimatedTokens, agent.watermark)) {
                continue;
            }

            // Main agent compaction uses 'turn' barrier so the next turn's main_turn
            // awaits completion instead of reading stale pre-compaction trajectories.
            const barrier: BarrierPolicy =
                agent.id === params.preset.mainAgentId ? 'turn' : 'self';

            const handle = this.barrierCoordinator.dispatch<WatermarkCompactionResult>(
                {
                    target: params.target,
                    phase: 'maintenance',
                    barrier,
                    agentProfileId: agent.id,
                    label: `Watermark Compaction (${agent.name})`,
                    currentStep: 'Compacting history chunk',
                },
                async (taskCtx) => {
                    return await this.watermarkCompactor.compact(this.trajectoryStore, {
                        agentId: agent.id,
                        watermark: agent.watermark,
                        triggers: params.allTriggers.filter((t) => !isEventDrivenTriggerRule(t)),
                        loreEntries: params.loreEntries,
                        summarizeChunk: this.summarizeChunk,
                        ...this.compactionOptions,
                        signal: taskCtx.signal,
                    });
                },
            );
            handles.push(handle);
        }

        return handles;
    }

    private async executePreparedUnit(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents: Record<string, AgentProfile>;
            derivedAgentsByRuleId?: Record<string, AgentProfile>;
            loreEntries: readonly RawLoreEntry[];
            subAgents: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            injectionSession?: PromptInjectionSession;
            matchOverrides?: Record<string, string>;
            taskId?: string;
            checkpointScope?: { phase: PipelinePhase; triggerId?: string };
            resumeMessages?: readonly CanonicalMessage[];
            initialReadSet?: Record<string, string>;
            overrideAgentProfileId?: string;
            overrideTriggerId?: string;
            eventPayload?: ToolEventPayload;
            isErrorRecovery?: boolean;
            forceDisableOutputFile?: boolean;
            onToolStart?: (step: ToolStepLog) => void;
            onRetrying?: (info: RoundRetryLog) => void;
            signal: AbortSignal;
        },
    ): Promise<TriggerExecutionResult> {
        throwIfAborted(ctx.signal);

        if (unit.kind === 'script') {
            return await this.executeScriptUnit(unit, ctx);
        }

        const startedAt = Date.now();
        const profile =
            (ctx.overrideAgentProfileId
                ? ctx.preset.agents[ctx.overrideAgentProfileId]
                  ?? ctx.effectiveAgents[ctx.overrideAgentProfileId]
                : undefined)
            ?? resolveEffectiveUnitAgentProfile(
                unit,
                ctx.preset,
                ctx.derivedAgentsByRuleId,
                ctx.effectiveAgents,
            );
        const triggerIds =
            unit.triggers.length > 0
                ? unit.triggers.map((t) => t.id)
                : ctx.overrideTriggerId
                    ? ctx.overrideTriggerId.split(',').map((s) => s.trim()).filter(Boolean)
                    : [];
        const triggerIdString = ctx.overrideTriggerId ?? triggerIds.join(',');
        const lorebookNames = collectUnitLorebookNames(unit.triggers);
        const triggerSource = resolveUnitTriggerSource(unit.triggers, lorebookNames);

        let unitSchema: z.ZodTypeAny | undefined;
        let promptInput: string;
        let triggerPrompt: string;
        try {
            unitSchema = await this.compileUnitVariableSchema(unit, ctx.globalVarSchema);
            const built =
                unit.triggers.length > 0
                    ? await this.buildTriggerAgentPrompt(unit, ctx)
                    : { promptInput: '', triggerPrompt: '' };
            promptInput = built.promptInput;
            triggerPrompt = built.triggerPrompt;
        } catch (error) {
            if (!isAbortError(error) && !ctx.signal.aborted) {
                const endedAt = Date.now();
                const conn = resolveConnection(this.settingsProvider(), profile.connectionId);
                const errorMessage = error instanceof Error ? error.message : String(error);
                this.traceLogger.recordTrace(
                    {
                        runId: `trigger_prep_${triggerIds.join('_') || unit.unitId}_${ctx.target.messageId}_${ctx.target.swipeId}_${startedAt}`,
                        target: { ...ctx.target },
                        phase: unit.phase,
                        agentProfileId: profile.id,
                        agentName: profile.name || unit.label,
                        triggerId: triggerIdString,
                        triggerLabel: unit.label,
                        ...(triggerSource ? { triggerSource } : {}),
                        ...(lorebookNames.length > 0 ? { lorebookNames } : {}),
                        connectionId: conn.id,
                        model: conn.model || 'trigger-prep',
                        status: 'error',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: {
                            inputTokens: 0,
                            cachedTokens: 0,
                            outputTokens: 0,
                            totalTokens: 0,
                            cacheHitRate: 0,
                        },
                        toolSteps: [],
                        error: errorMessage,
                    },
                    true,
                );
            }
            throw error;
        }

        const permissions = mergeUnitPermissions(profile.permissions, unit.triggers);
        const triggerTools = resolveUnitTools(profile.enabledTools, unit.triggers);
        const decorators = unit.triggers
            .map((t) => t.decorator)
            .filter((d): d is string => Boolean(d));
        const targetPaths = unit.triggers
            .map((t) => t.targetPath)
            .filter((p): p is string => Boolean(p));

        const triggerMacroOverrides: Record<string, string> = {
            ...(ctx.matchOverrides ?? {}),
            triggerPrompt,
            triggerLabel: unit.label,
            triggerId: triggerIdString,
            triggerPhase: unit.phase,
            triggerTargetPath: unit.targetPath ?? targetPaths.join(','),
        };

        const envForHooks: CompiledTurnEnvironment = {
            loreEntries: [...ctx.loreEntries],
            effectiveAgents: ctx.effectiveAgents,
            derivedAgentsByRuleId: ctx.derivedAgentsByRuleId ?? {},
            allTriggers: [],
            subAgents: [...ctx.subAgents],
            globalVarSchema: ctx.globalVarSchema,
        };
        // Re-derive triggers cheaply only when hooks fire; use compileTurnEnvironment lazily if empty.
        const runnerHooks = this.buildAgentRunnerHooks({
            preset: ctx.preset,
            env: {
                ...envForHooks,
                allTriggers: mergePresetAndCompiledTriggers(
                    ctx.preset.triggers,
                    this.decoratorCompiler.compile(ctx.loreEntries, { preset: ctx.preset }).triggers,
                ),
            },
            injectionSession: ctx.injectionSession,
            isErrorRecovery: ctx.isErrorRecovery,
        });

        const agentResult = await this.agentRunner.run({
            agent: {
                ...profile,
                enabledTools: triggerTools,
                permissions,
            },
            preset: ctx.preset,
            target: ctx.target,
            phase: unit.phase,
            promptTriggerContext: {
                kind: 'trigger',
                phase: unit.phase,
                triggerIds,
                decorators,
                targetPaths,
            },
            ...(ctx.resumeMessages
                ? {
                    resumeMessages: ctx.resumeMessages,
                    ...(ctx.initialReadSet ? { initialReadSet: ctx.initialReadSet } : {}),
                }
                : { userInput: promptInput }),
            loreEntries: ctx.loreEntries,
            subAgents: ctx.subAgents,
            includeCategory4DynamicEntries: false,
            runTailRadar: false,
            getVariableSchema: unitSchema ? () => unitSchema : undefined,
            triggerId: triggerIdString,
            triggerLabel: unit.label,
            ...(triggerSource ? { triggerSource } : {}),
            ...(lorebookNames.length > 0 ? { lorebookNames } : {}),
            ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
            ...(ctx.checkpointScope ? { checkpointScope: ctx.checkpointScope } : {}),
            ...(ctx.forceDisableOutputFile ? { requireOutputFile: false } : {}),
            staged: ctx.staged,
            ...(ctx.injectionSession ? { injectionSession: ctx.injectionSession } : {}),
            ...runnerHooks,
            ...(ctx.onToolStart ? { onToolStart: ctx.onToolStart } : {}),
            ...(ctx.onRetrying ? { onRetrying: ctx.onRetrying } : {}),
            signal: ctx.signal,
            macroOverrides: triggerMacroOverrides,
        });

        return {
            unitId: unit.unitId,
            phase: unit.phase,
            target: ctx.target,
            kind: 'agent',
            triggerIds,
            agentProfileId: profile.id,
            output: agentResult.content,
            agentResult,
        };
    }

    private async executeScriptUnit(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents?: Record<string, AgentProfile>;
            derivedAgentsByRuleId?: Record<string, AgentProfile>;
            loreEntries?: readonly RawLoreEntry[];
            subAgents?: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            injectionSession?: PromptInjectionSession;
            matchOverrides?: Record<string, string>;
            eventPayload?: ToolEventPayload;
            isErrorRecovery?: boolean;
            onToolStart?: (step: ToolStepLog) => void;
            onRetrying?: (info: RoundRetryLog) => void;
            signal: AbortSignal;
        },
    ): Promise<TriggerExecutionResult> {
        const rule = unit.triggers[0];
        const startedAt = Date.now();
        const runId = `script_${rule.id}_${ctx.target.messageId}_${ctx.target.swipeId}_${startedAt}`;
        const code = rule.scriptCode ?? rule.instructionTemplate ?? '';
        const isEjs = Boolean(rule.decorator && rule.decorator.includes('_ejs'));

        const permissions: ScopedPermissions = {
            read: ['/**'],
            write: rule.targetPath
                ? [rule.targetPath]
                : ['/memory/**', '/scratch/**', '/lorebooks/**', '/state/variables.json'],
        };

        const agentApi = this.createToolAgentApi({
            defaultTarget: ctx.target,
            defaultPhase: unit.phase,
            defaultStaged: ctx.staged,
            parentSignal: ctx.signal,
            isErrorRecovery: Boolean(ctx.isErrorRecovery),
            preset: ctx.preset,
            injectionSession: ctx.injectionSession,
        });

        const baseToolCtx = createToolExecutionContext({
            bridge: this.bridge,
            vfs: this.vfs,
            store: this.store,
            ...(this.sideGen ? { sideGen: this.sideGen } : {}),
            target: ctx.target,
            signal: ctx.signal,
            permissions,
            phase: unit.phase,
            staged: ctx.staged,
            source: `script:${rule.id}`,
            getVariableSchema: ctx.globalVarSchema ? () => ctx.globalVarSchema : undefined,
        });
        const toolCtx: ToolExecutionContext = {
            ...baseToolCtx,
            agent: agentApi,
            ...(ctx.eventPayload ? { event: ctx.eventPayload } : {}),
        };

        let output = '';
        let skipped = false;
        let warning: string | undefined;

        try {
            if (isEjs) {
                if (!this.bridge.evaluateOptionalEjs) {
                    skipped = true;
                    warning = `Skipped ${rule.decorator}: HostBridge.evaluateOptionalEjs is not available.`;
                } else {
                    const vars = await this.vfs
                        .readVariables({ target: ctx.target, staged: ctx.staged })
                        .catch(() => ({}));
                    const ejsVars: Record<string, unknown> = {
                        ...vars,
                        ...(ctx.matchOverrides ?? {}),
                        triggerPrompt: code,
                        triggerLabel: rule.label,
                        triggerId: rule.id,
                        triggerPhase: unit.phase,
                        triggerTargetPath: rule.targetPath ?? '',
                        input: ctx.userText,
                        output: ctx.assistantText,
                        target: ctx.target,
                    };
                    const evaluated = await this.bridge.evaluateOptionalEjs(
                        code,
                        ejsVars,
                        ctx.injectionSession ? { injectionSession: ctx.injectionSession } : undefined,
                    );
                    throwIfAborted(ctx.signal);

                    if (rule.decorator?.startsWith('@@replace_ejs') && rule.targetPath) {
                        if (evaluated.trim().length > 0) {
                            await toolCtx.fs.write(rule.targetPath, evaluated);
                        }
                        output = evaluated;
                    } else if (rule.decorator?.startsWith('@@append_output_ejs')) {
                        if (evaluated.trim().length > 0) {
                            await toolCtx.message.appendView(evaluated);
                        }
                        output = evaluated;
                    } else if (rule.decorator?.startsWith('@@replace_output_ejs')) {
                        await toolCtx.message.replaceView(evaluated);
                        output = evaluated;
                    } else {
                        // @@evaluate_ejs(_before): side effects only, output discarded from brief
                        output = '';
                    }
                }
            } else {
                if (!this.sandbox) {
                    throw new Error(`Script trigger "${rule.label}" requires a ScriptSandbox instance.`);
                }
                const rawResult = await this.sandbox.evaluateScript(code, toolCtx, {
                    id: runId,
                    allowNetwork: true,
                });
                throwIfAborted(ctx.signal);
                if (typeof rawResult === 'string') {
                    output = rawResult;
                } else if (rawResult !== undefined && rawResult !== null) {
                    output = JSON.stringify(rawResult);
                }
            }
        } catch (error) {
            if (!isAbortError(error) && !ctx.signal.aborted) {
                const endedAt = Date.now();
                const conn = resolveConnection(this.settingsProvider(), 'inherit');
                const errorMessage = error instanceof Error ? error.message : String(error);
                const lorebookNames = collectUnitLorebookNames([rule]);
                const triggerSource = resolveUnitTriggerSource([rule], lorebookNames);
                this.traceLogger.recordTrace(
                    {
                        runId,
                        target: { ...ctx.target },
                        phase: unit.phase,
                        agentProfileId: rule.agentProfileId || 'script',
                        agentName: rule.label,
                        triggerId: rule.id,
                        triggerLabel: rule.label,
                        ...(triggerSource ? { triggerSource } : {}),
                        ...(lorebookNames.length > 0 ? { lorebookNames } : {}),
                        connectionId: conn.id,
                        model: '0-token-script',
                        status: 'error',
                        startedAt,
                        endedAt,
                        durationMs: Math.max(0, endedAt - startedAt),
                        usage: {
                            inputTokens: 0,
                            cachedTokens: 0,
                            outputTokens: 0,
                            totalTokens: 0,
                            cacheHitRate: 0,
                        },
                        toolSteps: [],
                        error: errorMessage,
                    },
                    true,
                );
            }
            throw error;
        }

        return {
            unitId: unit.unitId,
            phase: unit.phase,
            target: ctx.target,
            kind: 'script',
            triggerIds: [rule.id],
            agentProfileId: rule.agentProfileId || 'script',
            output,
            ...(skipped ? { skipped: true } : {}),
            ...(warning ? { warning } : {}),
        };
    }

    private async buildTriggerAgentPrompt(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            userText: string;
            assistantText: string;
            staged?: boolean;
            injectionSession?: PromptInjectionSession;
            matchOverrides?: Record<string, string>;
        },
    ): Promise<{ promptInput: string; triggerPrompt: string }> {
        const macroOverrides: Record<string, string> = {
            ...(ctx.matchOverrides ?? {}),
            input: ctx.userText,
            output: ctx.assistantText,
            lastMessage: ctx.assistantText || ctx.userText,
        };

        const hasEjsTemplates = unit.triggers.some((r) => r.instructionTemplate.includes('<%'));
        let baseVars: Record<string, unknown> | undefined;
        if (this.bridge.transformPromptText || (hasEjsTemplates && this.bridge.evaluateOptionalEjs)) {
            baseVars = await this.vfs
                .readVariables({ target: ctx.target, staged: ctx.staged ?? true })
                .catch(() => ({}));
        }

        const renderRuleTemplate = async (rule: TriggerRule): Promise<string> => {
            const ruleOverrides: Record<string, string> = {
                ...macroOverrides,
                triggerLabel: rule.label,
                triggerId: rule.id,
                triggerPhase: unit.phase,
                triggerTargetPath: rule.targetPath ?? '',
            };
            let text = this.bridge.substituteMacros(rule.instructionTemplate, ruleOverrides);
            if (this.bridge.transformPromptText || (baseVars && this.bridge.evaluateOptionalEjs && text.includes('<%'))) {
                const ejsVars: Record<string, unknown> = {
                    ...(baseVars ?? {}),
                    ...ruleOverrides,
                    target: ctx.target,
                };
                const res = await runPromptTransform(this.bridge, {
                    text,
                    source: 'trigger_prompt',
                    layer: 'trigger',
                    meta: {
                        sessionId: `trigger_${unit.unitId}`,
                        phase: unit.phase,
                        target: ctx.target,
                        isChatMessage: false,
                        vars: ejsVars,
                        ...(ctx.injectionSession ? { injectionSession: ctx.injectionSession } : {}),
                    },
                    onError: 'fallback',
                });
                text = res.text;
            }
            return text.trim();
        };

        const sections: string[] = [];
        let triggerPrompt = '';
        if (unit.triggers.length === 1) {
            const rule = unit.triggers[0];
            const rendered = await renderRuleTemplate(rule);
            triggerPrompt = rendered;
            if (rule.targetPath) {
                sections.push(`Target VFS Path: ${rule.targetPath}`);
            }
            if (rendered) {
                sections.push(rendered);
            }
        } else {
            sections.push(
                [
                    `Grouped Trigger Batch (${unit.groupName ?? unit.label}, ${unit.triggers.length} tasks):`,
                    `- Complete ALL ${unit.triggers.length} tasks below before finishing; do not stop after completing only the first task.`,
                    '- Persist each task\'s changes strictly through the granted tools for its Target VFS Path, and ignore legacy plain-text output-only format directives inside individual task bodies.',
                ].join('\n'),
            );
            const taskSections: string[] = [];
            for (let index = 0; index < unit.triggers.length; index += 1) {
                const rule = unit.triggers[index];
                const header = `### Task ${index + 1}: ${rule.label}${rule.targetPath ? ` (Target: ${rule.targetPath})` : ''}${rule.decorator ? ` [${rule.decorator}]` : ''}`;
                const rendered = await renderRuleTemplate(rule);
                taskSections.push(rendered ? `${header}\n\n${rendered}` : header);
                sections.push(header);
                if (rendered) {
                    sections.push(rendered);
                }
            }
            triggerPrompt = taskSections.join('\n\n');
        }

        if (ctx.userText) {
            sections.push(`Latest User Input:\n${ctx.userText}`);
        }
        if (ctx.assistantText) {
            sections.push(`Latest Assistant Output:\n${ctx.assistantText}`);
        }

        return {
            promptInput: sections.join('\n\n'),
            triggerPrompt,
        };
    }

    private async compileGlobalVariableSchema(
        schemaEntries: readonly RawLoreEntry[],
    ): Promise<z.ZodTypeAny | undefined> {
        if (schemaEntries.length === 0) {
            return undefined;
        }
        return await compileVariableSchemaEntries(schemaEntries, this.sandbox);
    }

    private async compileUnitVariableSchema(
        unit: TriggerExecutionUnit,
        globalSchema?: z.ZodTypeAny,
    ): Promise<z.ZodTypeAny | undefined> {
        let merged: z.ZodTypeAny | undefined = globalSchema;
        for (const rule of unit.triggers) {
            if (!rule.schemaSource) {
                continue;
            }
            try {
                const compiled = await normalizeTriggerSchema(rule.schemaSource, this.sandbox);
                if (compiled) {
                    merged = merged ? deepMergeZod(merged, compiled) : compiled;
                }
            } catch (error) {
                if (isAbortError(error)) {
                    throw error;
                }
                const msg = error instanceof Error ? error.message : String(error);
                throw new Error(`[@@${rule.schemaSource.kind}_schema (${rule.label})] ${msg}`);
            }
        }
        return merged;
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

    private isMainlineThreadId(agentId: string): boolean {
        return !agentId.startsWith('side:') && !agentId.startsWith('assistant:');
    }

    private pruneMainlineTrajectoriesFromMessage(messageId: number): void {
        for (const agentId of this.trajectoryStore.listAgentIds()) {
            if (this.isMainlineThreadId(agentId)) {
                this.trajectoryStore.pruneFromMessage(messageId, agentId);
            }
        }
    }

    private clearNativeVariablesFromMessage(fromMessageId: number): void {
        if (!this.bridge.writeMessageVariables) {
            return;
        }
        const chat = this.bridge.getChat();
        for (let messageId = Math.max(0, fromMessageId); messageId < chat.length; messageId += 1) {
            const variables = chat[messageId]?.variables;
            if (!Array.isArray(variables)) {
                continue;
            }
            for (let swipeId = 0; swipeId < variables.length; swipeId += 1) {
                this.bridge.writeMessageVariables({ messageId, swipeId }, null);
            }
        }
    }

    private restoreTrajectoriesBeforeMessage(messageId: number): void {
        const chat = this.bridge.getChat();
        const swipeLookup = (msgId: number) => chat[msgId]?.swipeId ?? 0;
        for (const agentId of this.trajectoryStore.listAgentIds()) {
            if (this.isMainlineThreadId(agentId)) {
                this.trajectoryStore.restoreBeforeMessage(messageId, agentId, swipeLookup);
            }
        }
    }

    private restoreTrajectoriesForBranch(target: MessageTarget): void {
        for (const agentId of this.trajectoryStore.listAgentIds()) {
            if (this.isMainlineThreadId(agentId)) {
                this.trajectoryStore.restoreBranch(target, agentId);
            }
        }
    }

    private resolveTurnNumber(messageId: number, explicitTurnNumber?: number): number {
        if (explicitTurnNumber !== undefined && Number.isInteger(explicitTurnNumber) && explicitTurnNumber >= 0) {
            return explicitTurnNumber;
        }
        const chat = this.bridge.getChat();
        const userCount = chat
            .slice(0, messageId + 1)
            .filter((msg) => msg.isUser && !msg.isSystem).length;
        if (userCount > 0) {
            return userCount;
        }
        return Math.max(1, Math.floor((messageId + 1) / 2));
    }

    private readExistingChatMessageText(target: MessageTarget): string {
        const chat = this.bridge.getChat();
        const msg = chat[target.messageId];
        if (!msg) {
            return '';
        }
        return msg.swipes?.[target.swipeId] ?? msg.mes ?? '';
    }

    private readTurnExchangeText(target: MessageTarget): { userText: string; assistantText: string } {
        const chat = this.bridge.getChat();
        const targetMsg = chat[target.messageId];
        const assistantText = targetMsg?.swipes?.[target.swipeId] ?? targetMsg?.mes ?? '';
        let userText = '';
        for (let i = target.messageId - 1; i >= 0; i -= 1) {
            const candidate = chat[i];
            if (candidate && candidate.isUser && !candidate.isSystem) {
                userText = candidate.mes ?? '';
                break;
            }
        }
        return { userText, assistantText };
    }
}

function groupRulesByOrder(rules: readonly TriggerRule[]): TriggerRule[][] {
    const sorted = rules
        .map((rule, idx) => ({ rule, idx }))
        .sort((a, b) => a.rule.order - b.rule.order || a.idx - b.idx);
    const batches: TriggerRule[][] = [];
    let currentOrder: number | undefined;
    let currentBatch: TriggerRule[] = [];

    for (const { rule } of sorted) {
        if (currentOrder === undefined || rule.order !== currentOrder) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
            currentOrder = rule.order;
            currentBatch = [rule];
        } else {
            currentBatch.push(rule);
        }
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}

function resolveStrictestBarrier(rules: readonly TriggerRule[]): BarrierPolicy {
    let strictest: BarrierPolicy = 'none';
    for (const rule of rules) {
        if (rule.barrier === 'turn') {
            return 'turn';
        }
        if (rule.barrier === 'self') {
            strictest = 'self';
        }
    }
    return strictest;
}

function mergeUnitMatchOverrides(
    triggers: readonly TriggerRule[],
    overridesByRuleId: ReadonlyMap<string, Record<string, string>>,
): Record<string, string> | undefined {
    let merged: Record<string, string> | undefined;
    for (const rule of triggers) {
        const ov = overridesByRuleId.get(rule.id);
        if (ov) {
            merged = { ...(merged ?? {}), ...ov };
        }
    }
    return merged;
}

function resolveEffectiveUnitAgentProfile(
    unit: TriggerExecutionUnit,
    preset: Preset,
    derivedAgentsByRuleId: Record<string, AgentProfile> | undefined,
    effectiveAgents: Record<string, AgentProfile>,
): AgentProfile {
    if (preset.agents[unit.agentProfileId]) {
        return preset.agents[unit.agentProfileId];
    }

    if (derivedAgentsByRuleId) {
        const survivingDerived: AgentProfile[] = [];
        for (const rule of unit.triggers) {
            const derived = derivedAgentsByRuleId[rule.id];
            if (derived) {
                survivingDerived.push(derived);
            }
        }
        if (survivingDerived.length === 1) {
            return survivingDerived[0];
        }
        if (survivingDerived.length > 1) {
            let acc = survivingDerived[0];
            for (let i = 1; i < survivingDerived.length; i += 1) {
                acc = mergeDerivedAgentProfiles(acc, survivingDerived[i], unit.groupName);
            }
            return acc;
        }
    }

    return (
        effectiveAgents[unit.agentProfileId]
        ?? createDefaultMainAgent({
            id: unit.agentProfileId,
            name: unit.label,
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 4,
        })
    );
}

function matchConditionKeyword(rawKey: string, scanText: string): boolean {
    const trimmed = rawKey.trim();
    if (!trimmed) {
        return false;
    }
    const regex = parseLoreRegex(trimmed);
    if (regex) {
        regex.lastIndex = 0;
        return regex.test(scanText);
    }
    return scanText.toLowerCase().includes(trimmed.toLowerCase());
}

function extractRegexMatchOverrides(exec: RegExpExecArray): Record<string, string> {
    const overrides: Record<string, string> = {
        match: exec[0] ?? '',
    };
    if (exec.groups) {
        for (const [k, v] of Object.entries(exec.groups)) {
            if (typeof v === 'string') {
                overrides[k] = v;
            }
        }
    }
    for (let i = 1; i < exec.length; i += 1) {
        if (typeof exec[i] === 'string') {
            overrides[String(i)] = exec[i];
        }
    }
    return overrides;
}

function mergeUnitPermissions(
    base: ScopedPermissions,
    triggers: readonly TriggerRule[],
): ScopedPermissions {
    const read = new Set(base.read);
    const write = new Set(base.write);
    for (const rule of triggers) {
        if (rule.targetPath) {
            read.add(rule.targetPath);
            if (rule.source === 'worldinfo' || rule.targetPath === OUTPUT_FILE_PATH) {
                write.add(rule.targetPath);
            }
        }
    }
    return {
        read: Array.from(read),
        write: Array.from(write),
    };
}

function resolveUnitTools(
    baseTools: readonly string[],
    triggers: readonly TriggerRule[],
): string[] {
    if (baseTools.length > 0) {
        const merged = new Set(baseTools);
        for (const rule of triggers) {
            if (rule.targetPath === OUTPUT_FILE_PATH) {
                merged.add('read_file');
                merged.add('edit_file');
                merged.add('append_file');
                merged.add('write_file');
            }
            for (const toolName of rule.extraTools ?? []) {
                const trimmed = toolName.trim();
                if (trimmed) {
                    merged.add(trimmed);
                }
            }
        }
        return Array.from(merged);
    }
    const tools = new Set<string>(['read_file', 'read_variables']);
    for (const rule of triggers) {
        if (rule.targetPath === '/state/variables.json') {
            tools.add('patch_variables');
        } else if (rule.targetPath === OUTPUT_FILE_PATH) {
            tools.add('edit_file');
            tools.add('append_file');
            tools.add('write_file');
        } else if (rule.targetPath) {
            tools.add('edit_file');
            tools.add('write_file');
        }
        for (const toolName of rule.extraTools ?? []) {
            const trimmed = toolName.trim();
            if (trimmed) {
                tools.add(trimmed);
            }
        }
    }
    return Array.from(tools);
}

function collectUnitLorebookNames(triggers: readonly TriggerRule[]): string[] {
    const names = new Set<string>();
    for (const rule of triggers) {
        const world = rule.sourceWorld?.trim();
        if (world) {
            names.add(world);
        }
    }
    return Array.from(names);
}

function resolveUnitTriggerSource(
    triggers: readonly TriggerRule[],
    lorebookNames: readonly string[],
): 'preset' | 'worldinfo' | undefined {
    if (lorebookNames.length > 0 || triggers.some((t) => t.source === 'worldinfo')) {
        return 'worldinfo';
    }
    if (triggers.length > 0) {
        return 'preset';
    }
    return undefined;
}

function isEventDrivenTriggerRule(rule: TriggerRule): boolean {
    return Array.isArray(rule.events) && rule.events.length > 0;
}

function sanitizeSegmentLocal(raw: string): string {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '') || 'agent';
}

function linkAbortSignals(
    parent: AbortSignal,
    child?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
    if (!child || child === parent) {
        return { signal: parent, cleanup: () => {} };
    }
    const controller = new AbortController();
    const abortFrom = (src: AbortSignal) => {
        if (!controller.signal.aborted) {
            controller.abort(src.reason ?? createAbortError('Operation aborted'));
        }
    };
    if (parent.aborted) {
        abortFrom(parent);
        return { signal: controller.signal, cleanup: () => {} };
    }
    if (child.aborted) {
        abortFrom(child);
        return { signal: controller.signal, cleanup: () => {} };
    }
    const onParentAbort = () => abortFrom(parent);
    const onChildAbort = () => abortFrom(child);
    parent.addEventListener('abort', onParentAbort, { once: true });
    child.addEventListener('abort', onChildAbort, { once: true });
    return {
        signal: controller.signal,
        cleanup: () => {
            parent.removeEventListener('abort', onParentAbort);
            child.removeEventListener('abort', onChildAbort);
        },
    };
}

function createErrorRecoveryControl(): ToolErrorRecoveryControl {
    const state: {
        action: ToolErrorRecoveryAction;
        reason?: string;
        delayMs?: number;
        rollbackToolRounds?: number;
        dropHistoryTurns?: number;
        connectionId?: string;
        temperature?: number;
        maxTokens?: number;
        mode?: 'round' | 'turn';
        retryOptions?: ToolErrorRecoveryRetryOptions;
        fallbackContent?: string;
    } = {
        action: 'none',
    };

    const control: ToolErrorRecoveryControl = {
        retry(reason?: string, opts?: ToolErrorRecoveryRetryOptions) {
            state.action = 'retry';
            state.reason = reason;
            state.delayMs = opts?.delayMs;
            state.rollbackToolRounds = opts?.rollbackToolRounds;
            state.dropHistoryTurns = opts?.dropHistoryTurns;
            state.connectionId = opts?.connectionId;
            state.temperature = opts?.temperature;
            state.maxTokens = opts?.maxTokens;
            state.mode = opts?.mode;
            state.retryOptions = opts ? { ...opts } : undefined;
        },
        abort(reason?: string) {
            state.action = 'abort';
            state.reason = reason;
        },
        fallback(content: string, reason?: string) {
            state.action = 'fallback';
            state.fallbackContent = content;
            state.reason = reason;
        },
        get action() {
            return state.action;
        },
        get reason() {
            return state.reason;
        },
        get delayMs() {
            return state.delayMs;
        },
        get rollbackToolRounds() {
            return state.rollbackToolRounds;
        },
        get dropHistoryTurns() {
            return state.dropHistoryTurns;
        },
        get connectionId() {
            return state.connectionId;
        },
        get temperature() {
            return state.temperature;
        },
        get maxTokens() {
            return state.maxTokens;
        },
        get mode() {
            return state.mode;
        },
        get retryOptions() {
            return state.retryOptions;
        },
        get fallbackContent() {
            return state.fallbackContent;
        },
    };
    return control;
}

function normalizePostprocessToolCalls(rawCalls: readonly unknown[]): CanonicalToolCall[] {
    const result: CanonicalToolCall[] = [];
    for (const item of rawCalls) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }
        const rec = item as Record<string, unknown>;
        const id = typeof rec.id === 'string' ? rec.id.trim() : '';
        const name = typeof rec.name === 'string' ? rec.name.trim() : '';
        if (!id || !name) {
            continue;
        }
        const args =
            typeof rec.arguments === 'string'
                ? rec.arguments
                : JSON.stringify(rec.arguments ?? {});
        result.push({
            id,
            name,
            arguments: args,
            ...(typeof rec.thoughtSignature === 'string'
                ? { thoughtSignature: rec.thoughtSignature }
                : {}),
        });
    }
    return result;
}

function reconcilePostprocessOutputReturn(
    postOutput: ToolPostprocessOutput,
    rawReturn: unknown,
    prevText: string,
    prevContent: string | undefined,
    prevReasoning: string | undefined,
): void {
    if (typeof postOutput.content === 'string' && postOutput.content !== prevContent) {
        postOutput.text = postOutput.content;
    } else if (typeof postOutput.text === 'string' && postOutput.text !== prevText) {
        postOutput.content = postOutput.text;
    }

    if (typeof rawReturn === 'string') {
        const wasReasoningAssignment =
            postOutput.reasoningContent !== prevReasoning
            && rawReturn === postOutput.reasoningContent;
        if (!wasReasoningAssignment) {
            postOutput.content = rawReturn;
            postOutput.text = rawReturn;
        }
        return;
    }

    if (rawReturn && typeof rawReturn === 'object' && !Array.isArray(rawReturn)) {
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
                typeof rec.reasoningContent === 'string' ? rec.reasoningContent : undefined;
        }
        if (Array.isArray(rec.toolCalls)) {
            postOutput.toolCalls = normalizePostprocessToolCalls(rec.toolCalls);
        }
    }
}

function parseErrorRecoveryReturnDecision(
    rawReturn: unknown,
): AgentGenerationErrorDecision | undefined {
    if (!rawReturn || typeof rawReturn !== 'object' || Array.isArray(rawReturn)) {
        return undefined;
    }
    const rec = rawReturn as Record<string, unknown>;
    if (rec.action === 'abort') {
        return {
            action: 'abort',
            ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
        };
    }
    if (rec.action === 'retry') {
        return {
            action: 'retry',
            ...(typeof rec.reason === 'string' ? { reason: rec.reason } : {}),
            ...(typeof rec.delayMs === 'number' && Number.isFinite(rec.delayMs)
                ? { delayMs: rec.delayMs }
                : {}),
            ...(Array.isArray(rec.messages) ? { messages: rec.messages as CanonicalMessage[] } : {}),
            ...(typeof rec.rollbackToolRounds === 'number' && Number.isFinite(rec.rollbackToolRounds)
                ? { rollbackToolRounds: rec.rollbackToolRounds }
                : {}),
            ...(typeof rec.dropHistoryTurns === 'number' && Number.isFinite(rec.dropHistoryTurns)
                ? { dropHistoryTurns: rec.dropHistoryTurns }
                : {}),
            ...(typeof rec.connectionId === 'string' ? { connectionId: rec.connectionId } : {}),
            ...(typeof rec.temperature === 'number' && Number.isFinite(rec.temperature)
                ? { temperature: rec.temperature }
                : {}),
            ...(typeof rec.maxTokens === 'number' && Number.isFinite(rec.maxTokens)
                ? { maxTokens: rec.maxTokens }
                : {}),
        };
    }
    return undefined;
}

function extractErrorDiagnostics(error: unknown): {
    message: string;
    code?: string;
    status?: number;
} {
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const primary =
        error instanceof LLMTransportError
            ? error
            : cause instanceof LLMTransportError
                ? cause
                : error;
    const message = error instanceof Error ? error.message : String(error);
    const rec =
        primary && typeof primary === 'object'
            ? (primary as { code?: unknown; status?: unknown; statusCode?: unknown })
            : undefined;
    const code = typeof rec?.code === 'string' && rec.code.trim() ? rec.code.trim() : undefined;
    const rawStatus =
        typeof rec?.status === 'number'
            ? rec.status
            : typeof rec?.statusCode === 'number'
                ? rec.statusCode
                : undefined;
    const status =
        rawStatus !== undefined && Number.isFinite(rawStatus) ? Math.trunc(rawStatus) : undefined;
    return {
        message,
        ...(code ? { code } : {}),
        ...(status !== undefined ? { status } : {}),
    };
}

export type { CanonicalMessage };
