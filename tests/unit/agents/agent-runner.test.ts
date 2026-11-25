import { describe, expect, it } from 'vitest';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import {
    AgentExecutionError,
    AgentRunner,
    MaxToolRoundsError,
    TurnInterruptedError,
} from '@/core/agents';
import { TraceLogger } from '@/core/logger';
import { compileVariableSchemaEntries } from '@/core/tools';
import type { GenerationEventPayload, RawLoreEntry } from '@/core/types';
import { IframeJsSandbox } from '@/sandbox';
import {
    assertAppendOnlyPrefix,
    DeferredGate,
    MemoryHostBridge,
    ScriptedLLMTransport,
} from '../../mocks';

function makeTestSetup(opts: {
    lorebooks?: Record<string, RawLoreEntry[]>;
    maxToolRounds?: number;
    enabledTools?: string[];
    writePermissions?: string[];
    sessionMode?: 'persistent' | 'ephemeral';
    stream?: boolean;
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: {
            userName: '沈默',
            charName: '林晚',
            characterAvatar: 'linwan.png',
            personaAvatar: 'shenmo.png',
        },
        characterFields: {
            description: '灰港资深调查员与前守夜人记事官，负责追查灵能走私网络。',
        },
        lorebooks: opts.lorebooks,
    });
    bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '开始调查' });
    bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

    const conn = createDefaultConnection({
        id: 'conn_main',
        model: 'test-model',
        stream: opts.stream ?? true,
    });
    const mainAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: 'conn_main',
        sessionMode: opts.sessionMode ?? 'persistent',
        maxToolRounds: opts.maxToolRounds ?? 6,
        enabledTools: opts.enabledTools ?? [
            'list_dir',
            'read_file',
            'write_file',
            'edit_file',
            'read_variables',
            'patch_variables',
        ],
        permissions: {
            read: ['/**'],
            write: opts.writePermissions ?? ['/memory/**', '/notes/**', '/state/variables.json'],
        },
    });
    const preset = createDefaultPreset({
        id: 'preset_test',
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
    const transport = new ScriptedLLMTransport();
    const runner = new AgentRunner({
        bridge,
        transport,
        settings,
        traceLogger,
    });

    return { bridge, settings, preset, mainAgent, traceLogger, transport, runner };
}

describe('AgentRunner & TraceLogger', () => {
    it('executes multi-round tool calls with /output.md preview streaming, KV prefix invariance, and accurate TokenUsage', async () => {
        const { bridge, traceLogger, transport, runner } = makeTestSetup();
        const vfs = runner.vfs;
        await vfs.writeFile('/notes/clue.md', '旧灯塔二楼暗格密码：3719\n状态：未开启', {
            target: { messageId: 0, swipeId: 0 },
        });

        const events: GenerationEventPayload[] = [];
        traceLogger.subscribe((ev) => events.push(ev));

        const textDeltas: string[] = [];
        const outputPreviews: string[] = [];
        const reasoningDeltas: string[] = [];

        transport.enqueue(
            {
                reasoningContent: '先列出目录并读取线索文件。',
                content: '',
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/notes/clue.md' }),
                    },
                ],
                usage: { inputTokens: 1000, cachedTokens: 600, outputTokens: 40 },
            },
            {
                reasoningContent: '已掌握密码，写入 /output.md。',
                content: '',
                toolCalls: [
                    {
                        id: 'call_write_1',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '我在二楼暗格中记下了密码 3719。',
                        }),
                    },
                ],
                usage: { inputTokens: 1120, cachedTokens: 980, outputTokens: 25 },
            },
            {
                reasoningContent: '核对无误。',
                content: '内部核对完成：密码已正确写入 /output.md。',
                usage: { inputTokens: 1180, cachedTokens: 1080, outputTokens: 15 },
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '查看二楼线索并告诉我结果。',
            onTextDelta: (d) => textDeltas.push(d),
            onOutputPreview: (full) => outputPreviews.push(full),
            onReasoningDelta: (d) => reasoningDeltas.push(d),
        });

        expect(res.content).toBe('我在二楼暗格中记下了密码 3719。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '我在二楼暗格中记下了密码 3719。',
        );
        expect(res.rounds).toBe(3);
        expect(res.toolSteps).toHaveLength(2);
        expect(res.toolSteps[0].toolName).toBe('read_file');
        expect(res.toolSteps[0].ok).toBe(true);
        expect(res.toolSteps[0].result).toContain('3719');
        expect(res.toolSteps[1].toolName).toBe('write_file');
        expect(res.toolSteps[1].ok).toBe(true);

        // Plain assistant text is isolated from onTextDelta in main_turn; output_preview streams /output.md
        expect(textDeltas).toEqual([]);
        expect(outputPreviews.length).toBeGreaterThan(0);
        expect(outputPreviews[outputPreviews.length - 1]).toBe('我在二楼暗格中记下了密码 3719。');
        expect(reasoningDeltas.join('')).toContain('先列出目录并读取线索文件');

        // Accurate cumulative usage across all 3 rounds
        expect(res.usage.inputTokens).toBe(3300);
        expect(res.usage.cachedTokens).toBe(2660);
        expect(res.usage.outputTokens).toBe(80);
        expect(res.usage.totalTokens).toBe(3380);
        expect(res.usage.cacheHitRate).toBeCloseTo(2660 / 3300, 4);

        // Streamed & lifecycle events recorded
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('phase_started');
        expect(kinds).toContain('reasoning_delta');
        expect(kinds).toContain('output_preview');
        expect(kinds).toContain('tool_started');
        expect(kinds).toContain('tool_completed');
        expect(kinds).toContain('trace_recorded');
        expect(kinds).toContain('phase_completed');

        // Prefix invariance across rounds and into Turn 2
        expect(transport.requests).toHaveLength(3);
        assertAppendOnlyPrefix(transport.requests[0], transport.requests[1]);
        assertAppendOnlyPrefix(transport.requests[1], transport.requests[2]);

        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '继续前进。' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'call_write_2',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '我推开了暗格的门。',
                        }),
                    },
                ],
                usage: { inputTokens: 1200, cachedTokens: 1100, outputTokens: 15 },
            },
            {
                content: 'Turn 2 review ok.',
                usage: { inputTokens: 1240, cachedTokens: 1180, outputTokens: 8 },
            },
        );
        const res2 = await runner.run({
            agent: 'main',
            target: { messageId: 3, swipeId: 0 },
            phase: 'main_turn',
            userInput: '继续前进。',
        });

        expect(res2.content).toBe('我推开了暗格的门。');
        assertAppendOnlyPrefix(transport.requests[2], transport.requests[3]);
        assertAppendOnlyPrefix(transport.requests[3], transport.requests[4]);
        expect(runner.trajectoryStore.getReadSet('main').has('/notes/clue.md')).toBe(true);
        expect(runner.trajectoryStore.getReadSet('main').has('/output.md')).toBe(false);
    });

    it('self-heals in-round when patch_variables fails Zod schema or edit_file anchor misses', async () => {
        const sandbox = new IframeJsSandbox();
        const schema = await compileVariableSchemaEntries(
            [
                {
                    world: 'Rules',
                    uid: 1,
                    comment: 'Vars Schema',
                    content:
                        '@@zod_schema z.object({ hp: z.number().min(0).max(100), mood: z.enum(["calm", "tense"]) }).loose()',
                    keys: [],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 0,
                    order: 1,
                    role: 0,
                },
            ],
            sandbox,
        );

        const { bridge, runner, transport } = makeTestSetup();
        await runner.vfs.writeVariables({ hp: 100, mood: 'calm' }, { target: { messageId: 0, swipeId: 0 } });
        await runner.vfs.writeFile('/memory/status.md', '当前地点：灰港码头\n警戒：低', {
            target: { messageId: 0, swipeId: 0 },
        });

        transport.enqueue(
            // Round 1: invalid variable patch + missing anchor edit_file
            {
                content: '',
                toolCalls: [
                    {
                        id: 'c_bad_vars',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { hp: 250, mood: 'angry' } }),
                    },
                    {
                        id: 'c_bad_edit',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/memory/status.md',
                            search: '不存在的锚点文本',
                            replace: '警戒：高',
                        }),
                    },
                ],
            },
            // Round 2: LLM reads structured errors from tool results, corrects itself, and writes /output.md!
            async (req) => {
                const toolMsgs = req.messages.filter((m) => m.role === 'tool');
                expect(toolMsgs).toHaveLength(2);
                expect(String(toolMsgs[0].content)).toContain('hp');
                expect(String(toolMsgs[0].content)).toContain('mood');
                expect(String(toolMsgs[1].content)).toContain('Target text not found');

                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'c_fix_vars',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 80, mood: 'tense' } }),
                        },
                        {
                            id: 'c_fix_edit',
                            name: 'edit_file',
                            arguments: JSON.stringify({
                                path: '/memory/status.md',
                                search: '警戒：低',
                                replace: '警戒：高',
                            }),
                        },
                        {
                            id: 'c_write_out',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '已完成自愈修正并更新状态。',
                            }),
                        },
                    ],
                };
            },
            // Round 3: internal finish summary
            {
                content: 'Review complete.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '更新战斗后状态。',
            getVariableSchema: () => schema,
        });

        expect(res.content).toBe('已完成自愈修正并更新状态。');
        expect(res.rounds).toBe(3);
        expect(res.toolSteps.map((s) => s.ok)).toEqual([false, false, true, true, true]);
        expect(res.toolSteps[0].error).toContain('hp');
        expect(res.toolSteps[1].error).toContain('Target text not found');

        runner.store.commitStagedData({ messageId: 1, swipeId: 0 });
        const vars = await runner.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(vars).toMatchObject({ hp: 80, mood: 'tense' });
        const statusText = await runner.vfs.readFile('/memory/status.md', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(statusText).toContain('警戒：高');
        expect(bridge.getChat().length).toBe(2);
    });

    it('delegates @@agent sub-agent calls in isolated plain-text child runs and integrates into /output.md', async () => {
        const archivistEntry: RawLoreEntry = {
            world: 'Lore',
            uid: 50,
            comment: '考据灰港银莲花结社的秘密档案',
            content: '@@agent archivist\n你是资料考据员，请检索 /lorebooks/ 并输出 50 字以内的简明结论。',
            keys: [],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 1,
            role: 0,
        };
        const secretLoreEntry: RawLoreEntry = {
            world: 'Lore',
            uid: 51,
            comment: '银莲花秘档',
            content: '银莲花结社由前灵能炉工程师建立，接头信物为三瓣银莲花铜徽。',
            keys: ['银莲花'],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 1,
            depth: 0,
            order: 10,
            role: 0,
        };

        const { runner, transport, traceLogger } = makeTestSetup({
            lorebooks: { Lore: [archivistEntry, secretLoreEntry] },
        });

        // Turn sequence:
        // 0: parent LLM calls delegate_agent_archivist
        // 1: child sub-agent calls read_file on secretLoreEntry
        // 2: child sub-agent returns concise plain-text summary (no /output.md required!)
        // 3: parent LLM writes /output.md using child summary
        // 4: parent LLM finishes with internal summary
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'call_sub_1',
                        name: 'delegate_agent_archivist',
                        arguments: JSON.stringify({ task: '查明银莲花结社的创立者与信物' }),
                    },
                ],
            },
            (req) => {
                // Child agent must NOT see parent recursive delegation tools
                const toolNames = req.tools.map((t) => t.name);
                expect(toolNames).not.toContain('delegate_agent_archivist');
                expect(toolNames).toContain('read_file');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'child_read_1',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/lorebooks/Lore/银莲花秘档-51.md' }),
                        },
                    ],
                };
            },
            {
                content: '摘要：由前灵能炉工程师创立，信物为三瓣银莲花铜徽。',
            },
            (req) => {
                const toolMsg = req.messages.find((m) => m.role === 'tool' && m.toolName === 'delegate_agent_archivist');
                expect(String(toolMsg?.content)).toContain('三瓣银莲花铜徽');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'write_parent_out',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '据档案记载，那是前灵能炉工程师建立的组织，以三瓣银莲花铜徽为信物。',
                            }),
                        },
                    ],
                };
            },
            {
                content: 'Internal: integrated archivist summary into /output.md.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '帮我查一下银莲花结社的底细。',
        });

        expect(res.content).toBe('据档案记载，那是前灵能炉工程师建立的组织，以三瓣银莲花铜徽为信物。');
        expect(res.content).not.toContain('Internal:');
        expect(res.toolSteps[0].toolName).toBe('delegate_agent_archivist');
        expect(res.toolSteps[0].result).toContain('摘要：由前灵能炉工程师创立');

        // Parent trajectory contains only the clean delegation summary, NOT child's raw read_file dump
        const parentMessages = runner.trajectoryStore.getMessages('main');
        const serializedParent = JSON.stringify(parentMessages);
        expect(serializedParent).toContain('摘要：由前灵能炉工程师创立');
        expect(serializedParent).not.toContain('child_read_1');

        // TraceLogger recorded both parent and child runs
        const traces = traceLogger.listTraces();
        expect(traces.length).toBeGreaterThanOrEqual(2);
        expect(traces.some((t) => t.agentProfileId === 'subagent_archivist')).toBe(true);
    });

    it('enforces maxToolRounds guardrail and records error trace', async () => {
        const { runner, transport, traceLogger } = makeTestSetup({ maxToolRounds: 2 });

        // Enqueue 4 consecutive tool-calling responses; should abort after 2 tool rounds (3rd LLM call)
        for (let i = 0; i < 4; i += 1) {
            transport.enqueue({
                content: '',
                toolCalls: [
                    {
                        id: `loop_${i}`,
                        name: 'list_dir',
                        arguments: JSON.stringify({ path: '/' }),
                    },
                ],
            });
        }

        await expect(
            runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '不断列出目录。',
            }),
        ).rejects.toThrow(MaxToolRoundsError);

        expect(transport.requests).toHaveLength(3);
        const [latest] = traceLogger.listTraces({ limit: 1 });
        expect(latest.status).toBe('error');
        expect(latest.error).toContain('maxToolRounds (2)');
        expect(latest.toolSteps).toHaveLength(2);
    });

    it('treats maxToolRounds=0 as unlimited and executes >8 consecutive tool rounds cleanly', async () => {
        const { bridge, runner, transport, traceLogger } = makeTestSetup({ maxToolRounds: 0 });

        for (let i = 0; i < 11; i += 1) {
            transport.enqueue({
                content: '',
                toolCalls: [
                    {
                        id: `unlim_list_${i}`,
                        name: 'list_dir',
                        arguments: JSON.stringify({ path: '/' }),
                    },
                ],
            });
        }
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'unlim_write_out',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '经过 12 轮工具调用后输出的最终正文。',
                        }),
                    },
                ],
            },
            {
                content: '已完成全部检索与输出写入。',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '执行超长多轮检索与汇总。',
        });

        expect(transport.requests).toHaveLength(13);
        expect(res.toolSteps).toHaveLength(12);
        expect(res.content).toBe('经过 12 轮工具调用后输出的最终正文。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '经过 12 轮工具调用后输出的最终正文。',
        );
        const [latest] = traceLogger.listTraces({ limit: 1 });
        expect(latest.status).toBe('completed');
    });

    it('supports AbortSignal during streaming/tool execution without mutating TrajectoryStore', async () => {
        const { runner, transport, traceLogger } = makeTestSetup();
        const abortController = new AbortController();
        const gate = new DeferredGate<void>();

        transport.enqueue(async () => {
            setTimeout(() => abortController.abort(), 15);
            await gate.wait();
            return { content: 'Should never resolve' };
        });

        await expect(
            runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '触发中止测试',
                signal: abortController.signal,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });

        gate.resolve();
        expect(runner.trajectoryStore.getMessageCount('main')).toBe(0);
        const [latest] = traceLogger.listTraces({ limit: 1 });
        expect(latest.status).toBe('aborted');
    });

    it('supports ephemeral mode sliding window and TraceLogger 100-run ring buffer filtering', async () => {
        const { bridge, runner, traceLogger } = makeTestSetup({
            sessionMode: 'ephemeral',
        });
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '第二句用户话' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '第二句回复', swipeId: 0 });
        bridge.pushMessage({ id: 4, name: '沈默', isUser: true, mes: '第三句用户话' });
        bridge.pushMessage({ id: 5, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        const ephemeralAgent = createDefaultMainAgent({
            id: 'eph',
            name: 'Ephemeral Observer',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 2,
            enabledTools: [],
        });

        const transport = runner.transport as ScriptedLLMTransport;
        transport.enqueue((req) => {
            const historyTexts = req.messages.map((m) => String(m.content));
            expect(historyTexts.some((t) => t.includes('第二句回复'))).toBe(true);
            return { content: '瞬态观测结果' };
        });

        const ephRes = await runner.run({
            agent: ephemeralAgent,
            target: { messageId: 5, swipeId: 0 },
            phase: 'after_turn',
            userInput: '总结最新互动',
        });
        expect(ephRes.content).toBe('瞬态观测结果');
        expect(runner.trajectoryStore.hasThread('eph')).toBe(false);

        // Ring buffer test: 120 traces recorded -> capped at 100, preserving newest 100
        traceLogger.clear();
        for (let i = 0; i < 120; i += 1) {
            traceLogger.recordTrace(
                {
                    runId: `ring_${i}`,
                    target: { messageId: i % 5, swipeId: 0 },
                    phase: i % 2 === 0 ? 'main_turn' : 'after_turn',
                    agentProfileId: i % 3 === 0 ? 'main' : 'ag_vars',
                    agentName: 'Agent',
                    connectionId: 'conn_main',
                    model: 'test-model',
                    status: 'completed',
                    startedAt: 1000 + i,
                    endedAt: 1010 + i,
                    durationMs: 10,
                    usage: { inputTokens: 10, cachedTokens: 5, outputTokens: 2, totalTokens: 12, cacheHitRate: 0.5 },
                    toolSteps: [],
                },
                false,
            );
        }

        expect(traceLogger.size).toBe(100);
        const all = traceLogger.listTraces();
        expect(all).toHaveLength(100);
        expect(all.some((t) => t.runId === 'ring_0')).toBe(false);
        expect(all.some((t) => t.runId === 'ring_19')).toBe(false);
        expect(all.some((t) => t.runId === 'ring_20')).toBe(true);
        expect(all[0].runId).toBe('ring_119');

        const filtered = traceLogger.listTraces({
            target: { messageId: 4, swipeId: 0 },
            phase: 'main_turn',
            agentProfileId: 'main',
        });
        expect(filtered.every((t) => t.target.messageId === 4 && t.phase === 'main_turn' && t.agentProfileId === 'main')).toBe(true);
    });

    it('supports write /output.md -> in-turn review -> edit_file(/output.md) while hiding internal summary and guaranteeing Layer 0 output tools', async () => {
        // Deliberately configure mainAgent WITHOUT output tools or /output.md write permissions
        const { bridge, transport, runner, settings, preset } = makeTestSetup({
            enabledTools: ['list_dir'],
            writePermissions: ['/scratch/**'],
        });
        // Disable append_file via builtinToolSettings on the active preset to verify override is respected
        settings.presets[preset.id].builtinToolSettings = {
            append_file: { enabled: false },
        };

        const textDeltas: string[] = [];
        const previews: string[] = [];
        const reasonings: string[] = [];

        transport.enqueue(
            (req) => {
                const toolNames = req.tools.map((t) => t.name);
                expect(toolNames).toContain('read_file');
                expect(toolNames).toContain('write_file');
                expect(toolNames).toContain('edit_file');
                expect(toolNames).not.toContain('append_file');

                return {
                    reasoningContent: '先写初稿到 /output.md。',
                    content: 'Internal draft note: writing scene now.',
                    toolCalls: [
                        {
                            id: 'write_draft',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '林晚在三号泊位点亮了错误的煤油灯。',
                            }),
                        },
                    ],
                };
            },
            {
                reasoningContent: '自检发现用词有误，改为铜制风灯。',
                content: 'Internal review: fixing lamp type.',
                toolCalls: [
                    {
                        id: 'edit_fix',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            search: '错误的煤油灯',
                            replace: '铜制防风灯',
                        }),
                    },
                ],
            },
            {
                content: 'Review passed. No remaining errors.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '描写林晚在码头的动作。',
            onTextDelta: (d) => textDeltas.push(d),
            onOutputPreview: (p) => previews.push(p),
            onReasoningDelta: (r) => reasonings.push(r),
        });

        expect(res.content).toBe('林晚在三号泊位点亮了铜制防风灯。');
        expect(res.content).not.toContain('Review passed');
        expect(res.content).not.toContain('Internal');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '林晚在三号泊位点亮了铜制防风灯。',
        );
        expect(textDeltas).toEqual([]);
        expect(previews[previews.length - 1]).toBe('林晚在三号泊位点亮了错误的煤油灯。');
        expect(reasonings.join('')).toContain('自检发现用词有误');
        expect(res.trace.outputPreview).toBe('林晚在三号泊位点亮了铜制防风灯。');

        // Internal review summary is recorded in TrajectoryStore, NOT the user-visible message
        const traj = runner.trajectoryStore.getMessages('main');
        expect(String(traj[traj.length - 1].content)).toBe('Review passed. No remaining errors.');
    });

    it('allows @@agent child reviewer during main_turn to inspect /output.md and return plain-text critique', async () => {
        const reviewerEntry: RawLoreEntry = {
            world: 'Review',
            uid: 80,
            comment: '设定审核员',
            content: '@@agent reviewer\n检查 /output.md 中的设定错误并返回简明修正建议。',
            keys: [],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 1,
            role: 0,
        };

        const { bridge, transport, runner } = makeTestSetup({
            lorebooks: { Review: [reviewerEntry] },
        });

        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'w1',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: '灰港守夜人佩戴银色徽章。',
                        }),
                    },
                ],
            },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'rev_1',
                        name: 'delegate_agent_reviewer',
                        arguments: JSON.stringify({ task: '核查 /output.md 是否符合灰港设定' }),
                    },
                ],
            },
            // Child reviewer reads /output.md and returns plain text directly
            {
                content: '',
                toolCalls: [
                    {
                        id: 'child_read_out',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/output.md' }),
                    },
                ],
            },
            (req) => {
                const toolRes = req.messages.find((m) => m.role === 'tool');
                expect(String(toolRes?.content)).toContain('1| 灰港守夜人佩戴银色徽章。');
                return {
                    content: '问题：徽章应为三瓣银莲花铜徽，非银色。',
                };
            },
            // Parent applies reviewer critique via edit_file
            (req) => {
                const reviewResult = req.messages.find(
                    (m) => m.role === 'tool' && m.toolName === 'delegate_agent_reviewer',
                );
                expect(String(reviewResult?.content)).toContain('三瓣银莲花铜徽');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'fix_badge',
                            name: 'edit_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                search: '银色徽章',
                                replace: '三瓣银莲花铜徽',
                            }),
                        },
                    ],
                };
            },
            {
                content: 'All reviewer edits applied.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '写出守夜人登场描写并自审。',
        });

        expect(res.content).toBe('灰港守夜人佩戴三瓣银莲花铜徽。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '灰港守夜人佩戴三瓣银莲花铜徽。',
        );
    });

    it('retries once when /output.md is empty and throws TurnInterruptedError(empty_output) if still empty', async () => {
        const { bridge, transport, runner } = makeTestSetup({ maxToolRounds: 4 });

        // Case 1: Model forgets to write /output.md -> [System Check] -> self-heals on retry
        transport.enqueue(
            {
                content: '我直接用纯文本回答了，忘了写文件。',
            },
            (req) => {
                const lastMsg = req.messages[req.messages.length - 1];
                expect(lastMsg.role).toBe('user');
                expect(String(lastMsg.content)).toContain('[System Check] /output.md is still empty');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'heal_write',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '自愈后正确写入 /output.md 的正文。',
                            }),
                        },
                    ],
                };
            },
            {
                content: '已完成修正。',
            },
        );

        const healed = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '开始第一回合。',
        });
        expect(healed.content).toBe('自愈后正确写入 /output.md 的正文。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '自愈后正确写入 /output.md 的正文。',
        );

        // Case 2: Model still refuses to write /output.md after retry -> TurnInterruptedError('empty_output')
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '第二回合' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            { content: '第一次纯文本' },
            { content: '第二次依然是纯文本' },
        );

        let caught: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 3, swipeId: 0 },
                phase: 'main_turn',
                userInput: '开始第二回合。',
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(TurnInterruptedError);
        const interrupted = caught as TurnInterruptedError;
        expect(interrupted.reason).toBe('empty_output');
        expect(interrupted.salvagedOutput).toBe('');
        expect(interrupted.trace.status).toBe('interrupted');
        expect(interrupted.trace.interruptedReason).toBe('empty_output');
        expect(interrupted.checkpoint.target).toEqual({ messageId: 3, swipeId: 0 });
        expect(interrupted.checkpoint.completedTurnMessages.some((m) => String(m.content).includes('[System Check]'))).toBe(true);
    });

    it('salvages /output.md and emits TurnInterruptedError on user_stop, stream error, and finishReason=length (streaming & non-streaming)', async () => {
        // 1. Streaming finishReason: 'length' with incomplete tool JSON -> intercepted BEFORE Zod/tool execution!
        const { bridge, settings, transport, runner, traceLogger } = makeTestSetup({ stream: true });
        const previews: string[] = [];

        transport.enqueue({
            chunks: [
                {
                    type: 'tool_call_delta',
                    toolCallIndex: 0,
                    toolCallId: 'tc_trunc',
                    toolName: 'write_file',
                    argumentsDelta: '{"path":"/output.md","content":"半截流式正文被长度',
                },
                {
                    type: 'tool_call_delta',
                    toolCallIndex: 0,
                    argumentsDelta: '截断了', // Intentionally unclosed JSON!
                },
                {
                    type: 'done',
                    finishReason: 'length',
                },
            ],
        });

        let lengthErr: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                userInput: '写长文。',
                onOutputPreview: (p) => previews.push(p),
            });
        } catch (err) {
            lengthErr = err;
        }

        expect(lengthErr).toBeInstanceOf(TurnInterruptedError);
        const lenInterrupted = lengthErr as TurnInterruptedError;
        expect(lenInterrupted.reason).toBe('length');
        expect(lenInterrupted.salvagedOutput).toBe('半截流式正文被长度截断了');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('半截流式正文被长度截断了');
        expect(previews[previews.length - 1]).toBe('半截流式正文被长度截断了');
        // Unclosed tool call MUST NOT appear in checkpoint.completedTurnMessages
        expect(lenInterrupted.checkpoint.completedTurnMessages.some((m) => Boolean(m.toolCalls?.length))).toBe(false);

        // 2. Non-streaming finishReason: 'length' with truncated toolCalls -> salvaged cleanly without Zod retry loop
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '非流式截断' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue({
            content: '',
            toolCalls: [
                {
                    id: 'tc_nonstream',
                    name: 'write_file',
                    arguments: '{"path":"/output.md","content":"非流式截断半截内容',
                },
            ],
            finishReason: 'length',
        });

        let nonStreamErr: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 3, swipeId: 0 },
                phase: 'main_turn',
                stream: false,
                userInput: '非流式测试。',
            });
        } catch (err) {
            nonStreamErr = err;
        }
        expect(nonStreamErr).toBeInstanceOf(TurnInterruptedError);
        expect((nonStreamErr as TurnInterruptedError).reason).toBe('length');
        expect((nonStreamErr as TurnInterruptedError).salvagedOutput).toBe('非流式截断半截内容');

        // 3. Stream network error mid-write_file -> salvages partial content & preserves prior completed rounds
        bridge.pushMessage({ id: 4, name: '沈默', isUser: true, mes: '网络断流' });
        bridge.pushMessage({ id: 5, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        await runner.vfs.writeFile('/notes/fact.md', '关键事实：灯塔下有暗渠。', {
            target: { messageId: 4, swipeId: 0 },
        });
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'read_fact',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/notes/fact.md' }),
                    },
                ],
            },
            {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'w_err',
                        toolName: 'write_file',
                        argumentsDelta: '{"path":"/output.md","content":"暗渠之中传来',
                    },
                ],
                error: new Error('SSE connection dropped'),
                errorAfterChunks: 1,
            },
        );

        let netErr: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 5, swipeId: 0 },
                phase: 'main_turn',
                userInput: '检查暗渠。',
            });
        } catch (err) {
            netErr = err;
        }
        expect(netErr).toBeInstanceOf(TurnInterruptedError);
        const netInterrupted = netErr as TurnInterruptedError;
        expect(netInterrupted.reason).toBe('error');
        expect(netInterrupted.salvagedOutput).toBe('暗渠之中传来');
        expect(netInterrupted.checkpoint.readSetSnapshot['/notes/fact.md']).toBeDefined();
        expect(netInterrupted.checkpoint.completedTurnMessages.some((m) => m.role === 'tool')).toBe(true);

        // 4. user_stop mid-append_file -> salvages base + decoded chunk
        bridge.pushMessage({ id: 6, name: '沈默', isUser: true, mes: '手动停止' });
        bridge.pushMessage({ id: 7, name: '林晚', isUser: false, mes: '已有前缀。', swipeId: 0 });
        const stopController = new AbortController();
        const stopTransport = {
            complete: transport.complete.bind(transport),
            async *stream() {
                yield {
                    type: 'tool_call_delta' as const,
                    toolCallIndex: 0,
                    toolCallId: 'app_stop',
                    toolName: 'append_file',
                    argumentsDelta: '{"path":"/output.md","content":"新追加的半截',
                };
                stopController.abort();
                await new Promise<never>(() => {});
            },
        };
        const stopRunner = new AgentRunner({
            bridge,
            transport: stopTransport,
            settings,
            traceLogger,
        });

        let stopErr: unknown;
        try {
            await stopRunner.run({
                agent: 'main',
                target: { messageId: 7, swipeId: 0 },
                phase: 'main_turn',
                userInput: '继续追加。',
                signal: stopController.signal,
            });
        } catch (err) {
            stopErr = err;
        }
        expect(stopErr).toBeInstanceOf(TurnInterruptedError);
        expect((stopErr as TurnInterruptedError).reason).toBe('user_stop');
        expect((stopErr as TurnInterruptedError).salvagedOutput).toBe('已有前缀。新追加的半截');
        expect(bridge.readChatMessage({ messageId: 7, swipeId: 0 })).toBe('已有前缀。新追加的半截');

        // 5. True 0-progress error on Round 1 -> throws AgentExecutionError (NOT TurnInterruptedError)
        bridge.pushMessage({ id: 8, name: '沈默', isUser: true, mes: '零产出失败' });
        bridge.pushMessage({ id: 9, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        const errTransport = new ScriptedLLMTransport([{ error: new Error('503 Upstream down') }]);
        const errRunner = new AgentRunner({
            bridge,
            transport: errTransport,
            settings,
            traceLogger,
        });
        let zeroProgressErr: unknown;
        try {
            await errRunner.run({
                agent: 'main',
                target: { messageId: 9, swipeId: 0 },
                phase: 'main_turn',
                userInput: '零产出失败',
            });
        } catch (err) {
            zeroProgressErr = err;
        }
        expect(zeroProgressErr).toBeInstanceOf(AgentExecutionError);
        expect(zeroProgressErr).not.toBeInstanceOf(TurnInterruptedError);
    });

    it('isolates @@tool sandboxes across concurrent runs and disposes them cleanly after each run', async () => {
        const loreEntry: RawLoreEntry = {
            world: 'ComfyUI生图',
            uid: 5,
            comment: 'comfyui_generate',
            content: [
                '@@tool comfyui_generate allowNetwork=false',
                'export default defineTool({',
                '  name: "comfyui_generate",',
                '  description: "Mock image generator",',
                '  parameters: z.object({ prompt: z.string() }),',
                '  async execute(args) {',
                '    return { ok: true, imgTag: `<img src="${args.prompt}.png" />` };',
                '  },',
                '});',
            ].join('\n'),
            keys: [],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 1,
            role: 0,
        };

        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '林晚' },
            lorebooks: { 'ComfyUI生图': [loreEntry] },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '画一张图' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        const conn = createDefaultConnection({ id: 'conn_main', model: 'test-model', stream: false });
        const drawAgent = createDefaultMainAgent({
            id: 'draw_agent',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['comfyui_generate'],
            permissions: { read: ['/**'], write: [] },
        });
        const otherAgent = createDefaultMainAgent({
            id: 'other_agent',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables'],
            permissions: { read: ['/**'], write: [] },
        });
        const preset = createDefaultPreset({
            id: 'preset_concurrent',
            mainAgentId: 'draw_agent',
            agents: { draw_agent: drawAgent, other_agent: otherAgent },
        });
        const settings = createDefaultSettings({
            connections: { [conn.id]: conn },
            currentConnectionId: conn.id,
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const sandbox = new IframeJsSandbox();
        const traceLogger = new TraceLogger({ maxTraces: 50 });

        const run1EnteredGate = new DeferredGate();
        const releaseRun1Gate = new DeferredGate();

        const transport = {
            async complete(req: Parameters<ScriptedLLMTransport['complete']>[0]) {
                const isDrawRun = req.tools.some((t) => t.name === 'comfyui_generate');
                if (!isDrawRun) {
                    return {
                        content: 'other done',
                        toolCalls: [],
                        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 5, totalTokens: 15 },
                    };
                }
                const hasToolResult = req.messages.some((m) => m.role === 'tool');
                if (!hasToolResult) {
                    run1EnteredGate.resolve();
                    await releaseRun1Gate.promise;
                    return {
                        content: '',
                        toolCalls: [
                            {
                                id: 'call_comfy_1',
                                name: 'comfyui_generate',
                                arguments: JSON.stringify({ prompt: 'white_tiger_girl' }),
                            },
                        ],
                        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 10, totalTokens: 20 },
                    };
                }
                const toolMsg = req.messages.find((m) => m.role === 'tool');
                return {
                    content: `done:${String(toolMsg?.content ?? '')}`,
                    toolCalls: [],
                    usage: { inputTokens: 15, cachedTokens: 0, outputTokens: 10, totalTokens: 25 },
                };
            },
            async *stream() {
                if (Date.now() < 0) {
                    yield { type: 'text_delta' as const, textDelta: '' };
                }
                throw new Error('stream not expected');
            },
        };

        const runner = new AgentRunner({
            bridge,
            transport,
            settings,
            traceLogger,
            sandbox,
        });

        // Start Run 1 (uses comfyui_generate), wait until it has compiled @@tool and entered LLM call
        const run1Promise = runner.run({
            agent: 'draw_agent',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            userInput: '生图调用',
        });
        await run1EnteredGate.promise;

        // Run 2 starts & completes concurrently while Run 1 is mid-flight
        const run2Res = await runner.run({
            agent: 'other_agent',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            userInput: '变量更新',
        });
        expect(run2Res.content).toBe('other done');

        // Release Run 1 so it invokes comfyui_generate (must NOT throw "has been disposed")
        releaseRun1Gate.resolve();
        const run1Res = await run1Promise;

        expect(run1Res.toolSteps).toHaveLength(1);
        expect(run1Res.toolSteps[0].toolName).toBe('comfyui_generate');
        expect(run1Res.toolSteps[0].ok).toBe(true);
        expect(run1Res.toolSteps[0].result).toContain('white_tiger_girl.png');
        expect(run1Res.content).toContain('white_tiger_girl.png');

        // All per-run sandboxes must be disposed after both runs complete
        expect(sandbox.lifecycle.getActiveIds()).toEqual([]);
    });
});
