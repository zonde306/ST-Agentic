import type { WICategory } from './lore';
import type { OffMainlineSettings } from './off-mainline';

export type RunMode = 'off' | 'companion' | 'takeover';
export type ThemeMode = 'dark' | 'light' | 'auto';
export type CapsulePosition = 'top' | 'bottom';
export type CapsulePersistMode = 'keep' | 'auto_hide';
export type CachePolicy = 'auto_prefix' | 'anthropic_explicit' | 'none';
export type ApiProviderFormat = 'openai' | 'anthropic' | 'gemini';

export interface ApiConnection {
    id: string;
    name: string;
    providerFormat: ApiProviderFormat;
    baseUrl: string;
    apiKey: string;
    model: string;
    contextSize: number;
    maxTokens: number;
    temperature: number;
    topK: number;
    topP: number;
    frequencyPenalty: number;
    presencePenalty: number;
    stream: boolean;
    includeHeaders: Record<string, unknown>;
    includeBody: Record<string, unknown>;
    excludeBody: Record<string, unknown>;
    maxConcurrency: number;
    cachePolicy: CachePolicy;
    maxCacheBreakpoints?: number;
    promptPostProcessing?: 'none' | 'merge' | 'semi' | 'strict' | 'single';
    linkedPreset?: string;
    /** Enable strict tool loop (forced tool decoding + finish_turn gate + repeated read breaker; default false). */
    strictToolLoop?: boolean;
    /** Max automatic per-round retries on stream drop, empty response, constraint violation, or malformed tool JSON (default 2, 0 disables). */
    roundMaxRetries?: number;
}

export type PipelinePhase = 'before_turn' | 'main_turn' | 'after_turn' | 'maintenance';
export type BarrierPolicy = 'turn' | 'self' | 'none';
export type SessionMode = 'persistent' | 'ephemeral';

export interface ScopedPermissions {
    read: string[];
    write: string[];
}

export type BuiltinPromptTriggerType =
    | 'main'
    | 'main_normal'
    | 'main_continue'
    | 'main_regenerate'
    | 'main_swipe'
    | 'assistant'
    | 'assistant_chat'
    | 'assistant_adjust'
    | 'assistant_author'
    | 'assistant_full'
    | 'assistant_admin'
    | 'trigger'
    | 'trigger_before'
    | 'trigger_after'
    | 'trigger_maintenance'
    | 'trigger_variables'
    | 'trigger_lore'
    | 'trigger_output'
    | 'subagent'
    | 'sidegen';

export type PromptTriggerType = BuiltinPromptTriggerType | `trigger_rule:${string}`;

export type PromptTriggerContext =
    | { kind: 'main'; action?: 'normal' | 'continue' | 'regenerate' | 'swipe' }
    | { kind: 'assistant'; mode: 'chat' | 'adjust' | 'author' | 'full'; stAdminEnabled?: boolean }
    | {
          kind: 'trigger';
          phase: PipelinePhase;
          triggerIds?: readonly string[];
          decorators?: readonly string[];
          targetPaths?: readonly string[];
      }
    | { kind: 'subagent'; phase?: PipelinePhase }
    | { kind: 'sidegen'; mode?: 'once' | 'session' };

export type PromptBlockRole = 'system' | 'user' | 'assistant' | 'custom';
export type PromptBlockPlacement = 'prefix' | 'tail' | 'floating_tail';

export interface PromptBlock {
    id: string;
    name: string;
    role: PromptBlockRole;
    placement: PromptBlockPlacement;
    content: string;
    enabled: boolean;
    triggers?: PromptTriggerType[];
}

export type StrictToolLoopOverride = 'inherit' | 'on' | 'off';

export interface AgentProfile {
    id: string;
    name: string;
    connectionId: string;
    sessionMode: SessionMode;
    promptBlocks: PromptBlock[];
    enabledTools: string[];
    permissions: ScopedPermissions;
    /** Maximum tool-calling rounds per turn (`0` = unlimited). */
    maxToolRounds: number;
    watermark?: { high: number; low: number };
    ephemeralWindowSize?: number;
    description?: string;
    /** Agent-level strict tool loop override: 'inherit' (default, follows connection) | 'on' | 'off'. */
    strictToolLoop?: StrictToolLoopOverride;
}

export interface TriggerCondition {
    type: 'always' | 'interval' | 'regex' | 'keyword' | 'js_predicate';
    interval?: number;
    pattern?: string;
    keys?: string[];
    predicateCode?: string;
}

export interface TriggerRule {
    id: string;
    label: string;
    source: 'preset' | 'worldinfo';
    phase: PipelinePhase;
    order: number;
    barrier: BarrierPolicy;
    agentProfileId: string;
    kind: 'agent' | 'script';
    tag?: string;
    groupName?: string;
    condition: TriggerCondition;
    instructionTemplate: string;
    targetPath?: string;
    schemaSource?: { kind: 'json' | 'zod'; raw: string };
    decorator?: string;
    scriptCode?: string;
    findRegex?: string;
    enabled: boolean;
}

export type RegexStage = 'display' | 'ingest' | 'lore_read';

export interface RegexRule {
    id: string;
    name: string;
    pattern: string;
    replace: string;
    stage: RegexStage;
    applyToUser: boolean;
    applyToAssistant: boolean;
    enabled: boolean;
}

export type SlashToolParamType = 'string' | 'number' | 'boolean' | 'enum';

export interface SlashToolParamDef {
    name: string;
    type: SlashToolParamType;
    description: string;
    required?: boolean;
    defaultValue?: string | number | boolean;
    enumValues?: string[];
}

export type CustomToolKind = 'js' | 'slash_bridge';

export interface CustomToolConfig {
    id: string;
    name: string;
    kind: CustomToolKind;
    description: string;
    enabled: boolean;
    code?: string;
    allowNetwork?: boolean;
    commandTemplate?: string;
    params?: SlashToolParamDef[];
    allowedAgents?: string[];
}

export interface BuiltinToolConfig {
    enabled: boolean;
    description?: string;
    parameters?: Record<string, string>;
}

export interface Preset {
    id: string;
    name: string;
    mainAgentId: string;
    agents: Record<string, AgentProfile>;
    triggers: TriggerRule[];
    regexRules: RegexRule[];
    customTools: CustomToolConfig[];
    files: Record<string, string>;
    wiRouterOverrides: Record<string, WICategory>;
    builtinToolSettings?: Record<string, BuiltinToolConfig>;
}

export interface StorageSettings {
    autoCompact: boolean;
    keepDepth: number;
    sizeThreshold: number;
    pruneLegacy: boolean;
    fuzzyIndexFiles: boolean;
}

export interface Settings {
    version: number;
    runMode: RunMode;
    themeMode: ThemeMode;
    capsulePosition: CapsulePosition;
    capsulePersistMode: CapsulePersistMode;
    connections: Record<string, ApiConnection>;
    currentConnectionId: string;
    presets: Record<string, Preset>;
    currentPresetId: string;
    storage: StorageSettings;
    migrations: Record<string, boolean>;
    offMainline?: OffMainlineSettings;
}

export interface MigrationSkippedItem {
    name: string;
    reason: 'builtin_slot' | 'depth_injection' | 'unsupported' | 'invalid';
    detail?: string;
}

export interface MigrationReport {
    sourceFormat: 'st_custom_generation' | 'st_openai_preset' | 'cg_embed' | 'unknown';
    migratedConnections: number;
    migratedPresets: number;
    migratedAgents: number;
    migratedPromptBlocks: number;
    migratedTriggers: number;
    migratedRegexRules: number;
    migratedFiles: number;
    skippedItems: MigrationSkippedItem[];
    warnings: string[];
}

export interface EmbeddedPresetsPayload {
    version: 1;
    presets: Preset[];
}

export interface EmbeddedFilesPayload {
    version: 1;
    files: Record<string, string>;
}
