import type { TargetedMouseEvent } from 'preact';
import type { AssistantSession, PendingApproval } from '@/core/types';
import { IconTrash } from '@/ui/components/Icons';
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
    onDeleteSession,
    onOpenUndoModal,
    onCloseDrawer,
}: SessionListPanelProps) {
    const handleDeleteClick = (
        event: TargetedMouseEvent<HTMLButtonElement>,
        sessionId: string,
    ) => {
        event.stopPropagation();
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
                                    gap: '6px',
                                    padding: '4px 6px 4px 10px',
                                }}
                            >
                                <button
                                    type="button"
                                    data-assistant-session-select={session.id}
                                    aria-current={isSelected ? 'true' : undefined}
                                    onClick={() => onSelectSession(session.id)}
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

                                <button
                                    type="button"
                                    data-assistant-session-delete={session.id}
                                    aria-label={`删除会话：${session.title}`}
                                    title="删除此会话"
                                    class="ag-btn ag-btn-ghost ag-btn-sm"
                                    style={{
                                        width: '40px',
                                        height: '40px',
                                        padding: 0,
                                        flexShrink: 0,
                                        color: 'var(--muted-foreground)',
                                    }}
                                    onClick={(e) => handleDeleteClick(e, session.id)}
                                >
                                    <IconTrash size={14} />
                                </button>
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
