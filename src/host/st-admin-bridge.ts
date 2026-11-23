import {
    characters,
    deleteCharacter,
    getCharacters,
    getRequestHeaders,
    saveSettingsDebounced,
    selectCharacterById as stSelectCharacterById,
} from '@st/script.js';
import { extension_settings } from '@st/scripts/extensions.js';
import {
    SCRIPT_TYPES,
    getScriptsByType,
    saveScriptsByType,
} from '@st/scripts/extensions/regex/engine.js';
import { setUserAvatar, user_avatar } from '@st/scripts/personas.js';
import { power_user } from '@st/scripts/power-user.js';
import { getPresetManager } from '@st/scripts/preset-manager.js';
import {
    createNewWorldInfo,
    loadWorldInfo,
    onWorldInfoChange,
    saveWorldInfo,
    selected_world_info,
    updateWorldInfoList,
    world_info,
    world_names,
} from '@st/scripts/world-info.js';

import type { HostAdminBridge } from '@/core/bridge';
import type {
    HostCharacterCreatePayload,
    HostCharacterFull,
    HostCharacterPatch,
    HostCharacterSummary,
    HostImportUrlResult,
    HostPersonaEntry,
    HostPresetInfo,
    HostRegexScript,
    HostSettingsScope,
    RawLoreEntry,
    WorldInfoBookSnapshot,
} from '@/core/types';

import { executeStSlashCommand } from './slash-bridge';
import {
    buildCharacterFullSnapshot,
    convertRawStLoreEntry,
    normalizeStRegexScripts,
    patchStCharacterById,
    resolveStCharacterById,
} from './st-author-bridge';

export interface STAdminBridgeOptions {
    executeSlashCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
    getExecuteSlashCommand?: () => ((command: string, signal?: AbortSignal) => Promise<string>) | undefined;
}

interface PresetManagerLike {
    apiId?: string;
    getAllPresets?: () => string[];
    findPreset?: (name: string) => unknown;
    getSelectedPresetName?: () => string;
    selectPreset?: (value: unknown) => Promise<void> | void;
    savePreset?: (name: string, settings: Record<string, unknown>, opts?: { skipUpdate?: boolean }) => Promise<void> | void;
    getCompletionPresetByName?: (name: string) => Record<string, unknown> | undefined;
    getPresetSettings?: (name: string) => Record<string, unknown> | undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneValue<T>(value: T): T {
    if (value === undefined || value === null || typeof value !== 'object') {
        return value;
    }
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

function parseContentDispositionName(header: string | null): string | undefined {
    if (!header) {
        return undefined;
    }
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (utf8Match?.[1]) {
        try {
            return decodeURIComponent(utf8Match[1].trim());
        } catch {
            return utf8Match[1].trim();
        }
    }
    const plainMatch = /filename="?([^";]+)"?/i.exec(header);
    return plainMatch?.[1]?.trim() || undefined;
}

function inferImportedType(
    headerType: string | null,
    name: string,
    url: string,
): HostImportUrlResult['importedType'] {
    const normalizedHeader = (headerType ?? '').toLowerCase();
    if (normalizedHeader.includes('character') || normalizedHeader.includes('card')) {
        return 'character';
    }
    if (normalizedHeader.includes('lore') || normalizedHeader.includes('world')) {
        return 'worldinfo';
    }
    if (normalizedHeader.includes('preset')) {
        return 'preset';
    }

    const lower = `${name} ${url}`.toLowerCase();
    if (lower.includes('.png') || lower.includes('.charx') || lower.includes('character')) {
        return 'character';
    }
    if (lower.includes('lorebook') || lower.includes('world')) {
        return 'worldinfo';
    }
    if (lower.includes('preset')) {
        return 'preset';
    }
    return 'unknown';
}

function parseNumericUid(rawUid: unknown, fallback: number): number {
    if (typeof rawUid === 'number' && Number.isFinite(rawUid)) {
        return Math.floor(rawUid);
    }
    if (typeof rawUid === 'string') {
        const parsed = Number.parseInt(rawUid, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}

/**
 * SillyTavern host implementation of `HostAdminBridge`.
 * Only invoked by the Assistant runtime when `mode === 'full'` AND `stAdminEnabled === true`.
 */
export class STAdminBridge implements HostAdminBridge {
    private readonly slashExecutor?: (command: string, signal?: AbortSignal) => Promise<string>;
    private readonly getSlashExecutor?: () =>
        | ((command: string, signal?: AbortSignal) => Promise<string>)
        | undefined;

    constructor(options: STAdminBridgeOptions = {}) {
        this.slashExecutor = options.executeSlashCommand;
        this.getSlashExecutor = options.getExecuteSlashCommand;
    }

    // ------------------------------------------------------------------------
    // 1. Global World Info management
    // ------------------------------------------------------------------------

    async listAllWorldNames(): Promise<string[]> {
        if ((!Array.isArray(world_names) || world_names.length === 0) && typeof updateWorldInfoList === 'function') {
            try {
                await updateWorldInfoList();
            } catch {
                // Ignore refresh errors when ST WI UI is not mounted.
            }
        }

        const names = new Set<string>();
        if (Array.isArray(world_names)) {
            for (const name of world_names) {
                if (typeof name === 'string' && name.trim()) {
                    names.add(name.trim());
                }
            }
        }
        if (Array.isArray(selected_world_info)) {
            for (const name of selected_world_info) {
                if (typeof name === 'string' && name.trim()) {
                    names.add(name.trim());
                }
            }
        }
        return Array.from(names).sort();
    }

    async createWorldBook(name: string): Promise<WorldInfoBookSnapshot> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error('World Info book name must not be empty');
        }

        const existing = (await loadWorldInfo(trimmed).catch(() => null)) as
            | { entries?: Record<string, unknown> | unknown[] }
            | null
            | undefined;
        if (existing?.entries) {
            const entries: RawLoreEntry[] = Array.isArray(existing.entries)
                ? existing.entries.map((item, idx) => convertRawStLoreEntry(trimmed, item, idx))
                : Object.entries(existing.entries).map(([k, item], idx) =>
                      convertRawStLoreEntry(trimmed, item, parseNumericUid(k, idx)),
                  );
            return { name: trimmed, entries };
        }

        if (typeof createNewWorldInfo === 'function') {
            await createNewWorldInfo(trimmed, { interactive: false });
        } else {
            await saveWorldInfo(trimmed, { entries: {} }, true);
        }

        if (Array.isArray(world_names) && !world_names.includes(trimmed)) {
            world_names.push(trimmed);
        }

        return {
            name: trimmed,
            entries: [],
        };
    }

    async bindWorldBook(name: string, enabled: boolean): Promise<void> {
        const trimmed = name.trim();
        if (!trimmed) {
            throw new Error('World Info book name must not be empty');
        }

        if (Array.isArray(selected_world_info)) {
            const idx = selected_world_info.indexOf(trimmed);
            if (enabled && idx < 0) {
                selected_world_info.push(trimmed);
            } else if (!enabled && idx >= 0) {
                selected_world_info.splice(idx, 1);
            }
        }

        if (isPlainRecord(world_info)) {
            const globalSelect = Array.isArray(world_info.globalSelect)
                ? (world_info.globalSelect as string[])
                : null;
            if (globalSelect) {
                const idx = globalSelect.indexOf(trimmed);
                if (enabled && idx < 0) {
                    globalSelect.push(trimmed);
                } else if (!enabled && idx >= 0) {
                    globalSelect.splice(idx, 1);
                }
            }
        }

        saveSettingsDebounced();

        if (typeof onWorldInfoChange === 'function') {
            try {
                onWorldInfoChange(undefined, undefined);
            } catch {
                // Ignore UI-only update errors when WI panel is not rendered.
            }
        }
    }

    // ------------------------------------------------------------------------
    // 2. Global Character Library CRUD & selection
    // ------------------------------------------------------------------------

    async listAllCharacters(): Promise<HostCharacterSummary[]> {
        if (!Array.isArray(characters)) {
            return [];
        }
        const summaries: HostCharacterSummary[] = [];
        characters.forEach((raw, idx) => {
            if (!isPlainRecord(raw)) {
                return;
            }
            const full = buildCharacterFullSnapshot(idx, raw);
            summaries.push({
                chid: full.chid,
                name: full.name,
                avatar: full.avatar,
                ...(full.description !== undefined ? { description: full.description } : {}),
                ...(full.tags !== undefined ? { tags: [...full.tags] } : {}),
                ...(full.primaryWorld !== undefined ? { primaryWorld: full.primaryWorld } : {}),
            });
        });
        return summaries;
    }

    async readCharacterById(chid: number): Promise<HostCharacterFull | null> {
        const resolved = resolveStCharacterById(chid);
        if (!resolved) {
            return null;
        }
        return buildCharacterFullSnapshot(resolved.chid, resolved.character);
    }

    async createCharacter(payload: HostCharacterCreatePayload): Promise<HostCharacterFull> {
        const charName = typeof payload.name === 'string' ? payload.name.trim() : '';
        if (!charName) {
            throw new Error('Character name is required');
        }

        const formData = new FormData();
        formData.append('ch_name', charName);
        if (payload.description !== undefined) formData.append('description', payload.description);
        if (payload.personality !== undefined) formData.append('personality', payload.personality);
        if (payload.scenario !== undefined) formData.append('scenario', payload.scenario);
        if (payload.first_mes !== undefined) formData.append('first_mes', payload.first_mes);
        if (payload.mes_example !== undefined) formData.append('mes_example', payload.mes_example);
        if (payload.creator_notes !== undefined) formData.append('creator_notes', payload.creator_notes);
        if (payload.system_prompt !== undefined) formData.append('system_prompt', payload.system_prompt);
        if (payload.post_history_instructions !== undefined) {
            formData.append('post_history_instructions', payload.post_history_instructions);
        }
        if (Array.isArray(payload.tags)) {
            formData.append('tags', payload.tags.join(', '));
        }
        if (Array.isArray(payload.alternate_greetings)) {
            for (const greeting of payload.alternate_greetings) {
                formData.append('alternate_greetings', greeting);
            }
        }
        formData.append('extensions', JSON.stringify(payload.extensions ?? {}));

        const headers =
            typeof getRequestHeaders === 'function'
                ? getRequestHeaders({ omitContentType: true })
                : {};

        const response = await fetch('/api/characters/create', {
            method: 'POST',
            headers,
            body: formData,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(
                `Failed to create character "${charName}" (${response.status}): ${errText || response.statusText}`,
            );
        }

        let createdAvatar = '';
        try {
            const rawBody = (await response.text()).trim();
            if (rawBody.startsWith('{')) {
                const parsed = JSON.parse(rawBody) as { avatar?: unknown; file_name?: unknown };
                if (typeof parsed.avatar === 'string') {
                    createdAvatar = parsed.avatar;
                } else if (typeof parsed.file_name === 'string') {
                    createdAvatar = parsed.file_name;
                }
            } else if (rawBody) {
                createdAvatar = rawBody.replace(/^"|"$/g, '');
            }
        } catch {
            // Keep empty avatar when response has no body.
        }

        if (typeof getCharacters === 'function') {
            await getCharacters();
        }

        if (Array.isArray(characters)) {
            for (let i = characters.length - 1; i >= 0; i--) {
                const item = characters[i];
                if (!isPlainRecord(item)) {
                    continue;
                }
                const matchesAvatar = createdAvatar && item.avatar === createdAvatar;
                const matchesName = !createdAvatar && item.name === charName;
                if (matchesAvatar || matchesName) {
                    return buildCharacterFullSnapshot(i, item);
                }
            }
        }

        const fallbackAvatar = createdAvatar || `${charName.replace(/\s+/g, '_')}.png`;
        return {
            chid: Array.isArray(characters) ? characters.length : 0,
            name: charName,
            avatar: fallbackAvatar,
            ...(payload.description !== undefined ? { description: payload.description } : {}),
            ...(payload.personality !== undefined ? { personality: payload.personality } : {}),
            ...(payload.scenario !== undefined ? { scenario: payload.scenario } : {}),
            ...(payload.first_mes !== undefined ? { first_mes: payload.first_mes } : {}),
            ...(payload.mes_example !== undefined ? { mes_example: payload.mes_example } : {}),
            ...(payload.creator_notes !== undefined ? { creator_notes: payload.creator_notes } : {}),
            ...(payload.system_prompt !== undefined ? { system_prompt: payload.system_prompt } : {}),
            ...(payload.post_history_instructions !== undefined
                ? { post_history_instructions: payload.post_history_instructions }
                : {}),
            ...(payload.alternate_greetings !== undefined
                ? { alternate_greetings: [...payload.alternate_greetings] }
                : {}),
            ...(payload.tags !== undefined ? { tags: [...payload.tags] } : {}),
            extensions: cloneValue(payload.extensions ?? {}),
            data: {
                name: charName,
                description: payload.description ?? '',
                personality: payload.personality ?? '',
                scenario: payload.scenario ?? '',
                extensions: cloneValue(payload.extensions ?? {}),
            },
        };
    }

    async patchCharacterById(
        chid: number,
        fields: HostCharacterPatch,
    ): Promise<HostCharacterFull> {
        return patchStCharacterById(chid, fields);
    }

    async deleteCharacterById(chid: number): Promise<boolean> {
        const resolved = resolveStCharacterById(chid);
        if (!resolved) {
            return false;
        }
        const avatar = typeof resolved.character.avatar === 'string' ? resolved.character.avatar : '';
        if (!avatar) {
            return false;
        }

        if (typeof deleteCharacter === 'function') {
            await deleteCharacter(avatar, { deleteChats: false });
            return true;
        }

        const headers =
            typeof getRequestHeaders === 'function'
                ? getRequestHeaders()
                : { 'Content-Type': 'application/json' };
        const response = await fetch('/api/characters/delete', {
            method: 'POST',
            headers,
            body: JSON.stringify({ avatar_url: avatar, delete_chats: false }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            throw new Error(
                `Failed to delete character "${avatar}" (${response.status}): ${errText || response.statusText}`,
            );
        }

        if (typeof getCharacters === 'function') {
            await getCharacters();
        }
        return true;
    }

    async selectCharacterById(chid: number): Promise<void> {
        const resolved = resolveStCharacterById(chid);
        if (!resolved) {
            throw new Error(`Character not found (chid=${chid})`);
        }
        if (typeof stSelectCharacterById !== 'function') {
            throw new Error('SillyTavern selectCharacterById is unavailable');
        }
        await stSelectCharacterById(resolved.chid);
    }

    // ------------------------------------------------------------------------
    // 3. Personas & Presets
    // ------------------------------------------------------------------------

    async listPersonas(): Promise<HostPersonaEntry[]> {
        const pu = (isPlainRecord(power_user) ? power_user : {}) as Record<string, unknown>;
        const personasMap = isPlainRecord(pu.personas)
            ? (pu.personas as Record<string, unknown>)
            : {};
        const descriptionsMap = isPlainRecord(pu.persona_descriptions)
            ? (pu.persona_descriptions as Record<string, unknown>)
            : {};

        const activeKey = typeof user_avatar === 'string' ? user_avatar : '';
        const keys = new Set<string>([
            ...Object.keys(personasMap),
            ...Object.keys(descriptionsMap),
        ]);
        if (activeKey && !keys.has(activeKey)) {
            keys.add(activeKey);
        }

        const list: HostPersonaEntry[] = [];
        for (const key of Array.from(keys).sort()) {
            const descRec = isPlainRecord(descriptionsMap[key])
                ? (descriptionsMap[key] as Record<string, unknown>)
                : undefined;
            const nameVal =
                typeof personasMap[key] === 'string' && (personasMap[key] as string).trim()
                    ? (personasMap[key] as string)
                    : key.replace(/\.[^/.]+$/, '');
            const titleVal = typeof descRec?.title === 'string' ? descRec.title : undefined;
            const descriptionVal =
                typeof descRec?.description === 'string'
                    ? descRec.description
                    : key === activeKey && typeof pu.persona_description === 'string'
                        ? pu.persona_description
                        : '';

            list.push({
                key,
                name: nameVal,
                ...(titleVal !== undefined ? { title: titleVal } : {}),
                description: descriptionVal,
                active: key === activeKey,
            });
        }
        return list;
    }

    async upsertPersona(key: string, desc: string, title?: string): Promise<HostPersonaEntry> {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
            throw new Error('Persona key must not be empty');
        }

        const pu = power_user as unknown as Record<string, unknown>;
        if (!isPlainRecord(pu.personas)) {
            pu.personas = {};
        }
        if (!isPlainRecord(pu.persona_descriptions)) {
            pu.persona_descriptions = {};
        }

        const personasMap = pu.personas as Record<string, unknown>;
        const descriptionsMap = pu.persona_descriptions as Record<string, unknown>;

        const existingName =
            typeof personasMap[trimmedKey] === 'string' ? (personasMap[trimmedKey] as string) : '';
        const resolvedName = title?.trim() || existingName || trimmedKey.replace(/\.[^/.]+$/, '');
        personasMap[trimmedKey] = resolvedName;

        const existingDesc = isPlainRecord(descriptionsMap[trimmedKey])
            ? (descriptionsMap[trimmedKey] as Record<string, unknown>)
            : {};
        descriptionsMap[trimmedKey] = {
            ...existingDesc,
            description: desc,
            ...(title !== undefined ? { title } : {}),
        };

        const isActive = typeof user_avatar === 'string' && user_avatar === trimmedKey;
        if (isActive) {
            pu.persona_description = desc;
        }

        saveSettingsDebounced();

        return {
            key: trimmedKey,
            name: resolvedName,
            ...(title !== undefined
                ? { title }
                : typeof existingDesc.title === 'string'
                    ? { title: existingDesc.title }
                    : {}),
            description: desc,
            active: isActive,
        };
    }

    async selectPersona(key: string): Promise<void> {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
            throw new Error('Persona key must not be empty');
        }

        if (typeof setUserAvatar === 'function') {
            await setUserAvatar(trimmedKey, { toastPersonaNameChange: false });
        }

        const pu = (isPlainRecord(power_user) ? power_user : {}) as Record<string, unknown>;
        const descriptionsMap = isPlainRecord(pu.persona_descriptions)
            ? (pu.persona_descriptions as Record<string, unknown>)
            : {};
        const descRec = isPlainRecord(descriptionsMap[trimmedKey])
            ? (descriptionsMap[trimmedKey] as Record<string, unknown>)
            : undefined;
        if (typeof descRec?.description === 'string') {
            pu.persona_description = descRec.description;
        }
        saveSettingsDebounced();
    }

    async listPresets(apiType?: string): Promise<HostPresetInfo[]> {
        if (typeof getPresetManager !== 'function') {
            return [];
        }
        const pm = getPresetManager(apiType ?? '') as PresetManagerLike | null | undefined;
        if (!pm) {
            return [];
        }

        const names = typeof pm.getAllPresets === 'function' ? pm.getAllPresets() : [];
        const selected = typeof pm.getSelectedPresetName === 'function' ? pm.getSelectedPresetName() : '';
        const resolvedApiType = apiType || pm.apiId || '';

        return names.map((name) => {
            let data: Record<string, unknown> | undefined;
            try {
                const raw = pm.getCompletionPresetByName?.(name);
                if (isPlainRecord(raw)) {
                    data = cloneValue(raw);
                }
            } catch {
                // Omit preset body when unavailable for this API type.
            }
            return {
                name,
                apiType: resolvedApiType,
                active: name === selected,
                ...(data !== undefined ? { data } : {}),
            };
        });
    }

    async selectPreset(name: string, apiType?: string): Promise<void> {
        if (typeof getPresetManager !== 'function') {
            throw new Error('SillyTavern getPresetManager is unavailable');
        }
        const pm = getPresetManager(apiType ?? '') as PresetManagerLike | null | undefined;
        if (!pm || typeof pm.selectPreset !== 'function') {
            throw new Error(`PresetManager unavailable for apiType="${apiType ?? ''}"`);
        }

        const value = typeof pm.findPreset === 'function' ? pm.findPreset(name) : name;
        if (value === undefined || value === null || value === '') {
            throw new Error(`Preset not found: "${name}"`);
        }
        await pm.selectPreset(value);
    }

    async patchPreset(
        name: string,
        patch: Record<string, unknown>,
        apiType?: string,
    ): Promise<HostPresetInfo> {
        if (typeof getPresetManager !== 'function') {
            throw new Error('SillyTavern getPresetManager is unavailable');
        }
        const pm = getPresetManager(apiType ?? '') as PresetManagerLike | null | undefined;
        if (!pm || typeof pm.savePreset !== 'function') {
            throw new Error(`PresetManager unavailable for apiType="${apiType ?? ''}"`);
        }

        const existingRaw =
            pm.getCompletionPresetByName?.(name) ?? pm.getPresetSettings?.(name) ?? {};
        const merged: Record<string, unknown> = {
            ...(isPlainRecord(existingRaw) ? cloneValue(existingRaw) : {}),
            ...cloneValue(patch),
        };

        await pm.savePreset(name, merged);

        const resolvedApiType = apiType || pm.apiId || '';
        const selected = typeof pm.getSelectedPresetName === 'function' ? pm.getSelectedPresetName() : '';

        return {
            name,
            apiType: resolvedApiType,
            active: name === selected,
            data: merged,
        };
    }

    // ------------------------------------------------------------------------
    // 4. Global Settings, Global Regex, Slash Exec & URL Import
    // ------------------------------------------------------------------------

    async readHostSettings(scope: HostSettingsScope): Promise<Record<string, unknown>> {
        const pu = isPlainRecord(power_user) ? power_user : {};
        const ext = isPlainRecord(extension_settings) ? extension_settings : {};

        if (scope === 'all') {
            return {
                power_user: cloneValue(pu),
                extension_settings: cloneValue(ext),
            };
        }
        if (scope === 'power_user') {
            return cloneValue(pu);
        }
        if (scope === 'extension_settings') {
            return cloneValue(ext);
        }

        const bucket = (ext as Record<string, unknown>)[scope];
        if (bucket === undefined) {
            return {};
        }
        return isPlainRecord(bucket) ? cloneValue(bucket) : { value: cloneValue(bucket) };
    }

    async patchHostSettings(
        scope: HostSettingsScope,
        patch: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const pu = power_user as unknown as Record<string, unknown>;
        const ext = extension_settings as unknown as Record<string, unknown>;

        if (scope === 'all') {
            if (isPlainRecord(patch.power_user)) {
                Object.assign(pu, cloneValue(patch.power_user));
            }
            if (isPlainRecord(patch.extension_settings)) {
                Object.assign(ext, cloneValue(patch.extension_settings));
            }
            saveSettingsDebounced();
            return this.readHostSettings('all');
        }

        if (scope === 'power_user') {
            Object.assign(pu, cloneValue(patch));
            saveSettingsDebounced();
            return cloneValue(pu);
        }

        if (scope === 'extension_settings') {
            Object.assign(ext, cloneValue(patch));
            saveSettingsDebounced();
            return cloneValue(ext);
        }

        const current = isPlainRecord(ext[scope]) ? (ext[scope] as Record<string, unknown>) : {};
        const next = {
            ...current,
            ...cloneValue(patch),
        };
        ext[scope] = next;
        saveSettingsDebounced();
        return cloneValue(next);
    }

    async listGlobalRegex(): Promise<HostRegexScript[]> {
        if (typeof getScriptsByType === 'function' && SCRIPT_TYPES?.GLOBAL !== undefined) {
            try {
                const scripts = getScriptsByType(SCRIPT_TYPES.GLOBAL);
                if (Array.isArray(scripts)) {
                    return cloneValue(scripts as HostRegexScript[]);
                }
            } catch {
                // Fall back to direct extension_settings.regex read.
            }
        }
        const ext = extension_settings as Record<string, unknown>;
        return Array.isArray(ext?.regex) ? cloneValue(ext.regex as HostRegexScript[]) : [];
    }

    async saveGlobalRegex(scripts: HostRegexScript[]): Promise<void> {
        const normalized = normalizeStRegexScripts(scripts);
        if (typeof saveScriptsByType === 'function' && SCRIPT_TYPES?.GLOBAL !== undefined) {
            await saveScriptsByType(
                normalized as unknown as Parameters<typeof saveScriptsByType>[0],
                SCRIPT_TYPES.GLOBAL,
            );
            return;
        }
        const ext = extension_settings as Record<string, unknown>;
        ext.regex = normalized;
        saveSettingsDebounced();
    }

    /** Reuse ST slash command execution bridge (`executeStSlashCommand`). */
    async executeSlashCommand(command: string, signal?: AbortSignal): Promise<string> {
        const dynamicExecutor = this.getSlashExecutor?.();
        if (dynamicExecutor) {
            return dynamicExecutor(command, signal);
        }
        if (this.slashExecutor) {
            return this.slashExecutor(command, signal);
        }
        return executeStSlashCommand(command, signal);
    }

    async importFromUrl(url: string): Promise<HostImportUrlResult> {
        const trimmedUrl = url.trim();
        if (!trimmedUrl) {
            return {
                ok: false,
                url,
                importedType: 'unknown',
                detail: 'Import URL must not be empty',
            };
        }

        const headers =
            typeof getRequestHeaders === 'function'
                ? getRequestHeaders()
                : { 'Content-Type': 'application/json' };

        const response = await fetch('/api/content/importURL', {
            method: 'POST',
            headers,
            body: JSON.stringify({ url: trimmedUrl }),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => response.statusText);
            return {
                ok: false,
                url: trimmedUrl,
                importedType: 'unknown',
                detail: errText || `HTTP ${response.status} ${response.statusText}`,
            };
        }

        const contentTypeHeader = response.headers?.get?.('X-Custom-Content-Type') ?? null;
        const dispositionHeader = response.headers?.get?.('Content-Disposition') ?? null;
        const urlFallbackName = trimmedUrl.split('/').pop()?.split('?')[0] || 'imported-resource';
        const name = parseContentDispositionName(dispositionHeader) ?? urlFallbackName;
        const importedType = inferImportedType(contentTypeHeader, name, trimmedUrl);

        return {
            ok: true,
            url: trimmedUrl,
            importedType,
            name,
            detail: `Imported ${importedType} "${name}" from ${trimmedUrl}`,
        };
    }
}
