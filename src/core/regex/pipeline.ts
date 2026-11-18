import type { RegexRule, RegexStage } from '../types';
import {
    compileRegexPattern,
    shouldApplyRegexRule,
    type CompiledRegexResult,
    type RegexSender,
} from './compiler';

/** Options controlling which `RegexRule`s are selected during pipeline execution. */
export interface RegexExecutionOptions {
    stage: RegexStage;
    sender?: RegexSender;
    onError?: (rule: RegexRule, error: string) => void;
}

/** Outcome of executing a single compiled regex rule against input text. */
export interface RegexApplyResult {
    output: string;
    matched: boolean;
    valid: boolean;
    error?: string;
}

/** Diagnostic entry emitted when a rule fails compilation or execution. */
export interface RegexRuleError {
    ruleId: string;
    ruleName: string;
    error: string;
}

/** Full execution report returned by `applyRegexRulesWithReport`. */
export interface RegexPipelineReport {
    output: string;
    appliedRuleIds: string[];
    errors: RegexRuleError[];
}

/**
 * Execute a compiled regex result against `text` with `$1`, `$2`, `$<name>`, `$$`, and `$&`
 * capture replacement semantics. Falls back safely to returning `text` unchanged on invalid syntax.
 */
export function applyCompiledRegex(
    text: string,
    compiled: CompiledRegexResult,
    replace: string,
): RegexApplyResult {
    const input = typeof text === 'string' ? text : String(text ?? '');
    const replacement = typeof replace === 'string' ? replace : String(replace ?? '');

    if (!compiled.ok) {
        return {
            output: input,
            matched: false,
            valid: false,
            error: compiled.error,
        };
    }

    if (!compiled.regex) {
        return {
            output: input,
            matched: false,
            valid: true,
        };
    }

    try {
        compiled.regex.lastIndex = 0;
        const matched = compiled.regex.test(input);
        compiled.regex.lastIndex = 0;
        const output = matched ? input.replace(compiled.regex, replacement) : input;
        compiled.regex.lastIndex = 0;
        return {
            output,
            matched,
            valid: true,
        };
    } catch (error) {
        return {
            output: input,
            matched: false,
            valid: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Test a single regex rule against sample text (ignoring `enabled`, `stage`, and sender flags),
 * returning replaced output, match boolean, and syntax validation feedback for live UI preview.
 */
export function testRegexRule(
    rule: Pick<RegexRule, 'pattern' | 'replace'>,
    sample: string,
): RegexApplyResult {
    const compiled = compileRegexPattern(rule.pattern);
    return applyCompiledRegex(sample, compiled, rule.replace);
}

/**
 * Execute all matching rules for `(stage, sender)` sequentially and return the transformed text
 * along with applied rule IDs and safe error diagnostics.
 */
export function applyRegexRulesWithReport(
    text: string,
    rules: readonly RegexRule[],
    options: RegexExecutionOptions,
    compileCache?: Map<string, CompiledRegexResult>,
): RegexPipelineReport {
    let current = typeof text === 'string' ? text : String(text ?? '');
    const appliedRuleIds: string[] = [];
    const errors: RegexRuleError[] = [];

    for (const rule of rules) {
        if (!shouldApplyRegexRule(rule, options.stage, options.sender)) {
            continue;
        }

        const compiled = compileCache
            ? getOrCompileCached(compileCache, rule.pattern)
            : compileRegexPattern(rule.pattern);

        const res = applyCompiledRegex(current, compiled, rule.replace);
        if (!res.valid && res.error) {
            errors.push({
                ruleId: rule.id,
                ruleName: rule.name,
                error: res.error,
            });
            options.onError?.(rule, res.error);
            continue;
        }

        current = res.output;
        if (res.matched) {
            appliedRuleIds.push(rule.id);
        }
    }

    return {
        output: current,
        appliedRuleIds,
        errors,
    };
}

/**
 * Execute all matching rules for `(stage, sender)` sequentially and return the resulting string.
 * Invalid regex rules are safely skipped without throwing.
 */
export function applyRegexRules(
    text: string,
    rules: readonly RegexRule[],
    options: RegexExecutionOptions,
): string {
    return applyRegexRulesWithReport(text, rules, options).output;
}

const MAX_CACHE_ENTRIES = 512;

function getOrCompileCached(
    cache: Map<string, CompiledRegexResult>,
    pattern: string,
): CompiledRegexResult {
    const cached = cache.get(pattern);
    if (cached) {
        return cached;
    }

    const compiled = compileRegexPattern(pattern);
    if (cache.size >= MAX_CACHE_ENTRIES) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey !== undefined) {
            cache.delete(oldestKey);
        }
    }
    cache.set(pattern, compiled);
    return compiled;
}

/**
 * Stateful regex pipeline holding a rule list and a bounded pattern compilation cache.
 */
export class RegexPipeline {
    private rules: RegexRule[];
    private readonly compileCache = new Map<string, CompiledRegexResult>();

    constructor(rules: readonly RegexRule[] = []) {
        this.rules = [...rules];
    }

    getRules(): readonly RegexRule[] {
        return this.rules;
    }

    setRules(rules: readonly RegexRule[]): void {
        this.rules = [...rules];
    }

    compile(pattern: string): CompiledRegexResult {
        return getOrCompileCached(this.compileCache, pattern);
    }

    run(text: string, options: RegexExecutionOptions): string {
        return applyRegexRulesWithReport(text, this.rules, options, this.compileCache).output;
    }

    runWithReport(text: string, options: RegexExecutionOptions): RegexPipelineReport {
        return applyRegexRulesWithReport(text, this.rules, options, this.compileCache);
    }

    clearCache(): void {
        this.compileCache.clear();
    }
}
