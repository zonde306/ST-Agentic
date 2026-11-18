import { z } from 'zod';
import type { CustomToolConfig, SlashToolParamDef } from '@/core/types';
import type { ToolDefinition } from './registry';
import { createAbortError, isAbortError, throwIfAborted } from './script-sandbox';

function coerceDefaultValue(def: SlashToolParamDef): unknown {
    if (def.defaultValue === undefined) {
        return undefined;
    }
    switch (def.type) {
        case 'number': {
            const num = typeof def.defaultValue === 'number'
                ? def.defaultValue
                : Number(def.defaultValue);
            return Number.isFinite(num) ? num : undefined;
        }
        case 'boolean':
            return Boolean(def.defaultValue);
        case 'enum': {
            const str = String(def.defaultValue);
            if (def.enumValues?.length && !def.enumValues.includes(str)) {
                return undefined;
            }
            return str;
        }
        default:
            return String(def.defaultValue);
    }
}

/** Compile a Zod v4 parameter object schema from `SlashToolParamDef[]`. */
export function buildSlashParamsSchema(
    params: readonly SlashToolParamDef[] = [],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const def of params) {
        const name = def.name.trim();
        if (!name) {
            continue;
        }

        let field: z.ZodTypeAny;
        switch (def.type) {
            case 'number':
                field = z.number();
                break;
            case 'boolean':
                field = z.boolean();
                break;
            case 'enum': {
                const values = (def.enumValues ?? []).map((v) => v.trim()).filter(Boolean);
                field = values.length > 0
                    ? z.enum(values as [string, ...string[]])
                    : z.string();
                break;
            }
            case 'string':
            default:
                field = z.string();
                break;
        }

        if (def.description) {
            field = field.describe(def.description);
        }

        const coercedDefault = coerceDefaultValue(def);
        if (coercedDefault !== undefined) {
            field = (field as z.ZodTypeAny).default(coercedDefault as never);
        } else if (def.required === false) {
            field = field.optional();
        }

        shape[name] = field;
    }

    return z.object(shape);
}

/**
 * Neutralize STScript command/pipe/macro injection payloads inside interpolated
 * parameter values while preserving normal prompt text.
 */
export function sanitizeSlashParamValue(
    value: unknown,
    options: { quoteContext?: '"' | "'" | null } = {},
): string {
    if (value === undefined || value === null) {
        return '';
    }
    let text = String(value)
        .replace(/\0/g, '')
        .replace(/\r\n|\r|\n/g, ' ');

    if (options.quoteContext === '"') {
        text = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    } else if (options.quoteContext === "'") {
        text = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    text = text
        .replace(/\|/g, '\\|')
        .replace(/\{\{/g, '{ {')
        .replace(/\}\}/g, '} }');

    return text;
}

/**
 * Safely interpolate `{{param}}` placeholders in a slash command template using
 * validated arguments and parameter definitions.
 */
export function interpolateSlashCommand(
    template: string,
    args: Record<string, unknown>,
    paramDefs: readonly SlashToolParamDef[] = [],
): string {
    const declaredParams = new Set(paramDefs.map((p) => p.name.trim()).filter(Boolean));

    return template.replace(
        /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
        (fullMatch, rawKey: string, offset: number, fullString: string) => {
            const hasArg = Object.hasOwn(args, rawKey);
            if (!hasArg && !declaredParams.has(rawKey)) {
                return fullMatch;
            }
            const val = hasArg ? args[rawKey] : undefined;
            const prevChar = offset > 0 ? fullString[offset - 1] : '';
            const nextChar = fullString[offset + fullMatch.length] ?? '';
            const quoteContext =
                prevChar === '"' && nextChar === '"'
                    ? '"'
                    : prevChar === "'" && nextChar === "'"
                        ? "'"
                        : null;

            return sanitizeSlashParamValue(val, { quoteContext });
        },
    ).trim();
}

/**
 * Compile a `CustomToolConfig` (`kind: 'slash_bridge'`) into a validated `ToolDefinition`
 * that interpolates parameters safely and dispatches via `ctx.st.slash(command)`.
 */
export function compileSlashBridgeTool(config: CustomToolConfig): ToolDefinition {
    if (config.kind !== 'slash_bridge') {
        throw new Error(`Expected kind "slash_bridge", received "${config.kind}".`);
    }

    const name = config.name.trim();
    if (!name) {
        throw new Error('Slash bridge tool requires a non-empty "name".');
    }

    const template = (config.commandTemplate ?? '').trim();
    if (!template) {
        throw new Error(`Slash bridge tool "${name}" requires a non-empty "commandTemplate".`);
    }

    const paramDefs = config.params ?? [];
    const schema = buildSlashParamsSchema(paramDefs);

    return {
        name,
        description: config.description || `Execute slash command: ${template}`,
        parameters: schema,
        source: 'slash_bridge',
        ...(config.allowedAgents?.length ? { allowedAgents: [...config.allowedAgents] } : {}),
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            const command = interpolateSlashCommand(
                template,
                args as Record<string, unknown>,
                paramDefs,
            );
            try {
                const output = await ctx.st.slash(command);
                throwIfAborted(ctx.signal);
                return JSON.stringify({
                    ok: true,
                    command,
                    output,
                    target: ctx.target,
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({
                    ok: false,
                    command,
                    error: message,
                });
            }
        },
    };
}
