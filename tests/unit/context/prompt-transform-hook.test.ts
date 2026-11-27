import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunner } from '@/core/agents';
import { AssistantRunner } from '@/core/assistant';
import {
    PROMPT_TRANSFORM_EVENTS,
    type PromptTransformListener,
    type PromptTransformPayload,
    runPromptTransform,
} from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import { ContextAssembler, TrajectoryStore } from '@/core/context';
import { LoreReadEvaluator, TailRadar } from '@/core/lore';
import { SideGenService } from '@/core/sidegen';
import { ChatDataStore } from '@/core/store';
import { createBuiltinToolRegistry, createToolExecutionContext } from '@/core/tools';
import type { RawLoreEntry } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { registerBuiltinEjsPromptTransformHook } from '@/host/ejs-adapter';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { MemoryHostBridge, ScriptedLLMTransport, assertAppendOnlyPrefix } from '../../mocks';

describe('Prompt Transform Hook Mechanism', () => {
    const globalHolder = globalThis as { EjsTemplate?: unknown };
    const originalEjsTemplate = globalHolder.EjsTemplate;

    afterEach(() => {
        if (originalEjsTemplate === undefined) {
            delete globalHolder.EjsTemplate;
        } else {
            globalHolder.EjsTemplate = originalEjsTemplate;
        }
    });

    it('runs listeners sequentially, prevents double-eval via handledSyntaxes, enforces monotonic cache.disable(), and guards non-string text corruption', async () => {
        const bridge = new MemoryHostBridge({
            ejsEvaluator: async (text) => `${text}[builtin-ejs]`,
        });

        const order: string[] = [];
        bridge.onPromptTransform((payload) => {
            order.push('ext1');
            payload.cache.disable('dynamic variable branch', 'ext1');
            payload.cache.addKey('ext1', 'v=1');
            if (payload.text.includes('<%')) {
                payload.text = payload.text.replace(/<%=\s*x\s*%>/g, 'EXT_X');
                payload.handledSyntaxes.add('ejs');
            }
        });
        bridge.onPromptTransform((payload) => {
            order.push('ext2');
            // Attempting to write non-string should be safely ignored on finalize
            if (payload.rawText === 'CORRUPT_ME') {
                (payload as unknown as { text: unknown }).text = 12345;
            }
        });

        const res1 = await runPromptTransform(bridge, {
            text: 'Value=<%= x %>',
            source: 'prompt_block',
            layer: 'layer0_prefix',
            meta: { sessionId: 's1' },
        });
        expect(order).toEqual(['ext1', 'ext2']);
        expect(res1.text).toBe('Value=EXT_X');
        expect(res1.cacheable).toBe(false);
        expect(res1.cacheKeys).toEqual({ ext1: 'v=1' });
        expect(res1.cacheDisableReasons).toEqual(['ext1: dynamic variable branch']);
        expect(res1.handledSyntaxes.has('ejs')).toBe(true);

        const res2 = await runPromptTransform(bridge, {
            text: 'CORRUPT_ME',
            source: 'prompt_block',
            layer: 'layer2_tail',
            meta: { sessionId: 's1' },
        });
        expect(res2.text).toBe('CORRUPT_ME');
        expect(res2.changed).toBe(false);
    });

    it('supports onError fallback, callback, and throw policies', async () => {
        const bridge = new MemoryHostBridge();
        bridge.onPromptTransform(() => {
            throw new Error('hook boom');
        });

        const fallbackRes = await runPromptTransform(bridge, {
            text: 'hello',
            source: 'prompt_block',
            layer: 'layer2_tail',
            meta: { sessionId: 's1' },
            onError: 'fallback',
        });
        expect(fallbackRes.text).toBe('hello');
        expect(fallbackRes.errors).toHaveLength(1);
        expect(fallbackRes.errors[0].error.message).toBe('hook boom');

        const observed: string[] = [];
        await runPromptTransform(bridge, {
            text: 'hello',
            source: 'prompt_block',
            layer: 'layer2_tail',
            meta: { sessionId: 's1' },
            onError: (err) => observed.push(err.message),
        });
        expect(observed).toEqual(['hook boom']);

        await expect(
            runPromptTransform(bridge, {
                text: 'hello',
                source: 'prompt_block',
                layer: 'layer2_tail',
                meta: { sessionId: 's1' },
                onError: 'throw',
            }),
        ).rejects.toThrow('hook boom');
    });

    it('selectively re-evaluates ONLY non-cacheable Layer 0 prefix blocks & system rules across turns while preserving frozenPrefix on unchanged branches', async () => {
        const bridge = new MemoryHostBridge({
            characterFields: {
                description: '足够长的角色描述文本，避免触发空壳卡判定，用于验证 Layer 0 选择性重算。'.repeat(2),
            },
        });

        const seenCalls: Array<{ source: string; blockId?: string; comment?: string }> = [];
        bridge.onPromptTransform((payload) => {
            seenCalls.push({
                source: payload.source,
                blockId: payload.meta.blockId,
                comment: payload.meta.lore?.comment,
            });
            if (payload.text.includes('<<STATIC_RULE>>')) {
                payload.text = payload.text.replace('<<STATIC_RULE>>', 'STATIC_RULE_OK');
                return;
            }
            if (payload.text.includes('<<DYN_RULE>>')) {
                payload.cache.disable('conditional rule', 'custom-syntax');
                const mode = Number(payload.meta.vars?.hp ?? 100) < 50 ? 'LOW_HP' : 'HEALTHY';
                payload.text = payload.text.replace('<<DYN_RULE>>', `RULE_${mode}`);
                return;
            }
            if (payload.text.includes('<<STATIC_PREFIX>>')) {
                payload.text = payload.text.replace('<<STATIC_PREFIX>>', 'STATIC_PREFIX_OK');
                return;
            }
            if (payload.text.includes('<<DYN_PREFIX>>')) {
                payload.cache.disable('conditional prefix', 'custom-syntax');
                const mode = Number(payload.meta.vars?.hp ?? 100) < 50 ? 'COMBAT_ALERT' : 'CALM_STATE';
                payload.text = payload.text.replace('<<DYN_PREFIX>>', `PREFIX_${mode}`);
            }
        });

        const loreEntries: RawLoreEntry[] = [
            {
                world: 'W',
                uid: 1,
                comment: 'StaticRule',
                content: '@@system\n<<STATIC_RULE>>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 20,
                role: 0,
            },
            {
                world: 'W',
                uid: 2,
                comment: 'DynamicRule',
                content: '@@system\n<<DYN_RULE>>',
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
        ];

        const agent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'static_prefix',
                    name: 'Static Prefix',
                    role: 'system',
                    placement: 'prefix',
                    content: '<<STATIC_PREFIX>>',
                    enabled: true,
                },
                {
                    id: 'dyn_prefix',
                    name: 'Dynamic Prefix',
                    role: 'system',
                    placement: 'prefix',
                    content: '<<DYN_PREFIX>>',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const store = new TrajectoryStore();

        const lifecycleEvents: string[] = [];
        bridge.onPromptTransformTurnStart((p) => {
            lifecycleEvents.push(`start:${p.sessionId}`);
        });
        bridge.onPromptTransformTurnEnd((p) => {
            lifecycleEvents.push(`end:${p.sessionId}`);
        });

        // Turn 1: full compile
        const turn1 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            loreEntries,
            transformSessionId: 't1',
            userInput: 'Turn 1',
            vars: { hp: 100 },
        });
        expect(lifecycleEvents).toEqual(['start:t1', 'end:t1']);
        expect(turn1.layer0Messages.map((m) => m.content)).toEqual([
            'System Base',
            '<system-rules>\n### StaticRule\nSTATIC_RULE_OK\n\n### DynamicRule\nRULE_HEALTHY\n</system-rules>',
            expect.stringContaining('<core-manifest>'),
            'STATIC_PREFIX_OK',
            'PREFIX_CALM_STATE',
        ]);

        // Turn 2: hp=80 -> conditional branch stays identical; static items are NOT re-evaluated!
        seenCalls.length = 0;
        const turn2 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            loreEntries,
            transformSessionId: 't2',
            userInput: 'Turn 2',
            vars: { hp: 80 },
        });
        expect(seenCalls.some((c) => c.blockId === 'static_prefix' || c.blockId === 'system_base')).toBe(false);
        expect(seenCalls.some((c) => c.comment === 'StaticRule')).toBe(false);
        expect(seenCalls.some((c) => c.blockId === 'dyn_prefix')).toBe(true);
        expect(seenCalls.some((c) => c.comment === 'DynamicRule')).toBe(true);
        expect(turn2.layer0Messages).toEqual(turn1.layer0Messages);

        // Turn 3: hp=20 -> conditional branch flips; ONLY dynamic items re-run, static items stay cached and untouched!
        seenCalls.length = 0;
        const turn3 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            loreEntries,
            transformSessionId: 't3',
            userInput: 'Turn 3',
            vars: { hp: 20 },
        });
        expect(seenCalls.some((c) => c.blockId === 'static_prefix' || c.blockId === 'system_base')).toBe(false);
        expect(seenCalls.some((c) => c.comment === 'StaticRule')).toBe(false);
        expect(seenCalls.some((c) => c.blockId === 'dyn_prefix')).toBe(true);
        expect(seenCalls.some((c) => c.comment === 'DynamicRule')).toBe(true);
        expect(turn3.layer0Messages[1].content).toBe(
            '<system-rules>\n### StaticRule\nSTATIC_RULE_OK\n\n### DynamicRule\nRULE_LOW_HP\n</system-rules>',
        );
        expect(turn3.layer0Messages[3].content).toBe('STATIC_PREFIX_OK');
        expect(turn3.layer0Messages[4].content).toBe('PREFIX_COMBAT_ALERT');
    });

    it('selectively re-evaluates non-cacheable floating_tail blocks across tool rounds while caching static floating_tail blocks', async () => {
        const bridge = new MemoryHostBridge({
            characterFields: {
                description: '长角色描述，确保测试稳定。'.repeat(3),
            },
        });
        let dynRound = 0;
        let staticCalls = 0;
        bridge.onPromptTransform((payload) => {
            if (payload.meta.blockId === 'static_floating') {
                staticCalls += 1;
                payload.text = 'STATIC_FLOATING_ONCE';
            } else if (payload.meta.blockId === 'dyn_floating') {
                dynRound += 1;
                payload.cache.disable('per-round dynamic floating', 'ext');
                payload.text = `DYN_ROUND_${dynRound}`;
            }
        });

        const settings = createDefaultSettings();
        settings.presets.default.agents.main.sessionMode = 'persistent';
        settings.presets.default.agents.main.strictToolLoop = 'off';
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'system_base',
                name: 'Base',
                role: 'system',
                placement: 'prefix',
                content: 'Base system',
                enabled: true,
            },
            {
                id: 'static_floating',
                name: 'Static Floating',
                role: 'system',
                placement: 'floating_tail',
                content: '<<STATIC>>',
                enabled: true,
            },
            {
                id: 'dyn_floating',
                name: 'Dynamic Floating',
                role: 'system',
                placement: 'floating_tail',
                content: '<<DYN>>',
                enabled: true,
            },
        ];

        const transport = new ScriptedLLMTransport([
            (req) => {
                expect(req.messages.slice(-2).map((m) => m.content)).toEqual([
                    'STATIC_FLOATING_ONCE',
                    'DYN_ROUND_1',
                ]);
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_list_1',
                            name: 'list_dir',
                            arguments: JSON.stringify({ path: '/' }),
                        },
                    ],
                };
            },
            (req) => {
                expect(req.messages.slice(-2).map((m) => m.content)).toEqual([
                    'STATIC_FLOATING_ONCE',
                    'DYN_ROUND_2',
                ]);
                return {
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_write_out',
                            name: 'write_file',
                            arguments: JSON.stringify({ path: '/output.md', content: 'Done' }),
                        },
                    ],
                };
            },
            () => ({ content: 'Finished.' }),
        ]);

        const runner = new AgentRunner({
            bridge,
            transport,
            settings: () => settings,
        });

        const res = await runner.run({
            agent: 'main',
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Go',
            stream: false,
        });

        expect(res.content).toBe('Done');
        expect(staticCalls).toBe(1);
        expect(dynRound).toBe(3);
    });

    it('propagates read_file editable/writable metadata, preserves raw templates for edit_file, aligns TailRadar dryRun, and caches cacheable VFS reads', async () => {
        const bridge = new MemoryHostBridge({
            lorebooks: {
                BookA: [
                    {
                        world: 'BookA',
                        uid: 10,
                        comment: 'HeroSecret',
                        content: '秘密：<%- vars.secret %> | [[EXT]]',
                        keys: ['秘密'],
                        keysecondary: [],
                        constant: false,
                        selective: false,
                        disable: false,
                        position: 0,
                        depth: 4,
                        order: 10,
                        role: 0,
                    },
                ],
            },
            ejsEvaluator: async (text, vars) =>
                text.replace(/<%-\s*vars\.secret\s*%>/g, String(vars.secret ?? '')),
        });
        bridge.setVariable('secret', 'REAL_SECRET');

        const observedMeta: Array<{
            source: string;
            dryRun: boolean;
            editable?: boolean;
            writable?: boolean;
            messageId?: number;
            swipeId?: number;
            target?: { messageId: number; swipeId: number };
        }> = [];
        bridge.onPromptTransform((payload) => {
            if (payload.source === 'vfs_read' || payload.source === 'lore_radar') {
                observedMeta.push({
                    source: payload.source,
                    dryRun: payload.dryRun,
                    editable: payload.meta.editable,
                    writable: payload.meta.writable,
                    messageId: payload.meta.messageId,
                    swipeId: payload.meta.swipeId,
                    target: payload.meta.target,
                });
            }
            if (payload.text.includes('[[EXT]]')) {
                if (payload.meta.editable) {
                    // External extension chooses to preserve raw syntax for editable files
                    return;
                }
                payload.text = payload.text.replace('[[EXT]]', 'EXT_EXPANDED');
            }
        });

        const store = new ChatDataStore(bridge);
        const loreEval = new LoreReadEvaluator(bridge);
        const vfs = new VirtualFileSystem({
            bridge,
            store,
            loreReadHook: loreEval.toLoreReadHook(),
        });
        const target = { messageId: 0, swipeId: 0 };
        const registry = createBuiltinToolRegistry();

        // 1. Read-only agent: editable=false, writable=false -> EJS & external transform both run
        const readOnlyCtx = createToolExecutionContext({
            bridge,
            vfs,
            store,
            target,
            permissions: { read: ['/**'], write: [] },
            canEditFiles: false,
        });
        const roRead = await registry.executeToolCall(
            'read_file',
            JSON.stringify({ path: '/lorebooks/BookA/HeroSecret-10.md' }),
            readOnlyCtx,
        );
        expect(roRead.ok).toBe(true);
        expect(roRead.output).toContain('秘密：REAL_SECRET | EXT_EXPANDED');
        expect(observedMeta.at(-1)).toEqual({
            source: 'vfs_read',
            dryRun: false,
            editable: false,
            writable: false,
            messageId: 0,
            swipeId: 0,
            target: { messageId: 0, swipeId: 0 },
        });

        // 2. Write-only agent (write_file allowed, edit_file disabled): writable=true, editable=false
        const writeOnlyCtx = createToolExecutionContext({
            bridge,
            vfs,
            store,
            target,
            permissions: { read: ['/**'], write: ['/lorebooks/**'] },
            canEditFiles: false,
        });
        await registry.executeToolCall(
            'read_file',
            JSON.stringify({ path: '/lorebooks/BookA/HeroSecret-10.md' }),
            writeOnlyCtx,
        );
        expect(observedMeta.at(-1)).toEqual({
            source: 'vfs_read',
            dryRun: false,
            editable: false,
            writable: true,
            messageId: 0,
            swipeId: 0,
            target: { messageId: 0, swipeId: 0 },
        });

        // 3. Edit-capable agent: editable=true, writable=true -> built-in EJS skips so edit_file matches verbatim!
        const editCapableCtx = createToolExecutionContext({
            bridge,
            vfs,
            store,
            target,
            permissions: { read: ['/**'], write: ['/lorebooks/**'] },
            canEditFiles: true,
        });
        const editableRead = await registry.executeToolCall(
            'read_file',
            JSON.stringify({ path: '/lorebooks/BookA/HeroSecret-10.md' }),
            editCapableCtx,
        );
        expect(editableRead.output).toContain('秘密：<%- vars.secret %> | [[EXT]]');
        expect(observedMeta.at(-1)).toEqual({
            source: 'vfs_read',
            dryRun: false,
            editable: true,
            writable: true,
            messageId: 0,
            swipeId: 0,
            target: { messageId: 0, swipeId: 0 },
        });

        const editRes = await registry.executeToolCall(
            'edit_file',
            JSON.stringify({
                path: '/lorebooks/BookA/HeroSecret-10.md',
                search: '<%- vars.secret %>',
                replace: '<%- vars.secret %>_EDITED',
            }),
            editCapableCtx,
        );
        expect(editRes.ok).toBe(true);
        expect(JSON.parse(editRes.output).ok).toBe(true);

        // 4. TailRadar receives dryRun=true and aligned editable/writable capabilities
        const radar = new TailRadar(loreEval);
        const radarRes = await radar.scan(
            (await bridge.listEnabledLorebooks()).get('BookA')!,
            {
                input: '告诉我秘密',
                target,
                vars: { secret: 'REAL_SECRET' },
                canEditPath: () => true,
                canWritePath: () => true,
            },
        );
        expect(radarRes.candidates).toHaveLength(1);
        expect(observedMeta.at(-1)).toEqual({
            source: 'lore_radar',
            dryRun: true,
            editable: true,
            writable: true,
            messageId: 0,
            swipeId: 0,
            target: { messageId: 0, swipeId: 0 },
        });

        // 5. VFS transform cache hits on cacheable plain-mount external transform, bypasses on cacheable: false
        let cacheableCalls = 0;
        let nonCacheableCalls = 0;
        bridge.onPromptTransform((payload) => {
            if (payload.source !== 'vfs_read') {
                return;
            }
            if (payload.meta.path === '/workspace/cacheable.md') {
                cacheableCalls += 1;
                payload.text = payload.text.replace('[[C]]', 'CACHED_OK');
            }
            if (payload.meta.path === '/workspace/dynamic.md') {
                nonCacheableCalls += 1;
                payload.cache.disable('volatile', 'ext');
                payload.text = payload.text.replace('[[D]]', `DYN_${nonCacheableCalls}`);
            }
        });
        await vfs.writeFile('/workspace/cacheable.md', 'Hello [[C]]', { target, staged: true });
        await vfs.writeFile('/workspace/dynamic.md', 'Hello [[D]]', { target, staged: true });

        expect(await vfs.readFile('/workspace/cacheable.md', { target, staged: true })).toBe('Hello CACHED_OK');
        expect(await vfs.readFile('/workspace/cacheable.md', { target, staged: true })).toBe('Hello CACHED_OK');
        expect(cacheableCalls).toBe(1);

        expect(await vfs.readFile('/workspace/dynamic.md', { target, staged: true })).toBe('Hello DYN_1');
        expect(await vfs.readFile('/workspace/dynamic.md', { target, staged: true })).toBe('Hello DYN_2');
        expect(nonCacheableCalls).toBe(2);
    });

    it('passes chat-message metadata (isChatMessage, messageId, swipeId, name, isUser), preserves protocol transparency on multimodal blocks, and never passes persistent Layer 1 history', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '莫布', charName: '爱丽丝' },
            chat: [
                { id: 0, name: '爱丽丝', isUser: false, mes: '开场白 [[H]]', swipeId: 1 },
                { id: 1, name: '莫布', isUser: true, mes: '你好 [[U]]', swipeId: 2 },
            ],
        });

        const captured: PromptTransformPayload[] = [];
        bridge.onPromptTransform((payload) => {
            captured.push(payload);
            payload.text = payload.text
                .replace('[[H]]', '[HIST]')
                .replace('[[U]]', '[USER]')
                .replace('[[B]]', '[BLOCK]');
        });

        const assembler = new ContextAssembler();
        const store = new TrajectoryStore();

        // Ephemeral agent: receives chat_message metadata for recentChatMessages & main user_input
        const ephemeralAgent = createDefaultMainAgent({
            id: 'ephemeral_helper',
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 2,
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'Base [[B]]',
                    enabled: true,
                },
                {
                    id: 'custom_mm',
                    name: 'Custom Multimodal',
                    role: 'custom',
                    placement: 'tail',
                    content: JSON.stringify([
                        {
                            role: 'user',
                            name: 'Narrator',
                            content: [
                                { type: 'text', text: 'Caption [[B]]' },
                                { type: 'image_url', image_url: { url: 'https://example.com/[[B]].png' } },
                            ],
                        },
                    ]),
                    enabled: true,
                },
            ],
        });

        const ephCtx = await assembler.assembleWithHost({
            agent: ephemeralAgent,
            hostBridge: bridge,
            target: { messageId: 2, swipeId: 0 },
            promptTriggerContext: { kind: 'main', action: 'normal' },
            recentChatMessages: [
                { id: 0, name: '爱丽丝', isUser: false, mes: '开场白 [[H]]', swipeId: 1 },
            ],
            userInput: '你好 [[U]]',
            userName: '莫布',
        });

        const chatHistPayload = captured.find((p) => p.source === 'chat_message');
        expect(chatHistPayload?.meta).toMatchObject({
            isChatMessage: true,
            target: { messageId: 2, swipeId: 0 },
            messageId: 0,
            swipeId: 1,
            name: '爱丽丝',
            isUser: false,
        });
        expect(chatHistPayload?.layer).toBe('layer1_ephemeral');

        const mainUserPayload = captured.find((p) => p.source === 'user_input');
        expect(mainUserPayload?.meta).toMatchObject({
            isChatMessage: true,
            target: { messageId: 2, swipeId: 0 },
            messageId: 1,
            swipeId: 2,
            name: '莫布',
            isUser: true,
        });

        const blockPayloads = captured.filter((p) => p.source === 'prompt_block');
        expect(blockPayloads.every((p) => p.meta.isChatMessage === false)).toBe(true);
        expect(
            blockPayloads.every(
                (p) =>
                    p.meta.messageId === 2
                    && p.meta.swipeId === 0
                    && p.meta.target?.messageId === 2
                    && p.meta.target?.swipeId === 0,
            ),
        ).toBe(true);
        expect(blockPayloads.some((p) => p.rawText.includes('https://example.com/'))).toBe(false);
        const narratorPayload = blockPayloads.find((p) => p.meta.blockId === 'custom_mm');
        expect(narratorPayload?.meta.name).toBe('Narrator');
        expect(ephCtx.floatingTailMessages[0].content).toEqual([
            { type: 'text', text: 'Caption [BLOCK]' },
            { type: 'image_url', imageUrl: 'https://example.com/[[B]].png' },
        ]);

        // Trigger user_input carries isChatMessage: false while preserving anchored messageId/swipeId
        const lifecycleCoords: Array<{ messageId?: number; swipeId?: number }> = [];
        bridge.onPromptTransformTurnStart((p) => {
            lifecycleCoords.push({ messageId: p.messageId, swipeId: p.swipeId });
        });
        bridge.onPromptTransformTurnEnd((p) => {
            lifecycleCoords.push({ messageId: p.messageId, swipeId: p.swipeId });
        });
        captured.length = 0;
        await assembler.assembleWithHost({
            agent: ephemeralAgent,
            hostBridge: bridge,
            target: { messageId: 1, swipeId: 2 },
            promptTriggerContext: { kind: 'trigger', phase: 'after_turn' },
            userInput: 'Trigger task instruction',
        });
        const triggerUserPayload = captured.find((p) => p.source === 'user_input');
        expect(triggerUserPayload?.meta.isChatMessage).toBe(false);
        expect(triggerUserPayload?.meta.target).toEqual({ messageId: 1, swipeId: 2 });
        expect(triggerUserPayload?.meta.messageId).toBe(1);
        expect(triggerUserPayload?.meta.swipeId).toBe(2);
        expect(lifecycleCoords).toEqual([
            { messageId: 1, swipeId: 2 },
            { messageId: 1, swipeId: 2 },
        ]);

        // Ephemeral second pass with identical un-disabled chat message hits cache (no re-eval)
        captured.length = 0;
        await assembler.assembleWithHost({
            agent: ephemeralAgent,
            hostBridge: bridge,
            target: { messageId: 2, swipeId: 0 },
            promptTriggerContext: { kind: 'main', action: 'normal' },
            recentChatMessages: [
                { id: 0, name: '爱丽丝', isUser: false, mes: '开场白 [[H]]', swipeId: 1 },
            ],
            userInput: '你好 [[U]]',
            userName: '莫布',
        });
        expect(captured.some((p) => p.source === 'chat_message')).toBe(false);

        // Persistent Layer 1 history: transformed ONCE when uncached (promotes to cache),
        // then NEVER re-processed on subsequent turns; if cache.disable() is called, re-runs until cacheable.
        const persistentAgent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'Static base',
                    enabled: true,
                },
            ],
        });
        const persistBridge = new MemoryHostBridge({
            identity: { userName: '莫布', charName: '爱丽丝' },
        });
        let dynamicHistFlag = true;
        const persistSeen: Array<{ source: string; text: string; isChatMessage: boolean }> = [];
        persistBridge.onPromptTransform((payload) => {
            persistSeen.push({
                source: payload.source,
                text: payload.text,
                isChatMessage: payload.meta.isChatMessage,
            });
            if (payload.text.includes('[[DYNAMIC_HIST]]')) {
                if (dynamicHistFlag) {
                    payload.cache.disable('volatile', 'ext');
                    payload.text = 'DYNAMIC_V1';
                } else {
                    payload.text = 'DYNAMIC_CACHED';
                }
                return;
            }
            payload.text = payload.text.replace('[[U]]', '[USER]').replace('[[H]]', '[HIST]');
        });

        const t1 = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: persistBridge,
            trajectoryStore: store,
            target: { messageId: 1, swipeId: 0 },
            userInput: 'Turn 1 [[U]]',
        });
        expect(t1.userInputTransformState?.cached).toBe(true);
        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: persistentAgent.id,
            target: { messageId: 1, swipeId: 0 },
            turnMessages: t1.layer2Messages,
            turnTransformStates: [t1.userInputTransformState],
            finalAssistantMessage: { role: 'assistant', content: 'Reply 1 [[H]]' },
            finalAssistantTransformState: {
                cached: false,
                rawContent: 'Reply 1 [[H]]',
                meta: { source: 'chat_message', isChatMessage: true, messageId: 1, swipeId: 0, isUser: false },
            },
        });

        // Turn 2: Turn 1 user is already cached (skipped); Reply 1 [[H]] runs ONCE & promotes to cached!
        persistSeen.length = 0;
        const t2 = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: persistBridge,
            trajectoryStore: store,
            target: { messageId: 3, swipeId: 0 },
            userInput: 'Turn 2 [[DYNAMIC_HIST]]',
        });
        expect(persistSeen.filter((e) => e.source === 'chat_message')).toEqual([
            { source: 'chat_message', text: 'Reply 1 [[H]]', isChatMessage: true },
        ]);
        expect(t2.layer1Messages[1]?.content).toBe('Reply 1 [HIST]');
        expect(t2.userInputTransformState?.cached).toBe(false);

        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: persistentAgent.id,
            target: { messageId: 3, swipeId: 0 },
            turnMessages: t2.layer2Messages,
            turnTransformStates: [t2.userInputTransformState],
            finalAssistantMessage: { role: 'assistant', content: 'Reply 2' },
            finalAssistantTransformState: {
                cached: true,
            },
        });

        // Turn 3: Reply 1 is now cached (NOT called); Turn 2 dynamic user STILL re-runs while disabled
        persistSeen.length = 0;
        dynamicHistFlag = false; // This pass does NOT call cache.disable() -> promotes Turn 2!
        const t3 = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: persistBridge,
            trajectoryStore: store,
            target: { messageId: 5, swipeId: 0 },
            userInput: 'Turn 3',
        });
        expect(persistSeen.filter((e) => e.text.includes('Reply 1'))).toHaveLength(0);
        expect(persistSeen.some((e) => e.text === 'Turn 2 [[DYNAMIC_HIST]]')).toBe(true);
        expect(t3.layer1Messages[2]?.content).toBe('DYNAMIC_CACHED');
        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: persistentAgent.id,
            target: { messageId: 5, swipeId: 0 },
            turnMessages: t3.layer2Messages,
            turnTransformStates: [t3.userInputTransformState],
            finalAssistantMessage: { role: 'assistant', content: 'Reply 3' },
            finalAssistantTransformState: { cached: true },
        });

        // Turn 4: Turn 2 has now been promoted to cached -> zero Layer 1 re-evaluations!
        persistSeen.length = 0;
        const t4 = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: persistBridge,
            trajectoryStore: store,
            target: { messageId: 7, swipeId: 0 },
            userInput: 'Turn 4',
        });
        expect(persistSeen.some((e) => e.source === 'chat_message' || e.text.includes('DYNAMIC_HIST'))).toBe(false);
        assertAppendOnlyPrefix(t3.request, t4.request);
    });

    it('transforms read_history (whole text) and read_variables (raw JSON, no JSON validation) across AgentRunner, AssistantRunner, and SideGenService', async () => {
        // 1. AgentRunner: read_history + read_variables (with invalid JSON pass-through)
        const agentBridge = new MemoryHostBridge({
            identity: { userName: 'Player', charName: 'Aria' },
        });
        agentBridge.pushMessage({ id: 0, name: 'Player', isUser: true, mes: 'Hi' });
        agentBridge.pushMessage({ id: 1, name: 'Aria', isUser: false, mes: '', swipeId: 0 });
        agentBridge.setVariable('hp', 50);

        const store = new ChatDataStore(agentBridge);
        const vfs = new VirtualFileSystem({ bridge: agentBridge, store });
        await vfs.writeHistoryInternal(
            '/history/chunk-001.md',
            'Archived [[HIST_VAR]] line 1\nArchived line 2',
        );

        const agentHooks: Array<{ source: string; toolName?: string; editable?: boolean }> = [];
        agentBridge.onPromptTransform((payload) => {
            if (payload.source === 'history_read' || payload.source === 'variables_read') {
                agentHooks.push({
                    source: payload.source,
                    toolName: payload.meta.toolName,
                    editable: payload.meta.editable,
                });
            }
            if (payload.source === 'history_read') {
                payload.text = payload.text.replace('[[HIST_VAR]]', 'EXPANDED_HIST');
            }
            if (payload.source === 'variables_read') {
                // Deliberately return non-JSON text to verify raw JSON string pass-through without repair/error
                payload.text = '<<BROKEN_JSON_FROM_EXT>>';
            }
        });

        const conn = createDefaultConnection({
            id: 'conn_tools',
            model: 'gemini-2.5-pro',
            stream: false,
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const agent = createDefaultMainAgent({
            id: 'main',
            connectionId: conn.id,
            sessionMode: 'persistent',
            enabledTools: ['read_history', 'read_variables', 'patch_variables', 'write_file'],
            permissions: {
                read: ['/**'],
                write: ['/memory/**', '/notes/**', '/state/variables.json'],
            },
        });
        const preset = createDefaultPreset({
            id: 'p_tools',
            mainAgentId: 'main',
            agents: { main: agent },
        });
        const settings = createDefaultSettings({
            connections: { [conn.id]: conn },
            currentConnectionId: conn.id,
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });
        const transport = new ScriptedLLMTransport([
            {
                toolCalls: [
                    { id: 'rh_1', name: 'read_history', arguments: JSON.stringify({ chunk: 'chunk-001.md' }) },
                    { id: 'rv_1', name: 'read_variables', arguments: JSON.stringify({ scope: 'message' }) },
                ],
            },
            (req) => {
                const toolMsgs = req.messages.filter((m) => m.role === 'tool');
                expect(String(toolMsgs[0]?.content)).toContain('EXPANDED_HIST');
                expect(toolMsgs[1]?.content).toBe('<<BROKEN_JSON_FROM_EXT>>');
                return {
                    toolCalls: [
                        { id: 'wo_1', name: 'write_file', arguments: JSON.stringify({ path: '/output.md', content: 'Agent ok' }) },
                    ],
                };
            },
            { content: 'Done' },
        ]);
        const agentRunner = new AgentRunner({ bridge: agentBridge, transport, settings, vfs });
        const agentRes = await agentRunner.run({
            agent,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
        });
        expect(agentRes.content).toBe('Agent ok');
        expect(agentHooks).toEqual([
            { source: 'history_read', toolName: 'read_history', editable: false },
            { source: 'variables_read', toolName: 'read_variables', editable: true },
        ]);

        // 2. AssistantRunner (Workbench): user prompt + Layer 1 once-cache + read_history + read_variables + read_file in adjust mode
        const astBridge = createOffMainlineTestBridge();
        astBridge.setVariable('gold', 77);
        const astStore = new ChatDataStore(astBridge);
        const astSeen: Array<{ source: string; text: string; editable?: boolean }> = [];
        astBridge.onPromptTransform((payload) => {
            astSeen.push({
                source: payload.source,
                text: payload.text,
                editable: payload.meta.editable,
            });
            payload.text = payload.text
                .replace('[[WB_U]]', 'WORKBENCH_USER')
                .replace('[[WH]]', 'WB_HIST')
                .replace('[[WB_FILE]]', 'WB_FILE_EXPANDED');
        });
        const astTransport = new ScriptedLLMTransport([
            {
                toolCalls: [
                    { id: 'a_rh', name: 'read_history', arguments: JSON.stringify({ chunk: 'chunk-002.md' }) },
                    { id: 'a_rv', name: 'read_variables', arguments: JSON.stringify({ scope: 'message' }) },
                    { id: 'a_rf', name: 'read_file', arguments: JSON.stringify({ path: '/workspace/wb.md' }) },
                ],
            },
            (req) => {
                expect(req.messages.some((m) => m.role === 'user' && String(m.content).includes('WORKBENCH_USER'))).toBe(true);
                const tMsgs = req.messages.filter((m) => m.role === 'tool');
                expect(String(tMsgs[0]?.content)).toContain('WB_HIST');
                expect(String(tMsgs[1]?.content)).toContain('77');
                expect(String(tMsgs[2]?.content)).toContain('WB_FILE_EXPANDED');
                return { content: 'Assistant first reply' };
            },
            (req) => {
                // Turn 2: Turn 1's user/tool msgs were already cached -> ONLY Assistant first reply + Turn 2 user run!
                expect(req.messages.some((m) => m.role === 'assistant' && m.content === 'Assistant first reply')).toBe(true);
                return { content: 'Assistant second reply' };
            },
        ]);
        const astSettings = createDefaultSettings();
        astSettings.connections.default = {
            ...astSettings.connections.default,
            strictToolLoop: false,
            stream: false,
        };
        const astRunner = new AssistantRunner({
            bridge: astBridge,
            transport: astTransport,
            store: astStore,
            trajectoryStore: new TrajectoryStore(),
            settings: astSettings,
            stream: false,
        });
        await astRunner.vfs.writeHistoryInternal('/history/chunk-002.md', 'Workbench [[WH]] archive');
        await astRunner.vfs.writeFile('/workspace/wb.md', 'Workspace [[WB_FILE]]', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
        });
        const wbSession = await astRunner.createSession({ mode: 'adjust', title: 'WB Hooks' });
        await astRunner.sendPrompt(wbSession.id, 'Check [[WB_U]]');
        expect(astSeen.some((e) => e.source === 'vfs_read' && e.editable === true)).toBe(true);
        expect(astSeen.some((e) => e.source === 'variables_read' && e.editable === true)).toBe(true);

        astSeen.length = 0;
        await astRunner.sendPrompt(wbSession.id, 'Follow-up');
        expect(astSeen.some((e) => e.text === 'Assistant first reply' && e.source === 'chat_message')).toBe(true);
        expect(astSeen.some((e) => e.source === 'history_read' || e.source === 'variables_read' || e.source === 'vfs_read')).toBe(false);

        // 3. SideGenService: ST chat tail (Rule #2 cached) + user prompt + session Layer 1 history
        const sideBridge = createOffMainlineTestBridge();
        const sideSeen: Array<{ source: string; text: string; messageId?: number }> = [];
        sideBridge.onPromptTransform((payload) => {
            sideSeen.push({
                source: payload.source,
                text: payload.text,
                messageId: payload.meta.messageId,
            });
            payload.text = payload.text.replace('[[SIDE_M]]', 'SIDE_EXPANDED');
        });
        const sideTransport = new ScriptedLLMTransport([
            (req) => {
                const u = req.messages.find((m) => m.role === 'user');
                expect(String(u?.content)).toContain('SIDE_EXPANDED');
                return { content: 'Side reply 1 [[SIDE_M]]' };
            },
            () => ({ content: 'Side reply 2' }),
        ]);
        const sideSettings = createDefaultSettings();
        sideSettings.connections['side-c'] = createDefaultConnection({
            id: 'side-c',
            model: 'gemini-2.5-flash',
            strictToolLoop: false,
            stream: false,
        });
        const sideService = new SideGenService({
            bridge: sideBridge,
            transport: sideTransport,
            trajectoryStore: new TrajectoryStore(),
            getDefaultConnectionId: () => 'side-c',
            getSettings: () => sideSettings,
            resolveConnection: (id) => sideSettings.connections[id],
        });
        await sideService.createSession({ id: 'side:t', title: 'Side T', systemPrompt: 'sys' });
        await sideService.send('side:t', 'Analyze [[SIDE_M]]', { mainChatDepth: 2 });
        const chatTailCountTurn1 = sideSeen.filter((e) => e.source === 'chat_message').length;
        expect(chatTailCountTurn1).toBeGreaterThan(0);

        sideSeen.length = 0;
        await sideService.send('side:t', 'Next', { mainChatDepth: 2 });
        // Turn 1's unchanged ST chat tail messages hit cache (skipped), while Turn 1's SideGen reply runs once!
        expect(sideSeen.filter((e) => e.source === 'chat_message')).toEqual([
            { source: 'chat_message', text: 'Side reply 1 [[SIDE_M]]', messageId: 1 },
        ]);
    });

    it('registers built-in EJS hook via makeLast on eventSource and yields to external ejs handlers', async () => {
        globalHolder.EjsTemplate = {
            evalTemplate: vi.fn(async (code: string) => code.replace('<%- v %>', 'BUILTIN_VAL')),
        };

        const listeners: Record<string, PromptTransformListener[]> = {};
        const fakeEventSource = {
            on(event: string, fn: PromptTransformListener) {
                (listeners[event] ??= []).push(fn);
            },
            makeLast(event: string, fn: PromptTransformListener) {
                const arr = (listeners[event] ??= []);
                const idx = arr.indexOf(fn);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                }
                arr.push(fn);
            },
            removeListener(event: string, fn: PromptTransformListener) {
                const arr = listeners[event];
                if (!arr) {
                    return;
                }
                const idx = arr.indexOf(fn);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                }
            },
            async emit(event: string, payload: PromptTransformPayload) {
                for (const fn of [...(listeners[event] ?? [])]) {
                    await fn(payload);
                }
            },
        };

        const extListener: PromptTransformListener = (payload) => {
            if (payload.text.includes('USE_EXT')) {
                payload.text = payload.text.replace('<%- v %>', 'EXT_OVERRIDE');
                payload.handledSyntaxes.add('ejs');
            }
        };
        fakeEventSource.on(PROMPT_TRANSFORM_EVENTS.TRANSFORM, extListener);

        const dispose = registerBuiltinEjsPromptTransformHook({ eventSource: fakeEventSource });
        expect(listeners[PROMPT_TRANSFORM_EVENTS.TRANSFORM]).toHaveLength(2);
        expect(listeners[PROMPT_TRANSFORM_EVENTS.TRANSFORM][0]).toBe(extListener);

        const { createPromptTransformPayload, finalizePromptTransformPayload } = await import('@/core/bridge');

        const p1 = createPromptTransformPayload({
            text: 'A <%- v %>',
            source: 'prompt_block',
            layer: 'layer0_prefix',
            meta: { sessionId: 's1' },
        });
        await fakeEventSource.emit(PROMPT_TRANSFORM_EVENTS.TRANSFORM, p1);
        expect(finalizePromptTransformPayload(p1, 'A <%- v %>').text).toBe('A BUILTIN_VAL');

        const p2 = createPromptTransformPayload({
            text: 'USE_EXT <%- v %>',
            source: 'prompt_block',
            layer: 'layer0_prefix',
            meta: { sessionId: 's1' },
        });
        await fakeEventSource.emit(PROMPT_TRANSFORM_EVENTS.TRANSFORM, p2);
        expect(finalizePromptTransformPayload(p2, 'USE_EXT <%- v %>').text).toBe('USE_EXT EXT_OVERRIDE');

        dispose();
        expect(listeners[PROMPT_TRANSFORM_EVENTS.TRANSFORM]).toEqual([extListener]);
    });

    it('re-evaluates Layer 0 prefix, Layer 1 persistent messages (user/assistant/read_file/checkpoints), ephemeral history, and SideGen tail after cache clear', async () => {
        let rev = 1;
        const seenEvents: Array<{ source: string; text: string }> = [];
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Player', charName: 'Aria' },
            chat: [
                { id: 0, name: 'Player', isUser: true, mes: 'Ephemeral [[TAG]]', swipeId: 0 },
                { id: 1, name: 'Aria', isUser: false, mes: '', swipeId: 0 },
            ],
        });
        bridge.onPromptTransform((payload) => {
            seenEvents.push({ source: payload.source, text: payload.text });
            payload.text = payload.text.replace('[[TAG]]', `REV_${rev}`);
        });

        const vfs = new VirtualFileSystem({ bridge });
        await vfs.writeFile('/workspace/doc.md', 'Doc [[TAG]]', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
        });

        const assembler = new ContextAssembler();
        const trajectoryStore = new TrajectoryStore();
        const persistentAgent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'Prefix [[TAG]]',
                    enabled: true,
                },
            ],
        });

        // Turn 1: evaluates prefix + user_input -> caches both
        const r1 = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 1, swipeId: 0 },
            userInput: 'User1 [[TAG]]',
        });
        expect(r1.layer0Messages.some((m) => String(m.content).includes('REV_1'))).toBe(true);
        expect(r1.layer2Messages[0]?.content).toBe('User1 REV_1');

        const readResult = await vfs.readFile('/workspace/doc.md', {
            target: { messageId: 1, swipeId: 0 },
            editable: false,
            writable: false,
        });
        assembler.finalizeTurn({
            trajectoryStore,
            agentId: persistentAgent.id,
            target: { messageId: 1, swipeId: 0 },
            turnMessages: [
                ...r1.layer2Messages,
                { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"/workspace/doc.md"}' }] },
                { role: 'tool', toolCallId: 'tc1', toolName: 'read_file', content: readResult },
            ],
            turnTransformStates: [
                r1.userInputTransformState,
                { cached: true },
                {
                    cached: true,
                    rawContent: 'Doc [[TAG]]',
                    meta: {
                        source: 'vfs_read',
                        isChatMessage: false,
                        toolName: 'read_file',
                        toolCallId: 'tc1',
                        path: '/workspace/doc.md',
                        mount: 'workspace',
                        editable: false,
                        writable: false,
                    },
                },
            ],
            finalAssistantMessage: { role: 'assistant', content: 'Reply1 [[TAG]]' },
            finalAssistantTransformState: {
                cached: true,
                rawContent: 'Reply1 [[TAG]]',
                meta: {
                    source: 'chat_message',
                    isChatMessage: true,
                    messageId: 1,
                    swipeId: 0,
                    isUser: false,
                },
            },
        });

        // Ephemeral + SideGen Turn 1 (populate their caches)
        const ephemeralAgent = createDefaultMainAgent({ id: 'eph', sessionMode: 'ephemeral', ephemeralWindowSize: 4 });
        await assembler.assembleWithHost({
            agent: ephemeralAgent,
            hostBridge: bridge,
            recentChatMessages: [{ id: 0, name: 'Player', isUser: true, mes: 'Ephemeral [[TAG]]', swipeId: 0 }],
            userInput: 'Ping',
        });

        const sideTransport = new ScriptedLLMTransport([{ content: 'Side1' }, { content: 'Side2' }]);
        const sideSettings = createDefaultSettings();
        sideSettings.connections['s-c'] = createDefaultConnection({ id: 's-c', strictToolLoop: false, stream: false });
        const sideService = new SideGenService({
            bridge,
            transport: sideTransport,
            trajectoryStore: new TrajectoryStore(),
            getDefaultConnectionId: () => 's-c',
            getSettings: () => sideSettings,
            resolveConnection: (id) => sideSettings.connections[id],
        });
        await sideService.createSession({ id: 'side:clr', title: 'Clr', systemPrompt: 'sys' });
        await sideService.send('side:clr', 'SidePrompt', { mainChatDepth: 2 });

        // Without cache clear: persistent Layer 0, cached Layer 1, ephemeral, and SideGen tail stay cached (REV_1)
        rev = 2;
        seenEvents.length = 0;
        const rCached = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 3, swipeId: 0 },
            userInput: 'User2',
        });
        expect(seenEvents.some((e) => e.source === 'prompt_block' && e.text.includes('Prefix [[TAG]]'))).toBe(false);
        expect(seenEvents.some((e) => e.source === 'user_input' && e.text === 'User1 [[TAG]]')).toBe(false);
        expect(seenEvents.some((e) => e.source === 'vfs_read')).toBe(false);
        expect(seenEvents.some((e) => e.source === 'chat_message')).toBe(false);
        expect(rCached.layer1Messages[0]?.content).toBe('User1 REV_1');

        // Clear all prompt caches -> bump transform rev=2 -> every single prompt layer re-evaluates!
        expect(trajectoryStore.clearAllFrozenPrefixes()).toBe(1);
        expect(trajectoryStore.clearAllTransformCaches()).toBe(4);
        expect(assembler.clearEphemeralChatTransformCache(bridge)).toBeGreaterThanOrEqual(1);
        expect(sideService.clearChatTailTransformCache()).toBeGreaterThanOrEqual(1);
        expect(vfs.clearReadTransformCache()).toBeGreaterThanOrEqual(1);

        // Even after restoreBranch from checkpoint (e.g. Swipe), cleared cache flags stay cleared
        expect(trajectoryStore.restoreBranch({ messageId: 1, swipeId: 0 }, persistentAgent.id)).toBe(true);

        seenEvents.length = 0;
        const rReeval = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 3, swipeId: 0 },
            userInput: 'User2',
        });
        expect(seenEvents.some((e) => e.source === 'prompt_block' && e.text.includes('Prefix [[TAG]]'))).toBe(true);
        expect(seenEvents.some((e) => e.source === 'user_input' && e.text === 'User1 [[TAG]]')).toBe(true);
        expect(seenEvents.some((e) => e.source === 'vfs_read' && e.text === 'Doc [[TAG]]')).toBe(true);
        expect(seenEvents.some((e) => e.source === 'chat_message' && e.text === 'Reply1 [[TAG]]')).toBe(true);
        expect(rReeval.layer0Messages.some((m) => String(m.content).includes('REV_2'))).toBe(true);
        expect(rReeval.layer1Messages[0]?.content).toBe('User1 REV_2');
        expect(rReeval.layer1Messages[2]?.content).toBe('Doc REV_2');
        expect(rReeval.layer1Messages[3]?.content).toBe('Reply1 REV_2');

        // Ephemeral & SideGen chat tail also re-evaluate after cache clear
        seenEvents.length = 0;
        const rEphReeval = await assembler.assembleWithHost({
            agent: ephemeralAgent,
            hostBridge: bridge,
            recentChatMessages: [{ id: 0, name: 'Player', isUser: true, mes: 'Ephemeral [[TAG]]', swipeId: 0 }],
            userInput: 'Ping2',
        });
        expect(seenEvents.some((e) => e.source === 'chat_message' && e.text === 'Ephemeral [[TAG]]')).toBe(true);
        expect(rEphReeval.layer1Messages[0]?.content).toBe('Ephemeral REV_2');

        seenEvents.length = 0;
        await sideService.send('side:clr', 'SidePrompt2', { mainChatDepth: 2 });
        expect(seenEvents.some((e) => e.source === 'chat_message' && e.text === 'Ephemeral [[TAG]]')).toBe(true);

        // Next turn after re-evaluation uses newly cached REV_2 without calling hooks again
        rev = 3;
        seenEvents.length = 0;
        const rRecached = await assembler.assembleWithHost({
            agent: persistentAgent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 3, swipeId: 0 },
            userInput: 'User3',
        });
        expect(seenEvents.some((e) => e.source === 'prompt_block' && e.text.includes('Prefix [[TAG]]'))).toBe(false);
        expect(seenEvents.some((e) => e.source === 'user_input' && e.text === 'User1 [[TAG]]')).toBe(false);
        expect(seenEvents.some((e) => e.source === 'vfs_read')).toBe(false);
        expect(seenEvents.some((e) => e.source === 'chat_message')).toBe(false);
        expect(rRecached.layer1Messages[0]?.content).toBe('User1 REV_2');
    });
});
