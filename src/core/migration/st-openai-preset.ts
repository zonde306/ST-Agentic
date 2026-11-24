import { parse as parseYaml } from 'yaml';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    DEFAULT_MAIN_AGENT_ID,
    isPlainRecord,
    normalizeConnection,
    sanitizeName,
} from '../config';
import type {
    ApiConnection,
    ApiProviderFormat,
    CachePolicy,
    MigrationReport,
    Preset,
    RegexRule,
    RegexStage,
} from '../types';
import {
    allocateUniqueId,
    convertStOpenAiPromptsToBlocks,
    createEmptyMigrationReport,
} from './prompts';

export interface StOpenAIPresetImportOptions {
    presetName?: string;
    presetId?: string;
}

export interface StOpenAIPresetImportResult {
    preset: Preset;
    connection: ApiConnection;
    report: MigrationReport;
}

/** SillyTavern `regex_placement` numeric enum values. */
const ST_REGEX_PLACEMENT = {
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    WORLD_INFO: 5,
} as const;

/**
 * Heuristic check for a SillyTavern OpenAI/Chat-Completion preset JSON object.
 */
export function isSillyTavernOpenAIPreset(raw: unknown): boolean {
    if (!isPlainRecord(raw)) {
        return false;
    }
    return (
        typeof raw.chat_completion_source === 'string'
        || (Array.isArray(raw.prompts) && !Array.isArray(raw.regexs) && !isPlainRecord(raw.templates))
    );
}

function parseOptionalYamlRecord(
    value: unknown,
    fieldName: string,
    warnings: string[],
): Record<string, unknown> {
    if (isPlainRecord(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return {};
    }

    try {
        const parsed: unknown = parseYaml(value);
        if (isPlainRecord(parsed)) {
            return parsed;
        }
        warnings.push(`Ignored "${fieldName}": YAML root is not an object mapping.`);
        return {};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Failed to parse "${fieldName}" YAML: ${message}`);
        return {};
    }
}

function convertStRegexScript(
    rawScript: unknown,
    index: number,
    warnings: string[],
    usedIds: Set<string>,
): RegexRule | null {
    if (!isPlainRecord(rawScript)) {
        return null;
    }

    const name = sanitizeName(rawScript.scriptName, `ST Regex ${index + 1}`);
    const id = allocateUniqueId(name, usedIds, `st_regex_${index + 1}`);
    const pattern = typeof rawScript.findRegex === 'string' ? rawScript.findRegex : '';
    const replace = typeof rawScript.replaceString === 'string' ? rawScript.replaceString : '';
    const placement = Array.isArray(rawScript.placement)
        ? rawScript.placement.map((v) => Number(v))
        : [];

    const hasUser = placement.includes(ST_REGEX_PLACEMENT.USER_INPUT);
    const hasAssistant = placement.includes(ST_REGEX_PLACEMENT.AI_OUTPUT);
    const hasWorldInfo = placement.includes(ST_REGEX_PLACEMENT.WORLD_INFO);
    const markdownOnly = Boolean(rawScript.markdownOnly);

    let stage: RegexStage;
    if (hasWorldInfo && !markdownOnly) {
        stage = 'lore_read';
    } else if (markdownOnly) {
        stage = 'display';
    } else {
        stage = 'ingest';
    }

    if (
        (rawScript.minDepth !== null && rawScript.minDepth !== undefined)
        || (rawScript.maxDepth !== null && rawScript.maxDepth !== undefined)
    ) {
        warnings.push(
            `Regex "${name}": dropped depth bounds (minDepth=${String(rawScript.minDepth)}, maxDepth=${String(rawScript.maxDepth)}) for KV cache invariance.`,
        );
    }

    return {
        id,
        name,
        pattern,
        replace,
        stage,
        applyToUser: stage === 'lore_read' ? false : hasUser,
        applyToAssistant: stage === 'lore_read' ? false : hasAssistant,
        enabled: !rawScript.disabled,
    };
}

function extractStConnection(
    raw: Record<string, unknown>,
    linkedPresetId: string,
    warnings: string[],
): ApiConnection {
    const source = typeof raw.chat_completion_source === 'string'
        ? raw.chat_completion_source.trim() || 'openai'
        : 'openai';
    const providerFormat: ApiProviderFormat =
        source === 'claude' || source === 'anthropic'
            ? 'anthropic'
            : source === 'makersuite' || source === 'gemini' || source === 'google'
                ? 'gemini'
                : 'openai';
    const cachePolicy: CachePolicy =
        providerFormat === 'anthropic' ? 'anthropic_explicit' : 'auto_prefix';

    const modelKey = `${source}_model`;
    const urlKey = `${source}_url`;
    const defaults = createDefaultConnection();
    const fallbackBaseUrl =
        providerFormat === 'gemini'
            ? 'https://generativelanguage.googleapis.com/v1beta'
            : defaults.baseUrl;

    const rawPostProc = typeof raw.custom_prompt_post_processing === 'string'
        ? raw.custom_prompt_post_processing.replace('_tools', '')
        : 'none';

    const includeHeaders = source === 'custom' || raw.custom_include_headers
        ? parseOptionalYamlRecord(raw.custom_include_headers, 'custom_include_headers', warnings)
        : {};
    const includeBody = source === 'custom' || raw.custom_include_body
        ? parseOptionalYamlRecord(raw.custom_include_body, 'custom_include_body', warnings)
        : {};
    const excludeBody = source === 'custom' || raw.custom_exclude_body
        ? parseOptionalYamlRecord(raw.custom_exclude_body, 'custom_exclude_body', warnings)
        : {};

    return normalizeConnection(
        {
            id: `st_${source}`,
            name: `ST (${source})`,
            providerFormat,
            baseUrl: typeof raw[urlKey] === 'string' && raw[urlKey]
                ? raw[urlKey]
                : fallbackBaseUrl,
            apiKey: '',
            model: typeof raw[modelKey] === 'string' && raw[modelKey]
                ? raw[modelKey]
                : providerFormat === 'gemini' && typeof raw.google_model === 'string' && raw.google_model
                    ? raw.google_model
                    : (typeof raw.openai_model === 'string' ? raw.openai_model : ''),
            contextSize: raw.openai_max_context,
            maxTokens: raw.openai_max_tokens,
            temperature: raw.temperature,
            topK: raw.top_k,
            topP: raw.top_p,
            frequencyPenalty: raw.frequency_penalty,
            presencePenalty: raw.presence_penalty,
            stream: raw.stream_openai === undefined ? true : Boolean(raw.stream_openai),
            includeHeaders,
            includeBody,
            excludeBody,
            maxConcurrency: 2,
            cachePolicy,
            maxCacheBreakpoints: 4,
            promptPostProcessing: rawPostProc,
            linkedPreset: linkedPresetId,
        },
        `st_${source}`,
    );
}

/**
 * Import a traditional SillyTavern OpenAI preset JSON, preserving custom `relative` blocks
 * as `prefix` and `inChat @D0` blocks as `tail`, while skipping built-in marker slots
 * and `@D >= 1` depth injections into a structured `MigrationReport`.
 */
export function importSillyTavernOpenAIPreset(
    raw: unknown,
    options: StOpenAIPresetImportOptions = {},
): StOpenAIPresetImportResult {
    if (!isSillyTavernOpenAIPreset(raw)) {
        throw new Error('Invalid SillyTavern OpenAI preset JSON.');
    }

    const data = raw as Record<string, unknown>;
    const report = createEmptyMigrationReport('st_openai_preset');

    const presetName = sanitizeName(
        options.presetName ?? data.name,
        'Imported ST Preset',
    );
    const presetId = sanitizeName(options.presetId ?? presetName, 'imported_st_preset');

    const promptBlocks = convertStOpenAiPromptsToBlocks(data.prompts, data.prompt_order, report);
    const mainAgent = createDefaultMainAgent({
        id: DEFAULT_MAIN_AGENT_ID,
        name: 'Main Narrative',
        promptBlocks,
    });

    const regexRules: RegexRule[] = [];
    const usedRegexIds = new Set<string>();
    if (isPlainRecord(data.extensions)) {
        const regexScripts = Array.isArray(data.extensions.regex_scripts)
            ? data.extensions.regex_scripts
            : (isPlainRecord(data.extensions.SPreset)
                && isPlainRecord(data.extensions.SPreset.RegexBinding)
                && Array.isArray(data.extensions.SPreset.RegexBinding.regexes))
                ? data.extensions.SPreset.RegexBinding.regexes
                : [];

        regexScripts.forEach((script, idx) => {
            const converted = convertStRegexScript(script, idx, report.warnings, usedRegexIds);
            if (converted) {
                regexRules.push(converted);
            }
        });
    }

    const connection = extractStConnection(data, presetId, report.warnings);

    const preset: Preset = {
        id: presetId,
        name: presetName,
        mainAgentId: mainAgent.id,
        agents: { [mainAgent.id]: mainAgent },
        triggers: [],
        regexRules,
        customTools: [],
        files: {},
        wiRouterOverrides: {},
    };

    report.migratedConnections = 1;
    report.migratedPresets = 1;
    report.migratedAgents = 1;
    report.migratedRegexRules = regexRules.length;

    return {
        preset,
        connection,
        report,
    };
}
