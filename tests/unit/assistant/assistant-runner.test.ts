import { describe, expect, it } from 'vitest';
import {
    AssistantRunner,
    AssistantSessionStore,
    REDACTED_PLACEHOLDER,
    toAssistantThreadId,
} from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { AppStore, type AssistantRuntimeBridge } from '@/ui/store/app-store';
import { canonicalStringify } from '@/core/utils';
import {
    SAMPLE_RAW_AUTHOR_WI_ENTRY,
    createOffMainlineTestBridge,
} from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

function createRunnerHarness(turns: ScriptedTurnInput[] = [], extra?: { stream?: boolean }) {
    const bridge = createOffMainlineTestBridge();
    const transport = new ScriptedLLMTransport(turns);
    const trajectoryStore = new TrajectoryStore();
    const traceLogger = new TraceLogger();
    const settings = createDefaultSettings();
    settings.connections['aux-fast'] = {
        ...settings.connections.default,
        id: 'aux-fast',
        name: 'Aux Fast Model',
        model: 'claude-3-5-haiku',
        apiKey: 'sk-ant-aux-secret-key-0001',
    };

    const runner = new AssistantRunner({
        bridge,
        transport,
        trajectoryStore,
        traceLogger,
        settings,
        stream: extra?.stream ?? true,
    });

    return { bridge, transport, trajectoryStore, traceLogger, settings, runner };
}

describe('AssistantRunner & AssistantSessionStore (TS2.1)', () => {
    it('satisfies AssistantRuntimeBridge 1:1 and integrates directly with AppStore', async () => {
        const { runner } = createRunnerHarness([
            {
                content: '当前处于交流只读模式，我可以为你分析雾港剧情。',
                reasoningContent: '检查用户需求并简短回复。',
                usage: { inputTokens: 400, cachedTokens: 320, outputTokens: 30 },
            },
        ]);

        // Structural type-level & runtime assignment check against UI bridge
        const uiBridge: AssistantRuntimeBridge = runner;
        const appStore = new AppStore({ assistantRuntime: uiBridge });

        const session = await uiBridge.createSession({
            title: '雾港剧情诊断',
            mode: 'chat',
            connectionId: 'aux-fast',
        });

        await appStore.refreshAssistantState();
        expect(appStore.getSnapshot().assistantSessions).toHaveLength(1);
        expect(appStore.getSnapshot().assistantSessions[0].id).toBe(session.id);

        const deltas: string[] = [];
        const reply = await runner.sendPrompt(session.id, '帮我总结当前状态', {
            onDelta: (d) => deltas.push(d),
        });

        expect(reply.role).toBe('assistant');
        expect(reply.content).toBe('当前处于交流只读模式，我可以为你分析雾港剧情。');
        expect(reply.think).toBe('检查用户需求并简短回复。');
        expect(deltas.join('')).toBe(reply.content);
        expect(reply.usage?.cacheRate).toBe('80.0%');

        appStore.dispose();
    });

    it('enforces 4-tier tool allowlists, independent connectionId, and KV cache prefix invariance across turns', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness([
            // Turn 1: model in chat mode tries to call write tool -> policy denies -> model responds
            {
                toolCalls: [
                    {
                        id: 'call_denied_1',
                        name: 'chat_edit_message',
                        arguments: JSON.stringify({
                            target: { messageId: 1, swipeId: 0 },
                            newText: '非法改写',
                        }),
                    },
                ],
                usage: { inputTokens: 300, cachedTokens: 0, outputTokens: 20 },
            },
            {
                content: '当前是交流只读模式，无法修改消息。',
                usage: { inputTokens: 380, cachedTokens: 300, outputTokens: 25 },
            },
            // Turn 2: normal follow-up turn in same mode -> identical Layer 0 prefix & tool schemas
            {
                content: '好的，继续分析。',
                usage: { inputTokens: 450, cachedTokens: 380, outputTokens: 15 },
            },
        ]);

        const session = await runner.createSession({
            title: '只读模式校验',
            mode: 'chat',
            connectionId: 'aux-fast',
        });

        const msg1 = await runner.sendPrompt(session.id, '帮我改第 1 条消息');
        expect(msg1.toolCalls).toHaveLength(1);
        expect(msg1.toolCalls![0].status).toBe('error');
        expect(msg1.toolCalls![0].resultSummary).toContain('requires "adjust" mode');

        // Independent connectionId was honored
        expect(transport.requests[0].connectionId).toBe('aux-fast');
        expect(transport.requests[0].connection?.model).toBe('claude-3-5-haiku');

        // Chat mode only exposes the 12 read-only tools in canonical sorted order
        const chatToolNames = transport.requests[0].tools.map((t) => t.name);
        expect(chatToolNames).toHaveLength(12);
        expect(chatToolNames).toEqual([...chatToolNames].sort());
        expect(chatToolNames).not.toContain('chat_edit_message');
        expect(chatToolNames).not.toContain('card_patch_active');

        await runner.sendPrompt(session.id, '那你帮我看看线索吧');

        // KV cache prefix invariance: Layer 0 system prompt and canonical tools stay identical
        const req1 = transport.requests[0];
        const req3 = transport.requests[2];
        expect(canonicalStringify(req3.messages[0])).toBe(canonicalStringify(req1.messages[0]));
        expect(canonicalStringify(req3.tools)).toBe(canonicalStringify(req1.tools));
        expect(req3.cacheBreakpoints).toEqual([0, 4]);

        // TrajectoryStore uses thread key `assistant:<sessionId>`
        const threadId = toAssistantThreadId(session.id);
        expect(trajectoryStore.hasThread(threadId)).toBe(true);
        expect(trajectoryStore.getMessageCount(threadId)).toBeGreaterThanOrEqual(6);
    });

    it('runs full inline bubble approval lifecycle: pending -> reject -> retryApproval -> approve -> undo', async () => {
        const revisedContent = [
            '@@system',
            '保持冷硬派侦探叙事口吻，禁止代替用户发言。',
            '<% if (getvar("heat") > 5) { %>',
            '【修订版警戒】全城封锁，旧码头增派双倍哨兵。',
            '<% } %>',
        ].join('\n');

        const initialProposalContent = [
            '@@system',
            '初版规则草案。',
        ].join('\n');

        const { bridge, transport, runner } = createRunnerHarness([
            // Turn 1: model proposes wi_upsert_primary_entry (suspends for approval)
            {
                content: '我准备更新主世界书 #7 条目，请审阅下方 Diff。',
                toolCalls: [
                    {
                        id: 'call_wi_rev1',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            comment: '全局叙事规则与动态状态检查',
                            keys: ['规则', '警戒'],
                            content: initialProposalContent,
                        }),
                    },
                ],
                usage: { inputTokens: 600, cachedTokens: 400, outputTokens: 80 },
            },
            // Turn 2 (triggered by retryApproval): model receives feedback and proposes revised content
            {
                content: '已根据反馈补充 heat > 5 的 EJS 条件判断。',
                toolCalls: [
                    {
                        id: 'call_wi_rev2',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            comment: '全局叙事规则与动态状态检查',
                            keys: ['规则', '警戒'],
                            content: revisedContent,
                        }),
                    },
                ],
                usage: { inputTokens: 700, cachedTokens: 500, outputTokens: 110 },
            },
        ]);

        const session = await runner.createSession({
            title: '写卡审批闭环',
            mode: 'author',
            autoApproveAuthor: false,
        });

        // 1. Send prompt -> suspends into bubble-attached PendingApproval
        const bubble = await runner.sendPrompt(session.id, '帮我更新主世界书 #7 条目');
        expect(bubble.approvalIds).toHaveLength(1);
        const approvalId = bubble.approvalIds![0];

        const pending = runner.getApproval(approvalId)!;
        expect(pending.status).toBe('pending');
        expect(pending.revision).toBe(1);
        expect(pending.mandatoryConfirm).toBe(false);
        expect(pending.rawContent).toBe(initialProposalContent);
        expect(pending.diffLines.some((l) => l.type === 'del')).toBe(true);
        expect(pending.diffLines.some((l) => l.type === 'add' && l.text === '初版规则草案。')).toBe(
            true,
        );

        // Host WI MUST NOT be modified before approval!
        const beforeApproveEntry = (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.find(
            (e) => e.uid === 7,
        )!;
        expect(beforeApproveEntry.content).toBe(SAMPLE_RAW_AUTHOR_WI_ENTRY.content);

        // 2. Reject with feedback -> status = 'rejected', host still untouched
        const rejected = await runner.decideApproval(
            approvalId,
            'reject',
            '需要保留 heat > 5 的 EJS 判断并强调旧码头双倍哨兵',
        );
        expect(rejected?.status).toBe('rejected');
        expect(rejected?.rejectionFeedback).toContain('heat > 5');

        // 3. Retry with feedback -> injects feedback to LLM, revision increments 1 -> 2, status resets to pending
        const retried = await runner.retryApproval(
            approvalId,
            '请补充 heat > 5 的 EJS 条件与双倍哨兵告警',
        );
        expect(retried?.status).toBe('pending');
        expect(retried?.revision).toBe(2);
        expect(retried?.rawContent).toBe(revisedContent);
        expect(retried?.diffLines.some((l) => l.type === 'add' && l.text.includes('双倍哨兵'))).toBe(
            true,
        );

        // Verify feedback was actually injected into LLM retry request
        const retryRequestText = JSON.stringify(transport.requests[1].messages);
        expect(retryRequestText).toContain('双倍哨兵');

        // Still NOT written to host before approve!
        const stillOriginal = (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.find(
            (e) => e.uid === 7,
        )!;
        expect(stillOriginal.content).toBe(SAMPLE_RAW_AUTHOR_WI_ENTRY.content);

        // 4. Approve -> executes write, saves UndoRecord, attaches undoId
        const approved = await runner.decideApproval(approvalId, 'approve');
        expect(approved?.status).toBe('approved');
        expect(approved?.undoId).toBeDefined();
        expect(approved?.reverted).toBe(false);

        const afterApprove = (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.find(
            (e) => e.uid === 7,
        )!;
        expect(afterApprove.content).toBe(revisedContent);
        expect(afterApprove.content).toContain('@@system');
        expect(afterApprove.content).not.toContain('@@@system');

        // 5. Undo -> restores exact pre-write WI entry and marks both UndoRecord & PendingApproval reverted
        const undoResult = await runner.undo(approved!.undoId!);
        expect(undoResult.ok).toBe(true);
        expect(undoResult.status).toBe('reverted');

        const afterUndo = (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.find(
            (e) => e.uid === 7,
        )!;
        expect(afterUndo.content).toBe(SAMPLE_RAW_AUTHOR_WI_ENTRY.content);
        expect(runner.getApproval(approvalId)?.reverted).toBe(true);
        expect(runner.listUndoRecords(session.id)[0].reverted).toBe(true);
    });

    it('enforces non-bypassable mandatoryConfirm even when autoApproveAuthor is true', async () => {
        const { bridge, runner } = createRunnerHarness([
            // Turn 1: non-mandatory wi_upsert_primary_entry auto-executes under autoApproveAuthor=true
            {
                toolCalls: [
                    {
                        id: 'call_auto_upsert',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            keys: ['规则'],
                            content: '@@system\n自动批准写入成功',
                        }),
                    },
                ],
            },
            {
                content: '已自动完成主世界书写入。',
            },
            // Turn 2: mandatoryConfirm high-risk st_settings_patch MUST still suspend for manual approval!
            {
                content: '准备修改 power_user.fast_ui_mode，需要强制人工确认。',
                toolCalls: [
                    {
                        id: 'call_mandatory_settings',
                        name: 'st_settings_patch',
                        arguments: JSON.stringify({
                            scope: 'power_user',
                            patch: { fast_ui_mode: false },
                        }),
                    },
                ],
            },
            // Turn 3: mandatoryConfirm delete tool MUST still suspend even under autoApproveAuthor=true!
            {
                content: '准备删除主世界书条目 #7，需要强制人工确认。',
                toolCalls: [
                    {
                        id: 'call_mandatory_delete',
                        name: 'wi_delete_primary_entry',
                        arguments: JSON.stringify({ uid: 7 }),
                    },
                ],
            },
        ]);

        const session = await runner.createSession({
            title: '高危强制确认测试',
            mode: 'full',
            stAdminEnabled: true,
            autoApproveAuthor: true,
        });

        // 1. Non-mandatory author write auto-executes
        const msg1 = await runner.sendPrompt(session.id, '更新 #7');
        expect(msg1.approvalIds).toBeUndefined();
        expect(msg1.toolCalls?.[0].status).toBe('ok');
        expect(msg1.toolCalls?.[0].undoId).toBeDefined();
        expect(
            (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.find((e) => e.uid === 7)
                ?.content,
        ).toBe('@@system\n自动批准写入成功');

        // 2. st_settings_patch MUST suspend with mandatoryConfirm: true
        const msg2 = await runner.sendPrompt(session.id, '关闭 fast_ui_mode');
        expect(msg2.approvalIds).toHaveLength(1);
        const settingsAppr = runner.getApproval(msg2.approvalIds![0])!;
        expect(settingsAppr.status).toBe('pending');
        expect(settingsAppr.mandatoryConfirm).toBe(true);
        expect(settingsAppr.riskLevel).toBe('high');
        expect(bridge.hostSettings.power_user.fast_ui_mode).toBe(true);

        // 3. wi_delete_primary_entry MUST suspend with mandatoryConfirm: true
        const msg3 = await runner.sendPrompt(session.id, '删除 #7');
        expect(msg3.approvalIds).toHaveLength(1);
        const deleteAppr = runner.getApproval(msg3.approvalIds![0])!;
        expect(deleteAppr.status).toBe('pending');
        expect(deleteAppr.mandatoryConfirm).toBe(true);
        expect(deleteAppr.riskLevel).toBe('high');
        expect(
            (await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries.some((e) => e.uid === 7),
        ).toBe(true);
    });

    it('propagates hasSecretRedaction on read tool calls inside AssistantRunner', async () => {
        const { runner } = createRunnerHarness([
            {
                toolCalls: [
                    {
                        id: 'call_read_settings',
                        name: 'st_settings_read',
                        arguments: JSON.stringify({ scope: 'power_user' }),
                    },
                ],
            },
            {
                content: '已读取酒馆设置，敏感凭据已自动脱敏。',
            },
        ]);

        const session = await runner.createSession({
            title: '脱敏传播验证',
            mode: 'full',
            stAdminEnabled: true,
        });

        const msg = await runner.sendPrompt(session.id, '看看 power_user 设置');
        expect(msg.toolCalls).toHaveLength(1);
        expect(msg.toolCalls![0].hasSecretRedaction).toBe(true);
        expect(msg.toolCalls![0].resultSummary).toContain(REDACTED_PLACEHOLDER);
        expect(msg.toolCalls![0].resultSummary).not.toContain('sk-test-power-user-secret');
    });

    it('supports abort() mid-stream cleanly without corrupting TrajectoryStore', async () => {
        const { trajectoryStore, runner } = createRunnerHarness([
            {
                content: '这是一段很长的流式响应内容，用于测试中断。',
                chunkSize: 4,
                delayMs: 30,
            },
        ]);

        const session = await runner.createSession({ title: '中断测试', mode: 'chat' });

        const promise = runner.sendPrompt(session.id, '请长篇大论分析');
        // Abort immediately while delayed stream is in flight
        runner.abort(session.id);

        const result = await promise;
        expect(result.interrupted).toBe(true);
        // Interrupted turn must NOT commit half-baked messages into TrajectoryStore
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(0);
    });

    it('persists sessions to HostBridge metadata and compacts long assistant trajectories without polluting mainline /history/*', async () => {
        const bridge = createOffMainlineTestBridge();
        const trajectoryStore = new TrajectoryStore();

        const store1 = new AssistantSessionStore({
            bridge,
            trajectoryStore,
            persistenceMode: 'metadata',
            watermark: { high: 120, low: 60 },
        });

        const s = store1.createSession({ title: '持久会话测试', mode: 'chat' });
        store1.appendMessage(s.id, {
            id: 'm1',
            role: 'user',
            content: '第一轮问题',
            timestamp: 1000,
        });

        // Reload in a fresh AssistantSessionStore over the same HostBridge metadata
        const store2 = new AssistantSessionStore({
            bridge,
            trajectoryStore,
            persistenceMode: 'metadata',
        });
        expect(store2.listSessions()).toHaveLength(1);
        expect(store2.getSession(s.id)?.messages).toHaveLength(1);

        // Append several turns to trigger watermark compaction
        store1.ensureFrozenPrefix(s.id, 'STATIC_SYSTEM_PROMPT', []);
        for (let i = 0; i < 6; i += 1) {
            store1.appendTrajectoryTurn(s.id, [
                { role: 'user', content: `第 ${i + 1} 轮详细问题：${'雾港线索详情'.repeat(12)}` },
                { role: 'assistant', content: `第 ${i + 1} 轮分析回复：${'调查结论记录'.repeat(12)}` },
            ]);
        }

        const compaction = store1.compactIfNeeded(s.id);
        expect(compaction.compacted).toBe(true);
        expect(compaction.archivedTurnCount).toBeGreaterThanOrEqual(1);
        expect(compaction.estimatedTokensAfter).toBeLessThan(compaction.estimatedTokensBefore);

        const compactedMsgs = trajectoryStore.getMessages(toAssistantThreadId(s.id));
        expect(compactedMsgs[0].role).toBe('system');
        expect(String(compactedMsgs[0].content)).toContain('<assistant-history-summary>');
    });

    it('supports editMessage, editAndResendMessage, retractMessage, and regenerateLastMessage with KV-cache prefix preservation', async () => {
        const { bridge, transport, trajectoryStore, runner } = createRunnerHarness([
            // Turn 1: adjust mode executes chat_edit_message (captures UndoRecord) then finishes
            {
                toolCalls: [
                    {
                        id: 'call_edit_chat_1',
                        name: 'chat_edit_message',
                        arguments: JSON.stringify({
                            target: { messageId: 1, swipeId: 0 },
                            newText: '雾港夜雨初停，林晚站在灯塔下。',
                        }),
                    },
                ],
            },
            {
                content: '已帮你微调第 1 楼文本。',
            },
            // Turn 2: proposes wi_upsert_primary_entry (suspends for approval)
            {
                content: '我准备更新主世界书条目 #7，请确认。',
                toolCalls: [
                    {
                        id: 'call_wi_pending_1',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            keys: ['规则'],
                            content: '@@system\n草案内容',
                        }),
                    },
                ],
            },
            // Turn 3 (after editAndResendMessage on Turn 2 user prompt): plain reply
            {
                content: '已按改写后的要求重新分析：主线暂不改世界书。',
            },
            // Turn 4 (after regenerateLastMessage on Turn 2 assistant reply): plain reply
            {
                content: '重新生成版：建议先保留当前世界书规则。',
            },
            // Turn 5 (after retracting Turn 2 assistant reply, regenerating from trailing user msg)
            {
                content: '仅剩用户消息时重新生成的新回复。',
            },
            // Turn 6 (after editMessage on Turn 1 assistant & Turn 2 prompt, follow-up prompt)
            {
                content: '收到，继续后续步骤。',
            },
        ]);

        const session = await runner.createSession({
            title: '改写撤回与重生成测试',
            mode: 'author',
            autoApproveAuthor: false,
        });

        // 1. Execute Turn 1 (captures UndoRecord #1, preserves tool_calls -> tool in TrajectoryStore)
        const reply1 = await runner.sendPrompt(session.id, '帮我润色第 1 楼对话');
        expect(reply1.content).toBe('已帮你微调第 1 楼文本。');
        expect(runner.listUndoRecords(session.id)).toHaveLength(1);

        const threadId = toAssistantThreadId(session.id);
        const layer1AfterTurn1 = trajectoryStore.getMessages(threadId);
        // [user, assistant(toolCalls), tool, assistant]
        expect(layer1AfterTurn1).toHaveLength(4);
        const frozenTurn1PrefixJson = canonicalStringify(layer1AfterTurn1);

        // 2. Execute Turn 2 (creates suspended PendingApproval)
        const reply2 = await runner.sendPrompt(session.id, '顺便修改主世界书 #7');
        expect(reply2.approvalIds).toHaveLength(1);
        expect(runner.listApprovals(session.id)).toHaveLength(1);

        const userMsg2 = runner.getSession(session.id)!.messages[2];
        expect(userMsg2.role).toBe('user');

        // 3. editAndResendMessage on Turn 2 user message:
        //    - clears Turn 2's PendingApproval
        //    - preserves Turn 1's UndoRecord & exact tool-call trajectory prefix
        //    - generates Turn 3 response
        const resentReply = await runner.editAndResendMessage(
            session.id,
            userMsg2.id,
            '改写指令：先只做分析，不要动世界书',
        );
        expect(resentReply.content).toBe('已按改写后的要求重新分析：主线暂不改世界书。');
        expect(runner.listApprovals(session.id)).toHaveLength(0);
        expect(runner.listUndoRecords(session.id)).toHaveLength(1);
        expect((await bridge.author!.readWorldInfoBook('雾港侦探录'))!.entries[0].content).toContain(
            '保持冷硬派侦探叙事口吻',
        );

        const sessionAfterResend = runner.getSession(session.id)!;
        expect(sessionAfterResend.messages).toHaveLength(4);
        expect(sessionAfterResend.messages[2].content).toBe('改写指令：先只做分析，不要动世界书');
        expect(sessionAfterResend.messages[3].content).toBe('已按改写后的要求重新分析：主线暂不改世界书。');

        // Verify Turn 1 prefix in request #4 remained byte-for-byte identical (KV cache invariance)
        const resendReq = transport.requests[3];
        expect(canonicalStringify(resendReq.messages.slice(1, 5))).toBe(frozenTurn1PrefixJson);

        // 4. regenerateLastMessage when last message is assistant:
        const regenReply1 = await runner.regenerateLastMessage(session.id);
        expect(regenReply1.content).toBe('重新生成版：建议先保留当前世界书规则。');
        const sessionAfterRegen1 = runner.getSession(session.id)!;
        expect(sessionAfterRegen1.messages).toHaveLength(4);
        expect(sessionAfterRegen1.messages[2].content).toBe('改写指令：先只做分析，不要动世界书');
        expect(sessionAfterRegen1.messages[3].content).toBe('重新生成版：建议先保留当前世界书规则。');

        const regenReq1 = transport.requests[4];
        expect(canonicalStringify(regenReq1.messages.slice(1, 5))).toBe(frozenTurn1PrefixJson);

        // 5. retractMessage on the last assistant message, then regenerateLastMessage from trailing user message:
        const retractedAssistant = await runner.retractMessage(
            session.id,
            sessionAfterRegen1.messages[3].id,
        );
        expect(retractedAssistant?.removedMessages).toHaveLength(1);
        expect(runner.getSession(session.id)!.messages).toHaveLength(3);

        const regenReply2 = await runner.regenerateLastMessage(session.id);
        expect(regenReply2.content).toBe('仅剩用户消息时重新生成的新回复。');
        expect(runner.getSession(session.id)!.messages).toHaveLength(4);

        // 6. editMessage in place preserves Turn 1 tool-call chain while updating edited content:
        const editedSession = await runner.editMessage(
            session.id,
            reply1.id,
            '已润色第 1 楼文本（手工改写版）。',
        );
        expect(editedSession?.messages[1].content).toBe('已润色第 1 楼文本（手工改写版）。');

        await runner.sendPrompt(session.id, '好的，继续');
        const postEditReq = transport.requests[6];
        // Layer 1 still contains the tool-call chain from Turn 1 with updated final assistant text
        expect(postEditReq.messages.some((m) => m.role === 'tool')).toBe(true);
        expect(
            postEditReq.messages.some(
                (m) => m.role === 'assistant' && m.content === '已润色第 1 楼文本（手工改写版）。',
            ),
        ).toBe(true);

        // 7. retractMessage from Turn 2 user message drops Turn 2 and Turn 3 cleanly:
        const retractedTurn2 = await runner.retractMessage(session.id, userMsg2.id);
        expect(retractedTurn2?.removedMessages).toHaveLength(4);
        expect(runner.getSession(session.id)!.messages).toHaveLength(2);

        // 8. regenerateLastMessage on an empty session throws cleanly:
        const emptySession = await runner.createSession({ title: '空会话', mode: 'chat' });
        await expect(runner.regenerateLastMessage(emptySession.id)).rejects.toThrow(
            'No user message available to regenerate.',
        );
    });

    it('sends multimodal image/audio/video/file attachments and preserves them across edit, resend, and regenerate', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness([
            { content: '已查看图片、听取音频并检查视频和文本附件。' },
            { content: '仅附件（无正文）的回复。' },
            { content: '改写重发后仍保留多模态附件的回复。' },
            { content: '重新生成后仍保留多模态附件的回复。' },
        ]);

        const session = await runner.createSession({ title: '多模态附件测试', mode: 'chat' });
        const attachments = [
            {
                id: 'att_img_1',
                kind: 'image' as const,
                name: 'scene.png',
                mimeType: 'image/png',
                size: 128,
                dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            },
            {
                id: 'att_aud_1',
                kind: 'audio' as const,
                name: 'voice.wav',
                mimeType: 'audio/wav',
                size: 256,
                dataUrl: 'data:audio/wav;base64,UklGRg==',
            },
            {
                id: 'att_vid_1',
                kind: 'video' as const,
                name: 'clip.mp4',
                mimeType: 'video/mp4',
                size: 512,
                dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXA=',
            },
            {
                id: 'att_txt_1',
                kind: 'file' as const,
                name: 'notes.md',
                mimeType: 'text/markdown',
                size: 32,
                dataUrl: 'data:text/markdown;base64,IyBOb3Rlcw==',
                textContent: '# Notes\nClue A',
            },
        ];

        // 1. Send prompt with multimodal attachments
        const reply1 = await runner.sendPrompt(session.id, '请分析以上四个附件', { attachments });
        expect(reply1.content).toBe('已查看图片、听取音频并检查视频和文本附件。');

        const req1UserMsg = transport.requests[0].messages[1];
        expect(Array.isArray(req1UserMsg.content)).toBe(true);
        expect(req1UserMsg.content).toEqual([
            { type: 'text', text: '请分析以上四个附件' },
            { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
            {
                type: 'input_audio',
                data: 'UklGRg==',
                format: 'wav',
                mimeType: 'audio/wav',
                filename: 'voice.wav',
            },
            {
                type: 'video_url',
                videoUrl: 'data:video/mp4;base64,AAAAIGZ0eXA=',
                mimeType: 'video/mp4',
                filename: 'clip.mp4',
            },
            { type: 'text', text: '[Attachment: notes.md]\n# Notes\nClue A' },
        ]);

        const turn1FrozenJson = canonicalStringify(
            trajectoryStore.getMessages(toAssistantThreadId(session.id)),
        );

        // 2. Send attachment-only message (empty text)
        const reply2 = await runner.sendPrompt(session.id, '', {
            attachments: [attachments[0]],
        });
        expect(reply2.content).toBe('仅附件（无正文）的回复。');
        expect(transport.requests[1].messages[3].content).toEqual([
            { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        ]);

        const turn2UserId = runner.getSession(session.id)!.messages[2].id;

        // 3. editAndResendMessage preserves Turn 1 multimodal KV prefix verbatim & retains Turn 2 attachment
        const resent = await runner.editAndResendMessage(
            session.id,
            turn2UserId,
            '补充说明：请重点看构图',
        );
        expect(resent.content).toBe('改写重发后仍保留多模态附件的回复。');
        expect(canonicalStringify(transport.requests[2].messages.slice(1, 3))).toBe(turn1FrozenJson);
        expect(transport.requests[2].messages[3].content).toEqual([
            { type: 'text', text: '补充说明：请重点看构图' },
            { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        ]);

        // 4. regenerateLastMessage retains Turn 2 attachment & Turn 1 KV prefix
        const regen = await runner.regenerateLastMessage(session.id);
        expect(regen.content).toBe('重新生成后仍保留多模态附件的回复。');
        expect(canonicalStringify(transport.requests[3].messages.slice(1, 3))).toBe(turn1FrozenJson);
        expect(transport.requests[3].messages[3].content).toEqual([
            { type: 'text', text: '补充说明：请重点看构图' },
            { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
        ]);
    });
});
