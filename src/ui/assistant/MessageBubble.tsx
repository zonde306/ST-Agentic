import type { TargetedKeyboardEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    AssistantMessage,
    AssistantToolCallRecord,
    PendingApproval,
    UndoRecord,
} from '@/core/types';
import { AttachedApprovalCard } from './AttachedApprovalCard';
import {
    formatAssistantTime,
    renderRedactedText,
    renderSimpleMarkdown,
} from './assistant-helpers';

export interface MessageBubbleProps {
    message: AssistantMessage;
    isStreaming?: boolean;
    isLastMessage?: boolean;
    canRegenerate?: boolean;
    isSessionStreaming?: boolean;
    isEditing?: boolean;
    isSyntheticStreaming?: boolean;
    approvalsById: ReadonlyMap<string, PendingApproval>;
    undoById: ReadonlyMap<string, UndoRecord>;
    busyApprovalId?: string | null;
    busyUndoId?: string | null;
    onDecideApproval: (
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ) => void | Promise<void>;
    onRetryApproval: (approvalId: string, feedback?: string) => void | Promise<void>;
    onApplyUndo: (undoId: string) => void | Promise<void>;
    onPreviewFile: (path: string) => void;
    onStartEdit?: (messageId: string) => void;
    onCancelEdit?: () => void;
    onSaveEdit?: (messageId: string, newContent: string) => void | Promise<void>;
    onSaveAndResendEdit?: (messageId: string, newContent: string) => void | Promise<void>;
    onRetract?: (messageId: string) => void | Promise<void>;
    onRegenerate?: () => void | Promise<void>;
    onCopy?: (content: string) => void | Promise<void>;
}

interface ToolCallItemProps {
    toolCall: AssistantToolCallRecord;
    undoRecord: UndoRecord | null;
    busyUndoId?: string | null;
    onApplyUndo: (undoId: string) => void | Promise<void>;
}

function ToolCallItem({ toolCall, undoRecord, busyUndoId, onApplyUndo }: ToolCallItemProps) {
    const [expanded, setExpanded] = useState<boolean>(false);
    const isError = toolCall.status === 'error';

    return (
        <div class="ag-ast-tool-card" data-assistant-tool-call={toolCall.id}>
            <div class="ag-ast-tool-header">
                <button
                    type="button"
                    class="ag-ast-tool-toggle"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((prev) => !prev)}
                >
                    <span
                        class="ag-mono"
                        style={{
                            fontWeight: 600,
                            color: isError ? 'var(--error)' : 'var(--foreground)',
                        }}
                    >
                        {isError ? '✕ ' : ''}
                        {toolCall.name}
                    </span>
                    <span class="ag-pill ag-pill-primary">{toolCall.scopeLabel}</span>
                    {isError ? <span class="ag-pill ag-pill-error">失败</span> : null}
                    {toolCall.hasSecretRedaction ? (
                        <span class="ag-redacted-badge" data-redacted-badge="true">
                            🔒 已脱敏
                        </span>
                    ) : null}
                    <span style={{ fontSize: '10px', color: 'var(--muted-foreground)' }}>
                        {toolCall.durationMs}ms {expanded ? '▾' : '▸'}
                    </span>
                </button>

                {undoRecord ? (
                    <button
                        type="button"
                        disabled={undoRecord.reverted || busyUndoId === undoRecord.id}
                        data-tool-undo-btn={undoRecord.id}
                        class={
                            undoRecord.reverted
                                ? 'ag-btn ag-btn-secondary ag-btn-sm'
                                : 'ag-btn ag-btn-sm ag-pill-warning'
                        }
                        onClick={() => void onApplyUndo(undoRecord.id)}
                    >
                        {undoRecord.reverted ? '✓ 已撤销' : '↩ 撤销'}
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <div class="ag-ast-tool-body">
                    <pre class="ag-ast-tool-pre ag-thin-scroll">
                        Args: {renderRedactedText(toolCall.argsSummary)}
                    </pre>
                    <pre class="ag-ast-tool-pre ag-thin-scroll">
                        {renderRedactedText(toolCall.resultSummary)}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Assistant or User chat bubble, featuring:
 * - Collapsible thinking + tool-call activity strip with redaction badge & quick undo
 * - Safe inline markdown rendering & streaming cursor
 * - Clickable read-only file reference chips
 * - Inline attached approval cards directly inside the AI bubble
 */
export function MessageBubble({
    message,
    isStreaming = false,
    isLastMessage: _isLastMessage = false,
    canRegenerate = false,
    isSessionStreaming = false,
    isEditing = false,
    isSyntheticStreaming = false,
    approvalsById,
    undoById,
    busyApprovalId = null,
    busyUndoId = null,
    onDecideApproval,
    onRetryApproval,
    onApplyUndo,
    onPreviewFile,
    onStartEdit,
    onCancelEdit,
    onSaveEdit,
    onSaveAndResendEdit,
    onRetract,
    onRegenerate,
    onCopy,
}: MessageBubbleProps) {
    const [activityExpanded, setActivityExpanded] = useState<boolean>(false);
    const [editDraft, setEditDraft] = useState<string>(message.content);
    const [copied, setCopied] = useState<boolean>(false);
    const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
    const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const latestContentRef = useRef<string>(message.content);
    latestContentRef.current = message.content;

    useEffect(() => {
        return () => {
            if (copyTimerRef.current) {
                clearTimeout(copyTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!isEditing) {
            return;
        }
        setEditDraft(latestContentRef.current);
        const ta = editTextareaRef.current;
        if (ta) {
            ta.focus();
            const len = ta.value.length;
            try {
                ta.setSelectionRange(len, len);
            } catch {
                // Ignore selection errors in restricted environments.
            }
        }
    }, [isEditing, message.id]);

    const handleCopyClick = async () => {
        await onCopy?.(message.content);
        setCopied(true);
        if (copyTimerRef.current) {
            clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = setTimeout(() => {
            setCopied(false);
        }, 1500);
    };

    const handleEditKeyDown = (event: TargetedKeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancelEdit?.();
            return;
        }
        if (
            (event.ctrlKey || event.metaKey)
            && event.key === 'Enter'
            && !event.isComposing
            && editDraft.trim()
            && !isSessionStreaming
        ) {
            event.preventDefault();
            if (message.role === 'user' && onSaveAndResendEdit) {
                void onSaveAndResendEdit(message.id, editDraft);
            } else if (onSaveEdit) {
                void onSaveEdit(message.id, editDraft);
            }
        }
    };

    const handleEditKeyUp = (event: TargetedKeyboardEvent<HTMLTextAreaElement>) => {
        event.stopPropagation();
    };

    const showActions = !isEditing && !isStreaming && !isSyntheticStreaming;

    if (message.role === 'user') {
        return (
            <div
                class="ag-ast-msg-row ag-ast-msg-row-user"
                data-assistant-message={message.id}
                data-message-role="user"
            >
                <div
                    class={
                        isEditing
                            ? 'ag-ast-msg-col ag-ast-msg-col-user ag-ast-msg-col-editing'
                            : 'ag-ast-msg-col ag-ast-msg-col-user'
                    }
                >
                    {isEditing ? (
                        <div class="ag-ast-edit-box" data-assistant-edit-box={message.id}>
                            <textarea
                                ref={editTextareaRef}
                                class="ag-ast-edit-textarea ag-thin-scroll"
                                data-assistant-edit-input={message.id}
                                aria-label="改写消息内容"
                                value={editDraft}
                                onInput={(e) => setEditDraft(e.currentTarget.value)}
                                onKeyDown={handleEditKeyDown}
                                onKeyUp={handleEditKeyUp}
                            />
                            <div class="ag-ast-edit-actions">
                                <button
                                    type="button"
                                    class="ag-btn ag-btn-ghost ag-btn-sm"
                                    data-assistant-edit-cancel={message.id}
                                    onClick={() => onCancelEdit?.()}
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    class="ag-btn ag-btn-secondary ag-btn-sm"
                                    data-assistant-edit-save={message.id}
                                    disabled={!editDraft.trim() || isSessionStreaming}
                                    onClick={() => void onSaveEdit?.(message.id, editDraft)}
                                >
                                    仅保存
                                </button>
                                <button
                                    type="button"
                                    class="ag-btn ag-btn-primary ag-btn-sm"
                                    data-assistant-edit-resend={message.id}
                                    disabled={!editDraft.trim() || isSessionStreaming}
                                    onClick={() => void onSaveAndResendEdit?.(message.id, editDraft)}
                                >
                                    保存并发送
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div class="ag-ast-bubble-user">
                            <div class="ag-ast-bubble-content" data-assistant-message-content={message.id}>
                                {renderSimpleMarkdown(message.content)}
                            </div>
                        </div>
                    )}

                    {showActions ? (
                        <div
                            class="ag-ast-msg-actions ag-ast-msg-actions-user"
                            data-assistant-msg-actions={message.id}
                        >
                            <button
                                type="button"
                                class="ag-ast-action-btn"
                                data-msg-action="copy"
                                title={copied ? '已复制' : '复制'}
                                aria-label="复制消息"
                                onClick={() => void handleCopyClick()}
                            >
                                {copied ? '✅' : '📋'}
                            </button>
                            <button
                                type="button"
                                class="ag-ast-action-btn"
                                data-msg-action="edit"
                                title="改写消息"
                                aria-label="改写消息"
                                disabled={isSessionStreaming}
                                onClick={() => onStartEdit?.(message.id)}
                            >
                                ✏️
                            </button>
                            {canRegenerate ? (
                                <button
                                    type="button"
                                    class="ag-ast-action-btn"
                                    data-msg-action="regenerate"
                                    title="重新生成"
                                    aria-label="重新生成末尾消息"
                                    disabled={isSessionStreaming}
                                    onClick={() => void onRegenerate?.()}
                                >
                                    🔄
                                </button>
                            ) : null}
                            <button
                                type="button"
                                class="ag-ast-action-btn ag-ast-action-btn-danger"
                                data-msg-action="retract"
                                title="撤回消息"
                                aria-label="撤回消息"
                                disabled={isSessionStreaming}
                                onClick={() => void onRetract?.(message.id)}
                            >
                                ↩️
                            </button>
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }

    const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const hasActivity = Boolean(message.think) || toolCalls.length > 0;
    const totalMs = toolCalls.reduce((sum, tc) => sum + (tc.durationMs || 0), 0);
    const hasRedaction = toolCalls.some((tc) => Boolean(tc.hasSecretRedaction));
    const hasToolError = toolCalls.some((tc) => tc.status === 'error');

    const firstUndoTool = toolCalls.find((tc) => tc.undoId && undoById.has(tc.undoId));
    const quickUndoRecord = firstUndoTool?.undoId
        ? (undoById.get(firstUndoTool.undoId) ?? null)
        : null;

    const approvals: PendingApproval[] = Array.isArray(message.approvalIds)
        ? message.approvalIds
            .map((id) => approvalsById.get(id))
            .filter((item): item is PendingApproval => Boolean(item))
        : [];

    const summaryParts: string[] = [];
    if (message.think) {
        summaryParts.push('已思考');
    }
    if (toolCalls.length > 0) {
        const previewNames = toolCalls
            .map((tc) => tc.name)
            .slice(0, 2)
            .join(', ');
        summaryParts.push(
            `${toolCalls.length} 次工具 (${previewNames}${toolCalls.length > 2 ? '…' : ''})`,
        );
    }
    if (totalMs > 0) {
        summaryParts.push(`${totalMs}ms`);
    }

    const fileRefs = Array.isArray(message.fileRefs) ? message.fileRefs : [];

    return (
        <div
            class="ag-ast-msg-row ag-ast-msg-row-assistant"
            data-assistant-message={message.id}
            data-message-role="assistant"
        >
            <div class="ag-ast-msg-col ag-ast-msg-col-assistant">
                <div class="ag-ast-bubble-assistant">
                    {hasActivity ? (
                        <div class="ag-ast-activity" data-assistant-activity={message.id}>
                            <div class="ag-ast-activity-bar">
                                <button
                                    type="button"
                                    class="ag-ast-activity-toggle"
                                    aria-expanded={activityExpanded}
                                    data-assistant-activity-toggle={message.id}
                                    onClick={() => setActivityExpanded((prev) => !prev)}
                                >
                                    <span
                                        style={{
                                            color: hasToolError ? 'var(--error)' : 'var(--success)',
                                            flexShrink: 0,
                                            fontWeight: 700,
                                        }}
                                    >
                                        {hasToolError ? '!' : '✓'}
                                    </span>
                                    <span class="ag-ast-activity-summary">
                                        {summaryParts.join(' · ')}
                                    </span>
                                    {hasRedaction ? (
                                        <span class="ag-redacted-badge" data-redacted-badge="true">
                                            🔒 已脱敏
                                        </span>
                                    ) : null}
                                    <span style={{ flexShrink: 0, opacity: 0.75 }}>
                                        {activityExpanded ? '▾' : '▸'}
                                    </span>
                                </button>

                                {quickUndoRecord ? (
                                    <button
                                        type="button"
                                        disabled={
                                            quickUndoRecord.reverted
                                            || busyUndoId === quickUndoRecord.id
                                        }
                                        data-activity-undo-btn={quickUndoRecord.id}
                                        class={
                                            quickUndoRecord.reverted
                                                ? 'ag-btn ag-btn-secondary ag-btn-sm'
                                                : 'ag-btn ag-btn-sm ag-pill-warning'
                                        }
                                        onClick={() => void onApplyUndo(quickUndoRecord.id)}
                                    >
                                        {quickUndoRecord.reverted ? '已还原' : '↩ 撤销'}
                                    </button>
                                ) : null}
                            </div>

                            {activityExpanded ? (
                                <div class="ag-ast-activity-body">
                                    {message.think ? (
                                        <div class="ag-ast-think">💭 {message.think}</div>
                                    ) : null}
                                    {toolCalls.map((tc) => (
                                        <ToolCallItem
                                            key={tc.id}
                                            toolCall={tc}
                                            undoRecord={
                                                tc.undoId ? (undoById.get(tc.undoId) ?? null) : null
                                            }
                                            busyUndoId={busyUndoId}
                                            onApplyUndo={onApplyUndo}
                                        />
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {isEditing ? (
                        <div class="ag-ast-edit-box" data-assistant-edit-box={message.id}>
                            <textarea
                                ref={editTextareaRef}
                                class="ag-ast-edit-textarea ag-thin-scroll"
                                data-assistant-edit-input={message.id}
                                aria-label="改写消息内容"
                                value={editDraft}
                                onInput={(e) => setEditDraft(e.currentTarget.value)}
                                onKeyDown={handleEditKeyDown}
                                onKeyUp={handleEditKeyUp}
                            />
                            <div class="ag-ast-edit-actions">
                                <button
                                    type="button"
                                    class="ag-btn ag-btn-ghost ag-btn-sm"
                                    data-assistant-edit-cancel={message.id}
                                    onClick={() => onCancelEdit?.()}
                                >
                                    取消
                                </button>
                                <button
                                    type="button"
                                    class="ag-btn ag-btn-primary ag-btn-sm"
                                    data-assistant-edit-save={message.id}
                                    disabled={!editDraft.trim() || isSessionStreaming}
                                    onClick={() => void onSaveEdit?.(message.id, editDraft)}
                                >
                                    保存改写
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div class="ag-ast-bubble-content" data-assistant-message-content={message.id}>
                            {message.content ? renderSimpleMarkdown(message.content) : null}
                            {isStreaming ? (
                                <span class="ag-ast-streaming-cursor" aria-label="生成中" />
                            ) : null}
                        </div>
                    )}

                    {fileRefs.length > 0 ? (
                        <div class="ag-ast-file-refs">
                            {fileRefs.map((filePath) => (
                                <button
                                    key={filePath}
                                    type="button"
                                    class="ag-ast-file-chip"
                                    title={`预览只读文件：${filePath}`}
                                    onClick={() => onPreviewFile(filePath)}
                                >
                                    📄 {filePath}
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {approvals.length > 0 ? (
                        <div class="ag-ast-approvals-wrap" data-assistant-approvals={message.id}>
                            {approvals.map((approval) => (
                                <AttachedApprovalCard
                                    key={approval.id}
                                    approval={approval}
                                    undoRecord={
                                        approval.undoId
                                            ? (undoById.get(approval.undoId) ?? null)
                                            : null
                                    }
                                    busy={
                                        busyApprovalId === approval.id
                                        || (Boolean(approval.undoId) && busyUndoId === approval.undoId)
                                    }
                                    onDecide={onDecideApproval}
                                    onRetry={onRetryApproval}
                                    onApplyUndo={onApplyUndo}
                                />
                            ))}
                        </div>
                    ) : null}

                    <div class="ag-ast-bubble-footer">
                        <span>
                            {message.usage
                                ? `缓存 ${message.usage.cacheRate} · ${message.usage.outputTokens} tok`
                                : message.interrupted
                                    ? '已手动中止'
                                    : 'Agentic 助手'}
                        </span>
                        <span>
                            {isStreaming
                                ? '生成中...'
                                : message.interrupted
                                    ? '已中止'
                                    : formatAssistantTime(message.timestamp)}
                        </span>
                    </div>
                </div>

                {showActions ? (
                    <div
                        class="ag-ast-msg-actions ag-ast-msg-actions-assistant"
                        data-assistant-msg-actions={message.id}
                    >
                        <button
                            type="button"
                            class="ag-ast-action-btn"
                            data-msg-action="copy"
                            title={copied ? '已复制' : '复制'}
                            aria-label="复制消息"
                            onClick={() => void handleCopyClick()}
                        >
                            {copied ? '✅' : '📋'}
                        </button>
                        {canRegenerate ? (
                            <button
                                type="button"
                                class="ag-ast-action-btn"
                                data-msg-action="regenerate"
                                title="重新生成"
                                aria-label="重新生成末尾消息"
                                disabled={isSessionStreaming}
                                onClick={() => void onRegenerate?.()}
                            >
                                🔄
                            </button>
                        ) : null}
                        <button
                            type="button"
                            class="ag-ast-action-btn"
                            data-msg-action="edit"
                            title="改写消息"
                            aria-label="改写消息"
                            disabled={isSessionStreaming}
                            onClick={() => onStartEdit?.(message.id)}
                        >
                            ✏️
                        </button>
                        <button
                            type="button"
                            class="ag-ast-action-btn ag-ast-action-btn-danger"
                            data-msg-action="retract"
                            title="撤回消息"
                            aria-label="撤回消息"
                            disabled={isSessionStreaming}
                            onClick={() => void onRetract?.(message.id)}
                        >
                            ↩️
                        </button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
