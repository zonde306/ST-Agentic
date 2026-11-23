import { useState } from 'preact/hooks';
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
    approvalsById,
    undoById,
    busyApprovalId = null,
    busyUndoId = null,
    onDecideApproval,
    onRetryApproval,
    onApplyUndo,
    onPreviewFile,
}: MessageBubbleProps) {
    const [activityExpanded, setActivityExpanded] = useState<boolean>(false);

    if (message.role === 'user') {
        return (
            <div
                class="ag-ast-msg-row ag-ast-msg-row-user"
                data-assistant-message={message.id}
                data-message-role="user"
            >
                <div class="ag-ast-bubble-user">
                    <div class="ag-ast-bubble-content">
                        {renderSimpleMarkdown(message.content)}
                    </div>
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

                <div class="ag-ast-bubble-content" data-assistant-message-content={message.id}>
                    {message.content ? renderSimpleMarkdown(message.content) : null}
                    {isStreaming ? (
                        <span class="ag-ast-streaming-cursor" aria-label="生成中" />
                    ) : null}
                </div>

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
        </div>
    );
}
