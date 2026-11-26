import type { CanonicalMessage } from '@/core/types';
import { canonicalClone } from '@/core/utils';

function hashString32(input: string, seed: number = 0x811c9dc5): number {
    let hash = seed >>> 0;
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

export interface PromptInjectedItem {
    order: number;
    prompt: string;
    sticky: number;
    uid: string;
}

export interface PromptPostProcess {
    search: RegExp | string;
    replace: string;
}

export type SerializedPromptInjected = Record<string, PromptInjectedItem[]>;

export interface PromptInjectionSession {
    injectPrompt(
        key: string,
        prompt: string,
        order?: number,
        sticky?: number,
        uid?: string,
    ): void;
    getPromptsInjected(
        key: string,
        postprocess?: PromptPostProcess[],
        outlet?: boolean,
    ): string;
    hasPromptsInjected(key: string): boolean;
    setForceOutlet(force?: boolean): void;
    applyOutlets(content: string, recursion?: number): string;
    tickSticky(count?: number): void;
    exportSnapshot(): SerializedPromptInjected;
    importSnapshot(snapshot?: SerializedPromptInjected | null): void;
    clear(): void;
    getKeys?(): string[];
}

const DEFAULT_MAX_OUTLET_RECURSION = 10;

function computeDefaultUid(key: string, prompt: string): string {
    return hashString32(`${key}#${prompt}`, 0xdeadbeef).toString(16).padStart(8, '0');
}

/**
 * Pure core implementation of `PromptInjectionSession` used as an isolated per-turn
 * fallback when `ST-Prompt-Template` is absent or running an older version without
 * `createInjectionSession`.
 */
export class LocalPromptInjectionSession implements PromptInjectionSession {
    private readonly promptInjected = new Map<string, Map<string, PromptInjectedItem>>();
    private readonly postprocessOutlets = new Map<
        string,
        { key: string; postprocess: PromptPostProcess[] }
    >();
    private forceOutlet = false;
    private ppCounter = 0;

    constructor(initialSnapshot?: SerializedPromptInjected | null) {
        if (initialSnapshot) {
            this.importSnapshot(initialSnapshot);
        }
    }

    injectPrompt(
        key: string,
        prompt: string,
        order: number = 100,
        sticky: number = 0,
        uid: string = '',
    ): void {
        if (typeof key !== 'string' || !key) {
            return;
        }
        const safePrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '');
        let inner = this.promptInjected.get(key);
        if (!inner) {
            inner = new Map<string, PromptInjectedItem>();
            this.promptInjected.set(key, inner);
        }
        const resolvedUid = uid || computeDefaultUid(key, safePrompt);
        inner.set(resolvedUid, {
            prompt: safePrompt,
            order: Number.isFinite(order) ? order : 100,
            sticky: Number.isFinite(sticky) ? sticky : 0,
            uid: resolvedUid,
        });
    }

    getPromptsInjected(
        key: string,
        postprocess: PromptPostProcess[] = [],
        outlet: boolean = this.forceOutlet,
    ): string {
        if (outlet) {
            if (!Array.isArray(postprocess) || postprocess.length === 0) {
                return `{{outletPromptsInjected:${key}}}`;
            }
            const tokenId = `pp_${this.ppCounter++}`;
            this.postprocessOutlets.set(tokenId, {
                key,
                postprocess: [...postprocess],
            });
            return `{{outletPromptsInjectedPP:${tokenId}}}`;
        }

        return this.resolvePrompts(key, postprocess);
    }

    hasPromptsInjected(key: string): boolean {
        const inner = this.promptInjected.get(key);
        return Boolean(inner && inner.size > 0);
    }

    setForceOutlet(force: boolean = true): void {
        this.forceOutlet = force;
    }

    applyOutlets(
        content: string,
        recursion: number = DEFAULT_MAX_OUTLET_RECURSION,
    ): string {
        if (
            !content
            || (!content.includes('{{outletPromptsInjected:')
                && !content.includes('{{outletPromptsInjectedPP:'))
        ) {
            return content;
        }

        let result = content;
        const maxSteps = Math.max(1, recursion);
        for (let i = 0; i < maxSteps; i += 1) {
            const hasPlain = result.includes('{{outletPromptsInjected:');
            const hasPP = result.includes('{{outletPromptsInjectedPP:');
            if (!hasPlain && !hasPP) {
                break;
            }
            if (hasPP) {
                result = result.replace(
                    /\{\{outletPromptsInjectedPP:(.+?)\}\}/g,
                    (_full, tokenId: string) => {
                        const entry = this.postprocessOutlets.get(tokenId);
                        return entry
                            ? this.resolvePrompts(entry.key, entry.postprocess)
                            : '';
                    },
                );
            }
            if (hasPlain) {
                result = result.replace(
                    /\{\{outletPromptsInjected:(.+?)\}\}/g,
                    (_full, key: string) => this.resolvePrompts(key),
                );
            }
        }
        return result;
    }

    tickSticky(count: number = 1): void {
        for (const key of Array.from(this.promptInjected.keys())) {
            const inner = this.promptInjected.get(key);
            if (!inner) {
                continue;
            }
            const toRemove: string[] = [];
            for (const [uid, item] of inner.entries()) {
                const nextSticky = item.sticky - count;
                if (nextSticky >= 0) {
                    item.sticky = nextSticky;
                } else {
                    toRemove.push(uid);
                }
            }
            if (toRemove.length > 0) {
                for (const uid of toRemove) {
                    inner.delete(uid);
                }
                if (inner.size === 0) {
                    this.promptInjected.delete(key);
                }
            }
        }
    }

    exportSnapshot(): SerializedPromptInjected {
        const snapshot: SerializedPromptInjected = {};
        for (const [key, inner] of this.promptInjected.entries()) {
            const items = Array.from(inner.values()).map((item) => ({ ...item }));
            if (items.length > 0) {
                snapshot[key] = items;
            }
        }
        return snapshot;
    }

    importSnapshot(snapshot?: SerializedPromptInjected | null): void {
        this.promptInjected.clear();
        this.postprocessOutlets.clear();
        if (!snapshot || typeof snapshot !== 'object') {
            return;
        }
        for (const [key, items] of Object.entries(snapshot)) {
            if (!Array.isArray(items) || items.length === 0) {
                continue;
            }
            const inner = new Map<string, PromptInjectedItem>();
            for (const item of items) {
                if (!item || typeof item !== 'object' || typeof item.prompt !== 'string') {
                    continue;
                }
                const order =
                    typeof item.order === 'number' && Number.isFinite(item.order)
                        ? item.order
                        : 100;
                const sticky =
                    typeof item.sticky === 'number' && Number.isFinite(item.sticky)
                        ? item.sticky
                        : 0;
                const uid =
                    typeof item.uid === 'string' && item.uid
                        ? item.uid
                        : computeDefaultUid(key, item.prompt);
                inner.set(uid, {
                    prompt: item.prompt,
                    order,
                    sticky,
                    uid,
                });
            }
            if (inner.size > 0) {
                this.promptInjected.set(key, inner);
            }
        }
    }

    clear(): void {
        this.promptInjected.clear();
        this.postprocessOutlets.clear();
        this.forceOutlet = false;
    }

    getKeys(): string[] {
        return Array.from(this.promptInjected.keys()).sort();
    }

    private resolvePrompts(key: string, postprocess: PromptPostProcess[] = []): string {
        const inner = this.promptInjected.get(key);
        if (!inner || inner.size === 0) {
            return '';
        }

        let combined = Array.from(inner.values())
            .sort((a, b) => a.order - b.order)
            .map((p) => p.prompt)
            .join('\n');

        for (const pp of postprocess) {
            combined = combined.replace(pp.search, pp.replace);
        }
        return combined;
    }
}

export interface ApplyOutletsOptions {
    /** Trim expanded string content and drop plain text messages whose content becomes empty/whitespace-only. */
    dropEmptyTextMessages?: boolean;
}

/** Expand delayed `{{outletPromptsInjected:...}}` placeholders across canonical messages without mutating inputs. */
export function applyOutletsToCanonicalMessages(
    messages: readonly CanonicalMessage[],
    session: PromptInjectionSession,
    options?: ApplyOutletsOptions,
): CanonicalMessage[] {
    const result: CanonicalMessage[] = [];
    for (const msg of messages) {
        const cloned = canonicalClone(msg);
        if (typeof cloned.content === 'string') {
            cloned.content = session.applyOutlets(cloned.content);
        } else if (Array.isArray(cloned.content)) {
            cloned.content = cloned.content.map((part) => {
                if (part.type === 'text') {
                    return {
                        ...part,
                        text: session.applyOutlets(part.text),
                    };
                }
                return part;
            });
        }
        if (typeof cloned.reasoningContent === 'string') {
            cloned.reasoningContent = session.applyOutlets(cloned.reasoningContent);
        }

        if (options?.dropEmptyTextMessages && typeof cloned.content === 'string') {
            cloned.content = cloned.content.trim();
            if (
                !cloned.content
                && !cloned.toolCalls?.length
                && !cloned.reasoningContent?.trim()
                && !cloned.extraFields
            ) {
                continue;
            }
        }

        result.push(cloned);
    }
    return result;
}

const INJECT_USAGE_PATTERN = /\b(?:injectPrompt|getPromptsInjected|hasPromptsInjected)\s*\(/;
const GET_PROMPTS_INJECTED_CALL_PATTERN = /\b(?:getPromptsInjected|hasPromptsInjected)\s*\(\s*([^)]*?)\)/g;
const OUTLET_MACRO_PATTERN = /\{\{\s*outlet::([^}]+?)\s*\}\}/gi;

export function containsInjectPromptUsage(text: string): boolean {
    return typeof text === 'string' && INJECT_USAGE_PATTERN.test(text);
}

export function extractReferencedInjectKeys(text: string): {
    keys: string[];
    hasDynamicKey: boolean;
} {
    const keys = new Set<string>();
    let hasDynamicKey = false;
    if (!text) {
        return { keys: [], hasDynamicKey: false };
    }

    GET_PROMPTS_INJECTED_CALL_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = GET_PROMPTS_INJECTED_CALL_PATTERN.exec(text)) !== null) {
        const argsRaw = match[1]?.trim() ?? '';
        const firstArgMatch = /^(['"])((?:\\.|(?!\1).)*)\1(?:\s*,|\s*$)/.exec(argsRaw);
        if (firstArgMatch) {
            keys.add(firstArgMatch[2]);
        } else if (argsRaw.length > 0) {
            hasDynamicKey = true;
        }
    }

    return {
        keys: Array.from(keys).sort(),
        hasDynamicKey,
    };
}

export function extractReferencedOutletKeys(text: string): string[] {
    if (!text) {
        return [];
    }
    const keys = new Set<string>();
    OUTLET_MACRO_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = OUTLET_MACRO_PATTERN.exec(text)) !== null) {
        const key = match[1]?.trim();
        if (key) {
            keys.add(key);
        }
    }
    return Array.from(keys).sort();
}

export function computeInjectionDigest(
    session: PromptInjectionSession,
    keys?: readonly string[] | 'all',
): string {
    const snapshot = session.exportSnapshot();
    const targetKeys =
        keys === undefined || keys === 'all'
            ? Object.keys(snapshot).sort()
            : [...new Set(keys)].sort();
    const parts: string[] = [];
    for (const key of targetKeys) {
        const items = snapshot[key] ?? [];
        if (items.length === 0) {
            parts.push(`${key}:`);
            continue;
        }
        const sorted = [...items].sort((a, b) => a.order - b.order || a.uid.localeCompare(b.uid));
        const body = sorted.map((i) => `${i.order}:${i.uid}:${i.prompt}`).join('\x00');
        parts.push(`${key}:${body}`);
    }
    return hashString32(parts.join('\x01'), 0x811c9dc5).toString(16).padStart(8, '0');
}
