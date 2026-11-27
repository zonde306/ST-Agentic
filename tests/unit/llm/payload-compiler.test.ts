import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '@/core/bridge';
import type { ApiConnection, CanonicalMessage, CanonicalToolSchema } from '@/core/types';
import { buildModelsEndpointUrl, MAX_ANTHROPIC_CACHE_BREAKPOINTS, PayloadCompiler, sanitizeGeminiSchema } from '@/core/llm';

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
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        stream: true,
        includeHeaders: {},
        includeBody: {},
        excludeBody: {},
        maxConcurrency: 2,
        cachePolicy: 'auto_prefix',
        ...overrides,
    };
}

describe('PayloadCompiler', () => {
    const compiler = new PayloadCompiler();

    it('produces byte-identical serializedBody for auto_prefix regardless of key insertion order', () => {
        const toolA: CanonicalToolSchema = {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string', description: 'Path to read' },
                    lineStart: { type: 'number', description: 'Start line' },
                },
            },
        };
        const toolAReordered: CanonicalToolSchema = {
            parameters: {
                properties: {
                    lineStart: { description: 'Start line', type: 'number' },
                    path: { description: 'Path to read', type: 'string' },
                },
                required: ['path'],
                type: 'object',
            },
            description: 'Read a file',
            name: 'read_file',
        };

        const connA = makeConnection({
            includeBody: { extra: { z: 1, a: 2 } },
        });
        const connB = makeConnection({
            includeBody: { extra: { a: 2, z: 1 } },
        });

        const reqA: LLMRequest = {
            connectionId: connA.id,
            messages: [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            ],
            tools: [toolA],
        };
        const reqB: LLMRequest = {
            connectionId: connB.id,
            messages: [
                { content: 'System prompt', role: 'system' },
                { content: [{ text: 'Hello', type: 'text' }], role: 'user' },
            ],
            tools: [toolAReordered],
        };

        const outA = compiler.compile(reqA, connA);
        const outB = compiler.compile(reqB, connB);

        expect(outA.url).toBe('https://api.openai.com/v1/chat/completions');
        expect(outA.headers.Authorization).toBe('Bearer sk-test-123');
        expect(outA.serializedBody).toBe(outB.serializedBody);
        expect(outA.body.stream_options).toEqual({ include_usage: true });
    });

    it('merges includeHeaders/includeBody and deletes excludeBody keys safely', () => {
        const conn = makeConnection({
            includeHeaders: {
                authorization: 'CustomToken xyz',
                'X-Title': 'ST-Agentic',
            },
            includeBody: {
                reasoning: { effort: 'high', exclude: false },
                custom_flag: true,
            },
            excludeBody: {
                frequency_penalty: true,
                presence_penalty: null,
                reasoning: { exclude: true },
                temperature: false, // false must not delete
            },
        });

        const out = compiler.compile(
            {
                connectionId: conn.id,
                messages: [{ role: 'user', content: 'hi' }],
                tools: [],
                stream: false,
            },
            conn,
        );

        expect(out.headers.authorization).toBe('CustomToken xyz');
        expect(out.headers.Authorization).toBeUndefined();
        expect(out.headers['X-Title']).toBe('ST-Agentic');
        expect(out.body.frequency_penalty).toBeUndefined();
        expect(out.body.presence_penalty).toBeUndefined();
        expect(out.body.temperature).toBe(0.7);
        expect(out.body.custom_flag).toBe(true);
        expect(out.body.reasoning).toEqual({ effort: 'high' });
        expect(out.body.tools).toBeUndefined();
        expect(out.body.stream_options).toBeUndefined();
    });

    it('compiles Anthropic Messages payload with system extraction, tool_use/tool_result, and role merging', () => {
        const conn = makeConnection({
            providerFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-sonnet-4-5',
            topK: 40,
            cachePolicy: 'none',
        });

        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Inspect /a.md and /b.md' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'toolu_1', name: 'read_file', arguments: '{"path":"/a.md"}' },
                    { id: 'toolu_2', name: 'read_file', arguments: '{"path":"/b.md"}' },
                ],
            },
            { role: 'tool', toolCallId: 'toolu_1', content: 'Content A' },
            { role: 'tool', toolCallId: 'toolu_2', content: 'Content B' },
        ];

        const out = compiler.compile(
            {
                connectionId: conn.id,
                messages,
                tools: [
                    {
                        name: 'read_file',
                        description: 'Read VFS file',
                        parameters: { type: 'object', properties: { path: { type: 'string' } } },
                    },
                ],
                stream: true,
            },
            conn,
        );

        expect(out.url).toBe('https://api.anthropic.com/v1/messages');
        expect(out.headers['x-api-key']).toBe('sk-test-123');
        expect(out.headers['anthropic-version']).toBe('2023-06-01');

        expect(out.body.system).toEqual([
            { type: 'text', text: 'Rule 1' },
            { type: 'text', text: 'Rule 2' },
        ]);
        expect(out.body.tools).toEqual([
            {
                name: 'read_file',
                description: 'Read VFS file',
                input_schema: { properties: { path: { type: 'string' } }, type: 'object' },
            },
        ]);
        // Consecutive tool results must be merged into one user turn
        const compiledMsgs = out.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
        expect(compiledMsgs).toHaveLength(3);
        expect(compiledMsgs[0].role).toBe('user');
        expect(compiledMsgs[1].role).toBe('assistant');
        expect(compiledMsgs[1].content).toEqual([
            { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/a.md' } },
            { type: 'tool_use', id: 'toolu_2', name: 'read_file', input: { path: '/b.md' } },
        ]);
        expect(compiledMsgs[2].role).toBe('user');
        expect(compiledMsgs[2].content).toEqual([
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Content A' },
            { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Content B' },
        ]);
        expect(out.body.frequency_penalty).toBeUndefined();
        expect(out.body.presence_penalty).toBeUndefined();
        expect(out.body.top_k).toBe(40);
    });

    it('enforces max 4 cache_control breakpoints for anthropic_explicit policy', () => {
        const conn = makeConnection({
            providerFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1',
            cachePolicy: 'anthropic_explicit',
            maxCacheBreakpoints: 10, // Attempt to exceed provider limit 4
        });

        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'Layer 0 static' },
            { role: 'user', content: 'Turn 1' },
            { role: 'assistant', content: 'Reply 1' },
            { role: 'user', content: 'Turn 2' },
            { role: 'assistant', content: 'Reply 2' },
            { role: 'user', content: 'Turn 3' },
            { role: 'assistant', content: 'Reply 3' },
            { role: 'user', content: 'Turn 4' },
        ];

        const out = compiler.compile(
            {
                connectionId: conn.id,
                messages,
                tools: [
                    {
                        name: 'list_dir',
                        description: 'List dir',
                        parameters: { type: 'object', properties: {} },
                    },
                ],
                cacheBreakpoints: [0, 2, 4, 5, 6, 7],
            },
            conn,
        );

        expect(MAX_ANTHROPIC_CACHE_BREAKPOINTS).toBe(4);
        expect(out.cacheBreakpointsApplied).toBe(4);

        const serialized = JSON.stringify(out.body);
        const matches = serialized.match(/"cache_control"/g) ?? [];
        expect(matches).toHaveLength(4);

        // Layer 0 system anchor [0] must remain cached, plus the latest checkpoints [5, 6, 7]
        const system = out.body.system as Array<{ cache_control?: unknown }>;
        expect(system[0].cache_control).toEqual({ type: 'ephemeral' });

        const compiledMsgs = out.body.messages as Array<{ content: Array<{ cache_control?: unknown }> }>;
        expect(compiledMsgs[4].content[0].cache_control).toEqual({ type: 'ephemeral' }); // orig idx 5 -> msg idx 4
        expect(compiledMsgs[5].content[0].cache_control).toEqual({ type: 'ephemeral' }); // orig idx 6 -> msg idx 5
        expect(compiledMsgs[6].content[0].cache_control).toEqual({ type: 'ephemeral' }); // orig idx 7 -> msg idx 6
    });

    it('places default Layer 0 end + tool cache_control on anthropic_explicit when cacheBreakpoints omitted', () => {
        const conn = makeConnection({
            providerFormat: 'anthropic',
            baseUrl: 'https://api.anthropic.com/v1/messages',
            cachePolicy: 'anthropic_explicit',
        });

        const out = compiler.compile(
            {
                connectionId: conn.id,
                messages: [
                    { role: 'system', content: 'Sys 0' },
                    { role: 'system', content: 'Sys 1 (Layer 0 end)' },
                    { role: 'user', content: 'Hello' },
                ],
                tools: [
                    { name: 'a', description: 'A', parameters: { type: 'object' } },
                    { name: 'b', description: 'B', parameters: { type: 'object' } },
                ],
            },
            conn,
        );

        expect(out.url).toBe('https://api.anthropic.com/v1/messages');
        expect(out.cacheBreakpointsApplied).toBe(2);
        const tools = out.body.tools as Array<{ cache_control?: unknown }>;
        expect(tools[0].cache_control).toBeUndefined();
        expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });
        const system = out.body.system as Array<{ cache_control?: unknown }>;
        expect(system[0].cache_control).toBeUndefined();
        expect(system[1].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('supports anthropic_explicit breakpoints on OpenAI/OpenRouter format capped at 4', () => {
        const conn = makeConnection({
            providerFormat: 'openai',
            baseUrl: 'https://openrouter.ai/api/v1',
            cachePolicy: 'anthropic_explicit',
            maxCacheBreakpoints: 3,
        });

        const out = compiler.compile(
            {
                connectionId: conn.id,
                messages: [
                    { role: 'system', content: 'Sys' },
                    { role: 'user', content: 'U1' },
                    { role: 'assistant', content: 'A1' },
                    { role: 'user', content: 'U2' },
                    { role: 'assistant', content: 'A2' },
                ],
                tools: [],
                cacheBreakpoints: [0, 1, 2, 3, 4],
            },
            conn,
        );

        expect(out.cacheBreakpointsApplied).toBe(3);
        const msgs = out.body.messages as Array<{ content: unknown }>;
        expect(msgs[0].content).toEqual([{ type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } }]);
        expect(msgs[1].content).toBe('U1');
        expect(msgs[3].content).toEqual([{ type: 'text', text: 'U2', cache_control: { type: 'ephemeral' } }]);
        expect(msgs[4].content).toEqual([{ type: 'text', text: 'A2', cache_control: { type: 'ephemeral' } }]);
    });

    it('applies promptPostProcessing modes (merge, semi, strict, single) accurately', () => {
        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'Sys A' },
            { role: 'system', content: 'Sys B' },
            { role: 'assistant', content: 'Assistant opener' },
            { role: 'system', content: 'Mid system' },
            { role: 'user', content: 'User question' },
        ];

        const merged = compiler.compile(
            { connectionId: 'c', messages, tools: [], stream: false },
            makeConnection({ promptPostProcessing: 'merge', cachePolicy: 'none' }),
        );
        expect(merged.body.messages).toEqual([
            { role: 'system', content: 'Sys A\n\nSys B' },
            { role: 'assistant', content: 'Assistant opener' },
            { role: 'system', content: 'Mid system' },
            { role: 'user', content: 'User question' },
        ]);

        const semi = compiler.compile(
            { connectionId: 'c', messages, tools: [], stream: false },
            makeConnection({ promptPostProcessing: 'semi', cachePolicy: 'none' }),
        );
        expect(semi.body.messages).toEqual([
            { role: 'system', content: 'Sys A\n\nSys B' },
            { role: 'assistant', content: 'Assistant opener' },
            { role: 'user', content: 'Mid system\n\nUser question' },
        ]);

        const strict = compiler.compile(
            { connectionId: 'c', messages, tools: [], stream: false },
            makeConnection({ promptPostProcessing: 'strict', cachePolicy: 'none' }),
        );
        expect(strict.body.messages).toEqual([
            { role: 'system', content: 'Sys A\n\nSys B' },
            { role: 'user', content: "Let's get started." },
            { role: 'assistant', content: 'Assistant opener' },
            { role: 'user', content: 'Mid system\n\nUser question' },
        ]);

        const single = compiler.compile(
            { connectionId: 'c', messages, tools: [], stream: false },
            makeConnection({ promptPostProcessing: 'single', cachePolicy: 'none' }),
        );
        expect(single.body.messages).toEqual([
            {
                role: 'user',
                content: 'Sys A\n\nSys B\n\nAssistant opener\n\nMid system\n\nUser question',
            },
        ]);
    });

    it('omits auth headers when apiKey is empty, handles pre-suffixed URLs, and ignores invalid breakpoint indices', () => {
        const openai = compiler.compile(
            {
                connectionId: 'local',
                messages: [{ role: 'user', content: 'ping' }],
                tools: [],
                cacheBreakpoints: [-1, 99],
            },
            makeConnection({
                providerFormat: 'openai',
                baseUrl: 'http://127.0.0.1:11434/v1/chat/completions/',
                apiKey: '',
                cachePolicy: 'anthropic_explicit',
                maxCacheBreakpoints: 0,
            }),
        );
        expect(openai.url).toBe('http://127.0.0.1:11434/v1/chat/completions');
        expect(openai.headers.Authorization).toBeUndefined();
        expect(openai.cacheBreakpointsApplied).toBe(0);

        const anthropic = compiler.compile(
            {
                connectionId: 'ant',
                messages: [{ role: 'user', content: 'ping' }],
                tools: [],
            },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://proxy.example.com/v1/messages',
                apiKey: '',
                cachePolicy: 'none',
            }),
        );
        expect(anthropic.url).toBe('https://proxy.example.com/v1/messages');
        expect(anthropic.headers['x-api-key']).toBeUndefined();
        expect(anthropic.headers['anthropic-version']).toBe('2023-06-01');
    });

    it('resolves /models endpoints and GET headers across OpenAI, Anthropic, and relative proxy URLs', () => {
        expect(buildModelsEndpointUrl('https://api.openai.com/v1', 'openai')).toBe(
            'https://api.openai.com/v1/models',
        );
        expect(buildModelsEndpointUrl('https://api.openai.com/v1/', 'openai')).toBe(
            'https://api.openai.com/v1/models',
        );
        expect(buildModelsEndpointUrl('https://api.openai.com/v1/chat/completions', 'openai')).toBe(
            'https://api.openai.com/v1/models',
        );
        expect(buildModelsEndpointUrl('https://proxy.local/v1/completions?api-version=2024', 'openai')).toBe(
            'https://proxy.local/v1/models?api-version=2024',
        );
        expect(buildModelsEndpointUrl('/proxy/v1', 'openai')).toBe('/proxy/v1/models');
        expect(buildModelsEndpointUrl('https://api.openai.com/v1/models', 'openai')).toBe(
            'https://api.openai.com/v1/models',
        );

        expect(buildModelsEndpointUrl('https://api.anthropic.com', 'anthropic')).toBe(
            'https://api.anthropic.com/v1/models',
        );
        expect(buildModelsEndpointUrl('https://api.anthropic.com/v1/', 'anthropic')).toBe(
            'https://api.anthropic.com/v1/models',
        );
        expect(buildModelsEndpointUrl('https://api.anthropic.com/v1/messages', 'anthropic')).toBe(
            'https://api.anthropic.com/v1/models',
        );
        expect(() => buildModelsEndpointUrl('   ', 'openai')).toThrow(/baseUrl is required/i);

        const openaiReq = compiler.compileModelsRequest(
            makeConnection({
                providerFormat: 'openai',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                apiKey: 'sk-openai',
                includeHeaders: {
                    'Content-Type': null,
                    'X-Custom': '1',
                },
            }),
        );
        expect(openaiReq.method).toBe('GET');
        expect(openaiReq.url).toBe('https://api.openai.com/v1/models');
        expect(openaiReq.headers.Accept).toBe('application/json');
        expect(openaiReq.headers['Content-Type']).toBeUndefined();
        expect(openaiReq.headers.Authorization).toBe('Bearer sk-openai');
        expect(openaiReq.headers['X-Custom']).toBe('1');

        const localReq = compiler.compileModelsRequest(
            makeConnection({
                providerFormat: 'openai',
                baseUrl: 'http://127.0.0.1:1234/v1',
                apiKey: '   ',
            }),
        );
        expect(localReq.headers.Authorization).toBeUndefined();
        expect(localReq.headers['Content-Type']).toBeUndefined();

        const anthropicReq = compiler.compileModelsRequest(
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                apiKey: 'sk-ant',
            }),
        );
        expect(anthropicReq.method).toBe('GET');
        expect(anthropicReq.url).toBe('https://api.anthropic.com/v1/models');
        expect(anthropicReq.headers['x-api-key']).toBe('sk-ant');
        expect(anthropicReq.headers['anthropic-version']).toBe('2023-06-01');
        expect(anthropicReq.headers['Content-Type']).toBeUndefined();
    });

    it('compiles multimodal image_url, input_audio, video_url, and file parts for OpenAI and Anthropic', () => {
        const multimodalMessages: CanonicalMessage[] = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: '请分析图片、音频、视频和文档' },
                    { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
                    {
                        type: 'input_audio',
                        data: 'data:audio/mp3;base64,SUQzAw==',
                        format: 'mp3',
                        mimeType: 'audio/mpeg',
                        filename: 'voice.mp3',
                    },
                    {
                        type: 'video_url',
                        videoUrl: 'data:video/mp4;base64,AAAAIGZ0eXA=',
                        mimeType: 'video/mp4',
                        filename: 'clip.mp4',
                    },
                    {
                        type: 'file',
                        data: 'data:application/pdf;base64,JVBERi0xLjQ=',
                        mimeType: 'application/pdf',
                        filename: 'spec.pdf',
                    },
                ],
            },
        ];

        const openaiOut = compiler.compile(
            {
                connectionId: 'openai-mm',
                messages: multimodalMessages,
                tools: [],
                stream: false,
            },
            makeConnection({ providerFormat: 'openai', cachePolicy: 'none' }),
        );
        const openaiMsgs = openaiOut.body.messages as Array<{ content: unknown[] }>;
        expect(openaiMsgs).toHaveLength(1);
        expect(openaiMsgs[0].content).toEqual([
            { type: 'text', text: '请分析图片、音频、视频和文档' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            { type: 'input_audio', input_audio: { data: 'SUQzAw==', format: 'mp3' } },
            { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAAIGZ0eXA=' } },
            {
                type: 'file',
                file: {
                    file_data: 'data:application/pdf;base64,JVBERi0xLjQ=',
                    filename: 'spec.pdf',
                    mime_type: 'application/pdf',
                },
            },
        ]);

        const anthropicOut = compiler.compile(
            {
                connectionId: 'ant-mm',
                messages: multimodalMessages,
                tools: [],
                stream: false,
            },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com',
                cachePolicy: 'none',
            }),
        );
        const antMsgs = anthropicOut.body.messages as Array<{ content: unknown[] }>;
        expect(antMsgs).toHaveLength(1);
        expect(antMsgs[0].content).toEqual([
            { type: 'text', text: '请分析图片、音频、视频和文档' },
            {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
            {
                type: 'document',
                source: { type: 'base64', media_type: 'audio/mpeg', data: 'SUQzAw==' },
            },
            {
                type: 'document',
                source: { type: 'base64', media_type: 'video/mp4', data: 'AAAAIGZ0eXA=' },
            },
            {
                type: 'document',
                source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
            },
        ]);
    });

    it('compiles Gemini endpoint URLs, /models discovery URLs, and x-goog-api-key headers across variants', () => {
        const baseReq = {
            connectionId: 'gem',
            messages: [{ role: 'user' as const, content: 'hi' }],
            tools: [],
        };

        const official = compiler.compile(
            { ...baseReq, stream: false },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com',
                model: 'gemini-2.5-flash',
                apiKey: 'AIza-secret',
            }),
        );
        expect(official.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
        );
        expect(official.headers['x-goog-api-key']).toBe('AIza-secret');
        expect(official.headers.Authorization).toBeUndefined();

        const v1betaStream = compiler.compile(
            { ...baseReq, stream: true },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
                model: 'models/gemini-2.5-pro',
                apiKey: 'AIza-secret',
            }),
        );
        expect(v1betaStream.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
        );

        const v1ModelsPrefix = compiler.compile(
            { ...baseReq, stream: false },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1',
                model: 'gemini-2.5-pro',
                apiKey: '',
            }),
        );
        expect(v1ModelsPrefix.url).toBe(
            'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-pro:generateContent',
        );
        expect(v1ModelsPrefix.headers['x-goog-api-key']).toBeUndefined();

        const modelsDirBase = compiler.compile(
            { ...baseReq, stream: true },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
                model: 'gemini-2.5-flash',
            }),
        );
        expect(modelsDirBase.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        );

        const pastedGenerateWithKey = compiler.compile(
            { ...baseReq, stream: true },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=AIzaQ',
                model: '',
                apiKey: '',
            }),
        );
        expect(pastedGenerateWithKey.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?key=AIzaQ&alt=sse',
        );

        const pastedStreamToNonStream = compiler.compile(
            { ...baseReq, stream: false },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=AIzaQ',
                model: '',
            }),
        );
        expect(pastedStreamToNonStream.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=AIzaQ',
        );

        const relativeProxy = compiler.compile(
            { ...baseReq, stream: true },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: '/proxy/gemini/v1beta',
                model: 'gemini-2.5-flash',
                includeHeaders: {
                    Authorization: 'Bearer custom-oauth-token',
                },
            }),
        );
        expect(relativeProxy.url).toBe(
            '/proxy/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
        );
        expect(relativeProxy.headers['x-goog-api-key']).toBeUndefined();
        expect(relativeProxy.headers.Authorization).toBe('Bearer custom-oauth-token');

        expect(() =>
            compiler.compile(
                { ...baseReq, stream: false },
                makeConnection({
                    providerFormat: 'gemini',
                    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                    model: '   ',
                }),
            ),
        ).toThrow(/model is required for Gemini/i);

        // /models discovery URL resolution
        expect(
            buildModelsEndpointUrl('https://generativelanguage.googleapis.com', 'gemini'),
        ).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(
            buildModelsEndpointUrl('https://generativelanguage.googleapis.com/v1beta/', 'gemini'),
        ).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(
            buildModelsEndpointUrl('https://generativelanguage.googleapis.com/v1', 'gemini'),
        ).toBe('https://generativelanguage.googleapis.com/v1/models');
        expect(
            buildModelsEndpointUrl('https://generativelanguage.googleapis.com/v1beta/models', 'gemini'),
        ).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(
            buildModelsEndpointUrl(
                'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=AIzaQ',
                'gemini',
            ),
        ).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=AIzaQ');

        const modelsReq = compiler.compileModelsRequest(
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                apiKey: 'AIza-models-key',
            }),
        );
        expect(modelsReq.method).toBe('GET');
        expect(modelsReq.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
        expect(modelsReq.headers['x-goog-api-key']).toBe('AIza-models-key');
        expect(modelsReq.headers.Accept).toBe('application/json');
        expect(modelsReq.headers['Content-Type']).toBeUndefined();
    });

    it('compiles Gemini systemInstruction, contents, thoughtSignature, functionResponse, generationConfig, schema sanitization, and multimodal parts', () => {
        const sanitizedNested = sanitizeGeminiSchema({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
                path: { type: 'string', description: 'File path' },
                filter: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Optional filter' },
                mode: { const: 'fast' },
                count: { type: 'integer', exclusiveMinimum: 1, format: 'int32' },
                tags: { type: 'array' },
            },
            required: ['path', 'nonexistent'],
        });
        expect(sanitizedNested).toEqual({
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path' },
                filter: { type: 'string', nullable: true, description: 'Optional filter' },
                mode: { type: 'string', enum: ['fast'] },
                count: { type: 'integer', minimum: 1, format: 'int32' },
                tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['path'],
        });

        const messages: CanonicalMessage[] = [
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Check /a.md and /b.md' },
            {
                role: 'assistant',
                content: 'Reading both files.',
                toolCalls: [
                    {
                        id: 'call_a',
                        name: 'read_file',
                        arguments: '{"path":"/a.md"}',
                        thoughtSignature: 'sig-abc-123',
                    },
                    {
                        id: 'call_b',
                        name: 'list_root',
                        arguments: '{}',
                    },
                ],
            },
            // First tool uses explicit toolName + JSON object string
            {
                role: 'tool',
                toolCallId: 'call_a',
                toolName: 'read_file',
                content: '{"content":"Hello"}',
            },
            // Second tool omits toolName -> resolved via call_b -> list_root, plain string wrapped as { result }
            {
                role: 'tool',
                toolCallId: 'call_b',
                content: 'root-ok',
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Analyze media' },
                    { type: 'image_url', imageUrl: 'data:image/png;base64,iVBORw0KGgo=' },
                    { type: 'input_audio', data: 'data:audio/mp3;base64,SUQzAw==', format: 'mp3' },
                    { type: 'input_audio', data: 'SUQzAw==', format: 'mp3' },
                    { type: 'video_url', videoUrl: 'https://example.com/clip.mp4', mimeType: 'video/mp4' },
                    { type: 'file', data: 'data:application/pdf;base64,JVBERi0xLjQ=', mimeType: 'application/pdf' },
                ],
            },
        ];

        const connZeroPenalties = makeConnection({
            providerFormat: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            model: 'gemini-2.5-pro',
            topK: 40,
            frequencyPenalty: 0,
            presencePenalty: 0,
            cachePolicy: 'auto_prefix',
            includeBody: {
                generationConfig: {
                    thinkingConfig: { includeThoughts: true },
                },
            },
        });

        const outA = compiler.compile(
            {
                connectionId: connZeroPenalties.id,
                messages,
                tools: [
                    {
                        name: 'read_file',
                        description: 'Read a file',
                        parameters: {
                            type: 'object',
                            additionalProperties: false,
                            properties: { path: { type: 'string' } },
                            required: ['path'],
                        },
                    },
                    {
                        name: 'list_root',
                        description: 'List root files',
                        parameters: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {},
                        },
                    },
                ],
                stream: false,
            },
            connZeroPenalties,
        );

        expect(outA.cacheBreakpointsApplied).toBe(0);
        expect(outA.body.systemInstruction).toEqual({
            parts: [{ text: 'Rule 1' }, { text: 'Rule 2' }],
        });
        expect(outA.body.tools).toEqual([
            {
                functionDeclarations: [
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
                        name: 'list_root',
                        description: 'List root files',
                    },
                ],
            },
        ]);

        const contents = outA.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
        expect(contents).toHaveLength(3);
        expect(contents[0]).toEqual({
            role: 'user',
            parts: [{ text: 'Check /a.md and /b.md' }],
        });
        expect(contents[1]).toEqual({
            role: 'model',
            parts: [
                { text: 'Reading both files.' },
                {
                    functionCall: { name: 'read_file', args: { path: '/a.md' } },
                    thoughtSignature: 'sig-abc-123',
                },
                {
                    functionCall: { name: 'list_root', args: {} },
                },
            ],
        });
        expect(contents[2]).toEqual({
            role: 'user',
            parts: [
                { functionResponse: { name: 'read_file', response: { content: 'Hello' } } },
                { functionResponse: { name: 'list_root', response: { result: 'root-ok' } } },
                { text: 'Analyze media' },
                { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
                { inlineData: { mimeType: 'audio/mp3', data: 'SUQzAw==' } },
                { inlineData: { mimeType: 'audio/mpeg', data: 'SUQzAw==' } },
                { fileData: { mimeType: 'video/mp4', fileUri: 'https://example.com/clip.mp4' } },
                { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0xLjQ=' } },
            ],
        });

        expect(outA.body.generationConfig).toEqual({
            maxOutputTokens: 4096,
            temperature: 0.7,
            topP: 0.95,
            topK: 40,
            thinkingConfig: { includeThoughts: true },
        });

        // Non-zero penalties ARE forwarded
        const outPenalties = compiler.compile(
            {
                connectionId: 'gem-pen',
                messages: [{ role: 'user', content: 'hi' }],
                tools: [],
                stream: false,
            },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-flash',
                frequencyPenalty: 0.25,
                presencePenalty: -0.1,
            }),
        );
        expect((outPenalties.body.generationConfig as Record<string, unknown>).frequencyPenalty).toBe(0.25);
        expect((outPenalties.body.generationConfig as Record<string, unknown>).presencePenalty).toBe(-0.1);

        // auto_prefix canonical key ordering remains byte-identical
        const connReordered = makeConnection({
            ...connZeroPenalties,
            includeBody: {
                generationConfig: {
                    thinkingConfig: { includeThoughts: true },
                },
            },
        });
        const outB = compiler.compile(
            {
                connectionId: connReordered.id,
                messages,
                tools: [
                    {
                        parameters: {
                            required: ['path'],
                            properties: { path: { type: 'string' } },
                            additionalProperties: false,
                            type: 'object',
                        },
                        description: 'Read a file',
                        name: 'read_file',
                    },
                    {
                        parameters: { properties: {}, type: 'object', additionalProperties: false },
                        description: 'List root files',
                        name: 'list_root',
                    },
                ],
                stream: false,
            },
            connReordered,
        );
        expect(outA.serializedBody).toBe(outB.serializedBody);
    });

    it('converts all system messages to user or model/assistant across Gemini, Anthropic, and OpenAI when systemInstructionMode is set', () => {
        const rawMessages: CanonicalMessage[] = [
            { role: 'system', name: 'SysA', content: 'Leading system 1' },
            { role: 'system', content: 'Leading system 2' },
            { role: 'user', content: 'Hello' },
            { role: 'system', name: 'SysMid', content: 'Mid system rule' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'system', content: 'Tail system reminder' },
        ];
        const snapshotBefore = JSON.stringify(rawMessages);

        // 1. Gemini + systemInstructionMode: 'user'
        const geminiUser = compiler.compile(
            { connectionId: 'gem-u', messages: rawMessages, tools: [], stream: false },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                systemInstructionMode: 'user',
                cachePolicy: 'auto_prefix',
            }),
        );
        expect(geminiUser.body.systemInstruction).toBeUndefined();
        expect(geminiUser.body.contents).toEqual([
            {
                role: 'user',
                parts: [
                    { text: 'Leading system 1' },
                    { text: 'Leading system 2' },
                    { text: 'Hello' },
                    { text: 'Mid system rule' },
                ],
            },
            { role: 'model', parts: [{ text: 'Hi there' }] },
            { role: 'user', parts: [{ text: 'Tail system reminder' }] },
        ]);

        // auto_prefix determinism with systemInstructionMode: 'user'
        const geminiUserReordered = compiler.compile(
            {
                connectionId: 'gem-u',
                messages: rawMessages.map((m) => ({ content: m.content, role: m.role, ...(m.name ? { name: m.name } : {}) })),
                tools: [],
                stream: false,
            },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                systemInstructionMode: 'user',
                cachePolicy: 'auto_prefix',
            }),
        );
        expect(geminiUser.serializedBody).toBe(geminiUserReordered.serializedBody);

        // 2. Gemini + systemInstructionMode: 'model' (leading system -> model triggers user placeholder; preceding user avoids placeholder)
        const geminiModel = compiler.compile(
            { connectionId: 'gem-m', messages: rawMessages, tools: [], stream: false },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                systemInstructionMode: 'model',
            }),
        );
        expect(geminiModel.body.systemInstruction).toBeUndefined();
        expect(geminiModel.body.contents).toEqual([
            { role: 'user', parts: [{ text: "Let's get started." }] },
            { role: 'model', parts: [{ text: 'Leading system 1' }, { text: 'Leading system 2' }] },
            { role: 'user', parts: [{ text: 'Hello' }] },
            {
                role: 'model',
                parts: [
                    { text: 'Mid system rule' },
                    { text: 'Hi there' },
                    { text: 'Tail system reminder' },
                ],
            },
        ]);

        const geminiModelUserFirst = compiler.compile(
            {
                connectionId: 'gem-m2',
                messages: [
                    { role: 'user', content: 'First user' },
                    { role: 'system', content: 'Mid system' },
                ],
                tools: [],
                stream: false,
            },
            makeConnection({
                providerFormat: 'gemini',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
                model: 'gemini-2.5-pro',
                systemInstructionMode: 'model',
            }),
        );
        expect(geminiModelUserFirst.body.systemInstruction).toBeUndefined();
        expect(geminiModelUserFirst.body.contents).toEqual([
            { role: 'user', parts: [{ text: 'First user' }] },
            { role: 'model', parts: [{ text: 'Mid system' }] },
        ]);

        // 3. Anthropic + 'user' & 'model' with anthropic_explicit cache_control
        const antUser = compiler.compile(
            {
                connectionId: 'ant-u',
                messages: [
                    { role: 'system', name: 'Sys', content: 'Layer 0 A' },
                    { role: 'system', content: 'Layer 0 B' },
                    { role: 'user', content: 'Turn 1' },
                ],
                tools: [],
                stream: false,
            },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com/v1',
                cachePolicy: 'anthropic_explicit',
                systemInstructionMode: 'user',
            }),
        );
        expect(antUser.body.system).toBeUndefined();
        expect(antUser.cacheBreakpointsApplied).toBe(1);
        expect(antUser.body.messages).toEqual([
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'Layer 0 A' },
                    { type: 'text', text: 'Layer 0 B', cache_control: { type: 'ephemeral' } },
                    { type: 'text', text: 'Turn 1' },
                ],
            },
        ]);

        const antModel = compiler.compile(
            {
                connectionId: 'ant-m',
                messages: rawMessages,
                tools: [],
                stream: false,
                cacheBreakpoints: [1, 5],
            },
            makeConnection({
                providerFormat: 'anthropic',
                baseUrl: 'https://api.anthropic.com/v1',
                cachePolicy: 'anthropic_explicit',
                systemInstructionMode: 'model',
            }),
        );
        expect(antModel.body.system).toBeUndefined();
        expect(antModel.cacheBreakpointsApplied).toBe(2);
        expect(antModel.body.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: "Let's get started." }] },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Leading system 1' },
                    { type: 'text', text: 'Leading system 2', cache_control: { type: 'ephemeral' } },
                ],
            },
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Mid system rule' },
                    { type: 'text', text: 'Hi there' },
                    { type: 'text', text: 'Tail system reminder', cache_control: { type: 'ephemeral' } },
                ],
            },
        ]);

        // 4. OpenAI + 'user' & 'model' + promptPostProcessing & explicit breakpoints
        const openaiUserMerged = compiler.compile(
            { connectionId: 'oai-u', messages: rawMessages, tools: [], stream: false },
            makeConnection({
                providerFormat: 'openai',
                systemInstructionMode: 'user',
                promptPostProcessing: 'merge',
                cachePolicy: 'none',
            }),
        );
        expect(
            (openaiUserMerged.body.messages as Array<{ role: string }>).some((m) => m.role === 'system'),
        ).toBe(false);
        expect(openaiUserMerged.body.messages).toEqual([
            {
                role: 'user',
                content: 'Leading system 1\n\nLeading system 2\n\nHello\n\nMid system rule',
            },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Tail system reminder' },
        ]);

        const openaiModelStrict = compiler.compile(
            { connectionId: 'oai-m', messages: rawMessages, tools: [], stream: false },
            makeConnection({
                providerFormat: 'openai',
                systemInstructionMode: 'model',
                promptPostProcessing: 'strict',
                cachePolicy: 'anthropic_explicit',
            }),
        );
        expect(
            (openaiModelStrict.body.messages as Array<{ role: string }>).some((m) => m.role === 'system'),
        ).toBe(false);
        expect(openaiModelStrict.cacheBreakpointsApplied).toBe(1);
        expect(openaiModelStrict.body.messages).toEqual([
            { role: 'user', content: "Let's get started." },
            {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: 'Leading system 1\n\nLeading system 2',
                        cache_control: { type: 'ephemeral' },
                    },
                ],
            },
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Mid system rule\n\nHi there\n\nTail system reminder' },
        ]);

        // Input messages must remain completely unmutated
        expect(JSON.stringify(rawMessages)).toBe(snapshotBefore);
    });
});
