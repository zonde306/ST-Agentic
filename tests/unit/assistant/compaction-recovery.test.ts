import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    ASSISTANT_FOLDED_OUTPUT_PREFIX,
    AssistantRunner,
    AssistantSessionStore,
    buildDeterministicSummary,
    toAssistantThreadId,
    type AssistantToolDefinition,
} from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import {
    resolveEffectiveContextBudget,
    TrajectoryStore,
    TransientToolSpillStore,
} from '@/core/context';
import { LLMTransportError } from '@/core/llm';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

function createStoreHarness(options?: { watermark?: { high: number; low: number } }) {
    const bridge = createOffMainlineTestBridge();
    const trajectoryStore = new TrajectoryStore();
    const store = new AssistantSessionStore({
        bridge,
        trajectoryStore,
        persistenceMode: 'memory',
        watermark: options?.watermark,
    });
    return { bridge, trajectoryStore, store };
}

function createRunnerHarness(
    turns: ScriptedTurnInput[] = [],
    extra?: {
        stream?: boolean;
        contextSize?: number;
        maxTokens?: number;
        extraTools?: readonly AssistantToolDefinition[];
        spillStore?: TransientToolSpillStore;
    },
) {
    const bridge = createOffMainlineTestBridge();
    const transport = new ScriptedLLMTransport(turns);
    const trajectoryStore = new TrajectoryStore();
    const spillStore = extra?.spillStore ?? new TransientToolSpillStore();
    const settings = createDefaultSettings();
    settings.connections.default = {
        ...settings.connections.default,
        model: 'gemini-2.5-pro',
        contextSize: extra?.contextSize ?? 1_048_576,
        maxTokens: extra?.maxTokens ?? 4096,
    };

    const runner = new AssistantRunner({
        bridge,
        transport,
        trajectoryStore,
        spillStore,
        settings,
        stream: extra?.stream ?? true,
        extraTools: extra?.extraTools,
    });

    return { bridge, transport, trajectoryStore, spillStore, settings, runner };
}

describe('Assistant Three-Stage Compaction, Calibrated Tokens & Overflow Recovery (C1.2)', () => {
    it('Stage 1: folds stale large tool outputs across multi-turn sessions in-place while preserving toolCallId pairing and recent turns', async () => {
        const { store, trajectoryStore } = createStoreHarness({ watermark: { high: 1000, low: 500 } });
        const session = store.createSession({ title: 'Stage 1 多轮折叠', mode: 'chat' });
        store.ensureFrozenPrefix(session.id, 'SYSTEM_PROMPT', []);

        const bigPayload = 'A'.repeat(1200);
        const smallPayload = 'short ok output';

        // Turn 0 (stale, older than keepRecentTurns=2): has 1 large tool + 1 small tool
        store.appendMessage(session.id, { id: 'u0', role: 'user', content: '查设置', timestamp: 1 });
        store.appendMessage(session.id, { id: 'a0', role: 'assistant', content: '查完了', timestamp: 2 });
        store.appendTrajectoryTurn(session.id, [
            { role: 'user', content: '查设置' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: 'call_old_big',
                        name: 'st_settings_read',
                        arguments: JSON.stringify({ scope: 'power_user' }),
                    },
                    {
                        id: 'call_old_small',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/workspace/tiny.md' }),
                    },
                ],
            },
            { role: 'tool', toolCallId: 'call_old_big', toolName: 'st_settings_read', content: bigPayload },
            { role: 'tool', toolCallId: 'call_old_small', toolName: 'read_file', content: smallPayload },
            { role: 'assistant', content: '查完了' },
        ]);

        // Turn 1 & Turn 2 (within keepRecentTurns=2): both have large tool outputs that must stay unfolded
        for (let i = 1; i <= 2; i += 1) {
            store.appendMessage(session.id, { id: `u${i}`, role: 'user', content: `最近问题 ${i}`, timestamp: i * 10 });
            store.appendMessage(session.id, { id: `a${i}`, role: 'assistant', content: `最近回复 ${i}`, timestamp: i * 10 + 1 });
            store.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `最近问题 ${i}` },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        {
                            id: `call_recent_${i}`,
                            name: 'wi_read_enabled',
                            arguments: JSON.stringify({ bookName: `书${i}` }),
                        },
                    ],
                },
                {
                    role: 'tool',
                    toolCallId: `call_recent_${i}`,
                    toolName: 'wi_read_enabled',
                    content: 'B'.repeat(900),
                },
                { role: 'assistant', content: `最近回复 ${i}` },
            ]);
        }

        const report = await store.compactSession(session.id, { mode: 'fold_only' });
        expect(report.compacted).toBe(true);
        expect(report.summaryMode).toBe('fold_only');
        expect(report.foldedToolResults).toBe(1);
        expect(report.archivedTurns).toBe(0);
        expect(report.tokensAfter).toBeLessThan(report.tokensBefore);

        const threadMsgs = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        // No summary header created in fold_only mode
        expect(threadMsgs[0].role).toBe('user');

        // Stale big tool was folded in-place with intact toolCallId & toolName
        const foldedTool = threadMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_old_big')!;
        expect(foldedTool).toBeDefined();
        expect(foldedTool.toolName).toBe('st_settings_read');
        expect(String(foldedTool.content)).toContain(ASSISTANT_FOLDED_OUTPUT_PREFIX);
        expect(String(foldedTool.content)).toContain('st_settings_read');
        expect(String(foldedTool.content)).toContain('power_user');
        expect(String(foldedTool.content)).toContain('1200');

        // Stale small tool <= 400 chars was NOT folded
        const smallTool = threadMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_old_small')!;
        expect(smallTool.content).toBe(smallPayload);

        // Recent turns' large tool outputs remained unfolded
        const recentTool1 = threadMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_recent_1')!;
        const recentTool2 = threadMsgs.find((m) => m.role === 'tool' && m.toolCallId === 'call_recent_2')!;
        expect(recentTool1.content).toBe('B'.repeat(900));
        expect(recentTool2.content).toBe('B'.repeat(900));

        // UI messages 100% preserved & compactionNotice attached to latest message
        const updatedSession = store.getSession(session.id)!;
        expect(updatedSession.messages).toHaveLength(6);
        expect(updatedSession.messages[5].compactionNotice?.foldedToolResults).toBe(1);
        expect(updatedSession.messages[5].compactionNotice?.summaryMode).toBe('fold_only');
    });

    it('Stage 1 single-turn urgent folding: folds earlier tool rounds within a single turn older than latest 1 tool round', async () => {
        const { store, trajectoryStore } = createStoreHarness();
        const session = store.createSession({ title: '单轮多工具折叠', mode: 'chat' });
        store.ensureFrozenPrefix(session.id, 'SYS', []);

        store.appendMessage(session.id, { id: 'u0', role: 'user', content: '多步排查', timestamp: 1 });
        store.appendMessage(session.id, { id: 'a0', role: 'assistant', content: '完成排查', timestamp: 2 });
        store.appendTrajectoryTurn(session.id, [
            { role: 'user', content: '多步排查' },
            // Round 1 (earlier -> MUST fold)
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'tc_r1', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/a.md' }) }],
            },
            { role: 'tool', toolCallId: 'tc_r1', toolName: 'read_file', content: 'X'.repeat(1500) },
            // Round 2 (latest 1 round -> MUST stay unfolded)
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'tc_r2', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/b.md' }) }],
            },
            { role: 'tool', toolCallId: 'tc_r2', toolName: 'read_file', content: 'Y'.repeat(1500) },
            { role: 'assistant', content: '完成排查' },
        ]);

        const report = await store.compactSession(session.id, { mode: 'auto', targetLowTokens: 50 });
        expect(report.compacted).toBe(true);
        expect(report.foldedToolResults).toBe(1);
        expect(report.archivedTurns).toBe(0);
        expect(report.summaryMode).toBe('fold_only');

        const msgs = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        const r1Tool = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'tc_r1')!;
        const r2Tool = msgs.find((m) => m.role === 'tool' && m.toolCallId === 'tc_r2')!;
        expect(String(r1Tool.content)).toContain(ASSISTANT_FOLDED_OUTPUT_PREFIX);
        expect(String(r1Tool.content)).toContain('/workspace/a.md');
        expect(r2Tool.content).toBe('Y'.repeat(1500));
    });

    it('Stage 2 & 3: archives raw transcript to /side/.assistant-archive, runs LLM summary with focusInstruction, falls back deterministically on error, and preserves all UI messages', async () => {
        const { store, trajectoryStore } = createStoreHarness();
        const session = store.createSession({ title: 'Stage 2 归档与摘要', mode: 'chat' });
        store.ensureFrozenPrefix(session.id, 'SYS', []);

        for (let i = 0; i < 4; i += 1) {
            store.appendMessage(session.id, { id: `u_${i}`, role: 'user', content: `第 ${i + 1} 轮需求：${'详细背景'.repeat(30)}`, timestamp: i * 2 });
            store.appendMessage(session.id, { id: `a_${i}`, role: 'assistant', content: `第 ${i + 1} 轮结论：${'分析结果'.repeat(30)}`, timestamp: i * 2 + 1 });
            store.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `第 ${i + 1} 轮需求：${'详细背景'.repeat(30)}` },
                { role: 'assistant', content: `第 ${i + 1} 轮结论：${'分析结果'.repeat(30)}` },
            ]);
        }

        const archivedFiles = new Map<string, string>();
        const llmSpy = vi.fn(async (input: { transcript: string; focusInstruction?: string }) => {
            expect(input.focusInstruction).toBe('务必保留世界书路由规则');
            expect(input.transcript).toContain('第 1 轮需求');
            return '1. 用户核心目标：改造世界书路由\n2. 关键对象：雾港侦探录\n3. 约束：保持 KV Cache 不变性\n4. 下一步：补充单测';
        });

        // 1. LLM summary succeeds
        const report1 = await store.compactSession(session.id, {
            mode: 'full',
            focusInstruction: '务必保留世界书路由规则',
            useLLMSummary: true,
            summarizeWithLLM: llmSpy,
            archiveWriter: (path, content) => {
                archivedFiles.set(path, content);
            },
        });

        expect(report1.compacted).toBe(true);
        expect(report1.summaryMode).toBe('llm');
        expect(report1.archivedTurns).toBe(3);
        expect(report1.archivedChunkPath).toBe(`/side/.assistant-archive/${session.id}/chunk-001.md`);
        expect(archivedFiles.has(report1.archivedChunkPath!)).toBe(true);
        expect(archivedFiles.get(report1.archivedChunkPath!)).toContain('delivery: none');
        expect(archivedFiles.get(report1.archivedChunkPath!)).toContain('第 1 轮需求');
        expect(llmSpy).toHaveBeenCalledTimes(1);

        // UI messages 100% preserved (8 messages) & compactionNotice attached to last bubble
        const s1 = store.getSession(session.id)!;
        expect(s1.messages).toHaveLength(8);
        expect(s1.messages[7].compactionNotice?.summaryMode).toBe('llm');
        expect(s1.messages[7].compactionNotice?.focusInstruction).toBe('务必保留世界书路由规则');
        expect(s1.messages[7].compactionNotice?.archivedChunkPath).toBe(report1.archivedChunkPath);

        // TrajectoryStore keeps summary header + latest 1 complete turn (3 messages total)
        const layer1 = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(layer1).toHaveLength(3);
        expect(layer1[0].role).toBe('system');
        expect(String(layer1[0].content)).toContain('<assistant-history-summary>');
        expect(String(layer1[0].content)).toContain('改造世界书路由');

        // 2. Append 2 more turns and trigger another compaction where LLM summarizer FAILS -> deterministic fallback
        for (let i = 4; i < 6; i += 1) {
            store.appendMessage(session.id, { id: `u_${i}`, role: 'user', content: `新增第 ${i + 1} 轮`, timestamp: i * 2 });
            store.appendMessage(session.id, { id: `a_${i}`, role: 'assistant', content: `新增回复 ${i + 1}`, timestamp: i * 2 + 1 });
            store.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `新增第 ${i + 1} 轮` },
                { role: 'assistant', content: `新增回复 ${i + 1}` },
            ]);
        }

        const report2 = await store.compactSession(session.id, {
            mode: 'full',
            focusInstruction: '保留超时降级校验',
            useLLMSummary: true,
            summarizeWithLLM: async () => {
                throw new Error('Upstream 504 Gateway Timeout');
            },
            archiveWriter: (path, content) => {
                archivedFiles.set(path, content);
            },
        });

        expect(report2.compacted).toBe(true);
        expect(report2.summaryMode).toBe('deterministic');
        expect(report2.archivedChunkPath).toBe(`/side/.assistant-archive/${session.id}/chunk-002.md`);
        expect(report2.summaryText).toContain('保留超时降级校验');
        expect(store.getSession(session.id)!.messages).toHaveLength(12);

        // Standalone buildDeterministicSummary sanity check
        const det = buildDeterministicSummary([], { focusInstruction: '重点规则' });
        expect(det).toContain('重点规则');
    });

    it('Calibrated token counter: applies anchor formula, maps normal/warning/danger thresholds, and resets anchor on compact/edit/retract/clear', async () => {
        const { store } = createStoreHarness();
        const session = store.createSession({ title: '校准计数器测试', mode: 'chat' });
        store.ensureFrozenPrefix(session.id, 'STATIC_SYS', []);
        store.appendMessage(session.id, { id: 'u1', role: 'user', content: '第一问', timestamp: 1 });
        store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '第一答', timestamp: 2 });
        store.appendTrajectoryTurn(session.id, [
            { role: 'user', content: '第一问' },
            { role: 'assistant', content: '第一答' },
        ]);

        const budget = resolveEffectiveContextBudget(
            { contextSize: 10_000, maxTokens: 1_024, model: 'test-model' },
            { configuredWatermark: { high: 7_000, low: 3_500 } },
        );
        // safeInputBudget = 10000 - 1024 - 512 = 8464
        const initial = store.getSessionTokenStatus(session.id, budget)!;
        expect(initial.level).toBe('normal');
        expect(initial.activeTurnCount).toBe(1);
        expect(initial.activeMessageCount).toBe(2);

        // Record calibration anchor where actual upstream tokens (6200) >> local estimate
        const estAtCall = initial.currentTokens;
        store.recordUsageAnchor(session.id, 6_200, estAtCall);

        // Append more trajectory messages -> calibrated count grows by delta from anchor
        store.appendMessage(session.id, { id: 'u2', role: 'user', content: '第二问补充内容'.repeat(20), timestamp: 3 });
        store.appendMessage(session.id, { id: 'a2', role: 'assistant', content: '第二答补充内容'.repeat(20), timestamp: 4 });
        store.appendTrajectoryTurn(session.id, [
            { role: 'user', content: '第二问补充内容'.repeat(20) },
            { role: 'assistant', content: '第二答补充内容'.repeat(20) },
        ]);

        const warningStatus = store.getSessionTokenStatus(session.id, budget)!;
        // 6200 + delta (~280) ≈ 6480 -> ~77% of 8464 (< 7000 highWatermark) -> warning!
        expect(warningStatus.currentTokens).toBeGreaterThan(6_200);
        expect(warningStatus.usagePercent).toBeGreaterThanOrEqual(70);
        expect(warningStatus.usagePercent).toBeLessThan(90);
        expect(warningStatus.level).toBe('warning');

        // Push anchor to >= highWatermark (7000) -> danger
        store.recordUsageAnchor(session.id, 7_100, warningStatus.currentTokens - 6_200 + estAtCall);
        const dangerStatus = store.getSessionTokenStatus(session.id, budget)!;
        expect(dangerStatus.level).toBe('danger');

        // Compact resets anchor -> drops back to uncalibrated post-compaction estimate
        const compactReport = await store.compactSession(session.id, { mode: 'full', useLLMSummary: false });
        expect(compactReport.compacted).toBe(true);
        expect(store.getUsageAnchor(session.id)).toBeNull();
        const postCompact = store.getSessionTokenStatus(session.id, budget)!;
        expect(postCompact.level).toBe('normal');
        expect(postCompact.compactedCount).toBeGreaterThanOrEqual(1);
        expect(postCompact.summaryPreview).toBeTruthy();

        // Re-anchor then retract -> resets anchor
        store.recordUsageAnchor(session.id, 5_000, postCompact.currentTokens);
        expect(store.getUsageAnchor(session.id)).not.toBeNull();
        store.retractFromMessage(session.id, 'u2');
        expect(store.getUsageAnchor(session.id)).toBeNull();

        // Re-anchor then clearSession -> resets anchor and clears messages/trajectory
        store.recordUsageAnchor(session.id, 5_000, 100);
        const cleared = store.clearSession(session.id)!;
        expect(cleared.messages).toHaveLength(0);
        expect(store.getUsageAnchor(session.id)).toBeNull();
        expect(store.getSessionTokenStatus(session.id, budget)!.activeTurnCount).toBe(0);
    });

    it('Compaction-safe editMessage & retractMessage: retains summary on retained-turn edits and safely rebuilds on archived-turn edits/retracts', async () => {
        const { store, trajectoryStore } = createStoreHarness();
        const session = store.createSession({ title: '压缩后编辑撤回对齐', mode: 'chat' });
        store.ensureFrozenPrefix(session.id, 'SYS', []);

        for (let i = 0; i < 4; i += 1) {
            store.appendMessage(session.id, { id: `u${i}`, role: 'user', content: `用户第 ${i} 轮`, timestamp: i * 10 });
            store.appendMessage(session.id, { id: `a${i}`, role: 'assistant', content: `助手第 ${i} 轮`, timestamp: i * 10 + 1 });
            store.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `用户第 ${i} 轮` },
                { role: 'assistant', content: `助手第 ${i} 轮` },
            ]);
        }

        // Compact turns 0..2, retaining turn 3
        await store.compactSession(session.id, { mode: 'full', useLLMSummary: false });
        const threadId = toAssistantThreadId(session.id);
        expect(trajectoryStore.getCompactionHeaderCount(threadId)).toBe(1);

        // 1. Edit retained turn 3's assistant reply -> summary header MUST stay intact!
        store.updateMessage(session.id, 'a3', (prev) => ({ ...prev, content: '助手第 3 轮（已编辑）' }));
        store.syncTrajectoryToMessages(session.id);

        const afterRetainedEdit = trajectoryStore.getMessages(threadId);
        expect(afterRetainedEdit[0].role).toBe('system');
        expect(String(afterRetainedEdit[0].content)).toContain('<assistant-history-summary>');
        expect(afterRetainedEdit[afterRetainedEdit.length - 1].content).toBe('助手第 3 轮（已编辑）');

        // 2. Edit archived turn 0's user message -> summary is now stale -> MUST safely drop header & rebuild from UI turns!
        store.recordUsageAnchor(session.id, 9999, 100);
        store.updateMessage(session.id, 'u0', (prev) => ({ ...prev, content: '用户第 0 轮（改写早期历史）' }));
        store.syncTrajectoryToMessages(session.id);

        expect(store.getUsageAnchor(session.id)).toBeNull();
        const afterArchivedEdit = trajectoryStore.getMessages(threadId);
        expect(trajectoryStore.getCompactionHeaderCount(threadId)).toBe(0);
        expect(afterArchivedEdit[0].role).toBe('user');
        expect(afterArchivedEdit[0].content).toBe('用户第 0 轮（改写早期历史）');
        expect(afterArchivedEdit).toHaveLength(8);

        // 3. Compact again, then retract into archived turn 1 -> safely rebuilds remaining turn 0 without stale summary!
        await store.compactSession(session.id, { mode: 'full', useLLMSummary: false });
        expect(trajectoryStore.getCompactionHeaderCount(threadId)).toBe(1);
        store.retractFromMessage(session.id, 'u1');

        const afterArchivedRetract = trajectoryStore.getMessages(threadId);
        expect(trajectoryStore.getCompactionHeaderCount(threadId)).toBe(0);
        expect(afterArchivedRetract).toHaveLength(2);
        expect(afterArchivedRetract[0].content).toBe('用户第 0 轮（改写早期历史）');
    });

    it('AssistantRunner pre-flight budget check triggers auto compaction before sending oversized context', async () => {
        // contextSize = 8192, maxTokens = 1024 -> safeInputBudget = 6656, preFlightThreshold = 5857, autoHighWatermark = 4992
        const { runner, transport, trajectoryStore } = createRunnerHarness(
            [
                { content: '第一轮答复已完成。', usage: { inputTokens: 2500, cachedTokens: 0, outputTokens: 20 } },
            ],
            { contextSize: 8192, maxTokens: 1024, stream: false },
        );

        const session = await runner.createSession({ title: '预检压缩测试', mode: 'chat' });

        // Pre-populate 6 turns (~6500 tokens total with tools) so Layer 0 + tools + Layer 1 exceed preFlightThreshold (5857)
        for (let i = 0; i < 6; i += 1) {
            const uText = `历史背景第 ${i + 1} 轮：${'线索记录与详细上下文分析内容'.repeat(30)}`;
            const aText = `历史结论第 ${i + 1} 轮：${'已归档的调查阶段性总结文本'.repeat(30)}`;
            runner.sessionStore.appendMessage(session.id, { id: `hu_${i}`, role: 'user', content: uText, timestamp: i * 10 });
            runner.sessionStore.appendMessage(session.id, { id: `ha_${i}`, role: 'assistant', content: aText, timestamp: i * 10 + 1 });
            runner.sessionStore.appendTrajectoryTurn(session.id, [
                { role: 'user', content: uText },
                { role: 'assistant', content: aText },
            ]);
        }

        // Send a prompt -> total tokens exceed preFlightThreshold, so pre-flight compacts BEFORE calling transport!
        const reply = await runner.sendPrompt(session.id, '请继续下一步诊断');
        expect(reply.content).toBe('第一轮答复已完成。');
        expect(reply.compactionNotice).toBeDefined();
        expect(reply.compactionNotice!.archivedTurns).toBeGreaterThanOrEqual(1);

        // Verify the request actually sent to LLM already had the <assistant-history-summary> header!
        expect(transport.requests).toHaveLength(1);
        const sentMessages = transport.requests[0].messages;
        expect(
            sentMessages.some(
                (m) => m.role === 'system' && String(m.content).includes('<assistant-history-summary>'),
            ),
        ).toBe(true);

        // UI messages were NOT deleted (12 pre-populated + 2 new = 14)
        expect(runner.getSession(session.id)!.messages).toHaveLength(14);
        expect(trajectoryStore.getCompactionHeaderCount(toAssistantThreadId(session.id))).toBe(1);
    });

    it('AssistantRunner auto-recovers from Gemini 1048576 overflow: disables LLM summary, crops inFlight tool content in-place preserving toolCallId, clears partial buffers, and succeeds on retry', async () => {
        const bigToolOutput = 'MEGA_DUMP_'.repeat(300); // 3000 chars
        const customBigTool: AssistantToolDefinition = {
            name: 'read_file',
            description: 'Mock large read_file tool for overflow recovery test',
            parameters: z.object({ path: z.string() }),
            tier: 'chat',
            readOnly: true,
            execute: async () => ({
                ok: true,
                output: bigToolOutput,
                hasSecretRedaction: false,
                redactionCount: 0,
            }),
        };

        const geminiOverflowError = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
            { status: 400 },
        );

        const { runner, transport } = createRunnerHarness(
            [
                // Round 1: model calls read_file -> returns 3000-char payload
                {
                    toolCalls: [
                        {
                            id: 'call_gemini_big_1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/workspace/huge.json' }),
                        },
                    ],
                    usage: { inputTokens: 800, cachedTokens: 0, outputTokens: 30 },
                },
                // Round 2 Attempt 1: emits partial garbage then throws Gemini 1048576 overflow!
                {
                    content: '残余半截流式文本...',
                    reasoningContent: '残余半截思考...',
                    chunkSize: 4,
                    error: geminiOverflowError,
                    errorAfterChunks: 2,
                },
                // Round 2 Attempt 2 (seamless auto-recovery retry): succeeds cleanly!
                {
                    content: '已从超限状态自动恢复，请按 keyPath 分段查询。',
                    usage: { inputTokens: 1200, cachedTokens: 0, outputTokens: 45 },
                },
            ],
            { extraTools: [customBigTool], stream: true },
        );

        const session = await runner.createSession({ title: 'Gemini 超限自愈测试', mode: 'chat' });

        // Add 2 prior turns so history compaction also exercises useLLMSummary: false
        runner.sessionStore.ensureFrozenPrefix(session.id, 'SYS', []);
        for (let i = 0; i < 2; i += 1) {
            runner.sessionStore.appendMessage(session.id, { id: `p_u_${i}`, role: 'user', content: `早期问题 ${i}`, timestamp: i });
            runner.sessionStore.appendMessage(session.id, { id: `p_a_${i}`, role: 'assistant', content: `早期答复 ${i}`, timestamp: i + 1 });
            runner.sessionStore.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `早期问题 ${i}` },
                { role: 'assistant', content: `早期答复 ${i}` },
            ]);
        }

        const reply = await runner.sendPrompt(session.id, '帮我分析 huge.json');

        // 1. Exactly 3 transport calls total (Round 1 + Round 2 failed + Round 2 retry).
        //    ZERO extra LLM summarization calls (useLLMSummary: false strictly enforced)!
        expect(transport.requests).toHaveLength(3);

        // 2. Retry request preserved toolCallId & assistant.toolCalls pairing while cropping tool content in-place!
        const retryReq = transport.requests[2];
        const assistantToolCallMsg = retryReq.messages.find(
            (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'call_gemini_big_1'),
        );
        const croppedToolMsg = retryReq.messages.find(
            (m) => m.role === 'tool' && m.toolCallId === 'call_gemini_big_1',
        );
        expect(assistantToolCallMsg).toBeDefined();
        expect(croppedToolMsg).toBeDefined();
        expect(croppedToolMsg!.toolName).toBe('read_file');
        expect(String(croppedToolMsg!.content)).toContain('1048576');
        expect(String(croppedToolMsg!.content).length).toBeLessThan(bigToolOutput.length);

        // 3. Partial streaming content/reasoning from failed attempt was cleanly wiped before retry!
        expect(reply.content).toBe('已从超限状态自动恢复，请按 keyPath 分段查询。');
        expect(reply.content).not.toContain('残余半截流式文本');
        expect(reply.think).toBeUndefined();
        expect(reply.interrupted).toBeUndefined();
        expect(reply.errorCode).toBeUndefined();
        expect(reply.compactionNotice).toBeDefined();
        expect(reply.compactionNotice!.foldedToolResults).toBeGreaterThanOrEqual(1);
        expect(reply.compactionNotice!.summaryMode).toBe('deterministic');
    });

    it('AssistantRunner stops after at-most-1 overflow recovery retry on double-overflow and marks errorCode: context_overflow', async () => {
        const overflowErr1 = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
            { status: 400 },
        );
        const overflowErr2 = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1500000',
            { status: 400 },
        );

        const { runner, transport } = createRunnerHarness(
            [
                { error: overflowErr1 },
                { error: overflowErr2 },
                // Extra queued turn must NEVER be reached!
                { content: 'SHOULD_NOT_BE_CALLED' },
            ],
            { stream: false },
        );

        const session = await runner.createSession({ title: '二次超限熔断测试', mode: 'chat' });
        for (let i = 0; i < 2; i += 1) {
            runner.sessionStore.appendMessage(session.id, { id: `du_${i}`, role: 'user', content: `问题 ${i}`, timestamp: i });
            runner.sessionStore.appendMessage(session.id, { id: `da_${i}`, role: 'assistant', content: `回答 ${i}`, timestamp: i + 1 });
            runner.sessionStore.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `问题 ${i}` },
                { role: 'assistant', content: `回答 ${i}` },
            ]);
        }

        await expect(runner.sendPrompt(session.id, '超大附件请求')).rejects.toThrow('1048576');

        // Stopped strictly after 1 recovery retry (2 calls total, 3rd queued turn untouched)
        expect(transport.requests).toHaveLength(2);
        expect(transport.remainingTurns).toBe(1);

        const latestSession = runner.getSession(session.id)!;
        const lastAssistant = latestSession.messages[latestSession.messages.length - 1];
        expect(lastAssistant.role).toBe('assistant');
        expect(lastAssistant.interrupted).toBe(true);
        expect(lastAssistant.errorCode).toBe('context_overflow');
    });

    it('AssistantRunner exposes public compactSession (with LLM temperature 0.2 & tools: []) + getSessionTokenStatus + spillStore lifecycle cleanup', async () => {
        const spillStore = new TransientToolSpillStore();
        let capturedSpillStore: TransientToolSpillStore | undefined;

        const spyTool: AssistantToolDefinition = {
            name: 'read_file',
            description: 'Spy tool checking spillStore injection',
            parameters: z.object({ path: z.string() }),
            tier: 'chat',
            readOnly: true,
            execute: async (_args, ctx) => {
                capturedSpillStore = ctx.spillStore;
                ctx.spillStore?.put({
                    toolCallId: ctx.toolCallId,
                    toolName: 'read_file',
                    content: 'spilled content line 1\nspilled content line 2',
                    scopeId: ctx.sessionId,
                });
                return {
                    ok: true,
                    output: 'ok',
                    hasSecretRedaction: false,
                    redactionCount: 0,
                };
            },
        };

        const { runner, transport } = createRunnerHarness(
            [
                // Turn 1: calls spyTool
                {
                    toolCalls: [
                        { id: 'tc_spill_1', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/a.md' }) },
                    ],
                    usage: { inputTokens: 600, cachedTokens: 0, outputTokens: 20 },
                },
                {
                    content: '第 1 轮完成',
                    usage: { inputTokens: 700, cachedTokens: 400, outputTokens: 20 },
                },
                // Turn 2
                {
                    content: '第 2 轮完成',
                    usage: { inputTokens: 900, cachedTokens: 600, outputTokens: 25 },
                },
                // Manual compactSession LLM summary response
                {
                    content: '1. 目标：验证手动压缩\n2. 文件：/workspace/a.md\n3. 约束：无\n4. 下一步：完成',
                },
            ],
            { extraTools: [spyTool], spillStore, stream: false },
        );

        expect(runner.getSpillStore()).toBe(spillStore);

        const session = await runner.createSession({ title: '手动压缩与溢出池生命周期', mode: 'chat' });
        await runner.sendPrompt(session.id, '读文件');
        await runner.sendPrompt(session.id, '继续');

        // spillStore was passed into AssistantToolContext and populated under sessionId scope
        expect(capturedSpillStore).toBe(spillStore);
        expect(spillStore.listPaths(session.id)).toHaveLength(1);

        // getSessionTokenStatus returns calibrated tokens from Turn 2 usage.inputTokens (900)
        const statusBefore = runner.getSessionTokenStatus(session.id)!;
        expect(statusBefore.currentTokens).toBeGreaterThanOrEqual(900);
        expect(statusBefore.activeTurnCount).toBe(2);

        // Manual compactSession invokes LLM with tools: [] and temperature: 0.2
        const compactReport = await runner.compactSession(session.id, {
            mode: 'full',
            focusInstruction: '保留 /workspace/a.md 读取记录',
        });
        expect(compactReport.compacted).toBe(true);
        expect(compactReport.summaryMode).toBe('llm');
        expect(compactReport.archivedTurns).toBe(1);

        const summaryReq = transport.requests[transport.requests.length - 1];
        expect(summaryReq.tools).toEqual([]);
        expect(summaryReq.connection?.temperature).toBe(0.2);
        expect(JSON.stringify(summaryReq.messages)).toContain('保留 /workspace/a.md 读取记录');

        // clearSession clears spillStore scope for this session
        await runner.clearSession(session.id);
        expect(spillStore.listPaths(session.id)).toHaveLength(0);

        // deleteSession also clears spillStore scope
        spillStore.put({
            toolCallId: 'tc_spill_2',
            toolName: 'read_file',
            content: 'temp',
            scopeId: session.id,
        });
        expect(spillStore.listPaths(session.id)).toHaveLength(1);
        await runner.deleteSession(session.id);
        expect(spillStore.listPaths(session.id)).toHaveLength(0);
    });

    it('Regression: in-flight overflow compaction followed by retracting failed Turn 4 preserves retained Turn 3 and <assistant-history-summary>', async () => {
        const overflowErr = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
            { status: 400 },
        );

        const { runner, trajectoryStore } = createRunnerHarness(
            [
                // Turn 4 attempt 1 -> overflows, triggers in-flight emergency compaction (archives Turns 1-2, retains Turn 3)
                { error: overflowErr },
                // Turn 4 attempt 2 -> overflows again, Turn 4 fails with context_overflow
                { error: overflowErr },
            ],
            { stream: false },
        );

        const session = await runner.createSession({ title: '在途压缩撤回回归', mode: 'chat' });

        // Commit 3 prior turns (Turns 1, 2, 3) into both UI session.messages and TrajectoryStore
        for (let i = 1; i <= 3; i += 1) {
            runner.sessionStore.appendMessage(session.id, {
                id: `u_t${i}`,
                role: 'user',
                content: `已提交第 ${i} 轮问题`,
                timestamp: i * 10,
            });
            runner.sessionStore.appendMessage(session.id, {
                id: `a_t${i}`,
                role: 'assistant',
                content: `已提交第 ${i} 轮答复`,
                timestamp: i * 10 + 1,
            });
            runner.sessionStore.appendTrajectoryTurn(session.id, [
                { role: 'user', content: `已提交第 ${i} 轮问题` },
                { role: 'assistant', content: `已提交第 ${i} 轮答复` },
            ]);
        }

        // Start Turn 4 -> fails after 1 overflow recovery retry
        await expect(runner.sendPrompt(session.id, '第 4 轮超大请求')).rejects.toThrow('1048576');

        const afterFail = runner.getSession(session.id)!;
        // UI has 3 prior turns (6 msgs) + Turn 4 user + Turn 4 failed assistant = 8 msgs
        expect(afterFail.messages).toHaveLength(8);
        const turn4UserMsg = afterFail.messages[6];
        expect(turn4UserMsg.role).toBe('user');
        expect(turn4UserMsg.content).toBe('第 4 轮超大请求');

        // User retracts failed Turn 4
        const retracted = await runner.retractMessage(session.id, turn4UserMsg.id);
        expect(retracted).not.toBeNull();
        expect(retracted!.removedMessages).toHaveLength(2);
        expect(runner.getSession(session.id)!.messages).toHaveLength(6);

        // TrajectoryStore MUST retain BOTH <assistant-history-summary> AND Turn 3 (3 messages total)!
        const threadId = toAssistantThreadId(session.id);
        const layer1 = trajectoryStore.getMessages(threadId);
        expect(trajectoryStore.getCompactionHeaderCount(threadId)).toBe(1);
        expect(layer1).toHaveLength(3);
        expect(layer1[0].role).toBe('system');
        expect(String(layer1[0].content)).toContain('<assistant-history-summary>');
        expect(layer1[1].role).toBe('user');
        expect(layer1[1].content).toBe('已提交第 3 轮问题');
        expect(layer1[2].role).toBe('assistant');
        expect(layer1[2].content).toBe('已提交第 3 轮答复');
    });
});
