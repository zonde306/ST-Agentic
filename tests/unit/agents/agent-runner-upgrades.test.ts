import { describe, expect, it, vi } from 'vitest';
import {
    AgentExecutionError,
    AgentRunner,
    FINISH_TURN_TOOL_NAME,
    MaxToolRoundsError,
    TurnInterruptedError,
    type AgentGenerationErrorHookContext,
    type AgentPostprocessResponseContext,
    type AgentPreprocessMessagesContext,
} from '@/core/agents';
import type { HostBridge, LLMRequest, LLMResponse, LLMStreamChunk, LLMTransport } from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { LLMTransportError } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import type { ScriptSandbox } from '@/core/tools';
import type {
    AgentProfile,
    AgentRunTrace,
    ApiConnection,
    Preset,
    PromptTriggerType,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { OUTPUT_FILE_PATH } from '@/core/vfs';
import { IframeJsSandbox } from '@/sandbox';
import {
    MemoryHostBridge,
    ScriptedLLMTransport,
    type ScriptedTurnInput,
} from '../../mocks';

class FullRequestCapturingTransport implements LLMTransport {
    public readonly requests: LLMRequest[] = [];
    private readonly inner = new ScriptedLLMTransport();

    constructor(turns: ScriptedTurnInput[] = []) {
        for (const t of turns) {
            this.enqueue(t);
        }
    }

    enqueue(...turns: ScriptedTurnInput[]): this {
        for (const turn of turns) {
            if (typeof turn === 'function') {
                this.inner.enqueue((captured, idx) => turn(this.requests[idx] ?? captured, idx));
            } else {
                this.inner.enqueue(turn);
            }
        }
        return this;
    }

    private capture(request: LLMRequest): void {
        this.requests.push({
            connectionId: request.connectionId,
            connection: request.connection ? canonicalClone(request.connection) : undefined,
            messages: canonicalClone(request.messages),
            tools: canonicalClone(request.tools),
            cacheBreakpoints: request.cacheBreakpoints ? [...request.cacheBreakpoints] : undefined,
            toolChoice: request.toolChoice ? canonicalClone(request.toolChoice) : undefined,
            stream: request.stream,
            signal: request.signal,
        });
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        this.capture(request);
        return await this.inner.complete(request);
    }

    async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
        this.capture(request);
        yield* this.inner.stream(request);
    }
}

function makeUpgradeSetup(opts: {
    strictToolLoop?: boolean;
    roundMaxRetries?: number;
    maxToolRounds?: number;
    stream?: boolean;
    sessionMode?: 'persistent' | 'ephemeral';
    sandbox?: ScriptSandbox;
    preprocessScript?: Preset['preprocessScript'];
    postprocessScript?: Preset['postprocessScript'];
    extraConnections?: Record<string, ApiConnection>;
    sendIfEmpty?: string;
    skipInitialChat?: boolean;
    onPreprocessMessages?: (ctx: AgentPreprocessMessagesContext) => Promise<void> | void;
    onPostprocessResponse?: (ctx: AgentPostprocessResponseContext) => Promise<void> | void;
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: {
            userName: '沈默',
            charName: '林晚',
            characterAvatar: 'linwan.png',
            personaAvatar: 'shenmo.png',
        },
        characterFields: {
            description: '灰港调查员，擅长严谨取证。',
        },
    });
    if (opts.sendIfEmpty !== undefined) {
        (bridge as HostBridge).getSendIfEmpty = () => opts.sendIfEmpty!;
    }
    if (!opts.skipInitialChat) {
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '开始调查' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });
    }

    const conn = createDefaultConnection({
        id: 'conn_main',
        model: 'test-model',
        temperature: 0.7,
        maxTokens: 2048,
        stream: opts.stream ?? false,
        strictToolLoop: opts.strictToolLoop ?? false,
        roundMaxRetries: opts.roundMaxRetries ?? 2,
    });

    const mainAgent: AgentProfile = createDefaultMainAgent({
        id: 'main',
        connectionId: conn.id,
        sessionMode: opts.sessionMode ?? 'persistent',
        maxToolRounds: opts.maxToolRounds ?? 6,
        strictToolLoop: 'inherit',
        enabledTools: [
            'list_dir',
            'read_file',
            'write_file',
            'append_file',
            'edit_file',
            'read_variables',
            'patch_variables',
        ],
        permissions: {
            read: ['/**'],
            write: ['/memory/**', '/notes/**', '/state/variables.json', OUTPUT_FILE_PATH],
        },
    });

    const preset = createDefaultPreset({
        id: 'preset_upgrade',
        mainAgentId: 'main',
        agents: { main: mainAgent },
        ...(opts.preprocessScript ? { preprocessScript: opts.preprocessScript } : {}),
        ...(opts.postprocessScript ? { postprocessScript: opts.postprocessScript } : {}),
    });

    const settings = createDefaultSettings({
        connections: {
            [conn.id]: conn,
            ...(opts.extraConnections ?? {}),
        },
        currentConnectionId: conn.id,
        presets: { [preset.id]: preset },
        currentPresetId: preset.id,
    });

    const traceLogger = new TraceLogger({ maxTraces: 100 });
    const transport = new FullRequestCapturingTransport();
    const runner = new AgentRunner({
        bridge,
        transport,
        settings,
        traceLogger,
        sandbox: opts.sandbox,
        roundRetryInitialDelayMs: 0,
        roundRetryMaxDelayMs: 0,
        onPreprocessMessages: opts.onPreprocessMessages,
        onPostprocessResponse: opts.onPostprocessResponse,
    });

    return { bridge, conn, mainAgent, preset, settings, traceLogger, transport, runner };
}

describe('AgentRunner Wave 2 upgrades', () => {
    describe('1. assistantRounds interleaving & converged assistantSummary', () => {
        it('streams live assistantRounds into running traces and stores full untruncated plain-text assistantSummary (never /output.md)', async () => {
            const { transport, runner, traceLogger } = makeUpgradeSetup({ stream: true });
            await runner.vfs.writeFile('/notes/clue.md', '密室门后藏着银怀表。', {
                target: { messageId: 0, swipeId: 0 },
            });

            const liveRunningSnapshots: AgentRunTrace[] = [];
            traceLogger.subscribe((ev) => {
                if (ev.kind === 'trace_recorded' && ev.trace?.status === 'running') {
                    liveRunningSnapshots.push(canonicalClone(ev.trace));
                }
            });

            const longFinalSummary =
                '最终核对摘要：'.padEnd(320, '核验已完成且设定前后完全一致，不含任何剧透冲突。');
            expect(longFinalSummary.length).toBeGreaterThan(240);

            transport.enqueue(
                {
                    chunks: [
                        { type: 'reasoning_delta', reasoningDelta: '第一轮思考：' },
                        { type: 'reasoning_delta', reasoningDelta: '先读线索。' },
                        { type: 'text_delta', textDelta: '正在查阅线索文件。' },
                        {
                            type: 'tool_call_delta',
                            toolCallIndex: 0,
                            toolCallId: 'tc_r1',
                            toolName: 'read_file',
                            argumentsDelta: JSON.stringify({ path: '/notes/clue.md' }),
                        },
                        { type: 'done', finishReason: 'tool_calls' },
                    ],
                },
                {
                    chunks: [
                        { type: 'reasoning_delta', reasoningDelta: '第二轮思考：写入正文。' },
                        {
                            type: 'tool_call_delta',
                            toolCallIndex: 0,
                            toolCallId: 'tc_w1',
                            toolName: 'write_file',
                            argumentsDelta: JSON.stringify({
                                path: '/output.md',
                                content: '【正文内容，绝不应进入 assistantSummary】林晚拾起了银怀表。',
                            }),
                        },
                        { type: 'done', finishReason: 'tool_calls' },
                    ],
                },
                {
                    chunks: [
                        { type: 'reasoning_delta', reasoningDelta: '第三轮思考：收尾核对。' },
                        { type: 'text_delta', textDelta: longFinalSummary },
                        { type: 'done', finishReason: 'stop' },
                    ],
                },
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '查看线索并回复。',
            });

            // Live running trace captured incremental streaming reasoning/content before toolSteps executed
            expect(
                liveRunningSnapshots.some(
                    (t) =>
                        t.assistantRounds?.some(
                            (r) =>
                                r.roundIndex === 0
                                && r.beforeStepIndex === 0
                                && r.reasoning?.includes('第一轮思考：先读线索。')
                                && r.content === '正在查阅线索文件。',
                        ),
                ),
            ).toBe(true);

            // Final trace has all 3 rounds aligned with beforeStepIndex
            expect(res.trace.assistantRounds).toHaveLength(3);
            expect(res.trace.assistantRounds?.[0]).toMatchObject({
                roundIndex: 0,
                beforeStepIndex: 0,
                reasoning: '第一轮思考：先读线索。',
                content: '正在查阅线索文件。',
                isFinishTurn: false,
            });
            expect(res.trace.assistantRounds?.[1]).toMatchObject({
                roundIndex: 1,
                beforeStepIndex: 1,
                reasoning: '第二轮思考：写入正文。',
                isFinishTurn: false,
            });
            expect(res.trace.assistantRounds?.[2]).toMatchObject({
                roundIndex: 2,
                beforeStepIndex: 2,
                reasoning: '第三轮思考：收尾核对。',
                content: longFinalSummary,
                isFinishTurn: false,
            });

            // assistantSummary and outputPreview are synced, untruncated, and NEVER copy /output.md
            expect(res.content).toBe('【正文内容，绝不应进入 assistantSummary】林晚拾起了银怀表。');
            expect(res.trace.assistantSummary).toBe(longFinalSummary);
            expect(res.trace.outputPreview).toBe(longFinalSummary);
            expect(res.trace.assistantSummary).not.toContain('林晚拾起了银怀表');
        });

        it('converges assistantSummary across finish_turn main_output, side_effect, and return_value modes', async () => {
            // 1. main_output finish_turn: combines step_brief + non-empty round content, never /output.md
            const mainSetup = makeUpgradeSetup({ strictToolLoop: true });
            mainSetup.transport.enqueue(
                {
                    reasoningContent: '写正文到 /output.md',
                    content: '',
                    toolCalls: [
                        {
                            id: 'w_out',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '【正式叙事正文】夜雨敲打着码头的铁皮屋顶。',
                            }),
                        },
                    ],
                },
                {
                    reasoningContent: '正文已就绪，提交 finish_turn',
                    content: '补充说明：氛围与人物性格均已贴合。',
                    toolCalls: [
                        {
                            id: 'ft_main',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '已完成码头夜雨场景撰写。' }),
                        },
                    ],
                },
            );
            const mainRes = await mainSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '描写码头夜雨。',
            });
            expect(mainRes.content).toBe('【正式叙事正文】夜雨敲打着码头的铁皮屋顶。');
            expect(mainRes.trace.assistantSummary).toBe(
                '已完成码头夜雨场景撰写。\n\n补充说明：氛围与人物性格均已贴合。',
            );
            expect(mainRes.trace.assistantSummary).not.toContain('正式叙事正文');
            expect(mainRes.trace.outputPreview).toBe(mainRes.trace.assistantSummary);
            const mainFinishRound = mainRes.trace.assistantRounds?.find((r) => r.isFinishTurn);
            expect(mainFinishRound).toMatchObject({
                roundIndex: 1,
                beforeStepIndex: 1,
                isFinishTurn: true,
                finishTurnSummary: mainRes.trace.assistantSummary,
            });

            // 2. side_effect finish_turn: combines status + step_brief
            const sideSetup = makeUpgradeSetup({ strictToolLoop: true, sessionMode: 'ephemeral' });
            sideSetup.transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'pv_1',
                            name: 'patch_variables',
                            arguments: JSON.stringify({
                                scope: 'message',
                                json_merge: { alertness: 'high' },
                            }),
                        },
                    ],
                },
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'ft_side',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({
                                status: '已同步警戒状态',
                                step_brief: '将 alertness 更新为 high',
                            }),
                        },
                    ],
                },
            );
            const sideRes = await sideSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                promptTriggerContext: {
                    kind: 'trigger',
                    phase: 'after_turn',
                    targetPaths: ['/state/variables.json'],
                },
                userInput: '更新状态变量。',
            });
            expect(sideRes.trace.assistantSummary).toBe('已同步警戒状态\n将 alertness 更新为 high');
            expect(sideRes.trace.outputPreview).toBe('已同步警戒状态\n将 alertness 更新为 high');
            expect(sideRes.trace.assistantRounds?.at(-1)).toMatchObject({
                isFinishTurn: true,
                finishTurnSummary: '已同步警戒状态\n将 alertness 更新为 high',
            });

            // 3. return_value finish_turn: captures full response without 240-char truncation
            const retSetup = makeUpgradeSetup({ strictToolLoop: true, sessionMode: 'ephemeral' });
            const longReturn = '完整分析结论：'.padEnd(310, '所有证据链均指向三号仓库的走私账簿。');
            retSetup.transport.enqueue({
                content: '',
                toolCalls: [
                    {
                        id: 'ft_ret',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({
                            step_brief: '汇总调查结果',
                            response: longReturn,
                        }),
                    },
                ],
            });
            const retRes = await retSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'before_turn',
                userInput: '分析当前线索。',
            });
            expect(retRes.content).toBe(longReturn);
            expect(retRes.trace.assistantSummary).toBe(longReturn);
            expect(retRes.trace.outputPreview).toBe(longReturn);
            expect(retRes.trace.assistantRounds?.[0]).toMatchObject({
                isFinishTurn: true,
                finishTurnSummary: longReturn,
            });
        });

        it('keeps assistantSummary undefined when failing mid-tool-round while preserving intermediate assistantRounds', async () => {
            const { transport, runner } = makeUpgradeSetup({ roundMaxRetries: 0 });
            transport.enqueue(
                {
                    reasoningContent: '先写草稿到 /output.md',
                    content: '中间轮说明：正在落盘草稿。',
                    toolCalls: [
                        {
                            id: 'w_mid',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '已写入的部分正文内容。',
                            }),
                        },
                    ],
                },
                {
                    error: new LLMTransportError('Bad Request', { status: 400, retryable: false }),
                },
            );

            let caught: unknown;
            try {
                await runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'main_turn',
                    userInput: '开始写作。',
                });
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(TurnInterruptedError);
            const interrupted = caught as TurnInterruptedError;
            expect(interrupted.trace.assistantSummary).toBeUndefined();
            expect(interrupted.trace.assistantRounds).toHaveLength(1);
            expect(interrupted.trace.assistantRounds?.[0]).toMatchObject({
                roundIndex: 0,
                beforeStepIndex: 0,
                reasoning: '先写草稿到 /output.md',
                content: '中间轮说明：正在落盘草稿。',
                isFinishTurn: false,
            });
        });
    });

    describe('2. agentic_output_process writeback emits render events', () => {
        it('emits CHARACTER_MESSAGE_RENDERED on output_mutation and turn_finish /output.md writebacks in main_turn', async () => {
            const { bridge, transport, runner } = makeUpgradeSetup({ strictToolLoop: true });
            const emittedRenderEvents: unknown[] = [];
            const origEmit = bridge.emitHostEvent.bind(bridge);
            bridge.emitHostEvent = (event: string, payload?: unknown) => {
                if (event === 'CHARACTER_MESSAGE_RENDERED') {
                    emittedRenderEvents.push(payload);
                }
                origEmit(event, payload);
            };

            bridge.onOutputProcess((payload) => {
                if (payload.meta.stage === 'output_mutation') {
                    payload.text = `${payload.text} [MUTATED]`;
                } else if (payload.meta.stage === 'turn_finish') {
                    payload.text = `${payload.text} [FINALIZED]`;
                }
            });

            transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'w_render',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '初稿正文',
                            }),
                        },
                    ],
                },
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'ft_render',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '完成润色' }),
                        },
                    ],
                },
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '写出正文。',
            });

            expect(res.content).toBe('初稿正文 [MUTATED] [FINALIZED]');
            // Both agentic_output_process writebacks (output_mutation + turn_finish) emitted render events!
            expect(emittedRenderEvents.length).toBeGreaterThanOrEqual(2);
            expect(emittedRenderEvents.every((id) => id === 1)).toBe(true);
        });
    });

    describe('3. Phase-scoped checkpoints, previousRoundSnapshot, taskId & hasRollbackableRound', () => {
        it('records previousRoundSnapshot before each tool batch and persists composite checkpoints for main_turn, after_turn, and MaxToolRoundsError', async () => {
            const { transport, runner, traceLogger } = makeUpgradeSetup({
                roundMaxRetries: 0,
                maxToolRounds: 6,
            });

            // 1. main_turn: Round 1 writes /notes/a.md, Round 2 writes /notes/b.md + /output.md, Round 3 errors
            transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'm_r1',
                            name: 'write_file',
                            arguments: JSON.stringify({ path: '/notes/a.md', content: 'A1' }),
                        },
                    ],
                },
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'm_r2_note',
                            name: 'write_file',
                            arguments: JSON.stringify({ path: '/notes/b.md', content: 'B2' }),
                        },
                        {
                            id: 'm_r2_out',
                            name: 'write_file',
                            arguments: JSON.stringify({ path: '/output.md', content: '第二轮正文' }),
                        },
                    ],
                },
                {
                    error: new LLMTransportError('Upstream 400', { status: 400, retryable: false }),
                },
            );

            let mainErr: unknown;
            try {
                await runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'main_turn',
                    taskId: 'task_main_1',
                    userInput: '分步记录并输出。',
                });
            } catch (err) {
                mainErr = err;
            }

            expect(mainErr).toBeInstanceOf(TurnInterruptedError);
            const mainInt = mainErr as TurnInterruptedError;
            expect(mainInt.trace.taskId).toBe('task_main_1');
            expect(mainInt.trace.hasRollbackableRound).toBe(true);
            expect(mainInt.checkpoint.phase).toBe('main_turn');
            expect(mainInt.checkpoint.runId).toBe(mainInt.trace.runId);
            expect(mainInt.checkpoint.previousRoundSnapshot).toBeDefined();
            // Snapshot was captured BEFORE Round 2: /notes/a.md exists, /notes/b.md does NOT, outputText was ''
            const prevSnap = mainInt.checkpoint.previousRoundSnapshot!;
            expect(prevSnap.outputText).toBe('');
            expect(prevSnap.stagedSnapshot.files?.['notes/a.md']?.content).toBe('A1');
            expect(prevSnap.stagedSnapshot.files?.['notes/b.md']).toBeUndefined();
            expect(prevSnap.rolledBackToolSummary).toContain('write_file(/notes/b.md)');
            expect(prevSnap.rolledBackToolSummary).toContain('write_file(/output.md)');
            // Completed checkpoint has both rounds
            expect(mainInt.checkpoint.stagedSnapshot.files?.['notes/b.md']?.content).toBe('B2');
            expect(runner.trajectoryStore.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 })?.runId).toBe(
                mainInt.trace.runId,
            );

            // 2. after_turn trigger with completed tool round then failure -> throws AgentExecutionError (compatible!) AND persists scoped checkpoint
            transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'af_r1',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ scope: 'message', json_merge: { gold: 99 } }),
                        },
                    ],
                },
                {
                    error: new LLMTransportError('After-turn failed', { status: 400, retryable: false }),
                },
            );

            let afterErr: unknown;
            try {
                await runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    triggerId: 'trig_vars',
                    taskId: 'task_after_99',
                    checkpointScope: { phase: 'after_turn', triggerId: 'trig_vars' },
                    userInput: '更新金币变量。',
                });
            } catch (err) {
                afterErr = err;
            }

            expect(afterErr).toBeInstanceOf(AgentExecutionError);
            expect(afterErr).not.toBeInstanceOf(TurnInterruptedError);
            const afterExecErr = afterErr as AgentExecutionError;
            expect(afterExecErr.trace.taskId).toBe('task_after_99');
            expect(afterExecErr.trace.hasRollbackableRound).toBe(true);
            expect(afterExecErr.checkpoint).toBeDefined();
            expect(afterExecErr.checkpoint?.phase).toBe('after_turn');
            expect(afterExecErr.checkpoint?.triggerId).toBe('trig_vars');
            expect(afterExecErr.checkpoint?.previousRoundSnapshot?.rolledBackToolSummary).toBe(
                'patch_variables',
            );

            // Both main_turn and after_turn checkpoints coexist cleanly in TrajectoryStore!
            const storedAfterCp = runner.trajectoryStore.getInterruptedCheckpoint(
                { messageId: 1, swipeId: 0 },
                { phase: 'after_turn', triggerId: 'trig_vars' },
            );
            expect(storedAfterCp?.runId).toBe(afterExecErr.trace.runId);
            expect(runner.trajectoryStore.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 })?.runId).toBe(
                mainInt.trace.runId,
            );

            // 3. MaxToolRoundsError persists scoped checkpoint with previousRoundSnapshot
            const maxSetup = makeUpgradeSetup({ maxToolRounds: 1, roundMaxRetries: 0 });
            maxSetup.transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'max_1',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'max_2',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
            );
            let maxErr: unknown;
            try {
                await maxSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'before_turn',
                    triggerId: 'trig_before',
                    taskId: 'task_max',
                    userInput: '扫描目录。',
                });
            } catch (err) {
                maxErr = err;
            }
            expect(maxErr).toBeInstanceOf(MaxToolRoundsError);
            const maxTyped = maxErr as MaxToolRoundsError;
            expect(maxTyped.trace.hasRollbackableRound).toBe(true);
            expect(maxTyped.trace.taskId).toBe('task_max');
            expect(maxTyped.checkpoint?.phase).toBe('before_turn');
            expect(maxTyped.checkpoint?.triggerId).toBe('trig_before');
            expect(maxTyped.checkpoint?.previousRoundSnapshot?.rolledBackToolSummary).toBe('list_dir(/)');
            expect(
                maxSetup.runner.trajectoryStore.getInterruptedCheckpoint(
                    { messageId: 1, swipeId: 0 },
                    { phase: 'before_turn', triggerId: 'trig_before' },
                )?.runId,
            ).toBe(maxTyped.trace.runId);
            expect(traceLogger.listTraces().length).toBeGreaterThanOrEqual(2);
        });
    });

    describe('4. Preset preprocessScript & postprocessScript + external callbacks', () => {
        it('executes preset preprocessScript + onPreprocessMessages ephemerally without mutating TrajectoryStore or settings', async () => {
            const sandbox = new IframeJsSandbox();
            const observedLayers: unknown[] = [];

            const { transport, runner, conn } = makeUpgradeSetup({
                sandbox,
                preprocessScript: {
                    enabled: true,
                    code: `
                        ctx.messages.replaceContent(
                            (m) => m.role === 'user' && String(m.content).includes('秘密口令'),
                            (text) => text.replace('秘密口令', '[已脱敏]')
                        );
                        ctx.messages.appendHint('[Preprocess Hint] 保持克制叙事', 'user');
                        ctx.body.temperature = 0.25;
                        ctx.body.max_tokens = 1024;
                        ctx.body.seed = 42;
                    `,
                },
            });

            // Seed frozen Layer 1 history in TrajectoryStore to prove it is never mutated
            runner.trajectoryStore.appendTurn(
                [
                    { role: 'user', content: '历史消息包含 秘密口令' },
                    { role: 'assistant', content: '历史回复' },
                ],
                'main',
            );
            const frozenBefore = canonicalClone(runner.trajectoryStore.getMessages('main'));

            transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'w_pre',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '脱敏后生成的正文。',
                            }),
                        },
                    ],
                },
                {
                    content: '完成。',
                },
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '当前输入包含 秘密口令。',
                onPreprocessMessages: (ctx) => {
                    observedLayers.push(ctx.layers);
                    ctx.messages.appendHint('[External Callback Hint]', 'user');
                },
            });

            expect(res.content).toBe('脱敏后生成的正文。');
            expect(observedLayers.length).toBe(2);
            const req0 = transport.requests[0];
            expect(req0.messages.some((m) => String(m.content).includes('秘密口令'))).toBe(false);
            expect(req0.messages.some((m) => String(m.content).includes('[已脱敏]'))).toBe(true);
            expect(req0.messages.some((m) => String(m.content).includes('[Preprocess Hint]'))).toBe(true);
            expect(req0.messages.some((m) => String(m.content).includes('[External Callback Hint]'))).toBe(true);
            expect(req0.connection?.temperature).toBe(0.25);
            expect(req0.connection?.maxTokens).toBe(1024);
            expect(req0.connection?.includeBody).toMatchObject({ seed: 42 });

            // Original settings connection and frozen Layer 1 messages MUST remain untouched!
            expect(conn.temperature).toBe(0.7);
            expect(conn.maxTokens).toBe(2048);
            expect(conn.includeBody).toEqual({});
            const storedAfter = runner.trajectoryStore.getMessages('main');
            expect(storedAfter.slice(0, 2)).toEqual(frozenBefore);
            expect(String(storedAfter[2].content)).toContain('秘密口令');
            expect(JSON.stringify(storedAfter)).not.toContain('[Preprocess Hint]');
            expect(JSON.stringify(storedAfter)).not.toContain('[External Callback Hint]');
        });

        it('honors trigger filters on preprocessScript and supports input.sandbox override', async () => {
            const perRunSandbox = new IframeJsSandbox();
            const triggers: PromptTriggerType[] = ['trigger_after'];
            const { transport, runner } = makeUpgradeSetup({
                preprocessScript: {
                    enabled: true,
                    triggers,
                    code: `ctx.messages.appendHint('[AFTER_ONLY_HINT]');`,
                },
            });

            transport.enqueue(
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'w_skip',
                            name: 'write_file',
                            arguments: JSON.stringify({ path: '/output.md', content: 'main ok' }),
                        },
                    ],
                },
                { content: 'done' },
                { content: 'after ok' },
            );

            await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '主生成',
                sandbox: perRunSandbox,
            });
            expect(
                transport.requests[0].messages.some((m) => String(m.content).includes('[AFTER_ONLY_HINT]')),
            ).toBe(false);

            await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '后置触发',
                sandbox: perRunSandbox,
            });
            const afterReq = transport.requests[transport.requests.length - 1];
            expect(
                afterReq.messages.some((m) => String(m.content).includes('[AFTER_ONLY_HINT]')),
            ).toBe(true);
        });

        it('executes postprocessScript to rewrite content/reasoning/toolCalls, trigger retry (bounded), and trigger requestFix (bounded)', async () => {
            // 1. Rewrite content, reasoningContent, and toolCalls via postprocessScript return object & in-place edit
            const sandbox = new IframeJsSandbox();
            const rewriteSetup = makeUpgradeSetup({
                sandbox,
                postprocessScript: {
                    enabled: true,
                    code: `
                        if (ctx.event.round === 1) {
                            return {
                                content: '改写后的中间说明',
                                reasoningContent: '改写后的思考',
                                toolCalls: [{
                                    id: 'tc_rewritten',
                                    name: 'write_file',
                                    arguments: JSON.stringify({ path: '/output.md', content: '后处理注入的正文' })
                                }]
                            };
                        }
                        ctx.output.text = ctx.output.text.replace('[BAD]', '[CLEAN]');
                    `,
                },
            });

            rewriteSetup.transport.enqueue(
                {
                    reasoningContent: '原始思考',
                    content: '原始文本（原本没有工具调用）',
                },
                {
                    content: '结果包含 [BAD] 标记',
                },
            );

            const rewriteRes = await rewriteSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '测试后处理改写。',
            });

            expect(rewriteRes.content).toBe('后处理注入的正文');
            expect(rewriteRes.toolSteps).toHaveLength(1);
            expect(rewriteRes.toolSteps[0].toolCallId).toBe('tc_rewritten');
            expect(rewriteRes.trace.assistantRounds?.[0]).toMatchObject({
                reasoning: '改写后的思考',
                content: '改写后的中间说明',
            });
            expect(rewriteRes.trace.assistantSummary).toBe('结果包含 [CLEAN] 标记');

            // 2. control.retry(reason) respects roundMaxRetries ceiling
            const retrySetup = makeUpgradeSetup({
                sandbox,
                roundMaxRetries: 2,
                postprocessScript: {
                    enabled: true,
                    code: `
                        if (ctx.output.text.includes('FORBIDDEN')) {
                            ctx.control.retry('包含违禁词');
                        }
                    `,
                },
            });
            retrySetup.transport.enqueue(
                { content: '尝试1 FORBIDDEN' },
                { content: '尝试2 FORBIDDEN' },
                { content: '尝试3 FORBIDDEN（耗尽上限后放行）' },
            );
            const retryRes = await retrySetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '测试重试上限。',
            });
            expect(retrySetup.transport.requests).toHaveLength(3);
            expect(retryRes.trace.retryCount).toBe(2);
            expect(retryRes.content).toBe('尝试3 FORBIDDEN（耗尽上限后放行）');

            // 3. control.requestFix(feedback) loops into next round and honors maxFixAttempts ceiling
            const fixSetup = makeUpgradeSetup({
                sandbox,
                postprocessScript: {
                    enabled: true,
                    code: `
                        if (!ctx.output.text.includes('[FIXED]')) {
                            ctx.control.requestFix('请在回复中包含 [FIXED] 标记');
                        }
                    `,
                },
            });
            fixSetup.transport.enqueue(
                { content: '第一次未达标' },
                (req) => {
                    const lastMsg = req.messages[req.messages.length - 1];
                    expect(lastMsg.role).toBe('user');
                    expect(String(lastMsg.content)).toContain('请在回复中包含 [FIXED] 标记');
                    return { content: '修正完成 [FIXED]' };
                },
            );
            const fixRes = await fixSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '输出带标记内容。',
            });
            expect(fixRes.rounds).toBe(2);
            expect(fixRes.content).toBe('修正完成 [FIXED]');

            // 4. In-place mutation via custom ScriptSandbox / onPostprocessResponse callback
            const customSandbox: ScriptSandbox = {
                evaluateSchema: sandbox.evaluateSchema.bind(sandbox),
                compileCustomTools: sandbox.compileCustomTools.bind(sandbox),
                async evaluateScript(_code, ctx) {
                    const out = ctx.output as unknown as {
                        content: string;
                        reasoningContent?: string;
                    };
                    out.content = 'in-place content';
                    out.reasoningContent = 'in-place reasoning';
                },
            };
            const inPlaceSetup = makeUpgradeSetup({
                sandbox: customSandbox,
                postprocessScript: { enabled: true, code: '// mock' },
            });
            inPlaceSetup.transport.enqueue({ content: 'orig', reasoningContent: 'orig r' });
            const inPlaceRes = await inPlaceSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: 'in-place test',
                onPostprocessResponse: (ctx) => {
                    ctx.output.content = `${ctx.output.content} + cb`;
                },
            });
            expect(inPlaceRes.content).toBe('in-place content + cb');
            expect(inPlaceRes.reasoningContent).toBe('in-place reasoning');

            // 5. preprocessScript sanitizes orphan tool messages & postprocessScript handles tool-round requestFix + abort cleanly
            const sanitizePreSetup = makeUpgradeSetup({
                sandbox,
                preprocessScript: {
                    enabled: true,
                    code: `
                        const list = ctx.messages.list();
                        list.push({ role: 'tool', toolCallId: 'orphan_pre', toolName: 'read_file', content: 'broken' });
                        ctx.messages.set(list);
                    `,
                },
                postprocessScript: {
                    enabled: true,
                    code: `
                        if (ctx.event.round === 1) {
                            ctx.control.requestFix('不要在第一轮调用该工具，请直接回复。');
                        }
                    `,
                },
            });
            sanitizePreSetup.transport.enqueue(
                (req) => {
                    expect(req.messages.some((m) => m.toolCallId === 'orphan_pre')).toBe(false);
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'tc_rejected_by_post',
                                name: 'list_dir',
                                arguments: JSON.stringify({ path: '/' }),
                            },
                        ],
                    };
                },
                (req) => {
                    // Rejected tool call from round 1 MUST NOT appear as unpaired tool_calls in round 2!
                    expect(
                        req.messages.some((m) =>
                            m.toolCalls?.some((tc) => tc.id === 'tc_rejected_by_post'),
                        ),
                    ).toBe(false);
                    expect(String(req.messages[req.messages.length - 1].content)).toContain(
                        '不要在第一轮调用该工具',
                    );
                    return { content: '直接回复完成。' };
                },
            );
            const sanitizePreRes = await sanitizePreSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '测试预处理清洗与工具轮自纠。',
            });
            expect(sanitizePreRes.content).toBe('直接回复完成。');
            expect(sanitizePreRes.toolSteps).toHaveLength(0);

            // 6. postprocessScript control.abort() stops immediately without retrying
            const abortPostSetup = makeUpgradeSetup({
                sandbox,
                roundMaxRetries: 2,
                postprocessScript: {
                    enabled: true,
                    code: `ctx.control.abort('后处理主动终止');`,
                },
            });
            abortPostSetup.transport.enqueue({ content: 'ignored' });
            await expect(
                abortPostSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    userInput: 'post abort test',
                }),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(abortPostSetup.transport.requests).toHaveLength(1);

            // 7. When postprocessScript requestFix hits maxFixAttempts ceiling, downstream processOutputText still runs on final output
            const fixExhaustedSetup = makeUpgradeSetup({
                sandbox,
                postprocessScript: {
                    enabled: true,
                    code: `ctx.control.requestFix('永远要求再修正一次');`,
                },
            });
            const processOutputCalls: string[] = [];
            fixExhaustedSetup.bridge.onOutputProcess((payload) => {
                processOutputCalls.push(payload.text);
                payload.text = `${payload.text} [PROCESS_OUTPUT_APPLIED]`;
            });
            // DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS === 3 -> rounds 1..3 enter fix loop, round 4 hits ceiling & must run processOutputText!
            fixExhaustedSetup.transport.enqueue(
                { content: 'draft 1' },
                { content: 'draft 2' },
                { content: 'draft 3' },
                { content: 'draft 4 final' },
            );
            const fixExhaustedRes = await fixExhaustedSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '测试 requestFix 耗尽上限后继续走输出校验。',
            });
            expect(fixExhaustedRes.rounds).toBe(4);
            expect(processOutputCalls).toEqual(['draft 4 final']);
            expect(fixExhaustedRes.content).toBe('draft 4 final [PROCESS_OUTPUT_APPLIED]');
        });
    });

    describe('5. onGenerationError recovery hook & ephemeral rollback', () => {
        it('rolls back unarchived tool round ephemerally, applies connection/param overrides, and never pollutes TrajectoryStore', async () => {
            const fallbackConn = createDefaultConnection({
                id: 'conn_fallback',
                model: 'fallback-safe-model',
                temperature: 0.9,
                maxTokens: 4096,
                stream: false,
            });
            const { transport, runner, settings } = makeUpgradeSetup({
                roundMaxRetries: 0,
                extraConnections: { [fallbackConn.id]: fallbackConn },
            });

            // Seed frozen Layer 1 history
            runner.trajectoryStore.appendTurn(
                [
                    { role: 'user', content: '冻结的历史消息' },
                    { role: 'assistant', content: '冻结的历史回复' },
                ],
                'main',
            );
            const frozenBefore = canonicalClone(runner.trajectoryStore.getMessages('main'));

            let seenHookCtx: AgentGenerationErrorHookContext | undefined;

            transport.enqueue(
                // Round 1: calls list_dir
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_bad_round',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
                // Round 2 attempt 1: fails with non-retryable HTTP 400 content_filter
                {
                    error: new LLMTransportError('Filtered by upstream safety policy', {
                        status: 400,
                        code: 'content_filter',
                        responseBody: '{"error":{"code":"content_filter"}}',
                        retryable: false,
                    }),
                },
                // Round 2 attempt 2 (after recovery rollback + fallbackConn override): writes /output.md
                (req) => {
                    expect(req.connectionId).toBe('conn_fallback');
                    expect(req.connection?.model).toBe('fallback-safe-model');
                    expect(req.connection?.temperature).toBe(0.2);
                    expect(req.connection?.maxTokens).toBe(1536);
                    // Rolled-back tc_bad_round tool call and tool result MUST NOT exist in retry messages!
                    expect(
                        req.messages.some((m) => m.toolCallId === 'tc_bad_round' || m.toolCalls?.some((tc) => tc.id === 'tc_bad_round')),
                    ).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('换一种更稳妥的表述'))).toBe(
                        true,
                    );
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'tc_safe_write',
                                name: 'write_file',
                                arguments: JSON.stringify({
                                    path: '/output.md',
                                    content: '绕过错误后的稳妥正文。',
                                }),
                            },
                        ],
                    };
                },
                // Round 3: finish cleanly
                (req) => {
                    // Turn messages were also aligned when rollbackToolRounds ran, so tc_bad_round is gone in Round 3 too
                    expect(
                        req.messages.some((m) => m.toolCallId === 'tc_bad_round'),
                    ).toBe(false);
                    return { content: '恢复成功并完成。' };
                },
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '执行可能触发过滤的任务。',
                onGenerationError: async (ctx) => {
                    seenHookCtx = ctx;
                    const rolled = ctx.ephemeralMessages.rollbackToolRounds(1);
                    expect(rolled).toBe(1);
                    ctx.ephemeralMessages.appendHint('换一种更稳妥的表述重试。', 'user');
                    return {
                        action: 'retry',
                        reason: 'rollback_and_switch_model',
                        connectionId: 'conn_fallback',
                        temperature: 0.2,
                        maxTokens: 1536,
                    };
                },
            });

            expect(seenHookCtx?.error).toEqual({
                name: 'LLMTransportError',
                message: 'Filtered by upstream safety policy',
                status: 400,
                code: 'content_filter',
                rawBody: '{"error":{"code":"content_filter"}}',
            });
            expect(Object.isFrozen(seenHookCtx?.error)).toBe(true);
            expect(res.content).toBe('绕过错误后的稳妥正文。');

            // Original Layer 1 frozen history and fallback connection settings remain untouched
            expect(runner.trajectoryStore.getMessages('main').slice(0, 2)).toEqual(frozenBefore);
            expect(settings.connections.conn_fallback.temperature).toBe(0.9);
            expect(settings.connections.conn_fallback.maxTokens).toBe(4096);
        });

        it('handles action=abort, action=pass, maxErrorRecoveryAttempts limit, orphan tool sanitization, and isErrorRecovery recursion guard', async () => {
            // 1. action: 'abort' stops immediately without retrying
            const abortSetup = makeUpgradeSetup({ roundMaxRetries: 0 });
            abortSetup.transport.enqueue({
                error: new LLMTransportError('Forbidden', { status: 403, retryable: false }),
            });
            const abortHook = vi.fn(async () => ({ action: 'abort' as const, reason: '风控拦截，主动中止' }));
            await expect(
                abortSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    userInput: 'abort test',
                    onGenerationError: abortHook,
                }),
            ).rejects.toMatchObject({ name: 'AbortError' });
            expect(abortHook).toHaveBeenCalledTimes(1);
            expect(abortSetup.traceLogger.listTraces({ limit: 1 })[0].status).toBe('aborted');

            // 2. action: 'pass' falls through to normal error handling
            const passSetup = makeUpgradeSetup({ roundMaxRetries: 0 });
            passSetup.transport.enqueue({
                error: new LLMTransportError('400 Invalid', { status: 400, retryable: false }),
            });
            await expect(
                passSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    userInput: 'pass test',
                    onGenerationError: async () => ({ action: 'pass' }),
                }),
            ).rejects.toThrow(AgentExecutionError);

            // 3. isErrorRecovery: true skips onGenerationError completely
            const guardSetup = makeUpgradeSetup({ roundMaxRetries: 0 });
            guardSetup.transport.enqueue({
                error: new LLMTransportError('400 Nested', { status: 400, retryable: false }),
            });
            const guardHook = vi.fn(async () => ({ action: 'retry' as const }));
            await expect(
                guardSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    userInput: 'nested recovery',
                    isErrorRecovery: true,
                    onGenerationError: guardHook,
                }),
            ).rejects.toThrow(AgentExecutionError);
            expect(guardHook).not.toHaveBeenCalled();

            // 4. decision.messages sanitizes orphan tool messages & respects maxErrorRecoveryAttempts=1
            const sanitizeSetup = makeUpgradeSetup({ roundMaxRetries: 0 });
            sanitizeSetup.transport.enqueue(
                { error: new LLMTransportError('400 First', { status: 400, retryable: false }) },
                (req) => {
                    // Orphan role: 'tool' must have been stripped by sanitizeToolCallPairs!
                    expect(req.messages.some((m) => m.role === 'tool')).toBe(false);
                    expect(req.messages.some((m) => String(m.content) === 'Clean prompt')).toBe(true);
                    throw new LLMTransportError('400 Second', { status: 400, retryable: false });
                },
            );
            const sanitizeHook = vi.fn(async () => ({
                action: 'retry' as const,
                messages: [
                    { role: 'user' as const, content: 'Clean prompt' },
                    { role: 'tool' as const, toolCallId: 'orphan_1', toolName: 'read_file', content: 'orphan' },
                ],
            }));
            await expect(
                sanitizeSetup.runner.run({
                    agent: 'main',
                    target: { messageId: 1, swipeId: 0 },
                    phase: 'after_turn',
                    userInput: 'sanitize test',
                    maxErrorRecoveryAttempts: 1,
                    onGenerationError: sanitizeHook,
                }),
            ).rejects.toThrow(AgentExecutionError);
            expect(sanitizeHook).toHaveBeenCalledTimes(1);
        });

        it('keeps rolled-back tool rounds removed across transient retries and preserves accurate turnStart after dropHistoryTurns for subsequent rollbackToolRounds', async () => {
            // Regression 2a + 2b combined:
            // Layer 1 has 2 historical turns (4 messages).
            // Round 1 executes list_dir (in-flight tool round).
            // Round 2 attempt 1 -> HTTP 400 -> Recovery #1 drops 2 history turns (4 Layer 1 msgs) -> shifts turnStart cleanly.
            // Round 2 attempt 2 -> HTTP 400 -> Recovery #2 rolls back 1 tool round (must return 1, NOT 0, and must NOT drop current user turn!).
            // Round 2 attempt 3 -> HTTP 502 transient error -> built-in retry runs -> Round 2 attempt 4 MUST still exclude rolled-back tool call and dropped history!
            const { transport, runner } = makeUpgradeSetup({
                roundMaxRetries: 1,
            });
            runner.trajectoryStore.appendTurn(
                [
                    { role: 'user', content: '历史回合1用户' },
                    { role: 'assistant', content: '历史回合1回复' },
                ],
                'main',
            );
            runner.trajectoryStore.appendTurn(
                [
                    { role: 'user', content: '历史回合2用户' },
                    { role: 'assistant', content: '历史回合2回复' },
                ],
                'main',
            );
            const frozenBefore = canonicalClone(runner.trajectoryStore.getMessages('main'));

            const recoveryLog: Array<{ attempt: number; dropped?: number; rolledBack?: number }> = [];

            transport.enqueue(
                // Round 1: calls list_dir
                {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_r1_rollback_target',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                },
                // Round 2 attempt 1: 400 -> triggers Recovery #1 (dropHistoryTurns(2))
                {
                    error: new LLMTransportError('400 Too noisy', { status: 400, retryable: false }),
                },
                // Round 2 attempt 2: 400 -> triggers Recovery #2 (rollbackToolRounds(1))
                (req) => {
                    expect(req.messages.some((m) => String(m.content).includes('历史回合1用户'))).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('历史回合2用户'))).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('当前轮指令'))).toBe(true);
                    expect(req.messages.some((m) => m.toolCallId === 'tc_r1_rollback_target')).toBe(true);
                    throw new LLMTransportError('400 Tool call rejected', { status: 400, retryable: false });
                },
                // Round 2 attempt 3: 502 retryable -> triggers built-in transient retry
                (req) => {
                    expect(req.messages.some((m) => m.toolCallId === 'tc_r1_rollback_target')).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('当前轮指令'))).toBe(true);
                    throw new LLMTransportError('502 Bad Gateway', { status: 502, retryable: true });
                },
                // Round 2 attempt 4 (after transient retry): MUST NOT resurrect rolled-back tool call or dropped history!
                (req) => {
                    expect(
                        req.messages.some(
                            (m) =>
                                m.toolCallId === 'tc_r1_rollback_target'
                                || m.toolCalls?.some((tc) => tc.id === 'tc_r1_rollback_target'),
                        ),
                    ).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('历史回合1用户'))).toBe(false);
                    expect(req.messages.some((m) => String(m.content).includes('当前轮指令'))).toBe(true);
                    return { content: '双重恢复加瞬时重试后成功收尾。' };
                },
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '当前轮指令：请核查状态。',
                maxErrorRecoveryAttempts: 2,
                onGenerationError: async (ctx) => {
                    if (ctx.attempt === 1) {
                        const dropped = ctx.ephemeralMessages.dropHistoryTurns(2);
                        recoveryLog.push({ attempt: 1, dropped });
                        return { action: 'retry', reason: 'drop_old_history' };
                    }
                    const rolledBack = ctx.ephemeralMessages.rollbackToolRounds(1);
                    recoveryLog.push({ attempt: 2, rolledBack });
                    return { action: 'retry', reason: 'rollback_in_flight_tool' };
                },
            });

            expect(recoveryLog).toEqual([
                { attempt: 1, dropped: 2 },
                { attempt: 2, rolledBack: 1 },
            ]);
            expect(res.content).toBe('双重恢复加瞬时重试后成功收尾。');
            // TrajectoryStore Layer 1 history MUST remain completely intact!
            expect(runner.trajectoryStore.getMessages('main').slice(0, 4)).toEqual(frozenBefore);
        });
    });

    describe('6. Empty input + trailing Assistant message role legality fallback', () => {
        it('uses bridge.getSendIfEmpty() when configured and falls back to lightweight user prompt when empty', async () => {
            // Case A: bridge.getSendIfEmpty() configured
            const setupConfigured = makeUpgradeSetup({
                skipInitialChat: true,
                sendIfEmpty: '请继续自然推进接下来的剧情。',
            });
            setupConfigured.bridge.pushMessage({
                id: 0,
                name: '林晚',
                isUser: false,
                mes: '开场白：雾气笼罩着灰港三号码头。',
                swipeId: 0,
            });
            setupConfigured.bridge.pushMessage({
                id: 1,
                name: '林晚',
                isUser: false,
                mes: '',
                swipeId: 0,
            });

            setupConfigured.transport.enqueue(
                (req) => {
                    const lastMsg = req.messages[req.messages.length - 1];
                    expect(lastMsg.role).toBe('user');
                    expect(String(lastMsg.content)).toContain('请继续自然推进接下来的剧情。');
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'w_empty_1',
                                name: 'write_file',
                                arguments: JSON.stringify({
                                    path: '/output.md',
                                    content: '新楼层剧情：汽笛声从浓雾深处传来。',
                                }),
                            },
                        ],
                    };
                },
                { content: '已完成新楼层推进。' },
            );

            const resConfigured = await setupConfigured.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                generationAction: 'normal',
                userInput: '',
            });
            expect(resConfigured.content).toBe('新楼层剧情：汽笛声从浓雾深处传来。');

            // Case B: bridge.getSendIfEmpty() returns '' -> injects lightweight default user prompt
            const setupDefault = makeUpgradeSetup({
                skipInitialChat: true,
                sendIfEmpty: '',
            });
            setupDefault.bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '你好' });
            setupDefault.bridge.pushMessage({
                id: 1,
                name: '林晚',
                isUser: false,
                mes: '你好，我在码头等你。',
                swipeId: 0,
            });
            setupDefault.bridge.pushMessage({
                id: 2,
                name: '林晚',
                isUser: false,
                mes: '',
                swipeId: 0,
            });
            setupDefault.runner.trajectoryStore.appendTurn(
                [
                    { role: 'user', content: '你好' },
                    { role: 'assistant', content: '你好，我在码头等你。' },
                ],
                'main',
            );

            setupDefault.transport.enqueue(
                (req) => {
                    const lastMsg = req.messages[req.messages.length - 1];
                    expect(lastMsg.role).toBe('user');
                    expect(String(lastMsg.content).trim().length).toBeGreaterThan(0);
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'w_empty_2',
                                name: 'write_file',
                                arguments: JSON.stringify({
                                    path: '/output.md',
                                    content: '林晚抬起头，望向远处的灯塔。',
                                }),
                            },
                        ],
                    };
                },
                { content: '推进完成。' },
            );

            const resDefault = await setupDefault.runner.run({
                agent: 'main',
                target: { messageId: 2, swipeId: 0 },
                phase: 'main_turn',
                generationAction: 'normal',
                userInput: '',
            });
            expect(resDefault.content).toBe('林晚抬起头，望向远处的灯塔。');

            // Case C: preceding chat message IS a user message -> must NOT inject fallback prompt
            const setupUserPrev = makeUpgradeSetup({
                sendIfEmpty: '不应被注入的兜底提示',
            });
            setupUserPrev.transport.enqueue(
                (req) => {
                    expect(
                        req.messages.some((m) => String(m.content).includes('不应被注入的兜底提示')),
                    ).toBe(false);
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'w_user_prev',
                                name: 'write_file',
                                arguments: JSON.stringify({
                                    path: '/output.md',
                                    content: '正常回复。',
                                }),
                            },
                        ],
                    };
                },
                { content: 'ok' },
            );
            await setupUserPrev.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                generationAction: 'normal',
                userInput: '',
            });
        });
    });
});
