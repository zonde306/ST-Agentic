import { useMemo } from 'preact/hooks';
import type { UndoRecord } from '@/core/types';
import { Button, ShadowModal } from '@/ui/components';
import { formatDetailedTime, getUndoKindMeta } from './assistant-helpers';

export interface UndoHistoryModalProps {
    open: boolean;
    records: readonly UndoRecord[];
    activeSessionId: string | null;
    busyUndoId?: string | null;
    onApplyUndo: (undoId: string) => void | Promise<void>;
    onClose: () => void;
}

/**
 * In-Shadow-DOM modal displaying all pre-write `UndoRecord`s (most recent first)
 * with kind/scope badges, before/after summary, timestamp, and idempotent `↩ 撤销` button.
 */
export function UndoHistoryModal({
    open,
    records,
    activeSessionId,
    busyUndoId = null,
    onApplyUndo,
    onClose,
}: UndoHistoryModalProps) {
    const sortedRecords = useMemo(
        () => [...records].sort((a, b) => b.timestamp - a.timestamp),
        [records],
    );

    const activeUndoCount = useMemo(
        () => sortedRecords.filter((rec) => !rec.reverted).length,
        [sortedRecords],
    );

    const currentSessionCount = useMemo(
        () =>
            activeSessionId
                ? sortedRecords.filter((rec) => rec.sessionId === activeSessionId).length
                : 0,
        [activeSessionId, sortedRecords],
    );

    return (
        <ShadowModal
            open={open}
            title={`↩ 写前快照撤销栈 (${activeUndoCount} 项可撤销)`}
            maxWidth="660px"
            onClose={onClose}
            footer={
                <Button variant="secondary" size="sm" onClick={onClose}>
                    关闭
                </Button>
            }
        >
            <div class="ag-undo-list" data-assistant-undo-modal="true">
                {sortedRecords.length === 0 ? (
                    <div class="ag-empty" style={{ minHeight: '160px' }}>
                        <div class="ag-empty-title">暂无写前快照记录</div>
                        <div class="ag-empty-desc">
                            通过调整、写卡或全权管家模式执行写入后，系统将自动保留写前快照供一键还原。
                        </div>
                    </div>
                ) : (
                    <>
                        <div class="ag-banner ag-banner-primary">
                            所有通过调整 / 写卡 /
                            全权管家执行的写入均在执行前留存完整写前快照（当前会话{' '}
                            <strong>{currentSessionCount}</strong> 条，全局{' '}
                            <strong>{sortedRecords.length}</strong> 条）。
                        </div>

                        {sortedRecords.map((record) => {
                            const kindMeta = getUndoKindMeta(record.kind);
                            const isBusy = busyUndoId === record.id;

                            return (
                                <div
                                    key={record.id}
                                    data-undo-record-id={record.id}
                                    data-undo-reverted={record.reverted ? 'true' : 'false'}
                                    class={
                                        record.reverted
                                            ? 'ag-undo-item ag-undo-item-reverted'
                                            : 'ag-undo-item'
                                    }
                                >
                                    <div class="ag-undo-item-header">
                                        <div class="ag-min-w-0" style={{ flex: '1 1 auto' }}>
                                            <div
                                                class="ag-row-wrap"
                                                style={{ gap: '6px', alignItems: 'center' }}
                                            >
                                                <span
                                                    style={{
                                                        fontWeight: 600,
                                                        fontSize: '13px',
                                                        color: 'var(--foreground)',
                                                        wordBreak: 'break-word',
                                                    }}
                                                >
                                                    {record.label}
                                                </span>
                                                <span class={`ag-pill ${kindMeta.pillClass}`}>
                                                    {kindMeta.label}
                                                </span>
                                                <span class="ag-pill ag-pill-muted">
                                                    {record.scope}
                                                </span>
                                                {record.reverted ? (
                                                    <span
                                                        class="ag-pill ag-pill-warning"
                                                        data-undo-reverted-badge={record.id}
                                                    >
                                                        已撤销
                                                    </span>
                                                ) : null}
                                            </div>
                                            <div
                                                class="ag-mono"
                                                style={{
                                                    fontSize: '11px',
                                                    color: 'var(--muted-foreground)',
                                                    marginTop: '3px',
                                                }}
                                            >
                                                {record.toolName} ·{' '}
                                                {formatDetailedTime(record.timestamp)}
                                            </div>
                                        </div>

                                        <button
                                            type="button"
                                            disabled={record.reverted || isBusy}
                                            data-undo-apply-btn={record.id}
                                            class={
                                                record.reverted
                                                    ? 'ag-btn ag-btn-secondary ag-btn-sm'
                                                    : 'ag-btn ag-btn-sm ag-pill-warning'
                                            }
                                            style={{ flexShrink: 0 }}
                                            onClick={() => {
                                                if (!record.reverted && !isBusy) {
                                                    void onApplyUndo(record.id);
                                                }
                                            }}
                                        >
                                            {record.reverted
                                                ? '已撤销'
                                                : isBusy
                                                    ? '撤销中...'
                                                    : '↩ 撤销'}
                                        </button>
                                    </div>

                                    <div class="ag-undo-diff-grid">
                                        <div
                                            class="ag-undo-before"
                                            title={`写前：${record.beforeSummary}`}
                                        >
                                            写前：{record.beforeSummary || '（空）'}
                                        </div>
                                        <div
                                            class="ag-undo-after"
                                            title={`写后：${record.afterSummary}`}
                                        >
                                            写后：{record.afterSummary || '（空）'}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </>
                )}
            </div>
        </ShadowModal>
    );
}
