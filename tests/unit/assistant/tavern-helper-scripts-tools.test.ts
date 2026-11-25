import { describe, expect, it } from 'vitest';
import {
    UndoStore,
    createAssistantUndoExecutor,
    createAuthorTools,
    createStAdminTools,
    executeAssistantTool,
    foldInlineBase64,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { ChatDataStore } from '@/core/store';
import { VirtualFileSystem } from '@/core/vfs';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';

function setupEnv() {
    const bridge = createOffMainlineTestBridge();
    bridge.extensionCapabilities = {
        tavernHelperScripts: true,
        tavernHelperAudio: true,
        ejsTemplate: true,
    };

    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({ bridge, store });
    const undoStore = new UndoStore();
    const trajectoryStore = new TrajectoryStore();
    const traceLogger = new TraceLogger();
    const settings = createDefaultSettings();

    const ctx: AssistantToolContext = {
        sessionId: 'ast_large_scripts',
        toolCallId: 'call_large_1',
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
    };

    const tools = new Map<string, AssistantToolDefinition>();
    for (const def of [...createAuthorTools(), ...createStAdminTools()]) {
        tools.set(def.name, def);
    }

    const undoExecutor = createAssistantUndoExecutor({ bridge, store, vfs });
    return { bridge, undoStore, undoExecutor, ctx, tools };
}

describe('Large TavernHelper scripts & raw World Info progressive drill-down', () => {
    it('auto-catalogs oversized scopes and reads target scripts after a 3MB Base64 sibling without truncation', async () => {
        const { bridge, ctx, tools } = setupEnv();
        const hugeBase64 = 'A'.repeat(3_200_000);
        const hugeScriptContent = [
            '// 01_时空穿梭开局器 header',
            `const bg = "data:image/png;base64,${hugeBase64}";`,
            'function bootWarp() {',
            '    return "WARP_READY";',
            '}',
        ].join('\n');
        const radarLines = [
            '// 02_战术雷达控制台 start',
            ...Array.from({ length: 240 }, (_, i) => `const sector_${i + 1} = ${i + 1};`),
            'const observer = new MutationObserver(() => renderRadar());',
            'function renderRadar() { return "RADAR_OK"; }',
        ];
        const radarScriptContent = radarLines.join('\n');

        bridge.tavernHelperScripts.character = [
            {
                type: 'script',
                id: 'script_00',
                name: '00_基础初始化',
                enabled: true,
                content: 'console.log("init");',
                data: {},
            },
            {
                type: 'script',
                id: 'script_01',
                name: '01_时空穿梭开局器',
                enabled: true,
                content: hugeScriptContent,
                data: { bigCache: 'B'.repeat(400_000) },
            },
            {
                type: 'script',
                id: 'script_02',
                name: '02_战术雷达控制台',
                enabled: true,
                content: radarScriptContent,
                data: { layout: 'compact' },
            },
        ];

        // 1. Default unfiltered read returns compact catalog instead of truncating at 2MB
        const catalogRes = await executeAssistantTool(
            tools.get('tavern_helper_scripts_read')!,
            { scope: 'character' },
            ctx,
        );
        expect(catalogRes.ok).toBe(true);
        expect(catalogRes.truncated).toBeUndefined();
        const catalogData = catalogRes.data as {
            mode: string;
            summaryOnly: boolean;
            scripts: Array<Record<string, unknown>>;
        };
        expect(catalogData.mode).toBe('catalog');
        expect(catalogData.summaryOnly).toBe(true);
        expect(catalogData.scripts).toHaveLength(3);
        expect(catalogData.scripts[1]!.name).toBe('01_时空穿梭开局器');
        expect(Number(catalogData.scripts[1]!.contentBytes)).toBeGreaterThan(3_000_000);
        expect(Number(catalogData.scripts[1]!.dataBytes)).toBeGreaterThan(400_000);
        expect(catalogData.scripts[2]!.name).toBe('02_战术雷达控制台');

        // 2. Targeted read reaches 02_战术雷达控制台 (supports lookup by name via scriptId) with pagination
        const page1 = await executeAssistantTool(
            tools.get('tavern_helper_scripts_read')!,
            { scope: 'character', scriptId: '02_战术雷达控制台' },
            ctx,
        );
        expect(page1.ok).toBe(true);
        const page1Script = (page1.data as { script: Record<string, unknown> }).script;
        expect(page1Script.id).toBe('script_02');
        expect(page1Script.shownStartLine).toBe(1);
        expect(page1Script.shownEndLine).toBe(200);
        expect(page1Script.hasMore).toBe(true);
        expect(String(page1Script.content)).toContain('1| // 02_战术雷达控制台 start');
        expect(String(page1Script.content)).toContain('tavern_helper_scripts_read');
        expect((page1Script.dataSummary as { keys: string[] }).keys).toEqual(['layout']);
        expect(page1Script.data).toBeUndefined();

        const page2 = await executeAssistantTool(
            tools.get('tavern_helper_scripts_read')!,
            { scope: 'character', scriptId: 'script_02', start_line: 201, end_line: 260 },
            ctx,
        );
        expect(page2.ok).toBe(true);
        const page2Script = (page2.data as { script: Record<string, unknown> }).script;
        expect(page2Script.hasMore).toBe(false);
        expect(String(page2Script.content)).toContain('242| const observer = new MutationObserver');

        // 3. Reading the 3MB script folds Base64 without altering 1-based line numbers
        const hugeRead = await executeAssistantTool(
            tools.get('tavern_helper_scripts_read')!,
            { scope: 'character', scriptId: 'script_01' },
            ctx,
        );
        expect(hugeRead.ok).toBe(true);
        const hugeScript = (hugeRead.data as { script: Record<string, unknown> }).script;
        expect(hugeScript.foldedBase64Count).toBe(1);
        expect(hugeScript.totalLines).toBe(5);
        expect(String(hugeScript.content)).toContain('[BASE64_OMITTED:3200000chars]');
        expect(String(hugeScript.content)).toContain('4|     return "WARP_READY";');
        expect(foldInlineBase64(hugeScriptContent).text.split('\n')).toHaveLength(5);

        // 4. Query grep searches across scripts without hitting 2MB cap
        const grepRes = await executeAssistantTool(
            tools.get('tavern_helper_scripts_read')!,
            { scope: 'character', query: 'MutationObserver', context_lines: 1 },
            ctx,
        );
        expect(grepRes.ok).toBe(true);
        const grepData = grepRes.data as {
            mode: string;
            matchCount: number;
            matches: Array<{ scriptId: string; line: number; context?: string[] }>;
        };
        expect(grepData.mode).toBe('search');
        expect(grepData.matchCount).toBe(1);
        expect(grepData.matches[0]!.scriptId).toBe('script_02');
        expect(grepData.matches[0]!.line).toBe(242);
        expect(grepData.matches[0]!.context?.some((c) => c.includes('>242|'))).toBe(true);
    });

    it('supports mode="edit_content" preserving huge Base64/data payloads, preview diffs, and surgical undo in folders', async () => {
        const { bridge, undoStore, undoExecutor, ctx, tools } = setupEnv();
        const hugeBase64 = 'Z'.repeat(3_100_000);
        const rawScript = [
            '// banner',
            `const img = "data:image/jpeg;base64,${hugeBase64}";`,
            'const mode = "lush";',
            'console.log(mode);',
        ].join('\n');

        bridge.tavernHelperScripts.global = [
            {
                type: 'folder',
                id: 'folder_ui',
                name: 'UI套件',
                enabled: true,
                scripts: [
                    {
                        type: 'script',
                        id: 'nested_ui',
                        name: '特效脚本',
                        enabled: true,
                        content: rawScript,
                        data: { preservedKey: 'stay-intact', blob: 'C'.repeat(200_000) },
                    },
                ],
            },
        ];

        const upsertTool = tools.get('tavern_helper_scripts_upsert')!;
        const args = {
            scope: 'global',
            mode: 'edit_content',
            scriptId: 'nested_ui',
            contentEdits: [
                {
                    search: 'const mode = "lush";',
                    replace: 'const mode = "lite";',
                    start_line: 3,
                    end_line: 4,
                },
            ],
        };

        // Preview folds Base64 cleanly and does not hang/bloat diff
        const preview = await upsertTool.preview!(args, ctx);
        expect(preview.beforeText).toContain('[BASE64_OMITTED:3100000chars]');
        expect(preview.afterText).toContain('const mode = "lite";');

        // Execute preserves exact untouched 3.1MB Base64 + data, returns compact summary
        const res = await executeAssistantTool(upsertTool, args, ctx);
        expect(res.ok).toBe(true);
        expect(res.truncated).toBeUndefined();
        const updatedChild = (
            bridge.tavernHelperScripts.global[0]!.scripts as Array<Record<string, unknown>>
        )[0]!;
        expect(String(updatedChild.content)).toContain(hugeBase64);
        expect(String(updatedChild.content)).toContain('const mode = "lite";');
        expect((updatedChild.data as { preservedKey: string }).preservedKey).toBe('stay-intact');

        // Surgical undo uses single-script snapshot and reverts cleanly
        const undoRecord = undoStore.get(res.undoId!);
        expect(undoRecord?.snapshot.action).toBe('tavern_helper_script_single');
        await undoStore.revert(res.undoId!, undoExecutor);

        const revertedChild = (
            bridge.tavernHelperScripts.global[0]!.scripts as Array<Record<string, unknown>>
        )[0]!;
        expect(revertedChild.content).toBe(rawScript);
    });

    it('auto-catalogs large raw World Info books and supports single-UID pagination & search', async () => {
        const { bridge, ctx, tools } = setupEnv();
        const largeBookEntries = Array.from({ length: 12 }, (_, idx) => ({
            uid: idx + 1,
            world: '雾港侦探录',
            comment: `Entry ${idx + 1}`,
            keys: [`k${idx + 1}`],
            keysecondary: [],
            content:
                idx === 11
                    ? [
                        '@@activate',
                        `const icon = "data:image/png;base64,${'D'.repeat(20_000)}";`,
                        ...Array.from({ length: 220 }, (__, l) => `Line ${l + 1}: target anchor HERE`),
                    ].join('\n')
                    : `Padding entry ${idx + 1}: ` + 'X'.repeat(2500),
            selective: true,
            disable: false,
            constant: false,
            position: 0,
            depth: 4,
            order: idx,
            role: 0,
        }));
        bridge.lorebooks.set('雾港侦探录', largeBookEntries);

        const wiRead = tools.get('wi_read_raw_book')!;

        // 1. Auto-catalog when total > 24KB
        const catalogRes = await executeAssistantTool(wiRead, { bookName: '雾港侦探录' }, ctx);
        expect(catalogRes.ok).toBe(true);
        const catalogData = catalogRes.data as {
            mode: string;
            summaryOnly: boolean;
            entries: Array<{ uid: number; contentBytes: number }>;
        };
        expect(catalogData.mode).toBe('catalog');
        expect(catalogData.summaryOnly).toBe(true);
        expect(catalogData.entries).toHaveLength(12);

        // 2. Targeted uid read folds Base64 and paginates lines cleanly
        const uidPage1 = await executeAssistantTool(wiRead, { bookName: '雾港侦探录', uid: 12 }, ctx);
        expect(uidPage1.ok).toBe(true);
        const uidData = uidPage1.data as {
            mode: string;
            foldedBase64Count: number;
            hasMore: boolean;
            content: string;
        };
        expect(uidData.mode).toBe('entry');
        expect(uidData.foldedBase64Count).toBe(1);
        expect(uidData.hasMore).toBe(true);
        expect(uidData.content).toContain('1| @@activate');
        expect(uidData.content).toContain('[BASE64_OMITTED:20000chars]');
        expect(uidData.content).toContain('wi_read_raw_book');

        // 3. Query search pinpoints line number
        const searchRes = await executeAssistantTool(
            wiRead,
            { bookName: '雾港侦探录', query: 'target anchor HERE', max_matches: 3 },
            ctx,
        );
        expect(searchRes.ok).toBe(true);
        const searchData = searchRes.data as {
            mode: string;
            matchCount: number;
            matches: Array<{ uid: number; line: number }>;
        };
        expect(searchData.mode).toBe('search');
        expect(searchData.matchCount).toBe(3);
        expect(searchData.matches[0]).toMatchObject({ uid: 12, line: 3 });
    });

    it('allows wi_read_raw_book to read globally enabled books without a primary bound lorebook, and disabled books only with stAdminEnabled', async () => {
        const { bridge, ctx, tools } = setupEnv();
        bridge.primaryWorldName = null;
        const activeChar = bridge.characters.find((c) => c.chid === bridge.activeCharacterId);
        if (activeChar) {
            activeChar.primaryWorld = undefined;
            if (activeChar.extensions) {
                delete activeChar.extensions.world;
            }
            if (activeChar.data && typeof activeChar.data === 'object') {
                const ext = (activeChar.data as Record<string, unknown>).extensions;
                if (ext && typeof ext === 'object') {
                    delete (ext as Record<string, unknown>).world;
                }
            }
        }

        bridge.setLorebook('___生理系统v3', [
            {
                uid: 1,
                world: '___生理系统v3',
                comment: 'EJS 状态结算',
                keys: ['生理'],
                keysecondary: [],
                content: '@@activate\n<% const hp = getvar("hp"); %>\n状态=<%= hp %>',
                selective: false,
                disable: false,
                constant: true,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
        ]);
        bridge.setDisabledLorebook('DisabledBook', [
            {
                uid: 9,
                world: 'DisabledBook',
                comment: 'Disabled Entry',
                keys: ['secret'],
                keysecondary: [],
                content: '@@system\n<% if (true) { %>hidden<% } %>',
                selective: false,
                disable: false,
                constant: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
        ]);

        const wiRead = tools.get('wi_read_raw_book')!;
        const wiUpsertPrimary = tools.get('wi_upsert_primary_entry')!;

        // 1. Reading globally enabled book succeeds in author & full without stAdminEnabled
        for (const mode of ['author', 'full'] as const) {
            const modeCtx: AssistantToolContext = { ...ctx, mode, stAdminEnabled: false };
            const res = await executeAssistantTool(
                wiRead,
                { bookName: '___生理系统v3' },
                modeCtx,
            );
            expect(res.ok).toBe(true);
            const data = res.data as {
                bookName: string;
                entries: Array<{ uid: number; content: string }>;
            };
            expect(data.bookName).toBe('___生理系统v3');
            expect(data.entries[0]?.content).toContain('@@activate');
            expect(data.entries[0]?.content).toContain('<% const hp = getvar("hp"); %>');

            const uidRes = await executeAssistantTool(
                wiRead,
                { bookName: '___生理系统v3', uid: 1 },
                modeCtx,
            );
            expect(uidRes.ok).toBe(true);
            expect((uidRes.data as { content: string }).content).toContain('1| @@activate');

            const queryRes = await executeAssistantTool(
                wiRead,
                { bookName: '___生理系统v3', query: 'getvar' },
                modeCtx,
            );
            expect(queryRes.ok).toBe(true);
            expect((queryRes.data as { matchCount: number }).matchCount).toBe(1);
        }

        // 2. Omitting bookName when no primary is bound returns helpful error listing enabled books
        const omittedRes = await executeAssistantTool(wiRead, {}, { ...ctx, stAdminEnabled: false });
        expect(omittedRes.ok).toBe(false);
        expect(omittedRes.error).toContain('no primary bound World Info book');
        expect(omittedRes.error).toContain('___生理系统v3');

        // 3. Primary mutation tools remain strictly gated to bound primary book
        const upsertPrimaryRes = await executeAssistantTool(
            wiUpsertPrimary,
            { bookName: '___生理系统v3', content: 'blocked' },
            { ...ctx, mode: 'full', stAdminEnabled: false },
        );
        expect(upsertPrimaryRes.ok).toBe(false);
        expect(upsertPrimaryRes.error).toContain('no primary bound World Info book');

        // 4. Disabled book is rejected when stAdminEnabled is false (in both author & full)
        for (const mode of ['author', 'full'] as const) {
            const disabledBlocked = await executeAssistantTool(
                wiRead,
                { bookName: 'DisabledBook' },
                { ...ctx, mode, stAdminEnabled: false },
            );
            expect(disabledBlocked.ok).toBe(false);
            expect(disabledBlocked.error).toContain('not currently enabled');
        }

        // 5. Disabled book succeeds in full + stAdminEnabled: true
        const disabledAdminOk = await executeAssistantTool(
            wiRead,
            { bookName: 'DisabledBook' },
            { ...ctx, mode: 'full', stAdminEnabled: true },
        );
        expect(disabledAdminOk.ok).toBe(true);
        const disabledData = disabledAdminOk.data as {
            bookName: string;
            entries: Array<{ content: string }>;
        };
        expect(disabledData.bookName).toBe('DisabledBook');
        expect(disabledData.entries[0]?.content).toContain('<% if (true) { %>hidden<% } %>');
    });
});
