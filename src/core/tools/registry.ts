import { z } from 'zod';
import type { ToolExecutionContext } from '@/core/bridge';
import type { BuiltinToolConfig, CanonicalToolSchema } from '@/core/types';
import { canonicalClone, stripJsonSchemaMeta } from '@/core/utils';
import { createAbortError, isAbortError, throwIfAborted } from './script-sandbox';

export interface ToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    description: string;
    parameters: TParams;
    execute(args: z.infer<TParams>, ctx: ToolExecutionContext): Promise<unknown> | unknown;
    strict?: boolean;
    source?: 'builtin' | 'custom_js' | 'slash_bridge' | 'agent' | string;
    allowedAgents?: string[];
}

export interface ToolValidationIssue {
    path: string;
    jsonPointer: string;
    code: string;
    message: string;
}

export interface ToolExecutionResult {
    ok: boolean;
    toolName: string;
    output: string;
    error?: string;
    durationMs: number;
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

function escapeJsonPointerSegment(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Convert Zod v4 issues into structured field-path diagnostics for self-healing. */
export function formatZodIssues(error: z.ZodError): ToolValidationIssue[] {
    return error.issues.map((issue) => {
        const segments = issue.path.map((part) => String(part));
        const path = segments.length > 0 ? segments.join('.') : '(root)';
        const jsonPointer =
            segments.length > 0
                ? `/${segments.map(escapeJsonPointerSegment).join('/')}`
                : '/';
        return {
            path,
            jsonPointer,
            code: issue.code,
            message: issue.message,
        };
    });
}

/** Format a self-healing validation error summary naming every invalid field path. */
export function formatValidationError(label: string, error: z.ZodError): string {
    const issues = formatZodIssues(error);
    if (issues.length === 0) {
        return `Validation failed for ${label}: invalid input.`;
    }
    const details = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    return `Validation failed for ${label} — fix the invalid field(s) and retry: ${details}`;
}

function applyParameterDescriptionOverrides(
    schema: z.ZodTypeAny,
    paramDescriptions?: Record<string, string>,
): z.ZodTypeAny {
    if (!paramDescriptions || Object.keys(paramDescriptions).length === 0) {
        return schema;
    }

    const maybeObject = schema as unknown as {
        shape?: Record<string, z.ZodTypeAny>;
        extend?: (shape: Record<string, z.ZodTypeAny>) => z.ZodTypeAny;
    };

    if (!maybeObject.shape || typeof maybeObject.extend !== 'function') {
        return schema;
    }

    let changed = false;
    const nextShape: Record<string, z.ZodTypeAny> = {};

    for (const [key, field] of Object.entries(maybeObject.shape)) {
        const customDesc = paramDescriptions[key];
        if (typeof customDesc === 'string' && customDesc.trim().length > 0 && typeof field?.describe === 'function') {
            nextShape[key] = field.describe(customDesc);
            changed = true;
        } else {
            nextShape[key] = field;
        }
    }

    return changed ? maybeObject.extend(nextShape) : schema;
}

/**
 * Convert a Zod v4 parameter schema into a deterministically key-ordered JSON Schema
 * with `$schema` and `$id` stripped for Prefix KV Cache stability.
 */
export function schemaToCanonicalJsonSchema(
    schema: z.ZodTypeAny,
    paramDescriptions?: Record<string, string>,
): Record<string, unknown> {
    const effective = applyParameterDescriptionOverrides(schema, paramDescriptions);
    const raw = z.toJSONSchema(effective, {
        io: 'input',
        unrepresentable: 'any',
    });
    return stripJsonSchemaMeta(raw);
}

function parseRawToolArguments(
    toolName: string,
    rawArgs: string | Record<string, unknown>,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    if (typeof rawArgs !== 'string') {
        if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
            return {
                ok: false,
                error: `Invalid arguments for tool "${toolName}": expected a JSON object.`,
            };
        }
        return { ok: true, value: rawArgs };
    }

    const trimmed = rawArgs.trim();
    if (!trimmed) {
        return { ok: true, value: {} };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (error) {
        return {
            ok: false,
            error: `Invalid JSON arguments for tool "${toolName}": ${(error as Error).message}. Supply a valid JSON object matching the schema.`,
        };
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            error: `Invalid arguments for tool "${toolName}": expected a JSON object, received ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
        };
    }

    return { ok: true, value: parsed as Record<string, unknown> };
}

function extractEmbeddedToolError(output: string): string | undefined {
    const trimmed = output.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(trimmed) as { ok?: unknown; error?: unknown };
        if (parsed && typeof parsed === 'object' && parsed.ok === false && typeof parsed.error === 'string') {
            return parsed.error;
        }
    } catch {
        // Not JSON; treat as normal text output
    }
    return undefined;
}

function serializeToolOutput(rawResult: unknown): string {
    if (typeof rawResult === 'string') {
        return rawResult;
    }
    if (rawResult === undefined) {
        return JSON.stringify({ ok: true });
    }
    return JSON.stringify(rawResult);
}

/**
 * Central tool registry managing registration, deterministic `CanonicalToolSchema`
 * compilation (`canonicalStringify`-stable), Zod v4 validation, and safe execution
 * with structured self-healing error feedback.
 */
export class ToolRegistry {
    private readonly tools = new Map<string, ToolDefinition>();

    constructor(initialTools: readonly ToolDefinition[] = []) {
        this.registerAll(initialTools);
    }

    register(tool: ToolDefinition, options: { replace?: boolean } = {}): this {
        if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
            throw new Error('Cannot register tool without a non-empty name.');
        }
        const name = tool.name.trim();
        if (!options.replace && this.tools.has(name)) {
            throw new Error(`Tool "${name}" is already registered.`);
        }
        this.tools.set(name, { ...tool, name });
        return this;
    }

    registerAll(tools: readonly ToolDefinition[], options: { replace?: boolean } = {}): this {
        for (const tool of tools) {
            this.register(tool, options);
        }
        return this;
    }

    unregister(name: string): boolean {
        return this.tools.delete(name);
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    get(name: string): ToolDefinition | undefined {
        return this.tools.get(name);
    }

    names(): string[] {
        return Array.from(this.tools.keys()).sort(compareCodeUnits);
    }

    list(): ToolDefinition[] {
        return this.names().map((name) => this.tools.get(name)!);
    }

    clone(): ToolRegistry {
        return new ToolRegistry(this.list());
    }

    /**
     * Compile enabled tools into deterministic, UTF-16 lexicographically sorted
     * `CanonicalToolSchema[]` for Layer 0 Prefix KV Cache invariance.
     */
    toCanonicalSchemas(
        enabledToolNames?: readonly string[],
        builtinOverrides?: Record<string, BuiltinToolConfig>,
    ): CanonicalToolSchema[] {
        const selectedNames = enabledToolNames
            ? Array.from(new Set(enabledToolNames.map((n) => n.trim()).filter(Boolean)))
            : Array.from(this.tools.keys());

        selectedNames.sort(compareCodeUnits);

        const schemas: CanonicalToolSchema[] = [];
        for (const name of selectedNames) {
            const tool = this.tools.get(name);
            if (!tool) {
                continue;
            }

            const override = builtinOverrides?.[name];
            if (override && override.enabled === false) {
                continue;
            }

            const description =
                override?.description && override.description.trim().length > 0
                    ? override.description
                    : tool.description;
            const parameters = schemaToCanonicalJsonSchema(tool.parameters, override?.parameters);

            schemas.push(
                canonicalClone({
                    name: tool.name,
                    description,
                    parameters,
                    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
                }),
            );
        }

        return schemas;
    }

    /**
     * Parse arguments, validate against the tool's Zod v4 schema, and execute
     * with `ctx`. Returns structured self-healing errors on validation/tool errors
     * while propagating `AbortError` when `ctx.signal` aborts.
     */
    async executeToolCall(
        name: string,
        rawArgs: string | Record<string, unknown>,
        ctx: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
        throwIfAborted(ctx.signal);
        const start = Date.now();

        const tool = this.tools.get(name);
        if (!tool) {
            const available = this.names();
            const error = `Unknown tool "${name}". Available tools: ${available.length > 0 ? available.join(', ') : '(none)'}`;
            return {
                ok: false,
                toolName: name,
                output: JSON.stringify({ ok: false, error }),
                error,
                durationMs: Math.max(0, Date.now() - start),
            };
        }

        const parsed = parseRawToolArguments(name, rawArgs);
        if (!parsed.ok) {
            return {
                ok: false,
                toolName: name,
                output: JSON.stringify({ ok: false, error: parsed.error }),
                error: parsed.error,
                durationMs: Math.max(0, Date.now() - start),
            };
        }

        const validated = tool.parameters.safeParse(parsed.value);
        if (!validated.success) {
            const issues = formatZodIssues(validated.error);
            const error = formatValidationError(`tool "${name}"`, validated.error);
            return {
                ok: false,
                toolName: name,
                output: JSON.stringify({ ok: false, error, issues }),
                error,
                durationMs: Math.max(0, Date.now() - start),
            };
        }

        try {
            const rawResult = await tool.execute(validated.data, ctx);
            if (ctx.signal.aborted) {
                throw createAbortError(`Tool "${name}" aborted`);
            }

            const output = serializeToolOutput(rawResult);
            const embeddedError = extractEmbeddedToolError(output);
            return {
                ok: embeddedError === undefined,
                toolName: name,
                output,
                ...(embeddedError !== undefined ? { error: embeddedError } : {}),
                durationMs: Math.max(0, Date.now() - start),
            };
        } catch (error) {
            if (isAbortError(error) || ctx.signal.aborted) {
                if (error instanceof Error && isAbortError(error)) {
                    throw error;
                }
                throw createAbortError(`Tool "${name}" aborted`);
            }
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                toolName: name,
                output: JSON.stringify({ ok: false, error: message }),
                error: message,
                durationMs: Math.max(0, Date.now() - start),
            };
        }
    }

    /** Execute a tool call and return only its string payload for LLM tool messages. */
    async executeToolCallText(
        name: string,
        rawArgs: string | Record<string, unknown>,
        ctx: ToolExecutionContext,
    ): Promise<string> {
        const result = await this.executeToolCall(name, rawArgs, ctx);
        return result.output;
    }
}
