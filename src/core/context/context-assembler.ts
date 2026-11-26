import type { HostBridge, LLMRequest, PromptInjectionSession } from '@/core/bridge';
import {
    DEFAULT_MAIN_AGENT_ID,
    createDefaultPromptBlocks,
    matchesPromptTriggers,
} from '@/core/config';
import {
    DecoratorParser,
    LoreReadEvaluator,
    WORLD_INFO_POSITION,
    buildCoreManifest,
    classifyEntry,
    evaluateIfConditions,
    extractIfConditions,
    hasPrivateDecorator,
    isEjsEntryEnabled,
    isEjsForceDisabledEntry,
    isEjsGenerateBeforeEntry,
    isEjsSpecialEntry,
    matchLoreEntryKeywords,
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
    CanonicalToolCall,
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
import {
    LocalPromptInjectionSession,
    applyOutletsToCanonicalMessages,
    computeInjectionDigest,
    extractReferencedInjectKeys,
    extractReferencedOutletKeys,
} from './prompt-injection-session';
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
    /** Pre-rendered PromptBlocks produced during `assembleWithHost()` for reuse on in-flight tool rounds. */
    preRenderedBlocks?: ReadonlyMap<string, CanonicalMessage[]>;
    /** Pre-rendered Category ① `system_rule` strings produced during `assembleWithHost()`. */
    preRenderedSystemRules?: readonly string[];
    /** Effective macro overrides (including turn-scoped `outlet:*` entries) produced during `assembleWithHost()`. */
    effectiveMacroOverrides?: Record<string, string>;
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
    /** Optional pre-rendered Category ① `system_rule` strings (with EJS + outlets evaluated). */
    preRenderedSystemRules?: readonly string[];
    /** Optional pre-rendered Layer 2 dynamic lore reminder lines (with `@@if` + EJS + outlets evaluated). */
    preRenderedDynamicReminders?: readonly string[];
    /** Optional Layer 0 dynamic dependency fingerprint for `prefix` `getPromptsInjected` / `{{outlet::...}}`. */
    prefixFingerprint?: string;

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
    /** Optional isolated `PromptInjectionSession` shared with `before_turn` triggers. */
    injectionSession?: PromptInjectionSession;
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

const OUTPUT_FILE_CONTENT_TOOLS = new Set(['write_file', 'append_file']);
const OUTPUT_VIEW_TEXT_TOOLS = new Set(['append_reply_view', 'replace_reply_view']);

function normalizeSimplePath(rawPath: string): string {
    const parts = rawPath.trim().replace(/\\/g, '/').split('/');
    const stack: string[] = [];
    for (const part of parts) {
        if (!part || part === '.') {
            continue;
        }
        if (part === '..') {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    return `/${stack.join('/')}`;
}

function isOutputMarkdownPath(rawPath: unknown): boolean {
    return typeof rawPath === 'string' && normalizeSimplePath(rawPath) === '/output.md';
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Apply `ingest`-stage regex rules once to `/output.md` (and reply view) tool-call
 * payloads before freezing `turnMessages` into Layer 1. Returns `tc` untouched if
 * nothing changed so argument JSON is never re-serialized unnecessarily.
 */
function ingestOutputToolCall(
    tc: CanonicalToolCall,
    regex: RegexSource,
): CanonicalToolCall {
    const isFileContentTool = OUTPUT_FILE_CONTENT_TOOLS.has(tc.name);
    const isEditTool = tc.name === 'edit_file';
    const isViewTool = OUTPUT_VIEW_TEXT_TOOLS.has(tc.name);

    if (!isFileContentTool && !isEditTool && !isViewTool) {
        return tc;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(tc.arguments);
    } catch {
        return tc;
    }
    if (!isPlainJsonObject(parsed)) {
        return tc;
    }

    let changed = false;
    const cleanStringField = (obj: Record<string, unknown>, key: string): void => {
        const prev = obj[key];
        if (typeof prev !== 'string' || prev.length === 0) {
            return;
        }
        const cleaned = applyIngestRegexText(prev, 'assistant', regex);
        if (cleaned !== prev) {
            obj[key] = cleaned;
            changed = true;
        }
    };

    if (isFileContentTool) {
        if (!isOutputMarkdownPath(parsed.path)) {
            return tc;
        }
        cleanStringField(parsed, 'content');
    } else if (isEditTool) {
        if (!isOutputMarkdownPath(parsed.path)) {
            return tc;
        }
        cleanStringField(parsed, 'search');
        cleanStringField(parsed, 'replace');
        if (Array.isArray(parsed.edits)) {
            for (const op of parsed.edits) {
                if (isPlainJsonObject(op)) {
                    cleanStringField(op, 'search');
                    cleanStringField(op, 'replace');
                }
            }
        }
    } else if (isViewTool) {
        cleanStringField(parsed, 'text');
    }

    if (!changed) {
        return tc;
    }

    return {
        ...tc,
        arguments: JSON.stringify(parsed),
    };
}

/**
 * Clone a `turnMessages` entry and apply `ingest` regex once to `/output.md` tool calls
 * on assistant tool-call messages (leaving user messages and tool results untouched).
 */
export function ingestTurnOutputMessage(
    message: CanonicalMessage,
    regex?: RegexSource,
): CanonicalMessage {
    const cloned = canonicalClone(message);
    if (!regex || cloned.role !== 'assistant' || !cloned.toolCalls?.length) {
        return cloned;
    }
    cloned.toolCalls = cloned.toolCalls.map((tc) => ingestOutputToolCall(tc, regex));
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

const PRECOLLECT_EXCLUDED_DECORATORS = new Set([
    '@@system',
    '@@trigger',
    '@@tool',
    '@@script',
    '@@group',
    '@@agent',
    '@@skill',
    '@@json_schema',
    '@@zod_schema',
    '@@preset',
    '@@batch_order',
    '@@replace',
    '@@replace_before',
    '@@replace_diff',
    '@@replace_diff_before',
    '@@replace_search',
    '@@replace_search_before',
    '@@variables_json',
    '@@variables_json_before',
    '@@variables_yaml',
    '@@variables_yaml_before',
    '@@variables_jsonpatch',
    '@@variables_jsonpatch_before',
    '@@evaluate_ejs',
    '@@evaluate_ejs_before',
    '@@replace_ejs',
    '@@replace_ejs_before',
    '@@append_output',
    '@@append_output_before',
    '@@append_output_ejs',
    '@@append_output_ejs_before',
    '@@replace_output',
    '@@replace_output_before',
    '@@replace_output_ejs',
    '@@replace_output_ejs_before',
]);

function extractMetadataVarsFallback(hostBridge?: HostBridge): Record<string, unknown> {
    const raw = hostBridge?.getMetadata()?.variables;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        return { ...(raw as Record<string, unknown>) };
    }
    return {};
}

function resolvePrefixDynamicDeps(blocks: readonly PromptBlock[]): {
    hasAnyDynamicDeps: boolean;
    injectKeys: string[];
    hasDynamicInjectKey: boolean;
    outletKeys: string[];
} {
    const injectKeys = new Set<string>();
    const outletKeys = new Set<string>();
    let hasDynamicInjectKey = false;

    for (const block of blocks) {
        const extracted = extractReferencedInjectKeys(block.content);
        for (const k of extracted.keys) {
            injectKeys.add(k);
        }
        if (extracted.hasDynamicKey) {
            hasDynamicInjectKey = true;
        }
        for (const oKey of extractReferencedOutletKeys(block.content)) {
            outletKeys.add(oKey);
        }
    }

    return {
        hasAnyDynamicDeps: injectKeys.size > 0 || hasDynamicInjectKey || outletKeys.size > 0,
        injectKeys: Array.from(injectKeys).sort(compareCodeUnits),
        hasDynamicInjectKey,
        outletKeys: Array.from(outletKeys).sort(compareCodeUnits),
    };
}

function computePrefixDynamicFingerprint(
    deps: ReturnType<typeof resolvePrefixDynamicDeps>,
    session: PromptInjectionSession,
    outletOverrides: Record<string, string>,
): string | undefined {
    if (!deps.hasAnyDynamicDeps) {
        return undefined;
    }
    const injectDigest =
        deps.injectKeys.length > 0 || deps.hasDynamicInjectKey
            ? computeInjectionDigest(session, deps.hasDynamicInjectKey ? 'all' : deps.injectKeys)
            : '';
    const outletParts = deps.outletKeys.map((k) => `${k}:${outletOverrides[`outlet:${k}`] ?? ''}`);
    return `${injectDigest}|${outletParts.join('\x02')}`;
}

/**
 * Whether `placement: 'tail'` PromptBlocks float transiently after `layer2Messages` /
 * `inFlightMessages` alongside `floating_tail` (unified across main, trigger, subagent,
 * Workbench, and SideGen so tool chains are sandwiched before Tail and never persisted into Layer 1).
 */
export function shouldFloatTailPromptBlocks(
    _context?: PromptTriggerContext,
): boolean {
    return true;
}

/**
 * Three-layer KV-cache-friendly Context Assembler:
 * - **Layer 0 (Static Prefix)**: canonical sorted tools + decoupled multi-character/world-simulator
 *   system base + Category ① `system_rule` compiled block + `Core Manifest` + `prefix` `PromptBlock`s.
 * - **Layer 1 (Frozen Trajectory)**: immutable finalized turns (`persistent` via `TrajectoryStore`,
 *   or sliding `ephemeralWindowSize` recent turns for `ephemeral` agents).
 * - **Layer 2 (Tail-Only Dynamic Zone)**: current user input + `<turn-brief>` + Category ④ dynamic
 *   reminders + `<lore-hint>` (plus transient `floatingTailMessages` for `tail` / `floating_tail`
 *   `PromptBlock`s appended after `inFlightMessages` without persisting into Layer 1).
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
        preRenderedSystemRules?: readonly string[];
        macroOverrides?: Record<string, string>;
        hostBridge?: HostBridge;
    }): StaticPrefixResult {
        const canonicalTools = canonicalizeTools(input.tools);
        const promptBlocks = input.agent.promptBlocks ?? [];
        const layer0Messages: CanonicalMessage[] = [];

        // 1. Decoupled System Base (multi-character / world-simulator safe)
        const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
        if (input.systemBasePrompt !== undefined) {
            const resolvedBase = substituteText(
                input.systemBasePrompt,
                input.hostBridge,
                input.macroOverrides,
            ).trim();
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
                        macroOverrides: input.macroOverrides,
                        precedingMessages: layer0Messages,
                    });
                    layer0Messages.push(...rendered);
                }
            }
        } else {
            const resolvedBase = substituteText(
                this.defaultSystemBase,
                input.hostBridge,
                input.macroOverrides,
            ).trim();
            if (resolvedBase) {
                layer0Messages.push({
                    role: 'system',
                    content: resolvedBase,
                });
            }
        }

        // 2. Category ① `system_rule` compiled block
        const classified = input.classifiedLore ?? [];
        const renderedRules: string[] = [];
        if (input.preRenderedSystemRules !== undefined) {
            for (const ruleText of input.preRenderedSystemRules) {
                const trimmed = ruleText.trim();
                if (trimmed) {
                    renderedRules.push(trimmed);
                }
            }
        } else {
            const systemRules = classified
                .filter((item) => item.category === 'system_rule' && !item.entry.disable)
                .sort(
                    (a, b) =>
                        b.entry.order - a.entry.order
                        || a.entry.depth - b.entry.depth
                        || compareCodeUnits(a.entry.world, b.entry.world)
                        || a.entry.uid - b.entry.uid,
                );

            for (const item of systemRules) {
                const text = substituteText(
                    item.cleanContent,
                    input.hostBridge,
                    input.macroOverrides,
                ).trim();
                if (!text) {
                    continue;
                }
                const title = item.entry.comment?.trim();
                renderedRules.push(title ? `### ${title}\n${text}` : text);
            }
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
                    macroOverrides: input.macroOverrides,
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
                preRenderedSystemRules: input.preRenderedSystemRules,
                macroOverrides: input.macroOverrides,
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
                        ...(input.prefixFingerprint !== undefined
                            ? { prefixFingerprint: input.prefixFingerprint }
                            : {}),
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
            ...(input.preRenderedBlocks ? { preRenderedBlocks: input.preRenderedBlocks } : {}),
            ...(input.preRenderedSystemRules !== undefined
                ? { preRenderedSystemRules: input.preRenderedSystemRules }
                : {}),
            ...(input.macroOverrides ? { effectiveMacroOverrides: input.macroOverrides } : {}),
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
        const {
            hostBridge,
            tailRadar,
            vfs,
            target,
            runTailRadar = true,
            injectionSession,
            ...rest
        } = input;

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

        const session: PromptInjectionSession =
            injectionSession
            ?? hostBridge.createPromptInjectionSession?.().session
            ?? new LocalPromptInjectionSession();

        const effectiveVars: Record<string, unknown> = {
            ...extractMetadataVarsFallback(hostBridge),
            ...(rest.vars ?? {}),
        };
        const invertEnabled = Boolean(hostBridge.getEjsFeatures?.()?.invertEnabled);
        const classified = classifyAllEntries(loreEntries, rest.wiRouterOverrides);
        const keywordHaystack = userText
            ? (recentTextHistory.length > 0 ? `${recentTextHistory.join('\n')}\n${userText}` : userText)
            : recentTextHistory.join('\n');

        // Step A: World Info `injectPrompt` pre-collection pass (e.g. @@generate_before / [GENERATE:BEFORE] / pure scripts)
        if (rest.inFlightMessages === undefined && loreEntries.length > 0) {
            const preCollectCandidates: Array<{
                entry: RawLoreEntry;
                decorators: ReturnType<typeof DecoratorParser.parseEntry>['decorators'];
                cleanContent: string;
            }> = [];

            for (const rawItem of loreEntries) {
                const entry = isClassifiedLoreEntry(rawItem) ? rawItem.entry : rawItem;
                const parsed = DecoratorParser.parseEntry(entry);
                if (parsed.decorators.some((d) => PRECOLLECT_EXCLUDED_DECORATORS.has(d.name))) {
                    continue;
                }
                if (isEjsForceDisabledEntry(parsed.decorators)) {
                    continue;
                }

                const isGenBefore = isEjsGenerateBeforeEntry(entry, parsed.decorators, parsed.cleanContent);
                const enabled = isEjsEntryEnabled(entry, parsed.decorators, { invertEnabled });
                if (!enabled) {
                    continue;
                }

                const isSpecial = isEjsSpecialEntry(entry, parsed.decorators);
                if (isSpecial && !isGenBefore) {
                    continue;
                }

                const isPreCollect =
                    isGenBefore
                    || (parsed.cleanContent.includes('<%') && parsed.cleanContent.includes('injectPrompt('))
                    || (classifyEntry(entry, { overrides: rest.wiRouterOverrides }).reason === 'pure_script');
                if (!isPreCollect) {
                    continue;
                }

                if (!entry.constant) {
                    if (!keywordHaystack || !Array.isArray(entry.keys) || entry.keys.length === 0) {
                        continue;
                    }
                    const matched = matchLoreEntryKeywords(entry, keywordHaystack, {
                        substituteMacros: (t, ov) => hostBridge.substituteMacros(t, ov),
                        macroOverrides: buildLayer2MacroOverrides(effectiveVars, rest.macroOverrides),
                    });
                    if (!matched) {
                        continue;
                    }
                }

                preCollectCandidates.push({
                    entry,
                    decorators: parsed.decorators,
                    cleanContent: parsed.cleanContent,
                });
            }

            preCollectCandidates.sort(
                (a, b) =>
                    b.entry.order - a.entry.order
                    || a.entry.depth - b.entry.depth
                    || compareCodeUnits(a.entry.world, b.entry.world)
                    || a.entry.uid - b.entry.uid,
            );

            const preCollectMacroOverrides = buildLayer2MacroOverrides(effectiveVars, rest.macroOverrides);
            for (const item of preCollectCandidates) {
                const ifConds = extractIfConditions(item.decorators);
                const passed = await evaluateIfConditions(ifConds, hostBridge, effectiveVars, {
                    injectionSession: session,
                });
                if (!passed) {
                    continue;
                }
                const substituted = hostBridge.substituteMacros(item.cleanContent, preCollectMacroOverrides);
                if (hostBridge.evaluateOptionalEjs && substituted.includes('<%')) {
                    try {
                        await hostBridge.evaluateOptionalEjs(substituted, effectiveVars, {
                            injectionSession: session,
                            ...(hasPrivateDecorator(item.decorators) ? { isPrivate: true } : {}),
                        });
                    } catch {
                        // Non-fatal in pre-collection pass
                    }
                }
            }
        }

        // Step B: TailRadar scan (passing shared injectionSession so @@if & EJS inside Category ③ see pre-collected injections)
        let loreHint = rest.loreHint;
        const shouldScanLoreRadar =
            runTailRadar
            && loreHint === undefined
            && rest.inFlightMessages === undefined
            && tailRadar !== undefined;

        if (shouldScanLoreRadar && tailRadar && userText) {
            loreHint = await tailRadar.scan(classified, {
                input: userText,
                recentMessages: recentTextHistory,
                readSet,
                target,
                vars: rest.vars,
                macroOverrides: rest.macroOverrides,
                injectionSession: session,
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
        const existingFrozen =
            isPersistent
            && !rest.forceRecompilePrefix
            && !isNonMainTriggerRun
                ? rest.trajectoryStore?.getFrozenPrefix(rest.agent.id) ?? null
                : null;

        // Step C: Build ST native `{{outlet::key}}` table for this turn (using forceOutlet=true so nested getPromptsInjected supports forward refs)
        const outletMacroOverrides: Record<string, string> = {
            __has_outlet_table__: '1',
        };
        const outletEntries = classified
            .filter(
                (item) =>
                    !item.entry.disable
                    && item.entry.position === WORLD_INFO_POSITION.outlet
                    && Boolean(item.entry.outletName?.trim())
                    && !isEjsForceDisabledEntry(item.decorators),
            )
            .sort(
                (a, b) =>
                    b.entry.order - a.entry.order
                    || a.entry.depth - b.entry.depth
                    || compareCodeUnits(a.entry.world, b.entry.world)
                    || a.entry.uid - b.entry.uid,
            );

        if (outletEntries.length > 0) {
            const outletBuckets = new Map<string, string[]>();
            const outletEvaluator = new LoreReadEvaluator(hostBridge);
            const baseMacroOverrides = buildLayer2MacroOverrides(effectiveVars, rest.macroOverrides);

            session.setForceOutlet(true);
            try {
                for (const item of outletEntries) {
                    const outletName = item.entry.outletName?.trim();
                    if (!outletName) {
                        continue;
                    }
                    if (!item.entry.constant) {
                        if (!keywordHaystack || !Array.isArray(item.entry.keys) || item.entry.keys.length === 0) {
                            continue;
                        }
                        const matched = matchLoreEntryKeywords(item.entry, keywordHaystack, {
                            substituteMacros: (t, ov) => hostBridge.substituteMacros(t, ov),
                            macroOverrides: baseMacroOverrides,
                        });
                        if (!matched) {
                            continue;
                        }
                    }

                    const evaluated = await outletEvaluator.evaluate(item, {
                        target,
                        vars: effectiveVars,
                        macroOverrides: baseMacroOverrides,
                        injectionSession: session,
                    });
                    if (evaluated.conditionSkipped || !evaluated.text.trim()) {
                        continue;
                    }
                    const list = outletBuckets.get(outletName) ?? [];
                    list.push(evaluated.text.trim());
                    outletBuckets.set(outletName, list);
                }
            } finally {
                session.setForceOutlet(false);
            }

            for (const [key, parts] of outletBuckets.entries()) {
                outletMacroOverrides[`outlet:${key}`] = parts.join('\n');
            }
        }

        const combinedMacroOverrides: Record<string, string> = {
            ...(rest.macroOverrides ?? {}),
            ...outletMacroOverrides,
        };

        // Determine matching prefix blocks and check Layer 0 dynamic dirty fingerprint
        const matchingPrefixBlocks: PromptBlock[] = [];
        const systemBaseBlock = promptBlocks.find((b) => b.id === 'system_base');
        if (
            rest.systemBasePrompt === undefined
            && systemBaseBlock
            && systemBaseBlock.enabled
            && systemBaseBlock.content.trim().length > 0
            && matchesPromptTriggers(systemBaseBlock.triggers, rest.promptTriggerContext)
        ) {
            matchingPrefixBlocks.push(systemBaseBlock);
        }
        for (const block of promptBlocks) {
            if (
                block.enabled
                && block.placement === 'prefix'
                && block.id !== 'system_base'
                && block.content.trim().length > 0
                && matchesPromptTriggers(block.triggers, rest.promptTriggerContext)
            ) {
                matchingPrefixBlocks.push(block);
            }
        }

        const prefixDeps = resolvePrefixDynamicDeps(matchingPrefixBlocks);
        const initialPrefixFingerprint = computePrefixDynamicFingerprint(
            prefixDeps,
            session,
            outletMacroOverrides,
        );
        const dynamicPrefixChanged =
            Boolean(existingFrozen)
            && prefixDeps.hasAnyDynamicDeps
            && existingFrozen?.prefixFingerprint !== initialPrefixFingerprint;

        const effectiveForceRecompilePrefix = Boolean(rest.forceRecompilePrefix) || dynamicPrefixChanged;
        const willUseFrozenPrefix = Boolean(existingFrozen) && !effectiveForceRecompilePrefix;

        // Step D: Phase 1 — Render blocks & inline lore with forceOutlet=true
        const newlyRenderedPrefixIds: string[] = [];
        const newlyRenderedTailIds: string[] = [];
        const newlyRenderedFloatingIds: string[] = [];
        let preRenderedSystemRules: string[] | undefined = rest.preRenderedSystemRules
            ? [...rest.preRenderedSystemRules]
            : undefined;
        let preRenderedDynamicReminders: string[] | undefined = rest.preRenderedDynamicReminders
            ? [...rest.preRenderedDynamicReminders]
            : undefined;

        session.setForceOutlet(true);
        try {
            if (!willUseFrozenPrefix) {
                const prefixBlocksToRender = matchingPrefixBlocks.filter(
                    (block) => !preRenderedBlocks.has(block.id),
                );
                if (prefixBlocksToRender.length > 0) {
                    const renderedPrefix = await prerenderPromptBlocks(prefixBlocksToRender, {
                        hostBridge,
                        macroOverrides: combinedMacroOverrides,
                        vars: rest.vars,
                        injectionSession: session,
                    });
                    for (const [blockId, messages] of renderedPrefix.entries()) {
                        preRenderedBlocks.set(blockId, messages);
                        newlyRenderedPrefixIds.push(blockId);
                    }
                }

                if (preRenderedSystemRules === undefined) {
                    const systemRuleEntries = classified
                        .filter((item) => item.category === 'system_rule' && !item.entry.disable)
                        .sort(
                            (a, b) =>
                                b.entry.order - a.entry.order
                                || a.entry.depth - b.entry.depth
                                || compareCodeUnits(a.entry.world, b.entry.world)
                                || a.entry.uid - b.entry.uid,
                        );
                    const renderedRulesList: string[] = [];
                    for (const item of systemRuleEntries) {
                        const ifConds = extractIfConditions(item.decorators);
                        const passed = await evaluateIfConditions(ifConds, hostBridge, effectiveVars, {
                            injectionSession: session,
                        });
                        if (!passed) {
                            continue;
                        }
                        let text = substituteText(item.cleanContent, hostBridge, combinedMacroOverrides);
                        if (hostBridge.evaluateOptionalEjs && text.includes('<%')) {
                            try {
                                text = await hostBridge.evaluateOptionalEjs(text, effectiveVars, {
                                    injectionSession: session,
                                    ...(hasPrivateDecorator(item.decorators) ? { isPrivate: true } : {}),
                                });
                            } catch {
                                // Keep macro-substituted fallback text
                            }
                        }
                        const trimmed = text.trim();
                        if (!trimmed) {
                            continue;
                        }
                        const title = item.entry.comment?.trim();
                        renderedRulesList.push(title ? `### ${title}\n${trimmed}` : trimmed);
                    }
                    preRenderedSystemRules = renderedRulesList;
                }
            }

            const floatTailBlocks = shouldFloatTailPromptBlocks(rest.promptTriggerContext);
            const layer2MacroOverrides = buildLayer2MacroOverrides(rest.vars, combinedMacroOverrides);

            if (rest.inFlightMessages === undefined && rest.includeCategory4DynamicEntries !== false && preRenderedDynamicReminders === undefined) {
                const dynamicEntries = classified
                    .filter(
                        (item) =>
                            item.category === 'dynamic_or_trigger'
                            && !item.entry.disable
                            && (item.reason === 'dynamic_at_depth' || item.reason === 'conditional_dynamic'),
                    )
                    .sort(
                        (a, b) =>
                            b.entry.order - a.entry.order
                            || a.entry.depth - b.entry.depth
                            || compareCodeUnits(a.entry.world, b.entry.world)
                            || a.entry.uid - b.entry.uid,
                    );
                const renderedReminders: string[] = [];
                for (const item of dynamicEntries) {
                    const ifConds = extractIfConditions(item.decorators);
                    const passed = await evaluateIfConditions(ifConds, hostBridge, effectiveVars, {
                        injectionSession: session,
                    });
                    if (!passed) {
                        continue;
                    }
                    let text = substituteText(item.cleanContent, hostBridge, layer2MacroOverrides);
                    if (hostBridge.evaluateOptionalEjs && text.includes('<%')) {
                        try {
                            text = await hostBridge.evaluateOptionalEjs(text, effectiveVars, {
                                injectionSession: session,
                                ...(hasPrivateDecorator(item.decorators) ? { isPrivate: true } : {}),
                            });
                        } catch {
                            // Keep macro-substituted fallback text
                        }
                    }
                    const trimmed = text.trim();
                    if (trimmed) {
                        renderedReminders.push(trimmed);
                    }
                }
                preRenderedDynamicReminders = renderedReminders;
            }

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
                    const renderedTail = await prerenderPromptBlocks(tailBlocksToRender, {
                        hostBridge,
                        macroOverrides: layer2MacroOverrides,
                        vars: rest.vars,
                        injectionSession: session,
                    });
                    for (const [blockId, messages] of renderedTail.entries()) {
                        preRenderedBlocks.set(blockId, messages);
                        newlyRenderedTailIds.push(blockId);
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
                const renderedFloating = await prerenderPromptBlocks(floatingBlocksToRender, {
                    hostBridge,
                    macroOverrides: layer2MacroOverrides,
                    vars: rest.vars,
                    injectionSession: session,
                });
                for (const [blockId, messages] of renderedFloating.entries()) {
                    preRenderedBlocks.set(blockId, messages);
                    newlyRenderedFloatingIds.push(blockId);
                }
            }
        } finally {
            session.setForceOutlet(false);
        }

        // Step E: Phase 2 — Expand delayed {{outletPromptsInjected:...}} placeholders across all rendered parts
        for (const blockId of [...newlyRenderedPrefixIds, ...newlyRenderedTailIds, ...newlyRenderedFloatingIds]) {
            const msgs = preRenderedBlocks.get(blockId);
            if (msgs) {
                preRenderedBlocks.set(blockId, applyOutletsToCanonicalMessages(msgs, session));
            }
        }
        if (preRenderedSystemRules) {
            preRenderedSystemRules = preRenderedSystemRules
                .map((rule) => session.applyOutlets(rule).trim())
                .filter(Boolean);
        }
        if (preRenderedDynamicReminders) {
            preRenderedDynamicReminders = preRenderedDynamicReminders
                .map((line) => session.applyOutlets(line).trim())
                .filter(Boolean);
        }

        const finalPrefixFingerprint = computePrefixDynamicFingerprint(
            prefixDeps,
            session,
            outletMacroOverrides,
        );

        return this.assemble({
            ...rest,
            forceRecompilePrefix: effectiveForceRecompilePrefix,
            loreEntries,
            loreHint,
            sideClues,
            sideHint,
            tailRadar: runTailRadar ? tailRadar : undefined,
            preRenderedBlocks,
            ...(preRenderedSystemRules !== undefined ? { preRenderedSystemRules } : {}),
            ...(preRenderedDynamicReminders !== undefined ? { preRenderedDynamicReminders } : {}),
            ...(finalPrefixFingerprint !== undefined ? { prefixFingerprint: finalPrefixFingerprint } : {}),
            macroOverrides: combinedMacroOverrides,
            hostBridge,
        });
    }

    /**
     * Append a completed turn into `TrajectoryStore` (applying `ingest` regex ONCE to
     * `/output.md` tool-call payloads in `turnMessages` and `finalAssistantMessage`
     * before freezing) and record the `(messageId, swipeId)` checkpoint.
     */
    finalizeTurn(input: FinalizeTurnInput): void {
        const agentId = input.agentId ?? DEFAULT_MAIN_AGENT_ID;
        const messagesToAppend: CanonicalMessage[] = input.turnMessages.map((m) =>
            ingestTurnOutputMessage(m, input.regex),
        );

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

        // 1. Dynamic reminders: Category ④ `dynamic_at_depth` + `conditional_dynamic` + explicit `dynamicReminders`
        const reminderLines: string[] = [];
        if (input.includeCategory4DynamicEntries !== false) {
            if (input.preRenderedDynamicReminders !== undefined) {
                for (const line of input.preRenderedDynamicReminders) {
                    const trimmed = line.trim();
                    if (trimmed) {
                        reminderLines.push(trimmed);
                    }
                }
            } else {
                const dynamicEntries = classified
                    .filter(
                        (item) =>
                            item.category === 'dynamic_or_trigger'
                            && !item.entry.disable
                            && (item.reason === 'dynamic_at_depth' || item.reason === 'conditional_dynamic'),
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
