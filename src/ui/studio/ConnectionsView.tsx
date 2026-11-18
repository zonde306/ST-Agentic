import type { TargetedEvent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    createDefaultConnection,
    exportConnections,
    importConnections,
} from '@/core/config';
import type {
    ApiConnection,
    ApiProviderFormat,
    CachePolicy,
    Settings,
} from '@/core/types';
import {
    Badge,
    Button,
    Card,
    CodeEditor,
    EmptyState,
    FormField,
    MasterDetailLayout,
    SelectInput,
    ShadowModal,
    TextInput,
    ToggleSwitch,
    useIsMobileViewport,
} from '@/ui/components';
import {
    IconCopy,
    IconDownload,
    IconPlay,
    IconPlug,
    IconPlus,
    IconTrash,
    IconUpload,
} from '@/ui/components/Icons';
import {
    type ConnectionTestResult,
    type ConsoleViewProps,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import {
    allocateUniqueId,
    copyTextToClipboard,
    downloadTextFile,
    parseYamlTextToRecord,
    recordToYamlText,
    useDraftNumber,
    useDraftString,
} from './studio-helpers';

/**
 * Produce a strictly sanitized connections export JSON string delegating to
 * `@/core/config`'s `exportConnections` (`apiKey` strictly stripped).
 */
export function buildSanitizedConnectionsExportJson(settings: Settings): string {
    return JSON.stringify(exportConnections(settings), null, 2);
}

interface YamlRecordEditorProps {
    resetKey: string;
    label: string;
    hint: string;
    placeholder: string;
    record: Record<string, unknown>;
    onCommit: (next: Record<string, unknown>) => void;
}

function YamlRecordEditor({
    resetKey,
    label,
    hint,
    placeholder,
    record,
    onCommit,
}: YamlRecordEditorProps) {
    const serialized = useMemo(() => recordToYamlText(record), [record]);
    const [text, setText] = useState(serialized);
    const [parseError, setParseError] = useState<string | null>(null);
    const prevKeyRef = useRef(resetKey);
    const lastCommittedRef = useRef(serialized);

    useEffect(() => {
        if (prevKeyRef.current !== resetKey) {
            prevKeyRef.current = resetKey;
            lastCommittedRef.current = serialized;
            setText(serialized);
            setParseError(null);
            return;
        }
        if (serialized !== lastCommittedRef.current) {
            lastCommittedRef.current = serialized;
            setText(serialized);
            setParseError(null);
        }
    }, [resetKey, serialized]);

    const handleChange = (nextText: string) => {
        setText(nextText);
        const parsed = parseYamlTextToRecord(nextText);
        if (!parsed.ok) {
            setParseError(parsed.error);
            return;
        }
        setParseError(null);
        const nextSerialized = recordToYamlText(parsed.value);
        lastCommittedRef.current = nextSerialized;
        onCommit(parsed.value);
    };

    return (
        <div class="ag-stack-v" style={{ gap: '6px' }}>
            <CodeEditor
                label={label}
                languageHint="yaml"
                rows={4}
                minHeight="108px"
                showToolbar={false}
                placeholder={placeholder}
                value={text}
                onChange={handleChange}
            />
            {parseError ? (
                <div class="ag-banner ag-banner-warning">YAML 语法尚未完成或无效：{parseError}</div>
            ) : (
                <div class="ag-field-hint">{hint}</div>
            )}
        </div>
    );
}

/**
 * View ⑨: Multi-Connection API & Cache Policy Manager (`tabId: 'connections'`).
 * Manages `settings.connections`, OpenAI/Anthropic formats, masked `apiKey`, sampling parameters,
 * concurrency limits, `cachePolicy`, YAML headers/body overrides, sanitized export, and live test.
 */
export function ConnectionsView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const connectionList = useMemo(
        () => Object.values(settings.connections),
        [settings.connections],
    );

    const [selectedConnId, setSelectedConnId] = useState<string>(
        settings.currentConnectionId || connectionList[0]?.id || '',
    );
    const [detailOpen, setDetailOpen] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

    const [importOpen, setImportOpen] = useState(false);
    const [importText, setImportText] = useState('');
    const [importError, setImportError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!settings.connections[selectedConnId]) {
            setSelectedConnId(settings.currentConnectionId || connectionList[0]?.id || '');
        }
    }, [connectionList, selectedConnId, settings.connections, settings.currentConnectionId]);

    const activeConn: ApiConnection | undefined =
        settings.connections[selectedConnId]
        ?? settings.connections[settings.currentConnectionId]
        ?? connectionList[0];

    const mutateActiveConn = (updater: (conn: ApiConnection) => ApiConnection) => {
        if (!activeConn) {
            return;
        }
        void store.updateSettings((prev) => {
            const current = prev.connections[activeConn.id];
            if (!current) {
                return prev;
            }
            return {
                ...prev,
                connections: {
                    ...prev.connections,
                    [current.id]: updater(current),
                },
            };
        });
    };

    const resetKey = activeConn?.id ?? '';
    const nameDraft = useDraftString(
        resetKey,
        activeConn?.name ?? '',
        (name) => mutateActiveConn((c) => ({ ...c, name })),
        { allowEmpty: false },
    );
    const baseUrlDraft = useDraftString(
        resetKey,
        activeConn?.baseUrl ?? '',
        (baseUrl) => mutateActiveConn((c) => ({ ...c, baseUrl })),
        { allowEmpty: false },
    );
    const apiKeyDraft = useDraftString(
        resetKey,
        activeConn?.apiKey ?? '',
        (apiKey) => mutateActiveConn((c) => ({ ...c, apiKey })),
        { allowEmpty: true },
    );
    const modelDraft = useDraftString(
        resetKey,
        activeConn?.model ?? '',
        (model) => mutateActiveConn((c) => ({ ...c, model })),
        { allowEmpty: true },
    );
    const contextSizeDraft = useDraftNumber(
        resetKey,
        activeConn?.contextSize ?? 64000,
        (contextSize) => mutateActiveConn((c) => ({ ...c, contextSize })),
        { min: 1, max: 10_000_000, integer: true },
    );
    const maxTokensDraft = useDraftNumber(
        resetKey,
        activeConn?.maxTokens ?? 4096,
        (maxTokens) => mutateActiveConn((c) => ({ ...c, maxTokens })),
        { min: 1, max: 1_000_000, integer: true },
    );
    const temperatureDraft = useDraftNumber(
        resetKey,
        activeConn?.temperature ?? 0.8,
        (temperature) => mutateActiveConn((c) => ({ ...c, temperature })),
        { min: 0, max: 2, integer: false },
    );
    const topPDraft = useDraftNumber(
        resetKey,
        activeConn?.topP ?? 1,
        (topP) => mutateActiveConn((c) => ({ ...c, topP })),
        { min: 0, max: 1, integer: false },
    );
    const topKDraft = useDraftNumber(
        resetKey,
        activeConn?.topK ?? 0,
        (topK) => mutateActiveConn((c) => ({ ...c, topK })),
        { min: 0, max: 1_000_000, integer: true },
    );
    const freqPenaltyDraft = useDraftNumber(
        resetKey,
        activeConn?.frequencyPenalty ?? 0,
        (frequencyPenalty) => mutateActiveConn((c) => ({ ...c, frequencyPenalty })),
        { min: -2, max: 2, integer: false },
    );
    const presPenaltyDraft = useDraftNumber(
        resetKey,
        activeConn?.presencePenalty ?? 0,
        (presencePenalty) => mutateActiveConn((c) => ({ ...c, presencePenalty })),
        { min: -2, max: 2, integer: false },
    );
    const maxConcDraft = useDraftNumber(
        resetKey,
        activeConn?.maxConcurrency ?? 2,
        (maxConcurrency) => mutateActiveConn((c) => ({ ...c, maxConcurrency })),
        { min: 1, max: 100, integer: true },
    );
    const maxBreakpointsDraft = useDraftNumber(
        resetKey,
        activeConn?.maxCacheBreakpoints ?? 4,
        (maxCacheBreakpoints) => mutateActiveConn((c) => ({ ...c, maxCacheBreakpoints })),
        { min: 0, max: 4, integer: true },
    );

    const linkedPresetOptions = useMemo(
        () => [
            { value: '', label: '不自动联动预设' },
            ...Object.values(settings.presets).map((p) => ({
                value: p.id,
                label: p.name,
            })),
        ],
        [settings.presets],
    );

    const handleCreateConnection = () => {
        const id = allocateUniqueId('conn', Object.keys(settings.connections), 'conn');
        const created = createDefaultConnection({
            id,
            name: `新连接 ${connectionList.length + 1}`,
        });
        void store.updateSettings((prev) => ({
            ...prev,
            connections: {
                ...prev.connections,
                [created.id]: created,
            },
        }));
        setSelectedConnId(created.id);
        setTestResult(null);
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已新增 API 连接：${created.name}`, 'success');
    };

    const handleDuplicateConnection = () => {
        if (!activeConn) {
            return;
        }
        const id = allocateUniqueId(
            `${activeConn.id}_copy`,
            Object.keys(settings.connections),
            'conn_copy',
        );
        const clone = createDefaultConnection({
            ...activeConn,
            id,
            name: `${activeConn.name} (副本)`,
        });
        void store.updateSettings((prev) => ({
            ...prev,
            connections: {
                ...prev.connections,
                [clone.id]: clone,
            },
        }));
        setSelectedConnId(clone.id);
        setTestResult(null);
        store.pushToast(`已复制 API 连接：${clone.name}`, 'success');
    };

    const handleDeleteConnection = () => {
        if (!activeConn) {
            return;
        }
        if (connectionList.length <= 1) {
            store.pushToast('至少需要保留一个 API 连接', 'warning');
            return;
        }
        store.openModal({
            kind: 'confirm',
            title: '删除 API 连接确认',
            message: `确定删除连接「${activeConn.name}」吗？绑定到该连接的智能体将需要重新指定或回退主连接。`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: async () => {
                const remaining = Object.keys(store.getSnapshot().settings.connections).filter(
                    (id) => id !== activeConn.id,
                );
                const nextPrimary = remaining[0] ?? '';
                await store.updateSettings((prev) => {
                    const nextConns = { ...prev.connections };
                    delete nextConns[activeConn.id];
                    return {
                        ...prev,
                        connections: nextConns,
                        currentConnectionId:
                            prev.currentConnectionId === activeConn.id
                                ? nextPrimary
                                : prev.currentConnectionId,
                    };
                });
                setSelectedConnId(nextPrimary);
                setDetailOpen(false);
                store.pushToast(`已删除连接：${activeConn.name}`, 'warning');
            },
        });
    };

    const handleTestConnection = async () => {
        if (!activeConn) {
            return;
        }
        try {
            setTesting(true);
            const res = await store.services.testConnection(activeConn);
            setTestResult(res);
            store.pushToast(res.message, res.ok ? 'success' : 'error');
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult({
                ok: false,
                latencyMs: 0,
                message: `连通测试失败：${msg}`,
            });
            store.pushToast(`连通测试失败：${msg}`, 'error');
        } finally {
            setTesting(false);
        }
    };

    const handleExportConnections = async (copyOnly: boolean) => {
        const json = buildSanitizedConnectionsExportJson(settings);
        if (copyOnly) {
            const ok = await copyTextToClipboard(json);
            store.pushToast(
                ok
                    ? '已复制脱敏连接 JSON（apiKey 已强制剥离）'
                    : '剪贴板不可用',
                ok ? 'success' : 'warning',
            );
        } else {
            downloadTextFile('agentic-connections.json', json);
            store.pushToast('已导出脱敏连接 JSON 文件（apiKey 已强制剥离）', 'success');
        }
    };

    const runImportConnections = (rawText: string) => {
        try {
            setImportError(null);
            const parsed: unknown = JSON.parse(rawText);
            const imported = importConnections(parsed);
            void store.updateSettings((prev) => ({
                ...prev,
                connections: {
                    ...prev.connections,
                    ...imported.connections,
                },
            }));
            setImportOpen(false);
            setImportText('');
            store.pushToast(
                `已导入 ${Object.keys(imported.connections).length} 个连接配置`,
                'success',
            );
        } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
        }
    };

    const handleImportFile = (event: TargetedEvent<HTMLInputElement, Event>) => {
        const file = event.currentTarget.files?.[0];
        if (!file) {
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            const text = typeof reader.result === 'string' ? reader.result : '';
            setImportText(text);
            runImportConnections(text);
        };
        reader.readAsText(file);
        event.currentTarget.value = '';
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    API 连接列表 ({connectionList.length})
                </span>
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={handleCreateConnection}
                >
                    新建连接
                </Button>
            </div>

            <div class="ag-row-wrap">
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconUpload size={14} />}
                    onClick={() => {
                        setImportError(null);
                        setImportOpen(true);
                    }}
                >
                    导入连接
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconDownload size={14} />}
                    onClick={() => void handleExportConnections(false)}
                >
                    导出脱敏
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconCopy size={14} />}
                    onClick={() => void handleExportConnections(true)}
                >
                    复制
                </Button>
            </div>

            <div class="ag-list" style={{ padding: 0 }}>
                {connectionList.map((conn) => {
                    const isPrimary = conn.id === settings.currentConnectionId;
                    const isSelected = activeConn?.id === conn.id;
                    return (
                        <button
                            key={conn.id}
                            type="button"
                            class={
                                isSelected && !isMobile
                                    ? 'ag-list-item ag-list-item-active'
                                    : 'ag-list-item'
                            }
                            onClick={() => {
                                setSelectedConnId(conn.id);
                                setTestResult(null);
                                if (isMobile) {
                                    setDetailOpen(true);
                                }
                            }}
                        >
                            <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                <span class="ag-list-item-title">{conn.name}</span>
                                <div class="ag-row-wrap">
                                    {isPrimary ? <Badge tone="success">主连接</Badge> : null}
                                    <Badge tone={conn.providerFormat === 'anthropic' ? 'primary' : 'neutral'}>
                                        {conn.providerFormat}
                                    </Badge>
                                </div>
                            </div>
                            <div class="ag-list-item-meta">
                                <span class="ag-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {conn.model || '(未配置 Model)'}
                                </span>
                                <span>{conn.cachePolicy}</span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );

    const detailPane = activeConn ? (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={
                        <span class="ag-row-wrap">
                            <span>{activeConn.name}</span>
                            {activeConn.id === settings.currentConnectionId ? (
                                <Badge tone="success">当前主连接</Badge>
                            ) : null}
                            <Badge tone="neutral" className="ag-mono">
                                {activeConn.id}
                            </Badge>
                        </span>
                    }
                    subtitle="配置多模型端点、缓存断点策略、并发上限、采样参数与自定义 Header/Body YAML"
                    actions={
                        <div class="ag-row-wrap">
                            {activeConn.id !== settings.currentConnectionId ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => void store.setCurrentConnection(activeConn.id)}
                                >
                                    设为主连接
                                </Button>
                            ) : null}
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<IconCopy size={14} />}
                                onClick={handleDuplicateConnection}
                            >
                                复制
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                icon={<IconTrash size={14} />}
                                disabled={connectionList.length <= 1}
                                onClick={handleDeleteConnection}
                            >
                                删除
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-2">
                            <FormField label="连接名称" required>
                                <TextInput
                                    value={nameDraft.value}
                                    onInput={nameDraft.onInput}
                                    onChange={nameDraft.onChange}
                                />
                            </FormField>

                            <FormField label="接口协议格式 (providerFormat)">
                                <SelectInput<ApiProviderFormat>
                                    value={activeConn.providerFormat}
                                    options={[
                                        { value: 'openai', label: 'OpenAI 兼容格式 (/chat/completions)' },
                                        { value: 'anthropic', label: 'Anthropic Messages 格式 (/messages)' },
                                    ]}
                                    onChange={(providerFormat) =>
                                        mutateActiveConn((c) => ({ ...c, providerFormat }))
                                    }
                                />
                            </FormField>

                            <FormField label="Endpoint (Base URL)" required>
                                <TextInput
                                    type="url"
                                    className="ag-mono"
                                    value={baseUrlDraft.value}
                                    placeholder="https://api.openai.com/v1"
                                    onInput={baseUrlDraft.onInput}
                                    onChange={baseUrlDraft.onChange}
                                />
                            </FormField>

                            <FormField label="Model ID">
                                <TextInput
                                    className="ag-mono"
                                    value={modelDraft.value}
                                    placeholder="claude-sonnet-4.5 / gpt-4.1"
                                    onInput={modelDraft.onInput}
                                    onChange={modelDraft.onChange}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label="API Key (本地存储，导出预设/连接时始终强制剥离)"
                        >
                            <div class="ag-row">
                                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                                    <TextInput
                                        type={showApiKey ? 'text' : 'password'}
                                        className="ag-mono"
                                        value={apiKeyDraft.value}
                                        placeholder="sk-..."
                                        onInput={apiKeyDraft.onInput}
                                        onChange={apiKeyDraft.onChange}
                                    />
                                </div>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => setShowApiKey((v) => !v)}
                                >
                                    {showApiKey ? '隐藏' : '显示'}
                                </Button>
                            </div>
                        </FormField>

                        <div class="ag-row-wrap">
                            <Button
                                variant="primary"
                                loading={testing}
                                icon={<IconPlay size={14} />}
                                onClick={() => void handleTestConnection()}
                            >
                                测试连通与缓存
                            </Button>
                            <ToggleSwitch
                                checked={activeConn.stream}
                                onChange={(stream) => mutateActiveConn((c) => ({ ...c, stream }))}
                                label="启用 SSE 流式输出 (stream)"
                            />
                        </div>

                        {testResult ? (
                            <div
                                class={
                                    testResult.ok
                                        ? 'ag-banner ag-banner-success'
                                        : 'ag-banner ag-banner-error'
                                }
                            >
                                <div class="ag-row-wrap">
                                    <span>{testResult.message}</span>
                                    <Badge tone="neutral" className="ag-mono">
                                        {testResult.latencyMs} ms
                                    </Badge>
                                    {testResult.cacheSupport ? (
                                        <Badge tone="primary">{testResult.cacheSupport}</Badge>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </Card>

                {/* Caching, Concurrency & Preset Linking */}
                <Card title="缓存协议、并发与预设联动">
                    <div class="ag-grid-2">
                        <FormField
                            label="前缀缓存协议策略 (cachePolicy)"
                            hint="auto_prefix 保障键序与前缀稳定；anthropic_explicit 注入 cache_control 断点"
                        >
                            <SelectInput<CachePolicy>
                                value={activeConn.cachePolicy}
                                options={[
                                    { value: 'auto_prefix', label: 'auto_prefix (自动前缀缓存: OpenAI/DeepSeek/Gemini)' },
                                    { value: 'anthropic_explicit', label: 'anthropic_explicit (显式 cache_control 断点)' },
                                    { value: 'none', label: 'none (禁用缓存断点标记)' },
                                ]}
                                onChange={(cachePolicy) =>
                                    mutateActiveConn((c) => ({ ...c, cachePolicy }))
                                }
                            />
                        </FormField>

                        <FormField label="最大断点数量 (maxCacheBreakpoints, 0-4)">
                            <TextInput
                                type="number"
                                min={0}
                                max={4}
                                step={1}
                                value={maxBreakpointsDraft.value}
                                onInput={maxBreakpointsDraft.onInput}
                                onChange={maxBreakpointsDraft.onChange}
                            />
                        </FormField>

                        <FormField
                            label="最大并发数 (maxConcurrency)"
                            hint="限制同时进行的后台触发/生成请求并发数 (1-100)"
                        >
                            <TextInput
                                type="number"
                                min={1}
                                max={100}
                                step={1}
                                value={maxConcDraft.value}
                                onInput={maxConcDraft.onInput}
                                onChange={maxConcDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Prompt 后处理模式 (promptPostProcessing)">
                            <SelectInput<NonNullable<ApiConnection['promptPostProcessing']>>
                                value={activeConn.promptPostProcessing ?? 'none'}
                                options={[
                                    { value: 'none', label: 'none (保持原始三层结构)' },
                                    { value: 'merge', label: 'merge (合并相邻同角色消息)' },
                                    { value: 'semi', label: 'semi (半严格交替)' },
                                    { value: 'strict', label: 'strict (严格 user/assistant 交替)' },
                                    { value: 'single', label: 'single (合并为单条消息)' },
                                ]}
                                onChange={(promptPostProcessing) =>
                                    mutateActiveConn((c) => ({ ...c, promptPostProcessing }))
                                }
                            />
                        </FormField>

                        <FormField
                            label="联动预设 (linkedPreset)"
                            hint="可选记录与该模型连接配套使用的推荐预设"
                        >
                            <SelectInput
                                value={activeConn.linkedPreset ?? ''}
                                options={linkedPresetOptions}
                                onChange={(linkedPreset) =>
                                    mutateActiveConn((c) => ({ ...c, linkedPreset }))
                                }
                            />
                        </FormField>
                    </div>
                </Card>

                {/* Sampling Parameters */}
                <Card title="上下文窗口与采样参数">
                    <div class="ag-grid-3">
                        <FormField label="Context Size">
                            <TextInput
                                type="number"
                                min={1}
                                max={10000000}
                                step={1024}
                                value={contextSizeDraft.value}
                                onInput={contextSizeDraft.onInput}
                                onChange={contextSizeDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Max Tokens">
                            <TextInput
                                type="number"
                                min={1}
                                max={1000000}
                                step={256}
                                value={maxTokensDraft.value}
                                onInput={maxTokensDraft.onInput}
                                onChange={maxTokensDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Temperature (0 - 2)">
                            <TextInput
                                type="number"
                                min={0}
                                max={2}
                                step={0.05}
                                value={temperatureDraft.value}
                                onInput={temperatureDraft.onInput}
                                onChange={temperatureDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Top P (0 - 1)">
                            <TextInput
                                type="number"
                                min={0}
                                max={1}
                                step={0.05}
                                value={topPDraft.value}
                                onInput={topPDraft.onInput}
                                onChange={topPDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Top K (0 = 关闭)">
                            <TextInput
                                type="number"
                                min={0}
                                max={1000000}
                                step={1}
                                value={topKDraft.value}
                                onInput={topKDraft.onInput}
                                onChange={topKDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Frequency Penalty (-2 - 2)">
                            <TextInput
                                type="number"
                                min={-2}
                                max={2}
                                step={0.05}
                                value={freqPenaltyDraft.value}
                                onInput={freqPenaltyDraft.onInput}
                                onChange={freqPenaltyDraft.onChange}
                            />
                        </FormField>

                        <FormField label="Presence Penalty (-2 - 2)">
                            <TextInput
                                type="number"
                                min={-2}
                                max={2}
                                step={0.05}
                                value={presPenaltyDraft.value}
                                onInput={presPenaltyDraft.onInput}
                                onChange={presPenaltyDraft.onChange}
                            />
                        </FormField>
                    </div>
                </Card>

                {/* Custom Headers / Body / Exclude YAML Editors */}
                <Card
                    title="自定义请求扩展 (YAML / JSON)"
                    subtitle="支持标准 YAML 或 JSON 对象映射；留空表示不附带"
                >
                    <div class="ag-stack-v">
                        <YamlRecordEditor
                            resetKey={`${activeConn.id}:headers`}
                            label="自定义 Request Headers (includeHeaders)"
                            hint="示例：HTTP-Referer: https://sillytavern.local"
                            placeholder="HTTP-Referer: https://sillytavern.local"
                            record={activeConn.includeHeaders}
                            onCommit={(includeHeaders) =>
                                mutateActiveConn((c) => ({ ...c, includeHeaders }))
                            }
                        />
                        <YamlRecordEditor
                            resetKey={`${activeConn.id}:includeBody`}
                            label="自定义附加 Body 字段 (includeBody)"
                            hint="示例：reasoning_effort: medium"
                            placeholder="reasoning_effort: medium"
                            record={activeConn.includeBody}
                            onCommit={(includeBody) =>
                                mutateActiveConn((c) => ({ ...c, includeBody }))
                            }
                        />
                        <YamlRecordEditor
                            resetKey={`${activeConn.id}:excludeBody`}
                            label="排除默认 Body 字段 (excludeBody)"
                            hint="设为 true 的字段将从请求 Body 中剔除（如 frequency_penalty: true）"
                            placeholder="frequency_penalty: true"
                            record={activeConn.excludeBody}
                            onCommit={(excludeBody) =>
                                mutateActiveConn((c) => ({ ...c, excludeBody }))
                            }
                        />
                    </div>
                </Card>
            </div>
        </div>
    ) : (
        <EmptyState
            icon={<IconPlug size={22} />}
            title="请选择或创建 API 连接"
        />
    );

    return (
        <>
            <MasterDetailLayout
                master={masterPane}
                detail={detailPane}
                detailOpen={detailOpen}
                onDetailOpenChange={setDetailOpen}
                detailTitle={activeConn?.name ?? 'API 连接配置'}
                isMobile={isMobile}
                emptyDetailTitle="请选择左侧 API 连接"
            />

            <ShadowModal
                open={importOpen}
                title="导入 API 连接配置 JSON"
                maxWidth="560px"
                onClose={() => setImportOpen(false)}
                footer={
                    <Button variant="secondary" onClick={() => setImportOpen(false)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleImportFile}
                    />
                    <div class="ag-row-wrap">
                        <Button
                            size="sm"
                            variant="secondary"
                            icon={<IconUpload size={14} />}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            选择 JSON 文件
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!importText.trim()}
                            onClick={() => runImportConnections(importText)}
                        >
                            解析并合并连接
                        </Button>
                    </div>
                    <CodeEditor
                        label="粘贴 st-agentic-connections JSON"
                        languageHint="json"
                        rows={7}
                        minHeight="150px"
                        showToolbar={false}
                        placeholder='{"format":"st-agentic-connections","version":1,"connections":{...}}'
                        value={importText}
                        onChange={setImportText}
                    />
                    {importError ? <div class="ag-banner ag-banner-error">{importError}</div> : null}
                </div>
            </ShadowModal>
        </>
    );
}
