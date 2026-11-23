import type { HostBridge, LLMRequest, LLMTransport } from '@/core/bridge';
import { createDefaultSettings, resolveConnection } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import type { TraceLogger } from '@/core/logger';
import { ChatDataStore, DATA_NAMESPACES, MESSAGE_OVERRIDE_KEY } from '@/core/store';
import type { DynamicVariableSchema } from '@/core/tools';
import type {
    ApiConnection,
    AssistantAttachment,
    AssistantMessage,
    AssistantMessageUsage,
    AssistantMode,
    AssistantSession,
    AssistantToolCallRecord,
    CanonicalMessage,
    CanonicalToolCall,
    CanonicalToolSchema,
    HostCharacterCreatePayload,
    HostCharacterPatch,
    HostRegexScript,
    HostSettingsScope,
    MessageTarget,
    PendingApproval,
    RawLoreEntry,
    Settings,
    TokenUsage,
    UndoRecord,
} from '@/core/types';
import { canonicalClone, normalizeVfsPath } from '@/core/utils';
import { VirtualFileSystem } from '@/core/vfs';
import { ApprovalGate, shouldRequireApproval } from './approval';
import {
    evaluateToolPolicy,
    getAllowedToolsForMode,
    type ToolPolicyResult,
} from './policy';
import { redactString, redactWithReport } from './redact';
import {
    AssistantSessionStore,
    buildAssistantUserContent,
    type AssistantRetractResult,
    type AssistantSessionPatch,
    type CreateAssistantSessionOptions,
} from './session-store';
import { createAdjustTools } from './tools-adjust';
import { createAdminTierTools } from './tools-admin';
import { createAuthorTools } from './tools-author';
import {
    createAssistantAbortError,
    createChatReadOnlyTools,
    executeAssistantTool,
    isAssistantAbortError,
    throwIfAssistantAborted,
    toCanonicalAssistantToolSchemas,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';
import {
    createUndoKindDispatcher,
    UndoStore,
    type UndoExecutor,
    type UndoRevertResult,
} from './undo-store';

export interface AssistantRunnerOptions {
    bridge: HostBridge;
    transport: LLMTransport;
    store?: ChatDataStore;
    vfs?: VirtualFileSystem;
    trajectoryStore?: TrajectoryStore;
    sessionStore?: AssistantSessionStore;
    approvalGate?: ApprovalGate;
    undoStore?: UndoStore;
    traceLogger?: TraceLogger;
    settings?: Settings | (() => Settings);
    resolveConnection?: (connectionId: string) => ApiConnection | undefined;
    getActiveTarget?: () => MessageTarget;
    getVariableSchema?: () => DynamicVariableSchema | undefined;
    getStatusSnapshot?: () => Record<string, unknown>;
    extraTools?: readonly AssistantToolDefinition[];
    maxToolRounds?: number;
    stream?: boolean;
    now?: () => number;
    idGenerator?: () => string;
}

export interface AssistantSendOptions {
    target?: MessageTarget;
    attachments?: AssistantAttachment[];
    onDelta?: (delta: string) => void;
    onReasoningDelta?: (delta: string) => void;
    onUpdate?: (session: AssistantSession) => void;
    signal?: AbortSignal;
    stream?: boolean;
}

interface SuspendedApprovalContext {
    approvalId: string;
    sessionId: string;
    messageId: string;
    toolCall: CanonicalToolCall;
    policy: ToolPolicyResult;
    target: MessageTarget;
    inFlightMessages: CanonicalMessage[];
}

interface TurnLLMOutput {
    content: string;
    reasoningContent: string;
    toolCalls: CanonicalToolCall[];
    usage: TokenUsage;
    finishReason?: string;
}

const DEFAULT_MAX_TOOL_ROUNDS = 12;

function normalizeUsage(partial?: Partial<TokenUsage>): TokenUsage {
    const inputTokens = partial?.inputTokens ?? 0;
    const cachedTokens = partial?.cachedTokens ?? 0;
    const outputTokens = partial?.outputTokens ?? 0;
    const totalTokens = partial?.totalTokens ?? inputTokens + outputTokens;
    const cacheHitRate =
        partial?.cacheHitRate ?? (inputTokens > 0 ? cachedTokens / inputTokens : 0);
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens,
        cacheHitRate,
    };
}

function addTokenUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
    const inputTokens = acc.inputTokens + next.inputTokens;
    const cachedTokens = acc.cachedTokens + next.cachedTokens;
    const outputTokens = acc.outputTokens + next.outputTokens;
    return {
        inputTokens,
        cachedTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheHitRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    };
}

function toAssistantMessageUsage(usage: TokenUsage): AssistantMessageUsage {
    const cacheRate =
        usage.inputTokens > 0
            ? `${((Math.min(usage.inputTokens, usage.cachedTokens) / usage.inputTokens) * 100).toFixed(1)}%`
            : '0.0%';
    return {
        inputTokens: usage.inputTokens,
        cachedTokens: usage.cachedTokens,
        outputTokens: usage.outputTokens,
        cacheRate,
    };
}

function safeParseJsonObject(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // Return empty object; tool schema validation will surface structured errors.
    }
    return {};
}

function buildAssistantSystemPrompt(mode: AssistantMode, stAdminEnabled: boolean): string {
    const lines: string[] = [
        'You are the ST-Agentic Off-Mainline Assistant operating outside the mainline RP context (0 mainline token overhead).',
        `Current capability mode: ${mode}${mode === 'full' ? ` (stAdminEnabled=${String(stAdminEnabled)})` : ''}.`,
        'Use the provided tools directly to inspect context, diagnose issues, and apply authorized changes.',
    ];
    if (mode === 'chat') {
        lines.push('Mode rule: STRICTLY READ-ONLY. Never attempt mutations.');
    } else if (mode === 'adjust') {
        lines.push(
            'Mode rule: Current-chat adjustments allowed (/workspace/**, /state/**, /lorebooks/**, /side/**, chat messages). Pre-write UndoRecords are captured automatically.',
        );
    } else if (mode === 'author') {
        lines.push(
            'Mode rule: Authoring mode enabled. You may edit the active character card, primary World Info (raw @@ decorators and <% ... %> EJS are preserved verbatim), and character-scoped regex. Permanent mutations require user diff approval.',
        );
    } else if (mode === 'full') {
        lines.push(
            stAdminEnabled
                ? 'Mode rule: Full control + ST Admin enabled. High-risk destructive, settings, preset, global regex, slash, and import operations always require mandatory manual confirmation.'
                : 'Mode rule: Full control over all enabled World Info books (raw @@ and EJS preserved). Permanent writes require user approval.',
        );
    }
    return lines.join('\n');
}

/**
 * Create the complete `UndoExecutor` handling all 7 `UndoKind`s by executing exact
 * reverse operations against `HostBridge`, `ChatDataStore`, `VirtualFileSystem`,
 * `HostAuthorBridge`, and `HostAdminBridge`.
 */
export function createAssistantUndoExecutor(deps: {
    bridge: HostBridge;
    store: ChatDataStore;
    vfs: VirtualFileSystem;
}): UndoExecutor {
    const { bridge, store, vfs } = deps;

    return createUndoKindDispatcher({
        chat_message: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            if (action === 'edit') {
                const target = (snap.target ?? record.target) as MessageTarget | undefined;
                if (!target) {
                    throw new Error('Missing target in chat_message undo snapshot.');
                }
                const prevContent = String(snap.previousContent ?? '');
                await bridge.writeChatMessage(target, prevContent, { emitEvent: true });
                return;
            }
            if (action === 'toggle_hide') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo chat_toggle_hide_message.');
                }
                const messageId = Number(snap.messageId ?? record.target?.messageId);
                const previousHidden = Boolean(snap.previousHidden);
                await bridge.author.toggleChatMessageHidden(messageId, previousHidden);
                return;
            }
            if (action === 'override_display') {
                const target = (snap.target ?? record.target) as MessageTarget | undefined;
                if (!target) {
                    throw new Error('Missing target in override_display undo snapshot.');
                }
                if (snap.hadPreviousOverride) {
                    store.set(
                        DATA_NAMESPACES.MESSAGE,
                        MESSAGE_OVERRIDE_KEY,
                        String(snap.previousOverrideSource ?? 'assistant:undo'),
                        String(snap.previousOverrideContent ?? ''),
                        { target, staged: false },
                    );
                } else {
                    store.remove(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, target);
                }
                await bridge.refreshMessageView(target);
                return;
            }
            throw new Error(`Unsupported chat_message undo action: "${String(action)}".`);
        },

        variables: async (record: UndoRecord) => {
            const previousVars = (record.snapshot.previousVars ?? {}) as Record<string, unknown>;
            await vfs.writeVariables(previousVars, {
                target: record.target,
                staged: false,
                source: 'assistant:undo',
            });
        },

        vfs_file: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const path = String(snap.path ?? '');
            if (!path) {
                throw new Error('Missing VFS path in vfs_file undo snapshot.');
            }
            const isLorebook = Boolean(snap.isLorebook) || path.startsWith('/lorebooks/');
            if (isLorebook) {
                if (!snap.hadOverride) {
                    await vfs.deleteFile(path, {
                        target: record.target,
                        staged: false,
                        source: 'assistant:undo',
                    });
                } else {
                    await vfs.writeFile(path, String(snap.previousContent ?? ''), {
                        target: record.target,
                        staged: false,
                        source: 'assistant:undo',
                    });
                }
                return;
            }

            if (!snap.existed) {
                await vfs.deleteFile(path, {
                    target: record.target,
                    staged: false,
                    source: 'assistant:undo',
                });
            } else {
                await vfs.writeFile(path, String(snap.previousContent ?? ''), {
                    target: record.target,
                    staged: false,
                    source: 'assistant:undo',
                });
            }
        },

        character: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const scope = snap.scope;
            if (scope === 'active') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo active character patch.');
                }
                const previousFields = (snap.previousFields ?? {}) as HostCharacterPatch;
                await bridge.author.patchActiveCharacter(previousFields, {
                    sessionId: record.sessionId,
                    toolCallId: record.toolCallId,
                    reason: `undo:${record.id}`,
                });
                return;
            }
            if (!bridge.admin) {
                throw new Error('HostAdminBridge is required to undo admin character operation.');
            }
            if (scope === 'admin_patch') {
                await bridge.admin.patchCharacterById(
                    Number(snap.chid),
                    (snap.previousFields ?? {}) as HostCharacterPatch,
                );
                return;
            }
            if (scope === 'admin_create') {
                await bridge.admin.deleteCharacterById(Number(snap.chid));
                return;
            }
            if (scope === 'admin_delete') {
                const prevChar = snap.previousCharacter as HostCharacterCreatePayload | undefined;
                if (prevChar && typeof prevChar.name === 'string') {
                    await bridge.admin.createCharacter(prevChar);
                }
                return;
            }
            if (scope === 'admin_select') {
                if (typeof snap.previousChid === 'number') {
                    await bridge.admin.selectCharacterById(snap.previousChid);
                }
                return;
            }
            throw new Error(`Unsupported character undo scope: "${String(scope)}".`);
        },

        worldinfo: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            const bookName = String(snap.bookName ?? '');
            if (action === 'update_entry' || action === 'delete_entry') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo World Info entry edit.');
                }
                const prevEntry = snap.previousEntry as RawLoreEntry | null | undefined;
                if (!prevEntry) {
                    throw new Error('Missing previousEntry in worldinfo undo snapshot.');
                }
                await bridge.author.upsertWorldInfoEntry(
                    bookName,
                    {
                        uid: prevEntry.uid,
                        comment: prevEntry.comment,
                        content: prevEntry.content,
                        keys: [...(prevEntry.keys ?? [])],
                        keysecondary: [...(prevEntry.keysecondary ?? [])],
                        constant: prevEntry.constant,
                        selective: prevEntry.selective,
                        selectiveLogic: prevEntry.selectiveLogic,
                        disable: prevEntry.disable,
                        position: prevEntry.position,
                        depth: prevEntry.depth,
                        order: prevEntry.order,
                        role: prevEntry.role,
                        caseSensitive: prevEntry.caseSensitive,
                        matchWholeWords: prevEntry.matchWholeWords,
                        probability: prevEntry.probability,
                        useProbability: prevEntry.useProbability,
                        group: prevEntry.group,
                        groupOverride: prevEntry.groupOverride,
                        groupWeight: prevEntry.groupWeight,
                        scanDepth: prevEntry.scanDepth,
                        extensions: prevEntry.extensions,
                    },
                    {
                        rawDirect: true,
                        undoMeta: {
                            sessionId: record.sessionId,
                            toolCallId: record.toolCallId,
                            reason: `undo:${record.id}`,
                        },
                    },
                );
                return;
            }
            if (action === 'create_entry') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo World Info entry creation.');
                }
                await bridge.author.deleteWorldInfoEntry(bookName, Number(snap.uid));
                return;
            }
            if (action === 'bind_book') {
                if (!bridge.admin) {
                    throw new Error('HostAdminBridge is required to undo bindWorldBook.');
                }
                await bridge.admin.bindWorldBook(bookName, Boolean(snap.previousEnabled));
                return;
            }
            if (action === 'create_book') {
                if (bridge.admin) {
                    await bridge.admin.bindWorldBook(bookName, false);
                }
                return;
            }
            throw new Error(`Unsupported worldinfo undo action: "${String(action)}".`);
        },

        regex: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const previousScripts = (snap.previousScripts ?? []) as HostRegexScript[];
            if (snap.scope === 'scoped') {
                if (!bridge.author) {
                    throw new Error('HostAuthorBridge is required to undo scoped regex.');
                }
                await bridge.author.saveScopedRegex(previousScripts);
                return;
            }
            if (snap.scope === 'global') {
                if (!bridge.admin) {
                    throw new Error('HostAdminBridge is required to undo global regex.');
                }
                await bridge.admin.saveGlobalRegex(previousScripts);
                return;
            }
            throw new Error(`Unsupported regex undo scope: "${String(snap.scope)}".`);
        },

        st_setting: async (record: UndoRecord) => {
            const snap = record.snapshot;
            const action = snap.action;
            if (action === 'slash_exec' || action === 'import_url') {
                return;
            }
            if (!bridge.admin) {
                throw new Error('HostAdminBridge is required to undo ST admin setting.');
            }
            if (action === 'settings_patch') {
                const scope = String(snap.scope ?? 'all') as HostSettingsScope;
                const prevValues = (snap.previousValues ?? {}) as Record<string, unknown>;
                await bridge.admin.patchHostSettings(scope, prevValues);
                return;
            }
            if (action === 'preset_select') {
                if (typeof snap.previousName === 'string' && snap.previousName) {
                    await bridge.admin.selectPreset(
                        snap.previousName,
                        typeof snap.apiType === 'string' ? snap.apiType : undefined,
                    );
                }
                return;
            }
            if (action === 'preset_patch') {
                await bridge.admin.patchPreset(
                    String(snap.name ?? ''),
                    (snap.previousData ?? {}) as Record<string, unknown>,
                    typeof snap.apiType === 'string' ? snap.apiType : undefined,
                );
                return;
            }
            if (action === 'persona_upsert') {
                const prev = snap.previousPersona as
                    | { key: string; description: string; title?: string }
                    | null
                    | undefined;
                if (prev) {
                    await bridge.admin.upsertPersona(prev.key, prev.description, prev.title);
                }
                return;
            }
            if (action === 'persona_select') {
                if (typeof snap.previousKey === 'string' && snap.previousKey) {
                    await bridge.admin.selectPersona(snap.previousKey);
                }
                return;
            }
            throw new Error(`Unsupported st_setting undo action: "${String(action)}".`);
        },
    });
}

/**
 * Off-mainline Assistant Runtime implementing 4-tier tool execution, KV-cache-friendly
 * multi-turn streaming, inline bubble approval/reject/retry loops, pre-write snapshots,
 * secret redaction, and `AssistantRuntimeBridge` 1:1 compatibility.
 */
export class AssistantRunner {
    public readonly bridge: HostBridge;
    public readonly transport: LLMTransport;
    public readonly store: ChatDataStore;
    public readonly vfs: VirtualFileSystem;
    public readonly trajectoryStore: TrajectoryStore;
    public readonly sessionStore: AssistantSessionStore;
    public readonly approvalGate: ApprovalGate;
    public readonly undoStore: UndoStore;
    public readonly traceLogger?: TraceLogger;

    private readonly toolsByName = new Map<string, AssistantToolDefinition>();
    private readonly undoExecutor: UndoExecutor;
    private readonly settingsProvider: () => Settings;
    private readonly customConnectionResolver?: (connectionId: string) => ApiConnection | undefined;
    private readonly activeTargetProvider?: () => MessageTarget;
    private readonly variableSchemaProvider?: () => DynamicVariableSchema | undefined;
    private readonly statusSnapshotProvider?: () => Record<string, unknown>;
    private readonly maxToolRounds: number;
    private readonly defaultStream: boolean;
    private readonly now: () => number;
    private readonly idGenerator: () => string;

    private readonly listeners = new Set<() => void>();
    private readonly activeControllers = new Map<string, AbortController>();
    private readonly suspendedApprovals = new Map<string, SuspendedApprovalContext>();
    private seq = 0;

    constructor(options: AssistantRunnerOptions) {
        this.bridge = options.bridge;
        this.transport = options.transport;
        this.store = options.store ?? options.vfs?.store ?? new ChatDataStore(options.bridge);
        this.vfs =
            options.vfs
            ?? new VirtualFileSystem({
                bridge: this.bridge,
                store: this.store,
            });
        this.trajectoryStore =
            options.trajectoryStore
            ?? options.sessionStore?.trajectoryStore
            ?? new TrajectoryStore();
        this.sessionStore =
            options.sessionStore
            ?? new AssistantSessionStore({
                bridge: this.bridge,
                trajectoryStore: this.trajectoryStore,
                now: options.now,
            });
        this.approvalGate = options.approvalGate ?? new ApprovalGate({ now: options.now });
        this.undoStore = options.undoStore ?? new UndoStore({ now: options.now });
        this.traceLogger = options.traceLogger;

        this.settingsProvider =
            typeof options.settings === 'function'
                ? options.settings
                : options.settings
                    ? () => options.settings as Settings
                    : () => createDefaultSettings();
        this.customConnectionResolver = options.resolveConnection;
        this.activeTargetProvider = options.getActiveTarget;
        this.variableSchemaProvider = options.getVariableSchema;
        this.statusSnapshotProvider = options.getStatusSnapshot;
        this.maxToolRounds = Math.max(1, options.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS);
        this.defaultStream = options.stream ?? true;
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `ast_msg_${this.now()}_${this.seq}`;
            });

        const allTools: AssistantToolDefinition[] = [
            ...createChatReadOnlyTools(),
            ...createAdjustTools(),
            ...createAuthorTools(),
            ...createAdminTierTools(),
            ...(options.extraTools ?? []),
        ];
        for (const tool of allTools) {
            this.toolsByName.set(tool.name, tool);
        }

        this.undoExecutor = createAssistantUndoExecutor({
            bridge: this.bridge,
            store: this.store,
            vfs: this.vfs,
        });
    }

    // ========================================================================
    // Session CRUD & Subscription (AssistantRuntimeBridge)
    // ========================================================================

    public listSessions(): AssistantSession[] {
        return this.sessionStore.listSessions();
    }

    public getSession(sessionId: string): AssistantSession | null {
        return this.sessionStore.getSession(sessionId);
    }

    public async createSession(
        options?: CreateAssistantSessionOptions,
    ): Promise<AssistantSession> {
        const session = this.sessionStore.createSession(options);
        this.notify();
        return session;
    }

    public async deleteSession(sessionId: string): Promise<boolean> {
        this.abort(sessionId);
        this.approvalGate.clear(sessionId);
        for (const [apprId, ctx] of Array.from(this.suspendedApprovals.entries())) {
            if (ctx.sessionId === sessionId) {
                this.suspendedApprovals.delete(apprId);
            }
        }
        const deleted = this.sessionStore.deleteSession(sessionId);
        if (deleted) {
            this.notify();
        }
        return deleted;
    }

    public async updateSessionConfig(
        sessionId: string,
        patch: AssistantSessionPatch,
    ): Promise<AssistantSession | null> {
        const updated = this.sessionStore.updateSession(sessionId, patch);
        if (updated) {
            this.notify();
        }
        return updated;
    }

    public subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public listApprovals(sessionId?: string): PendingApproval[] {
        return this.approvalGate.list(sessionId ? { sessionId } : undefined);
    }

    public getApproval(approvalId: string): PendingApproval | undefined {
        return this.approvalGate.get(approvalId);
    }

    public listUndoRecords(sessionId?: string): UndoRecord[] {
        return this.undoStore.list(sessionId);
    }

    /**
     * Read a VFS file for UI preview with automatic secret redaction.
     */
    public async readPreviewFile(path: string): Promise<string | null> {
        try {
            const normalized = normalizeVfsPath(path);
            const raw = await this.vfs.readFile(normalized, {
                target: this.resolveActiveTarget(),
                staged: false,
            });
            return redactString(raw).value;
        } catch {
            return null;
        }
    }

    /**
     * Return canonical sorted tool definitions unlocked for `(mode, stAdminEnabled)`.
     */
    public getAllowedToolDefinitions(
        mode: AssistantMode,
        stAdminEnabled: boolean = false,
    ): AssistantToolDefinition[] {
        const allowedNames = getAllowedToolsForMode(mode, stAdminEnabled);
        const defs: AssistantToolDefinition[] = [];
        for (const name of allowedNames) {
            const def = this.toolsByName.get(name);
            if (def) {
                defs.push(def);
            }
        }
        return defs;
    }

    /**
     * Abort an active streaming/tool execution for `sessionId`, or all active sessions when omitted.
     */
    public abort(sessionId?: string): void {
        if (sessionId !== undefined) {
            const controller = this.activeControllers.get(sessionId);
            if (controller && !controller.signal.aborted) {
                controller.abort(createAssistantAbortError(`Assistant session "${sessionId}" aborted`));
            }
            this.activeControllers.delete(sessionId);
            return;
        }
        for (const [id, controller] of Array.from(this.activeControllers.entries())) {
            if (!controller.signal.aborted) {
                controller.abort(createAssistantAbortError(`Assistant session "${id}" aborted`));
            }
            this.activeControllers.delete(id);
        }
    }

    // ========================================================================
    // Multi-Turn Streaming Execution Loop
    // ========================================================================

    public async sendPrompt(
        sessionId: string,
        prompt: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        return await this.executeAssistantTurn(sessionId, prompt, options, {
            appendUserMessage: true,
        });
    }

    /**
     * Rewrite an existing user or assistant message in place and reconcile `TrajectoryStore`
     * while preserving prior turns verbatim.
     */
    public async editMessage(
        sessionId: string,
        messageId: string,
        newContent: string,
    ): Promise<AssistantSession | null> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            return null;
        }
        const existingMsg = session.messages.find((m) => m.id === messageId);
        if (!existingMsg) {
            return null;
        }
        const hasAttachments = Boolean(
            existingMsg.attachments && existingMsg.attachments.length > 0,
        );
        if (!newContent.trim() && !hasAttachments) {
            throw new Error('Edited message content cannot be empty.');
        }

        this.abort(sessionId);

        const updatedMsg = this.sessionStore.updateMessage(sessionId, messageId, (prev) => ({
            ...prev,
            content: newContent,
            ...(prev.interrupted ? { interrupted: false } : {}),
        }));
        if (!updatedMsg) {
            return null;
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId);
        this.notify();
        return this.sessionStore.getSession(sessionId);
    }

    /**
     * Rewrite a user message, truncate any subsequent messages and pending approvals,
     * sync `TrajectoryStore` strictly before that turn, and stream a fresh assistant reply.
     */
    public async editAndResendMessage(
        sessionId: string,
        messageId: string,
        newContent: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        const idx = session.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) {
            throw new Error(`Assistant message not found: "${messageId}".`);
        }
        const existingMsg = session.messages[idx];
        if (existingMsg.role !== 'user') {
            throw new Error(`Only user messages can be edited and resent ("${messageId}").`);
        }
        const hasAttachments = Boolean(
            existingMsg.attachments && existingMsg.attachments.length > 0,
        );
        if (!newContent.trim() && !hasAttachments) {
            throw new Error('Edited message content cannot be empty.');
        }

        this.abort(sessionId);

        this.sessionStore.updateMessage(sessionId, messageId, (prev) => ({
            ...prev,
            content: newContent,
        }));

        const truncated = this.sessionStore.truncateAfterMessage(sessionId, messageId);
        if (truncated && truncated.removedMessages.length > 0) {
            this.cleanupApprovalsForMessages(sessionId, truncated.removedMessages);
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId, { upToMessageIndex: idx });
        this.emitSessionUpdate(sessionId, options.onUpdate);

        return await this.executeAssistantTurn(
            sessionId,
            newContent,
            {
                ...options,
                attachments: options.attachments ?? existingMsg.attachments,
            },
            {
                appendUserMessage: false,
            },
        );
    }

    /**
     * Retract `messageId` and all following messages from the session, removing any
     * associated pending approvals while keeping historical `UndoRecord`s intact.
     */
    public async retractMessage(
        sessionId: string,
        messageId: string,
    ): Promise<AssistantRetractResult | null> {
        this.abort(sessionId);

        const result = this.sessionStore.retractFromMessage(sessionId, messageId);
        if (!result) {
            return null;
        }

        this.cleanupApprovalsForMessages(sessionId, result.removedMessages);
        this.notify();
        return result;
    }

    /**
     * Regenerate the response for the trailing user turn (truncating any trailing assistant
     * reply/tool approvals first) while preserving earlier turns' KV-cache prefix verbatim.
     */
    public async regenerateLastMessage(
        sessionId: string,
        options: AssistantSendOptions = {},
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }
        if (session.messages.length === 0) {
            throw new Error('No user message available to regenerate.');
        }

        let lastUserIdx = -1;
        for (let i = session.messages.length - 1; i >= 0; i -= 1) {
            if (session.messages[i].role === 'user') {
                lastUserIdx = i;
                break;
            }
        }
        if (lastUserIdx < 0) {
            throw new Error('No user message available to regenerate.');
        }

        this.abort(sessionId);

        const targetUserMsg = session.messages[lastUserIdx];
        if (lastUserIdx < session.messages.length - 1) {
            const truncated = this.sessionStore.truncateAfterMessage(sessionId, targetUserMsg.id);
            if (truncated && truncated.removedMessages.length > 0) {
                this.cleanupApprovalsForMessages(sessionId, truncated.removedMessages);
            }
        }

        this.sessionStore.syncTrajectoryToMessages(sessionId, { upToMessageIndex: lastUserIdx });
        this.emitSessionUpdate(sessionId, options.onUpdate);

        return await this.executeAssistantTurn(
            sessionId,
            targetUserMsg.content,
            {
                ...options,
                attachments: options.attachments ?? targetUserMsg.attachments,
            },
            {
                appendUserMessage: false,
            },
        );
    }

    private async executeAssistantTurn(
        sessionId: string,
        prompt: string,
        options: AssistantSendOptions,
        config: { appendUserMessage: boolean },
    ): Promise<AssistantMessage> {
        const session = this.sessionStore.getSession(sessionId);
        if (!session) {
            throw new Error(`Assistant session not found: "${sessionId}".`);
        }

        // Cancel any previous in-flight run on the same session cleanly.
        this.abort(sessionId);
        const controller = new AbortController();
        this.activeControllers.set(sessionId, controller);

        const cleanupExternalSignal = this.linkExternalSignal(controller, options.signal);

        const target = options.target ?? this.resolveActiveTarget();
        const attachments =
            options.attachments && options.attachments.length > 0
                ? canonicalClone(options.attachments)
                : undefined;

        if (config.appendUserMessage) {
            const userMessage: AssistantMessage = {
                id: this.idGenerator(),
                role: 'user',
                content: prompt,
                ...(attachments ? { attachments } : {}),
                timestamp: this.now(),
            };
            this.sessionStore.appendMessage(sessionId, userMessage);
        }

        const assistantMessageId = this.idGenerator();
        let assistantMessage: AssistantMessage = {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: this.now(),
        };
        this.sessionStore.appendMessage(sessionId, assistantMessage);
        this.emitSessionUpdate(sessionId, options.onUpdate);

        const inFlightMessages: CanonicalMessage[] = [
            {
                role: 'user',
                content: buildAssistantUserContent(prompt, attachments),
            },
        ];
        const toolCallRecords: AssistantToolCallRecord[] = [];
        const approvalIds: string[] = [];
        const fileRefs = new Set<string>();
        let cumulativeUsage: TokenUsage = normalizeUsage();
        let thinkBuffer = '';
        let contentBuffer = '';

        const syncAssistantBubble = (patch?: Partial<AssistantMessage>): void => {
            assistantMessage = {
                ...assistantMessage,
                content: contentBuffer,
                ...(thinkBuffer ? { think: thinkBuffer } : {}),
                ...(toolCallRecords.length > 0 ? { toolCalls: canonicalClone(toolCallRecords) } : {}),
                ...(approvalIds.length > 0 ? { approvalIds: [...approvalIds] } : {}),
                ...(fileRefs.size > 0 ? { fileRefs: Array.from(fileRefs) } : {}),
                ...(cumulativeUsage.inputTokens > 0 || cumulativeUsage.outputTokens > 0
                    ? { usage: toAssistantMessageUsage(cumulativeUsage) }
                    : {}),
                ...(patch ?? {}),
            };
            this.sessionStore.updateMessage(sessionId, assistantMessageId, () => assistantMessage);
            this.emitSessionUpdate(sessionId, options.onUpdate);
        };

        try {
            const currentSession = this.sessionStore.getSession(sessionId) ?? session;
            const connection = this.resolveEffectiveConnection(currentSession.connectionId);
            const systemPrompt = buildAssistantSystemPrompt(
                currentSession.mode,
                currentSession.stAdminEnabled,
            );
            const allowedToolDefs = this.getAllowedToolDefinitions(
                currentSession.mode,
                currentSession.stAdminEnabled,
            );
            const canonicalTools: CanonicalToolSchema[] =
                toCanonicalAssistantToolSchemas(allowedToolDefs);
            const useStream = options.stream ?? connection.stream ?? this.defaultStream;

            let rounds = 0;

            while (rounds < this.maxToolRounds) {
                throwIfAssistantAborted(controller.signal);
                rounds += 1;

                const assembled = this.sessionStore.buildRequestMessages(
                    sessionId,
                    systemPrompt,
                    canonicalTools,
                    inFlightMessages,
                );

                const request: LLMRequest = {
                    connectionId: connection.id,
                    connection,
                    messages: assembled.messages,
                    tools: assembled.tools,
                    cacheBreakpoints: assembled.cacheBreakpoints,
                    stream: useStream,
                    signal: controller.signal,
                };

                const turnOutput = await this.invokeLLM(request, useStream, {
                    onTextDelta: (delta) => {
                        contentBuffer += delta;
                        options.onDelta?.(delta);
                        syncAssistantBubble();
                    },
                    onReasoningDelta: (delta) => {
                        thinkBuffer += delta;
                        options.onReasoningDelta?.(delta);
                        syncAssistantBubble();
                    },
                });

                cumulativeUsage = addTokenUsage(cumulativeUsage, turnOutput.usage);
                if (!useStream) {
                    if (turnOutput.content) {
                        contentBuffer += turnOutput.content;
                        options.onDelta?.(turnOutput.content);
                    }
                    if (turnOutput.reasoningContent) {
                        thinkBuffer += turnOutput.reasoningContent;
                        options.onReasoningDelta?.(turnOutput.reasoningContent);
                    }
                }

                // Final text-only turn: commit to TrajectoryStore & compact if needed.
                if (turnOutput.toolCalls.length === 0) {
                    const finalCanonicalAssistant: CanonicalMessage = {
                        role: 'assistant',
                        content: turnOutput.content,
                        ...(turnOutput.reasoningContent
                            ? { reasoningContent: turnOutput.reasoningContent }
                            : {}),
                    };
                    this.sessionStore.appendTrajectoryTurn(sessionId, [
                        ...inFlightMessages,
                        finalCanonicalAssistant,
                    ]);
                    this.sessionStore.compactIfNeeded(sessionId);
                    syncAssistantBubble();
                    return canonicalClone(assistantMessage);
                }

                // Tool-calling round
                const assistantToolMessage: CanonicalMessage = {
                    role: 'assistant',
                    content: turnOutput.content,
                    ...(turnOutput.reasoningContent
                        ? { reasoningContent: turnOutput.reasoningContent }
                        : {}),
                    toolCalls: canonicalClone(turnOutput.toolCalls),
                };
                inFlightMessages.push(assistantToolMessage);

                const liveSession = this.sessionStore.getSession(sessionId) ?? currentSession;
                let suspendedThisRound = false;

                for (const toolCall of turnOutput.toolCalls) {
                    throwIfAssistantAborted(controller.signal);

                    const startedAt = this.now();
                    const parsedArgs = safeParseJsonObject(toolCall.arguments);
                    const policy = evaluateToolPolicy(toolCall.name, parsedArgs, {
                        mode: liveSession.mode,
                        stAdminEnabled: liveSession.stAdminEnabled,
                        autoApproveAuthor: liveSession.autoApproveAuthor,
                    });

                    const redactedArgsSummary = truncateSummary(
                        JSON.stringify(redactWithReport(parsedArgs).value),
                        140,
                    );

                    // 1. Policy denied -> reject without executing
                    if (!policy.allowed) {
                        const deniedPayload = JSON.stringify({
                            ok: false,
                            error: policy.reason ?? `Tool "${toolCall.name}" denied by policy.`,
                        });
                        toolCallRecords.push({
                            id: toolCall.id,
                            name: toolCall.name,
                            scopeLabel: policy.scopeLabel,
                            status: 'error',
                            durationMs: Math.max(0, this.now() - startedAt),
                            argsSummary: redactedArgsSummary,
                            resultSummary: truncateSummary(
                                policy.reason ?? `Denied tool "${toolCall.name}"`,
                            ),
                        });
                        inFlightMessages.push({
                            role: 'tool',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            content: deniedPayload,
                        });
                        syncAssistantBubble();
                        continue;
                    }

                    const toolDef = this.toolsByName.get(toolCall.name);
                    if (!toolDef) {
                        const missingMsg = `Tool "${toolCall.name}" is allowed by policy but not registered.`;
                        toolCallRecords.push({
                            id: toolCall.id,
                            name: toolCall.name,
                            scopeLabel: policy.scopeLabel,
                            status: 'error',
                            durationMs: Math.max(0, this.now() - startedAt),
                            argsSummary: redactedArgsSummary,
                            resultSummary: missingMsg,
                        });
                        inFlightMessages.push({
                            role: 'tool',
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            content: JSON.stringify({ ok: false, error: missingMsg }),
                        });
                        syncAssistantBubble();
                        continue;
                    }

                    const toolCtx = this.createToolContext({
                        session: liveSession,
                        toolCallId: toolCall.id,
                        target,
                        signal: controller.signal,
                    });

                    // 2. Requires approval (including non-bypassable mandatoryConfirm) -> suspend into bubble PendingApproval
                    if (shouldRequireApproval(policy, liveSession.autoApproveAuthor)) {
                        const validated = toolDef.parameters.safeParse(parsedArgs);
                        if (!validated.success) {
                            const errResult = await executeAssistantTool(toolDef, parsedArgs, toolCtx);
                            toolCallRecords.push({
                                id: toolCall.id,
                                name: toolCall.name,
                                scopeLabel: policy.scopeLabel,
                                status: 'error',
                                durationMs: Math.max(0, this.now() - startedAt),
                                argsSummary: redactedArgsSummary,
                                resultSummary: truncateSummary(errResult.error ?? errResult.output),
                                ...(errResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
                            });
                            inFlightMessages.push({
                                role: 'tool',
                                toolCallId: toolCall.id,
                                toolName: toolCall.name,
                                content: errResult.output,
                            });
                            syncAssistantBubble();
                            continue;
                        }

                        const preview = await this.buildApprovalPreview(
                            toolDef,
                            validated.data as Record<string, unknown>,
                            policy,
                            toolCtx,
                        );
                        const pending = this.approvalGate.create({
                            sessionId,
                            messageId: assistantMessageId,
                            toolCallId: toolCall.id,
                            toolName: toolCall.name,
                            riskLevel: policy.riskLevel === 'high' ? 'high' : 'medium',
                            mandatoryConfirm: policy.mandatoryConfirm,
                            title: preview.title,
                            summary: preview.summary,
                            targetLabel: preview.targetLabel,
                            rawContent: preview.rawContent,
                            diffLines: preview.diffLines,
                            args: canonicalClone(validated.data as Record<string, unknown>),
                        });

                        approvalIds.push(pending.id);
                        this.suspendedApprovals.set(pending.id, {
                            approvalId: pending.id,
                            sessionId,
                            messageId: assistantMessageId,
                            toolCall: canonicalClone(toolCall),
                            policy,
                            target,
                            inFlightMessages: canonicalClone(inFlightMessages),
                        });
                        suspendedThisRound = true;
                        syncAssistantBubble();
                        continue;
                    }

                    // 3. Direct execution (read-only, adjust, or non-mandatory autoApproveAuthor)
                    const execResult = await executeAssistantTool(toolDef, parsedArgs, toolCtx);
                    if (execResult.fileRefs?.length) {
                        for (const ref of execResult.fileRefs) {
                            fileRefs.add(ref);
                        }
                    }

                    toolCallRecords.push({
                        id: toolCall.id,
                        name: toolCall.name,
                        scopeLabel: policy.scopeLabel,
                        status: execResult.ok ? 'ok' : 'error',
                        durationMs: Math.max(0, this.now() - startedAt),
                        argsSummary: redactedArgsSummary,
                        resultSummary: truncateSummary(
                            execResult.ok
                                ? execResult.output
                                : execResult.error ?? execResult.output,
                        ),
                        ...(execResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
                        ...(execResult.undoId ? { undoId: execResult.undoId } : {}),
                    });

                    inFlightMessages.push({
                        role: 'tool',
                        toolCallId: toolCall.id,
                        toolName: toolCall.name,
                        content: execResult.output,
                    });
                    syncAssistantBubble();
                }

                // Suspend turn cleanly so the inline bubble approval UI renders without blocking.
                if (suspendedThisRound) {
                    syncAssistantBubble();
                    return canonicalClone(assistantMessage);
                }
            }

            // Reached maxToolRounds: finalize whatever was streamed so far.
            syncAssistantBubble();
            return canonicalClone(assistantMessage);
        } catch (error) {
            if (isAssistantAbortError(error) || controller.signal.aborted) {
                syncAssistantBubble({ interrupted: true });
                return canonicalClone(assistantMessage);
            }
            const redactedErr = redactWithReport(
                error instanceof Error ? error.message : String(error),
            ).value;
            contentBuffer = contentBuffer
                ? `${contentBuffer}\n\n[Error] ${String(redactedErr)}`
                : `[Error] ${String(redactedErr)}`;
            syncAssistantBubble({ interrupted: true });
            throw new Error(String(redactedErr));
        } finally {
            cleanupExternalSignal();
            if (this.activeControllers.get(sessionId) === controller) {
                this.activeControllers.delete(sessionId);
            }
        }
    }

    // ========================================================================
    // Inline Bubble Approval / Reject / Retry / Undo Lifecycle
    // ========================================================================

    public async decideApproval(
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ): Promise<PendingApproval | null> {
        const existing = this.approvalGate.get(approvalId);
        if (!existing) {
            return null;
        }

        if (decision === 'reject') {
            const rejected = this.approvalGate.reject(approvalId, feedback);
            this.notify();
            return rejected;
        }

        // Approve: validate status first before executing write.
        if (existing.status !== 'pending') {
            throw new Error(
                `Cannot approve "${approvalId}" from status "${existing.status}"; expected "pending".`,
            );
        }

        const session = this.sessionStore.getSession(existing.sessionId);
        if (!session) {
            throw new Error(`Session "${existing.sessionId}" not found for approval "${approvalId}".`);
        }

        const policy = evaluateToolPolicy(existing.toolName, existing.args, {
            mode: session.mode,
            stAdminEnabled: session.stAdminEnabled,
            autoApproveAuthor: session.autoApproveAuthor,
        });
        if (!policy.allowed) {
            throw new Error(policy.reason ?? `Tool "${existing.toolName}" is no longer allowed.`);
        }

        const toolDef = this.toolsByName.get(existing.toolName);
        if (!toolDef) {
            throw new Error(`Tool "${existing.toolName}" is not registered.`);
        }

        const suspended = this.suspendedApprovals.get(approvalId);
        const target = suspended?.target ?? this.resolveActiveTarget();
        const startedAt = this.now();
        const signal = new AbortController().signal;

        const toolCtx = this.createToolContext({
            session,
            toolCallId: existing.toolCallId,
            target,
            signal,
        });

        const execResult = await executeAssistantTool(toolDef, existing.args, toolCtx);
        if (!execResult.ok) {
            throw new Error(execResult.error ?? `Execution of "${existing.toolName}" failed.`);
        }

        const approved = this.approvalGate.approve(approvalId, { undoId: execResult.undoId });

        const toolRecord: AssistantToolCallRecord = {
            id: existing.toolCallId,
            name: existing.toolName,
            scopeLabel: policy.scopeLabel,
            status: 'ok',
            durationMs: Math.max(0, this.now() - startedAt),
            argsSummary: truncateSummary(JSON.stringify(redactWithReport(existing.args).value), 140),
            resultSummary: truncateSummary(execResult.output),
            ...(execResult.hasSecretRedaction ? { hasSecretRedaction: true } : {}),
            ...(execResult.undoId ? { undoId: execResult.undoId } : {}),
        };

        this.sessionStore.updateMessage(existing.sessionId, existing.messageId, (msg) => {
            const nextCalls = [...(msg.toolCalls ?? [])];
            const idx = nextCalls.findIndex((c) => c.id === toolRecord.id);
            if (idx >= 0) {
                nextCalls[idx] = toolRecord;
            } else {
                nextCalls.push(toolRecord);
            }
            return {
                ...msg,
                content: msg.content.trim() ? msg.content : `已执行：${approved.title}`,
                toolCalls: nextCalls,
            };
        });

        // Commit the approved tool call + result into the session's TrajectoryStore thread.
        if (suspended) {
            const committedTurn: CanonicalMessage[] = [
                ...suspended.inFlightMessages,
                {
                    role: 'tool',
                    toolCallId: existing.toolCallId,
                    toolName: existing.toolName,
                    content: execResult.output,
                },
                {
                    role: 'assistant',
                    content: `Approved and executed ${existing.toolName}: ${approved.title}`,
                },
            ];
            this.sessionStore.appendTrajectoryTurn(existing.sessionId, committedTurn);
            this.sessionStore.compactIfNeeded(existing.sessionId);
            this.suspendedApprovals.delete(approvalId);
        }

        this.notify();
        return approved;
    }

    /**
     * Retry a `pending` or `rejected` approval by injecting optional user feedback into
     * the LLM, generating a revised tool proposal and real Diff, and incrementing `revision`.
     */
    public async retryApproval(
        approvalId: string,
        feedback?: string,
    ): Promise<PendingApproval | null> {
        const existing = this.approvalGate.get(approvalId);
        if (!existing) {
            return null;
        }
        if (existing.status === 'approved') {
            throw new Error(
                `Cannot retry already approved item "${approvalId}"; use undo() to revert instead.`,
            );
        }

        const session = this.sessionStore.getSession(existing.sessionId);
        if (!session) {
            throw new Error(`Session "${existing.sessionId}" not found for approval "${approvalId}".`);
        }

        const suspended = this.suspendedApprovals.get(approvalId);
        const target = suspended?.target ?? this.resolveActiveTarget();
        const connection = this.resolveEffectiveConnection(session.connectionId);
        const systemPrompt = buildAssistantSystemPrompt(session.mode, session.stAdminEnabled);
        const allowedToolDefs = this.getAllowedToolDefinitions(
            session.mode,
            session.stAdminEnabled,
        );
        const canonicalTools = toCanonicalAssistantToolSchemas(allowedToolDefs);

        const controller = new AbortController();
        this.activeControllers.set(existing.sessionId, controller);

        const feedbackText = feedback?.trim() || existing.rejectionFeedback?.trim() || '';
        const retryInstruction = feedbackText
            ? `User requested a revision for pending tool "${existing.toolName}" (revision #${existing.revision}) with feedback: ${feedbackText}. Call "${existing.toolName}" again with the revised arguments.`
            : `User requested an alternative revised proposal for pending tool "${existing.toolName}" (revision #${existing.revision}). Call "${existing.toolName}" again with revised arguments.`;

        const baseInFlight: CanonicalMessage[] = suspended
            ? canonicalClone(suspended.inFlightMessages)
            : [
                {
                    role: 'assistant',
                    content: existing.summary,
                    toolCalls: [
                        {
                            id: existing.toolCallId,
                            name: existing.toolName,
                            arguments: JSON.stringify(existing.args),
                        },
                    ],
                },
            ];

        const retryInFlight: CanonicalMessage[] = [
            ...baseInFlight,
            {
                role: 'tool',
                toolCallId: existing.toolCallId,
                toolName: existing.toolName,
                content: JSON.stringify({
                    ok: false,
                    status: 'retry_requested',
                    feedback: feedbackText || 'Please propose a revised version.',
                }),
            },
            {
                role: 'user',
                content: retryInstruction,
            },
        ];

        try {
            const assembled = this.sessionStore.buildRequestMessages(
                existing.sessionId,
                systemPrompt,
                canonicalTools,
                retryInFlight,
            );
            const useStream = connection.stream ?? this.defaultStream;
            const request: LLMRequest = {
                connectionId: connection.id,
                connection,
                messages: assembled.messages,
                tools: assembled.tools,
                cacheBreakpoints: assembled.cacheBreakpoints,
                stream: useStream,
                signal: controller.signal,
            };

            const turnOutput = await this.invokeLLM(request, useStream, {});

            const revisedCall =
                turnOutput.toolCalls.find((tc) => tc.name === existing.toolName)
                ?? turnOutput.toolCalls[0];

            if (revisedCall) {
                const revisedArgsRaw = safeParseJsonObject(revisedCall.arguments);
                const toolDef = this.toolsByName.get(revisedCall.name);
                const policy = evaluateToolPolicy(revisedCall.name, revisedArgsRaw, {
                    mode: session.mode,
                    stAdminEnabled: session.stAdminEnabled,
                    autoApproveAuthor: session.autoApproveAuthor,
                });

                if (toolDef && policy.allowed) {
                    const validated = toolDef.parameters.safeParse(revisedArgsRaw);
                    const finalArgs = validated.success
                        ? (validated.data as Record<string, unknown>)
                        : revisedArgsRaw;
                    const toolCtx = this.createToolContext({
                        session,
                        toolCallId: revisedCall.id,
                        target,
                        signal: controller.signal,
                    });
                    const preview = await this.buildApprovalPreview(
                        toolDef,
                        finalArgs,
                        policy,
                        toolCtx,
                    );

                    const retried = this.approvalGate.retry(approvalId, {
                        rejectionFeedback: feedbackText || undefined,
                        toolCallId: revisedCall.id,
                        title: preview.title,
                        summary: preview.summary,
                        targetLabel: preview.targetLabel,
                        rawContent: preview.rawContent,
                        diffLines: preview.diffLines,
                        args: canonicalClone(finalArgs),
                    });

                    const nextSuspendedInFlight: CanonicalMessage[] = [
                        ...retryInFlight,
                        {
                            role: 'assistant',
                            content: turnOutput.content,
                            ...(turnOutput.reasoningContent
                                ? { reasoningContent: turnOutput.reasoningContent }
                                : {}),
                            toolCalls: [canonicalClone(revisedCall)],
                        },
                    ];

                    this.suspendedApprovals.set(approvalId, {
                        approvalId,
                        sessionId: existing.sessionId,
                        messageId: existing.messageId,
                        toolCall: canonicalClone(revisedCall),
                        policy,
                        target,
                        inFlightMessages: nextSuspendedInFlight,
                    });

                    this.notify();
                    return retried;
                }
            }

            // Fallback when model returned plain text without calling a tool:
            // still increment revision and record feedback cleanly.
            const fallbackSummary = turnOutput.content.trim()
                ? truncateSummary(turnOutput.content, 200)
                : existing.summary;
            const retried = this.approvalGate.retry(approvalId, {
                rejectionFeedback: feedbackText || undefined,
                summary: fallbackSummary,
            });
            this.notify();
            return retried;
        } finally {
            if (this.activeControllers.get(existing.sessionId) === controller) {
                this.activeControllers.delete(existing.sessionId);
            }
        }
    }

    /**
     * Execute the exact reverse operation for `undoId` via `UndoStore` + bridges.
     * Also marks any linked `PendingApproval` as `reverted: true`.
     */
    public async undo(undoId: string): Promise<UndoRevertResult> {
        const result = await this.undoStore.revert(undoId, this.undoExecutor);
        if (result.ok) {
            for (const approval of this.approvalGate.list()) {
                if (approval.undoId === undoId && approval.status === 'approved') {
                    this.approvalGate.markReverted(approval.id, undoId);
                }
            }
            this.notify();
        }
        return result;
    }

    /**
     * `AssistantRuntimeBridge.applyUndo` adapter delegating to `undo(undoId)`.
     */
    public async applyUndo(undoId: string): Promise<UndoRecord | null> {
        const result = await this.undo(undoId);
        return result.ok ? (result.record ?? null) : null;
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    private cleanupApprovalsForMessages(
        sessionId: string,
        removedMessages: readonly AssistantMessage[],
    ): void {
        if (removedMessages.length === 0) {
            return;
        }
        const removedMsgIds = new Set<string>();
        const targetApprovalIds = new Set<string>();
        for (const msg of removedMessages) {
            removedMsgIds.add(msg.id);
            if (Array.isArray(msg.approvalIds)) {
                for (const apprId of msg.approvalIds) {
                    targetApprovalIds.add(apprId);
                }
            }
        }
        for (const appr of this.approvalGate.list({ sessionId })) {
            if (removedMsgIds.has(appr.messageId)) {
                targetApprovalIds.add(appr.id);
            }
        }
        for (const apprId of targetApprovalIds) {
            this.approvalGate.remove(apprId);
            this.suspendedApprovals.delete(apprId);
        }
    }

    private resolveActiveTarget(): MessageTarget {
        if (this.activeTargetProvider) {
            return this.activeTargetProvider();
        }
        const chat = this.bridge.getChat();
        if (chat.length === 0) {
            return { messageId: 0, swipeId: 0 };
        }
        const lastIdx = chat.length - 1;
        return {
            messageId: lastIdx,
            swipeId: chat[lastIdx]?.swipeId ?? 0,
        };
    }

    private resolveEffectiveConnection(connectionId: string): ApiConnection {
        const settings = this.settingsProvider();
        const trimmed = connectionId?.trim() || 'inherit';
        if (trimmed !== 'inherit' && this.customConnectionResolver) {
            const custom = this.customConnectionResolver(trimmed);
            if (custom) {
                return custom;
            }
        }
        if (trimmed === 'inherit') {
            return resolveConnection(settings);
        }
        return resolveConnection(settings, trimmed);
    }

    private createToolContext(params: {
        session: AssistantSession;
        toolCallId: string;
        target: MessageTarget;
        signal: AbortSignal;
    }): AssistantToolContext {
        return {
            sessionId: params.session.id,
            toolCallId: params.toolCallId,
            mode: params.session.mode,
            stAdminEnabled: params.session.stAdminEnabled,
            bridge: this.bridge,
            store: this.store,
            vfs: this.vfs,
            undoStore: this.undoStore,
            trajectoryStore: this.trajectoryStore,
            traceLogger: this.traceLogger,
            settings: this.settingsProvider(),
            target: params.target,
            signal: params.signal,
            getVariableSchema: this.variableSchemaProvider,
            captureUndo: true,
            getStatusSnapshot: this.statusSnapshotProvider,
        };
    }

    private async buildApprovalPreview(
        tool: AssistantToolDefinition,
        args: Record<string, unknown>,
        policy: ToolPolicyResult,
        ctx: AssistantToolContext,
    ) {
        if (tool.preview) {
            return await tool.preview(args, ctx);
        }
        const rawContent = JSON.stringify(redactWithReport(args).value, null, 2);
        return {
            title: `${tool.name} (${policy.scopeLabel})`,
            summary: `Execute ${tool.name} on ${policy.scopeLabel}.`,
            targetLabel: policy.scopeLabel,
            beforeText: '',
            afterText: rawContent,
            rawContent,
            diffLines: rawContent
                ? rawContent.split('\n').map((line) => ({ type: 'add' as const, text: line }))
                : [],
        };
    }

    private async invokeLLM(
        request: LLMRequest,
        useStream: boolean,
        callbacks: {
            onTextDelta?: (delta: string) => void;
            onReasoningDelta?: (delta: string) => void;
        },
    ): Promise<TurnLLMOutput> {
        throwIfAssistantAborted(request.signal);

        if (!useStream) {
            const resp = await this.transport.complete(request);
            throwIfAssistantAborted(request.signal);
            return {
                content: resp.content ?? '',
                reasoningContent: resp.reasoningContent ?? '',
                toolCalls: resp.toolCalls ? canonicalClone(resp.toolCalls) : [],
                usage: normalizeUsage(resp.usage),
                finishReason: resp.finishReason,
            };
        }

        let content = '';
        let reasoningContent = '';
        const toolMap = new Map<number, CanonicalToolCall>();
        let usage = normalizeUsage();
        let finishReason: string | undefined;

        for await (const chunk of this.transport.stream(request)) {
            throwIfAssistantAborted(request.signal);
            if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
                callbacks.onTextDelta?.(chunk.textDelta);
            } else if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoningContent += chunk.reasoningDelta;
                callbacks.onReasoningDelta?.(chunk.reasoningDelta);
            } else if (chunk.type === 'tool_call_delta') {
                const idx = chunk.toolCallIndex ?? 0;
                const prev = toolMap.get(idx) ?? {
                    id: `call_${this.now()}_${idx}`,
                    name: '',
                    arguments: '',
                };
                if (chunk.toolCallId) {
                    prev.id = chunk.toolCallId;
                }
                if (chunk.toolName) {
                    prev.name = chunk.toolName;
                }
                if (chunk.argumentsDelta) {
                    prev.arguments += chunk.argumentsDelta;
                }
                if (chunk.thoughtSignature) {
                    prev.thoughtSignature = chunk.thoughtSignature;
                }
                toolMap.set(idx, prev);
            } else if (chunk.type === 'usage' && chunk.usage) {
                usage = normalizeUsage(chunk.usage);
            } else if (chunk.type === 'done' && chunk.finishReason) {
                finishReason = chunk.finishReason;
            }
        }

        const toolCalls = Array.from(toolMap.entries())
            .sort(([a], [b]) => a - b)
            .map(([, tc]) => tc)
            .filter((tc) => tc.name.trim().length > 0);

        return {
            content,
            reasoningContent,
            toolCalls,
            usage,
            finishReason,
        };
    }

    private linkExternalSignal(
        controller: AbortController,
        external?: AbortSignal,
    ): () => void {
        if (!external) {
            return () => {};
        }
        if (external.aborted) {
            controller.abort(external.reason ?? createAssistantAbortError());
            return () => {};
        }
        const onAbort = () => {
            controller.abort(external.reason ?? createAssistantAbortError());
        };
        external.addEventListener('abort', onAbort, { once: true });
        return () => {
            external.removeEventListener('abort', onAbort);
        };
    }

    private emitSessionUpdate(
        sessionId: string,
        onUpdate?: (session: AssistantSession) => void,
    ): void {
        if (onUpdate) {
            const latest = this.sessionStore.getSession(sessionId);
            if (latest) {
                try {
                    onUpdate(latest);
                } catch {
                    // Keep stream resilient to callback errors.
                }
            }
        }
        this.notify();
    }

    private notify(): void {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener();
            } catch {
                // Keep subscriber loop fault-tolerant.
            }
        }
    }
}
