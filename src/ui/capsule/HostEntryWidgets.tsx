import { render } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { MessageTarget, RunMode } from '@/core/types';
import {
    type AppStore,
    type AppStoreState,
    getDefaultAppStore,
} from '@/ui/store';

function useWidgetStoreSlice<T>(
    store: AppStore,
    selector: (state: AppStoreState) => T,
): T {
    const selectorRef = useRef(selector);
    selectorRef.current = selector;

    const [selected, setSelected] = useState<T>(() => selectorRef.current(store.getSnapshot()));
    const latestRef = useRef<T>(selected);
    latestRef.current = selected;

    useEffect(() => {
        const sync = () => {
            const next = selectorRef.current(store.getSnapshot());
            if (!Object.is(latestRef.current, next)) {
                latestRef.current = next;
                setSelected(next);
            }
        };
        sync();
        return store.subscribe(sync);
    }, [store]);

    return selected;
}

const RUN_MODE_META: Record<
    RunMode,
    { label: string; shortLabel: string; desc: string }
> = {
    off: {
        label: '已关闭',
        shortLabel: '关闭',
        desc: '扩展完全休眠：走酒馆原生生成，不拦截也不触发后台 Agent。',
    },
    companion: {
        label: '伴生模式',
        shortLabel: '伴生',
        desc: '主回复走 ST 原生管线；保留后台触发、世界书覆写与状态胶囊。',
    },
    takeover: {
        label: '完全接管',
        shortLabel: '接管',
        desc: 'ST-Agentic 全链路接管单聊：三层 KV Cache、VFS 工具与 0ms 流式上屏。',
    },
};

const EXTENSIONS_CARD_STYLES = `
.agentic_settings .ag-ext-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 4px 2px 6px;
}
.agentic_settings .ag-ext-header-status {
    font-weight: 400;
    opacity: 0.75;
}
.agentic_settings .ag-ext-modes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
}
.agentic_settings .ag-ext-mode-btn {
    width: auto;
    margin: 0;
    justify-content: center;
    white-space: nowrap;
    opacity: 0.72;
}
.agentic_settings .ag-ext-mode-btn[data-active="true"] {
    opacity: 1;
    font-weight: 700;
    filter: none;
    border-color: var(--SmartThemeQuoteColor, currentColor);
}
.agentic_settings .ag-ext-desc {
    display: block;
    opacity: 0.75;
    line-height: 1.4;
}
.agentic_settings .ag-ext-select {
    width: 100%;
    margin: 0;
}
.agentic_settings .ag-ext-open-btn {
    width: 100%;
    justify-content: center;
    margin: 2px 0 0;
}
`;

export interface ExtensionsSettingsCardProps {
    store?: AppStore;
    className?: string;
}

/**
 * Native SillyTavern `.inline-drawer` settings block for `#extensions_settings`:
 * 3-mode selector (`off` | `companion` | `takeover`), preset selector,
 * status summary in the collapsible header, and an `[打开控制台]` button.
 */
export function ExtensionsSettingsCard({
    store: propStore,
    className,
}: ExtensionsSettingsCardProps) {
    const store = propStore ?? getDefaultAppStore();
    const runMode = useWidgetStoreSlice(store, (s) => s.runMode);
    const currentPresetId = useWidgetStoreSlice(store, (s) => s.settings.currentPresetId);
    const presets = useWidgetStoreSlice(store, (s) => s.settings.presets);

    const presetList = useMemo(() => Object.values(presets), [presets]);
    const modeMeta = RUN_MODE_META[runMode];

    return (
        <div
            class={className ? `agentic_settings ${className}` : 'agentic_settings'}
            data-agentic-settings-card="true"
        >
            <style data-agentic-ext-card-styles="true">{EXTENSIONS_CARD_STYLES}</style>

            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>
                        ST-Agentic
                        <small class="ag-ext-header-status" data-status-mode={runMode}>
                            {' · '}
                            {modeMeta.label}
                        </small>
                    </b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down" />
                </div>

                <div class="inline-drawer-content">
                    <div class="ag-ext-content">
                        <label>运行模式</label>
                        <div
                            class="flex-container flexGap5 ag-ext-modes"
                            role="group"
                            aria-label="ST-Agentic 运行模式"
                        >
                            {(['off', 'companion', 'takeover'] as const).map((mode) => {
                                const active = runMode === mode;
                                return (
                                    <div
                                        key={mode}
                                        role="button"
                                        tabIndex={0}
                                        class="menu_button ag-ext-mode-btn"
                                        data-mode={mode}
                                        data-active={active ? 'true' : 'false'}
                                        aria-pressed={active}
                                        onClick={() => void store.setRunMode(mode)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter' || event.key === ' ') {
                                                event.preventDefault();
                                                void store.setRunMode(mode);
                                            }
                                        }}
                                    >
                                        {RUN_MODE_META[mode].shortLabel}
                                    </div>
                                );
                            })}
                        </div>

                        <small class="ag-ext-desc">{modeMeta.desc}</small>

                        <label for="agentic_ext_preset_select">当前预设</label>
                        <select
                            id="agentic_ext_preset_select"
                            class="text_pole ag-ext-select"
                            value={currentPresetId}
                            onChange={(event) => {
                                void store.setCurrentPreset(event.currentTarget.value);
                            }}
                        >
                            {presetList.map((preset) => (
                                <option key={preset.id} value={preset.id}>
                                    {preset.name}
                                </option>
                            ))}
                        </select>

                        <div
                            role="button"
                            tabIndex={0}
                            class="menu_button menu_button_icon ag-ext-open-btn"
                            onClick={() => store.openConsole()}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    store.openConsole();
                                }
                            }}
                        >
                            <i class="fa-solid fa-sliders" aria-hidden="true" />
                            <span>打开控制台</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

/**
 * Mount `<ExtensionsSettingsCard />` into a host container (such as `#extensions_settings`)
 * and return an unmount cleanup callback.
 */
export function mountExtensionsSettingsCard(
    container: HTMLElement,
    store: AppStore = getDefaultAppStore(),
): () => void {
    const existing = container.querySelector('[data-agentic-settings-mount]');
    if (existing) {
        existing.remove();
    }

    const mountRoot = document.createElement('div');
    mountRoot.setAttribute('data-agentic-settings-mount', 'true');
    container.appendChild(mountRoot);

    render(<ExtensionsSettingsCard store={store} />, mountRoot);

    return () => {
        render(null, mountRoot);
        mountRoot.remove();
    };
}

export type ExtensionsMenuActionId = 'assistant' | 'rerun_after_turn';

export interface ExtensionsMenuOptions {
    target?: MessageTarget;
    onAction?: (action: ExtensionsMenuActionId) => void;
}

/**
 * Pure DOM helper building SillyTavern `#extensionsMenu` wand menu items
 * matching native `.list-group-item` / `fa-solid` / `.extensionsMenuExtensionButton` markup:
 * - `打开 Agentic 助手` -> opens console directly on `'assistant'`
 * - `重新运行后置触发` -> calls `services.rerunAfterTurn()` via `store.rerunAfterTurn()`
 */
export function buildExtensionsMenuItems(
    store: AppStore = getDefaultAppStore(),
    options: ExtensionsMenuOptions = {},
): HTMLElement[] {
    const specs: Array<{
        id: string;
        action: ExtensionsMenuActionId;
        iconClass: string;
        label: string;
        title: string;
        run: () => void;
    }> = [
        {
            id: 'agentic_menu_assistant',
            action: 'assistant',
            iconClass: 'fa-robot',
            label: '打开 Agentic 助手',
            title: '打开 ST-Agentic 独立助手工作台（4 档权限模式 · 0 占用主线上下文）',
            run: () => {
                const target = options.target ?? store.getSnapshot().activeTarget;
                store.openConsole('assistant', {
                    messageId: target.messageId,
                    swipeId: target.swipeId,
                });
                options.onAction?.('assistant');
            },
        },
        {
            id: 'agentic_menu_rerun_after',
            action: 'rerun_after_turn',
            iconClass: 'fa-rotate-right',
            label: '重新运行后置触发',
            title: '对当前楼层重新运行 after_turn 后台触发器',
            run: () => {
                void store.rerunAfterTurn(options.target).catch((error) => {
                    const msg = error instanceof Error ? error.message : String(error);
                    store.pushToast(`重新运行后置触发失败：${msg}`, 'error');
                });
                options.onAction?.('rerun_after_turn');
            },
        },
    ];

    return specs.map((spec) => {
        const row = document.createElement('div');
        row.id = spec.id;
        row.className = 'list-group-item flex-container flexGap5 interactable';
        row.setAttribute('data-agentic-menu-item', spec.action);
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = spec.title;

        const iconBox = document.createElement('div');
        iconBox.className = `fa-fw fa-solid ${spec.iconClass} extensionsMenuExtensionButton`;

        const labelSpan = document.createElement('span');
        labelSpan.textContent = spec.label;

        row.append(iconBox, labelSpan);
        row.addEventListener('click', () => {
            spec.run();
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                spec.run();
            }
        });

        return row;
    });
}

/**
 * Idempotently mount the ST-Agentic wand menu entries into `#extensionsMenu`
 * (or any supplied container) and return a cleanup function.
 */
export function mountExtensionsMenuItems(
    container: HTMLElement,
    store: AppStore = getDefaultAppStore(),
    options: ExtensionsMenuOptions = {},
): () => void {
    container
        .querySelectorAll('[data-agentic-menu-item]')
        .forEach((existing) => existing.remove());

    const items = buildExtensionsMenuItems(store, options);
    items.forEach((item) => container.appendChild(item));

    return () => {
        items.forEach((item) => item.remove());
    };
}
