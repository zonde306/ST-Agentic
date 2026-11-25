import { describe, expect, it } from 'vitest';
import {
    AGENTIC_DATA_KEY,
    CHAT_VARIABLES_DOC_KEY,
    ChatDataStore,
    DATA_NAMESPACES,
    GLOBAL_VARIABLES_DOC_KEY,
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
        expect(varsEntry?.source).toBe('st-message');
        expect(JSON.parse(varsEntry!.content)).toEqual({ hp: 100, location: '灰港' });
        expect(store.get(DATA_NAMESPACES.VARIABLES, 'hp')?.content).toBe('100');

        // New agentic_data layer overrides legacy without mutating legacy structures
        store.set(DATA_NAMESPACES.WORLDINFO, 'World/A/12', 'agentic', 'new override', { messageId: 1, swipeId: 0 });
        expect(store.get(DATA_NAMESPACES.WORLDINFO, 'World/A/12')?.content).toBe('new override');
        expect(bridge.chat[0].swipeInfo?.[0].wi_overrides?.['World/A']?.['12']?.content).toBe('legacy wi override');
    });

    it('snapshots merged staged buckets deeply and restores them atomically for checkpoint recovery', () => {
        const bridge = makeChatBridge(3);
        const store = new ChatDataStore(bridge);
        const target1 = { messageId: 1, swipeId: 0 };
        const target2 = { messageId: 2, swipeId: 0 };

        expect(store.snapshotStagedData(target1)).toEqual({});
        expect(() => store.snapshotStagedData({ messageId: -1, swipeId: 0 })).toThrow(/Invalid MessageTarget/);

        // Stage unbound pre-message entries + target1 entries (target1 overrides unbound on collision)
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/unbound.md', 'before', 'from-unbound');
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/shared.md', 'before', 'unbound-version');
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/shared.md', 'tool', 'target-version', target1);
        store.stageSet(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, 'vars', '{"hp":80}', target1);
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/other.md', 'tool', 'keep-other-target', target2);

        const snapshot = store.snapshotStagedData(target1);
        expect(snapshot).toEqual({
            files: {
                'memory/unbound.md': { source: 'before', content: 'from-unbound' },
                'memory/shared.md': { source: 'tool', content: 'target-version' },
            },
            variables: {
                [VARIABLES_DOC_KEY]: { source: 'vars', content: '{"hp":80}' },
            },
        });

        // Mutating snapshot or staging further writes does not corrupt the captured snapshot
        snapshot.files['memory/shared.md'].content = 'mutated-by-caller';
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/later.md', 'tool', 'after-snapshot', target1);
        expect(store.snapshotStagedData(target1).files['memory/shared.md'].content).toBe('target-version');

        // Roll back target1 + simulate fresh store restore from checkpoint snapshot
        store.rollbackStagedData(target1);
        store.rollbackStagedData(); // clear unbound
        expect(store.hasPending(target1)).toBe(false);

        store.restoreStagedData(target1, {
            files: {
                'memory/unbound.md': { source: 'before', content: 'from-unbound' },
                'memory/shared.md': { source: 'tool', content: 'target-version' },
            },
            variables: {
                [VARIABLES_DOC_KEY]: { source: 'vars', content: '{"hp":80}' },
            },
        });

        expect(store.hasPending(target1)).toBe(true);
        expect(store.getPending(DATA_NAMESPACES.FILES, 'memory/unbound.md', { target: target1 })?.content).toBe(
            'from-unbound',
        );
        expect(store.getPending(DATA_NAMESPACES.FILES, 'memory/shared.md', { target: target1 })?.content).toBe(
            'target-version',
        );
        expect(store.getPending(DATA_NAMESPACES.FILES, 'memory/later.md', { target: target1 })).toBeNull();
        // Other branch staging untouched
        expect(store.getPending(DATA_NAMESPACES.FILES, 'memory/other.md', { target: target2 })?.content).toBe(
            'keep-other-target',
        );

        const committed = store.commitStagedData(target1);
        expect(committed).toBe(3);
        expect(store.get(DATA_NAMESPACES.FILES, 'memory/unbound.md', { target: target1 })?.content).toBe(
            'from-unbound',
        );
        expect(store.get(DATA_NAMESPACES.FILES, 'memory/shared.md', { target: target1 })?.content).toBe(
            'target-version',
        );
        expect(store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, { target: target1 })?.content).toBe(
            JSON.stringify({ hp: 80 }, null, 2),
        );
        expect(bridge.chat[1].variables?.[0]).toEqual({ hp: 80 });

        // Restoring empty snapshot clears target staged data cleanly
        store.stageSet(DATA_NAMESPACES.FILES, 'memory/stale.md', 'tool', 'x', target1);
        store.restoreStagedData(target1, {});
        expect(store.hasPending(target1)).toBe(false);
    });

    it('uses ST native storage as Single Source of Truth for message/chat/global variables without stale shadow copies', () => {
        invalidateHeadIndex();
        const total = HOT_WINDOW + 4;
        const bridge = makeChatBridge(total);
        const store = new ChatDataStore(bridge);

        // 1. Writing message variables lands directly in chat[msgId].variables[swipeId] with zero agentic_data shadow
        store.set(
            DATA_NAMESPACES.VARIABLES,
            VARIABLES_DOC_KEY,
            'tool',
            JSON.stringify({ hp: 90, mood: 'calm' }),
            { messageId: 1, swipeId: 0 },
        );
        expect(bridge.chat[1].variables?.[0]).toEqual({ hp: 90, mood: 'calm' });
        const rawPersisted = bridge.metadata[AGENTIC_DATA_KEY] as
            | { layers?: Record<string, Record<string, unknown>> }
            | undefined;
        expect(rawPersisted?.layers?.['1#0']?.[DATA_NAMESPACES.VARIABLES]).toBeUndefined();

        // 2. External mutation (e.g. JS-Slash-Runner / MVU) even on cold messages (> HOT_WINDOW) is immediately visible
        bridge.chat[1].variables![0] = { hp: 42, mood: 'injured', fromExternal: true };
        const tipEntry = store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY);
        expect(tipEntry?.source).toBe('st-message');
        expect(JSON.parse(tipEntry!.content)).toEqual({ hp: 42, mood: 'injured', fromExternal: true });

        // 3. Staged 3-scope writes do not mutate ST native storage until commitStagedData; rollback leaves native intact
        const target = { messageId: total - 1, swipeId: 0 };
        store.stageSet(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, 'tool', JSON.stringify({ hp: 10 }), target);
        store.stageSet(DATA_NAMESPACES.VARIABLES, CHAT_VARIABLES_DOC_KEY, 'tool', JSON.stringify({ chapter: 2 }), target);
        store.stageSet(DATA_NAMESPACES.VARIABLES, GLOBAL_VARIABLES_DOC_KEY, 'tool', JSON.stringify({ theme: 'noir' }), target);
        expect(bridge.readChatVariables()).toEqual({});
        expect(bridge.readGlobalVariables()).toEqual({});

        store.rollbackStagedData(target);
        expect(bridge.readChatVariables()).toEqual({});
        expect(bridge.readGlobalVariables()).toEqual({});

        // Re-stage & commit atomically into ST native storage
        store.stageSet(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, 'tool', JSON.stringify({ hp: 15 }), target);
        store.stageSet(DATA_NAMESPACES.VARIABLES, CHAT_VARIABLES_DOC_KEY, 'tool', JSON.stringify({ chapter: 3 }), target);
        store.stageSet(DATA_NAMESPACES.VARIABLES, GLOBAL_VARIABLES_DOC_KEY, 'tool', JSON.stringify({ runs: 7 }), target);
        expect(store.commitStagedData(target)).toBe(3);

        expect(bridge.chat[target.messageId].variables?.[0]).toEqual({ hp: 15 });
        expect(bridge.metadata.variables).toEqual({ chapter: 3 });
        expect(bridge.metadata.globalVariables).toEqual({ runs: 7 });

        // 4. Unmigrated legacy agentic_data variables still work as read fallback when native slot is absent
        bridge.metadata[AGENTIC_DATA_KEY] = {
            version: 1,
            watermark: 0,
            base: {},
            layers: {
                '2#0': {
                    variables: {
                        [VARIABLES_DOC_KEY]: { source: 'legacy-agentic', content: '{"legacyFlag":true}' },
                    },
                },
            },
        };
        const legacyFallback = store.get(DATA_NAMESPACES.VARIABLES, VARIABLES_DOC_KEY, {
            target: { messageId: 2, swipeId: 0 },
        });
        expect(legacyFallback?.source).toBe('legacy-agentic');
        expect(JSON.parse(legacyFallback!.content)).toEqual({ legacyFlag: true });
    });
});
