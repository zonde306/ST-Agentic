import { useMemo, useState } from 'preact/hooks';
import { resolveActivePreset } from '@/core/config';
import { applyRegexRules } from '@/core/regex';
import type {
    SideClueDelivery,
    SideSessionInfo,
    SideSessionScope,
    SideSessionTranscriptEntry,
} from '@/core/types';
import {
    Badge,
    Button,
    EmptyState,
    FormField,
    SegmentedControl,
    SelectInput,
    ShadowModal,
    TextAreaInput,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconCopy,
    IconDatabase,
    IconPlus,
    IconRefresh,
    IconTrash,
} from '@/ui/components/Icons';
import type { AppStore } from '@/ui/store';
import {
    DELIVERY_SELECT_OPTIONS,
    copyTextSafe,
    formatAnchor,
    formatErrorMessage,
    formatShortTime,
    formatTokenCount,
    getDeliveryMeta,
    parseKeywordsInput,
    useSideGenStoreSlice,
} from './sidegen-helpers';

export interface SideSessionsPaneProps {
    store: AppStore;
    isMobile: boolean;
}

type ScopeFilter = 'all' | SideSessionScope;

const SCOPE_FILTER_OPTIONS: readonly { value: ScopeFilter; label: string }[] = [
    { value: 'all', label: '全部作用域' },
    { value: 'branch', label: '因果分支 (branch)' },
    { value: 'chat', label: '聊天级 (chat)' },
];

const SESSION_SCOPE_OPTIONS: readonly { value: SideSessionScope; label: string }[] = [
    { value: 'branch', label: '因果分支 (branch · 随 Swipe 回滚)' },
    { value: 'chat', label: '聊天级 (chat · 跨 Swipe 持久)' },
];

const AUTO_BRIDGE_MODE_OPTIONS: readonly { value: 'append' | 'replace'; label: string }[] = [
    { value: 'append', label: '追加 (append · 保留往期通讯)' },
    { value: 'replace', label: '覆写 (replace · 仅保留最新态势)' },
];

function roleLabel(role: SideSessionTranscriptEntry['role']): string {
    if (role === 'system') {
        return 'System (冻结前缀 / 压缩摘要)';
    }
    if (role === 'user') {
        return '写卡脚本 / 输入 (user)';
    }
    return '线外模型输出 (assistant)';
}

export function SideSessionsPane({ store }: SideSessionsPaneProps) {
    const sideSessions = useSideGenStoreSlice(store, (s) => s.sideSessions);
    const settings = useSideGenStoreSlice(store, (s) => s.settings);
    const activeTarget = useSideGenStoreSlice(store, (s) => s.activeTarget);
    const defaultDelivery = settings.offMainline?.defaultDelivery ?? 'radar_hint';
    const regexRules = useMemo(
        () => resolveActivePreset(settings).regexRules,
        [settings],
    );
    const formatTranscriptContent = (entry: SideSessionTranscriptEntry): string =>
        entry.role === 'user' || entry.role === 'assistant'
            ? applyRegexRules(entry.content, regexRules, {
                  stage: 'display',
                  sender: entry.role,
              })
            : entry.content;

    const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
    const [compactingId, setCompactingId] = useState<string | null>(null);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);

    // Read-only transcript modal state.
    const [transcriptSession, setTranscriptSession] = useState<SideSessionInfo | null>(null);
    const [transcriptEntries, setTranscriptEntries] = useState<SideSessionTranscriptEntry[]>([]);
    const [loadingTranscript, setLoadingTranscript] = useState<boolean>(false);
    const [transcriptError, setTranscriptError] = useState<string | null>(null);

    // Create new SideSession modal state.
    const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
    const [newId, setNewId] = useState<string>('');
    const [newTitle, setNewTitle] = useState<string>('');
    const [newScope, setNewScope] = useState<SideSessionScope>('branch');
    const [newConnectionId, setNewConnectionId] = useState<string>('inherit');
    const [newSystemPrompt, setNewSystemPrompt] = useState<string>('');
    const [newWatermarkHigh, setNewWatermarkHigh] = useState<string>('24000');
    const [newWatermarkLow, setNewWatermarkLow] = useState<string>('12000');
    const [enableAutoBridge, setEnableAutoBridge] = useState<boolean>(false);
    const [bridgePath, setBridgePath] = useState<string>('/side/comms/npc.md');
    const [bridgeTitle, setBridgeTitle] = useState<string>('');
    const [bridgeDelivery, setBridgeDelivery] = useState<SideClueDelivery>(defaultDelivery);
    const [bridgeMode, setBridgeMode] = useState<'append' | 'replace'>('append');
    const [bridgeKeywordsText, setBridgeKeywordsText] = useState<string>('');
    const [creating, setCreating] = useState<boolean>(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const connectionOptions = useMemo(
        () => [
            { value: 'inherit', label: '跟随主连接 (inherit)' },
            ...Object.values(settings.connections).map((conn) => ({
                value: conn.id,
                label: `${conn.name}${conn.model ? ` (${conn.model})` : ''}`,
            })),
        ],
        [settings.connections],
    );

    const filteredSessions = useMemo(
        () =>
            sideSessions.filter(
                (session) => scopeFilter === 'all' || session.scope === scopeFilter,
            ),
        [scopeFilter, sideSessions],
    );

    const handleViewTranscript = async (session: SideSessionInfo) => {
        setTranscriptSession(session);
        setTranscriptEntries([]);
        setTranscriptError(null);

        const runtime = store.getSideGenRuntime();
        if (!runtime) {
            setTranscriptError('SideGen 运行时未连接，无法拉取实时会话记录。');
            return;
        }

        setLoadingTranscript(true);
        try {
            const entries = await runtime.getTranscript(session.id);
            setTranscriptEntries(entries);
        } catch (err) {
            setTranscriptError(`加载会话记录失败：${formatErrorMessage(err)}`);
        } finally {
            setLoadingTranscript(false);
        }
    };

    const handleCopyTranscript = async () => {
        if (!transcriptSession || transcriptEntries.length === 0) {
            return;
        }
        const text = transcriptEntries
            .map((entry) => `[${entry.role}]\n${formatTranscriptContent(entry)}`)
            .join('\n\n---\n\n');
        const ok = await copyTextSafe(text);
        store.pushToast(
            ok ? '已复制会话只读记录' : '复制失败，请手动选中复制',
            ok ? 'success' : 'warning',
        );
    };

    const handleCompact = async (session: SideSessionInfo) => {
        if (compactingId) {
            return;
        }
        const runtime = store.getSideGenRuntime();
        if (!runtime) {
            store.pushToast('SideGen 运行时未连接，无法执行压缩', 'warning');
            return;
        }

        setCompactingId(session.id);
        try {
            const result = await runtime.compactSession(session.id);
            await store.refreshSideGenState(activeTarget);
            if (result.compacted) {
                store.pushToast(
                    `已压缩 ${session.id}，当前水位约 ${formatTokenCount(result.estimatedTokens)} tokens`,
                    'success',
                );
            } else {
                store.pushToast(
                    `${session.id} 当前历史不足压缩条件（约 ${formatTokenCount(result.estimatedTokens)} tokens）`,
                    'primary',
                );
            }
        } catch (err) {
            store.pushToast(`压缩会话失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setCompactingId(null);
        }
    };

    const handleDelete = async (session: SideSessionInfo) => {
        if (deletingId) {
            return;
        }
        const runtime = store.getSideGenRuntime();
        setDeletingId(session.id);
        try {
            if (runtime) {
                await runtime.deleteSession(session.id);
                await store.refreshSideGenState(activeTarget);
            } else {
                store.setSideSessions(sideSessions.filter((s) => s.id !== session.id));
            }
            setConfirmDeleteId(null);
            store.pushToast(`已删除线外会话：${session.id}`, 'warning');
        } catch (err) {
            store.pushToast(`删除会话失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setDeletingId(null);
        }
    };

    const openCreateModal = () => {
        setNewId('');
        setNewTitle('');
        setNewScope('branch');
        setNewConnectionId('inherit');
        setNewSystemPrompt('');
        setNewWatermarkHigh('24000');
        setNewWatermarkLow('12000');
        setEnableAutoBridge(false);
        setBridgePath('/side/comms/npc.md');
        setBridgeTitle('');
        setBridgeDelivery(defaultDelivery);
        setBridgeMode('append');
        setBridgeKeywordsText('');
        setCreateError(null);
        setCreateModalOpen(true);
    };

    const handleCreateSession = async () => {
        if (creating) {
            return;
        }
        const runtime = store.getSideGenRuntime();
        if (!runtime) {
            setCreateError('SideGen 运行时未连接，无法创建持久化线外会话。');
            return;
        }
        const title = newTitle.trim();
        if (!title) {
            setCreateError('请填写会话名称。');
            return;
        }
        if (enableAutoBridge && !bridgePath.trim().startsWith('/side/')) {
            setCreateError('自动桥接路径必须以 /side/ 开头。');
            return;
        }

        const high = Math.max(1000, Math.floor(Number(newWatermarkHigh) || 24000));
        const low = Math.max(500, Math.min(high - 1, Math.floor(Number(newWatermarkLow) || 12000)));

        setCreating(true);
        setCreateError(null);
        try {
            const created = await runtime.createSession({
                ...(newId.trim() ? { id: newId.trim() } : {}),
                title,
                scope: newScope,
                systemPrompt: newSystemPrompt.trim(),
                connectionId: newConnectionId,
                watermark: { high, low },
                ...(enableAutoBridge
                    ? {
                        autoBridge: {
                            path: bridgePath.trim(),
                            delivery: bridgeDelivery,
                            keywords: parseKeywordsInput(bridgeKeywordsText),
                            title: bridgeTitle.trim() || title,
                            mode: bridgeMode,
                        },
                    }
                    : {}),
            });
            await store.refreshSideGenState(activeTarget);
            setCreateModalOpen(false);
            store.pushToast(`已创建线外会话：${created.id}`, 'success');
        } catch (err) {
            setCreateError(`创建失败：${formatErrorMessage(err)}`);
        } finally {
            setCreating(false);
        }
    };

    return (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <div
                    class="ag-row-wrap"
                    style={{ justifyContent: 'space-between', alignItems: 'center' }}
                >
                    <div class="ag-row-wrap">
                        <SegmentedControl<ScopeFilter>
                            ariaLabel="线外会话作用域筛选"
                            value={scopeFilter}
                            options={SCOPE_FILTER_OPTIONS}
                            onChange={setScopeFilter}
                        />
                        <Badge tone="neutral">共 {filteredSessions.length} 个会话</Badge>
                    </div>

                    <Button
                        variant="primary"
                        size="sm"
                        icon={<IconPlus size={14} />}
                        onClick={openCreateModal}
                    >
                        新建线外会话
                    </Button>
                </div>

                {filteredSessions.length === 0 ? (
                    <EmptyState
                        icon={<IconDatabase size={22} />}
                        title={sideSessions.length === 0 ? '暂无线外持久会话' : '当前筛选下无会话'}
                        description="线外持久会话复用独立 TrajectoryStore（线程键 side:<id>），0 占用主线上下文，并可配置 autoBridge 自动沉淀到 /side/* 线索。"
                        action={
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<IconPlus size={14} />}
                                onClick={openCreateModal}
                            >
                                新建线外会话
                            </Button>
                        }
                    />
                ) : (
                    <div class="ag-stack-v">
                        {filteredSessions.map((session) => {
                            const high = Math.max(1, session.watermark.high);
                            const low = Math.max(0, Math.min(high, session.watermark.low));
                            const fillPct = Math.max(
                                0,
                                Math.min(100, (session.estimatedTokens / high) * 100),
                            );
                            const lowMarkerPct = Math.max(0, Math.min(100, (low / high) * 100));
                            const overHigh = session.estimatedTokens >= high;
                            const isConfirming = confirmDeleteId === session.id;
                            const isCompacting = compactingId === session.id;
                            const isDeleting = deletingId === session.id;
                            const connLabel =
                                session.connectionId === 'inherit'
                                    ? '跟随主连接'
                                    : (settings.connections[session.connectionId]?.name
                                        ?? session.connectionId);

                            return (
                                <article
                                    key={session.id}
                                    class="ag-side-session-card"
                                    data-side-session-id={session.id}
                                >
                                    <div class="ag-side-session-header">
                                        <div class="ag-min-w-0" style={{ flex: '1 1 240px' }}>
                                            <div class="ag-row-wrap" style={{ gap: '6px' }}>
                                                <span style={{ fontWeight: 700, fontSize: '14px' }}>
                                                    {session.title}
                                                </span>
                                                <span class="ag-pill ag-pill-primary ag-mono">
                                                    {session.id}
                                                </span>
                                                <span
                                                    class={
                                                        session.scope === 'branch'
                                                            ? 'ag-pill ag-pill-success'
                                                            : 'ag-pill ag-pill-warning'
                                                    }
                                                >
                                                    {session.scope === 'branch'
                                                        ? 'branch · 因果分支'
                                                        : 'chat · 聊天级'}
                                                </span>
                                                <span class="ag-pill ag-pill-muted">
                                                    {connLabel}
                                                </span>
                                            </div>

                                            <div
                                                class="ag-row-wrap"
                                                style={{
                                                    marginTop: '6px',
                                                    fontSize: '12px',
                                                    color: 'var(--muted-foreground)',
                                                    gap: '6px 12px',
                                                }}
                                            >
                                                <span>
                                                    锚点：
                                                    <code class="ag-mono">
                                                        {formatAnchor(session.anchor)}
                                                    </code>
                                                    {session.scope === 'chat' ? ' (跨 Swipe)' : ''}
                                                </span>
                                                <span>
                                                    自动桥接：
                                                    {session.autoBridge ? (
                                                        <>
                                                            <code
                                                                class="ag-mono"
                                                                style={{ color: 'var(--primary)' }}
                                                            >
                                                                {session.autoBridge.path}
                                                            </code>{' '}
                                                            <span
                                                                class={
                                                                    getDeliveryMeta(
                                                                        session.autoBridge.delivery,
                                                                    ).pillClass
                                                                }
                                                            >
                                                                {
                                                                    getDeliveryMeta(
                                                                        session.autoBridge.delivery,
                                                                    ).shortLabel
                                                                }
                                                            </span>
                                                        </>
                                                    ) : (
                                                        '未开启'
                                                    )}
                                                </span>
                                                <span>
                                                    轮次：<strong>{session.turns} 轮</strong>
                                                </span>
                                                <span>
                                                    更新：{formatShortTime(session.updatedAt)}
                                                </span>
                                            </div>
                                        </div>

                                        <div class="ag-row-wrap" style={{ flexShrink: 0 }}>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => {
                                                    void handleViewTranscript(session);
                                                }}
                                            >
                                                查看记录 ({session.turns} 轮)
                                            </Button>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                loading={isCompacting}
                                                icon={<IconRefresh size={13} />}
                                                onClick={() => {
                                                    void handleCompact(session);
                                                }}
                                            >
                                                {isCompacting ? '压缩中…' : '压缩'}
                                            </Button>

                                            {isConfirming ? (
                                                <>
                                                    <Button
                                                        variant="danger"
                                                        size="sm"
                                                        loading={isDeleting}
                                                        onClick={() => {
                                                            void handleDelete(session);
                                                        }}
                                                    >
                                                        确认删除
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={isDeleting}
                                                        onClick={() => setConfirmDeleteId(null)}
                                                    >
                                                        取消
                                                    </Button>
                                                </>
                                            ) : (
                                                <Button
                                                    variant="danger"
                                                    size="sm"
                                                    icon={<IconTrash size={13} />}
                                                    onClick={() => setConfirmDeleteId(session.id)}
                                                >
                                                    删除
                                                </Button>
                                            )}
                                        </div>
                                    </div>

                                    <div class="ag-progress-track" aria-label="Token 水位进度">
                                        <div
                                            class="ag-progress-fill"
                                            style={{
                                                width: `${fillPct}%`,
                                                background: overHigh
                                                    ? 'var(--warning)'
                                                    : 'var(--primary)',
                                            }}
                                        />
                                        <div
                                            class="ag-progress-marker"
                                            style={{ left: `${lowMarkerPct}%` }}
                                            title={`低水位：${formatTokenCount(low)} tokens`}
                                        />
                                    </div>

                                    <div class="ag-side-session-stats">
                                        <span>
                                            水位 {formatTokenCount(session.estimatedTokens)} /{' '}
                                            {formatTokenCount(high)} tok (低水位{' '}
                                            {formatTokenCount(low)})
                                        </span>
                                        <span style={{ color: 'var(--success)', fontWeight: 600 }}>
                                            缓存命中 {session.lastCacheHitRate ?? '—'}
                                        </span>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Read-only Transcript Modal */}
            <ShadowModal
                open={Boolean(transcriptSession)}
                title={
                    transcriptSession
                        ? `💬 只读会话记录 · ${transcriptSession.id}`
                        : '只读会话记录'
                }
                maxWidth="680px"
                onClose={() => setTranscriptSession(null)}
                footer={
                    <>
                        {transcriptEntries.length > 0 ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<IconCopy size={14} />}
                                onClick={() => {
                                    void handleCopyTranscript();
                                }}
                            >
                                复制记录
                            </Button>
                        ) : null}
                        <Button
                            variant="primary"
                            size="sm"
                            onClick={() => setTranscriptSession(null)}
                        >
                            关闭
                        </Button>
                    </>
                }
            >
                {transcriptSession ? (
                    <div class="ag-stack-v">
                        <div class="ag-banner ag-banner-primary">
                            <div
                                class="ag-row-wrap"
                                style={{ justifyContent: 'space-between', gap: '8px' }}
                            >
                                <span>
                                    作用域：
                                    <strong>
                                        {transcriptSession.scope === 'branch'
                                            ? '因果分支 (branch)'
                                            : '聊天级 (chat)'}
                                    </strong>{' '}
                                    · 锚点：
                                    <code class="ag-mono">
                                        {formatAnchor(transcriptSession.anchor)}
                                    </code>
                                </span>
                                <span>
                                    缓存命中：
                                    <strong style={{ color: 'var(--success)' }}>
                                        {transcriptSession.lastCacheHitRate ?? '—'}
                                    </strong>
                                </span>
                            </div>
                        </div>

                        {loadingTranscript ? (
                            <div
                                style={{
                                    padding: '24px',
                                    textAlign: 'center',
                                    color: 'var(--muted-foreground)',
                                    fontSize: '12px',
                                }}
                            >
                                正在加载只读对话轨迹…
                            </div>
                        ) : transcriptError ? (
                            <div class="ag-banner ag-banner-warning">{transcriptError}</div>
                        ) : transcriptEntries.length === 0 ? (
                            <EmptyState
                                title="暂无对话记录"
                                description="该线外会话尚未发送过任何消息，可在「SDK 试跑」页签发送首条消息。"
                            />
                        ) : (
                            <div class="ag-side-transcript-list">
                                {transcriptEntries.map((entry, idx) => (
                                    <div
                                        key={`${entry.role}_${idx}`}
                                        class={
                                            entry.role === 'user'
                                                ? 'ag-side-transcript-item ag-side-transcript-user'
                                                : 'ag-side-transcript-item'
                                        }
                                    >
                                        <div
                                            class="ag-row"
                                            style={{
                                                justifyContent: 'space-between',
                                                marginBottom: '4px',
                                            }}
                                        >
                                            <span
                                                style={{
                                                    fontSize: '11px',
                                                    fontWeight: 600,
                                                    color: 'var(--muted-foreground)',
                                                }}
                                            >
                                                {roleLabel(entry.role)}
                                            </span>
                                            {entry.timestamp ? (
                                                <span
                                                    class="ag-mono"
                                                    style={{
                                                        fontSize: '10px',
                                                        color: 'var(--muted-foreground)',
                                                    }}
                                                >
                                                    {formatShortTime(entry.timestamp)}
                                                </span>
                                            ) : null}
                                        </div>
                                        <div style={{ whiteSpace: 'pre-wrap' }}>
                                            {formatTranscriptContent(entry)}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                ) : null}
            </ShadowModal>

            {/* Create SideSession Modal */}
            <ShadowModal
                open={createModalOpen}
                title="＋ 新建线外持久会话 (SideSession)"
                maxWidth="600px"
                onClose={() => setCreateModalOpen(false)}
                footer={
                    <>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={creating}
                            onClick={() => setCreateModalOpen(false)}
                        >
                            取消
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            loading={creating}
                            icon={<IconPlus size={14} />}
                            onClick={() => {
                                void handleCreateSession();
                            }}
                        >
                            {creating ? '创建中…' : '创建会话'}
                        </Button>
                    </>
                }
            >
                <div class="ag-stack-v">
                    {createError ? (
                        <div class="ag-banner ag-banner-error" role="alert">
                            {createError}
                        </div>
                    ) : null}

                    <div class="ag-grid-2">
                        <FormField label="会话名称" required>
                            <TextInput
                                ariaLabel="会话名称"
                                value={newTitle}
                                placeholder="例如：林晚（加密通讯）"
                                disabled={creating}
                                onInput={setNewTitle}
                            />
                        </FormField>

                        <FormField
                            label="会话 ID (可选)"
                            hint="留空将自动生成；写卡脚本按此 ID 调用 send()"
                        >
                            <TextInput
                                ariaLabel="会话 ID"
                                value={newId}
                                placeholder="例如：phone:linwan"
                                disabled={creating}
                                onInput={setNewId}
                            />
                        </FormField>
                    </div>

                    <div class="ag-grid-2">
                        <FormField label="作用域 (Scope)">
                            <SelectInput<SideSessionScope>
                                ariaLabel="会话作用域"
                                value={newScope}
                                options={SESSION_SCOPE_OPTIONS}
                                disabled={creating}
                                onChange={setNewScope}
                            />
                        </FormField>

                        <FormField label="API 连接">
                            <SelectInput
                                ariaLabel="会话 API 连接"
                                value={newConnectionId}
                                options={connectionOptions}
                                disabled={creating}
                                onChange={setNewConnectionId}
                            />
                        </FormField>
                    </div>

                    <FormField
                        label="冻结系统提示词 (Layer 0 System Prompt)"
                        hint="创建后作为冻结静态前缀，享受显式缓存高命中率"
                    >
                        <TextAreaInput
                            ariaLabel="系统提示词"
                            value={newSystemPrompt}
                            rows={4}
                            placeholder="描述线外 NPC 身份、视野隔离边界与回复风格…"
                            disabled={creating}
                            onInput={setNewSystemPrompt}
                        />
                    </FormField>

                    <div class="ag-grid-2">
                        <FormField label="高水位压缩阈值 (High Tokens)">
                            <TextInput
                                ariaLabel="高水位阈值"
                                type="number"
                                min={1000}
                                value={newWatermarkHigh}
                                disabled={creating}
                                onInput={setNewWatermarkHigh}
                            />
                        </FormField>
                        <FormField label="低水位回落目标 (Low Tokens)">
                            <TextInput
                                ariaLabel="低水位目标"
                                type="number"
                                min={500}
                                value={newWatermarkLow}
                                disabled={creating}
                                onInput={setNewWatermarkLow}
                            />
                        </FormField>
                    </div>

                    <ToggleSwitch
                        checked={enableAutoBridge}
                        disabled={creating}
                        label="开启自动桥接到 /side/* 线索 (autoBridge)"
                        description="每轮 send() 完成后自动同步更新对应 /side/* 文档与 xxHash"
                        onChange={setEnableAutoBridge}
                    />

                    {enableAutoBridge ? (
                        <div class="ag-stack-v">
                            <div class="ag-grid-2">
                                <FormField label="桥接路径 (/side/*)" required>
                                    <TextInput
                                        ariaLabel="桥接路径"
                                        value={bridgePath}
                                        placeholder="/side/comms/linwan.md"
                                        disabled={creating}
                                        onInput={setBridgePath}
                                    />
                                </FormField>
                                <FormField label="线索标题">
                                    <TextInput
                                        ariaLabel="桥接线索标题"
                                        value={bridgeTitle}
                                        placeholder="留空则使用会话名称"
                                        disabled={creating}
                                        onInput={setBridgeTitle}
                                    />
                                </FormField>
                            </div>
                            <div class="ag-grid-2">
                                <FormField label="主线投递策略">
                                    <SelectInput<SideClueDelivery>
                                        ariaLabel="桥接投递策略"
                                        value={bridgeDelivery}
                                        options={DELIVERY_SELECT_OPTIONS}
                                        disabled={creating}
                                        onChange={setBridgeDelivery}
                                    />
                                </FormField>
                                <FormField label="写入模式">
                                    <SelectInput<'append' | 'replace'>
                                        ariaLabel="桥接写入模式"
                                        value={bridgeMode}
                                        options={AUTO_BRIDGE_MODE_OPTIONS}
                                        disabled={creating}
                                        onChange={setBridgeMode}
                                    />
                                </FormField>
                            </div>
                            <FormField label="雷达触发关键词" hint="逗号分隔">
                                <TextInput
                                    ariaLabel="桥接关键词"
                                    value={bridgeKeywordsText}
                                    placeholder="例如：林晚, 老码头, 门禁卡"
                                    disabled={creating}
                                    onInput={setBridgeKeywordsText}
                                />
                            </FormField>
                        </div>
                    ) : null}
                </div>
            </ShadowModal>
        </div>
    );
}
