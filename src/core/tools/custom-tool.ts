import { DecoratorParser } from '@/core/lore';
import type { CustomToolConfig, RawLoreEntry } from '@/core/types';
import type { ToolDefinition, ToolRegistry } from './registry';
import { type ScriptSandbox, throwIfAborted } from './script-sandbox';
import { compileSlashBridgeTool } from './slash-tool';

const MAX_CUSTOM_TOOL_TIMEOUT_MS = 600_000;

function parseDecoratorTimeoutMs(params: Record<string, string>): number | undefined {
    const raw = params.timeoutMs ?? params.timeout;
    if (raw === undefined) {
        return undefined;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return undefined;
    }
    return Math.min(Math.max(1, Math.floor(parsed)), MAX_CUSTOM_TOOL_TIMEOUT_MS);
}

export interface CompileCustomToolOptions {
    sandboxId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface RegisterCustomToolsOptions extends CompileCustomToolOptions {
    replace?: boolean;
    agentId?: string;
}

export interface RegisterCustomToolsResult {
    registered: string[];
    errors: Array<{ id: string; name: string; error: string }>;
}

/**
 * Compile a `CustomToolConfig` (`kind: 'js'` or `kind: 'slash_bridge'`) into one
 * or more validated `ToolDefinition` instances.
 */
export async function compileCustomToolConfig(
    config: CustomToolConfig,
    sandbox?: ScriptSandbox,
    options: CompileCustomToolOptions = {},
): Promise<ToolDefinition[]> {
    throwIfAborted(options.signal);

    if (config.kind === 'slash_bridge') {
        return [compileSlashBridgeTool(config)];
    }

    if (!sandbox) {
        throw new Error(`Custom JS tool "${config.name || config.id}" requires a ScriptSandbox instance.`);
    }

    const code = (config.code ?? '').trim();
    if (!code) {
        throw new Error(`Custom JS tool "${config.name || config.id}" has empty source code.`);
    }

    const sandboxId = options.sandboxId?.trim() || config.id?.trim() || config.name?.trim() || 'custom_js_tool';
    const compiledList = await sandbox.compileCustomTools(code, {
        id: sandboxId,
        allowNetwork: config.allowNetwork ?? true,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
    });

    if (compiledList.length === 0) {
        throw new Error(`Custom JS tool "${config.name || config.id}" did not export any defineTool() definition.`);
    }

    return compiledList.map((compiled) => ({
        name: compiled.name || config.name.trim(),
        description: compiled.description || config.description,
        parameters: compiled.parameters,
        ...(compiled.strict !== undefined ? { strict: compiled.strict } : {}),
        source: 'custom_js',
        ...(config.allowedAgents?.length ? { allowedAgents: [...config.allowedAgents] } : {}),
        execute: (args, ctx) => compiled.execute(args as Record<string, unknown>, ctx),
    }));
}

/**
 * Compile a `@@tool <name>` World Info entry into validated `ToolDefinition[]`
 * via `ScriptSandbox`.
 */
export async function compileLoreToolEntry(
    entry: RawLoreEntry,
    sandbox: ScriptSandbox,
    options: CompileCustomToolOptions = {},
): Promise<ToolDefinition[]> {
    const parsed = DecoratorParser.parseEntry(entry);
    const toolDec = parsed.decorators.find((d) => d.name === '@@tool');
    if (!toolDec) {
        throw new Error(`Lorebook entry "${entry.world}/${entry.uid}" does not contain a @@tool decorator.`);
    }

    const name = (toolDec.args[0] || entry.comment || `lore_tool_${entry.uid}`).trim();
    const allowNetworkParam = toolDec.params.allowNetwork;
    const allowNetwork =
        allowNetworkParam === undefined
            ? true
            : allowNetworkParam.toLowerCase() !== 'false';
    const decoratorTimeoutMs = parseDecoratorTimeoutMs(toolDec.params);

    const config: CustomToolConfig = {
        id: `lore:${entry.world}:${entry.uid}`,
        name,
        kind: 'js',
        description: entry.comment?.trim() || name,
        enabled: !entry.disable,
        code: parsed.cleanContent,
        allowNetwork,
    };

    return await compileCustomToolConfig(config, sandbox, {
        ...options,
        ...(options.timeoutMs === undefined && decoratorTimeoutMs !== undefined
            ? { timeoutMs: decoratorTimeoutMs }
            : {}),
    });
}

/**
 * Compile and register enabled `CustomToolConfig[]` into a `ToolRegistry`.
 * Optionally filters by `agentId` against `config.allowedAgents`.
 */
export async function registerCustomTools(
    registry: ToolRegistry,
    configs: readonly CustomToolConfig[],
    sandbox?: ScriptSandbox,
    options: RegisterCustomToolsOptions = {},
): Promise<RegisterCustomToolsResult> {
    const registered: string[] = [];
    const errors: Array<{ id: string; name: string; error: string }> = [];

    for (const config of configs) {
        throwIfAborted(options.signal);
        if (!config.enabled) {
            continue;
        }
        if (
            options.agentId
            && config.allowedAgents?.length
            && !config.allowedAgents.includes(options.agentId)
        ) {
            continue;
        }

        try {
            const tools = await compileCustomToolConfig(config, sandbox, options);
            for (const tool of tools) {
                registry.register(tool, { replace: options.replace ?? true });
                registered.push(tool.name);
            }
        } catch (error) {
            errors.push({
                id: config.id,
                name: config.name,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return { registered, errors };
}
