import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    ToolAgentApi,
    ToolAgentRunOptions,
    ToolAgentRunResult,
    ToolErrorRecoveryControl,
    ToolEventPayload,
    ToolExecutionContext,
    ToolPostprocessControl,
    ToolPostprocessOutput,
} from '@/core/bridge';
import { createEphemeralMessagesController } from '@/core/llm';
import { createToolExecutionContext, ToolRegistry } from '@/core/tools';
import type { AgentRunTrace, AssistantRoundLog } from '@/core/types';
import {
    IframeJsSandbox,
    SandboxAgentError,
    SandboxLifecycleManager,
} from '@/sandbox';
import { MemoryHostBridge } from '../../mocks';

function createBaseCtx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
    const bridge = new MemoryHostBridge({
        identity: { userName: '沈默', charName: '林晚' },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'Hi' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'Hello' });
    const base = createToolExecutionContext({
        bridge,
        target: { messageId: 1, swipeId: 0 },
        permissions: { read: ['/**'], write: ['/**'] },
    });
    return {
        ...base,
        ...overrides,
    };
}

describe('IframeJsSandbox extended context proxies (agent, messages, event, control, body, output)', () => {
    const lifecycle = new SandboxLifecycleManager();
    const sandbox = new IframeJsSandbox({ lifecycle });

    afterEach(() => {
        sandbox.disposeAll();
    });

    it('proxies ctx.agent / agent safely with signal propagation, cloning, isolation, and structured errors', async () => {
        const capturedSignals: Array<AbortSignal | undefined> = [];
        const runSpy = vi.fn(async (opts) => {
            capturedSignals.push(opts.signal);
            return {
                runId: 'run_1',
                agentId: opts.agentId ?? 'main',
                content: `Executed: ${opts.prompt ?? ''}`,
                ok: true,
                rounds: 1,
            };
        });
        const runTriggerSpy = vi.fn(async (ruleId, opts) => {
            capturedSignals.push(opts?.signal);
            return {
                runId: 'run_trigger_1',
                agentId: 'chronicler',
                content: `Trigger ${ruleId} ok`,
                ok: true,
            };
        });

        const hostAgent: ToolAgentApi & { secretInternal: string } = {
            run: runSpy,
            runTrigger: runTriggerSpy,
            secretInternal: 'must-not-leak',
        };

        const ctx = createBaseCtx({ agent: hostAgent });

        const result = (await sandbox.evaluateScript(
            `
            const r1 = await agent.run({ agentId: 'scout', prompt: 'Inspect harbor' });
            const r2 = await ctx.agent.runTrigger('post_summary');
            let mutateBlocked = false;
            try {
                ctx.agent.run = () => 'hijacked';
            } catch {
                mutateBlocked = true;
            }
            return {
                r1,
                r2,
                sameRef: agent === ctx.agent,
                frozen: Object.isFrozen(ctx.agent),
                mutateBlocked,
                leakedInternal: typeof ctx.agent.secretInternal !== 'undefined',
                leakedConstructor: typeof ctx.agent.constructor !== 'undefined',
                keys: Object.keys(ctx.agent).sort(),
            };
            `,
            ctx,
            { id: 'agent_proxy_ok', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(result.r1).toEqual({
            runId: 'run_1',
            agentId: 'scout',
            content: 'Executed: Inspect harbor',
            ok: true,
            rounds: 1,
        });
        expect(result.r2).toEqual({
            runId: 'run_trigger_1',
            agentId: 'chronicler',
            content: 'Trigger post_summary ok',
            ok: true,
        });
        expect(result.sameRef).toBe(true);
        expect(result.frozen).toBe(true);
        expect(result.mutateBlocked).toBe(true);
        expect(result.leakedInternal).toBe(false);
        expect(result.leakedConstructor).toBe(false);
        expect(result.keys).toEqual(['run', 'runTrigger']);
        expect(capturedSignals).toHaveLength(2);
        expect(capturedSignals[0]?.aborted).toBe(false);

        // Unconfigured ctx.agent throws structured AGENT_UNAVAILABLE
        const unconfiguredCtx = createBaseCtx();
        await expect(
            sandbox.evaluateScript(
                `return await agent.run({ prompt: 'test' });`,
                unconfiguredCtx,
                { id: 'agent_unconfigured', allowNetwork: false },
            ),
        ).rejects.toSatisfy(
            (err: unknown) =>
                err instanceof SandboxAgentError
                && err.code === 'AGENT_UNAVAILABLE'
                && err.method === 'agent.run',
        );

        // Invalid args throw structured AGENT_INVALID_ARGS
        await expect(
            sandbox.evaluateScript(
                `return await agent.runTrigger('   ');`,
                ctx,
                { id: 'agent_bad_rule', allowNetwork: false },
            ),
        ).rejects.toSatisfy(
            (err: unknown) =>
                err instanceof SandboxAgentError
                && err.code === 'AGENT_INVALID_ARGS'
                && err.method === 'agent.runTrigger',
        );

        // AbortSignal cancellation propagates to in-flight agent.run
        let inflightSignal: AbortSignal | undefined;
        const slowAgent: ToolAgentApi = {
            run: vi.fn(
                (opts: ToolAgentRunOptions) =>
                    new Promise<ToolAgentRunResult>((resolve, reject) => {
                        inflightSignal = opts.signal;
                        const timer = setTimeout(
                            () => resolve({ agentId: 'main', content: 'late', ok: true }),
                            300,
                        );
                        opts.signal?.addEventListener(
                            'abort',
                            () => {
                                clearTimeout(timer);
                                const err = new Error('aborted');
                                err.name = 'AbortError';
                                reject(err);
                            },
                            { once: true },
                        );
                    }),
            ),
            runTrigger: vi.fn(async () => ({ agentId: 'main', content: '', ok: true })),
        };
        const abortController = new AbortController();
        const abortCtx = createBaseCtx({
            agent: slowAgent,
            signal: abortController.signal,
        });
        const pending = sandbox.evaluateScript(
            `return await agent.run({ prompt: 'slow task' });`,
            abortCtx,
            { id: 'agent_abort_test', allowNetwork: false },
        );
        setTimeout(() => abortController.abort(), 25);
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(inflightSignal?.aborted).toBe(true);

        // Disposed sandbox guard inside custom tool calling ctx.agent.run
        const tools = await sandbox.compileCustomTools(
            `
            export default defineTool({
                name: 'grab_agent',
                description: 'Uses ctx.agent',
                parameters: z.object({}),
                async execute(_args, ctx) {
                    const out = await ctx.agent.run({ prompt: 'from tool' });
                    return out.content;
                },
            });
            `,
            { id: 'agent_tool_dispose', allowNetwork: false },
        );
        const registry = new ToolRegistry(tools);
        const toolRes = await registry.executeToolCall('grab_agent', {}, ctx);
        expect(toolRes.ok).toBe(true);
        expect(toolRes.output).toBe('Executed: from tool');

        // Also check disposed guard directly via keepAlive script returning the agent proxy
        const capturedAgentProxy = (await sandbox.evaluateScript(
            `return ctx.agent;`,
            ctx,
            { id: 'agent_keep_alive', keepAlive: true, allowNetwork: false },
        )) as ToolAgentApi;
        sandbox.dispose('agent_keep_alive');
        await expect(capturedAgentProxy.run({ prompt: 'after dispose' })).rejects.toSatisfy(
            (err: unknown) =>
                err instanceof SandboxAgentError
                && err.code === 'AGENT_DISPOSED'
                && err.method === 'agent.run',
        );
    });

    it('injects messages, event, control, body, and output on both ctx.* and top-level bindings with isolation and safe sync-back', async () => {
        const controller = createEphemeralMessagesController(
            [
                { role: 'system', content: 'L0' },
                { role: 'user', content: 'Old 1' },
                { role: 'assistant', content: 'Old Reply 1' },
                { role: 'user', content: 'Current' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{}' }],
                },
                { role: 'tool', toolCallId: 'tc1', toolName: 'read_file', content: 'boom' },
            ],
            { layer0End: 1, layer1End: 3, turnStart: 3 },
        );

        const hostEvent: ToolEventPayload = {
            type: 'generation_error',
            timestamp: 1700000000000,
            statusCode: 400,
            error: 'context or tool error',
            data: { nested: 'immutable' },
        };

        let retryReason: string | undefined;
        let retryOpts: unknown;
        let controlAction: ToolErrorRecoveryControl['action'] = 'none';
        const hostRecoveryControl: ToolErrorRecoveryControl = {
            retry(reason, opts) {
                controlAction = 'retry';
                retryReason = reason;
                retryOpts = opts;
            },
            abort(reason) {
                controlAction = 'abort';
                retryReason = reason;
            },
            get action() {
                return controlAction;
            },
            get reason() {
                return retryReason;
            },
        };

        const hostBody: Record<string, unknown> = {
            temperature: 0.9,
            remove_me: true,
        };

        const hostOutput: ToolPostprocessOutput = {
            text: '  Draft text  ',
            originalText: '  Draft text  ',
            stage: 'turn_finish',
            operation: 'finish_turn',
        };

        const ctx = createBaseCtx({
            messages: controller,
            event: hostEvent,
            control: hostRecoveryControl,
            body: hostBody,
            output: hostOutput,
        });

        const scriptOut = (await sandbox.evaluateScript(
            `
            // Verify both ctx.* and top-level bindings match
            const refsMatch =
                messages === ctx.messages
                && event === ctx.event
                && control === ctx.control
                && body === ctx.body
                && output === ctx.output;

            // Event is deeply frozen
            let eventImmutable = false;
            try {
                event.data.nested = 'hacked';
            } catch {
                eventImmutable = true;
            }

            // Output.originalText is readonly
            let originalImmutable = false;
            try {
                output.originalText = 'hacked';
            } catch {
                originalImmutable = true;
            }

            const rolled = messages.rollbackToolRounds(1);
            const dropped = messages.dropHistoryTurns(1);
            messages.replaceContent(
                (msg) => msg.role === 'user',
                (text) => text.toUpperCase(),
            );
            messages.appendHint('Retry cleanly');

            if (event.type === 'generation_error' && event.statusCode === 400) {
                control.retry('rolled back tool round', { delayMs: 250, rollbackToolRounds: 1 });
            }

            body.temperature = 0.4;
            body.custom_flag = { enabled: true };
            delete body.remove_me;

            output.text = output.text.trim() + ' [checked]';

            return {
                refsMatch,
                eventImmutable,
                originalImmutable,
                rolled,
                dropped,
                controlAction: control.action,
                controlReason: control.reason,
                finalMessages: messages.toMessages(),
            };
            `,
            ctx,
            { id: 'full_context_script', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(scriptOut.refsMatch).toBe(true);
        expect(scriptOut.eventImmutable).toBe(true);
        expect(scriptOut.originalImmutable).toBe(true);
        expect(scriptOut.rolled).toBe(1);
        expect(scriptOut.dropped).toBe(1);
        expect(scriptOut.controlAction).toBe('retry');
        expect(scriptOut.controlReason).toBe('rolled back tool round');
        expect(retryOpts).toEqual({ delayMs: 250, rollbackToolRounds: 1 });
        expect(hostEvent.data?.nested).toBe('immutable');
        expect(hostBody).toEqual({
            temperature: 0.4,
            custom_flag: { enabled: true },
        });
        expect(hostOutput.text).toBe('Draft text [checked]');
        expect(controller.toMessages()).toEqual([
            { role: 'system', content: 'L0' },
            { role: 'user', content: 'CURRENT' },
            { role: 'user', content: 'Retry cleanly' },
        ]);

        // Throwing script MUST NOT partially corrupt host body/output
        const guardedBody: Record<string, unknown> = { temperature: 0.8 };
        const guardedOutput: ToolPostprocessOutput = {
            text: 'original',
            originalText: 'original',
        };
        let postAction: ToolPostprocessControl['action'] = 'accept';
        let fixMessage: string | undefined;
        let rejectWrite = false;
        const postControl: ToolPostprocessControl = {
            retry() {
                postAction = 'retry';
            },
            requestFix(message, opts) {
                postAction = 'fix';
                fixMessage = message;
                rejectWrite = Boolean(opts?.rejectWrite);
            },
            get action() {
                return postAction;
            },
            get fixMessage() {
                return fixMessage;
            },
            get rejectWrite() {
                return rejectWrite;
            },
        };

        await expect(
            sandbox.evaluateScript(
                `
                body.temperature = 0.1;
                output.text = 'corrupted';
                control.requestFix('Check tags', { rejectWrite: true });
                throw new Error('script boom');
                `,
                createBaseCtx({
                    body: guardedBody,
                    output: guardedOutput,
                    control: postControl,
                }),
                { id: 'throwing_script_isolation', allowNetwork: false },
            ),
        ).rejects.toThrow('script boom');

        expect(guardedBody).toEqual({ temperature: 0.8 });
        expect(guardedOutput.text).toBe('original');
        expect(postAction).toBe('fix');
        expect(fixMessage).toBe('Check tags');
        expect(rejectWrite).toBe(true);
    });

    it('supports extended AgentRunTrace and AssistantRoundLog contracts cleanly', () => {
        const round: AssistantRoundLog = {
            roundIndex: 0,
            beforeStepIndex: 0,
            reasoning: 'Checking lorebook first',
            content: 'Let me inspect the lore.',
            isFinishTurn: false,
            timestamp: 1000,
        };
        const finishRound: AssistantRoundLog = {
            roundIndex: 1,
            beforeStepIndex: 2,
            isFinishTurn: true,
            finishTurnSummary: 'Completed reply in /output.md',
            timestamp: 2000,
        };
        const trace: AgentRunTrace = {
            runId: 'run_trace_1',
            target: { messageId: 2, swipeId: 0 },
            phase: 'main_turn',
            agentProfileId: 'main',
            agentName: 'Main Narrative',
            connectionId: 'default',
            model: 'gpt-4o',
            status: 'completed',
            startedAt: 1000,
            endedAt: 2500,
            durationMs: 1500,
            usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 40 },
            toolSteps: [],
            assistantRounds: [round, finishRound],
            assistantSummary: 'Completed reply in /output.md',
            taskId: 'task_42',
            hasRollbackableRound: true,
        };

        expect(trace.assistantRounds).toHaveLength(2);
        expect(trace.assistantSummary).toBe('Completed reply in /output.md');
        expect(trace.taskId).toBe('task_42');
        expect(trace.hasRollbackableRound).toBe(true);
    });
});
