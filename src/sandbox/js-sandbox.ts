import _ from 'lodash';
import { z } from 'zod';
import type { ToolExecutionContext } from '@/core/bridge';
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
import { ManagedSandboxHandle, SandboxLifecycleManager } from './lifecycle';

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

                    const scopedCtx: ToolExecutionContext = {
                        fs: ctx.fs,
                        vars: ctx.vars,
                        message: ctx.message,
                        st: ctx.st,
                        target: Object.freeze({ ...ctx.target }),
                        signal: combined.signal,
                        permissions: ctx.permissions,
                        ...(ctx.readSet ? { readSet: ctx.readSet } : {}),
                    };

                    try {
                        const runPromise = Promise.resolve(def.execute(args, scopedCtx));
                        return await raceWithSignalAndTimeout(
                            runPromise,
                            combined.signal,
                            options.timeoutMs ?? this.defaultTimeoutMs,
                            `Custom tool "${def.name}"`,
                        );
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
        const id = options.id ?? this.nextId('script');
        const allowNetwork = options.allowNetwork ?? true;

        const runController = new AbortController();
        const combined = combineAbortSignals(ctx.signal, runController.signal);

        const scopedCtx: ToolExecutionContext = {
            fs: ctx.fs,
            vars: ctx.vars,
            message: ctx.message,
            st: ctx.st,
            target: Object.freeze({ ...ctx.target }),
            signal: combined.signal,
            permissions: ctx.permissions,
            ...(ctx.readSet ? { readSet: ctx.readSet } : {}),
        };

        const realm = this.createRealm(id, 'script', {
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
                target: scopedCtx.target,
                signal: scopedCtx.signal,
            },
        });
        realm.handle.trackAbortController(runController);

        try {
            return await raceWithSignalAndTimeout(
                realm.evaluateCode(code, 'script'),
                combined.signal,
                options.timeoutMs ?? this.defaultTimeoutMs,
                `Script (${id})`,
            );
        } finally {
            combined.cleanup();
            realm.handle.untrackAbortController(runController);
            if (!options.keepAlive) {
                this.lifecycle.dispose(id);
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
