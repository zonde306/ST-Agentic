import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    MessageTarget,
    SideClueDelivery,
    SideClueStatus,
} from '@/core/types';
import type { BadgeTone, SelectOption } from '@/ui/components';
import type { AppStore, AppStoreState } from '@/ui/store';

export interface DeliveryMeta {
    value: SideClueDelivery;
    label: string;
    shortLabel: string;
    tone: BadgeTone;
    pillClass: string;
    description: string;
}

export const DELIVERY_META_LIST: readonly DeliveryMeta[] = [
    {
        value: 'none',
        label: '不入主线 (none)',
        shortLabel: '不入主线',
        tone: 'neutral',
        pillClass: 'ag-pill ag-pill-muted',
        description: '彻底隔离，主线完全不可见。适用于纯娱乐性线外小插曲。',
    },
    {
        value: 'vfs_only',
        label: '仅 VFS 可查 (vfs_only)',
        shortLabel: '仅 VFS',
        tone: 'primary',
        pillClass: 'ag-pill ag-pill-primary',
        description: '不主动提示；仅当主 Agent 自主调用 read_file / search_files 查阅时消费。',
    },
    {
        value: 'radar_hint',
        label: 'TailRadar 雷达触发 (radar_hint · 默认)',
        shortLabel: '雷达触发',
        tone: 'success',
        pillClass: 'ag-pill ag-pill-success',
        description: 'Layer 2 尾部雷达按关键词扫描，未读或内容更新时输出 <side-hint>，已读后静默。',
    },
    {
        value: 'next_turn_brief',
        label: '下轮一次性简报 (next_turn_brief)',
        shortLabel: '下轮简报',
        tone: 'warning',
        pillClass: 'ag-pill ag-pill-warning',
        description: '在下一主线回合 Layer 2 注入一次 <side-brief>，消费后自动降级。',
    },
] as const;

export const DELIVERY_SELECT_OPTIONS: readonly SelectOption<SideClueDelivery>[] =
    DELIVERY_META_LIST.map((item) => ({
        value: item.value,
        label: item.label,
    }));

export function getDeliveryMeta(delivery: SideClueDelivery): DeliveryMeta {
    return (
        DELIVERY_META_LIST.find((item) => item.value === delivery)
        ?? DELIVERY_META_LIST[2]
    );
}

export interface StatusMeta {
    value: SideClueStatus;
    label: string;
    shortLabel: string;
    tone: BadgeTone;
    pillClass: string;
}

export const STATUS_META_LIST: readonly StatusMeta[] = [
    {
        value: 'dormant',
        label: '潜伏中 (dormant)',
        shortLabel: '潜伏中',
        tone: 'neutral',
        pillClass: 'ag-pill ag-pill-muted',
    },
    {
        value: 'surfaced',
        label: '主线已感知 (surfaced)',
        shortLabel: '已浮现',
        tone: 'primary',
        pillClass: 'ag-pill ag-pill-primary',
    },
    {
        value: 'resolved',
        label: '已回收归档 (resolved)',
        shortLabel: '已回收',
        tone: 'success',
        pillClass: 'ag-pill ag-pill-success',
    },
] as const;

export const STATUS_SELECT_OPTIONS: readonly SelectOption<SideClueStatus>[] =
    STATUS_META_LIST.map((item) => ({
        value: item.value,
        label: item.label,
    }));

export function getStatusMeta(status: SideClueStatus): StatusMeta {
    return (
        STATUS_META_LIST.find((item) => item.value === status)
        ?? STATUS_META_LIST[0]
    );
}

export type ClueCategoryFilter = 'all' | 'comms' | 'rumors' | 'notes';

export function inferClueCategory(path: string): 'comms' | 'rumors' | 'notes' {
    if (path.startsWith('/side/comms/')) {
        return 'comms';
    }
    if (path.startsWith('/side/rumors/') || path.startsWith('/side/world/')) {
        return 'rumors';
    }
    return 'notes';
}

export function getClueCategoryLabel(category: 'comms' | 'rumors' | 'notes'): string {
    switch (category) {
        case 'comms':
            return '通讯';
        case 'rumors':
            return '流言';
        case 'notes':
            return '便签';
    }
}

/**
 * Parse comma/newline/Chinese-comma separated keyword text into deduplicated trimmed strings.
 */
export function parseKeywordsInput(raw: string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const part of raw.split(/[,，\n]+/)) {
        const trimmed = part.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            result.push(trimmed);
        }
    }
    return result;
}

/** Format a causal anchor (`MessageTarget`) as `#messageId#swipeId`. */
export function formatAnchor(anchor: MessageTarget | string): string {
    if (typeof anchor === 'string') {
        return anchor.startsWith('#') ? anchor : `#${anchor}`;
    }
    return `#${anchor.messageId}#${anchor.swipeId}`;
}

export function formatTokenCount(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) {
        return '0';
    }
    return Math.round(tokens).toLocaleString();
}

export function formatDurationMs(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        return '0 ms';
    }
    if (durationMs < 1000) {
        return `${Math.round(durationMs)} ms`;
    }
    return `${(durationMs / 1000).toFixed(2)} s`;
}

export function formatShortTime(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) {
        return '—';
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

/** Subscribe directly to an `AppStore` slice without depending on external view helpers. */
export function useSideGenStoreSlice<T>(
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

/** Normalize a user-provided filename/path into a valid `/side/<category>/<slug>.md` path. */
export function buildNewCluePath(
    category: 'comms' | 'rumors' | 'notes',
    rawName: string,
): string {
    const trimmed = rawName.trim().replace(/\\/g, '/');
    if (!trimmed) {
        return `/side/${category}/clue-${Date.now().toString(36)}.md`;
    }
    if (trimmed.startsWith('/side/')) {
        return trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
    }
    const cleanSlug = trimmed
        .replace(/^\/+/, '')
        .replace(/\.{2,}/g, '')
        .replace(/\s+/g, '-');
    const withExt = cleanSlug.endsWith('.md') ? cleanSlug : `${cleanSlug}.md`;
    return `/side/${category}/${withExt}`;
}
