import { describe, expect, it } from 'vitest';
import {
    buildCoreManifest,
    classifyEntry,
    isHollowCharacterCard,
    WIClassifier,
} from '@/core/lore';
import type { RawLoreEntry, WICategory } from '@/core/types';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import ejsConditionalLore from '../../fixtures/ejs-conditional-lore.json';

describe('WIClassifier & Hollow Character Card detection', () => {
    it('classifies all 13 entries of hollow-chinese-card.json into the 4 semantic categories', () => {
        const classifier = new WIClassifier();
        const lorebooks = hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>;
        const result = classifier.classifyLorebooks(lorebooks);

        expect(result.all).toHaveLength(13);

        const byUid = new Map<number, WICategory>(
            result.all.map((item) => [item.entry.uid, item.category]),
        );

        // Category ①: system_rule (explicit @@system + constant @D0~@D2 System without dynamic scripts)
        expect(byUid.get(1)).toBe('system_rule');
        expect(byUid.get(2)).toBe('system_rule');

        // Category ②: core_manifest (constant Before/After Char without triggers/dynamic scripts)
        expect(byUid.get(3)).toBe('core_manifest');
        expect(byUid.get(4)).toBe('core_manifest');

        // Category ③: on_demand_archive (green-light keyword entries)
        expect(byUid.get(5)).toBe('on_demand_archive');
        expect(byUid.get(6)).toBe('on_demand_archive');
        expect(byUid.get(7)).toBe('on_demand_archive');

        // Category ④: dynamic_or_trigger ([InitVar], @@replace, @@variables_json, @D0 getvar bar, @@skill, @@agent)
        expect(byUid.get(8)).toBe('dynamic_or_trigger');
        expect(byUid.get(9)).toBe('dynamic_or_trigger');
        expect(byUid.get(10)).toBe('dynamic_or_trigger');
        expect(byUid.get(11)).toBe('dynamic_or_trigger');
        expect(byUid.get(12)).toBe('dynamic_or_trigger');
        expect(byUid.get(13)).toBe('dynamic_or_trigger');

        expect(result.byCategory.system_rule).toHaveLength(2);
        expect(result.byCategory.core_manifest).toHaveLength(2);
        expect(result.byCategory.on_demand_archive).toHaveLength(3);
        expect(result.byCategory.dynamic_or_trigger).toHaveLength(6);

        // Verify VFS paths
        expect(result.byPath.has('/lorebooks/霜烬纪元/银莲花结社档案-5.md')).toBe(true);
        expect(result.byPath.has('/skills/rune-decode.md')).toBe(true);
    });

    it('keeps green-light EJS conditional entries in on_demand_archive', () => {
        const classifier = new WIClassifier();
        const entries = ejsConditionalLore.entries as RawLoreEntry[];
        const result = classifier.classifyEntries(entries);

        expect(result.byCategory.on_demand_archive).toHaveLength(2);
        expect(result.all.every((c) => c.category === 'on_demand_archive')).toBe(true);
    });

    it('supports wiRouterOverrides across VFS path and world/uid key formats', () => {
        const entries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const classifier = new WIClassifier({
            overrides: {
                '霜烬纪元/3': 'system_rule',
                '/lorebooks/霜烬纪元/灰港码头与旧灯塔酒馆-6.md': 'core_manifest',
                '霜烬纪元:2': 'core_manifest',
            },
        });

        const result = classifier.classifyEntries(entries);
        const uid3 = result.all.find((c) => c.entry.uid === 3)!;
        const uid6 = result.all.find((c) => c.entry.uid === 6)!;
        const uid2 = result.all.find((c) => c.entry.uid === 2)!;

        expect(uid3.category).toBe('system_rule');
        expect(uid3.overridden).toBe(true);
        expect(uid3.reason).toBe('manual_override');

        expect(uid6.category).toBe('core_manifest');
        expect(uid6.overridden).toBe(true);

        expect(uid2.category).toBe('core_manifest');
        expect(uid2.overridden).toBe(true);
    });

    it('detects hollow character cards and generates compensation guidance in Core Manifest', () => {
        expect(isHollowCharacterCard(hollowChineseCard.characterFields)).toBe(true);
        expect(isHollowCharacterCard({})).toBe(true);
        expect(
            isHollowCharacterCard({
                name: '长名字测试角色',
                first_mes: '这是一段很长很长的开场白文本，用于测试开场白不应被计入实质设定字数。'.repeat(5),
                description: '空壳。',
            }),
        ).toBe(true);

        expect(
            isHollowCharacterCard({
                description: '她曾是北方学院的首席铭文师，擅长解析古代灵能矩阵与地热炉共振回路，性格冷静果断，随身携带一枚传承自导师的银质星盘。'.repeat(2),
            }),
        ).toBe(false);

        const classifier = new WIClassifier();
        const classified = classifier.classifyEntries(
            hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        );

        const hollowManifest = buildCoreManifest({
            characterFields: hollowChineseCard.characterFields,
            coreEntries: classified.byCategory.core_manifest,
            personaDescription: hollowChineseCard.personaDescription,
        });

        expect(hollowManifest.isHollowCard).toBe(true);
        expect(hollowManifest.text).toContain('世界书驱动型卡片');
        expect(hollowManifest.text).toContain('/character/description.md');
        expect(hollowManifest.text).toContain('/persona/description.md');
        expect(hollowManifest.text).toContain('/lorebooks/霜烬纪元/核心人物林晚-3.md');
        expect(hollowManifest.text).toContain('/lorebooks/霜烬纪元/世界观总纲霜烬纪元-4.md');
        // Core entries ordered by order descending (500 before 400)
        expect(hollowManifest.coreEntries.map((c) => c.entry.uid)).toEqual([3, 4]);

        const richManifest = buildCoreManifest({
            characterFields: {
                description:
                    '这是一段明确超过八十字的完整原生角色卡描述文本，详细记录了主角的出身、经历、外貌特征、性格倾向、能力体系与核心目标，并补充了她与灰港各方势力之间的纠葛关系与过往约定，因此不应触发空壳卡片补偿提示。',
            },
            coreEntries: classified.byCategory.core_manifest,
        });
        expect(richManifest.isHollowCard).toBe(false);
        expect(richManifest.text).not.toContain('世界书驱动型卡片');

        // Custom hollowThreshold override
        expect(isHollowCharacterCard({ description: '较短但自定义阈值更低的角色简介文本。' }, 10)).toBe(false);
    });

    it('handles disabled entries, non-system @D roles, [GENERATE:BEFORE], and pure EJS scripts', () => {
        const base: RawLoreEntry = {
            world: 'W',
            uid: 100,
            comment: 'Base',
            content: '内容',
            keys: ['k'],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 4,
            depth: 1,
            order: 10,
            role: 1, // User role, not System
        };

        // Constant @D1 with role=1 (User) goes to core_manifest instead of system_rule
        expect(classifyEntry(base).category).toBe('core_manifest');
        // Constant @D4 (depth > 2) non-dynamic goes to core_manifest
        expect(classifyEntry({ ...base, depth: 4, role: 0 }).category).toBe('core_manifest');
        // Constant @D4 with {{getvar::hp}} goes to dynamic_or_trigger
        expect(classifyEntry({ ...base, depth: 4, role: 0, content: 'HP={{getvar::hp}}' }).category).toBe('dynamic_or_trigger');

        // [GENERATE:BEFORE] and {{setvar::...}} go to dynamic_or_trigger
        expect(classifyEntry({ ...base, content: '[GENERATE:BEFORE]\n计算' }).category).toBe('dynamic_or_trigger');
        expect(classifyEntry({ ...base, content: '{{setvar::hp::90}}' }).category).toBe('dynamic_or_trigger');

        // Pure EJS side-effect script (no output) goes to dynamic_or_trigger
        expect(classifyEntry({ ...base, constant: false, content: '<% vars.flag = true; %>' }).category).toBe('dynamic_or_trigger');

        // Disabled filtering in batch vs includeDisabled: true
        const classifier = new WIClassifier();
        const disabledEntry: RawLoreEntry = { ...base, uid: 101, disable: true };
        expect(classifier.classifyEntries([disabledEntry]).all).toHaveLength(0);
        expect(classifier.classifyEntries([disabledEntry], { includeDisabled: true }).all).toHaveLength(1);
    });
});
