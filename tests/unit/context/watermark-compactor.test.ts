import { describe, expect, it, vi } from 'vitest';
import {
    FOLDED_OUTPUT_PREFIX,
    TrajectoryStore,
    WatermarkCompactor,
    estimateRequestTokens,
    groupLayer1Turns,
} from '@/core/context';
import { TailRadar } from '@/core/lore';
import type { CanonicalMessage, RawLoreEntry, TriggerRule } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { MemoryHostBridge } from '../../mocks';

function makeToolTurn(params: {
    userText: string;
    toolCallId: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    toolOutput: string;
    assistantReply: string;
    omitToolNameOnResult?: boolean;
}): CanonicalMessage[] {
    return [
        { role: 'user', content: params.userText },
        {
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: params.toolCallId,
                    name: params.toolName,
                    arguments: JSON.stringify(params.toolArgs),
                },
            ],
        },
        {
            role: 'tool',
            toolCallId: params.toolCallId,
            ...(params.omitToolNameOnResult ? {} : { toolName: params.toolName }),
            content: params.toolOutput,
        },
        { role: 'assistant', content: params.assistantReply },
    ];
}

describe('WatermarkCompactor', () => {
    it('does nothing when estimatedTokens <= watermark.high (hysteresis guard)', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        store.appendTurn(
            [
                { role: 'user', content: '你好' },
                { role: 'assistant', content: '你好，调查员。' },
            ],
            'main',
        );
        const beforeTokens = compactor.estimateCurrentTokens(store);

        const result = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: beforeTokens + 100, low: Math.floor(beforeTokens / 2) },
        });

        expect(result.compacted).toBe(false);
        expect(result.archivedTurnCount).toBe(0);
        expect(result.foldedToolResultCount).toBe(0);
        expect(store.getMessageCount('main')).toBe(2);
        await expect(vfs.listDir('/history')).resolves.toEqual([]);
    });

    it('archives earliest complete turns without splitting tool_calls -> tool chains, folds stale >400-char read-only outputs, and evicts Read-Set paths', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        const bigReadA = '银莲花结社早期情报正文。'.repeat(50); // > 400 chars
        const bigReadB = '灰港码头地热管网图纸细节。'.repeat(50); // > 400 chars
        const bigSearchC = '检索命中列表：\n'.repeat(60); // > 400 chars
        const bigWriteD = '成功写入状态档案：\n'.repeat(60); // > 400 chars, NOT read-only!
        const smallReadE = '短档案内容。'; // <= 400 chars
        const bigReadRecentF = '最近回合才读取的超大设定文档。'.repeat(50); // > 400 chars, inside keepRecentTurns=2

        // Turn 0 (will be archived)
        store.appendTurn(
            makeToolTurn({
                userText: '查一下银莲花结社',
                toolCallId: 'tc_0',
                toolName: 'read_file',
                toolArgs: { path: '/lorebooks/world/lotus-5.md' },
                toolOutput: bigReadA,
                assistantReply: '已查阅银莲花档案。',
            }),
            'main',
        );
        store.markRead('/lorebooks/world/lotus-5.md', await bridge.hashText(bigReadA), 'main');
        store.recordCheckpoint({ messageId: 1, swipeId: 0 }, 'main');

        // Turn 1 (retained, older than K=2 -> read_file >400 chars MUST be folded; omit toolName on tool msg to test fallback via toolCallId)
        store.appendTurn(
            makeToolTurn({
                userText: '检查灰港地热图',
                toolCallId: 'tc_1',
                toolName: 'read_file',
                toolArgs: { path: '/lorebooks/world/harbor-6.md' },
                toolOutput: bigReadB,
                assistantReply: '地热管道情况已知。',
                omitToolNameOnResult: true,
            }),
            'main',
        );
        store.markRead('/lorebooks/world/harbor-6.md', await bridge.hashText(bigReadB), 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 0 }, 'main');

        // Turn 2 (retained, older than K=2 -> search_files >400 chars folded, write_file >400 chars NOT folded, small read_file <=400 chars NOT folded)
        store.appendTurn(
            [
                { role: 'user', content: '检索记录并写入笔记' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'tc_2a', name: 'search_files', arguments: '{"query":"守夜人","pathPrefix":"/lorebooks"}' },
                        { id: 'tc_2b', name: 'write_file', arguments: '{"path":"/memory/note.md","content":"..."}' },
                        { id: 'tc_2c', name: 'read_file', arguments: '{"path":"/lorebooks/world/short-8.md"}' },
                    ],
                },
                { role: 'tool', toolCallId: 'tc_2a', toolName: 'search_files', content: bigSearchC },
                { role: 'tool', toolCallId: 'tc_2b', toolName: 'write_file', content: bigWriteD },
                { role: 'tool', toolCallId: 'tc_2c', toolName: 'read_file', content: smallReadE },
                { role: 'assistant', content: '笔记已整理。' },
            ],
            'main',
        );
        store.markRead('/lorebooks/world/short-8.md', await bridge.hashText(smallReadE), 'main');
        store.recordCheckpoint({ messageId: 5, swipeId: 0 }, 'main');

        // Turn 3 (recent #1 of K=2 -> stays unfolded)
        store.appendTurn(
            makeToolTurn({
                userText: '读取最新加密书信',
                toolCallId: 'tc_3',
                toolName: 'read_file',
                toolArgs: { path: '/lorebooks/world/recent-9.md' },
                toolOutput: bigReadRecentF,
                assistantReply: '书信内容已掌握。',
            }),
            'main',
        );
        store.markRead('/lorebooks/world/recent-9.md', await bridge.hashText(bigReadRecentF), 'main');
        store.recordCheckpoint({ messageId: 7, swipeId: 0 }, 'main');

        // Turn 4 (recent #2 of K=2 -> stays unfolded)
        store.appendTurn(
            [
                { role: 'user', content: '准备前往灯塔。' },
                { role: 'assistant', content: '我陪你同去。' },
            ],
            'main',
        );
        store.recordCheckpoint({ messageId: 9, swipeId: 0 }, 'main');

        const tokensBefore = compactor.estimateCurrentTokens(store);
        const summarizeSpy = vi.fn(async (chunkText: string) => `摘要：已调查银莲花档案 (${chunkText.length} chars)`);

        // Set watermark so archiving Turn 0 + folding Turns 1..2 reduces tokens <= low
        const result = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: tokensBefore - 1, low: tokensBefore - 500 },
            keepRecentTurns: 2,
            foldThresholdChars: 400,
            summarizeChunk: summarizeSpy,
        });

        expect(result.compacted).toBe(true);
        expect(result.mode).toBe('fallback');
        expect(result.archivedTurnCount).toBe(1);
        expect(result.archivedChunkPath).toBe('/history/chunk-001.md');
        expect(result.summaryPath).toBe('/history/summary.md');
        expect(result.foldedToolResultCount).toBe(2); // tc_1 (read_file >400) + tc_2a (search_files >400)
        expect(result.estimatedTokensAfter).toBeLessThanOrEqual(tokensBefore - 500);

        // Verify chunk written via HistoryMount contains Turn 0 intact
        const chunkText = await vfs.readFile('/history/chunk-001.md');
        expect(chunkText).toContain('查一下银莲花结社');
        expect(chunkText).toContain('银莲花结社早期情报正文');
        expect(summarizeSpy).toHaveBeenCalledTimes(1);
        expect(await vfs.readFile('/history/summary.md')).toContain('摘要：已调查银莲花档案');

        // Verify retained messages & Action B placeholders
        const retained = store.getMessages('main');
        expect(retained[0].role).toBe('system');
        expect(retained[0].content).toContain('<history-summary');

        const { turns: retainedTurns } = groupLayer1Turns(retained, store.getCompactionHeaderCount('main'));
        expect(retainedTurns).toHaveLength(4); // Turns 1, 2, 3, 4

        // Turn 1 read_file folded with exact placeholder format & xxHash
        const foldedHarbor = retainedTurns[0].messages.find((m) => m.toolCallId === 'tc_1')!;
        expect(typeof foldedHarbor.content).toBe('string');
        expect(foldedHarbor.content).toMatch(
            /^\[已折叠只读输出: \/lorebooks\/world\/harbor-6\.md \(约 \d+ 字，内容哈希 [0-9a-f]{8}\)；如需重温请重新 read_file\]$/,
        );

        // Turn 2: search_files folded, write_file NOT folded, small read_file NOT folded
        const foldedSearch = retainedTurns[1].messages.find((m) => m.toolCallId === 'tc_2a')!;
        const keptWrite = retainedTurns[1].messages.find((m) => m.toolCallId === 'tc_2b')!;
        const keptSmallRead = retainedTurns[1].messages.find((m) => m.toolCallId === 'tc_2c')!;
        expect(String(foldedSearch.content).startsWith(FOLDED_OUTPUT_PREFIX)).toBe(true);
        expect(keptWrite.content).toBe(bigWriteD);
        expect(keptSmallRead.content).toBe(smallReadE);

        // Turn 3 (recent) stays unfolded
        const keptRecent = retainedTurns[2].messages.find((m) => m.toolCallId === 'tc_3')!;
        expect(keptRecent.content).toBe(bigReadRecentF);

        // Action C: Read-Set evicted lotus-5.md (archived) and harbor-6.md (folded),
        // while keeping short-8.md (unfolded) and recent-9.md (unfolded)!
        const postReadSet = store.getReadSet('main');
        expect(postReadSet.has('/lorebooks/world/lotus-5.md')).toBe(false);
        expect(postReadSet.has('/lorebooks/world/harbor-6.md')).toBe(false);
        expect(postReadSet.has('/lorebooks/world/short-8.md')).toBe(true);
        expect(postReadSet.has('/lorebooks/world/recent-9.md')).toBe(true);

        // TailRadar gently re-hints evicted path if referenced later!
        const radar = TailRadar.fromBridge(bridge);
        const lotusEntry: RawLoreEntry = {
            world: 'world',
            uid: 5,
            comment: 'lotus',
            content: bigReadA,
            keys: ['银莲花'],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 1,
            depth: 4,
            order: 100,
            role: 0,
        };
        const radarScan = await radar.scan([lotusEntry], {
            input: '再看看银莲花结社',
            readSet: postReadSet,
        });
        expect(radarScan.candidates).toHaveLength(1);
        expect(radarScan.candidates[0].status).toBe('unread');
    });

    it('never splits mid tool_calls -> tool chain even when watermark.low lies inside a multi-step tool turn', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        // Turn 0 has two chained tool calls
        store.appendTurn(
            [
                { role: 'user', content: '多步查询' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'a1', name: 'list_dir', arguments: '{"path":"/lorebooks"}' }],
                },
                { role: 'tool', toolCallId: 'a1', toolName: 'list_dir', content: 'A'.repeat(600) },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'a2', name: 'read_file', arguments: '{"path":"/lorebooks/a.md"}' }],
                },
                { role: 'tool', toolCallId: 'a2', toolName: 'read_file', content: 'B'.repeat(600) },
                { role: 'assistant', content: '多步查询完成。' },
            ],
            'main',
        );

        // Turn 1 also has chained tool calls
        store.appendTurn(
            makeToolTurn({
                userText: '第二轮继续',
                toolCallId: 'b1',
                toolName: 'grep_search',
                toolArgs: { query: '银莲花' },
                toolOutput: 'C'.repeat(600),
                assistantReply: '第二轮回复。',
            }),
            'main',
        );

        // Turn 2 final turn
        store.appendTurn(
            [
                { role: 'user', content: '第三轮' },
                { role: 'assistant', content: '第三轮完成。' },
            ],
            'main',
        );

        const total = compactor.estimateCurrentTokens(store);
        // Tight low target forcing archival of Turn 0 (and testing Turn 1 integrity)
        const targetLow = estimateRequestTokens(store.getMessages('main').slice(-4));

        const res = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: total - 1, low: targetLow },
            keepRecentTurns: 1,
        });

        expect(res.compacted).toBe(true);
        const remaining = store.getMessages('main').slice(store.getCompactionHeaderCount('main'));
        // Verify every assistant toolCall in remaining Layer 1 still has its matching tool result immediately following
        const seenCallIds = new Set<string>();
        const seenResultIds = new Set<string>();
        for (const msg of remaining) {
            if (msg.role === 'assistant' && msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    seenCallIds.add(tc.id);
                }
            } else if (msg.role === 'tool' && msg.toolCallId) {
                expect(seenCallIds.has(msg.toolCallId)).toBe(true);
                seenResultIds.add(msg.toolCallId);
            }
        }
        expect(seenResultIds).toEqual(seenCallIds);
    });

    it('uses Bridge Summary Mode (zero LLM calls) when card/preset has summary/outline triggers, and Fallback Mode otherwise', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        await vfs.writeFile('/memory/summary.md', '用户自建前情摘要：抵达灰港。');
        await vfs.writeFile('/memory/outline.md', '第一幕：旧灯塔会面。');

        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        for (let i = 0; i < 4; i += 1) {
            store.appendTurn(
                [
                    { role: 'user', content: `轮次 ${i} 输入：${'剧情细节'.repeat(40)}` },
                    { role: 'assistant', content: `轮次 ${i} 回复：${'回应内容'.repeat(40)}` },
                ],
                'main',
            );
        }

        const summaryTrigger: TriggerRule = {
            id: 'auto_summary',
            label: '剧情摘要更新',
            source: 'preset',
            phase: 'after_turn',
            order: 1,
            barrier: 'self',
            agentProfileId: 'chronicler',
            kind: 'agent',
            condition: { type: 'always' },
            instructionTemplate: '更新 /memory/summary.md',
            targetPath: '/memory/summary.md',
            enabled: true,
        };

        const summarizeCallback = vi.fn(async () => 'SHOULD_NOT_BE_CALLED');
        const tokens = compactor.estimateCurrentTokens(store);

        const bridgeRes = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: tokens - 1, low: Math.floor(tokens * 0.5) },
            triggers: [summaryTrigger],
            summarizeChunk: summarizeCallback,
        });

        expect(bridgeRes.compacted).toBe(true);
        expect(bridgeRes.mode).toBe('bridge');
        expect(summarizeCallback).not.toHaveBeenCalled();
        expect(bridgeRes.archivedChunkPath).toBe('/history/chunk-001.md');
        expect(bridgeRes.referencedSummaryPaths).toContain('/memory/summary.md');
        expect(bridgeRes.referencedSummaryPaths).toContain('/memory/outline.md');

        const headerContent = store.getMessages('main')[0].content as string;
        expect(headerContent).toContain('<history-archive-index>');
        expect(headerContent).toContain('/history/chunk-001.md');
        expect(headerContent).toContain('/memory/summary.md');
        expect(headerContent).toContain('/memory/outline.md');

        // Fallback Mode on a fresh store without summary triggers
        const fallbackStore = new TrajectoryStore();
        for (let i = 0; i < 4; i += 1) {
            fallbackStore.appendTurn(
                [
                    { role: 'user', content: `Fallback 轮次 ${i}：${'内容'.repeat(50)}` },
                    { role: 'assistant', content: `Fallback 回复 ${i}：${'内容'.repeat(50)}` },
                ],
                'main',
            );
        }
        const fbTokens = compactor.estimateCurrentTokens(fallbackStore);
        const fbCallback = vi.fn(async (chunkText: string) => {
            expect(chunkText).toContain('Fallback 轮次 0');
            return '内置兜底前情提要：第0轮事件已完成。';
        });

        const fbRes = await compactor.compact(fallbackStore, {
            agentId: 'main',
            watermark: { high: fbTokens - 1, low: Math.floor(fbTokens * 0.5) },
            summarizeChunk: fbCallback,
        });

        expect(fbRes.compacted).toBe(true);
        expect(fbRes.mode).toBe('fallback');
        expect(fbCallback).toHaveBeenCalledTimes(1);
        expect(fbRes.summaryPath).toBe('/history/summary.md');
        expect(await vfs.readFile('/history/summary.md')).toBe('内置兜底前情提要：第0轮事件已完成。');
        expect(fallbackStore.getMessages('main')[0].content).toContain('<history-summary');
    });

    it('aborts cleanly without mutating VFS or TrajectoryStore when AbortSignal triggers', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        store.appendTurn(
            [
                { role: 'user', content: 'A'.repeat(500) },
                { role: 'assistant', content: 'B'.repeat(500) },
            ],
            'main',
        );
        store.appendTurn(
            [
                { role: 'user', content: 'C'.repeat(500) },
                { role: 'assistant', content: 'D'.repeat(500) },
            ],
            'main',
        );

        const controller = new AbortController();
        const tokens = compactor.estimateCurrentTokens(store);

        await expect(
            compactor.compact(store, {
                agentId: 'main',
                watermark: { high: tokens - 1, low: 100 },
                signal: controller.signal,
                summarizeChunk: async (_chunk, sig) => {
                    expect(sig).toBe(controller.signal);
                    controller.abort();
                    return 'late summary';
                },
            }),
        ).rejects.toThrow(/aborted/i);

        expect(store.getMessageCount('main')).toBe(4);
        expect(store.getArchivedUpToChunk('main')).toBe(0);
        await expect(vfs.listDir('/history')).resolves.toEqual([]);
    });

    it('folds all 6 read-only tool types (>400 chars), supports sequential chunk-002 rolling summary, and detects lore-entry summary triggers for Bridge Mode', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const compactor = new WatermarkCompactor({ vfs, bridge });

        const bigOut = '只读工具检索详细输出文本。'.repeat(45); // > 400 chars

        // Turn 0 (archived in compaction #1)
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 0：'.repeat(30) },
                { role: 'assistant', content: 'Turn 0 reply：'.repeat(30) },
            ],
            'main',
        );

        // Turn 1 (retained, older than K=1 -> holds grep_search, list_dir, glob_files, read_history)
        store.appendTurn(
            [
                { role: 'user', content: '执行四类只读检查' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { id: 'r1', name: 'grep_search', arguments: '{"query":"银莲花"}' },
                        { id: 'r2', name: 'list_dir', arguments: '{"path":"/lorebooks"}' },
                        { id: 'r3', name: 'glob_files', arguments: '{"pattern":"/lorebooks/**/*.md"}' },
                        { id: 'r4', name: 'read_history', arguments: '{"path":"/history/chunk-000.md"}' },
                    ],
                },
                { role: 'tool', toolCallId: 'r1', toolName: 'grep_search', content: bigOut },
                { role: 'tool', toolCallId: 'r2', toolName: 'list_dir', content: bigOut },
                { role: 'tool', toolCallId: 'r3', toolName: 'glob_files', content: bigOut },
                { role: 'tool', toolCallId: 'r4', toolName: 'read_history', content: bigOut },
                { role: 'assistant', content: '四类检查已整理完成。' },
            ],
            'main',
        );

        // Turn 2 (recent K=1)
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 2 user' },
                { role: 'assistant', content: 'Turn 2 assistant' },
            ],
            'main',
        );

        const tBefore1 = compactor.estimateCurrentTokens(store);
        const res1 = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: tBefore1 - 1, low: Math.floor(tBefore1 * 0.4) },
            keepRecentTurns: 1,
            summarizeChunk: async () => '第一段提要：完成初始排查。',
        });

        expect(res1.compacted).toBe(true);
        expect(res1.chunkNumber).toBe(1);
        expect(res1.foldedToolResultCount).toBe(4);
        const { turns: afterFirstTurns } = groupLayer1Turns(
            store.getMessages('main'),
            store.getCompactionHeaderCount('main'),
        );
        const toolResults = afterFirstTurns[0].messages.filter((m) => m.role === 'tool');
        expect(toolResults).toHaveLength(4);
        for (const tr of toolResults) {
            expect(String(tr.content).startsWith(FOLDED_OUTPUT_PREFIX)).toBe(true);
        }

        // Add Turn 3 & run second compaction -> chunk-002.md + rolling summary receives prior summary
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 3 新剧情：'.repeat(50) },
                { role: 'assistant', content: 'Turn 3 推进：'.repeat(50) },
            ],
            'main',
        );
        const tBefore2 = compactor.estimateCurrentTokens(store);
        let sawPriorSummary = false;
        const res2 = await compactor.compact(store, {
            agentId: 'main',
            watermark: { high: tBefore2 - 1, low: Math.floor(tBefore2 * 0.45) },
            keepRecentTurns: 1,
            summarizeChunk: async (chunkInput) => {
                sawPriorSummary = chunkInput.includes('第一段提要：完成初始排查。');
                return '滚动合并提要：包含第一、二段全部进展。';
            },
        });

        expect(res2.compacted).toBe(true);
        expect(res2.archivedChunkPath).toBe('/history/chunk-002.md');
        expect(sawPriorSummary).toBe(true);
        expect(await vfs.readFile('/history/chunk-002.md')).toContain('四类检查已整理完成');
        expect(await vfs.readFile('/history/summary.md')).toBe('滚动合并提要：包含第一、二段全部进展。');

        // Verify auto-detection of lore-entry summary/important-table trigger uses Bridge Mode with 0 LLM calls
        const bridgeStore = new TrajectoryStore();
        bridgeStore.appendTurn(
            [
                { role: 'user', content: 'A'.repeat(400) },
                { role: 'assistant', content: 'B'.repeat(400) },
            ],
            'main',
        );
        bridgeStore.appendTurn(
            [
                { role: 'user', content: 'C'.repeat(400) },
                { role: 'assistant', content: 'D'.repeat(400) },
            ],
            'main',
        );
        const outlineLore: RawLoreEntry = {
            world: 'W',
            uid: 88,
            comment: '重要信息表格与剧情大纲',
            content: '@@replace\n根据每轮剧情维护大纲与重要信息表格。',
            keys: [],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 1,
            depth: 4,
            order: 10,
            role: 0,
        };
        const loreBridgeSpy = vi.fn(async () => 'MUST_NOT_RUN');
        const bt = compactor.estimateCurrentTokens(bridgeStore);
        const loreBridgeRes = await compactor.compact(bridgeStore, {
            agentId: 'main',
            watermark: { high: bt - 1, low: 100 },
            loreEntries: [outlineLore],
            summarizeChunk: loreBridgeSpy,
        });

        expect(loreBridgeRes.compacted).toBe(true);
        expect(loreBridgeRes.mode).toBe('bridge');
        expect(loreBridgeSpy).not.toHaveBeenCalled();
        expect(loreBridgeRes.referencedSummaryPaths).toEqual(['/memory/outline.md', '/memory/summary.md']);
    });
});
