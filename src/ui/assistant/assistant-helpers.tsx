import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    ApiConnection,
    AssistantMode,
    AssistantSession,
    PendingApproval,
    UndoKind,
} from '@/core/types';
import type { AppStore, AppStoreState } from '@/ui/store';

export interface AssistantModeMeta {
    id: AssistantMode;
    icon: string;
    label: string;
    fullLabel: string;
    pillClass: string;
    desc: string;
    pills: readonly { text: string; cls: string }[];
}

export const ASSISTANT_MODE_ORDER: readonly AssistantMode[] = [
    'chat',
    'adjust',
    'author',
    'full',
] as const;

export const ASSISTANT_MODE_META: Readonly<Record<AssistantMode, AssistantModeMeta>> = {
    chat: {
        id: 'chat',
        icon: '💬',
        label: '交流',
        fullLabel: '交流模式',
        pillClass: 'ag-pill-primary',
        desc: '纯聊天只读 · VFS / Chat / 角色卡 / WI，零写入副作用',
        pills: [
            { text: '读: VFS / Chat / 角色卡 / WI / 日志', cls: 'ag-pill-primary' },
            { text: '写: 禁止写入', cls: 'ag-pill-muted' },
        ],
    },
    adjust: {
        id: 'adjust',
        icon: '🔧',
        label: '调整',
        fullLabel: '调整模式',
        pillClass: 'ag-pill-success',
        desc: '允许修改当前 Chat、变量、工作区、分支 WI 覆写与 /side/*',
        pills: [
            { text: '写: 当前 Chat (可选同步轨迹)', cls: 'ag-pill-success' },
            { text: '写: 变量 / 工作区 / /side/*', cls: 'ag-pill-success' },
            { text: '永久资产: 只读', cls: 'ag-pill-muted' },
        ],
    },
    author: {
        id: 'author',
        icon: '✍️',
        label: '写卡',
        fullLabel: '写卡模式',
        pillClass: 'ag-pill-warning',
        desc: '含调整能力 + 当前角色卡、主世界书、绑定正则（支持 @@ 与 EJS）',
        pills: [
            { text: '写: 当前角色卡 & 主世界书 (@@ / EJS)', cls: 'ag-pill-warning' },
            { text: '写: 角色绑定正则 & 当前 Chat', cls: 'ag-pill-warning' },
            { text: '安全: 气泡审批 + 快照撤销', cls: 'ag-pill-primary' },
        ],
    },
    full: {
        id: 'full',
        icon: '⚡',
        label: '完全控制',
        fullLabel: '完全控制',
        pillClass: 'ag-pill-error',
        desc: '默认读写全部已开启世界书；开「ST 全权管家」解锁全库资产与设置',
        pills: [],
    },
};

export function getEffectiveModePills(
    session: Pick<AssistantSession, 'mode' | 'stAdminEnabled'>,
): readonly { text: string; cls: string }[] {
    if (session.mode !== 'full') {
        return ASSISTANT_MODE_META[session.mode].pills;
    }
    if (session.stAdminEnabled) {
        return [
            { text: '写: 全库世界书 / 角色卡 / 人设 / 正则', cls: 'ag-pill-error' },
            { text: '系统: ST 设置 / 预设 / 斜杠 / URL 导入', cls: 'ag-pill-error' },
            { text: '红线: 高危强制确认 + Key 脱敏 + 撤销', cls: 'ag-pill-warning' },
        ];
    }
    return [
        { text: '写: 全部已开启的世界书', cls: 'ag-pill-warning' },
        { text: '写: 含写卡 & 调整模式全部能力', cls: 'ag-pill-primary' },
        { text: 'ST 全局管家: 未启用', cls: 'ag-pill-muted' },
    ];
}

export function getUndoKindMeta(kind: UndoKind): { label: string; pillClass: string } {
    switch (kind) {
        case 'chat_message':
            return { label: 'Chat 消息', pillClass: 'ag-pill-primary' };
        case 'variables':
            return { label: '分支变量', pillClass: 'ag-pill-success' };
        case 'vfs_file':
            return { label: 'VFS 文件', pillClass: 'ag-pill-primary' };
        case 'character':
            return { label: '角色卡', pillClass: 'ag-pill-warning' };
        case 'worldinfo':
            return { label: '世界书', pillClass: 'ag-pill-warning' };
        case 'regex':
            return { label: '正则脚本', pillClass: 'ag-pill-warning' };
        case 'st_setting':
            return { label: 'ST 设置', pillClass: 'ag-pill-error' };
    }
}

export function resolveConnectionDisplay(
    connectionId: string,
    connections: Record<string, ApiConnection>,
    currentConnectionId: string,
): { shortLabel: string; fullLabel: string } {
    if (!connectionId || connectionId === 'inherit') {
        const primary = connections[currentConnectionId];
        return {
            shortLabel: '跟随主连接',
            fullLabel: primary ? `跟随主连接 (${primary.name})` : '跟随主连接',
        };
    }
    const found = connections[connectionId];
    if (!found) {
        return {
            shortLabel: connectionId,
            fullLabel: connectionId,
        };
    }
    const suffix = found.model ? ` · ${found.model}` : '';
    return {
        shortLabel: found.name,
        fullLabel: `${found.name}${suffix}`,
    };
}

export function countSessionPendingApprovals(
    session: AssistantSession,
    approvalsById: ReadonlyMap<string, PendingApproval>,
): number {
    let count = 0;
    const seen = new Set<string>();
    for (const msg of session.messages) {
        if (!Array.isArray(msg.approvalIds)) {
            continue;
        }
        for (const id of msg.approvalIds) {
            if (seen.has(id)) {
                continue;
            }
            seen.add(id);
            if (approvalsById.get(id)?.status === 'pending') {
                count += 1;
            }
        }
    }
    return count;
}

export function formatAssistantTime(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) {
        return '刚刚';
    }
    const diffMs = Date.now() - ts;
    if (diffMs >= 0 && diffMs < 45_000) {
        return '刚刚';
    }
    try {
        return new Date(ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        return String(ts);
    }
}

export function formatDetailedTime(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) {
        return '刚刚';
    }
    try {
        return new Date(ts).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    } catch {
        return String(ts);
    }
}

export function formatErrorMessage(err: unknown): string {
    if (err instanceof Error && err.message) {
        return err.message;
    }
    return String(err ?? '未知错误');
}

/**
 * Safely render inline markdown (`**bold**`, `` `code` ``, and line breaks) into Preact VNodes
 * without ever using `dangerouslySetInnerHTML`.
 */
export function renderSimpleMarkdown(text: string): ComponentChildren {
    if (!text) {
        return null;
    }
    const lines = text.split('\n');
    return lines.map((line, lineIdx) => {
        const tokens = parseInlineTokens(line, `l${lineIdx}`);
        return (
            <Fragment key={`line-${lineIdx}`}>
                {tokens}
                {lineIdx < lines.length - 1 ? <br /> : null}
            </Fragment>
        );
    });
}

function parseInlineTokens(line: string, keyPrefix: string): ComponentChildren[] {
    const result: ComponentChildren[] = [];
    const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*\*\*REDACTED\*\*\*)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null = regex.exec(line);
    let tokenIdx = 0;

    while (match !== null) {
        if (match.index > lastIndex) {
            result.push(line.slice(lastIndex, match.index));
        }
        const token = match[0];
        if (token === '***REDACTED***') {
            result.push(
                <span key={`${keyPrefix}-r-${tokenIdx}`} class="ag-redacted-token">
                    ***REDACTED***
                </span>,
            );
        } else if (token.startsWith('`') && token.endsWith('`')) {
            result.push(
                <code key={`${keyPrefix}-c-${tokenIdx}`}>{token.slice(1, -1)}</code>,
            );
        } else if (token.startsWith('**') && token.endsWith('**')) {
            result.push(
                <strong key={`${keyPrefix}-b-${tokenIdx}`} style={{ fontWeight: 600 }}>
                    {token.slice(2, -2)}
                </strong>,
            );
        } else {
            result.push(token);
        }
        lastIndex = regex.lastIndex;
        tokenIdx += 1;
        match = regex.exec(line);
    }

    if (lastIndex < line.length) {
        result.push(line.slice(lastIndex));
    }

    return result;
}

/**
 * Highlight `***REDACTED***` tokens inside tool output or raw diff previews using pure VNodes.
 */
export function renderRedactedText(text: string): ComponentChildren {
    if (!text) {
        return '';
    }
    const parts = text.split('***REDACTED***');
    if (parts.length === 1) {
        return text;
    }
    return parts.map((part, idx) => (
        <Fragment key={`red-${idx}`}>
            {part}
            {idx < parts.length - 1 ? (
                <span class="ag-redacted-token">***REDACTED***</span>
            ) : null}
        </Fragment>
    ));
}

/** Subscribe directly to an `AppStore` slice using pure `preact/hooks`. */
export function useAssistantStoreSlice<T>(
    store: AppStore,
    selector: (state: AppStoreState) => T,
): T {
    const selectorRef = useRef(selector);
    selectorRef.current = selector;

    const [selected, setSelected] = useState<T>(() => selectorRef.current(store.getSnapshot()));
    const latestSelectedRef = useRef<T>(selected);
    latestSelectedRef.current = selected;

    useEffect(() => {
        const sync = () => {
            const next = selectorRef.current(store.getSnapshot());
            if (!Object.is(latestSelectedRef.current, next)) {
                latestSelectedRef.current = next;
                setSelected(next);
            }
        };
        sync();
        return store.subscribe(sync);
    }, [store]);

    return selected;
}
