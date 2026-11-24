import { describe, expect, it } from 'vitest';
import { AgentRunner, FINISH_TURN_TOOL_NAME } from '@/core/agents';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
    exportPreset,
    normalizeConnection,
    normalizePromptBlock,
    selectPresetBlocksForContext,
    validatePresetImport,
} from '@/core/config';
import {
    ContextAssembler,
    TrajectoryStore,
    validateCustomPromptBlock,
} from '@/core/context';
import { PayloadCompiler } from '@/core/llm';
import { createBuiltinToolRegistry } from '@/core/tools';
import type { CanonicalMessage, PromptBlock } from '@/core/types';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

describe('floating_tail prompt block placement', () => {
    it('preserves placement: "floating_tail" in normalizePromptBlock and routes it to tail in selectPresetBlocksForContext', () => {
        const normalized = normalizePromptBlock({
            id: 'ft_1',
            name: 'Floating Rules',
            role: 'system',
            placement: 'floating_tail',
            content: 'Always obey tags.',
            enabled: true,
        });
        expect(normalized.placement).toBe('floating_tail');

        const preset = createDefaultPreset({
            agents: {
                main: createDefaultMainAgent({
                    promptBlocks: [
                        {
                            id: 'sys_prefix',
                            name: 'Prefix',
                            role: 'system',
                            placement: 'prefix',
                            content: 'Prefix content',
                            enabled: true,
                            triggers: ['assistant'],
                        },
                        {
                            id: 'sys_floating',
                            name: 'Floating',
                            role: 'system',
                            placement: 'floating_tail',
                            content: 'Floating content',
                            enabled: true,
                            triggers: ['assistant'],
                        },
                    ],
                }),
            },
        });

        const selected = selectPresetBlocksForContext(preset, {
            kind: 'assistant',
            mode: 'chat',
        });
        expect(selected.prefix.map((b) => b.id)).toEqual(['sys_prefix']);
        expect(selected.tail.map((b) => b.id)).toEqual(['sys_floating']);
    });

    it('assembles floating_tail after layer2Messages and inFlightMessages while keeping layer2Messages clean, supporting async EJS', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Traveler', charName: 'Guide' },
            ejsEvaluator: async (text, vars) =>
                text.replace(/<%-\s*phaseTag\s*%>/g, String(vars.phaseTag ?? '')),
        });

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'Base system instructions.',
                    enabled: true,
                },
                {
                    id: 'persisted_tail',
                    name: 'Persisted Tail',
                    role: 'user',
                    placement: 'tail',
                    content: 'Persisted tail note',
                    enabled: true,
                },
                {
                    id: 'ephemeral_floating',
                    name: 'Floating Tail EJS',
                    role: 'system',
                    placement: 'floating_tail',
                    content: 'Floating reminder [<%- phaseTag %>] for {{user}}',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const trajectoryStore = new TrajectoryStore();

        const round0 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 1, swipeId: 0 },
            userInput: 'Hello world',
            vars: { phaseTag: 'EJS_OK' },
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        expect(round0.layer2Messages.map((m) => m.content)).toEqual([
            'Hello world',
            'Persisted tail note',
        ]);
        expect(round0.floatingTailMessages).toEqual([
            { role: 'system', content: 'Floating reminder [EJS_OK] for Traveler' },
        ]);
        expect(round0.stats.floatingTailMessageCount).toBe(1);
        expect(round0.request.messages.slice(-3)).toEqual([
            { role: 'user', content: 'Hello world' },
            { role: 'user', content: 'Persisted tail note' },
            { role: 'system', content: 'Floating reminder [EJS_OK] for Traveler' },
        ]);

        const inFlight: CanonicalMessage[] = [
            ...round0.layer2Messages,
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/character/bio.md"}' }],
            },
            {
                role: 'tool',
                toolCallId: 'tc_1',
                toolName: 'read_file',
                content: 'Character bio text',
            },
        ];

        const round1 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore,
            target: { messageId: 1, swipeId: 0 },
            inFlightMessages: inFlight,
            vars: { phaseTag: 'EJS_OK' },
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        expect(round1.layer2Messages).toEqual(inFlight);
        expect(round1.floatingTailMessages).toEqual([
            { role: 'system', content: 'Floating reminder [EJS_OK] for Traveler' },
        ]);
        expect(round1.request.messages.slice(-3)).toEqual([
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/character/bio.md"}' }],
            },
            { role: 'tool', toolCallId: 'tc_1', toolName: 'read_file', content: 'Character bio text' },
            { role: 'system', content: 'Floating reminder [EJS_OK] for Traveler' },
        ]);
    });

    it('sandwiches in-flight and historical tool chains before floating_tail across turns without persisting floating_tail into TrajectoryStore', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Player', charName: 'Hero' },
            characterFields: { description: 'Hero character bio.' },
            chat: [
                { id: 0, name: 'Hero', isUser: false, mes: 'Opening scene.', swipeId: 0 },
                { id: 1, name: 'Player', isUser: true, mes: 'Turn 1 action', swipeId: 0 },
            ],
            ejsEvaluator: async (text, vars) =>
                text.replace(/<%-\s*tag\s*%>/g, String(vars.tag ?? 'v1')),
        });
        await bridge.saveExtensionData('vars_seed', true);

        const floatingBlock: PromptBlock = {
            id: 'floating_sync',
            name: 'Floating Sync',
            role: 'custom',
            placement: 'floating_tail',
            enabled: true,
            content: JSON.stringify([
                {
                    role: 'system',
                    content: 'FLOATING_STYLE_RULE [<%- tag %>]',
                },
                {
                    role: 'assistant',
                    tool_calls: [
                        {
                            id: 'call_sync_{{lastMessageId}}',
                            type: 'function',
                            function: { name: 'read_variables', arguments: {} },
                        },
                    ],
                },
                {
                    role: 'tool',
                    tool_call_id: 'call_sync_{{lastMessageId}}',
                    name: 'read_variables',
                    content: { ok: true, floating: true },
                },
            ]),
        };

        const agent = createDefaultMainAgent({
            strictToolLoop: 'on',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    enabled: true,
                    content: 'System base prompt.',
                },
                floatingBlock,
            ],
            enabledTools: ['read_file', 'write_file', 'read_variables'],
        });

        const connection = createDefaultConnection({
            id: 'conn_strict',
            providerFormat: 'openai',
            strictToolLoop: true,
            roundMaxRetries: 0,
        });
        const preset = createDefaultPreset({
            agents: { main: agent },
        });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport();
        // Turn 1: Round 0 -> read_file -> Round 1 -> write_file('/output.md') -> Round 2 -> finish_turn
        transport.enqueue(
            {
                toolCalls: [
                    {
                        id: 't1_r0',
                        name: 'read_file',
                        arguments: JSON.stringify({ path: '/character/description.md' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 't1_r1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'Turn 1 output' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 't1_r2',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Turn 1 done' }),
                    },
                ],
            },
            // Turn 2: Round 0 -> write_file('/output.md') -> Round 1 -> finish_turn
            {
                toolCalls: [
                    {
                        id: 't2_r0',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'Turn 2 output' }),
                    },
                ],
            },
            {
                toolCalls: [
                    {
                        id: 't2_r1',
                        name: FINISH_TURN_TOOL_NAME,
                        arguments: JSON.stringify({ step_brief: 'Turn 2 done' }),
                    },
                ],
            },
        );

        const trajectoryStore = new TrajectoryStore();
        const runner = new AgentRunner({
            bridge,
            transport,
            settings,
            trajectoryStore,
        });

        const res1 = await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Turn 1 action',
            userName: 'Player',
            vars: { tag: 'active' },
            macroOverrides: { lastMessageId: '1' },
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });
        expect(res1.content).toBe('Turn 1 output');

        // Inspect Turn 1 Round 0, Round 1, Round 2 requests
        const [req1R0, req1R1, req1R2] = transport.requests;

        // Round 0 ends with floating_tail after user input
        expect(req1R0.messages.slice(-4).map((m) => [m.role, m.toolName ?? m.content])).toEqual([
            ['user', 'Turn 1 action'],
            ['system', 'FLOATING_STYLE_RULE [active]'],
            ['assistant', ''],
            ['tool', 'read_variables'],
        ]);

        // Round 1 sandwiches read_file + tool result BEFORE floating_tail
        const r1ReadIdx = req1R1.messages.findIndex(
            (m) => m.role === 'tool' && m.toolCallId === 't1_r0',
        );
        const r1FloatStyleIdx = req1R1.messages.findIndex(
            (m) => m.role === 'system' && m.content === 'FLOATING_STYLE_RULE [active]',
        );
        expect(r1ReadIdx).toBeGreaterThan(0);
        expect(r1FloatStyleIdx).toBe(r1ReadIdx + 1);
        expect(req1R1.messages[req1R1.messages.length - 1].role).toBe('tool');
        expect(req1R1.messages[req1R1.messages.length - 1].toolCallId).toBe('call_sync_1');

        // Round 2 sandwiches read_file AND write_file tool chains BEFORE floating_tail
        const r2WriteIdx = req1R2.messages.findIndex(
            (m) => m.role === 'tool' && m.toolCallId === 't1_r1',
        );
        const r2FloatStyleIdx = req1R2.messages.findIndex(
            (m) => m.role === 'system' && m.content === 'FLOATING_STYLE_RULE [active]',
        );
        expect(r2WriteIdx).toBeGreaterThan(r1ReadIdx);
        expect(r2FloatStyleIdx).toBe(r2WriteIdx + 1);
        expect(req1R2.messages[req1R2.messages.length - 1].toolCallId).toBe('call_sync_1');

        // TrajectoryStore after Turn 1 must contain ZERO floating_tail messages
        const storedAfterTurn1 = trajectoryStore.getMessages(agent.id);
        expect(
            storedAfterTurn1.some(
                (m) =>
                    (typeof m.content === 'string' && m.content.includes('FLOATING_STYLE_RULE'))
                    || m.toolCallId === 'call_sync_1',
            ),
        ).toBe(false);

        // Turn 2 on messageId 3: Turn 1 history + Turn 1 tool chain + Turn 2 user + fresh floating_tail
        bridge.chat.push(
            { id: 2, name: 'Hero', isUser: false, mes: 'Turn 1 output', swipeId: 0 },
            { id: 3, name: 'Player', isUser: true, mes: 'Turn 2 action', swipeId: 0 },
        );

        const res2 = await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 3, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Turn 2 action',
            userName: 'Player',
            vars: { tag: 'active' },
            macroOverrides: { lastMessageId: '3' },
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });
        expect(res2.content).toBe('Turn 2 output');

        const req2R0 = transport.requests[3];
        const floatingStyleOccurrences = req2R0.messages.filter(
            (m) => m.role === 'system' && m.content === 'FLOATING_STYLE_RULE [active]',
        );
        expect(floatingStyleOccurrences).toHaveLength(1);
        expect(req2R0.messages.some((m) => m.toolCallId === 't1_r0')).toBe(true);
        expect(req2R0.messages.some((m) => m.toolCallId === 'call_sync_1')).toBe(false);
        expect(req2R0.messages[req2R0.messages.length - 1].toolCallId).toBe('call_sync_3');
    });

    it('folds partial: true prefill inside floating_tail without mutating turnMessages', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'User', charName: 'Char' },
            chat: [{ id: 0, name: 'User', isUser: true, mes: 'Go', swipeId: 0 }],
        });
        const agent = createDefaultMainAgent({
            strictToolLoop: 'off',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    enabled: true,
                    content: 'Write directly to /output.md.',
                },
                {
                    id: 'floating_prefill',
                    name: 'Floating Prefill',
                    role: 'custom',
                    placement: 'floating_tail',
                    enabled: true,
                    content: JSON.stringify({
                        role: 'assistant',
                        content: '<game>\n[Prefill]',
                        partial: true,
                    }),
                },
            ],
            enabledTools: ['read_file', 'write_file'],
        });
        const connection = createDefaultConnection({
            id: 'conn_prefill',
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const preset = createDefaultPreset({ agents: { main: agent } });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport();
        transport.enqueue(
            {
                toolCalls: [
                    {
                        id: 'pf_w1',
                        name: 'write_file',
                        arguments: JSON.stringify({ path: '/output.md', content: 'Finished scene' }),
                    },
                ],
                content: ' continuing tool...',
            },
            { content: ' final note.' },
        );

        const trajectoryStore = new TrajectoryStore();
        const runner = new AgentRunner({ bridge, transport, settings, trajectoryStore });

        const result = await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 0, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Go',
            requireOutputFile: true,
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        expect(result.content).toBe('Finished scene');
        // Second round request keeps user + pf_w1 tool pair without duplicating Turn 0 prefill into middle history,
        // while floating_tail re-attaches the prefill cleanly at the very end.
        const reqR1 = transport.requests[1];
        expect(reqR1.messages[reqR1.messages.length - 1].extraFields).toEqual({ partial: true });
        expect(
            reqR1.messages.slice(0, -1).some((m) => m.extraFields?.partial === true),
        ).toBe(false);
        // Persisted trajectory folds prefill prefix into assistant reply without leaving partial: true in history
        const stored = trajectoryStore.getMessages(agent.id);
        expect(stored.some((m) => m.extraFields?.partial === true)).toBe(false);
        expect(stored[stored.length - 1].content).toBe('<game>\n[Prefill] final note.');
    });

    it('compiles a full Prefix + Middle + Floating Tail topology end-to-end across Gemini, OpenAI, and Anthropic on Round 0 and Round 1', async () => {
        const seedAgent = createDefaultMainAgent({
            strictToolLoop: 'on',
            enabledTools: ['list_dir', 'read_file', 'write_file', 'read_variables'],
            promptBlocks: [
                {
                    id: 'prefix_system',
                    name: 'Prefix System',
                    role: 'system',
                    placement: 'prefix',
                    enabled: true,
                    content: 'Follow /preset/protocol.md and terminate turns via finish_turn.',
                },
                {
                    id: 'init_tool_context',
                    name: 'Init Tool Context',
                    role: 'custom',
                    placement: 'prefix',
                    enabled: true,
                    content: JSON.stringify([
                        { role: 'user', content: 'Initialize session workspace context.' },
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_init_list',
                                    type: 'function',
                                    function: { name: 'list_dir', arguments: '{"path":"/"}' },
                                    thoughtSignature: 'skip_thought_signature_validator',
                                },
                                {
                                    id: 'call_init_read',
                                    type: 'function',
                                    function: { name: 'read_file', arguments: '{"path":"/preset/protocol.md"}' },
                                    thoughtSignature: 'skip_thought_signature_validator',
                                },
                            ],
                        },
                        {
                            role: 'tool',
                            tool_call_id: 'call_init_list',
                            name: 'list_dir',
                            content: JSON.stringify({ entries: ['/preset/protocol.md', '/character/'] }),
                        },
                        {
                            role: 'tool',
                            tool_call_id: 'call_init_read',
                            name: 'read_file',
                            content: '# Protocol\nFollow style rules and finish via finish_turn.',
                        },
                    ]),
                },
                {
                    id: 'floating_style',
                    name: 'Floating Style Rules',
                    role: 'system',
                    placement: 'floating_tail',
                    enabled: true,
                    content: 'Always obey formatting and perspective constraints.',
                },
                {
                    id: 'tail_sync_tool_shell',
                    name: 'Tail Sync Tool Shell',
                    role: 'custom',
                    placement: 'floating_tail',
                    enabled: true,
                    content: JSON.stringify([
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_sync_turn_{{lastMessageId}}',
                                    type: 'function',
                                    function: { name: 'read_variables', arguments: '{}' },
                                    thoughtSignature: 'skip_thought_signature_validator',
                                },
                            ],
                        },
                        {
                            role: 'tool',
                            tool_call_id: 'call_sync_turn_{{lastMessageId}}',
                            name: 'read_variables',
                            content: JSON.stringify({ ok: true, char: '{{char}}', user: '{{user}}' }),
                        },
                    ]),
                },
            ],
        });
        const seedConnection = createDefaultConnection({
            id: 'conn_e2e_topology',
            providerFormat: 'gemini',
            model: 'gemini-2.5-pro',
            strictToolLoop: true,
            roundMaxRetries: 3,
        });
        const seedPreset = createDefaultPreset({
            id: 'preset_floating_tail_e2e',
            name: 'Floating Tail E2E Topology',
            agents: { main: seedAgent },
            files: {
                'protocol.md': '# Protocol\nFollow style rules and finish via finish_turn.',
            },
        });
        const rawJson = JSON.parse(
            JSON.stringify(exportPreset(seedPreset, { includeConnection: seedConnection })),
        );

        const imported = validatePresetImport(rawJson);
        expect(imported.ok).toBe(true);
        if (!imported.ok) {
            return;
        }

        const preset = imported.data.presets[0];
        const baseConn = imported.data.connection!;
        expect(baseConn.strictToolLoop).toBe(true);
        expect(baseConn.roundMaxRetries).toBe(3);

        const mainAgent = preset.agents[preset.mainAgentId];
        expect(mainAgent.strictToolLoop).toBe('on');
        expect(preset.files['protocol.md']).toBeTruthy();

        const floatingBlocks = mainAgent.promptBlocks.filter((b) => b.placement === 'floating_tail');
        expect(floatingBlocks).toHaveLength(2);
        expect(
            mainAgent.promptBlocks.some(
                (b) => b.id === 'tail_sync_tool_shell' && b.placement === 'floating_tail',
            ),
        ).toBe(true);

        for (const customBlock of mainAgent.promptBlocks.filter((b) => b.role === 'custom')) {
            const validation = validateCustomPromptBlock(customBlock.content);
            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);
            expect(validation.warnings).toEqual([]);
        }

        const registry = createBuiltinToolRegistry();
        const tools = [
            ...registry.toCanonicalSchemas(mainAgent.enabledTools, preset.builtinToolSettings),
            {
                name: FINISH_TURN_TOOL_NAME,
                description: 'Complete the current turn and submit the final result.',
                parameters: {
                    type: 'object',
                    properties: {
                        step_brief: { type: 'string' },
                    },
                    required: ['step_brief'],
                },
            },
        ];

        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '测试角色' },
            characterFields: { description: '一位冷静的侦探角色。' },
            personaDescription: '普通人类旅者。',
        });
        const trajectoryStore = new TrajectoryStore();
        const assembler = new ContextAssembler();
        const compiler = new PayloadCompiler();

        const r0 = await assembler.assembleWithHost({
            agent: mainAgent,
            connectionId: baseConn.id,
            tools,
            presetFiles: preset.files,
            promptTriggerContext: { kind: 'main', action: 'normal' },
            trajectoryStore,
            hostBridge: bridge,
            target: { messageId: 1, swipeId: 0 },
            userInput: '推开酒馆的木门，环顾四周。',
            macroOverrides: { lastMessageId: '1' },
        });
        expect(r0.layer2Messages).toHaveLength(1);
        expect(r0.floatingTailMessages).toHaveLength(3);

        const inFlightR1: CanonicalMessage[] = [
            ...r0.layer2Messages,
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: 'r1_read',
                        name: 'read_file',
                        arguments: '{"path":"/preset/protocol.md"}',
                        thoughtSignature: 'skip_thought_signature_validator',
                    },
                ],
            },
            {
                role: 'tool',
                toolCallId: 'r1_read',
                toolName: 'read_file',
                content: preset.files['protocol.md'],
            },
        ];

        const r1 = await assembler.assembleWithHost({
            agent: mainAgent,
            connectionId: baseConn.id,
            tools,
            presetFiles: preset.files,
            promptTriggerContext: { kind: 'main', action: 'normal' },
            trajectoryStore,
            hostBridge: bridge,
            target: { messageId: 1, swipeId: 0 },
            inFlightMessages: inFlightR1,
            macroOverrides: { lastMessageId: '1' },
        });

        // Verify r1_read tool result sits BEFORE floating_tail style rules and tail_sync_tool_shell
        const r1Msgs = r1.request.messages;
        const readToolIdx = r1Msgs.findIndex((m) => m.role === 'tool' && m.toolCallId === 'r1_read');
        const floatingStyleIdx = r1Msgs.findIndex(
            (m) => m.role === 'system' && m.content === 'Always obey formatting and perspective constraints.',
        );
        const tailSyncIdx = r1Msgs.findIndex((m) => m.role === 'tool' && m.toolCallId === 'call_sync_turn_1');
        expect(readToolIdx).toBeGreaterThan(0);
        expect(floatingStyleIdx).toBe(readToolIdx + 1);
        expect(tailSyncIdx).toBe(r1Msgs.length - 1);
        expect(readToolIdx).toBeLessThan(floatingStyleIdx);

        const allowed = r1.request.tools.map((t) => t.name).filter((n) => n !== FINISH_TURN_TOOL_NAME);

        // Compile across Gemini, OpenAI, and Anthropic on Round 1
        const g1 = compiler.compile(
            { ...r1.request, toolChoice: { mode: 'required', allowedToolNames: allowed } },
            normalizeConnection({ ...baseConn, providerFormat: 'gemini', model: 'gemini-2.5-pro' }),
        );
        const gContents = g1.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        expect(gContents[0].role).toBe('user');
        expect(gContents[gContents.length - 2].role).toBe('model');
        expect(gContents[gContents.length - 1].role).toBe('user');
        expect((g1.body.toolConfig as { functionCallingConfig: { mode: string } }).functionCallingConfig.mode).toBe('ANY');

        const o1 = compiler.compile(
            { ...r1.request, toolChoice: { mode: 'required', allowedToolNames: allowed } },
            normalizeConnection({ ...baseConn, providerFormat: 'openai', model: 'gpt-4.1' }),
        );
        expect(o1.body.tool_choice).toBe('required');
        const oMsgs = o1.body.messages as Array<{ role: string; tool_call_id?: string }>;
        expect(oMsgs[oMsgs.length - 1].tool_call_id).toBe('call_sync_turn_1');

        const a1 = compiler.compile(
            { ...r1.request, toolChoice: { mode: 'required', allowedToolNames: allowed } },
            normalizeConnection({ ...baseConn, providerFormat: 'anthropic', model: 'claude-sonnet-4-20250514' }),
        );
        expect((a1.body.tool_choice as { type: string }).type).toBe('any');
        const aMsgs = a1.body.messages as Array<{ role: string }>;
        expect(aMsgs[0].role).toBe('user');
        expect(aMsgs[aMsgs.length - 2].role).toBe('assistant');
        expect(aMsgs[aMsgs.length - 1].role).toBe('user');
    });
});
