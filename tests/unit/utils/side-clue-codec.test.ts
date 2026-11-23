import { describe, expect, it } from 'vitest';
import {
    DEFAULT_SIDE_CLUE_DELIVERY,
    DEFAULT_SIDE_CLUE_STATUS,
    hashText,
    initXxHash,
    isValidSideClueDelivery,
    isValidSideClueStatus,
    parseSideClue,
    parseSideClueRaw,
    parseSideClueSync,
    serializeSideClue,
    serializeSideClueWithHash,
    splitSideClueFrontmatter,
} from '@/core/utils';
import {
    SAMPLE_LINWAN_COMMS_META,
    SAMPLE_LINWAN_COMMS_RAW,
    SAMPLE_NEXT_TURN_BRIEF_RAW,
} from '../../fixtures/off-mainline-fixtures';

describe('side-clue-codec', () => {
    it('parses the canonical §2.1 frontmatter + Markdown body with exact metadata and xxHash', async () => {
        const doc = await parseSideClue('/side/comms/linwan.md', SAMPLE_LINWAN_COMMS_RAW);

        expect(doc.path).toBe('/side/comms/linwan.md');
        expect(doc.meta).toEqual(SAMPLE_LINWAN_COMMS_META);
        expect(doc.body).toBe(
            [
                '- [18:10 User]: 今晚十点老码头见，带上门禁卡。',
                '- [18:11 林晚]: 收到，东区巡逻九点半换防，我提前二十分钟在旧仓库灯塔下等你。',
            ].join('\n'),
        );
        expect(doc.contentHash).toBe(await hashText(SAMPLE_LINWAN_COMMS_RAW));
        expect(doc.contentHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('serializes frontmatter keys in deterministic canonical order and round-trips losslessly', async () => {
        const reorderedMeta = {
            updatedAt: 1732326600000,
            anchor: '12#0',
            createdAt: 1732320000000,
            summary: '林晚已在老码头旧仓库灯塔下接应，并确认东区巡逻 21:30 换防。',
            order: 100,
            scanDepth: 2,
            secondaryKeys: [],
            keywords: ['老码头', '灯塔', '林晚', '门禁卡'],
            status: 'dormant' as const,
            delivery: 'radar_hint' as const,
            title: '林晚的加密通讯线索',
            id: 'clue_linwan_comms',
            sourceSessionId: 'phone:linwan',
            consumedByTurn: 13,
        };

        const body = '- [18:10 User]: 今晚十点老码头见。\n---\n附注：带上门禁卡。';
        const serializedA = serializeSideClue(reorderedMeta, body);
        const serializedB = serializeSideClue({ ...SAMPLE_LINWAN_COMMS_META, consumedByTurn: 13 }, body);

        expect(serializedA).toBe(serializedB);

        // Verify canonical key ordering inside YAML frontmatter
        const { frontmatter } = splitSideClueFrontmatter(serializedA);
        expect(frontmatter).not.toBeNull();
        const keys = frontmatter!
            .split('\n')
            .filter((line) => /^[a-zA-Z][a-zA-Z0-9]*:/.test(line))
            .map((line) => line.split(':')[0]);
        expect(keys).toEqual([
            'id',
            'title',
            'delivery',
            'status',
            'keywords',
            'secondaryKeys',
            'scanDepth',
            'order',
            'summary',
            'sourceSessionId',
            'anchor',
            'createdAt',
            'updatedAt',
            'consumedByTurn',
        ]);

        // Round-trip preserves body containing horizontal rule `---`
        const reparsed = await parseSideClue('/side/comms/linwan.md', serializedA);
        expect(reparsed.meta).toEqual({ ...SAMPLE_LINWAN_COMMS_META, consumedByTurn: 13 });
        expect(reparsed.body).toBe(body);

        const withHash = await serializeSideClueWithHash(
            'side/comms/linwan.md',
            { ...SAMPLE_LINWAN_COMMS_META, consumedByTurn: 13 },
            body,
        );
        expect(withHash.content).toBe(serializedA);
        expect(withHash.doc.path).toBe('/side/comms/linwan.md');
        expect(withHash.doc.contentHash).toBe(reparsed.contentHash);
    });

    it('detects contentHash changes when body or metadata changes and matches sync parser', async () => {
        await initXxHash();

        const syncDoc = parseSideClueSync('/side/rumors/dock.md', SAMPLE_NEXT_TURN_BRIEF_RAW);
        const asyncDoc = await parseSideClue('/side/rumors/dock.md', SAMPLE_NEXT_TURN_BRIEF_RAW);
        expect(syncDoc).toEqual(asyncDoc);

        const updatedContent = serializeSideClue(
            { ...syncDoc.meta, updatedAt: syncDoc.meta.updatedAt + 1000 },
            `${syncDoc.body}\n新增补充：西侧警戒哨同样空虚。`,
        );
        const updatedDoc = parseSideClueSync('/side/rumors/dock.md', updatedContent);
        expect(updatedDoc.contentHash).not.toBe(syncDoc.contentHash);
    });

    it('handles CRLF line endings, UTF-8 BOM, and empty bodies cleanly', async () => {
        const crlfWithBom = `\uFEFF${SAMPLE_LINWAN_COMMS_RAW.replace(/\n/g, '\r\n')}`;
        const parsed = await parseSideClue('/side/comms/linwan.md', crlfWithBom);
        expect(parsed.meta).toEqual(SAMPLE_LINWAN_COMMS_META);
        expect(parsed.body).not.toContain('\r');

        const emptyBodySerialized = serializeSideClue(SAMPLE_LINWAN_COMMS_META, '');
        const emptyBodyParsed = parseSideClueRaw('/side/comms/linwan.md', emptyBodySerialized);
        expect(emptyBodyParsed.hasFrontmatter).toBe(true);
        expect(emptyBodyParsed.body).toBe('');
        expect(emptyBodyParsed.meta).toEqual(SAMPLE_LINWAN_COMMS_META);
    });

    it('degrades gracefully on missing frontmatter, malformed YAML, and invalid enum values', () => {
        // Plain markdown without frontmatter
        const plain = parseSideClueRaw(
            '/side/notes/warehouse.md',
            '# 仓库平面图\n\n入口在北侧铁门。',
            { anchor: '5#1', createdAt: 1000 },
        );
        expect(plain.hasFrontmatter).toBe(false);
        expect(plain.meta.id).toBe('clue_notes_warehouse');
        expect(plain.meta.title).toBe('仓库平面图');
        expect(plain.meta.delivery).toBe(DEFAULT_SIDE_CLUE_DELIVERY);
        expect(plain.meta.status).toBe(DEFAULT_SIDE_CLUE_STATUS);
        expect(plain.meta.anchor).toBe('5#1');
        expect(plain.meta.createdAt).toBe(1000);
        expect(plain.meta.updatedAt).toBe(1000);
        expect(plain.body).toBe('# 仓库平面图\n\n入口在北侧铁门。');

        // Malformed YAML frontmatter
        const malformed = parseSideClueRaw(
            '/side/notes/broken.md',
            '---\nid: [unterminated\n---\n仍然保留正文内容',
        );
        expect(malformed.hasFrontmatter).toBe(true);
        expect(malformed.meta.id).toBe('clue_notes_broken');
        expect(malformed.meta.delivery).toBe('radar_hint');
        expect(malformed.body).toBe('仍然保留正文内容');

        // Invalid enum values + duplicate/blank keywords
        const invalidEnums = parseSideClueRaw(
            '/side/notes/enums.md',
            [
                '---',
                'delivery: invalid_mode',
                'status: unknown_state',
                'keywords:',
                '  - " 码头 "',
                '  - ""',
                '  - 码头',
                '  - 灯塔',
                '---',
                'Body text',
            ].join('\n'),
        );
        expect(invalidEnums.meta.delivery).toBe('radar_hint');
        expect(invalidEnums.meta.status).toBe('dormant');
        expect(invalidEnums.meta.keywords).toEqual(['码头', '灯塔']);
        expect(invalidEnums.body).toBe('Body text');

        // Empty frontmatter block
        const emptyFm = parseSideClueRaw('/side/notes/empty-fm.md', '---\n---\n正文');
        expect(emptyFm.hasFrontmatter).toBe(true);
        expect(emptyFm.body).toBe('正文');
    });

    it('exposes accurate enum type guards', () => {
        expect(isValidSideClueDelivery('none')).toBe(true);
        expect(isValidSideClueDelivery('vfs_only')).toBe(true);
        expect(isValidSideClueDelivery('radar_hint')).toBe(true);
        expect(isValidSideClueDelivery('next_turn_brief')).toBe(true);
        expect(isValidSideClueDelivery('always')).toBe(false);

        expect(isValidSideClueStatus('dormant')).toBe(true);
        expect(isValidSideClueStatus('surfaced')).toBe(true);
        expect(isValidSideClueStatus('resolved')).toBe(true);
        expect(isValidSideClueStatus('archived')).toBe(false);
    });
});
