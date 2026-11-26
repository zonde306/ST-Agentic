import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isPlainRecord } from '@/core/config';
import type { AgentProfile, PromptBlock, TriggerRule } from '@/core/types';
import type { BadgeTone } from '@/ui/components';

export const PROMPT_PLACEMENT_OPTIONS: ReadonlyArray<{
    value: PromptBlock['placement'];
    label: string;
}> = [
    { value: 'prefix', label: 'Layer 0 Prefix (静态前缀缓存)' },
    { value: 'tail', label: 'Tail (瞬态沉底 · 上下文与工具链夹中间)' },
    { value: 'floating_tail', label: 'Floating Tail (瞬态沉底 · 兼容别名)' },
];

/** Map a `PromptBlock['placement']` to its badge tone and short display label. */
export function getPromptPlacementMeta(placement: PromptBlock['placement']): {
    tone: BadgeTone;
    label: string;
} {
    switch (placement) {
        case 'prefix':
            return { tone: 'primary', label: 'Prefix' };
        case 'floating_tail':
            return { tone: 'success', label: 'Floating Tail' };
        case 'tail':
        default:
            return { tone: 'warning', label: 'Tail' };
    }
}

/** Generate a unique identifier avoiding collisions in `existingIds`. */
export function allocateUniqueId(
    base: string,
    existingIds: Iterable<string>,
    fallback = 'item',
): string {
    const used = new Set(existingIds);
    const cleaned = base
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const seed = cleaned || fallback;

    if (!used.has(seed)) {
        return seed;
    }

    let suffix = 2;
    while (used.has(`${seed}_${suffix}`)) {
        suffix += 1;
    }
    return `${seed}_${suffix}`;
}

/** Return a new array with element at `fromIndex` moved to `toIndex`. */
export function moveArrayItem<T>(
    list: readonly T[],
    fromIndex: number,
    toIndex: number,
): T[] {
    if (
        fromIndex < 0
        || fromIndex >= list.length
        || toIndex < 0
        || toIndex >= list.length
        || fromIndex === toIndex
    ) {
        return [...list];
    }
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
}

/** Trigger browser file download for JSON or text content inside client environments. */
export function downloadTextFile(
    filename: string,
    text: string,
    mimeType = 'application/json;charset=utf-8',
): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        return;
    }
    try {
        const blob = new Blob([text], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
        // Ignore download restriction in headless or sandboxed browsers.
    }
}

/** Copy text to clipboard safely, returning true on success. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Clipboard permission denied or unavailable.
    }
    return false;
}

/** Serialize a plain key-value record to YAML text (empty string when empty). */
export function recordToYamlText(record: Record<string, unknown> | undefined): string {
    if (!record || Object.keys(record).length === 0) {
        return '';
    }
    try {
        return stringifyYaml(record).trimEnd();
    } catch {
        return JSON.stringify(record, null, 2);
    }
}

/** Parse YAML or JSON object mapping text into a plain record with validation diagnostics. */
export function parseYamlTextToRecord(
    text: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    const trimmed = text.trim();
    if (!trimmed) {
        return { ok: true, value: {} };
    }
    try {
        const parsed: unknown = parseYaml(trimmed);
        if (parsed === null || parsed === undefined) {
            return { ok: true, value: {} };
        }
        if (isPlainRecord(parsed)) {
            return { ok: true, value: parsed };
        }
        return {
            ok: false,
            error: 'YAML 根节点必须是键值对对象 (key: value)',
        };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Parse comma/newline-separated glob pattern strings into a deduplicated string list. */
export function parseGlobLines(text: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const part of text.split(/[\r\n,]+/)) {
        const trimmed = part.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return result;
}

/**
 * Focus-preserving text draft hook: keeps user's typing buffer stable across
 * async store normalization without stealing cursor position.
 */
export function useDraftString(
    resetKey: string,
    externalValue: string,
    onCommit: (next: string) => void,
    options: { allowEmpty?: boolean } = {},
) {
    const allowEmpty = options.allowEmpty ?? true;
    const [draft, setDraft] = useState(externalValue);
    const prevKeyRef = useRef(resetKey);
    const lastCommittedRef = useRef(externalValue);
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    useEffect(() => {
        if (prevKeyRef.current !== resetKey) {
            prevKeyRef.current = resetKey;
            lastCommittedRef.current = externalValue;
            setDraft(externalValue);
            return;
        }
        if (
            externalValue !== lastCommittedRef.current
            && externalValue !== lastCommittedRef.current.trim()
        ) {
            lastCommittedRef.current = externalValue;
            setDraft(externalValue);
        }
    }, [resetKey, externalValue]);

    const handleInput = useCallback(
        (next: string) => {
            setDraft(next);
            if (allowEmpty || next.trim().length > 0) {
                lastCommittedRef.current = next;
                onCommitRef.current(next);
            }
        },
        [allowEmpty],
    );

    const handleChange = useCallback(
        (next: string) => {
            if (!allowEmpty && next.trim().length === 0) {
                lastCommittedRef.current = externalValue;
                setDraft(externalValue);
                return;
            }
            setDraft(next);
            lastCommittedRef.current = next;
            onCommitRef.current(next);
        },
        [allowEmpty, externalValue],
    );

    return { value: draft, onInput: handleInput, onChange: handleChange };
}

/**
 * Focus-preserving comma-separated tag list draft hook (prevents stripping
 * trailing commas/spaces while the user is typing multiple entries).
 */
export function useDraftTagList(
    resetKey: string,
    externalTags: readonly string[],
    onCommit: (next: string[]) => void,
) {
    const parseTags = (raw: string): string[] =>
        raw
            .split(/[,，\r\n]+/)
            .map((item) => item.trim())
            .filter(Boolean);

    const serialized = externalTags.join(', ');
    const nextSig = externalTags.join('\0');
    const [draft, setDraft] = useState(serialized);
    const prevKeyRef = useRef(resetKey);
    const lastCommittedSignatureRef = useRef(nextSig);
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    useEffect(() => {
        if (prevKeyRef.current !== resetKey) {
            prevKeyRef.current = resetKey;
            lastCommittedSignatureRef.current = nextSig;
            setDraft(serialized);
            return;
        }
        if (nextSig !== lastCommittedSignatureRef.current) {
            lastCommittedSignatureRef.current = nextSig;
            setDraft(serialized);
        }
    }, [resetKey, serialized, nextSig]);

    const handleInput = useCallback((raw: string) => {
        setDraft(raw);
        const parsed = parseTags(raw);
        lastCommittedSignatureRef.current = parsed.join('\0');
        onCommitRef.current(parsed);
    }, []);

    const handleChange = useCallback((raw: string) => {
        const parsed = parseTags(raw);
        lastCommittedSignatureRef.current = parsed.join('\0');
        setDraft(parsed.join(', '));
        onCommitRef.current(parsed);
    }, []);

    return { value: draft, onInput: handleInput, onChange: handleChange };
}

/**
 * Focus-preserving numeric input draft hook allowing intermediate decimal/partial
 * typing before normalizing and committing on blur/change.
 */
export function useDraftNumber(
    resetKey: string,
    externalValue: number,
    onCommit: (next: number) => void,
    options: { min?: number; max?: number; integer?: boolean } = {},
) {
    const min = options.min ?? -Infinity;
    const max = options.max ?? Infinity;
    const integer = options.integer ?? false;

    const formatNum = (val: number) => (Number.isFinite(val) ? String(val) : '0');
    const [draft, setDraft] = useState(() => formatNum(externalValue));
    const prevKeyRef = useRef(resetKey);
    const lastCommittedRef = useRef(externalValue);
    const onCommitRef = useRef(onCommit);
    onCommitRef.current = onCommit;

    useEffect(() => {
        if (prevKeyRef.current !== resetKey) {
            prevKeyRef.current = resetKey;
            lastCommittedRef.current = externalValue;
            setDraft(formatNum(externalValue));
            return;
        }
        if (!Object.is(externalValue, lastCommittedRef.current)) {
            lastCommittedRef.current = externalValue;
            setDraft(formatNum(externalValue));
        }
    }, [resetKey, externalValue]);

    const handleInput = useCallback(
        (raw: string) => {
            setDraft(raw);
            const trimmed = raw.trim();
            if (!trimmed || trimmed === '-' || trimmed.endsWith('.')) {
                return;
            }
            const parsed = Number(trimmed);
            if (!Number.isFinite(parsed)) {
                return;
            }
            const normalized = integer ? Math.trunc(parsed) : parsed;
            if (normalized >= min && normalized <= max) {
                lastCommittedRef.current = normalized;
                onCommitRef.current(normalized);
            }
        },
        [integer, max, min],
    );

    const handleChange = useCallback(
        (raw: string) => {
            const parsed = Number(raw.trim());
            const base = Number.isFinite(parsed) ? parsed : lastCommittedRef.current;
            const bounded = Math.min(max, Math.max(min, integer ? Math.trunc(base) : base));
            lastCommittedRef.current = bounded;
            setDraft(formatNum(bounded));
            onCommitRef.current(bounded);
        },
        [integer, max, min],
    );

    return { value: draft, onInput: handleInput, onChange: handleChange };
}

/** Update a single `AgentProfile` inside a `Preset` immutably. */
export function withUpdatedAgent(
    agents: Record<string, AgentProfile>,
    agentId: string,
    updater: (agent: AgentProfile) => AgentProfile,
): Record<string, AgentProfile> {
    const target = agents[agentId];
    if (!target) {
        return agents;
    }
    return {
        ...agents,
        [agentId]: updater(target),
    };
}

/** Update a single `TriggerRule` inside `Preset.triggers` immutably. */
export function withUpdatedTrigger(
    triggers: readonly TriggerRule[],
    triggerId: string,
    updater: (rule: TriggerRule) => TriggerRule,
): TriggerRule[] {
    return triggers.map((rule) => (rule.id === triggerId ? updater(rule) : rule));
}
