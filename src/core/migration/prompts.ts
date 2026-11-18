import { isPlainRecord, sanitizeName } from '../config';
import type { MigrationReport, PromptBlock } from '../types';

/**
 * Built-in prompt slot identifiers from SillyTavern and legacy ST-CustomGeneration
 * that are superseded by Layer 0 / VFS / Pull-First architecture and skipped on migration.
 */
export const BUILTIN_SLOT_IDENTIFIERS = new Set<string>([
    'main',
    'personaDescription',
    'charDescription',
    'charPersonality',
    'scenario',
    'chatExamples',
    'dialogueExamples',
    'worldInfoBefore',
    'worldInfoAfter',
    'chatHistory',
    'worldInfoDepth',
    'authorsNoteDepth',
    'presetDepth',
    'charDepth',
    'worldInfoOutlet',
    'charNote',
    'authorsNote',
    'lastCharMessage',
    'lastUserMessage',
    'worldInfoDepth0',
    'worldInfoDepth1',
    'worldInfoDepth2',
    'worldInfoDepth3',
    'worldInfoDepth4',
    'presetDepth0',
    'presetDepth1',
    'presetDepth2',
    'presetDepth3',
    'presetDepth4',
    'chatDepth0',
    'chatDepth1',
    'chatDepth2',
    'chatDepth3',
    'chatDepth4',
    'toolCalls',
    'skillDefinitions',
    'skillBodies',
]);

/** Create an empty initialized `MigrationReport`. */
export function createEmptyMigrationReport(
    sourceFormat: MigrationReport['sourceFormat'],
): MigrationReport {
    return {
        sourceFormat,
        migratedConnections: 0,
        migratedPresets: 0,
        migratedAgents: 0,
        migratedPromptBlocks: 0,
        migratedTriggers: 0,
        migratedRegexRules: 0,
        migratedFiles: 0,
        skippedItems: [],
        warnings: [],
    };
}

/** Generate a deterministic unique identifier using a sanitized base and a collision set. */
export function allocateUniqueId(base: string, used: Set<string>, fallback = 'item'): string {
    const cleaned = base
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const seed = cleaned || fallback;

    if (!used.has(seed)) {
        used.add(seed);
        return seed;
    }

    let suffix = 2;
    while (used.has(`${seed}_${suffix}`)) {
        suffix += 1;
    }
    const unique = `${seed}_${suffix}`;
    used.add(unique);
    return unique;
}

function normalizePromptRole(role: unknown): PromptBlock['role'] {
    if (role === 'user' || role === 'assistant') {
        return role;
    }
    return 'system';
}

function resolvePlacementAndSkip(
    name: string,
    isInChat: boolean,
    depthRaw: unknown,
    report: MigrationReport,
): PromptBlock['placement'] | null {
    if (!isInChat) {
        return 'prefix';
    }

    const depthNum = Number(depthRaw);
    const depth = Number.isFinite(depthNum) ? Math.trunc(depthNum) : 4;
    if (depth === 0) {
        return 'tail';
    }

    report.skippedItems.push({
        name,
        reason: 'depth_injection',
        detail: `@D${depth}`,
    });
    return null;
}

/**
 * Convert legacy ST-CustomGeneration `PresetPrompt[]` entries into `PromptBlock[]`.
 * Built-in marker slots (`internal != null`) and `@D >= 1` depth injections are skipped and
 * recorded in `report.skippedItems`.
 */
export function convertLegacyPromptsToBlocks(
    rawPrompts: unknown,
    report: MigrationReport,
    options: { idPrefix?: string; recordBuiltinSkips?: boolean } = {},
): PromptBlock[] {
    if (!Array.isArray(rawPrompts)) {
        return [];
    }

    const blocks: PromptBlock[] = [];
    const usedIds = new Set<string>();
    const prefix = options.idPrefix ?? 'block';
    const recordBuiltinSkips = options.recordBuiltinSkips ?? true;

    rawPrompts.forEach((item, index) => {
        if (!isPlainRecord(item)) {
            return;
        }

        const name = sanitizeName(item.name, `Prompt ${index + 1}`);
        const internal = typeof item.internal === 'string' ? item.internal.trim() : '';

        if (internal.length > 0) {
            if (recordBuiltinSkips) {
                report.skippedItems.push({
                    name,
                    reason: 'builtin_slot',
                    detail: internal,
                });
            }
            return;
        }

        const isInChat = item.injectionPosition === 'inChat';
        const placement = resolvePlacementAndSkip(name, isInChat, item.injectionDepth, report);
        if (!placement) {
            return;
        }

        const content = typeof item.prompt === 'string' ? item.prompt : String(item.prompt ?? '');
        if (item.enabled === null && content.trim().length === 0) {
            return;
        }

        const enabled = item.enabled === undefined || item.enabled === null
            ? true
            : Boolean(item.enabled);
        const id = allocateUniqueId(`${prefix}_${name}`, usedIds, `${prefix}_${index + 1}`);

        blocks.push({
            id,
            name,
            role: normalizePromptRole(item.role),
            placement,
            content,
            enabled,
        });
        report.migratedPromptBlocks += 1;
    });

    return blocks;
}

interface OrderedStPrompt {
    prompt: Record<string, unknown>;
    enabled: boolean;
}

function resolveOrderedStPrompts(
    rawPrompts: unknown[],
    rawPromptOrder: unknown,
): OrderedStPrompt[] {
    const promptByIdentifier = new Map<string, Record<string, unknown>>();
    for (const item of rawPrompts) {
        if (isPlainRecord(item) && typeof item.identifier === 'string') {
            promptByIdentifier.set(item.identifier, item);
        }
    }

    if (Array.isArray(rawPromptOrder) && rawPromptOrder.length > 0) {
        const preferred =
            rawPromptOrder.find(
                (entry) => isPlainRecord(entry) && Number(entry.character_id) === 100001,
            )
            ?? rawPromptOrder[1]
            ?? rawPromptOrder[0];

        if (isPlainRecord(preferred) && Array.isArray(preferred.order) && preferred.order.length > 0) {
            const ordered: OrderedStPrompt[] = [];
            for (const entry of preferred.order) {
                if (!isPlainRecord(entry) || typeof entry.identifier !== 'string') {
                    continue;
                }
                const prompt = promptByIdentifier.get(entry.identifier);
                if (!prompt) {
                    continue;
                }
                ordered.push({
                    prompt,
                    enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
                });
            }
            return ordered;
        }
    }

    return rawPrompts
        .filter(isPlainRecord)
        .map((prompt) => ({
            prompt,
            enabled: prompt.enabled === undefined ? true : Boolean(prompt.enabled),
        }));
}

/**
 * Convert traditional SillyTavern OpenAI preset `prompts` + `prompt_order` into `PromptBlock[]`,
 * skipping built-in marker slots and `@D >= 1` depth injections into `report.skippedItems`.
 */
export function convertStOpenAiPromptsToBlocks(
    rawPrompts: unknown,
    rawPromptOrder: unknown,
    report: MigrationReport,
): PromptBlock[] {
    if (!Array.isArray(rawPrompts)) {
        return [];
    }

    const ordered = resolveOrderedStPrompts(rawPrompts, rawPromptOrder);
    const blocks: PromptBlock[] = [];
    const usedIds = new Set<string>();

    ordered.forEach(({ prompt, enabled }, index) => {
        const identifier = typeof prompt.identifier === 'string' ? prompt.identifier.trim() : '';
        const name = sanitizeName(prompt.name, identifier || `Prompt ${index + 1}`);
        const content = typeof prompt.content === 'string'
            ? prompt.content
            : String(prompt.content ?? '');

        const isMarker = Boolean(prompt.marker);
        const mappedId = identifier === 'dialogueExamples' ? 'chatExamples' : identifier;
        const isBuiltinSlot =
            isMarker
            || BUILTIN_SLOT_IDENTIFIERS.has(identifier)
            || BUILTIN_SLOT_IDENTIFIERS.has(mappedId)
            || ((identifier === 'nsfw' || identifier === 'jailbreak')
                && prompt.system_prompt === true
                && content.trim().length === 0);

        if (isBuiltinSlot) {
            report.skippedItems.push({
                name,
                reason: 'builtin_slot',
                detail: identifier || 'marker',
            });
            return;
        }

        const rawPos = prompt.injection_position;
        const isInChat =
            rawPos === 1 || rawPos === '1' || rawPos === 'inChat' || rawPos === 'absolute';
        const placement = resolvePlacementAndSkip(name, isInChat, prompt.injection_depth, report);
        if (!placement) {
            return;
        }

        if (!enabled && content.trim().length === 0) {
            return;
        }

        const id = allocateUniqueId(identifier || name, usedIds, `st_block_${index + 1}`);
        blocks.push({
            id,
            name,
            role: normalizePromptRole(prompt.role),
            placement,
            content,
            enabled,
        });
        report.migratedPromptBlocks += 1;
    });

    return blocks;
}
