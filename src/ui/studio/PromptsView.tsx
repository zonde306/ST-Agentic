import type { TargetedEvent } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import {
    EXPORT_FORMAT_PRESET,
    EXPORT_FORMAT_PROMPT,
    EXPORT_FORMAT_PROMPTS,
    getPromptTriggerDisplay,
    isPlainRecord,
    normalizePromptBlock,
    resolveActivePreset,
    validatePromptsImport,
} from '@/core/config';
import { validateCustomPromptBlock } from '@/core/context';
import {
    importSillyTavernOpenAIPreset,
    isSillyTavernOpenAIPreset,
} from '@/core/migration';
import type { AgentProfile, PromptBlock, PromptTriggerType } from '@/core/types';
import {
    Badge,
    Button,
    Card,
    CodeEditor,
    EmptyState,
    FormField,
    SelectInput,
    ShadowModal,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconArrowDown,
    IconArrowUp,
    IconCheck,
    IconCopy,
    IconDownload,
    IconPlus,
    IconTrash,
    IconUpload,
} from '@/ui/components/Icons';
import {
    type ConsoleViewProps,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import { PresetManagerPanel } from './PresetManagerPanel';
import { PromptTriggerPicker } from './PromptTriggerPicker';
import {
    allocateUniqueId,
    copyTextToClipboard,
    downloadTextFile,
    getPromptPlacementMeta,
    moveArrayItem,
    PROMPT_PLACEMENT_OPTIONS,
    withUpdatedAgent,
} from './studio-helpers';

function IconGrip({ size = 14 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
        </svg>
    );
}

function IconEditPen({ size = 14 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.9}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
    );
}

const CUSTOM_EJS_INFO_HINT =
    '检测到外层 EJS 控制流，将在上下文组装时求值后解析为 JSON 消息';

const CUSTOM_INIT_TOOL_CONTEXT_TEMPLATE = JSON.stringify(
    [
        {
            role: 'user',
            content: '请先读取当前场景设定与状态。',
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_init_read_1',
                    type: 'function',
                    function: {
                        name: 'read_file',
                        arguments: '{"path":"/state/variables.json"}',
                    },
                },
            ],
        },
        {
            role: 'tool',
            tool_call_id: 'call_init_read_1',
            name: 'read_file',
            content: '{"status":"ready"}',
        },
    ],
    null,
    2,
);

const CUSTOM_ASSISTANT_PREFILL_TEMPLATE = JSON.stringify(
    {
        role: 'assistant',
        content: '好的，我将严格按照设定与工具规范执行。',
        partial: true,
    },
    null,
    2,
);

const PROMPT_ROLE_OPTIONS: ReadonlyArray<{ value: PromptBlock['role']; label: string }> = [
    { value: 'system', label: 'system' },
    { value: 'user', label: 'user' },
    { value: 'assistant', label: 'assistant' },
    { value: 'custom', label: 'custom (自定义 JSON 消息)' },
];

function hasTrailingSystemInPrefix(blocks: readonly PromptBlock[]): boolean {
    let seenNonSystemPrefix = false;
    for (const block of blocks) {
        if (!block.enabled || block.placement !== 'prefix') {
            continue;
        }
        if (block.role === 'system') {
            if (seenNonSystemPrefix) {
                return true;
            }
        } else {
            seenNonSystemPrefix = true;
        }
    }
    return false;
}

export interface ParsedPromptImport {
    blocks: PromptBlock[];
    skippedCount: number;
    note?: string;
}

function extractPresetPromptBlocks(presetObj: Record<string, unknown>): ParsedPromptImport | null {
    if (!isPlainRecord(presetObj.agents)) {
        return null;
    }
    const agents = presetObj.agents;
    const mainId = typeof presetObj.mainAgentId === 'string' ? presetObj.mainAgentId : '';
    const mainCandidate = mainId ? agents[mainId] : undefined;
    const targetAgent: Record<string, unknown> | null = isPlainRecord(mainCandidate)
        ? mainCandidate
        : (Object.values(agents).find(isPlainRecord) ?? null);
    if (!targetAgent || !Array.isArray(targetAgent.promptBlocks)) {
        return null;
    }
    const blocks = targetAgent.promptBlocks
        .filter(isPlainRecord)
        .map((item, idx) =>
            normalizePromptBlock(item, `imported_${idx + 1}`, `提示词 ${idx + 1}`),
        );
    if (blocks.length === 0) {
        return null;
    }
    return {
        blocks,
        skippedCount: 0,
        note: `已从 ST-Agentic 预设提取 ${blocks.length} 条提示词`,
    };
}

export function parseImportedPromptBlocks(raw: unknown): ParsedPromptImport {
    if (Array.isArray(raw)) {
        const blocks = raw
            .filter(isPlainRecord)
            .map((item, idx) =>
                normalizePromptBlock(item, `imported_${idx + 1}`, `提示词 ${idx + 1}`),
            );
        if (blocks.length === 0) {
            throw new Error('数组中未找到有效的提示词对象');
        }
        return { blocks, skippedCount: 0 };
    }

    if (!isPlainRecord(raw)) {
        throw new Error('JSON 根节点必须是提示词数组或对象');
    }

    if (raw.format === EXPORT_FORMAT_PROMPTS || raw.format === EXPORT_FORMAT_PROMPT) {
        const res = validatePromptsImport(raw);
        if (!res.ok) {
            throw new Error(res.error);
        }
        return {
            blocks: res.data.prompts,
            skippedCount: 0,
            note: `已从 ST-Agentic 提示词包提取 ${res.data.prompts.length} 条提示词`,
        };
    }

    if ((raw.format === EXPORT_FORMAT_PRESET || raw.format === undefined) && isPlainRecord(raw.preset)) {
        const extracted = extractPresetPromptBlocks(raw.preset);
        if (extracted) {
            return extracted;
        }
    }

    if (isPlainRecord(raw.agents) && typeof raw.mainAgentId === 'string') {
        const extracted = extractPresetPromptBlocks(raw);
        if (extracted) {
            return extracted;
        }
    }

    if (isSillyTavernOpenAIPreset(raw)) {
        const migrated = importSillyTavernOpenAIPreset(raw);
        const mainAgent =
            migrated.preset.agents[migrated.preset.mainAgentId]
            ?? Object.values(migrated.preset.agents)[0];
        const blocks = mainAgent?.promptBlocks ?? [];
        if (blocks.length === 0) {
            throw new Error('该 ST 预设中未包含可导入的自定义提示词条目');
        }
        const skippedCount = migrated.report.skippedItems.length;
        return {
            blocks,
            skippedCount,
            note:
                skippedCount > 0
                    ? `已从 ST 预设提取 ${blocks.length} 条提示词（自动跳过 ${skippedCount} 条内置槽位或 @D>=1 深度注入以保持缓存安全）`
                    : `已从 ST 预设提取 ${blocks.length} 条提示词`,
        };
    }

    if (Array.isArray(raw.prompts)) {
        return parseImportedPromptBlocks(raw.prompts);
    }

    if (Array.isArray(raw.promptBlocks)) {
        return parseImportedPromptBlocks(raw.promptBlocks);
    }

    if (isPlainRecord(raw.prompt)) {
        return {
            blocks: [normalizePromptBlock(raw.prompt, 'imported_1', '导入提示词')],
            skippedCount: 0,
        };
    }

    if (
        typeof raw.name === 'string'
        || typeof raw.content === 'string'
        || typeof raw.placement === 'string'
    ) {
        return {
            blocks: [normalizePromptBlock(raw, 'imported_1', '导入提示词')],
            skippedCount: 0,
        };
    }

    throw new Error('未能识别的提示词 JSON 格式（支持提示词数组、单个提示词或 ST OpenAI 预设）');
}

/**
 * Independent Preset & Prompt List Editor view (`预设与提示词`):
 * manages prompt blocks strictly inside ST-Agentic's `settings.presets[currentPresetId]`
 * without mutating SillyTavern's native preset.
 */
export function PromptsView({ store: propStore }: ConsoleViewProps) {
    const ctxStore = useAppStoreInstance();
    const store = propStore ?? ctxStore;
    const settings = useAppStore((s) => s.settings);

    const activePreset = useMemo(() => resolveActivePreset(settings), [settings]);
    const agentList = useMemo(
        () => Object.values(activePreset.agents),
        [activePreset.agents],
    );

    const [selectedAgentId, setSelectedAgentId] = useState<string>('');
    const activeAgent: AgentProfile | undefined = useMemo(() => {
        if (selectedAgentId && activePreset.agents[selectedAgentId]) {
            return activePreset.agents[selectedAgentId];
        }
        return (
            activePreset.agents[activePreset.mainAgentId]
            ?? agentList[0]
        );
    }, [activePreset.agents, activePreset.mainAgentId, agentList, selectedAgentId]);

    const promptBlocks = activeAgent?.promptBlocks ?? [];
    const enabledPromptCount = useMemo(
        () => promptBlocks.filter((b) => b.enabled).length,
        [promptBlocks],
    );
    const prefixHasTrailingSystem = useMemo(
        () => hasTrailingSystemInPrefix(promptBlocks),
        [promptBlocks],
    );
    const enabledRegexCount = useMemo(
        () => activePreset.regexRules.filter((r) => r.enabled).length,
        [activePreset.regexRules],
    );

    // Drag & drop state
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    // Edit / Create modal state
    const [editorMode, setEditorMode] = useState<'create' | 'edit' | null>(null);
    const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
    const [draftName, setDraftName] = useState('');
    const [draftRole, setDraftRole] = useState<PromptBlock['role']>('system');
    const [draftPlacement, setDraftPlacement] = useState<PromptBlock['placement']>('prefix');
    const [draftEnabled, setDraftEnabled] = useState(true);
    const [draftTriggers, setDraftTriggers] = useState<PromptTriggerType[]>([]);
    const [draftContent, setDraftContent] = useState('');
    const [editError, setEditError] = useState<string | null>(null);
    const [customSaveErrors, setCustomSaveErrors] = useState<string[]>([]);

    const customValidation = useMemo(
        () => (draftRole === 'custom' ? validateCustomPromptBlock(draftContent) : null),
        [draftContent, draftRole],
    );

    const modalHasTrailingSystem = useMemo(() => {
        if (editorMode === null) {
            return false;
        }
        const draftPreview: PromptBlock = {
            id: editingBlockId ?? '__draft__',
            name: draftName || 'draft',
            role: draftRole,
            placement: draftPlacement,
            content: draftContent,
            enabled: draftEnabled,
        };
        const previewList =
            editorMode === 'create'
                ? [...promptBlocks, draftPreview]
                : promptBlocks.map((b) => (b.id === editingBlockId ? draftPreview : b));
        return hasTrailingSystemInPrefix(previewList);
    }, [
        draftContent,
        draftEnabled,
        draftName,
        draftPlacement,
        draftRole,
        editingBlockId,
        editorMode,
        promptBlocks,
    ]);

    // Import modal state
    const [importOpen, setImportOpen] = useState(false);
    const [importText, setImportText] = useState('');
    const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
    const [importError, setImportError] = useState<string | null>(null);
    const importFileRef = useRef<HTMLInputElement | null>(null);

    // Export modal state
    const [exportOpen, setExportOpen] = useState(false);
    const [exportBlock, setExportBlock] = useState<PromptBlock | null>(null);

    const mutateActiveAgentBlocks = (
        updater: (blocks: PromptBlock[]) => PromptBlock[],
    ): void => {
        if (!activeAgent) {
            return;
        }
        const targetAgentId = activeAgent.id;
        const targetPresetId = activePreset.id;
        void store.updateSettings((prev) => {
            const preset = prev.presets[targetPresetId];
            if (!preset) {
                return prev;
            }
            return {
                ...prev,
                presets: {
                    ...prev.presets,
                    [targetPresetId]: {
                        ...preset,
                        agents: withUpdatedAgent(preset.agents, targetAgentId, (ag) => ({
                            ...ag,
                            promptBlocks: updater(ag.promptBlocks),
                        })),
                    },
                },
            };
        });
    };

    const editingIndex = useMemo(() => {
        if (editorMode !== 'edit' || !editingBlockId) {
            return -1;
        }
        return promptBlocks.findIndex((b) => b.id === editingBlockId);
    }, [editingBlockId, editorMode, promptBlocks]);

    const openCreateModal = () => {
        setEditorMode('create');
        setEditingBlockId(null);
        setDraftName('');
        setDraftRole('system');
        setDraftPlacement('prefix');
        setDraftEnabled(true);
        setDraftTriggers([]);
        setDraftContent('');
        setEditError(null);
        setCustomSaveErrors([]);
    };

    const openEditModal = (block: PromptBlock) => {
        setEditorMode('edit');
        setEditingBlockId(block.id);
        setDraftName(block.name);
        setDraftRole(block.role);
        setDraftPlacement(block.placement);
        setDraftEnabled(block.enabled);
        setDraftTriggers(block.triggers ? [...block.triggers] : []);
        setDraftContent(block.content);
        setEditError(null);
        setCustomSaveErrors([]);
    };

    const handleSavePromptModal = () => {
        const trimmedName = draftName.trim();
        if (!trimmedName) {
            setEditError('请输入提示词名称');
            return;
        }

        if (draftRole === 'custom') {
            const validation = validateCustomPromptBlock(draftContent);
            if (!validation.valid) {
                setCustomSaveErrors(
                    validation.errors.length > 0
                        ? validation.errors
                        : ['自定义 JSON 消息格式无效，请检查语法与字段结构。'],
                );
                return;
            }
            setCustomSaveErrors([]);
        } else if (customSaveErrors.length > 0) {
            setCustomSaveErrors([]);
        }

        const nextTriggers = draftTriggers.length > 0 ? [...draftTriggers] : undefined;

        if (editorMode === 'create') {
            mutateActiveAgentBlocks((blocks) => {
                const nextId = allocateUniqueId(
                    trimmedName,
                    blocks.map((b) => b.id),
                    'prompt',
                );
                const created: PromptBlock = {
                    id: nextId,
                    name: trimmedName,
                    role: draftRole,
                    placement: draftPlacement,
                    content: draftContent,
                    enabled: draftEnabled,
                    ...(nextTriggers ? { triggers: nextTriggers } : {}),
                };
                return [...blocks, created];
            });
            store.pushToast(`已添加提示词：${trimmedName}`, 'success');
            setEditorMode(null);
            return;
        }

        if (editorMode === 'edit' && editingBlockId) {
            mutateActiveAgentBlocks((blocks) =>
                blocks.map((b) => {
                    if (b.id !== editingBlockId) {
                        return b;
                    }
                    const next: PromptBlock = {
                        ...b,
                        name: trimmedName,
                        role: draftRole,
                        placement: draftPlacement,
                        enabled: draftEnabled,
                        content: draftContent,
                    };
                    if (nextTriggers) {
                        next.triggers = nextTriggers;
                    } else {
                        delete next.triggers;
                    }
                    return next;
                }),
            );
            store.pushToast(`已保存提示词：${trimmedName}`, 'success');
            setEditorMode(null);
        }
    };

    const handleDuplicateEditingBlock = () => {
        if (!editingBlockId) {
            return;
        }
        if (draftRole === 'custom') {
            const validation = validateCustomPromptBlock(draftContent);
            if (!validation.valid) {
                setCustomSaveErrors(
                    validation.errors.length > 0
                        ? validation.errors
                        : ['自定义 JSON 消息格式无效，请检查语法与字段结构。'],
                );
                return;
            }
            setCustomSaveErrors([]);
        }
        const trimmedName = draftName.trim() || '提示词';
        const copyName = `${trimmedName} (副本)`;
        const nextTriggers = draftTriggers.length > 0 ? [...draftTriggers] : undefined;
        mutateActiveAgentBlocks((blocks) => {
            const idx = blocks.findIndex((b) => b.id === editingBlockId);
            const nextId = allocateUniqueId(
                `${editingBlockId}_copy`,
                blocks.map((b) => b.id),
                'prompt_copy',
            );
            const copyBlock: PromptBlock = {
                id: nextId,
                name: copyName,
                role: draftRole,
                placement: draftPlacement,
                content: draftContent,
                enabled: draftEnabled,
                ...(nextTriggers ? { triggers: nextTriggers } : {}),
            };
            if (idx < 0) {
                return [...blocks, copyBlock];
            }
            const next = [...blocks];
            next.splice(idx + 1, 0, copyBlock);
            return next;
        });
        store.pushToast(`已复制提示词：${copyName}`, 'success');
        setEditorMode(null);
    };

    const handleDeleteBlock = (block: PromptBlock) => {
        store.openModal({
            kind: 'confirm',
            title: '删除提示词确认',
            message: `确定要删除提示词「${block.name}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutateActiveAgentBlocks((blocks) =>
                    blocks.filter((b) => b.id !== block.id),
                );
                if (editingBlockId === block.id) {
                    setEditorMode(null);
                    setEditingBlockId(null);
                }
                store.pushToast(`已删除提示词：${block.name}`, 'warning');
            },
        });
    };

    const handleDropOnRow = (targetIndex: number) => {
        if (dragIndex !== null && dragIndex !== targetIndex) {
            mutateActiveAgentBlocks((blocks) =>
                moveArrayItem(blocks, dragIndex, targetIndex),
            );
        }
        setDragIndex(null);
        setDragOverIndex(null);
    };

    const handleRunImport = (rawText: string) => {
        setImportError(null);
        try {
            const parsed: unknown = JSON.parse(rawText);
            const result = parseImportedPromptBlocks(parsed);
            mutateActiveAgentBlocks((existing) => {
                const baseList = importMode === 'replace' ? [] : [...existing];
                const usedIds = new Set(baseList.map((b) => b.id));
                const assigned = result.blocks.map((block) => {
                    const uniqueId = allocateUniqueId(block.id, usedIds, 'prompt');
                    usedIds.add(uniqueId);
                    return { ...block, id: uniqueId };
                });
                return [...baseList, ...assigned];
            });
            store.pushToast(
                result.note ?? `已导入 ${result.blocks.length} 条提示词`,
                'success',
            );
            setImportOpen(false);
            setImportText('');
        } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
        }
    };

    const handleImportFileChange = async (event: TargetedEvent<HTMLInputElement, Event>) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (!file) {
            return;
        }
        try {
            const text = await file.text();
            setImportText(text);
            setImportError(null);
        } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
        }
    };

    const exportJsonText = useMemo(() => {
        if (exportBlock) {
            return JSON.stringify(
                {
                    format: EXPORT_FORMAT_PROMPT,
                    version: 1,
                    prompt: exportBlock,
                },
                null,
                2,
            );
        }
        return JSON.stringify(
            {
                format: EXPORT_FORMAT_PROMPTS,
                version: 1,
                presetName: activePreset.name,
                agentId: activeAgent?.id ?? '',
                prompts: promptBlocks,
            },
            null,
            2,
        );
    }, [activeAgent?.id, activePreset.name, exportBlock, promptBlocks]);

    const agentOptions = useMemo(
        () =>
            agentList.map((ag) => ({
                value: ag.id,
                label:
                    ag.id === activePreset.mainAgentId
                        ? `${ag.name}（主叙事）`
                        : ag.name,
            })),
        [activePreset.mainAgentId, agentList],
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
            <PresetManagerPanel
                store={store}
                compact
                onPresetChanged={() => setSelectedAgentId('')}
            />

            <div class="ag-view-scroll ag-thin-scroll" style={{ flex: '1 1 auto', minHeight: 0 }}>
                <div class="ag-stack-v">
                    {/* Independent Preset Summary & Target Agent Bar */}
                    <div
                        class="ag-row-wrap"
                        style={{
                            justifyContent: 'space-between',
                            padding: '10px 12px',
                            borderRadius: '10px',
                            border: '1px solid var(--border)',
                            background: 'var(--content)',
                        }}
                    >
                        <div class="ag-stack-v" style={{ gap: '4px', flex: '1 1 220px' }}>
                            <div class="ag-row-wrap">
                                <Badge tone="primary">独立预设</Badge>
                                <span style={{ fontSize: '12px', color: 'var(--muted-foreground)' }}>
                                    提示词: {promptBlocks.length} (启用: {enabledPromptCount}) · 正则:{' '}
                                    {activePreset.regexRules.length} (启用: {enabledRegexCount}) · 智能体:{' '}
                                    {agentList.length} · 触发器: {activePreset.triggers.length}
                                </span>
                            </div>
                            <div class="ag-field-hint">
                                仅作用于 ST-Agentic 独立预设（不会修改或覆盖 SillyTavern 原生预设）。
                            </div>
                        </div>

                        {agentOptions.length > 0 ? (
                            <div style={{ minWidth: '180px', maxWidth: '100%' }}>
                                <SelectInput
                                    ariaLabel="选择目标智能体"
                                    value={activeAgent?.id ?? ''}
                                    options={agentOptions}
                                    onChange={(id) => setSelectedAgentId(id)}
                                />
                            </div>
                        ) : null}
                    </div>

                    {/* Prompt List Card */}
                    <Card
                        title={`提示词 (${promptBlocks.length})`}
                        subtitle="支持拖拽排序、独立开关与编辑；Prefix 进入 Layer 0 静态前缀缓存，Tail 瞬态沉底（工具链夹在中间且不入历史）"
                        actions={
                            <div class="ag-row-wrap">
                                <Button
                                    size="sm"
                                    variant="primary"
                                    icon={<IconPlus size={14} />}
                                    disabled={!activeAgent}
                                    onClick={openCreateModal}
                                >
                                    添加
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    icon={<IconUpload size={14} />}
                                    disabled={!activeAgent}
                                    onClick={() => {
                                        setImportError(null);
                                        setImportOpen(true);
                                    }}
                                >
                                    导入
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    icon={<IconDownload size={14} />}
                                    disabled={!activeAgent || promptBlocks.length === 0}
                                    onClick={() => {
                                        setExportBlock(null);
                                        setExportOpen(true);
                                    }}
                                >
                                    导出
                                </Button>
                            </div>
                        }
                    >
                        {prefixHasTrailingSystem ? (
                            <div
                                class="ag-banner ag-banner-warning"
                                role="status"
                                style={{ marginBottom: '10px' }}
                            >
                                提示：当前 Prefix 区域存在位于 custom / user / assistant 积木之后的 system 积木。Gemini 与 Claude 仅会将前导连续 system 消息放入顶层系统指令，建议将 system 积木置于 Prefix 最前。
                            </div>
                        ) : null}
                        {promptBlocks.length === 0 ? (
                            <EmptyState
                                title="暂无提示词条目"
                                description="点击上方「添加」新建独立提示词，或点击「导入」从 ST 预设提取提示词条目。"
                                action={
                                    <Button
                                        size="sm"
                                        variant="primary"
                                        icon={<IconPlus size={14} />}
                                        disabled={!activeAgent}
                                        onClick={openCreateModal}
                                    >
                                        新增提示词
                                    </Button>
                                }
                            />
                        ) : (
                            <div class="ag-stack-v" style={{ gap: '8px' }} role="list">
                                {promptBlocks.map((block, index) => {
                                    const isDragOver =
                                        dragOverIndex === index
                                        && dragIndex !== null
                                        && dragIndex !== index;

                                    return (
                                        <div
                                            key={block.id}
                                            role="listitem"
                                            draggable
                                            onDragStart={(e) => {
                                                setDragIndex(index);
                                                setDragOverIndex(index);
                                                if (e.dataTransfer) {
                                                    e.dataTransfer.effectAllowed = 'move';
                                                    e.dataTransfer.setData('text/plain', String(index));
                                                }
                                            }}
                                            onDragOver={(e) => {
                                                e.preventDefault();
                                                if (e.dataTransfer) {
                                                    e.dataTransfer.dropEffect = 'move';
                                                }
                                                if (dragOverIndex !== index) {
                                                    setDragOverIndex(index);
                                                }
                                            }}
                                            onDragLeave={() => {
                                                if (dragOverIndex === index) {
                                                    setDragOverIndex(null);
                                                }
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                handleDropOnRow(index);
                                            }}
                                            onDragEnd={() => {
                                                setDragIndex(null);
                                                setDragOverIndex(null);
                                            }}
                                            style={{
                                                display: 'flex',
                                                flexWrap: 'wrap',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '6px 8px',
                                                padding: '6px 10px',
                                                borderRadius: '10px',
                                                border: isDragOver
                                                    ? '1px solid var(--primary)'
                                                    : '1px solid var(--border)',
                                                borderLeft: block.enabled
                                                    ? '3px solid var(--success)'
                                                    : '3px solid var(--border)',
                                                background: isDragOver
                                                    ? 'color-mix(in srgb, var(--primary) 10%, var(--card))'
                                                    : 'var(--card)',
                                                opacity: block.enabled ? 1 : 0.72,
                                                minWidth: 0,
                                                transition: 'border-color 0.15s, background-color 0.15s',
                                            }}
                                        >
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '4px',
                                                    flex: '1 1 160px',
                                                    minWidth: 0,
                                                }}
                                            >
                                                <span
                                                    title="拖拽调整顺序"
                                                    aria-hidden="true"
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        width: '24px',
                                                        height: '40px',
                                                        color: 'var(--muted-foreground)',
                                                        cursor: 'grab',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    <IconGrip size={15} />
                                                </span>

                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={block.enabled}
                                                    aria-label={`${block.enabled ? '停用' : '启用'} ${block.name}`}
                                                    title={block.enabled ? '点击停用' : '点击启用'}
                                                    onClick={() =>
                                                        mutateActiveAgentBlocks((blocks) =>
                                                            blocks.map((b) =>
                                                                b.id === block.id
                                                                    ? { ...b, enabled: !b.enabled }
                                                                    : b,
                                                            ),
                                                        )
                                                    }
                                                    style={{
                                                        minWidth: '40px',
                                                        minHeight: '40px',
                                                        padding: 0,
                                                        border: 'none',
                                                        background: 'transparent',
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'center',
                                                        cursor: 'pointer',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            width: '20px',
                                                            height: '20px',
                                                            borderRadius: '6px',
                                                            border: block.enabled
                                                                ? '1px solid var(--primary)'
                                                                : '1px solid var(--muted-foreground)',
                                                            background: block.enabled
                                                                ? 'var(--primary)'
                                                                : 'var(--content)',
                                                            color: 'var(--primary-foreground)',
                                                            display: 'inline-flex',
                                                            alignItems: 'center',
                                                            justifyContent: 'center',
                                                        }}
                                                    >
                                                        {block.enabled ? <IconCheck size={13} /> : null}
                                                    </span>
                                                </button>

                                                <div
                                                    style={{
                                                        display: 'flex',
                                                        flexWrap: 'wrap',
                                                        alignItems: 'center',
                                                        gap: '6px',
                                                        minWidth: 0,
                                                        flex: '1 1 auto',
                                                    }}
                                                >
                                                    <span
                                                        style={{
                                                            fontSize: '13px',
                                                            fontWeight: 600,
                                                            color: 'var(--foreground)',
                                                            wordBreak: 'break-word',
                                                        }}
                                                    >
                                                        {block.name}
                                                    </span>
                                                    {(() => {
                                                        const placementMeta = getPromptPlacementMeta(
                                                            block.placement,
                                                        );
                                                        return (
                                                            <Badge tone={placementMeta.tone}>
                                                                {placementMeta.label}
                                                            </Badge>
                                                        );
                                                    })()}
                                                    <Badge
                                                        tone={block.role === 'custom' ? 'primary' : 'neutral'}
                                                        className="ag-mono"
                                                    >
                                                        {block.role}
                                                    </Badge>
                                                    {block.triggers && block.triggers.length > 0 ? (
                                                        <>
                                                            {block.triggers.slice(0, 3).map((tag) => {
                                                                const disp = getPromptTriggerDisplay(
                                                                    tag,
                                                                    activePreset.triggers,
                                                                );
                                                                return (
                                                                    <Badge
                                                                        key={tag}
                                                                        tone={disp.tone}
                                                                        title={disp.label}
                                                                    >
                                                                        {disp.shortLabel}
                                                                    </Badge>
                                                                );
                                                            })}
                                                            {block.triggers.length > 3 ? (
                                                                <Badge
                                                                    tone="neutral"
                                                                    title={block.triggers
                                                                        .map(
                                                                            (tag) =>
                                                                                getPromptTriggerDisplay(
                                                                                    tag,
                                                                                    activePreset.triggers,
                                                                                ).label,
                                                                        )
                                                                        .join('、')}
                                                                >
                                                                    +{block.triggers.length - 3}
                                                                </Badge>
                                                            ) : null}
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>

                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: '4px',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    ariaLabel={`编辑提示词 ${block.name}`}
                                                    title="编辑提示词"
                                                    icon={<IconEditPen size={15} />}
                                                    onClick={() => openEditModal(block)}
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="ghost"
                                                    ariaLabel={`导出提示词 ${block.name}`}
                                                    title="导出单条提示词"
                                                    icon={<IconDownload size={15} />}
                                                    onClick={() => {
                                                        setExportBlock(block);
                                                        setExportOpen(true);
                                                    }}
                                                />
                                                <Button
                                                    size="sm"
                                                    variant="danger"
                                                    ariaLabel={`删除提示词 ${block.name}`}
                                                    title="删除提示词"
                                                    icon={<IconTrash size={15} />}
                                                    onClick={() => handleDeleteBlock(block)}
                                                />
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </Card>
                </div>
            </div>

            {/* Edit / Create Prompt ShadowModal */}
            <ShadowModal
                open={editorMode !== null}
                title={editorMode === 'create' ? '新增提示词条目' : `编辑提示词：${draftName || '未命名'}`}
                maxWidth="720px"
                onClose={() => setEditorMode(null)}
                footer={
                    <div
                        class="ag-row-wrap"
                        style={{ width: '100%', justifyContent: 'space-between' }}
                    >
                        <div class="ag-row-wrap">
                            {editorMode === 'edit' && editingBlockId ? (
                                <>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        ariaLabel="上移提示词"
                                        title="上移"
                                        disabled={editingIndex <= 0}
                                        icon={<IconArrowUp size={14} />}
                                        onClick={() =>
                                            mutateActiveAgentBlocks((blocks) =>
                                                moveArrayItem(blocks, editingIndex, editingIndex - 1),
                                            )
                                        }
                                    >
                                        上移
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        ariaLabel="下移提示词"
                                        title="下移"
                                        disabled={
                                            editingIndex < 0 || editingIndex >= promptBlocks.length - 1
                                        }
                                        icon={<IconArrowDown size={14} />}
                                        onClick={() =>
                                            mutateActiveAgentBlocks((blocks) =>
                                                moveArrayItem(blocks, editingIndex, editingIndex + 1),
                                            )
                                        }
                                    >
                                        下移
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        icon={<IconCopy size={14} />}
                                        onClick={handleDuplicateEditingBlock}
                                    >
                                        复制条目
                                    </Button>
                                </>
                            ) : null}
                        </div>
                        <div class="ag-row-wrap">
                            <Button variant="secondary" onClick={() => setEditorMode(null)}>
                                取消
                            </Button>
                            <Button
                                variant="primary"
                                icon={<IconCheck size={14} />}
                                onClick={handleSavePromptModal}
                            >
                                {editorMode === 'create' ? '添加' : '保存'}
                            </Button>
                        </div>
                    </div>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-grid-2">
                        <FormField label="提示词名称" required error={editError ?? undefined}>
                            <TextInput
                                value={draftName}
                                placeholder="例如：身份定义 / 破甲指令"
                                onInput={(val) => {
                                    setDraftName(val);
                                    if (editError) {
                                        setEditError(null);
                                    }
                                }}
                            />
                        </FormField>

                        <FormField label="启用状态">
                            <ToggleSwitch
                                checked={draftEnabled}
                                onChange={setDraftEnabled}
                                label={draftEnabled ? '已启用' : '已停用'}
                                description="停用后保留内容，不参与上下文组装"
                            />
                        </FormField>

                        <FormField label="注入位置 (缓存安全)">
                            <SelectInput<PromptBlock['placement']>
                                ariaLabel="提示词注入位置"
                                value={draftPlacement}
                                options={PROMPT_PLACEMENT_OPTIONS}
                                onChange={setDraftPlacement}
                            />
                        </FormField>

                        <FormField label="消息角色 (Role)">
                            <SelectInput<PromptBlock['role']>
                                ariaLabel="提示词消息角色"
                                value={draftRole}
                                options={PROMPT_ROLE_OPTIONS}
                                onChange={(role) => {
                                    setDraftRole(role);
                                    setCustomSaveErrors([]);
                                }}
                            />
                        </FormField>
                    </div>

                    <FormField
                        label="触发器 (生效模式筛选)"
                        hint="留空表示仅当前智能体默认生效；选择后仅在匹配生成模式或触发器时参与上下文组装"
                    >
                        <PromptTriggerPicker
                            value={draftTriggers}
                            onChange={setDraftTriggers}
                            placement={draftPlacement}
                            isMainAgent={activeAgent?.id === activePreset.mainAgentId}
                            presetTriggers={activePreset.triggers}
                        />
                    </FormField>

                    {draftRole === 'custom' ? (
                        <div class="ag-row-wrap" role="toolbar" aria-label="自定义 JSON 快捷模板">
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                    setDraftContent(CUSTOM_INIT_TOOL_CONTEXT_TEMPLATE);
                                    setCustomSaveErrors([]);
                                }}
                            >
                                插入初始工具上下文模板
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                    setDraftContent(CUSTOM_ASSISTANT_PREFILL_TEMPLATE);
                                    setCustomSaveErrors([]);
                                }}
                            >
                                插入 Assistant Prefill 模板
                            </Button>
                        </div>
                    ) : null}

                    <CodeEditor
                        label={`提示词正文 (${draftContent.length} 字符)`}
                        languageHint={draftRole === 'custom' ? 'json' : 'markdown'}
                        rows={10}
                        minHeight="220px"
                        value={draftContent}
                        placeholder={
                            draftRole === 'custom'
                                ? '输入合法 JSON 消息对象 {...}、消息数组 [{...}] 或外层 EJS 控制流模板...'
                                : '输入提示词内容，支持 {{user}}、{{char}}、{{file::/path}} 等宏...'
                        }
                        onChange={(next) => {
                            setDraftContent(next);
                            if (customSaveErrors.length > 0) {
                                setCustomSaveErrors([]);
                            }
                        }}
                    />

                    <div class="ag-field-hint">
                        可用自动注入定位宏（引用后将取消对应的默认 System Instruction / Layer 2 尾部自动注入，改为在此处精确展开；Prefix 请放置静态宏，动态宏请放置于 Tail）：
                        {' '}
                        <code>{'{{systemBase}}'}</code>、<code>{'{{assistantSystemPrompt}}'}</code>、<code>{'{{coreManifest}}'}</code>、<code>{'{{systemRules}}'}</code>、
                        <code>{'{{turnBrief}}'}</code>、<code>{'{{sideBrief}}'}</code>、
                        <code>{'{{workspaceNotice}}'}</code>、<code>{'{{dynamicReminders}}'}</code>、
                        <code>{'{{loreHint}}'}</code>、<code>{'{{sideHint}}'}</code>
                        （均支持下划线/短横线别名，如 <code>{'{{system-base}}'}</code> / <code>{'{{core-manifest}}'}</code>）。
                    </div>

                    {draftRole === 'custom' && customSaveErrors.length > 0 ? (
                        <div class="ag-banner ag-banner-error" role="alert">
                            {customSaveErrors.join('；')}
                        </div>
                    ) : null}

                    {draftRole === 'custom' && customValidation?.mode === 'ejs_template' ? (
                        <div class="ag-banner ag-banner-primary" role="status">
                            {CUSTOM_EJS_INFO_HINT}
                        </div>
                    ) : null}

                    {draftRole === 'custom' && customValidation && customValidation.valid ? (() => {
                        const filteredWarnings = customValidation.warnings.filter(
                            (w) =>
                                customValidation.mode !== 'ejs_template'
                                || !w.includes('检测到外层 EJS 控制流'),
                        );
                        if (filteredWarnings.length === 0) {
                            return null;
                        }
                        if (customValidation.mode === 'empty') {
                            return (
                                <div class="ag-field-hint" role="status">
                                    {filteredWarnings.join(' ')}
                                </div>
                            );
                        }
                        return (
                            <div class="ag-banner ag-banner-warning" role="status">
                                {filteredWarnings.join('；')}
                            </div>
                        );
                    })() : null}

                    {modalHasTrailingSystem ? (
                        <div class="ag-banner ag-banner-warning" role="status">
                            提示：当前 Prefix 区域存在位于 custom / user / assistant 积木之后的 system 积木。Gemini 与 Claude 仅会将前导连续 system 消息放入顶层系统指令，建议将 system 积木置于 Prefix 最前。
                        </div>
                    ) : null}
                </div>
            </ShadowModal>

            {/* Import Prompts ShadowModal */}
            <ShadowModal
                open={importOpen}
                title="导入提示词到独立预设"
                maxWidth="640px"
                onClose={() => setImportOpen(false)}
                footer={
                    <Button variant="secondary" onClick={() => setImportOpen(false)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-primary">
                        支持导入单条提示词 JSON、提示词数组，或传统 SillyTavern OpenAI 预设 JSON（仅提取到当前 ST-Agentic 独立预设的「{activeAgent?.name ?? ''}」，不会影响酒馆原生预设）。
                    </div>

                    <input
                        ref={importFileRef}
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleImportFileChange}
                    />

                    <FormField label="导入方式">
                        <SelectInput<'append' | 'replace'>
                            ariaLabel="提示词导入方式"
                            value={importMode}
                            options={[
                                { value: 'append', label: '追加到当前提示词列表末尾' },
                                { value: 'replace', label: '替换当前智能体的全部提示词' },
                            ]}
                            onChange={setImportMode}
                        />
                    </FormField>

                    <div class="ag-row-wrap">
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconUpload size={14} />}
                            onClick={() => importFileRef.current?.click()}
                        >
                            选择 JSON 文件
                        </Button>
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={!importText.trim()}
                            icon={<IconCheck size={14} />}
                            onClick={() => handleRunImport(importText)}
                        >
                            解析并导入
                        </Button>
                    </div>

                    <CodeEditor
                        label="粘贴提示词或 ST 预设 JSON"
                        languageHint="json"
                        rows={8}
                        minHeight="160px"
                        showToolbar={false}
                        placeholder='[{"name": "Main Prompt", "role": "system", "placement": "prefix", "content": "..."}]'
                        value={importText}
                        onChange={setImportText}
                    />

                    {importError ? <div class="ag-banner ag-banner-error">{importError}</div> : null}
                </div>
            </ShadowModal>

            {/* Export Prompts ShadowModal */}
            <ShadowModal
                open={exportOpen}
                title={exportBlock ? `导出提示词：${exportBlock.name}` : `导出提示词列表 (${promptBlocks.length})`}
                maxWidth="620px"
                onClose={() => setExportOpen(false)}
                footer={
                    <Button variant="secondary" onClick={() => setExportOpen(false)}>
                        关闭
                    </Button>
                }
            >
                <div class="ag-stack-v">
                    <div class="ag-row-wrap">
                        <Button
                            variant="primary"
                            size="sm"
                            icon={<IconDownload size={14} />}
                            onClick={() => {
                                const slug = exportBlock
                                    ? exportBlock.name
                                    : `${activePreset.name}_${activeAgent?.id ?? 'prompts'}`;
                                const safeSlug =
                                    slug.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '_') || 'prompts';
                                downloadTextFile(`agentic-prompts-${safeSlug}.json`, exportJsonText);
                                store.pushToast('已下载提示词 JSON 文件', 'success');
                            }}
                        >
                            下载 JSON 文件
                        </Button>
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconCopy size={14} />}
                            onClick={() =>
                                void copyTextToClipboard(exportJsonText).then((ok) => {
                                    store.pushToast(
                                        ok ? '已复制提示词 JSON 到剪贴板' : '剪贴板不可用，请手动复制',
                                        ok ? 'success' : 'warning',
                                    );
                                })
                            }
                        >
                            复制 JSON
                        </Button>
                    </div>

                    <CodeEditor
                        label="JSON 预览"
                        languageHint="json"
                        readOnly
                        rows={10}
                        minHeight="200px"
                        showToolbar={false}
                        value={exportJsonText}
                        onChange={() => {}}
                    />
                </div>
            </ShadowModal>
        </div>
    );
}
