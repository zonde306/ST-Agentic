import { describe, expect, it } from 'vitest';
import {
    isHighlightLanguage,
    resolveFenceLanguage,
    tokenizeCode,
    tokenizeJavaScript,
    tokenizeJson,
    tokenizeMarkdown,
    type SyntaxToken,
    type SyntaxTokenType,
} from '../../../src/ui/components/syntax-highlight';

function join(tokens: SyntaxToken[]): string {
    return tokens.map((t) => t.text).join('');
}

function typed(tokens: SyntaxToken[], type: SyntaxTokenType): string[] {
    return tokens.filter((t) => t.type === type).map((t) => t.text);
}

describe('syntax-highlight', () => {
    it('only enables the three supported languages', () => {
        expect(isHighlightLanguage('javascript')).toBe(true);
        expect(isHighlightLanguage('json')).toBe(true);
        expect(isHighlightLanguage('markdown')).toBe(true);
        expect(isHighlightLanguage('yaml')).toBe(false);
        expect(isHighlightLanguage(undefined)).toBe(false);
    });

    describe('lossless round-trip', () => {
        const samples: Array<[Parameters<typeof tokenizeCode>[1], string]> = [
            ['javascript', 'const a = 1;\n// c\nfunction f(x) { return /a\\/b[/]/g.test(x) ? `t${x}` : "s"; }\n'],
            ['javascript', 'let s = "unterminated\nlet t = \'ok\' /* open comment'],
            ['json', '{\n  "a": [1, -2.5e3, true, null],\n  "b": "x\\"y" // c\n}'],
            ['json', '{ "broken": "no end\n'],
            ['markdown', '# T\n\n- [x] **b** _i_ `c` {{user}}\n> q\n```js\nconst x = 1;\n```\n<tag a="1">t</tag>\n'],
            ['markdown', '```json\n{"open": true'],
            ['markdown', ''],
        ];
        it.each(samples)('%s reproduces input exactly', (lang, code) => {
            expect(join(tokenizeCode(code, lang))).toBe(code);
        });
    });

    it('tokenizes JavaScript keywords, strings, numbers, functions, regex and comments', () => {
        const tokens = tokenizeJavaScript('const re = /a+b/gi; // note\nfoo(0x1F, "s").bar; x = a / b / c;');
        expect(typed(tokens, 'keyword')).toContain('const');
        expect(typed(tokens, 'regex')).toEqual(['/a+b/gi']);
        expect(typed(tokens, 'comment')).toEqual(['// note']);
        expect(typed(tokens, 'function')).toEqual(['foo']);
        expect(typed(tokens, 'number')).toEqual(['0x1F']);
        expect(typed(tokens, 'string')).toEqual(['"s"']);
        expect(typed(tokens, 'property')).toEqual(['bar']);
    });

    it('treats `/` after an expression as division but after `=` / return as regex', () => {
        expect(typed(tokenizeJavaScript('x=/re/'), 'regex')).toEqual(['/re/']);
        expect(typed(tokenizeJavaScript('return /re/.test(s)'), 'regex')).toEqual(['/re/']);
        expect(typed(tokenizeJavaScript('(a) / b / c'), 'regex')).toEqual([]);
    });

    it('does not treat member names as keywords', () => {
        const tokens = tokenizeJavaScript('obj.default = obj.return;');
        expect(typed(tokens, 'keyword')).toEqual([]);
        expect(typed(tokens, 'property')).toEqual(['default', 'return']);
    });

    it('distinguishes JSON keys from string values', () => {
        const tokens = tokenizeJson('{"name" : "Alice", "tags": ["a"], "ok": false, "n": -1.5}');
        expect(typed(tokens, 'property')).toEqual(['"name"', '"tags"', '"ok"', '"n"']);
        expect(typed(tokens, 'string')).toEqual(['"Alice"', '"a"']);
        expect(typed(tokens, 'constant')).toEqual(['false']);
        expect(typed(tokens, 'number')).toEqual(['-1.5']);
    });

    it('highlights markdown blocks, inline marks, ST macros and prompt tags', () => {
        const md = [
            '## Title',
            '- [ ] item with **bold** and *em* and ~~gone~~',
            '> quoted {{char}}',
            'see [docs](https://example.com) or <character>x</character>',
            'snake_case_name stays plain',
        ].join('\n');
        const tokens = tokenizeMarkdown(md);
        expect(typed(tokens, 'heading')).toEqual(['## Title']);
        expect(typed(tokens, 'list')).toEqual(['-', '[ ]']);
        expect(typed(tokens, 'strong')).toEqual(['**bold**']);
        expect(typed(tokens, 'emphasis')).toEqual(['*em*']);
        expect(typed(tokens, 'strike')).toEqual(['~~gone~~']);
        expect(typed(tokens, 'quote')).toEqual(['> ']);
        expect(typed(tokens, 'macro')).toEqual(['{{char}}']);
        expect(typed(tokens, 'link')).toEqual(['[docs]']);
        expect(typed(tokens, 'url')).toEqual(['(https://example.com)']);
        expect(typed(tokens, 'tag')).toEqual(['<character>', '</character>']);
    });

    it('delegates fenced code to the nested language tokenizer', () => {
        const tokens = tokenizeMarkdown('```javascript\nconst a = "x";\n```\n```\nplain *not em*\n```');
        expect(typed(tokens, 'meta')).toEqual(['```javascript', '```', '```', '```']);
        expect(typed(tokens, 'keyword')).toEqual(['const']);
        expect(typed(tokens, 'string')).toEqual(['"x"']);
        expect(typed(tokens, 'code')).toEqual(['plain *not em*\n']);
        expect(typed(tokens, 'emphasis')).toEqual([]);
    });

    it('resolves common fence aliases', () => {
        expect(resolveFenceLanguage('ts title="x"')).toBe('javascript');
        expect(resolveFenceLanguage('JSONC')).toBe('json');
        expect(resolveFenceLanguage('python')).toBeNull();
    });
});
