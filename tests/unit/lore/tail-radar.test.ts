import { describe, expect, it } from 'vitest';
import { LoreReadEvaluator, TailRadar, WIClassifier } from '@/core/lore';
import type { RawLoreEntry } from '@/core/types';
import { MemoryHostBridge } from '../../mocks';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import ejsConditionalLore from '../../fixtures/ejs-conditional-lore.json';
import { evaluateFixtureEjs } from './read-evaluator.test';

function makeArchiveEntry(overrides: Partial<RawLoreEntry> & { uid: number; keys: string[] }): RawLoreEntry {
    return {
        world: 'TestWorld',
        comment: `条目-${overrides.uid}`,
        content: `条目 ${overrides.uid} 的档案正文内容。`,
        keysecondary: [],
        constant: false,
        selective: false,
        selectiveLogic: 0,
        disable: false,
        position: 1,
        depth: 4,
        order: 100,
        role: 0,
        ...overrides,
    };
}

describe('TailRadar', () => {
    it('scans only Category ③ entries and supports hollow-chinese-card selective logic', async () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const classifier = new WIClassifier();
        const classified = classifier.classifyLorebooks(await bridge.listEnabledLorebooks());
        const radar = TailRadar.fromBridge(bridge);

        // Input mentions "银莲花" and "守夜人" (without secondary keyword "协议/应急/密码")
        // Also includes "[InitVar]" / "林晚" from constant entries which must NEVER appear in radar
        const scan1 = await radar.scan(classified.all, '我从怀里取出银莲花铜徽，向守夜人询问林晚的下落。');
        expect(scan1.candidates).toHaveLength(1);
        expect(scan1.candidates[0]).toMatchObject({
            uid: 5,
            path: '/lorebooks/霜烬纪元/银莲花结社档案-5.md',
            status: 'unread',
        });
        expect(scan1.hintXml).toContain('<lore-hint>');
        expect(scan1.hintXml).toContain('- [未读] /lorebooks/霜烬纪元/银莲花结社档案-5.md');
        expect(scan1.hintXml).toContain('可能存在日常词误报，仅在剧情确实需要时按需 read_file，无关请直接忽略');

        // Input now includes secondary keyword "应急" for uid 7 ("守夜人应急协议")
        const scan2 = await radar.scan(classified.all, '启动守夜人应急预案！');
        expect(scan2.candidates).toHaveLength(1);
        expect(scan2.candidates[0].uid).toBe(7);
        expect(scan2.candidates[0].matchedKeywords).toEqual(['守夜人', '应急']);
    });

    it('implements all 4 selectiveLogic modes, regex /pattern/flags, caseSensitive, matchWholeWords, and scanDepth', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '艾琳' },
        });
        const radar = TailRadar.fromBridge(bridge);

        const entries: RawLoreEntry[] = [
            // 0: AND_ANY
            makeArchiveEntry({ uid: 1, keys: ['门'], selective: true, keysecondary: ['红', '蓝'], selectiveLogic: 0 }),
            // 1: NOT_ALL
            makeArchiveEntry({ uid: 2, keys: ['门'], selective: true, keysecondary: ['红', '蓝'], selectiveLogic: 1 }),
            // 2: NOT_ANY
            makeArchiveEntry({ uid: 3, keys: ['门'], selective: true, keysecondary: ['红', '蓝'], selectiveLogic: 2 }),
            // 3: AND_ALL
            makeArchiveEntry({ uid: 4, keys: ['门'], selective: true, keysecondary: ['红', '蓝'], selectiveLogic: 3 }),
            // Regex with escaped slash and /ig flags (stateless across scans)
            makeArchiveEntry({ uid: 5, keys: ['/sector\\s+7\\/B/ig'], comment: '扇区档案' }),
            // Case-sensitive plaintext
            makeArchiveEntry({ uid: 6, keys: ['VaultKey'], caseSensitive: true, comment: '秘钥' }),
            // Whole word match
            makeArchiveEntry({ uid: 7, keys: ['car'], matchWholeWords: true, comment: '汽车' }),
            // Macro inside keyword + scanDepth=1
            makeArchiveEntry({ uid: 8, keys: ['{{char}}的密信'], scanDepth: 1, comment: '密信' }),
        ];

        const onlyRed = await radar.scan(entries, '推开红门');
        expect(onlyRed.candidates.map((c) => c.uid).sort()).toEqual([1, 2]);

        const bothRedBlue = await radar.scan(entries, '红蓝之门');
        expect(bothRedBlue.candidates.map((c) => c.uid).sort()).toEqual([1, 4]);

        const neither = await radar.scan(entries, '木门');
        expect(neither.candidates.map((c) => c.uid).sort()).toEqual([2, 3]);

        // Regex /ig repeated checks remain stateless
        const regexHit1 = await radar.scan(entries, '前往 Sector 7/B');
        const regexHit2 = await radar.scan(entries, '检查 sector 7/B');
        expect(regexHit1.candidates.map((c) => c.uid)).toEqual([5]);
        expect(regexHit2.candidates.map((c) => c.uid)).toEqual([5]);

        // Case sensitivity
        expect((await radar.scan(entries, 'vaultkey')).candidates).toHaveLength(0);
        expect((await radar.scan(entries, 'found VaultKey')).candidates.map((c) => c.uid)).toEqual([6]);

        // Whole word: 'carpet' must NOT match 'car', 'a car.' MUST match 'car'
        expect((await radar.scan(entries, 'red carpet')).candidates).toHaveLength(0);
        expect((await radar.scan(entries, 'parked a car.')).candidates.map((c) => c.uid)).toEqual([7]);

        // Macro substitution in key + scanDepth=1 ignores older recentMessages
        const depthSkipped = await radar.scan(entries, {
            input: '普通输入',
            recentMessages: ['找到艾琳的密信'],
        });
        expect(depthSkipped.candidates).toHaveLength(0);

        const depthHit = await radar.scan(entries, {
            input: '打开艾琳的密信',
            recentMessages: ['上一轮'],
        });
        expect(depthHit.candidates.map((c) => c.uid)).toEqual([8]);
    });

    it('performs xxHash Read-Set dirty-checking on EJS branch flips and remains silent when unchanged', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默' },
            lorebooks: {
                [ejsConditionalLore.world]: ejsConditionalLore.entries as RawLoreEntry[],
            },
            ejsEvaluator: evaluateFixtureEjs,
        });
        bridge.setVariable('favorability', 20);

        const evaluator = new LoreReadEvaluator(bridge);
        const radar = new TailRadar(evaluator);
        const entries = (await bridge.listEnabledLorebooks()).get(ejsConditionalLore.world)!;
        const readSet = new Map<string, string>();

        // 1. First hit -> [未读]
        const firstScan = await radar.scan(entries, {
            input: '我去打听林晚的消息。',
            readSet,
        });
        expect(firstScan.candidates).toHaveLength(1);
        expect(firstScan.candidates[0].status).toBe('unread');
        expect(firstScan.hintXml).toContain('- [未读] /lorebooks/条件分支测试书/林晚好感度阶段档案-201.md');

        // Simulate agent calling read_file and recording rendered xxHash in Read-Set
        readSet.set(firstScan.candidates[0].path, firstScan.candidates[0].contentHash);

        // 2. Variable changes (20 -> 35) WITHOUT crossing >= 50 EJS branch -> SILENT!
        bridge.setVariable('favorability', 35);
        const unchangedScan = await radar.scan(entries, {
            input: '我再次提起林晚。',
            readSet,
        });
        expect(unchangedScan.candidates).toHaveLength(0);
        expect(unchangedScan.totalMatched).toBe(0);
        expect(unchangedScan.hintXml).toBe('');

        // 3. Variable crosses threshold (35 -> 60) -> EJS branch flips -> xxHash changes -> [已更新]!
        bridge.setVariable('favorability', 60);
        const updatedScan = await radar.scan(entries, {
            input: '我信任林晚的判断。',
            readSet,
        });
        expect(updatedScan.candidates).toHaveLength(1);
        expect(updatedScan.candidates[0].status).toBe('updated');
        expect(updatedScan.candidates[0].contentHash).not.toBe(firstScan.candidates[0].contentHash);
        expect(updatedScan.hintXml).toContain('- [已更新] /lorebooks/条件分支测试书/林晚好感度阶段档案-201.md');

        // 4. After agent re-reads updated entry, subsequent mention is silent again
        readSet.set(updatedScan.candidates[0].path, updatedScan.candidates[0].contentHash);
        const postUpdateSilent = await radar.scan(entries, {
            input: '林晚递给我一把钥匙。',
            readSet,
        });
        expect(postUpdateSilent.candidates).toHaveLength(0);
        expect(postUpdateSilent.hintXml).toBe('');
    });

    it('detects worldinfo override changes as [已更新] in Read-Set dirty-checking', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默' },
        });
        const entry = makeArchiveEntry({
            uid: 50,
            comment: '黑市账本',
            keys: ['账本'],
            content: '旧账本：暂无记录。',
        });

        const evaluator = new LoreReadEvaluator(bridge);
        const radar = new TailRadar(evaluator);
        const readSet = new Map<string, string>();

        const s1 = await radar.scan([entry], { input: '查看账本', readSet });
        readSet.set(s1.candidates[0].path, s1.candidates[0].contentHash);

        // Same content -> silent
        const s2 = await radar.scan([entry], { input: '查看账本', readSet });
        expect(s2.candidates).toHaveLength(0);

        // Worldinfo override updates content -> [已更新]
        const s3 = await radar.scan([entry], {
            input: '查看账本',
            readSet,
            overrides: {
                'TestWorld/50': '新账本：记录了三笔灵能炉走私交易。',
            },
        });
        expect(s3.candidates).toHaveLength(1);
        expect(s3.candidates[0].status).toBe('updated');
        expect(s3.hintXml).toContain('- [已更新] /lorebooks/TestWorld/黑市账本-50.md');
    });

    it('enforces Top-K cap (default K=5) prioritized by specificity and order with +N overflow line', async () => {
        const bridge = new MemoryHostBridge();
        const radar = TailRadar.fromBridge(bridge);

        const entries: RawLoreEntry[] = [
            makeArchiveEntry({ uid: 1, keys: ['花'], order: 999 }), // specificity 1
            makeArchiveEntry({ uid: 2, keys: ['莲花'], order: 100 }), // specificity 2
            makeArchiveEntry({ uid: 3, keys: ['银莲花'], order: 50 }), // specificity 3
            makeArchiveEntry({ uid: 4, keys: ['银莲花结社'], order: 10 }), // specificity 5
            makeArchiveEntry({ uid: 5, keys: ['灰港'], order: 300 }), // specificity 2, order 300 > uid 2
            makeArchiveEntry({ uid: 6, keys: ['灰港码头'], order: 20 }), // specificity 4
            makeArchiveEntry({ uid: 7, keys: ['酒馆'], order: 250 }), // specificity 2, order 250
            makeArchiveEntry({ uid: 8, keys: ['银'], order: 800 }), // specificity 1, order 800
        ];

        const result = await radar.scan(entries, '在灰港码头的酒馆里，银莲花结社正在议事。');

        expect(result.totalMatched).toBe(8);
        expect(result.candidates).toHaveLength(5);
        expect(result.overflowCount).toBe(3);

        // Expected top 5 order:
        // uid 4 (spec 5) -> uid 6 (spec 4) -> uid 3 (spec 3) -> uid 5 (spec 2, order 300) -> uid 7 (spec 2, order 250)
        expect(result.candidates.map((c) => c.uid)).toEqual([4, 6, 3, 5, 7]);
        expect(result.hintXml).toContain('+3 条更多候选匹配，如有需要请调用 search_files 检索');
    });

    it('supports tide EJS branch flip, scanDepth > 1 across recentMessages, disabled filtering, and custom topK', async () => {
        const bridge = new MemoryHostBridge({
            lorebooks: {
                [ejsConditionalLore.world]: ejsConditionalLore.entries as RawLoreEntry[],
            },
            ejsEvaluator: evaluateFixtureEjs,
        });
        bridge.setVariable('tide', 'low');

        const radar = TailRadar.fromBridge(bridge);
        const entries = (await bridge.listEnabledLorebooks()).get(ejsConditionalLore.world)!;
        const readSet = new Map<string, string>();

        const s1 = await radar.scan(entries, {
            input: '去看看码头情况。',
            readSet,
        });
        expect(s1.candidates).toHaveLength(1);
        expect(s1.candidates[0].uid).toBe(202);
        readSet.set(s1.candidates[0].path, s1.candidates[0].contentHash);

        // Unchanged tide -> silent
        const s2 = await radar.scan(entries, {
            input: '检查潮汐水位。',
            readSet,
        });
        expect(s2.candidates).toHaveLength(0);

        // Flip tide -> high -> [已更新]
        bridge.setVariable('tide', 'high');
        const s3 = await radar.scan(entries, {
            input: '检查潮汐水位。',
            readSet,
        });
        expect(s3.candidates).toHaveLength(1);
        expect(s3.candidates[0].status).toBe('updated');

        // Disabled & empty keys ignored; scanDepth=2 picks up recentMessages
        const extraEntries: RawLoreEntry[] = [
            makeArchiveEntry({ uid: 901, keys: ['暗号'], disable: true }),
            makeArchiveEntry({ uid: 902, keys: [] }),
            makeArchiveEntry({ uid: 903, keys: ['暗号'], scanDepth: 2, order: 200 }),
            makeArchiveEntry({ uid: 904, keys: ['接头'], scanDepth: 2, order: 100 }),
        ];

        const multiTurn = await radar.scan(extraEntries, {
            input: '现在去接头。',
            recentMessages: ['上上轮废话', '刚才我们约定了暗号'],
            topK: 1,
        });
        expect(multiTurn.totalMatched).toBe(2);
        expect(multiTurn.candidates).toHaveLength(1);
        expect(multiTurn.overflowCount).toBe(1);
        expect(multiTurn.candidates[0].uid).toBe(903);
    });

    it('filters out keyword-matched entries whose @@if condition evaluates to false', async () => {
        const bridge = new MemoryHostBridge({
            ejsEvaluator: async (text, vars) => {
                if (text.includes('!!(vars.chapter >= 2)')) {
                    return Number(vars.chapter) >= 2 ? 'true' : 'false';
                }
                return text;
            },
        });
        const radar = TailRadar.fromBridge(bridge);
        const gatedEntry = makeArchiveEntry({
            uid: 950,
            comment: '二章暗线',
            keys: ['暗门'],
            content: '@@if vars.chapter >= 2\n通往地下船坞的暗门已经打开。',
        });

        const ch1 = await radar.scan([gatedEntry], { input: '寻找暗门', vars: { chapter: 1 } });
        expect(ch1.candidates).toHaveLength(0);

        const ch2 = await radar.scan([gatedEntry], { input: '寻找暗门', vars: { chapter: 2 } });
        expect(ch2.candidates).toHaveLength(1);
        expect(ch2.candidates[0].uid).toBe(950);
    });
});
