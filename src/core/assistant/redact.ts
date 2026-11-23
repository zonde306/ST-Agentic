export const REDACTED_PLACEHOLDER = '***REDACTED***';

export const SECRET_KEY_PATTERN =
    /api[_-]?key|token|secret|password|authorization|cookie|bearer|private[_-]?key/i;

/**
 * LLM usage / accounting fields whose numeric values happen to contain the word "token"
 * (e.g. `inputTokens`, `cachedTokens`, `outputTokens`, `totalTokens`, `estimatedTokens`).
 * Only exempted when the associated value is a finite number so string credentials remain redacted.
 */
const SAFE_TOKEN_METRIC_KEY_PATTERN =
    /^(?:(?:input|output|cached|prompt|completion|reasoning|total|max|min|estimated|remaining|used|context|cache|watermark)[_-]?tokens?|tokens|token[_-]?(?:count|usage|budget|limit|rate|ratio|estimate|stats))$/i;

const PEM_PRIVATE_KEY_PATTERN =
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const HEADER_SECRET_PATTERN =
    /(\b(?:authorization|proxy-authorization|x-api-key|api[_-]?key|cookie|set-cookie)\s*:[ \t]*)([^\r\n]+)/gi;

const INLINE_JSON_STRING_FIELD_PATTERN = /("([^"\\]+)"\s*:\s*")((?:\\.|[^"\\])*)(")/g;

const BEARER_VALUE_PATTERN = /\bBearer\s+(?!\*\*\*REDACTED\*\*\*)[^\s"',;)\]}]+/gi;

const INLINE_CREDENTIAL_PATTERNS: readonly RegExp[] = [
    /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{6,}\b/g,
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{10,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{10,}\b/g,
    /\b(?:xoxb|xoxp|xoxa|xoxr|xoxs)-[A-Za-z0-9-]{10,}\b/g,
    /\bAIza[0-9A-Za-z_-]{20,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bwhsec_[A-Za-z0-9_-]{8,}\b/g,
];

const KEY_VALUE_ASSIGNMENT_PATTERN =
    /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret|password|passwd|token|cookie)[ \t]*=[ \t]*)([^\s&"',;)\]}]+)/gi;

const MAX_RECURSION_DEPTH = 64;

export interface RedactReport<T = unknown> {
    value: T;
    hasSecretRedaction: boolean;
    redactionCount: number;
}

interface RedactState {
    count: number;
    ancestors: Set<object>;
}

/**
 * Determine whether a property key represents a secret field.
 * Numeric LLM token-count metrics (e.g., `inputTokens: 1800`) are safely preserved.
 */
export function isSecretKey(key: string, value?: unknown): boolean {
    if (!key) {
        return false;
    }
    if (typeof value === 'number' && SAFE_TOKEN_METRIC_KEY_PATTERN.test(key)) {
        return false;
    }
    return SECRET_KEY_PATTERN.test(key);
}

function shouldRedactSecretKeyValue(value: unknown): boolean {
    if (value === null || value === undefined) {
        return false;
    }
    if (typeof value === 'string') {
        return value.length > 0 && value !== REDACTED_PLACEHOLDER;
    }
    return true;
}

function replaceWithCount(
    text: string,
    pattern: RegExp,
    replacement: string,
    state: RedactState,
): string {
    pattern.lastIndex = 0;
    return text.replace(pattern, (...args: unknown[]) => {
        const fullMatch = String(args[0]);
        const replaced = fullMatch.replace(new RegExp(pattern.source, pattern.flags.replace('g', '')), replacement);
        if (replaced !== fullMatch) {
            state.count += 1;
        }
        return replaced;
    });
}

function redactInlineString(input: string, state: RedactState): string {
    if (!input || input === REDACTED_PLACEHOLDER) {
        return input;
    }

    let out = input;

    out = replaceWithCount(out, PEM_PRIVATE_KEY_PATTERN, REDACTED_PLACEHOLDER, state);
    out = out.replace(
        INLINE_JSON_STRING_FIELD_PATTERN,
        (fullMatch: string, prefix: string, keyName: string, fieldVal: string, suffix: string) => {
            if (isSecretKey(keyName, fieldVal) && shouldRedactSecretKeyValue(fieldVal)) {
                state.count += 1;
                return `${prefix}${REDACTED_PLACEHOLDER}${suffix}`;
            }
            return fullMatch;
        },
    );
    out = out.replace(
        HEADER_SECRET_PATTERN,
        (fullMatch: string, prefix: string, rawVal: string) => {
            const trimmedVal = rawVal.trim();
            if (
                trimmedVal === '' ||
                trimmedVal === REDACTED_PLACEHOLDER ||
                /^Bearer\s+\*\*\*REDACTED\*\*\*$/i.test(trimmedVal)
            ) {
                return fullMatch;
            }
            state.count += 1;
            return `${prefix}${REDACTED_PLACEHOLDER}`;
        },
    );
    out = replaceWithCount(out, BEARER_VALUE_PATTERN, REDACTED_PLACEHOLDER, state);

    for (const pattern of INLINE_CREDENTIAL_PATTERNS) {
        out = replaceWithCount(out, pattern, REDACTED_PLACEHOLDER, state);
    }

    out = out.replace(
        KEY_VALUE_ASSIGNMENT_PATTERN,
        (fullMatch: string, prefix: string, rawVal: string) => {
            if (rawVal === REDACTED_PLACEHOLDER) {
                return fullMatch;
            }
            state.count += 1;
            return `${prefix}${REDACTED_PLACEHOLDER}`;
        },
    );

    return out;
}

function tryRedactJsonString(input: string, state: RedactState, depth: number): string | null {
    const trimmed = input.trim();
    const looksLikeJsonObject = trimmed.startsWith('{') && trimmed.endsWith('}');
    const looksLikeJsonArray = trimmed.startsWith('[') && trimmed.endsWith(']');
    if (!looksLikeJsonObject && !looksLikeJsonArray) {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }

    if (parsed === null || typeof parsed !== 'object') {
        return null;
    }

    const innerState: RedactState = {
        count: 0,
        ancestors: new Set<object>(),
    };
    const redactedParsed = redactValueInternal(parsed, innerState, depth + 1);
    if (innerState.count === 0) {
        return input;
    }

    state.count += innerState.count;
    return JSON.stringify(redactedParsed);
}

function redactStringInternal(input: string, state: RedactState, depth: number): string {
    if (!input || input === REDACTED_PLACEHOLDER) {
        return input;
    }

    if (depth < MAX_RECURSION_DEPTH) {
        const jsonResult = tryRedactJsonString(input, state, depth);
        if (jsonResult !== null) {
            return jsonResult;
        }
    }

    return redactInlineString(input, state);
}

function redactErrorInternal(err: Error, state: RedactState, depth: number): Error {
    if (state.ancestors.has(err)) {
        const circularErr = new Error('[Circular]');
        circularErr.name = err.name;
        return circularErr;
    }

    state.ancestors.add(err);
    try {
        const redactedMessage = redactStringInternal(err.message ?? '', state, depth + 1);
        const clone = new Error(redactedMessage);
        clone.name = err.name;

        if (typeof err.stack === 'string') {
            clone.stack = redactStringInternal(err.stack, state, depth + 1);
        }

        const errWithCause = err as Error & { cause?: unknown };
        if ('cause' in errWithCause && errWithCause.cause !== undefined) {
            (clone as Error & { cause?: unknown }).cause = redactValueInternal(
                errWithCause.cause,
                state,
                depth + 1,
            );
        }

        const record = err as unknown as Record<string, unknown>;
        const target = clone as unknown as Record<string, unknown>;
        for (const key of Object.keys(record)) {
            if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') {
                continue;
            }
            const propVal = record[key];
            if (isSecretKey(key, propVal)) {
                if (shouldRedactSecretKeyValue(propVal)) {
                    target[key] = REDACTED_PLACEHOLDER;
                    state.count += 1;
                } else {
                    target[key] = propVal;
                }
            } else {
                target[key] = redactValueInternal(propVal, state, depth + 1);
            }
        }

        return clone;
    } finally {
        state.ancestors.delete(err);
    }
}

function redactValueInternal(value: unknown, state: RedactState, depth: number): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (typeof value === 'string') {
        return redactStringInternal(value, state, depth);
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (depth >= MAX_RECURSION_DEPTH) {
        return '[MaxDepth]';
    }

    if (value instanceof Date) {
        return new Date(value.getTime());
    }

    if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags);
    }

    if (value instanceof Error) {
        return redactErrorInternal(value, state, depth);
    }

    if (state.ancestors.has(value)) {
        return '[Circular]';
    }

    state.ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => redactValueInternal(item, state, depth + 1));
        }

        if (value instanceof Map) {
            const nextMap = new Map<unknown, unknown>();
            for (const [entryKey, entryVal] of value.entries()) {
                const redactedKey = redactValueInternal(entryKey, state, depth + 1);
                if (typeof entryKey === 'string' && isSecretKey(entryKey, entryVal)) {
                    if (shouldRedactSecretKeyValue(entryVal)) {
                        nextMap.set(redactedKey, REDACTED_PLACEHOLDER);
                        state.count += 1;
                    } else {
                        nextMap.set(redactedKey, entryVal);
                    }
                } else {
                    nextMap.set(redactedKey, redactValueInternal(entryVal, state, depth + 1));
                }
            }
            return nextMap;
        }

        if (value instanceof Set) {
            const nextSet = new Set<unknown>();
            for (const item of value.values()) {
                nextSet.add(redactValueInternal(item, state, depth + 1));
            }
            return nextSet;
        }

        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
            const propVal = record[key];
            if (isSecretKey(key, propVal)) {
                if (shouldRedactSecretKeyValue(propVal)) {
                    result[key] = REDACTED_PLACEHOLDER;
                    state.count += 1;
                } else {
                    result[key] = propVal;
                }
            } else {
                result[key] = redactValueInternal(propVal, state, depth + 1);
            }
        }
        return result;
    } finally {
        state.ancestors.delete(value);
    }
}

/**
 * Redact inline secrets, Bearer tokens, PEM blocks, and embedded JSON credentials
 * within a single string, returning both the redacted string and redaction metadata.
 */
export function redactString(input: string): RedactReport<string> {
    const state: RedactState = { count: 0, ancestors: new Set<object>() };
    const value = redactStringInternal(input, state, 0);
    return {
        value,
        hasSecretRedaction: state.count > 0,
        redactionCount: state.count,
    };
}

/**
 * Recursively redact secrets across nested objects, arrays, Maps, Sets, Error instances,
 * and serialized JSON strings while handling circular references safely.
 */
export function redactWithReport<T>(value: T): RedactReport<T> {
    const state: RedactState = { count: 0, ancestors: new Set<object>() };
    const redacted = redactValueInternal(value, state, 0) as T;
    return {
        value: redacted,
        hasSecretRedaction: state.count > 0,
        redactionCount: state.count,
    };
}

/**
 * Convenience wrapper returning only the redacted clone of `value`.
 */
export function redactSecrets<T>(value: T): T {
    return redactWithReport(value).value;
}
