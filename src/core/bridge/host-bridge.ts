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
