import { useCallback, useEffect, useState } from 'preact/hooks';
import { Button } from '@/ui/components';
import { IconRefresh } from '@/ui/components/Icons';
import type { ConsoleViewProps, SideGenSubTab } from '@/ui/store';
import { CluesManagerPane } from './CluesManagerPane';
import { SdkPlaygroundPane } from './SdkPlaygroundPane';
import { SideSessionsPane } from './SideSessionsPane';
import { formatErrorMessage, useSideGenStoreSlice } from './sidegen-helpers';

const SUB_TABS: readonly { id: SideGenSubTab; label: string }[] = [
    { id: 'clues', label: '线索 (/side/*)' },
    { id: 'sessions', label: '线外会话' },
    { id: 'sdk', label: 'SDK 试跑' },
];

/**
 * SideGen Off-Mainline Sessions & `/side/*` Clues Console View (`sidegen` tab).
 * Registered into the console view registry via `registerSideGenView()`.
 */
export function SideGenView({ store, isMobile }: ConsoleViewProps) {
    const sideGenSubTab = useSideGenStoreSlice(store, (s) => s.sideGenSubTab);
    const sideCluesCount = useSideGenStoreSlice(store, (s) => s.sideClues.length);
    const sideSessionsCount = useSideGenStoreSlice(store, (s) => s.sideSessions.length);
    const activeTarget = useSideGenStoreSlice(store, (s) => s.activeTarget);

    const [refreshing, setRefreshing] = useState<boolean>(false);

    const refreshData = useCallback(
        async (showToastOnDone = false) => {
            if (!store.getSideGenRuntime()) {
                if (showToastOnDone) {
                    store.pushToast('SideGen 运行时未连接，展示当前缓存数据', 'primary');
                }
                return;
            }
            setRefreshing(true);
            try {
                await store.refreshSideGenState(activeTarget);
                if (showToastOnDone) {
                    store.pushToast('已刷新 /side/* 线索与线外会话', 'success');
                }
            } catch (err) {
                store.pushToast(`刷新线外数据失败：${formatErrorMessage(err)}`, 'error');
            } finally {
                setRefreshing(false);
            }
        },
        [activeTarget.messageId, activeTarget.swipeId, store],
    );

    // Hydrate from SideGenRuntime on mount and when the active causal branch target changes.
    useEffect(() => {
        void refreshData(false);
    }, [refreshData]);

    return (
        <div class="ag-side-root" data-view-id="sidegen">
            <div class="ag-side-subbar">
                <div
                    class="ag-side-tabs ag-no-scrollbar ag-min-w-0"
                    role="tablist"
                    aria-label="线外会话与线索子视图"
                >
                    {SUB_TABS.map((tab) => {
                        const isActive = sideGenSubTab === tab.id;
                        const count =
                            tab.id === 'clues'
                                ? sideCluesCount
                                : tab.id === 'sessions'
                                    ? sideSessionsCount
                                    : null;
                        return (
                            <button
                                key={tab.id}
                                type="button"
                                role="tab"
                                data-sidegen-subtab={tab.id}
                                aria-selected={isActive}
                                class={isActive ? 'ag-side-tab ag-side-tab-active' : 'ag-side-tab'}
                                onClick={() => store.setSideGenSubTab(tab.id)}
                            >
                                {tab.label}
                                {count !== null && count > 0 ? ` (${count})` : ''}
                            </button>
                        );
                    })}
                </div>

                <div class="ag-row" style={{ gap: '8px', flexShrink: 0, maxWidth: '50%' }}>
                    {!isMobile ? (
                        <span class="ag-side-subbar-hint">
                            业务交互 UI 由写卡作者经{' '}
                            <code class="ag-mono">Agentic.sideGen</code> 自建
                        </span>
                    ) : null}
                    <Button
                        variant="ghost"
                        size="sm"
                        loading={refreshing}
                        ariaLabel="刷新线外会话与线索"
                        title="刷新 /side/* 线索与线外会话"
                        icon={<IconRefresh size={14} />}
                        onClick={() => {
                            void refreshData(true);
                        }}
                    />
                </div>
            </div>

            <div class="ag-side-content">
                {sideGenSubTab === 'clues' ? (
                    <CluesManagerPane store={store} isMobile={isMobile} />
                ) : sideGenSubTab === 'sessions' ? (
                    <SideSessionsPane store={store} isMobile={isMobile} />
                ) : (
                    <SdkPlaygroundPane store={store} isMobile={isMobile} />
                )}
            </div>
        </div>
    );
}
