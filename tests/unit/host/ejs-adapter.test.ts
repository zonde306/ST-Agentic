import { afterEach, describe, expect, it } from 'vitest';
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
});
