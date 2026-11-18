import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { resolveActivePreset } from '@/core/config';
import {
    createBuiltinTools,
    interpolateSlashCommand,
    schemaToCanonicalJsonSchema,
} from '@/core/tools';
import type {
    ClassifiedLoreEntry,
    CustomToolConfig,
    PipelinePhase,
    SlashToolParamDef,
    SlashToolParamType,
    TriggerRule,
} from '@/core/types';
import {
    Badge,
    Button,
    Card,
    CodeEditor,
    type CodeSnippet,
    EmptyState,
    FormField,
    MasterDetailLayout,
    SegmentedControl,
    SelectInput,
    TextInput,
    ToggleSwitch,
    useIsMobileViewport,
} from '@/ui/components';
import {
    IconArrowDown,
    IconArrowUp,
    IconPlay,
    IconPlus,
    IconRefresh,
    IconTrash,
    IconWrench,
} from '@/ui/components/Icons';
import {
    type ConsoleViewProps,
    type ToolTestResult,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import {
    allocateUniqueId,
    moveArrayItem,
    useDraftString,
    useDraftTagList,
} from './studio-helpers';

const JS_TOOL_SNIPPETS: readonly CodeSnippet[] = [
    { label: 'defineTool', insertText: 'export default defineTool({\n  name: \'\',\n  description: \'\',\n  parameters: z.object({}),\n  async execute(args, ctx) {\n    return \'ok\';\n  },\n});' },
    { label: 'z.object', insertText: 'z.object({ })' },
    { label: 'ctx.fs', insertText: 'await ctx.fs.read(\'/lorebooks/\')' },
    { label: 'ctx.vars', insertText: 'await ctx.vars.patch({})' },
    { label: 'attachMedia', insertText: 'await ctx.message.attachMedia({ type: \'image\', url })' },
    { label: 'ctx.signal', insertText: 'signal: ctx.signal' },
];

const DEFAULT_JS_TOOL_TEMPLATE = `export default defineTool({
  name: 'custom_helper',
  description: '自定义 JS 工具说明',
  parameters: z.object({
    query: z.string().describe('输入参数'),
  }),
  async execute(args, ctx) {
    // 透传 ctx.signal 支持 Swipe/停止即时中断
    return \`已处理: \${args.query} (锚定 #\${ctx.target.messageId}#\${ctx.target.swipeId})\`;
  },
});`;

type ToolSelection =
    | { kind: 'custom'; id: string }
    | { kind: 'script'; triggerId: string }
    | { kind: 'builtin'; name: string }
    | { kind: 'wi_lore'; vfsPath: string };

type ToolFilterKind = 'all' | 'custom' | 'script' | 'builtin';

interface SlashParamRowProps {
    toolId: string;
    param: SlashToolParamDef;
    index: number;
    total: number;
    onUpdate: (patch: Partial<SlashToolParamDef>) => void;
    onMove: (toIndex: number) => void;
    onDelete: () => void;
}

function SlashParamRow({
    toolId,
    param,
    index,
    total,
    onUpdate,
    onMove,
    onDelete,
}: SlashParamRowProps) {
    const resetKey = `${toolId}:param:${index}`;
    const nameDraft = useDraftString(
        resetKey,
        param.name,
        (name) => onUpdate({ name }),
        { allowEmpty: false },
    );
    const descDraft = useDraftString(
        resetKey,
        param.description,
        (description) => onUpdate({ description }),
        { allowEmpty: true },
    );
    const enumDraft = useDraftTagList(
        resetKey,
        param.enumValues ?? [],
        (enumValues) => onUpdate({ enumValues }),
    );

    return (
        <div
            style={{
                border: '1px solid var(--border)',
                borderRadius: '10px',
                background: 'var(--card)',
                padding: '10px',
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                minWidth: 0,
            }}
        >
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <Badge tone="primary">参数 #{index + 1}</Badge>
                <div class="ag-row-wrap">
                    <ToggleSwitch
                        checked={param.required !== false}
                        onChange={(required) => onUpdate({ required })}
                        label="必填"
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        ariaLabel="上移参数"
                        disabled={index === 0}
                        icon={<IconArrowUp size={14} />}
                        onClick={() => onMove(index - 1)}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        ariaLabel="下移参数"
                        disabled={index >= total - 1}
                        icon={<IconArrowDown size={14} />}
                        onClick={() => onMove(index + 1)}
                    />
                    <Button
                        size="sm"
                        variant="danger"
                        ariaLabel="删除参数"
                        icon={<IconTrash size={14} />}
                        onClick={onDelete}
                    />
                </div>
            </div>

            <div class="ag-grid-2">
                <FormField label="参数键名 (用于 {{name}} 插值)" required>
                    <TextInput
                        className="ag-mono"
                        value={nameDraft.value}
                        placeholder="例如 prompt"
                        onInput={nameDraft.onInput}
                        onChange={nameDraft.onChange}
                    />
                </FormField>

                <FormField label="参数类型">
                    <SelectInput<SlashToolParamType>
                        value={param.type}
                        options={[
                            { value: 'string', label: 'string (文本)' },
                            { value: 'number', label: 'number (数值)' },
                            { value: 'boolean', label: 'boolean (布尔)' },
                            { value: 'enum', label: 'enum (枚举选项)' },
                        ]}
                        onChange={(type) => onUpdate({ type })}
                    />
                </FormField>
            </div>

            <FormField label="给大模型的参数说明 (description)">
                <TextInput
                    value={descDraft.value}
                    placeholder="描述该参数用途"
                    onInput={descDraft.onInput}
                    onChange={descDraft.onChange}
                />
            </FormField>

            {param.type === 'enum' ? (
                <FormField label="枚举候选值（逗号分隔）">
                    <TextInput
                        className="ag-mono"
                        value={enumDraft.value}
                        placeholder="portrait, landscape, square"
                        onInput={enumDraft.onInput}
                        onChange={enumDraft.onChange}
                    />
                </FormField>
            ) : null}
        </div>
    );
}

function buildSampleArgsForCustomTool(tool: CustomToolConfig): string {
    if (tool.kind === 'slash_bridge') {
        const obj: Record<string, unknown> = {};
        for (const p of tool.params ?? []) {
            if (p.defaultValue !== undefined) {
                obj[p.name] = p.defaultValue;
            } else if (p.type === 'number') {
                obj[p.name] = 1;
            } else if (p.type === 'boolean') {
                obj[p.name] = true;
            } else if (p.type === 'enum' && p.enumValues?.length) {
                obj[p.name] = p.enumValues[0];
            } else {
                obj[p.name] = `<${p.name}>`;
            }
        }
        return JSON.stringify(obj, null, 2);
    }
    return JSON.stringify({ sample: 'test_value' }, null, 2);
}

/**
 * View ⑥: Tools & Scripts (`tabId: 'tools'`).
 * Built-in tool reference, CRUD for JS `defineTool`, zero-code Slash Bridge builder,
 * `@@script` editors, scanned WI `@@tool`/`@@script` entries, and live sandbox test runner.
 */
export function ToolsView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const activeTarget = useAppStore((s) => s.activeTarget);
    const activePreset = resolveActivePreset(settings);

    const builtinTools = useMemo(() => createBuiltinTools(), []);
    const scriptRules = useMemo(
        () => activePreset.triggers.filter((t) => t.kind === 'script'),
        [activePreset.triggers],
    );

    const [filterKind, setFilterKind] = useState<ToolFilterKind>('all');
    const [wiToolEntries, setWiToolEntries] = useState<ClassifiedLoreEntry[]>([]);
    const [selection, setSelection] = useState<ToolSelection | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    const [testArgsJson, setTestArgsJson] = useState('{\n  "positivePrompt": "1girl, ink wash bamboo courtyard",\n  "aspectRatio": "portrait"\n}');
    const [testResult, setTestResult] = useState<ToolTestResult | null>(null);
    const [testing, setTesting] = useState(false);

    const refreshWiTools = useCallback(async () => {
        try {
            const res = await store.services.listClassifiedLoreEntries(
                activePreset.wiRouterOverrides,
            );
            setWiToolEntries(
                res.entries.filter((e) =>
                    e.decorators.some((d) => d.name === '@@tool' || d.name === '@@script'),
                ),
            );
        } catch {
            setWiToolEntries([]);
        }
    }, [activePreset.wiRouterOverrides, store.services]);

    useEffect(() => {
        void refreshWiTools();
    }, [refreshWiTools]);

    useEffect(() => {
        if (!selection) {
            if (activePreset.customTools.length > 0) {
                setSelection({ kind: 'custom', id: activePreset.customTools[0].id });
            } else if (scriptRules.length > 0) {
                setSelection({ kind: 'script', triggerId: scriptRules[0].id });
            } else if (builtinTools.length > 0) {
                setSelection({ kind: 'builtin', name: builtinTools[0].name });
            }
            return;
        }
        if (
            selection.kind === 'custom'
            && !activePreset.customTools.some((t) => t.id === selection.id)
        ) {
            setSelection(
                activePreset.customTools[0]
                    ? { kind: 'custom', id: activePreset.customTools[0].id }
                    : { kind: 'builtin', name: builtinTools[0].name },
            );
        } else if (
            selection.kind === 'script'
            && !scriptRules.some((r) => r.id === selection.triggerId)
        ) {
            setSelection(
                scriptRules[0]
                    ? { kind: 'script', triggerId: scriptRules[0].id }
                    : activePreset.customTools[0]
                        ? { kind: 'custom', id: activePreset.customTools[0].id }
                        : { kind: 'builtin', name: builtinTools[0].name },
            );
        }
    }, [activePreset.customTools, builtinTools, scriptRules, selection]);

    const activeCustomTool =
        selection?.kind === 'custom'
            ? activePreset.customTools.find((t) => t.id === selection.id)
            : undefined;
    const activeScriptRule =
        selection?.kind === 'script'
            ? scriptRules.find((r) => r.id === selection.triggerId)
            : undefined;
    const activeBuiltinTool =
        selection?.kind === 'builtin'
            ? builtinTools.find((t) => t.name === selection.name)
            : undefined;
    const activeWiTool =
        selection?.kind === 'wi_lore'
            ? wiToolEntries.find((e) => e.vfsPath === selection.vfsPath)
            : undefined;

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

    const mutateActiveCustom = (updater: (tool: CustomToolConfig) => CustomToolConfig) => {
        if (!activeCustomTool) {
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            customTools: preset.customTools.map((t) =>
                t.id === activeCustomTool.id ? updater(t) : t,
            ),
        }));
    };

    const mutateActiveScript = (updater: (rule: TriggerRule) => TriggerRule) => {
        if (!activeScriptRule) {
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            triggers: preset.triggers.map((t) =>
                t.id === activeScriptRule.id ? updater(t) : t,
            ),
        }));
    };

    const customResetKey = `${activePreset.id}:${activeCustomTool?.id ?? ''}`;
    const toolNameDraft = useDraftString(
        customResetKey,
        activeCustomTool?.name ?? '',
        (name) => mutateActiveCustom((t) => ({ ...t, name })),
        { allowEmpty: false },
    );
    const toolDescDraft = useDraftString(
        customResetKey,
        activeCustomTool?.description ?? '',
        (description) => mutateActiveCustom((t) => ({ ...t, description })),
        { allowEmpty: true },
    );
    const toolCodeDraft = useDraftString(
        customResetKey,
        activeCustomTool?.code ?? '',
        (code) => mutateActiveCustom((t) => ({ ...t, code })),
        { allowEmpty: true },
    );
    const commandTemplateDraft = useDraftString(
        customResetKey,
        activeCustomTool?.commandTemplate ?? '',
        (commandTemplate) => mutateActiveCustom((t) => ({ ...t, commandTemplate })),
        { allowEmpty: true },
    );

    const scriptResetKey = `${activePreset.id}:${activeScriptRule?.id ?? ''}`;
    const scriptLabelDraft = useDraftString(
        scriptResetKey,
        activeScriptRule?.label ?? '',
        (label) => mutateActiveScript((r) => ({ ...r, label })),
        { allowEmpty: false },
    );
    const scriptCodeDraft = useDraftString(
        scriptResetKey,
        activeScriptRule?.scriptCode ?? activeScriptRule?.instructionTemplate ?? '',
        (scriptCode) => mutateActiveScript((r) => ({ ...r, scriptCode })),
        { allowEmpty: true },
    );

    const handleAddCustomTool = (kind: 'js' | 'slash_bridge') => {
        const existingIds = activePreset.customTools.map((t) => t.id);
        const existingNames = activePreset.customTools.map((t) => t.name);
        const id = allocateUniqueId(
            kind === 'slash_bridge' ? 'slash_tool' : 'js_tool',
            existingIds,
            'tool',
        );
        const name = allocateUniqueId(
            kind === 'slash_bridge' ? 'slash_action' : 'custom_helper',
            existingNames,
            'custom_tool',
        );
        const created: CustomToolConfig =
            kind === 'slash_bridge'
                ? {
                    id,
                    name,
                    kind: 'slash_bridge',
                    description: '执行酒馆斜杠命令并返回结果',
                    enabled: true,
                    commandTemplate: '/echo {{text}}',
                    params: [
                        {
                            name: 'text',
                            type: 'string',
                            description: '要发送的文本参数',
                            required: true,
                        },
                    ],
                }
                : {
                    id,
                    name,
                    kind: 'js',
                    description: '自定义 JS defineTool 工具',
                    enabled: true,
                    allowNetwork: true,
                    code: DEFAULT_JS_TOOL_TEMPLATE.replace('custom_helper', name),
                };

        mutatePreset((preset) => ({
            ...preset,
            customTools: [...preset.customTools, created],
        }));
        setSelection({ kind: 'custom', id: created.id });
        setTestArgsJson(buildSampleArgsForCustomTool(created));
        setTestResult(null);
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已新增自定义工具：${created.name}`, 'success');
    };

    const handleAddScriptRule = () => {
        const id = allocateUniqueId(
            'script_rule',
            activePreset.triggers.map((t) => t.id),
            'script',
        );
        const created: TriggerRule = {
            id,
            label: `@@script 脚本 ${scriptRules.length + 1}`,
            source: 'preset',
            phase: 'after_turn',
            order: 1,
            barrier: 'turn',
            agentProfileId: activePreset.mainAgentId,
            kind: 'script',
            decorator: '@@script',
            condition: { type: 'always' },
            instructionTemplate: '确定性 JS 脚本任务（0 Token 消耗）',
            scriptCode: `// 可用 ctx.fs / ctx.vars / ctx.message / ctx.st / ctx.target / ctx.signal
const prev = (await ctx.vars.get('turnCount')) ?? 0;
await ctx.vars.patch({ turnCount: Number(prev) + 1 });
return { ok: true, turnCount: Number(prev) + 1 };`,
            enabled: true,
        };
        mutatePreset((preset) => ({
            ...preset,
            triggers: [...preset.triggers, created],
        }));
        setSelection({ kind: 'script', triggerId: created.id });
        setTestArgsJson('{}');
        setTestResult(null);
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已新增脚本规则：${created.label}`, 'success');
    };

    const handleDeleteCustomTool = (tool: CustomToolConfig) => {
        store.openModal({
            kind: 'confirm',
            title: '删除工具确认',
            message: `确定删除自定义工具「${tool.name}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => ({
                    ...preset,
                    customTools: preset.customTools.filter((t) => t.id !== tool.id),
                }));
                setSelection(null);
                setDetailOpen(false);
                store.pushToast(`已删除工具：${tool.name}`, 'warning');
            },
        });
    };

    const handleDeleteScriptRule = (rule: TriggerRule) => {
        store.openModal({
            kind: 'confirm',
            title: '删除脚本确认',
            message: `确定删除脚本规则「${rule.label}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => ({
                    ...preset,
                    triggers: preset.triggers.filter((t) => t.id !== rule.id),
                }));
                setSelection(null);
                setDetailOpen(false);
                store.pushToast(`已删除脚本：${rule.label}`, 'warning');
            },
        });
    };

    const handleRunSandboxTest = async () => {
        let payload: CustomToolConfig | { name: string; code?: string; commandTemplate?: string } | null =
            null;
        if (activeCustomTool) {
            payload = activeCustomTool;
        } else if (activeScriptRule) {
            payload = {
                name: activeScriptRule.label,
                code: activeScriptRule.scriptCode ?? activeScriptRule.instructionTemplate,
            };
        } else if (activeBuiltinTool) {
            payload = {
                name: activeBuiltinTool.name,
            };
        } else if (activeWiTool) {
            payload = {
                name: activeWiTool.slug,
                code: activeWiTool.cleanContent,
            };
        }
        if (!payload) {
            return;
        }
        try {
            setTesting(true);
            const result = await store.services.testToolInSandbox(
                payload,
                testArgsJson,
                activeTarget,
            );
            setTestResult(result);
            store.pushToast(
                result.ok ? '沙箱模拟调用测试通过' : '沙箱模拟调用返回错误',
                result.ok ? 'success' : 'error',
            );
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            setTestResult({
                ok: false,
                durationMs: 0,
                output: '',
                error: msg,
                target: activeTarget,
            });
            store.pushToast(`测试执行异常：${msg}`, 'error');
        } finally {
            setTesting(false);
        }
    };

    const builtinSchemaJson = useMemo(() => {
        if (!activeBuiltinTool) {
            return '';
        }
        try {
            const override = activePreset.builtinToolSettings?.[activeBuiltinTool.name];
            return JSON.stringify(
                schemaToCanonicalJsonSchema(activeBuiltinTool.parameters, override?.parameters),
                null,
                2,
            );
        } catch {
            return '{}';
        }
    }, [activeBuiltinTool, activePreset.builtinToolSettings]);

    const slashCommandPreview = useMemo(() => {
        if (!activeCustomTool || activeCustomTool.kind !== 'slash_bridge') {
            return '';
        }
        let sampleObj: Record<string, unknown> = {};
        try {
            const parsed: unknown = JSON.parse(testArgsJson || '{}');
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                sampleObj = parsed as Record<string, unknown>;
            }
        } catch {
            sampleObj = {};
        }
        return interpolateSlashCommand(
            activeCustomTool.commandTemplate ?? '',
            sampleObj,
            activeCustomTool.params ?? [],
        );
    }, [activeCustomTool, testArgsJson]);

    const agentIds = useMemo(
        () => Object.values(activePreset.agents),
        [activePreset.agents],
    );

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <SegmentedControl<ToolFilterKind>
                ariaLabel="工具分类筛选"
                value={filterKind}
                options={[
                    { value: 'all', label: '全部' },
                    { value: 'custom', label: '自定义' },
                    { value: 'script', label: '脚本' },
                    { value: 'builtin', label: '内置参考' },
                ]}
                onChange={setFilterKind}
            />

            <div class="ag-row-wrap">
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={() => handleAddCustomTool('js')}
                >
                    JS defineTool
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconPlus size={14} />}
                    onClick={() => handleAddCustomTool('slash_bridge')}
                >
                    斜杠桥接
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconPlus size={14} />}
                    onClick={handleAddScriptRule}
                >
                    @@script 脚本
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconRefresh size={14} />}
                    onClick={() => void refreshWiTools()}
                >
                    刷新 WI
                </Button>
            </div>

            {(filterKind === 'all' || filterKind === 'custom') ? (
                <div class="ag-stack-v" style={{ gap: '6px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                        预设自定义工具 ({activePreset.customTools.length})
                    </div>
                    {activePreset.customTools.map((tool) => {
                        const selected =
                            selection?.kind === 'custom' && selection.id === tool.id;
                        return (
                            <button
                                key={tool.id}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                style={{ opacity: tool.enabled ? 1 : 0.6 }}
                                onClick={() => {
                                    setSelection({ kind: 'custom', id: tool.id });
                                    setTestArgsJson(buildSampleArgsForCustomTool(tool));
                                    setTestResult(null);
                                    if (isMobile) {
                                        setDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                    <span class="ag-list-item-title ag-mono">{tool.name}</span>
                                    <Badge tone={tool.kind === 'slash_bridge' ? 'warning' : 'primary'}>
                                        {tool.kind === 'slash_bridge' ? '斜杠桥接' : 'JS defineTool'}
                                    </Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span>{tool.description || '无描述'}</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {(filterKind === 'all' || filterKind === 'script') ? (
                <div class="ag-stack-v" style={{ gap: '6px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                        确定性脚本 / WI @@tool ({scriptRules.length + wiToolEntries.length})
                    </div>
                    {scriptRules.map((rule) => {
                        const selected =
                            selection?.kind === 'script' && selection.triggerId === rule.id;
                        return (
                            <button
                                key={rule.id}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                onClick={() => {
                                    setSelection({ kind: 'script', triggerId: rule.id });
                                    setTestArgsJson('{}');
                                    setTestResult(null);
                                    if (isMobile) {
                                        setDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                    <span class="ag-list-item-title">{rule.label}</span>
                                    <Badge tone="success">script</Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span>{rule.phase}</span>
                                    <span>#{rule.order}</span>
                                </div>
                            </button>
                        );
                    })}
                    {wiToolEntries.map((item) => {
                        const selected =
                            selection?.kind === 'wi_lore' && selection.vfsPath === item.vfsPath;
                        return (
                            <button
                                key={item.vfsPath}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                onClick={() => {
                                    setSelection({ kind: 'wi_lore', vfsPath: item.vfsPath });
                                    setTestArgsJson('{}');
                                    setTestResult(null);
                                    if (isMobile) {
                                        setDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                    <span class="ag-list-item-title">{item.entry.comment || item.slug}</span>
                                    <Badge tone="warning">世界书</Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                                        {item.vfsPath}
                                    </span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {(filterKind === 'all' || filterKind === 'builtin') ? (
                <div class="ag-stack-v" style={{ gap: '6px' }}>
                    <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                        内置工具参考 ({builtinTools.length})
                    </div>
                    {builtinTools.map((tool) => {
                        const selected =
                            selection?.kind === 'builtin' && selection.name === tool.name;
                        const setting = activePreset.builtinToolSettings?.[tool.name];
                        return (
                            <button
                                key={tool.name}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                style={{ opacity: setting?.enabled === false ? 0.55 : 1 }}
                                onClick={() => {
                                    setSelection({ kind: 'builtin', name: tool.name });
                                    setTestArgsJson('{}');
                                    setTestResult(null);
                                    if (isMobile) {
                                        setDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                    <span class="ag-list-item-title ag-mono">{tool.name}</span>
                                    <Badge tone="neutral">内置</Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span>{tool.description}</span>
                                </div>
                            </button>
                        );
                    })}
                </div>
            ) : null}
        </div>
    );

    const sandboxTestCard = (
        <Card
            title={
                <span class="ag-row-wrap">
                    <span>▶ 沙箱模拟调用测试</span>
                    <Badge tone="primary" className="ag-mono">
                        锚定 #{activeTarget.messageId}#{activeTarget.swipeId}
                    </Badge>
                </span>
            }
            subtitle="无需发送真实聊天消息，直接在受控沙箱校验参数并执行试跑"
            actions={
                <div class="ag-row-wrap">
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                            if (activeCustomTool) {
                                setTestArgsJson(buildSampleArgsForCustomTool(activeCustomTool));
                            } else {
                                setTestArgsJson('{}');
                            }
                        }}
                    >
                        填充示例参数
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        loading={testing}
                        icon={<IconPlay size={14} />}
                        onClick={() => void handleRunSandboxTest()}
                    >
                        ▶ 沙箱模拟调用测试
                    </Button>
                </div>
            }
        >
            <div class="ag-stack-v">
                <CodeEditor
                    label="调用参数 JSON (args)"
                    languageHint="json"
                    rows={4}
                    minHeight="110px"
                    showToolbar={false}
                    value={testArgsJson}
                    onChange={setTestArgsJson}
                />

                {testResult ? (
                    <div
                        style={{
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            padding: '10px 12px',
                            background: 'var(--card)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '8px',
                        }}
                    >
                        <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                            <div class="ag-row-wrap">
                                <Badge tone={testResult.ok ? 'success' : 'error'}>
                                    {testResult.ok ? '✓ 执行成功' : '✗ 执行失败'}
                                </Badge>
                                <Badge tone="neutral" className="ag-mono">
                                    耗时 {testResult.durationMs} ms
                                </Badge>
                                <Badge tone="neutral" className="ag-mono">
                                    target: #{testResult.target.messageId}#{testResult.target.swipeId}
                                </Badge>
                            </div>
                        </div>
                        {testResult.error ? (
                            <div class="ag-banner ag-banner-error">{testResult.error}</div>
                        ) : null}
                        {testResult.output ? (
                            <pre class="ag-pre">{testResult.output}</pre>
                        ) : null}
                    </div>
                ) : null}
            </div>
        </Card>
    );

    let detailPane;
    if (activeCustomTool) {
        const params = activeCustomTool.params ?? [];
        const allowedAgents = activeCustomTool.allowedAgents ?? [];
        detailPane = (
            <div class="ag-view-scroll ag-thin-scroll">
                <div class="ag-stack-v">
                    <Card
                        title={
                            <span class="ag-row-wrap">
                                <span class="ag-mono">{activeCustomTool.name}</span>
                                <Badge
                                    tone={
                                        activeCustomTool.kind === 'slash_bridge'
                                            ? 'warning'
                                            : 'primary'
                                    }
                                >
                                    {activeCustomTool.kind === 'slash_bridge'
                                        ? 'slash_bridge'
                                        : 'js_define_tool'}
                                </Badge>
                            </span>
                        }
                        subtitle={
                            activeCustomTool.kind === 'slash_bridge'
                                ? '零代码将 SillyTavern 斜杠命令包装为带 Zod 校验的 Tool'
                                : '在受控 iframe 沙箱中执行标准现代 JS defineTool(...)'
                        }
                        actions={
                            <div class="ag-row-wrap">
                                <ToggleSwitch
                                    checked={activeCustomTool.enabled}
                                    onChange={(enabled) =>
                                        mutateActiveCustom((t) => ({ ...t, enabled }))
                                    }
                                    label={activeCustomTool.enabled ? '已启用' : '已停用'}
                                />
                                <Button
                                    size="sm"
                                    variant="danger"
                                    icon={<IconTrash size={14} />}
                                    onClick={() => handleDeleteCustomTool(activeCustomTool)}
                                >
                                    删除
                                </Button>
                            </div>
                        }
                    >
                        <div class="ag-stack-v">
                            <div class="ag-grid-2">
                                <FormField label="工具名 (name)" required>
                                    <TextInput
                                        className="ag-mono"
                                        value={toolNameDraft.value}
                                        onInput={toolNameDraft.onInput}
                                        onChange={toolNameDraft.onChange}
                                    />
                                </FormField>
                                <FormField label="工具类型">
                                    <SelectInput<'js' | 'slash_bridge'>
                                        value={activeCustomTool.kind}
                                        options={[
                                            { value: 'js', label: 'JS defineTool 工具' },
                                            { value: 'slash_bridge', label: '零代码斜杠桥接 (slash_bridge)' },
                                        ]}
                                        onChange={(kind) =>
                                            mutateActiveCustom((t) => ({
                                                ...t,
                                                kind,
                                                ...(kind === 'js' && !t.code
                                                    ? { code: DEFAULT_JS_TOOL_TEMPLATE }
                                                    : {}),
                                                ...(kind === 'slash_bridge' && !t.commandTemplate
                                                    ? { commandTemplate: '/echo {{text}}', params: t.params ?? [] }
                                                    : {}),
                                            }))
                                        }
                                    />
                                </FormField>
                            </div>

                            <FormField label="模型可见工具描述 (description)">
                                <TextInput
                                    value={toolDescDraft.value}
                                    onInput={toolDescDraft.onInput}
                                    onChange={toolDescDraft.onChange}
                                />
                            </FormField>

                            {activeCustomTool.kind === 'js' ? (
                                <>
                                    <ToggleSwitch
                                        checked={activeCustomTool.allowNetwork ?? true}
                                        onChange={(allowNetwork) =>
                                            mutateActiveCustom((t) => ({ ...t, allowNetwork }))
                                        }
                                        label="允许沙箱内发起 fetch 网络请求 (allowNetwork)"
                                        description="用于调用 ComfyUI / NAI / TTS 等本地或外部服务；关闭则强制禁网"
                                    />
                                    <CodeEditor
                                        label="JS 工具定义源码 (defineTool)"
                                        languageHint="javascript"
                                        snippets={JS_TOOL_SNIPPETS}
                                        rows={12}
                                        minHeight="240px"
                                        value={toolCodeDraft.value}
                                        onChange={toolCodeDraft.onInput}
                                    />
                                </>
                            ) : (
                                <div class="ag-stack-v">
                                    <FormField
                                        label="斜杠命令模板 (commandTemplate)"
                                        hint="使用 {{paramName}} 插入参数，自动防注入转义管道符与宏语法"
                                    >
                                        <TextInput
                                            className="ag-mono"
                                            value={commandTemplateDraft.value}
                                            placeholder="/sd {{prompt}}"
                                            onInput={commandTemplateDraft.onInput}
                                            onChange={commandTemplateDraft.onChange}
                                        />
                                    </FormField>

                                    <div class="ag-banner ag-banner-primary ag-mono">
                                        命令编译预览：{slashCommandPreview || '(空模板)'}
                                    </div>

                                    <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                                        <span style={{ fontSize: '13px', fontWeight: 600 }}>
                                            参数表单定义 ({params.length})
                                        </span>
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            icon={<IconPlus size={14} />}
                                            onClick={() => {
                                                const pName = allocateUniqueId(
                                                    'param',
                                                    params.map((p) => p.name),
                                                    'param',
                                                );
                                                mutateActiveCustom((t) => ({
                                                    ...t,
                                                    params: [
                                                        ...(t.params ?? []),
                                                        {
                                                            name: pName,
                                                            type: 'string',
                                                            description: '',
                                                            required: true,
                                                        },
                                                    ],
                                                }));
                                            }}
                                        >
                                            添加参数
                                        </Button>
                                    </div>

                                    {params.length === 0 ? (
                                        <div class="ag-field-hint">
                                            暂无参数定义；无参命令可直接执行模板。
                                        </div>
                                    ) : (
                                        <div class="ag-stack-v">
                                            {params.map((param, idx) => (
                                                <SlashParamRow
                                                    key={`${activeCustomTool.id}_p_${idx}`}
                                                    toolId={activeCustomTool.id}
                                                    param={param}
                                                    index={idx}
                                                    total={params.length}
                                                    onUpdate={(patch) =>
                                                        mutateActiveCustom((t) => ({
                                                            ...t,
                                                            params: (t.params ?? []).map((p, i) =>
                                                                i === idx ? { ...p, ...patch } : p,
                                                            ),
                                                        }))
                                                    }
                                                    onMove={(toIndex) =>
                                                        mutateActiveCustom((t) => ({
                                                            ...t,
                                                            params: moveArrayItem(
                                                                t.params ?? [],
                                                                idx,
                                                                toIndex,
                                                            ),
                                                        }))
                                                    }
                                                    onDelete={() =>
                                                        mutateActiveCustom((t) => ({
                                                            ...t,
                                                            params: (t.params ?? []).filter(
                                                                (_, i) => i !== idx,
                                                            ),
                                                        }))
                                                    }
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div class="ag-stack-v">
                                <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted-foreground)' }}>
                                    允许调用该工具的智能体（留空则对所有已勾选该工具的智能体开放）
                                </div>
                                <div class="ag-row-wrap">
                                    {agentIds.map((ag) => {
                                        const selected = allowedAgents.includes(ag.id);
                                        return (
                                            <Button
                                                key={ag.id}
                                                size="sm"
                                                variant={selected ? 'primary' : 'secondary'}
                                                active={selected}
                                                onClick={() => {
                                                    const next = selected
                                                        ? allowedAgents.filter((id) => id !== ag.id)
                                                        : [...allowedAgents, ag.id];
                                                    mutateActiveCustom((t) => ({
                                                        ...t,
                                                        allowedAgents: next,
                                                    }));
                                                }}
                                            >
                                                {ag.name}
                                            </Button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </Card>

                    {sandboxTestCard}
                </div>
            </div>
        );
    } else if (activeScriptRule) {
        detailPane = (
            <div class="ag-view-scroll ag-thin-scroll">
                <div class="ag-stack-v">
                    <Card
                        title={
                            <span class="ag-row-wrap">
                                <span>{activeScriptRule.label}</span>
                                <Badge tone="success">@@script (0 Token JS)</Badge>
                            </span>
                        }
                        subtitle="确定性脚本触发器，在指定管线阶段无 LLM 参与直接运行"
                        actions={
                            <div class="ag-row-wrap">
                                <ToggleSwitch
                                    checked={activeScriptRule.enabled}
                                    onChange={(enabled) =>
                                        mutateActiveScript((r) => ({ ...r, enabled }))
                                    }
                                    label={activeScriptRule.enabled ? '已启用' : '已停用'}
                                />
                                <Button
                                    size="sm"
                                    variant="danger"
                                    icon={<IconTrash size={14} />}
                                    onClick={() => handleDeleteScriptRule(activeScriptRule)}
                                >
                                    删除
                                </Button>
                            </div>
                        }
                    >
                        <div class="ag-stack-v">
                            <div class="ag-grid-2">
                                <FormField label="脚本名称" required>
                                    <TextInput
                                        value={scriptLabelDraft.value}
                                        onInput={scriptLabelDraft.onInput}
                                        onChange={scriptLabelDraft.onChange}
                                    />
                                </FormField>
                                <FormField label="执行阶段">
                                    <SelectInput<PipelinePhase>
                                        value={activeScriptRule.phase}
                                        options={[
                                            { value: 'before_turn', label: 'before_turn' },
                                            { value: 'main_turn', label: 'main_turn' },
                                            { value: 'after_turn', label: 'after_turn' },
                                            { value: 'maintenance', label: 'maintenance' },
                                        ]}
                                        onChange={(phase) =>
                                            mutateActiveScript((r) => ({ ...r, phase }))
                                        }
                                    />
                                </FormField>
                            </div>
                            <CodeEditor
                                label="确定性脚本代码 (@@script)"
                                languageHint="javascript"
                                snippets={JS_TOOL_SNIPPETS}
                                rows={11}
                                minHeight="220px"
                                value={scriptCodeDraft.value}
                                onChange={scriptCodeDraft.onInput}
                            />
                        </div>
                    </Card>

                    {sandboxTestCard}
                </div>
            </div>
        );
    } else if (activeBuiltinTool) {
        const setting = activePreset.builtinToolSettings?.[activeBuiltinTool.name] ?? {
            enabled: true,
        };
        detailPane = (
            <div class="ag-view-scroll ag-thin-scroll">
                <div class="ag-stack-v">
                    <Card
                        title={
                            <span class="ag-row-wrap">
                                <span class="ag-mono">{activeBuiltinTool.name}</span>
                                <Badge tone="neutral">内置核心工具</Badge>
                            </span>
                        }
                        subtitle={activeBuiltinTool.description}
                        actions={
                            <ToggleSwitch
                                checked={setting.enabled}
                                onChange={(enabled) =>
                                    mutatePreset((preset) => ({
                                        ...preset,
                                        builtinToolSettings: {
                                            ...(preset.builtinToolSettings ?? {}),
                                            [activeBuiltinTool.name]: {
                                                ...setting,
                                                enabled,
                                            },
                                        },
                                    }))
                                }
                                label={setting.enabled ? '全局允许' : '全局禁用'}
                            />
                        }
                    >
                        <div class="ag-stack-v">
                            <FormField label="自定义工具说明覆盖（留空则使用默认说明）">
                                <TextInput
                                    value={setting.description ?? ''}
                                    placeholder={activeBuiltinTool.description}
                                    onInput={(description) =>
                                        mutatePreset((preset) => ({
                                            ...preset,
                                            builtinToolSettings: {
                                                ...(preset.builtinToolSettings ?? {}),
                                                [activeBuiltinTool.name]: {
                                                    ...setting,
                                                    description: description || undefined,
                                                },
                                            },
                                        }))
                                    }
                                />
                            </FormField>

                            <div>
                                <div class="ag-field-label" style={{ marginBottom: '6px' }}>
                                    标准化参数 Schema (Deterministic JSON Schema)
                                </div>
                                <pre class="ag-pre">{builtinSchemaJson}</pre>
                            </div>
                        </div>
                    </Card>

                    {sandboxTestCard}
                </div>
            </div>
        );
    } else if (activeWiTool) {
        detailPane = (
            <div class="ag-view-scroll ag-thin-scroll">
                <div class="ag-stack-v">
                    <Card
                        title={activeWiTool.entry.comment || activeWiTool.slug}
                        subtitle={`世界书来源：${activeWiTool.vfsPath}`}
                        actions={
                            <Button
                                size="sm"
                                variant="primary"
                                icon={<IconPlus size={14} />}
                                onClick={() => {
                                    const id = allocateUniqueId(
                                        `wi_${activeWiTool.slug}`,
                                        activePreset.customTools.map((t) => t.id),
                                        'wi_tool',
                                    );
                                    const created: CustomToolConfig = {
                                        id,
                                        name: activeWiTool.slug,
                                        kind: 'js',
                                        description: activeWiTool.entry.comment || activeWiTool.slug,
                                        enabled: true,
                                        allowNetwork: true,
                                        code: activeWiTool.cleanContent,
                                    };
                                    mutatePreset((preset) => ({
                                        ...preset,
                                        customTools: [...preset.customTools, created],
                                    }));
                                    setSelection({ kind: 'custom', id: created.id });
                                    store.pushToast(`已导入工具「${created.name}」到当前预设`, 'success');
                                }}
                            >
                                复制到预设进行编辑
                            </Button>
                        }
                    >
                        <CodeEditor
                            label="世界书条目脚本源码"
                            languageHint="javascript"
                            readOnly
                            rows={10}
                            minHeight="200px"
                            showToolbar={false}
                            value={activeWiTool.cleanContent}
                            onChange={() => {}}
                        />
                    </Card>
                    {sandboxTestCard}
                </div>
            </div>
        );
    } else {
        detailPane = (
            <EmptyState
                icon={<IconWrench size={22} />}
                title="请选择左侧工具或脚本"
            />
        );
    }

    return (
        <MasterDetailLayout
            master={masterPane}
            detail={detailPane}
            detailOpen={detailOpen}
            onDetailOpenChange={setDetailOpen}
            detailTitle={
                activeCustomTool?.name
                ?? activeScriptRule?.label
                ?? activeBuiltinTool?.name
                ?? activeWiTool?.slug
                ?? '工具与脚本详情'
            }
            isMobile={isMobile}
            emptyDetailTitle="请选择左侧工具"
        />
    );
}
