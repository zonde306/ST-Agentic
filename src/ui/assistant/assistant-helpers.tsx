import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    ApiConnection,
    AssistantAttachment,
    AssistantAttachmentKind,
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
        desc: '允许增删改当前 Chat 消息、变量、工作区、分支 WI 覆写与 /side/*',
        pills: [
            { text: '写: 当前 Chat 增删改 (删消息默认确认)', cls: 'ag-pill-success' },
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
        desc: '读写全部已开启世界书 + 管理 ST-Agentic 自身设置/工具/正则；开「ST 全权管家」解锁全库与扩展热同步',
        pills: [],
    },
};

export function getEffectiveModePills(
    session: Pick<AssistantSession, 'mode' | 'stAdminEnabled'> & { autoApproveChatDelete?: boolean },
): readonly { text: string; cls: string }[] {
    if (session.mode === 'adjust' && session.autoApproveChatDelete) {
        return [
            { text: '写: 当前 Chat 增删改 (自动批准删除)', cls: 'ag-pill-warning' },
            { text: '写: 变量 / 工作区 / /side/*', cls: 'ag-pill-success' },
            { text: '永久资产: 只读', cls: 'ag-pill-muted' },
        ];
    }
    if (session.mode !== 'full') {
        return ASSISTANT_MODE_META[session.mode].pills;
    }
    if (session.stAdminEnabled) {
        return [
            { text: '写: 全库世界书 / 角色卡 / 人设 / 正则 / ST-Agentic', cls: 'ag-pill-error' },
            { text: '系统: ST 设置 / 预设 / 已安装扩展热同步 / 运行时重载', cls: 'ag-pill-error' },
            { text: '红线: 高危强制确认 + Key 脱敏 + 撤销', cls: 'ag-pill-warning' },
        ];
    }
    return [
        { text: '写: 已开启世界书 + ST-Agentic 设置/工具/脚本/正则', cls: 'ag-pill-warning' },
        { text: '写: 含写卡 & 调整模式全部能力 + 刷新消息展示', cls: 'ag-pill-primary' },
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

/** Copy text to clipboard with fallback for restricted/embedded browser contexts. */
export async function copyTextSafe(text: string): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall through to execCommand fallback.
        }
    }

    if (typeof document === 'undefined' || !document.body) {
        return false;
    }

    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
        textarea.remove();
        return ok;
    } catch {
        return false;
    }
}

export const MAX_ASSISTANT_ATTACHMENT_COUNT = 8;
export const MAX_ASSISTANT_SINGLE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ASSISTANT_TOTAL_BYTES = 32 * 1024 * 1024;
export const ASSISTANT_FILE_ACCEPT =
    'image/*,audio/*,video/*,.pdf,.txt,.md,.json,.csv,.yaml,.yml';

const IMAGE_EXT_MIME: Readonly<Record<string, string>> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
};

const AUDIO_EXT_MIME: Readonly<Record<string, string>> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    wave: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    aac: 'audio/aac',
    m4a: 'audio/mp4',
};

const VIDEO_EXT_MIME: Readonly<Record<string, string>> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    m4v: 'video/x-m4v',
    ogv: 'video/ogg',
};

const TEXT_EXT_MIME: Readonly<Record<string, string>> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    tsv: 'text/tab-separated-values',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    xml: 'application/xml',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    tsx: 'text/typescript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    log: 'text/plain',
    ini: 'text/plain',
    conf: 'text/plain',
};

export function formatFileSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return '0 B';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyAssistantFile(file: {
    name: string;
    type: string;
}): { kind: AssistantAttachmentKind; mimeType: string; isTextReadable: boolean } | null {
    const cleanMime = (file.type || '').split(';')[0].trim().toLowerCase();
    const extMatch = /\.([a-z0-9]+)$/i.exec(file.name.trim());
    const ext = extMatch ? extMatch[1].toLowerCase() : '';

    if (cleanMime.startsWith('image/')) {
        return { kind: 'image', mimeType: cleanMime, isTextReadable: false };
    }
    if (cleanMime.startsWith('audio/')) {
        return { kind: 'audio', mimeType: cleanMime, isTextReadable: false };
    }
    if (cleanMime.startsWith('video/')) {
        return { kind: 'video', mimeType: cleanMime, isTextReadable: false };
    }
    if (cleanMime === 'application/pdf') {
        return { kind: 'file', mimeType: cleanMime, isTextReadable: false };
    }
    if (
        cleanMime.startsWith('text/')
        || cleanMime === 'application/json'
        || cleanMime === 'application/xml'
        || cleanMime === 'application/yaml'
        || cleanMime === 'application/x-yaml'
        || cleanMime === 'application/javascript'
        || cleanMime === 'application/typescript'
    ) {
        return { kind: 'file', mimeType: cleanMime, isTextReadable: true };
    }

    if (ext && IMAGE_EXT_MIME[ext]) {
        return { kind: 'image', mimeType: IMAGE_EXT_MIME[ext], isTextReadable: false };
    }
    if (ext && AUDIO_EXT_MIME[ext]) {
        return { kind: 'audio', mimeType: AUDIO_EXT_MIME[ext], isTextReadable: false };
    }
    if (ext && VIDEO_EXT_MIME[ext]) {
        return { kind: 'video', mimeType: VIDEO_EXT_MIME[ext], isTextReadable: false };
    }
    if (ext === 'pdf') {
        return { kind: 'file', mimeType: 'application/pdf', isTextReadable: false };
    }
    if (ext && TEXT_EXT_MIME[ext]) {
        return { kind: 'file', mimeType: TEXT_EXT_MIME[ext], isTextReadable: true };
    }

    return null;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
        reader.readAsDataURL(blob);
    });
}

function readBlobAsText(blob: Blob): Promise<string> {
    if (typeof blob.text === 'function') {
        return blob.text();
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
        reader.onerror = () => reject(reader.error ?? new Error('读取文本文件失败'));
        reader.readAsText(blob);
    });
}

let attachmentSeq = 0;

export async function prepareAssistantAttachments(
    files: FileList | readonly File[],
    existing: readonly AssistantAttachment[],
): Promise<{ added: AssistantAttachment[]; errors: string[] }> {
    const fileArray = Array.from(files);
    const added: AssistantAttachment[] = [];
    const errors: string[] = [];

    let currentCount = existing.length;
    let currentTotalBytes = existing.reduce((sum, item) => sum + item.size, 0);

    for (const file of fileArray) {
        if (currentCount >= MAX_ASSISTANT_ATTACHMENT_COUNT) {
            errors.push(`最多只能附加 ${MAX_ASSISTANT_ATTACHMENT_COUNT} 个文件`);
            break;
        }
        if (file.size > MAX_ASSISTANT_SINGLE_FILE_BYTES) {
            errors.push(`「${file.name}」超过单文件大小上限 (${formatFileSize(MAX_ASSISTANT_SINGLE_FILE_BYTES)})`);
            continue;
        }
        if (currentTotalBytes + file.size > MAX_ASSISTANT_TOTAL_BYTES) {
            errors.push(`附件总大小不能超过 ${formatFileSize(MAX_ASSISTANT_TOTAL_BYTES)}`);
            continue;
        }

        const classified = classifyAssistantFile(file);
        if (!classified) {
            errors.push(`不支持的文件格式：「${file.name}」`);
            continue;
        }

        try {
            let dataUrl = await readBlobAsDataUrl(file);
            if (
                classified.mimeType
                && dataUrl.startsWith('data:application/octet-stream;')
            ) {
                dataUrl = `data:${classified.mimeType};${dataUrl.slice('data:application/octet-stream;'.length)}`;
            }
            const textContent = classified.isTextReadable
                ? await readBlobAsText(file)
                : undefined;

            attachmentSeq += 1;
            added.push({
                id: `att_${Date.now().toString(36)}_${attachmentSeq}`,
                kind: classified.kind,
                name: file.name || `attachment_${attachmentSeq}`,
                mimeType: classified.mimeType,
                size: file.size,
                dataUrl,
                ...(textContent !== undefined ? { textContent } : {}),
            });
            currentCount += 1;
            currentTotalBytes += file.size;
        } catch (err) {
            errors.push(`读取「${file.name}」失败：${formatErrorMessage(err)}`);
        }
    }

    return { added, errors };
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
