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
    };

    const fns = {
        getRequestHeaders: vi.fn((opts?: { omitContentType?: boolean }) =>
            opts?.omitContentType
                ? { 'X-CSRF-Token': 'csrf-test' }
                : { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-test' },
        ),
        saveChatDebounced: vi.fn(),
        saveCharacterDebounced: vi.fn(),
        saveSettingsDebounced: vi.fn(),
        saveMetadata: vi.fn(async () => undefined),
        saveMetadataDebounced: vi.fn(),
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
        GENERATION_AFTER_COMMANDS: 'generation_after_commands',
        WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        GENERATION_STOPPED: 'generation_stopped',
        GENERATION_ENDED: 'generation_ended',
        MESSAGE_SWIPED: 'message_swiped',
        MESSAGE_DELETED: 'message_deleted',
        MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
        MESSAGE_UPDATED: 'message_updated',
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
    extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    getRequestHeaders: stMocks.fns.getRequestHeaders,
    saveChatDebounced: stMocks.fns.saveChatDebounced,
    saveCharacterDebounced: stMocks.fns.saveCharacterDebounced,
    saveSettingsDebounced: stMocks.fns.saveSettingsDebounced,
    saveMetadata: stMocks.fns.saveMetadata,
    updateMessageBlock: stMocks.fns.updateMessageBlock,
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
import { ChatDataStore } from '@/core/store';
import type { PipelineOrchestrator } from '@/core/triggers';
import type { Settings } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import {
    COMPANION_SIDE_BRIDGE_PROMPT_KEY,
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
import { STHostBridge } from '@/host/st-bridge';

function resetStState() {
    stMocks.eventListeners.clear();
    stMocks.state.this_chid = 0;
    stMocks.state.name1 = 'Tester';
    stMocks.state.name2 = 'Alice';
    stMocks.state.user_avatar = 'tester.png';
    stMocks.state.selected_group = null;
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
});
