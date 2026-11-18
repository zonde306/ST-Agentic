import { diffLines } from 'diff';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { MessageTarget } from '@/core/types';
import {
    Badge,
    Button,
    CodeEditor,
    EmptyState,
    MasterDetailLayout,
    SegmentedControl,
    TextInput,
} from '@/ui/components';
import {
    IconCheck,
    IconCopy,
    IconFolder,
    IconRefresh,
    IconTrash,
} from '@/ui/components/Icons';
import type {
    ConsoleViewProps,
    FileOverrideCategory,
    FileOverrideItem,
} from '@/ui/store';
import {
    copyTextToClipboard,
    getCategoryLabel,
    getCategoryTone,
    useStoreSlice,
} from './shared';

type CategoryFilter = 'all' | FileOverrideCategory;
type EditorViewMode = 'edit' | 'diff';

interface DiffLineRow {
    kind: 'add' | 'del' | 'context';
    prefix: '+' | '-' | ' ';
    text: string;
}

const CATEGORY_FILTERS: readonly { id: CategoryFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'workspace', label: '工作区' },
    { id: 'variables', label: '变量' },
    { id: 'worldinfo', label: 'WI覆写' },
    { id: 'message', label: '展示层' },
];

function inferLanguageHint(
    item: FileOverrideItem,
): 'json' | 'javascript' | 'markdown' | 'yaml' | 'regex' | 'text' {
    if (item.category === 'variables' || item.path.endsWith('.json')) {
        return 'json';
    }
    if (item.path.endsWith('.md')) {
        return 'markdown';
    }
    if (item.path.endsWith('.js') || item.path.endsWith('.ts')) {
        return 'javascript';
    }
    if (item.path.endsWith('.yaml') || item.path.endsWith('.yml')) {
        return 'yaml';
    }
    return 'text';
}

function splitDiffChunkLines(value: string): string[] {
    if (!value) {
        return [];
    }
    const parts = value.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop();
    }
    return parts;
}

function buildDiffRows(baseContent: string, currentContent: string): {
    rows: DiffLineRow[];
    addedCount: number;
    removedCount: number;
} {
    const changes = diffLines(baseContent, currentContent, { stripTrailingCr: true });
    const rows: DiffLineRow[] = [];
    let addedCount = 0;
    let removedCount = 0;

    for (const part of changes) {
        const lines = splitDiffChunkLines(part.value);
        if (part.added) {
            addedCount += lines.length;
            for (const text of lines) {
                rows.push({ kind: 'add', prefix: '+', text });
            }
        } else if (part.removed) {
            removedCount += lines.length;
            for (const text of lines) {
                rows.push({ kind: 'del', prefix: '-', text });
            }
        } else {
            for (const text of lines) {
                rows.push({ kind: 'context', prefix: ' ', text });
            }
        }
    }

    return { rows, addedCount, removedCount };
}

function matchDeepLinkItem(item: FileOverrideItem, filePath: string): boolean {
    return item.path === filePath || item.id === filePath || item.key === filePath;
}

export function FilesOverridesView({ store, isMobile }: ConsoleViewProps) {
    const deepLink = useStoreSlice(store, (s) => s.deepLink);
    const activeTarget = useStoreSlice(store, (s) => s.activeTarget);

    const [items, setItems] = useState<FileOverrideItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);

    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [scopeByTarget, setScopeByTarget] = useState<boolean>(
        () => deepLink.messageId !== undefined,
    );
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [viewMode, setViewMode] = useState<EditorViewMode>(
        () => deepLink.viewMode ?? 'edit',
    );
    const [draftContent, setDraftContent] = useState('');

    const lastDeepLinkSigRef = useRef<string>('');
    const consumedDeepLinkFileRef = useRef<string | null>(null);
    const selectedIdRef = useRef<string | null>(selectedId);
    selectedIdRef.current = selectedId;

    const effectiveTarget: MessageTarget = useMemo(
        () => ({
            messageId: deepLink.messageId ?? activeTarget.messageId,
            swipeId: deepLink.swipeId ?? activeTarget.swipeId,
        }),
        [activeTarget.messageId, activeTarget.swipeId, deepLink.messageId, deepLink.swipeId],
    );

    const loadFiles = useCallback(
        async (targetArg?: MessageTarget) => {
            setLoading(true);
            setErrorText(null);
            try {
                const fetched = await store.services.listFilesAndOverrides(targetArg);
                setItems(fetched);
                setSelectedId((prev) => {
                    if (prev && fetched.some((item) => item.id === prev)) {
                        return prev;
                    }
                    return fetched[0]?.id ?? null;
                });
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                setErrorText(`加载文件与覆盖列表失败：${msg}`);
            } finally {
                setLoading(false);
            }
        },
        [store],
    );

    useEffect(() => {
        void loadFiles(scopeByTarget ? effectiveTarget : undefined);
    }, [effectiveTarget, loadFiles, scopeByTarget]);

    // Sync viewMode, scope, and selected item when deepLink updates.
    useEffect(() => {
        const sig = JSON.stringify({
            messageId: deepLink.messageId,
            swipeId: deepLink.swipeId,
            filePath: deepLink.filePath,
            viewMode: deepLink.viewMode,
        });
        if (sig === lastDeepLinkSigRef.current) {
            return;
        }
        lastDeepLinkSigRef.current = sig;

        if (deepLink.viewMode) {
            setViewMode(deepLink.viewMode);
        }
        if (deepLink.messageId !== undefined) {
            setScopeByTarget(true);
        }
        if (deepLink.filePath) {
            setCategoryFilter('all');
            consumedDeepLinkFileRef.current = null;
            const matched = items.find((item) => matchDeepLinkItem(item, deepLink.filePath!));
            if (matched) {
                consumedDeepLinkFileRef.current = deepLink.filePath;
                setSelectedId(matched.id);
                setDetailOpen(true);
            }
        } else {
            consumedDeepLinkFileRef.current = null;
            if (deepLink.messageId !== undefined && items.length > 0) {
                const byMessage = items.find((item) => item.target.messageId === deepLink.messageId);
                if (byMessage) {
                    setSelectedId(byMessage.id);
                }
            }
        }
    }, [deepLink, items]);

    // If deepLink.filePath arrived before `items` finished loading, select once items arrive.
    useEffect(() => {
        if (
            !deepLink.filePath
            || items.length === 0
            || consumedDeepLinkFileRef.current === deepLink.filePath
        ) {
            return;
        }
        const matched = items.find((item) => matchDeepLinkItem(item, deepLink.filePath!));
        if (matched) {
            consumedDeepLinkFileRef.current = deepLink.filePath;
            if (selectedIdRef.current !== matched.id) {
                setCategoryFilter('all');
                setSelectedId(matched.id);
            }
            setDetailOpen(true);
        }
    }, [deepLink.filePath, items]);

    const filteredItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return items.filter((item) => {
            if (categoryFilter !== 'all' && item.category !== categoryFilter) {
                return false;
            }
            if (!query) {
                return true;
            }
            return (
                item.path.toLowerCase().includes(query)
                || item.source.toLowerCase().includes(query)
                || item.layerLabel.toLowerCase().includes(query)
            );
        });
    }, [categoryFilter, items, searchQuery]);

    const selectedItem = useMemo(
        () => filteredItems.find((item) => item.id === selectedId)
            ?? items.find((item) => item.id === selectedId)
            ?? filteredItems[0]
            ?? null,
        [filteredItems, items, selectedId],
    );

    useEffect(() => {
        setDraftContent(selectedItem?.content ?? '');
    }, [selectedItem?.id, selectedItem?.content]);

    const hasUnsavedChanges = Boolean(
        selectedItem && draftContent !== selectedItem.content,
    );

    const diffSummary = useMemo(() => {
        if (!selectedItem || viewMode !== 'diff') {
            return null;
        }
        return buildDiffRows(selectedItem.baseContent ?? '', draftContent);
    }, [draftContent, selectedItem, viewMode]);

    const handleSelectItem = (item: FileOverrideItem) => {
        setSelectedId(item.id);
        setDetailOpen(true);
    };

    const handleSave = async () => {
        if (!selectedItem || !selectedItem.writable || saving) {
            return;
        }
        setSaving(true);
        try {
            const saved = await store.services.saveFileOrOverride({
                path: selectedItem.path,
                namespace: selectedItem.namespace,
                key: selectedItem.key,
                content: draftContent,
                target: selectedItem.target,
            });
            setItems((prev) =>
                prev.map((item) => (item.id === selectedItem.id ? { ...item, ...saved } : item)),
            );
            setDraftContent(saved.content);
            store.pushToast(`已保存至分支 ${saved.layerLabel}：${saved.path}`, 'success');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`保存失败：${msg}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const handleCopy = async () => {
        if (!selectedItem) {
            return;
        }
        const ok = await copyTextToClipboard(draftContent);
        store.pushToast(
            ok ? `已复制 ${selectedItem.path} 内容到剪贴板` : '剪贴板不可用，复制失败',
            ok ? 'success' : 'warning',
        );
    };

    const handleRequestRestoreOrDelete = () => {
        if (!selectedItem) {
            return;
        }
        const isWorldInfo = selectedItem.category === 'worldinfo';
        store.openModal({
            kind: 'confirm',
            title: isWorldInfo ? '确认恢复世界书原文' : '确认删除当前分支覆写',
            message: isWorldInfo
                ? `确定清除 ${selectedItem.path} 在 ${selectedItem.layerLabel} 的覆写并恢复原书内容吗？`
                : `确定清除 ${selectedItem.path} 在 ${selectedItem.layerLabel} 的当前覆写/文件吗？`,
            confirmLabel: isWorldInfo ? '恢复原书' : '确认删除',
            cancelLabel: '取消',
            tone: 'danger',
            onConfirm: async () => {
                await store.services.deleteFileOrOverride({
                    path: selectedItem.path,
                    namespace: selectedItem.namespace,
                    key: selectedItem.key,
                    target: selectedItem.target,
                });
                await loadFiles(scopeByTarget ? effectiveTarget : undefined);
                store.pushToast(
                    isWorldInfo
                        ? `已清除覆写并恢复原书：${selectedItem.path}`
                        : `已移除当前层覆写：${selectedItem.path}`,
                    'warning',
                );
            },
        });
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px', gap: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <div class="ag-row-wrap" style={{ gap: '6px' }}>
                    {CATEGORY_FILTERS.map((cat) => (
                        <Button
                            key={cat.id}
                            size="sm"
                            variant={categoryFilter === cat.id ? 'primary' : 'secondary'}
                            active={categoryFilter === cat.id}
                            onClick={() => setCategoryFilter(cat.id)}
                        >
                            {cat.label}
                        </Button>
                    ))}
                </div>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconRefresh size={14} />}
                    ariaLabel="刷新文件列表"
                    title="刷新文件列表"
                    loading={loading}
                    onClick={() => void loadFiles(scopeByTarget ? effectiveTarget : undefined)}
                />
            </div>

            <div class="ag-row-wrap" style={{ gap: '6px' }}>
                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                    <TextInput
                        type="search"
                        value={searchQuery}
                        placeholder="搜索路径 / 来源 / 层级..."
                        ariaLabel="搜索文件或覆写"
                        onInput={setSearchQuery}
                    />
                </div>
                <Button
                    size="sm"
                    variant={scopeByTarget ? 'primary' : 'secondary'}
                    active={scopeByTarget}
                    title="切换仅看目标因果分支或全部会话"
                    onClick={() => setScopeByTarget((prev) => !prev)}
                >
                    {scopeByTarget
                        ? `分支 #${effectiveTarget.messageId}#${effectiveTarget.swipeId}`
                        : '全部层'}
                </Button>
            </div>

            {errorText ? <div class="ag-banner ag-banner-error">{errorText}</div> : null}

            {loading && items.length === 0 ? (
                <EmptyState
                    icon={<IconFolder size={20} />}
                    title="正在加载工作区与覆写层..."
                />
            ) : filteredItems.length === 0 ? (
                <EmptyState
                    icon={<IconFolder size={20} />}
                    title="暂无匹配的文件或覆写"
                    description="可切换分类筛选、取消目标分支限定，或在聊天中产生变量/WI 写入后再查看。"
                />
            ) : (
                <div class="ag-list" style={{ padding: 0 }}>
                    {filteredItems.map((item) => {
                        const isActive = selectedItem?.id === item.id;
                        const isTargetMatch =
                            deepLink.messageId !== undefined
                            && item.target.messageId === deepLink.messageId;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                class={
                                    isActive && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                onClick={() => handleSelectItem(item)}
                            >
                                <div class="ag-row" style={{ justifyContent: 'space-between' }}>
                                    <span
                                        class="ag-list-item-title ag-mono"
                                        style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                        title={item.path}
                                    >
                                        {item.path}
                                    </span>
                                    <Badge tone={getCategoryTone(item.category)}>
                                        {getCategoryLabel(item.category)}
                                    </Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span
                                        style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                    >
                                        {item.source}
                                    </span>
                                    <span class="ag-row" style={{ gap: '4px', flexShrink: 0 }}>
                                        {isTargetMatch ? (
                                            <Badge tone="primary">定位</Badge>
                                        ) : null}
                                        <Badge tone={item.overridden ? 'success' : 'neutral'}>
                                            {item.layerLabel}
                                        </Badge>
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const detailPane = selectedItem ? (
        <div
            class="ag-stack-v"
            style={{
                padding: isMobile ? '12px' : '14px',
                height: '100%',
                minHeight: 0,
            }}
        >
            <div
                class="ag-card"
                style={{ flexShrink: 0 }}
            >
                <div class="ag-card-header">
                    <div class="ag-card-headings" style={{ minWidth: 0, flex: '1 1 220px' }}>
                        <div
                            class="ag-card-title ag-mono"
                            style={{ wordBreak: 'break-all' }}
                        >
                            {selectedItem.path}
                        </div>
                        <div class="ag-card-subtitle ag-row-wrap" style={{ marginTop: '4px' }}>
                            <Badge tone={getCategoryTone(selectedItem.category)}>
                                {getCategoryLabel(selectedItem.category)}
                            </Badge>
                            <span>归属层：{selectedItem.layerLabel}</span>
                            <span>来源：{selectedItem.source}</span>
                            <Badge tone={selectedItem.overridden ? 'success' : 'neutral'}>
                                {selectedItem.overridden ? '已覆写' : '基线原文'}
                            </Badge>
                            {hasUnsavedChanges ? (
                                <Badge tone="warning">未保存修改</Badge>
                            ) : null}
                        </div>
                    </div>

                    <div class="ag-card-actions">
                        <SegmentedControl<EditorViewMode>
                            ariaLabel="视图模式"
                            value={viewMode}
                            options={[
                                { value: 'edit', label: '编辑' },
                                { value: 'diff', label: 'Diff 对比' },
                            ]}
                            onChange={setViewMode}
                        />
                    </div>
                </div>

                <div
                    class="ag-card-body ag-row-wrap"
                    style={{
                        padding: '10px 14px',
                        justifyContent: 'space-between',
                    }}
                >
                    <div class="ag-row-wrap">
                        <Button
                            variant="primary"
                            size="sm"
                            icon={<IconCheck size={14} />}
                            disabled={!selectedItem.writable || saving || !hasUnsavedChanges}
                            loading={saving}
                            onClick={() => void handleSave()}
                        >
                            保存
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconCopy size={14} />}
                            onClick={() => void handleCopy()}
                        >
                            复制
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            icon={<IconTrash size={14} />}
                            disabled={!selectedItem.writable || !selectedItem.overridden}
                            onClick={handleRequestRestoreOrDelete}
                        >
                            恢复原书/删除
                        </Button>
                    </div>
                    {!selectedItem.writable ? (
                        <Badge tone="neutral">只读层</Badge>
                    ) : null}
                </div>
            </div>

            {viewMode === 'edit' ? (
                <div style={{ flex: '1 1 auto', minHeight: 0 }}>
                    <CodeEditor
                        key={selectedItem.id}
                        value={draftContent}
                        onChange={setDraftContent}
                        label={`正在编辑：${selectedItem.path}`}
                        languageHint={inferLanguageHint(selectedItem)}
                        readOnly={!selectedItem.writable}
                        rows={14}
                        minHeight={isMobile ? '240px' : '340px'}
                    />
                </div>
            ) : (
                <div
                    class="ag-card"
                    style={{
                        flex: '1 1 auto',
                        minHeight: '220px',
                        display: 'flex',
                        flexDirection: 'column',
                    }}
                >
                    <div class="ag-card-header">
                        <div class="ag-card-headings">
                            <span class="ag-card-title">原书 / 基线 vs 当前分支层</span>
                            <span class="ag-card-subtitle">
                                {selectedItem.baseContent
                                    ? `基线对照 (${selectedItem.layerLabel})`
                                    : '无原书基线（展示新增/覆写内容）'}
                            </span>
                        </div>
                        {diffSummary ? (
                            <div class="ag-row-wrap">
                                <Badge tone="success">+{diffSummary.addedCount} 行</Badge>
                                <Badge tone="error">-{diffSummary.removedCount} 行</Badge>
                            </div>
                        ) : null}
                    </div>
                    <div
                        class="ag-card-body ag-thin-scroll"
                        style={{
                            flex: '1 1 auto',
                            overflowY: 'auto',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '2px',
                        }}
                    >
                        {!diffSummary || diffSummary.rows.length === 0 ? (
                            <div class="ag-banner ag-banner-neutral">
                                当前内容与基线完全一致，暂无行级差异。
                            </div>
                        ) : (
                            diffSummary.rows.map((row, idx) => {
                                const rowClass =
                                    row.kind === 'add'
                                        ? 'ag-diff-add ag-mono'
                                        : row.kind === 'del'
                                            ? 'ag-diff-del ag-mono'
                                            : 'ag-mono';
                                return (
                                    <div
                                        key={idx}
                                        class={rowClass}
                                        style={{
                                            fontSize: '12px',
                                            lineHeight: 1.5,
                                            padding: '2px 8px',
                                            borderRadius: '4px',
                                            whiteSpace: 'pre-wrap',
                                            wordBreak: 'break-word',
                                        }}
                                    >
                                        <span
                                            style={{
                                                display: 'inline-block',
                                                width: '18px',
                                                opacity: 0.75,
                                                userSelect: 'none',
                                            }}
                                        >
                                            {row.prefix}
                                        </span>
                                        <span>{row.text || ' '}</span>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    ) : null;

    return (
        <MasterDetailLayout
            isMobile={isMobile}
            detailOpen={detailOpen}
            onDetailOpenChange={setDetailOpen}
            detailTitle={selectedItem?.path ?? '文件详情'}
            emptyDetailTitle="选择左侧文件或覆写条目"
            emptyDetailDescription="支持工作区文件、/state/variables.json、世界书覆写及消息展示层的编辑与 Diff 对比。"
            master={masterPane}
            detail={detailPane}
        />
    );
}
