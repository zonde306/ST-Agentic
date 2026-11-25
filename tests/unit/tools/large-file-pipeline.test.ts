import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    UndoStore,
    createAdjustTools,
    createChatReadOnlyTools,
    executeAssistantTool,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore, TransientToolSpillStore, utf8ByteLength } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { ChatDataStore } from '@/core/store';
import { createBuiltinToolRegistry, createToolExecutionContext } from '@/core/tools';
import type { RawLoreEntry } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function createMainlineHarness() {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        characterFields: hollowChineseCard.characterFields,
        personaDescription: hollowChineseCard.personaDescription,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: '检查大文件读写链路' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: '初始回复' });

    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({ bridge, store });
    const spillStore = new TransientToolSpillStore();
    const registry = createBuiltinToolRegistry();
    registry.setOutputGateOptions({ spillStore, scopeId: 'main:1#0' });
    const readSet = new Map<string, string>();

    const ctx = createToolExecutionContext({
        bridge,
        vfs,
        store,
        target: { messageId: 1, swipeId: 0 },
        permissions: { read: ['/**'], write: ['/**'] },
        readSet,
        spillStore,
    });

    return { bridge, store, vfs, spillStore, registry, readSet, ctx };
}

function createAssistantHarness() {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        characterFields: hollowChineseCard.characterFields,
        personaDescription: hollowChineseCard.personaDescription,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: '检查大文件读写链路' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: '初始回复' });

    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({ bridge, store });
    const undoStore = new UndoStore();
    const trajectoryStore = new TrajectoryStore();
    const traceLogger = new TraceLogger();
    const spillStore = new TransientToolSpillStore();

    const ctx: AssistantToolContext = {
        sessionId: 'ast_large_pipeline',
        toolCallId: 'call_ast_1',
        mode: 'adjust',
        stAdminEnabled: false,
        bridge,
        store,
        vfs,
        undoStore,
        trajectoryStore,
        traceLogger,
        settings: createDefaultSettings(),
        target: { messageId: 1, swipeId: 0 },
        signal: new AbortController().signal,
        spillStore,
    };

    const tools = new Map<string, AssistantToolDefinition>();
    for (const def of [...createChatReadOnlyTools(), ...createAdjustTools()]) {
        tools.set(def.name, def);
    }

    return { bridge, store, vfs, undoStore, spillStore, ctx, tools };
}

describe('Large-File Search -> Read -> Write Pipeline', () => {
    it('aligns grep_search & search_files 1:1 with read_file lines across workspace, lorebooks, and history', async () => {
        const { vfs, registry, ctx } = createMainlineHarness();

        // 1. Workspace file: grep_search and search_files match exact 1-based line
        const wsLines = Array.from({ length: 40 }, (_, i) => `row ${i + 1}: routine entry`);
        wsLines[26] = 'row 27: UNIQUE_ANCHOR_OBSIDIAN_KEY inside workspace';
        await vfs.writeFile('/notes/codex.md', wsLines.join('\n'), {
            target: ctx.target,
            staged: false,
        });

        const grepWs = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    {
                        query: 'UNIQUE_ANCHOR_OBSIDIAN_KEY',
                        path_prefix: '/notes/codex.md',
                        context_lines: 2,
                    },
                    ctx,
                )
            ).output,
        );
        expect(grepWs.ok).toBe(true);
        expect(grepWs.results).toHaveLength(1);
        expect(grepWs.results[0]).toMatchObject({
            path: '/notes/codex.md',
            line: 27,
            totalLines: 40,
        });
        expect(grepWs.results[0].context).toEqual([
            ' 25| row 25: routine entry',
            ' 26| row 26: routine entry',
            '>27| row 27: UNIQUE_ANCHOR_OBSIDIAN_KEY inside workspace',
            ' 28| row 28: routine entry',
            ' 29| row 29: routine entry',
        ]);

        const searchWs = JSON.parse(
            (
                await registry.executeToolCall(
                    'search_files',
                    { query: 'UNIQUE_ANCHOR_OBSIDIAN_KEY', path_prefix: '/notes' },
                    ctx,
                )
            ).output,
        );
        expect(searchWs.ok).toBe(true);
        expect(searchWs.results[0]).toMatchObject({
            path: '/notes/codex.md',
            line: 27,
            totalLines: 40,
            matchedIn: 'content',
        });

        // Passing the returned line directly to read_file shows the exact line
        const readWs = await registry.executeToolCall(
            'read_file',
            { path: '/notes/codex.md', start_line: 27, end_line: 27 },
            ctx,
        );
        expect(readWs.output).toContain('27| row 27: UNIQUE_ANCHOR_OBSIDIAN_KEY inside workspace');

        // 2. Lorebook file with YAML frontmatter: grep_search & search_files match read_file line 1:1
        const lorePath = '/lorebooks/霜烬纪元/银莲花结社档案-5.md';
        const loreGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    { query: '三瓣银莲花铜徽', path_prefix: lorePath, context_lines: 0 },
                    ctx,
                )
            ).output,
        );
        expect(loreGrep.ok).toBe(true);
        expect(loreGrep.results).toHaveLength(1);
        expect(loreGrep.results[0].context).toBeUndefined();
        const loreHitLine = loreGrep.results[0].line as number;

        const loreRead = await registry.executeToolCall(
            'read_file',
            { path: lorePath, start_line: loreHitLine, end_line: loreHitLine },
            ctx,
        );
        expect(loreRead.ok).toBe(true);
        expect(loreRead.output).toContain(`${loreHitLine}|`);
        expect(loreRead.output).toContain('三瓣银莲花铜徽');

        // Frontmatter metadata hit also aligns to exact frontmatter line
        const loreFmGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    { query: 'uid: 5', path_prefix: lorePath, context_lines: 0 },
                    ctx,
                )
            ).output,
        );
        expect(loreFmGrep.results[0].line).toBeLessThan(loreHitLine);
        const loreFmRead = await registry.executeToolCall(
            'read_file',
            {
                path: lorePath,
                start_line: loreFmGrep.results[0].line,
                end_line: loreFmGrep.results[0].line,
            },
            ctx,
        );
        expect(loreFmRead.output).toContain(`${loreFmGrep.results[0].line}| uid: 5`);

        const loreSearch = JSON.parse(
            (
                await registry.executeToolCall(
                    'search_files',
                    { query: '三瓣银莲花铜徽', path_prefix: '/lorebooks' },
                    ctx,
                )
            ).output,
        );
        expect(loreSearch.results[0].path).toBe(lorePath);
        expect(loreSearch.results[0].line).toBe(loreHitLine);
        expect(loreSearch.results[0].matchedIn).toBe('content');

        // 3. History file: search_history fuzzy & grep align with read_history
        await vfs.writeHistoryInternal(
            '/history/chunk-009.md',
            '第一行背景\n第二行记录：找到失落的航海日志\n第三行收尾',
        );
        const histFuzzy = JSON.parse(
            (await registry.executeToolCall('search_history', { query: '航海日志' }, ctx)).output,
        );
        expect(histFuzzy.results[0]).toMatchObject({
            path: '/history/chunk-009.md',
            line: 2,
            totalLines: 3,
        });
    });

    it('centers grep snippets on huge single lines and honors max_matches_per_file', async () => {
        const { vfs, registry, ctx } = createMainlineHarness();

        const hugeLine = `${'A'.repeat(3000)}TARGET_NEEDLE_CENTER${'B'.repeat(2000)}`;
        const repeatedLines = Array.from(
            { length: 10 },
            (_, idx) => `repeat_${idx + 1} MATCH_TOKEN`,
        ).join('\n');

        await vfs.writeFile('/notes/wide.txt', hugeLine, { target: ctx.target, staged: false });
        await vfs.writeFile('/notes/many.txt', repeatedLines, { target: ctx.target, staged: false });

        const wideGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    { query: 'TARGET_NEEDLE_CENTER', path_prefix: '/notes/wide.txt' },
                    ctx,
                )
            ).output,
        );
        expect(wideGrep.ok).toBe(true);
        expect(wideGrep.results).toHaveLength(1);
        expect(wideGrep.results[0].snippet).toContain('TARGET_NEEDLE_CENTER');
        expect(wideGrep.results[0].snippet.startsWith('...')).toBe(true);
        expect(wideGrep.results[0].snippet.endsWith('...')).toBe(true);

        const cappedGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    {
                        query: 'MATCH_TOKEN',
                        path_prefix: '/notes/many.txt',
                        max_matches_per_file: 3,
                        context_lines: 0,
                    },
                    ctx,
                )
            ).output,
        );
        expect(cappedGrep.total).toBe(3);
        expect(cappedGrep.results.map((r: { line: number }) => r.line)).toEqual([1, 2, 3]);
    });

    it('soft-paginates large reads, pages huge single lines, protects Read-Set, and wires mainline /tmp/tool-spill/*', async () => {
        const { vfs, spillStore, registry, readSet, ctx } = createMainlineHarness();

        // 600-line file > 200-line soft cap
        const bigLines = Array.from(
            { length: 600 },
            (_, idx) => `Line ${idx + 1}: ${'lore-segment-'.repeat(8)}`,
        );
        await vfs.writeFile('/notes/big.md', bigLines.join('\n'), {
            target: ctx.target,
            staged: false,
        });
        readSet.clear();

        const firstPage = await registry.executeToolCall('read_file', { path: '/notes/big.md' }, ctx);
        expect(firstPage.ok).toBe(true);
        expect(utf8ByteLength(firstPage.output)).toBeLessThanOrEqual(24 * 1024);
        expect(firstPage.output).toContain('lines 1-');
        expect(firstPage.output).toContain('of 600');
        expect(firstPage.output).toContain('next: start_line=');
        expect(firstPage.output).toContain('1| Line 1:');
        // Partial/soft-truncated read MUST NOT record full-file Read-Set digest
        expect(readSet.has('/notes/big.md')).toBe(false);

        // Explicit full-file range on small file DOES record Read-Set digest
        const lorePath = '/lorebooks/霜烬纪元/银莲花结社档案-5.md';
        const fullLoreRaw = await vfs.readFile(lorePath);
        const totalLoreLines = fullLoreRaw.split('\n').length;
        const explicitFull = await registry.executeToolCall(
            'read_file',
            { path: lorePath, start_line: 1, end_line: totalLoreLines },
            ctx,
        );
        expect(explicitFull.ok).toBe(true);
        expect(readSet.has(lorePath)).toBe(true);

        // line_numbers: false omits prefixes while keeping metadata header
        const noNums = await registry.executeToolCall(
            'read_file',
            { path: '/notes/big.md', start_line: 1, end_line: 2, line_numbers: false },
            ctx,
        );
        expect(noNums.ok).toBe(true);
        expect(noNums.output).toContain('[File: /notes/big.md | lines 1-2 of 600');
        expect(noNums.output).toContain('\nLine 1:');
        expect(noNums.output).not.toContain('\n1| ');

        // Single 15,000-char line paged with char_limit & char_offset
        const singleHugeLine = `${'0123456789'.repeat(1000)}MIDDLE_SLICE_MARKER${'abcdefghij'.repeat(500)}`;
        await vfs.writeFile('/notes/minified.json', singleHugeLine, {
            target: ctx.target,
            staged: false,
        });
        const charPage1 = await registry.executeToolCall(
            'read_file',
            { path: '/notes/minified.json', start_line: 1, end_line: 1, char_limit: 500 },
            ctx,
        );
        expect(charPage1.ok).toBe(true);
        expect(charPage1.output).toContain('char_offset=500');
        const charPage2 = await registry.executeToolCall(
            'read_file',
            {
                path: '/notes/minified.json',
                start_line: 1,
                end_line: 1,
                char_offset: 9990,
                char_limit: 500,
            },
            ctx,
        );
        expect(charPage2.ok).toBe(true);
        expect(charPage2.output).toContain('MIDDLE_SLICE_MARKER');

        // Mainline agent oversized non-VFS tool spills to /tmp/tool-spill/* and mainline read_file/grep_search work on it
        registry.register({
            name: 'dump_big_report',
            description: 'Produces an oversized plain text report.',
            parameters: z.object({}),
            execute: () =>
                Array.from({ length: 450 }, (_, i) =>
                    i === 299 ? 'LINE_300_SPILL_TARGET' : `Report row ${i + 1}: ${'x'.repeat(80)}`,
                ).join('\n'),
        });

        const dumpRes = await registry.executeToolCall('dump_big_report', {}, ctx, {
            toolCallId: 'call_main_spill_1',
        });
        expect(dumpRes.ok).toBe(true);
        expect(dumpRes.truncated).toBe(true);
        expect(dumpRes.spillPath).toBe('/tmp/tool-spill/call_main_spill_1.txt');

        const mainSpillGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    {
                        query: 'LINE_300_SPILL_TARGET',
                        path_prefix: '/tmp/tool-spill/call_main_spill_1.txt',
                    },
                    ctx,
                )
            ).output,
        );
        expect(mainSpillGrep.ok).toBe(true);
        expect(mainSpillGrep.results[0]).toMatchObject({
            path: '/tmp/tool-spill/call_main_spill_1.txt',
            line: 300,
            totalLines: 450,
        });
        expect(mainSpillGrep.results[0].context?.some((c: string) => c.startsWith('>300|'))).toBe(
            true,
        );

        const mainSpillRead = await registry.executeToolCall(
            'read_file',
            {
                path: '/tmp/tool-spill/call_main_spill_1.txt',
                start_line: 299,
                end_line: 301,
            },
            ctx,
        );
        expect(mainSpillRead.ok).toBe(true);
        expect(mainSpillRead.output).toContain('300| LINE_300_SPILL_TARGET');

        spillStore.clearScope('main:1#0');
        const expiredMainRead = await registry.executeToolCall(
            'read_file',
            { path: '/tmp/tool-spill/call_main_spill_1.txt' },
            ctx,
        );
        expect(expiredMainRead.ok).toBe(false);
        expect(expiredMainRead.output).toContain('not found or expired');
    });

    it('enforces unambiguous range-scoped edits, atomic batch edits[], self-healing hints, and $-literal safety', async () => {
        const { vfs, registry, ctx } = createMainlineHarness();

        const docLines = [
            '## Section A',
            'status: pending',
            'note: alpha',
            '',
            '## Section B',
            'status: pending',
            'note: beta',
            '',
            '## Section C',
            'status: pending',
            'note: gamma',
        ];
        await vfs.writeFile('/notes/sections.md', docLines.join('\n'), {
            target: ctx.target,
            staged: false,
        });

        // 1. Ambiguous edit without range is rejected with exact matchLines
        const ambiguous = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    { path: '/notes/sections.md', search: 'status: pending', replace: 'status: done' },
                    ctx,
                )
            ).output,
        );
        expect(ambiguous.ok).toBe(false);
        expect(ambiguous.code).toBe('AMBIGUOUS_MATCH');
        expect(ambiguous.matchLines).toEqual([2, 6, 10]);
        expect(await vfs.readFile('/notes/sections.md')).toBe(docLines.join('\n'));

        // 2. Range-scoped edit disambiguates Section B only
        const scopedEdit = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        search: 'status: pending',
                        replace: 'status: done',
                        start_line: 5,
                        end_line: 7,
                    },
                    ctx,
                )
            ).output,
        );
        expect(scopedEdit.ok).toBe(true);
        expect(scopedEdit.replacements).toBe(1);
        expect(scopedEdit.changedRanges).toEqual([{ startLine: 6, endLine: 6 }]);
        expect(scopedEdit.totalLines).toBe(11);
        const afterScoped = (await vfs.readFile('/notes/sections.md')).split('\n');
        expect(afterScoped[1]).toBe('status: pending');
        expect(afterScoped[5]).toBe('status: done');
        expect(afterScoped[9]).toBe('status: pending');

        // 3. Self-healing hints: accidental N| prefix & out-of-range match
        const prefixMistake = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    { path: '/notes/sections.md', search: '6| status: done', replace: 'status: fixed' },
                    ctx,
                )
            ).output,
        );
        expect(prefixMistake.ok).toBe(false);
        expect(prefixMistake.code).toBe('NOT_FOUND');
        expect(prefixMistake.error).toContain('line-number prefixes');

        const wrongRange = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        search: 'note: gamma',
                        replace: 'note: updated',
                        start_line: 1,
                        end_line: 4,
                    },
                    ctx,
                )
            ).output,
        );
        expect(wrongRange.ok).toBe(false);
        expect(wrongRange.code).toBe('NOT_FOUND');
        expect(wrongRange.error).toContain('at line(s) [11]');

        // 4. Atomic batch edits[]: rollback if any edit fails or overlaps
        const failedBatch = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        edits: [
                            { search: 'note: alpha', replace: 'note: ALPHA', start_line: 1, end_line: 4 },
                            { search: 'DOES_NOT_EXIST', replace: 'x' },
                        ],
                    },
                    ctx,
                )
            ).output,
        );
        expect(failedBatch.ok).toBe(false);
        expect(await vfs.readFile('/notes/sections.md')).not.toContain('ALPHA');

        const overlapBatch = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        edits: [
                            { search: 'status: pending', replace: 'A', start_line: 1, end_line: 3 },
                            { search: 'pending\nnote: alpha', replace: 'B', start_line: 1, end_line: 4 },
                        ],
                    },
                    ctx,
                )
            ).output,
        );
        expect(overlapBatch.ok).toBe(false);
        expect(overlapBatch.code).toBe('OVERLAPPING_EDITS');

        // Successful batch with JS special $-tokens ($&, $$, $', $`) preserved verbatim
        const goodBatch = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        edits: [
                            {
                                search: 'note: alpha',
                                replace: "price: $$100 $& $' $`",
                                start_line: 1,
                                end_line: 4,
                            },
                            {
                                search: 'status: pending',
                                replace: 'status: verified\nextra: line',
                                start_line: 9,
                                end_line: 11,
                            },
                        ],
                    },
                    ctx,
                )
            ).output,
        );
        expect(goodBatch.ok).toBe(true);
        expect(goodBatch.replacements).toBe(2);
        expect(goodBatch.totalLines).toBe(12);
        expect(goodBatch.changedRanges).toEqual([
            { startLine: 3, endLine: 3 },
            { startLine: 10, endLine: 11 },
        ]);
        const finalText = await vfs.readFile('/notes/sections.md');
        expect(finalText).toContain("price: $$100 $& $' $`");
        expect(finalText).toContain('status: verified\nextra: line');

        // 5. replace_all replaces all matches within scoped range
        const replaceAllRes = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: '/notes/sections.md',
                        search: 'status:',
                        replace: 'state:',
                        replace_all: true,
                    },
                    ctx,
                )
            ).output,
        );
        expect(replaceAllRes.ok).toBe(true);
        expect(replaceAllRes.replacements).toBe(3);

        // 6. Lorebook frontmatter protection & line-aligned edit + $-literal across /output.md, /side/*, /global/*
        const lorePath = '/lorebooks/霜烬纪元/银莲花结社档案-5.md';
        const fmBlocked = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: lorePath,
                        search: 'uid: 5',
                        replace: 'uid: 999',
                        start_line: 1,
                        end_line: 5,
                    },
                    ctx,
                )
            ).output,
        );
        expect(fmBlocked.ok).toBe(false);
        expect(fmBlocked.code).toBe('READONLY_REGION');

        const loreGrep = JSON.parse(
            (
                await registry.executeToolCall(
                    'grep_search',
                    { query: '三瓣银莲花铜徽', path_prefix: lorePath },
                    ctx,
                )
            ).output,
        );
        const loreLine = loreGrep.results[0].line as number;
        const loreEdit = JSON.parse(
            (
                await registry.executeToolCall(
                    'edit_file',
                    {
                        path: lorePath,
                        search: '三瓣银莲花铜徽',
                        replace: '四瓣银莲花银徽 ($&)',
                        start_line: loreLine - 1,
                        end_line: loreLine + 1,
                    },
                    ctx,
                )
            ).output,
        );
        expect(loreEdit.ok).toBe(true);
        expect(await vfs.readFile(lorePath)).toContain('四瓣银莲花银徽 ($&)');

        // $-literal preservation on /output.md, /side/notes/*, and /global/*
        await vfs.writeFile('/output.md', 'old-out', { target: ctx.target, staged: false });
        await vfs.writeFile('/side/notes/clue.md', 'old-side', { target: ctx.target, staged: false });
        await vfs.writeFile('/global/cfg.md', 'old-global');
        await registry.executeToolCall('edit_file', { path: '/output.md', search: 'old-out', replace: '$$$&' }, ctx);
        await registry.executeToolCall('edit_file', { path: '/side/notes/clue.md', search: 'old-side', replace: "$$'$`" }, ctx);
        await registry.executeToolCall('edit_file', { path: '/global/cfg.md', search: 'old-global', replace: '$&$&' }, ctx);
        expect(await vfs.readFile('/output.md', { target: ctx.target, staged: false })).toBe('$$$&');
        expect(await vfs.readFile('/side/notes/clue.md', { target: ctx.target, staged: false })).toBe("$$'$`");
        expect(await vfs.readFile('/global/cfg.md')).toBe('$&$&');
    });

    it('supports full Assistant preview, execute, and undo for range-scoped & batch edit_file', async () => {
        const { vfs, undoStore, ctx, tools } = createAssistantHarness();

        await vfs.writeFile(
            '/workspace/plan.md',
            ['line 1: item', 'line 2: item', 'line 3: item', 'line 4: tail'].join('\n'),
            { target: ctx.target, staged: false },
        );

        const editTool = tools.get('edit_file')!;
        const grepTool = tools.get('grep_search')!;
        const readTool = tools.get('read_file')!;

        // Search -> Read -> Preview -> Execute -> Undo
        const grepRes = await executeAssistantTool(
            grepTool,
            { query: 'item', path_prefix: '/workspace/plan.md', context_lines: 1 },
            ctx,
        );
        expect(grepRes.ok).toBe(true);
        expect((grepRes.data as { total: number }).total).toBe(3);

        const readRes = await executeAssistantTool(
            readTool,
            { path: '/workspace/plan.md', start_line: 2, end_line: 3 },
            ctx,
        );
        expect(readRes.output).toContain('2| line 2: item');
        expect(readRes.output).toContain('3| line 3: item');

        const preview = await editTool.preview!(
            {
                path: '/workspace/plan.md',
                edits: [
                    { search: 'item', replace: 'SECOND', start_line: 2, end_line: 2 },
                    { search: 'item', replace: 'THIRD', start_line: 3, end_line: 3 },
                ],
            },
            ctx,
        );
        expect(preview.beforeText).toContain('line 2: item\nline 3: item');
        expect(preview.afterText).toContain('line 2: SECOND\nline 3: THIRD');

        const execRes = await executeAssistantTool(
            editTool,
            {
                path: '/workspace/plan.md',
                edits: [
                    { search: 'item', replace: 'SECOND', start_line: 2, end_line: 2 },
                    { search: 'item', replace: 'THIRD', start_line: 3, end_line: 3 },
                ],
            },
            ctx,
        );
        expect(execRes.ok).toBe(true);
        expect(execRes.undoId).toBeDefined();
        expect((execRes.data as { replacements: number }).replacements).toBe(2);

        const updated = await vfs.readFile('/workspace/plan.md', {
            target: ctx.target,
            staged: false,
        });
        expect(updated).toBe(['line 1: item', 'line 2: SECOND', 'line 3: THIRD', 'line 4: tail'].join('\n'));

        const undoRec = undoStore.get(execRes.undoId!);
        expect(undoRec).not.toBeNull();
        expect(undoRec!.snapshot.previousContent).toContain('line 2: item');
    });
});
