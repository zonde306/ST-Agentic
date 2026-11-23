import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    AgentExecutionError,
    AgentRunner,
    TurnInterruptedError,
} from '@/core/agents';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import {
    DEFAULT_MAX_TOOL_RESULT_BYTES,
    estimateRequestTokens,
    resolveEffectiveContextBudget,
    TransientToolSpillStore,
    utf8ByteLength,
} from '@/core/context';
import { LLMTransportError } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import {
    createToolExecutionContext,
    ToolRegistry,
    type ToolDefinition,
} from '@/core/tools';
import type { CanonicalMessage, GenerationEventPayload } from '@/core/types';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

function makeRunnerSetup(opts: {
    contextSize?: number;
    maxTokens?: number;
    model?: string;
    sessionMode?: 'persistent' | 'ephemeral';
    stream?: boolean;
    extraTools?: ToolDefinition[];
    enabledTools?: string[];
    watermark?: { high: number; low: number };
    maxToolRounds?: number;
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: {
            userName: 'Tester',
            charName: 'Assistant',
            characterAvatar: 'assistant.png',
            personaAvatar: 'tester.png',
        },
        characterFields: {
            description: 'Mainline test investigator.',
        },
    });
    bridge.pushMessage({ id: 0, name: 'Tester', isUser: true, mes: 'Start session' });
    bridge.pushMessage({ id: 1, name: 'Assistant', isUser: false, mes: '', swipeId: 0 });

    const conn = createDefaultConnection({
        id: 'conn_main',
        model: opts.model ?? 'gemini-2.5-pro',
        contextSize: opts.contextSize ?? 128_000,
        maxTokens: opts.maxTokens ?? 4_096,
        stream: opts.stream ?? true,
    });
    const mainAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: 'conn_main',
        sessionMode: opts.sessionMode ?? 'persistent',
        maxToolRounds: opts.maxToolRounds ?? 6,
        ...(opts.watermark ? { watermark: opts.watermark } : {}),
        enabledTools: opts.enabledTools ?? [
            'list_dir',
            'read_file',
            'write_file',
            'edit_file',
        ],
        permissions: {
            read: ['/**'],
            write: ['/memory/**', '/notes/**', '/output.md'],
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

    return { bridge, conn, mainAgent, preset, settings, traceLogger, transport, runner };
}

describe('ToolRegistry 32 KB output gate', () => {
    it('passes small outputs through untouched, emits JSON Key Manifest for oversized objects, and truncates + spills oversized text', async () => {
        const bridge = new MemoryHostBridge();
        const spillStore = new TransientToolSpillStore();
        const registry = new ToolRegistry(
            [
                {
                    name: 'small_tool',
                    description: 'Returns a small payload',
                    parameters: z.object({}),
                    execute: async () => 'short ok output',
                },
                {
                    name: 'huge_object_tool',
                    description: 'Returns an oversized structured JSON object',
                    parameters: z.object({}),
                    execute: async () => ({
                        smallMeta: { version: 1, tag: 'meta' },
                        massivePayload: 'X'.repeat(42_000),
                        mediumList: Array.from({ length: 120 }, (_, i) => `item_${i}_${'M'.repeat(40)}`),
                    }),
                },
                {
                    name: 'huge_text_tool',
                    description: 'Returns an oversized multi-line text document',
                    parameters: z.object({}),
                    execute: async () =>
                        Array.from(
                            { length: 400 },
                            (_, idx) => `Line ${String(idx + 1).padStart(3, '0')}: ${'A'.repeat(110)}`,
                        ).join('\n'),
                },
            ],
            { spillStore },
        );

        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        // 1. Small output <= 32 KB passes through untouched
        const smallRes = await registry.executeToolCall('small_tool', {}, ctx, {
            toolCallId: 'call_small',
        });
        expect(smallRes.ok).toBe(true);
        expect(smallRes.output).toBe('short ok output');
        expect(smallRes.truncated).toBeUndefined();
        expect(smallRes.spillPath).toBeUndefined();
        expect(spillStore.size).toBe(0);

        // 2. Oversized JSON object > 32 KB produces descending-size Key Manifest + spill entry
        const objRes = await registry.executeToolCall('huge_object_tool', {}, ctx, {
            toolCallId: 'call_obj_1',
            scopeId: 'scope_a',
        });
        expect(objRes.ok).toBe(true);
        expect(objRes.truncated).toBe(true);
        expect(objRes.originalBytes).toBeGreaterThan(DEFAULT_MAX_TOOL_RESULT_BYTES);
        expect(utf8ByteLength(objRes.output)).toBeLessThanOrEqual(DEFAULT_MAX_TOOL_RESULT_BYTES);
        expect(objRes.spillPath).toBe('/tmp/tool-spill/call_obj_1.json');

        const manifestPayload = JSON.parse(objRes.output) as {
            truncated: boolean;
            tool: string;
            spillPath: string;
            manifest: Array<{ key: string; type: string; bytes: number; itemCount?: number }>;
        };
        expect(manifestPayload.truncated).toBe(true);
        expect(manifestPayload.tool).toBe('huge_object_tool');
        expect(manifestPayload.spillPath).toBe('/tmp/tool-spill/call_obj_1.json');
        expect(manifestPayload.manifest[0].key).toBe('massivePayload');
        expect(manifestPayload.manifest[1].key).toBe('mediumList');
        expect(manifestPayload.manifest[1].itemCount).toBe(120);
        expect(manifestPayload.manifest[0].bytes).toBeGreaterThan(manifestPayload.manifest[1].bytes);

        // 3. Oversized plain text > 32 KB emits head (120) + omission banner + tail (30) + spill pointer
        const textRes = await registry.executeToolCall('huge_text_tool', {}, ctx, {
            toolCallId: 'call_txt_1',
            scopeId: 'scope_b',
        });
        expect(textRes.ok).toBe(true);
        expect(textRes.truncated).toBe(true);
        expect(textRes.originalBytes).toBeGreaterThan(DEFAULT_MAX_TOOL_RESULT_BYTES);
        expect(utf8ByteLength(textRes.output)).toBeLessThanOrEqual(DEFAULT_MAX_TOOL_RESULT_BYTES);
        expect(textRes.spillPath).toBe('/tmp/tool-spill/call_txt_1.txt');
        expect(textRes.output).toContain('Line 001:');
        expect(textRes.output).toContain('Line 120:');
        expect(textRes.output).toContain('Line 400:');
        expect(textRes.output).toContain('omitted');
        expect(textRes.output).toContain('/tmp/tool-spill/call_txt_1.txt');

        // Verify spill store holds full text and supports slice + scoped cleanup
        expect(registry.getSpillStore()).toBe(spillStore);
        expect(spillStore.readSlice('/tmp/tool-spill/call_txt_1.txt', 200, 201)).toContain('Line 200:');
        registry.clearSpillStore('scope_a');
        expect(spillStore.get('/tmp/tool-spill/call_obj_1.json')).toBeNull();
        expect(spillStore.get('/tmp/tool-spill/call_txt_1.txt')).not.toBeNull();
        registry.clearSpillStore();
        expect(spillStore.size).toBe(0);
    });

    it('preserves output gate options across clone() and supports disabling via setOutputGateOptions or per-call options', async () => {
        const bridge = new MemoryHostBridge();
        const spillStore = new TransientToolSpillStore();
        const base = new ToolRegistry(
            [
                {
                    name: 'big_blob',
                    description: 'Returns a 40 KB string',
                    parameters: z.object({}),
                    execute: async () => 'Z'.repeat(40_000),
                },
            ],
            { maxToolResultBytes: 4096, spillStore },
        );

        const cloned = base.clone();
        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const gated = await cloned.executeToolCall('big_blob', {}, ctx, { toolCallId: 'c_gated' });
        expect(gated.truncated).toBe(true);
        expect(utf8ByteLength(gated.output)).toBeLessThanOrEqual(4096);
        expect(cloned.getSpillStore()).toBe(spillStore);

        // Per-call opt-out bypasses truncation
        const ungated = await cloned.executeToolCall('big_blob', {}, ctx, {
            enableOutputGate: false,
        });
        expect(ungated.truncated).toBeUndefined();
        expect(ungated.output.length).toBe(40_000);

        // setOutputGateOptions disables gate at registry level
        cloned.setOutputGateOptions({ enableOutputGate: false });
        const afterDisable = await cloned.executeToolCall('big_blob', {}, ctx);
        expect(afterDisable.truncated).toBeUndefined();
        expect(afterDisable.output.length).toBe(40_000);
    });
});

describe('AgentRunner pre-flight budget check & context overflow auto-recovery', () => {
    it('triggers pre-flight WatermarkCompactor compaction before sending oversized persistent history', async () => {
        const { conn, transport, runner } = makeRunnerSetup({
            contextSize: 4_096,
            maxTokens: 1_024,
            model: 'small-window-model',
            stream: false,
        });
        const budget = resolveEffectiveContextBudget(conn);

        // Seed 5 sizable historical turns in TrajectoryStore so Layer 0 + Layer 1 + Layer 2 exceeds preFlightThreshold
        for (let turn = 1; turn <= 5; turn += 1) {
            runner.trajectoryStore.appendTurn(
                [
                    {
                        role: 'user',
                        content: `Historical turn ${turn} prompt: ${'alpha '.repeat(260)}`,
                    },
                    {
                        role: 'assistant',
                        content: `Historical turn ${turn} reply: ${'beta '.repeat(260)}`,
                    },
                ],
                'main',
            );
        }
        const layer1CountBefore = runner.trajectoryStore.getMessageCount('main');
        expect(layer1CountBefore).toBe(10);

        const compactSpy = vi.spyOn(runner.watermarkCompactor, 'compact');

        transport.enqueue({
            content: 'Pre-flight compacted reply ok.',
            usage: { inputTokens: 800, cachedTokens: 0, outputTokens: 20 },
        });

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            requireOutputFile: false,
            userInput: 'Summarize current progress concisely.',
        });

        expect(res.content).toBe('Pre-flight compacted reply ok.');
        // Compact ran proactively before the single LLM call; zero extra LLM summary calls made
        expect(compactSpy).toHaveBeenCalledTimes(1);
        expect(transport.requests).toHaveLength(1);
        expect(runner.trajectoryStore.getArchivedUpToChunk('main')).toBeGreaterThanOrEqual(1);
        expect(await runner.vfs.exists('/history/chunk-001.md')).toBe(true);

        // Outgoing request sent to LLM is strictly reduced below preFlightThreshold
        const sentTokens = estimateRequestTokens(
            transport.requests[0].messages,
            transport.requests[0].tools,
        );
        expect(sentTokens).toBeLessThan(budget.preFlightThreshold);
        expect(
            transport.requests[0].messages.some(
                (m) =>
                    m.role === 'system'
                    && typeof m.content === 'string'
                    && (m.content.startsWith('<history-summary') || m.content.startsWith('<history-archive-index>')),
            ),
        ).toBe(true);
    });

    it('folds oversized earlier in-flight tool messages during pre-flight while preserving toolCallId pairing', async () => {
        const { conn, transport, runner } = makeRunnerSetup({
            contextSize: 4_096,
            maxTokens: 1_024,
            model: 'small-window-model',
            stream: false,
            enabledTools: ['fetch_chunk'],
        });
        const budget = resolveEffectiveContextBudget(conn);

        const fetchChunkTool: ToolDefinition = {
            name: 'fetch_chunk',
            description: 'Fetch a data chunk',
            parameters: z.object({ id: z.string() }),
            execute: async (rawArgs) => {
                const { id } = rawArgs as { id: string };
                return `chunk:${id}:${'D'.repeat(5_000)}`;
            },
        };

        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    { id: 'call_r1', name: 'fetch_chunk', arguments: JSON.stringify({ id: 'one' }) },
                ],
            },
            {
                content: '',
                toolCalls: [
                    { id: 'call_r2', name: 'fetch_chunk', arguments: JSON.stringify({ id: 'two' }) },
                ],
            },
            {
                content: 'Done after pre-flight in-flight tool folding.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            requireOutputFile: false,
            extraTools: [fetchChunkTool],
            userInput: 'Fetch both chunks and conclude.',
        });

        expect(res.content).toBe('Done after pre-flight in-flight tool folding.');
        expect(transport.requests).toHaveLength(3);

        // Inspect 3rd request: both tool nodes MUST remain present with intact toolCallIds,
        // while earlier oversized tool output was folded in-place.
        const thirdReq = transport.requests[2];
        const toolMsgs = thirdReq.messages.filter((m) => m.role === 'tool');
        expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['call_r1', 'call_r2']);
        expect(String(toolMsgs[0].content)).toContain('[已折叠本轮早期工具输出:');
        expect(
            estimateRequestTokens(thirdReq.messages, thirdReq.tools),
        ).toBeLessThan(budget.preFlightThreshold);
    });

    it('recovers automatically from Gemini ContextOverflowError without LLM summary calls, crops in-flight tool results in-place preserving toolCallId, and succeeds on retry', async () => {
        const { transport, runner } = makeRunnerSetup({
            contextSize: 1_048_576,
            maxTokens: 8_192,
            model: 'gemini-2.5-pro',
            stream: true,
            enabledTools: ['dump_records', 'write_file', 'read_file', 'append_file', 'edit_file'],
        });

        // Seed 2 historical turns so emergency compaction also compacts Layer 1
        runner.trajectoryStore.appendTurn(
            [
                { role: 'user', content: `Earlier quest context: ${'history '.repeat(300)}` },
                { role: 'assistant', content: `Earlier quest reply: ${'notes '.repeat(300)}` },
            ],
            'main',
        );
        runner.trajectoryStore.appendTurn(
            [
                { role: 'user', content: `Second quest context: ${'detail '.repeat(300)}` },
                { role: 'assistant', content: `Second quest reply: ${'log '.repeat(300)}` },
            ],
            'main',
        );

        const dumpRecordsTool: ToolDefinition = {
            name: 'dump_records',
            description: 'Return records payload',
            parameters: z.object({ kind: z.enum(['big', 'tiny']) }),
            execute: async (rawArgs) => {
                const { kind } = rawArgs as { kind: 'big' | 'tiny' };
                return kind === 'big'
                    ? `RECORDS_START\n${'record_payload_line\n'.repeat(400)}RECORDS_END`
                    : '{"ok":true}';
            },
        };

        const compactSpy = vi.spyOn(runner.watermarkCompactor, 'compact');

        // Round 1: invokes big + tiny tools
        // Round 2 (attempt 1): streams partial /output.md write delta then throws Gemini ContextOverflowError
        // Round 2 (retry): succeeds cleanly and writes final /output.md
        // Round 3: final review turn completes
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    { id: 'call_big_1', name: 'dump_records', arguments: JSON.stringify({ kind: 'big' }) },
                    { id: 'call_tiny_2', name: 'dump_records', arguments: JSON.stringify({ kind: 'tiny' }) },
                ],
            },
            {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'call_partial_bad',
                        toolName: 'write_file',
                        argumentsDelta: '{"path":"/output.md","content":"PARTIAL_CORRUPTED_',
                    },
                ],
                errorAfterChunks: 1,
                error: new LLMTransportError(
                    'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
                    { status: 400 },
                ),
            },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'call_write_final',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: 'Recovered clean final narrative.',
                        }),
                    },
                ],
            },
            {
                content: 'Verified recovered output.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            extraTools: [dumpRecordsTool],
            userInput: 'Inspect records and respond.',
        });

        expect(res.content).toBe('Recovered clean final narrative.');
        // Exact transport calls: Round 1 (1) + Round 2 overflow (1) + Round 2 recovery retry (1) + Round 3 review (1) = 4
        // Proves ZERO extra LLM summary calls were issued during emergency recovery!
        expect(transport.requests).toHaveLength(4);
        expect(compactSpy).toHaveBeenCalledTimes(1);
        expect(compactSpy.mock.calls[0]?.[1]?.summarizeChunk).toBeUndefined();
        expect(await runner.vfs.exists('/history/chunk-001.md')).toBe(true);

        // Compare failed Round 2 request (index 1) vs retried Round 2 request (index 2)
        const failedReq = transport.requests[1];
        const retriedReq = transport.requests[2];

        const failedTools = failedReq.messages.filter((m) => m.role === 'tool');
        const retriedTools = retriedReq.messages.filter((m) => m.role === 'tool');

        // Tool node count and toolCallId pairing strictly preserved
        expect(retriedTools.map((m) => m.toolCallId)).toEqual(['call_big_1', 'call_tiny_2']);
        expect(retriedTools.map((m) => m.toolName)).toEqual(['dump_records', 'dump_records']);

        // Oversized tool message cropped in-place referencing limitTokens & original size
        expect(String(failedTools[0].content)).toContain('RECORDS_START');
        expect(String(retriedTools[0].content)).toContain('[输出因触发模型上下文上限');
        expect(String(retriedTools[0].content)).toContain('1048576');
        expect(String(retriedTools[0].content).length).toBeLessThan(String(failedTools[0].content).length);

        // Tiny tool output left intact
        expect(retriedTools[1].content).toBe('{"ok":true}');

        // Assistant toolCalls still match the retained tool messages 1-to-1
        const assistantWithCalls = retriedReq.messages.find(
            (m): m is CanonicalMessage => m.role === 'assistant' && Boolean(m.toolCalls?.length),
        );
        expect(assistantWithCalls?.toolCalls?.map((tc) => tc.id)).toEqual(['call_big_1', 'call_tiny_2']);
    });

    it('recovers from OpenAI context_length_exceeded error for ephemeral agents as well', async () => {
        const { bridge, transport, runner } = makeRunnerSetup({
            contextSize: 32_000,
            maxTokens: 2_048,
            model: 'gpt-4o',
            sessionMode: 'ephemeral',
            stream: false,
        });

        for (let i = 2; i <= 7; i += 1) {
            bridge.pushMessage({
                id: i,
                name: i % 2 === 0 ? 'Tester' : 'Assistant',
                isUser: i % 2 === 0,
                mes: `Chat message #${i}: ${'lorem '.repeat(120)}`,
                swipeId: 0,
            });
        }

        transport.enqueue(
            {
                error: new LLMTransportError(
                    "This model's maximum context length is 8192 tokens. However, your messages resulted in 12450 tokens.",
                    { status: 400, code: 'context_length_exceeded' },
                ),
            },
            {
                content: 'Ephemeral recovered response.',
            },
        );

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 7, swipeId: 0 },
            phase: 'after_turn',
            requireOutputFile: false,
            userInput: 'Produce summary.',
        });

        expect(res.content).toBe('Ephemeral recovered response.');
        expect(transport.requests).toHaveLength(2);
        expect(transport.requests[1].messages.length).toBeLessThan(
            transport.requests[0].messages.length,
        );
    });

    it('stops after at most 1 auto-recovery retry on double ContextOverflowError and records trace telemetry', async () => {
        const { traceLogger, transport, runner } = makeRunnerSetup({
            contextSize: 128_000,
            maxTokens: 4_096,
            model: 'gpt-4o',
            stream: false,
        });

        const events: GenerationEventPayload[] = [];
        traceLogger.subscribe((ev) => events.push(ev));

        const overflowError1 = new LLMTransportError(
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 15000 tokens.",
            { status: 400, code: 'context_length_exceeded' },
        );
        const overflowError2 = new LLMTransportError(
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9200 tokens.",
            { status: 400, code: 'context_length_exceeded' },
        );

        // Enqueue a 3rd turn that MUST NEVER be consumed
        transport.enqueue(
            { error: overflowError1 },
            { error: overflowError2 },
            { content: 'SHOULD_NEVER_BE_REACHED' },
        );

        let caught: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                requireOutputFile: false,
                userInput: 'Giant prompt that still overflows even after recovery.',
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(AgentExecutionError);
        const execErr = caught as AgentExecutionError;
        expect(execErr.message).toContain('maximum context length is 8192');
        expect(execErr.trace.status).toBe('error');
        expect(execErr.trace.error).toContain('8192');

        // Strictly 2 transport calls: initial attempt + 1 recovery retry (3rd turn untouched!)
        expect(transport.requests).toHaveLength(2);
        expect(transport.remainingTurns).toBe(1);

        // Trace telemetry event emitted with error details
        const traceEvents = events.filter((e) => e.kind === 'trace_recorded');
        expect(traceEvents.length).toBeGreaterThanOrEqual(1);
        expect(traceEvents[traceEvents.length - 1].trace?.status).toBe('error');
        expect(traceEvents[traceEvents.length - 1].error).toContain('8192');
    });

    it('surfaces TurnInterruptedError cleanly on double overflow after tool progress in main_turn', async () => {
        const { transport, runner } = makeRunnerSetup({
            contextSize: 128_000,
            maxTokens: 4_096,
            model: 'gemini-2.5-pro',
            stream: false,
            enabledTools: ['tiny_tool', 'write_file', 'read_file', 'append_file', 'edit_file'],
        });

        const tinyTool: ToolDefinition = {
            name: 'tiny_tool',
            description: 'Small tool',
            parameters: z.object({}),
            execute: async () => 'ok',
        };

        transport.enqueue(
            {
                content: '',
                toolCalls: [{ id: 'c_1', name: 'tiny_tool', arguments: '{}' }],
            },
            {
                error: new LLMTransportError(
                    'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1500000',
                    { status: 400 },
                ),
            },
            {
                error: new LLMTransportError(
                    'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1200000',
                    { status: 400 },
                ),
            },
            { content: 'SHOULD_NOT_RUN' },
        );

        let caught: unknown;
        try {
            await runner.run({
                agent: 'main',
                target: { messageId: 1, swipeId: 0 },
                phase: 'main_turn',
                extraTools: [tinyTool],
                userInput: 'Run tool then double overflow.',
            });
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(TurnInterruptedError);
        const interrupted = caught as TurnInterruptedError;
        expect(interrupted.reason).toBe('error');
        expect(interrupted.trace.status).toBe('interrupted');
        expect(interrupted.causeError).toContain('1048576');
        // 1 (round 1) + 2 (round 2 overflow + single retry) = 3 calls total
        expect(transport.requests).toHaveLength(3);
        expect(transport.remainingTurns).toBe(1);
    });
});
