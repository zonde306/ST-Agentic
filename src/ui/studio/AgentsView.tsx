import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    createDefaultMainAgent,
    DEFAULT_WATERMARK,
    resolveActivePreset,
} from '@/core/config';
import { validateCustomPromptBlock } from '@/core/context';
import { BUILTIN_TOOL_NAMES } from '@/core/tools';
import type {
    AgentProfile,
    PromptBlock,
    SessionMode,
    StrictToolLoopOverride,
    TriggerRule,
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
    TextInput,
    ToggleSwitch,
    useIsMobileViewport,
} from '@/ui/components';
import {
    IconArrowDown,
    IconArrowUp,
    IconBot,
    IconCopy,
    IconPlus,
    IconTrash,
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
    moveArrayItem,
    useDraftNumber,
    useDraftString,
    withUpdatedAgent,
} from './studio-helpers';

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

const STRICT_TOOL_LOOP_OPTIONS: ReadonlyArray<{ value: StrictToolLoopOverride; label: string }> = [
    { value: 'inherit', label: '跟随连接 (inherit)' },
    { value: 'on', label: '强制开启 (on)' },
    { value: 'off', label: '强制关闭 (off)' },
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

const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
    list_dir: '列出 VFS 目录结构',
    glob_files: '按 Glob 模式匹配 VFS 文件路径',
    grep_search: '逐行正则/子串搜索文件内容',
    search_files: 'BM25 / 模糊语义检索设定与档案',
    read_file: '读取 VFS 文件（触发宏/EJS 读取时求值）',
    write_file: '写入或覆盖可写 VFS 文件（绑定因果分支）',
    edit_file: '精确锚点局部替换可写 VFS 文件',
    read_variables: '读取 /state/variables.json 与变量 Schema',
    patch_variables: '增量合并/Patch 变量并执行 Schema 校验',
    search_history: '检索 /history/* 冷归档对话块',
    read_history: '读取 /history/* 归档块或摘要正文',
    append_reply_view: '向消息展示层追加卡片（不破前缀缓存）',
    replace_reply_view: '替换消息展示层文本（不改底层轨迹）',
    attach_media: '挂载图片/音频/视频附件到锚定楼层',
};

interface PromptBlockCardProps {
    agentId: string;
    isMainAgent: boolean;
    presetTriggers: readonly TriggerRule[];
    block: PromptBlock;
    index: number;
    total: number;
    onUpdate: (patch: Partial<PromptBlock>) => void;
    onMove: (toIndex: number) => void;
    onDelete: () => void;
}

function PromptBlockCard({
    agentId,
    isMainAgent,
    presetTriggers,
    block,
    index,
    total,
    onUpdate,
    onMove,
    onDelete,
}: PromptBlockCardProps) {
    const resetKey = `${agentId}:${block.id}`;
    const nameDraft = useDraftString(
        resetKey,
        block.name,
        (next) => onUpdate({ name: next }),
        { allowEmpty: false },
    );
    const [contentText, setContentText] = useState(block.content);
    const prevContentKeyRef = useRef(resetKey);
    const lastCommittedContentRef = useRef(block.content);

    useEffect(() => {
        if (prevContentKeyRef.current !== resetKey) {
            prevContentKeyRef.current = resetKey;
            lastCommittedContentRef.current = block.content;
            setContentText(block.content);
            return;
        }
        if (block.content !== lastCommittedContentRef.current) {
            lastCommittedContentRef.current = block.content;
            setContentText(block.content);
        }
    }, [block.content, resetKey]);

    const customValidation = useMemo(
        () => (block.role === 'custom' ? validateCustomPromptBlock(contentText) : null),
        [block.role, contentText],
    );

    const handleContentChange = (next: string) => {
        setContentText(next);
        if (block.role === 'custom') {
            const validation = validateCustomPromptBlock(next);
            if (!validation.valid) {
                return;
            }
        }
        lastCommittedContentRef.current = next;
        onUpdate({ content: next });
    };

    const orderDraft = useDraftNumber(
        `${resetKey}:order:${index}`,
        index + 1,
        (targetOneBased) => {
            const clampedIdx = Math.max(0, Math.min(total - 1, targetOneBased - 1));
            if (clampedIdx !== index) {
                onMove(clampedIdx);
            }
        },
        { min: 1, max: Math.max(1, total), integer: true },
    );

    return (
        <div
            style={{
                border: '1px solid var(--border)',
                borderRadius: '10px',
                background: 'var(--card)',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                opacity: block.enabled ? 1 : 0.68,
                minWidth: 0,
            }}
        >
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <div class="ag-row-wrap" style={{ flex: '1 1 200px', minWidth: 0 }}>
                    <Badge tone={block.placement === 'prefix' ? 'primary' : 'warning'}>
                        #{index + 1} · {block.placement === 'prefix' ? 'Prefix' : 'Tail'}
                    </Badge>
                    <Badge
                        tone={block.role === 'custom' ? 'primary' : 'neutral'}
                        className="ag-mono"
                    >
                        {block.role}
                    </Badge>
                    <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                        <TextInput
                            ariaLabel={`积木 ${index + 1} 名称`}
                            value={nameDraft.value}
                            onInput={nameDraft.onInput}
                            onChange={nameDraft.onChange}
                        />
                    </div>
                </div>

                <div class="ag-row-wrap">
                    <ToggleSwitch
                        checked={block.enabled}
                        onChange={(checked) => onUpdate({ enabled: checked })}
                        label={block.enabled ? '启用' : '停用'}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        ariaLabel="上移积木"
                        title="上移"
                        disabled={index === 0}
                        icon={<IconArrowUp size={14} />}
                        onClick={() => onMove(index - 1)}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        ariaLabel="下移积木"
                        title="下移"
                        disabled={index >= total - 1}
                        icon={<IconArrowDown size={14} />}
                        onClick={() => onMove(index + 1)}
                    />
                    <div style={{ width: '74px' }}>
                        <TextInput
                            type="number"
                            min={1}
                            max={Math.max(1, total)}
                            step={1}
                            ariaLabel={`积木 ${block.name} 序号`}
                            value={orderDraft.value}
                            onInput={orderDraft.onInput}
                            onChange={orderDraft.onChange}
                        />
                    </div>
                    <Button
                        size="sm"
                        variant="danger"
                        ariaLabel="删除积木"
                        title="删除积木"
                        icon={<IconTrash size={14} />}
                        onClick={onDelete}
                    />
                </div>
            </div>

            <div class="ag-grid-2">
                <FormField label="注入位置 (缓存安全)">
                    <SelectInput
                        ariaLabel="积木位置"
                        value={block.placement}
                        options={[
                            { value: 'prefix', label: 'Layer 0 Prefix (静态前缀缓存)' },
                            { value: 'tail', label: 'Layer 2 Tail (当轮尾部追加)' },
                        ]}
                        onChange={(placement) => onUpdate({ placement })}
                    />
                </FormField>

                <FormField label="消息角色 (Role)">
                    <SelectInput<PromptBlock['role']>
                        ariaLabel="积木角色"
                        value={block.role}
                        options={PROMPT_ROLE_OPTIONS}
                        onChange={(role) => {
                            if (role !== 'custom' && contentText !== lastCommittedContentRef.current) {
                                lastCommittedContentRef.current = contentText;
                                onUpdate({ role, content: contentText });
                            } else {
                                onUpdate({ role });
                            }
                        }}
                    />
                </FormField>
            </div>

            <FormField label="触发器 (生效模式筛选)">
                <PromptTriggerPicker
                    value={block.triggers ?? []}
                    onChange={(triggers) =>
                        onUpdate({ triggers: triggers.length > 0 ? triggers : undefined })
                    }
                    placement={block.placement}
                    isMainAgent={isMainAgent}
                    presetTriggers={presetTriggers}
                />
            </FormField>

            {block.role === 'custom' ? (
                <div class="ag-row-wrap" role="toolbar" aria-label="自定义 JSON 快捷模板">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleContentChange(CUSTOM_INIT_TOOL_CONTEXT_TEMPLATE)}
                    >
                        插入初始工具上下文模板
                    </Button>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => handleContentChange(CUSTOM_ASSISTANT_PREFILL_TEMPLATE)}
                    >
                        插入 Assistant Prefill 模板
                    </Button>
                </div>
            ) : null}

            <CodeEditor
                label="积木指令正文"
                languageHint={block.role === 'custom' ? 'json' : 'markdown'}
                rows={4}
                minHeight="110px"
                placeholder={
                    block.role === 'custom'
                        ? '输入合法 JSON 消息对象 {...}、消息数组 [{...}] 或外层 EJS 控制流模板...'
                        : undefined
                }
                value={contentText}
                onChange={handleContentChange}
            />

            {block.role === 'custom' && customValidation && !customValidation.valid ? (
                <div class="ag-banner ag-banner-error" role="alert">
                    {customValidation.errors.join('；')}
                </div>
            ) : null}

            {block.role === 'custom' && customValidation?.mode === 'ejs_template' ? (
                <div class="ag-banner ag-banner-primary" role="status">
                    {CUSTOM_EJS_INFO_HINT}
                </div>
            ) : null}

            {block.role === 'custom' && customValidation && customValidation.valid ? (() => {
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
        </div>
    );
}

interface GlobPatternListEditorProps {
    label: string;
    hint: string;
    patterns: readonly string[];
    presets: readonly string[];
    onChange: (next: string[]) => void;
}

function GlobPatternListEditor({
    label,
    hint,
    patterns,
    presets,
    onChange,
}: GlobPatternListEditorProps) {
    const [newPattern, setNewPattern] = useState('');

    const addPattern = (raw: string) => {
        const trimmed = raw.trim();
        if (!trimmed) {
            return;
        }
        if (patterns.includes(trimmed)) {
            return;
        }
        onChange([...patterns, trimmed]);
    };

    return (
        <div
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
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <div>
                    <div style={{ fontSize: '13px', fontWeight: 600 }}>{label}</div>
                    <div class="ag-field-hint">{hint}</div>
                </div>
                <Badge tone="neutral">{patterns.length} 条</Badge>
            </div>

            {patterns.length === 0 ? (
                <div class="ag-field-hint">当前列表为空（禁止任何对应路径访问）。</div>
            ) : (
                <div class="ag-stack-v">
                    {patterns.map((pattern, idx) => (
                        <div key={idx} class="ag-row">
                            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                                <TextInput
                                    ariaLabel={`${label} 规则 ${idx + 1}`}
                                    className="ag-mono"
                                    value={pattern}
                                    onInput={(val) => {
                                        const next = [...patterns];
                                        next[idx] = val;
                                        onChange(next);
                                    }}
                                    onChange={(val) => {
                                        const trimmed = val.trim();
                                        if (!trimmed) {
                                            onChange(patterns.filter((_, i) => i !== idx));
                                        } else {
                                            const next = [...patterns];
                                            next[idx] = trimmed;
                                            onChange(next);
                                        }
                                    }}
                                />
                            </div>
                            <Button
                                size="sm"
                                variant="danger"
                                ariaLabel={`删除规则 ${pattern}`}
                                icon={<IconTrash size={14} />}
                                onClick={() => onChange(patterns.filter((_, i) => i !== idx))}
                            />
                        </div>
                    ))}
                </div>
            )}

            <div class="ag-row">
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <TextInput
                        ariaLabel={`新增${label}`}
                        className="ag-mono"
                        value={newPattern}
                        placeholder="例如 /lorebooks/**"
                        onInput={setNewPattern}
                    />
                </div>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconPlus size={14} />}
                    disabled={!newPattern.trim()}
                    onClick={() => {
                        addPattern(newPattern);
                        setNewPattern('');
                    }}
                >
                    添加
                </Button>
            </div>

            <div class="ag-row-wrap">
                {presets.map((preset) => (
                    <Button
                        key={preset}
                        size="sm"
                        variant="ghost"
                        disabled={patterns.includes(preset)}
                        onClick={() => addPattern(preset)}
                    >
                        + {preset}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/**
 * View ④: Agents Configuration (`tabId: 'agents'`).
 * Manages `preset.agents`, connection binding, session mode, modular `promptBlocks`,
 * tool permissions checklist, VFS read/write Glob rules, and watermark thresholds.
 */
export function AgentsView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const activePreset = resolveActivePreset(settings);
    const agentList = useMemo(
        () => Object.values(activePreset.agents),
        [activePreset.agents],
    );

    const [selectedAgentId, setSelectedAgentId] = useState<string>(activePreset.mainAgentId);
    const [detailOpen, setDetailOpen] = useState(false);
    const [extraToolName, setExtraToolName] = useState('');

    useEffect(() => {
        if (!activePreset.agents[selectedAgentId]) {
            setSelectedAgentId(activePreset.mainAgentId || agentList[0]?.id || '');
        }
    }, [activePreset.agents, activePreset.mainAgentId, agentList, selectedAgentId]);

    const activeAgent: AgentProfile | undefined =
        activePreset.agents[selectedAgentId] ?? activePreset.agents[activePreset.mainAgentId] ?? agentList[0];

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

    const mutateActiveAgent = (updater: (agent: AgentProfile) => AgentProfile) => {
        if (!activeAgent) {
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            agents: withUpdatedAgent(preset.agents, activeAgent.id, updater),
        }));
    };

    const agentResetKey = `${activePreset.id}:${activeAgent?.id ?? ''}`;
    const nameDraft = useDraftString(
        agentResetKey,
        activeAgent?.name ?? '',
        (next) => mutateActiveAgent((ag) => ({ ...ag, name: next })),
        { allowEmpty: false },
    );
    const descDraft = useDraftString(
        agentResetKey,
        activeAgent?.description ?? '',
        (next) => mutateActiveAgent((ag) => ({ ...ag, description: next })),
        { allowEmpty: true },
    );
    const maxRoundsDraft = useDraftNumber(
        agentResetKey,
        activeAgent?.maxToolRounds ?? 8,
        (next) => mutateActiveAgent((ag) => ({ ...ag, maxToolRounds: next })),
        { min: 1, max: 100, integer: true },
    );
    const ephWindowDraft = useDraftNumber(
        agentResetKey,
        activeAgent?.ephemeralWindowSize ?? 6,
        (next) => mutateActiveAgent((ag) => ({ ...ag, ephemeralWindowSize: next })),
        { min: 1, max: 500, integer: true },
    );
    const highWmDraft = useDraftNumber(
        agentResetKey,
        activeAgent?.watermark?.high ?? DEFAULT_WATERMARK.high,
        (high) =>
            mutateActiveAgent((ag) => {
                const prevLow = ag.watermark?.low ?? DEFAULT_WATERMARK.low;
                return {
                    ...ag,
                    watermark: {
                        high,
                        low: Math.min(high, prevLow),
                    },
                };
            }),
        { min: 1000, max: 2_000_000, integer: true },
    );
    const lowWmDraft = useDraftNumber(
        agentResetKey,
        activeAgent?.watermark?.low ?? DEFAULT_WATERMARK.low,
        (low) =>
            mutateActiveAgent((ag) => {
                const high = ag.watermark?.high ?? DEFAULT_WATERMARK.high;
                return {
                    ...ag,
                    watermark: {
                        high,
                        low: Math.min(high, low),
                    },
                };
            }),
        { min: 500, max: activeAgent?.watermark?.high ?? DEFAULT_WATERMARK.high, integer: true },
    );

    const connectionOptions = useMemo(
        () => [
            { value: 'inherit', label: '跟随当前主连接 (inherit)' },
            ...Object.values(settings.connections).map((conn) => ({
                value: conn.id,
                label: `${conn.name} (${conn.model || '未填模型'})`,
            })),
        ],
        [settings.connections],
    );

    const allKnownTools = useMemo(() => {
        const customNames = activePreset.customTools.map((t) => ({
            name: t.name,
            desc: t.description || (t.kind === 'slash_bridge' ? '斜杠命令工具' : '自定义 JS 工具'),
            badge: t.kind === 'slash_bridge' ? '斜杠' : 'JS工具',
        }));
        const builtinList = BUILTIN_TOOL_NAMES.map((name) => ({
            name,
            desc: BUILTIN_TOOL_DESCRIPTIONS[name] ?? '内置工具',
            badge: '内置',
        }));
        const knownSet = new Set<string>([
            ...builtinList.map((t) => t.name),
            ...customNames.map((t) => t.name),
        ]);
        const extraList = (activeAgent?.enabledTools ?? [])
            .filter((name) => !knownSet.has(name))
            .map((name) => ({
                name,
                desc: '外部 / 世界书 @@tool 或 @@agent 工具',
                badge: '扩展',
            }));

        return [...builtinList, ...customNames, ...extraList];
    }, [activeAgent?.enabledTools, activePreset.customTools]);

    const handleCreateAgent = () => {
        const id = allocateUniqueId('agent', Object.keys(activePreset.agents), 'agent');
        const created = createDefaultMainAgent({
            id,
            name: `伴生智能体 ${agentList.length + 1}`,
            connectionId: 'inherit',
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 6,
            promptBlocks: [
                {
                    id: allocateUniqueId('block', [], 'block'),
                    name: '智能体职责指令',
                    role: 'system',
                    placement: 'prefix',
                    content: '请结合挂载的 /lorebooks/ 与 /state/variables.json 完成指派任务。',
                    enabled: true,
                },
            ],
            enabledTools: ['read_file', 'search_files', 'read_variables'],
            permissions: { read: ['/**'], write: [] },
        });
        mutatePreset((preset) => ({
            ...preset,
            agents: {
                ...preset.agents,
                [created.id]: created,
            },
        }));
        setSelectedAgentId(created.id);
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已创建智能体：${created.name}`, 'success');
    };

    const handleDuplicateAgent = () => {
        if (!activeAgent) {
            return;
        }
        const id = allocateUniqueId(
            `${activeAgent.id}_copy`,
            Object.keys(activePreset.agents),
            'agent_copy',
        );
        const clone: AgentProfile = {
            ...activeAgent,
            id,
            name: `${activeAgent.name} (副本)`,
            promptBlocks: activeAgent.promptBlocks.map((b) => ({
                ...b,
                ...(b.triggers ? { triggers: [...b.triggers] } : {}),
            })),
            enabledTools: [...activeAgent.enabledTools],
            permissions: {
                read: [...activeAgent.permissions.read],
                write: [...activeAgent.permissions.write],
            },
            ...(activeAgent.watermark ? { watermark: { ...activeAgent.watermark } } : {}),
        };
        mutatePreset((preset) => ({
            ...preset,
            agents: {
                ...preset.agents,
                [clone.id]: clone,
            },
        }));
        setSelectedAgentId(clone.id);
        store.pushToast(`已复制智能体：${clone.name}`, 'success');
    };

    const handleDeleteAgent = () => {
        if (!activeAgent) {
            return;
        }
        if (activeAgent.id === activePreset.mainAgentId) {
            store.pushToast('主叙事智能体不可直接删除，请先将其他智能体设为主智能体', 'warning');
            return;
        }
        store.openModal({
            kind: 'confirm',
            title: '删除智能体确认',
            message: `确定从预设「${activePreset.name}」中删除智能体「${activeAgent.name}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => {
                    const nextAgents = { ...preset.agents };
                    delete nextAgents[activeAgent.id];
                    return {
                        ...preset,
                        agents: nextAgents,
                    };
                });
                setSelectedAgentId(activePreset.mainAgentId);
                setDetailOpen(false);
                store.pushToast(`已删除智能体：${activeAgent.name}`, 'warning');
            },
        });
    };

    const handleToggleTool = (toolName: string) => {
        if (!activeAgent) {
            return;
        }
        const hasTool = activeAgent.enabledTools.includes(toolName);
        const nextTools = hasTool
            ? activeAgent.enabledTools.filter((t) => t !== toolName)
            : [...activeAgent.enabledTools, toolName];
        mutateActiveAgent((ag) => ({ ...ag, enabledTools: nextTools }));
    };

    const handleAddBlock = () => {
        if (!activeAgent) {
            return;
        }
        const id = allocateUniqueId(
            'block',
            activeAgent.promptBlocks.map((b) => b.id),
            'block',
        );
        const newBlock: PromptBlock = {
            id,
            name: `新指令积木 ${activeAgent.promptBlocks.length + 1}`,
            role: 'system',
            placement: 'prefix',
            content: '',
            enabled: true,
        };
        mutateActiveAgent((ag) => ({
            ...ag,
            promptBlocks: [...ag.promptBlocks, newBlock],
        }));
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    智能体档案 ({agentList.length})
                </span>
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={handleCreateAgent}
                >
                    新增智能体
                </Button>
            </div>

            <div class="ag-list" style={{ padding: 0 }}>
                {agentList.map((agent) => {
                    const isMain = agent.id === activePreset.mainAgentId;
                    const isSelected = activeAgent?.id === agent.id;
                    return (
                        <button
                            key={agent.id}
                            type="button"
                            class={
                                isSelected && !isMobile
                                    ? 'ag-list-item ag-list-item-active'
                                    : 'ag-list-item'
                            }
                            onClick={() => {
                                setSelectedAgentId(agent.id);
                                if (isMobile) {
                                    setDetailOpen(true);
                                }
                            }}
                        >
                            <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                <span class="ag-list-item-title">{agent.name}</span>
                                <div class="ag-row-wrap">
                                    {isMain ? <Badge tone="success">主叙事</Badge> : null}
                                    <Badge
                                        tone={
                                            agent.sessionMode === 'persistent'
                                                ? 'primary'
                                                : 'warning'
                                        }
                                    >
                                        {agent.sessionMode}
                                    </Badge>
                                </div>
                            </div>
                            <div class="ag-list-item-meta">
                                <span class="ag-mono">{agent.id}</span>
                                <span>
                                    {agent.promptBlocks.length} 积木 · {agent.enabledTools.length} 工具
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );

    const detailPane = activeAgent ? (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={
                        <span class="ag-row-wrap">
                            <span>{activeAgent.name}</span>
                            {activeAgent.id === activePreset.mainAgentId ? (
                                <Badge tone="success">主叙事 Agent</Badge>
                            ) : null}
                            <Badge tone="neutral" className="ag-mono">
                                {activeAgent.id}
                            </Badge>
                        </span>
                    }
                    subtitle="配置连接绑定、持久/瞬态轨迹模式、Prefix/Tail 积木、工具白名单与 VFS 读写权限"
                    actions={
                        <div class="ag-row-wrap">
                            {activeAgent.id !== activePreset.mainAgentId ? (
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                        mutatePreset((preset) => ({
                                            ...preset,
                                            mainAgentId: activeAgent.id,
                                        }));
                                        store.pushToast(`已将「${activeAgent.name}」设为主叙事 Agent`, 'success');
                                    }}
                                >
                                    设为主 Agent
                                </Button>
                            ) : null}
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<IconCopy size={14} />}
                                onClick={handleDuplicateAgent}
                            >
                                复制
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                icon={<IconTrash size={14} />}
                                disabled={activeAgent.id === activePreset.mainAgentId}
                                onClick={handleDeleteAgent}
                            >
                                删除
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-2">
                            <FormField label="智能体名称" required>
                                <TextInput
                                    value={nameDraft.value}
                                    onInput={nameDraft.onInput}
                                    onChange={nameDraft.onChange}
                                />
                            </FormField>

                            <FormField label="绑定 API 连接">
                                <SelectInput
                                    value={activeAgent.connectionId}
                                    options={connectionOptions}
                                    onChange={(connectionId) =>
                                        mutateActiveAgent((ag) => ({ ...ag, connectionId }))
                                    }
                                />
                            </FormField>

                            <FormField
                                label="会话轨迹模式 (sessionMode)"
                                hint="persistent 享受三层前缀 KV 缓存；ephemeral 按需拉取最近 K 轮"
                            >
                                <SelectInput<SessionMode>
                                    value={activeAgent.sessionMode}
                                    options={[
                                        { value: 'persistent', label: 'persistent（持久伴生缓存轨）' },
                                        { value: 'ephemeral', label: 'ephemeral（瞬态按需轨）' },
                                    ]}
                                    onChange={(sessionMode) =>
                                        mutateActiveAgent((ag) => ({
                                            ...ag,
                                            sessionMode,
                                            ...(sessionMode === 'persistent' && !ag.watermark
                                                ? { watermark: { ...DEFAULT_WATERMARK } }
                                                : {}),
                                            ...(sessionMode === 'ephemeral'
                                            && ag.ephemeralWindowSize === undefined
                                                ? { ephemeralWindowSize: 6 }
                                                : {}),
                                        }))
                                    }
                                />
                            </FormField>

                            <FormField label="单轮最大工具调用步数 (maxToolRounds)">
                                <TextInput
                                    type="number"
                                    min={1}
                                    max={100}
                                    step={1}
                                    value={maxRoundsDraft.value}
                                    onInput={maxRoundsDraft.onInput}
                                    onChange={maxRoundsDraft.onChange}
                                />
                            </FormField>

                            <FormField
                                label="强约束工具闭环"
                                hint="strictToolLoop · 覆盖当前连接的强约束工具闭环开关"
                            >
                                <SelectInput<StrictToolLoopOverride>
                                    ariaLabel="强约束工具闭环"
                                    value={activeAgent.strictToolLoop ?? 'inherit'}
                                    options={STRICT_TOOL_LOOP_OPTIONS}
                                    onChange={(strictToolLoop) =>
                                        mutateActiveAgent((ag) => ({ ...ag, strictToolLoop }))
                                    }
                                />
                            </FormField>

                            {activeAgent.sessionMode === 'ephemeral' ? (
                                <FormField
                                    label="瞬态窗口轮数 (ephemeralWindowSize)"
                                    hint="仅 ephemeral 模式生效：拉取最近 K 轮对话上下文"
                                >
                                    <TextInput
                                        type="number"
                                        min={1}
                                        max={500}
                                        step={1}
                                        value={ephWindowDraft.value}
                                        onInput={ephWindowDraft.onInput}
                                        onChange={ephWindowDraft.onChange}
                                    />
                                </FormField>
                            ) : (
                                <>
                                    <FormField
                                        label="高水位线 High Watermark (Tokens)"
                                        hint="达到 H 时在 maintenance 阶段触发原子分块归档"
                                    >
                                        <TextInput
                                            type="number"
                                            min={1000}
                                            max={2000000}
                                            step={1000}
                                            value={highWmDraft.value}
                                            onInput={highWmDraft.onInput}
                                            onChange={highWmDraft.onChange}
                                        />
                                    </FormField>
                                    <FormField
                                        label="低水位线 Low Watermark (Tokens)"
                                        hint="压缩后回落至 L（必须 <= High Watermark）"
                                    >
                                        <TextInput
                                            type="number"
                                            min={500}
                                            max={activeAgent.watermark?.high ?? DEFAULT_WATERMARK.high}
                                            step={500}
                                            value={lowWmDraft.value}
                                            onInput={lowWmDraft.onInput}
                                            onChange={lowWmDraft.onChange}
                                        />
                                    </FormField>
                                </>
                            )}
                        </div>

                        <FormField label="职责备注 (可选，供 @@agent 工具说明使用)">
                            <TextInput
                                value={descDraft.value}
                                placeholder="例如：负责考据角色过往设定与世界观细节"
                                onInput={descDraft.onInput}
                                onChange={descDraft.onChange}
                            />
                        </FormField>
                    </div>
                </Card>

                {/* Prompt Blocks Editor */}
                <Card
                    title="模块化提示词积木 (promptBlocks)"
                    subtitle="严格限定为 Layer 0 Prefix (静态前缀) 或 Layer 2 Tail (当轮尾部)，禁止 @D1~@DN 历史中间插拔"
                    actions={
                        <Button
                            size="sm"
                            variant="primary"
                            icon={<IconPlus size={14} />}
                            onClick={handleAddBlock}
                        >
                            新增积木
                        </Button>
                    }
                >
                    {hasTrailingSystemInPrefix(activeAgent.promptBlocks) ? (
                        <div
                            class="ag-banner ag-banner-warning"
                            role="status"
                            style={{ marginBottom: '10px' }}
                        >
                            提示：当前 Prefix 区域存在位于 custom / user / assistant 积木之后的 system 积木。Gemini 与 Claude 仅会将前导连续 system 消息放入顶层系统指令，建议将 system 积木置于 Prefix 最前。
                        </div>
                    ) : null}
                    {activeAgent.promptBlocks.length === 0 ? (
                        <EmptyState
                            title="暂无提示词积木"
                            description="点击上方「新增积木」添加静态 Prefix 指令或尾部 Tail 提醒。"
                        />
                    ) : (
                        <div class="ag-stack-v">
                            {activeAgent.promptBlocks.map((block, index) => (
                                <PromptBlockCard
                                    key={block.id}
                                    agentId={activeAgent.id}
                                    isMainAgent={activeAgent.id === activePreset.mainAgentId}
                                    presetTriggers={activePreset.triggers}
                                    block={block}
                                    index={index}
                                    total={activeAgent.promptBlocks.length}
                                    onUpdate={(patch) =>
                                        mutateActiveAgent((ag) => ({
                                            ...ag,
                                            promptBlocks: ag.promptBlocks.map((b) => {
                                                if (b.id !== block.id) {
                                                    return b;
                                                }
                                                const next = { ...b, ...patch };
                                                if (!next.triggers || next.triggers.length === 0) {
                                                    delete next.triggers;
                                                }
                                                return next;
                                            }),
                                        }))
                                    }
                                    onMove={(toIndex) =>
                                        mutateActiveAgent((ag) => ({
                                            ...ag,
                                            promptBlocks: moveArrayItem(ag.promptBlocks, index, toIndex),
                                        }))
                                    }
                                    onDelete={() =>
                                        mutateActiveAgent((ag) => ({
                                            ...ag,
                                            promptBlocks: ag.promptBlocks.filter((b) => b.id !== block.id),
                                        }))
                                    }
                                />
                            ))}
                        </div>
                    )}
                </Card>

                {/* Enabled Tools Checklist */}
                <Card
                    title={`授权工具清单 (${activeAgent.enabledTools.length})`}
                    subtitle="勾选该智能体在工具循环中允许调用的内置工具、自定义工具与斜杠命令工具"
                    actions={
                        <div class="ag-row-wrap">
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                    mutateActiveAgent((ag) => ({
                                        ...ag,
                                        enabledTools: Array.from(
                                            new Set([
                                                ...ag.enabledTools,
                                                'list_dir',
                                                'glob_files',
                                                'grep_search',
                                                'search_files',
                                                'read_file',
                                                'read_variables',
                                                'search_history',
                                                'read_history',
                                            ]),
                                        ),
                                    }))
                                }
                            >
                                全选只读检索工具
                            </Button>
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    mutateActiveAgent((ag) => ({ ...ag, enabledTools: [] }))
                                }
                            >
                                清空
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-2">
                            {allKnownTools.map((tool) => {
                                const enabled = activeAgent.enabledTools.includes(tool.name);
                                return (
                                    <div
                                        key={tool.name}
                                        style={{
                                            border: enabled
                                                ? '1px solid var(--primary)'
                                                : '1px solid var(--border)',
                                            borderRadius: '10px',
                                            background: enabled
                                                ? 'color-mix(in srgb, var(--primary) 8%, var(--card))'
                                                : 'var(--card)',
                                            padding: '10px 12px',
                                            minWidth: 0,
                                        }}
                                    >
                                        <ToggleSwitch
                                            checked={enabled}
                                            onChange={() => handleToggleTool(tool.name)}
                                            label={`${tool.name} [${tool.badge}]`}
                                            description={tool.desc}
                                        />
                                    </div>
                                );
                            })}
                        </div>

                        <div class="ag-row">
                            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                                <TextInput
                                    ariaLabel="添加自定义或世界书工具名"
                                    className="ag-mono"
                                    value={extraToolName}
                                    placeholder="添加世界书 @@tool / @@agent 名称，例如 archivist"
                                    onInput={setExtraToolName}
                                />
                            </div>
                            <Button
                                size="sm"
                                variant="secondary"
                                icon={<IconPlus size={14} />}
                                disabled={!extraToolName.trim()}
                                onClick={() => {
                                    const trimmed = extraToolName.trim();
                                    if (trimmed && !activeAgent.enabledTools.includes(trimmed)) {
                                        mutateActiveAgent((ag) => ({
                                            ...ag,
                                            enabledTools: [...ag.enabledTools, trimmed],
                                        }));
                                    }
                                    setExtraToolName('');
                                }}
                            >
                                添加工具
                            </Button>
                        </div>
                    </div>
                </Card>

                {/* VFS Glob Permissions */}
                <Card
                    title="VFS 沙箱读写权限 (ScopedToolGuard)"
                    subtitle="运行时强制拦截未授权路径；只读挂载区（/character, /persona, /preset, /history, /skills）即使匹配写规则也只读"
                >
                    <div class="ag-grid-2">
                        <GlobPatternListEditor
                            label="可读路径 Glob 白名单 (read)"
                            hint="例：/** 允许读全局，或 /lorebooks/**, /state/variables.json"
                            patterns={activeAgent.permissions.read}
                            presets={['/**', '/lorebooks/**', '/character/**', '/state/variables.json', '/history/**']}
                            onChange={(read) =>
                                mutateActiveAgent((ag) => ({
                                    ...ag,
                                    permissions: { ...ag.permissions, read },
                                }))
                            }
                        />
                        <GlobPatternListEditor
                            label="可写路径 Glob 白名单 (write)"
                            hint="例：/memory/**, /scratch/**, /state/variables.json, /lorebooks/**"
                            patterns={activeAgent.permissions.write}
                            presets={['/memory/**', '/scratch/**', '/state/variables.json', '/lorebooks/**']}
                            onChange={(write) =>
                                mutateActiveAgent((ag) => ({
                                    ...ag,
                                    permissions: { ...ag.permissions, write },
                                }))
                            }
                        />
                    </div>
                </Card>
            </div>
        </div>
    ) : (
        <EmptyState
            icon={<IconBot size={22} />}
            title="请选择或创建智能体"
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
            <PresetManagerPanel
                store={store}
                compact
                onPresetChanged={() => setDetailOpen(false)}
            />
            <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }}>
                <MasterDetailLayout
                    master={masterPane}
                    detail={detailPane}
                    detailOpen={detailOpen}
                    onDetailOpenChange={setDetailOpen}
                    detailTitle={activeAgent?.name ?? '智能体配置'}
                    isMobile={isMobile}
                    emptyDetailTitle="请选择左侧智能体档案"
                />
            </div>
        </div>
    );
}
