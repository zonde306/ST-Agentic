import { diffLines } from 'diff';
import type { TargetedEvent } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { MessageTarget } from '@/core/types';
import { isInstructionIndexPath } from '@/core/vfs';
import {
    Badge,
    Button,
    CodeEditor,
    DiffViewer,
    type DiffViewerLine,
    EmptyState,
    FormField,
    MasterDetailLayout,
    SegmentedControl,
    SelectInput,
    ShadowModal,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconCheck,
    IconCopy,
    IconDownload,
    IconFolder,
    IconPlus,
    IconRefresh,
    IconTrash,
    IconUpload,
} from '@/ui/components/Icons';
import type {
    ConsoleViewProps,
    FileOverrideCategory,
    FileOverrideItem,
    FileStorageScope,
} from '@/ui/store';
import {
    copyTextToClipboard,
    downloadTextFile,
    getCategoryLabel,
    getCategoryTone,
    useStoreSlice,
} from './shared';

type CategoryFilter = 'all' | FileOverrideCategory;
type EditorViewMode = 'edit' | 'diff';
type CreateUploadScope = 'workspace_docs' | 'workspace_shared' | 'preset' | 'global';

const CATEGORY_FILTERS: readonly { id: CategoryFilter; label: string }[] = [
    { id: 'all', label: '全部' },
    { id: 'instructions', label: '规范与文档' },
    { id: 'workspace', label: '工作区' },
    { id: 'variables', label: '变量' },
    { id: 'worldinfo', label: 'WI覆写' },
    { id: 'message', label: '输出 (/output.md)' },
];

const SCOPE_OPTIONS: readonly { value: CreateUploadScope; label: string }[] = [
    { value: 'workspace_docs', label: '会话规范 (/workspace/docs/ · 全分支)' },
    { value: 'workspace_shared', label: '共享协作区 (/workspace/shared/ · 跟随分支)' },
    { value: 'preset', label: '预设参考 (/preset/ · 随预设导出)' },
    { value: 'global', label: '全局规范 (/global/ · 跨聊天生效)' },
];

const DEFAULT_AGENTS_MD_TEMPLATE = [
    '# Agent 工作规范索引 (AGENTS.md)',
    '',
    '## 核心硬性规范（始终生效）',
    '- 严格遵守世界观与角色设定，禁止抢写 {{user}} 的发言与内心想法。',
    '- 输出前必须核对 `/state/variables.json` 中的最新状态并在 `/output.md` 保持格式一致。',
    '',
    '## 按需参考文档（仅在涉及对应场景时调用 read_file 读取）',
    '- 文风与禁用词规范：`docs/writing-style.md`（若在本目录则对应 `/workspace/docs/writing-style.md`）',
    '- 特殊战斗或数值判定：`docs/combat-rules.md`',
    '',
].join('\n');

function resolveBasename(filePath: string): string {
    const clean = filePath.replace(/^\/+/, '');
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) || 'file.txt' : clean || 'file.txt';
}

function resolveMimeType(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.json')) {
        return 'application/json;charset=utf-8';
    }
    if (lower.endsWith('.md')) {
        return 'text/markdown;charset=utf-8';
    }
    return 'text/plain;charset=utf-8';
}

function sanitizeRelativeInputPath(rawPath: string): string | null {
    const posix = rawPath.trim().replace(/\\/g, '/').replace(/[\0%#?]/g, '_');
    const rawSegs = posix.split('/');
    const safeSegs: string[] = [];
    for (const seg of rawSegs) {
        const cleaned = seg.trim();
        if (!cleaned || cleaned === '.' || cleaned === '..') {
            continue;
        }
        const noLeadingDots = cleaned.replace(/^\.+/, '');
        if (noLeadingDots) {
            safeSegs.push(noLeadingDots);
        }
    }
    return safeSegs.length > 0 ? safeSegs.join('/') : null;
}

function resolveTargetPathAndScope(
    scope: CreateUploadScope,
    rawRelPath: string,
    branchWideOverride: boolean,
): { fullPath: string; key: string; storageScope: FileStorageScope } | null {
    const safeRel = sanitizeRelativeInputPath(rawRelPath);
    if (!safeRel) {
        return null;
    }

    const lowerRel = safeRel.toLowerCase();
    if (scope === 'preset') {
        const rel = lowerRel.startsWith('preset/') ? safeRel.slice('preset/'.length) : safeRel;
        if (!rel) {
            return null;
        }
        return { fullPath: `/preset/${rel}`, key: rel, storageScope: 'preset' };
    }

    if (scope === 'global') {
        const rel = lowerRel.startsWith('global/') ? safeRel.slice('global/'.length) : safeRel;
        if (!rel) {
            return null;
        }
        return { fullPath: `/global/${rel}`, key: rel, storageScope: 'global' };
    }

    if (scope === 'workspace_shared') {
        const rel = lowerRel.startsWith('workspace/shared/')
            ? safeRel.slice('workspace/shared/'.length)
            : lowerRel.startsWith('shared/')
                ? safeRel.slice('shared/'.length)
                : safeRel;
        if (!rel) {
            return null;
        }
        const key = `workspace/shared/${rel}`;
        return {
            fullPath: `/${key}`,
            key,
            storageScope: branchWideOverride ? 'chat_base' : 'chat_branch',
        };
    }

    // workspace_docs: route AGENTS.md directly to /workspace/AGENTS.md, otherwise /workspace/docs/*
    const stripped = lowerRel.startsWith('workspace/') ? safeRel.slice('workspace/'.length) : safeRel;
    const strippedLower = stripped.toLowerCase();
    if (strippedLower === 'agents.md') {
        return {
            fullPath: '/workspace/AGENTS.md',
            key: 'workspace/AGENTS.md',
            storageScope: 'chat_base',
        };
    }
    const key = strippedLower.startsWith('docs/') || strippedLower.startsWith('shared/')
        ? `workspace/${stripped}`
        : `workspace/docs/${stripped}`;
    return {
        fullPath: `/${key}`,
        key,
        storageScope: key.startsWith('workspace/docs/') || branchWideOverride ? 'chat_base' : 'chat_branch',
    };
}

function inferLanguageHint(
    item: FileOverrideItem,
): 'json' | 'javascript' | 'markdown' | 'yaml' | 'regex' | 'text' {
    if (item.category === 'variables' || item.path.endsWith('.json')) {
        return 'json';
    }
    if (
        item.category === 'message'
        || item.path === '/output.md'
        || item.path.endsWith('/output.md')
        || item.path.endsWith('.md')
    ) {
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
    rows: DiffViewerLine[];
    addedCount: number;
    removedCount: number;
} {
    const changes = diffLines(baseContent, currentContent, { stripTrailingCr: true });
    const rows: DiffViewerLine[] = [];
    let addedCount = 0;
    let removedCount = 0;

    for (const part of changes) {
        const lines = splitDiffChunkLines(part.value);
        if (part.added) {
            addedCount += lines.length;
            for (const text of lines) {
                rows.push({ type: 'add', text });
            }
        } else if (part.removed) {
            removedCount += lines.length;
            for (const text of lines) {
                rows.push({ type: 'del', text });
            }
        } else {
            for (const text of lines) {
                rows.push({ type: 'ctx', text });
            }
        }
    }

    return { rows, addedCount, removedCount };
}

function matchDeepLinkItem(item: FileOverrideItem, filePath: string): boolean {
    return item.path === filePath || item.id === filePath || item.key === filePath;
}

export function isUnmodifiedWorldInfoItem(item: FileOverrideItem): boolean {
    if (item.category !== 'worldinfo') {
        return false;
    }
    if (!item.overridden) {
        return true;
    }
    if (item.baseContent !== undefined) {
        return item.content.replace(/\r\n/g, '\n') === item.baseContent.replace(/\r\n/g, '\n');
    }
    return false;
}

export function filterVisibleFileOverrideItems(
    items: readonly FileOverrideItem[],
    scopedTarget?: MessageTarget,
): FileOverrideItem[] {
    const baseFiltered = items.filter((item) => !isUnmodifiedWorldInfoItem(item));
    const messageItems = baseFiltered.filter((item) => item.category === 'message');
    if (messageItems.length <= 1) {
        return baseFiltered;
    }

    let keptMessageItem: FileOverrideItem | undefined;
    if (scopedTarget) {
        keptMessageItem =
            messageItems.find(
                (item) =>
                    item.target.messageId === scopedTarget.messageId
                    && item.target.swipeId === scopedTarget.swipeId,
            )
            ?? messageItems.find((item) => item.target.messageId === scopedTarget.messageId);
    }
    if (!keptMessageItem) {
        keptMessageItem = messageItems.reduce((latest, candidate) => {
            if (candidate.target.messageId !== latest.target.messageId) {
                return candidate.target.messageId > latest.target.messageId ? candidate : latest;
            }
            return candidate.target.swipeId > latest.target.swipeId ? candidate : latest;
        });
    }

    return baseFiltered.filter(
        (item) => item.category !== 'message' || item === keptMessageItem,
    );
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

    const [createModalOpen, setCreateModalOpen] = useState(false);
    const [createScope, setCreateScope] = useState<CreateUploadScope>('workspace_docs');
    const [newRelPath, setNewRelPath] = useState('');
    const [newBranchWide, setNewBranchWide] = useState(true);
    const [createError, setCreateError] = useState<string | null>(null);
    const [dragActive, setDragActive] = useState(false);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const uploadScopeOverrideRef = useRef<CreateUploadScope | null>(null);
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
                const fetched = filterVisibleFileOverrideItems(
                    await store.services.listFilesAndOverrides(targetArg),
                    targetArg,
                );
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
            const matched =
                items.find(
                    (item) =>
                        matchDeepLinkItem(item, deepLink.filePath!)
                        && (deepLink.messageId === undefined || item.target.messageId === deepLink.messageId)
                        && (deepLink.swipeId === undefined || item.target.swipeId === deepLink.swipeId),
                )
                ?? items.find((item) => matchDeepLinkItem(item, deepLink.filePath!));
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
        const matched =
            items.find(
                (item) =>
                    matchDeepLinkItem(item, deepLink.filePath!)
                    && (deepLink.messageId === undefined || item.target.messageId === deepLink.messageId)
                    && (deepLink.swipeId === undefined || item.target.swipeId === deepLink.swipeId),
            )
            ?? items.find((item) => matchDeepLinkItem(item, deepLink.filePath!));
        if (matched) {
            consumedDeepLinkFileRef.current = deepLink.filePath;
            if (selectedIdRef.current !== matched.id) {
                setCategoryFilter('all');
                setSelectedId(matched.id);
            }
            setDetailOpen(true);
        }
    }, [deepLink.filePath, deepLink.messageId, deepLink.swipeId, items]);

    const filteredItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return items.filter((item) => {
            if (isUnmodifiedWorldInfoItem(item)) {
                return false;
            }
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
                storageScope: selectedItem.storageScope,
            });
            if (isUnmodifiedWorldInfoItem(saved)) {
                const nextItems = items.filter((item) => item.id !== selectedItem.id);
                setItems(nextItems);
                setDetailOpen(false);
                setSelectedId((prev) => (prev === selectedItem.id ? (nextItems[0]?.id ?? null) : prev));
                store.pushToast(`内容与原书一致，已移出覆写列表：${saved.path}`, 'primary');
                return;
            }
            setItems((prev) =>
                prev.map((item) => (item.id === selectedItem.id ? { ...item, ...saved } : item)),
            );
            setDraftContent(saved.content);
            store.pushToast(`已保存至 ${saved.layerLabel}：${saved.path}`, 'success');
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

    const handleDownloadSelected = () => {
        if (!selectedItem) {
            return;
        }
        const filename = resolveBasename(selectedItem.path);
        const ok = downloadTextFile(filename, draftContent, resolveMimeType(selectedItem.path));
        store.pushToast(
            ok ? `已下载 ${filename}` : '当前环境不支持文件下载',
            ok ? 'success' : 'warning',
        );
    };

    const handleExportBundle = () => {
        if (filteredItems.length === 0) {
            store.pushToast('当前筛选结果为空，暂无可导出文件', 'warning');
            return;
        }
        const bundle = {
            version: 1,
            exportedAt: new Date().toISOString(),
            files: filteredItems.map((item) => ({
                path: item.path,
                category: item.category,
                storageScope: item.storageScope,
                source: item.source,
                content: item.id === selectedItem?.id ? draftContent : item.content,
            })),
        };
        const ok = downloadTextFile(
            'agentic-files-bundle.json',
            JSON.stringify(bundle, null, 2),
            'application/json;charset=utf-8',
        );
        store.pushToast(
            ok ? `已导出 ${filteredItems.length} 个文件打包 JSON` : '当前环境不支持文件下载',
            ok ? 'success' : 'warning',
        );
    };

    const upsertWorkspaceOrSpecFile = useCallback(
        async (
            scope: CreateUploadScope,
            relPath: string,
            content: string,
            branchWide: boolean,
        ): Promise<FileOverrideItem | null> => {
            const resolved = resolveTargetPathAndScope(scope, relPath, branchWide);
            if (!resolved) {
                return null;
            }
            const saved = await store.services.saveFileOrOverride({
                path: resolved.fullPath,
                namespace: 'files',
                key: resolved.key,
                content,
                target: effectiveTarget,
                storageScope: resolved.storageScope,
            });
            return saved;
        },
        [effectiveTarget, store],
    );

    const resolveDefaultScopeFromFilter = useCallback((): CreateUploadScope => {
        if (categoryFilter === 'workspace') {
            return 'workspace_shared';
        }
        return 'workspace_docs';
    }, [categoryFilter]);

    const handleOpenCreateModal = () => {
        const defaultScope = resolveDefaultScopeFromFilter();
        setCreateScope(defaultScope);
        setNewRelPath('');
        setNewBranchWide(defaultScope === 'workspace_docs');
        setCreateError(null);
        setCreateModalOpen(true);
    };

    const handleCreateFile = async () => {
        const resolved = resolveTargetPathAndScope(createScope, newRelPath, newBranchWide);
        if (!resolved) {
            setCreateError('请输入合法的文件相对路径（不可为空或包含 ..）');
            return;
        }
        try {
            setSaving(true);
            setCreateError(null);
            const initialContent = isInstructionIndexPath(resolved.fullPath)
                ? DEFAULT_AGENTS_MD_TEMPLATE
                : '';
            const saved = await store.services.saveFileOrOverride({
                path: resolved.fullPath,
                namespace: 'files',
                key: resolved.key,
                content: initialContent,
                target: effectiveTarget,
                storageScope: resolved.storageScope,
            });
            await loadFiles(scopeByTarget ? effectiveTarget : undefined);
            setSelectedId(saved.id);
            setDetailOpen(true);
            setViewMode('edit');
            setCreateModalOpen(false);
            store.pushToast(`已创建 ${saved.path}`, 'success');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setCreateError(msg);
        } finally {
            setSaving(false);
        }
    };

    const handleQuickCreateAgentsMd = async () => {
        try {
            setSaving(true);
            setCreateError(null);
            const existing = items.find((item) => item.path.toLowerCase() === '/workspace/agents.md');
            if (existing) {
                setSelectedId(existing.id);
                setDetailOpen(true);
                setCreateModalOpen(false);
                store.pushToast('已定位到现有的 /workspace/AGENTS.md', 'primary');
                return;
            }
            const saved = await store.services.saveFileOrOverride({
                path: '/workspace/AGENTS.md',
                namespace: 'files',
                key: 'workspace/AGENTS.md',
                content: DEFAULT_AGENTS_MD_TEMPLATE,
                target: effectiveTarget,
                storageScope: 'chat_base',
            });
            await loadFiles(scopeByTarget ? effectiveTarget : undefined);
            setCategoryFilter('all');
            setSelectedId(saved.id);
            setDetailOpen(true);
            setViewMode('edit');
            setCreateModalOpen(false);
            store.pushToast('已创建规范索引模板 /workspace/AGENTS.md', 'success');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setCreateError(msg);
        } finally {
            setSaving(false);
        }
    };

    const processUploadedFiles = useCallback(
        async (fileList: FileList | File[], explicitScope?: CreateUploadScope) => {
            const files = Array.from(fileList);
            if (files.length === 0) {
                return;
            }
            const scope = explicitScope ?? resolveDefaultScopeFromFilter();
            const branchWide = scope === 'workspace_docs';
            let lastSaved: FileOverrideItem | null = null;
            let successCount = 0;
            const failures: string[] = [];

            setSaving(true);
            try {
                for (const file of files) {
                    try {
                        const relRaw =
                            (file as File & { webkitRelativePath?: string }).webkitRelativePath
                            || file.name;
                        const content = await file.text();
                        const saved = await upsertWorkspaceOrSpecFile(scope, relRaw, content, branchWide);
                        if (saved) {
                            lastSaved = saved;
                            successCount += 1;
                        } else {
                            failures.push(`${file.name}: 文件路径不合法`);
                        }
                    } catch (error) {
                        const msg = error instanceof Error ? error.message : String(error);
                        failures.push(`${file.name}: ${msg}`);
                    }
                }
                await loadFiles(scopeByTarget ? effectiveTarget : undefined);
                if (lastSaved) {
                    setSelectedId(lastSaved.id);
                    setDetailOpen(true);
                    setViewMode('edit');
                }
                if (successCount > 0) {
                    store.pushToast(
                        successCount === 1 && lastSaved
                            ? `已上传 ${lastSaved.path}`
                            : `已成功上传 ${successCount} 个文件`,
                        'success',
                    );
                }
                if (failures.length > 0) {
                    store.pushToast(`部分文件上传失败：${failures[0]}`, 'error');
                }
            } finally {
                setSaving(false);
            }
        },
        [effectiveTarget, loadFiles, resolveDefaultScopeFromFilter, scopeByTarget, store, upsertWorkspaceOrSpecFile],
    );

    const handleTriggerUpload = (scopeOverride?: CreateUploadScope) => {
        uploadScopeOverrideRef.current = scopeOverride ?? null;
        fileInputRef.current?.click();
    };

    const handleFileInputChange = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const list = event.currentTarget.files;
        const explicitScope = uploadScopeOverrideRef.current ?? undefined;
        uploadScopeOverrideRef.current = null;
        if (list && list.length > 0) {
            void processUploadedFiles(list, explicitScope);
        }
        event.currentTarget.value = '';
    };

    const canDeleteSelected = Boolean(
        selectedItem
        && selectedItem.writable
        && (selectedItem.overridden
            || selectedItem.storageScope === 'chat_base'
            || selectedItem.storageScope === 'preset'
            || selectedItem.storageScope === 'global'
            || selectedItem.category === 'workspace'
            || selectedItem.category === 'instructions'),
    );

    const handleRequestRestoreOrDelete = () => {
        if (!selectedItem || !canDeleteSelected) {
            return;
        }
        const isWorldInfo = selectedItem.category === 'worldinfo';
        const isVariables = selectedItem.category === 'variables';
        store.openModal({
            kind: 'confirm',
            title: isWorldInfo
                ? '确认恢复世界书原文'
                : isVariables
                    ? '确认移除当前分支变量覆写'
                    : '确认删除文件',
            message: isWorldInfo
                ? `确定清除 ${selectedItem.path} 在 ${selectedItem.layerLabel} 的覆写并恢复原书内容吗？`
                : isVariables
                    ? `确定清除 ${selectedItem.path} 在 ${selectedItem.layerLabel} 的变量覆写吗？`
                    : `确定永久删除 ${selectedItem.path}（${selectedItem.layerLabel}）吗？`,
            confirmLabel: isWorldInfo ? '恢复原书' : '确认删除',
            cancelLabel: '取消',
            tone: 'danger',
            onConfirm: async () => {
                await store.services.deleteFileOrOverride({
                    path: selectedItem.path,
                    namespace: selectedItem.namespace,
                    key: selectedItem.key,
                    target: selectedItem.target,
                    storageScope: selectedItem.storageScope,
                });
                await loadFiles(scopeByTarget ? effectiveTarget : undefined);
                setDetailOpen(false);
                store.pushToast(
                    isWorldInfo
                        ? `已清除覆写并恢复原书：${selectedItem.path}`
                        : `已移除：${selectedItem.path}`,
                    'warning',
                );
            },
        });
    };

    const worldinfoOverrideItems = useMemo(
        () => filteredItems.filter((item) => item.category === 'worldinfo' && item.overridden && item.writable),
        [filteredItems],
    );

    const handleBatchRestoreWorldInfo = () => {
        if (worldinfoOverrideItems.length === 0 || saving) {
            return;
        }
        const targets = [...worldinfoOverrideItems];
        const renderedOnlyCount = targets.filter((item) => item.renderedOnlyOverride).length;
        store.openModal({
            kind: 'confirm',
            title: '确认批量恢复世界书原书',
            message: `确定清除当前列表中 ${targets.length} 条世界书覆写${
                renderedOnlyCount > 0 ? `（其中 ${renderedOnlyCount} 条仅包含宏/EJS求值结果）` : ''
            }并恢复原书内容吗？`,
            confirmLabel: '批量恢复原书',
            cancelLabel: '取消',
            tone: 'danger',
            onConfirm: async () => {
                setSaving(true);
                try {
                    let cleared = 0;
                    for (const targetItem of targets) {
                        await store.services.deleteFileOrOverride({
                            path: targetItem.path,
                            namespace: targetItem.namespace,
                            key: targetItem.key,
                            target: targetItem.target,
                            storageScope: targetItem.storageScope,
                        });
                        cleared += 1;
                    }
                    await loadFiles(scopeByTarget ? effectiveTarget : undefined);
                    setDetailOpen(false);
                    store.pushToast(`已批量清除 ${cleared} 条世界书覆写并恢复原书`, 'warning');
                } catch (error) {
                    const msg = error instanceof Error ? error.message : String(error);
                    store.pushToast(`批量恢复失败：${msg}`, 'error');
                } finally {
                    setSaving(false);
                }
            },
        });
    };

    const previewResolvedCreate = useMemo(
        () => resolveTargetPathAndScope(createScope, newRelPath, newBranchWide),
        [createScope, newBranchWide, newRelPath],
    );

    const masterPane = (
        <div
            class="ag-stack-v"
            style={{
                padding: '10px',
                gap: '10px',
                outline: dragActive ? '2px dashed var(--primary)' : undefined,
                outlineOffset: '-4px',
                borderRadius: '8px',
            }}
            onDragOver={(e) => {
                e.preventDefault();
                if (!dragActive) {
                    setDragActive(true);
                }
            }}
            onDragLeave={() => {
                setDragActive(false);
            }}
            onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
                    void processUploadedFiles(e.dataTransfer.files);
                }
            }}
        >
            <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".md,.txt,.json,.yaml,.yml,.csv,.xml,text/*"
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
            />

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

            <div class="ag-row-wrap" style={{ gap: '6px' }}>
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={handleOpenCreateModal}
                >
                    新建
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconUpload size={14} />}
                    loading={saving}
                    title="上传本地 .md / .txt / .json 文件（或直接拖拽到列表）"
                    onClick={() => handleTriggerUpload()}
                >
                    上传
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconDownload size={14} />}
                    disabled={filteredItems.length === 0}
                    title="将当前筛选结果导出为 JSON 打包文件"
                    onClick={handleExportBundle}
                >
                    导出包
                </Button>
                {worldinfoOverrideItems.length > 0 ? (
                    <Button
                        size="sm"
                        variant="danger"
                        icon={<IconTrash size={14} />}
                        loading={saving}
                        title="批量清除当前列表中的世界书分支覆写并恢复原书"
                        onClick={handleBatchRestoreWorldInfo}
                    >
                        批量恢复 WI 原书 ({worldinfoOverrideItems.length})
                    </Button>
                ) : null}
            </div>

            {dragActive ? (
                <div class="ag-banner ag-banner-primary">
                    松开鼠标即可上传文件到 {resolveDefaultScopeFromFilter() === 'workspace_shared' ? '/workspace/shared/' : '/workspace/docs/ (AGENTS.md 自动入根规范)'}
                </div>
            ) : null}

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
                                <div class="ag-row" style={{ justifyContent: 'space-between', minWidth: 0, width: '100%' }}>
                                    <span
                                        class="ag-list-item-title ag-mono"
                                        style={{
                                            minWidth: 0,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                        title={item.path}
                                    >
                                        {item.path}
                                    </span>
                                    <span style={{ flexShrink: 0 }}>
                                        <Badge tone={getCategoryTone(item.category)}>
                                            {getCategoryLabel(item.category)}
                                        </Badge>
                                    </span>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span
                                        style={{
                                            minWidth: 0,
                                            flexShrink: 0,
                                            maxWidth: '42%',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}
                                        title={item.source}
                                    >
                                        {item.source}
                                    </span>
                                    <span
                                        class="ag-row"
                                        style={{
                                            gap: '4px',
                                            minWidth: 0,
                                            flex: '0 1 auto',
                                            overflow: 'hidden',
                                        }}
                                    >
                                        {isInstructionIndexPath(item.path) ? (
                                            <span style={{ flexShrink: 0 }}>
                                                <Badge tone="primary">索引</Badge>
                                            </span>
                                        ) : null}
                                        {isTargetMatch ? (
                                            <span style={{ flexShrink: 0 }}>
                                                <Badge tone="primary">定位</Badge>
                                            </span>
                                        ) : null}
                                        {item.renderedOnlyOverride ? (
                                            <span style={{ flexShrink: 0 }}>
                                                <Badge tone="warning">仅宏/EJS渲染</Badge>
                                            </span>
                                        ) : null}
                                        <Badge tone={item.overridden ? 'success' : 'neutral'} title={item.layerLabel}>
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
                            {selectedItem.renderedOnlyOverride ? (
                                <Badge tone="warning">仅宏/EJS渲染</Badge>
                            ) : null}
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
                            variant="secondary"
                            size="sm"
                            icon={<IconDownload size={14} />}
                            onClick={handleDownloadSelected}
                        >
                            下载
                        </Button>
                        <Button
                            variant="danger"
                            size="sm"
                            icon={<IconTrash size={14} />}
                            disabled={!canDeleteSelected}
                            onClick={handleRequestRestoreOrDelete}
                        >
                            {selectedItem.category === 'worldinfo'
                                ? '恢复原书'
                                : selectedItem.category === 'variables'
                                    ? '清除覆写'
                                    : '删除'}
                        </Button>
                    </div>
                    {!selectedItem.writable ? (
                        <Badge tone="neutral">只读层</Badge>
                    ) : null}
                </div>
                {selectedItem.renderedOnlyOverride ? (
                    <div
                        class="ag-banner ag-banner-warning"
                        style={{ margin: '0 14px 12px 14px', fontSize: '12px' }}
                    >
                        该历史覆写的内容仅等于原书经过宏/EJS求值后的静态快照，没有实质内容改动；继续保留会冻结原书中的动态模板逻辑，建议点击“恢复原书”。
                    </div>
                ) : null}
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
                    </div>
                    <div class="ag-card-body ag-diffv-host" data-files-diff="true">
                        <DiffViewer
                            key={selectedItem.id}
                            class="ag-diffv-fill"
                            lines={diffSummary?.rows ?? []}
                            emptyText={
                                <div class="ag-banner ag-banner-neutral">
                                    当前内容与基线完全一致，暂无行级差异。
                                </div>
                            }
                        />
                    </div>
                </div>
            )}
        </div>
    ) : null;

    return (
        <>
            <MasterDetailLayout
                isMobile={isMobile}
                detailOpen={detailOpen}
                onDetailOpenChange={setDetailOpen}
                detailTitle={selectedItem?.path ?? '文件详情'}
                emptyDetailTitle="选择左侧文件或覆写条目"
                emptyDetailDescription="支持工作区与协作文件、AGENTS.md 规范树、/state/variables.json、世界书覆写及 /output.md 消息输出的上传、下载、编辑与 Diff 对比。"
                master={masterPane}
                detail={detailPane}
            />

            <ShadowModal
                open={createModalOpen}
                title="新建或上传规范与工作区文件"
                maxWidth="480px"
                onClose={() => setCreateModalOpen(false)}
                footer={
                    <>
                        <Button variant="secondary" onClick={() => setCreateModalOpen(false)}>
                            取消
                        </Button>
                        <Button
                            variant="secondary"
                            icon={<IconUpload size={14} />}
                            loading={saving}
                            onClick={() => {
                                setCreateModalOpen(false);
                                handleTriggerUpload(createScope);
                            }}
                        >
                            上传本地文件至此域
                        </Button>
                        <Button
                            variant="primary"
                            icon={<IconPlus size={14} />}
                            loading={saving}
                            onClick={() => void handleCreateFile()}
                        >
                            创建文件
                        </Button>
                    </>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-neutral">
                        <div class="ag-row-wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: '12px' }}>
                                推荐结构：薄索引 <span class="ag-mono">/workspace/AGENTS.md</span> + 按需子文档 <span class="ag-mono">/workspace/docs/*.md</span>
                            </span>
                            <Button
                                size="sm"
                                variant="secondary"
                                loading={saving}
                                onClick={() => void handleQuickCreateAgentsMd()}
                            >
                                一键创建 AGENTS.md 模板
                            </Button>
                        </div>
                    </div>

                    <FormField label="目标作用域">
                        <SelectInput<CreateUploadScope>
                            value={createScope}
                            options={SCOPE_OPTIONS}
                            ariaLabel="文件目标作用域"
                            onChange={(val) => {
                                setCreateScope(val);
                                setNewBranchWide(val !== 'workspace_shared');
                                setCreateError(null);
                            }}
                        />
                    </FormField>

                    <FormField
                        label="相对路径"
                        required
                        error={createError ?? undefined}
                        hint={
                            previewResolvedCreate
                                ? `最终 VFS 路径：${previewResolvedCreate.fullPath}`
                                : '例如：AGENTS.md、writing-style.md、combat/rules.md'
                        }
                    >
                        <TextInput
                            className="ag-mono"
                            value={newRelPath}
                            placeholder={
                                createScope === 'workspace_shared'
                                    ? 'handoff.md'
                                    : 'AGENTS.md 或 writing-style.md'
                            }
                            onInput={(val) => {
                                setNewRelPath(val);
                                setCreateError(null);
                            }}
                        />
                    </FormField>

                    {createScope === 'workspace_shared' ? (
                        <ToggleSwitch
                            checked={newBranchWide}
                            label="全分支生效（切换 Swipe / 重生成保留）"
                            description="关闭时跟随当前消息分支回滚；规范索引与 docs/** 始终跨分支保留。"
                            onChange={setNewBranchWide}
                        />
                    ) : null}
                </div>
            </ShadowModal>
        </>
    );
}
