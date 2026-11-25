import type { EjsEvaluateOptions, HostBridge } from '@/core/bridge';
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

/** ST-Prompt-Template World Info decorators (16 total including @@activate / @@dont_activate). */
export const EJS_TEMPLATE_DECORATORS = [
    '@@if',
    '@@private',
    '@@preload',
    '@@only_preload',
    '@@dont_preload',
    '@@initial_variables',
    '@@always_enabled',
    '@@generate_before',
    '@@generate_after',
    '@@render_before',
    '@@render_after',
    '@@message_formatting',
    '@@iframe',
    '@@preprocessing',
    '@@dont_deactivate',
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
    ...EJS_TEMPLATE_DECORATORS,
    ...AGENTIC_DECORATORS,
]);

/** Decorators whose argument payload should be kept verbatim without quote-stripping. */
const VERBATIM_ARG_DECORATORS = new Set(['@@json_schema', '@@zod_schema', '@@if', '@@iframe']);

const EJS_SPECIAL_DECORATORS = new Set([
    '@@initial_variables',
    '@@only_preload',
    '@@generate_before',
    '@@generate_after',
    '@@render_before',
    '@@render_after',
]);

const EJS_FORCE_DISABLED_DECORATORS = new Set([
    '@@dont_activate',
    '@@dont_deactivate',
]);

const COMMENT_SPECIAL_PATTERN = /\[(?:initialvariables|generate:[^\]]*|render:[^\]]*)\]|@INJECT\b/i;
const GENERATE_BEFORE_PATTERN = /\[generate:before\]/i;

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

function resolveParsedDecorators(
    entry: Pick<RawLoreEntry, 'content' | 'decorators'>,
    decorators?: readonly ParsedDecorator[],
): readonly ParsedDecorator[] {
    return decorators ?? DecoratorParser.parseEntry(entry).decorators;
}

/**
 * Check whether an entry is an `ST-Prompt-Template` special entry that must be
 * excluded from normal context/VFS exposure (`@@render_*`, `@@generate_*`,
 * `@@only_preload`, `@@initial_variables`, `[InitialVariables]`, `[GENERATE:*]`,
 * `[RENDER:*]`, `@INJECT`).
 */
export function isEjsSpecialEntry(
    entry: Pick<RawLoreEntry, 'comment' | 'content' | 'decorators'>,
    decorators?: readonly ParsedDecorator[],
): boolean {
    const resolved = resolveParsedDecorators(entry, decorators);
    if (resolved.some((d) => EJS_SPECIAL_DECORATORS.has(d.name))) {
        return true;
    }
    if (COMMENT_SPECIAL_PATTERN.test(entry.comment ?? '')) {
        return true;
    }
    return false;
}

/** Check whether decorators force-disable this entry (`@@dont_activate` / `@@dont_deactivate`). */
export function isEjsForceDisabledEntry(decorators: readonly ParsedDecorator[]): boolean {
    return decorators.some((d) => EJS_FORCE_DISABLED_DECORATORS.has(d.name));
}

/** Check whether an entry is a `@@generate_before` / `[GENERATE:BEFORE]` entry. */
export function isEjsGenerateBeforeEntry(
    entry: Pick<RawLoreEntry, 'comment' | 'content' | 'decorators'>,
    decorators?: readonly ParsedDecorator[],
    cleanContent?: string,
): boolean {
    const resolved = resolveParsedDecorators(entry, decorators);
    if (resolved.some((d) => d.name === '@@generate_before')) {
        return true;
    }
    if (GENERATE_BEFORE_PATTERN.test(entry.comment ?? '')) {
        return true;
    }
    const body = cleanContent ?? DecoratorParser.parseEntry(entry).cleanContent;
    return GENERATE_BEFORE_PATTERN.test(body);
}

/**
 * Evaluate whether an entry is enabled under `ST-Prompt-Template` semantics,
 * honoring `@@always_enabled` and `invert_enabled` on special entries.
 */
export function isEjsEntryEnabled(
    entry: Pick<RawLoreEntry, 'disable' | 'comment' | 'content' | 'decorators'>,
    decorators?: readonly ParsedDecorator[],
    options?: { invertEnabled?: boolean },
): boolean {
    const resolved = resolveParsedDecorators(entry, decorators);
    if (isEjsForceDisabledEntry(resolved)) {
        return false;
    }
    if (resolved.some((d) => d.name === '@@always_enabled')) {
        return true;
    }
    if (options?.invertEnabled && isEjsSpecialEntry(entry, resolved)) {
        return Boolean(entry.disable);
    }
    return !entry.disable;
}

/** Extract all `@@if <expr>` condition expressions in declaration order. */
export function extractIfConditions(decorators: readonly ParsedDecorator[]): string[] {
    const conditions: string[] = [];
    for (const dec of decorators) {
        if (dec.name === '@@if') {
            const expr = dec.rawArgs.trim();
            if (expr) {
                conditions.push(expr);
            }
        }
    }
    return conditions;
}

/** Check whether `@@private` is declared on the entry. */
export function hasPrivateDecorator(decorators: readonly ParsedDecorator[]): boolean {
    return decorators.some((d) => d.name === '@@private');
}

/**
 * Evaluate `@@if <expr>` conditions using `HostBridge.evaluateOptionalEjs`.
 * Degrades gracefully by returning `true` (and emitting a deduplicated warning) when
 * `ST-Prompt-Template` is unavailable or when an expression fails to evaluate.
 */
export async function evaluateIfConditions(
    conditions: readonly string[],
    hostBridge: Pick<HostBridge, 'evaluateOptionalEjs' | 'reportCompatWarning'> | undefined,
    vars: Record<string, unknown>,
    options?: EjsEvaluateOptions,
): Promise<boolean> {
    if (!conditions || conditions.length === 0) {
        return true;
    }

    if (!hostBridge?.evaluateOptionalEjs) {
        hostBridge?.reportCompatWarning?.(
            'ejs_missing_for_if',
            '检测到世界书包含 @@if 条件装饰器，但未安装或未启用 ST-Prompt-Template；条件将按兼容降级模式默认放行。',
        );
        return true;
    }

    for (const expr of conditions) {
        const trimmedExpr = expr.trim();
        if (!trimmedExpr) {
            continue;
        }
        try {
            const evaluated = await hostBridge.evaluateOptionalEjs(
                `<%- !!(${trimmedExpr}) %>`,
                vars,
                options,
            );
            if (evaluated.trim() === 'false') {
                return false;
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            hostBridge.reportCompatWarning?.(
                `ejs_if_eval_error:${trimmedExpr}`,
                `@@if 条件表达式 (${trimmedExpr}) 求值出错，已降级放行：${msg}`,
            );
        }
    }

    return true;
}
