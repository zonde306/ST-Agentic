import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    ToolAgentApi,
    ToolAgentRunOptions,
    ToolAgentRunResult,
    ToolErrorRecoveryControl,
    ToolErrorRecoveryRetryOptions,
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
    SandboxExecutionError,
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

    it('preserves skip semantics when replaceContent replacer returns undefined, keeps body syncBack atomic, and cleans abort listeners on pre-eval clone failure', async () => {
        // 1. messages.replaceContent callback returning undefined skips modifying unmatched messages
        const messagesCtrl = createEphemeralMessagesController([
            { role: 'system', content: 'Keep system intact' },
            { role: 'user', content: 'keep user intact' },
            { role: 'user', content: 'rewrite me' },
        ]);

        const replacedCount = (await sandbox.evaluateScript(
            `
            return messages.replaceContent(
                (msg) => msg.role === 'user',
                (content) => {
                    if (content.includes('rewrite')) {
                        return content.toUpperCase();
                    }
                    return undefined;
                },
            );
            `,
            createBaseCtx({ messages: messagesCtrl }),
            { id: 'replace_skip_undefined', allowNetwork: false },
        )) as number;

        expect(replacedCount).toBe(1);
        expect(messagesCtrl.toMessages()).toEqual([
            { role: 'system', content: 'Keep system intact' },
            { role: 'user', content: 'keep user intact' },
            { role: 'user', content: 'REWRITE ME' },
        ]);

        // 2. Atomic body syncBack: if any key fails cloning, ZERO partial mutations or deletions occur on hostBody
        const atomicBody: Record<string, unknown> = {
            temperature: 0.7,
            keep_me: 'untouched',
        };
        await expect(
            sandbox.evaluateScript(
                `
                body.temperature = 0.2;
                delete body.keep_me;
                body.bad = () => {};
                `,
                createBaseCtx({ body: atomicBody }),
                { id: 'body_atomic_syncback', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxExecutionError);

        expect(atomicBody).toEqual({
            temperature: 0.7,
            keep_me: 'untouched',
        });

        // 3. Pre-eval clone error cleans up combined/caller abort listeners cleanly
        const ac = new AbortController();
        const addSpy = vi.spyOn(ac.signal, 'addEventListener');
        const removeSpy = vi.spyOn(ac.signal, 'removeEventListener');
        const uncloneableEvent = {
            type: 'generation_error',
            timestamp: 1,
            data: { fn: () => 'bad' },
        } as unknown as ToolEventPayload;

        await expect(
            sandbox.evaluateScript(
                `return 1;`,
                createBaseCtx({ signal: ac.signal, event: uncloneableEvent }),
                { id: 'preeval_cleanup_check', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxExecutionError);

        expect(addSpy).toHaveBeenCalled();
        expect(removeSpy).toHaveBeenCalledTimes(addSpy.mock.calls.length);
        expect(lifecycle.getStats().activeSandboxes).toBe(0);
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

    it('supports ctx.output bidirectional text/content sync, reasoningContent & toolCalls cloning/write-back, and atomic rollback on uncloneable values', async () => {
        // 1. Initializes from hostOutput.content when provided, and editing only content syncs both content and text
        const contentFirstOutput: ToolPostprocessOutput = {
            text: 'stale text',
            content: 'canonical content',
            originalText: 'canonical content',
            reasoningContent: 'initial thought',
            toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/a.md"}' }],
            stage: 'turn_finish',
            round: 2,
        };

        const initSnapshot = (await sandbox.evaluateScript(
            `
            const before = {
                text: output.text,
                content: output.content,
                reasoningContent: output.reasoningContent,
                toolCalls: output.toolCalls.map((c) => ({ ...c })),
            };
            output.content = 'edited via content';
            output.reasoningContent = 'refined thought';
            output.toolCalls.push({
                id: 'tc_2',
                name: 'write_file',
                arguments: '{"path":"/b.md"}',
                thoughtSignature: 'sig_2',
            });
            return before;
            `,
            createBaseCtx({ output: contentFirstOutput }),
            { id: 'output_edit_content', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(initSnapshot).toEqual({
            text: 'canonical content',
            content: 'canonical content',
            reasoningContent: 'initial thought',
            toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/a.md"}' }],
        });
        expect(contentFirstOutput.content).toBe('edited via content');
        expect(contentFirstOutput.text).toBe('edited via content');
        expect(contentFirstOutput.reasoningContent).toBe('refined thought');
        expect(contentFirstOutput.toolCalls).toEqual([
            { id: 'tc_1', name: 'read_file', arguments: '{"path":"/a.md"}' },
            {
                id: 'tc_2',
                name: 'write_file',
                arguments: '{"path":"/b.md"}',
                thoughtSignature: 'sig_2',
            },
        ]);

        // 2. Initializes from hostOutput.text when content is omitted, and editing only text syncs both text and content
        const textOnlyOutput: ToolPostprocessOutput = {
            text: 'initial text',
            originalText: 'initial text',
            reasoningContent: 'remove me',
            toolCalls: [{ id: 'tc_del', name: 'glob', arguments: '{}' }],
        };

        const textOnlySeen = (await sandbox.evaluateScript(
            `
            const seen = { text: output.text, content: output.content };
            output.text = 'edited via text';
            output.reasoningContent = undefined;
            output.toolCalls = undefined;
            return seen;
            `,
            createBaseCtx({ output: textOnlyOutput }),
            { id: 'output_edit_text', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(textOnlySeen).toEqual({ text: 'initial text', content: 'initial text' });
        expect(textOnlyOutput.text).toBe('edited via text');
        expect(textOnlyOutput.content).toBe('edited via text');
        expect(textOnlyOutput.reasoningContent).toBeUndefined();
        expect(textOnlyOutput.toolCalls).toBeUndefined();

        // 3. Atomic rollback: uncloneable toolCalls prevents partial writes to text/content/reasoningContent/toolCalls
        const atomicOutput: ToolPostprocessOutput = {
            text: 'safe text',
            content: 'safe text',
            originalText: 'safe text',
            reasoningContent: 'safe reasoning',
            toolCalls: [{ id: 'tc_keep', name: 'read_file', arguments: '{"path":"/keep.md"}' }],
        };

        await expect(
            sandbox.evaluateScript(
                `
                output.content = 'dirty content';
                output.reasoningContent = 'dirty reasoning';
                output.toolCalls[0].arguments = '{"mutated":true}';
                output.toolCalls.push({
                    id: 'tc_bad',
                    name: 'broken',
                    arguments: '{}',
                    extraFields: { fn: () => 'not cloneable' },
                });
                `,
                createBaseCtx({ output: atomicOutput }),
                { id: 'output_atomic_uncloneable_toolcalls', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxExecutionError);

        expect(atomicOutput).toEqual({
            text: 'safe text',
            content: 'safe text',
            originalText: 'safe text',
            reasoningContent: 'safe reasoning',
            toolCalls: [{ id: 'tc_keep', name: 'read_file', arguments: '{"path":"/keep.md"}' }],
        });

        // 4. Atomic rollback on invalid field types (non-string reasoningContent / non-array toolCalls / non-string content)
        await expect(
            sandbox.evaluateScript(
                `
                output.text = 'dirty';
                output.reasoningContent = 12345;
                `,
                createBaseCtx({ output: atomicOutput }),
                { id: 'output_atomic_bad_reasoning', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxExecutionError);

        await expect(
            sandbox.evaluateScript(
                `
                output.text = 'dirty';
                output.toolCalls = 'not-an-array';
                `,
                createBaseCtx({ output: atomicOutput }),
                { id: 'output_atomic_bad_toolcalls', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxExecutionError);

        expect(atomicOutput).toEqual({
            text: 'safe text',
            content: 'safe text',
            originalText: 'safe text',
            reasoningContent: 'safe reasoning',
            toolCalls: [{ id: 'tc_keep', name: 'read_file', arguments: '{"path":"/keep.md"}' }],
        });
    });

    it('proxies extended ctx.control.retry options (connectionId, temperature, maxTokens, mode, rollbackToolRounds), exposes frozen retryOptions, and validates/blocks bad args', async () => {
        let action: ToolErrorRecoveryControl['action'] = 'none';
        let reason: string | undefined;
        let capturedOpts: ToolErrorRecoveryRetryOptions | undefined;

        const retrySpy = vi.fn((r?: string, opts?: ToolErrorRecoveryRetryOptions) => {
            action = 'retry';
            reason = r;
            capturedOpts = opts;
        });

        const hostControl: ToolErrorRecoveryControl = {
            retry: retrySpy,
            abort(r?: string) {
                action = 'abort';
                reason = r;
            },
            get action() {
                return action;
            },
            get reason() {
                return reason;
            },
            get connectionId() {
                return capturedOpts?.connectionId;
            },
            get temperature() {
                return capturedOpts?.temperature;
            },
            get maxTokens() {
                return capturedOpts?.maxTokens;
            },
            get mode() {
                return capturedOpts?.mode;
            },
            get rollbackToolRounds() {
                return capturedOpts?.rollbackToolRounds;
            },
            get retryOptions() {
                return capturedOpts;
            },
        };

        const out = (await sandbox.evaluateScript(
            `
            control.retry('fallback to backup route', {
                connectionId: 'conn_backup',
                temperature: 0.2,
                maxTokens: 2048,
                mode: 'round',
                rollbackToolRounds: 1,
                delayMs: 150,
            });

            let retryOptsFrozen = false;
            try {
                control.retryOptions.mode = 'turn';
            } catch {
                retryOptsFrozen = true;
            }

            return {
                action: control.action,
                reason: control.reason,
                connectionId: control.connectionId,
                temperature: control.temperature,
                maxTokens: control.maxTokens,
                mode: control.mode,
                rollbackToolRounds: control.rollbackToolRounds,
                retryOptions: control.retryOptions,
                retryOptsFrozen,
            };
            `,
            createBaseCtx({ control: hostControl }),
            { id: 'control_retry_extended', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(capturedOpts).toEqual({
            connectionId: 'conn_backup',
            temperature: 0.2,
            maxTokens: 2048,
            mode: 'round',
            rollbackToolRounds: 1,
            delayMs: 150,
        });
        expect(out).toEqual({
            action: 'retry',
            reason: 'fallback to backup route',
            connectionId: 'conn_backup',
            temperature: 0.2,
            maxTokens: 2048,
            mode: 'round',
            rollbackToolRounds: 1,
            retryOptions: {
                connectionId: 'conn_backup',
                temperature: 0.2,
                maxTokens: 2048,
                mode: 'round',
                rollbackToolRounds: 1,
                delayMs: 150,
            },
            retryOptsFrozen: true,
        });

        // Reject invalid types and non-cloneable objects without invoking host retry
        retrySpy.mockClear();
        const invalidCalls = [
            `control.retry('bad mode', { mode: 'invalid' });`,
            `control.retry('bad temp', { temperature: -0.5 });`,
            `control.retry('bad maxTokens', { maxTokens: 0 });`,
            `control.retry('bad conn', { connectionId: 123 });`,
            `control.retry('uncloneable', { connectionId: 'ok', fn: () => {} });`,
        ];

        for (let i = 0; i < invalidCalls.length; i += 1) {
            await expect(
                sandbox.evaluateScript(
                    invalidCalls[i],
                    createBaseCtx({ control: hostControl }),
                    { id: `control_retry_invalid_${i}`, allowNetwork: false },
                ),
            ).rejects.toThrow(SandboxExecutionError);
        }
        expect(retrySpy).not.toHaveBeenCalled();
    });

    it('maps defensive profile/tools aliases in ctx.agent.run only when canonical agentId/enabledTools are omitted', async () => {
        const receivedCalls: Array<Record<string, unknown>> = [];
        const hostAgent: ToolAgentApi = {
            run: vi.fn(async (opts: ToolAgentRunOptions) => {
                receivedCalls.push({ ...(opts as unknown as Record<string, unknown>) });
                return {
                    agentId: opts.agentId ?? 'default',
                    content: `ran:${opts.agentId ?? 'default'}:${(opts.enabledTools ?? []).join(',')}`,
                    ok: true,
                };
            }),
            runTrigger: vi.fn(async () => ({ agentId: 'main', content: '', ok: true })),
        };

        const ctx = createBaseCtx({ agent: hostAgent });

        const res = (await sandbox.evaluateScript(
            `
            const aliasRun = await ctx.agent.run({
                profile: 'archivist',
                tools: ['read_file', 'search_files'],
                prompt: 'Summarize clues',
            });
            const canonicalWinsRun = await agent.run({
                agentId: 'primary_agent',
                profile: 'ignored_alias',
                enabledTools: ['write_file'],
                tools: ['ignored_tool'],
                prompt: 'Canonical precedence',
            });
            return { aliasRun, canonicalWinsRun };
            `,
            ctx,
            { id: 'agent_alias_compat', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(res.aliasRun).toEqual({
            agentId: 'archivist',
            content: 'ran:archivist:read_file,search_files',
            ok: true,
        });
        expect(res.canonicalWinsRun).toEqual({
            agentId: 'primary_agent',
            content: 'ran:primary_agent:write_file',
            ok: true,
        });

        expect(receivedCalls).toHaveLength(2);
        expect(receivedCalls[0].agentId).toBe('archivist');
        expect(receivedCalls[0].enabledTools).toEqual(['read_file', 'search_files']);
        expect('profile' in receivedCalls[0]).toBe(false);
        expect('tools' in receivedCalls[0]).toBe(false);

        expect(receivedCalls[1].agentId).toBe('primary_agent');
        expect(receivedCalls[1].enabledTools).toEqual(['write_file']);
        expect('profile' in receivedCalls[1]).toBe(false);
        expect('tools' in receivedCalls[1]).toBe(false);

        // Invalid alias types throw structured AGENT_INVALID_ARGS
        await expect(
            sandbox.evaluateScript(
                `return await ctx.agent.run({ profile: 42, prompt: 'bad' });`,
                ctx,
                { id: 'agent_bad_profile_alias', allowNetwork: false },
            ),
        ).rejects.toSatisfy(
            (err: unknown) =>
                err instanceof SandboxAgentError
                && err.code === 'AGENT_INVALID_ARGS'
                && err.method === 'agent.run',
        );

        await expect(
            sandbox.evaluateScript(
                `return await ctx.agent.run({ tools: 'read_file', prompt: 'bad' });`,
                ctx,
                { id: 'agent_bad_tools_alias', allowNetwork: false },
            ),
        ).rejects.toSatisfy(
            (err: unknown) =>
                err instanceof SandboxAgentError
                && err.code === 'AGENT_INVALID_ARGS'
                && err.method === 'agent.run',
        );
    });
});
