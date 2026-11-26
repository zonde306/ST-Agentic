import type {
    ChatMessageSnapshot,
    MediaAttachment,
    MessageTarget,
    RawLoreEntry,
    ReloadDisplayedMessagesOptions,
    ReloadDisplayedMessagesResult,
    SwipeDataSnapshot,
} from '../types';
import type {
    PromptInjectionSession,
    SerializedPromptInjected,
} from '../context/prompt-injection-session';
export type { PromptInjectionSession, SerializedPromptInjected };
import type { HostAdminBridge, HostAuthorBridge } from './host-admin-bridge';

export interface HostIdentity {
    userName: string;
    charName: string;
    characterAvatar: string;
    personaAvatar: string;
}

export interface WriteChatMessageOptions {
    /**
     * Whether to emit native host update events (`MESSAGE_UPDATED`).
     * Keep `false` during streaming or internal staging; set `true` on post-turn edits.
     */
    emitEvent?: boolean;
}

export type ChatMessageRole = 'user' | 'assistant' | 'system';

export interface CreateChatMessageInput {
    role: ChatMessageRole;
    content: string;
    name?: string;
    /** 0-based insertion index (`0..chat.length`); omit to append at the end. */
    insertAt?: number;
    /** Override `is_system`; defaults to `true` for `'system'` role and `false` otherwise. */
    hidden?: boolean;
    swipeId?: number;
    swipes?: string[];
    swipeInfo?: SwipeDataSnapshot[];
    sendDate?: string | number;
    extra?: Record<string, unknown>;
    variables?: Record<string, unknown>[];
    /** Optional lossless raw host fields preserved for undo restoration. */
    rawFields?: Record<string, unknown>;
}

export interface CreateChatMessageOptions {
    /** Whether to emit native host creation events (`MESSAGE_SENT` / `MESSAGE_RECEIVED`). Defaults to `true`. */
    emitEvent?: boolean;
}

export interface DeleteChatMessageOptions {
    /** Whether to emit native host deletion events (`MESSAGE_DELETED`). Defaults to `true`. */
    emitEvent?: boolean;
}

export interface DeletedChatMessageSnapshot {
    messageId: number;
    snapshot: ChatMessageSnapshot;
    rawMessage?: Record<string, unknown>;
}

export interface EjsRenderSession {
    /** Opaque host-owned prepared EJS context reused in-place across blocks within a single turn. */
    hostContext?: Record<string, unknown>;
    /** Variable updates written by ST macros since the last EJS call, synced into `hostContext.variables`. */
    pendingMacroVarUpdates?: Record<string, unknown>;
    /** Variable updates written into `hostContext.variables` during the latest EJS evaluation. */
    lastEjsVarUpdates?: Record<string, unknown>;
}

export interface EjsEvaluateOptions {
    injectionSession?: PromptInjectionSession;
    isPrivate?: boolean;
    ejsSession?: EjsRenderSession;
}

export interface EjsFeaturesSnapshot {
    invertEnabled?: boolean;
}

/**
 * Host Anti-Corruption Interface: `src/core/**` accesses chat state, assets,
 * macros, and SillyTavern services exclusively through this bridge.
 */
export interface HostBridge {
    // 1. Conversation & message read/write
    getChat(): ChatMessageSnapshot[];
    getMetadata(): Record<string, unknown>;
    saveChatDebounced(): void;
    getActiveIdentity(): HostIdentity;

    // 1b. Native ST 3-scope variables (message / chat / global)
    readMessageVariables?(target: MessageTarget): Record<string, unknown> | null;
    writeMessageVariables?(target: MessageTarget, vars: Record<string, unknown> | null): boolean;
    readChatVariables?(): Record<string, unknown>;
    writeChatVariables?(vars: Record<string, unknown>): void;
    readGlobalVariables?(): Record<string, unknown>;
    writeGlobalVariables?(vars: Record<string, unknown>): void;

    /**
     * Read the raw clean markdown content of the specified `(messageId, swipeId)` target
     * (without `display` regex transforms), or `null` when the message or swipe does not exist.
     */
    readChatMessage(target: MessageTarget): string | null;

    /**
     * Write raw content directly to the specified `(messageId, swipeId)` target:
     * updates `swipes[swipeId]`, syncs `mes` and refreshes the message view when targeting
     * the active swipe, and calls `saveChatDebounced()`.
     */
    writeChatMessage(
        target: MessageTarget,
        content: string,
        options?: WriteChatMessageOptions,
    ): Promise<void>;

    /**
     * Create a new native chat message (appending or inserting at `insertAt`),
     * refresh the host DOM/view, call `saveChatDebounced()`, and optionally emit events.
     */
    createChatMessage?(
        input: CreateChatMessageInput,
        options?: CreateChatMessageOptions,
    ): Promise<ChatMessageSnapshot>;

    /**
     * Physically delete a chat message at `messageId`, renumber subsequent messages,
     * call `saveChatDebounced()`, and optionally emit `MESSAGE_DELETED`.
     * Returns the pre-deletion snapshot (and raw host record if available), or `null` if missing.
     */
    deleteChatMessage?(
        messageId: number,
        options?: DeleteChatMessageOptions,
    ): Promise<DeletedChatMessageSnapshot | null>;

    // 2. Character, persona & World Info assets
    getCharacterFields(): Record<string, string>;
    getPersonaDescription(): string;
    listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>>;

    // 3. Macro & optional template rendering
    substituteMacros(text: string, overrides?: Record<string, string>): string;
    evaluateOptionalEjs?(
        text: string,
        vars: Record<string, unknown>,
        options?: EjsEvaluateOptions,
    ): Promise<string>;
    createPromptInjectionSession?(initialSnapshot?: SerializedPromptInjected): {
        session: PromptInjectionSession;
        mode: 'native' | 'fallback';
    };
    getEjsFeatures?(): EjsFeaturesSnapshot | null;
    reportCompatWarning?(code: string, message: string): void;

    // 4. External extension integration & slash commands
    executeSlashCommand?(command: string, signal?: AbortSignal): Promise<string>;
    attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void>;
    refreshMessageView(target: MessageTarget): Promise<void>;
    reloadDisplayedMessages?(
        options?: ReloadDisplayedMessagesOptions,
    ): Promise<ReloadDisplayedMessagesResult>;

    // 5. Persistence & hashing primitives
    loadExtensionData<T>(key: string, fallback: T): Promise<T>;
    saveExtensionData<T>(key: string, value: T): Promise<void>;
    hashText(text: string): Promise<string>;

    // 6. Optional host UI luminance & event hooks
    getHostLuminance?(): 'dark' | 'light';
    emitHostEvent?(event: string, payload?: unknown): void;

    // 7. Optional off-mainline authoring & ST global administration bridges
    author?: HostAuthorBridge;
    admin?: HostAdminBridge;
}
