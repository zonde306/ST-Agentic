import { describe, expect, it } from 'vitest';
import { type InterruptedTurnCheckpoint, TrajectoryStore } from '@/core/context';
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

    it('persists, clones, round-trips, and replaces InterruptedTurnCheckpoints cleanly', () => {
        const bridge = new MemoryHostBridge();
        const store = new TrajectoryStore();

        expect(() => {
            store.saveInterruptedCheckpoint({
                agentId: 'main',
                target: { messageId: -1, swipeId: 0 },
                reason: 'user_stop',
                completedTurnMessages: [],
                readSetSnapshot: {},
                stagedSnapshot: {},
                createdAt: 1000,
            });
        }).toThrow(/Invalid MessageTarget/);

        const inputCheckpoint: InterruptedTurnCheckpoint = {
            agentId: 'main',
            target: { messageId: 5, swipeId: 1 },
            reason: 'length',
            errorMessage: 'max_tokens reached',
            completedTurnMessages: [
                { role: 'user', content: 'Continue story' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/lorebooks/a.md"}' }],
                },
                { role: 'tool', toolCallId: 'tc_1', toolName: 'read_file', content: 'Lore text' },
            ],
            readSetSnapshot: { '/lorebooks/a.md': 'hash-a' },
            stagedSnapshot: {
                variables: {
                    'variables.json': { source: 'main', content: '{"hp":9}' },
                },
            },
            createdAt: 123456,
        };

        store.saveInterruptedCheckpoint(inputCheckpoint);

        // Mutating original input object must not mutate stored checkpoint
        inputCheckpoint.completedTurnMessages.push({ role: 'user', content: 'hacked' });
        inputCheckpoint.readSetSnapshot['/lorebooks/a.md'] = 'tampered';
        inputCheckpoint.stagedSnapshot.variables['variables.json'].content = 'tampered';

        const loaded = store.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 });
        expect(loaded).toBeDefined();
        expect(loaded?.reason).toBe('length');
        expect(loaded?.errorMessage).toBe('max_tokens reached');
        expect(loaded?.completedTurnMessages).toHaveLength(3);
        expect(loaded?.readSetSnapshot).toEqual({ '/lorebooks/a.md': 'hash-a' });
        expect(loaded?.stagedSnapshot.variables['variables.json'].content).toBe('{"hp":9}');

        // Mutating returned defensive clone must not mutate stored checkpoint
        loaded!.readSetSnapshot['/lorebooks/a.md'] = 'mutated-clone';
        loaded!.completedTurnMessages.pop();
        expect(store.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 })?.completedTurnMessages).toHaveLength(3);
        expect(store.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 })?.readSetSnapshot['/lorebooks/a.md']).toBe('hash-a');

        const listed = store.listInterruptedCheckpoints();
        expect(listed.size).toBe(1);
        expect(listed.has(toBranchKey({ messageId: 5, swipeId: 1 }))).toBe(true);

        // Serialize/deserialize round-trip (via HostBridge too)
        store.appendTurn([{ role: 'user', content: 'Prev turn' }, { role: 'assistant', content: 'Prev reply' }], 'main');
        store.recordCheckpoint({ messageId: 3, swipeId: 0 }, 'main');
        store.setFrozenPrefix(
            {
                tools: [{ name: 'write_file', description: 'Write', parameters: { type: 'object' } }],
                messages: [{ role: 'system', content: 'Base' }],
                layer0EndIndex: 0,
            },
            'main',
        );
        store.saveToHost(bridge);

        const reloaded = TrajectoryStore.loadFromHost(bridge);
        const reloadedCp = reloaded.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 });
        expect(reloadedCp).toEqual({
            agentId: 'main',
            target: { messageId: 5, swipeId: 1 },
            reason: 'length',
            errorMessage: 'max_tokens reached',
            completedTurnMessages: [
                { role: 'user', content: 'Continue story' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: '{"path":"/lorebooks/a.md"}' }],
                },
                { role: 'tool', toolCallId: 'tc_1', toolName: 'read_file', content: 'Lore text' },
            ],
            readSetSnapshot: { '/lorebooks/a.md': 'hash-a' },
            stagedSnapshot: {
                variables: {
                    'variables.json': { source: 'main', content: '{"hp":9}' },
                },
            },
            createdAt: 123456,
        });

        // replaceFrom copies threads, checkpoints, frozenPrefix, and interrupted checkpoints cleanly
        const replacementTarget = new TrajectoryStore();
        replacementTarget.appendTurn([{ role: 'user', content: 'Stale' }], 'stale_agent');
        replacementTarget.saveInterruptedCheckpoint({
            agentId: 'stale_agent',
            target: { messageId: 99, swipeId: 0 },
            reason: 'error',
            completedTurnMessages: [],
            readSetSnapshot: {},
            stagedSnapshot: {},
            createdAt: 1,
        });

        replacementTarget.replaceFrom(reloaded);
        expect(replacementTarget.hasThread('stale_agent')).toBe(false);
        expect(replacementTarget.getInterruptedCheckpoint({ messageId: 99, swipeId: 0 })).toBeUndefined();
        expect(replacementTarget.getFrozenPrefix('main')?.messages[0].content).toBe('Base');
        expect(replacementTarget.getCheckpoint({ messageId: 3, swipeId: 0 }, 'main')).toBeDefined();
        expect(replacementTarget.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 })?.reason).toBe('length');

        // Self-replace is a safe no-op
        replacementTarget.replaceFrom(replacementTarget);
        expect(replacementTarget.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 })?.reason).toBe('length');

        // Backwards compatibility with legacy v1 serialized payloads lacking `interrupted`
        const legacyRestored = TrajectoryStore.deserialize({
            version: 1,
            threads: store.serialize().threads,
        });
        expect(legacyRestored.listInterruptedCheckpoints().size).toBe(0);
        expect(legacyRestored.serialize().interrupted).toBeUndefined();

        expect(reloaded.clearInterruptedCheckpoint({ messageId: 5, swipeId: 1 })).toBe(true);
        expect(reloaded.clearInterruptedCheckpoint({ messageId: 5, swipeId: 1 })).toBe(false);
        expect(reloaded.getInterruptedCheckpoint({ messageId: 5, swipeId: 1 })).toBeUndefined();
    });

    it('auto-cleans interrupted checkpoints on pruneSwipe, pruneFromMessage, and clearThread', () => {
        const store = new TrajectoryStore();

        const makeCp = (agentId: string, messageId: number, swipeId: number): InterruptedTurnCheckpoint => ({
            agentId,
            target: { messageId, swipeId },
            reason: 'user_stop',
            completedTurnMessages: [{ role: 'user', content: `m${messageId}#${swipeId}` }],
            readSetSnapshot: {},
            stagedSnapshot: {},
            createdAt: 100,
        });

        store.saveInterruptedCheckpoint(makeCp('main', 1, 0));
        store.saveInterruptedCheckpoint(makeCp('main', 3, 0));
        store.saveInterruptedCheckpoint(makeCp('main', 3, 1));
        store.saveInterruptedCheckpoint(makeCp('chronicler', 4, 0));

        // pruneSwipe with mismatched agentId preserves the checkpoint
        store.pruneSwipe({ messageId: 3, swipeId: 0 }, 'chronicler');
        expect(store.getInterruptedCheckpoint({ messageId: 3, swipeId: 0 })).toBeDefined();

        // pruneSwipe with matching agentId (even when threads map has no entry yet) removes it
        store.pruneSwipe({ messageId: 3, swipeId: 0 }, 'main');
        expect(store.getInterruptedCheckpoint({ messageId: 3, swipeId: 0 })).toBeUndefined();
        expect(store.getInterruptedCheckpoint({ messageId: 3, swipeId: 1 })).toBeDefined();

        // pruneFromMessage filtered by agentId removes only matching agent's >= messageId checkpoints
        store.pruneFromMessage(3, 'main');
        expect(store.getInterruptedCheckpoint({ messageId: 3, swipeId: 1 })).toBeUndefined();
        expect(store.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 })).toBeDefined();
        expect(store.getInterruptedCheckpoint({ messageId: 4, swipeId: 0 })).toBeDefined();

        // clearThread removes remaining checkpoints for that agent only
        store.clearThread('main');
        expect(store.getInterruptedCheckpoint({ messageId: 1, swipeId: 0 })).toBeUndefined();
        expect(store.getInterruptedCheckpoint({ messageId: 4, swipeId: 0 })).toBeDefined();

        // pruneFromMessage without agentId removes all remaining >= messageId
        store.pruneFromMessage(4);
        expect(store.getInterruptedCheckpoint({ messageId: 4, swipeId: 0 })).toBeUndefined();
    });

    it('prunes cold checkpoints (< coldEnd) and releases obsolete message snapshots from serialized pool', () => {
        const store = new TrajectoryStore();
        const totalTurns = 100;
        const keepDepth = 12;

        // Simulate 100 turns where compaction periodically replaced active Layer 1 messages
        for (let i = 0; i < totalTurns; ++i) {
            store.appendTurn(
                [
                    { role: 'user', content: `Turn ${i} user input ` + 'u'.repeat(200) },
                    { role: 'assistant', content: `Turn ${i} reply ` + 'a'.repeat(200) },
                ],
                'main',
            );
            store.recordCheckpoint({ messageId: i, swipeId: 0 }, 'main');

            // At turn 80, simulate watermark compaction flattening turns [0..80)
            if (i === 80) {
                store.applyCompaction(
                    {
                        compactedMessages: [
                            { role: 'system', content: 'Compacted summary up to turn 80' },
                        ],
                        archivedUpToChunk: 1,
                        compactionHeaderCount: 1,
                        turnEndCounts: [1],
                    },
                    'main',
                );
            }
        }

        expect(store.countCheckpoints('main')).toBe(100);
        const bytesBefore = store.estimateBytes();

        const coldEnd = totalTurns - keepDepth; // 88
        const result = store.pruneColdCheckpoints(coldEnd, 'main');
        expect(result.removedCheckpoints).toBe(88);
        expect(result.remainingCheckpoints).toBe(12);
        expect(store.countCheckpoints('main')).toBe(12);

        const bytesAfter = store.estimateBytes();
        // Releasing 88 obsolete checkpoints dramatically shrinks messagePool
        expect(bytesAfter).toBeLessThan(bytesBefore * 0.5);

        // Hot checkpoints [88..99] remain restorable
        expect(store.restoreBranch({ messageId: 90, swipeId: 0 }, 'main')).toBe(true);
        expect(store.restoreBranch({ messageId: 99, swipeId: 0 }, 'main')).toBe(true);

        // When ALL checkpoints are cold (coldEnd > max messageId), keep single newest anchor
        const anchorOnly = store.pruneColdCheckpoints(500, 'main');
        expect(anchorOnly.removedCheckpoints).toBe(11);
        expect(anchorOnly.remainingCheckpoints).toBe(1);
        expect(store.restoreBranch({ messageId: 99, swipeId: 0 }, 'main')).toBe(true);
    });

    it('preserves optional prefixFingerprint on frozenPrefix across serialize, deserialize, and replaceFrom', () => {
        const store = new TrajectoryStore();

        store.setFrozenPrefix(
            {
                tools: [],
                messages: [{ role: 'system', content: 'No fingerprint' }],
                layer0EndIndex: 0,
            },
            'legacy_thread',
        );
        store.setFrozenPrefix(
            {
                tools: [],
                messages: [{ role: 'system', content: 'With fingerprint' }],
                layer0EndIndex: 0,
                prefixFingerprint: 'fp_preset_1',
            },
            'assistant:sess_1',
        );

        const serialized = store.serialize();
        expect('prefixFingerprint' in (serialized.threads.legacy_thread.frozenPrefix ?? {})).toBe(false);
        expect(serialized.threads['assistant:sess_1'].frozenPrefix?.prefixFingerprint).toBe('fp_preset_1');

        const deserialized = TrajectoryStore.deserialize(serialized);
        expect(deserialized.getFrozenPrefix('legacy_thread')?.prefixFingerprint).toBeUndefined();
        expect('prefixFingerprint' in (deserialized.getFrozenPrefix('legacy_thread') ?? {})).toBe(false);
        expect(deserialized.getFrozenPrefix('assistant:sess_1')?.prefixFingerprint).toBe('fp_preset_1');

        const replaced = new TrajectoryStore();
        replaced.replaceFrom(deserialized);
        expect(replaced.getFrozenPrefix('legacy_thread')?.prefixFingerprint).toBeUndefined();
        expect('prefixFingerprint' in (replaced.getFrozenPrefix('legacy_thread') ?? {})).toBe(false);
        expect(replaced.getFrozenPrefix('assistant:sess_1')?.prefixFingerprint).toBe('fp_preset_1');
    });
});
