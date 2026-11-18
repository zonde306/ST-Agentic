import { describe, expect, it } from 'vitest';
import {
    assertAppendOnlyPrefix,
    DeferredGate,
    MemoryHostBridge,
    ScriptedLLMTransport,
} from './index';
import type { LLMRequest } from '@/core/bridge';
import type { CanonicalToolSchema, RawLoreEntry } from '@/core/types';
import hollowChineseCard from '../fixtures/hollow-chinese-card.json';
import ejsConditionalLore from '../fixtures/ejs-conditional-lore.json';
import legacyCustomGeneration from '../fixtures/legacy-custom-generation.json';
import stOpenAiPreset from '../fixtures/st-openai-preset.json';

describe('Wave 0 test mocks', () => {
    it('MemoryHostBridge supports macros, variables, lorebooks, spies, and real xxHash', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '艾琳' },
            characterFields: { description: '银月守望者' },
            personaDescription: '来自北方边境的调查员',
        });

        bridge.setVariable('gold', 120);
        const macroOut = bridge.substituteMacros(
            '{{user}} 对 {{char}} 说：当前金币 {{getvar::gold}} ({{custom}})',
            { custom: '银莲花' },
        );
        expect(macroOut).toBe('旅人 对 艾琳 说：当前金币 120 (银莲花)');

        const h1 = await bridge.hashText('测试文本');
        const h2 = await bridge.hashText('测试文本');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{16}$/);

        const target = { messageId: 1, swipeId: 0 };
        await bridge.attachMediaToMessage(target, { type: 'image', url: 'https://example.com/a.png' });
        await bridge.refreshMessageView(target);
        expect(bridge.mediaAttachments).toHaveLength(1);
        expect(bridge.refreshedViews).toEqual([target]);

        await bridge.saveExtensionData('settings', { runMode: 'takeover' });
        expect(await bridge.loadExtensionData('settings', { runMode: 'off' })).toEqual({
            runMode: 'takeover',
        });
    });

    it('ScriptedLLMTransport streams text, reasoning, incremental tool calls, usage, and honors AbortSignal', async () => {
        const transport = new ScriptedLLMTransport([
            {
                reasoningContent: '先检索档案',
                content: '好的，让我查一下。',
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'read_file',
                        arguments: '{"path":"/lorebooks/world/银莲花-12.md"}',
                        thoughtSignature: 'sig-abc',
                    },
                ],
                usage: { inputTokens: 1000, cachedTokens: 900, outputTokens: 42 },
                chunkSize: 6,
            },
            {
                delayMs: 500,
                content: '不会发出',
            },
        ]);

        const req: LLMRequest = {
            connectionId: 'default',
            messages: [{ role: 'user', content: ' silver lotus ' }],
            tools: [],
        };

        let reasoning = '';
        let content = '';
        const argParts: string[] = [];
        let seenCached = 0;

        for await (const chunk of transport.stream(req)) {
            if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoning += chunk.reasoningDelta;
            } else if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
            } else if (chunk.type === 'tool_call_delta' && chunk.argumentsDelta) {
                argParts.push(chunk.argumentsDelta);
            } else if (chunk.type === 'usage' && chunk.usage) {
                seenCached = chunk.usage.cachedTokens;
            }
        }

        expect(reasoning).toBe('先检索档案');
        expect(content).toBe('好的，让我查一下。');
        expect(argParts.length).toBeGreaterThan(1);
        expect(argParts.join('')).toBe('{"path":"/lorebooks/world/银莲花-12.md"}');
        expect(seenCached).toBe(900);
        expect(transport.requests).toHaveLength(1);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 15);
        await expect(
            transport.complete({ ...req, signal: controller.signal }),
        ).rejects.toThrow(/aborted/i);
    });

    it('assertAppendOnlyPrefix passes for append-only turns and throws on key/prefix mutation', () => {
        const toolA: CanonicalToolSchema = {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
        };
        const toolAReordered: CanonicalToolSchema = {
            description: 'Read a file',
            parameters: { properties: { path: { type: 'string' } }, type: 'object' },
            name: 'read_file',
        };

        const req1: LLMRequest = {
            connectionId: 'main',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'turn 1' },
            ],
            tools: [toolA],
        };

        const req2Valid: LLMRequest = {
            connectionId: 'main',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'turn 1' },
                { role: 'assistant', content: 'reply 1' },
                { role: 'user', content: 'turn 2' },
            ],
            tools: [toolAReordered],
        };

        expect(() => assertAppendOnlyPrefix(req1, req2Valid)).not.toThrow();

        const req2MutatedPrefix: LLMRequest = {
            ...req2Valid,
            messages: [
                { role: 'system', content: 'sys-mutated' },
                ...req2Valid.messages.slice(1),
            ],
        };
        expect(() => assertAppendOnlyPrefix(req1, req2MutatedPrefix)).toThrow(/messages\[0\]/);
    });

    it('DeferredGate coordinates async task waiting and resolution', async () => {
        const gate = new DeferredGate<string>();
        let finished = false;

        const worker = (async () => {
            const val = await gate.promise;
            finished = true;
            return val;
        })();

        await gate.waitUntilWaiting();
        expect(finished).toBe(false);
        expect(gate.waitingCount).toBe(1);

        gate.resolve('committed');
        await expect(worker).resolves.toBe('committed');
        expect(finished).toBe(true);
    });

    it('loads standard Wave 0 corpus fixtures cleanly into MemoryHostBridge', async () => {
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const ejsEntries = ejsConditionalLore.entries as RawLoreEntry[];

        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: {
                '霜烬纪元': loreEntries,
                [ejsConditionalLore.world]: ejsEntries,
            },
        });

        const books = await bridge.listEnabledLorebooks();
        expect(books.get('霜烬纪元')?.length).toBeGreaterThanOrEqual(10);
        expect(books.get(ejsConditionalLore.world)).toHaveLength(2);
        expect(bridge.getCharacterFields().description.length).toBeLessThan(80);
        expect(legacyCustomGeneration.interceptGenerate).toBe(true);
        expect(stOpenAiPreset.prompts.some((p) => p.injection_depth === 4 && p.injection_position === 1)).toBe(true);
    });
});
