import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '@/core/bridge';
import type { ApiConnection, CanonicalMessage, CanonicalToolSchema } from '@/core/types';
import { PayloadCompiler, postProcessCanonicalMessages } from '@/core/llm';

function makeConnection(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return {
        id: 'conn-1',
        name: 'Test Connection',
        providerFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test-123',
        model: 'gpt-4o',
        contextSize: 64000,
        maxTokens: 4096,
        temperature: 0.7,
        topK: 0,
        topP: 0.95,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: false,
        includeHeaders: {},
        includeBody: {},
        excludeBody: {},
        maxConcurrency: 2,
        cachePolicy: 'none',
        ...overrides,
    };
}

const SAMPLE_TOOLS: CanonicalToolSchema[] = [
    {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                content: { type: 'string' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'finish_turn',
        description: 'Finish the turn',
        parameters: {
            type: 'object',
            properties: { step_brief: { type: 'string' } },
            required: ['step_brief'],
        },
    },
];

describe('PayloadCompiler — 3-provider toolChoice compilation', () => {
    const compiler = new PayloadCompiler();

    const baseMessages: CanonicalMessage[] = [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Inspect /notes.md' },
    ];

    describe('OpenAI', () => {
        const conn = makeConnection({ providerFormat: 'openai' });

        it('compiles auto and none modes without leaking allowedToolNames', () => {
            const autoOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'auto', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(autoOut.body.tool_choice).toBe('auto');

            const noneOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'none', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(noneOut.body.tool_choice).toBe('none');
        });

        it('compiles required mode for none/empty/unknown/single/multi allowedToolNames', () => {
            const reqNoList = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required' },
                },
                conn,
            );
            expect(reqNoList.body.tool_choice).toBe('required');

            const reqEmpty = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: [] },
                },
                conn,
            );
            expect(reqEmpty.body.tool_choice).toBe('required');

            const reqUnknown = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: ['missing_tool'] },
                },
                conn,
            );
            expect(reqUnknown.body.tool_choice).toBe('required');

            const reqSingle = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: {
                        mode: 'required',
                        allowedToolNames: ['missing_tool', 'read_file', 'read_file'],
                    },
                },
                conn,
            );
            expect(reqSingle.body.tool_choice).toEqual({
                type: 'function',
                function: { name: 'read_file' },
            });

            const reqMulti = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: {
                        mode: 'required',
                        allowedToolNames: ['write_file', 'read_file'],
                    },
                },
                conn,
            );
            expect(reqMulti.body.tool_choice).toBe('required');
        });
    });

    describe('Anthropic', () => {
        const conn = makeConnection({
            providerFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4-5',
        });

        it('compiles auto and none modes cleanly', () => {
            const autoOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'auto', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(autoOut.body.tool_choice).toEqual({ type: 'auto' });

            const noneOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'none', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(noneOut.body.tool_choice).toEqual({ type: 'none' });
        });

        it('compiles required mode for none/empty/unknown/single/multi allowedToolNames', () => {
            const reqNoList = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required' },
                },
                conn,
            );
            expect(reqNoList.body.tool_choice).toEqual({ type: 'any' });

            const reqEmpty = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: [] },
                },
                conn,
            );
            expect(reqEmpty.body.tool_choice).toEqual({ type: 'any' });

            const reqUnknown = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: ['does_not_exist'] },
                },
                conn,
            );
            expect(reqUnknown.body.tool_choice).toEqual({ type: 'any' });

            const reqSingle = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: {
                        mode: 'required',
                        allowedToolNames: ['finish_turn', 'unknown_tool', 'finish_turn'],
                    },
                },
                conn,
            );
            expect(reqSingle.body.tool_choice).toEqual({ type: 'tool', name: 'finish_turn' });

            const reqMulti = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: {
                        mode: 'required',
                        allowedToolNames: ['read_file', 'write_file'],
                    },
                },
                conn,
            );
            expect(reqMulti.body.tool_choice).toEqual({ type: 'any' });
        });
    });

    describe('Gemini', () => {
        const conn = makeConnection({
            providerFormat: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            model: 'gemini-2.5-pro',
        });

        it('never emits allowedFunctionNames for AUTO or NONE modes', () => {
            const autoOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'auto', allowedToolNames: ['read_file', 'write_file'] },
                },
                conn,
            );
            expect(autoOut.body.toolConfig).toEqual({
                functionCallingConfig: { mode: 'AUTO' },
            });
            expect(
                Object.prototype.hasOwnProperty.call(
                    (autoOut.body.toolConfig as { functionCallingConfig: Record<string, unknown> })
                        .functionCallingConfig,
                    'allowedFunctionNames',
                ),
            ).toBe(false);

            const noneOut = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'none', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(noneOut.body.toolConfig).toEqual({
                functionCallingConfig: { mode: 'NONE' },
            });
            expect(
                Object.prototype.hasOwnProperty.call(
                    (noneOut.body.toolConfig as { functionCallingConfig: Record<string, unknown> })
                        .functionCallingConfig,
                    'allowedFunctionNames',
                ),
            ).toBe(false);
        });

        it('compiles required mode as ANY with deduplicated ordered intersection of request.tools', () => {
            const reqNoList = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required' },
                },
                conn,
            );
            expect(reqNoList.body.toolConfig).toEqual({
                functionCallingConfig: { mode: 'ANY' },
            });

            const reqEmpty = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: [] },
                },
                conn,
            );
            expect(reqEmpty.body.toolConfig).toEqual({
                functionCallingConfig: { mode: 'ANY' },
            });

            const reqUnknown = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: ['ghost_tool'] },
                },
                conn,
            );
            expect(reqUnknown.body.toolConfig).toEqual({
                functionCallingConfig: { mode: 'ANY' },
            });

            const reqSingle = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: { mode: 'required', allowedToolNames: ['read_file'] },
                },
                conn,
            );
            expect(reqSingle.body.toolConfig).toEqual({
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: ['read_file'],
                },
            });

            const reqMulti = compiler.compile(
                {
                    connectionId: conn.id,
                    messages: baseMessages,
                    tools: SAMPLE_TOOLS,
                    toolChoice: {
                        mode: 'required',
                        allowedToolNames: [
                            'write_file',
                            'unknown_a',
                            'read_file',
                            'write_file',
                            'unknown_b',
                        ],
                    },
                },
                conn,
            );
            expect(reqMulti.body.toolConfig).toEqual({
                functionCallingConfig: {
                    mode: 'ANY',
                    allowedFunctionNames: ['write_file', 'read_file'],
                },
            });
        });
    });

    it('omits tool_choice and toolConfig across all providers when request.tools is empty', () => {
        const req: LLMRequest = {
            connectionId: 'conn-empty',
            messages: baseMessages,
            tools: [],
            toolChoice: { mode: 'required', allowedToolNames: ['read_file'] },
        };

        const openaiOut = compiler.compile(req, makeConnection({ providerFormat: 'openai' }));
        expect(openaiOut.body.tool_choice).toBeUndefined();

        const anthropicOut = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                model: 'claude-sonnet-4-5',
            }),
        );
        expect(anthropicOut.body.tool_choice).toBeUndefined();

        const geminiOut = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
            }),
        );
        expect(geminiOut.body.toolConfig).toBeUndefined();
    });

    it('lets connection.includeBody override compiled toolChoice on all three providers cleanly', () => {
        const req: LLMRequest = {
            connectionId: 'conn-override',
            messages: baseMessages,
            tools: SAMPLE_TOOLS,
            toolChoice: { mode: 'required', allowedToolNames: ['read_file'] },
        };

        const openaiOut = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'openai',
                includeBody: { tool_choice: 'none' },
            }),
        );
        expect(openaiOut.body.tool_choice).toBe('none');

        const anthropicOut = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                model: 'claude-sonnet-4-5',
                includeBody: { tool_choice: { type: 'auto' } },
            }),
        );
        expect(anthropicOut.body.tool_choice).toEqual({ type: 'auto' });

        const geminiAutoOverride = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                includeBody: { toolConfig: { functionCallingConfig: { mode: 'AUTO' } } },
            }),
        );
        expect(geminiAutoOverride.body.toolConfig).toEqual({
            functionCallingConfig: { mode: 'AUTO' },
        });

        const geminiSubsetOverride = compiler.compile(
            req,
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                includeBody: {
                    toolConfig: {
                        functionCallingConfig: { allowedFunctionNames: ['write_file'] },
                    },
                },
            }),
        );
        expect(geminiSubsetOverride.body.toolConfig).toEqual({
            functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: ['write_file'],
            },
        });
    });
});

describe('PayloadCompiler — extraFields passthrough, sanitization & anti-merge', () => {
    const compiler = new PayloadCompiler();

    it('passes through Kimi partial:true, DeepSeek prefix:true, and toolCall extraFields on OpenAI', () => {
        const inputExtra: Record<string, unknown> = {
            partial: true,
            vendor_meta: { z: 2, a: 1 },
        };
        const toolExtra: Record<string, unknown> = {
            extra_content: { google: { thought_signature: 'sig-xyz' } },
        };

        const messages: CanonicalMessage[] = [
            { role: 'user', content: 'Continue story' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'read_file',
                        arguments: '{"path":"/story.md"}',
                        extraFields: toolExtra,
                    },
                ],
                extraFields: { prefix: true },
            },
            { role: 'tool', toolCallId: 'call_1', content: 'Chapter 1' },
            { role: 'assistant', content: 'Once upon a time', extraFields: inputExtra },
        ];

        const out = compiler.compile(
            { connectionId: 'openai-1', messages, tools: SAMPLE_TOOLS },
            makeConnection({ providerFormat: 'openai', cachePolicy: 'none' }),
        );

        // Mutating original objects after compile must not affect compiled payload (deep clone)
        (inputExtra.vendor_meta as Record<string, unknown>).a = 999;
        ((toolExtra.extra_content as Record<string, unknown>).google as Record<string, unknown>).thought_signature =
            'mutated';

        const compiledMsgs = out.body.messages as Array<Record<string, unknown>>;
        expect(compiledMsgs).toHaveLength(4);
        expect(compiledMsgs[1].prefix).toBe(true);
        const toolCalls = compiledMsgs[1].tool_calls as Array<Record<string, unknown>>;
        expect(toolCalls[0].extra_content).toEqual({ google: { thought_signature: 'sig-xyz' } });

        expect(compiledMsgs[3].partial).toBe(true);
        expect(compiledMsgs[3].vendor_meta).toEqual({ a: 1, z: 2 });
        expect(Object.keys(compiledMsgs[3].vendor_meta as Record<string, unknown>)).toEqual(['a', 'z']);
    });

    it('passes through message and toolCall extraFields on Anthropic and Gemini', () => {
        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'System rule', extraFields: { custom_sys: 'v1' } },
            { role: 'user', content: 'Run tool' },
            {
                role: 'assistant',
                content: 'Calling read_file',
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'read_file',
                        arguments: '{"path":"/a.md"}',
                        thoughtSignature: 'sig-1',
                        extraFields: { tc_tag: 'alpha' },
                    },
                ],
                extraFields: { assistant_flag: true },
            },
            { role: 'tool', toolCallId: 'call_1', toolName: 'read_file', content: '{"ok":true}' },
            { role: 'assistant', content: 'Prefill start', extraFields: { partial: true } },
        ];

        const anthropicOut = compiler.compile(
            { connectionId: 'anth-1', messages, tools: SAMPLE_TOOLS },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                model: 'claude-sonnet-4-5',
            }),
        );
        const sysBlocks = anthropicOut.body.system as Array<Record<string, unknown>>;
        expect(sysBlocks[0].custom_sys).toBe('v1');

        const anthMsgs = anthropicOut.body.messages as Array<Record<string, unknown>>;
        expect(anthMsgs).toHaveLength(4);
        expect(anthMsgs[1].assistant_flag).toBe(true);
        const anthToolUse = (anthMsgs[1].content as Array<Record<string, unknown>>).find(
            (b) => b.type === 'tool_use',
        );
        expect(anthToolUse?.tc_tag).toBe('alpha');
        expect(anthMsgs[3].partial).toBe(true);

        const geminiOut = compiler.compile(
            { connectionId: 'gem-1', messages, tools: SAMPLE_TOOLS },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
            }),
        );
        const gemSys = (geminiOut.body.systemInstruction as { parts: Array<Record<string, unknown>> }).parts;
        expect(gemSys[0].custom_sys).toBe('v1');

        const gemContents = geminiOut.body.contents as Array<Record<string, unknown>>;
        expect(gemContents).toHaveLength(4);
        expect(gemContents[1].assistant_flag).toBe(true);
        const gemParts = gemContents[1].parts as Array<Record<string, unknown>>;
        const gemFnPart = gemParts.find((p) => p.functionCall !== undefined);
        expect(gemFnPart?.thoughtSignature).toBe('sig-1');
        expect((gemFnPart?.functionCall as Record<string, unknown>).tc_tag).toBe('alpha');
        expect(gemContents[3].partial).toBe(true);
    });

    it('strips prototype-pollution keys and preserves canonical key ordering in extraFields', () => {
        const maliciousExtra = JSON.parse(
            '{"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2},"z_field":1,"a_field":{"__proto__":{"deep":true},"y":2,"b":1}}',
        ) as Record<string, unknown>;
        const maliciousToolExtra = JSON.parse(
            '{"__proto__":{"tcPolluted":true},"prototype":{"x":1},"m_key":3,"c_key":4}',
        ) as Record<string, unknown>;

        const messages: CanonicalMessage[] = [
            { role: 'user', content: 'Test safety' },
            {
                role: 'assistant',
                content: 'Safe output',
                toolCalls: [
                    {
                        id: 'call_safe',
                        name: 'read_file',
                        arguments: '{}',
                        extraFields: maliciousToolExtra,
                    },
                ],
                extraFields: maliciousExtra,
            },
        ];

        const outA = compiler.compile(
            { connectionId: 'safe-a', messages, tools: SAMPLE_TOOLS },
            makeConnection({ providerFormat: 'openai', cachePolicy: 'auto_prefix' }),
        );

        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect(({} as Record<string, unknown>).deep).toBeUndefined();
        expect(({} as Record<string, unknown>).tcPolluted).toBeUndefined();
        expect(outA.serializedBody).not.toContain('__proto__');
        expect(outA.serializedBody).not.toContain('polluted');
        expect(outA.serializedBody).not.toContain('constructor');
        expect(outA.serializedBody).not.toContain('prototype');

        const compiledMsg = (outA.body.messages as Array<Record<string, unknown>>)[1];
        expect(compiledMsg.a_field).toEqual({ b: 1, y: 2 });
        expect(compiledMsg.z_field).toBe(1);
        expect(Object.keys(compiledMsg.a_field as Record<string, unknown>)).toEqual(['b', 'y']);

        const compiledTc = (compiledMsg.tool_calls as Array<Record<string, unknown>>)[0];
        expect(compiledTc.c_key).toBe(4);
        expect(compiledTc.m_key).toBe(3);

        // Byte-identical serializedBody regardless of extraFields key insertion order
        const reorderedMessages: CanonicalMessage[] = [
            { role: 'user', content: 'Test safety' },
            {
                role: 'assistant',
                content: 'Safe output',
                toolCalls: [
                    {
                        id: 'call_safe',
                        name: 'read_file',
                        arguments: '{}',
                        extraFields: { c_key: 4, m_key: 3 },
                    },
                ],
                extraFields: { a_field: { b: 1, y: 2 }, z_field: 1 },
            },
        ];
        const outB = compiler.compile(
            { connectionId: 'safe-b', messages: reorderedMessages, tools: SAMPLE_TOOLS },
            makeConnection({ providerFormat: 'openai', cachePolicy: 'auto_prefix' }),
        );
        expect(outA.serializedBody).toBe(outB.serializedBody);
    });

    it('prevents merging messages with non-empty extraFields across merge, semi, and strict modes', () => {
        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'Sys 1' },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Draft part 1' },
            { role: 'assistant', content: 'Prefill tail', extraFields: { partial: true } },
            { role: 'assistant', content: 'After prefill' },
            { role: 'system', content: 'Mid sys with extra', extraFields: { vendor_hint: 'keep' } },
            { role: 'user', content: 'Normal user follow-up' },
        ];

        for (const mode of ['merge', 'semi', 'strict'] as const) {
            const processed = postProcessCanonicalMessages(messages, mode);
            const assistantMsgs = processed.messages.filter((m) => m.role === 'assistant');
            expect(assistantMsgs).toHaveLength(3);
            expect(assistantMsgs[0].content).toBe('Draft part 1');
            expect(assistantMsgs[0].extraFields).toBeUndefined();
            expect(assistantMsgs[1].content).toBe('Prefill tail');
            expect(assistantMsgs[1].extraFields).toEqual({ partial: true });
            expect(assistantMsgs[2].content).toBe('After prefill');
            expect(assistantMsgs[2].extraFields).toBeUndefined();

            if (mode === 'semi' || mode === 'strict') {
                // Mid-prompt system converted to user must NOT merge with subsequent user message
                const lastTwo = processed.messages.slice(-2);
                expect(lastTwo[0]).toEqual({
                    role: 'user',
                    content: 'Mid sys with extra',
                    extraFields: { vendor_hint: 'keep' },
                });
                expect(lastTwo[1]).toEqual({
                    role: 'user',
                    content: 'Normal user follow-up',
                });
            }
        }
    });

    it('prevents provider-level block merging in Anthropic and Gemini when prev or curr has extraFields', () => {
        const messages: CanonicalMessage[] = [
            { role: 'user', content: 'Start' },
            { role: 'assistant', content: 'Normal A' },
            { role: 'assistant', content: 'Prefill B', extraFields: { partial: true } },
            { role: 'assistant', content: 'Normal C' },
            { role: 'user', content: 'Normal U1' },
            { role: 'user', content: 'Normal U2' },
        ];

        const anthropicOut = compiler.compile(
            { connectionId: 'anth-anti-merge', messages, tools: [] },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                model: 'claude-sonnet-4-5',
                promptPostProcessing: 'none',
            }),
        );
        const anthMsgs = anthropicOut.body.messages as Array<Record<string, unknown>>;
        // [user(Start), assistant(Normal A), assistant(Prefill B, partial:true), assistant(Normal C), user(Normal U1 + Normal U2)]
        expect(anthMsgs).toHaveLength(5);
        expect(anthMsgs[1].role).toBe('assistant');
        expect(anthMsgs[1].partial).toBeUndefined();
        expect(anthMsgs[2].role).toBe('assistant');
        expect(anthMsgs[2].partial).toBe(true);
        expect(anthMsgs[3].role).toBe('assistant');
        expect(anthMsgs[3].partial).toBeUndefined();
        // Normal consecutive user messages without extraFields still merge
        expect(anthMsgs[4].role).toBe('user');
        expect(anthMsgs[4].content).toEqual([
            { type: 'text', text: 'Normal U1' },
            { type: 'text', text: 'Normal U2' },
        ]);

        const geminiOut = compiler.compile(
            { connectionId: 'gem-anti-merge', messages, tools: [] },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                promptPostProcessing: 'none',
            }),
        );
        const gemContents = geminiOut.body.contents as Array<Record<string, unknown>>;
        expect(gemContents).toHaveLength(5);
        expect(gemContents[1].role).toBe('model');
        expect(gemContents[1].partial).toBeUndefined();
        expect(gemContents[2].role).toBe('model');
        expect(gemContents[2].partial).toBe(true);
        expect(gemContents[3].role).toBe('model');
        expect(gemContents[3].partial).toBeUndefined();
        // Normal consecutive user messages without extraFields still merge parts
        expect(gemContents[4].role).toBe('user');
        expect(gemContents[4].parts).toEqual([{ text: 'Normal U1' }, { text: 'Normal U2' }]);
    });

    it('allows normal same-role merging when extraFields is empty or contains only forbidden keys', () => {
        const forbiddenOnly = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
        const processed = postProcessCanonicalMessages(
            [
                { role: 'user', content: 'A', extraFields: {} },
                { role: 'user', content: 'B', extraFields: forbiddenOnly },
            ],
            'merge',
        );
        expect(processed.messages).toHaveLength(1);
        expect(processed.messages[0]).toEqual({ role: 'user', content: 'A\n\nB' });
    });
});
