import { useMemo, useState } from 'preact/hooks';
import {
    BUILTIN_PROMPT_TRIGGER_GROUPS,
    getPromptTriggerDisplay,
} from '@/core/config';
import type { PromptBlock, PromptTriggerType, TriggerRule } from '@/core/types';
import { Button } from '@/ui/components';
import { IconCheck, IconFilter } from '@/ui/components/Icons';

export interface PromptTriggerPickerProps {
    value: readonly PromptTriggerType[];
    onChange: (next: PromptTriggerType[]) => void;
    placement?: PromptBlock['placement'];
    isMainAgent?: boolean;
    presetTriggers?: readonly TriggerRule[];
}

export function PromptTriggerPicker({
    value,
    onChange,
    placement,
    isMainAgent,
    presetTriggers,
}: PromptTriggerPickerProps) {
    const [expanded, setExpanded] = useState(false);

    const selectedSet = useMemo(() => new Set<string>(value), [value]);

    const agentTriggerRules = useMemo(
        () => (presetTriggers ?? []).filter((rule) => rule.kind === 'agent'),
        [presetTriggers],
    );

    const toggleTrigger = (triggerId: PromptTriggerType) => {
        if (selectedSet.has(triggerId)) {
            onChange(value.filter((item) => item !== triggerId));
        } else {
            onChange([...value, triggerId]);
        }
    };

    const hasMainSubAction = value.some(
        (t) =>
            t === 'main_normal'
            || t === 'main_continue'
            || t === 'main_regenerate'
            || t === 'main_swipe',
    );
    const hasOffMainlineTag = value.some(
        (t) => t === 'assistant' || t.startsWith('assistant_') || t === 'sidegen',
    );

    return (
        <div class="ag-trigger-picker">
            <div class="ag-trigger-picker-bar">
                <div class="ag-trigger-picker-chips">
                    {value.length === 0 ? (
                        <span class="ag-trigger-picker-placeholder">
                            未限定 (默认仅对当前智能体生效；选择后仅在匹配模式参与生成)
                        </span>
                    ) : (
                        value.map((tag) => {
                            const display = getPromptTriggerDisplay(tag, presetTriggers);
                            return (
                                <button
                                    key={tag}
                                    type="button"
                                    class={`ag-trigger-chip ag-badge ag-badge-${display.tone}`}
                                    aria-label={`移除触发器 ${display.label}`}
                                    title={`点击移除：${display.label}`}
                                    onClick={() =>
                                        onChange(value.filter((item) => item !== tag))
                                    }
                                >
                                    <span>{display.shortLabel}</span>
                                    <span class="ag-trigger-chip-x" aria-hidden="true">
                                        ×
                                    </span>
                                </button>
                            );
                        })
                    )}
                </div>

                <div class="ag-trigger-picker-actions">
                    {value.length > 0 ? (
                        <Button
                            size="sm"
                            variant="ghost"
                            ariaLabel="清空已选触发器"
                            onClick={() => onChange([])}
                        >
                            清空
                        </Button>
                    ) : null}
                    <Button
                        size="sm"
                        variant="secondary"
                        active={expanded}
                        icon={<IconFilter size={13} />}
                        ariaLabel={expanded ? '收起触发器选择面板' : '展开触发器选择面板'}
                        onClick={() => setExpanded((prev) => !prev)}
                    >
                        {expanded ? '收起' : '选择触发器'}
                    </Button>
                </div>
            </div>

            {expanded ? (
                <div class="ag-trigger-panel" role="group" aria-label="生成触发器筛选列表">
                    {BUILTIN_PROMPT_TRIGGER_GROUPS.map((group) => (
                        <div key={group.id} class="ag-trigger-group">
                            <div class="ag-trigger-group-title">{group.label}</div>
                            <div class="ag-trigger-options">
                                {group.options.map((opt) => {
                                    const active = selectedSet.has(opt.id);
                                    return (
                                        <button
                                            key={opt.id}
                                            type="button"
                                            aria-pressed={active}
                                            title={opt.desc}
                                            class={
                                                active
                                                    ? 'ag-trigger-option ag-trigger-option-active'
                                                    : 'ag-trigger-option'
                                            }
                                            onClick={() => toggleTrigger(opt.id)}
                                        >
                                            <div class="ag-trigger-option-head">
                                                <span class="ag-trigger-option-label">
                                                    {opt.label}
                                                </span>
                                                {active ? (
                                                    <span class="ag-trigger-option-check">
                                                        <IconCheck size={13} />
                                                    </span>
                                                ) : null}
                                            </div>
                                            <div class="ag-trigger-option-desc">{opt.desc}</div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ))}

                    {agentTriggerRules.length > 0 ? (
                        <div class="ag-trigger-group">
                            <div class="ag-trigger-group-title">指定预设触发器</div>
                            <div class="ag-trigger-options">
                                {agentTriggerRules.map((rule) => {
                                    const triggerId: PromptTriggerType = `trigger_rule:${rule.id}`;
                                    const active = selectedSet.has(triggerId);
                                    const meta = `${rule.phase} · ${rule.agentProfileId}${rule.enabled ? '' : ' · 已停用'}`;
                                    return (
                                        <button
                                            key={triggerId}
                                            type="button"
                                            aria-pressed={active}
                                            title={`${rule.label} (${meta})`}
                                            class={
                                                active
                                                    ? 'ag-trigger-option ag-trigger-option-active'
                                                    : 'ag-trigger-option'
                                            }
                                            onClick={() => toggleTrigger(triggerId)}
                                        >
                                            <div class="ag-trigger-option-head">
                                                <span class="ag-trigger-option-label">
                                                    {rule.label}
                                                </span>
                                                {active ? (
                                                    <span class="ag-trigger-option-check">
                                                        <IconCheck size={13} />
                                                    </span>
                                                ) : null}
                                            </div>
                                            <div class="ag-trigger-option-desc">{meta}</div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : null}

            {placement === 'prefix' && hasMainSubAction ? (
                <div class="ag-field-hint" style={{ color: 'var(--warning)' }}>
                    提示：按主生成细分动作（普通/继续/重生成/Swipe）筛选时，建议将注入位置设为 Layer 2 Tail 以保持 Layer 0 静态前缀缓存不变。
                </div>
            ) : null}

            {isMainAgent === false && hasOffMainlineTag ? (
                <div class="ag-field-hint">
                    提示：助手工作台与 SideGen 当前仅从预设的「主叙事 Agent」提示词列表读取匹配条目。
                </div>
            ) : null}
        </div>
    );
}
