import { describe, expect, it, vi } from 'vitest';
import type { RawLoreEntry } from '@/core/types';
import {
    OUTPUT_FILE_PATH,
    VfsError,
    VfsInvalidPathError,
    VfsNotFoundError,
    VfsReadOnlyError,
    VirtualFileSystem,
} from '@/core/vfs';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function createFixtureBridge(): MemoryHostBridge {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        characterFields: hollowChineseCard.characterFields,
        personaDescription: hollowChineseCard.personaDescription,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'hello' });
    bridge.pushMessage({
        name: 'Assistant',
        isUser: false,
        mes: 'reply',
        swipes: ['reply s0', 'reply s1'],
        swipeInfo: [{}, {}],
    });
    return bridge;
}

describe('VirtualFileSystem', () => {
    it('exposes all 9 mount topologies at root and handles / workspace + /state/variables.json with swipe isolation', async () => {
        const bridge = createFixtureBridge();
        bridge.setVariable('gold', 50); // legacy metadata.variables overlaid on [InitVar]

        const vfs = new VirtualFileSystem({ bridge });

        const rootEntries = await vfs.listDir('/');
        const rootNames = rootEntries.map((e) => e.name);
        expect(rootNames).toEqual(
            expect.arrayContaining([
                'character',
                'global',
                'history',
                'lorebooks',
                'persona',
                'preset',
                'skills',
                'state',
            ]),
        );

        // /state/variables.json aligns [InitVar] (uid 8) + metadata.variables with deterministic sorted keys
        const initVarsRaw = await vfs.readFile('/state/variables.json');
        expect(JSON.parse(initVarsRaw)).toEqual({
            favorability: 20,
            gold: 50,
            hp: 100,
            location: '灰港码头',
            sanity: 85,
        });

        // Workspace / files + /state/generated_context.md co-exist with /state/variables.json
        await vfs.writeFile('/notes/clue.md', '第一条线索\n第二行\n第三行');
        await vfs.writeFile('/state/generated_context.md', '动态摘要');
        expect(await vfs.readFile('/notes/clue.md', { startLine: 2, endLine: 3 })).toBe('第二行\n第三行');

        const stateEntries = await vfs.listDir('/state');
        expect(stateEntries.map((e) => e.name)).toEqual([
            'chat_variables.json',
            'generated_context.md',
            'global_variables.json',
            'variables.json',
        ]);

        // Edit and swipe isolation on /state/variables.json (backed by chat[1].variables[swipeId])
        const editRes = await vfs.editFile('/state/variables.json', '"hp": 100', '"hp": 75', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(editRes.ok).toBe(true);
        expect((await vfs.readVariables({ target: { messageId: 1, swipeId: 0 } })).hp).toBe(75);
        expect((await vfs.readVariables({ target: { messageId: 1, swipeId: 1 } })).hp).toBe(100);
        expect(bridge.chat[1].variables?.[0]?.hp).toBe(75);

        // /state/chat_variables.json <-> bridge.metadata.variables & /state/global_variables.json <-> bridge.metadata.globalVariables
        await vfs.writeFile('/state/chat_variables.json', JSON.stringify({ gold: 120, quest: 'active' }));
        expect(bridge.metadata.variables).toEqual({ gold: 120, quest: 'active' });
        bridge.setVariable('externalChatKey', 'hello');
        expect(JSON.parse(await vfs.readFile('/state/chat_variables.json'))).toEqual({
            externalChatKey: 'hello',
            gold: 120,
            quest: 'active',
        });

        await vfs.writeFile('/state/global_variables.json', JSON.stringify({ globalMode: 'hardcore' }));
        expect(bridge.metadata.globalVariables).toEqual({ globalMode: 'hardcore' });
        bridge.setGlobalVariable('externalGlobal', 42);
        expect(JSON.parse(await vfs.readFile('/state/global_variables.json'))).toEqual({
            externalGlobal: 42,
            globalMode: 'hardcore',
        });

        // Reject invalid JSON write to /state/variables.json
        await expect(vfs.writeFile('/state/variables.json', '{bad json')).rejects.toThrow();

        // Staged write + commit/rollback through store
        await vfs.writeFile('/draft.md', 'temp draft', { target: { messageId: 1, swipeId: 1 }, staged: true });
        expect(await vfs.readFile('/draft.md', { target: { messageId: 1, swipeId: 1 } })).toBe('temp draft');
        expect(await vfs.readFile('/draft.md', { target: { messageId: 1, swipeId: 1 }, staged: false }).catch((e) => e)).toBeInstanceOf(
            VfsNotFoundError,
        );
        vfs.store.commitStagedData({ messageId: 1, swipeId: 1 });
        expect(await vfs.readFile('/draft.md', { target: { messageId: 1, swipeId: 1 }, staged: false })).toBe(
            'temp draft',
        );
    });

    it('mounts /character/* and /persona/* skipping empty fields and first_mes, with allowlisted overlays', async () => {
        const bridge = createFixtureBridge();
        const vfs = new VirtualFileSystem({ bridge });

        const charFiles = await vfs.listDir('/character');
        const charNames = charFiles.map((f) => f.name);
        expect(charNames).toContain('description.md');
        expect(charNames).not.toContain('first_mes.md');
        expect(charNames).not.toContain('personality.md');
        expect(charNames).not.toContain('scenario.md');

        expect(await vfs.readFile('/character/description.md')).toContain('空壳卡片');
        expect(await vfs.readFile('/persona/description.md')).toContain('北方学院');

        // Base snapshot and non-allowlisted overlay paths are strictly read-only
        await expect(vfs.writeFile('/character/description.md', 'hack')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.writeFile('/character/notes.md', 'hack')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.writeFile('/persona/description.md', 'hack')).rejects.toBeInstanceOf(VfsReadOnlyError);

        // Allowlisted overlay files CONSTRAINTS.md / LESSONS.md are writable and scoped by avatar + swipe
        await vfs.writeFile('/character/CONSTRAINTS.md', '不要抢话', { target: { messageId: 1, swipeId: 0 } });
        await vfs.writeFile('/persona/LESSONS.md', '记住暗号', { target: { messageId: 1, swipeId: 0 } });
        expect(await vfs.readFile('/character/CONSTRAINTS.md', { target: { messageId: 1, swipeId: 0 } })).toBe('不要抢话');
        expect(await vfs.readFile('/persona/LESSONS.md', { target: { messageId: 1, swipeId: 0 } })).toBe('记住暗号');

        // Switching active character avatar isolates overlays cleanly
        bridge.identity.characterAvatar = 'other-char.png';
        await expect(vfs.readFile('/character/CONSTRAINTS.md')).rejects.toBeInstanceOf(VfsNotFoundError);
    });

    it('mounts /lorebooks with ro base, rw causal overrides, @@ escape safety, and injectable LoreReadHook', async () => {
        const bridge = createFixtureBridge();
        const hookCalls: Array<{ world: string; uid: number; overridden?: string }> = [];
        const loreHook = vi.fn(async (ctx) => {
            hookCalls.push({ world: ctx.world, uid: ctx.uid, overridden: ctx.overriddenContent });
            const base = ctx.overriddenContent ?? ctx.rawContent;
            return bridge.substituteMacros(base);
        });

        const vfs = new VirtualFileSystem({ bridge, loreReadHook: loreHook });

        const bookEntries = await vfs.listDir('/lorebooks/霜烬纪元');
        const names = bookEntries.map((e) => e.name);
        // Plain entries (uid 2..7) and @@replace (uid 9) exist; @@skill (uid 12), [InitVar] (uid 8), @@agent (uid 13) do not
        expect(names).toContain('银莲花结社档案-5.md');
        expect(names).toContain('动态事件日志-9.md');
        expect(names.some((n) => n.endsWith('-8.md'))).toBe(false);
        expect(names.some((n) => n.endsWith('-12.md'))).toBe(false);
        expect(names.some((n) => n.endsWith('-13.md'))).toBe(false);

        const targetPath = '/lorebooks/霜烬纪元/银莲花结社档案-5.md';
        const initialContent = await vfs.readFile(targetPath, { target: { messageId: 1, swipeId: 0 } });
        expect(initialContent).toContain('world: 霜烬纪元');
        expect(initialContent).toContain('uid: 5');
        expect(initialContent).toContain('三瓣银莲花铜徽');
        expect(loreHook).toHaveBeenCalledTimes(1);

        // Write override with leading @@ escalation attempt -> escaped in storage, restored on read
        await vfs.writeFile(targetPath, '@@replace\n新线索：{{user}} 已取得铜徽。', {
            target: { messageId: 1, swipeId: 0 },
        });
        const rawStored = vfs.store.get('worldinfo', '霜烬纪元/5', { target: { messageId: 1, swipeId: 0 } })?.content;
        expect(rawStored?.startsWith('@@@replace')).toBe(true);

        const overriddenRead = await vfs.readFile(targetPath, { target: { messageId: 1, swipeId: 0 } });
        expect(overriddenRead).toContain('新线索：沈默 已取得铜徽。');
        expect(hookCalls[1].overridden).toContain('新线索：{{user}} 已取得铜徽。');

        // Frontmatter mismatch rejection
        await expect(
            vfs.writeFile(targetPath, '---\nworld: 霜烬纪元\nuid: 999\n---\n篡改'),
        ).rejects.toThrow(/does not match/);

        // Delete override restores original book text
        expect(await vfs.deleteFile(targetPath, { target: { messageId: 1, swipeId: 0 } })).toBe(true);
        const restored = await vfs.readFile(targetPath, { target: { messageId: 1, swipeId: 0 } });
        expect(restored).toContain('地下互助会');
        expect(restored).not.toContain('已取得铜徽');
    });

    it('mounts /skills, /preset, /global, and /history with proper ro/rw and internal compaction write semantics', async () => {
        const bridge = createFixtureBridge();
        let presetFiles: Record<string, string> = {
            'style-guide.md': '冷峻写实文风指南',
            '/nested/template.md': '模板文本',
        };
        const vfs = new VirtualFileSystem({
            bridge,
            getPresetFiles: () => presetFiles,
        });

        // /skills/<name>.md
        const skills = await vfs.listDir('/skills');
        expect(skills.map((s) => s.name)).toEqual(['rune-decode.md']);
        const skillText = await vfs.readFile('/skills/rune-decode.md');
        expect(skillText).toContain('skill: rune-decode');
        expect(skillText).toContain('古代灵能铭文破译');
        await expect(vfs.writeFile('/skills/rune-decode.md', 'x')).rejects.toBeInstanceOf(VfsReadOnlyError);

        // /preset/*
        expect(await vfs.readFile('/preset/style-guide.md')).toBe('冷峻写实文风指南');
        expect(await vfs.readFile('/preset/nested/template.md')).toBe('模板文本');
        await expect(vfs.writeFile('/preset/style-guide.md', 'x')).rejects.toBeInstanceOf(VfsReadOnlyError);
        presetFiles = { 'updated.md': '新预设文件' };
        expect(await vfs.readFile('/preset/updated.md')).toBe('新预设文件');

        // /global/* persists via HostBridge extension storage even with concurrent writes
        await Promise.all([
            vfs.writeFile('/global/prefs.md', '偏好设置'),
            vfs.writeFile('/global/kb/glossary.md', '术语表'),
        ]);
        const vfs2 = new VirtualFileSystem({ bridge: new MemoryHostBridge({ extensionData: Object.fromEntries(bridge.extensionData) }) });
        expect(await vfs2.readFile('/global/prefs.md')).toBe('偏好设置');
        expect(await vfs2.readFile('/global/kb/glossary.md')).toBe('术语表');

        // /history/* is strictly ro for normal write/edit/delete, writable via internal compaction API
        await expect(vfs.writeFile('/history/chunk-001.md', 'forged')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.writeFile('/history/summary.md', 'forged')).rejects.toBeInstanceOf(VfsReadOnlyError);

        await vfs.writeHistoryInternal('/history/chunk-001.md', '第 1-5 轮对话归档');
        await vfs.writeHistoryInternal('summary.md', '前情提要：调查员抵达灰港。');
        expect(await vfs.readFile('/history/chunk-001.md')).toBe('第 1-5 轮对话归档');
        expect(await vfs.readFile('/history/summary.md')).toBe('前情提要：调查员抵达灰港。');
        await expect(vfs.editFile('/history/summary.md', '灰港', '新港')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.deleteFile('/history/chunk-001.md')).rejects.toBeInstanceOf(VfsReadOnlyError);
    });

    it('supports minisearch ranked searchFiles, grepSearch, globFiles, and rejects .. traversal', async () => {
        const bridge = createFixtureBridge();
        const vfs = new VirtualFileSystem({ bridge });
        await vfs.writeFile('/memory/session-note.md', '调查员记录：今晚前往旧灯塔酒馆核实银莲花线索。');
        await vfs.writeHistoryInternal('/history/chunk-001.md', '归档：在码头听到守夜人应急协议的传闻。');

        // MiniSearch ranks lorebook entry with explicit key/title boost at the top
        const hits = await vfs.searchFiles('银莲花 铜徽');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].path).toBe('/lorebooks/霜烬纪元/银莲花结社档案-5.md');
        expect(hits[0].score).toBeGreaterThan(0);

        const scopedHits = await vfs.searchFiles('应急协议', { pathPrefix: '/history' });
        expect(scopedHits).toHaveLength(1);
        expect(scopedHits[0].path).toBe('/history/chunk-001.md');

        // Grep search
        const grepHits = await vfs.grepSearch('三瓣银莲花铜徽', '/lorebooks');
        expect(grepHits).toHaveLength(1);
        expect(grepHits[0].path).toBe('/lorebooks/霜烬纪元/银莲花结社档案-5.md');
        expect(grepHits[0].line).toBeGreaterThan(0);

        // Glob files
        const loreGlobs = await vfs.globFiles('/lorebooks/**/*.md');
        expect(loreGlobs).toContain('/lorebooks/霜烬纪元/核心人物林晚-3.md');
        expect(loreGlobs).toContain('/lorebooks/霜烬纪元/银莲花结社档案-5.md');

        // Reject .. traversal
        await expect(vfs.readFile('/lorebooks/../character/description.md')).rejects.toBeInstanceOf(
            VfsInvalidPathError,
        );
        await expect(vfs.globFiles('/lorebooks/../**/*.md')).rejects.toBeInstanceOf(VfsInvalidPathError);
    });

    it('mounts /output.md with strict non-inheritance across floors/swipes, pre-create buffers, and appendFile', async () => {
        const bridge = createFixtureBridge();
        const vfs = new VirtualFileSystem({ bridge });

        // Root listDir surfaces output.md alongside mount directories
        const rootEntries = await vfs.listDir('/');
        const outputStat = rootEntries.find((e) => e.name === 'output.md');
        expect(outputStat).toMatchObject({
            path: OUTPUT_FILE_PATH,
            name: 'output.md',
            kind: 'file',
            writable: true,
            mount: 'output',
        });

        // Strict non-layered reads: swipe 0, swipe 1, and non-existent message 2 never inherit from message 1
        expect(await vfs.readFile('/output.md', { target: { messageId: 1, swipeId: 0 } })).toBe('reply s0');
        expect(await vfs.readFile('output.md', { target: { messageId: 1, swipeId: 1 } })).toBe('reply s1');
        expect(await vfs.readFile('/output.md', { target: { messageId: 2, swipeId: 0 } })).toBe('');
        expect(await vfs.readFile('/output.md', { target: { messageId: 1, swipeId: 5 } })).toBe('');

        // Write, verbatim append (no auto-newline), edit, and delete on exact branch
        await vfs.writeFile('/output.md', '第一段', { target: { messageId: 1, swipeId: 0 } });
        await vfs.appendFile('/output.md', '，紧接续写。', { target: { messageId: 1, swipeId: 0 } });
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('第一段，紧接续写。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 1 })).toBe('reply s1');

        const editRes = await vfs.editFile('/output.md', '紧接续写', '原地修正', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(editRes.ok).toBe(true);
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('第一段，原地修正。');

        expect(await vfs.deleteFile('/output.md', { target: { messageId: 1, swipeId: 0 } })).toBe(true);
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('');

        // Companion before_turn pre-create buffer when target message doesn't exist yet
        const preTarget = { messageId: 2, swipeId: 0 };
        await vfs.writeFile('/output.md', '前置', { target: preTarget });
        await vfs.appendFile('/output.md', '状态栏', { target: preTarget });
        expect(vfs.peekPreCreateBuffer(preTarget)).toBe('前置状态栏');
        expect(await vfs.readFile('/output.md', { target: preTarget })).toBe('前置状态栏');
        expect(await vfs.editFile('/output.md', '状态栏', '提示卡', { target: preTarget })).toMatchObject({
            ok: true,
        });
        expect(vfs.flushPreCreateBuffer(preTarget)).toBe('前置提示卡');
        expect(vfs.peekPreCreateBuffer(preTarget)).toBeUndefined();

        // clearPreCreateBuffersFrom prunes >= messageId without touching earlier targets
        await vfs.writeFile('/output.md', 'buf2', { target: { messageId: 2, swipeId: 0 } });
        await vfs.writeFile('/output.md', 'buf3', { target: { messageId: 3, swipeId: 0 } });
        vfs.clearPreCreateBuffersFrom(3);
        expect(vfs.peekPreCreateBuffer({ messageId: 2, swipeId: 0 })).toBe('buf2');
        expect(vfs.peekPreCreateBuffer({ messageId: 3, swipeId: 0 })).toBeUndefined();

        // Once host creates message 2, readFile/writeFile sync directly and clear stale pre-create buffer
        bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'host created' });
        expect(await vfs.readFile('/output.md', { target: preTarget })).toBe('host created');
        expect(vfs.peekPreCreateBuffer(preTarget)).toBeUndefined();

        // Workspace appendFile & read-only mount rejection
        await vfs.appendFile('/memory/stream.md', 'A');
        await vfs.appendFile('/memory/stream.md', 'B');
        expect(await vfs.readFile('/memory/stream.md')).toBe('AB');
        await expect(vfs.appendFile('/skills/rune-decode.md', 'hack')).rejects.toBeInstanceOf(VfsReadOnlyError);

        // Empty chat without target throws EINVAL on writeFile and returns '' on readFile
        const emptyVfs = new VirtualFileSystem({ bridge: new MemoryHostBridge() });
        expect(await emptyVfs.readFile('/output.md')).toBe('');
        await expect(emptyVfs.writeFile('/output.md', 'x')).rejects.toMatchObject({
            code: 'EINVAL',
        });
        await expect(emptyVfs.writeFile('/output.md', 'x')).rejects.toBeInstanceOf(VfsError);
    });

    it('preserves full /output.md content during line-scoped edits (startLine/endLine)', async () => {
        const bridge = createFixtureBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const target = { messageId: 1, swipeId: 0 };

        const initialLines = Array.from({ length: 10 }, (_, idx) => `Line ${idx + 1}: original`);
        await vfs.writeFile('/output.md', initialLines.join('\n'), { target });

        // Multi-edit with top-level startLine/endLine lifted from the first op (mirrors edit_file tool)
        const multiEditRes = await vfs.editFile('/output.md', 'Line 4: original', 'Line 4: updated', {
            target,
            startLine: 4,
            endLine: 5,
            edits: [
                { search: 'Line 4: original', replace: 'Line 4: updated', startLine: 4, endLine: 5 },
                { search: 'Line 8: original', replace: 'Line 8: updated', startLine: 8, endLine: 9 },
            ],
        });
        expect(multiEditRes).toMatchObject({
            ok: true,
            replacements: 2,
            totalLines: 10,
        });
        const afterMulti = (bridge.readChatMessage(target) ?? '').split('\n');
        expect(afterMulti).toHaveLength(10);
        expect(afterMulti[0]).toBe('Line 1: original');
        expect(afterMulti[3]).toBe('Line 4: updated');
        expect(afterMulti[7]).toBe('Line 8: updated');
        expect(afterMulti[9]).toBe('Line 10: original');

        // Single edit starting at line 1 must not truncate lines 3..10
        const headEditRes = await vfs.editFile('/output.md', 'Line 1: original', 'Line 1: head-updated', {
            target,
            startLine: 1,
            endLine: 2,
        });
        expect(headEditRes).toMatchObject({
            ok: true,
            replacements: 1,
            totalLines: 10,
        });
        const afterHead = (bridge.readChatMessage(target) ?? '').split('\n');
        expect(afterHead).toHaveLength(10);
        expect(afterHead[0]).toBe('Line 1: head-updated');
        expect(afterHead[3]).toBe('Line 4: updated');
        expect(afterHead[7]).toBe('Line 8: updated');
        expect(afterHead[9]).toBe('Line 10: original');
    });

    it('excludes ST-Prompt-Template special entries from /lorebooks/* and parses @@initial_variables into /state/variables.json', async () => {
        const specialEntries: RawLoreEntry[] = [
            {
                world: 'SpecialBook',
                uid: 1,
                comment: 'Normal Setting',
                content: '灰港北街设定。',
                keys: ['北街'],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 2,
                comment: 'Status Bar',
                content: '@@render_after\n@@iframe 状态栏\n<div><%- vars.hp %></div>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 4,
                depth: 0,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 3,
                comment: 'Only Preload',
                content: '@@only_preload\n<% define("x", 1); %>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 4,
                comment: '@INJECT pos=1',
                content: '注入内容',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 5,
                comment: 'Initial Vars',
                content: '@@initial_variables\nhp: 120\nrank: "A"',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 6,
                comment: 'Blocked Entry',
                content: '@@dont_activate\n隐藏条目',
                keys: ['隐藏'],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 7,
                comment: 'Json Schema Entry',
                content: '@@json_schema {"type":"object","properties":{"hp":{"type":"number"}}}',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
            {
                world: 'SpecialBook',
                uid: 8,
                comment: 'Zod Schema Entry',
                content: '@@zod_schema z.object({ hp: z.number() })',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
        ];

        const bridge = new MemoryHostBridge({
            lorebooks: { SpecialBook: specialEntries },
        });
        bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
        const vfs = new VirtualFileSystem({ bridge });

        const files = await vfs.listDir('/lorebooks/SpecialBook');
        expect(files.map((f) => f.name)).toEqual(['Normal-Setting-1.md']);
        expect(JSON.parse(await vfs.readFile('/state/variables.json'))).toEqual({
            hp: 120,
            rank: 'A',
        });
    });

    it('evaluates macros and optional EJS by default across template mounts while preserving raw: true and keeping non-template mounts verbatim', async () => {
        const bridge = new MemoryHostBridge({
            identity: {
                userName: '铃木丸太',
                charName: '爱丽丝',
                characterAvatar: 'alice.png',
                personaAvatar: 'maruta.png',
            },
            characterFields: {
                description: '标题 {{char}}，{{user}} 扮演路人。\n<% if (Number(vars.trust) >= 50) { %>\n秘密：信任已达标(<%= vars.trust %>)。\n<% } else { %>\n秘密：尚在观察。\n<% } %>',
            },
            personaDescription: '{{user}} 是普通男人，好感={{getvar::trust}}。',
            lorebooks: {
                BookA: [
                    {
                        world: 'BookA',
                        uid: 1,
                        comment: 'Lore Entry',
                        content: '档案：{{char}} 与 {{user}}，trust=<%= vars.trust %>',
                        keys: ['档案'],
                        keysecondary: [],
                        constant: false,
                        selective: false,
                        disable: false,
                        position: 0,
                        depth: 4,
                        order: 10,
                        role: 0,
                    },
                    {
                        world: 'BookA',
                        uid: 2,
                        comment: 'Skill Entry',
                        content: '@@skill inspect-skill\n技能摘要：{{user}} 查看 <%= vars.trust %>\n正文：{{char}} 的细节。',
                        keys: [],
                        keysecondary: [],
                        constant: true,
                        selective: false,
                        disable: false,
                        position: 0,
                        depth: 4,
                        order: 10,
                        role: 0,
                    },
                ],
            },
        });
        bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
        bridge.pushMessage({ name: 'Alice', isUser: false, mes: '回复 {{user}} <% if (true) { %>原文<% } %>' });
        bridge.setEjsEvaluator(async (text, vars) => {
            let out = text.replace(
                /<% if \(Number\(vars\.trust\) >= 50\) \{ %>([\s\S]*?)<% \} else \{ %>([\s\S]*?)<% \} %>/g,
                (_m, truthy: string, falsy: string) => (Number(vars.trust) >= 50 ? truthy : falsy),
            );
            out = out.replace(/<%=\s*vars\.trust\s*%>/g, String(vars.trust ?? ''));
            return out;
        });

        const vfs = new VirtualFileSystem({
            bridge,
            getPresetFiles: () => ({
                'guide.md': '预设指南：{{char}} / <%= vars.trust %>',
            }),
        });
        const target = { messageId: 1, swipeId: 0 };
        await vfs.writeVariables({ trust: 65 }, { target, staged: true });
        await vfs.writeFile('/workspace/notes.md', '工作区：{{user}} trust=<%= vars.trust %>', {
            target,
            staged: true,
        });
        await vfs.writeFile('/global/rules.md', '全局：{{char}}');
        await vfs.writeHistoryInternal('/history/chunk-001.md', '归档：{{user}} <% raw %>');
        await vfs.writeSideClue(
            {
                path: '/side/notes/clue.md',
                title: '线索',
                body: '线外：{{user}} <% raw %>',
            },
            { target, staged: false },
        );

        // Default reads evaluate macros + EJS using target/staged variables
        const charText = await vfs.readFile('/character/description.md', { target, staged: true });
        expect(charText).toContain('标题 爱丽丝，铃木丸太 扮演路人。');
        expect(charText).toContain('秘密：信任已达标(65)。');
        expect(charText).not.toContain('<%');

        // Line-sliced read evaluates full multi-line EJS block before slicing lines
        const charLine2 = await vfs.readFile('/character/description.md', {
            target,
            staged: true,
            startLine: 2,
            endLine: 3,
        });
        expect(charLine2).toContain('秘密：信任已达标(65)。');

        expect(await vfs.readFile('/persona/description.md', { target, staged: true })).toBe(
            '铃木丸太 是普通男人，好感=65。',
        );
        expect(await vfs.readFile('/preset/guide.md', { target, staged: true })).toBe('预设指南：爱丽丝 / 65');
        expect(await vfs.readFile('/workspace/notes.md', { target, staged: true })).toBe('工作区：铃木丸太 trust=65');
        expect(await vfs.readFile('/global/rules.md', { target, staged: true })).toBe('全局：爱丽丝');

        const skillText = await vfs.readFile('/skills/inspect-skill.md', { target, staged: true });
        expect(skillText).toContain('skill: inspect-skill');
        expect(skillText).toContain('技能摘要：铃木丸太 查看 65');
        expect(skillText).toContain('正文：爱丽丝 的细节。');

        // /lorebooks/* fallback evaluation without LoreReadHook
        const loreText = await vfs.readFile('/lorebooks/BookA/Lore-Entry-1.md', { target, staged: true });
        expect(loreText).toContain('world: BookA');
        expect(loreText).toContain('档案：爱丽丝 与 铃木丸太，trust=65');

        // { raw: true } preserves verbatim templates across all evaluated mounts
        expect(await vfs.readFile('/character/description.md', { target, staged: true, raw: true })).toContain('{{char}}');
        expect(await vfs.readFile('/character/description.md', { target, staged: true, raw: true })).toContain('<% if');
        expect(await vfs.readFile('/persona/description.md', { target, staged: true, raw: true })).toContain('{{user}}');
        expect(await vfs.readFile('/preset/guide.md', { target, staged: true, raw: true })).toContain('<%= vars.trust %>');
        expect(await vfs.readFile('/workspace/notes.md', { target, staged: true, raw: true })).toContain('{{user}}');
        expect(await vfs.readFile('/global/rules.md', { target, staged: true, raw: true })).toBe('全局：{{char}}');
        expect(await vfs.readFile('/skills/inspect-skill.md', { target, staged: true, raw: true })).toContain('{{user}}');
        expect(await vfs.readFile('/lorebooks/BookA/Lore-Entry-1.md', { target, staged: true, raw: true })).toContain('{{char}}');

        // Also bypasses LoreReadHook when loreReadHook is wired
        const hookSpy = vi.fn(async () => 'HOOK_EVALUATED');
        vfs.setLoreReadHook(hookSpy);
        expect(await vfs.readFile('/lorebooks/BookA/Lore-Entry-1.md', { target, staged: true })).toContain('HOOK_EVALUATED');
        expect(hookSpy).toHaveBeenCalledTimes(1);
        const rawLore = await vfs.readFile('/lorebooks/BookA/Lore-Entry-1.md', {
            target,
            staged: true,
            raw: true,
        });
        expect(rawLore).toContain('档案：{{char}} 与 {{user}}');
        expect(hookSpy).toHaveBeenCalledTimes(1);

        // Non-template mounts always return raw content
        expect(await vfs.readFile('/docs/ejs-macros.md', { target })).toContain('<%=');
        expect(await vfs.readFile('/output.md', { target })).toBe('回复 {{user}} <% if (true) { %>原文<% } %>');
        expect(await vfs.readFile('/history/chunk-001.md', { target })).toBe('归档：{{user}} <% raw %>');
        expect(await vfs.readFile('/side/notes/clue.md', { target, staged: false })).toContain('线外：{{user}} <% raw %>');
    });

    it('restricts /lorebooks/* worldinfo overrides to genuine modifications and preserves macros/regex on editable reads', async () => {
        const bridge = new MemoryHostBridge({
            identity: {
                userName: '沈默',
                charName: '林晚',
                characterAvatar: 'linwan.png',
                personaAvatar: 'shenmo.png',
            },
            lorebooks: {
                TemplateBook: [
                    {
                        world: 'TemplateBook',
                        uid: 11,
                        comment: '插画规则',
                        content:
                            '@@depth 4\n<%_ if (!vars.inBattle) { _%>\n---\n<插图规则>\n角色：{{char}} / {{user}}\n<%_ } _%>',
                        keys: ['插图'],
                        keysecondary: [],
                        constant: true,
                        selective: false,
                        disable: false,
                        position: 4,
                        depth: 4,
                        order: 100,
                        role: 0,
                    },
                ],
            },
            ejsEvaluator: async (text, vars) => {
                if (vars.inBattle) {
                    return '';
                }
                return text
                    .replace(/<%_\s*if \(!vars\.inBattle\) \{\s*_%>\n?/g, '')
                    .replace(/\n?<%_\s*\}\s*_%>/g, '');
            },
        });
        bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
        bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'hello' });
        bridge.setVariable('inBattle', false);

        const { LoreReadEvaluator } = await import('@/core/lore');
        const loreEval = new LoreReadEvaluator(bridge, {
            applyLoreReadRegex: (text) => text.replace('角色：', 'REGEX_角色：'),
        });
        const vfs = new VirtualFileSystem({
            bridge,
            loreReadHook: loreEval.toLoreReadHook(),
        });
        const target = { messageId: 1, swipeId: 0 };
        const lorePath = '/lorebooks/TemplateBook/插画规则-11.md';

        // 1. Editable read preserves raw macros, EJS tags, and skips lore_read regex
        const editableDoc = await vfs.readFile(lorePath, {
            target,
            staged: false,
            editable: true,
            writable: true,
        });
        expect(editableDoc).toContain('{{char}} / {{user}}');
        expect(editableDoc).toContain('<%_ if (!vars.inBattle) { _%>');
        expect(editableDoc).not.toContain('REGEX_角色：');

        // Read-only read evaluates macros, EJS, and regex
        const renderedDoc = await vfs.readFile(lorePath, {
            target,
            staged: false,
            editable: false,
        });
        expect(renderedDoc).toContain('REGEX_角色：林晚 / 沈默');
        expect(renderedDoc).not.toContain('<%_');

        // 2. Writing base-identical (decorator-stripped or full raw) content creates NO override
        const baseCleanBody =
            '<%_ if (!vars.inBattle) { _%>\n---\n<插图规则>\n角色：{{char}} / {{user}}\n<%_ } _%>';
        await vfs.writeFile(lorePath, baseCleanBody, { target, staged: false });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        // 3. Writing macro/EJS-evaluated rendering (both pre-regex and post-regex) of unmodified base entry is rejected
        const renderedOnlyBody = '---\n<插图规则>\n角色：林晚 / 沈默';
        await expect(
            vfs.writeFile(lorePath, renderedOnlyBody, { target, staged: false }),
        ).rejects.toMatchObject({ code: 'EINVAL' });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        const renderedWithRegexBody = '---\n<插图规则>\nREGEX_角色：林晚 / 沈默';
        await expect(
            vfs.writeFile(lorePath, renderedWithRegexBody, { target, staged: false }),
        ).rejects.toMatchObject({ code: 'EINVAL' });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        // Also reject macro-only rendering before EJS/regex if it matches substituteMacros(baseBody)
        const macroOnlyRenderedBody =
            '<%_ if (!vars.inBattle) { _%>\n---\n<插图规则>\n角色：林晚 / 沈默\n<%_ } _%>';
        await expect(
            vfs.writeFile(lorePath, macroOnlyRenderedBody, { target, staged: false }),
        ).rejects.toMatchObject({ code: 'EINVAL' });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        // 4. No-op editFile does not create an override
        const noopEdit = await vfs.editFile(lorePath, '<插图规则>', '<插图规则>', {
            target,
            staged: false,
        });
        expect(noopEdit.ok).toBe(true);
        expect(noopEdit.replacements).toBe(0);
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        // 5. Genuine modification succeeds and creates override
        await vfs.writeFile(lorePath, '---\n<插图规则>\n角色：林晚 / 沈默\n补充：新增规则', {
            target,
            staged: false,
        });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })?.content).toContain(
            '补充：新增规则',
        );

        // 6. Writing base-identical content clears existing override
        await vfs.writeFile(lorePath, baseCleanBody, { target, staged: false });
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();

        // 7. Genuine editFile creates override, and editFile back to base clears it
        const genuineEdit = await vfs.editFile(lorePath, '<插图规则>', '<插图规则-已改>', {
            target,
            staged: false,
        });
        expect(genuineEdit.ok).toBe(true);
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })?.content).toContain(
            '<插图规则-已改>',
        );

        const revertEdit = await vfs.editFile(lorePath, '<插图规则-已改>', '<插图规则>', {
            target,
            staged: false,
        });
        expect(revertEdit.ok).toBe(true);
        expect(vfs.store.get('worldinfo', 'TemplateBook/11', { target })).toBeNull();
    });
});
