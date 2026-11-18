import type { ParsedDecorator, RawLoreEntry } from '@/core/types';

/** Legacy ST-CustomGeneration `@@` decorators supported for lossless migration and parsing. */
export const LEGACY_DECORATORS = [
    '@@replace',
    '@@replace_before',
    '@@replace_diff',
    '@@replace_diff_before',
    '@@replace_search',
    '@@replace_search_before',
    '@@variables_json',
    '@@variables_json_before',
    '@@variables_yaml',
    '@@variables_yaml_before',
    '@@variables_jsonpatch',
    '@@variables_jsonpatch_before',
    '@@evaluate_ejs',
    '@@evaluate_ejs_before',
    '@@replace_ejs',
    '@@replace_ejs_before',
    '@@append_output',
    '@@append_output_before',
    '@@append_output_ejs',
    '@@append_output_ejs_before',
    '@@replace_output',
    '@@replace_output_before',
    '@@replace_output_ejs',
    '@@replace_output_ejs_before',
    '@@batch_order',
    '@@preset',
    '@@json_schema',
    '@@zod_schema',
    '@@agent',
    '@@skill',
] as const;

/** SillyTavern native World Info decorators. */
export const ST_NATIVE_DECORATORS = [
    '@@activate',
    '@@dont_activate',
] as const;

/** New ST-Agentic structured decorators. */
export const AGENTIC_DECORATORS = [
    '@@trigger',
    '@@tool',
    '@@script',
    '@@group',
    '@@system',
] as const;

/** Complete set of recognized `@@` decorator names. */
export const KNOWN_DECORATORS: ReadonlySet<string> = new Set([
    ...LEGACY_DECORATORS,
    ...ST_NATIVE_DECORATORS,
    ...AGENTIC_DECORATORS,
]);

/** Decorators whose argument payload should be kept verbatim without quote-stripping. */
const VERBATIM_ARG_DECORATORS = new Set(['@@json_schema', '@@zod_schema']);

const PARAM_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;

function normalizeDecoratorName(name: string): string {
    return name.startsWith('@@') ? name : `@@${name}`;
}

interface TokenParseState {
    buffer: string;
    hasToken: boolean;
    startedQuoted: boolean;
    unquotedEqualsIndex: number;
}

function createEmptyTokenState(): TokenParseState {
    return {
        buffer: '',
        hasToken: false,
        startedQuoted: false,
        unquotedEqualsIndex: -1,
    };
}

function flushToken(
    state: TokenParseState,
    args: string[],
    params: Record<string, string>,
): void {
    if (!state.hasToken) {
        return;
    }

    const token = state.buffer;
    if (!state.startedQuoted && state.unquotedEqualsIndex > 0) {
        const key = token.slice(0, state.unquotedEqualsIndex);
        if (PARAM_KEY_PATTERN.test(key)) {
            params[key] = token.slice(state.unquotedEqualsIndex + 1);
            return;
        }
    }

    args.push(token);
}

/**
 * Split decorator arguments into positional `args` and `key=value` `params`,
 * supporting single/double quotes and backslash escapes while preserving verbatim JSON/Zod payloads.
 */
export function splitDecoratorArgs(
    rawArgs: string,
    decoratorName?: string,
): { args: string[]; params: Record<string, string> } {
    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return { args: [], params: {} };
    }

    if (
        (decoratorName && VERBATIM_ARG_DECORATORS.has(decoratorName))
        || trimmed.startsWith('{')
        || trimmed.startsWith('[')
    ) {
        return { args: [trimmed], params: {} };
    }

    const args: string[] = [];
    const params: Record<string, string> = {};

    let state = createEmptyTokenState();
    let inDoubleQuotes = false;
    let inSingleQuotes = false;
    let isEscaped = false;

    for (let i = 0; i < trimmed.length; i += 1) {
        const ch = trimmed[i];

        if (isEscaped) {
            state.buffer += ch;
            state.hasToken = true;
            isEscaped = false;
            continue;
        }

        if (ch === '\\') {
            isEscaped = true;
            continue;
        }

        if (ch === '"' && !inSingleQuotes) {
            if (!state.hasToken) {
                state.startedQuoted = true;
            }
            inDoubleQuotes = !inDoubleQuotes;
            state.hasToken = true;
            continue;
        }

        if (ch === "'" && !inDoubleQuotes) {
            if (!state.hasToken) {
                state.startedQuoted = true;
            }
            inSingleQuotes = !inSingleQuotes;
            state.hasToken = true;
            continue;
        }

        if (/\s/.test(ch) && !inDoubleQuotes && !inSingleQuotes) {
            flushToken(state, args, params);
            state = createEmptyTokenState();
            continue;
        }

        if (
            ch === '='
            && !inDoubleQuotes
            && !inSingleQuotes
            && state.unquotedEqualsIndex === -1
        ) {
            state.unquotedEqualsIndex = state.buffer.length;
        }

        state.buffer += ch;
        state.hasToken = true;
    }

    if (isEscaped) {
        state.buffer += '\\';
        state.hasToken = true;
    }

    flushToken(state, args, params);
    return { args, params };
}

/** Parse a single decorator line (e.g. `@@trigger phase=after order=1`). */
export function parseDecoratorLine(line: string): ParsedDecorator | null {
    const trimmedEnd = line.replace(/\r$/, '');
    if (!trimmedEnd.startsWith('@@')) {
        return null;
    }

    const wsMatch = /\s/.exec(trimmedEnd);
    const splitIndex = wsMatch ? wsMatch.index : -1;
    const name = splitIndex === -1 ? trimmedEnd : trimmedEnd.slice(0, splitIndex);
    const rawArgs = splitIndex === -1 ? '' : trimmedEnd.slice(splitIndex + 1).trim();
    const { args, params } = splitDecoratorArgs(rawArgs, name);

    return {
        name,
        rawArgs,
        args,
        params,
    };
}

export interface DecoratorParseResult {
    decorators: ParsedDecorator[];
    cleanContent: string;
}

/**
 * Parse leading `@@` decorators from World Info content and return both
 * the structured `ParsedDecorator[]` list and the stripped body text.
 */
export function parseDecorators(content: string): DecoratorParseResult {
    if (!content || !content.startsWith('@@')) {
        return { decorators: [], cleanContent: content ?? '' };
    }

    const decorators: ParsedDecorator[] = [];
    let lineStart = 0;
    let bodyStart = 0;
    let fallbacked = false;

    while (lineStart < content.length) {
        if (!content.startsWith('@@', lineStart)) {
            break;
        }

        const rawLineEnd = content.indexOf('\n', lineStart);
        const lineEnd = rawLineEnd === -1 ? content.length : rawLineEnd;
        const nextLineStart = rawLineEnd === -1 ? content.length : rawLineEnd + 1;

        const line = content.slice(lineStart, lineEnd).replace(/\r$/, '');
        const isEscaped = line.startsWith('@@@');
        if (isEscaped && !fallbacked) {
            break;
        }

        const candidate = isEscaped ? line.slice(1) : line;
        const parsed = parseDecoratorLine(candidate);

        if (parsed && KNOWN_DECORATORS.has(parsed.name)) {
            decorators.push(parsed);
            fallbacked = false;
            bodyStart = nextLineStart;
        } else {
            fallbacked = true;
        }

        if (rawLineEnd === -1) {
            break;
        }
        lineStart = nextLineStart;
    }

    if (decorators.length === 0) {
        return { decorators: [], cleanContent: content };
    }

    return {
        decorators,
        cleanContent: content.slice(bodyStart),
    };
}

/**
 * Parser for World Info `@@` decorators supporting legacy `ST-CustomGeneration`
 * decorators and new `ST-Agentic` structured decorators (`@@trigger`, `@@tool`,
 * `@@script`, `@@group`, `@@system`).
 */
export class DecoratorParser {
    public static readonly KNOWN_DECORATORS = KNOWN_DECORATORS;

    public readonly decorators: ParsedDecorator[];
    public readonly cleanContent: string;

    constructor(input: string | Pick<RawLoreEntry, 'content' | 'decorators'>) {
        const result = typeof input === 'string'
            ? DecoratorParser.parse(input)
            : DecoratorParser.parseEntry(input);
        this.decorators = result.decorators;
        this.cleanContent = result.cleanContent;
    }

    public static parse(content: string): DecoratorParseResult {
        return parseDecorators(content);
    }

    public static parseEntry(
        entry: Pick<RawLoreEntry, 'content' | 'decorators'>,
    ): DecoratorParseResult {
        const fromContent = parseDecorators(entry.content ?? '');
        if (fromContent.decorators.length > 0) {
            return fromContent;
        }

        if (!entry.decorators || entry.decorators.length === 0) {
            return fromContent;
        }

        const parsedList: ParsedDecorator[] = [];
        for (const raw of entry.decorators) {
            const candidate = raw.startsWith('@@') ? raw : `@@${raw}`;
            const parsed = parseDecoratorLine(candidate);
            if (parsed) {
                parsedList.push(parsed);
            }
        }

        return {
            decorators: parsedList,
            cleanContent: entry.content ?? '',
        };
    }

    public static isKnownDecorator(name: string): boolean {
        return KNOWN_DECORATORS.has(normalizeDecoratorName(name));
    }

    public has(name: string): boolean {
        const target = normalizeDecoratorName(name);
        return this.decorators.some((d) => d.name === target);
    }

    public get(name: string): ParsedDecorator | undefined {
        const target = normalizeDecoratorName(name);
        return this.decorators.find((d) => d.name === target);
    }

    public getAll(name: string): ParsedDecorator[] {
        const target = normalizeDecoratorName(name);
        return this.decorators.filter((d) => d.name === target);
    }

    public args(name: string): string[] {
        return this.get(name)?.args ?? [];
    }

    public params(name: string): Record<string, string> {
        return this.get(name)?.params ?? {};
    }

    public rawArgs(name: string): string | undefined {
        return this.get(name)?.rawArgs;
    }
}
