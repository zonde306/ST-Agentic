import {
    characters,
    chat,
    chat_metadata,
    saveCharacterDebounced,
    saveMetadata,
    this_chid,
} from '@st/script.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import { saveMetadataDebounced } from '@st/scripts/extensions.js';
import { translate } from '@st/scripts/i18n.js';
import { power_user } from '@st/scripts/power-user.js';
import { accountStorage } from '@st/scripts/util/AccountStorage.js';
import type { HostBridge } from '@/core/bridge';
import {
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    exportPreset,
    normalizeFileMap,
    normalizePreset,
} from '@/core/config';
import {
    EMBED_KEY_AGENTIC_FILES,
    EMBED_KEY_AGENTIC_PRESETS,
    EMBED_KEY_LEGACY_FILES,
    EMBED_KEY_LEGACY_PRESETS,
    type EmbeddedCharacterMigrationResult,
    createEmbeddedFilesPayload,
    createEmbeddedPresetsPayload,
    isLegacyCustomGenerationData,
    migrateEmbeddedCharacterData,
    migrateFromCustomGeneration,
} from '@/core/migration';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    invalidateHeadIndex,
    readPersistedAgenticData,
} from '@/core/store';
import type {
    ChatMessageSnapshot,
    MessageTarget,
    MigrationReport,
    Preset,
    SwipeDataSnapshot,
} from '@/core/types';
import { hashText } from '@/core/utils';
import {
    type AppStore,
    type EmbeddedCardStatus,
    getDefaultAppStore,
} from '@/ui/store';

export const AGENTIC_CARD_MENU_IDS = {
    LINK_PRESET: 'agentic-card-link',
    IMPORT_PRESET: 'agentic-card-import',
    LINK_FILES: 'agentic-card-link-files',
    IMPORT_FILES: 'agentic-card-import-files',
} as const;

export type AgenticCardMenuId =
    (typeof AGENTIC_CARD_MENU_IDS)[keyof typeof AGENTIC_CARD_MENU_IDS];

export interface EmbedCardSetupOptions {
    store?: AppStore;
    bridge?: HostBridge;
    dataStore?: ChatDataStore;
    autoPromptDelayMs?: number;
}

export interface ImportEmbeddedCardOptions {
    presetsOnly?: boolean;
    filesOnly?: boolean;
    overwriteExisting?: boolean;
    store?: AppStore;
    bridge?: HostBridge;
    dataStore?: ChatDataStore;
}

export interface ImportEmbeddedCardResult {
    presetsImported: number;
    filesImported: number;
    report?: MigrationReport;
    message: string;
}

interface ResolvedCharacterEntry {
    chid: number;
    character: Character;
}

const DROPDOWN_SELECTOR = '#char-management-dropdown';
const FORM_CREATE_SELECTOR = '#form_create';
const AUTO_PROMPT_PREFIX = 'AgenticAlertEmbed_';
const DEFAULT_AUTO_PROMPT_DELAY_MS = 600;
const DROPDOWN_DEDUP_WINDOW_MS = 50;

const CARD_MENU_OPTIONS: ReadonlyArray<{
    id: AgenticCardMenuId;
    i18nKey: string;
    fallbackLabel: string;
}> = [
    {
        id: AGENTIC_CARD_MENU_IDS.LINK_PRESET,
        i18nKey: 'Link Preset to Card',
        fallbackLabel: 'Link Preset to Card',
    },
    {
        id: AGENTIC_CARD_MENU_IDS.IMPORT_PRESET,
        i18nKey: 'Import Card Preset',
        fallbackLabel: 'Import Card Preset',
    },
    {
        id: AGENTIC_CARD_MENU_IDS.LINK_FILES,
        i18nKey: 'Link Files to Card',
        fallbackLabel: 'Link Files to Card',
    },
    {
        id: AGENTIC_CARD_MENU_IDS.IMPORT_FILES,
        i18nKey: 'Import Card Files',
        fallbackLabel: 'Import Card Files',
    },
];

let boundOptions: EmbedCardSetupOptions = {};
let activeTeardown: (() => void) | null = null;
let lastHandledDropdownAction: { id: string; timestamp: number } | null = null;

function tr(fallbackText: string, i18nKey: string): string {
    try {
        const translated = translate(fallbackText, i18nKey);
        if (typeof translated === 'string' && translated.trim().length > 0) {
            return translated;
        }
    } catch {
        // Fallback silently when ST i18n has not initialized.
    }
    return fallbackText;
}

function getActiveStore(overrideStore?: AppStore): AppStore {
    return overrideStore ?? boundOptions.store ?? getDefaultAppStore();
}

function getActiveBridge(overrideBridge?: HostBridge): HostBridge {
    return overrideBridge ?? boundOptions.bridge ?? createFallbackStBridge();
}

function getActiveDataStore(
    overrideStore?: ChatDataStore,
    overrideBridge?: HostBridge,
): ChatDataStore {
    if (overrideStore) {
        return overrideStore;
    }
    if (boundOptions.dataStore && !overrideBridge) {
        return boundOptions.dataStore;
    }
    return new ChatDataStore(getActiveBridge(overrideBridge));
}

function createFallbackStBridge(): HostBridge {
    return {
        getChat(): ChatMessageSnapshot[] {
            const list = Array.isArray(chat) ? chat : [];
            return list.map((msg, index) => ({
                id: index,
                name: String(msg?.name ?? ''),
                isUser: Boolean(msg?.is_user),
                isSystem: Boolean(msg?.is_system),
                mes: String(msg?.mes ?? ''),
                swipeId: typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0,
                swipes: Array.isArray(msg?.swipes) ? msg.swipes : undefined,
                swipeInfo: Array.isArray(msg?.swipe_info)
                    ? (msg.swipe_info as SwipeDataSnapshot[])
                    : undefined,
                sendDate: msg?.send_date as string | number | undefined,
                extra: msg?.extra as Record<string, unknown> | undefined,
            }));
        },
        getMetadata(): Record<string, unknown> {
            return (chat_metadata ?? {}) as Record<string, unknown>;
        },
        saveChatDebounced(): void {
            try {
                saveMetadataDebounced();
            } catch {
                // Ignore if ST metadata save hooks are unavailable in isolated tests.
            }
        },
        getActiveIdentity() {
            return {
                userName: 'User',
                charName: '',
                characterAvatar: '',
                personaAvatar: '',
            };
        },
        getCharacterFields(): Record<string, string> {
            return {};
        },
        getPersonaDescription(): string {
            return '';
        },
        async listEnabledLorebooks() {
            return new Map();
        },
        substituteMacros(text: string): string {
            return text;
        },
        async attachMediaToMessage(): Promise<void> {
            // Not used by embed-card fallback bridge.
        },
        async refreshMessageView(): Promise<void> {
            // Not used by embed-card fallback bridge.
        },
        async loadExtensionData<T>(_key: string, fallback: T): Promise<T> {
            return fallback;
        },
        async saveExtensionData(): Promise<void> {
            // Not used by embed-card fallback bridge.
        },
        async hashText(text: string): Promise<string> {
            return hashText(text);
        },
    };
}

function resolveCharacter(chid?: number | string): ResolvedCharacterEntry | null {
    const rawChid = chid ?? (this_chid as number | string | undefined);
    if (rawChid === undefined || rawChid === null || rawChid === '') {
        return null;
    }
    const index = Number(rawChid);
    if (!Number.isInteger(index) || index < 0) {
        return null;
    }
    const list = Array.isArray(characters) ? characters : [];
    const character = list[index];
    if (!character || typeof character !== 'object') {
        return null;
    }
    return { chid: index, character };
}

function parseJsonRecord(raw: unknown): Record<string, unknown> | null {
    if (typeof raw !== 'string' || !raw.trim()) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Ignore malformed JSON snapshots.
    }
    return null;
}

function extractCharacterExtensions(character: Character): Record<string, unknown> {
    const dataObj = character.data as unknown as { extensions?: unknown } | undefined;
    const liveExt = dataObj?.extensions;
    const merged: Record<string, unknown> =
        liveExt && typeof liveExt === 'object' && !Array.isArray(liveExt)
            ? { ...(liveExt as Record<string, unknown>) }
            : {};

    const parsedJson = parseJsonRecord(character.json_data);
    const jsonData = parsedJson?.data;
    if (jsonData && typeof jsonData === 'object' && !Array.isArray(jsonData)) {
        const jsonExt = (jsonData as { extensions?: unknown }).extensions;
        if (jsonExt && typeof jsonExt === 'object' && !Array.isArray(jsonExt)) {
            const extRec = jsonExt as Record<string, unknown>;
            for (const key of [
                EMBED_KEY_AGENTIC_PRESETS,
                EMBED_KEY_AGENTIC_FILES,
                EMBED_KEY_LEGACY_PRESETS,
                EMBED_KEY_LEGACY_FILES,
            ]) {
                if (merged[key] === undefined && extRec[key] !== undefined) {
                    merged[key] = extRec[key];
                }
            }
        }
    }

    return merged;
}

function ensureNestedExtensions(target: Record<string, unknown>): Record<string, unknown> {
    if (!target.data || typeof target.data !== 'object' || Array.isArray(target.data)) {
        target.data = {};
    }
    const dataRec = target.data as Record<string, unknown>;
    if (
        !dataRec.extensions
        || typeof dataRec.extensions !== 'object'
        || Array.isArray(dataRec.extensions)
    ) {
        dataRec.extensions = {};
    }
    return dataRec.extensions as Record<string, unknown>;
}

/**
 * Persist an extension key across all three character data mirrors used by SillyTavern:
 * 1) live `characters[chid].data.extensions`
 * 2) serialized `characters[chid].json_data`
 * 3) active character editor form `#form_create [name="json_data"]`
 */
function writeExtensionKeyToCharacterMirrors(
    character: Character,
    key: string,
    payload: unknown,
): void {
    // 1. Live character object.
    const liveExtensions = ensureNestedExtensions(character as unknown as Record<string, unknown>);
    liveExtensions[key] = payload;

    // 2. Serialized `character.json_data` kept alongside the live object.
    const jsonRecord = parseJsonRecord(character.json_data) ?? {};
    const jsonExtensions = ensureNestedExtensions(jsonRecord);
    jsonExtensions[key] = payload;
    character.json_data = JSON.stringify(jsonRecord);

    // 3. Edit form `#form_create [name="json_data"]`, which wins on save if left stale.
    if (typeof document !== 'undefined') {
        const form = document.querySelector(FORM_CREATE_SELECTOR);
        if (form) {
            const avatarInput = form.querySelector<HTMLInputElement>('[name="avatar_url"]');
            const formAvatar = avatarInput?.value?.trim() ?? '';
            const matchesForm = !formAvatar || !character.avatar || formAvatar === character.avatar;
            const jsonInput = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(
                '[name="json_data"]',
            );
            if (matchesForm && jsonInput) {
                const formJsonRecord = parseJsonRecord(jsonInput.value) ?? parseJsonRecord(character.json_data) ?? {};
                const formExtensions = ensureNestedExtensions(formJsonRecord);
                formExtensions[key] = payload;
                jsonInput.value = JSON.stringify(formJsonRecord);
            }
        }
    }
}

function runEmbeddedMigration(character: Character): EmbeddedCharacterMigrationResult {
    const ext = extractCharacterExtensions(character);
    const result = migrateEmbeddedCharacterData(ext);

    // Fallback for legacy single-object CG ExportPayload placed directly in `cg_embed_presets`.
    if (!result.hasPresets) {
        const legacyCandidate = ext[EMBED_KEY_AGENTIC_PRESETS] ?? ext[EMBED_KEY_LEGACY_PRESETS];
        if (
            legacyCandidate
            && typeof legacyCandidate === 'object'
            && !Array.isArray(legacyCandidate)
            && isLegacyCustomGenerationData(legacyCandidate)
        ) {
            try {
                const migrated = migrateFromCustomGeneration(legacyCandidate);
                const migratedPresets = Object.values(migrated.settings.presets);
                if (migratedPresets.length > 0) {
                    return {
                        ...result,
                        presetsPayload: { version: 1, presets: migratedPresets },
                        hasPresets: true,
                        fromLegacy: true,
                        report: {
                            ...migrated.report,
                            migratedFiles:
                                migrated.report.migratedFiles
                                + Object.keys(result.filesPayload?.files ?? {}).length,
                        },
                    };
                }
            } catch {
                // Keep empty preset result when payload cannot be converted.
            }
        }
    }

    return result;
}

function getLatestChatTarget(bridge: HostBridge): MessageTarget | null {
    const snapshot = bridge.getChat();
    if (snapshot.length === 0) {
        return null;
    }
    const messageId = snapshot.length - 1;
    const swipeId = snapshot[messageId]?.swipeId ?? 0;
    return { messageId, swipeId };
}

function collectWorkspaceFileMap(dataStore: ChatDataStore, bridge: HostBridge): Map<string, string> {
    const target = getLatestChatTarget(bridge) ?? undefined;
    const rows = dataStore.lookup(DATA_NAMESPACES.FILES, {
        target,
        includeStaged: true,
    });
    const map = new Map<string, string>();
    for (const row of rows) {
        const cleanName = row.key.replace(/^\/+/, '').trim();
        if (cleanName) {
            map.set(cleanName, row.entry.content);
        }
    }
    return map;
}

function readAccountStorageItem(key: string): string | null {
    try {
        return accountStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeAccountStorageItem(key: string, value: string): void {
    try {
        accountStorage.setItem(key, value);
    } catch {
        // Ignore storage write errors in minimal environments.
    }
}

function formatByteSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

function measureFileMapBytes(files: Record<string, string>): number {
    let total = 0;
    for (const [name, content] of Object.entries(files)) {
        total += name.length + content.length;
    }
    return total;
}

/**
 * Read embedded preset & file status from the target (or currently selected) character card.
 * Prioritizes `agentic_embed_*` keys and seamlessly falls back to legacy `cg_embed_*`.
 */
export async function getEmbeddedCardStatus(chid?: number): Promise<EmbeddedCardStatus> {
    const resolved = resolveCharacter(chid);
    if (!resolved) {
        return {
            characterName: tr('未选择角色', 'No character selected'),
            hasPresets: false,
            hasFiles: false,
            fromLegacy: false,
            presetCount: 0,
            fileCount: 0,
        };
    }

    const migration = runEmbeddedMigration(resolved.character);
    return {
        characterName: resolved.character.name || resolved.character.avatar || `#${resolved.chid}`,
        hasPresets: migration.hasPresets,
        hasFiles: migration.hasFiles,
        fromLegacy: migration.fromLegacy,
        presetCount: migration.presetsPayload?.presets.length ?? 0,
        fileCount: Object.keys(migration.filesPayload?.files ?? {}).length,
    };
}

/**
 * Sanitize one or more presets (`exportPreset` + `normalizePreset`, stripping all `apiKey`s)
 * and write `agentic_embed_presets` across all three character data mirrors.
 */
export async function embedPresetToCard(
    presetOrId: Preset | readonly Preset[] | string,
    chid?: number,
    options: { store?: AppStore } = {},
): Promise<string> {
    const resolved = resolveCharacter(chid);
    if (!resolved) {
        throw new Error(tr('当前未选择角色卡，无法写入嵌入预设。', 'No active character selected.'));
    }

    const store = getActiveStore(options.store);
    let rawPresets: readonly Preset[];
    if (typeof presetOrId === 'string') {
        const found = store.getSnapshot().settings.presets[presetOrId];
        if (!found) {
            throw new Error(`Preset "${presetOrId}" not found.`);
        }
        rawPresets = [found];
    } else if (Array.isArray(presetOrId)) {
        rawPresets = presetOrId;
    } else {
        rawPresets = [presetOrId as Preset];
    }

    if (rawPresets.length === 0) {
        throw new Error(tr('请至少选择一个预设进行嵌入。', 'At least one preset is required.'));
    }

    // Double-sanitize via exportPreset + normalizePreset so secrets (`apiKey`) can never leak into PNG cards.
    const sanitizedPresets = rawPresets.map((preset) => {
        const exported = exportPreset(preset);
        return normalizePreset(exported.preset, exported.preset.id);
    });
    const payload = createEmbeddedPresetsPayload(sanitizedPresets);

    writeExtensionKeyToCharacterMirrors(
        resolved.character,
        EMBED_KEY_AGENTIC_PRESETS,
        payload,
    );
    saveCharacterDebounced();

    const presetNames = sanitizedPresets.map((p) => p.name).join(', ');
    return tr(
        `已将预设「${presetNames}」写入角色卡三处镜像 (${EMBED_KEY_AGENTIC_PRESETS})`,
        'agentic_embed_preset_saved',
    )
        .replace('${0}', () => presetNames)
        .replace('${1}', () => EMBED_KEY_AGENTIC_PRESETS);
}

/**
 * Validate PNG chunk size safety (`<= 256 KiB`) and write `agentic_embed_files`
 * across all three character data mirrors.
 */
export async function embedFilesToCard(
    files: Record<string, string>,
    chid?: number,
): Promise<string> {
    const resolved = resolveCharacter(chid);
    if (!resolved) {
        throw new Error(tr('当前未选择角色卡，无法写入嵌入文件。', 'No active character selected.'));
    }

    const payload = createEmbeddedFilesPayload(files, DEFAULT_FILE_MAP_SIZE_LIMIT);
    writeExtensionKeyToCharacterMirrors(
        resolved.character,
        EMBED_KEY_AGENTIC_FILES,
        payload,
    );
    saveCharacterDebounced();

    const fileCount = Object.keys(payload.files).length;
    return tr(
        `已将 ${fileCount} 个文件写入角色卡三处镜像 (${EMBED_KEY_AGENTIC_FILES})`,
        'agentic_embed_files_saved',
    )
        .replace('${0}', () => String(fileCount))
        .replace('${1}', () => EMBED_KEY_AGENTIC_FILES);
}

/**
 * Dual-read embedded presets and workspace files from a character card (upgrading legacy
 * `cg_embed_*` payloads automatically via `migrateEmbeddedCharacterData`), apply presets
 * to `AppStore` settings, and write workspace files into `ChatDataStore`.
 */
export async function importEmbeddedFromCard(
    chid?: number,
    options: ImportEmbeddedCardOptions = {},
): Promise<ImportEmbeddedCardResult> {
    const resolved = resolveCharacter(chid);
    if (!resolved) {
        throw new Error(tr('当前未选择角色卡，无法导入嵌入数据。', 'No active character selected.'));
    }

    const store = getActiveStore(options.store);
    const bridge = getActiveBridge(options.bridge);
    const dataStore = getActiveDataStore(options.dataStore, bridge);
    const migration = runEmbeddedMigration(resolved.character);

    const shouldImportPresets = !options.filesOnly && migration.hasPresets;
    const shouldImportFiles = !options.presetsOnly && migration.hasFiles;

    if (!shouldImportPresets && !shouldImportFiles) {
        return {
            presetsImported: 0,
            filesImported: 0,
            message: tr(
                '当前角色卡未包含可导入的嵌入预设或文件。',
                'No embedded presets or files found on this character card.',
            ),
        };
    }

    let presetsImported = 0;
    if (shouldImportPresets && migration.presetsPayload) {
        const normalizedList = migration.presetsPayload.presets.map((preset) =>
            normalizePreset(exportPreset(preset).preset, preset.id),
        );
        if (normalizedList.length > 0) {
            await store.updateSettings((prev) => {
                const nextPresets = { ...prev.presets };
                for (const preset of normalizedList) {
                    nextPresets[preset.id] = preset;
                }
                return {
                    ...prev,
                    presets: nextPresets,
                    currentPresetId: normalizedList[0].id,
                };
            });
            presetsImported = normalizedList.length;
        }
    }

    let filesImported = 0;
    if (shouldImportFiles && migration.filesPayload) {
        const entries = Object.entries(migration.filesPayload.files);
        if (entries.length > 0) {
            const target = getLatestChatTarget(bridge);
            const existing = collectWorkspaceFileMap(dataStore, bridge);
            const overwrite = options.overwriteExisting !== false;

            for (const [name, content] of entries) {
                if (!overwrite && existing.has(name)) {
                    continue;
                }
                if (target) {
                    dataStore.set(DATA_NAMESPACES.FILES, name, 'card-import', content, { target });
                } else {
                    // Empty chat: persist in `agentic_data.base` so files survive reload before turn #0.
                    const metadata = bridge.getMetadata();
                    const persisted = readPersistedAgenticData(metadata, true);
                    if (persisted) {
                        if (!persisted.base[DATA_NAMESPACES.FILES]) {
                            persisted.base[DATA_NAMESPACES.FILES] = {};
                        }
                        persisted.base[DATA_NAMESPACES.FILES][name] = {
                            source: 'card-import',
                            content,
                        };
                        invalidateHeadIndex();
                    } else {
                        dataStore.stageSet(DATA_NAMESPACES.FILES, name, 'card-import', content);
                    }
                }
                filesImported += 1;
            }

            if (filesImported > 0) {
                bridge.saveChatDebounced();
                try {
                    await saveMetadata();
                } catch {
                    // Ignore when ST backend metadata save is unavailable in test stubs.
                }
            }
        }
    }

    const charLabel = resolved.character.name || resolved.character.avatar || `#${resolved.chid}`;
    const legacyTag = migration.fromLegacy ? '（已自动迁移旧版 cg_embed_*）' : '';
    const message = `已从角色卡「${charLabel}」导入 ${presetsImported} 套预设与 ${filesImported} 个工作区文件${legacyTag}`;

    const shouldIncludeReport =
        migration.fromLegacy
        || migration.report.skippedItems.length > 0
        || migration.report.warnings.length > 0;

    return {
        presetsImported,
        filesImported,
        ...(shouldIncludeReport ? { report: migration.report } : {}),
        message,
    };
}

function showMigrationReportSoon(
    store: AppStore,
    title: string,
    result: ImportEmbeddedCardResult,
): void {
    if (!result.report) {
        return;
    }
    const report = result.report;
    globalThis.setTimeout(() => {
        store.openModal({
            kind: 'migration_report',
            title,
            report,
            summary: result.message,
        });
    }, 0);
}

async function openLinkPresetFlow(): Promise<void> {
    const store = getActiveStore();
    const resolved = resolveCharacter();
    if (!resolved) {
        store.pushToast(tr('请先打开一张角色卡。', 'No active character selected.'), 'warning');
        return;
    }

    const activePreset = store.getActivePreset();
    const status = await getEmbeddedCardStatus(resolved.chid);
    const charName = status.characterName;
    const existingNote = status.hasPresets
        ? `\n\n当前角色卡已包含 ${status.presetCount} 套内嵌预设${status.fromLegacy ? '（来自旧版 cg_embed_presets，写入后将升级为 agentic_embed_presets）' : ''}，确认后将更新为当前预设。`
        : '';

    store.openConsole();
    store.openModal({
        kind: 'confirm',
        title: tr('关联预设到角色卡', 'Link Preset to Card'),
        message:
            `将当前预设「${activePreset.name}」嵌入角色卡「${charName}」？\n`
            + `写入时将自动通过 exportPreset/normalizePreset 剥离 API Key，并同步更新角色卡三处数据镜像。`
            + existingNote,
        confirmLabel: tr('确认嵌入', 'Embed Preset'),
        cancelLabel: tr('取消', 'Cancel'),
        onConfirm: async () => {
            const msg = await embedPresetToCard(activePreset, resolved.chid, { store });
            store.pushToast(msg, 'success');
        },
    });
}

async function openImportPresetFlow(): Promise<void> {
    const store = getActiveStore();
    const resolved = resolveCharacter();
    if (!resolved) {
        store.pushToast(tr('请先打开一张角色卡。', 'No active character selected.'), 'warning');
        return;
    }

    const status = await getEmbeddedCardStatus(resolved.chid);
    store.openConsole();

    if (!status.hasPresets) {
        store.openModal({
            kind: 'info',
            title: tr('导入角色卡预设', 'Import Card Preset'),
            message: tr('该角色卡尚未嵌入任何预设。', 'No linked presets'),
        });
        return;
    }

    const legacyHint = status.fromLegacy
        ? '\n检测到旧版 cg_embed_presets 数据，导入时将自动无损迁移至 ST-Agentic 格式并生成迁移报告。'
        : '';

    store.openModal({
        kind: 'confirm',
        title: tr('导入角色卡预设', 'Import Card Preset'),
        message:
            `角色卡「${status.characterName}」内嵌了 ${status.presetCount} 套预设。是否立即导入并设为当前预设？`
            + legacyHint,
        confirmLabel: tr('立即导入', 'Import'),
        cancelLabel: tr('取消', 'Cancel'),
        onConfirm: async () => {
            const res = await importEmbeddedFromCard(resolved.chid, {
                presetsOnly: true,
                store,
            });
            store.pushToast(res.message, 'success');
            showMigrationReportSoon(
                store,
                tr('角色卡预设迁移报告', 'Character Card Migration Report'),
                res,
            );
        },
    });
}

async function openLinkFilesFlow(): Promise<void> {
    const store = getActiveStore();
    const bridge = getActiveBridge();
    const dataStore = getActiveDataStore(undefined, bridge);
    const resolved = resolveCharacter();
    if (!resolved) {
        store.pushToast(tr('请先打开一张角色卡。', 'No active character selected.'), 'warning');
        return;
    }

    const activePreset = store.getActivePreset();
    const cardMigration = runEmbeddedMigration(resolved.character);
    const mergedFiles: Record<string, string> = {};

    // 1. Current chat workspace files.
    for (const [name, content] of collectWorkspaceFileMap(dataStore, bridge).entries()) {
        mergedFiles[name] = content;
    }
    // 2. Active preset `/preset/*` files.
    for (const [name, content] of Object.entries(activePreset.files ?? {})) {
        if (mergedFiles[name] === undefined) {
            mergedFiles[name] = content;
        }
    }
    // 3. Previously embedded card files (so existing card assets are preserved).
    for (const [name, content] of Object.entries(cardMigration.filesPayload?.files ?? {})) {
        if (mergedFiles[name] === undefined) {
            mergedFiles[name] = content;
        }
    }

    const normalized = normalizeFileMap(mergedFiles);
    const entries = Object.entries(normalized);
    store.openConsole();

    if (entries.length === 0) {
        store.openModal({
            kind: 'info',
            title: tr('关联文件到角色卡', 'Link Files to Card'),
            message: tr(
                '当前对话工作区、当前预设及角色卡中均没有可嵌入的文件。',
                'No files available to embed.',
            ),
        });
        return;
    }

    const totalBytes = measureFileMapBytes(normalized);
    if (totalBytes > DEFAULT_FILE_MAP_SIZE_LIMIT) {
        const largest = entries
            .sort(([, a], [, b]) => b.length - a.length)
            .slice(0, 3)
            .map(([name, content]) => `${name} (${formatByteSize(content.length)})`)
            .join('、');
        const msg =
            `待嵌入文件总体积 ${formatByteSize(totalBytes)} 超出角色卡 PNG 安全上限 `
            + `(${Math.floor(DEFAULT_FILE_MAP_SIZE_LIMIT / 1024)} KB)。最大文件：${largest}。`;
        store.pushToast(msg, 'error');
        store.openModal({
            kind: 'info',
            title: tr('文件体积超限', 'Files Size Limit Exceeded'),
            message: msg,
        });
        return;
    }

    const previewList = entries
        .slice(0, 8)
        .map(([name, content]) => `• ${name} (${formatByteSize(content.length)})`)
        .join('\n');
    const overflowNote = entries.length > 8 ? `\n… 共 ${entries.length} 个文件` : '';

    store.openModal({
        kind: 'confirm',
        title: tr('关联文件到角色卡', 'Link Files to Card'),
        message:
            `将以下 ${entries.length} 个文件（总计 ${formatByteSize(totalBytes)}）写入角色卡「${resolved.character.name}」？\n\n`
            + previewList
            + overflowNote,
        confirmLabel: tr('确认写入', 'Embed Files'),
        cancelLabel: tr('取消', 'Cancel'),
        onConfirm: async () => {
            const msg = await embedFilesToCard(normalized, resolved.chid);
            store.pushToast(msg, 'success');
        },
    });
}

async function openImportFilesFlow(): Promise<void> {
    const store = getActiveStore();
    const bridge = getActiveBridge();
    const dataStore = getActiveDataStore(undefined, bridge);
    const resolved = resolveCharacter();
    if (!resolved) {
        store.pushToast(tr('请先打开一张角色卡。', 'No active character selected.'), 'warning');
        return;
    }

    const migration = runEmbeddedMigration(resolved.character);
    const embeddedFiles = migration.filesPayload?.files ?? {};
    const names = Object.keys(embeddedFiles);
    store.openConsole();

    if (names.length === 0) {
        store.openModal({
            kind: 'info',
            title: tr('导入角色卡文件', 'Import Card Files'),
            message: tr('该角色卡尚未嵌入任何工作区文件。', 'No linked files'),
        });
        return;
    }

    const existingWorkspace = collectWorkspaceFileMap(dataStore, bridge);
    const conflicts = names.filter((name) => existingWorkspace.has(name));
    const conflictNote = conflicts.length > 0
        ? `\n\n注意：以下 ${conflicts.length} 个同名文件已存在于当前对话工作区，确认导入将覆盖它们：\n${conflicts.slice(0, 6).map((n) => `• ${n}`).join('\n')}`
        : '';

    store.openModal({
        kind: 'confirm',
        title: tr('导入角色卡文件', 'Import Card Files'),
        message:
            `角色卡「${resolved.character.name}」携带 ${names.length} 个工作区初始文件：\n`
            + `${names.slice(0, 8).map((n) => `• ${n}`).join('\n')}`
            + (names.length > 8 ? `\n… 等共 ${names.length} 个文件` : '')
            + conflictNote,
        confirmLabel: tr('导入到工作区', 'Import Files'),
        cancelLabel: tr('取消', 'Cancel'),
        onConfirm: async () => {
            const res = await importEmbeddedFromCard(resolved.chid, {
                filesOnly: true,
                overwriteExisting: true,
                store,
                bridge,
                dataStore,
            });
            store.pushToast(res.message, 'success');
        },
    });
}

async function handleDropdownAction(optionId: string): Promise<void> {
    const now = Date.now();
    if (
        lastHandledDropdownAction
        && lastHandledDropdownAction.id === optionId
        && now - lastHandledDropdownAction.timestamp < DROPDOWN_DEDUP_WINDOW_MS
    ) {
        return;
    }
    lastHandledDropdownAction = { id: optionId, timestamp: now };

    switch (optionId) {
        case AGENTIC_CARD_MENU_IDS.LINK_PRESET:
            await openLinkPresetFlow();
            break;
        case AGENTIC_CARD_MENU_IDS.IMPORT_PRESET:
            await openImportPresetFlow();
            break;
        case AGENTIC_CARD_MENU_IDS.LINK_FILES:
            await openLinkFilesFlow();
            break;
        case AGENTIC_CARD_MENU_IDS.IMPORT_FILES:
            await openImportFilesFlow();
            break;
        default:
            break;
    }
}

function injectDropdownOptions(): HTMLSelectElement | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const select = document.querySelector<HTMLSelectElement>(DROPDOWN_SELECTOR);
    if (!select) {
        return null;
    }

    for (const item of CARD_MENU_OPTIONS) {
        if (!select.querySelector(`#${item.id}`)) {
            const option = document.createElement('option');
            option.id = item.id;
            option.value = item.id;
            option.setAttribute('data-i18n', item.i18nKey);
            option.textContent = tr(item.fallbackLabel, item.i18nKey);
            select.appendChild(option);
        }
    }

    return select;
}

async function promptEmbeddedDataForCharacter(chid?: number | string): Promise<void> {
    const resolved = resolveCharacter(chid);
    if (!resolved) {
        return;
    }

    const status = await getEmbeddedCardStatus(resolved.chid);
    if (!status.hasPresets && !status.hasFiles) {
        return;
    }

    const avatarKey = resolved.character.avatar || String(resolved.chid);
    const checkKey = `${AUTO_PROMPT_PREFIX}${avatarKey}`;
    if (readAccountStorageItem(checkKey)) {
        return;
    }

    const allowDialog = power_user?.world_import_dialog ?? true;
    if (!allowDialog) {
        return;
    }

    const store = getActiveStore();
    if (store.getSnapshot().activeModal) {
        return;
    }

    writeAccountStorageItem(checkKey, 'true');

    const parts: string[] = [];
    if (status.hasPresets) {
        parts.push(`${status.presetCount} 套预设`);
    }
    if (status.hasFiles) {
        parts.push(`${status.fileCount} 个工作区初始文件`);
    }
    const legacyNotice = status.fromLegacy
        ? '\n检测到旧版 ST-CustomGeneration (cg_embed_*) 数据，将自动无损迁移至 ST-Agentic。'
        : '';

    store.openConsole();
    store.openModal({
        kind: 'confirm',
        title: tr('发现角色卡嵌入数据', 'Embedded Card Data Detected'),
        message:
            `角色卡「${status.characterName}」携带了 ${parts.join(' 与 ')}。是否立即导入？`
            + legacyNotice
            + '\n\n如需稍后导入，可在角色面板「更多...」下拉菜单中选择「导入角色卡预设 / 导入角色卡文件」。',
        confirmLabel: status.fromLegacy ? tr('导入并迁移', 'Import & Migrate') : tr('立即导入', 'Import'),
        cancelLabel: tr('稍后再说', 'Later'),
        onConfirm: async () => {
            const res = await importEmbeddedFromCard(resolved.chid, { store });
            store.pushToast(res.message, 'success');
            showMigrationReportSoon(
                store,
                tr('角色卡嵌入迁移报告', 'Character Card Migration Report'),
                res,
            );
        },
    });
}

/**
 * Mount `#char-management-dropdown` character card embed options (`agentic-card-link`,
 * `agentic-card-import`, `agentic-card-link-files`, `agentic-card-import-files`),
 * bind dropdown selection handlers, and auto-prompt via Shadow DOM `AppStore` when opening
 * a character card that carries `agentic_embed_*` or legacy `cg_embed_*` payloads.
 */
export function setupEmbedCard(options: EmbedCardSetupOptions = {}): () => void {
    activeTeardown?.();
    boundOptions = { ...options };

    let disposed = false;
    let promptTimer: ReturnType<typeof setTimeout> | null = null;
    let boundSelect: HTMLSelectElement | null = null;

    const clearPendingPromptTimer = () => {
        if (promptTimer !== null) {
            clearTimeout(promptTimer);
            promptTimer = null;
        }
    };

    const onSelectChange = (event: Event) => {
        const selectEl = event.currentTarget as HTMLSelectElement | null;
        if (!selectEl) {
            return;
        }
        const selectedOption = selectEl.options[selectEl.selectedIndex];
        const targetId = selectedOption?.id || selectEl.value || '';
        const isKnown = CARD_MENU_OPTIONS.some((item) => item.id === targetId);
        if (!isKnown) {
            return;
        }
        if (selectEl.options.length > 0) {
            selectEl.selectedIndex = 0;
        }
        void handleDropdownAction(targetId);
    };

    const ensureDropdownBound = () => {
        const select = injectDropdownOptions();
        if (select && select !== boundSelect) {
            boundSelect?.removeEventListener('change', onSelectChange);
            select.addEventListener('change', onSelectChange);
            boundSelect = select;
        }
    };

    const onEditorOpened = (chid?: number | string) => {
        if (disposed) {
            return;
        }
        ensureDropdownBound();
        clearPendingPromptTimer();
        const delayMs = Math.max(0, options.autoPromptDelayMs ?? DEFAULT_AUTO_PROMPT_DELAY_MS);
        promptTimer = globalThis.setTimeout(() => {
            promptTimer = null;
            if (!disposed) {
                void promptEmbeddedDataForCharacter(chid);
            }
        }, delayMs);
    };

    const onDropdownEvent = (selectedId: unknown) => {
        if (disposed || typeof selectedId !== 'string') {
            return;
        }
        if (CARD_MENU_OPTIONS.some((item) => item.id === selectedId)) {
            void handleDropdownAction(selectedId);
        }
    };

    eventSource.on(event_types.CHARACTER_EDITOR_OPENED, onEditorOpened);
    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, onDropdownEvent);
    ensureDropdownBound();

    const teardown = () => {
        if (disposed) {
            return;
        }
        disposed = true;
        clearPendingPromptTimer();
        boundSelect?.removeEventListener('change', onSelectChange);
        boundSelect = null;
        eventSource.removeListener(event_types.CHARACTER_EDITOR_OPENED, onEditorOpened);
        eventSource.removeListener(event_types.CHARACTER_MANAGEMENT_DROPDOWN, onDropdownEvent);
        if (activeTeardown === teardown) {
            activeTeardown = null;
        }
    };

    activeTeardown = teardown;
    return teardown;
}
