import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EjsRenderSession } from '@/core/bridge';
import { LocalPromptInjectionSession } from '@/core/context';
import {
    createHostPromptInjectionSession,
    evaluateOptionalEjs,
    getEjsTemplateFeatures,
} from '@/host/ejs-adapter';

describe('ejs-adapter compatibility & ctx.vars shadowing fix', () => {
    const globalHolder = globalThis as { EjsTemplate?: unknown };
    const originalEjsTemplate = globalHolder.EjsTemplate;

    afterEach(() => {
        if (originalEjsTemplate === undefined) {
            delete globalHolder.EjsTemplate;
        } else {
            globalHolder.EjsTemplate = originalEjsTemplate;
        }
    });

    it('preserves user vars properties on ctx.vars alongside vars.get/vars.all helpers', async () => {
        globalHolder.EjsTemplate = {
            prepareContext: async (env: Record<string, unknown>) => ({ ...env }),
            evalTemplate: async (_code: string, ctx: Record<string, unknown>) => {
                const varsObj = ctx.vars as Record<string, unknown> & {
                    get?: (key: string) => Promise<unknown>;
                };
                const directProp = varsObj.hp;
                const topLevel = ctx.hp;
                const helperVal = await varsObj.get?.('hp');
                return `${String(directProp)}|${String(topLevel)}|${String(helperVal)}`;
            },
        };

        const out = await evaluateOptionalEjs(
            '<%- vars.hp %>',
            { hp: 88 },
            {
                vars: {
                    all: async () => ({ hp: 88 }),
                    get: async (k: string) => (k === 'hp' ? 88 : undefined),
                },
            },
        );
        expect(out).toBe('88|88|88');
    });

    it('falls back cleanly with a deduplicated warning when ST-Prompt-Template lacks createInjectionSession', async () => {
        const warnings: Array<{ code: string; message: string }> = [];
        globalHolder.EjsTemplate = {
            getFeatures: () => ({ invert_enabled: true }),
            prepareContext: async (env: Record<string, unknown>) => ({ ...env }),
            evalTemplate: async (code: string, ctx: Record<string, unknown>) => {
                const inject = ctx.injectPrompt as (k: string, p: string, o?: number, s?: number) => void;
                const get = ctx.getPromptsInjected as (k: string) => string;
                if (code.includes('injectPrompt(')) {
                    inject('hud', 'HP=95', 10, 1);
                    return '';
                }
                if (code.includes('getPromptsInjected(')) {
                    return get('hud');
                }
                return code;
            },
        };

        expect(getEjsTemplateFeatures()).toEqual({ invertEnabled: true });
        const created = createHostPromptInjectionSession();
        expect(created.mode).toBe('fallback');
        expect(created.session).toBeInstanceOf(LocalPromptInjectionSession);

        await evaluateOptionalEjs(
            '<% injectPrompt("hud", "HP=95", 10, 1); %>',
            {},
            undefined,
            {
                injectionSession: created.session,
                onCompatWarning: (code, message) => warnings.push({ code, message }),
            },
        );
        const readOut = await evaluateOptionalEjs(
            '<%- getPromptsInjected("hud") %>',
            {},
            undefined,
            {
                injectionSession: created.session,
                onCompatWarning: (code, message) => warnings.push({ code, message }),
            },
        );

        expect(readOut).toBe('HP=95');
        expect(warnings.some((w) => w.code === 'ejs_old_version_inject_prompt')).toBe(true);
    });

    it('reuses prepared hostContext in-place across calls when ejsSession is provided and syncs macro/EJS variables', async () => {
        const prepareSpy = vi.fn(async (env: Record<string, unknown>) => {
            const variables: Record<string, unknown> = { ...(env.vars as Record<string, unknown>) };
            const ctx: Record<string, unknown> = {
                ...env,
                variables,
                // Method relying on `this === ctx` to verify in-place reuse
                readViaThis(key: string) {
                    return (this.variables as Record<string, unknown>)[key];
                },
                setViaThis(key: string, val: unknown) {
                    (this.variables as Record<string, unknown>)[key] = val;
                },
            };
            return ctx;
        });

        globalHolder.EjsTemplate = {
            prepareContext: prepareSpy,
            evalTemplate: async (code: string, ctx: Record<string, unknown>) => {
                const typedCtx = ctx as {
                    setViaThis: (k: string, v: unknown) => void;
                    readViaThis: (k: string) => unknown;
                    customDefine?: string;
                    vars: Record<string, unknown>;
                };
                if (code.includes('STEP_1')) {
                    typedCtx.setViaThis('cache_note', 'from_step_1');
                    ctx.customDefine = 'defined_once';
                    return '';
                }
                if (code.includes('STEP_2')) {
                    const cacheVal = typedCtx.readViaThis('cache_note');
                    const macroVal = typedCtx.readViaThis('macro_var');
                    const topMacroVal = typedCtx.vars.macro_var;
                    return `${String(cacheVal)}|${String(macroVal)}|${String(topMacroVal)}|${String(ctx.customDefine)}`;
                }
                return code;
            },
        };

        const ejsSession: EjsRenderSession = {};

        await evaluateOptionalEjs('<% STEP_1 %>', { hp: 100 }, undefined, { ejsSession });
        expect(prepareSpy).toHaveBeenCalledTimes(1);
        expect(ejsSession.lastEjsVarUpdates).toEqual({ cache_note: 'from_step_1' });

        // Simulate an ST macro mutating `macro_var` between block 1 and block 2
        ejsSession.pendingMacroVarUpdates = { macro_var: 'updated_by_macro' };

        const step2Out = await evaluateOptionalEjs('<% STEP_2 %>', { hp: 100 }, undefined, {
            ejsSession,
        });
        expect(prepareSpy).toHaveBeenCalledTimes(1);
        expect(ejsSession.pendingMacroVarUpdates).toBeUndefined();
        expect(step2Out).toBe('from_step_1|updated_by_macro|updated_by_macro|defined_once');
    });
});
