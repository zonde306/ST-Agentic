import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AssistantMessage, UndoRecord } from '@/core/types';
import { MarkdownContent } from '@/ui/components';
import {
    IconAlertTriangle,
    IconBolt,
    IconBookOpen,
    IconBot,
    IconCheck,
    IconChevronRight,
    IconCode,
    IconDatabase,
    IconEdit,
    IconFileText,
    IconFilter,
    IconFolder,
    IconImport,
    IconLayers,
    IconMessage,
    IconPlug,
    IconSearch,
    IconTerminal,
    IconUndo,
    IconWrench,
} from '@/ui/components/Icons';
import {
    extractPrimaryArg,
    formatDurationShort,
    getToolDisplay,
    type ActivityTimelineData,
    type TimelineStep,
    type TimelineToolCall,
    type TimelineToolGroup,
    type ToolIconKind,
} from './activity-timeline-model';
import { renderRedactedText } from './assistant-helpers';

function ToolIcon({ kind, size = 14 }: { kind: ToolIconKind; size?: number }) {
    switch (kind) {
        case 'file':
            return <IconFileText size={size} />;
        case 'edit':
            return <IconEdit size={size} />;
        case 'folder':
            return <IconFolder size={size} />;
        case 'search':
            return <IconSearch size={size} />;
        case 'chat':
            return <IconMessage size={size} />;
        case 'data':
            return <IconDatabase size={size} />;
        case 'card':
            return <IconBot size={size} />;
        case 'regex':
            return <IconFilter size={size} />;
        case 'script':
            return <IconCode size={size} />;
        case 'book':
            return <IconBookOpen size={size} />;
        case 'preset':
            return <IconLayers size={size} />;
        case 'terminal':
            return <IconTerminal size={size} />;
        case 'import':
            return <IconImport size={size} />;
        case 'plug':
            return <IconPlug size={size} />;
        case 'agentic':
            return <IconBolt size={size} />;
        case 'settings':
        case 'tool':
        default:
            return <IconWrench size={size} />;
    }
}

function toggleInSet(prev: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(prev);
    if (next.has(key)) {
        next.delete(key);
    } else {
        next.add(key);
    }
    return next;
}

function StateDot({ state }: { state: TimelineToolCall['state'] }) {
    if (state === 'running') {
        return <span class="ag-ast-tl-spinner" aria-label="执行中" />;
    }
    return <span class="ag-ast-tl-dot" data-state={state} aria-hidden="true" />;
}

interface ToolRowProps {
    call: TimelineToolCall;
    nested?: boolean;
    open: boolean;
    onToggle: () => void;
    undoRecord: UndoRecord | null;
    busyUndoId: string | null;
    onApplyUndo: (undoId: string) => void | Promise<void>;
}

function ToolRow({ call, nested, open, onToggle, undoRecord, busyUndoId, onApplyUndo }: ToolRowProps) {
    const record = call.record;
    const display = record ? getToolDisplay(record.name) : null;
    const arg = record ? extractPrimaryArg(record.argsSummary) || record.scopeLabel : '';
    let meta: string;
    if (call.state === 'running') {
        meta = '执行中';
    } else if (call.state === 'pending') {
        meta = '未完成';
    } else {
        meta = formatDurationShort(record?.durationMs ?? 0);
    }
    const verb = display ? display.verb : call.state === 'running' ? '正在执行工具' : '工具调用';

    return (
        <div
            class={nested ? 'ag-ast-tl-tool ag-ast-tl-tool-nested' : 'ag-ast-tl-tool'}
            data-assistant-tool-call={call.id}
            data-state={call.state}
        >
            <div class="ag-ast-tl-tool-line">
                <button
                    type="button"
                    class="ag-ast-tool-toggle ag-ast-tl-tool-row"
                    aria-expanded={open}
                    disabled={!record}
                    title={record ? `${record.name} · ${record.scopeLabel}` : undefined}
                    onClick={onToggle}
                >
                    <span class="ag-ast-tl-tool-icon" aria-hidden="true">
                        <ToolIcon kind={display?.icon ?? 'tool'} />
                    </span>
                    {nested ? null : (
                        <span
                            class={
                                call.state === 'running'
                                    ? 'ag-ast-tl-tool-verb ag-ast-tl-shimmer'
                                    : 'ag-ast-tl-tool-verb'
                            }
                        >
                            {verb}
                        </span>
                    )}
                    {arg ? (
                        <span class="ag-ast-tl-tool-arg ag-mono">{renderRedactedText(arg)}</span>
                    ) : null}
                    {record?.hasSecretRedaction ? (
                        <span class="ag-redacted-badge" data-redacted-badge="true">
                            🔒 已脱敏
                        </span>
                    ) : null}
                    <span class="ag-ast-tl-tool-meta">
                        <span class="ag-ast-tl-tool-ms">{meta}</span>
                        <StateDot state={call.state} />
                    </span>
                </button>
                {undoRecord ? (
                    <button
                        type="button"
                        class="ag-ast-tl-undo"
                        data-tool-undo-btn={undoRecord.id}
                        data-reverted={undoRecord.reverted ? 'true' : 'false'}
                        disabled={undoRecord.reverted || busyUndoId === undoRecord.id}
                        title={undoRecord.reverted ? '已撤销' : '撤销此操作'}
                        aria-label={undoRecord.reverted ? '已撤销' : '撤销此操作'}
                        onClick={() => void onApplyUndo(undoRecord.id)}
                    >
                        {undoRecord.reverted ? <IconCheck size={13} /> : <IconUndo size={13} />}
                        <span>{undoRecord.reverted ? '已撤销' : '撤销'}</span>
                    </button>
                ) : null}
            </div>
            {open && record ? (
                <div class="ag-ast-tl-tool-detail">
                    <div class="ag-ast-tl-tool-detail-head">
                        <span class="ag-mono">{record.name}</span>
                        <span class="ag-pill">{record.scopeLabel}</span>
                    </div>
                    <pre class="ag-ast-tool-pre ag-thin-scroll">
                        Args: {renderRedactedText(record.argsSummary)}
                    </pre>
                    <pre
                        class="ag-ast-tool-pre ag-thin-scroll"
                        data-tone={record.status === 'error' ? 'error' : undefined}
                    >
                        {renderRedactedText(record.resultSummary)}
                    </pre>
                </div>
            ) : null}
        </div>
    );
}

interface StepNodeProps {
    step: TimelineStep;
    index: number;
    thinkOpen: boolean;
    onToggleThink: () => void;
    renderGroup: (group: TimelineToolGroup) => ComponentChildren;
}

function StepNode({ step, index, thinkOpen, onToggleThink, renderGroup }: StepNodeProps) {
    const stillThinking = step.isLive && step.toolCount === 0 && !step.preface;
    let timeLabel = '';
    if (typeof step.thinkMs === 'number') {
        timeLabel = `思考 ${formatDurationShort(step.thinkMs)}`;
    } else if (stillThinking) {
        timeLabel = '思考中…';
    }
    const canExpandBody = Boolean(step.body) && !stillThinking;

    return (
        <li
            class="ag-ast-tl-step"
            data-assistant-activity-step={step.id}
            data-live={step.isLive ? 'true' : 'false'}
            data-error={step.hasError ? 'true' : 'false'}
        >
            <span class="ag-ast-tl-node" aria-hidden="true">
                {step.isLive ? (
                    <span class="ag-ast-tl-spinner" />
                ) : step.hasError ? (
                    '!'
                ) : (
                    index + 1
                )}
            </span>
            <div class="ag-ast-tl-step-main">
                <button
                    type="button"
                    class="ag-ast-tl-step-head"
                    aria-expanded={canExpandBody ? thinkOpen : undefined}
                    disabled={!canExpandBody}
                    onClick={onToggleThink}
                >
                    <span
                        class={
                            stillThinking
                                ? 'ag-ast-tl-step-title ag-ast-tl-shimmer'
                                : 'ag-ast-tl-step-title'
                        }
                    >
                        {step.title}
                    </span>
                    {timeLabel ? <span class="ag-ast-tl-step-time">{timeLabel}</span> : null}
                </button>
                {stillThinking && step.think ? (
                    <div class="ag-ast-tl-live-think">
                        <div class="ag-ast-tl-live-think-inner">{step.think}</div>
                    </div>
                ) : step.body ? (
                    <div class="ag-ast-tl-think" data-clamped={thinkOpen ? 'false' : 'true'}>
                        {step.body}
                    </div>
                ) : null}
                {step.preface ? (
                    <div class="ag-ast-tl-preface ag-ast-bubble-markdown">
                        <MarkdownContent content={step.preface} />
                    </div>
                ) : null}
                {step.groups.length > 0 ? (
                    <div class="ag-ast-tl-tools">{step.groups.map((g) => renderGroup(g))}</div>
                ) : null}
            </div>
        </li>
    );
}

export interface ActivityTimelineProps {
    message: AssistantMessage;
    timeline: ActivityTimelineData;
    isStreaming: boolean;
    undoById: ReadonlyMap<string, UndoRecord>;
    busyUndoId: string | null;
    onApplyUndo: (undoId: string) => void | Promise<void>;
}

/**
 * Per-round activity timeline (design: think -> preface -> tools for each model round).
 * Collapsed to a single summary row by default; auto-expands while the model is still
 * thinking / calling tools, and folds back once the final reply starts streaming.
 */
export function ActivityTimeline({
    message,
    timeline,
    isStreaming,
    undoById,
    busyUndoId,
    onApplyUndo,
}: ActivityTimelineProps) {
    const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
    const [openThink, setOpenThink] = useState<ReadonlySet<string>>(() => new Set());
    const [openTools, setOpenTools] = useState<ReadonlySet<string>>(() => new Set());
    const [groupOverrides, setGroupOverrides] = useState<ReadonlyMap<string, boolean>>(
        () => new Map(),
    );
    const [now, setNow] = useState<number>(() => Date.now());

    useEffect(() => {
        if (!isStreaming) {
            return undefined;
        }
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [isStreaming]);

    const { steps, livePhase } = timeline;
    const autoExpanded = isStreaming && livePhase !== 'replying';
    const expanded = userExpanded ?? autoExpanded;

    const allRecords = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const quickUndoTool = allRecords.find((tc) => tc.undoId && undoById.has(tc.undoId));
    const quickUndoRecord = quickUndoTool?.undoId ? (undoById.get(quickUndoTool.undoId) ?? null) : null;

    const metaParts: string[] = [];
    let headline: string;
    let headlineDetail = '';
    let tone: 'live' | 'ok' | 'warning';
    if (livePhase) {
        tone = 'live';
        const roundLabel = `第 ${Math.max(1, steps.length)} 轮`;
        if (livePhase === 'tools') {
            headline = '正在调用工具';
            metaParts.push(roundLabel, `${timeline.liveDoneTools}/${timeline.liveTotalTools}`);
        } else if (livePhase === 'replying') {
            headline = '正在回复';
            if (timeline.toolCount > 0) {
                metaParts.push(`${timeline.toolCount} 次工具`);
            }
        } else {
            headline = '正在思考';
            const liveStep = steps[steps.length - 1];
            if (liveStep && liveStep.toolCount === 0 && liveStep.title && liveStep.think) {
                headlineDetail = liveStep.title;
            }
            metaParts.push(roundLabel);
        }
        metaParts.push(formatDurationShort(Math.max(0, now - message.timestamp)));
    } else {
        tone = timeline.errorCount > 0 ? 'warning' : 'ok';
        const hasThink = steps.some((s) => s.think);
        if (timeline.hasThinkTiming && timeline.totalThinkMs > 0) {
            headline = `已思考 ${formatDurationShort(timeline.totalThinkMs)}`;
        } else {
            headline = hasThink ? '已思考' : '已处理';
        }
        if (steps.length > 1) {
            metaParts.push(`${steps.length} 轮`);
        }
        if (timeline.toolCount > 0) {
            metaParts.push(`${timeline.toolCount} 次工具`);
        }
    }

    const isGroupOpen = (group: TimelineToolGroup): boolean => {
        const override = groupOverrides.get(group.key);
        if (override !== undefined) {
            return override;
        }
        return group.calls.some(
            (c) => c.state === 'error' || c.state === 'running' || Boolean(c.record?.hasSecretRedaction),
        );
    };

    const renderToolRow = (call: TimelineToolCall, nested: boolean) => (
        <ToolRow
            key={call.id}
            call={call}
            nested={nested}
            open={openTools.has(call.id)}
            onToggle={() => setOpenTools((prev) => toggleInSet(prev, call.id))}
            undoRecord={call.record?.undoId ? (undoById.get(call.record.undoId) ?? null) : null}
            busyUndoId={busyUndoId}
            onApplyUndo={onApplyUndo}
        />
    );

    const renderGroup = (group: TimelineToolGroup) => {
        if (group.calls.length === 1) {
            return renderToolRow(group.calls[0], false);
        }
        const open = isGroupOpen(group);
        const first = group.calls[0].record;
        const display = getToolDisplay(group.name);
        const totalMs = group.calls.reduce((sum, c) => sum + (c.record?.durationMs ?? 0), 0);
        const groupState: TimelineToolCall['state'] = group.calls.some((c) => c.state === 'running')
            ? 'running'
            : group.calls.some((c) => c.state === 'error')
              ? 'error'
              : group.calls.some((c) => c.state === 'pending')
                ? 'pending'
                : 'ok';
        return (
            <div key={group.key} class="ag-ast-tl-group" data-assistant-tool-group={group.key}>
                <button
                    type="button"
                    class="ag-ast-tl-tool-row ag-ast-tl-group-head"
                    aria-expanded={open}
                    title={first ? `${first.name} · ${first.scopeLabel}` : undefined}
                    onClick={() =>
                        setGroupOverrides((prev) => {
                            const next = new Map(prev);
                            next.set(group.key, !open);
                            return next;
                        })
                    }
                >
                    <span class="ag-ast-tl-tool-icon" aria-hidden="true">
                        <ToolIcon kind={display.icon} />
                    </span>
                    <span class="ag-ast-tl-tool-verb">
                        {display.verb}
                        <span class="ag-ast-tl-tool-count">×{group.calls.length}</span>
                    </span>
                    <span class="ag-ast-tl-tool-arg">
                        {open ? '' : group.calls
                            .map((c) => (c.record ? extractPrimaryArg(c.record.argsSummary) : ''))
                            .filter(Boolean)
                            .join(' · ')}
                    </span>
                    <span class="ag-ast-tl-tool-meta">
                        <span class="ag-ast-tl-tool-ms">
                            {groupState === 'running' ? '执行中' : formatDurationShort(totalMs)}
                        </span>
                        <StateDot state={groupState} />
                        <span class="ag-ast-tl-chevron" data-open={open ? 'true' : 'false'}>
                            <IconChevronRight size={12} />
                        </span>
                    </span>
                </button>
                {open ? (
                    <div class="ag-ast-tl-group-children">
                        {group.calls.map((c) => renderToolRow(c, true))}
                    </div>
                ) : null}
            </div>
        );
    };

    return (
        <div
            class="ag-ast-tl"
            data-assistant-activity={message.id}
            data-expanded={expanded ? 'true' : 'false'}
            data-tone={tone}
        >
            <div class="ag-ast-tl-bar">
                <button
                    type="button"
                    class="ag-ast-tl-summary"
                    aria-expanded={expanded}
                    data-assistant-activity-toggle={message.id}
                    onClick={() => setUserExpanded(!expanded)}
                >
                    <span class="ag-ast-tl-status" data-tone={tone} aria-hidden="true">
                        {tone === 'live' ? (
                            <span class="ag-ast-tl-spinner" />
                        ) : tone === 'warning' ? (
                            <IconAlertTriangle size={13} />
                        ) : (
                            <IconCheck size={13} />
                        )}
                    </span>
                    <span
                        class={
                            tone === 'live'
                                ? 'ag-ast-tl-headline ag-ast-tl-shimmer'
                                : 'ag-ast-tl-headline'
                        }
                    >
                        {headline}
                    </span>
                    {headlineDetail ? (
                        <span class="ag-ast-tl-headline-detail">{headlineDetail}</span>
                    ) : null}
                    {metaParts.length > 0 ? (
                        <span class="ag-ast-tl-meta">{metaParts.join(' · ')}</span>
                    ) : null}
                    {timeline.errorCount > 0 ? (
                        <span class="ag-ast-tl-badge" data-tone="error">
                            {timeline.errorCount} 次失败
                        </span>
                    ) : null}
                    {timeline.hasRedaction ? (
                        <span class="ag-redacted-badge" data-redacted-badge="true">
                            🔒 已脱敏
                        </span>
                    ) : null}
                    <span class="ag-ast-tl-chevron" data-open={expanded ? 'true' : 'false'}>
                        <IconChevronRight size={14} />
                    </span>
                </button>
                {quickUndoRecord ? (
                    <button
                        type="button"
                        class="ag-ast-tl-undo"
                        data-activity-undo-btn={quickUndoRecord.id}
                        data-reverted={quickUndoRecord.reverted ? 'true' : 'false'}
                        disabled={quickUndoRecord.reverted || busyUndoId === quickUndoRecord.id}
                        onClick={() => void onApplyUndo(quickUndoRecord.id)}
                    >
                        {quickUndoRecord.reverted ? <IconCheck size={13} /> : <IconUndo size={13} />}
                        <span>{quickUndoRecord.reverted ? '已还原' : '撤销'}</span>
                    </button>
                ) : null}
            </div>

            {expanded ? (
                <ol class="ag-ast-tl-steps">
                    {steps.map((step, idx) => (
                        <StepNode
                            key={step.id}
                            step={step}
                            index={idx}
                            thinkOpen={openThink.has(step.id)}
                            onToggleThink={() => setOpenThink((prev) => toggleInSet(prev, step.id))}
                            renderGroup={renderGroup}
                        />
                    ))}
                </ol>
            ) : null}
        </div>
    );
}
