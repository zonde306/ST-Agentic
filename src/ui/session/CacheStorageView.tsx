import { useCallback, useEffect, useState } from 'preact/hooks';
import type { CompactionReport, StorageSettings } from '@/core/types';
import {
    Badge,
    Button,
    Card,
    EmptyState,
    FormField,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconCheck,
    IconDatabase,
    IconPlay,
    IconRefresh,
    IconTrash,
} from '@/ui/components/Icons';
import type {
    AgentWatermarkStatus,
    ConsoleViewProps,
    StorageOverview,
} from '@/ui/store';
import {
    formatBytes,
    formatCompactTokens,
    formatTokenCount,
    useStoreSlice,
} from './shared';

export function CacheStorageView({ store }: ConsoleViewProps) {
    const storageSettings = useStoreSlice(store, (s) => s.settings.storage);

    const [watermarks, setWatermarks] = useState<AgentWatermarkStatus[]>([]);
    const [overview, setOverview] = useState<StorageOverview | null>(null);
    const [loading, setLoading] = useState(true);
    const [clearingCaches, setClearingCaches] = useState(false);
    const [compactingAgentId, setCompactingAgentId] = useState<string | null>(null);
    const [compactionBusy, setCompactionBusy] = useState(false);
    const [lastReport, setLastReport] = useState<CompactionReport | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);

    const [keepDepthDraft, setKeepDepthDraft] = useState<string>(() =>
        String(storageSettings.keepDepth),
    );
    const [thresholdKbDraft, setThresholdKbDraft] = useState<string>(() =>
        String(Math.max(1, Math.round(storageSettings.sizeThreshold / 1024))),
    );

    useEffect(() => {
        setKeepDepthDraft(String(storageSettings.keepDepth));
    }, [storageSettings.keepDepth]);

    useEffect(() => {
        setThresholdKbDraft(String(Math.max(1, Math.round(storageSettings.sizeThreshold / 1024))));
    }, [storageSettings.sizeThreshold]);

    const loadTelemetry = useCallback(async () => {
        setLoading(true);
        setErrorText(null);
        try {
            const [wmList, storageData] = await Promise.all([
                store.services.getWatermarkStatuses(),
                store.services.getStorageOverview(),
            ]);
            setWatermarks(wmList);
            setOverview(storageData);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setErrorText(`读取缓存水位与存储遥测失败：${msg}`);
        } finally {
            setLoading(false);
        }
    }, [store]);

    useEffect(() => {
        void loadTelemetry();
    }, [loadTelemetry]);

    const updateStoragePatch = async (patch: Partial<StorageSettings>, toastMessage?: string) => {
        await store.updateSettings((prev) => ({
            ...prev,
            storage: {
                ...prev.storage,
                ...patch,
            },
        }));
        if (toastMessage) {
            store.pushToast(toastMessage, 'success');
        }
    };

    const handleKeepDepthCommit = (rawValue: string) => {
        setKeepDepthDraft(rawValue);
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed) && parsed >= 1) {
            const nextDepth = Math.round(parsed);
            if (nextDepth !== storageSettings.keepDepth) {
                void updateStoragePatch({ keepDepth: nextDepth });
            }
        }
    };

    const handleThresholdKbCommit = (rawValue: string) => {
        setThresholdKbDraft(rawValue);
        const parsed = Number(rawValue);
        if (Number.isFinite(parsed) && parsed >= 16) {
            const nextBytes = Math.round(parsed) * 1024;
            if (nextBytes !== storageSettings.sizeThreshold) {
                void updateStoragePatch({ sizeThreshold: nextBytes });
            }
        }
    };

    const handleClearPromptCaches = async () => {
        if (clearingCaches) {
            return;
        }
        if (!store.services.clearAllPromptCaches) {
            store.pushToast('当前运行时不支持清除提示词缓存', 'warning');
            return;
        }
        setClearingCaches(true);
        try {
            const result = await store.services.clearAllPromptCaches();
            await loadTelemetry();
            store.pushToast(
                `已清除所有提示词缓存（未删除聊天历史）：前缀缓存 ${result.clearedPrefixes} 条 · 消息/历史缓存 ${result.clearedMessageCaches ?? 0} 条 · VFS 缓存 ${result.clearedVfsCache} 条 · 世界书缓存 ${result.clearedLorebooks} 条`,
                'success',
                4500,
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`清除提示词缓存失败：${msg}`, 'error');
        } finally {
            setClearingCaches(false);
        }
    };

    const handleCompactAgent = async (item: AgentWatermarkStatus) => {
        if (compactingAgentId) {
            return;
        }
        setCompactingAgentId(item.agentId);
        try {
            const updated = await store.services.compactAgentContext(item.agentId);
            setWatermarks((prev) =>
                prev.map((w) => (w.agentId === item.agentId ? updated : w)),
            );
            store.pushToast(
                `${updated.agentName} 已完成分块归档（已归档 ${updated.archivedChunks} 块，回落至 ${formatCompactTokens(updated.currentTokens)} tokens）`,
                'success',
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`分块归档失败：${msg}`, 'error');
        } finally {
            setCompactingAgentId(null);
        }
    };

    const handlePreviewCompaction = async () => {
        if (compactionBusy) {
            return;
        }
        setCompactionBusy(true);
        try {
            const report = await store.services.previewColdCompaction(storageSettings.keepDepth);
            setLastReport(report);
            store.pushToast(
                `预览完成：可压平 ${report.flattenedEntries} 条冷记录，预计释放 ${formatBytes(report.freedBytes)}`,
                'primary',
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`预览压平失败：${msg}`, 'error');
        } finally {
            setCompactionBusy(false);
        }
    };

    const handleRunCompaction = async () => {
        if (compactionBusy) {
            return;
        }
        setCompactionBusy(true);
        try {
            const report = await store.services.runColdCompaction(storageSettings.keepDepth);
            setLastReport(report);
            const nextOverview = await store.services.getStorageOverview();
            setOverview(nextOverview);
            store.pushToast(
                `冷层压平完成：已回收 ${report.removedLayers} 个分支层，释放 ${formatBytes(report.freedBytes)}`,
                'success',
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`冷层压平失败：${msg}`, 'error');
        } finally {
            setCompactionBusy(false);
        }
    };

    return (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                {errorText ? <div class="ag-banner ag-banner-error">{errorText}</div> : null}

                {/* Top Section: Persistent Agent Context Watermarks */}
                <Card
                    title="持久智能体上下文水位与分块归档 (KV Cache 保护)"
                    subtitle="未跨过高水位 H 前严禁修改历史或折叠旧工具输出，到达 H 后在维护阶段原子归档回落至低水位 L。"
                    actions={
                        <div class="ag-row-wrap">
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<IconTrash size={14} />}
                                loading={clearingCaches}
                                disabled={clearingCaches}
                                className="ag-cache-clear-prompts-btn"
                                title="仅清除前缀缓存、消息/历史处理缓存、VFS 缓存与世界书缓存，不会删除聊天历史"
                                onClick={() => void handleClearPromptCaches()}
                            >
                                清除所有提示词缓存
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<IconRefresh size={14} />}
                                loading={loading}
                                onClick={() => void loadTelemetry()}
                            >
                                刷新遥测
                            </Button>
                        </div>
                    }
                >
                    {loading && watermarks.length === 0 ? (
                        <EmptyState
                            icon={<IconDatabase size={20} />}
                            title="正在加载智能体水位状态..."
                        />
                    ) : watermarks.length === 0 ? (
                        <EmptyState
                            icon={<IconDatabase size={20} />}
                            title="暂无活跃的持久智能体轨迹"
                            description="当主叙事 Agent 或 sessionMode='persistent' 伴生智能体运行后，将在此展示各自上下文水位。"
                        />
                    ) : (
                        <div class="ag-grid-3">
                            {watermarks.map((w) => {
                                const high = Math.max(1, w.highWatermark);
                                const pct = Math.max(
                                    0,
                                    Math.min(100, Math.round((w.currentTokens / high) * 100)),
                                );
                                const lowPct = Math.max(
                                    0,
                                    Math.min(100, Math.round((w.lowWatermark / high) * 100)),
                                );
                                const isOverHigh = w.currentTokens >= w.highWatermark;
                                const isNearHigh = !isOverHigh && pct >= 80;
                                const fillColor = isOverHigh
                                    ? 'var(--error)'
                                    : isNearHigh
                                        ? 'var(--warning)'
                                        : 'var(--primary)';

                                return (
                                    <div key={w.agentId} class="ag-card">
                                        <div class="ag-card-body ag-stack-v" style={{ gap: '10px' }}>
                                            <div
                                                class="ag-row"
                                                style={{ justifyContent: 'space-between' }}
                                            >
                                                <span style={{ fontWeight: 700, fontSize: '13px' }}>
                                                    {w.agentName}
                                                </span>
                                                <Badge
                                                    tone={
                                                        isOverHigh
                                                            ? 'error'
                                                            : isNearHigh
                                                                ? 'warning'
                                                                : 'primary'
                                                    }
                                                >
                                                    {pct}%
                                                </Badge>
                                            </div>

                                            <div
                                                class="ag-row ag-mono"
                                                style={{
                                                    justifyContent: 'space-between',
                                                    fontSize: '12px',
                                                }}
                                            >
                                                <span>{formatTokenCount(w.currentTokens)} tokens</span>
                                                <span style={{ color: 'var(--muted-foreground)' }}>
                                                    H = {formatCompactTokens(w.highWatermark)}
                                                </span>
                                            </div>

                                            <div
                                                class="ag-progress-track"
                                                role="progressbar"
                                                aria-label={`${w.agentName} 上下文水位`}
                                                aria-valuenow={w.currentTokens}
                                                aria-valuemin={0}
                                                aria-valuemax={w.highWatermark}
                                            >
                                                <div
                                                    class="ag-progress-fill"
                                                    style={{
                                                        width: `${pct}%`,
                                                        background: fillColor,
                                                    }}
                                                />
                                                <div
                                                    class="ag-progress-marker"
                                                    title={`低水位 L = ${w.lowWatermark}`}
                                                    style={{ left: `${lowPct}%` }}
                                                />
                                            </div>

                                            <div
                                                class="ag-row-wrap"
                                                style={{
                                                    justifyContent: 'space-between',
                                                    fontSize: '11px',
                                                    color: 'var(--muted-foreground)',
                                                }}
                                            >
                                                <span>
                                                    L={formatCompactTokens(w.lowWatermark)} · 已归档{' '}
                                                    {w.archivedChunks} 块
                                                </span>
                                                <span>{w.summaryMode}</span>
                                            </div>

                                            <Button
                                                size="sm"
                                                variant="secondary"
                                                loading={compactingAgentId === w.agentId}
                                                disabled={Boolean(compactingAgentId)}
                                                onClick={() => void handleCompactAgent(w)}
                                            >
                                                立即分块归档
                                            </Button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </Card>

                {/* Bottom Section: ChatDataStore Cold-Layer Telemetry & Compaction */}
                <Card
                    title="ChatDataStore 存档冷层物理压平 (Storage Compaction)"
                    subtitle="合并距今超过保留热深度的冷楼层增量覆盖并清理旧 Swipe 分支，防止 .jsonl 存档无限膨胀。"
                    actions={
                        <ToggleSwitch
                            checked={storageSettings.autoCompact}
                            label="自动压平"
                            onChange={(checked) =>
                                void updateStoragePatch(
                                    { autoCompact: checked },
                                    `自动冷层压平已${checked ? '开启' : '关闭'}`,
                                )
                            }
                        />
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-4">
                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">估算占用体积</div>
                                    <div
                                        class="ag-mono"
                                        style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}
                                    >
                                        {overview ? formatBytes(overview.estimatedBytes) : '-'}
                                    </div>
                                    {overview && overview.trajectoryBytes !== undefined ? (
                                        <div class="ag-field-hint">
                                            轨迹检查点体积：{formatBytes(overview.trajectoryBytes)}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">活跃分支层数</div>
                                    <div
                                        class="ag-mono"
                                        style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}
                                    >
                                        {overview ? `${overview.activeLayers} 层` : '-'}
                                    </div>
                                    {overview && overview.trajectoryCheckpoints !== undefined ? (
                                        <div class="ag-field-hint">
                                            轨迹检查点：{overview.trajectoryCheckpoints} 个
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">保留热深度 (keepDepth)</div>
                                    <div
                                        class="ag-mono"
                                        style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}
                                    >
                                        {storageSettings.keepDepth} 轮
                                    </div>
                                    {overview ? (
                                        <div class="ag-field-hint">
                                            已压平水位：Message #{overview.compactedWatermark}
                                        </div>
                                    ) : null}
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">触发阈值 (sizeThreshold)</div>
                                    <div
                                        class="ag-mono"
                                        style={{ fontSize: '16px', fontWeight: 700, marginTop: '4px' }}
                                    >
                                        {formatBytes(storageSettings.sizeThreshold)}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="ag-grid-2">
                            <FormField
                                label="保留热窗口深度 (keepDepth / 轮)"
                                hint="最近 N 条消息保留完整分支隔离与未压平增量层。"
                            >
                                <TextInput
                                    type="number"
                                    min={1}
                                    step={1}
                                    value={keepDepthDraft}
                                    ariaLabel="保留热窗口深度"
                                    onInput={handleKeepDepthCommit}
                                    onChange={handleKeepDepthCommit}
                                />
                            </FormField>

                            <FormField
                                label="自动压平体积阈值 (sizeThreshold / KiB)"
                                hint={`当前等价：${formatBytes(storageSettings.sizeThreshold)}（${storageSettings.sizeThreshold.toLocaleString()} bytes）`}
                            >
                                <TextInput
                                    type="number"
                                    min={16}
                                    step={16}
                                    value={thresholdKbDraft}
                                    ariaLabel="体积触发阈值 KiB"
                                    onInput={handleThresholdKbCommit}
                                    onChange={handleThresholdKbCommit}
                                />
                            </FormField>
                        </div>

                        <ToggleSwitch
                            checked={storageSettings.pruneLegacy}
                            label="压平时同步清理旧版残留字段 (pruneLegacy)"
                            description="压平冷层后移除已合并的旧版 cg_data / wi_overrides 冗余快照"
                            onChange={(checked) =>
                                void updateStoragePatch({ pruneLegacy: checked })
                            }
                        />

                        {lastReport ? (
                            <div
                                class={
                                    lastReport.dryRun
                                        ? 'ag-banner ag-banner-primary'
                                        : 'ag-banner ag-banner-success'
                                }
                            >
                                <div
                                    class="ag-row-wrap"
                                    style={{ justifyContent: 'space-between', marginBottom: '6px' }}
                                >
                                    <strong>
                                        {lastReport.dryRun
                                            ? '压平预览报告 (Dry Run · 未实际写入)'
                                            : '冷层物理压平执行报告'}
                                    </strong>
                                    <Badge tone={lastReport.dryRun ? 'primary' : 'success'}>
                                        释放 {formatBytes(lastReport.freedBytes)}
                                    </Badge>
                                </div>
                                <div class="ag-row-wrap" style={{ gap: '10px', fontSize: '12px' }}>
                                    <span>压缩楼层：{lastReport.compactedMessages} 条</span>
                                    <span>移除冷层：{lastReport.removedLayers} 个</span>
                                    <span>压平条目：{lastReport.flattenedEntries} 条</span>
                                    {lastReport.prunedScratchFiles !== undefined ? (
                                        <span>清理冷草稿：{lastReport.prunedScratchFiles} 个</span>
                                    ) : null}
                                    {lastReport.prunedCheckpoints !== undefined ? (
                                        <span>裁剪检查点：{lastReport.prunedCheckpoints} 个</span>
                                    ) : null}
                                    <span>
                                        体积：{formatBytes(lastReport.estimatedBytesBefore)} →{' '}
                                        {formatBytes(lastReport.estimatedBytesAfter)}
                                    </span>
                                    {lastReport.trajectoryBytesBefore !== undefined
                                        && lastReport.trajectoryBytesAfter !== undefined ? (
                                            <span>
                                                轨迹：{formatBytes(lastReport.trajectoryBytesBefore)} →{' '}
                                                {formatBytes(lastReport.trajectoryBytesAfter)}
                                            </span>
                                        ) : null}
                                    <span>
                                        水位：#{lastReport.previousWatermark} → #
                                        {lastReport.newWatermark}
                                    </span>
                                </div>
                            </div>
                        ) : null}

                        <div class="ag-row-wrap">
                            <Button
                                variant="secondary"
                                icon={<IconPlay size={14} />}
                                loading={compactionBusy}
                                onClick={() => void handlePreviewCompaction()}
                            >
                                预览压平
                            </Button>
                            <Button
                                variant="primary"
                                icon={<IconCheck size={14} />}
                                loading={compactionBusy}
                                onClick={() => void handleRunCompaction()}
                            >
                                立即压平
                            </Button>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}
