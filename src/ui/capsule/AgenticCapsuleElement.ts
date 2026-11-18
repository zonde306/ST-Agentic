import type {
    BackgroundTaskStatus,
    CapsulePersistMode,
    CapsulePosition,
    ConsoleTabId,
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
    | 'done'
    | 'background-running'
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
    taskId?: string;
    taskLabel?: string;
    badges: CapsuleBadgeItem[];
    backgroundTasks: BackgroundTaskStatus[];
    onOpenConsole?: (tab: ConsoleTabId, deepLink: DeepLinkState) => void;
    onCancelTask?: (taskId: string) => void | Promise<void>;
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
] as const;

const CAPSULE_STYLES = `
:host {
    all: initial;
    display: block;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
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

.cap-shell {
    --cap-bg: var(--ag-cap-bg, #181b22);
    --cap-bg-hover: var(--ag-cap-bg-hover, #232834);
    --cap-border: var(--ag-cap-border, #2f3542);
    --cap-fg: var(--ag-cap-fg, #e6e9ef);
    --cap-muted: var(--ag-cap-muted, #9aa3b2);
    --cap-primary: var(--ag-cap-primary, #6c8cff);
    --cap-success: var(--ag-cap-success, #34d399);
    --cap-warning: var(--ag-cap-warning, #fbbf24);
    --cap-error: var(--ag-cap-error, #f87171);

    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 2px;
    width: 100%;
    max-width: 100%;
    min-width: 0;
    min-height: 40px;
    padding: 0 4px 0 2px;
    border-radius: 10px;
    border: 1px solid var(--cap-border);
    background: var(--cap-bg);
    color: var(--cap-fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    color-scheme: dark;
}

.cap-shell[data-theme="light"] {
    --cap-bg: var(--ag-cap-bg, #f4f6fa);
    --cap-bg-hover: var(--ag-cap-bg-hover, #e8edf5);
    --cap-border: var(--ag-cap-border, #d5dce8);
    --cap-fg: var(--ag-cap-fg, #181c24);
    --cap-muted: var(--ag-cap-muted, #5f697a);
    --cap-primary: var(--ag-cap-primary, #3b66f5);
    --cap-success: var(--ag-cap-success, #10b981);
    --cap-warning: var(--ag-cap-warning, #d97706);
    --cap-error: var(--ag-cap-error, #dc2626);
    color-scheme: light;
}

.cap-shell[data-status="error"] {
    border-color: color-mix(in srgb, var(--cap-error) 55%, var(--cap-border));
}

.cap-shell[data-status="retrieving"],
.cap-shell[data-status="streaming"],
.cap-shell[data-status="background-running"] {
    border-color: color-mix(in srgb, var(--cap-primary) 50%, var(--cap-border));
}

.cap-open-btn {
    flex: 1 1 auto;
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
    gap: 6px;
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
.cap-cancel-btn:focus-visible {
    outline: 2px solid var(--cap-primary);
    outline-offset: -2px;
}

.cap-indicator {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--cap-primary);
}

.cap-shell[data-status="done"] .cap-indicator {
    color: var(--cap-success);
}

.cap-shell[data-status="error"] .cap-indicator {
    color: var(--cap-error);
}

.cap-dot-pulse {
    width: 8px;
    height: 8px;
    border-radius: 9999px;
    background: currentColor;
    animation: ag-cap-pulse 1.2s ease-in-out infinite;
}

@keyframes ag-cap-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.45; transform: scale(0.8); }
}

.cap-summary {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
    font-weight: 500;
    color: var(--cap-fg);
}

.cap-badges {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 2px;
}

.cap-badge-btn {
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
    padding: 0 3px;
    margin: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.cap-badge-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 7px;
    border-radius: 9999px;
    border: 1px solid var(--cap-border);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
    background: color-mix(in srgb, var(--cap-primary) 12%, transparent);
    color: var(--cap-primary);
}

.cap-badge-pill[data-tone="success"] {
    background: color-mix(in srgb, var(--cap-success) 14%, transparent);
    border-color: color-mix(in srgb, var(--cap-success) 38%, transparent);
    color: var(--cap-success);
}

.cap-badge-pill[data-tone="warning"] {
    background: color-mix(in srgb, var(--cap-warning) 14%, transparent);
    border-color: color-mix(in srgb, var(--cap-warning) 38%, transparent);
    color: var(--cap-warning);
}

.cap-badge-pill[data-tone="error"] {
    background: color-mix(in srgb, var(--cap-error) 14%, transparent);
    border-color: color-mix(in srgb, var(--cap-error) 38%, transparent);
    color: var(--cap-error);
}

.cap-task-group {
    flex-shrink: 0;
    max-width: 56%;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    padding-left: 8px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--cap-primary) 35%, transparent);
    background: color-mix(in srgb, var(--cap-primary) 12%, transparent);
    color: var(--cap-primary);
}

.cap-task-text {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    font-weight: 600;
}

.cap-task-timer {
    flex-shrink: 0;
    margin-left: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    opacity: 0.9;
}

.cap-cancel-btn {
    flex-shrink: 0;
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    margin: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.cap-cancel-pill {
    width: 24px;
    height: 24px;
    border-radius: 9999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    background: color-mix(in srgb, var(--cap-fg) 10%, transparent);
    transition: background-color 0.15s;
}

.cap-cancel-btn:hover .cap-cancel-pill {
    background: color-mix(in srgb, var(--cap-error) 28%, transparent);
    color: var(--cap-error);
}

@media (max-width: 767px) {
    .cap-badges {
        display: none;
    }

    .cap-task-group {
        max-width: 50%;
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

function buildDefaultSummary(state: AgenticCapsuleData): string {
    if (state.summary.trim()) {
        return state.summary.trim();
    }

    const hitText = formatHitRatePercent(state.cacheHitRate);
    switch (state.status) {
        case 'retrieving':
            return state.currentStep
                ? `正在检索 ${state.currentStep}`
                : `正在检索资料（第 ${Math.max(1, state.stepCount)} 步）...`;
        case 'streaming':
            if (state.stepCount > 0 && hitText) {
                return `已检索 ${state.stepCount} 步 · 缓存命中 ${hitText} · 流式输出中`;
            }
            return hitText ? `缓存命中 ${hitText} · 流式输出中` : '主叙事流式生成中...';
        case 'background-running':
            return state.stepCount > 0 && hitText
                ? `${state.stepCount} 步 · 缓存 ${hitText} · 后台运行中`
                : '后台触发任务执行中...';
        case 'error':
            return state.errorMessage?.trim() || '生成或后台任务发生错误';
        case 'done': {
            const parts: string[] = [];
            if (state.stepCount > 0) {
                parts.push(`${state.stepCount} 步`);
            }
            if (hitText) {
                parts.push(`缓存 ${hitText}`);
            }
            return parts.length > 0 ? parts.join(' · ') : '生成完成 · 点击查看日志';
        }
        case 'idle':
        default:
            return 'ST-Agentic 就绪 · 点击查看日志';
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
    private _timerId: ReturnType<typeof setInterval> | null = null;
    private _shadow: ShadowRoot | null = null;
    private _shellEl: HTMLDivElement | null = null;
    private _openBtnEl: HTMLButtonElement | null = null;
    private _indicatorEl: HTMLSpanElement | null = null;
    private _summaryEl: HTMLSpanElement | null = null;
    private _badgesEl: HTMLDivElement | null = null;
    private _tasksEl: HTMLDivElement | null = null;

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
                    || val === 'done'
                    || val === 'background-running'
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
        if (patch.position && this.getAttribute('position') !== patch.position) {
            this.setAttribute('position', patch.position);
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

    /**
     * Bind this capsule to an `AppStore` for reactive theme/position/persistMode/task sync
     * and one-click deep linking into `<dialog id="agentic-app">`.
     */
    connectStore(store: AppStore, target?: MessageTarget): () => void {
        this._storeUnsubscribe?.();
        this._store = store;

        if (target) {
            this._state.messageId = target.messageId;
            this._state.swipeId = target.swipeId;
        }

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
                } else if (hasActiveTasks) {
                    derivedStatus = 'background-running';
                } else if (mainTrace.status === 'completed') {
                    derivedStatus = 'done';
                }
            } else if (hasActiveTasks) {
                derivedStatus = 'background-running';
            }

            this.setState({
                theme: snap.themeMode === 'auto' ? snap.resolvedTheme : snap.themeMode,
                position: snap.settings.capsulePosition,
                persistMode: snap.settings.capsulePersistMode,
                backgroundTasks: matchingTasks,
                status: derivedStatus,
                errorMessage: mainTrace?.status === 'error' ? (mainTrace.error ?? this._state.errorMessage) : this._state.errorMessage,
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
        return () => {
            this.disconnectStore();
        };
    }

    /** Detach any active `AppStore` subscription bound via `connectStore`. */
    disconnectStore(): void {
        this._storeUnsubscribe?.();
        this._storeUnsubscribe = null;
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

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'cap-open-btn';
        openBtn.setAttribute('aria-label', '打开 ST-Agentic 控制台查看生成日志');

        const indicator = document.createElement('span');
        indicator.className = 'cap-indicator';

        const summary = document.createElement('span');
        summary.className = 'cap-summary';

        openBtn.append(indicator, summary);
        openBtn.addEventListener('click', () => {
            this.handleOpenConsole('logs', {
                messageId: this._state.messageId,
                swipeId: this._state.swipeId,
            });
        });

        const badges = document.createElement('div');
        badges.className = 'cap-badges';

        const tasks = document.createElement('div');
        tasks.className = 'cap-tasks';
        tasks.style.display = 'contents';

        shell.append(openBtn, badges, tasks);
        shadow.append(styleEl, shell);

        this._shellEl = shell;
        this._openBtnEl = openBtn;
        this._indicatorEl = indicator;
        this._summaryEl = summary;
        this._badgesEl = badges;
        this._tasksEl = tasks;
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
        if (!this._tasksEl) {
            return;
        }
        const activeTasks = this.getActiveBackgroundTasks();
        const timerEls = this._tasksEl.querySelectorAll('.cap-task-timer');
        activeTasks.forEach((task, idx) => {
            const el = timerEls[idx];
            if (el) {
                const sec = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
                el.textContent = `${sec}s`;
            }
        });
    }

    private render(): void {
        if (
            !this._shellEl
            || !this._indicatorEl
            || !this._summaryEl
            || !this._badgesEl
            || !this._tasksEl
            || !this._openBtnEl
        ) {
            return;
        }

        const activeTasks = this.getActiveBackgroundTasks();
        const isActive =
            activeTasks.length > 0
            || this._state.status === 'retrieving'
            || this._state.status === 'streaming'
            || this._state.status === 'background-running'
            || this._state.status === 'error';

        const shouldHide = this._state.persistMode === 'auto_hide' && !isActive;
        this.setAttribute('data-hidden', shouldHide ? 'true' : 'false');

        const resolvedTheme = this.resolveTheme();
        this._shellEl.setAttribute('data-theme', resolvedTheme);
        this._shellEl.setAttribute('data-status', this._state.status);
        this._shellEl.setAttribute('data-position', this._state.position);

        // Indicator icon
        this._indicatorEl.replaceChildren();
        if (
            this._state.status === 'retrieving'
            || this._state.status === 'streaming'
            || this._state.status === 'background-running'
        ) {
            const pulse = document.createElement('span');
            pulse.className = 'cap-dot-pulse';
            this._indicatorEl.appendChild(pulse);
        } else {
            this._indicatorEl.appendChild(createStatusIconSvg(this._state.status));
        }

        // Summary text (single-line truncated via CSS ellipsis)
        const summaryText = buildDefaultSummary(this._state);
        this._summaryEl.textContent = summaryText;
        this._openBtnEl.title = `#${this._state.messageId}#${this._state.swipeId} · ${summaryText}`;

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
            pill.textContent = badge.label;
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

        // Active background task chips with `>= 40x40px` [×] cancel button
        this._tasksEl.replaceChildren();
        for (const task of activeTasks) {
            const group = document.createElement('div');
            group.className = 'cap-task-group';

            const labelEl = document.createElement('span');
            labelEl.className = 'cap-task-text';
            labelEl.textContent = task.label || '后台任务';
            labelEl.title = task.currentStep ? `${task.label}: ${task.currentStep}` : task.label;

            const timerEl = document.createElement('span');
            timerEl.className = 'cap-task-timer';
            const sec = Math.max(0, Math.floor((Date.now() - task.startedAt) / 1000));
            timerEl.textContent = `${sec}s`;

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'cap-cancel-btn';
            cancelBtn.setAttribute('data-task-id', task.taskId);
            cancelBtn.setAttribute('aria-label', `取消后台任务 ${task.label}`);
            cancelBtn.title = '仅中止该后台任务';

            const cancelPill = document.createElement('span');
            cancelPill.className = 'cap-cancel-pill';
            cancelPill.setAttribute('aria-hidden', 'true');
            cancelPill.textContent = '×';

            cancelBtn.appendChild(cancelPill);
            cancelBtn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.handleCancelTask(task.taskId);
            });

            group.append(labelEl, timerEl, cancelBtn);
            this._tasksEl.appendChild(group);
        }
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
 */
export function placeAgenticCapsule(
    mesBlock: HTMLElement,
    capsule: HTMLElement,
    position: CapsulePosition = 'bottom',
): void {
    capsule.setAttribute('position', position);
    const mesText = mesBlock.querySelector('.mes_text');
    if (mesText && mesText.parentElement === mesBlock) {
        if (position === 'top') {
            mesBlock.insertBefore(capsule, mesText);
        } else if (mesText.nextSibling) {
            mesBlock.insertBefore(capsule, mesText.nextSibling);
        } else {
            mesBlock.appendChild(capsule);
        }
        return;
    }

    if (position === 'top') {
        mesBlock.prepend(capsule);
    } else {
        mesBlock.appendChild(capsule);
    }
}
