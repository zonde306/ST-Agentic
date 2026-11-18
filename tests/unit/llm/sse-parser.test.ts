import { describe, expect, it } from 'vitest';
import type { LLMStreamChunk } from '@/core/bridge';
import { assembleStreamChunks, parseCompletionResponse, SSEParser } from '@/core/llm';

function encode(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

describe('SSEParser', () => {
    it('handles split UTF-8 characters, CRLF delimiters, comments, and incremental <think> blocks', () => {
        const sse = [
            ': keep-alive\r\n\r\n',
            'data: {"choices":[{"index":0,"delta":{"content":"<thi"}}]}\r\n\r\n',
            'data: {"choices":[{"index":0,"delta":{"content":"nk>分析：银莲花</thi"}}]}\r\n\r\n',
            'data: {"choices":[{"index":0,"delta":{"content":"nk>2 < 3，正文银莲花"}}]}\r\n\r\n',
            'data: [DONE]\r\n\r\n',
        ].join('');

        const bytes = encode(sse);
        const parser = new SSEParser();
        const allChunks: LLMStreamChunk[] = [];

        // Feed 3 bytes at a time to split multi-byte UTF-8 Chinese chars and \r\n\r\n boundaries.
        for (let i = 0; i < bytes.length; i += 3) {
            allChunks.push(...parser.feed(bytes.subarray(i, i + 3)));
        }
        allChunks.push(...parser.flush());

        const result = parser.getResult();
        expect(result.reasoningContent).toBe('分析：银莲花');
        expect(result.content).toBe('2 < 3，正文银莲花');
        expect(allChunks.filter((c) => c.type === 'done')).toHaveLength(1);
    });

    it('reassembles interleaved multi-tool calls without duplicating repeated id/name', () => {
        const parser = new SSEParser();
        const frames = [
            'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Checking two files."}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"list_dir","arguments":"{\\"dir\\":"}}]}}]}\n\n',
            // Repeated id & name must NOT concatenate!
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"\\"/a.md\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\\"/lore\\"}"}}]}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
            // OpenAI stream_options include_usage trailing chunk after finish_reason
            'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":45,"total_tokens":2045,"prompt_tokens_details":{"cached_tokens":1600}}}\n\n',
            'data: [DONE]\n\n',
        ];

        const chunks: LLMStreamChunk[] = [];
        for (const frame of frames) {
            chunks.push(...parser.feed(frame));
        }
        chunks.push(...parser.flush());

        const assembled = assembleStreamChunks(chunks);
        expect(assembled.reasoningContent).toBe('Checking two files.');
        expect(assembled.toolCalls).toEqual([
            { id: 'call_1', name: 'read_file', arguments: '{"path":"/a.md"}' },
            { id: 'call_2', name: 'list_dir', arguments: '{"dir":"/lore"}' },
        ]);
        expect(assembled.usage).toEqual({
            inputTokens: 2000,
            cachedTokens: 1600,
            outputTokens: 45,
            totalTokens: 2045,
            cacheHitRate: 0.8,
        });
        expect(assembled.finishReason).toBe('tool_calls');
    });

    it('extracts Gemini thoughtSignature from OpenAI-compat, OpenRouter reasoning_details, and native Gemini chunks', () => {
        // 1. OpenAI-compat extra_content.google.thought_signature + OpenRouter reasoning_details
        const parser = new SSEParser();
        const frames = [
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"tool_a","arguments":"{}"},"extra_content":{"google":{"thought_signature":"sig-google-1"}}}]}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"tool_b","arguments":"{}"}}]}}]}\n\n',
            'data: {"choices":[{"index":0,"delta":{"reasoning_details":[{"type":"reasoning.encrypted","id":"call_b","data":"sig-openrouter-2"}]}}]}\n\n',
            'data: [DONE]\n\n',
        ];
        const chunks: LLMStreamChunk[] = [];
        for (const f of frames) {
            chunks.push(...parser.feed(f));
        }
        chunks.push(...parser.flush());

        const res = parser.getResult();
        expect(res.toolCalls).toEqual([
            { id: 'call_a', name: 'tool_a', arguments: '{}', thoughtSignature: 'sig-google-1' },
            { id: 'call_b', name: 'tool_b', arguments: '{}', thoughtSignature: 'sig-openrouter-2' },
        ]);
        expect(chunks.some((c) => c.type === 'tool_call_delta' && c.thoughtSignature === 'sig-openrouter-2')).toBe(true);

        // 2. Native Gemini candidates chunk
        const geminiParser = new SSEParser();
        geminiParser.feed(
            'data: {"candidates":[{"content":{"parts":[{"text":"gemini thinking","thought":true},{"functionCall":{"name":"lookup","args":{"q":"lotus"}},"thoughtSignature":"sig-native-3"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":500,"cachedContentTokenCount":400,"candidatesTokenCount":25,"totalTokenCount":525}}\n\n',
        );
        geminiParser.flush();
        const geminiRes = geminiParser.getResult();
        expect(geminiRes.reasoningContent).toBe('gemini thinking');
        expect(geminiRes.toolCalls).toEqual([
            { id: 'call_0', name: 'lookup', arguments: '{"q":"lotus"}', thoughtSignature: 'sig-native-3' },
        ]);
        expect(geminiRes.usage.cachedTokens).toBe(400);
        expect(geminiRes.usage.cacheHitRate).toBe(0.8);
    });

    it('parses Anthropic Messages SSE events (thinking_delta, text_delta, input_json_delta, cache_read_input_tokens)', () => {
        const parser = new SSEParser({ providerFormat: 'anthropic' });
        const anthropicStream = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","role":"assistant","usage":{"input_tokens":100,"cache_creation_input_tokens":100,"cache_read_input_tokens":800,"output_tokens":1}}}\n\n',
            'event: ping\ndata: {"type":"ping"}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 1. "}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Step 2."}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Checking file."}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_01","name":"read_file","input":{}}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"/lore.md\\"}"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":3,"content_block":{"type":"tool_use","id":"toolu_02","name":"list_root","input":{}}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":3}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":64}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ].join('');

        const chunks: LLMStreamChunk[] = [];
        for (let i = 0; i < anthropicStream.length; i += 29) {
            chunks.push(...parser.feed(anthropicStream.slice(i, i + 29)));
        }
        chunks.push(...parser.flush());

        const result = assembleStreamChunks(chunks);
        expect(result.reasoningContent).toBe('Step 1. Step 2.');
        expect(result.content).toBe('Checking file.');
        expect(result.toolCalls).toEqual([
            { id: 'toolu_01', name: 'read_file', arguments: '{"path":"/lore.md"}' },
            { id: 'toolu_02', name: 'list_root', arguments: '{}' },
        ]);
        expect(result.usage).toEqual({
            inputTokens: 1000,
            cachedTokens: 800,
            outputTokens: 64,
            totalTokens: 1064,
            cacheHitRate: 0.8,
        });
        expect(result.finishReason).toBe('tool_use');
    });

    it('throws LLMTransportError on inline SSE error frames and parses non-streaming JSON responses', () => {
        const parser = new SSEParser();
        expect(() =>
            parser.feed('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n'),
        ).toThrow(/Overloaded/);

        const anthropicNonStream = parseCompletionResponse(
            {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'pondering' },
                    { type: 'text', text: 'Done' },
                    { type: 'tool_use', id: 'tu_1', name: 'ping', input: { ok: true } },
                ],
                stop_reason: 'tool_use',
                usage: {
                    input_tokens: 50,
                    cache_read_input_tokens: 450,
                    output_tokens: 30,
                },
            },
            'anthropic',
        );

        expect(anthropicNonStream.reasoningContent).toBe('pondering');
        expect(anthropicNonStream.content).toBe('Done');
        expect(anthropicNonStream.toolCalls).toEqual([
            { id: 'tu_1', name: 'ping', arguments: '{"ok":true}' },
        ]);
        expect(anthropicNonStream.usage).toEqual({
            inputTokens: 500,
            cachedTokens: 450,
            outputTokens: 30,
            totalTokens: 530,
            cacheHitRate: 0.9,
        });
    });

    it('flushes unclosed <think> tags, trailing unterminated frames, and DeepSeek prompt_cache_hit_tokens', () => {
        const parser = new SSEParser();
        parser.feed(
            'data: {"choices":[{"index":0,"delta":{"content":"<think>open thought"}}]}\n\n'
            + 'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":10,"prompt_cache_hit_tokens":750}}',
        );
        // Note: second frame lacked trailing \n\n and [DONE]; flush() must still process it!
        parser.flush();

        const res = parser.getResult();
        expect(res.reasoningContent).toBe('open thought');
        expect(res.content).toBe('');
        expect(res.usage).toEqual({
            inputTokens: 1000,
            cachedTokens: 750,
            outputTokens: 10,
            totalTokens: 1010,
            cacheHitRate: 0.75,
        });
    });
});
