import type { ApiConnection, Preset, PresetMessageScript, PromptBlock, Settings } from '../types';
import {
    createDefaultMainAgent,
    createDefaultPreset,
    DEFAULT_MAIN_AGENT_ID,
} from './defaults';
import {
    isPlainRecord,
    normalizeConnection,
    normalizeConnectionsMap,
    normalizePreset,
    normalizePresetMessageScript,
    normalizePromptBlock,
    normalizeSettings,
    sanitizeName,
} from './normalize';

export const EXPORT_FORMAT_PRESET = 'st-agentic-preset';
export const EXPORT_FORMAT_PROMPT = 'st-agentic-prompt';
export const EXPORT_FORMAT_PROMPTS = 'st-agentic-prompts';
export const EXPORT_FORMAT_CONNECTIONS = 'st-agentic-connections';
export const EXPORT_FORMAT_SETTINGS = 'st-agentic-settings';
export const EXPORT_SCHEMA_VERSION = 1 as const;

export interface ExportedPresetPayload {
    format: typeof EXPORT_FORMAT_PRESET;
    version: typeof EXPORT_SCHEMA_VERSION;
    preset: Preset;
    connection?: ApiConnection;
}

export interface ExportedPromptPayload {
    format: typeof EXPORT_FORMAT_PROMPT;
    version: typeof EXPORT_SCHEMA_VERSION;
    prompt: PromptBlock;
}

export interface ExportedPromptsPayload {
    format: typeof EXPORT_FORMAT_PROMPTS;
    version: typeof EXPORT_SCHEMA_VERSION;
    presetName?: string;
    agentId?: string;
    prompts: PromptBlock[];
    preprocessScript?: PresetMessageScript;
    postprocessScript?: PresetMessageScript;
}

export interface ExportedConnectionsPayload {
    format: typeof EXPORT_FORMAT_CONNECTIONS;
    version: typeof EXPORT_SCHEMA_VERSION;
    currentConnectionId: string;
    connections: Record<string, ApiConnection>;
}

export interface ExportOptions {
    includeConnection?: ApiConnection | null;
}

export type ImportValidationResult<T> =
    | { ok: true; data: T }
    | { ok: false; error: string };

/**
 * Return a normalized deep copy of `connection` with `apiKey` strictly stripped (`''`).
 */
export function stripConnectionApiKey(connection: ApiConnection): ApiConnection {
    const normalized = normalizeConnection(connection, connection.id);
    return {
        ...normalized,
        apiKey: '',
    };
}

/**
 * Build a sanitized preset export payload.
 * Even when `includeConnection` is supplied, `apiKey` is ALWAYS stripped to `''`.
 */
export function exportPreset(
    preset: Preset,
    options: ExportOptions = {},
): ExportedPresetPayload {
    const sanitizedPreset = normalizePreset(preset, preset.id);
    const payload: ExportedPresetPayload = {
        format: EXPORT_FORMAT_PRESET,
        version: EXPORT_SCHEMA_VERSION,
        preset: sanitizedPreset,
    };

    if (options.includeConnection) {
        payload.connection = stripConnectionApiKey(options.includeConnection);
    }

    return payload;
}

/**
 * Build a sanitized connections export payload with `apiKey` strictly stripped on every entry.
 */
export function exportConnections(
    source: Settings | Record<string, ApiConnection>,
    currentConnectionId?: string,
): ExportedConnectionsPayload {
    const rawMap = isSettingsLike(source) ? source.connections : source;
    const normalizedMap = normalizeConnectionsMap(rawMap);
    const sanitizedConnections: Record<string, ApiConnection> = {};

    for (const [id, conn] of Object.entries(normalizedMap)) {
        sanitizedConnections[id] = stripConnectionApiKey(conn);
    }

    const keys = Object.keys(sanitizedConnections);
    const requestedCurrent =
        currentConnectionId ?? (isSettingsLike(source) ? source.currentConnectionId : undefined);
    const resolvedCurrent =
        requestedCurrent && sanitizedConnections[requestedCurrent]
            ? requestedCurrent
            : (keys[0] ?? '');

    return {
        format: EXPORT_FORMAT_CONNECTIONS,
        version: EXPORT_SCHEMA_VERSION,
        currentConnectionId: resolvedCurrent,
        connections: sanitizedConnections,
    };
}

/**
 * Build a sanitized `Settings` export object with `apiKey` strictly stripped from all connections.
 */
export function exportSettings(settings: Settings): Settings {
    const normalized = normalizeSettings(settings);
    const sanitizedConnections: Record<string, ApiConnection> = {};

    for (const [id, conn] of Object.entries(normalized.connections)) {
        sanitizedConnections[id] = stripConnectionApiKey(conn);
    }

    return {
        ...normalized,
        connections: sanitizedConnections,
    };
}

function isSettingsLike(value: unknown): value is Settings {
    return isPlainRecord(value) && isPlainRecord(value.connections) && isPlainRecord(value.presets);
}

/**
 * Validate and normalize an imported ST-Agentic preset payload (`st-agentic-preset`,
 * preset bundle `{ presets: [...] }`, or standalone `Preset` object).
 */
export function validatePresetImport(
    raw: unknown,
): ImportValidationResult<{ presets: Preset[]; connection?: ApiConnection }> {
    if (!isPlainRecord(raw)) {
        return { ok: false, error: 'Invalid preset import: expected a JSON object.' };
    }

    if (raw.format !== undefined && raw.format !== EXPORT_FORMAT_PRESET) {
        return {
            ok: false,
            error: `Unsupported preset export format: "${String(raw.format)}".`,
        };
    }

    // Standard single-preset export wrapper
    if (isPlainRecord(raw.preset)) {
        if (!isPlainRecord(raw.preset.agents) && typeof raw.preset.name !== 'string') {
            return { ok: false, error: 'Invalid preset import: preset object lacks name or agents.' };
        }
        const preset = normalizePreset(raw.preset, typeof raw.preset.id === 'string' ? raw.preset.id : 'imported');
        const connection = isPlainRecord(raw.connection)
            ? stripConnectionApiKey(normalizeConnection(raw.connection))
            : undefined;
        return {
            ok: true,
            data: {
                presets: [preset],
                ...(connection ? { connection } : {}),
            },
        };
    }

    // Multi-preset bundle wrapper
    if (Array.isArray(raw.presets)) {
        if (raw.presets.length === 0) {
            return { ok: false, error: 'Invalid preset import: presets array cannot be empty.' };
        }
        const presets = raw.presets
            .filter(isPlainRecord)
            .map((entry, idx) => normalizePreset(entry, `imported_${idx + 1}`));
        if (presets.length === 0) {
            return { ok: false, error: 'Invalid preset import: no valid preset objects found.' };
        }
        const connection = isPlainRecord(raw.connection)
            ? stripConnectionApiKey(normalizeConnection(raw.connection))
            : undefined;
        return {
            ok: true,
            data: {
                presets,
                ...(connection ? { connection } : {}),
            },
        };
    }

    // Bare Preset object (must look like an ST-Agentic preset, not an unrelated object)
    if (isPlainRecord(raw.agents) && typeof raw.mainAgentId === 'string') {
        const preset = normalizePreset(raw, typeof raw.id === 'string' ? raw.id : 'imported');
        return { ok: true, data: { presets: [preset] } };
    }

    return { ok: false, error: 'Invalid preset import: missing preset data.' };
}

/** Validate and normalize an imported ST-Agentic connections payload. */
export function validateConnectionsImport(
    raw: unknown,
): ImportValidationResult<{ connections: Record<string, ApiConnection>; currentConnectionId: string }> {
    if (!isPlainRecord(raw)) {
        return { ok: false, error: 'Invalid connections import: expected a JSON object.' };
    }

    if (raw.format !== undefined && raw.format !== EXPORT_FORMAT_CONNECTIONS) {
        return {
            ok: false,
            error: `Unsupported connections export format: "${String(raw.format)}".`,
        };
    }

    if (!isPlainRecord(raw.connections)) {
        return { ok: false, error: 'Invalid connections import: connections map is required.' };
    }

    const connections = normalizeConnectionsMap(raw.connections);
    const keys = Object.keys(connections);
    if (keys.length === 0) {
        return { ok: false, error: 'Invalid connections import: connections cannot be empty.' };
    }

    const requestedCurrent =
        typeof raw.currentConnectionId === 'string' ? raw.currentConnectionId.trim() : '';
    const currentConnectionId =
        requestedCurrent && connections[requestedCurrent] ? requestedCurrent : keys[0];

    return {
        ok: true,
        data: {
            connections,
            currentConnectionId,
        },
    };
}

/** Validate and normalize an imported ST-Agentic `Settings` payload. */
export function validateSettingsImport(raw: unknown): ImportValidationResult<Settings> {
    if (!isPlainRecord(raw)) {
        return { ok: false, error: 'Invalid settings import: expected a JSON object.' };
    }

    if (raw.format !== undefined && raw.format !== EXPORT_FORMAT_SETTINGS) {
        return {
            ok: false,
            error: `Unsupported settings export format: "${String(raw.format)}".`,
        };
    }

    const candidate = isPlainRecord(raw.settings) ? raw.settings : raw;
    if (!isPlainRecord(candidate.presets) && !isPlainRecord(candidate.connections)) {
        return {
            ok: false,
            error: 'Invalid settings import: expected presets or connections mapping.',
        };
    }

    return {
        ok: true,
        data: normalizeSettings(candidate),
    };
}

/** Parse and validate a preset import payload, throwing on invalid input. */
export function importPreset(
    raw: unknown,
): { presets: Preset[]; connection?: ApiConnection } {
    const res = validatePresetImport(raw);
    if (!res.ok) {
        throw new Error(res.error);
    }
    return res.data;
}

/** Parse and validate a connections import payload, throwing on invalid input. */
export function importConnections(
    raw: unknown,
): { connections: Record<string, ApiConnection>; currentConnectionId: string } {
    const res = validateConnectionsImport(raw);
    if (!res.ok) {
        throw new Error(res.error);
    }
    return res.data;
}

/** Parse and validate a settings import payload, throwing on invalid input. */
export function importSettings(raw: unknown): Settings {
    const res = validateSettingsImport(raw);
    if (!res.ok) {
        throw new Error(res.error);
    }
    return res.data;
}

export interface ImportedPromptsData {
    prompts: PromptBlock[];
    presetName?: string;
    agentId?: string;
    preprocessScript?: PresetMessageScript;
    postprocessScript?: PresetMessageScript;
}

/**
 * Validate and normalize an imported `st-agentic-prompts` or `st-agentic-prompt` payload,
 * preserving `placement`, `role: 'custom'`, `triggers`, and optional preset message scripts losslessly.
 */
export function validatePromptsImport(
    raw: unknown,
): ImportValidationResult<ImportedPromptsData> {
    if (!isPlainRecord(raw)) {
        return { ok: false, error: 'Invalid prompts import: expected a JSON object.' };
    }

    if (raw.format === EXPORT_FORMAT_PROMPTS) {
        if (!Array.isArray(raw.prompts)) {
            return { ok: false, error: 'Invalid prompts import: prompts array is required.' };
        }
        const prompts = raw.prompts
            .filter(isPlainRecord)
            .map((item, idx) =>
                normalizePromptBlock(item, `imported_${idx + 1}`, `Prompt ${idx + 1}`),
            );
        if (prompts.length === 0) {
            return { ok: false, error: 'Invalid prompts import: no valid prompt blocks found.' };
        }
        const presetName =
            typeof raw.presetName === 'string' && raw.presetName.trim()
                ? raw.presetName.trim()
                : undefined;
        const agentId =
            typeof raw.agentId === 'string' && raw.agentId.trim()
                ? raw.agentId.trim()
                : undefined;
        const preprocessScript = normalizePresetMessageScript(raw.preprocessScript);
        const postprocessScript = normalizePresetMessageScript(raw.postprocessScript);
        return {
            ok: true,
            data: {
                prompts,
                ...(presetName ? { presetName } : {}),
                ...(agentId ? { agentId } : {}),
                ...(preprocessScript ? { preprocessScript } : {}),
                ...(postprocessScript ? { postprocessScript } : {}),
            },
        };
    }

    if (raw.format === EXPORT_FORMAT_PROMPT) {
        if (!isPlainRecord(raw.prompt)) {
            return { ok: false, error: 'Invalid prompt import: prompt object is required.' };
        }
        const prompt = normalizePromptBlock(raw.prompt, 'imported_1', 'Imported Prompt');
        return {
            ok: true,
            data: {
                prompts: [prompt],
            },
        };
    }

    return { ok: false, error: 'Invalid prompts import: unsupported format.' };
}

/**
 * Construct a normalized `Preset` from validated `st-agentic-prompts` / `st-agentic-prompt` data.
 */
export function buildPresetFromPromptsImport(
    data: ImportedPromptsData,
    options: { presetName?: string; presetId?: string } = {},
): Preset {
    const presetName = sanitizeName(options.presetName ?? data.presetName, 'Imported Prompts');
    const presetId = sanitizeName(options.presetId ?? presetName, 'imported_prompts');
    const agentId = sanitizeName(data.agentId, DEFAULT_MAIN_AGENT_ID);
    const mainAgent = createDefaultMainAgent({
        id: agentId,
        promptBlocks: data.prompts,
    });
    return normalizePreset(
        createDefaultPreset({
            id: presetId,
            name: presetName,
            mainAgentId: agentId,
            agents: { [agentId]: mainAgent },
            ...(data.preprocessScript ? { preprocessScript: data.preprocessScript } : {}),
            ...(data.postprocessScript ? { postprocessScript: data.postprocessScript } : {}),
        }),
        presetId,
    );
}
