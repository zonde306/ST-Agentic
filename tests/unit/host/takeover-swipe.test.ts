import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stMocks = vi.hoisted(() => {
    const eventListeners = new Map<string, Set<(...args: unknown[]) => unknown>>();

    const state = {
        this_chid: 0 as number | undefined,
        name1: 'Tester',
        name2: 'Alice',
        user_avatar: 'tester.png',
        selected_group: null as string | null,
        characters: [] as Array<Record<string, unknown>>,
        chat: [] as Array<Record<string, unknown>>,
        chat_metadata: {} as Record<string, unknown>,
        extension_settings: {} as Record<string, unknown>,
        power_user: {
            reasoning: { prefix: '<think>', suffix: '</think>' },
            personas: {},
            persona_descriptions: {},
            persona_description: '',
        } as Record<string, unknown>,
        world_names: [] as string[],
        selected_world_info: [] as string[],
        world_info: { globalSelect: [], charLore: [] } as Record<string, unknown>,
        externalAbortController: undefined as AbortController | undefined,
        swipesHidden: false,
    };

    const fns = {
        activateSendButtons: vi.fn(),
        deactivateSendButtons: vi.fn(),
        hideSwipeButtons: vi.fn(() => {
            state.swipesHidden = true;
        }),
        showSwipeButtons: vi.fn(() => {
            state.swipesHidden = false;
            fns.refreshSwipeButtons();
        }),
        refreshSwipeButtons: vi.fn(),
        updateSwipeCounter: vi.fn(async () => undefined),
        syncMesToSwipe: vi.fn((messageId?: number | null) => {
            const idx = messageId ?? state.chat.length - 1;
            const msg = state.chat[idx] as
                | { mes?: unknown; swipe_id?: unknown; swipes?: unknown[] }
                | undefined;
            if (!msg || typeof msg.swipe_id !== 'number' || !Array.isArray(msg.swipes)) {
                return false;
            }
            msg.swipes[msg.swipe_id] = msg.mes;
            return true;
        }),
        syncSwipeToMes: vi.fn((messageId?: number | null, swipeId?: number | null) => {
            const idx = messageId ?? state.chat.length - 1;
            const msg = state.chat[idx] as
                | { mes?: unknown; swipe_id?: unknown; swipes?: unknown[]; swipe_info?: unknown[] }
                | undefined;
            if (!msg || !Array.isArray(msg.swipes)) {
                return false;
            }
            if (typeof swipeId === 'number') {
                msg.swipe_id = swipeId;
            }
            const targetSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
            if (typeof msg.swipes[targetSwipe] !== 'string') {
                return false;
            }
            msg.mes = msg.swipes[targetSwipe];
            return true;
        }),
        ensureSwipes: vi.fn((msg: Record<string, unknown>) => {
            if (!Array.isArray(msg.swipes)) {
                msg.swipes = [typeof msg.mes === 'string' ? msg.mes : ''];
                msg.swipe_id = 0;
                msg.swipe_info = [{}];
                return true;
            }
            return false;
        }),
        setExternalAbortController: vi.fn((controller?: AbortController) => {
            state.externalAbortController = controller;
        }),
        addCopyToCodeBlocks: vi.fn(),
        addOneMessage: vi.fn(),
        appendMediaToMessage: vi.fn(),
        deleteMessage: vi.fn(),
        getCharacterCardFields: vi.fn(() => ({})),
        getGeneratingApi: vi.fn(() => 'openai'),
        getGeneratingModel: vi.fn(() => 'gpt-test'),
        messageFormatting: vi.fn((text: string) => text),
        saveChatConditional: vi.fn(async () => undefined),
        saveChatDebounced: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        scrollChatToBottom: vi.fn(),
        substituteParams: vi.fn((text: string) => text),
        updateMessageBlock: vi.fn(),
        updateViewMessageIds: vi.fn(),
        updateReasoningUI: vi.fn(),
        getMessageTimeStamp: vi.fn(() => '2026-11-26@13h00m00s'),
        getCharaFilename: vi.fn(() => 'alice'),
        loadWorldInfo: vi.fn(async () => null),
        saveMetadataDebounced: vi.fn(),
        eventOn: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
            let set = eventListeners.get(event);
            if (!set) {
                set = new Set();
                eventListeners.set(event, set);
            }
            set.add(listener);
        }),
        eventRemoveListener: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
            eventListeners.get(event)?.delete(listener);
        }),
        eventEmit: vi.fn(async (event: string, ...args: unknown[]) => {
            const set = eventListeners.get(event);
            if (!set) {
                return;
            }
            for (const listener of Array.from(set)) {
                await listener(...args);
            }
        }),
    };

    const event_types = {
        GENERATION_STOPPED: 'generation_stopped',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_UPDATED: 'message_updated',
        MESSAGE_DELETED: 'message_deleted',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    };

    return { state, fns, eventListeners, event_types };
});

vi.mock('@st/script.js', () => ({
    activateSendButtons: stMocks.fns.activateSendButtons,
    addCopyToCodeBlocks: stMocks.fns.addCopyToCodeBlocks,
    addOneMessage: stMocks.fns.addOneMessage,
    appendMediaToMessage: stMocks.fns.appendMediaToMessage,
    characters: stMocks.state.characters,
    chat: stMocks.state.chat,
    chat_metadata: stMocks.state.chat_metadata,
    deactivateSendButtons: stMocks.fns.deactivateSendButtons,
    deleteMessage: stMocks.fns.deleteMessage,
    ensureSwipes: stMocks.fns.ensureSwipes,
    getCharacterCardFields: stMocks.fns.getCharacterCardFields,
    getGeneratingApi: stMocks.fns.getGeneratingApi,
    getGeneratingModel: stMocks.fns.getGeneratingModel,
    hideSwipeButtons: stMocks.fns.hideSwipeButtons,
    messageFormatting: stMocks.fns.messageFormatting,
    name1: stMocks.state.name1,
    name2: stMocks.state.name2,
    refreshSwipeButtons: stMocks.fns.refreshSwipeButtons,
    saveChatConditional: stMocks.fns.saveChatConditional,
    saveChatDebounced: stMocks.fns.saveChatDebounced,
    saveSettingsDebounced: stMocks.fns.saveSettingsDebounced,
    scrollChatToBottom: stMocks.fns.scrollChatToBottom,
    setExternalAbortController: stMocks.fns.setExternalAbortController,
    showSwipeButtons: stMocks.fns.showSwipeButtons,
    substituteParams: stMocks.fns.substituteParams,
    syncMesToSwipe: stMocks.fns.syncMesToSwipe,
    syncSwipeToMes: stMocks.fns.syncSwipeToMes,
    this_chid: stMocks.state.this_chid,
    updateMessageBlock: stMocks.fns.updateMessageBlock,
    updateSwipeCounter: stMocks.fns.updateSwipeCounter,
    updateViewMessageIds: stMocks.fns.updateViewMessageIds,
}));

vi.mock('@st/scripts/events.js', () => ({
    event_types: stMocks.event_types,
    eventSource: {
        on: stMocks.fns.eventOn,
        removeListener: stMocks.fns.eventRemoveListener,
        emit: stMocks.fns.eventEmit,
    },
}));

vi.mock('@st/scripts/group-chats.js', () => ({
    get selected_group() {
        return stMocks.state.selected_group;
    },
}));

vi.mock('@st/scripts/power-user.js', () => ({
    power_user: stMocks.state.power_user,
}));

vi.mock('@st/scripts/reasoning.js', () => ({
    ReasoningType: { Model: 'model', Parsed: 'parsed' },
    parseReasoningFromString: (raw: string) => ({ content: raw, reasoning: '' }),
    updateReasoningUI: stMocks.fns.updateReasoningUI,
}));

vi.mock('@st/scripts/RossAscends-mods.js', () => ({
    getMessageTimeStamp: stMocks.fns.getMessageTimeStamp,
}));

vi.mock('@st/scripts/constants.js', () => ({
    MEDIA_SOURCE: { GENERATED: 'generated' },
    MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
}));

vi.mock('@st/scripts/extensions.js', () => ({
    extension_settings: stMocks.state.extension_settings,
    saveMetadataDebounced: stMocks.fns.saveMetadataDebounced,
}));

vi.mock('@st/scripts/personas.js', () => ({
    user_avatar: stMocks.state.user_avatar,
}));

vi.mock('@st/scripts/utils.js', () => ({
    getCharaFilename: stMocks.fns.getCharaFilename,
}));

vi.mock('@st/scripts/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    loadWorldInfo: stMocks.fns.loadWorldInfo,
    selected_world_info: stMocks.state.selected_world_info,
    world_info: stMocks.state.world_info,
}));

vi.mock('@st/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
    getScriptsByType: vi.fn(() => []),
    saveScriptsByType: vi.fn(async () => undefined),
}));

vi.mock('@st/scripts/i18n.js', () => ({
    translate: (fallback: string) => fallback,
}));

vi.mock('@st/scripts/preset-manager.js', () => ({
    getPresetManager: vi.fn(() => undefined),
}));

vi.mock('@st/scripts/util/AccountStorage.js', () => ({
    accountStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
    },
}));

vi.mock('@st/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: {
        commands: {},
    },
}));

vi.mock('@st/scripts/macros/macro-system.js', () => ({
    MacroCategory: { UTILITY: 'utility' },
    MacroValueType: { STRING: 'string' },
    macros: {
        register: vi.fn(),
        registry: { unregister: vi.fn() },
    },
}));

vi.mock('@st/scripts/slash-commands.js', () => ({
    executeSlashCommands: vi.fn(async () => ({ pipe: '' })),
    executeSlashCommandsWithOptions: vi.fn(async () => ({ pipe: '' })),
}));

vi.mock('@st/scripts/slash-commands/SlashCommandAbortController.js', () => ({
    SlashCommandAbortController: class {
        abort = vi.fn();
    },
}));

import { TurnInterruptedError } from '@/core/agents';
import { createDefaultSettings } from '@/core/config';
import type { PipelineOrchestrator, RunTurnInput, RunTurnResult } from '@/core/triggers';
import type { MessageTarget, Settings } from '@/core/types';
import { createAgenticInterceptor } from '@/host/interceptor';
import { STHostBridge } from '@/host/st-bridge';
import { StreamRenderer } from '@/host/stream-renderer';
import type { AppStore } from '@/ui/store';

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function createFakePipeline(
    runTurnImpl: (input: RunTurnInput) => Promise<RunTurnResult>,
): PipelineOrchestrator {
    return {
        store: {
            rollbackStagedData: vi.fn(),
        },
        runTurn: vi.fn(runTurnImpl),
        resumeTurn: vi.fn(),
    } as unknown as PipelineOrchestrator;
}

function createMinimalAppStore(disconnectSpy?: ReturnType<typeof vi.fn>) {
    const activeTarget: MessageTarget = { messageId: 0, swipeId: 0 };
    return {
        setActiveTarget: vi.fn((next: MessageTarget) => {
            activeTarget.messageId = next.messageId;
            activeTarget.swipeId = next.swipeId;
        }),
        getSnapshot: vi.fn(() => ({
            activeTarget,
            traces: [],
            backgroundTasks: [],
            themeMode: 'dark' as const,
            resolvedTheme: 'dark' as const,
            settings: createDefaultSettings(),
        })),
        subscribe: vi.fn(() => disconnectSpy ?? (() => {})),
        pushToast: vi.fn(),
        services: {
            subscribeEvents: vi.fn(() => () => {}),
        },
    } as unknown as AppStore;
}

describe('Takeover swipe lifecycle and consistency', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;
    const originalCustomElements = (globalThis as { customElements?: unknown }).customElements;

    beforeEach(() => {
        stMocks.state.chat.length = 0;
        stMocks.state.characters.length = 0;
        stMocks.state.characters.push({ name: 'Alice', avatar: 'alice.png' });
        stMocks.state.selected_group = null;
        stMocks.state.externalAbortController = undefined;
        stMocks.state.swipesHidden = false;
        stMocks.eventListeners.clear();
        vi.clearAllMocks();
    });

    afterEach(() => {
        if (originalDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = originalDocument;
        }
        if (originalCustomElements === undefined) {
            delete (globalThis as { customElements?: unknown }).customElements;
        } else {
            (globalThis as { customElements?: unknown }).customElements = originalCustomElements;
        }
    });

    it('keeps Generate("swipe") pending until takeover runTurn completes and prevents endSwipe revert', async () => {
        stMocks.state.chat.push(
            { name: 'Tester', is_user: true, mes: 'Hi' },
            {
                name: 'Alice',
                is_user: false,
                mes: 's2',
                swipe_id: 2,
                swipes: ['s0', 's1', 's2'],
                swipe_info: [{}, {}, {}],
                extra: { display_text: 'stale display', reasoning: 'old reasoning' },
            },
        );

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();
        const deferred = createDeferred<RunTurnResult>();
        let capturedInput: RunTurnInput | undefined;

        const orchestrator = createFakePipeline(async (input) => {
            capturedInput = input;
            return await deferred.promise;
        });

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        // Simulate ST's overswipe -> Generate('swipe') -> endSwipe()
        const mesId = 1;
        const msg = stMocks.state.chat[mesId] as {
            swipe_id: number;
            swipes: string[];
            mes: string;
        };
        const originalSwipeId = msg.swipe_id;
        msg.swipe_id = msg.swipes.length; // 3 (unallocated slot during ST overswipe)

        let generationFinished = false;
        const fakeGenerateSwipe = async () => {
            let aborted = false;
            await handle.interceptor(stMocks.state.chat, 4096, () => {
                aborted = true;
            }, 'swipe');
            if (aborted) {
                stMocks.fns.activateSendButtons();
            }
            generationFinished = true;
        };

        const generationPromise = fakeGenerateSwipe();

        // Wait a microtask so interceptor enters runTurn
        await Promise.resolve();
        await Promise.resolve();

        expect(generationFinished).toBe(false);
        expect(capturedInput).toBeDefined();
        expect(capturedInput?.action).toBe('swipe');
        expect(capturedInput?.target).toEqual({ messageId: 1, swipeId: 3 });
        expect(capturedInput?.previousSwipeId).toBe(originalSwipeId);
        expect(capturedInput?.userInput).toBe('Hi');
        expect(msg.swipes.length).toBe(4);
        expect(stMocks.fns.updateSwipeCounter).toHaveBeenCalledWith(1);

        const trace = {
            runId: 'run-1',
            target: { messageId: 1, swipeId: 3 },
            phase: 'main_turn' as const,
            agentProfileId: 'main',
            agentName: 'Main',
            connectionId: 'conn-1',
            model: 'gpt-test',
            status: 'completed' as const,
            startedAt: Date.now(),
            durationMs: 100,
            usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50, totalTokens: 120 },
            toolSteps: [],
        };

        deferred.resolve({
            target: { messageId: 1, swipeId: 3 },
            action: 'swipe',
            content: 's3',
            deltaContent: 's3',
            beforeTurnResults: [],
            mainRun: {
                runId: 'run-1',
                target: { messageId: 1, swipeId: 3 },
                phase: 'main_turn',
                agentProfileId: 'main',
                content: 's3',
                rounds: 2,
                toolSteps: [],
                usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50, totalTokens: 120 },
                trace,
            },
            afterTurnTasks: [],
            maintenanceTasks: [],
        });

        await generationPromise;
        expect(generationFinished).toBe(true);

        // Simulate ST endSwipe() clamping check after `await generation`
        const clampedId = Math.max(0, Math.min(msg.swipe_id, msg.swipes.length - 1));
        expect(clampedId).toBe(3);
        expect(msg.swipe_id).toBe(3);
        expect(msg.mes).toBe('s3');
        expect(msg.swipes).toEqual(['s0', 's1', 's2', 's3']);
        expect(stMocks.fns.syncMesToSwipe).toHaveBeenCalledWith(1);
        expect(stMocks.fns.refreshSwipeButtons).toHaveBeenCalledWith(true);
        expect(stMocks.fns.updateSwipeCounter).toHaveBeenLastCalledWith(1);

        handle.dispose();
    });

    it('reverts empty aborted swipe takeover cleanly and restores activeTarget to previous swipe', async () => {
        stMocks.state.chat.push(
            { name: 'Tester', is_user: true, mes: 'Hi' },
            {
                name: 'Alice',
                is_user: false,
                mes: 's2',
                swipe_id: 2,
                swipes: ['s0', 's1', 's2'],
                swipe_info: [{}, {}, {}],
            },
        );

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();

        const orchestrator = createFakePipeline(async (input) => {
            return await new Promise<RunTurnResult>((_resolve, reject) => {
                input.signal?.addEventListener('abort', () => {
                    const err = new Error('Stopped by user');
                    err.name = 'AbortError';
                    reject(err);
                });
            });
        });

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        const msg = stMocks.state.chat[1] as { swipe_id: number; swipes: string[]; mes: string };
        msg.swipe_id = 3;

        const generationPromise = (async () => {
            await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'swipe');
        })();

        await Promise.resolve();
        await Promise.resolve();

        // Trigger GENERATION_STOPPED while running
        await stMocks.fns.eventEmit(stMocks.event_types.GENERATION_STOPPED);
        await generationPromise;

        const clampedId = Math.max(0, Math.min(msg.swipe_id, msg.swipes.length - 1));
        expect(clampedId).toBe(2);
        expect(msg.swipe_id).toBe(2);
        expect(msg.mes).toBe('s2');
        expect(msg.swipes).toEqual(['s0', 's1', 's2']);
        expect(stMocks.fns.syncSwipeToMes).toHaveBeenCalledWith(1, 2);
        expect(appStore.setActiveTarget).toHaveBeenLastCalledWith({ messageId: 1, swipeId: 2 });

        handle.dispose();
    });

    it('preserves new swipe slot and salvaged text when swipe takeover throws TurnInterruptedError', async () => {
        stMocks.state.chat.push(
            { name: 'Tester', is_user: true, mes: 'Hi' },
            {
                name: 'Alice',
                is_user: false,
                mes: 's2',
                swipe_id: 2,
                swipes: ['s0', 's1', 's2'],
                swipe_info: [{}, {}, {}],
            },
        );

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();

        const orchestrator = createFakePipeline(async (input) => {
            throw new TurnInterruptedError({
                reason: 'error',
                salvagedOutput: 'partial s3',
                errorMessage: 'network drop',
                checkpoint: {
                    target: input.target,
                    agentId: 'main',
                    reason: 'error',
                    completedTurnMessages: [],
                    readSetSnapshot: {},
                    stagedSnapshot: {},
                    createdAt: Date.now(),
                },
                trace: {
                    runId: 'run-1',
                    target: input.target,
                    agentProfileId: 'main',
                    agentName: 'Main',
                    connectionId: 'conn-1',
                    model: 'gpt-test',
                    phase: 'main_turn',
                    status: 'interrupted',
                    startedAt: Date.now(),
                    durationMs: 50,
                    toolSteps: [],
                    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
                },
            });
        });

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        const msg = stMocks.state.chat[1] as { swipe_id: number; swipes: string[]; mes: string };
        msg.swipe_id = 3;

        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'swipe');

        const clampedId = Math.max(0, Math.min(msg.swipe_id, msg.swipes.length - 1));
        expect(clampedId).toBe(3);
        expect(msg.swipe_id).toBe(3);
        expect(msg.mes).toBe('partial s3');
        expect(msg.swipes[3]).toBe('partial s3');
        expect(stMocks.fns.syncMesToSwipe).toHaveBeenCalledWith(1);
        expect(stMocks.fns.updateSwipeCounter).toHaveBeenLastCalledWith(1);
        expect(appStore.pushToast).toHaveBeenCalled();

        handle.dispose();
    });

    it('keeps capsule store subscription alive after finalize() so background tasks remain visible', async () => {
        const disconnectSpy = vi.fn();
        const setStateSpy = vi.fn();
        const connectStoreSpy = vi.fn(() => disconnectSpy);

        const fakeMesBlock = {
            classList: { contains: (cls: string) => cls === 'mes_block' },
            children: [],
            querySelector: vi.fn(() => null),
            appendChild: vi.fn(),
            prepend: vi.fn(),
        };

        const fakeCapsule = {
            isConnected: true,
            parentElement: fakeMesBlock,
            nextSibling: null,
            getAttribute: vi.fn(() => 'bottom'),
            setAttribute: vi.fn(),
            connectStore: connectStoreSpy,
            setState: setStateSpy,
            remove: vi.fn(),
        };

        const fakeMesElement = {
            querySelector: vi.fn((selector: string) => {
                if (selector === 'agentic-capsule') {
                    return fakeCapsule;
                }
                if (selector === '.mes_block') {
                    return fakeMesBlock;
                }
                return null;
            }),
        };

        (globalThis as { document?: unknown }).document = {
            querySelector: vi.fn((selector: string) =>
                selector.includes('[mesid="0"]') ? fakeMesElement : null,
            ),
        };
        (globalThis as { customElements?: unknown }).customElements = {
            get: vi.fn(() => class {}),
            define: vi.fn(),
        };

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const appStore = createMinimalAppStore(disconnectSpy);

        const renderer = StreamRenderer.beginPlaceholder('normal', {
            getSettings: () => settings,
            getStore: () => undefined,
            getAppStore: () => appStore,
            substituteMacros: (t) => t,
            identity: {
                userName: 'Tester',
                charName: 'Alice',
                characterAvatar: 'alice.png',
                personaAvatar: 'tester.png',
            },
        });

        await renderer.finalize({
            finalText: 'Done text',
            hasBackgroundTasks: true,
            stepCount: 3,
            cacheHitRate: 0.75,
        });

        expect(connectStoreSpy).toHaveBeenCalledTimes(1);
        expect(disconnectSpy).not.toHaveBeenCalled();
        expect(setStateSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                status: 'background-running',
                stepCount: 3,
                cacheHitRate: 0.75,
            }),
        );
    });

    it('STHostBridge.refreshMessageView() returns early for unallocated overswipe slot', async () => {
        stMocks.state.chat.push({
            name: 'Alice',
            is_user: false,
            mes: 's2',
            swipe_id: 3,
            swipes: ['s0', 's1', 's2'],
        });

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });

        await bridge.refreshMessageView({ messageId: 0, swipeId: 3 });

        expect(stMocks.fns.updateMessageBlock).not.toHaveBeenCalled();
        expect(stMocks.fns.messageFormatting).not.toHaveBeenCalled();
    });

    it('normalizes empty #send_but click or #send_textarea Enter on assistant tail from continue to normal (new floor) while preserving explicit continue', async () => {
        const docListeners = new Map<string, Set<(event: unknown) => void>>();
        const sendTextarea = { id: 'send_textarea', value: '' };
        const sendBut = {
            id: 'send_but',
            closest: (sel: string) => (sel === '#send_but' ? sendBut : null),
        };
        const optionContinue = {
            id: 'option_continue',
            closest: (sel: string) => (sel === '#option_continue' ? optionContinue : null),
        };

        const addEventListenerSpy = vi.fn(
            (type: string, listener: (event: unknown) => void, _capture?: boolean) => {
                let set = docListeners.get(type);
                if (!set) {
                    set = new Set();
                    docListeners.set(type, set);
                }
                set.add(listener);
            },
        );
        const removeEventListenerSpy = vi.fn(
            (type: string, listener: (event: unknown) => void, _capture?: boolean) => {
                docListeners.get(type)?.delete(listener);
            },
        );
        const dispatchDoc = (type: string, event: Record<string, unknown>) => {
            for (const listener of Array.from(docListeners.get(type) ?? [])) {
                listener(event);
            }
        };

        (globalThis as { document?: unknown }).document = {
            body: { dataset: {} as Record<string, string> },
            querySelector: (selector: string) => {
                if (selector === '#send_textarea') return sendTextarea;
                if (selector === '#send_but') return sendBut;
                return null;
            },
            addEventListener: addEventListenerSpy,
            removeEventListener: removeEventListenerSpy,
        };

        stMocks.state.chat.push(
            { name: 'Tester', is_user: true, mes: 'Hi' },
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: 'Existing formatted card reply',
                swipe_id: 0,
                swipes: ['Existing formatted card reply'],
                swipe_info: [{}],
            },
        );

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();
        const capturedInputs: RunTurnInput[] = [];

        const orchestrator = createFakePipeline(async (input) => {
            capturedInputs.push(input);
            return {
                target: input.target,
                action: input.action,
                content: `Reply for #${input.target.messageId} (${input.action})`,
                deltaContent: `Reply for #${input.target.messageId} (${input.action})`,
                beforeTurnResults: [],
                mainRun: {
                    runId: `run-${capturedInputs.length}`,
                    target: input.target,
                    phase: 'main_turn',
                    agentProfileId: 'main',
                    content: `Reply for #${input.target.messageId} (${input.action})`,
                    rounds: 1,
                    toolSteps: [],
                    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
                    trace: {
                        runId: `run-${capturedInputs.length}`,
                        target: input.target,
                        phase: 'main_turn',
                        agentProfileId: 'main',
                        agentName: 'Main',
                        connectionId: 'conn-1',
                        model: 'gpt-test',
                        status: 'completed',
                        startedAt: Date.now(),
                        durationMs: 10,
                        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
                        toolSteps: [],
                    },
                },
                afterTurnTasks: [],
                maintenanceTasks: [],
            };
        });

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        // 1. Clicking #send_but with empty textarea -> ST passes type='continue', interceptor normalizes to 'normal' (new floor #2)
        dispatchDoc('pointerdown', { target: sendBut });
        dispatchDoc('click', { target: sendBut });
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'continue');

        expect(capturedInputs).toHaveLength(1);
        expect(capturedInputs[0]?.action).toBe('normal');
        expect(capturedInputs[0]?.target).toEqual({ messageId: 2, swipeId: 0 });
        expect(stMocks.state.chat).toHaveLength(3);
        expect(stMocks.state.chat[1]?.mes).toBe('Existing formatted card reply');
        expect(stMocks.state.chat[2]?.mes).toBe('Reply for #2 (normal)');

        // 2. Pressing Enter in empty #send_textarea -> ST passes type='continue', interceptor normalizes to 'normal' (new floor #3)
        dispatchDoc('keydown', {
            target: sendTextarea,
            key: 'Enter',
            shiftKey: false,
            altKey: false,
            isComposing: false,
        });
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'continue');

        expect(capturedInputs).toHaveLength(2);
        expect(capturedInputs[1]?.action).toBe('normal');
        expect(capturedInputs[1]?.target).toEqual({ messageId: 3, swipeId: 0 });
        expect(stMocks.state.chat).toHaveLength(4);
        expect(stMocks.state.chat[2]?.mes).toBe('Reply for #2 (normal)');
        expect(stMocks.state.chat[3]?.mes).toBe('Reply for #3 (normal)');

        // 3. Explicit #option_continue click -> stays 'continue' in-place on floor #3
        dispatchDoc('pointerdown', { target: sendBut });
        dispatchDoc('click', { target: optionContinue });
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'continue');

        expect(capturedInputs).toHaveLength(3);
        expect(capturedInputs[2]?.action).toBe('continue');
        expect(capturedInputs[2]?.target).toEqual({ messageId: 3, swipeId: 0 });
        expect(stMocks.state.chat).toHaveLength(4);

        handle.dispose();
        expect(removeEventListenerSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
        expect(removeEventListenerSpy).toHaveBeenCalledWith('click', expect.any(Function), true);
        expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    });

    it('cancels queued rAF streaming preview frames when /output.md tool writes or MESSAGE_UPDATED / CHARACTER_MESSAGE_RENDERED fires so mounted iframes are not overwritten', async () => {
        const originalRaf = globalThis.requestAnimationFrame;
        const originalCancelRaf = globalThis.cancelAnimationFrame;

        let nextRafId = 1;
        const rafQueue = new Map<number, FrameRequestCallback>();
        const cancelSpy = vi.fn((id: number) => {
            rafQueue.delete(id);
        });
        globalThis.requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
            const id = nextRafId++;
            rafQueue.set(id, cb);
            return id;
        });
        globalThis.cancelAnimationFrame = cancelSpy;

        const mesTextEl = { innerHTML: '' };
        const fakeMesBlock = {
            classList: { contains: (cls: string) => cls === 'mes_block' },
            children: [],
            querySelector: vi.fn(() => null),
            appendChild: vi.fn(),
            prepend: vi.fn(),
        };
        const fakeCapsule = {
            isConnected: true,
            parentElement: fakeMesBlock,
            nextSibling: null,
            getAttribute: vi.fn(() => 'bottom'),
            setAttribute: vi.fn(),
            connectStore: vi.fn(() => () => {}),
            setState: vi.fn(),
            remove: vi.fn(),
        };
        const fakeMesElement = {
            querySelector: vi.fn((selector: string) => {
                if (selector === '.mes_text') return mesTextEl;
                if (selector === 'agentic-capsule') return fakeCapsule;
                if (selector === '.mes_block') return fakeMesBlock;
                return null;
            }),
            remove: vi.fn(),
        };
        (globalThis as { document?: unknown }).document = {
            querySelector: vi.fn((selector: string) =>
                selector.includes('[mesid="0"]') ? fakeMesElement : null,
            ),
        };
        (globalThis as { customElements?: unknown }).customElements = {
            get: vi.fn(() => class {}),
            define: vi.fn(),
        };

        try {
            const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
            const renderer = StreamRenderer.beginPlaceholder('normal', {
                getSettings: () => settings,
                getStore: () => undefined,
                substituteMacros: (t) => t,
                identity: {
                    userName: 'Tester',
                    charName: 'Alice',
                    characterAvatar: 'alice.png',
                    personaAvatar: 'tester.png',
                },
            });

            // 1. Stream preview schedules a rAF frame
            renderer.setOutputPreview('<div>stream draft</div>');
            expect(rafQueue.size).toBe(1);

            // 2. Output tool starts & commits /output.md -> host emits MESSAGE_UPDATED & CHARACTER_MESSAGE_RENDERED
            renderer.onToolStart('write_file');
            expect(cancelSpy).toHaveBeenCalledTimes(1);
            expect(rafQueue.size).toBe(0);

            // Simulate streaming preview queued again right before host event, then JS-Slash-Runner mounts iframe
            renderer.setOutputPreview('<div>final html</div>');
            expect(rafQueue.size).toBe(1);

            stMocks.state.chat[0].mes = '<div>final html</div>';
            (stMocks.state.chat[0].swipes as string[])[0] = '<div>final html</div>';
            mesTextEl.innerHTML = '<iframe data-js-slash-runner="mounted"></iframe>';

            await stMocks.fns.eventEmit(stMocks.event_types.MESSAGE_UPDATED, 0);
            await stMocks.fns.eventEmit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 0, 'agentic_rerender');
            renderer.onToolComplete('write_file');

            expect(rafQueue.size).toBe(0);
            expect(mesTextEl.innerHTML).toBe('<iframe data-js-slash-runner="mounted"></iframe>');

            // 3. Subsequent reasoning delta in next round updates reasoning UI without overwriting .mes_text iframe
            renderer.appendReasoningDelta('checking variables...');
            expect(rafQueue.size).toBe(1);
            const callbacks = Array.from(rafQueue.values());
            rafQueue.clear();
            for (const cb of callbacks) {
                cb(Date.now());
            }

            expect(mesTextEl.innerHTML).toBe('<iframe data-js-slash-runner="mounted"></iframe>');
            expect(stMocks.fns.updateReasoningUI).toHaveBeenCalled();

            // 4. Deleting /output.md clears outputPreviewText so a subsequent reasoning frame does not revive stale text
            stMocks.state.chat[0].mes = '';
            (stMocks.state.chat[0].swipes as string[])[0] = '';
            mesTextEl.innerHTML = '';
            renderer.onToolStart('delete_file');
            renderer.onToolComplete('delete_file');
            expect(renderer.getAccumulatedText()).toBe('');
            renderer.appendReasoningDelta('rethinking after delete...');
            const postDeleteCallbacks = Array.from(rafQueue.values());
            rafQueue.clear();
            for (const cb of postDeleteCallbacks) {
                cb(Date.now());
            }
            expect(mesTextEl.innerHTML).toBe('');

            await renderer.abort({ wasUserStop: true });

            // 5. Round-0 empty abort on a createdNewMessage detaches all eventSource & store listeners cleanly
            const unsubscribeEventsSpy = vi.fn();
            const appStoreWithUnsub = {
                ...createMinimalAppStore(),
                services: {
                    subscribeEvents: vi.fn(() => unsubscribeEventsSpy),
                },
            } as unknown as AppStore;
            const emptyRenderer = StreamRenderer.beginPlaceholder('normal', {
                getSettings: () => settings,
                getStore: () => undefined,
                getAppStore: () => appStoreWithUnsub,
                substituteMacros: (t) => t,
                identity: {
                    userName: 'Tester',
                    charName: 'Alice',
                    characterAvatar: 'alice.png',
                    personaAvatar: 'tester.png',
                },
            });
            expect(stMocks.eventListeners.get(stMocks.event_types.MESSAGE_UPDATED)?.size).toBe(1);
            expect(
                stMocks.eventListeners.get(stMocks.event_types.CHARACTER_MESSAGE_RENDERED)?.size,
            ).toBe(1);
            await emptyRenderer.abort({ wasUserStop: true });
            expect(stMocks.eventListeners.get(stMocks.event_types.MESSAGE_UPDATED)?.size ?? 0).toBe(0);
            expect(
                stMocks.eventListeners.get(stMocks.event_types.CHARACTER_MESSAGE_RENDERED)?.size ?? 0,
            ).toBe(0);
            expect(unsubscribeEventsSpy).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.requestAnimationFrame = originalRaf;
            globalThis.cancelAnimationFrame = originalCancelRaf;
        }
    });

    it('recreates popped round-0 floor in bindExisting, resumeTakeoverTurn (forwarding rollbackLastToolRound), and retryTakeoverTurn', async () => {
        stMocks.state.chat.push({
            name: 'Tester',
            is_user: true,
            is_system: false,
            mes: 'Hello Alice',
            swipe_id: 0,
            swipes: ['Hello Alice'],
        });

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();

        const resumeCalls: Array<Record<string, unknown>> = [];
        const runTurnCalls: RunTurnInput[] = [];
        const clearCheckpointSpy = vi.fn();

        const makeResult = (target: MessageTarget, action: RunTurnInput['action'], content: string): RunTurnResult => ({
            target,
            action,
            content,
            deltaContent: content,
            beforeTurnResults: [],
            mainRun: {
                runId: 'run-recovered',
                target,
                phase: 'main_turn',
                agentProfileId: 'main',
                content,
                rounds: 1,
                toolSteps: [],
                usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0, totalTokens: 30 },
                trace: {
                    runId: 'run-recovered',
                    target,
                    phase: 'main_turn',
                    agentProfileId: 'main',
                    agentName: 'Main',
                    connectionId: 'conn-1',
                    model: 'gpt-test',
                    status: 'completed',
                    startedAt: Date.now(),
                    durationMs: 20,
                    usage: { inputTokens: 20, outputTokens: 10, cachedTokens: 0, totalTokens: 30 },
                    toolSteps: [],
                },
            },
            afterTurnTasks: [],
            maintenanceTasks: [],
        });

        const orchestrator = {
            store: {
                rollbackStagedData: vi.fn(),
            },
            trajectoryStore: {
                clearInterruptedCheckpoint: clearCheckpointSpy,
            },
            runTurn: vi.fn(async (input: RunTurnInput) => {
                runTurnCalls.push(input);
                return makeResult(input.target, input.action, `Retried (${input.action})`);
            }),
            resumeTurn: vi.fn(async (input: Record<string, unknown>) => {
                resumeCalls.push(input);
                return makeResult(input.target as MessageTarget, 'continue', 'Resumed after pop');
            }),
        } as unknown as PipelineOrchestrator;

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        // 1. Floor #1 was popped (chat.length === 1) -> resumeTakeoverTurn recreates floor #1 and forwards rollbackLastToolRound
        await handle.resumeTakeoverTurn({ messageId: 1, swipeId: 0 }, { rollbackLastToolRound: true });

        expect(appStore.pushToast).not.toHaveBeenCalled();
        expect(stMocks.state.chat).toHaveLength(2);
        expect(stMocks.state.chat[1]?.mes).toBe('Resumed after pop');
        expect(stMocks.fns.addOneMessage).toHaveBeenCalledTimes(1);
        expect(resumeCalls).toHaveLength(1);
        expect(resumeCalls[0]?.rollbackLastToolRound).toBe(true);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.MESSAGE_RECEIVED,
            1,
            'normal',
        );

        // 2. Pop floor #1 again -> retryTakeoverTurn recreates floor #1 and runs a fresh 'normal' turn with userInput
        stMocks.state.chat.pop();
        expect(stMocks.state.chat).toHaveLength(1);
        await handle.retryTakeoverTurn({ messageId: 1, swipeId: 0 });

        expect(clearCheckpointSpy).toHaveBeenCalledWith({ messageId: 1, swipeId: 0 });
        expect(stMocks.state.chat).toHaveLength(2);
        expect(runTurnCalls[0]?.action).toBe('normal');
        expect(runTurnCalls[0]?.userInput).toBe('Hello Alice');
        expect(stMocks.state.chat[1]?.mes).toBe('Retried (normal)');

        // 3. Retry existing floor #1 in-place -> resets content, clears staged/checkpoint state, and runs 'regenerate' without adding floor #2
        clearCheckpointSpy.mockClear();
        (orchestrator.store.rollbackStagedData as ReturnType<typeof vi.fn>).mockClear();
        await handle.retryTakeoverTurn({ messageId: 1, swipeId: 0 });
        expect(orchestrator.store.rollbackStagedData).toHaveBeenCalledWith({ messageId: 1, swipeId: 0 });
        expect(clearCheckpointSpy).toHaveBeenCalledWith({ messageId: 1, swipeId: 0 });
        expect(stMocks.state.chat).toHaveLength(2);
        expect(runTurnCalls[1]?.action).toBe('regenerate');
        expect(runTurnCalls[1]?.userInput).toBe('Hello Alice');
        expect(stMocks.state.chat[1]?.mes).toBe('Retried (regenerate)');

        // 4. Out-of-bounds target (messageId > chat.length) still fails cleanly with toast
        await handle.resumeTakeoverTurn({ messageId: 5, swipeId: 0 });
        expect(appStore.pushToast).toHaveBeenCalledWith('无法恢复：目标消息不存在。', 'error');

        handle.dispose();
    });

    it('forwards preceding userInput on regenerate across system messages while keeping continue and empty-send on assistant tail undefined', async () => {
        stMocks.state.chat.push(
            { name: 'Tester', is_user: true, is_system: false, mes: 'Open the tavern door' },
            { name: 'System', is_user: false, is_system: true, mes: 'System note' },
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: 'Initial reply',
                swipe_id: 0,
                swipes: ['Initial reply'],
                swipe_info: [{}],
            },
        );

        const settings: Settings = { ...createDefaultSettings(), runMode: 'takeover' };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const appStore = createMinimalAppStore();
        const capturedInputs: RunTurnInput[] = [];

        const orchestrator = createFakePipeline(async (input) => {
            capturedInputs.push(input);
            return {
                target: input.target,
                action: input.action,
                content: `Reply (${input.action})`,
                deltaContent: `Reply (${input.action})`,
                beforeTurnResults: [],
                mainRun: {
                    runId: `run-${capturedInputs.length}`,
                    target: input.target,
                    phase: 'main_turn',
                    agentProfileId: 'main',
                    content: `Reply (${input.action})`,
                    rounds: 1,
                    toolSteps: [],
                    usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
                    trace: {
                        runId: `run-${capturedInputs.length}`,
                        target: input.target,
                        phase: 'main_turn',
                        agentProfileId: 'main',
                        agentName: 'Main',
                        connectionId: 'conn-1',
                        model: 'gpt-test',
                        status: 'completed',
                        startedAt: Date.now(),
                        durationMs: 10,
                        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15 },
                        toolSteps: [],
                    },
                },
                afterTurnTasks: [],
                maintenanceTasks: [],
            };
        });

        const handle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => settings,
            getAppStore: () => appStore,
            registerGlobal: false,
        });

        // 1. Regenerate after ST pops the trailing assistant floor skips intervening is_system floor #1 and recovers userInput from floor #0
        stMocks.state.chat.pop();
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'regenerate');
        expect(capturedInputs[0]?.action).toBe('regenerate');
        expect(capturedInputs[0]?.target).toEqual({ messageId: 2, swipeId: 0 });
        expect(capturedInputs[0]?.userInput).toBe('Open the tavern door');
        expect(capturedInputs[0]?.userName).toBe('Tester');

        // 2. Continue preserves userInput: undefined
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'continue');
        expect(capturedInputs[1]?.action).toBe('continue');
        expect(capturedInputs[1]?.userInput).toBeUndefined();

        // 3. Normal send immediately following an assistant message preserves userInput: undefined
        await handle.interceptor(stMocks.state.chat, 4096, () => {}, 'normal');
        expect(capturedInputs[2]?.action).toBe('normal');
        expect(capturedInputs[2]?.userInput).toBeUndefined();

        handle.dispose();
    });
});
