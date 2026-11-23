import { Fragment, type TargetedKeyboardEvent, render } from 'preact';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import type { ConsoleTabId, RunMode, ThemeMode } from '@/core/types';
import {
    Badge,
    Button,
    Card,
    SegmentedControl,
    SelectInput,
    ToastContainer,
    useIsMobileViewport,
} from '../components';
import {
    IconBolt,
    IconBookOpen,
    IconBot,
    IconClose,
    IconDatabase,
    IconFilter,
    IconFolder,
    IconGitBranch,
    IconMonitor,
    IconMoon,
    IconPlug,
    IconSun,
    IconTerminal,
    IconUpload,
    IconWrench,
} from '../components/Icons';
import {
    AppStore,
    AppStoreProvider,
    getDefaultAppStore,
    useAppStore,
    useAppStoreInstance,
} from '../store/app-store';
import {
    CONSOLE_TABS,
    CONSOLE_TAB_GROUPS,
    type ConsoleTabMeta,
    getConsoleTabMeta,
    useConsoleView,
} from '../store/view-registry';
import { ActiveAppModal } from './ImportEmbedModal';
import { AGENTIC_DIALOG_RESET_STYLES, AGENTIC_SHELL_STYLES } from './styles';

function TabIcon({ tabId }: { tabId: ConsoleTabId }) {
    switch (tabId) {
        case 'assistant':
            return (
                <svg
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    class="ag-icon"
                    aria-hidden="true"
                >
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    <path d="M9 10h.01" />
                    <path d="M12 10h.01" />
                    <path d="M15 10h.01" />
                </svg>
            );
        case 'sidegen':
            return (
                <svg
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    class="ag-icon"
                    aria-hidden="true"
                >
                    <circle cx="12" cy="12" r="2" />
                    <path d="M16.24 7.76a6 6 0 0 1 0 8.49" />
                    <path d="M7.76 16.24a6 6 0 0 1 0-8.49" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    <path d="M4.93 19.07a10 10 0 0 1 0-14.14" />
                </svg>
            );
        case 'files':
            return <IconFolder size={16} />;
        case 'logs':
            return <IconTerminal size={16} />;
        case 'cache':
            return <IconDatabase size={16} />;
        case 'prompts':
            return (
                <svg
                    width={16}
                    height={16}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.9}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    class="ag-icon"
                    aria-hidden="true"
                >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="8" y1="13" x2="16" y2="13" />
                    <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
            );
        case 'agents':
            return <IconBot size={16} />;
        case 'pipeline':
            return <IconGitBranch size={16} />;
        case 'tools':
            return <IconWrench size={16} />;
        case 'regex':
            return <IconFilter size={16} />;
        case 'wi':
            return <IconBookOpen size={16} />;
        case 'connections':
            return <IconPlug size={16} />;
    }
}

function nextThemeMode(current: ThemeMode): ThemeMode {
    if (current === 'dark') {
        return 'light';
    }
    if (current === 'light') {
        return 'auto';
    }
    return 'dark';
}

function themeModeLabel(mode: ThemeMode): string {
    if (mode === 'dark') {
        return '深色';
    }
    if (mode === 'light') {
        return '浅色';
    }
    return '自动';
}

function ThemeModeIcon({ mode }: { mode: ThemeMode }) {
    if (mode === 'dark') {
        return <IconMoon size={15} />;
    }
    if (mode === 'light') {
        return <IconSun size={15} />;
    }
    return <IconMonitor size={15} />;
}

function FallbackConsoleView({
    tabMeta,
    store,
}: {
    tabMeta: ConsoleTabMeta;
    store: AppStore;
    isMobile: boolean;
}) {
    const state = useAppStore();
    const activePreset = store.getActivePreset();
    const activeConnection = store.getActiveConnection();

    return (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                <Card
                    title={`${tabMeta.groupLabel} · ${tabMeta.label}`}
                    subtitle={tabMeta.description}
                    actions={<Badge tone="primary">待注册业务视图 ({tabMeta.id})</Badge>}
                >
                    <div class="ag-stack-v">
                        <div class="ag-banner ag-banner-primary">
                            视图模块 <span class="ag-mono">{tabMeta.id}</span> 将由 Wave 3 通过{' '}
                            <span class="ag-mono">registerConsoleView(&apos;{tabMeta.id}&apos;, Component)</span>{' '}
                            动态挂载，无需修改 <span class="ag-mono">AgenticAppShell</span>。
                        </div>

                        <div class="ag-grid-3">
                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">当前预设</div>
                                    <div style={{ fontWeight: 600, marginTop: '4px' }}>
                                        {activePreset.name}
                                    </div>
                                    <div class="ag-field-hint">
                                        {Object.keys(activePreset.agents).length} 个智能体 ·{' '}
                                        {activePreset.triggers.length} 条触发器
                                    </div>
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">主连接模型</div>
                                    <div style={{ fontWeight: 600, marginTop: '4px' }}>
                                        {activeConnection.name}
                                    </div>
                                    <div class="ag-field-hint ag-mono">
                                        {activeConnection.model || '(未配置 Model)'}
                                    </div>
                                </div>
                            </div>

                            <div class="ag-card">
                                <div class="ag-card-body">
                                    <div class="ag-field-label">因果锚点 / 轨迹</div>
                                    <div style={{ fontWeight: 600, marginTop: '4px' }} class="ag-mono">
                                        #{state.activeTarget.messageId}#{state.activeTarget.swipeId}
                                    </div>
                                    <div class="ag-field-hint">
                                        {state.traces.length} 条运行轨迹 · {state.backgroundTasks.length} 个后台任务
                                    </div>
                                </div>
                            </div>
                        </div>

                        {(state.deepLink.messageId !== undefined || state.deepLink.filePath) ? (
                            <div class="ag-banner ag-banner-success">
                                深链接参数：
                                {state.deepLink.messageId !== undefined
                                    ? ` messageId=#${state.deepLink.messageId}`
                                    : ''}
                                {state.deepLink.swipeId !== undefined
                                    ? ` swipeId=#${state.deepLink.swipeId}`
                                    : ''}
                                {state.deepLink.filePath
                                    ? ` filePath=${state.deepLink.filePath}`
                                    : ''}
                            </div>
                        ) : null}

                        <div class="ag-row-wrap">
                            <Button
                                variant="secondary"
                                size="sm"
                                icon={<IconUpload size={14} />}
                                onClick={() => store.openModal({ kind: 'import_manager' })}
                            >
                                测试导入 / 迁移与角色卡嵌入面板
                            </Button>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    store.pushToast(
                                        `当前视图 ${tabMeta.label} 就绪 (${state.resolvedTheme} 主题)`,
                                        'primary',
                                    )
                                }
                            >
                                测试 Shadow DOM 通知
                            </Button>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    );
}

function AgenticShellContent() {
    const store = useAppStoreInstance();
    const isMobile = useIsMobileViewport();
    const activeTab = useAppStore((s) => s.activeTab);
    const mobileAssistantStack = useAppStore((s) => s.mobileAssistantStack);
    const assistantPendingApprovals = useAppStore((s) => s.assistantPendingApprovals);
    const runMode = useAppStore((s) => s.runMode);
    const themeMode = useAppStore((s) => s.themeMode);
    const isMaximized = useAppStore((s) => s.isMaximized);
    const settings = useAppStore((s) => s.settings);
    const toastQueue = useAppStore((s) => s.toastQueue);

    const RegisteredView = useConsoleView(activeTab);
    const activeTabMeta = getConsoleTabMeta(activeTab);

    // CRITICAL Mobile (< 768px) Stacking Rule (OFF_MAINLINE_PLAN.md §6.2):
    // Hide top console header and mobile tab bar while inside an assistant chat detail thread.
    const hideMobileChrome =
        isMobile && activeTab === 'assistant' && mobileAssistantStack === 'detail';

    const pendingApprovalCount = useMemo(
        () => assistantPendingApprovals.filter((item) => item.status === 'pending').length,
        [assistantPendingApprovals],
    );

    const connectionOptions = useMemo(
        () =>
            Object.values(settings.connections).map((conn) => ({
                value: conn.id,
                label: conn.name,
            })),
        [settings.connections],
    );

    const presetOptions = useMemo(
        () =>
            Object.values(settings.presets).map((preset) => ({
                value: preset.id,
                label: preset.name,
            })),
        [settings.presets],
    );

    const runModeOptions = useMemo(
        () =>
            [
                { value: 'off', label: '关闭', title: '扩展完全休眠' },
                { value: 'companion', label: '伴生', title: '保留 ST 原生生成 + 后台触发' },
                { value: 'takeover', label: '接管', title: 'ST-Agentic 全链路接管与缓存优化' },
            ] as const,
        [],
    );

    const stopKeyPropagation = (event: TargetedKeyboardEvent<HTMLDivElement>) => {
        event.stopPropagation();
    };

    return (
        <div
            class="ag-console"
            data-maximized={isMaximized ? 'true' : 'false'}
            data-mobile-chrome-hidden={hideMobileChrome ? 'true' : 'false'}
            onKeyDown={stopKeyPropagation}
            onKeyUp={stopKeyPropagation}
        >
            {/* Header Bar & Mobile Horizontal Group Navigation (auto-hidden in mobile assistant detail) */}
            {!hideMobileChrome ? (
                <Fragment>
                    <header class="ag-header">
                        <div
                            class="ag-brand"
                            title={!isMobile ? '双击切换网页全屏 / 还原窗口' : undefined}
                            onDblClick={() => {
                                if (!isMobile) {
                                    store.toggleMaximized();
                                }
                            }}
                        >
                            <span class="ag-brand-logo" aria-hidden="true">
                                <IconBolt size={17} />
                            </span>
                            <span class="ag-brand-title">ST-Agentic</span>
                            <span class="ag-isolation-pill">Shadow DOM 隔离</span>
                        </div>

                        <div class="ag-header-controls">
                            <SegmentedControl<RunMode>
                                ariaLabel="运行模式"
                                value={runMode}
                                options={runModeOptions}
                                onChange={(mode) => {
                                    void store.setRunMode(mode);
                                }}
                            />

                            <div class="ag-header-select-wrap">
                                <SelectInput
                                    ariaLabel="主 API 连接"
                                    className="ag-header-select"
                                    value={settings.currentConnectionId}
                                    options={connectionOptions}
                                    onChange={(id) => {
                                        void store.setCurrentConnection(id);
                                    }}
                                />
                                <SelectInput
                                    ariaLabel="当前预设"
                                    className="ag-header-select"
                                    value={settings.currentPresetId}
                                    options={presetOptions}
                                    onChange={(id) => {
                                        void store.setCurrentPreset(id);
                                    }}
                                />
                            </div>

                            <div class="ag-header-actions">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    ariaLabel={`切换主题（当前：${themeModeLabel(themeMode)}）`}
                                    title={`主题模式：${themeModeLabel(themeMode)}（点击切换 深色 / 浅色 / 自动）`}
                                    icon={<ThemeModeIcon mode={themeMode} />}
                                    onClick={() => {
                                        void store.setThemeMode(
                                            nextThemeMode(store.getSnapshot().themeMode),
                                        );
                                    }}
                                >
                                    {themeModeLabel(themeMode)}
                                </Button>

                                <Button
                                    variant="secondary"
                                    size="sm"
                                    ariaLabel="导入、导出与角色卡嵌入"
                                    icon={<IconUpload size={15} />}
                                    onClick={() => store.openModal({ kind: 'import_manager' })}
                                >
                                    导入 / 嵌卡
                                </Button>

                                {!isMobile ? (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        ariaLabel={isMaximized ? '还原窗口' : '网页全屏'}
                                        title={isMaximized ? '还原窗口' : '网页全屏'}
                                        className="ag-window-toggle-btn"
                                        onClick={() => store.toggleMaximized()}
                                    >
                                        <span aria-hidden="true" style={{ fontSize: '15px', lineHeight: 1 }}>
                                            {isMaximized ? '🪟' : '🖥️'}
                                        </span>
                                    </Button>
                                ) : null}

                                <Button
                                    variant="ghost"
                                    size="sm"
                                    ariaLabel="关闭控制台"
                                    title="关闭控制台"
                                    icon={<IconClose size={17} />}
                                    onClick={() => store.closeConsole()}
                                />
                            </div>
                        </div>
                    </header>

                    {/* Mobile Horizontal Group Navigation (< 768px) */}
                    <nav class="ag-mobile-nav ag-mobile-tabs ag-thin-scroll" aria-label="控制台导航">
                        {CONSOLE_TABS.map((tab, index) => {
                            const prev = index > 0 ? CONSOLE_TABS[index - 1] : null;
                            const showDivider = prev !== null && prev.group !== tab.group;
                            const isActive = activeTab === tab.id;
                            return (
                                <Fragment key={tab.id}>
                                    {showDivider ? (
                                        <span
                                            class="ag-mobile-nav-divider"
                                            aria-hidden="true"
                                        />
                                    ) : null}
                                    <button
                                        type="button"
                                        data-tab-id={tab.id}
                                        class={
                                            isActive
                                                ? 'ag-mobile-tab ag-mobile-tab-active'
                                                : 'ag-mobile-tab'
                                        }
                                        aria-current={isActive ? 'page' : undefined}
                                        onClick={() => store.setActiveTab(tab.id)}
                                    >
                                        <TabIcon tabId={tab.id} />
                                        <span>{tab.shortLabel}</span>
                                        {tab.id === 'assistant' && pendingApprovalCount > 0 ? (
                                            <span class="ag-nav-count-badge">
                                                {pendingApprovalCount}
                                            </span>
                                        ) : null}
                                    </button>
                                </Fragment>
                            );
                        })}
                    </nav>
                </Fragment>
            ) : null}

            {/* Body: Desktop Sidebar + Active View Slot */}
            <div class="ag-body">
                <aside class="ag-sidebar ag-thin-scroll" aria-label="功能模块">
                    {CONSOLE_TAB_GROUPS.map((group) => (
                        <div key={group.id} class="ag-nav-group">
                            <div class="ag-nav-group-label">{group.label}</div>
                            {CONSOLE_TABS.filter((tab) => tab.group === group.id).map((tab) => {
                                const isActive = activeTab === tab.id;
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        data-tab-id={tab.id}
                                        class={isActive ? 'ag-nav-item ag-nav-item-active' : 'ag-nav-item'}
                                        aria-current={isActive ? 'page' : undefined}
                                        onClick={() => store.setActiveTab(tab.id)}
                                    >
                                        <span class="ag-nav-item-icon">
                                            <TabIcon tabId={tab.id} />
                                        </span>
                                        <span class="ag-nav-item-text">
                                            <span class="ag-nav-item-label-row">
                                                <span class="ag-nav-item-label">{tab.label}</span>
                                                {tab.id === 'assistant' && pendingApprovalCount > 0 ? (
                                                    <span
                                                        class={
                                                            isActive
                                                                ? 'ag-nav-count-badge ag-nav-count-badge-on-active'
                                                                : 'ag-nav-count-badge'
                                                        }
                                                    >
                                                        {pendingApprovalCount}
                                                    </span>
                                                ) : null}
                                            </span>
                                            <span class="ag-nav-item-desc">{tab.description}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                </aside>

                <main class="ag-main">
                    {RegisteredView ? (
                        <RegisteredView store={store} isMobile={isMobile} />
                    ) : (
                        <FallbackConsoleView
                            tabMeta={activeTabMeta}
                            store={store}
                            isMobile={isMobile}
                        />
                    )}
                </main>
            </div>

            <ActiveAppModal />
            <ToastContainer
                toasts={toastQueue}
                onDismiss={(id) => store.dismissToast(id)}
            />
        </div>
    );
}

export interface AgenticAppShellProps {
    store?: AppStore;
}

/**
 * Isolated Unified Console Shell (`<dialog id="agentic-app">` + `Shadow DOM`).
 * - Top Layer `<dialog>` floats above SillyTavern z-index stacks.
 * - Inner ShadowRoot uses `:host { all: initial }` + self-contained stylesheet.
 * - Stops `keydown`/`keyup` propagation at the dialog boundary so arrow keys
 *   inside inputs never trigger SillyTavern chat Swipe.
 */
export function AgenticAppShell({ store: propStore }: AgenticAppShellProps) {
    const contextStore = useAppStoreInstance();
    const store = propStore ?? contextStore;

    const dialogRef = useRef<HTMLDialogElement | null>(null);
    const shadowHostRef = useRef<HTMLDivElement | null>(null);
    const mountTargetRef = useRef<HTMLDivElement | null>(null);

    const isOpen = useAppStore((s) => s.isOpen);
    const isMaximized = useAppStore((s) => s.isMaximized);
    const resolvedTheme = useAppStore((s) => s.resolvedTheme);
    const themeMode = useAppStore((s) => s.themeMode);

    // Attach ShadowRoot once and render Preact tree inside it.
    useEffect(() => {
        const hostEl = shadowHostRef.current;
        if (!hostEl) {
            return;
        }

        const shadowRoot = hostEl.shadowRoot ?? hostEl.attachShadow({ mode: 'open' });

        let styleEl = shadowRoot.querySelector('style[data-agentic-styles]') as HTMLStyleElement | null;
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.setAttribute('data-agentic-styles', 'true');
            styleEl.textContent = AGENTIC_SHELL_STYLES;
            shadowRoot.appendChild(styleEl);
        }

        let mountEl = shadowRoot.querySelector('div[data-agentic-mount]') as HTMLDivElement | null;
        if (!mountEl) {
            mountEl = document.createElement('div');
            mountEl.setAttribute('data-agentic-mount', 'true');
            shadowRoot.appendChild(mountEl);
        }
        mountTargetRef.current = mountEl;

        render(
            <AppStoreProvider store={store}>
                <AgenticShellContent />
            </AppStoreProvider>,
            mountEl,
        );

        return () => {
            if (mountTargetRef.current) {
                render(null, mountTargetRef.current);
            }
        };
    }, [store]);

    // Sync `data-theme` attribute on the shadow host whenever resolved theme changes.
    useEffect(() => {
        const hostEl = shadowHostRef.current;
        if (hostEl) {
            hostEl.setAttribute('data-theme', resolvedTheme);
        }
    }, [resolvedTheme]);

    // Sync `<dialog id="agentic-app">` open state via native Top Layer API.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }

        if (isOpen) {
            store.refreshResolvedTheme();
            if (!dialog.open) {
                if (typeof dialog.showModal === 'function') {
                    try {
                        dialog.showModal();
                    } catch {
                        dialog.setAttribute('open', '');
                    }
                } else {
                    dialog.setAttribute('open', '');
                }
            }
        } else if (dialog.open || dialog.hasAttribute('open')) {
            if (typeof dialog.close === 'function') {
                try {
                    dialog.close();
                } catch {
                    dialog.removeAttribute('open');
                }
            } else {
                dialog.removeAttribute('open');
            }
        }
    }, [isOpen, store]);

    // Intercept Escape / native dialog cancel & close, plus keyboard event boundary guard.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) {
            return;
        }

        const handleKeyBoundary = (event: KeyboardEvent) => {
            event.stopPropagation();
        };

        const handleCancel = (event: Event) => {
            const snap = store.getSnapshot();
            if (snap.activeModal) {
                event.preventDefault();
                store.closeModal();
                return;
            }
            store.closeConsole();
        };

        const handleClose = () => {
            if (store.getSnapshot().isOpen) {
                store.closeConsole();
            }
        };

        dialog.addEventListener('keydown', handleKeyBoundary);
        dialog.addEventListener('keyup', handleKeyBoundary);
        dialog.addEventListener('cancel', handleCancel);
        dialog.addEventListener('close', handleClose);

        return () => {
            dialog.removeEventListener('keydown', handleKeyBoundary);
            dialog.removeEventListener('keyup', handleKeyBoundary);
            dialog.removeEventListener('cancel', handleCancel);
            dialog.removeEventListener('close', handleClose);
        };
    }, [store]);

    // Track `window.visualViewport` height on mobile (< 768px) to avoid virtual keyboard clipping.
    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || typeof window === 'undefined') {
            return;
        }

        const syncViewportHeight = () => {
            const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
            if (viewportWidth < 768) {
                const heightPx = Math.round(window.visualViewport?.height ?? window.innerHeight);
                dialog.style.setProperty('--ag-viewport-height', `${heightPx}px`);
            } else {
                dialog.style.removeProperty('--ag-viewport-height');
            }
        };

        syncViewportHeight();
        window.addEventListener('resize', syncViewportHeight);
        window.visualViewport?.addEventListener('resize', syncViewportHeight);
        window.visualViewport?.addEventListener('scroll', syncViewportHeight);

        return () => {
            window.removeEventListener('resize', syncViewportHeight);
            window.visualViewport?.removeEventListener('resize', syncViewportHeight);
            window.visualViewport?.removeEventListener('scroll', syncViewportHeight);
        };
    }, [isOpen]);

    // Watch host theme changes when `themeMode === 'auto'`.
    useEffect(() => {
        if (themeMode !== 'auto' || !isOpen || typeof window === 'undefined') {
            return;
        }

        store.refreshResolvedTheme();

        const observer =
            typeof MutationObserver !== 'undefined'
                ? new MutationObserver(() => {
                    store.refreshResolvedTheme();
                })
                : null;

        if (observer && typeof document !== 'undefined') {
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'style', 'data-theme'],
            });
            if (document.body) {
                observer.observe(document.body, {
                    attributes: true,
                    attributeFilter: ['class', 'style', 'data-theme'],
                });
            }
        }

        const mql =
            typeof window.matchMedia === 'function'
                ? window.matchMedia('(prefers-color-scheme: light)')
                : null;
        const handleMediaChange = () => store.refreshResolvedTheme();
        mql?.addEventListener('change', handleMediaChange);

        return () => {
            observer?.disconnect();
            mql?.removeEventListener('change', handleMediaChange);
        };
    }, [isOpen, store, themeMode]);

    return (
        <dialog
            id="agentic-app"
            ref={dialogRef}
            data-maximized={isMaximized ? 'true' : 'false'}
            onClick={(event) => {
                if (event.target === dialogRef.current) {
                    if (store.getSnapshot().activeModal) {
                        store.closeModal();
                    } else {
                        store.closeConsole();
                    }
                }
            }}
        >
            <style data-agentic-dialog-reset="true">{AGENTIC_DIALOG_RESET_STYLES}</style>
            <div
                data-agentic-shadow-host="true"
                data-theme={resolvedTheme}
                data-maximized={isMaximized ? 'true' : 'false'}
                ref={shadowHostRef}
            />
        </dialog>
    );
}

export interface MountedAgenticShell {
    store: AppStore;
    container: HTMLElement;
    unmount: () => void;
}

/**
 * Imperatively mount `<AgenticAppShell />` into a host container (defaults to `document.body`).
 */
export function mountAgenticAppShell(options: {
    container?: HTMLElement;
    store?: AppStore;
} = {}): MountedAgenticShell {
    const store = options.store ?? getDefaultAppStore();
    const targetParent = options.container ?? document.body;
    const mountWrapper = document.createElement('div');
    mountWrapper.setAttribute('data-agentic-shell-root', 'true');
    targetParent.appendChild(mountWrapper);

    render(
        <AppStoreProvider store={store}>
            <AgenticAppShell store={store} />
        </AppStoreProvider>,
        mountWrapper,
    );

    return {
        store,
        container: mountWrapper,
        unmount: () => {
            render(null, mountWrapper);
            mountWrapper.remove();
        },
    };
}
