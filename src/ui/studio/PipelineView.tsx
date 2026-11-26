import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { resolveActivePreset } from '@/core/config';
import { buildWorldInfoTriggerRuleId } from '@/core/triggers';
import type {
    BarrierPolicy,
    ClassifiedLoreEntry,
    PipelinePhase,
    TriggerCondition,
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
    IconGitBranch,
    IconPlay,
    IconPlus,
    IconRefresh,
    IconTrash,
} from '@/ui/components/Icons';
import {
    type ConsoleViewProps,
    useAppStore,
    useAppStoreInstance,
} from '@/ui/store';
import { PresetManagerPanel } from './PresetManagerPanel';
import {
    allocateUniqueId,
    useDraftNumber,
    useDraftString,
    useDraftTagList,
    withUpdatedTrigger,
} from './studio-helpers';

const PIPELINE_PHASES: readonly {
    id: PipelinePhase;
    title: string;
    subtitle: string;
}[] = [
    { id: 'before_turn', title: 'Phase 1: Before Turn', subtitle: '前置推演 & @@*_before' },
    { id: 'main_turn', title: 'Phase 2: Main Turn', subtitle: '主叙事生成通道 (流式)' },
    { id: 'after_turn', title: 'Phase 3: After Turn', subtitle: '后置变量 / 摘要 / 媒体异步' },
    { id: 'maintenance', title: 'Phase 4: Maintenance', subtitle: '高低水位线分块压缩维护' },
];

const TRIGGER_DECORATOR_PREFIXES = [
    '@@trigger',
    '@@script',
    '@@replace',
    '@@variables',
    '@@append_output',
    '@@replace_output',
    '@@evaluate_ejs',
];

function isPipelineLoreEntry(item: ClassifiedLoreEntry): boolean {
    return item.decorators.some((d) =>
        TRIGGER_DECORATOR_PREFIXES.some((prefix) => d.name.startsWith(prefix)),
    );
}

function inferRuleFromLoreEntry(
    item: ClassifiedLoreEntry,
    defaultAgentId: string,
): TriggerRule {
    const primary =
        item.decorators.find((d) =>
            TRIGGER_DECORATOR_PREFIXES.some((prefix) => d.name.startsWith(prefix)),
        ) ?? item.decorators[0];
    const batchOrderDec = item.decorators.find((d) => d.name === '@@batch_order');
    const groupDec = item.decorators.find((d) => d.name === '@@group');

    const decName = primary?.name ?? '@@trigger';
    const params = primary?.params ?? {};
    const phaseRaw = (params.phase ?? '').toLowerCase();

    let phase: PipelinePhase = decName.endsWith('_before') ? 'before_turn' : 'after_turn';
    if (phaseRaw === 'before' || phaseRaw === 'before_turn') {
        phase = 'before_turn';
    } else if (phaseRaw === 'main' || phaseRaw === 'main_turn') {
        phase = 'main_turn';
    } else if (phaseRaw === 'maintenance') {
        phase = 'maintenance';
    } else if (phaseRaw === 'after' || phaseRaw === 'after_turn') {
        phase = 'after_turn';
    }

    let barrier: BarrierPolicy = phase === 'before_turn' ? 'turn' : 'self';
    if (decName.startsWith('@@variables')) {
        barrier = 'turn';
    }
    if (params.barrier === 'turn' || params.barrier === 'self' || params.barrier === 'none') {
        barrier = params.barrier;
    }

    const orderNum = Number(params.order ?? batchOrderDec?.args[0] ?? 1);
    const order = Number.isFinite(orderNum) ? Math.trunc(orderNum) : 1;

    const rawGroup = (params.group ?? groupDec?.args[0] ?? groupDec?.rawArgs ?? '').trim();
    const forceIsolate = ['none', 'isolate', 'off', 'false'].includes(rawGroup.toLowerCase());
    const tag = primary?.args[0]?.trim() ?? '';
    const inferredGroupName = forceIsolate
        ? undefined
        : rawGroup
            ? rawGroup
            : decName.startsWith('@@variables')
                ? (tag ? `variables:${tag}` : 'variables')
                : undefined;

    const jsonSchemaDec = item.decorators.find((d) => d.name === '@@json_schema');
    const zodSchemaDec = item.decorators.find((d) => d.name === '@@zod_schema');

    const sourceWorld = item.entry.world?.trim() || undefined;
    return {
        id: buildWorldInfoTriggerRuleId(item.entry.world, item.entry.uid),
        label: item.entry.comment?.trim() || `${decName} (${item.slug})`,
        source: 'worldinfo',
        ...(sourceWorld ? { sourceWorld } : {}),
        ...(typeof item.entry.uid === 'number' && Number.isFinite(item.entry.uid)
            ? { sourceEntryUid: item.entry.uid }
            : {}),
        phase,
        order,
        barrier,
        agentProfileId: params.profile?.trim() || defaultAgentId,
        kind: decName === '@@script' || decName.startsWith('@@evaluate_ejs') ? 'script' : 'agent',
        tag,
        ...(inferredGroupName ? { groupName: inferredGroupName } : {}),
        condition: { type: 'always' },
        instructionTemplate: item.cleanContent,
        decorator: decName,
        targetPath: decName.startsWith('@@variables') ? '/state/variables.json' : item.vfsPath,
        ...(jsonSchemaDec
            ? { schemaSource: { kind: 'json', raw: jsonSchemaDec.rawArgs } }
            : zodSchemaDec
                ? { schemaSource: { kind: 'zod', raw: zodSchemaDec.rawArgs } }
                : {}),
        ...(decName === '@@script' ? { scriptCode: item.cleanContent } : {}),
        enabled: !item.entry.disable,
    };
}

function barrierTone(barrier: BarrierPolicy): 'error' | 'warning' | 'primary' {
    if (barrier === 'turn') {
        return 'error';
    }
    if (barrier === 'self') {
        return 'warning';
    }
    return 'primary';
}

function conditionSummary(condition: TriggerCondition): string {
    switch (condition.type) {
        case 'interval':
            return `每 ${condition.interval ?? 1} 轮`;
        case 'regex':
            return `正则 ${condition.pattern || '(空)'}`;
        case 'keyword':
            return `关键词 ${(condition.keys ?? []).join(', ') || '(空)'}`;
        case 'js_predicate':
            return 'JS 条件表达式';
        default:
            return 'always (每轮触发)';
    }
}

type PipelineSelection =
    | { kind: 'preset_rule'; ruleId: string }
    | { kind: 'scanned_wi'; vfsPath: string };

/**
 * View ⑤: 4-Phase Trigger Pipeline (`tabId: 'pipeline'`).
 * Merges preset `TriggerRule`s and scanned WI `@@` decorator entries across
 * `before_turn`, `main_turn`, `after_turn`, and `maintenance` swimlanes.
 */
export function PipelineView(props: Partial<ConsoleViewProps> = {}) {
    const ctxStore = useAppStoreInstance();
    const detectedMobile = useIsMobileViewport();
    const store = props.store ?? ctxStore;
    const isMobile = props.isMobile ?? detectedMobile;

    const settings = useAppStore((s) => s.settings);
    const activeTarget = useAppStore((s) => s.activeTarget);
    const activePreset = resolveActivePreset(settings);

    const [loreEntries, setLoreEntries] = useState<ClassifiedLoreEntry[]>([]);
    const [scanningLore, setScanningLore] = useState(false);
    const [selection, setSelection] = useState<PipelineSelection | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [runningRuleId, setRunningRuleId] = useState<string | null>(null);

    const hasValidTarget =
        Number.isInteger(activeTarget.messageId)
        && activeTarget.messageId >= 0
        && Number.isInteger(activeTarget.swipeId)
        && activeTarget.swipeId >= 0;
    const targetLabel = hasValidTarget
        ? `#${activeTarget.messageId}#${activeTarget.swipeId}`
        : '无楼层';

    const refreshLoreScan = useCallback(async () => {
        try {
            setScanningLore(true);
            const res = await store.services.listClassifiedLoreEntries(
                activePreset.wiRouterOverrides,
            );
            setLoreEntries(res.entries.filter(isPipelineLoreEntry));
        } catch {
            setLoreEntries([]);
        } finally {
            setScanningLore(false);
        }
    }, [activePreset.wiRouterOverrides, store.services]);

    useEffect(() => {
        void refreshLoreScan();
    }, [refreshLoreScan]);

    const scannedVirtualEntries = useMemo(() => {
        const existingIds = new Set(activePreset.triggers.map((t) => t.id));
        const importedWorldUids = new Set<string>();
        for (const rule of activePreset.triggers) {
            if (rule.source === 'worldinfo' && rule.sourceWorld && rule.sourceEntryUid !== undefined) {
                importedWorldUids.add(`${rule.sourceWorld}::${rule.sourceEntryUid}`);
            }
        }
        return loreEntries
            .map((entry) => ({
                lore: entry,
                inferred: inferRuleFromLoreEntry(entry, activePreset.mainAgentId),
            }))
            .filter(({ lore, inferred }) => {
                if (existingIds.has(inferred.id)) {
                    return false;
                }
                if (existingIds.has(`wi:${lore.entry.world}:${lore.entry.uid}`)) {
                    return false;
                }
                if (importedWorldUids.has(`${lore.entry.world}::${lore.entry.uid}`)) {
                    return false;
                }
                return true;
            });
    }, [activePreset.mainAgentId, activePreset.triggers, loreEntries]);

    useEffect(() => {
        if (!selection) {
            if (activePreset.triggers.length > 0) {
                setSelection({ kind: 'preset_rule', ruleId: activePreset.triggers[0].id });
            } else if (scannedVirtualEntries.length > 0) {
                setSelection({
                    kind: 'scanned_wi',
                    vfsPath: scannedVirtualEntries[0].lore.vfsPath,
                });
            }
            return;
        }
        if (
            selection.kind === 'preset_rule'
            && !activePreset.triggers.some((t) => t.id === selection.ruleId)
        ) {
            if (activePreset.triggers.length > 0) {
                setSelection({ kind: 'preset_rule', ruleId: activePreset.triggers[0].id });
            } else if (scannedVirtualEntries.length > 0) {
                setSelection({
                    kind: 'scanned_wi',
                    vfsPath: scannedVirtualEntries[0].lore.vfsPath,
                });
            } else {
                setSelection(null);
            }
        }
    }, [activePreset.triggers, scannedVirtualEntries, selection]);

    const activePresetRule: TriggerRule | undefined =
        selection?.kind === 'preset_rule'
            ? activePreset.triggers.find((t) => t.id === selection.ruleId)
            : undefined;

    const activeScannedItem =
        selection?.kind === 'scanned_wi'
            ? scannedVirtualEntries.find((item) => item.lore.vfsPath === selection.vfsPath)
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

    const mutateActiveRule = (updater: (rule: TriggerRule) => TriggerRule) => {
        if (!activePresetRule) {
            return;
        }
        mutatePreset((preset) => ({
            ...preset,
            triggers: withUpdatedTrigger(preset.triggers, activePresetRule.id, updater),
        }));
    };

    const ruleResetKey = `${activePreset.id}:${activePresetRule?.id ?? ''}`;
    const labelDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.label ?? '',
        (label) => mutateActiveRule((r) => ({ ...r, label })),
        { allowEmpty: false },
    );
    const orderDraft = useDraftNumber(
        ruleResetKey,
        activePresetRule?.order ?? 1,
        (order) => mutateActiveRule((r) => ({ ...r, order })),
        { min: -1_000_000, max: 1_000_000, integer: true },
    );
    const tagDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.tag ?? '',
        (tag) => mutateActiveRule((r) => ({ ...r, tag })),
        { allowEmpty: true },
    );
    const groupDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.groupName ?? '',
        (groupName) => mutateActiveRule((r) => ({ ...r, groupName: groupName.trim() || undefined })),
        { allowEmpty: true },
    );
    const targetPathDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.targetPath ?? '',
        (targetPath) => mutateActiveRule((r) => ({ ...r, targetPath: targetPath.trim() || undefined })),
        { allowEmpty: true },
    );
    const instructionDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.instructionTemplate ?? '',
        (instructionTemplate) => mutateActiveRule((r) => ({ ...r, instructionTemplate })),
        { allowEmpty: true },
    );
    const scriptCodeDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.scriptCode ?? '',
        (scriptCode) => mutateActiveRule((r) => ({ ...r, scriptCode })),
        { allowEmpty: true },
    );
    const intervalDraft = useDraftNumber(
        ruleResetKey,
        activePresetRule?.condition.interval ?? 2,
        (interval) =>
            mutateActiveRule((r) => ({
                ...r,
                condition: { ...r.condition, interval },
            })),
        { min: 1, max: 10000, integer: true },
    );
    const regexPatternDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.condition.pattern ?? '',
        (pattern) =>
            mutateActiveRule((r) => ({
                ...r,
                condition: { ...r.condition, pattern },
            })),
        { allowEmpty: true },
    );
    const keysDraft = useDraftTagList(
        ruleResetKey,
        activePresetRule?.condition.keys ?? [],
        (keys) =>
            mutateActiveRule((r) => ({
                ...r,
                condition: {
                    ...r.condition,
                    keys,
                },
            })),
    );
    const predicateDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.condition.predicateCode ?? '',
        (predicateCode) =>
            mutateActiveRule((r) => ({
                ...r,
                condition: { ...r.condition, predicateCode },
            })),
        { allowEmpty: true },
    );
    const schemaRawDraft = useDraftString(
        ruleResetKey,
        activePresetRule?.schemaSource?.raw ?? '',
        (raw) =>
            mutateActiveRule((r) => ({
                ...r,
                schemaSource: {
                    kind: r.schemaSource?.kind ?? 'json',
                    raw,
                },
            })),
        { allowEmpty: true },
    );

    const agentOptions = useMemo(
        () =>
            Object.values(activePreset.agents).map((ag) => ({
                value: ag.id,
                label: `${ag.name} (${ag.sessionMode})`,
            })),
        [activePreset.agents],
    );

    const handleAddRule = (phase: PipelinePhase = 'after_turn') => {
        const id = allocateUniqueId(
            `trigger_${phase}`,
            activePreset.triggers.map((t) => t.id),
            'trigger',
        );
        const phaseRules = activePreset.triggers.filter((t) => t.phase === phase);
        const nextOrder =
            phaseRules.length > 0
                ? Math.max(...phaseRules.map((t) => t.order)) + 1
                : 1;
        const created: TriggerRule = {
            id,
            label: `新触发规则 (${phase})`,
            source: 'preset',
            phase,
            order: nextOrder,
            barrier: phase === 'before_turn' ? 'turn' : 'self',
            agentProfileId: activePreset.mainAgentId,
            kind: 'agent',
            decorator: '@@trigger',
            condition: { type: 'always' },
            instructionTemplate: '请根据本轮最新对话执行对应后台更新任务。',
            enabled: true,
        };
        mutatePreset((preset) => ({
            ...preset,
            triggers: [...preset.triggers, created],
        }));
        setSelection({ kind: 'preset_rule', ruleId: created.id });
        if (isMobile) {
            setDetailOpen(true);
        }
        store.pushToast(`已添加触发规则：${created.label}`, 'success');
    };

    const handleImportScannedRule = (inferred: TriggerRule) => {
        mutatePreset((preset) => ({
            ...preset,
            triggers: [...preset.triggers, inferred],
        }));
        setSelection({ kind: 'preset_rule', ruleId: inferred.id });
        store.pushToast(`已将世界书条目「${inferred.label}」导入预设管线进行编辑`, 'success');
    };

    const handleDeleteRule = (rule: TriggerRule) => {
        store.openModal({
            kind: 'confirm',
            title: '删除触发规则确认',
            message: `确定从预设「${activePreset.name}」删除触发规则「${rule.label}」吗？`,
            confirmLabel: '确认删除',
            tone: 'danger',
            onConfirm: () => {
                mutatePreset((preset) => ({
                    ...preset,
                    triggers: preset.triggers.filter((t) => t.id !== rule.id),
                }));
                setSelection(null);
                setDetailOpen(false);
                store.pushToast(`已删除触发规则：${rule.label}`, 'warning');
            },
        });
    };

    const handleRunRule = async (rule: TriggerRule) => {
        if (runningRuleId !== null || rule.phase !== 'after_turn' || !hasValidTarget) {
            return;
        }
        const target = { ...activeTarget };
        const prevRunIds = new Set(store.getSnapshot().traces.map((t) => t.runId));
        setRunningRuleId(rule.id);
        try {
            await store.rerunAfterTurn(target, {
                triggerIds: [rule.id],
                force: true,
                label: rule.label,
                silentToast: true,
            });
            await store.refreshTraces().catch(() => {});
            const newestTrace = store
                .getSnapshot()
                .traces.find(
                    (t) =>
                        !prevRunIds.has(t.runId)
                        && t.target.messageId === target.messageId
                        && t.target.swipeId === target.swipeId
                        && t.phase === 'after_turn',
                );
            const action = {
                label: '查看日志',
                onClick: () =>
                    store.openConsole('logs', {
                        messageId: target.messageId,
                        swipeId: target.swipeId,
                        ...(newestTrace ? { logId: newestTrace.runId } : {}),
                    }),
            };
            if (newestTrace?.status === 'error') {
                store.pushToast(
                    `触发器「${rule.label}」在 ${targetLabel} 执行失败：${newestTrace.error || '请查看日志'}`,
                    'error',
                    5000,
                    action,
                );
            } else if (newestTrace) {
                store.pushToast(
                    `已在 ${targetLabel} 运行触发器「${rule.label}」`,
                    'success',
                    5000,
                    action,
                );
            } else {
                store.pushToast(
                    `已派发 ${targetLabel} 的后置触发：${rule.label}`,
                    'primary',
                    5000,
                    action,
                );
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            store.pushToast(`运行触发器失败：${msg}`, 'error');
        } finally {
            setRunningRuleId((prev) => (prev === rule.id ? null : prev));
        }
    };

    const masterPane = (
        <div class="ag-stack-v" style={{ padding: '10px' }}>
            <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--muted-foreground)' }}>
                    四阶段调度泳道
                </span>
                <div class="ag-row-wrap">
                    <Button
                        size="sm"
                        variant="secondary"
                        loading={scanningLore}
                        icon={<IconRefresh size={14} />}
                        onClick={() => void refreshLoreScan()}
                    >
                        扫描 WI
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        icon={<IconPlus size={14} />}
                        onClick={() => handleAddRule('after_turn')}
                    >
                        新增规则
                    </Button>
                </div>
            </div>

            {PIPELINE_PHASES.map((phaseMeta) => {
                const presetItems = activePreset.triggers
                    .filter((t) => t.phase === phaseMeta.id)
                    .map((rule) => ({
                        kind: 'preset_rule' as const,
                        key: rule.id,
                        order: rule.order,
                        rule,
                    }));
                const wiItems = scannedVirtualEntries
                    .filter(({ inferred }) => inferred.phase === phaseMeta.id)
                    .map(({ lore, inferred }) => ({
                        kind: 'scanned_wi' as const,
                        key: lore.vfsPath,
                        order: inferred.order,
                        lore,
                        rule: inferred,
                    }));

                const combined = [...presetItems, ...wiItems].sort(
                    (a, b) => a.order - b.order || a.rule.label.localeCompare(b.rule.label),
                );

                return (
                    <div
                        key={phaseMeta.id}
                        style={{
                            border: '1px solid var(--border)',
                            borderRadius: '10px',
                            background: 'var(--card)',
                            padding: '8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                            minWidth: 0,
                        }}
                    >
                        <div class="ag-row-wrap" style={{ justifyContent: 'space-between' }}>
                            <div>
                                <div style={{ fontSize: '12px', fontWeight: 700 }}>{phaseMeta.title}</div>
                                <div class="ag-field-hint">{phaseMeta.subtitle}</div>
                            </div>
                            <Button
                                size="sm"
                                variant="ghost"
                                ariaLabel={`在 ${phaseMeta.title} 新增规则`}
                                icon={<IconPlus size={13} />}
                                onClick={() => handleAddRule(phaseMeta.id)}
                            />
                        </div>

                        {combined.length === 0 ? (
                            <div class="ag-field-hint" style={{ padding: '4px 2px' }}>
                                该阶段暂无规则
                            </div>
                        ) : (
                            <div class="ag-stack-v" style={{ gap: '6px' }}>
                                {combined.map((entry) => {
                                    const isSelected =
                                        (entry.kind === 'preset_rule'
                                            && selection?.kind === 'preset_rule'
                                            && selection.ruleId === entry.rule.id)
                                        || (entry.kind === 'scanned_wi'
                                            && selection?.kind === 'scanned_wi'
                                            && selection.vfsPath === entry.key);
                                    const r = entry.rule;
                                    return (
                                        <button
                                            key={entry.key}
                                            type="button"
                                            class={
                                                isSelected && !isMobile
                                                    ? 'ag-list-item ag-list-item-active'
                                                    : 'ag-list-item'
                                            }
                                            style={{
                                                opacity: r.enabled ? 1 : 0.55,
                                                minHeight: '48px',
                                            }}
                                            onClick={() => {
                                                if (entry.kind === 'preset_rule') {
                                                    setSelection({
                                                        kind: 'preset_rule',
                                                        ruleId: r.id,
                                                    });
                                                } else {
                                                    setSelection({
                                                        kind: 'scanned_wi',
                                                        vfsPath: entry.key,
                                                    });
                                                }
                                                if (isMobile) {
                                                    setDetailOpen(true);
                                                }
                                            }}
                                        >
                                            <div
                                                class="ag-row-wrap"
                                                style={{ justifyContent: 'space-between', width: '100%' }}
                                            >
                                                <span class="ag-list-item-title">
                                                    #{r.order} · {r.label}
                                                </span>
                                                <Badge tone={barrierTone(r.barrier)}>
                                                    {r.barrier}
                                                </Badge>
                                            </div>
                                            <div class="ag-list-item-meta">
                                                <span>
                                                    {entry.kind === 'scanned_wi'
                                                        ? '世界书 @@ (实时扫描)'
                                                        : r.source === 'worldinfo'
                                                            ? '世界书 @@ (已导入)'
                                                            : '预设规则'}
                                                    {r.groupName ? ` · @@group ${r.groupName}` : ''}
                                                </span>
                                                <span>{conditionSummary(r.condition)}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );

    const detailPane = activePresetRule ? (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={
                        <span class="ag-row-wrap">
                            <span>{activePresetRule.label}</span>
                            <Badge tone={barrierTone(activePresetRule.barrier)}>
                                barrier: {activePresetRule.barrier}
                            </Badge>
                            {activePresetRule.decorator ? (
                                <Badge tone="primary" className="ag-mono">
                                    {activePresetRule.decorator}
                                </Badge>
                            ) : null}
                        </span>
                    }
                    subtitle={`ID: ${activePresetRule.id} · 来源：${
                        activePresetRule.source === 'worldinfo' ? '世界书规则' : '预设内建规则'
                    }`}
                    actions={
                        <div class="ag-row-wrap">
                            <ToggleSwitch
                                checked={activePresetRule.enabled}
                                onChange={(enabled) =>
                                    mutateActiveRule((r) => ({ ...r, enabled }))
                                }
                                label={activePresetRule.enabled ? '已启用' : '已停用'}
                            />
                            <Button
                                size="sm"
                                variant="primary"
                                className="ag-pipeline-run-btn"
                                icon={<IconPlay size={14} />}
                                loading={runningRuleId === activePresetRule.id}
                                disabled={
                                    runningRuleId !== null
                                    || activePresetRule.phase !== 'after_turn'
                                    || !hasValidTarget
                                }
                                title={
                                    activePresetRule.phase !== 'after_turn'
                                        ? '仅支持手动运行后置触发（after_turn）'
                                        : !hasValidTarget
                                            ? '当前会话暂无可作用的楼层'
                                            : `在当前楼层 ${targetLabel} 手动强制运行一次此触发器（忽略条件与停用状态）`
                                }
                                onClick={() => void handleRunRule(activePresetRule)}
                            >
                                {runningRuleId === activePresetRule.id
                                    ? '运行中...'
                                    : `立即运行 (${targetLabel})`}
                            </Button>
                            <Button
                                size="sm"
                                variant="danger"
                                icon={<IconTrash size={14} />}
                                ariaLabel={`删除规则 ${activePresetRule.label}`}
                                title="删除此触发规则"
                                onClick={() => handleDeleteRule(activePresetRule)}
                            />
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-grid-2">
                            <FormField label="规则名称 (label)" required>
                                <TextInput
                                    value={labelDraft.value}
                                    onInput={labelDraft.onInput}
                                    onChange={labelDraft.onChange}
                                />
                            </FormField>

                            <FormField label="执行阶段 (phase)">
                                <SelectInput<PipelinePhase>
                                    value={activePresetRule.phase}
                                    options={PIPELINE_PHASES.map((p) => ({
                                        value: p.id,
                                        label: `${p.title} (${p.subtitle})`,
                                    }))}
                                    onChange={(phase) =>
                                        mutateActiveRule((r) => ({ ...r, phase }))
                                    }
                                />
                            </FormField>

                            <FormField
                                label="执行批次顺序 (order)"
                                hint="数值越小越先执行；同 phase + order + groupName 将合并运行"
                            >
                                <TextInput
                                    type="number"
                                    step={1}
                                    value={orderDraft.value}
                                    onInput={orderDraft.onInput}
                                    onChange={orderDraft.onChange}
                                />
                            </FormField>

                            <FormField
                                label="并发屏障策略 (barrier)"
                                hint="turn: 下轮前必等 · self: 仅自身队列串行 · none: 彻底脱离按楼层回填"
                            >
                                <SelectInput<BarrierPolicy>
                                    value={activePresetRule.barrier}
                                    options={[
                                        { value: 'turn', label: 'turn (跨轮强屏障：下轮前必等)' },
                                        { value: 'self', label: 'self (自身队列串行：不挡下轮)' },
                                        { value: 'none', label: 'none (独立后台脱离：按楼层回填)' },
                                    ]}
                                    onChange={(barrier) =>
                                        mutateActiveRule((r) => ({ ...r, barrier }))
                                    }
                                />
                            </FormField>

                            <FormField label="执行方式 (kind)">
                                <SelectInput<'agent' | 'script'>
                                    value={activePresetRule.kind}
                                    options={[
                                        { value: 'agent', label: 'agent (调用智能体工具循环)' },
                                        { value: 'script', label: 'script (0 Token JS 确定性脚本)' },
                                    ]}
                                    onChange={(kind) =>
                                        mutateActiveRule((r) => ({ ...r, kind }))
                                    }
                                />
                            </FormField>

                            <FormField label="绑定执行智能体 (agentProfileId)">
                                <SelectInput
                                    value={activePresetRule.agentProfileId}
                                    options={agentOptions}
                                    onChange={(agentProfileId) =>
                                        mutateActiveRule((r) => ({ ...r, agentProfileId }))
                                    }
                                />
                            </FormField>

                            <FormField
                                label="装饰器标签 (tag)"
                                hint="对应原版 @@<decorator> <tag> 匹配标识"
                            >
                                <TextInput
                                    value={tagDraft.value}
                                    placeholder="例如：好感结算"
                                    onInput={tagDraft.onInput}
                                    onChange={tagDraft.onChange}
                                />
                            </FormField>

                            <FormField
                                label="可选合并组 (groupName / @@group)"
                                hint="留空默认 1 对 1 独立运行；同组同批才合并"
                            >
                                <TextInput
                                    value={groupDraft.value}
                                    placeholder="留空则默认不合并"
                                    onInput={groupDraft.onInput}
                                    onChange={groupDraft.onChange}
                                />
                            </FormField>
                        </div>

                        <FormField
                            label="锁定授权目标路径 (targetPath)"
                            hint="可选：将该条目的 VFS 写入赋权精确锁定到指定文件路径（如 /state/variables.json 或 /memory/outline.md）"
                        >
                            <TextInput
                                className="ag-mono"
                                value={targetPathDraft.value}
                                placeholder="/state/variables.json"
                                onInput={targetPathDraft.onInput}
                                onChange={targetPathDraft.onChange}
                            />
                        </FormField>
                    </div>
                </Card>

                {/* Trigger Condition */}
                <Card title="触发条件 (condition)">
                    <div class="ag-stack-v">
                        <FormField label="条件类型">
                            <SelectInput<TriggerCondition['type']>
                                value={activePresetRule.condition.type}
                                options={[
                                    { value: 'always', label: 'always (每次触发)' },
                                    { value: 'interval', label: 'interval (每隔 N 轮触发)' },
                                    { value: 'regex', label: 'regex (正则匹配本轮输入/输出)' },
                                    { value: 'keyword', label: 'keyword (关键词命中触发)' },
                                    { value: 'js_predicate', label: 'js_predicate (自定义 JS 条件函数)' },
                                ]}
                                onChange={(type) =>
                                    mutateActiveRule((r) => ({
                                        ...r,
                                        condition: {
                                            ...r.condition,
                                            type,
                                            ...(type === 'interval' && !r.condition.interval
                                                ? { interval: 2 }
                                                : {}),
                                        },
                                    }))
                                }
                            />
                        </FormField>

                        {activePresetRule.condition.type === 'interval' ? (
                            <FormField label="轮次间隔 (interval)">
                                <TextInput
                                    type="number"
                                    min={1}
                                    max={10000}
                                    step={1}
                                    value={intervalDraft.value}
                                    onInput={intervalDraft.onInput}
                                    onChange={intervalDraft.onChange}
                                />
                            </FormField>
                        ) : null}

                        {activePresetRule.condition.type === 'regex' ? (
                            <FormField label="触发正则表达式 (pattern)">
                                <TextInput
                                    className="ag-mono"
                                    value={regexPatternDraft.value}
                                    placeholder="/(战斗|突破|重要人物)/"
                                    onInput={regexPatternDraft.onInput}
                                    onChange={regexPatternDraft.onChange}
                                />
                            </FormField>
                        ) : null}

                        {activePresetRule.condition.type === 'keyword' ? (
                            <FormField label="触发关键词列表（逗号分隔）">
                                <TextInput
                                    value={keysDraft.value}
                                    placeholder="银莲花, 玉佩, 密道"
                                    onInput={keysDraft.onInput}
                                    onChange={keysDraft.onChange}
                                />
                            </FormField>
                        ) : null}

                        {activePresetRule.condition.type === 'js_predicate' ? (
                            <CodeEditor
                                label="JS 条件表达式 (返回 boolean)"
                                languageHint="javascript"
                                rows={4}
                                minHeight="100px"
                                value={predicateDraft.value}
                                placeholder="return ctx.vars.get('战斗中') === true;"
                                onChange={predicateDraft.onInput}
                            />
                        ) : null}
                    </div>
                </Card>

                {/* Instruction / Script / Schema */}
                <Card
                    title={
                        activePresetRule.kind === 'script'
                            ? '脚本正文与指令模板'
                            : '触发任务指令模板 (instructionTemplate) & Schema'
                    }
                >
                    <div class="ag-stack-v">
                        <CodeEditor
                            label="指令模板 (instructionTemplate)"
                            languageHint="markdown"
                            rows={5}
                            minHeight="130px"
                            value={instructionDraft.value}
                            onChange={instructionDraft.onInput}
                        />

                        {activePresetRule.kind === 'script' ? (
                            <CodeEditor
                                label="确定性脚本代码 (scriptCode)"
                                languageHint="javascript"
                                rows={6}
                                minHeight="150px"
                                value={scriptCodeDraft.value}
                                placeholder="await ctx.vars.patch({ round: (await ctx.vars.get('round') ?? 0) + 1 });"
                                onChange={scriptCodeDraft.onInput}
                            />
                        ) : null}

                        <FormField label="变量校验 Schema 来源 (schemaSource)">
                            <SelectInput<'none' | 'json' | 'zod'>
                                value={activePresetRule.schemaSource?.kind ?? 'none'}
                                options={[
                                    { value: 'none', label: '不绑定独立 Schema（使用全局或无校验）' },
                                    { value: 'json', label: 'JSON Schema (@@json_schema)' },
                                    { value: 'zod', label: 'Zod Schema (@@zod_schema)' },
                                ]}
                                onChange={(kind) => {
                                    if (kind === 'none') {
                                        mutateActiveRule((r) => {
                                            const next = { ...r };
                                            delete next.schemaSource;
                                            return next;
                                        });
                                    } else {
                                        mutateActiveRule((r) => ({
                                            ...r,
                                            schemaSource: {
                                                kind,
                                                raw: r.schemaSource?.raw ?? '',
                                            },
                                        }));
                                    }
                                }}
                            />
                        </FormField>

                        {activePresetRule.schemaSource ? (
                            <CodeEditor
                                label={
                                    activePresetRule.schemaSource.kind === 'zod'
                                        ? 'Zod Schema 表达式'
                                        : 'JSON Schema 对象'
                                }
                                languageHint={
                                    activePresetRule.schemaSource.kind === 'zod'
                                        ? 'javascript'
                                        : 'json'
                                }
                                rows={5}
                                minHeight="120px"
                                value={schemaRawDraft.value}
                                placeholder={
                                    activePresetRule.schemaSource.kind === 'zod'
                                        ? 'z.object({ hp: z.number().min(0).max(100) })'
                                        : '{"type":"object","properties":{"hp":{"type":"number"}}}'
                                }
                                onChange={schemaRawDraft.onInput}
                            />
                        ) : null}
                    </div>
                </Card>
            </div>
        </div>
    ) : activeScannedItem ? (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={activeScannedItem.inferred.label}
                    subtitle={`扫描自世界书：${activeScannedItem.lore.vfsPath} (UID #${activeScannedItem.lore.entry.uid})`}
                    actions={
                        <div class="ag-row-wrap">
                            <Button
                                size="sm"
                                variant="secondary"
                                className="ag-pipeline-run-btn"
                                icon={<IconPlay size={14} />}
                                loading={runningRuleId === activeScannedItem.inferred.id}
                                disabled={
                                    runningRuleId !== null
                                    || activeScannedItem.inferred.phase !== 'after_turn'
                                    || !hasValidTarget
                                }
                                title={
                                    activeScannedItem.inferred.phase !== 'after_turn'
                                        ? '仅支持手动运行后置触发（after_turn）'
                                        : !hasValidTarget
                                            ? '当前会话暂无可作用的楼层'
                                            : `无需导入预设，直接在当前楼层 ${targetLabel} 强制运行一次此世界书触发器`
                                }
                                onClick={() => void handleRunRule(activeScannedItem.inferred)}
                            >
                                {runningRuleId === activeScannedItem.inferred.id
                                    ? '运行中...'
                                    : `立即运行 (${targetLabel})`}
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                icon={<IconPlus size={14} />}
                                onClick={() => handleImportScannedRule(activeScannedItem.inferred)}
                            >
                                导入为预设可编辑规则
                            </Button>
                        </div>
                    }
                >
                    <div class="ag-stack-v">
                        <div class="ag-banner ag-banner-primary">
                            此规则当前由当前激活世界书的 <span class="ag-mono">@@</span> 装饰器实时扫描推导。点击右上角「导入为预设可编辑规则」可在当前预设中覆写其 phase、order、barrier、条件与绑定 Agent。
                        </div>

                        <div class="ag-row-wrap">
                            <Badge tone="primary">
                                推导阶段：{activeScannedItem.inferred.phase}
                            </Badge>
                            <Badge tone={barrierTone(activeScannedItem.inferred.barrier)}>
                                barrier: {activeScannedItem.inferred.barrier}
                            </Badge>
                            <Badge tone="neutral">
                                order: {activeScannedItem.inferred.order}
                            </Badge>
                            {activeScannedItem.lore.decorators.map((dec, idx) => (
                                <Badge key={`${dec.name}_${idx}`} tone="warning" className="ag-mono">
                                    {dec.name}
                                    {dec.rawArgs ? ` ${dec.rawArgs}` : ''}
                                </Badge>
                            ))}
                        </div>

                        <CodeEditor
                            label="世界书条目正文（去除 @@ 装饰器头）"
                            languageHint="markdown"
                            readOnly
                            rows={8}
                            minHeight="180px"
                            showToolbar={false}
                            value={activeScannedItem.lore.cleanContent}
                            onChange={() => {}}
                        />
                    </div>
                </Card>
            </div>
        </div>
    ) : (
        <EmptyState
            icon={<IconGitBranch size={22} />}
            title="暂无选中触发规则"
            description="在左侧四阶段泳道选择已有规则，或点击「新增规则」创建触发任务。"
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
                onPresetChanged={() => {
                    setSelection(null);
                    setDetailOpen(false);
                }}
            />
            <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }}>
                <MasterDetailLayout
                    master={masterPane}
                    detail={detailPane}
                    detailOpen={detailOpen}
                    onDetailOpenChange={setDetailOpen}
                    detailTitle={
                        activePresetRule?.label
                        ?? activeScannedItem?.inferred.label
                        ?? '触发管线详情'
                    }
                    isMobile={isMobile}
                    emptyDetailTitle="请选择左侧触发规则"
                />
            </div>
        </div>
    );
}
