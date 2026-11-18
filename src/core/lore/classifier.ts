import type { ClassifiedLoreEntry, ParsedDecorator, RawLoreEntry, WICategory } from '@/core/types';
import { DecoratorParser } from './decorators';

/** SillyTavern World Info insertion position constants. */
export const WORLD_INFO_POSITION = {
    beforeChar: 0,
    afterChar: 1,
    anTop: 2,
    anBottom: 3,
    atDepth: 4,
    emTop: 5,
    emBottom: 6,
    outlet: 7,
} as const;

/** SillyTavern World Info secondary keyword selective logic constants. */
export const WORLD_INFO_LOGIC = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
} as const;

/** Default character count threshold below which a character card is considered hollow. */
export const DEFAULT_HOLLOW_CARD_THRESHOLD = 80;

const UNSAFE_SEGMENT_CHARS = /[%#?\\]/g;

/** Decorators that indicate Category ④ (triggers, scripts, tools, agents, skills, or control headers). */
const CATEGORY_4_DECORATORS = new Set([
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
    '@@trigger',
    '@@tool',
    '@@script',
    '@@group',
    '@@dont_activate',
]);

const INIT_VAR_PATTERN = /\[initvar\]/i;
const GENERATE_DIRECTIVE_PATTERN = /\[generate:(?:before|after)\]/i;
const VAR_MUTATION_PATTERN = /\{\{(?:setvar|addvar|incvar|decvar|setglobalvar|addglobalvar)::|(?:^|\n)\s*\/setvar\b|\b(?:setvar|setglobalvar)\s*\(/i;
const DYNAMIC_EXPR_PATTERN = /\{\{(?:getvar|getglobalvar|var|random|roll|time|date)(?:::|\}\})|<%[\s\S]*?%>|\bgetvar\s*\(/i;
const EJS_TAG_PATTERN = /<%[\s\S]*?%>/g;
const EJS_OUTPUT_TAG_PATTERN = /<%[=-]/;

const NON_SETTING_CHARACTER_FIELDS = new Set([
    'name',
    'first_mes',
    'firstmes',
    'avatar',
    'creator_notes',
    'creatorcomment',
    'sd_character_prompt',
    'tags',
    'spec',
    'spec_version',
]);

/** Encode unsafe path segment characters (`%`, `#`, `?`, `\`) without altering `/`. */
export function encodeLoreSegment(name: string): string {
    return (name ?? '').replace(
        UNSAFE_SEGMENT_CHARS,
        (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
    );
}

/** Generate a filesystem-safe slug from a World Info entry comment/title. */
export function slugifyLoreComment(comment: string): string {
    const slug = (comment ?? '')
        .trim()
        .replace(/[\s/\\]+/g, '-')
        .replace(/[^\p{L}\p{N}_.-]+/gu, '')
        .replace(/^[.-]+/, '')
        .replace(/-{2,}/g, '-')
        .slice(0, 60)
        .replace(/-+$/, '');

    return slug || 'entry';
}

/** Canonical override key (`${world}/${uid}`) matching legacy `worldInfoKey`. */
export function buildLoreOverrideKey(world: string, uid: number | string): string {
    return `${world}/${String(uid)}`;
}

/** Build the canonical VFS path for a World Info entry (`/lorebooks/...` or `/skills/...`). */
export function buildLoreVfsPath(
    entry: Pick<RawLoreEntry, 'world' | 'uid' | 'comment'>,
    decorators: readonly ParsedDecorator[] = [],
): string {
    const skillDecorator = decorators.find((d) => d.name === '@@skill');
    if (skillDecorator) {
        const rawSkillName = skillDecorator.args[0]?.trim() || entry.comment || `skill-${entry.uid}`;
        const skillSlug = slugifyLoreComment(rawSkillName);
        return `/skills/${encodeLoreSegment(skillSlug)}.md`;
    }

    const bookSegment = encodeLoreSegment(entry.world || 'default').replace(/^\/+|\/+$/g, '') || 'default';
    const slug = slugifyLoreComment(entry.comment);
    return `/lorebooks/${bookSegment}/${slug}-${entry.uid}.md`;
}

function isPureEjsScript(content: string): boolean {
    if (!EJS_TAG_PATTERN.test(content)) {
        return false;
    }
    EJS_TAG_PATTERN.lastIndex = 0;

    if (EJS_OUTPUT_TAG_PATTERN.test(content)) {
        return false;
    }

    const staticRemainder = content.replace(EJS_TAG_PATTERN, '').trim();
    return staticRemainder.length === 0;
}

function isSystemRole(role: number | null | undefined): boolean {
    return role === undefined || role === null || role === 0;
}

function resolveManualOverride(
    entry: Pick<RawLoreEntry, 'world' | 'uid'>,
    vfsPath: string,
    overrides?: Record<string, WICategory>,
): WICategory | undefined {
    if (!overrides) {
        return undefined;
    }

    const candidates = [
        vfsPath,
        buildLoreOverrideKey(entry.world, entry.uid),
        `${entry.world}:${entry.uid}`,
        `${entry.world}#${entry.uid}`,
    ];

    for (const key of candidates) {
        if (Object.hasOwn(overrides, key)) {
            return overrides[key];
        }
    }

    return undefined;
}

export interface WIClassifyOptions {
    /** Manual `wiRouterOverrides` mapping entry key or VFS path to `WICategory`. */
    overrides?: Record<string, WICategory>;
    /** Whether disabled entries (`entry.disable === true`) are included in batch classification (default `false`). */
    includeDisabled?: boolean;
}

export interface WIClassificationResult {
    all: ClassifiedLoreEntry[];
    byCategory: Record<WICategory, ClassifiedLoreEntry[]>;
    byPath: Map<string, ClassifiedLoreEntry>;
}

export interface CoreManifestOptions {
    characterFields: Record<string, string>;
    coreEntries: readonly ClassifiedLoreEntry[];
    personaDescription?: string;
    hollowThreshold?: number;
}

export interface CoreManifestResult {
    isHollowCard: boolean;
    characterFilePaths: string[];
    coreEntries: ClassifiedLoreEntry[];
    text: string;
}

/**
 * Detect whether a character card is a "hollow" (World-Info-driven) card whose
 * substantive native character fields (`description`, `personality`, `scenario`, etc.)
 * are missing or shorter than `threshold` characters (default 80).
 */
export function isHollowCharacterCard(
    characterFields: Record<string, string>,
    threshold: number = DEFAULT_HOLLOW_CARD_THRESHOLD,
): boolean {
    if (!characterFields) {
        return true;
    }

    let substantiveChars = 0;
    for (const [rawKey, rawValue] of Object.entries(characterFields)) {
        if (typeof rawValue !== 'string') {
            continue;
        }
        const normalizedKey = rawKey.trim().toLowerCase().replace(/\.md$/, '');
        if (NON_SETTING_CHARACTER_FIELDS.has(normalizedKey)) {
            continue;
        }
        substantiveChars += rawValue.trim().length;
    }

    return substantiveChars < threshold;
}

/**
 * Build the deterministic Layer 0 Core Manifest listing `/character/*` files,
 * Category ② `core_manifest` lorebook paths/titles/charCounts, and hollow-card
 * compensation guidance when substantive native character fields are scarce.
 */
export function buildCoreManifest(options: CoreManifestOptions): CoreManifestResult {
    const threshold = options.hollowThreshold ?? DEFAULT_HOLLOW_CARD_THRESHOLD;
    const isHollowCard = isHollowCharacterCard(options.characterFields, threshold);

    const charEntries: Array<{ path: string; chars: number }> = [];
    for (const [rawKey, rawValue] of Object.entries(options.characterFields ?? {})) {
        if (typeof rawValue !== 'string') {
            continue;
        }
        const trimmedValue = rawValue.trim();
        if (!trimmedValue) {
            continue;
        }
        const normalizedKey = rawKey.trim().toLowerCase().replace(/\.md$/, '');
        if (NON_SETTING_CHARACTER_FIELDS.has(normalizedKey)) {
            continue;
        }
        const fileName = rawKey.trim().endsWith('.md') ? rawKey.trim() : `${rawKey.trim()}.md`;
        charEntries.push({
            path: `/character/${fileName}`,
            chars: trimmedValue.length,
        });
    }
    charEntries.sort((a, b) => a.path.localeCompare(b.path));

    const sortedCoreEntries = [...options.coreEntries].sort(
        (a, b) =>
            b.entry.order - a.entry.order
            || a.entry.world.localeCompare(b.entry.world)
            || a.entry.uid - b.entry.uid,
    );

    const lines: string[] = ['<core-manifest>'];

    if (isHollowCard) {
        lines.push(
            '注意：当前卡片属于“世界书驱动型卡片”（空壳角色卡），原生角色设定字段极简或为空，核心人设、主角面板与世界观总纲位于下方常驻世界书条目中。请先通过 read_file 按需读取核心条目，切勿误判为缺乏背景设定。',
        );
    }

    if (charEntries.length > 0) {
        lines.push('角色与基础档案路径：');
        for (const item of charEntries) {
            lines.push(`- ${item.path} (~${item.chars}字)`);
        }
    }

    const personaText = options.personaDescription?.trim() ?? '';
    if (personaText.length > 0) {
        lines.push(`- /persona/description.md (~${personaText.length}字)`);
    }

    if (sortedCoreEntries.length > 0) {
        lines.push('核心常驻世界书条目（Category ②，请按需调用 read_file 阅读）：');
        for (const item of sortedCoreEntries) {
            const title = item.entry.comment?.trim() || item.slug;
            lines.push(`- ${item.vfsPath} | ${title} (~${item.charCount}字)`);
        }
    } else if (isHollowCard) {
        lines.push('暂无已分类的核心常驻世界书条目，可使用 list_dir 或 search_files 浏览 /lorebooks/。');
    }

    lines.push('</core-manifest>');

    return {
        isHollowCard,
        characterFilePaths: charEntries.map((item) => item.path),
        coreEntries: sortedCoreEntries,
        text: lines.join('\n'),
    };
}

/**
 * Classify a single `RawLoreEntry` into one of the four `ST-Agentic` semantic categories:
 * `system_rule`, `core_manifest`, `on_demand_archive`, or `dynamic_or_trigger`.
 */
export function classifyEntry(
    entry: RawLoreEntry,
    options?: Pick<WIClassifyOptions, 'overrides'>,
): ClassifiedLoreEntry {
    const parsed = DecoratorParser.parseEntry(entry);
    const slug = slugifyLoreComment(entry.comment);
    const vfsPath = buildLoreVfsPath(entry, parsed.decorators);
    const cleanContent = parsed.cleanContent;
    const charCount = cleanContent.trim().length;

    const manualCategory = resolveManualOverride(entry, vfsPath, options?.overrides);
    if (manualCategory) {
        return {
            entry,
            category: manualCategory,
            vfsPath,
            slug,
            decorators: parsed.decorators,
            cleanContent,
            charCount,
            overridden: true,
            reason: 'manual_override',
        };
    }

    const classifyResult = determineCategory(entry, parsed.decorators, cleanContent);

    return {
        entry,
        category: classifyResult.category,
        vfsPath,
        slug,
        decorators: parsed.decorators,
        cleanContent,
        charCount,
        overridden: false,
        reason: classifyResult.reason,
    };
}

function determineCategory(
    entry: RawLoreEntry,
    decorators: readonly ParsedDecorator[],
    cleanContent: string,
): { category: WICategory; reason: string } {
    const hasSystemDecorator = decorators.some((d) => d.name === '@@system');
    if (hasSystemDecorator) {
        return { category: 'system_rule', reason: 'decorator:@@system' };
    }

    const controlDecorator = decorators.find((d) => CATEGORY_4_DECORATORS.has(d.name));
    if (controlDecorator) {
        return { category: 'dynamic_or_trigger', reason: `decorator:${controlDecorator.name}` };
    }

    if (INIT_VAR_PATTERN.test(entry.comment ?? '') || INIT_VAR_PATTERN.test(cleanContent)) {
        return { category: 'dynamic_or_trigger', reason: 'init_var' };
    }

    if (GENERATE_DIRECTIVE_PATTERN.test(cleanContent)) {
        return { category: 'dynamic_or_trigger', reason: 'generate_directive' };
    }

    if (VAR_MUTATION_PATTERN.test(cleanContent)) {
        return { category: 'dynamic_or_trigger', reason: 'variable_mutation' };
    }

    if (isPureEjsScript(cleanContent)) {
        return { category: 'dynamic_or_trigger', reason: 'pure_script' };
    }

    if (entry.constant) {
        if (
            entry.position === WORLD_INFO_POSITION.atDepth
            && DYNAMIC_EXPR_PATTERN.test(cleanContent)
        ) {
            return { category: 'dynamic_or_trigger', reason: 'dynamic_at_depth' };
        }

        if (
            entry.position === WORLD_INFO_POSITION.atDepth
            && entry.depth >= 0
            && entry.depth <= 2
            && isSystemRole(entry.role)
        ) {
            return { category: 'system_rule', reason: 'constant_at_depth_system' };
        }

        return { category: 'core_manifest', reason: 'constant_core_manifest' };
    }

    return { category: 'on_demand_archive', reason: 'keyword_archive' };
}

/**
 * Four-way semantic classifier for SillyTavern World Info entries, supporting
 * hollow character cards, `wiRouterOverrides`, and Core Manifest generation.
 */
export class WIClassifier {
    private readonly defaultOptions: WIClassifyOptions;

    constructor(options: WIClassifyOptions = {}) {
        this.defaultOptions = { ...options };
    }

    public classifyEntry(
        entry: RawLoreEntry,
        options?: Pick<WIClassifyOptions, 'overrides'>,
    ): ClassifiedLoreEntry {
        return classifyEntry(entry, {
            overrides: options?.overrides ?? this.defaultOptions.overrides,
        });
    }

    public classifyEntries(
        entries: readonly RawLoreEntry[],
        options?: WIClassifyOptions,
    ): WIClassificationResult {
        const includeDisabled = options?.includeDisabled ?? this.defaultOptions.includeDisabled ?? false;
        const overrides = options?.overrides ?? this.defaultOptions.overrides;

        const all: ClassifiedLoreEntry[] = [];
        const byCategory: Record<WICategory, ClassifiedLoreEntry[]> = {
            system_rule: [],
            core_manifest: [],
            on_demand_archive: [],
            dynamic_or_trigger: [],
        };
        const byPath = new Map<string, ClassifiedLoreEntry>();

        for (const entry of entries) {
            if (!includeDisabled && entry.disable) {
                continue;
            }
            const classified = this.classifyEntry(entry, { overrides });
            all.push(classified);
            byCategory[classified.category].push(classified);
            byPath.set(classified.vfsPath, classified);
        }

        return { all, byCategory, byPath };
    }

    public classifyLorebooks(
        lorebooks: Map<string, RawLoreEntry[]> | Record<string, RawLoreEntry[]>,
        options?: WIClassifyOptions,
    ): WIClassificationResult {
        const flattened: RawLoreEntry[] = [];
        const entriesIter = lorebooks instanceof Map
            ? lorebooks.entries()
            : Object.entries(lorebooks);

        for (const [world, entries] of entriesIter) {
            for (const entry of entries) {
                flattened.push(entry.world ? entry : { ...entry, world });
            }
        }

        return this.classifyEntries(flattened, options);
    }

    public isHollowCharacterCard(
        characterFields: Record<string, string>,
        threshold: number = DEFAULT_HOLLOW_CARD_THRESHOLD,
    ): boolean {
        return isHollowCharacterCard(characterFields, threshold);
    }

    public buildCoreManifest(options: CoreManifestOptions): CoreManifestResult {
        return buildCoreManifest(options);
    }
}
