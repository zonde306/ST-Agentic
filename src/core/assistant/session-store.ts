import type { HostBridge } from '@/core/bridge';
import {
    estimateRequestTokens,
    groupLayer1Turns,
    TrajectoryStore,
    type FrozenStaticPrefix,
    type Layer1TurnGroup,
} from '@/core/context';
import type {
    AssistantAttachment,
    AssistantMessage,
    AssistantMode,
    AssistantSession,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolSchema,
} from '@/core/types';
import { canonicalClone, canonicalStringify } from '@/core/utils';

export const ASSISTANT_THREAD_PREFIX = 'assistant:';
export const ASSISTANT_SESSIONS_STORAGE_KEY = 'agentic_assistant_sessions';
export const DEFAULT_ASSISTANT_WATERMARK = { high: 24000, low: 12000 } as const;

const ASSISTANT_SUMMARY_TAG = '<assistant-history-summary>';

export function toAssistantThreadId(sessionId: string): string {
    return `${ASSISTANT_THREAD_PREFIX}${sessionId}`;
}

export interface CreateAssistantSessionOptions {
    id?: string;
    title?: string;
    mode?: AssistantMode;
    stAdminEnabled?: boolean;
    autoApproveAuthor?: boolean;
    autoApproveChatDelete?: boolean;
    connectionId?: string;
}

export type AssistantSessionPatch = Partial<
    Pick<
        AssistantSession,
        | 'title'
        | 'mode'
        | 'stAdminEnabled'
        | 'autoApproveAuthor'
        | 'autoApproveChatDelete'
        | 'connectionId'
    >
>;

export type AssistantPersistenceMode = 'memory' | 'metadata' | 'extension_data';

export interface AssistantSessionStoreOptions {
    bridge?: HostBridge;
    trajectoryStore?: TrajectoryStore;
    persistenceMode?: AssistantPersistenceMode;
    storageKey?: string;
    watermark?: { high: number; low: number };
    now?: () => number;
    idGenerator?: () => string;
}

export interface AssistantRequestAssembly {
    messages: CanonicalMessage[];
    tools: CanonicalToolSchema[];
    cacheBreakpoints: number[];
    estimatedTokens: number;
}

export interface AssistantCompactionResult {
    compacted: boolean;
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    archivedTurnCount: number;
}

export interface AssistantRetractResult {
    session: AssistantSession;
    removedMessages: AssistantMessage[];
}

interface UiTurnGroup {
    user: AssistantMessage | null;
    assistants: AssistantMessage[];
}

function isEmptyInterruptedAssistantMessage(msg: AssistantMessage): boolean {
    return (
        msg.role === 'assistant'
        && Boolean(msg.interrupted)
        && !msg.content.trim()
        && !msg.think?.trim()
        && !(msg.toolCalls && msg.toolCalls.length > 0)
    );
}

function groupUiMessagesIntoTurns(messages: readonly AssistantMessage[]): UiTurnGroup[] {
    const turns: UiTurnGroup[] = [];
    let current: UiTurnGroup | null = null;

    const flush = () => {
        if (current && (current.user !== null || current.assistants.length > 0)) {
            turns.push(current);
        }
        current = null;
    };

    for (const msg of messages) {
        if (msg.role === 'user') {
            flush();
            current = { user: msg, assistants: [] };
            continue;
        }
        if (isEmptyInterruptedAssistantMessage(msg)) {
            continue;
        }
        if (!current) {
            current = { user: null, assistants: [] };
        }
        current.assistants.push(msg);
    }

    flush();
    return turns;
}

const AUDIO_EXTENSION_FORMAT_MAP: Readonly<Record<string, string>> = {
    mp3: 'mp3',
    mpeg: 'mp3',
    mpga: 'mp3',
    wav: 'wav',
    wave: 'wav',
    ogg: 'ogg',
    oga: 'ogg',
    opus: 'ogg',
    flac: 'flac',
    aac: 'aac',
    m4a: 'm4a',
    mp4: 'm4a',
    webm: 'webm',
};

const AUDIO_MIME_FORMAT_MAP: Readonly<Record<string, string>> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/flac': 'flac',
    'audio/x-flac': 'flac',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/m4a': 'm4a',
    'audio/webm': 'webm',
};

export function stripDataUrlBase64Prefix(dataOrUrl: string): string {
    if (!dataOrUrl.startsWith('data:')) {
        return dataOrUrl;
    }
    const commaIdx = dataOrUrl.indexOf(',');
    return commaIdx >= 0 ? dataOrUrl.slice(commaIdx + 1) : dataOrUrl;
}

export function inferAudioFormat(mimeType?: string, filename?: string): string {
    const cleanMime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (cleanMime && AUDIO_MIME_FORMAT_MAP[cleanMime]) {
        return AUDIO_MIME_FORMAT_MAP[cleanMime];
    }
    if (cleanMime.startsWith('audio/')) {
        const sub = cleanMime.slice('audio/'.length).replace(/^x-/, '');
        if (AUDIO_EXTENSION_FORMAT_MAP[sub]) {
            return AUDIO_EXTENSION_FORMAT_MAP[sub];
        }
    }
    const extMatch = /\.([a-z0-9]+)$/i.exec((filename ?? '').trim());
    if (extMatch) {
        const ext = extMatch[1].toLowerCase();
        if (AUDIO_EXTENSION_FORMAT_MAP[ext]) {
            return AUDIO_EXTENSION_FORMAT_MAP[ext];
        }
    }
    return 'mp3';
}

/**
 * Build canonical `user` message content from plain prompt text and optional multimodal attachments.
 */
export function buildAssistantUserContent(
    prompt: string,
    attachments?: readonly AssistantAttachment[],
): string | CanonicalContentPart[] {
    if (!attachments || attachments.length === 0) {
        return prompt;
    }

    const parts: CanonicalContentPart[] = [];
    if (prompt.trim().length > 0) {
        parts.push({ type: 'text', text: prompt });
    }

    for (const att of attachments) {
        if (att.kind === 'image') {
            parts.push({
                type: 'image_url',
                imageUrl: att.dataUrl,
            });
        } else if (att.kind === 'audio') {
            parts.push({
                type: 'input_audio',
                data: stripDataUrlBase64Prefix(att.dataUrl),
                format: inferAudioFormat(att.mimeType, att.name),
                mimeType: att.mimeType,
                filename: att.name,
            });
        } else if (att.kind === 'video') {
            parts.push({
                type: 'video_url',
                videoUrl: att.dataUrl,
                mimeType: att.mimeType,
                filename: att.name,
            });
        } else if (att.textContent !== undefined) {
            parts.push({
                type: 'text',
                text: `[Attachment: ${att.name}]\n${att.textContent}`,
            });
        } else {
            parts.push({
                type: 'file',
                data: att.dataUrl,
                mimeType: att.mimeType,
                filename: att.name,
            });
        }
    }

    return parts;
}

function synthesizeTurnMessages(uiTurn: UiTurnGroup): CanonicalMessage[] {
    const out: CanonicalMessage[] = [];
    if (uiTurn.user) {
        out.push({
            role: 'user',
            content: buildAssistantUserContent(uiTurn.user.content, uiTurn.user.attachments),
        });
    }
    for (const ast of uiTurn.assistants) {
        if (!ast.content.trim() && !ast.think?.trim()) {
            continue;
        }
        out.push({
            role: 'assistant',
            content: ast.content,
            ...(ast.think?.trim() ? { reasoningContent: ast.think } : {}),
        });
    }
    return out;
}

function reconcileTurnMessages(
    uiTurn: UiTurnGroup,
    existingTurn: Layer1TurnGroup | undefined,
): CanonicalMessage[] {
    if (!existingTurn || existingTurn.messages.length === 0 || !uiTurn.user) {
        return synthesizeTurnMessages(uiTurn);
    }

    const firstExisting = existingTurn.messages[0];
    if (firstExisting.role !== 'user') {
        return synthesizeTurnMessages(uiTurn);
    }

    const desiredUserContent = buildAssistantUserContent(
        uiTurn.user.content,
        uiTurn.user.attachments,
    );
    const userMatches =
        canonicalStringify(firstExisting.content) === canonicalStringify(desiredUserContent);
    const nonEmptyAssistants = uiTurn.assistants.filter(
        (ast) => ast.content.trim().length > 0 || Boolean(ast.think?.trim()),
    );

    if (nonEmptyAssistants.length === 0) {
        if (existingTurn.messages.length === 1 && userMatches) {
            return [...existingTurn.messages];
        }
        return [{ role: 'user', content: desiredUserContent }];
    }

    if (nonEmptyAssistants.length === 1) {
        const finalUiAssistant = nonEmptyAssistants[0];
        const lastExisting = existingTurn.messages[existingTurn.messages.length - 1];
        const canPreserveTail =
            existingTurn.messages.length >= 2
            && lastExisting.role === 'assistant'
            && !(lastExisting.toolCalls && lastExisting.toolCalls.length > 0);

        if (canPreserveTail) {
            const existingAssistantText = contentToPlainText(lastExisting.content);
            if (userMatches && existingAssistantText === finalUiAssistant.content) {
                return [...existingTurn.messages];
            }
            const nextMsgs = [...existingTurn.messages];
            if (!userMatches) {
                nextMsgs[0] = {
                    ...canonicalClone(firstExisting),
                    content: canonicalClone(desiredUserContent),
                };
            }
            if (existingAssistantText !== finalUiAssistant.content) {
                nextMsgs[nextMsgs.length - 1] = {
                    ...canonicalClone(lastExisting),
                    content: finalUiAssistant.content,
                };
            }
            return nextMsgs;
        }
    }

    return synthesizeTurnMessages(uiTurn);
}

function contentToPlainText(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .map((part) => {
            if (part.type === 'text') return part.text;
            if (part.type === 'image_url') return `[image:${part.imageUrl}]`;
            if (part.type === 'input_audio') return `[audio:${part.filename ?? part.format}]`;
            if (part.type === 'video_url') {
                return `[video:${part.filename ?? part.mimeType ?? 'video'}]`;
            }
            return `[file:${part.filename ?? part.mimeType ?? 'attachment'}]`;
        })
        .join('\n');
}

function extractExistingSummaryBody(messages: readonly CanonicalMessage[]): string {
    for (const msg of messages) {
        if (msg.role === 'system' && typeof msg.content === 'string' && msg.content.startsWith(ASSISTANT_SUMMARY_TAG)) {
            return msg.content
                .replace(/^<assistant-history-summary>\s*/i, '')
                .replace(/\s*<\/assistant-history-summary>\s*$/i, '')
                .trim();
        }
    }
    return '';
}

function summarizeAssistantTurns(turns: readonly Layer1TurnGroup[], priorSummary: string): string {
    const lines: string[] = [];
    if (priorSummary) {
        lines.push(priorSummary);
    }
    for (const turn of turns) {
        const userMsg = turn.messages.find((m) => m.role === 'user');
        const assistantMsgs = turn.messages.filter((m) => m.role === 'assistant');
        const finalAssistant = assistantMsgs[assistantMsgs.length - 1];
        const toolNames = new Set<string>();
        for (const msg of turn.messages) {
            if (msg.toolCalls?.length) {
                for (const tc of msg.toolCalls) {
                    toolNames.add(tc.name);
                }
            }
        }
        const userText = userMsg
            ? contentToPlainText(userMsg.content).replace(/\s+/g, ' ').trim().slice(0, 48)
            : '';
        const assistantText = finalAssistant
            ? contentToPlainText(finalAssistant.content).replace(/\s+/g, ' ').trim().slice(0, 56)
            : '';
        const toolsPart = toolNames.size > 0 ? ` [${Array.from(toolNames).join(',')}]` : '';
        lines.push(`- U: ${userText} -> A${toolsPart}: ${assistantText}`);
    }
    const combined = lines.join('\n').trim();
    return combined.length > 1200 ? combined.slice(combined.length - 1200) : combined;
}

function cloneSession(session: AssistantSession): AssistantSession {
    return canonicalClone(session);
}

function isValidAssistantSession(raw: unknown): raw is AssistantSession {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return false;
    }
    const rec = raw as Partial<AssistantSession>;
    return (
        typeof rec.id === 'string'
        && rec.id.length > 0
        && typeof rec.title === 'string'
        && (rec.mode === 'chat' || rec.mode === 'adjust' || rec.mode === 'author' || rec.mode === 'full')
        && Array.isArray(rec.messages)
    );
}

/**
 * Stores `AssistantSession` records and messages (in memory with optional `HostBridge`
 * metadata or extension-data persistence) and manages KV-cache-friendly per-session
 * `TrajectoryStore` threads keyed by `assistant:<sessionId>`.
 */
export class AssistantSessionStore {
    public readonly trajectoryStore: TrajectoryStore;

    private readonly sessions = new Map<string, AssistantSession>();
    private readonly bridge?: HostBridge;
    private readonly persistenceMode: AssistantPersistenceMode;
    private readonly storageKey: string;
    private readonly defaultWatermark: { high: number; low: number };
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private persistChain: Promise<void> = Promise.resolve();
    private seq = 0;

    constructor(options: AssistantSessionStoreOptions = {}) {
        this.bridge = options.bridge;
        this.trajectoryStore = options.trajectoryStore ?? new TrajectoryStore();
        this.persistenceMode =
            options.persistenceMode ?? (options.bridge ? 'metadata' : 'memory');
        this.storageKey = options.storageKey?.trim() || ASSISTANT_SESSIONS_STORAGE_KEY;
        this.defaultWatermark = options.watermark
            ? {
                high: Math.max(100, Math.floor(options.watermark.high)),
                low: Math.max(50, Math.floor(options.watermark.low)),
            }
            : { ...DEFAULT_ASSISTANT_WATERMARK };
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `ast_${this.now()}_${this.seq}`;
            });

        if (this.persistenceMode === 'metadata' && this.bridge) {
            this.hydrateFromMetadata();
        }
    }

    /** Load persisted sessions from configured storage (metadata or extension_data). */
    public async load(): Promise<AssistantSession[]> {
        if (!this.bridge || this.persistenceMode === 'memory') {
            return this.listSessions();
        }
        if (this.persistenceMode === 'metadata') {
            this.hydrateFromMetadata();
            return this.listSessions();
        }
        const loaded = await this.bridge.loadExtensionData<AssistantSession[]>(
            this.storageKey,
            [],
        );
        this.sessions.clear();
        if (Array.isArray(loaded)) {
            for (const item of loaded) {
                if (isValidAssistantSession(item)) {
                    this.sessions.set(item.id, cloneSession(item));
                }
            }
        }
        return this.listSessions();
    }

    /** Wait for any queued async persistence operations to complete. */
    public async flush(): Promise<void> {
        await this.persistChain;
    }

    public createSession(options: CreateAssistantSessionOptions = {}): AssistantSession {
        const id = options.id?.trim() || this.idGenerator();
        if (this.sessions.has(id)) {
            throw new Error(`Assistant session "${id}" already exists.`);
        }
        const now = this.now();
        const mode: AssistantMode = options.mode ?? 'chat';
        const session: AssistantSession = {
            id,
            title: options.title?.trim() || '新助手会话',
            mode,
            stAdminEnabled: mode === 'full' ? Boolean(options.stAdminEnabled) : false,
            autoApproveAuthor: Boolean(options.autoApproveAuthor),
            autoApproveChatDelete: Boolean(options.autoApproveChatDelete),
            connectionId: options.connectionId?.trim() || 'inherit',
            updatedAt: now,
            messages: [],
        };
        this.sessions.set(id, session);
        this.trajectoryStore.ensureThread(toAssistantThreadId(id));
        this.persist();
        return cloneSession(session);
    }

    public getSession(sessionId: string): AssistantSession | null {
        const found = this.sessions.get(sessionId);
        return found ? cloneSession(found) : null;
    }

    public listSessions(): AssistantSession[] {
        return Array.from(this.sessions.values())
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(cloneSession);
    }

    public updateSession(
        sessionId: string,
        patch: AssistantSessionPatch,
    ): AssistantSession | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        if (patch.title !== undefined) {
            session.title = patch.title.trim() || session.title;
        }
        if (patch.mode !== undefined) {
            session.mode = patch.mode;
            if (patch.mode !== 'full') {
                session.stAdminEnabled = false;
            }
        }
        if (patch.stAdminEnabled !== undefined) {
            session.stAdminEnabled = session.mode === 'full' ? Boolean(patch.stAdminEnabled) : false;
        }
        if (patch.autoApproveAuthor !== undefined) {
            session.autoApproveAuthor = Boolean(patch.autoApproveAuthor);
        }
        if (patch.autoApproveChatDelete !== undefined) {
            session.autoApproveChatDelete = Boolean(patch.autoApproveChatDelete);
        }
        if (patch.connectionId !== undefined) {
            session.connectionId = patch.connectionId.trim() || 'inherit';
        }
        session.updatedAt = this.now();
        this.persist();
        return cloneSession(session);
    }

    public deleteSession(sessionId: string): boolean {
        const existed = this.sessions.delete(sessionId);
        this.trajectoryStore.clearThread(toAssistantThreadId(sessionId));
        if (existed) {
            this.persist();
        }
        return existed;
    }

    public appendMessage(sessionId: string, message: AssistantMessage): AssistantMessage {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        const copy = canonicalClone(message);
        session.messages.push(copy);
        session.updatedAt = this.now();
        this.persist();
        return canonicalClone(copy);
    }

    public updateMessage(
        sessionId: string,
        messageId: string,
        updater: (prev: AssistantMessage) => AssistantMessage,
    ): AssistantMessage | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const updated = canonicalClone(updater(canonicalClone(session.messages[idx])));
        session.messages[idx] = updated;
        session.updatedAt = this.now();
        this.persist();
        return canonicalClone(updated);
    }

    /**
     * Retract `messageId` and all subsequent messages from `session.messages`,
     * syncing `TrajectoryStore` Layer 1 while preserving earlier turns verbatim.
     */
    public retractFromMessage(
        sessionId: string,
        messageId: string,
    ): AssistantRetractResult | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const removedMessages = session.messages.slice(idx).map((m) => canonicalClone(m));
        session.messages = session.messages.slice(0, idx);
        session.updatedAt = this.now();
        this.syncTrajectoryToMessages(sessionId);
        this.persist();
        return {
            session: cloneSession(session),
            removedMessages,
        };
    }

    /**
     * Remove all messages strictly after `messageId`, keeping `messageId` intact,
     * and synchronize `TrajectoryStore` Layer 1.
     */
    public truncateAfterMessage(
        sessionId: string,
        messageId: string,
    ): AssistantRetractResult | null {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return null;
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            return null;
        }
        const removedMessages = session.messages.slice(idx + 1).map((m) => canonicalClone(m));
        session.messages = session.messages.slice(0, idx + 1);
        session.updatedAt = this.now();
        this.syncTrajectoryToMessages(sessionId);
        this.persist();
        return {
            session: cloneSession(session),
            removedMessages,
        };
    }

    /**
     * Reconcile `TrajectoryStore` Layer 1 with `session.messages` (or a prefix up to `upToMessageIndex`),
     * preserving unmodified prior turns (including tool-call chains) verbatim for KV cache stability.
     */
    public syncTrajectoryToMessages(
        sessionId: string,
        options?: { upToMessageIndex?: number },
    ): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }

        const endIdx =
            options?.upToMessageIndex !== undefined
                ? Math.max(0, Math.min(session.messages.length, options.upToMessageIndex))
                : session.messages.length;

        const uiTurns = groupUiMessagesIntoTurns(session.messages.slice(0, endIdx));
        const threadId = toAssistantThreadId(sessionId);
        const existingLayer1 = this.trajectoryStore.getMessages(threadId);
        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);

        const { headerMessages, turns: existingTurns } = groupLayer1Turns(
            existingLayer1,
            headerCount > 0 ? headerCount : undefined,
        );

        let retainedHeaders: CanonicalMessage[] = [];
        let reconcileUiTurns: UiTurnGroup[] = uiTurns;

        if (headerMessages.length > 0 && existingTurns.length > 0) {
            const firstExistingUser = existingTurns[0].messages.find((m) => m.role === 'user');
            if (firstExistingUser) {
                const needle = contentToPlainText(firstExistingUser.content);
                const approxStart = Math.max(0, uiTurns.length - existingTurns.length - 2);
                let offset = -1;
                const matchesTurnUser = (turn: UiTurnGroup): boolean => {
                    if (!turn.user) {
                        return false;
                    }
                    const turnPlain = contentToPlainText(
                        buildAssistantUserContent(turn.user.content, turn.user.attachments),
                    );
                    return turnPlain === needle || turn.user.content === needle;
                };
                for (let i = approxStart; i < uiTurns.length; i += 1) {
                    if (matchesTurnUser(uiTurns[i])) {
                        offset = i;
                        break;
                    }
                }
                if (offset < 0) {
                    for (let i = 0; i < approxStart; i += 1) {
                        if (matchesTurnUser(uiTurns[i])) {
                            offset = i;
                            break;
                        }
                    }
                }
                if (offset >= 0 && offset < uiTurns.length) {
                    retainedHeaders = [...headerMessages];
                    reconcileUiTurns = uiTurns.slice(offset);
                }
            }
        }

        const compactedMessages: CanonicalMessage[] = [...retainedHeaders];
        const turnEndCounts: number[] = [];
        let runningLen = retainedHeaders.length;

        for (let i = 0; i < reconcileUiTurns.length; i += 1) {
            const uiTurn = reconcileUiTurns[i];
            const existingTurn = i < existingTurns.length ? existingTurns[i] : undefined;
            const turnMsgs = reconcileTurnMessages(uiTurn, existingTurn);
            if (turnMsgs.length > 0) {
                compactedMessages.push(...turnMsgs);
                runningLen += turnMsgs.length;
                turnEndCounts.push(runningLen);
            }
        }

        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: prevChunk,
                compactionHeaderCount: retainedHeaders.length,
                turnEndCounts,
            },
            threadId,
        );
    }

    /** Return the `TrajectoryStore` thread ID (`assistant:<sessionId>`). */
    public getThreadId(sessionId: string): string {
        return toAssistantThreadId(sessionId);
    }

    /**
     * Ensure Layer 0 static prefix (`systemPrompt` + canonically ordered `tools`) is frozen
     * on `assistant:<sessionId>` for KV cache prefix invariance across multi-turn requests.
     * Only recompiles when the frozen prefix is absent or the prompt/toolset actually changed.
     */
    public ensureFrozenPrefix(
        sessionId: string,
        systemPrompt: string,
        tools: readonly CanonicalToolSchema[],
        forceRecompile: boolean = false,
    ): FrozenStaticPrefix {
        const threadId = toAssistantThreadId(sessionId);
        const existing = this.trajectoryStore.getFrozenPrefix(threadId);
        const desiredMessages: CanonicalMessage[] = [{ role: 'system', content: systemPrompt }];
        const desiredTools = canonicalClone([...tools]);

        if (
            !forceRecompile
            && existing
            && canonicalStringify(existing.messages) === canonicalStringify(desiredMessages)
            && canonicalStringify(existing.tools) === canonicalStringify(desiredTools)
        ) {
            return existing;
        }

        const nextPrefix: FrozenStaticPrefix = {
            messages: desiredMessages,
            tools: desiredTools,
            layer0EndIndex: 0,
        };
        this.trajectoryStore.setFrozenPrefix(nextPrefix, threadId);
        return this.trajectoryStore.getFrozenPrefix(threadId)!;
    }

    /**
     * Assemble a KV-cache-friendly `LLMRequest` payload for `assistant:<sessionId>`:
     * Layer 0 (frozen system prefix) + Layer 1 (append-only committed trajectory) + in-flight turn messages.
     */
    public buildRequestMessages(
        sessionId: string,
        systemPrompt: string,
        tools: readonly CanonicalToolSchema[],
        inFlightMessages: readonly CanonicalMessage[] = [],
    ): AssistantRequestAssembly {
        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.ensureFrozenPrefix(sessionId, systemPrompt, tools);
        const layer0 = canonicalClone([...frozen.messages]);
        const layer1 = canonicalClone([...this.trajectoryStore.getMessages(threadId)]);
        const inFlight = canonicalClone([...inFlightMessages]);

        const messages: CanonicalMessage[] = [...layer0, ...layer1, ...inFlight];
        const canonicalTools = canonicalClone([...frozen.tools]);

        const cacheBreakpoints: number[] = [];
        if (layer0.length > 0) {
            cacheBreakpoints.push(layer0.length - 1);
        }
        if (layer1.length > 0) {
            cacheBreakpoints.push(layer0.length + layer1.length - 1);
        }

        const estimatedTokens = estimateRequestTokens(messages, canonicalTools);
        return {
            messages,
            tools: canonicalTools,
            cacheBreakpoints,
            estimatedTokens,
        };
    }

    /** Append finalized turn messages to Layer 1 of `assistant:<sessionId>` without mutating prior items. */
    public appendTrajectoryTurn(
        sessionId: string,
        messages: readonly CanonicalMessage[],
    ): void {
        if (messages.length === 0) {
            return;
        }
        const threadId = toAssistantThreadId(sessionId);
        this.trajectoryStore.appendTurn(messages, threadId);
    }

    /**
     * Hysteresis watermark compaction for `assistant:<sessionId>`.
     * Never splits `tool_calls -> tool` turn groups and never writes to mainline `/history/*`.
     */
    public compactIfNeeded(
        sessionId: string,
        options?: { watermark?: { high: number; low: number }; force?: boolean },
    ): AssistantCompactionResult {
        const threadId = toAssistantThreadId(sessionId);
        const frozen = this.trajectoryStore.getFrozenPrefix(threadId);
        const layer0 = frozen?.messages ?? [];
        const tools = frozen?.tools ?? [];
        const layer1 = this.trajectoryStore.getMessages(threadId);

        const watermark = options?.watermark ?? this.defaultWatermark;
        const estimatedTokensBefore = estimateRequestTokens([...layer0, ...layer1], tools);

        if (!options?.force && estimatedTokensBefore <= watermark.high) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
            };
        }

        const headerCount = this.trajectoryStore.getCompactionHeaderCount(threadId);
        const { headerMessages, turns } = groupLayer1Turns(
            layer1,
            headerCount > 0 ? headerCount : undefined,
        );

        if (turns.length <= 1) {
            return {
                compacted: false,
                estimatedTokensBefore,
                estimatedTokensAfter: estimatedTokensBefore,
                archivedTurnCount: 0,
            };
        }

        const priorSummary = extractExistingSummaryBody(headerMessages);
        const maxArchive = turns.length - 1;
        let archiveCount = 1;
        let summaryMsg: CanonicalMessage = {
            role: 'system',
            content: `${ASSISTANT_SUMMARY_TAG}\n${summarizeAssistantTurns(turns.slice(0, archiveCount), priorSummary)}\n</assistant-history-summary>`,
        };

        const calcTokens = (count: number, hdr: CanonicalMessage): number => {
            const retained = turns.slice(count).flatMap((t) => t.messages);
            return estimateRequestTokens([...layer0, hdr, ...retained], tools);
        };

        let projected = calcTokens(archiveCount, summaryMsg);
        while (projected > watermark.low && archiveCount < maxArchive) {
            archiveCount += 1;
            summaryMsg = {
                role: 'system',
                content: `${ASSISTANT_SUMMARY_TAG}\n${summarizeAssistantTurns(turns.slice(0, archiveCount), priorSummary)}\n</assistant-history-summary>`,
            };
            projected = calcTokens(archiveCount, summaryMsg);
        }

        const retainedTurns = turns.slice(archiveCount);
        const compactedMessages: CanonicalMessage[] = [
            summaryMsg,
            ...retainedTurns.flatMap((t) => t.messages),
        ];
        const turnEndCounts: number[] = [];
        let runningLen = 1;
        for (const turn of retainedTurns) {
            runningLen += turn.messages.length;
            turnEndCounts.push(runningLen);
        }

        const prevChunk = this.trajectoryStore.getArchivedUpToChunk(threadId);
        this.trajectoryStore.applyCompaction(
            {
                compactedMessages,
                archivedUpToChunk: prevChunk + 1,
                compactionHeaderCount: 1,
                turnEndCounts,
            },
            threadId,
        );

        const estimatedTokensAfter = estimateRequestTokens(
            [...layer0, ...compactedMessages],
            tools,
        );

        return {
            compacted: true,
            estimatedTokensBefore,
            estimatedTokensAfter,
            archivedTurnCount: archiveCount,
        };
    }

    private hydrateFromMetadata(): void {
        if (!this.bridge) {
            return;
        }
        const meta = this.bridge.getMetadata();
        const raw = meta[this.storageKey];
        if (!Array.isArray(raw)) {
            return;
        }
        this.sessions.clear();
        for (const item of raw) {
            if (isValidAssistantSession(item)) {
                this.sessions.set(item.id, cloneSession(item));
            }
        }
    }

    private persist(): void {
        if (!this.bridge || this.persistenceMode === 'memory') {
            return;
        }
        const snapshot = this.listSessions();
        if (this.persistenceMode === 'metadata') {
            const meta = this.bridge.getMetadata();
            meta[this.storageKey] = snapshot;
            this.bridge.saveChatDebounced();
            return;
        }

        const bridge = this.bridge;
        const key = this.storageKey;
        this.persistChain = this.persistChain
            .catch(() => {
                // Keep persistence chain healthy
            })
            .then(async () => {
                await bridge.saveExtensionData(key, snapshot);
            });
    }
}
