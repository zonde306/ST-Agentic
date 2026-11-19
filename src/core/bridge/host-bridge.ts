import type {
    ChatMessageSnapshot,
    MediaAttachment,
    MessageTarget,
    RawLoreEntry,
} from '../types';

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

    // 2. Character, persona & World Info assets
    getCharacterFields(): Record<string, string>;
    getPersonaDescription(): string;
    listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>>;

    // 3. Macro & optional template rendering
    substituteMacros(text: string, overrides?: Record<string, string>): string;
    evaluateOptionalEjs?(text: string, vars: Record<string, unknown>): Promise<string>;

    // 4. External extension integration & slash commands
    executeSlashCommand?(command: string, signal?: AbortSignal): Promise<string>;
    attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void>;
    refreshMessageView(target: MessageTarget): Promise<void>;

    // 5. Persistence & hashing primitives
    loadExtensionData<T>(key: string, fallback: T): Promise<T>;
    saveExtensionData<T>(key: string, value: T): Promise<void>;
    hashText(text: string): Promise<string>;

    // 6. Optional host UI luminance & event hooks
    getHostLuminance?(): 'dark' | 'light';
    emitHostEvent?(event: string, payload?: unknown): void;
}
