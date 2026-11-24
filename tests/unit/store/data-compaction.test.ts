import { describe, expect, it } from 'vitest';
import {
    AGENTIC_DATA_KEY,
    ChatDataStore,
    DATA_NAMESPACES,
    DataCompactor,
    VARIABLES_DOC_KEY,
    compactColdLayers,
} from '@/core/store';
import { MemoryHostBridge } from '../../mocks';

function buildMultiTurnChat(length: number): MemoryHostBridge {
    const bridge = new MemoryHostBridge();
    for (let i = 0; i < length; ++i) {
        bridge.pushMessage({
            name: i % 2 === 0 ? 'User' : 'Assistant',
            isUser: i % 2 === 0,
            mes: `turn ${i}`,
            swipeId: 0,
            swipes: [`turn ${i} s0`, `turn ${i} s1`],
            swipeInfo: [{}, {}],
        });
    }
    return bridge;
}

describe('DataCompactor', () => {
    it('supports dryRun estimation without mutating metadata or saving', () => {
        const bridge = buildMultiTurnChat(10);
        const store = new ChatDataStore(bridge);

        for (let i = 0; i < 6; ++i) {
            store.set(DATA_NAMESPACES.FILES, 'log.md', 'turn', 'x'.repeat(200) + `-${i}`, {
                messageId: i,
                swipeId: 0,
            });
            store.set(DATA_NAMESPACES.FILES, 'log.md', 'turn', 'alt'.repeat(50), {
                messageId: i,
                swipeId: 1,
            });
        }

        const savesBefore = bridge.saveChatCalls;
        const beforeSnapshot = structuredClone(bridge.metadata[AGENTIC_DATA_KEY]);

        const compactor = new DataCompactor(bridge);
        const report = compactor.compactColdLayers({ dryRun: true, keepDepth: 4 });

        expect(report.dryRun).toBe(true);
        expect(report.previousWatermark).toBe(0);
        expect(report.newWatermark).toBe(6);
        expect(report.compactedMessages).toBe(6);
        expect(report.removedLayers).toBe(12);
        expect(report.flattenedEntries).toBe(1);
        expect(report.estimatedBytesBefore).toBeGreaterThan(report.estimatedBytesAfter);
        expect(report.freedBytes).toBe(report.estimatedBytesBefore - report.estimatedBytesAfter);

        // Zero mutation during dryRun
        expect(bridge.saveChatCalls).toBe(savesBefore);
        expect(bridge.metadata[AGENTIC_DATA_KEY]).toEqual(beforeSnapshot);
    });

    it('losslessly flattens cold layers, preserves tombstones, hot window swipes, and message overrides', () => {
        const bridge = buildMultiTurnChat(12);
        bridge.chat[1].swipeId = 1; // cold active swipe is 1
        const store = new ChatDataStore(bridge);

        // Cold region [0..8) when keepDepth = 4
        store.set(DATA_NAMESPACES.FILES, 'keep.md', 's', 'initial', { messageId: 0, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'branch.md', 's', 'from-swipe-0', { messageId: 1, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'branch.md', 's', 'from-swipe-1', { messageId: 1, swipeId: 1 });
        store.set(DATA_NAMESPACES.FILES, 'deleted.md', 's', 'soon-gone', { messageId: 2, swipeId: 0 });
        store.erase(DATA_NAMESPACES.FILES, 'deleted.md', 'del', { messageId: 4, swipeId: 0 });
        store.set(DATA_NAMESPACES.WORLDINFO, 'world/7', 'wi', 'cold-wi-override', { messageId: 5, swipeId: 0 });
        store.set(DATA_NAMESPACES.MESSAGE, '', 'view', 'cold msg display', { messageId: 3, swipeId: 0 });

        // Hot window [8..12)
        store.set(DATA_NAMESPACES.FILES, 'hot.md', 's', 'hot-s0', { messageId: 9, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'hot.md', 's', 'hot-s1', { messageId: 9, swipeId: 1 });

        const report = compactColdLayers(bridge, { keepDepth: 4 });
        expect(report.dryRun).toBe(false);
        expect(report.newWatermark).toBe(8);
        expect(report.freedBytes).toBeGreaterThan(0);

        // Lossless equivalence at active tip
        expect(store.get(DATA_NAMESPACES.FILES, 'keep.md')?.content).toBe('initial');
        expect(store.get(DATA_NAMESPACES.FILES, 'branch.md')?.content).toBe('from-swipe-1');
        expect(store.get(DATA_NAMESPACES.FILES, 'deleted.md')).toBeNull();
        expect(store.get(DATA_NAMESPACES.FILES, 'deleted.md', { includeDeleted: true })?.deleted).toBe(true);
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'world/7')?.content).toBe('cold-wi-override');

        // Non-layered message display override in cold message remains intact
        expect(store.get(DATA_NAMESPACES.MESSAGE, '', { target: { messageId: 3, swipeId: 0 } })?.content).toBe(
            'cold msg display',
        );

        // Hot window swipe branches remain isolated and switchable
        expect(store.get(DATA_NAMESPACES.FILES, 'hot.md', { target: { messageId: 9, swipeId: 0 } })?.content).toBe(
            'hot-s0',
        );
        expect(store.get(DATA_NAMESPACES.FILES, 'hot.md', { target: { messageId: 9, swipeId: 1 } })?.content).toBe(
            'hot-s1',
        );

        // Idempotent second run
        const second = compactColdLayers(bridge, { keepDepth: 4 });
        expect(second.compactedMessages).toBe(0);
        expect(second.removedLayers).toBe(0);
        expect(second.flattenedEntries).toBe(0);
    });

    it('absorbs legacy cold entries and preserves tombstones across incremental compactions', () => {
        const bridge = buildMultiTurnChat(10);
        bridge.chat[0].swipeInfo = [
            {
                wi_overrides: {
                    LegacyBook: { '9': { type: 'legacy', content: 'legacy-wi-text' } },
                },
            },
        ];
        bridge.chat[1].variables = [{ hp: 88 }];

        const store = new ChatDataStore(bridge);
        // Erase legacy WI override at message 2
        store.erase(DATA_NAMESPACES.WORLDINFO, 'LegacyBook/9', 'del', { messageId: 2, swipeId: 0 });

        const first = compactColdLayers(bridge, { keepDepth: 6 }); // coldEnd = 4
        expect(first.newWatermark).toBe(4);
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'LegacyBook/9')).toBeNull();
        expect(JSON.parse(store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY)!.content)).toEqual({ hp: 88 });

        // Grow chat and run second incremental compaction (coldEnd = 8)
        for (let i = 10; i < 14; ++i) {
            bridge.pushMessage({ name: 'User', isUser: true, mes: `m${i}` });
        }
        const second = compactColdLayers(bridge, { keepDepth: 6 });
        expect(second.previousWatermark).toBe(4);
        expect(second.newWatermark).toBe(8);

        // Tombstone from message 2 MUST still mask legacy wi_overrides at message 0
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'LegacyBook/9')).toBeNull();
        expect(JSON.parse(store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY)!.content)).toEqual({ hp: 88 });
    });

    it('auto-prunes cold /scratch/** drafts while preserving hot /scratch/**, /workspace/shared/**, /workspace/docs/**, and /workspace/AGENTS.md', () => {
        const bridge = buildMultiTurnChat(16);
        const store = new ChatDataStore(bridge);

        // Cold scratch files (messages 1 & 2, coldEnd = 12 when keepDepth = 4)
        store.set(DATA_NAMESPACES.FILES, 'scratch/old-draft.md', 'agent:main', 'old scratch 1', {
            messageId: 1,
            swipeId: 0,
        });
        store.set(DATA_NAMESPACES.FILES, 'scratch/reused.md', 'agent:main', 'old version', {
            messageId: 2,
            swipeId: 0,
        });
        // Hot scratch file (touched at message 14 >= 12)
        store.set(DATA_NAMESPACES.FILES, 'scratch/reused.md', 'agent:main', 'hot version', {
            messageId: 14,
            swipeId: 0,
        });
        store.set(DATA_NAMESPACES.FILES, 'scratch/hot-only.md', 'agent:main', 'active draft', {
            messageId: 15,
            swipeId: 0,
        });

        // Non-scratch workspace files & base specs must survive compaction
        store.setBase(DATA_NAMESPACES.FILES, 'workspace/AGENTS.md', 'ui-edit', '# Core Index');
        store.setBase(DATA_NAMESPACES.FILES, 'workspace/docs/style.md', 'assistant', '# Style Guide');
        store.set(DATA_NAMESPACES.FILES, 'workspace/shared/handoff.md', 'agent:main', 'shared cold note', {
            messageId: 3,
            swipeId: 0,
        });
        store.set(DATA_NAMESPACES.FILES, 'memory/outline.md', 'agent:main', 'chapter outline', {
            messageId: 4,
            swipeId: 0,
        });

        const report = compactColdLayers(bridge, { keepDepth: 4 });
        expect(report.prunedScratchFiles).toBe(1);

        // Cold scratch draft was removed completely
        expect(store.get(DATA_NAMESPACES.FILES, 'scratch/old-draft.md', { includeDeleted: true })).toBeNull();
        // Hot scratch drafts stay intact
        expect(store.get(DATA_NAMESPACES.FILES, 'scratch/reused.md')?.content).toBe('hot version');
        expect(store.get(DATA_NAMESPACES.FILES, 'scratch/hot-only.md')?.content).toBe('active draft');
        // Specs, shared workspace, and memory survive cold compaction
        expect(store.get(DATA_NAMESPACES.FILES, 'workspace/AGENTS.md')?.content).toBe('# Core Index');
        expect(store.get(DATA_NAMESPACES.FILES, 'workspace/docs/style.md')?.content).toBe('# Style Guide');
        expect(store.get(DATA_NAMESPACES.FILES, 'workspace/shared/handoff.md')?.content).toBe('shared cold note');
        expect(store.get(DATA_NAMESPACES.FILES, 'memory/outline.md')?.content).toBe('chapter outline');
    });
});
