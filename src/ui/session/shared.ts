import { useEffect, useRef, useState } from 'preact/hooks';
import type {
    AgentRunStatus,
    PipelinePhase,
    TokenUsage,
} from '@/core/types';
import type { BadgeTone } from '@/ui/components';
import type { AppStore, AppStoreState, FileOverrideCategory } from '@/ui/store';

/**
 * Subscribe directly to a specific `AppStore` instance passed via props,
 * ensuring views work identically both inside `AppStoreProvider` and when
 * mounted standalone with an explicit `store` prop.
 */
export function useStoreSlice<T>(
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

/** Copy text to clipboard with fallback for restricted browser contexts. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
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

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
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

export function formatTokenCount(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) {
        return '0';
    }
    return Math.round(tokens).toLocaleString();
}

export function formatCompactTokens(tokens: number): string {
    if (!Number.isFinite(tokens) || tokens < 0) {
        return '0';
    }
    if (tokens >= 1000) {
        return `${(tokens / 1000).toFixed(1)}k`;
    }
    return String(Math.round(tokens));
}

export function computeCacheHitPercent(usage: TokenUsage): number {
    if (typeof usage.cacheHitRate === 'number' && Number.isFinite(usage.cacheHitRate)) {
        const normalized = usage.cacheHitRate <= 1 ? usage.cacheHitRate * 100 : usage.cacheHitRate;
        return Math.max(0, Math.min(100, normalized));
    }
    if (!usage.inputTokens || usage.inputTokens <= 0) {
        return 0;
    }
    return Math.max(0, Math.min(100, (usage.cachedTokens / usage.inputTokens) * 100));
}

export function formatTimestamp(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) {
        return '-';
    }
    try {
        const date = new Date(ts);
        return date.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });
    } catch {
        return String(ts);
    }
}

export function getCategoryLabel(category: FileOverrideCategory): string {
    switch (category) {
        case 'workspace':
            return '工作区';
        case 'variables':
            return '变量';
        case 'worldinfo':
            return 'WI覆写';
        case 'message':
            return '展示层';
    }
}

export function getCategoryTone(category: FileOverrideCategory): BadgeTone {
    switch (category) {
        case 'workspace':
            return 'primary';
        case 'variables':
            return 'success';
        case 'worldinfo':
            return 'warning';
        case 'message':
            return 'neutral';
    }
}

export function getPhaseLabel(phase: PipelinePhase): string {
    switch (phase) {
        case 'before_turn':
            return '前置推演';
        case 'main_turn':
            return '主生成';
        case 'after_turn':
            return '后置触发';
        case 'maintenance':
            return '水位维护';
    }
}

export function getRunStatusMeta(status: AgentRunStatus): { label: string; tone: BadgeTone } {
    switch (status) {
        case 'completed':
            return { label: '已完成', tone: 'success' };
        case 'running':
            return { label: '运行中', tone: 'primary' };
        case 'aborted':
            return { label: '已中止', tone: 'warning' };
        case 'error':
            return { label: '错误', tone: 'error' };
    }
}
