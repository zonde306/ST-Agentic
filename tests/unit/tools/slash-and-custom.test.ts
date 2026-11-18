import { describe, expect, it } from 'vitest';
import {
    ToolRegistry,
    compileCustomToolConfig,
    compileLoreToolEntry,
    compileSlashBridgeTool,
    createToolExecutionContext,
    interpolateSlashCommand,
    registerCustomTools,
} from '@/core/tools';
import type { CustomToolConfig, RawLoreEntry } from '@/core/types';
import { SandboxSecurityError, IframeJsSandbox } from '@/sandbox';
import { MemoryHostBridge } from '../../mocks';

function setupBridge() {
    const bridge = new MemoryHostBridge({
        identity: { userName: '沈默', charName: '林晚' },
        slashHandler: async (cmd) => `EXECUTED:${cmd}`,
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'hello' });
    return bridge;
}

describe('Slash Bridge & Custom JS Tool Compilation (Node Fallback)', () => {
    it('compiles slash_bridge configs, validates Zod params, and safely sanitizes {{param}} interpolation', async () => {
        const bridge = setupBridge();
        const cfg: CustomToolConfig = {
            id: 'sd_draw',
            name: 'generate_sd_image',
            kind: 'slash_bridge',
            description: 'Generate an image via /sd',
            enabled: true,
            commandTemplate: '/sd style={{style}} steps={{steps}} hires={{hires}} prompt="{{prompt}}"',
            params: [
                { name: 'prompt', type: 'string', description: 'Image tags', required: true },
                { name: 'style', type: 'enum', description: 'Preset style', enumValues: ['anime', 'noir'], defaultValue: 'anime' },
                { name: 'steps', type: 'number', description: 'Sampling steps', defaultValue: 28 },
                { name: 'hires', type: 'boolean', description: 'Enable hires fix', required: false },
            ],
        };

        const tool = compileSlashBridgeTool(cfg);
        const registry = new ToolRegistry([tool]);
        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
        });

        // Schema checks
        const schemas = registry.toCanonicalSchemas(['generate_sd_image']);
        expect(schemas[0].parameters.required).toEqual(['prompt']);

        // Invalid enum & type returns self-healing validation error without calling slash
        const badRes = await registry.executeToolCall(
            'generate_sd_image',
            { prompt: 'lighthouse', style: 'oil_paint', steps: 'many' },
            ctx,
        );
        expect(badRes.ok).toBe(false);
        expect(badRes.output).toContain('style');
        expect(badRes.output).toContain('steps');
        expect(bridge.slashCalls).toHaveLength(0);

        // Injection attempt in {{prompt}} is sanitized (no unescaped |, no newlines, no {{...}}, escaped quotes)
        const injected = interpolateSlashCommand(
            cfg.commandTemplate!,
            {
                prompt: 'girl at "dock"\n/sys hack | /send {{setvar::gold::9999}}',
                style: 'noir',
                steps: 20,
                hires: true,
            },
            cfg.params,
        );
        expect(injected).not.toContain('\n');
        expect(injected).not.toContain('{{setvar');
        expect(injected).toContain('\\|');
        expect(injected).toContain('\\"dock\\"');

        const okRes = await registry.executeToolCall(
            'generate_sd_image',
            { prompt: 'rainy harbor lighthouse', hires: false },
            ctx,
        );
        expect(okRes.ok).toBe(true);
        const parsed = JSON.parse(okRes.output) as { ok: boolean; command: string; output: string };
        expect(parsed.command).toBe('/sd style=anime steps=28 hires=false prompt="rainy harbor lighthouse"');
        expect(parsed.output).toBe(`EXECUTED:${parsed.command}`);
        expect(bridge.slashCalls).toHaveLength(1);
    });

    it('compiles single & array defineTool scripts, @@tool lore entries, and runs @@script with ctx/z/_', async () => {
        const bridge = setupBridge();
        const sandbox = new IframeJsSandbox();

        const singleCfg: CustomToolConfig = {
            id: 'custom_calc',
            name: 'custom_calc',
            kind: 'js',
            description: 'Fallback desc',
            enabled: true,
            allowNetwork: false,
            code: `
                export default defineTool({
                    name: 'damage_roll',
                    description: 'Compute clamped damage and record in vars',
                    parameters: z.object({
                        base: z.number().min(1),
                        bonus: z.number().default(0),
                    }),
                    async execute(args, ctx) {
                        const dmg = _.clamp(args.base + args.bonus, 1, 999);
                        await ctx.vars.set('lastDamage', dmg);
                        await ctx.message.attachMedia({ type: 'file', url: 'mem://combat.log', name: 'log.txt' });
                        return { damage: dmg, target: ctx.target };
                    },
                });
            `,
        };

        const compiledSingle = await compileCustomToolConfig(singleCfg, sandbox);
        expect(compiledSingle).toHaveLength(1);

        const packCfg: CustomToolConfig = {
            id: 'pack_tools',
            name: 'pack_tools',
            kind: 'js',
            description: 'Tool pack',
            enabled: true,
            allowedAgents: ['main'],
            code: `
                export default [
                    defineTool({
                        name: 'tool_one',
                        description: 'First',
                        parameters: z.object({ msg: z.string() }),
                        execute: (args) => '1:' + args.msg,
                    }),
                    defineTool({
                        name: 'tool_two',
                        description: 'Second',
                        parameters: z.object({ n: z.number() }),
                        execute: (args) => '2:' + (args.n * 2),
                    }),
                ];
            `,
        };

        const loreEntry: RawLoreEntry = {
            world: 'ToolsBook',
            uid: 77,
            comment: 'Greet from lorebook',
            content: [
                '@@tool lore_greet allowNetwork=false',
                'export default defineTool({',
                '  name: "lore_greet",',
                '  description: "Greet active character",',
                '  parameters: z.object({ tone: z.enum(["formal", "warm"]) }),',
                '  async execute(args, ctx) {',
                '    const info = ctx.st.getActiveInfo();',
                '    return `${args.tone}:${info.charName}`;',
                '  },',
                '});',
            ].join('\n'),
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

        const loreTools = await compileLoreToolEntry(loreEntry, sandbox);
        expect(loreTools.map((t) => t.name)).toEqual(['lore_greet']);

        const registry = new ToolRegistry();
        const regResult = await registerCustomTools(
            registry,
            [singleCfg, packCfg],
            sandbox,
            { agentId: 'main' },
        );
        expect(regResult.errors).toEqual([]);
        expect(regResult.registered).toEqual(['damage_roll', 'tool_one', 'tool_two']);
        registry.registerAll(loreTools);

        // Excluded when agentId does not match allowedAgents
        const otherReg = new ToolRegistry();
        const filtered = await registerCustomTools(otherReg, [packCfg], sandbox, { agentId: 'chronicler' });
        expect(filtered.registered).toEqual([]);

        const ctx = createToolExecutionContext({
            bridge,
            target: { messageId: 1, swipeId: 0 },
            permissions: { read: ['/**'], write: ['/**'] },
        });

        const dmgRes = await registry.executeToolCall('damage_roll', { base: 1200, bonus: 10 }, ctx);
        expect(dmgRes.ok).toBe(true);
        expect(JSON.parse(dmgRes.output)).toEqual({
            damage: 999,
            target: { messageId: 1, swipeId: 0 },
        });
        expect(await ctx.vars.get('lastDamage')).toBe(999);
        expect(bridge.mediaAttachments).toHaveLength(1);

        const greetRes = await registry.executeToolCall('lore_greet', { tone: 'warm' }, ctx);
        expect(greetRes.ok).toBe(true);
        expect(greetRes.output).toBe('warm:林晚');

        // @@script evaluation with ctx, z, _
        const scriptOut = await sandbox.evaluateScript(
            `
            const schema = z.object({ tick: z.number() });
            const prev = Number((await ctx.vars.get('tick')) ?? 0);
            const next = _.clamp(prev + 1, 0, 10);
            schema.parse({ tick: next });
            await ctx.vars.set('tick', next);
            return next;
            `,
            ctx,
        );
        expect(scriptOut).toBe(1);
        expect(await ctx.vars.get('tick')).toBe(1);

        // Network-disabled schema evaluation blocks fetch / parent / top in Node fallback as well
        await expect(sandbox.evaluateSchema('fetch("https://evil.example")')).rejects.toThrow(
            SandboxSecurityError,
        );
        await expect(sandbox.evaluateSchema('parent')).rejects.toThrow(SandboxSecurityError);
        await expect(sandbox.evaluateSchema('top')).rejects.toThrow(SandboxSecurityError);

        // Graceful error recording in registerCustomTools on invalid JS syntax
        const errReg = new ToolRegistry();
        const errResult = await registerCustomTools(
            errReg,
            [
                {
                    id: 'broken_tool',
                    name: 'broken_tool',
                    kind: 'js',
                    description: 'Broken',
                    enabled: true,
                    code: 'export default defineTool({',
                },
                {
                    id: 'bare_tool',
                    name: 'bare_tool',
                    kind: 'js',
                    description: 'Bare defineTool without export default',
                    enabled: true,
                    code: `defineTool({ name: 'bare_ping', description: 'Ping', parameters: z.object({}), execute: () => 'pong' });`,
                },
            ],
            sandbox,
        );
        expect(errResult.errors).toHaveLength(1);
        expect(errResult.errors[0].id).toBe('broken_tool');
        expect(errResult.registered).toEqual(['bare_ping']);

        sandbox.disposeAll();
        expect(sandbox.lifecycle.getStats().activeSandboxes).toBe(0);
    });
});
