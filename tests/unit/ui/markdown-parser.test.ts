import { describe, expect, it } from 'vitest';
import {
    type MarkdownBlockNode,
    type MarkdownInlineNode,
    parseMarkdownBlocks,
    parseMarkdownInline,
    sanitizeMarkdownImageUrl,
    sanitizeMarkdownUrl,
} from '@/ui/components/markdown-parser';

function inlineToText(nodes: readonly MarkdownInlineNode[]): string {
    return nodes
        .map((node) => {
            switch (node.type) {
                case 'text':
                    return node.text;
                case 'code':
                    return node.code;
                case 'redacted':
                    return '***REDACTED***';
                case 'break':
                    return '\n';
                case 'image':
                    return node.alt;
                case 'strong':
                case 'em':
                case 'del':
                case 'link':
                    return inlineToText(node.children);
            }
        })
        .join('');
}

describe('Markdown GFM AST Parser', () => {
    it('parses the exact Slash-command assistant reply structure from screenshot', () => {
        const md = [
            '**可以，我现在能够访问 SillyTavern 的 Slash / STscript 命令执行工具 (`st_slash_exec`)。**',
            '',
            '通过 SillyTavern 的内置 Slash 命令，确实可以做到对聊天消息的物理删除、新建、插入等操作。',
            '',
            '---',
            '',
            '### 一、支持消息操作的常用 Slash 命令',
            '',
            '在 SillyTavern (STscript) 中，与消息相关的常用命令包括：',
            '',
            '1. 删除消息：',
            '  - `/del [message_id]` 或 `/delete`：删除指定的单条或最新消息。',
            '  - `/cut [message_id]`：剪切/截断该消息之后的所有历史。',
            '  - `/messages-del`：批量删除指定范围或条件的聊天消息。',
            '',
            '2. 创建 / 插入消息：',
            '  - `/send [text]`：以当前用户身份发送一条新消息。',
            '  - `/sys [text]`：插入一条系统消息。',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks.map((b) => b.type)).toEqual([
            'paragraph',
            'paragraph',
            'hr',
            'heading',
            'paragraph',
            'list',
        ]);

        const firstPara = blocks[0] as Extract<MarkdownBlockNode, { type: 'paragraph' }>;
        expect(firstPara.children).toHaveLength(1);
        expect(firstPara.children[0].type).toBe('strong');
        const strongNode = firstPara.children[0] as Extract<MarkdownInlineNode, { type: 'strong' }>;
        expect(strongNode.children.some((n) => n.type === 'code' && n.code === 'st_slash_exec')).toBe(
            true,
        );

        const heading = blocks[3] as Extract<MarkdownBlockNode, { type: 'heading' }>;
        expect(heading.level).toBe(3);
        expect(inlineToText(heading.children)).toBe('一、支持消息操作的常用 Slash 命令');

        const orderedList = blocks[5] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(orderedList.ordered).toBe(true);
        expect(orderedList.start).toBe(1);
        expect(orderedList.items).toHaveLength(2);

        const item1 = orderedList.items[0];
        expect(item1.blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
        const nested1 = item1.blocks[1] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(nested1.ordered).toBe(false);
        expect(nested1.items).toHaveLength(3);
        const firstSubPara = nested1.items[0].blocks[0] as Extract<
            MarkdownBlockNode,
            { type: 'paragraph' }
        >;
        expect(
            firstSubPara.children.some((n) => n.type === 'code' && n.code === '/del [message_id]'),
        ).toBe(true);

        const item2 = orderedList.items[1];
        expect(item2.blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
        const nested2 = item2.blocks[1] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(nested2.ordered).toBe(false);
        expect(nested2.items).toHaveLength(2);
    });

    it('parses bold section header followed by 2-space nested list (**1. 删除消息：**)', () => {
        const md = [
            '**1. 删除消息：**',
            '  - `/del [message_id]`：删除消息。',
            '  - `/cut [message_id]`：截断历史。',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
        const para = blocks[0] as Extract<MarkdownBlockNode, { type: 'paragraph' }>;
        expect(para.children[0].type).toBe('strong');
        expect(inlineToText(para.children)).toBe('1. 删除消息：');
        const list = blocks[1] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(list.ordered).toBe(false);
        expect(list.items).toHaveLength(2);
    });

    it('parses headings H1-H6, preserves ### C#, and ignores #7 without space', () => {
        const md = [
            '# H1',
            '## H2 ##',
            '### C#',
            '#### H4',
            '##### H5',
            '###### H6',
            '#7 条目说明',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks.slice(0, 6).map((b) => (b.type === 'heading' ? b.level : null))).toEqual([
            1, 2, 3, 4, 5, 6,
        ]);
        expect(inlineToText((blocks[1] as Extract<MarkdownBlockNode, { type: 'heading' }>).children)).toBe(
            'H2',
        );
        expect(inlineToText((blocks[2] as Extract<MarkdownBlockNode, { type: 'heading' }>).children)).toBe(
            'C#',
        );
        expect(blocks[6].type).toBe('paragraph');
        expect(inlineToText((blocks[6] as Extract<MarkdownBlockNode, { type: 'paragraph' }>).children)).toBe(
            '#7 条目说明',
        );
    });

    it('parses thematic breaks (---, ***, ___) without misparsing ***REDACTED*** or text\\n---', () => {
        const blocks = parseMarkdownBlocks('第一段\n---\n***\n_ _ _\n***REDACTED***');
        expect(blocks.map((b) => b.type)).toEqual([
            'paragraph',
            'hr',
            'hr',
            'hr',
            'paragraph',
        ]);
        const redactedPara = blocks[4] as Extract<MarkdownBlockNode, { type: 'paragraph' }>;
        expect(redactedPara.children).toEqual([{ type: 'redacted' }]);
    });

    it('parses fenced code blocks (backtick, tilde, language tag, and unclosed streaming)', () => {
        const closed = parseMarkdownBlocks('```typescript\nconst a = 1;\n```\n\n~~~json\n{"ok":true}\n~~~');
        expect(closed).toEqual([
            { type: 'code_block', lang: 'typescript', code: 'const a = 1;' },
            { type: 'code_block', lang: 'json', code: '{"ok":true}' },
        ]);

        const streamingUnclosed = parseMarkdownBlocks('### 正在输出\n```ts\nconst x = 1;\nconst y = 2;');
        expect(streamingUnclosed).toEqual([
            { type: 'heading', level: 3, children: [{ type: 'text', text: '正在输出' }] },
            { type: 'code_block', lang: 'ts', code: 'const x = 1;\nconst y = 2;' },
        ]);
    });

    it('parses nested blockquotes containing headings, lists, and code blocks', () => {
        const md = [
            '> ### 引用标题',
            '> - 引用列表 1',
            '> > 嵌套引用 **加粗**',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks).toHaveLength(1);
        const quote = blocks[0] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
        expect(quote.type).toBe('blockquote');
        expect(quote.blocks.map((b) => b.type)).toEqual(['heading', 'list', 'blockquote']);
        const innerQuote = quote.blocks[2] as Extract<MarkdownBlockNode, { type: 'blockquote' }>;
        expect(innerQuote.blocks[0].type).toBe('paragraph');
    });

    it('parses ordered custom start, task lists, loose lists, and code blocks inside list items', () => {
        const md = [
            '3) 第三项',
            '   ```js',
            '   console.log(1);',
            '',
            '   console.log(2);',
            '   ```',
            '',
            '4) 第四项',
            '',
            '- [ ] 待办 A',
            '- [x] 已完成 B',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks.map((b) => b.type)).toEqual(['list', 'list']);

        const ol = blocks[0] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(ol.ordered).toBe(true);
        expect(ol.start).toBe(3);
        expect(ol.items).toHaveLength(2);
        expect(ol.items[0].blocks.map((b) => b.type)).toEqual(['paragraph', 'code_block']);
        const codeBlock = ol.items[0].blocks[1] as Extract<MarkdownBlockNode, { type: 'code_block' }>;
        expect(codeBlock.code).toBe('console.log(1);\n\nconsole.log(2);');

        const ul = blocks[1] as Extract<MarkdownBlockNode, { type: 'list' }>;
        expect(ul.ordered).toBe(false);
        expect(ul.items.map((item) => item.checked)).toEqual([false, true]);
    });

    it('parses GFM tables with alignments, escaped pipes, code pipes, <br>, and rejects non-tables', () => {
        const md = [
            '| 命令 | 说明 | 对齐 |',
            '| :--- | :---: | ---: |',
            '| `/del` | 删除\\|截断<br>第二行 | `a | b` |',
            '| `/sys` | 系统消息 | 100 |',
        ].join('\n');

        const blocks = parseMarkdownBlocks(md);
        expect(blocks).toHaveLength(1);
        const table = blocks[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
        expect(table.type).toBe('table');
        expect(table.aligns).toEqual(['left', 'center', 'right']);
        expect(table.headers.map(inlineToText)).toEqual(['命令', '说明', '对齐']);
        expect(table.rows).toHaveLength(2);
        expect(table.rows[0][1]).toEqual([
            { type: 'text', text: '删除|截断' },
            { type: 'break' },
            { type: 'text', text: '第二行' },
        ]);
        expect(table.rows[0][2]).toEqual([{ type: 'code', code: 'a | b' }]);

        const nonTable = parseMarkdownBlocks('普通标题文本\n---');
        expect(nonTable.map((b) => b.type)).toEqual(['paragraph', 'hr']);
    });

    it('supports nested inline formatting, balanced links, bare URLs, escapes, and snake_case preservation', () => {
        const nested = parseMarkdownInline(
            '*斜体 **加粗 `code`** 与 ~~删除~~* 和 ***全强调***',
        );
        expect(nested[0].type).toBe('em');
        const emChildren = (nested[0] as Extract<MarkdownInlineNode, { type: 'em' }>).children;
        expect(emChildren.some((n) => n.type === 'strong')).toBe(true);
        expect(emChildren.some((n) => n.type === 'del')).toBe(true);

        const snake = parseMarkdownInline('调用 `st_slash_exec` 与 st_slash_exec 和 fast_ui_mode');
        expect(snake.some((n) => n.type === 'em' || n.type === 'strong')).toBe(false);
        expect(inlineToText(snake)).toBe('调用 st_slash_exec 与 st_slash_exec 和 fast_ui_mode');

        const cjkBold = parseMarkdownInline('注意：**非常重要**，请确认\\*转义\\*。');
        expect(cjkBold[0]).toEqual({ type: 'text', text: '注意：' });
        expect(cjkBold[1]).toEqual({
            type: 'strong',
            children: [{ type: 'text', text: '非常重要' }],
        });
        expect(cjkBold[2]).toEqual({ type: 'text', text: '，请确认*转义*。' });

        const links = parseMarkdownInline(
            '查看 [**文档**](https://en.wikipedia.org/wiki/Markdown_(markup)) 或 https://example.com/a?x=1。',
        );
        const linkNodes = links.filter((n) => n.type === 'link') as Extract<
            MarkdownInlineNode,
            { type: 'link' }
        >[];
        expect(linkNodes).toHaveLength(2);
        expect(linkNodes[0].href).toBe('https://en.wikipedia.org/wiki/Markdown_(markup)');
        expect(linkNodes[0].children[0].type).toBe('strong');
        expect(linkNodes[1].href).toBe('https://example.com/a?x=1');
    });

    it('preserves ***REDACTED*** everywhere and blocks unsafe URLs / raw HTML execution', () => {
        const redactedInBold = parseMarkdownInline('**密钥 ***REDACTED*** 警告**');
        expect(redactedInBold).toEqual([
            {
                type: 'strong',
                children: [
                    { type: 'text', text: '密钥 ' },
                    { type: 'redacted' },
                    { type: 'text', text: ' 警告' },
                ],
            },
        ]);

        const redactedInTable = parseMarkdownBlocks(
            '| Key | Val |\n| --- | --- |\n| token | ***REDACTED*** |',
        );
        const table = redactedInTable[0] as Extract<MarkdownBlockNode, { type: 'table' }>;
        expect(table.rows[0][1]).toEqual([{ type: 'redacted' }]);

        expect(sanitizeMarkdownUrl('javascript:alert(1)')).toBeNull();
        expect(sanitizeMarkdownUrl('  vbscript:msgbox(1)  ')).toBeNull();
        expect(sanitizeMarkdownUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
        expect(sanitizeMarkdownUrl('https://example.com/path')).toBe('https://example.com/path');
        expect(sanitizeMarkdownUrl('mailto:user@example.com')).toBe('mailto:user@example.com');

        expect(sanitizeMarkdownImageUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull();
        expect(sanitizeMarkdownImageUrl('javascript:alert(1)')).toBeNull();
        expect(sanitizeMarkdownImageUrl('data:image/png;base64,iVBORw0KGgo=')).toBe(
            'data:image/png;base64,iVBORw0KGgo=',
        );

        const unsafeNodes = parseMarkdownInline(
            '[点我](javascript:alert(1)) ![xss](data:image/svg+xml;base64,PHN2Zz4=) <script>alert(1)</script> <% getvar("x") %>',
        );
        expect(unsafeNodes.some((n) => n.type === 'link' || n.type === 'image')).toBe(false);
        expect(inlineToText(unsafeNodes)).toContain('点我');
        expect(inlineToText(unsafeNodes)).toContain('[图片: xss]');
        expect(inlineToText(unsafeNodes)).toContain('<script>alert(1)</script>');
        expect(inlineToText(unsafeNodes)).toContain('<% getvar("x") %>');
    });

    it('handles deep recursion safely without throwing', () => {
        const deepQuotes = `${'> '.repeat(25)}深层引用`;
        const blocks = parseMarkdownBlocks(deepQuotes);
        expect(blocks.length).toBeGreaterThan(0);

        const deepEmphasis = `${'*'.repeat(2)}`.repeat(12);
        expect(() => parseMarkdownInline(deepEmphasis)).not.toThrow();
    });
});
