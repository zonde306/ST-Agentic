import { afterEach, describe, expect, it } from 'vitest';
import { SideGenService } from '@/core/sidegen';
import { ChatDataStore } from '@/core/store';
import { ToolRegistry, createToolExecutionContext } from '@/core/tools';
import { VirtualFileSystem } from '@/core/vfs';
import {
    IframeJsSandbox,
    SandboxLifecycleManager,
    SandboxSecurityError,
    SandboxSideGenError,
} from '@/sandbox';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport } from '../../mocks';

function createDeterministicClock(start = 1_732_320_000_000, step = 1000) {
    let current = start;
    return () => {
        const value = current;
        current += step;
        return value;
    };
}

function createSideGenTestHarness(turns: ConstructorParameters<typeof ScriptedLLMTransport>[0]) {
    const bridge = createOffMainlineTestBridge();
    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({ bridge, store });
    const transport = new ScriptedLLMTransport(turns);
    const sideGen = new SideGenService({
        bridge,
        transport,
        dataStore: store,
        vfs,
        now: createDeterministicClock(),
    });
    return { bridge, store, vfs, transport, sideGen };
}

describe('IframeJsSandbox ctx.sideGen Bridge (Chromium Browser)', () => {
    const lifecycle = new SandboxLifecycleManager();
    const sandbox = new IframeJsSandbox({ lifecycle });

    afterEach(() => {
        sandbox.disposeAll();
    });

    it('wires createToolExecutionContext with optional sideGen and executes createSession + send + autoBridge + clues.read inside iframe sandbox', async () => {
        const { bridge, store, vfs, sideGen } = createSideGenTestHarness([
            {
                content: '收到，东区巡逻九点半换防，我提前二十分钟在旧仓库灯塔下等你。',
                usage: { inputTokens: 120, cachedTokens: 0, outputTokens: 28 },
            },
            {
                content: '门禁卡已备妥，暗号三声雾笛。',
                usage: { inputTokens: 220, cachedTokens: 190, outputTokens: 18 },
            },
        ]);

        // Backward compatibility when sideGen is omitted
        const plainCtx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            target: { messageId: 1, swipeId: 0 },
        });
        expect(plainCtx.sideGen).toBeUndefined();

        const ctx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            sideGen,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });
        expect(ctx.sideGen).toBe(sideGen);

        const result = (await sandbox.evaluateScript(
            `
            const created = await ctx.sideGen.createSession({
                id: 'phone:linwan',
                title: '林晚加密手机通讯',
                scope: 'branch',
                systemPrompt: '你是林晚，通过加密频道简短联络。',
                autoBridge: {
                    path: '/side/comms/linwan.md',
                    delivery: 'radar_hint',
                    keywords: ['老码头', '灯塔', '林晚', '门禁卡'],
                    title: '林晚的加密通讯线索',
                    mode: 'append',
                    summaryPrefix: '加密通讯：',
                },
            });

            const turn1 = await ctx.sideGen.send(
                'phone:linwan',
                '今晚十点老码头见，带上门禁卡。',
            );
            const clueAfterTurn1 = await ctx.sideGen.clues.read('/side/comms/linwan.md');

            const turn2 = await ctx.sideGen.send('phone:linwan', '门禁卡和暗号确认一下。');
            const clueAfterTurn2 = await ctx.sideGen.clues.read('/side/comms/linwan.md');

            const sessionInfo = await ctx.sideGen.getSession('phone:linwan');
            const allSessions = await ctx.sideGen.listSessions({ scope: 'branch' });
            const transcript = await ctx.sideGen.getTranscript('phone:linwan');
            const compacted = await ctx.sideGen.compactSession('phone:linwan');

            // Exercise all remaining clues.* facade methods
            const noteDoc = await ctx.sideGen.clues.write({
                path: '/side/notes/harbor-key.md',
                title: '门禁卡暗记',
                delivery: 'vfs_only',
                keywords: ['门禁卡'],
                summary: '门禁卡背面刻有 07 编号。',
                body: '旧仓库东侧铁门可用 07 号门禁卡开启。',
            });
            const updatedDelivery = await ctx.sideGen.clues.updateDelivery(
                '/side/notes/harbor-key.md',
                'next_turn_brief',
            );
            const updatedStatus = await ctx.sideGen.clues.updateStatus(
                '/side/notes/harbor-key.md',
                'surfaced',
            );
            const exported = await ctx.sideGen.clues.exportToWorldInfo(
                '/side/comms/linwan.md',
                { markResolved: true },
            );
            const clueListBeforeDelete = await ctx.sideGen.clues.list();
            const deletedNote = await ctx.sideGen.clues.delete('/side/notes/harbor-key.md');
            const deletedSession = await ctx.sideGen.deleteSession('phone:linwan');
            const missingAfterDelete = await ctx.sideGen.getSession('phone:linwan');

            return {
                createdId: created.id,
                turn1Text: turn1.text,
                turn1BridgedPath: turn1.bridgedPath,
                turn2Text: turn2.text,
                clue1Body: clueAfterTurn1.body,
                clue1Hash: clueAfterTurn1.contentHash,
                clue2Body: clueAfterTurn2.body,
                clue2Hash: clueAfterTurn2.contentHash,
                sessionTurns: sessionInfo.turns,
                listedSessionIds: allSessions.map((s) => s.id),
                transcriptRoles: transcript.map((m) => m.role),
                compacted,
                notePath: noteDoc.path,
                updatedDelivery: updatedDelivery.meta.delivery,
                updatedStatus: updatedStatus.meta.status,
                exportedBook: exported.bookName,
                exportedCluePath: exported.cluePath,
                cluePathsBeforeDelete: clueListBeforeDelete.map((d) => d.path),
                deletedNote,
                deletedSession,
                missingAfterDelete,
            };
            `,
            ctx,
            { id: 'sidegen_full_flow', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(result.createdId).toBe('phone:linwan');
        expect(result.turn1Text).toBe('收到，东区巡逻九点半换防，我提前二十分钟在旧仓库灯塔下等你。');
        expect(result.turn1BridgedPath).toBe('/side/comms/linwan.md');
        expect(result.turn2Text).toBe('门禁卡已备妥，暗号三声雾笛。');
        expect(String(result.clue1Body)).toContain('今晚十点老码头见，带上门禁卡。');
        expect(String(result.clue1Body)).toContain('东区巡逻九点半换防');
        expect(String(result.clue2Body)).toContain('门禁卡已备妥，暗号三声雾笛。');
        expect(result.clue2Hash).not.toBe(result.clue1Hash);
        expect(result.sessionTurns).toBe(2);
        expect(result.listedSessionIds).toEqual(['phone:linwan']);
        expect(result.transcriptRoles).toEqual(['system', 'user', 'assistant', 'user', 'assistant']);
        expect((result.compacted as { compacted: boolean }).compacted).toBe(true);
        expect(result.notePath).toBe('/side/notes/harbor-key.md');
        expect(result.updatedDelivery).toBe('next_turn_brief');
        expect(result.updatedStatus).toBe('surfaced');
        expect(result.exportedBook).toBe('雾港侦探录');
        expect(result.exportedCluePath).toBe('/side/comms/linwan.md');
        expect(result.cluePathsBeforeDelete).toEqual([
            '/side/comms/linwan.md',
            '/side/notes/harbor-key.md',
        ]);
        expect(result.deletedNote).toBe(true);
        expect(result.deletedSession).toBe(true);
        expect(result.missingAfterDelete).toBeNull();

        // Confirm host-side persistence reflects sandbox calls accurately
        const persistedClue = await sideGen.clues.read('/side/comms/linwan.md');
        expect(persistedClue?.meta.status).toBe('resolved');
        expect(await sideGen.clues.read('/side/notes/harbor-key.md')).toBeNull();
        expect(await sideGen.listSessions()).toEqual([]);
        expect(lifecycle.getStats().activeSandboxes).toBe(0);
    });

    it('supports ctx.sideGen.runOnce in both evaluateScript and defineTool custom tools with network isolation intact', async () => {
        const { bridge, store, vfs, transport, sideGen } = createSideGenTestHarness([
            {
                content: '码头暗哨刚刚交接完毕，雾色渐浓。',
                usage: { inputTokens: 90, cachedTokens: 0, outputTokens: 20 },
            },
            {
                content: '酒馆角落的水手低声提起走私船今晚停靠三号泊位。',
                usage: { inputTokens: 110, cachedTokens: 0, outputTokens: 26 },
            },
        ]);

        const ctx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            sideGen,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        // 1. Direct script calling ctx.sideGen.runOnce (stateless + bridged)
        const scriptRes = (await sandbox.evaluateScript(
            `
            const stateless = await ctx.sideGen.runOnce({
                systemPrompt: '你是雾港暗线观察者。',
                prompt: '简述码头当前动静。',
                mainChatDepth: 2,
                includeVars: true,
            });
            return {
                text: stateless.text,
                sessionId: stateless.sessionId,
                bridgedPath: stateless.bridgedPath,
                usage: stateless.usage,
            };
            `,
            ctx,
            { id: 'sidegen_once_script', allowNetwork: false },
        )) as {
            text: string;
            sessionId?: string;
            bridgedPath?: string;
            usage?: { inputTokens: number; cachedTokens: number; outputTokens: number };
        };

        expect(scriptRes.text).toBe('码头暗哨刚刚交接完毕，雾色渐浓。');
        expect(scriptRes.sessionId).toBeUndefined();
        expect(scriptRes.bridgedPath).toBeUndefined();
        expect(scriptRes.usage).toEqual({ inputTokens: 90, cachedTokens: 0, outputTokens: 20 });
        expect(transport.requests).toHaveLength(1);
        expect(await sideGen.clues.list()).toEqual([]);

        // 2. Compiled defineTool custom tool calling ctx.sideGen.runOnce with bridge
        const tools = await sandbox.compileCustomTools(
            `
            export default defineTool({
                name: 'scout_harbor_rumor',
                description: 'Run an off-mainline rumor scout and bridge to /side/rumors/*',
                parameters: z.object({ topic: z.string() }),
                async execute(args, ctx) {
                    const out = await ctx.sideGen.runOnce({
                        prompt: '推演流言：' + args.topic,
                        bridge: {
                            path: '/side/rumors/berth-three.md',
                            delivery: 'radar_hint',
                            title: '三号泊位传闻',
                            keywords: ['三号泊位', '走私船'],
                        },
                    });
                    const doc = await ctx.sideGen.clues.read('/side/rumors/berth-three.md');
                    return {
                        text: out.text,
                        bridgedPath: out.bridgedPath,
                        clueTitle: doc?.meta.title,
                    };
                },
            });
            `,
            { id: 'sidegen_custom_tool', allowNetwork: false },
        );

        const registry = new ToolRegistry(tools);
        const toolCallRes = await registry.executeToolCall(
            'scout_harbor_rumor',
            { topic: '三号泊位' },
            ctx,
        );
        expect(toolCallRes.ok).toBe(true);
        expect(JSON.parse(toolCallRes.output)).toEqual({
            text: '酒馆角落的水手低声提起走私船今晚停靠三号泊位。',
            bridgedPath: '/side/rumors/berth-three.md',
            clueTitle: '三号泊位传闻',
        });
    });

    it('propagates parent and cross-realm AbortSignal cancellation to in-flight ctx.sideGen.send() and runOnce() and prevents stale writes', async () => {
        let capturedSendSignal: AbortSignal | undefined;
        let capturedOnceSignal: AbortSignal | undefined;

        const { bridge, store, vfs, sideGen } = createSideGenTestHarness([
            (request) => {
                capturedSendSignal = request.signal;
                return {
                    content: '不应被写入的过期回复',
                    delayMs: 250,
                };
            },
            (request) => {
                capturedOnceSignal = request.signal;
                return {
                    content: '不应被写入的过期一次性回复',
                    delayMs: 250,
                };
            },
        ]);

        // Pre-create a branch session with autoBridge to verify zero stale writes on abort
        await sideGen.createSession({
            id: 'phone:linwan',
            title: '林晚中断测试',
            scope: 'branch',
            systemPrompt: '你是林晚。',
            autoBridge: {
                path: '/side/comms/linwan.md',
                delivery: 'radar_hint',
                keywords: ['老码头'],
                title: '林晚中断线索',
                mode: 'append',
            },
        });

        // 1. Parent AbortController aborts an in-flight sandbox ctx.sideGen.send()
        const parentController = new AbortController();
        const abortableCtx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            sideGen,
            target: { messageId: 1, swipeId: 0 },
            signal: parentController.signal,
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const pendingScript = sandbox.evaluateScript(
            `
            return await ctx.sideGen.send('phone:linwan', '这是一条会被中途取消的消息');
            `,
            abortableCtx,
            { id: 'sidegen_abort_send', allowNetwork: false },
        );

        setTimeout(() => parentController.abort(), 30);
        await expect(pendingScript).rejects.toMatchObject({ name: 'AbortError' });

        // Host transport signal must have aborted immediately
        expect(capturedSendSignal?.aborted).toBe(true);

        // Wait longer than the mocked transport delay and confirm ZERO stale writes occurred
        await new Promise((r) => setTimeout(r, 280));
        expect((await sideGen.getSession('phone:linwan'))?.turns).toBe(0);
        expect(await sideGen.getTranscript('phone:linwan')).toEqual([
            { role: 'system', content: '你是林晚。' },
        ]);
        expect(await sideGen.clues.read('/side/comms/linwan.md')).toBeNull();

        // 2. Cross-realm AbortController created INSIDE the iframe aborts ctx.sideGen.runOnce()
        const freshCtx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            sideGen,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const iframeAbortRes = (await sandbox.evaluateScript(
            `
            const localAc = new AbortController();
            setTimeout(() => localAc.abort(), 25);
            try {
                await ctx.sideGen.runOnce({
                    prompt: '跨 Realm 中断测试',
                    bridge: {
                        path: '/side/notes/aborted-once.md',
                        delivery: 'radar_hint',
                    },
                    signal: localAc.signal,
                });
                return { aborted: false };
            } catch (err) {
                return { aborted: true, name: err && err.name };
            }
            `,
            freshCtx,
            { id: 'sidegen_iframe_abort', allowNetwork: false },
        )) as { aborted: boolean; name?: string };

        expect(iframeAbortRes).toEqual({ aborted: true, name: 'AbortError' });
        expect(capturedOnceSignal?.aborted).toBe(true);
        await new Promise((r) => setTimeout(r, 280));
        expect(await sideGen.clues.read('/side/notes/aborted-once.md')).toBeNull();
    });

    it('keeps direct fetch/XHR/WebSocket blocked inside the sandbox and hides host SideGenService internals', async () => {
        const { bridge, store, vfs, sideGen } = createSideGenTestHarness([
            { content: '宿主代理生成成功，沙箱外网仍被屏蔽。' },
        ]);

        const ctx = createToolExecutionContext({
            bridge,
            store,
            vfs,
            sideGen,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const probe = (await sandbox.evaluateScript(
            `
            const probeBlocked = (fn) => {
                try {
                    fn();
                    return { blocked: false };
                } catch (err) {
                    return { blocked: true, name: err && err.name, message: String(err && err.message || err) };
                }
            };

            const fetchProbe = probeBlocked(() => fetch('https://example.com'));
            const xhrProbe = probeBlocked(() => new XMLHttpRequest());
            const wsProbe = probeBlocked(() => new WebSocket('wss://example.com'));
            const beaconProbe = probeBlocked(() => navigator.sendBeacon('https://example.com', 'leak'));

            // SideGen still succeeds via host-side RPC proxy despite allowNetwork: false
            const sideResult = await ctx.sideGen.runOnce({ prompt: '经由宿主执行' });

            // Proxy hardening: frozen, null-prototype, no leaked SideGenService internals
            let mutateBlocked = false;
            try {
                ctx.sideGen.runOnce = () => 'hijacked';
            } catch {
                mutateBlocked = true;
            }

            return {
                fetchProbe,
                xhrProbe,
                wsProbe,
                beaconProbe,
                sideText: sideResult.text,
                sideGenFrozen: Object.isFrozen(ctx.sideGen),
                cluesFrozen: Object.isFrozen(ctx.sideGen.clues),
                mutateBlocked,
                leakedSessionStore: typeof ctx.sideGen.sessionStore !== 'undefined',
                leakedTrajectoryStore: typeof ctx.sideGen.trajectoryStore !== 'undefined',
                leakedAbortAll: typeof ctx.sideGen.abortAll !== 'undefined',
                leakedOnBranchChanged: typeof ctx.sideGen.onBranchChanged !== 'undefined',
                leakedConstructor: typeof ctx.sideGen.constructor !== 'undefined',
                exposedKeys: Object.keys(ctx.sideGen).sort(),
                exposedClueKeys: Object.keys(ctx.sideGen.clues).sort(),
            };
            `,
            ctx,
            { id: 'sidegen_network_isolation', allowNetwork: false },
        )) as Record<string, unknown>;

        expect(probe.fetchProbe).toMatchObject({ blocked: true, name: 'SandboxSecurityError' });
        expect(probe.xhrProbe).toMatchObject({ blocked: true, name: 'SandboxSecurityError' });
        expect(probe.wsProbe).toMatchObject({ blocked: true, name: 'SandboxSecurityError' });
        expect(probe.beaconProbe).toMatchObject({ blocked: true, name: 'SandboxSecurityError' });
        expect(probe.sideText).toBe('宿主代理生成成功，沙箱外网仍被屏蔽。');
        expect(probe.sideGenFrozen).toBe(true);
        expect(probe.cluesFrozen).toBe(true);
        expect(probe.mutateBlocked).toBe(true);
        expect(probe.leakedSessionStore).toBe(false);
        expect(probe.leakedTrajectoryStore).toBe(false);
        expect(probe.leakedAbortAll).toBe(false);
        expect(probe.leakedOnBranchChanged).toBe(false);
        expect(probe.leakedConstructor).toBe(false);
        expect(probe.exposedKeys).toEqual([
            'clues',
            'compactSession',
            'createSession',
            'deleteSession',
            'getSession',
            'getTranscript',
            'listSessions',
            'runOnce',
            'send',
        ]);
        expect(probe.exposedClueKeys).toEqual([
            'delete',
            'exportToWorldInfo',
            'list',
            'read',
            'updateDelivery',
            'updateStatus',
            'write',
        ]);

        // Direct unguarded fetch call in script rejects with SandboxSecurityError
        await expect(
            sandbox.evaluateScript(
                'return await fetch("https://example.com");',
                ctx,
                { id: 'sidegen_direct_fetch_reject', allowNetwork: false },
            ),
        ).rejects.toThrow(SandboxSecurityError);
    });

    it('returns clear structured SandboxSideGenError when ctx.sideGen is not configured', async () => {
        const bridge = createOffMainlineTestBridge();
        const unconfiguredCtx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });
        expect(unconfiguredCtx.sideGen).toBeUndefined();

        await expect(
            sandbox.evaluateScript(
                `return await ctx.sideGen.runOnce({ prompt: 'test' });`,
                unconfiguredCtx,
                { id: 'sidegen_unconfigured_once', allowNetwork: false },
            ),
        ).rejects.toSatisfy((err: unknown) => {
            return (
                err instanceof SandboxSideGenError
                && err.code === 'SIDEGEN_UNAVAILABLE'
                && err.method === 'sideGen.runOnce'
                && /not configured/i.test(err.message)
            );
        });

        await expect(
            sandbox.evaluateScript(
                `return await ctx.sideGen.clues.read('/side/comms/linwan.md');`,
                unconfiguredCtx,
                { id: 'sidegen_unconfigured_clue', allowNetwork: false },
            ),
        ).rejects.toSatisfy((err: unknown) => {
            return (
                err instanceof SandboxSideGenError
                && err.code === 'SIDEGEN_UNAVAILABLE'
                && err.method === 'sideGen.clues.read'
                && /not configured/i.test(err.message)
            );
        });
    });
});
