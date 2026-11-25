import { describe, expect, it, vi } from 'vitest';
import {
    AssistantRunner,
    type AssistantRetryOptions,
    toAssistantThreadId,
} from '@/core/assistant';
import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMTransport } from '@/core/bridge';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import type { AssistantRetryStatus, PromptBlock } from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

/**
 * Recording wrapper around `ScriptedLLMTransport` that preserves `request.toolChoice`
 * verbatim (since `ScriptedLLMTransport.captureRequest` omits `toolChoice`).
 */
class RecordingTransport implements LLMTransport {
    public readonly requests: LLMRequest[] = [];
    private readonly inner: ScriptedLLMTransport;

    constructor(turns: ScriptedTurnInput[] = []) {
        this.inner = new ScriptedLLMTransport(turns);
    }

    private record(request: LLMRequest): void {
        this.requests.push({
            connectionId: request.connectionId,
            connection: request.connection ? canonicalClone(request.connection) : undefined,
            messages: canonicalClone(request.messages),
            tools: canonicalClone(request.tools),
            toolChoice: request.toolChoice ? canonicalClone(request.toolChoice) : undefined,
            cacheBreakpoints: request.cacheBreakpoints ? [...request.cacheBreakpoints] : undefined,
            stream: request.stream,
            signal: request.signal,
        });
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        this.record(request);
        return this.inner.complete(request);
    }

    async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
        this.record(request);
        for await (const chunk of this.inner.stream(request)) {
            yield chunk;
        }
    }
}

function createStrictHarness(
    turns: ScriptedTurnInput[],
    opts?: {
        strictToolLoop?: boolean;
        roundMaxRetries?: number;
        stream?: boolean;
        autoRetry?: AssistantRetryOptions | false;
        extraPromptBlocks?: PromptBlock[];
        ejsEvaluator?: (text: string, vars: Record<string, unknown>) => Promise<string>;
    },
) {
    const bridge = createOffMainlineTestBridge();
    if (opts?.ejsEvaluator) {
        bridge.evaluateOptionalEjs = opts.ejsEvaluator;
    }

    const transport = new RecordingTransport(turns);
    const trajectoryStore = new TrajectoryStore();
    const settings = createDefaultSettings();
    settings.connections.default = {
        ...settings.connections.default,
        strictToolLoop: opts?.strictToolLoop ?? true,
        ...(opts?.roundMaxRetries !== undefined ? { roundMaxRetries: opts.roundMaxRetries } : {}),
        stream: opts?.stream ?? true,
    };

    if (opts?.extraPromptBlocks?.length) {
        const preset = settings.presets[settings.currentPresetId];
        const mainAgent = preset.agents[preset.mainAgentId];
        mainAgent.promptBlocks = [...mainAgent.promptBlocks, ...opts.extraPromptBlocks];
    }

    const runner = new AssistantRunner({
        bridge,
        transport,
        trajectoryStore,
        settings,
        stream: opts?.stream ?? true,
        ...(opts?.autoRetry !== undefined ? { autoRetry: opts.autoRetry } : {}),
    });

    return { bridge, transport, trajectoryStore, settings, runner };
}

describe('AssistantRunner — A1.3 Async Custom/EJS Prompts, Transparent finish_turn, Retry & Prefill', () => {
    it('renders async custom JSON + EJS prefix/tail prompt blocks and freezes prefix across turns', async () => {
        let ejsPrefixCalls = 0;
        let ejsTailCalls = 0;

        const ejsEvaluator = vi.fn(async (text: string, vars: Record<string, unknown>) => {
            if (text.includes('PREFIX_TAG')) {
                ejsPrefixCalls += 1;
                return text.replace('<%- PREFIX_TAG %>', `v${ejsPrefixCalls}:${String(vars.chapter ?? '0')}`);
            }
            if (text.includes('TAIL_DYNAMIC_BLOCK')) {
                ejsTailCalls += 1;
                const jsonHelper = vars.json as (v: unknown) => string;
                return JSON.stringify([
                    {
                        role: 'system',
                        content: `tail_run_${ejsTailCalls}_${JSON.parse(jsonHelper(vars.chapter ?? 'none'))}`,
                    },
                ]);
            }
            return text;
        });

        const { bridge, transport, runner } = createStrictHarness(
            [
                {
                    toolCalls: [
                        {
                            id: 'ft_ejs_1',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '第一轮答复',
                                response: '第一轮完成。',
                            }),
                        },
                    ],
                },
                {
                    toolCalls: [
                        {
                            id: 'ft_ejs_2',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '第二轮答复',
                                response: '第二轮完成。',
                            }),
                        },
                    ],
                },
            ],
            {
                strictToolLoop: true,
                stream: false,
                ejsEvaluator,
                extraPromptBlocks: [
                    {
                        id: 'ast_custom_prefix',
                        name: 'Assistant Custom Context',
                        role: 'custom',
                        placement: 'prefix',
                        enabled: true,
                        triggers: ['assistant'],
                        content: JSON.stringify([
                            {
                                role: 'user',
                                content: '示范检查 <%- PREFIX_TAG %>',
                            },
                            {
                                role: 'assistant',
                                content: '',
                                tool_calls: [
                                    {
                                        type: 'function',
                                        function: {
                                            name: 'list_dir',
                                            arguments: { path: '/' },
                                        },
                                    },
                                ],
                                vendor_tag: 'keep-me',
                            },
                            {
                                role: 'tool',
                                content: { ok: true, entries: ['/character'] },
                            },
                        ]),
                    },
                    {
                        id: 'ast_ejs_tail',
                        name: 'Assistant Dynamic Tail',
                        role: 'custom',
                        placement: 'tail',
                        enabled: true,
                        triggers: ['assistant'],
                        content: '<%/* TAIL_DYNAMIC_BLOCK */%>',
                    },
                ],
            },
        );

        bridge.setVariable('chapter', 'ch3');
        const session = await runner.createSession({ title: 'EJS 自定义测试', mode: 'chat' });

        await runner.sendPrompt(session.id, '第一问');
        bridge.setVariable('chapter', 'ch4');
        await runner.sendPrompt(session.id, '第二问');

        expect(transport.requests).toHaveLength(2);
        // Prefix EJS evaluated ONCE when Layer 0 froze; Tail EJS evaluated every turn
        expect(ejsPrefixCalls).toBe(1);
        expect(ejsTailCalls).toBe(2);

        const req1Msgs = transport.requests[0].messages;
        const req2Msgs = transport.requests[1].messages;

        // Custom multi-message block expanded with deterministic toolCallId, auto-paired tool msg, and extraFields
        const demoAssistant = req1Msgs.find((m) => m.extraFields?.vendor_tag === 'keep-me');
        expect(demoAssistant).toBeDefined();
        expect(demoAssistant!.toolCalls).toHaveLength(1);
        expect(demoAssistant!.toolCalls![0].id).toBe('call_ast_custom_prefix_1_0');
        const demoTool = req1Msgs.find(
            (m) => m.role === 'tool' && m.toolCallId === 'call_ast_custom_prefix_1_0',
        );
        expect(demoTool).toBeDefined();
        expect(demoTool!.toolName).toBe('list_dir');

        // Prefix text stayed frozen at v1:ch3 in turn 2
        expect(req1Msgs.some((m) => m.content === '示范检查 v1:ch3')).toBe(true);
        expect(req2Msgs.some((m) => m.content === '示范检查 v1:ch3')).toBe(true);

        // Tail dynamic Track B EJS updated between turns
        expect(req1Msgs[req1Msgs.length - 1].content).toBe('tail_run_1_ch3');
        expect(req2Msgs[req2Msgs.length - 1].content).toBe('tail_run_2_ch4');
    });

    it('streams finish_turn response transparently as Markdown with zero tool cards and full reconcileTurnMessages compatibility', async () => {
        const { transport, trajectoryStore, runner } = createStrictHarness(
            [
                {
                    toolCalls: [
                        {
                            id: 'call_ft_solo_1',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '分析雾港状态并整理回答',
                                response: '## 雾港诊断\n\n- 状态：**正常**\n- 说明："一切平稳"',
                            }),
                        },
                    ],
                    chunkSize: 4,
                    usage: { inputTokens: 320, cachedTokens: 200, outputTokens: 45 },
                },
            ],
            { strictToolLoop: true, stream: true },
        );

        const session = await runner.createSession({ title: '透明 finish_turn 测试', mode: 'chat' });
        const streamedDeltas: string[] = [];
        const reasoningDeltas: string[] = [];

        const reply = await runner.sendPrompt(session.id, '请诊断当前状态', {
            onDelta: (d) => streamedDeltas.push(d),
            onReasoningDelta: (d) => reasoningDeltas.push(d),
        });

        // Static finish_turn registered with propertyOrdering & required toolChoice
        expect(transport.requests).toHaveLength(1);
        const req = transport.requests[0];
        const finishTool = req.tools.find((t) => t.name === 'finish_turn');
        expect(finishTool).toBeDefined();
        expect(finishTool!.parameters.propertyOrdering).toEqual(['step_brief', 'response']);
        expect(req.toolChoice?.mode).toBe('required');
        expect(req.toolChoice?.allowedToolNames).toContain('finish_turn');

        // Incremental Markdown streaming (zero raw JSON leaked)
        expect(streamedDeltas.length).toBeGreaterThan(2);
        expect(streamedDeltas.join('')).toBe('## 雾港诊断\n\n- 状态：**正常**\n- 说明："一切平稳"');
        expect(reply.content).toBe('## 雾港诊断\n\n- 状态：**正常**\n- 说明："一切平稳"');

        // step_brief routed to folded thinkBuffer (not mixed into content)
        expect(reasoningDeltas.join('')).toBe('分析雾港状态并整理回答');
        expect(reply.think).toBe('分析雾港状态并整理回答');

        // ZERO tool-call cards for finish_turn
        expect(reply.toolCalls).toBeUndefined();
        expect(reply.approvalIds).toBeUndefined();

        // TrajectoryStore stores clean unwrapped assistant message (NO finish_turn pseudo tool call/result)
        const stored = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(stored).toHaveLength(2);
        expect(stored[0]).toEqual({ role: 'user', content: '请诊断当前状态' });
        expect(stored[1]).toEqual({
            role: 'assistant',
            content: '## 雾港诊断\n\n- 状态：**正常**\n- 说明："一切平稳"',
            reasoningContent: '分析雾港状态并整理回答',
        });
        expect(stored[1].toolCalls).toBeUndefined();

        // 100% compatible with editMessage -> reconcileTurnMessages
        await runner.editMessage(session.id, reply.id, '## 雾港诊断（人工修订）');
        const afterEdit = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(afterEdit).toHaveLength(2);
        expect(afterEdit[1].content).toBe('## 雾港诊断（人工修订）');
        expect(afterEdit[1].toolCalls).toBeUndefined();
    });

    it('keeps native reasoningContent exclusively in thinkBuffer without mixing step_brief', async () => {
        const { runner, trajectoryStore } = createStrictHarness(
            [
                {
                    reasoningContent: '原生深度思考过程',
                    toolCalls: [
                        {
                            id: 'call_ft_native_think',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '不应混入思考区的简述',
                                response: '正式回答正文。',
                            }),
                        },
                    ],
                    chunkSize: 5,
                },
            ],
            { strictToolLoop: true, stream: true },
        );

        const session = await runner.createSession({ title: '原生思考优先', mode: 'chat' });
        const reply = await runner.sendPrompt(session.id, '回答问题');

        expect(reply.content).toBe('正式回答正文。');
        expect(reply.think).toBe('原生深度思考过程');
        expect(reply.think).not.toContain('不应混入思考区的简述');

        const stored = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(stored[1].reasoningContent).toBe('原生深度思考过程');
    });

    it('protects against mixed [finish_turn, business tool] jump: rolls back premature text, runs tool, defers finish_turn, and preserves tool history on edit', async () => {
        const { transport, trajectoryStore, runner } = createStrictHarness(
            [
                // Round 1: finish_turn streams first (index 0), then list_dir arrives (index 1) -> anti-jump!
                {
                    toolCalls: [
                        {
                            id: 'call_ft_premature',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '抢跑规划',
                                response: '抢跑草稿内容，绝对不能留在最终气泡里！',
                            }),
                        },
                        {
                            id: 'call_list_mixed',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                    chunkSize: 6,
                },
                // Round 2: model sees list_dir output + deferred finish_turn response, then calls solo finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_ft_final',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '核对目录后正式汇总',
                                response: '已核对根目录，全部文件正常。',
                            }),
                        },
                    ],
                    chunkSize: 6,
                },
            ],
            { strictToolLoop: true, stream: true },
        );

        const session = await runner.createSession({ title: '混调防抢跑测试', mode: 'chat' });
        const reply = await runner.sendPrompt(session.id, '检查根目录后告诉我');

        expect(transport.requests).toHaveLength(2);
        // Top-level tools array remained strictly identical across rounds (KV cache invariance)
        expect(transport.requests[0].tools).toEqual(transport.requests[1].tools);

        // Round 2 received deferred finish_turn tool response + real list_dir result
        const round2Msgs = transport.requests[1].messages;
        const deferredToolMsg = round2Msgs.find(
            (m) => m.role === 'tool' && m.toolCallId === 'call_ft_premature',
        );
        expect(deferredToolMsg).toBeDefined();
        expect(JSON.parse(String(deferredToolMsg!.content))).toEqual({
            ok: false,
            deferred: true,
            message:
                'Other tools ran in this round. Review their outputs (or approval result) first, then call finish_turn in the next round.',
        });
        expect(
            round2Msgs.some((m) => m.role === 'tool' && m.toolCallId === 'call_list_mixed'),
        ).toBe(true);

        // Premature text rolled back cleanly; final bubble has ONLY final response + list_dir card (ZERO finish_turn card)
        expect(reply.content).toBe('已核对根目录，全部文件正常。');
        expect(reply.content).not.toContain('抢跑草稿');
        expect(reply.toolCalls).toHaveLength(1);
        expect(reply.toolCalls![0].name).toBe('list_dir');

        // Final message in TrajectoryStore is pure assistant text -> editMessage preserves tool history verbatim!
        const storedBeforeEdit = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        const lastBeforeEdit = storedBeforeEdit[storedBeforeEdit.length - 1];
        expect(lastBeforeEdit.role).toBe('assistant');
        expect(lastBeforeEdit.toolCalls).toBeUndefined();
        expect(lastBeforeEdit.content).toBe('已核对根目录，全部文件正常。');

        await runner.editMessage(session.id, reply.id, '已核对根目录（编辑后）。');
        const storedAfterEdit = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        expect(storedAfterEdit).toHaveLength(storedBeforeEdit.length);
        expect(
            storedAfterEdit.some((m) => m.role === 'tool' && m.toolCallId === 'call_list_mixed'),
        ).toBe(true);
        expect(storedAfterEdit[storedAfterEdit.length - 1].content).toBe(
            '已核对根目录（编辑后）。',
        );
    });

    it('preserves ApprovalGate pause & resume on mixed [chat_delete_message, finish_turn] without bypassing approval or dropping tool_call_id pairing', async () => {
        const { bridge, transport, trajectoryStore, runner } = createStrictHarness(
            [
                // Round 1: approval-gated write tool + premature finish_turn in same round
                {
                    toolCalls: [
                        {
                            id: 'call_del_1',
                            name: 'chat_delete_message',
                            arguments: JSON.stringify({ messageId: 1 }),
                        },
                        {
                            id: 'call_ft_jump_approval',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '假装已删除',
                                response: '已经帮你删掉了！（抢跑）',
                            }),
                        },
                    ],
                },
                // Round 2 (after approve + continueLastMessage): receives paired tool results and finishes cleanly
                {
                    toolCalls: [
                        {
                            id: 'call_ft_after_approve',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '确认删除完成',
                                response: '已删除第 1 条消息。',
                            }),
                        },
                    ],
                },
            ],
            { strictToolLoop: true, stream: true },
        );

        const session = await runner.createSession({
            title: '混调审批保护测试',
            mode: 'adjust',
            autoApproveChatDelete: false,
        });

        expect(bridge.chat).toHaveLength(2);
        const suspendedBubble = await runner.sendPrompt(session.id, '删掉第 1 条消息');

        // Approval MUST NOT be bypassed; chat must still be untouched; zero premature content or finish_turn card
        expect(bridge.chat).toHaveLength(2);
        expect(suspendedBubble.approvalIds).toHaveLength(1);
        expect(suspendedBubble.content).toBe('');
        expect(suspendedBubble.toolCalls).toBeUndefined();

        const approvalId = suspendedBubble.approvalIds![0];
        const pending = runner.getApproval(approvalId)!;
        expect(pending.status).toBe('pending');
        expect(pending.toolName).toBe('chat_delete_message');

        // User approves -> deletes message & prepares resumable checkpoint with BOTH paired tool results
        const approved = await runner.decideApproval(approvalId, 'approve');
        expect(approved?.status).toBe('approved');
        expect(bridge.chat).toHaveLength(1);

        const checkpointSession = runner.getSession(session.id)!;
        expect(checkpointSession.interruptedCheckpoint).toBeDefined();
        expect(checkpointSession.interruptedCheckpoint!.messageId).toBe(suspendedBubble.id);
        const checkpointToolIds = checkpointSession.interruptedCheckpoint!.inFlightMessages
            .filter((m) => m.role === 'tool')
            .map((m) => m.toolCallId)
            .sort();
        expect(checkpointToolIds).toEqual(['call_del_1', 'call_ft_jump_approval']);

        // Auto-continue resumes in the same bubble -> delivers paired tool outputs and commits real reply
        const resumed = await runner.continueLastMessage(session.id);
        expect(resumed.id).toBe(suspendedBubble.id);
        expect(resumed.content).toBe('已删除第 1 条消息。');
        expect(resumed.content).not.toContain('已执行：');

        const round2ToolIds = transport.requests[1].messages
            .filter((m) => m.role === 'tool')
            .map((m) => m.toolCallId)
            .sort();
        expect(round2ToolIds).toEqual(['call_del_1', 'call_ft_jump_approval']);

        const committed = trajectoryStore.getMessages(toAssistantThreadId(session.id));
        const toolResults = committed.filter((m) => m.role === 'tool');
        expect(toolResults.map((m) => m.toolCallId).sort()).toEqual([
            'call_del_1',
            'call_ft_jump_approval',
        ]);
        const deferredEntry = toolResults.find((m) => m.toolCallId === 'call_ft_jump_approval');
        expect(JSON.parse(String(deferredEntry!.content)).deferred).toBe(true);
        expect(committed[committed.length - 1]).toEqual({
            role: 'assistant',
            content: '已删除第 1 条消息。',
            reasoningContent: '确认删除完成',
        });
    });

    it('rolls back and retries TOOL_CHOICE_VIOLATION and MALFORMED_TOOL_CALL honoring connection.roundMaxRetries', async () => {
        const { transport, trajectoryStore, runner } = createStrictHarness(
            [
                // Attempt 1: violates tool_choice: required with plain text
                {
                    content: '我直接用纯文本摆烂回答',
                },
                // Attempt 2: malformed truncated JSON arguments on finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_ft_bad_json',
                            name: 'finish_turn',
                            arguments: '{"step_brief":"思考","response":"残影文本',
                        },
                    ],
                    chunkSize: 5,
                },
                // Attempt 3: valid JSON object but empty response on solo finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_ft_empty_resp',
                            name: 'finish_turn',
                            arguments: JSON.stringify({ step_brief: '空壳', response: '   ' }),
                        },
                    ],
                },
                // Attempt 4: clean solo finish_turn succeeds (3rd retry = connection.roundMaxRetries)
                {
                    toolCalls: [
                        {
                            id: 'call_ft_ok',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '重试恢复正常',
                                response: '干净完整的最终答复。',
                            }),
                        },
                    ],
                },
            ],
            {
                strictToolLoop: true,
                roundMaxRetries: 3,
                stream: true,
                // Do NOT pass maxRetries here so connection.roundMaxRetries = 3 drives retry budget
                autoRetry: { initialDelayMs: 2, maxDelayMs: 10, backoffFactor: 2 },
            },
        );

        const session = await runner.createSession({ title: '约束违规重试测试', mode: 'chat' });
        const retryStatuses: AssistantRetryStatus[] = [];

        const reply = await runner.sendPrompt(session.id, '请给出完整答复', {
            onRetry: (s) => retryStatuses.push(s),
        });

        expect(transport.requests).toHaveLength(4);
        expect(retryStatuses).toHaveLength(3);
        expect(retryStatuses.map((s) => [s.attempt, s.maxAttempts])).toEqual([
            [1, 3],
            [2, 3],
            [3, 3],
        ]);

        // Zero dirty fragments from attempts 1-3 survived in bubble or trajectory
        expect(reply.content).toBe('干净完整的最终答复。');
        expect(reply.content).not.toContain('摆烂');
        expect(reply.content).not.toContain('残影');
        expect(reply.think).toBe('重试恢复正常');
        expect(reply.retryStatus).toBeUndefined();
        expect(reply.toolCalls).toBeUndefined();
        expect(trajectoryStore.getMessageCount(toAssistantThreadId(session.id))).toBe(2);
    });

    it('auto-consumes and folds trailing partial:true / prefix:true Prefill assistant messages before round 2', async () => {
        const { transport, trajectoryStore, runner } = createStrictHarness(
            [
                // Round 1: model continues after prefill and calls list_dir
                {
                    content: '先查目录。',
                    toolCalls: [
                        {
                            id: 'call_prefill_list',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
                // Round 2: model completes via solo finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_prefill_ft',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '汇总目录',
                                response: '根目录检查完毕。',
                            }),
                        },
                    ],
                },
            ],
            {
                strictToolLoop: true,
                stream: false,
                extraPromptBlocks: [
                    {
                        id: 'ast_prefill_tail',
                        name: 'Kimi Partial Prefill',
                        role: 'custom',
                        placement: 'tail',
                        enabled: true,
                        triggers: ['assistant'],
                        content: JSON.stringify({
                            role: 'assistant',
                            content: '【导语】',
                            partial: true,
                        }),
                    },
                ],
            },
        );

        const session = await runner.createSession({ title: 'Prefill 折叠测试', mode: 'chat' });
        const reply = await runner.sendPrompt(session.id, '帮我查根目录');

        expect(transport.requests).toHaveLength(2);

        // Round 1 request ends with partial: true prefill assistant message
        const req1Last = transport.requests[0].messages[transport.requests[0].messages.length - 1];
        expect(req1Last.role).toBe('assistant');
        expect(req1Last.content).toBe('【导语】');
        expect(req1Last.extraFields?.partial).toBe(true);

        // Round 2 request MUST NOT contain any partial: true or prefix: true message anywhere (prevents HTTP 400)
        const req2Msgs = transport.requests[1].messages;
        expect(
            req2Msgs.some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true),
        ).toBe(false);

        // Round 1 assistant message in Round 2 has prefill text folded cleanly into content
        const foldedAssistant = req2Msgs.find(
            (m) =>
                m.role === 'assistant'
                && m.toolCalls?.some((tc) => tc.id === 'call_prefill_list'),
        );
        expect(foldedAssistant).toBeDefined();
        expect(foldedAssistant!.content).toBe('【导语】先查目录。');
        expect(foldedAssistant!.extraFields).toBeUndefined();

        expect(reply.content).toBe('根目录检查完毕。');
        expect(
            trajectoryStore
                .getMessages(toAssistantThreadId(session.id))
                .some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true),
        ).toBe(false);
    });
});
