import type { z } from 'zod';
import type { ToolExecutionContext } from '@/core/bridge';

/** Error thrown when sandboxed code attempts to access a blocked host or network API. */
export class SandboxSecurityError extends Error {
    public readonly apiName: string;

    constructor(apiName: string, message?: string) {
        super(message ?? `Sandbox security violation: "${apiName}" is blocked in this mode.`);
        this.name = 'SandboxSecurityError';
        this.apiName = apiName;
    }
}

/** Error thrown when sandbox compilation or script execution fails. */
export class SandboxExecutionError extends Error {
    constructor(message: string, public readonly causeError?: unknown) {
        super(message);
        this.name = 'SandboxExecutionError';
    }
}

export interface SandboxToolDefinition<TParams extends z.ZodTypeAny = z.ZodTypeAny> {
    name: string;
    description: string;
    parameters: TParams;
    execute(args: z.infer<TParams>, ctx: ToolExecutionContext): Promise<unknown> | unknown;
    strict?: boolean;
    timeoutMs?: number;
}

export interface CompiledSandboxTool {
    name: string;
    description: string;
    parameters: z.ZodTypeAny;
    execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<unknown>;
    strict?: boolean;
    timeoutMs?: number;
}

export interface SchemaEvalOptions {
    id?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface SandboxCompileOptions {
    id?: string;
    allowNetwork?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface SandboxRunOptions {
    id?: string;
    allowNetwork?: boolean;
    timeoutMs?: number;
    keepAlive?: boolean;
    signal?: AbortSignal;
}

/** Abstract schema evaluator for `@@zod_schema` expressions without DOM/host coupling. */
export interface SchemaEvaluator {
    evaluateSchema(code: string, options?: SchemaEvalOptions): Promise<z.ZodTypeAny>;
}

/**
 * Abstract JS sandbox contract consumed by `src/core/tools/**`.
 * Browser `iframe` implementation resides strictly in `src/sandbox/**`.
 */
export interface ScriptSandbox extends SchemaEvaluator {
    compileCustomTools(code: string, options?: SandboxCompileOptions): Promise<CompiledSandboxTool[]>;
    evaluateScript(code: string, ctx: ToolExecutionContext, options?: SandboxRunOptions): Promise<unknown>;
    dispose?(id: string): boolean;
    disposeAll?(): number;
}

/**
 * Author-facing helper injected into custom tool scripts (`defineTool({ ... })`)
 * and re-exported for TypeScript authoring.
 */
export function defineTool<TParams extends z.ZodTypeAny>(
    definition: SandboxToolDefinition<TParams>,
): SandboxToolDefinition<TParams> {
    if (!definition || typeof definition !== 'object') {
        throw new Error('defineTool() requires a tool definition object.');
    }
    if (typeof definition.name !== 'string' || definition.name.trim().length === 0) {
        throw new Error('defineTool() requires a non-empty string "name".');
    }
    if (typeof definition.description !== 'string') {
        throw new Error(`defineTool("${definition.name}") requires a string "description".`);
    }
    if (!definition.parameters || typeof definition.parameters.safeParse !== 'function') {
        throw new Error(`defineTool("${definition.name}") requires a Zod v4 "parameters" schema.`);
    }
    if (typeof definition.execute !== 'function') {
        throw new Error(`defineTool("${definition.name}") requires an "execute" function.`);
    }
    if (
        definition.timeoutMs !== undefined
        && (
            typeof definition.timeoutMs !== 'number'
            || !Number.isFinite(definition.timeoutMs)
            || definition.timeoutMs <= 0
        )
    ) {
        throw new Error(`defineTool("${definition.name}") "timeoutMs" must be a positive finite number.`);
    }
    return definition;
}

/** Create a canonical `AbortError` recognized by `AgentRunner` and `AbortSignal` handlers. */
export function createAbortError(message: string = 'Operation aborted'): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

/** Return true if `error` represents an abort/cancellation error. */
export function isAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const record = error as { name?: unknown; code?: unknown };
    return record.name === 'AbortError' || record.code === 'ABORT_ERR';
}

/** Throw `AbortError` immediately if `signal` is already aborted. */
export function throwIfAborted(signal?: AbortSignal, message?: string): void {
    if (signal?.aborted) {
        const reason = signal.reason;
        if (reason instanceof Error && isAbortError(reason)) {
            throw reason;
        }
        throw createAbortError(message);
    }
}
