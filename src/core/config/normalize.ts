import type {
    AgentProfile,
    ApiConnection,
    ApiProviderFormat,
    BarrierPolicy,
    BuiltinToolConfig,
    CachePolicy,
    CapsulePersistMode,
    CapsulePosition,
    CustomToolConfig,
    PipelinePhase,
    Preset,
    PromptBlock,
    RegexRule,
    RegexStage,
    RunMode,
    ScopedPermissions,
    Settings,
    SlashToolParamDef,
    SlashToolParamType,
    StorageSettings,
    StrictToolLoopOverride,
    ThemeMode,
    TriggerCondition,
    TriggerRule,
    WICategory,
} from '../types';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultStorageSettings,
    DEFAULT_CONNECTION_ID,
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    DEFAULT_MAIN_AGENT_ID,
    DEFAULT_PRESET_ID,
    SETTINGS_VERSION,
} from './defaults';
import { normalizePromptTriggers } from './prompt-triggers';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function cloneJsonValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeRecord(value: unknown): Record<string, unknown> {
    if (!isPlainRecord(value)) {
        return {};
    }
    return cloneJsonValue(value);
}

export function sanitizeName(value: unknown, fallback: string): string {
    if (typeof value !== 'string') {
        return fallback;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : fallback;
}

export function parseBoundedNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    integer = false,
): number {
    if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
        return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    return integer ? Math.trunc(clamped) : clamped;
}

function normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') {
            continue;
        }
        const trimmed = item.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return result;
}

/** Validate a preset file relative path safe for mounting under `/preset/<name>`. */
export function validatePresetFileName(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) {
        return 'File name is required';
    }
    if (trimmed.includes('\0') || /[%#?\\]/.test(trimmed)) {
        return 'File name cannot contain \\ % # ? or null bytes';
    }
    if (trimmed.startsWith('/') || trimmed.endsWith('/')) {
        return 'File path cannot start or end with "/"';
    }
    const segments = trimmed.split('/');
    for (const seg of segments) {
        if (!seg) {
            return 'File path cannot contain empty "/" segments';
        }
        if (seg === '.' || seg === '..') {
            return 'File path cannot contain "." or ".." traversal segments';
        }
        if (seg.startsWith('.')) {
            return 'File or folder name cannot start with "."';
        }
    }
    if (trimmed.length > 120) {
        return 'File name exceeds 120 characters';
    }
    return null;
}

/**
 * Normalize a preset/embedded `name -> content` file map, dropping invalid keys.
 * Optionally enforces a total byte/char size limit when `throwOnLimit` is true.
 */
export function normalizeFileMap(
    raw: unknown,
    options: { maxBytes?: number; throwOnLimit?: boolean } = {},
): Record<string, string> {
    const result: Record<string, string> = {};
    if (!isPlainRecord(raw)) {
        return result;
    }

    const maxBytes = options.maxBytes ?? DEFAULT_FILE_MAP_SIZE_LIMIT;
    let total = 0;

    for (const [key, value] of Object.entries(raw)) {
        if (typeof value !== 'string') {
            continue;
        }
        const name = key.trim();
        if (validatePresetFileName(name) !== null) {
            continue;
        }

        const nextTotal = total + name.length + value.length;
        if (nextTotal > maxBytes) {
            if (options.throwOnLimit) {
                throw new Error(`Files exceed the ${Math.floor(maxBytes / 1024)} KB limit.`);
            }
            continue;
        }

        total = nextTotal;
        result[name] = value;
    }

    return result;
}

const VALID_PROVIDER_FORMATS = new Set<ApiProviderFormat>(['openai', 'anthropic', 'gemini']);
const VALID_CACHE_POLICIES = new Set<CachePolicy>(['auto_prefix', 'anthropic_explicit', 'none']);
const VALID_POST_PROCESSING = new Set<NonNullable<ApiConnection['promptPostProcessing']>>([
    'none',
    'merge',
    'semi',
    'strict',
    'single',
]);

/** Normalize an untrusted API connection object into a complete `ApiConnection`. */
export function normalizeConnection(
    input: unknown,
    fallbackId: string = DEFAULT_CONNECTION_ID,
): ApiConnection {
    const defaults = createDefaultConnection();
    const raw = isPlainRecord(input) ? input : {};

    const id = sanitizeName(raw.id, fallbackId);
    const name = sanitizeName(raw.name, id);
    const providerFormat: ApiProviderFormat = VALID_PROVIDER_FORMATS.has(
        raw.providerFormat as ApiProviderFormat,
    )
        ? (raw.providerFormat as ApiProviderFormat)
        : 'openai';

    const defaultCachePolicy: CachePolicy =
        providerFormat === 'anthropic' ? 'anthropic_explicit' : 'auto_prefix';
    const cachePolicy: CachePolicy = VALID_CACHE_POLICIES.has(raw.cachePolicy as CachePolicy)
        ? (raw.cachePolicy as CachePolicy)
        : defaultCachePolicy;

    const promptPostProcessing = VALID_POST_PROCESSING.has(
        raw.promptPostProcessing as NonNullable<ApiConnection['promptPostProcessing']>,
    )
        ? (raw.promptPostProcessing as NonNullable<ApiConnection['promptPostProcessing']>)
        : 'none';

    return {
        id,
        name,
        providerFormat,
        baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() || defaults.baseUrl : defaults.baseUrl,
        apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
        model: typeof raw.model === 'string' ? raw.model.trim() : defaults.model,
        contextSize: parseBoundedNumber(raw.contextSize, defaults.contextSize, 1, 10_000_000, true),
        maxTokens: parseBoundedNumber(raw.maxTokens, defaults.maxTokens, 1, 1_000_000, true),
        temperature: parseBoundedNumber(raw.temperature, defaults.temperature, 0, 2, false),
        topK: parseBoundedNumber(raw.topK, defaults.topK, 0, 1_000_000, true),
        topP: parseBoundedNumber(raw.topP, defaults.topP, 0, 1, false),
        frequencyPenalty: parseBoundedNumber(
            raw.frequencyPenalty,
            defaults.frequencyPenalty,
            -2,
            2,
            false,
        ),
        presencePenalty: parseBoundedNumber(
            raw.presencePenalty,
            defaults.presencePenalty,
            -2,
            2,
            false,
        ),
        stream: raw.stream === undefined ? defaults.stream : Boolean(raw.stream),
        includeHeaders: normalizeRecord(raw.includeHeaders),
        includeBody: normalizeRecord(raw.includeBody),
        excludeBody: normalizeRecord(raw.excludeBody),
        maxConcurrency: parseBoundedNumber(raw.maxConcurrency, defaults.maxConcurrency, 1, 100, true),
        cachePolicy,
        maxCacheBreakpoints: parseBoundedNumber(
            raw.maxCacheBreakpoints,
            defaults.maxCacheBreakpoints ?? 4,
            0,
            4,
            true,
        ),
        promptPostProcessing,
        linkedPreset: typeof raw.linkedPreset === 'string' ? raw.linkedPreset.trim() : '',
        strictToolLoop:
            raw.strictToolLoop === undefined
                ? Boolean(defaults.strictToolLoop)
                : Boolean(raw.strictToolLoop),
        roundMaxRetries: parseBoundedNumber(
            raw.roundMaxRetries,
            defaults.roundMaxRetries ?? 2,
            0,
            10,
            true,
        ),
    };
}

/** Normalize a map or array of API connections keyed by connection `id`. */
export function normalizeConnectionsMap(raw: unknown): Record<string, ApiConnection> {
    const result: Record<string, ApiConnection> = {};

    if (Array.isArray(raw)) {
        raw.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                return;
            }
            const conn = normalizeConnection(entry, `connection_${index + 1}`);
            result[conn.id] = conn;
        });
        return result;
    }

    if (!isPlainRecord(raw)) {
        return result;
    }

    for (const [key, value] of Object.entries(raw)) {
        if (!isPlainRecord(value)) {
            continue;
        }
        const fallbackId = sanitizeName(key, DEFAULT_CONNECTION_ID);
        const conn = normalizeConnection(value, fallbackId);
        result[conn.id] = conn;
    }

    return result;
}

const VALID_BLOCK_ROLES = new Set<PromptBlock['role']>(['system', 'user', 'assistant', 'custom']);
const VALID_BLOCK_PLACEMENTS = new Set<PromptBlock['placement']>(['prefix', 'tail', 'floating_tail']);
const VALID_STRICT_TOOL_LOOP_OVERRIDES = new Set<StrictToolLoopOverride>(['inherit', 'on', 'off']);

/** Normalize a `PromptBlock` entry. */
export function normalizePromptBlock(
    input: unknown,
    fallbackId = 'block_1',
    fallbackName = 'Prompt Block',
): PromptBlock {
    const raw = isPlainRecord(input) ? input : {};
    const role: PromptBlock['role'] = VALID_BLOCK_ROLES.has(raw.role as PromptBlock['role'])
        ? (raw.role as PromptBlock['role'])
        : 'system';
    const placement: PromptBlock['placement'] = VALID_BLOCK_PLACEMENTS.has(
        raw.placement as PromptBlock['placement'],
    )
        ? (raw.placement as PromptBlock['placement'])
        : 'prefix';

    const triggers = normalizePromptTriggers(raw.triggers ?? raw.injection_trigger);

    return {
        id: sanitizeName(raw.id, fallbackId),
        name: sanitizeName(raw.name, fallbackName),
        role,
        placement,
        content: typeof raw.content === 'string' ? raw.content : String(raw.content ?? ''),
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
        ...(triggers ? { triggers } : {}),
    };
}

function normalizePermissions(raw: unknown): ScopedPermissions {
    if (!isPlainRecord(raw)) {
        return { read: ['/**'], write: [] };
    }
    return {
        read: normalizeStringArray(raw.read),
        write: normalizeStringArray(raw.write),
    };
}

/** Normalize an `AgentProfile` entry. */
export function normalizeAgentProfile(
    input: unknown,
    fallbackId: string = DEFAULT_MAIN_AGENT_ID,
): AgentProfile {
    const raw = isPlainRecord(input) ? input : {};
    const id = sanitizeName(raw.id, fallbackId);
    const name = sanitizeName(raw.name, id);
    const sessionMode = raw.sessionMode === 'ephemeral' ? 'ephemeral' : 'persistent';

    const promptBlocks: PromptBlock[] = Array.isArray(raw.promptBlocks)
        ? raw.promptBlocks.map((block, index) =>
            normalizePromptBlock(block, `block_${index + 1}`, `Block ${index + 1}`),
        )
        : [];

    const profile: AgentProfile = {
        id,
        name,
        connectionId: sanitizeName(raw.connectionId, 'inherit'),
        sessionMode,
        promptBlocks,
        enabledTools: normalizeStringArray(raw.enabledTools),
        permissions: normalizePermissions(raw.permissions),
        maxToolRounds: parseBoundedNumber(raw.maxToolRounds, 0, 0, 1000, true),
        strictToolLoop: VALID_STRICT_TOOL_LOOP_OVERRIDES.has(
            raw.strictToolLoop as StrictToolLoopOverride,
        )
            ? (raw.strictToolLoop as StrictToolLoopOverride)
            : 'inherit',
    };

    if (isPlainRecord(raw.watermark)) {
        const high = parseBoundedNumber(raw.watermark.high, 36000, 1000, 2_000_000, true);
        const low = Math.min(
            high,
            parseBoundedNumber(raw.watermark.low, Math.floor(high / 2), 500, high, true),
        );
        profile.watermark = { high, low };
    }

    if (raw.ephemeralWindowSize !== undefined) {
        profile.ephemeralWindowSize = parseBoundedNumber(raw.ephemeralWindowSize, 6, 1, 500, true);
    }

    if (typeof raw.description === 'string' && raw.description.trim()) {
        profile.description = raw.description.trim();
    }

    return profile;
}

const VALID_CONDITION_TYPES = new Set<TriggerCondition['type']>([
    'always',
    'interval',
    'regex',
    'keyword',
    'js_predicate',
]);

/** Normalize a `TriggerCondition`. */
export function normalizeTriggerCondition(input: unknown): TriggerCondition {
    const raw = isPlainRecord(input) ? input : {};
    const type: TriggerCondition['type'] = VALID_CONDITION_TYPES.has(
        raw.type as TriggerCondition['type'],
    )
        ? (raw.type as TriggerCondition['type'])
        : 'always';

    const condition: TriggerCondition = { type };
    if (type === 'interval') {
        condition.interval = parseBoundedNumber(raw.interval, 1, 1, 10_000, true);
    } else if (type === 'regex' && typeof raw.pattern === 'string') {
        condition.pattern = raw.pattern;
    } else if (type === 'keyword') {
        condition.keys = normalizeStringArray(raw.keys);
    } else if (type === 'js_predicate' && typeof raw.predicateCode === 'string') {
        condition.predicateCode = raw.predicateCode;
    }
    return condition;
}

const VALID_PHASES = new Set<PipelinePhase>([
    'before_turn',
    'main_turn',
    'after_turn',
    'maintenance',
]);
const VALID_BARRIERS = new Set<BarrierPolicy>(['turn', 'self', 'none']);

/** Normalize a `TriggerRule`. */
export function normalizeTriggerRule(input: unknown, fallbackId = 'trigger_1'): TriggerRule {
    const raw = isPlainRecord(input) ? input : {};
    const id = sanitizeName(raw.id, fallbackId);
    const phase: PipelinePhase = VALID_PHASES.has(raw.phase as PipelinePhase)
        ? (raw.phase as PipelinePhase)
        : 'after_turn';
    const barrier: BarrierPolicy = VALID_BARRIERS.has(raw.barrier as BarrierPolicy)
        ? (raw.barrier as BarrierPolicy)
        : 'turn';

    const rule: TriggerRule = {
        id,
        label: sanitizeName(raw.label, id),
        source: raw.source === 'worldinfo' ? 'worldinfo' : 'preset',
        phase,
        order: parseBoundedNumber(raw.order, 1, -1_000_000, 1_000_000, true),
        barrier,
        agentProfileId: sanitizeName(raw.agentProfileId, DEFAULT_MAIN_AGENT_ID),
        kind: raw.kind === 'script' ? 'script' : 'agent',
        condition: normalizeTriggerCondition(raw.condition),
        instructionTemplate:
            typeof raw.instructionTemplate === 'string'
                ? raw.instructionTemplate
                : String(raw.instructionTemplate ?? ''),
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    };

    if (typeof raw.sourceWorld === 'string' && raw.sourceWorld.trim()) {
        rule.sourceWorld = raw.sourceWorld.trim();
    }
    if (typeof raw.sourceEntryUid === 'number' && Number.isFinite(raw.sourceEntryUid)) {
        rule.sourceEntryUid = Math.trunc(raw.sourceEntryUid);
    }
    if (typeof raw.tag === 'string') {
        rule.tag = raw.tag;
    }
    if (typeof raw.groupName === 'string' && raw.groupName.trim()) {
        rule.groupName = raw.groupName.trim();
    }
    if (typeof raw.targetPath === 'string' && raw.targetPath.trim()) {
        rule.targetPath = raw.targetPath.trim();
    }
    if (isPlainRecord(raw.schemaSource) && typeof raw.schemaSource.raw === 'string') {
        rule.schemaSource = {
            kind: raw.schemaSource.kind === 'zod' ? 'zod' : 'json',
            raw: raw.schemaSource.raw,
        };
    }
    if (typeof raw.decorator === 'string' && raw.decorator.trim()) {
        rule.decorator = raw.decorator.trim();
    }
    if (Array.isArray(raw.ifConditions)) {
        const ifConditions = normalizeStringArray(raw.ifConditions);
        if (ifConditions.length > 0) {
            rule.ifConditions = ifConditions;
        }
    }
    if (typeof raw.scriptCode === 'string') {
        rule.scriptCode = raw.scriptCode;
    }
    if (typeof raw.findRegex === 'string' && raw.findRegex.length > 0) {
        rule.findRegex = raw.findRegex;
    }

    return rule;
}

const VALID_REGEX_STAGES = new Set<RegexStage>(['display', 'ingest', 'lore_read']);

/** Normalize a `RegexRule`. */
export function normalizeRegexRule(
    input: unknown,
    fallbackId = 'regex_1',
    fallbackName = 'Regex Rule',
): RegexRule {
    const raw = isPlainRecord(input) ? input : {};
    const stage: RegexStage = VALID_REGEX_STAGES.has(raw.stage as RegexStage)
        ? (raw.stage as RegexStage)
        : 'display';

    return {
        id: sanitizeName(raw.id, fallbackId),
        name: sanitizeName(raw.name, fallbackName),
        pattern: typeof raw.pattern === 'string' ? raw.pattern : String(raw.pattern ?? ''),
        replace: typeof raw.replace === 'string' ? raw.replace : String(raw.replace ?? ''),
        stage,
        applyToUser: Boolean(raw.applyToUser),
        applyToAssistant: Boolean(raw.applyToAssistant),
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    };
}

const VALID_SLASH_PARAM_TYPES = new Set<SlashToolParamType>([
    'string',
    'number',
    'boolean',
    'enum',
]);

function normalizeSlashParamDef(input: unknown, index: number): SlashToolParamDef | null {
    if (!isPlainRecord(input)) {
        return null;
    }
    const name = sanitizeName(input.name, `param_${index + 1}`);
    const type: SlashToolParamType = VALID_SLASH_PARAM_TYPES.has(input.type as SlashToolParamType)
        ? (input.type as SlashToolParamType)
        : 'string';

    const def: SlashToolParamDef = {
        name,
        type,
        description: typeof input.description === 'string' ? input.description : '',
        ...(input.required !== undefined ? { required: Boolean(input.required) } : {}),
    };

    if (
        typeof input.defaultValue === 'string'
        || typeof input.defaultValue === 'number'
        || typeof input.defaultValue === 'boolean'
    ) {
        def.defaultValue = input.defaultValue;
    }

    if (Array.isArray(input.enumValues)) {
        def.enumValues = input.enumValues
            .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
            .map((v) => v.trim());
    }

    return def;
}

/** Normalize a `CustomToolConfig`. */
export function normalizeCustomToolConfig(input: unknown, fallbackId = 'tool_1'): CustomToolConfig {
    const raw = isPlainRecord(input) ? input : {};
    const id = sanitizeName(raw.id, fallbackId);
    const kind = raw.kind === 'slash_bridge' ? 'slash_bridge' : 'js';

    const config: CustomToolConfig = {
        id,
        name: sanitizeName(raw.name, id),
        kind,
        description: typeof raw.description === 'string' ? raw.description : '',
        enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    };

    if (typeof raw.code === 'string') {
        config.code = raw.code;
    }
    if (raw.allowNetwork !== undefined) {
        config.allowNetwork = Boolean(raw.allowNetwork);
    }
    if (typeof raw.commandTemplate === 'string') {
        config.commandTemplate = raw.commandTemplate;
    }
    if (Array.isArray(raw.params)) {
        config.params = raw.params
            .map((p, idx) => normalizeSlashParamDef(p, idx))
            .filter((p): p is SlashToolParamDef => p !== null);
    }
    if (Array.isArray(raw.allowedAgents)) {
        config.allowedAgents = normalizeStringArray(raw.allowedAgents);
    }

    return config;
}

function normalizeBuiltinToolSettings(
    raw: unknown,
): Record<string, BuiltinToolConfig> | undefined {
    if (!isPlainRecord(raw)) {
        return undefined;
    }
    const result: Record<string, BuiltinToolConfig> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!isPlainRecord(value)) {
            continue;
        }
        const entry: BuiltinToolConfig = {
            enabled: Boolean(value.enabled),
        };
        if (typeof value.description === 'string') {
            entry.description = value.description;
        }
        if (isPlainRecord(value.parameters)) {
            entry.parameters = Object.fromEntries(
                Object.entries(value.parameters).map(([pKey, pVal]) => [pKey, String(pVal ?? '')]),
            );
        }
        result[key] = entry;
    }
    return result;
}

const VALID_WI_CATEGORIES = new Set<WICategory>([
    'system_rule',
    'core_manifest',
    'on_demand_archive',
    'dynamic_or_trigger',
]);

function normalizeWIRouterOverrides(raw: unknown): Record<string, WICategory> {
    if (!isPlainRecord(raw)) {
        return {};
    }
    const result: Record<string, WICategory> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (VALID_WI_CATEGORIES.has(value as WICategory)) {
            result[key] = value as WICategory;
        }
    }
    return result;
}

const LEGACY_DEFAULT_MAIN_TOOLS: readonly string[] = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'read_variables',
    'search_history',
    'read_history',
];

const OUTPUT_WRITE_TOOLS: readonly string[] = [
    'write_file',
    'append_file',
    'edit_file',
];

const LEGACY_DEFAULT_MAIN_WRITE_PERMISSIONS_V1: readonly string[] = [
    '/memory/**',
    '/scratch/**',
];

const LEGACY_DEFAULT_MAIN_WRITE_PERMISSIONS_V2: readonly string[] = [
    '/output.md',
    '/memory/**',
    '/scratch/**',
];

function hasExactStringSet(actual: readonly string[], expected: readonly string[]): boolean {
    if (actual.length !== expected.length) {
        return false;
    }
    const actualSet = new Set(actual);
    if (actualSet.size !== expected.length) {
        return false;
    }
    return expected.every((item) => actualSet.has(item));
}

/** Normalize an untrusted preset object into a valid `Preset` with a guaranteed main agent. */
export function normalizePreset(input: unknown, fallbackId: string = DEFAULT_PRESET_ID): Preset {
    const raw = isPlainRecord(input) ? input : {};
    const id = sanitizeName(raw.id, fallbackId);
    const name = sanitizeName(raw.name, id === DEFAULT_PRESET_ID ? 'Default' : id);

    const agents: Record<string, AgentProfile> = {};
    const rawAgentsById: Record<string, Record<string, unknown>> = {};
    if (isPlainRecord(raw.agents)) {
        for (const [agentKey, agentVal] of Object.entries(raw.agents)) {
            if (!isPlainRecord(agentVal)) {
                continue;
            }
            const profile = normalizeAgentProfile(agentVal, sanitizeName(agentKey, DEFAULT_MAIN_AGENT_ID));
            agents[profile.id] = profile;
            rawAgentsById[profile.id] = agentVal;
        }
    }

    let mainAgentId = sanitizeName(raw.mainAgentId, DEFAULT_MAIN_AGENT_ID);
    if (Object.keys(agents).length === 0) {
        const defaultMain = createDefaultMainAgent({ id: mainAgentId });
        agents[mainAgentId] = defaultMain;
    } else if (!agents[mainAgentId]) {
        mainAgentId = Object.keys(agents)[0];
    }

    const triggers: TriggerRule[] = Array.isArray(raw.triggers)
        ? raw.triggers
            .filter(isPlainRecord)
            .map((t, idx) => normalizeTriggerRule(t, `trigger_${idx + 1}`))
        : [];

    const regexRules: RegexRule[] = Array.isArray(raw.regexRules)
        ? raw.regexRules
            .filter(isPlainRecord)
            .map((r, idx) => normalizeRegexRule(r, `regex_${idx + 1}`, `Regex ${idx + 1}`))
        : [];

    const customTools: CustomToolConfig[] = Array.isArray(raw.customTools)
        ? raw.customTools
            .filter(isPlainRecord)
            .map((tool, idx) => normalizeCustomToolConfig(tool, `tool_${idx + 1}`))
        : [];

    const builtinToolSettings = normalizeBuiltinToolSettings(raw.builtinToolSettings);

    const rawMainAgent = rawAgentsById[mainAgentId];
    if (rawMainAgent && agents[mainAgentId]) {
        const mainAgent = agents[mainAgentId];
        const omittedTools = rawMainAgent.enabledTools === undefined;
        if (omittedTools || hasExactStringSet(mainAgent.enabledTools, LEGACY_DEFAULT_MAIN_TOOLS)) {
            const toolSet = new Set(mainAgent.enabledTools);
            for (const tool of OUTPUT_WRITE_TOOLS) {
                if (builtinToolSettings?.[tool]?.enabled === false) {
                    continue;
                }
                toolSet.add(tool);
            }
            mainAgent.enabledTools = Array.from(toolSet);
        }

        const omittedPermissions =
            !isPlainRecord(rawMainAgent.permissions)
            || rawMainAgent.permissions.write === undefined;
        if (
            omittedPermissions
            || hasExactStringSet(mainAgent.permissions.write, LEGACY_DEFAULT_MAIN_WRITE_PERMISSIONS_V1)
            || hasExactStringSet(mainAgent.permissions.write, LEGACY_DEFAULT_MAIN_WRITE_PERMISSIONS_V2)
        ) {
            const nextWrite = [...mainAgent.permissions.write];
            if (!nextWrite.includes('/output.md')) {
                nextWrite.unshift('/output.md');
            }
            if (!nextWrite.includes('/workspace/shared/**')) {
                nextWrite.push('/workspace/shared/**');
            }
            mainAgent.permissions = {
                read: mainAgent.permissions.read,
                write: nextWrite,
            };
        }
    }

    return {
        id,
        name,
        mainAgentId,
        agents,
        triggers,
        regexRules,
        customTools,
        files: normalizeFileMap(raw.files),
        wiRouterOverrides: normalizeWIRouterOverrides(raw.wiRouterOverrides),
        ...(builtinToolSettings ? { builtinToolSettings } : {}),
    };
}

/** Normalize a map or array of presets keyed by preset `id`. */
export function normalizePresetsMap(raw: unknown): Record<string, Preset> {
    const result: Record<string, Preset> = {};

    if (Array.isArray(raw)) {
        raw.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                return;
            }
            const preset = normalizePreset(entry, `preset_${index + 1}`);
            result[preset.id] = preset;
        });
        return result;
    }

    if (!isPlainRecord(raw)) {
        return result;
    }

    for (const [key, value] of Object.entries(raw)) {
        if (!isPlainRecord(value)) {
            continue;
        }
        const fallbackId = sanitizeName(key, DEFAULT_PRESET_ID);
        const preset = normalizePreset(value, fallbackId);
        result[preset.id] = preset;
    }

    return result;
}

/** Normalize `StorageSettings`. */
export function normalizeStorageSettings(input: unknown): StorageSettings {
    const defaults = createDefaultStorageSettings();
    const raw = isPlainRecord(input) ? input : {};

    return {
        autoCompact: raw.autoCompact === undefined ? defaults.autoCompact : Boolean(raw.autoCompact),
        keepDepth: parseBoundedNumber(raw.keepDepth, defaults.keepDepth, 1, 100_000, true),
        sizeThreshold: parseBoundedNumber(
            raw.sizeThreshold,
            defaults.sizeThreshold,
            0,
            Number.MAX_SAFE_INTEGER,
            true,
        ),
        pruneLegacy: raw.pruneLegacy === undefined ? defaults.pruneLegacy : Boolean(raw.pruneLegacy),
        fuzzyIndexFiles:
            raw.fuzzyIndexFiles === undefined ? defaults.fuzzyIndexFiles : Boolean(raw.fuzzyIndexFiles),
    };
}

const VALID_RUN_MODES = new Set<RunMode>(['off', 'companion', 'takeover']);
const VALID_THEME_MODES = new Set<ThemeMode>(['dark', 'light', 'auto']);
const VALID_CAPSULE_POSITIONS = new Set<CapsulePosition>(['top', 'bottom']);
const VALID_CAPSULE_PERSIST_MODES = new Set<CapsulePersistMode>(['keep', 'auto_hide']);

/** Normalize an untrusted root `Settings` object, guaranteeing at least one connection and preset. */
export function normalizeSettings(input: unknown): Settings {
    const raw = isPlainRecord(input) ? input : {};

    const connections = normalizeConnectionsMap(raw.connections);
    if (Object.keys(connections).length === 0) {
        const defConn = createDefaultConnection();
        connections[defConn.id] = defConn;
    }

    const connectionKeys = Object.keys(connections);
    const requestedConnId = sanitizeName(raw.currentConnectionId, '');
    const currentConnectionId =
        requestedConnId && connections[requestedConnId] ? requestedConnId : connectionKeys[0];

    const presets = normalizePresetsMap(raw.presets);
    if (Object.keys(presets).length === 0) {
        const defPreset = createDefaultPreset();
        presets[defPreset.id] = defPreset;
    }

    const presetKeys = Object.keys(presets);
    const requestedPresetId = sanitizeName(raw.currentPresetId, '');
    const currentPresetId =
        requestedPresetId && presets[requestedPresetId] ? requestedPresetId : presetKeys[0];

    const migrations: Record<string, boolean> = {};
    if (isPlainRecord(raw.migrations)) {
        for (const [key, value] of Object.entries(raw.migrations)) {
            if (typeof value === 'boolean') {
                migrations[key] = value;
            }
        }
    }

    return {
        version: parseBoundedNumber(raw.version, SETTINGS_VERSION, 1, 999, true),
        runMode: VALID_RUN_MODES.has(raw.runMode as RunMode)
            ? (raw.runMode as RunMode)
            : 'companion',
        themeMode: VALID_THEME_MODES.has(raw.themeMode as ThemeMode)
            ? (raw.themeMode as ThemeMode)
            : 'dark',
        capsulePosition: VALID_CAPSULE_POSITIONS.has(raw.capsulePosition as CapsulePosition)
            ? (raw.capsulePosition as CapsulePosition)
            : 'bottom',
        capsulePersistMode: VALID_CAPSULE_PERSIST_MODES.has(
            raw.capsulePersistMode as CapsulePersistMode,
        )
            ? (raw.capsulePersistMode as CapsulePersistMode)
            : 'keep',
        connections,
        currentConnectionId,
        presets,
        currentPresetId,
        storage: normalizeStorageSettings(raw.storage),
        migrations,
    };
}

/** Resolve an `ApiConnection` by ID (handling `'inherit'` and fallback to the active connection). */
export function resolveConnection(settings: Settings, connectionId?: string): ApiConnection {
    const requested = connectionId?.trim();
    if (requested && requested !== 'inherit' && settings.connections[requested]) {
        return settings.connections[requested];
    }
    if (settings.connections[settings.currentConnectionId]) {
        return settings.connections[settings.currentConnectionId];
    }
    const firstKey = Object.keys(settings.connections)[0];
    return firstKey ? settings.connections[firstKey] : createDefaultConnection();
}

/** Resolve the currently active `Preset` from `settings`. */
export function resolveActivePreset(settings: Settings): Preset {
    if (settings.presets[settings.currentPresetId]) {
        return settings.presets[settings.currentPresetId];
    }
    const firstKey = Object.keys(settings.presets)[0];
    return firstKey ? settings.presets[firstKey] : createDefaultPreset();
}
