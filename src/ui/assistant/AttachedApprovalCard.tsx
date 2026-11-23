import { useEffect, useRef, useState } from 'preact/hooks';
import type { PendingApproval, UndoRecord } from '@/core/types';
import { renderRedactedText } from './assistant-helpers';

export interface AttachedApprovalCardProps {
    approval: PendingApproval;
    undoRecord?: UndoRecord | null;
    busy?: boolean;
    onDecide: (
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ) => void | Promise<void>;
    onRetry: (approvalId: string, feedback?: string) => void | Promise<void>;
    onApplyUndo: (undoId: string) => void | Promise<void>;
}

/**
 * Inline bubble approval card attached directly to the bottom of an AI message bubble.
 * Enforces the §6.2 auto-collapse rule: once approved or rejected (including after a retry
 * cycle that bumped `revision`), automatically collapses to a single compact status line.
 */
export function AttachedApprovalCard({
    approval,
    undoRecord = null,
    busy = false,
    onDecide,
    onRetry,
    onApplyUndo,
}: AttachedApprovalCardProps) {
    const [detailExpanded, setDetailExpanded] = useState<boolean>(false);
    const [viewMode, setViewMode] = useState<'diff' | 'raw'>('diff');
    const [feedbackText, setFeedbackText] = useState<string>('');

    const prevStateRef = useRef<{ status: PendingApproval['status']; revision: number }>({
        status: approval.status,
        revision: approval.revision,
    });

    // CRITICAL AUTO-COLLAPSE RULE (§6.2):
    // Reset `detailExpanded` to false whenever an approval enters `pending` (e.g. after retry)
    // or transitions into `approved`/`rejected` (including after a retry that bumped revision),
    // ensuring immediate single-line auto-collapse with zero stale expanded state.
    useEffect(() => {
        const prev = prevStateRef.current;
        const statusChanged = prev.status !== approval.status;
        const revisionChanged = prev.revision !== approval.revision;

        if (approval.status === 'pending' && detailExpanded) {
            setDetailExpanded(false);
        } else if ((statusChanged || revisionChanged) && approval.status !== 'pending') {
            setDetailExpanded(false);
        }
        if (revisionChanged && approval.status === 'pending') {
            setFeedbackText('');
        }

        prevStateRef.current = {
            status: approval.status,
            revision: approval.revision,
        };
    }, [approval.status, approval.revision, detailExpanded]);

    const isHighRisk = approval.mandatoryConfirm || approval.riskLevel === 'high';
    const isReverted = Boolean(approval.reverted || undoRecord?.reverted);
    const effectiveUndoId = undoRecord?.id ?? approval.undoId;

    const handleApprove = () => {
        if (busy || approval.status !== 'pending') {
            return;
        }
        setDetailExpanded(false);
        void onDecide(approval.id, 'approve');
    };

    const handleReject = () => {
        if (busy || approval.status !== 'pending') {
            return;
        }
        const trimmed = feedbackText.trim();
        setDetailExpanded(false);
        setFeedbackText('');
        void onDecide(approval.id, 'reject', trimmed || undefined);
    };

    const handleRetry = () => {
        if (busy) {
            return;
        }
        const trimmed = feedbackText.trim();
        setDetailExpanded(false);
        setFeedbackText('');
        void onRetry(approval.id, trimmed || undefined);
    };

    const handleUndo = () => {
        if (busy || isReverted || !effectiveUndoId) {
            return;
        }
        void onApplyUndo(effectiveUndoId);
    };

    // Collapsed 1-line compact bar for accepted / rejected approvals
    if (approval.status !== 'pending' && !detailExpanded) {
        const isRejected = approval.status === 'rejected';
        const collapsedToneClass = isRejected
            ? 'ag-ast-approval-collapsed-rejected'
            : isReverted
                ? 'ag-ast-approval-collapsed-reverted'
                : 'ag-ast-approval-collapsed-approved';
        const iconColor = isRejected
            ? 'var(--error)'
            : isReverted
                ? 'var(--warning)'
                : 'var(--success)';
        const statusPrefix = isRejected
            ? `已拒绝：${approval.title}`
            : isReverted
                ? `已还原：${approval.title}`
                : `已接受：${approval.title}`;

        return (
            <div
                class={`ag-ast-approval-collapsed ${collapsedToneClass}`}
                data-approval-id={approval.id}
                data-approval-status={approval.status}
                data-approval-collapsed="true"
            >
                <div class="ag-ast-approval-collapsed-label">
                    <span style={{ color: iconColor, fontWeight: 700, flexShrink: 0 }}>
                        {isRejected ? '✕' : isReverted ? '↩' : '✓'}
                    </span>
                    <span class="ag-ast-approval-collapsed-text" title={statusPrefix}>
                        {statusPrefix}
                    </span>
                </div>

                <div class="ag-ast-approval-collapsed-actions">
                    <button
                        type="button"
                        data-approval-expand-btn={approval.id}
                        class="ag-btn ag-btn-secondary ag-btn-sm"
                        onClick={() => setDetailExpanded(true)}
                    >
                        详情
                    </button>

                    {isRejected ? (
                        <button
                            type="button"
                            disabled={busy}
                            data-approval-retry-btn={approval.id}
                            class="ag-btn ag-btn-sm ag-pill-primary"
                            onClick={handleRetry}
                        >
                            ↻ 重试
                        </button>
                    ) : effectiveUndoId ? (
                        <button
                            type="button"
                            disabled={busy || isReverted}
                            data-approval-undo-btn={approval.id}
                            class={
                                isReverted
                                    ? 'ag-btn ag-btn-secondary ag-btn-sm'
                                    : 'ag-btn ag-btn-sm ag-pill-warning'
                            }
                            onClick={handleUndo}
                        >
                            {isReverted ? '已还原' : '↩ 撤销'}
                        </button>
                    ) : null}
                </div>
            </div>
        );
    }

    const cardBorderClass =
        approval.status === 'pending'
            ? isHighRisk
                ? 'ag-ast-approval-high'
                : 'ag-ast-approval-medium'
            : '';

    return (
        <div
            class={cardBorderClass ? `ag-ast-approval-card ${cardBorderClass}` : 'ag-ast-approval-card'}
            data-approval-id={approval.id}
            data-approval-status={approval.status}
            data-approval-collapsed="false"
        >
            <div class="ag-ast-approval-header">
                <div class="ag-ast-approval-title-row">
                    {isHighRisk ? (
                        <span
                            class="ag-pill ag-pill-error"
                            data-approval-mandatory="true"
                            style={{ flexShrink: 0 }}
                        >
                            🔒 强制确认
                        </span>
                    ) : null}
                    <span class="ag-ast-approval-title" title={approval.title}>
                        {approval.title}
                    </span>
                </div>

                <div class="ag-row" style={{ gap: '6px', flexShrink: 0 }}>
                    <div
                        class="ag-ast-approval-view-tabs"
                        role="tablist"
                        aria-label="变更预览模式"
                    >
                        <button
                            type="button"
                            role="tab"
                            aria-selected={viewMode === 'diff'}
                            data-approval-view-tab="diff"
                            class={
                                viewMode === 'diff'
                                    ? 'ag-ast-approval-view-tab ag-ast-approval-view-tab-active'
                                    : 'ag-ast-approval-view-tab'
                            }
                            onClick={() => setViewMode('diff')}
                        >
                            Diff
                        </button>
                        <button
                            type="button"
                            role="tab"
                            aria-selected={viewMode === 'raw'}
                            data-approval-view-tab="raw"
                            class={
                                viewMode === 'raw'
                                    ? 'ag-ast-approval-view-tab ag-ast-approval-view-tab-active'
                                    : 'ag-ast-approval-view-tab'
                            }
                            onClick={() => setViewMode('raw')}
                        >
                            原文
                        </button>
                    </div>

                    {approval.status !== 'pending' ? (
                        <button
                            type="button"
                            data-approval-collapse-btn={approval.id}
                            class="ag-btn ag-btn-secondary ag-btn-sm"
                            onClick={() => setDetailExpanded(false)}
                        >
                            收起
                        </button>
                    ) : null}
                </div>
            </div>

            {(approval.summary || approval.targetLabel) ? (
                <div
                    class="ag-row-wrap"
                    style={{
                        fontSize: '11px',
                        color: 'var(--muted-foreground)',
                        gap: '6px',
                    }}
                >
                    {approval.targetLabel ? (
                        <span class="ag-pill ag-pill-muted">{approval.targetLabel}</span>
                    ) : null}
                    {approval.summary ? <span>{approval.summary}</span> : null}
                </div>
            ) : null}

            {viewMode === 'diff' ? (
                <div class="ag-diff-box ag-thin-scroll" data-approval-diff="true">
                    {approval.diffLines.length > 0 ? (
                        approval.diffLines.map((line, idx) => {
                            const lineClass =
                                line.type === 'add'
                                    ? 'ag-diff-line ag-diff-line-add'
                                    : line.type === 'del'
                                        ? 'ag-diff-line ag-diff-line-del'
                                        : 'ag-diff-line ag-diff-line-ctx';
                            return (
                                <div key={`${approval.id}-diff-${idx}`} class={lineClass}>
                                    {renderRedactedText(line.text)}
                                </div>
                            );
                        })
                    ) : (
                        <div class="ag-diff-line ag-diff-line-ctx">
                            {renderRedactedText(approval.rawContent || '（无差异预览）')}
                        </div>
                    )}
                </div>
            ) : (
                <pre class="ag-ast-tool-pre ag-thin-scroll" data-approval-raw="true">
                    {renderRedactedText(approval.rawContent)}
                </pre>
            )}

            {approval.status === 'pending' ? (
                <>
                    <input
                        type="text"
                        class="ag-input"
                        data-approval-feedback-input={approval.id}
                        aria-label="重试修改意见（可选）"
                        placeholder="可选：补充修改意见，点击「↻ 重试」重新生成..."
                        value={feedbackText}
                        disabled={busy}
                        onInput={(e) => setFeedbackText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                        }}
                        onKeyUp={(e) => {
                            e.stopPropagation();
                        }}
                    />

                    <div class="ag-ast-approval-actions">
                        <span class="ag-ast-approval-tool">
                            {approval.toolName}
                            {approval.revision > 1 ? ` · 第 ${approval.revision} 版` : ''}
                        </span>

                        <div class="ag-ast-approval-btn-group">
                            <button
                                type="button"
                                disabled={busy}
                                data-approval-retry-btn={approval.id}
                                class="ag-btn ag-btn-secondary ag-btn-sm"
                                onClick={handleRetry}
                            >
                                ↻ 重试
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                data-approval-reject-btn={approval.id}
                                class="ag-btn ag-btn-danger ag-btn-sm"
                                onClick={handleReject}
                            >
                                ✕ 拒绝
                            </button>
                            <button
                                type="button"
                                disabled={busy}
                                data-approval-approve-btn={approval.id}
                                class={
                                    isHighRisk
                                        ? 'ag-btn ag-btn-sm'
                                        : 'ag-btn ag-btn-primary ag-btn-sm'
                                }
                                style={
                                    isHighRisk
                                        ? {
                                            background: 'var(--error)',
                                            color: '#ffffff',
                                            borderColor: 'transparent',
                                            fontWeight: 600,
                                        }
                                        : { fontWeight: 600 }
                                }
                                onClick={handleApprove}
                            >
                                ✓ 接受
                            </button>
                        </div>
                    </div>
                </>
            ) : approval.status === 'rejected' ? (
                <div class="ag-stack-v" style={{ gap: '8px' }}>
                    <input
                        type="text"
                        class="ag-input"
                        data-approval-feedback-input={approval.id}
                        aria-label="重试修改意见（可选）"
                        placeholder="可选：补充修改意见，点击「↻ 重试生成方案」..."
                        value={feedbackText}
                        disabled={busy}
                        onInput={(e) => setFeedbackText(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                        }}
                        onKeyUp={(e) => {
                            e.stopPropagation();
                        }}
                    />
                    <div class="ag-row" style={{ justifyContent: 'flex-end' }}>
                        <button
                            type="button"
                            disabled={busy}
                            data-approval-retry-btn={approval.id}
                            class="ag-btn ag-btn-sm ag-pill-primary"
                            onClick={handleRetry}
                        >
                            ↻ 重试生成方案
                        </button>
                    </div>
                </div>
            ) : effectiveUndoId ? (
                <div class="ag-row" style={{ justifyContent: 'space-between' }}>
                    <span class="ag-ast-approval-tool">
                        {isReverted ? '已还原写前快照' : '已接受并生成写前快照'}
                    </span>
                    <button
                        type="button"
                        disabled={busy || isReverted}
                        data-approval-undo-btn={approval.id}
                        class={
                            isReverted
                                ? 'ag-btn ag-btn-secondary ag-btn-sm'
                                : 'ag-btn ag-btn-sm ag-pill-warning'
                        }
                        onClick={handleUndo}
                    >
                        {isReverted ? '已还原' : '↩ 撤销'}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
