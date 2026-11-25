import { describe, expect, it } from 'vitest';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { PipelineOrchestrator, TurnInterruptedError } from '@/core/triggers';
import type { GenerationEventPayload, RawLoreEntry, Settings, TriggerRule } from '@/core/types';
import { IframeJsSandbox } from '@/sandbox';
import {
    assertAppendOnlyPrefix,
    DeferredGate,
    MemoryHostBridge,
    ScriptedLLMTransport,
} from '../../mocks';

function writeOutputTurn(text: string, id: string = 'write_out') {
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

function createPipelineFixture(options: {
    triggers?: TriggerRule[];
    lorebooks?: Record<string, RawLoreEntry[]>;
    agents?: Record<string, ReturnType<typeof createDefaultMainAgent>>;
    ejsEvaluator?: (text: string, vars: Record<string, unknown>) => string | Promise<string>;
    watermark?: { high: number; low: number };
} = {}) {
    const bridge = new MemoryHostBridge({
        identity: { userName: '沈默', charName: '林晚' },
        characterFields: { description: '灰港调查员。' },
        lorebooks: options.lorebooks,
        ejsEvaluator: options.ejsEvaluator,
    });

    const conn = createDefaultConnection({
        id: 'conn_main',
        model: 'test-model',
        stream: false,
    });

    const mainAgent = createDefaultMainAgent({
        id: 'main',
        connectionId: 'conn_main',
        sessionMode: 'persistent',
        watermark: options.watermark ?? { high: 36000, low: 18000 },
        enabledTools: ['read_file', 'write_file', 'read_variables', 'patch_variables'],
        permissions: { read: ['/**'], write: ['/memory/**', '/state/variables.json'] },
    });

    const preset = createDefaultPreset({
        id: 'preset_test',
        mainAgentId: 'main',
        agents: {
            main: mainAgent,
            ...(options.agents ?? {}),
        },
        triggers: options.triggers ?? [],
    });

    const settings: Settings = createDefaultSettings({
        runMode: 'takeover',
        connections: { [conn.id]: conn },
        currentConnectionId: conn.id,
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

describe('PipelineOrchestrator & 3-Tier BarrierCoordinator', () => {
    it("blocks Turn 2 before_turn until Turn 1 'turn' barrier settles while keeping Turn 1 return non-blocking", async () => {
        const turn1BarrierGate = new DeferredGate<void>();
        const executionOrder: string[] = [];

        const varsAgent = createDefaultMainAgent({
            id: 'ag_vars',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables', 'patch_variables'],
            permissions: { read: ['/state/variables.json'], write: ['/state/variables.json'] },
        });

        const beforeAgent = createDefaultMainAgent({
            id: 'ag_before',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables'],
            permissions: { read: ['/state/variables.json'], write: [] },
        });

        const triggers: TriggerRule[] = [
            {
                id: 'tr_before_brief',
                label: 'Before Brief',
                source: 'preset',
                phase: 'before_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_before',
                kind: 'agent',
                condition: { type: 'always' },
                instructionTemplate: 'Read variables and produce turn brief.',
                enabled: true,
            },
            {
                id: 'tr_after_vars',
                label: 'Vars Update',
                source: 'preset',
                phase: 'after_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_vars',
                kind: 'agent',
                targetPath: '/state/variables.json',
                condition: { type: 'always' },
                instructionTemplate: 'Set hp=75.',
                enabled: true,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            triggers,
            agents: { ag_vars: varsAgent, ag_before: beforeAgent },
        });
        await orchestrator.vfs.writeVariables({ hp: 100 }, { target: { messageId: 0, swipeId: 0 } });

        // Turn 1 messages
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: 'Turn 1 user' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        // Turn 1 before_turn -> Turn 1 main_turn -> Turn 1 after_turn (paused at gate!)
        transport.enqueue(
            () => {
                executionOrder.push('t1_before');
                return { content: 'T1 Brief: HP=100' };
            },
            (req) => {
                executionOrder.push('t1_main');
                expect(String(req.messages[req.messages.length - 1].content)).toContain('<turn-brief>');
                expect(String(req.messages[req.messages.length - 1].content)).toContain('T1 Brief: HP=100');
                return writeOutputTurn('Turn 1 Reply', 'w_t1');
            },
            { content: 't1 main done' },
            async () => {
                executionOrder.push('t1_after_turn_barrier_enter');
                await turn1BarrierGate.wait();
                executionOrder.push('t1_after_turn_barrier_patch');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'patch_t1',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 75 } }),
                        },
                    ],
                };
            },
            { content: 'Vars updated to 75' },
        );

        const t1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: 'Turn 1 user',
        });

        // Turn 1 returned immediately while 'turn' barrier task is still running!
        expect(t1.content).toBe('Turn 1 Reply');
        expect(t1.afterTurnTasks).toHaveLength(1);
        await turn1BarrierGate.waitUntilWaiting();
        expect(executionOrder).toEqual(['t1_before', 't1_main', 't1_after_turn_barrier_enter']);

        // Start Turn 2 while Turn 1 'turn' barrier is still suspended!
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: 'Turn 2 user' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        let turn2BeforeEntered = false;
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'read_t2',
                        name: 'read_variables',
                        arguments: JSON.stringify({ path: 'hp' }),
                    },
                ],
            },
            (req) => {
                turn2BeforeEntered = true;
                executionOrder.push('t2_before');
                const toolRes = req.messages.find((m) => m.role === 'tool');
                // Turn 2 MUST observe hp=75 written by Turn 1's 'turn' barrier!
                expect(String(toolRes?.content)).toContain('75');
                return { content: 'T2 Brief: HP=75' };
            },
            (req) => {
                executionOrder.push('t2_main');
                expect(String(req.messages[req.messages.length - 1].content)).toContain('T2 Brief: HP=75');
                return writeOutputTurn('Turn 2 Reply', 'w_t2');
            },
            { content: 't2 main done' },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'patch_t2',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { hp: 50 } }),
                    },
                ],
            },
            { content: 'Vars updated to 50' },
        );

        const turn2Promise = orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 3, swipeId: 0 },
            userInput: 'Turn 2 user',
        });

        // Flush microtasks: Turn 2 MUST still be blocked before entering before_turn!
        await new Promise((r) => setTimeout(r, 25));
        expect(turn2BeforeEntered).toBe(false);

        // Release Turn 1 'turn' barrier -> Turn 2 proceeds and reads committed hp=75
        turn1BarrierGate.resolve();
        const t2 = await turn2Promise;
        expect(t2.content).toBe('Turn 2 Reply');
        expect(turn2BeforeEntered).toBe(true);
        expect(executionOrder).toEqual([
            't1_before',
            't1_main',
            't1_after_turn_barrier_enter',
            't1_after_turn_barrier_patch',
            't2_before',
            't2_main',
        ]);

        await orchestrator.barrierCoordinator.awaitAllSettled();
    });

    it("serializes 'self' barrier tasks FIFO by agentProfileId/targetPath without blocking Turn 2 main_turn", async () => {
        const t1SelfGate = new DeferredGate<void>();
        const selfOrder: string[] = [];

        const chronicler = createDefaultMainAgent({
            id: 'ag_chronicler',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['write_file'],
            permissions: { read: ['/**'], write: ['/memory/**'] },
        });

        const triggers: TriggerRule[] = [
            {
                id: 'tr_outline',
                label: 'Outline Update',
                source: 'preset',
                phase: 'after_turn',
                order: 1,
                barrier: 'self',
                agentProfileId: 'ag_chronicler',
                kind: 'agent',
                targetPath: '/memory/outline.md',
                condition: { type: 'always' },
                instructionTemplate: 'Append outline',
                enabled: true,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            triggers,
            agents: { ag_chronicler: chronicler },
        });

        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: 'Turn 1' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: 'Turn 2' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            writeOutputTurn('Main Turn 1', 'w_self_1'),
            { content: 'm1 done' },
            async () => {
                selfOrder.push('self_t1_start');
                await t1SelfGate.wait();
                selfOrder.push('self_t1_finish');
                return { content: 'Outline T1 done' };
            },
            writeOutputTurn('Main Turn 2', 'w_self_2'),
            { content: 'm2 done' },
            async () => {
                selfOrder.push('self_t2_start');
                return { content: 'Outline T2 done' };
            },
        );

        const t1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: 'Turn 1',
        });
        await t1SelfGate.waitUntilWaiting();

        // Turn 2 completes main_turn IMMEDIATELY without waiting for Turn 1's 'self' task!
        const t2 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 3, swipeId: 0 },
            userInput: 'Turn 2',
        });
        expect(t2.content).toBe('Main Turn 2');

        // Turn 2's 'self' task must still be 'queued' behind Turn 1's 'self' task!
        expect(t1.afterTurnTasks[0].getStatus().state).toBe('running');
        expect(t2.afterTurnTasks[0].getStatus().state).toBe('queued');
        expect(selfOrder).toEqual(['self_t1_start']);

        // Release Turn 1 'self' task -> Turn 2 'self' task executes strictly afterwards in FIFO order
        t1SelfGate.resolve();
        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(selfOrder).toEqual(['self_t1_start', 'self_t1_finish', 'self_t2_start']);
        expect(t1.afterTurnTasks[0].getStatus().state).toBe('completed');
        expect(t2.afterTurnTasks[0].getStatus().state).toBe('completed');
    });

    it("anchors 'none' barrier tasks to exact (messageId, swipeId) across 3 later turns and aborts cleanly on Swipe or Cancel", async () => {
        const t1NoneGate = new DeferredGate<void>();

        const artistAgent = createDefaultMainAgent({
            id: 'ag_artist',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['attach_media', 'append_reply_view'],
            permissions: { read: ['/**'], write: [] },
        });

        const triggers: TriggerRule[] = [
            {
                id: 'tr_illust',
                label: 'Scene Illustration',
                source: 'preset',
                phase: 'after_turn',
                order: 1,
                barrier: 'none',
                agentProfileId: 'ag_artist',
                kind: 'agent',
                condition: { type: 'keyword', keys: ['灯塔'] },
                instructionTemplate: 'Generate illustration for the lighthouse scene.',
                enabled: true,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            triggers,
            agents: { ag_artist: artistAgent },
        });

        // Turn 1 (messageId: 1, swipeId: 0) triggers detached 'none' illustration task
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '前往灯塔' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            writeOutputTurn('灯塔在雨雾中闪烁。', 'w_lighthouse'),
            { content: 'main 1 done' },
            async () => {
                await t1NoneGate.wait();
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'attach_1',
                            name: 'attach_media',
                            arguments: JSON.stringify({ type: 'image', url: '/img/lighthouse-1-0.png' }),
                        },
                        {
                            id: 'append_1',
                            name: 'append_reply_view',
                            arguments: JSON.stringify({ text: '[插图已回填至1#0]' }),
                        },
                    ],
                };
            },
        );

        const t1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '前往灯塔',
        });
        expect(t1.afterTurnTasks).toHaveLength(1);
        await t1NoneGate.waitUntilWaiting();

        // Advance 3 MORE turns (turns 2, 3, 4) while Turn 1 'none' task is still in-flight!
        for (let turn = 2; turn <= 4; turn += 1) {
            const uId = (turn - 1) * 2;
            const aId = uId + 1;
            bridge.pushMessage({ id: uId, name: '沈默', isUser: true, mes: `继续第${turn}轮对话` });
            bridge.pushMessage({ id: aId, name: '林晚', isUser: false, mes: '', swipeId: 0 });
            transport.enqueue(
                writeOutputTurn(`第${turn}轮回复`, `w_turn_${turn}`),
                { content: `turn ${turn} done` },
            );

            const res = await orchestrator.runTurn({
                action: 'normal',
                target: { messageId: aId, swipeId: 0 },
                userInput: `继续第${turn}轮对话`,
            });
            expect(res.content).toBe(`第${turn}轮回复`);
        }

        // Now enqueue Turn 1's second round and release Turn 1's detached 'none' task!
        transport.enqueue({ content: '插图挂载完成' });
        t1NoneGate.resolve();
        await t1.afterTurnTasks[0].promise;

        // Attachment & /output.md message write MUST anchor strictly to { messageId: 1, swipeId: 0 }!
        expect(bridge.mediaAttachments).toHaveLength(1);
        expect(bridge.mediaAttachments[0].target).toEqual({ messageId: 1, swipeId: 0 });
        expect(bridge.mediaAttachments[0].media.url).toBe('/img/lighthouse-1-0.png');

        const msg1Text = bridge.readChatMessage({ messageId: 1, swipeId: 0 });
        expect(msg1Text).toContain('灯塔在雨雾中闪烁。');
        expect(msg1Text).toContain('[插图已回填至1#0]');

        // Later turns (e.g. messageId 7) remain completely untouched!
        expect(bridge.readChatMessage({ messageId: 7, swipeId: 0 })).toBe('第4轮回复');
    });

    it('enforces Swipe, Regenerate, Continue, and targeted single-task Cancel causal isolation', async () => {
        const swipeGate = new DeferredGate<void>();
        const olderTurnGate = new DeferredGate<void>();

        const bgAgent = createDefaultMainAgent({
            id: 'ag_bg',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['write_file', 'attach_media'],
            permissions: { read: ['/**'], write: ['/memory/**'] },
        });

        const triggers: TriggerRule[] = [
            {
                id: 'tr_before_note',
                label: 'Before Note',
                source: 'preset',
                phase: 'before_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_bg',
                kind: 'agent',
                condition: { type: 'always' },
                instructionTemplate: 'Produce before brief.',
                enabled: true,
            },
            {
                id: 'tr_after_bg',
                label: 'After Bg',
                source: 'preset',
                phase: 'after_turn',
                order: 1,
                barrier: 'none',
                agentProfileId: 'ag_bg',
                kind: 'agent',
                condition: { type: 'always' },
                instructionTemplate: 'Background work.',
                enabled: true,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            triggers,
            agents: { ag_bg: bgAgent },
        });

        // Turn 1 on message 1#0
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: 'U0' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            { content: 'Brief 1' },
            writeOutputTurn('Reply 1#0', 'w_1_0'),
            { content: 'done 1#0' },
            async () => {
                await olderTurnGate.wait();
                return { content: 'Bg 1#0 finished' };
            },
        );
        const turn1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: 'U0',
        });
        await olderTurnGate.waitUntilWaiting();

        // Turn 2 on message 3#0 (its 'none' task pauses on swipeGate; later we swipe 3#0 -> 3#1)
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: 'U2' });
        bridge.pushMessage({
            id: 3,
            name: '林晚',
            isUser: false,
            mes: '',
            swipeId: 0,
            swipes: ['', ''],
            swipeInfo: [{}, {}],
        });
        transport.enqueue(
            { content: 'Brief 3#0' },
            writeOutputTurn('Reply 3#0', 'w_3_0'),
            { content: 'done 3#0' },
            async () => {
                await swipeGate.wait();
                return { content: 'Bg 3#0 should abort' };
            },
        );
        const turn2Swipe0 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 3, swipeId: 0 },
            userInput: 'U2',
        });
        await swipeGate.waitUntilWaiting();

        // Stage something uncommitted on 3#0 to verify rollback on Swipe
        orchestrator.store.stageSet('files', 'memory/swipe0-temp.md', 'test', 'stale-0', {
            messageId: 3,
            swipeId: 0,
        });

        // Action: SWIPE message 3 from swipeId 0 -> swipeId 1!
        bridge.chat[3].swipeId = 1;
        transport.enqueue(
            { content: 'Brief 3#1' },
            (req) => {
                // TrajectoryStore must have rolled back to Turn 1 (1#0), NOT containing Reply 3#0!
                const serialized = JSON.stringify(req.messages);
                expect(serialized).toContain('Reply 1#0');
                expect(serialized).not.toContain('Reply 3#0');
                return writeOutputTurn('Reply 3#1', 'w_3_1');
            },
            { content: 'done 3#1' },
            { content: 'Bg 3#1 finished' },
        );

        const turn2Swipe1 = await orchestrator.runTurn({
            action: 'swipe',
            target: { messageId: 3, swipeId: 1 },
            previousSwipeId: 0,
            userInput: 'U2',
        });
        expect(turn2Swipe1.content).toBe('Reply 3#1');

        // Old swipe 3#0 task was aborted & pending data rolled back, while Turn 1 (1#0) task is STILL running!
        expect(turn2Swipe0.afterTurnTasks[0].getStatus().state).toBe('aborted');
        expect(
            orchestrator.store.getPending('files', 'memory/swipe0-temp.md', {
                target: { messageId: 3, swipeId: 0 },
            }),
        ).toBeNull();
        expect(turn1.afterTurnTasks[0].getStatus().state).toBe('running');

        // Single-task cancel cancels ONLY Turn 1's task
        expect(orchestrator.cancelBackgroundTask(turn1.afterTurnTasks[0].taskId)).toBe(true);
        expect(turn1.afterTurnTasks[0].getStatus().state).toBe('aborted');
        swipeGate.resolve();
        olderTurnGate.resolve();
        await orchestrator.barrierCoordinator.awaitAllSettled();

        // Action: CONTINUE on 3#1 -> MUST skip before_turn and append to /output.md without double-merging!
        bridge.chat[3].mes = 'Reply 3#1';
        bridge.chat[3].swipes = ['Reply 3#0', 'Reply 3#1'];
        transport.enqueue(
            (req) => {
                const serialized = JSON.stringify(req.messages);
                const lastMsgText = String(req.messages[req.messages.length - 1].content);
                expect(serialized).toContain('Reply 3#1');
                // Continue skips before_turn: no new <turn-brief> in Layer 2 continuation message
                expect(lastMsgText).not.toContain('<turn-brief>');
                expect(lastMsgText).toContain('Continue seamlessly');
                expect(lastMsgText).toContain('/output.md');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'app_3_1',
                            name: 'append_file',
                            arguments: JSON.stringify({ path: '/output.md', content: ' ...continued!' }),
                        },
                    ],
                };
            },
            { content: 'Continue review done' },
            { content: 'Bg continue finished' },
        );

        const continued = await orchestrator.runTurn({
            action: 'continue',
            target: { messageId: 3, swipeId: 1 },
            userInput: 'U2',
            existingContent: 'Reply 3#1',
        });
        expect(continued.beforeTurnResults).toHaveLength(0);
        expect(continued.deltaContent).toBe(' ...continued!');
        expect(continued.content).toBe('Reply 3#1 ...continued!');
        expect(bridge.readChatMessage({ messageId: 3, swipeId: 1 })).toBe('Reply 3#1 ...continued!');
        await orchestrator.barrierCoordinator.awaitAllSettled();

        // Action: REGENERATE from message 3 -> clears layers & checkpoints >= 3 and re-runs full turn
        orchestrator.store.set('files', 'memory/after-3.md', 'test', 'to-be-pruned', {
            messageId: 3,
            swipeId: 1,
        });
        transport.enqueue(
            { content: 'Brief 3 regen' },
            (req) => {
                const serialized = JSON.stringify(req.messages);
                expect(serialized).toContain('Reply 1#0');
                expect(serialized).not.toContain('Reply 3#1');
                expect(serialized).not.toContain('...continued!');
                return writeOutputTurn('Regenerated 3#1', 'w_regen');
            },
            { content: 'done regen' },
            { content: 'Bg regen finished' },
        );

        const regen = await orchestrator.runTurn({
            action: 'regenerate',
            target: { messageId: 3, swipeId: 1 },
            userInput: 'U2',
        });
        expect(regen.content).toBe('Regenerated 3#1');
        expect(
            orchestrator.store.get('files', 'memory/after-3.md', {
                target: { messageId: 3, swipeId: 1 },
            }),
        ).toBeNull();

        await orchestrator.barrierCoordinator.awaitAllSettled();
    });

    it('evaluates all 5 condition types, runs 0-token @@script/@@evaluate_ejs, supports @@group merge, rerunAfterTurn, and maintenance compaction', async () => {
        const ejsCalls: string[] = [];
        const chronicler = createDefaultMainAgent({
            id: 'chronicler',
            connectionId: 'conn_main',
            sessionMode: 'ephemeral',
            enabledTools: ['write_file'],
            permissions: { read: ['/**'], write: ['/memory/**'] },
        });

        const loreEntries: RawLoreEntry[] = [
            {
                world: 'Chronicle',
                uid: 1,
                comment: 'EJS 0-Token Hook',
                content: '@@evaluate_ejs_before\n<% mark("ran") %>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 1,
                role: 0,
            },
            {
                world: 'Chronicle',
                uid: 2,
                comment: 'JS Script 0-Token',
                content: '@@script phase=before order=2 barrier=turn\nawait vars.set("scriptRan", true); return "ScriptBrief: ready";',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 2,
                role: 0,
            },
            {
                world: 'Chronicle',
                uid: 3,
                comment: 'Grouped A',
                content: '@@trigger phase=after order=1 barrier=self profile=chronicler\n@@group digest\nTask A',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 1,
                role: 0,
            },
            {
                world: 'Chronicle',
                uid: 4,
                comment: 'Grouped B',
                content: '@@trigger phase=after order=1 barrier=self profile=chronicler\n@@group digest\nTask B',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 1,
                role: 0,
            },
        ];

        const extraTriggers: TriggerRule[] = [
            {
                id: 'cond_interval',
                label: 'Interval 2',
                source: 'preset',
                phase: 'after_turn',
                order: 2,
                barrier: 'self',
                agentProfileId: 'chronicler',
                kind: 'script',
                condition: { type: 'interval', interval: 2 },
                instructionTemplate: '',
                scriptCode: 'await vars.set("intervalHit", true);',
                enabled: true,
            },
            {
                id: 'cond_regex',
                label: 'Regex Condition',
                source: 'preset',
                phase: 'after_turn',
                order: 3,
                barrier: 'self',
                agentProfileId: 'chronicler',
                kind: 'script',
                condition: { type: 'regex', pattern: '/银莲花/' },
                instructionTemplate: '',
                scriptCode: 'await vars.set("regexHit", true);',
                enabled: true,
            },
            {
                id: 'cond_js_pred',
                label: 'JS Predicate',
                source: 'preset',
                phase: 'after_turn',
                order: 4,
                barrier: 'self',
                agentProfileId: 'chronicler',
                kind: 'script',
                condition: {
                    type: 'js_predicate',
                    predicateCode: 'return (await vars.get("scriptRan")) === true;',
                },
                instructionTemplate: '',
                scriptCode: 'await vars.set("predicateHit", true);',
                enabled: true,
            },
        ];

        const { bridge, transport, traceLogger, orchestrator } = createPipelineFixture({
            triggers: extraTriggers,
            lorebooks: { Chronicle: loreEntries },
            agents: { chronicler },
            ejsEvaluator: (code) => {
                ejsCalls.push(code);
                return '';
            },
            // Very low watermark so maintenance triggers after Turn 2
            watermark: { high: 200, low: 100 },
        });

        // Turn 1: interval=2 should NOT fire; regex /银莲花/ DOES fire; js_predicate fires; grouped A+B run as ONE LLM call!
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查剧本' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            (req) => {
                // before_turn 0-token script returned "ScriptBrief: ready" -> injected into <turn-brief>
                expect(String(req.messages[req.messages.length - 1].content)).toContain('ScriptBrief: ready');
                return writeOutputTurn('我看到银莲花刻痕。'.repeat(15), 'w_lore_1');
            },
            { content: 'main 1 done' },
            (req) => {
                // Grouped A + B merged into 1 single LLM invocation
                const prompt = String(req.messages[req.messages.length - 1].content);
                expect(prompt).toContain('Task A');
                expect(prompt).toContain('Task B');
                return { content: 'Digest A+B completed' };
            },
        );

        const t1 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '检查剧本',
            turnNumber: 1,
        });

        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(ejsCalls).toHaveLength(1);
        expect(t1.beforeTurnBrief).toBe('ScriptBrief: ready');
        // 2 main_turn calls (write_file + finish) + 1 merged @@group call (scripts consumed 0 LLM tokens!)
        expect(transport.requests).toHaveLength(3);

        const varsT1 = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(varsT1.scriptRan).toBe(true);
        expect(varsT1.regexHit).toBe(true);
        expect(varsT1.predicateHit).toBe(true);
        expect(varsT1.intervalHit).toBeUndefined();

        // Turn 2: interval=2 fires AND high watermark triggers maintenance compaction!
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '第二回合' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            writeOutputTurn('第二回合足够长的回复内容。'.repeat(20), 'w_lore_2'),
            { content: 'main 2 done' },
            { content: 'Digest T2 completed' },
        );

        const t2 = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 3, swipeId: 0 },
            userInput: '第二回合',
            turnNumber: 2,
        });
        bridge.chat[3].mes = t2.content;
        bridge.chat[3].swipes = [t2.content];

        await orchestrator.barrierCoordinator.awaitAllSettled();

        const varsT2 = await orchestrator.vfs.readVariables({ target: { messageId: 3, swipeId: 0 } });
        expect(varsT2.intervalHit).toBe(true);
        expect(t2.maintenanceTasks.length).toBeGreaterThanOrEqual(1);
        expect(await orchestrator.vfs.exists('/history/chunk-001.md')).toBe(true);

        // Verify rerunAfterTurn manual recovery re-dispatches after_turn triggers for target (3, 0)
        transport.enqueue({ content: 'Manual rerun digest' });
        const rerunHandles = await orchestrator.rerunAfterTurn({ messageId: 3, swipeId: 0 }, { turnNumber: 2 });
        expect(rerunHandles.length).toBeGreaterThanOrEqual(1);
        await orchestrator.barrierCoordinator.awaitAllSettled();

        const scriptTraces = traceLogger.listTraces({ agentProfileId: 'script' });
        expect(scriptTraces.some((tr) => tr.model === '0-token-script' && tr.usage.totalTokens === 0)).toBe(true);
    });

    it("serializes 'self' barrier FIFO across distinct agents sharing targetPath and runs legacy @@variables_json + @@zod_schema self-healing end-to-end", async () => {
        const sharedGate = new DeferredGate<void>();
        const sharedOrder: string[] = [];

        const writerA = createDefaultMainAgent({ id: 'writer_a', connectionId: 'conn_main', sessionMode: 'ephemeral' });
        const writerB = createDefaultMainAgent({ id: 'writer_b', connectionId: 'conn_main', sessionMode: 'ephemeral' });

        const { bridge, transport, orchestrator } = createPipelineFixture({
            agents: { writer_a: writerA, writer_b: writerB },
            lorebooks: {
                StateBook: [
                    {
                        world: 'StateBook',
                        uid: 77,
                        comment: 'HP Settlement',
                        content: [
                            '@@variables_json',
                            '@@zod_schema z.object({ hp: z.number().min(0).max(100) }).loose()',
                            'Update hp in /state/variables.json.',
                        ].join('\n'),
                        keys: [],
                        keysecondary: [],
                        constant: true,
                        selective: false,
                        disable: false,
                        position: 1,
                        depth: 4,
                        order: 1,
                        role: 0,
                    },
                ],
            },
        });

        await orchestrator.vfs.writeVariables({ hp: 100 }, { target: { messageId: 0, swipeId: 0 } });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '受伤了' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            writeOutputTurn('主角被流矢擦伤。', 'w_hurt'),
            { content: 'main hurt done' },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'bad_hp',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { hp: -20 } }),
                    },
                ],
            },
            (req) => {
                const toolMsg = req.messages.find((m) => m.role === 'tool');
                expect(String(toolMsg?.content)).toContain('hp');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'good_hp',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 82 } }),
                        },
                    ],
                };
            },
            { content: '已修正 hp=82' },
        );

        await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '受伤了',
        });
        await orchestrator.barrierCoordinator.awaitAllSettled();

        const varsAfterHeal = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(varsAfterHeal.hp).toBe(82);

        // Verify two distinct agentProfileIds sharing targetPath '/memory/shared.md' still serialize FIFO under 'self'
        const h1 = orchestrator.barrierCoordinator.dispatch(
            {
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'self',
                agentProfileId: 'writer_a',
                label: 'Writer A',
                targetPath: '/memory/shared.md',
            },
            async () => {
                sharedOrder.push('a_start');
                await sharedGate.wait();
                sharedOrder.push('a_end');
            },
        );
        const h2 = orchestrator.barrierCoordinator.dispatch(
            {
                target: { messageId: 3, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'self',
                agentProfileId: 'writer_b',
                label: 'Writer B',
                targetPath: '/memory/shared.md',
            },
            async () => {
                sharedOrder.push('b_start');
                sharedOrder.push('b_end');
            },
        );

        expect(h1.getStatus().state).toBe('running');
        expect(h2.getStatus().state).toBe('queued');
        await sharedGate.waitUntilWaiting();
        sharedGate.resolve();
        await Promise.all([h1.promise, h2.promise]);

        expect(sharedOrder).toEqual(['a_start', 'a_end', 'b_start', 'b_end']);
    });

    it('recovers across 2 consecutive length interruptions via resumeTurn and continue while preserving 100% KV prefix invariance and staged data', async () => {
        const beforeScriptTrigger: TriggerRule = {
            id: 'tr_before_stage',
            label: 'Before Stager',
            source: 'preset',
            phase: 'before_turn',
            order: 1,
            barrier: 'turn',
            agentProfileId: 'script',
            kind: 'script',
            condition: { type: 'always' },
            instructionTemplate: '',
            scriptCode: 'await vars.set("stagedBefore", true); return "StageBrief: ready";',
            enabled: true,
        };

        const loreEntry: RawLoreEntry = {
            world: 'Harbor',
            uid: 70,
            comment: '秘密档案',
            content: '三号泊位地下室的密道钥匙藏在铜锚后方。',
            keys: ['铜锚', '密道'],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 1,
            depth: 4,
            order: 1,
            role: 0,
        };

        const { bridge, transport, traceLogger, orchestrator } = createPipelineFixture({
            triggers: [beforeScriptTrigger],
            lorebooks: { Harbor: [loreEntry] },
        });

        const events: GenerationEventPayload[] = [];
        traceLogger.subscribe((ev) => events.push(ev));

        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查铜锚并写出长篇记录' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        // Hop 1: Round 0 reads lore file (populates Read-Set); Round 1 hits finishReason='length' mid-write_file!
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'hop1_read_lore',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/lorebooks/Harbor/秘密档案-70.md' }),
                    },
                ],
            },
            {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'hop1_write_trunc',
                        toolName: 'write_file',
                        argumentsDelta: '{"path":"/output.md","content":"第一段：码头夜雾。',
                    },
                    { type: 'done', finishReason: 'length' },
                ],
            },
        );

        let hop1Err: unknown;
        try {
            await orchestrator.runTurn({
                action: 'normal',
                target: { messageId: 1, swipeId: 0 },
                userInput: '检查铜锚并写出长篇记录',
                stream: true,
            });
        } catch (err) {
            hop1Err = err;
        }

        expect(hop1Err).toBeInstanceOf(TurnInterruptedError);
        const hop1Interrupted = hop1Err as TurnInterruptedError;
        expect(hop1Interrupted.reason).toBe('length');
        expect(hop1Interrupted.salvagedOutput).toBe('第一段：码头夜雾。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('第一段：码头夜雾。');
        expect(orchestrator.store.hasPending({ messageId: 1, swipeId: 0 })).toBe(true);
        expect(events.some((e) => e.kind === 'turn_interrupted' && e.interruptedReason === 'length')).toBe(true);

        // Persisted in HostBridge metadata -> survives TrajectoryStore.loadFromHost reload
        const reloadedStore = TrajectoryStore.loadFromHost(bridge);
        const persistedCp = reloadedStore.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 });
        expect(persistedCp).toBeDefined();
        expect(persistedCp?.readSetSnapshot['/lorebooks/Harbor/秘密档案-70.md']).toBeDefined();
        expect(JSON.parse(persistedCp!.stagedSnapshot.variables['variables.json'].content)).toMatchObject({
            stagedBefore: true,
        });

        const hop1Req = transport.requests[1];

        // Hop 2: explicit resumeTurn() -> appends second segment, then hits finishReason='length' AGAIN!
        transport.enqueue((req) => {
            assertAppendOnlyPrefix(hop1Req, req);
            const lastMsg = req.messages[req.messages.length - 1];
            expect(lastMsg.role).toBe('user');
            expect(String(lastMsg.content)).toContain('[System Recovery]');
            expect(String(lastMsg.content)).toContain('第一段：码头夜雾。');
            expect(String(lastMsg.content)).not.toContain('<lore-hint>');

            return {
                chunks: [
                    {
                        type: 'tool_call_delta',
                        toolCallIndex: 0,
                        toolCallId: 'hop2_append_trunc',
                        toolName: 'append_file',
                        argumentsDelta: '{"path":"/output.md","content":"第二段：银莲花徽记。',
                    },
                    { type: 'done', finishReason: 'length' },
                ],
            };
        });

        let hop2Err: unknown;
        try {
            await orchestrator.resumeTurn({
                target: { messageId: 1, swipeId: 0 },
                stream: true,
            });
        } catch (err) {
            hop2Err = err;
        }

        expect(hop2Err).toBeInstanceOf(TurnInterruptedError);
        const hop2Interrupted = hop2Err as TurnInterruptedError;
        expect(hop2Interrupted.reason).toBe('length');
        expect(hop2Interrupted.salvagedOutput).toBe('第一段：码头夜雾。第二段：银莲花徽记。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '第一段：码头夜雾。第二段：银莲花徽记。',
        );

        const hop2Req = transport.requests[2];

        // Hop 3: runTurn({ action: 'continue' }) auto-detects checkpoint -> appends final segment, edits in-turn, and finishes!
        transport.enqueue(
            (req) => {
                assertAppendOnlyPrefix(hop2Req, req);
                const lastMsg = req.messages[req.messages.length - 1];
                expect(String(lastMsg.content)).toContain('[System Recovery]');
                expect(String(lastMsg.content)).toContain('第二段：银莲花徽记。');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'hop3_append_end',
                            name: 'append_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '第三段：真相大白。',
                            }),
                        },
                    ],
                };
            },
            {
                content: '',
                toolCalls: [
                    {
                        id: 'hop3_edit_review',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            search: '真相大白',
                            replace: '暗门开启',
                        }),
                    },
                ],
            },
            {
                content: 'All 3 hops reviewed and complete.',
            },
        );

        const hop3Res = await orchestrator.runTurn({
            action: 'continue',
            target: { messageId: 1, swipeId: 0 },
            stream: true,
        });

        expect(hop3Res.content).toBe('第一段：码头夜雾。第二段：银莲花徽记。第三段：暗门开启。');
        expect(hop3Res.deltaContent).toBe('第三段：暗门开启。');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '第一段：码头夜雾。第二段：银莲花徽记。第三段：暗门开启。',
        );
        expect(orchestrator.trajectoryStore.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 })).toBeUndefined();
        expect(events.some((e) => e.kind === 'turn_resumed')).toBe(true);
        expect(events.some((e) => e.kind === 'turn_completed')).toBe(true);

        // Staged before_turn variable survived both interrupts and committed on Hop 3 completion!
        const finalVars = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(finalVars.stagedBefore).toBe(true);

        const hop3LastReq = transport.requests[transport.requests.length - 1];

        // Turn 2 after multi-hop resume STILL preserves 100% KV Cache prefix invariance!
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '进入暗门。' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            (req) => {
                assertAppendOnlyPrefix(hop3LastReq, req);
                return writeOutputTurn('我们顺着暗门台阶下行。', 'w_turn2_after_resume');
            },
            { content: 'Turn 2 ok' },
        );
        const turn2Res = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 3, swipeId: 0 },
            userInput: '进入暗门。',
            stream: false,
        });
        expect(turn2Res.content).toBe('我们顺着暗门台阶下行。');

        // Also verify swipe & regenerate clear interrupted checkpoints cleanly
        bridge.pushMessage({ id: 4, name: '沈默', isUser: true, mes: '测试清理' });
        bridge.pushMessage({
            id: 5,
            name: '林晚',
            isUser: false,
            mes: '',
            swipeId: 0,
            swipes: ['', ''],
            swipeInfo: [{}, {}],
        });
        orchestrator.trajectoryStore.saveInterruptedCheckpoint({
            agentId: 'main',
            target: { messageId: 5, swipeId: 0 },
            reason: 'user_stop',
            completedTurnMessages: [{ role: 'user', content: '测试清理' }],
            readSetSnapshot: {},
            stagedSnapshot: {},
            createdAt: Date.now(),
        });
        bridge.chat[5].swipeId = 1;
        transport.enqueue(writeOutputTurn('Swipe 1 clean', 'w_s1'), { content: 'done' });
        await orchestrator.runTurn({
            action: 'swipe',
            target: { messageId: 5, swipeId: 1 },
            previousSwipeId: 0,
            userInput: '测试清理',
        });
        expect(orchestrator.trajectoryStore.getInterruptedCheckpoint({ messageId: 5, swipeId: 0 })).toBeUndefined();
    });

    it('runs @@replace_output and @@trigger target=/output.md direct edits with anchor-miss self-heal and per-floor /output.md@M#S barriers', async () => {
        const loreEntries: RawLoreEntry[] = [
            {
                world: 'EditBook',
                uid: 10,
                comment: '正文局部修校',
                content: '@@replace_output\n@@batch_order 1\n把文中错词修正。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 1,
                depth: 4,
                order: 1,
                role: 0,
            },
            {
                world: 'EditBook',
                uid: 11,
                comment: '追加状态尾部',
                content: '@@trigger phase=after order=2 barrier=self target=/output.md\n在 /output.md 末尾追加状态标签。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 1,
                depth: 4,
                order: 2,
                role: 0,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            lorebooks: { EditBook: loreEntries },
        });

        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查铁门' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        transport.enqueue(
            // main_turn writes initial /output.md
            writeOutputTurn('林晚走近生锈铁门。', 'w_door'),
            { content: 'main done' },
            // Trigger 1 (@@replace_output, order 1): bad anchor -> self-heal via read_file('/output.md') -> edit_file succeeds!
            {
                content: '',
                toolCalls: [
                    {
                        id: 'bad_anchor_edit',
                        name: 'edit_file',
                        arguments: JSON.stringify({
                            path: '/output.md',
                            search: '不存在的旧铁门',
                            replace: '铜锁暗门',
                        }),
                    },
                ],
            },
            (req) => {
                const errMsg = req.messages.find((m) => m.role === 'tool');
                expect(String(errMsg?.content)).toContain('Target text not found');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'reread_out',
                            name: 'read_file',
                            arguments: JSON.stringify({ path: '/output.md' }),
                        },
                    ],
                };
            },
            (req) => {
                const readMsg = req.messages.filter((m) => m.role === 'tool')[1];
                expect(String(readMsg?.content)).toBe('林晚走近生锈铁门。');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'fixed_anchor_edit',
                            name: 'edit_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                search: '生锈铁门',
                                replace: '铜锁暗门',
                            }),
                        },
                    ],
                };
            },
            { content: 'replace_output done' },
            // Trigger 2 (@@trigger target=/output.md, order 2): serialized behind Trigger 1 via path:/output.md@1#0, appends after edit!
            {
                content: '',
                toolCalls: [
                    {
                        id: 'read_after_edit',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/output.md' }),
                    },
                ],
            },
            (req) => {
                const readMsg = req.messages.find((m) => m.role === 'tool');
                expect(String(readMsg?.content)).toBe('林晚走近铜锁暗门。');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'append_badge',
                            name: 'append_file',
                            arguments: JSON.stringify({
                                path: '/output.md',
                                content: '\n[状态：警戒]',
                            }),
                        },
                    ],
                };
            },
            { content: 'append trigger done' },
        );

        const turnRes = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '检查铁门',
        });
        expect(turnRes.afterTurnTasks).toHaveLength(2);
        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe(
            '林晚走近铜锁暗门。\n[状态：警戒]',
        );

        // Verify BarrierCoordinator floor-scoped /output.md@M#S locks:
        // Same floor (1#0) serializes FIFO; different floor (3#0) executes in parallel without blocking!
        const floor1Gate = new DeferredGate<void>();
        const log: string[] = [];

        const f1TaskA = orchestrator.barrierCoordinator.dispatch(
            {
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'self',
                agentProfileId: 'editor_a',
                label: 'Editor A on 1#0',
                targetPath: '/output.md',
            },
            async () => {
                log.push('1#0:A:start');
                await floor1Gate.wait();
                log.push('1#0:A:end');
            },
        );
        const f1TaskB = orchestrator.barrierCoordinator.dispatch(
            {
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'self',
                agentProfileId: 'editor_b',
                label: 'Editor B on 1#0',
                targetPath: '/output.md',
            },
            async () => {
                log.push('1#0:B:start');
                log.push('1#0:B:end');
            },
        );
        const f3TaskC = orchestrator.barrierCoordinator.dispatch(
            {
                target: { messageId: 3, swipeId: 0 },
                phase: 'after_turn',
                barrier: 'self',
                agentProfileId: 'editor_c',
                label: 'Editor C on 3#0',
                targetPath: '/output.md',
            },
            async () => {
                log.push('3#0:C:start');
                log.push('3#0:C:end');
            },
        );

        await floor1Gate.waitUntilWaiting();
        expect(f1TaskA.getStatus().state).toBe('running');
        expect(f1TaskB.getStatus().state).toBe('queued');

        // Different floor (3#0) completes immediately while 1#0 A is still blocked!
        await f3TaskC.promise;
        expect(f3TaskC.getStatus().state).toBe('completed');
        expect(log).toEqual(['1#0:A:start', '3#0:C:start', '3#0:C:end']);

        floor1Gate.resolve();
        await Promise.all([f1TaskA.promise, f1TaskB.promise]);
        expect(log).toEqual([
            '1#0:A:start',
            '3#0:C:start',
            '3#0:C:end',
            '1#0:A:end',
            '1#0:B:start',
            '1#0:B:end',
        ]);
    });

    it('auto-merges legacy @@variables_json entries with merged Zod schemas in a single LLM call', async () => {
        const loreEntries: RawLoreEntry[] = [
            {
                world: 'VarsBook',
                uid: 1,
                comment: '生命值更新',
                content: [
                    '@@variables_json',
                    '@@zod_schema z.object({ hp: z.number().min(0).max(100) }).loose()',
                    '只输出 JSON，更新 hp 数值。',
                ].join('\n'),
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 100,
                role: 0,
            },
            {
                world: 'VarsBook',
                uid: 2,
                comment: '银币结算',
                content: [
                    '@@variables_json',
                    '@@zod_schema z.object({ coins: z.number().int().min(0) }).loose()',
                    '检测到银币关键词时更新 coins。',
                ].join('\n'),
                keys: ['银币'],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 120,
                role: 0,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            lorebooks: { VarsBook: loreEntries },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查钱袋' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        let sawMergedPrompt = false;
        let sawSchemaValidationError = false;

        transport.enqueue(
            writeOutputTurn('林晚拾起地上的三枚银币，擦去伤口的血迹。', 'w_vars_main'),
            { content: 'main done' },
            // 1 single merged after_turn LLM run (first tries invalid hp=150 -> self-heals on merged Zod schema -> patches both hp & coins)
            (req) => {
                const userPrompt = String(req.messages[req.messages.length - 1].content);
                expect(userPrompt).toContain('Grouped Trigger Batch (variables, 2 tasks)');
                expect(userPrompt).toContain('Complete ALL 2 tasks below before finishing');
                expect(userPrompt).toContain('只输出 JSON，更新 hp 数值。');
                expect(userPrompt).toContain('检测到银币关键词时更新 coins。');
                sawMergedPrompt = true;
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'bad_patch',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 150, coins: 3 } }),
                        },
                    ],
                };
            },
            (req) => {
                const toolMsg = req.messages.filter((m) => m.role === 'tool').pop();
                expect(String(toolMsg?.content)).toMatch(/validation|too_big|100/i);
                sawSchemaValidationError = true;
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'good_patch',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { hp: 85, coins: 3 } }),
                        },
                    ],
                };
            },
            { content: 'vars batch done' },
        );

        await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '检查钱袋',
        });
        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(sawMergedPrompt).toBe(true);
        expect(sawSchemaValidationError).toBe(true);
        expect(transport.requests).toHaveLength(5);

        const vars = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(vars).toMatchObject({ hp: 85, coins: 3 });
    });

    it('runs cross-type explicit @@group (@@variables_json + @@replace) in 1 LLM call and merges before_turn in runBeforeTurn', async () => {
        const loreEntries: RawLoreEntry[] = [
            {
                world: 'MixedBook',
                uid: 10,
                comment: '前置时间推进',
                content: '@@variables_json_before\n推进时间段。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 10,
                role: 0,
            },
            {
                world: 'MixedBook',
                uid: 11,
                comment: '前置天气推演',
                content: '@@variables_json_before\n更新天气状态。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 25,
                role: 0,
            },
            {
                world: 'MixedBook',
                uid: 12,
                comment: '后置变量结算',
                content: '@@variables_json\n@@group sync_pack\n更新 alertLevel。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 15,
                role: 0,
            },
            {
                world: 'MixedBook',
                uid: 13,
                comment: '灰港事件板',
                content: '@@replace\n@@group sync_pack\n更新灰港事件板记录。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 30,
                role: 0,
            },
        ];

        const { bridge, transport, orchestrator } = createPipelineFixture({
            lorebooks: { MixedBook: loreEntries },
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '巡视码头' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        // 1. Test orchestrator.runBeforeTurn merges the two @@variables_json_before entries into 1 LLM call
        transport.enqueue(
            (req) => {
                const prompt = String(req.messages[req.messages.length - 1].content);
                expect(prompt).toContain('Grouped Trigger Batch (variables, 2 tasks)');
                expect(prompt).toContain('推进时间段。');
                expect(prompt).toContain('更新天气状态。');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'before_patch',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { period: 'night', weather: 'fog' } }),
                        },
                    ],
                };
            },
            { content: '当前为浓雾深夜' },
        );

        const beforeRes = await orchestrator.runBeforeTurn({
            target: { messageId: 1, swipeId: 0 },
            userText: '巡视码头',
            turnNumber: 1,
        });
        expect(beforeRes.brief).toBe('当前为浓雾深夜');
        expect(beforeRes.results).toHaveLength(1);
        expect(beforeRes.results[0].triggerIds).toHaveLength(2);
        expect(transport.requests).toHaveLength(2);

        // 2. Test full runTurn: 1 before_turn batch + main_turn + 1 cross-type sync_pack batch
        transport.enqueue(
            {
                content: '',
                toolCalls: [
                    {
                        id: 'before_patch_2',
                        name: 'patch_variables',
                        arguments: JSON.stringify({ json_merge: { period: 'night', weather: 'fog' } }),
                    },
                ],
            },
            { content: '浓雾笼罩码头' },
            writeOutputTurn('雾中传来钟声。', 'w_mixed_main'),
            { content: 'main done' },
            (req) => {
                const sys = String(req.messages[0].content);
                const prompt = String(req.messages[req.messages.length - 1].content);
                expect(sys).toContain('Complete EVERY task');
                expect(prompt).toContain('Grouped Trigger Batch (sync_pack, 2 tasks)');
                expect(prompt).toContain('Target: /state/variables.json');
                expect(prompt).toContain('Target: /lorebooks/MixedBook/灰港事件板-13.md');
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'sync_vars',
                            name: 'patch_variables',
                            arguments: JSON.stringify({ json_merge: { alertLevel: 2 } }),
                        },
                        {
                            id: 'sync_lore',
                            name: 'write_file',
                            arguments: JSON.stringify({
                                path: '/lorebooks/MixedBook/灰港事件板-13.md',
                                content: '浓雾夜响起警戒钟声。',
                            }),
                        },
                    ],
                };
            },
            { content: 'sync_pack done' },
        );

        await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '巡视码头',
            turnNumber: 1,
        });
        await orchestrator.barrierCoordinator.awaitAllSettled();

        const target = { messageId: 1, swipeId: 0 };
        const vars = await orchestrator.vfs.readVariables({ target });
        expect(vars).toMatchObject({ period: 'night', weather: 'fog', alertLevel: 2 });
        const loreContent = await orchestrator.vfs.readFile('/lorebooks/MixedBook/灰港事件板-13.md', {
            target,
        });
        expect(loreContent).toContain('浓雾夜响起警戒钟声。');
    });
});
