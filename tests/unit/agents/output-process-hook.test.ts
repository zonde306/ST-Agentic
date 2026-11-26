import { describe, expect, it } from 'vitest';
import { AgentRunner, FINISH_TURN_TOOL_NAME } from '@/core/agents';
import { AssistantRunner } from '@/core/assistant';
import {
    DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS,
    PROMPT_TRANSFORM_EVENTS,
    createOutputProcessPayload,
    finalizeOutputProcessPayload,
    formatOutputFixFeedback,
    type LLMRequest,
    type LLMResponse,
    type LLMStreamChunk,
    type LLMTransport,
    type OutputProcessPayload,
} from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { SideGenService } from '@/core/sidegen';
import type { ApiConnection, AgentProfile, PromptBlock } from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { VirtualFileSystem, OUTPUT_FILE_PATH } from '@/core/vfs';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import {
    MemoryHostBridge,
    ScriptedLLMTransport,
    type ScriptedTurnInput,
} from '../../mocks';

class RecordingTransport implements LLMTransport {
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
                this.inner.enqueue((capturedReq, idx) => turn(this.requests[idx] ?? capturedReq, idx));
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
            toolChoice: request.toolChoice ? canonicalClone(request.toolChoice) : undefined,
            cacheBreakpoints: request.cacheBreakpoints ? [...request.cacheBreakpoints] : undefined,
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

function makeAgentSetup(opts: {
    strictToolLoop?: boolean;
    roundMaxRetries?: number;
    maxToolRounds?: number;
    stream?: boolean;
    phase?: 'main_turn' | 'before_turn';
    agentOverride?: Partial<AgentProfile>;
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: { userName: 'Player', charName: 'Aria' },
    });
    bridge.pushMessage({ id: 0, name: 'Player', isUser: true, mes: 'Go.' });
    bridge.pushMessage({ id: 1, name: 'Aria', isUser: false, mes: '', swipeId: 0 });

    const conn = createDefaultConnection({
        id: 'conn_out',
        model: 'gemini-2.5-pro',
        stream: opts.stream ?? false,
        strictToolLoop: opts.strictToolLoop ?? true,
        roundMaxRetries: opts.roundMaxRetries ?? 2,
    });

    const mainAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: conn.id,
        sessionMode: 'persistent',
        maxToolRounds: opts.maxToolRounds ?? 6,
        strictToolLoop: 'inherit',
        enabledTools: [
            'list_dir',
            'read_file',
            'write_file',
            'append_file',
            'edit_file',
        ],
        permissions: {
            read: ['/**'],
            write: ['/memory/**', '/notes/**', '/state/variables.json'],
        },
        ...opts.agentOverride,
    });

    const subAgent: AgentProfile = {
        id: 'sub_worker',
        name: 'Sub Worker',
        sessionMode: 'ephemeral',
        connectionId: conn.id,
        strictToolLoop: 'inherit',
        maxToolRounds: 4,
        enabledTools: ['read_file'],
        permissions: { read: ['/**'], write: [] },
        promptBlocks: [
            {
                id: 'sub_sys',
                name: 'Sub System',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content: 'Return structured output.',
                triggers: ['trigger_before', 'subagent'],
            },
        ],
    };

    const preset = createDefaultPreset({
        id: 'preset_out',
        mainAgentId: 'main',
        agents: {
            main: mainAgent,
            sub_worker: subAgent,
        },
    });

    const settings = createDefaultSettings({
        connections: { [conn.id]: conn },
        currentConnectionId: conn.id,
        presets: { [preset.id]: preset },
        currentPresetId: preset.id,
    });

    const transport = new RecordingTransport();
    const vfs = new VirtualFileSystem({ bridge });
    const runner = new AgentRunner({
        bridge,
        transport,
        settings,
        vfs,
        traceLogger: new TraceLogger({ maxTraces: 100 }),
        roundRetryInitialDelayMs: 0,
        roundRetryMaxDelayMs: 0,
    });

    return { bridge, vfs, transport, runner, mainAgent, subAgent };
}

function makeAssistantHarness(
    turns: ScriptedTurnInput[],
    opts?: {
        strictToolLoop?: boolean;
        roundMaxRetries?: number;
        stream?: boolean;
    },
) {
    const bridge = createOffMainlineTestBridge();
    const transport = new RecordingTransport(turns);
    const trajectoryStore = new TrajectoryStore();
    const settings = createDefaultSettings();
    settings.connections.default = {
        ...settings.connections.default,
        strictToolLoop: opts?.strictToolLoop ?? true,
        roundMaxRetries: opts?.roundMaxRetries ?? 2,
        stream: opts?.stream ?? false,
    };
    const preset = settings.presets[settings.currentPresetId];
    const mainAgent = preset.agents[preset.mainAgentId];
    mainAgent.promptBlocks = [
        ...mainAgent.promptBlocks,
        {
            id: 'assistant_hook_block',
            name: 'Assistant Hook Block',
            role: 'system',
            placement: 'prefix',
            enabled: true,
            triggers: ['assistant'],
            content: 'Assistant context note.',
        },
    ];

    const runner = new AssistantRunner({
        bridge,
        transport,
        trajectoryStore,
        settings,
        stream: opts?.stream ?? false,
        autoRetry: { initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
    });

    return { bridge, transport, trajectoryStore, runner };
}

function makeSideGenHarness(
    turns: ScriptedTurnInput[],
    opts?: {
        connection?: Partial<ApiConnection>;
        extraPromptBlocks?: PromptBlock[];
    },
) {
    const bridge = createOffMainlineTestBridge();
    const transport = new RecordingTransport(turns);
    const trajectoryStore = new TrajectoryStore();
    const settings = createDefaultSettings();
    const conn = createDefaultConnection({
        id: 'side-hook',
        model: 'gemini-2.5-flash',
        strictToolLoop: true,
        roundMaxRetries: 2,
        stream: false,
        ...opts?.connection,
    });
    settings.connections['side-hook'] = conn;
    const preset = settings.presets[settings.currentPresetId];
    const mainAgent = preset.agents[preset.mainAgentId];
    mainAgent.promptBlocks = [
        ...mainAgent.promptBlocks,
        {
            id: 'sidegen_hook_block',
            name: 'SideGen Hook Block',
            role: 'system',
            placement: 'prefix',
            enabled: true,
            triggers: ['sidegen'],
            content: 'SideGen context note.',
        },
        ...(opts?.extraPromptBlocks ?? []),
    ];

    const service = new SideGenService({
        bridge,
        transport,
        trajectoryStore,
        getDefaultConnectionId: () => 'side-hook',
        getSettings: () => settings,
        resolveConnection: (id) => settings.connections[id],
        roundRetry: { initialDelayMs: 0, maxDelayMs: 0, backoffFactor: 1 },
    });

    return { bridge, transport, service };
}

describe('agentic_output_process contract & runners integration', () => {
    it('enforces monotonic retry > fix > accept priority and non-string text guard', () => {
        expect(PROMPT_TRANSFORM_EVENTS.OUTPUT_PROCESS).toBe('agentic_output_process');

        const payload = createOutputProcessPayload({
            text: 'initial output',
            meta: {
                runner: 'agent',
                stage: 'turn_finish',
                operation: 'finish_turn',
                sessionId: 'run_1',
                round: 1,
                retryAttempt: 0,
                maxRetries: 2,
                fixAttempt: 0,
                maxFixAttempts: DEFAULT_MAX_OUTPUT_FIX_ATTEMPTS,
            },
        });

        payload.control.requestFix('syntax issue', { rejectWrite: true, extId: 'ext-a' });
        expect(payload.control.action).toBe('fix');
        expect(payload.control.rejectWrite).toBe(true);

        payload.control.retry('regenerate please', 'ext-b');
        // Retry beats fix monotonically; subsequent requestFix cannot downgrade retry.
        payload.control.requestFix('another issue', { extId: 'ext-c' });
        expect(payload.control.action).toBe('retry');
        expect(payload.control.retryReason).toBe('regenerate please');
        expect(payload.control.requestedBy).toBe('ext-b');

        // Non-string corruption falls back to originalText cleanly.
        (payload as unknown as { text: unknown }).text = { broken: true };
        const result = finalizeOutputProcessPayload(payload, 'initial output');
        expect(result.text).toBe('initial output');
        expect(result.changed).toBe(false);
        expect(result.action).toBe('retry');

        expect(
            formatOutputFixFeedback('unclosed tag', {
                stage: 'output_mutation',
                operation: 'write_file',
                rejectWrite: true,
                requestedBy: 'validator',
            }),
        ).toContain('rejected and NOT saved');
    });

    it('AgentRunner: rewrites /output.md on write_file/edit_file, skips non-output tools & intermediate content', async () => {
        const { bridge, vfs, transport, runner, mainAgent } = makeAgentSetup({ strictToolLoop: true });
        const events: OutputProcessPayload[] = [];

        bridge.onOutputProcess((payload) => {
            events.push({
                ...payload,
                meta: { ...payload.meta },
            });
            if (payload.meta.stage === 'output_mutation') {
                payload.text = payload.text.replace('[RAW]', '[SANITIZED]');
            }
        });

        transport.enqueue(
            // Round 1: ordinary non-output write & intermediate assistant.content -> MUST NOT trigger hook
            {
                content: 'Thinking through notes before drafting.',
                toolCalls: [
                    {
                        id: 'note_1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/notes/scratch.md', content: '[RAW] note' }),
                    },
                ],
            },
            // Round 2: write_file to /output.md -> triggers output_mutation rewrite
            {
                toolCalls: [
                    {
                        id: 'out_write_1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'Hello [RAW]' }),
                    },
                ],
            },
            // Round 3: edit_file on /output.md -> sees simulated full text + previousText, rewrites [RAW]
            {
                toolCalls: [
                    {
                        id: 'out_edit_1',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            search: 'Hello [SANITIZED]',
                            replace: 'Hello [SANITIZED] + [RAW]',
                        }),
                    },
                ],
            },
            // Round 4: finish_turn -> triggers turn_finish with final sanitized /output.md
            {
                toolCalls: [
                    {
                        id: 'ft_1',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Done' }),
                    },
                ],
            },
        );

        const result = await runner.run({
            agent: mainAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });

        expect(result.content).toBe('Hello [SANITIZED] + [SANITIZED]');
        expect(await vfs.readFile(OUTPUT_FILE_PATH, { target: { messageId: 1, swipeId: 0 }, staged: true }))
            .toBe('Hello [SANITIZED] + [SANITIZED]');
        expect(await vfs.readFile('/notes/scratch.md', { target: { messageId: 1, swipeId: 0 }, staged: true }))
            .toBe('[RAW] note');

        expect(events).toHaveLength(3);
        expect(events[0].meta.stage).toBe('output_mutation');
        expect(events[0].meta.operation).toBe('write_file');
        expect(events[0].meta.messageId).toBe(1);
        expect(events[0].meta.swipeId).toBe(0);
        expect(events[0].meta.target).toEqual({ messageId: 1, swipeId: 0 });
        expect(events[1].meta.stage).toBe('output_mutation');
        expect(events[1].meta.operation).toBe('edit_file');
        expect(events[1].meta.previousText).toBe('Hello [SANITIZED]');
        expect(events[2].meta.stage).toBe('turn_finish');
        expect(events[2].meta.operation).toBe('finish_turn');
        expect(events[2].meta.messageId).toBe(1);
        expect(events[2].meta.swipeId).toBe(0);
        expect(events[2].meta.target).toEqual({ messageId: 1, swipeId: 0 });
        expect(events[2].originalText).toBe('Hello [SANITIZED] + [SANITIZED]');
    });

    it('AgentRunner: output_mutation retry honors roundMaxRetries & stops retrying when exhausted', async () => {
        const { bridge, transport, runner, mainAgent } = makeAgentSetup({
            strictToolLoop: true,
            roundMaxRetries: 2,
        });
        const seenRetryAttempts: number[] = [];

        bridge.onOutputProcess((payload) => {
            if (payload.meta.stage === 'output_mutation') {
                seenRetryAttempts.push(payload.meta.retryAttempt);
                payload.control.retry('unbalanced custom tag', 'lint-ext');
            }
        });

        transport.enqueue(
            // Retry 0 -> retry() thrown before tool executes
            {
                toolCalls: [
                    {
                        id: 'out_bad_0',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'bad draft 0' }),
                    },
                ],
            },
            // Retry 1 -> retry() thrown before tool executes
            {
                toolCalls: [
                    {
                        id: 'out_bad_1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'bad draft 1' }),
                    },
                ],
            },
            // Retry 2 (exhausted: retryAttempt === maxRetries === 2) -> accepted without throwing!
            {
                toolCalls: [
                    {
                        id: 'out_bad_2',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'accepted fallback 2' }),
                    },
                ],
            },
            // Round 2: finish_turn
            {
                toolCalls: [
                    {
                        id: 'ft_after_retry',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Finished' }),
                    },
                ],
            },
        );

        const result = await runner.run({
            agent: mainAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });

        expect(seenRetryAttempts).toEqual([0, 1, 2]);
        expect(result.content).toBe('accepted fallback 2');
        expect(result.trace.retryCount).toBe(2);
    });

    it('AgentRunner: requestFix rejectWrite blocks writes up to maxFixAttempts, then allows after limit exhausted', async () => {
        const { bridge, transport, runner, mainAgent } = makeAgentSetup({
            strictToolLoop: true,
            maxToolRounds: 8,
        });
        const seenFixAttempts: number[] = [];

        bridge.onOutputProcess((payload) => {
            if (payload.meta.stage === 'output_mutation') {
                seenFixAttempts.push(payload.meta.fixAttempt);
                if (payload.text.includes('<broken>')) {
                    payload.control.requestFix('Missing closing </broken> tag', {
                        rejectWrite: true,
                        extId: 'tag-checker',
                    });
                }
            }
        });

        transport.enqueue(
            // Fix attempt 0, 1, 2 rejected; 4th (fixAttempt === 3 === maxFixAttempts) goes through!
            {
                toolCalls: [
                    {
                        id: 'w1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '<broken> 1' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 'w2',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '<broken> 2' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 'w3',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '<broken> 3' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 'w4',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '<broken> 4' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 'ft_fix_limit',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Completed after fix cap' }),
                    },
                ],
            },
        );

        const result = await runner.run({
            agent: mainAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });

        expect(seenFixAttempts).toEqual([0, 1, 2, 3]);
        expect(result.toolSteps[0].ok).toBe(false);
        expect(result.toolSteps[0].result).toContain('rejected and NOT saved');
        expect(result.toolSteps[1].ok).toBe(false);
        expect(result.toolSteps[2].ok).toBe(false);
        expect(result.toolSteps[3].ok).toBe(true);
        expect(result.content).toBe('<broken> 4');
    });

    it('AgentRunner: soft fix warns in tool_result and finish_turn rejection asks model to revise', async () => {
        const { bridge, transport, runner, mainAgent } = makeAgentSetup({
            strictToolLoop: true,
            maxToolRounds: 6,
        });

        bridge.onOutputProcess((payload) => {
            if (payload.meta.stage === 'output_mutation' && payload.text.includes('SOFT_WARN')) {
                payload.control.requestFix('Draft still contains SOFT_WARN marker');
            }
            if (payload.meta.stage === 'turn_finish' && payload.text.includes('FINISH_BAD')) {
                payload.control.requestFix('Final output cannot include FINISH_BAD');
            }
        });

        transport.enqueue(
            {
                toolCalls: [
                    {
                        id: 'w_soft',
                        name: 'write_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            content: 'SOFT_WARN and FINISH_BAD',
                        }),
                    },
                ],
            },
            // Model tries to finish_turn right away -> blocked by turn_finish requestFix
            {
                toolCalls: [
                    {
                        id: 'ft_reject',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Try finish' }),
                    },
                ],
            },
            // Model edits /output.md to fix both issues
            {
                toolCalls: [
                    {
                        id: 'e_clean',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            search: 'SOFT_WARN and FINISH_BAD',
                            replace: 'Clean final prose',
                        }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 'ft_ok',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Clean finish' }),
                    },
                ],
            },
        );

        const result = await runner.run({
            agent: mainAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });

        expect(result.toolSteps[0].ok).toBe(true);
        expect(JSON.parse(result.toolSteps[0].result).validationWarning).toContain('SOFT_WARN');
        expect(result.toolSteps[1].ok).toBe(false);
        expect(result.toolSteps[1].error).toContain('FINISH_BAD');
        expect(result.content).toBe('Clean final prose');
    });

    it('AgentRunner: works when strictToolLoop is disabled (plain_finish) & for non-main return_value agent retry', async () => {
        const { bridge, transport, runner, mainAgent, subAgent } = makeAgentSetup({
            strictToolLoop: false,
            roundMaxRetries: 1,
            maxToolRounds: 5,
        });
        const observedOps: Array<{ stage: string; op: string; mode?: string }> = [];

        bridge.onOutputProcess((payload) => {
            observedOps.push({
                stage: payload.meta.stage,
                op: payload.meta.operation,
                mode: payload.meta.finishMode,
            });
            if (payload.meta.runner === 'agent' && payload.meta.agentId === 'main') {
                if (payload.meta.stage === 'turn_finish' && payload.text === 'needs more detail') {
                    payload.control.requestFix('Expand ending');
                    return;
                }
                if (payload.meta.stage === 'turn_finish') {
                    payload.text = `${payload.text} [FINALIZED]`;
                }
            } else if (payload.meta.agentId === 'sub_worker') {
                if (payload.text === 'sub bad') {
                    payload.control.retry('sub retry');
                }
            }
        });

        transport.enqueue(
            // Main run (no strictToolLoop): write /output.md then return plain text finish
            {
                toolCalls: [
                    {
                        id: 'plain_w1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'needs more detail' }),
                    },
                ],
            },
            { content: 'All done.' },
            // Model receives feedback, rewrites /output.md cleanly, then plain-finishes again
            {
                toolCalls: [
                    {
                        id: 'plain_w2',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'Detailed chapter' }),
                    },
                ],
            },
            { content: 'All done now.' },
        );

        const mainResult = await runner.run({
            agent: mainAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });

        expect(mainResult.content).toBe('Detailed chapter [FINALIZED]');
        expect(observedOps).toContainEqual({
            stage: 'turn_finish',
            op: 'plain_finish',
            mode: 'plain_text',
        });

        // Verify non-main return_value subagent supports control.retry() in plain_finish mode
        transport.enqueue(
            { content: 'sub bad' },
            { content: 'sub good' },
        );
        const subResult = await runner.run({
            agent: subAgent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'before_turn',
        });
        expect(subResult.content).toBe('sub good');
        expect(subResult.trace.retryCount).toBe(1);
    });

    it('AssistantRunner: supports strict finish_turn & plain_finish rewrite, retry limit, and self-healing fix', async () => {
        // 1. strictToolLoop = true: finish_turn retry -> fix -> rewrite
        const strictHarness = makeAssistantHarness(
            [
                // Attempt 0: retry requested
                {
                    toolCalls: [
                        {
                            id: 'ast_ft_0',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 's0', response: 'RETRY_ME' }),
                        },
                    ],
                },
                // Attempt 1 (retry #1): fix requested -> feeds tool error back into conversation
                {
                    toolCalls: [
                        {
                            id: 'ast_ft_1',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 's1', response: 'FIX_ME' }),
                        },
                    ],
                },
                // Round 2 after fix feedback: accepted & rewritten
                {
                    toolCalls: [
                        {
                            id: 'ast_ft_2',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 's2', response: 'clean reply' }),
                        },
                    ],
                },
            ],
            { strictToolLoop: true, roundMaxRetries: 2, stream: false },
        );

        const chatList = strictHarness.bridge.getChat();
        const expectedAnchor = {
            messageId: chatList.length - 1,
            swipeId: chatList[chatList.length - 1]?.swipeId ?? 0,
        };
        const promptHookCoords: Array<{ messageId?: number; swipeId?: number; target?: unknown }> = [];
        strictHarness.bridge.onPromptTransform((payload) => {
            promptHookCoords.push({
                messageId: payload.meta.messageId,
                swipeId: payload.meta.swipeId,
                target: payload.meta.target,
            });
        });

        strictHarness.bridge.onOutputProcess((payload) => {
            expect(payload.meta.runner).toBe('assistant');
            expect(payload.meta.operation).toBe('finish_turn');
            expect(payload.meta.messageId).toBe(expectedAnchor.messageId);
            expect(payload.meta.swipeId).toBe(expectedAnchor.swipeId);
            expect(payload.meta.target).toEqual(expectedAnchor);
            if (payload.text === 'RETRY_ME') {
                payload.control.retry('assistant syntax retry');
            } else if (payload.text === 'FIX_ME') {
                payload.control.requestFix('Replace FIX_ME marker');
            } else if (payload.text === 'clean reply') {
                payload.text = 'clean reply [VERIFIED]';
            }
        });

        const strictSession = await strictHarness.runner.createSession({ title: 'Strict Test' });
        const strictMsg = await strictHarness.runner.sendPrompt(strictSession.id, 'hi');
        expect(strictMsg.content).toBe('clean reply [VERIFIED]');
        expect(strictHarness.transport.requests).toHaveLength(3);
        expect(promptHookCoords.length).toBeGreaterThan(0);
        for (const coord of promptHookCoords) {
            expect(coord.messageId).toBe(expectedAnchor.messageId);
            expect(coord.swipeId).toBe(expectedAnchor.swipeId);
            expect(coord.target).toEqual(expectedAnchor);
        }

        // 2. strictToolLoop = false: plain_finish requestFix + retry limit exhaustion
        const plainHarness = makeAssistantHarness(
            [
                { content: 'PLAIN_FIX' },
                { content: 'PLAIN_RETRY_CAP' },
                { content: 'PLAIN_RETRY_CAP' },
            ],
            { strictToolLoop: false, roundMaxRetries: 1, stream: false },
        );

        let plainRetryHits = 0;
        plainHarness.bridge.onOutputProcess((payload) => {
            expect(payload.meta.operation).toBe('plain_finish');
            expect(payload.meta.finishMode).toBe('plain_text');
            if (payload.text === 'PLAIN_FIX') {
                payload.control.requestFix('Fix plain response');
            } else if (payload.text === 'PLAIN_RETRY_CAP') {
                plainRetryHits += 1;
                payload.control.retry('still invalid');
                payload.text = 'PLAIN_AFTER_CAP';
            }
        });

        const plainSession = await plainHarness.runner.createSession({ title: 'Plain Test' });
        const plainMsg = await plainHarness.runner.sendPrompt(plainSession.id, 'hello');
        expect(plainRetryHits).toBe(2); // initial + 1 retry
        expect(plainMsg.content).toBe('PLAIN_AFTER_CAP');
    });

    it('SideGenService: supports strict finish_turn & plain_finish rewrite, retry limit, and requestFix', async () => {
        // 1. strictToolLoop = true via send()
        const strictSide = makeSideGenHarness(
            [
                {
                    toolCalls: [
                        {
                            id: 'sg_0',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 'sb', response: 'SG_RETRY' }),
                        },
                    ],
                },
                {
                    toolCalls: [
                        {
                            id: 'sg_1',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 'sb', response: 'SG_FIX' }),
                        },
                    ],
                },
                {
                    toolCalls: [
                        {
                            id: 'sg_2',
                            name: FINISH_TURN_TOOL_NAME,
                            arguments: JSON.stringify({ step_brief: 'sb', response: 'SG_OK' }),
                        },
                    ],
                },
            ],
            { connection: { strictToolLoop: true, roundMaxRetries: 1, stream: false } },
        );

        const sideChat = strictSide.bridge.getChat();
        const expectedSideAnchor = {
            messageId: sideChat.length - 1,
            swipeId: sideChat[sideChat.length - 1]?.swipeId ?? 0,
        };
        const sidePromptCoords: Array<{ messageId?: number; swipeId?: number; target?: unknown }> = [];
        strictSide.bridge.onPromptTransform((payload) => {
            sidePromptCoords.push({
                messageId: payload.meta.messageId,
                swipeId: payload.meta.swipeId,
                target: payload.meta.target,
            });
        });

        strictSide.bridge.onOutputProcess((payload) => {
            expect(payload.meta.runner).toBe('sidegen');
            expect(payload.meta.messageId).toBe(expectedSideAnchor.messageId);
            expect(payload.meta.swipeId).toBe(expectedSideAnchor.swipeId);
            expect(payload.meta.target).toEqual(expectedSideAnchor);
            if (payload.text === 'SG_RETRY') {
                payload.control.retry('sidegen retry');
            } else if (payload.text === 'SG_FIX') {
                payload.control.requestFix('Fix sidegen draft');
            } else if (payload.text === 'SG_OK') {
                payload.text = 'SG_OK [HOOKED]';
            }
        });

        await strictSide.service.createSession({
            id: 'side:hook',
            title: 'Hook Side',
            systemPrompt: 'sys',
        });
        const sendRes = await strictSide.service.send('side:hook', 'run');
        expect(sendRes.text).toBe('SG_OK [HOOKED]');
        expect(sidePromptCoords.length).toBeGreaterThan(0);
        for (const coord of sidePromptCoords) {
            expect(coord.messageId).toBe(expectedSideAnchor.messageId);
            expect(coord.swipeId).toBe(expectedSideAnchor.swipeId);
            expect(coord.target).toEqual(expectedSideAnchor);
        }

        // 2. strictToolLoop = false via runOnce() (requestFix still iterates cleanly, retry respects cap)
        const plainSide = makeSideGenHarness(
            [
                { content: 'ONCE_FIX' },
                { content: 'ONCE_RETRY' },
                { content: 'ONCE_RETRY' },
            ],
            { connection: { strictToolLoop: false, roundMaxRetries: 1, stream: false } },
        );

        const plainSideChat = plainSide.bridge.getChat();
        const expectedPlainAnchor = {
            messageId: plainSideChat.length - 1,
            swipeId: plainSideChat[plainSideChat.length - 1]?.swipeId ?? 0,
        };
        plainSide.bridge.onOutputProcess((payload) => {
            expect(payload.meta.operation).toBe('plain_finish');
            expect(payload.meta.messageId).toBe(expectedPlainAnchor.messageId);
            expect(payload.meta.swipeId).toBe(expectedPlainAnchor.swipeId);
            expect(payload.meta.target).toEqual(expectedPlainAnchor);
            if (payload.text === 'ONCE_FIX') {
                payload.control.requestFix('Needs fix even without finish_turn');
            } else if (payload.text === 'ONCE_RETRY') {
                payload.control.retry('retry cap test');
                payload.text = 'ONCE_FINAL';
            }
        });

        const onceRes = await plainSide.service.runOnce({ prompt: 'once prompt' });
        expect(onceRes.text).toBe('ONCE_FINAL');
        expect(plainSide.transport.requests).toHaveLength(3);
    });
});
