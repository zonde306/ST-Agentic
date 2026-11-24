import type { TargetedEvent } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    resolveActivePreset,
    validatePresetFileName,
} from '@/core/config';
import { buildLoreOverrideKey } from '@/core/lore';
import type { ClassifiedLoreEntry, WICategory } from '@/core/types';
import {
    Badge,
    Button,
    Card,
    CodeEditor,
    EmptyState,
    FormField,
    MasterDetailLayout,
    SegmentedControl,
    SelectInput,
    ShadowModal,
    TextInput,
    useIsMobileViewport,
} from '@/ui/components';
import {
    IconBookOpen,
    IconDownload,
    IconFolder,
    IconPlus,
    IconRefresh,
    IconTrash,
    IconUpload,
} from '@/ui/components/Icons';
import {
    type ConsoleViewProps,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import { downloadTextFile, useDraftString } from './studio-helpers';

type WIRouterSubTab = 'router' | 'preset_files';
type OverrideChoice = 'auto' | WICategory;
type CategoryFilter = 'all' | WICategory;

const WI_CATEGORY_META: Record<
    WICategory,
    {
        label: string;
        shortLabel: string;
        tone: 'primary' | 'success' | 'neutral' | 'warning';
        desc: string;
    }
> = {
    system_rule: {
        label: '① 全局指令与文风 (system_rule)',
        shortLabel: '① 系统指令',
        tone: 'primary',
        desc: '编译入 Layer 0 静态前缀，确保首轮生效且不破缓存',
    },
    core_manifest: {
        label: '② 核心主干设定 (core_manifest)',
        shortLabel: '② 核心清单',
        tone: 'success',
        desc: '在 Core Manifest 置顶暴露路径与字数，按需 read_file',
    },
    on_demand_archive: {
        label: '③ 按需检索档案 (on_demand_archive)',
        shortLabel: '③ 按需档案',
        tone: 'neutral',
        desc: '由去重尾部雷达提示，模型按需搜索与拉取',
    },
    dynamic_or_trigger: {
        label: '④ 脚本/变量/动态层 (dynamic_or_trigger)',
        shortLabel: '④ 动态触发',
        tone: 'warning',
        desc: '从静态前缀剥离，归入触发管线或 Layer 2 尾部',
    },
};

function getEntryManualOverride(
    overrides: Record<string, WICategory>,
    item: ClassifiedLoreEntry,
): OverrideChoice {
    const canonical = buildLoreOverrideKey(item.entry.world, item.entry.uid);
    return (
        overrides[canonical]
        ?? overrides[item.vfsPath]
        ?? overrides[`${item.entry.world}:${item.entry.uid}`]
        ?? overrides[`${item.entry.world}#${item.entry.uid}`]
        ?? 'auto'
    );
}

function detectLanguageHint(
    filename: string,
): 'json' | 'yaml' | 'javascript' | 'markdown' | 'text' {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.json')) {
        return 'json';
    }
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
        return 'yaml';
    }
    if (lower.endsWith('.js') || lower.endsWith('.ts')) {
        return 'javascript';
    }
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
        return 'markdown';
    }
    return 'text';
}

function formatByteSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * View ⑧: World Info 4-Category Router & `/preset/*` Reference Files (`tabId: 'wi'`).
 * - Inspects classified World Info entries, detects hollow character cards, and persists manual overrides into `preset.wiRouterOverrides`.
 * - Provides CRUD, text file upload, and inline `CodeEditor` editing for `preset.files`.
 */
export function WIRouterView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const activePreset = resolveActivePreset(settings);

    const [subTab, setSubTab] = useState<WIRouterSubTab>('router');
    const [entries, setEntries] = useState<ClassifiedLoreEntry[]>([]);
    const [isHollowCard, setIsHollowCard] = useState(false);
    const [loadingLore, setLoadingLore] = useState(false);
    const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
    const [searchQuery, setSearchQuery] = useState('');

    // Preset file manager state
    const fileNames = useMemo(
        () => Object.keys(activePreset.files).sort((a, b) => a.localeCompare(b)),
        [activePreset.files],
    );
    const [selectedFile, setSelectedFile] = useState<string>(fileNames[0] ?? '');
    const [fileDetailOpen, setFileDetailOpen] = useState(false);
    const [newFileModalOpen, setNewFileModalOpen] = useState(false);
    const [newFileName, setNewFileName] = useState('');
    const [newFileError, setNewFileError] = useState<string | null>(null);
    const fileUploadRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!fileNames.includes(selectedFile)) {
            setSelectedFile(fileNames[0] ?? '');
        }
    }, [fileNames, selectedFile]);

    const refreshClassification = useCallback(async () => {
        try {
            setLoadingLore(true);
            const res = await store.services.listClassifiedLoreEntries(
                activePreset.wiRouterOverrides,
            );
            setEntries(res.entries);
            setIsHollowCard(res.isHollowCard);
        } catch (error) {
            store.pushToast(
                `加载世界书分流预览失败：${error instanceof Error ? error.message : String(error)}`,
                'error',
            );
        } finally {
            setLoadingLore(false);
        }
    }, [activePreset.wiRouterOverrides, store]);

    useEffect(() => {
        void refreshClassification();
    }, [refreshClassification]);

    const mutatePreset = (updater: (preset: typeof activePreset) => typeof activePreset) => {
        void store.updateSettings((prev) => {
            const current = resolveActivePreset(prev);
            return {
                ...prev,
                presets: {
                    ...prev.presets,
                    [current.id]: updater(current),
                },
            };
        });
    };

    const handleOverrideChange = (item: ClassifiedLoreEntry, choice: OverrideChoice) => {
        const canonical = buildLoreOverrideKey(item.entry.world, item.entry.uid);
        mutatePreset((preset) => {
            const nextOverrides = { ...preset.wiRouterOverrides };
            delete nextOverrides[canonical];
            delete nextOverrides[item.vfsPath];
            delete nextOverrides[`${item.entry.world}:${item.entry.uid}`];
            delete nextOverrides[`${item.entry.world}#${item.entry.uid}`];
            if (choice !== 'auto') {
                nextOverrides[canonical] = choice;
            }
            return {
                ...preset,
                wiRouterOverrides: nextOverrides,
            };
        });
        store.pushToast(
            choice === 'auto'
                ? `已恢复条目「${item.entry.comment || item.slug}」为自动分流`
                : `已锁定条目「${item.entry.comment || item.slug}」归属为 ${WI_CATEGORY_META[choice].shortLabel}`,
            'success',
        );
    };

    const categoryCounts = useMemo(() => {
        const counts: Record<WICategory, number> = {
            system_rule: 0,
            core_manifest: 0,
            on_demand_archive: 0,
            dynamic_or_trigger: 0,
        };
        for (const item of entries) {
            counts[item.category] += 1;
        }
        return counts;
    }, [entries]);

    const filteredEntries = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        return entries.filter((item) => {
            if (categoryFilter !== 'all' && item.category !== categoryFilter) {
                return false;
            }
            if (!q) {
                return true;
            }
            return (
                item.entry.comment.toLowerCase().includes(q)
                || item.entry.world.toLowerCase().includes(q)
                || item.vfsPath.toLowerCase().includes(q)
                || item.entry.keys.some((k) => k.toLowerCase().includes(q))
            );
        });
    }, [categoryFilter, entries, searchQuery]);

    // Preset file calculations & draft editor
    const totalFileBytes = useMemo(() => {
        return Object.entries(activePreset.files).reduce(
            (sum, [name, content]) => sum + name.length + content.length,
            0,
        );
    }, [activePreset.files]);

    const activeFileContent = selectedFile ? activePreset.files[selectedFile] : undefined;
    const fileDraft = useDraftString(
        `${activePreset.id}:file:${selectedFile}`,
        activeFileContent ?? '',
        (nextContent) => {
            if (!selectedFile) {
                return;
            }
            mutatePreset((preset) => ({
                ...preset,
                files: {
                    ...preset.files,
                    [selectedFile]: nextContent,
                },
            }));
        },
        { allowEmpty: true },
    );

    const handleCreateFile = () => {
        const trimmed = newFileName.trim();
        const validationErr = validatePresetFileName(trimmed);
        if (validationErr) {
            setNewFileError(validationErr);
            return;
        }
        if (Object.hasOwn(activePreset.files, trimmed)) {
            setNewFileError(`文件 "${trimmed}" 已存在`);
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            files: {
                ...preset.files,
                [trimmed]: '',
            },
        }));
        setSelectedFile(trimmed);
        setNewFileModalOpen(false);
        setNewFileName('');
        setNewFileError(null);
        if (isMobile) {
            setFileDetailOpen(true);
        }
        store.pushToast(`已创建预设参考文件 /preset/${trimmed}`, 'success');
    };

    const handleUploadFile = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const file = event.currentTarget.files?.[0];
        if (!file) {
            return;
        }
        const rawRel =
            (file as File & { webkitRelativePath?: string }).webkitRelativePath
            || file.name;
        const safeName = rawRel
            .trim()
            .replace(/\\/g, '/')
            .replace(/^[./]+/, '')
            .replace(/[%#?\0]/g, '_');
        const err = validatePresetFileName(safeName);
        if (err) {
            store.pushToast(`文件名不合法：${err}`, 'error');
            event.currentTarget.value = '';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const content = typeof reader.result === 'string' ? reader.result : '';
            const projected =
                totalFileBytes
                - (activePreset.files[safeName]?.length ?? 0)
                + safeName.length
                + content.length;
            if (projected > DEFAULT_FILE_MAP_SIZE_LIMIT) {
                store.pushToast(
                    `上传失败：预设文件总大小超出 ${Math.floor(DEFAULT_FILE_MAP_SIZE_LIMIT / 1024)} KB 上限`,
                    'error',
                );
                return;
            }
            mutatePreset((preset) => ({
                ...preset,
                files: {
                    ...preset.files,
                    [safeName]: content,
                },
            }));
            setSelectedFile(safeName);
            if (isMobile) {
                setFileDetailOpen(true);
            }
            store.pushToast(`已上传 /preset/${safeName}`, 'success');
        };
        reader.readAsText(file);
        event.currentTarget.value = '';
    };

    const handleDeleteFile = (filename: string) => {
        store.openModal({
            kind: 'confirm',
            title: '删除预设文件确认',
            message: `确定从当前预设删除参考文件「/preset/${filename}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => {
                    const nextFiles = { ...preset.files };
                    delete nextFiles[filename];
                    return {
                        ...preset,
                        files: nextFiles,
                    };
                });
                setFileDetailOpen(false);
                store.pushToast(`已删除 /preset/${filename}`, 'warning');
            },
        });
    };

    const overrideCount = Object.keys(activePreset.wiRouterOverrides).length;

    const routerViewContent = (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                {isHollowCard ? (
                    <div class="ag-banner ag-banner-warning">
                        <strong>检测到空壳角色卡（Hollow Card）：</strong>
                        当前原生角色卡设定字段缺失或不足 80 字。系统已自动激活{' '}
                        <strong>Layer 0 Core Manifest 空壳补偿引导</strong>，将第 ② 类核心常驻世界书条目置顶暴露给主 Agent，防止模型误判为无设定。
                    </div>
                ) : (
                    <div class="ag-banner ag-banner-primary">
                        当前角色卡包含完整的原生角色设定；世界书条目仍按四类语义分流与{' '}
                        <span class="ag-mono">xxHash</span> 尾部雷达去重策略挂载至{' '}
                        <span class="ag-mono">/lorebooks/*</span>。
                    </div>
                )}

                <Card
                    title="中文卡 WI 四类自动分流与手动纠偏"
                    subtitle={`已扫描 ${entries.length} 条启用世界书 · 已手动覆写 ${overrideCount} 条`}
                    actions={
                        <div class="ag-row-wrap">
                            {overrideCount > 0 ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                        mutatePreset((preset) => ({
                                            ...preset,
                                            wiRouterOverrides: {},
                                        }));
                                        store.pushToast('已清除全部手动路由纠偏，恢复自动识别', 'warning');
                                    }}
                                >
                                    重置全部纠偏 ({overrideCount})
                                </Button>
                            ) : null}
                            <Button
                                size="sm"
                                variant="primary"
                                loading={loadingLore}
                                icon={<IconRefresh size={14} />}
                                onClick={() => void refreshClassification()}
                            >
                                重新扫描
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-4">
                            {(['system_rule', 'core_manifest', 'on_demand_archive', 'dynamic_or_trigger'] as const).map(
                                (cat) => {
                                    const meta = WI_CATEGORY_META[cat];
                                    const active = categoryFilter === cat;
                                    return (
                                        <button
                                            key={cat}
                                            type="button"
                                            class={
                                                active
                                                    ? 'ag-list-item ag-list-item-active'
                                                    : 'ag-list-item'
                                            }
                                            onClick={() =>
                                                setCategoryFilter((prev) =>
                                                    prev === cat ? 'all' : cat,
                                                )
                                            }
                                        >
                                            <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                                <Badge tone={meta.tone}>{meta.shortLabel}</Badge>
                                                <span class="ag-mono" style={{ fontWeight: 700 }}>
                                                    {categoryCounts[cat]}
                                                </span>
                                            </div>
                                            <div class="ag-field-hint" style={{ marginTop: '2px' }}>
                                                {meta.desc}
                                            </div>
                                        </button>
                                    );
                                },
                            )}
                        </div>

                        <div class="ag-row-wrap">
                            <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                                <TextInput
                                    type="search"
                                    ariaLabel="搜索世界书条目"
                                    value={searchQuery}
                                    placeholder="按条目标题、世界书名、VFS 路径或关键词过滤..."
                                    onInput={setSearchQuery}
                                />
                            </div>
                            {categoryFilter !== 'all' ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setCategoryFilter('all')}
                                >
                                    显示全部分类 ({entries.length})
                                </Button>
                            ) : null}
                        </div>

                        {filteredEntries.length === 0 ? (
                            <EmptyState
                                icon={<IconBookOpen size={22} />}
                                title="没有匹配的世界书条目"
                                description="请确认当前角色或全局已启用世界书，或清空上方筛选条件。"
                            />
                        ) : (
                            <div class="ag-stack-v">
                                {filteredEntries.map((item) => {
                                    const meta = WI_CATEGORY_META[item.category];
                                    const overrideVal = getEntryManualOverride(
                                        activePreset.wiRouterOverrides,
                                        item,
                                    );
                                    const isManual = overrideVal !== 'auto' || Boolean(item.overridden);
                                    return (
                                        <div
                                            key={`${item.entry.world}_${item.entry.uid}_${item.vfsPath}`}
                                            style={{
                                                border: '1px solid var(--border)',
                                                borderRadius: '10px',
                                                background: 'var(--card)',
                                                padding: '12px',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                gap: '8px',
                                                minWidth: 0,
                                            }}
                                        >
                                            <div
                                                class="ag-row-wrap"
                                                style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}
                                            >
                                                <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                                                    <div class="ag-row-wrap">
                                                        <span style={{ fontWeight: 600, fontSize: '13px', wordBreak: 'break-word' }}>
                                                            {item.entry.comment || item.slug}
                                                        </span>
                                                        <Badge tone="neutral">
                                                            {item.entry.world} #{item.entry.uid}
                                                        </Badge>
                                                        <Badge tone="neutral">{item.charCount} 字</Badge>
                                                        <Badge tone={meta.tone}>{meta.label}</Badge>
                                                        {isManual ? (
                                                            <Badge tone="warning">手动纠偏</Badge>
                                                        ) : null}
                                                    </div>

                                                    <div
                                                        class="ag-mono ag-field-hint"
                                                        style={{ marginTop: '4px', overflowWrap: 'anywhere' }}
                                                    >
                                                        {item.vfsPath}
                                                    </div>

                                                    <div class="ag-row-wrap" style={{ marginTop: '4px' }}>
                                                        <span class="ag-field-hint">
                                                            {item.entry.constant ? '蓝灯常驻' : '绿灯触发'}
                                                            {item.entry.position === 4
                                                                ? ` · @D${item.entry.depth}`
                                                                : ''}
                                                            {item.entry.keys.length > 0
                                                                ? ` · 关键词: ${item.entry.keys.slice(0, 4).join(', ')}`
                                                                : ''}
                                                            {item.reason ? ` · 依据: ${item.reason}` : ''}
                                                        </span>
                                                        {item.decorators.map((dec, idx) => (
                                                            <Badge
                                                                key={`${dec.name}_${idx}`}
                                                                tone="primary"
                                                                className="ag-mono"
                                                            >
                                                                {dec.name}
                                                            </Badge>
                                                        ))}
                                                    </div>
                                                </div>

                                                <div style={{ width: isMobile ? '100%' : '230px', flexShrink: 0 }}>
                                                    <SelectInput<OverrideChoice>
                                                        ariaLabel={`覆写 ${item.entry.comment || item.slug} 分类`}
                                                        value={overrideVal}
                                                        options={[
                                                            { value: 'auto', label: '自动启发式识别' },
                                                            { value: 'system_rule', label: '锁定 ① 全局指令 (Layer 0)' },
                                                            { value: 'core_manifest', label: '锁定 ② 核心主干设定' },
                                                            { value: 'on_demand_archive', label: '锁定 ③ 按需检索档案' },
                                                            { value: 'dynamic_or_trigger', label: '锁定 ④ 动态/触发剥离' },
                                                        ]}
                                                        onChange={(choice) =>
                                                            handleOverrideChange(item, choice)
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </Card>
            </div>
        </div>
    );

    const filesMasterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <input
                ref={fileUploadRef}
                type="file"
                accept=".txt,.md,.json,.yaml,.yml,.csv,.xml,text/*"
                style={{ display: 'none' }}
                onChange={handleUploadFile}
            />

            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    /preset/* ({fileNames.length})
                </span>
                <Badge tone="neutral">
                    {formatByteSize(totalFileBytes)} /{' '}
                    {Math.floor(DEFAULT_FILE_MAP_SIZE_LIMIT / 1024)} KB
                </Badge>
            </div>

            <div class="ag-row-wrap">
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={() => {
                        setNewFileName('');
                        setNewFileError(null);
                        setNewFileModalOpen(true);
                    }}
                >
                    新建文件
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconUpload size={14} />}
                    onClick={() => fileUploadRef.current?.click()}
                >
                    上传文本文件
                </Button>
            </div>

            {fileNames.length === 0 ? (
                <EmptyState
                    icon={<IconFolder size={22} />}
                    title="暂无预设随附文件"
                    description="可在 /preset/* 附带文风手册、规则表或初始化 JSON，供 Agent 按需 read_file。"
                />
            ) : (
                <div class="ag-list" style={{ padding: 0 }}>
                    {fileNames.map((name) => {
                        const content = activePreset.files[name] ?? '';
                        const selected = selectedFile === name;
                        return (
                            <button
                                key={name}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                onClick={() => {
                                    setSelectedFile(name);
                                    if (isMobile) {
                                        setFileDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-list-item-title ag-mono">/preset/{name}</div>
                                <div class="ag-list-item-meta">
                                    <span>{content.length} 字符</span>
                                    <span>{formatByteSize(content.length)}</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );

    const filesDetailPane =
        selectedFile && activeFileContent !== undefined ? (
            <div class="ag-view-scroll ag-thin-scroll">
                <div class="ag-stack-v">
                    <Card
                        title={<span class="ag-mono">/preset/{selectedFile}</span>}
                        subtitle="随预设导出并只读挂载到 VFS /preset/*，不占用 Layer 0 静态前缀"
                        actions={
                            <div class="ag-row-wrap" style={{ gap: '6px' }}>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    icon={<IconDownload size={14} />}
                                    onClick={() => {
                                        const basename = selectedFile.split('/').pop() || selectedFile;
                                        const mime = selectedFile.toLowerCase().endsWith('.json')
                                            ? 'application/json;charset=utf-8'
                                            : selectedFile.toLowerCase().endsWith('.md')
                                                ? 'text/markdown;charset=utf-8'
                                                : 'text/plain;charset=utf-8';
                                        downloadTextFile(basename, fileDraft.value, mime);
                                        store.pushToast(`已下载 ${basename}`, 'success');
                                    }}
                                >
                                    下载文件
                                </Button>
                                <Button
                                    size="sm"
                                    variant="danger"
                                    icon={<IconTrash size={14} />}
                                    onClick={() => handleDeleteFile(selectedFile)}
                                >
                                    删除文件
                                </Button>
                            </div>
                        }
                    >
                        <CodeEditor
                            label="文件内容（自动保存至当前预设）"
                            languageHint={detectLanguageHint(selectedFile)}
                            rows={16}
                            minHeight="320px"
                            value={fileDraft.value}
                            onChange={fileDraft.onInput}
                        />
                    </Card>
                </div>
            </div>
        ) : (
            <EmptyState
                icon={<IconFolder size={22} />}
                title="请选择或创建 /preset/* 文件"
            />
        );

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                minWidth: 0,
            }}
        >
            <div
                style={{
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--sidebar)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px',
                }}
            >
                <SegmentedControl<WIRouterSubTab>
                    ariaLabel="世界书路由子视图"
                    value={subTab}
                    options={[
                        { value: 'router', label: 'WI 四类分流预览与纠偏' },
                        { value: 'preset_files', label: `预设文件管理 (/preset/* · ${fileNames.length})` },
                    ]}
                    onChange={setSubTab}
                />
                <Badge tone={isHollowCard ? 'warning' : 'success'}>
                    {isHollowCard ? '空壳角色卡补偿：已激活' : '标准角色卡'}
                </Badge>
            </div>

            <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                {subTab === 'router' ? (
                    routerViewContent
                ) : (
                    <MasterDetailLayout
                        master={filesMasterPane}
                        detail={filesDetailPane}
                        detailOpen={fileDetailOpen}
                        onDetailOpenChange={setFileDetailOpen}
                        detailTitle={selectedFile ? `/preset/${selectedFile}` : '预设文件'}
                        isMobile={isMobile}
                        emptyDetailTitle="请选择左侧预设文件"
                    />
                )}
            </div>

            <ShadowModal
                open={newFileModalOpen}
                title="新建预设参考文件 (/preset/*)"
                maxWidth="440px"
                onClose={() => setNewFileModalOpen(false)}
                footer={
                    <>
                        <Button variant="secondary" onClick={() => setNewFileModalOpen(false)}>
                            取消
                        </Button>
                        <Button variant="primary" onClick={handleCreateFile}>
                            创建文件
                        </Button>
                    </>
                }
            >
                <FormField
                    label="相对路径（支持子目录，不可含 .. 或以 . 开头）"
                    required
                    error={newFileError ?? undefined}
                    hint="例如：AGENTS.md、docs/style_guide.md、init_vars.json"
                >
                    <TextInput
                        className="ag-mono"
                        value={newFileName}
                        placeholder="docs/style_guide.md"
                        onInput={(val) => {
                            setNewFileName(val);
                            setNewFileError(null);
                        }}
                    />
                </FormField>
            </ShadowModal>
        </div>
    );
}
