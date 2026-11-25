import type {
    CreateChatMessageInput,
    CreateChatMessageOptions,
    DeleteChatMessageOptions,
    DeletedChatMessageSnapshot,
    EjsEvaluateOptions,
    EjsFeaturesSnapshot,
    HostAdminBridge,
    HostAuthorBridge,
    HostBridge,
    HostIdentity,
    ListPresetsOptions,
    PromptInjectionSession,
    ReadHostSettingsOptions,
    SerializedPromptInjected,
    WriteChatMessageOptions,
} from '@/core/bridge';
import { LocalPromptInjectionSession, utf8ByteLength } from '@/core/context';
import type {
    AuthorUndoMeta,
    ChatMessageSnapshot,
    EmbedAgenticOptions,
    EmbedAgenticResult,
    HostCharacterCreatePayload,
    HostCharacterFull,
    HostCharacterPatch,
    HostCharacterSummary,
    HostExtensionCapabilities,
    HostImportUrlResult,
    HostPersonaEntry,
    HostPresetInfo,
    HostRegexScript,
    HostRuntimeSyncOptions,
    HostRuntimeSyncResult,
    HostSettingsScope,
    HostSyncTarget,
    HostSyncTargetReport,
    MediaAttachment,
    MessageTarget,
    RawLoreEntry,
    ReloadDisplayedMessagesOptions,
    ReloadDisplayedMessagesResult,
    TavernHelperScriptScope,
    TavernHelperScriptsReadResult,
    TavernHelperScriptsWriteResult,
    UpsertWorldInfoEntryOptions,
    WorldInfoBookSnapshot,
    WorldInfoEntryUpsert,
} from '@/core/types';
import { hashText as computeXxHash } from '@/core/utils';

export type EjsEvaluatorStub = (
    text: string,
    vars: Record<string, unknown>,
    options?: EjsEvaluateOptions,
) => Promise<string> | string;
export type SlashCommandStub = (command: string, signal?: AbortSignal) => Promise<string> | string;

export interface MemoryHostBridgeInit {
    chat?: ChatMessageSnapshot[];
    metadata?: Record<string, unknown>;
    identity?: Partial<HostIdentity>;
    characterFields?: Record<string, string>;
    personaDescription?: string;
    lorebooks?: Map<string, RawLoreEntry[]> | Record<string, RawLoreEntry[]>;
    disabledLorebooks?: Map<string, RawLoreEntry[]> | Record<string, RawLoreEntry[]>;
    primaryWorldName?: string | null;
    characters?: HostCharacterFull[];
    activeCharacterId?: number;
    scopedRegex?: HostRegexScript[];
    globalRegex?: HostRegexScript[];
    personas?: HostPersonaEntry[];
    presets?: HostPresetInfo[];
    hostSettings?: Record<string, Record<string, unknown>>;
    extensionData?: Record<string, unknown>;
    ejsEvaluator?: EjsEvaluatorStub;
    ejsFeatures?: EjsFeaturesSnapshot;
    injectionSessionMode?: 'native' | 'fallback';
    slashHandler?: SlashCommandStub;
    hostLuminance?: 'dark' | 'light';
    enableAuthorBridge?: boolean;
    enableAdminBridge?: boolean;
    extensionCapabilities?: Partial<HostExtensionCapabilities>;
}

const DEFAULT_MOCK_HOST_SETTINGS: Record<string, Record<string, unknown>> = {
    power_user: {
        theme: 'Dark',
        fast_ui_mode: true,
        api_key_custom: 'sk-test-power-user-secret-1234567890',
        proxy_authorization: 'Bearer tok_live_mock_9876543210abcdef',
    },
    extension_settings: {
        agentic: {
            runMode: 'takeover',
            apiKey: 'sk-ant-mock-agentic-key-abcdef',
        },
        tts: {
            provider: 'elevenlabs',
            token: 'el_mock_token_secret_xyz',
            headers: {
                Authorization: 'Bearer mock_tts_bearer_token_001',
            },
        },
        webhook: {
            endpoint: 'https://hooks.example.test/st',
            secret: 'whsec_mock_secret_value_42',
            password: 'mock-db-password-!@#',
            cookie: 'session=mock_cookie_secret',
        },
    },
};

export class MemoryHostBridge implements HostBridge {
    public chat: ChatMessageSnapshot[];
    public metadata: Record<string, unknown>;
    public identity: HostIdentity;
    public characterFields: Record<string, string>;
    public personaDescription: string;
    public lorebooks: Map<string, RawLoreEntry[]>;
    public disabledLorebooks: Map<string, RawLoreEntry[]>;
    public primaryWorldName: string | null;
    public characters: HostCharacterFull[];
    public activeCharacterId: number;
    public scopedRegex: HostRegexScript[];
    public globalRegex: HostRegexScript[];
    public personas: HostPersonaEntry[];
    public presets: HostPresetInfo[];
    public hostSettings: Record<string, Record<string, unknown>>;
    public extensionData: Map<string, unknown>;
    public hostLuminance: 'dark' | 'light';

    public saveChatCalls = 0;
    public writtenMessages: Array<{
        target: MessageTarget;
        content: string;
        options?: WriteChatMessageOptions;
    }> = [];
    public createdMessages: Array<{
        input: CreateChatMessageInput;
        createdId: number;
        options?: CreateChatMessageOptions;
    }> = [];
    public deletedMessages: Array<{
        messageId: number;
        snapshot: ChatMessageSnapshot;
        options?: DeleteChatMessageOptions;
    }> = [];
    public mediaAttachments: Array<{ target: MessageTarget; media: MediaAttachment }> = [];
    public refreshedViews: MessageTarget[] = [];
    public reloadedMessageBatches: Array<{
        reloadedIds: number[];
        skippedIds: number[];
        emitUpdateEvent: boolean;
    }> = [];
    public slashCalls: Array<{ command: string; aborted: boolean }> = [];
    public emittedEvents: Array<{ event: string; payload?: unknown }> = [];
    public embeddedPayloads: EmbedAgenticOptions[] = [];
    public importedUrls: string[] = [];
    public tavernHelperScripts: Record<TavernHelperScriptScope, Record<string, unknown>[]> = {
        global: [],
        character: [],
        preset: [],
    };
    public tavernHelperLiveApiAvailable = true;
    public extensionCapabilities: HostExtensionCapabilities;
    public runtimeSyncCalls: HostRuntimeSyncOptions[] = [];
    public characterPatchHistory: Array<{
        chid: number;
        fields: HostCharacterPatch;
        undoMeta?: AuthorUndoMeta;
    }> = [];

    public compatWarnings: Array<{ code: string; message: string }> = [];
    public ejsFeatures: EjsFeaturesSnapshot | null;
    public injectionSessionMode: 'native' | 'fallback';
    private reportedCompatCodes = new Set<string>();

    public evaluateOptionalEjs?: (
        text: string,
        vars: Record<string, unknown>,
        options?: EjsEvaluateOptions,
    ) => Promise<string>;
    public executeSlashCommand?: (command: string, signal?: AbortSignal) => Promise<string>;
    public author?: HostAuthorBridge;
    public admin?: HostAdminBridge;

    private slashHandler?: SlashCommandStub;

    constructor(init: MemoryHostBridgeInit = {}) {
        this.chat = init.chat ? [...init.chat] : [];
        this.metadata = init.metadata ? { ...init.metadata } : {};
        this.ejsFeatures = init.ejsFeatures ?? { invertEnabled: false };
        this.injectionSessionMode = init.injectionSessionMode ?? 'native';
        this.extensionCapabilities = {
            tavernHelperScripts: init.extensionCapabilities?.tavernHelperScripts ?? false,
            tavernHelperAudio: init.extensionCapabilities?.tavernHelperAudio ?? false,
            ejsTemplate: init.extensionCapabilities?.ejsTemplate ?? Boolean(init.ejsEvaluator),
        };
        this.identity = {
            userName: init.identity?.userName ?? 'User',
            charName: init.identity?.charName ?? 'Assistant',
            characterAvatar: init.identity?.characterAvatar ?? 'char.png',
            personaAvatar: init.identity?.personaAvatar ?? 'user.png',
        };
        this.characterFields = init.characterFields ? { ...init.characterFields } : {};
        this.personaDescription = init.personaDescription ?? '';

        this.lorebooks = new Map<string, RawLoreEntry[]>();
        if (init.lorebooks instanceof Map) {
            for (const [world, entries] of init.lorebooks.entries()) {
                this.lorebooks.set(world, entries.map((e) => structuredClone(e)));
            }
        } else if (init.lorebooks) {
            for (const [world, entries] of Object.entries(init.lorebooks)) {
                this.lorebooks.set(world, entries.map((e) => structuredClone(e)));
            }
        }

        this.disabledLorebooks = new Map<string, RawLoreEntry[]>();
        if (init.disabledLorebooks instanceof Map) {
            for (const [world, entries] of init.disabledLorebooks.entries()) {
                this.disabledLorebooks.set(world, entries.map((e) => structuredClone(e)));
            }
        } else if (init.disabledLorebooks) {
            for (const [world, entries] of Object.entries(init.disabledLorebooks)) {
                this.disabledLorebooks.set(world, entries.map((e) => structuredClone(e)));
            }
        }

        const firstEnabledWorld = this.lorebooks.keys().next().value ?? null;
        this.primaryWorldName =
            init.primaryWorldName !== undefined ? init.primaryWorldName : firstEnabledWorld;

        if (init.characters && init.characters.length > 0) {
            this.characters = init.characters.map((c) => structuredClone(c));
            this.activeCharacterId = init.activeCharacterId ?? this.characters[0].chid;
        } else {
            this.activeCharacterId = init.activeCharacterId ?? 0;
            this.characters = [
                {
                    chid: this.activeCharacterId,
                    name: this.identity.charName,
                    avatar: this.identity.characterAvatar,
                    description: this.characterFields.description ?? '',
                    personality: this.characterFields.personality ?? '',
                    scenario: this.characterFields.scenario ?? '',
                    first_mes: this.characterFields.first_mes ?? '',
                    mes_example: this.characterFields.mes_example ?? '',
                    creator_notes: this.characterFields.creator_notes ?? '',
                    system_prompt: this.characterFields.system_prompt ?? '',
                    post_history_instructions:
                        this.characterFields.post_history_instructions ?? '',
                    primaryWorld: this.primaryWorldName ?? undefined,
                    tags: [],
                    extensions: {
                        ...(this.primaryWorldName ? { world: this.primaryWorldName } : {}),
                    },
                    data: {
                        name: this.identity.charName,
                        description: this.characterFields.description ?? '',
                        personality: this.characterFields.personality ?? '',
                        scenario: this.characterFields.scenario ?? '',
                        extensions: {
                            ...(this.primaryWorldName ? { world: this.primaryWorldName } : {}),
                        },
                    },
                },
            ];
        }

        this.scopedRegex = init.scopedRegex ? init.scopedRegex.map((r) => structuredClone(r)) : [];
        this.globalRegex = init.globalRegex ? init.globalRegex.map((r) => structuredClone(r)) : [];
        this.personas = init.personas
            ? init.personas.map((p) => structuredClone(p))
            : [
                {
                    key: this.identity.personaAvatar,
                    name: this.identity.userName,
                    title: 'Default Persona',
                    description: this.personaDescription,
                    active: true,
                },
            ];
        this.presets = init.presets
            ? init.presets.map((p) => structuredClone(p))
            : [
                {
                    name: 'Default',
                    apiType: 'openai',
                    active: true,
                    data: {
                        temperature: 0.8,
                        openai_max_tokens: 2048,
                    },
                },
            ];
        this.hostSettings = init.hostSettings
            ? structuredClone(init.hostSettings)
            : structuredClone(DEFAULT_MOCK_HOST_SETTINGS);

        this.extensionData = new Map<string, unknown>(
            init.extensionData ? Object.entries(init.extensionData) : [],
        );
        this.hostLuminance = init.hostLuminance ?? 'dark';

        if (init.ejsEvaluator) {
            this.setEjsEvaluator(init.ejsEvaluator);
        }

        if (init.slashHandler) {
            this.setSlashHandler(init.slashHandler);
        } else {
            this.setSlashHandler(async () => '');
        }

        if (init.enableAuthorBridge !== false) {
            this.author = this.createAuthorBridge();
        }
        if (init.enableAdminBridge !== false) {
            this.admin = this.createAdminBridge();
        }
    }

    getChat(): ChatMessageSnapshot[] {
        return this.chat;
    }

    getMetadata(): Record<string, unknown> {
        return this.metadata;
    }

    saveChatDebounced(): void {
        this.saveChatCalls += 1;
    }

    readMessageVariables(target: MessageTarget): Record<string, unknown> | null {
        if (
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return null;
        }
        const msg = this.chat[target.messageId];
        if (!msg || !Array.isArray(msg.variables) || target.swipeId >= msg.variables.length) {
            return null;
        }
        const slot = msg.variables[target.swipeId];
        return isNonEmptyPlainRecord(slot) ? structuredClone(slot) : null;
    }

    writeMessageVariables(target: MessageTarget, vars: Record<string, unknown> | null): boolean {
        if (
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return false;
        }
        const msg = this.chat[target.messageId];
        if (!msg) {
            return false;
        }
        const variables = Array.isArray(msg.variables)
            ? msg.variables
            : (msg.variables = []);
        while (variables.length <= target.swipeId) {
            variables.push({});
        }
        variables[target.swipeId] = isPlainRecord(vars) ? structuredClone(vars) : {};
        this.saveChatDebounced();
        return true;
    }

    readChatVariables(): Record<string, unknown> {
        const raw = this.metadata.variables;
        return isPlainRecord(raw) ? structuredClone(raw) : {};
    }

    writeChatVariables(vars: Record<string, unknown>): void {
        const target = this.getMetadataVariables();
        replaceRecordInPlace(target, isPlainRecord(vars) ? vars : {});
        this.saveChatDebounced();
    }

    readGlobalVariables(): Record<string, unknown> {
        const raw = this.metadata.globalVariables;
        return isPlainRecord(raw) ? structuredClone(raw) : {};
    }

    writeGlobalVariables(vars: Record<string, unknown>): void {
        const target = this.getMetadataGlobalVariables(true);
        replaceRecordInPlace(target, isPlainRecord(vars) ? vars : {});
    }

    readChatMessage(target: MessageTarget): string | null {
        if (
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return null;
        }
        const msg = this.chat[target.messageId];
        if (!msg) {
            return null;
        }
        if (Array.isArray(msg.swipes) && target.swipeId < msg.swipes.length) {
            return typeof msg.swipes[target.swipeId] === 'string'
                ? msg.swipes[target.swipeId]
                : '';
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
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return;
        }
        const msg = this.chat[target.messageId];
        if (!msg) {
            return;
        }

        this.writtenMessages.push({
            target: { ...target },
            content,
            ...(options !== undefined ? { options: { ...options } } : {}),
        });

        const swipes = Array.isArray(msg.swipes)
            ? msg.swipes
            : (msg.swipes = [typeof msg.mes === 'string' ? msg.mes : '']);
        const swipeInfo = Array.isArray(msg.swipeInfo)
            ? msg.swipeInfo
            : (msg.swipeInfo = []);

        while (swipes.length <= target.swipeId) {
            swipes.push('');
        }
        while (swipeInfo.length <= target.swipeId) {
            swipeInfo.push({});
        }

        swipes[target.swipeId] = content;

        const activeSwipeId = msg.swipeId ?? 0;
        if (activeSwipeId === target.swipeId) {
            msg.mes = content;
            await this.refreshMessageView(target);
        }

        this.saveChatDebounced();

        if (options?.emitEvent) {
            this.emitHostEvent('MESSAGE_UPDATED', target.messageId);
        }
    }

    async createChatMessage(
        input: CreateChatMessageInput,
        options?: CreateChatMessageOptions,
    ): Promise<ChatMessageSnapshot> {
        const targetIndex =
            input.insertAt === undefined ? this.chat.length : Math.floor(input.insertAt);
        if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > this.chat.length) {
            throw new Error(
                `Invalid insertAt index ${String(input.insertAt)} for chat length ${this.chat.length}.`,
            );
        }

        const isUser = input.role === 'user';
        const isSystem =
            input.hidden !== undefined ? Boolean(input.hidden) : input.role === 'system';
        const resolvedName =
            input.name?.trim()
            || (isUser
                ? this.identity.userName || 'User'
                : input.role === 'system'
                  ? 'System'
                  : this.identity.charName || 'Assistant');
        const swipes =
            Array.isArray(input.swipes) && input.swipes.length > 0
                ? input.swipes.map((s) => String(s ?? ''))
                : [input.content];
        const swipeId =
            input.swipeId !== undefined && Number.isInteger(input.swipeId)
                ? Math.max(0, Math.min(input.swipeId, swipes.length - 1))
                : 0;
        const swipeInfo = Array.isArray(input.swipeInfo)
            ? input.swipeInfo.map((info) => structuredClone(info))
            : [];
        while (swipeInfo.length < swipes.length) {
            swipeInfo.push({});
        }

        const rawOverrides =
            input.rawFields && typeof input.rawFields === 'object'
                ? structuredClone(input.rawFields)
                : undefined;

        const snapshot: ChatMessageSnapshot = {
            id: targetIndex,
            name:
                typeof rawOverrides?.name === 'string' ? rawOverrides.name : resolvedName,
            isUser:
                rawOverrides?.is_user !== undefined ? Boolean(rawOverrides.is_user) : isUser,
            isSystem:
                rawOverrides?.is_system !== undefined
                    ? Boolean(rawOverrides.is_system)
                    : isSystem,
            mes:
                typeof rawOverrides?.mes === 'string'
                    ? rawOverrides.mes
                    : swipes[swipeId] ?? input.content,
            swipeId:
                typeof rawOverrides?.swipe_id === 'number'
                    ? rawOverrides.swipe_id
                    : swipeId,
            swipes: Array.isArray(rawOverrides?.swipes)
                ? (rawOverrides.swipes as unknown[]).map((s) => String(s ?? ''))
                : swipes,
            swipeInfo: Array.isArray(rawOverrides?.swipe_info)
                ? (structuredClone(rawOverrides.swipe_info) as ChatMessageSnapshot['swipeInfo'])
                : swipeInfo,
            ...(rawOverrides?.send_date !== undefined
                ? { sendDate: rawOverrides.send_date as string | number }
                : input.sendDate !== undefined
                  ? { sendDate: input.sendDate }
                  : {}),
            ...(rawOverrides?.extra && typeof rawOverrides.extra === 'object'
                ? { extra: structuredClone(rawOverrides.extra as Record<string, unknown>) }
                : input.extra
                  ? { extra: structuredClone(input.extra) }
                  : {}),
            ...(Array.isArray(rawOverrides?.variables)
                ? { variables: structuredClone(rawOverrides.variables as Record<string, unknown>[]) }
                : input.variables
                  ? { variables: structuredClone(input.variables) }
                  : {}),
        };

        if (targetIndex === this.chat.length) {
            this.chat.push(snapshot);
        } else {
            this.chat.splice(targetIndex, 0, snapshot);
        }
        this.chat.forEach((msg, idx) => {
            msg.id = idx;
        });

        this.createdMessages.push({
            input: structuredClone(input),
            createdId: targetIndex,
            ...(options !== undefined ? { options: { ...options } } : {}),
        });
        this.saveChatDebounced();

        if (options?.emitEvent !== false) {
            if (snapshot.isUser) {
                this.emitHostEvent('MESSAGE_SENT', targetIndex);
            } else {
                this.emitHostEvent('MESSAGE_RECEIVED', targetIndex);
            }
        }

        return structuredClone(snapshot);
    }

    async deleteChatMessage(
        messageId: number,
        options?: DeleteChatMessageOptions,
    ): Promise<DeletedChatMessageSnapshot | null> {
        if (
            !Number.isInteger(messageId) ||
            messageId < 0 ||
            messageId >= this.chat.length
        ) {
            return null;
        }
        const existing = this.chat[messageId];
        if (!existing) {
            return null;
        }
        const snapshot = structuredClone(existing);
        this.chat.splice(messageId, 1);
        this.chat.forEach((msg, idx) => {
            msg.id = idx;
        });

        this.deletedMessages.push({
            messageId,
            snapshot: structuredClone(snapshot),
            ...(options !== undefined ? { options: { ...options } } : {}),
        });
        this.saveChatDebounced();

        if (options?.emitEvent !== false) {
            this.emitHostEvent('MESSAGE_DELETED', this.chat.length);
        }

        return {
            messageId,
            snapshot,
        };
    }

    getActiveIdentity(): HostIdentity {
        return { ...this.identity };
    }

    getCharacterFields(): Record<string, string> {
        return { ...this.characterFields };
    }

    getPersonaDescription(): string {
        return this.personaDescription;
    }

    async listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>> {
        const result = new Map<string, RawLoreEntry[]>();
        for (const [world, entries] of this.lorebooks.entries()) {
            result.set(world, entries.map((entry) => structuredClone(entry)));
        }
        return result;
    }

    substituteMacros(text: string, overrides?: Record<string, string>): string {
        if (!text) {
            return '';
        }
        if (!text.includes('{{')) {
            return text;
        }

        const variables = this.getMetadataVariables();
        const globalVariables = this.getMetadataGlobalVariables();
        const overrideMap = new Map<string, string>();
        const outletMap = new Map<string, string>();
        let hasOutletTable = false;
        if (overrides) {
            for (const [key, value] of Object.entries(overrides)) {
                if (key === '__has_outlet_table__') {
                    hasOutletTable = value === '1';
                    continue;
                }
                if (key.startsWith('outlet:')) {
                    outletMap.set(key.slice(7), value);
                    continue;
                }
                if (!key.startsWith('var:')) {
                    overrideMap.set(key.toLowerCase(), value);
                }
            }
        }

        const chatDefaults = new Map<string, string>();
        if (this.chat.length > 0) {
            const lastEntry = this.chat[this.chat.length - 1];
            const lastMsgId =
                typeof lastEntry?.id === 'number' && Number.isFinite(lastEntry.id)
                    ? String(lastEntry.id)
                    : String(this.chat.length - 1);
            chatDefaults.set('lastmessage', typeof lastEntry?.mes === 'string' ? lastEntry.mes : '');
            chatDefaults.set('lastmessageid', lastMsgId);
            chatDefaults.set('allchatrange', `0-${this.chat.length - 1}`);

            let lastUserMes = '';
            for (let i = this.chat.length - 1; i >= 0; i -= 1) {
                const msg = this.chat[i];
                if (msg?.isUser && !msg.isSystem) {
                    lastUserMes = typeof msg.mes === 'string' ? msg.mes : '';
                    break;
                }
            }
            chatDefaults.set('lastusermessage', lastUserMes);

            let lastCharMes = '';
            for (let i = this.chat.length - 1; i >= 0; i -= 1) {
                const msg = this.chat[i];
                if (msg && !msg.isUser && !msg.isSystem) {
                    lastCharMes = typeof msg.mes === 'string' ? msg.mes : '';
                    break;
                }
            }
            chatDefaults.set('lastcharmessage', lastCharMes);
        } else {
            chatDefaults.set('lastmessage', '');
            chatDefaults.set('lastmessageid', '');
            chatDefaults.set('allchatrange', '');
            chatDefaults.set('lastusermessage', '');
            chatDefaults.set('lastcharmessage', '');
        }

        return text.replace(/\{\{([^{}]+)\}\}/g, (match, rawInner: string) => {
            const trimmed = rawInner.trim();
            const lower = trimmed.toLowerCase();

            if (lower.startsWith('outlet::')) {
                const outletName = trimmed.slice('outlet::'.length).trim();
                if (hasOutletTable || outletMap.size > 0) {
                    return outletMap.get(outletName) ?? '';
                }
                return match;
            }

            if (lower.startsWith('getvar::')) {
                const varName = trimmed.slice('getvar::'.length).trim();
                if (overrides && Object.hasOwn(overrides, varName)) {
                    return overrides[varName];
                }
                if (overrides && Object.hasOwn(overrides, `var:${varName}`)) {
                    return overrides[`var:${varName}`];
                }
                return stringifyVariable(variables[varName]);
            }

            if (lower.startsWith('getglobalvar::')) {
                const varName = trimmed.slice('getglobalvar::'.length).trim();
                return stringifyVariable(globalVariables[varName]);
            }

            if (overrideMap.has(lower)) {
                return overrideMap.get(lower) ?? '';
            }
            if (lower === 'user') {
                return this.identity.userName;
            }
            if (lower === 'char') {
                return this.identity.charName;
            }
            if (chatDefaults.has(lower)) {
                return chatDefaults.get(lower) ?? '';
            }
            return match;
        });
    }

    async attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void> {
        this.mediaAttachments.push({
            target: { ...target },
            media: { ...media },
        });
    }

    async refreshMessageView(target: MessageTarget): Promise<void> {
        this.refreshedViews.push({ ...target });
    }

    async reloadDisplayedMessages(
        options: ReloadDisplayedMessagesOptions = {},
    ): Promise<ReloadDisplayedMessagesResult> {
        const requestedIds = Array.isArray(options.messageIds)
            ? options.messageIds.filter((id) => Number.isInteger(id) && id >= 0)
            : [];
        const allIds = this.chat.map((_, idx) => idx);
        let candidateIds: number[];
        const skippedIds: number[] = [];

        if (requestedIds.length > 0) {
            candidateIds = [];
            for (const id of requestedIds) {
                if (id < this.chat.length) {
                    candidateIds.push(id);
                } else {
                    skippedIds.push(id);
                }
            }
        } else {
            const limit =
                typeof options.limit === 'number' && options.limit > 0
                    ? Math.floor(options.limit)
                    : 50;
            candidateIds = allIds.slice(-limit);
        }

        const emitUpdateEvent = options.emitUpdateEvent !== false;
        let emittedEvents = 0;
        for (const id of candidateIds) {
            const msg = this.chat[id];
            const swipeId = typeof msg?.swipeId === 'number' ? msg.swipeId : 0;
            await this.refreshMessageView({ messageId: id, swipeId });
            if (emitUpdateEvent) {
                this.emitHostEvent('message_updated', id);
                emittedEvents += 1;
            }
        }

        this.reloadedMessageBatches.push({
            reloadedIds: [...candidateIds],
            skippedIds: [...skippedIds],
            emitUpdateEvent,
        });

        return {
            reloadedIds: candidateIds,
            skippedIds,
            emittedEvents,
        };
    }

    async loadExtensionData<T>(key: string, fallback: T): Promise<T> {
        if (!this.extensionData.has(key)) {
            return structuredClone(fallback);
        }
        return structuredClone(this.extensionData.get(key) as T);
    }

    async saveExtensionData<T>(key: string, value: T): Promise<void> {
        this.extensionData.set(key, structuredClone(value));
    }

    async hashText(text: string): Promise<string> {
        return computeXxHash(text);
    }

    getHostLuminance(): 'dark' | 'light' {
        return this.hostLuminance;
    }

    emitHostEvent(event: string, payload?: unknown): void {
        this.emittedEvents.push({ event, payload });
    }

    // --- Test helper methods ---

    pushMessage(
        partial: Omit<ChatMessageSnapshot, 'id' | 'swipeId'> & { id?: number; swipeId?: number },
    ): ChatMessageSnapshot {
        const id = partial.id ?? this.chat.length;
        const snapshot: ChatMessageSnapshot = {
            ...partial,
            id,
            swipeId: partial.swipeId ?? 0,
            swipes: partial.swipes ? [...partial.swipes] : [partial.mes],
            swipeInfo: partial.swipeInfo ? [...partial.swipeInfo] : [{}],
        };
        this.chat[id] = snapshot;
        return snapshot;
    }

    setLorebook(world: string, entries: RawLoreEntry[]): void {
        this.lorebooks.set(world, entries.map((e) => structuredClone(e)));
        this.disabledLorebooks.delete(world);
    }

    setDisabledLorebook(world: string, entries: RawLoreEntry[]): void {
        this.disabledLorebooks.set(world, entries.map((e) => structuredClone(e)));
        this.lorebooks.delete(world);
    }

    setCharacterFields(fields: Record<string, string>): void {
        this.characterFields = { ...fields };
        const active = this.findCharacter(this.activeCharacterId);
        if (active) {
            for (const [k, v] of Object.entries(fields)) {
                active[k] = v;
                if (active.data && typeof active.data === 'object') {
                    active.data[k] = v;
                }
            }
        }
    }

    setPersonaDescription(desc: string): void {
        this.personaDescription = desc;
        const active = this.personas.find((p) => p.active);
        if (active) {
            active.description = desc;
        }
    }

    setVariable(name: string, value: unknown): void {
        const vars = this.getMetadataVariables();
        vars[name] = value;
        this.metadata.variables = vars;
    }

    setGlobalVariable(name: string, value: unknown): void {
        const vars = this.getMetadataGlobalVariables(true);
        vars[name] = value;
        this.metadata.globalVariables = vars;
    }

    setEjsEvaluator(fn?: EjsEvaluatorStub): void {
        if (!fn) {
            delete this.evaluateOptionalEjs;
            return;
        }
        this.evaluateOptionalEjs = async (
            text: string,
            vars: Record<string, unknown>,
            options?: EjsEvaluateOptions,
        ) => {
            const code = options?.isPrivate && text.includes('<%')
                ? `<% await (async () => { %>${text}<% })(); %>`
                : text;
            return fn(code, vars, options);
        };
    }

    createPromptInjectionSession(initialSnapshot?: SerializedPromptInjected): {
        session: PromptInjectionSession;
        mode: 'native' | 'fallback';
    } {
        return {
            session: new LocalPromptInjectionSession(initialSnapshot),
            mode: this.injectionSessionMode,
        };
    }

    getEjsFeatures(): EjsFeaturesSnapshot | null {
        return this.ejsFeatures ? { ...this.ejsFeatures } : null;
    }

    reportCompatWarning(code: string, message: string): void {
        if (this.reportedCompatCodes.has(code)) {
            return;
        }
        this.reportedCompatCodes.add(code);
        this.compatWarnings.push({ code, message });
    }

    setSlashHandler(fn?: SlashCommandStub): void {
        this.slashHandler = fn;
        if (!fn) {
            delete this.executeSlashCommand;
            return;
        }
        this.executeSlashCommand = async (command: string, signal?: AbortSignal) => {
            if (signal?.aborted) {
                this.slashCalls.push({ command, aborted: true });
                throw createAbortError();
            }
            const result = await this.slashHandler!(command, signal);
            this.slashCalls.push({ command, aborted: Boolean(signal?.aborted) });
            return result;
        };
    }

    // --- Internal author & admin mock factories ---

    private findCharacter(chid: number): HostCharacterFull | undefined {
        return this.characters.find((c) => c.chid === chid);
    }

    private findWorldBookEntries(bookName: string): RawLoreEntry[] | null {
        if (this.lorebooks.has(bookName)) {
            return this.lorebooks.get(bookName)!;
        }
        if (this.disabledLorebooks.has(bookName)) {
            return this.disabledLorebooks.get(bookName)!;
        }
        return null;
    }

    private applyCharacterPatch(
        target: HostCharacterFull,
        fields: HostCharacterPatch,
        undoMeta?: AuthorUndoMeta,
    ): HostCharacterFull {
        this.characterPatchHistory.push({
            chid: target.chid,
            fields: structuredClone(fields),
            ...(undoMeta ? { undoMeta: { ...undoMeta } } : {}),
        });

        if (!target.data || typeof target.data !== 'object') {
            target.data = {};
        }

        for (const [key, value] of Object.entries(fields)) {
            if (key === 'extensions' && value && typeof value === 'object' && !Array.isArray(value)) {
                target.extensions = {
                    ...(target.extensions ?? {}),
                    ...(structuredClone(value) as Record<string, unknown>),
                };
                target.data.extensions = structuredClone(target.extensions);
                continue;
            }
            if (key === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
                target.data = {
                    ...target.data,
                    ...(structuredClone(value) as Record<string, unknown>),
                };
                continue;
            }
            target[key] = structuredClone(value);
            if (key !== 'chid' && key !== 'avatar' && key !== 'primaryWorld') {
                target.data[key] = structuredClone(value);
            }
        }

        if (target.chid === this.activeCharacterId) {
            if (typeof fields.name === 'string') {
                this.identity.charName = fields.name;
            }
            for (const fieldKey of [
                'description',
                'personality',
                'scenario',
                'first_mes',
                'mes_example',
                'creator_notes',
                'system_prompt',
                'post_history_instructions',
            ] as const) {
                const val = target[fieldKey];
                if (typeof val === 'string') {
                    this.characterFields[fieldKey] = val;
                }
            }
        }

        this.emitHostEvent('CHARACTER_EDITED', { chid: target.chid });
        return structuredClone(target);
    }

    private createAuthorBridge(): HostAuthorBridge {
        return {
            getActiveCharacterFull: async (): Promise<HostCharacterFull | null> => {
                const active = this.findCharacter(this.activeCharacterId);
                return active ? structuredClone(active) : null;
            },

            patchActiveCharacter: async (
                fields: HostCharacterPatch,
                undoMeta?: AuthorUndoMeta,
            ): Promise<HostCharacterFull> => {
                const active = this.findCharacter(this.activeCharacterId);
                if (!active) {
                    throw new Error(`No active character selected (chid=${this.activeCharacterId})`);
                }
                return this.applyCharacterPatch(active, fields, undoMeta);
            },

            toggleChatMessageHidden: async (
                messageId: number,
                hidden: boolean,
            ): Promise<boolean> => {
                if (!Number.isInteger(messageId) || messageId < 0 || messageId >= this.chat.length) {
                    return false;
                }
                const msg = this.chat[messageId];
                if (!msg) {
                    return false;
                }
                msg.isSystem = hidden;
                await this.refreshMessageView({ messageId, swipeId: msg.swipeId ?? 0 });
                this.saveChatDebounced();
                this.emitHostEvent('MESSAGE_UPDATED', messageId);
                return true;
            },

            getPrimaryWorldName: async (): Promise<string | null> => {
                const active = this.findCharacter(this.activeCharacterId);
                const extWorld =
                    active?.extensions && typeof active.extensions.world === 'string'
                        ? active.extensions.world
                        : null;
                return active?.primaryWorld ?? extWorld ?? this.primaryWorldName;
            },

            readWorldInfoBook: async (bookName: string): Promise<WorldInfoBookSnapshot | null> => {
                const entries = this.findWorldBookEntries(bookName);
                if (!entries) {
                    return null;
                }
                return {
                    name: bookName,
                    entries: entries.map((e) => structuredClone(e)),
                };
            },

            upsertWorldInfoEntry: async (
                bookName: string,
                entry: WorldInfoEntryUpsert,
                _opts?: UpsertWorldInfoEntryOptions,
            ): Promise<RawLoreEntry> => {
                let entries = this.findWorldBookEntries(bookName);
                if (!entries) {
                    entries = [];
                    this.lorebooks.set(bookName, entries);
                }

                const existingIdx =
                    entry.uid !== undefined
                        ? entries.findIndex((item) => item.uid === entry.uid)
                        : -1;

                const nextUid =
                    entry.uid !== undefined
                        ? entry.uid
                        : entries.reduce((max, item) => Math.max(max, item.uid), -1) + 1;

                const existing = existingIdx >= 0 ? entries[existingIdx] : undefined;
                const saved: RawLoreEntry = {
                    world: bookName,
                    uid: nextUid,
                    comment: entry.comment ?? existing?.comment ?? `Entry #${nextUid}`,
                    // Raw direct write: preserve `@@` decorators and `<% ... %>` EJS verbatim
                    content: entry.content,
                    keys: [...entry.keys],
                    keysecondary: entry.keysecondary
                        ? [...entry.keysecondary]
                        : existing?.keysecondary
                            ? [...existing.keysecondary]
                            : [],
                    constant: entry.constant ?? existing?.constant ?? false,
                    selective: entry.selective ?? existing?.selective ?? false,
                    ...(entry.selectiveLogic !== undefined
                        ? { selectiveLogic: entry.selectiveLogic }
                        : existing?.selectiveLogic !== undefined
                            ? { selectiveLogic: existing.selectiveLogic }
                            : {}),
                    disable: entry.disable ?? existing?.disable ?? false,
                    position: entry.position ?? existing?.position ?? 0,
                    depth: entry.depth ?? existing?.depth ?? 4,
                    order: entry.order ?? existing?.order ?? 100,
                    role: entry.role ?? existing?.role ?? 0,
                    ...(entry.caseSensitive !== undefined
                        ? { caseSensitive: entry.caseSensitive }
                        : existing?.caseSensitive !== undefined
                            ? { caseSensitive: existing.caseSensitive }
                            : {}),
                    ...(entry.matchWholeWords !== undefined
                        ? { matchWholeWords: entry.matchWholeWords }
                        : existing?.matchWholeWords !== undefined
                            ? { matchWholeWords: existing.matchWholeWords }
                            : {}),
                    ...(entry.probability !== undefined
                        ? { probability: entry.probability }
                        : existing?.probability !== undefined
                            ? { probability: existing.probability }
                            : {}),
                    ...(entry.useProbability !== undefined
                        ? { useProbability: entry.useProbability }
                        : existing?.useProbability !== undefined
                            ? { useProbability: existing.useProbability }
                            : {}),
                    ...(entry.group !== undefined
                        ? { group: entry.group }
                        : existing?.group !== undefined
                            ? { group: existing.group }
                            : {}),
                    ...(entry.groupOverride !== undefined
                        ? { groupOverride: entry.groupOverride }
                        : existing?.groupOverride !== undefined
                            ? { groupOverride: existing.groupOverride }
                            : {}),
                    ...(entry.groupWeight !== undefined
                        ? { groupWeight: entry.groupWeight }
                        : existing?.groupWeight !== undefined
                            ? { groupWeight: existing.groupWeight }
                            : {}),
                    ...(entry.scanDepth !== undefined
                        ? { scanDepth: entry.scanDepth }
                        : existing?.scanDepth !== undefined
                            ? { scanDepth: existing.scanDepth }
                            : {}),
                    ...(entry.extensions !== undefined
                        ? { extensions: structuredClone(entry.extensions) }
                        : existing?.extensions !== undefined
                            ? { extensions: structuredClone(existing.extensions) }
                            : {}),
                };

                if (existingIdx >= 0) {
                    entries[existingIdx] = saved;
                } else {
                    entries.push(saved);
                }

                this.emitHostEvent('WORLDINFO_UPDATED', { bookName, uid: nextUid });
                return structuredClone(saved);
            },

            deleteWorldInfoEntry: async (bookName: string, uid: number): Promise<boolean> => {
                const entries = this.findWorldBookEntries(bookName);
                if (!entries) {
                    return false;
                }
                const idx = entries.findIndex((item) => item.uid === uid);
                if (idx < 0) {
                    return false;
                }
                entries.splice(idx, 1);
                this.emitHostEvent('WORLDINFO_UPDATED', { bookName, deletedUid: uid });
                return true;
            },

            listScopedRegex: async (): Promise<HostRegexScript[]> => {
                return this.scopedRegex.map((s) => structuredClone(s));
            },

            saveScopedRegex: async (scripts: HostRegexScript[]): Promise<void> => {
                this.scopedRegex = scripts.map((s) => structuredClone(s));
                this.emitHostEvent('SCOPED_REGEX_UPDATED', { count: this.scopedRegex.length });
            },

            embedAgenticPayload: async (
                options: EmbedAgenticOptions,
            ): Promise<EmbedAgenticResult> => {
                this.embeddedPayloads.push(structuredClone(options));
                const embeddedPresets = options.includePreset ? 1 : 0;
                const embeddedFiles = options.includeFiles
                    ? Object.keys(options.files ?? {}).length || (options.filePaths?.length ?? 0)
                    : 0;
                return {
                    ok: true,
                    embeddedPresets,
                    embeddedFiles,
                    message: `Embedded ${embeddedPresets} preset(s) and ${embeddedFiles} file(s)`,
                };
            },
        };
    }

    private createAdminBridge(): HostAdminBridge {
        return {
            listAllWorldNames: async (): Promise<string[]> => {
                const names = new Set<string>([
                    ...this.lorebooks.keys(),
                    ...this.disabledLorebooks.keys(),
                ]);
                return Array.from(names).sort();
            },

            createWorldBook: async (name: string): Promise<WorldInfoBookSnapshot> => {
                if (!this.lorebooks.has(name) && !this.disabledLorebooks.has(name)) {
                    this.disabledLorebooks.set(name, []);
                }
                const entries = this.findWorldBookEntries(name) ?? [];
                return {
                    name,
                    entries: entries.map((e) => structuredClone(e)),
                };
            },

            bindWorldBook: async (name: string, enabled: boolean): Promise<void> => {
                if (enabled) {
                    const existing =
                        this.lorebooks.get(name) ?? this.disabledLorebooks.get(name) ?? [];
                    this.disabledLorebooks.delete(name);
                    this.lorebooks.set(name, existing);
                } else {
                    const existing =
                        this.disabledLorebooks.get(name) ?? this.lorebooks.get(name) ?? [];
                    this.lorebooks.delete(name);
                    this.disabledLorebooks.set(name, existing);
                }
                this.emitHostEvent('WORLDINFO_BINDING_UPDATED', { name, enabled });
            },

            listAllCharacters: async (): Promise<HostCharacterSummary[]> => {
                return this.characters.map((c) => ({
                    chid: c.chid,
                    name: c.name,
                    avatar: c.avatar,
                    ...(c.description !== undefined ? { description: c.description } : {}),
                    ...(c.tags !== undefined ? { tags: [...c.tags] } : {}),
                    ...(c.primaryWorld !== undefined ? { primaryWorld: c.primaryWorld } : {}),
                }));
            },

            readCharacterById: async (chid: number): Promise<HostCharacterFull | null> => {
                const found = this.findCharacter(chid);
                return found ? structuredClone(found) : null;
            },

            createCharacter: async (
                payload: HostCharacterCreatePayload,
            ): Promise<HostCharacterFull> => {
                const nextChid =
                    this.characters.reduce((max, c) => Math.max(max, c.chid), -1) + 1;
                const slug = payload.name.replace(/\s+/g, '_').toLowerCase() || `char_${nextChid}`;
                const created: HostCharacterFull = {
                    ...structuredClone(payload),
                    chid: nextChid,
                    name: payload.name,
                    avatar: `${slug}.png`,
                    extensions: structuredClone(payload.extensions ?? {}),
                    data: {
                        name: payload.name,
                        description: payload.description ?? '',
                        personality: payload.personality ?? '',
                        scenario: payload.scenario ?? '',
                        extensions: structuredClone(payload.extensions ?? {}),
                    },
                };
                this.characters.push(created);
                this.emitHostEvent('CHARACTER_CREATED', { chid: nextChid });
                return structuredClone(created);
            },

            patchCharacterById: async (
                chid: number,
                fields: HostCharacterPatch,
            ): Promise<HostCharacterFull> => {
                const target = this.findCharacter(chid);
                if (!target) {
                    throw new Error(`Character not found: chid=${chid}`);
                }
                return this.applyCharacterPatch(target, fields);
            },

            deleteCharacterById: async (chid: number): Promise<boolean> => {
                const idx = this.characters.findIndex((c) => c.chid === chid);
                if (idx < 0) {
                    return false;
                }
                this.characters.splice(idx, 1);
                this.emitHostEvent('CHARACTER_DELETED', { chid });
                return true;
            },

            selectCharacterById: async (chid: number): Promise<void> => {
                const target = this.findCharacter(chid);
                if (!target) {
                    throw new Error(`Character not found: chid=${chid}`);
                }
                this.activeCharacterId = chid;
                this.identity.charName = target.name;
                this.identity.characterAvatar = target.avatar;
                this.characterFields = {
                    ...(target.description !== undefined ? { description: target.description } : {}),
                    ...(target.personality !== undefined ? { personality: target.personality } : {}),
                    ...(target.scenario !== undefined ? { scenario: target.scenario } : {}),
                    ...(target.first_mes !== undefined ? { first_mes: target.first_mes } : {}),
                    ...(target.mes_example !== undefined ? { mes_example: target.mes_example } : {}),
                    ...(target.creator_notes !== undefined
                        ? { creator_notes: target.creator_notes }
                        : {}),
                    ...(target.system_prompt !== undefined
                        ? { system_prompt: target.system_prompt }
                        : {}),
                    ...(target.post_history_instructions !== undefined
                        ? { post_history_instructions: target.post_history_instructions }
                        : {}),
                };
                this.primaryWorldName = target.primaryWorld ?? null;
                this.emitHostEvent('CHAT_CHANGED', { chid });
            },

            listPersonas: async (): Promise<HostPersonaEntry[]> => {
                return this.personas.map((p) => structuredClone(p));
            },

            upsertPersona: async (
                key: string,
                desc: string,
                title?: string,
            ): Promise<HostPersonaEntry> => {
                const existing = this.personas.find((p) => p.key === key);
                if (existing) {
                    existing.description = desc;
                    if (title !== undefined) {
                        existing.title = title;
                    }
                    if (existing.active) {
                        this.personaDescription = desc;
                    }
                    return structuredClone(existing);
                }
                const created: HostPersonaEntry = {
                    key,
                    name: title ?? key.replace(/\.png$/i, ''),
                    ...(title !== undefined ? { title } : {}),
                    description: desc,
                    active: false,
                };
                this.personas.push(created);
                return structuredClone(created);
            },

            selectPersona: async (key: string): Promise<void> => {
                const target = this.personas.find((p) => p.key === key);
                if (!target) {
                    throw new Error(`Persona not found: ${key}`);
                }
                for (const persona of this.personas) {
                    persona.active = persona.key === key;
                }
                this.identity.personaAvatar = target.key;
                this.identity.userName = target.name;
                this.personaDescription = target.description;
            },

            listPresets: async (
                apiTypeOrOptions?: string | ListPresetsOptions,
            ): Promise<HostPresetInfo[]> => {
                const options: ListPresetsOptions =
                    typeof apiTypeOrOptions === 'string'
                        ? { apiType: apiTypeOrOptions }
                        : (apiTypeOrOptions ?? {});
                const apiType = options.apiType;
                const nameFilter = typeof options.name === 'string' ? options.name.trim() : '';
                const includeData = options.includeData === true;

                const filtered = this.presets.filter(
                    (p) =>
                        (!apiType || p.apiType === apiType)
                        && (!nameFilter || p.name === nameFilter),
                );
                return filtered.map((p) => {
                    const base: HostPresetInfo = {
                        name: p.name,
                        apiType: p.apiType,
                        ...(p.active !== undefined ? { active: p.active } : {}),
                    };
                    if (includeData && p.data !== undefined) {
                        base.data = structuredClone(p.data);
                    }
                    return base;
                });
            },

            selectPreset: async (name: string, apiType?: string): Promise<void> => {
                const target = this.presets.find(
                    (p) => p.name === name && (!apiType || p.apiType === apiType),
                );
                if (!target) {
                    throw new Error(`Preset not found: ${name}`);
                }
                for (const preset of this.presets) {
                    if (preset.apiType === target.apiType) {
                        preset.active = preset.name === target.name;
                    }
                }
            },

            patchPreset: async (
                name: string,
                patch: Record<string, unknown>,
                apiType?: string,
            ): Promise<HostPresetInfo> => {
                const target = this.presets.find(
                    (p) => p.name === name && (!apiType || p.apiType === apiType),
                );
                if (!target) {
                    throw new Error(`Preset not found: ${name}`);
                }
                target.data = {
                    ...(target.data ?? {}),
                    ...structuredClone(patch),
                };
                return structuredClone(target);
            },

            readHostSettings: async (
                scope: HostSettingsScope,
                options?: ReadHostSettingsOptions,
            ): Promise<Record<string, unknown>> => {
                let baseObj: Record<string, unknown>;
                if (scope === 'all') {
                    baseObj = structuredClone(this.hostSettings);
                } else if (Object.hasOwn(this.hostSettings, scope)) {
                    baseObj = structuredClone(this.hostSettings[scope]);
                } else {
                    const extBucket = this.hostSettings.extension_settings;
                    if (extBucket && Object.hasOwn(extBucket, scope)) {
                        const value = extBucket[scope];
                        baseObj =
                            value && typeof value === 'object' && !Array.isArray(value)
                                ? structuredClone(value as Record<string, unknown>)
                                : { value: structuredClone(value) };
                    } else {
                        baseObj = {};
                    }
                }

                const keyPath = typeof options?.keyPath === 'string' ? options.keyPath.trim() : '';
                if (keyPath) {
                    const resolved = resolveMockSettingsKeyPath(baseObj, scope, keyPath);
                    if (!resolved.found) {
                        return { scope, keyPath, found: false, value: null };
                    }
                    if (
                        resolved.value
                        && typeof resolved.value === 'object'
                        && !Array.isArray(resolved.value)
                    ) {
                        const rec = resolved.value as Record<string, unknown>;
                        const bytes = utf8ByteLength(JSON.stringify(rec));
                        if (
                            options?.summaryOnly === true
                            || (options?.summaryOnly !== false && bytes > 16 * 1024)
                        ) {
                            return buildMockSettingsManifest(rec, scope, bytes, keyPath);
                        }
                        return structuredClone(rec);
                    }
                    return {
                        scope,
                        keyPath,
                        found: true,
                        value: structuredClone(resolved.value),
                    };
                }

                const totalBytes = utf8ByteLength(JSON.stringify(baseObj));
                if (
                    options?.summaryOnly === true
                    || (options?.summaryOnly !== false && totalBytes > 16 * 1024)
                ) {
                    return buildMockSettingsManifest(baseObj, scope, totalBytes);
                }
                return baseObj;
            },

            patchHostSettings: async (
                scope: HostSettingsScope,
                patch: Record<string, unknown>,
            ): Promise<Record<string, unknown>> => {
                const mergePreservingRedacted = (
                    existing: unknown,
                    incoming: unknown,
                ): unknown => {
                    if (incoming === '***REDACTED***') {
                        return structuredClone(existing);
                    }
                    if (
                        existing &&
                        typeof existing === 'object' &&
                        !Array.isArray(existing) &&
                        incoming &&
                        typeof incoming === 'object' &&
                        !Array.isArray(incoming)
                    ) {
                        const out = structuredClone(existing) as Record<string, unknown>;
                        for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
                            if (v === '***REDACTED***') {
                                continue;
                            }
                            if (
                                v &&
                                typeof v === 'object' &&
                                !Array.isArray(v) &&
                                out[k] &&
                                typeof out[k] === 'object' &&
                                !Array.isArray(out[k])
                            ) {
                                out[k] = mergePreservingRedacted(out[k], v);
                            } else {
                                out[k] = structuredClone(v);
                            }
                        }
                        return out;
                    }
                    return structuredClone(incoming);
                };

                if (scope === 'all') {
                    if (
                        patch.power_user &&
                        typeof patch.power_user === 'object' &&
                        !Array.isArray(patch.power_user)
                    ) {
                        this.hostSettings.power_user = mergePreservingRedacted(
                            this.hostSettings.power_user ?? {},
                            patch.power_user,
                        ) as Record<string, unknown>;
                    }
                    if (
                        patch.extension_settings &&
                        typeof patch.extension_settings === 'object' &&
                        !Array.isArray(patch.extension_settings)
                    ) {
                        this.hostSettings.extension_settings = mergePreservingRedacted(
                            this.hostSettings.extension_settings ?? {},
                            patch.extension_settings,
                        ) as Record<string, unknown>;
                    }
                    this.emitHostEvent('HOST_SETTINGS_UPDATED', { scope });
                    return structuredClone(this.hostSettings);
                }

                if (scope === 'power_user' || scope === 'extension_settings') {
                    const next = mergePreservingRedacted(
                        this.hostSettings[scope] ?? {},
                        patch,
                    ) as Record<string, unknown>;
                    this.hostSettings[scope] = next;
                    this.emitHostEvent('HOST_SETTINGS_UPDATED', { scope });
                    return structuredClone(next);
                }

                const extRoot = (this.hostSettings.extension_settings ??= {}) as Record<
                    string,
                    unknown
                >;
                const existing =
                    (extRoot[scope] as Record<string, unknown> | undefined) ??
                    this.hostSettings[scope] ??
                    {};
                const next = mergePreservingRedacted(existing, patch) as Record<string, unknown>;
                extRoot[scope] = next;
                this.emitHostEvent('HOST_SETTINGS_UPDATED', { scope });
                return structuredClone(next);
            },

            listGlobalRegex: async (): Promise<HostRegexScript[]> => {
                return this.globalRegex.map((s) => structuredClone(s));
            },

            saveGlobalRegex: async (scripts: HostRegexScript[]): Promise<void> => {
                this.globalRegex = scripts.map((s) => structuredClone(s));
                this.emitHostEvent('GLOBAL_REGEX_UPDATED', { count: this.globalRegex.length });
            },

            importFromUrl: async (url: string): Promise<HostImportUrlResult> => {
                this.importedUrls.push(url);
                const lower = url.toLowerCase();
                const importedType = lower.endsWith('.json')
                    ? 'worldinfo'
                    : lower.endsWith('.png')
                        ? 'character'
                        : 'unknown';
                const name = url.split('/').pop() || 'imported-resource';
                return {
                    ok: true,
                    url,
                    importedType,
                    name,
                    detail: `Mock imported ${name} from ${url}`,
                };
            },

            getExtensionCapabilities: (): HostExtensionCapabilities => ({
                ...this.extensionCapabilities,
            }),

            readTavernHelperScripts: async (
                scope: TavernHelperScriptScope,
            ): Promise<TavernHelperScriptsReadResult> => {
                return {
                    scope,
                    liveApiAvailable: this.tavernHelperLiveApiAvailable,
                    scripts: structuredClone(this.tavernHelperScripts[scope] ?? []),
                };
            },

            replaceTavernHelperScripts: async (
                scope: TavernHelperScriptScope,
                scripts: Record<string, unknown>[],
            ): Promise<TavernHelperScriptsWriteResult> => {
                const cloned = structuredClone(scripts);
                this.tavernHelperScripts[scope] = cloned;
                this.emitHostEvent('TAVERN_HELPER_SCRIPTS_UPDATED', {
                    scope,
                    count: cloned.length,
                });
                return {
                    scope,
                    syncedLive: this.tavernHelperLiveApiAvailable,
                    requiresReload: !this.tavernHelperLiveApiAvailable,
                    count: cloned.length,
                    scripts: structuredClone(cloned),
                    detail: `Mock updated ${cloned.length} ${scope} TavernHelper script(s).`,
                };
            },

            syncHostRuntime: async (
                options: HostRuntimeSyncOptions = {},
            ): Promise<HostRuntimeSyncResult> => {
                this.runtimeSyncCalls.push(structuredClone(options));
                const requested: HostSyncTarget[] = options.targets?.length ? options.targets : ['all'];
                const defaultTargets: Exclude<HostSyncTarget, 'all'>[] = [
                    'agentic',
                    ...(this.extensionCapabilities.ejsTemplate ? (['ejs'] as const) : []),
                    ...(this.extensionCapabilities.tavernHelperScripts
                        ? (['tavern_helper_scripts'] as const)
                        : []),
                    ...(this.extensionCapabilities.tavernHelperAudio
                        ? (['tavern_helper_audio'] as const)
                        : []),
                    'st_settings',
                    'messages',
                ];
                const resolved: Exclude<HostSyncTarget, 'all'>[] = [];
                for (const t of requested) {
                    if (t === 'all') {
                        for (const d of defaultTargets) {
                            if (!resolved.includes(d)) resolved.push(d);
                        }
                    } else if (!resolved.includes(t)) {
                        resolved.push(t);
                    }
                }

                const results: HostSyncTargetReport[] = [];
                let reloadedMessageIds: number[] | undefined;
                for (const target of resolved) {
                    if (target === 'messages') {
                        const reloaded = await this.reloadDisplayedMessages({
                            messageIds: options.messageIds,
                            limit: options.messageLimit,
                            emitUpdateEvent: true,
                        });
                        reloadedMessageIds = reloaded.reloadedIds;
                        results.push({
                            target: 'messages',
                            ok: true,
                            syncedLive: true,
                            detail: `Reloaded ${reloaded.reloadedIds.length} displayed message(s).`,
                            data: { reloadedIds: reloaded.reloadedIds },
                        });
                    } else {
                        results.push({
                            target,
                            ok: true,
                            syncedLive: true,
                            requiresReload: false,
                            detail: `Mock synchronized ${target}.`,
                        });
                    }
                }
                return {
                    ok: true,
                    results,
                    ...(reloadedMessageIds ? { reloadedMessageIds } : {}),
                };
            },
        };
    }

    private getMetadataVariables(): Record<string, unknown> {
        const raw = this.metadata.variables;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as Record<string, unknown>;
        }
        const created: Record<string, unknown> = {};
        this.metadata.variables = created;
        return created;
    }

    private getMetadataGlobalVariables(create: boolean = false): Record<string, unknown> {
        const raw = this.metadata.globalVariables;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as Record<string, unknown>;
        }
        if (create) {
            const created: Record<string, unknown> = {};
            this.metadata.globalVariables = created;
            return created;
        }
        return {};
    }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isNonEmptyPlainRecord(value: unknown): value is Record<string, unknown> {
    return isPlainRecord(value) && Object.keys(value).length > 0;
}

function replaceRecordInPlace(
    target: Record<string, unknown>,
    next: Record<string, unknown>,
): void {
    for (const key of Object.keys(target)) {
        if (!Object.hasOwn(next, key)) {
            delete target[key];
        }
    }
    for (const [key, value] of Object.entries(next)) {
        target[key] = structuredClone(value);
    }
}

function stringifyVariable(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function createAbortError(): Error {
    const err = new Error('Operation aborted');
    err.name = 'AbortError';
    return err;
}

function resolveMockSettingsKeyPath(
    root: Record<string, unknown>,
    scope: string,
    rawKeyPath: string,
): { found: boolean; value: unknown } {
    const segments = rawKeyPath
        .trim()
        .replace(/\\/g, '/')
        .split(/[./]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const walk = (segs: string[]): { found: boolean; value: unknown } => {
        let cursor: unknown = root;
        for (const seg of segs) {
            if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') {
                return { found: false, value: undefined };
            }
            if (Array.isArray(cursor)) {
                const idx = Number.parseInt(seg, 10);
                if (!Number.isInteger(idx) || idx < 0 || idx >= cursor.length || String(idx) !== seg) {
                    return { found: false, value: undefined };
                }
                cursor = cursor[idx];
                continue;
            }
            if (cursor && typeof cursor === 'object' && Object.hasOwn(cursor, seg)) {
                cursor = (cursor as Record<string, unknown>)[seg];
                continue;
            }
            return { found: false, value: undefined };
        }
        return { found: true, value: cursor };
    };
    const direct = walk(segments);
    if (direct.found) {
        return direct;
    }
    if (segments[0] === scope && segments.length > 1) {
        return walk(segments.slice(1));
    }
    return { found: false, value: undefined };
}

function buildMockSettingsManifest(
    record: Record<string, unknown>,
    scope: string,
    totalBytes: number,
    keyPath?: string,
): Record<string, unknown> {
    const manifest = Object.entries(record)
        .map(([key, value]) => {
            const type =
                value === null || value === undefined
                    ? 'null'
                    : Array.isArray(value)
                        ? 'array'
                        : typeof value;
            const serialized = JSON.stringify(value) ?? 'null';
            const bytes = utf8ByteLength(serialized);
            const itemCount =
                type === 'array'
                    ? (value as unknown[]).length
                    : type === 'object'
                        ? Object.keys(value as Record<string, unknown>).length
                        : undefined;
            const previewSource = typeof value === 'string' ? value : serialized;
            const clean = previewSource.replace(/\s+/g, ' ').trim();
            const preview = clean.length <= 100 ? clean : `${clean.slice(0, 97).trimEnd()}...`;
            return {
                key,
                type,
                bytes,
                ...(itemCount !== undefined ? { itemCount } : {}),
                preview,
            };
        })
        .sort((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
        scope,
        ...(keyPath ? { keyPath } : {}),
        summaryOnly: true,
        totalBytes,
        manifest,
        hint: 'Returned summary manifest to keep context compact. Pass a specific extension scope or keyPath to drill down.',
    };
}
