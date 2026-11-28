import { createContext, createElement, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import type { RemoteModelInfo, ToolSideGenApi } from '@/core/bridge';
import {
    createDefaultSettings,
    normalizeSettings,
    resolveActivePreset,
    resolveConnection,
} from '@/core/config';
import type {
    AgentRunTrace,
    ApiConnection,
    AssistantAttachment,
    AssistantCompactOptions,
    AssistantCompactReport,
    AssistantMessage,
    AssistantMode,
    AssistantRetryStatus,
    AssistantSession,
    AssistantSessionTokenStatus,
    BackgroundTaskStatus,
    ClassifiedLoreEntry,
    CompactionReport,
    ConsoleTabId,
    CustomToolConfig,
    DataNamespace,
    GenerationEventPayload,
    MessageTarget,
    MigrationReport,
    PendingApproval,
    Preset,
    RunMode,
    Settings,
    SideClueDoc,
    SideSessionInfo,
    ThemeMode,
    ToolStepLog,
    UndoRecord,
    WICategory,
} from '@/core/types';
import {
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
} from './mock-services';

export interface AssistantStreamingHooks {
    signal: AbortSignal;
    onDelta: (delta: string) => void;
    onRetry: (status?: AssistantRetryStatus) => void;
    onUpdate: (updatedSession: AssistantSession) => void;
}

function formatStoreErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export type ResolvedTheme = 'dark' | 'light';
export type ToastTone = 'primary' | 'success' | 'warning' | 'error';
export type MobileViewStack = 'list' | 'detail';
export type SideGenSubTab = 'clues' | 'sessions' | 'sdk';

export interface DeepLinkState {
    messageId?: number;
    filePath?: string;
    swipeId?: number;
    logId?: string;
    viewMode?: 'edit' | 'diff';
    assistantSessionId?: string;
    sideCluePath?: string;
    sideGenSubTab?: SideGenSubTab;
}

/**
 * Runtime bridge binding decoupling `AssistantView` (TS3.1) from `AssistantRunner` (TS2.1).
 */
export interface AssistantRuntimeBridge {
    listSessions(): Promise<AssistantSession[]> | AssistantSession[];
    getSession?(sessionId: string): Promise<AssistantSession | null> | AssistantSession | null;
    createSession(options?: {
        title?: string;
        mode?: AssistantMode;
        connectionId?: string;
        stAdminEnabled?: boolean;
        autoApproveAuthor?: boolean;
        autoApproveChatDelete?: boolean;
    }): Promise<AssistantSession>;
    deleteSession?(sessionId: string): Promise<boolean>;
    updateSessionConfig?(
        sessionId: string,
        patch: Partial<
            Pick<
                AssistantSession,
                | 'title'
                | 'mode'
                | 'stAdminEnabled'
                | 'autoApproveAuthor'
                | 'autoApproveChatDelete'
                | 'connectionId'
            >
        >,
    ): Promise<AssistantSession | null>;
    sendPrompt(
        sessionId: string,
        prompt: string,
        options?: {
            attachments?: AssistantAttachment[];
            onDelta?: (delta: string) => void;
            onRetry?: (status: AssistantRetryStatus) => void;
            onUpdate?: (session: AssistantSession) => void;
            signal?: AbortSignal;
        },
    ): Promise<AssistantMessage | AssistantSession | void>;
    editMessage?(
        sessionId: string,
        messageId: string,
        newContent: string,
    ): Promise<AssistantSession | null | void>;
    editAndResendMessage?(
        sessionId: string,
        messageId: string,
        newContent: string,
        options?: {
            onDelta?: (delta: string) => void;
            onRetry?: (status: AssistantRetryStatus) => void;
            onUpdate?: (session: AssistantSession) => void;
            signal?: AbortSignal;
        },
    ): Promise<AssistantMessage | AssistantSession | void>;
    retractMessage?(
        sessionId: string,
        messageId: string,
    ): Promise<
        | { session: AssistantSession; removedMessages: AssistantMessage[] }
        | AssistantSession
        | null
        | void
    >;
    regenerateLastMessage?(
        sessionId: string,
        options?: {
            onDelta?: (delta: string) => void;
            onRetry?: (status: AssistantRetryStatus) => void;
            onUpdate?: (session: AssistantSession) => void;
            signal?: AbortSignal;
        },
    ): Promise<AssistantMessage | AssistantSession | void>;
    continueLastMessage?(
        sessionId: string,
        options?: {
            onDelta?: (delta: string) => void;
            onRetry?: (status: AssistantRetryStatus) => void;
            onUpdate?: (session: AssistantSession) => void;
            signal?: AbortSignal;
        },
    ): Promise<AssistantMessage | AssistantSession | void>;
    abort?(sessionId?: string): void;
    listApprovals?(sessionId?: string): Promise<PendingApproval[]> | PendingApproval[];
    decideApproval(
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ): Promise<PendingApproval | null | void>;
    retryApproval(
        approvalId: string,
        feedback?: string,
    ): Promise<PendingApproval | null | void>;
    listUndoRecords?(sessionId?: string): Promise<UndoRecord[]> | UndoRecord[];
    applyUndo(undoId: string): Promise<boolean | UndoRecord | null | void>;
    readPreviewFile?(path: string): Promise<string | null>;
    getSessionTokenStatus?(
        sessionId: string,
    ): Promise<AssistantSessionTokenStatus | null> | AssistantSessionTokenStatus | null;
    compactSession?(
        sessionId: string,
        options?: AssistantCompactOptions,
    ): Promise<AssistantCompactReport>;
    subscribe?(listener: () => void): () => void;
}

/**
 * Runtime bridge binding decoupling `SideGenView` (TS3.2) from `SideGenService` (TS1.3).
 */
export type SideGenRuntimeBridge = ToolSideGenApi;

export interface ToastAction {
    label: string;
    onClick: () => void;
}

export interface ToastItem {
    id: string;
    message: string;
    tone: ToastTone;
    createdAt: number;
    durationMs: number;
    action?: ToastAction;
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

export type FileOverrideCategory =
    | 'instructions'
    | 'workspace'
    | 'variables'
    | 'worldinfo'
    | 'message';

export type FileStorageScope = 'chat_base' | 'chat_branch' | 'preset' | 'global';

export interface FileOverrideItem {
    id: string;
    category: FileOverrideCategory;
    storageScope?: FileStorageScope;
    namespace: DataNamespace;
    path: string;
    key: string;
    target: MessageTarget;
    layerLabel: string;
    source: string;
    content: string;
    baseContent?: string;
    overridden: boolean;
    renderedOnlyOverride?: boolean;
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
    trajectoryBytes?: number;
    trajectoryCheckpoints?: number;
}

export type { RemoteModelInfo };

export interface ConnectionTestResult {
    ok: boolean;
    latencyMs: number;
    message: string;
    cacheSupport?: string;
}

export interface ConnectionModelsResult {
    ok: boolean;
    latencyMs: number;
    models: RemoteModelInfo[];
    message: string;
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

export interface ClearPromptCachesResult {
    clearedPrefixes: number;
    clearedVfsCache: number;
    clearedLorebooks: number;
    clearedMessageCaches?: number;
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
        storageScope?: FileStorageScope;
    }): Promise<FileOverrideItem>;
    deleteFileOrOverride(input: {
        path: string;
        namespace: DataNamespace;
        key: string;
        target?: MessageTarget;
        storageScope?: FileStorageScope;
    }): Promise<void>;

    // Watermark & Cold-layer Compaction (View 3)
    getWatermarkStatuses(): Promise<AgentWatermarkStatus[]>;
    compactAgentContext(agentId: string): Promise<AgentWatermarkStatus>;
    clearAllPromptCaches?(): Promise<ClearPromptCachesResult>;
    getStorageOverview(): Promise<StorageOverview>;
    previewColdCompaction(keepDepth?: number): Promise<CompactionReport>;
    runColdCompaction(keepDepth?: number): Promise<CompactionReport>;

    // Traces & Execution Actions (View 2 & Capsule / Magic Menu)
    listTraces(filter?: { messageId?: number; swipeId?: number }): Promise<AgentRunTrace[]>;
    clearTraces?(): Promise<void>;
    stopTrace?(trace: AgentRunTrace): Promise<boolean> | boolean;
    continueTrace?(
        trace: AgentRunTrace,
        options?: { rollbackLastToolRound?: boolean },
    ): Promise<void>;
    retryTrace?(trace: AgentRunTrace): Promise<void>;
    rerunAfterTurn(target?: MessageTarget, options?: { triggerIds?: string[]; force?: boolean }): Promise<void>;
    resumeTurn?(target: MessageTarget): Promise<void>;
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
    fetchModels(connection: ApiConnection): Promise<ConnectionModelsResult>;
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

    // Off-Mainline Runtime Bridges (Assistant & SideGen, optional for backward compatibility)
    assistantRuntime?: AssistantRuntimeBridge;
    sideGenRuntime?: SideGenRuntimeBridge;
}

export interface AppStoreState {
    isOpen: boolean;
    isMaximized: boolean;
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
    // Off-Mainline UI State Slice (Assistant & SideGen)
    mobileAssistantStack: MobileViewStack;
    mobileSideGenStack: MobileViewStack;
    selectedAssistantSessionId: string | null;
    selectedSideCluePath: string | null;
    sideGenSubTab: SideGenSubTab;
    assistantSessions: AssistantSession[];
    assistantPendingApprovals: PendingApproval[];
    assistantUndoStack: UndoRecord[];
    assistantStreamingSessionId: string | null;
    assistantStreamingSessionIds: string[];
    assistantStreamingDeltas: Record<string, string>;
    sideClues: SideClueDoc[];
    sideSessions: SideSessionInfo[];
}

export interface AppStoreOptions {
    initialSettings?: Settings;
    initialTraces?: AgentRunTrace[];
    initialBackgroundTasks?: BackgroundTaskStatus[];
    initialTab?: ConsoleTabId;
    initialOpen?: boolean;
    initialMaximized?: boolean;
    initialTarget?: MessageTarget;
    initialMobileAssistantStack?: MobileViewStack;
    initialMobileSideGenStack?: MobileViewStack;
    initialAssistantSessionId?: string | null;
    initialSideCluePath?: string | null;
    initialSideGenSubTab?: SideGenSubTab;
    initialAssistantSessions?: AssistantSession[];
    initialAssistantPendingApprovals?: PendingApproval[];
    initialAssistantUndoStack?: UndoRecord[];
    initialSideClues?: SideClueDoc[];
    initialSideSessions?: SideSessionInfo[];
    services?: AgenticUIServices;
    assistantRuntime?: AssistantRuntimeBridge;
    sideGenRuntime?: SideGenRuntimeBridge;
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
    private unsubscribeAssistantRuntime?: () => void;
    private _assistantRuntime: AssistantRuntimeBridge | null = null;
    private _sideGenRuntime: SideGenRuntimeBridge | null = null;
    private readonly assistantStreamControllers = new Map<string, AbortController>();
    private assistantChatEpoch = 0;
    private disposed = false;
    private toastCounter = 0;
    private resumedEventCount = 0;

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
            isMaximized: options.initialMaximized ?? false,
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
            mobileAssistantStack: options.initialMobileAssistantStack ?? 'list',
            mobileSideGenStack: options.initialMobileSideGenStack ?? 'list',
            selectedAssistantSessionId: options.initialAssistantSessionId ?? null,
            selectedSideCluePath: options.initialSideCluePath ?? null,
            sideGenSubTab: options.initialSideGenSubTab ?? 'clues',
            assistantSessions: options.initialAssistantSessions
                ? [...options.initialAssistantSessions]
                : [],
            assistantPendingApprovals: options.initialAssistantPendingApprovals
                ? [...options.initialAssistantPendingApprovals]
                : [],
            assistantUndoStack: options.initialAssistantUndoStack
                ? [...options.initialAssistantUndoStack]
                : [],
            assistantStreamingSessionId: null,
            assistantStreamingSessionIds: [],
            assistantStreamingDeltas: {},
            sideClues: options.initialSideClues ? [...options.initialSideClues] : [],
            sideSessions: options.initialSideSessions ? [...options.initialSideSessions] : [],
        };

        const initialAssistantRuntime =
            options.assistantRuntime ?? this.services.assistantRuntime ?? null;
        if (initialAssistantRuntime) {
            this.setAssistantRuntime(initialAssistantRuntime);
        }

        const initialSideGenRuntime =
            options.sideGenRuntime ?? this.services.sideGenRuntime ?? null;
        if (initialSideGenRuntime) {
            this.setSideGenRuntime(initialSideGenRuntime);
        }

        if (this.services.subscribeEvents) {
            this.unsubscribeEvents = this.services.subscribeEvents((event) => {
                this.handleGenerationEvent(event);
            });
        }
    }

    get assistantRuntime(): AssistantRuntimeBridge | null {
        return this._assistantRuntime;
    }

    get sideGenRuntime(): SideGenRuntimeBridge | null {
        return this._sideGenRuntime;
    }

    getAssistantRuntime(): AssistantRuntimeBridge | null {
        return this._assistantRuntime;
    }

    setAssistantRuntime(runtime: AssistantRuntimeBridge | null): void {
        this.unsubscribeAssistantRuntime?.();
        this.unsubscribeAssistantRuntime = undefined;
        this._assistantRuntime = runtime;
        if (runtime?.subscribe) {
            this.unsubscribeAssistantRuntime = runtime.subscribe(() => {
                void this.refreshAssistantState();
            });
        }
    }

    getSideGenRuntime(): SideGenRuntimeBridge | null {
        return this._sideGenRuntime;
    }

    setSideGenRuntime(runtime: SideGenRuntimeBridge | null): void {
        this._sideGenRuntime = runtime;
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

        let nextMobileAssistantStack = this.state.mobileAssistantStack;
        let nextSelectedAssistantSessionId = this.state.selectedAssistantSessionId;
        if (nextTab === 'assistant') {
            if (deepLink?.assistantSessionId) {
                nextSelectedAssistantSessionId = deepLink.assistantSessionId;
                nextMobileAssistantStack = 'detail';
            } else if (tab === 'assistant' || this.state.activeTab !== 'assistant') {
                // Default mobile assistant entry to session list unless deep-linking a specific session.
                nextMobileAssistantStack = 'list';
            }
        } else if (this.state.activeTab === 'assistant') {
            nextMobileAssistantStack = 'list';
        }

        let nextMobileSideGenStack = this.state.mobileSideGenStack;
        let nextSelectedSideCluePath = this.state.selectedSideCluePath;
        let nextSideGenSubTab = this.state.sideGenSubTab;
        if (nextTab === 'sidegen') {
            if (deepLink?.sideGenSubTab) {
                nextSideGenSubTab = deepLink.sideGenSubTab;
            }
            if (deepLink?.sideCluePath) {
                nextSelectedSideCluePath = deepLink.sideCluePath;
                nextMobileSideGenStack = 'detail';
            } else if (tab === 'sidegen' || this.state.activeTab !== 'sidegen') {
                nextMobileSideGenStack = 'list';
            }
        }

        this.setState({
            isOpen: true,
            activeTab: nextTab,
            deepLink: nextDeepLink,
            activeTarget: nextTarget,
            resolvedTheme: resolveThemeValue(this.state.themeMode, this.customLuminanceReader),
            mobileAssistantStack: nextMobileAssistantStack,
            selectedAssistantSessionId: nextSelectedAssistantSessionId,
            mobileSideGenStack: nextMobileSideGenStack,
            selectedSideCluePath: nextSelectedSideCluePath,
            sideGenSubTab: nextSideGenSubTab,
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

    setMaximized(maximized: boolean): void {
        if (this.state.isMaximized === maximized) {
            return;
        }
        this.setState({ isMaximized: maximized });
    }

    toggleMaximized(): void {
        this.setMaximized(!this.state.isMaximized);
    }

    setActiveTab(tab: ConsoleTabId): void {
        const patch: Partial<AppStoreState> = {};
        if (this.state.activeTab !== tab) {
            patch.activeTab = tab;
        }

        // Mobile rule: switching to 'assistant' (or leaving it) resets stack to 'list'
        // so users always land on the session list and console chrome stays visible.
        if (tab === 'assistant' && this.state.mobileAssistantStack !== 'list') {
            patch.mobileAssistantStack = 'list';
        } else if (
            tab !== 'assistant'
            && this.state.activeTab === 'assistant'
            && this.state.mobileAssistantStack !== 'list'
        ) {
            patch.mobileAssistantStack = 'list';
        }

        if (tab === 'sidegen' && this.state.mobileSideGenStack !== 'list') {
            patch.mobileSideGenStack = 'list';
        }

        if (Object.keys(patch).length === 0) {
            return;
        }
        this.setState(patch);
    }

    setMobileAssistantStack(stack: MobileViewStack): void {
        if (this.state.mobileAssistantStack === stack) {
            return;
        }
        this.setState({ mobileAssistantStack: stack });
    }

    setSelectedAssistantSessionId(sessionId: string | null): void {
        if (this.state.selectedAssistantSessionId === sessionId) {
            return;
        }
        this.setState({ selectedAssistantSessionId: sessionId });
    }

    openAssistantSession(sessionId: string): void {
        this.setState({
            selectedAssistantSessionId: sessionId,
            mobileAssistantStack: 'detail',
        });
    }

    backToAssistantList(): void {
        if (this.state.mobileAssistantStack === 'list') {
            return;
        }
        this.setState({ mobileAssistantStack: 'list' });
    }

    setMobileSideGenStack(stack: MobileViewStack): void {
        if (this.state.mobileSideGenStack === stack) {
            return;
        }
        this.setState({ mobileSideGenStack: stack });
    }

    setSideGenSubTab(subTab: SideGenSubTab): void {
        if (this.state.sideGenSubTab === subTab && this.state.mobileSideGenStack === 'list') {
            return;
        }
        this.setState({
            sideGenSubTab: subTab,
            mobileSideGenStack: 'list',
        });
    }

    setSelectedSideCluePath(path: string | null): void {
        if (this.state.selectedSideCluePath === path) {
            return;
        }
        this.setState({ selectedSideCluePath: path });
    }

    openSideClue(path: string): void {
        this.setState({
            selectedSideCluePath: path,
            mobileSideGenStack: 'detail',
        });
    }

    backToSideClueList(): void {
        if (this.state.mobileSideGenStack === 'list') {
            return;
        }
        this.setState({ mobileSideGenStack: 'list' });
    }

    setAssistantSessions(sessions: AssistantSession[]): void {
        const nextSessions = [...sessions];
        const currentSelected = this.state.selectedAssistantSessionId;
        const stillExists =
            currentSelected !== null
            && nextSessions.some((session) => session.id === currentSelected);
        this.setState({
            assistantSessions: nextSessions,
            selectedAssistantSessionId: stillExists
                ? currentSelected
                : (nextSessions[0]?.id ?? null),
        });
    }

    setAssistantPendingApprovals(approvals: PendingApproval[]): void {
        this.setState({ assistantPendingApprovals: [...approvals] });
    }

    setAssistantUndoStack(records: UndoRecord[]): void {
        this.setState({ assistantUndoStack: [...records] });
    }

    setAssistantStreamingSessionId(sessionId: string | null): void {
        if (sessionId === null) {
            if (
                this.state.assistantStreamingSessionId === null
                && this.state.assistantStreamingSessionIds.length === 0
                && Object.keys(this.state.assistantStreamingDeltas).length === 0
            ) {
                return;
            }
            this.setState({
                assistantStreamingSessionId: null,
                assistantStreamingSessionIds: [],
                assistantStreamingDeltas: {},
            });
            return;
        }

        const nextIds = this.state.assistantStreamingSessionIds.includes(sessionId)
            ? this.state.assistantStreamingSessionIds
            : [...this.state.assistantStreamingSessionIds, sessionId];
        if (
            this.state.assistantStreamingSessionId === sessionId
            && nextIds === this.state.assistantStreamingSessionIds
        ) {
            return;
        }
        this.setState({
            assistantStreamingSessionId: sessionId,
            assistantStreamingSessionIds: nextIds,
        });
    }

    isAssistantSessionStreaming(sessionId: string): boolean {
        return (
            this.state.assistantStreamingSessionIds.includes(sessionId)
            || this.state.assistantStreamingSessionId === sessionId
            || this.assistantStreamControllers.has(sessionId)
        );
    }

    upsertAssistantSession(updated: AssistantSession): void {
        const current = this.state.assistantSessions;
        const idx = current.findIndex((item) => item.id === updated.id);
        if (idx >= 0) {
            const next = [...current];
            next[idx] = updated;
            this.setAssistantSessions(next);
        } else {
            this.setAssistantSessions([updated, ...current]);
        }
    }

    private clearAssistantStreamingState(sessionId: string): void {
        const nextIds = this.state.assistantStreamingSessionIds.filter((id) => id !== sessionId);
        const hasDelta = Object.prototype.hasOwnProperty.call(
            this.state.assistantStreamingDeltas,
            sessionId,
        );
        const nextDeltas = hasDelta
            ? Object.fromEntries(
                Object.entries(this.state.assistantStreamingDeltas).filter(
                    ([id]) => id !== sessionId,
                ),
            )
            : this.state.assistantStreamingDeltas;
        const nextPrimaryId =
            this.state.assistantStreamingSessionId === sessionId
                ? (nextIds[nextIds.length - 1] ?? null)
                : this.state.assistantStreamingSessionId;

        if (
            nextIds.length === this.state.assistantStreamingSessionIds.length
            && !hasDelta
            && nextPrimaryId === this.state.assistantStreamingSessionId
        ) {
            return;
        }

        this.setState({
            assistantStreamingSessionId: nextPrimaryId,
            assistantStreamingSessionIds: nextIds,
            assistantStreamingDeltas: nextDeltas,
        });
    }

    /**
     * Run an assistant streaming operation under AppStore ownership so tab switches
     * or view unmounts inside the console do not abort in-flight generation.
     */
    async runAssistantStreamingOperation(
        sessionId: string,
        executor: (
            hooks: AssistantStreamingHooks,
        ) => Promise<AssistantMessage | AssistantSession | void>,
        errorPrefix: string,
    ): Promise<void> {
        if (this.disposed) {
            return;
        }

        const existingController = this.assistantStreamControllers.get(sessionId);
        if (existingController) {
            existingController.abort();
            this.assistantStreamControllers.delete(sessionId);
        }

        const controller = new AbortController();
        this.assistantStreamControllers.set(sessionId, controller);

        const nextIds = this.state.assistantStreamingSessionIds.includes(sessionId)
            ? this.state.assistantStreamingSessionIds
            : [...this.state.assistantStreamingSessionIds, sessionId];
        this.setState({
            assistantStreamingSessionId: sessionId,
            assistantStreamingSessionIds: nextIds,
            assistantStreamingDeltas: {
                ...this.state.assistantStreamingDeltas,
                [sessionId]: '',
            },
        });

        let receivedOnUpdate = false;
        let liveBubbleOwned = false;
        const runChatEpoch = this.assistantChatEpoch;
        const isCurrentRun = () =>
            !this.disposed
            && this.assistantChatEpoch === runChatEpoch
            && this.assistantStreamControllers.get(sessionId) === controller;

        try {
            const result = await executor({
                signal: controller.signal,
                onDelta: (delta: string) => {
                    if (controller.signal.aborted || liveBubbleOwned || !isCurrentRun()) {
                        return;
                    }
                    const prevText = this.state.assistantStreamingDeltas[sessionId] ?? '';
                    this.setState({
                        assistantStreamingDeltas: {
                            ...this.state.assistantStreamingDeltas,
                            [sessionId]: prevText + delta,
                        },
                    });
                },
                onRetry: () => {
                    if (controller.signal.aborted || !isCurrentRun()) {
                        return;
                    }
                    this.setState({
                        assistantStreamingDeltas: {
                            ...this.state.assistantStreamingDeltas,
                            [sessionId]: '',
                        },
                    });
                },
                onUpdate: (updatedSession: AssistantSession) => {
                    if (this.disposed || this.assistantChatEpoch !== runChatEpoch) {
                        return;
                    }
                    receivedOnUpdate = true;
                    const last = updatedSession.messages[updatedSession.messages.length - 1];
                    if (last?.role === 'assistant') {
                        liveBubbleOwned = true;
                        if (!controller.signal.aborted && isCurrentRun()) {
                            this.setState({
                                assistantStreamingDeltas: {
                                    ...this.state.assistantStreamingDeltas,
                                    [sessionId]: '',
                                },
                            });
                        }
                    } else {
                        liveBubbleOwned = false;
                    }
                    this.upsertAssistantSession(updatedSession);
                },
            });

            if (this.disposed || this.assistantChatEpoch !== runChatEpoch) {
                return;
            }

            if (result && 'messages' in result && Array.isArray(result.messages)) {
                this.upsertAssistantSession(result);
            } else if (!receivedOnUpdate && result && 'role' in result) {
                const cur = this.state.assistantSessions.find((item) => item.id === sessionId);
                if (cur && !cur.messages.some((m) => m.id === result.id)) {
                    this.upsertAssistantSession({
                        ...cur,
                        updatedAt: Date.now(),
                        messages: [...cur.messages, result],
                    });
                }
            }

            const finalAssistantMsg =
                result && 'role' in result
                    ? result
                    : result && 'messages' in result && Array.isArray(result.messages)
                        ? result.messages[result.messages.length - 1]
                        : undefined;
            if (finalAssistantMsg?.interrupted) {
                if (finalAssistantMsg.errorCode === 'max_tool_rounds') {
                    this.pushToast(
                        '已达到单轮工具调用上限，可点击「继续执行」接着运行',
                        'warning',
                    );
                } else if (finalAssistantMsg.errorCode === 'length') {
                    this.pushToast(
                        '输出达到长度上限已截断，可点击「继续生成」接着输出',
                        'warning',
                    );
                }
            }
        } catch (err) {
            if (!this.disposed && this.assistantChatEpoch === runChatEpoch && !controller.signal.aborted) {
                this.pushToast(`${errorPrefix}：${formatStoreErrorMessage(err)}`, 'error');
            }
        } finally {
            if (this.assistantStreamControllers.get(sessionId) === controller) {
                this.assistantStreamControllers.delete(sessionId);
                this.clearAssistantStreamingState(sessionId);
            }
            if (!this.disposed && this.assistantChatEpoch === runChatEpoch) {
                try {
                    await this.refreshAssistantState();
                } catch {
                    // Keep UI responsive even if refresh fails after abort.
                }
            }
        }
    }

    abortAssistantStream(
        sessionId?: string,
        options?: { silentToast?: boolean; chatChanged?: boolean },
    ): void {
        if (options?.chatChanged) {
            this.assistantChatEpoch += 1;
        }
        if (sessionId) {
            const controller = this.assistantStreamControllers.get(sessionId);
            if (controller) {
                this.assistantStreamControllers.delete(sessionId);
                controller.abort();
            }
            this._assistantRuntime?.abort?.(sessionId);
            this.clearAssistantStreamingState(sessionId);
        } else {
            const controllers = Array.from(this.assistantStreamControllers.values());
            this.assistantStreamControllers.clear();
            for (const controller of controllers) {
                controller.abort();
            }
            this._assistantRuntime?.abort?.();
            if (
                this.state.assistantStreamingSessionId !== null
                || this.state.assistantStreamingSessionIds.length > 0
                || Object.keys(this.state.assistantStreamingDeltas).length > 0
            ) {
                this.setState({
                    assistantStreamingSessionId: null,
                    assistantStreamingSessionIds: [],
                    assistantStreamingDeltas: {},
                });
            }
        }

        if (!options?.silentToast && !this.disposed) {
            this.pushToast('已停止当前助手生成', 'warning');
        }
    }

    setSideClues(clues: SideClueDoc[]): void {
        const nextClues = [...clues];
        const currentPath = this.state.selectedSideCluePath;
        const stillExists =
            currentPath !== null
            && nextClues.some((clue) => clue.path === currentPath);
        this.setState({
            sideClues: nextClues,
            selectedSideCluePath: stillExists ? currentPath : (nextClues[0]?.path ?? null),
        });
    }

    setSideSessions(sessions: SideSessionInfo[]): void {
        this.setState({ sideSessions: [...sessions] });
    }

    async refreshAssistantState(): Promise<void> {
        const runtime = this._assistantRuntime;
        if (!runtime) {
            return;
        }
        const [sessions, approvals, undoRecords] = await Promise.all([
            Promise.resolve(runtime.listSessions()),
            runtime.listApprovals ? Promise.resolve(runtime.listApprovals()) : Promise.resolve(null),
            runtime.listUndoRecords ? Promise.resolve(runtime.listUndoRecords()) : Promise.resolve(null),
        ]);

        const patch: Partial<AppStoreState> = {
            assistantSessions: [...sessions],
        };
        const currentSelected = this.state.selectedAssistantSessionId;
        if (
            !currentSelected
            || !sessions.some((session) => session.id === currentSelected)
        ) {
            patch.selectedAssistantSessionId = sessions[0]?.id ?? null;
        }
        if (approvals !== null) {
            patch.assistantPendingApprovals = [...approvals];
        }
        if (undoRecords !== null) {
            patch.assistantUndoStack = [...undoRecords];
        }
        this.setState(patch);
    }

    async refreshSideGenState(target?: MessageTarget): Promise<void> {
        const runtime = this._sideGenRuntime;
        if (!runtime) {
            return;
        }
        const resolvedTarget = target ?? this.state.activeTarget;
        const [clues, sessions] = await Promise.all([
            runtime.clues.list(resolvedTarget),
            runtime.listSessions(),
        ]);
        const currentPath = this.state.selectedSideCluePath;
        const nextSelectedPath =
            currentPath && clues.some((clue) => clue.path === currentPath)
                ? currentPath
                : (clues[0]?.path ?? null);
        this.setState({
            sideClues: [...clues],
            sideSessions: [...sessions],
            selectedSideCluePath: nextSelectedPath,
        });
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

    async rerunAfterTurn(
        target?: MessageTarget,
        options?: {
            triggerIds?: string[];
            force?: boolean;
            label?: string;
            silentToast?: boolean;
        },
    ): Promise<void> {
        const resolved = target ?? this.state.activeTarget;
        const prevRunIds = new Set(this.state.traces.map((t) => t.runId));
        const serviceOpts: { triggerIds?: string[]; force?: boolean } = {};
        if (options?.triggerIds?.length) {
            serviceOpts.triggerIds = options.triggerIds;
        }
        if (options?.force) {
            serviceOpts.force = true;
        }
        await this.services.rerunAfterTurn(
            resolved,
            Object.keys(serviceOpts).length > 0 ? serviceOpts : undefined,
        );
        if (!options?.silentToast) {
            const newestErrorTrace = this.state.traces.find(
                (t) =>
                    !prevRunIds.has(t.runId)
                    && t.target.messageId === resolved.messageId
                    && t.target.swipeId === resolved.swipeId
                    && t.phase === 'after_turn'
                    && t.status === 'error',
            );
            if (newestErrorTrace) {
                const labelPrefix = options?.label ? `「${options.label}」` : '';
                this.pushToast(
                    `触发器${labelPrefix}在 #${resolved.messageId}#${resolved.swipeId} 执行失败：${newestErrorTrace.error || '请查看日志'}`,
                    'error',
                    5000,
                );
            } else {
                this.pushToast(
                    options?.label
                        ? `已重新派发 #${resolved.messageId}#${resolved.swipeId} 的后置触发：${options.label}`
                        : `已重新派发楼层 #${resolved.messageId}#${resolved.swipeId} 的后置触发任务`,
                    'primary',
                );
            }
        }
    }

    async resumeTurn(target?: MessageTarget): Promise<void> {
        const resolved = target ?? this.state.activeTarget;
        if (!this.services.resumeTurn) {
            this.pushToast('当前运行时不支持断点恢复', 'warning');
            return;
        }
        const prevEventCount = this.resumedEventCount;
        await this.services.resumeTurn(resolved);
        if (this.resumedEventCount === prevEventCount) {
            this.pushToast(
                `已恢复 #${resolved.messageId}#${resolved.swipeId} 的 /output.md 生成`,
                'success',
            );
        }
    }

    pushToast(
        message: string,
        tone: ToastTone = 'primary',
        durationMs = 2800,
        action?: ToastAction,
    ): string {
        this.toastCounter += 1;
        const id = `toast_${Date.now()}_${this.toastCounter}`;
        const item: ToastItem = {
            id,
            message,
            tone,
            createdAt: Date.now(),
            durationMs,
            ...(action ? { action } : {}),
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

    private findMatchingTraceIndex(event: GenerationEventPayload): number {
        if (event.runId) {
            const byRunId = this.state.traces.findIndex((item) => item.runId === event.runId);
            if (byRunId >= 0) {
                return byRunId;
            }
        }
        const phase = event.phase ?? 'main_turn';
        return this.state.traces.findIndex(
            (item) =>
                item.target.messageId === event.target.messageId
                && item.target.swipeId === event.target.swipeId
                && item.phase === phase,
        );
    }

    private handleGenerationEvent(event: GenerationEventPayload): void {
        if (event.kind === 'trace_recorded' && event.trace) {
            this.upsertTrace(event.trace);
            return;
        }
        if ((event.kind === 'tool_started' || event.kind === 'tool_completed') && event.toolStep) {
            const idx = this.findMatchingTraceIndex(event);
            if (idx < 0) {
                return;
            }
            const existing = this.state.traces[idx];
            const incomingStep: ToolStepLog = {
                ...event.toolStep,
                status:
                    event.toolStep.status
                    ?? (event.kind === 'tool_started'
                        ? 'running'
                        : event.toolStep.ok
                            ? 'completed'
                            : 'error'),
            };
            const existingStepIdx = existing.toolSteps.findIndex(
                (step) =>
                    step.stepIndex === incomingStep.stepIndex
                    && step.toolCallId === incomingStep.toolCallId,
            );
            if (existingStepIdx >= 0) {
                const prevStep = existing.toolSteps[existingStepIdx];
                if (
                    prevStep.status === incomingStep.status
                    && prevStep.ok === incomingStep.ok
                    && prevStep.result === incomingStep.result
                    && prevStep.error === incomingStep.error
                    && prevStep.durationMs === incomingStep.durationMs
                ) {
                    return;
                }
            }
            const nextSteps = [...existing.toolSteps];
            if (existingStepIdx >= 0) {
                nextSteps[existingStepIdx] = incomingStep;
            } else {
                nextSteps.push(incomingStep);
            }
            const nextTraces = [...this.state.traces];
            nextTraces[idx] = {
                ...existing,
                durationMs: Math.max(
                    existing.durationMs,
                    Math.max(0, (event.timestamp || Date.now()) - existing.startedAt),
                ),
                toolSteps: nextSteps,
            };
            this.setState({ traces: nextTraces });
            return;
        }
        if (event.kind === 'background_task_updated' && event.task) {
            this.upsertBackgroundTask(event.task);
            return;
        }
        if (event.kind === 'output_preview' && event.outputPreview !== undefined) {
            const idx = this.findMatchingTraceIndex(event);
            if (idx >= 0) {
                const existing = this.state.traces[idx];
                if (existing.outputPreview !== event.outputPreview) {
                    const nextTraces = [...this.state.traces];
                    nextTraces[idx] = {
                        ...existing,
                        outputPreview: event.outputPreview,
                    };
                    this.setState({ traces: nextTraces });
                }
            }
            return;
        }
        if (event.kind === 'turn_interrupted') {
            if (event.trace) {
                this.upsertTrace(event.trace);
                return;
            }
            const idx = this.findMatchingTraceIndex(event);
            if (idx >= 0) {
                const existing = this.state.traces[idx];
                const nextTraces = [...this.state.traces];
                nextTraces[idx] = {
                    ...existing,
                    status: 'interrupted',
                    interruptedReason: event.interruptedReason ?? existing.interruptedReason,
                    error: event.error ?? existing.error,
                    outputPreview: event.outputPreview ?? existing.outputPreview,
                    endedAt: event.timestamp || Date.now(),
                };
                this.setState({ traces: nextTraces });
            }
            return;
        }
        if (event.kind === 'turn_resumed') {
            this.resumedEventCount += 1;
            if (event.trace) {
                this.upsertTrace(event.trace);
            } else {
                const idx = this.findMatchingTraceIndex(event);
                if (idx >= 0) {
                    const existing = this.state.traces[idx];
                    if (existing.status === 'interrupted') {
                        const nextTraces = [...this.state.traces];
                        nextTraces[idx] = {
                            ...existing,
                            status: 'running',
                            interruptedReason: undefined,
                            error: undefined,
                        };
                        this.setState({ traces: nextTraces });
                    }
                }
            }
            this.pushToast(
                `已恢复 #${event.target.messageId}#${event.target.swipeId} 的 /output.md 生成`,
                'success',
            );
        }
    }

    dispose(): void {
        this.disposed = true;
        const controllers = Array.from(this.assistantStreamControllers.values());
        this.assistantStreamControllers.clear();
        for (const controller of controllers) {
            controller.abort();
        }
        this.unsubscribeEvents?.();
        this.unsubscribeEvents = undefined;
        this.unsubscribeAssistantRuntime?.();
        this.unsubscribeAssistantRuntime = undefined;
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
