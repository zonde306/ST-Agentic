import _ from 'lodash';
import { z } from 'zod';
import type {
    ToolAgentApi,
    ToolAgentRunOptions,
    ToolAgentRunTriggerOptions,
    ToolEphemeralMessagesApi,
    ToolErrorRecoveryControl,
    ToolEventPayload,
    ToolExecutionContext,
    ToolPostprocessControl,
    ToolPostprocessOutput,
    ToolSideCluesApi,
    ToolSideGenApi,
} from '@/core/bridge';
import {
    type CompiledSandboxTool,
    createAbortError,
    defineTool,
    isAbortError,
    type SandboxCompileOptions,
    SandboxExecutionError,
    type SandboxRunOptions,
    SandboxSecurityError,
    type SandboxToolDefinition,
    type SchemaEvalOptions,
    type ScriptSandbox,
    throwIfAborted,
} from '@/core/tools';
import type {
    CanonicalMessage,
    CreateSideSessionOptions,
    ExportWorldInfoOptions,
    MessageTarget,
    SideClueDelivery,
    SideClueStatus,
    SideClueWriteInput,
    SideGenOnceOptions,
    SideGenSendOptions,
    SideSessionFilter,
} from '@/core/types';
import { ManagedSandboxHandle, SandboxLifecycleManager } from './lifecycle';

export type SandboxSideGenErrorCode =
    | 'SIDEGEN_UNAVAILABLE'
    | 'SIDEGEN_DISPOSED'
    | 'SIDEGEN_INVALID_ARGS';

/** Structured error thrown by the sandbox `ctx.sideGen` host proxy boundary. */
export class SandboxSideGenError extends SandboxExecutionError {
    public readonly code: SandboxSideGenErrorCode;
    public readonly method: string;

    constructor(
        code: SandboxSideGenErrorCode,
        method: string,
        message: string,
        causeError?: unknown,
    ) {
        super(message, causeError);
        this.name = 'SandboxSideGenError';
        this.code = code;
        this.method = method;
    }
}

export type SandboxAgentErrorCode =
    | 'AGENT_UNAVAILABLE'
    | 'AGENT_DISPOSED'
    | 'AGENT_INVALID_ARGS';

/** Structured error thrown by the sandbox `ctx.agent` host proxy boundary. */
export class SandboxAgentError extends SandboxExecutionError {
    public readonly code: SandboxAgentErrorCode;
    public readonly method: string;

    constructor(
        code: SandboxAgentErrorCode,
        method: string,
        message: string,
        causeError?: unknown,
    ) {
        super(message, causeError);
        this.name = 'SandboxAgentError';
        this.code = code;
        this.method = method;
    }
}

export interface IframeJsSandboxOptions {
    lifecycle?: SandboxLifecycleManager;
    defaultTimeoutMs?: number;
}

const UNSAFE_LODASH_KEYS = new Set(['template', 'runInContext', 'noConflict', 'mixin', 'VERSION']);

const ALWAYS_BLOCKED_PROPS = new Set<string | symbol>([
    'parent',
    'top',
    'frameElement',
    'opener',
    'open',
]);

const NETWORK_BLOCKED_PROPS = new Set<string | symbol>([
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'ServiceWorker',
    'RTCPeerConnection',
    'importScripts',
]);

const SCHEMA_ONLY_BLOCKED_PROPS = new Set<string | symbol>([
    'eval',
    'Function',
    'document',
    'location',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'caches',
]);

const NODE_ONLY_BLOCKED_PROPS = new Set<string | symbol>([
    'process',
    'global',
    'require',
    'module',
    'exports',
    '__dirname',
    '__filename',
    'Buffer',
]);

let cachedSafeLodash: Record<string, unknown> | null = null;

/** Create a frozen safe Lodash helper object free of template evaluation and global mixin hooks. */
export function createSafeLodash(): Record<string, unknown> {
    if (cachedSafeLodash) {
        return cachedSafeLodash;
    }

    const safe: Record<string, unknown> = {};
    for (const key of Object.keys(_)) {
        if (UNSAFE_LODASH_KEYS.has(key)) {
            continue;
        }
        const val = (_ as unknown as Record<string, unknown>)[key];
        if (typeof val === 'function') {
            safe[key] = val;
        }
    }
    cachedSafeLodash = Object.freeze(safe);
    return cachedSafeLodash;
}

function stripMarkdownFence(raw: string): string {
    const trimmed = raw.trim();
    const fence = /^```(?:js|ts|javascript|typescript|mjs|cjs)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(trimmed);
    return fence ? fence[1].trim() : trimmed;
}

/**
 * Normalize user tool/script source so `export default ...`, `export const ...`,
 * and markdown fences compile inside an isolated sandbox function body.
 */
export function prepareSandboxScript(rawCode: string): {
    code: string;
    hasExportDefault: boolean;
} {
    const unfenced = stripMarkdownFence(rawCode);
    let hasExportDefault = false;

    let transformed = unfenced.replace(
        /(^|\n)([ \t]*)export\s+default\s+/g,
        (_m, prefix: string, indent: string) => {
            hasExportDefault = true;
            return `${prefix}${indent}__agenticDefaultExport__ = `;
        },
    );

    transformed = transformed.replace(
        /(^|\n)([ \t]*)export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/g,
        '$1$2',
    );

    return {
        code: transformed.trim(),
        hasExportDefault,
    };
}

function createBlockedNavigatorProxy(baseNavigator: Navigator | undefined): unknown {
    const fallbackTarget = (baseNavigator ?? {}) as object;
    return new Proxy(fallbackTarget, {
        get(target, prop) {
            if (prop === 'sendBeacon' || prop === 'share' || prop === 'clipboard') {
                return () => {
                    throw new SandboxSecurityError(`navigator.${String(prop)}`);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

function combineAbortSignals(
    primary?: AbortSignal,
    secondary?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
    if (!primary && !secondary) {
        return { signal: new AbortController().signal, cleanup: () => {} };
    }
    if (!primary && secondary) {
        return { signal: secondary, cleanup: () => {} };
    }
    if (primary && !secondary) {
        return { signal: primary, cleanup: () => {} };
    }

    const controller = new AbortController();
    const a = primary!;
    const b = secondary!;

    if (a.aborted) {
        controller.abort(a.reason ?? createAbortError());
        return { signal: controller.signal, cleanup: () => {} };
    }
    if (b.aborted) {
        controller.abort(b.reason ?? createAbortError());
        return { signal: controller.signal, cleanup: () => {} };
    }

    const onAbortA = () => controller.abort(a.reason ?? createAbortError());
    const onAbortB = () => controller.abort(b.reason ?? createAbortError());

    a.addEventListener('abort', onAbortA, { once: true });
    b.addEventListener('abort', onAbortB, { once: true });

    return {
        signal: controller.signal,
        cleanup: () => {
            a.removeEventListener('abort', onAbortA);
            b.removeEventListener('abort', onAbortB);
        },
    };
}

const MAX_CUSTOM_TOOL_TIMEOUT_MS = 600_000;

function resolveToolTimeoutMs(candidate: number | undefined, fallback: number): number {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
        return Math.min(Math.max(1, Math.floor(candidate)), MAX_CUSTOM_TOOL_TIMEOUT_MS);
    }
    return fallback;
}

function raceWithSignalAndTimeout<T>(
    promise: Promise<T>,
    signal?: AbortSignal,
    timeoutMs?: number,
    label: string = 'Sandbox execution',
): Promise<T> {
    throwIfAborted(signal);

    return new Promise<T>((resolve, reject) => {
        let settled = false;
        let timerId: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            if (timerId !== undefined) {
                globalThis.clearTimeout(timerId);
                timerId = undefined;
            }
            signal?.removeEventListener('abort', onAbort);
        };

        const onAbort = () => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            const reason = signal?.reason;
            if (reason instanceof Error && isAbortError(reason)) {
                reject(reason);
            } else {
                reject(createAbortError(`${label} aborted`));
            }
        };

        if (signal) {
            signal.addEventListener('abort', onAbort, { once: true });
        }

        if (timeoutMs && timeoutMs > 0) {
            timerId = globalThis.setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(new SandboxExecutionError(`${label} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
        }

        promise.then(
            (val) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(val);
            },
            (err) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                reject(err);
            },
        );
    });
}

function getZodTypeName(schema: unknown): string | undefined {
    if (!schema || typeof schema !== 'object') {
        return undefined;
    }
    const s = schema as { def?: { type?: string }; _def?: { typeName?: string } };
    return s.def?.type ?? s._def?.typeName;
}

function isZodSchemaObject(val: unknown): val is z.ZodTypeAny {
    return Boolean(
        val
        && typeof val === 'object'
        && typeof (val as z.ZodTypeAny).safeParse === 'function',
    );
}

function isAbortSignalLike(val: unknown): val is AbortSignal {
    return Boolean(
        val
        && typeof val === 'object'
        && typeof (val as AbortSignal).aborted === 'boolean'
        && typeof (val as AbortSignal).addEventListener === 'function'
        && typeof (val as AbortSignal).removeEventListener === 'function',
    );
}

function cloneBoundaryValue<T>(value: T, method: string): T {
    if (value === undefined || value === null) {
        return value;
    }
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
        return value;
    }
    try {
        if (typeof globalThis.structuredClone === 'function') {
            return globalThis.structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value)) as T;
    } catch (error) {
        throw new SandboxSideGenError(
            'SIDEGEN_INVALID_ARGS',
            method,
            `ctx.${method}() received non-serializable data across the sandbox boundary.`,
            error,
        );
    }
}

function assertRecordArg(
    value: unknown,
    method: string,
    argName: string,
): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new SandboxSideGenError(
            'SIDEGEN_INVALID_ARGS',
            method,
            `ctx.${method}() requires "${argName}" to be a plain object.`,
        );
    }
    return value as Record<string, unknown>;
}

function assertStringArg(value: unknown, method: string, argName: string): string {
    if (typeof value !== 'string') {
        throw new SandboxSideGenError(
            'SIDEGEN_INVALID_ARGS',
            method,
            `ctx.${method}() requires "${argName}" to be a string.`,
        );
    }
    return value;
}

function extractSignalAndCloneOptions<T extends { signal?: AbortSignal }>(
    rawOpts: unknown,
    method: string,
    required: boolean,
): { options: Omit<T, 'signal'>; callerSignal?: AbortSignal } {
    if (rawOpts === undefined) {
        if (required) {
            throw new SandboxSideGenError(
                'SIDEGEN_INVALID_ARGS',
                method,
                `ctx.${method}() requires an options object.`,
            );
        }
        return { options: {} as Omit<T, 'signal'> };
    }

    const record = assertRecordArg(rawOpts, method, 'options');
    let callerSignal: AbortSignal | undefined;
    if (record.signal !== undefined) {
        if (!isAbortSignalLike(record.signal)) {
            throw new SandboxSideGenError(
                'SIDEGEN_INVALID_ARGS',
                method,
                `ctx.${method}() received an invalid AbortSignal in options.signal.`,
            );
        }
        callerSignal = record.signal;
    }

    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (key === 'signal') {
            continue;
        }
        copy[key] = record[key];
    }

    return {
        options: cloneBoundaryValue(copy, method) as Omit<T, 'signal'>,
        callerSignal,
    };
}

/**
 * Create a frozen, null-prototype host-side proxy for `ctx.sideGen` inside the JS sandbox.
 *
 * - Exposes only the allowlisted `ToolSideGenApi` and `ToolSideCluesApi` methods
 *   (never leaks host `SideGenService` internals such as `sessionStore`, `trajectoryStore`,
 *   `abortAll`, or host prototypes).
 * - Strictly binds/forwards the parent sandbox `AbortSignal` into `runOnce` and `send`
 *   so aborting or disposing the sandbox immediately cancels in-flight SideGen LLM calls.
 * - Executes all LLM work strictly on the host side without relaxing iframe network isolation.
 * - Throws structured `SandboxSideGenError` (`SIDEGEN_UNAVAILABLE` / `SIDEGEN_DISPOSED` /
 *   `SIDEGEN_INVALID_ARGS`) when unconfigured, disposed, or misused.
 */
function createSandboxSideGenProxy(
    hostSideGen: ToolSideGenApi | undefined,
    parentSignal: AbortSignal,
    isDisposed: () => boolean,
): ToolSideGenApi {
    const assertReady = (method: string, signal: AbortSignal): ToolSideGenApi => {
        if (isDisposed()) {
            throw new SandboxSideGenError(
                'SIDEGEN_DISPOSED',
                method,
                `ctx.${method}() failed: sandbox has been disposed.`,
            );
        }
        throwIfAborted(signal, `ctx.${method}() aborted`);
        if (!hostSideGen) {
            throw new SandboxSideGenError(
                'SIDEGEN_UNAVAILABLE',
                method,
                `ctx.${method}() failed: SideGen service is not configured in this execution context.`,
            );
        }
        return hostSideGen;
    };

    const invokeHost = async <T>(
        method: string,
        signal: AbortSignal,
        executor: (api: ToolSideGenApi) => Promise<T>,
    ): Promise<T> => {
        const api = assertReady(method, signal);
        const result = await raceWithSignalAndTimeout(
            Promise.resolve().then(() => executor(api)),
            signal,
            undefined,
            `ctx.${method}()`,
        );
        if (isDisposed()) {
            throw new SandboxSideGenError(
                'SIDEGEN_DISPOSED',
                method,
                `ctx.${method}() failed: sandbox was disposed during execution.`,
            );
        }
        throwIfAborted(signal, `ctx.${method}() aborted`);
        return cloneBoundaryValue(result, method);
    };

    const invokeClues = async <T>(
        method: string,
        executor: (clues: ToolSideCluesApi) => Promise<T>,
    ): Promise<T> => {
        return await invokeHost(method, parentSignal, (api) => {
            if (!api.clues) {
                throw new SandboxSideGenError(
                    'SIDEGEN_UNAVAILABLE',
                    method,
                    `ctx.${method}() failed: SideGen clues facade is not configured.`,
                );
            }
            return executor(api.clues);
        });
    };

    const cloneOptionalTarget = (
        target: unknown,
        method: string,
    ): MessageTarget | undefined => {
        if (target === undefined) {
            return undefined;
        }
        const record = assertRecordArg(target, method, 'target');
        return cloneBoundaryValue(record, method) as unknown as MessageTarget;
    };

    const cluesMethods: ToolSideCluesApi = {
        async write(input: SideClueWriteInput) {
            const method = 'sideGen.clues.write';
            assertReady(method, parentSignal);
            const cleanInput = cloneBoundaryValue(
                assertRecordArg(input, method, 'input'),
                method,
            ) as unknown as SideClueWriteInput;
            return await invokeClues(method, (clues) => clues.write(cleanInput));
        },

        async read(path: string, target?: MessageTarget) {
            const method = 'sideGen.clues.read';
            assertReady(method, parentSignal);
            const safePath = assertStringArg(path, method, 'path');
            const safeTarget = cloneOptionalTarget(target, method);
            return await invokeClues(method, (clues) => clues.read(safePath, safeTarget));
        },

        async list(target?: MessageTarget) {
            const method = 'sideGen.clues.list';
            assertReady(method, parentSignal);
            const safeTarget = cloneOptionalTarget(target, method);
            return await invokeClues(method, (clues) => clues.list(safeTarget));
        },

        async updateDelivery(
            path: string,
            delivery: SideClueDelivery,
            target?: MessageTarget,
        ) {
            const method = 'sideGen.clues.updateDelivery';
            assertReady(method, parentSignal);
            const safePath = assertStringArg(path, method, 'path');
            const safeDelivery = assertStringArg(
                delivery,
                method,
                'delivery',
            ) as SideClueDelivery;
            const safeTarget = cloneOptionalTarget(target, method);
            return await invokeClues(method, (clues) =>
                clues.updateDelivery(safePath, safeDelivery, safeTarget),
            );
        },

        async updateStatus(
            path: string,
            status: SideClueStatus,
            target?: MessageTarget,
        ) {
            const method = 'sideGen.clues.updateStatus';
            assertReady(method, parentSignal);
            const safePath = assertStringArg(path, method, 'path');
            const safeStatus = assertStringArg(status, method, 'status') as SideClueStatus;
            const safeTarget = cloneOptionalTarget(target, method);
            return await invokeClues(method, (clues) =>
                clues.updateStatus(safePath, safeStatus, safeTarget),
            );
        },

        async delete(path: string, target?: MessageTarget) {
            const method = 'sideGen.clues.delete';
            assertReady(method, parentSignal);
            const safePath = assertStringArg(path, method, 'path');
            const safeTarget = cloneOptionalTarget(target, method);
            return await invokeClues(method, (clues) => clues.delete(safePath, safeTarget));
        },

        async exportToWorldInfo(path: string, options?: ExportWorldInfoOptions) {
            const method = 'sideGen.clues.exportToWorldInfo';
            assertReady(method, parentSignal);
            const safePath = assertStringArg(path, method, 'path');
            const safeOptions =
                options === undefined
                    ? undefined
                    : (cloneBoundaryValue(
                        assertRecordArg(options, method, 'options'),
                        method,
                    ) as unknown as ExportWorldInfoOptions);
            return await invokeClues(method, (clues) =>
                clues.exportToWorldInfo(safePath, safeOptions),
            );
        },
    };

    const frozenClues: ToolSideCluesApi = Object.freeze(
        Object.assign(Object.create(null) as object, cluesMethods),
    ) as ToolSideCluesApi;

    const sideGenMethods: ToolSideGenApi = {
        async runOnce(opts: SideGenOnceOptions) {
            const method = 'sideGen.runOnce';
            assertReady(method, parentSignal);
            const { options: cleanOpts, callerSignal } =
                extractSignalAndCloneOptions<SideGenOnceOptions>(opts, method, true);
            const linked = combineAbortSignals(parentSignal, callerSignal);
            try {
                return await invokeHost(method, linked.signal, (api) =>
                    api.runOnce({
                        ...cleanOpts,
                        signal: linked.signal,
                    }),
                );
            } finally {
                linked.cleanup();
            }
        },

        async createSession(opts: CreateSideSessionOptions) {
            const method = 'sideGen.createSession';
            assertReady(method, parentSignal);
            const cleanOpts = cloneBoundaryValue(
                assertRecordArg(opts, method, 'options'),
                method,
            ) as unknown as CreateSideSessionOptions;
            return await invokeHost(method, parentSignal, (api) =>
                api.createSession(cleanOpts),
            );
        },

        async send(sessionId: string, prompt: string, opts?: SideGenSendOptions) {
            const method = 'sideGen.send';
            assertReady(method, parentSignal);
            const safeSessionId = assertStringArg(sessionId, method, 'sessionId');
            const safePrompt = assertStringArg(prompt, method, 'prompt');
            const { options: cleanOpts, callerSignal } =
                extractSignalAndCloneOptions<SideGenSendOptions>(opts, method, false);
            const linked = combineAbortSignals(parentSignal, callerSignal);
            try {
                return await invokeHost(method, linked.signal, (api) =>
                    api.send(safeSessionId, safePrompt, {
                        ...cleanOpts,
                        signal: linked.signal,
                    }),
                );
            } finally {
                linked.cleanup();
            }
        },

        async getSession(sessionId: string) {
            const method = 'sideGen.getSession';
            assertReady(method, parentSignal);
            const safeSessionId = assertStringArg(sessionId, method, 'sessionId');
            return await invokeHost(method, parentSignal, (api) =>
                api.getSession(safeSessionId),
            );
        },

        async listSessions(filter?: SideSessionFilter) {
            const method = 'sideGen.listSessions';
            assertReady(method, parentSignal);
            const safeFilter =
                filter === undefined
                    ? undefined
                    : (cloneBoundaryValue(
                        assertRecordArg(filter, method, 'filter'),
                        method,
                    ) as unknown as SideSessionFilter);
            return await invokeHost(method, parentSignal, (api) =>
                api.listSessions(safeFilter),
            );
        },

        async getTranscript(sessionId: string) {
            const method = 'sideGen.getTranscript';
            assertReady(method, parentSignal);
            const safeSessionId = assertStringArg(sessionId, method, 'sessionId');
            return await invokeHost(method, parentSignal, (api) =>
                api.getTranscript(safeSessionId),
            );
        },

        async compactSession(sessionId: string) {
            const method = 'sideGen.compactSession';
            assertReady(method, parentSignal);
            const safeSessionId = assertStringArg(sessionId, method, 'sessionId');
            return await invokeHost(method, parentSignal, (api) =>
                api.compactSession(safeSessionId),
            );
        },

        async deleteSession(sessionId: string) {
            const method = 'sideGen.deleteSession';
            assertReady(method, parentSignal);
            const safeSessionId = assertStringArg(sessionId, method, 'sessionId');
            return await invokeHost(method, parentSignal, (api) =>
                api.deleteSession(safeSessionId),
            );
        },

        clues: frozenClues,
    };

    return Object.freeze(
        Object.assign(Object.create(null) as object, sideGenMethods),
    ) as ToolSideGenApi;
}

const FORBIDDEN_BOUNDARY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function cloneBoundaryPayload<T>(
    value: T,
    method: string,
    onError: (method: string, error: unknown) => Error,
): T {
    if (value === undefined || value === null) {
        return value;
    }
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') {
        return value;
    }
    try {
        if (typeof globalThis.structuredClone === 'function') {
            return globalThis.structuredClone(value);
        }
        return JSON.parse(JSON.stringify(value)) as T;
    } catch (error) {
        throw onError(method, error);
    }
}

function deepFreezeBoundaryValue<T>(value: T, seen = new WeakSet<object>()): T {
    if (value && typeof value === 'object') {
        const obj = value as unknown as object;
        if (seen.has(obj)) {
            return value;
        }
        seen.add(obj);
        if (Array.isArray(value)) {
            for (const item of value) {
                deepFreezeBoundaryValue(item, seen);
            }
        } else {
            for (const propVal of Object.values(value as Record<string, unknown>)) {
                deepFreezeBoundaryValue(propVal, seen);
            }
        }
        Object.freeze(obj);
    }
    return value;
}

function cloneAgentBoundaryValue<T>(value: T, method: string): T {
    return cloneBoundaryPayload(
        value,
        method,
        (m, err) =>
            new SandboxAgentError(
                'AGENT_INVALID_ARGS',
                m,
                `ctx.${m}() received non-serializable data across the sandbox boundary.`,
                err,
            ),
    );
}

function extractAgentSignalAndCloneOptions<T extends { signal?: AbortSignal }>(
    rawOpts: unknown,
    method: string,
    required: boolean,
): { options: Omit<T, 'signal'>; callerSignal?: AbortSignal } {
    if (rawOpts === undefined) {
        if (required) {
            throw new SandboxAgentError(
                'AGENT_INVALID_ARGS',
                method,
                `ctx.${method}() requires an options object.`,
            );
        }
        return { options: {} as Omit<T, 'signal'> };
    }

    if (!rawOpts || typeof rawOpts !== 'object' || Array.isArray(rawOpts)) {
        throw new SandboxAgentError(
            'AGENT_INVALID_ARGS',
            method,
            `ctx.${method}() requires "options" to be a plain object.`,
        );
    }

    const record = rawOpts as Record<string, unknown>;
    let callerSignal: AbortSignal | undefined;
    if (record.signal !== undefined) {
        if (!isAbortSignalLike(record.signal)) {
            throw new SandboxAgentError(
                'AGENT_INVALID_ARGS',
                method,
                `ctx.${method}() received an invalid AbortSignal in options.signal.`,
            );
        }
        callerSignal = record.signal;
    }

    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        if (key === 'signal' || FORBIDDEN_BOUNDARY_KEYS.has(key)) {
            continue;
        }
        copy[key] = record[key];
    }

    return {
        options: cloneAgentBoundaryValue(copy, method) as Omit<T, 'signal'>,
        callerSignal,
    };
}

/**
 * Create a frozen, null-prototype host-side proxy for `ctx.agent` inside the JS sandbox.
 * Mirrors `createSandboxSideGenProxy`: enforces `isDisposed()` and linked `AbortSignal`,
 * clones all cross-boundary inputs/outputs, and exposes only `run` and `runTrigger`.
 */
function createSandboxAgentProxy(
    hostAgent: ToolAgentApi | undefined,
    parentSignal: AbortSignal,
    isDisposed: () => boolean,
): ToolAgentApi {
    const assertReady = (method: string, signal: AbortSignal): ToolAgentApi => {
        if (isDisposed()) {
            throw new SandboxAgentError(
                'AGENT_DISPOSED',
                method,
                `ctx.${method}() failed: sandbox has been disposed.`,
            );
        }
        throwIfAborted(signal, `ctx.${method}() aborted`);
        if (!hostAgent) {
            throw new SandboxAgentError(
                'AGENT_UNAVAILABLE',
                method,
                `ctx.${method}() failed: agent execution service is not configured in this execution context.`,
            );
        }
        return hostAgent;
    };

    const invokeHost = async <T>(
        method: string,
        signal: AbortSignal,
        executor: (api: ToolAgentApi) => Promise<T>,
    ): Promise<T> => {
        const api = assertReady(method, signal);
        const result = await raceWithSignalAndTimeout(
            Promise.resolve().then(() => executor(api)),
            signal,
            undefined,
            `ctx.${method}()`,
        );
        if (isDisposed()) {
            throw new SandboxAgentError(
                'AGENT_DISPOSED',
                method,
                `ctx.${method}() failed: sandbox was disposed during execution.`,
            );
        }
        throwIfAborted(signal, `ctx.${method}() aborted`);
        return cloneAgentBoundaryValue(result, method);
    };

    const agentMethods: ToolAgentApi = {
        async run(opts: ToolAgentRunOptions) {
            const method = 'agent.run';
            assertReady(method, parentSignal);
            const { options: cleanOpts, callerSignal } =
                extractAgentSignalAndCloneOptions<ToolAgentRunOptions>(opts, method, true);
            const linked = combineAbortSignals(parentSignal, callerSignal);
            try {
                return await invokeHost(method, linked.signal, (api) =>
                    api.run({
                        ...cleanOpts,
                        signal: linked.signal,
                    }),
                );
            } finally {
                linked.cleanup();
            }
        },

        async runTrigger(ruleId: string, opts?: ToolAgentRunTriggerOptions) {
            const method = 'agent.runTrigger';
            assertReady(method, parentSignal);
            if (typeof ruleId !== 'string' || ruleId.trim().length === 0) {
                throw new SandboxAgentError(
                    'AGENT_INVALID_ARGS',
                    method,
                    `ctx.${method}() requires "ruleId" to be a non-empty string.`,
                );
            }
            const safeRuleId = ruleId.trim();
            const { options: cleanOpts, callerSignal } =
                extractAgentSignalAndCloneOptions<ToolAgentRunTriggerOptions>(opts, method, false);
            const linked = combineAbortSignals(parentSignal, callerSignal);
            try {
                return await invokeHost(method, linked.signal, (api) =>
                    api.runTrigger(safeRuleId, {
                        ...cleanOpts,
                        signal: linked.signal,
                    }),
                );
            } finally {
                linked.cleanup();
            }
        },
    };

    return Object.freeze(
        Object.assign(Object.create(null) as object, agentMethods),
    ) as ToolAgentApi;
}

function cloneExecutionBoundaryValue<T>(value: T, method: string): T {
    return cloneBoundaryPayload(
        value,
        method,
        (m, err) =>
            new SandboxExecutionError(
                `ctx.${m}() received non-serializable data across the sandbox boundary.`,
                err,
            ),
    );
}

function createSandboxMessagesProxy(
    hostMessages: ToolEphemeralMessagesApi,
    parentSignal: AbortSignal,
    isDisposed: () => boolean,
): ToolEphemeralMessagesApi {
    const assertReady = (method: string): void => {
        if (isDisposed()) {
            throw new SandboxExecutionError(`ctx.${method}() failed: sandbox has been disposed.`);
        }
        throwIfAborted(parentSignal, `ctx.${method}() aborted`);
    };

    const messagesMethods: ToolEphemeralMessagesApi = {
        list() {
            const method = 'messages.list';
            assertReady(method);
            return cloneExecutionBoundaryValue(hostMessages.list(), method);
        },

        set(nextMessages: CanonicalMessage[]) {
            const method = 'messages.set';
            assertReady(method);
            if (!Array.isArray(nextMessages)) {
                throw new SandboxExecutionError(`ctx.${method}() requires an array of messages.`);
            }
            const cloned = cloneExecutionBoundaryValue(nextMessages, method);
            hostMessages.set(cloned);
        },

        rollbackToolRounds(count?: number) {
            const method = 'messages.rollbackToolRounds';
            assertReady(method);
            if (count !== undefined && typeof count !== 'number') {
                throw new SandboxExecutionError(`ctx.${method}() requires "count" to be a number.`);
            }
            return hostMessages.rollbackToolRounds(count);
        },

        dropHistoryTurns(count?: number, opts?: { from?: 'newest' | 'oldest' }) {
            const method = 'messages.dropHistoryTurns';
            assertReady(method);
            if (count !== undefined && typeof count !== 'number') {
                throw new SandboxExecutionError(`ctx.${method}() requires "count" to be a number.`);
            }
            const safeOpts =
                opts === undefined
                    ? undefined
                    : (() => {
                        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
                            throw new SandboxExecutionError(
                                `ctx.${method}() requires "opts" to be a plain object.`,
                            );
                        }
                        return cloneExecutionBoundaryValue(opts, method);
                    })();
            return hostMessages.dropHistoryTurns(count, safeOpts);
        },

        replaceContent(selector, replacer) {
            const method = 'messages.replaceContent';
            assertReady(method);
            if (typeof selector !== 'number' && typeof selector !== 'function') {
                throw new SandboxExecutionError(
                    `ctx.${method}() requires "selector" to be a number or function.`,
                );
            }
            if (typeof replacer !== 'string' && typeof replacer !== 'function') {
                throw new SandboxExecutionError(
                    `ctx.${method}() requires "replacer" to be a string or function.`,
                );
            }
            const wrappedSelector =
                typeof selector === 'function'
                    ? (msg: CanonicalMessage, idx: number) =>
                        Boolean(selector(cloneExecutionBoundaryValue(msg, method), idx))
                    : selector;
            const wrappedReplacer =
                typeof replacer === 'function'
                    ? (content: string, msg: CanonicalMessage, idx: number) => {
                        const out = replacer(content, cloneExecutionBoundaryValue(msg, method), idx);
                        return typeof out === 'string' ? out : (undefined as unknown as string);
                    }
                    : replacer;
            return hostMessages.replaceContent(wrappedSelector, wrappedReplacer);
        },

        appendHint(content: string, role?: 'user' | 'system') {
            const method = 'messages.appendHint';
            assertReady(method);
            if (typeof content !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "content" to be a string.`);
            }
            if (role !== undefined && role !== 'user' && role !== 'system') {
                throw new SandboxExecutionError(
                    `ctx.${method}() requires "role" to be "user" or "system".`,
                );
            }
            hostMessages.appendHint(content, role);
        },

        toMessages() {
            const method = 'messages.toMessages';
            assertReady(method);
            return cloneExecutionBoundaryValue(hostMessages.toMessages(), method);
        },
    };

    return Object.freeze(
        Object.assign(Object.create(null) as object, messagesMethods),
    ) as ToolEphemeralMessagesApi;
}

function createSandboxEventSnapshot(hostEvent: ToolEventPayload): ToolEventPayload {
    const cloned = cloneExecutionBoundaryValue(hostEvent, 'event');
    return deepFreezeBoundaryValue(cloned);
}

const CONTROL_READONLY_FIELDS = [
    'action',
    'reason',
    'delayMs',
    'rollbackToolRounds',
    'dropHistoryTurns',
    'fallbackContent',
    'retryReason',
    'fixMessage',
    'rejectWrite',
    'abortReason',
] as const;

function createSandboxControlProxy(
    hostControl: ToolErrorRecoveryControl | ToolPostprocessControl,
    parentSignal: AbortSignal,
    isDisposed: () => boolean,
): ToolErrorRecoveryControl | ToolPostprocessControl {
    const assertReady = (method: string): void => {
        if (isDisposed()) {
            throw new SandboxExecutionError(`ctx.${method}() failed: sandbox has been disposed.`);
        }
        throwIfAborted(parentSignal, `ctx.${method}() aborted`);
    };

    const record = hostControl as unknown as Record<string, unknown>;
    const proxyObj = Object.create(null) as Record<string, unknown>;

    if (typeof record.retry === 'function') {
        proxyObj.retry = (reason?: string, opts?: Record<string, unknown>) => {
            const method = 'control.retry';
            assertReady(method);
            if (reason !== undefined && typeof reason !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "reason" to be a string.`);
            }
            const safeOpts =
                opts === undefined
                    ? undefined
                    : (() => {
                        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
                            throw new SandboxExecutionError(
                                `ctx.${method}() requires "opts" to be a plain object.`,
                            );
                        }
                        return cloneExecutionBoundaryValue(opts, method);
                    })();
            (record.retry as (r?: string, o?: unknown) => void).call(hostControl, reason, safeOpts);
        };
    }

    if (typeof record.requestFix === 'function') {
        proxyObj.requestFix = (message: string, opts?: Record<string, unknown>) => {
            const method = 'control.requestFix';
            assertReady(method);
            if (typeof message !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "message" to be a string.`);
            }
            const safeOpts =
                opts === undefined
                    ? undefined
                    : (() => {
                        if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
                            throw new SandboxExecutionError(
                                `ctx.${method}() requires "opts" to be a plain object.`,
                            );
                        }
                        return cloneExecutionBoundaryValue(opts, method);
                    })();
            (record.requestFix as (m: string, o?: unknown) => void).call(
                hostControl,
                message,
                safeOpts,
            );
        };
    }

    if (typeof record.abort === 'function') {
        proxyObj.abort = (reason?: string) => {
            const method = 'control.abort';
            assertReady(method);
            if (reason !== undefined && typeof reason !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "reason" to be a string.`);
            }
            (record.abort as (r?: string) => void).call(hostControl, reason);
        };
    }

    if (typeof record.fallback === 'function') {
        proxyObj.fallback = (content: string, reason?: string) => {
            const method = 'control.fallback';
            assertReady(method);
            if (typeof content !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "content" to be a string.`);
            }
            if (reason !== undefined && typeof reason !== 'string') {
                throw new SandboxExecutionError(`ctx.${method}() requires "reason" to be a string.`);
            }
            (record.fallback as (c: string, r?: string) => void).call(
                hostControl,
                content,
                reason,
            );
        };
    }

    if (typeof record.accept === 'function') {
        proxyObj.accept = () => {
            const method = 'control.accept';
            assertReady(method);
            (record.accept as () => void).call(hostControl);
        };
    }

    for (const prop of CONTROL_READONLY_FIELDS) {
        if (prop in record) {
            Object.defineProperty(proxyObj, prop, {
                enumerable: true,
                configurable: false,
                get: () => {
                    const val = record[prop];
                    return typeof val === 'object' && val !== null
                        ? cloneExecutionBoundaryValue(val, `control.${prop}`)
                        : val;
                },
            });
        }
    }

    return Object.freeze(proxyObj) as unknown as ToolErrorRecoveryControl | ToolPostprocessControl;
}

function createSandboxBodyBridge(hostBody: Record<string, unknown>): {
    workingBody: Record<string, unknown>;
    syncBack: () => void;
} {
    const workingBody: Record<string, unknown> = {};
    for (const key of Object.keys(hostBody)) {
        if (FORBIDDEN_BOUNDARY_KEYS.has(key)) {
            continue;
        }
        workingBody[key] = cloneExecutionBoundaryValue(hostBody[key], 'body');
    }

    return {
        workingBody,
        syncBack: () => {
            const stagedEntries: Array<[string, unknown]> = [];
            const nextKeys = new Set<string>();
            for (const key of Object.keys(workingBody)) {
                if (FORBIDDEN_BOUNDARY_KEYS.has(key)) {
                    continue;
                }
                const val = workingBody[key];
                if (val === undefined) {
                    continue;
                }
                const cloned = cloneExecutionBoundaryValue(val, 'body');
                nextKeys.add(key);
                stagedEntries.push([key, cloned]);
            }
            for (const [key, cloned] of stagedEntries) {
                hostBody[key] = cloned;
            }
            for (const existingKey of Object.keys(hostBody)) {
                if (!FORBIDDEN_BOUNDARY_KEYS.has(existingKey) && !nextKeys.has(existingKey)) {
                    delete hostBody[existingKey];
                }
            }
        },
    };
}

const OUTPUT_READONLY_FIELDS = [
    'originalText',
    'stage',
    'operation',
    'filePath',
    'round',
    'fixAttempt',
    'maxFixAttempts',
] as const;

function createSandboxOutputBridge(hostOutput: ToolPostprocessOutput): {
    workingOutput: ToolPostprocessOutput;
    syncBack: () => void;
} {
    const workingOutput: Record<string, unknown> = {
        text: typeof hostOutput.text === 'string' ? hostOutput.text : '',
    };

    const hostRecord = hostOutput as unknown as Record<string, unknown>;
    for (const field of OUTPUT_READONLY_FIELDS) {
        if (hostRecord[field] !== undefined) {
            Object.defineProperty(workingOutput, field, {
                value: hostRecord[field],
                writable: false,
                enumerable: true,
                configurable: false,
            });
        }
    }

    return {
        workingOutput: workingOutput as unknown as ToolPostprocessOutput,
        syncBack: () => {
            if (typeof workingOutput.text === 'string') {
                hostOutput.text = workingOutput.text;
            }
        },
    };
}

interface RealmContext {
    handle: ManagedSandboxHandle;
    scopeProxy: object;
    evaluateCode: (rawCode: string, mode: 'schema' | 'tool' | 'script') => Promise<unknown>;
    setActiveSignal: (signal?: AbortSignal) => void;
}

/**
 * Tiered JavaScript sandbox implementing `ScriptSandbox`.
 *
 * - **Browser runtime**: mounts an isolated `<iframe sandbox="allow-scripts allow-same-origin">`
 *   tracked by `SandboxLifecycleManager` with lexical + proxy environment hardening.
 * - **Network-Disabled Schema Mode**: blocks `fetch`, `XMLHttpRequest`, `WebSocket`,
 *   `EventSource`, `navigator.sendBeacon`, `parent`, `top`, and DOM globals during `@@zod_schema` parsing.
 * - **Controlled Tool / Script Mode**: evaluates `defineTool` (single or array) and `@@script`,
 *   injects `ctx`, `z` (Zod v4), `_` (safe lodash), `defineTool`, tracks timers/listeners,
 *   and forwards `AbortSignal`.
 * - **Node fallback**: when `typeof document === 'undefined'`, evaluates in a hardened scoped
 *   function with identical security guards and lifecycle timer tracking for unit tests.
 */
export class IframeJsSandbox implements ScriptSandbox {
    public readonly lifecycle: SandboxLifecycleManager;
    private readonly defaultTimeoutMs: number;
    private sequence = 0;

    constructor(options: IframeJsSandboxOptions = {}) {
        this.lifecycle = options.lifecycle ?? new SandboxLifecycleManager();
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    }

    async evaluateSchema(code: string, options: SchemaEvalOptions = {}): Promise<z.ZodTypeAny> {
        throwIfAborted(options.signal);
        const id = options.id ?? this.nextId('schema');
        let registeredSchema: z.ZodTypeAny | undefined;

        const registerSchema = (schema: z.ZodTypeAny): z.ZodTypeAny => {
            if (!isZodSchemaObject(schema) || getZodTypeName(schema) !== 'object') {
                throw new SandboxExecutionError('registerSchema() requires a z.object(...) schema.');
            }
            registeredSchema = schema;
            return schema;
        };

        const realm = this.createRealm(id, 'schema', {
            allowNetwork: false,
            schemaMode: true,
            injections: {
                z,
                _: createSafeLodash(),
                registerSchema,
            },
        });

        const controller = new AbortController();
        realm.handle.trackAbortController(controller);
        const linked = combineAbortSignals(options.signal, controller.signal);

        try {
            const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
            const evaluated = await raceWithSignalAndTimeout(
                realm.evaluateCode(code, 'schema'),
                linked.signal,
                timeoutMs,
                'Schema evaluation',
            );

            const candidate = registeredSchema ?? evaluated;
            if (!isZodSchemaObject(candidate)) {
                throw new SandboxExecutionError(
                    '@@zod_schema code must evaluate to a Zod schema (e.g. z.object({ ... })).',
                );
            }
            return candidate;
        } finally {
            linked.cleanup();
            realm.handle.untrackAbortController(controller);
            this.lifecycle.dispose(id);
        }
    }

    async compileCustomTools(
        code: string,
        options: SandboxCompileOptions = {},
    ): Promise<CompiledSandboxTool[]> {
        throwIfAborted(options.signal);
        const id = options.id ?? this.nextId('tool');
        const allowNetwork = options.allowNetwork ?? true;
        const collectedTools: SandboxToolDefinition[] = [];
        let activeSignal: AbortSignal | undefined;

        const defineToolWrapper = <TParams extends z.ZodTypeAny>(
            definition: SandboxToolDefinition<TParams>,
        ): SandboxToolDefinition<TParams> => {
            const validated = defineTool(definition);
            if (!collectedTools.includes(validated as unknown as SandboxToolDefinition)) {
                collectedTools.push(validated as unknown as SandboxToolDefinition);
            }
            return validated;
        };

        const realm = this.createRealm(id, 'tool', {
            allowNetwork,
            schemaMode: false,
            getActiveSignal: () => activeSignal,
            injections: {
                z,
                _: createSafeLodash(),
                defineTool: defineToolWrapper,
            },
        });
        realm.setActiveSignal = (sig?: AbortSignal) => {
            activeSignal = sig;
        };

        const compileController = new AbortController();
        realm.handle.trackAbortController(compileController);
        const linkedCompile = combineAbortSignals(options.signal, compileController.signal);

        try {
            const evaluated = await raceWithSignalAndTimeout(
                realm.evaluateCode(code, 'tool'),
                linkedCompile.signal,
                options.timeoutMs ?? this.defaultTimeoutMs,
                `Custom tool compilation (${id})`,
            );

            const rawDefinitions = normalizeCompiledTools(evaluated, collectedTools);
            if (rawDefinitions.length === 0) {
                throw new SandboxExecutionError(
                    `Custom tool "${id}" did not export or return any defineTool(...) definition.`,
                );
            }

            return rawDefinitions.map((def) => ({
                name: def.name.trim(),
                description: def.description,
                parameters: def.parameters,
                ...(def.strict !== undefined ? { strict: def.strict } : {}),
                ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
                execute: async (args: Record<string, unknown>, ctx: ToolExecutionContext) => {
                    if (realm.handle.isDisposed()) {
                        throw new SandboxExecutionError(`Sandbox "${id}" has been disposed.`);
                    }
                    throwIfAborted(ctx.signal);

                    const callController = new AbortController();
                    realm.handle.trackAbortController(callController);
                    const combined = combineAbortSignals(ctx.signal, callController.signal);
                    const prevSignal = activeSignal;
                    activeSignal = combined.signal;

                    try {
                        const isDisposed = () => realm.handle.isDisposed();
                        const scopedSideGen = createSandboxSideGenProxy(
                            ctx.sideGen,
                            combined.signal,
                            isDisposed,
                        );
                        const scopedAgent = createSandboxAgentProxy(
                            ctx.agent,
                            combined.signal,
                            isDisposed,
                        );
                        const scopedMessages = ctx.messages
                            ? createSandboxMessagesProxy(ctx.messages, combined.signal, isDisposed)
                            : undefined;
                        const scopedEvent = ctx.event
                            ? createSandboxEventSnapshot(ctx.event)
                            : undefined;
                        const scopedControl = ctx.control
                            ? createSandboxControlProxy(ctx.control, combined.signal, isDisposed)
                            : undefined;
                        const bodyBridge = ctx.body
                            ? createSandboxBodyBridge(ctx.body)
                            : undefined;
                        const outputBridge = ctx.output
                            ? createSandboxOutputBridge(ctx.output)
                            : undefined;

                        const scopedCtx: ToolExecutionContext = {
                            fs: ctx.fs,
                            vars: ctx.vars,
                            message: ctx.message,
                            st: ctx.st,
                            sideGen: scopedSideGen,
                            agent: scopedAgent,
                            ...(scopedMessages ? { messages: scopedMessages } : {}),
                            ...(scopedEvent ? { event: scopedEvent } : {}),
                            ...(scopedControl ? { control: scopedControl } : {}),
                            ...(bodyBridge ? { body: bodyBridge.workingBody } : {}),
                            ...(outputBridge ? { output: outputBridge.workingOutput } : {}),
                            target: Object.freeze({ ...ctx.target }),
                            signal: combined.signal,
                            permissions: ctx.permissions,
                            ...(ctx.readSet ? { readSet: ctx.readSet } : {}),
                        };

                        const executionTimeoutMs = resolveToolTimeoutMs(
                            def.timeoutMs ?? options.timeoutMs,
                            this.defaultTimeoutMs,
                        );
                        const runPromise = Promise.resolve(def.execute(args, scopedCtx));
                        const result = await raceWithSignalAndTimeout(
                            runPromise,
                            combined.signal,
                            executionTimeoutMs,
                            `Custom tool "${def.name}"`,
                        );
                        if (!isDisposed() && !combined.signal.aborted) {
                            bodyBridge?.syncBack();
                            outputBridge?.syncBack();
                        }
                        return result;
                    } finally {
                        activeSignal = prevSignal;
                        combined.cleanup();
                        realm.handle.untrackAbortController(callController);
                    }
                },
            }));
        } catch (error) {
            this.lifecycle.dispose(id);
            throw error;
        } finally {
            linkedCompile.cleanup();
            realm.handle.untrackAbortController(compileController);
        }
    }

    async evaluateScript(
        code: string,
        ctx: ToolExecutionContext,
        options: SandboxRunOptions = {},
    ): Promise<unknown> {
        throwIfAborted(ctx.signal);
        throwIfAborted(options.signal);
        const id = options.id ?? this.nextId('script');
        const allowNetwork = options.allowNetwork ?? true;

        const callerLinked = combineAbortSignals(ctx.signal, options.signal);
        const runController = new AbortController();
        const combined = combineAbortSignals(callerLinked.signal, runController.signal);

        const handleBox: { current?: ManagedSandboxHandle } = {};
        const isDisposed = () => handleBox.current?.isDisposed() ?? false;
        let realm: RealmContext | undefined;

        try {
            const scopedSideGen = createSandboxSideGenProxy(
                ctx.sideGen,
                combined.signal,
                isDisposed,
            );
            const scopedAgent = createSandboxAgentProxy(
                ctx.agent,
                combined.signal,
                isDisposed,
            );
            const scopedMessages = ctx.messages
                ? createSandboxMessagesProxy(ctx.messages, combined.signal, isDisposed)
                : undefined;
            const scopedEvent = ctx.event
                ? createSandboxEventSnapshot(ctx.event)
                : undefined;
            const scopedControl = ctx.control
                ? createSandboxControlProxy(ctx.control, combined.signal, isDisposed)
                : undefined;
            const bodyBridge = ctx.body
                ? createSandboxBodyBridge(ctx.body)
                : undefined;
            const outputBridge = ctx.output
                ? createSandboxOutputBridge(ctx.output)
                : undefined;

            const scopedCtx: ToolExecutionContext = {
                fs: ctx.fs,
                vars: ctx.vars,
                message: ctx.message,
                st: ctx.st,
                sideGen: scopedSideGen,
                agent: scopedAgent,
                ...(scopedMessages ? { messages: scopedMessages } : {}),
                ...(scopedEvent ? { event: scopedEvent } : {}),
                ...(scopedControl ? { control: scopedControl } : {}),
                ...(bodyBridge ? { body: bodyBridge.workingBody } : {}),
                ...(outputBridge ? { output: outputBridge.workingOutput } : {}),
                target: Object.freeze({ ...ctx.target }),
                signal: combined.signal,
                permissions: ctx.permissions,
                ...(ctx.readSet ? { readSet: ctx.readSet } : {}),
            };

            realm = this.createRealm(id, 'script', {
                allowNetwork,
                schemaMode: false,
                getActiveSignal: () => combined.signal,
                injections: {
                    z,
                    _: createSafeLodash(),
                    defineTool,
                    ctx: scopedCtx,
                    fs: scopedCtx.fs,
                    vars: scopedCtx.vars,
                    message: scopedCtx.message,
                    st: scopedCtx.st,
                    sideGen: scopedCtx.sideGen,
                    agent: scopedCtx.agent,
                    messages: scopedCtx.messages,
                    event: scopedCtx.event,
                    control: scopedCtx.control,
                    body: scopedCtx.body,
                    output: scopedCtx.output,
                    target: scopedCtx.target,
                    signal: scopedCtx.signal,
                },
            });
            handleBox.current = realm.handle;
            realm.handle.trackAbortController(runController);

            const result = await raceWithSignalAndTimeout(
                realm.evaluateCode(code, 'script'),
                combined.signal,
                options.timeoutMs ?? this.defaultTimeoutMs,
                `Script (${id})`,
            );
            if (!isDisposed() && !combined.signal.aborted) {
                bodyBridge?.syncBack();
                outputBridge?.syncBack();
            }
            return result;
        } finally {
            combined.cleanup();
            callerLinked.cleanup();
            if (realm) {
                realm.handle.untrackAbortController(runController);
                if (!options.keepAlive) {
                    this.lifecycle.dispose(id);
                }
            }
        }
    }

    dispose(id: string): boolean {
        return this.lifecycle.dispose(id);
    }

    disposeAll(): number {
        return this.lifecycle.disposeAll();
    }

    private nextId(prefix: string): string {
        this.sequence += 1;
        return `${prefix}_${this.sequence}`;
    }

    private createRealm(
        id: string,
        kind: 'schema' | 'tool' | 'script',
        config: {
            allowNetwork: boolean;
            schemaMode: boolean;
            injections: Record<string, unknown>;
            getActiveSignal?: () => AbortSignal | undefined;
        },
    ): RealmContext {
        if (typeof document !== 'undefined' && (document.body || document.documentElement)) {
            return this.createBrowserIframeRealm(id, kind, config);
        }
        return this.createNodeFallbackRealm(id, kind, config);
    }

    private createBrowserIframeRealm(
        id: string,
        kind: 'schema' | 'tool' | 'script',
        config: {
            allowNetwork: boolean;
            schemaMode: boolean;
            injections: Record<string, unknown>;
            getActiveSignal?: () => AbortSignal | undefined;
        },
    ): RealmContext {
        const handle = this.lifecycle.register(id, kind);
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.setAttribute('aria-hidden', 'true');
        iframe.setAttribute('data-agentic-sandbox-id', id);
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

        const hostContainer = document.body ?? document.documentElement;
        hostContainer.appendChild(iframe);
        handle.setIframe(iframe);

        const win = iframe.contentWindow as (Window & typeof globalThis) | null;
        if (!win) {
            this.lifecycle.dispose(id);
            throw new SandboxExecutionError(`Failed to initialize sandbox iframe contentWindow for "${id}".`);
        }

        handle.instrumentRealmWindow(win);

        // Capture iframe's Function constructor BEFORE locking down win.eval/Function.
        const RealmFunction = win.Function;

        hardenBrowserWindow(win, config);
        const scopeProxy = buildSandboxScopeProxy(win, {
            allowNetwork: config.allowNetwork,
            schemaMode: config.schemaMode,
            isNode: false,
            injections: config.injections,
            getActiveSignal: config.getActiveSignal,
            rawFetch: config.allowNetwork && typeof win.fetch === 'function'
                ? win.fetch.bind(win)
                : undefined,
        });

        return {
            handle,
            scopeProxy,
            setActiveSignal: () => {},
            evaluateCode: (rawCode, mode) =>
                executeInScopedRealm(rawCode, mode, scopeProxy, (fnSrc) => {
                    const builder = new RealmFunction(
                        '__scope__',
                        `with (__scope__) { return (${fnSrc}); }`,
                    ) as (scope: object) => () => Promise<unknown>;
                    return builder(scopeProxy);
                }),
        };
    }

    private createNodeFallbackRealm(
        id: string,
        kind: 'schema' | 'tool' | 'script',
        config: {
            allowNetwork: boolean;
            schemaMode: boolean;
            injections: Record<string, unknown>;
            getActiveSignal?: () => AbortSignal | undefined;
        },
    ): RealmContext {
        const handle = this.lifecycle.register(id, kind);
        const timers = handle.createTimerBindings();
        const hostFetch =
            config.allowNetwork && typeof globalThis.fetch === 'function'
                ? globalThis.fetch.bind(globalThis)
                : undefined;

        const baseTarget: Record<string, unknown> = {
            setTimeout: timers.setTimeout,
            clearTimeout: timers.clearTimeout,
            setInterval: timers.setInterval,
            clearInterval: timers.clearInterval,
            console: globalThis.console,
            Promise: globalThis.Promise,
            Array: globalThis.Array,
            Object: globalThis.Object,
            String: globalThis.String,
            Number: globalThis.Number,
            Boolean: globalThis.Boolean,
            Math: globalThis.Math,
            Date: globalThis.Date,
            JSON: globalThis.JSON,
            RegExp: globalThis.RegExp,
            Error: globalThis.Error,
            TypeError: globalThis.TypeError,
            RangeError: globalThis.RangeError,
            Map: globalThis.Map,
            Set: globalThis.Set,
            WeakMap: globalThis.WeakMap,
            WeakSet: globalThis.WeakSet,
            URL: globalThis.URL,
            URLSearchParams: globalThis.URLSearchParams,
            AbortController: globalThis.AbortController,
            AbortSignal: globalThis.AbortSignal,
            TextEncoder: globalThis.TextEncoder,
            TextDecoder: globalThis.TextDecoder,
            atob: globalThis.atob,
            btoa: globalThis.btoa,
            structuredClone: globalThis.structuredClone,
            queueMicrotask: globalThis.queueMicrotask,
            parseInt: globalThis.parseInt,
            parseFloat: globalThis.parseFloat,
            isNaN: globalThis.isNaN,
            isFinite: globalThis.isFinite,
            encodeURIComponent: globalThis.encodeURIComponent,
            decodeURIComponent: globalThis.decodeURIComponent,
            encodeURI: globalThis.encodeURI,
            decodeURI: globalThis.decodeURI,
            undefined,
            NaN: Number.NaN,
            Infinity: Number.POSITIVE_INFINITY,
        };

        const scopeProxy = buildSandboxScopeProxy(baseTarget, {
            allowNetwork: config.allowNetwork,
            schemaMode: config.schemaMode,
            isNode: true,
            injections: config.injections,
            getActiveSignal: config.getActiveSignal,
            rawFetch: hostFetch,
        });

        const compileInNode = (fnSrc: string): (() => Promise<unknown>) => {
            const builder = new Function(
                '__scope__',
                `with (__scope__) { return (${fnSrc}); }`,
            ) as (scope: object) => () => Promise<unknown>;
            return builder(scopeProxy);
        };

        return {
            handle,
            scopeProxy,
            setActiveSignal: () => {},
            evaluateCode: (rawCode, mode) =>
                executeInScopedRealm(rawCode, mode, scopeProxy, compileInNode),
        };
    }
}

function hardenBrowserWindow(
    win: Window & typeof globalThis,
    config: { allowNetwork: boolean; schemaMode: boolean },
): void {
    const defineBlockedGetter = (target: object, prop: string) => {
        try {
            Object.defineProperty(target, prop, {
                get() {
                    throw new SandboxSecurityError(prop);
                },
                set() {
                    throw new SandboxSecurityError(prop);
                },
                configurable: true,
            });
        } catch {
            // Some WebIDL properties such as `top` are [LegacyUnforgeable]; guarded via scopeProxy
        }
    };

    const defineBlockedMethod = (target: object, prop: string) => {
        try {
            Object.defineProperty(target, prop, {
                value: () => {
                    throw new SandboxSecurityError(prop);
                },
                writable: false,
                configurable: true,
            });
        } catch {
            // Ignore non-configurable properties; guarded via scopeProxy
        }
    };

    for (const prop of ALWAYS_BLOCKED_PROPS) {
        if (typeof prop === 'string') {
            if (prop === 'open') {
                defineBlockedMethod(win, prop);
            } else {
                defineBlockedGetter(win, prop);
            }
        }
    }

    if (!config.allowNetwork) {
        for (const prop of NETWORK_BLOCKED_PROPS) {
            if (typeof prop === 'string') {
                defineBlockedMethod(win, prop);
            }
        }
        if (win.navigator) {
            defineBlockedMethod(win.navigator, 'sendBeacon');
        }
    }

    if (config.schemaMode) {
        for (const prop of SCHEMA_ONLY_BLOCKED_PROPS) {
            if (typeof prop === 'string') {
                defineBlockedGetter(win, prop);
            }
        }
    }
}

function buildSandboxScopeProxy(
    targetObj: object,
    options: {
        allowNetwork: boolean;
        schemaMode: boolean;
        isNode: boolean;
        injections: Record<string, unknown>;
        getActiveSignal?: () => AbortSignal | undefined;
        rawFetch?: typeof globalThis.fetch;
    },
): object {
    const isBlockedProp = (prop: string | symbol): boolean => {
        if (ALWAYS_BLOCKED_PROPS.has(prop)) {
            return true;
        }
        if (!options.allowNetwork && NETWORK_BLOCKED_PROPS.has(prop)) {
            return true;
        }
        if (options.schemaMode && SCHEMA_ONLY_BLOCKED_PROPS.has(prop)) {
            return true;
        }
        if (options.isNode && NODE_ONLY_BLOCKED_PROPS.has(prop)) {
            return true;
        }
        return false;
    };

    const wrappedFetch = options.allowNetwork && options.rawFetch
        ? (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const activeSig = options.getActiveSignal?.();
            if (!activeSig) {
                return options.rawFetch!(input, init);
            }
            const combined = combineAbortSignals(init?.signal ?? undefined, activeSig);
            const nextInit: RequestInit = {
                ...(init ?? {}),
                signal: combined.signal,
            };
            return options.rawFetch!(input, nextInit).finally(() => {
                combined.cleanup();
            });
        }
        : undefined;

    const proxyRef: object = new Proxy(targetObj, {
        has(target, prop) {
            if (prop === Symbol.unscopables) {
                return false;
            }
            if (isBlockedProp(prop)) {
                return true;
            }
            if (typeof prop === 'string' && Object.hasOwn(options.injections, prop)) {
                return true;
            }
            if (
                prop === 'window'
                || prop === 'self'
                || prop === 'globalThis'
                || prop === 'frames'
                || prop === 'navigator'
            ) {
                return true;
            }
            return prop in target;
        },
        get(target, prop) {
            if (prop === Symbol.unscopables) {
                return undefined;
            }
            if (isBlockedProp(prop)) {
                throw new SandboxSecurityError(String(prop));
            }
            if (typeof prop === 'string' && Object.hasOwn(options.injections, prop)) {
                return options.injections[prop];
            }
            if (
                prop === 'window'
                || prop === 'self'
                || prop === 'globalThis'
                || prop === 'frames'
            ) {
                return proxyRef;
            }
            if (prop === 'navigator') {
                const rawNav = Reflect.get(target, 'navigator', target) as Navigator | undefined;
                return options.allowNetwork ? rawNav : createBlockedNavigatorProxy(rawNav);
            }
            if (prop === 'fetch' && wrappedFetch) {
                return wrappedFetch;
            }

            const value = Reflect.get(target, prop, target);
            if (typeof value === 'function' && value.prototype === undefined) {
                return value.bind(target);
            }
            return value;
        },
        set(target, prop, value) {
            if (isBlockedProp(prop)) {
                throw new SandboxSecurityError(String(prop));
            }
            if (typeof prop === 'string' && Object.hasOwn(options.injections, prop)) {
                return false;
            }
            return Reflect.set(target, prop, value);
        },
    });

    return proxyRef;
}

async function executeInScopedRealm(
    rawCode: string,
    mode: 'schema' | 'tool' | 'script',
    _scopeProxy: object,
    compileFn: (fnSrc: string) => () => Promise<unknown>,
): Promise<unknown> {
    const { code, hasExportDefault } = prepareSandboxScript(rawCode);
    if (!code) {
        throw new SandboxExecutionError(`Empty ${mode} script.`);
    }

    const exprCandidate = code.replace(/;\s*$/, '');
    const canTryExpression = !hasExportDefault && !/\breturn\b/.test(exprCandidate);

    let compiled: (() => Promise<unknown>) | null = null;
    if (canTryExpression) {
        try {
            compiled = compileFn(`(async function() { "use strict"; return (\n${exprCandidate}\n); })`);
        } catch {
            compiled = null;
        }
    }

    if (!compiled) {
        try {
            compiled = compileFn(`(async function() {
                "use strict";
                let __agenticDefaultExport__;
                const module = { exports: undefined };
                const exports = {};
                const __res__ = await (async function() {
                    ${code}
                })();
                if (__res__ !== undefined) return __res__;
                if (__agenticDefaultExport__ !== undefined) return __agenticDefaultExport__;
                if (module.exports !== undefined) return module.exports;
                return exports.default;
            })`);
        } catch (error) {
            throw new SandboxExecutionError(
                `Failed to compile ${mode} script: ${(error as Error).message}`,
                error,
            );
        }
    }

    return await compiled();
}

function normalizeCompiledTools(
    evaluated: unknown,
    collectedTools: SandboxToolDefinition[],
): SandboxToolDefinition[] {
    if (Array.isArray(evaluated)) {
        return evaluated.map((item) => defineTool(item as SandboxToolDefinition));
    }
    if (evaluated && typeof evaluated === 'object') {
        return [defineTool(evaluated as SandboxToolDefinition)];
    }
    if (collectedTools.length > 0) {
        return collectedTools;
    }
    return [];
}
