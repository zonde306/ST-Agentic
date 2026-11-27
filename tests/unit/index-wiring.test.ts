import { beforeEach, describe, expect, it, vi } from 'vitest';

const stMocks = vi.hoisted(() => {
    const state = {
        chat: [] as Array<Record<string, unknown>>,
        chat_metadata: {} as Record<string, unknown>,
        extension_settings: {} as Record<string, unknown>,
        characters: [] as Array<Record<string, unknown>>,
        selected_group: null as string | null,
    };
    const eventListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();
    const eventSource = {
        on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
            let set = eventListeners.get(event);
            if (!set) {
                set = new Set();
                eventListeners.set(event, set);
            }
            set.add(fn);
        }),
        removeListener: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
            eventListeners.get(event)?.delete(fn);
        }),
        emit: vi.fn(),
    };
    const event_types = {
        CHAT_CHANGED: 'chat_changed',
        SETTINGS_LOADED: 'settings_loaded',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        WORLDINFO_UPDATED: 'worldinfo_updated',
        WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_EDITED: 'message_edited',
        GENERATION_STOPPED: 'generation_stopped',
        APP_READY: 'app_ready',
        EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
    };
    return { state, eventListeners, eventSource, event_types };
});

vi.mock('@st/script.js', () => ({
    chat: stMocks.state.chat,
    chat_metadata: stMocks.state.chat_metadata,
    characters: stMocks.state.characters,
    this_chid: 0,
    name1: 'User',
    name2: 'Assistant',
    saveMetadata: vi.fn(async () => undefined),
    saveSettingsDebounced: vi.fn(),
    saveChatDebounced: vi.fn(),
    saveChatConditional: vi.fn(async () => undefined),
    substituteParams: (text: string) => text,
    activateSendButtons: vi.fn(),
    deactivateSendButtons: vi.fn(),
    hideSwipeButtons: vi.fn(),
    showSwipeButtons: vi.fn(),
    setExternalAbortController: vi.fn(),
    addCopyToCodeBlocks: vi.fn(),
    addOneMessage: vi.fn(),
    appendMediaToMessage: vi.fn(),
    deleteMessage: vi.fn(),
    ensureSwipes: vi.fn(),
    getCharacterCardFields: vi.fn(() => ({})),
    getGeneratingApi: vi.fn(() => 'openai'),
    getGeneratingModel: vi.fn(() => 'test'),
    messageFormatting: (text: string) => text,
    refreshSwipeButtons: vi.fn(),
    scrollChatToBottom: vi.fn(),
    syncMesToSwipe: vi.fn(),
    syncSwipeToMes: vi.fn(),
    updateMessageBlock: vi.fn(),
    updateSwipeCounter: vi.fn(),
    updateViewMessageIds: vi.fn(),
}));
vi.mock('@st/scripts/events.js', () => ({
    event_types: stMocks.event_types,
    eventSource: stMocks.eventSource,
}));
vi.mock('@st/scripts/extensions.js', () => ({
    extension_settings: stMocks.state.extension_settings,
    saveMetadataDebounced: vi.fn(),
}));
vi.mock('@st/scripts/group-chats.js', () => ({
    selected_group: stMocks.state.selected_group,
}));
vi.mock('@st/scripts/constants.js', () => ({
    MEDIA_SOURCE: { GENERATED: 'generated' },
    MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
}));
vi.mock('@st/scripts/power-user.js', () => ({
    power_user: {
        reasoning: { prefix: '<think>', suffix: '</think>' },
        personas: {},
        persona_descriptions: {},
        persona_description: '',
    },
}));
vi.mock('@st/scripts/reasoning.js', () => ({
    ReasoningType: { Model: 'model', Parsed: 'parsed' },
    parseReasoningFromString: (raw: string) => ({ content: raw, reasoning: '' }),
    updateReasoningUI: vi.fn(),
}));
vi.mock('@st/scripts/RossAscends-mods.js', () => ({
    getMessageTimeStamp: () => '2026-11-28@00h00m00s',
}));
vi.mock('@st/scripts/world-info.js', () => ({
    world_names: [],
    selected_world_info: [],
    world_info: { globalSelect: [], charLore: [] },
    loadWorldInfo: vi.fn(async () => null),
    saveWorldInfo: vi.fn(async () => undefined),
    updateWorldInfoList: vi.fn(async () => undefined),
}));
vi.mock('@st/scripts/extensions/regex/engine.js', () => ({
    getRegexedString: (s: string) => s,
    regex_placement: { MD_DISPLAY: 1, AI_OUTPUT: 2, USER_INPUT: 1, WORLD_INFO: 5 },
}));
vi.mock('@st/scripts/i18n.js', () => ({
    t: (s: string) => s,
}));
vi.mock('@st/scripts/macros/macro-system.js', () => ({
    MacroEnv: {},
}));
vi.mock('@st/scripts/personas.js', () => ({
    user_avatar: 'user.png',
    getUserAvatar: vi.fn(),
    setUserAvatar: vi.fn(),
}));
vi.mock('@st/scripts/preset-manager.js', () => ({
    getPresetManager: vi.fn(() => null),
}));
vi.mock('@st/scripts/slash-commands.js', () => ({
    executeSlashCommandsWithOptions: vi.fn(async () => ({ pipe: '' })),
}));
vi.mock('@st/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: { fromProps: vi.fn((p: unknown) => p) },
}));
vi.mock('@st/scripts/slash-commands/SlashCommandAbortController.js', () => ({
    SlashCommandAbortController: class {},
}));
vi.mock('@st/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'boolean' },
    SlashCommandArgument: { fromProps: vi.fn((p: unknown) => p) },
    SlashCommandNamedArgument: { fromProps: vi.fn((p: unknown) => p) },
}));
vi.mock('@st/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: {
        addCommandObject: vi.fn(),
        commands: {},
    },
}));
vi.mock('@st/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
}));
vi.mock('@st/scripts/utils.js', () => ({
    uuidv4: () => 'uuid-test',
    getCharaFilename: () => 'assistant',
}));

import type { ToolEventPayload } from '@/core/bridge';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore, WatermarkCompactor } from '@/core/context';
import { FetchLLMTransport, LLMTransportError } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import { WIClassifier } from '@/core/lore';
import { ChatDataStore, DataCompactor } from '@/core/store';
import { createAbortError, createBuiltinToolRegistry } from '@/core/tools';
import { BarrierCoordinator, PipelineOrchestrator } from '@/core/triggers';
import type { AgentRunTrace, Settings } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import type { AgenticInterceptorHandle } from '@/host/interceptor';
import type { STHostBridge } from '@/host/st-bridge';
import { createLiveUiServices, emitOffMainlineGenerationError } from '@/index';
import { IframeJsSandbox } from '@/sandbox';
import { DeferredGate, MemoryHostBridge, ScriptedLLMTransport } from '../mocks';

function makeTrace(overrides: Partial<AgentRunTrace> = {}): AgentRunTrace {
    return {
        runId: 'run_1',
        target: { messageId: 1, swipeId: 0 },
        phase: 'main_turn',
        agentProfileId: 'main',
        agentName: 'Main',
        connectionId: 'conn_1',
        model: 'test-model',
        status: 'running',
        startedAt: Date.now(),
        durationMs: 100,
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, totalTokens: 15, cacheHitRate: 0 },
        toolSteps: [],
        ...overrides,
    };
}

describe('Entry Wiring: createLiveUiServices & emitOffMainlineGenerationError', () => {
    beforeEach(() => {
        stMocks.state.chat.length = 0;
        stMocks.state.chat.push(
            { is_user: true, mes: 'hello', swipe_id: 0 },
            { is_user: false, mes: 'world', swipe_id: 0, swipes: ['world'] },
        );
    });

    it('wires clearAllPromptCaches, stopTrace, continueTrace, and retryTrace accurately across all phases', async () => {
        const memBridge = new MemoryHostBridge({
            chat: [
                { id: 0, name: 'User', isUser: true, mes: 'hello', swipeId: 0 },
                { id: 1, name: 'Assistant', isUser: false, mes: 'world', swipeId: 0, swipes: ['world'] },
            ],
        });
        const clearLorebookCacheSpy = vi.fn(() => 3);
        const bridgeWithClear = Object.assign(memBridge, {
            clearLorebookCache: clearLorebookCacheSpy,
        });

        let currentSettings: Settings = createDefaultSettings();
        const store = new ChatDataStore(bridgeWithClear);
        const vfs = new VirtualFileSystem({ bridge: bridgeWithClear, store });
        const clearVfsSpy = vi.spyOn(vfs, 'clearReadTransformCache').mockReturnValue(4);
        const traceLogger = new TraceLogger();
        const barrierCoordinator = new BarrierCoordinator({ traceLogger });
        const trajectoryStore = new TrajectoryStore();
        trajectoryStore.appendMessages([{ role: 'user', content: 'keep-layer1-history' }], 'main');
        trajectoryStore.setFrozenPrefix(
            { tools: [], messages: [{ role: 'system', content: 'sys' }], layer0EndIndex: 0 },
            'main',
        );
        const saveToHostSpy = vi.spyOn(trajectoryStore, 'saveToHost');

        const transport = new ScriptedLLMTransport();
        const orchestrator = new PipelineOrchestrator({
            bridge: bridgeWithClear,
            transport,
            settings: () => currentSettings,
            store,
            vfs,
            trajectoryStore,
            traceLogger,
            barrierCoordinator,
        });

        const resumeTakeoverTurn = vi.fn(async () => undefined);
        const retryTakeoverTurn = vi.fn(async () => undefined);
        const abortActiveTakeover = vi.fn(() => true);
        const fakeInterceptor: AgenticInterceptorHandle = {
            interceptor: vi.fn(),
            isTakeoverActive: () => true,
            abortActiveTakeover,
            resumeTakeoverTurn,
            retryTakeoverTurn,
            dispose: vi.fn(),
        };

        const abortAssistantSpy = vi.fn();
        const abortSideGenSpy = vi.fn();
        const resumeTriggerSpy = vi.spyOn(orchestrator, 'resumeTriggerTask').mockResolvedValue([]);
        const rerunAfterTurnSpy = vi
            .spyOn(orchestrator, 'rerunAfterTurn')
            .mockResolvedValue([{ promise: Promise.resolve({} as never) } as never]);

        const services = createLiveUiServices({
            bridge: bridgeWithClear as unknown as STHostBridge,
            store,
            dataCompactor: new DataCompactor(bridgeWithClear),
            vfs,
            sideGen: {} as never,
            abortSideGen: abortSideGenSpy,
            assistantRunner: { abort: abortAssistantSpy } as never,
            traceLogger,
            sandbox: new IframeJsSandbox(),
            toolRegistry: createBuiltinToolRegistry(),
            trajectoryStore,
            watermarkCompactor: new WatermarkCompactor({ vfs, bridge: bridgeWithClear }),
            transport: new FetchLLMTransport(),
            barrierCoordinator,
            orchestrator,
            classifier: new WIClassifier(),
            getSettings: () => currentSettings,
            setSettings: (next) => {
                currentSettings = next;
                return next;
            },
            syncTools: async () => {},
            getAppStore: () => undefined,
            getInterceptorHandle: () => fakeInterceptor,
            isSuppressingSave: () => false,
        });

        // 1. clearAllPromptCaches clears frozen prefixes + saves + clears VFS & lorebook caches without deleting Layer 1!
        const cacheRes = await services.clearAllPromptCaches!();
        expect(cacheRes).toEqual({
            clearedPrefixes: 1,
            clearedVfsCache: 4,
            clearedLorebooks: 3,
        });
        expect(saveToHostSpy).toHaveBeenCalledWith(bridgeWithClear);
        expect(clearVfsSpy).toHaveBeenCalledTimes(1);
        expect(clearLorebookCacheSpy).toHaveBeenCalledTimes(1);
        expect(trajectoryStore.getFrozenPrefix('main')).toBeNull();
        expect(trajectoryStore.getMessages('main')).toHaveLength(1);

        // 2. stopTrace across main_turn, after_turn (by taskId and fallback lookup), assistant, sidegen
        expect(services.stopTrace!(makeTrace({ phase: 'main_turn' }))).toBe(true);
        expect(abortActiveTakeover).toHaveBeenCalledWith('Stopped from logs');

        const gateA = new DeferredGate<void>();
        const handleA = barrierCoordinator.dispatch(
            {
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'none',
                agentProfileId: 'ag_bg',
                label: 'BG Task A',
            },
            async () => {
                await gateA.wait();
            },
        );
        await gateA.waitUntilWaiting();
        expect(
            services.stopTrace!(
                makeTrace({
                    phase: 'after_turn',
                    agentProfileId: 'ag_bg',
                    taskId: handleA.taskId,
                }),
            ),
        ).toBe(true);
        expect(handleA.getStatus().state).toBe('aborted');
        gateA.resolve();

        const gateB = new DeferredGate<void>();
        const handleB = barrierCoordinator.dispatch(
            {
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'none',
                agentProfileId: 'ag_fallback',
                label: 'BG Task B',
            },
            async () => {
                await gateB.wait();
            },
        );
        await gateB.waitUntilWaiting();
        // No taskId -> fallback matches target + agentProfileId
        expect(
            services.stopTrace!(
                makeTrace({
                    phase: 'after_turn',
                    agentProfileId: 'ag_fallback',
                }),
            ),
        ).toBe(true);
        expect(handleB.getStatus().state).toBe('aborted');
        gateB.resolve();

        expect(
            services.stopTrace!(
                makeTrace({
                    phase: 'maintenance',
                    offMainlineKind: 'assistant',
                    offMainlineSessionId: 'sess_42',
                    agentProfileId: 'assistant:sess_42',
                    status: 'running',
                }),
            ),
        ).toBe(true);
        expect(abortAssistantSpy).toHaveBeenCalledWith('sess_42');

        expect(
            services.stopTrace!(
                makeTrace({
                    phase: 'maintenance',
                    offMainlineKind: 'sidegen_session',
                    agentProfileId: 'side:s1',
                    status: 'running',
                }),
            ),
        ).toBe(true);
        expect(abortSideGenSpy).toHaveBeenCalledWith('Stopped from logs');

        // 3. continueTrace: main_turn with checkpoint -> resumeTakeoverTurn(options); without checkpoint -> retryTakeoverTurn
        trajectoryStore.saveInterruptedCheckpoint({
            agentId: 'main',
            target: { messageId: 1, swipeId: 0 },
            reason: 'error',
            completedTurnMessages: [{ role: 'user', content: 'hi' }],
            readSetSnapshot: {},
            stagedSnapshot: {},
            createdAt: Date.now(),
        });
        await services.continueTrace!(
            makeTrace({ phase: 'main_turn', status: 'interrupted' }),
            { rollbackLastToolRound: true },
        );
        expect(resumeTakeoverTurn).toHaveBeenCalledWith(
            { messageId: 1, swipeId: 0 },
            { rollbackLastToolRound: true },
        );

        trajectoryStore.clearInterruptedCheckpoint({ messageId: 1, swipeId: 0 });
        await services.continueTrace!(makeTrace({ phase: 'main_turn', status: 'error' }));
        expect(retryTakeoverTurn).toHaveBeenCalledWith({ messageId: 1, swipeId: 0 });

        // after_turn with triggerId -> resumeTriggerTask
        await services.continueTrace!(
            makeTrace({ phase: 'after_turn', triggerId: 'tr_a', status: 'error' }),
            { rollbackLastToolRound: true },
        );
        expect(resumeTriggerSpy).toHaveBeenCalledWith(
            { messageId: 1, swipeId: 0 },
            'tr_a',
            { rollbackLastToolRound: true },
        );

        // 4. retryTrace: after_turn clears composite checkpoint then calls rerunAfterTurn
        trajectoryStore.saveInterruptedCheckpoint({
            agentId: 'ag_vars',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            triggerId: 'tr_a,tr_b',
            reason: 'error',
            completedTurnMessages: [],
            readSetSnapshot: {},
            stagedSnapshot: {},
            createdAt: Date.now(),
        });
        await services.retryTrace!(
            makeTrace({ phase: 'after_turn', triggerId: 'tr_a,tr_b', status: 'error' }),
        );
        expect(
            trajectoryStore.getInterruptedCheckpoint(
                { messageId: 1, swipeId: 0 },
                { phase: 'after_turn', triggerId: 'tr_a,tr_b' },
            ),
        ).toBeUndefined();
        expect(rerunAfterTurnSpy).toHaveBeenCalledWith(
            { messageId: 1, swipeId: 0 },
            { triggerIds: ['tr_a', 'tr_b'], force: true },
        );
    });

    it('emits agentic_generation_error for off-mainline assistant/sidegen errors and ignores AbortError', () => {
        const memBridge = new MemoryHostBridge();

        emitOffMainlineGenerationError(memBridge, {
            target: { messageId: 2, swipeId: 1 },
            offMainlineKind: 'assistant',
            sessionId: 'asst_1',
            agentId: 'assistant:asst_1',
            error: new LLMTransportError('Rate limited', {
                status: 429,
                code: 'RATE_LIMIT',
                retryable: true,
            }),
        });

        emitOffMainlineGenerationError(memBridge, {
            target: { messageId: 2, swipeId: 1 },
            offMainlineKind: 'sidegen_once',
            agentId: 'sidegen:once',
            error: createAbortError('User cancelled'),
        });

        expect(memBridge.emittedEvents).toHaveLength(1);
        expect(memBridge.emittedEvents[0].event).toBe('agentic_generation_error');
        const payload = memBridge.emittedEvents[0].payload as ToolEventPayload;
        expect(payload.type).toBe('generation_error');
        expect(payload.agentId).toBe('assistant:asst_1');
        expect(payload.statusCode).toBe(429);
        expect(payload.errorCode).toBe('RATE_LIMIT');
        expect(payload.data).toEqual({
            offMainlineKind: 'assistant',
            sessionId: 'asst_1',
        });
    });
});
