import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
    AgentRunTrace,
    CanonicalToolCall,
    PipelinePhase,
    ToolStepLog,
} from '@/core/types';
import {
    Badge,
    Button,
    EmptyState,
    MasterDetailLayout,
    SegmentedControl,
    SelectInput,
    TextInput,
} from '@/ui/components';
import {
    IconAlertTriangle,
    IconCheck,
    IconCopy,
    IconRefresh,
    IconTerminal,
    IconTrash,
} from '@/ui/components/Icons';
import type { ConsoleViewProps } from '@/ui/store';
import {
    computeCacheHitPercent,
    copyTextToClipboard,
    formatDurationMs,
    formatTimestamp,
    formatTokenCount,
    getPhaseLabel,
    getRunStatusMeta,
    useStoreSlice,
} from './shared';

type PhaseFilter = 'all' | PipelinePhase;
type DetailViewTab = 'steps' | 'raw';

const PHASE_OPTIONS: readonly { value: PhaseFilter; label: string }[] = [
    { value: 'all', label: '全部阶段' },
    { value: 'before_turn', label: 'before_turn · 前置' },
    { value: 'main_turn', label: 'main_turn · 主生成' },
    { value: 'after_turn', label: 'after_turn · 后置' },
    { value: 'maintenance', label: 'maintenance · 维护' },
];

function formatJsonBlock(value: unknown): string {
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return value;
        }
    }
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

function extractToolCallsFromTrace(trace: AgentRunTrace): {
    fromMessages: Array<{ messageIndex: number; toolCalls: CanonicalToolCall[] }>;
    fromSteps: Array<{
        stepIndex: number;
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown> | string;
        ok: boolean;
    }>;
} {
    const fromMessages: Array<{ messageIndex: number; toolCalls: CanonicalToolCall[] }> = [];
    const messages = trace.requestSnapshot?.messages ?? [];
    messages.forEach((msg, index) => {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
            fromMessages.push({
                messageIndex: index,
                toolCalls: msg.toolCalls,
            });
        }
    });

    const fromSteps = trace.toolSteps.map((step) => ({
        stepIndex: step.stepIndex,
        toolCallId: step.toolCallId,
        toolName: step.toolName,
        args: step.args,
        ok: step.ok,
    }));

    return { fromMessages, fromSteps };
}

function matchesSearch(trace: AgentRunTrace, query: string): boolean {
    if (!query) {
        return true;
    }
    const q = query.toLowerCase();
    if (
        trace.agentName.toLowerCase().includes(q)
        || trace.agentProfileId.toLowerCase().includes(q)
        || trace.model.toLowerCase().includes(q)
        || trace.runId.toLowerCase().includes(q)
        || (trace.triggerLabel?.toLowerCase().includes(q) ?? false)
        || (trace.outputPreview?.toLowerCase().includes(q) ?? false)
        || (trace.error?.toLowerCase().includes(q) ?? false)
        || `#${trace.target.messageId}`.includes(q)
    ) {
        return true;
    }
    return trace.toolSteps.some(
        (step) =>
            step.toolName.toLowerCase().includes(q)
            || step.result.toLowerCase().includes(q)
            || (step.error?.toLowerCase().includes(q) ?? false)
            || formatJsonBlock(step.args).toLowerCase().includes(q),
    );
}

export function LogsView({ store, isMobile }: ConsoleViewProps) {
    const traces = useStoreSlice(store, (s) => s.traces);
    const deepLink = useStoreSlice(store, (s) => s.deepLink);

    const [messageFilter, setMessageFilter] = useState<string>(() =>
        deepLink.messageId !== undefined ? String(deepLink.messageId) : 'all',
    );
    const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedRunId, setSelectedRunId] = useState<string | null>(
        () => deepLink.logId ?? traces[0]?.runId ?? null,
    );
    const [highlightedStepIndex, setHighlightedStepIndex] = useState<number | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [detailTab, setDetailTab] = useState<DetailViewTab>('steps');
    const [refreshing, setRefreshing] = useState(false);

    const lastDeepLinkSigRef = useRef<string>('');
    const didAutoLoadRef = useRef(false);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await store.refreshTraces();
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`刷新日志失败：${msg}`, 'error');
        } finally {
            setRefreshing(false);
        }
    }, [store]);

    // Only auto-fetch if store has no traces yet (preserves explicit `initialTraces` fixtures).
    useEffect(() => {
        if (didAutoLoadRef.current) {
            return;
        }
        didAutoLoadRef.current = true;
        if (traces.length === 0) {
            void handleRefresh();
        }
    }, [handleRefresh, traces.length]);

    // Sync filter and selection whenever capsule or wand menu deep-links into LogsView.
    useEffect(() => {
        const sig = JSON.stringify({
            messageId: deepLink.messageId,
            swipeId: deepLink.swipeId,
            logId: deepLink.logId,
        });
        if (sig === lastDeepLinkSigRef.current) {
            return;
        }
        lastDeepLinkSigRef.current = sig;

        if (deepLink.messageId !== undefined) {
            setMessageFilter(String(deepLink.messageId));
        }
        if (deepLink.logId) {
            setSelectedRunId(deepLink.logId);
            setHighlightedStepIndex(null);
            setDetailOpen(true);
        } else if (deepLink.messageId !== undefined) {
            const matched = traces.find(
                (t) =>
                    t.target.messageId === deepLink.messageId
                    && (deepLink.swipeId === undefined || t.target.swipeId === deepLink.swipeId),
            );
            if (matched) {
                setSelectedRunId(matched.runId);
                setHighlightedStepIndex(null);
                setDetailOpen(true);
            }
        }
    }, [deepLink.logId, deepLink.messageId, deepLink.swipeId, traces]);

    const distinctFloors = useMemo(() => {
        const seen = new Set<number>();
        for (const trace of traces) {
            seen.add(trace.target.messageId);
        }
        return Array.from(seen).sort((a, b) => b - a);
    }, [traces]);

    const filteredTraces = useMemo(() => {
        const floorText = messageFilter.trim().replace(/^#/, '');
        const parsedFloor =
            floorText && floorText !== 'all' && /^\d+$/.test(floorText)
                ? Number(floorText)
                : null;

        return traces.filter((trace) => {
            if (parsedFloor !== null && trace.target.messageId !== parsedFloor) {
                return false;
            }
            if (phaseFilter !== 'all' && trace.phase !== phaseFilter) {
                return false;
            }
            return matchesSearch(trace, searchQuery.trim());
        });
    }, [messageFilter, phaseFilter, searchQuery, traces]);

    const selectedTrace = useMemo(
        () =>
            filteredTraces.find((t) => t.runId === selectedRunId)
            ?? filteredTraces[0]
            ?? null,
        [filteredTraces, selectedRunId],
    );

    const handleSelectRun = (runId: string, stepIndex: number | null = null) => {
        setSelectedRunId(runId);
        setHighlightedStepIndex(stepIndex);
        if (stepIndex !== null) {
            setDetailTab('steps');
        }
        setDetailOpen(true);
    };

    const handleClearTraces = async () => {
        if (!store.services.clearTraces) {
            return;
        }
        try {
            await store.services.clearTraces();
            store.setTraces([]);
            setSelectedRunId(null);
            store.pushToast('已清空内存运行日志', 'warning');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`清空日志失败：${msg}`, 'error');
        }
    };

    const handleCopyPayload = async (label: string, value: unknown) => {
        const json = formatJsonBlock(value);
        const ok = await copyTextToClipboard(json);
        store.pushToast(
            ok ? `已复制 ${label} 到剪贴板` : '剪贴板不可用，复制失败',
            ok ? 'success' : 'warning',
        );
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px', gap: '10px' }}>
            <div class="ag-row-wrap" style={{ gap: '6px', justifyContent: 'space-between' }}>
                <div class="ag-row-wrap" style={{ gap: '6px' }}>
                    <Button
                        size="sm"
                        variant={messageFilter === 'all' ? 'primary' : 'secondary'}
                        active={messageFilter === 'all'}
                        onClick={() => setMessageFilter('all')}
                    >
                        全部楼层
                    </Button>
                    {distinctFloors.slice(0, 6).map((floor) => {
                        const floorStr = String(floor);
                        const active = messageFilter === floorStr;
                        return (
                            <Button
                                key={floor}
                                size="sm"
                                variant={active ? 'primary' : 'secondary'}
                                active={active}
                                onClick={() => setMessageFilter(floorStr)}
                            >
                                #{floor}
                            </Button>
                        );
                    })}
                </div>
                <div class="ag-row" style={{ gap: '4px' }}>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconRefresh size={14} />}
                        ariaLabel="刷新日志"
                        title="刷新日志"
                        loading={refreshing}
                        onClick={() => void handleRefresh()}
                    />
                    {store.services.clearTraces ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            icon={<IconTrash size={14} />}
                            ariaLabel="清空日志"
                            title="清空日志"
                            onClick={() => void handleClearTraces()}
                        />
                    ) : null}
                </div>
            </div>

            <div class="ag-grid-2" style={{ gap: '6px' }}>
                <TextInput
                    type="search"
                    value={messageFilter === 'all' ? '' : messageFilter}
                    placeholder="按 #messageId 过滤 (如 12)"
                    ariaLabel="按消息楼层 ID 过滤"
                    onInput={(val) => setMessageFilter(val.trim() ? val : 'all')}
                />
                <SelectInput<PhaseFilter>
                    ariaLabel="按执行阶段过滤"
                    value={phaseFilter}
                    options={PHASE_OPTIONS}
                    onChange={setPhaseFilter}
                />
            </div>

            <TextInput
                type="search"
                value={searchQuery}
                placeholder="全局搜索 Agent / 模型 / 工具名 / 输出..."
                ariaLabel="全局搜索生成日志"
                onInput={setSearchQuery}
            />

            {filteredTraces.length === 0 ? (
                <EmptyState
                    icon={<IconTerminal size={20} />}
                    title="暂无匹配的生成或工具日志"
                    description="请尝试切换楼层/阶段筛选，或在聊天中触发一次生成。"
                />
            ) : (
                <div class="ag-list" style={{ padding: 0, gap: '8px' }}>
                    {filteredTraces.map((trace) => {
                        const isSelected = selectedTrace?.runId === trace.runId;
                        const hitRate = computeCacheHitPercent(trace.usage);
                        const statusMeta = getRunStatusMeta(trace.status);
                        return (
                            <div
                                key={trace.runId}
                                style={{
                                    display: 'flex',
                                    flexDirection: 'column',
                                    gap: '4px',
                                }}
                            >
                                <button
                                    type="button"
                                    class={
                                        isSelected && !isMobile
                                            ? 'ag-list-item ag-list-item-active'
                                            : 'ag-list-item'
                                    }
                                    onClick={() => handleSelectRun(trace.runId, null)}
                                >
                                    <div
                                        class="ag-row"
                                        style={{ justifyContent: 'space-between', gap: '6px' }}
                                    >
                                        <span
                                            class="ag-list-item-title"
                                            style={{
                                                minWidth: 0,
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            #{trace.target.messageId}#{trace.target.swipeId} ·{' '}
                                            {trace.agentName}
                                        </span>
                                        <span style={{ flexShrink: 0 }}>
                                            <Badge tone={hitRate >= 70 ? 'success' : 'neutral'}>
                                                {hitRate.toFixed(1)}% 命中
                                            </Badge>
                                        </span>
                                    </div>
                                    <div class="ag-list-item-meta">
                                        <span class="ag-row" style={{ gap: '4px' }}>
                                            <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                                            <span>
                                                {trace.phase} · {trace.toolSteps.length} 步
                                            </span>
                                        </span>
                                        <span class="ag-mono">
                                            {formatDurationMs(trace.durationMs)}
                                        </span>
                                    </div>
                                </button>

                                {trace.toolSteps.length > 0 ? (
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: '4px',
                                            paddingLeft: '14px',
                                            borderLeft: '2px solid var(--border)',
                                            marginLeft: '10px',
                                        }}
                                    >
                                        {trace.toolSteps.map((step) => {
                                            const stepSelected =
                                                isSelected
                                                && highlightedStepIndex === step.stepIndex;
                                            return (
                                                <button
                                                    key={`${trace.runId}_${step.toolCallId}_${step.stepIndex}`}
                                                    type="button"
                                                    class={
                                                        stepSelected && !isMobile
                                                            ? 'ag-list-item ag-list-item-active'
                                                            : 'ag-list-item'
                                                    }
                                                    style={{
                                                        minHeight: '40px',
                                                        padding: '6px 10px',
                                                    }}
                                                    onClick={() =>
                                                        handleSelectRun(trace.runId, step.stepIndex)
                                                    }
                                                >
                                                    <div
                                                        class="ag-row"
                                                        style={{
                                                            justifyContent: 'space-between',
                                                            fontSize: '12px',
                                                        }}
                                                    >
                                                        <span
                                                            class="ag-mono"
                                                            style={{
                                                                fontWeight: 600,
                                                                minWidth: 0,
                                                                overflow: 'hidden',
                                                                textOverflow: 'ellipsis',
                                                                whiteSpace: 'nowrap',
                                                            }}
                                                        >
                                                            #{step.stepIndex + 1} {step.toolName}
                                                        </span>
                                                        <span class="ag-row" style={{ gap: '4px', flexShrink: 0 }}>
                                                            <Badge tone={step.ok ? 'success' : 'error'}>
                                                                {step.ok ? 'OK' : 'ERR'}
                                                            </Badge>
                                                            <span
                                                                style={{
                                                                    fontSize: '11px',
                                                                    color: 'var(--muted-foreground)',
                                                                }}
                                                            >
                                                                {formatDurationMs(step.durationMs)}
                                                            </span>
                                                        </span>
                                                    </div>
                                                </button>
                                            );
                                        })}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const detailPane = selectedTrace ? (() => {
        const hitRate = computeCacheHitPercent(selectedTrace.usage);
        const statusMeta = getRunStatusMeta(selectedTrace.status);
        const extractedCalls = extractToolCallsFromTrace(selectedTrace);
        const fullSnapshotPayload = {
            runId: selectedTrace.runId,
            target: selectedTrace.target,
            phase: selectedTrace.phase,
            agentProfileId: selectedTrace.agentProfileId,
            agentName: selectedTrace.agentName,
            model: selectedTrace.model,
            status: selectedTrace.status,
            durationMs: selectedTrace.durationMs,
            usage: selectedTrace.usage,
            toolSteps: selectedTrace.toolSteps,
            outputPreview: selectedTrace.outputPreview,
            error: selectedTrace.error,
            requestSnapshot: selectedTrace.requestSnapshot,
        };

        return (
            <div
                class="ag-view-scroll ag-thin-scroll"
                style={{ padding: isMobile ? '12px' : '14px' }}
            >
                <div class="ag-stack-v">
                    {/* Header Card */}
                    <div class="ag-card">
                        <div class="ag-card-header">
                            <div class="ag-card-headings" style={{ flex: '1 1 220px' }}>
                                <div class="ag-card-title">
                                    #{selectedTrace.target.messageId}#{selectedTrace.target.swipeId}{' '}
                                    · {selectedTrace.agentName}
                                </div>
                                <div class="ag-card-subtitle ag-row-wrap" style={{ marginTop: '4px' }}>
                                    <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                                    <Badge tone="primary">
                                        {selectedTrace.phase} ({getPhaseLabel(selectedTrace.phase)})
                                    </Badge>
                                    <span class="ag-mono">{selectedTrace.model}</span>
                                    {selectedTrace.triggerLabel ? (
                                        <Badge tone="neutral">{selectedTrace.triggerLabel}</Badge>
                                    ) : null}
                                    <span>开始：{formatTimestamp(selectedTrace.startedAt)}</span>
                                </div>
                            </div>

                            <div class="ag-card-actions">
                                <SegmentedControl<DetailViewTab>
                                    ariaLabel="日志详情视图"
                                    value={detailTab}
                                    options={[
                                        { value: 'steps', label: '步骤详情' },
                                        { value: 'raw', label: '原始 JSON' },
                                    ]}
                                    onChange={setDetailTab}
                                />
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    icon={<IconCopy size={14} />}
                                    onClick={() =>
                                        void handleCopyPayload('完整运行快照 JSON', fullSnapshotPayload)
                                    }
                                >
                                    复制完整 JSON
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* TokenUsage & Duration Cards */}
                    <div class="ag-grid-4">
                        <div class="ag-card">
                            <div class="ag-card-body">
                                <div class="ag-field-label">Input Tokens</div>
                                <div
                                    class="ag-mono"
                                    style={{ fontSize: '18px', fontWeight: 700, marginTop: '4px' }}
                                >
                                    {formatTokenCount(selectedTrace.usage.inputTokens)}
                                </div>
                            </div>
                        </div>

                        <div
                            class="ag-card"
                            style={{
                                borderColor: 'color-mix(in srgb, var(--success) 42%, transparent)',
                            }}
                        >
                            <div class="ag-card-body">
                                <div class="ag-field-label" style={{ color: 'var(--success)' }}>
                                    Cached 命中 ({hitRate.toFixed(1)}%)
                                </div>
                                <div
                                    class="ag-mono"
                                    style={{
                                        fontSize: '18px',
                                        fontWeight: 700,
                                        marginTop: '4px',
                                        color: 'var(--success)',
                                    }}
                                >
                                    {formatTokenCount(selectedTrace.usage.cachedTokens)}
                                </div>
                            </div>
                        </div>

                        <div class="ag-card">
                            <div class="ag-card-body">
                                <div class="ag-field-label">Output Tokens</div>
                                <div
                                    class="ag-mono"
                                    style={{ fontSize: '18px', fontWeight: 700, marginTop: '4px' }}
                                >
                                    {formatTokenCount(selectedTrace.usage.outputTokens)}
                                </div>
                            </div>
                        </div>

                        <div class="ag-card">
                            <div class="ag-card-body">
                                <div class="ag-field-label">Duration 耗时</div>
                                <div
                                    class="ag-mono"
                                    style={{ fontSize: '18px', fontWeight: 700, marginTop: '4px' }}
                                >
                                    {formatDurationMs(selectedTrace.durationMs)}
                                </div>
                            </div>
                        </div>
                    </div>

                    {selectedTrace.error ? (
                        <div class="ag-banner ag-banner-error ag-row" style={{ alignItems: 'flex-start' }}>
                            <IconAlertTriangle size={16} />
                            <div class="ag-mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                {selectedTrace.error}
                            </div>
                        </div>
                    ) : null}

                    {detailTab === 'steps' ? (
                        <div class="ag-stack-v">
                            {selectedTrace.toolSteps.length === 0 ? (
                                <div class="ag-banner ag-banner-neutral">
                                    本轮运行未调用工具（纯文本推理/输出）。
                                </div>
                            ) : (
                                selectedTrace.toolSteps.map((step: ToolStepLog) => {
                                    const isFocused = highlightedStepIndex === step.stepIndex;
                                    return (
                                        <div
                                            key={`${step.toolCallId}_${step.stepIndex}`}
                                            class="ag-card"
                                            style={
                                                isFocused
                                                    ? { borderColor: 'var(--primary)' }
                                                    : undefined
                                            }
                                        >
                                            <div class="ag-card-header">
                                                <div class="ag-row-wrap">
                                                    <Badge tone={step.ok ? 'success' : 'error'}>
                                                        Step #{step.stepIndex + 1}
                                                    </Badge>
                                                    <span class="ag-mono" style={{ fontWeight: 700 }}>
                                                        {step.toolName}
                                                    </span>
                                                    <span
                                                        class="ag-mono"
                                                        style={{
                                                            fontSize: '11px',
                                                            color: 'var(--muted-foreground)',
                                                        }}
                                                    >
                                                        {step.toolCallId}
                                                    </span>
                                                </div>
                                                <div class="ag-row">
                                                    <Badge tone={step.ok ? 'success' : 'error'}>
                                                        {step.ok ? (
                                                            <IconCheck size={12} />
                                                        ) : (
                                                            <IconAlertTriangle size={12} />
                                                        )}
                                                        <span>{step.ok ? '成功' : '失败'}</span>
                                                    </Badge>
                                                    <span
                                                        class="ag-mono"
                                                        style={{
                                                            fontSize: '11px',
                                                            color: 'var(--muted-foreground)',
                                                        }}
                                                    >
                                                        {formatDurationMs(step.durationMs)}
                                                    </span>
                                                </div>
                                            </div>
                                            <div class="ag-card-body ag-stack-v" style={{ gap: '8px' }}>
                                                <div>
                                                    <div
                                                        class="ag-row"
                                                        style={{
                                                            justifyContent: 'space-between',
                                                            marginBottom: '4px',
                                                        }}
                                                    >
                                                        <span class="ag-field-label">入参 (args)</span>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            icon={<IconCopy size={13} />}
                                                            onClick={() =>
                                                                void handleCopyPayload(
                                                                    `${step.toolName} 入参`,
                                                                    step.args,
                                                                )
                                                            }
                                                        >
                                                            复制入参
                                                        </Button>
                                                    </div>
                                                    <pre class="ag-pre">{formatJsonBlock(step.args)}</pre>
                                                </div>

                                                <div>
                                                    <div
                                                        class="ag-row"
                                                        style={{
                                                            justifyContent: 'space-between',
                                                            marginBottom: '4px',
                                                        }}
                                                    >
                                                        <span class="ag-field-label">返回 (result)</span>
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            icon={<IconCopy size={13} />}
                                                            onClick={() =>
                                                                void handleCopyPayload(
                                                                    `${step.toolName} 返回值`,
                                                                    step.result,
                                                                )
                                                            }
                                                        >
                                                            复制返回
                                                        </Button>
                                                    </div>
                                                    <pre class="ag-pre">{step.result || '(空)'}</pre>
                                                </div>

                                                {step.error ? (
                                                    <div class="ag-banner ag-banner-error ag-mono">
                                                        错误：{step.error}
                                                    </div>
                                                ) : null}
                                            </div>
                                        </div>
                                    );
                                })
                            )}

                            {selectedTrace.outputPreview ? (
                                <div class="ag-card">
                                    <div class="ag-card-header">
                                        <span class="ag-card-title">Assistant 输出摘要</span>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            icon={<IconCopy size={13} />}
                                            onClick={() =>
                                                void handleCopyPayload(
                                                    'Assistant 输出摘要',
                                                    selectedTrace.outputPreview,
                                                )
                                            }
                                        >
                                            复制正文
                                        </Button>
                                    </div>
                                    <div class="ag-card-body">
                                        <pre class="ag-pre">{selectedTrace.outputPreview}</pre>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <div class="ag-stack-v">
                            <div class="ag-card">
                                <div class="ag-card-header">
                                    <div class="ag-card-headings">
                                        <span class="ag-card-title">messages 请求消息数组</span>
                                        <span class="ag-card-subtitle">
                                            {selectedTrace.requestSnapshot
                                                ? `${selectedTrace.requestSnapshot.messages.length} 条消息 · Cache Breakpoints: ${JSON.stringify(selectedTrace.requestSnapshot.cacheBreakpoints ?? [])}`
                                                : '未采集 requestSnapshot.messages'}
                                        </span>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        icon={<IconCopy size={14} />}
                                        onClick={() =>
                                            void handleCopyPayload(
                                                'messages JSON',
                                                selectedTrace.requestSnapshot?.messages ?? [],
                                            )
                                        }
                                    >
                                        复制 messages
                                    </Button>
                                </div>
                                <div class="ag-card-body">
                                    <pre class="ag-pre ag-thin-scroll" style={{ maxHeight: '320px' }}>
                                        {formatJsonBlock(
                                            selectedTrace.requestSnapshot?.messages ?? [],
                                        )}
                                    </pre>
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-header">
                                    <div class="ag-card-headings">
                                        <span class="ag-card-title">tool_calls 与工具定义快照</span>
                                        <span class="ag-card-subtitle">
                                            步骤调用 {extractedCalls.fromSteps.length} 次 · 已注册工具{' '}
                                            {selectedTrace.requestSnapshot?.tools?.length ?? 0} 个
                                        </span>
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        icon={<IconCopy size={14} />}
                                        onClick={() =>
                                            void handleCopyPayload('tool_calls JSON', {
                                                toolCallsInMessages: extractedCalls.fromMessages,
                                                toolSteps: extractedCalls.fromSteps,
                                                tools: selectedTrace.requestSnapshot?.tools ?? [],
                                            })
                                        }
                                    >
                                        复制 tool_calls
                                    </Button>
                                </div>
                                <div class="ag-card-body">
                                    <pre class="ag-pre ag-thin-scroll" style={{ maxHeight: '320px' }}>
                                        {formatJsonBlock({
                                            toolCallsInMessages: extractedCalls.fromMessages,
                                            toolSteps: extractedCalls.fromSteps,
                                            tools: selectedTrace.requestSnapshot?.tools ?? [],
                                        })}
                                    </pre>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    })() : null;

    return (
        <MasterDetailLayout
            isMobile={isMobile}
            detailOpen={detailOpen}
            onDetailOpenChange={setDetailOpen}
            detailTitle={
                selectedTrace
                    ? `#${selectedTrace.target.messageId} · ${selectedTrace.agentName}`
                    : '运行详情'
            }
            emptyDetailTitle="选择左侧运行记录"
            emptyDetailDescription="查看 Input / Cached / Output Token 统计、缓存命中率、工具步骤树与原始 messages / tool_calls JSON。"
            master={masterPane}
            detail={detailPane}
        />
    );
}
