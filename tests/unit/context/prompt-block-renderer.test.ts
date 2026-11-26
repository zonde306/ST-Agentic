import { describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@/core/bridge';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    exportPreset,
    importPreset,
    normalizeAgentProfile,
    normalizeConnection,
    normalizePromptBlock,
} from '@/core/config';
import {
    ContextAssembler,
    TrajectoryStore,
    prerenderPromptBlocks,
    renderPromptBlock,
    renderPromptBlockSync,
    renderPromptBlocks,
    validateCustomPromptBlock,
} from '@/core/context';
import type { PromptBlock } from '@/core/types';
import { MemoryHostBridge } from '../../mocks';

function createEjsMockBridge(
    evalFn: (text: string, vars: Record<string, unknown>) => Promise<string> | string,
    macros: Record<string, string> = {},
): HostBridge {
    const bridge = new MemoryHostBridge({
        identity: {
            charName: macros.char ?? 'Assistant',
            userName: macros.user ?? 'User',
        },
        ejsEvaluator: evalFn,
    });
    return bridge;
}

describe('prompt-block-renderer & config normalization', () => {
    it('evaluates standard prompt blocks with macros + optional EJS and skips empty results', async () => {
        const evalSpy = vi.fn(async (text: string, vars: Record<string, unknown>) =>
            text.replace(/<%-\s*mood\s*%>/g, String(vars.mood ?? '')),
        );
        const bridge = createEjsMockBridge(evalSpy, { char: 'Aria' });

        const block: PromptBlock = {
            id: 'std_1',
            name: 'Standard',
            role: 'system',
            placement: 'prefix',
            content: 'Character: {{char}}, Mood: <%- mood %>',
            enabled: true,
        };

        const msgs = await renderPromptBlock(block, {
            hostBridge: bridge,
            vars: { mood: 'calm' },
        });
        expect(msgs).toEqual([{ role: 'system', content: 'Character: Aria, Mood: calm' }]);
        expect(evalSpy).toHaveBeenCalledTimes(1);

        const emptyBlock: PromptBlock = {
            ...block,
            id: 'std_empty',
            content: '<%- mood %>',
        };
        const skipped = await renderPromptBlock(emptyBlock, {
            hostBridge: bridge,
            vars: { mood: '   ' },
        });
        expect(skipped).toEqual([]);
    });

    it('renders Track A custom JSON blocks safely even when macros/EJS contain quotes and newlines', async () => {
        const evalSpy = vi.fn(async (text: string, vars: Record<string, unknown>) =>
            text.replace(/<%-\s*note\s*%>/g, String(vars.note ?? '')),
        );
        const bridge = createEjsMockBridge(evalSpy, {
            char: 'Alice "The Great"\nSecond Line',
        });

        const block: PromptBlock = {
            id: 'init.tool/demo',
            name: 'Initial Tool Context',
            role: 'custom',
            placement: 'prefix',
            enabled: true,
            content: JSON.stringify([
                {
                    role: 'user',
                    content: 'Read profile for {{char}} (note: <%- note %>)',
                },
                {
                    role: 'model',
                    content: '',
                    reasoning_content: 'Checking character sheet first.',
                    tool_calls: [
                        {
                            type: 'function',
                            function: {
                                name: 'read_file',
                                arguments: JSON.stringify({
                                    z_note: '<%- note %>',
                                    a_path: '/character/{{char}}.md',
                                }),
                            },
                            extra_content: {
                                google: {
                                    thoughtSignature: 'sig_abc_123',
                                },
                            },
                            vendor_tc_flag: true,
                        },
                    ],
                    custom_msg_meta: { b: 2, a: 1 },
                },
                {
                    role: 'tool',
                    content: { ok: true, char: '{{char}}' },
                },
            ]),
        };

        const firstRun = await renderPromptBlock(block, {
            hostBridge: bridge,
            vars: { note: 'Line "A"\nLine "B"' },
        });
        const secondRun = await renderPromptBlock(block, {
            hostBridge: bridge,
            vars: { note: 'Line "A"\nLine "B"' },
        });

        expect(firstRun).toEqual(secondRun);
        expect(firstRun).toHaveLength(3);

        // User message
        expect(firstRun[0]).toEqual({
            role: 'user',
            content: 'Read profile for Alice "The Great"\nSecond Line (note: Line "A"\nLine "B")',
        });

        // Assistant ('model' normalized to 'assistant') with deterministic tool_call_id & canonical arguments
        const assistantMsg = firstRun[1];
        expect(assistantMsg.role).toBe('assistant');
        expect(assistantMsg.reasoningContent).toBe('Checking character sheet first.');
        expect(assistantMsg.toolCalls).toHaveLength(1);
        const tc = assistantMsg.toolCalls![0];
        expect(tc.id).toBe('call_init_tool_demo_1_0');
        expect(tc.name).toBe('read_file');
        expect(tc.thoughtSignature).toBe('sig_abc_123');
        expect(tc.extraFields).toEqual({ vendor_tc_flag: true });
        // Canonical key ordering in arguments & quote/newline safe re-serialization
        expect(tc.arguments).toBe(
            '{"a_path":"/character/Alice \\"The Great\\"\\nSecond Line.md","z_note":"Line \\"A\\"\\nLine \\"B\\""}',
        );
        expect(JSON.parse(tc.arguments)).toEqual({
            a_path: '/character/Alice "The Great"\nSecond Line.md',
            z_note: 'Line "A"\nLine "B"',
        });
        expect(assistantMsg.extraFields).toEqual({ custom_msg_meta: { a: 1, b: 2 } });
        expect(Object.keys(assistantMsg.extraFields!.custom_msg_meta as Record<string, unknown>)).toEqual([
            'a',
            'b',
        ]);

        // Tool message auto-paired against preceding assistant tool_call & object content canonicalStringify'd
        const toolMsg = firstRun[2];
        expect(toolMsg.role).toBe('tool');
        expect(toolMsg.toolCallId).toBe('call_init_tool_demo_1_0');
        expect(toolMsg.toolName).toBe('read_file');
        expect(toolMsg.content).toBe(
            '{"char":"Alice \\"The Great\\"\\nSecond Line","ok":true}',
        );
    });

    it('renders Track B outer EJS template with json() helper and skips when output is empty', async () => {
        const evalFn = async (text: string, vars: Record<string, unknown>): Promise<string> => {
            const json = vars.json as (v: unknown) => string;
            if (text.includes('if (enabled)')) {
                if (!vars.enabled) {
                    return '   \n  ';
                }
                return JSON.stringify([
                    {
                        role: 'assistant',
                        content: JSON.parse(json(vars.prefillText)) as string,
                        partial: true,
                    },
                ]);
            }
            return text;
        };
        const bridge = createEjsMockBridge(evalFn, { user: 'Bob' });

        const trackBBlock: PromptBlock = {
            id: 'prefill_ejs',
            name: 'Conditional Prefill',
            role: 'custom',
            placement: 'tail',
            enabled: true,
            content: '<% if (enabled) { %>{"role":"assistant","content":<%- json(prefillText) %>,"partial":true}<% } %>',
        };

        // Condition false -> empty output -> skipped cleanly
        const skipped = await renderPromptBlock(trackBBlock, {
            hostBridge: bridge,
            vars: { enabled: false, prefillText: 'Hello {{user}}' },
        });
        expect(skipped).toEqual([]);

        // Condition true -> JSON parsed + macros applied on string leaves + extraFields preserved
        const rendered = await renderPromptBlock(trackBBlock, {
            hostBridge: bridge,
            vars: { enabled: true, prefillText: 'Hello "quoted" {{user}}\nStart:' },
        });
        expect(rendered).toEqual([
            {
                role: 'assistant',
                content: 'Hello "quoted" Bob\nStart:',
                extraFields: { partial: true },
            },
        ]);

        // Sync renderer skips Track B cleanly
        expect(renderPromptBlockSync(trackBBlock, { hostBridge: bridge })).toEqual([]);
    });

    it('filters prototype-pollution keys and disallows nested custom role', async () => {
        const rawJson = `{
            "role": "assistant",
            "content": "Prefill",
            "partial": true,
            "__proto__": { "polluted": true },
            "constructor": { "bad": 1 },
            "prototype": { "bad": 2 },
            "nested": { "safe": 1, "__proto__": { "inner": true }, "constructor": "nope" }
        }`;

        const msgs = await renderPromptBlock({
            id: 'proto_test',
            name: 'Proto Test',
            role: 'custom',
            placement: 'tail',
            enabled: true,
            content: rawJson,
        });

        expect(msgs).toHaveLength(1);
        expect(msgs[0].extraFields).toEqual({
            nested: { safe: 1 },
            partial: true,
        });
        expect(Object.prototype.hasOwnProperty.call(msgs[0].extraFields, '__proto__')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(msgs[0].extraFields, 'constructor')).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(msgs[0].extraFields, 'prototype')).toBe(false);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();

        // Nested role: 'custom' is ignored
        const nestedCustom = await renderPromptBlock({
            id: 'bad_role',
            name: 'Nested Custom',
            role: 'custom',
            placement: 'prefix',
            enabled: true,
            content: JSON.stringify([{ role: 'custom', content: 'nope' }, { role: 'user', content: 'ok' }]),
        });
        expect(nestedCustom).toEqual([{ role: 'user', content: 'ok' }]);

        // Empty array skips
        const emptyArr = await renderPromptBlock({
            id: 'empty_arr',
            name: 'Empty Array',
            role: 'custom',
            placement: 'prefix',
            enabled: true,
            content: '[]',
        });
        expect(emptyArr).toEqual([]);
    });

    it('auto-pairs tool messages across consecutive blocks in renderPromptBlocks', async () => {
        const blocks: PromptBlock[] = [
            {
                id: 'b_call',
                name: 'Call',
                role: 'custom',
                placement: 'prefix',
                enabled: true,
                content: JSON.stringify({
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        { name: 'read_file', arguments: { path: '/a.md' } },
                        { name: 'search_files', arguments: { query: 'hero' } },
                    ],
                }),
            },
            {
                id: 'b_resp',
                name: 'Resp',
                role: 'custom',
                placement: 'prefix',
                enabled: true,
                content: JSON.stringify([
                    { role: 'tool', content: 'file A' },
                    { role: 'tool', content: 'search result' },
                ]),
            },
        ];

        const msgs = await renderPromptBlocks(blocks);
        expect(msgs).toHaveLength(3);
        expect(msgs[0].toolCalls?.map((tc) => tc.id)).toEqual([
            'call_b_call_0_0',
            'call_b_call_0_1',
        ]);
        expect(msgs[1]).toMatchObject({
            role: 'tool',
            toolCallId: 'call_b_call_0_0',
            toolName: 'read_file',
            content: 'file A',
        });
        expect(msgs[2]).toMatchObject({
            role: 'tool',
            toolCallId: 'call_b_call_0_1',
            toolName: 'search_files',
            content: 'search result',
        });
    });

    it('validates custom prompt blocks accurately for JSON, EJS template, and error/warning cases', () => {
        // Valid paired array
        const ok = validateCustomPromptBlock(
            JSON.stringify([
                { role: 'assistant', content: '', tool_calls: [{ name: 'read_file', arguments: '{"path":"/a"}' }] },
                { role: 'tool', content: 'done' },
            ]),
        );
        expect(ok.valid).toBe(true);
        expect(ok.mode).toBe('json');
        expect(ok.messageCount).toBe(2);
        expect(ok.errors).toEqual([]);
        expect(ok.warnings).toEqual([]);

        // Unpaired tool_calls warning
        const unpaired = validateCustomPromptBlock(
            JSON.stringify([
                { role: 'assistant', content: '', tool_calls: [{ name: 'read_file', arguments: '{}' }] },
            ]),
        );
        expect(unpaired.valid).toBe(true);
        expect(unpaired.warnings.length).toBeGreaterThan(0);

        // Nested custom role error
        const nestedCustom = validateCustomPromptBlock(JSON.stringify({ role: 'custom', content: 'x' }));
        expect(nestedCustom.valid).toBe(false);
        expect(nestedCustom.mode).toBe('invalid');

        // Outer EJS balanced template
        const ejsOk = validateCustomPromptBlock(
            '<% if (flag) { %>{"role":"assistant","content":"hi","partial":true}<% } %>',
        );
        expect(ejsOk.valid).toBe(true);
        expect(ejsOk.mode).toBe('ejs_template');
        expect(ejsOk.warnings.length).toBeGreaterThan(0);

        // Unbalanced EJS tags
        const ejsBad = validateCustomPromptBlock('<% if (flag) { {"role":"user"}');
        expect(ejsBad.valid).toBe(false);
        expect(ejsBad.mode).toBe('invalid');

        // Plain invalid JSON
        const syntaxBad = validateCustomPromptBlock('{ bad json');
        expect(syntaxBad.valid).toBe(false);
        expect(syntaxBad.mode).toBe('invalid');
    });

    it('ContextAssembler.assembleWithHost freezes prefix EJS evaluation once and evaluates tail every turn', async () => {
        const evalSpy = vi.fn(async (text: string, vars: Record<string, unknown>) =>
            text.replace(/<%-\s*turn\s*%>/g, String(vars.turn ?? '')),
        );
        const bridge = createEjsMockBridge(evalSpy, { char: 'Luna' });

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System for {{char}}',
                    enabled: true,
                },
                {
                    id: 'prefix_custom',
                    name: 'Prefix Tool Demo',
                    role: 'custom',
                    placement: 'prefix',
                    enabled: true,
                    content: JSON.stringify([
                        { role: 'user', content: 'Init turn <%- turn %>' },
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [{ name: 'read_file', arguments: { path: '/character/main.md' } }],
                        },
                        { role: 'tool', content: 'ok' },
                    ]),
                },
                {
                    id: 'tail_ejs',
                    name: 'Tail Prefill',
                    role: 'custom',
                    placement: 'tail',
                    enabled: true,
                    content: JSON.stringify({
                        role: 'assistant',
                        content: 'Turn <%- turn %>:',
                        partial: true,
                    }),
                },
            ],
        });

        const store = new TrajectoryStore();
        const assembler = new ContextAssembler();

        // Turn 1: compiles Layer 0 (prefix evaluated once) and Layer 2 (tail evaluated for turn 1)
        const turn1 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            userInput: 'Hello 1',
            vars: { turn: 1 },
        });
        expect(turn1.layer0Messages.some((m) => m.content === 'Init turn 1')).toBe(true);
        expect(turn1.layer0Messages.some((m) => m.role === 'tool' && m.toolName === 'read_file')).toBe(true);
        expect(turn1.floatingTailMessages[turn1.floatingTailMessages.length - 1]).toEqual({
            role: 'assistant',
            content: 'Turn 1:',
            extraFields: { partial: true },
        });
        expect(turn1.request.messages[turn1.request.messages.length - 1]).toEqual({
            role: 'assistant',
            content: 'Turn 1:',
            extraFields: { partial: true },
        });
        const callsAfterTurn1 = evalSpy.mock.calls.length;
        expect(callsAfterTurn1).toBe(2); // 1 for prefix_custom, 1 for tail_ejs

        // Turn 2: Layer 0 is frozen -> prefix_custom MUST NOT be re-evaluated; tail_ejs IS re-evaluated
        const turn2 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            userInput: 'Hello 2',
            vars: { turn: 2 },
        });
        expect(turn2.layer0Messages).toEqual(turn1.layer0Messages);
        expect(turn2.floatingTailMessages[turn2.floatingTailMessages.length - 1]).toEqual({
            role: 'assistant',
            content: 'Turn 2:',
            extraFields: { partial: true },
        });
        expect(evalSpy.mock.calls.length).toBe(callsAfterTurn1 + 1); // Only tail_ejs ran!

        // prerenderPromptBlocks map passed directly into sync assemble() also works
        const manualMap = await prerenderPromptBlocks(agent.promptBlocks, {
            hostBridge: bridge,
            vars: { turn: 99 },
        });
        const manualAssembled = assembler.assemble({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            forceRecompilePrefix: true,
            preRenderedBlocks: manualMap,
            userInput: 'Manual',
        });
        expect(manualAssembled.layer0Messages.some((m) => m.content === 'Init turn 99')).toBe(true);
        expect(
            manualAssembled.floatingTailMessages[manualAssembled.floatingTailMessages.length - 1].content,
        ).toBe('Turn 99:');
    });

    it('normalizes strictToolLoop, roundMaxRetries, custom role, and preserves export/import compatibility', () => {
        const defConn = createDefaultConnection();
        expect(defConn.strictToolLoop).toBe(false);
        expect(defConn.roundMaxRetries).toBe(2);

        expect(normalizeConnection({ roundMaxRetries: -5 }).roundMaxRetries).toBe(0);
        expect(normalizeConnection({ roundMaxRetries: 99 }).roundMaxRetries).toBe(10);
        expect(normalizeConnection({ roundMaxRetries: 3.9 }).roundMaxRetries).toBe(3);
        expect(normalizeConnection({ strictToolLoop: true }).strictToolLoop).toBe(true);
        // Legacy connection without new fields defaults cleanly
        const legacyConn = normalizeConnection({ id: 'old', model: 'gpt-4o' });
        expect(legacyConn.strictToolLoop).toBe(false);
        expect(legacyConn.roundMaxRetries).toBe(2);

        const customBlock = normalizePromptBlock({
            id: 'c1',
            name: 'Custom JSON',
            role: 'custom',
            placement: 'prefix',
            content: '{"role":"assistant","content":"hi"}',
        });
        expect(customBlock.role).toBe('custom');

        expect(normalizeAgentProfile({ id: 'a1' }).strictToolLoop).toBe('inherit');
        expect(normalizeAgentProfile({ id: 'a2', strictToolLoop: 'on' }).strictToolLoop).toBe('on');
        expect(normalizeAgentProfile({ id: 'a3', strictToolLoop: 'off' }).strictToolLoop).toBe('off');
        expect(normalizeAgentProfile({ id: 'a4', strictToolLoop: 'bogus' }).strictToolLoop).toBe('inherit');

        const preset = createDefaultPreset({
            agents: {
                main: createDefaultMainAgent({
                    strictToolLoop: 'on',
                    promptBlocks: [customBlock],
                }),
            },
        });
        const exported = exportPreset(preset, {
            includeConnection: createDefaultConnection({
                apiKey: 'secret',
                strictToolLoop: true,
                roundMaxRetries: 4,
            }),
        });
        const imported = importPreset(exported);
        expect(imported.presets[0].agents.main.strictToolLoop).toBe('on');
        expect(imported.presets[0].agents.main.promptBlocks[0].role).toBe('custom');
        expect(imported.connection?.strictToolLoop).toBe(true);
        expect(imported.connection?.roundMaxRetries).toBe(4);
        expect(imported.connection?.apiKey).toBe('');
    });
});
