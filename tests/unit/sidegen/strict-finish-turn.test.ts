import { describe, expect, it, vi } from 'vitest';
import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMTransport } from '@/core/bridge';
import { createDefaultConnection, createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { LLMTransportError } from '@/core/llm';
import { SideGenService, toSideThreadId } from '@/core/sidegen';
import type { ApiConnection, PromptBlock, RegexRule } from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

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

function createSideGenHarness(
    turns: ScriptedTurnInput[],
    opts?: {
        connection?: Partial<ApiConnection>;
        extraPromptBlocks?: PromptBlock[];
        regexRules?: RegexRule[];
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
    const conn = createDefaultConnection({
        id: 'side-strict',
        model: 'gemini-2.5-flash',
        strictToolLoop: true,
        roundMaxRetries: 2,
        stream: true,
        ...opts?.connection,
    });
    settings.connections['side-strict'] = conn;

    const preset = settings.presets[settings.currentPresetId];
    if (opts?.extraPromptBlocks?.length) {
        const mainAgent = preset.agents[preset.mainAgentId];
        mainAgent.promptBlocks = [...mainAgent.promptBlocks, ...opts.extraPromptBlocks];
    }
    if (opts?.regexRules?.length) {
        preset.regexRules = [...opts.regexRules];
    }

    const service = new SideGenService({
        bridge,
        transport,
        trajectoryStore,
        getDefaultConnectionId: () => 'side-strict',
        getSettings: () => settings,
        resolveConnection: (id) => settings.connections[id],
        roundRetry: { initialDelayMs: 2, maxDelayMs: 10, backoffFactor: 2 },
    });

    return { bridge, transport, trajectoryStore, settings, conn, service };
}

describe('SideGenService — A1.3 Async Custom/EJS Prompts, Transparent finish_turn, Retry & Prefill', () => {
    it('renders async custom JSON + EJS prompt blocks in runOnce and freezes prefix EJS across send() turns', async () => {
        let prefixEvals = 0;
        let tailEvals = 0;

        const ejsEvaluator = vi.fn(async (text: string, vars: Record<string, unknown>) => {
            if (text.includes('SIDE_PREFIX_EXPR')) {
                prefixEvals += 1;
                return text.replace(
                    '<%- SIDE_PREFIX_EXPR %>',
                    `p${prefixEvals}:${String(vars.zone ?? 'unknown')}`,
                );
            }
            if (text.includes('SIDE_TAIL_TRACK_B')) {
                tailEvals += 1;
                const jsonFn = vars.json as (v: unknown) => string;
                return JSON.stringify({
                    role: 'system',
                    content: `tail#${tailEvals}:${JSON.parse(jsonFn(vars.zone ?? 'none'))}`,
                });
            }
            return text;
        });

        const { bridge, transport, service } = createSideGenHarness(
            [
                // runOnce
                {
                    toolCalls: [
                        {
                            id: 'ft_once_ejs',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '生成一次性线索',
                                response: '码头暗哨换防完毕。',
                            }),
                        },
                    ],
                },
                // session turn 1
                {
                    toolCalls: [
                        {
                            id: 'ft_sess_ejs_1',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '第一轮支线',
                                response: '支线回复一。',
                            }),
                        },
                    ],
                },
                // session turn 2
                {
                    toolCalls: [
                        {
                            id: 'ft_sess_ejs_2',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '第二轮支线',
                                response: '支线回复二。',
                            }),
                        },
                    ],
                },
            ],
            {
                connection: { strictToolLoop: true, stream: false },
                ejsEvaluator,
                extraPromptBlocks: [
                    {
                        id: 'side_custom_prefix',
                        name: 'SideGen Custom Prefix',
                        role: 'custom',
                        placement: 'prefix',
                        enabled: true,
                        triggers: ['sidegen'],
                        content: JSON.stringify([
                            { role: 'user', content: '区域设定 <%- SIDE_PREFIX_EXPR %>' },
                            {
                                role: 'assistant',
                                content: '',
                                tool_calls: [{ name: 'finish_turn', arguments: { step_brief: 'demo', response: 'ok' } }],
                                trace_tag: 'side-demo',
                            },
                            { role: 'tool', content: { ok: true } },
                        ]),
                    },
                    {
                        id: 'side_ejs_tail',
                        name: 'SideGen Dynamic Tail',
                        role: 'custom',
                        placement: 'tail',
                        enabled: true,
                        triggers: ['sidegen'],
                        content: '<%/* SIDE_TAIL_TRACK_B */%>',
                    },
                ],
            },
        );

        bridge.setVariable('zone', 'dock-east');

        // 1. runOnce renders both prefix & tail async EJS + custom blocks
        const onceResult = await service.runOnce({ prompt: '侦查东区' });
        expect(onceResult.text).toBe('码头暗哨换防完毕。');
        expect(transport.requests[0].messages.some((m) => m.content === '区域设定 p1:dock-east')).toBe(true);
        expect(transport.requests[0].messages.some((m) => m.extraFields?.trace_tag === 'side-demo')).toBe(true);
        expect(transport.requests[0].messages[transport.requests[0].messages.length - 1].content).toBe(
            'tail#1:dock-east',
        );

        // 2. createSession freezes prefix (eval #2); send turn 1 & turn 2 MUST NOT re-evaluate prefix
        await service.createSession({
            id: 'side:ejs',
            title: 'EJS 支线',
            systemPrompt: '支线系统词',
        });
        expect(prefixEvals).toBe(2);

        await service.send('side:ejs', '第一条消息');
        bridge.setVariable('zone', 'dock-west');
        await service.send('side:ejs', '第二条消息');

        // Prefix remained frozen after createSession; tail updated on every send()
        expect(prefixEvals).toBe(2);
        expect(tailEvals).toBe(3);

        const sessReq1 = transport.requests[1].messages;
        const sessReq2 = transport.requests[2].messages;
        expect(sessReq1.some((m) => m.content === '区域设定 p2:dock-east')).toBe(true);
        expect(sessReq2.some((m) => m.content === '区域设定 p2:dock-east')).toBe(true);
        expect(sessReq1[sessReq1.length - 1].content).toBe('tail#2:dock-east');
        expect(sessReq2[sessReq2.length - 1].content).toBe('tail#3:dock-west');
    });

    it('unwraps streaming finish_turn cleanly in runOnce and send() with zero pseudo tool-calls persisted in TrajectoryStore', async () => {
        const { transport, trajectoryStore, service } = createSideGenHarness(
            [
                // runOnce streaming finish_turn
                {
                    toolCalls: [
                        {
                            id: 'ft_stream_once',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '汇总码头动向',
                                response: '### 码头简报\n\n夜班守卫已撤离。',
                            }),
                        },
                    ],
                    chunkSize: 4,
                    usage: { inputTokens: 140, cachedTokens: 60, outputTokens: 28 },
                },
                // session send: mixed [unexpected_tool, finish_turn] -> deferred -> round 2 clean solo finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_unknown_1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/notes.md' }),
                        },
                        {
                            id: 'ft_mixed_jump',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '抢跑',
                                response: '不应输出的抢跑内容',
                            }),
                        },
                    ],
                    chunkSize: 5,
                },
                {
                    toolCalls: [
                        {
                            id: 'ft_stream_sess_final',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '正式提交支线回复',
                                response: '支线密信：灯塔三楼暗门已开启。',
                            }),
                        },
                    ],
                    chunkSize: 5,
                    usage: { inputTokens: 220, cachedTokens: 150, outputTokens: 32 },
                },
            ],
            { connection: { strictToolLoop: true, stream: true } },
        );

        const onceRes = await service.runOnce({
            systemPrompt: '你是线外观察员。',
            prompt: '汇报码头现状',
        });

        expect(onceRes.text).toBe('### 码头简报\n\n夜班守卫已撤离。');
        expect(transport.requests[0].tools).toHaveLength(1);
        expect(transport.requests[0].tools[0].name).toBe('finish_turn');
        expect(transport.requests[0].tools[0].parameters.propertyOrdering).toEqual([
            'step_brief',
            'response',
        ]);
        expect(transport.requests[0].toolChoice).toEqual({
            mode: 'required',
            allowedToolNames: ['finish_turn'],
        });

        await service.createSession({
            id: 'side:strict-stream',
            title: '强约束支线',
            systemPrompt: '你是暗号联络人。',
        });

        const sendRes = await service.send('side:strict-stream', '灯塔情况如何？');
        expect(sendRes.text).toBe('支线密信：灯塔三楼暗门已开启。');
        expect(sendRes.text).not.toContain('抢跑');

        // Round 2 request received deferred finish_turn response & identical frozen tools
        expect(transport.requests).toHaveLength(3);
        expect(transport.requests[1].tools).toEqual(transport.requests[2].tools);
        const round2Deferred = transport.requests[2].messages.find(
            (m) => m.role === 'tool' && m.toolCallId === 'ft_mixed_jump',
        );
        expect(round2Deferred).toBeDefined();
        expect(JSON.parse(String(round2Deferred!.content)).deferred).toBe(true);

        // TrajectoryStore persisted ONLY clean [user, assistant] with ZERO finish_turn toolCalls/tool rows
        const layer1 = trajectoryStore.getMessages(toSideThreadId('side:strict-stream'));
        expect(layer1).toHaveLength(2);
        expect(layer1[0]).toEqual({ role: 'user', content: '灯塔情况如何？' });
        expect(layer1[1]).toEqual({
            role: 'assistant',
            content: '支线密信：灯塔三楼暗门已开启。',
            reasoningContent: '正式提交支线回复',
        });
        expect(layer1[1].toolCalls).toBeUndefined();

        const transcript = await service.getTranscript('side:strict-stream');
        expect(transcript).toEqual([
            { role: 'system', content: '你是暗号联络人。' },
            { role: 'user', content: '灯塔情况如何？' },
            { role: 'assistant', content: '支线密信：灯塔三楼暗门已开启。' },
        ]);
    });

    it('retries TOOL_CHOICE_VIOLATION, MALFORMED_TOOL_CALL, and mid-stream drops cleanly and honors roundMaxRetries=0', async () => {
        const { transport, service } = createSideGenHarness(
            [
                // Attempt 1: violates tool_choice: required
                { content: '纯文本违规输出' },
                // Attempt 2: malformed truncated tool JSON
                {
                    toolCalls: [
                        {
                            id: 'ft_broken',
                            name: 'finish_turn',
                            arguments: '{"step_brief":"broken","response":"截断残影',
                        },
                    ],
                    chunkSize: 5,
                },
                // Attempt 3: succeeds on 2nd retry
                {
                    toolCalls: [
                        {
                            id: 'ft_recovered',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '重试成功',
                                response: '单拍回滚重试后的干净输出。',
                            }),
                        },
                    ],
                },
            ],
            { connection: { strictToolLoop: true, roundMaxRetries: 2, stream: true } },
        );

        const res = await service.runOnce({ prompt: '重试测试' });
        expect(transport.requests).toHaveLength(3);
        expect(res.text).toBe('单拍回滚重试后的干净输出。');
        expect(res.text).not.toContain('截断残影');

        // Verify roundMaxRetries=0 disables retries immediately
        const { transport: noRetryTransport, service: noRetryService } = createSideGenHarness(
            [
                {
                    error: new LLMTransportError('Transient 503', { status: 503, retryable: true }),
                },
                {
                    toolCalls: [
                        {
                            id: 'ft_should_not_run',
                            name: 'finish_turn',
                            arguments: JSON.stringify({ step_brief: 'x', response: 'never' }),
                        },
                    ],
                },
            ],
            { connection: { strictToolLoop: true, roundMaxRetries: 0, stream: false } },
        );

        await expect(noRetryService.runOnce({ prompt: '禁用重试' })).rejects.toThrow(/Transient 503/);
        expect(noRetryTransport.requests).toHaveLength(1);
    });

    it('consumes and folds trailing partial:true and prefix:true Prefill messages in both runOnce and multi-round send()', async () => {
        // 1. Non-strict runOnce + send() with partial: true prefill
        const { transport: textTransport, trajectoryStore: textTrajectory, service: textService } =
            createSideGenHarness(
                [
                    { content: '码头东门无人看守。' },
                    { content: '第一轮续写完成。' },
                    { content: '第二轮续写完成。' },
                ],
                {
                    connection: { strictToolLoop: false, stream: false },
                    extraPromptBlocks: [
                        {
                            id: 'side_partial_tail',
                            name: 'SideGen Prefill',
                            role: 'custom',
                            placement: 'tail',
                            enabled: true,
                            triggers: ['sidegen'],
                            content: JSON.stringify({
                                role: 'assistant',
                                content: '【暗线】',
                                partial: true,
                            }),
                        },
                    ],
                },
            );

        const onceRes = await textService.runOnce({ prompt: '观察东门' });
        expect(onceRes.text).toBe('【暗线】码头东门无人看守。');
        const onceLast = textTransport.requests[0].messages[textTransport.requests[0].messages.length - 1];
        expect(onceLast.extraFields?.partial).toBe(true);

        await textService.createSession({
            id: 'side:prefill-text',
            title: '预填会话',
            systemPrompt: '系统提示',
        });
        const t1 = await textService.send('side:prefill-text', '第一轮');
        expect(t1.text).toBe('【暗线】第一轮续写完成。');

        const t2 = await textService.send('side:prefill-text', '第二轮');
        expect(t2.text).toBe('【暗线】第二轮续写完成。');

        // In Turn 2 request, NO middle message has partial: true (only the newly appended trailing tail prefill does)
        const turn2Msgs = textTransport.requests[2].messages;
        expect(
            turn2Msgs
                .slice(0, -1)
                .some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true),
        ).toBe(false);
        expect(
            textTrajectory
                .getMessages(toSideThreadId('side:prefill-text'))
                .some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true),
        ).toBe(false);

        // 2. Strict multi-round send() with prefix: true prefill -> round 2 must have zero prefix: true anywhere
        const { transport: strictTransport, service: strictService } = createSideGenHarness(
            [
                // Round 1: mixed tool call after prefix: true prefill
                {
                    content: '准备核查',
                    toolCalls: [
                        {
                            id: 'call_bad_side',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                        {
                            id: 'call_ft_side_defer',
                            name: 'finish_turn',
                            arguments: JSON.stringify({ step_brief: 'jump', response: 'jump' }),
                        },
                    ],
                },
                // Round 2: clean solo finish_turn
                {
                    toolCalls: [
                        {
                            id: 'call_ft_side_done',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: 'done',
                                response: '多轮折叠后正常完成。',
                            }),
                        },
                    ],
                },
            ],
            {
                connection: { strictToolLoop: true, stream: false },
                extraPromptBlocks: [
                    {
                        id: 'side_prefix_tail',
                        name: 'DeepSeek Prefix',
                        role: 'custom',
                        placement: 'tail',
                        enabled: true,
                        triggers: ['sidegen'],
                        content: JSON.stringify({
                            role: 'assistant',
                            content: '前置：',
                            prefix: true,
                        }),
                    },
                ],
            },
        );

        await strictService.createSession({
            id: 'side:prefill-strict',
            title: '强约束预填',
            systemPrompt: '系统提示',
        });
        const strictRes = await strictService.send('side:prefill-strict', '开始');
        expect(strictRes.text).toBe('多轮折叠后正常完成。');
        expect(strictTransport.requests).toHaveLength(2);

        const strictRound2Msgs = strictTransport.requests[1].messages;
        expect(
            strictRound2Msgs.some(
                (m) => m.extraFields?.prefix === true || m.extraFields?.partial === true,
            ),
        ).toBe(false);
        const foldedAssistant = strictRound2Msgs.find(
            (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'call_bad_side'),
        );
        expect(foldedAssistant?.content).toBe('前置：准备核查');
        expect(foldedAssistant?.extraFields).toBeUndefined();
    });

    it('applies user/assistant ingest and display regex across finish_turn.response, plain text, mainChatDepth, and /side/* bridges', async () => {
        const regexRules: RegexRule[] = [
            {
                id: 'rx_user_ooc',
                name: 'Strip user OOC',
                pattern: '/\\s*\\[OOC:[^\\]]*\\]/g',
                replace: '',
                stage: 'ingest',
                applyToUser: true,
                applyToAssistant: false,
                enabled: true,
            },
            {
                id: 'rx_asst_status',
                name: 'Strip assistant status',
                pattern: '/<!--\\s*status:[\\s\\S]*?-->/g',
                replace: '',
                stage: 'ingest',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'rx_asst_think_ingest',
                name: 'Strip think from history',
                pattern: '/<think>[\\s\\S]*?<\\/think>/g',
                replace: '',
                stage: 'ingest',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'rx_asst_think_display',
                name: 'Format think for display',
                pattern: '/<think>([\\s\\S]*?)<\\/think>/g',
                replace: '[思考($1) · {{user}}]',
                stage: 'display',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'rx_asst_status_display',
                name: 'Format status for display',
                pattern: '/<!--\\s*status:([\\s\\S]*?)\\s*-->/g',
                replace: '[状态:$1]',
                stage: 'display',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
        ];

        // 1. Strict finish_turn.response path (runOnce + persistent send + autoBridge)
        const { bridge, transport, trajectoryStore, settings, service } = createSideGenHarness(
            [
                // runOnce
                {
                    toolCalls: [
                        {
                            id: 'ft_rx_once',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '一次线外回复',
                                response: '<think>暗哨</think>码头安全。<!-- status:ok -->',
                            }),
                        },
                    ],
                },
                // session turn 1
                {
                    toolCalls: [
                        {
                            id: 'ft_rx_s1',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '首轮',
                                response: '<think>盘算</think>收到暗号。<!-- status:ready -->',
                            }),
                        },
                    ],
                },
                // session turn 2
                {
                    toolCalls: [
                        {
                            id: 'ft_rx_s2',
                            name: 'finish_turn',
                            arguments: JSON.stringify({
                                step_brief: '次轮',
                                response: '马上撤离。<!-- status:done -->',
                            }),
                        },
                    ],
                },
            ],
            {
                connection: { strictToolLoop: true, stream: false },
                regexRules,
            },
        );

        // Push a main-chat turn with OOC & status comment so mainChatDepth=2 also gets ingest-cleaned
        bridge.pushMessage({
            id: 2,
            name: 'User',
            isUser: true,
            mes: '检查码头[OOC: 测试]',
        });
        bridge.pushMessage({
            id: 3,
            name: 'Char',
            isUser: false,
            mes: '码头警戒中<!-- status:raw -->',
        });

        const onceRes = await service.runOnce({
            prompt: '确认东门[OOC: 忽略我]',
            mainChatDepth: 2,
            bridge: {
                path: '/side/notes/rx-once.md',
                delivery: 'radar_hint',
                keywords: ['东门'],
            },
        });

        // Returned result.text gets display regex (even tags stripped by ingest) + macro expansion
        expect(onceRes.text).toBe('[思考(暗哨) · 调查员]码头安全。[状态:ok]');
        const onceUserMsg = String(
            transport.requests[0].messages[transport.requests[0].messages.length - 1].content,
        );
        expect(onceUserMsg).toContain('确认东门');
        expect(onceUserMsg).not.toContain('[OOC:');
        expect(onceUserMsg).toContain('检查码头');
        expect(onceUserMsg).toContain('码头警戒中');
        expect(onceUserMsg).not.toContain('<!-- status:raw');

        // Bridged /side/* clue receives ingest-cleaned text (no display formatting, no raw status/think)
        const onceAnchor = { messageId: 3, swipeId: 0 };
        const bridgedOnce = await service.clues.read('/side/notes/rx-once.md', onceAnchor);
        expect(bridgedOnce?.body).toBe('码头安全。');

        await service.createSession({
            id: 'side:rx',
            title: '正则支线',
            systemPrompt: '线外规则',
            autoBridge: {
                path: '/side/comms/rx-session.md',
                delivery: 'next_turn_brief',
                keywords: ['暗号'],
                title: '正则对话记录',
                mode: 'append',
            },
        });

        const s1 = await service.send('side:rx', '暗号确认[OOC: 附注]');
        expect(s1.text).toBe('[思考(盘算) · 调查员]收到暗号。[状态:ready]');

        const threadId = toSideThreadId('side:rx');
        const layer1AfterT1 = trajectoryStore.getMessages(threadId);
        expect(layer1AfterT1).toHaveLength(2);
        expect(layer1AfterT1[0].content).toBe('暗号确认');
        expect(layer1AfterT1[1].content).toBe('收到暗号。');

        const bridgedSession = await service.clues.read('/side/comms/rx-session.md', onceAnchor);
        expect(bridgedSession?.body).toContain('- [调查员]: 暗号确认');
        expect(bridgedSession?.body).toContain('- [正则支线]: 收到暗号。');
        expect(bridgedSession?.body).not.toContain('[思考(');

        // Adding a late ingest rule MUST NOT mutate already-frozen Turn 1 messages in TrajectoryStore
        settings.presets[settings.currentPresetId].regexRules.push({
            id: 'rx_late_mask',
            name: 'Late mask',
            pattern: '暗号',
            replace: 'MASKED',
            stage: 'ingest',
            applyToUser: true,
            applyToAssistant: true,
            enabled: true,
        });

        const s2 = await service.send('side:rx', '新指令');
        expect(s2.text).toBe('马上撤离。[状态:done]');
        const turn2ReqMsgs = transport.requests[2].messages;
        expect(turn2ReqMsgs.some((m) => m.role === 'user' && m.content === '暗号确认')).toBe(true);
        expect(turn2ReqMsgs.some((m) => m.role === 'assistant' && m.content === '收到暗号。')).toBe(true);

        // 2. Non-strict plain-text mode also applies ingest + display regex
        const { trajectoryStore: plainTrajectory, service: plainService } = createSideGenHarness(
            [{ content: '<think>纯文本</think>完毕<!-- status:plain -->' }],
            {
                connection: { strictToolLoop: false, stream: false },
                regexRules,
            },
        );
        await plainService.createSession({
            id: 'side:rx-plain',
            title: '纯文本正则',
            systemPrompt: '系统',
        });
        const plainRes = await plainService.send('side:rx-plain', '你好[OOC: test]');
        expect(plainRes.text).toBe('[思考(纯文本) · 调查员]完毕[状态:plain]');
        const plainLayer1 = plainTrajectory.getMessages(toSideThreadId('side:rx-plain'));
        expect(plainLayer1[0].content).toBe('你好');
        expect(plainLayer1[1].content).toBe('完毕');
    });
});
