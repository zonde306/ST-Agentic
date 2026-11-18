import {
    createDefaultMainAgent,
    createDefaultStorageSettings,
    DEFAULT_CONNECTION_ID,
    DEFAULT_MAIN_AGENT_ID,
    DEFAULT_PRESET_ID,
    isPlainRecord,
    normalizeConnection,
    normalizeFileMap,
    normalizeSettings,
    normalizeStorageSettings,
    sanitizeName,
    SETTINGS_VERSION,
} from '../config';
import type {
    AgentProfile,
    ApiConnection,
    BarrierPolicy,
    BuiltinToolConfig,
    PipelinePhase,
    Preset,
    RegexRule,
    RegexStage,
    ScopedPermissions,
    Settings,
    TriggerCondition,
    TriggerRule,
} from '../types';
import {
    allocateUniqueId,
    convertLegacyPromptsToBlocks,
    createEmptyMigrationReport,
} from './prompts';
import type { MigrationReport } from '../types';

export interface LegacyMigrationResult {
    settings: Settings;
    report: MigrationReport;
}

const LEGACY_TOOL_REPLACEMENT_MAP: Record<string, string[]> = {
    get_worldinfo: ['read_file', 'list_dir'],
    search_worldinfo: ['search_files'],
    set_worldinfo: ['write_file', 'edit_file'],
};

/**
 * Heuristic detector for `ST-CustomGeneration` settings or export JSON payloads.
 */
export function isLegacyCustomGenerationData(raw: unknown): boolean {
    if (!isPlainRecord(raw)) {
        return false;
    }

    // Already an ST-Agentic v1+ payload if `connections` + `runMode` or `st-agentic-*` format
    if (
        typeof raw.format === 'string'
        && raw.format.startsWith('st-agentic-')
    ) {
        return false;
    }
    if (isPlainRecord(raw.connections) && typeof raw.runMode === 'string') {
        return false;
    }

    if (isPlainRecord(raw.apis) || typeof raw.interceptGenerate === 'boolean') {
        return true;
    }

    if (Array.isArray(raw.presets) && raw.presets.some(isLegacyPresetShape)) {
        return true;
    }

    if (isPlainRecord(raw.presets)) {
        return Object.values(raw.presets).some(isLegacyPresetShape);
    }

    return isLegacyPresetShape(raw);
}

function isLegacyPresetShape(raw: unknown): boolean {
    if (!isPlainRecord(raw)) {
        return false;
    }
    if (isPlainRecord(raw.agents) && typeof raw.mainAgentId === 'string') {
        return false;
    }
    return (
        Array.isArray(raw.prompts)
        && (Array.isArray(raw.regexs) || isPlainRecord(raw.templates))
    );
}

/** Convert a legacy `ST-CustomGeneration` `ApiSettings` object into an `ApiConnection`. */
export function migrateLegacyConnection(id: string, rawApi: unknown): ApiConnection {
    const raw = isPlainRecord(rawApi) ? rawApi : {};
    return normalizeConnection(
        {
            ...raw,
            id,
            name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : id,
            providerFormat: 'openai',
            cachePolicy: 'auto_prefix',
        },
        id,
    );
}

/**
 * Map a legacy `ST-CustomGeneration` `RegEx` entry to `RegexRule` (`display` / `lore_read` / `ingest`),
 * dropping legacy `minDepth` / `maxDepth` history rewriting bounds.
 */
export function migrateLegacyRegex(
    rawRegex: unknown,
    index: number,
    warnings: string[],
    usedIds?: Set<string>,
): RegexRule | null {
    if (!isPlainRecord(rawRegex)) {
        return null;
    }

    const name = sanitizeName(rawRegex.name, `Regex ${index + 1}`);
    const id = usedIds
        ? allocateUniqueId(name, usedIds, `regex_${index + 1}`)
        : `regex_${index + 1}`;
    const pattern = typeof rawRegex.regex === 'string'
        ? rawRegex.regex
        : typeof rawRegex.pattern === 'string'
            ? rawRegex.pattern
            : '';
    const replace = typeof rawRegex.replace === 'string'
        ? rawRegex.replace
        : String(rawRegex.replace ?? '');

    const userInput = Boolean(rawRegex.userInput);
    const aiOutput = Boolean(rawRegex.aiOutput);
    const worldInfo = Boolean(rawRegex.worldInfo);
    const ephemerality = Boolean(rawRegex.ephemerality);
    const request = Boolean(rawRegex.request);
    const response = Boolean(rawRegex.response);

    let stage: RegexStage;
    if (worldInfo && !ephemerality) {
        stage = 'lore_read';
    } else if (ephemerality || (response && !request && !worldInfo)) {
        stage = 'display';
    } else if (worldInfo) {
        stage = 'lore_read';
    } else {
        stage = 'ingest';
    }

    if (
        (rawRegex.minDepth !== null && rawRegex.minDepth !== undefined)
        || (rawRegex.maxDepth !== null && rawRegex.maxDepth !== undefined)
    ) {
        warnings.push(
            `Regex "${name}": dropped depth bounds (minDepth=${String(rawRegex.minDepth)}, maxDepth=${String(rawRegex.maxDepth)}) for KV cache invariance.`,
        );
    }

    return {
        id,
        name,
        pattern,
        replace,
        stage,
        applyToUser: stage === 'lore_read' ? false : userInput,
        applyToAssistant: stage === 'lore_read' ? false : aiOutput,
        enabled: rawRegex.enabled === undefined ? true : Boolean(rawRegex.enabled),
    };
}

function resolveTriggerCapabilities(decorator: string): {
    tools: string[];
    permissions: ScopedPermissions;
    barrier: BarrierPolicy;
    phase: PipelinePhase;
} {
    const phase: PipelinePhase = decorator.endsWith('_before') ? 'before_turn' : 'after_turn';

    if (decorator.startsWith('@@variables')) {
        return {
            phase,
            barrier: 'turn',
            tools: ['read_variables', 'patch_variables', 'read_file'],
            permissions: {
                read: ['/state/variables.json', '/lorebooks/**', '/memory/**'],
                write: ['/state/variables.json'],
            },
        };
    }

    if (decorator.startsWith('@@append_output')) {
        return {
            phase,
            barrier: phase === 'before_turn' ? 'turn' : 'self',
            tools: ['append_reply_view', 'read_file', 'read_variables'],
            permissions: { read: ['/**'], write: [] },
        };
    }

    if (decorator.startsWith('@@replace_output')) {
        return {
            phase,
            barrier: phase === 'before_turn' ? 'turn' : 'self',
            tools: ['replace_reply_view', 'read_file', 'read_variables'],
            permissions: { read: ['/**'], write: [] },
        };
    }

    if (decorator.startsWith('@@evaluate_ejs')) {
        return {
            phase,
            barrier: phase === 'before_turn' ? 'turn' : 'self',
            tools: ['read_variables', 'patch_variables', 'read_file', 'edit_file', 'write_file'],
            permissions: {
                read: ['/**'],
                write: ['/lorebooks/**', '/state/variables.json', '/memory/**'],
            },
        };
    }

    // @@replace, @@replace_diff, @@replace_search, etc.
    return {
        phase,
        barrier: phase === 'before_turn' ? 'turn' : 'self',
        tools: ['read_file', 'edit_file', 'write_file', 'read_variables'],
        permissions: {
            read: ['/**'],
            write: ['/lorebooks/**', '/memory/**', '/state/**'],
        },
    };
}

function normalizeLegacyTemplatePrompts(raw: Record<string, unknown>): unknown[] {
    if (Array.isArray(raw.prompts)) {
        return raw.prompts;
    }
    if (raw.content !== undefined && raw.content !== null) {
        return [
            {
                name: 'Instruction',
                role: 'user',
                prompt: String(raw.content),
                injectionPosition: 'relative',
                enabled: true,
                internal: null,
            },
        ];
    }
    return [];
}

/**
 * Split a legacy `ST-CustomGeneration` `Template` / `GenerationProfile` into an `AgentProfile`
 * and (for trigger kinds) a matching `TriggerRule`.
 */
export function migrateLegacyTemplate(
    templateKey: string,
    rawTemplate: unknown,
    report: MigrationReport,
    usedAgentIds: Set<string>,
    usedTriggerIds: Set<string>,
): { agent: AgentProfile; trigger?: TriggerRule } | null {
    if (!isPlainRecord(rawTemplate)) {
        return null;
    }

    const rawId = typeof rawTemplate.id === 'string' ? rawTemplate.id.trim() : '';
    const legacyDecorator = typeof rawTemplate.decorator === 'string' ? rawTemplate.decorator.trim() : '';
    let kind = typeof rawTemplate.kind === 'string' ? rawTemplate.kind.trim() : '';
    let binding = typeof rawTemplate.binding === 'string'
        ? rawTemplate.binding.trim()
        : legacyDecorator;
    let tag = typeof rawTemplate.tag === 'string' ? rawTemplate.tag.trim() : '';

    if (!kind) {
        if (binding === '@@agent') {
            kind = 'agent';
            binding = tag;
            tag = '';
        } else {
            kind = 'trigger';
        }
    }

    const rawPrompts = normalizeLegacyTemplatePrompts(rawTemplate);
    const promptBlocks = convertLegacyPromptsToBlocks(rawPrompts, report, {
        idPrefix: rawId || binding || templateKey,
        recordBuiltinSkips: true,
    });

    if (kind === 'agent') {
        const agentId = allocateUniqueId(binding || rawId || templateKey, usedAgentIds, 'subagent');
        const agentName = binding || rawId || agentId;
        const agent: AgentProfile = {
            id: agentId,
            name: agentName,
            connectionId: 'inherit',
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 6,
            promptBlocks,
            enabledTools: [
                'list_dir',
                'glob_files',
                'grep_search',
                'search_files',
                'read_file',
                'read_variables',
                'search_history',
                'read_history',
            ],
            permissions: { read: ['/**'], write: [] },
            maxToolRounds: 6,
        };
        return { agent };
    }

    const decorator = binding || '@@replace';
    const capabilities = resolveTriggerCapabilities(decorator);
    const agentId = allocateUniqueId(
        rawId || `${decorator}${tag ? `_${tag}` : ''}`,
        usedAgentIds,
        'trigger_agent',
    );
    const label = tag ? `${decorator} (${tag})` : decorator;

    const agent: AgentProfile = {
        id: agentId,
        name: label,
        connectionId: 'inherit',
        sessionMode: 'ephemeral',
        ephemeralWindowSize: 4,
        promptBlocks,
        enabledTools: capabilities.tools,
        permissions: capabilities.permissions,
        maxToolRounds: 6,
    };

    const legacyOutputRegex = typeof rawTemplate.regex === 'string' ? rawTemplate.regex.trim() : '';
    if (legacyOutputRegex) {
        report.warnings.push(
            `Template "${label}": legacy output extraction regex "${legacyOutputRegex}" was superseded by structured tool calls.`,
        );
    }

    const findRegex = typeof rawTemplate.findRegex === 'string' ? rawTemplate.findRegex.trim() : '';
    const condition: TriggerCondition = findRegex
        ? { type: 'regex', pattern: findRegex }
        : { type: 'always' };

    const enabledBlocks = promptBlocks.filter((b) => b.enabled && b.content.trim().length > 0);
    const fallbackBlocks = enabledBlocks.length > 0
        ? enabledBlocks
        : promptBlocks.filter((b) => b.content.trim().length > 0);
    const instructionTemplate = fallbackBlocks.map((b) => b.content).join('\n\n');

    const triggerId = allocateUniqueId(
        rawId ? `trigger_${rawId}` : `trigger_${decorator}_${tag}`,
        usedTriggerIds,
        'trigger',
    );

    const trigger: TriggerRule = {
        id: triggerId,
        label,
        source: 'preset',
        phase: capabilities.phase,
        order: 1,
        barrier: capabilities.barrier,
        agentProfileId: agentId,
        kind: decorator.startsWith('@@evaluate_ejs') ? 'script' : 'agent',
        tag,
        decorator,
        condition,
        instructionTemplate,
        ...(findRegex ? { findRegex } : {}),
        enabled: true,
    };

    return { agent, trigger };
}

function migrateLegacyTools(
    rawTools: unknown,
    mainAgent: AgentProfile,
): Record<string, BuiltinToolConfig> | undefined {
    if (!isPlainRecord(rawTools)) {
        return undefined;
    }

    const builtinToolSettings: Record<string, BuiltinToolConfig> = {};
    const enabledSet = new Set(mainAgent.enabledTools);

    for (const [toolName, value] of Object.entries(rawTools)) {
        if (!isPlainRecord(value)) {
            continue;
        }
        const enabled = Boolean(value.enabled);
        const config: BuiltinToolConfig = { enabled };
        if (typeof value.description === 'string') {
            config.description = value.description;
        }
        if (isPlainRecord(value.parameters)) {
            config.parameters = Object.fromEntries(
                Object.entries(value.parameters).map(([pKey, pVal]) => [pKey, String(pVal ?? '')]),
            );
        }
        builtinToolSettings[toolName] = config;

        if (enabled) {
            const replacements = LEGACY_TOOL_REPLACEMENT_MAP[toolName];
            if (replacements) {
                replacements.forEach((mapped) => enabledSet.add(mapped));
            } else {
                enabledSet.add(toolName);
            }
        }
    }

    mainAgent.enabledTools = Array.from(enabledSet);
    return builtinToolSettings;
}

/**
 * Migrate a single legacy `ST-CustomGeneration` `Preset` object into `Preset` (`ST-Agentic`).
 */
export function migrateLegacyPreset(
    rawPreset: unknown,
    fallbackName: string,
    report: MigrationReport,
): Preset {
    const raw = isPlainRecord(rawPreset) ? rawPreset : {};
    const name = sanitizeName(raw.name, fallbackName);
    const id = sanitizeName(raw.id, name);

    const mainPromptBlocks = convertLegacyPromptsToBlocks(raw.prompts, report, {
        idPrefix: 'main',
        recordBuiltinSkips: true,
    });

    const mainAgent = createDefaultMainAgent({
        id: DEFAULT_MAIN_AGENT_ID,
        name: 'Main Narrative',
        promptBlocks: mainPromptBlocks,
    });

    const agents: Record<string, AgentProfile> = {
        [mainAgent.id]: mainAgent,
    };
    const triggers: TriggerRule[] = [];
    const usedAgentIds = new Set<string>([mainAgent.id]);
    const usedTriggerIds = new Set<string>();

    if (isPlainRecord(raw.templates)) {
        for (const [key, tpl] of Object.entries(raw.templates)) {
            const converted = migrateLegacyTemplate(
                key,
                tpl,
                report,
                usedAgentIds,
                usedTriggerIds,
            );
            if (!converted) {
                continue;
            }
            agents[converted.agent.id] = converted.agent;
            if (converted.trigger) {
                triggers.push(converted.trigger);
                report.migratedTriggers += 1;
            }
        }
    }

    const usedRegexIds = new Set<string>();
    const regexRules: RegexRule[] = Array.isArray(raw.regexs)
        ? raw.regexs
            .map((entry, idx) => migrateLegacyRegex(entry, idx, report.warnings, usedRegexIds))
            .filter((rule): rule is RegexRule => rule !== null)
        : [];
    report.migratedRegexRules += regexRules.length;

    const files = normalizeFileMap(raw.files);
    report.migratedFiles += Object.keys(files).length;

    const builtinToolSettings = migrateLegacyTools(raw.tools, mainAgent);

    report.migratedPresets += 1;
    report.migratedAgents += Object.keys(agents).length;

    return {
        id,
        name,
        mainAgentId: mainAgent.id,
        agents,
        triggers,
        regexRules,
        customTools: [],
        files,
        wiRouterOverrides: {},
        ...(builtinToolSettings ? { builtinToolSettings } : {}),
    };
}

/**
 * Lossless one-way migration from `ST-CustomGeneration` settings, preset export JSON,
 * or API connections export JSON into `ST-Agentic` `Settings` + `MigrationReport`.
 */
export function migrateFromCustomGeneration(raw: unknown): LegacyMigrationResult {
    if (!isPlainRecord(raw)) {
        throw new Error('Invalid legacy ST-CustomGeneration payload: expected a JSON object.');
    }

    const report = createEmptyMigrationReport('st_custom_generation');
    const connections: Record<string, ApiConnection> = {};
    const presets: Record<string, Preset> = {};
    let currentConnectionId = '';
    let currentPresetId = '';

    // 1. Connections (`apis` map or `ExportPayload.apiConnection`)
    if (isPlainRecord(raw.apis)) {
        for (const [key, apiVal] of Object.entries(raw.apis)) {
            if (!isPlainRecord(apiVal)) {
                continue;
            }
            const id = sanitizeName(key, DEFAULT_CONNECTION_ID);
            connections[id] = migrateLegacyConnection(id, apiVal);
            report.migratedConnections += 1;
        }
        const requestedApi = typeof raw.currentApi === 'string' ? raw.currentApi.trim() : '';
        currentConnectionId =
            requestedApi && connections[requestedApi]
                ? requestedApi
                : (Object.keys(connections)[0] ?? '');
    } else if (isPlainRecord(raw.apiConnection)) {
        const conn = migrateLegacyConnection(DEFAULT_CONNECTION_ID, raw.apiConnection);
        connections[conn.id] = conn;
        currentConnectionId = conn.id;
        report.migratedConnections += 1;
    }

    // 2. Presets (record, array export, or standalone preset)
    if (Array.isArray(raw.presets)) {
        const migratedList: Preset[] = [];
        raw.presets.forEach((entry, idx) => {
            if (!isPlainRecord(entry)) {
                return;
            }
            const preset = migrateLegacyPreset(entry, `Preset ${idx + 1}`, report);
            presets[preset.id] = preset;
            migratedList.push(preset);
        });
        const idx = Number(raw.currentPreset);
        if (Number.isInteger(idx) && idx >= 0 && idx < migratedList.length) {
            currentPresetId = migratedList[idx].id;
        } else if (migratedList.length > 0) {
            currentPresetId = migratedList[0].id;
        }
    } else if (isPlainRecord(raw.presets)) {
        for (const [key, presetVal] of Object.entries(raw.presets)) {
            if (!isPlainRecord(presetVal)) {
                continue;
            }
            const fallback = sanitizeName(key, DEFAULT_PRESET_ID);
            const preset = migrateLegacyPreset(presetVal, fallback, report);
            presets[preset.id] = preset;
        }
        const requestedPreset =
            typeof raw.currentPreset === 'string' ? raw.currentPreset.trim() : '';
        currentPresetId =
            requestedPreset && presets[requestedPreset]
                ? requestedPreset
                : (Object.keys(presets)[0] ?? '');
    } else if (isLegacyPresetShape(raw)) {
        const preset = migrateLegacyPreset(raw, 'Imported Legacy Preset', report);
        presets[preset.id] = preset;
        currentPresetId = preset.id;
    }

    if (
        report.migratedConnections === 0
        && report.migratedPresets === 0
    ) {
        throw new Error('Unrecognized legacy ST-CustomGeneration data.');
    }

    const migrations: Record<string, boolean> = {};
    if (isPlainRecord(raw.migrations)) {
        for (const [k, v] of Object.entries(raw.migrations)) {
            if (typeof v === 'boolean') {
                migrations[k] = v;
            }
        }
    }
    migrations.legacy_custom_generation = true;

    const runMode = raw.interceptGenerate === true ? 'takeover' : 'companion';
    const storage = isPlainRecord(raw.storage)
        ? normalizeStorageSettings(raw.storage)
        : createDefaultStorageSettings();

    const normalized = normalizeSettings({
        version: SETTINGS_VERSION,
        runMode,
        themeMode: 'dark',
        capsulePosition: 'bottom',
        capsulePersistMode: 'keep',
        connections: Object.keys(connections).length > 0 ? connections : undefined,
        currentConnectionId,
        presets: Object.keys(presets).length > 0 ? presets : undefined,
        currentPresetId,
        storage,
        migrations,
    });

    return {
        settings: normalized,
        report,
    };
}
