import { describe, expect, it } from 'vitest';
import {
    AGENTIC_DATA_KEY,
    ChatDataStore,
    DATA_NAMESPACES,
    HOT_WINDOW,
    VARIABLES_DOC_KEY,
    invalidateHeadIndex,
} from '@/core/store';
import { MemoryHostBridge } from '../../mocks';

function makeChatBridge(messageCount: number = 4): MemoryHostBridge {
    const bridge = new MemoryHostBridge();
    for (let i = 0; i < messageCount; ++i) {
        bridge.pushMessage({
            name: i % 2 === 0 ? 'User' : 'Assistant',
            isUser: i % 2 === 0,
            mes: `message ${i}`,
            swipeId: 0,
            swipes: [`message ${i}`],
            swipeInfo: [{}],
        });
    }
    return bridge;
}

describe('ChatDataStore', () => {
    it('persists writes under metadata.agentic_data and triggers saveChatDebounced', () => {
        const bridge = makeChatBridge(2);
        const store = new ChatDataStore(bridge);

        store.set(DATA_NAMESPACES.FILES, 'notes.md', 'tool', 'hello', { messageId: 1, swipeId: 0 });

        expect(bridge.saveChatCalls).toBe(1);
        const raw = bridge.metadata[AGENTIC_DATA_KEY] as {
            version: number;
            watermark: number;
            layers: Record<string, Record<string, Record<string, { source: string; content: string }>>>;
        };
        expect(raw.version).toBe(1);
        expect(raw.watermark).toBe(0);
        expect(raw.layers['1#0'][DATA_NAMESPACES.FILES]['notes.md']).toEqual({
            source: 'tool',
            content: 'hello',
        });
        expect(store.get(DATA_NAMESPACES.FILES, 'notes.md')?.content).toBe('hello');
    });

    it('isolates causal (messageId, swipeId) branches along the active swipe chain', () => {
        const bridge = makeChatBridge(3);
        bridge.chat[1].swipes = ['branch A', 'branch B'];
        bridge.chat[1].swipeInfo = [{}, {}];
        const store = new ChatDataStore(bridge);

        store.set(DATA_NAMESPACES.FILES, 'clue.md', 'tool', 'base clue', { messageId: 0, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'clue.md', 'tool', 'clue from swipe 0', { messageId: 1, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'clue.md', 'tool', 'clue from swipe 1', { messageId: 1, swipeId: 1 });
        store.set(DATA_NAMESPACES.FILES, 'only-s0.md', 'tool', 's0 only', { messageId: 1, swipeId: 0 });

        // Message 2 inherits active swipe of message 1 (swipeId = 0)
        expect(store.get(DATA_NAMESPACES.FILES, 'clue.md', { target: { messageId: 2, swipeId: 0 } })?.content).toBe(
            'clue from swipe 0',
        );
        expect(store.get(DATA_NAMESPACES.FILES, 'only-s0.md', { target: { messageId: 2, swipeId: 0 } })?.content).toBe(
            's0 only',
        );

        // Switch message 1's active swipe to 1 -> message 2 immediately inherits branch B
        bridge.chat[1].swipeId = 1;
        expect(store.get(DATA_NAMESPACES.FILES, 'clue.md', { target: { messageId: 2, swipeId: 0 } })?.content).toBe(
            'clue from swipe 1',
        );
        expect(store.get(DATA_NAMESPACES.FILES, 'only-s0.md', { target: { messageId: 2, swipeId: 0 } })).toBeNull();

        // Explicit historical swipe query still reads swipe 0 directly
        expect(store.get(DATA_NAMESPACES.FILES, 'clue.md', { target: { messageId: 1, swipeId: 0 } })?.content).toBe(
            'clue from swipe 0',
        );
        expect(store.get(DATA_NAMESPACES.FILES, 'clue.md', { target: { messageId: 0, swipeId: 0 } })?.content).toBe(
            'base clue',
        );
    });

    it('keeps HeadIndex accurate across > HOT_WINDOW messages including cold swipe changes', () => {
        invalidateHeadIndex();
        const total = HOT_WINDOW + 8;
        const bridge = makeChatBridge(total);
        bridge.chat[2].swipes = ['old0', 'old1'];
        bridge.chat[2].swipeInfo = [{}, {}];

        const store = new ChatDataStore(bridge);
        store.set(DATA_NAMESPACES.FILES, 'cold.md', 'tool', 'cold-swipe-0', { messageId: 2, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'cold.md', 'tool', 'cold-swipe-1', { messageId: 2, swipeId: 1 });
        store.set(DATA_NAMESPACES.FILES, 'hot.md', 'tool', 'hot-val', { messageId: total - 2, swipeId: 0 });

        expect(store.get(DATA_NAMESPACES.FILES, 'cold.md')?.content).toBe('cold-swipe-0');
        expect(store.get(DATA_NAMESPACES.FILES, 'hot.md')?.content).toBe('hot-val');

        // Mutating a cold message's active swipe invalidates stale HeadIndex entries cleanly
        bridge.chat[2].swipeId = 1;
        expect(store.get(DATA_NAMESPACES.FILES, 'cold.md')?.content).toBe('cold-swipe-1');
    });

    it('isolates non-layered message overrides per exact target', () => {
        const bridge = makeChatBridge(3);
        const store = new ChatDataStore(bridge);

        store.set(DATA_NAMESPACES.MESSAGE, '', 'append_output', 'override msg 1', { messageId: 1, swipeId: 0 });

        expect(store.get(DATA_NAMESPACES.MESSAGE, '', { target: { messageId: 1, swipeId: 0 } })?.content).toBe(
            'override msg 1',
        );
        expect(store.get(DATA_NAMESPACES.MESSAGE, '', { target: { messageId: 2, swipeId: 0 } })).toBeNull();
        expect(store.scan(DATA_NAMESPACES.MESSAGE)).toHaveLength(1);
    });

    it('stages pending writes and supports atomic commitStagedData and rollbackStagedData', () => {
        const bridge = makeChatBridge(2);
        const store = new ChatDataStore(bridge);
        const target = { messageId: 1, swipeId: 0 };

        store.set(DATA_NAMESPACES.FILES, 'committed.md', 'init', 'v1', { messageId: 0, swipeId: 0 });
        const savesBeforeStage = bridge.saveChatCalls;

        store.stageSet(DATA_NAMESPACES.FILES, 'staged.md', 'tool', 'draft', target);
        store.stageDelete(DATA_NAMESPACES.FILES, 'committed.md', 'tool', target);

        expect(bridge.saveChatCalls).toBe(savesBeforeStage);
        expect(store.hasPending(target)).toBe(true);
        expect(store.get(DATA_NAMESPACES.FILES, 'staged.md', { target })).toBeNull();
        expect(store.get(DATA_NAMESPACES.FILES, 'committed.md', { target })?.content).toBe('v1');

        expect(store.getPending(DATA_NAMESPACES.FILES, 'staged.md', { target })?.content).toBe('draft');
        expect(store.getPending(DATA_NAMESPACES.FILES, 'committed.md', { target })).toBeNull();
        expect(
            store.getPending(DATA_NAMESPACES.FILES, 'committed.md', { target, includeDeleted: true })?.deleted,
        ).toBe(true);

        // Rollback discards staged writes and restores committed visibility
        const rolledBack = store.rollbackStagedData(target);
        expect(rolledBack).toBe(2);
        expect(store.hasPending(target)).toBe(false);
        expect(store.getPending(DATA_NAMESPACES.FILES, 'staged.md', { target })).toBeNull();
        expect(store.getPending(DATA_NAMESPACES.FILES, 'committed.md', { target })?.content).toBe('v1');

        // Re-stage and commit atomically
        store.stageSet(DATA_NAMESPACES.FILES, 'final.md', 'tool', 'committed-draft', target);
        store.stageSet(DATA_NAMESPACES.WORLDINFO, 'world/5', 'tool', 'updated lore'); // unbound pre-message
        const committedCount = store.commitStagedData(target);

        expect(committedCount).toBe(2);
        expect(store.hasPending(target)).toBe(false);
        expect(store.get(DATA_NAMESPACES.FILES, 'final.md', { target })?.content).toBe('committed-draft');
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'world/5', { target })?.content).toBe('updated lore');
    });

    it('supports deletion tombstones vs physical remove, and pruneFromMessage', () => {
        const bridge = makeChatBridge(4);
        const store = new ChatDataStore(bridge);

        store.set(DATA_NAMESPACES.FILES, 'a.md', 's', 'v0', { messageId: 0, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'a.md', 's', 'v1', { messageId: 1, swipeId: 0 });
        store.erase(DATA_NAMESPACES.FILES, 'a.md', 'del', { messageId: 2, swipeId: 0 });
        store.set(DATA_NAMESPACES.FILES, 'b.md', 's', 'future', { messageId: 3, swipeId: 0 });

        // Tombstone at message 2 masks message 1 and message 0
        expect(store.get(DATA_NAMESPACES.FILES, 'a.md', { target: { messageId: 2, swipeId: 0 } })).toBeNull();
        expect(
            store.get(DATA_NAMESPACES.FILES, 'a.md', { target: { messageId: 2, swipeId: 0 }, includeDeleted: true })
                ?.deleted,
        ).toBe(true);
        // Message 1 still intact
        expect(store.get(DATA_NAMESPACES.FILES, 'a.md', { target: { messageId: 1, swipeId: 0 } })?.content).toBe('v1');

        // Physical remove at message 1 lets message 0 resurface at message 1
        expect(store.remove(DATA_NAMESPACES.FILES, 'a.md', { messageId: 1, swipeId: 0 })).toBe(true);
        expect(store.get(DATA_NAMESPACES.FILES, 'a.md', { target: { messageId: 1, swipeId: 0 } })?.content).toBe('v0');

        // pruneFromMessage(2) removes layers at message 2 and message 3 (including staged)
        store.stageSet(DATA_NAMESPACES.FILES, 'staged3.md', 'tool', 'x', { messageId: 3, swipeId: 0 });
        const pruned = store.pruneFromMessage(2);
        expect(pruned).toBe(3);
        expect(store.get(DATA_NAMESPACES.FILES, 'a.md', { target: { messageId: 2, swipeId: 0 } })?.content).toBe('v0');
        expect(store.get(DATA_NAMESPACES.FILES, 'b.md', { target: { messageId: 3, swipeId: 0 } })).toBeNull();
        expect(store.hasPending({ messageId: 3, swipeId: 0 })).toBe(false);
    });

    it('reads legacy cg_data, wi_overrides, mes_override, cg_state, and message.variables in read-only fallback', () => {
        const bridge = new MemoryHostBridge({
            metadata: {
                cg_state: {
                    version: 1,
                    watermark: 1,
                    base: {
                        files: {
                            'legacy-base.md': { source: 'compacted', content: 'from-cg-state' },
                        },
                    },
                },
                variables: { globalCoin: 50 },
            },
            chat: [
                {
                    id: 0,
                    name: 'Assistant',
                    isUser: false,
                    mes: 'msg 0',
                    swipeId: 0,
                    variables: [{ hp: 100, location: '灰港' }],
                    swipeInfo: [
                        {
                            cg_data: {
                                files: {
                                    'cg.md': { source: 'legacy-cg', content: 'from-cg-data' },
                                },
                            },
                            wi_overrides: {
                                'World/A': {
                                    '12': { type: '@@replace', content: 'legacy wi override' },
                                },
                            },
                            mes_override: 'legacy display override',
                        },
                    ],
                },
                {
                    id: 1,
                    name: 'Assistant',
                    isUser: false,
                    mes: 'msg 1',
                    swipeId: 0,
                    variables: [{}], // empty placeholder must not clobber message 0 variables
                    swipeInfo: [{}],
                },
            ],
        });

        const store = new ChatDataStore(bridge);

        expect(store.get(DATA_NAMESPACES.FILES, 'legacy-base.md')?.content).toBe('from-cg-state');
        expect(store.get(DATA_NAMESPACES.FILES, 'cg.md')?.content).toBe('from-cg-data');
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'World/A/12')?.content).toBe('legacy wi override');
        expect(store.get(DATA_NAMESPACES.MESSAGE, '', { target: { messageId: 0, swipeId: 0 } })?.content).toBe(
            'legacy display override',
        );
        expect(store.get(DATA_NAMESPACES.MESSAGE, '', { target: { messageId: 1, swipeId: 0 } })).toBeNull();

        const varsEntry = store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY);
        expect(varsEntry?.source).toBe('legacy-variables');
        expect(JSON.parse(varsEntry!.content)).toEqual({ hp: 100, location: '灰港' });
        expect(store.get(DATA_NAMESPACES.VARIABLES, 'hp')?.content).toBe('100');

        // New agentic_data layer overrides legacy without mutating legacy structures
        store.set(DATA_NAMESPACES.WORLDINFO, 'World/A/12', 'agentic', 'new override', { messageId: 1, swipeId: 0 });
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'World/A/12')?.content).toBe('new override');
        expect(bridge.chat[0].swipeInfo?.[0].wi_overrides?.['World/A']?.['12']?.content).toBe('legacy wi override');
    });
});
