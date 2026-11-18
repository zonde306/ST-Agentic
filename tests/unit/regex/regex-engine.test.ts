import { describe, expect, it, vi } from 'vitest';
import type { RegexRule } from '@/core/types';
import {
    applyRegexRules,
    applyRegexRulesWithReport,
    compileRegexPattern,
    RegexPipeline,
    shouldApplyRegexRule,
    testRegexRule,
} from '@/core/regex';

function makeRule(overrides: Partial<RegexRule> = {}): RegexRule {
    return {
        id: 'r1',
        name: 'Rule 1',
        pattern: '/foo/g',
        replace: 'bar',
        stage: 'display',
        applyToUser: false,
        applyToAssistant: true,
        enabled: true,
        ...overrides,
    };
}

describe('src/core/regex engine', () => {
    it('compiles /pattern/flags and plain literal text safely', () => {
        const regexCompiled = compileRegexPattern('/<status>([\\s\\S]*?)<\\/status>/gi');
        expect(regexCompiled.ok).toBe(true);
        expect(regexCompiled.isLiteral).toBe(false);
        expect(regexCompiled.regex).toBeInstanceOf(RegExp);
        expect(regexCompiled.regex?.flags).toContain('g');
        expect(regexCompiled.regex?.flags).toContain('i');

        const unescapedInternalSlash = compileRegexPattern('/<think>[\\s\\S]*?</think>/g');
        expect(unescapedInternalSlash.ok).toBe(true);
        expect(unescapedInternalSlash.isLiteral).toBe(false);

        const literalWithMetachars = compileRegexPattern('[DEBUG] (v1.0) $price');
        expect(literalWithMetachars.ok).toBe(true);
        expect(literalWithMetachars.isLiteral).toBe(true);

        const pathLiteral = compileRegexPattern('/state/variables.json');
        expect(pathLiteral.ok).toBe(true);
        expect(pathLiteral.isLiteral).toBe(true);

        const unixPathLiteral = compileRegexPattern('/usr/bin/env');
        expect(unixPathLiteral.ok).toBe(true);
        expect(unixPathLiteral.isLiteral).toBe(true);

        const emptyPattern = compileRegexPattern('');
        expect(emptyPattern.ok).toBe(true);
        expect(emptyPattern.regex).toBeNull();
    });

    it('supports numbered ($1, $2), named ($<name>), and escaped ($$) capture replacements', () => {
        const numbered = testRegexRule(
            { pattern: '/(\\w+)-(\\d+)/g', replace: '$2:$1' },
            'item-12 and box-99',
        );
        expect(numbered).toEqual({
            output: '12:item and 99:box',
            matched: true,
            valid: true,
        });

        const named = testRegexRule(
            { pattern: '/(?<key>[a-z]+)=(?<val>\\d+)/g', replace: '[$<key> -> $<val>]' },
            'hp=85 mp=40',
        );
        expect(named).toEqual({
            output: '[hp -> 85] [mp -> 40]',
            matched: true,
            valid: true,
        });

        const literal = testRegexRule(
            { pattern: '[HP: 100]', replace: '$$100 (full)' },
            'Status [HP: 100] now [HP: 100]',
        );
        expect(literal).toEqual({
            output: 'Status $100 (full) now $100 (full)',
            matched: true,
            valid: true,
        });
    });

    it('filters rules accurately by stage (display, ingest, lore_read) and sender', () => {
        const rules: RegexRule[] = [
            makeRule({
                id: 'display_ai',
                stage: 'display',
                pattern: '/<think>([\\s\\S]*?)<\\/think>/g',
                replace: '[thought: $1]',
                applyToUser: false,
                applyToAssistant: true,
            }),
            makeRule({
                id: 'display_user',
                stage: 'display',
                pattern: '/\\[OOC\\]/g',
                replace: '(OOC)',
                applyToUser: true,
                applyToAssistant: false,
            }),
            makeRule({
                id: 'ingest_ai',
                stage: 'ingest',
                pattern: '/<debug>[\\s\\S]*?<\\/debug>/g',
                replace: '',
                applyToUser: false,
                applyToAssistant: true,
            }),
            makeRule({
                id: 'lore_clean',
                stage: 'lore_read',
                pattern: '/<!--([\\s\\S]*?)-->/g',
                replace: '',
                applyToUser: false,
                applyToAssistant: false,
            }),
            makeRule({
                id: 'disabled_rule',
                stage: 'display',
                pattern: '/secret/g',
                replace: '***',
                applyToUser: true,
                applyToAssistant: true,
                enabled: false,
            }),
        ];

        expect(shouldApplyRegexRule(rules[3], 'lore_read', 'lore')).toBe(true);
        expect(shouldApplyRegexRule(rules[3], 'lore_read', 'assistant')).toBe(false);
        expect(shouldApplyRegexRule(rules[0], 'display', 'lore')).toBe(false);

        const aiDisplayOut = applyRegexRules(
            '<think>plan</think>Hello [OOC] <debug>x</debug> <!--c--> secret',
            rules,
            { stage: 'display', sender: 'assistant' },
        );
        expect(aiDisplayOut).toBe('[thought: plan]Hello [OOC] <debug>x</debug> <!--c--> secret');

        const userDisplayOut = applyRegexRules(
            '<think>plan</think>Hello [OOC] <debug>x</debug>',
            rules,
            { stage: 'display', sender: 'user' },
        );
        expect(userDisplayOut).toBe('<think>plan</think>Hello (OOC) <debug>x</debug>');

        const aiIngestOut = applyRegexRules(
            '<think>plan</think>Hello <debug>internal</debug>',
            rules,
            { stage: 'ingest', sender: 'assistant' },
        );
        expect(aiIngestOut).toBe('<think>plan</think>Hello ');

        const loreOut = applyRegexRules(
            'Lore body <!-- hidden author note --> <debug>keep</debug>',
            rules,
            { stage: 'lore_read', sender: 'lore' },
        );
        expect(loreOut).toBe('Lore body  <debug>keep</debug>');

        // `sender` defaults to `'lore'` for `lore_read` stage when omitted
        expect(
            applyRegexRules('A <!-- note --> B', rules, { stage: 'lore_read' }),
        ).toBe('A  B');
    });

    it('falls back safely without throwing on invalid regex syntax', () => {
        const onError = vi.fn();
        const rules: RegexRule[] = [
            makeRule({
                id: 'broken_bracket',
                name: 'Broken Bracket',
                pattern: '/[unclosed/g',
                replace: 'X',
                stage: 'ingest',
            }),
            makeRule({
                id: 'bad_flag',
                name: 'Bad Flag',
                pattern: '/hello/z',
                replace: 'hi',
                stage: 'ingest',
            }),
            makeRule({
                id: 'dup_flag',
                name: 'Duplicate Flag',
                pattern: '/hello/gg',
                replace: 'hi',
                stage: 'ingest',
            }),
            makeRule({
                id: 'valid_rule',
                name: 'Valid Cleanup',
                pattern: '/world/g',
                replace: 'ST-Agentic',
                stage: 'ingest',
            }),
        ];

        const report = applyRegexRulesWithReport('hello [unclosed world', rules, {
            stage: 'ingest',
            sender: 'assistant',
            onError,
        });

        expect(report.output).toBe('hello [unclosed ST-Agentic');
        expect(report.appliedRuleIds).toEqual(['valid_rule']);
        expect(report.errors).toHaveLength(3);
        expect(report.errors.map((e) => e.ruleId)).toEqual([
            'broken_bracket',
            'bad_flag',
            'dup_flag',
        ]);
        expect(onError).toHaveBeenCalledTimes(3);

        const previewBroken = testRegexRule({ pattern: '/(unclosed/i', replace: 'x' }, 'abc');
        expect(previewBroken.valid).toBe(false);
        expect(previewBroken.matched).toBe(false);
        expect(previewBroken.output).toBe('abc');
        expect(previewBroken.error).toBeTruthy();
    });

    it('RegexPipeline caches compilations and resets global/sticky regex state', () => {
        const pipeline = new RegexPipeline([
            makeRule({
                id: 'sticky_or_global',
                pattern: '/\\d+/gy',
                replace: 'N',
                stage: 'display',
                applyToAssistant: true,
            }),
            makeRule({
                id: 'global_tag',
                pattern: '/\\[(\\w+)\\]/g',
                replace: '<$1>',
                stage: 'display',
                applyToAssistant: true,
            }),
        ]);

        const first = pipeline.run('12 [tag] 34', { stage: 'display', sender: 'assistant' });
        const second = pipeline.run('99 [other]', { stage: 'display', sender: 'assistant' });

        expect(first).toBe('N <tag> 34');
        expect(second).toBe('N <other>');
    });
});
