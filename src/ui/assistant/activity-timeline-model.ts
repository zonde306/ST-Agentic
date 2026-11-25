import type {
    AssistantActivityStep,
    AssistantMessage,
    AssistantToolCallRecord,
} from '@/core/types';

/** Icon family for a tool row; mapped to concrete SVG icons by the view. */
export type ToolIconKind =
    | 'file'
    | 'edit'
    | 'folder'
    | 'search'
    | 'chat'
    | 'data'
    | 'card'
    | 'regex'
    | 'script'
    | 'book'
    | 'settings'
    | 'preset'
    | 'terminal'
    | 'import'
    | 'plug'
    | 'agentic'
    | 'tool';

export interface ToolDisplay {
    verb: string;
    icon: ToolIconKind;
}

const TOOL_DISPLAY: Readonly<Record<string, ToolDisplay>> = {
    read_file: { verb: '读取文件', icon: 'file' },
    write_file: { verb: '写入文件', icon: 'edit' },
    append_file: { verb: '追加文件', icon: 'edit' },
    edit_file: { verb: '编辑文件', icon: 'edit' },
    list_dir: { verb: '列出目录', icon: 'folder' },
    glob_files: { verb: '匹配文件', icon: 'folder' },
    grep_search: { verb: '搜索内容', icon: 'search' },
    search_files: { verb: '搜索文件', icon: 'search' },
    read_history: { verb: '读取聊天历史', icon: 'chat' },
    search_history: { verb: '搜索聊天历史', icon: 'search' },
    read_variables: { verb: '读取变量', icon: 'data' },
    patch_variables: { verb: '修改变量', icon: 'data' },
    message_override_display: { verb: '覆盖消息显示', icon: 'chat' },
    chat_create_message: { verb: '新建消息', icon: 'chat' },
    chat_delete_message: { verb: '删除消息', icon: 'chat' },
    chat_edit_message: { verb: '编辑消息', icon: 'chat' },
    chat_reload_messages: { verb: '重载聊天', icon: 'chat' },
    chat_toggle_hide_message: { verb: '切换消息隐藏', icon: 'chat' },
    card_read_active: { verb: '读取当前角色卡', icon: 'card' },
    card_read_full: { verb: '读取完整角色卡', icon: 'card' },
    card_patch_active: { verb: '修改当前角色卡', icon: 'card' },
    card_embed_agentic: { verb: '嵌入扩展配置', icon: 'card' },
    card_admin_list_all: { verb: '列出全部角色卡', icon: 'card' },
    card_admin_read: { verb: '读取角色卡', icon: 'card' },
    card_admin_create: { verb: '创建角色卡', icon: 'card' },
    card_admin_patch: { verb: '修改角色卡', icon: 'card' },
    card_admin_delete: { verb: '删除角色卡', icon: 'card' },
    card_admin_select: { verb: '切换角色卡', icon: 'card' },
    persona_admin_list: { verb: '列出人设', icon: 'card' },
    persona_admin_select: { verb: '切换人设', icon: 'card' },
    persona_admin_upsert: { verb: '写入人设', icon: 'card' },
    regex_list_scoped: { verb: '列出局部正则', icon: 'regex' },
    regex_upsert_scoped: { verb: '写入局部正则', icon: 'regex' },
    regex_delete_scoped: { verb: '删除局部正则', icon: 'regex' },
    regex_admin_global_upsert: { verb: '写入全局正则', icon: 'regex' },
    regex_admin_global_delete: { verb: '删除全局正则', icon: 'regex' },
    tavern_helper_scripts_read: { verb: '读取角色脚本', icon: 'script' },
    tavern_helper_scripts_upsert: { verb: '写入角色脚本', icon: 'script' },
    wi_read_enabled: { verb: '读取已启用世界书', icon: 'book' },
    wi_list_enabled_books: { verb: '列出已启用世界书', icon: 'book' },
    wi_read_raw_book: { verb: '读取世界书原文', icon: 'book' },
    wi_upsert_enabled_entry: { verb: '写入世界书条目', icon: 'book' },
    wi_delete_enabled_entry: { verb: '删除世界书条目', icon: 'book' },
    wi_upsert_primary_entry: { verb: '写入主世界书条目', icon: 'book' },
    wi_delete_primary_entry: { verb: '删除主世界书条目', icon: 'book' },
    wi_admin_list_all: { verb: '列出全部世界书', icon: 'book' },
    wi_admin_create_book: { verb: '创建世界书', icon: 'book' },
    wi_admin_bind_book: { verb: '绑定世界书', icon: 'book' },
    wi_admin_upsert_entry: { verb: '写入世界书条目', icon: 'book' },
    wi_admin_delete_entry: { verb: '删除世界书条目', icon: 'book' },
    st_settings_read: { verb: '读取 ST 设置', icon: 'settings' },
    st_settings_patch: { verb: '修改 ST 设置', icon: 'settings' },
    st_preset_list: { verb: '列出预设', icon: 'preset' },
    st_preset_select: { verb: '切换预设', icon: 'preset' },
    st_preset_patch: { verb: '修改预设', icon: 'preset' },
    st_slash_exec: { verb: '执行斜杠命令', icon: 'terminal' },
    st_sync_runtime: { verb: '同步运行时', icon: 'settings' },
    st_import_url: { verb: '从 URL 导入', icon: 'import' },
    agentic_config_read: { verb: '读取扩展配置', icon: 'agentic' },
    agentic_settings_patch: { verb: '修改扩展设置', icon: 'agentic' },
    agentic_connection_upsert: { verb: '写入 API 连接', icon: 'plug' },
    agentic_preset_component_upsert: { verb: '写入预设组件', icon: 'preset' },
    agentic_preset_component_delete: { verb: '删除预设组件', icon: 'preset' },
    agentic_read_status: { verb: '读取运行状态', icon: 'agentic' },
    agentic_read_traces: { verb: '读取生成日志', icon: 'agentic' },
};

export function getToolDisplay(name: string): ToolDisplay {
    return TOOL_DISPLAY[name] ?? { verb: name, icon: 'tool' };
}

const PRIMARY_ARG_KEYS = [
    'path',
    'file_path',
    'filePath',
    'pattern',
    'query',
    'glob',
    'command',
    'url',
    'bookName',
    'name',
    'title',
    'scope',
    'messageId',
    'id',
    'key',
] as const;

const QUOTED_ARG_KEYS = new Set<string>(['pattern', 'query', 'glob']);

function formatArgValue(key: string, value: string): string {
    const compact = value.replace(/\s+/g, ' ').trim();
    return QUOTED_ARG_KEYS.has(key) ? `"${compact}"` : compact;
}

/**
 * Picks the most identifying argument out of a (possibly truncated) JSON args summary,
 * e.g. `{"path":"/tmp/a.json","offset":0}` -> `/tmp/a.json`.
 */
export function extractPrimaryArg(argsSummary: string): string {
    const raw = (argsSummary ?? '').trim();
    if (!raw) {
        return '';
    }
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const obj = parsed as Record<string, unknown>;
            for (const key of PRIMARY_ARG_KEYS) {
                const val = obj[key];
                if (typeof val === 'string' && val.trim()) {
                    return formatArgValue(key, val);
                }
                if (typeof val === 'number') {
                    return String(val);
                }
            }
            for (const [key, val] of Object.entries(obj)) {
                if (typeof val === 'string' && val.trim()) {
                    return formatArgValue(key, val);
                }
            }
            return '';
        }
    } catch {
        // Truncated summary: fall through to regex extraction.
    }
    for (const key of PRIMARY_ARG_KEYS) {
        const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw);
        if (match?.[1]) {
            return formatArgValue(key, match[1].replace(/\\"/g, '"'));
        }
    }
    const anyMatch = /"([A-Za-z_]+)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
    return anyMatch?.[2] ? formatArgValue(anyMatch[1], anyMatch[2].replace(/\\"/g, '"')) : '';
}

const TITLE_MAX_CHARS = 40;

/**
 * Splits reasoning text into a short headline (first sentence) and the remainder.
 * When the first sentence is too long it is truncated and the full text kept as body.
 */
export function splitFirstSentence(text: string): { title: string; rest: string } {
    const cleaned = (text ?? '').trim();
    if (!cleaned) {
        return { title: '', rest: '' };
    }
    const match = /[。！？!?\n]|\.(?=\s|$)/.exec(cleaned);
    const end = match ? match.index : cleaned.length;
    const sentence = cleaned
        .slice(0, end)
        .replace(/^[#>*\-\s`_]+/, '')
        .replace(/[*`_]+/g, '')
        .replace(/[，,：:；;、\s]+$/, '')
        .trim();
    if (!sentence) {
        return { title: '', rest: cleaned };
    }
    if (sentence.length > TITLE_MAX_CHARS) {
        return { title: `${sentence.slice(0, TITLE_MAX_CHARS)}…`, rest: cleaned };
    }
    const rest = cleaned.slice(match ? end + match[0].length : cleaned.length).trim();
    return { title: sentence, rest };
}

export type TimelineToolState = 'ok' | 'error' | 'running' | 'pending';

export interface TimelineToolCall {
    id: string;
    record: AssistantToolCallRecord | null;
    state: TimelineToolState;
}

/** Consecutive same-name calls inside one round are merged into one group. */
export interface TimelineToolGroup {
    key: string;
    name: string;
    calls: TimelineToolCall[];
}

export interface TimelineStep {
    id: string;
    title: string;
    /** Reasoning body shown under the title (first sentence removed when used as title). */
    body: string;
    /** Full reasoning text (used for the live streaming window). */
    think: string;
    thinkMs?: number;
    preface: string;
    groups: TimelineToolGroup[];
    toolCount: number;
    hasError: boolean;
    isLive: boolean;
}

export type TimelineLivePhase = 'thinking' | 'tools' | 'replying' | null;

export interface ActivityTimelineData {
    steps: TimelineStep[];
    /** Assistant content with per-round prefaces removed (the actual final reply). */
    finalContent: string;
    toolCount: number;
    errorCount: number;
    hasRedaction: boolean;
    totalThinkMs: number;
    hasThinkTiming: boolean;
    livePhase: TimelineLivePhase;
    liveDoneTools: number;
    liveTotalTools: number;
}

function removePrefacesFromContent(content: string, prefaces: readonly string[]): string {
    let remaining = content;
    for (const preface of prefaces) {
        if (!preface) {
            continue;
        }
        const pos = remaining.indexOf(preface);
        if (pos >= 0) {
            remaining = remaining.slice(0, pos) + remaining.slice(pos + preface.length);
        }
    }
    return remaining.replace(/^\s+/, '');
}

function groupToolCalls(stepId: string, calls: TimelineToolCall[]): TimelineToolGroup[] {
    const groups: TimelineToolGroup[] = [];
    for (const call of calls) {
        const name = call.record?.name ?? '';
        const last = groups[groups.length - 1];
        if (last && name && last.name === name) {
            last.calls.push(call);
        } else {
            groups.push({ key: `${stepId}-g${groups.length}`, name, calls: [call] });
        }
    }
    return groups;
}

/**
 * Normalizes an assistant message into ordered timeline rounds.
 * Legacy messages (no `activity`) and any unreferenced tool records / leading
 * reasoning are folded into a synthesized leading round so nothing is dropped.
 */
export function buildActivityTimeline(
    message: AssistantMessage,
    options: { isStreaming?: boolean } = {},
): ActivityTimelineData {
    const isStreaming = Boolean(options.isStreaming);
    const records = Array.isArray(message.toolCalls) ? message.toolCalls : [];
    const recordById = new Map(records.map((r) => [r.id, r]));
    const rawSteps: AssistantActivityStep[] = Array.isArray(message.activity)
        ? message.activity
        : [];

    const referenced = new Set<string>();
    for (const step of rawSteps) {
        for (const id of step.toolCallIds ?? []) {
            referenced.add(id);
        }
    }
    const joinedThink = rawSteps.map((s) => s.think ?? '').join('');
    const fullThink = message.think ?? '';
    let leadingThink = '';
    if (rawSteps.length === 0) {
        leadingThink = fullThink;
    } else if (fullThink.length > joinedThink.length && fullThink.endsWith(joinedThink)) {
        leadingThink = fullThink.slice(0, fullThink.length - joinedThink.length);
    }
    const leftoverRecords = records.filter((r) => !referenced.has(r.id));

    const normalized: AssistantActivityStep[] = [];
    if (leadingThink.trim() || leftoverRecords.length > 0) {
        normalized.push({
            id: `${message.id}-legacy`,
            startedAt: message.timestamp,
            ...(leadingThink.trim() ? { think: leadingThink } : {}),
            toolCallIds: leftoverRecords.map((r) => r.id),
        });
    }
    normalized.push(...rawSteps);

    const steps: TimelineStep[] = normalized.map((step, idx) => {
        const isLastStep = idx === normalized.length - 1;
        const isLive = isStreaming && isLastStep;
        const calls: TimelineToolCall[] = (step.toolCallIds ?? []).map((id) => {
            const record = recordById.get(id) ?? null;
            let state: TimelineToolState;
            if (record) {
                state = record.status === 'error' ? 'error' : 'ok';
            } else {
                state = isLive ? 'running' : 'pending';
            }
            return { id, record, state };
        });
        const think = (step.think ?? '').trim();
        const preface = (step.preface ?? '').trim();
        let title = '';
        let body = think;
        if (think) {
            const split = splitFirstSentence(think);
            title = split.title;
            body = split.rest;
        } else if (preface) {
            title = splitFirstSentence(preface).title;
        }
        if (!title) {
            title = calls.length > 0 ? `调用 ${calls.length} 个工具` : '思考';
        }
        return {
            id: step.id,
            title,
            body,
            think,
            ...(typeof step.thinkMs === 'number' ? { thinkMs: step.thinkMs } : {}),
            preface,
            groups: groupToolCalls(step.id, calls),
            toolCount: calls.length,
            hasError: calls.some((c) => c.state === 'error'),
            isLive,
        };
    });

    const prefaces = normalized.map((s) => s.preface ?? '').filter(Boolean);
    const finalContent = removePrefacesFromContent(message.content ?? '', prefaces);

    const allCalls = steps.flatMap((s) => s.groups.flatMap((g) => g.calls));
    const timedSteps = normalized.filter((s) => typeof s.thinkMs === 'number');
    const totalThinkMs = timedSteps.reduce((sum, s) => sum + (s.thinkMs ?? 0), 0);

    let livePhase: TimelineLivePhase = null;
    let liveDoneTools = 0;
    let liveTotalTools = 0;
    if (isStreaming) {
        const lastStep = steps[steps.length - 1];
        const lastCalls = lastStep ? lastStep.groups.flatMap((g) => g.calls) : [];
        const runningCount = lastCalls.filter((c) => c.state === 'running').length;
        if (runningCount > 0) {
            livePhase = 'tools';
            liveTotalTools = lastCalls.length;
            liveDoneTools = lastCalls.length - runningCount;
        } else if (finalContent.trim()) {
            livePhase = 'replying';
        } else {
            livePhase = 'thinking';
        }
    }

    return {
        steps,
        finalContent,
        toolCount: allCalls.length,
        errorCount: allCalls.filter((c) => c.state === 'error').length,
        hasRedaction: records.some((r) => Boolean(r.hasSecretRedaction)),
        totalThinkMs,
        hasThinkTiming: timedSteps.length > 0,
        livePhase,
        liveDoneTools,
        liveTotalTools,
    };
}

export function formatDurationShort(ms: number): string {
    const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    if (safe < 1000) {
        return `${Math.round(safe)}ms`;
    }
    if (safe < 60_000) {
        return `${(safe / 1000).toFixed(1).replace(/\.0$/, '')}s`;
    }
    const minutes = Math.floor(safe / 60_000);
    const seconds = Math.round((safe % 60_000) / 1000);
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ''}`;
}
