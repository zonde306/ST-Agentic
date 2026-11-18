import type { RegexRule, RegexStage } from '../types';

/** Target message/content origin used to filter `RegexRule` execution. */
export type RegexSender = 'user' | 'assistant' | 'lore';

/** Successful regex compilation outcome (`regex` is `null` for an empty pattern no-op). */
export interface CompiledRegexSuccess {
    ok: true;
    regex: RegExp | null;
    isLiteral: boolean;
}

/** Failed regex compilation outcome containing a diagnostic error message. */
export interface CompiledRegexFailure {
    ok: false;
    regex: null;
    isLiteral: false;
    error: string;
}

export type CompiledRegexResult = CompiledRegexSuccess | CompiledRegexFailure;

/** A `RegexRule` paired with its compiled `CompiledRegexResult`. */
export interface CompiledRegexRule {
    rule: RegexRule;
    compiled: CompiledRegexResult;
}

const VALID_REGEX_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
const REGEX_LITERAL_PATTERN = /^\/([\s\S]*)\/([a-zA-Z]*)$/;

/** Escape all JavaScript regular expression metacharacters for literal substring matching. */
export function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasUnescapedSlash(body: string): boolean {
    let escaped = false;
    for (let i = 0; i < body.length; i += 1) {
        const ch = body[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '/') {
            return true;
        }
    }
    return false;
}

function validateFlags(flags: string): string | null {
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i += 1) {
        const ch = flags[i];
        if (!VALID_REGEX_FLAGS.has(ch)) {
            return `Invalid regex flag "${ch}" in "${flags}"`;
        }
        if (seen.has(ch)) {
            return `Duplicate regex flag "${ch}" in "${flags}"`;
        }
        seen.add(ch);
    }

    if (seen.has('u') && seen.has('v')) {
        return 'Regex flags "u" and "v" cannot be used together';
    }

    return null;
}

function compileLiteral(pattern: string): CompiledRegexResult {
    try {
        return {
            ok: true,
            regex: new RegExp(escapeRegExp(pattern), 'g'),
            isLiteral: true,
        };
    } catch (error) {
        return {
            ok: false,
            regex: null,
            isLiteral: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Compile a `RegexRule.pattern` supporting `/pattern/flags` syntax and plain literal text matching.
 * Never throws; invalid regex syntax yields `{ ok: false, error }` for safe fallback.
 */
export function compileRegexPattern(pattern: string): CompiledRegexResult {
    if (typeof pattern !== 'string') {
        return {
            ok: false,
            regex: null,
            isLiteral: false,
            error: 'Regex pattern must be a string',
        };
    }

    if (pattern.length === 0) {
        return {
            ok: true,
            regex: null,
            isLiteral: false,
        };
    }

    const literalMatch = REGEX_LITERAL_PATTERN.exec(pattern);
    if (!literalMatch) {
        return compileLiteral(pattern);
    }

    const [, body, flags] = literalMatch;

    // A bare `//` without flags is treated as literal text matching `//`.
    if (body.length === 0 && flags.length === 0) {
        return compileLiteral(pattern);
    }

    if (body.length === 0) {
        return {
            ok: false,
            regex: null,
            isLiteral: false,
            error: 'Empty regex body with flags is not allowed',
        };
    }

    const flagError = validateFlags(flags);
    if (flagError) {
        // Paths like `/usr/bin/env` contain unescaped internal slashes and are literal text.
        if (hasUnescapedSlash(body)) {
            return compileLiteral(pattern);
        }
        return {
            ok: false,
            regex: null,
            isLiteral: false,
            error: flagError,
        };
    }

    try {
        return {
            ok: true,
            regex: new RegExp(body, flags),
            isLiteral: false,
        };
    } catch (error) {
        return {
            ok: false,
            regex: null,
            isLiteral: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Compile a full `RegexRule` into a `{ rule, compiled }` pair. */
export function compileRegexRule(rule: RegexRule): CompiledRegexRule {
    return {
        rule,
        compiled: compileRegexPattern(rule.pattern),
    };
}

/**
 * Determine whether `rule` should run in the given cache-safe `stage` for `sender`.
 * - `lore_read` rules run when `stage === 'lore_read'` and `sender` is `'lore'` (or omitted).
 * - `display` and `ingest` rules require `sender` `'user'` (`applyToUser`) or `'assistant'` (`applyToAssistant`).
 */
export function shouldApplyRegexRule(
    rule: RegexRule,
    stage: RegexStage,
    sender?: RegexSender,
): boolean {
    if (!rule.enabled || rule.stage !== stage) {
        return false;
    }

    if (stage === 'lore_read') {
        return (sender ?? 'lore') === 'lore';
    }

    if (sender === 'user') {
        return Boolean(rule.applyToUser);
    }

    if (sender === 'assistant') {
        return Boolean(rule.applyToAssistant);
    }

    return false;
}
