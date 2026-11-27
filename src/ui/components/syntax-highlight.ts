/**
 * Zero-dependency, single-pass syntax tokenizers for the `CodeEditor` highlight overlay.
 *
 * Design goals:
 * - Tiny (no Prism / highlight.js / CodeMirror): a handful of sticky regexes per language.
 * - Lossless: concatenating every `token.text` reproduces the input exactly, so the
 *   overlay `<pre>` stays glyph-aligned with the transparent `<textarea>` above it.
 * - Tolerant: unterminated strings / comments / fences never throw and simply run to EOF
 *   (or end of line for single-line constructs) so half-typed code still renders.
 */

export type HighlightLanguage = 'javascript' | 'json' | 'markdown';

export type SyntaxTokenType =
    | 'comment'
    | 'string'
    | 'number'
    | 'constant'
    | 'keyword'
    | 'function'
    | 'property'
    | 'operator'
    | 'punctuation'
    | 'regex'
    | 'heading'
    | 'strong'
    | 'emphasis'
    | 'strike'
    | 'code'
    | 'link'
    | 'url'
    | 'list'
    | 'quote'
    | 'tag'
    | 'macro'
    | 'meta';

export interface SyntaxToken {
    /** `null` = plain text (rendered without a wrapper span). */
    type: SyntaxTokenType | null;
    text: string;
}

/** Above this size the editor falls back to a plain textarea to keep typing latency flat. */
export const MAX_HIGHLIGHT_CHARS = 60_000;

const HIGHLIGHTABLE = new Set<string>(['javascript', 'json', 'markdown']);

export function isHighlightLanguage(lang: string | undefined | null): lang is HighlightLanguage {
    return typeof lang === 'string' && HIGHLIGHTABLE.has(lang);
}

/** Maps markdown fence info strings (```js) to a highlight language. */
export function resolveFenceLanguage(info: string): HighlightLanguage | null {
    const lang = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
    switch (lang) {
        case 'js':
        case 'javascript':
        case 'mjs':
        case 'cjs':
        case 'jsx':
        case 'ts':
        case 'typescript':
        case 'tsx':
            return 'javascript';
        case 'json':
        case 'jsonc':
        case 'json5':
            return 'json';
        case 'md':
        case 'markdown':
            return 'markdown';
        default:
            return null;
    }
}

class TokenSink {
    readonly tokens: SyntaxToken[] = [];

    push(type: SyntaxTokenType | null, text: string): void {
        if (!text) {
            return;
        }
        const last = this.tokens[this.tokens.length - 1];
        if (last && last.type === type) {
            last.text += text;
            return;
        }
        this.tokens.push({ type, text });
    }

    pushAll(tokens: readonly SyntaxToken[]): void {
        for (const token of tokens) {
            this.push(token.type, token.text);
        }
    }
}

/** Runs `re` (must be sticky `y`) at `pos`; returns the matched text or `null`. */
function matchAt(re: RegExp, code: string, pos: number): string | null {
    re.lastIndex = pos;
    const m = re.exec(code);
    return m && m[0].length > 0 ? m[0] : null;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript
// ---------------------------------------------------------------------------

const JS_KEYWORDS = new Set([
    'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from',
    'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return',
    'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
    'while', 'with', 'yield', 'as', 'interface', 'type', 'enum', 'implements', 'declare',
    'readonly', 'keyof', 'satisfies',
]);

const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);

/** Keywords after which a `/` starts a regex literal rather than a division. */
const JS_REGEX_PRECEDING_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await',
]);

const JS_RE = {
    space: /\s+/y,
    lineComment: /\/\/[^\n]*/y,
    blockComment: /\/\*[\s\S]*?(?:\*\/|$)/y,
    sq: /'(?:\\[\s\S]|[^'\\\n])*'?/y,
    dq: /"(?:\\[\s\S]|[^"\\\n])*"?/y,
    template: /`(?:\\[\s\S]|[^`\\])*`?/y,
    regex: /\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*/y,
    number: /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y,
    ident: /[A-Za-z_$\u00A0-\uFFFF][\w$\u00A0-\uFFFF]*/y,
    // `/` is kept out of multi-char runs so `x=/re/` still reaches the regex-literal branch.
    operator: /(?:=>|\.\.\.|\?\?=?|\?\.|[+\-*%=&|^!~<>?:]+|\/=?)/y,
    punct: /[{}()[\];,.@#]/y,
    callLookahead: /\s*\(/y,
};

export function tokenizeJavaScript(code: string): SyntaxToken[] {
    const sink = new TokenSink();
    let pos = 0;
    // Tracks whether a `/` at the current position would begin a regex literal.
    let regexAllowed = true;
    let prevSignificant = '';

    while (pos < code.length) {
        let text: string | null;

        if ((text = matchAt(JS_RE.space, code, pos))) {
            sink.push(null, text);
        } else if ((text = matchAt(JS_RE.lineComment, code, pos)) || (text = matchAt(JS_RE.blockComment, code, pos))) {
            sink.push('comment', text);
        } else if (
            (text = matchAt(JS_RE.sq, code, pos))
            || (text = matchAt(JS_RE.dq, code, pos))
            || (text = matchAt(JS_RE.template, code, pos))
        ) {
            sink.push('string', text);
            regexAllowed = false;
            prevSignificant = 'str';
        } else if (regexAllowed && code[pos] === '/' && (text = matchAt(JS_RE.regex, code, pos))) {
            sink.push('regex', text);
            regexAllowed = false;
            prevSignificant = 'regex';
        } else if (/[\d.]/.test(code[pos] ?? '') && (text = matchAt(JS_RE.number, code, pos)) && text !== '.') {
            sink.push('number', text);
            regexAllowed = false;
            prevSignificant = 'num';
        } else if ((text = matchAt(JS_RE.ident, code, pos))) {
            const afterDot = prevSignificant === '.' || prevSignificant === '?.';
            let type: SyntaxTokenType | null = null;
            if (!afterDot && JS_KEYWORDS.has(text)) {
                type = 'keyword';
            } else if (!afterDot && JS_CONSTANTS.has(text)) {
                type = 'constant';
            } else if (matchAt(JS_RE.callLookahead, code, pos + text.length) !== null) {
                type = 'function';
            } else if (afterDot) {
                type = 'property';
            }
            sink.push(type, text);
            regexAllowed = type === 'keyword' && JS_REGEX_PRECEDING_KEYWORDS.has(text);
            prevSignificant = text;
        } else if ((text = matchAt(JS_RE.operator, code, pos))) {
            sink.push('operator', text);
            regexAllowed = true;
            prevSignificant = text;
        } else if ((text = matchAt(JS_RE.punct, code, pos))) {
            sink.push('punctuation', text);
            regexAllowed = text !== ')' && text !== ']' && text !== '}' && text !== '.';
            prevSignificant = text;
        } else {
            text = code[pos] as string;
            sink.push(null, text);
        }

        pos += text.length;
    }

    return sink.tokens;
}

// ---------------------------------------------------------------------------
// JSON (lenient: also understands JSONC comments)
// ---------------------------------------------------------------------------

const JSON_RE = {
    space: /\s+/y,
    lineComment: /\/\/[^\n]*/y,
    blockComment: /\/\*[\s\S]*?(?:\*\/|$)/y,
    string: /"(?:\\[\s\S]|[^"\\\n])*"?/y,
    number: /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y,
    word: /[A-Za-z_$][\w$]*/y,
    keyLookahead: /\s*:/y,
};

export function tokenizeJson(code: string): SyntaxToken[] {
    const sink = new TokenSink();
    let pos = 0;

    while (pos < code.length) {
        let text: string | null;
        const ch = code[pos] as string;

        if ((text = matchAt(JSON_RE.space, code, pos))) {
            sink.push(null, text);
        } else if (ch === '/' && ((text = matchAt(JSON_RE.lineComment, code, pos)) || (text = matchAt(JSON_RE.blockComment, code, pos)))) {
            sink.push('comment', text);
        } else if ((text = matchAt(JSON_RE.string, code, pos))) {
            const isKey = matchAt(JSON_RE.keyLookahead, code, pos + text.length) !== null;
            sink.push(isKey ? 'property' : 'string', text);
        } else if ((text = matchAt(JSON_RE.number, code, pos))) {
            sink.push('number', text);
        } else if ((text = matchAt(JSON_RE.word, code, pos))) {
            sink.push(text === 'true' || text === 'false' || text === 'null' ? 'constant' : null, text);
        } else if ('{}[],:'.includes(ch)) {
            text = ch;
            sink.push('punctuation', text);
        } else {
            text = ch;
            sink.push(null, text);
        }

        pos += text.length;
    }

    return sink.tokens;
}

// ---------------------------------------------------------------------------
// Markdown (+ SillyTavern `{{macro}}` and XML-ish prompt tags)
// ---------------------------------------------------------------------------

const MD_INLINE_RE = {
    escape: /\\[\\`*_{}[\]()#+\-.!~<>|]/y,
    code: /(`+)[^\n]*?\1/y,
    macro: /\{\{[^{}\n]*\}\}/y,
    htmlComment: /<!--[\s\S]*?(?:-->|$)/y,
    tag: /<\/?[A-Za-z][\w:.-]*(?:\s[^<>\n]*)?\/?>/y,
    autolink: /<(?:https?:\/\/|mailto:)[^\s<>]+>/y,
    url: /https?:\/\/[^\s<>()[\]]+[^\s<>()[\].,;:!?'"]/y,
    link: /!?\[[^\]\n]*\]/y,
    linkTarget: /\([^)\n]*\)/y,
    strong: /(\*\*|__)(?=\S)[^\n]*?\S\1/y,
    strike: /~~(?=\S)[^\n]*?\S~~/y,
    emphasis: /(\*|_)(?=[^\s*_])[^\n]*?[^\s*_]\1|(\*|_)[^\s*_]\2/y,
    plain: /[^\\`{<h![*_~]+/y,
};

/** `snake_case_name` must not be read as `_emphasis_` (CommonMark intraword rule). */
function isIntrawordUnderscore(line: string, pos: number): boolean {
    return line[pos] === '_' && pos > 0 && /[\p{L}\p{N}_]/u.test(line[pos - 1] ?? '');
}

function tokenizeMarkdownInline(line: string, sink: TokenSink): void {
    let pos = 0;
    while (pos < line.length) {
        let text: string | null;

        if ((text = matchAt(MD_INLINE_RE.escape, line, pos))) {
            sink.push(null, text);
        } else if ((text = matchAt(MD_INLINE_RE.code, line, pos))) {
            sink.push('code', text);
        } else if ((text = matchAt(MD_INLINE_RE.macro, line, pos))) {
            sink.push('macro', text);
        } else if ((text = matchAt(MD_INLINE_RE.htmlComment, line, pos))) {
            sink.push('comment', text);
        } else if ((text = matchAt(MD_INLINE_RE.autolink, line, pos))) {
            sink.push('url', text);
        } else if ((text = matchAt(MD_INLINE_RE.tag, line, pos))) {
            sink.push('tag', text);
        } else if ((text = matchAt(MD_INLINE_RE.url, line, pos))) {
            sink.push('url', text);
        } else if ((text = matchAt(MD_INLINE_RE.link, line, pos))) {
            const target = matchAt(MD_INLINE_RE.linkTarget, line, pos + text.length);
            if (target) {
                sink.push('link', text);
                sink.push('url', target);
                text += target;
            } else {
                sink.push(null, text);
            }
        } else if (!isIntrawordUnderscore(line, pos) && (text = matchAt(MD_INLINE_RE.strong, line, pos))) {
            sink.push('strong', text);
        } else if ((text = matchAt(MD_INLINE_RE.strike, line, pos))) {
            sink.push('strike', text);
        } else if (!isIntrawordUnderscore(line, pos) && (text = matchAt(MD_INLINE_RE.emphasis, line, pos))) {
            sink.push('emphasis', text);
        } else if ((text = matchAt(MD_INLINE_RE.plain, line, pos))) {
            sink.push(null, text);
        } else {
            text = line[pos] as string;
            sink.push(null, text);
        }

        pos += text.length;
    }
}

const MD_BLOCK_RE = {
    fence: /^(\s{0,3})(`{3,}|~{3,})(.*)$/,
    heading: /^\s{0,3}#{1,6}(?:\s|$)/,
    hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^(\s{0,3}>\s?)+/,
    list: /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\](?=\s))?/,
    table: /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/,
};

export function tokenizeMarkdown(code: string): SyntaxToken[] {
    const sink = new TokenSink();
    const lines = code.split('\n');

    let fence: { marker: string; lang: HighlightLanguage | null; body: string[] } | null = null;

    const flushFenceBody = () => {
        if (!fence || fence.body.length === 0) {
            return;
        }
        const body = fence.body.join('');
        fence.body = [];
        if (fence.lang && fence.lang !== 'markdown') {
            sink.pushAll(tokenizeCode(body, fence.lang));
        } else {
            sink.push('code', body);
        }
    };

    lines.forEach((line, index) => {
        const newline = index < lines.length - 1 ? '\n' : '';

        if (fence) {
            const close = MD_BLOCK_RE.fence.exec(line);
            if (close && close[2]?.[0] === fence.marker[0] && (close[2]?.length ?? 0) >= fence.marker.length && !close[3]?.trim()) {
                flushFenceBody();
                sink.push('meta', line);
                sink.push(null, newline);
                fence = null;
            } else {
                fence.body.push(line + newline);
            }
            return;
        }

        const open = MD_BLOCK_RE.fence.exec(line);
        if (open && !(open[2]?.[0] === '`' && open[3]?.includes('`'))) {
            sink.push('meta', line);
            sink.push(null, newline);
            fence = { marker: open[2] ?? '```', lang: resolveFenceLanguage(open[3] ?? ''), body: [] };
            return;
        }

        if (MD_BLOCK_RE.heading.test(line)) {
            sink.push('heading', line);
        } else if (MD_BLOCK_RE.hr.test(line) || MD_BLOCK_RE.table.test(line)) {
            sink.push('punctuation', line);
        } else {
            let rest = line;
            const quote = MD_BLOCK_RE.quote.exec(rest);
            if (quote) {
                sink.push('quote', quote[0]);
                rest = rest.slice(quote[0].length);
            }
            const list = MD_BLOCK_RE.list.exec(rest);
            if (list) {
                sink.push(null, list[1] ?? '');
                sink.push('list', list[2] ?? '');
                sink.push(null, list[3] ?? '');
                if (list[4]) {
                    sink.push('list', list[4]);
                }
                rest = rest.slice(list[0].length);
            }
            if (MD_BLOCK_RE.heading.test(rest)) {
                sink.push('heading', rest);
            } else {
                tokenizeMarkdownInline(rest, sink);
            }
        }
        sink.push(null, newline);
    });

    // Unterminated fence: still highlight what has been typed so far.
    flushFenceBody();
    return sink.tokens;
}

// ---------------------------------------------------------------------------

export function tokenizeCode(code: string, lang: HighlightLanguage): SyntaxToken[] {
    switch (lang) {
        case 'javascript':
            return tokenizeJavaScript(code);
        case 'json':
            return tokenizeJson(code);
        case 'markdown':
            return tokenizeMarkdown(code);
        default:
            return [{ type: null, text: code }];
    }
}
