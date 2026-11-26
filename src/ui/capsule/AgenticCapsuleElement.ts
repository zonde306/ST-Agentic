import type {
    BackgroundTaskStatus,
    CapsulePersistMode,
    CapsulePosition,
    ConsoleTabId,
    GenerationEventPayload,
    InterruptedReason,
    MessageTarget,
    ThemeMode,
} from '@/core/types';
import {
    type AppStore,
    type DeepLinkState,
    type ResolvedTheme,
    detectHostLuminanceFromCssVars,
    getDefaultAppStore,
} from '@/ui/store';

export type CapsuleStatus =
    | 'idle'
    | 'retrieving'
    | 'streaming'
    | 'retrying'
    | 'done'
    | 'background-running'
    | 'interrupted'
    | 'error';

export interface CapsuleBadgeItem {
    label: string;
    tone?: 'neutral' | 'primary' | 'success' | 'warning' | 'error';
    tab?: ConsoleTabId;
    filePath?: string;
    viewMode?: 'edit' | 'diff';
}

export interface AgenticCapsuleData {
    messageId: number;
    swipeId: number;
    position: CapsulePosition;
    persistMode: CapsulePersistMode;
    theme: ThemeMode;
    status: CapsuleStatus;
    summary: string;
    stepCount: number;
    cacheHitRate?: number;
    currentStep?: string;
    errorMessage?: string;
    interruptedReason?: InterruptedReason;
    canResume?: boolean;
    retryAttempt?: number;
    retryMaxAttempts?: number;
    retryReason?: string;
    taskId?: string;
    taskLabel?: string;
    badges: CapsuleBadgeItem[];
    backgroundTasks: BackgroundTaskStatus[];
    onOpenConsole?: (tab: ConsoleTabId, deepLink: DeepLinkState) => void;
    onCancelTask?: (taskId: string) => void | Promise<void>;
    onResume?: () => void | Promise<void>;
}

const CAPSULE_OBSERVED_ATTRIBUTES = [
    'message-id',
    'swipe-id',
    'position',
    'persist-mode',
    'theme',
    'data-theme',
    'status',
    'summary',
    'step-count',
    'cache-hit-rate',
    'current-step',
    'task-id',
    'task-label',
    'error-message',
    'interrupted-reason',
    'can-resume',
    'retry-attempt',
    'retry-max-attempts',
    'retry-reason',
] as const;

const CAPSULE_STYLES = `
:host {
    all: initial;
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    /* Mirror .mes_text so the capsule never slides under ST's swipe chevron / counter. */
    padding-right: var(--mes-right-spacing, 0px);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    line-height: 1.4;
    -webkit-font-smoothing: antialiased;
}

:host([hidden]),
:host([data-hidden="true"]) {
    display: none !important;
}

:host([position="top"]) {
    margin: 4px 0 8px 0;
}

:host([position="bottom"]),
:host(:not([position])) {
    margin: 8px 0 4px 0;
}

*, *::before, *::after {
    box-sizing: border-box;
}

[hidden] {
    display: none !important;
}

.cap-shell {
    --cap-bg: var(--ag-cap-bg, #1f1f23);
    --cap-bg-hover: var(--ag-cap-bg-hover, #28282d);
    --cap-border: var(--ag-cap-border, #2a2a30);
    --cap-fg: var(--ag-cap-fg, #ececf1);
    --cap-muted: var(--ag-cap-muted, #a1a1ab);
    --cap-primary: var(--ag-cap-primary, #7d7bf6);
    --cap-success: var(--ag-cap-success, #4cc38a);
    --cap-warning: var(--ag-cap-warning, #e8a93c);
    --cap-error: var(--ag-cap-error, #f06470);
    --cap-accent: var(--cap-primary);
    --cap-hairline: color-mix(in srgb, var(--cap-fg) 8%, transparent);

    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    border-radius: 10px;
    border: 1px solid var(--cap-border);
    background: var(--cap-bg);
    color: var(--cap-fg);
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    color-scheme: dark;
    transition: border-color 0.2s;
}

.cap-shell[data-theme="light"] {
    --cap-bg: var(--ag-cap-bg, #f4f4f6);
    --cap-bg-hover: var(--ag-cap-bg-hover, #ebebef);
    --cap-border: var(--ag-cap-border, #e3e3e8);
    --cap-fg: var(--ag-cap-fg, #1a1a1f);
    --cap-muted: var(--ag-cap-muted, #62626d);
    --cap-primary: var(--ag-cap-primary, #5753e0);
    --cap-success: var(--ag-cap-success, #1a8a52);
    --cap-warning: var(--ag-cap-warning, #b5650b);
    --cap-error: var(--ag-cap-error, #d3344a);
    color-scheme: light;
}

/* Status accents (order matters: warning / error override the running tint). */
.cap-shell[data-status="done"] {
    --cap-accent: var(--cap-success);
}

.cap-shell[data-active="true"] {
    border-color: color-mix(in srgb, var(--cap-primary) 38%, var(--cap-border));
}

.cap-shell[data-status="interrupted"],
.cap-shell[data-status="retrying"] {
    --cap-accent: var(--cap-warning);
    border-color: color-mix(in srgb, var(--cap-warning) 45%, var(--cap-border));
}

.cap-shell[data-status="error"] {
    --cap-accent: var(--cap-error);
    border-color: color-mix(in srgb, var(--cap-error) 45%, var(--cap-border));
}

.cap-row {
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 2px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 2px;
    overflow: hidden;
}

.cap-open-btn {
    flex: 1 1 0%;
    min-width: 0;
    min-height: 40px;
    padding: 0 8px;
    margin: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    display: flex;
    align-items: center;
    gap: 8px;
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    transition: background-color 0.15s;
}

.cap-open-btn:hover {
    background: var(--cap-bg-hover);
}

.cap-open-btn:focus-visible,
.cap-badge-btn:focus-visible,
.cap-cancel-btn:focus-visible,
.cap-resume-btn:focus-visible,
.cap-tasks-toggle:focus-visible {
    outline: 1.5px solid color-mix(in srgb, var(--cap-primary) 70%, transparent);
    outline-offset: -3px;
}

.cap-indicator {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--cap-accent);
}

.cap-spinner {
    width: 12px;
    height: 12px;
    border-radius: 9999px;
    border: 1.75px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    animation: ag-cap-spin 0.8s linear infinite;
}

@keyframes ag-cap-spin {
    to { transform: rotate(360deg); }
}

@keyframes ag-cap-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
}

.cap-summary {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    color: var(--cap-fg);
}

.cap-summary-main {
    font-weight: 600;
}

.cap-summary-meta {
    color: var(--cap-muted);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
}

.cap-summary-meta::before {
    content: "·";
    margin: 0 6px;
    opacity: 0.7;
}

.cap-badges {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    display: inline-flex;
    align-items: center;
}

.cap-badges:empty {
    display: none;
}

.cap-badge-btn {
    flex: 0 1 auto;
    min-width: 40px;
    max-width: 100%;
    min-height: 40px;
    padding: 0 2px;
    margin: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    cursor: pointer;
}

.cap-badge-pill {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 160px;
    height: 20px;
    padding: 0 8px;
    border-radius: 9999px;
    overflow: hidden;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    background: color-mix(in srgb, var(--cap-primary) 12%, transparent);
    color: var(--cap-primary);
    transition: background-color 0.15s;
}

.cap-badge-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.cap-badge-pill[data-tone="success"] {
    background: color-mix(in srgb, var(--cap-success) 14%, transparent);
    color: var(--cap-success);
}

.cap-badge-pill[data-tone="warning"] {
    background: color-mix(in srgb, var(--cap-warning) 14%, transparent);
    color: var(--cap-warning);
}

.cap-badge-pill[data-tone="error"] {
    background: color-mix(in srgb, var(--cap-error) 14%, transparent);
    color: var(--cap-error);
}

.cap-badge-pill[data-tone="neutral"] {
    background: color-mix(in srgb, var(--cap-fg) 8%, transparent);
    color: var(--cap-muted);
}

.cap-task-area {
    display: contents;
}

/* Running background task chip: ● label 14s (x) */
.cap-task-group {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;
    overflow-x: clip;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 0 0 10px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--cap-primary) 13%, transparent);
    color: var(--cap-primary);
    font-size: 11.5px;
    font-weight: 600;
    transition: background-color 0.15s;
}

.cap-task-dot {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: currentColor;
    animation: ag-cap-pulse 1.4s ease-in-out infinite;
}

.cap-task-dot[data-state="queued"] {
    animation: none;
    opacity: 0.45;
}

.cap-task-text {
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.cap-task-timer {
    flex-shrink: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    opacity: 0.8;
}

/* 40x40 hit target; negative vertical margin keeps the visual chip slim. */
.cap-cancel-btn {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    margin: -7px 0 -7px -8px;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.cap-cancel-pill {
    width: 20px;
    height: 20px;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, currentColor 14%, transparent);
    transition: background-color 0.15s, color 0.15s;
}

.cap-cancel-btn:hover .cap-cancel-pill {
    background: color-mix(in srgb, var(--cap-error) 22%, transparent);
    color: var(--cap-error);
}

.cap-tasks-toggle {
    flex: 0 1 auto;
    min-width: 40px;
    max-width: 55%;
    min-height: 40px;
    padding: 0 2px;
    margin: 0;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: inherit;
    font: inherit;
    display: inline-flex;
    align-items: center;
    overflow: hidden;
    cursor: pointer;
}

.cap-tasks-toggle .cap-task-group {
    max-width: 100%;
    padding-right: 8px;
}

.cap-tasks-toggle:hover .cap-task-group,
.cap-tasks-toggle[aria-expanded="true"] .cap-task-group {
    background: color-mix(in srgb, var(--cap-primary) 20%, transparent);
}

.cap-chevron {
    flex-shrink: 0;
    transition: transform 0.2s;
}

.cap-tasks-toggle[aria-expanded="true"] .cap-chevron {
    transform: rotate(180deg);
}

.cap-resume-btn {
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
    padding: 0 2px;
    margin: 0;
    border: none;
    border-radius: 9999px;
    background: transparent;
    color: var(--cap-warning);
    font: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.cap-resume-pill {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 12px;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--cap-warning) 16%, transparent);
    font-weight: 600;
    white-space: nowrap;
    transition: background-color 0.15s;
}

.cap-resume-btn:hover:not(:disabled) .cap-resume-pill {
    background: color-mix(in srgb, var(--cap-warning) 26%, transparent);
}

.cap-resume-btn:disabled {
    opacity: 0.6;
    cursor: wait;
}

/* Expanded multi-task list */
.cap-panel {
    display: flex;
    flex-direction: column;
    max-height: 216px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 2px 4px;
    border-top: 1px solid var(--cap-hairline);
}

.cap-panel-item {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 40px;
    padding-left: 12px;
    border-radius: 8px;
    transition: background-color 0.15s;
}

.cap-panel-item:hover {
    background: var(--cap-bg-hover);
}

.cap-panel-item .cap-task-dot {
    color: var(--cap-primary);
}

.cap-panel-label {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
}

.cap-panel-step {
    flex: 1 1 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    color: var(--cap-muted);
}

.cap-panel-item .cap-task-timer {
    color: var(--cap-muted);
}

.cap-panel-item .cap-cancel-btn {
    margin: 0;
    color: var(--cap-muted);
}

/* Indeterminate activity bar along the bottom edge while anything is running. */
.cap-progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    overflow: hidden;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.25s;
}

.cap-shell[data-active="true"] .cap-progress {
    opacity: 1;
}

.cap-progress::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    background: linear-gradient(90deg, transparent, var(--cap-accent), transparent);
    transform: translateX(-100%);
    animation: ag-cap-slide 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes ag-cap-slide {
    from { transform: translateX(-100%); }
    to { transform: translateX(250%); }
}

@media (max-width: 767px) {
    .cap-badges {
        display: none;
    }

    .cap-task-group {
        max-width: 58%;
    }

    .cap-tasks-toggle {
        max-width: 58%;
    }
}

@media (prefers-reduced-motion: reduce) {
    .cap-spinner,
    .cap-task-dot,
    .cap-progress::before {
        animation: none;
    }
}
`;

function formatHitRatePercent(rate: number | undefined): string {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
        return '';
    }
    const pct = rate <= 1 ? rate * 100 : rate;
    return `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
}

function createStatusIconSvg(status: CapsuleStatus): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    if (status === 'interrupted') {
        const circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '9');
        const l1 = document.createElementNS(ns, 'line');
        l1.setAttribute('x1', '10');
        l1.setAttribute('y1', '9');
        l1.setAttribute('x2', '10');
        l1.setAttribute('y2', '15');
        const l2 = document.createElementNS(ns, 'line');
        l2.setAttribute('x1', '14');
        l2.setAttribute('y1', '9');
        l2.setAttribute('x2', '14');
        l2.setAttribute('y2', '15');
        svg.append(circle, l1, l2);
        return svg;
    }

    if (status === 'error') {
        const tri = document.createElementNS(ns, 'path');
        tri.setAttribute('d', 'm21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z');
        const l1 = document.createElementNS(ns, 'line');
        l1.setAttribute('x1', '12');
        l1.setAttribute('y1', '9');
        l1.setAttribute('x2', '12');
        l1.setAttribute('y2', '13');
        const l2 = document.createElementNS(ns, 'line');
        l2.setAttribute('x1', '12');
        l2.setAttribute('y1', '17');
        l2.setAttribute('x2', '12.01');
        l2.setAttribute('y2', '17');
        svg.append(tri, l1, l2);
        return svg;
    }

    if (status === 'done') {
        const poly = document.createElementNS(ns, 'polyline');
        poly.setAttribute('points', '20 6 9 17 4 12');
        svg.append(poly);
        return svg;
    }

    const bolt = document.createElementNS(ns, 'polygon');
    bolt.setAttribute('points', '13 2 3 14 12 14 11 22 21 10 12 10 13 2');
    svg.append(bolt);
    return svg;
}

const RUNNING_STATUSES: ReadonlySet<CapsuleStatus> = new Set<CapsuleStatus>([
    'retrieving',
    'streaming',
    'retrying',
    'background-running',
]);

const TASK_PANEL_ID = 'cap-task-panel';

function formatElapsed(startedAt: number, now = Date.now()): string {
    const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
    if (sec < 60) {
        return `${sec}s`;
    }
    const min = Math.floor(sec / 60);
    if (min < 60) {
        return `${min}m${String(sec % 60).padStart(2, '0')}s`;
    }
    const hr = Math.floor(min / 60);
    return `${hr}h${String(min % 60).padStart(2, '0')}m`;
}

function createStrokeIcon(size: number, strokeWidth: number, paths: string[]): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(strokeWidth));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    }
    return svg;
}

interface CapsuleSummaryParts {
    main: string;
    meta: string;
}

function joinMeta(parts: string[]): string {
    return parts.filter((p) => p.length > 0).join(' · ');
}

function buildSummaryParts(state: AgenticCapsuleData): CapsuleSummaryParts {
    const custom = state.summary.trim();
    if (custom) {
        return { main: custom, meta: '' };
    }

    const hitText = formatHitRatePercent(state.cacheHitRate);
    const steps = state.stepCount > 0 ? `${state.stepCount} 步` : '';
    const cache = hitText ? `缓存 ${hitText}` : '';

    switch (state.status) {
        case 'retrieving':
            return state.currentStep
                ? { main: `正在检索 ${state.currentStep}`, meta: '' }
                : { main: '正在检索资料', meta: `第 ${Math.max(1, state.stepCount)} 步` };
        case 'streaming':
            return { main: '正在生成正文', meta: joinMeta([steps, cache]) };
        case 'retrying': {
            const attempt = state.retryAttempt ?? 1;
            const maxAttempts = state.retryMaxAttempts;
            const progress =
                typeof maxAttempts === 'number' && maxAttempts > 0
                    ? ` ${attempt}/${maxAttempts}`
                    : ` ${attempt}`;
            return {
                main: `自动重试${progress}`,
                meta: state.retryReason?.trim() || '网络/模型异常',
            };
        }
        case 'background-running':
            return { main: '后台任务运行中', meta: joinMeta([steps, cache]) };
        case 'interrupted': {
            const resumable = state.canResume !== false;
            switch (state.interruptedReason) {
                case 'length':
                    return { main: '输出被截断', meta: resumable ? '可续写' : '' };
                case 'empty_output':
                    return { main: '未写入 /output.md', meta: resumable ? '可重试' : '' };
                case 'error':
                    return { main: '连接中断', meta: resumable ? '可恢复' : '' };
                case 'user_stop':
                default:
                    return { main: '已暂停', meta: resumable ? '可恢复' : '' };
            }
        }
        case 'error':
            return {
                main: '运行出错',
                meta: state.errorMessage?.trim() || '生成或后台任务发生错误',
            };
        case 'done':
            return { main: '已完成', meta: joinMeta([steps, cache]) || '点击查看日志' };
        case 'idle':
        default:
            return { main: 'ST-Agentic 就绪', meta: '点击查看日志' };
    }
}

const BaseHTMLElement = (
    typeof HTMLElement !== 'undefined' ? HTMLElement : class {}
) as typeof HTMLElement;

/**
 * Autonomous Shadow DOM Custom Element `<agentic-capsule>` mounted inside
 * SillyTavern `[mesid] > .mes_block` outside `.mes_text`.
 */
export class AgenticCapsuleElement extends BaseHTMLElement {
    static get observedAttributes(): readonly string[] {
        return CAPSULE_OBSERVED_ATTRIBUTES;
    }

    private _state: AgenticCapsuleData = {
        messageId: 0,
        swipeId: 0,
        position: 'bottom',
        persistMode: 'keep',
        theme: 'dark',
        status: 'idle',
        summary: '',
        stepCount: 0,
        badges: [],
        backgroundTasks: [],
    };

    private _store: AppStore | null = null;
    private _storeUnsubscribe: (() => void) | null = null;
    private _eventsUnsubscribe: (() => void) | null = null;
    private _timerId: ReturnType<typeof setInterval> | null = null;
    private _resumePending = false;
    private _shadow: ShadowRoot | null = null;
    private _shellEl: HTMLDivElement | null = null;
    private _openBtnEl: HTMLButtonElement | null = null;
    private _indicatorEl: HTMLSpanElement | null = null;
    private _summaryMainEl: HTMLSpanElement | null = null;
    private _summaryMetaEl: HTMLSpanElement | null = null;
    private _badgesEl: HTMLDivElement | null = null;
    private _resumeBtnEl: HTMLButtonElement | null = null;
    private _taskAreaEl: HTMLDivElement | null = null;
    private _panelEl: HTMLDivElement | null = null;
    private _tasksExpanded = false;

    constructor() {
        super();
        if (typeof this.attachShadow === 'function') {
            this._shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
            this.initShadowDom();
        }
    }

    connectedCallback(): void {
        if (!this.hasAttribute('position')) {
            this.setAttribute('position', this._state.position);
        }
        this.render();
        this.syncTicker();
    }

    disconnectedCallback(): void {
        this.stopTicker();
    }

    attributeChangedCallback(
        name: string,
        _oldValue: string | null,
        newValue: string | null,
    ): void {
        const val = newValue ?? '';
        switch (name) {
            case 'message-id': {
                const num = Number(val);
                if (Number.isFinite(num)) {
                    this._state.messageId = num;
                }
                break;
            }
            case 'swipe-id': {
                const num = Number(val);
                if (Number.isFinite(num)) {
                    this._state.swipeId = num;
                }
                break;
            }
            case 'position':
                this._state.position = val === 'top' ? 'top' : 'bottom';
                break;
            case 'persist-mode':
                this._state.persistMode = val === 'auto_hide' ? 'auto_hide' : 'keep';
                break;
            case 'theme':
            case 'data-theme':
                if (val === 'light' || val === 'dark' || val === 'auto') {
                    this._state.theme = val;
                }
                break;
            case 'status':
                if (
                    val === 'idle'
                    || val === 'retrieving'
                    || val === 'streaming'
                    || val === 'retrying'
                    || val === 'done'
                    || val === 'background-running'
                    || val === 'interrupted'
                    || val === 'error'
                ) {
                    this._state.status = val;
                }
                break;
            case 'summary':
                this._state.summary = val;
                break;
            case 'step-count': {
                const num = Number(val);
                if (Number.isFinite(num)) {
                    this._state.stepCount = num;
                }
                break;
            }
            case 'cache-hit-rate': {
                const num = Number(val);
                this._state.cacheHitRate = Number.isFinite(num) ? num : undefined;
                break;
            }
            case 'current-step':
                this._state.currentStep = val || undefined;
                break;
            case 'task-id':
                this._state.taskId = val || undefined;
                break;
            case 'task-label':
                this._state.taskLabel = val || undefined;
                break;
            case 'error-message':
                this._state.errorMessage = val || undefined;
                break;
            case 'interrupted-reason':
                if (
                    val === 'user_stop'
                    || val === 'length'
                    || val === 'error'
                    || val === 'empty_output'
                ) {
                    this._state.interruptedReason = val;
                } else if (!val) {
                    this._state.interruptedReason = undefined;
                }
                break;
            case 'can-resume':
                if (val === 'false' || val === '0') {
                    this._state.canResume = false;
                } else if (val === 'true' || val === '1' || newValue === '') {
                    this._state.canResume = true;
                } else if (newValue === null) {
                    this._state.canResume = undefined;
                }
                break;
            case 'retry-attempt': {
                const num = Number(val);
                this._state.retryAttempt = Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
                break;
            }
            case 'retry-max-attempts': {
                const num = Number(val);
                this._state.retryMaxAttempts =
                    Number.isFinite(num) && num > 0 ? Math.floor(num) : undefined;
                break;
            }
            case 'retry-reason':
                this._state.retryReason = val || undefined;
                break;
        }
        this.render();
        this.syncTicker();
    }

    getState(): AgenticCapsuleData {
        return {
            ...this._state,
            badges: [...this._state.badges],
            backgroundTasks: [...this._state.backgroundTasks],
        };
    }

    setState(patch: Partial<AgenticCapsuleData>): void {
        this._state = {
            ...this._state,
            ...patch,
            badges: patch.badges ? [...patch.badges] : this._state.badges,
            backgroundTasks: patch.backgroundTasks
                ? [...patch.backgroundTasks]
                : this._state.backgroundTasks,
        };
        if (
            patch.position
            && typeof this.getAttribute === 'function'
            && this.getAttribute('position') !== patch.position
        ) {
            this.setAttribute('position', patch.position);
        }
        if (patch.position && typeof this.closest === 'function') {
            const hostContainer =
                this.closest<HTMLElement>('.mes_block')
                ?? this.closest<HTMLElement>('.mes');
            if (hostContainer) {
                placeAgenticCapsule(hostContainer, this, patch.position);
            }
        }
        this.render();
        this.syncTicker();
    }

    get messageId(): number {
        return this._state.messageId;
    }
    set messageId(value: number) {
        this.setState({ messageId: value });
    }

    get swipeId(): number {
        return this._state.swipeId;
    }
    set swipeId(value: number) {
        this.setState({ swipeId: value });
    }

    get position(): CapsulePosition {
        return this._state.position;
    }
    set position(value: CapsulePosition) {
        this.setState({ position: value });
    }

    get persistMode(): CapsulePersistMode {
        return this._state.persistMode;
    }
    set persistMode(value: CapsulePersistMode) {
        this.setState({ persistMode: value });
    }

    get theme(): ThemeMode {
        return this._state.theme;
    }
    set theme(value: ThemeMode) {
        this.setState({ theme: value });
    }

    get status(): CapsuleStatus {
        return this._state.status;
    }
    set status(value: CapsuleStatus) {
        this.setState({ status: value });
    }

    get summary(): string {
        return this._state.summary;
    }
    set summary(value: string) {
        this.setState({ summary: value });
    }

    get stepCount(): number {
        return this._state.stepCount;
    }
    set stepCount(value: number) {
        this.setState({ stepCount: value });
    }

    get cacheHitRate(): number | undefined {
        return this._state.cacheHitRate;
    }
    set cacheHitRate(value: number | undefined) {
        this.setState({ cacheHitRate: value });
    }

    get backgroundTasks(): BackgroundTaskStatus[] {
        return [...this._state.backgroundTasks];
    }
    set backgroundTasks(value: BackgroundTaskStatus[]) {
        this.setState({ backgroundTasks: value });
    }

    get interruptedReason(): InterruptedReason | undefined {
        return this._state.interruptedReason;
    }
    set interruptedReason(value: InterruptedReason | undefined) {
        this.setState({ interruptedReason: value });
    }

    get canResume(): boolean | undefined {
        return this._state.canResume;
    }
    set canResume(value: boolean | undefined) {
        this.setState({ canResume: value });
    }

    /**
     * Bind this capsule to an `AppStore` for reactive theme/position/persistMode/task sync
     * and one-click deep linking into `<dialog id="agentic-app">`.
     */
    connectStore(store: AppStore, target?: MessageTarget): () => void {
        this._storeUnsubscribe?.();
        this._eventsUnsubscribe?.();
        this._eventsUnsubscribe = null;
        this._store = store;

        if (target) {
            this._state.messageId = target.messageId;
            this._state.swipeId = target.swipeId;
        }

        const handleGenerationEvent = (event: GenerationEventPayload) => {
            if (
                event.target.messageId !== this._state.messageId
                || event.target.swipeId !== this._state.swipeId
            ) {
                return;
            }

            if (event.kind === 'turn_retrying') {
                if (event.phase === 'after_turn' || event.phase === 'maintenance') {
                    return;
                }
                this.setState({
                    status: 'retrying',
                    retryAttempt: event.retryAttempt ?? 1,
                    retryMaxAttempts: event.retryMaxAttempts,
                    retryReason: event.retryReason,
                    summary: '',
                });
                return;
            }

            if (this._state.status === 'retrying') {
                if (
                    event.kind === 'text_delta'
                    || event.kind === 'reasoning_delta'
                    || event.kind === 'output_preview'
                ) {
                    this.setState({
                        status: 'streaming',
                        retryAttempt: undefined,
                        retryMaxAttempts: undefined,
                        retryReason: undefined,
                        summary: '',
                    });
                } else if (event.kind === 'tool_started') {
                    this.setState({
                        status: 'retrieving',
                        currentStep: event.toolStep ? `Tool: ${event.toolStep.toolName}` : undefined,
                        retryAttempt: undefined,
                        retryMaxAttempts: undefined,
                        retryReason: undefined,
                        summary: '',
                    });
                }
            }
        };

        const syncFromStore = () => {
            const snap = store.getSnapshot();
            const msgId = this._state.messageId;
            const swId = this._state.swipeId;

            const matchingTasks = snap.backgroundTasks.filter(
                (t) => t.target.messageId === msgId && t.target.swipeId === swId,
            );
            const matchingTraces = snap.traces.filter(
                (t) => t.target.messageId === msgId && t.target.swipeId === swId,
            );
            const mainTrace =
                matchingTraces.find((t) => t.phase === 'main_turn') ?? matchingTraces[0];

            const hasActiveTasks = matchingTasks.some(
                (t) => t.state === 'running' || t.state === 'queued',
            );

            let derivedStatus = this._state.status;
            if (mainTrace) {
                if (mainTrace.status === 'error') {
                    derivedStatus = 'error';
                } else if (mainTrace.status === 'interrupted') {
                    derivedStatus = 'interrupted';
                } else if (hasActiveTasks) {
                    derivedStatus =
                        this._state.status === 'retrying' && mainTrace.status === 'running'
                            ? 'retrying'
                            : 'background-running';
                } else if (mainTrace.status === 'completed') {
                    derivedStatus = 'done';
                } else if (
                    mainTrace.status === 'running'
                    && (this._state.status === 'interrupted' || this._state.status === 'idle')
                ) {
                    derivedStatus = 'streaming';
                }
            } else if (hasActiveTasks) {
                derivedStatus = 'background-running';
            }

            const clearRetryState = derivedStatus !== 'retrying';

            this.setState({
                theme: snap.themeMode === 'auto' ? snap.resolvedTheme : snap.themeMode,
                position: snap.settings.capsulePosition,
                persistMode: snap.settings.capsulePersistMode,
                backgroundTasks: matchingTasks,
                status: derivedStatus,
                ...(clearRetryState
                    ? {
                        retryAttempt: undefined,
                        retryMaxAttempts: undefined,
                        retryReason: undefined,
                    }
                    : {}),
                interruptedReason:
                    mainTrace?.status === 'interrupted'
                        ? (mainTrace.interruptedReason ?? this._state.interruptedReason)
                        : mainTrace?.status === 'completed' || mainTrace?.status === 'running'
                            ? undefined
                            : this._state.interruptedReason,
                errorMessage:
                    mainTrace?.status === 'error' || mainTrace?.status === 'interrupted'
                        ? (mainTrace.error ?? this._state.errorMessage)
                        : mainTrace?.status === 'completed' || mainTrace?.status === 'running'
                            ? undefined
                            : this._state.errorMessage,
                stepCount: mainTrace ? mainTrace.toolSteps.length : this._state.stepCount,
                cacheHitRate: mainTrace
                    ? mainTrace.usage.cacheHitRate
                        ?? (mainTrace.usage.inputTokens > 0
                            ? mainTrace.usage.cachedTokens / mainTrace.usage.inputTokens
                            : undefined)
                    : this._state.cacheHitRate,
            });
        };

        syncFromStore();
        this._storeUnsubscribe = store.subscribe(syncFromStore);
        if (store.services?.subscribeEvents) {
            this._eventsUnsubscribe = store.services.subscribeEvents(handleGenerationEvent);
        }
        return () => {
            this.disconnectStore();
        };
    }

    /** Detach any active `AppStore` subscription bound via `connectStore`. */
    disconnectStore(): void {
        this._storeUnsubscribe?.();
        this._storeUnsubscribe = null;
        this._eventsUnsubscribe?.();
        this._eventsUnsubscribe = null;
    }

    private resolveStore(): AppStore | null {
        if (this._store) {
            return this._store;
        }
        try {
            return getDefaultAppStore();
        } catch {
            return null;
        }
    }

    private resolveTheme(): ResolvedTheme {
        if (this._state.theme === 'light' || this._state.theme === 'dark') {
            return this._state.theme;
        }
        return detectHostLuminanceFromCssVars(this);
    }

    private getActiveBackgroundTasks(): BackgroundTaskStatus[] {
        const running = this._state.backgroundTasks.filter(
            (t) => t.state === 'running' || t.state === 'queued',
        );
        if (running.length > 0) {
            return running;
        }
        if (this._state.status === 'background-running') {
            return [
                {
                    taskId: this._state.taskId || `task_${this._state.messageId}_${this._state.swipeId}`,
                    target: {
                        messageId: this._state.messageId,
                        swipeId: this._state.swipeId,
                    },
                    phase: 'after_turn',
                    barrier: 'none',
                    agentProfileId: 'background',
                    label: this._state.taskLabel || '后台任务',
                    state: 'running',
                    startedAt: Date.now(),
                },
            ];
        }
        return [];
    }

    private initShadowDom(): void {
        const shadow = this._shadow;
        if (!shadow) {
            return;
        }

        const styleEl = document.createElement('style');
        styleEl.textContent = CAPSULE_STYLES;

        const shell = document.createElement('div');
        shell.className = 'cap-shell';

        const row = document.createElement('div');
        row.className = 'cap-row';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'cap-open-btn';
        openBtn.setAttribute('aria-label', '打开 ST-Agentic 控制台查看生成日志');

        const indicator = document.createElement('span');
        indicator.className = 'cap-indicator';

        const summary = document.createElement('span');
        summary.className = 'cap-summary';
        const summaryMain = document.createElement('span');
        summaryMain.className = 'cap-summary-main';
        const summaryMeta = document.createElement('span');
        summaryMeta.className = 'cap-summary-meta';
        summary.append(summaryMain, summaryMeta);

        openBtn.append(indicator, summary);
        openBtn.addEventListener('click', () => {
            this.handleOpenConsole('logs', {
                messageId: this._state.messageId,
                swipeId: this._state.swipeId,
            });
        });

        const badges = document.createElement('div');
        badges.className = 'cap-badges';

        const taskArea = document.createElement('div');
        taskArea.className = 'cap-task-area';

        const resumeBtn = document.createElement('button');
        resumeBtn.type = 'button';
        resumeBtn.className = 'cap-resume-btn';
        resumeBtn.setAttribute('data-action', 'resume');
        resumeBtn.setAttribute('aria-label', '恢复生成 /output.md');
        resumeBtn.title = '从中断点继续生成 /output.md';
        const resumePill = document.createElement('span');
        resumePill.className = 'cap-resume-pill';
        resumePill.textContent = '↻ 恢复';
        resumeBtn.appendChild(resumePill);
        resumeBtn.hidden = true;
        resumeBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            void this.handleResume();
        });

        row.append(openBtn, badges, taskArea, resumeBtn);

        const panel = document.createElement('div');
        panel.className = 'cap-panel';
        panel.id = TASK_PANEL_ID;
        panel.setAttribute('role', 'list');
        panel.setAttribute('aria-label', '后台任务列表');
        panel.hidden = true;

        const progress = document.createElement('div');
        progress.className = 'cap-progress';
        progress.setAttribute('aria-hidden', 'true');

        shell.append(row, panel, progress);
        shadow.append(styleEl, shell);

        this._shellEl = shell;
        this._openBtnEl = openBtn;
        this._indicatorEl = indicator;
        this._summaryMainEl = summaryMain;
        this._summaryMetaEl = summaryMeta;
        this._badgesEl = badges;
        this._resumeBtnEl = resumeBtn;
        this._taskAreaEl = taskArea;
        this._panelEl = panel;
    }

    private handleOpenConsole(tab: ConsoleTabId, deepLink: DeepLinkState): void {
        if (this._state.onOpenConsole) {
            this._state.onOpenConsole(tab, deepLink);
        } else {
            this.resolveStore()?.openConsole(tab, deepLink);
        }

        if (typeof CustomEvent !== 'undefined') {
            this.dispatchEvent(
                new CustomEvent('agentic-capsule-open', {
                    bubbles: true,
                    composed: true,
                    detail: { tab, ...deepLink },
                }),
            );
        }
    }

    private handleCancelTask(taskId: string): void {
        if (this._state.onCancelTask) {
            void this._state.onCancelTask(taskId);
        } else {
            const store = this.resolveStore();
            if (store) {
                void store.cancelBackgroundTask(taskId);
            }
        }

        // Optimistically update local task list so standalone capsules reflect cancellation immediately.
        const hasExplicitTask = this._state.backgroundTasks.some((t) => t.taskId === taskId);
        if (hasExplicitTask) {
            const nextTasks = this._state.backgroundTasks.map((t) =>
                t.taskId === taskId
                    ? { ...t, state: 'aborted' as const, endedAt: Date.now() }
                    : t,
            );
            const stillRunning = nextTasks.some(
                (t) => t.state === 'running' || t.state === 'queued',
            );
            this._state.backgroundTasks = nextTasks;
            if (!stillRunning && this._state.status === 'background-running') {
                this._state.status = 'done';
            }
        } else if (this._state.status === 'background-running') {
            this._state.status = 'done';
        }

        if (typeof CustomEvent !== 'undefined') {
            this.dispatchEvent(
                new CustomEvent('agentic-capsule-cancel-task', {
                    bubbles: true,
                    composed: true,
                    detail: {
                        taskId,
                        messageId: this._state.messageId,
                        swipeId: this._state.swipeId,
                    },
                }),
            );
        }

        this.render();
        this.syncTicker();
    }

    private async handleResume(): Promise<void> {
        if (
            this._resumePending
            || this._state.status !== 'interrupted'
            || this._state.canResume === false
        ) {
            return;
        }

        const target: MessageTarget = {
            messageId: this._state.messageId,
            swipeId: this._state.swipeId,
        };
        const reason = this._state.interruptedReason;

        this._resumePending = true;
        if (this._resumeBtnEl) {
            this._resumeBtnEl.disabled = true;
        }

        try {
            if (typeof CustomEvent !== 'undefined') {
                this.dispatchEvent(
                    new CustomEvent('agentic-capsule-resume', {
                        bubbles: true,
                        composed: true,
                        detail: {
                            messageId: target.messageId,
                            swipeId: target.swipeId,
                            reason,
                        },
                    }),
                );
            }

            if (this._state.onResume) {
                await this._state.onResume();
            } else {
                const store = this.resolveStore();
                if (store?.services.resumeTurn) {
                    await store.services.resumeTurn(target);
                } else if (store) {
                    await store.resumeTurn(target);
                }
            }
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.resolveStore()?.pushToast(`恢复生成失败：${msg}`, 'error');
        } finally {
            this._resumePending = false;
            if (this._resumeBtnEl) {
                this._resumeBtnEl.disabled = false;
            }
            this.render();
        }
    }

    private syncTicker(): void {
        const hasActive = this.getActiveBackgroundTasks().length > 0;
        if (hasActive && this.isConnected) {
            if (!this._timerId) {
                this._timerId = setInterval(() => {
                    this.updateTimersOnly();
                }, 1000);
            }
        } else {
            this.stopTicker();
        }
    }

    private stopTicker(): void {
        if (this._timerId) {
            clearInterval(this._timerId);
            this._timerId = null;
        }
    }

    private updateTimersOnly(): void {
        if (!this._shellEl) {
            return;
        }
        const now = Date.now();
        this._shellEl.querySelectorAll<HTMLElement>('[data-started-at]').forEach((el) => {
            const startedAt = Number(el.dataset.startedAt);
            if (Number.isFinite(startedAt)) {
                el.textContent = formatElapsed(startedAt, now);
            }
        });
    }

    private render(): void {
        if (
            !this._shellEl
            || !this._indicatorEl
            || !this._summaryMainEl
            || !this._summaryMetaEl
            || !this._badgesEl
            || !this._resumeBtnEl
            || !this._taskAreaEl
            || !this._panelEl
            || !this._openBtnEl
        ) {
            return;
        }

        const status = this._state.status;
        const activeTasks = this.getActiveBackgroundTasks();
        const isRunning = activeTasks.length > 0 || RUNNING_STATUSES.has(status);
        const isActive = isRunning || status === 'interrupted' || status === 'error';

        const shouldHide = this._state.persistMode === 'auto_hide' && !isActive;
        this.setAttribute('data-hidden', shouldHide ? 'true' : 'false');

        const resolvedTheme = this.resolveTheme();
        this._shellEl.setAttribute('data-theme', resolvedTheme);
        this._shellEl.setAttribute('data-status', status);
        this._shellEl.setAttribute('data-position', this._state.position);
        this._shellEl.setAttribute('data-active', isRunning ? 'true' : 'false');

        // Indicator: spinner while working, otherwise a status glyph.
        this._indicatorEl.replaceChildren();
        if (RUNNING_STATUSES.has(status)) {
            const spinner = document.createElement('span');
            spinner.className = 'cap-spinner';
            this._indicatorEl.appendChild(spinner);
        } else {
            this._indicatorEl.appendChild(createStatusIconSvg(status));
        }

        // Summary: bold headline + muted meta (single-line ellipsis on .cap-summary).
        const { main, meta } = buildSummaryParts(this._state);
        this._summaryMainEl.textContent = main;
        this._summaryMetaEl.textContent = meta;
        this._summaryMetaEl.hidden = meta.length === 0;
        const detailSuffix =
            status === 'interrupted' && this._state.errorMessage?.trim()
                ? ` (${this._state.errorMessage.trim()})`
                : '';
        this._openBtnEl.title = `#${this._state.messageId}#${this._state.swipeId} · ${main}${meta ? ` · ${meta}` : ''}${detailSuffix}`;

        // Dedicated resume action button when interrupted
        const showResume = status === 'interrupted' && this._state.canResume !== false;
        this._resumeBtnEl.hidden = !showResume;
        this._resumeBtnEl.disabled = this._resumePending;

        // Quick badges (optional)
        this._badgesEl.replaceChildren();
        for (const badge of this._state.badges) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cap-badge-btn';
            btn.title = badge.label;
            btn.setAttribute('aria-label', badge.label);
            const pill = document.createElement('span');
            pill.className = 'cap-badge-pill';
            if (badge.tone) {
                pill.setAttribute('data-tone', badge.tone);
            }
            const pillText = document.createElement('span');
            pillText.className = 'cap-badge-text';
            pillText.textContent = badge.label;
            pill.appendChild(pillText);
            btn.appendChild(pill);
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.handleOpenConsole(badge.tab ?? 'files', {
                    messageId: this._state.messageId,
                    swipeId: this._state.swipeId,
                    filePath: badge.filePath,
                    viewMode: badge.viewMode,
                });
            });
            this._badgesEl.appendChild(btn);
        }

        // Background tasks: one chip inline; 2+ collapse into a toggle with an expandable list.
        if (activeTasks.length <= 1) {
            this._tasksExpanded = false;
        }
        const focusKey = this.getFocusedKey();
        this._taskAreaEl.replaceChildren();
        this._panelEl.replaceChildren();

        if (activeTasks.length === 1) {
            this._taskAreaEl.appendChild(this.buildSingleTaskChip(activeTasks[0]));
        } else if (activeTasks.length > 1) {
            this._taskAreaEl.appendChild(this.buildTasksToggle(activeTasks));
            if (this._tasksExpanded) {
                for (const task of activeTasks) {
                    this._panelEl.appendChild(this.buildPanelItem(task));
                }
            }
        }
        this._panelEl.hidden = !(this._tasksExpanded && activeTasks.length > 1);
        this.restoreFocus(focusKey);
    }

    private getFocusedKey(): string | undefined {
        const active = this._shadow?.activeElement as HTMLElement | null | undefined;
        return active?.dataset?.focusKey;
    }

    private restoreFocus(key: string | undefined): void {
        if (!key || !this._shadow) {
            return;
        }
        const match = Array.from(
            this._shadow.querySelectorAll<HTMLElement>('[data-focus-key]'),
        ).find((el) => el.dataset.focusKey === key);
        match?.focus();
    }

    private buildTaskDot(task: BackgroundTaskStatus): HTMLSpanElement {
        const dot = document.createElement('span');
        dot.className = 'cap-task-dot';
        dot.setAttribute('data-state', task.state);
        dot.setAttribute('aria-hidden', 'true');
        return dot;
    }

    private buildTaskTimer(task: BackgroundTaskStatus): HTMLSpanElement {
        const timer = document.createElement('span');
        timer.className = 'cap-task-timer';
        if (task.state === 'queued') {
            timer.textContent = '排队';
        } else {
            timer.dataset.startedAt = String(task.startedAt);
            timer.textContent = formatElapsed(task.startedAt);
        }
        return timer;
    }

    private buildCancelButton(task: BackgroundTaskStatus): HTMLButtonElement {
        const label = task.label || '后台任务';
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'cap-cancel-btn';
        cancelBtn.setAttribute('data-task-id', task.taskId);
        cancelBtn.dataset.focusKey = `cancel:${task.taskId}`;
        cancelBtn.setAttribute('aria-label', `取消后台任务 ${label}`);
        cancelBtn.title = '仅中止该后台任务';

        const cancelPill = document.createElement('span');
        cancelPill.className = 'cap-cancel-pill';
        cancelPill.setAttribute('aria-hidden', 'true');
        cancelPill.appendChild(createStrokeIcon(11, 2.6, ['M18 6 6 18', 'm6 6 12 12']));

        cancelBtn.appendChild(cancelPill);
        cancelBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            this.handleCancelTask(task.taskId);
        });
        return cancelBtn;
    }

    private buildSingleTaskChip(task: BackgroundTaskStatus): HTMLDivElement {
        const label = task.label || '后台任务';
        const group = document.createElement('div');
        group.className = 'cap-task-group';
        group.title = task.currentStep ? `${label}: ${task.currentStep}` : label;

        const text = document.createElement('span');
        text.className = 'cap-task-text';
        text.textContent = label;

        group.append(
            this.buildTaskDot(task),
            text,
            this.buildTaskTimer(task),
            this.buildCancelButton(task),
        );
        return group;
    }

    private buildTasksToggle(tasks: BackgroundTaskStatus[]): HTMLButtonElement {
        const expanded = this._tasksExpanded;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'cap-tasks-toggle';
        toggle.dataset.focusKey = 'toggle';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute('aria-controls', TASK_PANEL_ID);
        toggle.setAttribute(
            'aria-label',
            `${tasks.length} 个后台任务运行中，${expanded ? '收起' : '展开'}列表`,
        );
        toggle.title = tasks.map((t) => t.label || '后台任务').join('\n');

        const chip = document.createElement('span');
        chip.className = 'cap-task-group';

        const running = tasks.filter((t) => t.state === 'running');
        const lead = running[0] ?? tasks[0];

        const text = document.createElement('span');
        text.className = 'cap-task-text';
        text.textContent = `${tasks.length} 个后台任务`;

        const timerSource =
            running.length > 0
                ? running.reduce((a, b) => (b.startedAt < a.startedAt ? b : a))
                : lead;

        const chevron = createStrokeIcon(12, 2.4, ['m6 9 6 6 6-6']);
        chevron.classList.add('cap-chevron');

        chip.append(this.buildTaskDot(lead), text, this.buildTaskTimer(timerSource), chevron);
        toggle.appendChild(chip);
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            this._tasksExpanded = !this._tasksExpanded;
            this.render();
        });
        return toggle;
    }

    private buildPanelItem(task: BackgroundTaskStatus): HTMLDivElement {
        const label = task.label || '后台任务';
        const item = document.createElement('div');
        item.className = 'cap-panel-item';
        item.setAttribute('role', 'listitem');
        item.setAttribute('data-state', task.state);
        item.title = task.currentStep ? `${label}: ${task.currentStep}` : label;

        const labelEl = document.createElement('span');
        labelEl.className = 'cap-panel-label';
        labelEl.textContent = label;

        const stepEl = document.createElement('span');
        stepEl.className = 'cap-panel-step';
        stepEl.textContent = task.currentStep ?? '';

        item.append(
            this.buildTaskDot(task),
            labelEl,
            stepEl,
            this.buildTaskTimer(task),
            this.buildCancelButton(task),
        );
        return item;
    }
}

/** Register the `<agentic-capsule>` autonomous custom element idempotently. */
export function registerAgenticCapsuleElement(tagName = 'agentic-capsule'): void {
    if (typeof customElements === 'undefined' || typeof HTMLElement === 'undefined') {
        return;
    }
    if (!customElements.get(tagName)) {
        customElements.define(tagName, AgenticCapsuleElement);
    }
}

/**
 * Mount or reposition an `<agentic-capsule>` inside a SillyTavern `.mes_block`
 * strictly OUTSIDE `.mes_text` (above or below depending on `position`).
 * Accepts either the outer `.mes` message element or `.mes_block` itself.
 */
export function placeAgenticCapsule(
    mesOrBlock: HTMLElement,
    capsule: HTMLElement,
    position: CapsulePosition = 'bottom',
): void {
    if (
        typeof capsule.getAttribute !== 'function'
        || capsule.getAttribute('position') !== position
    ) {
        capsule.setAttribute('position', position);
    }

    const mesBlock = mesOrBlock.classList?.contains('mes_block')
        ? mesOrBlock
        : mesOrBlock.querySelector<HTMLElement>('.mes_block');
    const targetContainer = mesBlock ?? mesOrBlock;

    const directMesText =
        (Array.from(targetContainer.children ?? []).find((child) =>
            child.classList?.contains('mes_text'),
        ) as HTMLElement | undefined) ?? null;
    const mesText = directMesText ?? targetContainer.querySelector<HTMLElement>('.mes_text');
    const anchorParent = mesText?.parentElement ?? targetContainer;

    if (mesText && mesText.parentElement === anchorParent) {
        if (position === 'top') {
            if (capsule.parentElement !== anchorParent || capsule.nextSibling !== mesText) {
                anchorParent.insertBefore(capsule, mesText);
            }
        } else if (capsule.parentElement !== anchorParent || mesText.nextSibling !== capsule) {
            if (mesText.nextSibling) {
                anchorParent.insertBefore(capsule, mesText.nextSibling);
            } else {
                anchorParent.appendChild(capsule);
            }
        }
        return;
    }

    if (position === 'top') {
        if (capsule.parentElement !== targetContainer || targetContainer.firstChild !== capsule) {
            targetContainer.prepend(capsule);
        }
    } else if (capsule.parentElement !== targetContainer || targetContainer.lastChild !== capsule) {
        targetContainer.appendChild(capsule);
    }
}
