import {
    chat,
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
import { formatSideBriefXml, selectUnconsumedSideBriefClues } from '@/core/context';
import { DecoratorParser, TailRadar } from '@/core/lore';
import {
    CHAT_VARIABLES_DOC_KEY,
    ChatDataStore,
    DATA_NAMESPACES,
    GLOBAL_VARIABLES_DOC_KEY,
    VARIABLES_DOC_KEY,
    worldInfoKey,
} from '@/core/store';
import {
    groupTriggersForExecution,
    mergeDerivedAgentProfiles,
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
export const COMPANION_SIDE_BRIDGE_PROMPT_KEY = 'agentic_side_bridge';

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
    tailRadar?: TailRadar;
}

export interface CompanionHooksHandle {
    dispose(): void;
    resolveVfsFileSync(rawPath: string, target?: MessageTarget): string;
    clearSideBridgePrompt(): void;
    syncSideBridgePrompt(target?: MessageTarget): Promise<string>;
}

interface PendingCompanionTurn {
    target: MessageTarget;
    controller: AbortController;
    pendingSideBriefPaths?: string[];
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

        if (normalized === '/state/chat_variables.json' || rel === 'vars/chat') {
            const staged = store
                .listPending(target)
                .find((item) => item.ns === DATA_NAMESPACES.VARIABLES && item.key === CHAT_VARIABLES_DOC_KEY);
            if (staged) {
                return staged.entry.deleted ? '{}' : staged.entry.content;
            }
            return JSON.stringify(bridge.readChatVariables(), null, 2);
        }

        if (normalized === '/state/global_variables.json' || rel === 'vars/global') {
            const staged = store
                .listPending(target)
                .find((item) => item.ns === DATA_NAMESPACES.VARIABLES && item.key === GLOBAL_VARIABLES_DOC_KEY);
            if (staged) {
                return staged.entry.deleted ? '{}' : staged.entry.content;
            }
            return JSON.stringify(bridge.readGlobalVariables(), null, 2);
        }

        if (
            normalized === '/state/variables.json'
            || rel === 'vars'
            || rel.startsWith('vars/')
        ) {
            const varsEntry =
                store.getPending(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target }) ??
                store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target });
            if (!varsEntry?.content) {
                return '';
            }
            const subKey =
                normalized === '/state/variables.json' || rel === 'vars'
                    ? ''
                    : rel.slice('vars/'.length);
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

        if (rel.startsWith('side/')) {
            const key = rel.slice('side/'.length);
            if (!key) {
                return '';
            }
            const entry =
                store.getPending(DATA_NAMESPACES.SIDE_FILES, key, { target })
                ?? store.get(DATA_NAMESPACES.SIDE_FILES, key, { target })
                ?? store.getPending(DATA_NAMESPACES.SIDE_FILES, `/${rel}`, { target })
                ?? store.get(DATA_NAMESPACES.SIDE_FILES, `/${rel}`, { target });
            return typeof entry?.content === 'string' ? entry.content : '';
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

function readPendingSendTextareaText(): string {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
        return '';
    }
    const textarea = document.querySelector('#send_textarea') as HTMLTextAreaElement | null;
    return typeof textarea?.value === 'string' ? textarea.value.trim() : '';
}

function buildScanTail(scanDepth = 8, pendingUserInput = ''): string {
    const segments = Array.isArray(chat)
        ? chat.slice(-Math.max(1, scanDepth)).map((msg) => {
              const m = msg as { name?: unknown; mes?: unknown };
              const speaker = typeof m.name === 'string' && m.name ? `${m.name}: ` : '';
              return `${speaker}${typeof m.mes === 'string' ? m.mes : ''}`;
          })
        : [];

    const trimmedPending = pendingUserInput.trim();
    if (trimmedPending) {
        const lastMes =
            Array.isArray(chat) && chat.length > 0
                ? (chat[chat.length - 1] as { mes?: unknown } | undefined)?.mes
                : undefined;
        if (typeof lastMes !== 'string' || lastMes.trim() !== trimmedPending) {
            segments.push(trimmedPending);
        }
    }

    return segments.join('\n\n');
}

async function runCompanionBeforeTurnUnits(
    orchestrator: PipelineOrchestrator,
    bridge: STHostBridge,
    settings: Settings,
    target: MessageTarget,
    signal: AbortSignal,
    pendingUserInput = '',
): Promise<string> {
    const scanText = buildScanTail(8, pendingUserInput);
    const turnNumber = target.messageId + 1;

    if (typeof orchestrator.runBeforeTurn === 'function') {
        const result = await orchestrator.runBeforeTurn({
            target,
            userText: scanText,
            turnNumber,
            signal,
        });
        return result.brief;
    }

    const lorebooks = await bridge.listEnabledLorebooks();
    const preset = resolveActivePreset(settings);
    const compiled = orchestrator.decoratorCompiler.compile(lorebooks, { preset });
    const beforeRules = compiled.triggers.filter(
        (rule) => rule.phase === 'before_turn' && rule.enabled,
    );

    if (beforeRules.length === 0) {
        return '';
    }

    const sortedRules = beforeRules
        .map((rule, idx) => ({ rule, idx }))
        .sort((a, b) => a.rule.order - b.rule.order || a.idx - b.idx);
    const ruleBatches: TriggerRule[][] = [];
    let currentOrder: number | undefined;
    let currentBatch: TriggerRule[] = [];
    for (const { rule } of sortedRules) {
        if (currentOrder === undefined || rule.order !== currentOrder) {
            if (currentBatch.length > 0) {
                ruleBatches.push(currentBatch);
            }
            currentOrder = rule.order;
            currentBatch = [rule];
        } else {
            currentBatch.push(rule);
        }
    }
    if (currentBatch.length > 0) {
        ruleBatches.push(currentBatch);
    }

    const briefFragments: string[] = [];

    const executeRule = async (
        rule: TriggerRule,
        matchOverrides?: Record<string, string>,
        overrideAgentProfile?: typeof preset.agents[string],
    ): Promise<void> => {
        if (signal.aborted) {
            return;
        }
        const substitutedPrompt = bridge.substituteMacros(
            rule.instructionTemplate,
            matchOverrides,
        );
        if (!substitutedPrompt.trim()) {
            return;
        }

        if (rule.kind === 'agent' && rule.agentProfileId) {
            const agentProfile =
                preset?.agents?.[rule.agentProfileId]
                ?? overrideAgentProfile
                ?? compiled.derivedAgentsByRuleId?.[rule.id]
                ?? compiled.derivedAgents?.[rule.agentProfileId]
                ?? rule.agentProfileId;
            const result = await orchestrator.agentRunner.run({
                agent: agentProfile,
                userInput: substitutedPrompt,
                target,
                phase: 'before_turn',
                promptTriggerContext: {
                    kind: 'trigger',
                    phase: 'before_turn',
                    triggerIds: [rule.id],
                    ...(rule.decorator ? { decorators: [rule.decorator] } : {}),
                    ...(rule.targetPath ? { targetPaths: [rule.targetPath] } : {}),
                },
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

    for (const ruleBatch of ruleBatches) {
        if (signal.aborted) {
            break;
        }
        const matchedRules: TriggerRule[] = [];
        const matchOverridesByRuleId = new Map<string, Record<string, string>>();
        for (const rule of ruleBatch) {
            if (signal.aborted) {
                break;
            }
            const evaluation = await orchestrator.evaluateCondition(rule, {
                target,
                turnNumber,
                scanText,
                signal,
                staged: true,
            });
            if (evaluation.matched) {
                matchedRules.push(rule);
                if (evaluation.matchOverrides) {
                    matchOverridesByRuleId.set(rule.id, evaluation.matchOverrides);
                }
            }
        }
        if (matchedRules.length === 0 || signal.aborted) {
            continue;
        }

        const units: TriggerExecutionUnit[] = groupTriggersForExecution(matchedRules);
        for (const unit of units) {
            if (signal.aborted) {
                break;
            }
            const derivedProfiles = unit.triggers
                .map((r) => compiled.derivedAgentsByRuleId?.[r.id])
                .filter((p): p is NonNullable<typeof p> => Boolean(p));
            let mergedDerived = derivedProfiles[0];
            for (let i = 1; i < derivedProfiles.length; i += 1) {
                mergedDerived = mergeDerivedAgentProfiles(mergedDerived, derivedProfiles[i], unit.groupName);
            }

            if (unit.isGrouped && unit.triggers.length > 1) {
                await Promise.all(
                    unit.triggers.map((rule) =>
                        executeRule(rule, matchOverridesByRuleId.get(rule.id), mergedDerived),
                    ),
                );
            } else {
                for (const rule of unit.triggers) {
                    await executeRule(rule, matchOverridesByRuleId.get(rule.id), mergedDerived);
                }
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

function collectRecentChatTexts(
    limit = 8,
    options?: { pendingInput?: string; includePendingTextarea?: boolean },
): { input: string; recentMessages: string[] } {
    const maxItems = Math.max(1, limit);
    const texts = Array.isArray(chat)
        ? chat
              .slice(-maxItems)
              .map((msg) => {
                  const m = msg as { mes?: unknown };
                  return typeof m?.mes === 'string' ? m.mes.trim() : '';
              })
              .filter(Boolean)
        : [];

    const pendingText = (
        options?.pendingInput
        ?? (options?.includePendingTextarea ? readPendingSendTextareaText() : '')
    ).trim();
    if (pendingText && texts[texts.length - 1] !== pendingText) {
        texts.push(pendingText);
    }

    const bounded = texts.slice(-maxItems);
    if (bounded.length === 0) {
        return { input: '', recentMessages: [] };
    }
    return {
        input: bounded[bounded.length - 1] ?? '',
        recentMessages: bounded.slice(0, -1),
    };
}

async function buildCompanionSideBridgeContent(
    orchestrator: PipelineOrchestrator,
    radar: TailRadar,
    target: MessageTarget,
    options?: { pendingInput?: string; includePendingTextarea?: boolean },
): Promise<{ content: string; briefPaths: string[] }> {
    const clues = await orchestrator.vfs.listSideClues({ target });
    if (clues.length === 0) {
        return { content: '', briefPaths: [] };
    }

    const briefClues = selectUnconsumedSideBriefClues(clues);
    const briefXml = formatSideBriefXml(briefClues);

    const { input, recentMessages } = collectRecentChatTexts(8, options);
    const scanResult = input || recentMessages.length > 0
        ? radar.scanSideClues(clues, { input, recentMessages })
        : undefined;
    const hintXml = scanResult?.hintXml?.trim() ?? '';

    const parts = [briefXml.trim(), hintXml].filter(Boolean);
    return {
        content: parts.join('\n\n'),
        briefPaths: briefClues.map((clue) => clue.path),
    };
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
    const sideTailRadar = options.tailRadar ?? TailRadar.fromBridge(bridge);

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

    const clearSideBridgePrompt = () => {
        if (typeof setExtensionPrompt === 'function') {
            setExtensionPrompt(
                COMPANION_SIDE_BRIDGE_PROMPT_KEY,
                '',
                extension_prompt_types?.IN_CHAT ?? 1,
                0,
                false,
                extension_prompt_roles?.SYSTEM ?? 0,
            );
        }
    };

    const syncSideBridgePrompt = async (targetOverride?: MessageTarget): Promise<string> => {
        const settings = getSettings();
        if (!settings || settings.runMode !== 'companion') {
            clearSideBridgePrompt();
            return '';
        }

        const target = targetOverride ?? getLatestMessageTarget();
        const sideBridge = await buildCompanionSideBridgeContent(orchestrator, sideTailRadar, target);
        if (typeof setExtensionPrompt === 'function') {
            setExtensionPrompt(
                COMPANION_SIDE_BRIDGE_PROMPT_KEY,
                sideBridge.content,
                extension_prompt_types?.IN_CHAT ?? 1,
                0,
                false,
                extension_prompt_roles?.SYSTEM ?? 0,
            );
        }
        return sideBridge.content;
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
            clearSideBridgePrompt();
            return;
        }

        if (genType === 'quiet') {
            return;
        }

        pendingCompanionTurn?.controller.abort('Superseded by new generation');
        const controller = new AbortController();
        const target = resolveUpcomingTarget(genType);
        const pendingUserInput = genType === 'normal' ? readPendingSendTextareaText() : '';
        pendingCompanionTurn = { target, controller };

        try {
            await orchestrator.barrierCoordinator.awaitTurnBarriers({
                signal: controller.signal,
            });
            if (controller.signal.aborted) {
                return;
            }

            const [briefText, sideBridge] = await Promise.all([
                runCompanionBeforeTurnUnits(
                    orchestrator,
                    bridge,
                    settings,
                    target,
                    controller.signal,
                    pendingUserInput,
                ),
                buildCompanionSideBridgeContent(orchestrator, sideTailRadar, target, {
                    pendingInput: pendingUserInput,
                }),
            ]);
            if (controller.signal.aborted) {
                return;
            }

            if (pendingCompanionTurn?.controller === controller) {
                pendingCompanionTurn.pendingSideBriefPaths = sideBridge.briefPaths;
            }

            if (typeof setExtensionPrompt === 'function') {
                setExtensionPrompt(
                    COMPANION_PROMPT_KEY,
                    briefText,
                    extension_prompt_types?.IN_CHAT ?? 1,
                    0,
                    Boolean(briefText),
                    extension_prompt_roles?.SYSTEM ?? 0,
                );
                setExtensionPrompt(
                    COMPANION_SIDE_BRIDGE_PROMPT_KEY,
                    sideBridge.content,
                    extension_prompt_types?.IN_CHAT ?? 1,
                    0,
                    false,
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
            clearSideBridgePrompt();
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

    const onCharacterMessageRendered = async (messageId: unknown, renderType?: unknown) => {
        clearCompanionPrompt();
        clearSideBridgePrompt();

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

        let briefPathsToConsume: string[] = [];
        if (pendingCompanionTurn?.target.messageId === messageId) {
            briefPathsToConsume = pendingCompanionTurn.pendingSideBriefPaths ?? [];
            pendingCompanionTurn = null;
        }

        if (briefPathsToConsume.length > 0) {
            await orchestrator.vfs.markSideCluesConsumed(briefPathsToConsume, messageId + 1, {
                target,
            });
        }

        await orchestrator.store.commitStagedData(target);

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

        const normalizedRenderType =
            typeof renderType === 'string' ? renderType.trim().toLowerCase() : '';
        const isFirstFloorOnly =
            normalizedRenderType === 'first_message'
            || (messageId === 0 && (!Array.isArray(chat) || chat.length <= 1));
        if (isFirstFloorOnly) {
            return;
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
        clearSideBridgePrompt();
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

    // Proactively clear companion & `/side/*` prompts whenever runMode flips to `off` (or leaves `companion`).
    let lastObservedRunMode = getSettings()?.runMode;
    if (!lastObservedRunMode || lastObservedRunMode === 'off') {
        clearSideBridgePrompt();
    }
    const appStore = getAppStore?.();
    const unsubscribeAppStore =
        appStore && typeof appStore.subscribe === 'function'
            ? appStore.subscribe(() => {
                  const nextRunMode = getSettings()?.runMode ?? appStore.getSnapshot()?.settings?.runMode;
                  if (nextRunMode !== lastObservedRunMode) {
                      lastObservedRunMode = nextRunMode;
                      if (nextRunMode !== 'companion') {
                          clearCompanionPrompt();
                          clearSideBridgePrompt();
                      }
                  }
              })
            : undefined;

    return {
        resolveVfsFileSync,
        clearSideBridgePrompt,
        syncSideBridgePrompt,
        dispose() {
            clearCompanionPrompt();
            clearSideBridgePrompt();
            unsubscribeAppStore?.();
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
