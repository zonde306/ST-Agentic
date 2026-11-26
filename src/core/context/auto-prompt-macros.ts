import { matchesPromptTriggers } from '@/core/config';
import type { PromptBlock, PromptTriggerContext } from '@/core/types';

export type Layer0AutoPromptMacroKey = 'systemBase' | 'coreManifest' | 'systemRules';

export type Layer2AutoPromptMacroKey =
    | 'turnBrief'
    | 'sideBrief'
    | 'workspaceNotice'
    | 'dynamicReminders'
    | 'loreHint'
    | 'sideHint';

export type OffMainlineAutoPromptMacroKey = 'assistantSystemPrompt';

export type AutoPromptMacroKey =
    | Layer0AutoPromptMacroKey
    | Layer2AutoPromptMacroKey
    | OffMainlineAutoPromptMacroKey;

export const LAYER0_AUTO_PROMPT_KEYS: readonly Layer0AutoPromptMacroKey[] = [
    'systemBase',
    'coreManifest',
    'systemRules',
];

export const LAYER2_AUTO_PROMPT_KEYS: readonly Layer2AutoPromptMacroKey[] = [
    'turnBrief',
    'sideBrief',
    'workspaceNotice',
    'dynamicReminders',
    'loreHint',
    'sideHint',
];

export const OFF_MAINLINE_AUTO_PROMPT_KEYS: readonly OffMainlineAutoPromptMacroKey[] = [
    'assistantSystemPrompt',
];

export const ALL_AUTO_PROMPT_KEYS: readonly AutoPromptMacroKey[] = [
    ...LAYER0_AUTO_PROMPT_KEYS,
    ...LAYER2_AUTO_PROMPT_KEYS,
    ...OFF_MAINLINE_AUTO_PROMPT_KEYS,
];

export const AUTO_PROMPT_MACRO_ALIASES: Readonly<Record<AutoPromptMacroKey, readonly string[]>> = {
    systemBase: ['systemBase', 'system_base', 'system-base'],
    coreManifest: ['coreManifest', 'core_manifest', 'core-manifest'],
    systemRules: ['systemRules', 'system_rules', 'system-rules'],
    turnBrief: ['turnBrief', 'turn_brief', 'turn-brief'],
    sideBrief: ['sideBrief', 'side_brief', 'side-brief'],
    workspaceNotice: ['workspaceNotice', 'workspace_notice', 'workspace-notice'],
    dynamicReminders: ['dynamicReminders', 'dynamic_reminders', 'dynamic-reminders'],
    loreHint: ['loreHint', 'lore_hint', 'lore-hint'],
    sideHint: ['sideHint', 'side_hint', 'side-hint'],
    assistantSystemPrompt: [
        'assistantSystemPrompt',
        'assistant_system_prompt',
        'assistant-system-prompt',
    ],
};

const ALIAS_LOWER_TO_KEY = new Map<string, AutoPromptMacroKey>();
const ALIAS_LOWER_LIST: string[] = [];

for (const key of ALL_AUTO_PROMPT_KEYS) {
    for (const alias of AUTO_PROMPT_MACRO_ALIASES[key]) {
        const lower = alias.toLowerCase();
        ALIAS_LOWER_TO_KEY.set(lower, key);
        ALIAS_LOWER_LIST.push(lower);
    }
}

export const AUTO_PROMPT_MACRO_ALIAS_LOWER_SET: ReadonlySet<string> = new Set(ALIAS_LOWER_LIST);

const AUTO_PROMPT_MACRO_TOKEN_RE = /\{\{\s*([a-zA-Z][\w-]*)\s*\}\}/g;

/**
 * Extract canonical `AutoPromptMacroKey`s referenced via `{{...}}` (camelCase, snake_case, or kebab-case)
 * inside a prompt text or JSON template.
 */
export function extractAutoPromptMacroKeys(text: string): Set<AutoPromptMacroKey> {
    const keys = new Set<AutoPromptMacroKey>();
    if (!text || !text.includes('{{')) {
        return keys;
    }
    AUTO_PROMPT_MACRO_TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = AUTO_PROMPT_MACRO_TOKEN_RE.exec(text)) !== null) {
        const lower = match[1].toLowerCase();
        const canonical = ALIAS_LOWER_TO_KEY.get(lower);
        if (canonical) {
            keys.add(canonical);
        }
    }
    return keys;
}

export interface ClaimedAutoPromptMacros {
    all: Set<AutoPromptMacroKey>;
    prefix: Set<AutoPromptMacroKey>;
    tail: Set<AutoPromptMacroKey>;
}

/**
 * Scan active, trigger-matching `PromptBlock`s (and optional explicit `systemBasePrompt`)
 * to determine which auto-injected blocks are explicitly claimed by preset macros.
 */
export function detectClaimedAutoPromptMacros(input: {
    promptBlocks?: readonly PromptBlock[];
    systemBasePrompt?: string;
    promptTriggerContext?: PromptTriggerContext;
}): ClaimedAutoPromptMacros {
    const all = new Set<AutoPromptMacroKey>();
    const prefix = new Set<AutoPromptMacroKey>();
    const tail = new Set<AutoPromptMacroKey>();

    const record = (text: string, placement: 'prefix' | 'tail') => {
        for (const key of extractAutoPromptMacroKeys(text)) {
            all.add(key);
            if (placement === 'prefix') {
                prefix.add(key);
            } else {
                tail.add(key);
            }
        }
    };

    const promptBlocks = input.promptBlocks ?? [];
    if (input.systemBasePrompt !== undefined) {
        record(input.systemBasePrompt, 'prefix');
    } else {
        const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
        if (
            systemBaseBlock
            && systemBaseBlock.enabled
            && systemBaseBlock.content.trim().length > 0
            && matchesPromptTriggers(systemBaseBlock.triggers, input.promptTriggerContext)
        ) {
            record(systemBaseBlock.content, 'prefix');
        }
    }

    for (const block of promptBlocks) {
        if (
            block.id === 'system_base'
            || !block.enabled
            || block.content.trim().length === 0
            || !matchesPromptTriggers(block.triggers, input.promptTriggerContext)
        ) {
            continue;
        }
        if (block.placement === 'prefix') {
            record(block.content, 'prefix');
        } else if (block.placement === 'tail' || block.placement === 'floating_tail') {
            record(block.content, 'tail');
        }
    }

    return { all, prefix, tail };
}

/**
 * Expand canonical auto-prompt macro values across all supported alias spellings
 * (`camelCase`, `snake_case`, `kebab-case`) for `macroOverrides`.
 */
export function buildAutoPromptMacroOverrides(
    values: Partial<Record<AutoPromptMacroKey, string>>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of ALL_AUTO_PROMPT_KEYS) {
        const value = values[key];
        if (value === undefined) {
            continue;
        }
        for (const alias of AUTO_PROMPT_MACRO_ALIASES[key]) {
            out[alias] = value;
        }
    }
    return out;
}

/**
 * Check whether any alias of `key` is already present in `overrides` (case-insensitive).
 */
export function hasAutoPromptMacroOverride(
    overrides: Record<string, string> | undefined,
    key: AutoPromptMacroKey,
): boolean {
    if (!overrides) {
        return false;
    }
    const targetAliases = new Set(AUTO_PROMPT_MACRO_ALIASES[key].map((a) => a.toLowerCase()));
    for (const existingKey of Object.keys(overrides)) {
        if (targetAliases.has(existingKey.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Return a shallow copy of `overrides` omitting all auto-prompt macro aliases (case-insensitive)
 * so auto-prompt tokens can stay unexpanded across EJS evaluation and expand verbatim afterwards.
 */
export function omitAutoPromptMacroOverrides(
    overrides?: Record<string, string>,
): Record<string, string> | undefined {
    if (!overrides) {
        return undefined;
    }
    const filtered: Record<string, string> = {};
    for (const [key, val] of Object.entries(overrides)) {
        if (!AUTO_PROMPT_MACRO_ALIAS_LOWER_SET.has(key.toLowerCase())) {
            filtered[key] = val;
        }
    }
    return filtered;
}

/**
 * Single-pass fallback substitution for auto-prompt macros when `hostBridge` is omitted
 * or when expanding deferred auto-prompt macros verbatim after EJS/transform hooks.
 * Leaves all non-auto-prompt tokens (`{{user}}`, `{{char}}`, etc.) intact.
 */
export function substituteAutoPromptMacrosFallback(
    text: string,
    overrides?: Record<string, string>,
    allowedKeys?: ReadonlySet<AutoPromptMacroKey>,
): string {
    if (!text || !text.includes('{{') || !overrides) {
        return text;
    }

    const resolvedByKey = new Map<AutoPromptMacroKey, string>();
    for (const [rawKey, val] of Object.entries(overrides)) {
        const canonical = ALIAS_LOWER_TO_KEY.get(rawKey.toLowerCase());
        if (canonical && (!allowedKeys || allowedKeys.has(canonical)) && typeof val === 'string') {
            resolvedByKey.set(canonical, val);
        }
    }
    if (resolvedByKey.size === 0) {
        return text;
    }

    return text.replace(AUTO_PROMPT_MACRO_TOKEN_RE, (match, tokenName: string) => {
        const canonical = ALIAS_LOWER_TO_KEY.get(tokenName.toLowerCase());
        if (!canonical || !resolvedByKey.has(canonical)) {
            return match;
        }
        return resolvedByKey.get(canonical) ?? '';
    });
}
