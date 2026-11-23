import type { HostBridge } from '@/core/bridge';
import {
    estimateRequestTokens,
    groupLayer1Turns,
    TrajectoryStore,
    type FrozenStaticPrefix,
    type Layer1TurnGroup,
} from '@/core/context';
import type {
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
    connectionId?: string;
}

export type AssistantSessionPatch = Partial<
    Pick<
        AssistantSession,
        'title' | 'mode' | 'stAdminEnabled' | 'autoApproveAuthor' | 'connectionId'
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

function contentToPlainText(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    return content
        .map((part) => {
            if (part.type === 'text') return part.text;
            if (part.type === 'image_url') return `[image:${part.imageUrl}]`;
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
