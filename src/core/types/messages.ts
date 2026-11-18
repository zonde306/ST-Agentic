/** Causal message coordinates binding all branch writes, checkpoints, and async tasks. */
export interface MessageTarget {
    messageId: number;
    swipeId: number;
}

/** String serialization of MessageTarget in `${messageId}#${swipeId}` format. */
export type BranchKey = `${number}#${number}`;

export function toBranchKey(target: MessageTarget): BranchKey {
    return `${target.messageId}#${target.swipeId}`;
}

export function parseBranchKey(key: string): MessageTarget | null {
    const match = /^(\d+)#(\d+)$/.exec(key);
    if (!match) {
        return null;
    }

    const messageId = Number(match[1]);
    const swipeId = Number(match[2]);
    if (!Number.isSafeInteger(messageId) || !Number.isSafeInteger(swipeId)) {
        return null;
    }

    return { messageId, swipeId };
}

export type MediaAttachmentType = 'image' | 'audio' | 'video' | 'file';

export interface MediaAttachment {
    type: MediaAttachmentType;
    url: string;
    mimeType?: string;
    name?: string;
    caption?: string;
    inline?: boolean;
    extra?: Record<string, unknown>;
}

export interface StoredDataEntry {
    source: string;
    content: string;
    deleted?: boolean;
}

/** namespace -> key -> entry */
export type NamespaceDataMap = Record<string, Record<string, StoredDataEntry>>;

export interface LegacyWIOverride {
    type: string;
    content: string;
}

export interface SwipeDataSnapshot {
    cg_data?: NamespaceDataMap;
    wi_overrides?: Record<string, Record<string, LegacyWIOverride>>;
    mes_override?: string;
    extra?: Record<string, unknown>;
    send_date?: string | number;
    [key: string]: unknown;
}

export interface ChatMessageSnapshot {
    id: number;
    name: string;
    isUser: boolean;
    isSystem?: boolean;
    mes: string;
    swipeId: number;
    swipes?: string[];
    swipeInfo?: SwipeDataSnapshot[];
    sendDate?: string | number;
    extra?: Record<string, unknown>;
    variables?: Record<string, unknown>[];
}

export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

export type CanonicalContentPart =
    | { type: 'text'; text: string }
    | { type: 'image_url'; imageUrl: string; detail?: 'auto' | 'low' | 'high' }
    | { type: 'file'; data: string; mimeType?: string; filename?: string };

export interface CanonicalToolCall {
    id: string;
    name: string;
    arguments: string;
    thoughtSignature?: string;
}

export interface CanonicalMessage {
    role: CanonicalRole;
    content: string | CanonicalContentPart[];
    name?: string;
    reasoningContent?: string;
    toolCalls?: CanonicalToolCall[];
    toolCallId?: string;
    toolName?: string;
}

export interface CanonicalToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
}

export interface RawLoreEntry {
    world: string;
    uid: number;
    comment: string;
    content: string;
    keys: string[];
    keysecondary: string[];
    constant: boolean;
    selective: boolean;
    selectiveLogic?: number;
    disable: boolean;
    position: number;
    depth: number;
    order: number;
    role: number;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | number | null;
    probability?: number;
    useProbability?: boolean;
    group?: string;
    groupOverride?: boolean;
    groupWeight?: number;
    scanDepth?: number | null;
    decorators?: string[];
    extensions?: Record<string, unknown>;
}
