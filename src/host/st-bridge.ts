import {
    addCopyToCodeBlocks,
    addOneMessage,
    appendMediaToMessage,
    characters,
    chat,
    chat_metadata,
    deleteMessage,
    getCharacterCardFields,
    messageFormatting,
    name1,
    name2,
    refreshSwipeButtons,
    saveChatDebounced,
    saveSettingsDebounced,
    substituteParams,
    syncMesToSwipe,
    this_chid,
    updateMessageBlock,
    updateViewMessageIds,
} from '@st/script.js';
import { MEDIA_SOURCE, MEDIA_TYPE } from '@st/scripts/constants.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import { extension_settings } from '@st/scripts/extensions.js';
import { user_avatar } from '@st/scripts/personas.js';
import { power_user } from '@st/scripts/power-user.js';
import { updateReasoningUI } from '@st/scripts/reasoning.js';
import { getCharaFilename } from '@st/scripts/utils.js';
import {
    loadWorldInfo,
    METADATA_KEY,
    selected_world_info,
    world_info,
} from '@st/scripts/world-info.js';

import type {
    CreateChatMessageInput,
    CreateChatMessageOptions,
    DeleteChatMessageOptions,
    DeletedChatMessageSnapshot,
    HostAdminBridge,
    HostAuthorBridge,
    HostBridge,
    HostIdentity,
    WriteChatMessageOptions,
} from '@/core/bridge';
import { resolveActivePreset } from '@/core/config';
import { applyRegexRules } from '@/core/regex';
import type { ChatDataStore } from '@/core/store';
import type {
    ChatMessageSnapshot,
    MediaAttachment,
    MessageTarget,
    RawLoreEntry,
    RegexRule,
    ReloadDisplayedMessagesOptions,
    ReloadDisplayedMessagesResult,
    Settings,
    SwipeDataSnapshot,
} from '@/core/types';
import { hashText } from '@/core/utils';
import { detectHostLuminanceFromCssVars } from '@/ui/store';

import { STAdminBridge } from './st-admin-bridge';
import { STAuthorBridge } from './st-author-bridge';

export const DEFAULT_EXTENSION_SETTINGS_KEY = 'Agentic';

const VALID_MACRO_IDENTIFIER = /^[a-zA-Z][\w-_]*$/;
const GETVAR_MACRO_PATTERN = /\{\{getvar::([^}]+)\}\}/gi;
const FILE_MACRO_PATTERN = /\{\{file::([^}]+)\}\}/gi;
const SINGLE_MACRO_TOKEN_PATTERN = /\{\{([^{}]+)\}\}/g;
const PRE_SUBSTITUTE_OVERRIDE_KEYS = new Set(['lastgenerationtype']);

const CHARACTER_NON_SETTING_KEYS = new Set(['name', 'avatar']);

export type EvaluateOptionalEjsHook = (
    text: string,
    vars: Record<string, unknown>,
) => Promise<string>;

export type ExecuteSlashCommandHook = (
    command: string,
    signal?: AbortSignal,
) => Promise<string>;

export interface STHostBridgeOptions {
    extensionKey?: string;
    getStore?: () => ChatDataStore | undefined;
    getSettings?: () => Settings | undefined;
    resolveFileMacroSync?: (path: string) => string;
    evaluateOptionalEjs?: EvaluateOptionalEjsHook;
    executeSlashCommand?: ExecuteSlashCommandHook;
}

interface RawStLoreEntry {
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
    order?: number;
    position?: number | string;
    depth?: number;
    role?: number;
    disable?: boolean;
    enabled?: boolean;
    probability?: number;
    useProbability?: boolean;
    scanDepth?: number;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | number | null;
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
        return rawUid;
    }
    if (typeof rawUid === 'string') {
        const parsed = Number.parseInt(rawUid, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}

function cloneChatSnapshot(raw: unknown, index: number): ChatMessageSnapshot {
    const msg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const swipes = Array.isArray(msg.swipes)
        ? msg.swipes.map((item) => String(item ?? ''))
        : undefined;
    const swipeInfo = Array.isArray(msg.swipe_info)
        ? (msg.swipe_info.map((info) =>
              info && typeof info === 'object' ? { ...(info as Record<string, unknown>) } : {},
          ) as SwipeDataSnapshot[])
        : undefined;
    const extra =
        msg.extra && typeof msg.extra === 'object'
            ? { ...(msg.extra as Record<string, unknown>) }
            : undefined;
    const variables = Array.isArray(msg.variables)
        ? (msg.variables as Record<string, unknown>[])
        : undefined;

    return {
        id: index,
        name: typeof msg.name === 'string' ? msg.name : '',
        isUser: Boolean(msg.is_user),
        ...(msg.is_system !== undefined ? { isSystem: Boolean(msg.is_system) } : {}),
        mes: typeof msg.mes === 'string' ? msg.mes : String(msg.mes ?? ''),
        swipeId: typeof msg.swipe_id === 'number' ? msg.swipe_id : 0,
        ...(swipes ? { swipes } : {}),
        ...(swipeInfo ? { swipeInfo } : {}),
        ...(typeof msg.send_date === 'string' || typeof msg.send_date === 'number'
            ? { sendDate: msg.send_date }
            : {}),
        ...(extra ? { extra } : {}),
        ...(variables ? { variables } : {}),
    };
}

function convertStLoreEntry(worldName: string, rawInput: unknown, fallbackIndex: number): RawLoreEntry {
    const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as RawStLoreEntry;
    const keys = normalizeStringArray(raw.key ?? raw.keys);
    const keysecondary = normalizeStringArray(raw.keysecondary ?? raw.secondaryKeys);

    return {
        world: worldName,
        uid: parseNumericUid(raw.uid, fallbackIndex),
        comment: typeof raw.comment === 'string' ? raw.comment : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        keys,
        keysecondary,
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
    };
}

function resolveMediaType(mediaType?: MediaAttachment['type']): string {
    switch (mediaType) {
        case 'video':
            return MEDIA_TYPE?.VIDEO ?? 'video';
        case 'audio':
            return MEDIA_TYPE?.AUDIO ?? 'audio';
        case 'image':
        default:
            return MEDIA_TYPE?.IMAGE ?? 'image';
    }
}

function collectDisplayRegexRules(settings?: Settings): RegexRule[] {
    if (!settings) {
        return [];
    }
    const preset = resolveActivePreset(settings);
    return Array.isArray(preset?.regexRules) ? preset.regexRules : [];
}

function wrapWithJQuery(element: HTMLElement): JQuery<HTMLElement> | null {
    const jq = (globalThis as { $?: (target: HTMLElement) => JQuery<HTMLElement> }).$;
    if (typeof jq === 'function') {
        return jq(element);
    }
    return null;
}

function cloneHostValue<T>(value: T): T {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value)) as T;
    }
}

function getDisplayedChatFirstId(): number | null {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
        return null;
    }
    const ids = Array.from(document.querySelectorAll<HTMLElement>('#chat .mes'))
        .map((el) => Number(el.getAttribute('mesid')))
        .filter((id) => Number.isFinite(id));
    return ids.length > 0 ? Math.min(...ids) : null;
}

function renumberDisplayedChatMessages(startIndex: number): void {
    if (typeof updateViewMessageIds === 'function') {
        // SillyTavern's JS lacks a @param JSDoc for `startIndex`, inferring `null | undefined`.
        (updateViewMessageIds as unknown as (startIndex?: number | null) => void)(startIndex);
        return;
    }
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') {
        return;
    }
    const elements = Array.from(document.querySelectorAll<HTMLElement>('#chat .mes'));
    elements.forEach((el, index) => {
        const nextId = startIndex + index;
        el.setAttribute('mesid', String(nextId));
        const idEl = el.querySelector<HTMLElement>('.mesIDDisplay');
        if (idEl) {
            idEl.textContent = `#${nextId}`;
        }
        el.classList.toggle('last_mes', index === elements.length - 1);
    });
}

/**
 * Thin SillyTavern implementation of `HostBridge`.
 * Isolates all `@st/*` runtime dependencies behind the core bridge contract.
 */
export class STHostBridge implements HostBridge {
    private readonly extensionKey: string;
    private getStoreFn?: () => ChatDataStore | undefined;
    private getSettingsFn?: () => Settings | undefined;
    private resolveFileMacroSyncFn?: (path: string) => string;
    private onAgenticSettingsReloadFn?: () => Promise<void> | void;
    private cachedLorebooks = new Map<string, RawLoreEntry[]>();

    evaluateOptionalEjs?: EvaluateOptionalEjsHook;
    executeSlashCommand?: ExecuteSlashCommandHook;
    readonly author: HostAuthorBridge;
    readonly admin: HostAdminBridge;

    constructor(options: STHostBridgeOptions = {}) {
        this.extensionKey = options.extensionKey ?? DEFAULT_EXTENSION_SETTINGS_KEY;
        this.getStoreFn = options.getStore;
        this.getSettingsFn = options.getSettings;
        this.resolveFileMacroSyncFn = options.resolveFileMacroSync;
        if (options.evaluateOptionalEjs) {
            this.evaluateOptionalEjs = options.evaluateOptionalEjs;
        }
        if (options.executeSlashCommand) {
            this.executeSlashCommand = options.executeSlashCommand;
        }
        this.author = new STAuthorBridge({
            getSettings: () => this.getSettingsFn?.(),
            getStore: () => this.getStoreFn?.(),
        });
        this.admin = new STAdminBridge({
            getExecuteSlashCommand: () => this.executeSlashCommand,
            onAgenticSettingsPatched: () => this.onAgenticSettingsReloadFn?.(),
            reloadDisplayedMessages: (opts) => this.reloadDisplayedMessages(opts),
        });
    }

    /** Register a callback invoked when STAdminBridge patches extension_settings.Agentic. */
    setAgenticSettingsReloadHook(hook: () => Promise<void> | void): void {
        this.onAgenticSettingsReloadFn = hook;
    }

    /** Attach `ChatDataStore` after bridge construction. */
    setStore(store: ChatDataStore): void {
        this.getStoreFn = () => store;
    }

    /** Retrieve the attached `ChatDataStore`, if configured. */
    getStore(): ChatDataStore | undefined {
        return this.getStoreFn?.();
    }

    /** Attach a reactive settings getter after bridge construction. */
    setSettingsGetter(getter: () => Settings | undefined): void {
        this.getSettingsFn = getter;
    }

    /** Register synchronous `{{file::path}}` resolver fallback. */
    setFileMacroResolver(resolver: (path: string) => string): void {
        this.resolveFileMacroSyncFn = resolver;
    }

    /** Attach optional host bridges (`ejs-adapter`, `slash-bridge`) without static imports. */
    setOptionalHooks(hooks: {
        evaluateOptionalEjs?: EvaluateOptionalEjsHook;
        executeSlashCommand?: ExecuteSlashCommandHook;
    }): void {
        if (hooks.evaluateOptionalEjs) {
            this.evaluateOptionalEjs = hooks.evaluateOptionalEjs;
        }
        if (hooks.executeSlashCommand) {
            this.executeSlashCommand = hooks.executeSlashCommand;
        }
    }

    /** Return cached lorebook snapshot map from the latest `listEnabledLorebooks()` scan. */
    getCachedLorebooks(): Map<string, RawLoreEntry[]> {
        return new Map(this.cachedLorebooks);
    }

    getChat(): ChatMessageSnapshot[] {
        if (!Array.isArray(chat)) {
            return [];
        }
        return chat.map((entry, idx) => cloneChatSnapshot(entry, idx));
    }

    getMetadata(): Record<string, unknown> {
        if (chat_metadata && typeof chat_metadata === 'object') {
            return chat_metadata as Record<string, unknown>;
        }
        return {};
    }

    saveChatDebounced(): void {
        saveChatDebounced();
    }

    readChatMessage(target: MessageTarget): string | null {
        if (
            !Array.isArray(chat) ||
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return null;
        }
        const msg = chat[target.messageId] as Record<string, unknown> | undefined;
        if (!msg) {
            return null;
        }
        if (Array.isArray(msg.swipes) && target.swipeId < msg.swipes.length) {
            const rawSwipe = msg.swipes[target.swipeId];
            return typeof rawSwipe === 'string' ? rawSwipe : '';
        }
        if (target.swipeId === 0 && (!Array.isArray(msg.swipes) || msg.swipes.length === 0)) {
            return typeof msg.mes === 'string' ? msg.mes : '';
        }
        return null;
    }

    async writeChatMessage(
        target: MessageTarget,
        content: string,
        options?: WriteChatMessageOptions,
    ): Promise<void> {
        if (
            !Array.isArray(chat) ||
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return;
        }
        const msg = chat[target.messageId] as Record<string, unknown> | undefined;
        if (!msg) {
            return;
        }

        const swipes = Array.isArray(msg.swipes)
            ? (msg.swipes as unknown[])
            : ((msg.swipes = [typeof msg.mes === 'string' ? msg.mes : '']) as unknown[]);
        const swipeInfo = Array.isArray(msg.swipe_info)
            ? (msg.swipe_info as Array<Record<string, unknown>>)
            : ((msg.swipe_info = []) as Array<Record<string, unknown>>);

        while (swipes.length <= target.swipeId) {
            swipes.push('');
        }
        while (swipeInfo.length <= target.swipeId) {
            swipeInfo.push({});
        }

        swipes[target.swipeId] = content;

        const activeSwipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (activeSwipeId === target.swipeId) {
            msg.mes = content;
            this.renderDisplayView(target.messageId, msg, content);
        }

        saveChatDebounced();

        if (options?.emitEvent && event_types.MESSAGE_UPDATED) {
            await eventSource.emit(event_types.MESSAGE_UPDATED, target.messageId);
        }
    }

    async createChatMessage(
        input: CreateChatMessageInput,
        options?: CreateChatMessageOptions,
    ): Promise<ChatMessageSnapshot> {
        if (!Array.isArray(chat)) {
            throw new Error('SillyTavern chat array is not available.');
        }

        const targetIndex = input.insertAt === undefined ? chat.length : Math.floor(input.insertAt);
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > chat.length) {
            throw new Error(
                `Invalid insertAt index ${String(input.insertAt)} for chat length ${chat.length}.`,
            );
        }

        const identity = this.getActiveIdentity();
        const isUser = input.role === 'user';
        const isSystem = input.hidden !== undefined ? Boolean(input.hidden) : input.role === 'system';
        const resolvedName =
            input.name?.trim()
            || (isUser
                ? identity.userName || 'User'
                : input.role === 'system'
                  ? 'System'
                  : identity.charName || 'Assistant');
        const sendDate = input.sendDate ?? new Date().toISOString();
        const swipes =
            Array.isArray(input.swipes) && input.swipes.length > 0
                ? input.swipes.map((s) => String(s ?? ''))
                : [input.content];
        const swipeId =
            input.swipeId !== undefined && Number.isInteger(input.swipeId)
                ? Math.max(0, Math.min(input.swipeId, swipes.length - 1))
                : 0;
        const activeMes = swipes[swipeId] ?? input.content;

        let rawMsg: Record<string, unknown>;
        if (input.rawFields && typeof input.rawFields === 'object') {
            rawMsg = cloneHostValue(input.rawFields);
            if (typeof rawMsg.name !== 'string') {
                rawMsg.name = resolvedName;
            }
            if (rawMsg.is_user === undefined) {
                rawMsg.is_user = isUser;
            }
            if (rawMsg.is_system === undefined) {
                rawMsg.is_system = isSystem;
            }
            if (typeof rawMsg.mes !== 'string') {
                rawMsg.mes = activeMes;
            }
            if (rawMsg.send_date === undefined) {
                rawMsg.send_date = sendDate;
            }
        } else {
            const extra =
                input.extra && typeof input.extra === 'object' ? cloneHostValue(input.extra) : {};
            const swipeInfo: Array<Record<string, unknown>> = Array.isArray(input.swipeInfo)
                ? input.swipeInfo.map((info) =>
                      info && typeof info === 'object'
                          ? cloneHostValue(info as Record<string, unknown>)
                          : {},
                  )
                : [];
            while (swipeInfo.length < swipes.length) {
                swipeInfo.push({
                    send_date: sendDate,
                    extra: cloneHostValue(extra),
                });
            }

            rawMsg = {
                name: resolvedName,
                is_user: isUser,
                is_system: isSystem,
                send_date: sendDate,
                mes: activeMes,
                swipe_id: swipeId,
                swipes,
                swipe_info: swipeInfo,
                extra,
                ...(Array.isArray(input.variables)
                    ? { variables: cloneHostValue(input.variables) }
                    : {}),
            };
        }

        const isAppend = targetIndex === chat.length;
        const hasQuerySelector =
            typeof document !== 'undefined' && typeof document.querySelector === 'function';
        const firstDisplayedId = !isAppend && hasQuerySelector ? getDisplayedChatFirstId() : null;
        const hasAnchorEl =
            !isAppend && hasQuerySelector
                ? Boolean(document.querySelector(`#chat .mes[mesid="${targetIndex}"]`))
                : false;

        if (isAppend) {
            chat.push(rawMsg);
        } else {
            chat.splice(targetIndex, 0, rawMsg);
        }

        if (chat_metadata && typeof chat_metadata === 'object') {
            (chat_metadata as Record<string, unknown>).tainted = true;
        }

        // Update ST chat DOM in-place without reloadCurrentChat() (which emits CHAT_CHANGED and aborts the assistant).
        if (isAppend) {
            if (typeof addOneMessage === 'function') {
                addOneMessage(rawMsg, { scroll: true, showSwipes: true });
            }
        } else if (typeof document !== 'undefined') {
            if (hasAnchorEl) {
                if (typeof addOneMessage === 'function') {
                    addOneMessage(rawMsg, {
                        insertBefore: targetIndex,
                        forceId: targetIndex,
                        scroll: false,
                        showSwipes: true,
                    });
                }
                renumberDisplayedChatMessages(firstDisplayedId ?? targetIndex);
            } else if (firstDisplayedId !== null && targetIndex < firstDisplayedId) {
                renumberDisplayedChatMessages(firstDisplayedId + 1);
            } else if (typeof addOneMessage === 'function') {
                addOneMessage(rawMsg, {
                    forceId: targetIndex,
                    scroll: false,
                    showSwipes: true,
                });
            }
        } else {
            if (typeof addOneMessage === 'function') {
                addOneMessage(rawMsg, {
                    insertBefore: targetIndex,
                    forceId: targetIndex,
                    scroll: false,
                    showSwipes: true,
                });
            }
            renumberDisplayedChatMessages(0);
        }

        if (collectDisplayRegexRules(this.getSettingsFn?.()).length > 0) {
            this.renderDisplayView(
                targetIndex,
                rawMsg,
                typeof rawMsg.mes === 'string' ? rawMsg.mes : '',
            );
        }

        saveChatDebounced();

        if (options?.emitEvent !== false && typeof eventSource?.emit === 'function') {
            if (rawMsg.is_user) {
                if (event_types?.MESSAGE_SENT) {
                    await eventSource.emit(event_types.MESSAGE_SENT, targetIndex);
                }
            } else if (event_types?.MESSAGE_RECEIVED) {
                // Intentionally emit MESSAGE_RECEIVED (not CHARACTER_MESSAGE_RENDERED) so post-turn companion agents do not fire.
                await eventSource.emit(event_types.MESSAGE_RECEIVED, targetIndex, 'extension');
            }
        }

        return cloneChatSnapshot(rawMsg, targetIndex);
    }

    async deleteChatMessage(
        messageId: number,
        options?: DeleteChatMessageOptions,
    ): Promise<DeletedChatMessageSnapshot | null> {
        if (
            !Array.isArray(chat) ||
            !Number.isInteger(messageId) ||
            messageId < 0 ||
            messageId >= chat.length
        ) {
            return null;
        }
        const rawMsg = chat[messageId] as Record<string, unknown> | undefined;
        if (!rawMsg) {
            return null;
        }

        const snapshot = cloneChatSnapshot(rawMsg, messageId);
        const rawMessage = cloneHostValue(rawMsg);

        const mesEl =
            typeof document !== 'undefined' && typeof document.querySelector === 'function'
                ? document.querySelector<HTMLElement>(`#chat .mes[mesid="${messageId}"]`)
                : null;

        if (mesEl && options?.emitEvent !== false && typeof deleteMessage === 'function') {
            const prevLen = chat.length;
            await deleteMessage(messageId, undefined, false, false);
            if (chat.length === prevLen - 1) {
                return { messageId, snapshot, rawMessage };
            }
        }

        const firstDisplayedId =
            typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
                ? getDisplayedChatFirstId()
                : null;

        chat.splice(messageId, 1);

        if (typeof document !== 'undefined') {
            mesEl?.remove();
            if (firstDisplayedId !== null) {
                const nextStart =
                    messageId < firstDisplayedId
                        ? Math.max(0, firstDisplayedId - 1)
                        : firstDisplayedId;
                renumberDisplayedChatMessages(nextStart);
            }
        }

        if (chat_metadata && typeof chat_metadata === 'object') {
            (chat_metadata as Record<string, unknown>).tainted = true;
        }
        if (typeof refreshSwipeButtons === 'function') {
            refreshSwipeButtons();
        }
        saveChatDebounced();

        if (
            options?.emitEvent !== false &&
            event_types?.MESSAGE_DELETED &&
            typeof eventSource?.emit === 'function'
        ) {
            await eventSource.emit(event_types.MESSAGE_DELETED, chat.length);
        }

        return { messageId, snapshot, rawMessage };
    }

    getActiveIdentity(): HostIdentity {
        const currentChar = this.getActiveCharacter();
        const charFile =
            typeof getCharaFilename === 'function' ? getCharaFilename(this_chid) : '';
        const characterAvatar =
            (typeof currentChar?.avatar === 'string' && currentChar.avatar) || charFile || '';

        return {
            userName: typeof name1 === 'string' && name1 ? name1 : 'User',
            charName:
                (typeof name2 === 'string' && name2) ||
                (typeof currentChar?.name === 'string' ? currentChar.name : '') ||
                '',
            characterAvatar,
            personaAvatar: typeof user_avatar === 'string' ? user_avatar : '',
        };
    }

    getCharacterFields(): Record<string, string> {
        const result: Record<string, string> = {};
        const currentChar = this.getActiveCharacter();
        const v2 = (currentChar?.data && typeof currentChar.data === 'object'
            ? currentChar.data
            : {}) as Record<string, unknown>;
        const extensions = (v2.extensions && typeof v2.extensions === 'object'
            ? v2.extensions
            : {}) as Record<string, unknown>;
        const depthPrompt = (extensions.depth_prompt && typeof extensions.depth_prompt === 'object'
            ? extensions.depth_prompt
            : {}) as Record<string, unknown>;
        const sdPrompt = (extensions.sd_character_prompt && typeof extensions.sd_character_prompt === 'object'
            ? extensions.sd_character_prompt
            : {}) as Record<string, unknown>;

        const numericChid = Number(this_chid);
        const cardFields =
            typeof getCharacterCardFields === 'function'
                ? ((getCharacterCardFields({
                      chid: Number.isInteger(numericChid) && numericChid >= 0 ? numericChid : undefined,
                  }) as
                      | Record<string, unknown>
                      | undefined) ?? {})
                : {};

        const pickString = (...candidates: unknown[]): string => {
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim().length > 0) {
                    return candidate;
                }
            }
            for (const candidate of candidates) {
                if (typeof candidate === 'string') {
                    return candidate;
                }
            }
            return '';
        };

        const mapped: Record<string, string> = {
            description: pickString(v2.description, currentChar?.description, cardFields.description),
            personality: pickString(v2.personality, currentChar?.personality, cardFields.personality),
            scenario: pickString(v2.scenario, currentChar?.scenario, cardFields.scenario),
            mes_example: pickString(v2.mes_example, currentChar?.mes_example, cardFields.mesExamples),
            creator_notes: pickString(v2.creator_notes, currentChar?.creatorcomment),
            system_prompt: pickString(v2.system_prompt, cardFields.system),
            post_history_instructions: pickString(
                v2.post_history_instructions,
                cardFields.jailbreak,
            ),
            depth_prompt: pickString(depthPrompt.prompt, cardFields.charDepthPrompt),
            sd_character_prompt: pickString(sdPrompt.positive),
        };

        for (const [key, value] of Object.entries(mapped)) {
            if (!CHARACTER_NON_SETTING_KEYS.has(key) && value.length > 0) {
                result[key] = value;
            }
        }

        return result;
    }

    getPersonaDescription(): string {
        const personaMap = power_user?.persona_descriptions as
            | Record<string, { description?: unknown } | undefined>
            | undefined;
        const avatarKey = typeof user_avatar === 'string' ? user_avatar : '';
        const selected = avatarKey ? personaMap?.[avatarKey] : undefined;
        if (typeof selected?.description === 'string') {
            return selected.description;
        }
        return typeof power_user?.persona_description === 'string'
            ? power_user.persona_description
            : '';
    }

    async listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>> {
        const enabledNames = this.collectEnabledLorebookNames();
        const result = new Map<string, RawLoreEntry[]>();
        const nextCache = new Map<string, RawLoreEntry[]>();

        await Promise.all(
            enabledNames.map(async (bookName) => {
                try {
                    const data = (await loadWorldInfo(bookName)) as
                        | { entries?: Record<string, unknown> | unknown[] }
                        | null
                        | undefined;
                    if (!data?.entries) {
                        result.set(bookName, []);
                        nextCache.set(bookName, []);
                        return;
                    }

                    const entries: RawLoreEntry[] = Array.isArray(data.entries)
                        ? data.entries.map((entry, index) =>
                              convertStLoreEntry(bookName, entry, index),
                          )
                        : Object.entries(data.entries).map(([uidKey, entry], index) =>
                              convertStLoreEntry(
                                  bookName,
                                  entry,
                                  parseNumericUid(uidKey, index),
                              ),
                          );

                    result.set(bookName, entries);
                    nextCache.set(bookName, entries);
                } catch (error) {
                    console.warn(`[ST-Agentic] Failed to load lorebook "${bookName}":`, error);
                }
            }),
        );

        this.cachedLorebooks = nextCache;
        return result;
    }

    substituteMacros(text: string, overrides?: Record<string, string>): string {
        if (!text) {
            return '';
        }
        if (!text.includes('{{')) {
            return text;
        }

        let working = text;
        const dynamicMacros: Record<string, string> = {};
        const fallbackMap = new Map<string, string>();
        const preSubstituteMap = new Map<string, string>();

        if (overrides) {
            const presentTemplateMacros = new Set<string>();
            for (const match of working.matchAll(SINGLE_MACRO_TOKEN_PATTERN)) {
                presentTemplateMacros.add(match[1].trim().toLowerCase());
            }

            const varOverrides = new Map<string, string>();
            for (const [key, value] of Object.entries(overrides)) {
                if (key.startsWith('var:')) {
                    varOverrides.set(key.slice(4), value);
                    continue;
                }
                const lowerKey = key.toLowerCase();
                if (PRE_SUBSTITUTE_OVERRIDE_KEYS.has(lowerKey)) {
                    preSubstituteMap.set(lowerKey, value);
                    continue;
                }
                if (VALID_MACRO_IDENTIFIER.test(key)) {
                    dynamicMacros[key] = value;
                }
                if (presentTemplateMacros.has(lowerKey)) {
                    fallbackMap.set(lowerKey, value);
                }
            }

            if (varOverrides.size > 0) {
                working = working.replace(GETVAR_MACRO_PATTERN, (full, rawVarName: string) => {
                    const name = rawVarName.trim();
                    return varOverrides.has(name) ? (varOverrides.get(name) ?? '') : full;
                });
            }

            if (preSubstituteMap.size > 0 && working.includes('{{')) {
                working = working.replace(SINGLE_MACRO_TOKEN_PATTERN, (match, rawKey: string) => {
                    const lower = rawKey.trim().toLowerCase();
                    return preSubstituteMap.has(lower) ? (preSubstituteMap.get(lower) ?? '') : match;
                });
            }
        }

        const hasDynamicMacros = Object.keys(dynamicMacros).length > 0;
        if (!hasDynamicMacros) {
            working = substituteParams(working);
        } else if (substituteParams.length >= 2) {
            working = (substituteParams as (...args: unknown[]) => string)(
                working,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                dynamicMacros,
            );
        } else {
            working = substituteParams(working, { dynamicMacros });
        }

        if (this.resolveFileMacroSyncFn && FILE_MACRO_PATTERN.test(working)) {
            FILE_MACRO_PATTERN.lastIndex = 0;
            const resolveFile = this.resolveFileMacroSyncFn;
            working = working.replace(FILE_MACRO_PATTERN, (_full, rawPath: string) =>
                resolveFile(rawPath.trim()),
            );
        }

        if (fallbackMap.size > 0 && working.includes('{{')) {
            working = working.replace(SINGLE_MACRO_TOKEN_PATTERN, (match, rawKey: string) => {
                const lower = rawKey.trim().toLowerCase();
                return fallbackMap.has(lower) ? (fallbackMap.get(lower) ?? '') : match;
            });
        }

        return working;
    }

    async attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void> {
        if (!Array.isArray(chat) || target.messageId < 0 || target.messageId >= chat.length) {
            return;
        }

        const msg = chat[target.messageId] as Record<string, unknown> | undefined;
        if (!msg) {
            return;
        }

        const extraSource =
            media.extra && typeof media.extra.source === 'string'
                ? media.extra.source
                : undefined;
        const stMedia = {
            url: media.url,
            type: resolveMediaType(media.type),
            title: media.caption ?? media.name ?? '',
            source: extraSource ?? MEDIA_SOURCE?.GENERATED ?? 'generated',
        };

        const activeSwipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        const swipeInfoList = Array.isArray(msg.swipe_info)
            ? (msg.swipe_info as Array<Record<string, unknown>>)
            : undefined;

        if (swipeInfoList && target.swipeId >= 0 && target.swipeId < swipeInfoList.length) {
            const targetSwipeInfo = (swipeInfoList[target.swipeId] ??= {});
            const swipeExtra = ((targetSwipeInfo.extra ??= {}) as Record<string, unknown>);
            const swipeMedia = Array.isArray(swipeExtra.media)
                ? (swipeExtra.media as Array<{ url?: string }>)
                : ((swipeExtra.media = []) as Array<{ url?: string }>);
            if (!swipeMedia.some((item) => item.url === stMedia.url)) {
                swipeMedia.push({ ...stMedia });
            }
        }

        if (activeSwipeId !== target.swipeId) {
            saveChatDebounced();
            return;
        }

        const msgExtra = ((msg.extra ??= {}) as Record<string, unknown>);
        const mediaList = Array.isArray(msgExtra.media)
            ? (msgExtra.media as Array<{ url?: string }>)
            : ((msgExtra.media = []) as Array<{ url?: string }>);

        if (mediaList.some((item) => item.url === stMedia.url)) {
            return;
        }

        mediaList.push(stMedia);

        if (typeof document !== 'undefined' && typeof appendMediaToMessage === 'function') {
            const mesElement = document.querySelector<HTMLElement>(
                `#chat .mes[mesid="${target.messageId}"]`,
            );
            const jqElement = mesElement ? wrapWithJQuery(mesElement) : null;
            if (jqElement) {
                appendMediaToMessage(msg, jqElement);
            }
        }

        if (typeof syncMesToSwipe === 'function') {
            syncMesToSwipe();
        }
        saveChatDebounced();
    }

    async refreshMessageView(target: MessageTarget): Promise<void> {
        if (!Array.isArray(chat) || target.messageId < 0 || target.messageId >= chat.length) {
            return;
        }

        const msg = chat[target.messageId] as Record<string, unknown> | undefined;
        if (!msg) {
            return;
        }

        const activeSwipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (activeSwipeId !== target.swipeId) {
            return;
        }

        const swipes = Array.isArray(msg.swipes) ? (msg.swipes as unknown[]) : undefined;
        const swipeRaw =
            swipes && target.swipeId >= 0 && target.swipeId < swipes.length
                ? swipes[target.swipeId]
                : undefined;
        const baseText =
            typeof swipeRaw === 'string'
                ? swipeRaw
                : typeof msg.mes === 'string'
                  ? msg.mes
                  : '';

        this.renderDisplayView(target.messageId, msg, baseText);
    }

    async reloadDisplayedMessages(
        options?: ReloadDisplayedMessagesOptions,
    ): Promise<ReloadDisplayedMessagesResult> {
        if (!Array.isArray(chat) || chat.length === 0) {
            return {
                reloadedIds: [],
                skippedIds: Array.isArray(options?.messageIds) ? [...options.messageIds] : [],
                emittedEvents: 0,
            };
        }

        const limit =
            typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0
                ? Math.min(100, Math.floor(options.limit))
                : 50;
        const emitUpdateEvent = options?.emitUpdateEvent !== false;

        let candidateIds: number[] = [];
        if (Array.isArray(options?.messageIds) && options.messageIds.length > 0) {
            const seen = new Set<number>();
            for (const rawId of options.messageIds) {
                if (typeof rawId === 'number' && Number.isInteger(rawId) && !seen.has(rawId)) {
                    seen.add(rawId);
                    candidateIds.push(rawId);
                }
            }
        } else {
            if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
                const domIds = Array.from(document.querySelectorAll<HTMLElement>('#chat .mes[mesid]'))
                    .map((el) => Number.parseInt(el.getAttribute('mesid') ?? '', 10))
                    .filter((id) => Number.isInteger(id) && id >= 0 && id < chat.length)
                    .sort((a, b) => a - b);
                if (domIds.length > 0) {
                    candidateIds = Array.from(new Set(domIds)).slice(-limit);
                }
            }
            if (candidateIds.length === 0) {
                const start = Math.max(0, chat.length - limit);
                for (let id = start; id < chat.length; id += 1) {
                    candidateIds.push(id);
                }
            }
        }

        const reloadedIds: number[] = [];
        const skippedIds: number[] = [];
        let emittedEvents = 0;

        for (const messageId of candidateIds) {
            if (!Number.isInteger(messageId) || messageId < 0 || messageId >= chat.length) {
                skippedIds.push(messageId);
                continue;
            }
            const msg = chat[messageId] as Record<string, unknown> | undefined;
            if (!msg) {
                skippedIds.push(messageId);
                continue;
            }
            const swipeId = typeof msg.swipe_id === 'number' && msg.swipe_id >= 0 ? msg.swipe_id : 0;
            await this.refreshMessageView({ messageId, swipeId });
            reloadedIds.push(messageId);

            // Emit MESSAGE_UPDATED (NEVER CHARACTER_MESSAGE_RENDERED or CHAT_CHANGED)
            // so JS-Slash-Runner re-mounts frontend iframes without firing after_turn hooks.
            if (emitUpdateEvent && event_types?.MESSAGE_UPDATED && typeof eventSource?.emit === 'function') {
                await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
                emittedEvents += 1;
            }
        }

        return {
            reloadedIds,
            skippedIds,
            emittedEvents,
        };
    }

    /**
     * Render raw markdown into `.mes_text` with transient `display`-stage regexes and macros.
     * Never writes transformed HTML/display text back to `msg.mes` or `msg.swipes`.
     */
    private renderDisplayView(
        messageId: number,
        msg: Record<string, unknown>,
        rawText: string,
    ): void {
        const settings = this.getSettingsFn?.();
        const regexRules = collectDisplayRegexRules(settings);
        const sender = msg.is_user ? 'user' : 'assistant';
        const displayText =
            regexRules.length > 0
                ? this.substituteMacros(
                      applyRegexRules(rawText, regexRules, {
                          stage: 'display',
                          sender,
                      }),
                  )
                : rawText;

        if (typeof document === 'undefined') {
            return;
        }

        const mesElement = document.querySelector<HTMLElement>(
            `#chat .mes[mesid="${messageId}"]`,
        );
        if (!mesElement) {
            return;
        }

        const rawMesSnapshot = msg.mes;
        let updatedViaBlock = false;
        if (typeof updateMessageBlock === 'function') {
            const displayProxy = {
                ...msg,
                mes: displayText,
                extra: {
                    ...((msg.extra as Record<string, unknown> | undefined) ?? {}),
                    display_text: displayText,
                },
            };
            updateMessageBlock(messageId, displayProxy, { rerenderMessage: true });
            updatedViaBlock = true;
            if (msg.mes !== rawMesSnapshot) {
                msg.mes = rawMesSnapshot;
            }
        } else if (typeof messageFormatting === 'function') {
            const mesTextEl = mesElement.querySelector<HTMLElement>('.mes_text');
            if (mesTextEl) {
                mesTextEl.innerHTML = messageFormatting(
                    displayText,
                    typeof msg.name === 'string' ? msg.name : '',
                    Boolean(msg.is_system),
                    Boolean(msg.is_user),
                    messageId,
                );
            }
        }

        if (typeof updateReasoningUI === 'function') {
            updateReasoningUI(mesElement);
        }
        if (typeof addCopyToCodeBlocks === 'function') {
            const hasUncopiedCodeBlock = Array.from(
                mesElement.querySelectorAll('pre code'),
            ).some((codeEl) => !codeEl.querySelector('.code-copy'));
            if (!updatedViaBlock || hasUncopiedCodeBlock) {
                addCopyToCodeBlocks(mesElement);
            }
        }
    }

    async loadExtensionData<T>(key: string, fallback: T): Promise<T> {
        const extSettings = extension_settings as Record<string, unknown>;
        const bucket = extSettings?.[this.extensionKey] as
            | Record<string, unknown>
            | undefined;
        if (!bucket || !(key in bucket) || bucket[key] === undefined) {
            return fallback;
        }
        return bucket[key] as T;
    }

    async saveExtensionData<T>(key: string, value: T): Promise<void> {
        const extSettings = extension_settings as Record<string, unknown>;
        if (!extSettings[this.extensionKey] || typeof extSettings[this.extensionKey] !== 'object') {
            extSettings[this.extensionKey] = {};
        }
        (extSettings[this.extensionKey] as Record<string, unknown>)[key] = value;
        saveSettingsDebounced();
    }

    hashText(text: string): Promise<string> {
        return hashText(text);
    }

    getHostLuminance(): 'dark' | 'light' {
        return detectHostLuminanceFromCssVars();
    }

    emitHostEvent(event: string, payload?: unknown): void {
        if (typeof eventSource?.emit === 'function') {
            void eventSource.emit(event, payload);
        }
    }

    private getActiveCharacter(): Record<string, unknown> | undefined {
        const index = Number(this_chid);
        if (
            !Array.isArray(characters) ||
            !Number.isInteger(index) ||
            index < 0 ||
            index >= characters.length
        ) {
            return undefined;
        }
        return characters[index] as Record<string, unknown> | undefined;
    }

    private collectEnabledLorebookNames(): string[] {
        const seen = new Set<string>();
        const ordered: string[] = [];

        const pushBook = (name: unknown) => {
            if (typeof name === 'string') {
                const trimmed = name.trim();
                if (trimmed && !seen.has(trimmed)) {
                    seen.add(trimmed);
                    ordered.push(trimmed);
                }
            }
        };

        if (Array.isArray(selected_world_info)) {
            for (const name of selected_world_info) {
                pushBook(name);
            }
        }

        const currentChar = this.getActiveCharacter();
        const v2 = (currentChar?.data && typeof currentChar.data === 'object'
            ? currentChar.data
            : {}) as Record<string, unknown>;
        const extensions = (v2.extensions && typeof v2.extensions === 'object'
            ? v2.extensions
            : {}) as Record<string, unknown>;
        pushBook(extensions.world);

        const wiConfig = world_info as Record<string, unknown> | undefined;
        const charLoreList = wiConfig?.charLore as
            | Array<{ name?: string; extraBooks?: unknown[] }>
            | undefined;
        if (Array.isArray(charLoreList) && currentChar) {
            const charFile =
                typeof getCharaFilename === 'function' ? getCharaFilename(this_chid) : '';
            const avatarBase =
                typeof currentChar.avatar === 'string'
                    ? currentChar.avatar.replace(/\.[^/.]+$/, '')
                    : '';
            const match = charLoreList.find(
                (entry) =>
                    (charFile && entry.name === charFile) ||
                    (avatarBase && entry.name === avatarBase),
            );
            if (Array.isArray(match?.extraBooks)) {
                for (const extraName of match.extraBooks) {
                    pushBook(extraName);
                }
            }
        }

        const chatMeta = chat_metadata as Record<string, unknown> | undefined;
        if (chatMeta && METADATA_KEY) {
            pushBook(chatMeta[METADATA_KEY]);
        }

        const personaMap = power_user?.persona_descriptions as
            | Record<string, { lorebook?: unknown } | undefined>
            | undefined;
        const avatarKey = typeof user_avatar === 'string' ? user_avatar : '';
        if (avatarKey && personaMap?.[avatarKey]?.lorebook) {
            pushBook(personaMap[avatarKey]?.lorebook);
        }

        return ordered;
    }
}
