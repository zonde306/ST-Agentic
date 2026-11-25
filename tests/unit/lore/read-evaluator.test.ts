import { describe, expect, it } from 'vitest';
import { LoreReadEvaluator } from '@/core/lore';
import type { LoreReadContext, RawLoreEntry } from '@/core/types';
import { MemoryHostBridge } from '../../mocks';
import ejsConditionalLore from '../../fixtures/ejs-conditional-lore.json';

/** Lightweight deterministic EJS evaluator for `ejs-conditional-lore.json` tests. */
export function evaluateFixtureEjs(text: string, vars: Record<string, unknown>): string {
    const getvar = (name: string): unknown => vars[name];

    let rendered = text.replace(
        /<%\s*if\s*\(\s*getvar\(['"]([^'"]+)['"]\)\s*(>=|===)\s*([^)]+?)\s*\)\s*\{\s*%>\s*([\s\S]*?)<%\s*\}\s*else\s*\{\s*%>\s*([\s\S]*?)<%\s*\}\s*%>/g,
        (_m, varName: string, op: string, rawRhs: string, thenBranch: string, elseBranch: string) => {
            const lhs = getvar(varName);
            const rhsTrimmed = rawRhs.trim();
            const rhs = rhsTrimmed.startsWith("'") || rhsTrimmed.startsWith('"')
                ? rhsTrimmed.slice(1, -1)
                : Number(rhsTrimmed);
            const condition = op === '>=' ? Number(lhs) >= Number(rhs) : lhs === rhs;
            return condition ? thenBranch : elseBranch;
        },
    );

    rendered = rendered.replace(
        /<%=\s*getvar\(['"]([^'"]+)['"]\)\s*>=\s*(\d+)\s*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*%>/g,
        (_m, varName: string, threshold: string, tVal: string, fVal: string) =>
            Number(getvar(varName)) >= Number(threshold) ? tVal : fVal,
    );

    return rendered;
}

describe('LoreReadEvaluator', () => {
    it('executes override -> substituteMacros -> optional EJS -> lore_read regex -> xxHash pipeline', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '银莲花剧场' },
            ejsEvaluator: evaluateFixtureEjs,
        });
        bridge.setVariable('favorability', 60);

        const trace: string[] = [];
        const evaluator = new LoreReadEvaluator(bridge, {
            overrides: {
                '条件分支测试书/201':
                    '@@system\n覆写档案：林晚信任 {{user}}。\n<%= getvar(\'favorability\') >= 50 ? \'信赖\' : \'戒备\' %> <!--strip-->',
            },
            applyLoreReadRegex: (text) => {
                trace.push('regex');
                return text.replace(/\s*<!--strip-->/g, '');
            },
        });

        const entry = ejsConditionalLore.entries[0] as RawLoreEntry;
        const result = await evaluator.evaluate(entry);

        expect(result.overridden).toBe(true);
        expect(result.ejsEvaluated).toBe(true);
        expect(result.path).toBe('/lorebooks/条件分支测试书/林晚好感度阶段档案-201.md');
        expect(result.text).toBe('@@system\n覆写档案：林晚信任 沈默。\n信赖');
        expect(result.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(trace).toEqual(['regex']);
    });

    it('strips leading decorators when reading unoverridden entry and resolves getOverride by target', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '艾琳' },
        });

        const rawEntry: RawLoreEntry = {
            world: '霜烬纪元',
            uid: 1,
            comment: '全局文风与叙事协议',
            content: '@@system\n禁止代替 {{user}} 做决定。',
            keys: [],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 0,
            depth: 4,
            order: 1000,
            role: 0,
        };

        const evaluator = new LoreReadEvaluator(bridge, {
            getOverride: (_world, _uid, target) => {
                if (target?.messageId === 5 && target?.swipeId === 1) {
                    return '第5楼第1页覆写：允许 {{user}} 自由行动。';
                }
                return null;
            },
        });

        const baseRes = await evaluator.evaluate(rawEntry, { target: { messageId: 5, swipeId: 0 } });
        expect(baseRes.overridden).toBe(false);
        expect(baseRes.text).toBe('禁止代替 沈默 做决定。');

        const overrideRes = await evaluator.evaluate(rawEntry, { target: { messageId: 5, swipeId: 1 } });
        expect(overrideRes.overridden).toBe(true);
        expect(overrideRes.text).toBe('第5楼第1页覆写：允许 沈默 自由行动。');
        expect(overrideRes.contentHash).not.toBe(baseRes.contentHash);
    });

    it('degrades silently when evaluateOptionalEjs is absent and honors onEjsError policies', async () => {
        const bridgeNoEjs = new MemoryHostBridge({
            identity: { userName: '沈默' },
        });
        const entry = ejsConditionalLore.entries[0] as RawLoreEntry;
        const evalNoEjs = new LoreReadEvaluator(bridgeNoEjs);
        const noEjsRes = await evalNoEjs.evaluate(entry);

        expect(noEjsRes.ejsEvaluated).toBe(false);
        expect(noEjsRes.text).toContain('林晚对 沈默 保持礼貌距离');
        expect(noEjsRes.text).toContain('<% if');

        const bridgeBrokenEjs = new MemoryHostBridge({
            ejsEvaluator: () => {
                throw new Error('EJS syntax boom');
            },
        });
        const fallbackEval = new LoreReadEvaluator(bridgeBrokenEjs, { onEjsError: 'fallback' });
        const fallbackRes = await fallbackEval.evaluate(entry);
        expect(fallbackRes.ejsEvaluated).toBe(false);
        expect(fallbackRes.ejsError).toBe('EJS syntax boom');

        const strictEval = new LoreReadEvaluator(bridgeBrokenEjs, { onEjsError: 'throw' });
        await expect(strictEval.evaluate(entry)).rejects.toThrow('EJS syntax boom');
    });

    it('produces identical xxHash when EJS branch does not flip and new xxHash when branch flips', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默' },
            ejsEvaluator: evaluateFixtureEjs,
        });
        const evaluator = new LoreReadEvaluator(bridge);
        const entry = ejsConditionalLore.entries[0] as RawLoreEntry;

        const r20 = await evaluator.evaluate(entry, { vars: { favorability: 20 } });
        const r35 = await evaluator.evaluate(entry, { vars: { favorability: 35 } });
        const r60 = await evaluator.evaluate(entry, { vars: { favorability: 60 } });

        expect(r20.text).toBe(r35.text);
        expect(r20.contentHash).toBe(r35.contentHash);
        expect(r60.text).not.toBe(r20.text);
        expect(r60.contentHash).not.toBe(r20.contentHash);
    });

    it('exposes a VFS-compatible LoreReadHook via toLoreReadHook()', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默' },
            ejsEvaluator: evaluateFixtureEjs,
        });
        bridge.setVariable('tide', 'high');

        const evaluator = new LoreReadEvaluator(bridge);
        const hook = evaluator.toLoreReadHook();

        const ctx: LoreReadContext = {
            world: ejsConditionalLore.world,
            uid: 202,
            path: '/lorebooks/条件分支测试书/灰港潮汐通告-202.md',
            rawContent: ejsConditionalLore.entries[1].content,
        };

        const text = await hook(ctx);
        expect(text).toBe('高潮警报：码头下层通道已被海水淹没。');
    });

    it('supports Map overrides by VFS path and explicit empty string override', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默' },
        });
        const entry: RawLoreEntry = {
            world: 'TestBook',
            uid: 7,
            comment: '地图',
            content: '原始地图说明',
            keys: ['地图'],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 1,
            depth: 4,
            order: 50,
            role: 0,
        };

        const overrideMap = new Map<string, string>([
            ['/lorebooks/TestBook/地图-7.md', '来自 Map 的覆写，持有者 {{user}}'],
        ]);
        const evaluator = new LoreReadEvaluator(bridge, { overrides: overrideMap });
        const fromMap = await evaluator.evaluate(entry);
        expect(fromMap.overridden).toBe(true);
        expect(fromMap.text).toBe('来自 Map 的覆写，持有者 沈默');

        const emptyOverride = await evaluator.evaluate(entry, { overrideContent: '' });
        expect(emptyOverride.overridden).toBe(true);
        expect(emptyOverride.text).toBe('');
    });

    it('honors @@if conditions and @@private decorator during LoreReadEvaluator evaluation', async () => {
        let sawPrivateWrapper = false;
        const bridge = new MemoryHostBridge({
            ejsEvaluator: async (text, vars) => {
                let working = text;
                if (working.includes('await (async () => {')) {
                    sawPrivateWrapper = true;
                    working = working
                        .replace('<% await (async () => { %>', '')
                        .replace('<% })(); %>', '');
                }
                if (working.includes('!!(vars.unlocked)')) {
                    return vars.unlocked ? 'true' : 'false';
                }
                return working.replace(/<%-\s*vars\.secret\s*%>/g, String(vars.secret ?? ''));
            },
        });
        const entry: RawLoreEntry = {
            world: 'TestBook',
            uid: 88,
            comment: '机密卷宗',
            content: '@@if vars.unlocked\n@@private\n机密：<%- vars.secret %>',
            keys: ['卷宗'],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 1,
            depth: 4,
            order: 50,
            role: 0,
        };

        const evaluator = new LoreReadEvaluator(bridge);
        const locked = await evaluator.evaluate(entry, { vars: { unlocked: false, secret: 'X' } });
        expect(locked.conditionSkipped).toBe(true);
        expect(locked.text).toBe('');

        const unlocked = await evaluator.evaluate(entry, { vars: { unlocked: true, secret: '灰港密钥' } });
        expect(unlocked.conditionSkipped).toBeUndefined();
        expect(sawPrivateWrapper).toBe(true);
        expect(unlocked.text).toBe('机密：灰港密钥');
    });
});
