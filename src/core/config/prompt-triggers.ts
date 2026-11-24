import type {
    BuiltinPromptTriggerType,
    Preset,
    PromptBlock,
    PromptTriggerContext,
    PromptTriggerType,
    TriggerRule,
} from '../types';

export type PromptTriggerTone = 'primary' | 'success' | 'warning' | 'neutral';

export interface PromptTriggerOption {
    id: BuiltinPromptTriggerType;
    label: string;
    shortLabel: string;
    desc: string;
    tone: PromptTriggerTone;
}

export interface PromptTriggerGroup {
    id: string;
    label: string;
    options: readonly PromptTriggerOption[];
}

export const BUILTIN_PROMPT_TRIGGER_GROUPS: readonly PromptTriggerGroup[] = [
    {
        id: 'main',
        label: '主生成',
        options: [
            {
                id: 'main',
                label: '全部主生成',
                shortLabel: '主生成',
                desc: '主叙事生成通道的所有动作 (普通/继续/重Roll/Swipe)',
                tone: 'primary',
            },
            {
                id: 'main_normal',
                label: '普通发送 (Normal)',
                shortLabel: '主·普通',
                desc: '仅在常规发送用户消息生成时生效',
                tone: 'primary',
            },
            {
                id: 'main_continue',
                label: '继续生成 (Continue)',
                shortLabel: '主·继续',
                desc: '仅在 Continue 续写当前消息时生效',
                tone: 'primary',
            },
            {
                id: 'main_regenerate',
                label: '重新生成 (Regenerate)',
                shortLabel: '主·重生成',
                desc: '仅在 Regenerate 重新生成时生效',
                tone: 'primary',
            },
            {
                id: 'main_swipe',
                label: '切换生成 (Swipe)',
                shortLabel: '主·Swipe',
                desc: '仅在 Swipe 生成新分支回复时生效',
                tone: 'primary',
            },
        ],
    },
    {
        id: 'assistant',
        label: '助手工作台',
        options: [
            {
                id: 'assistant',
                label: '全部工作台模式',
                shortLabel: '工作台',
                desc: '助手工作台所有权限档位均注入此提示词',
                tone: 'success',
            },
            {
                id: 'assistant_chat',
                label: '交流模式 (只读)',
                shortLabel: '助手·交流',
                desc: '仅在助手「交流模式」下参与上下文',
                tone: 'success',
            },
            {
                id: 'assistant_adjust',
                label: '调整模式',
                shortLabel: '助手·调整',
                desc: '仅在助手「调整模式」下参与上下文',
                tone: 'success',
            },
            {
                id: 'assistant_author',
                label: '写卡模式',
                shortLabel: '助手·写卡',
                desc: '仅在助手「写卡模式」下参与上下文',
                tone: 'success',
            },
            {
                id: 'assistant_full',
                label: '完全控制',
                shortLabel: '助手·完全',
                desc: '仅在助手「完全控制」下参与上下文',
                tone: 'success',
            },
            {
                id: 'assistant_admin',
                label: 'ST 全权管家',
                shortLabel: '助手·管家',
                desc: '仅在助手开启「ST 全权管家」时注入',
                tone: 'warning',
            },
        ],
    },
    {
        id: 'triggers_offmain',
        label: '触发器与线外任务',
        options: [
            {
                id: 'trigger',
                label: '全部触发器',
                shortLabel: '触发器',
                desc: '所有阶段与类型的管线/世界书触发器均注入',
                tone: 'warning',
            },
            {
                id: 'trigger_before',
                label: '前置阶段 (before_turn)',
                shortLabel: '前置触发',
                desc: '仅在 before_turn 前置推演触发器运行时生效',
                tone: 'warning',
            },
            {
                id: 'trigger_after',
                label: '后置阶段 (after_turn)',
                shortLabel: '后置触发',
                desc: '仅在 after_turn 后置触发器运行时生效',
                tone: 'warning',
            },
            {
                id: 'trigger_maintenance',
                label: '维护压缩 (maintenance)',
                shortLabel: '维护触发',
                desc: '仅在 maintenance 维护阶段触发器运行时生效',
                tone: 'warning',
            },
            {
                id: 'trigger_variables',
                label: '变量更新 (@@variables)',
                shortLabel: '变量触发',
                desc: '作用于 /state/variables.json 或 @@variables 触发器',
                tone: 'warning',
            },
            {
                id: 'trigger_lore',
                label: '世界书覆写 (@@replace)',
                shortLabel: 'WI触发',
                desc: '作用于 /lorebooks/* 或 @@replace 类触发器',
                tone: 'warning',
            },
            {
                id: 'trigger_output',
                label: '正文修改 (@@*_output)',
                shortLabel: '正文触发',
                desc: '作用于 /output.md 或 @@append_output/@@replace_output',
                tone: 'warning',
            },
            {
                id: 'subagent',
                label: '子智能体 (@@agent)',
                shortLabel: '子智能体',
                desc: '仅在主智能体委派 @@agent 子任务时生效',
                tone: 'neutral',
            },
            {
                id: 'sidegen',
                label: '线外生成 (SideGen)',
                shortLabel: 'SideGen',
                desc: '仅在 SideGen 线外会话或 runOnce 生成时生效',
                tone: 'neutral',
            },
        ],
    },
] as const;

const BUILTIN_TRIGGER_OPTION_MAP = new Map<BuiltinPromptTriggerType, PromptTriggerOption>();
export const VALID_BUILTIN_PROMPT_TRIGGERS = new Set<BuiltinPromptTriggerType>();

for (const group of BUILTIN_PROMPT_TRIGGER_GROUPS) {
    for (const option of group.options) {
        VALID_BUILTIN_PROMPT_TRIGGERS.add(option.id);
        BUILTIN_TRIGGER_OPTION_MAP.set(option.id, option);
    }
}

const ST_NATIVE_TRIGGER_ALIASES: Readonly<Record<string, BuiltinPromptTriggerType>> = {
    normal: 'main_normal',
    continue: 'main_continue',
    regenerate: 'main_regenerate',
    swipe: 'main_swipe',
    quiet: 'trigger',
};

const TRIGGER_RULE_PREFIX = 'trigger_rule:';

/**
 * Normalize raw trigger definitions (including SillyTavern native `injection_trigger`
 * aliases such as `normal`, `continue`, `regenerate`, `swipe`, `quiet`) into canonical
 * deduplicated `PromptTriggerType[]`, or `undefined` when empty.
 */
export function normalizePromptTriggers(raw: unknown): PromptTriggerType[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }

    const seen = new Set<string>();
    const normalized: PromptTriggerType[] = [];

    for (const item of raw) {
        if (typeof item !== 'string') {
            continue;
        }
        const trimmed = item.trim();
        if (!trimmed) {
            continue;
        }

        let resolved: PromptTriggerType | undefined;
        if (trimmed.toLowerCase().startsWith(TRIGGER_RULE_PREFIX)) {
            const ruleId = trimmed.slice(TRIGGER_RULE_PREFIX.length).trim();
            if (ruleId) {
                resolved = `${TRIGGER_RULE_PREFIX}${ruleId}`;
            }
        } else {
            const lower = trimmed.toLowerCase();
            if (VALID_BUILTIN_PROMPT_TRIGGERS.has(lower as BuiltinPromptTriggerType)) {
                resolved = lower as BuiltinPromptTriggerType;
            } else if (ST_NATIVE_TRIGGER_ALIASES[lower]) {
                resolved = ST_NATIVE_TRIGGER_ALIASES[lower];
            }
        }

        if (resolved && !seen.has(resolved)) {
            seen.add(resolved);
            normalized.push(resolved);
        }
    }

    return normalized.length > 0 ? normalized : undefined;
}

/**
 * Expand a runtime `PromptTriggerContext` into the complete set of matching trigger tags.
 */
export function resolveContextTriggerTags(context: PromptTriggerContext): Set<string> {
    const tags = new Set<string>();

    switch (context.kind) {
        case 'main': {
            tags.add('main');
            tags.add(`main_${context.action ?? 'normal'}`);
            break;
        }
        case 'assistant': {
            tags.add('assistant');
            tags.add(`assistant_${context.mode}`);
            if (context.mode === 'full' && context.stAdminEnabled) {
                tags.add('assistant_admin');
            }
            break;
        }
        case 'trigger': {
            tags.add('trigger');
            if (context.phase === 'before_turn') {
                tags.add('trigger_before');
            } else if (context.phase === 'after_turn') {
                tags.add('trigger_after');
            } else if (context.phase === 'maintenance') {
                tags.add('trigger_maintenance');
            } else if (context.phase === 'main_turn') {
                tags.add('main');
            }

            const decorators = (context.decorators ?? [])
                .map((d) => d.trim().toLowerCase())
                .filter(Boolean);
            const targetPaths = (context.targetPaths ?? [])
                .map((p) => p.trim())
                .filter(Boolean);

            if (
                targetPaths.some((p) => p === '/state/variables.json')
                || decorators.some((d) => d.startsWith('@@variables'))
            ) {
                tags.add('trigger_variables');
            }
            if (
                targetPaths.some((p) => p === '/output.md')
                || decorators.some(
                    (d) => d.startsWith('@@append_output') || d.startsWith('@@replace_output'),
                )
            ) {
                tags.add('trigger_output');
            }
            if (
                targetPaths.some((p) => p.startsWith('/lorebooks/'))
                || decorators.some(
                    (d) => d.startsWith('@@replace') && !d.startsWith('@@replace_output'),
                )
            ) {
                tags.add('trigger_lore');
            }

            for (const id of context.triggerIds ?? []) {
                const trimmed = id.trim();
                if (trimmed) {
                    tags.add(`${TRIGGER_RULE_PREFIX}${trimmed}`);
                }
            }
            break;
        }
        case 'subagent': {
            tags.add('subagent');
            break;
        }
        case 'sidegen': {
            tags.add('sidegen');
            break;
        }
    }

    return tags;
}

/**
 * Determine whether a prompt block's `triggers` filter allows participation in `context`.
 * When `triggers` is omitted or empty, returns `true` by default unless `requireExplicit` is set.
 */
export function matchesPromptTriggers(
    triggers: readonly string[] | undefined,
    context?: PromptTriggerContext,
    options?: { requireExplicit?: boolean },
): boolean {
    if (!triggers || triggers.length === 0) {
        return !options?.requireExplicit;
    }
    if (!context) {
        if (options?.requireExplicit) {
            return false;
        }
        const defaultTags = resolveContextTriggerTags({ kind: 'main', action: 'normal' });
        return triggers.some((t) => defaultTags.has(t));
    }

    const activeTags = resolveContextTriggerTags(context);
    return triggers.some((t) => activeTags.has(t));
}

/**
 * Select enabled non-empty `PromptBlock`s from a preset agent that match `context`,
 * split into `prefix` and `tail` arrays in their original order.
 * Defaults to `requireExplicit: true` so untagged main-agent blocks never bleed into
 * off-mainline runtimes (Workbench / SideGen / cross-agent trigger runs).
 */
export function selectPresetBlocksForContext(
    preset: Preset,
    context: PromptTriggerContext,
    options?: { requireExplicit?: boolean; agentId?: string },
): { prefix: PromptBlock[]; tail: PromptBlock[] } {
    const targetAgentId = options?.agentId ?? preset.mainAgentId;
    const agent = preset.agents[targetAgentId];
    if (!agent) {
        return { prefix: [], tail: [] };
    }

    const requireExplicit = options?.requireExplicit ?? true;
    const prefix: PromptBlock[] = [];
    const tail: PromptBlock[] = [];

    for (const block of agent.promptBlocks ?? []) {
        if (!block.enabled || !block.content.trim()) {
            continue;
        }
        if (!matchesPromptTriggers(block.triggers, context, { requireExplicit })) {
            continue;
        }
        if (block.placement === 'tail' || block.placement === 'floating_tail') {
            tail.push(block);
        } else {
            prefix.push(block);
        }
    }

    return { prefix, tail };
}

/**
 * Resolve UI display metadata (`label`, `shortLabel`, `tone`) for a trigger tag or `trigger_rule:<id>`.
 */
export function getPromptTriggerDisplay(
    trigger: string,
    presetTriggers?: readonly TriggerRule[],
): { label: string; shortLabel: string; tone: PromptTriggerTone } {
    const builtin = BUILTIN_TRIGGER_OPTION_MAP.get(trigger as BuiltinPromptTriggerType);
    if (builtin) {
        return {
            label: builtin.label,
            shortLabel: builtin.shortLabel,
            tone: builtin.tone,
        };
    }

    if (trigger.startsWith(TRIGGER_RULE_PREFIX)) {
        const ruleId = trigger.slice(TRIGGER_RULE_PREFIX.length);
        const matchedRule = presetTriggers?.find((rule) => rule.id === ruleId);
        const ruleLabel = matchedRule?.label?.trim() || ruleId;
        return {
            label: `触发器: ${ruleLabel}`,
            shortLabel: `规则:${ruleLabel}`,
            tone: 'warning',
        };
    }

    return {
        label: trigger,
        shortLabel: trigger,
        tone: 'neutral',
    };
}
