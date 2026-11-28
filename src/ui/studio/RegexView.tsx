import type { TargetedEvent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    isPlainRecord,
    normalizeRegexRule,
    resolveActivePreset,
} from '@/core/config';
import {
    applyRegexRulesWithReport,
    compileRegexPattern,
    type CompiledRegexResult,
    type RegexSender,
    shouldApplyRegexRule,
    testRegexRule,
} from '@/core/regex';
import type { RegexRule, RegexStage } from '@/core/types';
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
    TextAreaInput,
    TextInput,
    ToggleSwitch,
    useIsMobileViewport,
} from '@/ui/components';
import {
    IconArrowDown,
    IconArrowUp,
    IconCopy,
    IconExport,
    IconFilter,
    IconImport,
    IconPlus,
    IconTrash,
} from '@/ui/components/Icons';
import {
    type ConsoleViewProps,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import {
    allocateUniqueId,
    copyTextToClipboard,
    downloadTextFile,
    moveArrayItem,
    useDraftString,
} from './studio-helpers';

const DEFAULT_SAMPLE_TEXT = `<think>
用户正在调查井沿刻痕，应先读取银莲花设定。
</think>
夜风穿过竹梢，石井边缘浮现半枚银莲花印记。
<!-- status: {"hp":84,"location":"听竹小筑"} -->`;

interface HighlightSegment {
    text: string;
    isMatch: boolean;
}

function collectHighlightSegments(
    sample: string,
    compiled: CompiledRegexResult,
): { segments: HighlightSegment[]; matchCount: number } {
    if (!compiled.ok || !compiled.regex || !sample) {
        return { segments: [{ text: sample, isMatch: false }], matchCount: 0 };
    }
    try {
        const flags = compiled.regex.flags.includes('g')
            ? compiled.regex.flags
            : `${compiled.regex.flags}g`;
        const globalRe = new RegExp(compiled.regex.source, flags);
        const segments: HighlightSegment[] = [];
        let lastIdx = 0;
        let matchCount = 0;
        let match: RegExpExecArray | null;

        while ((match = globalRe.exec(sample)) !== null && matchCount < 200) {
            const start = match.index;
            const len = match[0].length;
            if (len === 0) {
                if (globalRe.lastIndex >= sample.length) {
                    break;
                }
                globalRe.lastIndex += 1;
                continue;
            }
            if (start > lastIdx) {
                segments.push({ text: sample.slice(lastIdx, start), isMatch: false });
            }
            segments.push({ text: match[0], isMatch: true });
            lastIdx = start + len;
            matchCount += 1;
            if (!compiled.regex.global) {
                break;
            }
        }
        if (lastIdx < sample.length) {
            segments.push({ text: sample.slice(lastIdx), isMatch: false });
        }
        if (segments.length === 0) {
            segments.push({ text: sample, isMatch: false });
        }
        return { segments, matchCount };
    } catch {
        return { segments: [{ text: sample, isMatch: false }], matchCount: 0 };
    }
}

function stageTone(stage: RegexStage): 'success' | 'primary' | 'warning' {
    if (stage === 'display') {
        return 'success';
    }
    if (stage === 'ingest') {
        return 'primary';
    }
    return 'warning';
}

function stageLabel(stage: RegexStage): string {
    if (stage === 'display') {
        return 'display (展示美化)';
    }
    if (stage === 'ingest') {
        return 'ingest (入轨固化)';
    }
    return 'lore_read (世界书读取)';
}

interface RegexLiveComparisonProps {
    rule: RegexRule;
    allRules: readonly RegexRule[];
    sampleText: string;
    sender: RegexSender;
    previewMode: 'single' | 'stage_pipeline';
}

function RegexLiveComparison({
    rule,
    allRules,
    sampleText,
    sender,
    previewMode,
}: RegexLiveComparisonProps) {
    const compiled = useMemo(() => compileRegexPattern(rule.pattern), [rule.pattern]);
    const singleResult = useMemo(
        () => testRegexRule({ pattern: rule.pattern, replace: rule.replace }, sampleText),
        [rule.pattern, rule.replace, sampleText],
    );
    const highlights = useMemo(
        () => collectHighlightSegments(sampleText, compiled),
        [compiled, sampleText],
    );

    const wouldRunInPipeline = shouldApplyRegexRule(rule, rule.stage, sender);

    const effectiveRules = useMemo(
        () => allRules.map((item) => (item.id === rule.id ? rule : item)),
        [allRules, rule],
    );

    const pipelineReport = useMemo(() => {
        if (previewMode !== 'stage_pipeline') {
            return null;
        }
        return applyRegexRulesWithReport(sampleText, effectiveRules, {
            stage: rule.stage,
            sender,
        });
    }, [effectiveRules, previewMode, rule.stage, sampleText, sender]);

    const outputText =
        previewMode === 'stage_pipeline' && pipelineReport
            ? pipelineReport.output
            : singleResult.output;

    return (
        <div class="ag-stack-v">
            <div class="ag-row-wrap">
                {!singleResult.valid ? (
                    <Badge tone="error">语法错误：{singleResult.error}</Badge>
                ) : (
                    <Badge tone={singleResult.matched ? 'success' : 'neutral'}>
                        {singleResult.matched
                            ? `命中 ${highlights.matchCount} 处`
                            : '未命中样本'}
                    </Badge>
                )}
                <Badge tone={wouldRunInPipeline ? 'primary' : 'warning'}>
                    {wouldRunInPipeline
                        ? `当前 ${rule.stage} + ${sender} 生效`
                        : `当前 ${rule.stage} + ${sender} 不触发（受启用/发送方开关过滤）`}
                </Badge>
                {compiled.ok && compiled.isLiteral ? (
                    <Badge tone="neutral">纯文本字面匹配</Badge>
                ) : null}
            </div>

            {!singleResult.valid && singleResult.error ? (
                <div class="ag-banner ag-banner-error">
                    正则语法错误：{singleResult.error}
                </div>
            ) : null}

            <div class="ag-grid-2">
                <div style={{ minWidth: 0 }}>
                    <div class="ag-field-label" style={{ marginBottom: '6px' }}>
                        样本命中高亮 (Input Match Highlight)
                    </div>
                    <pre class="ag-pre" style={{ minHeight: '110px' }}>
                        {highlights.segments.map((seg, idx) =>
                            seg.isMatch ? (
                                <mark
                                    key={idx}
                                    style={{
                                        background: 'color-mix(in srgb, var(--warning) 30%, transparent)',
                                        color: 'var(--foreground)',
                                        borderRadius: '3px',
                                        padding: '0 2px',
                                        outline: '1px solid color-mix(in srgb, var(--warning) 55%, transparent)',
                                    }}
                                >
                                    {seg.text}
                                </mark>
                            ) : (
                                <span key={idx}>{seg.text}</span>
                            ),
                        )}
                    </pre>
                </div>

                <div style={{ minWidth: 0 }}>
                    <div class="ag-field-label" style={{ marginBottom: '6px' }}>
                        {previewMode === 'stage_pipeline'
                            ? `阶段管线串联输出 (${rule.stage})`
                            : '单条规则替换后输出 (Replaced Output)'}
                    </div>
                    <pre
                        class="ag-pre"
                        style={{
                            minHeight: '110px',
                            borderColor: singleResult.valid
                                ? 'color-mix(in srgb, var(--success) 40%, var(--border))'
                                : 'color-mix(in srgb, var(--error) 45%, var(--border))',
                        }}
                    >
                        {outputText}
                    </pre>
                </div>
            </div>
        </div>
    );
}

/**
 * View ⑦: Self-Developed Cache-Safe Regex Engine Rules (`tabId: 'regex'`).
 * Manages `preset.regexRules` across `display` / `ingest` / `lore_read` stages with
 * JSON import/export and a focus-preserving live sample replacement comparison pane.
 */
export function RegexView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const activePreset = resolveActivePreset(settings);

    const [selectedRuleId, setSelectedRuleId] = useState<string>(
        activePreset.regexRules[0]?.id ?? '',
    );
    const [detailOpen, setDetailOpen] = useState(false);

    // Live test state kept local so typing in pattern/replace/sample never remounts inputs.
    const [sampleText, setSampleText] = useState(DEFAULT_SAMPLE_TEXT);
    const [sender, setSender] = useState<RegexSender>('assistant');
    const [previewMode, setPreviewMode] = useState<'single' | 'stage_pipeline'>('single');

    // Import/Export modal state inside Shadow DOM
    const [importModalOpen, setImportModalOpen] = useState(false);
    const [importJsonText, setImportJsonText] = useState('');
    const [importMode, setImportMode] = useState<'append' | 'replace'>('append');
    const [importError, setImportError] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!activePreset.regexRules.some((r) => r.id === selectedRuleId)) {
            setSelectedRuleId(activePreset.regexRules[0]?.id ?? '');
        }
    }, [activePreset.regexRules, selectedRuleId]);

    const activeRule: RegexRule | undefined =
        activePreset.regexRules.find((r) => r.id === selectedRuleId)
        ?? activePreset.regexRules[0];

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

    const mutateActiveRule = (updater: (rule: RegexRule) => RegexRule) => {
        if (!activeRule) {
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            regexRules: preset.regexRules.map((r) =>
                r.id === activeRule.id ? updater(r) : r,
            ),
        }));
    };

    const ruleResetKey = `${activePreset.id}:${activeRule?.id ?? ''}`;
    const nameDraft = useDraftString(
        ruleResetKey,
        activeRule?.name ?? '',
        (name) => mutateActiveRule((r) => ({ ...r, name })),
        { allowEmpty: false },
    );
    const patternDraft = useDraftString(
        ruleResetKey,
        activeRule?.pattern ?? '',
        (pattern) => mutateActiveRule((r) => ({ ...r, pattern })),
        { allowEmpty: true },
    );
    const replaceDraft = useDraftString(
        ruleResetKey,
        activeRule?.replace ?? '',
        (replace) => mutateActiveRule((r) => ({ ...r, replace })),
        { allowEmpty: true },
    );

    const handleAddRule = () => {
        const id = allocateUniqueId(
            'regex',
            activePreset.regexRules.map((r) => r.id),
            'regex',
        );
        const created: RegexRule = {
            id,
            name: `新正则规则 ${activePreset.regexRules.length + 1}`,
            pattern: '/<!--([\\s\\S]*?)-->/g',
            replace: '',
            stage: 'display',
            applyToUser: false,
            applyToAssistant: true,
            enabled: true,
        };
        mutatePreset((preset) => ({
            ...preset,
            regexRules: [...preset.regexRules, created],
        }));
        setSelectedRuleId(created.id);
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已添加正则规则：${created.name}`, 'success');
    };

    const handleDeleteRule = (rule: RegexRule) => {
        store.openModal({
            kind: 'confirm',
            title: '删除正则规则确认',
            message: `确定删除正则规则「${rule.name}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => ({
                    ...preset,
                    regexRules: preset.regexRules.filter((r) => r.id !== rule.id),
                }));
                setDetailOpen(false);
                store.pushToast(`已删除正则规则：${rule.name}`, 'warning');
            },
        });
    };

    const handleExportJson = async (copyOnly: boolean) => {
        const json = JSON.stringify(activePreset.regexRules, null, 2);
        if (copyOnly) {
            const ok = await copyTextToClipboard(json);
            store.pushToast(
                ok ? '已复制正则规则列表 JSON' : '剪贴板不可用',
                ok ? 'success' : 'warning',
            );
        } else {
            const safeName = (activePreset.name || 'preset').replace(/[^\w.-]+/g, '_');
            downloadTextFile(`${safeName}_regex_rules.json`, json);
            store.pushToast('已导出正则规则 JSON 文件', 'success');
        }
    };

    const runImportRules = (rawText: string) => {
        try {
            setImportError(null);
            const parsed: unknown = JSON.parse(rawText);
            let rawArray: unknown[] = [];
            if (Array.isArray(parsed)) {
                rawArray = parsed;
            } else if (isPlainRecord(parsed) && Array.isArray(parsed.regexRules)) {
                rawArray = parsed.regexRules;
            } else if (isPlainRecord(parsed) && Array.isArray(parsed.regexs)) {
                rawArray = parsed.regexs;
            } else if (isPlainRecord(parsed) && isPlainRecord(parsed.preset) && Array.isArray(parsed.preset.regexRules)) {
                rawArray = parsed.preset.regexRules;
            } else {
                throw new Error('需要 RegexRule 数组或包含 regexRules 字段的 JSON 对象');
            }

            const existingIds =
                importMode === 'append'
                    ? activePreset.regexRules.map((r) => r.id)
                    : [];
            const usedIds = new Set<string>(existingIds);
            const imported: RegexRule[] = rawArray
                .filter(isPlainRecord)
                .map((item, idx) => {
                    const normalized = normalizeRegexRule(
                        item,
                        `regex_${idx + 1}`,
                        `导入正则 ${idx + 1}`,
                    );
                    const uniqueId = usedIds.has(normalized.id)
                        ? allocateUniqueId(normalized.id, usedIds, 'regex')
                        : normalized.id;
                    usedIds.add(uniqueId);
                    return { ...normalized, id: uniqueId };
                });

            if (imported.length === 0) {
                throw new Error('未在 JSON 中找到有效的正则规则对象');
            }

            mutatePreset((preset) => ({
                ...preset,
                regexRules:
                    importMode === 'replace'
                        ? imported
                        : [...preset.regexRules, ...imported],
            }));
            setSelectedRuleId(imported[0].id);
            setImportModalOpen(false);
            setImportJsonText('');
            store.pushToast(`成功导入 ${imported.length} 条正则规则`, 'success');
        } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
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
            setImportJsonText(content);
            runImportRules(content);
        };
        reader.readAsText(file);
        event.currentTarget.value = '';
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    正则规则 ({activePreset.regexRules.length})
                </span>
                <Button
                    size="sm"
                    variant="primary"
                    icon={<IconPlus size={14} />}
                    onClick={handleAddRule}
                >
                    新增规则
                </Button>
            </div>

            <div class="ag-row-wrap">
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconImport size={14} />}
                    onClick={() => {
                        setImportError(null);
                        setImportModalOpen(true);
                    }}
                >
                    导入 JSON
                </Button>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={<IconExport size={14} />}
                    disabled={activePreset.regexRules.length === 0}
                    onClick={() => void handleExportJson(false)}
                >
                    导出
                </Button>
                <Button
                    size="sm"
                    variant="ghost"
                    icon={<IconCopy size={14} />}
                    disabled={activePreset.regexRules.length === 0}
                    onClick={() => void handleExportJson(true)}
                >
                    复制
                </Button>
            </div>

            <div class="ag-list" style={{ padding: 0 }}>
                {activePreset.regexRules.length === 0 ? (
                    <EmptyState
                        title="暂无正则规则"
                        description="点击上方「新增规则」创建 display / ingest / lore_read 规则。"
                    />
                ) : (
                    activePreset.regexRules.map((rule, index) => {
                        const selected = activeRule?.id === rule.id;
                        return (
                            <button
                                key={rule.id}
                                type="button"
                                class={
                                    selected && !isMobile
                                        ? 'ag-list-item ag-list-item-active'
                                        : 'ag-list-item'
                                }
                                style={{ opacity: rule.enabled ? 1 : 0.55 }}
                                onClick={() => {
                                    setSelectedRuleId(rule.id);
                                    if (isMobile) {
                                        setDetailOpen(true);
                                    }
                                }}
                            >
                                <div class="ag-row-wrap" style={{ justifyContent: 'space-between', width: '100%' }}>
                                    <span class="ag-list-item-title">
                                        #{index + 1} · {rule.name}
                                    </span>
                                    <Badge tone={stageTone(rule.stage)}>{rule.stage}</Badge>
                                </div>
                                <div class="ag-list-item-meta">
                                    <span class="ag-mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {rule.pattern || '(空模式)'}
                                    </span>
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );

    const activeIndex = activeRule
        ? activePreset.regexRules.findIndex((r) => r.id === activeRule.id)
        : -1;

    const effectivePreviewRule: RegexRule | undefined = activeRule
        ? {
            ...activeRule,
            name: nameDraft.value,
            pattern: patternDraft.value,
            replace: replaceDraft.value,
        }
        : undefined;

    const detailPane = activeRule && effectivePreviewRule ? (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={
                        <span class="ag-row-wrap">
                            <span>{activeRule.name}</span>
                            <Badge tone={stageTone(activeRule.stage)}>
                                {stageLabel(activeRule.stage)}
                            </Badge>
                        </span>
                    }
                    subtitle="自研独立正则引擎（无深度回改，100% 守护 Prefix KV Cache）"
                    actions={
                        <div class="ag-row-wrap">
                            <ToggleSwitch
                                checked={activeRule.enabled}
                                onChange={(enabled) =>
                                    mutateActiveRule((r) => ({ ...r, enabled }))
                                }
                                label={activeRule.enabled ? '已启用' : '已停用'}
                            />
                            <Button
                                size="sm"
                                variant="secondary"
                                ariaLabel="上移正则规则"
                                disabled={activeIndex <= 0}
                                icon={<IconArrowUp size={14} />}
                                onClick={() =>
                                    mutatePreset((preset) => ({
                                        ...preset,
                                        regexRules: moveArrayItem(
                                            preset.regexRules,
                                            activeIndex,
                                            activeIndex - 1,
                                        ),
                                    }))
                                }
                            />
                            <Button
                                size="sm"
                                variant="secondary"
                                ariaLabel="下移正则规则"
                                disabled={
                                    activeIndex < 0
                                    || activeIndex >= activePreset.regexRules.length - 1
                                }
                                icon={<IconArrowDown size={14} />}
                                onClick={() =>
                                    mutatePreset((preset) => ({
                                        ...preset,
                                        regexRules: moveArrayItem(
                                            preset.regexRules,
                                            activeIndex,
                                            activeIndex + 1,
                                        ),
                                    }))
                                }
                            />
                            <Button
                                size="sm"
                                variant="danger"
                                icon={<IconTrash size={14} />}
                                onClick={() => handleDeleteRule(activeRule)}
                            >
                                删除
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-2">
                            <FormField label="规则名称" required>
                                <TextInput
                                    id="regex-name-input"
                                    value={nameDraft.value}
                                    onInput={nameDraft.onInput}
                                    onChange={nameDraft.onChange}
                                />
                            </FormField>

                            <FormField
                                label="执行阶段 (缓存安全三档)"
                                hint="display 仅美化 DOM；ingest 入轨固化进轨迹；lore_read 读世界书后清洗"
                            >
                                <SelectInput<RegexStage>
                                    value={activeRule.stage}
                                    options={[
                                        { value: 'display', label: 'display (纯 DOM 美化，不改持久轨)' },
                                        { value: 'ingest', label: 'ingest (入轨一次性清洗并永久固化)' },
                                        { value: 'lore_read', label: 'lore_read (VFS 读世界书后清洗)' },
                                    ]}
                                    onChange={(stage) => {
                                        if (stage === 'lore_read') {
                                            setSender('lore');
                                        } else if (sender === 'lore') {
                                            setSender('assistant');
                                        }
                                        mutateActiveRule((r) => ({ ...r, stage }));
                                    }}
                                />
                            </FormField>

                            <FormField
                                label="查找正则 (/pattern/flags 或纯文本)"
                                hint="支持 /.../gimsuy 语法；不含首尾斜杠则按纯文本字面匹配"
                            >
                                <TextInput
                                    id="regex-pattern-input"
                                    className="ag-mono"
                                    value={patternDraft.value}
                                    placeholder="/<think>([\\s\\S]*?)<\\/think>/g"
                                    onInput={patternDraft.onInput}
                                    onChange={patternDraft.onChange}
                                />
                            </FormField>

                            <FormField
                                label="替换为 (支持 $1, $2, $<name>)"
                                hint="留空即删除匹配片段"
                            >
                                <TextInput
                                    id="regex-replace-input"
                                    className="ag-mono"
                                    value={replaceDraft.value}
                                    placeholder="[思考已折叠: $1]"
                                    onInput={replaceDraft.onInput}
                                    onChange={replaceDraft.onChange}
                                />
                            </FormField>
                        </div>

                        {activeRule.stage !== 'lore_read' ? (
                            <div class="ag-grid-2">
                                <ToggleSwitch
                                    checked={activeRule.applyToUser}
                                    onChange={(applyToUser) =>
                                        mutateActiveRule((r) => ({ ...r, applyToUser }))
                                    }
                                    label="作用于用户消息 (applyToUser)"
                                    description="发送或渲染用户楼层时匹配"
                                />
                                <ToggleSwitch
                                    checked={activeRule.applyToAssistant}
                                    onChange={(applyToAssistant) =>
                                        mutateActiveRule((r) => ({ ...r, applyToAssistant }))
                                    }
                                    label="作用于助手回复 (applyToAssistant)"
                                    description="生成落盘或渲染 AI 回复楼层时匹配"
                                />
                            </div>
                        ) : (
                            <div class="ag-banner ag-banner-warning">
                                <span class="ag-mono">lore_read</span> 阶段专门在 VFS 读取{' '}
                                <span class="ag-mono">/lorebooks/*</span> 完成宏/EJS 求值后执行一次，不受用户/助手发送方开关影响。
                            </div>
                        )}
                    </div>
                </Card>

                {/* Focus-Preserving Live Sample Comparison Pane */}
                <Card
                    title="实时正则替换对比测试（防失焦局部刷新）"
                    subtitle="输入正则表达式、替换文本或测试样本时，光标准确保留在原输入框内"
                    actions={
                        <SegmentedControl<'single' | 'stage_pipeline'>
                            ariaLabel="正则预览模式"
                            value={previewMode}
                            options={[
                                { value: 'single', label: '单条规则测试' },
                                { value: 'stage_pipeline', label: '同阶段串联' },
                            ]}
                            onChange={setPreviewMode}
                        />
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--muted-foreground)' }}>
                                模拟来源 (Sender)
                            </span>
                            <SegmentedControl<RegexSender>
                                ariaLabel="模拟消息来源"
                                value={sender}
                                options={[
                                    { value: 'assistant', label: 'Assistant 回复' },
                                    { value: 'user', label: 'User 输入' },
                                    { value: 'lore', label: 'Lore 世界书' },
                                ]}
                                onChange={setSender}
                            />
                        </div>

                        <FormField label="测试样本文本">
                            <TextAreaInput
                                id="regex-sample-input"
                                className="ag-mono"
                                rows={4}
                                value={sampleText}
                                placeholder="粘贴需要测试的对话或世界书片段..."
                                onInput={setSampleText}
                            />
                        </FormField>

                        <RegexLiveComparison
                            rule={effectivePreviewRule}
                            allRules={activePreset.regexRules}
                            sampleText={sampleText}
                            sender={sender}
                            previewMode={previewMode}
                        />
                    </div>
                </Card>
            </div>
        </div>
    ) : (
        <EmptyState
            icon={<IconFilter size={22} />}
            title="暂无选中正则规则"
            description="在左侧选择一条规则或点击「新增规则」。"
        />
    );

    return (
        <>
            <MasterDetailLayout
                master={masterPane}
                detail={detailPane}
                detailOpen={detailOpen}
                onDetailOpenChange={setDetailOpen}
                detailTitle={activeRule?.name ?? '正则清洗规则'}
                isMobile={isMobile}
                emptyDetailTitle="请选择左侧正则规则"
            />

            <ShadowModal
                open={importModalOpen}
                title="导入正则规则 JSON"
                maxWidth="580px"
                onClose={() => setImportModalOpen(false)}
                footer={
                    <Button variant="secondary" onClick={() => setImportModalOpen(false)}>
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
                        onChange={handleFileSelected}
                    />
                    <FormField label="导入合并方式">
                        <SegmentedControl<'append' | 'replace'>
                            ariaLabel="正则导入方式"
                            value={importMode}
                            options={[
                                { value: 'append', label: '追加到当前规则列表' },
                                { value: 'replace', label: '替换当前规则列表' },
                            ]}
                            onChange={setImportMode}
                        />
                    </FormField>
                    <div class="ag-row-wrap">
                        <Button
                            size="sm"
                            variant="secondary"
                            icon={<IconImport size={14} />}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            选择 JSON 文件
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            disabled={!importJsonText.trim()}
                            onClick={() => runImportRules(importJsonText)}
                        >
                            导入粘贴内容
                        </Button>
                    </div>
                    <CodeEditor
                        label="粘贴 RegexRule[] JSON"
                        languageHint="json"
                        rows={7}
                        minHeight="150px"
                        showToolbar={false}
                        placeholder='[{"name":"...","pattern":"/foo/g","replace":"bar","stage":"display"}]'
                        value={importJsonText}
                        onChange={setImportJsonText}
                    />
                    {importError ? <div class="ag-banner ag-banner-error">{importError}</div> : null}
                </div>
            </ShadowModal>
        </>
    );
}
