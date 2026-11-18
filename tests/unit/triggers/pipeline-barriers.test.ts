import { describe, expect, it } from 'vitest';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { TraceLogger } from '@/core/logger';
import { PipelineOrchestrator } from '@/core/triggers';
import type { RawLoreEntry, Settings, TriggerRule } from '@/core/types';
import { IframeJsSandbox } from '@/sandbox';
import { DeferredGate, MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

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
                return { content: 'Turn 1 Reply' };
            },
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
                return { content: 'Turn 2 Reply' };
            },
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
            { content: 'Main Turn 1' },
            async () => {
                selfOrder.push('self_t1_start');
                await t1SelfGate.wait();
                selfOrder.push('self_t1_finish');
                return { content: 'Outline T1 done' };
            },
            { content: 'Main Turn 2' },
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
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '灯塔在雨雾中闪烁。', swipeId: 0 });

        transport.enqueue(
            { content: '灯塔在雨雾中闪烁。' },
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
            bridge.pushMessage({ id: aId, name: '林晚', isUser: false, mes: `第${turn}轮回复`, swipeId: 0 });
            transport.enqueue({ content: `第${turn}轮回复` });

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

        // Attachment & display view override MUST anchor strictly to { messageId: 1, swipeId: 0 }!
        expect(bridge.mediaAttachments).toHaveLength(1);
        expect(bridge.mediaAttachments[0].target).toEqual({ messageId: 1, swipeId: 0 });
        expect(bridge.mediaAttachments[0].media.url).toBe('/img/lighthouse-1-0.png');

        const viewOverride1 = orchestrator.store.get('message', '', {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(viewOverride1?.content).toContain('[插图已回填至1#0]');

        // Later turns (e.g. messageId 7) remain completely untouched!
        expect(orchestrator.store.get('message', '', { target: { messageId: 7, swipeId: 0 } })).toBeNull();
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
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: 'A1#0', swipeId: 0 });
        transport.enqueue(
            { content: 'Brief 1' },
            { content: 'Reply 1#0' },
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
            mes: 'A3#0',
            swipeId: 0,
            swipes: ['A3#0', ''],
            swipeInfo: [{}, {}],
        });
        transport.enqueue(
            { content: 'Brief 3#0' },
            { content: 'Reply 3#0' },
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
                const allTexts = req.messages.map((m) => String(m.content)).join('\n');
                expect(allTexts).toContain('Reply 1#0');
                expect(allTexts).not.toContain('Reply 3#0');
                return { content: 'Reply 3#1' };
            },
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

        // Action: CONTINUE on 3#1 -> MUST skip before_turn and append to 3#1 trajectory!
        bridge.chat[3].mes = 'Reply 3#1';
        bridge.chat[3].swipes = ['A3#0', 'Reply 3#1'];
        transport.enqueue(
            (req) => {
                const allTexts = req.messages.map((m) => String(m.content)).join('\n');
                const lastMsgText = String(req.messages[req.messages.length - 1].content);
                expect(allTexts).toContain('Reply 3#1');
                // Continue skips before_turn: no new <turn-brief> in Layer 2 continuation message
                expect(lastMsgText).not.toContain('<turn-brief>');
                expect(lastMsgText).toContain('Continue seamlessly');
                return { content: ' ...continued!' };
            },
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
        await orchestrator.barrierCoordinator.awaitAllSettled();

        // Action: REGENERATE from message 3 -> clears layers & checkpoints >= 3 and re-runs full turn
        orchestrator.store.set('files', 'memory/after-3.md', 'test', 'to-be-pruned', {
            messageId: 3,
            swipeId: 1,
        });
        transport.enqueue(
            { content: 'Brief 3 regen' },
            (req) => {
                const allTexts = req.messages.map((m) => String(m.content)).join('\n');
                expect(allTexts).toContain('Reply 1#0');
                expect(allTexts).not.toContain('Reply 3#1');
                expect(allTexts).not.toContain('...continued!');
                return { content: 'Regenerated 3#1' };
            },
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
                return { content: '我看到银莲花刻痕。'.repeat(15) };
            },
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
        bridge.chat[1].mes = t1.content;
        bridge.chat[1].swipes = [t1.content];

        await orchestrator.barrierCoordinator.awaitAllSettled();

        expect(ejsCalls).toHaveLength(1);
        expect(t1.beforeTurnBrief).toBe('ScriptBrief: ready');
        // 1 main_turn call + 1 merged @@group call (scripts consumed 0 LLM tokens!)
        expect(transport.requests).toHaveLength(2);

        const varsT1 = await orchestrator.vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(varsT1.scriptRan).toBe(true);
        expect(varsT1.regexHit).toBe(true);
        expect(varsT1.predicateHit).toBe(true);
        expect(varsT1.intervalHit).toBeUndefined();

        // Turn 2: interval=2 fires AND high watermark triggers maintenance compaction!
        bridge.pushMessage({ id: 2, name: '沈默', isUser: true, mes: '第二回合' });
        bridge.pushMessage({ id: 3, name: '林晚', isUser: false, mes: '', swipeId: 0 });
        transport.enqueue(
            { content: '第二回合足够长的回复内容。'.repeat(20) },
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
            { content: '主角被流矢擦伤。' },
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
});
