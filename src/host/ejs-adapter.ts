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
 * Evaluate optional `<% ... %>` EJS template tags when `globalThis.EjsTemplate` is installed.
 *
 * Silently degrades by returning `text` unmodified when `EjsTemplate` is unavailable
 * or when `text` contains no `<%` tags.
 */
export async function evaluateOptionalEjs(
    text: string,
    vars: Record<string, unknown> = {},
    extraHelpers?: Record<string, unknown>,
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

    const safeVars: Record<string, unknown> =
        vars && typeof vars === 'object' && !Array.isArray(vars) ? vars : {};

    const mergedEnv: Record<string, unknown> = {
        ...safeVars,
        ...(extraHelpers ?? {}),
    };
    if (!Object.hasOwn(mergedEnv, 'vars')) {
        mergedEnv.vars = safeVars;
    }

    let ctx: Record<string, unknown>;
    if (typeof ejs.prepareContext === 'function') {
        const prepared = await ejs.prepareContext(mergedEnv);
        ctx = prepared && typeof prepared === 'object' ? prepared : { ...mergedEnv };
        for (const [key, value] of Object.entries(mergedEnv)) {
            if (!(key in ctx)) {
                ctx[key] = value;
            }
        }
        if (extraHelpers) {
            Object.assign(ctx, extraHelpers);
        }
    } else {
        ctx = mergedEnv;
    }

    const evaluated = await ejs.evalTemplate(text, ctx);
    if (evaluated === undefined || evaluated === null) {
        return '';
    }
    return typeof evaluated === 'string' ? evaluated : String(evaluated);
}
