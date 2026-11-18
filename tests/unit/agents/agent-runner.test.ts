import { describe, expect, it } from 'vitest';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { AgentRunner, MaxToolRoundsError } from '@/core/agents';
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
    it('executes multi-round tool calls with streaming events, KV prefix invariance, and accurate TokenUsage', async () => {
        const { bridge, traceLogger, transport, runner } = makeTestSetup();
        const vfs = runner.vfs;
        await vfs.writeFile('/notes/clue.md', '旧灯塔二楼暗格密码：3719\n状态：未开启', {
            target: { messageId: 0, swipeId: 0 },
        });

        const events: GenerationEventPayload[] = [];
        traceLogger.subscribe((ev) => events.push(ev));

        const textDeltas: string[] = [];
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
                reasoningContent: '已掌握密码，给出回复。',
                content: '我在二楼暗格中记下了密码 3719。',
                usage: { inputTokens: 1120, cachedTokens: 980, outputTokens: 25 },
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '查看二楼线索并告诉我结果。',
            onTextDelta: (d) => textDeltas.push(d),
            onReasoningDelta: (d) => reasoningDeltas.push(d),
        });

        expect(res.content).toBe('我在二楼暗格中记下了密码 3719。');
        expect(res.rounds).toBe(2);
        expect(res.toolSteps).toHaveLength(1);
        expect(res.toolSteps[0].toolName).toBe('read_file');
        expect(res.toolSteps[0].ok).toBe(true);
        expect(res.toolSteps[0].result).toContain('3719');

        expect(textDeltas.join('')).toBe('我在二楼暗格中记下了密码 3719。');
        expect(reasoningDeltas.join('')).toContain('先列出目录并读取线索文件');

        // Accurate cumulative usage across both rounds
        expect(res.usage.inputTokens).toBe(2120);
        expect(res.usage.cachedTokens).toBe(1580);
        expect(res.usage.outputTokens).toBe(65);
        expect(res.usage.totalTokens).toBe(2185);
        expect(res.usage.cacheHitRate).toBeCloseTo(1580 / 2120, 4);

        // Streamed & lifecycle events recorded
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('phase_started');
        expect(kinds).toContain('reasoning_delta');
        expect(kinds).toContain('tool_started');
        expect(kinds).toContain('tool_completed');
        expect(kinds).toContain('text_delta');
        expect(kinds).toContain('trace_recorded');
        expect(kinds).toContain('phase_completed');

        // Prefix invariance between round 0 and round 1, and into Turn 2
        expect(transport.requests).toHaveLength(2);
        assertAppendOnlyPrefix(transport.requests[0], transport.requests[1]);

        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '继续前进。' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue({
            content: '我推开了暗格的门。',
            usage: { inputTokens: 1200, cachedTokens: 1100, outputTokens: 15 },
        });
        await runner.run({
            agent: 'main',
            target: { messageId: 3, swipeId: 0 },
            phase: 'main_turn',
            userInput: '继续前进。',
        });

        assertAppendOnlyPrefix(transport.requests[1], transport.requests[2]);
        expect(runner.trajectoryStore.getReadSet('main').has('/notes/clue.md')).toBe(true);
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
            // Round 2: LLM reads structured errors from tool results and corrects itself in-round!
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
                    ],
                };
            },
            // Round 3: final answer
            {
                content: '已完成自愈修正并更新状态。',
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
        expect(res.toolSteps.map((s) => s.ok)).toEqual([false, false, true, true]);
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

    it('delegates @@agent sub-agent calls in isolated ephemeral child runs and returns summary text', async () => {
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
        // 0: parent LLM asks to call delegate_agent_archivist
        // 1: child sub-agent calls read_file on secretLoreEntry
        // 2: child sub-agent returns concise summary
        // 3: parent LLM uses child summary for final reply
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
                    content: '据档案记载，那是前灵能炉工程师建立的组织，以三瓣银莲花铜徽为信物。',
                };
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: '帮我查一下银莲花结社的底细。',
        });

        expect(res.content).toContain('三瓣银莲花铜徽');
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
});
