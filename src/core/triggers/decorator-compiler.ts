import { extractSubAgentDescriptors, type SubAgentDescriptor } from '@/core/agents';
import { buildLoreVfsPath, DecoratorParser } from '@/core/lore';
import type {
    AgentProfile,
    BarrierPolicy,
    ClassifiedLoreEntry,
    ParsedDecorator,
    PipelinePhase,
    Preset,
    RawLoreEntry,
    ScopedPermissions,
    TriggerCondition,
    TriggerRule,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';

export interface LoreToolDescriptor {
    name: string;
    entry: RawLoreEntry;
    allowNetwork: boolean;
}

export interface CompiledWorldInfoArtifacts {
    triggers: TriggerRule[];
    derivedAgents: Record<string, AgentProfile>;
    subAgents: SubAgentDescriptor[];
    toolEntries: LoreToolDescriptor[];
    schemaEntries: RawLoreEntry[];
    warnings: string[];
}

export interface DecoratorCompilerOptions {
    preset?: Preset;
}

export interface TriggerExecutionUnit {
    unitId: string;
    phase: PipelinePhase;
    order: number;
    barrier: BarrierPolicy;
    agentProfileId: string;
    kind: 'agent' | 'script';
    groupName?: string;
    isGrouped: boolean;
    triggers: TriggerRule[];
    label: string;
    targetPath?: string;
}

const REPLACE_DECORATORS = new Set([
    '@@replace',
    '@@replace_before',
    '@@replace_diff',
    '@@replace_diff_before',
    '@@replace_search',
    '@@replace_search_before',
]);

const VARIABLES_DECORATORS = new Set([
    '@@variables_json',
    '@@variables_json_before',
    '@@variables_yaml',
    '@@variables_yaml_before',
    '@@variables_jsonpatch',
    '@@variables_jsonpatch_before',
]);

const APPEND_OUTPUT_DECORATORS = new Set([
    '@@append_output',
    '@@append_output_before',
]);

const REPLACE_OUTPUT_DECORATORS = new Set([
    '@@replace_output',
    '@@replace_output_before',
]);

const EJS_SCRIPT_DECORATORS = new Set([
    '@@evaluate_ejs',
    '@@evaluate_ejs_before',
    '@@replace_ejs',
    '@@replace_ejs_before',
    '@@append_output_ejs',
    '@@append_output_ejs_before',
    '@@replace_output_ejs',
    '@@replace_output_ejs_before',
]);

const PHASE_ORDER: Record<PipelinePhase, number> = {
    before_turn: 0,
    main_turn: 1,
    after_turn: 2,
    maintenance: 3,
};

const BARRIER_STRICTNESS: Record<BarrierPolicy, number> = {
    none: 0,
    self: 1,
    turn: 2,
};

function sanitizeSegment(raw: string): string {
    return raw
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '') || 'item';
}

function stripLeadingCodeFence(raw: string): { code: string; remainder: string } {
    const trimmed = raw.trim();
    const match = /^```(?:json|js|ts|javascript|typescript|mjs|cjs)?\s*\r?\n([\s\S]*?)\r?\n```\s*([\s\S]*)$/i.exec(
        trimmed,
    );
    if (!match) {
        return { code: '', remainder: raw };
    }
    return {
        code: match[1].trim(),
        remainder: match[2].trim(),
    };
}

function stripCodeFenceOnly(raw: string): string {
    const trimmed = raw.trim();
    const match = /^```(?:json|js|ts|javascript|typescript|mjs|cjs)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(
        trimmed,
    );
    return match ? match[1].trim() : trimmed;
}

function parsePhaseValue(raw: string | undefined, fallback: PipelinePhase): PipelinePhase {
    if (!raw) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'before' || normalized === 'before_turn') {
        return 'before_turn';
    }
    if (normalized === 'main' || normalized === 'main_turn') {
        return 'main_turn';
    }
    if (normalized === 'after' || normalized === 'after_turn') {
        return 'after_turn';
    }
    if (normalized === 'maintenance') {
        return 'maintenance';
    }
    return fallback;
}

function parseBarrierValue(raw: string | undefined, fallback: BarrierPolicy): BarrierPolicy {
    if (!raw) {
        return fallback;
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'turn' || normalized === 'self' || normalized === 'none') {
        return normalized;
    }
    return fallback;
}

function parseOrderValue(
    explicitOrder: string | undefined,
    batchOrderDec: ParsedDecorator | undefined,
    entryOrder: number | undefined,
): number {
    if (explicitOrder !== undefined) {
        const parsed = Number(explicitOrder);
        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }
    if (batchOrderDec) {
        const raw = batchOrderDec.args[0] ?? batchOrderDec.rawArgs;
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) {
            return Math.trunc(parsed);
        }
    }
    return typeof entryOrder === 'number' && Number.isFinite(entryOrder) ? entryOrder : 1;
}

function extractCondition(
    entry: RawLoreEntry,
    params: Record<string, string>,
): TriggerCondition {
    if (params.interval !== undefined) {
        const parsed = Number(params.interval);
        return {
            type: 'interval',
            interval: Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 1,
        };
    }
    if (params.regex) {
        return { type: 'regex', pattern: params.regex };
    }
    if (params.keys) {
        const keys = params.keys
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean);
        return { type: 'keyword', keys };
    }
    if (!entry.constant && Array.isArray(entry.keys) && entry.keys.length > 0) {
        return {
            type: 'keyword',
            keys: entry.keys.map((k) => k.trim()).filter(Boolean),
        };
    }
    return { type: 'always' };
}

function extractInlineSchema(
    decorators: readonly ParsedDecorator[],
    cleanContent: string,
): { schemaSource?: { kind: 'json' | 'zod'; raw: string }; instructionText: string } {
    const jsonDec = decorators.find((d) => d.name === '@@json_schema');
    const zodDec = decorators.find((d) => d.name === '@@zod_schema');

    if (!jsonDec && !zodDec) {
        return { instructionText: cleanContent.trim() };
    }

    const activeDec = zodDec ?? jsonDec!;
    const kind: 'json' | 'zod' = zodDec ? 'zod' : 'json';
    let rawSchema = activeDec.rawArgs.trim();
    let instructionText = cleanContent.trim();

    if (!rawSchema) {
        const extracted = stripLeadingCodeFence(cleanContent);
        if (extracted.code) {
            rawSchema = extracted.code;
            instructionText = extracted.remainder;
        } else {
            rawSchema = cleanContent.trim();
            instructionText = '';
        }
    }

    return {
        schemaSource: rawSchema ? { kind, raw: rawSchema } : undefined,
        instructionText,
    };
}

function buildDerivedTriggerAgent(params: {
    id: string;
    name: string;
    systemInstruction: string;
    enabledTools: string[];
    permissions: ScopedPermissions;
}): AgentProfile {
    return {
        id: params.id,
        name: params.name,
        connectionId: 'inherit',
        sessionMode: 'ephemeral',
        ephemeralWindowSize: 4,
        promptBlocks: [
            {
                id: 'system_base',
                name: 'Scoped Trigger Base',
                role: 'system',
                placement: 'prefix',
                content: params.systemInstruction,
                enabled: true,
            },
        ],
        enabledTools: [...params.enabledTools],
        permissions: {
            read: [...params.permissions.read],
            write: [...params.permissions.write],
        },
        maxToolRounds: 6,
    };
}

function unwrapLoreInputs(
    input: Map<string, RawLoreEntry[]> | readonly (RawLoreEntry | ClassifiedLoreEntry)[],
): RawLoreEntry[] {
    if (input instanceof Map) {
        const list: RawLoreEntry[] = [];
        for (const [world, entries] of input.entries()) {
            for (const entry of entries) {
                list.push(entry.world ? entry : { ...entry, world });
            }
        }
        return list;
    }

    return input.map((item) => ('entry' in item ? item.entry : item));
}

/**
 * Compiler transforming legacy World Info `@@` decorators and new `@@trigger` /
 * `@@script` / `@@group` / `@@tool` / `@@agent` entries into scoped `TriggerRule`s,
 * derived `AgentProfile`s, and 0-token script descriptors.
 */
export class DecoratorCompiler {
    compile(
        lorebooksOrEntries:
            | Map<string, RawLoreEntry[]>
            | readonly (RawLoreEntry | ClassifiedLoreEntry)[],
        options: DecoratorCompilerOptions = {},
    ): CompiledWorldInfoArtifacts {
        const entries = unwrapLoreInputs(lorebooksOrEntries);
        const triggers: TriggerRule[] = [];
        const derivedAgents: Record<string, AgentProfile> = {};
        const toolEntries: LoreToolDescriptor[] = [];
        const schemaEntries: RawLoreEntry[] = [];
        const warnings: string[] = [];

        const subAgents = extractSubAgentDescriptors(entries);

        for (const entry of entries) {
            if (entry.disable) {
                continue;
            }

            const compiled = this.compileEntry(entry, options);
            if (!compiled) {
                continue;
            }

            if (compiled.toolEntry) {
                toolEntries.push(compiled.toolEntry);
            }
            if (compiled.schemaEntry) {
                schemaEntries.push(compiled.schemaEntry);
            }
            if (compiled.trigger) {
                triggers.push(compiled.trigger);
            }
            if (compiled.derivedAgent) {
                derivedAgents[compiled.derivedAgent.id] = compiled.derivedAgent;
            }
            if (compiled.warnings.length > 0) {
                warnings.push(...compiled.warnings);
            }
        }

        return {
            triggers,
            derivedAgents,
            subAgents,
            toolEntries,
            schemaEntries,
            warnings,
        };
    }

    compileEntry(
        entry: RawLoreEntry,
        options: DecoratorCompilerOptions = {},
    ): {
        trigger?: TriggerRule;
        derivedAgent?: AgentProfile;
        toolEntry?: LoreToolDescriptor;
        schemaEntry?: RawLoreEntry;
        warnings: string[];
    } | null {
        const parsed = DecoratorParser.parseEntry(entry);
        const decorators = parsed.decorators;
        if (decorators.length === 0) {
            return null;
        }

        const warnings: string[] = [];

        // Ignore @@agent (handled by extractSubAgentDescriptors) and @@skill / @@system
        if (decorators.some((d) => d.name === '@@agent')) {
            return null;
        }

        const toolDec = decorators.find((d) => d.name === '@@tool');
        if (toolDec) {
            const name = (toolDec.args[0] || entry.comment || `lore_tool_${entry.uid}`).trim();
            const allowNetwork =
                toolDec.params.allowNetwork === undefined
                    ? true
                    : toolDec.params.allowNetwork.toLowerCase() !== 'false';
            return {
                toolEntry: { name, entry, allowNetwork },
                warnings,
            };
        }

        const triggerDec = decorators.find((d) => d.name === '@@trigger');
        const scriptDec = decorators.find((d) => d.name === '@@script');
        const batchOrderDec = decorators.find((d) => d.name === '@@batch_order');
        const groupDec = decorators.find((d) => d.name === '@@group');
        const replaceDec = decorators.find((d) => REPLACE_DECORATORS.has(d.name));
        const varsDec = decorators.find((d) => VARIABLES_DECORATORS.has(d.name));
        const appendOutputDec = decorators.find((d) => APPEND_OUTPUT_DECORATORS.has(d.name));
        const replaceOutputDec = decorators.find((d) => REPLACE_OUTPUT_DECORATORS.has(d.name));
        const ejsDec = decorators.find((d) => EJS_SCRIPT_DECORATORS.has(d.name));
        const schemaDec = decorators.find(
            (d) => d.name === '@@json_schema' || d.name === '@@zod_schema',
        );

        // Standalone @@json_schema / @@zod_schema (not attached to @@variables* or @@trigger)
        if (schemaDec && !varsDec && !triggerDec) {
            return {
                schemaEntry: entry,
                warnings,
            };
        }

        const vfsPath = buildLoreVfsPath(entry, decorators);
        const ruleId = `wi_${sanitizeSegment(entry.world)}_${entry.uid}`;
        const label = entry.comment?.trim() || `${entry.world}#${entry.uid}`;
        const groupName =
            triggerDec?.params.group?.trim()
            || scriptDec?.params.group?.trim()
            || groupDec?.args[0]?.trim()
            || groupDec?.rawArgs.trim()
            || undefined;

        const baseOrder = parseOrderValue(
            triggerDec?.params.order ?? scriptDec?.params.order,
            batchOrderDec,
            entry.order,
        );

        const presetAgents = options.preset?.agents ?? {};

        // 1. New @@trigger or @@script (or combined @@trigger + @@script)
        if (triggerDec || scriptDec) {
            const params = { ...(scriptDec?.params ?? {}), ...(triggerDec?.params ?? {}) };
            const phase = parsePhaseValue(params.phase, 'after_turn');
            const defaultBarrier: BarrierPolicy = phase === 'before_turn' ? 'turn' : 'self';
            const barrier = parseBarrierValue(params.barrier, defaultBarrier);
            const isScript = Boolean(scriptDec);
            const targetPath = params.target?.trim() || (replaceDec ? vfsPath : varsDec ? '/state/variables.json' : undefined);
            const condition = extractCondition(entry, params);
            const tag = params.tag?.trim() || triggerDec?.args[0]?.trim() || undefined;

            if (isScript) {
                const scriptCode = stripCodeFenceOnly(parsed.cleanContent);
                const trigger: TriggerRule = {
                    id: ruleId,
                    label,
                    source: 'worldinfo',
                    phase,
                    order: baseOrder,
                    barrier,
                    agentProfileId: params.profile?.trim() || params.agent?.trim() || 'script',
                    kind: 'script',
                    ...(tag ? { tag } : {}),
                    ...(groupName ? { groupName } : {}),
                    condition,
                    instructionTemplate: scriptCode,
                    ...(targetPath ? { targetPath } : {}),
                    decorator: triggerDec ? '@@trigger' : '@@script',
                    scriptCode,
                    enabled: true,
                };
                return { trigger, warnings };
            }

            const { schemaSource, instructionText } = extractInlineSchema(decorators, parsed.cleanContent);
            const requestedProfileId = params.profile?.trim() || params.agent?.trim();
            const existingProfile = requestedProfileId ? presetAgents[requestedProfileId] : undefined;
            const agentProfileId = existingProfile
                ? existingProfile.id
                : (requestedProfileId || `wi_agent_${sanitizeSegment(entry.world)}_${entry.uid}`);

            let derivedAgent: AgentProfile | undefined;
            if (!existingProfile) {
                const tools =
                    targetPath === '/state/variables.json'
                        ? ['read_variables', 'patch_variables', 'read_file']
                        : targetPath
                            ? ['read_file', 'edit_file', 'write_file', 'read_variables']
                            : [
                                'list_dir',
                                'search_files',
                                'read_file',
                                'edit_file',
                                'write_file',
                                'read_variables',
                                'patch_variables',
                            ];
                const permissions: ScopedPermissions =
                    targetPath === '/state/variables.json'
                        ? { read: ['/state/variables.json', '/lorebooks/**', '/memory/**'], write: ['/state/variables.json'] }
                        : targetPath
                            ? { read: [targetPath, '/state/variables.json', '/lorebooks/**'], write: [targetPath] }
                            : { read: ['/**'], write: ['/memory/**', '/scratch/**', '/lorebooks/**', '/state/variables.json'] };

                derivedAgent = buildDerivedTriggerAgent({
                    id: agentProfileId,
                    name: label,
                    systemInstruction:
                        'You are a scoped trigger agent. Follow the trigger instruction carefully and invoke the granted tools cleanly.',
                    enabledTools: tools,
                    permissions,
                });
            }

            const trigger: TriggerRule = {
                id: ruleId,
                label,
                source: 'worldinfo',
                phase,
                order: baseOrder,
                barrier,
                agentProfileId,
                kind: 'agent',
                ...(tag ? { tag } : {}),
                ...(groupName ? { groupName } : {}),
                condition,
                instructionTemplate: instructionText,
                ...(targetPath ? { targetPath } : {}),
                ...(schemaSource ? { schemaSource } : {}),
                decorator: '@@trigger',
                enabled: true,
            };

            return { trigger, derivedAgent, warnings };
        }

        // 2. Legacy @@replace* -> scoped VFS read_file/edit_file/write_file on /lorebooks/...
        if (replaceDec) {
            const phase: PipelinePhase = replaceDec.name.endsWith('_before')
                ? 'before_turn'
                : 'after_turn';
            const barrier: BarrierPolicy = phase === 'before_turn' ? 'turn' : 'self';
            const tag = replaceDec.args[0]?.trim() || undefined;
            const agentProfileId = `wi_agent_${sanitizeSegment(entry.world)}_${entry.uid}`;

            const derivedAgent = buildDerivedTriggerAgent({
                id: agentProfileId,
                name: `${label} (${replaceDec.name})`,
                systemInstruction: [
                    `You maintain the World Info entry stored at "${vfsPath}".`,
                    'First inspect the current content via read_file, then apply surgical updates via edit_file or full updates via write_file ONLY to that target path.',
                ].join('\n'),
                enabledTools: ['read_file', 'edit_file', 'write_file', 'read_variables'],
                permissions: {
                    read: [vfsPath, '/state/variables.json'],
                    write: [vfsPath],
                },
            });

            const trigger: TriggerRule = {
                id: ruleId,
                label,
                source: 'worldinfo',
                phase,
                order: baseOrder,
                barrier,
                agentProfileId,
                kind: 'agent',
                ...(tag ? { tag } : {}),
                ...(groupName ? { groupName } : {}),
                condition: extractCondition(entry, {}),
                instructionTemplate: parsed.cleanContent.trim(),
                targetPath: vfsPath,
                decorator: replaceDec.name,
                enabled: true,
            };

            return { trigger, derivedAgent, warnings };
        }

        // 3. Legacy @@variables* -> /state/variables.json + compiled @@json_schema / @@zod_schema
        if (varsDec) {
            const phase: PipelinePhase = varsDec.name.endsWith('_before')
                ? 'before_turn'
                : 'after_turn';
            const barrier: BarrierPolicy = 'turn';
            const tag = varsDec.args[0]?.trim() || undefined;
            const { schemaSource, instructionText } = extractInlineSchema(decorators, parsed.cleanContent);
            const agentProfileId = `wi_agent_${sanitizeSegment(entry.world)}_${entry.uid}`;

            const derivedAgent = buildDerivedTriggerAgent({
                id: agentProfileId,
                name: `${label} (${varsDec.name})`,
                systemInstruction: [
                    'You maintain structured state variables at /state/variables.json.',
                    'Read current state with read_variables and apply incremental updates with patch_variables.',
                    'If patch_variables reports a schema validation error, inspect the failing field paths and fix them in the same turn.',
                ].join('\n'),
                enabledTools: ['read_variables', 'patch_variables', 'read_file'],
                permissions: {
                    read: ['/state/variables.json', '/lorebooks/**', '/memory/**'],
                    write: ['/state/variables.json'],
                },
            });

            const trigger: TriggerRule = {
                id: ruleId,
                label,
                source: 'worldinfo',
                phase,
                order: baseOrder,
                barrier,
                agentProfileId,
                kind: 'agent',
                ...(tag ? { tag } : {}),
                ...(groupName ? { groupName } : {}),
                condition: extractCondition(entry, {}),
                instructionTemplate: instructionText,
                targetPath: '/state/variables.json',
                ...(schemaSource ? { schemaSource } : {}),
                decorator: varsDec.name,
                enabled: true,
            };

            return { trigger, derivedAgent, warnings };
        }

        // 4. Legacy @@append_output* / @@replace_output* -> append_reply_view / replace_reply_view
        if (appendOutputDec || replaceOutputDec) {
            const activeDec = (appendOutputDec ?? replaceOutputDec)!;
            const isAppend = Boolean(appendOutputDec);
            const phase: PipelinePhase = activeDec.name.endsWith('_before')
                ? 'before_turn'
                : 'after_turn';
            const barrier: BarrierPolicy = phase === 'before_turn' ? 'turn' : 'self';
            const tag = activeDec.args[0]?.trim() || undefined;
            const agentProfileId = `wi_agent_${sanitizeSegment(entry.world)}_${entry.uid}`;
            const viewTool = isAppend ? 'append_reply_view' : 'replace_reply_view';

            const derivedAgent = buildDerivedTriggerAgent({
                id: agentProfileId,
                name: `${label} (${activeDec.name})`,
                systemInstruction: `You update only the display layer of the anchored message using ${viewTool}. Never alter underlying conversation history.`,
                enabledTools: [viewTool, 'read_file', 'read_variables'],
                permissions: {
                    read: ['/**'],
                    write: [],
                },
            });

            const trigger: TriggerRule = {
                id: ruleId,
                label,
                source: 'worldinfo',
                phase,
                order: baseOrder,
                barrier,
                agentProfileId,
                kind: 'agent',
                ...(tag ? { tag } : {}),
                ...(groupName ? { groupName } : {}),
                condition: extractCondition(entry, {}),
                instructionTemplate: parsed.cleanContent.trim(),
                decorator: activeDec.name,
                enabled: true,
            };

            return { trigger, derivedAgent, warnings };
        }

        // 5. Legacy EJS 0-token script triggers (@@evaluate_ejs*, @@replace_ejs*, @@append_output_ejs*, @@replace_output_ejs*)
        if (ejsDec) {
            const phase: PipelinePhase = ejsDec.name.endsWith('_before')
                ? 'before_turn'
                : 'after_turn';
            const barrier: BarrierPolicy = phase === 'before_turn' ? 'turn' : 'self';
            const tag = ejsDec.args[0]?.trim() || undefined;
            const isReplaceLore = ejsDec.name.startsWith('@@replace_ejs');

            const trigger: TriggerRule = {
                id: ruleId,
                label,
                source: 'worldinfo',
                phase,
                order: baseOrder,
                barrier,
                agentProfileId: 'ejs_script',
                kind: 'script',
                ...(tag ? { tag } : {}),
                ...(groupName ? { groupName } : {}),
                condition: extractCondition(entry, {}),
                instructionTemplate: parsed.cleanContent,
                ...(isReplaceLore ? { targetPath: vfsPath } : {}),
                decorator: ejsDec.name,
                scriptCode: parsed.cleanContent,
                enabled: true,
            };

            return { trigger, warnings };
        }

        return null;
    }
}

/**
 * Group enabled triggers into execution units enforcing **default `1 Trigger = 1 Run` isolation**.
 * Two triggers are merged ONLY when `kind === 'agent'`, `groupName` is explicitly non-empty,
 * and `phase + order + groupName + agentProfileId` all match.
 */
export function groupTriggersForExecution(
    triggers: readonly TriggerRule[],
): TriggerExecutionUnit[] {
    const enabled = triggers
        .filter((rule) => rule.enabled)
        .map((rule, idx) => ({ rule: canonicalClone(rule), idx }))
        .sort(
            (a, b) =>
                PHASE_ORDER[a.rule.phase] - PHASE_ORDER[b.rule.phase]
                || a.rule.order - b.rule.order
                || a.idx - b.idx,
        );

    const units: TriggerExecutionUnit[] = [];
    const groupedBuckets = new Map<string, TriggerExecutionUnit>();

    for (const { rule } of enabled) {
        const groupName = rule.groupName?.trim();
        const canMerge = rule.kind === 'agent' && Boolean(groupName);

        if (canMerge && groupName) {
            const groupKey = `${rule.phase}::${rule.order}::${groupName}::${rule.agentProfileId}`;
            const existing = groupedBuckets.get(groupKey);
            if (existing) {
                existing.triggers.push(rule);
                existing.isGrouped = true;
                existing.label = `${groupName} (${existing.triggers.length})`;
                if (BARRIER_STRICTNESS[rule.barrier] > BARRIER_STRICTNESS[existing.barrier]) {
                    existing.barrier = rule.barrier;
                }
                continue;
            }

            const unit: TriggerExecutionUnit = {
                unitId: `group:${groupKey}`,
                phase: rule.phase,
                order: rule.order,
                barrier: rule.barrier,
                agentProfileId: rule.agentProfileId,
                kind: 'agent',
                groupName,
                isGrouped: false,
                triggers: [rule],
                label: rule.label,
                ...(rule.targetPath ? { targetPath: rule.targetPath } : {}),
            };
            groupedBuckets.set(groupKey, unit);
            units.push(unit);
            continue;
        }

        units.push({
            unitId: `single:${rule.id}`,
            phase: rule.phase,
            order: rule.order,
            barrier: rule.barrier,
            agentProfileId: rule.agentProfileId,
            kind: rule.kind,
            ...(groupName ? { groupName } : {}),
            isGrouped: false,
            triggers: [rule],
            label: rule.label,
            ...(rule.targetPath ? { targetPath: rule.targetPath } : {}),
        });
    }

    return units;
}
