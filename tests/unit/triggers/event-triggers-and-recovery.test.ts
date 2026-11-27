import { describe, expect, it } from 'vitest';
import type { ToolEventPayload } from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { LLMTransportError } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import {
    AgentExecutionError,
    PipelineOrchestrator,
    TurnInterruptedError,
} from '@/core/triggers';
import type {
    ApiConnection,
    Preset,
    RawLoreEntry,
    Settings,
    TriggerRule,
} from '@/core/types';
import { IframeJsSandbox } from '@/sandbox';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

function writeOutputTurn(text: string, id = 'write_out') {
    return {
        content: '',
        toolCalls: [
            {
                id,
                name: 'write_file',
                arguments: JSON.stringify({ path: '/output.md', content: text }),
            },
        ],
    };
}

function makeLoreEntry(
    partial: Partial<RawLoreEntry> & { uid: number; content: string },
): RawLoreEntry {
    return {
        world: partial.world ?? 'EventBook',
        uid: partial.uid,
        comment: partial.comment ?? `Entry ${partial.uid}`,
        content: partial.content,
        keys: partial.keys ?? [],
        keysecondary: partial.keysecondary ?? [],
        constant: partial.constant ?? true,
        selective: partial.selective ?? false,
        disable: partial.disable ?? false,
        position: partial.position ?? 1,
        depth: partial.depth ?? 4,
        order: partial.order ?? 1,
        role: partial.role ?? 0,
    };
}

function createFixture(options: {
    triggers?: TriggerRule[];
    lorebooks?: Record<string, RawLoreEntry[]>;
    agents?: Record<string, ReturnType<typeof createDefaultMainAgent>>;
    extraConnections?: Record<string, ApiConnection>;
    presetPatch?: Partial<Preset>;
    roundMaxRetries?: number;
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: { userName: '沈默', charName: '林晚' },
        characterFields: { description: '灰港调查员。' },
        lorebooks: options.lorebooks,
    });

    const mainConn = createDefaultConnection({
        id: 'conn_main',
        model: 'primary-model',
        stream: false,
        roundMaxRetries: options.roundMaxRetries ?? 0,
    });

    const mainAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: 'conn_main',
        sessionMode: 'persistent',
        enabledTools: ['read_file', 'write_file', 'append_file', 'edit_file', 'read_variables', 'patch_variables'],
        permissions: {
            read: ['/**'],
            write: ['/output.md', '/memory/**', '/state/variables.json'],
        },
    });

    const preset = createDefaultPreset({
        id: 'preset_test',
        mainAgentId: 'main',
        agents: {
            main: mainAgent,
            ...(options.agents ?? {}),
        },
        triggers: options.triggers ?? [],
        ...(options.presetPatch ?? {}),
    });

    const settings: Settings = createDefaultSettings({
        runMode: 'takeover',
        connections: {
            [mainConn.id]: mainConn,
            ...(options.extraConnections ?? {}),
        },
        currentConnectionId: mainConn.id,
        presets: { [preset.id]: preset },
        currentPresetId: preset.id,
    });

    const transport = new ScriptedLLMTransport();
    const traceLogger = new TraceLogger();
    const sandbox = new IframeJsSandbox();

    const orchestrator = new PipelineOrchestrator({
        bridge,
        transport,
        settings: () => settings,
        traceLogger,
        sandbox,
    });

    return { bridge, settings, preset, transport, traceLogger, sandbox, orchestrator };
}

describe('Event Triggers, ctx.agent, Error Recovery & Full-Phase Rollback Resume', () => {
    it('never misfires event-driven @@script on=generation_error during normal before_turn / after_turn / maintenance phases', async () => {
        const loreEntries: RawLoreEntry[] = [
            makeLoreEntry({
                uid: 1,
                comment: '错误恢复脚本（常规阶段禁止误触）',
                content: [
                    '@@script on=generation_error order=1',
                    'await vars.set("errorScriptMisfired", true);',
                ].join('\n'),
            }),
            makeLoreEntry({
                uid: 2,
                comment: '常规后置脚本',
                content: [
                    '@@script phase=after order=1',
                    'await vars.set("normalAfterRan", true);',
                ].join('\n'),
            }),
            makeLoreEntry({
                uid: 3,
                comment: '事件驱动前置标记',
                content: [
                    '@@script phase=before on=chat_changed order=1',
                    'await vars.set("chatChangedMisfired", true);',
                ].join('\n'),
            }),
        ];

        const { bridge, transport, orchestrator } = createFixture({
            lorebooks: { EventBook: loreEntries },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '你好' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            writeOutputTurn('正常回合回复。', 'w_norm_1'),
            { content: 'done' },
        );

        const res = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '你好',
        });
        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(res.content).toBe('正常回合回复。');
        const vars = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(vars.normalAfterRan).toBe(true);
        expect(vars.errorScriptMisfired).toBeUndefined();
        expect(vars.chatChangedMisfired).toBeUndefined();
    });

    it('runs @@script on=generation_error to temporarily rollback a tool round, switch connection, and retry without polluting Layer 0/1', async () => {
        const backupConn = createDefaultConnection({
            id: 'conn_backup',
            model: 'backup-model',
            temperature: 0.9,
            maxTokens: 4096,
            stream: false,
            roundMaxRetries: 0,
        });

        const loreEntries: RawLoreEntry[] = [
            makeLoreEntry({
                uid: 10,
                comment: '错误临时回退重试脚本',
                content: [
                    '@@script on=error order=1',
                    'const layers = ctx.event?.data?.layers;',
                    'await ctx.vars.set("recoverySawLayers", Boolean(layers && typeof layers.turnStart === "number"));',
                    'await ctx.vars.set("recoveryStatusCode", ctx.event?.statusCode ?? null);',
                    'ctx.messages.rollbackToolRounds(1);',
                    'ctx.messages.appendHint("Fallback route active: write concise answer directly to /output.md.");',
                    'ctx.control.retry("switch_to_backup", { connectionId: "conn_backup", temperature: 0.25, maxTokens: 1024, delayMs: 0 });',
                ].join('\n'),
            }),
        ];

        const { bridge, transport, orchestrator } = createFixture({
            lorebooks: { EventBook: loreEntries },
            extraConnections: { conn_backup: backupConn },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '调查码头' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        let sawBackupRetryRequest = false;
        transport.enqueue(
            // Round 1: execute a read_variables tool call
            {
                content: '',
                toolCalls: [
                    {
                        id: 'tc_round_1',
                        name: 'read_variables',
                        arguments: '{}',
                    },
                ],
            },
            // Round 2: primary model fails with non-retryable 400 error -> triggers @@script on=generation_error!
            () => {
                throw new LLMTransportError('Bad upstream payload', {
                    status: 400,
                    code: 'BAD_REQUEST',
                    retryable: false,
                });
            },
            // Recovery retry: uses conn_backup, temp=0.25, maxTokens=1024, rolled back tc_round_1, appended hint!
            (req) => {
                sawBackupRetryRequest = true;
                expect(req.connection?.id).toBe('conn_backup');
                expect(req.connection?.model).toBe('backup-model');
                expect(req.connection?.temperature).toBe(0.25);
                expect(req.connection?.maxTokens).toBe(1024);
                const serialized = JSON.stringify(req.messages);
                expect(serialized).not.toContain('tc_round_1');
                expect(serialized).toContain('Fallback route active');
                return writeOutputTurn('通过备用线路成功恢复。', 'w_recovered');
            },
            { content: 'recovery finish' },
        );

        const res = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '调查码头',
        });

        expect(sawBackupRetryRequest).toBe(true);
        expect(res.content).toBe('通过备用线路成功恢复。');

        const vars = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(vars.recoverySawLayers).toBe(true);
        expect(vars.recoveryStatusCode).toBe(400);

        // Ensure temporary retry overrides did NOT mutate Settings or pollute TrajectoryStore with temporary hint
        expect(backupConn.temperature).toBe(0.9);
        expect(backupConn.maxTokens).toBe(4096);
        const persistedMsgs = orchestrator.trajectoryStore.getMessages('main');
        expect(JSON.stringify(persistedMsgs)).not.toContain('Fallback route active');
        expect(JSON.stringify(persistedMsgs)).not.toContain('tc_round_1');
    });

    it('supports ctx.agent.run (preset agent, @@agent, default) and ctx.agent.runTrigger, with strict recursion guard inside generation_error', async () => {
        const scoutAgent = createDefaultMainAgent({
            id: 'scout',
            name: 'Scout',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables'],
            permissions: { read: ['/**'], write: [] },
        });

        const loreEntries: RawLoreEntry[] = [
            makeLoreEntry({
                uid: 20,
                comment: '档案专家',
                content: '@@agent archivist\n总结已知档案线索。',
            }),
            makeLoreEntry({
                uid: 21,
                comment: '脚本调起 Agent',
                content: [
                    '@@script phase=before order=1',
                    'const r1 = await ctx.agent.run({ agentId: "scout", prompt: "Inspect harbor" });',
                    'const r2 = await ctx.agent.run({ agentId: "archivist", prompt: "Check records" });',
                    'const r3 = await ctx.agent.runTrigger("tr_helper_script");',
                    'await ctx.vars.set("agentRunResults", { r1: r1.content, r2: r2.content, r3: r3.content });',
                    'return `Brief:${r1.content}|${r2.content}|${r3.content}`;',
                ].join('\n'),
            }),
            makeLoreEntry({
                uid: 22,
                comment: '错误恢复调用失败 Agent（必须防递归）',
                content: [
                    '@@script on=generation_error order=1',
                    'const count = ((await ctx.vars.get("errHookCount")) || 0) + 1;',
                    'await ctx.vars.set("errHookCount", count);',
                    'const diag = await ctx.agent.run({ prompt: "diagnose error" });',
                    'await ctx.vars.set("diagOk", diag.ok);',
                    'ctx.control.abort("stop_after_diag");',
                ].join('\n'),
            }),
        ];

        const helperTrigger: TriggerRule = {
            id: 'tr_helper_script',
            label: 'Helper Script',
            source: 'preset',
            phase: 'after_turn',
            order: 99,
            barrier: 'none',
            agentProfileId: 'script',
            kind: 'script',
            events: ['chat_changed'],
            condition: { type: 'always' },
            instructionTemplate: '',
            scriptCode: 'return "helper-ok";',
            enabled: true,
        };

        const { bridge, transport, orchestrator } = createFixture({
            triggers: [helperTrigger],
            lorebooks: { EventBook: loreEntries },
            agents: { scout: scoutAgent },
        });

        // Turn 1: before_turn script invokes scout, @@agent archivist, and runTrigger('tr_helper_script')
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '出发' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            { content: 'scout-clear' },
            { content: 'archivist-note' },
            writeOutputTurn('主回合已收到简报。', 'w_t1'),
            { content: 'done' },
        );

        const t1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '出发',
        });
        expect(t1.beforeTurnBrief).toBe('Brief:scout-clear|archivist-note|helper-ok');
        const varsT1 = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(varsT1.agentRunResults).toEqual({
            r1: 'scout-clear',
            r2: 'archivist-note',
            r3: 'helper-ok',
        });

        // Turn 2: main_turn fails -> on=generation_error calls ctx.agent.run which ALSO fails -> MUST NOT recurse!
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '触发故障' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            // Turn 2 before_turn scout + archivist
            { content: 's2' },
            { content: 'a2' },
            // Turn 2 main_turn fails -> enters on=generation_error
            () => {
                throw new LLMTransportError('Main upstream outage', {
                    status: 503,
                    code: 'UNAVAILABLE',
                    retryable: false,
                });
            },
            // Inside generation_error, ctx.agent.run({ prompt: 'diagnose error' }) ALSO fails!
            () => {
                throw new LLMTransportError('Helper also down', {
                    status: 503,
                    code: 'UNAVAILABLE',
                    retryable: false,
                });
            },
        );

        let caught: unknown;
        try {
            await orchestrator.runTurn({
                action: 'normal',
                target: { messageId: 3, swipeId: 0 },
                userInput: '触发故障',
            });
        } catch (err) {
            caught = err;
        }
        // control.abort('stop_after_diag') inside main_turn triggers TurnInterruptedError(reason: 'user_stop')
        expect(caught).toBeInstanceOf(TurnInterruptedError);

        const varsT2 = await orchestrator.vfs.readVariables({
            target: { messageId: 3, swipeId: 0 },
            staged: true,
        });
        // Entered generation_error strictly ONCE (never recursed when helper agent failed!)
        expect(varsT2.errHookCount).toBe(1);
        expect(varsT2.diagOk).toBe(false);
    });

    it('runs @@script on=prompt_preprocess and on=output_postprocess alongside Preset preprocess/postprocess scripts', async () => {
        const loreEntries: RawLoreEntry[] = [
            makeLoreEntry({
                uid: 30,
                comment: '事件预处理脚本',
                content: [
                    '@@script on=prompt_preprocess order=1',
                    'ctx.messages.appendHint("[EVENT-PREPROCESS-HINT]");',
                    'ctx.body.temperature = 0.33;',
                ].join('\n'),
            }),
            makeLoreEntry({
                uid: 31,
                comment: '事件后处理脚本',
                content: [
                    '@@script on=output_postprocess order=1',
                    'if (ctx.output.text.includes("RAW_REPLY")) {',
                    '  ctx.output.content = ctx.output.text.replace("RAW_REPLY", "POSTPROCESSED_REPLY");',
                    '}',
                ].join('\n'),
            }),
        ];

        const { bridge, transport, orchestrator } = createFixture({
            lorebooks: { EventBook: loreEntries },
            presetPatch: {
                preprocessScript: {
                    enabled: true,
                    code: 'ctx.messages.appendHint("[PRESET-PREPROCESS-HINT]");',
                },
                postprocessScript: {
                    enabled: true,
                    code: 'if (ctx.output.text === "SEED") { return "RAW_REPLY"; }',
                },
            },
        });

        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查脚本钩子' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        let sawBothPreprocessHints = false;
        transport.enqueue(
            (req) => {
                const text = JSON.stringify(req.messages);
                if (
                    text.includes('[PRESET-PREPROCESS-HINT]')
                    && text.includes('[EVENT-PREPROCESS-HINT]')
                    && req.connection?.temperature === 0.33
                ) {
                    sawBothPreprocessHints = true;
                }
                return writeOutputTurn('正文输出。', 'w_prepost');
            },
            // Final round returns "SEED" -> Preset.postprocessScript turns it into "RAW_REPLY"
            // -> @@script on=output_postprocess turns it into "POSTPROCESSED_REPLY"!
            { content: 'SEED' },
        );

        const res = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '检查脚本钩子',
        });

        expect(sawBothPreprocessHints).toBe(true);
        expect(res.mainRun.trace.assistantSummary).toBe('POSTPROCESSED_REPLY');
    });

    it('supports resumeTurn with rollbackLastToolRound restoring /output.md and staged data with rollback prompt', async () => {
        const { bridge, transport, orchestrator } = createFixture();
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '写两段故事并更新变量' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        // Round 1 writes good initial /output.md + staged var v1
        // Round 2 writes bad /output.md + staged var v2, then Round 3 fails -> TurnInterruptedError with previousRoundSnapshot!
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'tc_good_1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '第一段正确正文。' }),
                    },
                    {
                        id: 'tc_var_1',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { stage: 'round1' } }),
                    },
                ],
            },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'tc_bad_2',
                        name: 'append_file',
                        arguments: JSON.stringify({ path: '/output.md', content: '错误的第二段。' }),
                    },
                    {
                        id: 'tc_var_2',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { stage: 'round2_bad' } }),
                    },
                ],
            },
            () => {
                throw new LLMTransportError('Model stalled on round 3', {
                    status: 500,
                    retryable: false,
                });
            },
        );

        let interrupted: unknown;
        try {
            await orchestrator.runTurn({
                action: 'normal',
                target: { messageId: 1, swipeId: 0 },
                userInput: '写两段故事并更新变量',
            });
        } catch (err) {
            interrupted = err;
        }
        expect(interrupted).toBeInstanceOf(TurnInterruptedError);
        const cp = orchestrator.trajectoryStore.getInterruptedCheckpoint({
            messageId: 1,
            swipeId: 0,
        });
        expect(cp?.previousRoundSnapshot).toBeDefined();
        expect(cp?.previousRoundSnapshot?.outputText).toBe('第一段正确正文。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '第一段正确正文。错误的第二段。',
        );

        // Now resumeTurn with rollbackLastToolRound: true!
        let sawRollbackPrompt = false;
        let sawRolledBackOutputDuringResume = '';
        let sawRolledBackStageVar = '';
        transport.enqueue(
            async (req) => {
                const lastMsg = req.messages[req.messages.length - 1];
                const lastText = String(lastMsg.content);
                sawRollbackPrompt =
                    lastText.includes('Tool Round Rolled Back')
                    && lastText.includes('append_file');
                sawRolledBackOutputDuringResume =
                    bridge.readChatMessage({ messageId: 1, swipeId: 0 }) ?? '';
                const stagedVars = await orchestrator.vfs.readVariables({
                    target: { messageId: 1, swipeId: 0 },
                    staged: true,
                });
                sawRolledBackStageVar = String(stagedVars.stage ?? '');
                // tc_bad_2 must NOT appear in resumed messages
                expect(JSON.stringify(req.messages)).not.toContain('tc_bad_2');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_fixed_2',
                            name: 'append_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '修正后的第二段。',
                            }),
                        },
                    ],
                };
            },
            { content: 'Rollback resume finished' },
        );

        const resumed = await orchestrator.resumeTurn({
            target: { messageId: 1, swipeId: 0 },
            rollbackLastToolRound: true,
        });

        expect(sawRollbackPrompt).toBe(true);
        expect(sawRolledBackOutputDuringResume).toBe('第一段正确正文。');
        expect(sawRolledBackStageVar).toBe('round1');
        expect(resumed.content).toBe('第一段正确正文。修正后的第二段。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '第一段正确正文。修正后的第二段。',
        );
        const committedVars = await orchestrator.vfs.readVariables({
            target: { messageId: 1, swipeId: 0 },
        });
        expect(committedVars.stage).toBe('round1');
    });

    it('persists after_turn composite checkpoint with taskId on error and resumes with rollbackLastToolRound via resumeTriggerTask (with graceful fallback when no checkpoint)', async () => {
        const varsAgent = createDefaultMainAgent({
            id: 'ag_vars',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables', 'patch_variables'],
            permissions: { read: ['/state/variables.json'], write: ['/state/variables.json'] },
        });

        const afterRule: TriggerRule = {
            id: 'tr_after_state',
            label: 'State Updater',
            source: 'preset',
            phase: 'after_turn',
            order: 1,
            barrier: 'self',
            agentProfileId: 'ag_vars',
            kind: 'agent',
            targetPath: '/state/variables.json',
            condition: { type: 'always' },
            instructionTemplate: 'Update state variables.',
            enabled: true,
        };

        const { bridge, transport, traceLogger, orchestrator } = createFixture({
            triggers: [afterRule],
            agents: { ag_vars: varsAgent },
        });

        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '进入战斗' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            writeOutputTurn('战斗开始。', 'w_battle'),
            { content: 'main done' },
            // after_turn Round 1 patches hp=50 (staged), Round 2 patches hp=1 (bad), Round 3 fails!
            {
                content: '',
                toolCalls: [
                    {
                        id: 'after_r1',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { hp: 50 } }),
                    },
                ],
            },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'after_r2_bad',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { hp: 1 } }),
                    },
                ],
            },
            () => {
                throw new LLMTransportError('After trigger upstream error', {
                    status: 502,
                    code: 'BAD_GATEWAY',
                    retryable: false,
                });
            },
        );

        const turnRes = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '进入战斗',
        });
        expect(turnRes.afterTurnTasks).toHaveLength(1);
        const taskId = turnRes.afterTurnTasks[0].taskId;

        await expect(turnRes.afterTurnTasks[0].promise).rejects.toBeInstanceOf(
            AgentExecutionError,
        );

        // Verify trace carries taskId + hasRollbackableRound and checkpoint persisted to HostBridge
        const errTrace = traceLogger
            .listTraces({ phase: 'after_turn', status: 'error' })
            .find((tr) => tr.triggerId === 'tr_after_state');
        expect(errTrace?.taskId).toBe(taskId);
        expect(errTrace?.hasRollbackableRound).toBe(true);

        const reloaded = TrajectoryStore.loadFromHost(bridge);
        const savedAfterCp = reloaded.getInterruptedCheckpoint(
            { messageId: 1, swipeId: 0 },
            { phase: 'after_turn', triggerId: 'tr_after_state' },
        );
        expect(savedAfterCp).toBeDefined();
        expect(savedAfterCp?.previousRoundSnapshot).toBeDefined();

        // Also verify unrecovered after_turn error emitted agentic_generation_error host event!
        const emittedErr = bridge.emittedEvents.find(
            (e) => e.event === 'agentic_generation_error',
        );
        expect(emittedErr).toBeDefined();
        const errPayload = emittedErr!.payload as ToolEventPayload;
        expect(errPayload.type).toBe('generation_error');
        expect(errPayload.phase).toBe('after_turn');
        expect(errPayload.triggerId).toBe('tr_after_state');
        expect(errPayload.statusCode).toBe(502);

        // Resume trigger task with rollbackLastToolRound: true -> restores hp=50 (rolls back hp=1)!
        let stagedHpBeforePatch = 0;
        transport.enqueue(
            async (req) => {
                const stagedVars = await orchestrator.vfs.readVariables({
                    target: { messageId: 1, swipeId: 0 },
                    staged: true,
                });
                stagedHpBeforePatch = Number(stagedVars.hp ?? 0);
                expect(String(req.messages[req.messages.length - 1].content)).toContain(
                    'Tool Round Rolled Back',
                );
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'after_r2_fixed',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 45, status: 'ok' } }),
                        },
                    ],
                };
            },
            { content: 'after trigger recovered' },
        );

        const resumeHandles = await orchestrator.resumeTriggerTask(
            { messageId: 1, swipeId: 0 },
            'tr_after_state',
            { rollbackLastToolRound: true },
        );
        expect(resumeHandles).toHaveLength(1);
        await resumeHandles[0].promise;

        expect(stagedHpBeforePatch).toBe(50);
        const committedVars = await orchestrator.vfs.readVariables({
            target: { messageId: 1, swipeId: 0 },
        });
        expect(committedVars).toMatchObject({ hp: 45, status: 'ok' });
        // Composite checkpoint cleared after successful resume
        expect(
            orchestrator.trajectoryStore.getInterruptedCheckpoint(
                { messageId: 1, swipeId: 0 },
                { phase: 'after_turn', triggerId: 'tr_after_state' },
            ),
        ).toBeUndefined();

        // Calling resumeTriggerTask when no checkpoint exists falls back gracefully to rerunAfterTurn!
        transport.enqueue({ content: 'rerun fallback ok' });
        const fallbackHandles = await orchestrator.resumeTriggerTask(
            { messageId: 1, swipeId: 0 },
            'tr_after_state',
        );
        expect(fallbackHandles).toHaveLength(1);
        const fallbackRes = await fallbackHandles[0].promise;
        expect(fallbackRes.output).toBe('rerun fallback ok');
    });

    it('emits agentic_generation_error and agentic_turn_interrupted on unrecovered main_turn errors and routes dispatchHostEvent with re-entrancy protection', async () => {
        const loreEntries: RawLoreEntry[] = [
            makeLoreEntry({
                uid: 40,
                comment: '宿主事件监听',
                content: [
                    '@@script on=message_sent,output_updated order=1',
                    'const log = (await ctx.vars.get("hostEvents")) || [];',
                    'log.push(`${ctx.event.type}:${ctx.event.messageId}`);',
                    'await ctx.vars.set("hostEvents", log);',
                ].join('\n'),
            }),
        ];

        const { bridge, transport, orchestrator } = createFixture({
            lorebooks: { EventBook: loreEntries },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '测试外部事件' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        // Host event routing via dispatchHostEvent
        await orchestrator.dispatchHostEvent('message_sent', { messageId: 0, swipeId: 0 });
        await orchestrator.dispatchHostEvent('output_updated', { messageId: 1, swipeId: 0 });
        const vars = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(vars.hostEvents).toEqual(['message_sent:0', 'output_updated:1']);

        // 1) Cold Round-1 main_turn failure -> AgentExecutionError + agentic_generation_error
        transport.enqueue(() => {
            throw new LLMTransportError('Hard provider failure', {
                status: 500,
                code: 'INTERNAL_ERROR',
                retryable: false,
            });
        });

        await expect(
            orchestrator.runTurn({
                action: 'normal',
                target: { messageId: 1, swipeId: 0 },
                userInput: '测试外部事件',
            }),
        ).rejects.toBeInstanceOf(AgentExecutionError);

        const coldErrEv = bridge.emittedEvents.find(
            (e) => e.event === 'agentic_generation_error',
        );
        expect(coldErrEv).toBeDefined();
        expect((coldErrEv!.payload as ToolEventPayload).type).toBe('generation_error');
        expect((coldErrEv!.payload as ToolEventPayload).phase).toBe('main_turn');
        expect((coldErrEv!.payload as ToolEventPayload).statusCode).toBe(500);
        expect((coldErrEv!.payload as ToolEventPayload).errorCode).toBe('INTERNAL_ERROR');
        expect((coldErrEv!.payload as ToolEventPayload).error).toContain('Hard provider failure');

        // 2) Mid-turn failure (after Round 1 progress) -> TurnInterruptedError + BOTH agentic_turn_interrupted & agentic_generation_error
        bridge.emittedEvents.length = 0;
        transport.enqueue(
            writeOutputTurn('中断前已有正文。', 'w_partial'),
            () => {
                throw new LLMTransportError('Mid-turn network drop', {
                    status: 504,
                    code: 'TIMEOUT',
                    retryable: false,
                });
            },
        );

        await expect(
            orchestrator.runTurn({
                action: 'normal',
                target: { messageId: 1, swipeId: 0 },
                userInput: '测试外部事件',
            }),
        ).rejects.toBeInstanceOf(TurnInterruptedError);

        const interruptedEv = bridge.emittedEvents.find(
            (e) => e.event === 'agentic_turn_interrupted',
        );
        const midGenErrEv = bridge.emittedEvents.find(
            (e) => e.event === 'agentic_generation_error',
        );
        expect(interruptedEv).toBeDefined();
        expect(midGenErrEv).toBeDefined();
        expect((interruptedEv!.payload as ToolEventPayload).reason).toBe('error');
        expect((midGenErrEv!.payload as ToolEventPayload).type).toBe('generation_error');
        expect((midGenErrEv!.payload as ToolEventPayload).phase).toBe('main_turn');
        expect((midGenErrEv!.payload as ToolEventPayload).error).toContain('Mid-turn network drop');
    });
});
