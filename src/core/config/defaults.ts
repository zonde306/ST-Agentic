import { canonicalClone } from '../utils';
import type {
    AgentProfile,
    ApiConnection,
    Preset,
    PromptBlock,
    ScopedPermissions,
    Settings,
    StorageSettings,
} from '../types';

export const SETTINGS_VERSION = 1;
export const DEFAULT_CONNECTION_ID = 'default';
export const DEFAULT_PRESET_ID = 'default';
export const DEFAULT_MAIN_AGENT_ID = 'main';
export const DEFAULT_FILE_MAP_SIZE_LIMIT = 256 * 1024;

export const DEFAULT_WATERMARK = {
    high: 36000,
    low: 18000,
} as const;

export const DEFAULT_MAIN_AGENT_TOOLS: readonly string[] = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'write_file',
    'append_file',
    'edit_file',
    'read_variables',
    'search_history',
    'read_history',
];

export const DEFAULT_MAIN_AGENT_PERMISSIONS: ScopedPermissions = {
    read: ['/**'],
    write: ['/output.md', '/memory/**', '/scratch/**', '/workspace/shared/**'],
};

const DEFAULT_SYSTEM_BASE_PROMPT = [
    'You operate on top of a Virtual File System (VFS) mounting /output.md, /character/, /persona/, /lorebooks/, /skills/, /preset/, /global/, /workspace/, /state/variables.json, and /history/.',
    'This workspace may represent a single-character roleplay, a multi-character ensemble, or an open world simulation; follow the system rules and core manifest rather than assuming a single fixed persona.',
    'Retrieve details on demand via read_file, search_files, grep_search, and list_dir before asserting lore or state. For large files, locate lines with grep_search/search_files, page with read_file(start_line, end_line), and edit via edit_file (omit "N| " prefixes).',
    'Treat <lore-hint> entries as literal keyword suggestions and read only the files relevant to the current scene.',
    'Instruction indexes (AGENTS.md under /global/, /preset/, /workspace/) and docs/** are read-only guides: resolve relative paths in an AGENTS.md relative to its directory and read linked docs only when relevant; use /workspace/shared/ for cross-agent collaboration notes.',
    'Output Protocol: Plain assistant text is strictly internal (for planning, tool reasoning, or review notes) and is NEVER displayed to the user.',
    'Write your complete user-facing response to /output.md via write_file (or chunked append_file). After writing /output.md, review it in-turn for canon consistency, formatting tags, character voice, and state accuracy, fix any errors in-place via edit_file("/output.md", ...), and finish only once /output.md is ready.',
].join('\n');

export function createDefaultPromptBlocks(): PromptBlock[] {
    return [
        {
            id: 'system_base',
            name: 'Decoupled Narrative Base',
            role: 'system',
            placement: 'prefix',
            content: DEFAULT_SYSTEM_BASE_PROMPT,
            enabled: true,
        },
        {
            id: 'tail_guidance',
            name: 'Tail Guidance',
            role: 'system',
            placement: 'tail',
            content: '',
            enabled: false,
        },
    ];
}

/** Create a fresh default `ApiConnection` snapshot. */
export function createDefaultConnection(overrides: Partial<ApiConnection> = {}): ApiConnection {
    const base: ApiConnection = {
        id: DEFAULT_CONNECTION_ID,
        name: 'Default',
        providerFormat: 'openai',
        baseUrl: 'http://localhost:8080/v1',
        apiKey: '',
        model: '',
        contextSize: 64000,
        maxTokens: 4096,
        temperature: 0.8,
        topK: 0,
        topP: 1,
        frequencyPenalty: 0,
        presencePenalty: 0,
        stream: true,
        includeHeaders: {},
        includeBody: {},
        excludeBody: {},
        maxConcurrency: 2,
        cachePolicy: 'auto_prefix',
        maxCacheBreakpoints: 4,
        promptPostProcessing: 'none',
        systemInstructionMode: 'native',
        linkedPreset: '',
        strictToolLoop: false,
        roundMaxRetries: 2,
    };

    return {
        ...base,
        ...canonicalClone(overrides),
        includeHeaders: canonicalClone(overrides.includeHeaders ?? {}),
        includeBody: canonicalClone(overrides.includeBody ?? {}),
        excludeBody: canonicalClone(overrides.excludeBody ?? {}),
    };
}

/** Create the default persistent main narrative `AgentProfile`. */
export function createDefaultMainAgent(overrides: Partial<AgentProfile> = {}): AgentProfile {
    return {
        id: overrides.id ?? DEFAULT_MAIN_AGENT_ID,
        name: overrides.name ?? 'Main Narrative',
        connectionId: overrides.connectionId ?? 'inherit',
        sessionMode: overrides.sessionMode ?? 'persistent',
        promptBlocks: overrides.promptBlocks
            ? canonicalClone(overrides.promptBlocks)
            : createDefaultPromptBlocks(),
        enabledTools: overrides.enabledTools
            ? [...overrides.enabledTools]
            : [...DEFAULT_MAIN_AGENT_TOOLS],
        permissions: overrides.permissions
            ? {
                read: [...overrides.permissions.read],
                write: [...overrides.permissions.write],
            }
            : {
                read: [...DEFAULT_MAIN_AGENT_PERMISSIONS.read],
                write: [...DEFAULT_MAIN_AGENT_PERMISSIONS.write],
            },
        maxToolRounds: overrides.maxToolRounds ?? 0,
        watermark: overrides.watermark
            ? { ...overrides.watermark }
            : { ...DEFAULT_WATERMARK },
        ...(overrides.ephemeralWindowSize !== undefined
            ? { ephemeralWindowSize: overrides.ephemeralWindowSize }
            : {}),
        ...(overrides.description !== undefined
            ? { description: overrides.description }
            : {}),
        strictToolLoop: overrides.strictToolLoop ?? 'inherit',
    };
}

/** Create a fresh default `Preset` containing the default main narrative agent. */
export function createDefaultPreset(overrides: Partial<Preset> = {}): Preset {
    const mainAgentId = overrides.mainAgentId?.trim() || DEFAULT_MAIN_AGENT_ID;
    const defaultMain = createDefaultMainAgent({ id: mainAgentId });

    return {
        id: overrides.id?.trim() || DEFAULT_PRESET_ID,
        name: overrides.name?.trim() || 'Default',
        mainAgentId,
        agents: overrides.agents
            ? canonicalClone(overrides.agents)
            : { [mainAgentId]: defaultMain },
        triggers: overrides.triggers ? canonicalClone(overrides.triggers) : [],
        regexRules: overrides.regexRules ? canonicalClone(overrides.regexRules) : [],
        customTools: overrides.customTools ? canonicalClone(overrides.customTools) : [],
        files: overrides.files ? { ...overrides.files } : {},
        wiRouterOverrides: overrides.wiRouterOverrides ? { ...overrides.wiRouterOverrides } : {},
        ...(overrides.builtinToolSettings
            ? { builtinToolSettings: canonicalClone(overrides.builtinToolSettings) }
            : {}),
    };
}

/** Create fresh default `StorageSettings`. */
export function createDefaultStorageSettings(
    overrides: Partial<StorageSettings> = {},
): StorageSettings {
    return {
        autoCompact: true,
        keepDepth: 32,
        sizeThreshold: DEFAULT_FILE_MAP_SIZE_LIMIT,
        pruneLegacy: true,
        fuzzyIndexFiles: true,
        ...overrides,
    };
}

/** Create a complete default `Settings` object with one default connection and preset. */
export function createDefaultSettings(overrides: Partial<Settings> = {}): Settings {
    const defaultConn = createDefaultConnection();
    const defaultPreset = createDefaultPreset();

    return {
        version: overrides.version ?? SETTINGS_VERSION,
        runMode: overrides.runMode ?? 'companion',
        themeMode: overrides.themeMode ?? 'dark',
        capsulePosition: overrides.capsulePosition ?? 'bottom',
        capsulePersistMode: overrides.capsulePersistMode ?? 'keep',
        connections: overrides.connections
            ? canonicalClone(overrides.connections)
            : { [defaultConn.id]: defaultConn },
        currentConnectionId: overrides.currentConnectionId ?? defaultConn.id,
        presets: overrides.presets
            ? canonicalClone(overrides.presets)
            : { [defaultPreset.id]: defaultPreset },
        currentPresetId: overrides.currentPresetId ?? defaultPreset.id,
        storage: overrides.storage
            ? createDefaultStorageSettings(overrides.storage)
            : createDefaultStorageSettings(),
        migrations: overrides.migrations ? { ...overrides.migrations } : {},
    };
}
