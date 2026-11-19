import {
    chat,
    chat_metadata,
    extension_prompt_roles,
    extension_prompt_types,
    setExtensionPrompt,
} from '@st/script.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import { extension_settings } from '@st/scripts/extensions.js';
import { selected_group } from '@st/scripts/group-chats.js';
import { MacroCategory, macros, MacroValueType } from '@st/scripts/macros/macro-system.js';
import { worldInfoCache } from '@st/scripts/world-info.js';

import { resolveActivePreset } from '@/core/config';
import { DecoratorParser } from '@/core/lore';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    VARIABLES_DOC_KEY,
    worldInfoKey,
} from '@/core/store';
import {
    groupTriggersForExecution,
    PipelineOrchestrator,
    type TriggerExecutionUnit,
} from '@/core/triggers';
import type { MessageTarget, RawLoreEntry, Settings, TriggerRule } from '@/core/types';
import { normalizeVfsPath } from '@/core/utils';
import {
    GLOBAL_VFS_EXTENSION_KEY,
    OUTPUT_FILE_PATH,
    unescapeAt,
    type VirtualFileSystem,
} from '@/core/vfs';
import {
    AgenticCapsuleElement,
    placeAgenticCapsule,
    registerAgenticCapsuleElement,
} from '@/ui/capsule';
import type { AppStore } from '@/ui/store';

import type { STHostBridge } from './st-bridge';

const COMPANION_PROMPT_KEY = 'agentic_companion_before';

const CONTROL_DECORATOR_NAMES = new Set([
    'trigger',
    'agent',
    'tool',
    'script',
    'skill',
    'json_schema',
    'zod_schema',
    'replace',
    'replace_before',
    'replace_diff',
    'replace_diff_before',
    'replace_prompt',
    'replace_search',
    'replace_pattern',
    'replace_user',
    'replace_ai',
    'append_output',
    'evaluate_ejs',
    'variables',
    'initvar',
    'var',
]);

export interface CompanionHooksOptions {
    bridge: STHostBridge;
    orchestrator: PipelineOrchestrator;
    getSettings: () => Settings | undefined;
    getAppStore?: () => AppStore | undefined;
    isTakeoverActive?: () => boolean;
}

export interface CompanionHooksHandle {
    dispose(): void;
    resolveVfsFileSync(rawPath: string, target?: MessageTarget): string;
}

interface PendingCompanionTurn {
    target: MessageTarget;
    controller: AbortController;
}

function getLatestMessageTarget(): MessageTarget {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { messageId: 0, swipeId: 0 };
    }
    const lastId = chat.length - 1;
    const msg = chat[lastId] as { swipe_id?: unknown } | undefined;
    const swipeId = typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
    return { messageId: lastId, swipeId };
}

function resolveUpcomingTarget(genType: string): MessageTarget {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { messageId: 0, swipeId: 0 };
    }

    const lastIdx = chat.length - 1;
    const lastMsg = chat[lastIdx] as { is_user?: unknown; swipe_id?: unknown } | undefined;
    if (genType === 'swipe' || genType === 'continue') {
        const swipeId = typeof lastMsg?.swipe_id === 'number' ? lastMsg.swipe_id : 0;
        return { messageId: lastIdx, swipeId };
    }
    if (genType === 'regenerate') {
        if (lastMsg && !lastMsg.is_user) {
            return { messageId: lastIdx, swipeId: 0 };
        }
        return { messageId: chat.length, swipeId: 0 };
    }
    return { messageId: chat.length, swipeId: 0 };
}

function parseNumericUid(rawUid: unknown, fallback: number): number {
    if (typeof rawUid === 'number' && Number.isFinite(rawUid)) {
        return rawUid;
    }
    if (typeof rawUid === 'string') {
        const parsed = Number.parseInt(rawUid, 10);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return fallback;
}

function syncVariablesToChatMetadata(store: ChatDataStore, target: MessageTarget): void {
    const varsEntry =
        store.getPending(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target }) ??
        store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target });
    if (!varsEntry?.content) {
        return;
    }

    try {
        const parsed = JSON.parse(varsEntry.content) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const meta = (chat_metadata ?? {}) as Record<string, unknown>;
            const existing =
                meta.variables && typeof meta.variables === 'object'
                    ? (meta.variables as Record<string, unknown>)
                    : ((meta.variables = {}) as Record<string, unknown>);
            Object.assign(existing, parsed);
        }
    } catch {
        // Ignore non-JSON variable snapshot in sync helper.
    }
}

function isControlLoreEntry(rawEntry: Record<string, unknown>, idx: number): boolean {
    const candidate: RawLoreEntry = {
        world: typeof rawEntry.world === 'string' ? rawEntry.world : '',
        uid: parseNumericUid(rawEntry.uid, idx),
        comment: typeof rawEntry.comment === 'string' ? rawEntry.comment : '',
        content: typeof rawEntry.content === 'string' ? rawEntry.content : '',
        keys: Array.isArray(rawEntry.key)
            ? rawEntry.key.map(String)
            : Array.isArray(rawEntry.keys)
              ? rawEntry.keys.map(String)
              : [],
        keysecondary: Array.isArray(rawEntry.keysecondary) ? rawEntry.keysecondary.map(String) : [],
        constant: Boolean(rawEntry.constant),
        selective: rawEntry.selective !== undefined ? Boolean(rawEntry.selective) : true,
        disable: Boolean(rawEntry.disable),
        position: typeof rawEntry.position === 'number' ? rawEntry.position : 0,
        depth: typeof rawEntry.depth === 'number' ? rawEntry.depth : 4,
        order: typeof rawEntry.order === 'number' ? rawEntry.order : 100,
        role: typeof rawEntry.role === 'number' ? rawEntry.role : 0,
    };
    const parsed = DecoratorParser.parseEntry(candidate);
    if (parsed.decorators.some((dec) => CONTROL_DECORATOR_NAMES.has(dec.name.toLowerCase()))) {
        return true;
    }
    return /^@@(?:trigger|agent|tool|script|skill|json_schema|zod_schema|replace(?:_\w+)?|append_output|evaluate_ejs|variables|initvar)\b/im.test(
        candidate.content,
    );
}

function resolveLoreContentSync(
    relPath: string,
    bridge: STHostBridge,
    store: ChatDataStore,
    target: MessageTarget,
): string {
    const slashIdx = relPath.indexOf('/');
    const worldFilter = slashIdx === -1 ? '' : relPath.slice(0, slashIdx);
    const entryQuery = slashIdx === -1 ? relPath : relPath.slice(slashIdx + 1);

    const applyWorldOverride = (world: string, uid: string | number, fallback: string): string => {
        const key = worldInfoKey(world, uid);
        const override =
            store.getPending(DATA_NAMESPACES.WORLDINFO, key, { target }) ??
            store.get(DATA_NAMESPACES.WORLDINFO, key, { target });
        return typeof override?.content === 'string' ? unescapeAt(override.content) : fallback;
    };

    const cached = bridge.getCachedLorebooks();
    for (const [worldName, entries] of cached.entries()) {
        if (worldFilter && worldName !== worldFilter) {
            continue;
        }
        for (const entry of entries) {
            if (
                String(entry.uid) === entryQuery ||
                (entry.comment && entry.comment === entryQuery) ||
                relPath === `${worldName}/${String(entry.uid)}`
            ) {
                return applyWorldOverride(worldName, entry.uid, entry.content);
            }
        }
    }

    if (worldInfoCache && typeof worldInfoCache.get === 'function' && worldFilter) {
        const rawBook = worldInfoCache.get(worldFilter) as
            | { entries?: Record<string, Record<string, unknown>> | Array<Record<string, unknown>> }
            | undefined;
        if (rawBook?.entries) {
            const list = Array.isArray(rawBook.entries)
                ? rawBook.entries
                : Object.values(rawBook.entries);
            for (const entry of list) {
                const uid = entry.uid as string | number | undefined;
                const comment = typeof entry.comment === 'string' ? entry.comment : '';
                if (String(uid ?? '') === entryQuery || (comment && comment === entryQuery)) {
                    return applyWorldOverride(
                        worldFilter,
                        uid ?? entryQuery,
                        typeof entry.content === 'string' ? entry.content : '',
                    );
                }
            }
        }
    }

    return '';
}

function readNamespaceEntrySync(
    store: ChatDataStore,
    namespace: (typeof DATA_NAMESPACES)[keyof typeof DATA_NAMESPACES],
    key: string,
    target: MessageTarget,
): string | undefined {
    const entry = store.getPending(namespace, key, { target }) ?? store.get(namespace, key, { target });
    return typeof entry?.content === 'string' ? unescapeAt(entry.content) : undefined;
}

function buildSyncVfsReader(
    bridge: STHostBridge,
    store: ChatDataStore,
    getSettings: () => Settings | undefined,
    vfs?: VirtualFileSystem,
): (rawPath: string, target?: MessageTarget) => string {
    return (rawPath: string, targetOverride?: MessageTarget): string => {
        const settings = getSettings();
        if (!settings || settings.runMode === 'off') {
            return '';
        }

        const normalized = normalizeVfsPath(rawPath);
        if (!normalized || normalized.includes('..')) {
            return '';
        }

        const target = targetOverride ?? getLatestMessageTarget();
        if (normalized === OUTPUT_FILE_PATH) {
            return bridge.readChatMessage(target) ?? vfs?.peekPreCreateBuffer(target) ?? '';
        }

        const rel = normalized.startsWith('/') ? normalized.slice(1) : normalized;

        if (rel === 'vars' || rel.startsWith('vars/')) {
            const varsEntry =
                store.getPending(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target }) ??
                store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target });
            if (!varsEntry?.content) {
                return '';
            }
            const subKey = rel === 'vars' ? '' : rel.slice('vars/'.length);
            if (!subKey || subKey === VARIABLES_DOC_KEY) {
                return varsEntry.content;
            }
            try {
                const obj = JSON.parse(varsEntry.content) as Record<string, unknown>;
                const val = obj[subKey];
                if (val === undefined) {
                    return '';
                }
                return typeof val === 'string' ? val : JSON.stringify(val);
            } catch {
                return '';
            }
        }

        if (rel.startsWith('chat/')) {
            const key = rel.slice('chat/'.length);
            return readNamespaceEntrySync(store, DATA_NAMESPACES.FILES, key, target) ?? '';
        }

        if (rel.startsWith('character/')) {
            const key = rel.slice('character/'.length);
            const fromStore = readNamespaceEntrySync(
                store,
                DATA_NAMESPACES.CHARACTER_FILES,
                key,
                target,
            );
            if (fromStore !== undefined) {
                return fromStore;
            }
            const fields = bridge.getCharacterFields();
            const fieldKey = key.replace(/\.md$/i, '');
            return fields[key] ?? fields[fieldKey] ?? '';
        }

        if (rel.startsWith('persona/')) {
            const key = rel.slice('persona/'.length);
            const fromStore = readNamespaceEntrySync(
                store,
                DATA_NAMESPACES.PERSONA_FILES,
                key,
                target,
            );
            if (fromStore !== undefined) {
                return fromStore;
            }
            if (key === 'description' || key === 'description.md' || key === 'persona.md') {
                return bridge.getPersonaDescription();
            }
            return '';
        }

        if (rel.startsWith('preset/')) {
            const key = rel.slice('preset/'.length);
            const preset = resolveActivePreset(settings);
            const hit = preset?.files?.[key];
            return typeof hit === 'string' ? hit : '';
        }

        if (rel.startsWith('global/')) {
            const key = rel.slice('global/'.length);
            const extSettings = extension_settings as Record<string, unknown>;
            const globalBucket = extSettings?.[GLOBAL_VFS_EXTENSION_KEY] as
                | Record<string, unknown>
                | undefined;
            const val = globalBucket?.[key];
            return typeof val === 'string' ? val : '';
        }

        if (rel.startsWith('lore/')) {
            return resolveLoreContentSync(rel.slice('lore/'.length), bridge, store, target);
        }

        if (rel.startsWith('messages/')) {
            const idPart = rel.slice('messages/'.length).replace(/\.[^/.]+$/, '');
            const messageId = Number.parseInt(idPart, 10);
            if (
                !Number.isInteger(messageId) ||
                !Array.isArray(chat) ||
                messageId < 0 ||
                messageId >= chat.length
            ) {
                return '';
            }
            const msg = chat[messageId] as { swipe_id?: unknown };
            const msgSwipe = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
            return bridge.readChatMessage({ messageId, swipeId: msgSwipe }) ?? '';
        }

        // Default fallback: try /chat/ namespace directly for shorthand paths.
        return readNamespaceEntrySync(store, DATA_NAMESPACES.FILES, rel, target) ?? '';
    };
}

function buildScanTail(scanDepth = 8): string {
    if (!Array.isArray(chat) || chat.length === 0) {
        return '';
    }
    const tail = chat.slice(-Math.max(1, scanDepth));
    return tail
        .map((msg) => {
            const m = msg as { name?: unknown; mes?: unknown };
            const speaker = typeof m.name === 'string' && m.name ? `${m.name}: ` : '';
            return `${speaker}${typeof m.mes === 'string' ? m.mes : ''}`;
        })
        .join('\n\n');
}

async function runCompanionBeforeTurnUnits(
    orchestrator: PipelineOrchestrator,
    bridge: STHostBridge,
    settings: Settings,
    target: MessageTarget,
    signal: AbortSignal,
): Promise<string> {
    const lorebooks = await bridge.listEnabledLorebooks();
    const preset = resolveActivePreset(settings);
    const compiled = orchestrator.decoratorCompiler.compile(lorebooks, { preset });
    const beforeRules = compiled.triggers.filter(
        (rule) => rule.phase === 'before_turn' && rule.enabled,
    );

    if (beforeRules.length === 0) {
        return '';
    }

    const units: TriggerExecutionUnit[] = groupTriggersForExecution(beforeRules);
    const scanText = buildScanTail();
    const turnNumber = target.messageId + 1;
    const briefFragments: string[] = [];

    const executeRule = async (rule: TriggerRule): Promise<void> => {
        if (signal.aborted) {
            return;
        }
        const evaluation = await orchestrator.evaluateCondition(rule, {
            target,
            turnNumber,
            scanText,
            signal,
        });
        if (!evaluation.matched || signal.aborted) {
            return;
        }

        const substitutedPrompt = bridge.substituteMacros(
            rule.instructionTemplate,
            evaluation.matchOverrides,
        );
        if (!substitutedPrompt.trim()) {
            return;
        }

        if (rule.kind === 'agent' && rule.agentProfileId) {
            const agentProfile = preset?.agents?.[rule.agentProfileId] ?? rule.agentProfileId;
            const result = await orchestrator.agentRunner.run({
                agent: agentProfile,
                userInput: substitutedPrompt,
                target,
                phase: 'before_turn',
                preset,
                signal,
            });
            if (result.content.trim()) {
                briefFragments.push(result.content.trim());
            }
            return;
        }

        if (rule.kind === 'agent') {
            briefFragments.push(substitutedPrompt.trim());
        }
    };

    for (const unit of units) {
        if (signal.aborted) {
            break;
        }
        if (unit.isGrouped && unit.triggers.length > 1) {
            await Promise.all(unit.triggers.map((rule) => executeRule(rule)));
        } else {
            for (const rule of unit.triggers) {
                await executeRule(rule);
            }
        }
    }

    return briefFragments.join('\n\n');
}

function mountCompanionCapsule(
    messageId: number,
    target: MessageTarget,
    settings: Settings,
    getAppStore?: () => AppStore | undefined,
): AgenticCapsuleElement | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const mesElement = document.querySelector<HTMLElement>(`#chat .mes[mesid="${messageId}"]`);
    if (!mesElement) {
        return null;
    }

    registerAgenticCapsuleElement();
    const existing = mesElement.querySelector<AgenticCapsuleElement>('agentic-capsule');
    const capsule =
        existing ?? (document.createElement('agentic-capsule') as AgenticCapsuleElement);
    placeAgenticCapsule(mesElement, capsule, settings.capsulePosition ?? 'bottom');

    const appStore = getAppStore?.();
    if (appStore) {
        capsule.connectStore(appStore, target);
    }
    return capsule;
}

function unregisterFileMacro(): void {
    const macroHolder = macros as {
        registry?: { unregister?: (name: string) => void };
    };
    macroHolder.registry?.unregister?.('file');
}

/**
 * Register SillyTavern Companion mode hooks (`before_turn`, `WORLDINFO_ENTRIES_LOADED`,
 * `{{file::path}}` macro, and `after_turn` + `<agentic-capsule>`) alongside causal branch listeners.
 */
export function setupCompanionHooks(options: CompanionHooksOptions): CompanionHooksHandle {
    const { bridge, orchestrator, getSettings, getAppStore, isTakeoverActive } = options;
    const resolveVfsFileSync = buildSyncVfsReader(
        bridge,
        orchestrator.store,
        getSettings,
        orchestrator.vfs,
    );
    bridge.setFileMacroResolver((path) => resolveVfsFileSync(path));

    // Register {{file::path}} macro for SillyTavern's experimental MacroEngine.
    try {
        unregisterFileMacro();
        const fallbackCategory = MacroCategory?.UTILITY ?? 'utility';
        macros.register('file', {
            category: fallbackCategory,
            description: 'Read a file from the ST-Agentic Virtual File System synchronously',
            unnamedArgs: [
                {
                    name: 'path',
                    type: MacroValueType?.STRING ?? 'string',
                    optional: false,
                    description: 'Virtual file path (e.g. /chat/notes.md, /vars/hp)',
                },
            ],
            handler: (ctx: { unnamedArgs?: unknown[] }) => {
                const argPath = String(ctx?.unnamedArgs?.[0] ?? '').trim();
                return argPath ? resolveVfsFileSync(argPath) : '';
            },
        });
    } catch (error) {
        console.warn('[ST-Agentic] Could not register {{file::path}} macro on MacroEngine:', error);
    }

    let activeGenType: string | null = null;
    let pendingCompanionTurn: PendingCompanionTurn | null = null;

    const clearCompanionPrompt = () => {
        if (typeof setExtensionPrompt === 'function') {
            setExtensionPrompt(
                COMPANION_PROMPT_KEY,
                '',
                extension_prompt_types?.IN_CHAT ?? 1,
                0,
                false,
                extension_prompt_roles?.SYSTEM ?? 0,
            );
        }
    };

    const onGenerationAfterCommands = async (
        type: unknown,
        _genOptions: unknown,
        dryRun?: unknown,
    ) => {
        if (dryRun === true) {
            return;
        }

        const genType = typeof type === 'string' && type ? type : 'normal';
        activeGenType = genType;

        const settings = getSettings();
        if (!settings || settings.runMode !== 'companion') {
            clearCompanionPrompt();
            return;
        }

        if (genType === 'quiet') {
            return;
        }

        pendingCompanionTurn?.controller.abort('Superseded by new generation');
        const controller = new AbortController();
        const target = resolveUpcomingTarget(genType);
        pendingCompanionTurn = { target, controller };

        try {
            await orchestrator.barrierCoordinator.awaitTurnBarriers({
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                return;
            }

            const briefText = await runCompanionBeforeTurnUnits(
                orchestrator,
                bridge,
                settings,
                target,
                controller.signal,
            );
            if (controller.signal.aborted) {
                return;
            }

            syncVariablesToChatMetadata(orchestrator.store, target);

            if (typeof setExtensionPrompt === 'function') {
                setExtensionPrompt(
                    COMPANION_PROMPT_KEY,
                    briefText,
                    extension_prompt_types?.IN_CHAT ?? 1,
                    0,
                    Boolean(briefText),
                    extension_prompt_roles?.SYSTEM ?? 0,
                );
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                console.warn('[ST-Agentic] Companion before_turn hook failed:', error);
            }
        }
    };

    const onWorldInfoEntriesLoaded = (data: unknown) => {
        const settings = getSettings();
        if (!settings || settings.runMode === 'off') {
            return;
        }

        const payload = (data && typeof data === 'object' ? data : {}) as {
            globalLore?: Array<Record<string, unknown>>;
            characterLore?: Array<Record<string, unknown>>;
            chatLore?: Array<Record<string, unknown>>;
            personaLore?: Array<Record<string, unknown>>;
        };

        const lists = [
            payload.globalLore,
            payload.characterLore,
            payload.chatLore,
            payload.personaLore,
        ].filter((list): list is Array<Record<string, unknown>> => Array.isArray(list));

        if (settings.runMode === 'takeover') {
            // Short-circuit redundant ST WI scan during single-chat takeover unless in passthrough (/gen or group).
            if (!selected_group && (isTakeoverActive?.() || activeGenType !== 'quiet')) {
                for (const list of lists) {
                    list.length = 0;
                }
            }
            return;
        }

        const target = pendingCompanionTurn?.target ?? getLatestMessageTarget();
        for (const list of lists) {
            for (let i = list.length - 1; i >= 0; i--) {
                const entry = list[i];
                if (!entry) {
                    continue;
                }
                if (isControlLoreEntry(entry, i)) {
                    list.splice(i, 1);
                    continue;
                }

                const worldName = typeof entry.world === 'string' ? entry.world : '';
                const uid = entry.uid as string | number | undefined;
                if (worldName && uid !== undefined) {
                    const key = worldInfoKey(worldName, uid);
                    const override =
                        orchestrator.store.getPending(DATA_NAMESPACES.WORLDINFO, key, { target }) ??
                        orchestrator.store.get(DATA_NAMESPACES.WORLDINFO, key, { target });
                    if (typeof override?.content === 'string') {
                        entry.content = unescapeAt(override.content);
                    }
                }
            }
        }
    };

    const onCharacterMessageRendered = async (messageId: unknown) => {
        clearCompanionPrompt();

        const settings = getSettings();
        if (!settings || settings.runMode !== 'companion') {
            return;
        }
        if (activeGenType === 'quiet') {
            activeGenType = null;
            return;
        }
        activeGenType = null;

        if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId < 0) {
            return;
        }

        const msg = Array.isArray(chat)
            ? (chat[messageId] as { swipe_id?: unknown } | undefined)
            : undefined;
        const swipeId = typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
        const target: MessageTarget = { messageId, swipeId };

        if (pendingCompanionTurn?.target.messageId === messageId) {
            pendingCompanionTurn = null;
        }

        await orchestrator.store.commitStagedData(target);
        syncVariablesToChatMetadata(orchestrator.store, target);

        const bufferedOutput = orchestrator.vfs.flushPreCreateBuffer(target);
        if (bufferedOutput !== undefined) {
            const currentText = bridge.readChatMessage(target) ?? '';
            const nextText = !currentText
                ? bufferedOutput
                : !bufferedOutput
                  ? currentText
                  : currentText.includes(bufferedOutput)
                    ? currentText
                    : currentText.endsWith('\n') || bufferedOutput.startsWith('\n')
                      ? `${currentText}${bufferedOutput}`
                      : `${currentText}\n${bufferedOutput}`;
            if (nextText !== currentText) {
                await bridge.writeChatMessage(target, nextText, { emitEvent: false });
            } else {
                await bridge.refreshMessageView(target);
            }
        } else {
            await bridge.refreshMessageView(target);
        }

        const capsule = mountCompanionCapsule(messageId, target, settings, getAppStore);
        capsule?.setState({
            status: 'done',
            currentStep: '',
            errorMessage: '',
        });

        try {
            const handles = await orchestrator.rerunAfterTurn(target, {
                turnNumber: messageId + 1,
            });
            if (handles.length > 0) {
                capsule?.setState({
                    status: 'background-running',
                    currentStep: `${handles.length} background task${handles.length === 1 ? '' : 's'}`,
                });
                void Promise.allSettled(handles.map((h) => h.promise)).then((results) => {
                    const rejected = results.find((r) => r.status === 'rejected');
                    if (rejected && rejected.status === 'rejected') {
                        capsule?.setState({
                            status: 'error',
                            errorMessage: String(rejected.reason ?? 'Background task failed'),
                            currentStep: '',
                        });
                    } else {
                        capsule?.setState({
                            status: 'done',
                            currentStep: '',
                        });
                    }
                });
            }
        } catch (error) {
            capsule?.setState({
                status: 'error',
                errorMessage: error instanceof Error ? error.message : String(error),
                currentStep: '',
            });
        }
    };

    const onGenerationStopped = () => {
        activeGenType = null;
        clearCompanionPrompt();
        if (pendingCompanionTurn) {
            pendingCompanionTurn.controller.abort('Generation stopped');
            orchestrator.store.rollbackStagedData(pendingCompanionTurn.target);
            orchestrator.vfs.flushPreCreateBuffer(pendingCompanionTurn.target);
            pendingCompanionTurn = null;
        }
    };

    const onGenerationEnded = () => {
        activeGenType = null;
    };

    const onMessageSwiped = (messageId: unknown) => {
        if (typeof messageId !== 'number' || !Array.isArray(chat) || !chat[messageId]) {
            return;
        }
        const msg = chat[messageId] as { swipe_id?: unknown };
        const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        const target: MessageTarget = { messageId, swipeId };
        getAppStore?.()?.setActiveTarget(target);
        void bridge.refreshMessageView(target);
    };

    const onMessageDeleted = (messageId: unknown) => {
        if (typeof messageId !== 'number' || messageId < 0) {
            return;
        }
        orchestrator.barrierCoordinator.abortFromMessage(messageId, 'Message deleted');
        orchestrator.store.pruneFromMessage(messageId);
        orchestrator.vfs.clearPreCreateBuffersFrom(messageId);
        const prevInterrupted = orchestrator.trajectoryStore.listInterruptedCheckpoints().size;
        const removedCheckpoints = orchestrator.trajectoryStore.pruneFromMessage(messageId);
        if (
            removedCheckpoints > 0
            || orchestrator.trajectoryStore.listInterruptedCheckpoints().size !== prevInterrupted
        ) {
            orchestrator.trajectoryStore.saveToHost(bridge);
        }
    };

    const onMessageSwipeDeleted = (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        const raw = payload as { messageId?: unknown; swipeId?: unknown };
        if (typeof raw.messageId === 'number' && typeof raw.swipeId === 'number') {
            const target: MessageTarget = { messageId: raw.messageId, swipeId: raw.swipeId };
            orchestrator.barrierCoordinator.abortTarget(target, 'Swipe deleted');
            orchestrator.store.pruneSwipe(target);
            const prevInterrupted = orchestrator.trajectoryStore.listInterruptedCheckpoints().size;
            const removedCheckpoints = orchestrator.trajectoryStore.pruneSwipe(target);
            if (
                removedCheckpoints > 0
                || orchestrator.trajectoryStore.listInterruptedCheckpoints().size !== prevInterrupted
            ) {
                orchestrator.trajectoryStore.saveToHost(bridge);
            }
        }
    };

    const onChatChanged = () => {
        onGenerationStopped();
        orchestrator.vfs.clearPreCreateBuffersFrom(0);
    };

    const registrations: Array<[string, (...args: unknown[]) => unknown]> = [
        [event_types.GENERATION_AFTER_COMMANDS, onGenerationAfterCommands],
        [event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded],
        [event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered],
        [event_types.GENERATION_STOPPED, onGenerationStopped],
        [event_types.GENERATION_ENDED, onGenerationEnded],
        [event_types.MESSAGE_SWIPED, onMessageSwiped],
        [event_types.MESSAGE_DELETED, onMessageDeleted],
        [event_types.MESSAGE_SWIPE_DELETED, onMessageSwipeDeleted],
        [event_types.CHAT_CHANGED, onChatChanged],
    ];

    for (const [eventName, handler] of registrations) {
        if (eventName) {
            eventSource.on(eventName, handler);
        }
    }

    return {
        resolveVfsFileSync,
        dispose() {
            clearCompanionPrompt();
            for (const [eventName, handler] of registrations) {
                if (eventName && typeof eventSource.removeListener === 'function') {
                    eventSource.removeListener(eventName, handler);
                }
            }
            try {
                unregisterFileMacro();
            } catch {
                // Ignore if MacroEngine does not expose unregister.
            }
        },
    };
}
