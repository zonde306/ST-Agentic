import type { TargetedEvent, TargetedKeyboardEvent, TargetedPointerEvent } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
    AssistantAttachment,
    AssistantMessage,
    AssistantMode,
    AssistantSession,
    AssistantSessionTokenStatus,
    AssistantTokenLevel,
    PendingApproval,
    UndoRecord,
} from '@/core/types';
import { Button, IconCheck, IconClose, IconEdit, ShadowModal } from '@/ui/components';
import type { ConsoleViewProps } from '@/ui/store';
import { MessageBubble } from './MessageBubble';
import {
    type ComposerPopoverKind,
    ModeModelPopover,
    StAdminConfirmModal,
} from './ModeModelPopover';
import { SessionListPanel } from './SessionListPanel';
import { UndoHistoryModal } from './UndoHistoryModal';
import {
    ASSISTANT_FILE_ACCEPT,
    ASSISTANT_MODE_META,
    copyTextSafe,
    formatErrorMessage,
    formatFileSize,
    prepareAssistantAttachments,
    renderRedactedText,
    resolveConnectionDisplay,
    useAssistantStoreSlice,
} from './assistant-helpers';

type ActivePopover = ComposerPopoverKind | 'sessions';

interface FilePreviewState {
    path: string;
    content: string;
    loading: boolean;
}

function formatCompactTokens(tokens: number): string {
    const safe = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0;
    if (safe < 1_000) {
        return `${safe} tok`;
    }
    if (safe < 100_000) {
        return `${(safe / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
    }
    if (safe < 1_000_000) {
        return `${Math.round(safe / 1_000)}k`;
    }
    return `${(safe / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function resolveEffectiveTokenLevel(status: AssistantSessionTokenStatus): AssistantTokenLevel {
    if (
        status.level === 'danger'
        || status.usagePercent >= 90
        || status.currentTokens >= status.highWatermark
    ) {
        return 'danger';
    }
    if (status.level === 'warning' || status.usagePercent >= 70) {
        return 'warning';
    }
    return 'normal';
}

/**
 * Assistant Workbench Preact View (`assistant` console tab).
 *
 * Implements the space-maximized 1:1 contract from `docs/assistant-ui-prototype.html`
 * and `docs/OFF_MAINLINE_PLAN.md` §6.2:
 * - No shortcut command bar and no manual "attach context" chips.
 * - Desktop: slim single-line top bar (`min-h-[46px]`) with `☰ 会话 (N)` slide-out drawer.
 * - Mobile (`< 768px`): strict `list ↔ detail` stack via `store.mobileAssistantStack`;
 *   entering `'detail'` hides `AgenticAppShell`'s top header & tab bar, and clicking `←`
 *   calls `store.backToAssistantList()` to restore them immediately.
 * - Unified bottom composer with permission mode + model connection selectors on bottom-left
 *   and a compact `40×40px` `▶` / `■` action button on bottom-right.
 */
export function AssistantView({ store, isMobile }: ConsoleViewProps) {
    const assistantSessions = useAssistantStoreSlice(store, (s) => s.assistantSessions);
    const selectedSessionId = useAssistantStoreSlice(store, (s) => s.selectedAssistantSessionId);
    const mobileAssistantStack = useAssistantStoreSlice(store, (s) => s.mobileAssistantStack);
    const pendingApprovals = useAssistantStoreSlice(store, (s) => s.assistantPendingApprovals);
    const undoStack = useAssistantStoreSlice(store, (s) => s.assistantUndoStack);
    const streamingSessionId = useAssistantStoreSlice(store, (s) => s.assistantStreamingSessionId);
    const settings = useAssistantStoreSlice(store, (s) => s.settings);

    const [openPopover, setOpenPopover] = useState<ActivePopover>(null);
    const [undoModalOpen, setUndoModalOpen] = useState<boolean>(false);
    const [stAdminConfirmOpen, setStAdminConfirmOpen] = useState<boolean>(false);
    const [previewFile, setPreviewFile] = useState<FilePreviewState | null>(null);
    const [draft, setDraft] = useState<string>('');
    const [streamingDelta, setStreamingDelta] = useState<{
        sessionId: string;
        text: string;
    } | null>(null);
    const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
    const [busyUndoId, setBusyUndoId] = useState<string | null>(null);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const [pendingAttachments, setPendingAttachments] = useState<AssistantAttachment[]>([]);
    const [isDragOver, setIsDragOver] = useState<boolean>(false);
    const [activeActionsMessageId, setActiveActionsMessageId] = useState<string | null>(null);
    const [previewImage, setPreviewImage] = useState<AssistantAttachment | null>(null);
    const [topbarRenameRevealed, setTopbarRenameRevealed] = useState<boolean>(false);
    const [isRenamingTopbarTitle, setIsRenamingTopbarTitle] = useState<boolean>(false);
    const [topbarTitleDraft, setTopbarTitleDraft] = useState<string>('');
    const [tokenStatus, setTokenStatus] = useState<AssistantSessionTokenStatus | null>(null);
    const [isCompacting, setIsCompacting] = useState<boolean>(false);
    const [compactModalOpen, setCompactModalOpen] = useState<boolean>(false);
    const [compactFocusDraft, setCompactFocusDraft] = useState<string>('');
    const [compactError, setCompactError] = useState<string | null>(null);
    const [compactSummaryPreviewOpen, setCompactSummaryPreviewOpen] = useState<boolean>(false);

    const abortControllerRef = useRef<AbortController | null>(null);
    const tokenFetchSeqRef = useRef<number>(0);
    const threadRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const topbarRenameInputRef = useRef<HTMLInputElement | null>(null);
    const titleLastPointerTypeRef = useRef<string>('mouse');
    const dragDepthRef = useRef<number>(0);
    const pendingAttachmentsRef = useRef<AssistantAttachment[]>(pendingAttachments);
    pendingAttachmentsRef.current = pendingAttachments;

    // Hydrate from AssistantRuntimeBridge on mount.
    useEffect(() => {
        if (!store.assistantRuntime) {
            return;
        }
        void store.refreshAssistantState().catch((err) => {
            store.pushToast(`加载助手状态失败：${formatErrorMessage(err)}`, 'error');
        });
    }, [store]);

    // Cleanup any active AbortController on unmount.
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
        };
    }, []);

    const approvalsById = useMemo(() => {
        const map = new Map<string, PendingApproval>();
        for (const item of pendingApprovals) {
            map.set(item.id, item);
        }
        return map;
    }, [pendingApprovals]);

    const undoById = useMemo(() => {
        const map = new Map<string, UndoRecord>();
        for (const record of undoStack) {
            map.set(record.id, record);
        }
        return map;
    }, [undoStack]);

    const activeUndoCount = useMemo(
        () => undoStack.filter((rec) => !rec.reverted).length,
        [undoStack],
    );

    const activeSession = useMemo<AssistantSession | null>(() => {
        const found = assistantSessions.find((session) => session.id === selectedSessionId);
        if (found) {
            return found;
        }
        return assistantSessions.length > 0 ? assistantSessions[0] : null;
    }, [assistantSessions, selectedSessionId]);

    const isStreamingCurrent = Boolean(
        activeSession && streamingSessionId === activeSession.id,
    );

    useEffect(() => {
        setEditingMessageId(null);
        setActiveActionsMessageId(null);
        setIsRenamingTopbarTitle(false);
        setTopbarRenameRevealed(false);
        setTopbarTitleDraft('');
        setCompactModalOpen(false);
        setCompactError(null);
        setCompactSummaryPreviewOpen(false);
    }, [activeSession?.id]);

    const refreshTokenStatus = useCallback(
        async (targetSessionId?: string | null) => {
            const sid = targetSessionId ?? activeSession?.id ?? null;
            const getter = store.assistantRuntime?.getSessionTokenStatus;
            if (!sid || !getter) {
                setTokenStatus(null);
                return;
            }
            const seq = ++tokenFetchSeqRef.current;
            try {
                const nextStatus = await getter(sid);
                if (tokenFetchSeqRef.current === seq) {
                    setTokenStatus(nextStatus ?? null);
                }
            } catch {
                if (tokenFetchSeqRef.current === seq) {
                    setTokenStatus(null);
                }
            }
        },
        [activeSession?.id, store],
    );

    const activeSessionMessageCount = activeSession?.messages.length ?? 0;
    const activeSessionUpdatedAt = activeSession?.updatedAt ?? 0;
    const activeSessionConnectionId = activeSession?.connectionId ?? '';
    const activeSessionMode = activeSession?.mode ?? 'chat';
    const activeSessionStAdmin = Boolean(activeSession?.stAdminEnabled);

    useEffect(() => {
        void refreshTokenStatus(activeSession?.id ?? null);
    }, [
        activeSession?.id,
        activeSessionMessageCount,
        activeSessionUpdatedAt,
        activeSessionConnectionId,
        activeSessionMode,
        activeSessionStAdmin,
        isStreamingCurrent,
        pendingApprovals.length,
        settings.currentConnectionId,
        refreshTokenStatus,
    ]);

    useEffect(() => {
        if (!isRenamingTopbarTitle) {
            return;
        }
        const input = topbarRenameInputRef.current;
        if (input) {
            input.focus();
            try {
                input.select();
            } catch {
                // Ignore selection errors in restricted environments.
            }
        }
    }, [isRenamingTopbarTitle]);

    useEffect(() => {
        if (isStreamingCurrent) {
            setActiveActionsMessageId(null);
        }
    }, [isStreamingCurrent]);

    // Auto-scroll thread when messages or live streaming delta update.
    const messageCount = activeSession?.messages.length ?? 0;
    const lastMessageContentLen =
        activeSession && messageCount > 0
            ? activeSession.messages[messageCount - 1].content.length
            : 0;
    useEffect(() => {
        const el = threadRef.current;
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }, [activeSession?.id, messageCount, lastMessageContentLen, streamingDelta?.text]);

    // Auto-resize composer textarea smoothly up to 160px.
    useEffect(() => {
        const ta = textareaRef.current;
        if (!ta) {
            return;
        }
        ta.style.height = 'auto';
        const nextHeight = Math.min(160, Math.max(40, ta.scrollHeight));
        ta.style.height = `${nextHeight}px`;
    }, [draft]);

    const upsertSessionInStore = useCallback(
        (updated: AssistantSession) => {
            const current = store.getSnapshot().assistantSessions;
            const idx = current.findIndex((item) => item.id === updated.id);
            if (idx >= 0) {
                const next = [...current];
                next[idx] = updated;
                store.setAssistantSessions(next);
            } else {
                store.setAssistantSessions([updated, ...current]);
            }
        },
        [store],
    );

    const handleCreateSession = useCallback(async (): Promise<AssistantSession | null> => {
        const current = activeSession;
        const defaultMode: AssistantMode = current?.mode ?? 'chat';
        const defaultConnId =
            current?.connectionId
            ?? settings.offMainline?.defaultAssistantConnectionId
            ?? 'inherit';
        const defaultStAdmin = defaultMode === 'full' ? Boolean(current?.stAdminEnabled) : false;

        setOpenPopover(null);
        const runtime = store.assistantRuntime;

        try {
            if (runtime) {
                const created = await runtime.createSession({
                    mode: defaultMode,
                    connectionId: defaultConnId,
                    stAdminEnabled: defaultStAdmin,
                    autoApproveAuthor: false,
                    autoApproveChatDelete: false,
                });
                upsertSessionInStore(created);
                store.openAssistantSession(created.id);
                await store.refreshAssistantState();
                store.openAssistantSession(created.id);
                store.pushToast('已新建助手会话', 'success');
                return created;
            }

            const modeMeta = ASSISTANT_MODE_META[defaultMode];
            const now = Date.now();
            const created: AssistantSession = {
                id: `ast_${now.toString(36)}`,
                title: `新助手对话 (${modeMeta.label})`,
                mode: defaultMode,
                stAdminEnabled: defaultStAdmin,
                autoApproveAuthor: false,
                autoApproveChatDelete: false,
                connectionId: defaultConnId,
                updatedAt: now,
                messages: [],
            };
            store.setAssistantSessions([created, ...store.getSnapshot().assistantSessions]);
            store.openAssistantSession(created.id);
            store.pushToast('已新建助手会话', 'success');
            return created;
        } catch (err) {
            store.pushToast(`新建助手会话失败：${formatErrorMessage(err)}`, 'error');
            return null;
        }
    }, [activeSession, settings.offMainline?.defaultAssistantConnectionId, store, upsertSessionInStore]);

    const handleSelectSession = useCallback(
        (sessionId: string) => {
            setOpenPopover(null);
            store.openAssistantSession(sessionId);
        },
        [store],
    );

    const handleBackToList = useCallback(() => {
        setOpenPopover(null);
        store.backToAssistantList();
    }, [store]);

    const handleDeleteSession = useCallback(
        async (sessionId: string) => {
            if (store.getSnapshot().assistantStreamingSessionId === sessionId) {
                abortControllerRef.current?.abort();
                store.assistantRuntime?.abort?.(sessionId);
                store.setAssistantStreamingSessionId(null);
                setStreamingDelta(null);
            }

            const runtime = store.assistantRuntime;
            try {
                if (runtime?.deleteSession) {
                    await runtime.deleteSession(sessionId);
                    await store.refreshAssistantState();
                } else {
                    const remaining = store
                        .getSnapshot()
                        .assistantSessions.filter((s) => s.id !== sessionId);
                    store.setAssistantSessions(remaining);
                }
                store.pushToast('已删除助手会话', 'warning');
            } catch (err) {
                store.pushToast(`删除会话失败：${formatErrorMessage(err)}`, 'error');
            }
        },
        [store],
    );

    const handleRenameSession = useCallback(
        async (sessionId: string, nextTitle: string): Promise<boolean> => {
            const trimmed = nextTitle.trim();
            if (!trimmed) {
                store.pushToast('会话标题不能为空', 'warning');
                return false;
            }
            const target = store
                .getSnapshot()
                .assistantSessions.find((s) => s.id === sessionId);
            if (!target) {
                return false;
            }
            if (trimmed === target.title) {
                return true;
            }

            const optimistic: AssistantSession = {
                ...target,
                title: trimmed,
            };
            upsertSessionInStore(optimistic);

            const runtime = store.assistantRuntime;
            if (runtime?.updateSessionConfig) {
                try {
                    const updated = await runtime.updateSessionConfig(sessionId, {
                        title: trimmed,
                    });
                    if (updated) {
                        upsertSessionInStore(updated);
                    } else {
                        await store.refreshAssistantState();
                    }
                } catch (err) {
                    store.pushToast(`重命名会话失败：${formatErrorMessage(err)}`, 'error');
                    await store.refreshAssistantState();
                    return false;
                }
            }

            store.pushToast('已更新会话标题', 'success');
            return true;
        },
        [store, upsertSessionInStore],
    );

    const handleTitlePointerDown = useCallback(
        (event: TargetedPointerEvent<HTMLSpanElement>) => {
            if (event.pointerType) {
                titleLastPointerTypeRef.current = event.pointerType;
            }
        },
        [],
    );

    const handleTitleTap = useCallback(() => {
        if (
            isMobile
            || titleLastPointerTypeRef.current === 'touch'
            || titleLastPointerTypeRef.current === 'pen'
        ) {
            setTopbarRenameRevealed((prev) => !prev);
        }
    }, [isMobile]);

    const handleStartTopbarRename = useCallback(() => {
        if (!activeSession) {
            return;
        }
        setOpenPopover(null);
        setTopbarRenameRevealed(false);
        setTopbarTitleDraft(activeSession.title);
        setIsRenamingTopbarTitle(true);
    }, [activeSession]);

    const handleCancelTopbarRename = useCallback(() => {
        setIsRenamingTopbarTitle(false);
        setTopbarRenameRevealed(false);
        setTopbarTitleDraft('');
    }, []);

    const handleCommitTopbarRename = useCallback(async () => {
        if (!activeSession) {
            return;
        }
        const trimmed = topbarTitleDraft.trim();
        if (!trimmed) {
            store.pushToast('会话标题不能为空', 'warning');
            return;
        }
        setIsRenamingTopbarTitle(false);
        setTopbarRenameRevealed(false);
        setTopbarTitleDraft('');
        await handleRenameSession(activeSession.id, trimmed);
    }, [activeSession, handleRenameSession, store, topbarTitleDraft]);

    const handleTopbarRenameKeyDown = useCallback(
        (event: TargetedKeyboardEvent<HTMLInputElement>) => {
            event.stopPropagation();
            if (event.key === 'Escape') {
                event.preventDefault();
                handleCancelTopbarRename();
                return;
            }
            if (event.key === 'Enter' && !event.isComposing && topbarTitleDraft.trim()) {
                event.preventDefault();
                void handleCommitTopbarRename();
            }
        },
        [handleCancelTopbarRename, handleCommitTopbarRename, topbarTitleDraft],
    );

    const patchActiveSessionConfig = useCallback(
        async (
            patch: Partial<
                Pick<
                    AssistantSession,
                    | 'title'
                    | 'mode'
                    | 'stAdminEnabled'
                    | 'autoApproveAuthor'
                    | 'autoApproveChatDelete'
                    | 'connectionId'
                >
            >,
        ) => {
            if (!activeSession) {
                return;
            }
            const optimistic: AssistantSession = {
                ...activeSession,
                ...patch,
            };
            upsertSessionInStore(optimistic);

            const runtime = store.assistantRuntime;
            if (runtime?.updateSessionConfig) {
                try {
                    const updated = await runtime.updateSessionConfig(activeSession.id, patch);
                    if (updated) {
                        upsertSessionInStore(updated);
                    } else {
                        await store.refreshAssistantState();
                    }
                } catch (err) {
                    store.pushToast(`更新会话设置失败：${formatErrorMessage(err)}`, 'error');
                    await store.refreshAssistantState();
                }
            }
        },
        [activeSession, store, upsertSessionInStore],
    );

    const handleSelectMode = useCallback(
        (mode: AssistantMode) => {
            if (!activeSession) {
                return;
            }
            const patch: Partial<Pick<AssistantSession, 'mode' | 'stAdminEnabled'>> =
                mode !== 'full' ? { mode, stAdminEnabled: false } : { mode };
            void patchActiveSessionConfig(patch);
            store.pushToast(
                `已切换为：${ASSISTANT_MODE_META[mode].fullLabel}`,
                mode === 'full' ? 'warning' : 'primary',
            );
            if (mode === 'chat') {
                setOpenPopover(null);
            }
        },
        [activeSession, patchActiveSessionConfig, store],
    );

    const handleToggleAutoApproveAuthor = useCallback(
        (checked: boolean) => {
            void patchActiveSessionConfig({ autoApproveAuthor: checked });
            store.pushToast(
                checked
                    ? '已开启「本会话自动批准写卡」（高危仍强制确认）'
                    : '已恢复「写卡前气泡审批」',
                checked ? 'warning' : 'primary',
            );
        },
        [patchActiveSessionConfig, store],
    );

    const handleToggleAutoApproveChatDelete = useCallback(
        (checked: boolean) => {
            void patchActiveSessionConfig({ autoApproveChatDelete: checked });
            store.pushToast(
                checked
                    ? '已开启「本会话自动批准删除消息」（仍保留写前快照可撤销）'
                    : '已恢复「删除消息前气泡确认」',
                checked ? 'warning' : 'primary',
            );
        },
        [patchActiveSessionConfig, store],
    );

    const handleRequestToggleStAdmin = useCallback(() => {
        if (!activeSession) {
            return;
        }
        if (activeSession.stAdminEnabled) {
            void patchActiveSessionConfig({ stAdminEnabled: false });
            store.pushToast('已关闭「ST 全权管家」，权限收口为仅已开启世界书', 'primary');
            return;
        }
        setOpenPopover(null);
        setStAdminConfirmOpen(true);
    }, [activeSession, patchActiveSessionConfig, store]);

    const handleConfirmStAdmin = useCallback(() => {
        setStAdminConfirmOpen(false);
        void patchActiveSessionConfig({ stAdminEnabled: true });
        store.pushToast('已启用 ST 全权管家（高危强制审批 + Secret 脱敏已激活）', 'warning');
    }, [patchActiveSessionConfig, store]);

    const handleSelectConnection = useCallback(
        (connectionId: string) => {
            void patchActiveSessionConfig({ connectionId });
            setOpenPopover(null);
            const display = resolveConnectionDisplay(
                connectionId,
                settings.connections,
                settings.currentConnectionId,
            );
            store.pushToast(`模型已切换为：${display.shortLabel}`, 'primary');
        },
        [patchActiveSessionConfig, settings.connections, settings.currentConnectionId, store],
    );

    const handleAbortStream = useCallback(() => {
        const targetId = store.getSnapshot().assistantStreamingSessionId ?? activeSession?.id;
        abortControllerRef.current?.abort();
        abortControllerRef.current = null;
        if (targetId) {
            store.assistantRuntime?.abort?.(targetId);
        }
        store.setAssistantStreamingSessionId(null);
        setStreamingDelta(null);
        store.pushToast('已停止当前助手生成', 'warning');
    }, [activeSession?.id, store]);

    const runStreamingOperation = useCallback(
        async (
            sessionId: string,
            executor: (hooks: {
                signal: AbortSignal;
                onDelta: (delta: string) => void;
                onRetry: () => void;
                onUpdate: (updatedSession: AssistantSession) => void;
            }) => Promise<AssistantMessage | AssistantSession | void>,
            errorPrefix: string,
        ) => {
            const controller = new AbortController();
            abortControllerRef.current = controller;
            store.setAssistantStreamingSessionId(sessionId);
            setStreamingDelta({ sessionId, text: '' });

            let receivedOnUpdate = false;
            let liveBubbleOwned = false;

            try {
                const result = await executor({
                    signal: controller.signal,
                    onDelta: (delta: string) => {
                        if (controller.signal.aborted || liveBubbleOwned) {
                            return;
                        }
                        setStreamingDelta((prev) => ({
                            sessionId,
                            text: prev && prev.sessionId === sessionId ? prev.text + delta : delta,
                        }));
                    },
                    onRetry: () => {
                        setStreamingDelta({ sessionId, text: '' });
                    },
                    onUpdate: (updatedSession: AssistantSession) => {
                        receivedOnUpdate = true;
                        const last = updatedSession.messages[updatedSession.messages.length - 1];
                        if (last?.role === 'assistant') {
                            liveBubbleOwned = true;
                            setStreamingDelta({ sessionId, text: '' });
                        } else {
                            liveBubbleOwned = false;
                        }
                        upsertSessionInStore(updatedSession);
                    },
                });

                if (result && 'messages' in result && Array.isArray(result.messages)) {
                    upsertSessionInStore(result);
                } else if (!receivedOnUpdate && result && 'role' in result) {
                    const cur = store
                        .getSnapshot()
                        .assistantSessions.find((item) => item.id === sessionId);
                    if (cur && !cur.messages.some((m) => m.id === result.id)) {
                        upsertSessionInStore({
                            ...cur,
                            updatedAt: Date.now(),
                            messages: [...cur.messages, result],
                        });
                    }
                }

                const finalAssistantMsg =
                    result && 'role' in result
                        ? result
                        : result && 'messages' in result && Array.isArray(result.messages)
                            ? result.messages[result.messages.length - 1]
                            : undefined;
                if (finalAssistantMsg?.interrupted) {
                    if (finalAssistantMsg.errorCode === 'max_tool_rounds') {
                        store.pushToast(
                            '已达到单轮工具调用上限，可点击「继续执行」接着运行',
                            'warning',
                        );
                    } else if (finalAssistantMsg.errorCode === 'length') {
                        store.pushToast(
                            '输出达到长度上限已截断，可点击「继续生成」接着输出',
                            'warning',
                        );
                    }
                }
            } catch (err) {
                if (!controller.signal.aborted) {
                    store.pushToast(`${errorPrefix}：${formatErrorMessage(err)}`, 'error');
                }
            } finally {
                if (abortControllerRef.current === controller) {
                    abortControllerRef.current = null;
                }
                if (store.getSnapshot().assistantStreamingSessionId === sessionId) {
                    store.setAssistantStreamingSessionId(null);
                }
                setStreamingDelta(null);
                try {
                    await store.refreshAssistantState();
                } catch {
                    // Keep UI responsive even if refresh fails after abort.
                }
                await refreshTokenStatus(sessionId);
            }
        },
        [refreshTokenStatus, store, upsertSessionInStore],
    );

    const handleAddFiles = useCallback(
        async (files: FileList | readonly File[]) => {
            if (!files || files.length === 0) {
                return;
            }
            const { added, errors } = await prepareAssistantAttachments(
                files,
                pendingAttachmentsRef.current,
            );
            if (added.length > 0) {
                setPendingAttachments((prev) => [...prev, ...added]);
            }
            for (const errMsg of errors) {
                store.pushToast(errMsg, 'warning');
            }
        },
        [store],
    );

    const handleRemovePendingAttachment = useCallback((attachmentId: string) => {
        setPendingAttachments((prev) => prev.filter((item) => item.id !== attachmentId));
    }, []);

    const handleSendPrompt = useCallback(async () => {
        if (isStreamingCurrent) {
            handleAbortStream();
            return;
        }

        const text = draft.trim();
        const attachmentsToSend = [...pendingAttachmentsRef.current];
        if (!text && attachmentsToSend.length === 0) {
            store.pushToast('请输入指令或上传附件后再发送', 'warning');
            return;
        }

        const runtime = store.assistantRuntime;
        if (!runtime) {
            store.pushToast('助手运行时未连接，暂时无法发送指令', 'warning');
            return;
        }

        let targetSession = activeSession;
        if (!targetSession) {
            targetSession = await handleCreateSession();
            if (!targetSession) {
                return;
            }
        }

        const sessionId = targetSession.id;
        setDraft('');
        setPendingAttachments([]);
        setOpenPopover(null);
        setEditingMessageId(null);
        setActiveActionsMessageId(null);

        await runStreamingOperation(
            sessionId,
            (hooks) =>
                runtime.sendPrompt(sessionId, text, {
                    ...hooks,
                    ...(attachmentsToSend.length > 0 ? { attachments: attachmentsToSend } : {}),
                }),
            '助手执行失败',
        );
    }, [
        activeSession,
        draft,
        handleAbortStream,
        handleCreateSession,
        isStreamingCurrent,
        runStreamingOperation,
        store,
    ]);

    const handleCopyMessage = useCallback(
        async (content: string) => {
            const ok = await copyTextSafe(content);
            store.pushToast(
                ok ? '已复制消息内容' : '复制失败，请手动选中文本复制',
                ok ? 'success' : 'warning',
            );
        },
        [store],
    );

    const handleSaveEditMessage = useCallback(
        async (messageId: string, newContent: string) => {
            if (!activeSession || isStreamingCurrent) {
                return;
            }
            const targetMsg = activeSession.messages.find((m) => m.id === messageId);
            const hasAttachments = Boolean(targetMsg?.attachments?.length);
            if (!newContent.trim() && !hasAttachments) {
                store.pushToast('消息内容不能为空', 'warning');
                return;
            }

            const runtime = store.assistantRuntime;
            try {
                if (runtime?.editMessage) {
                    const updated = await runtime.editMessage(
                        activeSession.id,
                        messageId,
                        newContent,
                    );
                    if (updated) {
                        upsertSessionInStore(updated);
                    }
                    await store.refreshAssistantState();
                } else {
                    upsertSessionInStore({
                        ...activeSession,
                        updatedAt: Date.now(),
                        messages: activeSession.messages.map((m) =>
                            m.id === messageId
                                ? {
                                    ...m,
                                    content: newContent,
                                    ...(m.interrupted ? { interrupted: false } : {}),
                                }
                                : m,
                        ),
                    });
                }
                setEditingMessageId(null);
                setActiveActionsMessageId(null);
                await refreshTokenStatus(activeSession.id);
                store.pushToast('已保存消息改写', 'success');
            } catch (err) {
                store.pushToast(`保存改写失败：${formatErrorMessage(err)}`, 'error');
            }
        },
        [activeSession, isStreamingCurrent, refreshTokenStatus, store, upsertSessionInStore],
    );

    const handleSaveAndResendMessage = useCallback(
        async (messageId: string, newContent: string) => {
            if (!activeSession || isStreamingCurrent) {
                return;
            }
            const targetMsg = activeSession.messages.find((m) => m.id === messageId);
            const hasAttachments = Boolean(targetMsg?.attachments?.length);
            if (!newContent.trim() && !hasAttachments) {
                store.pushToast('消息内容不能为空', 'warning');
                return;
            }
            const runtime = store.assistantRuntime;
            if (!runtime) {
                store.pushToast('助手运行时未连接，暂时无法发送指令', 'warning');
                return;
            }
            if (!runtime.editAndResendMessage) {
                store.pushToast('当前运行时不支持改写并发送', 'warning');
                return;
            }

            setEditingMessageId(null);
            setActiveActionsMessageId(null);
            setOpenPopover(null);
            const sessionId = activeSession.id;

            await runStreamingOperation(
                sessionId,
                (hooks) => runtime.editAndResendMessage!(sessionId, messageId, newContent, hooks),
                '改写并发送失败',
            );
        },
        [activeSession, isStreamingCurrent, runStreamingOperation, store],
    );

    const handleRetractMessage = useCallback(
        (messageId: string) => {
            if (!activeSession || isStreamingCurrent) {
                return;
            }
            const idx = activeSession.messages.findIndex((m) => m.id === messageId);
            if (idx < 0) {
                return;
            }

            const targetMsg = activeSession.messages[idx];
            const tailCount = activeSession.messages.length - idx;
            const tailAfter = tailCount - 1;
            const isLastTurnPair =
                tailAfter === 1
                && targetMsg.role === 'user'
                && activeSession.messages[idx + 1]?.role === 'assistant';
            const isInstantSafe = tailAfter === 0 || isLastTurnPair;
            const sessionId = activeSession.id;

            const executeRetract = async () => {
                const runtime = store.assistantRuntime;
                try {
                    if (runtime?.retractMessage) {
                        const result = await runtime.retractMessage(sessionId, messageId);
                        if (result && 'session' in result) {
                            upsertSessionInStore(result.session);
                        } else if (result && 'messages' in result) {
                            upsertSessionInStore(result);
                        }
                        await store.refreshAssistantState();
                    } else {
                        const cur = store
                            .getSnapshot()
                            .assistantSessions.find((s) => s.id === sessionId);
                        if (cur) {
                            const curIdx = cur.messages.findIndex((m) => m.id === messageId);
                            if (curIdx >= 0) {
                                upsertSessionInStore({
                                    ...cur,
                                    updatedAt: Date.now(),
                                    messages: cur.messages.slice(0, curIdx),
                                });
                            }
                        }
                    }

                    setEditingMessageId((prev) => (prev === messageId ? null : prev));
                    setActiveActionsMessageId(null);
                    if (targetMsg.role === 'user') {
                        if (draft.trim() === '' && targetMsg.content) {
                            setDraft(targetMsg.content);
                        }
                        if (
                            pendingAttachmentsRef.current.length === 0
                            && targetMsg.attachments
                            && targetMsg.attachments.length > 0
                        ) {
                            setPendingAttachments(targetMsg.attachments);
                        }
                    }
                    store.pushToast(
                        tailCount > 1
                            ? `已撤回该轮及后续共 ${tailCount} 条消息`
                            : '已撤回消息',
                        'warning',
                    );
                    await refreshTokenStatus(sessionId);
                } catch (err) {
                    store.pushToast(`撤回消息失败：${formatErrorMessage(err)}`, 'error');
                }
            };

            if (isInstantSafe) {
                void executeRetract();
                return;
            }

            store.openModal({
                kind: 'confirm',
                title: '确认撤回消息',
                message: `撤回此消息将同时移除其后方的 ${tailAfter} 条对话记录（共 ${tailCount} 条），此操作不可恢复。是否继续？`,
                confirmLabel: '确认撤回',
                cancelLabel: '取消',
                tone: 'danger',
                onConfirm: executeRetract,
            });
        },
        [activeSession, draft, isStreamingCurrent, refreshTokenStatus, store, upsertSessionInStore],
    );

    const handleRegenerateLastMessage = useCallback(async () => {
        if (!activeSession || isStreamingCurrent) {
            return;
        }
        const runtime = store.assistantRuntime;
        if (!runtime) {
            store.pushToast('助手运行时未连接，暂时无法重新生成', 'warning');
            return;
        }
        if (!runtime.regenerateLastMessage) {
            store.pushToast('当前运行时不支持重新生成末尾消息', 'warning');
            return;
        }

        setEditingMessageId(null);
        setOpenPopover(null);
        const sessionId = activeSession.id;

        await runStreamingOperation(
            sessionId,
            (hooks) => runtime.regenerateLastMessage!(sessionId, hooks),
            '重新生成失败',
        );
    }, [activeSession, isStreamingCurrent, runStreamingOperation, store]);

    const handleContinueLastMessage = useCallback(async () => {
        if (!activeSession || isStreamingCurrent) {
            return;
        }
        const runtime = store.assistantRuntime;
        if (!runtime) {
            store.pushToast('助手运行时未连接，暂时无法继续生成', 'warning');
            return;
        }
        if (!runtime.continueLastMessage) {
            store.pushToast('当前运行时不支持继续生成', 'warning');
            return;
        }

        setEditingMessageId(null);
        setActiveActionsMessageId(null);
        setOpenPopover(null);
        const sessionId = activeSession.id;

        await runStreamingOperation(
            sessionId,
            (hooks) => runtime.continueLastMessage!(sessionId, hooks),
            '继续生成失败',
        );
    }, [activeSession, isStreamingCurrent, runStreamingOperation, store]);

    const handleOpenCompactModal = useCallback(() => {
        if (!activeSession || isCompacting || tokenStatus?.isCompacting) {
            return;
        }
        setTopbarRenameRevealed(false);
        setOpenPopover(null);
        setCompactError(null);
        setCompactSummaryPreviewOpen(false);
        setCompactModalOpen(true);
        void refreshTokenStatus(activeSession.id);
    }, [activeSession, isCompacting, refreshTokenStatus, tokenStatus?.isCompacting]);

    const handleRunCompaction = useCallback(
        async (mode: 'fold_only' | 'full') => {
            if (!activeSession || isCompacting || tokenStatus?.isCompacting) {
                return;
            }
            const runtime = store.assistantRuntime;
            if (!runtime?.compactSession) {
                setCompactError('当前运行时不支持上下文压缩');
                return;
            }
            setIsCompacting(true);
            setCompactError(null);
            const sessionId = activeSession.id;
            try {
                const focus = mode === 'full' ? compactFocusDraft.trim() : '';
                const report = await runtime.compactSession(sessionId, {
                    mode,
                    ...(focus ? { focusInstruction: focus } : {}),
                });
                await store.refreshAssistantState();
                await refreshTokenStatus(sessionId);
                setCompactModalOpen(false);
                setCompactFocusDraft('');
                if (report.compacted) {
                    store.pushToast(
                        `已压缩上下文：${formatCompactTokens(report.tokensBefore)} → ${formatCompactTokens(report.tokensAfter)}`,
                        'success',
                    );
                } else {
                    store.pushToast('当前上下文无需进一步压缩', 'primary');
                }
            } catch (err) {
                setCompactError(`压缩失败：${formatErrorMessage(err)}`);
            } finally {
                setIsCompacting(false);
            }
        },
        [
            activeSession,
            compactFocusDraft,
            isCompacting,
            refreshTokenStatus,
            store,
            tokenStatus?.isCompacting,
        ],
    );

    const handleCompactAndRetryOverflow = useCallback(async () => {
        if (!activeSession || isStreamingCurrent || isCompacting || tokenStatus?.isCompacting) {
            return;
        }
        const runtime = store.assistantRuntime;
        if (!runtime) {
            store.pushToast('助手运行时未连接，暂时无法重试', 'warning');
            return;
        }
        const sessionId = activeSession.id;
        if (runtime.compactSession) {
            setIsCompacting(true);
            try {
                const report = await runtime.compactSession(sessionId, { mode: 'full' });
                await store.refreshAssistantState();
                await refreshTokenStatus(sessionId);
                if (report.compacted) {
                    store.pushToast(
                        `已压缩历史上下文（${formatCompactTokens(report.tokensBefore)} → ${formatCompactTokens(report.tokensAfter)}），正在重试...`,
                        'primary',
                    );
                }
            } catch (err) {
                store.pushToast(`压缩历史失败：${formatErrorMessage(err)}`, 'error');
                return;
            } finally {
                setIsCompacting(false);
            }
        }
        await handleRegenerateLastMessage();
    }, [
        activeSession,
        handleRegenerateLastMessage,
        isCompacting,
        isStreamingCurrent,
        refreshTokenStatus,
        store,
        tokenStatus?.isCompacting,
    ]);

    const handleDecideApproval = useCallback(
        async (approvalId: string, decision: 'approve' | 'reject', feedback?: string) => {
            const target = approvalsById.get(approvalId);
            if (!target || target.status !== 'pending') {
                return;
            }

            setBusyApprovalId(approvalId);
            const runtime = store.assistantRuntime;
            try {
                if (runtime) {
                    const updated = await runtime.decideApproval(approvalId, decision, feedback);
                    if (runtime.listApprovals) {
                        await store.refreshAssistantState();
                    } else {
                        const nextApprovals = store
                            .getSnapshot()
                            .assistantPendingApprovals.map((item) => {
                                if (item.id !== approvalId) {
                                    return item;
                                }
                                if (updated) {
                                    return updated;
                                }
                                return {
                                    ...item,
                                    status:
                                        decision === 'approve'
                                            ? ('approved' as const)
                                            : ('rejected' as const),
                                    ...(feedback ? { rejectionFeedback: feedback } : {}),
                                };
                            });
                        store.setAssistantPendingApprovals(nextApprovals);
                        await store.refreshAssistantState();
                    }
                } else {
                    const nextApprovals = store
                        .getSnapshot()
                        .assistantPendingApprovals.map((item) =>
                            item.id === approvalId
                                ? {
                                    ...item,
                                    status:
                                        decision === 'approve'
                                            ? ('approved' as const)
                                            : ('rejected' as const),
                                    ...(feedback ? { rejectionFeedback: feedback } : {}),
                                }
                                : item,
                        );
                    store.setAssistantPendingApprovals(nextApprovals);
                }

                store.pushToast(
                    decision === 'approve'
                        ? `✓ 已接受并落盘：${target.title}`
                        : `✕ 已拒绝：${target.title}`,
                    decision === 'approve' ? 'success' : 'warning',
                );
                await refreshTokenStatus(target.sessionId);
            } catch (err) {
                store.pushToast(`审批操作失败：${formatErrorMessage(err)}`, 'error');
            } finally {
                setBusyApprovalId(null);
            }
        },
        [approvalsById, refreshTokenStatus, store],
    );

    const handleRetryApproval = useCallback(
        async (approvalId: string, feedback?: string) => {
            const target = approvalsById.get(approvalId);
            if (!target) {
                return;
            }

            setBusyApprovalId(approvalId);
            const runtime = store.assistantRuntime;
            try {
                let nextRevision = (target.revision || 1) + 1;
                if (runtime) {
                    const retried = await runtime.retryApproval(approvalId, feedback);
                    if (retried) {
                        nextRevision = retried.revision;
                    }
                    if (runtime.listApprovals) {
                        await store.refreshAssistantState();
                    } else {
                        const nextApprovals = store
                            .getSnapshot()
                            .assistantPendingApprovals.map((item) => {
                                if (item.id !== approvalId) {
                                    return item;
                                }
                                if (retried) {
                                    return retried;
                                }
                                return {
                                    ...item,
                                    revision: nextRevision,
                                    status: 'pending' as const,
                                    undoId: undefined,
                                    reverted: false,
                                    ...(feedback ? { rejectionFeedback: feedback } : {}),
                                };
                            });
                        store.setAssistantPendingApprovals(nextApprovals);
                        await store.refreshAssistantState();
                    }
                } else {
                    const nextApprovals = store
                        .getSnapshot()
                        .assistantPendingApprovals.map((item) =>
                            item.id === approvalId
                                ? {
                                    ...item,
                                    revision: nextRevision,
                                    status: 'pending' as const,
                                    undoId: undefined,
                                    reverted: false,
                                    ...(feedback ? { rejectionFeedback: feedback } : {}),
                                }
                                : item,
                        );
                    store.setAssistantPendingApprovals(nextApprovals);
                }

                store.pushToast(`↻ 已重新生成修改方案（第 ${nextRevision} 版），请确认`, 'primary');
                await refreshTokenStatus(target.sessionId);
            } catch (err) {
                store.pushToast(`重试方案失败：${formatErrorMessage(err)}`, 'error');
            } finally {
                setBusyApprovalId(null);
            }
        },
        [approvalsById, refreshTokenStatus, store],
    );

    const handleApplyUndo = useCallback(
        async (undoId: string) => {
            const target = undoById.get(undoId);
            if (target?.reverted) {
                return;
            }

            setBusyUndoId(undoId);
            const runtime = store.assistantRuntime;
            try {
                if (runtime) {
                    await runtime.applyUndo(undoId);
                    if (runtime.listUndoRecords) {
                        await store.refreshAssistantState();
                    } else {
                        const snap = store.getSnapshot();
                        store.setAssistantUndoStack(
                            snap.assistantUndoStack.map((rec) =>
                                rec.id === undoId ? { ...rec, reverted: true } : rec,
                            ),
                        );
                        store.setAssistantPendingApprovals(
                            snap.assistantPendingApprovals.map((appr) =>
                                appr.undoId === undoId ? { ...appr, reverted: true } : appr,
                            ),
                        );
                        await store.refreshAssistantState();
                    }
                } else {
                    const snap = store.getSnapshot();
                    store.setAssistantUndoStack(
                        snap.assistantUndoStack.map((rec) =>
                            rec.id === undoId ? { ...rec, reverted: true } : rec,
                        ),
                    );
                    store.setAssistantPendingApprovals(
                        snap.assistantPendingApprovals.map((appr) =>
                            appr.undoId === undoId ? { ...appr, reverted: true } : appr,
                        ),
                    );
                }

                store.pushToast(
                    `↩ 已还原写前快照：${target?.label ?? undoId}`,
                    'success',
                );
            } catch (err) {
                store.pushToast(`撤销操作失败：${formatErrorMessage(err)}`, 'error');
            } finally {
                setBusyUndoId(null);
            }
        },
        [store, undoById],
    );

    const handlePreviewFile = useCallback(
        async (filePath: string) => {
            setPreviewFile({ path: filePath, content: '', loading: true });
            const reader = store.assistantRuntime?.readPreviewFile;
            if (!reader) {
                setPreviewFile({
                    path: filePath,
                    content: '（当前运行时未提供只读文件预览器）',
                    loading: false,
                });
                return;
            }
            try {
                const content = await reader(filePath);
                setPreviewFile({
                    path: filePath,
                    content: content ?? '（文件不存在或内容为空）',
                    loading: false,
                });
            } catch (err) {
                setPreviewFile({
                    path: filePath,
                    content: `读取失败：${formatErrorMessage(err)}`,
                    loading: false,
                });
            }
        },
        [store],
    );

    const handleRootKeyDown = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            if (isRenamingTopbarTitle) {
                event.preventDefault();
                handleCancelTopbarRename();
                return;
            }
            if (topbarRenameRevealed) {
                event.preventDefault();
                setTopbarRenameRevealed(false);
                return;
            }
            if (editingMessageId !== null) {
                event.preventDefault();
                setEditingMessageId(null);
                return;
            }
            if (activeActionsMessageId !== null) {
                event.preventDefault();
                setActiveActionsMessageId(null);
                return;
            }
            if (openPopover !== null) {
                event.preventDefault();
                setOpenPopover(null);
            }
        }
    };

    const handleRootKeyUp = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
    };

    const hasDragFiles = (event: DragEvent): boolean => {
        const dt = event.dataTransfer;
        if (!dt) {
            return false;
        }
        if (dt.files && dt.files.length > 0) {
            return true;
        }
        if (dt.types) {
            return Array.from(dt.types).includes('Files');
        }
        return false;
    };

    const handleRootDragEnter = (event: TargetedEvent<HTMLDivElement, DragEvent>) => {
        if (!hasDragFiles(event)) {
            return;
        }
        event.preventDefault();
        dragDepthRef.current += 1;
        setIsDragOver(true);
    };

    const handleRootDragOver = (event: TargetedEvent<HTMLDivElement, DragEvent>) => {
        if (!hasDragFiles(event)) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
        if (!isDragOver) {
            setIsDragOver(true);
        }
    };

    const handleRootDragLeave = () => {
        if (!isDragOver && dragDepthRef.current === 0) {
            return;
        }
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) {
            setIsDragOver(false);
        }
    };

    const handleRootDrop = (event: TargetedEvent<HTMLDivElement, DragEvent>) => {
        const dt = event.dataTransfer;
        dragDepthRef.current = 0;
        setIsDragOver(false);
        if (!dt) {
            return;
        }
        if (dt.files && dt.files.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            void handleAddFiles(dt.files);
        }
    };

    const handleFileInputChange = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const files = event.currentTarget.files;
        if (files && files.length > 0) {
            void handleAddFiles(files);
        }
        event.currentTarget.value = '';
    };

    const handleComposerPaste = (event: TargetedEvent<HTMLTextAreaElement, ClipboardEvent>) => {
        const dt = event.clipboardData;
        if (!dt) {
            return;
        }
        const files: File[] = [];
        if (dt.files && dt.files.length > 0) {
            files.push(...Array.from(dt.files));
        } else if (dt.items && dt.items.length > 0) {
            for (const item of Array.from(dt.items)) {
                if (item.kind === 'file') {
                    const f = item.getAsFile();
                    if (f) {
                        files.push(f);
                    }
                }
            }
        }
        if (files.length > 0) {
            event.preventDefault();
            void handleAddFiles(files);
        }
    };

    const handleComposerKeyDown = (event: TargetedKeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (
            event.key === 'Enter'
            && !event.shiftKey
            && !event.isComposing
            && !isStreamingCurrent
        ) {
            event.preventDefault();
            void handleSendPrompt();
        }
    };

    const handleComposerKeyUp = (event: TargetedKeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
    };

    // Mobile (< 768px) in 'list' stack: show full-viewport session list.
    if (isMobile && mobileAssistantStack === 'list') {
        return (
            <div
                class="ag-ast-root"
                data-view-id="assistant"
                data-assistant-mobile-view="list"
                onKeyDown={handleRootKeyDown}
                onKeyUp={handleRootKeyUp}
            >
                <SessionListPanel
                    sessions={assistantSessions}
                    selectedSessionId={activeSession?.id ?? null}
                    approvalsById={approvalsById}
                    activeUndoCount={activeUndoCount}
                    isMobile
                    onSelectSession={handleSelectSession}
                    onCreateSession={() => void handleCreateSession()}
                    onRenameSession={handleRenameSession}
                    onDeleteSession={(id) => void handleDeleteSession(id)}
                    onOpenUndoModal={() => setUndoModalOpen(true)}
                />

                <UndoHistoryModal
                    open={undoModalOpen}
                    records={undoStack}
                    activeSessionId={activeSession?.id ?? null}
                    busyUndoId={busyUndoId}
                    onApplyUndo={handleApplyUndo}
                    onClose={() => setUndoModalOpen(false)}
                />
            </div>
        );
    }

    const activeMode: AssistantMode = activeSession?.mode ?? 'chat';
    const modeMeta = ASSISTANT_MODE_META[activeMode];
    const isAdminMode = Boolean(activeSession?.mode === 'full' && activeSession?.stAdminEnabled);
    const modeButtonLabel = isAdminMode ? '⚡ 管家' : `${modeMeta.icon} ${modeMeta.label}`;
    const modeButtonPillClass = isAdminMode ? 'ag-pill-error' : modeMeta.pillClass;

    const connDisplay = resolveConnectionDisplay(
        activeSession?.connectionId ?? 'inherit',
        settings.connections,
        settings.currentConnectionId,
    );

    const renderedMessages: AssistantMessage[] = activeSession ? activeSession.messages : [];
    const effectiveCompacting = isCompacting || Boolean(tokenStatus?.isCompacting);
    const effectiveTokenLevel: AssistantTokenLevel = tokenStatus
        ? resolveEffectiveTokenLevel(tokenStatus)
        : 'normal';
    const tokenPillTitle = tokenStatus
        ? effectiveCompacting
            ? '正在压缩当前会话上下文...'
            : `当前上下文约 ${tokenStatus.currentTokens.toLocaleString()} / ${tokenStatus.contextLimit.toLocaleString()} tok (${tokenStatus.usagePercent}%) · 点击管理/压缩上下文`
        : '';
    const canCompactRuntime = Boolean(store.assistantRuntime?.compactSession);
    const lastMsg = renderedMessages[renderedMessages.length - 1];
    const showSyntheticStreamingBubble = Boolean(
        isStreamingCurrent
        && streamingDelta
        && activeSession
        && streamingDelta.sessionId === activeSession.id
        && (!lastMsg || lastMsg.role !== 'assistant' || streamingDelta.text.length > 0),
    );
    const syntheticMessageAlreadyReflected = Boolean(
        lastMsg
        && lastMsg.role === 'assistant'
        && streamingDelta
        && streamingDelta.text.length > 0
        && lastMsg.content.endsWith(streamingDelta.text),
    );

    return (
        <div
            class="ag-ast-root"
            data-view-id="assistant"
            data-assistant-mobile-view={isMobile ? 'detail' : 'desktop'}
            data-drag-over={isDragOver ? 'true' : 'false'}
            onKeyDown={handleRootKeyDown}
            onKeyUp={handleRootKeyUp}
            onDragEnter={handleRootDragEnter}
            onDragOver={handleRootDragOver}
            onDragLeave={handleRootDragLeave}
            onDrop={handleRootDrop}
        >
            {/* 1. Slim Single-Line Top Bar (min-h-[46px]) */}
            <div class="ag-ast-topbar" data-assistant-topbar="true">
                <div class="ag-ast-topbar-left">
                    {isMobile ? (
                        <button
                            type="button"
                            data-assistant-back-btn="true"
                            aria-label="返回会话列表"
                            title="返回会话列表"
                            class="ag-ast-topbar-btn"
                            onClick={handleBackToList}
                        >
                            ←
                        </button>
                    ) : (
                        <button
                            type="button"
                            data-assistant-drawer-btn="true"
                            aria-expanded={openPopover === 'sessions'}
                            title="打开助手会话列表"
                            class="ag-ast-topbar-btn"
                            onClick={() => {
                                setTopbarRenameRevealed(false);
                                setOpenPopover((prev) =>
                                    prev === 'sessions' ? null : 'sessions',
                                );
                            }}
                        >
                            <span>☰</span>
                            <span>会话 ({assistantSessions.length})</span>
                        </button>
                    )}

                    {activeSession ? (
                        isRenamingTopbarTitle ? (
                            <div
                                class="ag-ast-title-edit"
                                data-assistant-topbar-rename-form="true"
                            >
                                <input
                                    ref={topbarRenameInputRef}
                                    type="text"
                                    class="ag-ast-title-input"
                                    data-assistant-topbar-rename-input="true"
                                    aria-label="编辑会话标题"
                                    placeholder="输入会话标题..."
                                    maxLength={80}
                                    value={topbarTitleDraft}
                                    onInput={(e) => setTopbarTitleDraft(e.currentTarget.value)}
                                    onKeyDown={handleTopbarRenameKeyDown}
                                    onKeyUp={(e) => e.stopPropagation()}
                                />
                                <button
                                    type="button"
                                    class="ag-ast-title-edit-btn ag-ast-title-edit-save"
                                    data-assistant-topbar-rename-save="true"
                                    aria-label="保存会话标题"
                                    title="保存 (Enter)"
                                    disabled={!topbarTitleDraft.trim()}
                                    onClick={() => void handleCommitTopbarRename()}
                                >
                                    <IconCheck size={14} />
                                </button>
                                <button
                                    type="button"
                                    class="ag-ast-title-edit-btn"
                                    data-assistant-topbar-rename-cancel="true"
                                    aria-label="取消重命名"
                                    title="取消 (Esc)"
                                    onClick={handleCancelTopbarRename}
                                >
                                    <IconClose size={14} />
                                </button>
                            </div>
                        ) : (
                            <div
                                class="ag-ast-title-wrap"
                                data-assistant-title-wrap="true"
                                data-rename-revealed={topbarRenameRevealed ? 'true' : 'false'}
                            >
                                <span
                                    class="ag-ast-title ag-ast-title-interactive"
                                    data-assistant-session-title="true"
                                    title={activeSession.title}
                                    onPointerDown={handleTitlePointerDown}
                                    onClick={handleTitleTap}
                                    onDblClick={handleStartTopbarRename}
                                >
                                    {activeSession.title}
                                </span>
                                <button
                                    type="button"
                                    class="ag-ast-title-rename-btn"
                                    data-assistant-topbar-rename-btn="true"
                                    aria-label={`重命名会话：${activeSession.title}`}
                                    title="重命名会话"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        handleStartTopbarRename();
                                    }}
                                >
                                    <IconEdit size={14} />
                                </button>
                            </div>
                        )
                    ) : (
                        <span
                            class="ag-ast-title"
                            data-assistant-session-title="true"
                            title="助手工作台"
                        >
                            助手工作台
                        </span>
                    )}
                </div>

                {!(isMobile && isRenamingTopbarTitle) ? (
                    <div class="ag-ast-topbar-right">
                        {activeSession && tokenStatus ? (
                            <button
                                type="button"
                                data-assistant-token-pill="true"
                                data-token-level={effectiveTokenLevel}
                                data-token-compacting={effectiveCompacting ? 'true' : 'false'}
                                aria-label={
                                    effectiveCompacting
                                        ? '正在压缩上下文'
                                        : `上下文占用 ${formatCompactTokens(tokenStatus.currentTokens)}，点击管理或压缩上下文`
                                }
                                title={tokenPillTitle}
                                disabled={effectiveCompacting}
                                class={[
                                    'ag-ast-topbar-btn',
                                    'ag-ast-token-pill',
                                    `ag-ast-token-${effectiveTokenLevel}`,
                                    effectiveCompacting ? 'ag-ast-token-compacting' : '',
                                ]
                                    .filter(Boolean)
                                    .join(' ')}
                                onClick={handleOpenCompactModal}
                            >
                                <span class="ag-ast-token-dot" aria-hidden="true" />
                                <span class="ag-ast-token-text">
                                    {effectiveCompacting
                                        ? '压缩中...'
                                        : formatCompactTokens(tokenStatus.currentTokens)}
                                </span>
                            </button>
                        ) : null}

                        <button
                            type="button"
                            data-assistant-new-session-btn="true"
                            aria-label="新建助手会话"
                            title="新建助手会话"
                            class="ag-ast-topbar-btn"
                            onClick={() => {
                                setTopbarRenameRevealed(false);
                                void handleCreateSession();
                            }}
                        >
                            ＋
                        </button>

                        <button
                            type="button"
                            data-assistant-undo-btn="true"
                            aria-label={`写前快照撤销历史 (${activeUndoCount})`}
                            title="写前快照撤销历史"
                            class="ag-ast-topbar-btn"
                            onClick={() => {
                                setTopbarRenameRevealed(false);
                                setOpenPopover(null);
                                setUndoModalOpen(true);
                            }}
                        >
                            <span>↩</span>
                            {activeUndoCount > 0 ? (
                                <span class="ag-ast-undo-count">{activeUndoCount}</span>
                            ) : null}
                        </button>
                    </div>
                ) : null}
            </div>

            {/* 2. Main Conversation Stream (Maximized Viewport) */}
            <div
                ref={threadRef}
                class="ag-ast-thread ag-thin-scroll"
                data-assistant-thread="true"
                onClick={(e) => {
                    if (topbarRenameRevealed) {
                        setTopbarRenameRevealed(false);
                    }
                    if (e.target === e.currentTarget && activeActionsMessageId !== null) {
                        setActiveActionsMessageId(null);
                    }
                }}
            >
                {!activeSession ? (
                    <div class="ag-empty" style={{ margin: 'auto' }}>
                        <div class="ag-empty-title">独立线外助手工作台</div>
                        <div class="ag-empty-desc">
                            不占用主线上下文与 KV Cache。新建会话后直接输入自然语言，助手将按当前权限自主调用只读或写卡工具。
                        </div>
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void handleCreateSession()}
                        >
                            ＋ 新建助手会话
                        </Button>
                    </div>
                ) : renderedMessages.length === 0 && !showSyntheticStreamingBubble ? (
                    <div class="ag-ast-msg-row ag-ast-msg-row-assistant">
                        <div class="ag-ast-bubble-assistant">
                            <div class="ag-ast-bubble-content">
                                已就绪：<strong>{modeMeta.fullLabel}</strong>
                                {isAdminMode ? ' · 🛡️ ST 全权管家' : ''}
                                （独立上下文，0 占用主线 Token）。直接输入你的指令，助手会按需自主读取所需档案与状态。
                            </div>
                            <div class="ag-ast-bubble-footer">
                                <span>Agentic 助手</span>
                                <span>就绪</span>
                            </div>
                        </div>
                    </div>
                ) : (
                    <>
                        {renderedMessages.map((msg, idx) => {
                            const isLastMessage = idx === renderedMessages.length - 1;
                            const isLastStreamingMsg =
                                isStreamingCurrent
                                && isLastMessage
                                && msg.role === 'assistant'
                                && (!showSyntheticStreamingBubble || syntheticMessageAlreadyReflected);
                            const hasPriorOrSelfUser =
                                msg.role === 'user'
                                || renderedMessages.slice(0, idx).some((m) => m.role === 'user');
                            const canRegenerate =
                                isLastMessage
                                && hasPriorOrSelfUser
                                && !(showSyntheticStreamingBubble && !syntheticMessageAlreadyReflected);
                            const canContinue =
                                isLastMessage
                                && msg.role === 'assistant'
                                && msg.errorCode !== 'context_overflow'
                                && !(showSyntheticStreamingBubble && !syntheticMessageAlreadyReflected)
                                && Boolean(
                                    msg.interrupted
                                    || msg.canContinue
                                    || activeSession?.interruptedCheckpoint?.messageId === msg.id
                                    || (!msg.content.trim()
                                        && (msg.toolCalls?.length ?? 0) > 0
                                        && !(msg.approvalIds?.length)),
                                );

                            return (
                                <MessageBubble
                                    key={msg.id}
                                    message={msg}
                                    isMobile={isMobile}
                                    isStreaming={isLastStreamingMsg}
                                    isLastMessage={isLastMessage}
                                    canRegenerate={canRegenerate}
                                    canContinue={canContinue}
                                    isSessionStreaming={isStreamingCurrent}
                                    isCompacting={effectiveCompacting}
                                    isEditing={editingMessageId === msg.id}
                                    actionsOpen={activeActionsMessageId === msg.id}
                                    approvalsById={approvalsById}
                                    undoById={undoById}
                                    busyApprovalId={busyApprovalId}
                                    busyUndoId={busyUndoId}
                                    onDecideApproval={handleDecideApproval}
                                    onRetryApproval={handleRetryApproval}
                                    onApplyUndo={handleApplyUndo}
                                    onPreviewFile={(path) => void handlePreviewFile(path)}
                                    onPreviewImage={(att) => setPreviewImage(att)}
                                    onToggleActions={(id) =>
                                        setActiveActionsMessageId((prev) => (prev === id ? null : id))
                                    }
                                    onCloseActions={() => setActiveActionsMessageId(null)}
                                    onStartEdit={(id) => {
                                        setOpenPopover(null);
                                        setActiveActionsMessageId(null);
                                        setEditingMessageId(id);
                                    }}
                                    onCancelEdit={() => setEditingMessageId(null)}
                                    onSaveEdit={handleSaveEditMessage}
                                    onSaveAndResendEdit={handleSaveAndResendMessage}
                                    onRetract={handleRetractMessage}
                                    onRegenerate={handleRegenerateLastMessage}
                                    onContinue={handleContinueLastMessage}
                                    onCompactAndRetryOverflow={handleCompactAndRetryOverflow}
                                    onCopy={handleCopyMessage}
                                />
                            );
                        })}

                        {showSyntheticStreamingBubble && !syntheticMessageAlreadyReflected ? (
                            <MessageBubble
                                key="assistant-streaming-live"
                                message={{
                                    id: 'assistant-streaming-live',
                                    role: 'assistant',
                                    content: streamingDelta?.text ?? '',
                                    timestamp: Date.now(),
                                }}
                                isStreaming
                                isSyntheticStreaming
                                isSessionStreaming={isStreamingCurrent}
                                approvalsById={approvalsById}
                                undoById={undoById}
                                busyApprovalId={busyApprovalId}
                                busyUndoId={busyUndoId}
                                onDecideApproval={handleDecideApproval}
                                onRetryApproval={handleRetryApproval}
                                onApplyUndo={handleApplyUndo}
                                onPreviewFile={(path) => void handlePreviewFile(path)}
                            />
                        ) : null}
                    </>
                )}
            </div>

            {/* Popover Backdrop for Mode / Model selectors */}
            {(openPopover === 'mode' || openPopover === 'model') ? (
                <div
                    class="ag-ast-popover-backdrop"
                    data-assistant-popover-backdrop="true"
                    onClick={() => setOpenPopover(null)}
                />
            ) : null}

            {/* 3. Unified Minimal Bottom Composer (NO shortcut bar, NO attach context chips) */}
            <div class="ag-ast-composer-wrap" data-assistant-composer="true">
                {activeSession && (openPopover === 'mode' || openPopover === 'model') ? (
                    <ModeModelPopover
                        kind={openPopover}
                        session={activeSession}
                        connections={settings.connections}
                        currentConnectionId={settings.currentConnectionId}
                        onSelectMode={handleSelectMode}
                        onToggleAutoApproveAuthor={handleToggleAutoApproveAuthor}
                        onToggleAutoApproveChatDelete={handleToggleAutoApproveChatDelete}
                        onRequestToggleStAdmin={handleRequestToggleStAdmin}
                        onSelectConnection={handleSelectConnection}
                        onClose={() => setOpenPopover(null)}
                    />
                ) : null}

                <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ASSISTANT_FILE_ACCEPT}
                    data-assistant-file-input="true"
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                />

                <div
                    class={
                        isDragOver
                            ? 'ag-ast-composer-box ag-ast-composer-box-dragover'
                            : 'ag-ast-composer-box'
                    }
                >
                    {isDragOver ? (
                        <div class="ag-ast-drop-hint" data-assistant-drop-hint="true">
                            📥 松开鼠标即可上传图片、音频、视频或文件
                        </div>
                    ) : null}

                    {pendingAttachments.length > 0 ? (
                        <div
                            class="ag-ast-pending-attachments"
                            data-assistant-pending-attachments="true"
                        >
                            {pendingAttachments.map((att) => (
                                <div
                                    key={att.id}
                                    class="ag-ast-pending-chip"
                                    data-pending-attachment={att.id}
                                    data-attachment-kind={att.kind}
                                >
                                    {att.kind === 'image' ? (
                                        <img
                                            src={att.dataUrl}
                                            alt={att.name}
                                            class="ag-ast-pending-thumb"
                                        />
                                    ) : (
                                        <span class="ag-ast-pending-icon" aria-hidden="true">
                                            {att.kind === 'audio'
                                                ? '🎵'
                                                : att.kind === 'video'
                                                    ? '🎬'
                                                    : '📄'}
                                        </span>
                                    )}
                                    <div class="ag-ast-pending-meta">
                                        <span class="ag-ast-pending-name" title={att.name}>
                                            {att.name}
                                        </span>
                                        <span class="ag-ast-pending-size">
                                            {formatFileSize(att.size)}
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        class="ag-ast-pending-remove"
                                        data-remove-attachment={att.id}
                                        aria-label={`移除附件 ${att.name}`}
                                        title={`移除附件 ${att.name}`}
                                        onClick={() => handleRemovePendingAttachment(att.id)}
                                    >
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : null}

                    <textarea
                        ref={textareaRef}
                        rows={1}
                        data-assistant-draft-input="true"
                        aria-label="输入助手指令"
                        placeholder="输入指令或拖拽图片/音频/视频/文件到此处..."
                        class="ag-ast-composer-input"
                        value={draft}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onPaste={handleComposerPaste}
                        onKeyDown={handleComposerKeyDown}
                        onKeyUp={handleComposerKeyUp}
                    />

                    <div class="ag-ast-composer-bar">
                        <div class="ag-ast-composer-left">
                            <button
                                type="button"
                                data-assistant-mode-btn="true"
                                aria-expanded={openPopover === 'mode'}
                                title="切换助手权限模式"
                                disabled={!activeSession}
                                class={`ag-ast-mode-btn ${modeButtonPillClass}`}
                                onClick={() =>
                                    setOpenPopover((prev) => (prev === 'mode' ? null : 'mode'))
                                }
                            >
                                <span>{modeButtonLabel}</span>
                                <span style={{ opacity: 0.7, fontSize: '10px' }}>▾</span>
                            </button>

                            <button
                                type="button"
                                data-assistant-model-btn="true"
                                aria-expanded={openPopover === 'model'}
                                title={`切换助手模型连接：${connDisplay.fullLabel}`}
                                disabled={!activeSession}
                                class={
                                    openPopover === 'model'
                                        ? 'ag-ast-model-btn ag-pill-primary'
                                        : 'ag-ast-model-btn'
                                }
                                onClick={() =>
                                    setOpenPopover((prev) => (prev === 'model' ? null : 'model'))
                                }
                            >
                                <span class="ag-ast-model-label">{connDisplay.shortLabel}</span>
                                <span
                                    style={{ opacity: 0.7, fontSize: '10px', flexShrink: 0 }}
                                >
                                    ▾
                                </span>
                            </button>
                        </div>

                        <div class="ag-ast-composer-right">
                            <button
                                type="button"
                                data-assistant-upload-btn="true"
                                aria-label="上传图片、音频、视频或文件"
                                title="上传附件（图片 / 音频 / 视频 / 文件，或直接拖拽到此处）"
                                disabled={isStreamingCurrent}
                                class="ag-ast-upload-btn"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <span aria-hidden="true">📎</span>
                            </button>

                            {isStreamingCurrent ? (
                                <button
                                    type="button"
                                    data-assistant-stop-btn="true"
                                    title="停止生成"
                                    aria-label="停止生成"
                                    class="ag-ast-stop-btn"
                                    onClick={handleAbortStream}
                                >
                                    <span>■</span>
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    data-assistant-send-btn="true"
                                    title="发送 (Enter)"
                                    aria-label="发送"
                                    class="ag-ast-send-btn"
                                    onClick={() => void handleSendPrompt()}
                                >
                                    <span>▶</span>
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Desktop Slide-Out Sessions Drawer */}
            {!isMobile && openPopover === 'sessions' ? (
                <div
                    class="ag-ast-drawer-backdrop"
                    data-assistant-drawer-backdrop="true"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) {
                            setOpenPopover(null);
                        }
                    }}
                >
                    <div class="ag-ast-drawer">
                        <SessionListPanel
                            sessions={assistantSessions}
                            selectedSessionId={activeSession?.id ?? null}
                            approvalsById={approvalsById}
                            activeUndoCount={activeUndoCount}
                            isMobile={false}
                            onSelectSession={handleSelectSession}
                            onCreateSession={() => void handleCreateSession()}
                            onRenameSession={handleRenameSession}
                            onDeleteSession={(id) => void handleDeleteSession(id)}
                            onOpenUndoModal={() => {
                                setOpenPopover(null);
                                setUndoModalOpen(true);
                            }}
                            onCloseDrawer={() => setOpenPopover(null)}
                        />
                    </div>
                </div>
            ) : null}

            {/* In-Shadow-DOM Context Compaction Confirmation Modal */}
            <ShadowModal
                open={compactModalOpen && activeSession !== null}
                title="压缩当前会话上下文"
                maxWidth="540px"
                onClose={() => {
                    if (!effectiveCompacting) {
                        setCompactModalOpen(false);
                        setCompactError(null);
                    }
                }}
                footer={
                    <div class="ag-compact-modal-footer">
                        <button
                            type="button"
                            class="ag-btn ag-btn-secondary ag-btn-sm"
                            data-assistant-compact-cancel="true"
                            disabled={effectiveCompacting}
                            onClick={() => {
                                setCompactModalOpen(false);
                                setCompactError(null);
                            }}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            class="ag-btn ag-btn-secondary ag-btn-sm"
                            data-assistant-compact-fold="true"
                            disabled={
                                effectiveCompacting
                                || isStreamingCurrent
                                || !canCompactRuntime
                                || (tokenStatus?.foldableToolResultCount ?? 0) <= 0
                            }
                            onClick={() => void handleRunCompaction('fold_only')}
                        >
                            仅折叠旧工具
                        </button>
                        <button
                            type="button"
                            class="ag-btn ag-btn-primary ag-btn-sm"
                            data-assistant-compact-confirm="true"
                            disabled={effectiveCompacting || isStreamingCurrent || !canCompactRuntime}
                            aria-busy={effectiveCompacting || undefined}
                            onClick={() => void handleRunCompaction('full')}
                        >
                            {effectiveCompacting ? '压缩中...' : '确认压缩'}
                        </button>
                    </div>
                }
            >
                <div class="ag-compact-modal-body" data-assistant-compact-modal="true">
                    {tokenStatus ? (
                        <div class="ag-compact-meter-card">
                            <div class="ag-compact-meter-row">
                                <span class="ag-compact-meter-label">当前上下文占用</span>
                                <span
                                    class="ag-mono ag-compact-meter-value"
                                    data-assistant-compact-usage="true"
                                >
                                    {tokenStatus.currentTokens.toLocaleString()} /{' '}
                                    {tokenStatus.contextLimit.toLocaleString()} tok (
                                    {tokenStatus.usagePercent}%)
                                </span>
                            </div>

                            <div class="ag-compact-progress-track">
                                <div
                                    class={`ag-compact-progress-fill ag-compact-progress-${effectiveTokenLevel}`}
                                    style={{
                                        width: `${Math.min(100, Math.max(0, tokenStatus.usagePercent))}%`,
                                    }}
                                />
                                {tokenStatus.contextLimit > 0
                                && tokenStatus.highWatermark > 0
                                && tokenStatus.highWatermark < tokenStatus.contextLimit ? (
                                    <span
                                        class="ag-compact-progress-marker"
                                        title={`自动高水位线：${tokenStatus.highWatermark.toLocaleString()} tok`}
                                        style={{
                                            left: `${Math.min(
                                                98,
                                                Math.max(
                                                    2,
                                                    Math.round(
                                                        (tokenStatus.highWatermark
                                                            / tokenStatus.contextLimit)
                                                            * 100,
                                                    ),
                                                ),
                                            )}%`,
                                        }}
                                    />
                                ) : null}
                            </div>

                            <div class="ag-compact-stats" data-assistant-compact-stats="true">
                                当前活跃 {tokenStatus.activeTurnCount} 轮 · 包含{' '}
                                {tokenStatus.foldableToolResultCount} 条可折叠旧工具输出 · 已归档{' '}
                                {tokenStatus.compactedCount} 块
                            </div>
                        </div>
                    ) : null}

                    <div class="ag-banner ag-banner-primary">
                        仅精简发给模型的轨迹上下文，界面聊天记录、审批卡与写前撤销记录将完整保留。
                    </div>

                    {tokenStatus?.summaryPreview ? (
                        <div class="ag-compact-preview-box">
                            <button
                                type="button"
                                class="ag-compact-summary-toggle"
                                data-assistant-compact-preview-toggle="true"
                                aria-expanded={compactSummaryPreviewOpen}
                                onClick={() => setCompactSummaryPreviewOpen((prev) => !prev)}
                            >
                                <span>已有交接摘要预览</span>
                                <span>{compactSummaryPreviewOpen ? '▾' : '▸'}</span>
                            </button>
                            {compactSummaryPreviewOpen ? (
                                <pre
                                    class="ag-compact-summary-pre ag-thin-scroll"
                                    data-assistant-compact-preview-body="true"
                                >
                                    {tokenStatus.summaryPreview}
                                </pre>
                            ) : null}
                        </div>
                    ) : null}

                    <div class="ag-field">
                        <label class="ag-field-label" for="ag-ast-compact-focus">
                            保留重点（可选）
                        </label>
                        <textarea
                            id="ag-ast-compact-focus"
                            rows={3}
                            class="ag-compact-focus-textarea ag-thin-scroll"
                            data-assistant-compact-focus="true"
                            aria-label="保留重点"
                            placeholder="可选：输入需要重点保留的规则、文件或上下文目标（例如：保留世界书路由改造细节）"
                            value={compactFocusDraft}
                            disabled={effectiveCompacting}
                            onInput={(e) => setCompactFocusDraft(e.currentTarget.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            onKeyUp={(e) => e.stopPropagation()}
                            onKeyPress={(e) => e.stopPropagation()}
                        />
                    </div>

                    {compactError ? (
                        <div
                            class="ag-banner ag-banner-error"
                            data-assistant-compact-error="true"
                        >
                            {compactError}
                        </div>
                    ) : null}
                </div>
            </ShadowModal>

            {/* In-Shadow-DOM Secondary Confirmation Modal for ST 全权管家 */}
            <StAdminConfirmModal
                open={stAdminConfirmOpen}
                onCancel={() => setStAdminConfirmOpen(false)}
                onConfirm={handleConfirmStAdmin}
            />

            {/* In-Shadow-DOM Pre-Write Undo History Modal */}
            <UndoHistoryModal
                open={undoModalOpen}
                records={undoStack}
                activeSessionId={activeSession?.id ?? null}
                busyUndoId={busyUndoId}
                onApplyUndo={handleApplyUndo}
                onClose={() => setUndoModalOpen(false)}
            />

            {/* In-Shadow-DOM Read-Only File Preview Modal */}
            <ShadowModal
                open={previewFile !== null}
                title={previewFile ? `📄 只读文件预览 · ${previewFile.path}` : '只读文件预览'}
                maxWidth="640px"
                onClose={() => setPreviewFile(null)}
                footer={
                    <Button variant="secondary" size="sm" onClick={() => setPreviewFile(null)}>
                        关闭
                    </Button>
                }
            >
                {previewFile?.loading ? (
                    <div style={{ color: 'var(--muted-foreground)', fontSize: '12px' }}>
                        正在读取文件快照...
                    </div>
                ) : (
                    <pre class="ag-pre ag-thin-scroll">
                        {renderRedactedText(previewFile?.content ?? '')}
                    </pre>
                )}
            </ShadowModal>

            {/* In-Shadow-DOM Image Attachment Lightbox Modal */}
            <ShadowModal
                open={previewImage !== null}
                title={previewImage ? `🖼️ 图片预览 · ${previewImage.name}` : '图片预览'}
                maxWidth="720px"
                onClose={() => setPreviewImage(null)}
                footer={
                    <Button variant="secondary" size="sm" onClick={() => setPreviewImage(null)}>
                        关闭
                    </Button>
                }
            >
                {previewImage ? (
                    <div
                        data-assistant-image-preview="true"
                        style={{ display: 'flex', justifyContent: 'center' }}
                    >
                        <img
                            src={previewImage.dataUrl}
                            alt={previewImage.name}
                            style={{
                                maxWidth: '100%',
                                maxHeight: '70vh',
                                borderRadius: '10px',
                                objectFit: 'contain',
                            }}
                        />
                    </div>
                ) : null}
            </ShadowModal>
        </div>
    );
}
