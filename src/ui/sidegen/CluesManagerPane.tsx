import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
    SideClueDelivery,
    SideClueDoc,
    SideClueStatus,
} from '@/core/types';
import {
    Badge,
    Button,
    EmptyState,
    FormField,
    MasterDetailLayout,
    SegmentedControl,
    SelectInput,
    ShadowModal,
    TextAreaInput,
    TextInput,
} from '@/ui/components';
import {
    IconCheck,
    IconExport,
    IconFolder,
    IconPlus,
    IconTrash,
} from '@/ui/components/Icons';
import type { AppStore } from '@/ui/store';
import { ExportWorldInfoModal } from './ExportWorldInfoModal';
import {
    type ClueCategoryFilter,
    DELIVERY_SELECT_OPTIONS,
    STATUS_SELECT_OPTIONS,
    buildNewCluePath,
    formatAnchor,
    formatErrorMessage,
    formatShortTime,
    getClueCategoryLabel,
    getDeliveryMeta,
    getStatusMeta,
    inferClueCategory,
    parseKeywordsInput,
    useSideGenStoreSlice,
} from './sidegen-helpers';

export interface CluesManagerPaneProps {
    store: AppStore;
    isMobile: boolean;
}

const CATEGORY_FILTER_OPTIONS: readonly { value: ClueCategoryFilter; label: string }[] = [
    { value: 'all', label: '全部' },
    { value: 'comms', label: '通讯' },
    { value: 'rumors', label: '流言' },
    { value: 'notes', label: '便签' },
];

const NEW_CLUE_CATEGORY_OPTIONS: readonly { value: 'comms' | 'rumors' | 'notes'; label: string }[] = [
    { value: 'comms', label: '/side/comms/ — 远程加密通讯' },
    { value: 'rumors', label: '/side/rumors/ — 市井流言暗流' },
    { value: 'notes', label: '/side/notes/ — 线外事件便签' },
];

export function CluesManagerPane({ store, isMobile }: CluesManagerPaneProps) {
    const sideClues = useSideGenStoreSlice(store, (s) => s.sideClues);
    const selectedSideCluePath = useSideGenStoreSlice(store, (s) => s.selectedSideCluePath);
    const mobileSideGenStack = useSideGenStoreSlice(store, (s) => s.mobileSideGenStack);
    const activeTarget = useSideGenStoreSlice(store, (s) => s.activeTarget);
    const defaultDelivery = useSideGenStoreSlice(
        store,
        (s) => s.settings.offMainline?.defaultDelivery ?? 'radar_hint',
    );

    const [categoryFilter, setCategoryFilter] = useState<ClueCategoryFilter>('all');
    const [searchQuery, setSearchQuery] = useState<string>('');

    // Draft editor fields for the currently selected clue.
    const [draftTitle, setDraftTitle] = useState<string>('');
    const [draftKeywordsText, setDraftKeywordsText] = useState<string>('');
    const [draftSummary, setDraftSummary] = useState<string>('');
    const [draftBody, setDraftBody] = useState<string>('');
    const [saving, setSaving] = useState<boolean>(false);
    const [updatingMeta, setUpdatingMeta] = useState<boolean>(false);
    const [confirmingDelete, setConfirmingDelete] = useState<boolean>(false);
    const [deleting, setDeleting] = useState<boolean>(false);
    const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);

    // Create new clue modal state.
    const [createModalOpen, setCreateModalOpen] = useState<boolean>(false);
    const [newCategory, setNewCategory] = useState<'comms' | 'rumors' | 'notes'>('notes');
    const [newSlug, setNewSlug] = useState<string>('');
    const [newTitle, setNewTitle] = useState<string>('');
    const [newDelivery, setNewDelivery] = useState<SideClueDelivery>(defaultDelivery);
    const [newStatus, setNewStatus] = useState<SideClueStatus>('dormant');
    const [newKeywordsText, setNewKeywordsText] = useState<string>('');
    const [newSummary, setNewSummary] = useState<string>('');
    const [newBody, setNewBody] = useState<string>('');
    const [creating, setCreating] = useState<boolean>(false);
    const [createError, setCreateError] = useState<string | null>(null);

    const filteredClues = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return sideClues.filter((clue) => {
            if (categoryFilter !== 'all' && inferClueCategory(clue.path) !== categoryFilter) {
                return false;
            }
            if (!query) {
                return true;
            }
            return (
                clue.path.toLowerCase().includes(query)
                || clue.meta.title.toLowerCase().includes(query)
                || clue.meta.summary.toLowerCase().includes(query)
                || clue.meta.keywords.some((kw) => kw.toLowerCase().includes(query))
            );
        });
    }, [categoryFilter, searchQuery, sideClues]);

    const selectedClue = useMemo<SideClueDoc | null>(() => {
        if (selectedSideCluePath) {
            const exact = sideClues.find((c) => c.path === selectedSideCluePath);
            if (exact) {
                return exact;
            }
        }
        return filteredClues[0] ?? sideClues[0] ?? null;
    }, [filteredClues, selectedSideCluePath, sideClues]);

    const selectedClueKeywordsKey = selectedClue ? selectedClue.meta.keywords.join('\0') : '';

    // Sync local draft when switching clues or when persisted title/keywords/summary/body change,
    // without wiping unsaved text edits when only delivery/status metadata toggles.
    useEffect(() => {
        if (!selectedClue) {
            setDraftTitle('');
            setDraftKeywordsText('');
            setDraftSummary('');
            setDraftBody('');
            setConfirmingDelete(false);
            return;
        }
        setDraftTitle(selectedClue.meta.title);
        setDraftKeywordsText(selectedClue.meta.keywords.join(', '));
        setDraftSummary(selectedClue.meta.summary);
        setDraftBody(selectedClue.body);
        setConfirmingDelete(false);
    }, [
        selectedClue?.path,
        selectedClue?.meta.title,
        selectedClue?.meta.summary,
        selectedClueKeywordsKey,
        selectedClue?.body,
    ]);

    const parsedDraftKeywords = useMemo(
        () => parseKeywordsInput(draftKeywordsText),
        [draftKeywordsText],
    );

    const hasUnsavedChanges = useMemo(() => {
        if (!selectedClue) {
            return false;
        }
        const origKeywords = selectedClue.meta.keywords.join(', ');
        return (
            draftTitle !== selectedClue.meta.title
            || draftSummary !== selectedClue.meta.summary
            || draftBody !== selectedClue.body
            || parsedDraftKeywords.join(', ') !== parseKeywordsInput(origKeywords).join(', ')
        );
    }, [draftBody, draftSummary, draftTitle, parsedDraftKeywords, selectedClue]);

    const handleSelectClue = (clue: SideClueDoc) => {
        setConfirmingDelete(false);
        if (isMobile) {
            store.openSideClue(clue.path);
        } else {
            store.setSelectedSideCluePath(clue.path);
        }
    };

    const handleDeliveryChange = async (nextDelivery: SideClueDelivery) => {
        if (!selectedClue || updatingMeta || nextDelivery === selectedClue.meta.delivery) {
            return;
        }
        const metaInfo = getDeliveryMeta(nextDelivery);
        const runtime = store.getSideGenRuntime();

        setUpdatingMeta(true);
        try {
            if (runtime) {
                await runtime.clues.updateDelivery(selectedClue.path, nextDelivery, activeTarget);
                await store.refreshSideGenState(activeTarget);
            } else {
                const updated: SideClueDoc = {
                    ...selectedClue,
                    meta: {
                        ...selectedClue.meta,
                        delivery: nextDelivery,
                        updatedAt: Date.now(),
                    },
                };
                store.setSideClues(
                    sideClues.map((c) => (c.path === selectedClue.path ? updated : c)),
                );
            }
            store.pushToast(`已更新投递策略：${metaInfo.shortLabel}`, 'success');
        } catch (err) {
            store.pushToast(`更新投递策略失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setUpdatingMeta(false);
        }
    };

    const handleStatusChange = async (nextStatus: SideClueStatus) => {
        if (!selectedClue || updatingMeta || nextStatus === selectedClue.meta.status) {
            return;
        }
        const statusInfo = getStatusMeta(nextStatus);
        const runtime = store.getSideGenRuntime();

        setUpdatingMeta(true);
        try {
            if (runtime) {
                await runtime.clues.updateStatus(selectedClue.path, nextStatus, activeTarget);
                await store.refreshSideGenState(activeTarget);
            } else {
                const updated: SideClueDoc = {
                    ...selectedClue,
                    meta: {
                        ...selectedClue.meta,
                        status: nextStatus,
                        updatedAt: Date.now(),
                    },
                };
                store.setSideClues(
                    sideClues.map((c) => (c.path === selectedClue.path ? updated : c)),
                );
            }
            store.pushToast(`线索状态已更新：${statusInfo.shortLabel}`, 'primary');
        } catch (err) {
            store.pushToast(`更新线索状态失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setUpdatingMeta(false);
        }
    };

    const handleSaveDetail = async () => {
        if (!selectedClue || saving) {
            return;
        }
        const runtime = store.getSideGenRuntime();
        const cleanedTitle = draftTitle.trim() || selectedClue.meta.title || selectedClue.path;

        setSaving(true);
        try {
            if (runtime) {
                await runtime.clues.write({
                    path: selectedClue.path,
                    id: selectedClue.meta.id,
                    title: cleanedTitle,
                    delivery: selectedClue.meta.delivery,
                    status: selectedClue.meta.status,
                    keywords: parsedDraftKeywords,
                    secondaryKeys: selectedClue.meta.secondaryKeys,
                    scanDepth: selectedClue.meta.scanDepth,
                    order: selectedClue.meta.order,
                    summary: draftSummary.trim(),
                    sourceSessionId: selectedClue.meta.sourceSessionId,
                    anchor: selectedClue.meta.anchor,
                    body: draftBody,
                    target: activeTarget,
                });
                await store.refreshSideGenState(activeTarget);
            } else {
                const updated: SideClueDoc = {
                    ...selectedClue,
                    meta: {
                        ...selectedClue.meta,
                        title: cleanedTitle,
                        keywords: parsedDraftKeywords,
                        summary: draftSummary.trim(),
                        updatedAt: Date.now(),
                    },
                    body: draftBody,
                };
                store.setSideClues(
                    sideClues.map((c) => (c.path === selectedClue.path ? updated : c)),
                );
            }
            store.pushToast(`已保存线索：${selectedClue.path}`, 'success');
        } catch (err) {
            store.pushToast(`保存线索失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleResetDraft = () => {
        if (!selectedClue) {
            return;
        }
        setDraftTitle(selectedClue.meta.title);
        setDraftKeywordsText(selectedClue.meta.keywords.join(', '));
        setDraftSummary(selectedClue.meta.summary);
        setDraftBody(selectedClue.body);
    };

    const handleDeleteClue = async () => {
        if (!selectedClue || deleting) {
            return;
        }
        const targetPath = selectedClue.path;
        const runtime = store.getSideGenRuntime();

        setDeleting(true);
        try {
            if (runtime) {
                await runtime.clues.delete(targetPath, activeTarget);
                await store.refreshSideGenState(activeTarget);
            } else {
                store.setSideClues(sideClues.filter((c) => c.path !== targetPath));
            }
            setConfirmingDelete(false);
            if (isMobile) {
                store.backToSideClueList();
            }
            store.pushToast(`已删除线索：${targetPath}`, 'warning');
        } catch (err) {
            store.pushToast(`删除线索失败：${formatErrorMessage(err)}`, 'error');
        } finally {
            setDeleting(false);
        }
    };

    const openCreateModal = () => {
        setNewCategory(categoryFilter === 'all' ? 'notes' : categoryFilter);
        setNewSlug('');
        setNewTitle('');
        setNewDelivery(defaultDelivery);
        setNewStatus('dormant');
        setNewKeywordsText('');
        setNewSummary('');
        setNewBody('');
        setCreateError(null);
        setCreateModalOpen(true);
    };

    const previewNewPath = useMemo(
        () => buildNewCluePath(newCategory, newSlug || 'new-clue'),
        [newCategory, newSlug],
    );

    const handleCreateClue = async () => {
        if (creating) {
            return;
        }
        const trimmedTitle = newTitle.trim();
        const trimmedBody = newBody.trim();
        if (!trimmedTitle) {
            setCreateError('请填写线索标题。');
            return;
        }
        if (!trimmedBody && !newSummary.trim()) {
            setCreateError('请至少填写线索摘要或正文内容。');
            return;
        }

        const resolvedPath = buildNewCluePath(newCategory, newSlug || trimmedTitle);
        const keywords = parseKeywordsInput(newKeywordsText);
        const runtime = store.getSideGenRuntime();

        setCreating(true);
        setCreateError(null);
        try {
            if (runtime) {
                const written = await runtime.clues.write({
                    path: resolvedPath,
                    title: trimmedTitle,
                    delivery: newDelivery,
                    status: newStatus,
                    keywords,
                    summary: newSummary.trim() || trimmedBody.slice(0, 120),
                    body: trimmedBody || newSummary.trim(),
                    target: activeTarget,
                });
                await store.refreshSideGenState(activeTarget);
                if (isMobile) {
                    store.openSideClue(written.path);
                } else {
                    store.setSelectedSideCluePath(written.path);
                }
                store.pushToast(`已新建线索：${written.path}`, 'success');
            } else {
                const now = Date.now();
                const localDoc: SideClueDoc = {
                    path: resolvedPath,
                    meta: {
                        id: `clue_${now.toString(36)}`,
                        title: trimmedTitle,
                        delivery: newDelivery,
                        status: newStatus,
                        keywords,
                        summary: newSummary.trim() || trimmedBody.slice(0, 120),
                        anchor: `${activeTarget.messageId}#${activeTarget.swipeId}`,
                        createdAt: now,
                        updatedAt: now,
                    },
                    body: trimmedBody || newSummary.trim(),
                    contentHash: `local_${now.toString(36)}`,
                };
                const existingIdx = sideClues.findIndex((c) => c.path === localDoc.path);
                const nextList =
                    existingIdx >= 0
                        ? sideClues.map((c, idx) => (idx === existingIdx ? localDoc : c))
                        : [...sideClues, localDoc];
                store.setSideClues(nextList);
                if (isMobile) {
                    store.openSideClue(localDoc.path);
                } else {
                    store.setSelectedSideCluePath(localDoc.path);
                }
                store.pushToast(`已在预览态创建线索：${localDoc.path}`, 'primary');
            }
            setCreateModalOpen(false);
        } catch (err) {
            const msg = formatErrorMessage(err);
            setCreateError(`创建失败：${msg}`);
            store.pushToast(`新建线索失败：${msg}`, 'error');
        } finally {
            setCreating(false);
        }
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px', gap: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <SegmentedControl<ClueCategoryFilter>
                    ariaLabel="线索分类筛选"
                    value={categoryFilter}
                    options={CATEGORY_FILTER_OPTIONS}
                    onChange={setCategoryFilter}
                />
                <Button
                    variant="primary"
                    size="sm"
                    icon={<IconPlus size={14} />}
                    onClick={openCreateModal}
                >
                    新建线索
                </Button>
            </div>

            <TextInput
                type="search"
                ariaLabel="搜索 /side/* 线索"
                value={searchQuery}
                placeholder="筛选标题、路径或关键词…"
                onInput={setSearchQuery}
            />

            {filteredClues.length === 0 ? (
                <EmptyState
                    icon={<IconFolder size={20} />}
                    title={sideClues.length === 0 ? '暂无 /side/* 线外线索' : '没有匹配的线索'}
                    description={
                        sideClues.length === 0
                            ? '点击「新建线索」手工添加伏笔，或由写卡脚本经 Agentic.sideGen 自动桥接写入。'
                            : '尝试切换分类或清空搜索关键词。'
                    }
                    action={
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconPlus size={14} />}
                            onClick={openCreateModal}
                        >
                            新建线索
                        </Button>
                    }
                />
            ) : (
                <div class="ag-list" style={{ padding: 0 }}>
                    {filteredClues.map((clue) => {
                        const isSelected = !isMobile && selectedClue?.path === clue.path;
                        const deliveryMeta = getDeliveryMeta(clue.meta.delivery);
                        const statusMeta = getStatusMeta(clue.meta.status);
                        const categoryLabel = getClueCategoryLabel(inferClueCategory(clue.path));
                        const previewKeywords = clue.meta.keywords.slice(0, 3);
                        const extraKeywords = Math.max(0, clue.meta.keywords.length - previewKeywords.length);

                        return (
                            <button
                                key={clue.path}
                                type="button"
                                data-clue-path={clue.path}
                                class={
                                    isSelected
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                onClick={() => handleSelectClue(clue)}
                            >
                                <div
                                    class="ag-row"
                                    style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                                >
                                    <span class="ag-list-item-title">
                                        {clue.meta.title || clue.path}
                                    </span>
                                    <span class={deliveryMeta.pillClass} style={{ flexShrink: 0 }}>
                                        {deliveryMeta.shortLabel}
                                    </span>
                                </div>

                                <div
                                    class="ag-mono"
                                    style={{
                                        fontSize: '11px',
                                        color: 'var(--primary)',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {clue.path}
                                </div>

                                {previewKeywords.length > 0 ? (
                                    <div class="ag-side-keyword-list" style={{ gap: '4px', marginTop: '2px' }}>
                                        {previewKeywords.map((kw) => (
                                            <span key={kw} class="ag-pill ag-pill-primary">
                                                {kw}
                                            </span>
                                        ))}
                                        {extraKeywords > 0 ? (
                                            <span class="ag-pill ag-pill-muted">+{extraKeywords}</span>
                                        ) : null}
                                    </div>
                                ) : null}

                                <div class="ag-list-item-meta" style={{ marginTop: '2px' }}>
                                    <span class="ag-row" style={{ gap: '6px' }}>
                                        <span class={statusMeta.pillClass}>{statusMeta.shortLabel}</span>
                                        <span>{categoryLabel}</span>
                                    </span>
                                    <span class="ag-mono">
                                        {formatAnchor(clue.meta.anchor)}
                                        {clue.meta.consumedByTurn !== undefined
                                            ? ` · 已消费@${clue.meta.consumedByTurn}`
                                            : ''}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const detailPane = selectedClue ? (
        <div class="ag-stack-v" style={{ padding: '14px' }}>
            <div class="ag-side-clue-meta">
                <div class="ag-min-w-0" style={{ flex: '1 1 auto' }}>
                    <div
                        style={{
                            fontSize: '15px',
                            fontWeight: 700,
                            wordBreak: 'break-word',
                        }}
                    >
                        {selectedClue.meta.title || selectedClue.path}
                    </div>
                    <div
                        class="ag-mono"
                        style={{
                            fontSize: '11px',
                            color: 'var(--primary)',
                            wordBreak: 'break-all',
                            marginTop: '2px',
                        }}
                    >
                        {selectedClue.path}
                    </div>
                    <div class="ag-row-wrap" style={{ marginTop: '6px', gap: '6px' }}>
                        <Badge tone="neutral">锚点 {formatAnchor(selectedClue.meta.anchor)}</Badge>
                        {selectedClue.meta.sourceSessionId ? (
                            <Badge tone="primary">来源 {selectedClue.meta.sourceSessionId}</Badge>
                        ) : null}
                        {selectedClue.meta.consumedByTurn !== undefined ? (
                            <Badge tone="warning">
                                已于第 {selectedClue.meta.consumedByTurn} 轮消费
                            </Badge>
                        ) : null}
                        <Badge tone="neutral" title={`内容哈希：${selectedClue.contentHash}`}>
                            Hash {selectedClue.contentHash.slice(0, 8)}
                        </Badge>
                        <span style={{ fontSize: '11px', color: 'var(--muted-foreground)' }}>
                            更新于 {formatShortTime(selectedClue.meta.updatedAt)}
                        </span>
                    </div>
                </div>

                <Button
                    variant="secondary"
                    size="sm"
                    icon={<IconExport size={14} />}
                    onClick={() => setExportModalOpen(true)}
                >
                    📤 导出到世界书
                </Button>
            </div>

            <div class="ag-grid-2">
                <FormField
                    label="主线投递策略 (4 档即时生效)"
                    hint={getDeliveryMeta(selectedClue.meta.delivery).description}
                >
                    <SelectInput<SideClueDelivery>
                        ariaLabel="主线投递策略"
                        value={selectedClue.meta.delivery}
                        options={DELIVERY_SELECT_OPTIONS}
                        disabled={updatingMeta}
                        onChange={(val) => {
                            void handleDeliveryChange(val);
                        }}
                    />
                </FormField>

                <FormField
                    label="线索状态 (即时生效)"
                    hint="控制线索生命周期：潜伏中 / 主线已感知 / 已回收归档"
                >
                    <SelectInput<SideClueStatus>
                        ariaLabel="线索状态"
                        value={selectedClue.meta.status}
                        options={STATUS_SELECT_OPTIONS}
                        disabled={updatingMeta}
                        onChange={(val) => {
                            void handleStatusChange(val);
                        }}
                    />
                </FormField>
            </div>

            <FormField label="线索标题 (Title)">
                <TextInput
                    ariaLabel="线索标题"
                    value={draftTitle}
                    placeholder="为该 /side/* 线索命名"
                    disabled={saving}
                    onInput={setDraftTitle}
                />
            </FormField>

            <FormField
                label="雷达触发关键词 (Keywords)"
                hint="逗号（, 或 ，）分隔；仅在 radar_hint 模式下由 TailRadar 扫描"
            >
                <TextInput
                    ariaLabel="雷达触发关键词"
                    value={draftKeywordsText}
                    placeholder="例如：老码头, 灯塔, 林晚, 门禁卡"
                    disabled={saving}
                    onInput={setDraftKeywordsText}
                />
                {parsedDraftKeywords.length > 0 ? (
                    <div class="ag-side-keyword-list" style={{ marginTop: '6px' }}>
                        {parsedDraftKeywords.map((kw) => (
                            <span key={kw} class="ag-pill ag-pill-primary ag-mono">
                                {kw}
                            </span>
                        ))}
                    </div>
                ) : null}
            </FormField>

            <FormField
                label="精炼摘要 (Summary)"
                hint="用于 TailRadar <side-hint> 或伴生模式轻量提示"
            >
                <TextInput
                    ariaLabel="精炼摘要"
                    value={draftSummary}
                    placeholder="一句话概括线索核心事实"
                    disabled={saving}
                    onInput={setDraftSummary}
                />
            </FormField>

            <FormField
                label="线索正文 (Markdown · 主 Agent 按需 read_file 获取)"
                hint="所有写入均严格绑定当前因果分支锚点"
            >
                <TextAreaInput
                    ariaLabel="线索正文"
                    value={draftBody}
                    rows={7}
                    placeholder="输入 Markdown 线索正文…"
                    disabled={saving}
                    className="ag-mono"
                    onInput={setDraftBody}
                />
            </FormField>

            <div
                class="ag-row-wrap"
                style={{
                    justifyContent: 'space-between',
                    paddingTop: '8px',
                    borderTop: '1px solid var(--border)',
                }}
            >
                <div class="ag-row-wrap">
                    {confirmingDelete ? (
                        <>
                            <span style={{ fontSize: '12px', color: 'var(--error)', fontWeight: 600 }}>
                                确认删除该线索？
                            </span>
                            <Button
                                variant="danger"
                                size="sm"
                                loading={deleting}
                                onClick={() => {
                                    void handleDeleteClue();
                                }}
                            >
                                确认删除
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={deleting}
                                onClick={() => setConfirmingDelete(false)}
                            >
                                取消
                            </Button>
                        </>
                    ) : (
                        <Button
                            variant="danger"
                            size="sm"
                            icon={<IconTrash size={14} />}
                            onClick={() => setConfirmingDelete(true)}
                        >
                            删除线索
                        </Button>
                    )}
                </div>

                <div class="ag-row-wrap">
                    {hasUnsavedChanges ? (
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={saving}
                            onClick={handleResetDraft}
                        >
                            撤销修改
                        </Button>
                    ) : null}
                    <Button
                        variant="primary"
                        size="sm"
                        loading={saving}
                        disabled={!hasUnsavedChanges && !saving}
                        icon={<IconCheck size={14} />}
                        onClick={() => {
                            void handleSaveDetail();
                        }}
                    >
                        {saving ? '保存中…' : '保存修改'}
                    </Button>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <>
            <MasterDetailLayout
                master={masterPane}
                detail={detailPane}
                detailOpen={mobileSideGenStack === 'detail'}
                onDetailOpenChange={(open) => {
                    store.setMobileSideGenStack(open ? 'detail' : 'list');
                }}
                detailTitle={selectedClue?.meta.title || selectedClue?.path || '线索详情'}
                backLabel="返回"
                isMobile={isMobile}
                emptyDetailTitle="请选择或新建一条 /side/* 线索"
                emptyDetailDescription="所有 /side/* 线索按因果分支隔离存储，可根据 4 档投递策略按需浮现到主线。"
            />

            <ExportWorldInfoModal
                open={exportModalOpen}
                clue={selectedClue}
                store={store}
                hasUnsavedChanges={hasUnsavedChanges}
                onClose={() => setExportModalOpen(false)}
            />

            <ShadowModal
                open={createModalOpen}
                title="＋ 新建 /side/* 线外线索"
                maxWidth="580px"
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
                                void handleCreateClue();
                            }}
                        >
                            {creating ? '创建中…' : '创建线索'}
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
                        <FormField label="线索目录分类">
                            <SelectInput<'comms' | 'rumors' | 'notes'>
                                ariaLabel="线索目录分类"
                                value={newCategory}
                                options={NEW_CLUE_CATEGORY_OPTIONS}
                                disabled={creating}
                                onChange={setNewCategory}
                            />
                        </FormField>

                        <FormField
                            label="文件名 / 路径标识"
                            hint={`将写入：${previewNewPath}`}
                        >
                            <TextInput
                                ariaLabel="文件名或路径标识"
                                value={newSlug}
                                placeholder="例如：linwan.md 或 dock-rumor"
                                disabled={creating}
                                onInput={setNewSlug}
                            />
                        </FormField>
                    </div>

                    <FormField label="线索标题" required>
                        <TextInput
                            ariaLabel="新建线索标题"
                            value={newTitle}
                            placeholder="例如：林晚的加密通讯线索"
                            disabled={creating}
                            onInput={setNewTitle}
                        />
                    </FormField>

                    <div class="ag-grid-2">
                        <FormField label="主线投递策略">
                            <SelectInput<SideClueDelivery>
                                ariaLabel="新建线索投递策略"
                                value={newDelivery}
                                options={DELIVERY_SELECT_OPTIONS}
                                disabled={creating}
                                onChange={setNewDelivery}
                            />
                        </FormField>

                        <FormField label="初始状态">
                            <SelectInput<SideClueStatus>
                                ariaLabel="新建线索状态"
                                value={newStatus}
                                options={STATUS_SELECT_OPTIONS}
                                disabled={creating}
                                onChange={setNewStatus}
                            />
                        </FormField>
                    </div>

                    <FormField label="雷达触发关键词" hint="逗号分隔，用于 radar_hint 关键词匹配">
                        <TextInput
                            ariaLabel="新建线索关键词"
                            value={newKeywordsText}
                            placeholder="例如：老码头, 灯塔, 门禁卡"
                            disabled={creating}
                            onInput={setNewKeywordsText}
                        />
                    </FormField>

                    <FormField label="精炼摘要">
                        <TextInput
                            ariaLabel="新建线索摘要"
                            value={newSummary}
                            placeholder="一句话总结该伏笔的核心内容"
                            disabled={creating}
                            onInput={setNewSummary}
                        />
                    </FormField>

                    <FormField label="线索正文 (Markdown)" required>
                        <TextAreaInput
                            ariaLabel="新建线索正文"
                            value={newBody}
                            rows={5}
                            placeholder="输入详细记录、短信内容或暗线推演正文…"
                            disabled={creating}
                            className="ag-mono"
                            onInput={setNewBody}
                        />
                    </FormField>
                </div>
            </ShadowModal>
        </>
    );
}
