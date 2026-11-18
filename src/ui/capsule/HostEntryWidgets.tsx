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
    { label: string; shortLabel: string; dotColor: string; desc: string }
> = {
    off: {
        label: '已关闭',
        shortLabel: '关闭',
        dotColor: '#9aa3b2',
        desc: '扩展完全休眠：走酒馆原生生成，不拦截也不触发后台 Agent。',
    },
    companion: {
        label: '伴生模式',
        shortLabel: '伴生',
        dotColor: '#34d399',
        desc: '主回复走 ST 原生管线；保留后台触发、世界书覆写与状态胶囊。',
    },
    takeover: {
        label: '完全接管',
        shortLabel: '接管',
        dotColor: '#6c8cff',
        desc: 'ST-Agentic 全链路接管单聊：三层 KV Cache、VFS 工具与 0ms 流式上屏。',
    },
};

const EXTENSIONS_CARD_STYLES = `
.ag-ext-card {
    box-sizing: border-box;
    width: 100%;
    padding: 12px;
    margin: 6px 0;
    border-radius: 12px;
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 140, 160, 0.35));
    background: var(--SmartThemeBlurTintColor, rgba(24, 27, 34, 0.86));
    color: var(--SmartThemeBodyColor, #e6e9ef);
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.45;
}
.ag-ext-card *, .ag-ext-card *::before, .ag-ext-card *::after {
    box-sizing: border-box;
}
.ag-ext-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
}
.ag-ext-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 14px;
}
.ag-ext-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 9px;
    border-radius: 9999px;
    border: 1px solid rgba(128, 140, 160, 0.35);
    font-size: 12px;
    font-weight: 600;
}
.ag-ext-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    display: inline-block;
    flex-shrink: 0;
}
.ag-ext-modes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    padding: 3px;
    border-radius: 10px;
    border: 1px solid rgba(128, 140, 160, 0.3);
    background: color-mix(in srgb, currentColor 7%, transparent);
}
.ag-ext-mode-btn {
    min-width: 40px;
    min-height: 40px;
    padding: 0 8px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
}
.ag-ext-mode-btn[data-active="true"] {
    background: #6c8cff;
    color: #ffffff;
}
.ag-ext-desc {
    margin: 0;
    font-size: 12px;
    opacity: 0.82;
}
.ag-ext-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.ag-ext-label {
    font-size: 12px;
    font-weight: 600;
    opacity: 0.85;
}
.ag-ext-select {
    width: 100%;
    min-height: 40px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid rgba(128, 140, 160, 0.4);
    background: var(--SmartThemeBlurTintColor, rgba(20, 22, 27, 0.9));
    color: inherit;
    font-size: 16px;
}
.ag-ext-open-btn {
    width: 100%;
    min-width: 40px;
    min-height: 40px;
    padding: 0 14px;
    border-radius: 9px;
    border: none;
    background: #6c8cff;
    color: #ffffff;
    font-size: 14px;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
}
.ag-ext-open-btn:hover {
    filter: brightness(1.06);
}
`;

export interface ExtensionsSettingsCardProps {
    store?: AppStore;
    className?: string;
}

/**
 * Minimalist host status card for SillyTavern's `#extensions_settings` drawer:
 * 3-mode selector (`off` | `companion` | `takeover`), preset selector,
 * status indicator dot, and a `>= 40x40px` `[打开控制台]` button.
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
            class={className ? `ag-ext-card ${className}` : 'ag-ext-card'}
            data-agentic-settings-card="true"
        >
            <style data-agentic-ext-card-styles="true">{EXTENSIONS_CARD_STYLES}</style>

            <div class="ag-ext-header">
                <div class="ag-ext-title">
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span>ST-Agentic</span>
                </div>
                <span class="ag-ext-status-pill" data-status-mode={runMode}>
                    <span
                        class="ag-ext-status-dot"
                        style={{ backgroundColor: modeMeta.dotColor }}
                        aria-hidden="true"
                    />
                    <span>{modeMeta.label}</span>
                </span>
            </div>

            <div class="ag-ext-modes" role="group" aria-label="ST-Agentic 运行模式">
                {(['off', 'companion', 'takeover'] as const).map((mode) => {
                    const active = runMode === mode;
                    return (
                        <button
                            key={mode}
                            type="button"
                            class="ag-ext-mode-btn"
                            data-mode={mode}
                            data-active={active ? 'true' : 'false'}
                            aria-pressed={active}
                            onClick={() => void store.setRunMode(mode)}
                        >
                            {RUN_MODE_META[mode].shortLabel}
                        </button>
                    );
                })}
            </div>

            <p class="ag-ext-desc">{modeMeta.desc}</p>

            <div class="ag-ext-field">
                <label class="ag-ext-label" for="agentic_ext_preset_select">
                    当前预设
                </label>
                <select
                    id="agentic_ext_preset_select"
                    class="ag-ext-select"
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
            </div>

            <button
                type="button"
                class="ag-ext-open-btn"
                onClick={() => store.openConsole()}
            >
                <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                >
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                </svg>
                <span>打开控制台</span>
            </button>
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

export type ExtensionsMenuActionId = 'files' | 'logs' | 'rerun_after_turn';

export interface ExtensionsMenuOptions {
    target?: MessageTarget;
    onAction?: (action: ExtensionsMenuActionId) => void;
}

function createMenuSvgIcon(action: ExtensionsMenuActionId): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    if (action === 'files') {
        const path = document.createElementNS(ns, 'path');
        path.setAttribute(
            'd',
            'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z',
        );
        svg.appendChild(path);
        return svg;
    }

    if (action === 'logs') {
        const poly = document.createElementNS(ns, 'polyline');
        poly.setAttribute('points', '4 17 10 11 4 5');
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', '12');
        line.setAttribute('y1', '19');
        line.setAttribute('x2', '20');
        line.setAttribute('y2', '19');
        svg.append(poly, line);
        return svg;
    }

    const p1 = document.createElementNS(ns, 'polyline');
    p1.setAttribute('points', '23 4 23 10 17 10');
    const p2 = document.createElementNS(ns, 'polyline');
    p2.setAttribute('points', '1 20 1 14 7 14');
    const p3 = document.createElementNS(ns, 'path');
    p3.setAttribute(
        'd',
        'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    );
    svg.append(p1, p2, p3);
    return svg;
}

/**
 * Pure DOM helper building SillyTavern `#extensionsMenu` wand menu items:
 * - `文件与内容覆盖` -> opens console at `'files'`
 * - `查看生成日志` -> opens console at `'logs'`
 * - `重新运行后置触发` -> calls `services.rerunAfterTurn()` via `store.rerunAfterTurn()`
 */
export function buildExtensionsMenuItems(
    store: AppStore = getDefaultAppStore(),
    options: ExtensionsMenuOptions = {},
): HTMLElement[] {
    const specs: Array<{
        id: string;
        action: ExtensionsMenuActionId;
        label: string;
        title: string;
        run: () => void;
    }> = [
        {
            id: 'agentic_menu_files',
            action: 'files',
            label: '文件与内容覆盖',
            title: '打开 ST-Agentic 控制台查看工作区、变量与世界书 Diff',
            run: () => {
                const target = options.target ?? store.getSnapshot().activeTarget;
                store.openConsole('files', {
                    messageId: target.messageId,
                    swipeId: target.swipeId,
                });
                options.onAction?.('files');
            },
        },
        {
            id: 'agentic_menu_logs',
            action: 'logs',
            label: '查看生成日志',
            title: '打开 ST-Agentic 控制台查看生成与工具调用日志',
            run: () => {
                const target = options.target ?? store.getSnapshot().activeTarget;
                store.openConsole('logs', {
                    messageId: target.messageId,
                    swipeId: target.swipeId,
                });
                options.onAction?.('logs');
            },
        },
        {
            id: 'agentic_menu_rerun_after',
            action: 'rerun_after_turn',
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
        const wrapper = document.createElement('div');
        wrapper.id = spec.id;
        wrapper.className = 'extension_container interactable';
        wrapper.setAttribute('data-agentic-menu-item', spec.action);
        wrapper.tabIndex = 0;

        const row = document.createElement('div');
        row.className = 'list-group-item flex-container flexGap5 interactable';
        row.setAttribute('role', 'listitem');
        row.tabIndex = 0;
        row.title = spec.title;
        row.style.minHeight = '40px';
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '8px';
        row.style.cursor = 'pointer';

        const iconBox = document.createElement('div');
        iconBox.className = 'extensionsMenuExtensionButton';
        iconBox.style.display = 'inline-flex';
        iconBox.style.alignItems = 'center';
        iconBox.style.justifyContent = 'center';
        iconBox.appendChild(createMenuSvgIcon(spec.action));

        const labelSpan = document.createElement('span');
        labelSpan.textContent = spec.label;

        row.append(iconBox, labelSpan);
        row.addEventListener('click', (event) => {
            event.stopPropagation();
            spec.run();
        });
        row.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                spec.run();
            }
        });

        wrapper.appendChild(row);
        return wrapper;
    });
}

/**
 * Idempotently mount the 3 ST-Agentic wand menu entries into `#extensionsMenu`
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
