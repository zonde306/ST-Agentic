import { afterEach, describe, expect, it } from 'vitest';
import {
    ToolRegistry,
    createToolExecutionContext,
} from '@/core/tools';
import { IframeJsSandbox, SandboxLifecycleManager, SandboxSecurityError } from '@/sandbox';
import { MemoryHostBridge } from '../../mocks';

function createBrowserBridge() {
    const bridge = new MemoryHostBridge({
        identity: { userName: '沈默', charName: '林晚' },
        slashHandler: async (cmd) => `SLASH:${cmd}`,
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: '检查浏览器沙箱' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: '准备执行' });
    return bridge;
}

describe('IframeJsSandbox & SandboxLifecycleManager (Chromium Browser)', () => {
    const lifecycle = new SandboxLifecycleManager();
    const sandbox = new IframeJsSandbox({ lifecycle });

    afterEach(() => {
        sandbox.disposeAll();
        delete (window as unknown as Record<string, unknown>).__hostTestSecret;
        delete (window as unknown as Record<string, unknown>).__sandboxPolluted;
    });

    it('isolates @@zod_schema in network-disabled iframe mode, blocks fetch/XHR/WS/EventSource/sendBeacon/parent/top, and removes temp iframe', async () => {
        const schema = await sandbox.evaluateSchema(`
            const allowedMoods = _.uniq(['calm', 'tense', 'calm']);
            export default z.object({
                hp: z.number().int().min(0).max(100),
                mood: z.enum(allowedMoods),
            });
        `);
        expect(schema.safeParse({ hp: 80, mood: 'calm' }).success).toBe(true);
        expect(schema.safeParse({ hp: 120, mood: 'angry' }).success).toBe(false);

        const blockedProbes = [
            'fetch("https://example.com")',
            'new XMLHttpRequest()',
            'new WebSocket("wss://example.com")',
            'new EventSource("https://example.com/sse")',
            'navigator.sendBeacon("https://example.com", "leak")',
            'parent',
            'top',
            'window.parent',
            'window.top',
            'globalThis.top',
            'document',
            'Function("return top")()',
        ];

        for (const probe of blockedProbes) {
            await expect(sandbox.evaluateSchema(probe)).rejects.toThrow(SandboxSecurityError);
        }

        // All temporary schema iframes must be cleaned up immediately after evaluateSchema resolves/rejects
        expect(lifecycle.getStats().activeSandboxes).toBe(0);
        expect(document.querySelectorAll('iframe[data-agentic-sandbox-id]')).toHaveLength(0);
    });

    it('runs defineTool (single & array) and @@script inside sandboxed iframe with ctx/z/_/AbortSignal and host isolation', async () => {
        (window as unknown as Record<string, unknown>).__hostTestSecret = 'top-secret-token';
        const bridge = createBrowserBridge();

        const tools = await sandbox.compileCustomTools(
            `
            export default [
                defineTool({
                    name: 'browser_state_tool',
                    description: 'Read/write vars, attach media, and check isolation',
                    parameters: z.object({
                        hp: z.number().min(0),
                        note: z.string(),
                    }),
                    async execute(args, ctx) {
                        await ctx.vars.set('hp', _.clamp(args.hp, 0, 100));
                        await ctx.fs.write('/memory/browser.md', args.note);
                        await ctx.message.attachMedia({ type: 'image', url: 'https://local.test/img.png' });
                        const slashOut = await ctx.st.slash('/echo ok');

                        // Host globals & Object.prototype are isolated in the iframe realm
                        let parentBlocked = false;
                        try { void parent; } catch { parentBlocked = true; }
                        let topBlocked = false;
                        try { void window.top; } catch { topBlocked = true; }
                        Object.prototype.__sandboxTestMarker = 'isolated';

                        return {
                            target: ctx.target,
                            hostSecretVisible: typeof window.__hostTestSecret !== 'undefined',
                            parentBlocked,
                            topBlocked,
                            slashOut,
                            hasFetch: typeof fetch === 'function',
                            dataFetchText: await (await fetch('data:text/plain,sandbox-fetch-ok')).text(),
                        };
                    },
                }),
                defineTool({
                    name: 'cancellable_wait_tool',
                    description: 'Async tool honoring AbortSignal',
                    parameters: z.object({ delayMs: z.number().min(10) }),
                    execute(args, ctx) {
                        return new Promise((resolve, reject) => {
                            if (ctx.signal.aborted) {
                                const err = new Error('aborted');
                                err.name = 'AbortError';
                                reject(err);
                                return;
                            }
                            const timer = setTimeout(() => resolve('completed'), args.delayMs);
                            ctx.signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                const err = new Error('aborted during wait');
                                err.name = 'AbortError';
                                reject(err);
                            }, { once: true });
                        });
                    },
                }),
            ];
            `,
            { id: 'browser_pack', allowNetwork: true },
        );

        const iframeNodes = document.querySelectorAll('iframe[data-agentic-sandbox-id="browser_pack"]');
        expect(iframeNodes).toHaveLength(1);
        expect(iframeNodes[0].getAttribute('sandbox')).toContain('allow-scripts');

        const registry = new ToolRegistry(tools);
        const controller = new AbortController();
        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            signal: controller.signal,
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const res = await registry.executeToolCall(
            'browser_state_tool',
            { hp: 140, note: '浏览器沙箱写入测试' },
            ctx,
        );
        expect(res.ok).toBe(true);
        const payload = JSON.parse(res.output) as {
            target: { messageId: number; swipeId: number };
            hostSecretVisible: boolean;
            parentBlocked: boolean;
            topBlocked: boolean;
            slashOut: string;
            hasFetch: boolean;
            dataFetchText: string;
        };
        expect(payload).toEqual({
            target: { messageId: 1, swipeId: 0 },
            hostSecretVisible: false,
            parentBlocked: true,
            topBlocked: true,
            slashOut: 'SLASH:/echo ok',
            hasFetch: true,
            dataFetchText: 'sandbox-fetch-ok',
        });
        // Host Object.prototype must remain completely untouched
        expect(({} as Record<string, unknown>).__sandboxTestMarker).toBeUndefined();
        expect(await ctx.vars.get('hp')).toBe(100);
        expect(bridge.mediaAttachments).toHaveLength(1);

        // Controlled mode with allowNetwork: false blocks fetch
        const offlineTools = await sandbox.compileCustomTools(
            `export default defineTool({
                name: 'offline_tool',
                description: 'Blocks fetch',
                parameters: z.object({}),
                async execute() { return await fetch('https://example.com'); }
            });`,
            { id: 'offline_tool', allowNetwork: false },
        );
        const offlineReg = new ToolRegistry(offlineTools);
        const offlineRes = await offlineReg.executeToolCall('offline_tool', {}, ctx);
        expect(offlineRes.ok).toBe(false);
        expect(offlineRes.error).toMatch(/fetch/i);

        // AbortSignal cancels in-flight async tool immediately
        const pendingCall = registry.executeToolCall('cancellable_wait_tool', { delayMs: 5000 }, ctx);
        setTimeout(() => controller.abort(), 30);
        await expect(pendingCall).rejects.toMatchObject({ name: 'AbortError' });

        // @@script execution in browser iframe
        const scriptCtx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });
        const scriptVal = await sandbox.evaluateScript(
            `
            const current = await ctx.vars.get('hp');
            await ctx.vars.set('hp', current - 15);
            return await ctx.vars.get('hp');
            `,
            scriptCtx,
        );
        expect(scriptVal).toBe(85);
    });

    it('tracks timers and listeners in SandboxLifecycleManager, cleans up on hot-reload, and clears all on disposeAll()', async () => {
        const bridge = createBrowserBridge();
        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        // Register a sandboxed tool that spawns intervals, timeouts, and window event listeners
        const [toolV1] = await sandbox.compileCustomTools(
            `
            export default defineTool({
                name: 'leaky_worker',
                description: 'Creates interval, timeout, and listener inside iframe',
                parameters: z.object({}),
                execute(_args, ctx) {
                    const notify = () => { void ctx; };
                    setInterval(() => {
                        ctx.st.emit('tick');
                    }, 20);
                    setTimeout(() => {
                        ctx.st.emit('delayed');
                    }, 80);
                    window.addEventListener('custom-ping', notify);
                    window.dispatchEvent(new Event('custom-ping'));
                    return 'started';
                },
            });
            `,
            { id: 'hot_reload_tool', allowNetwork: false },
        );

        const reg = new ToolRegistry([toolV1]);
        await reg.executeToolCall('leaky_worker', {}, ctx);

        const statsBeforeDispose = lifecycle.getStats('hot_reload_tool');
        expect(statsBeforeDispose.activeSandboxes).toBe(1);
        expect(statsBeforeDispose.intervals).toBe(1);
        expect(statsBeforeDispose.timeouts).toBe(1);
        expect(statsBeforeDispose.listeners).toBe(1);
        expect(statsBeforeDispose.iframes).toBe(1);
        expect(document.querySelectorAll('iframe[data-agentic-sandbox-id="hot_reload_tool"]')).toHaveLength(1);

        // Hot-reloading the same ID must dispose the old iframe and all its timers/listeners first
        await sandbox.compileCustomTools(
            `export default defineTool({
                name: 'leaky_worker',
                description: 'v2',
                parameters: z.object({}),
                execute() { return 'v2'; }
            });`,
            { id: 'hot_reload_tool', allowNetwork: false },
        );
        expect(document.querySelectorAll('iframe[data-agentic-sandbox-id="hot_reload_tool"]')).toHaveLength(1);
        const eventsAtReload = bridge.emittedEvents.length;

        // Also run a keepAlive script with an active interval and listener to verify disposeAll()
        await sandbox.evaluateScript(
            `
            setInterval(() => { ctx.st.emit('bg_tick'); }, 15);
            setTimeout(() => { ctx.st.emit('bg_timeout'); }, 120);
            window.addEventListener('bg-evt', () => { ctx.st.emit('bg_evt'); });
            `,
            ctx,
            { id: 'bg_script', keepAlive: true },
        );

        await new Promise((r) => setTimeout(r, 45));
        const preDisposeEvents = bridge.emittedEvents.length;
        expect(preDisposeEvents).toBeGreaterThan(eventsAtReload);

        // disposeAll() clears every interval/timeout/listener and removes every iframe from DOM
        const disposedCount = lifecycle.disposeAll();
        expect(disposedCount).toBe(2);
        expect(lifecycle.getStats()).toEqual({
            activeSandboxes: 0,
            timeouts: 0,
            intervals: 0,
            listeners: 0,
            iframes: 0,
        });
        expect(document.querySelectorAll('iframe[data-agentic-sandbox-id]')).toHaveLength(0);

        // Wait longer than interval/timeout periods and verify ZERO additional events fire
        const postDisposeSnapshot = bridge.emittedEvents.length;
        await new Promise((r) => setTimeout(r, 150));
        expect(bridge.emittedEvents.length).toBe(postDisposeSnapshot);
    });
});
