import { z } from 'zod';
import type { ToolExecutionContext, ToolVarsApi, ToolVarsOptions } from '@/core/bridge';
import { DecoratorParser } from '@/core/lore';
import type { MessageTarget, RawLoreEntry, VariableScope } from '@/core/types';
import { canonicalClone, canonicalStringify, stripJsonSchemaMeta } from '@/core/utils';
import type { VirtualFileSystem } from '@/core/vfs';
import { formatZodIssues, type ToolDefinition, type ToolValidationIssue } from './registry';
import { createAbortError, isAbortError, type SchemaEvaluator, throwIfAborted } from './script-sandbox';

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface JsonPatchOperation {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
    path: string;
    from?: string;
    value?: unknown;
}

export interface VariableValidationResult {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: string;
    issues?: ToolValidationIssue[];
}

export type DynamicVariableSchema = z.ZodTypeAny | Record<string, unknown> | string;

export interface VariableToolOptions {
    getSchema?: () => DynamicVariableSchema | undefined;
}

export interface VariableSchemaAwareApi extends ToolVarsApi {
    getSchema?: () => DynamicVariableSchema | undefined;
    replaceAll?: (
        nextVars: Record<string, unknown>,
        opts?: ToolVarsOptions,
    ) => Promise<Record<string, unknown>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto === null) {
        return true;
    }
    return (
        Object.prototype.toString.call(value) === '[object Object]' &&
        Object.getPrototypeOf(proto) === null
    );
}

function deepCloneJson<T>(value: T): T {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            // Fallback below
        }
    }
    return canonicalClone(value);
}

function deepEquals(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }
    if (a === null || b === null || typeof a !== typeof b) {
        return false;
    }
    if (typeof a !== 'object') {
        return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0; i < a.length; i += 1) {
            if (!deepEquals(a[i], b[i])) {
                return false;
            }
        }
        return true;
    }

    const recA = a as Record<string, unknown>;
    const recB = b as Record<string, unknown>;
    const keysA = Object.keys(recA);
    const keysB = Object.keys(recB);
    if (keysA.length !== keysB.length) {
        return false;
    }
    for (const key of keysA) {
        if (!Object.hasOwn(recB, key) || !deepEquals(recA[key], recB[key])) {
            return false;
        }
    }
    return true;
}

/** Parse RFC 6901 JSON Pointer (`/a/b/0`) into unescaped path segments. */
export function parseJsonPointer(pointer: string): string[] {
    if (typeof pointer !== 'string') {
        throw new Error('JSON Pointer path must be a string.');
    }
    if (pointer === '') {
        return [];
    }
    if (!pointer.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer "${pointer}": non-empty pointers must start with "/".`);
    }

    const segments = pointer
        .slice(1)
        .split('/')
        .map((seg) => seg.replace(/~1/g, '/').replace(/~0/g, '~'));

    for (const seg of segments) {
        if (FORBIDDEN_KEYS.has(seg)) {
            throw new Error(`Forbidden property segment "${seg}" in JSON Pointer "${pointer}".`);
        }
    }

    return segments;
}

function parseArrayIndex(segment: string, length: number, allowAppend: boolean): number {
    if (segment === '-' && allowAppend) {
        return length;
    }
    if (!/^(?:0|[1-9]\d*)$/.test(segment)) {
        throw new Error(`Invalid array index "${segment}".`);
    }
    const idx = Number(segment);
    const max = allowAppend ? length : length - 1;
    if (idx < 0 || idx > max) {
        throw new Error(`Array index ${idx} out of bounds (length ${length}).`);
    }
    return idx;
}

function resolveContainer(
    root: Record<string, unknown>,
    segments: string[],
    pointer: string,
    opIndex: number,
    opName: string,
): { parent: Record<string, unknown> | unknown[]; key: string } {
    let curr: unknown = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (Array.isArray(curr)) {
            const idx = parseArrayIndex(seg, curr.length, false);
            curr = curr[idx];
        } else if (isPlainObject(curr)) {
            if (!Object.hasOwn(curr, seg)) {
                throw new Error(
                    `Operation #${opIndex} (${opName}) failed at "${pointer}": parent segment "${seg}" does not exist.`,
                );
            }
            curr = curr[seg];
        } else {
            throw new Error(
                `Operation #${opIndex} (${opName}) failed at "${pointer}": segment "${seg}" cannot traverse non-container value.`,
            );
        }
    }

    if (!Array.isArray(curr) && !isPlainObject(curr)) {
        throw new Error(
            `Operation #${opIndex} (${opName}) failed at "${pointer}": parent is not an object or array.`,
        );
    }

    return {
        parent: curr,
        key: segments[segments.length - 1],
    };
}

function getAtPointer(root: Record<string, unknown>, segments: string[], pointer: string): unknown {
    let curr: unknown = root;
    for (const seg of segments) {
        if (Array.isArray(curr)) {
            const idx = parseArrayIndex(seg, curr.length, false);
            curr = curr[idx];
        } else if (isPlainObject(curr)) {
            if (!Object.hasOwn(curr, seg)) {
                throw new Error(`Path "${pointer}" does not exist (missing "${seg}").`);
            }
            curr = curr[seg];
        } else {
            throw new Error(`Path "${pointer}" cannot traverse non-container value at "${seg}".`);
        }
    }
    return curr;
}

function setAtPointer(
    root: Record<string, unknown>,
    segments: string[],
    value: unknown,
    mode: 'add' | 'replace',
    pointer: string,
    opIndex: number,
): Record<string, unknown> {
    if (segments.length === 0) {
        if (!isPlainObject(value)) {
            throw new Error(`Operation #${opIndex} (${mode}) at root "" requires a plain object.`);
        }
        return deepCloneJson(value);
    }

    const { parent, key } = resolveContainer(root, segments, pointer, opIndex, mode);
    const cloned = deepCloneJson(value);

    if (Array.isArray(parent)) {
        if (mode === 'add') {
            if (key === '-') {
                parent.push(cloned);
            } else {
                const idx = parseArrayIndex(key, parent.length, true);
                parent.splice(idx, 0, cloned);
            }
        } else {
            const idx = parseArrayIndex(key, parent.length, false);
            parent[idx] = cloned;
        }
        return root;
    }

    if (mode === 'replace' && !Object.hasOwn(parent, key)) {
        throw new Error(
            `Operation #${opIndex} (replace) failed at "${pointer}": target key "${key}" does not exist.`,
        );
    }

    parent[key] = cloned;
    return root;
}

function removeAtPointer(
    root: Record<string, unknown>,
    segments: string[],
    pointer: string,
    opIndex: number,
): unknown {
    if (segments.length === 0) {
        throw new Error(`Operation #${opIndex} (remove) cannot remove the root document.`);
    }

    const { parent, key } = resolveContainer(root, segments, pointer, opIndex, 'remove');
    if (Array.isArray(parent)) {
        const idx = parseArrayIndex(key, parent.length, false);
        const [removed] = parent.splice(idx, 1);
        return removed;
    }

    if (!Object.hasOwn(parent, key)) {
        throw new Error(
            `Operation #${opIndex} (remove) failed at "${pointer}": target key "${key}" does not exist.`,
        );
    }

    const prev = parent[key];
    delete parent[key];
    return prev;
}

/** Apply RFC 7396 JSON Merge Patch cleanly without mutating `target`. */
export function applyJsonMergePatch(
    target: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    if (!isPlainObject(patch)) {
        throw new Error('JSON Merge Patch payload must be a plain object.');
    }

    const result: Record<string, unknown> = isPlainObject(target) ? deepCloneJson(target) : {};
    for (const [key, value] of Object.entries(patch)) {
        if (FORBIDDEN_KEYS.has(key)) {
            throw new Error(`Forbidden property key "${key}" in JSON Merge Patch.`);
        }
        if (value === null) {
            delete result[key];
        } else if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = applyJsonMergePatch(result[key] as Record<string, unknown>, value);
        } else {
            result[key] = deepCloneJson(value);
        }
    }
    return result;
}

/** Apply RFC 6902 JSON Patch operations without mutating `doc`. */
export function applyJsonPatch(
    doc: Record<string, unknown>,
    operations: readonly JsonPatchOperation[],
): Record<string, unknown> {
    let working: Record<string, unknown> = isPlainObject(doc) ? deepCloneJson(doc) : {};

    for (let idx = 0; idx < operations.length; idx += 1) {
        const op = operations[idx];
        const segments = parseJsonPointer(op.path);

        switch (op.op) {
            case 'add': {
                working = setAtPointer(working, segments, op.value, 'add', op.path, idx);
                break;
            }
            case 'replace': {
                working = setAtPointer(working, segments, op.value, 'replace', op.path, idx);
                break;
            }
            case 'remove': {
                removeAtPointer(working, segments, op.path, idx);
                break;
            }
            case 'copy': {
                if (typeof op.from !== 'string') {
                    throw new Error(`Operation #${idx} (copy) requires a "from" JSON Pointer.`);
                }
                const fromSegs = parseJsonPointer(op.from);
                const val = getAtPointer(working, fromSegs, op.from);
                working = setAtPointer(working, segments, val, 'add', op.path, idx);
                break;
            }
            case 'move': {
                if (typeof op.from !== 'string') {
                    throw new Error(`Operation #${idx} (move) requires a "from" JSON Pointer.`);
                }
                if (op.from === op.path) {
                    break;
                }
                if (op.path.startsWith(`${op.from}/`)) {
                    throw new Error(
                        `Operation #${idx} (move) failed: destination "${op.path}" cannot be inside source "${op.from}".`,
                    );
                }
                const fromSegs = parseJsonPointer(op.from);
                const movedVal = removeAtPointer(working, fromSegs, op.from, idx);
                working = setAtPointer(working, segments, movedVal, 'add', op.path, idx);
                break;
            }
            case 'test': {
                const actual = getAtPointer(working, segments, op.path);
                if (!deepEquals(actual, op.value)) {
                    throw new Error(
                        `Operation #${idx} (test) failed at "${op.path}": expected ${canonicalStringify(op.value)}, got ${canonicalStringify(actual)}.`,
                    );
                }
                break;
            }
            default: {
                throw new Error(`Operation #${idx} has unsupported op "${String((op as { op?: unknown }).op)}".`);
            }
        }
    }

    return working;
}

function getZodTypeName(schema: unknown): string | undefined {
    if (!schema || typeof schema !== 'object') {
        return undefined;
    }
    const s = schema as { def?: { type?: string }; _def?: { typeName?: string } };
    return s.def?.type ?? s._def?.typeName;
}

function unwrapZodWrapper(schema: z.ZodTypeAny): {
    core: z.ZodTypeAny;
    isOptional: boolean;
    isNullable: boolean;
} {
    let isOptional = false;
    let isNullable = false;
    let current: z.ZodTypeAny = schema;

    while (current && typeof (current as unknown as { unwrap?: () => z.ZodTypeAny }).unwrap === 'function') {
        const t = getZodTypeName(current);
        if (t === 'optional' || t === 'ZodOptional') {
            isOptional = true;
            current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
        } else if (t === 'nullable' || t === 'ZodNullable') {
            isNullable = true;
            current = (current as unknown as { unwrap: () => z.ZodTypeAny }).unwrap();
        } else {
            break;
        }
    }

    return { core: current, isOptional, isNullable };
}

function isLooseObject(schema: z.ZodTypeAny): boolean {
    const s = schema as unknown as {
        def?: { catchall?: unknown };
        _def?: { unknownKeys?: string; catchall?: unknown };
    };
    const catchallType = getZodTypeName(s.def?.catchall ?? s._def?.catchall);
    return catchallType === 'unknown' || s._def?.unknownKeys === 'passthrough';
}

function isStrictObject(schema: z.ZodTypeAny): boolean {
    const s = schema as unknown as {
        def?: { catchall?: unknown };
        _def?: { unknownKeys?: string; catchall?: unknown };
    };
    const catchallType = getZodTypeName(s.def?.catchall ?? s._def?.catchall);
    return catchallType === 'never' || s._def?.unknownKeys === 'strict';
}

/** Recursively merge two Zod v4 schemas (`schemaB` overrides/extends `schemaA`). */
export function deepMergeZod(schemaA: z.ZodTypeAny, schemaB: z.ZodTypeAny): z.ZodTypeAny {
    const unwrappedA = unwrapZodWrapper(schemaA);
    const unwrappedB = unwrapZodWrapper(schemaB);

    const typeA = getZodTypeName(unwrappedA.core);
    const typeB = getZodTypeName(unwrappedB.core);

    const isObjA = typeA === 'object' || typeA === 'ZodObject';
    const isObjB = typeB === 'object' || typeB === 'ZodObject';
    const isArrA = typeA === 'array' || typeA === 'ZodArray';
    const isArrB = typeB === 'array' || typeB === 'ZodArray';

    let mergedCore: z.ZodTypeAny;

    if (isObjA && isObjB) {
        const shapeA = (unwrappedA.core as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
        const shapeB = (unwrappedB.core as z.ZodObject<Record<string, z.ZodTypeAny>>).shape;
        const mergedShape: Record<string, z.ZodTypeAny> = { ...shapeA };

        for (const [key, valB] of Object.entries(shapeB)) {
            if (Object.hasOwn(shapeA, key)) {
                mergedShape[key] = deepMergeZod(shapeA[key], valB);
            } else {
                mergedShape[key] = valB;
            }
        }

        const allowLoose =
            (isLooseObject(unwrappedA.core) || isLooseObject(unwrappedB.core))
            && !isStrictObject(unwrappedA.core)
            && !isStrictObject(unwrappedB.core);

        mergedCore = allowLoose ? z.looseObject(mergedShape) : z.object(mergedShape);
    } else if (isArrA && isArrB) {
        const elA = (unwrappedA.core as unknown as { element: z.ZodTypeAny }).element;
        const elB = (unwrappedB.core as unknown as { element: z.ZodTypeAny }).element;
        mergedCore = z.array(deepMergeZod(elA, elB));
    } else {
        mergedCore = unwrappedB.core;
    }

    let result = mergedCore;
    if (unwrappedB.isNullable) {
        result = result.nullable();
    }
    if (unwrappedB.isOptional) {
        result = result.optional();
    }
    return result;
}

function stripCodeFence(raw: string): string {
    const trimmed = raw.trim();
    const fence = /^```(?:json|js|ts|javascript|typescript)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(trimmed);
    return fence ? fence[1].trim() : trimmed;
}

/** Compile a JSON Schema object or JSON string into a Zod v4 schema via `z.fromJSONSchema`. */
export function compileJsonSchema(raw: string | Record<string, unknown>): z.ZodTypeAny {
    let schemaObj: Record<string, unknown>;
    if (typeof raw === 'string') {
        const cleaned = stripCodeFence(raw);
        const parsed = JSON.parse(cleaned) as unknown;
        if (!isPlainObject(parsed)) {
            throw new Error('@@json_schema must parse to a JSON object.');
        }
        schemaObj = parsed;
    } else if (isPlainObject(raw)) {
        schemaObj = raw;
    } else {
        throw new Error('JSON Schema must be a plain object or JSON string.');
    }

    return z.fromJSONSchema(schemaObj as Parameters<typeof z.fromJSONSchema>[0]) as z.ZodTypeAny;
}

/** Resolve a `DynamicVariableSchema` (Zod schema, JSON Schema object, or JSON string) to Zod. */
export function resolveVariableZodSchema(
    schema: DynamicVariableSchema | undefined,
): z.ZodTypeAny | undefined {
    if (!schema) {
        return undefined;
    }
    if (typeof schema === 'string') {
        return compileJsonSchema(schema);
    }
    if (typeof (schema as z.ZodTypeAny).safeParse === 'function') {
        return schema as z.ZodTypeAny;
    }
    if (isPlainObject(schema)) {
        return compileJsonSchema(schema);
    }
    return undefined;
}

/**
 * Compile and merge `@@json_schema` and `@@zod_schema` World Info entries in ascending `order`.
 * `@@zod_schema` entries execute inside the provided `SchemaEvaluator` (network-disabled mode).
 */
export async function compileVariableSchemaEntries(
    entries: readonly RawLoreEntry[],
    schemaEvaluator?: SchemaEvaluator,
): Promise<z.ZodObject<Record<string, z.ZodTypeAny>>> {
    const schemaEntries = entries
        .filter((e) => !e.disable)
        .map((entry) => ({ entry, parsed: DecoratorParser.parseEntry(entry) }))
        .filter(({ parsed }) =>
            parsed.decorators.some((d) => d.name === '@@json_schema' || d.name === '@@zod_schema'),
        )
        .sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0));

    let merged: z.ZodTypeAny = z.looseObject({});

    for (const { entry, parsed } of schemaEntries) {
        const jsonDec = parsed.decorators.find((d) => d.name === '@@json_schema');
        const zodDec = parsed.decorators.find((d) => d.name === '@@zod_schema');

        if (jsonDec) {
            const rawSource = jsonDec.rawArgs.trim() || parsed.cleanContent.trim();
            if (!rawSource) {
                continue;
            }
            const compiled = compileJsonSchema(rawSource);
            if (getZodTypeName(compiled) !== 'object') {
                throw new Error(
                    `@@json_schema in "${entry.world}/${entry.comment || entry.uid}" must define an object schema.`,
                );
            }
            merged = deepMergeZod(merged, compiled);
        } else if (zodDec) {
            if (!schemaEvaluator) {
                throw new Error(
                    `@@zod_schema in "${entry.world}/${entry.comment || entry.uid}" requires a SchemaEvaluator.`,
                );
            }
            const rawCode = zodDec.rawArgs.trim() || stripCodeFence(parsed.cleanContent);
            if (!rawCode) {
                continue;
            }
            const compiled = await schemaEvaluator.evaluateSchema(rawCode);
            if (getZodTypeName(compiled) !== 'object') {
                throw new Error(
                    `@@zod_schema in "${entry.world}/${entry.comment || entry.uid}" must evaluate to a z.object(...) schema.`,
                );
            }
            merged = deepMergeZod(merged, compiled);
        }
    }

    return merged as z.ZodObject<Record<string, z.ZodTypeAny>>;
}

/** Validate a variables object against a Zod or JSON Schema, returning field-path diagnostics. */
export function validateVariablesWithSchema(
    candidate: Record<string, unknown>,
    schema: DynamicVariableSchema | undefined,
): VariableValidationResult {
    const zodSchema = resolveVariableZodSchema(schema);
    if (!zodSchema) {
        return { ok: true, data: candidate };
    }

    const parsed = zodSchema.safeParse(candidate);
    if (!parsed.success) {
        const issues = formatZodIssues(parsed.error);
        const summary = issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
        return {
            ok: false,
            error: `Variable schema validation failed — no changes were saved. Fix the invalid field(s) and retry: ${summary}`,
            issues,
        };
    }

    const data = isPlainObject(parsed.data) ? parsed.data : candidate;
    return { ok: true, data };
}

function readNestedVarPath(vars: Record<string, unknown>, rawPath: string): unknown {
    const segments = rawPath.startsWith('/')
        ? parseJsonPointer(rawPath)
        : rawPath.split('.').filter(Boolean);

    let curr: unknown = vars;
    for (const seg of segments) {
        if (FORBIDDEN_KEYS.has(seg)) {
            return undefined;
        }
        if (Array.isArray(curr) && /^(?:0|[1-9]\d*)$/.test(seg)) {
            curr = curr[Number(seg)];
        } else if (isPlainObject(curr) && Object.hasOwn(curr, seg)) {
            curr = curr[seg];
        } else {
            return undefined;
        }
    }
    return curr;
}

function setNestedVarPath(
    vars: Record<string, unknown>,
    rawPath: string,
    value: unknown,
): Record<string, unknown> {
    const segments = rawPath.startsWith('/')
        ? parseJsonPointer(rawPath)
        : rawPath.split('.').filter(Boolean);

    if (segments.length === 0) {
        if (!isPlainObject(value)) {
            throw new Error('Setting root variables requires a plain object.');
        }
        return deepCloneJson(value);
    }

    const next = deepCloneJson(vars);
    let curr: Record<string, unknown> = next;

    for (let i = 0; i < segments.length - 1; i += 1) {
        const seg = segments[i];
        if (FORBIDDEN_KEYS.has(seg)) {
            throw new Error(`Forbidden variable path segment "${seg}".`);
        }
        const existing = curr[seg];
        if (!isPlainObject(existing)) {
            curr[seg] = {};
        }
        curr = curr[seg] as Record<string, unknown>;
    }

    const leaf = segments[segments.length - 1];
    if (FORBIDDEN_KEYS.has(leaf)) {
        throw new Error(`Forbidden variable path segment "${leaf}".`);
    }
    curr[leaf] = deepCloneJson(value);
    return next;
}

export interface VfsVarsAdapterOptions {
    target?: MessageTarget;
    staged?: boolean;
    source?: string;
    signal?: AbortSignal;
    getSchema?: () => DynamicVariableSchema | undefined;
}

/**
 * `ToolVarsApi` adapter backed by `VirtualFileSystem`'s `/state/variables.json`
 * bound to a causal `MessageTarget` and optional dynamic variable schema.
 */
export class VfsVarsAdapter implements VariableSchemaAwareApi {
    private readonly target?: MessageTarget;
    private readonly staged?: boolean;
    private readonly source: string;
    private readonly signal?: AbortSignal;
    private readonly schemaProvider?: () => DynamicVariableSchema | undefined;

    constructor(
        private readonly vfs: VirtualFileSystem,
        options: VfsVarsAdapterOptions = {},
    ) {
        this.target = options.target;
        this.staged = options.staged;
        this.source = options.source ?? 'tool-vars';
        this.signal = options.signal;
        this.schemaProvider = options.getSchema;
    }

    getSchema(): DynamicVariableSchema | undefined {
        return this.schemaProvider?.();
    }

    async get(path?: string, opts?: ToolVarsOptions): Promise<unknown> {
        throwIfAborted(this.signal);
        const scope: VariableScope = opts?.scope ?? 'message';
        const vars = await this.vfs.readVariables({
            target: this.target,
            staged: this.staged,
            scope,
        });
        if (!path || !path.trim()) {
            return vars;
        }
        return readNestedVarPath(vars, path.trim());
    }

    async set(path: string, value: unknown, opts?: ToolVarsOptions): Promise<void> {
        throwIfAborted(this.signal);
        const scope: VariableScope = opts?.scope ?? 'message';
        const current = await this.vfs.readVariables({
            target: this.target,
            staged: this.staged,
            scope,
        });
        const candidate = setNestedVarPath(current, path, value);
        const validation =
            scope === 'message'
                ? validateVariablesWithSchema(candidate, this.getSchema())
                : { ok: true, data: candidate };
        if (!validation.ok) {
            throw new Error(validation.error);
        }
        await this.vfs.writeVariables(validation.data ?? candidate, {
            target: this.target,
            staged: this.staged,
            source: this.source,
            scope,
        });
    }

    async patch(
        ops: Record<string, unknown> | Array<Record<string, unknown>>,
        opts?: ToolVarsOptions,
    ): Promise<Record<string, unknown>> {
        throwIfAborted(this.signal);
        const scope: VariableScope = opts?.scope ?? 'message';
        const current = await this.vfs.readVariables({
            target: this.target,
            staged: this.staged,
            scope,
        });
        const candidate = Array.isArray(ops)
            ? applyJsonPatch(current, ops as unknown as JsonPatchOperation[])
            : applyJsonMergePatch(current, ops);

        const validation =
            scope === 'message'
                ? validateVariablesWithSchema(candidate, this.getSchema())
                : { ok: true, data: candidate };
        if (!validation.ok) {
            throw new Error(validation.error);
        }

        const finalVars = validation.data ?? candidate;
        await this.vfs.writeVariables(finalVars, {
            target: this.target,
            staged: this.staged,
            source: this.source,
            scope,
        });
        return finalVars;
    }

    async replaceAll(
        nextVars: Record<string, unknown>,
        opts?: ToolVarsOptions,
    ): Promise<Record<string, unknown>> {
        throwIfAborted(this.signal);
        const scope: VariableScope = opts?.scope ?? 'message';
        const normalized = isPlainObject(nextVars) ? deepCloneJson(nextVars) : nextVars;
        const validation =
            scope === 'message'
                ? validateVariablesWithSchema(normalized, this.getSchema())
                : { ok: true, data: normalized };
        if (!validation.ok) {
            throw new Error(validation.error);
        }
        const finalVars = validation.data ?? normalized;
        await this.vfs.writeVariables(finalVars, {
            target: this.target,
            staged: this.staged,
            source: this.source,
            scope,
        });
        return finalVars;
    }
}

const VARIABLE_SCOPE_SCHEMA = z
    .enum(['message', 'chat', 'global'])
    .optional()
    .default('message')
    .describe(
        'Variable scope: "message" (default, /state/variables.json, chat[id].variables[swipe_id]), "chat" (/state/chat_variables.json, chat_metadata.variables), or "global" (/state/global_variables.json, extension_settings.variables.global).',
    );

const READ_VARIABLES_SCHEMA = z.object({
    path: z
        .string()
        .optional()
        .describe('Optional dot-notation or JSON pointer path (e.g. "player.hp" or "/stats/gold"). Omit to read all variables.'),
    scope: VARIABLE_SCOPE_SCHEMA,
    include_schema: z
        .boolean()
        .optional()
        .default(false)
        .describe('Include the active JSON Schema for message-scope variables when available.'),
    default_value: z
        .unknown()
        .optional()
        .describe('Fallback value returned when the requested path is undefined.'),
});

const JSON_PATCH_OP_SCHEMA = z.object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']).describe('RFC 6902 patch operation.'),
    path: z.string().describe('RFC 6901 JSON Pointer target path, e.g. "/hp" or "/inventory/0".'),
    from: z.string().optional().describe('Source JSON Pointer path required for "move" and "copy".'),
    value: z.unknown().optional().describe('Value required for "add", "replace", and "test".'),
});

const PATCH_VARIABLES_SCHEMA = z.object({
    scope: VARIABLE_SCOPE_SCHEMA,
    json_merge: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('RFC 7396 JSON Merge Patch object (nested objects merge; null deletes a key).'),
    json_patch: z
        .array(JSON_PATCH_OP_SCHEMA)
        .optional()
        .describe('RFC 6902 JSON Patch operations array: [{ op, path, from?, value? }].'),
});

/** Create `read_variables` and `patch_variables` with optional dynamic schema validation. */
export function createVariableTools(options: VariableToolOptions = {}): ToolDefinition[] {
    const resolveSchema = (ctx: ToolExecutionContext): DynamicVariableSchema | undefined => {
        const aware = ctx.vars as VariableSchemaAwareApi;
        return aware.getSchema?.() ?? options.getSchema?.();
    };

    const readVariablesTool: ToolDefinition<typeof READ_VARIABLES_SCHEMA> = {
        name: 'read_variables',
        description:
            'Read state variables from SillyTavern native storage (/state/variables.json for message branch, /state/chat_variables.json for chat, /state/global_variables.json for global), optionally at a specific path or with the active variable JSON Schema.',
        parameters: READ_VARIABLES_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const scope: VariableScope = args.scope ?? 'message';
                const rawValue = await ctx.vars.get(args.path, { scope });
                const value =
                    rawValue !== undefined
                        ? rawValue
                        : args.default_value !== undefined
                            ? args.default_value
                            : args.path
                                ? null
                                : {};

                let jsonSchema: Record<string, unknown> | undefined;
                if (args.include_schema && scope === 'message') {
                    const zodSchema = resolveVariableZodSchema(resolveSchema(ctx));
                    if (zodSchema) {
                        jsonSchema = stripJsonSchemaMeta(
                            z.toJSONSchema(zodSchema, { io: 'input', unrepresentable: 'any' }),
                        );
                    }
                }

                return JSON.stringify({
                    ok: true,
                    scope,
                    ...(args.path ? { path: args.path } : {}),
                    variables: value,
                    ...(jsonSchema ? { json_schema: jsonSchema } : {}),
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ ok: false, error: message });
            }
        },
    };

    const patchVariablesTool: ToolDefinition<typeof PATCH_VARIABLES_SCHEMA> = {
        name: 'patch_variables',
        description:
            'Update SillyTavern native variables (/state/variables.json for message branch, /state/chat_variables.json for chat, /state/global_variables.json for global) using RFC 7396 json_merge and/or RFC 6902 json_patch, validating message-scope variables against any active @@json_schema or @@zod_schema before committing.',
        parameters: PATCH_VARIABLES_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            if (!args.json_merge && (!args.json_patch || args.json_patch.length === 0)) {
                return JSON.stringify({
                    ok: false,
                    error: 'Provide at least one of "json_merge" or non-empty "json_patch".',
                });
            }

            try {
                const scope: VariableScope = args.scope ?? 'message';
                const rawCurrent = await ctx.vars.get(undefined, { scope });
                let candidate: Record<string, unknown> = isPlainObject(rawCurrent)
                    ? deepCloneJson(rawCurrent)
                    : {};

                if (args.json_merge) {
                    candidate = applyJsonMergePatch(candidate, args.json_merge);
                }
                if (args.json_patch && args.json_patch.length > 0) {
                    candidate = applyJsonPatch(candidate, args.json_patch);
                }

                const activeSchema = scope === 'message' ? resolveSchema(ctx) : undefined;
                const validation = validateVariablesWithSchema(candidate, activeSchema);
                if (!validation.ok) {
                    return JSON.stringify({
                        ok: false,
                        error: validation.error,
                        issues: validation.issues ?? [],
                    });
                }

                const validatedVars = validation.data ?? candidate;
                const aware = ctx.vars as VariableSchemaAwareApi;
                let persisted: Record<string, unknown>;

                if (typeof aware.replaceAll === 'function') {
                    persisted = await aware.replaceAll(validatedVars, { scope });
                } else {
                    const schemaMutated = activeSchema !== undefined && !deepEquals(candidate, validatedVars);
                    if (schemaMutated) {
                        persisted = await ctx.vars.patch(validatedVars, { scope });
                    } else if (args.json_merge && args.json_patch?.length) {
                        await ctx.vars.patch(args.json_merge, { scope });
                        persisted = await ctx.vars.patch(
                            args.json_patch as unknown as Array<Record<string, unknown>>,
                            { scope },
                        );
                    } else if (args.json_merge) {
                        persisted = await ctx.vars.patch(args.json_merge, { scope });
                    } else {
                        persisted = await ctx.vars.patch(
                            args.json_patch as unknown as Array<Record<string, unknown>>,
                            { scope },
                        );
                    }
                }

                return JSON.stringify({
                    ok: true,
                    scope,
                    target: ctx.target,
                    variables: persisted,
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ ok: false, error: message });
            }
        },
    };

    return [readVariablesTool, patchVariablesTool];
}
