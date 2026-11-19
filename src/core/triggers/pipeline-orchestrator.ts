import { z } from 'zod';
import {
    AgentRunner,
    type AgentRunResult,
    type SubAgentDescriptor,
    TurnInterruptedError,
} from '@/core/agents';
import type { HostBridge, LLMTransport, ToolExecutionContext } from '@/core/bridge';
import {
    createDefaultMainAgent,
    createDefaultSettings,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import {
    ContextAssembler,
    TrajectoryStore,
    WatermarkCompactor,
    type ChunkSummarizer,
    type CompactionOptions,
    type WatermarkCompactionResult,
} from '@/core/context';
import { TraceLogger } from '@/core/logger';
import {
    LoreReadEvaluator,
    parseLoreRegex,
    TailRadar,
    WIClassifier,
} from '@/core/lore';
import { applyRegexRules, compileRegexPattern, RegexPipeline } from '@/core/regex';
import { ChatDataStore, DATA_NAMESPACES, worldInfoKey } from '@/core/store';
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
                this.trajectoryStore.pruneFromMessage(target.messageId);
            } else if (input.action === 'continue') {
                this.restoreTrajectoriesForBranch(target);
            }

            // 2. [Barrier Check] Await pending prior `'turn'` barriers before entering `before_turn`
            await this.barrierCoordinator.awaitTurnBarriers({ signal: turnSignal });
            throwIfAborted(turnSignal);

            // 3. Load lorebooks & compile @@ decorators once per turn
            const env = await this.compileTurnEnvironment(preset, turnSignal);

            // 4. [Phase 1: before_turn] (skipped on `'continue'`)
            const beforeTurnResults: TriggerExecutionResult[] = [];
            if (input.action !== 'continue') {
                const beforeUnits = groupTriggersForExecution(
                    env.allTriggers.filter((t) => t.phase === 'before_turn'),
                );
                await this.executeOrderedSyncUnits(beforeUnits, {
                    target,
                    turnNumber,
                    userText: rawUserText,
                    assistantText: '',
                    preset,
                    effectiveAgents: env.effectiveAgents,
                    loreEntries: env.loreEntries,
                    subAgents: env.subAgents,
                    globalVarSchema: env.globalVarSchema,
                    staged: true,
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
                userInput: mainUserInput,
                userName: input.userName,
                turnBrief: beforeTurnBrief,
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

    private async compileTurnEnvironment(
        preset: Preset,
        signal: AbortSignal,
    ): Promise<{
        loreEntries: RawLoreEntry[];
        effectiveAgents: Record<string, AgentProfile>;
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
            allTriggers: TriggerRule[];
            subAgents: SubAgentDescriptor[];
            globalVarSchema: z.ZodTypeAny | undefined;
        };
        signal: AbortSignal;
    }): Promise<RunTurnResult> {
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
            allTriggers: params.env.allTriggers,
            loreEntries: params.env.loreEntries,
            subAgents: params.env.subAgents,
            globalVarSchema: params.env.globalVarSchema,
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

        return { matched: true, matchOverrides };
    }

    private async executeOrderedSyncUnits(
        units: readonly TriggerExecutionUnit[],
        ctx: {
            target: MessageTarget;
            turnNumber: number;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents: Record<string, AgentProfile>;
            loreEntries: readonly RawLoreEntry[];
            subAgents: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            signal: AbortSignal;
            resultsOut: TriggerExecutionResult[];
        },
    ): Promise<void> {
        if (units.length === 0) {
            return;
        }

        const batches = groupUnitsByOrder(units);
        for (const batch of batches) {
            throwIfAborted(ctx.signal);
            const batchResults = await Promise.all(
                batch.map((unit) =>
                    this.executeSingleUnit(unit, {
                        ...ctx,
                        scanText: ctx.userText,
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
        allTriggers: readonly TriggerRule[];
        loreEntries: readonly RawLoreEntry[];
        subAgents: readonly SubAgentDescriptor[];
        globalVarSchema?: z.ZodTypeAny;
        signal?: AbortSignal;
    }): Promise<DispatchedTaskHandle<TriggerExecutionResult>[]> {
        const afterUnits = groupTriggersForExecution(
            params.allTriggers.filter((t) => t.phase === 'after_turn'),
        );
        if (afterUnits.length === 0) {
            return [];
        }

        const scanText = params.assistantText || params.userText;
        const matchedUnits: Array<{
            unit: TriggerExecutionUnit;
            activeTriggers: TriggerRule[];
            matchOverrides?: Record<string, string>;
        }> = [];

        for (const unit of afterUnits) {
            const evaluated = await this.filterMatchingTriggers(unit, {
                target: params.target,
                turnNumber: params.turnNumber,
                scanText,
                signal: params.signal ?? new AbortController().signal,
            });
            if (evaluated.activeTriggers.length > 0) {
                matchedUnits.push({
                    unit: { ...unit, triggers: evaluated.activeTriggers },
                    activeTriggers: evaluated.activeTriggers,
                    matchOverrides: evaluated.matchOverrides,
                });
            }
        }

        if (matchedUnits.length === 0) {
            return [];
        }

        const handles: DispatchedTaskHandle<TriggerExecutionResult>[] = [];
        let prevTurnOrderPromise: Promise<unknown> | undefined;
        let currentTurnOrder: number | undefined;
        let currentOrderGroupPromises: Promise<unknown>[] = [];

        for (const item of matchedUnits) {
            const { unit, matchOverrides } = item;

            if (unit.barrier === 'turn') {
                if (currentTurnOrder !== undefined && unit.order !== currentTurnOrder) {
                    prevTurnOrderPromise =
                        currentOrderGroupPromises.length > 0
                            ? Promise.allSettled(currentOrderGroupPromises)
                            : prevTurnOrderPromise;
                    currentOrderGroupPromises = [];
                }
                currentTurnOrder = unit.order;
            }

            const waitBeforeRun = unit.barrier === 'turn' ? prevTurnOrderPromise : undefined;

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
                    if (waitBeforeRun) {
                        await waitBeforeRun;
                        throwIfAborted(taskCtx.signal);
                    }

                    taskCtx.setCurrentStep(
                        unit.kind === 'script' ? `Running script (${unit.label})` : `Running ${unit.agentProfileId}`,
                    );

                    const result = await this.executePreparedUnit(unit, {
                        target: taskCtx.target,
                        userText: params.userText,
                        assistantText: params.assistantText,
                        preset: params.preset,
                        effectiveAgents: params.effectiveAgents,
                        loreEntries: params.loreEntries,
                        subAgents: params.subAgents,
                        globalVarSchema: params.globalVarSchema,
                        staged: true,
                        matchOverrides,
                        signal: taskCtx.signal,
                    });

                    throwIfAborted(taskCtx.signal);
                    this.store.commitStagedData(taskCtx.target);
                    return result;
                },
            );

            if (unit.barrier === 'turn') {
                currentOrderGroupPromises.push(handle.promise);
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

    private async executeSingleUnit(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            turnNumber: number;
            scanText: string;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents: Record<string, AgentProfile>;
            loreEntries: readonly RawLoreEntry[];
            subAgents: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            signal: AbortSignal;
        },
    ): Promise<TriggerExecutionResult | null> {
        const evaluated = await this.filterMatchingTriggers(unit, {
            target: ctx.target,
            turnNumber: ctx.turnNumber,
            scanText: ctx.scanText,
            signal: ctx.signal,
        });

        if (evaluated.activeTriggers.length === 0) {
            return null;
        }

        const activeUnit: TriggerExecutionUnit = {
            ...unit,
            triggers: evaluated.activeTriggers,
        };

        return await this.executePreparedUnit(activeUnit, {
            target: ctx.target,
            userText: ctx.userText,
            assistantText: ctx.assistantText,
            preset: ctx.preset,
            effectiveAgents: ctx.effectiveAgents,
            loreEntries: ctx.loreEntries,
            subAgents: ctx.subAgents,
            globalVarSchema: ctx.globalVarSchema,
            staged: ctx.staged,
            matchOverrides: evaluated.matchOverrides,
            signal: ctx.signal,
        });
    }

    private async filterMatchingTriggers(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            turnNumber: number;
            scanText: string;
            signal: AbortSignal;
        },
    ): Promise<{ activeTriggers: TriggerRule[]; matchOverrides?: Record<string, string> }> {
        const activeTriggers: TriggerRule[] = [];
        let mergedOverrides: Record<string, string> | undefined;

        for (const rule of unit.triggers) {
            const evalRes = await this.evaluateCondition(rule, ctx);
            if (evalRes.matched) {
                activeTriggers.push(rule);
                if (evalRes.matchOverrides) {
                    mergedOverrides = {
                        ...(mergedOverrides ?? {}),
                        ...evalRes.matchOverrides,
                    };
                }
            }
        }

        return { activeTriggers, matchOverrides: mergedOverrides };
    }

    private async executePreparedUnit(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            userText: string;
            assistantText: string;
            preset: Preset;
            effectiveAgents: Record<string, AgentProfile>;
            loreEntries: readonly RawLoreEntry[];
            subAgents: readonly SubAgentDescriptor[];
            globalVarSchema?: z.ZodTypeAny;
            staged: boolean;
            matchOverrides?: Record<string, string>;
            signal: AbortSignal;
        },
    ): Promise<TriggerExecutionResult> {
        throwIfAborted(ctx.signal);

        if (unit.kind === 'script') {
            return await this.executeScriptUnit(unit, ctx);
        }

        const profile =
            ctx.effectiveAgents[unit.agentProfileId]
            ?? createDefaultMainAgent({
                id: unit.agentProfileId,
                name: unit.label,
                sessionMode: 'ephemeral',
                ephemeralWindowSize: 4,
            });

        const unitSchema = await this.compileUnitVariableSchema(unit, ctx.globalVarSchema);
        const promptInput = this.buildTriggerAgentPrompt(unit, ctx);
        const permissions = mergeUnitPermissions(profile.permissions, unit.triggers);
        const triggerTools = resolveUnitTools(profile.enabledTools, unit.triggers);

        const agentResult = await this.agentRunner.run({
            agent: {
                ...profile,
                enabledTools: triggerTools,
                permissions,
            },
            preset: ctx.preset,
            target: ctx.target,
            phase: unit.phase,
            userInput: promptInput,
            loreEntries: ctx.loreEntries,
            subAgents: ctx.subAgents,
            includeCategory4DynamicEntries: false,
            runTailRadar: false,
            getVariableSchema: unitSchema ? () => unitSchema : undefined,
            triggerId: unit.triggers.map((t) => t.id).join(','),
            triggerLabel: unit.label,
            staged: ctx.staged,
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
                const evaluated = await this.bridge.evaluateOptionalEjs(code, ejsVars);
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

        const endedAt = Date.now();
        const conn = resolveConnection(this.settingsProvider(), 'inherit');
        this.traceLogger.recordTrace(
            {
                runId,
                target: { ...ctx.target },
                phase: unit.phase,
                agentProfileId: rule.agentProfileId || 'script',
                agentName: rule.label,
                triggerId: rule.id,
                triggerLabel: rule.label,
                connectionId: conn.id,
                model: '0-token-script',
                status: 'completed',
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
                ...(output ? { outputPreview: output.slice(0, 240) } : {}),
            },
            true,
        );

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

    private buildTriggerAgentPrompt(
        unit: TriggerExecutionUnit,
        ctx: {
            target: MessageTarget;
            userText: string;
            assistantText: string;
            matchOverrides?: Record<string, string>;
        },
    ): string {
        const macroOverrides: Record<string, string> = {
            ...(ctx.matchOverrides ?? {}),
            input: ctx.userText,
            output: ctx.assistantText,
            lastMessage: ctx.assistantText || ctx.userText,
        };

        const sections: string[] = [];
        if (unit.triggers.length === 1) {
            const rule = unit.triggers[0];
            const rendered = this.bridge.substituteMacros(
                rule.instructionTemplate,
                macroOverrides,
            ).trim();
            if (rule.targetPath) {
                sections.push(`Target VFS Path: ${rule.targetPath}`);
            }
            if (rendered) {
                sections.push(rendered);
            }
        } else {
            sections.push(
                `Grouped Trigger Batch (${unit.groupName ?? unit.label}, ${unit.triggers.length} tasks):`,
            );
            unit.triggers.forEach((rule, index) => {
                const rendered = this.bridge.substituteMacros(
                    rule.instructionTemplate,
                    macroOverrides,
                ).trim();
                sections.push(
                    `### Task ${index + 1}: ${rule.label}${rule.targetPath ? ` (Target: ${rule.targetPath})` : ''}`,
                );
                if (rendered) {
                    sections.push(rendered);
                }
            });
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

    private restoreTrajectoriesBeforeMessage(messageId: number): void {
        const chat = this.bridge.getChat();
        const swipeLookup = (msgId: number) => chat[msgId]?.swipeId ?? 0;
        for (const agentId of this.trajectoryStore.listAgentIds()) {
            this.trajectoryStore.restoreBeforeMessage(messageId, agentId, swipeLookup);
        }
    }

    private restoreTrajectoriesForBranch(target: MessageTarget): void {
        for (const agentId of this.trajectoryStore.listAgentIds()) {
            this.trajectoryStore.restoreBranch(target, agentId);
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

function groupUnitsByOrder(units: readonly TriggerExecutionUnit[]): TriggerExecutionUnit[][] {
    const sorted = [...units].sort((a, b) => a.order - b.order);
    const batches: TriggerExecutionUnit[][] = [];
    let currentOrder: number | undefined;
    let currentBatch: TriggerExecutionUnit[] = [];

    for (const unit of sorted) {
        if (currentOrder === undefined || unit.order !== currentOrder) {
            if (currentBatch.length > 0) {
                batches.push(currentBatch);
            }
            currentOrder = unit.order;
            currentBatch = [unit];
        } else {
            currentBatch.push(unit);
        }
    }
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }

    return batches;
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

export type { CanonicalMessage };
