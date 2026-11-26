import { describe, expect, it } from 'vitest';
import {
    AgentExecutionError,
    AgentRunner,
    FINISH_TURN_TOOL_NAME,
    resolveStrictToolLoop,
} from '@/core/agents';
import type { LLMRequest, LLMResponse, LLMStreamChunk, LLMTransport } from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { TraceLogger } from '@/core/logger';
import type {
    AgentProfile,
    GenerationEventPayload,
    PromptBlock,
    RoundRetryLog,
    StrictToolLoopOverride,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';
import { AgenticCapsuleElement } from '@/ui/capsule/AgenticCapsuleElement';
import { AppStore, createMockUIServices } from '@/ui/store';
import {
    assertAppendOnlyPrefix,
    MemoryHostBridge,
    ScriptedLLMTransport,
    type ScriptedTurnInput,
} from '../../mocks';

/**
 * Thin wrapper around `ScriptedLLMTransport` that preserves `request.toolChoice`
 * (since `ScriptedLLMTransport.captureRequest` does not yet clone `toolChoice`).
 */
class ToolChoiceCapturingTransport implements LLMTransport {
    public readonly requests: LLMRequest[] = [];
    private readonly inner = new ScriptedLLMTransport();

    enqueue(...turns: ScriptedTurnInput[]): this {
        for (const turn of turns) {
            if (typeof turn === 'function') {
                this.inner.enqueue((capturedReq, callIdx) => {
                    const fullReq = this.requests[callIdx] ?? capturedReq;
                    return turn(fullReq, callIdx);
                });
            } else {
                this.inner.enqueue(turn);
            }
        }
        return this;
    }

    private record(request: LLMRequest): void {
        this.requests.push({
            connectionId: request.connectionId,
            connection: request.connection ? canonicalClone(request.connection) : undefined,
            messages: canonicalClone(request.messages),
            tools: canonicalClone(request.tools),
            cacheBreakpoints: request.cacheBreakpoints ? [...request.cacheBreakpoints] : undefined,
            toolChoice: request.toolChoice
                ? {
                    mode: request.toolChoice.mode,
                    ...(request.toolChoice.allowedToolNames
                        ? { allowedToolNames: [...request.toolChoice.allowedToolNames] }
                        : {}),
                }
                : undefined,
            stream: request.stream,
            signal: request.signal,
        });
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        this.record(request);
        return await this.inner.complete(request);
    }

    async *stream(request: LLMRequest): AsyncIterable<LLMStreamChunk> {
        this.record(request);
        yield* this.inner.stream(request);
    }
}

function makeStrictSetup(opts: {
    connectionStrict?: boolean;
    agentStrict?: StrictToolLoopOverride;
    roundMaxRetries?: number;
    maxToolRounds?: number;
    enabledTools?: string[];
    extraPromptBlocks?: PromptBlock[];
    sessionMode?: 'persistent' | 'ephemeral';
    stream?: boolean;
    roundRetryInitialDelayMs?: number;
    roundRetryMaxDelayMs?: number;
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
    bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '开始调查' });
    bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

    const conn = createDefaultConnection({
        id: 'conn_strict',
        model: 'gemini-2.5-pro',
        stream: opts.stream ?? true,
        strictToolLoop: opts.connectionStrict ?? true,
        roundMaxRetries: opts.roundMaxRetries ?? 2,
    });

    const baseAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: conn.id,
        sessionMode: opts.sessionMode ?? 'persistent',
        maxToolRounds: opts.maxToolRounds ?? 6,
        strictToolLoop: opts.agentStrict ?? 'inherit',
        enabledTools: opts.enabledTools ?? [
            'list_dir',
            'grep_search',
            'read_file',
            'write_file',
            'append_file',
            'edit_file',
        ],
        permissions: {
            read: ['/**'],
            write: ['/memory/**', '/notes/**', '/state/variables.json'],
        },
    });

    const mainAgent: AgentProfile = opts.extraPromptBlocks
        ? {
            ...baseAgent,
            promptBlocks: [...baseAgent.promptBlocks, ...opts.extraPromptBlocks],
        }
        : baseAgent;

    const preset = createDefaultPreset({
        id: 'preset_strict',
        mainAgentId: 'main',
        agents: { main: mainAgent },
    });

    const settings = createDefaultSettings({
        connections: { [conn.id]: conn },
        currentConnectionId: conn.id,
        presets: { [preset.id]: preset },
        currentPresetId: preset.id,
    });

    const traceLogger = new TraceLogger({ maxTraces: 100 });
    const transport = new ToolChoiceCapturingTransport();
    const runner = new AgentRunner({
        bridge,
        transport,
        settings,
        traceLogger,
        roundRetryInitialDelayMs: opts.roundRetryInitialDelayMs ?? 0,
        roundRetryMaxDelayMs: opts.roundRetryMaxDelayMs ?? 0,
    });

    return { bridge, conn, mainAgent, preset, settings, traceLogger, transport, runner };
}

describe('AgentRunner strictToolLoop, Prefill folding & round auto-retry', () => {
    it('resolves strictToolLoop override precedence cleanly', () => {
        expect(resolveStrictToolLoop({ strictToolLoop: 'on' }, { strictToolLoop: false })).toBe(true);
        expect(resolveStrictToolLoop({ strictToolLoop: 'off' }, { strictToolLoop: true })).toBe(false);
        expect(resolveStrictToolLoop({ strictToolLoop: 'inherit' }, { strictToolLoop: true })).toBe(true);
        expect(resolveStrictToolLoop({ strictToolLoop: 'inherit' }, { strictToolLoop: false })).toBe(false);
        expect(resolveStrictToolLoop({}, { strictToolLoop: true })).toBe(true);
        expect(resolveStrictToolLoop({}, { strictToolLoop: undefined })).toBe(false);
    });

    it('enforces empty /output.md gate, fallback rejection, _turn_state receipts, and Layer 0 tools + prefix invariance', async () => {
        const { bridge, transport, runner } = makeStrictSetup({ maxToolRounds: 3 });

        transport.enqueue(
            // Round 1: /output.md is empty -> finish_turn excluded from allowedToolNames,
            // yet model calls finish_turn anyway (multi-tool fallback) -> rejected!
            (req) => {
                const finishSchema = req.tools.find((t) => t.name === FINISH_TURN_TOOL_NAME);
                expect(finishSchema).toBeDefined();
                expect(finishSchema?.description).toBe(
                    'Complete the current turn and submit the final result.',
                );
                expect(finishSchema?.parameters.propertyOrdering).toEqual(['step_brief']);
                expect(req.toolChoice?.mode).toBe('required');
                expect(req.toolChoice?.allowedToolNames).not.toContain(FINISH_TURN_TOOL_NAME);
                expect(req.toolChoice?.allowedToolNames).toContain('write_file');

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_premature_finish',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '试图提前交卷' }),
                        },
                    ],
                };
            },
            // Round 2: sees rejection + _turn_state(output_ready: false) -> writes /output.md
            (req) => {
                const lastToolMsg = req.messages[req.messages.length - 1];
                expect(lastToolMsg.role).toBe('tool');
                const parsed = JSON.parse(String(lastToolMsg.content)) as {
                    ok: boolean;
                    error: string;
                    _turn_state: { round: string; output_ready: boolean };
                };
                expect(parsed.ok).toBe(false);
                expect(parsed.error).toContain('/output.md is still empty');
                expect(parsed._turn_state).toEqual({ round: '1/3', output_ready: false });
                expect(req.toolChoice?.allowedToolNames).not.toContain(FINISH_TURN_TOOL_NAME);

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_write_out',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '灯塔顶层铁门缓缓打开。',
                            }),
                        },
                    ],
                };
            },
            // Round 3: /output.md is now non-empty -> finish_turn is allowed & completes cleanly
            (req) => {
                const lastToolMsg = req.messages[req.messages.length - 1];
                expect(lastToolMsg.role).toBe('tool');
                const parsed = JSON.parse(String(lastToolMsg.content)) as {
                    _turn_state: { round: string; output_ready: boolean };
                };
                expect(parsed._turn_state).toEqual({ round: '2/3', output_ready: true });
                expect(req.toolChoice?.mode).toBe('required');
                expect(req.toolChoice?.allowedToolNames).toContain(FINISH_TURN_TOOL_NAME);

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'call_final_finish',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '已完成灯塔剧情写入。' }),
                        },
                    ],
                };
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '推开灯塔顶层的门。',
        });

        expect(res.content).toBe('灯塔顶层铁门缓缓打开。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '灯塔顶层铁门缓缓打开。',
        );
        expect(res.rounds).toBe(3);

        // Layer 0 request.tools & append-only prefix invariance across all rounds
        expect(transport.requests).toHaveLength(3);
        const tools0 = canonicalStringify(transport.requests[0].tools);
        const tools1 = canonicalStringify(transport.requests[1].tools);
        const tools2 = canonicalStringify(transport.requests[2].tools);
        expect(tools1).toBe(tools0);
        expect(tools2).toBe(tools0);
        assertAppendOnlyPrefix(transport.requests[0], transport.requests[1]);
        assertAppendOnlyPrefix(transport.requests[1], transport.requests[2]);

        // Finalized durable history ends with clean assistant text (no pseudo finish_turn tool call)
        const storedMessages = runner.trajectoryStore.getMessages('main');
        const lastStored = storedMessages[storedMessages.length - 1];
        expect(lastStored.role).toBe('assistant');
        expect(lastStored.toolCalls).toBeUndefined();
        expect(lastStored.content).toBe('已完成灯塔剧情写入。');
    });

    it('breaks repeated read-only loops by warning, excluding repeated tools, and shrinking allowedToolNames to write tools + finish_turn', async () => {
        const { transport, runner } = makeStrictSetup({ maxToolRounds: 6 });
        await runner.vfs.writeFile('/notes/clue.md', '暗门钥匙藏在壁炉灰烬下。', {
            target: { messageId: 0, swipeId: 0 },
        });

        transport.enqueue(
            // Round 1: first read_file(clue) -> count 1
            (req) => {
                expect(req.toolChoice?.allowedToolNames).toContain('read_file');
                expect(req.toolChoice?.allowedToolNames).toContain('list_dir');
                expect(req.toolChoice?.allowedToolNames).toContain('grep_search');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'r1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/notes/clue.md' }),
                        },
                    ],
                };
            },
            // Round 2: identical read_file(clue) -> count 2 -> warning + read_file excluded next round
            () => ({
                content: '',
                toolCalls: [
                    {
                        id: 'r2',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/notes/clue.md' }),
                    },
                ],
            }),
            // Round 3: read_file is excluded from allowedToolNames; model repeats read_file anyway
            // (2nd consecutive duplicate-only read round) -> triggers full shrink to write tools!
            (req) => {
                const lastToolMsg = req.messages[req.messages.length - 1];
                expect(String(lastToolMsg.content)).toContain('Repeated identical read-only call');
                expect(req.toolChoice?.allowedToolNames).not.toContain('read_file');
                expect(req.toolChoice?.allowedToolNames).toContain('list_dir');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'r3',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/notes/clue.md' }),
                        },
                    ],
                };
            },
            // Round 4: shrunk strictly to write tools (all read-only tools excluded; finish_turn excluded since /output.md empty)
            (req) => {
                const allowed = req.toolChoice?.allowedToolNames ?? [];
                expect(allowed).not.toContain('read_file');
                expect(allowed).not.toContain('list_dir');
                expect(allowed).not.toContain('grep_search');
                expect(allowed).not.toContain(FINISH_TURN_TOOL_NAME);
                expect(allowed).toContain('write_file');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'w1',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '我从壁炉灰烬下取出了暗门钥匙。',
                            }),
                        },
                    ],
                };
            },
            // Round 5: finish_turn now allowed
            (req) => {
                expect(req.toolChoice?.allowedToolNames).toContain(FINISH_TURN_TOOL_NAME);
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'fin1',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '写入钥匙线索结果。' }),
                        },
                    ],
                };
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '找出暗门钥匙。',
        });

        expect(res.content).toBe('我从壁炉灰烬下取出了暗门钥匙。');
        // Layer 0 tools remained completely frozen throughout shrinking
        const baseTools = canonicalStringify(transport.requests[0].tools);
        for (const req of transport.requests) {
            expect(canonicalStringify(req.tools)).toBe(baseTools);
        }
    });

    it('folds trailing partial: true and prefix: true assistant Prefill before round 2 without leaving transient flags', async () => {
        for (const flagKey of ['partial', 'prefix'] as const) {
            const prefillBlock: PromptBlock = {
                id: `prefill_${flagKey}`,
                name: `Prefill (${flagKey})`,
                role: 'custom',
                placement: 'tail',
                enabled: true,
                content: JSON.stringify({
                    role: 'assistant',
                    content: '好的，我先',
                    [flagKey]: true,
                }),
            };

            const { transport, runner } = makeStrictSetup({
                extraPromptBlocks: [prefillBlock],
                roundMaxRetries: 2,
            });
            await runner.vfs.writeFile('/notes/prefill.md', '预填测试文件内容', {
                target: { messageId: 0, swipeId: 0 },
            });

            transport.enqueue(
                // Attempt 1 on Round 1: fails with TOOL_CHOICE_VIOLATION -> prefill MUST stay intact for retry!
                (req) => {
                    const lastMsg = req.messages[req.messages.length - 1];
                    expect(lastMsg.role).toBe('assistant');
                    expect(lastMsg.content).toBe('好的，我先');
                    expect(lastMsg.extraFields?.[flagKey]).toBe(true);
                    return { content: '不小心直接吐了纯文本' };
                },
                // Attempt 2 on Round 1: still sees exact prefill at tail, now calls read_file
                (req) => {
                    const lastMsg = req.messages[req.messages.length - 1];
                    expect(lastMsg.role).toBe('assistant');
                    expect(lastMsg.content).toBe('好的，我先');
                    expect(lastMsg.extraFields?.[flagKey]).toBe(true);
                    return {
                        content: '查阅笔记。',
                        toolCalls: [
                            {
                                id: `read_${flagKey}`,
                                name: 'read_file',
                                arguments: JSON.stringify({ path: '/notes/prefill.md' }),
                            },
                        ],
                    };
                },
                // Round 2: prefill placeholder folded into assistant message & ZERO transient flags in history;
                // floating prefill re-attached cleanly at the very end without leaving partial/prefix mid-history!
                (req) => {
                    const hasAnyMidHistoryTransientFlag = req.messages
                        .slice(0, -1)
                        .some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true);
                    expect(hasAnyMidHistoryTransientFlag).toBe(false);
                    expect(req.messages[req.messages.length - 1].extraFields?.[flagKey]).toBe(true);

                    const assistantCallMsg = req.messages.find(
                        (m) => m.role === 'assistant' && Boolean(m.toolCalls?.length),
                    );
                    expect(assistantCallMsg?.content).toBe('好的，我先查阅笔记。');

                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: `write_${flagKey}`,
                                name: 'write_file',
                                arguments: JSON.stringify({
                                    path: '/output.md',
                                    content: `已完成 ${flagKey} 折叠测试。`,
                                }),
                            },
                        ],
                    };
                },
                // Round 3: finish_turn
                () => ({
                    content: '',
                    toolCalls: [
                        {
                            id: `fin_${flagKey}`,
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 'done' }),
                        },
                    ],
                }),
            );

            const res = await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '检查笔记并写结果。',
            });

            expect(res.content).toBe(`已完成 ${flagKey} 折叠测试。`);
            const stored = runner.trajectoryStore.getMessages('main');
            expect(
                stored.some((m) => m.extraFields?.partial === true || m.extraFields?.prefix === true),
            ).toBe(false);
        }
    });

    it('rolls back streaming preview and retries cleanly on TOOL_CHOICE_VIOLATION, MALFORMED_TOOL_CALL, EMPTY_RESPONSE, and stream drops with zero turnMessages pollution', async () => {
        const { transport, traceLogger, runner } = makeStrictSetup({
            roundMaxRetries: 3,
            stream: true,
        });

        const events: GenerationEventPayload[] = [];
        traceLogger.subscribe((ev) => events.push(ev));
        const previews: string[] = [];

        transport.enqueue(
            // Attempt 1: TOOL_CHOICE_VIOLATION (plain text when mode === 'required')
            { content: '我拒绝调工具，直接纯文本停工。' },
            // Attempt 2: MALFORMED_TOOL_CALL (streams dirty /output.md preview then ends with broken JSON)
            {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'tc_bad_json',
                        toolName: 'write_file',
                        argumentsDelta: '{"path":"/output.md","content":"脏流式残影',
                    },
                    {
                        type: 'done',
                        finishReason: 'stop',
                    },
                ],
            },
            // Attempt 3: EMPTY_RESPONSE (empty text, 0 tool calls)
            { content: '   ' },
            // Attempt 4 (retry 3/3): clean write_file("/output.md")
            (req) => {
                // Verify zero pollution from all 3 failed attempts in request.messages
                const serialized = JSON.stringify(req.messages);
                expect(serialized).not.toContain('我拒绝调工具');
                expect(serialized).not.toContain('脏流式残影');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_clean_write',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '干净重试后成功生成的最终正文。',
                            }),
                        },
                    ],
                };
            },
            // Round 2: finish_turn
            () => ({
                content: '',
                toolCalls: [
                    {
                        id: 'tc_finish',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: '写入完成。' }),
                    },
                ],
            }),
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '写出正文。',
            onOutputPreview: (p) => previews.push(p),
        });

        expect(res.content).toBe('干净重试后成功生成的最终正文。');

        const retryEvents = events.filter((e) => e.kind === 'turn_retrying');
        expect(retryEvents).toHaveLength(3);
        expect(retryEvents.map((e) => e.retryReason)).toEqual([
            'TOOL_CHOICE_VIOLATION',
            'MALFORMED_TOOL_CALL',
            'EMPTY_RESPONSE',
        ]);
        expect(retryEvents.map((e) => e.retryAttempt)).toEqual([1, 2, 3]);
        expect(retryEvents.every((e) => e.retryMaxAttempts === 3)).toBe(true);

        // Preview saw dirty text, then rolled back to committed '' before final clean preview
        const dirtyIdx = previews.findIndex((p) => p.includes('脏流式残影'));
        expect(dirtyIdx).toBeGreaterThanOrEqual(0);
        expect(previews[dirtyIdx + 1]).toBe('');
        expect(previews[previews.length - 1]).toBe('干净重试后成功生成的最终正文。');
    });

    it('supports Form C return-value finish_turn (even with empty enabledTools), defers mixed-round finish_turn, and Form B side-effect targetPaths gate', async () => {
        // 1. Form C (before_turn / return-value mode) with empty enabledTools
        const setupC = makeStrictSetup({
            enabledTools: [],
            sessionMode: 'persistent',
        });

        const streamedReturnDeltas: string[] = [];
        setupC.transport.enqueue((req) => {
            expect(req.tools.map((t) => t.name)).toEqual([FINISH_TURN_TOOL_NAME]);
            const schema = req.tools[0];
            expect(schema.parameters.propertyOrdering).toEqual(['step_brief', 'response']);
            expect(req.toolChoice).toEqual({
                mode: 'required',
                allowedToolNames: [FINISH_TURN_TOOL_NAME],
            });
            return {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'fin_c',
                        toolName: FINISH_TURN_TOOL_NAME,
                        argumentsDelta: '{"step_brief":"汇总线索","response":"简报：',
                    },
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        argumentsDelta: '暗格密码为 3719。"}',
                    },
                    { type: 'done', finishReason: 'tool_calls' },
                ],
            };
        });

        const resC = await setupC.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'before_turn',
            userInput: '总结当前线索。',
            onTextDelta: (d) => streamedReturnDeltas.push(d),
        });

        expect(resC.content).toBe('简报：暗格密码为 3719。');
        expect(streamedReturnDeltas.join('')).toBe('简报：暗格密码为 3719。');
        const storedC = setupC.runner.trajectoryStore.getMessages('main');
        expect(storedC.some((m) => m.toolCalls?.some((tc) => tc.name === FINISH_TURN_TOOL_NAME))).toBe(false);
        expect(storedC[storedC.length - 1]).toMatchObject({
            role: 'assistant',
            content: '简报：暗格密码为 3719。',
        });

        // 2. Form C mixed round [read_file, finish_turn] defers finish_turn until next round
        const setupMixed = makeStrictSetup({
            enabledTools: ['read_file'],
            sessionMode: 'ephemeral',
        });
        await setupMixed.runner.vfs.writeFile('/notes/doc.md', '真实坐标：北纬 31 度', {
            target: { messageId: 0, swipeId: 0 },
        });
        setupMixed.transport.enqueue(
            () => ({
                content: '',
                toolCalls: [
                    {
                        id: 'm_read',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/notes/doc.md' }),
                    },
                    {
                        id: 'm_fin_early',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({
                            step_brief: '抢跑',
                            response: '胡乱猜测的坐标',
                        }),
                    },
                ],
            }),
            (req) => {
                const deferredMsg = req.messages.find(
                    (m) => m.role === 'tool' && m.toolCallId === 'm_fin_early',
                );
                expect(String(deferredMsg?.content)).toContain('"deferred":true');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'm_fin_real',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({
                                step_brief: '读取后正式回复',
                                response: '坐标是北纬 31 度。',
                            }),
                        },
                    ],
                };
            },
        );

        const resMixed = await setupMixed.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'before_turn',
            userInput: '查坐标。',
        });
        expect(resMixed.content).toBe('坐标是北纬 31 度。');

        // 3. Form B (side-effect trigger with targetPaths) suppresses finish_turn on round 1 before write
        const setupB = makeStrictSetup({
            enabledTools: ['read_file', 'write_file'],
            sessionMode: 'ephemeral',
        });
        setupB.transport.enqueue(
            (req) => {
                const finishSchema = req.tools.find((t) => t.name === FINISH_TURN_TOOL_NAME);
                expect(finishSchema).toBeDefined();
                const props = finishSchema?.parameters.properties as Record<string, unknown>;
                expect(props).toHaveProperty('step_brief');
                expect(props).toHaveProperty('status');
                expect(props).not.toHaveProperty('response');
                expect(req.toolChoice?.allowedToolNames).not.toContain(FINISH_TURN_TOOL_NAME);

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'b_write',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/notes/summary.md',
                                content: '更新后的笔记',
                            }),
                        },
                    ],
                };
            },
            (req) => {
                expect(req.toolChoice?.allowedToolNames).toContain(FINISH_TURN_TOOL_NAME);
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'b_fin',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({
                                step_brief: '已更新笔记',
                                status: 'updated /notes/summary.md',
                            }),
                        },
                    ],
                };
            },
        );

        const resB = await setupB.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            promptTriggerContext: {
                kind: 'trigger',
                phase: 'after_turn',
                targetPaths: ['/notes/summary.md'],
            },
            userInput: '更新总结笔记。',
        });
        expect(resB.content).toBe('updated /notes/summary.md');
    });

    it('tries clean rollback retry on non-strict main_turn refusal and respects roundMaxRetries = 0', async () => {
        // Non-strict refusal -> clean rollback retry (no [System Check] pollution on retry 1) -> heals
        const setupRefusal = makeStrictSetup({
            connectionStrict: false,
            roundMaxRetries: 2,
        });
        const retryEvents: GenerationEventPayload[] = [];
        setupRefusal.traceLogger.subscribe((e) => {
            if (e.kind === 'turn_retrying') {
                retryEvents.push(e);
            }
        });

        setupRefusal.transport.enqueue(
            { content: '抱歉，我无法满足该请求。' },
            (req) => {
                expect(JSON.stringify(req.messages)).not.toContain('抱歉，我无法满足该请求');
                expect(JSON.stringify(req.messages)).not.toContain('[System Check]');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'refusal_heal',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '重试后正常生成的故事正文。',
                            }),
                        },
                    ],
                };
            },
            { content: '核对完成。' },
        );

        const healed = await setupRefusal.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '继续故事。',
        });
        expect(healed.content).toBe('重试后正常生成的故事正文。');
        expect(retryEvents).toHaveLength(1);

        // roundMaxRetries: 0 disables retries completely
        const setupNoRetry = makeStrictSetup({
            connectionStrict: true,
            roundMaxRetries: 0,
        });
        setupNoRetry.transport.enqueue({ content: '违例纯文本' });
        await expect(
            setupNoRetry.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '测试不重试。',
            }),
        ).rejects.toBeInstanceOf(AgentExecutionError);
        expect(setupNoRetry.transport.requests).toHaveLength(1);
    });

    it('updates AgenticCapsuleElement state on turn_retrying and auto-recovers on next stream event', () => {
        const listeners = new Set<(event: GenerationEventPayload) => void>();
        const services = {
            ...createMockUIServices(),
            subscribeEvents: (listener: (event: GenerationEventPayload) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const store = new AppStore({
            services,
            initialTraces: [],
            initialBackgroundTasks: [],
        });

        const capsule = new AgenticCapsuleElement();
        const disconnect = capsule.connectStore(store, { messageId: 2, swipeId: 0 });

        const emit = (event: GenerationEventPayload) => {
            for (const listener of listeners) {
                listener(event);
            }
        };

        emit({
            kind: 'turn_retrying',
            target: { messageId: 2, swipeId: 0 },
            timestamp: Date.now(),
            retryAttempt: 1,
            retryMaxAttempts: 2,
            retryDelayMs: 1200,
            retryReason: 'TOOL_CHOICE_VIOLATION',
        });

        expect(capsule.getState().status).toBe('retrying');
        expect(capsule.getState().retryAttempt).toBe(1);
        expect(capsule.getState().retryMaxAttempts).toBe(2);
        expect(capsule.getState().retryReason).toBe('TOOL_CHOICE_VIOLATION');

        // Unrelated swipe event must NOT disturb this capsule
        emit({
            kind: 'output_preview',
            target: { messageId: 2, swipeId: 1 },
            timestamp: Date.now(),
            outputPreview: 'other swipe',
        });
        expect(capsule.getState().status).toBe('retrying');

        // Matching stream chunk auto-recovers capsule back to streaming
        emit({
            kind: 'output_preview',
            target: { messageId: 2, swipeId: 0 },
            timestamp: Date.now(),
            outputPreview: '正常续写正文',
        });
        expect(capsule.getState().status).toBe('streaming');
        expect(capsule.getState().retryAttempt).toBeUndefined();

        disconnect();
        store.dispose();
    });

    it('rolls back mid-stream write_file drop, allows closing finish_turn at maxToolRounds, and aborts during retry backoff', async () => {
        // 1. Mid-stream network error during write_file + closing finish_turn at exact maxToolRounds = 1
        const setup = makeStrictSetup({
            maxToolRounds: 1,
            roundMaxRetries: 2,
            stream: true,
        });
        const events: GenerationEventPayload[] = [];
        setup.traceLogger.subscribe((e) => events.push(e));
        const previews: string[] = [];

        setup.transport.enqueue(
            {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'w_drop',
                        toolName: 'write_file',
                        argumentsDelta: '{"path":"/output.md","content":"半截断流残影',
                    },
                ],
                error: new Error('SSE connection dropped'),
                errorAfterChunks: 1,
            },
            () => ({
                content: '',
                toolCalls: [
                    {
                        id: 'w_ok',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '断流重试后的完整正文。',
                        }),
                    },
                ],
            }),
            (req) => {
                // At toolRoundsExecuted === maxToolRounds (1/1) with /output.md ready, allowedToolNames narrows to finish_turn
                expect(req.toolChoice).toEqual({
                    mode: 'required',
                    allowedToolNames: [FINISH_TURN_TOOL_NAME],
                });
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'fin_at_max',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '在最后一拍顺利交卷。' }),
                        },
                    ],
                };
            },
        );

        const res = await setup.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '测试断流重试与最后一拍交卷。',
            onOutputPreview: (p) => previews.push(p),
        });

        expect(res.content).toBe('断流重试后的完整正文。');
        expect(events.filter((e) => e.kind === 'turn_retrying')).toHaveLength(1);
        const dropIdx = previews.findIndex((p) => p.includes('半截断流残影'));
        expect(dropIdx).toBeGreaterThanOrEqual(0);
        expect(previews[dropIdx + 1]).toBe('');
        expect(previews[previews.length - 1]).toBe('断流重试后的完整正文。');

        // 2. AbortSignal cancels immediately during retry backoff delay
        const abortSetup = makeStrictSetup({
            roundMaxRetries: 2,
            roundRetryInitialDelayMs: 5_000,
            roundRetryMaxDelayMs: 10_000,
        });
        const controller = new AbortController();
        abortSetup.traceLogger.subscribe((ev) => {
            if (ev.kind === 'turn_retrying') {
                controller.abort('User cancelled retry');
            }
        });
        abortSetup.transport.enqueue({ content: '违例纯文本触发退避' });

        await expect(
            abortSetup.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '测试取消重试退避。',
                signal: controller.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(abortSetup.transport.requests).toHaveLength(1);
    });

    it('preserves Layer 0 EJS and Track B custom JSON prefix invariance across multi-round ephemeral runs', async () => {
        const ejsPrefixBlocks: PromptBlock[] = [
            {
                id: 'ejs_std_prefix',
                name: 'Standard EJS Prefix',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content: '当前调查模式：<%= investigationMode %>',
            },
            {
                id: 'ejs_track_b_prefix',
                name: 'Track B Custom Tool Demo',
                role: 'custom',
                placement: 'prefix',
                enabled: true,
                content: '<% if (includeDemo) { %>[{"role":"user","content":"示范查询"},{"role":"assistant","content":"","tool_calls":[{"name":"read_file","arguments":{"path":"/notes/demo.md"}}]},{"role":"tool","content":"示范结果"}]<% } %>',
            },
        ];

        const { bridge, transport, runner } = makeStrictSetup({
            sessionMode: 'ephemeral',
            enabledTools: ['read_file'],
            extraPromptBlocks: ejsPrefixBlocks,
        });

        let ejsCallCount = 0;
        bridge.setEjsEvaluator((text, vars) => {
            ejsCallCount += 1;
            if (text.includes('<%= investigationMode %>')) {
                return text.replace('<%= investigationMode %>', String(vars.investigationMode ?? ''));
            }
            if (text.includes('<% if (includeDemo) { %>')) {
                return vars.includeDemo
                    ? '[{"role":"user","content":"示范查询"},{"role":"assistant","content":"","tool_calls":[{"name":"read_file","arguments":{"path":"/notes/demo.md"}}]},{"role":"tool","content":"示范结果"}]'
                    : '';
            }
            return text;
        });

        await runner.vfs.writeFile('/notes/fact.md', '关键档案：守夜人徽章编号 42。', {
            target: { messageId: 0, swipeId: 0 },
        });

        transport.enqueue(
            // Round 1: read_file
            (req) => {
                const serialized = JSON.stringify(req.messages);
                expect(serialized).toContain('当前调查模式：深度取证');
                expect(serialized).not.toContain('<%=');
                expect(serialized).toContain('示范查询');
                expect(serialized).toContain('示范结果');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'eph_read_1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/notes/fact.md' }),
                        },
                    ],
                };
            },
            // Round 2: reassembleInFlight() MUST keep identical evaluated EJS + Track B prefix messages!
            (req) => {
                const serialized = JSON.stringify(req.messages);
                expect(serialized).toContain('当前调查模式：深度取证');
                expect(serialized).not.toContain('<%=');
                expect(serialized).toContain('示范查询');
                expect(serialized).toContain('示范结果');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'eph_fin_1',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({
                                step_brief: '读取档案完成',
                                response: '徽章编号是 42。',
                            }),
                        },
                    ],
                };
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'before_turn',
            userInput: '查询守夜人徽章编号。',
            vars: {
                investigationMode: '深度取证',
                includeDemo: true,
            },
        });

        expect(res.content).toBe('徽章编号是 42。');
        expect(transport.requests).toHaveLength(2);
        // Byte-for-byte append-only KV-cache prefix invariance from Round 1 to Round 2
        assertAppendOnlyPrefix(transport.requests[0], transport.requests[1]);
        // Prefix EJS blocks evaluated once at run start (no redundant re-evaluation in assembleWithHost/Round 2)
        expect(ejsCallCount).toBe(2);
    });

    it('emits _turn_state.round without /Infinity and avoids forced finish_turn narrowing when maxToolRounds=0', async () => {
        const { transport, runner } = makeStrictSetup({ maxToolRounds: 0 });

        transport.enqueue(
            // Round 1: list_dir
            (req) => {
                expect(req.toolChoice?.mode).toBe('required');
                expect(req.toolChoice?.allowedToolNames).toContain('list_dir');
                expect(req.toolChoice?.allowedToolNames).not.toContain(FINISH_TURN_TOOL_NAME);
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'u_list_1',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                };
            },
            // Round 2: receives round='1' (no '/Infinity'), writes /output.md
            (req) => {
                const lastToolMsg = req.messages[req.messages.length - 1];
                const parsed = JSON.parse(String(lastToolMsg.content)) as {
                    _turn_state: { round: string; output_ready: boolean };
                };
                expect(parsed._turn_state).toEqual({ round: '1', output_ready: false });
                expect(parsed._turn_state.round).not.toContain('Infinity');

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'u_write_2',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '无限轮次严格闭环测试正文。',
                            }),
                        },
                    ],
                };
            },
            // Round 3: receives round='2', /output.md is ready, toolChoice still keeps write/edit tools alongside finish_turn
            (req) => {
                const lastToolMsg = req.messages[req.messages.length - 1];
                const parsed = JSON.parse(String(lastToolMsg.content)) as {
                    _turn_state: { round: string; output_ready: boolean };
                };
                expect(parsed._turn_state).toEqual({ round: '2', output_ready: true });
                expect(parsed._turn_state.round).not.toContain('Infinity');
                expect(req.toolChoice?.mode).toBe('required');
                expect(req.toolChoice?.allowedToolNames).toContain(FINISH_TURN_TOOL_NAME);
                expect(req.toolChoice?.allowedToolNames).toContain('write_file');
                expect(req.toolChoice?.allowedToolNames).toContain('edit_file');

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'u_finish_3',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: '无限轮次模式下顺利交卷。' }),
                        },
                    ],
                };
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '验证无限轮次严格工具闭环状态回执。',
        });

        expect(res.content).toBe('无限轮次严格闭环测试正文。');
        expect(transport.requests).toHaveLength(3);
    });

    it('applies ingest regex once to /output.md write_file arguments in TrajectoryStore without mutating raw /output.md or breaking KV cache', async () => {
        const { bridge, transport, settings, runner } = makeStrictSetup({
            stream: false,
        });
        const preset = settings.presets[settings.currentPresetId];
        preset.regexRules = [
            {
                id: 'ingest_strip_trace',
                name: 'Strip assistant inline trace',
                pattern: '/<!--\\s*trace:[^>]*-->/g',
                replace: '',
                stage: 'ingest',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'display_fold_think',
                name: 'Fold think for DOM only',
                pattern: '/<think>([\\s\\S]*?)<\\/think>/g',
                replace: '[折叠:$1]',
                stage: 'display',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
        ];

        transport.enqueue(
            // Turn 1 Round 1: write_file('/output.md', ...)
            {
                content: '',
                toolCalls: [
                    {
                        id: 'r1_write',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '<think>内心</think>码头灯影摇曳。<!-- trace: round1 -->',
                        }),
                    },
                ],
            },
            // Turn 1 Round 2: finish_turn
            {
                content: '',
                toolCalls: [
                    {
                        id: 'r1_finish',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({
                            step_brief: '完成首轮<!-- trace: brief1 -->',
                        }),
                    },
                ],
            },
            // Turn 2 Round 1: verify frozen Layer 1 prefix, then write Turn 2 output
            (req) => {
                const frozenWriteMsg = req.messages.find(
                    (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'r1_write'),
                );
                expect(frozenWriteMsg).toBeDefined();
                const frozenWriteArgs = JSON.parse(frozenWriteMsg!.toolCalls![0].arguments) as {
                    path: string;
                    content: string;
                };
                expect(frozenWriteArgs.content).toBe('<think>内心</think>码头灯影摇曳。');
                expect(frozenWriteArgs.content).not.toContain('[折叠:');
                expect(req.messages.some((m) => m.role === 'assistant' && m.content === '完成首轮')).toBe(
                    true,
                );

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'r2_write',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '第二轮正文<!-- trace: round2 -->',
                            }),
                        },
                    ],
                };
            },
            // Turn 2 Round 2: finish_turn
            {
                content: '',
                toolCalls: [
                    {
                        id: 'r2_finish',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: '第二轮结束' }),
                    },
                ],
            },
        );

        const res1 = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '第一轮行动',
        });

        // Raw /output.md and host chat message MUST retain original text (ingest only cleans TrajectoryStore)
        expect(res1.content).toBe('<think>内心</think>码头灯影摇曳。<!-- trace: round1 -->');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '<think>内心</think>码头灯影摇曳。<!-- trace: round1 -->',
        );

        // Add another ingest rule before Turn 2: Turn 1's frozen Layer 1 prefix MUST stay byte-for-byte invariant
        preset.regexRules.push({
            id: 'ingest_late_mask',
            name: 'Late mask',
            pattern: '码头',
            replace: 'MASKED',
            stage: 'ingest',
            applyToUser: false,
            applyToAssistant: true,
            enabled: true,
        });

        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '第二轮行动' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        const res2 = await runner.run({
            agent: 'main',
            target: { messageId: 3, swipeId: 0 },
            phase: 'main_turn',
            userInput: '第二轮行动',
        });

        expect(res2.content).toBe('第二轮正文<!-- trace: round2 -->');
        assertAppendOnlyPrefix(transport.requests[0], transport.requests[2]);
        const layer1After = runner.trajectoryStore.getMessages('main');
        const t1WriteFrozen = layer1After.find(
            (m) => m.role === 'assistant' && m.toolCalls?.some((tc) => tc.id === 'r1_write'),
        );
        expect(JSON.parse(t1WriteFrozen!.toolCalls![0].arguments).content).toBe(
            '<think>内心</think>码头灯影摇曳。',
        );
    });

    it('persists retryCount and retryEvents onto AgentRunTrace and differentiates write vs read-only empty completion in after_turn', async () => {
        // 1. Recovery & exhaustion telemetry on AgentRunTrace + onRetrying callback
        const setupTelemetry = makeStrictSetup({
            connectionStrict: false,
            roundMaxRetries: 2,
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables', 'patch_variables'],
            roundRetryInitialDelayMs: 0,
            roundRetryMaxDelayMs: 0,
        });

        const retryingLogs: RoundRetryLog[] = [];
        setupTelemetry.transport.enqueue(
            // Round 1: read_variables
            {
                content: '',
                toolCalls: [
                    { id: 'c_rv', name: 'read_variables', arguments: '{"scope":"message"}' },
                ],
            },
            // Round 2 attempt 1: thinking-only empty response -> EMPTY_RESPONSE retry #1
            {
                content: '',
                reasoningContent: 'internal thoughts only',
                usage: { inputTokens: 200, cachedTokens: 0, outputTokens: 150 },
                finishReason: 'STOP',
            },
            // Round 2 attempt 2: second empty -> EMPTY_RESPONSE retry #2
            {
                content: '  ',
                usage: { inputTokens: 200, cachedTokens: 0, outputTokens: 12 },
                finishReason: 'STOP',
            },
            // Round 2 attempt 3 (exhausts 2 retries): still empty -> fails
            {
                content: '',
                reasoningContent: 'final thought preview',
                usage: { inputTokens: 200, cachedTokens: 0, outputTokens: 80 },
                finishReason: 'STOP',
            },
        );

        let caughtErr: unknown;
        try {
            await setupTelemetry.runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: '读取变量并分析。',
                onRetrying: (info) => retryingLogs.push(info),
            });
        } catch (err) {
            caughtErr = err;
        }

        expect(caughtErr).toBeInstanceOf(AgentExecutionError);
        const failTrace = (caughtErr as AgentExecutionError).trace;
        expect(failTrace.status).toBe('error');
        expect(failTrace.retryCount).toBe(2);
        expect(failTrace.roundMaxRetries).toBe(2);
        expect(failTrace.retryEvents).toHaveLength(2);
        expect(failTrace.retryEvents?.[0]).toMatchObject({
            round: 2,
            attempt: 1,
            maxAttempts: 2,
            reason: 'EMPTY_RESPONSE',
            finishReason: 'STOP',
            outputTokens: 150,
            hasReasoning: true,
        });
        expect(failTrace.retryEvents?.[1]).toMatchObject({
            round: 2,
            attempt: 2,
            maxAttempts: 2,
            reason: 'EMPTY_RESPONSE',
            finishReason: 'STOP',
            outputTokens: 12,
        });
        expect(failTrace.outputPreview).toContain('final thought preview');
        expect(retryingLogs).toEqual(failTrace.retryEvents);

        // 2. Non-strict after_turn trigger that already succeeded a write tool completes silently
        const setupSilentWrite = makeStrictSetup({
            connectionStrict: false,
            roundMaxRetries: 2,
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables', 'patch_variables'],
            roundRetryInitialDelayMs: 0,
            roundRetryMaxDelayMs: 0,
        });
        setupSilentWrite.transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'c_pv',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ scope: 'message', json_merge: { synced: true } }),
                    },
                ],
            },
            // Round 2: empty text with 0 tool calls after successful patch_variables -> succeeds immediately
            { content: '' },
        );

        const silentRes = await setupSilentWrite.runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            userInput: '写入变量即可。',
        });
        expect(silentRes.trace.status).toBe('completed');
        expect(silentRes.trace.retryCount).toBe(0);
        expect(setupSilentWrite.transport.requests).toHaveLength(2);
    });

    it('ignores after_turn turn_retrying events on main capsule while preserving main retrying state across syncFromStore', () => {
        const listeners = new Set<(event: GenerationEventPayload) => void>();
        const services = {
            ...createMockUIServices(),
            subscribeEvents: (listener: (event: GenerationEventPayload) => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const store = new AppStore({
            services,
            initialTraces: [],
            initialBackgroundTasks: [],
        });

        const capsule = new AgenticCapsuleElement();
        const disconnect = capsule.connectStore(store, { messageId: 4, swipeId: 3 });

        const emit = (event: GenerationEventPayload) => {
            for (const listener of listeners) {
                listener(event);
            }
        };

        // Main turn enters running -> retrying
        store.upsertTrace({
            runId: 'run_main_4_3',
            target: { messageId: 4, swipeId: 3 },
            phase: 'main_turn',
            agentProfileId: 'main',
            agentName: 'Main',
            connectionId: 'conn_1',
            model: 'm',
            status: 'running',
            startedAt: Date.now(),
            durationMs: 0,
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 },
            toolSteps: [],
        });

        emit({
            kind: 'turn_retrying',
            phase: 'main_turn',
            target: { messageId: 4, swipeId: 3 },
            timestamp: Date.now(),
            retryAttempt: 1,
            retryMaxAttempts: 2,
            retryDelayMs: 1000,
            retryReason: 'EMPTY_RESPONSE',
        });
        expect(capsule.getState().status).toBe('retrying');

        // Background task store update while main_turn is still running must NOT clobber main retrying state
        store.upsertBackgroundTask({
            taskId: 'bg_1',
            target: { messageId: 4, swipeId: 3 },
            phase: 'after_turn',
            barrier: 'none',
            agentProfileId: 'ag_phys',
            label: '🍌生理更新',
            state: 'running',
            startedAt: Date.now(),
        });
        expect(capsule.getState().status).toBe('retrying');

        // Main turn finishes -> done; subsequent after_turn turn_retrying must NOT regress capsule to retrying
        store.upsertTrace({
            runId: 'run_main_4_3',
            target: { messageId: 4, swipeId: 3 },
            phase: 'main_turn',
            agentProfileId: 'main',
            agentName: 'Main',
            connectionId: 'conn_1',
            model: 'm',
            status: 'completed',
            startedAt: Date.now() - 500,
            endedAt: Date.now(),
            durationMs: 500,
            usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 20 },
            toolSteps: [],
        });
        expect(capsule.getState().status).toBe('background-running');

        emit({
            kind: 'turn_retrying',
            phase: 'after_turn',
            target: { messageId: 4, swipeId: 3 },
            timestamp: Date.now(),
            retryAttempt: 1,
            retryMaxAttempts: 2,
            retryDelayMs: 1200,
            retryReason: 'EMPTY_RESPONSE',
        });
        expect(capsule.getState().status).toBe('background-running');

        disconnect();
    });
});
