import { describe, expect, it } from 'vitest';
import {
    AssistantRunner,
    type AssistantRetryOptions,
    AssistantSessionStore,
    REDACTED_PLACEHOLDER,
    toAssistantThreadId,
} from '@/core/assistant';
import { createDefaultConnection, createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { LLMTransportError, PayloadCompiler } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import type { AssistantRetryStatus } from '@/core/types';
import { AppStore, type AssistantRuntimeBridge } from '@/ui/store/app-store';
import { canonicalStringify } from '@/core/utils';
import {
    SAMPLE_RAW_AUTHOR_WI_ENTRY,
    createOffMainlineTestBridge,
} from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

function createRunnerHarness(
    turns: ScriptedTurnInput[] = [],
    extra?: {
        stream?: boolean;
        maxToolRounds?: number;
        autoRetry?: AssistantRetryOptions | false;
    },
) {
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
        ...(extra?.maxToolRounds !== undefined ? { maxToolRounds: extra.maxToolRounds } : {}),
        ...(extra?.autoRetry !== undefined ? { autoRetry: extra.autoRetry } : {}),
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

    it('supports chat_create_message and chat_delete_message in adjust mode with autoApproveChatDelete toggle, inline confirmation, and full undo', async () => {
        const { bridge, runner } = createRunnerHarness([
            // Turn 1: adjust mode directly executes chat_create_message
            {
                toolCalls: [
                    {
                        id: 'call_create_1',
                        name: 'chat_create_message',
                        arguments: JSON.stringify({
                            role: 'assistant',
                            content: '新插入的码头线索消息',
                        }),
                    },
                ],
            },
            {
                content: '已在对话末尾创建新消息 #2。',
            },
            // Turn 2: autoApproveChatDelete=false -> chat_delete_message suspends for inline bubble confirmation
            {
                content: '我将删除第 1 楼消息，请先确认。',
                toolCalls: [
                    {
                        id: 'call_delete_pending',
                        name: 'chat_delete_message',
                        arguments: JSON.stringify({
                            messageId: 1,
                        }),
                    },
                ],
            },
            // Turn 3: after toggling autoApproveChatDelete=true -> chat_delete_message executes directly
            {
                toolCalls: [
                    {
                        id: 'call_delete_auto',
                        name: 'chat_delete_message',
                        arguments: JSON.stringify({
                            messageId: 1,
                        }),
                    },
                ],
            },
            {
                content: '已自动批准并删除消息 #1。',
            },
        ]);

        const session = await runner.createSession({
            title: '调整模式增删消息测试',
            mode: 'adjust',
            autoApproveChatDelete: false,
        });

        // 1. chat_create_message executes directly in adjust mode
        const createBubble = await runner.sendPrompt(session.id, '帮我在末尾加一条回复');
        expect(createBubble.approvalIds).toBeUndefined();
        expect(bridge.chat).toHaveLength(3);
        expect(bridge.chat[2].mes).toBe('新插入的码头线索消息');
        const createUndoId = createBubble.toolCalls![0].undoId!;
        expect(createUndoId).toBeTruthy();

        // Undo removes newly created message, then re-create for deletion test
        await runner.undo(createUndoId);
        expect(bridge.chat).toHaveLength(2);

        // 2. chat_delete_message suspends when autoApproveChatDelete === false
        const beforeDeleteContent = bridge.chat[1].mes;
        const deleteBubble = await runner.sendPrompt(session.id, '帮我删掉第 1 条消息');
        expect(deleteBubble.approvalIds).toHaveLength(1);
        const approvalId = deleteBubble.approvalIds![0];
        const pending = runner.getApproval(approvalId)!;
        expect(pending.status).toBe('pending');
        expect(pending.mandatoryConfirm).toBe(false);
        expect(pending.riskLevel).toBe('medium');
        expect(pending.diffLines.some((l) => l.type === 'del')).toBe(true);
        // Message MUST NOT be deleted before approval
        expect(bridge.chat).toHaveLength(2);

        // Approve -> deletes message and attaches undoId
        const approved = await runner.decideApproval(approvalId, 'approve');
        expect(approved?.status).toBe('approved');
        expect(approved?.undoId).toBeDefined();
        expect(bridge.chat).toHaveLength(1);

        // Undo restores deleted message
        await runner.undo(approved!.undoId!);
        expect(bridge.chat).toHaveLength(2);
        expect(bridge.chat[1].mes).toBe(beforeDeleteContent);

        // 3. Toggle autoApproveChatDelete ON -> deletes directly without approval card
        await runner.updateSessionConfig(session.id, { autoApproveChatDelete: true });
        const autoDeleteBubble = await runner.sendPrompt(session.id, '直接删除第 1 条消息');
        expect(autoDeleteBubble.approvalIds).toBeUndefined();
        expect(autoDeleteBubble.toolCalls![0].status).toBe('ok');
        expect(bridge.chat).toHaveLength(1);

        const autoUndoId = autoDeleteBubble.toolCalls![0].undoId!;
        await runner.undo(autoUndoId);
        expect(bridge.chat).toHaveLength(2);
        expect(bridge.chat[1].mes).toBe(beforeDeleteContent);
    });

    it('auto-retries mid-stream network errors and empty responses with clean buffer rollback', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness(
            [
                // Attempt 1: mid-stream drop after emitting partial text chunk
                {
                    content: '半截失败输出',
                    chunkSize: 6,
                    error: new LLMTransportError('SSE connection dropped', { retryable: true }),
                    errorAfterChunks: 1,
                },
                // Attempt 2: silent empty response (no toolCalls, empty content)
                {
                    content: '',
                },
                // Attempt 3: clean complete reply
                {
                    content: '最终完整答复内容。',
                    usage: { inputTokens: 200, cachedTokens: 100, outputTokens: 25 },
                },
            ],
            {
                stream: true,
                autoRetry: { maxRetries: 2, initialDelayMs: 5, maxDelayMs: 20, backoffFactor: 2 },
            },
        );

        const session = await runner.createSession({ title: '自动重试测试', mode: 'chat' });
        const retryStatuses: AssistantRetryStatus[] = [];
        const observedLiveRetryStates: Array<AssistantRetryStatus | undefined> = [];

        const reply = await runner.sendPrompt(session.id, '帮我分析当前状态', {
            onRetry: (status) => retryStatuses.push(status),
            onUpdate: (updated) => {
                const last = updated.messages[updated.messages.length - 1];
                if (last?.role === 'assistant' && last.retryStatus) {
                    observedLiveRetryStates.push(last.retryStatus);
                }
            },
        });

        expect(transport.requests).toHaveLength(3);
        expect(retryStatuses).toHaveLength(2);
        expect(retryStatuses[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
        expect(retryStatuses[1]).toMatchObject({ attempt: 2, maxAttempts: 2 });
        expect(observedLiveRetryStates.length).toBeGreaterThanOrEqual(2);

        // Partial text from Attempt 1 must have been rolled back cleanly without duplication
        expect(reply.content).toBe('最终完整答复内容。');
        expect(reply.content).not.toContain('半截失败输出');
        expect(reply.retryStatus).toBeUndefined();
        expect(reply.interrupted).toBeUndefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(2);
    });

    it('aborts immediately during auto-retry backoff and saves a resumable user_stop checkpoint', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness(
            [
                {
                    error: new LLMTransportError('Upstream gateway timeout', {
                        status: 504,
                        retryable: true,
                    }),
                },
                { content: 'SHOULD_NOT_BE_REACHED' },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 3, initialDelayMs: 10_000, maxDelayMs: 10_000 },
            },
        );

        const session = await runner.createSession({ title: '退避中断测试', mode: 'chat' });
        const startedAt = Date.now();
        const result = await runner.sendPrompt(session.id, '触发重试并立即中止', {
            onRetry: () => {
                setTimeout(() => runner.abort(session.id), 10);
            },
        });
        const elapsed = Date.now() - startedAt;

        expect(elapsed).toBeLessThan(1000);
        expect(transport.requests).toHaveLength(1);
        expect(result.interrupted).toBe(true);
        expect(result.errorCode).toBe('user_stop');
        expect(result.canContinue).toBe(true);
        expect(result.retryStatus).toBeUndefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(0);
        expect(runner.sessionStore.getInterruptedCheckpoint(session.id)).toMatchObject({
            messageId: result.id,
            reason: 'user_stop',
        });
    });

    it('preserves completed tool rounds in checkpoint on exhausted retries and resumes via continueLastMessage()', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness(
            [
                // Round 1: calls list_dir (succeeds)
                {
                    toolCalls: [
                        {
                            id: 'call_list_1',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
                // Round 2: exhausts initial attempt + 1 autoRetry with network failure
                {
                    content: '开始汇总：',
                    chunkSize: 5,
                    error: new Error('network error mid-summary'),
                    errorAfterChunks: 1,
                },
                {
                    error: new LLMTransportError('Bad gateway', { status: 502, retryable: true }),
                },
                // Resumed Round via continueLastMessage(): receives tool history without re-running list_dir
                {
                    content: '已完成目录盘点。',
                },
            ],
            {
                stream: true,
                autoRetry: { maxRetries: 1, initialDelayMs: 5, maxDelayMs: 10 },
            },
        );

        const session = await runner.createSession({ title: '断线续传测试', mode: 'chat' });
        await expect(runner.sendPrompt(session.id, '列出根目录文件并总结')).rejects.toThrow(
            /Bad gateway/,
        );

        // Must NOT commit half-baked turn into TrajectoryStore while interrupted
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(0);

        const afterErrorSession = runner.getSession(session.id)!;
        const failedBubble = afterErrorSession.messages[afterErrorSession.messages.length - 1];
        expect(failedBubble.role).toBe('assistant');
        expect(failedBubble.interrupted).toBe(true);
        expect(failedBubble.errorCode).toBe('network');
        expect(failedBubble.canContinue).toBe(true);
        expect(failedBubble.toolCalls).toHaveLength(1);
        expect(failedBubble.toolCalls![0].name).toBe('list_dir');
        expect(afterErrorSession.interruptedCheckpoint).toBeDefined();
        expect(afterErrorSession.interruptedCheckpoint!.messageId).toBe(failedBubble.id);
        expect(afterErrorSession.interruptedCheckpoint!.inFlightMessages.some((m) => m.role === 'tool')).toBe(
            true,
        );

        const continued = await runner.continueLastMessage(session.id);

        // Resumed request contains completed assistant(toolCalls) + tool result without repeating list_dir
        expect(transport.requests).toHaveLength(4);
        const resumedMsgs = transport.requests[3].messages;
        expect(resumedMsgs.some((m) => m.role === 'tool' && m.toolCallId === 'call_list_1')).toBe(true);

        // Same assistant bubble updated in place, [Error] banner cleared, toolCalls kept intact
        const finalSession = runner.getSession(session.id)!;
        expect(finalSession.messages).toHaveLength(2);
        expect(continued.id).toBe(failedBubble.id);
        expect(continued.content).toBe('已完成目录盘点。');
        expect(continued.content).not.toContain('[Error]');
        expect(continued.interrupted).toBeUndefined();
        expect(continued.canContinue).toBeUndefined();
        expect(continued.toolCalls).toHaveLength(1);
        expect(finalSession.interruptedCheckpoint).toBeUndefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBeGreaterThanOrEqual(4);
    });

    it('marks max_tool_rounds interruption with checkpoint and continues cleanly via continueLastMessage()', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness(
            [
                // Round 1 (reaches maxToolRounds=1)
                {
                    toolCalls: [
                        {
                            id: 'call_list_cap',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/character' }),
                        },
                    ],
                },
                // Resumed Round after clicking Continue
                {
                    content: '继续执行后已完成角色目录分析。',
                },
            ],
            {
                stream: false,
                maxToolRounds: 1,
                autoRetry: false,
            },
        );

        const session = await runner.createSession({ title: '轮次上限续跑', mode: 'chat' });
        const capped = await runner.sendPrompt(session.id, '检查角色卡目录');

        expect(capped.interrupted).toBe(true);
        expect(capped.errorCode).toBe('max_tool_rounds');
        expect(capped.canContinue).toBe(true);
        expect(capped.toolCalls).toHaveLength(1);
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(0);
        expect(runner.sessionStore.getInterruptedCheckpoint(session.id)?.reason).toBe('max_tool_rounds');

        const finished = await runner.continueLastMessage(session.id);
        expect(transport.requests).toHaveLength(2);
        expect(finished.id).toBe(capped.id);
        expect(finished.interrupted).toBeUndefined();
        expect(finished.content).toBe('继续执行后已完成角色目录分析。');
        expect(runner.sessionStore.getInterruptedCheckpoint(session.id)).toBeNull();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBeGreaterThanOrEqual(4);
    });

    it('allows unlimited tool rounds by default (>20 rounds) without max_tool_rounds interruption', async () => {
        const turns: ScriptedTurnInput[] = [];
        for (let i = 0; i < 25; i += 1) {
            turns.push({
                toolCalls: [
                    {
                        id: `call_unlim_${i}`,
                        name: 'list_dir',
                        arguments: JSON.stringify({ path: '/character' }),
                    },
                ],
            });
        }
        turns.push({
            content: '25 轮工具调用全部完成后已正常汇总。',
        });

        const { transport, runner } = createRunnerHarness(turns, {
            stream: false,
            autoRetry: false,
        });

        const session = await runner.createSession({ title: '默认无限轮次', mode: 'chat' });
        const finished = await runner.sendPrompt(session.id, '执行多轮复杂检索');

        expect(transport.requests).toHaveLength(26);
        expect(finished.interrupted).toBeUndefined();
        expect(finished.errorCode).toBeUndefined();
        expect(finished.toolCalls).toHaveLength(25);
        expect(finished.content).toBe('25 轮工具调用全部完成后已正常汇总。');
    });

    it('handles finishReason=length truncation across consecutive continuations and protects truncated tool JSON', async () => {
        // 1. Consecutive text length truncations without duplicating already-output segments
        const { transport: textTransport, trajectoryStore: textTrajectory, runner: textRunner } =
            createRunnerHarness(
                [
                    { content: '第一段', finishReason: 'length' },
                    { content: '第二段', finishReason: 'MAX_TOKENS' },
                    { content: '第三段', finishReason: 'stop' },
                ],
                { stream: true, autoRetry: false },
            );

        const s1 = await textRunner.createSession({ title: '长度截断连续续写', mode: 'chat' });
        const r1 = await textRunner.sendPrompt(s1.id, '写三段故事');
        expect(r1.interrupted).toBe(true);
        expect(r1.errorCode).toBe('length');
        expect(r1.canContinue).toBe(true);
        expect(r1.content).toBe('第一段');
        expect(textTrajectory.getMessageCount(toAssistantThreadId(s1.id))).toBe(0);

        const r2 = await textRunner.continueLastMessage(s1.id);
        expect(r2.id).toBe(r1.id);
        expect(r2.interrupted).toBe(true);
        expect(r2.errorCode).toBe('length');
        expect(r2.content).toBe('第一段第二段');

        const r3 = await textRunner.continueLastMessage(s1.id);
        expect(r3.id).toBe(r1.id);
        expect(r3.interrupted).toBeUndefined();
        expect(r3.content).toBe('第一段第二段第三段');

        const committed = textTrajectory.getMessages(toAssistantThreadId(s1.id));
        const assistantTexts = committed
            .filter((m) => m.role === 'assistant')
            .map((m) => String(m.content));
        expect(assistantTexts).toEqual(['第一段', '第二段', '第三段']);
        expect(textTransport.requests).toHaveLength(3);

        // 2. Truncated tool JSON on finishReason=length must NOT execute partial tool call
        const { runner: toolRunner } = createRunnerHarness(
            [
                {
                    toolCalls: [
                        {
                            id: 'call_trunc_1',
                            name: 'read_file',
                            arguments: '{"path":"/character/desc',
                        },
                    ],
                    finishReason: 'length',
                },
                {
                    content: '已重新输出并完成答复。',
                    finishReason: 'stop',
                },
            ],
            { stream: false, autoRetry: false },
        );

        const s2 = await toolRunner.createSession({ title: '截断工具参数保护', mode: 'chat' });
        const t1 = await toolRunner.sendPrompt(s2.id, '读取角色描述');
        expect(t1.interrupted).toBe(true);
        expect(t1.errorCode).toBe('length');
        expect(t1.canContinue).toBe(true);
        expect(t1.toolCalls).toBeUndefined();

        const t2 = await toolRunner.continueLastMessage(s2.id);
        expect(t2.interrupted).toBeUndefined();
        expect(t2.content).toBe('已重新输出并完成答复。');
    });

    it('supports legacy continueLastMessage() fallback when trailing bubble has toolCalls and empty content without checkpoint', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness(
            [
                {
                    content: '根据已读取的设定文件，角色档案已整理完毕。',
                },
            ],
            { stream: false, autoRetry: false },
        );

        const session = await runner.createSession({ title: '旧版空回复兜底续写', mode: 'chat' });
        runner.sessionStore.appendMessage(session.id, {
            id: 'legacy_u_1',
            role: 'user',
            content: '读取描述并整理重点',
            timestamp: 1000,
        });
        runner.sessionStore.appendMessage(session.id, {
            id: 'legacy_a_1',
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 'legacy_tc_1',
                    name: 'read_file',
                    scopeLabel: 'VFS: /character/description.md',
                    status: 'ok',
                    durationMs: 2,
                    argsSummary: '{"path":"/character/description.md"}',
                    resultSummary: '主角是一名驻守雾港的调查员。',
                },
            ],
            timestamp: 1001,
        });

        const continued = await runner.continueLastMessage(session.id);
        expect(continued.id).toBe('legacy_a_1');
        expect(continued.content).toBe('根据已读取的设定文件，角色档案已整理完毕。');
        expect(continued.toolCalls).toHaveLength(1);
        expect(runner.getSession(session.id)!.messages).toHaveLength(2);
        expect(transport.requests).toHaveLength(1);
        const sentText = transport.requests[0].messages
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        expect(sentText).toContain('read_file');
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBeGreaterThanOrEqual(2);
    });

    it('readPreviewFile() reads lorebook/workspace VFS files and /tmp/tool-spill/* entries with secret redaction', async () => {
        const { bridge, runner } = createRunnerHarness();
        bridge.setLorebook('雾港侦探录', [
            SAMPLE_RAW_AUTHOR_WI_ENTRY,
            {
                world: '雾港侦探录',
                uid: 111,
                comment: '插画插入',
                content: '## 插画插入规则\n在章节高潮处输出插画标记。',
                keys: ['插画'],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 100,
                role: 0,
            },
        ]);

        // 1. Read mounted /lorebooks/<book>/<entry>.md
        const loreEntries = await runner.vfs.listDir('/lorebooks/雾港侦探录');
        expect(loreEntries.length).toBeGreaterThan(0);
        const lorePath = loreEntries[0].path;
        const lorePreview = await runner.readPreviewFile(lorePath);
        expect(lorePreview).not.toBeNull();
        expect(lorePreview).toContain('在章节高潮处输出插画标记。');

        // 2. Read committed VFS workspace file with automatic secret redaction
        await runner.vfs.writeFile(
            '/memory/preview-secret.md',
            'endpoint: https://example.test\napiKey: sk-proj-secret-1234567890abcdef',
            { staged: false },
        );
        const secretPreview = await runner.readPreviewFile('/memory/preview-secret.md');
        expect(secretPreview).not.toBeNull();
        expect(secretPreview).toContain('endpoint: https://example.test');
        expect(secretPreview).toContain(REDACTED_PLACEHOLDER);
        expect(secretPreview).not.toContain('sk-proj-secret-1234567890abcdef');

        // 3. Read transient /tmp/tool-spill/* output with automatic secret redaction
        const spill = runner.spillStore.put({
            toolCallId: 'call_preview_spill_1',
            toolName: 'read_file',
            content: 'spilled line 1\nAuthorization: Bearer raw-spill-token-xyz\nspilled line 3',
        });
        const spillPreview = await runner.readPreviewFile(spill.path);
        expect(spillPreview).not.toBeNull();
        expect(spillPreview).toContain('spilled line 1');
        expect(spillPreview).toContain(REDACTED_PLACEHOLDER);
        expect(spillPreview).not.toContain('raw-spill-token-xyz');

        // 4. Missing VFS or spill path returns null
        expect(await runner.readPreviewFile('/lorebooks/不存在/missing-999.md')).toBeNull();
        expect(await runner.readPreviewFile('/tmp/tool-spill/nonexistent.txt')).toBeNull();
    });

    it('records AssistantMessage.fileRefs only for successful write tools (excluding read-only and failed writes)', async () => {
        const { runner } = createRunnerHarness(
            [
                // Turn 1 (read-only tools only): read_file + read_variables -> final text
                {
                    toolCalls: [
                        {
                            id: 'call_ro_1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/character/description.md' }),
                        },
                        {
                            id: 'call_ro_2',
                            name: 'read_variables',
                            arguments: JSON.stringify({}),
                        },
                    ],
                },
                {
                    content: '已只读核对角色描述与变量。',
                },
                // Turn 2 (adjust mode): read_file + failing edit_file + write_file + patch_variables -> final text
                {
                    toolCalls: [
                        {
                            id: 'call_mix_read',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/character/description.md' }),
                        },
                        {
                            id: 'call_mix_fail_edit',
                            name: 'edit_file',
                            arguments: JSON.stringify({
                                path: '/workspace/missing.md',
                                search: '不存在的片段',
                                replace: '新内容',
                            }),
                        },
                        {
                            id: 'call_mix_write',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/workspace/written-note.md',
                                content: '# 写入笔记\n已持久化到工作区。',
                            }),
                        },
                        {
                            id: 'call_mix_patch_vars',
                            name: 'patch_variables',
                            arguments: JSON.stringify({
                                json_merge: { heat: 3 },
                            }),
                        },
                    ],
                },
                {
                    content: '已写入工作区笔记并更新分支变量。',
                },
            ],
            { stream: false },
        );

        const chatSession = await runner.createSession({ title: '只读不展示fileRefs', mode: 'chat' });
        const readOnlyReply = await runner.sendPrompt(chatSession.id, '帮我看看角色描述和变量');
        expect(readOnlyReply.content).toBe('已只读核对角色描述与变量。');
        expect(readOnlyReply.fileRefs).toBeUndefined();

        const adjustSession = await runner.createSession({ title: '仅写入展示fileRefs', mode: 'adjust' });
        const mixedReply = await runner.sendPrompt(adjustSession.id, '核对描述后写入笔记并更新变量');
        expect(mixedReply.content).toBe('已写入工作区笔记并更新分支变量。');
        expect(mixedReply.fileRefs).toEqual([
            '/workspace/written-note.md',
            '/state/variables.json',
        ]);
    });

    it('exposes optional extension tools and prompt hints only when detected as active', async () => {
        const { bridge, transport, runner } = createRunnerHarness(
            [
                { content: '未安装第三方扩展时的回复。' },
                { content: '已检测到第三方扩展时的回复。' },
            ],
            { stream: false },
        );

        // 1. When TavernHelper & EjsTemplate are absent:
        bridge.extensionCapabilities = {
            tavernHelperScripts: false,
            tavernHelperAudio: false,
            ejsTemplate: false,
        };
        const withoutExtTools = runner.getAllowedToolDefinitions('full', true).map((t) => t.name);
        expect(withoutExtTools).not.toContain('tavern_helper_scripts_read');
        expect(withoutExtTools).not.toContain('tavern_helper_scripts_upsert');
        expect(withoutExtTools).toContain('st_sync_runtime');

        const sWithout = await runner.createSession({
            title: '无第三方扩展',
            mode: 'full',
            stAdminEnabled: true,
        });
        await runner.sendPrompt(sWithout.id, '检查可用工具');
        const reqWithout = transport.requests[0]!;
        const sysWithout = String(reqWithout.messages[0]?.content ?? '');
        expect(sysWithout).not.toContain('JS-Slash-Runner');
        expect(sysWithout).not.toContain('TavernHelper');
        expect(sysWithout).not.toContain('EjsTemplate');
        const syncToolWithout = reqWithout.tools?.find((t) => t.name === 'st_sync_runtime');
        const targetsEnumWithout = (
            ((syncToolWithout?.parameters?.properties as Record<string, Record<string, unknown>>)?.targets
                ?.items as Record<string, unknown>)?.enum as string[] | undefined
        ) ?? [];
        expect(targetsEnumWithout).toEqual(['all', 'agentic', 'messages', 'st_settings']);

        // 2. When TavernHelper & EjsTemplate are active:
        bridge.extensionCapabilities = {
            tavernHelperScripts: true,
            tavernHelperAudio: true,
            ejsTemplate: true,
        };
        const withExtTools = runner.getAllowedToolDefinitions('full', true).map((t) => t.name);
        expect(withExtTools).toContain('tavern_helper_scripts_read');
        expect(withExtTools).toContain('tavern_helper_scripts_upsert');

        const sWith = await runner.createSession({
            title: '已安装扩展',
            mode: 'full',
            stAdminEnabled: true,
        });
        await runner.sendPrompt(sWith.id, '再次检查可用工具');
        const reqWith = transport.requests[1]!;
        const sysWith = String(reqWith.messages[0]?.content ?? '');
        expect(sysWith).toContain('JS-Slash-Runner');
        expect(sysWith).toContain('EjsTemplate');
        const syncToolWith = reqWith.tools?.find((t) => t.name === 'st_sync_runtime');
        const targetsEnumWith = (
            ((syncToolWith?.parameters?.properties as Record<string, Record<string, unknown>>)?.targets
                ?.items as Record<string, unknown>)?.enum as string[] | undefined
        ) ?? [];
        expect(targetsEnumWith).toEqual([
            'all',
            'agentic',
            'ejs',
            'tavern_helper_scripts',
            'tavern_helper_audio',
            'messages',
            'st_settings',
        ]);
    });

    it('creates a resumable checkpoint on approval and auto-continues through follow-up tools & chained approvals in the same bubble', async () => {
        const { bridge, transport, trajectoryStore, runner } = createRunnerHarness([
            // Round 1: preface + approval-gated WI edit
            {
                content: '我先为你更新主世界书 #7 条目。',
                reasoningContent: '准备写入规则条目 #7。',
                toolCalls: [
                    {
                        id: 'call_chain_wi_1',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            comment: '规则',
                            keys: ['规则'],
                            content: '@@system\n第一阶段规则已启用。',
                        }),
                    },
                ],
                usage: { inputTokens: 500, cachedTokens: 200, outputTokens: 50 },
            },
            // Round 2 (after approving call_chain_wi_1 + continueLastMessage): reads chat & proposes second approval-gated change
            {
                reasoningContent: '第一阶段已完成，继续处理设置变更。',
                toolCalls: [
                    {
                        id: 'call_chain_settings_2',
                        name: 'st_settings_patch',
                        arguments: JSON.stringify({
                            scope: 'power_user',
                            patch: { fast_ui_mode: false },
                        }),
                    },
                ],
                usage: { inputTokens: 650, cachedTokens: 450, outputTokens: 45 },
            },
            // Round 3 (after approving call_chain_settings_2 + continueLastMessage): final summary reply
            {
                content: '世界书条目 #7 与 fast_ui_mode 设置均已完成更新。',
                usage: { inputTokens: 780, cachedTokens: 580, outputTokens: 35 },
            },
        ]);

        const session = await runner.createSession({
            title: '审批自动续写链路测试',
            mode: 'full',
            stAdminEnabled: true,
            autoApproveAuthor: false,
        });

        const bubble1 = await runner.sendPrompt(session.id, '帮我更新规则并关闭 fast_ui_mode');
        expect(bubble1.approvalIds).toHaveLength(1);
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeUndefined();

        const appr1Id = bubble1.approvalIds![0];
        const approved1 = await runner.decideApproval(appr1Id, 'approve');
        expect(approved1?.status).toBe('approved');

        const afterAppr1 = runner.getSession(session.id)!;
        const msgAfterAppr1 = afterAppr1.messages[afterAppr1.messages.length - 1]!;
        expect(msgAfterAppr1.content).toBe('我先为你更新主世界书 #7 条目。');
        expect(msgAfterAppr1.content).not.toContain('已执行：');
        expect(msgAfterAppr1.interrupted).toBeUndefined();
        expect(afterAppr1.interruptedCheckpoint?.messageId).toBe(bubble1.id);
        expect(afterAppr1.interruptedCheckpoint?.bubbleBaseContent).toBe('我先为你更新主世界书 #7 条目。');

        // Continuation 1 -> receives WI tool result and suspends on chained approval #2
        const bubble2 = await runner.continueLastMessage(session.id);
        expect(bubble2.id).toBe(bubble1.id);
        expect(bubble2.approvalIds).toHaveLength(2);
        expect(bubble2.toolCalls?.map((t) => t.id)).toEqual(['call_chain_wi_1']);
        expect(bubble2.activity).toHaveLength(2);

        // Layer 0 prefix remains identical across rounds & Round 2 received real tool output
        expect(canonicalStringify(transport.requests[1].messages[0])).toBe(
            canonicalStringify(transport.requests[0].messages[0]),
        );
        const round2ToolMsg = transport.requests[1].messages.find(
            (m) => m.role === 'tool' && m.toolCallId === 'call_chain_wi_1',
        );
        expect(round2ToolMsg).toBeDefined();
        expect(String(round2ToolMsg!.content)).toContain('"ok":true');

        // Approve chained approval #2 -> sets checkpoint again, then final continuation completes turn
        const appr2Id = bubble2.approvalIds![1];
        const approved2 = await runner.decideApproval(appr2Id, 'approve');
        expect(approved2?.status).toBe('approved');
        expect(bridge.hostSettings.power_user.fast_ui_mode).toBe(false);

        const finalBubble = await runner.continueLastMessage(session.id);
        expect(finalBubble.id).toBe(bubble1.id);
        expect(finalBubble.content).toBe(
            '我先为你更新主世界书 #7 条目。世界书条目 #7 与 fast_ui_mode 设置均已完成更新。',
        );
        expect(finalBubble.approvalIds).toHaveLength(2);
        expect(finalBubble.toolCalls?.map((t) => t.id)).toEqual([
            'call_chain_wi_1',
            'call_chain_settings_2',
        ]);
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeUndefined();

        const committed = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(committed.some((m) => m.role === 'tool' && m.toolCallId === 'call_chain_wi_1')).toBe(
            true,
        );
        expect(
            committed.some((m) => m.role === 'tool' && m.toolCallId === 'call_chain_settings_2'),
        ).toBe(true);
        expect(committed[committed.length - 1]).toEqual({
            role: 'assistant',
            content: '世界书条目 #7 与 fast_ui_mode 设置均已完成更新。',
        });
    });

    it('waits until all pending approvals in a multi-approval round are resolved before setting checkpoint (including mixed reject + approve)', async () => {
        const { transport, runner } = createRunnerHarness([
            // Round 1: two approval-gated tool calls in one round
            {
                toolCalls: [
                    {
                        id: 'call_multi_1',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            keys: ['规则'],
                            content: '@@system\n多审批更新',
                        }),
                    },
                    {
                        id: 'call_multi_2',
                        name: 'chat_delete_message',
                        arguments: JSON.stringify({ messageId: 1 }),
                    },
                ],
            },
            // Round 2 (after resolving both): receives both tool outputs
            {
                content: '两个审批结果均已处理完成。',
            },
            // Round 3: another multi-approval turn to test mixed reject + approve
            {
                toolCalls: [
                    {
                        id: 'call_mix_reject',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            keys: ['规则'],
                            content: '@@system\n不应写入',
                        }),
                    },
                    {
                        id: 'call_mix_approve',
                        name: 'st_settings_patch',
                        arguments: JSON.stringify({
                            scope: 'power_user',
                            patch: { fast_ui_mode: false },
                        }),
                    },
                ],
            },
            {
                content: '已保留拒绝反馈并完成另一项设置修改。',
            },
        ]);

        const session = await runner.createSession({
            title: '多审批同轮测试',
            mode: 'full',
            stAdminEnabled: true,
            autoApproveAuthor: false,
            autoApproveChatDelete: false,
        });

        // Case A: approve first -> no checkpoint yet; approve second -> checkpoint with both tool results
        const b1 = await runner.sendPrompt(session.id, '同时改世界书并删掉第 1 条消息');
        expect(b1.approvalIds).toHaveLength(2);
        const [a1, a2] = b1.approvalIds!;

        await runner.decideApproval(a1, 'approve');
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeUndefined();

        await runner.decideApproval(a2, 'approve');
        const cpA = runner.getSession(session.id)!.interruptedCheckpoint;
        expect(cpA).toBeDefined();
        expect(
            cpA!.inFlightMessages.filter((m) => m.role === 'tool').map((m) => m.toolCallId).sort(),
        ).toEqual(['call_multi_1', 'call_multi_2']);

        const contA = await runner.continueLastMessage(session.id);
        expect(contA.content).toBe('两个审批结果均已处理完成。');
        expect(
            transport.requests[1].messages
                .filter((m) => m.role === 'tool')
                .map((m) => m.toolCallId)
                .sort(),
        ).toEqual(['call_multi_1', 'call_multi_2']);

        // Case B: reject first with feedback + approve second -> checkpoint pairs rejection payload & approved result
        const b2 = await runner.sendPrompt(session.id, '再试一次混合审批');
        expect(b2.approvalIds).toHaveLength(2);
        const [m1, m2] = b2.approvalIds!;

        await runner.decideApproval(m1, 'reject', '不要改世界书');
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeUndefined();

        await runner.decideApproval(m2, 'approve');
        const cpB = runner.getSession(session.id)!.interruptedCheckpoint;
        expect(cpB).toBeDefined();
        const rejectedTool = cpB!.inFlightMessages.find(
            (m) => m.role === 'tool' && m.toolCallId === 'call_mix_reject',
        );
        expect(rejectedTool).toBeDefined();
        expect(JSON.parse(String(rejectedTool!.content))).toEqual({
            ok: false,
            status: 'rejected_by_user',
            feedback: '不要改世界书',
        });

        const contB = await runner.continueLastMessage(session.id);
        expect(contB.content).toBe('已保留拒绝反馈并完成另一项设置修改。');
    });

    it('flushes an unresumed approval checkpoint to TrajectoryStore before starting a new sendPrompt turn', async () => {
        const { transport, trajectoryStore, runner } = createRunnerHarness([
            {
                toolCalls: [
                    {
                        id: 'call_flush_1',
                        name: 'wi_upsert_primary_entry',
                        arguments: JSON.stringify({
                            uid: 7,
                            keys: ['规则'],
                            content: '@@system\n待冲刷规则',
                        }),
                    },
                ],
            },
            {
                content: '好的，开始新话题。',
            },
        ]);

        const session = await runner.createSession({
            title: '未续写审批冲刷测试',
            mode: 'author',
            autoApproveAuthor: false,
        });

        const b1 = await runner.sendPrompt(session.id, '先改一下世界书');
        await runner.decideApproval(b1.approvalIds![0], 'approve');
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeDefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(0);

        // User sends a brand-new prompt instead of continuing -> previous approved tool turn is flushed safely
        const b2 = await runner.sendPrompt(session.id, '换个话题聊聊');
        expect(b2.content).toBe('好的，开始新话题。');
        expect(runner.getSession(session.id)!.interruptedCheckpoint).toBeUndefined();

        const req2 = transport.requests[1]!;
        expect(req2.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_flush_1')).toBe(
            true,
        );
        const committed = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(committed.some((m) => m.role === 'tool' && m.toolCallId === 'call_flush_1')).toBe(
            true,
        );
    });

    it('takes over Off-Mainline Assistant system prompt via {{assistantSystemPrompt}} / {{systemBase}} without EJS errors or Gemini systemInstruction leakage', async () => {
        const bridge = createOffMainlineTestBridge();
        bridge.extensionCapabilities = {
            tavernHelperScripts: false,
            tavernHelperAudio: false,
            ejsTemplate: true,
        };
        bridge.evaluateOptionalEjs = async (text) => {
            if (text.includes('<%')) {
                throw new Error(`Unexpected EJS compilation on literal <%: ${text}`);
            }
            return text;
        };

        const transport = new ScriptedLLMTransport([
            { content: '第一轮完成' },
            { content: '第二轮复用完成' },
            { content: '切换模式后完成' },
        ]);
        const trajectoryStore = new TrajectoryStore();
        const traceLogger = new TraceLogger();
        const settings = createDefaultSettings();
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'asst_user_prefix',
                name: 'Assistant User Slot',
                role: 'user',
                placement: 'prefix',
                content: '助手指令接管：\n{{assistantSystemPrompt}}\n别名：{{assistant-system-prompt}}',
                enabled: true,
                triggers: ['assistant'],
            },
        ];

        const runner = new AssistantRunner({
            bridge,
            transport,
            trajectoryStore,
            traceLogger,
            settings,
        });

        const session = await runner.createSession({
            title: '助手系统词接管测试',
            mode: 'chat',
        });

        // Turn 1: built-in Off-Mainline Assistant prompt is NOT emitted as role='system', expands inside user block,
        // and literal `<% ... %>` inside buildAssistantSystemPrompt() never triggers evaluateOptionalEjs
        await runner.sendPrompt(session.id, '帮我检查现状');
        const req1 = transport.requests[0]!;
        expect(req1.messages.some((m) => m.role === 'system')).toBe(false);
        expect(req1.messages[0].role).toBe('user');
        expect(req1.messages[0].content).toContain(
            'You are the ST-Agentic Off-Mainline Assistant operating outside the mainline RP context',
        );
        expect(req1.messages[0].content).toContain('Current capability mode: chat.');

        const compiler = new PayloadCompiler();
        const compiled = compiler.compile(
            req1,
            createDefaultConnection({ providerFormat: 'gemini', model: 'gemini-2.5-pro' }),
        );
        expect(compiled.body.systemInstruction).toBeUndefined();
        expect(JSON.stringify(compiled.body.contents)).toContain(
            'You are the ST-Agentic Off-Mainline Assistant',
        );

        // Turn 2: frozen prefix reuse MUST NOT slice off messages[0] when system prompt was omitted
        await runner.sendPrompt(session.id, '继续分析');
        const req2 = transport.requests[1]!;
        expect(req2.messages.some((m) => m.role === 'system')).toBe(false);
        expect(req2.messages[0].role).toBe('user');
        expect(req2.messages[0].content).toContain('Current capability mode: chat.');

        // Mode switch (chat -> adjust) invalidates frozen prefix and updates expanded prompt
        await runner.updateSessionConfig(session.id, { mode: 'adjust' });
        await runner.sendPrompt(session.id, '现在进入调整模式');
        const req3 = transport.requests[2]!;
        expect(req3.messages.some((m) => m.role === 'system')).toBe(false);
        expect(req3.messages[0].content).toContain('Current capability mode: adjust.');
    });

    it('supports {{systemBase}} / {{assistantSystemPrompt}} in assistant tail blocks across frozen turns and invalidates stale prefix', async () => {
        const { settings, transport, runner } = createRunnerHarness([
            { content: '第一轮无接管' },
            { content: '第二轮尾部接管' },
            { content: '第三轮继续尾部接管' },
        ]);

        const session = await runner.createSession({
            title: '尾部接管测试',
            mode: 'chat',
        });

        // Turn 1: no takeover macro -> auto system prompt present
        await runner.sendPrompt(session.id, '回合一');
        expect(transport.requests[0]!.messages[0].role).toBe('system');
        expect(transport.requests[0]!.messages[0].content).toContain(
            'You are the ST-Agentic Off-Mainline Assistant',
        );

        // Add tail block with {{systemBase}} -> stale Turn 1 frozen prefix MUST be invalidated
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'asst_tail_takeover',
                name: 'Assistant Tail Takeover',
                role: 'user',
                placement: 'tail',
                content: '尾部接管：\n{{systemBase}}',
                enabled: true,
                triggers: ['assistant'],
            },
        ];

        await runner.sendPrompt(session.id, '回合二');
        const req2 = transport.requests[1]!;
        expect(req2.messages.some((m) => m.role === 'system')).toBe(false);
        const tailMsg2 = req2.messages[req2.messages.length - 1]!;
        expect(tailMsg2.role).toBe('user');
        expect(tailMsg2.content).toContain(
            'You are the ST-Agentic Off-Mainline Assistant',
        );

        await runner.sendPrompt(session.id, '回合三');
        const req3 = transport.requests[2]!;
        expect(req3.messages.some((m) => m.role === 'system')).toBe(false);
        const tailMsg3 = req3.messages[req3.messages.length - 1]!;
        expect(tailMsg3.role).toBe('user');
        expect(tailMsg3.content).toContain(
            'You are the ST-Agentic Off-Mainline Assistant',
        );
    });

    it('auto-retries empty responses with finishReason=length/MAX_TOKENS, rolls back leaked reasoning, and classifies exhausted retries as empty_response', async () => {
        // 1. Empty response with MAX_TOKENS / length (completely empty + reasoning-only) retries and recovers
        const { transport, trajectoryStore, settings, runner } = createRunnerHarness(
            [
                // Attempt 1: MAX_TOKENS with zero text and zero toolCalls
                {
                    content: '',
                    finishReason: 'MAX_TOKENS',
                },
                // Attempt 2: length with reasoningContent only, zero text and zero toolCalls
                {
                    content: '   ',
                    reasoningContent: '泄露的残留思考片段',
                    finishReason: 'length',
                },
                // Attempt 3: clean normal response
                {
                    content: '重试后成功生成正文。',
                    reasoningContent: '正常思考过程',
                    finishReason: 'stop',
                },
            ],
            {
                stream: true,
                autoRetry: { initialDelayMs: 2, maxDelayMs: 10, backoffFactor: 2 },
            },
        );
        settings.connections.default.roundMaxRetries = 2;

        const session = await runner.createSession({ title: 'MAX_TOKENS 空响应重试', mode: 'chat' });
        const retryStatuses: AssistantRetryStatus[] = [];
        const reply = await runner.sendPrompt(session.id, '请分析现状', {
            onRetry: (status) => retryStatuses.push(status),
        });

        expect(transport.requests).toHaveLength(3);
        expect(retryStatuses).toHaveLength(2);
        expect(retryStatuses[0]).toMatchObject({ attempt: 1, maxAttempts: 2 });
        expect(retryStatuses[1]).toMatchObject({ attempt: 2, maxAttempts: 2 });
        expect(reply.content).toBe('重试后成功生成正文。');
        expect(reply.think).toBe('正常思考过程');
        expect(reply.think).not.toContain('泄露的残留思考片段');
        expect(reply.retryStatus).toBeUndefined();
        expect(reply.interrupted).toBeUndefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(2);

        // 2. Exhausted MAX_TOKENS empty responses -> errorCode: 'empty_response' & canContinue: true
        const exhausted = createRunnerHarness(
            [
                { content: '', finishReason: 'MAX_TOKENS' },
                { content: '', finishReason: 'length' },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 1, initialDelayMs: 2, maxDelayMs: 5 },
            },
        );
        const sExhausted = await exhausted.runner.createSession({ title: '空响应耗尽', mode: 'chat' });
        await expect(exhausted.runner.sendPrompt(sExhausted.id, '测试耗尽')).rejects.toThrow(/空响应/);
        const failedSession = exhausted.runner.getSession(sExhausted.id)!;
        const failedMsg = failedSession.messages[failedSession.messages.length - 1]!;
        expect(failedMsg.interrupted).toBe(true);
        expect(failedMsg.errorCode).toBe('empty_response');
        expect(failedMsg.canContinue).toBe(true);
    });

    it('filters blank-name tool calls in non-streaming mode and triggers EMPTY_RESPONSE auto-retry', async () => {
        const { transport, runner } = createRunnerHarness(
            [
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_blank_name',
                            name: '   ',
                            arguments: '{}',
                        },
                    ],
                },
                {
                    content: '已过滤无效空工具名并重试成功。',
                },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 1, initialDelayMs: 2, maxDelayMs: 5 },
            },
        );

        const session = await runner.createSession({ title: '空工具名过滤重试', mode: 'chat' });
        const retryStatuses: AssistantRetryStatus[] = [];
        const reply = await runner.sendPrompt(session.id, '检查工具调用', {
            onRetry: (status) => retryStatuses.push(status),
        });

        expect(transport.requests).toHaveLength(2);
        expect(retryStatuses).toHaveLength(1);
        expect(reply.content).toBe('已过滤无效空工具名并重试成功。');
        expect(reply.toolCalls).toBeUndefined();
    });

    it('auto-retries empty responses in retryApproval() and throws when retries are exhausted', async () => {
        // 1. retryApproval recovers after an empty response
        const { transport, runner } = createRunnerHarness(
            [
                {
                    content: '初版草案',
                    toolCalls: [
                        {
                            id: 'call_wi_init',
                            name: 'wi_upsert_primary_entry',
                            arguments: JSON.stringify({
                                uid: 7,
                                comment: '规则',
                                keys: ['规则'],
                                content: '@@system\n初版内容',
                            }),
                        },
                    ],
                },
                // retryApproval attempt 1: empty response -> must retry
                { content: '' },
                // retryApproval attempt 2: valid revised tool proposal
                {
                    content: '修订版草案',
                    toolCalls: [
                        {
                            id: 'call_wi_revised',
                            name: 'wi_upsert_primary_entry',
                            arguments: JSON.stringify({
                                uid: 7,
                                comment: '规则',
                                keys: ['规则'],
                                content: '@@system\n修订后内容',
                            }),
                        },
                    ],
                },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 1, initialDelayMs: 2, maxDelayMs: 5 },
            },
        );

        const session = await runner.createSession({
            title: '审批重试空响应恢复',
            mode: 'author',
            autoApproveAuthor: false,
        });
        const bubble = await runner.sendPrompt(session.id, '修改世界书 #7');
        const approvalId = bubble.approvalIds![0];

        const retried = await runner.retryApproval(approvalId, '补充细节');
        expect(transport.requests).toHaveLength(3);
        expect(retried?.revision).toBe(2);
        expect(retried?.rawContent).toBe('@@system\n修订后内容');

        // 2. retryApproval throws when empty responses exhaust retries (must NOT silently bump revision)
        const exhaustedHarness = createRunnerHarness(
            [
                {
                    content: '初版草案',
                    toolCalls: [
                        {
                            id: 'call_wi_init_2',
                            name: 'wi_upsert_primary_entry',
                            arguments: JSON.stringify({
                                uid: 7,
                                comment: '规则',
                                keys: ['规则'],
                                content: '@@system\n初版内容',
                            }),
                        },
                    ],
                },
                { content: '' },
                { content: '   ' },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 1, initialDelayMs: 2, maxDelayMs: 5 },
            },
        );

        const s2 = await exhaustedHarness.runner.createSession({
            title: '审批重试空响应耗尽',
            mode: 'author',
            autoApproveAuthor: false,
        });
        const b2 = await exhaustedHarness.runner.sendPrompt(s2.id, '修改世界书 #7');
        const appr2 = b2.approvalIds![0];

        await expect(exhaustedHarness.runner.retryApproval(appr2, '再试一次')).rejects.toThrow(/空响应/);
        expect(exhaustedHarness.transport.requests).toHaveLength(3);
        expect(exhaustedHarness.runner.getApproval(appr2)?.revision).toBe(1);
    });

    it('auto-retries when processOutputText strips the final reply down to empty', async () => {
        const { bridge, transport, runner } = createRunnerHarness(
            [
                { content: '   <STRIP_ME>   ' },
                { content: '保留下来的有效回复。' },
            ],
            {
                stream: false,
                autoRetry: { maxRetries: 1, initialDelayMs: 2, maxDelayMs: 5 },
            },
        );

        bridge.onOutputProcess((payload) => {
            if (payload.text.includes('<STRIP_ME>')) {
                payload.text = '   ';
            }
        });

        const session = await runner.createSession({ title: '后处理清空重试', mode: 'chat' });
        const retryStatuses: AssistantRetryStatus[] = [];
        const reply = await runner.sendPrompt(session.id, '生成回复', {
            onRetry: (status) => retryStatuses.push(status),
        });

        expect(transport.requests).toHaveLength(2);
        expect(retryStatuses).toHaveLength(1);
        expect(reply.content).toBe('保留下来的有效回复。');
    });
});
