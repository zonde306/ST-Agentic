import { describe, expect, it } from 'vitest';
import {
    AGENTIC_DECORATORS,
    DecoratorParser,
    EJS_TEMPLATE_DECORATORS,
    KNOWN_DECORATORS,
    LEGACY_DECORATORS,
    ST_NATIVE_DECORATORS,
    evaluateIfConditions,
    extractIfConditions,
    hasPrivateDecorator,
    isEjsEntryEnabled,
    isEjsForceDisabledEntry,
    isEjsSpecialEntry,
    parseDecorators,
} from '@/core/lore';
import type { RawLoreEntry } from '@/core/types';
import { MemoryHostBridge } from '../../mocks';

function makeEntry(content: string, decorators?: string[]): RawLoreEntry {
    return {
        world: 'TestBook',
        uid: 1,
        comment: 'Test Entry',
        content,
        keys: [],
        keysecondary: [],
        constant: false,
        selective: false,
        disable: false,
        position: 1,
        depth: 4,
        order: 100,
        role: 0,
        ...(decorators ? { decorators } : {}),
    };
}

describe('DecoratorParser', () => {
    it('recognizes all legacy, ST native, and ST-Agentic decorators', () => {
        for (const name of [...LEGACY_DECORATORS, ...ST_NATIVE_DECORATORS, ...AGENTIC_DECORATORS]) {
            expect(DecoratorParser.isKnownDecorator(name)).toBe(true);
            expect(KNOWN_DECORATORS.has(name)).toBe(true);
        }

        const legacySample = [
            '@@replace_diff_before',
            '@@variables_jsonpatch',
            '@@append_output_ejs_before',
            '@@replace_output_ejs',
            '@@evaluate_ejs_before',
            '@@replace_search',
            '@@variables_yaml',
            '@@preset fast-model',
            '@@batch_order 2',
            '正文内容',
        ].join('\n');

        const parsed = new DecoratorParser(legacySample);
        expect(parsed.decorators.map((d) => d.name)).toEqual([
            '@@replace_diff_before',
            '@@variables_jsonpatch',
            '@@append_output_ejs_before',
            '@@replace_output_ejs',
            '@@evaluate_ejs_before',
            '@@replace_search',
            '@@variables_yaml',
            '@@preset',
            '@@batch_order',
        ]);
        expect(parsed.args('@@preset')).toEqual(['fast-model']);
        expect(parsed.args('batch_order')).toEqual(['2']);
        expect(parsed.cleanContent).toBe('正文内容');
    });

    it('parses new @@trigger with key=value params, quoted values, and mixed positional args', () => {
        const content = [
            '@@trigger summary phase=after order=1 barrier=self profile="chronicler v2" label="状态 = 总结"',
            '@@group story_digest',
            '根据本轮内容生成简短摘要。',
        ].join('\n');

        const parsed = new DecoratorParser(content);
        expect(parsed.has('@@trigger')).toBe(true);
        expect(parsed.has('group')).toBe(true);
        expect(parsed.args('@@trigger')).toEqual(['summary']);
        expect(parsed.params('@@trigger')).toEqual({
            phase: 'after',
            order: '1',
            barrier: 'self',
            profile: 'chronicler v2',
            label: '状态 = 总结',
        });
        expect(parsed.args('@@group')).toEqual(['story_digest']);
        expect(parsed.cleanContent).toBe('根据本轮内容生成简短摘要。');
    });

    it('parses @@tool, @@script, @@system, @@agent, and @@skill decorators', () => {
        const toolEntry = parseDecorators('@@tool comfy_illustrate allowNetwork=true\nexport default {};');
        expect(toolEntry.decorators).toEqual([
            {
                name: '@@tool',
                rawArgs: 'comfy_illustrate allowNetwork=true',
                args: ['comfy_illustrate'],
                params: { allowNetwork: 'true' },
            },
        ]);
        expect(toolEntry.cleanContent).toBe('export default {};');

        const scriptEntry = parseDecorators('@@script phase=before order=0\nvars.tick = (vars.tick || 0) + 1;');
        expect(scriptEntry.decorators[0]).toMatchObject({
            name: '@@script',
            params: { phase: 'before', order: '0' },
        });

        const systemEntry = parseDecorators('@@system\r\n请保持冷峻克制的文风。');
        expect(systemEntry.decorators).toEqual([
            { name: '@@system', rawArgs: '', args: [], params: {} },
        ]);
        expect(systemEntry.cleanContent).toBe('请保持冷峻克制的文风。');

        const agentEntry = parseDecorators('@@agent archivist query scope\n检索归档。');
        expect(agentEntry.decorators[0]).toMatchObject({
            name: '@@agent',
            args: ['archivist', 'query', 'scope'],
        });

        const skillEntry = parseDecorators('@@skill "rune decode" v1\n铭文解析步骤');
        expect(skillEntry.decorators[0]).toMatchObject({
            name: '@@skill',
            args: ['rune decode', 'v1'],
        });
    });

    it('preserves inline JSON and Zod schemas without stripping quotes', () => {
        const jsonContent = [
            '@@variables_json',
            '@@json_schema {"type":"object","properties":{"hp":{"type":"number"}},"required":["hp"]}',
            '更新角色生命值。',
        ].join('\n');

        const parsedJson = new DecoratorParser(jsonContent);
        expect(parsedJson.rawArgs('@@json_schema')).toBe(
            '{"type":"object","properties":{"hp":{"type":"number"}},"required":["hp"]}',
        );
        expect(parsedJson.args('@@json_schema')).toEqual([
            '{"type":"object","properties":{"hp":{"type":"number"}},"required":["hp"]}',
        ]);
        expect(parsedJson.params('@@json_schema')).toEqual({});
        expect(parsedJson.cleanContent).toBe('更新角色生命值。');

        const zodContent = '@@zod_schema z.object({ mood: z.enum(["calm", "tense"]) })\n更新情绪。';
        const parsedZod = new DecoratorParser(zodContent);
        expect(parsedZod.rawArgs('@@zod_schema')).toBe(
            'z.object({ mood: z.enum(["calm", "tense"]) })',
        );
        expect(parsedZod.cleanContent).toBe('更新情绪。');
    });

    it('handles @@@ escapes, unknown @@ lines, quoted literals with =, and pre-parsed entry.decorators', () => {
        const escaped = parseDecorators('@@@replace\n不应被剥离。');
        expect(escaped.decorators).toEqual([]);
        expect(escaped.cleanContent).toBe('@@@replace\n不应被剥离。');

        const unknown = parseDecorators('@@unknown_header\n普通文本内容');
        expect(unknown.decorators).toEqual([]);
        expect(unknown.cleanContent).toBe('@@unknown_header\n普通文本内容');

        const mixed = parseDecorators('@@replace\n@@literal_note\n实际正文');
        expect(mixed.decorators.map((d) => d.name)).toEqual(['@@replace']);
        expect(mixed.cleanContent).toBe('@@literal_note\n实际正文');

        const quotedEquals = parseDecorators('@@replace "a=b"\n内容');
        expect(quotedEquals.decorators[0]).toMatchObject({
            name: '@@replace',
            args: ['a=b'],
            params: {},
        });

        const preStripped = new DecoratorParser(makeEntry('纯净正文', ['@@trigger phase=after order=2']));
        expect(preStripped.has('@@trigger')).toBe(true);
        expect(preStripped.params('@@trigger')).toEqual({ phase: 'after', order: '2' });
        expect(preStripped.cleanContent).toBe('纯净正文');
    });

    it('supports all 16 ST-Prompt-Template decorators, verbatim @@if/@@iframe, special entry flags, and @@if evaluation', async () => {
        for (const name of EJS_TEMPLATE_DECORATORS) {
            expect(DecoratorParser.isKnownDecorator(name)).toBe(true);
            expect(KNOWN_DECORATORS.has(name)).toBe(true);
        }

        const statusEntry = makeEntry(
            [
                '@@render_after',
                '@@iframe 状态栏（点击展开）',
                '@@if !is_user && !is_system && vars.hp > 0',
                '@@private',
                '<div>HP: <%- vars.hp %></div>',
            ].join('\n'),
        );
        const parsed = new DecoratorParser(statusEntry);
        expect(parsed.decorators.map((d) => d.name)).toEqual([
            '@@render_after',
            '@@iframe',
            '@@if',
            '@@private',
        ]);
        expect(parsed.rawArgs('@@iframe')).toBe('状态栏（点击展开）');
        expect(extractIfConditions(parsed.decorators)).toEqual([
            '!is_user && !is_system && vars.hp > 0',
        ]);
        expect(hasPrivateDecorator(parsed.decorators)).toBe(true);
        expect(parsed.cleanContent).toBe('<div>HP: <%- vars.hp %></div>');
        expect(isEjsSpecialEntry(statusEntry, parsed.decorators)).toBe(true);

        const disabledEntry = makeEntry('@@dont_activate\n屏蔽');
        expect(isEjsForceDisabledEntry(new DecoratorParser(disabledEntry).decorators)).toBe(true);
        expect(isEjsEntryEnabled(disabledEntry)).toBe(false);

        const alwaysEnabledEntry: RawLoreEntry = {
            ...makeEntry('@@render_after\n@@always_enabled\n<div>ok</div>'),
            disable: true,
        };
        expect(isEjsEntryEnabled(alwaysEnabledEntry)).toBe(true);

        const invertedSpecial: RawLoreEntry = {
            ...makeEntry('@@generate_before\n<% injectPrompt("a", "b"); %>'),
            disable: true,
        };
        expect(isEjsEntryEnabled(invertedSpecial, undefined, { invertEnabled: false })).toBe(false);
        expect(isEjsEntryEnabled(invertedSpecial, undefined, { invertEnabled: true })).toBe(true);

        // evaluateIfConditions with EJS evaluator
        const bridgeWithEjs = new MemoryHostBridge({
            ejsEvaluator: async (code, vars) => {
                if (code.includes('vars.hp > 50')) {
                    return Number(vars.hp) > 50 ? 'true' : 'false';
                }
                return 'true';
            },
        });
        expect(await evaluateIfConditions(['vars.hp > 50'], bridgeWithEjs, { hp: 80 })).toBe(true);
        expect(await evaluateIfConditions(['vars.hp > 50'], bridgeWithEjs, { hp: 20 })).toBe(false);

        // Missing EJS gracefully warns once and fails open
        const bridgeNoEjs = new MemoryHostBridge();
        expect(await evaluateIfConditions(['vars.hp > 50'], bridgeNoEjs, { hp: 20 })).toBe(true);
        expect(await evaluateIfConditions(['vars.hp > 50'], bridgeNoEjs, { hp: 10 })).toBe(true);
        expect(bridgeNoEjs.compatWarnings).toHaveLength(1);
        expect(bridgeNoEjs.compatWarnings[0].code).toBe('ejs_missing_for_if');
    });
});
