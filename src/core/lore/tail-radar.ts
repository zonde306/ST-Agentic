import type { HostBridge, PromptInjectionSession } from '@/core/bridge';
import type {
    ClassifiedLoreEntry,
    MessageTarget,
    RadarCandidate,
    RadarScanResult,
    RawLoreEntry,
    SideClueDoc,
    SideClueRadarCandidate,
    SideClueRadarScanResult,
} from '@/core/types';
import { classifyEntry, WORLD_INFO_LOGIC } from './classifier';
import {
    LoreReadEvaluator,
    type LoreEvaluateOptions,
    type LoreOverrideResolver,
    type LoreOverrideSource,
    type LoreReadEvaluatorOptions,
    type LoreReadRegexCallback,
} from './read-evaluator';

export const DEFAULT_RADAR_TOP_K = 5;
export const DEFAULT_SCAN_DEPTH = 2;

const VALID_REGEX_FLAGS = /^[gimsuydv]*$/;

export interface TailRadarDefaults {
    topK?: number;
    defaultScanDepth?: number;
    defaultCaseSensitive?: boolean;
    defaultMatchWholeWords?: boolean;
}

export interface RadarScanInput {
    /** Latest user input (or combined scan text when `recentMessages` is omitted). */
    input: string;
    /** Optional prior context messages ordered oldest-to-newest (combined with `input` up to `scanDepth`). */
    recentMessages?: string[];
    /** Default scan depth when an entry does not specify `scanDepth` (default `2`). */
    defaultScanDepth?: number;
    /** Persistent agent Read-Set mapping VFS path -> last observed `xxHash`. */
    readSet?: ReadonlyMap<string, string>;
    /** Maximum number of candidates emitted in `<lore-hint>` (default `5`). */
    topK?: number;
    /** Causal message target for `worldinfo` override resolution. */
    target?: MessageTarget;
    /** Variable snapshot for macro / optional EJS evaluation. */
    vars?: Record<string, unknown>;
    /** Macro overrides for keyword and entry evaluation. */
    macroOverrides?: Record<string, string>;
    /** Isolated prompt injection session shared across the turn. */
    injectionSession?: PromptInjectionSession;
    /** Per-scan override content resolver. */
    getOverride?: LoreOverrideResolver;
    /** Per-scan override map/record. */
    overrides?: LoreOverrideSource;
    /** Per-scan `lore_read` regex callback. */
    applyLoreReadRegex?: LoreReadRegexCallback;
    /** Default case sensitivity when `entry.caseSensitive` is null/undefined (default `false`). */
    defaultCaseSensitive?: boolean;
    /** Default whole-word matching when `entry.matchWholeWords` is null/undefined (default `false`). */
    defaultMatchWholeWords?: boolean;
    /** Whether the reading agent can edit the scanned path (`editable` metadata). */
    canEditPath?: (path: string) => boolean;
    /** Whether the reading agent can write the scanned path (`writable` metadata). */
    canWritePath?: (path: string) => boolean;
    sessionId?: string;
    agentId?: string;
    phase?: string;
    sessionBag?: Record<string, unknown>;
}

export interface SideClueRadarScanInput {
    /** Latest user input (or combined scan text when `recentMessages` is omitted). */
    input: string;
    /** Optional prior context messages ordered oldest-to-newest (combined with `input` up to `scanDepth`). */
    recentMessages?: string[];
    /** Default scan depth when a clue does not specify `meta.scanDepth` (default `2`). */
    defaultScanDepth?: number;
    /** Persistent agent Read-Set mapping VFS path -> last observed `xxHash`. */
    readSet?: ReadonlyMap<string, string>;
    /** Maximum number of candidates emitted in `<side-hint>` (default `5`). */
    topK?: number;
    /** Variable snapshot for macro substitution in keywords. */
    vars?: Record<string, unknown>;
    /** Macro overrides for keyword substitution. */
    macroOverrides?: Record<string, string>;
    /** Default case sensitivity for plain keyword matching (default `false`). */
    defaultCaseSensitive?: boolean;
    /** Default whole-word matching for plain keyword matching (default `false`). */
    defaultMatchWholeWords?: boolean;
}

interface KeywordMatchDetail {
    keyword: string;
    matchedLength: number;
}

interface EntryMatchResult {
    matchedKeywords: string[];
    specificity: number;
}

function isClassifiedEntry(
    item: ClassifiedLoreEntry | RawLoreEntry,
): item is ClassifiedLoreEntry {
    return 'entry' in item && 'category' in item && 'vfsPath' in item;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a SillyTavern slash-delimited regex keyword such as `/银莲花|lotus/i`.
 * Returns `null` if the string is not a valid regex literal.
 */
export function parseLoreRegex(input: string): RegExp | null {
    if (typeof input !== 'string' || !input.startsWith('/')) {
        return null;
    }

    let endSlashPos = -1;
    for (let i = 1; i < input.length; i += 1) {
        if (input[i] === '/') {
            let backslashes = 0;
            let j = i - 1;
            while (j >= 0 && input[j] === '\\') {
                backslashes += 1;
                j -= 1;
            }
            if (backslashes % 2 === 0) {
                endSlashPos = i;
                break;
            }
        }
    }

    if (endSlashPos <= 1) {
        return null;
    }

    const rawPattern = input.slice(1, endSlashPos);
    const flags = input.slice(endSlashPos + 1);
    if (!VALID_REGEX_FLAGS.test(flags)) {
        return null;
    }

    const pattern = rawPattern.replace(/\\\//g, '/');
    // Strip `g` flag so `.exec()` remains stateless across scans.
    const safeFlags = flags.replace(/g/g, '');

    try {
        return new RegExp(pattern, safeFlags);
    } catch {
        return null;
    }
}

function matchKeywordText(
    haystack: string,
    rawNeedle: string,
    caseSensitive: boolean,
    matchWholeWords: boolean,
): KeywordMatchDetail | null {
    const trimmedNeedle = rawNeedle.trim();
    if (!trimmedNeedle) {
        return null;
    }

    const regex = parseLoreRegex(trimmedNeedle);
    if (regex) {
        regex.lastIndex = 0;
        const execMatch = regex.exec(haystack);
        if (!execMatch) {
            return null;
        }
        return {
            keyword: trimmedNeedle,
            matchedLength: Math.max(1, execMatch[0].length),
        };
    }

    const normalizedHaystack = caseSensitive ? haystack : haystack.toLowerCase();
    const normalizedNeedle = caseSensitive ? trimmedNeedle : trimmedNeedle.toLowerCase();

    if (matchWholeWords) {
        const words = normalizedNeedle.split(/\s+/);
        if (words.length > 1) {
            if (normalizedHaystack.includes(normalizedNeedle)) {
                return { keyword: trimmedNeedle, matchedLength: trimmedNeedle.length };
            }
            return null;
        }

        const wordBoundaryRegex = new RegExp(`(?:^|\\W)(${escapeRegExp(normalizedNeedle)})(?:$|\\W)`);
        if (wordBoundaryRegex.test(normalizedHaystack)) {
            return { keyword: trimmedNeedle, matchedLength: trimmedNeedle.length };
        }
        return null;
    }

    if (normalizedHaystack.includes(normalizedNeedle)) {
        return { keyword: trimmedNeedle, matchedLength: trimmedNeedle.length };
    }
    return null;
}

function matchSingleKeyword(
    haystack: string,
    rawNeedle: string,
    entry: RawLoreEntry,
    defaultCaseSensitive: boolean,
    defaultMatchWholeWords: boolean,
): KeywordMatchDetail | null {
    const caseSensitive = entry.caseSensitive ?? defaultCaseSensitive;
    const matchWholeWords = Boolean(entry.matchWholeWords ?? defaultMatchWholeWords);
    return matchKeywordText(haystack, rawNeedle, caseSensitive, matchWholeWords);
}

function buildHaystack(
    input: string,
    recentMessages: readonly string[] | undefined,
    entryScanDepth: number | null | undefined,
    defaultScanDepth: number,
): string {
    if (!recentMessages || recentMessages.length === 0) {
        return input;
    }

    const depth = entryScanDepth ?? defaultScanDepth;
    if (depth <= 0) {
        return '';
    }

    const combined = input ? [...recentMessages, input] : [...recentMessages];
    return combined.slice(-depth).join('\n');
}

function buildMacroOverridesFromVars(
    vars: Record<string, unknown> | undefined,
    macroOverrides: Record<string, string> | undefined,
): Record<string, string> | undefined {
    if (!vars && !macroOverrides) {
        return undefined;
    }

    const merged: Record<string, string> = {};
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined || v === null) {
                merged[`var:${k}`] = '';
            } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                merged[`var:${k}`] = String(v);
            } else {
                merged[`var:${k}`] = JSON.stringify(v);
            }
        }
    }
    if (macroOverrides) {
        Object.assign(merged, macroOverrides);
    }
    return merged;
}

/** Format `<lore-hint>` XML block with anti-hallucination guidance and optional overflow notice. */
export function formatLoreHintXml(
    candidates: readonly RadarCandidate[],
    overflowCount: number,
): string {
    if (candidates.length === 0 && overflowCount <= 0) {
        return '';
    }

    const lines: string[] = [
        '<lore-hint>',
        '以下条目字面匹配本轮输入（可能存在日常词误报，仅在剧情确实需要时按需 read_file，无关请直接忽略）：',
    ];

    for (const candidate of candidates) {
        if (candidate.status === 'unread') {
            const keywordsLabel = candidate.matchedKeywords.map((kw) => `"${kw}"`).join(', ');
            lines.push(`- [未读] ${candidate.path} (命中: ${keywordsLabel}, ~${candidate.charCount}字)`);
        } else {
            lines.push(`- [已更新] ${candidate.path} (~${candidate.charCount}字)`);
        }
    }

    if (overflowCount > 0) {
        lines.push(`+${overflowCount} 条更多候选匹配，如有需要请调用 search_files 检索`);
    }

    lines.push('</lore-hint>');
    return lines.join('\n');
}

/** Format compact `<side-hint>` XML block for matched `/side/*` radar clues. */
export function formatSideHintXml(
    candidates: readonly SideClueRadarCandidate[],
    overflowCount: number,
): string {
    if (candidates.length === 0 && overflowCount <= 0) {
        return '';
    }

    const lines: string[] = [
        '<side-hint>',
        '以下线外伏笔线索匹配本轮对话（仅在剧情需要时按需 read_file 查阅，无关请直接忽略）：',
    ];

    for (const candidate of candidates) {
        const summaryPart = candidate.summary ? ` — ${candidate.summary}` : '';
        if (candidate.status === 'unread') {
            const keywordsLabel = candidate.matchedKeywords.map((kw) => `"${kw}"`).join(', ');
            lines.push(`- [未读] ${candidate.title} (${candidate.path})${summaryPart} (命中: ${keywordsLabel})`);
        } else {
            lines.push(`- [已更新] ${candidate.title} (${candidate.path})${summaryPart}`);
        }
    }

    if (overflowCount > 0) {
        lines.push(`+${overflowCount} 条更多线外线索匹配，如有需要请调用 search_files 检索 /side/*`);
    }

    lines.push('</side-hint>');
    return lines.join('\n');
}

/**
 * Tail-only deduplicated World Info radar:
 * scans Category ③ (`on_demand_archive`) entries, evaluates matched candidates
 * via `LoreReadEvaluator`, performs `Read-Set` `xxHash` dirty-checking, enforces
 * the Top-K cap, and produces `<lore-hint>` XML guidance.
 */
export class TailRadar {
    private readonly evaluator: LoreReadEvaluator;
    private readonly defaults: Required<TailRadarDefaults>;

    constructor(evaluator: LoreReadEvaluator, defaults: TailRadarDefaults = {}) {
        this.evaluator = evaluator;
        this.defaults = {
            topK: defaults.topK ?? DEFAULT_RADAR_TOP_K,
            defaultScanDepth: defaults.defaultScanDepth ?? DEFAULT_SCAN_DEPTH,
            defaultCaseSensitive: defaults.defaultCaseSensitive ?? false,
            defaultMatchWholeWords: defaults.defaultMatchWholeWords ?? false,
        };
    }

    public static fromBridge(
        hostBridge: HostBridge,
        evaluatorOptions?: LoreReadEvaluatorOptions,
        radarDefaults?: TailRadarDefaults,
    ): TailRadar {
        return new TailRadar(new LoreReadEvaluator(hostBridge, evaluatorOptions), radarDefaults);
    }

    public async scan(
        entries: readonly (ClassifiedLoreEntry | RawLoreEntry)[],
        inputOrOptions: string | RadarScanInput,
    ): Promise<RadarScanResult> {
        const scanOptions: RadarScanInput = typeof inputOrOptions === 'string'
            ? { input: inputOrOptions }
            : inputOrOptions;

        const topK = Math.max(0, scanOptions.topK ?? this.defaults.topK);
        const defaultScanDepth = scanOptions.defaultScanDepth ?? this.defaults.defaultScanDepth;
        const defaultCaseSensitive = scanOptions.defaultCaseSensitive ?? this.defaults.defaultCaseSensitive;
        const defaultMatchWholeWords = scanOptions.defaultMatchWholeWords ?? this.defaults.defaultMatchWholeWords;
        const keywordMacroOverrides = buildMacroOverridesFromVars(
            scanOptions.vars,
            scanOptions.macroOverrides,
        );

        const evaluateOpts: LoreEvaluateOptions = {
            target: scanOptions.target,
            vars: scanOptions.vars,
            macroOverrides: scanOptions.macroOverrides,
            injectionSession: scanOptions.injectionSession,
            getOverride: scanOptions.getOverride,
            overrides: scanOptions.overrides,
            applyLoreReadRegex: scanOptions.applyLoreReadRegex,
        };

        const rawCandidates: RadarCandidate[] = [];

        for (const item of entries) {
            const classified = isClassifiedEntry(item) ? item : classifyEntry(item);
            if (classified.category !== 'on_demand_archive' || classified.entry.disable) {
                continue;
            }

            const entry = classified.entry;
            if (!Array.isArray(entry.keys) || entry.keys.length === 0) {
                continue;
            }

            const haystack = buildHaystack(
                scanOptions.input,
                scanOptions.recentMessages,
                entry.scanDepth,
                defaultScanDepth,
            );
            if (!haystack) {
                continue;
            }

            const match = this.matchEntry(
                entry,
                haystack,
                defaultCaseSensitive,
                defaultMatchWholeWords,
                keywordMacroOverrides,
            );
            if (!match) {
                continue;
            }

            const evaluated = await this.evaluator.evaluate(classified, {
                ...evaluateOpts,
                dryRun: true,
                source: 'lore_radar',
                editable: scanOptions.canEditPath?.(classified.vfsPath) ?? false,
                writable: scanOptions.canWritePath?.(classified.vfsPath) ?? false,
                ...(scanOptions.sessionId !== undefined ? { sessionId: scanOptions.sessionId } : {}),
                ...(scanOptions.agentId !== undefined ? { agentId: scanOptions.agentId } : {}),
                ...(scanOptions.phase !== undefined ? { phase: scanOptions.phase } : {}),
                ...(scanOptions.sessionBag !== undefined ? { sessionBag: scanOptions.sessionBag } : {}),
            });
            if (evaluated.conditionSkipped) {
                continue;
            }
            const previousHash = scanOptions.readSet?.get(classified.vfsPath);

            if (previousHash !== undefined && previousHash === evaluated.contentHash) {
                // Silent suppression: Read-Set already holds identical rendered text.
                continue;
            }

            const status: 'unread' | 'updated' = previousHash === undefined ? 'unread' : 'updated';

            rawCandidates.push({
                path: classified.vfsPath,
                world: entry.world,
                uid: entry.uid,
                title: entry.comment?.trim() || classified.slug || String(entry.uid),
                status,
                matchedKeywords: match.matchedKeywords,
                charCount: evaluated.charCount,
                contentHash: evaluated.contentHash,
                order: entry.order ?? 0,
                specificity: match.specificity,
            });
        }

        rawCandidates.sort(
            (a, b) =>
                b.specificity - a.specificity
                || b.order - a.order
                || a.path.localeCompare(b.path),
        );

        const totalMatched = rawCandidates.length;
        const candidates = rawCandidates.slice(0, topK);
        const overflowCount = Math.max(0, totalMatched - candidates.length);
        const hintXml = formatLoreHintXml(candidates, overflowCount);

        return {
            candidates,
            totalMatched,
            overflowCount,
            hintXml,
        };
    }

    /**
     * Synchronously scan `/side/*` clue documents for `delivery === 'radar_hint'` matches.
     *
     * Reuses `parseLoreRegex` and `Read-Set` `xxHash` dirty-checking:
     * - Emits `<side-hint>` only for active (`status !== 'resolved'`) `radar_hint` clues whose
     *   keywords (and optional `secondaryKeys`) match AND are unread or updated since last read.
     * - Stays 100% silent when already read with an unchanged `contentHash`.
     * - `delivery === 'none'`, `'vfs_only'`, and `'next_turn_brief'` never trigger radar hints.
     */
    public scanSideClues(
        clues: readonly SideClueDoc[],
        inputOrOptions: string | SideClueRadarScanInput,
    ): SideClueRadarScanResult {
        const scanOptions: SideClueRadarScanInput = typeof inputOrOptions === 'string'
            ? { input: inputOrOptions }
            : inputOrOptions;

        const topK = Math.max(0, scanOptions.topK ?? this.defaults.topK);
        const defaultScanDepth = scanOptions.defaultScanDepth ?? this.defaults.defaultScanDepth;
        const defaultCaseSensitive = scanOptions.defaultCaseSensitive ?? this.defaults.defaultCaseSensitive;
        const defaultMatchWholeWords = scanOptions.defaultMatchWholeWords ?? this.defaults.defaultMatchWholeWords;
        const keywordMacroOverrides = buildMacroOverridesFromVars(
            scanOptions.vars,
            scanOptions.macroOverrides,
        );

        const rawCandidates: SideClueRadarCandidate[] = [];

        for (const clue of clues) {
            const meta = clue.meta;
            if (meta.delivery !== 'radar_hint' || meta.status === 'resolved') {
                continue;
            }
            if (!Array.isArray(meta.keywords) || meta.keywords.length === 0) {
                continue;
            }

            const haystack = buildHaystack(
                scanOptions.input,
                scanOptions.recentMessages,
                meta.scanDepth,
                defaultScanDepth,
            );
            if (!haystack) {
                continue;
            }

            const match = this.matchSideClue(
                clue,
                haystack,
                defaultCaseSensitive,
                defaultMatchWholeWords,
                keywordMacroOverrides,
            );
            if (!match) {
                continue;
            }

            const previousHash = scanOptions.readSet?.get(clue.path);
            if (previousHash !== undefined && previousHash === clue.contentHash) {
                // Silent suppression: Read-Set already holds identical clue content.
                continue;
            }

            const status: 'unread' | 'updated' = previousHash === undefined ? 'unread' : 'updated';

            rawCandidates.push({
                path: clue.path,
                id: meta.id,
                title: meta.title?.trim() || meta.id || clue.path,
                summary: meta.summary?.trim() ?? '',
                status,
                matchedKeywords: match.matchedKeywords,
                contentHash: clue.contentHash,
                order: meta.order ?? 0,
                specificity: match.specificity,
            });
        }

        rawCandidates.sort(
            (a, b) =>
                b.specificity - a.specificity
                || b.order - a.order
                || a.path.localeCompare(b.path),
        );

        const totalMatched = rawCandidates.length;
        const candidates = rawCandidates.slice(0, topK);
        const overflowCount = Math.max(0, totalMatched - candidates.length);
        const hintXml = formatSideHintXml(candidates, overflowCount);

        return {
            candidates,
            totalMatched,
            overflowCount,
            hintXml,
        };
    }

    private matchSideClue(
        clue: SideClueDoc,
        haystack: string,
        defaultCaseSensitive: boolean,
        defaultMatchWholeWords: boolean,
        macroOverrides?: Record<string, string>,
    ): EntryMatchResult | null {
        const primaryMatches: KeywordMatchDetail[] = [];

        for (const rawKey of clue.meta.keywords) {
            const substituted = this.evaluator.hostBridge
                .substituteMacros(rawKey, macroOverrides)
                .trim();
            if (!substituted) {
                continue;
            }

            const matched = matchKeywordText(
                haystack,
                substituted,
                defaultCaseSensitive,
                defaultMatchWholeWords,
            );
            if (matched) {
                primaryMatches.push(matched);
            }
        }

        if (primaryMatches.length === 0) {
            return null;
        }

        const activeSecondary = (clue.meta.secondaryKeys ?? [])
            .map((key) => this.evaluator.hostBridge.substituteMacros(key, macroOverrides).trim())
            .filter(Boolean);

        const secondaryMatches: KeywordMatchDetail[] = [];
        if (activeSecondary.length > 0) {
            for (const secKey of activeSecondary) {
                const matched = matchKeywordText(
                    haystack,
                    secKey,
                    defaultCaseSensitive,
                    defaultMatchWholeWords,
                );
                if (matched) {
                    secondaryMatches.push(matched);
                }
            }
            if (secondaryMatches.length === 0) {
                return null;
            }
        }

        const allMatches = secondaryMatches.length > 0
            ? [...primaryMatches, ...secondaryMatches]
            : primaryMatches;

        const seenKeywords = new Set<string>();
        const matchedKeywords: string[] = [];
        let specificity = 0;

        for (const item of allMatches) {
            if (!seenKeywords.has(item.keyword)) {
                seenKeywords.add(item.keyword);
                matchedKeywords.push(item.keyword);
                specificity += item.matchedLength;
            }
        }

        if (matchedKeywords.length > 1) {
            specificity += matchedKeywords.length;
        }

        return {
            matchedKeywords,
            specificity,
        };
    }

    private matchEntry(
        entry: RawLoreEntry,
        haystack: string,
        defaultCaseSensitive: boolean,
        defaultMatchWholeWords: boolean,
        macroOverrides?: Record<string, string>,
    ): EntryMatchResult | null {
        return matchLoreEntryKeywords(entry, haystack, {
            defaultCaseSensitive,
            defaultMatchWholeWords,
            substituteMacros: (text, overrides) =>
                this.evaluator.hostBridge.substituteMacros(text, overrides),
            macroOverrides,
        });
    }
}

export interface MatchLoreKeywordsOptions {
    defaultCaseSensitive?: boolean;
    defaultMatchWholeWords?: boolean;
    substituteMacros?: (text: string, overrides?: Record<string, string>) => string;
    macroOverrides?: Record<string, string>;
}

/**
 * Match a World Info entry's primary/secondary keywords against a haystack string,
 * honoring `caseSensitive`, `matchWholeWords`, regex `/.../flags`, and `selectiveLogic`.
 */
export function matchLoreEntryKeywords(
    entry: RawLoreEntry,
    haystack: string,
    options: MatchLoreKeywordsOptions = {},
): EntryMatchResult | null {
    const defaultCaseSensitive = options.defaultCaseSensitive ?? false;
    const defaultMatchWholeWords = options.defaultMatchWholeWords ?? false;
    const sub = options.substituteMacros ?? ((text: string) => text);
    const macroOverrides = options.macroOverrides;

    const primaryMatches: KeywordMatchDetail[] = [];

    for (const rawKey of entry.keys) {
        const substituted = sub(rawKey, macroOverrides).trim();
        if (!substituted) {
            continue;
        }

        const matched = matchSingleKeyword(
            haystack,
            substituted,
            entry,
            defaultCaseSensitive,
            defaultMatchWholeWords,
        );
        if (matched) {
            primaryMatches.push(matched);
        }
    }

    if (primaryMatches.length === 0) {
        return null;
    }

    const activeSecondary = (entry.keysecondary ?? [])
        .map((key) => sub(key, macroOverrides).trim())
        .filter(Boolean);

    const hasSecondary = Boolean(entry.selective && activeSecondary.length > 0);
    const positiveSecondaryMatches: KeywordMatchDetail[] = [];

    if (hasSecondary) {
        const logic = entry.selectiveLogic ?? WORLD_INFO_LOGIC.AND_ANY;
        let matchedCount = 0;

        for (const secKey of activeSecondary) {
            const matched = matchSingleKeyword(
                haystack,
                secKey,
                entry,
                defaultCaseSensitive,
                defaultMatchWholeWords,
            );
            if (matched) {
                matchedCount += 1;
                positiveSecondaryMatches.push(matched);
            }
        }

        const passed = evaluateSelectiveLogic(logic, matchedCount, activeSecondary.length);
        if (!passed) {
            return null;
        }
    }

    const isPositiveSecondary =
        hasSecondary
        && (entry.selectiveLogic === undefined
            || entry.selectiveLogic === WORLD_INFO_LOGIC.AND_ANY
            || entry.selectiveLogic === WORLD_INFO_LOGIC.AND_ALL);

    const allMatches = isPositiveSecondary
        ? [...primaryMatches, ...positiveSecondaryMatches]
        : primaryMatches;

    const seenKeywords = new Set<string>();
    const matchedKeywords: string[] = [];
    let specificity = 0;

    for (const item of allMatches) {
        if (!seenKeywords.has(item.keyword)) {
            seenKeywords.add(item.keyword);
            matchedKeywords.push(item.keyword);
            specificity += item.matchedLength;
        }
    }

    if (matchedKeywords.length > 1) {
        specificity += matchedKeywords.length;
    }

    return {
        matchedKeywords,
        specificity,
    };
}

function evaluateSelectiveLogic(
    logic: number,
    matchedCount: number,
    totalSecondary: number,
): boolean {
    switch (logic) {
        case WORLD_INFO_LOGIC.AND_ANY:
            return matchedCount > 0;
        case WORLD_INFO_LOGIC.NOT_ALL:
            return matchedCount < totalSecondary;
        case WORLD_INFO_LOGIC.NOT_ANY:
            return matchedCount === 0;
        case WORLD_INFO_LOGIC.AND_ALL:
            return matchedCount === totalSecondary;
        default:
            return matchedCount > 0;
    }
}
