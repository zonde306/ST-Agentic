import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const stMocks = vi.hoisted(() => {
    const state = {
        characters: [] as Array<Record<string, unknown>>,
        extension_settings: {} as Record<string, unknown>,
        power_user: {} as Record<string, unknown>,
        world_names: [] as string[],
        selected_world_info: [] as string[],
        world_info: { globalSelect: [] as string[], charLore: [] as unknown[] } as Record<
            string,
            unknown
        >,
        presets: new Map<string, Record<string, unknown>>(),
        selectedPresetName: 'Default',
        user_avatar: 'tester.png',
    };

    const fns = {
        getCompletionPresetByName: vi.fn((name: string) => state.presets.get(name)),
        savePreset: vi.fn(async (name: string, settings: Record<string, unknown>) => {
            state.presets.set(name, settings);
        }),
        selectPreset: vi.fn(async (name: string) => {
            state.selectedPresetName = name;
        }),
        saveSettingsDebounced: vi.fn(),
    };

    const presetManager = {
        apiId: 'openai',
        getAllPresets: () => Array.from(state.presets.keys()),
        findPreset: (name: string) => (state.presets.has(name) ? name : undefined),
        getSelectedPresetName: () => state.selectedPresetName,
        selectPreset: fns.selectPreset,
        savePreset: fns.savePreset,
        getCompletionPresetByName: fns.getCompletionPresetByName,
    };

    return { state, fns, presetManager };
});

vi.mock('@st/script.js', () => ({
    get characters() {
        return stMocks.state.characters;
    },
    get this_chid() {
        return 0;
    },
    deleteCharacter: vi.fn(),
    getCharacters: vi.fn(async () => undefined),
    getRequestHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
    saveSettingsDebounced: stMocks.fns.saveSettingsDebounced,
    saveCharacterDebounced: vi.fn(),
    saveChatDebounced: vi.fn(),
    selectCharacterById: vi.fn(),
    chat: [],
    chat_metadata: {},
}));

vi.mock('@st/scripts/extensions.js', () => ({
    get extension_settings() {
        return stMocks.state.extension_settings;
    },
    saveMetadataDebounced: vi.fn(),
}));

vi.mock('@st/scripts/i18n.js', () => ({
    translate: (fallback: string) => fallback,
}));

vi.mock('@st/scripts/util/AccountStorage.js', () => ({
    accountStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
    },
}));

vi.mock('@st/scripts/extensions/regex/engine.js', () => ({
    SCRIPT_TYPES: { GLOBAL: 0, SCOPED: 1, PRESET: 2 },
    getScriptsByType: vi.fn(() => []),
    saveScriptsByType: vi.fn(async () => undefined),
}));

vi.mock('@st/scripts/personas.js', () => ({
    get user_avatar() {
        return stMocks.state.user_avatar;
    },
    setUserAvatar: vi.fn(async () => undefined),
}));

vi.mock('@st/scripts/power-user.js', () => ({
    get power_user() {
        return stMocks.state.power_user;
    },
}));

vi.mock('@st/scripts/preset-manager.js', () => ({
    getPresetManager: vi.fn(() => stMocks.presetManager),
}));

vi.mock('@st/scripts/world-info.js', () => ({
    get world_names() {
        return stMocks.state.world_names;
    },
    get selected_world_info() {
        return stMocks.state.selected_world_info;
    },
    get world_info() {
        return stMocks.state.world_info;
    },
    createNewWorldInfo: vi.fn(),
    loadWorldInfo: vi.fn(async () => null),
    onWorldInfoChange: vi.fn(),
    saveWorldInfo: vi.fn(async () => undefined),
    updateWorldInfoList: vi.fn(async () => undefined),
    createWorldInfoEntry: vi.fn(),
    deleteWorldInfoEntry: vi.fn(),
    reloadEditor: vi.fn(),
}));

vi.mock('@st/scripts/events.js', () => ({
    eventSource: { on: vi.fn(), removeListener: vi.fn(), emit: vi.fn(async () => undefined) },
    event_types: { CHARACTER_EDITED: 'character_edited', MESSAGE_UPDATED: 'message_updated' },
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

import {
    REDACTED_PLACEHOLDER,
    UndoStore,
    createAdminTierTools,
    createChatReadOnlyTools,
    executeAssistantTool,
    finalizeMutationToolResult,
    finalizeReadToolResult,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import {
    DEFAULT_MAX_TOOL_RESULT_BYTES,
    TrajectoryStore,
    TransientToolSpillStore,
    utf8ByteLength,
} from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { ChatDataStore } from '@/core/store';
import { VirtualFileSystem } from '@/core/vfs';
import { STAdminBridge } from '@/host/st-admin-bridge';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';

function createToolHarness(overrides?: Partial<AssistantToolContext>) {
    const bridge = createOffMainlineTestBridge();
    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({ bridge, store });
    const undoStore = new UndoStore();
    const trajectoryStore = new TrajectoryStore();
    const traceLogger = new TraceLogger();
    const spillStore = new TransientToolSpillStore();
    const settings = createDefaultSettings();

    const ctx: AssistantToolContext = {
        sessionId: 'ast_budget_session',
        toolCallId: 'call_budget_1',
        mode: 'full',
        stAdminEnabled: true,
        bridge,
        store,
        vfs,
        undoStore,
        trajectoryStore,
        traceLogger,
        settings,
        target: { messageId: 1, swipeId: 0 },
        signal: new AbortController().signal,
        spillStore,
        ...overrides,
    };

    const tools = new Map<string, AssistantToolDefinition>();
    for (const def of [...createChatReadOnlyTools(), ...createAdminTierTools()]) {
        tools.set(def.name, def);
    }

    return { bridge, store, vfs, undoStore, spillStore, ctx, tools };
}

describe('C1.1 Host Admin Bridge Slimming, Drill-Down & Assistant Output Gate', () => {
    beforeEach(() => {
        stMocks.state.characters = [
            {
                name: 'ShortCard',
                avatar: 'short.png',
                description: 'Brief character bio.',
                data: { name: 'ShortCard', description: 'Brief character bio.', extensions: {} },
            },
            {
                name: 'VerboseCard',
                avatar: 'verbose.png',
                description: 'A'.repeat(260),
                data: { name: 'VerboseCard', description: 'A'.repeat(260), extensions: {} },
            },
        ];
        stMocks.state.power_user = {
            theme: 'Obsidian',
            fast_ui_mode: true,
            heavyBackgroundImage: 'data:image/png;base64,' + 'B'.repeat(22_000),
        };
        stMocks.state.extension_settings = {
            TavernHelper: {
                enabled: true,
                scripts: [
                    { id: 'script-0', name: 'HUD', code: 'console.log("hud");' },
                    { id: 'script-1', name: 'Giant', code: 'x'.repeat(25_000) },
                ],
            },
            tinyExt: { flag: true },
        };
        stMocks.state.presets = new Map([
            ['Default', { temperature: 0.7, prompt_body: 'P'.repeat(8000) }],
            ['Creative', { temperature: 1.2, prompt_body: 'C'.repeat(9000) }],
        ]);
        stMocks.state.selectedPresetName = 'Default';
        vi.clearAllMocks();
    });

    describe('STAdminBridge readHostSettings, listPresets, and listAllCharacters', () => {
        it('returns a descending-byte summary manifest for large broad scopes and drills down via keyPath', async () => {
            const admin = new STAdminBridge();

            const allManifest = await admin.readHostSettings('all');
            expect(allManifest.summaryOnly).toBe(true);
            expect(allManifest.scope).toBe('all');
            expect(typeof allManifest.totalBytes).toBe('number');
            expect((allManifest.totalBytes as number)).toBeGreaterThan(16 * 1024);
            expect(typeof allManifest.hint).toBe('string');
            const topItems = allManifest.manifest as Array<{ key: string; bytes: number }>;
            expect(topItems.map((i) => i.key)).toEqual(['extension_settings', 'power_user']);
            expect(topItems[0].bytes).toBeGreaterThanOrEqual(topItems[1].bytes);
            expect(allManifest.subManifests).toBeDefined();

            const extManifest = await admin.readHostSettings('extension_settings');
            expect(extManifest.summaryOnly).toBe(true);
            const extItems = extManifest.manifest as Array<{ key: string; bytes: number }>;
            expect(extItems[0].key).toBe('TavernHelper');
            expect(extItems[1].key).toBe('tinyExt');

            const puManifest = await admin.readHostSettings('power_user');
            expect(puManifest.summaryOnly).toBe(true);
            const puItems = puManifest.manifest as Array<{ key: string; bytes: number }>;
            expect(puItems[0].key).toBe('heavyBackgroundImage');

            // Explicit summaryOnly: true summarizes even tiny scopes
            const tinySummary = await admin.readHostSettings('tinyExt', { summaryOnly: true });
            expect(tinySummary.summaryOnly).toBe(true);
            expect((tinySummary.manifest as Array<{ key: string }>)[0].key).toBe('flag');

            // Dot and slash keyPath drill-down
            const themeRes = await admin.readHostSettings('all', { keyPath: 'power_user.theme' });
            expect(themeRes).toEqual({
                scope: 'all',
                keyPath: 'power_user.theme',
                found: true,
                value: 'Obsidian',
            });

            const script0 = await admin.readHostSettings('extension_settings', {
                keyPath: 'TavernHelper/scripts/0',
            });
            expect(script0).toEqual({
                id: 'script-0',
                name: 'HUD',
                code: 'console.log("hud");',
            });

            // Oversized array subtree under keyPath also returns a compact manifest
            const scriptsSummary = await admin.readHostSettings('extension_settings', {
                keyPath: 'TavernHelper.scripts',
            });
            expect(scriptsSummary.summaryOnly).toBe(true);
            expect(scriptsSummary.type).toBe('array');
            expect(scriptsSummary.itemCount).toBe(2);

            // Missing keyPath returns found: false cleanly
            const missing = await admin.readHostSettings('power_user', {
                keyPath: 'does.not.exist',
            });
            expect(missing).toEqual({
                scope: 'power_user',
                keyPath: 'does.not.exist',
                found: false,
                value: null,
            });
        });

        it('listPresets strips heavy data by default and supports targeted name + includeData: true', async () => {
            const admin = new STAdminBridge();

            const legacyList = await admin.listPresets('openai');
            expect(legacyList).toEqual([
                { name: 'Default', apiType: 'openai', active: true },
                { name: 'Creative', apiType: 'openai', active: false },
            ]);
            expect(stMocks.fns.getCompletionPresetByName).not.toHaveBeenCalled();

            const singleWithData = await admin.listPresets({
                apiType: 'openai',
                name: 'Creative',
                includeData: true,
            });
            expect(singleWithData).toHaveLength(1);
            expect(singleWithData[0].name).toBe('Creative');
            expect(singleWithData[0].data?.temperature).toBe(1.2);
            expect(stMocks.fns.getCompletionPresetByName).toHaveBeenCalledTimes(1);
            expect(stMocks.fns.getCompletionPresetByName).toHaveBeenCalledWith('Creative');
        });

        it('listAllCharacters truncates long descriptions to <= 120 chars', async () => {
            const admin = new STAdminBridge();
            const list = await admin.listAllCharacters();
            expect(list).toHaveLength(2);
            expect(list[0].description).toBe('Brief character bio.');
            expect(list[1].description).toBeDefined();
            expect(list[1].description!.length).toBeLessThanOrEqual(120);
            expect(list[1].description!.endsWith('...')).toBe(true);
        });
    });

    describe('Admin tools: st_settings_read, st_preset_list/patch, card_admin_list_all', () => {
        it('st_settings_read returns redacted manifest when large or summaryOnly=true, and drills down via keyPath', async () => {
            const { bridge, ctx, tools } = createToolHarness();
            bridge.hostSettings.extension_settings.megaPlugin = {
                apiKey: 'sk-proj-mega-secret-999888',
                blob: 'M'.repeat(24_000),
            };

            const tool = tools.get('st_settings_read')!;

            // Large unfiltered scope automatically degrades to manifest with zero leaked secrets
            const largeRes = await executeAssistantTool(tool, { scope: 'all' }, ctx);
            expect(largeRes.ok).toBe(true);
            expect(largeRes.output).not.toContain('sk-proj-mega-secret-999888');
            const largeSettings = (largeRes.data as { settings: Record<string, unknown> }).settings;
            expect(largeSettings.summaryOnly).toBe(true);
            expect(Array.isArray(largeSettings.manifest)).toBe(true);
            expect(typeof largeSettings.hint).toBe('string');

            // Explicit summaryOnly on small scope
            const sumRes = await executeAssistantTool(
                tool,
                { scope: 'power_user', summaryOnly: true },
                ctx,
            );
            expect(sumRes.ok).toBe(true);
            expect((sumRes.data as { settings: Record<string, unknown> }).settings.summaryOnly).toBe(
                true,
            );
            expect(sumRes.output).not.toContain('sk-test-power-user-secret');

            // Targeted keyPath drill-down
            const drillRes = await executeAssistantTool(
                tool,
                { scope: 'all', keyPath: 'power_user.theme' },
                ctx,
            );
            expect(drillRes.ok).toBe(true);
            expect((drillRes.data as { settings: { found: boolean; value: unknown } }).settings).toEqual({
                scope: 'all',
                keyPath: 'power_user.theme',
                found: true,
                value: 'Dark',
            });

            // Secrets inside a keyPath drill-down are redacted
            const secretDrill = await executeAssistantTool(
                tool,
                { scope: 'extension_settings', keyPath: 'megaPlugin.apiKey' },
                ctx,
            );
            expect(secretDrill.ok).toBe(true);
            expect(secretDrill.hasSecretRedaction).toBe(true);
            expect(secretDrill.output).toContain(REDACTED_PLACEHOLDER);
            expect(secretDrill.output).not.toContain('sk-proj-mega-secret-999888');
        });

        it('st_settings_patch captures previousValues cleanly even when target scope exceeds 16 KB', async () => {
            const { bridge, ctx, tools, undoStore } = createToolHarness();
            bridge.hostSettings.power_user.giantBlob = 'G'.repeat(22_000);

            const patchTool = tools.get('st_settings_patch')!;
            const preview = await patchTool.preview!(
                { scope: 'power_user', patch: { fast_ui_mode: false } },
                ctx,
            );
            expect(preview.beforeText).toContain('"fast_ui_mode": true');

            const res = await executeAssistantTool(
                patchTool,
                { scope: 'power_user', patch: { fast_ui_mode: false } },
                ctx,
            );
            expect(res.ok).toBe(true);
            expect(res.undoId).toBeDefined();
            const record = undoStore.get(res.undoId!);
            expect(record?.snapshot.previousValues).toEqual({ fast_ui_mode: true });
        });

        it('st_preset_list defaults to metadata-only, supports name + includeData, and st_preset_patch does targeted lookup', async () => {
            const { bridge, ctx, tools } = createToolHarness();
            bridge.presets.push({
                name: 'Narrative',
                apiType: 'openai',
                active: false,
                data: { temperature: 1.05, system_prompt: 'S'.repeat(6000) },
            });

            const listSpy = vi.spyOn(bridge.admin!, 'listPresets');
            const listTool = tools.get('st_preset_list')!;

            // Default list: metadata only (no data)
            const metaRes = await executeAssistantTool(listTool, { apiType: 'openai' }, ctx);
            expect(metaRes.ok).toBe(true);
            expect(listSpy).toHaveBeenCalledWith({
                apiType: 'openai',
                includeData: false,
                name: undefined,
            });
            const metaPresets = (metaRes.data as { presets: Array<Record<string, unknown>> })
                .presets;
            expect(metaPresets).toHaveLength(2);
            expect(metaPresets.every((p) => !('data' in p))).toBe(true);

            // Targeted name + includeData: true
            const detailRes = await executeAssistantTool(
                listTool,
                { apiType: 'openai', name: 'Narrative', includeData: true },
                ctx,
            );
            expect(detailRes.ok).toBe(true);
            const detailPresets = (detailRes.data as { presets: Array<Record<string, unknown>> })
                .presets;
            expect(detailPresets).toHaveLength(1);
            expect(detailPresets[0].name).toBe('Narrative');
            expect((detailPresets[0].data as { temperature: number }).temperature).toBe(1.05);

            // st_preset_patch calls listPresets with { includeData: true, name }
            listSpy.mockClear();
            const patchTool = tools.get('st_preset_patch')!;
            const patchPreview = await patchTool.preview!(
                { name: 'Narrative', apiType: 'openai', patch: { temperature: 0.9 } },
                ctx,
            );
            expect(patchPreview.beforeText).toContain('1.05');
            expect(listSpy).toHaveBeenCalledWith({
                apiType: 'openai',
                includeData: true,
                name: 'Narrative',
            });

            listSpy.mockClear();
            const patchRes = await executeAssistantTool(
                patchTool,
                { name: 'Narrative', apiType: 'openai', patch: { temperature: 0.9 } },
                ctx,
            );
            expect(patchRes.ok).toBe(true);
            expect(listSpy).toHaveBeenCalledWith({
                apiType: 'openai',
                includeData: true,
                name: 'Narrative',
            });
        });

        it('card_admin_list_all returns bounded description preview (<= 120 chars) + descriptionLength', async () => {
            const { bridge, ctx, tools } = createToolHarness();
            const longDesc = 'Long lore summary '.repeat(40);
            bridge.characters.push({
                chid: 2,
                name: 'Archivist',
                avatar: 'archivist.png',
                description: longDesc,
                tags: ['npc'],
            });

            const res = await executeAssistantTool(tools.get('card_admin_list_all')!, {}, ctx);
            expect(res.ok).toBe(true);
            const chars = (
                res.data as {
                    characters: Array<{
                        name: string;
                        description?: string;
                        descriptionPreview?: string;
                        descriptionLength: number;
                    }>;
                }
            ).characters;
            const archivist = chars.find((c) => c.name === 'Archivist')!;
            expect(archivist.description!.length).toBeLessThanOrEqual(120);
            expect(archivist.descriptionPreview!.length).toBeLessThanOrEqual(120);
            expect(archivist.descriptionLength).toBe(longDesc.length);
            expect(res.output).not.toContain(longDesc);
        });
    });

    describe('wi_read_enabled auto-catalog degradation', () => {
        it('degrades to catalog when unfiltered or when matched content exceeds 24 KB, and returns full content when filtered & small', async () => {
            const { bridge, ctx, tools } = createToolHarness();
            bridge.lorebooks.set('HugeBook', [
                {
                    world: 'HugeBook',
                    uid: 101,
                    comment: 'Giant Chronicle',
                    content: 'Chronicle line.\n'.repeat(2000), // > 30 KB
                    keys: ['chronicle'],
                    keysecondary: ['history'],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 4,
                    order: 50,
                    role: 0,
                },
                {
                    world: 'HugeBook',
                    uid: 102,
                    comment: 'Small Clue',
                    content: 'Short secret note under the bridge.',
                    keys: ['bridge'],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 4,
                    order: 60,
                    role: 0,
                },
            ]);

            const wiTool = tools.get('wi_read_enabled')!;

            // 1. Unfiltered -> auto catalog without full content
            const unfiltered = await executeAssistantTool(wiTool, {}, ctx);
            expect(unfiltered.ok).toBe(true);
            const uData = unfiltered.data as {
                catalogOnly: boolean;
                degradedToCatalog: boolean;
                reason: string;
                hint: string;
                books: Array<{ bookName: string; entries: Array<Record<string, unknown>> }>;
            };
            expect(uData.catalogOnly).toBe(true);
            expect(uData.degradedToCatalog).toBe(true);
            expect(uData.reason).toBe('unfiltered_request');
            expect(uData.hint).toContain('/lorebooks/');
            for (const book of uData.books) {
                for (const entry of book.entries) {
                    expect(entry).not.toHaveProperty('content');
                    expect(typeof entry.contentLength).toBe('number');
                    expect(entry).toHaveProperty('world');
                    expect(entry).toHaveProperty('uid');
                    expect(entry).toHaveProperty('comment');
                    expect(entry).toHaveProperty('keys');
                    expect(entry).toHaveProperty('order');
                }
            }

            // 2. Filtered by bookName, but matched content > 24 KB -> auto catalog
            const hugeBook = await executeAssistantTool(wiTool, { bookName: 'HugeBook' }, ctx);
            expect(hugeBook.ok).toBe(true);
            const hData = hugeBook.data as {
                catalogOnly: boolean;
                degradedToCatalog: boolean;
                reason: string;
                books: Array<{ entries: Array<Record<string, unknown>> }>;
            };
            expect(hData.catalogOnly).toBe(true);
            expect(hData.degradedToCatalog).toBe(true);
            expect(hData.reason).toBe('content_exceeded_24kb');
            expect(hData.books[0].entries[0]).not.toHaveProperty('content');

            // 3. Filtered by bookName + query and <= 24 KB -> full content returned
            const smallFiltered = await executeAssistantTool(
                wiTool,
                { bookName: 'HugeBook', query: 'bridge' },
                ctx,
            );
            expect(smallFiltered.ok).toBe(true);
            const sData = smallFiltered.data as {
                catalogOnly: boolean;
                degradedToCatalog?: boolean;
                books: Array<{ entries: Array<Record<string, unknown>> }>;
            };
            expect(sData.catalogOnly).toBe(false);
            expect(sData.degradedToCatalog).toBeUndefined();
            expect(sData.books[0].entries).toHaveLength(1);
            expect(sData.books[0].entries[0].content).toBe('Short secret note under the bridge.');
        });
    });

    describe('Assistant 32 KB output gate, spillStore redaction safety, and /tmp/tool-spill/* read_file/grep_search', () => {
        it('soft-paginates large VFS files without spilling, and gates oversized plain text via redacted /tmp/tool-spill/*', async () => {
            const { vfs, spillStore, ctx, tools } = createToolHarness({
                toolCallId: 'call_big_file_1',
            });

            const lines: string[] = [];
            for (let i = 1; i <= 500; i += 1) {
                if (i === 250) {
                    lines.push(
                        `LINE_250_NEEDLE Authorization: Bearer live_spill_secret_777 api_key=sk-proj-spill-secret-999`,
                    );
                } else {
                    lines.push(`Line ${String(i).padStart(3, '0')}: ${'payload-segment-'.repeat(6)}`);
                }
            }
            const hugeText = lines.join('\n');
            expect(utf8ByteLength(hugeText)).toBeGreaterThan(DEFAULT_MAX_TOOL_RESULT_BYTES);

            await vfs.writeFile('/workspace/huge.log', hugeText, {
                target: ctx.target,
                staged: false,
            });

            const readTool = tools.get('read_file')!;
            const grepTool = tools.get('grep_search')!;

            // 1. VFS read_file soft-paginates directly (no redundant spill entry created for VFS file)
            const vfsReadRes = await executeAssistantTool(
                readTool,
                { path: '/workspace/huge.log' },
                ctx,
            );
            expect(vfsReadRes.ok).toBe(true);
            expect(vfsReadRes.truncated).toBe(true);
            expect(vfsReadRes.spillPath).toBeUndefined();
            expect(utf8ByteLength(vfsReadRes.output)).toBeLessThanOrEqual(24 * 1024);
            expect(vfsReadRes.output).toContain('lines 1-200 of 500');
            expect(vfsReadRes.output).toContain('next: start_line=201');
            expect(spillStore.get('/tmp/tool-spill/call_big_file_1.txt')).toBeNull();

            // 2. Non-VFS oversized plain-text tool output hits 32 KB gate and spills redacted content
            const giantPlainTool: AssistantToolDefinition = {
                name: 'giant_plain_dump',
                description: 'Simulates an oversized non-VFS text tool output.',
                parameters: z.object({}),
                tier: 'chat',
                readOnly: true,
                execute: () => finalizeReadToolResult(hugeText),
            };
            const readRes = await executeAssistantTool(giantPlainTool, {}, ctx);
            expect(readRes.ok).toBe(true);
            expect(readRes.truncated).toBe(true);
            expect(readRes.spillPath).toBe('/tmp/tool-spill/call_big_file_1.txt');
            expect(utf8ByteLength(readRes.output)).toBeLessThanOrEqual(
                DEFAULT_MAX_TOOL_RESULT_BYTES,
            );
            expect(readRes.hasSecretRedaction).toBe(true);
            expect(readRes.output).not.toContain('live_spill_secret_777');
            expect(readRes.output).not.toContain('sk-proj-spill-secret-999');

            // Spill store MUST hold only redacted text (zero raw secrets)
            const spilled = spillStore.get('/tmp/tool-spill/call_big_file_1.txt');
            expect(spilled).not.toBeNull();
            expect(spilled!.content).not.toContain('live_spill_secret_777');
            expect(spilled!.content).not.toContain('sk-proj-spill-secret-999');
            expect(spilled!.content).toContain(REDACTED_PLACEHOLDER);

            // read_file against /tmp/tool-spill/* returns numbered line slice
            const sliceRes = await executeAssistantTool(
                readTool,
                {
                    path: '/tmp/tool-spill/call_big_file_1.txt',
                    start_line: 249,
                    end_line: 251,
                },
                { ...ctx, toolCallId: 'call_slice_1' },
            );
            expect(sliceRes.ok).toBe(true);
            expect(sliceRes.truncated).toBeUndefined();
            expect(sliceRes.output).toContain('250| LINE_250_NEEDLE');
            expect(sliceRes.output).toContain(REDACTED_PLACEHOLDER);
            expect(sliceRes.output).not.toContain('live_spill_secret_777');

            // grep_search against /tmp/tool-spill/* finds exact line + context
            const grepRes = await executeAssistantTool(
                grepTool,
                {
                    query: 'LINE_250_NEEDLE',
                    path_prefix: '/tmp/tool-spill/call_big_file_1.txt',
                },
                { ...ctx, toolCallId: 'call_grep_1' },
            );
            expect(grepRes.ok).toBe(true);
            const hits = (
                grepRes.data as { results: Array<{ path: string; line: number; context?: string[] }> }
            ).results;
            expect(hits).toHaveLength(1);
            expect(hits[0].path).toBe('/tmp/tool-spill/call_big_file_1.txt');
            expect(hits[0].line).toBe(250);
            expect(hits[0].context?.some((c) => c.startsWith('>250|'))).toBe(true);

            // After session scope is cleared, /tmp/tool-spill/* returns clean error
            spillStore.clearScope(ctx.sessionId);
            const expiredRead = await executeAssistantTool(
                readTool,
                { path: '/tmp/tool-spill/call_big_file_1.txt', start_line: 1, end_line: 5 },
                { ...ctx, toolCallId: 'call_expired_read' },
            );
            expect(expiredRead.ok).toBe(false);
            expect(expiredRead.error).toContain('not found or expired');

            const expiredGrep = await executeAssistantTool(
                grepTool,
                { query: 'LINE_250_NEEDLE', path_prefix: '/tmp/tool-spill/call_big_file_1.txt' },
                { ...ctx, toolCallId: 'call_expired_grep' },
            );
            expect(expiredGrep.ok).toBe(false);
            expect(expiredGrep.error).toContain('not found or expired');
        });

        it('gates finalizeReadToolResult / finalizeMutationToolResult and redacts custom extraTools before spilling', async () => {
            const spillStore = new TransientToolSpillStore();

            // Direct finalizeReadToolResult with gate produces descending-byte JSON Key Manifest
            const gatedRead = finalizeReadToolResult(
                {
                    smallKey: 'ok',
                    apiKey: 'sk-proj-direct-secret-111',
                    giantKey: 'Z'.repeat(40_000),
                },
                {
                    gate: {
                        toolName: 'custom_reader',
                        toolCallId: 'call_direct_json',
                        spillStore,
                        scopeId: 'sess_1',
                    },
                },
            );
            expect(gatedRead.truncated).toBe(true);
            expect(gatedRead.spillPath).toBe('/tmp/tool-spill/call_direct_json.json');
            expect(gatedRead.hasSecretRedaction).toBe(true);
            expect(gatedRead.output).not.toContain('sk-proj-direct-secret-111');
            const parsedManifest = JSON.parse(gatedRead.output) as {
                truncated: boolean;
                manifest: Array<{ key: string }>;
                spillPath: string;
            };
            expect(parsedManifest.truncated).toBe(true);
            expect(parsedManifest.manifest[0].key).toBe('giantKey');
            expect(spillStore.get('/tmp/tool-spill/call_direct_json.json')!.content).not.toContain(
                'sk-proj-direct-secret-111',
            );

            // Direct finalizeMutationToolResult with gate enforces maxBytes
            const gatedMut = finalizeMutationToolResult(
                { hugeField: 'M'.repeat(40_000) },
                {
                    undoId: 'undo_1',
                    gate: {
                        toolName: 'custom_mutator',
                        toolCallId: 'call_direct_mut',
                        spillStore,
                        scopeId: 'sess_1',
                    },
                },
            );
            expect(gatedMut.truncated).toBe(true);
            expect(utf8ByteLength(gatedMut.output)).toBeLessThanOrEqual(
                DEFAULT_MAX_TOOL_RESULT_BYTES,
            );

            // Custom extraTool returning raw unredacted oversized output is STILL redacted before spilling!
            const { ctx } = createToolHarness({
                toolCallId: 'call_extra_tool',
                maxToolResultBytes: 4096,
            });
            const rogueExtraTool: AssistantToolDefinition = {
                name: 'rogue_extra_tool',
                description: 'Simulates an extra tool that skips finalizeReadToolResult.',
                parameters: z.object({}),
                tier: 'chat',
                readOnly: true,
                execute: () => ({
                    ok: true,
                    output: JSON.stringify({
                        token: 'ghp_RawExtraToolSecret123456',
                        payload: 'E'.repeat(10_000),
                    }),
                    data: {
                        token: 'ghp_RawExtraToolSecret123456',
                        payload: 'E'.repeat(10_000),
                    },
                    hasSecretRedaction: false,
                    redactionCount: 0,
                }),
            };

            const extraRes = await executeAssistantTool(rogueExtraTool, {}, ctx);
            expect(extraRes.ok).toBe(true);
            expect(extraRes.truncated).toBe(true);
            expect(extraRes.hasSecretRedaction).toBe(true);
            expect(extraRes.output).not.toContain('ghp_RawExtraToolSecret123456');
            expect(utf8ByteLength(extraRes.output)).toBeLessThanOrEqual(4096);
            const extraSpill = ctx.spillStore!.get(extraRes.spillPath!)!;
            expect(extraSpill.content).not.toContain('ghp_RawExtraToolSecret123456');
            expect(extraSpill.content).toContain(REDACTED_PLACEHOLDER);
        });
    });
});
