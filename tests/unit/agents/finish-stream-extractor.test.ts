import { describe, expect, it, vi } from 'vitest';
import { FinishTurnStreamExtractor } from '@/core/agents';

describe('FinishTurnStreamExtractor', () => {
    it('incrementally decodes step_brief and response for slot 0 finish_turn across 1-char chunks', () => {
        const responseDeltas: string[] = [];
        const briefDeltas: string[] = [];
        const extractor = new FinishTurnStreamExtractor({
            onResponseDelta: (d) => responseDeltas.push(d),
            onStepBriefDelta: (d) => briefDeltas.push(d),
        });

        const payload = JSON.stringify({
            step_brief: 'Summarize findings clearly.',
            response: 'Here is the final answer!',
        });

        // Chunked tool name + early args
        extractor.feedToolCallDelta(0, { name: 'finish', argumentsDelta: payload.slice(0, 10) });
        expect(responseDeltas).toEqual([]);
        expect(extractor.isFinishTurnConfirmed()).toBe(false);

        extractor.feedToolCallDelta(0, { name: '_turn' });
        expect(extractor.isFinishTurnConfirmed()).toBe(true);

        for (let i = 10; i < payload.length; i += 1) {
            extractor.feedToolCallDelta(0, { argumentsDelta: payload[i] });
        }

        expect(briefDeltas.join('')).toBe('Summarize findings clearly.');
        expect(responseDeltas.join('')).toBe('Here is the final answer!');
        expect(extractor.getDecodedStepBrief()).toBe('Summarize findings clearly.');
        expect(extractor.getDecodedResponse()).toBe('Here is the final answer!');
        expect(extractor.isSuppressed()).toBe(false);
    });

    it('decodes split escape sequences and UTF-16 surrogate pairs without emitting lone surrogates', () => {
        const responseDeltas: string[] = [];
        const extractor = new FinishTurnStreamExtractor({
            onResponseDelta: (d) => responseDeltas.push(d),
        });

        const chunks = [
            '{"extra":{"nested":[1,"ignore"]},"step_brief":"Plan\\n1","response":"Hi\\',
            'n\\"World\\" \\',
            '\\ \\',
            '/ \\t \\',
            'u4e',
            '2d ',
            '\\uD8',
            '3D',
            '\\uDE',
            '80',
            ' raw \uD83D',
            '\uDE00"}',
        ];

        for (const chunk of chunks) {
            extractor.feedToolCallDelta(0, {
                name: 'finish_turn',
                argumentsDelta: chunk,
            });
        }

        for (const delta of responseDeltas) {
            expect(delta.includes('\uFFFD')).toBe(false);
            for (let i = 0; i < delta.length; i += 1) {
                const code = delta.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = delta.charCodeAt(i + 1);
                    expect(next).toBeGreaterThanOrEqual(0xdc00);
                    expect(next).toBeLessThanOrEqual(0xdfff);
                    i += 1;
                }
            }
        }

        expect(extractor.getDecodedStepBrief()).toBe('Plan\n1');
        expect(extractor.getDecodedResponse()).toBe('Hi\n"World" \\ / \t 中 🚀 raw 😀');
        expect(responseDeltas.join('')).toBe('Hi\n"World" \\ / \t 中 🚀 raw 😀');
    });

    it('ignores non-finish_turn tool calls at slot 0 without marking suppressed', () => {
        const onResponseDelta = vi.fn();
        const extractor = new FinishTurnStreamExtractor({ onResponseDelta });

        extractor.feedToolCallDelta(0, {
            name: 'read_file',
            argumentsDelta: '{"path":"/output.md","response":"should not leak"}',
        });

        expect(onResponseDelta).not.toHaveBeenCalled();
        expect(extractor.isFinishTurnConfirmed()).toBe(false);
        expect(extractor.isSuppressed()).toBe(false);
        expect(extractor.getDecodedResponse()).toBe('');
    });

    it('immediately suppresses output when any parallel tool slot (index > 0) arrives and resets cleanly on resetRound()', () => {
        const responseDeltas: string[] = [];
        const onSuppressed = vi.fn();
        const extractor = new FinishTurnStreamExtractor({
            onResponseDelta: (d) => responseDeltas.push(d),
            onSuppressed,
        });

        // Slot 0 starts streaming finish_turn
        extractor.feedToolCallDelta(0, {
            name: 'finish_turn',
            argumentsDelta: '{"step_brief":"done","response":"Draft ',
        });
        expect(responseDeltas).toEqual(['Draft ']);
        expect(extractor.getDecodedResponse()).toBe('Draft ');
        expect(extractor.isSuppressed()).toBe(false);

        // Parallel tool arrives at slot 1 -> immediate suppression
        extractor.feedToolCallDelta(1, {
            name: 'read_file',
            argumentsDelta: '{"path":"/a.md"}',
        });
        expect(extractor.isSuppressed()).toBe(true);
        expect(extractor.isFinishTurnConfirmed()).toBe(false);
        expect(onSuppressed).toHaveBeenCalledTimes(1);
        expect(extractor.getDecodedResponse()).toBe('');
        expect(extractor.getDecodedStepBrief()).toBe('');

        // Subsequent slot 0 or slot 2 deltas are blocked
        extractor.feedToolCallDelta(0, { argumentsDelta: 'more text"}' });
        extractor.feedToolCallDelta(2, { name: 'write_file' });
        expect(responseDeltas).toEqual(['Draft ']);
        expect(onSuppressed).toHaveBeenCalledTimes(1);

        // resetRound clears suppression and buffers cleanly for next round
        extractor.resetRound();
        expect(extractor.isSuppressed()).toBe(false);
        expect(extractor.getDecodedResponse()).toBe('');

        extractor.feedToolCallDelta(0, {
            name: 'finish_turn',
            argumentsDelta: '{"response":"Clean round 2"}',
        });
        expect(extractor.getDecodedResponse()).toBe('Clean round 2');
        expect(responseDeltas).toEqual(['Draft ', 'Clean round 2']);
    });
});
