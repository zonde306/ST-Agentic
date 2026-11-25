import type {
    AuthorUndoMeta,
    CreateSideSessionOptions,
    EmbedAgenticOptions,
    EmbedAgenticResult,
    ExportWorldInfoOptions,
    ExportWorldInfoResult,
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
    MessageTarget,
    RawLoreEntry,
    SideClueDelivery,
    SideClueDoc,
    SideClueStatus,
    SideClueWriteInput,
    SideGenOnceOptions,
    SideGenResult,
    SideGenSendOptions,
    SideSessionFilter,
    SideSessionInfo,
    SideSessionTranscriptEntry,
    TavernHelperScriptScope,
    TavernHelperScriptsReadResult,
    TavernHelperScriptsWriteResult,
    UpsertWorldInfoEntryOptions,
    WorldInfoBookSnapshot,
    WorldInfoEntryUpsert,
} from '../types';

/**
 * Authoring anti-corruption bridge (`author` and `full` assistant modes + clue WI export).
 * All SillyTavern character card, primary/enabled World Info, scoped regex, and card-embed
 * mutations pass through this boundary; `src/core/**` never imports `@st/*`.
 */
export interface HostAuthorBridge {
    /** Read full active character card fields & extensions snapshot, or `null` when none selected. */
    getActiveCharacterFull(): Promise<HostCharacterFull | null>;

    /**
     * Permanently patch active character card fields and synchronize host memory mirrors
     * (`characters[chid]`, `characters[chid].data`, and UI metadata).
     */
    patchActiveCharacter(
        fields: HostCharacterPatch,
        undoMeta?: AuthorUndoMeta,
    ): Promise<HostCharacterFull>;

    /** Toggle `is_system` visibility of a chat message and refresh the message view. */
    toggleChatMessageHidden(messageId: number, hidden: boolean): Promise<boolean>;

    /** Return the active character's primary bound World Info book name, or `null` if none. */
    getPrimaryWorldName(): Promise<string | null>;

    /** Read raw entries of a World Info book directly (preserving raw `@@` decorators & EJS). */
    readWorldInfoBook(bookName: string): Promise<WorldInfoBookSnapshot | null>;

    /**
     * Create or update a native World Info entry directly without `escapeAt`
     * (raw `@@` decorators and `<% ... %>` EJS are preserved verbatim).
     */
    upsertWorldInfoEntry(
        bookName: string,
        entry: WorldInfoEntryUpsert,
        opts?: UpsertWorldInfoEntryOptions,
    ): Promise<RawLoreEntry>;

    /** Permanently delete a World Info entry by UID from the specified book. */
    deleteWorldInfoEntry(bookName: string, uid: number): Promise<boolean>;

    /** List character-scoped regex scripts (`SCRIPT_TYPES.SCOPED`). */
    listScopedRegex(): Promise<HostRegexScript[]>;

    /** Persist character-scoped regex scripts (`SCRIPT_TYPES.SCOPED`). */
    saveScopedRegex(scripts: HostRegexScript[]): Promise<void>;

    /** Package and embed ST-Agentic presets/files into the active character card extensions. */
    embedAgenticPayload(options: EmbedAgenticOptions): Promise<EmbedAgenticResult>;
}

export interface ReadHostSettingsOptions {
    /** Dot/slash key path for drill-down reads, e.g. "TavernHelper.scripts" or "power_user.theme". */
    keyPath?: string;
    /** When true, return only a top-level manifest (key, type, bytes, itemCount, preview) instead of full nested content. */
    summaryOnly?: boolean;
}

export interface ListPresetsOptions {
    apiType?: string;
    /** Default false: list returns only metadata ({ name, apiType, active }); load full `data` only when explicitly requested. */
    includeData?: boolean;
    /** Filter to a single preset by exact name, typically combined with `includeData: true`. */
    name?: string;
}

/**
 * Global SillyTavern administration anti-corruption bridge.
 * Accessible ONLY when assistant `mode === 'full'` AND `stAdminEnabled === true`.
 */
export interface HostAdminBridge {
    // 1. Global World Info management
    listAllWorldNames(): Promise<string[]>;
    createWorldBook(name: string): Promise<WorldInfoBookSnapshot>;
    bindWorldBook(name: string, enabled: boolean): Promise<void>;

    // 2. Global character card CRUD & selection
    listAllCharacters(): Promise<HostCharacterSummary[]>;
    readCharacterById(chid: number): Promise<HostCharacterFull | null>;
    createCharacter(payload: HostCharacterCreatePayload): Promise<HostCharacterFull>;
    patchCharacterById(chid: number, fields: HostCharacterPatch): Promise<HostCharacterFull>;
    deleteCharacterById(chid: number): Promise<boolean>;
    selectCharacterById(chid: number): Promise<void>;

    // 3. Personas & presets
    listPersonas(): Promise<HostPersonaEntry[]>;
    upsertPersona(key: string, desc: string, title?: string): Promise<HostPersonaEntry>;
    selectPersona(key: string): Promise<void>;
    listPresets(apiTypeOrOptions?: string | ListPresetsOptions): Promise<HostPresetInfo[]>;
    selectPreset(name: string, apiType?: string): Promise<void>;
    patchPreset(
        name: string,
        patch: Record<string, unknown>,
        apiType?: string,
    ): Promise<HostPresetInfo>;

    // 4. Global settings, global regex & URL resource import
    readHostSettings(
        scope: HostSettingsScope,
        options?: ReadHostSettingsOptions,
    ): Promise<Record<string, unknown>>;
    patchHostSettings(
        scope: HostSettingsScope,
        patch: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    listGlobalRegex(): Promise<HostRegexScript[]>;
    saveGlobalRegex(scripts: HostRegexScript[]): Promise<void>;
    importFromUrl(url: string): Promise<HostImportUrlResult>;

    // 5. Optional third-party extension capability detection, live sync & host runtime sync
    getExtensionCapabilities?(): HostExtensionCapabilities;
    readTavernHelperScripts?(
        scope: TavernHelperScriptScope,
    ): Promise<TavernHelperScriptsReadResult>;
    replaceTavernHelperScripts?(
        scope: TavernHelperScriptScope,
        scripts: Record<string, unknown>[],
    ): Promise<TavernHelperScriptsWriteResult>;
    syncHostRuntime?(options?: HostRuntimeSyncOptions): Promise<HostRuntimeSyncResult>;
}

/** Clue management facade exposed on `ToolSideGenApi.clues` and `Agentic.sideGen.clues`. */
export interface ToolSideCluesApi {
    write(input: SideClueWriteInput): Promise<SideClueDoc>;
    read(path: string, target?: MessageTarget): Promise<SideClueDoc | null>;
    list(target?: MessageTarget): Promise<SideClueDoc[]>;
    updateDelivery(
        path: string,
        delivery: SideClueDelivery,
        target?: MessageTarget,
    ): Promise<SideClueDoc | null>;
    updateStatus(
        path: string,
        status: SideClueStatus,
        target?: MessageTarget,
    ): Promise<SideClueDoc | null>;
    delete(path: string, target?: MessageTarget): Promise<boolean>;
    exportToWorldInfo(
        path: string,
        options?: ExportWorldInfoOptions,
    ): Promise<ExportWorldInfoResult>;
}

/**
 * Off-mainline SideGen SDK API exposed to JS sandbox tools (`ctx.sideGen`)
 * and author scripts (`Agentic.sideGen`).
 */
export interface ToolSideGenApi {
    runOnce(opts: SideGenOnceOptions): Promise<SideGenResult>;
    createSession(opts: CreateSideSessionOptions): Promise<SideSessionInfo>;
    send(sessionId: string, prompt: string, opts?: SideGenSendOptions): Promise<SideGenResult>;
    getSession(sessionId: string): Promise<SideSessionInfo | null>;
    listSessions(filter?: SideSessionFilter): Promise<SideSessionInfo[]>;
    getTranscript(sessionId: string): Promise<SideSessionTranscriptEntry[]>;
    compactSession(sessionId: string): Promise<{ compacted: boolean; estimatedTokens: number }>;
    deleteSession(sessionId: string): Promise<boolean>;
    readonly clues: ToolSideCluesApi;
}
