import { z } from 'zod';
import {
    AgentRunner,
    type AgentRunResult,
    type SubAgentDescriptor,
    TurnInterruptedError,
} from '@/core/agents';
import type {
    HostBridge,
    LLMTransport,
    PromptInjectionSession,
    SerializedPromptInjected,
    ToolExecutionContext,
    ToolSideGenApi,
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
    MessageTarget,
    PipelinePhase,
    Preset,
    RawLoreEntry,
    RegexRule,
    ScopedPermissions,
    Settings,
    ToolStepLog,
    TriggerRule,
} from '@/core/types';
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
    signal?: AbortSignal;
    stream?: boolean;
    onTextDelta?: (delta: string) => void;
    onOutputPreview?: (previewText: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onToolStart?: (step: ToolStepLog) => void;
    onToolComplete?: (step: ToolStepLog) => void;
}

export { TurnInterruptedError };

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

            // 4. [Phase 1: before_turn] (skipped on `'continue'`)
            const beforeTurnResults: TriggerExecutionResult[] = [];
            if (input.action !== 'continue') {
                const beforeRules = env.allTriggers.filter(
                    (t) => t.phase === 'before_turn' && t.enabled,
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
                return this.handleTurnInterrupted(target, error);
            }

            // Roll back uncommitted staged data if before_turn / main_turn failed or aborted
            this.store.rollbackStagedData(target);

            const aborted = isAbortError(error) || turnSignal.aborted;
            if (aborted) {
                this.traceLogger.emit({
                    kind: 'turn_aborted',
                    target: { ...target },
                    timestamp: Date.now(),
                    error: error instanceof Error ? error.message : 'Turn aborted',
                });
                throw error instanceof Error && isAbortError(error)
                    ? error
                    : createAbortError('Turn aborted');
            }

            this.traceLogger.emit({
                kind: 'turn_error',
                target: { ...target },
                timestamp: Date.now(),
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    /**
     * Resume an interrupted `main_turn` from its persisted `InterruptedTurnCheckpoint`
     * while preserving 100% byte-for-byte Prefix KV Cache invariance over completed rounds.
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

            this.restoreTrajectoriesBeforeMessage(target.messageId);
            this.store.restoreStagedData(target, cp.stagedSnapshot);

            const currentOutput = await this.vfs
                .readFile(OUTPUT_FILE_PATH, { target, staged: true })
                .catch(() => '');

            const recoveryPrompt = [
                `[System Recovery] Previous generation was interrupted (reason: ${cp.reason}).`,
                `Current /output.md already has ${currentOutput.length} chars saved (ending with: ${JSON.stringify(currentOutput.slice(-200))}).`,
                'Inspect /output.md if needed, seamlessly continue writing the remaining content using append_file or edit_file on /output.md WITHOUT repeating already-written text, and review /output.md for completeness and errors before finishing.',
            ].join('\n');

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
                    ...cp.completedTurnMessages,
                    { role: 'user', content: recoveryPrompt },
                ],
                initialReadSet: cp.readSetSnapshot,
                loreEntries: env.loreEntries,
                subAgents: env.subAgents,
                getVariableSchema: env.globalVarSchema ? () => env.globalVarSchema : undefined,
                staged: true,
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
                return this.handleTurnInterrupted(target, error);
            }

            const aborted = isAbortError(error) || turnSignal.aborted;
            if (aborted) {
                this.traceLogger.emit({
                    kind: 'turn_aborted',
                    target: { ...target },
                    timestamp: Date.now(),
                    error: error instanceof Error ? error.message : 'Turn resume aborted',
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
    ): Promise<{
        loreEntries: RawLoreEntry[];
        effectiveAgents: Record<string, AgentProfile>;
        derivedAgentsByRuleId: Record<string, AgentProfile>;
        allTriggers: TriggerRule[];
        subAgents: SubAgentDescriptor[];
        globalVarSchema: z.ZodTypeAny | undefined;
    }> {
        const loreEntries = await this.loadRawLoreEntries();
        throwIfAborted(signal);

        const compiled = this.decoratorCompiler.compile(loreEntries, { preset });
        const effectiveAgents: Record<string, AgentProfile> = {
            ...compiled.derivedAgents,
            ...preset.agents,
        };
        const allTriggers: TriggerRule[] = [
            ...preset.triggers,
            ...compiled.triggers,
        ];
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

    private handleTurnInterrupted(target: MessageTarget, error: TurnInterruptedError): never {
        this.trajectoryStore.saveInterruptedCheckpoint(error.checkpoint);
        this.trajectoryStore.saveToHost(this.bridge);
        this.traceLogger.emit({
            kind: 'turn_interrupted',
            target: { ...target },
            timestamp: Date.now(),
            agentProfileId: error.checkpoint.agentId,
            interruptedReason: error.reason,
            outputPreview: error.salvagedOutput,
            ...(error.causeError ? { error: error.causeError } : {}),
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
            (t) => t.phase === 'before_turn' && t.enabled,
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
     */
    async rerunAfterTurn(
        targetInput: MessageTarget,
        options: { turnNumber?: number; signal?: AbortSignal } = {},
    ): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const target = freezeTarget(targetInput);
        if (options.signal) {
            throwIfAborted(options.signal);
        }

        // Abort any stuck after_turn tasks for this exact target and clear pending staging.
        this.barrierCoordinator.abortTarget(target, 'Manual rerun of after_turn');
        this.store.rollbackStagedData(target);

        const settings = this.settingsProvider();
        const preset = resolveActivePreset(settings);
        const loreEntries = await this.loadRawLoreEntries();
        const compiled = this.decoratorCompiler.compile(loreEntries, { preset });
        const effectiveAgents: Record<string, AgentProfile> = {
            ...compiled.derivedAgents,
            ...preset.agents,
        };
        const allTriggers: TriggerRule[] = [...preset.triggers, ...compiled.triggers];
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
        signal?: AbortSignal;
    }): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const afterRules = params.allTriggers.filter((t) => t.phase === 'after_turn' && t.enabled);
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
                const matchedRules: TriggerRule[] = [];
                const matchOverridesByRuleId = new Map<string, Record<string, string>>();
                for (const rule of ruleBatch) {
                    const evaluated = await this.evaluateCondition(rule, {
                        target: params.target,
                        turnNumber: params.turnNumber,
                        scanText,
                        signal: params.signal ?? new AbortController().signal,
                        staged: false,
                        injectionSession: params.injectionSession,
                    });
                    if (evaluated.matched) {
                        matchedRules.push(rule);
                        if (evaluated.matchOverrides) {
                            matchOverridesByRuleId.set(rule.id, evaluated.matchOverrides);
                        }
                    }
                }
                if (matchedRules.length === 0) {
                    continue;
                }

                const units = groupTriggersForExecution(matchedRules);
                const batchTurnPromises: Promise<unknown>[] = [];
                const batchAllPromises: Promise<unknown>[] = [];

                for (const unit of units) {
                    const unitOverrides = mergeUnitMatchOverrides(
                        unit.triggers,
                        matchOverridesByRuleId,
                    );
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
                                signal: taskCtx.signal,
                            });

                            throwIfAborted(taskCtx.signal);
                            this.store.commitStagedData(taskCtx.target);
                            return result;
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

                    const matchedRules: TriggerRule[] = [];
                    const matchOverridesByRuleId = new Map<string, Record<string, string>>();
                    for (const rule of ruleBatch) {
                        const evaluated = await this.evaluateCondition(rule, {
                            target: taskCtx.target,
                            turnNumber: params.turnNumber,
                            scanText,
                            signal: taskCtx.signal,
                            staged: false,
                            injectionSession: params.injectionSession,
                        });
                        if (evaluated.matched) {
                            matchedRules.push(rule);
                            if (evaluated.matchOverrides) {
                                matchOverridesByRuleId.set(rule.id, evaluated.matchOverrides);
                            }
                        }
                    }

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

                    const units = groupTriggersForExecution(matchedRules);
                    taskCtx.setCurrentStep(
                        units.length === 1
                            ? `Running ${units[0].label}`
                            : `Running ${units.length} after_turn units`,
                    );

                    const unitResults = await Promise.all(
                        units.map((unit) =>
                            this.executePreparedUnit(unit, {
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
                                signal: taskCtx.signal,
                            }),
                        ),
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
                        triggers: params.allTriggers,
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
            signal: AbortSignal;
        },
    ): Promise<TriggerExecutionResult> {
        throwIfAborted(ctx.signal);

        if (unit.kind === 'script') {
            return await this.executeScriptUnit(unit, ctx);
        }

        const profile = resolveEffectiveUnitAgentProfile(
            unit,
            ctx.preset,
            ctx.derivedAgentsByRuleId,
            ctx.effectiveAgents,
        );

        const unitSchema = await this.compileUnitVariableSchema(unit, ctx.globalVarSchema);
        const promptInput = await this.buildTriggerAgentPrompt(unit, ctx);
        const permissions = mergeUnitPermissions(profile.permissions, unit.triggers);
        const triggerTools = resolveUnitTools(profile.enabledTools, unit.triggers);

        const triggerIds = unit.triggers.map((t) => t.id);
        const lorebookNames = collectUnitLorebookNames(unit.triggers);
        const triggerSource = resolveUnitTriggerSource(unit.triggers, lorebookNames);
        const decorators = unit.triggers
            .map((t) => t.decorator)
            .filter((d): d is string => Boolean(d));
        const targetPaths = unit.triggers
            .map((t) => t.targetPath)
            .filter((p): p is string => Boolean(p));

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
            userInput: promptInput,
            loreEntries: ctx.loreEntries,
            subAgents: ctx.subAgents,
            includeCategory4DynamicEntries: false,
            runTailRadar: false,
            getVariableSchema: unitSchema ? () => unitSchema : undefined,
            triggerId: triggerIds.join(','),
            triggerLabel: unit.label,
            ...(triggerSource ? { triggerSource } : {}),
            ...(lorebookNames.length > 0 ? { lorebookNames } : {}),
            staged: ctx.staged,
            ...(ctx.injectionSession ? { injectionSession: ctx.injectionSession } : {}),
            stream: false,
            signal: ctx.signal,
            macroOverrides: ctx.matchOverrides,
        });

        return {
            unitId: unit.unitId,
            phase: unit.phase,
            target: ctx.target,
            kind: 'agent',
            triggerIds: unit.triggers.map((t) => t.id),
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
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            injectionSession?: PromptInjectionSession;
            matchOverrides?: Record<string, string>;
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

        const toolCtx: ToolExecutionContext = createToolExecutionContext({
            bridge: this.bridge,
            vfs: this.vfs,
            store: this.store,
            ...(this.sideGen ? { sideGen: this.sideGen } : {}),
            target: ctx.target,
            signal: ctx.signal,
            permissions,
            staged: ctx.staged,
            source: `script:${rule.id}`,
            getVariableSchema: ctx.globalVarSchema ? () => ctx.globalVarSchema : undefined,
        });

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
    ): Promise<string> {
        const macroOverrides: Record<string, string> = {
            ...(ctx.matchOverrides ?? {}),
            input: ctx.userText,
            output: ctx.assistantText,
            lastMessage: ctx.assistantText || ctx.userText,
        };

        const hasEjsTemplates = unit.triggers.some((r) => r.instructionTemplate.includes('<%'));
        let ejsVars: Record<string, unknown> | undefined;
        if (hasEjsTemplates && this.bridge.evaluateOptionalEjs) {
            const baseVars = await this.vfs
                .readVariables({ target: ctx.target, staged: ctx.staged ?? true })
                .catch(() => ({}));
            ejsVars = {
                ...baseVars,
                ...macroOverrides,
                target: ctx.target,
            };
        }

        const renderRuleTemplate = async (template: string): Promise<string> => {
            let text = this.bridge.substituteMacros(template, macroOverrides);
            if (ejsVars && this.bridge.evaluateOptionalEjs && text.includes('<%')) {
                try {
                    text = await this.bridge.evaluateOptionalEjs(
                        text,
                        ejsVars,
                        ctx.injectionSession ? { injectionSession: ctx.injectionSession } : undefined,
                    );
                } catch {
                    // Keep macro-substituted fallback text on EJS runtime error
                }
            }
            return text.trim();
        };

        const sections: string[] = [];
        if (unit.triggers.length === 1) {
            const rule = unit.triggers[0];
            const rendered = await renderRuleTemplate(rule.instructionTemplate);
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
            for (let index = 0; index < unit.triggers.length; index += 1) {
                const rule = unit.triggers[index];
                const rendered = await renderRuleTemplate(rule.instructionTemplate);
                sections.push(
                    `### Task ${index + 1}: ${rule.label}${rule.targetPath ? ` (Target: ${rule.targetPath})` : ''}${rule.decorator ? ` [${rule.decorator}]` : ''}`,
                );
                if (rendered) {
                    sections.push(rendered);
                }
            }
        }

        if (ctx.userText) {
            sections.push(`Latest User Input:\n${ctx.userText}`);
        }
        if (ctx.assistantText) {
            sections.push(`Latest Assistant Output:\n${ctx.assistantText}`);
        }

        return sections.join('\n\n');
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
            const compiled = await normalizeTriggerSchema(rule.schemaSource, this.sandbox);
            if (compiled) {
                merged = merged ? deepMergeZod(merged, compiled) : compiled;
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

export type { CanonicalMessage };
