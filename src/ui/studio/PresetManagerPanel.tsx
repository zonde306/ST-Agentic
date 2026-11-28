import type { TargetedEvent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    createDefaultPreset,
    exportPreset,
    normalizePreset,
} from '@/core/config';
import type { ApiConnection, MigrationReport, Preset } from '@/core/types';
import {
    Badge,
    Button,
    CodeEditor,
    DropdownMenu,
    FormField,
    SelectInput,
    ShadowModal,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconCheck,
    IconCopy,
    IconCreditCard,
    IconEdit,
    IconExport,
    IconImport,
    IconPlus,
    IconTrash,
} from '@/ui/components/Icons';
import {
    type AppStore,
    type EmbeddedCardStatus,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import {
    allocateUniqueId,
    copyTextToClipboard,
    downloadTextFile,
} from './studio-helpers';

export interface PresetManagerPanelProps {
    store?: AppStore;
    compact?: boolean;
    onPresetChanged?: (presetId: string) => void;
}

type PresetDialogKind = 'create' | 'rename' | 'import' | 'export' | 'embed' | null;

/**
 * Produce a strictly sanitized preset export JSON string using `@/core/config`'s
 * `exportPreset` (never leaks `apiKey`).
 */
export function buildSanitizedPresetExportJson(
    preset: Preset,
    includeConnection?: ApiConnection | null,
): string {
    const payload = exportPreset(preset, {
        includeConnection: includeConnection ?? undefined,
    });
    return JSON.stringify(payload, null, 2);
}

function formatSkippedReason(reason: string): string {
    switch (reason) {
        case 'builtin_slot':
            return '内置槽位 (由 VFS 按需拉取替代)';
        case 'depth_injection':
            return '历史深度注入 @D>=1 (破坏 KV 缓存前缀)';
        case 'unsupported':
            return '暂不支持项';
        default:
            return reason;
    }
}

function MigrationSummaryBanner({ report }: { report: MigrationReport }) {
    return (
        <div class="ag-stack-v">
            <div class="ag-row-wrap">
                <Badge tone="primary">预设：{report.migratedPresets}</Badge>
                <Badge tone="primary">连接：{report.migratedConnections}</Badge>
                <Badge tone="primary">智能体：{report.migratedAgents}</Badge>
                <Badge tone="primary">积木：{report.migratedPromptBlocks}</Badge>
                <Badge tone="primary">触发器：{report.migratedTriggers}</Badge>
                <Badge tone="primary">正则：{report.migratedRegexRules}</Badge>
                <Badge tone="primary">文件：{report.migratedFiles}</Badge>
            </div>

            {report.skippedItems.length > 0 ? (
                <div class="ag-banner ag-banner-warning">
                    <strong>已按缓存安全规则忽略 {report.skippedItems.length} 项：</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {report.skippedItems.map((item, idx) => (
                            <li key={`${item.name}_${idx}`}>
                                <span class="ag-mono">{item.name}</span> —{' '}
                                {formatSkippedReason(item.reason)}
                                {item.detail ? ` (${item.detail})` : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {report.warnings.length > 0 ? (
                <div class="ag-banner ag-banner-primary">
                    <strong>迁移说明：</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {report.warnings.map((w, idx) => (
                            <li key={idx}>{w}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Preset CRUD, sanitized export (`apiKey` stripped), legacy/ST preset migration,
 * and character card PNG embed panel — all sub-modals stay strictly inside Shadow DOM.
 */
export function PresetManagerPanel({
    store: propStore,
    compact = false,
    onPresetChanged,
}: PresetManagerPanelProps) {
    const ctxStore = useAppStoreInstance();
    const store = propStore ?? ctxStore;
    const settings = useAppStore((s) => s.settings);

    const activePreset =
        settings.presets[settings.currentPresetId]
        ?? Object.values(settings.presets)[0];
    const activeConnection =
        settings.connections[settings.currentConnectionId]
        ?? Object.values(settings.connections)[0];
    const presetList = useMemo(
        () => Object.values(settings.presets),
        [settings.presets],
    );

    const [dialogKind, setDialogKind] = useState<PresetDialogKind>(null);
    const [nameInput, setNameInput] = useState('');
    const [importText, setImportText] = useState('');
    const [importNameOverride, setImportNameOverride] = useState('');
    const [includeConnOnExport, setIncludeConnOnExport] = useState(false);
    const [lastImportReport, setLastImportReport] = useState<MigrationReport | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [cardStatus, setCardStatus] = useState<EmbeddedCardStatus | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const presetOptions = useMemo(
        () =>
            presetList.map((p) => ({
                value: p.id,
                label: p.name,
            })),
        [presetList],
    );

    useEffect(() => {
        if (dialogKind !== 'embed') {
            return;
        }
        let cancelled = false;
        void store.services
            .getEmbeddedCardStatus()
            .then((status) => {
                if (!cancelled) {
                    setCardStatus(status);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setCardStatus(null);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [dialogKind, store]);

    const openCreateModal = () => {
        setNameInput('');
        setErrorText(null);
        setDialogKind('create');
    };

    const openRenameModal = () => {
        setNameInput(activePreset?.name ?? '');
        setErrorText(null);
        setDialogKind('rename');
    };

    const handleCreatePreset = async () => {
        const trimmed = nameInput.trim();
        if (!trimmed) {
            setErrorText('请输入预设名称');
            return;
        }
        const id = allocateUniqueId(trimmed, Object.keys(settings.presets), 'preset');
        const created = createDefaultPreset({ id, name: trimmed });
        await store.updateSettings((prev) => ({
            ...prev,
            presets: { ...prev.presets, [created.id]: created },
            currentPresetId: created.id,
        }));
        onPresetChanged?.(created.id);
        setDialogKind(null);
        store.pushToast(`已创建预设：${created.name}`, 'success');
    };

    const handleRenamePreset = async () => {
        if (!activePreset) {
            return;
        }
        const trimmed = nameInput.trim();
        if (!trimmed) {
            setErrorText('预设名称不能为空');
            return;
        }
        await store.updateSettings((prev) => ({
            ...prev,
            presets: {
                ...prev.presets,
                [activePreset.id]: {
                    ...prev.presets[activePreset.id],
                    name: trimmed,
                },
            },
        }));
        setDialogKind(null);
        store.pushToast(`已重命名预设为：${trimmed}`, 'success');
    };

    const handleDuplicatePreset = async () => {
        if (!activePreset) {
            return;
        }
        const copyName = `${activePreset.name} (副本)`;
        const copyId = allocateUniqueId(
            `${activePreset.id}_copy`,
            Object.keys(settings.presets),
            'preset_copy',
        );
        const duplicated = normalizePreset(
            {
                ...activePreset,
                id: copyId,
                name: copyName,
            },
            copyId,
        );
        await store.updateSettings((prev) => ({
            ...prev,
            presets: { ...prev.presets, [duplicated.id]: duplicated },
            currentPresetId: duplicated.id,
        }));
        onPresetChanged?.(duplicated.id);
        store.pushToast(`已复制预设：${duplicated.name}`, 'success');
    };

    const handleDeletePreset = () => {
        if (!activePreset) {
            return;
        }
        if (presetList.length <= 1) {
            store.pushToast('至少需要保留一个预设，无法删除最后一个预设', 'warning');
            return;
        }
        store.openModal({
            kind: 'confirm',
            title: '删除预设确认',
            message: `确定删除预设「${activePreset.name}」吗？该预设下的智能体、触发规则、正则与自定义工具将被一并移除。`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: async () => {
                const remainingIds = Object.keys(store.getSnapshot().settings.presets).filter(
                    (id) => id !== activePreset.id,
                );
                const fallbackId = remainingIds[0] ?? '';
                await store.updateSettings((prev) => {
                    const nextPresets = { ...prev.presets };
                    delete nextPresets[activePreset.id];
                    return {
                        ...prev,
                        presets: nextPresets,
                        currentPresetId: fallbackId,
                    };
                });
                if (fallbackId) {
                    onPresetChanged?.(fallbackId);
                }
                store.pushToast(`已删除预设：${activePreset.name}`, 'warning');
            },
        });
    };

    const sanitizedExportJson = useMemo(() => {
        if (!activePreset) {
            return '{}';
        }
        return buildSanitizedPresetExportJson(
            activePreset,
            includeConnOnExport ? activeConnection : undefined,
        );
    }, [activeConnection, activePreset, includeConnOnExport]);

    const handleDownloadExport = () => {
        if (!activePreset) {
            return;
        }
        const safeFile = (activePreset.name || 'agentic-preset').replace(/[^\w.-]+/g, '_');
        downloadTextFile(`${safeFile}.json`, sanitizedExportJson);
        store.pushToast('已导出脱敏预设 JSON（apiKey 已强制剥离）', 'success');
    };

    const handleCopyExport = async () => {
        const copied = await copyTextToClipboard(sanitizedExportJson);
        store.pushToast(
            copied
                ? '已复制脱敏预设 JSON（apiKey 已强制剥离）'
                : '剪贴板不可用，请从下方编辑区手动复制',
            copied ? 'success' : 'warning',
        );
    };

    const runImportText = async (rawText: string) => {
        if (!rawText.trim()) {
            setErrorText('请先选择 JSON 文件或粘贴预设/迁移内容');
            return;
        }
        try {
            setBusy(true);
            setErrorText(null);
            const parsed: unknown = JSON.parse(rawText);
            const result = await store.services.importPresetOrConfig(parsed, {
                presetName: importNameOverride.trim() || undefined,
            });

            let targetPresetId = '';
            await store.updateSettings((prev) => {
                if (result.settings) {
                    targetPresetId = result.settings.currentPresetId;
                    return result.settings;
                }
                const nextConnections = result.connection
                    ? { ...prev.connections, [result.connection.id]: result.connection }
                    : prev.connections;
                let nextPresets = prev.presets;
                let nextPresetId = prev.currentPresetId;
                if (result.preset) {
                    const uniqueId = prev.presets[result.preset.id]
                        ? allocateUniqueId(result.preset.id, Object.keys(prev.presets), 'imported')
                        : result.preset.id;
                    const normalized = normalizePreset({ ...result.preset, id: uniqueId }, uniqueId);
                    nextPresets = { ...prev.presets, [normalized.id]: normalized };
                    nextPresetId = normalized.id;
                }
                targetPresetId = nextPresetId;
                return {
                    ...prev,
                    connections: nextConnections,
                    presets: nextPresets,
                    currentPresetId: nextPresetId,
                };
            });

            if (targetPresetId) {
                onPresetChanged?.(targetPresetId);
            }
            store.pushToast(result.message, 'success');

            if (result.report) {
                setLastImportReport(result.report);
                setDialogKind(null);
                store.openModal({
                    kind: 'migration_report',
                    title: '导入与自动迁移报告',
                    report: result.report,
                    summary: result.message,
                });
            } else {
                setDialogKind(null);
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setErrorText(`导入失败：${msg}`);
            store.pushToast(`导入失败：${msg}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleFileUpload = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const file = event.currentTarget.files?.[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const content = typeof reader.result === 'string' ? reader.result : '';
            setImportText(content);
            void runImportText(content);
        };
        reader.readAsText(file);
        event.currentTarget.value = '';
    };

    const handleEmbedPreset = async () => {
        if (!activePreset) {
            return;
        }
        try {
            setBusy(true);
            const msg = await store.services.embedPresetToCard(activePreset.id);
            setCardStatus(await store.services.getEmbeddedCardStatus());
            store.pushToast(msg, 'success');
        } catch (error) {
            store.pushToast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleEmbedFiles = async () => {
        if (!activePreset) {
            return;
        }
        try {
            setBusy(true);
            const msg = await store.services.embedFilesToCard(activePreset.files);
            setCardStatus(await store.services.getEmbeddedCardStatus());
            store.pushToast(msg, 'success');
        } catch (error) {
            store.pushToast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleImportFromCard = async () => {
        try {
            setBusy(true);
            const res = await store.services.importEmbeddedFromCard();
            setCardStatus(await store.services.getEmbeddedCardStatus());
            store.pushToast(res.message, 'success');
            if (res.report) {
                setDialogKind(null);
                store.openModal({
                    kind: 'migration_report',
                    title: '角色卡嵌入迁移报告',
                    report: res.report,
                    summary: res.message,
                });
            }
        } catch (error) {
            store.pushToast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div class={compact ? 'ag-toolbar ag-toolbar-compact' : 'ag-toolbar'}>
            <div class="ag-toolbar-group" style={{ flex: '1 1 260px' }}>
                <span class="ag-toolbar-label">当前预设</span>
                <div style={{ flex: '1 1 180px', minWidth: 0, maxWidth: '320px' }}>
                    <SelectInput
                        ariaLabel="切换当前预设"
                        value={activePreset?.id ?? ''}
                        options={presetOptions}
                        onChange={(id) => {
                            void store.setCurrentPreset(id);
                            onPresetChanged?.(id);
                        }}
                    />
                </div>
                {activePreset ? (
                    <span class="ag-toolbar-meta">
                        {Object.keys(activePreset.agents).length} 智能体 ·{' '}
                        {activePreset.triggers.length} 触发 ·{' '}
                        {activePreset.regexRules.length} 正则
                    </span>
                ) : null}
            </div>

            <div class="ag-toolbar-group">
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconPlus size={16} />}
                    title="新建预设"
                    onClick={openCreateModal}
                >
                    新建
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconImport size={16} />}
                    title="导入预设 / 旧版自动迁移"
                    onClick={() => {
                        setErrorText(null);
                        setLastImportReport(null);
                        setDialogKind('import');
                    }}
                >
                    导入
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconExport size={16} />}
                    title="导出脱敏预设"
                    onClick={() => setDialogKind('export')}
                >
                    导出
                </Button>
                <DropdownMenu
                    ariaLabel="更多预设操作"
                    items={[
                        {
                            id: 'rename',
                            label: '重命名',
                            icon: <IconEdit size={15} />,
                            onSelect: openRenameModal,
                        },
                        {
                            id: 'duplicate',
                            label: '复制预设',
                            icon: <IconCopy size={15} />,
                            onSelect: () => void handleDuplicatePreset(),
                        },
                        {
                            id: 'embed',
                            label: '角色卡嵌入',
                            icon: <IconCreditCard size={15} />,
                            onSelect: () => setDialogKind('embed'),
                        },
                        {
                            id: 'delete',
                            label: '删除预设',
                            icon: <IconTrash size={15} />,
                            danger: true,
                            separatorBefore: true,
                            disabled: presetList.length <= 1,
                            onSelect: handleDeletePreset,
                        },
                    ]}
                />
            </div>

            {/* Create / Rename Preset Modal (Shadow DOM) */}
            <ShadowModal
                open={dialogKind === 'create' || dialogKind === 'rename'}
                title={dialogKind === 'create' ? '新建预设' : '重命名当前预设'}
                maxWidth="440px"
                onClose={() => setDialogKind(null)}
                footer={
                    <>
                        <Button variant="secondary" onClick={() => setDialogKind(null)}>
                            取消
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() =>
                                void (dialogKind === 'create'
                                    ? handleCreatePreset()
                                    : handleRenamePreset())
                            }
                        >
                            确认
                        </Button>
                    </>
                }
            >
                <div class="ag-stack-v">
                    <FormField label="预设名称" required error={errorText ?? undefined}>
                        <TextInput
                            value={nameInput}
                            placeholder="例如：群像古风写作预设"
                            onInput={setNameInput}
                            onChange={setNameInput}
                        />
                    </FormField>
                </div>
            </ShadowModal>

            {/* Import / Migration Modal (Shadow DOM) */}
            <ShadowModal
                open={dialogKind === 'import'}
                title="导入预设 / 旧版自动迁移"
                maxWidth="640px"
                onClose={() => setDialogKind(null)}
                footer={
                    <Button variant="secondary" onClick={() => setDialogKind(null)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-primary">
                        支持导入 ST-Agentic 预设、旧版 ST-CustomGeneration 配置/预设（无损只读迁移），以及传统 ST OpenAI 预设（仅保留 relative → prefix 与 @D0 → tail，自动跳过内置槽位与 @D&gt;=1 深度注入）。
                    </div>

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                    />

                    <FormField label="可选自定义预设名称">
                        <TextInput
                            value={importNameOverride}
                            placeholder="留空则沿用文件内的预设名称"
                            onInput={setImportNameOverride}
                        />
                    </FormField>

                    <div class="ag-row-wrap">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            icon={<IconImport size={14} />}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            选择 JSON 文件
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            loading={busy}
                            disabled={!importText.trim()}
                            icon={<IconCheck size={14} />}
                            onClick={() => void runImportText(importText)}
                        >
                            解析并导入
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                                setDialogKind(null);
                                store.openModal({ kind: 'import_manager' });
                            }}
                        >
                            打开完整导入/嵌卡中心
                        </Button>
                    </div>

                    <CodeEditor
                        label="粘贴预设或旧版配置 JSON"
                        languageHint="json"
                        rows={6}
                        minHeight="140px"
                        showToolbar={false}
                        placeholder='{"format": "st-agentic-preset", ...}'
                        value={importText}
                        onChange={setImportText}
                    />

                    {errorText ? <div class="ag-banner ag-banner-error">{errorText}</div> : null}
                    {lastImportReport ? <MigrationSummaryBanner report={lastImportReport} /> : null}
                </div>
            </ShadowModal>

            {/* Sanitized Export Modal (Shadow DOM) */}
            <ShadowModal
                open={dialogKind === 'export'}
                title={`导出预设：${activePreset?.name ?? ''}`}
                maxWidth="600px"
                onClose={() => setDialogKind(null)}
                footer={
                    <Button variant="secondary" onClick={() => setDialogKind(null)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-success">
                        导出始终通过 <span class="ag-mono">exportPreset</span> 执行强制脱敏，任何 API Key 均会被置空。
                    </div>
                    <ToggleSwitch
                        checked={includeConnOnExport}
                        onChange={setIncludeConnOnExport}
                        label="附带当前主 API 连接参数"
                        description="仅保留 Base URL / 模型与采样参数，apiKey 严格剥离为空字符串"
                    />
                    <div class="ag-row-wrap">
                        <Button
                            variant="primary"
                            size="sm"
                            icon={<IconExport size={14} />}
                            onClick={handleDownloadExport}
                        >
                            导出 JSON 文件
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconCopy size={14} />}
                            onClick={() => void handleCopyExport()}
                        >
                            复制 JSON
                        </Button>
                    </div>
                    <CodeEditor
                        label="脱敏导出预览"
                        languageHint="json"
                        readOnly
                        rows={8}
                        minHeight="160px"
                        showToolbar={false}
                        value={sanitizedExportJson}
                        onChange={() => {}}
                    />
                </div>
            </ShadowModal>

            {/* Character Card PNG Embed Modal (Shadow DOM) */}
            <ShadowModal
                open={dialogKind === 'embed'}
                title="角色卡 PNG 嵌入管理 (embed-card)"
                maxWidth="560px"
                onClose={() => setDialogKind(null)}
                footer={
                    <Button variant="secondary" onClick={() => setDialogKind(null)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-row-wrap">
                        <Badge tone="primary">
                            当前角色：{cardStatus?.characterName ?? '读取中...'}
                        </Badge>
                        {cardStatus?.fromLegacy ? (
                            <Badge tone="warning">检测到旧版 cg_embed_*</Badge>
                        ) : null}
                        <Badge tone={cardStatus?.hasPresets ? 'success' : 'neutral'}>
                            内嵌预设：{cardStatus?.presetCount ?? 0}
                        </Badge>
                        <Badge tone={cardStatus?.hasFiles ? 'success' : 'neutral'}>
                            内嵌文件：{cardStatus?.fileCount ?? 0}
                        </Badge>
                    </div>

                    <div class="ag-banner ag-banner-primary">
                        写入将同步更新角色卡扩展字段（<span class="ag-mono">agentic_embed_presets</span> /{' '}
                        <span class="ag-mono">agentic_embed_files</span>），并在导入时自动兼容旧版{' '}
                        <span class="ag-mono">cg_embed_*</span> 数据迁移。
                    </div>

                    <div class="ag-row-wrap">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy || !activePreset}
                            onClick={() => void handleEmbedPreset()}
                        >
                            关联当前预设到角色卡
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy || !activePreset}
                            onClick={() => void handleEmbedFiles()}
                        >
                            关联 /preset/* 文件到角色卡 ({Object.keys(activePreset?.files ?? {}).length})
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={busy || (!cardStatus?.hasPresets && !cardStatus?.hasFiles)}
                            onClick={() => void handleImportFromCard()}
                        >
                            从角色卡导入预设与文件
                        </Button>
                    </div>
                </div>
            </ShadowModal>
        </div>
    );
}
