import { createContext, createElement, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import {
    createDefaultSettings,
    normalizeSettings,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import type {
    AgentRunTrace,
    ApiConnection,
    BackgroundTaskStatus,
    ClassifiedLoreEntry,
    CompactionReport,
    ConsoleTabId,
    CustomToolConfig,
    DataNamespace,
    GenerationEventPayload,
    MessageTarget,
    MigrationReport,
    Preset,
    RunMode,
    Settings,
    ThemeMode,
    WICategory,
} from '@/core/types';
import {
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
} from './mock-services';

export type ResolvedTheme = 'dark' | 'light';
export type ToastTone = 'primary' | 'success' | 'warning' | 'error';

export interface DeepLinkState {
    messageId?: number;
    filePath?: string;
    swipeId?: number;
    logId?: string;
    viewMode?: 'edit' | 'diff';
}

export interface ToastItem {
    id: string;
    message: string;
    tone: ToastTone;
    createdAt: number;
    durationMs: number;
}

export type ActiveModalState =
    | { kind: 'import_manager' }
    | {
        kind: 'migration_report';
        title: string;
        report: MigrationReport;
        summary?: string;
    }
    | {
        kind: 'confirm';
        title: string;
        message: string;
        confirmLabel?: string;
        cancelLabel?: string;
        tone?: 'primary' | 'danger';
        onConfirm: () => void | Promise<void>;
    }
    | {
        kind: 'info';
        title: string;
        message: string;
    }
    | {
        kind: 'custom';
        id: string;
        title: string;
        payload?: unknown;
    };

export type FileOverrideCategory = 'workspace' | 'variables' | 'worldinfo' | 'message';

export interface FileOverrideItem {
    id: string;
    category: FileOverrideCategory;
    namespace: DataNamespace;
    path: string;
    key: string;
    target: MessageTarget;
    layerLabel: string;
    source: string;
    content: string;
    baseContent?: string;
    overridden: boolean;
    writable: boolean;
}

export interface AgentWatermarkStatus {
    agentId: string;
    agentName: string;
    currentTokens: number;
    lowWatermark: number;
    highWatermark: number;
    archivedChunks: number;
    summaryMode: string;
}

export interface StorageOverview {
    estimatedBytes: number;
    activeLayers: number;
    compactedWatermark: number;
    keepDepth: number;
    autoCompact: boolean;
    sizeThreshold: number;
}

export interface ConnectionTestResult {
    ok: boolean;
    latencyMs: number;
    message: string;
    cacheSupport?: string;
}

export interface ToolTestResult {
    ok: boolean;
    durationMs: number;
    output: string;
    error?: string;
    target: MessageTarget;
}

export interface EmbeddedCardStatus {
    characterName: string;
    hasPresets: boolean;
    hasFiles: boolean;
    fromLegacy: boolean;
    presetCount: number;
    fileCount: number;
}

export interface ImportPresetResult {
    settings?: Settings;
    preset?: Preset;
    connection?: ApiConnection;
    report?: MigrationReport;
    message: string;
}

/**
 * Abstract UI Service Adapter decoupling UI components from SillyTavern host
 * and runtime storage implementations (`dev:ui` uses mock implementation).
 */
export interface AgenticUIServices {
    // Files & Overrides (View 1)
    listFilesAndOverrides(target?: MessageTarget): Promise<FileOverrideItem[]>;
    saveFileOrOverride(input: {
        path: string;
        namespace: DataNamespace;
        key: string;
        content: string;
        target?: MessageTarget;
    }): Promise<FileOverrideItem>;
    deleteFileOrOverride(input: {
        path: string;
        namespace: DataNamespace;
        key: string;
        target?: MessageTarget;
    }): Promise<void>;

    // Watermark & Cold-layer Compaction (View 3)
    getWatermarkStatuses(): Promise<AgentWatermarkStatus[]>;
    compactAgentContext(agentId: string): Promise<AgentWatermarkStatus>;
    getStorageOverview(): Promise<StorageOverview>;
    previewColdCompaction(keepDepth?: number): Promise<CompactionReport>;
    runColdCompaction(keepDepth?: number): Promise<CompactionReport>;

    // Traces & Execution Actions (View 2 & Capsule / Magic Menu)
    listTraces(filter?: { messageId?: number; swipeId?: number }): Promise<AgentRunTrace[]>;
    clearTraces?(): Promise<void>;
    rerunAfterTurn(target?: MessageTarget): Promise<void>;
    cancelBackgroundTask(taskId: string): Promise<void>;

    // Settings, Preset Import/Export & Migration (Header / View 4-9)
    saveSettings(settings: Settings): Promise<void>;
    importPresetOrConfig(
        rawJson: unknown,
        options?: { presetName?: string },
    ): Promise<ImportPresetResult>;
    exportPresetJson(presetId: string, includeConnection?: boolean): Promise<string>;

    // Character Card PNG Embed Actions (Header Embed Menu)
    getEmbeddedCardStatus(): Promise<EmbeddedCardStatus>;
    embedPresetToCard(presetId: string): Promise<string>;
    embedFilesToCard(files: Record<string, string>): Promise<string>;
    importEmbeddedFromCard(): Promise<{
        presetsImported: number;
        filesImported: number;
        report?: MigrationReport;
        message: string;
    }>;

    // Studio Testing & World Info Classification (Views 6, 8, 9)
    testConnection(connection: ApiConnection): Promise<ConnectionTestResult>;
    testToolInSandbox(
        tool: CustomToolConfig | { name: string; code?: string; commandTemplate?: string },
        argsJson: string,
        target?: MessageTarget,
    ): Promise<ToolTestResult>;
    listClassifiedLoreEntries(
        overrides?: Record<string, WICategory>,
    ): Promise<{ entries: ClassifiedLoreEntry[]; isHollowCard: boolean }>;

    // Host Theme Luminance & Live Events
    getHostLuminance?(): ResolvedTheme;
    subscribeEvents?(listener: (event: GenerationEventPayload) => void): () => void;
}

export interface AppStoreState {
    isOpen: boolean;
    activeTab: ConsoleTabId;
    deepLink: DeepLinkState;
    activeTarget: MessageTarget;
    runMode: RunMode;
    themeMode: ThemeMode;
    resolvedTheme: ResolvedTheme;
    settings: Settings;
    traces: AgentRunTrace[];
    backgroundTasks: BackgroundTaskStatus[];
    toastQueue: ToastItem[];
    activeModal: ActiveModalState | null;
}

export interface AppStoreOptions {
    initialSettings?: Settings;
    initialTraces?: AgentRunTrace[];
    initialBackgroundTasks?: BackgroundTaskStatus[];
    initialTab?: ConsoleTabId;
    initialOpen?: boolean;
    initialTarget?: MessageTarget;
    services?: AgenticUIServices;
    getHostLuminance?: () => ResolvedTheme;
}

/**
 * Parse a CSS color string (`rgb(...)`, `rgba(...)`, `#hex`) and calculate
 * W3C relative luminance to classify dark vs light host themes.
 */
function parseColorLuminance(colorValue: string): number | null {
    const raw = colorValue.trim();
    if (!raw || raw === 'transparent' || raw === 'none') {
        return null;
    }

    let r: number;
    let g: number;
    let b: number;
    let a = 1;

    const rgbMatch = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
        raw,
    );
    if (rgbMatch) {
        r = Number(rgbMatch[1]);
        g = Number(rgbMatch[2]);
        b = Number(rgbMatch[3]);
        if (rgbMatch[4] !== undefined) {
            a = rgbMatch[4].endsWith('%')
                ? Number(rgbMatch[4].slice(0, -1)) / 100
                : Number(rgbMatch[4]);
        }
    } else if (/^#[0-9a-f]{3,8}$/i.test(raw)) {
        const hex = raw.slice(1);
        if (hex.length === 3 || hex.length === 4) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
            if (hex.length === 4) {
                a = parseInt(hex[3] + hex[3], 16) / 255;
            }
        } else if (hex.length === 6 || hex.length === 8) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
            if (hex.length === 8) {
                a = parseInt(hex.slice(6, 8), 16) / 255;
            }
        } else {
            return null;
        }
    } else {
        return null;
    }

    if (a < 0.08 || !Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        return null;
    }

    const toLinear = (c: number) => {
        const srgb = Math.max(0, Math.min(255, c)) / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * Detect host theme luminance exclusively via computed CSS variables
 * (`--SmartThemeBlurTintColor` / `--SmartThemeBodyColor`), falling back to `dark`.
 */
export function detectHostLuminanceFromCssVars(targetElement?: Element | null): ResolvedTheme {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return 'dark';
    }

    const candidates: (Element | null | undefined)[] = [
        targetElement,
        document.documentElement,
        document.body,
    ];

    for (const el of candidates) {
        if (!el) {
            continue;
        }
        try {
            const styles = window.getComputedStyle(el);
            const blurTint = styles.getPropertyValue('--SmartThemeBlurTintColor');
            const bodyColor = styles.getPropertyValue('--SmartThemeBodyColor');

            const bgLum = parseColorLuminance(blurTint);
            if (bgLum !== null) {
                return bgLum > 0.5 ? 'light' : 'dark';
            }

            // Text foreground color is inverted relative to background luminance.
            const fgLum = parseColorLuminance(bodyColor);
            if (fgLum !== null) {
                return fgLum < 0.45 ? 'light' : 'dark';
            }

            const rawBgLum = parseColorLuminance(styles.backgroundColor);
            if (rawBgLum !== null) {
                return rawBgLum > 0.5 ? 'light' : 'dark';
            }
        } catch {
            // Ignore unreadable elements in synthetic test environments.
        }
    }

    if (typeof window.matchMedia === 'function') {
        try {
            if (window.matchMedia('(prefers-color-scheme: light)').matches) {
                return 'light';
            }
        } catch {
            // Ignore matchMedia errors.
        }
    }

    return 'dark';
}

function resolveThemeValue(
    themeMode: ThemeMode,
    getHostLuminance?: () => ResolvedTheme,
): ResolvedTheme {
    if (themeMode === 'dark' || themeMode === 'light') {
        return themeMode;
    }
    if (getHostLuminance) {
        try {
            return getHostLuminance();
        } catch {
            return 'dark';
        }
    }
    return detectHostLuminanceFromCssVars();
}

export class AppStore {
    public readonly services: AgenticUIServices;
    private state: AppStoreState;
    private readonly listeners = new Set<() => void>();
    private readonly toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly customLuminanceReader?: () => ResolvedTheme;
    private unsubscribeEvents?: () => void;
    private toastCounter = 0;

    constructor(options: AppStoreOptions = {}) {
        const usingCustomServices = Boolean(options.services);
        this.services = options.services ?? createMockUIServices();
        this.customLuminanceReader =
            options.getHostLuminance ?? this.services.getHostLuminance;

        const initialSettings = normalizeSettings(
            options.initialSettings
                ?? (usingCustomServices ? createDefaultSettings() : createMockSettings()),
        );
        const initialTraces =
            options.initialTraces
            ?? (usingCustomServices ? [] : createMockTraces());
        const initialTasks =
            options.initialBackgroundTasks
            ?? (usingCustomServices ? [] : createMockBackgroundTasks());

        this.state = {
            isOpen: options.initialOpen ?? false,
            activeTab: options.initialTab ?? 'files',
            deepLink: {},
            activeTarget: options.initialTarget ?? { messageId: 12, swipeId: 0 },
            runMode: initialSettings.runMode,
            themeMode: initialSettings.themeMode,
            resolvedTheme: resolveThemeValue(initialSettings.themeMode, this.customLuminanceReader),
            settings: initialSettings,
            traces: [...initialTraces],
            backgroundTasks: [...initialTasks],
            toastQueue: [],
            activeModal: null,
        };

        if (this.services.subscribeEvents) {
            this.unsubscribeEvents = this.services.subscribeEvents((event) => {
                this.handleGenerationEvent(event);
            });
        }
    }

    getSnapshot(): AppStoreState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private setState(patch: Partial<AppStoreState>): void {
        this.state = {
            ...this.state,
            ...patch,
        };
        this.listeners.forEach((listener) => {
            try {
                listener();
            } catch {
                // Keep listener loop fault-tolerant.
            }
        });
    }

    getActivePreset(): Preset {
        return resolveActivePreset(this.state.settings);
    }

    getActiveConnection(): ApiConnection {
        return resolveConnection(this.state.settings);
    }

    openConsole(tab?: ConsoleTabId, deepLink?: DeepLinkState): void {
        const nextTab = tab ?? this.state.activeTab;
        const nextDeepLink = deepLink ? { ...deepLink } : this.state.deepLink;
        const nextTarget =
            deepLink?.messageId !== undefined
                ? {
                    messageId: deepLink.messageId,
                    swipeId: deepLink.swipeId ?? this.state.activeTarget.swipeId,
                }
                : this.state.activeTarget;

        this.setState({
            isOpen: true,
            activeTab: nextTab,
            deepLink: nextDeepLink,
            activeTarget: nextTarget,
            resolvedTheme: resolveThemeValue(this.state.themeMode, this.customLuminanceReader),
        });
    }

    closeConsole(): void {
        if (!this.state.isOpen && !this.state.activeModal) {
            return;
        }
        this.setState({
            isOpen: false,
            activeModal: null,
        });
    }

    toggleConsole(tab?: ConsoleTabId): void {
        if (this.state.isOpen) {
            this.closeConsole();
        } else {
            this.openConsole(tab);
        }
    }

    setActiveTab(tab: ConsoleTabId): void {
        if (this.state.activeTab === tab) {
            return;
        }
        this.setState({ activeTab: tab });
    }

    setDeepLink(deepLink: DeepLinkState): void {
        this.setState({ deepLink: { ...deepLink } });
    }

    clearDeepLink(): void {
        this.setState({ deepLink: {} });
    }

    setActiveTarget(target: MessageTarget): void {
        this.setState({ activeTarget: { ...target } });
    }

    refreshResolvedTheme(): void {
        const resolved = resolveThemeValue(this.state.themeMode, this.customLuminanceReader);
        if (resolved !== this.state.resolvedTheme) {
            this.setState({ resolvedTheme: resolved });
        }
    }

    async setRunMode(runMode: RunMode): Promise<void> {
        const nextSettings = normalizeSettings({
            ...this.state.settings,
            runMode,
        });
        this.setState({
            runMode: nextSettings.runMode,
            settings: nextSettings,
        });
        await this.persistSettingsSafe(nextSettings);

        const label =
            runMode === 'takeover'
                ? '完全接管 (Takeover)'
                : runMode === 'companion'
                    ? '伴生模式 (Companion)'
                    : '已关闭 (Off)';
        this.pushToast(`运行模式已切换为：${label}`, runMode === 'off' ? 'warning' : 'success');
    }

    async setThemeMode(themeMode: ThemeMode): Promise<void> {
        const nextSettings = normalizeSettings({
            ...this.state.settings,
            themeMode,
        });
        const resolvedTheme = resolveThemeValue(nextSettings.themeMode, this.customLuminanceReader);
        this.setState({
            themeMode: nextSettings.themeMode,
            resolvedTheme,
            settings: nextSettings,
        });
        await this.persistSettingsSafe(nextSettings);
    }

    async setCurrentPreset(presetId: string): Promise<void> {
        if (!this.state.settings.presets[presetId]) {
            return;
        }
        const nextSettings = normalizeSettings({
            ...this.state.settings,
            currentPresetId: presetId,
        });
        this.setState({ settings: nextSettings });
        await this.persistSettingsSafe(nextSettings);
        const presetName = nextSettings.presets[presetId]?.name ?? presetId;
        this.pushToast(`已切换预设：${presetName}`, 'success');
    }

    async setCurrentConnection(connectionId: string): Promise<void> {
        if (!this.state.settings.connections[connectionId]) {
            return;
        }
        const nextSettings = normalizeSettings({
            ...this.state.settings,
            currentConnectionId: connectionId,
        });
        this.setState({ settings: nextSettings });
        await this.persistSettingsSafe(nextSettings);
        const connName = nextSettings.connections[connectionId]?.name ?? connectionId;
        this.pushToast(`已切换主连接：${connName}`, 'success');
    }

    async updateSettings(updater: (prev: Settings) => Settings): Promise<Settings> {
        const nextSettings = normalizeSettings(updater(this.state.settings));
        const resolvedTheme = resolveThemeValue(nextSettings.themeMode, this.customLuminanceReader);
        this.setState({
            settings: nextSettings,
            runMode: nextSettings.runMode,
            themeMode: nextSettings.themeMode,
            resolvedTheme,
        });
        await this.persistSettingsSafe(nextSettings);
        return nextSettings;
    }

    private async persistSettingsSafe(settings: Settings): Promise<void> {
        try {
            await this.services.saveSettings(settings);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            this.pushToast(`保存设置失败：${msg}`, 'error');
        }
    }

    setTraces(traces: AgentRunTrace[]): void {
        this.setState({ traces: [...traces] });
    }

    upsertTrace(trace: AgentRunTrace): void {
        const idx = this.state.traces.findIndex((item) => item.runId === trace.runId);
        const nextTraces = [...this.state.traces];
        if (idx >= 0) {
            nextTraces[idx] = trace;
        } else {
            nextTraces.unshift(trace);
            if (nextTraces.length > 100) {
                nextTraces.length = 100;
            }
        }
        this.setState({ traces: nextTraces });
    }

    async refreshTraces(filter?: { messageId?: number; swipeId?: number }): Promise<void> {
        const traces = await this.services.listTraces(filter);
        this.setState({ traces });
    }

    setBackgroundTasks(tasks: BackgroundTaskStatus[]): void {
        this.setState({ backgroundTasks: [...tasks] });
    }

    upsertBackgroundTask(task: BackgroundTaskStatus): void {
        const idx = this.state.backgroundTasks.findIndex((item) => item.taskId === task.taskId);
        const nextTasks = [...this.state.backgroundTasks];
        if (idx >= 0) {
            nextTasks[idx] = task;
        } else {
            nextTasks.unshift(task);
        }
        this.setState({ backgroundTasks: nextTasks });
    }

    async cancelBackgroundTask(taskId: string): Promise<void> {
        await this.services.cancelBackgroundTask(taskId);
        const nextTasks = this.state.backgroundTasks.map((task) =>
            task.taskId === taskId
                ? { ...task, state: 'aborted' as const, endedAt: Date.now() }
                : task,
        );
        this.setState({ backgroundTasks: nextTasks });
        this.pushToast('已发送中断信号，仅取消该后台任务', 'warning');
    }

    async rerunAfterTurn(target?: MessageTarget): Promise<void> {
        const resolved = target ?? this.state.activeTarget;
        await this.services.rerunAfterTurn(resolved);
        this.pushToast(
            `已重新派发楼层 #${resolved.messageId}#${resolved.swipeId} 的后置触发任务`,
            'primary',
        );
    }

    pushToast(message: string, tone: ToastTone = 'primary', durationMs = 2800): string {
        this.toastCounter += 1;
        const id = `toast_${Date.now()}_${this.toastCounter}`;
        const item: ToastItem = {
            id,
            message,
            tone,
            createdAt: Date.now(),
            durationMs,
        };
        const nextQueue = [...this.state.toastQueue.slice(-4), item];
        this.setState({ toastQueue: nextQueue });

        if (durationMs > 0) {
            const timer = setTimeout(() => {
                this.dismissToast(id);
            }, durationMs);
            this.toastTimers.set(id, timer);
        }

        return id;
    }

    dismissToast(id: string): void {
        const timer = this.toastTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.toastTimers.delete(id);
        }
        if (!this.state.toastQueue.some((item) => item.id === id)) {
            return;
        }
        this.setState({
            toastQueue: this.state.toastQueue.filter((item) => item.id !== id),
        });
    }

    openModal(modal: ActiveModalState): void {
        this.setState({ activeModal: modal });
    }

    closeModal(): void {
        if (!this.state.activeModal) {
            return;
        }
        this.setState({ activeModal: null });
    }

    private handleGenerationEvent(event: GenerationEventPayload): void {
        if (event.kind === 'trace_recorded' && event.trace) {
            this.upsertTrace(event.trace);
        } else if (event.kind === 'background_task_updated' && event.task) {
            this.upsertBackgroundTask(event.task);
        }
    }

    dispose(): void {
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = undefined;
        this.toastTimers.forEach((timer) => clearTimeout(timer));
        this.toastTimers.clear();
        this.listeners.clear();
    }
}

let defaultAppStore: AppStore | null = null;

export function getDefaultAppStore(): AppStore {
    if (!defaultAppStore) {
        defaultAppStore = new AppStore();
    }
    return defaultAppStore;
}

export function setDefaultAppStore(store: AppStore): void {
    defaultAppStore = store;
}

export const AppStoreContext = createContext<AppStore | null>(null);

export interface AppStoreProviderProps {
    store: AppStore;
    children?: ComponentChildren;
}

export function AppStoreProvider({ store, children }: AppStoreProviderProps) {
    return createElement(AppStoreContext.Provider, { value: store }, children);
}

/** Retrieve the active `AppStore` instance from context or fallback singleton. */
export function useAppStoreInstance(): AppStore {
    return useContext(AppStoreContext) ?? getDefaultAppStore();
}

const identitySelector = (state: AppStoreState): AppStoreState => state;

/**
 * Subscribe a Preact component to `AppStore` state (or a selected slice)
 * using pure `preact/hooks` without `@preact/signals`.
 */
export function useAppStore(): AppStoreState;
export function useAppStore<T>(selector: (state: AppStoreState) => T): T;
export function useAppStore<T = AppStoreState>(
    selector: (state: AppStoreState) => T = identitySelector as (state: AppStoreState) => T,
): T {
    const store = useAppStoreInstance();
    const selectorRef = useRef(selector);
    selectorRef.current = selector;

    const [selected, setSelected] = useState<T>(() => selectorRef.current(store.getSnapshot()));
    const latestSelectedRef = useRef<T>(selected);
    latestSelectedRef.current = selected;

    useEffect(() => {
        const checkForUpdates = () => {
            const next = selectorRef.current(store.getSnapshot());
            if (!Object.is(latestSelectedRef.current, next)) {
                latestSelectedRef.current = next;
                setSelected(next);
            }
        };

        checkForUpdates();
        return store.subscribe(checkForUpdates);
    }, [store]);

    return selected;
}
