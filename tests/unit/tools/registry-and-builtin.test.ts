import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LoreReadEvaluator, TailRadar, WIClassifier } from '@/core/lore';
import { ChatDataStore, DATA_NAMESPACES, MESSAGE_OVERRIDE_KEY } from '@/core/store';
import {
    BUILTIN_TOOL_NAMES,
    ChatMessageViewAdapter,
    ToolRegistry,
    createBuiltinToolRegistry,
    createToolExecutionContext,
} from '@/core/tools';
import type { RawLoreEntry } from '@/core/types';
import { canonicalStringify } from '@/core/utils';
import { VirtualFileSystem } from '@/core/vfs';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function setupWorkspaceBridge() {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        characterFields: hollowChineseCard.characterFields,
        personaDescription: hollowChineseCard.personaDescription,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: '你好，我在找银莲花的线索。' });
    bridge.pushMessage({
        name: 'Assistant',
        isUser: false,
        mes: '初始回复正文。',
        swipes: ['初始回复正文。', '第二页候选正文。'],
        swipeInfo: [{}, {}],
    });
    return bridge;
}

describe('ToolRegistry & Built-in VFS / History / Message Tools', () => {
    it('produces byte-for-byte deterministic CanonicalToolSchema regardless of registration or input order', () => {
        const toolA = {
            name: 'zebra_tool',
            description: 'Zebra',
            parameters: z.object({
                zeta: z.string().describe('Z field'),
                alpha: z.number().default(1).describe('A field'),
            }),
            execute: async () => 'z',
        };
        const toolB = {
            name: 'alpha_tool',
            description: 'Alpha',
            parameters: z.object({
                nested: z.object({
                    second: z.boolean().optional(),
                    first: z.string(),
                }),
            }),
            execute: async () => 'a',
        };

        const reg1 = new ToolRegistry([toolA, toolB]);
        const reg2 = new ToolRegistry([toolB, toolA]);

        const schemas1 = reg1.toCanonicalSchemas(['zebra_tool', 'alpha_tool', 'alpha_tool']);
        const schemas2 = reg2.toCanonicalSchemas(['alpha_tool', 'zebra_tool']);

        expect(schemas1.map((s) => s.name)).toEqual(['alpha_tool', 'zebra_tool']);
        expect(canonicalStringify(schemas1)).toBe(canonicalStringify(schemas2));
        expect('$schema' in schemas1[0].parameters).toBe(false);
        expect('$id' in schemas1[0].parameters).toBe(false);
        // Optional default field `alpha` must NOT be marked required
        expect(schemas1[1].parameters.required).toEqual(['zeta']);

        // Preset BuiltinToolConfig overrides description & parameter descriptions cleanly
        const overridden = reg1.toCanonicalSchemas(['zebra_tool', 'alpha_tool'], {
            alpha_tool: { enabled: false },
            zebra_tool: {
                enabled: true,
                description: 'Custom Zebra Desc',
                parameters: { zeta: 'Overridden Z desc' },
            },
        });
        expect(overridden).toHaveLength(1);
        expect(overridden[0].description).toBe('Custom Zebra Desc');
        expect(
            (overridden[0].parameters.properties as Record<string, { description?: string }>).zeta.description,
        ).toBe('Overridden Z desc');
    });

    it('validates arguments with Zod v4 and returns self-healing field-path errors without crashing', async () => {
        const bridge = setupWorkspaceBridge();
        const registry = createBuiltinToolRegistry();
        registry.register({
            name: 'nested_check',
            description: 'Nested validation test',
            parameters: z.object({
                player: z.object({
                    hp: z.number().int().min(0),
                    role: z.enum(['scout', 'mage']),
                }),
            }),
            execute: async () => 'ok',
        });

        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const badJson = await registry.executeToolCall('read_file', '{not valid json', ctx);
        expect(badJson.ok).toBe(false);
        expect(badJson.output).toContain('Invalid JSON arguments');

        const missingTool = await registry.executeToolCall('nonexistent_tool', '{}', ctx);
        expect(missingTool.ok).toBe(false);
        expect(missingTool.error).toContain('Unknown tool "nonexistent_tool"');

        const badNested = await registry.executeToolCall(
            'nested_check',
            { player: { hp: -10, role: 'paladin' } },
            ctx,
        );
        expect(badNested.ok).toBe(false);
        const parsed = JSON.parse(badNested.output) as {
            ok: boolean;
            error: string;
            issues: Array<{ path: string }>;
        };
        expect(parsed.ok).toBe(false);
        expect(parsed.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['player.hp', 'player.role']));
        expect(parsed.error).toContain('player.hp');
        expect(parsed.error).toContain('player.role');
    });

    it('registers all 15 built-in tools and executes VFS tools through ScopedToolGuard', async () => {
        const bridge = setupWorkspaceBridge();
        const store = new ChatDataStore(bridge);
        const vfs = new VirtualFileSystem({ bridge, store });
        await vfs.writeFile('/memory/notes.md', '第一行\n关键词：银莲花\n第三行', {
            target: { messageId: 1, swipeId: 0 },
        });
        await vfs.writeFile('/secret/private.md', '绝密档案', {
            target: { messageId: 1, swipeId: 0 },
        });

        const registry = createBuiltinToolRegistry();
        expect(BUILTIN_TOOL_NAMES).toHaveLength(15);
        expect(BUILTIN_TOOL_NAMES).toContain('append_file');
        expect(registry.names().sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());

        const ctx = createToolExecutionContext({
            bridge,
            vfs,
            store,
            target: { messageId: 1, swipeId: 0 },
            permissions: {
                read: ['/memory/**', '/lorebooks/**', '/character/**', '/output.md'],
                write: ['/memory/**', '/output.md'],
            },
        });

        // Allowed list_dir, glob_files, search_files, grep_search, read_file, write_file, append_file, edit_file
        const listRes = JSON.parse((await registry.executeToolCall('list_dir', { path: '/memory' }, ctx)).output);
        expect(listRes.ok).toBe(true);
        expect(listRes.entries.map((e: { name: string }) => e.name)).toContain('notes.md');

        const globRes = JSON.parse((await registry.executeToolCall('glob_files', { pattern: '/memory/*.md' }, ctx)).output);
        expect(globRes.results).toEqual(['/memory/notes.md']);

        const grepRes = JSON.parse(
            (await registry.executeToolCall('grep_search', { query: '银莲花', path_prefix: '/memory' }, ctx)).output,
        );
        expect(grepRes.ok).toBe(true);
        expect(grepRes.results[0].path).toBe('/memory/notes.md');
        expect(grepRes.results[0].line).toBeGreaterThan(0);
        expect(grepRes.results[0].snippet).toContain('银莲花');

        const searchRes = JSON.parse(
            (await registry.executeToolCall('search_files', { query: '银莲花', path_prefix: '/lorebooks' }, ctx)).output,
        );
        expect(searchRes.ok).toBe(true);
        expect(searchRes.results[0].path).toBe('/lorebooks/霜烬纪元/银莲花结社档案-5.md');

        const writeRes = JSON.parse(
            (await registry.executeToolCall('write_file', { path: '/memory/clue.md', content: '线索：铜徽' }, ctx)).output,
        );
        expect(writeRes.ok).toBe(true);

        const appendRes = JSON.parse(
            (await registry.executeToolCall('append_file', { path: '/memory/clue.md', content: '（已核实）' }, ctx)).output,
        );
        expect(appendRes.ok).toBe(true);
        expect(appendRes.appendedBytes).toBeGreaterThan(0);

        const editRes = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    { path: '/memory/clue.md', search: '铜徽', replace: '银徽' },
                    ctx,
                )
            ).output,
        );
        expect(editRes.ok).toBe(true);
        expect((await registry.executeToolCall('read_file', { path: '/memory/clue.md' }, ctx)).output).toBe(
            '线索：银徽（已核实）',
        );

        // append_file on /output.md writes verbatim without auto-newline directly to bound message
        const outWrite = JSON.parse(
            (await registry.executeToolCall('write_file', { path: '/output.md', content: '前半句' }, ctx)).output,
        );
        expect(outWrite.ok).toBe(true);
        const outAppend = JSON.parse(
            (await registry.executeToolCall('append_file', { path: '/output.md', content: '后半句' }, ctx)).output,
        );
        expect(outAppend.ok).toBe(true);
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('前半句后半句');

        // Unauthorized read & write blocked by ScopedToolGuard
        const deniedRead = await registry.executeToolCall('read_file', { path: '/secret/private.md' }, ctx);
        expect(deniedRead.ok).toBe(false);
        expect(deniedRead.output).toContain('EACCES');

        const deniedWrite = await registry.executeToolCall(
            'write_file',
            { path: '/lorebooks/霜烬纪元/银莲花结社档案-5.md', content: 'tamper' },
            ctx,
        );
        expect(deniedWrite.ok).toBe(false);
        expect(deniedWrite.output).toContain('EACCES');

        const deniedAppend = await registry.executeToolCall(
            'append_file',
            { path: '/secret/private.md', content: 'tamper' },
            ctx,
        );
        expect(deniedAppend.ok).toBe(false);
        expect(deniedAppend.output).toContain('EACCES');

        // Path traversal blocked
        const traversal = await registry.executeToolCall(
            'read_file',
            { path: '/memory/../secret/private.md' },
            ctx,
        );
        expect(traversal.ok).toBe(false);
    });

    it('updates ctx.readSet with xxHash on full read_file so TailRadar suppresses duplicate lore hints', async () => {
        const bridge = setupWorkspaceBridge();
        const evaluator = new LoreReadEvaluator(bridge);
        const vfs = new VirtualFileSystem({
            bridge,
            loreReadHook: evaluator.toLoreReadHook(),
        });
        const radar = new TailRadar(evaluator);
        const classifier = new WIClassifier();
        const classified = classifier.classifyLorebooks(await bridge.listEnabledLorebooks());
        const readSet = new Map<string, string>();

        const scanBefore = await radar.scan(classified.all, {
            input: '调查银莲花铜徽的来历。',
            readSet,
        });
        expect(scanBefore.candidates).toHaveLength(1);
        const targetLorePath = scanBefore.candidates[0].path;

        const registry = createBuiltinToolRegistry();
        const ctx = createToolExecutionContext({
            bridge,
            vfs,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: [] },
            readSet,
        });

        // Partial line-slice read must NOT suppress the unread file in Read-Set
        const partial = await registry.executeToolCall(
            'read_file',
            { path: targetLorePath, start_line: 1, end_line: 3 },
            ctx,
        );
        expect(partial.ok).toBe(true);
        expect(readSet.has(targetLorePath)).toBe(false);

        // Full read updates Read-Set with xxHash matching LoreReadEvaluator
        const full = await registry.executeToolCall('read_file', { path: targetLorePath }, ctx);
        expect(full.ok).toBe(true);
        expect(full.output).toContain('三瓣银莲花铜徽');
        expect(readSet.get(targetLorePath)).toBe(scanBefore.candidates[0].contentHash);

        // TailRadar now stays silent for the unchanged entry
        const scanAfter = await radar.scan(classified.all, {
            input: '再次提到银莲花铜徽。',
            readSet,
        });
        expect(scanAfter.candidates).toHaveLength(0);
        expect(scanAfter.hintXml).toBe('');

        // Full read of /output.md MUST NEVER pollute ctx.readSet
        const outRead = await registry.executeToolCall('read_file', { path: '/output.md' }, ctx);
        expect(outRead.ok).toBe(true);
        expect(outRead.output).toBe('初始回复正文。');
        expect(readSet.has('/output.md')).toBe(false);
    });

    it('executes search_history and read_history strictly over /history/* within permissions', async () => {
        const bridge = setupWorkspaceBridge();
        const vfs = new VirtualFileSystem({ bridge });
        await vfs.writeHistoryInternal('/history/chunk-001.md', '第1轮：在灰港码头遇到林晚。\n第2轮：发现铜徽。');
        await vfs.writeHistoryInternal('/history/summary.md', '摘要：调查员与林晚结盟。');

        const registry = createBuiltinToolRegistry();
        const ctx = createToolExecutionContext({
            bridge,
            vfs,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: [] },
        });

        const fuzzy = JSON.parse(
            (await registry.executeToolCall('search_history', { query: '灰港码头' }, ctx)).output,
        );
        expect(fuzzy.ok).toBe(true);
        expect(fuzzy.results[0].path).toBe('/history/chunk-001.md');

        const grep = JSON.parse(
            (await registry.executeToolCall('search_history', { query: '铜徽', mode: 'grep' }, ctx)).output,
        );
        expect(grep.ok).toBe(true);
        expect(grep.results[0].path).toBe('/history/chunk-001.md');
        expect(grep.results[0].line).toBeGreaterThan(0);
        expect(grep.results[0].snippet).toContain('铜徽');

        // Accepts bare chunk filename or full /history/ path
        const chunk = await registry.executeToolCall('read_history', { chunk: 'chunk-001.md', start_line: 2, end_line: 2 }, ctx);
        expect(chunk.ok).toBe(true);
        expect(chunk.output).toBe('第2轮：发现铜徽。');

        // Rejects non-history paths & traversal
        const escaped = await registry.executeToolCall('read_history', { chunk: '/character/description.md' }, ctx);
        expect(escaped.ok).toBe(false);
        const trav = await registry.executeToolCall('read_history', { chunk: '../character/description.md' }, ctx);
        expect(trav.ok).toBe(false);
    });

    it('binds append_reply_view, replace_reply_view, and attach_media directly to ST messages on ctx.target and honors AbortSignal', async () => {
        const bridge = setupWorkspaceBridge();
        const store = new ChatDataStore(bridge);
        const registry = createBuiltinToolRegistry();

        // Bind context to messageId=1, swipeId=0, then advance chat to messageId=3 afterwards
        const target = { messageId: 1, swipeId: 0 };
        const ctx = createToolExecutionContext({
            bridge,
            store,
            target,
            permissions: { read: ['/**'], write: [] },
        });

        bridge.pushMessage({ name: 'User', isUser: true, mes: '后续消息 2' });
        bridge.pushMessage({ name: 'Assistant', isUser: false, mes: '后续回复 3' });

        // append_reply_view writes directly to target ST message (/output.md) and calls refreshMessageView,
        // without writing DATA_NAMESPACES.MESSAGE
        const appendRes = await registry.executeToolCall(
            'append_reply_view',
            { text: '[状态栏] 好感: 20' },
            ctx,
        );
        expect(appendRes.ok).toBe(true);
        expect(bridge.readChatMessage(target)).toBe('初始回复正文。\n[状态栏] 好感: 20');
        expect(bridge.chat[1].mes).toBe('初始回复正文。\n[状态栏] 好感: 20');
        expect(bridge.chat[1].swipes?.[0]).toBe('初始回复正文。\n[状态栏] 好感: 20');
        expect(bridge.chat[1].swipes?.[1]).toBe('第二页候选正文。');
        expect(bridge.chat[3].mes).toBe('后续回复 3');
        expect(store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, { target })).toBeNull();
        expect(bridge.refreshedViews).toContainEqual({ messageId: 1, swipeId: 0 });

        // Second append_reply_view accumulates cleanly on top of direct ST message content
        const appendRes2 = await registry.executeToolCall(
            'append_reply_view',
            { text: '[状态栏 2] 理智: 85' },
            ctx,
        );
        expect(appendRes2.ok).toBe(true);
        expect(bridge.readChatMessage(target)).toBe(
            '初始回复正文。\n[状态栏] 好感: 20\n[状态栏 2] 理智: 85',
        );
        expect(store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, { target })).toBeNull();

        // replace_reply_view directly updates ST message without writing DATA_NAMESPACES.MESSAGE
        const replaceRes = await registry.executeToolCall(
            'replace_reply_view',
            { text: '美化后的展示文本' },
            ctx,
        );
        expect(replaceRes.ok).toBe(true);
        expect(bridge.readChatMessage(target)).toBe('美化后的展示文本');
        expect(bridge.chat[1].mes).toBe('美化后的展示文本');
        expect(store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, { target })).toBeNull();

        // Direct ChatMessageViewAdapter without vfs option falls back to HostBridge.readChatMessage/writeChatMessage
        const directAdapter = new ChatMessageViewAdapter(
            bridge,
            store,
            { messageId: 1, swipeId: 1 },
            new AbortController().signal,
        );
        await directAdapter.appendView('[页2附注]');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 1 })).toBe('第二页候选正文。\n[页2附注]');
        expect(bridge.chat[1].mes).toBe('美化后的展示文本'); // inactive swipe does not overwrite active mes
        await directAdapter.replaceView('第二页重写');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 1 })).toBe('第二页重写');
        expect(store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, { target: { messageId: 1, swipeId: 1 } })).toBeNull();

        // attach_media binds strictly to frozen target #1#0
        const mediaRes = await registry.executeToolCall(
            'attach_media',
            { type: 'image', url: 'https://local.test/art.png', caption: '码头夜景' },
            ctx,
        );
        expect(mediaRes.ok).toBe(true);
        expect(bridge.mediaAttachments).toEqual([
            {
                target: { messageId: 1, swipeId: 0 },
                media: { type: 'image', url: 'https://local.test/art.png', caption: '码头夜景' },
            },
        ]);

        // Aborted signal rejects with AbortError and leaves bridge untouched
        const controller = new AbortController();
        controller.abort();
        const abortedCtx = createToolExecutionContext({
            bridge,
            store,
            target: { messageId: 3, swipeId: 0 },
            signal: controller.signal,
        });
        await expect(
            registry.executeToolCall('attach_media', { type: 'audio', url: '/voice.mp3' }, abortedCtx),
        ).rejects.toMatchObject({ name: 'AbortError' });
        await expect(
            registry.executeToolCall('append_reply_view', { text: 'should not write' }, abortedCtx),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(bridge.mediaAttachments).toHaveLength(1);
        expect(bridge.readChatMessage({ messageId: 3, swipeId: 0 })).toBe('后续回复 3');
        expect(store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, { target: { messageId: 3, swipeId: 0 } })).toBeNull();
    });

    it('supports minimal ToolFsApi without native grep, append, or read-range options via fallbacks', async () => {
        const bridge = setupWorkspaceBridge();
        const files: Record<string, string> = {
            '/notes/a.md': 'line 1\nline 2 target\nline 3',
        };
        const registry = createBuiltinToolRegistry();
        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
        });
        ctx.fs = {
            async read(path) {
                if (!(path in files)) throw new Error(`Missing ${path}`);
                return files[path];
            },
            async write(path, content) {
                files[path] = content;
            },
            async edit(path, oldText, newText) {
                files[path] = files[path].replace(oldText, newText);
                return { ok: true, path, message: 'ok' };
            },
            async list() {
                return [];
            },
            async search() {
                return [];
            },
            async glob() {
                return Object.keys(files);
            },
        };

        const sliceRes = await registry.executeToolCall(
            'read_file',
            { path: '/notes/a.md', start_line: 2, end_line: 2 },
            ctx,
        );
        expect(sliceRes.ok).toBe(true);
        expect(sliceRes.output).toBe('line 2 target');

        const appendFallbackExisting = await registry.executeToolCall(
            'append_file',
            { path: '/notes/a.md', content: '\nline 4' },
            ctx,
        );
        expect(appendFallbackExisting.ok).toBe(true);
        expect(files['/notes/a.md']).toBe('line 1\nline 2 target\nline 3\nline 4');

        const appendFallbackNew = await registry.executeToolCall(
            'append_file',
            { path: '/notes/new.md', content: 'fresh' },
            ctx,
        );
        expect(appendFallbackNew.ok).toBe(true);
        expect(files['/notes/new.md']).toBe('fresh');

        const grepRes = JSON.parse(
            (await registry.executeToolCall('grep_search', { query: 'target', path_prefix: '/notes' }, ctx)).output,
        );
        expect(grepRes.ok).toBe(true);
        expect(grepRes.results).toEqual([
            { path: '/notes/a.md', score: 1, line: 2, snippet: 'line 2 target' },
        ]);
    });
});
