import { describe, expect, it } from 'vitest';
import {
    createEphemeralMessagesController,
    sanitizeToolCallPairs,
} from '@/core/llm';
import type { CanonicalMessage } from '@/core/types';

function makeAssistantToolCall(
    calls: Array<{ id: string; name: string; arguments?: string }>,
    content: string = '',
): CanonicalMessage {
    return {
        role: 'assistant',
        content,
        toolCalls: calls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: c.arguments ?? '{}',
        })),
    };
}

function makeToolResult(id: string, name: string, content: string): CanonicalMessage {
    return {
        role: 'tool',
        toolCallId: id,
        toolName: name,
        content,
    };
}

describe('ephemeral-messages', () => {
    describe('sanitizeToolCallPairs', () => {
        it('preserves valid single-tool and multi-tool pairs across multiple rounds', () => {
            const input: CanonicalMessage[] = [
                { role: 'system', content: 'Base system' },
                { role: 'user', content: 'Check two files' },
                makeAssistantToolCall([
                    { id: 'tc_1', name: 'read_file', arguments: '{"path":"/a.md"}' },
                    { id: 'tc_2', name: 'read_file', arguments: '{"path":"/b.md"}' },
                ]),
                // Out-of-order within the contiguous tool run is still valid
                makeToolResult('tc_2', 'read_file', 'content B'),
                makeToolResult('tc_1', 'read_file', 'content A'),
                makeAssistantToolCall([{ id: 'tc_3', name: 'write_file', arguments: '{"path":"/output.md"}' }]),
                makeToolResult('tc_3', 'write_file', 'ok'),
                { role: 'assistant', content: 'All done.' },
            ];

            const result = sanitizeToolCallPairs(input);
            expect(result).toEqual(input);
            // Output is defensively cloned
            expect(result).not.toBe(input);
            expect(result[2]).not.toBe(input[2]);
            // Idempotent
            expect(sanitizeToolCallPairs(result)).toEqual(result);
        });

        it('drops orphan tool results at start, after user/system/plain assistant, with unknown IDs, or duplicates', () => {
            const input: CanonicalMessage[] = [
                makeToolResult('orphan_start', 'read_file', 'bad'),
                { role: 'user', content: 'Hello' },
                makeToolResult('orphan_after_user', 'read_file', 'bad'),
                { role: 'assistant', content: 'Plain assistant' },
                makeToolResult('orphan_after_plain', 'read_file', 'bad'),
                makeAssistantToolCall([{ id: 'tc_valid', name: 'read_file' }]),
                makeToolResult('tc_valid', 'read_file', 'first result'),
                makeToolResult('tc_valid', 'read_file', 'duplicate result'),
                makeToolResult('tc_unknown', 'read_file', 'wrong id'),
                { role: 'tool', content: 'missing id' },
                { role: 'user', content: 'Next' },
            ];

            const result = sanitizeToolCallPairs(input);
            expect(result).toEqual([
                { role: 'user', content: 'Hello' },
                { role: 'assistant', content: 'Plain assistant' },
                makeAssistantToolCall([{ id: 'tc_valid', name: 'read_file' }]),
                makeToolResult('tc_valid', 'read_file', 'first result'),
                { role: 'user', content: 'Next' },
            ]);
        });

        it('filters partially matched toolCalls and drops or strips completely unmatched toolCalls', () => {
            const input: CanonicalMessage[] = [
                { role: 'user', content: 'Start' },
                // Partial match: tc_1 matched, tc_2 missing
                makeAssistantToolCall([
                    { id: 'tc_1', name: 'read_file' },
                    { id: 'tc_2', name: 'search_files' },
                ]),
                makeToolResult('tc_1', 'read_file', 'result 1'),
                // Completely unmatched with empty content -> dropped entirely
                makeAssistantToolCall([{ id: 'tc_empty', name: 'read_file' }], ''),
                { role: 'user', content: 'Interleaved' },
                // Completely unmatched with non-empty text -> keep assistant text, strip toolCalls
                makeAssistantToolCall([{ id: 'tc_with_text', name: 'read_file' }], 'Thinking aloud.'),
                { role: 'user', content: 'Interrupt before tool result' },
                makeToolResult('tc_with_text', 'read_file', 'too late, broken by user'),
                // Dangling tool call at end of array -> dropped
                makeAssistantToolCall([{ id: 'tc_tail', name: 'write_file' }], '   '),
            ];

            const result = sanitizeToolCallPairs(input);
            expect(result).toEqual([
                { role: 'user', content: 'Start' },
                makeAssistantToolCall([{ id: 'tc_1', name: 'read_file' }]),
                makeToolResult('tc_1', 'read_file', 'result 1'),
                { role: 'user', content: 'Interleaved' },
                { role: 'assistant', content: 'Thinking aloud.' },
                { role: 'user', content: 'Interrupt before tool result' },
            ]);
        });

        it('strips empty toolCalls arrays and stray toolCalls on non-assistant messages without mutating input', () => {
            const input: CanonicalMessage[] = [
                {
                    role: 'user',
                    content: 'Hi',
                    toolCalls: [{ id: 'bad', name: 'x', arguments: '{}' }],
                },
                {
                    role: 'assistant',
                    content: 'Reply',
                    toolCalls: [],
                },
            ];

            const result = sanitizeToolCallPairs(input);
            expect(result).toEqual([
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Reply' },
            ]);
            // Original input remains untouched
            expect(input[0].toolCalls).toHaveLength(1);
            expect(input[1].toolCalls).toEqual([]);
        });
    });

    describe('createEphemeralMessagesController', () => {
        it('rolls back recent in-flight tool rounds after turnStart without touching Layer 1 tool history', () => {
            const messages: CanonicalMessage[] = [
                // Layer 0: [0, 1)
                { role: 'system', content: 'Static prefix' },
                // Layer 1: [1, 5) — contains a historical tool round that MUST NOT be rolled back
                { role: 'user', content: 'History turn 1' },
                makeAssistantToolCall([{ id: 'h_tc1', name: 'read_file' }]),
                makeToolResult('h_tc1', 'read_file', 'hist lore'),
                { role: 'assistant', content: 'History reply 1' },
                // Current turn: [5, ...)
                { role: 'user', content: 'Current turn' },
                makeAssistantToolCall([
                    { id: 'c_tc1', name: 'read_file' },
                    { id: 'c_tc2', name: 'grep_search' },
                ]),
                makeToolResult('c_tc1', 'read_file', 'res1'),
                makeToolResult('c_tc2', 'grep_search', 'res2'),
                makeAssistantToolCall([{ id: 'c_tc3', name: 'write_file' }]),
                makeToolResult('c_tc3', 'write_file', 'bad write'),
                { role: 'system', content: 'Floating tail reminder' },
            ];

            const ctrl = createEphemeralMessagesController(messages, {
                layer0End: 1,
                layer1End: 5,
                turnStart: 5,
            });

            expect(ctrl.rollbackToolRounds(0)).toBe(0);
            expect(ctrl.rollbackToolRounds(-2)).toBe(0);

            // Roll back 1 round -> removes c_tc3 pair while keeping floating tail & c_tc1/c_tc2
            expect(ctrl.rollbackToolRounds(1)).toBe(1);
            expect(ctrl.toMessages()).toEqual([
                { role: 'system', content: 'Static prefix' },
                { role: 'user', content: 'History turn 1' },
                makeAssistantToolCall([{ id: 'h_tc1', name: 'read_file' }]),
                makeToolResult('h_tc1', 'read_file', 'hist lore'),
                { role: 'assistant', content: 'History reply 1' },
                { role: 'user', content: 'Current turn' },
                makeAssistantToolCall([
                    { id: 'c_tc1', name: 'read_file' },
                    { id: 'c_tc2', name: 'grep_search' },
                ]),
                makeToolResult('c_tc1', 'read_file', 'res1'),
                makeToolResult('c_tc2', 'grep_search', 'res2'),
                { role: 'system', content: 'Floating tail reminder' },
            ]);

            // Requesting 5 more rounds rolls back only the 1 remaining in-flight round (multi-tool atomic),
            // leaving Layer 1's h_tc1 strictly untouched!
            expect(ctrl.rollbackToolRounds(5)).toBe(1);
            expect(ctrl.toMessages()).toEqual([
                { role: 'system', content: 'Static prefix' },
                { role: 'user', content: 'History turn 1' },
                makeAssistantToolCall([{ id: 'h_tc1', name: 'read_file' }]),
                makeToolResult('h_tc1', 'read_file', 'hist lore'),
                { role: 'assistant', content: 'History reply 1' },
                { role: 'user', content: 'Current turn' },
                { role: 'system', content: 'Floating tail reminder' },
            ]);
            expect(ctrl.rollbackToolRounds(1)).toBe(0);
        });

        it('drops complete Layer 1 history turns from oldest or newest while preserving Layer 0, compaction header, and turnStart', () => {
            const baseMessages: CanonicalMessage[] = [
                // Layer 0: [0, 1)
                { role: 'system', content: 'L0 system' },
                // Layer 1: [1, 10)
                { role: 'system', content: '[Compaction Summary]' },
                // Turn 1: user + tool round + final reply (4 msgs)
                { role: 'user', content: 'Turn 1' },
                makeAssistantToolCall([{ id: 't1_tc', name: 'read_file' }]),
                makeToolResult('t1_tc', 'read_file', 'lore 1'),
                { role: 'assistant', content: 'Reply 1' },
                // Turn 2: simple exchange (2 msgs)
                { role: 'user', content: 'Turn 2' },
                { role: 'assistant', content: 'Reply 2' },
                // Turn 3: simple exchange (2 msgs)
                { role: 'user', content: 'Turn 3' },
                { role: 'assistant', content: 'Reply 3' },
                // Current turn: [10, 13)
                { role: 'user', content: 'Current input' },
                makeAssistantToolCall([{ id: 'cur_tc', name: 'read_file' }]),
                makeToolResult('cur_tc', 'read_file', 'cur lore'),
            ];

            // 1. Default from: 'oldest' drops Turn 1 (including its tool round) and preserves compaction header
            const oldestCtrl = createEphemeralMessagesController(baseMessages, {
                layer0End: 1,
                layer1End: 10,
                turnStart: 10,
            });
            expect(oldestCtrl.dropHistoryTurns(1)).toBe(1);
            expect(oldestCtrl.toMessages().map((m) => `${m.role}:${String(m.content)}`)).toEqual([
                'system:L0 system',
                'system:[Compaction Summary]',
                'user:Turn 2',
                'assistant:Reply 2',
                'user:Turn 3',
                'assistant:Reply 3',
                'user:Current input',
                'assistant:',
                'tool:cur lore',
            ]);

            // Subsequent rollbackToolRounds still knows the adjusted turnStart!
            expect(oldestCtrl.rollbackToolRounds(1)).toBe(1);
            expect(oldestCtrl.toMessages().map((m) => `${m.role}:${String(m.content)}`)).toEqual([
                'system:L0 system',
                'system:[Compaction Summary]',
                'user:Turn 2',
                'assistant:Reply 2',
                'user:Turn 3',
                'assistant:Reply 3',
                'user:Current input',
            ]);

            // 2. from: 'newest' drops Turn 3 and Turn 2, preserving Turn 1 intact
            const newestCtrl = createEphemeralMessagesController(baseMessages, {
                layer0End: 1,
                layer1End: 10,
                turnStart: 10,
            });
            expect(newestCtrl.dropHistoryTurns(2, { from: 'newest' })).toBe(2);
            expect(newestCtrl.toMessages()).toEqual([
                { role: 'system', content: 'L0 system' },
                { role: 'system', content: '[Compaction Summary]' },
                { role: 'user', content: 'Turn 1' },
                makeAssistantToolCall([{ id: 't1_tc', name: 'read_file' }]),
                makeToolResult('t1_tc', 'read_file', 'lore 1'),
                { role: 'assistant', content: 'Reply 1' },
                { role: 'user', content: 'Current input' },
                makeAssistantToolCall([{ id: 'cur_tc', name: 'read_file' }]),
                makeToolResult('cur_tc', 'read_file', 'cur lore'),
            ]);

            // Dropping more turns than remaining drops only Turn 1 (returns 1) and never touches Layer 0 or Current turn
            expect(newestCtrl.dropHistoryTurns(10, { from: 'newest' })).toBe(1);
            expect(newestCtrl.dropHistoryTurns(1)).toBe(0);
            expect(newestCtrl.toMessages()).toEqual([
                { role: 'system', content: 'L0 system' },
                { role: 'system', content: '[Compaction Summary]' },
                { role: 'user', content: 'Current input' },
                makeAssistantToolCall([{ id: 'cur_tc', name: 'read_file' }]),
                makeToolResult('cur_tc', 'read_file', 'cur lore'),
            ]);
        });

        it('supports list defensive cloning, set with sanitization, replaceContent (string/multimodal), and appendHint', () => {
            const ctrl = createEphemeralMessagesController([
                { role: 'system', content: 'Sys' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Look at this' },
                        { type: 'image_url', imageUrl: 'https://example.test/a.png' },
                    ],
                },
                { role: 'assistant', content: 'Draft answer' },
            ]);

            // list() returns defensive copy
            const snap = ctrl.list();
            snap[0].content = 'Tampered';
            expect(ctrl.list()[0].content).toBe('Sys');

            // replaceContent by negative/out-of-bounds index safely does nothing
            expect(ctrl.replaceContent(-1, 'nope')).toBe(0);
            expect(ctrl.replaceContent(99, 'nope')).toBe(0);

            // replaceContent by valid index on multimodal message preserves non-text parts
            expect(ctrl.replaceContent(1, (text) => `${text} carefully`)).toBe(1);
            expect(ctrl.list()[1].content).toEqual([
                { type: 'text', text: 'Look at this carefully' },
                { type: 'image_url', imageUrl: 'https://example.test/a.png' },
            ]);

            // replaceContent by predicate
            expect(
                ctrl.replaceContent(
                    (msg) => msg.role === 'assistant',
                    (content) => `${content}!`,
                ),
            ).toBe(1);
            expect(ctrl.list()[2].content).toBe('Draft answer!');

            // appendHint default ('user'), explicit 'system', and empty string no-op
            ctrl.appendHint('');
            ctrl.appendHint('Check formatting.');
            ctrl.appendHint('System note.', 'system');
            expect(ctrl.list().slice(3)).toEqual([
                { role: 'user', content: 'Check formatting.' },
                { role: 'system', content: 'System note.' },
            ]);

            // set() + toMessages() always enforces sanitizeToolCallPairs
            ctrl.set([
                { role: 'user', content: 'Hi' },
                makeAssistantToolCall([{ id: 'broken_tc', name: 'read_file' }]),
                makeToolResult('wrong_tc', 'read_file', 'orphan'),
            ]);
            expect(ctrl.toMessages()).toEqual([{ role: 'user', content: 'Hi' }]);
        });
    });
});
