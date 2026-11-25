import type { HostBridge, LLMRequest } from '@/core/bridge';
import {
    DEFAULT_MAIN_AGENT_ID,
    createDefaultPromptBlocks,
    matchesPromptTriggers,
} from '@/core/config';
import {
    buildCoreManifest,
    classifyEntry,
    type CoreManifestResult,
    type TailRadar,
} from '@/core/lore';
import {
    RegexPipeline,
    applyRegexRules,
    type RegexSender,
} from '@/core/regex';
import type {
    AgentProfile,
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalToolSchema,
    ChatMessageSnapshot,
    ClassifiedLoreEntry,
    MessageTarget,
    PromptBlock,
    PromptTriggerContext,
    RadarScanResult,
    RawLoreEntry,
    RegexRule,
    SideClueDoc,
    SideClueRadarScanResult,
    WICategory,
} from '@/core/types';
import { canonicalClone, stripJsonSchemaMeta } from '@/core/utils';
import { prerenderPromptBlocks, renderPromptBlockSync } from './prompt-block-renderer';
import { TrajectoryStore } from './trajectory-store';
import { estimateRequestTokens, groupLayer1Turns } from './watermark-compactor';

export interface StaticPrefixResult {
    tools: CanonicalToolSchema[];
    messages: CanonicalMessage[];
    layer0EndIndex: number;
    coreManifest: CoreManifestResult;
    systemRuleCount: number;
}

export interface ContextLayerStats {
    layer0MessageCount: number;
    layer1MessageCount: number;
    layer2MessageCount: number;
    floatingTailMessageCount: number;
    totalMessageCount: number;
    layer0EndIndex: number;
    layer1EndIndex: number;
    estimatedTokens: number;
}

export interface AssembledContext {
    request: LLMRequest;
    layer0Messages: CanonicalMessage[];
    layer1Messages: CanonicalMessage[];
    layer2Messages: CanonicalMessage[];
    floatingTailMessages: CanonicalMessage[];
    cacheBreakpoints: number[];
    coreManifest: CoreManifestResult;
    systemRuleCount: number;
    stats: ContextLayerStats;
    /** Paths of unconsumed `next_turn_brief` `/side/*` clues surfaced into Layer 2 `<side-brief>`. */
    consumedSideBriefPaths: string[];
    /** Side-clue radar scan result when `TailRadar.scanSideClues` ran or was provided. */
    sideHintResult?: SideClueRadarScanResult;
}

export interface SideClueProvider {
    listSideClues(target?: MessageTarget): Promise<SideClueDoc[]>;
}

export type RegexSource = RegexPipeline | readonly RegexRule[];

export interface ContextAssembleInput {
    agent: AgentProfile;
    connectionId?: string;
    tools?: readonly CanonicalToolSchema[];

    // Layer 0 inputs
    characterFields?: Record<string, string>;
    personaDescription?: string;
    loreEntries?: readonly (RawLoreEntry | ClassifiedLoreEntry)[];
    wiRouterOverrides?: Record<string, WICategory>;
    presetFiles?: Record<string, string>;
    hollowThreshold?: number;
    systemBasePrompt?: string;
    promptTriggerContext?: PromptTriggerContext;
    forceRecompilePrefix?: boolean;
    /** Optional pre-rendered prompt blocks (keyed by `PromptBlock.id`) from async EJS / custom JSON rendering. */
    preRenderedBlocks?: ReadonlyMap<string, CanonicalMessage[]>;

    // Layer 1 inputs
    trajectoryStore?: TrajectoryStore;
    /** Recent chat turns/messages used when `agent.sessionMode === 'ephemeral'`. */
    recentChatMessages?: readonly (CanonicalMessage | ChatMessageSnapshot)[];

    // Layer 2 inputs (new turn vs active in-flight continuation)
    userInput?: string | CanonicalContentPart[];
    userName?: string;
    turnBrief?: string;
    dynamicReminders?: readonly string[];
    /** Automatically evaluate Category ④ `dynamic_at_depth` lore entries into Layer 2 (default `true`). */
    includeCategory4DynamicEntries?: boolean;
    loreHint?: string | RadarScanResult;
    /** Parsed `/side/*` clue documents for Layer 2 `<side-brief>` and optional `TailRadar.scanSideClues`. */
    sideClues?: readonly SideClueDoc[];
    /** Pre-computed `<side-hint>` XML or `SideClueRadarScanResult` for Layer 2 dynamic tail. */
    sideHint?: string | SideClueRadarScanResult;
    /** Explicit `<side-brief>` override for Layer 2 dynamic tail. */
    sideBrief?: string;
    /** Progressive-disclosure workspace/instruction notices appended in Layer 2 tail. */
    workspaceNotice?: string;
    /** Optional `TailRadar` for synchronous `scanSideClues` when `sideClues` is passed and `sideHint` is omitted. */
    tailRadar?: TailRadar;
    /** Active turn messages during multi-step tool loop (bypasses regenerating Layer 2). */
    inFlightMessages?: readonly CanonicalMessage[];

    // Shared runtime services
    hostBridge?: HostBridge;
    regex?: RegexSource;
    vars?: Record<string, unknown>;
    macroOverrides?: Record<string, string>;
    signal?: AbortSignal;
}

export interface AssembleWithHostInput extends Omit<ContextAssembleInput, 'hostBridge'> {
    hostBridge: HostBridge;
    tailRadar?: TailRadar;
    /** Optional VFS / `SideMount` provider used to enumerate `/side/*` clues when `sideClues` is omitted. */
    vfs?: SideClueProvider;
    /** Target coordinates passed to `TailRadar.scan` and `vfs.listSideClues`. */
    target?: MessageTarget;
    /** Whether to automatically run `TailRadar` when `tailRadar` is provided and hints are omitted (default `true`). */
    runTailRadar?: boolean;
}

export interface FinalizeTurnInput {
    trajectoryStore: TrajectoryStore;
    agentId?: string;
    target: MessageTarget;
    /** Messages produced during the turn before the final assistant reply (Layer 2 + tool call/result chain). */
    turnMessages: readonly CanonicalMessage[];
    /** Final assistant reply for the turn (will run `ingest` regex once before freezing). */
    finalAssistantMessage?: CanonicalMessage;
    regex?: RegexSource;
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

/**
 * Deterministically sort tool schemas by name and canonicalize parameter JSON Schemas
 * (stripping `$schema`/`$id` and sorting keys recursively) for KV Cache invariance.
 */
export function canonicalizeTools(
    tools: readonly CanonicalToolSchema[] = [],
): CanonicalToolSchema[] {
    const sorted = [...tools].sort((a, b) => compareCodeUnits(a.name, b.name));
    return sorted.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: stripJsonSchemaMeta(canonicalClone(tool.parameters ?? {})),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    }));
}

/** Apply `ingest`-stage regex rules once (never runs `display` or `lore_read` rules). */
export function applyIngestRegexText(
    text: string,
    sender: Extract<RegexSender, 'user' | 'assistant'>,
    regex?: RegexSource,
): string {
    if (!regex || !text) {
        return text;
    }
    if (regex instanceof RegexPipeline) {
        return regex.run(text, { stage: 'ingest', sender });
    }
    if (regex.length === 0) {
        return text;
    }
    return applyRegexRules(text, regex, { stage: 'ingest', sender });
}

/** Apply `ingest`-stage regex rules once to a `CanonicalMessage` before freezing into Layer 1. */
export function ingestCanonicalMessage(
    message: CanonicalMessage,
    regex?: RegexSource,
): CanonicalMessage {
    const cloned = canonicalClone(message);
    if (!regex || (cloned.role !== 'user' && cloned.role !== 'assistant')) {
        return cloned;
    }
    const sender: Extract<RegexSender, 'user' | 'assistant'> = cloned.role;

    if (typeof cloned.content === 'string') {
        cloned.content = applyIngestRegexText(cloned.content, sender, regex);
        return cloned;
    }

    cloned.content = cloned.content.map((part) => {
        if (part.type === 'text') {
            return {
                ...part,
                text: applyIngestRegexText(part.text, sender, regex),
            };
        }
        return part;
    });
    return cloned;
}

function isClassifiedLoreEntry(
    item: RawLoreEntry | ClassifiedLoreEntry,
): item is ClassifiedLoreEntry {
    return 'entry' in item && 'category' in item && 'vfsPath' in item;
}

function classifyAllEntries(
    entries: readonly (RawLoreEntry | ClassifiedLoreEntry)[] | undefined,
    overrides?: Record<string, WICategory>,
): ClassifiedLoreEntry[] {
    if (!entries || entries.length === 0) {
        return [];
    }
    const result: ClassifiedLoreEntry[] = [];
    for (const item of entries) {
        if (isClassifiedLoreEntry(item)) {
            if (overrides) {
                result.push(classifyEntry(item.entry, { overrides }));
            } else {
                result.push(item);
            }
        } else {
            result.push(classifyEntry(item, { overrides }));
        }
    }
    return result;
}

function isChatMessageSnapshot(
    msg: CanonicalMessage | ChatMessageSnapshot,
): msg is ChatMessageSnapshot {
    return 'mes' in msg && 'isUser' in msg;
}

function toCanonicalHistoryMessages(
    rawMessages: readonly (CanonicalMessage | ChatMessageSnapshot)[],
    regex?: RegexSource,
): CanonicalMessage[] {
    const out: CanonicalMessage[] = [];
    for (const item of rawMessages) {
        if (isChatMessageSnapshot(item)) {
            if (item.isSystem) {
                continue;
            }
            const role: 'user' | 'assistant' = item.isUser ? 'user' : 'assistant';
            const content = applyIngestRegexText(item.mes ?? '', role, regex);
            out.push({
                role,
                content,
                ...(item.name ? { name: item.name } : {}),
            });
        } else {
            out.push(canonicalClone(item));
        }
    }
    return out;
}

export function buildLayer2MacroOverrides(
    vars?: Record<string, unknown>,
    macroOverrides?: Record<string, string>,
): Record<string, string> | undefined {
    if (!vars && !macroOverrides) {
        return undefined;
    }
    const merged: Record<string, string> = {};
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            if (v === undefined || v === null) {
                merged[`var:${k}`] = '';
            } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                merged[`var:${k}`] = String(v);
            } else {
                merged[`var:${k}`] = JSON.stringify(v);
            }
        }
    }
    if (macroOverrides) {
        Object.assign(merged, macroOverrides);
    }
    return merged;
}

function substituteText(
    text: string,
    hostBridge?: HostBridge,
    overrides?: Record<string, string>,
): string {
    if (!text || !hostBridge) {
        return text;
    }
    return hostBridge.substituteMacros(text, overrides);
}

function wrapXmlIfNeeded(tag: string, body: string): string {
    const trimmed = body.trim();
    if (!trimmed) {
        return '';
    }
    if (trimmed.startsWith(`<${tag}>`) && trimmed.endsWith(`</${tag}>`)) {
        return trimmed;
    }
    return `<${tag}>\n${trimmed}\n</${tag}>`;
}

/**
 * Select unconsumed `delivery === 'next_turn_brief'` clues eligible for one-shot
 * Layer 2 `<side-brief>` injection, ordered deterministically by `order desc`, `path asc`.
 */
export function selectUnconsumedSideBriefClues(
    clues: readonly SideClueDoc[],
): SideClueDoc[] {
    return clues
        .filter(
            (clue) =>
                clue.meta.delivery === 'next_turn_brief'
                && clue.meta.status === 'dormant'
                && clue.meta.consumedByTurn === undefined,
        )
        .sort(
            (a, b) =>
                (b.meta.order ?? 0) - (a.meta.order ?? 0)
                || compareCodeUnits(a.path, b.path),
        );
}

/** Format unconsumed `next_turn_brief` `/side/*` clues into a compact `<side-brief>` XML block. */
export function formatSideBriefXml(clues: readonly SideClueDoc[]): string {
    if (clues.length === 0) {
        return '';
    }

    const lines: string[] = [
        '<side-brief>',
        '以下为上一阶段线外发生的事件简报（本轮一次性同步，如需完整记录可按需 read_file 查阅）：',
    ];

    for (const clue of clues) {
        const title = clue.meta.title?.trim() || clue.meta.id || clue.path;
        const summary = clue.meta.summary?.trim();
        const body = clue.body.trim();
        const detail = summary || body;
        if (detail) {
            lines.push(`- ${title} (${clue.path}): ${detail}`);
        } else {
            lines.push(`- ${title} (${clue.path})`);
        }
    }

    lines.push('</side-brief>');
    return lines.join('\n');
}

/**
 * Whether `placement: 'tail'` PromptBlocks should float after `inFlightMessages` alongside
 * `floating_tail` (matching Workbench/SideGen behavior) instead of staying inside Layer 2.
 */
export function shouldFloatTailPromptBlocks(
    context?: PromptTriggerContext,
): boolean {
    return context?.kind === 'trigger' || context?.kind === 'subagent';
}

/**
 * Three-layer KV-cache-friendly Context Assembler:
 * - **Layer 0 (Static Prefix)**: canonical sorted tools + decoupled multi-character/world-simulator
 *   system base + Category ① `system_rule` compiled block + `Core Manifest` + `prefix` `PromptBlock`s.
 * - **Layer 1 (Frozen Trajectory)**: immutable finalized turns (`persistent` via `TrajectoryStore`,
 *   or sliding `ephemeralWindowSize` recent turns for `ephemeral` agents).
 * - **Layer 2 (Tail-Only Dynamic Zone)**: current user input + `<turn-brief>` + Category ④ dynamic
 *   reminders + `<lore-hint>` + `tail` `PromptBlock`s.
 */
export class ContextAssembler {
    private readonly defaultSystemBase: string;

    constructor(options: { defaultSystemBase?: string } = {}) {
        this.defaultSystemBase = options.defaultSystemBase ?? createDefaultPromptBlocks()[0].content;
    }

    /**
     * Compile the deterministic Layer 0 static prefix (`tools` + `messages` + `layer0EndIndex`).
     */
    compileStaticPrefix(input: {
        agent: AgentProfile;
        tools?: readonly CanonicalToolSchema[];
        characterFields?: Record<string, string>;
        personaDescription?: string;
        classifiedLore?: readonly ClassifiedLoreEntry[];
        presetFiles?: Record<string, string>;
        hollowThreshold?: number;
        systemBasePrompt?: string;
        promptTriggerContext?: PromptTriggerContext;
        preRenderedBlocks?: ReadonlyMap<string, CanonicalMessage[]>;
        hostBridge?: HostBridge;
    }): StaticPrefixResult {
        const canonicalTools = canonicalizeTools(input.tools);
        const promptBlocks = input.agent.promptBlocks ?? [];
        const layer0Messages: CanonicalMessage[] = [];

        // 1. Decoupled System Base (multi-character / world-simulator safe)
        const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
        if (input.systemBasePrompt !== undefined) {
            const resolvedBase = substituteText(input.systemBasePrompt, input.hostBridge).trim();
            if (resolvedBase) {
                const baseRole =
                    systemBaseBlock?.role && systemBaseBlock.role !== 'custom'
                        ? systemBaseBlock.role
                        : 'system';
                layer0Messages.push({
                    role: baseRole,
                    content: resolvedBase,
                });
            }
        } else if (systemBaseBlock) {
            if (
                systemBaseBlock.enabled
                && matchesPromptTriggers(systemBaseBlock.triggers, input.promptTriggerContext)
            ) {
                if (input.preRenderedBlocks?.has(systemBaseBlock.id)) {
                    for (const msg of input.preRenderedBlocks.get(systemBaseBlock.id) ?? []) {
                        layer0Messages.push(canonicalClone(msg));
                    }
                } else {
                    const rendered = renderPromptBlockSync(systemBaseBlock, {
                        hostBridge: input.hostBridge,
                        precedingMessages: layer0Messages,
                    });
                    layer0Messages.push(...rendered);
                }
            }
        } else {
            const resolvedBase = substituteText(this.defaultSystemBase, input.hostBridge).trim();
            if (resolvedBase) {
                layer0Messages.push({
                    role: 'system',
                    content: resolvedBase,
                });
            }
        }

        // 2. Category ① `system_rule` compiled block
        const classified = input.classifiedLore ?? [];
        const systemRules = classified
            .filter((item) => item.category === 'system_rule' && !item.entry.disable)
            .sort(
                (a, b) =>
                    b.entry.order - a.entry.order
                    || a.entry.depth - b.entry.depth
                    || compareCodeUnits(a.entry.world, b.entry.world)
                    || a.entry.uid - b.entry.uid,
            );

        const renderedRules: string[] = [];
        for (const item of systemRules) {
            const text = substituteText(item.cleanContent, input.hostBridge).trim();
            if (!text) {
                continue;
            }
            const title = item.entry.comment?.trim();
            renderedRules.push(title ? `### ${title}\n${text}` : text);
        }

        if (renderedRules.length > 0) {
            layer0Messages.push({
                role: 'system',
                content: `<system-rules>\n${renderedRules.join('\n\n')}\n</system-rules>`,
            });
        }

        // 3. Core Manifest (/character/* + Category ② core_manifest + hollow-card notice)
        const coreEntries = classified.filter(
            (item) => item.category === 'core_manifest' && !item.entry.disable,
        );
        const coreManifest = buildCoreManifest({
            characterFields: input.characterFields ?? {},
            coreEntries,
            personaDescription: input.personaDescription,
            hollowThreshold: input.hollowThreshold,
        });

        let manifestText = coreManifest.text;
        const presetFileNames = Object.keys(input.presetFiles ?? {})
            .map((name) => name.replace(/^\/+/, ''))
            .filter(Boolean)
            .sort(compareCodeUnits);
        if (presetFileNames.length > 0) {
            const presetLines = presetFileNames.map((name) => `- /preset/${name}`);
            manifestText = manifestText.replace(
                /<\/core-manifest>$/,
                `预设参考文档（/preset/*，按需调用 read_file 阅读）：\n${presetLines.join('\n')}\n</core-manifest>`,
            );
        }

        layer0Messages.push({
            role: 'system',
            content: manifestText,
        });

        // 4. Additional `prefix` PromptBlocks (preserving explicit order, role, and multi-message custom blocks)
        const prefixBlocks = promptBlocks.filter(
            (b: PromptBlock) =>
                b.enabled
                && b.placement === 'prefix'
                && b.id !== 'system_base'
                && b.content.trim().length > 0
                && matchesPromptTriggers(b.triggers, input.promptTriggerContext),
        );
        for (const block of prefixBlocks) {
            if (input.preRenderedBlocks?.has(block.id)) {
                for (const msg of input.preRenderedBlocks.get(block.id) ?? []) {
                    layer0Messages.push(canonicalClone(msg));
                }
            } else {
                const rendered = renderPromptBlockSync(block, {
                    hostBridge: input.hostBridge,
                    precedingMessages: layer0Messages,
                });
                layer0Messages.push(...rendered);
            }
        }

        return {
            tools: canonicalTools,
            messages: layer0Messages,
            layer0EndIndex: layer0Messages.length - 1,
            coreManifest,
            systemRuleCount: renderedRules.length,
        };
    }

    /**
     * Assemble a complete three-layer `LLMRequest` (and metadata) synchronously.
     */
    assemble(input: ContextAssembleInput): AssembledContext {
        const hostBridge = input.hostBridge;
        const characterFields = input.characterFields ?? hostBridge?.getCharacterFields() ?? {};
        const personaDescription = input.personaDescription ?? hostBridge?.getPersonaDescription() ?? '';
        const classified = classifyAllEntries(input.loreEntries, input.wiRouterOverrides);

        let layer0Messages: CanonicalMessage[];
        let tools: CanonicalToolSchema[];
        let layer0EndIndex: number;
        let coreManifest: CoreManifestResult;
        let systemRuleCount: number;

        const isPersistent = input.agent.sessionMode === 'persistent';
        const hasTriggerScopedBlocks = (input.agent.promptBlocks ?? []).some(
            (b) => b.triggers && b.triggers.length > 0,
        );
        const isNonMainTriggerRun =
            isPersistent
            && input.promptTriggerContext !== undefined
            && input.promptTriggerContext.kind !== 'main'
            && hasTriggerScopedBlocks;
        const existingFrozen =
            isPersistent && !input.forceRecompilePrefix && !isNonMainTriggerRun
                ? input.trajectoryStore?.getFrozenPrefix(input.agent.id) ?? null
                : null;

        if (existingFrozen) {
            tools = canonicalClone(existingFrozen.tools) as CanonicalToolSchema[];
            layer0Messages = canonicalClone(existingFrozen.messages) as CanonicalMessage[];
            layer0EndIndex = existingFrozen.layer0EndIndex;
            const coreEntries = classified.filter(
                (item) => item.category === 'core_manifest' && !item.entry.disable,
            );
            coreManifest = buildCoreManifest({
                characterFields,
                coreEntries,
                personaDescription,
                hollowThreshold: input.hollowThreshold,
            });
            systemRuleCount = classified.filter(
                (item) => item.category === 'system_rule' && !item.entry.disable,
            ).length;
        } else {
            const prefix = this.compileStaticPrefix({
                agent: input.agent,
                tools: input.tools,
                characterFields,
                personaDescription,
                classifiedLore: classified,
                presetFiles: input.presetFiles,
                hollowThreshold: input.hollowThreshold,
                systemBasePrompt: input.systemBasePrompt,
                promptTriggerContext: input.promptTriggerContext,
                preRenderedBlocks: input.preRenderedBlocks,
                hostBridge,
            });
            tools = prefix.tools;
            layer0Messages = prefix.messages;
            layer0EndIndex = prefix.layer0EndIndex;
            coreManifest = prefix.coreManifest;
            systemRuleCount = prefix.systemRuleCount;

            if (isPersistent && !isNonMainTriggerRun && input.trajectoryStore) {
                input.trajectoryStore.setFrozenPrefix(
                    {
                        tools,
                        messages: layer0Messages,
                        layer0EndIndex,
                    },
                    input.agent.id,
                );
            }
        }

        // Layer 1: Frozen trajectory (persistent) or sliding recent turns (ephemeral)
        let layer1Messages: CanonicalMessage[];
        if (isPersistent) {
            const stored = input.trajectoryStore?.getMessages(input.agent.id) ?? [];
            layer1Messages = stored.map((m) => canonicalClone(m));
        } else {
            const windowSize = Math.max(0, input.agent.ephemeralWindowSize ?? 6);
            if (windowSize === 0 || !input.recentChatMessages?.length) {
                layer1Messages = [];
            } else {
                const canonicalHistory = toCanonicalHistoryMessages(input.recentChatMessages, input.regex);
                const { turns } = groupLayer1Turns(canonicalHistory);
                layer1Messages = turns
                    .slice(-windowSize)
                    .flatMap((t) => t.messages.map((m) => canonicalClone(m)));
            }
        }

        // Layer 2: Tail-Only Dynamic Zone (or frozen in-flight messages during tool loop)
        let layer2Messages: CanonicalMessage[];
        let consumedSideBriefPaths: string[] = [];
        let sideHintResult: SideClueRadarScanResult | undefined;

        if (input.inFlightMessages !== undefined) {
            layer2Messages = input.inFlightMessages.map((m) => canonicalClone(m));
        } else {
            const briefClues = input.sideBrief === undefined && input.sideClues?.length
                ? selectUnconsumedSideBriefClues(input.sideClues)
                : [];
            consumedSideBriefPaths = briefClues.map((c) => c.path);
            const sideBriefXml = input.sideBrief !== undefined
                ? wrapXmlIfNeeded('side-brief', input.sideBrief)
                : formatSideBriefXml(briefClues);

            let sideHintXml = '';
            if (input.sideHint !== undefined) {
                if (typeof input.sideHint === 'string') {
                    sideHintXml = input.sideHint.trim();
                } else {
                    sideHintResult = input.sideHint;
                    sideHintXml = input.sideHint.hintXml.trim();
                }
            } else if (input.tailRadar && input.sideClues?.length) {
                const userText = extractUserTextForRadar(input.userInput);
                const recentTextHistory = extractRecentTexts(layer1Messages);
                if (userText || recentTextHistory.length > 0) {
                    const readSet = isPersistent
                        ? input.trajectoryStore?.getReadSet(input.agent.id)
                        : undefined;
                    sideHintResult = input.tailRadar.scanSideClues(input.sideClues, {
                        input: userText,
                        recentMessages: recentTextHistory,
                        readSet,
                        vars: input.vars,
                        macroOverrides: input.macroOverrides,
                    });
                    sideHintXml = sideHintResult.hintXml.trim();
                }
            }

            layer2Messages = this.buildLayer2Messages(input, classified, {
                sideBriefXml,
                sideHintXml,
            });
        }

        const floatingTailMessages = this.buildFloatingTailMessages(input, [
            ...layer0Messages,
            ...layer1Messages,
            ...layer2Messages,
        ]);

        const allMessages = [
            ...layer0Messages,
            ...layer1Messages,
            ...layer2Messages,
            ...floatingTailMessages,
        ];
        const layer1EndIndex = layer0Messages.length + layer1Messages.length - 1;

        const cacheBreakpoints = this.computeCacheBreakpoints({
            layer0Count: layer0Messages.length,
            layer0EndIndex,
            layer1Count: layer1Messages.length,
            layer1EndIndex,
            isPersistent,
            trajectoryStore: input.trajectoryStore,
            agentId: input.agent.id,
        });

        const request: LLMRequest = {
            connectionId: input.connectionId ?? input.agent.connectionId,
            messages: allMessages,
            tools,
            ...(cacheBreakpoints.length > 0 ? { cacheBreakpoints } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
        };

        const estimatedTokens = estimateRequestTokens(allMessages, tools);

        return {
            request,
            layer0Messages,
            layer1Messages,
            layer2Messages,
            floatingTailMessages,
            cacheBreakpoints,
            coreManifest,
            systemRuleCount,
            consumedSideBriefPaths,
            ...(sideHintResult !== undefined ? { sideHintResult } : {}),
            stats: {
                layer0MessageCount: layer0Messages.length,
                layer1MessageCount: layer1Messages.length,
                layer2MessageCount: layer2Messages.length,
                floatingTailMessageCount: floatingTailMessages.length,
                totalMessageCount: allMessages.length,
                layer0EndIndex,
                layer1EndIndex,
                estimatedTokens,
            },
        };
    }

    /**
     * Async convenience wrapper pulling lorebooks/character/persona from `HostBridge`,
     * optionally enumerating `/side/*` clues from `vfs`, and scanning Category ③ + `/side/*`
     * entries via `TailRadar` against `TrajectoryStore`'s `Read-Set`.
     */
    async assembleWithHost(input: AssembleWithHostInput): Promise<AssembledContext> {
        const { hostBridge, tailRadar, vfs, target, runTailRadar = true, ...rest } = input;

        let loreEntries = rest.loreEntries;
        if (!loreEntries) {
            const books = await hostBridge.listEnabledLorebooks();
            const raw: RawLoreEntry[] = [];
            for (const [world, entries] of books.entries()) {
                for (const entry of entries) {
                    raw.push(entry.world ? entry : { ...entry, world });
                }
            }
            loreEntries = raw;
        }

        let sideClues = rest.sideClues;
        if (sideClues === undefined && vfs) {
            sideClues = await vfs.listSideClues(target);
        }

        const userText = extractUserTextForRadar(rest.userInput);
        const readSet = rest.agent.sessionMode === 'persistent'
            ? rest.trajectoryStore?.getReadSet(rest.agent.id)
            : undefined;
        const recentTextHistory = extractRecentTexts(
            rest.agent.sessionMode === 'persistent'
                ? (rest.trajectoryStore?.getMessages(rest.agent.id) ?? [])
                : [],
        );

        let loreHint = rest.loreHint;
        const shouldScanLoreRadar =
            runTailRadar
            && loreHint === undefined
            && rest.inFlightMessages === undefined
            && tailRadar !== undefined;

        if (shouldScanLoreRadar && tailRadar && userText) {
            const classified = classifyAllEntries(loreEntries, rest.wiRouterOverrides);
            loreHint = await tailRadar.scan(classified, {
                input: userText,
                recentMessages: recentTextHistory,
                readSet,
                target,
                vars: rest.vars,
                macroOverrides: rest.macroOverrides,
            });
        }

        let sideHint = rest.sideHint;
        const shouldScanSideRadar =
            runTailRadar
            && sideHint === undefined
            && rest.inFlightMessages === undefined
            && tailRadar !== undefined
            && Boolean(sideClues && sideClues.length > 0);

        if (shouldScanSideRadar && tailRadar && sideClues && (userText || recentTextHistory.length > 0)) {
            sideHint = tailRadar.scanSideClues(sideClues, {
                input: userText,
                recentMessages: recentTextHistory,
                readSet,
                vars: rest.vars,
                macroOverrides: rest.macroOverrides,
            });
        }

        // Pre-render PromptBlocks asynchronously (EJS + custom JSON):
        // - `prefix` blocks ONLY when Layer 0 is not frozen (or forceRecompilePrefix) to preserve KV cache invariance
        // - `tail` blocks on every new turn (Layer 2 dynamic tail)
        const preRenderedBlocks = new Map<string, CanonicalMessage[]>(
            rest.preRenderedBlocks ? Array.from(rest.preRenderedBlocks.entries()) : [],
        );
        const promptBlocks = rest.agent.promptBlocks ?? [];
        const isPersistent = rest.agent.sessionMode === 'persistent';
        const hasTriggerScopedBlocks = promptBlocks.some(
            (b) => b.triggers && b.triggers.length > 0,
        );
        const isNonMainTriggerRun =
            isPersistent
            && rest.promptTriggerContext !== undefined
            && rest.promptTriggerContext.kind !== 'main'
            && hasTriggerScopedBlocks;
        const willUseFrozenPrefix =
            isPersistent
            && !rest.forceRecompilePrefix
            && !isNonMainTriggerRun
            && Boolean(rest.trajectoryStore?.getFrozenPrefix(rest.agent.id));

        if (!willUseFrozenPrefix) {
            const prefixBlocksToRender: PromptBlock[] = [];
            const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
            if (
                rest.systemBasePrompt === undefined
                && systemBaseBlock
                && systemBaseBlock.enabled
                && systemBaseBlock.content.trim().length > 0
                && matchesPromptTriggers(systemBaseBlock.triggers, rest.promptTriggerContext)
                && !preRenderedBlocks.has(systemBaseBlock.id)
            ) {
                prefixBlocksToRender.push(systemBaseBlock);
            }
            for (const block of promptBlocks) {
                if (
                    block.enabled
                    && block.placement === 'prefix'
                    && block.id !== 'system_base'
                    && block.content.trim().length > 0
                    && matchesPromptTriggers(block.triggers, rest.promptTriggerContext)
                    && !preRenderedBlocks.has(block.id)
                ) {
                    prefixBlocksToRender.push(block);
                }
            }
            if (prefixBlocksToRender.length > 0) {
                const renderedPrefix = await prerenderPromptBlocks(prefixBlocksToRender, {
                    hostBridge,
                    vars: rest.vars,
                });
                for (const [blockId, messages] of renderedPrefix.entries()) {
                    preRenderedBlocks.set(blockId, messages);
                }
            }
        }

        const floatTailBlocks = shouldFloatTailPromptBlocks(rest.promptTriggerContext);

        if (!floatTailBlocks && rest.inFlightMessages === undefined) {
            const tailBlocksToRender = promptBlocks.filter(
                (b: PromptBlock) =>
                    b.enabled
                    && b.placement === 'tail'
                    && b.content.trim().length > 0
                    && matchesPromptTriggers(b.triggers, rest.promptTriggerContext)
                    && !preRenderedBlocks.has(b.id),
            );
            if (tailBlocksToRender.length > 0) {
                const tailMacroOverrides = buildLayer2MacroOverrides(rest.vars, rest.macroOverrides);
                const renderedTail = await prerenderPromptBlocks(tailBlocksToRender, {
                    hostBridge,
                    macroOverrides: tailMacroOverrides,
                    vars: rest.vars,
                });
                for (const [blockId, messages] of renderedTail.entries()) {
                    preRenderedBlocks.set(blockId, messages);
                }
            }
        }

        const floatingBlocksToRender = promptBlocks.filter(
            (b: PromptBlock) =>
                b.enabled
                && (b.placement === 'floating_tail' || (floatTailBlocks && b.placement === 'tail'))
                && b.content.trim().length > 0
                && matchesPromptTriggers(b.triggers, rest.promptTriggerContext)
                && !preRenderedBlocks.has(b.id),
        );
        if (floatingBlocksToRender.length > 0) {
            const floatingMacroOverrides = buildLayer2MacroOverrides(rest.vars, rest.macroOverrides);
            const renderedFloating = await prerenderPromptBlocks(floatingBlocksToRender, {
                hostBridge,
                macroOverrides: floatingMacroOverrides,
                vars: rest.vars,
            });
            for (const [blockId, messages] of renderedFloating.entries()) {
                preRenderedBlocks.set(blockId, messages);
            }
        }

        return this.assemble({
            ...rest,
            loreEntries,
            loreHint,
            sideClues,
            sideHint,
            tailRadar: runTailRadar ? tailRadar : undefined,
            preRenderedBlocks,
            hostBridge,
        });
    }

    /**
     * Append a completed turn into `TrajectoryStore` (applying `ingest` regex ONCE to
     * `finalAssistantMessage` before freezing) and record the `(messageId, swipeId)` checkpoint.
     */
    finalizeTurn(input: FinalizeTurnInput): void {
        const agentId = input.agentId ?? DEFAULT_MAIN_AGENT_ID;
        const messagesToAppend: CanonicalMessage[] = input.turnMessages.map((m) => canonicalClone(m));

        if (input.finalAssistantMessage) {
            messagesToAppend.push(
                ingestCanonicalMessage(input.finalAssistantMessage, input.regex),
            );
        }

        input.trajectoryStore.appendTurn(messagesToAppend, agentId);
        input.trajectoryStore.recordCheckpoint(input.target, agentId);
    }

    private buildLayer2Messages(
        input: ContextAssembleInput,
        classified: readonly ClassifiedLoreEntry[],
        sideBlocks: { sideBriefXml?: string; sideHintXml?: string } = {},
    ): CanonicalMessage[] {
        const layer2Messages: CanonicalMessage[] = [];
        const macroOverrides = buildLayer2MacroOverrides(input.vars, input.macroOverrides);

        // 1. Dynamic reminders: Category ④ `dynamic_at_depth` + explicit `dynamicReminders`
        const reminderLines: string[] = [];
        if (input.includeCategory4DynamicEntries !== false) {
            const dynamicEntries = classified
                .filter(
                    (item) =>
                        item.category === 'dynamic_or_trigger'
                        && !item.entry.disable
                        && item.reason === 'dynamic_at_depth',
                )
                .sort(
                    (a, b) =>
                        b.entry.order - a.entry.order
                        || a.entry.depth - b.entry.depth
                        || compareCodeUnits(a.entry.world, b.entry.world)
                        || a.entry.uid - b.entry.uid,
                );
            for (const item of dynamicEntries) {
                const rendered = substituteText(item.cleanContent, input.hostBridge, macroOverrides).trim();
                if (rendered) {
                    reminderLines.push(rendered);
                }
            }
        }
        if (input.dynamicReminders) {
            for (const line of input.dynamicReminders) {
                const trimmed = line.trim();
                if (trimmed) {
                    reminderLines.push(trimmed);
                }
            }
        }

        const turnBriefXml = input.turnBrief ? wrapXmlIfNeeded('turn-brief', input.turnBrief) : '';
        const sideBriefXml = sideBlocks.sideBriefXml?.trim() ?? '';
        const workspaceNoticeXml = input.workspaceNotice?.trim() ?? '';
        const remindersXml = reminderLines.length > 0
            ? `<dynamic-reminders>\n${reminderLines.join('\n')}\n</dynamic-reminders>`
            : '';
        const loreHintXml = typeof input.loreHint === 'string'
            ? input.loreHint.trim()
            : (input.loreHint?.hintXml?.trim() ?? '');
        const sideHintXml = sideBlocks.sideHintXml?.trim() ?? '';

        const tailBlocks = [
            turnBriefXml,
            sideBriefXml,
            workspaceNoticeXml,
            remindersXml,
            loreHintXml,
            sideHintXml,
        ].filter((s) => s.length > 0);
        const tailSuffix = tailBlocks.join('\n\n');

        // 2. User input (ingested ONCE on entry) + tail blocks
        if (Array.isArray(input.userInput)) {
            const ingestedParts = input.userInput.map((part) => {
                if (part.type === 'text') {
                    return {
                        ...part,
                        text: applyIngestRegexText(part.text, 'user', input.regex),
                    };
                }
                return { ...part };
            });
            if (tailSuffix) {
                ingestedParts.push({ type: 'text', text: tailSuffix });
            }
            if (ingestedParts.length > 0) {
                layer2Messages.push({
                    role: 'user',
                    content: ingestedParts,
                    ...(input.userName ? { name: input.userName } : {}),
                });
            }
        } else {
            const rawText = input.userInput ?? '';
            const ingestedUser = rawText
                ? applyIngestRegexText(rawText, 'user', input.regex)
                : '';
            const sections = [ingestedUser, tailSuffix].filter((s) => s.length > 0);
            if (sections.length > 0) {
                layer2Messages.push({
                    role: 'user',
                    content: sections.join('\n\n'),
                    ...(input.userName ? { name: input.userName } : {}),
                });
            }
        }

        // 3. Enabled `tail` PromptBlocks (supporting multi-message custom blocks & async pre-rendered EJS)
        if (!shouldFloatTailPromptBlocks(input.promptTriggerContext)) {
            layer2Messages.push(
                ...this.renderPlacementBlocks(['tail'], input, macroOverrides, layer2Messages),
            );
        }

        return layer2Messages;
    }

    private renderPlacementBlocks(
        placements: ReadonlyArray<'tail' | 'floating_tail'>,
        input: ContextAssembleInput,
        macroOverrides: Record<string, string> | undefined,
        precedingSeed: readonly CanonicalMessage[],
    ): CanonicalMessage[] {
        const blocks = (input.agent.promptBlocks ?? []).filter(
            (b: PromptBlock) =>
                b.enabled
                && placements.includes(b.placement as 'tail' | 'floating_tail')
                && b.content.trim().length > 0
                && matchesPromptTriggers(b.triggers, input.promptTriggerContext),
        );
        if (blocks.length === 0) {
            return [];
        }

        const out: CanonicalMessage[] = [];
        for (const block of blocks) {
            if (input.preRenderedBlocks?.has(block.id)) {
                for (const msg of input.preRenderedBlocks.get(block.id) ?? []) {
                    out.push(canonicalClone(msg));
                }
            } else {
                const rendered = renderPromptBlockSync(block, {
                    hostBridge: input.hostBridge,
                    macroOverrides,
                    precedingMessages: [...precedingSeed, ...out],
                });
                out.push(...rendered);
            }
        }
        return out;
    }

    private buildFloatingTailMessages(
        input: ContextAssembleInput,
        precedingMessages: readonly CanonicalMessage[],
    ): CanonicalMessage[] {
        const macroOverrides = buildLayer2MacroOverrides(input.vars, input.macroOverrides);
        const placements: ReadonlyArray<'tail' | 'floating_tail'> = shouldFloatTailPromptBlocks(
            input.promptTriggerContext,
        )
            ? ['tail', 'floating_tail']
            : ['floating_tail'];
        return this.renderPlacementBlocks(placements, input, macroOverrides, precedingMessages);
    }

    private computeCacheBreakpoints(params: {
        layer0Count: number;
        layer0EndIndex: number;
        layer1Count: number;
        layer1EndIndex: number;
        isPersistent: boolean;
        trajectoryStore?: TrajectoryStore;
        agentId: string;
    }): number[] {
        const points: number[] = [];
        const seen = new Set<number>();

        const pushPoint = (idx: number) => {
            if (idx >= 0 && !seen.has(idx)) {
                seen.add(idx);
                points.push(idx);
            }
        };

        pushPoint(params.layer0EndIndex);

        if (params.layer1Count > 0) {
            if (params.isPersistent && params.trajectoryStore) {
                for (const count of params.trajectoryStore.getTurnEndCounts(params.agentId)) {
                    const globalIdx = params.layer0Count + count - 1;
                    if (globalIdx > params.layer0EndIndex && globalIdx <= params.layer1EndIndex) {
                        pushPoint(globalIdx);
                    }
                }
            }
            if (params.layer1EndIndex > params.layer0EndIndex) {
                pushPoint(params.layer1EndIndex);
            }
        }

        return points;
    }
}

function extractUserTextForRadar(
    userInput: string | CanonicalContentPart[] | undefined,
): string {
    if (!userInput) {
        return '';
    }
    if (typeof userInput === 'string') {
        return userInput;
    }
    return userInput
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
}

function stripTailMetadataTags(text: string): string {
    return text
        .replace(/<turn-brief>[\s\S]*?<\/turn-brief>/g, '')
        .replace(/<side-brief>[\s\S]*?<\/side-brief>/g, '')
        .replace(/<dynamic-reminders>[\s\S]*?<\/dynamic-reminders>/g, '')
        .replace(/<lore-hint>[\s\S]*?<\/lore-hint>/g, '')
        .replace(/<side-hint>[\s\S]*?<\/side-hint>/g, '')
        .trim();
}

function extractRecentTexts(messages: readonly CanonicalMessage[]): string[] {
    const texts: string[] = [];
    for (const msg of messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            if (typeof msg.content === 'string') {
                const cleaned = stripTailMetadataTags(msg.content);
                if (cleaned) {
                    texts.push(cleaned);
                }
            } else {
                const text = stripTailMetadataTags(
                    msg.content
                        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                        .map((p) => p.text)
                        .join('\n'),
                );
                if (text) {
                    texts.push(text);
                }
            }
        }
    }
    return texts;
}
