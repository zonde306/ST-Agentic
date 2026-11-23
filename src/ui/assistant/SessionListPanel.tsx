import type { TargetedKeyboardEvent, TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AssistantSession, PendingApproval } from '@/core/types';
import { IconCheck, IconClose, IconEdit, IconTrash } from '@/ui/components/Icons';
import {
    ASSISTANT_MODE_META,
    countSessionPendingApprovals,
    formatAssistantTime,
} from './assistant-helpers';

export interface SessionListPanelProps {
    sessions: readonly AssistantSession[];
    selectedSessionId: string | null;
    approvalsById: ReadonlyMap<string, PendingApproval>;
    activeUndoCount: number;
    isMobile: boolean;
    onSelectSession: (sessionId: string) => void;
    onCreateSession: () => void;
    onRenameSession: (sessionId: string, nextTitle: string) => void | Promise<boolean | void>;
    onDeleteSession: (sessionId: string) => void;
    onOpenUndoModal: () => void;
    onCloseDrawer?: () => void;
}

/**
 * Assistant Session List Panel.
 * - Mobile (`< 768px` in `'list'` stack): fills the viewport; selecting a session pushes `'detail'`.
 * - Desktop (`>= 768px`): rendered inside the slide-out left drawer toggled by `☰ 会话 (N)`.
 */
export function SessionListPanel({
    sessions,
    selectedSessionId,
    approvalsById,
    activeUndoCount,
    isMobile,
    onSelectSession,
    onCreateSession,
    onRenameSession,
    onDeleteSession,
    onOpenUndoModal,
    onCloseDrawer,
}: SessionListPanelProps) {
    const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
    const [titleDraft, setTitleDraft] = useState<string>('');
    const renameInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (editingSessionId && !sessions.some((s) => s.id === editingSessionId)) {
            setEditingSessionId(null);
            setTitleDraft('');
        }
    }, [editingSessionId, sessions]);

    useEffect(() => {
        if (!editingSessionId) {
            return;
        }
        const input = renameInputRef.current;
        if (input) {
            input.focus();
            try {
                input.select();
            } catch {
                // Ignore selection errors in restricted environments.
            }
        }
    }, [editingSessionId]);

    const handleStartRename = (
        event: TargetedMouseEvent<HTMLButtonElement>,
        session: AssistantSession,
    ) => {
        event.stopPropagation();
        setEditingSessionId(session.id);
        setTitleDraft(session.title);
    };

    const handleCancelRename = (event?: TargetedMouseEvent<HTMLButtonElement>) => {
        event?.stopPropagation();
        setEditingSessionId(null);
        setTitleDraft('');
    };

    const handleCommitRename = async (session: AssistantSession) => {
        const trimmed = titleDraft.trim();
        if (!trimmed) {
            return;
        }
        setEditingSessionId(null);
        setTitleDraft('');
        if (trimmed === session.title) {
            return;
        }
        await onRenameSession(session.id, trimmed);
    };

    const handleRenameKeyDown = (
        event: TargetedKeyboardEvent<HTMLInputElement>,
        session: AssistantSession,
    ) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            handleCancelRename();
            return;
        }
        if (event.key === 'Enter' && !event.isComposing && titleDraft.trim()) {
            event.preventDefault();
            void handleCommitRename(session);
        }
    };

    const handleDeleteClick = (
        event: TargetedMouseEvent<HTMLButtonElement>,
        sessionId: string,
    ) => {
        event.stopPropagation();
        if (editingSessionId === sessionId) {
            setEditingSessionId(null);
            setTitleDraft('');
        }
        onDeleteSession(sessionId);
    };

    return (
        <div
            class="ag-ast-session-panel"
            data-assistant-session-panel="true"
            data-assistant-panel-mode={isMobile ? 'mobile-list' : 'desktop-drawer'}
        >
            <div class="ag-ast-session-header">
                <button
                    type="button"
                    data-assistant-create-session="true"
                    class="ag-btn ag-btn-primary ag-btn-sm"
                    style={{ flex: '1 1 auto', borderRadius: '12px', fontWeight: 600 }}
                    onClick={onCreateSession}
                >
                    <span>＋ 新建会话</span>
                </button>
                {!isMobile && onCloseDrawer ? (
                    <button
                        type="button"
                        data-assistant-close-drawer="true"
                        aria-label="关闭会话抽屉"
                        title="关闭会话抽屉"
                        class="ag-ast-topbar-btn"
                        onClick={onCloseDrawer}
                    >
                        ✕
                    </button>
                ) : null}
            </div>

            <div class="ag-ast-session-list ag-thin-scroll" role="list" aria-label="助手会话列表">
                {sessions.length === 0 ? (
                    <div
                        class="ag-empty"
                        style={{ minHeight: '160px', padding: '24px 12px' }}
                    >
                        <div class="ag-empty-title">暂无助手会话</div>
                        <div class="ag-empty-desc">
                            点击上方「＋ 新建会话」，在独立上下文中开始对话与写卡协助。
                        </div>
                    </div>
                ) : (
                    sessions.map((session) => {
                        const modeMeta = ASSISTANT_MODE_META[session.mode];
                        const pendingCount = countSessionPendingApprovals(session, approvalsById);
                        const isSelected = session.id === selectedSessionId;
                        const isEditing = editingSessionId === session.id;
                        const modeLabel =
                            session.mode === 'full' && session.stAdminEnabled
                                ? `${modeMeta.icon} ${modeMeta.label} · 管家`
                                : `${modeMeta.icon} ${modeMeta.label}`;

                        return (
                            <div
                                key={session.id}
                                role="listitem"
                                data-assistant-session-item={session.id}
                                class={
                                    isSelected
                                        ? 'ag-ast-session-item ag-ast-session-item-active'
                                        : 'ag-ast-session-item'
                                }
                                style={{
                                    display: 'flex',
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: '4px',
                                    padding: '4px 6px 4px 10px',
                                }}
                            >
                                {isEditing ? (
                                    <div
                                        class="ag-ast-session-rename-row"
                                        data-assistant-session-rename-form={session.id}
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <input
                                            ref={renameInputRef}
                                            type="text"
                                            class="ag-ast-session-rename-input"
                                            data-assistant-session-rename-input={session.id}
                                            aria-label={`编辑会话标题：${session.title}`}
                                            placeholder="输入会话标题..."
                                            maxLength={80}
                                            value={titleDraft}
                                            onInput={(e) => setTitleDraft(e.currentTarget.value)}
                                            onKeyDown={(e) => handleRenameKeyDown(e, session)}
                                            onKeyUp={(e) => e.stopPropagation()}
                                        />
                                        <button
                                            type="button"
                                            data-assistant-session-rename-save={session.id}
                                            aria-label="保存会话标题"
                                            title="保存 (Enter)"
                                            class="ag-ast-title-edit-btn ag-ast-title-edit-save"
                                            disabled={!titleDraft.trim()}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void handleCommitRename(session);
                                            }}
                                        >
                                            <IconCheck size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            data-assistant-session-rename-cancel={session.id}
                                            aria-label="取消重命名"
                                            title="取消 (Esc)"
                                            class="ag-ast-title-edit-btn"
                                            onClick={handleCancelRename}
                                        >
                                            <IconClose size={14} />
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            data-assistant-session-select={session.id}
                                            aria-current={isSelected ? 'true' : undefined}
                                            onClick={() => {
                                                if (editingSessionId !== null) {
                                                    setEditingSessionId(null);
                                                    setTitleDraft('');
                                                }
                                                onSelectSession(session.id);
                                            }}
                                            style={{
                                                flex: '1 1 auto',
                                                minWidth: 0,
                                                minHeight: '44px',
                                                padding: '6px 4px',
                                                border: 'none',
                                                background: 'transparent',
                                                color: 'inherit',
                                                textAlign: 'left',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '6px',
                                            }}
                                        >
                                            <div class="ag-ast-session-item-top">
                                                <span
                                                    class="ag-ast-session-item-title"
                                                    title={session.title}
                                                >
                                                    {session.title}
                                                </span>
                                                {pendingCount > 0 ? (
                                                    <span
                                                        class="ag-pill ag-pill-warning"
                                                        style={{ borderRadius: '9999px', flexShrink: 0 }}
                                                    >
                                                        待审 {pendingCount}
                                                    </span>
                                                ) : null}
                                            </div>
                                            <div class="ag-ast-session-item-meta">
                                                <span class={`ag-pill ${modeMeta.pillClass}`}>
                                                    {modeLabel}
                                                </span>
                                                <span style={{ whiteSpace: 'nowrap' }}>
                                                    {session.messages.length} 条 ·{' '}
                                                    {formatAssistantTime(session.updatedAt)}
                                                </span>
                                            </div>
                                        </button>

                                        <div class="ag-ast-session-item-actions">
                                            <button
                                                type="button"
                                                data-assistant-session-rename={session.id}
                                                aria-label={`重命名会话：${session.title}`}
                                                title="重命名此会话"
                                                class="ag-btn ag-btn-ghost ag-btn-sm ag-ast-session-icon-btn"
                                                onClick={(e) => handleStartRename(e, session)}
                                            >
                                                <IconEdit size={14} />
                                            </button>

                                            <button
                                                type="button"
                                                data-assistant-session-delete={session.id}
                                                aria-label={`删除会话：${session.title}`}
                                                title="删除此会话"
                                                class="ag-btn ag-btn-ghost ag-btn-sm ag-ast-session-icon-btn"
                                                onClick={(e) => handleDeleteClick(e, session.id)}
                                            >
                                                <IconTrash size={14} />
                                            </button>
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            <div class="ag-ast-session-footer">
                <button
                    type="button"
                    data-assistant-session-undo-btn="true"
                    class="ag-ast-topbar-btn"
                    style={{
                        width: '100%',
                        justifyContent: 'space-between',
                        padding: '0 12px',
                    }}
                    onClick={onOpenUndoModal}
                >
                    <span>↩ 写前快照撤销历史</span>
                    <span
                        class={
                            activeUndoCount > 0
                                ? 'ag-pill ag-pill-warning'
                                : 'ag-pill ag-pill-muted'
                        }
                        style={{ borderRadius: '9999px' }}
                    >
                        {activeUndoCount}
                    </span>
                </button>
            </div>
        </div>
    );
}
