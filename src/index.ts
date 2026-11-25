import { AgentRunner } from '@/core/agents';
import {
    AssistantRunner,
    AssistantSessionStore,
    UndoStore,
    createChatMetadataUndoAdapter,
} from '@/core/assistant';
import type { ToolSideGenApi } from '@/core/bridge';
import {
    createDefaultSettings,
    DEFAULT_FILE_MAP_SIZE_LIMIT,
    exportPreset,
    importConnections,
    importPreset,
    importSettings,
    normalizeSettings,
    resolveActivePreset,
    validateConnectionsImport,
    validatePresetFileName,
    validatePresetImport,
    validateSettingsImport,
} from '@/core/config';
import {
    ContextAssembler,
    TrajectoryStore,
    TransientToolSpillStore,
    WatermarkCompactor,
} from '@/core/context';
import { FetchLLMTransport } from '@/core/llm';
import { TraceLogger } from '@/core/logger';
import {
    buildLoreVfsPath,
    LoreReadEvaluator,
    TailRadar,
    WIClassifier,
} from '@/core/lore';
import {
    importSillyTavernOpenAIPreset,
    isLegacyCustomGenerationData,
    isSillyTavernOpenAIPreset,
    migrateFromCustomGeneration,
} from '@/core/migration';
import { RegexPipeline } from '@/core/regex';
import { SideGenService } from '@/core/sidegen';
import {
    CHAT_VARIABLES_DOC_KEY,
    ChatDataStore,
    DATA_NAMESPACES,
    DataCompactor,
    GLOBAL_VARIABLES_DOC_KEY,
    invalidateHeadIndex,
    VARIABLES_DOC_KEY,
    worldInfoKey,
} from '@/core/store';
import {
    BUILTIN_TOOL_NAMES,
    compileCustomToolConfig,
    compileLoreToolEntry,
    compileSlashBridgeTool,
    createBuiltinToolRegistry,
    createToolExecutionContext,
    registerCustomTools,
    type ToolRegistry,
} from '@/core/tools';
import {
    BarrierCoordinator,
    DecoratorCompiler,
    PipelineOrchestrator,
} from '@/core/triggers';
import type {
    AgentProfile,
    AgentRunTrace,
    ApiConnection,
    ClassifiedLoreEntry,
    CompactionReport,
    CustomToolConfig,
    DataNamespace,
    MessageTarget,
    MigrationReport,
    Preset,
    RawLoreEntry,
    Settings,
    WICategory,
} from '@/core/types';
import { canonicalClone, canonicalStringify, initXxHash, normalizeVfsPath } from '@/core/utils';
import {
    GLOBAL_VFS_EXTENSION_KEY,
    OUTPUT_FILE_PATH,
    VirtualFileSystem,
    isChatBaseWorkspacePath,
    isInstructionDocPath,
    isInstructionIndexPath,
} from '@/core/vfs';
import type { AgenticAssistantPublicApi, AgenticPublicApi } from '@/globals';
import { type CompanionHooksHandle, setupCompanionHooks } from '@/host/companion-hooks';
import { evaluateOptionalEjs } from '@/host/ejs-adapter';
import {
    embedFilesToCard,
    embedPresetToCard,
    getEmbeddedCardStatus,
    importEmbeddedFromCard,
    setupEmbedCard,
} from '@/host/embed-card';
import {
    type AgenticInterceptorHandle,
    createAgenticInterceptor,
    type STGenerateInterceptor,
} from '@/host/interceptor';
import { registerSideGenSlashCommands } from '@/host/sidegen-slash';
import { executeStSlashCommand } from '@/host/slash-bridge';
import {
    DEFAULT_EXTENSION_SETTINGS_KEY,
    STHostBridge,
} from '@/host/st-bridge';
import { IframeJsSandbox, SandboxLifecycleManager } from '@/sandbox';
import { registerAssistantView } from '@/ui/assistant';
import {
    type AgenticCapsuleElement,
    mountExtensionsMenuItems,
    mountExtensionsSettingsCard,
    placeAgenticCapsule,
    registerAgenticCapsuleElement,
} from '@/ui/capsule';
import { registerSessionViews } from '@/ui/session';
import { mountAgenticAppShell } from '@/ui/shell';
import { registerSideGenView } from '@/ui/sidegen';
import {
    AppStore,
    type AgenticUIServices,
    type AgentWatermarkStatus,
    type ConnectionModelsResult,
    type ConnectionTestResult,
    type EmbeddedCardStatus,
    type FileOverrideItem,
    type ImportPresetResult,
    type StorageOverview,
    type ToolTestResult,
    setDefaultAppStore,
} from '@/ui/store';
import { registerStudioViews } from '@/ui/studio';
import { chat, saveMetadata, saveSettingsDebounced } from '@st/script.js';
import { event_types, eventSource } from '@st/scripts/events.js';
import { extension_settings } from '@st/scripts/extensions.js';

const AGENTIC_VERSION = '0.1.0';
const LEGACY_EXTENSION_SETTINGS_KEY = 'CustomGeneration';
const BUILTIN_TOOL_NAME_SET = new Set<string>(BUILTIN_TOOL_NAMES);

let resolveBootReady: (() => void) | null = null;
const bootReadyPromise = new Promise<void>((resolve) => {
    resolveBootReady = resolve;
});
let bootFailed = false;
let activeRealInterceptor: STGenerateInterceptor | null = null;

/**
 * Register a safe early interceptor placeholder until async initialization completes,
 * matching `manifest.json` `generate_interceptor: "Agentic_interceptor"`.
 */
function ensureEarlyInterceptorPlaceholder(): void {
    const holder = globalThis as { Agentic_interceptor?: STGenerateInterceptor };
    if (typeof holder.Agentic_interceptor === 'function') {
        return;
    }

    const earlyPlaceholder: STGenerateInterceptor = async (
        chatMessages: Parameters<STGenerateInterceptor>[0],
        contextSize: Parameters<STGenerateInterceptor>[1],
        abort: Parameters<STGenerateInterceptor>[2],
        type: Parameters<STGenerateInterceptor>[3],
    ) => {
        if (!activeRealInterceptor && !bootFailed) {
            await bootReadyPromise;
        }
        if (activeRealInterceptor) {
            await activeRealInterceptor(chatMessages, contextSize, abort, type);
        }
    };
    holder.Agentic_interceptor = earlyPlaceholder;
}

ensureEarlyInterceptorPlaceholder();

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStoredAgenticSettings(raw: unknown): raw is Record<string, unknown> {
    if (!isPlainObject(raw)) {
        return false;
    }
    return (
        'presets' in raw
        || 'connections' in raw
        || 'currentPresetId' in raw
        || 'currentConnectionId' in raw
        || 'runMode' in raw
    );
}

function ensureAgenticBucket(): Record<string, unknown> {
    const root = extension_settings as Record<string, unknown>;
    if (!isPlainObject(root[DEFAULT_EXTENSION_SETTINGS_KEY])) {
        root[DEFAULT_EXTENSION_SETTINGS_KEY] = {};
    }
    return root[DEFAULT_EXTENSION_SETTINGS_KEY] as Record<string, unknown>;
}

function persistAgenticSettings(next: Settings, persistDebounced = true): Settings {
    const normalized = normalizeSettings(next);
    const bucket = ensureAgenticBucket();
    // Merge normalized settings fields while preserving auxiliary extension data keys (e.g. global VFS files).
    Object.assign(bucket, canonicalClone(normalized));
    if (persistDebounced) {
        saveSettingsDebounced();
    }
    return normalized;
}

function loadOrMigrateSettings(): {
    settings: Settings;
    migrationReport?: MigrationReport;
} {
    const root = extension_settings as Record<string, unknown>;
    const existingAgentic = root[DEFAULT_EXTENSION_SETTINGS_KEY];

    if (hasStoredAgenticSettings(existingAgentic)) {
        return {
            settings: normalizeSettings(existingAgentic),
        };
    }

    // Strictly read-only detection of legacy CustomGeneration config on first boot.
    const rawLegacy = root[LEGACY_EXTENSION_SETTINGS_KEY];
    if (rawLegacy && isLegacyCustomGenerationData(rawLegacy)) {
        const migrated = migrateFromCustomGeneration(rawLegacy);
        const persisted = persistAgenticSettings(migrated.settings, true);
        return {
            settings: persisted,
            migrationReport: migrated.report,
        };
    }

    return {
        settings: persistAgenticSettings(createDefaultSettings(), true),
    };
}

function resolveValidTarget(candidate?: MessageTarget | null): MessageTarget {
    if (
        candidate
        && Number.isInteger(candidate.messageId)
        && candidate.messageId >= 0
        && Number.isInteger(candidate.swipeId)
        && candidate.swipeId >= 0
    ) {
        return { messageId: candidate.messageId, swipeId: candidate.swipeId };
    }
    if (!Array.isArray(chat) || chat.length === 0) {
        return { messageId: 0, swipeId: 0 };
    }
    const lastIndex = chat.length - 1;
    const lastMessage = chat[lastIndex] as { swipe_id?: unknown } | undefined;
    const swipeId =
        typeof lastMessage?.swipe_id === 'number'
        && Number.isInteger(lastMessage.swipe_id)
        && lastMessage.swipe_id >= 0
            ? lastMessage.swipe_id
            : 0;
    return { messageId: lastIndex, swipeId };
}

function formatLayerLabel(messageId: number, swipeId: number, isBase = false): string {
    if (isBase || messageId < 0) {
        return 'Base 层 (全局默认)';
    }
    return `L${messageId}#${swipeId}`;
}

function readNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const segments = path
        .split('.')
        .map((segment) => segment.trim())
        .filter(Boolean);
    let cursor: unknown = obj;
    for (const seg of segments) {
        if (!isPlainObject(cursor) || !(seg in cursor)) {
            return undefined;
        }
        cursor = cursor[seg];
    }
    return cursor;
}

function parseJsonObjectSafe(rawText: string): Record<string, unknown> {
    if (!rawText.trim()) {
        return {};
    }
    try {
        const parsed: unknown = JSON.parse(rawText);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function hydrateTrajectoryStore(targetStore: TrajectoryStore, sourceStore: TrajectoryStore): void {
    targetStore.replaceFrom(sourceStore);
}

function createEjsVfsHelpers(
    getVfs: () => VirtualFileSystem | undefined,
    getStore: () => ChatDataStore | undefined,
    getTarget: () => MessageTarget,
): Record<string, unknown> {
    const readVarsObject = async (): Promise<Record<string, unknown>> => {
        const store = getStore();
        const vfs = getVfs();
        const target = getTarget();
        if (vfs) {
            try {
                const raw = await vfs.readFile('/state/variables.json', { target });
                return parseJsonObjectSafe(raw);
            } catch {
                // Fall back to ChatDataStore lookup below.
            }
        }
        const entry = store?.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, {
            target,
            includeStaged: true,
        });
        return parseJsonObjectSafe(entry?.content ?? '');
    };

    const readVfsFile = async (path: string): Promise<string> => {
        const vfs = getVfs();
        if (!vfs || !path.trim()) {
            return '';
        }
        try {
            return await vfs.readFile(path, { target: getTarget() });
        } catch {
            return '';
        }
    };

    const fileExists = async (path: string): Promise<boolean> => {
        const vfs = getVfs();
        if (!vfs || !path.trim()) {
            return false;
        }
        try {
            return await vfs.exists(path, { target: getTarget() });
        } catch {
            return false;
        }
    };

    const listFiles = async (dirPath = '/'): Promise<string[]> => {
        const vfs = getVfs();
        if (!vfs) {
            return [];
        }
        try {
            const entries = await vfs.listDir(dirPath, { target: getTarget() });
            return entries.map((entry) => entry.path);
        } catch {
            return [];
        }
    };

    return {
        readFile: readVfsFile,
        fileExists,
        listFiles,
        getVars: readVarsObject,
        getVar: async (keyPath?: string, fallback?: unknown): Promise<unknown> => {
            const vars = await readVarsObject();
            if (!keyPath || !keyPath.trim()) {
                return vars;
            }
            const value = readNestedValue(vars, keyPath);
            return value !== undefined ? value : fallback;
        },
        vfs: {
            read: readVfsFile,
            exists: fileExists,
            list: listFiles,
        },
        vars: {
            all: readVarsObject,
            get: async (keyPath: string, fallback?: unknown): Promise<unknown> => {
                const vars = await readVarsObject();
                const value = readNestedValue(vars, keyPath);
                return value !== undefined ? value : fallback;
            },
        },
    };
}

interface RuntimeServicesDeps {
    bridge: STHostBridge;
    store: ChatDataStore;
    dataCompactor: DataCompactor;
    vfs: VirtualFileSystem;
    sideGen: ToolSideGenApi;
    assistantRunner?: AssistantRunner;
    traceLogger: TraceLogger;
    sandbox: IframeJsSandbox;
    toolRegistry: ToolRegistry;
    trajectoryStore: TrajectoryStore;
    watermarkCompactor: WatermarkCompactor;
    transport: FetchLLMTransport;
    barrierCoordinator: BarrierCoordinator;
    orchestrator: PipelineOrchestrator;
    classifier: WIClassifier;
    getSettings: () => Settings;
    setSettings: (next: Settings, persistDebounced?: boolean) => Settings;
    syncTools: () => Promise<void>;
    getAppStore: () => AppStore | undefined;
    getInterceptorHandle: () => AgenticInterceptorHandle | undefined;
    isSuppressingSave: () => boolean;
}

function createLiveUiServices(deps: RuntimeServicesDeps): AgenticUIServices {
    const {
        bridge,
        store,
        dataCompactor,
        vfs,
        sideGen,
        assistantRunner,
        traceLogger,
        sandbox,
        toolRegistry,
        trajectoryStore,
        watermarkCompactor,
        transport,
        barrierCoordinator,
        orchestrator,
        classifier,
        getSettings,
        setSettings,
        syncTools,
        getAppStore,
        getInterceptorHandle,
        isSuppressingSave,
    } = deps;

    const resolveTarget = (target?: MessageTarget): MessageTarget =>
        resolveValidTarget(target ?? getAppStore()?.getSnapshot().activeTarget);

    const hasSummaryTriggersInContext = (
        preset: Preset,
        loreEntries: readonly RawLoreEntry[],
    ): boolean => {
        const compiled = orchestrator.decoratorCompiler.compile(loreEntries, { preset });
        const triggers = [...preset.triggers, ...compiled.triggers];
        return triggers.some(
            (trigger) =>
                trigger.enabled
                && /summary|outline|记忆|摘要|大纲/i.test(
                    `${trigger.label} ${trigger.id} ${trigger.targetPath ?? ''}`,
                ),
        );
    };

    const buildWatermarkStatusForAgent = (
        agent: AgentProfile,
        summaryMode: 'bridge' | 'fallback',
    ): AgentWatermarkStatus => ({
        agentId: agent.id,
        agentName: agent.name,
        currentTokens: watermarkCompactor.estimateCurrentTokens(trajectoryStore, {
            agentId: agent.id,
        }),
        lowWatermark: agent.watermark?.low ?? 24_000,
        highWatermark: agent.watermark?.high ?? 48_000,
        archivedChunks: trajectoryStore.getArchivedUpToChunk(agent.id),
        summaryMode,
    });

    const listFilesAndOverrides = async (targetInput?: MessageTarget): Promise<FileOverrideItem[]> => {
        const target = resolveTarget(targetInput);
        const settings = getSettings();
        const activePreset = resolveActivePreset(settings);
        const items: FileOverrideItem[] = [];

        // 1. Native 3-scope Variables (/state/variables.json, /state/chat_variables.json, /state/global_variables.json)
        let varsContent = '{}';
        try {
            varsContent = await vfs.readFile('/state/variables.json', { target });
        } catch {
            const fallbackVars = store.getLegacyMetadataVariables();
            varsContent = fallbackVars ? JSON.stringify(fallbackVars, null, 2) : '{}';
        }
        const varsEntry = store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, {
            target,
            includeStaged: true,
        });
        const varsRows = store.lookup(DATA_NAMESPACES.VARIABLES, {
            target,
            includeStaged: true,
        });
        const varsRow = varsRows.find((row) => row.key === VARIABLES_DOC_KEY);
        const legacyVars = store.getLegacyMetadataVariables();
        const baseVarsContent = legacyVars ? JSON.stringify(legacyVars, null, 2) : '{}';

        items.push({
            id: `variables:${VARIABLES_DOC_KEY}`,
            category: 'variables',
            storageScope: 'chat_branch',
            namespace: DATA_NAMESPACES.VARIABLES,
            path: '/state/variables.json',
            key: VARIABLES_DOC_KEY,
            target:
                varsRow && varsRow.messageId >= 0
                    ? { messageId: varsRow.messageId, swipeId: varsRow.swipeId }
                    : target,
            layerLabel:
                varsRow && varsRow.messageId >= 0
                    ? formatLayerLabel(varsRow.messageId, varsRow.swipeId, false)
                    : '初始变量 ([InitVar] / chat)',
            source: varsEntry?.source ?? 'initvar',
            content: varsContent,
            baseContent: baseVarsContent,
            overridden: Boolean(varsRow && varsRow.messageId >= 0),
            writable: true,
        });

        const chatVars = bridge.readChatVariables();
        const chatVarsContent = await vfs
            .readFile('/state/chat_variables.json', { target })
            .catch(() => JSON.stringify(chatVars, null, 2));
        items.push({
            id: `variables:${CHAT_VARIABLES_DOC_KEY}`,
            category: 'variables',
            storageScope: 'chat_base',
            namespace: DATA_NAMESPACES.VARIABLES,
            path: '/state/chat_variables.json',
            key: CHAT_VARIABLES_DOC_KEY,
            target,
            layerLabel: '聊天变量 (ST chat_metadata.variables)',
            source: 'st-chat',
            content: chatVarsContent,
            baseContent: '{}',
            overridden: Object.keys(chatVars).length > 0,
            writable: true,
        });

        const globalVars = bridge.readGlobalVariables();
        const globalVarsContent = await vfs
            .readFile('/state/global_variables.json', { target })
            .catch(() => JSON.stringify(globalVars, null, 2));
        items.push({
            id: `variables:${GLOBAL_VARIABLES_DOC_KEY}`,
            category: 'variables',
            storageScope: 'global',
            namespace: DATA_NAMESPACES.VARIABLES,
            path: '/state/global_variables.json',
            key: GLOBAL_VARIABLES_DOC_KEY,
            target,
            layerLabel: '全局变量 (ST extension_settings.variables.global)',
            source: 'st-global',
            content: globalVarsContent,
            baseContent: '{}',
            overridden: Object.keys(globalVars).length > 0,
            writable: true,
        });

        // 2. Workspace files (chat DataStore `files`), Preset files (`/preset/*`), and Global files (`/global/*`)
        const fileRows = store.lookup(DATA_NAMESPACES.FILES, {
            target,
            includeStaged: true,
        });
        for (const row of fileRows) {
            const cleanKey = row.key.replace(/^\/+/, '');
            if (cleanKey === 'output.md') {
                continue;
            }
            const fullPath = `/${cleanKey}`;
            const isSpec = isInstructionIndexPath(fullPath) || isInstructionDocPath(fullPath);
            const inBase = store.hasBase(DATA_NAMESPACES.FILES, cleanKey) || row.messageId < 0;
            items.push({
                id: `files:${cleanKey}`,
                category: isSpec ? 'instructions' : 'workspace',
                storageScope: inBase ? 'chat_base' : 'chat_branch',
                namespace: DATA_NAMESPACES.FILES,
                path: fullPath,
                key: cleanKey,
                target:
                    row.messageId >= 0
                        ? { messageId: row.messageId, swipeId: row.swipeId }
                        : target,
                layerLabel: inBase
                    ? (isSpec ? '聊天规范层 (全分支)' : '聊天基底层 (全分支)')
                    : formatLayerLabel(row.messageId, row.swipeId, false),
                source: row.entry.source,
                content: row.entry.content,
                overridden: row.messageId >= 0,
                writable: true,
            });
        }

        const presetKeys = Object.keys(activePreset.files).sort((a, b) => a.localeCompare(b));
        for (const rawKey of presetKeys) {
            const content = activePreset.files[rawKey];
            const cleanKey = rawKey.replace(/^\/+/, '');
            if (!cleanKey || typeof content !== 'string') {
                continue;
            }
            items.push({
                id: `preset:${cleanKey}`,
                category: 'instructions',
                storageScope: 'preset',
                namespace: DATA_NAMESPACES.FILES,
                path: `/preset/${cleanKey}`,
                key: cleanKey,
                target,
                layerLabel: '预设参考 (/preset/*)',
                source: 'preset',
                content,
                baseContent: content,
                overridden: false,
                writable: true,
            });
        }

        const globalFiles = await bridge.loadExtensionData<Record<string, string>>(
            GLOBAL_VFS_EXTENSION_KEY,
            {},
        );
        if (globalFiles && typeof globalFiles === 'object') {
            const globalKeys = Object.keys(globalFiles).sort((a, b) => a.localeCompare(b));
            for (const rawKey of globalKeys) {
                const content = globalFiles[rawKey];
                const cleanKey = rawKey.replace(/^\/+/, '');
                if (!cleanKey || typeof content !== 'string') {
                    continue;
                }
                items.push({
                    id: `global:${cleanKey}`,
                    category: 'instructions',
                    storageScope: 'global',
                    namespace: DATA_NAMESPACES.FILES,
                    path: `/global/${cleanKey}`,
                    key: cleanKey,
                    target,
                    layerLabel: '全局规范 (/global/*)',
                    source: 'global',
                    content,
                    baseContent: content,
                    overridden: false,
                    writable: true,
                });
            }
        }

        // 3. World Info entries & branch overrides
        const lorebooks = await bridge.listEnabledLorebooks();
        const wiRows = store.lookup(DATA_NAMESPACES.WORLDINFO, {
            target,
            includeStaged: true,
        });
        const wiRowMap = new Map(wiRows.map((row) => [row.key, row]));
        const seenWiKeys = new Set<string>();

        for (const [worldName, entries] of lorebooks.entries()) {
            for (const entry of entries) {
                const rawEntry = entry.world ? entry : { ...entry, world: worldName };
                const wiKey = worldInfoKey(rawEntry.world, rawEntry.uid);
                seenWiKeys.add(wiKey);
                const wiPath = buildLoreVfsPath(rawEntry);
                const overrideRow = wiRowMap.get(wiKey);
                const baseContent = rawEntry.content ?? '';

                items.push({
                    id: `worldinfo:${wiKey}`,
                    category: 'worldinfo',
                    namespace: DATA_NAMESPACES.WORLDINFO,
                    path: wiPath,
                    key: wiKey,
                    target:
                        overrideRow && overrideRow.messageId >= 0
                            ? { messageId: overrideRow.messageId, swipeId: overrideRow.swipeId }
                            : target,
                    layerLabel: overrideRow
                        ? formatLayerLabel(overrideRow.messageId, overrideRow.swipeId, overrideRow.messageId < 0)
                        : `原书 (${rawEntry.world})`,
                    source: overrideRow?.entry.source ?? 'lorebook',
                    content: overrideRow ? overrideRow.entry.content : baseContent,
                    baseContent,
                    overridden: Boolean(overrideRow),
                    writable: true,
                });
            }
        }

        for (const [wiKey, row] of wiRowMap.entries()) {
            if (seenWiKeys.has(wiKey)) {
                continue;
            }
            items.push({
                id: `worldinfo:${wiKey}`,
                category: 'worldinfo',
                namespace: DATA_NAMESPACES.WORLDINFO,
                path: `/lorebooks/${wiKey}`,
                key: wiKey,
                target:
                    row.messageId >= 0
                        ? { messageId: row.messageId, swipeId: row.swipeId }
                        : target,
                layerLabel: formatLayerLabel(row.messageId, row.swipeId, row.messageId < 0),
                source: row.entry.source,
                content: row.entry.content,
                overridden: true,
                writable: true,
            });
        }

        // 4. Message outputs (/output.md mapped directly to host chat messages)
        const chatMessages = bridge.getChat();
        const messageIndices = new Set<number>();
        const windowStart = Math.max(0, chatMessages.length - 50);
        for (let i = chatMessages.length - 1; i >= windowStart; i -= 1) {
            messageIndices.add(i);
        }
        if (target.messageId >= 0 && target.messageId < chatMessages.length) {
            messageIndices.add(target.messageId);
        }

        const sortedMessageIndices = Array.from(messageIndices).sort((a, b) => b - a);
        for (const i of sortedMessageIndices) {
            const rawMsg = chatMessages[i];
            if (!rawMsg || rawMsg.isSystem) {
                continue;
            }
            const sw = i === target.messageId ? target.swipeId : (rawMsg.swipeId ?? 0);
            const msgTarget: MessageTarget = { messageId: i, swipeId: sw };
            items.push({
                id: `output:${i}#${sw}`,
                category: 'message',
                namespace: DATA_NAMESPACES.FILES,
                path: OUTPUT_FILE_PATH,
                key: 'output.md',
                target: msgTarget,
                layerLabel: formatLayerLabel(i, sw),
                source: 'chat',
                content: bridge.readChatMessage(msgTarget) ?? '',
                overridden: false,
                writable: true,
            });
        }

        return items;
    };

    const normalizeKeyForNamespace = (
        namespace: DataNamespace,
        key: string,
        path: string,
    ): string => {
        if (namespace === DATA_NAMESPACES.FILES) {
            return (key || path).replace(/^\/+/, '');
        }
        if (namespace === DATA_NAMESPACES.VARIABLES) {
            return VARIABLES_DOC_KEY;
        }
        return key;
    };

    const isOutputOverrideTarget = (input: {
        path: string;
        namespace: DataNamespace;
        key: string;
        category?: string;
    }): boolean => {
        const cleanKey = input.key.replace(/^\/+/, '').trim();
        return (
            input.category === 'message'
            || input.path.trim() === OUTPUT_FILE_PATH
            || cleanKey === 'output.md'
        );
    };

    return {
        listFilesAndOverrides,

        async saveFileOrOverride(input): Promise<FileOverrideItem> {
            const target = resolveTarget(input.target);
            if (isOutputOverrideTarget(input)) {
                await vfs.writeFile(OUTPUT_FILE_PATH, input.content, {
                    target,
                    staged: false,
                    source: 'ui-edit',
                });
                await bridge.refreshMessageView(target);
                await saveMetadata();

                const refreshed = await listFilesAndOverrides(target);
                const matched = refreshed.find(
                    (item) =>
                        item.category === 'message'
                        && item.path === OUTPUT_FILE_PATH
                        && item.target.messageId === target.messageId
                        && item.target.swipeId === target.swipeId,
                );
                if (matched) {
                    return matched;
                }
                return {
                    id: `output:${target.messageId}#${target.swipeId}`,
                    category: 'message',
                    namespace: DATA_NAMESPACES.FILES,
                    path: OUTPUT_FILE_PATH,
                    key: 'output.md',
                    target,
                    layerLabel: formatLayerLabel(target.messageId, target.swipeId),
                    source: 'chat',
                    content: input.content,
                    overridden: false,
                    writable: true,
                };
            }

            const normalizedPath = normalizeVfsPath(input.path || `/${input.key || ''}`);
            const resolveVariablePath = (): string | null => {
                if (
                    normalizedPath === '/state/variables.json'
                    || normalizedPath === '/state/chat_variables.json'
                    || normalizedPath === '/state/global_variables.json'
                ) {
                    return normalizedPath;
                }
                if (input.namespace === DATA_NAMESPACES.VARIABLES) {
                    if (input.key === CHAT_VARIABLES_DOC_KEY) {
                        return '/state/chat_variables.json';
                    }
                    if (input.key === GLOBAL_VARIABLES_DOC_KEY) {
                        return '/state/global_variables.json';
                    }
                    return '/state/variables.json';
                }
                return null;
            };
            const variablePath = resolveVariablePath();
            if (variablePath) {
                await vfs.writeFile(variablePath, input.content, {
                    target,
                    staged: false,
                    source: 'ui-edit',
                });
                await saveMetadata();
                const refreshed = await listFilesAndOverrides(target);
                const matched = refreshed.find((item) => item.path === variablePath);
                if (matched) {
                    return matched;
                }
                return {
                    id: `variables:${variablePath.slice('/state/'.length)}`,
                    category: 'variables',
                    storageScope:
                        variablePath === '/state/global_variables.json'
                            ? 'global'
                            : variablePath === '/state/chat_variables.json'
                                ? 'chat_base'
                                : 'chat_branch',
                    namespace: DATA_NAMESPACES.VARIABLES,
                    path: variablePath,
                    key: variablePath.slice('/state/'.length),
                    target,
                    layerLabel:
                        variablePath === '/state/global_variables.json'
                            ? '全局变量 (ST extension_settings.variables.global)'
                            : variablePath === '/state/chat_variables.json'
                                ? '聊天变量 (ST chat_metadata.variables)'
                                : formatLayerLabel(target.messageId, target.swipeId),
                    source: 'ui-edit',
                    content: input.content,
                    overridden: true,
                    writable: true,
                };
            }

            const isPresetScope = input.storageScope === 'preset' || normalizedPath.startsWith('/preset/');
            if (isPresetScope) {
                const relName = (
                    normalizedPath.startsWith('/preset/')
                        ? normalizedPath.slice('/preset/'.length)
                        : (input.key || normalizedPath)
                ).replace(/^\/+/, '');
                const validationErr = validatePresetFileName(relName);
                if (validationErr) {
                    throw new Error(validationErr);
                }

                const prevSettings = getSettings();
                const activePreset = resolveActivePreset(prevSettings);
                const currentTotal = Object.entries(activePreset.files).reduce(
                    (sum, [name, content]) =>
                        name === relName ? sum : sum + name.length + content.length,
                    0,
                );
                if (currentTotal + relName.length + input.content.length > DEFAULT_FILE_MAP_SIZE_LIMIT) {
                    throw new Error(
                        `预设文件总大小超出 ${Math.floor(DEFAULT_FILE_MAP_SIZE_LIMIT / 1024)} KB 上限`,
                    );
                }

                const nextSettings: Settings = {
                    ...prevSettings,
                    presets: {
                        ...prevSettings.presets,
                        [activePreset.id]: {
                            ...activePreset,
                            files: {
                                ...activePreset.files,
                                [relName]: input.content,
                            },
                        },
                    },
                };
                const storeUi = getAppStore();
                if (storeUi) {
                    await storeUi.updateSettings(() => nextSettings);
                } else {
                    setSettings(nextSettings, !isSuppressingSave());
                    await syncTools();
                }

                const refreshed = await listFilesAndOverrides(target);
                const matched = refreshed.find(
                    (item) => item.storageScope === 'preset' && item.key === relName,
                );
                if (matched) {
                    return matched;
                }
                return {
                    id: `preset:${relName}`,
                    category: 'instructions',
                    storageScope: 'preset',
                    namespace: DATA_NAMESPACES.FILES,
                    path: `/preset/${relName}`,
                    key: relName,
                    target,
                    layerLabel: '预设参考 (/preset/*)',
                    source: 'preset',
                    content: input.content,
                    baseContent: input.content,
                    overridden: false,
                    writable: true,
                };
            }

            const isGlobalScope = input.storageScope === 'global' || normalizedPath.startsWith('/global/');
            if (isGlobalScope) {
                const relKey = (
                    normalizedPath.startsWith('/global/')
                        ? normalizedPath.slice('/global/'.length)
                        : (input.key || normalizedPath)
                ).replace(/^\/+/, '');
                if (!relKey) {
                    throw new Error('全局文件路径不能为空');
                }
                await vfs.writeFile(`/global/${relKey}`, input.content, { source: 'ui-edit' });
                const refreshed = await listFilesAndOverrides(target);
                const matched = refreshed.find(
                    (item) => item.storageScope === 'global' && item.key === relKey,
                );
                if (matched) {
                    return matched;
                }
                return {
                    id: `global:${relKey}`,
                    category: 'instructions',
                    storageScope: 'global',
                    namespace: DATA_NAMESPACES.FILES,
                    path: `/global/${relKey}`,
                    key: relKey,
                    target,
                    layerLabel: '全局规范 (/global/*)',
                    source: 'global',
                    content: input.content,
                    baseContent: input.content,
                    overridden: false,
                    writable: true,
                };
            }

            const cleanKey = normalizeKeyForNamespace(input.namespace, input.key, normalizedPath);
            const isBaseScope =
                input.namespace === DATA_NAMESPACES.FILES
                && (input.storageScope === 'chat_base' || isChatBaseWorkspacePath(normalizedPath));

            if (isBaseScope) {
                store.setBase(DATA_NAMESPACES.FILES, cleanKey, 'ui-edit', input.content);
            } else {
                store.set(input.namespace, cleanKey, 'ui-edit', input.content, { target });
            }
            await saveMetadata();

            const refreshed = await listFilesAndOverrides(target);
            const matched = refreshed.find(
                (item) =>
                    item.namespace === input.namespace
                    && item.key === cleanKey
                    && item.storageScope !== 'preset'
                    && item.storageScope !== 'global'
                    && (isBaseScope
                        || (item.target.messageId === target.messageId
                            && item.target.swipeId === target.swipeId)),
            );
            if (matched) {
                return matched;
            }
            const isSpec = isInstructionIndexPath(`/${cleanKey}`) || isInstructionDocPath(`/${cleanKey}`);
            return {
                id: `${input.namespace}:${cleanKey}`,
                category:
                    input.namespace === DATA_NAMESPACES.VARIABLES
                        ? 'variables'
                        : input.namespace === DATA_NAMESPACES.WORLDINFO
                            ? 'worldinfo'
                            : isSpec
                                ? 'instructions'
                                : 'workspace',
                storageScope: isBaseScope ? 'chat_base' : 'chat_branch',
                namespace: input.namespace,
                path: normalizedPath,
                key: cleanKey,
                target,
                layerLabel: isBaseScope
                    ? (isSpec ? '聊天规范层 (全分支)' : '聊天基底层 (全分支)')
                    : formatLayerLabel(target.messageId, target.swipeId),
                source: 'ui-edit',
                content: input.content,
                overridden: !isBaseScope,
                writable: true,
            };
        },

        async deleteFileOrOverride(input): Promise<void> {
            const target = resolveTarget(input.target);
            if (isOutputOverrideTarget(input)) {
                await vfs.deleteFile(OUTPUT_FILE_PATH, {
                    target,
                    staged: false,
                    source: 'ui-delete',
                });
                await bridge.refreshMessageView(target);
                await saveMetadata();
                return;
            }

            const normalizedPath = normalizeVfsPath(input.path || `/${input.key || ''}`);
            const variableDeletePath =
                normalizedPath === '/state/variables.json'
                || normalizedPath === '/state/chat_variables.json'
                || normalizedPath === '/state/global_variables.json'
                    ? normalizedPath
                    : input.namespace === DATA_NAMESPACES.VARIABLES
                        ? input.key === CHAT_VARIABLES_DOC_KEY
                            ? '/state/chat_variables.json'
                            : input.key === GLOBAL_VARIABLES_DOC_KEY
                                ? '/state/global_variables.json'
                                : '/state/variables.json'
                        : null;
            if (variableDeletePath) {
                await vfs.deleteFile(variableDeletePath, {
                    target,
                    staged: false,
                    source: 'ui-delete',
                });
                await saveMetadata();
                return;
            }

            if (input.storageScope === 'preset' || normalizedPath.startsWith('/preset/')) {
                const relName = (
                    normalizedPath.startsWith('/preset/')
                        ? normalizedPath.slice('/preset/'.length)
                        : (input.key || normalizedPath)
                ).replace(/^\/+/, '');
                const prevSettings = getSettings();
                const activePreset = resolveActivePreset(prevSettings);
                if (!Object.hasOwn(activePreset.files, relName)) {
                    return;
                }
                const nextFiles = { ...activePreset.files };
                delete nextFiles[relName];
                const nextSettings: Settings = {
                    ...prevSettings,
                    presets: {
                        ...prevSettings.presets,
                        [activePreset.id]: {
                            ...activePreset,
                            files: nextFiles,
                        },
                    },
                };
                const storeUi = getAppStore();
                if (storeUi) {
                    await storeUi.updateSettings(() => nextSettings);
                } else {
                    setSettings(nextSettings, !isSuppressingSave());
                    await syncTools();
                }
                return;
            }

            if (input.storageScope === 'global' || normalizedPath.startsWith('/global/')) {
                const relKey = (
                    normalizedPath.startsWith('/global/')
                        ? normalizedPath.slice('/global/'.length)
                        : (input.key || normalizedPath)
                ).replace(/^\/+/, '');
                if (relKey) {
                    await vfs.deleteFile(`/global/${relKey}`, { source: 'ui-delete' });
                }
                return;
            }

            const cleanKey = normalizeKeyForNamespace(input.namespace, input.key, normalizedPath);
            if (
                input.namespace === DATA_NAMESPACES.FILES
                && (input.storageScope === 'chat_base' || isChatBaseWorkspacePath(normalizedPath))
            ) {
                store.removeBase(DATA_NAMESPACES.FILES, cleanKey);
                await saveMetadata();
                return;
            }

            const removed = store.remove(input.namespace, cleanKey, target);
            if (
                input.namespace === DATA_NAMESPACES.FILES
                && (!removed || store.get(DATA_NAMESPACES.FILES, cleanKey, { target }) !== null)
            ) {
                store.erase(DATA_NAMESPACES.FILES, cleanKey, 'ui-delete', { target });
            }

            await saveMetadata();
        },

        async getWatermarkStatuses(): Promise<AgentWatermarkStatus[]> {
            const activePreset = resolveActivePreset(getSettings());
            const lorebooks = await bridge.listEnabledLorebooks();
            const loreEntries = Array.from(lorebooks.values()).flat();
            const summaryMode = hasSummaryTriggersInContext(activePreset, loreEntries)
                ? 'bridge'
                : 'fallback';

            const agentMap = new Map<string, AgentProfile>();
            for (const agent of Object.values(activePreset.agents)) {
                if (agent.sessionMode === 'persistent') {
                    agentMap.set(agent.id, agent);
                }
            }
            for (const threadId of trajectoryStore.listAgentIds()) {
                if (!agentMap.has(threadId)) {
                    const fromPreset = activePreset.agents[threadId];
                    if (fromPreset) {
                        agentMap.set(threadId, fromPreset);
                    }
                }
            }

            const statuses = Array.from(agentMap.values()).map((agent) =>
                buildWatermarkStatusForAgent(agent, summaryMode),
            );

            if (assistantRunner) {
                for (const session of assistantRunner.listSessions()) {
                    const tokenStatus = assistantRunner.getSessionTokenStatus(session.id);
                    if (
                        tokenStatus
                        && (session.messages.length > 0 || tokenStatus.currentTokens > 0)
                    ) {
                        statuses.push({
                            agentId: `assistant:${session.id}`,
                            agentName: `助手 · ${session.title}`,
                            currentTokens: tokenStatus.currentTokens,
                            lowWatermark: tokenStatus.lowWatermark,
                            highWatermark: tokenStatus.highWatermark,
                            archivedChunks: tokenStatus.compactedCount,
                            summaryMode: 'assistant_compact',
                        });
                    }
                }
            }

            return statuses;
        },

        async compactAgentContext(agentId: string): Promise<AgentWatermarkStatus> {
            if (agentId.startsWith('assistant:') && assistantRunner) {
                const sessionId = agentId.slice('assistant:'.length);
                await assistantRunner.compactSession(sessionId, { mode: 'full' });
                trajectoryStore.saveToHost(bridge);
                const session = assistantRunner.getSession(sessionId);
                const updatedStatus = assistantRunner.getSessionTokenStatus(sessionId);
                return {
                    agentId,
                    agentName: session ? `助手 · ${session.title}` : agentId,
                    currentTokens: updatedStatus?.currentTokens ?? 0,
                    lowWatermark: updatedStatus?.lowWatermark ?? 12_000,
                    highWatermark: updatedStatus?.highWatermark ?? 24_000,
                    archivedChunks: updatedStatus?.compactedCount ?? 0,
                    summaryMode: 'assistant_compact',
                };
            }

            const activePreset = resolveActivePreset(getSettings());
            const lorebooks = await bridge.listEnabledLorebooks();
            const loreEntries = Array.from(lorebooks.values()).flat();
            const agent = activePreset.agents[agentId] ?? Object.values(activePreset.agents)[0];
            const summaryMode = hasSummaryTriggersInContext(activePreset, loreEntries)
                ? 'bridge'
                : 'fallback';

            await watermarkCompactor.compact(trajectoryStore, {
                agentId,
                watermark: agent?.watermark,
                triggers: activePreset.triggers,
                loreEntries,
                force: true,
            });
            trajectoryStore.saveToHost(bridge);

            if (agent) {
                return buildWatermarkStatusForAgent(agent, summaryMode);
            }
            return {
                agentId,
                agentName: agentId,
                currentTokens: watermarkCompactor.estimateCurrentTokens(trajectoryStore, { agentId }),
                lowWatermark: 24_000,
                highWatermark: 48_000,
                archivedChunks: trajectoryStore.getArchivedUpToChunk(agentId),
                summaryMode,
            };
        },

        async getStorageOverview(): Promise<StorageOverview> {
            const settings = getSettings();
            return {
                estimatedBytes: dataCompactor.estimateBytes(),
                activeLayers: dataCompactor.countLayers(),
                compactedWatermark: dataCompactor.getWatermark(),
                keepDepth: settings.storage.keepDepth,
                autoCompact: settings.storage.autoCompact,
                sizeThreshold: settings.storage.sizeThreshold,
                trajectoryBytes: trajectoryStore.estimateBytes(),
                trajectoryCheckpoints: trajectoryStore.countCheckpoints(),
            };
        },

        async previewColdCompaction(keepDepth?: number): Promise<CompactionReport> {
            const settings = getSettings();
            const resolvedKeepDepth = keepDepth ?? settings.storage.keepDepth;
            const report = dataCompactor.compactColdLayers({
                dryRun: true,
                keepDepth: resolvedKeepDepth,
                includeLegacy: settings.storage.pruneLegacy,
                pruneColdScratch: true,
            });
            const coldEnd = Math.max(0, bridge.getChat().length - resolvedKeepDepth);
            const sim = new TrajectoryStore();
            sim.replaceFrom(trajectoryStore);
            const trajectoryBytesBefore = sim.estimateBytes();
            const cpResult = sim.pruneColdCheckpoints(coldEnd);
            const trajectoryBytesAfter = sim.estimateBytes();
            return {
                ...report,
                prunedCheckpoints: cpResult.removedCheckpoints,
                trajectoryBytesBefore,
                trajectoryBytesAfter,
            };
        },

        async runColdCompaction(keepDepth?: number): Promise<CompactionReport> {
            const settings = getSettings();
            const resolvedKeepDepth = keepDepth ?? settings.storage.keepDepth;
            const report = dataCompactor.compactColdLayers({
                dryRun: false,
                keepDepth: resolvedKeepDepth,
                includeLegacy: settings.storage.pruneLegacy,
                pruneColdScratch: true,
            });
            const coldEnd = Math.max(0, bridge.getChat().length - resolvedKeepDepth);
            const trajectoryBytesBefore = trajectoryStore.estimateBytes();
            const cpResult = trajectoryStore.pruneColdCheckpoints(coldEnd);
            const trajectoryBytesAfter = trajectoryStore.estimateBytes();
            if (cpResult.removedCheckpoints > 0) {
                trajectoryStore.saveToHost(bridge);
            }
            if (
                report.removedLayers > 0
                || report.compactedMessages > 0
                || (report.prunedScratchFiles ?? 0) > 0
                || cpResult.removedCheckpoints > 0
            ) {
                await saveMetadata();
            }
            return {
                ...report,
                prunedCheckpoints: cpResult.removedCheckpoints,
                trajectoryBytesBefore,
                trajectoryBytesAfter,
            };
        },

        async listTraces(filter?: { messageId?: number; swipeId?: number }): Promise<AgentRunTrace[]> {
            return traceLogger.listTraces(filter);
        },

        async clearTraces(): Promise<void> {
            traceLogger.clear();
            getAppStore()?.setTraces([]);
        },

        async rerunAfterTurn(targetInput?: MessageTarget): Promise<void> {
            const target = resolveTarget(targetInput);
            const handles = await orchestrator.rerunAfterTurn(target);
            const storeUi = getAppStore();
            storeUi?.setBackgroundTasks(barrierCoordinator.listTasks());
            await Promise.allSettled(handles.map((handle) => handle.promise));
            trajectoryStore.saveToHost(bridge);
            storeUi?.setBackgroundTasks(barrierCoordinator.listTasks());
            if (storeUi) {
                await storeUi.refreshTraces();
            }
        },

        async resumeTurn(targetInput: MessageTarget): Promise<void> {
            const target = resolveValidTarget(targetInput);
            const handle = getInterceptorHandle();
            if (!handle) {
                throw new Error('Agentic interceptor is not initialized.');
            }
            await handle.resumeTakeoverTurn(target);
        },

        async cancelBackgroundTask(taskId: string): Promise<void> {
            orchestrator.cancelBackgroundTask(taskId, 'Cancelled from Agentic console');
            getAppStore()?.setBackgroundTasks(barrierCoordinator.listTasks());
        },

        async saveSettings(nextSettings: Settings): Promise<void> {
            setSettings(nextSettings, !isSuppressingSave());
            await syncTools();
        },

        async importPresetOrConfig(
            rawJson: unknown,
            options?: { presetName?: string },
        ): Promise<ImportPresetResult> {
            const prevSettings = getSettings();

            if (isSillyTavernOpenAIPreset(rawJson)) {
                const imported = importSillyTavernOpenAIPreset(rawJson, {
                    presetName: options?.presetName,
                });
                const nextSettings = setSettings({
                    ...prevSettings,
                    presets: {
                        ...prevSettings.presets,
                        [imported.preset.id]: imported.preset,
                    },
                    currentPresetId: imported.preset.id,
                });
                await syncTools();
                return {
                    settings: nextSettings,
                    preset: imported.preset,
                    report: imported.report,
                    message: `已导入 SillyTavern OpenAI 预设：${imported.preset.name}`,
                };
            }

            if (isLegacyCustomGenerationData(rawJson)) {
                const migrated = migrateFromCustomGeneration(rawJson);
                const mergedPresets = {
                    ...prevSettings.presets,
                    ...migrated.settings.presets,
                };
                const mergedConnections = {
                    ...prevSettings.connections,
                    ...migrated.settings.connections,
                };
                const importedPreset = resolveActivePreset(migrated.settings);
                const nextSettings = setSettings({
                    ...prevSettings,
                    presets: mergedPresets,
                    connections: mergedConnections,
                    currentPresetId: importedPreset.id,
                });
                await syncTools();
                return {
                    settings: nextSettings,
                    preset: importedPreset,
                    report: migrated.report,
                    message: `已迁移导入 CustomGeneration 配置（预设 ${Object.keys(migrated.settings.presets).length} 个）`,
                };
            }

            if (validateSettingsImport(rawJson).ok) {
                const full = importSettings(rawJson);
                const nextSettings = setSettings(full);
                await syncTools();
                return {
                    settings: nextSettings,
                    preset: resolveActivePreset(nextSettings),
                    message: '已导入完整 Agentic 配置。',
                };
            }

            if (validatePresetImport(rawJson).ok) {
                const imported = importPreset(rawJson);
                const nextPresets = { ...prevSettings.presets };
                let primaryPreset = imported.presets[0];
                for (let index = 0; index < imported.presets.length; index++) {
                    const item = imported.presets[index];
                    const resolvedName =
                        index === 0 && options?.presetName?.trim()
                            ? options.presetName.trim()
                            : item.name;
                    const presetCopy: Preset = { ...item, name: resolvedName };
                    nextPresets[presetCopy.id] = presetCopy;
                    if (index === 0) {
                        primaryPreset = presetCopy;
                    }
                }
                const nextConnections = { ...prevSettings.connections };
                if (imported.connection && !(imported.connection.id in nextConnections)) {
                    nextConnections[imported.connection.id] = imported.connection;
                }
                const nextSettings = setSettings({
                    ...prevSettings,
                    presets: nextPresets,
                    connections: nextConnections,
                    currentPresetId: primaryPreset?.id ?? prevSettings.currentPresetId,
                });
                await syncTools();
                return {
                    settings: nextSettings,
                    preset: primaryPreset,
                    connection: imported.connection,
                    message: `已导入预设：${primaryPreset?.name ?? 'Preset'}`,
                };
            }

            if (validateConnectionsImport(rawJson).ok) {
                const imported = importConnections(rawJson);
                const nextConnections = { ...prevSettings.connections };
                for (const [connId, conn] of Object.entries(imported.connections)) {
                    const existingKey = nextConnections[connId]?.apiKey;
                    nextConnections[connId] = {
                        ...conn,
                        apiKey: conn.apiKey || existingKey || '',
                    };
                }
                const nextSettings = setSettings({
                    ...prevSettings,
                    connections: nextConnections,
                    currentConnectionId:
                        imported.currentConnectionId in nextConnections
                            ? imported.currentConnectionId
                            : prevSettings.currentConnectionId,
                });
                return {
                    settings: nextSettings,
                    message: `已导入 ${Object.keys(imported.connections).length} 条 API 连接配置。`,
                };
            }

            throw new Error('无法识别的 JSON 格式：请提供 Agentic 预设/设置、Connections 或 SillyTavern OpenAI 预设。');
        },

        async exportPresetJson(presetId: string, includeConnection = false): Promise<string> {
            const settings = getSettings();
            const preset = settings.presets[presetId] ?? resolveActivePreset(settings);
            const connId = preset.agents[preset.mainAgentId]?.connectionId ?? settings.currentConnectionId;
            const connection = includeConnection ? settings.connections[connId] : undefined;
            return JSON.stringify(
                exportPreset(preset, { includeConnection: connection }),
                null,
                2,
            );
        },

        async getEmbeddedCardStatus(): Promise<EmbeddedCardStatus> {
            return await getEmbeddedCardStatus();
        },

        async embedPresetToCard(presetId: string): Promise<string> {
            return await embedPresetToCard(presetId, undefined, { store: getAppStore() });
        },

        async embedFilesToCard(files: Record<string, string>): Promise<string> {
            return await embedFilesToCard(files);
        },

        async importEmbeddedFromCard() {
            const result = await importEmbeddedFromCard(undefined, {
                store: getAppStore(),
                bridge,
                dataStore: store,
            });
            await syncTools();
            return result;
        },

        async testConnection(connection: ApiConnection): Promise<ConnectionTestResult> {
            const startedAt = performance.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);
            try {
                const response = await transport.complete({
                    connectionId: connection.id,
                    connection,
                    messages: [{ role: 'user', content: 'Reply with OK.' }],
                    tools: [],
                    stream: false,
                    signal: controller.signal,
                });
                const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
                const cacheSupport =
                    response.usage?.cachedTokens
                        ? `cachedTokens=${response.usage.cachedTokens}`
                        : `${connection.providerFormat}:${connection.model}`;
                return {
                    ok: true,
                    latencyMs,
                    message: `连接成功 (${latencyMs}ms · ${connection.model})`,
                    cacheSupport,
                };
            } catch (error) {
                const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    ok: false,
                    latencyMs,
                    message: `连接失败 (${latencyMs}ms)：${msg}`,
                };
            } finally {
                clearTimeout(timer);
            }
        },

        async fetchModels(connection: ApiConnection): Promise<ConnectionModelsResult> {
            const startedAt = performance.now();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15_000);
            try {
                const models = await transport.listModels({
                    connectionId: connection.id,
                    connection,
                    signal: controller.signal,
                });
                const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
                return {
                    ok: true,
                    latencyMs,
                    models,
                    message:
                        models.length > 0
                            ? `已获取 ${models.length} 个可用模型 (${latencyMs}ms)`
                            : `接口连接正常，但返回了 0 个模型 (${latencyMs}ms)`,
                };
            } catch (error) {
                const latencyMs = Math.max(1, Math.round(performance.now() - startedAt));
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    ok: false,
                    latencyMs,
                    models: [],
                    message: `获取模型列表失败 (${latencyMs}ms)：${msg}`,
                };
            } finally {
                clearTimeout(timer);
            }
        },

        async testToolInSandbox(
            tool: CustomToolConfig | { name: string; code?: string; commandTemplate?: string },
            argsJson: string,
            targetInput?: MessageTarget,
        ): Promise<ToolTestResult> {
            const startedAt = performance.now();
            const target = resolveTarget(targetInput);
            try {
                const parsedArgs: unknown = argsJson.trim() ? JSON.parse(argsJson) : {};
                const argsRecord = isPlainObject(parsedArgs) ? parsedArgs : {};
                const ctx = createToolExecutionContext({
                    bridge,
                    vfs,
                    store,
                    sideGen,
                    target,
                    signal: AbortSignal.timeout(15_000),
                    staged: false,
                    source: 'sandbox-test',
                });

                let resultValue: unknown;
                if ('kind' in tool && tool.kind === 'slash_bridge') {
                    const def = compileSlashBridgeTool(tool);
                    resultValue = await def.execute(argsRecord, ctx);
                } else if ('kind' in tool && tool.kind === 'js') {
                    const defs = await compileCustomToolConfig(tool, sandbox, { timeoutMs: 15_000 });
                    const picked = defs.find((d) => d.name === tool.name) ?? defs[0];
                    resultValue = await picked.execute(argsRecord, ctx);
                } else if ('commandTemplate' in tool && tool.commandTemplate?.trim()) {
                    const tempSlash: CustomToolConfig = {
                        id: `test_slash_${tool.name}`,
                        name: tool.name,
                        kind: 'slash_bridge',
                        description: tool.name,
                        enabled: true,
                        commandTemplate: tool.commandTemplate,
                    };
                    const def = compileSlashBridgeTool(tempSlash);
                    resultValue = await def.execute(argsRecord, ctx);
                } else if ('code' in tool && tool.code?.trim()) {
                    if (/defineTool\s*\(/.test(tool.code)) {
                        const tempJs: CustomToolConfig = {
                            id: `test_js_${tool.name}`,
                            name: tool.name,
                            kind: 'js',
                            description: tool.name,
                            enabled: true,
                            code: tool.code,
                            allowNetwork: true,
                        };
                        const defs = await compileCustomToolConfig(tempJs, sandbox, { timeoutMs: 15_000 });
                        const picked = defs.find((d) => d.name === tool.name) ?? defs[0];
                        resultValue = await picked.execute(argsRecord, ctx);
                    } else {
                        resultValue = await sandbox.evaluateScript(tool.code, ctx, {
                            id: `test_script_${tool.name}`,
                            allowNetwork: true,
                            timeoutMs: 15_000,
                        });
                    }
                } else {
                    const outputText = await toolRegistry.executeToolCallText(tool.name, argsJson, ctx);
                    return {
                        ok: true,
                        durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
                        output: outputText,
                        target,
                    };
                }

                const output =
                    typeof resultValue === 'string'
                        ? resultValue
                        : JSON.stringify(resultValue ?? null, null, 2);
                return {
                    ok: true,
                    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
                    output,
                    target,
                };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    ok: false,
                    durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
                    output: '',
                    error: msg,
                    target,
                };
            }
        },

        async listClassifiedLoreEntries(
            overrides?: Record<string, WICategory>,
        ): Promise<{ entries: ClassifiedLoreEntry[]; isHollowCard: boolean }> {
            const lorebooks = await bridge.listEnabledLorebooks();
            const activePreset = resolveActivePreset(getSettings());
            const classified = classifier.classifyLorebooks(lorebooks, {
                overrides: overrides ?? activePreset.wiRouterOverrides,
            });
            const isHollowCard = classifier.isHollowCharacterCard(bridge.getCharacterFields());
            return {
                entries: classified.all,
                isHollowCard,
            };
        },

        getHostLuminance() {
            return bridge.getHostLuminance();
        },

        subscribeEvents(listener) {
            return traceLogger.subscribe(listener);
        },

        ...(assistantRunner ? { assistantRuntime: assistantRunner } : {}),
    };
}

interface HostMountController {
    sync(): void;
    dispose(): void;
}

function setupHostUiContainers(appStore: AppStore): HostMountController {
    let unmountSettings: (() => void) | null = null;
    let unmountMenu: (() => void) | null = null;
    let disposed = false;

    const ensureSettingsCardMounted = (): HTMLElement | null => {
        if (disposed) {
            return null;
        }
        const container =
            document.getElementById('extensions_settings')
            ?? document.getElementById('extensions_settings2');
        if (!container) {
            return null;
        }
        if (!container.querySelector('[data-agentic-settings-mount]')) {
            unmountSettings?.();
            unmountSettings = mountExtensionsSettingsCard(container, appStore);
        }
        return container;
    };

    const ensureMenuMounted = (): HTMLElement | null => {
        if (disposed) {
            return null;
        }
        const menu = document.getElementById('extensionsMenu');
        if (!menu) {
            return null;
        }
        if (!menu.querySelector('[data-agentic-menu-item]')) {
            unmountMenu?.();
            unmountMenu = mountExtensionsMenuItems(menu, appStore);
        }
        return menu;
    };

    const observedContainers = new WeakSet<Element>();
    const containerObserver = new MutationObserver(() => {
        syncMounts();
    });

    const attachObservers = (): void => {
        const settingsEl = ensureSettingsCardMounted();
        if (settingsEl && !observedContainers.has(settingsEl)) {
            observedContainers.add(settingsEl);
            containerObserver.observe(settingsEl, { childList: true });
        }
        const menuEl = ensureMenuMounted();
        if (menuEl && !observedContainers.has(menuEl)) {
            observedContainers.add(menuEl);
            containerObserver.observe(menuEl, { childList: true });
        }
    };

    const syncMounts = (): void => {
        if (disposed) {
            return;
        }
        attachObservers();
    };

    syncMounts();

    let bodyObserver: MutationObserver | null = null;
    if (
        typeof document !== 'undefined'
        && document.body
        && (!document.getElementById('extensions_settings') || !document.getElementById('extensionsMenu'))
    ) {
        bodyObserver = new MutationObserver(() => {
            attachObservers();
            if (
                document.getElementById('extensions_settings')
                && document.getElementById('extensionsMenu')
            ) {
                bodyObserver?.disconnect();
                bodyObserver = null;
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
    }

    const onDocumentClick = (event: MouseEvent): void => {
        const target = event.target as Element | null;
        if (target?.closest?.('#extensionsMenuButton')) {
            queueMicrotask(syncMounts);
        }
    };
    document.addEventListener('click', onDocumentClick);

    return {
        sync: syncMounts,
        dispose: () => {
            disposed = true;
            document.removeEventListener('click', onDocumentClick);
            containerObserver.disconnect();
            bodyObserver?.disconnect();
            unmountSettings?.();
            unmountMenu?.();
        },
    };
}

jQuery(async () => {
    try {
        await initXxHash();

        const runtimeRefs: {
            vfs?: VirtualFileSystem;
            store?: ChatDataStore;
            appStore?: AppStore;
            interceptorHandle?: AgenticInterceptorHandle;
            companionHooksHandle?: CompanionHooksHandle;
        } = {};

        const bridge = new STHostBridge({
            extensionKey: DEFAULT_EXTENSION_SETTINGS_KEY,
            executeSlashCommand: executeStSlashCommand,
            evaluateOptionalEjs: async (text: string, vars?: Record<string, unknown>) =>
                await evaluateOptionalEjs(
                    text,
                    vars,
                    createEjsVfsHelpers(
                        () => runtimeRefs.vfs,
                        () => runtimeRefs.store,
                        () => resolveValidTarget(runtimeRefs.appStore?.getSnapshot().activeTarget),
                    ),
                ),
        });

        const initial = loadOrMigrateSettings();
        let currentSettings = initial.settings;

        const store = new ChatDataStore(bridge);
        runtimeRefs.store = store;
        bridge.setStore(store);
        bridge.setSettingsGetter(() => currentSettings);

        const dataCompactor = new DataCompactor(bridge);
        const regexPipeline = new RegexPipeline(resolveActivePreset(currentSettings).regexRules);
        const loreReadEvaluator = new LoreReadEvaluator(bridge, {
            getOverride: (world, uid, target) =>
                store.get(DATA_NAMESPACES.WORLDINFO, worldInfoKey(world, uid), {
                    target,
                    includeStaged: true,
                })?.content ?? null,
            applyLoreReadRegex: (text) =>
                regexPipeline.run(text, { stage: 'lore_read', sender: 'lore' }),
        });
        const tailRadar = new TailRadar(loreReadEvaluator);
        const classifier = new WIClassifier();
        const decoratorCompiler = new DecoratorCompiler();
        const vfs = new VirtualFileSystem({
            bridge,
            store,
            loreReadHook: loreReadEvaluator.toLoreReadHook(),
            getPresetFiles: () => resolveActivePreset(currentSettings).files,
        });
        runtimeRefs.vfs = vfs;

        const traceLogger = new TraceLogger();
        const sandboxLifecycle = new SandboxLifecycleManager();
        const sandbox = new IframeJsSandbox({ lifecycle: sandboxLifecycle });
        const mainlineSpillStore = new TransientToolSpillStore();
        const toolRegistry = createBuiltinToolRegistry();
        toolRegistry.setOutputGateOptions({ spillStore: mainlineSpillStore });

        const registeredCustomToolNames = new Set<string>();
        let toolSyncGeneration = 0;

        const syncCustomAndLoreTools = async (): Promise<void> => {
            const gen = ++toolSyncGeneration;
            for (const name of registeredCustomToolNames) {
                if (!BUILTIN_TOOL_NAME_SET.has(name)) {
                    toolRegistry.unregister(name);
                }
            }
            registeredCustomToolNames.clear();

            const activePreset = resolveActivePreset(currentSettings);
            const safeCustomConfigs = activePreset.customTools.filter(
                (tool) => !BUILTIN_TOOL_NAME_SET.has(tool.name.trim()),
            );

            try {
                const customRes = await registerCustomTools(toolRegistry, safeCustomConfigs, sandbox);
                if (gen !== toolSyncGeneration) {
                    return;
                }
                for (const name of customRes.registered) {
                    registeredCustomToolNames.add(name);
                }
                for (const err of customRes.errors) {
                    console.warn(`[Agentic] Failed to compile custom tool "${err.name}": ${err.error}`);
                }
            } catch (error) {
                console.warn('[Agentic] Custom tool registration error:', error);
            }

            try {
                const lorebooks = await bridge.listEnabledLorebooks();
                if (gen !== toolSyncGeneration) {
                    return;
                }
                const compiled = decoratorCompiler.compile(
                    Array.from(lorebooks.values()).flat(),
                    { preset: activePreset },
                );
                for (const loreTool of compiled.toolEntries) {
                    if (gen !== toolSyncGeneration) {
                        return;
                    }
                    if (loreTool.entry.disable) {
                        continue;
                    }
                    try {
                        const defs = await compileLoreToolEntry(loreTool.entry, sandbox);
                        for (const def of defs) {
                            if (BUILTIN_TOOL_NAME_SET.has(def.name)) {
                                continue;
                            }
                            toolRegistry.register(def, { replace: true });
                            registeredCustomToolNames.add(def.name);
                        }
                    } catch (error) {
                        console.warn(
                            `[Agentic] Failed to compile @@tool "${loreTool.name}":`,
                            error,
                        );
                    }
                }
            } catch (error) {
                console.warn('[Agentic] World Info @@tool scan error:', error);
            }
        };

        const trajectoryStore = new TrajectoryStore();
        hydrateTrajectoryStore(trajectoryStore, TrajectoryStore.loadFromHost(bridge));

        const contextAssembler = new ContextAssembler();
        const watermarkCompactor = new WatermarkCompactor({ vfs, bridge });
        const resolveConnectionById = (connectionId: string): ApiConnection | undefined =>
            currentSettings.connections[connectionId]
            ?? currentSettings.connections[currentSettings.currentConnectionId];

        const transport = new FetchLLMTransport({
            connections: currentSettings.connections,
            resolveConnection: resolveConnectionById,
        });

        const scheduleSideGenUiRefresh = (target?: MessageTarget): void => {
            const uiStore = runtimeRefs.appStore;
            if (!uiStore) {
                return;
            }
            void uiStore.refreshSideGenState(target).catch(() => {});
        };

        const sideGenService = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            dataStore: store,
            vfs,
            getDefaultConnectionId: () => currentSettings.currentConnectionId,
            getSettings: () => currentSettings,
            resolveConnection: resolveConnectionById,
            defaultDelivery: currentSettings.offMainline?.defaultDelivery,
            onTrace: (trace) => {
                traceLogger.recordTrace(trace, true);
            },
        });

        const sideGenApi: ToolSideGenApi = {
            async runOnce(opts) {
                const result = await sideGenService.runOnce(opts);
                if (result.bridgedPath) {
                    scheduleSideGenUiRefresh();
                }
                return result;
            },
            async createSession(opts) {
                const info = await sideGenService.createSession(opts);
                scheduleSideGenUiRefresh();
                return info;
            },
            async send(sessionId, prompt, opts) {
                const result = await sideGenService.send(sessionId, prompt, opts);
                scheduleSideGenUiRefresh();
                return result;
            },
            getSession: (sessionId) => sideGenService.getSession(sessionId),
            listSessions: (filter) => sideGenService.listSessions(filter),
            getTranscript: (sessionId) => sideGenService.getTranscript(sessionId),
            async compactSession(sessionId) {
                const result = await sideGenService.compactSession(sessionId);
                scheduleSideGenUiRefresh();
                return result;
            },
            async deleteSession(sessionId) {
                const deleted = await sideGenService.deleteSession(sessionId);
                if (deleted) {
                    scheduleSideGenUiRefresh();
                }
                return deleted;
            },
            clues: {
                async write(input) {
                    const doc = await sideGenService.clues.write(input);
                    scheduleSideGenUiRefresh(input.target);
                    return doc;
                },
                read: (path, target) => sideGenService.clues.read(path, target),
                list: (target) => sideGenService.clues.list(target),
                async updateDelivery(path, delivery, target) {
                    const updated = await sideGenService.clues.updateDelivery(path, delivery, target);
                    scheduleSideGenUiRefresh(target);
                    return updated;
                },
                async updateStatus(path, status, target) {
                    const updated = await sideGenService.clues.updateStatus(path, status, target);
                    scheduleSideGenUiRefresh(target);
                    return updated;
                },
                async delete(path, target) {
                    const deleted = await sideGenService.clues.delete(path, target);
                    if (deleted) {
                        scheduleSideGenUiRefresh(target);
                    }
                    return deleted;
                },
                async exportToWorldInfo(path, options) {
                    const exported = await sideGenService.clues.exportToWorldInfo(path, options);
                    scheduleSideGenUiRefresh();
                    return exported;
                },
            },
        };

        const undoStore = new UndoStore({
            persistence: createChatMetadataUndoAdapter(
                () => bridge.getMetadata(),
                () => bridge.saveChatDebounced(),
            ),
        });
        await undoStore.load();

        const assistantSessionStore = new AssistantSessionStore({
            bridge,
            trajectoryStore,
            persistenceMode: 'metadata',
        });

        const applyAssistantSettingsUpdate = async (
            updater: (prev: Settings) => Settings,
        ): Promise<Settings> => {
            const nextNormalized = normalizeSettings(updater(canonicalClone(currentSettings)));
            const storeUi = runtimeRefs.appStore;
            if (storeUi) {
                return await storeUi.updateSettings(() => nextNormalized);
            }
            updateSettingsState(nextNormalized, !suppressNextSave);
            await syncCustomAndLoreTools();
            return canonicalClone(currentSettings);
        };

        const assistantRunner = new AssistantRunner({
            bridge,
            transport,
            store,
            vfs,
            trajectoryStore,
            sessionStore: assistantSessionStore,
            undoStore,
            traceLogger,
            settings: () => currentSettings,
            updateSettings: applyAssistantSettingsUpdate,
            resolveConnection: resolveConnectionById,
            getActiveTarget: () => resolveValidTarget(runtimeRefs.appStore?.getSnapshot().activeTarget),
            getStatusSnapshot: () => {
                const activePreset = resolveActivePreset(currentSettings);
                const mainAgentId = activePreset.mainAgentId;
                const activeTarget = resolveValidTarget(
                    runtimeRefs.appStore?.getSnapshot().activeTarget,
                );
                return {
                    runMode: currentSettings.runMode,
                    currentPresetId: currentSettings.currentPresetId,
                    activePresetName: activePreset.name,
                    currentConnectionId: currentSettings.currentConnectionId,
                    activeTarget,
                    mainlineTokens: watermarkCompactor.estimateCurrentTokens(trajectoryStore, {
                        agentId: mainAgentId,
                    }),
                    archivedChunks: trajectoryStore.getArchivedUpToChunk(mainAgentId),
                    traceCount: traceLogger.listTraces().length,
                    sideSessionCount: sideGenService.sessionStore.listSessions().length,
                };
            },
        });

        const agentRunner = new AgentRunner({
            bridge,
            transport,
            settings: () => currentSettings,
            toolRegistry,
            contextAssembler,
            trajectoryStore,
            vfs,
            store,
            regexPipeline,
            loreReadEvaluator,
            tailRadar,
            traceLogger,
            sandbox,
            sideGen: sideGenApi,
        });

        const barrierCoordinator = new BarrierCoordinator({ traceLogger });
        const orchestrator = new PipelineOrchestrator({
            bridge,
            transport,
            settings: () => currentSettings,
            store,
            vfs,
            trajectoryStore,
            contextAssembler,
            watermarkCompactor,
            toolRegistry,
            traceLogger,
            barrierCoordinator,
            agentRunner,
            decoratorCompiler,
            classifier,
            loreReadEvaluator,
            tailRadar,
            regexPipeline,
            sandbox,
            sideGen: sideGenApi,
        });

        const updateSettingsState = (next: Settings, persistDebounced = true): Settings => {
            currentSettings = persistAgenticSettings(next, persistDebounced);
            regexPipeline.setRules(resolveActivePreset(currentSettings).regexRules);
            transport.setConnections(currentSettings.connections);
            if (currentSettings.runMode !== 'companion') {
                runtimeRefs.companionHooksHandle?.clearSideBridgePrompt();
            }
            return currentSettings;
        };

        let suppressNextSave = false;

        const uiServices = createLiveUiServices({
            bridge,
            store,
            dataCompactor,
            vfs,
            sideGen: sideGenApi,
            assistantRunner,
            traceLogger,
            sandbox,
            toolRegistry,
            trajectoryStore,
            watermarkCompactor,
            transport,
            barrierCoordinator,
            orchestrator,
            classifier,
            getSettings: () => currentSettings,
            setSettings: updateSettingsState,
            syncTools: syncCustomAndLoreTools,
            getAppStore: () => runtimeRefs.appStore,
            getInterceptorHandle: () => runtimeRefs.interceptorHandle,
            isSuppressingSave: () => suppressNextSave,
        });

        await syncCustomAndLoreTools();

        const appStore = new AppStore({
            initialSettings: currentSettings,
            initialTraces: traceLogger.listTraces(),
            initialBackgroundTasks: barrierCoordinator.listTasks(),
            initialTarget: resolveValidTarget(),
            services: uiServices,
            assistantRuntime: assistantRunner,
            sideGenRuntime: sideGenApi,
            getHostLuminance: () => bridge.getHostLuminance(),
        });
        runtimeRefs.appStore = appStore;
        appStore.setAssistantRuntime(assistantRunner);
        appStore.setSideGenRuntime(sideGenApi);
        setDefaultAppStore(appStore);

        // Register all Off-Mainline/Studio/Session views and Shadow DOM custom element before mounting UI shells.
        registerAssistantView();
        registerSideGenView();
        registerSessionViews();
        registerStudioViews();
        registerAgenticCapsuleElement();

        mountAgenticAppShell({ store: appStore });
        const hostMounts = setupHostUiContainers(appStore);

        void appStore.refreshAssistantState().catch(() => {});
        void appStore.refreshSideGenState().catch(() => {});

        if (initial.migrationReport) {
            appStore.pushToast(
                `已自动从 CustomGeneration 迁移配置（预设 ${Object.keys(currentSettings.presets).length} 个）。`,
                'primary',
                4200,
            );
        }

        const interceptorHandle = createAgenticInterceptor({
            bridge,
            orchestrator,
            getSettings: () => currentSettings,
            getAppStore: () => appStore,
            registerGlobal: true,
        });
        runtimeRefs.interceptorHandle = interceptorHandle;
        activeRealInterceptor = interceptorHandle.interceptor;

        const companionHooksHandle = setupCompanionHooks({
            bridge,
            orchestrator,
            tailRadar,
            getSettings: () => currentSettings,
            getAppStore: () => appStore,
            isTakeoverActive: () => interceptorHandle.isTakeoverActive(),
        });
        runtimeRefs.companionHooksHandle = companionHooksHandle;

        let sideGenLifecycleController = new AbortController();
        const rotateSideGenLifecycleAbort = (reason: string): void => {
            const prev = sideGenLifecycleController;
            sideGenLifecycleController = new AbortController();
            if (!prev.signal.aborted) {
                prev.abort(reason);
            }
        };

        const sideGenSlashHandle = registerSideGenSlashCommands({
            getSideGen: () => sideGenApi,
            getAbortSignal: () => sideGenLifecycleController.signal,
        });

        setupEmbedCard({
            store: appStore,
            bridge,
            dataStore: store,
        });

        // Persist assistant trajectory updates whenever AssistantRunner notifies subscribers.
        const unsubscribeAssistantPersist = assistantRunner.subscribe(() => {
            if (trajectoryStore.listAgentIds().length > 0) {
                trajectoryStore.saveToHost(bridge);
            }
        });

        let autoCompactInFlight = false;
        const runAutoStorageCompactionIfNeeded = async (): Promise<void> => {
            if (autoCompactInFlight || !currentSettings.storage.autoCompact) {
                return;
            }
            const keepDepth = currentSettings.storage.keepDepth;
            const threshold = currentSettings.storage.sizeThreshold;
            const overDataThreshold = dataCompactor.estimateBytes() > threshold;
            const overTrajectoryThreshold =
                trajectoryStore.estimateBytes() > threshold
                || trajectoryStore.countCheckpoints() > keepDepth + 16;
            if (!overDataThreshold && !overTrajectoryThreshold) {
                return;
            }
            autoCompactInFlight = true;
            try {
                const report = dataCompactor.compactColdLayers({
                    dryRun: false,
                    keepDepth,
                    includeLegacy: currentSettings.storage.pruneLegacy,
                    pruneColdScratch: true,
                });
                const coldEnd = Math.max(0, bridge.getChat().length - keepDepth);
                const cpResult = trajectoryStore.pruneColdCheckpoints(coldEnd);
                if (cpResult.removedCheckpoints > 0) {
                    trajectoryStore.saveToHost(bridge);
                }
                if (
                    report.removedLayers > 0
                    || report.compactedMessages > 0
                    || (report.prunedScratchFiles ?? 0) > 0
                    || cpResult.removedCheckpoints > 0
                ) {
                    await saveMetadata();
                }
            } finally {
                autoCompactInFlight = false;
            }
        };

        // Persist persistent agent trajectories and interrupted checkpoints whenever turn/trace events fire.
        traceLogger.subscribe((event) => {
            if (
                (event.kind === 'trace_recorded'
                    || event.kind === 'turn_interrupted'
                    || event.kind === 'turn_completed')
                && (trajectoryStore.listAgentIds().length > 0
                    || trajectoryStore.listInterruptedCheckpoints().size > 0)
            ) {
                trajectoryStore.saveToHost(bridge);
            }
            if (event.kind === 'turn_completed') {
                scheduleSideGenUiRefresh(event.target);
                void runAutoStorageCompactionIfNeeded().catch(() => {
                    // Best-effort post-turn background compaction.
                });
            }
        });

        const syncActiveTargetFromChat = (explicitMessageId?: number): void => {
            if (
                typeof explicitMessageId === 'number'
                && Number.isInteger(explicitMessageId)
                && explicitMessageId >= 0
                && chat[explicitMessageId]
            ) {
                const msg = chat[explicitMessageId] as { swipe_id?: unknown };
                const swipeId =
                    typeof msg?.swipe_id === 'number'
                    && Number.isInteger(msg.swipe_id)
                    && msg.swipe_id >= 0
                        ? msg.swipe_id
                        : 0;
                appStore?.setActiveTarget({ messageId: explicitMessageId, swipeId });
                return;
            }
            appStore?.setActiveTarget(resolveValidTarget());
        };

        const rehydrateMessageCapsules = (explicitMessageId?: number): void => {
            if (typeof document === 'undefined' || !Array.isArray(chat) || chat.length === 0) {
                return;
            }

            const indices: number[] =
                explicitMessageId !== undefined
                    ? Number.isInteger(explicitMessageId)
                      && explicitMessageId >= 0
                      && explicitMessageId < chat.length
                        ? [explicitMessageId]
                        : []
                    : chat.map((_, idx) => idx);

            const hasTargetCheckpoint = (target: MessageTarget): boolean =>
                trajectoryStore
                    .listAgentIds()
                    .filter((id) => !id.startsWith('side:') && !id.startsWith('assistant:'))
                    .some((agentId) => trajectoryStore.getCheckpoint(target, agentId) !== undefined);

            for (const messageId of indices) {
                const rawMsg = chat[messageId] as
                    | { is_user?: unknown; is_system?: unknown; swipe_id?: unknown }
                    | undefined;
                if (!rawMsg || rawMsg.is_user || rawMsg.is_system) {
                    continue;
                }

                const mesElement = document.querySelector<HTMLElement>(
                    `#chat .mes[mesid="${messageId}"]`,
                );
                if (!mesElement) {
                    continue;
                }

                const swipeId =
                    typeof rawMsg.swipe_id === 'number'
                    && Number.isInteger(rawMsg.swipe_id)
                    && rawMsg.swipe_id >= 0
                        ? rawMsg.swipe_id
                        : 0;
                const msgTarget: MessageTarget = { messageId, swipeId };

                const interruptedCp = trajectoryStore.getInterruptedCheckpoint(msgTarget);
                const existingCapsule =
                    mesElement.querySelector<AgenticCapsuleElement>('agentic-capsule');

                if (interruptedCp) {
                    const capsule =
                        existingCapsule
                        ?? (document.createElement('agentic-capsule') as AgenticCapsuleElement);
                    placeAgenticCapsule(
                        mesElement,
                        capsule,
                        currentSettings.capsulePosition ?? 'bottom',
                    );
                    capsule.connectStore(appStore, msgTarget);
                    capsule.setState({
                        status: 'interrupted',
                        canResume: true,
                        interruptedReason: interruptedCp.reason,
                        summary: '',
                        errorMessage: interruptedCp.errorMessage ?? '',
                        onResume: () => uiServices.resumeTurn?.(msgTarget),
                    });
                    continue;
                }

                if (existingCapsule) {
                    const hasCheckpoint = hasTargetCheckpoint(msgTarget);
                    existingCapsule.setState({
                        status: hasCheckpoint ? 'done' : 'idle',
                        canResume: false,
                        interruptedReason: undefined,
                        errorMessage: '',
                        summary: '',
                        onResume: undefined,
                    });
                    existingCapsule.connectStore(appStore, msgTarget);
                } else if (currentSettings.runMode !== 'off' && hasTargetCheckpoint(msgTarget)) {
                    const capsule = document.createElement(
                        'agentic-capsule',
                    ) as AgenticCapsuleElement;
                    placeAgenticCapsule(
                        mesElement,
                        capsule,
                        currentSettings.capsulePosition ?? 'bottom',
                    );
                    capsule.setState({
                        status: 'done',
                        canResume: false,
                        interruptedReason: undefined,
                        errorMessage: '',
                        summary: '',
                        onResume: undefined,
                    });
                    capsule.connectStore(appStore, msgTarget);
                }
            }
        };

        rehydrateMessageCapsules();

        const handleChatChanged = async (): Promise<void> => {
            assistantRunner.abort();
            assistantRunner.clearSpillStore();
            toolRegistry.clearSpillStore();
            rotateSideGenLifecycleAbort('chat_changed');
            sideGenService.abortAll('chat_changed');
            sandboxLifecycle.disposeAll();
            invalidateHeadIndex();
            hydrateTrajectoryStore(trajectoryStore, TrajectoryStore.loadFromHost(bridge));
            sideGenService.onChatChanged({ reloadTrajectory: false });
            await undoStore.load();
            await assistantRunner.sessionStore.load();
            syncActiveTargetFromChat();
            appStore?.setTraces(traceLogger.listTraces());
            appStore?.setBackgroundTasks(barrierCoordinator.listTasks());
            await appStore?.refreshAssistantState();
            await appStore?.refreshSideGenState();
            if (currentSettings.runMode !== 'companion') {
                companionHooksHandle.clearSideBridgePrompt();
            }
            rehydrateMessageCapsules();
            await syncCustomAndLoreTools();
            await runAutoStorageCompactionIfNeeded();
        };

        const handleSettingsReloaded = async (): Promise<void> => {
            const reloaded = (extension_settings as Record<string, unknown>)[
                DEFAULT_EXTENSION_SETTINGS_KEY
            ];
            if (!hasStoredAgenticSettings(reloaded)) {
                return;
            }
            const normalized = normalizeSettings(reloaded);
            if (canonicalStringify(normalized) === canonicalStringify(currentSettings)) {
                return;
            }
            updateSettingsState(normalized, false);
            if (appStore) {
                suppressNextSave = true;
                try {
                    await appStore.updateSettings(() => normalized);
                } finally {
                    suppressNextSave = false;
                }
            }
            await syncCustomAndLoreTools();
        };

        bridge.setAgenticSettingsReloadHook(handleSettingsReloaded);

        eventSource.on(event_types.CHAT_CHANGED, () => {
            void handleChatChanged();
        });
        eventSource.on(event_types.SETTINGS_LOADED, () => {
            void handleSettingsReloaded();
        });
        eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => {
            void handleSettingsReloaded();
        });
        eventSource.on(event_types.WORLDINFO_UPDATED, () => {
            void syncCustomAndLoreTools();
        });
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, () => {
            void syncCustomAndLoreTools();
        });
        eventSource.on(event_types.MESSAGE_DELETED, (messageId: unknown) => {
            const resolvedMsgId =
                typeof messageId === 'number' && Number.isInteger(messageId) && messageId >= 0
                    ? messageId
                    : undefined;
            rotateSideGenLifecycleAbort('messages_pruned');
            if (resolvedMsgId !== undefined) {
                sideGenService.onMessagesPruned(resolvedMsgId);
            } else {
                sideGenService.abortAll('messages_pruned');
            }
            syncActiveTargetFromChat();
            appStore?.setTraces(traceLogger.listTraces());
            scheduleSideGenUiRefresh();
        });
        eventSource.on(event_types.MESSAGE_SWIPED, (messageId: unknown) => {
            const resolvedMsgId = typeof messageId === 'number' ? messageId : undefined;
            syncActiveTargetFromChat(resolvedMsgId);
            const nextAnchor = appStore.getSnapshot().activeTarget;
            rotateSideGenLifecycleAbort('branch_changed');
            sideGenService.onBranchChanged(nextAnchor);
            appStore?.setTraces(traceLogger.listTraces());
            rehydrateMessageCapsules(resolvedMsgId);
            scheduleSideGenUiRefresh(nextAnchor);
        });
        if (event_types.MESSAGE_SWIPE_DELETED) {
            eventSource.on(event_types.MESSAGE_SWIPE_DELETED, () => {
                syncActiveTargetFromChat();
                const nextAnchor = appStore.getSnapshot().activeTarget;
                rotateSideGenLifecycleAbort('branch_changed');
                sideGenService.onBranchChanged(nextAnchor, { pruneSiblings: false });
                scheduleSideGenUiRefresh(nextAnchor);
            });
        }
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId: unknown) => {
            syncActiveTargetFromChat(typeof messageId === 'number' ? messageId : undefined);
            scheduleSideGenUiRefresh();
            void runAutoStorageCompactionIfNeeded().catch(() => {
                // Best-effort message-received background compaction.
            });
        });
        if (event_types.MESSAGE_SENT) {
            eventSource.on(event_types.MESSAGE_SENT, (messageId: unknown) => {
                syncActiveTargetFromChat(typeof messageId === 'number' ? messageId : undefined);
                scheduleSideGenUiRefresh();
            });
        }
        eventSource.on(event_types.MESSAGE_UPDATED, (messageId: unknown) => {
            syncActiveTargetFromChat(typeof messageId === 'number' ? messageId : undefined);
            scheduleSideGenUiRefresh();
        });
        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, (messageId: unknown) => {
                syncActiveTargetFromChat(typeof messageId === 'number' ? messageId : undefined);
                scheduleSideGenUiRefresh();
            });
        }
        if (event_types.GENERATION_STOPPED) {
            eventSource.on(event_types.GENERATION_STOPPED, () => {
                rotateSideGenLifecycleAbort('generation_stopped');
                sideGenService.abortAll('generation_stopped');
                assistantRunner.abort();
            });
        }
        eventSource.on(event_types.APP_READY, () => {
            hostMounts.sync();
            syncActiveTargetFromChat();
            rehydrateMessageCapsules();
            scheduleSideGenUiRefresh();
        });
        eventSource.on(event_types.EXTENSIONS_FIRST_LOAD, () => {
            hostMounts.sync();
        });

        let runtimeDisposed = false;
        const disposeOffMainlineAndHost = (): void => {
            if (runtimeDisposed) {
                return;
            }
            runtimeDisposed = true;
            assistantRunner.abort();
            assistantRunner.clearSpillStore();
            toolRegistry.clearSpillStore();
            rotateSideGenLifecycleAbort('unload');
            sideGenService.abortAll('unload');
            unsubscribeAssistantPersist();
            companionHooksHandle.clearSideBridgePrompt();
            companionHooksHandle.dispose();
            sideGenSlashHandle.dispose();
            interceptorHandle.dispose();
            hostMounts.dispose();
            sandboxLifecycle.disposeAll();
        };

        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', disposeOffMainlineAndHost, { once: true });
            window.addEventListener('pagehide', disposeOffMainlineAndHost, { once: true });
        }

        await runAutoStorageCompactionIfNeeded();

        const publicAssistantApi: AgenticAssistantPublicApi = {
            open: (sessionId?: string) => {
                appStore.openConsole(
                    'assistant',
                    sessionId ? { assistantSessionId: sessionId } : undefined,
                );
            },
            listSessions: () => assistantRunner.listSessions(),
            getSession: (sessionId: string) => assistantRunner.getSession(sessionId),
            createSession: (opts) => assistantRunner.createSession(opts),
            updateSession: (sessionId, patch) => assistantRunner.updateSessionConfig(sessionId, patch),
            deleteSession: (sessionId) => assistantRunner.deleteSession(sessionId),
            send: (sessionId, prompt, opts) => assistantRunner.sendPrompt(sessionId, prompt, opts),
            editMessage: (sessionId, messageId, newContent) =>
                assistantRunner.editMessage(sessionId, messageId, newContent),
            editAndResendMessage: (sessionId, messageId, newContent, opts) =>
                assistantRunner.editAndResendMessage(sessionId, messageId, newContent, opts),
            retractMessage: (sessionId, messageId) =>
                assistantRunner.retractMessage(sessionId, messageId),
            regenerateLastMessage: (sessionId, opts) =>
                assistantRunner.regenerateLastMessage(sessionId, opts),
            continueLastMessage: (sessionId, opts) =>
                assistantRunner.continueLastMessage(sessionId, opts),
            decideApproval: (approvalId, decision, feedback) =>
                assistantRunner.decideApproval(approvalId, decision, feedback),
            retryApproval: (approvalId, feedback) =>
                assistantRunner.retryApproval(approvalId, feedback),
            undo: (undoId) => assistantRunner.undo(undoId),
            listPendingApprovals: (sessionId) => assistantRunner.listApprovals(sessionId),
            listUndoHistory: (sessionId) => assistantRunner.listUndoRecords(sessionId),
            abort: (sessionId) => assistantRunner.abort(sessionId),
        };

        const publicApi: AgenticPublicApi = {
            version: AGENTIC_VERSION,
            getSettings: () => canonicalClone(currentSettings),
            openConsole: (tab, deepLink) => {
                appStore?.openConsole(tab, deepLink);
            },
            closeConsole: () => {
                appStore?.closeConsole();
            },
            runTurn: (input) => orchestrator.runTurn(input),
            rerunAfterTurn: async (target) => {
                await uiServices.rerunAfterTurn(target);
            },
            sideGen: sideGenApi,
            assistant: publicAssistantApi,
            vfs,
            store,
            traces: traceLogger,
            orchestrator,
            sandbox,
            uiStore: appStore,
            bridge,
        };

        globalThis.Agentic = publicApi;
        resolveBootReady?.();
    } catch (error) {
        bootFailed = true;
        resolveBootReady?.();
        console.error('[Agentic] Initialization failed:', error);
    }
});

export type { AgenticAssistantPublicApi, AgenticPublicApi };
export default {
    version: AGENTIC_VERSION,
    getApi: (): AgenticPublicApi | undefined => globalThis.Agentic,
};
