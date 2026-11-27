import { z } from 'zod';
import {
    createDefaultConnection,
    createDefaultPreset,
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    normalizeAgentProfile,
    normalizeConnection,
    normalizeCustomToolConfig,
    normalizePresetMessageScript,
    normalizePromptBlock,
    normalizeRegexRule,
    normalizeSettings,
    normalizeTriggerRule,
    resolveActivePreset,
    validatePresetFileName,
} from '@/core/config';
import { BUILTIN_TOOL_NAMES } from '@/core/tools';
import type {
    AgentProfile,
    ApiConnection,
    BuiltinToolConfig,
    CustomToolConfig,
    OffMainlineSettings,
    Preset,
    PresetMessageScript,
    PromptBlock,
    PromptTriggerType,
    RegexRule,
    Settings,
    TriggerRule,
    WICategory,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { computeDiffLines } from './approval';
import { isSecretKey, REDACTED_PLACEHOLDER, redactWithReport } from './redact';
import {
    finalizeMutationToolResult,
    finalizeReadToolResult,
    finalizeToolError,
    throwIfAssistantAborted,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';

const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getLatestSettingsSnapshot(ctx: AssistantToolContext): Settings {
    const raw = ctx.getLatestSettings?.() ?? ctx.settings;
    if (!raw) {
        throw new Error('ST-Agentic settings are unavailable in AssistantToolContext.');
    }
    return canonicalClone(raw);
}

function requireSettingsUpdater(
    ctx: AssistantToolContext,
): (updater: (prev: Settings) => Settings) => Promise<Settings> | Settings {
    if (!ctx.updateSettings) {
        throw new Error(
            'Settings live updater (ctx.updateSettings) is not available in this environment.',
        );
    }
    return ctx.updateSettings;
}

function resolveTargetPreset(settings: Settings, presetId?: string): Preset {
    if (presetId && presetId.trim()) {
        const found = settings.presets[presetId.trim()];
        if (!found) {
            throw new Error(`ST-Agentic preset "${presetId.trim()}" not found.`);
        }
        return found;
    }
    return resolveActivePreset(settings);
}

function allocateUniquePresetId(presets: Record<string, Preset>, base: string): string {
    const slug = base
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'preset';
    if (!presets[slug]) {
        return slug;
    }
    let counter = 2;
    while (presets[`${slug}_${counter}`]) {
        counter += 1;
    }
    return `${slug}_${counter}`;
}

function allocateComponentId(prefix: string, existingIds: ReadonlySet<string>): string {
    let counter = existingIds.size + 1;
    while (existingIds.has(`${prefix}_${counter}`)) {
        counter += 1;
    }
    return `${prefix}_${counter}`;
}

/**
 * Preserve real `apiKey` and secret `includeHeaders` values when incoming connection fields
 * omit secrets or pass `***REDACTED***`.
 */
export function preserveRedactedConnectionSecrets(
    incoming: Partial<ApiConnection> & Record<string, unknown>,
    existing?: ApiConnection,
    options?: { clearApiKey?: boolean },
): Partial<ApiConnection> & Record<string, unknown> {
    const next: Partial<ApiConnection> & Record<string, unknown> = canonicalClone(incoming);

    if (options?.clearApiKey) {
        next.apiKey = '';
    } else if (existing) {
        const rawKey = next.apiKey;
        if (
            rawKey === undefined
            || rawKey === ''
            || (typeof rawKey === 'string' && rawKey.includes(REDACTED_PLACEHOLDER))
        ) {
            next.apiKey = existing.apiKey;
        }
    } else if (typeof next.apiKey === 'string' && next.apiKey.includes(REDACTED_PLACEHOLDER)) {
        next.apiKey = '';
    }

    if (existing && isPlainRecord(next.includeHeaders)) {
        const mergedHeaders: Record<string, unknown> = { ...next.includeHeaders };
        for (const [headerKey, headerVal] of Object.entries(mergedHeaders)) {
            if (
                typeof headerVal === 'string'
                && headerVal.includes(REDACTED_PLACEHOLDER)
                && typeof existing.includeHeaders?.[headerKey] === 'string'
                && existing.includeHeaders[headerKey] !== ''
            ) {
                mergedHeaders[headerKey] = existing.includeHeaders[headerKey];
            }
        }
        next.includeHeaders = mergedHeaders;
    }

    return next;
}

/**
 * Strip `apiKey` and secret `includeHeaders` values before persisting an `ApiConnection`
 * inside an `UndoRecord` (which is stored in `chat_metadata`).
 */
export function stripConnectionSecretsForUndo(connection: ApiConnection): Record<string, unknown> {
    const copy = canonicalClone(connection) as unknown as Record<string, unknown>;
    delete copy.apiKey;
    if (isPlainRecord(copy.includeHeaders)) {
        const safeHeaders: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(copy.includeHeaders)) {
            if (isSecretKey(key, value)) {
                continue;
            }
            if (typeof value === 'string' && /\bBearer\s+/i.test(value)) {
                continue;
            }
            safeHeaders[key] = value;
        }
        copy.includeHeaders = safeHeaders;
    }
    return copy;
}

type PromptScriptStage = 'preprocess' | 'postprocess';

function parsePromptScriptStageToken(raw: unknown): PromptScriptStage | null {
    if (typeof raw !== 'string') {
        return null;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'preprocess' || normalized === 'postprocess') {
        return normalized;
    }
    return null;
}

function resolvePromptScriptStage(rawId?: unknown, rawStage?: unknown): PromptScriptStage {
    const idStage = parsePromptScriptStageToken(rawId);
    const explicitStage = parsePromptScriptStageToken(rawStage);
    if (typeof rawId === 'string' && rawId.trim() !== '' && !idStage) {
        throw new Error(
            `Invalid prompt_script id "${rawId.trim()}": expected "preprocess" or "postprocess".`,
        );
    }
    if (typeof rawStage === 'string' && rawStage.trim() !== '' && !explicitStage) {
        throw new Error(
            `Invalid prompt_script stage "${rawStage.trim()}": expected "preprocess" or "postprocess".`,
        );
    }
    if (idStage && explicitStage && idStage !== explicitStage) {
        throw new Error(
            `Conflicting prompt_script id ("${idStage}") and stage ("${explicitStage}").`,
        );
    }
    const resolved = idStage ?? explicitStage;
    if (!resolved) {
        throw new Error('prompt_script requires id or stage to be "preprocess" or "postprocess".');
    }
    return resolved;
}

function mergePresetMessageScript(
    existing: PresetMessageScript | undefined,
    patch: Record<string, unknown>,
): PresetMessageScript {
    const mergedRaw: Record<string, unknown> = {
        enabled: existing ? existing.enabled : true,
        code: existing?.code ?? '',
        ...(existing?.triggers ? { triggers: [...existing.triggers] } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.code !== undefined ? { code: patch.code } : {}),
        ...(patch.triggers !== undefined ? { triggers: patch.triggers } : {}),
    };
    return (
        normalizePresetMessageScript(mergedRaw) ?? {
            enabled: false,
            code: '',
        }
    );
}

function summarizePresetMessageScript(script?: PresetMessageScript) {
    const code = script?.code ?? '';
    return {
        configured: Boolean(script),
        enabled: Boolean(script?.enabled),
        hasCode: code.trim().length > 0,
        codeLength: code.length,
        triggers: script?.triggers ?? ([] as PromptTriggerType[]),
    };
}

function summarizePresetForCatalog(preset: Preset, currentPresetId: string) {
    const mainAgent = preset.agents[preset.mainAgentId];
    return {
        id: preset.id,
        name: preset.name,
        active: preset.id === currentPresetId,
        mainAgentId: preset.mainAgentId,
        counts: {
            agents: Object.keys(preset.agents).length,
            mainPromptBlocks: mainAgent?.promptBlocks.length ?? 0,
            triggers: preset.triggers.length,
            customTools: preset.customTools.length,
            regexRules: preset.regexRules.length,
            presetFiles: Object.keys(preset.files).length,
            wiRouterOverrides: Object.keys(preset.wiRouterOverrides).length,
        },
        preprocessScript: summarizePresetMessageScript(preset.preprocessScript),
        postprocessScript: summarizePresetMessageScript(preset.postprocessScript),
        agentIds: Object.keys(preset.agents),
        customToolNames: preset.customTools.map((t) => ({ id: t.id, name: t.name, kind: t.kind, enabled: t.enabled })),
        triggerIds: preset.triggers.map((t) => ({
            id: t.id,
            label: t.label,
            kind: t.kind,
            phase: t.phase,
            ...(t.events?.length ? { events: t.events } : {}),
            enabled: t.enabled,
        })),
        regexIds: preset.regexRules.map((r) => ({ id: r.id, name: r.name, stage: r.stage, enabled: r.enabled })),
        presetFilePaths: Object.keys(preset.files).sort(),
    };
}

// ============================================================================
// Zod Schemas
// ============================================================================

const AGENTIC_CONFIG_READ_SCHEMA = z.object({
    section: z
        .enum([
            'summary',
            'settings',
            'presets',
            'preset',
            'prompts',
            'prompt_scripts',
            'agents',
            'triggers',
            'tools',
            'regex',
            'wi_router',
            'connections',
        ])
        .optional()
        .default('summary')
        .describe('Config section to inspect.'),
    presetId: z.string().optional().describe('Target ST-Agentic preset ID (defaults to currentPresetId).'),
    agentId: z.string().optional().describe('Optional AgentProfile ID when reading prompts or agents.'),
    itemId: z
        .string()
        .optional()
        .describe(
            'Optional item ID/name/path filter for targeted drill-down (e.g. "preprocess" | "postprocess" for prompt_scripts).',
        ),
});

const PRESET_MESSAGE_SCRIPT_PATCH_SCHEMA = z.object({
    enabled: z.boolean().optional(),
    code: z.string().optional(),
    triggers: z.array(z.string()).nullable().optional(),
});

const AGENTIC_SETTINGS_PATCH_SCHEMA = z.object({
    runMode: z.enum(['off', 'companion', 'takeover']).optional(),
    themeMode: z.enum(['dark', 'light', 'auto']).optional(),
    capsulePosition: z.enum(['top', 'bottom']).optional(),
    capsulePersistMode: z.enum(['keep', 'auto_hide']).optional(),
    currentPresetId: z.string().min(1).optional(),
    currentConnectionId: z.string().min(1).optional(),
    storage: z
        .object({
            autoCompact: z.boolean().optional(),
            keepDepth: z.number().int().min(1).optional(),
            sizeThreshold: z.number().int().min(1024).optional(),
            pruneLegacy: z.boolean().optional(),
            fuzzyIndexFiles: z.boolean().optional(),
        })
        .optional(),
    offMainline: z
        .object({
            defaultAssistantConnectionId: z.string().optional(),
            defaultDelivery: z.enum(['none', 'vfs_only', 'radar_hint', 'next_turn_brief']).optional(),
        })
        .optional(),
    createPreset: z
        .object({
            id: z.string().optional(),
            name: z.string().min(1),
            cloneFromPresetId: z.string().optional(),
            setAsCurrent: z.boolean().optional().default(true),
        })
        .optional(),
    renamePreset: z
        .object({
            presetId: z.string().min(1),
            name: z.string().min(1),
        })
        .optional(),
    deletePresetId: z
        .string()
        .min(1)
        .optional()
        .describe('Preset ID to permanently delete (mandatoryConfirm; cannot delete last remaining preset).'),
    presetPatch: z
        .object({
            presetId: z.string().optional(),
            mainAgentId: z.string().min(1).optional(),
            wiRouterOverrides: z
                .record(
                    z.string(),
                    z.enum(['system_rule', 'core_manifest', 'on_demand_archive', 'dynamic_or_trigger']).nullable(),
                )
                .optional(),
            builtinToolSettings: z
                .record(
                    z.string(),
                    z
                        .object({
                            enabled: z.boolean(),
                            description: z.string().optional(),
                            parameters: z.record(z.string(), z.string()).optional(),
                        })
                        .nullable(),
                )
                .optional(),
            preprocessScript: PRESET_MESSAGE_SCRIPT_PATCH_SCHEMA.nullable().optional(),
            postprocessScript: PRESET_MESSAGE_SCRIPT_PATCH_SCHEMA.nullable().optional(),
        })
        .optional(),
});

const PRESET_COMPONENT_KIND_SCHEMA = z.enum([
    'prompt_block',
    'prompt_script',
    'agent',
    'trigger',
    'custom_tool',
    'regex_rule',
    'preset_file',
]);

type PresetComponentKind = z.infer<typeof PRESET_COMPONENT_KIND_SCHEMA>;

const AGENTIC_PRESET_COMPONENT_UPSERT_SCHEMA = z.object({
    presetId: z.string().optional().describe('Target preset ID; defaults to currentPresetId.'),
    kind: PRESET_COMPONENT_KIND_SCHEMA,
    agentId: z.string().optional().describe('Agent ID for prompt_block; defaults to preset.mainAgentId.'),
    insertAt: z.number().int().min(0).optional().describe('Optional insertion index when creating ordered list items.'),
    item: z
        .record(z.string(), z.unknown())
        .describe(
            'Component fields (merged over existing item if id/name matches; for prompt_script use id/stage: "preprocess" | "postprocess", enabled?, code?, triggers?).',
        ),
    reloadMessages: z
        .boolean()
        .optional()
        .default(true)
        .describe('When upserting a display-stage regex_rule, automatically reload displayed chat messages.'),
});

const AGENTIC_PRESET_COMPONENT_DELETE_SCHEMA = z.object({
    presetId: z.string().optional().describe('Target preset ID; defaults to currentPresetId.'),
    kind: PRESET_COMPONENT_KIND_SCHEMA,
    id: z
        .string()
        .min(1)
        .describe(
            'Component ID (or custom_tool name / preset_file relative path / prompt_script stage "preprocess" | "postprocess").',
        ),
    agentId: z.string().optional().describe('Agent ID for prompt_block; defaults to preset.mainAgentId.'),
    reloadMessages: z
        .boolean()
        .optional()
        .default(true)
        .describe('When deleting a display-stage regex_rule, automatically reload displayed chat messages.'),
});

const AGENTIC_CONNECTION_UPSERT_SCHEMA = z.object({
    id: z.string().min(1).describe('Connection ID to create or update.'),
    name: z.string().optional(),
    providerFormat: z.enum(['openai', 'anthropic', 'gemini']).optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional().describe('API key (omit or leave unchanged to preserve existing apiKey).'),
    clearApiKey: z.boolean().optional().default(false),
    model: z.string().optional(),
    contextSize: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    topK: z.number().int().min(0).optional(),
    topP: z.number().min(0).max(1).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    stream: z.boolean().optional(),
    includeHeaders: z.record(z.string(), z.unknown()).optional(),
    includeBody: z.record(z.string(), z.unknown()).optional(),
    excludeBody: z.record(z.string(), z.unknown()).optional(),
    maxConcurrency: z.number().int().min(1).optional(),
    cachePolicy: z.enum(['auto_prefix', 'anthropic_explicit', 'none']).optional(),
    maxCacheBreakpoints: z.number().int().min(0).max(4).optional(),
    promptPostProcessing: z.enum(['none', 'merge', 'semi', 'strict', 'single']).optional(),
    systemInstructionMode: z
        .enum(['native', 'user', 'model'])
        .optional()
        .describe(
            "System instruction handling: 'native' (keep system/systemInstruction), 'user' (convert all system messages to user), or 'model' (convert all system messages to model/assistant).",
        ),
    linkedPreset: z.string().optional(),
    strictToolLoop: z.boolean().optional(),
    roundMaxRetries: z.number().int().min(0).max(10).optional(),
    setAsCurrent: z.boolean().optional().default(false),
});

// ============================================================================
// Pure Patch Application Helpers (reused by preview + execute)
// ============================================================================

function applyAgenticSettingsPatch(
    baseSettings: Settings,
    args: z.infer<typeof AGENTIC_SETTINGS_PATCH_SCHEMA>,
): { nextSettings: Settings; affectedPresetIds: Set<string>; summaryParts: string[] } {
    const next = canonicalClone(baseSettings);
    const affectedPresetIds = new Set<string>();
    const summaryParts: string[] = [];

    if (args.createPreset) {
        const requestedId = args.createPreset.id?.trim();
        if (requestedId && next.presets[requestedId]) {
            throw new Error(`Preset ID "${requestedId}" already exists.`);
        }
        const newId = requestedId || allocateUniquePresetId(next.presets, args.createPreset.name);
        let created: Preset;
        if (args.createPreset.cloneFromPresetId?.trim()) {
            const source = next.presets[args.createPreset.cloneFromPresetId.trim()];
            if (!source) {
                throw new Error(`Source preset "${args.createPreset.cloneFromPresetId}" not found.`);
            }
            created = canonicalClone(source);
            created.id = newId;
            created.name = args.createPreset.name.trim();
        } else {
            created = createDefaultPreset({ id: newId, name: args.createPreset.name.trim() });
        }
        next.presets[newId] = created;
        affectedPresetIds.add(newId);
        if (args.createPreset.setAsCurrent !== false) {
            next.currentPresetId = newId;
        }
        summaryParts.push(`createPreset(${newId})`);
    }

    if (args.renamePreset) {
        const target = next.presets[args.renamePreset.presetId];
        if (!target) {
            throw new Error(`Preset "${args.renamePreset.presetId}" not found.`);
        }
        affectedPresetIds.add(target.id);
        target.name = args.renamePreset.name.trim();
        summaryParts.push(`renamePreset(${target.id})`);
    }

    if (args.deletePresetId) {
        const delId = args.deletePresetId.trim();
        if (!next.presets[delId]) {
            throw new Error(`Preset "${delId}" not found.`);
        }
        if (Object.keys(next.presets).length <= 1) {
            throw new Error('Cannot delete the last remaining ST-Agentic preset.');
        }
        affectedPresetIds.add(delId);
        delete next.presets[delId];
        if (next.currentPresetId === delId) {
            next.currentPresetId = Object.keys(next.presets)[0]!;
        }
        summaryParts.push(`deletePreset(${delId})`);
    }

    if (args.presetPatch) {
        const target = resolveTargetPreset(next, args.presetPatch.presetId);
        affectedPresetIds.add(target.id);
        if (args.presetPatch.mainAgentId !== undefined) {
            if (!target.agents[args.presetPatch.mainAgentId]) {
                throw new Error(
                    `Agent "${args.presetPatch.mainAgentId}" does not exist in preset "${target.id}".`,
                );
            }
            target.mainAgentId = args.presetPatch.mainAgentId;
        }
        if (args.presetPatch.wiRouterOverrides) {
            const nextOverrides: Record<string, WICategory> = { ...target.wiRouterOverrides };
            for (const [key, cat] of Object.entries(args.presetPatch.wiRouterOverrides)) {
                if (cat === null) {
                    delete nextOverrides[key];
                } else {
                    nextOverrides[key] = cat;
                }
            }
            target.wiRouterOverrides = nextOverrides;
        }
        if (args.presetPatch.builtinToolSettings) {
            const nextBuiltin: Record<string, BuiltinToolConfig> = {
                ...(target.builtinToolSettings ?? {}),
            };
            for (const [toolName, cfg] of Object.entries(args.presetPatch.builtinToolSettings)) {
                if (cfg === null) {
                    delete nextBuiltin[toolName];
                } else {
                    nextBuiltin[toolName] = canonicalClone(cfg);
                }
            }
            target.builtinToolSettings = nextBuiltin;
        }
        if (args.presetPatch.preprocessScript !== undefined) {
            if (args.presetPatch.preprocessScript === null) {
                delete target.preprocessScript;
            } else {
                target.preprocessScript = mergePresetMessageScript(
                    target.preprocessScript,
                    args.presetPatch.preprocessScript as Record<string, unknown>,
                );
            }
        }
        if (args.presetPatch.postprocessScript !== undefined) {
            if (args.presetPatch.postprocessScript === null) {
                delete target.postprocessScript;
            } else {
                target.postprocessScript = mergePresetMessageScript(
                    target.postprocessScript,
                    args.presetPatch.postprocessScript as Record<string, unknown>,
                );
            }
        }
        summaryParts.push(`presetPatch(${target.id})`);
    }

    if (args.runMode !== undefined) {
        next.runMode = args.runMode;
        summaryParts.push(`runMode=${args.runMode}`);
    }
    if (args.themeMode !== undefined) {
        next.themeMode = args.themeMode;
        summaryParts.push(`themeMode=${args.themeMode}`);
    }
    if (args.capsulePosition !== undefined) {
        next.capsulePosition = args.capsulePosition;
        summaryParts.push(`capsulePosition=${args.capsulePosition}`);
    }
    if (args.capsulePersistMode !== undefined) {
        next.capsulePersistMode = args.capsulePersistMode;
        summaryParts.push(`capsulePersistMode=${args.capsulePersistMode}`);
    }
    if (args.currentPresetId !== undefined) {
        if (!next.presets[args.currentPresetId]) {
            throw new Error(`Preset "${args.currentPresetId}" not found.`);
        }
        next.currentPresetId = args.currentPresetId;
        summaryParts.push(`currentPresetId=${args.currentPresetId}`);
    }
    if (args.currentConnectionId !== undefined) {
        if (!next.connections[args.currentConnectionId]) {
            throw new Error(`Connection "${args.currentConnectionId}" not found.`);
        }
        next.currentConnectionId = args.currentConnectionId;
        summaryParts.push(`currentConnectionId=${args.currentConnectionId}`);
    }
    if (args.storage) {
        next.storage = {
            ...next.storage,
            ...args.storage,
        };
        summaryParts.push('storage');
    }
    if (args.offMainline) {
        const mergedOffMainline: OffMainlineSettings = {
            ...(next.offMainline ?? {}),
            ...args.offMainline,
        };
        next.offMainline = mergedOffMainline;
        summaryParts.push('offMainline');
    }

    return {
        nextSettings: normalizeSettings(next),
        affectedPresetIds,
        summaryParts,
    };
}

interface ComponentUpsertOutcome {
    nextSettings: Settings;
    presetId: string;
    previousPreset: Preset;
    itemLabel: string;
    beforeText: string;
    afterText: string;
    shouldReloadMessages: boolean;
    savedComponent: unknown;
}

function insertOrReplaceAt<T>(list: T[], index: number, item: T, insertAt?: number): T[] {
    const next = [...list];
    if (index >= 0) {
        next[index] = item;
        return next;
    }
    if (insertAt !== undefined && insertAt >= 0 && insertAt <= next.length) {
        next.splice(insertAt, 0, item);
        return next;
    }
    next.push(item);
    return next;
}

function applyPresetComponentUpsert(
    baseSettings: Settings,
    args: z.infer<typeof AGENTIC_PRESET_COMPONENT_UPSERT_SCHEMA>,
): ComponentUpsertOutcome {
    const nextSettings = canonicalClone(baseSettings);
    const preset = resolveTargetPreset(nextSettings, args.presetId);
    const previousPreset = canonicalClone(preset);
    const rawItem = canonicalClone(args.item);
    const kind: PresetComponentKind = args.kind;

    if (kind === 'prompt_block') {
        const targetAgentId = args.agentId?.trim() || preset.mainAgentId;
        const agent = preset.agents[targetAgentId];
        if (!agent) {
            throw new Error(`Agent "${targetAgentId}" not found in preset "${preset.id}".`);
        }
        const rawId = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
        const existingIdx = rawId ? agent.promptBlocks.findIndex((b) => b.id === rawId) : -1;
        const existing = existingIdx >= 0 ? agent.promptBlocks[existingIdx] : undefined;
        const resolvedId =
            rawId
            || allocateComponentId('block', new Set(agent.promptBlocks.map((b) => b.id)));
        const merged = {
            ...(existing ? canonicalClone(existing) : {}),
            ...rawItem,
            id: resolvedId,
        };
        const normalized: PromptBlock = normalizePromptBlock(
            merged,
            resolvedId,
            typeof merged.name === 'string' && merged.name.trim() ? merged.name : resolvedId,
        );
        agent.promptBlocks = insertOrReplaceAt(
            agent.promptBlocks,
            existingIdx,
            normalized,
            args.insertAt,
        );
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: `${targetAgentId}/${normalized.id}`,
            beforeText: existing?.content ?? '',
            afterText: normalized.content,
            shouldReloadMessages: false,
            savedComponent: normalized,
        };
    }

    if (kind === 'prompt_script') {
        const stage = resolvePromptScriptStage(rawItem.id, rawItem.stage);
        const propKey = stage === 'preprocess' ? 'preprocessScript' : 'postprocessScript';
        const existing = preset[propKey];
        const normalized = mergePresetMessageScript(existing, rawItem);
        preset[propKey] = normalized;
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: stage,
            beforeText: existing?.code ?? '',
            afterText: normalized.code,
            shouldReloadMessages: false,
            savedComponent: {
                id: stage,
                stage,
                ...normalized,
            },
        };
    }

    if (kind === 'agent') {
        const rawId =
            (typeof rawItem.id === 'string' && rawItem.id.trim())
            || args.agentId?.trim()
            || allocateComponentId('agent', new Set(Object.keys(preset.agents)));
        const existing = preset.agents[rawId];
        const merged = {
            ...(existing ? canonicalClone(existing) : {}),
            ...rawItem,
            id: rawId,
        };
        const normalized: AgentProfile = normalizeAgentProfile(merged, rawId);
        preset.agents[normalized.id] = normalized;
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: normalized.id,
            beforeText: existing ? JSON.stringify(existing, null, 2) : '',
            afterText: JSON.stringify(normalized, null, 2),
            shouldReloadMessages: false,
            savedComponent: normalized,
        };
    }

    if (kind === 'trigger') {
        const rawId = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
        const existingIdx = rawId ? preset.triggers.findIndex((t) => t.id === rawId) : -1;
        const existing = existingIdx >= 0 ? preset.triggers[existingIdx] : undefined;
        const resolvedId =
            rawId
            || allocateComponentId('trigger', new Set(preset.triggers.map((t) => t.id)));
        const merged = {
            ...(existing ? canonicalClone(existing) : {}),
            ...rawItem,
            id: resolvedId,
        };
        const normalized: TriggerRule = normalizeTriggerRule(merged, resolvedId);
        preset.triggers = insertOrReplaceAt(preset.triggers, existingIdx, normalized, args.insertAt);
        const beforeText =
            existing?.kind === 'script'
                ? (existing.scriptCode ?? '')
                : existing
                    ? JSON.stringify(existing, null, 2)
                    : '';
        const afterText =
            normalized.kind === 'script'
                ? (normalized.scriptCode ?? '')
                : JSON.stringify(normalized, null, 2);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: normalized.id,
            beforeText,
            afterText,
            shouldReloadMessages: false,
            savedComponent: normalized,
        };
    }

    if (kind === 'custom_tool') {
        const rawId = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
        const rawName = typeof rawItem.name === 'string' ? rawItem.name.trim() : '';
        const existingIdx = preset.customTools.findIndex(
            (t) => (rawId && t.id === rawId) || (!rawId && rawName && t.name === rawName),
        );
        const existing = existingIdx >= 0 ? preset.customTools[existingIdx] : undefined;
        const resolvedId =
            rawId
            || existing?.id
            || allocateComponentId('tool', new Set(preset.customTools.map((t) => t.id)));
        const merged = {
            ...(existing ? canonicalClone(existing) : {}),
            ...rawItem,
            id: resolvedId,
        };
        const normalized: CustomToolConfig = normalizeCustomToolConfig(merged, resolvedId);
        if (BUILTIN_TOOL_NAME_SET.has(normalized.name)) {
            throw new Error(
                `Custom tool name "${normalized.name}" conflicts with a built-in ST-Agentic tool.`,
            );
        }
        preset.customTools = insertOrReplaceAt(
            preset.customTools,
            existingIdx,
            normalized,
            args.insertAt,
        );
        const beforeText =
            existing?.kind === 'js'
                ? (existing.code ?? '')
                : existing
                    ? JSON.stringify(existing, null, 2)
                    : '';
        const afterText =
            normalized.kind === 'js'
                ? (normalized.code ?? '')
                : JSON.stringify(normalized, null, 2);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: normalized.name,
            beforeText,
            afterText,
            shouldReloadMessages: false,
            savedComponent: normalized,
        };
    }

    if (kind === 'regex_rule') {
        const rawId = typeof rawItem.id === 'string' ? rawItem.id.trim() : '';
        const existingIdx = rawId ? preset.regexRules.findIndex((r) => r.id === rawId) : -1;
        const existing = existingIdx >= 0 ? preset.regexRules[existingIdx] : undefined;
        const resolvedId =
            rawId
            || allocateComponentId('regex', new Set(preset.regexRules.map((r) => r.id)));
        const merged = {
            ...(existing ? canonicalClone(existing) : {}),
            ...rawItem,
            id: resolvedId,
        };
        const normalized: RegexRule = normalizeRegexRule(merged, resolvedId, resolvedId);
        preset.regexRules = insertOrReplaceAt(
            preset.regexRules,
            existingIdx,
            normalized,
            args.insertAt,
        );
        const touchesDisplay =
            normalized.stage === 'display' || existing?.stage === 'display';
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: normalized.name,
            beforeText: existing ? JSON.stringify(existing, null, 2) : '',
            afterText: JSON.stringify(normalized, null, 2),
            shouldReloadMessages: touchesDisplay && args.reloadMessages !== false,
            savedComponent: normalized,
        };
    }

    // kind === 'preset_file'
    const rawPath =
        (typeof rawItem.path === 'string' && rawItem.path.trim())
        || (typeof rawItem.name === 'string' && rawItem.name.trim())
        || (typeof rawItem.id === 'string' && rawItem.id.trim())
        || '';
    const relName = rawPath.replace(/^\/preset\//, '').replace(/^\/+/, '');
    const validationErr = validatePresetFileName(relName);
    if (validationErr) {
        throw new Error(validationErr);
    }
    const content =
        typeof rawItem.content === 'string'
            ? rawItem.content
            : String(rawItem.content ?? '');
    const currentTotal = Object.entries(preset.files).reduce(
        (sum, [name, text]) => (name === relName ? sum : sum + name.length + text.length),
        0,
    );
    if (currentTotal + relName.length + content.length > DEFAULT_FILE_MAP_SIZE_LIMIT) {
        throw new Error(
            `Preset files exceed the ${Math.floor(DEFAULT_FILE_MAP_SIZE_LIMIT / 1024)} KB size limit.`,
        );
    }
    const previousContent = preset.files[relName] ?? '';
    preset.files[relName] = content;
    return {
        nextSettings: normalizeSettings(nextSettings),
        presetId: preset.id,
        previousPreset,
        itemLabel: `/preset/${relName}`,
        beforeText: previousContent,
        afterText: content,
        shouldReloadMessages: false,
        savedComponent: { path: `/preset/${relName}`, key: relName, content },
    };
}

interface ComponentDeleteOutcome {
    nextSettings: Settings;
    presetId: string;
    previousPreset: Preset;
    itemLabel: string;
    beforeText: string;
    shouldReloadMessages: boolean;
}

function applyPresetComponentDelete(
    baseSettings: Settings,
    args: z.infer<typeof AGENTIC_PRESET_COMPONENT_DELETE_SCHEMA>,
): ComponentDeleteOutcome {
    const nextSettings = canonicalClone(baseSettings);
    const preset = resolveTargetPreset(nextSettings, args.presetId);
    const previousPreset = canonicalClone(preset);
    const targetId = args.id.trim();

    if (args.kind === 'prompt_block') {
        const targetAgentId = args.agentId?.trim() || preset.mainAgentId;
        const agent = preset.agents[targetAgentId];
        if (!agent) {
            throw new Error(`Agent "${targetAgentId}" not found in preset "${preset.id}".`);
        }
        const existing = agent.promptBlocks.find((b) => b.id === targetId);
        if (!existing) {
            throw new Error(`PromptBlock "${targetId}" not found on agent "${targetAgentId}".`);
        }
        agent.promptBlocks = agent.promptBlocks.filter((b) => b.id !== targetId);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: `${targetAgentId}/${targetId}`,
            beforeText: existing.content,
            shouldReloadMessages: false,
        };
    }

    if (args.kind === 'prompt_script') {
        const stage = resolvePromptScriptStage(targetId);
        const propKey = stage === 'preprocess' ? 'preprocessScript' : 'postprocessScript';
        const existing = preset[propKey];
        if (!existing) {
            throw new Error(
                `Prompt script "${stage}" is not configured in preset "${preset.id}".`,
            );
        }
        delete preset[propKey];
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: stage,
            beforeText: existing.code,
            shouldReloadMessages: false,
        };
    }

    if (args.kind === 'agent') {
        if (targetId === preset.mainAgentId) {
            throw new Error(`Cannot delete mainAgentId "${preset.mainAgentId}".`);
        }
        const existing = preset.agents[targetId];
        if (!existing) {
            throw new Error(`Agent "${targetId}" not found in preset "${preset.id}".`);
        }
        delete preset.agents[targetId];
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: targetId,
            beforeText: JSON.stringify(existing, null, 2),
            shouldReloadMessages: false,
        };
    }

    if (args.kind === 'trigger') {
        const existing = preset.triggers.find((t) => t.id === targetId);
        if (!existing) {
            throw new Error(`Trigger "${targetId}" not found in preset "${preset.id}".`);
        }
        preset.triggers = preset.triggers.filter((t) => t.id !== targetId);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: existing.id,
            beforeText:
                existing.kind === 'script'
                    ? (existing.scriptCode ?? '')
                    : JSON.stringify(existing, null, 2),
            shouldReloadMessages: false,
        };
    }

    if (args.kind === 'custom_tool') {
        const existing = preset.customTools.find(
            (t) => t.id === targetId || t.name === targetId,
        );
        if (!existing) {
            throw new Error(`CustomTool "${targetId}" not found in preset "${preset.id}".`);
        }
        preset.customTools = preset.customTools.filter((t) => t.id !== existing.id);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: existing.name,
            beforeText:
                existing.kind === 'js'
                    ? (existing.code ?? '')
                    : JSON.stringify(existing, null, 2),
            shouldReloadMessages: false,
        };
    }

    if (args.kind === 'regex_rule') {
        const existing = preset.regexRules.find((r) => r.id === targetId);
        if (!existing) {
            throw new Error(`RegexRule "${targetId}" not found in preset "${preset.id}".`);
        }
        preset.regexRules = preset.regexRules.filter((r) => r.id !== targetId);
        return {
            nextSettings: normalizeSettings(nextSettings),
            presetId: preset.id,
            previousPreset,
            itemLabel: existing.name,
            beforeText: JSON.stringify(existing, null, 2),
            shouldReloadMessages: existing.stage === 'display' && args.reloadMessages !== false,
        };
    }

    // preset_file
    const relName = targetId.replace(/^\/preset\//, '').replace(/^\/+/, '');
    if (!Object.hasOwn(preset.files, relName)) {
        throw new Error(`Preset file "/preset/${relName}" not found in preset "${preset.id}".`);
    }
    const previousContent = preset.files[relName]!;
    delete preset.files[relName];
    return {
        nextSettings: normalizeSettings(nextSettings),
        presetId: preset.id,
        previousPreset,
        itemLabel: `/preset/${relName}`,
        beforeText: previousContent,
        shouldReloadMessages: false,
    };
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the 5 `full`-tier ST-Agentic self-management tools (`FULL_AGENTIC_CONFIG_TOOLS`).
 * All outputs pass through secret redaction; undo records never persist API keys.
 */
export function createFullAgenticConfigTools(): AssistantToolDefinition[] {
    const agenticConfigReadTool: AssistantToolDefinition<typeof AGENTIC_CONFIG_READ_SCHEMA> = {
        name: 'agentic_config_read',
        description:
            'Inspect ST-Agentic own configuration: summary, global settings, presets, prompt blocks, prompt_scripts (preset preprocessScript / postprocessScript), agents, triggers/@@scripts, custom tools, regex rules, WI router overrides, or API connections (secrets are automatically redacted to ***REDACTED***). Read-only.',
        parameters: AGENTIC_CONFIG_READ_SCHEMA,
        tier: 'full',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const settings = getLatestSettingsSnapshot(ctx);
            const section = args.section ?? 'summary';

            if (section === 'settings') {
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    settings: {
                        version: settings.version,
                        runMode: settings.runMode,
                        themeMode: settings.themeMode,
                        capsulePosition: settings.capsulePosition,
                        capsulePersistMode: settings.capsulePersistMode,
                        currentPresetId: settings.currentPresetId,
                        currentConnectionId: settings.currentConnectionId,
                        storage: settings.storage,
                        ...(settings.offMainline ? { offMainline: settings.offMainline } : {}),
                    },
                });
            }

            if (section === 'connections') {
                const list = Object.values(settings.connections);
                const filtered = args.itemId
                    ? list.filter((c) => c.id === args.itemId || c.name === args.itemId)
                    : list;
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    currentConnectionId: settings.currentConnectionId,
                    total: filtered.length,
                    connections: filtered,
                });
            }

            if (section === 'presets') {
                const summaries = Object.values(settings.presets).map((p) =>
                    summarizePresetForCatalog(p, settings.currentPresetId),
                );
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    currentPresetId: settings.currentPresetId,
                    total: summaries.length,
                    presets: summaries,
                });
            }

            const preset = resolveTargetPreset(settings, args.presetId);

            if (section === 'summary') {
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    global: {
                        runMode: settings.runMode,
                        themeMode: settings.themeMode,
                        capsulePosition: settings.capsulePosition,
                        capsulePersistMode: settings.capsulePersistMode,
                        currentPresetId: settings.currentPresetId,
                        currentConnectionId: settings.currentConnectionId,
                    },
                    presets: Object.values(settings.presets).map((p) =>
                        summarizePresetForCatalog(p, settings.currentPresetId),
                    ),
                    connections: Object.values(settings.connections).map((c) => ({
                        id: c.id,
                        name: c.name,
                        providerFormat: c.providerFormat,
                        baseUrl: c.baseUrl,
                        model: c.model,
                        active: c.id === settings.currentConnectionId,
                    })),
                });
            }

            if (section === 'preset') {
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    preset,
                    preprocessScript: preset.preprocessScript ?? null,
                    postprocessScript: preset.postprocessScript ?? null,
                });
            }

            if (section === 'prompt_scripts') {
                const preprocessScript = preset.preprocessScript ?? null;
                const postprocessScript = preset.postprocessScript ?? null;
                const requestedItem = args.itemId?.trim();
                if (requestedItem) {
                    const stage = parsePromptScriptStageToken(requestedItem);
                    if (!stage) {
                        return finalizeToolError(
                            `Invalid prompt_scripts itemId "${requestedItem}": expected "preprocess" or "postprocess".`,
                            ctx.signal,
                        );
                    }
                    return finalizeReadToolResult({
                        ok: true,
                        section,
                        presetId: preset.id,
                        stage,
                        script: stage === 'preprocess' ? preprocessScript : postprocessScript,
                        preprocessScript,
                        postprocessScript,
                    });
                }
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    preprocessScript,
                    postprocessScript,
                });
            }

            if (section === 'prompts') {
                const targetAgentId = args.agentId?.trim() || preset.mainAgentId;
                const agent = preset.agents[targetAgentId];
                if (!agent) {
                    return finalizeToolError(
                        `Agent "${targetAgentId}" not found in preset "${preset.id}".`,
                        ctx.signal,
                    );
                }
                const blocks = args.itemId
                    ? agent.promptBlocks.filter((b) => b.id === args.itemId || b.name === args.itemId)
                    : agent.promptBlocks;
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    agentId: targetAgentId,
                    total: blocks.length,
                    promptBlocks: blocks,
                    preprocessScript: preset.preprocessScript ?? null,
                    postprocessScript: preset.postprocessScript ?? null,
                });
            }

            if (section === 'agents') {
                const targetId = args.agentId?.trim() || args.itemId?.trim();
                if (targetId) {
                    const found = preset.agents[targetId];
                    if (!found) {
                        return finalizeToolError(
                            `Agent "${targetId}" not found in preset "${preset.id}".`,
                            ctx.signal,
                        );
                    }
                    return finalizeReadToolResult({
                        ok: true,
                        section,
                        presetId: preset.id,
                        agent: found,
                    });
                }
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    mainAgentId: preset.mainAgentId,
                    agents: preset.agents,
                });
            }

            if (section === 'triggers') {
                const triggers = args.itemId
                    ? preset.triggers.filter((t) => t.id === args.itemId || t.label === args.itemId)
                    : preset.triggers;
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    total: triggers.length,
                    triggers,
                });
            }

            if (section === 'tools') {
                const customTools = args.itemId
                    ? preset.customTools.filter((t) => t.id === args.itemId || t.name === args.itemId)
                    : preset.customTools;
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    totalCustomTools: customTools.length,
                    customTools,
                    builtinToolSettings: preset.builtinToolSettings ?? {},
                });
            }

            if (section === 'regex') {
                const regexRules = args.itemId
                    ? preset.regexRules.filter((r) => r.id === args.itemId || r.name === args.itemId)
                    : preset.regexRules;
                return finalizeReadToolResult({
                    ok: true,
                    section,
                    presetId: preset.id,
                    total: regexRules.length,
                    regexRules,
                });
            }

            // wi_router
            return finalizeReadToolResult({
                ok: true,
                section,
                presetId: preset.id,
                wiRouterOverrides: preset.wiRouterOverrides,
            });
        },
    };

    const agenticSettingsPatchTool: AssistantToolDefinition<typeof AGENTIC_SETTINGS_PATCH_SCHEMA> = {
        name: 'agentic_settings_patch',
        description:
            'Update ST-Agentic global settings (runMode, themeMode, active preset/connection, storage, offMainline), create/rename/delete ST-Agentic presets, or update wiRouterOverrides / builtinToolSettings / preprocessScript / postprocessScript. Syncs live immediately.',
        parameters: AGENTIC_SETTINGS_PATCH_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            const before = getLatestSettingsSnapshot(ctx);
            const { nextSettings, summaryParts } = applyAgenticSettingsPatch(before, args);
            const stripConn = (s: Settings) => {
                const copy = canonicalClone(s) as unknown as Record<string, unknown>;
                delete copy.connections;
                return copy;
            };
            const beforeText = JSON.stringify(redactWithReport(stripConn(before)).value, null, 2);
            const afterText = JSON.stringify(redactWithReport(stripConn(nextSettings)).value, null, 2);
            return {
                title: args.deletePresetId
                    ? `Delete ST-Agentic preset "${args.deletePresetId}"`
                    : 'Update ST-Agentic settings',
                summary:
                    summaryParts.length > 0
                        ? `Apply ST-Agentic settings changes: ${summaryParts.join(', ')}.`
                        : 'Apply ST-Agentic settings patch.',
                targetLabel: 'ST-Agentic Settings',
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const updater = requireSettingsUpdater(ctx);
            const before = getLatestSettingsSnapshot(ctx);
            const { nextSettings, affectedPresetIds, summaryParts } = applyAgenticSettingsPatch(
                before,
                args,
            );

            const saved = await updater(() => nextSettings);

            const previousPresets: Record<string, Preset | null> = {};
            for (const presetId of affectedPresetIds) {
                previousPresets[presetId] = before.presets[presetId]
                    ? canonicalClone(before.presets[presetId])
                    : null;
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'agentic_settings_patch',
                        kind: 'st_setting',
                        label: `Agentic settings (${summaryParts.join(', ') || 'patch'})`,
                        scope: 'agentic:settings',
                        beforeSummary: `preset=${before.currentPresetId}, mode=${before.runMode}`,
                        afterSummary: `preset=${saved.currentPresetId}, mode=${saved.runMode}`,
                        snapshot: {
                            action: 'agentic_settings_patch',
                            previousGlobals: {
                                runMode: before.runMode,
                                themeMode: before.themeMode,
                                capsulePosition: before.capsulePosition,
                                capsulePersistMode: before.capsulePersistMode,
                                currentPresetId: before.currentPresetId,
                                currentConnectionId: before.currentConnectionId,
                                storage: canonicalClone(before.storage),
                                ...(before.offMainline
                                    ? { offMainline: canonicalClone(before.offMainline) }
                                    : {}),
                            },
                            previousPresets,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    syncedLive: true,
                    runMode: saved.runMode,
                    currentPresetId: saved.currentPresetId,
                    currentConnectionId: saved.currentConnectionId,
                    changes: summaryParts,
                },
                { undoId },
            );
        },
    };

    const agenticPresetComponentUpsertTool: AssistantToolDefinition<
        typeof AGENTIC_PRESET_COMPONENT_UPSERT_SCHEMA
    > = {
        name: 'agentic_preset_component_upsert',
        description:
            'Create or update an ST-Agentic preset component (prompt_block, prompt_script [preprocess/postprocess], agent, trigger / @@script with optional events, custom_tool JS defineTool or slash_bridge, regex_rule for display/ingest/lore_read, or preset_file). Syncs live to UI, tool registry, and regex pipeline immediately.',
        parameters: AGENTIC_PRESET_COMPONENT_UPSERT_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            const before = getLatestSettingsSnapshot(ctx);
            const outcome = applyPresetComponentUpsert(before, args);
            return {
                title: `Upsert ST-Agentic ${args.kind}: ${outcome.itemLabel}`,
                summary: `Update ${args.kind} "${outcome.itemLabel}" in preset "${outcome.presetId}".`,
                targetLabel: `Agentic Preset (${outcome.presetId}): ${args.kind}/${outcome.itemLabel}`,
                beforeText: outcome.beforeText,
                afterText: outcome.afterText,
                rawContent: outcome.afterText,
                diffLines: computeDiffLines(outcome.beforeText, outcome.afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const updater = requireSettingsUpdater(ctx);
            const before = getLatestSettingsSnapshot(ctx);
            const outcome = applyPresetComponentUpsert(before, args);

            await updater(() => outcome.nextSettings);

            let reloadedMessageIds: number[] | undefined;
            if (outcome.shouldReloadMessages && ctx.bridge.reloadDisplayedMessages) {
                const reloadRes = await ctx.bridge.reloadDisplayedMessages({
                    emitUpdateEvent: true,
                });
                reloadedMessageIds = reloadRes.reloadedIds;
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'agentic_preset_component_upsert',
                        kind: 'st_setting',
                        label: `Upsert ${args.kind} "${outcome.itemLabel}"`,
                        scope: `agentic:${outcome.presetId}:${args.kind}:${outcome.itemLabel}`,
                        beforeSummary: outcome.beforeText
                            ? truncateSummary(outcome.beforeText)
                            : '(new component)',
                        afterSummary: truncateSummary(outcome.afterText),
                        snapshot: {
                            action: 'agentic_preset_snapshot',
                            presetId: outcome.presetId,
                            previousPreset: outcome.previousPreset,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    syncedLive: true,
                    presetId: outcome.presetId,
                    kind: args.kind,
                    component: outcome.savedComponent,
                    ...(reloadedMessageIds ? { reloadedMessageIds } : {}),
                },
                { undoId },
            );
        },
    };

    const agenticPresetComponentDeleteTool: AssistantToolDefinition<
        typeof AGENTIC_PRESET_COMPONENT_DELETE_SCHEMA
    > = {
        name: 'agentic_preset_component_delete',
        description:
            'Permanently delete a component (prompt_block, prompt_script [preprocess/postprocess], agent, trigger, custom_tool, regex_rule, or preset_file) from an ST-Agentic preset. High-risk mandatoryConfirm operation.',
        parameters: AGENTIC_PRESET_COMPONENT_DELETE_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            const before = getLatestSettingsSnapshot(ctx);
            const outcome = applyPresetComponentDelete(before, args);
            return {
                title: `Delete ST-Agentic ${args.kind}: ${outcome.itemLabel}`,
                summary: `Delete ${args.kind} "${outcome.itemLabel}" from preset "${outcome.presetId}".`,
                targetLabel: `Agentic Preset (${outcome.presetId}): ${args.kind}/${outcome.itemLabel}`,
                beforeText: outcome.beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(outcome.beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const updater = requireSettingsUpdater(ctx);
            const before = getLatestSettingsSnapshot(ctx);
            const outcome = applyPresetComponentDelete(before, args);

            await updater(() => outcome.nextSettings);

            let reloadedMessageIds: number[] | undefined;
            if (outcome.shouldReloadMessages && ctx.bridge.reloadDisplayedMessages) {
                const reloadRes = await ctx.bridge.reloadDisplayedMessages({
                    emitUpdateEvent: true,
                });
                reloadedMessageIds = reloadRes.reloadedIds;
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'agentic_preset_component_delete',
                        kind: 'st_setting',
                        label: `Delete ${args.kind} "${outcome.itemLabel}"`,
                        scope: `agentic:${outcome.presetId}:${args.kind}:${outcome.itemLabel}`,
                        beforeSummary: truncateSummary(outcome.beforeText),
                        afterSummary: '(deleted)',
                        snapshot: {
                            action: 'agentic_preset_snapshot',
                            presetId: outcome.presetId,
                            previousPreset: outcome.previousPreset,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    syncedLive: true,
                    presetId: outcome.presetId,
                    kind: args.kind,
                    deletedId: args.id,
                    ...(reloadedMessageIds ? { reloadedMessageIds } : {}),
                },
                { undoId },
            );
        },
    };

    const agenticConnectionUpsertTool: AssistantToolDefinition<
        typeof AGENTIC_CONNECTION_UPSERT_SCHEMA
    > = {
        name: 'agentic_connection_upsert',
        description:
            'Create or update an ST-Agentic API connection (baseUrl, model, providerFormat, sampling params, cachePolicy, headers). Preserves existing apiKey when omitted or "***REDACTED***". High-risk mandatoryConfirm operation.',
        parameters: AGENTIC_CONNECTION_UPSERT_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            const before = getLatestSettingsSnapshot(ctx);
            const existing = before.connections[args.id.trim()];
            const { clearApiKey, setAsCurrent, ...rawConnPatch } = args;
            void setAsCurrent;
            const safeIncoming = preserveRedactedConnectionSecrets(rawConnPatch, existing, {
                clearApiKey,
            });
            const merged = normalizeConnection(
                {
                    ...(existing ? canonicalClone(existing) : createDefaultConnection({ id: args.id.trim() })),
                    ...safeIncoming,
                    id: args.id.trim(),
                },
                args.id.trim(),
            );
            const beforeText = existing
                ? JSON.stringify(redactWithReport(existing).value, null, 2)
                : '';
            const afterText = JSON.stringify(redactWithReport(merged).value, null, 2);
            return {
                title: `${existing ? 'Update' : 'Create'} ST-Agentic connection "${args.id.trim()}"`,
                summary: `${existing ? 'Modify' : 'Add'} API connection "${merged.name}" (${merged.providerFormat} · ${merged.baseUrl}).`,
                targetLabel: `Agentic Connection: ${args.id.trim()}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const updater = requireSettingsUpdater(ctx);
            const before = getLatestSettingsSnapshot(ctx);
            const connId = args.id.trim();
            const existing = before.connections[connId];
            const { clearApiKey, setAsCurrent, ...rawConnPatch } = args;
            const safeIncoming = preserveRedactedConnectionSecrets(rawConnPatch, existing, {
                clearApiKey,
            });

            const normalized = normalizeConnection(
                {
                    ...(existing ? canonicalClone(existing) : createDefaultConnection({ id: connId })),
                    ...safeIncoming,
                    id: connId,
                },
                connId,
            );

            const nextSettings = normalizeSettings({
                ...before,
                connections: {
                    ...before.connections,
                    [connId]: normalized,
                },
                ...(setAsCurrent ? { currentConnectionId: connId } : {}),
            });

            await updater(() => nextSettings);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'agentic_connection_upsert',
                        kind: 'st_setting',
                        label: `${existing ? 'Update' : 'Create'} connection "${connId}"`,
                        scope: `agentic:connection:${connId}`,
                        beforeSummary: existing
                            ? `${existing.providerFormat}:${existing.model} @ ${existing.baseUrl}`
                            : '(new connection)',
                        afterSummary: `${normalized.providerFormat}:${normalized.model} @ ${normalized.baseUrl}`,
                        snapshot: {
                            action: 'agentic_connection_upsert',
                            connectionId: connId,
                            existed: Boolean(existing),
                            previousConnection: existing
                                ? stripConnectionSecretsForUndo(existing)
                                : null,
                            previousCurrentConnectionId: before.currentConnectionId,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    syncedLive: true,
                    connection: normalized,
                    currentConnectionId: nextSettings.currentConnectionId,
                },
                { undoId },
            );
        },
    };

    return [
        agenticConfigReadTool,
        agenticSettingsPatchTool,
        agenticPresetComponentUpsertTool,
        agenticPresetComponentDeleteTool,
        agenticConnectionUpsertTool,
    ];
}
