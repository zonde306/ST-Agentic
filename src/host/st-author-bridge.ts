import {
    characters,
    chat,
    chat_metadata,
    getRequestHeaders,
    saveChatDebounced,
    this_chid,
    updateMessageBlock,
} from '@st/script.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import {
    SCRIPT_TYPES,
    getScriptsByType,
    saveScriptsByType,
} from '@st/scripts/extensions/regex/engine.js';
import {
    createWorldInfoEntry,
    deleteWorldInfoEntry as stDeleteWorldInfoEntry,
    loadWorldInfo,
    reloadEditor,
    saveWorldInfo,
} from '@st/scripts/world-info.js';

import type { HostAuthorBridge } from '@/core/bridge';
import { resolveActivePreset } from '@/core/config';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import type {
    AuthorUndoMeta,
    EmbedAgenticOptions,
    EmbedAgenticResult,
    HostCharacterFull,
    HostCharacterPatch,
    HostRegexScript,
    RawLoreEntry,
    Settings,
    UpsertWorldInfoEntryOptions,
    WorldInfoBookSnapshot,
    WorldInfoEntryUpsert,
} from '@/core/types';

import { embedFilesToCard, embedPresetToCard } from './embed-card';

export interface STAuthorBridgeOptions {
    getSettings?: () => Settings | undefined;
    getStore?: () => ChatDataStore | undefined;
}

interface RawStWorldInfoEntry {
    uid?: number | string;
    key?: string[] | string;
    keys?: string[] | string;
    keysecondary?: string[] | string;
    secondaryKeys?: string[] | string;
    comment?: string;
    content?: string;
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: number;
    addMemo?: boolean;
    order?: number;
    position?: number;
    depth?: number;
    role?: number;
    disable?: boolean;
    enabled?: boolean;
    probability?: number;
    useProbability?: boolean;
    scanDepth?: number | null;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | number | null;
    group?: string;
    groupOverride?: boolean;
    groupWeight?: number;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

interface RawStWorldInfoBook {
    entries?: Record<string, RawStWorldInfoEntry> | RawStWorldInfoEntry[];
    [key: string]: unknown;
}

const FORM_CREATE_SELECTOR = '#form_create';

const V1_MIRROR_FIELDS = new Set([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'tags',
    'chat',
]);

const V2_DATA_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
    'system_prompt',
    'post_history_instructions',
    'alternate_greetings',
    'tags',
    'creator',
    'character_version',
] as const;

const FORM_FIELD_MAPPING: ReadonlyArray<readonly [key: string, selectors: readonly string[]]> = [
    ['name', ['[name="ch_name"]', '#character_name_pole']],
    ['description', ['[name="description"]', '#description_textarea']],
    ['personality', ['[name="personality"]', '#personality_textarea']],
    ['scenario', ['[name="scenario"]', '#scenario_pole']],
    ['first_mes', ['[name="first_mes"]', '#firstmessage_textarea']],
    ['mes_example', ['[name="mes_example"]', '#mes_example_textarea']],
    ['creator_notes', ['[name="creator_notes"]', '#creator_notes_textarea']],
    ['system_prompt', ['[name="system_prompt"]', '#system_prompt_textarea']],
    [
        'post_history_instructions',
        ['[name="post_history_instructions"]', '#post_history_instructions_textarea'],
    ],
    ['creator', ['[name="creator"]', '#creator_textarea']],
    ['character_version', ['[name="character_version"]', '#character_version_textarea']],
];

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

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'string' || !raw.trim()) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function normalizeStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => (typeof item === 'string' ? item.trim() : String(item ?? '').trim()))
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }
    return [];
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

function pickOptionalString(...candidates: unknown[]): string | undefined {
    for (const candidate of candidates) {
        if (typeof candidate === 'string') {
            return candidate;
        }
    }
    return undefined;
}

/**
 * Resolve a character entry from SillyTavern's live `characters[]` list by index.
 */
export function resolveStCharacterById(
    chid: number | string | undefined,
): { chid: number; character: Record<string, unknown> } | null {
    if (chid === undefined || chid === null || chid === '') {
        return null;
    }
    const index = Number(chid);
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(characters) || index >= characters.length) {
        return null;
    }
    const character = characters[index];
    if (!isPlainRecord(character)) {
        return null;
    }
    return { chid: index, character };
}

/**
 * Convert a live SillyTavern character object into a full `HostCharacterFull` snapshot.
 */
export function buildCharacterFullSnapshot(
    chid: number,
    rawCharacter: Record<string, unknown>,
): HostCharacterFull {
    const v2 = isPlainRecord(rawCharacter.data) ? rawCharacter.data : {};
    const v2Extensions = isPlainRecord(v2.extensions) ? v2.extensions : {};
    const topExtensions = isPlainRecord(rawCharacter.extensions) ? rawCharacter.extensions : {};
    const mergedExtensions: Record<string, unknown> = {
        ...cloneValue(topExtensions),
        ...cloneValue(v2Extensions),
    };

    const name = pickOptionalString(v2.name, rawCharacter.name) ?? '';
    const avatar = typeof rawCharacter.avatar === 'string' ? rawCharacter.avatar : '';
    const description = pickOptionalString(v2.description, rawCharacter.description);
    const personality = pickOptionalString(v2.personality, rawCharacter.personality);
    const scenario = pickOptionalString(v2.scenario, rawCharacter.scenario);
    const firstMes = pickOptionalString(v2.first_mes, rawCharacter.first_mes);
    const mesExample = pickOptionalString(v2.mes_example, rawCharacter.mes_example);
    const creatorNotes = pickOptionalString(v2.creator_notes, rawCharacter.creatorcomment);
    const systemPrompt = pickOptionalString(v2.system_prompt);
    const postHistory = pickOptionalString(v2.post_history_instructions);
    const creator = pickOptionalString(v2.creator);
    const characterVersion = pickOptionalString(v2.character_version);

    const rawTags = Array.isArray(v2.tags)
        ? v2.tags
        : Array.isArray(rawCharacter.tags)
            ? rawCharacter.tags
            : undefined;
    const tags = rawTags ? rawTags.map((item) => String(item)) : undefined;

    const rawAltGreetings = Array.isArray(v2.alternate_greetings)
        ? v2.alternate_greetings
        : Array.isArray(rawCharacter.alternate_greetings)
            ? rawCharacter.alternate_greetings
            : undefined;
    const alternateGreetings = rawAltGreetings
        ? rawAltGreetings.map((item) => String(item))
        : undefined;

    const primaryWorld =
        typeof mergedExtensions.world === 'string' && mergedExtensions.world.trim()
            ? mergedExtensions.world.trim()
            : undefined;

    return {
        chid,
        name,
        avatar,
        ...(description !== undefined ? { description } : {}),
        ...(personality !== undefined ? { personality } : {}),
        ...(scenario !== undefined ? { scenario } : {}),
        ...(firstMes !== undefined ? { first_mes: firstMes } : {}),
        ...(mesExample !== undefined ? { mes_example: mesExample } : {}),
        ...(creatorNotes !== undefined ? { creator_notes: creatorNotes } : {}),
        ...(systemPrompt !== undefined ? { system_prompt: systemPrompt } : {}),
        ...(postHistory !== undefined ? { post_history_instructions: postHistory } : {}),
        ...(alternateGreetings !== undefined ? { alternate_greetings: alternateGreetings } : {}),
        ...(tags !== undefined ? { tags } : {}),
        ...(creator !== undefined ? { creator } : {}),
        ...(characterVersion !== undefined ? { character_version: characterVersion } : {}),
        ...(primaryWorld !== undefined ? { primaryWorld } : {}),
        extensions: mergedExtensions,
        data: cloneValue(v2),
    };
}

/**
 * Build a SillyTavern `/api/characters/merge-attributes` request body for a character patch.
 */
export function buildCharacterMergePayload(
    character: Record<string, unknown>,
    fields: HostCharacterPatch,
): Record<string, unknown> {
    const avatar = typeof character.avatar === 'string' ? character.avatar : '';
    const payload: Record<string, unknown> = { avatar };
    const dataPatch: Record<string, unknown> = isPlainRecord(fields.data)
        ? cloneValue(fields.data)
        : {};

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || key === 'data' || key === 'extensions' || key === 'chid' || key === 'avatar') {
            continue;
        }
        if (key === 'creator_notes') {
            payload.creatorcomment = cloneValue(value);
            dataPatch.creator_notes = cloneValue(value);
            continue;
        }
        if (V1_MIRROR_FIELDS.has(key)) {
            payload[key] = cloneValue(value);
        }
        if ((V2_DATA_FIELDS as readonly string[]).includes(key)) {
            dataPatch[key] = cloneValue(value);
        } else if (!V1_MIRROR_FIELDS.has(key)) {
            payload[key] = cloneValue(value);
            dataPatch[key] = cloneValue(value);
        }
    }

    const existingDataExt = isPlainRecord(dataPatch.extensions)
        ? (dataPatch.extensions as Record<string, unknown>)
        : undefined;
    const topExt = isPlainRecord(fields.extensions)
        ? (fields.extensions as Record<string, unknown>)
        : undefined;
    if (existingDataExt || topExt) {
        dataPatch.extensions = {
            ...(existingDataExt ? cloneValue(existingDataExt) : {}),
            ...(topExt ? cloneValue(topExt) : {}),
        };
    }

    if (Object.keys(dataPatch).length > 0) {
        payload.data = dataPatch;
    }

    return payload;
}

/**
 * Synchronize all three SillyTavern character mirrors after a persisted character update:
 * 1) Live top-level `characters[chid]` v1 properties & serialized `characters[chid].json_data`
 * 2) Live nested `characters[chid].data` v2 properties & `data.extensions`
 * 3) Active editor form `#form_create` & chat/UI metadata mirrors
 */
export function syncCharacterThreeWayMirrors(
    chid: number,
    character: Record<string, unknown>,
    fields: HostCharacterPatch,
): void {
    // 1 & 2. Synchronize `characters[chid]` (v1 top-level) and `characters[chid].data` (v2)
    if (!isPlainRecord(character.data)) {
        character.data = {};
    }
    const v2Data = character.data as Record<string, unknown>;
    if (!isPlainRecord(v2Data.extensions)) {
        v2Data.extensions = {};
    }

    const dataPatch = isPlainRecord(fields.data) ? fields.data : undefined;
    if (dataPatch) {
        for (const [key, value] of Object.entries(dataPatch)) {
            if (value === undefined) {
                continue;
            }
            if (key === 'extensions' && isPlainRecord(value)) {
                v2Data.extensions = {
                    ...(v2Data.extensions as Record<string, unknown>),
                    ...cloneValue(value),
                };
            } else {
                v2Data[key] = cloneValue(value);
                if (V1_MIRROR_FIELDS.has(key)) {
                    character[key] = cloneValue(value);
                } else if (key === 'creator_notes') {
                    character.creatorcomment = cloneValue(value);
                }
            }
        }
    }

    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined || key === 'data' || key === 'chid' || key === 'avatar') {
            continue;
        }
        if (key === 'extensions' && isPlainRecord(value)) {
            v2Data.extensions = {
                ...(v2Data.extensions as Record<string, unknown>),
                ...cloneValue(value),
            };
            if (isPlainRecord(character.extensions)) {
                character.extensions = {
                    ...character.extensions,
                    ...cloneValue(value),
                };
            }
            continue;
        }
        if (key === 'creator_notes') {
            character.creatorcomment = cloneValue(value);
            v2Data.creator_notes = cloneValue(value);
            continue;
        }
        if (V1_MIRROR_FIELDS.has(key)) {
            character[key] = cloneValue(value);
        }
        v2Data[key] = cloneValue(value);
    }

    // Keep serialized `character.json_data` mirror synchronized alongside live object.
    const existingJson = parseJsonRecord(character.json_data) ?? {};
    const jsonDataObj = isPlainRecord(existingJson.data)
        ? { ...existingJson.data }
        : {};
    for (const [key, value] of Object.entries(v2Data)) {
        jsonDataObj[key] = cloneValue(value);
    }
    const nextJsonRecord: Record<string, unknown> = {
        ...existingJson,
        ...(typeof character.name === 'string' ? { name: character.name } : {}),
        ...(typeof character.description === 'string' ? { description: character.description } : {}),
        ...(typeof character.personality === 'string' ? { personality: character.personality } : {}),
        ...(typeof character.scenario === 'string' ? { scenario: character.scenario } : {}),
        ...(typeof character.first_mes === 'string' ? { first_mes: character.first_mes } : {}),
        ...(typeof character.mes_example === 'string' ? { mes_example: character.mes_example } : {}),
        ...(typeof character.creatorcomment === 'string'
            ? { creatorcomment: character.creatorcomment }
            : {}),
        data: jsonDataObj,
    };
    character.json_data = JSON.stringify(nextJsonRecord);

    // 3. Synchronize active editor form `#form_create` and chat/UI state mirrors.
    const isActiveChar = Number(this_chid) === chid;
    const charAvatar = typeof character.avatar === 'string' ? character.avatar : '';

    if (typeof document !== 'undefined') {
        const form = document.querySelector<HTMLElement>(FORM_CREATE_SELECTOR);
        if (form) {
            const avatarInput = form.querySelector<HTMLInputElement>('[name="avatar_url"]');
            const formAvatar = avatarInput?.value?.trim() ?? '';
            const matchesForm = (!formAvatar && isActiveChar) || (Boolean(charAvatar) && formAvatar === charAvatar);

            if (matchesForm) {
                for (const [fieldKey, selectors] of FORM_FIELD_MAPPING) {
                    const nextVal = v2Data[fieldKey] ?? character[fieldKey];
                    if (typeof nextVal !== 'string') {
                        continue;
                    }
                    const touched =
                        fieldKey in fields || (dataPatch !== undefined && fieldKey in dataPatch);
                    if (!touched) {
                        continue;
                    }
                    for (const selector of selectors) {
                        const el = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
                        if (el) {
                            el.value = nextVal;
                        }
                    }
                }

                const jsonInput = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
                    '[name="json_data"]',
                );
                if (jsonInput) {
                    jsonInput.value = String(character.json_data);
                }
            }
        }
    }

    if (isActiveChar && isPlainRecord(chat_metadata)) {
        const nextName = typeof v2Data.name === 'string' ? v2Data.name : undefined;
        if (nextName && typeof chat_metadata.character_name === 'string') {
            chat_metadata.character_name = nextName;
        }
        const ext = v2Data.extensions as Record<string, unknown>;
        if (typeof ext.world === 'string' && 'world_info' in chat_metadata && !chat_metadata.world_info) {
            // Leave explicit chat-bound world_info intact; only notify UI listeners.
        }
    }

    const editedEvent = (event_types as Record<string, string | undefined>)?.CHARACTER_EDITED;
    if (editedEvent && typeof eventSource?.emit === 'function') {
        void eventSource.emit(editedEvent, { detail: { id: chid, character } });
    }
}

/**
 * Persist a character patch via ST `/api/characters/merge-attributes` and synchronize all 3 mirrors.
 */
export async function patchStCharacterById(
    chid: number,
    fields: HostCharacterPatch,
): Promise<HostCharacterFull> {
    const resolved = resolveStCharacterById(chid);
    if (!resolved) {
        throw new Error(`Character not found (chid=${chid})`);
    }
    const { character } = resolved;
    const avatar = typeof character.avatar === 'string' ? character.avatar : '';
    if (!avatar) {
        throw new Error(`Character at chid=${chid} has no avatar filename`);
    }

    const mergePayload = buildCharacterMergePayload(character, fields);
    const headers = typeof getRequestHeaders === 'function' ? getRequestHeaders() : { 'Content-Type': 'application/json' };
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers,
        body: JSON.stringify(mergePayload),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => response.statusText);
        throw new Error(
            `Failed to patch character "${avatar}" (${response.status}): ${errText || response.statusText}`,
        );
    }

    syncCharacterThreeWayMirrors(chid, character, fields);
    return buildCharacterFullSnapshot(chid, character);
}

/**
 * Convert a raw SillyTavern World Info entry into `RawLoreEntry` WITHOUT mutating `@@` or `<% %>`.
 */
export function convertRawStLoreEntry(
    bookName: string,
    rawInput: unknown,
    fallbackIndex: number,
): RawLoreEntry {
    const raw = (isPlainRecord(rawInput) ? rawInput : {}) as RawStWorldInfoEntry;
    return {
        world: bookName,
        uid: parseNumericUid(raw.uid, fallbackIndex),
        comment: typeof raw.comment === 'string' ? raw.comment : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        keys: normalizeStringArray(raw.key ?? raw.keys),
        keysecondary: normalizeStringArray(raw.keysecondary ?? raw.secondaryKeys),
        constant: Boolean(raw.constant),
        selective: raw.selective !== undefined ? Boolean(raw.selective) : true,
        selectiveLogic: typeof raw.selectiveLogic === 'number' ? raw.selectiveLogic : 0,
        disable: raw.disable !== undefined ? Boolean(raw.disable) : raw.enabled === false,
        position: typeof raw.position === 'number' ? raw.position : 0,
        depth: typeof raw.depth === 'number' ? raw.depth : 4,
        order: typeof raw.order === 'number' ? raw.order : 100,
        role: typeof raw.role === 'number' ? raw.role : 0,
        ...(raw.caseSensitive !== undefined ? { caseSensitive: raw.caseSensitive } : {}),
        ...(raw.matchWholeWords !== undefined ? { matchWholeWords: raw.matchWholeWords } : {}),
        ...(typeof raw.probability === 'number' ? { probability: raw.probability } : {}),
        ...(typeof raw.useProbability === 'boolean' ? { useProbability: raw.useProbability } : {}),
        ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
        ...(typeof raw.groupOverride === 'boolean' ? { groupOverride: raw.groupOverride } : {}),
        ...(typeof raw.groupWeight === 'number' ? { groupWeight: raw.groupWeight } : {}),
        ...(raw.scanDepth !== undefined ? { scanDepth: raw.scanDepth } : {}),
        ...(isPlainRecord(raw.extensions) ? { extensions: cloneValue(raw.extensions) } : {}),
    };
}

function normalizeBookEntriesMap(rawBook: RawStWorldInfoBook): Record<string, RawStWorldInfoEntry> {
    if (!rawBook.entries) {
        rawBook.entries = {};
        return rawBook.entries;
    }
    if (Array.isArray(rawBook.entries)) {
        const mapped: Record<string, RawStWorldInfoEntry> = {};
        rawBook.entries.forEach((item, idx) => {
            const uid = parseNumericUid(item?.uid, idx);
            mapped[String(uid)] = { ...(isPlainRecord(item) ? item : {}), uid };
        });
        rawBook.entries = mapped;
        return mapped;
    }
    return rawBook.entries;
}

function findNextWorldInfoUid(entries: Record<string, RawStWorldInfoEntry>): number {
    let maxUid = -1;
    for (const [k, item] of Object.entries(entries)) {
        const uid = parseNumericUid(item?.uid ?? k, -1);
        if (uid > maxUid) {
            maxUid = uid;
        }
    }
    return maxUid + 1;
}

/**
 * Normalize `HostRegexScript[]` with SillyTavern `RegexScriptData` required defaults
 * (`trimStrings`, `placement`, `disabled`, `markdownOnly`, `promptOnly`, `runOnEdit`, `substituteRegex`).
 */
export function normalizeStRegexScripts(
    scripts: readonly HostRegexScript[],
): Array<HostRegexScript & {
    trimStrings: string[];
    placement: number[];
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    substituteRegex: number;
    minDepth: number | null;
    maxDepth: number | null;
}> {
    return scripts.map((script) => {
        const cloned = cloneValue(script);
        return {
            ...cloned,
            trimStrings: Array.isArray(cloned.trimStrings) ? cloned.trimStrings : [],
            placement: Array.isArray(cloned.placement) ? cloned.placement : [],
            disabled: cloned.disabled ?? false,
            markdownOnly: cloned.markdownOnly ?? false,
            promptOnly: cloned.promptOnly ?? false,
            runOnEdit: cloned.runOnEdit ?? false,
            substituteRegex: cloned.substituteRegex ?? 0,
            minDepth: cloned.minDepth ?? null,
            maxDepth: cloned.maxDepth ?? null,
        };
    });
}

function collectWorkspaceFiles(
    store: ChatDataStore | undefined,
    filePaths?: string[],
): Record<string, string> {
    if (!store) {
        return {};
    }
    const target =
        Array.isArray(chat) && chat.length > 0
            ? {
                  messageId: chat.length - 1,
                  swipeId:
                      typeof (chat[chat.length - 1] as { swipe_id?: unknown } | undefined)?.swipe_id === 'number'
                          ? ((chat[chat.length - 1] as { swipe_id: number }).swipe_id)
                          : 0,
              }
            : undefined;
    const rows = store.lookup(DATA_NAMESPACES.FILES, {
        target,
        includeStaged: true,
    });

    const wantedSet = filePaths && filePaths.length > 0
        ? new Set(
              filePaths.map((p) =>
                  p
                      .trim()
                      .replace(/^\/+/, '')
                      .replace(/^(?:workspace|chat)\//, ''),
              ),
          )
        : null;

    const files: Record<string, string> = {};
    for (const row of rows) {
        const cleanKey = row.key.replace(/^\/+/, '').trim();
        if (!cleanKey) {
            continue;
        }
        if (wantedSet && !wantedSet.has(cleanKey)) {
            continue;
        }
        files[cleanKey] = row.entry.content;
    }
    return files;
}

/**
 * SillyTavern host implementation of `HostAuthorBridge`.
 * Supports active character editing with 3-way mirror sync, raw World Info authoring
 * (preserving `@@` decorators & `<% ... %>` EJS verbatim), scoped regex, and card embedding.
 */
export class STAuthorBridge implements HostAuthorBridge {
    private readonly getSettings?: () => Settings | undefined;
    private readonly getStore?: () => ChatDataStore | undefined;

    constructor(options: STAuthorBridgeOptions = {}) {
        this.getSettings = options.getSettings;
        this.getStore = options.getStore;
    }

    async getActiveCharacterFull(): Promise<HostCharacterFull | null> {
        const resolved = resolveStCharacterById(this_chid);
        if (!resolved) {
            return null;
        }
        return buildCharacterFullSnapshot(resolved.chid, resolved.character);
    }

    async patchActiveCharacter(
        fields: HostCharacterPatch,
        _undoMeta?: AuthorUndoMeta,
    ): Promise<HostCharacterFull> {
        const resolved = resolveStCharacterById(this_chid);
        if (!resolved) {
            throw new Error(`No active character selected (this_chid=${String(this_chid)})`);
        }
        return patchStCharacterById(resolved.chid, fields);
    }

    async toggleChatMessageHidden(messageId: number, hidden: boolean): Promise<boolean> {
        if (
            !Array.isArray(chat) ||
            !Number.isInteger(messageId) ||
            messageId < 0 ||
            messageId >= chat.length
        ) {
            return false;
        }
        const msg = chat[messageId] as Record<string, unknown> | undefined;
        if (!msg) {
            return false;
        }

        const nextHidden = Boolean(hidden);
        msg.is_system = nextHidden;

        if (typeof document !== 'undefined') {
            const mesElement = document.querySelector<HTMLElement>(`#chat .mes[mesid="${messageId}"]`);
            if (mesElement) {
                mesElement.setAttribute('is_system', String(nextHidden));
            }
        }

        if (typeof updateMessageBlock === 'function') {
            try {
                updateMessageBlock(messageId, msg, { rerenderMessage: false });
            } catch {
                // Ignore DOM update errors when ST chat DOM is absent.
            }
        }

        saveChatDebounced();

        const updatedEvent = (event_types as Record<string, string | undefined>)?.MESSAGE_UPDATED;
        if (updatedEvent && typeof eventSource?.emit === 'function') {
            await eventSource.emit(updatedEvent, messageId);
        }

        return true;
    }

    async getPrimaryWorldName(): Promise<string | null> {
        const resolved = resolveStCharacterById(this_chid);
        if (!resolved) {
            return null;
        }
        const v2 = isPlainRecord(resolved.character.data) ? resolved.character.data : {};
        const ext = isPlainRecord(v2.extensions) ? v2.extensions : {};
        const world = typeof ext.world === 'string' ? ext.world.trim() : '';
        return world || null;
    }

    async readWorldInfoBook(bookName: string): Promise<WorldInfoBookSnapshot | null> {
        const trimmedName = bookName.trim();
        if (!trimmedName) {
            return null;
        }
        const data = (await loadWorldInfo(trimmedName)) as RawStWorldInfoBook | null | undefined;
        if (!data || !data.entries) {
            return null;
        }

        const entries: RawLoreEntry[] = Array.isArray(data.entries)
            ? data.entries.map((entry, idx) => convertRawStLoreEntry(trimmedName, entry, idx))
            : Object.entries(data.entries).map(([uidKey, entry], idx) =>
                  convertRawStLoreEntry(trimmedName, entry, parseNumericUid(uidKey, idx)),
              );

        entries.sort((a, b) => a.uid - b.uid);
        return {
            name: trimmedName,
            entries,
        };
    }

    async upsertWorldInfoEntry(
        bookName: string,
        entry: WorldInfoEntryUpsert,
        _opts?: UpsertWorldInfoEntryOptions,
    ): Promise<RawLoreEntry> {
        const trimmedName = bookName.trim();
        if (!trimmedName) {
            throw new Error('World Info book name must not be empty');
        }

        const loaded = (await loadWorldInfo(trimmedName)) as RawStWorldInfoBook | null | undefined;
        const bookData: RawStWorldInfoBook = loaded && isPlainRecord(loaded)
            ? loaded
            : { entries: {} };
        const entriesMap = normalizeBookEntriesMap(bookData);

        let targetUid: number;
        let existingEntry: RawStWorldInfoEntry | undefined;

        if (entry.uid !== undefined && Number.isFinite(entry.uid)) {
            targetUid = Math.floor(entry.uid);
            existingEntry = entriesMap[String(targetUid)];
        } else {
            targetUid = findNextWorldInfoUid(entriesMap);
        }

        let targetRecord: RawStWorldInfoEntry;
        if (existingEntry && isPlainRecord(existingEntry)) {
            targetRecord = existingEntry;
        } else if (typeof createWorldInfoEntry === 'function') {
            const created = createWorldInfoEntry(trimmedName, bookData) as RawStWorldInfoEntry | undefined;
            if (created && isPlainRecord(created)) {
                const createdUid = parseNumericUid(created.uid, targetUid);
                if (entry.uid !== undefined && createdUid !== targetUid) {
                    delete entriesMap[String(createdUid)];
                    created.uid = targetUid;
                    entriesMap[String(targetUid)] = created;
                } else {
                    targetUid = createdUid;
                    entriesMap[String(targetUid)] = created;
                }
                targetRecord = created;
            } else {
                targetRecord = { uid: targetUid };
                entriesMap[String(targetUid)] = targetRecord;
            }
        } else {
            targetRecord = { uid: targetUid };
            entriesMap[String(targetUid)] = targetRecord;
        }

        // Write raw `content` verbatim WITHOUT `escapeAt` so `@@` decorators and `<% ... %>` EJS stay intact.
        targetRecord.uid = targetUid;
        targetRecord.key = [...entry.keys];
        targetRecord.keysecondary = entry.keysecondary
            ? [...entry.keysecondary]
            : normalizeStringArray(targetRecord.keysecondary);
        targetRecord.comment = entry.comment ?? (typeof targetRecord.comment === 'string' ? targetRecord.comment : '');
        targetRecord.content = entry.content;
        targetRecord.addMemo = Boolean(targetRecord.comment);
        targetRecord.constant = entry.constant ?? Boolean(targetRecord.constant);
        targetRecord.selective =
            entry.selective !== undefined
                ? entry.selective
                : targetRecord.selective !== undefined
                    ? Boolean(targetRecord.selective)
                    : true;
        targetRecord.selectiveLogic =
            entry.selectiveLogic ?? (typeof targetRecord.selectiveLogic === 'number' ? targetRecord.selectiveLogic : 0);
        targetRecord.disable = entry.disable ?? Boolean(targetRecord.disable);
        targetRecord.position =
            entry.position ?? (typeof targetRecord.position === 'number' ? targetRecord.position : 0);
        targetRecord.depth =
            entry.depth ?? (typeof targetRecord.depth === 'number' ? targetRecord.depth : 4);
        targetRecord.order =
            entry.order ?? (typeof targetRecord.order === 'number' ? targetRecord.order : 100);
        targetRecord.role =
            entry.role ?? (typeof targetRecord.role === 'number' ? targetRecord.role : 0);

        if (entry.caseSensitive !== undefined) {
            targetRecord.caseSensitive = entry.caseSensitive;
        }
        if (entry.matchWholeWords !== undefined) {
            targetRecord.matchWholeWords = entry.matchWholeWords;
        }
        if (entry.probability !== undefined) {
            targetRecord.probability = entry.probability;
        }
        if (entry.useProbability !== undefined) {
            targetRecord.useProbability = entry.useProbability;
        }
        if (entry.group !== undefined) {
            targetRecord.group = entry.group;
        }
        if (entry.groupOverride !== undefined) {
            targetRecord.groupOverride = entry.groupOverride;
        }
        if (entry.groupWeight !== undefined) {
            targetRecord.groupWeight = entry.groupWeight;
        }
        if (entry.scanDepth !== undefined) {
            targetRecord.scanDepth = entry.scanDepth;
        }
        if (entry.extensions !== undefined) {
            targetRecord.extensions = cloneValue(entry.extensions);
        }

        await saveWorldInfo(trimmedName, bookData, true);

        if (typeof reloadEditor === 'function') {
            try {
                reloadEditor(trimmedName, false);
            } catch {
                // Ignore if ST WI editor UI is not active.
            }
        }

        return convertRawStLoreEntry(trimmedName, targetRecord, targetUid);
    }

    async deleteWorldInfoEntry(bookName: string, uid: number): Promise<boolean> {
        const trimmedName = bookName.trim();
        if (!trimmedName || !Number.isFinite(uid)) {
            return false;
        }

        const loaded = (await loadWorldInfo(trimmedName)) as RawStWorldInfoBook | null | undefined;
        if (!loaded || !loaded.entries) {
            return false;
        }
        const entriesMap = normalizeBookEntriesMap(loaded);
        const key = String(Math.floor(uid));
        if (!(key in entriesMap)) {
            return false;
        }

        if (typeof stDeleteWorldInfoEntry === 'function') {
            const deleted = await stDeleteWorldInfoEntry(
                loaded as unknown as Parameters<typeof stDeleteWorldInfoEntry>[0],
                Math.floor(uid),
                { silent: true },
            );
            if (deleted === false && key in entriesMap) {
                delete entriesMap[key];
            }
        } else {
            delete entriesMap[key];
        }

        await saveWorldInfo(trimmedName, loaded, true);

        if (typeof reloadEditor === 'function') {
            try {
                reloadEditor(trimmedName, false);
            } catch {
                // Ignore if ST WI editor UI is not active.
            }
        }

        return true;
    }

    async listScopedRegex(): Promise<HostRegexScript[]> {
        if (typeof getScriptsByType === 'function' && SCRIPT_TYPES?.SCOPED !== undefined) {
            try {
                const scripts = getScriptsByType(SCRIPT_TYPES.SCOPED);
                if (Array.isArray(scripts)) {
                    return cloneValue(scripts as HostRegexScript[]);
                }
            } catch {
                // Fall back to direct character extension read.
            }
        }

        const resolved = resolveStCharacterById(this_chid);
        if (!resolved) {
            return [];
        }
        const v2 = isPlainRecord(resolved.character.data) ? resolved.character.data : {};
        const ext = isPlainRecord(v2.extensions) ? v2.extensions : {};
        return Array.isArray(ext.regex_scripts)
            ? cloneValue(ext.regex_scripts as HostRegexScript[])
            : [];
    }

    async saveScopedRegex(scripts: HostRegexScript[]): Promise<void> {
        const normalized = normalizeStRegexScripts(scripts);
        const resolved = resolveStCharacterById(this_chid);

        if (typeof saveScriptsByType === 'function' && SCRIPT_TYPES?.SCOPED !== undefined) {
            await saveScriptsByType(
                normalized as unknown as Parameters<typeof saveScriptsByType>[0],
                SCRIPT_TYPES.SCOPED,
            );
            if (resolved) {
                syncCharacterThreeWayMirrors(resolved.chid, resolved.character, {
                    extensions: { regex_scripts: normalized },
                });
            }
            return;
        }

        if (!resolved) {
            throw new Error('Cannot save scoped regex scripts: no active character selected');
        }
        await patchStCharacterById(resolved.chid, {
            extensions: { regex_scripts: normalized },
        });
    }

    async embedAgenticPayload(options: EmbedAgenticOptions): Promise<EmbedAgenticResult> {
        const resolved = resolveStCharacterById(this_chid);
        if (!resolved) {
            return {
                ok: false,
                embeddedPresets: 0,
                embeddedFiles: 0,
                message: 'No active character selected.',
            };
        }

        const messages: string[] = [];
        let embeddedPresets = 0;
        let embeddedFiles = 0;

        if (options.includePreset) {
            const settings = this.getSettings?.();
            const presetTarget = options.presetId
                ? (settings?.presets?.[options.presetId] ?? options.presetId)
                : settings
                    ? resolveActivePreset(settings)
                    : undefined;

            if (!presetTarget) {
                throw new Error('Cannot embed preset: no active preset or presetId available.');
            }
            const msg = await embedPresetToCard(presetTarget, resolved.chid);
            embeddedPresets = 1;
            messages.push(msg);
        }

        if (options.includeFiles) {
            const explicitFiles = options.files ? cloneValue(options.files) : {};
            const storeFiles =
                Object.keys(explicitFiles).length === 0 || (options.filePaths && options.filePaths.length > 0)
                    ? collectWorkspaceFiles(this.getStore?.(), options.filePaths)
                    : {};
            const mergedFiles: Record<string, string> = {
                ...storeFiles,
                ...explicitFiles,
            };

            const count = Object.keys(mergedFiles).length;
            if (count > 0) {
                const msg = await embedFilesToCard(mergedFiles, resolved.chid);
                embeddedFiles = count;
                messages.push(msg);
            }
        }

        return {
            ok: true,
            embeddedPresets,
            embeddedFiles,
            message:
                messages.join(' | ') ||
                `Embedded ${embeddedPresets} preset(s) and ${embeddedFiles} file(s)`,
        };
    }
}
