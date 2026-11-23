import type { ComponentType } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ConsoleTabId } from '@/core/types';
import type { AppStore } from './app-store';

export type ConsoleTabGroup = 'offmain' | 'session' | 'system';

export interface ConsoleTabMeta {
    id: ConsoleTabId;
    group: ConsoleTabGroup;
    groupLabel: string;
    label: string;
    shortLabel: string;
    description: string;
}

export interface ConsoleViewProps {
    store: AppStore;
    isMobile: boolean;
}

export type ConsoleViewComponent = ComponentType<ConsoleViewProps>;

/**
 * Canonical 3-group, 11-tab navigation metadata matching ARCHITECTURE.md §9.2
 * and OFF_MAINLINE_PLAN.md §6.1 (`offmain` top-most group).
 */
export const CONSOLE_TABS: readonly ConsoleTabMeta[] = [
    {
        id: 'assistant',
        group: 'offmain',
        groupLabel: '线外协作',
        label: '助手工作台',
        shortLabel: '助手',
        description: '4档模式 / 气泡审批 / 撤销',
    },
    {
        id: 'sidegen',
        group: 'offmain',
        groupLabel: '线外协作',
        label: '线外会话与线索',
        shortLabel: '线外线索',
        description: 'SideSession / /side/*',
    },
    {
        id: 'files',
        group: 'session',
        groupLabel: '当前会话',
        label: '文件与内容覆盖',
        shortLabel: '文件覆盖',
        description: '工作区 / 变量 / WI Diff',
    },
    {
        id: 'logs',
        group: 'session',
        groupLabel: '当前会话',
        label: '生成与工具日志',
        shortLabel: '生成日志',
        description: '轮次调用链 / 缓存命中',
    },
    {
        id: 'cache',
        group: 'session',
        groupLabel: '当前会话',
        label: '缓存水位与存档压平',
        shortLabel: '缓存压平',
        description: '分块归档 / 冷层压平',
    },
    {
        id: 'prompts',
        group: 'system',
        groupLabel: '预设与系统',
        label: '预设与提示词',
        shortLabel: '提示词',
        description: '独立预设 / 提示词排序与编辑',
    },
    {
        id: 'agents',
        group: 'system',
        groupLabel: '预设与系统',
        label: '智能体',
        shortLabel: '智能体',
        description: '提示词积木 / 权限 / 水位',
    },
    {
        id: 'pipeline',
        group: 'system',
        groupLabel: '预设与系统',
        label: '触发管线',
        shortLabel: '触发管线',
        description: '四阶段 / 屏障 / @@扫描',
    },
    {
        id: 'tools',
        group: 'system',
        groupLabel: '预设与系统',
        label: '工具与脚本',
        shortLabel: '工具脚本',
        description: 'JS defineTool / 模拟测试',
    },
    {
        id: 'regex',
        group: 'system',
        groupLabel: '预设与系统',
        label: '正则清洗',
        shortLabel: '正则清洗',
        description: 'display / ingest / lore_read',
    },
    {
        id: 'wi',
        group: 'system',
        groupLabel: '预设与系统',
        label: '世界书路由',
        shortLabel: '世界书路由',
        description: '四类分流纠偏 / /preset/*',
    },
    {
        id: 'connections',
        group: 'system',
        groupLabel: '预设与系统',
        label: 'API 连接',
        shortLabel: 'API连接',
        description: '多模型 / 缓存断点策略',
    },
] as const;

export const CONSOLE_TAB_GROUPS: readonly { id: ConsoleTabGroup; label: string }[] = [
    { id: 'offmain', label: '线外协作' },
    { id: 'session', label: '当前会话' },
    { id: 'system', label: '预设与系统' },
] as const;

const viewRegistry = new Map<ConsoleTabId, ConsoleViewComponent>();
const registryListeners = new Set<() => void>();

function notifyRegistryListeners(): void {
    registryListeners.forEach((listener) => {
        try {
            listener();
        } catch {
            // Keep registry notification loop resilient to subscriber errors.
        }
    });
}

/** Look up metadata for a console tab ID. */
export function getConsoleTabMeta(tabId: ConsoleTabId): ConsoleTabMeta {
    return CONSOLE_TABS.find((tab) => tab.id === tabId) ?? CONSOLE_TABS[0];
}

/**
 * Register a Preact view component for one of the console tabs.
 * Returns an unregister callback for clean module teardown or hot replacement.
 */
export function registerConsoleView(
    tabId: ConsoleTabId,
    component: ConsoleViewComponent,
): () => void {
    viewRegistry.set(tabId, component);
    notifyRegistryListeners();

    return () => {
        if (viewRegistry.get(tabId) === component) {
            viewRegistry.delete(tabId);
            notifyRegistryListeners();
        }
    };
}

/** Retrieve the currently registered view component for `tabId`, if any. */
export function getConsoleView(tabId: ConsoleTabId): ConsoleViewComponent | undefined {
    return viewRegistry.get(tabId);
}

/** List all tab IDs that currently have a registered view component. */
export function listRegisteredConsoleViews(): ConsoleTabId[] {
    return Array.from(viewRegistry.keys());
}

/** Subscribe to console view registration updates. */
export function subscribeConsoleViews(listener: () => void): () => void {
    registryListeners.add(listener);
    return () => {
        registryListeners.delete(listener);
    };
}

/** Reactive Preact hook returning the registered view component for `tabId`. */
export function useConsoleView(tabId: ConsoleTabId): ConsoleViewComponent | undefined {
    const [, setVersion] = useState(0);

    useEffect(() => {
        return subscribeConsoleViews(() => {
            setVersion((prev) => prev + 1);
        });
    }, []);

    return getConsoleView(tabId);
}
