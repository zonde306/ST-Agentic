import {
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    isPlainRecord,
    normalizeFileMap,
    normalizePreset,
} from '../config';
import type {
    EmbeddedFilesPayload,
    EmbeddedPresetsPayload,
    MigrationReport,
    Preset,
} from '../types';
import { migrateLegacyPreset } from './legacy-cg';
import { createEmptyMigrationReport } from './prompts';

export const EMBED_KEY_AGENTIC_PRESETS = 'agentic_embed_presets';
export const EMBED_KEY_AGENTIC_FILES = 'agentic_embed_files';
export const EMBED_KEY_LEGACY_PRESETS = 'cg_embed_presets';
export const EMBED_KEY_LEGACY_FILES = 'cg_embed_files';

export interface EmbeddedCharacterMigrationResult {
    presetsPayload: EmbeddedPresetsPayload | null;
    filesPayload: EmbeddedFilesPayload | null;
    fromLegacy: boolean;
    hasPresets: boolean;
    hasFiles: boolean;
    report: MigrationReport;
}

function unwrapCharacterExtensions(raw: unknown): Record<string, unknown> {
    if (!isPlainRecord(raw)) {
        return {};
    }
    // Accept either `character.data.extensions` directly or a full character card object.
    if (isPlainRecord(raw.data) && isPlainRecord(raw.data.extensions)) {
        return raw.data.extensions;
    }
    if (isPlainRecord(raw.extensions)) {
        return raw.extensions;
    }
    return raw;
}

function extractPresetArray(raw: unknown): unknown[] {
    if (Array.isArray(raw)) {
        return raw;
    }
    if (isPlainRecord(raw) && Array.isArray(raw.presets)) {
        return raw.presets;
    }
    return [];
}

function extractRawFileMap(raw: unknown): Record<string, string> {
    if (!isPlainRecord(raw)) {
        return {};
    }
    const candidate = isPlainRecord(raw.files) ? raw.files : raw;
    return normalizeFileMap(candidate);
}

/**
 * Dual-read converter for embedded character card payloads:
 * reads `agentic_embed_presets` / `agentic_embed_files` when present, falling back to
 * legacy `cg_embed_presets` / `cg_embed_files` and upgrading them seamlessly.
 */
export function migrateEmbeddedCharacterData(rawExtensions: unknown): EmbeddedCharacterMigrationResult {
    const ext = unwrapCharacterExtensions(rawExtensions);
    const report = createEmptyMigrationReport('cg_embed');

    let presetsPayload: EmbeddedPresetsPayload | null = null;
    let filesPayload: EmbeddedFilesPayload | null = null;
    let fromLegacyPresets = false;
    let fromLegacyFiles = false;

    const agenticPresetsRaw = extractPresetArray(ext[EMBED_KEY_AGENTIC_PRESETS]);
    const legacyPresetsRaw = extractPresetArray(ext[EMBED_KEY_LEGACY_PRESETS]);

    if (agenticPresetsRaw.length > 0) {
        const presets = agenticPresetsRaw
            .filter(isPlainRecord)
            .map((entry, idx) => normalizePreset(entry, `card_preset_${idx + 1}`));
        if (presets.length > 0) {
            presetsPayload = { version: 1, presets };
            report.migratedPresets += presets.length;
            presets.forEach((p) => {
                report.migratedAgents += Object.keys(p.agents).length;
                report.migratedTriggers += p.triggers.length;
                report.migratedRegexRules += p.regexRules.length;
                report.migratedFiles += Object.keys(p.files).length;
                Object.values(p.agents).forEach((agent) => {
                    report.migratedPromptBlocks += agent.promptBlocks.length;
                });
            });
        }
    } else if (legacyPresetsRaw.length > 0) {
        const presets = legacyPresetsRaw
            .filter(isPlainRecord)
            .map((entry, idx) => migrateLegacyPreset(entry, `Card Preset ${idx + 1}`, report));
        if (presets.length > 0) {
            presetsPayload = { version: 1, presets };
            fromLegacyPresets = true;
        }
    }

    const agenticFiles = extractRawFileMap(ext[EMBED_KEY_AGENTIC_FILES]);
    const legacyFiles = extractRawFileMap(ext[EMBED_KEY_LEGACY_FILES]);

    if (Object.keys(agenticFiles).length > 0) {
        filesPayload = { version: 1, files: agenticFiles };
        report.migratedFiles += Object.keys(agenticFiles).length;
    } else if (Object.keys(legacyFiles).length > 0) {
        filesPayload = { version: 1, files: legacyFiles };
        report.migratedFiles += Object.keys(legacyFiles).length;
        fromLegacyFiles = true;
    }

    const fromLegacy = fromLegacyPresets || fromLegacyFiles;
    report.sourceFormat = fromLegacy ? 'cg_embed' : 'unknown';
    const hasPresets = Boolean(presetsPayload && presetsPayload.presets.length > 0);
    const hasFiles = Boolean(filesPayload && Object.keys(filesPayload.files).length > 0);

    return {
        presetsPayload,
        filesPayload,
        fromLegacy,
        hasPresets,
        hasFiles,
        report,
    };
}

/** Build a normalized versioned `agentic_embed_presets` payload ready to write to a character card. */
export function createEmbeddedPresetsPayload(presets: readonly Preset[]): EmbeddedPresetsPayload {
    return {
        version: 1,
        presets: presets.map((preset, idx) => normalizePreset(preset, `card_preset_${idx + 1}`)),
    };
}

/** Build a normalized versioned `agentic_embed_files` payload enforcing PNG chunk size safety. */
export function createEmbeddedFilesPayload(
    files: Record<string, string>,
    maxBytes: number = DEFAULT_FILE_MAP_SIZE_LIMIT,
): EmbeddedFilesPayload {
    return {
        version: 1,
        files: normalizeFileMap(files, { maxBytes, throwOnLimit: true }),
    };
}
