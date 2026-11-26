import type { EjsEvaluateOptions, EjsFeaturesSnapshot } from '@/core/bridge';
import {
    LocalPromptInjectionSession,
    type PromptInjectionSession,
    type SerializedPromptInjected,
    containsInjectPromptUsage,
} from '@/core/context';

/**
 * Optional runtime shape exposed by `ST-Prompt-Template` on `globalThis.EjsTemplate`.
 */
export interface EjsTemplateGlobal {
    prepareContext?: (
        context?: Record<string, unknown>,
        end?: number,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>;
    evalTemplate: (
        code: string,
        context?: Record<string, unknown> | null,
        options?: Record<string, unknown>,
    ) => Promise<unknown> | unknown;
    createInjectionSession?: (
        initialSnapshot?: SerializedPromptInjected | null,
    ) => PromptInjectionSession;
    getFeatures?: () => Record<string, unknown>;
}

export interface EvaluateOptionalEjsCallOptions extends EjsEvaluateOptions {
    onCompatWarning?: (code: string, message: string) => void;
}

function getEjsTemplateGlobal(): EjsTemplateGlobal | null {
    const candidate = (globalThis as { EjsTemplate?: unknown }).EjsTemplate;
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const api = candidate as Partial<EjsTemplateGlobal>;
    if (typeof api.evalTemplate !== 'function') {
        return null;
    }
    return api as EjsTemplateGlobal;
}

/**
 * Probe whether `globalThis.EjsTemplate` (`ST-Prompt-Template`) is currently loaded.
 * Returns `false` silently when absent without logging or throwing.
 */
export function isEjsTemplateAvailable(): boolean {
    return getEjsTemplateGlobal() !== null;
}

/**
 * Inspect `ST-Prompt-Template` runtime feature flags (e.g., `invert_enabled`),
 * or return `null` when `EjsTemplate` is absent.
 */
export function getEjsTemplateFeatures(): EjsFeaturesSnapshot | null {
    const ejs = getEjsTemplateGlobal();
    if (!ejs || typeof ejs.getFeatures !== 'function') {
        return null;
    }
    try {
        const raw = ejs.getFeatures();
        return {
            invertEnabled: Boolean(raw && typeof raw === 'object' && raw.invert_enabled),
        };
    } catch {
        return null;
    }
}

/**
 * Create an isolated `PromptInjectionSession`, preferring `EjsTemplate.createInjectionSession`
 * when available and degrading gracefully to `LocalPromptInjectionSession` on older versions
 * or when `ST-Prompt-Template` is not installed.
 */
export function createHostPromptInjectionSession(
    initialSnapshot?: SerializedPromptInjected,
): { session: PromptInjectionSession; mode: 'native' | 'fallback' } {
    const ejs = getEjsTemplateGlobal();
    if (ejs && typeof ejs.createInjectionSession === 'function') {
        return {
            session: ejs.createInjectionSession(initialSnapshot),
            mode: 'native',
        };
    }
    return {
        session: new LocalPromptInjectionSession(initialSnapshot),
        mode: 'fallback',
    };
}

function buildVarsView(
    safeVars: Record<string, unknown>,
    extraVarsHelper: unknown,
): Record<string, unknown> {
    const view: Record<string, unknown> = { ...safeVars };
    if (extraVarsHelper && typeof extraVarsHelper === 'object') {
        const helper = extraVarsHelper as Record<string, unknown>;
        for (const methodKey of ['all', 'get']) {
            const fn = helper[methodKey];
            if (typeof fn === 'function' && !Object.hasOwn(view, methodKey)) {
                Object.defineProperty(view, methodKey, {
                    value: fn,
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
            }
        }
    }
    return view;
}

const EJS_RESERVED_CONTEXT_KEYS = new Set([
    'vars',
    'variables',
    'injectionSession',
    'injectPrompt',
    'getPromptsInjected',
    'hasPromptsInjected',
    'SillyTavern',
]);

function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function serializeVarDigest(value: unknown): string {
    if (value === undefined) {
        return 'u';
    }
    if (value === null) {
        return 'n';
    }
    if (typeof value === 'string') {
        return `s:${value}`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return `p:${String(value)}`;
    }
    try {
        return `j:${JSON.stringify(value)}`;
    } catch {
        return `x:${String(value)}`;
    }
}

function snapshotShallowRecord(obj: Record<string, unknown>): Map<string, string> {
    const snap = new Map<string, string>();
    for (const [key, value] of Object.entries(obj)) {
        snap.set(key, serializeVarDigest(value));
    }
    return snap;
}

/**
 * Evaluate optional `<% ... %>` EJS template tags when `globalThis.EjsTemplate` is installed.
 *
 * Silently degrades by returning `text` unmodified when `EjsTemplate` is unavailable
 * or when `text` contains no `<%` tags.
 */
export async function evaluateOptionalEjs(
    text: string,
    vars: Record<string, unknown> = {},
    extraHelpers?: Record<string, unknown>,
    options?: EvaluateOptionalEjsCallOptions,
): Promise<string> {
    if (typeof text !== 'string') {
        return String(text ?? '');
    }
    if (!text.includes('<%')) {
        return text;
    }

    const ejs = getEjsTemplateGlobal();
    if (!ejs) {
        return text;
    }

    const templateCode = options?.isPrivate
        ? `<% await (async () => { %>${text}<% })(); %>`
        : text;

    const safeVars: Record<string, unknown> =
        vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};

    const ejsSession = options?.ejsSession;
    const pendingUpdates = ejsSession?.pendingMacroVarUpdates;
    const mergedSafeVars: Record<string, unknown> = pendingUpdates
        ? { ...safeVars, ...pendingUpdates }
        : safeVars;

    const extraWithoutVars: Record<string, unknown> = {};
    if (extraHelpers) {
        for (const [key, value] of Object.entries(extraHelpers)) {
            if (key !== 'vars') {
                extraWithoutVars[key] = value;
            }
        }
    }
    const varsView = buildVarsView(mergedSafeVars, extraHelpers?.vars);

    const session = options?.injectionSession;
    if (session && typeof ejs.createInjectionSession !== 'function' && containsInjectPromptUsage(text)) {
        options?.onCompatWarning?.(
            'ejs_old_version_inject_prompt',
            '检测到旧版 ST-Prompt-Template（缺少 createInjectionSession 隔离接口）：已启用本地兼容模式处理顶层 injectPrompt/getPromptsInjected，建议更新 ST-Prompt-Template 以支持 getwi/define 嵌套调用。',
        );
    }

    let ctx: Record<string, unknown>;
    if (ejsSession?.hostContext) {
        // Reuse the prepared context strictly in-place to preserve EjsTemplate `this` bindings,
        // `scope: 'cache'` variables, and cross-block `define()` definitions.
        ctx = ejsSession.hostContext;
        if (pendingUpdates && Object.keys(pendingUpdates).length > 0 && isPlainObjectRecord(ctx.variables)) {
            Object.assign(ctx.variables, pendingUpdates);
        }
        if (ejsSession) {
            ejsSession.pendingMacroVarUpdates = undefined;
        }
        Object.assign(ctx, extraWithoutVars);
        ctx.vars = varsView;
        for (const [key, value] of Object.entries(mergedSafeVars)) {
            if (EJS_RESERVED_CONTEXT_KEYS.has(key) || typeof ctx[key] === 'function') {
                continue;
            }
            ctx[key] = value;
        }
        if (session) {
            ctx.injectionSession = session;
        }
    } else {
        const mergedEnv: Record<string, unknown> = {
            ...mergedSafeVars,
            ...extraWithoutVars,
            vars: varsView,
            ...(session ? { injectionSession: session } : {}),
        };

        if (typeof ejs.prepareContext === 'function') {
            const prepared = await ejs.prepareContext(mergedEnv);
            ctx = prepared && typeof prepared === 'object' ? prepared : { ...mergedEnv };
            for (const [key, value] of Object.entries(mergedEnv)) {
                if (key !== 'injectionSession' && !(key in ctx)) {
                    ctx[key] = value;
                }
            }
            Object.assign(ctx, extraWithoutVars);
            ctx.vars = varsView;
        } else {
            ctx = mergedEnv;
        }

        if (pendingUpdates && Object.keys(pendingUpdates).length > 0 && isPlainObjectRecord(ctx.variables)) {
            Object.assign(ctx.variables, pendingUpdates);
        }
        if (ejsSession) {
            ejsSession.pendingMacroVarUpdates = undefined;
            ejsSession.hostContext = ctx;
        }
    }

    if (session) {
        ctx.injectPrompt = session.injectPrompt.bind(session);
        ctx.getPromptsInjected = session.getPromptsInjected.bind(session);
        ctx.hasPromptsInjected = session.hasPromptsInjected.bind(session);
    }

    const preEvalVarSnapshot =
        ejsSession && isPlainObjectRecord(ctx.variables)
            ? snapshotShallowRecord(ctx.variables)
            : null;

    const evaluated = await ejs.evalTemplate(templateCode, ctx);

    if (ejsSession && preEvalVarSnapshot && isPlainObjectRecord(ctx.variables)) {
        const changed: Record<string, unknown> = {};
        let hasChanges = false;
        for (const [key, value] of Object.entries(ctx.variables)) {
            const nextDigest = serializeVarDigest(value);
            if (!preEvalVarSnapshot.has(key) || preEvalVarSnapshot.get(key) !== nextDigest) {
                changed[key] = value;
                hasChanges = true;
            }
        }
        ejsSession.lastEjsVarUpdates = hasChanges ? changed : undefined;
    } else if (ejsSession) {
        ejsSession.lastEjsVarUpdates = undefined;
    }

    if (evaluated === undefined || evaluated === null) {
        return '';
    }
    return typeof evaluated === 'string' ? evaluated : String(evaluated);
}
