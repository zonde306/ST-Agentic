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
            personas: {} as Record<string, string>,
            persona_descriptions: {} as Record<string, Record<string, unknown>>,
            persona_description: '',
        } as Record<string, unknown>,
        world_names: [] as string[],
        selected_world_info: [] as string[],
        world_info: { globalSelect: [] as string[], charLore: [] as unknown[] } as Record<string, unknown>,
        worldBooks: new Map<string, { entries: Record<string, Record<string, unknown>> }>(),
        scopedRegex: [] as Array<Record<string, unknown>>,
        globalRegex: [] as Array<Record<string, unknown>>,
        presets: new Map<string, Record<string, unknown>>(),
        selectedPresetName: 'Default',
        registeredSlashCommands: {} as Record<string, Record<string, unknown>>,
        registeredMacros: new Map<string, unknown>(),
        is_send_press: false,
        isChatSaving: false,
        currentChatId: 'chat-1' as string | undefined,
    };

    const fns = {
        getRequestHeaders: vi.fn((opts?: { omitContentType?: boolean }) =>
            opts?.omitContentType
                ? { 'X-CSRF-Token': 'csrf-test' }
                : { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' },
        ),
        getCurrentChatId: vi.fn(() => state.currentChatId),
        saveChatConditional: vi.fn(async () => undefined),
        saveChatDebounced: vi.fn(),
        saveCharacterDebounced: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        saveMetadata: vi.fn(async () => undefined),
        saveMetadataDebounced: vi.fn(),
        addOneMessage: vi.fn(),
        deleteMessage: vi.fn(async (id: number) => {
            state.chat.splice(id, 1);
            fns.saveChatDebounced();
            await fns.eventEmit(event_types.MESSAGE_DELETED, state.chat.length);
        }),
        refreshSwipeButtons: vi.fn(),
        updateViewMessageIds: vi.fn(),
        updateMessageBlock: vi.fn(),
        setExtensionPrompt: vi.fn(),
        substituteParams: vi.fn((text: string) => text),
        syncMesToSwipe: vi.fn(),
        appendMediaToMessage: vi.fn(),
        messageFormatting: vi.fn((text: string) => text),
        getCharacterCardFields: vi.fn(() => ({})),
        getCharaFilename: vi.fn(() => 'alice'),
        getCharacters: vi.fn(async () => undefined),
        selectCharacterById: vi.fn(async (id: number) => {
            state.this_chid = id;
        }),
        deleteCharacter: vi.fn(async (avatar: string) => {
            const idx = state.characters.findIndex((c) => c.avatar === avatar);
            if (idx >= 0) {
                state.characters.splice(idx, 1);
            }
        }),
        loadWorldInfo: vi.fn(async (name: string) => state.worldBooks.get(name) ?? null),
        saveWorldInfo: vi.fn(async (name: string, data: { entries: Record<string, Record<string, unknown>> }) => {
            state.worldBooks.set(name, data);
        }),
        createNewWorldInfo: vi.fn(async (name: string) => {
            state.worldBooks.set(name, { entries: {} });
            if (!state.world_names.includes(name)) {
                state.world_names.push(name);
            }
            return true;
        }),
        createWorldInfoEntry: vi.fn((_name: string, data: { entries: Record<string, Record<string, unknown>> }) => {
            const existingIds = Object.keys(data.entries).map((k) => Number(k)).filter(Number.isFinite);
            const nextUid = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
            const entry = { uid: nextUid, key: [], keysecondary: [], comment: '', content: '' };
            data.entries[String(nextUid)] = entry;
            return entry;
        }),
        deleteWorldInfoEntry: vi.fn(async (data: { entries: Record<string, Record<string, unknown>> }, uid: number) => {
            const key = String(uid);
            if (key in data.entries) {
                delete data.entries[key];
                return true;
            }
            return false;
        }),
        reloadEditor: vi.fn(),
        updateWorldInfoList: vi.fn(async () => undefined),
        onWorldInfoChange: vi.fn(),
        getScriptsByType: vi.fn((type: number) => {
            if (type === 1) return state.scopedRegex;
            if (type === 0) return state.globalRegex;
            return [];
        }),
        saveScriptsByType: vi.fn(async (scripts: Array<Record<string, unknown>>, type: number) => {
            if (type === 1) {
                state.scopedRegex = scripts;
            } else if (type === 0) {
                state.globalRegex = scripts;
            }
        }),
        setUserAvatar: vi.fn(async (key: string) => {
            state.user_avatar = key;
        }),
        presetManagerSelect: vi.fn(async (val: string) => {
            state.selectedPresetName = val;
        }),
        presetManagerSave: vi.fn(async (name: string, settings: Record<string, unknown>) => {
            state.presets.set(name, settings);
        }),
        executeSlashCommandsWithOptions: vi.fn(async (cmd: string) => ({ pipe: `ran:${cmd}` })),
        executeSlashCommands: vi.fn(async (cmd: string) => ({ pipe: `ran:${cmd}` })),
        eventEmit: vi.fn(async (event: string, ...args: unknown[]) => {
            const listeners = eventListeners.get(event);
            if (!listeners) return;
            for (const listener of listeners) {
                await listener(...args);
            }
        }),
    };

    const eventSource = {
        on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
            let set = eventListeners.get(event);
            if (!set) {
                set = new Set();
                eventListeners.set(event, set);
            }
            set.add(handler);
        }),
        removeListener: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
            eventListeners.get(event)?.delete(handler);
        }),
        emit: fns.eventEmit,
    };

    const event_types = {
        GENERATION_STARTED: 'generation_started',
        GENERATION_AFTER_COMMANDS: 'generation_after_commands',
        WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
        USER_MESSAGE_RENDERED: 'user_message_rendered',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
        IMPERSONATE_READY: 'impersonate_ready',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        MESSAGE_SENT: 'message_sent',
        MESSAGE_RECEIVED: 'message_received',
        MESSAGE_UPDATED: 'message_updated',
        SETTINGS_LOADED: 'settings_loaded',
        EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
        CHAT_CHANGED: 'chat_changed',
        CHARACTER_EDITED: 'character_edited',
    };

    const presetManager = {
        apiId: 'openai',
        getAllPresets: () => Array.from(state.presets.keys()),
        findPreset: (name: string) => (state.presets.has(name) ? name : undefined),
        getSelectedPresetName: () => state.selectedPresetName,
        selectPreset: fns.presetManagerSelect,
        savePreset: fns.presetManagerSave,
        getCompletionPresetByName: (name: string) => state.presets.get(name),
    };

    return { state, fns, eventSource, event_types, eventListeners, presetManager };
});

vi.mock('@st/script.js', () => ({
    get characters() {
        return stMocks.state.characters;
    },
    get chat() {
        return stMocks.state.chat;
    },
    get chat_metadata() {
        return stMocks.state.chat_metadata;
    },
    get this_chid() {
        return stMocks.state.this_chid;
    },
    get name1() {
        return stMocks.state.name1;
    },
    get name2() {
        return stMocks.state.name2;
    },
    get is_send_press() {
        return stMocks.state.is_send_press;
    },
    get isChatSaving() {
        return stMocks.state.isChatSaving;
    },
    extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    getCurrentChatId: stMocks.fns.getCurrentChatId,
    getRequestHeaders: stMocks.fns.getRequestHeaders,
    saveChatConditional: stMocks.fns.saveChatConditional,
    saveChatDebounced: stMocks.fns.saveChatDebounced,
    saveCharacterDebounced: stMocks.fns.saveCharacterDebounced,
    saveSettingsDebounced: stMocks.fns.saveSettingsDebounced,
    saveMetadata: stMocks.fns.saveMetadata,
    addOneMessage: stMocks.fns.addOneMessage,
    deleteMessage: stMocks.fns.deleteMessage,
    refreshSwipeButtons: stMocks.fns.refreshSwipeButtons,
    updateMessageBlock: stMocks.fns.updateMessageBlock,
    updateViewMessageIds: stMocks.fns.updateViewMessageIds,
    setExtensionPrompt: stMocks.fns.setExtensionPrompt,
    substituteParams: stMocks.fns.substituteParams,
    syncMesToSwipe: stMocks.fns.syncMesToSwipe,
    appendMediaToMessage: stMocks.fns.appendMediaToMessage,
    messageFormatting: stMocks.fns.messageFormatting,
    getCharacterCardFields: stMocks.fns.getCharacterCardFields,
    getCharacters: stMocks.fns.getCharacters,
    selectCharacterById: stMocks.fns.selectCharacterById,
    deleteCharacter: stMocks.fns.deleteCharacter,
    addCopyToCodeBlocks: vi.fn(),
}));

vi.mock('@st/scripts/constants.js', () => ({
    MEDIA_SOURCE: { GENERATED: 'generated' },
    MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video', AUDIO: 'audio' },
}));

vi.mock('@st/scripts/events.js', () => ({
    eventSource: stMocks.eventSource,
    event_types: stMocks.event_types,
}));

vi.mock('@st/scripts/extensions.js', () => ({
    get extension_settings() {
        return stMocks.state.extension_settings;
    },
    saveMetadataDebounced: stMocks.fns.saveMetadataDebounced,
}));

vi.mock('@st/scripts/i18n.js', () => ({
    translate: (fallback: string) => fallback,
}));

vi.mock('@st/scripts/personas.js', () => ({
    get user_avatar() {
        return stMocks.state.user_avatar;
    },
    setUserAvatar: stMocks.fns.setUserAvatar,
}));

vi.mock('@st/scripts/power-user.js', () => ({
    get power_user() {
        return stMocks.state.power_user;
    },
}));

vi.mock('@st/scripts/preset-manager.js', () => ({
    getPresetManager: vi.fn(() => stMocks.presetManager),
}));

vi.mock('@st/scripts/reasoning.js', () => ({
    updateReasoningUI: vi.fn(),
}));

vi.mock('@st/scripts/utils.js', () => ({
    getCharaFilename: stMocks.fns.getCharaFilename,
}));

vi.mock('@st/scripts/util/AccountStorage.js', () => ({
    accountStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
    },
}));

vi.mock('@st/scripts/group-chats.js', () => ({
    get selected_group() {
        return stMocks.state.selected_group;
    },
}));

vi.mock('@st/scripts/macros/macro-system.js', () => ({
    MacroCategory: { UTILITY: 'utility' },
    MacroValueType: { STRING: 'string' },
    macros: {
        register: vi.fn((name: string, def: unknown) => {
            stMocks.state.registeredMacros.set(name, def);
        }),
        registry: {
            unregister: vi.fn((name: string) => {
                stMocks.state.registeredMacros.delete(name);
            }),
        },
    },
}));

vi.mock('@st/scripts/world-info.js', () => ({
    METADATA_KEY: 'world_info',
    get world_names() {
        return stMocks.state.world_names;
    },
    get selected_world_info() {
        return stMocks.state.selected_world_info;
    },
    get world_info() {
        return stMocks.state.world_info;
    },
    worldInfoCache: {
        get: (name: string) => stMocks.state.worldBooks.get(name),
    },
    loadWorldInfo: stMocks.fns.loadWorldInfo,
    saveWorldInfo: stMocks.fns.saveWorldInfo,
    createNewWorldInfo: stMocks.fns.createNewWorldInfo,
    createWorldInfoEntry: stMocks.fns.createWorldInfoEntry,
    deleteWorldInfoEntry: stMocks.fns.deleteWorldInfoEntry,
    reloadEditor: stMocks.fns.reloadEditor,
    updateWorldInfoList: stMocks.fns.updateWorldInfoList,
    onWorldInfoChange: stMocks.fns.onWorldInfoChange,
}));

vi.mock('@st/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
    getScriptsByType: stMocks.fns.getScriptsByType,
    saveScriptsByType: stMocks.fns.saveScriptsByType,
}));

vi.mock('@st/scripts/slash-commands.js', () => ({
    executeSlashCommands: stMocks.fns.executeSlashCommands,
    executeSlashCommandsWithOptions: stMocks.fns.executeSlashCommandsWithOptions,
}));

vi.mock('@st/scripts/slash-commands/SlashCommandAbortController.js', () => ({
    SlashCommandAbortController: class {
        abort = vi.fn();
    },
}));

vi.mock('@st/scripts/slash-commands/SlashCommand.js', () => ({
    SlashCommand: {
        fromProps: (props: Record<string, unknown>) => ({ ...props }),
    },
}));

vi.mock('@st/scripts/slash-commands/SlashCommandArgument.js', () => ({
    ARGUMENT_TYPE: { STRING: 'string', NUMBER: 'number', BOOLEAN: 'bool' },
    SlashCommandArgument: {
        fromProps: (props: Record<string, unknown>) => ({ ...props }),
    },
    SlashCommandNamedArgument: {
        fromProps: (props: Record<string, unknown>) => ({ ...props }),
    },
}));

vi.mock('@st/scripts/slash-commands/SlashCommandParser.js', () => ({
    SlashCommandParser: {
        get commands() {
            return stMocks.state.registeredSlashCommands;
        },
        addCommandObject: vi.fn((cmd: Record<string, unknown>) => {
            if (typeof cmd.name === 'string') {
                stMocks.state.registeredSlashCommands[cmd.name] = cmd;
            }
        }),
    },
}));

import type { ToolSideGenApi } from '@/core/bridge';
import { createDefaultSettings } from '@/core/config';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import type { PipelineOrchestrator } from '@/core/triggers';
import type { Settings } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import {
    AGENTIC_GENERATION_ERROR_EVENT,
    COMPANION_SIDE_BRIDGE_PROMPT_KEY,
    type CompanionGenerationErrorPayload,
    setupCompanionHooks,
} from '@/host/companion-hooks';
import {
    SIDEGEN_SLASH_COMMANDS,
    dispatchSideGenClue,
    dispatchSideGenOnce,
    dispatchSideGenSend,
    parseSideGenSlashInput,
    registerSideGenSlashCommands,
} from '@/host/sidegen-slash';
import { STAdminBridge } from '@/host/st-admin-bridge';
import { STAuthorBridge } from '@/host/st-author-bridge';
import { AGENTIC_RERENDER_EVENT_TYPE, STHostBridge } from '@/host/st-bridge';

function resetStState() {
    stMocks.eventListeners.clear();
    stMocks.state.this_chid = 0;
    stMocks.state.name1 = 'Tester';
    stMocks.state.name2 = 'Alice';
    stMocks.state.user_avatar = 'tester.png';
    stMocks.state.selected_group = null;
    stMocks.state.isChatSaving = false;
    stMocks.state.currentChatId = 'chat-1';
    stMocks.state.characters = [
        {
            name: 'Alice',
            avatar: 'alice.png',
            description: 'Old description',
            personality: 'Calm',
            scenario: 'Old dock',
            creatorcomment: 'Initial note',
            json_data: JSON.stringify({
                name: 'Alice',
                description: 'Old description',
                data: {
                    name: 'Alice',
                    description: 'Old description',
                    extensions: {
                        world: 'HarborLore',
                        untouched_ext: { keep: true },
                    },
                },
            }),
            data: {
                name: 'Alice',
                description: 'Old description',
                personality: 'Calm',
                scenario: 'Old dock',
                creator_notes: 'Initial note',
                system_prompt: 'Base sys',
                extensions: {
                    world: 'HarborLore',
                    untouched_ext: { keep: true },
                },
            },
        },
    ];
    stMocks.state.chat = [
        { name: 'Tester', is_user: true, is_system: false, mes: '今晚我们去老码头灯塔看看', swipe_id: 0, swipes: ['今晚我们去老码头灯塔看看'] },
    ];
    stMocks.state.chat_metadata = { character_name: 'Alice' };
    stMocks.state.extension_settings = {
        regex: [],
        Agentic: { apiKey: 'sk-secret-value' },
    };
    stMocks.state.power_user = {
        personas: { 'tester.png': 'Tester', 'detective.png': 'Detective' },
        persona_descriptions: {
            'tester.png': { description: 'Original persona', title: 'Main' },
            'detective.png': { description: 'Investigator', title: 'Alt' },
        },
        persona_description: 'Original persona',
        fast_ui_mode: false,
    };
    stMocks.state.world_names = ['HarborLore', 'ArchiveBook'];
    stMocks.state.selected_world_info = ['HarborLore'];
    stMocks.state.world_info = { globalSelect: ['HarborLore'], charLore: [] };
    stMocks.state.worldBooks = new Map([
        [
            'HarborLore',
            {
                entries: {
                    '0': {
                        uid: 0,
                        key: ['harbor'],
                        keysecondary: [],
                        comment: 'Harbor Gate',
                        content: 'Quiet pier at dusk.',
                        constant: false,
                        selective: true,
                        disable: false,
                        position: 0,
                        depth: 4,
                        order: 100,
                        role: 0,
                    },
                },
            },
        ],
    ]);
    stMocks.state.scopedRegex = [];
    stMocks.state.globalRegex = [];
    stMocks.state.presets = new Map([
        ['Default', { temperature: 0.7, max_tokens: 1024 }],
        ['Creative', { temperature: 1.1, max_tokens: 2048 }],
    ]);
    stMocks.state.selectedPresetName = 'Default';
    stMocks.state.registeredSlashCommands = {};
    stMocks.state.registeredMacros.clear();
    stMocks.state.is_send_press = false;

    vi.clearAllMocks();
}

describe('STHostBridge author & admin integration', () => {
    beforeEach(() => {
        resetStState();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('exposes STAuthorBridge (.author) and STAdminBridge (.admin) on STHostBridge', async () => {
        const bridge = new STHostBridge();
        expect(bridge.author).toBeInstanceOf(STAuthorBridge);
        expect(bridge.admin).toBeInstanceOf(STAdminBridge);

        const active = await bridge.author.getActiveCharacterFull();
        expect(active?.name).toBe('Alice');
        expect(active?.primaryWorld).toBe('HarborLore');

        const worlds = await bridge.admin.listAllWorldNames();
        expect(worlds).toEqual(['ArchiveBook', 'HarborLore']);
    });
});

describe('STAuthorBridge', () => {
    beforeEach(() => {
        resetStState();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('patches active character via /api/characters/merge-attributes and synchronizes all 3 memory/UI mirrors', async () => {
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => 'OK',
        }));
        vi.stubGlobal('fetch', fetchMock);

        // Provide a minimal #form_create DOM mirror to verify 3rd mirror sync.
        const formInputs: Record<string, { value: string }> = {
            '[name="avatar_url"]': { value: 'alice.png' },
            '[name="ch_name"]': { value: 'Alice' },
            '[name="description"]': { value: 'Old description' },
            '[name="creator_notes"]': { value: 'Initial note' },
            '[name="json_data"]': { value: '{}' },
        };
        const fakeForm = {
            querySelector: (selector: string) => formInputs[selector] ?? null,
        };
        vi.stubGlobal('document', {
            querySelector: (selector: string) => (selector === '#form_create' ? fakeForm : null),
        });

        const author = new STAuthorBridge();
        const updated = await author.patchActiveCharacter({
            name: 'Alice Vance',
            description: 'Updated harbor investigator',
            creator_notes: 'Revised author note',
            extensions: { custom_flag: 42 },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('/api/characters/merge-attributes');
        expect(init.method).toBe('POST');
        expect(init.headers).toEqual({
            'Content-Type': 'application/json',
            'X-CSRF-Token': 'csrf-test',
        });
        const sentBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(sentBody.avatar).toBe('alice.png');
        expect(sentBody.name).toBe('Alice Vance');
        expect(sentBody.creatorcomment).toBe('Revised author note');
        expect((sentBody.data as Record<string, unknown>).description).toBe('Updated harbor investigator');

        // Mirror 1: characters[chid] top-level v1 + json_data
        const liveChar = stMocks.state.characters[0]!;
        expect(liveChar.name).toBe('Alice Vance');
        expect(liveChar.description).toBe('Updated harbor investigator');
        expect(liveChar.creatorcomment).toBe('Revised author note');
        const parsedJsonData = JSON.parse(String(liveChar.json_data)) as {
            name: string;
            data: { description: string; extensions: Record<string, unknown> };
        };
        expect(parsedJsonData.name).toBe('Alice Vance');
        expect(parsedJsonData.data.description).toBe('Updated harbor investigator');
        expect(parsedJsonData.data.extensions.untouched_ext).toEqual({ keep: true });
        expect(parsedJsonData.data.extensions.custom_flag).toBe(42);

        // Mirror 2: characters[chid].data v2
        const liveData = liveChar.data as Record<string, unknown>;
        expect(liveData.name).toBe('Alice Vance');
        expect(liveData.description).toBe('Updated harbor investigator');
        expect(liveData.creator_notes).toBe('Revised author note');
        expect((liveData.extensions as Record<string, unknown>).untouched_ext).toEqual({ keep: true });
        expect((liveData.extensions as Record<string, unknown>).custom_flag).toBe(42);

        // Mirror 3: #form_create UI inputs + chat_metadata + CHARACTER_EDITED event
        expect(formInputs['[name="ch_name"]']!.value).toBe('Alice Vance');
        expect(formInputs['[name="description"]']!.value).toBe('Updated harbor investigator');
        expect(formInputs['[name="creator_notes"]']!.value).toBe('Revised author note');
        expect(formInputs['[name="json_data"]']!.value).toContain('Updated harbor investigator');
        expect(stMocks.state.chat_metadata.character_name).toBe('Alice Vance');
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_EDITED,
            expect.objectContaining({ detail: expect.objectContaining({ id: 0 }) }),
        );

        expect(updated.name).toBe('Alice Vance');
        expect(updated.description).toBe('Updated harbor investigator');
    });

    it('toggles chat message hidden state, updates DOM attribute, and saves chat', async () => {
        const setAttribute = vi.fn();
        vi.stubGlobal('document', {
            querySelector: (selector: string) =>
                selector === '#chat .mes[mesid="0"]' ? { setAttribute } : null,
        });

        const author = new STAuthorBridge();
        const ok = await author.toggleChatMessageHidden(0, true);
        expect(ok).toBe(true);
        expect(stMocks.state.chat[0]!.is_system).toBe(true);
        expect(setAttribute).toHaveBeenCalledWith('is_system', 'true');
        expect(stMocks.fns.saveChatDebounced).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 0);

        const missing = await author.toggleChatMessageHidden(99, true);
        expect(missing).toBe(false);
    });

    it('creates chat messages (append, middle insert, pagination-window insert, rawFields) without reloading chat or triggering CHARACTER_MESSAGE_RENDERED', async () => {
        const bridge = new STHostBridge();

        // 1. Append assistant message in headless mode
        const appended = await bridge.createChatMessage({
            role: 'assistant',
            content: '灯塔的油灯还亮着。',
        });
        expect(appended.id).toBe(1);
        expect(appended.name).toBe('Alice');
        expect(appended.isUser).toBe(false);
        expect(appended.isSystem).toBe(false);
        expect(stMocks.state.chat).toHaveLength(2);
        expect(stMocks.state.chat_metadata.tainted).toBe(true);
        expect(stMocks.fns.addOneMessage).toHaveBeenCalledWith(
            expect.objectContaining({ mes: '灯塔的油灯还亮着。', name: 'Alice', is_user: false }),
            expect.objectContaining({ scroll: true, showSwipes: true }),
        );
        expect(stMocks.fns.saveChatDebounced).toHaveBeenCalled();
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.MESSAGE_RECEIVED,
            1,
            'extension',
        );
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            expect.anything(),
        );

        // 2. Append user message emits MESSAGE_SENT
        const userCreated = await bridge.createChatMessage({
            role: 'user',
            content: '我们走吧。',
        });
        expect(userCreated.id).toBe(2);
        expect(userCreated.name).toBe('Tester');
        expect(userCreated.isUser).toBe(true);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_SENT, 2);

        // 3. Middle insert when rendered DOM anchor exists calls insertBefore + updateViewMessageIds
        vi.clearAllMocks();
        const mes0 = { getAttribute: (k: string) => (k === 'mesid' ? '0' : null) };
        const mes1 = { getAttribute: (k: string) => (k === 'mesid' ? '1' : null) };
        vi.stubGlobal('document', {
            querySelector: (selector: string) =>
                selector === '#chat .mes[mesid="1"]' ? mes1 : null,
            querySelectorAll: (selector: string) =>
                selector === '#chat .mes' ? [mes0, mes1] : [],
        });

        const midInserted = await bridge.createChatMessage({
            role: 'system',
            content: '旁白：海风骤起。',
            insertAt: 1,
        });
        expect(midInserted.id).toBe(1);
        expect(midInserted.isSystem).toBe(true);
        expect(stMocks.state.chat[1]!.mes).toBe('旁白：海风骤起。');
        expect(stMocks.fns.addOneMessage).toHaveBeenCalledWith(
            expect.objectContaining({ mes: '旁白：海风骤起。', is_system: true }),
            expect.objectContaining({ insertBefore: 1, forceId: 1, scroll: false }),
        );
        expect(stMocks.fns.updateViewMessageIds).toHaveBeenCalledWith(0);

        // 4. Insert above ST pagination window (firstDisplayedId = 2, insertAt = 0) shifts rendered IDs without appending DOM node
        vi.clearAllMocks();
        const mes2 = { getAttribute: (k: string) => (k === 'mesid' ? '2' : null) };
        vi.stubGlobal('document', {
            querySelector: () => null,
            querySelectorAll: (selector: string) =>
                selector === '#chat .mes' ? [mes2] : [],
        });
        const aboveWindow = await bridge.createChatMessage({
            role: 'assistant',
            content: '序幕',
            insertAt: 0,
            rawFields: {
                name: 'CustomSpeaker',
                is_user: false,
                is_system: false,
                mes: '序幕',
                force_avatar: 'custom.png',
                swipe_id: 0,
                swipes: ['序幕'],
            },
        });
        expect(aboveWindow.id).toBe(0);
        expect((stMocks.state.chat[0] as Record<string, unknown>).force_avatar).toBe('custom.png');
        expect(stMocks.fns.addOneMessage).not.toHaveBeenCalled();
        expect(stMocks.fns.updateViewMessageIds).toHaveBeenCalledWith(3);
    });

    it('deletes chat messages via native deleteMessage when in DOM and splices cleanly when off-DOM or emitEvent=false', async () => {
        stMocks.state.chat.push(
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: '第二条回复',
                swipe_id: 0,
                swipes: ['第二条回复'],
                force_avatar: 'alice_alt.png',
            },
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: '第三条发言',
                swipe_id: 0,
                swipes: ['第三条发言'],
            },
        );
        const bridge = new STHostBridge();

        // 1. In-DOM deletion delegates to native deleteMessage(1, undefined, false, false)
        const mes1El = { getAttribute: (k: string) => (k === 'mesid' ? '1' : null), remove: vi.fn() };
        vi.stubGlobal('document', {
            querySelector: (selector: string) =>
                selector === '#chat .mes[mesid="1"]' ? mes1El : null,
            querySelectorAll: () => [mes1El],
        });

        const deletedInDom = await bridge.deleteChatMessage(1);
        expect(deletedInDom?.messageId).toBe(1);
        expect(deletedInDom?.snapshot.mes).toBe('第二条回复');
        expect(deletedInDom?.rawMessage?.force_avatar).toBe('alice_alt.png');
        expect(stMocks.fns.deleteMessage).toHaveBeenCalledWith(1, undefined, false, false);
        expect(stMocks.state.chat).toHaveLength(2);

        // 2. Off-DOM / paginated deletion (firstDisplayedId = 1, delete index 0) splices & shifts rendered IDs down
        vi.clearAllMocks();
        const mes1After = { getAttribute: (k: string) => (k === 'mesid' ? '1' : null), remove: vi.fn() };
        vi.stubGlobal('document', {
            querySelector: () => null,
            querySelectorAll: (selector: string) =>
                selector === '#chat .mes' ? [mes1After] : [],
        });

        const deletedOffDom = await bridge.deleteChatMessage(0, { emitEvent: false });
        expect(deletedOffDom?.snapshot.mes).toBe('今晚我们去老码头灯塔看看');
        expect(stMocks.fns.deleteMessage).not.toHaveBeenCalled();
        expect(stMocks.state.chat).toHaveLength(1);
        expect(stMocks.fns.updateViewMessageIds).toHaveBeenCalledWith(0);
        expect(stMocks.fns.refreshSwipeButtons).toHaveBeenCalled();
        expect(stMocks.fns.saveChatDebounced).toHaveBeenCalled();
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalled();

        // 3. Out-of-bounds returns null
        expect(await bridge.deleteChatMessage(99)).toBeNull();
    });

    it('preserves raw @@ decorators and <% ... %> EJS verbatim in World Info upsert & delete', async () => {
        const author = new STAuthorBridge();
        const rawAuthorContent = [
            '@@system',
            '@@trigger before_turn',
            '<% if (vars.alertLevel > 2) { %>',
            'Patrols double around the lighthouse.',
            '<% } %>',
        ].join('\n');

        const saved = await author.upsertWorldInfoEntry('HarborLore', {
            comment: 'Lighthouse Trigger',
            keys: ['lighthouse', 'patrol'],
            content: rawAuthorContent,
            constant: true,
            order: 150,
        });

        expect(saved.content).toBe(rawAuthorContent);
        expect(saved.content).not.toContain('\\@@');
        expect(stMocks.fns.saveWorldInfo).toHaveBeenCalledWith('HarborLore', expect.anything(), true);

        const persistedBook = await author.readWorldInfoBook('HarborLore');
        const readBack = persistedBook?.entries.find((e) => e.uid === saved.uid);
        expect(readBack?.content).toBe(rawAuthorContent);

        const deleted = await author.deleteWorldInfoEntry('HarborLore', saved.uid);
        expect(deleted).toBe(true);
        const afterDelete = await author.readWorldInfoBook('HarborLore');
        expect(afterDelete?.entries.find((e) => e.uid === saved.uid)).toBeUndefined();
    });

    it('hardens STHostBridge.substituteMacros with pre-substituted lastGenerationType, options dynamicMacros, and single-pass fallback', () => {
        const bridge = new STHostBridge();
        let capturedText = '';
        let capturedOptions: unknown;

        stMocks.fns.substituteParams.mockImplementationOnce((...args: unknown[]) => {
            capturedText = String(args[0] ?? '');
            capturedOptions = args[1];
            // Simulate a host environment that overwrites {{lastGenerationType}} if still present
            // and leaves unknown/mock tokens intact.
            return capturedText.replace(/\{\{lastGenerationType\}\}/gi, 'host-clobbered');
        });

        const output = bridge.substituteMacros(
            'gen={{LASTGENERATIONTYPE}}|u={{LASTUSERMESSAGE}}|st={{stLastUserMessage}}|v={{getvar::coin}}',
            {
                lastGenerationType: 'regenerate',
                lastUserMessage: 'Literal {{model}} inside user input',
                model: 'gpt-4.1',
                stLastUserMessage: 'Main Chat User',
                'var:coin': '55',
            },
        );

        expect(capturedText).toContain('gen=regenerate|');
        expect(capturedOptions).toEqual({
            dynamicMacros: {
                lastUserMessage: 'Literal {{model}} inside user input',
                model: 'gpt-4.1',
                stLastUserMessage: 'Main Chat User',
            },
        });
        expect(output).toBe(
            'gen=regenerate|u=Literal {{model}} inside user input|st=Main Chat User|v=55',
        );
    });

    it('expands auto-prompt macros via single-pass post-substitution without leaking into dynamicMacros or re-evaluating inner tokens', () => {
        const bridge = new STHostBridge({
            resolveFileMacroSync: (filePath) => `[FILE:${filePath}]`,
        });
        let capturedOptions: unknown;

        stMocks.fns.substituteParams.mockImplementationOnce((...args: unknown[]) => {
            capturedOptions = args[1];
            return String(args[0] ?? '');
        });

        const manifestPayload =
            '<core-manifest>\n- {{user}} literal\n- {{file::/secret.md}}\n</core-manifest>';

        const output = bridge.substituteMacros(
            'slot={{coreManifest}}|alias={{core-manifest}}|user={{lastUserMessage}}',
            {
                coreManifest: manifestPayload,
                'core-manifest': manifestPayload,
                lastUserMessage: 'User wrote {{coreManifest}} and {{loreHint}}',
                loreHint: '<lore-hint>ignored</lore-hint>',
            },
        );

        // Auto-prompt aliases must NOT be passed into dynamicMacros
        expect(capturedOptions).toEqual({
            dynamicMacros: {
                lastUserMessage: 'User wrote {{coreManifest}} and {{loreHint}}',
            },
        });
        // Single-pass post-substitution:
        // - {{coreManifest}} and {{core-manifest}} expand to manifestPayload verbatim (without expanding {{user}} or {{file::/secret.md}} inside it)
        // - {{loreHint}} was not referenced in the template, so literal {{loreHint}} inside lastUserMessage stays intact
        expect(output).toBe(
            `slot=${manifestPayload}|alias=${manifestPayload}|user=User wrote {{coreManifest}} and {{loreHint}}`,
        );
    });

    it('lists and saves scoped regex via SCRIPT_TYPES.SCOPED and embeds agentic payload', async () => {
        const settings = createDefaultSettings();
        const bridge = new STHostBridge({ getSettings: () => settings });
        const author = bridge.author;

        const scripts = [
            {
                id: 'rx-1',
                scriptName: 'Strip OOC',
                findRegex: '/\\(OOC:.*?\\)/g',
                replaceString: '',
                placement: [2],
            },
        ];
        await author.saveScopedRegex(scripts);
        const expectedScoped = [
            {
                ...scripts[0]!,
                trimStrings: [],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            },
        ];
        expect(stMocks.fns.saveScriptsByType).toHaveBeenCalledWith(expectedScoped, 1);

        const listed = await author.listScopedRegex();
        expect(listed).toEqual(expectedScoped);

        const embedRes = await author.embedAgenticPayload({
            includePreset: true,
            includeFiles: true,
            files: { 'notes.md': 'Clue notes' },
        });
        expect(embedRes.ok).toBe(true);
        expect(embedRes.embeddedPresets).toBe(1);
        expect(embedRes.embeddedFiles).toBe(1);
        const liveExt = (stMocks.state.characters[0]!.data as { extensions: Record<string, unknown> })
            .extensions;
        expect(liveExt.agentic_embed_presets).toBeDefined();
        expect(liveExt.agentic_embed_files).toBeDefined();
    });
});

describe('STAdminBridge', () => {
    beforeEach(() => {
        resetStState();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('manages global World Info library, characters, personas, presets, settings, global regex, slash, and URL import', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url === '/api/characters/create') {
                stMocks.state.characters.push({
                    name: 'Lin Wan',
                    avatar: 'lin_wan.png',
                    description: 'Encrypted courier',
                    data: { name: 'Lin Wan', description: 'Encrypted courier', extensions: {} },
                });
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    text: async (): Promise<string> => 'lin_wan.png',
                };
            }
            if (url === '/api/content/importURL') {
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: {
                        get: (name: string): string | null => {
                            if (name.toLowerCase() === 'x-custom-content-type') return 'lorebook';
                            if (name.toLowerCase() === 'content-disposition') {
                                return 'attachment; filename="imported_harbor.json"';
                            }
                            return null;
                        },
                    },
                    text: async (): Promise<string> => '{}',
                };
            }
            return { ok: true, status: 200, statusText: 'OK', text: async (): Promise<string> => 'OK' };
        });
        vi.stubGlobal('fetch', fetchMock);

        const admin = new STAdminBridge();

        // 1. World Info
        const createdBook = await admin.createWorldBook('SecretLore');
        expect(createdBook.name).toBe('SecretLore');
        await admin.bindWorldBook('SecretLore', true);
        expect(stMocks.state.selected_world_info).toContain('SecretLore');
        await admin.bindWorldBook('SecretLore', false);
        expect(stMocks.state.selected_world_info).not.toContain('SecretLore');

        // 2. Characters
        const newChar = await admin.createCharacter({
            name: 'Lin Wan',
            description: 'Encrypted courier',
        });
        expect(newChar.avatar).toBe('lin_wan.png');
        const allChars = await admin.listAllCharacters();
        expect(allChars.map((c) => c.name)).toEqual(['Alice', 'Lin Wan']);
        await admin.selectCharacterById(1);
        expect(stMocks.state.this_chid).toBe(1);
        expect(await admin.deleteCharacterById(1)).toBe(true);
        expect(stMocks.state.characters).toHaveLength(1);

        // 3. Personas & Presets
        const upsertedPersona = await admin.upsertPersona('spy.png', 'Undercover agent', 'Agent X');
        expect(upsertedPersona.description).toBe('Undercover agent');
        await admin.selectPersona('spy.png');
        expect(stMocks.state.user_avatar).toBe('spy.png');
        const personas = await admin.listPersonas();
        expect(personas.find((p) => p.key === 'spy.png')?.active).toBe(true);

        const presets = await admin.listPresets('openai');
        expect(presets.map((p) => p.name)).toEqual(['Default', 'Creative']);
        await admin.selectPreset('Creative', 'openai');
        expect(stMocks.state.selectedPresetName).toBe('Creative');
        const patchedPreset = await admin.patchPreset('Creative', { temperature: 0.95 }, 'openai');
        expect(patchedPreset.data?.temperature).toBe(0.95);

        // 4. Settings, Global Regex, Slash & Import URL
        const patchedPower = await admin.patchHostSettings('power_user', { fast_ui_mode: true });
        expect(patchedPower.fast_ui_mode).toBe(true);
        const allSettings = await admin.readHostSettings('all');
        expect((allSettings.power_user as Record<string, unknown>).fast_ui_mode).toBe(true);

        const globalScripts = [
            { id: 'gr-1', scriptName: 'Global Rule', findRegex: '/foo/g', replaceString: 'bar' },
        ];
        await admin.saveGlobalRegex(globalScripts);
        const expectedGlobal = [
            {
                ...globalScripts[0]!,
                trimStrings: [],
                placement: [],
                disabled: false,
                markdownOnly: false,
                promptOnly: false,
                runOnEdit: false,
                substituteRegex: 0,
                minDepth: null,
                maxDepth: null,
            },
        ];
        expect(stMocks.fns.saveScriptsByType).toHaveBeenCalledWith(expectedGlobal, 0);
        expect(await admin.listGlobalRegex()).toEqual(expectedGlobal);

        const slashOut = await admin.executeSlashCommand('/echo hi');
        expect(slashOut).toBe('ran:/echo hi');

        const importRes = await admin.importFromUrl('https://example.com/harbor.json');
        expect(importRes.ok).toBe(true);
        expect(importRes.importedType).toBe('worldinfo');
        expect(importRes.name).toBe('imported_harbor.json');
    });
});

describe('Companion Hooks /side/* Bridge & Zero-Residue Cleanup', () => {
    beforeEach(() => {
        resetStState();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('injects matched radar_hint + unconsumed next_turn_brief into agentic_side_bridge, resolves {{file::/side/...}}, and clears on runMode=off and dispose', async () => {
        const settings: Settings = {
            ...createDefaultSettings(),
            runMode: 'companion',
        };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const store = new ChatDataStore(bridge);
        bridge.setStore(store);
        const vfs = new VirtualFileSystem({ bridge, store });

        const target = { messageId: 0, swipeId: 0 };
        await vfs.writeSideClue(
            {
                path: '/side/comms/linwan.md',
                title: '林晚的加密通讯线索',
                delivery: 'radar_hint',
                keywords: ['老码头', '灯塔'],
                summary: '林晚已在老码头旧仓库灯塔下接应，东区巡逻 21:30 换防。',
                body: '- [18:11 林晚]: 我在旧仓库灯塔下等你。',
            },
            { target, staged: false },
        );
        await vfs.writeSideClue(
            {
                path: '/side/rumors/harbor_brief.md',
                title: '港口临时封锁',
                delivery: 'next_turn_brief',
                summary: '港口东区刚刚发布临时宵禁令。',
                body: '巡逻队已经封锁东区入口。',
            },
            { target, staged: false },
        );
        await vfs.writeSideClue(
            {
                path: '/side/notes/hidden.md',
                title: '完全隔离笔记',
                delivery: 'none',
                keywords: ['老码头'],
                summary: '绝不可注入主线',
                body: 'secret',
            },
            { target, staged: false },
        );

        const appListeners = new Set<() => void>();
        const mockAppStore = {
            getSnapshot: () => ({ settings }),
            subscribe: (fn: () => void) => {
                appListeners.add(fn);
                return () => appListeners.delete(fn);
            },
            setActiveTarget: vi.fn(),
        };

        const mockOrchestrator = {
            store,
            vfs,
            barrierCoordinator: {
                awaitTurnBarriers: vi.fn(async () => undefined),
                abortFromMessage: vi.fn(),
                abortTarget: vi.fn(),
            },
            decoratorCompiler: {
                compile: vi.fn(() => ({ triggers: [] })),
            },
            rerunAfterTurn: vi.fn(async () => []),
            trajectoryStore: {
                listInterruptedCheckpoints: vi.fn(() => new Map()),
                pruneFromMessage: vi.fn(() => 0),
                pruneSwipe: vi.fn(() => 0),
                saveToHost: vi.fn(),
            },
        } as unknown as PipelineOrchestrator;

        const handle = setupCompanionHooks({
            bridge,
            orchestrator: mockOrchestrator,
            getSettings: () => settings,
            getAppStore: () => mockAppStore as unknown as never,
        });

        // 1. {{file::/side/...}} resolves cleanly synchronously
        const resolved = handle.resolveVfsFileSync('/side/comms/linwan.md', target);
        expect(resolved).toContain('林晚的加密通讯线索');
        expect(resolved).toContain('旧仓库灯塔下等你');

        // 2. GENERATION_AFTER_COMMANDS injects radar_hint + next_turn_brief into agentic_side_bridge
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);

        const sideBridgeCalls = stMocks.fns.setExtensionPrompt.mock.calls.filter(
            (call) => call[0] === COMPANION_SIDE_BRIDGE_PROMPT_KEY,
        );
        expect(sideBridgeCalls.length).toBeGreaterThanOrEqual(1);
        const injectedCall = sideBridgeCalls[sideBridgeCalls.length - 1]!;
        const injectedContent = String(injectedCall[1]);
        expect(injectedCall[2]).toBe(1); // extension_prompt_types.IN_CHAT
        expect(injectedCall[3]).toBe(0);
        expect(injectedContent).toContain('<side-brief>');
        expect(injectedContent).toContain('港口临时封锁');
        expect(injectedContent).toContain('<side-hint>');
        expect(injectedContent).toContain('/side/comms/linwan.md');
        expect(injectedContent).toContain('林晚已在老码头旧仓库灯塔下接应');
        expect(injectedContent).not.toContain('绝不可注入主线');

        // 3. CHARACTER_MESSAGE_RENDERED marks next_turn_brief consumed & clears prompt
        stMocks.state.chat.push({
            name: 'Alice',
            is_user: false,
            is_system: false,
            mes: '我们出发去灯塔吧。',
            swipe_id: 0,
            swipes: ['我们出发去灯塔吧。'],
        });
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 1);
        expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
            COMPANION_SIDE_BRIDGE_PROMPT_KEY,
            '',
            1,
            0,
            false,
            0,
        );
        const briefAfter = await vfs.readSideClue('/side/rumors/harbor_brief.md', {
            messageId: 1,
            swipeId: 0,
        });
        expect(briefAfter?.meta.status).toBe('surfaced');
        expect(briefAfter?.meta.consumedByTurn).toBe(2);

        // 4. Switching runMode to 'off' immediately clears agentic_side_bridge via AppStore subscription
        stMocks.fns.setExtensionPrompt.mockClear();
        settings.runMode = 'off';
        for (const listener of appListeners) {
            listener();
        }
        expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
            COMPANION_SIDE_BRIDGE_PROMPT_KEY,
            '',
            1,
            0,
            false,
            0,
        );
        expect(handle.resolveVfsFileSync('/side/comms/linwan.md', target)).toBe('');

        // 5. GENERATION_AFTER_COMMANDS in 'off' mode also explicitly clears agentic_side_bridge
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
            COMPANION_SIDE_BRIDGE_PROMPT_KEY,
            '',
            1,
            0,
            false,
            0,
        );

        // 6. Teardown dispose() also explicitly clears agentic_side_bridge
        stMocks.fns.setExtensionPrompt.mockClear();
        handle.dispose();
        expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
            COMPANION_SIDE_BRIDGE_PROMPT_KEY,
            '',
            1,
            0,
            false,
            0,
        );
    });

    it('matches /side/* radar_hint clues against pending #send_textarea input on normal GENERATION_AFTER_COMMANDS before chat[] updates', async () => {
        // Real ST fires GENERATION_AFTER_COMMANDS before sendMessageAsUser() pushes the
        // #send_textarea prompt onto chat[]. Keep chat[] free of '旧灯塔' initially.
        stMocks.state.chat = [
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: '我们刚从老码头回来。',
                swipe_id: 0,
                swipes: ['我们刚从老码头回来。'],
            },
        ];

        const settings: Settings = {
            ...createDefaultSettings(),
            runMode: 'companion',
        };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const store = new ChatDataStore(bridge);
        bridge.setStore(store);
        const vfs = new VirtualFileSystem({ bridge, store });

        const target = { messageId: 0, swipeId: 0 };
        await vfs.writeSideClue(
            {
                path: '/side/rumors/lighthouse.md',
                title: '旧灯塔异响传闻',
                delivery: 'radar_hint',
                keywords: ['旧灯塔'],
                summary: '午夜旧灯塔曾出现神秘信号灯',
                body: '码头守夜人报告称，午夜时分旧灯塔顶层闪过三短三长的神秘信号灯。',
                status: 'dormant',
            },
            { target, staged: false },
        );

        const sendTextarea = { value: '听说旧灯塔那边最近有点不对劲。' };
        vi.stubGlobal('document', {
            querySelector: (selector: string) => (selector === '#send_textarea' ? sendTextarea : null),
        });

        const mockOrchestrator = {
            store,
            vfs,
            barrierCoordinator: {
                awaitTurnBarriers: vi.fn(async () => undefined),
                abortFromMessage: vi.fn(),
                abortTarget: vi.fn(),
            },
            decoratorCompiler: {
                compile: vi.fn(() => ({ triggers: [] })),
            },
            rerunAfterTurn: vi.fn(async () => []),
            trajectoryStore: {
                listInterruptedCheckpoints: vi.fn(() => new Map()),
                pruneFromMessage: vi.fn(() => 0),
                pruneSwipe: vi.fn(() => 0),
                saveToHost: vi.fn(),
            },
        } as unknown as PipelineOrchestrator;

        const handle = setupCompanionHooks({
            bridge,
            orchestrator: mockOrchestrator,
            getSettings: () => settings,
        });

        const getLastSideBridgePrompt = () => {
            const calls = stMocks.fns.setExtensionPrompt.mock.calls.filter(
                (call) => call[0] === COMPANION_SIDE_BRIDGE_PROMPT_KEY,
            );
            return calls.length > 0 ? String(calls[calls.length - 1]![1]) : '';
        };

        // 1. Normal generation (explicit 'normal' and default undefined) matches pending #send_textarea
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        const normalPrompt = getLastSideBridgePrompt();
        expect(normalPrompt).toContain('<side-hint>');
        expect(normalPrompt).toContain('旧灯塔异响传闻');
        expect(normalPrompt).toContain('午夜旧灯塔曾出现神秘信号灯');
        expect(normalPrompt).toContain('/side/rumors/lighthouse.md');

        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, undefined, {}, false);
        expect(getLastSideBridgePrompt()).toContain('/side/rumors/lighthouse.md');

        // 2. Non-normal genTypes ('swipe', 'regenerate', 'impersonate') must ignore unsent #send_textarea drafts
        for (const nonNormalType of ['swipe', 'regenerate', 'impersonate'] as const) {
            stMocks.fns.setExtensionPrompt.mockClear();
            await stMocks.eventSource.emit(
                stMocks.event_types.GENERATION_AFTER_COMMANDS,
                nonNormalType,
                {},
                false,
            );
            expect(getLastSideBridgePrompt()).toBe('');
        }

        // 3. Manual syncSideBridgePrompt() must also ignore unsent #send_textarea drafts
        stMocks.fns.setExtensionPrompt.mockClear();
        const syncedPrompt = await handle.syncSideBridgePrompt(target);
        expect(syncedPrompt).toBe('');

        // 4. First turn when chat[] is empty still matches pending #send_textarea on normal send
        stMocks.state.chat = [];
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        expect(getLastSideBridgePrompt()).toContain('/side/rumors/lighthouse.md');

        // 5. After sendMessageAsUser() pushes the prompt onto chat[] and clears #send_textarea,
        //    subsequent scans still match cleanly without stale or duplicate text
        stMocks.state.chat = [
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: '听说旧灯塔那边最近有点不对劲。',
                swipe_id: 0,
                swipes: ['听说旧灯塔那边最近有点不对劲。'],
            },
        ];
        sendTextarea.value = '';
        stMocks.fns.setExtensionPrompt.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
        const afterClearPrompt = getLastSideBridgePrompt();
        expect(afterClearPrompt).toContain('/side/rumors/lighthouse.md');
        expect(afterClearPrompt.match(/\/side\/rumors\/lighthouse\.md/g)).toHaveLength(1);

        handle.dispose();
    });

    it('skips auto-triggering after_turn on floor #0 initial greeting while allowing normal turns (>= #1)', async () => {
        stMocks.state.chat = [
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: '欢迎来到港湾镇。',
                swipe_id: 0,
                swipes: ['欢迎来到港湾镇。'],
            },
        ];

        const settings: Settings = {
            ...createDefaultSettings(),
            runMode: 'companion',
        };
        const bridge = new STHostBridge({ getSettings: () => settings });
        const store = new ChatDataStore(bridge);
        bridge.setStore(store);
        const vfs = new VirtualFileSystem({ bridge, store });

        const rerunAfterTurn = vi.fn(async () => []);
        const mockOrchestrator = {
            store,
            vfs,
            barrierCoordinator: {
                awaitTurnBarriers: vi.fn(async () => undefined),
                abortFromMessage: vi.fn(),
                abortTarget: vi.fn(),
            },
            decoratorCompiler: {
                compile: vi.fn(() => ({ triggers: [] })),
            },
            rerunAfterTurn,
            trajectoryStore: {
                listInterruptedCheckpoints: vi.fn(() => new Map()),
                pruneFromMessage: vi.fn(() => 0),
                pruneSwipe: vi.fn(() => 0),
                saveToHost: vi.fn(),
            },
        } as unknown as PipelineOrchestrator;

        const handle = setupCompanionHooks({
            bridge,
            orchestrator: mockOrchestrator,
            getSettings: () => settings,
        });

        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 0, 'first_message');
        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 0);
        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 0, 'regenerate');
        expect(rerunAfterTurn).not.toHaveBeenCalled();

        stMocks.state.chat.push(
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: '你好，爱丽丝。',
                swipe_id: 0,
                swipes: ['你好，爱丽丝。'],
            },
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: '很高兴见到你！',
                swipe_id: 0,
                swipes: ['很高兴见到你！'],
            },
        );

        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 2, 'normal');
        expect(rerunAfterTurn).toHaveBeenCalledTimes(1);
        expect(rerunAfterTurn).toHaveBeenCalledWith(
            { messageId: 2, swipeId: 0 },
            { turnNumber: 3 },
        );

        handle.dispose();
    });

    it('excludes ST-Agentic control decorators & strips @@system in WORLDINFO_ENTRIES_LOADED across off, companion, and takeover-passthrough modes', async () => {
        stMocks.state.chat = [
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: 'Hello',
                swipe_id: 0,
                swipes: ['Hello'],
            },
        ];

        const settings: Settings = createDefaultSettings({ runMode: 'off' });
        const bridge = new STHostBridge({ getSettings: () => settings });
        const store = new ChatDataStore(bridge);
        bridge.setStore(store);
        const vfs = new VirtualFileSystem({ bridge, store });
        store.set(
            DATA_NAMESPACES.WORLDINFO,
            'LoreBook/10',
            '/lorebooks/LoreBook/Normal-10.md',
            'Companion overridden content',
            { target: { messageId: 0, swipeId: 0 } },
        );

        const mockOrchestrator = {
            store,
            vfs,
            barrierCoordinator: {
                awaitTurnBarriers: vi.fn(async () => undefined),
                abortFromMessage: vi.fn(),
                abortTarget: vi.fn(),
            },
            decoratorCompiler: {
                compile: vi.fn(() => ({ triggers: [] })),
            },
            rerunAfterTurn: vi.fn(async () => []),
            trajectoryStore: {
                listInterruptedCheckpoints: vi.fn(() => new Map()),
                pruneFromMessage: vi.fn(() => 0),
                pruneSwipe: vi.fn(() => 0),
                saveToHost: vi.fn(),
            },
        } as unknown as PipelineOrchestrator;

        const handle = setupCompanionHooks({
            bridge,
            orchestrator: mockOrchestrator,
            getSettings: () => settings,
        });

        const buildPayload = () => ({
            globalLore: [
                { uid: 1, world: 'LoreBook', comment: 'Vars', content: '@@variables_json\nhp: 10' },
                { uid: 2, world: 'LoreBook', comment: 'EJS', content: '@@evaluate_ejs_before\n<% 1 %>' },
                { uid: 3, world: 'LoreBook', comment: 'Tool', content: '@@tool my_tool\nreturn 1;' },
                { uid: 4, world: 'LoreBook', comment: 'Plain', content: 'Normal lore about harbor' },
                { uid: 5, world: 'LoreBook', comment: '[InitVar] Stats', content: 'hp: 100' },
            ],
            characterLore: [
                { uid: 6, world: 'LoreBook', comment: 'CondTrig', content: '@@if vars.x\n@@trigger phase=after\nRun' },
                { uid: 7, world: 'LoreBook', comment: 'Group', content: '@@group g1\nMerged' },
                { uid: 8, world: 'LoreBook', comment: 'Schema', content: '@@zod_schema z.object({ a: z.string() })' },
                { uid: 9, world: 'LoreBook', comment: 'Sys', content: '@@system\nAlways follow rules.' },
                { uid: 10, world: 'LoreBook', comment: 'Normal', content: 'Original normal lore' },
            ],
            chatLore: [],
            personaLore: [
                { uid: 11, world: 'LoreBook', comment: 'CondSys', content: '@@if vars.ok\n@@system\nConditioned rule' },
            ],
        });

        // 1. runMode === 'off': control entries removed, @@system stripped cleanly without mutating originals, NO VFS override
        const offPayload = buildPayload();
        const originalSysRef = offPayload.characterLore[3];
        const originalNormalRef = offPayload.characterLore[4];
        await stMocks.eventSource.emit(stMocks.event_types.WORLDINFO_ENTRIES_LOADED, offPayload);

        expect(offPayload.globalLore.map((e) => e.uid)).toEqual([4]);
        expect(offPayload.characterLore.map((e) => e.uid)).toEqual([9, 10]);
        expect(offPayload.characterLore[0]?.content).toBe('Always follow rules.');
        expect(offPayload.characterLore[1]?.content).toBe('Original normal lore');
        expect(originalSysRef?.content).toBe('@@system\nAlways follow rules.');
        expect(originalNormalRef?.content).toBe('Original normal lore');
        expect(offPayload.personaLore[0]?.content).toBe('@@if vars.ok\nConditioned rule');

        // 2. runMode === 'companion': control entries removed, @@system stripped, AND VFS overrides applied on shallow clone
        settings.runMode = 'companion';
        const compPayload = buildPayload();
        const compNormalOriginal = compPayload.characterLore[4];
        await stMocks.eventSource.emit(stMocks.event_types.WORLDINFO_ENTRIES_LOADED, compPayload);

        expect(compPayload.globalLore.map((e) => e.uid)).toEqual([4]);
        expect(compPayload.characterLore.map((e) => e.uid)).toEqual([9, 10]);
        expect(compPayload.characterLore[0]?.content).toBe('Always follow rules.');
        expect(compPayload.characterLore[1]?.content).toBe('Companion overridden content');
        expect(compNormalOriginal?.content).toBe('Original normal lore');

        // 3. runMode === 'takeover' during group-chat passthrough: still filters ST-Agentic decorators instead of leaking!
        settings.runMode = 'takeover';
        stMocks.state.selected_group = 'group-123';
        const groupPayload = buildPayload();
        await stMocks.eventSource.emit(stMocks.event_types.WORLDINFO_ENTRIES_LOADED, groupPayload);

        expect(groupPayload.globalLore.map((e) => e.uid)).toEqual([4]);
        expect(groupPayload.characterLore.map((e) => e.uid)).toEqual([9, 10]);
        expect(groupPayload.characterLore[0]?.content).toBe('Always follow rules.');
        expect(groupPayload.characterLore[1]?.content).toBe('Original normal lore');

        handle.dispose();
    });

    it('clears cached lorebooks via STHostBridge.clearLorebookCache() and reads host send_if_empty safely via getSendIfEmpty()', async () => {
        const bridge = new STHostBridge();
        await bridge.listEnabledLorebooks();
        expect(bridge.getCachedLorebooks().size).toBe(1);

        expect(bridge.clearLorebookCache()).toBe(1);
        expect(bridge.getCachedLorebooks().size).toBe(0);
        expect(bridge.clearLorebookCache()).toBe(0);

        // 1. Returns '' when no host settings exist
        vi.stubGlobal('SillyTavern', undefined);
        vi.stubGlobal('oai_settings', undefined);
        expect(bridge.getSendIfEmpty()).toBe('');

        // 2. Reads trimmed value from SillyTavern.getContext().chatCompletionSettings.send_if_empty
        vi.stubGlobal('SillyTavern', {
            getContext: () => ({
                chatCompletionSettings: { send_if_empty: '  Continue the story.  ' },
            }),
        });
        expect(bridge.getSendIfEmpty()).toBe('Continue the story.');

        // 3. Explicit empty send_if_empty on context does not fall back to stale global/DOM
        vi.stubGlobal('oai_settings', { send_if_empty: 'fallback ignored' });
        vi.stubGlobal('SillyTavern', {
            getContext: () => ({
                chatCompletionSettings: { send_if_empty: '   ' },
            }),
        });
        expect(bridge.getSendIfEmpty()).toBe('');

        // 4. Falls back to globalThis.oai_settings when SillyTavern.getContext() is absent
        vi.stubGlobal('SillyTavern', undefined);
        vi.stubGlobal('oai_settings', { send_if_empty: '  *nods silently*  ' });
        expect(bridge.getSendIfEmpty()).toBe('*nods silently*');

        // 5. Falls back to #send_if_empty_textarea in DOM when settings objects are absent
        vi.stubGlobal('oai_settings', undefined);
        vi.stubGlobal('document', {
            querySelector: (selector: string) =>
                selector === '#send_if_empty_textarea' ? { value: '  DOM fallback  ' } : null,
        });
        expect(bridge.getSendIfEmpty()).toBe('DOM fallback');
    });

    it('detects native generation error in companion mode (lock release, unhandledrejection, and GENERATION_STARTED fallback), cleans staged data/prompts, and emits agentic_generation_error', async () => {
        vi.useFakeTimers();
        try {
            const settings: Settings = createDefaultSettings({ runMode: 'companion' });
            const bridge = new STHostBridge({ getSettings: () => settings });
            const store = new ChatDataStore(bridge);
            bridge.setStore(store);
            const vfs = new VirtualFileSystem({ bridge, store });

            const errorEvents: CompanionGenerationErrorPayload[] = [];
            stMocks.eventSource.on(AGENTIC_GENERATION_ERROR_EVENT, (payload) => {
                errorEvents.push(payload as CompanionGenerationErrorPayload);
            });

            const rollbackSpy = vi.spyOn(store, 'rollbackStagedData');
            const mockOrchestrator = {
                store,
                vfs,
                barrierCoordinator: {
                    awaitTurnBarriers: vi.fn(async () => undefined),
                    abortFromMessage: vi.fn(),
                    abortTarget: vi.fn(),
                },
                decoratorCompiler: {
                    compile: vi.fn(() => ({ triggers: [] })),
                },
                rerunAfterTurn: vi.fn(async () => []),
                trajectoryStore: {
                    listInterruptedCheckpoints: vi.fn(() => new Map()),
                    pruneFromMessage: vi.fn(() => 0),
                    pruneSwipe: vi.fn(() => 0),
                    saveToHost: vi.fn(),
                },
            } as unknown as PipelineOrchestrator;

            const handle = setupCompanionHooks({
                bridge,
                orchestrator: mockOrchestrator,
                getSettings: () => settings,
                errorCheckGraceMs: 40,
                errorCheckPollMs: 30,
            });

            // Scenario 1: ST Generate() acquires lock (is_send_press=true) then hits onError -> unblockGeneration (is_send_press=false) without MESSAGE_RECEIVED/GENERATION_ENDED
            const target1 = { messageId: 1, swipeId: 0 };
            store.set(DATA_NAMESPACES.FILES, 'draft.md', 'before_turn', 'staged-content', {
                target: target1,
                staged: true,
            });
            await vfs.writeFile('/output.md', 'pre-create-buf', { target: target1 });

            stMocks.state.is_send_press = true;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            stMocks.fns.setExtensionPrompt.mockClear();

            // Native ST hits onError -> unblockGeneration sets is_send_press = false without emitting stop/end events
            stMocks.state.is_send_press = false;
            await vi.advanceTimersByTimeAsync(100);

            expect(errorEvents).toHaveLength(1);
            expect(errorEvents[0]).toMatchObject({
                mode: 'companion',
                target: target1,
                genType: 'normal',
                source: 'unblock_timeout',
            });
            expect(rollbackSpy).toHaveBeenCalledWith(target1);
            expect(store.listPending(target1)).toHaveLength(0);
            expect(vfs.peekPreCreateBuffer(target1)).toBeUndefined();
            expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
                'agentic_companion_before',
                '',
                1,
                0,
                false,
                0,
            );
            expect(stMocks.fns.setExtensionPrompt).toHaveBeenCalledWith(
                COMPANION_SIDE_BRIDGE_PROMPT_KEY,
                '',
                1,
                0,
                false,
                0,
            );

            // Scenario 2: Streaming normal completion releases lock right before MESSAGE_RECEIVED within grace window -> NO error event
            errorEvents.length = 0;
            stMocks.state.is_send_press = true;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            stMocks.state.is_send_press = false;
            await vi.advanceTimersByTimeAsync(35);
            await stMocks.eventSource.emit(stMocks.event_types.MESSAGE_RECEIVED, 1, 'normal');
            await vi.advanceTimersByTimeAsync(200);
            expect(errorEvents).toHaveLength(0);
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_ENDED, 2);

            // Scenario 3: Explicit GENERATION_STOPPED cleans up pending turn & disarms error detection (NO error event)
            errorEvents.length = 0;
            store.set(DATA_NAMESPACES.FILES, 'stopped.md', 'before_turn', 'staged-stop', {
                target: target1,
                staged: true,
            });
            stMocks.state.is_send_press = true;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_STOPPED);
            stMocks.state.is_send_press = false;
            await vi.advanceTimersByTimeAsync(200);
            expect(errorEvents).toHaveLength(0);
            expect(store.listPending(target1)).toHaveLength(0);

            // Scenario 4a: Background GENERATION_STARTED('quiet') during active companion turn must NOT abort, roll back staged data, or emit agentic_generation_error
            errorEvents.length = 0;
            store.set(DATA_NAMESPACES.FILES, 'keep-during-quiet.md', 'before_turn', 'staged-keep', {
                target: target1,
                staged: true,
            });
            await vfs.writeFile('/output.md', 'keep-buf', { target: target1 });
            stMocks.state.is_send_press = true;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_STARTED, 'quiet', {}, false);
            expect(errorEvents).toHaveLength(0);
            expect(store.listPending(target1)).toHaveLength(1);
            expect(vfs.peekPreCreateBuffer(target1)).toBe('keep-buf');
            await stMocks.eventSource.emit(stMocks.event_types.MESSAGE_RECEIVED, 1, 'normal');
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_ENDED, 2);
            stMocks.state.is_send_press = false;
            store.rollbackStagedData(target1);
            vfs.flushPreCreateBuffer(target1);

            // Scenario 4b: Next non-quiet GENERATION_STARTED fallback catches orphaned pendingCompanionTurn even if lock was never observed
            errorEvents.length = 0;
            store.set(DATA_NAMESPACES.FILES, 'orphan.md', 'before_turn', 'staged-orphan', {
                target: target1,
                staged: true,
            });
            await vfs.writeFile('/output.md', 'orphan-buf', { target: target1 });
            stMocks.state.is_send_press = false;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_STARTED, 'normal', {}, false);

            expect(errorEvents).toHaveLength(1);
            expect(errorEvents[0]).toMatchObject({
                mode: 'companion',
                target: target1,
                source: 'superseded_generation_started',
            });
            expect(store.listPending(target1)).toHaveLength(0);
            expect(vfs.peekPreCreateBuffer(target1)).toBeUndefined();

            // Scenario 5: unhandledrejection while lock is released captures error message and emits agentic_generation_error
            errorEvents.length = 0;
            const rejectionListeners = new Set<(event: Event) => void>();
            vi.stubGlobal('addEventListener', (type: string, fn: (event: Event) => void) => {
                if (type === 'unhandledrejection') {
                    rejectionListeners.add(fn);
                }
            });
            vi.stubGlobal('removeEventListener', (type: string, fn: (event: Event) => void) => {
                if (type === 'unhandledrejection') {
                    rejectionListeners.delete(fn);
                }
            });

            stMocks.state.is_send_press = false;
            await stMocks.eventSource.emit(stMocks.event_types.GENERATION_AFTER_COMMANDS, 'normal', {}, false);
            for (const listener of Array.from(rejectionListeners)) {
                listener({ reason: { error: { message: '429 Rate limit exceeded' } } } as unknown as Event);
            }
            await vi.advanceTimersByTimeAsync(60);

            expect(errorEvents).toHaveLength(1);
            expect(errorEvents[0]).toMatchObject({
                mode: 'companion',
                target: target1,
                source: 'unhandled_rejection',
                errorMessage: '429 Rate limit exceeded',
            });

            handle.dispose();
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('/sidegen-* Slash Commands', () => {
    beforeEach(() => {
        resetStState();
    });

    function createMockSideGen(): ToolSideGenApi {
        const sessions = new Map<string, { id: string; title: string }>();
        return {
            runOnce: vi.fn(async (opts) => ({
                text: `once:${opts.prompt}`,
                bridgedPath: opts.bridge?.path,
                durationMs: 12,
            })),
            createSession: vi.fn(async (opts) => {
                const id = opts.id ?? 'generated';
                sessions.set(id, { id, title: opts.title });
                return {
                    id,
                    title: opts.title,
                    scope: opts.scope ?? 'branch',
                    systemPrompt: opts.systemPrompt,
                    connectionId: opts.connectionId ?? 'default',
                    watermark: opts.watermark ?? { high: 12000, low: 6000 },
                    autoBridge: opts.autoBridge,
                    anchor: { messageId: 0, swipeId: 0 },
                    turns: 0,
                    estimatedTokens: 0,
                    createdAt: 1,
                    updatedAt: 1,
                };
            }),
            send: vi.fn(async (sessionId, prompt) => ({
                text: `reply:${sessionId}:${prompt}`,
                sessionId,
                durationMs: 15,
            })),
            getSession: vi.fn(async (sessionId) =>
                sessions.has(sessionId)
                    ? {
                          id: sessionId,
                          title: sessions.get(sessionId)!.title,
                          scope: 'branch' as const,
                          systemPrompt: '',
                          connectionId: 'default',
                          watermark: { high: 12000, low: 6000 },
                          anchor: { messageId: 0, swipeId: 0 },
                          turns: 1,
                          estimatedTokens: 100,
                          createdAt: 1,
                          updatedAt: 1,
                      }
                    : null,
            ),
            listSessions: vi.fn(async () => []),
            getTranscript: vi.fn(async () => []),
            compactSession: vi.fn(async () => ({ compacted: false, estimatedTokens: 0 })),
            deleteSession: vi.fn(async () => true),
            clues: {
                write: vi.fn(async (input) => ({
                    path: input.path,
                    meta: {
                        id: 'clue_1',
                        title: input.title ?? 'Clue',
                        delivery: input.delivery ?? 'radar_hint',
                        status: input.status ?? 'dormant',
                        keywords: input.keywords ?? [],
                        summary: input.summary ?? '',
                        anchor: '0#0',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    body: input.body,
                    contentHash: 'abc123',
                })),
                read: vi.fn(async (path) => ({
                    path,
                    meta: {
                        id: 'clue_1',
                        title: 'Harbor Clue',
                        delivery: 'radar_hint' as const,
                        status: 'dormant' as const,
                        keywords: ['dock'],
                        summary: 'Dock summary',
                        anchor: '0#0',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    body: 'Body text',
                    contentHash: 'abc123',
                })),
                list: vi.fn(async () => [
                    {
                        path: '/side/comms/linwan.md',
                        meta: {
                            id: 'clue_linwan',
                            title: 'Lin Wan Comms',
                            delivery: 'radar_hint' as const,
                            status: 'dormant' as const,
                            keywords: ['dock'],
                            summary: 'Meeting at 22:00',
                            anchor: '0#0',
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        body: 'See you there.',
                        contentHash: 'hash1',
                    },
                ]),
                updateDelivery: vi.fn(async (path, delivery) => ({
                    path,
                    meta: {
                        id: 'clue_1',
                        title: 'Clue',
                        delivery,
                        status: 'dormant' as const,
                        keywords: [],
                        summary: '',
                        anchor: '0#0',
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    body: '',
                    contentHash: 'hash2',
                })),
                updateStatus: vi.fn(async (path, status) => ({
                    path,
                    meta: {
                        id: 'clue_1',
                        title: 'Clue',
                        delivery: 'radar_hint' as const,
                        status,
                        keywords: [],
                        summary: '',
                        anchor: '0#0',
                        createdAt: 1,
                        updatedAt: 2,
                    },
                    body: '',
                    contentHash: 'hash3',
                })),
                delete: vi.fn(async () => true),
                exportToWorldInfo: vi.fn(async (path, opts) => ({
                    bookName: opts?.bookName ?? 'HarborLore',
                    uid: 7,
                    comment: opts?.comment ?? 'Exported Clue',
                    cluePath: path,
                })),
            },
        };
    }

    it('parses both ST namedArgs and CLI --flag tokens cleanly', () => {
        const parsed = parseSideGenSlashInput(
            { connection: 'fast-model' },
            '--system "You are an off-stage narrator" --depth 4 --path /side/rumors/dock.md --delivery radar_hint --keywords "dock,lighthouse" Describe the rumor',
        );
        expect(parsed.flags).toEqual({
            connection: 'fast-model',
            system: 'You are an off-stage narrator',
            depth: '4',
            path: '/side/rumors/dock.md',
            delivery: 'radar_hint',
            keywords: 'dock,lighthouse',
        });
        expect(parsed.text).toBe('Describe the rumor');
    });

    it('registers /sidegen-once, /sidegen-send, and /sidegen-clue and dispatches all flags accurately', async () => {
        const sideGen = createMockSideGen();
        const handle = registerSideGenSlashCommands({ getSideGen: () => sideGen });

        expect(handle.commands).toEqual([
            SIDEGEN_SLASH_COMMANDS.ONCE,
            SIDEGEN_SLASH_COMMANDS.SEND,
            SIDEGEN_SLASH_COMMANDS.CLUE,
        ]);
        expect(Object.keys(stMocks.state.registeredSlashCommands)).toEqual([
            'sidegen-once',
            'sidegen-send',
            'sidegen-clue',
        ]);

        // /sidegen-once
        const onceOut = await dispatchSideGenOnce(
            sideGen,
            { depth: '3', connection: 'conn-2' },
            '--system "Narrate rumors" --path /side/rumors/r1.md --delivery next_turn_brief --keywords "dock,fog" --title "Dock Rumor" What happened at the pier?',
        );
        expect(onceOut).toBe('once:What happened at the pier?');
        expect(sideGen.runOnce).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'What happened at the pier?',
                systemPrompt: 'Narrate rumors',
                mainChatDepth: 3,
                connectionId: 'conn-2',
                bridge: {
                    path: '/side/rumors/r1.md',
                    delivery: 'next_turn_brief',
                    title: 'Dock Rumor',
                    keywords: ['dock', 'fog'],
                },
            }),
        );

        // /sidegen-send (auto-creates session with autoBridge on first turn, reuses on second)
        const sendOut = await dispatchSideGenSend(
            sideGen,
            { session: 'phone:linwan', scope: 'branch' },
            '--system "You are Lin Wan" --path /side/comms/linwan.md --delivery radar_hint --keywords "老码头,灯塔" Tonight at 10pm',
        );
        expect(sendOut).toBe('reply:phone:linwan:Tonight at 10pm');
        expect(sideGen.createSession).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'phone:linwan',
                scope: 'branch',
                systemPrompt: 'You are Lin Wan',
                autoBridge: expect.objectContaining({
                    path: '/side/comms/linwan.md',
                    delivery: 'radar_hint',
                    keywords: ['老码头', '灯塔'],
                }),
            }),
        );
        expect(sideGen.send).toHaveBeenCalledWith('phone:linwan', 'Tonight at 10pm', {});

        // /sidegen-clue actions
        const listJson = JSON.parse(await dispatchSideGenClue(sideGen, { action: 'list' }, '')) as Array<{
            path: string;
        }>;
        expect(listJson[0]?.path).toBe('/side/comms/linwan.md');

        const writeJson = JSON.parse(
            await dispatchSideGenClue(
                sideGen,
                {},
                '--action write --path /side/notes/n1.md --title "Note 1" --delivery radar_hint --keywords "key1,key2" Clue body here',
            ),
        ) as { path: string };
        expect(writeJson.path).toBe('/side/notes/n1.md');
        expect(sideGen.clues.write).toHaveBeenCalledWith(
            expect.objectContaining({
                path: '/side/notes/n1.md',
                title: 'Note 1',
                delivery: 'radar_hint',
                keywords: ['key1', 'key2'],
                body: 'Clue body here',
            }),
        );

        const deliveryJson = JSON.parse(
            await dispatchSideGenClue(
                sideGen,
                { action: 'delivery', path: '/side/notes/n1.md', delivery: 'vfs_only' },
                '',
            ),
        ) as { delivery: string };
        expect(deliveryJson.delivery).toBe('vfs_only');

        const statusJson = JSON.parse(
            await dispatchSideGenClue(
                sideGen,
                { action: 'status', path: '/side/notes/n1.md' },
                'resolved',
            ),
        ) as { status: string };
        expect(statusJson.status).toBe('resolved');

        const exportJson = JSON.parse(
            await dispatchSideGenClue(
                sideGen,
                { action: 'export', path: '/side/notes/n1.md', title: 'WI Entry', keywords: 'k1,k2' },
                '',
            ),
        ) as { uid: number; comment: string };
        expect(exportJson.uid).toBe(7);
        expect(exportJson.comment).toBe('WI Entry');

        // Dispose removes registered commands
        handle.dispose();
        expect(Object.keys(stMocks.state.registeredSlashCommands)).toHaveLength(0);
    });

    it('reloads displayed messages in-place and live-syncs Agentic, EjsTemplate, and TavernHelper without page reload', async () => {
        const setAttribute = vi.fn();
        const mesEl0 = {
            getAttribute: vi.fn((attr: string) => (attr === 'mesid' ? '0' : null)),
            querySelector: vi.fn(() => null),
            querySelectorAll: vi.fn(() => []),
            setAttribute,
        };
        const mesEl1 = {
            getAttribute: vi.fn((attr: string) => (attr === 'mesid' ? '1' : null)),
            querySelector: vi.fn(() => null),
            querySelectorAll: vi.fn(() => []),
            setAttribute,
        };
        stMocks.state.chat.push({
            name: 'Alice',
            is_user: false,
            is_system: false,
            mes: 'Second message <ui-card>HP 100</ui-card>',
            extra: {},
        });

        vi.stubGlobal('document', {
            querySelectorAll: (selector: string) =>
                selector === '#chat > .mes' ? [mesEl0, mesEl1] : [],
            querySelector: (selector: string) => {
                if (selector === '#chat .mes[mesid="0"]') return mesEl0;
                if (selector === '#chat .mes[mesid="1"]') return mesEl1;
                return null;
            },
        });

        const ejsSetFeatures = vi.fn();
        const ejsRefreshWi = vi.fn(async () => undefined);
        const thScriptsStore: Record<'global' | 'character' | 'preset', Record<string, unknown>[]> = {
            global: [{ type: 'script', id: 'g1', name: 'UI Renderer', content: 'console.log(1);', enabled: true }],
            character: [{ type: 'script', id: 'c1', name: 'Char Script', content: 'console.log(2);', enabled: true }],
            preset: [],
        };
        const thReplaceScriptTrees = vi.fn(
            async (scripts: Record<string, unknown>[], opts: { type: 'global' | 'character' | 'preset' }) => {
                thScriptsStore[opts.type] = scripts;
            },
        );
        const thGetScriptTrees = vi.fn(
            async (opts: { type: 'global' | 'character' | 'preset' }) => thScriptsStore[opts.type],
        );
        const thSetAudioSettings = vi.fn();

        vi.stubGlobal('EjsTemplate', {
            setFeatures: ejsSetFeatures,
            refreshWorldInfo: ejsRefreshWi,
        });
        vi.stubGlobal('TavernHelper', {
            getScriptTrees: thGetScriptTrees,
            replaceScriptTrees: thReplaceScriptTrees,
            setAudioSettings: thSetAudioSettings,
        });

        const onAgenticReload = vi.fn();
        const hostBridge = new STHostBridge();
        hostBridge.setAgenticSettingsReloadHook(onAgenticReload);

        // 1. reloadDisplayedMessages refreshes both visible messages and emits MESSAGE_UPDATED only
        const reloadRes = await hostBridge.reloadDisplayedMessages({ emitUpdateEvent: true });
        expect(reloadRes.reloadedIds).toEqual([0, 1]);
        expect(reloadRes.emittedEvents).toBe(2);
        expect(stMocks.fns.updateMessageBlock).toHaveBeenCalledTimes(2);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 0);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            expect.anything(),
        );

        // 2. patchHostSettings deep-merges, preserves '***REDACTED***', and triggers extension live hooks
        stMocks.state.extension_settings.Agentic = {
            runMode: 'companion',
            connections: { default: { apiKey: 'real-agentic-secret-key', model: 'gpt-4o' } },
        };
        stMocks.state.extension_settings.EjsTemplate = { enabled: false, debug: false };
        stMocks.state.extension_settings.tavern_helper = {
            script: { scripts: thScriptsStore.global },
            audio: { bgm: { volume: 50 }, ambient: { volume: 30 } },
        };

        const adminBridge = new STAdminBridge({
            onAgenticSettingsPatched: onAgenticReload,
            reloadDisplayedMessages: (opts) => hostBridge.reloadDisplayedMessages(opts),
        });

        expect(adminBridge.getExtensionCapabilities()).toEqual({
            tavernHelperScripts: true,
            tavernHelperAudio: true,
            ejsTemplate: true,
        });

        await adminBridge.patchHostSettings('Agentic', {
            runMode: 'takeover',
            connections: { default: { apiKey: '***REDACTED***', model: 'gpt-4.1' } },
        });
        expect(onAgenticReload).toHaveBeenCalledTimes(1);
        expect(
            ((stMocks.state.extension_settings.Agentic as Record<string, unknown>).connections as Record<
                string,
                Record<string, unknown>
            >).default?.apiKey,
        ).toBe('real-agentic-secret-key');

        await adminBridge.patchHostSettings('EjsTemplate', { enabled: true });
        expect(ejsSetFeatures).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, debug: false }));

        await adminBridge.patchHostSettings('tavern_helper', {
            audio: { bgm: { volume: 80 } },
        });
        expect(thSetAudioSettings).toHaveBeenCalledWith('bgm', expect.objectContaining({ volume: 80 }));

        // 3. readTavernHelperScripts & replaceTavernHelperScripts (live + fallback)
        const readLive = await adminBridge.readTavernHelperScripts('global');
        expect(readLive.liveApiAvailable).toBe(true);
        expect(readLive.scripts).toHaveLength(1);

        const nextGlobalScripts = [
            { type: 'script', id: 'g2', name: 'New Card UI', content: 'renderUI();', enabled: true },
        ];
        const writeLive = await adminBridge.replaceTavernHelperScripts('global', nextGlobalScripts);
        expect(writeLive.syncedLive).toBe(true);
        expect(thReplaceScriptTrees).toHaveBeenCalledWith(nextGlobalScripts, { type: 'global' });

        // 4. syncHostRuntime syncs all targets and re-renders displayed messages
        stMocks.fns.eventEmit.mockClear();
        const syncRes = await adminBridge.syncHostRuntime({ targets: ['all'], messageIds: [1] });
        expect(syncRes.ok).toBe(true);
        expect(syncRes.reloadedMessageIds).toEqual([1]);
        expect(ejsRefreshWi).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.SETTINGS_LOADED);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.EXTENSION_SETTINGS_LOADED,
        );
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);

        // Capability gating & fallback storage path when globalThis.TavernHelper / EjsTemplate are absent
        vi.stubGlobal('TavernHelper', undefined);
        vi.stubGlobal('EjsTemplate', undefined);
        expect(adminBridge.getExtensionCapabilities()).toEqual({
            tavernHelperScripts: false,
            tavernHelperAudio: false,
            ejsTemplate: false,
        });
        const minimalSync = await adminBridge.syncHostRuntime({ targets: ['all'], messageIds: [1] });
        expect(minimalSync.ok).toBe(true);
        expect(minimalSync.results.map((r) => r.target)).toEqual([
            'agentic',
            'st_settings',
            'messages',
        ]);
        const explicitAbsentSync = await adminBridge.syncHostRuntime({ targets: ['ejs'] });
        expect(explicitAbsentSync.ok).toBe(false);

        const fallbackWrite = await adminBridge.replaceTavernHelperScripts('character', [
            { type: 'script', id: 'c_fallback', name: 'Fallback Char', content: 'ok()', enabled: true },
        ]);
        expect(fallbackWrite.syncedLive).toBe(false);
        expect(fallbackWrite.requiresReload).toBe(true);
        const fallbackRead = await adminBridge.readTavernHelperScripts('character');
        expect(fallbackRead.liveApiAvailable).toBe(false);
        expect(fallbackRead.scripts[0]?.id).toBe('c_fallback');
    });

    it('emits CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED on /output.md updates without recursing in companion mode', async () => {
        stMocks.state.chat = [
            {
                name: 'Tester',
                is_user: true,
                is_system: false,
                mes: '你好',
                swipe_id: 0,
                swipes: ['你好'],
                swipe_info: [{}],
            },
            {
                name: 'Alice',
                is_user: false,
                is_system: false,
                mes: '初始正文',
                swipe_id: 0,
                swipes: ['初始正文', '次选分页'],
                swipe_info: [{}, {}],
            },
            {
                name: 'System',
                is_user: false,
                is_system: true,
                mes: '系统注记',
                swipe_id: 0,
                swipes: ['系统注记'],
                swipe_info: [{}],
            },
        ];

        const makeFakeMesEl = (mesid: string) => {
            const fakeEl: Record<string, unknown> = {
                mesid,
                classList: { contains: () => false },
                querySelectorAll: () => [],
                appendChild: vi.fn(),
                insertBefore: vi.fn(),
            };
            const fakeCapsule: Record<string, unknown> = {
                getAttribute: () => 'bottom',
                setAttribute: vi.fn(),
                setState: vi.fn(),
                connectStore: vi.fn(),
                parentElement: fakeEl,
                nextSibling: null,
            };
            fakeEl.querySelector = (sel: string) => (sel === 'agentic-capsule' ? fakeCapsule : null);
            return fakeEl;
        };
        const mesDomMap = new Map<string, Record<string, unknown>>([
            ['#chat .mes[mesid="0"]', makeFakeMesEl('0')],
            ['#chat .mes[mesid="1"]', makeFakeMesEl('1')],
            ['#chat .mes[mesid="2"]', makeFakeMesEl('2')],
        ]);
        vi.stubGlobal('document', {
            querySelector: (selector: string) => mesDomMap.get(selector) ?? null,
            querySelectorAll: () => [],
        });

        const settings: Settings = createDefaultSettings({ runMode: 'companion' });
        const bridge = new STHostBridge({ getSettings: () => settings });
        const store = new ChatDataStore(bridge);
        bridge.setStore(store);
        const vfs = new VirtualFileSystem({ bridge, store });

        // 1. Assistant /output.md write/edit/append updates DOM and emits MESSAGE_UPDATED + CHARACTER_MESSAGE_RENDERED
        await vfs.writeFile('/output.md', '<div>html panel</div>', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(stMocks.fns.updateMessageBlock).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            1,
            AGENTIC_RERENDER_EVENT_TYPE,
        );

        stMocks.fns.eventEmit.mockClear();
        await vfs.editFile('/output.md', 'html panel', 'updated panel', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            1,
            AGENTIC_RERENDER_EVENT_TYPE,
        );

        // 2. Inactive swipe write emits MESSAGE_UPDATED but does NOT emit CHARACTER_MESSAGE_RENDERED
        stMocks.fns.eventEmit.mockClear();
        stMocks.fns.updateMessageBlock.mockClear();
        await vfs.writeFile('/output.md', '次选更新', {
            target: { messageId: 1, swipeId: 1 },
        });
        expect(stMocks.fns.updateMessageBlock).not.toHaveBeenCalled();
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            expect.anything(),
            expect.anything(),
        );

        // 3. User message /output.md write emits MESSAGE_UPDATED + USER_MESSAGE_RENDERED; hidden system message emits no render event
        stMocks.fns.eventEmit.mockClear();
        await vfs.writeFile('/output.md', '修改后的用户消息', {
            target: { messageId: 0, swipeId: 0 },
        });
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 0);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.USER_MESSAGE_RENDERED,
            0,
        );

        stMocks.fns.eventEmit.mockClear();
        await vfs.writeFile('/output.md', '修改后的系统注记', {
            target: { messageId: 2, swipeId: 0 },
        });
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 2);
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            expect.anything(),
            expect.anything(),
        );
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.USER_MESSAGE_RENDERED,
            expect.anything(),
        );

        // 4. Explicit emitRenderEvent: false emits MESSAGE_UPDATED only without render event
        stMocks.fns.eventEmit.mockClear();
        await vfs.writeFile('/output.md', '草稿正文', {
            target: { messageId: 1, swipeId: 0 },
            emitRenderEvent: false,
        });
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(stMocks.event_types.MESSAGE_UPDATED, 1);
        expect(stMocks.fns.eventEmit).not.toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            expect.anything(),
            expect.anything(),
        );

        // 5. Companion hooks guard against internal re-render recursion & preserve iframes when no display regex matches
        const rerunAfterTurn = vi.fn(async () => []);
        const mockOrchestrator = {
            store,
            vfs,
            barrierCoordinator: {
                awaitTurnBarriers: vi.fn(async () => undefined),
                abortFromMessage: vi.fn(),
                abortTarget: vi.fn(),
            },
            decoratorCompiler: {
                compile: vi.fn(() => ({ triggers: [] })),
            },
            rerunAfterTurn,
            trajectoryStore: {
                listInterruptedCheckpoints: vi.fn(() => new Map()),
                pruneFromMessage: vi.fn(() => 0),
                pruneSwipe: vi.fn(() => 0),
                saveToHost: vi.fn(),
            },
        } as unknown as PipelineOrchestrator;

        const handle = setupCompanionHooks({
            bridge,
            orchestrator: mockOrchestrator,
            getSettings: () => settings,
        });

        // Native turn completion triggers companion rerunAfterTurn once without overwriting DOM (no display regex)
        stMocks.fns.updateMessageBlock.mockClear();
        stMocks.fns.eventEmit.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 1, 'normal');
        expect(rerunAfterTurn).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.updateMessageBlock).not.toHaveBeenCalled();

        // Subsequent after_turn /output.md write emits CHARACTER_MESSAGE_RENDERED (agentic_rerender)
        // which updates DOM & lets JS-Slash-Runner render, WITHOUT recursively re-triggering rerunAfterTurn
        // or clearing companion prompts.
        stMocks.fns.setExtensionPrompt.mockClear();
        await vfs.appendFile('/output.md', '\n<pre><code><!DOCTYPE html></html></code></pre>', {
            target: { messageId: 1, swipeId: 0 },
            staged: true,
        });
        expect(stMocks.fns.updateMessageBlock).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            1,
            AGENTIC_RERENDER_EVENT_TYPE,
        );
        expect(rerunAfterTurn).toHaveBeenCalledTimes(1);
        expect(stMocks.fns.setExtensionPrompt).not.toHaveBeenCalled();

        // Flushing preCreateBuffers on a newly created message emits guarded CHARACTER_MESSAGE_RENDERED once
        // without causing infinite recursion in companion hooks.
        const futureTarget = { messageId: 3, swipeId: 0 };
        await vfs.writeFile('/output.md', '<pre><code><!DOCTYPE html></html></code></pre>', {
            target: futureTarget,
            emitRenderEvent: false,
        });
        stMocks.state.chat.push({
            name: 'Alice',
            is_user: false,
            is_system: false,
            mes: '正文内容',
            swipe_id: 0,
            swipes: ['正文内容'],
            swipe_info: [{}],
        });
        mesDomMap.set('#chat .mes[mesid="3"]', makeFakeMesEl('3'));
        stMocks.fns.eventEmit.mockClear();
        await stMocks.eventSource.emit(stMocks.event_types.CHARACTER_MESSAGE_RENDERED, 3, 'normal');
        expect(rerunAfterTurn).toHaveBeenCalledTimes(2);
        expect(stMocks.fns.eventEmit).toHaveBeenCalledWith(
            stMocks.event_types.CHARACTER_MESSAGE_RENDERED,
            3,
            AGENTIC_RERENDER_EVENT_TYPE,
        );

        handle.dispose();
    });

    it('STHostBridge.saveChatNow() waits for isChatSaving, coalesces overlapping writes, and cancels on chat change', async () => {
        const bridge = new STHostBridge();
        let releaseFirstSave!: () => void;
        let callCount = 0;

        stMocks.fns.saveChatConditional.mockImplementation(async () => {
            callCount += 1;
            if (callCount === 1) {
                stMocks.state.isChatSaving = true;
                await new Promise<void>((resolve) => {
                    releaseFirstSave = () => {
                        stMocks.state.isChatSaving = false;
                        resolve();
                    };
                });
            }
        });

        const firstSave = bridge.saveChatNow();
        await Promise.resolve();
        expect(bridge.hasPendingChatSave()).toBe(true);

        // Concurrent saves while first save is active coalesce into a single follow-up flush
        const secondSave = bridge.saveChatNow();
        const thirdSave = bridge.saveChatNow();

        releaseFirstSave();
        await Promise.all([firstSave, secondSave, thirdSave]);
        expect(callCount).toBe(2);
        expect(bridge.hasPendingChatSave()).toBe(false);

        // Wait for external isChatSaving=true to clear instead of dropping
        callCount = 0;
        stMocks.fns.saveChatConditional.mockImplementation(async () => {
            callCount += 1;
        });
        stMocks.state.isChatSaving = true;
        const waitedSave = bridge.saveChatNow();
        setTimeout(() => {
            stMocks.state.isChatSaving = false;
        }, 60);
        await waitedSave;
        expect(callCount).toBe(1);

        // Switching chats invalidates queued saves so stale metadata never writes to the new chat
        callCount = 0;
        stMocks.state.isChatSaving = true;
        const staleSave = bridge.saveChatNow();
        stMocks.state.currentChatId = 'chat-2';
        stMocks.state.chat_metadata = { character_name: 'Alice', chat2: true };
        bridge.notifyChatChanged();
        stMocks.state.isChatSaving = false;
        await staleSave;
        expect(callCount).toBe(0);
    });
});
