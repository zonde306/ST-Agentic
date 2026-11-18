import { describe, expect, it } from 'vitest';
import { TrajectoryStore } from '@/core/context';
import { type CanonicalMessage, toBranchKey } from '@/core/types';
import { MemoryHostBridge } from '../../mocks';

describe('TrajectoryStore', () => {
    it('maintains per-agent immutable append-only message history and Read-Set isolation', () => {
        const store = new TrajectoryStore();
        const rawUserMsg: CanonicalMessage = { role: 'user', content: '前往灰港码头。' };
        const rawAssistantMsg: CanonicalMessage = {
            role: 'assistant',
            content: '海雾弥漫在码头上。',
            toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"/lorebooks/a.md"}' }],
        };

        store.appendTurn([rawUserMsg, rawAssistantMsg], 'main');
        store.markRead('/lorebooks/a.md', 'hash-a1', 'main');

        // Mutating original input object must NOT mutate stored Layer 1 message
        rawUserMsg.content = '被外部篡改';
        rawAssistantMsg.toolCalls![0].arguments = '{"path":"/hacked.md"}';

        const mainMsgs = store.getMessages('main');
        expect(mainMsgs).toHaveLength(2);
        expect(mainMsgs[0].content).toBe('前往灰港码头。');
        expect(mainMsgs[1].toolCalls?.[0].arguments).toBe('{"path":"/lorebooks/a.md"}');

        // Stored messages are deeply frozen
        expect(Object.isFrozen(mainMsgs[0])).toBe(true);
        expect(Object.isFrozen(mainMsgs[1].toolCalls?.[0])).toBe(true);
        expect(() => {
            (mainMsgs[0] as { content: string }).content = 'mutate';
        }).toThrow();

        // Separate persistent agent keeps independent messages and Read-Set
        store.appendTurn([{ role: 'user', content: '记录本轮摘要' }], 'chronicler');
        store.markRead('/memory/summary.md', 'hash-sum', 'chronicler');

        expect(store.getMessages('main')).toHaveLength(2);
        expect(store.getMessages('chronicler')).toHaveLength(1);
        expect(store.getReadSet('main').has('/memory/summary.md')).toBe(false);
        expect(store.getReadSet('chronicler').has('/lorebooks/a.md')).toBe(false);
        expect(store.listAgentIds()).toEqual(['chronicler', 'main']);
    });

    it('supports non-destructive swipe rollback, sibling swipe switching, and common prefix preservation', () => {
        const store = new TrajectoryStore();

        // Message 0 (user) -> Message 1 (assistant swipe 0)
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 1 user' },
                { role: 'assistant', content: 'Turn 1 reply (s0)' },
            ],
            'main',
        );
        store.markRead('/lorebooks/core.md', 'h-core', 'main');
        const cp1 = store.recordCheckpoint({ messageId: 1, swipeId: 0 }, 'main');
        expect(cp1.messageCount).toBe(2);
        expect(cp1.readSetSnapshot.get('/lorebooks/core.md')).toBe('h-core');
        expect(cp1.archivedUpToChunk).toBe(0);

        // Message 2 (user) -> Message 3 (assistant swipe 0)
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 2 user' },
                { role: 'assistant', content: 'Turn 2 reply (s0)' },
            ],
            'main',
        );
        store.markRead('/lorebooks/branch0.md', 'h-b0', 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 0 }, 'main');
        expect(store.getMessageCount('main')).toBe(4);

        const prefixRefBeforeSwipe = store.getMessages('main')[0];

        // Swipe on message 3 -> roll back to checkpoint before message 3 (i.e. message 1 swipe 0)
        expect(store.restoreBeforeMessage(3, 'main')).toBe(true);
        expect(store.getMessageCount('main')).toBe(2);
        expect(store.getMessages('main')[0]).toBe(prefixRefBeforeSwipe);
        expect(store.getReadSet('main').has('/lorebooks/branch0.md')).toBe(false);
        expect(store.getReadSet('main').get('/lorebooks/core.md')).toBe('h-core');

        // Generate swipe 1 for message 3
        store.appendTurn(
            [
                { role: 'user', content: 'Turn 2 user' },
                { role: 'assistant', content: 'Turn 2 reply (s1)' },
            ],
            'main',
        );
        store.markRead('/lorebooks/branch1.md', 'h-b1', 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 1 }, 'main');
        expect(store.getMessages('main')[3].content).toBe('Turn 2 reply (s1)');

        // Non-destructive: switching back to 3#0 restores exact 3#0 history and Read-Set
        expect(store.restoreBranch({ messageId: 3, swipeId: 0 }, 'main')).toBe(true);
        expect(store.getMessages('main')[3].content).toBe('Turn 2 reply (s0)');
        expect(store.getReadSet('main').has('/lorebooks/branch0.md')).toBe(true);
        expect(store.getReadSet('main').has('/lorebooks/branch1.md')).toBe(false);

        // Switching back to 3#1 also works
        expect(store.restoreBranch({ messageId: 3, swipeId: 1 }, 'main')).toBe(true);
        expect(store.getMessages('main')[3].content).toBe('Turn 2 reply (s1)');
        expect(store.getReadSet('main').has('/lorebooks/branch1.md')).toBe(true);

        // Restoring unknown branch returns false without mutating active trajectory
        expect(store.restoreBranch({ messageId: 99, swipeId: 0 }, 'main')).toBe(false);
        expect(store.getMessageCount('main')).toBe(4);
    });

    it('prunes checkpoints and restores prior state on regenerate/delete (pruneFromMessage & pruneSwipe)', () => {
        const store = new TrajectoryStore();

        store.appendTurn([{ role: 'user', content: 'M0' }, { role: 'assistant', content: 'M1' }], 'main');
        store.recordCheckpoint({ messageId: 1, swipeId: 0 }, 'main');

        store.appendTurn([{ role: 'user', content: 'M2' }, { role: 'assistant', content: 'M3-s0' }], 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 0 }, 'main');

        store.restoreBranch({ messageId: 1, swipeId: 0 }, 'main');
        store.appendTurn([{ role: 'user', content: 'M2' }, { role: 'assistant', content: 'M3-s1' }], 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 1 }, 'main');

        store.appendTurn([{ role: 'user', content: 'M4' }], 'chronicler');
        store.recordCheckpoint({ messageId: 4, swipeId: 0 }, 'chronicler');

        // Prune single swipe 3#0
        expect(store.pruneSwipe({ messageId: 3, swipeId: 0 }, 'main')).toBe(1);
        expect(store.getCheckpoint({ messageId: 3, swipeId: 0 }, 'main')).toBeUndefined();
        expect(store.getCheckpoint({ messageId: 3, swipeId: 1 }, 'main')).toBeDefined();

        // Prune all threads from messageId 3 onwards (regenerate/delete)
        const removed = store.pruneFromMessage(3);
        expect(removed).toBe(2); // 3#1 in main + 4#0 in chronicler
        expect(store.getMessageCount('main')).toBe(2);
        expect(store.getMessages('main')[1].content).toBe('M1');
        expect(store.getMessageCount('chronicler')).toBe(0);
        expect(store.listCheckpoints('main').has(toBranchKey({ messageId: 1, swipeId: 0 }))).toBe(true);
    });

    it('serializes and persists via HostBridge metadata with deduplicated pool across swipes', () => {
        const bridge = new MemoryHostBridge();
        const store = new TrajectoryStore();

        store.setFrozenPrefix(
            {
                tools: [{ name: 'read_file', description: 'Read file', parameters: { type: 'object' } }],
                messages: [{ role: 'system', content: 'Static base' }],
                layer0EndIndex: 0,
            },
            'main',
        );
        store.appendTurn([{ role: 'user', content: 'Shared user' }, { role: 'assistant', content: 'Swipe 0' }], 'main');
        store.markRead('/lorebooks/x.md', 'hash-x', 'main');
        store.recordCheckpoint({ messageId: 1, swipeId: 0 }, 'main');

        store.restoreBeforeMessage(1, 'main');
        store.appendTurn([{ role: 'user', content: 'Shared user' }, { role: 'assistant', content: 'Swipe 1' }], 'main');
        store.markRead('/lorebooks/y.md', 'hash-y', 'main');
        store.recordCheckpoint({ messageId: 1, swipeId: 1 }, 'main');

        const serialized = store.serialize();
        // 'Shared user' is interned once in the pool
        expect(serialized.threads.main.messagePool).toHaveLength(3);

        store.saveToHost(bridge);
        expect(bridge.saveChatCalls).toBe(1);

        const reloaded = TrajectoryStore.loadFromHost(bridge);
        expect(reloaded.getFrozenPrefix('main')?.messages[0].content).toBe('Static base');
        expect(reloaded.getMessages('main')[1].content).toBe('Swipe 1');
        expect(reloaded.getReadSet('main').get('/lorebooks/y.md')).toBe('hash-y');

        // Switching back to Swipe 0 works seamlessly after reload
        expect(reloaded.restoreBranch({ messageId: 1, swipeId: 0 }, 'main')).toBe(true);
        expect(reloaded.getMessages('main')[1].content).toBe('Swipe 0');
        expect(reloaded.getReadSet('main').get('/lorebooks/x.md')).toBe('hash-x');
    });
});
