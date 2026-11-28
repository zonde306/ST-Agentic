import type { TargetedEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
    Badge,
    Button,
    Card,
    CodeEditor,
    ShadowModal,
    ToggleSwitch,
} from '../components';
import {
    IconCheck,
    IconCopy,
    IconExport,
    IconImport,
} from '../components/Icons';
import {
    type ActiveModalState,
    type EmbeddedCardStatus,
    useAppStore,
    useAppStoreInstance,
} from '../store/app-store';

function downloadTextFile(filename: string, text: string): void {
    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        return;
    }
    try {
        const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
        // Ignore download failure in restricted environments.
    }
}

function ImportManagerBody() {
    const store = useAppStoreInstance();
    const settings = useAppStore((state) => state.settings);
    const activePreset = settings.presets[settings.currentPresetId];

    const [jsonInput, setJsonInput] = useState('');
    const [includeConn, setIncludeConn] = useState(false);
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [cardStatus, setCardStatus] = useState<EmbeddedCardStatus | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        let cancelled = false;
        void store.services
            .getEmbeddedCardStatus()
            .then((status) => {
                if (!cancelled) {
                    setCardStatus(status);
                }
            })
            .catch(() => {
                // Keep card status optional in minimal environments.
            });
        return () => {
            cancelled = true;
        };
    }, [store]);

    const handleExportPreset = async (copyOnly = false) => {
        try {
            setBusy(true);
            setErrorText(null);
            const exported = await store.services.exportPresetJson(
                settings.currentPresetId,
                includeConn,
            );
            if (copyOnly) {
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(exported);
                }
                store.pushToast('已复制脱敏预设 JSON（已强制剥离 apiKey）', 'success');
            } else {
                const safeName = (activePreset?.name || 'agentic-preset').replace(/[^\w.-]+/g, '_');
                downloadTextFile(`${safeName}.json`, exported);
                store.pushToast('已导出脱敏预设 JSON 文件（已强制剥离 apiKey）', 'success');
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setErrorText(msg);
        } finally {
            setBusy(false);
        }
    };

    const runImportFromText = async (rawText: string) => {
        if (!rawText.trim()) {
            setErrorText('请先选择 JSON 文件或粘贴预设/配置内容');
            return;
        }
        try {
            setBusy(true);
            setErrorText(null);
            const parsed: unknown = JSON.parse(rawText);
            const result = await store.services.importPresetOrConfig(parsed);

            await store.updateSettings((prev) => {
                if (result.settings) {
                    return result.settings;
                }
                const nextConnections = result.connection
                    ? { ...prev.connections, [result.connection.id]: result.connection }
                    : prev.connections;
                const nextPresets = result.preset
                    ? { ...prev.presets, [result.preset.id]: result.preset }
                    : prev.presets;
                return {
                    ...prev,
                    connections: nextConnections,
                    presets: nextPresets,
                    currentPresetId: result.preset ? result.preset.id : prev.currentPresetId,
                };
            });

            store.pushToast(result.message, 'success');
            if (result.report) {
                store.openModal({
                    kind: 'migration_report',
                    title: '导入与迁移报告',
                    report: result.report,
                    summary: result.message,
                });
            } else {
                store.closeModal();
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setErrorText(`导入失败：${msg}`);
            store.pushToast(`导入失败：${msg}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleFileSelected = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const file = event.currentTarget.files?.[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const content = typeof reader.result === 'string' ? reader.result : '';
            setJsonInput(content);
            void runImportFromText(content);
        };
        reader.readAsText(file);
        event.currentTarget.value = '';
    };

    const handleEmbedPreset = async () => {
        try {
            setBusy(true);
            const msg = await store.services.embedPresetToCard(settings.currentPresetId);
            const nextStatus = await store.services.getEmbeddedCardStatus();
            setCardStatus(nextStatus);
            store.pushToast(msg, 'success');
        } catch (error) {
            store.pushToast(error instanceof Error ? error.message : String(error), 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleImportCard = async () => {
        try {
            setBusy(true);
            const res = await store.services.importEmbeddedFromCard();
            const nextStatus = await store.services.getEmbeddedCardStatus();
            setCardStatus(nextStatus);
            store.pushToast(res.message, 'success');
            if (res.report) {
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
        <div class="ag-stack-v">
            <Card
                title="1. 导出当前预设"
                subtitle={`当前预设：${activePreset?.name ?? settings.currentPresetId}（导出始终强制剥离 API Key）`}
            >
                <div class="ag-stack-v">
                    <ToggleSwitch
                        checked={includeConn}
                        onChange={setIncludeConn}
                        label="附带当前主连接参数"
                        description="仅导出 Base URL / 模型与采样参数，apiKey 始终置空"
                    />
                    <div class="ag-row-wrap">
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={busy}
                            icon={<IconExport size={14} />}
                            onClick={() => void handleExportPreset(false)}
                        >
                            导出预设 JSON
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            icon={<IconCopy size={14} />}
                            onClick={() => void handleExportPreset(true)}
                        >
                            复制到剪贴板
                        </Button>
                    </div>
                </div>
            </Card>

            <Card
                title="2. 导入预设 / 自动迁移"
                subtitle="自动识别 ST-Agentic、旧版 ST-CustomGeneration 与传统 ST OpenAI 预设"
            >
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-primary">
                        传统 ST 预设仅提取用户自定义块（relative → prefix，@D0 → tail），自动忽略内置槽位与 @D&gt;=1 深度注入以守护 KV Cache 不变量。
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleFileSelected}
                    />
                    <div class="ag-row-wrap">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            icon={<IconImport size={14} />}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            选择 JSON 文件导入
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={busy || !jsonInput.trim()}
                            icon={<IconCheck size={14} />}
                            onClick={() => void runImportFromText(jsonInput)}
                        >
                            导入粘贴内容
                        </Button>
                    </div>
                    <CodeEditor
                        label="或直接粘贴 JSON"
                        languageHint="json"
                        rows={5}
                        minHeight="120px"
                        showToolbar={false}
                        placeholder='{"format":"st-agentic-preset", ...}'
                        value={jsonInput}
                        onChange={setJsonInput}
                    />
                    {errorText ? <div class="ag-banner ag-banner-error">{errorText}</div> : null}
                </div>
            </Card>

            <Card
                title="3. 角色卡 PNG 嵌入数据 (embed-card)"
                subtitle={
                    cardStatus
                        ? `当前角色：${cardStatus.characterName}`
                        : '读取角色卡嵌入状态中...'
                }
                actions={
                    cardStatus?.fromLegacy ? (
                        <Badge tone="warning">检测到旧版 cg_embed_*</Badge>
                    ) : null
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-row-wrap">
                        <Badge tone={cardStatus?.hasPresets ? 'success' : 'neutral'}>
                            内嵌预设：{cardStatus?.presetCount ?? 0}
                        </Badge>
                        <Badge tone={cardStatus?.hasFiles ? 'success' : 'neutral'}>
                            内嵌文件：{cardStatus?.fileCount ?? 0}
                        </Badge>
                    </div>
                    <div class="ag-row-wrap">
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => void handleEmbedPreset()}
                        >
                            关联当前预设到角色卡
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={busy || (!cardStatus?.hasPresets && !cardStatus?.hasFiles)}
                            onClick={() => void handleImportCard()}
                        >
                            从角色卡导入预设与文件
                        </Button>
                    </div>
                </div>
            </Card>
        </div>
    );
}

function MigrationReportBody({
    modal,
}: {
    modal: Extract<ActiveModalState, { kind: 'migration_report' }>;
}) {
    const { report, summary } = modal;
    return (
        <div class="ag-stack-v">
            {summary ? <div class="ag-banner ag-banner-success">{summary}</div> : null}
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
                                <span class="ag-mono">{item.name}</span> — {item.reason}
                                {item.detail ? ` (${item.detail})` : ''}
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}

            {report.warnings.length > 0 ? (
                <div class="ag-banner ag-banner-primary">
                    <strong>迁移提示：</strong>
                    <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                        {report.warnings.map((warning, idx) => (
                            <li key={idx}>{warning}</li>
                        ))}
                    </ul>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Renders the active modal managed by `AppStore.activeModal` strictly inside Shadow DOM.
 */
export function ActiveAppModal() {
    const store = useAppStoreInstance();
    const activeModal = useAppStore((state) => state.activeModal);
    const [confirmBusy, setConfirmBusy] = useState(false);

    if (!activeModal) {
        return null;
    }

    if (activeModal.kind === 'import_manager') {
        return (
            <ShadowModal
                open
                title="导入 / 迁移与角色卡 PNG 嵌入管理"
                maxWidth="640px"
                onClose={() => store.closeModal()}
                footer={
                    <Button variant="secondary" onClick={() => store.closeModal()}>
                        关闭
                    </Button>
                }
            >
                <ImportManagerBody />
            </ShadowModal>
        );
    }

    if (activeModal.kind === 'migration_report') {
        return (
            <ShadowModal
                open
                title={activeModal.title}
                maxWidth="580px"
                onClose={() => store.closeModal()}
                footer={
                    <Button variant="primary" onClick={() => store.closeModal()}>
                        确认
                    </Button>
                }
            >
                <MigrationReportBody modal={activeModal} />
            </ShadowModal>
        );
    }

    if (activeModal.kind === 'confirm') {
        const handleConfirm = async () => {
            try {
                setConfirmBusy(true);
                await activeModal.onConfirm();
                store.closeModal();
            } finally {
                setConfirmBusy(false);
            }
        };

        return (
            <ShadowModal
                open
                title={activeModal.title}
                maxWidth="460px"
                onClose={() => store.closeModal()}
                footer={
                    <>
                        <Button
                            variant="secondary"
                            disabled={confirmBusy}
                            onClick={() => store.closeModal()}
                        >
                            {activeModal.cancelLabel ?? '取消'}
                        </Button>
                        <Button
                            variant={activeModal.tone === 'danger' ? 'danger' : 'primary'}
                            loading={confirmBusy}
                            onClick={() => void handleConfirm()}
                        >
                            {activeModal.confirmLabel ?? '确认'}
                        </Button>
                    </>
                }
            >
                <div style={{ whiteSpace: 'pre-wrap' }}>{activeModal.message}</div>
            </ShadowModal>
        );
    }

    if (activeModal.kind === 'info') {
        return (
            <ShadowModal
                open
                title={activeModal.title}
                maxWidth="480px"
                onClose={() => store.closeModal()}
                footer={
                    <Button variant="primary" onClick={() => store.closeModal()}>
                        知道了
                    </Button>
                }
            >
                <div style={{ whiteSpace: 'pre-wrap' }}>{activeModal.message}</div>
            </ShadowModal>
        );
    }

    return null;
}
