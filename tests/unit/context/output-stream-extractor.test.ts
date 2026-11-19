import { describe, expect, it, vi } from 'vitest';
import { IncrementalOutputStreamExtractor } from '@/core/agents/output-stream-extractor';

describe('IncrementalOutputStreamExtractor', () => {
    it('streams 1-character chunks for write_file targeting /output.md without corruptions', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        const payload = JSON.stringify({
            path: '/output.md',
            content: 'Hello, world!',
        });

        extractor.feedToolCallDelta(0, { name: 'write_file' });
        for (const ch of payload) {
            extractor.feedToolCallDelta(0, { argumentsDelta: ch });
        }

        expect(previews.length).toBeGreaterThan(1);
        expect(previews[0]).toBe('H');
        expect(previews[previews.length - 1]).toBe('Hello, world!');
        expect(extractor.getSalvageableOutput()).toBe('Hello, world!');
    });

    it('decodes split escape sequences and UTF-16 surrogate pairs across chunk boundaries', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        const chunks = [
            '{"path":"/output.md","content":"Line1\\',
            'n\\"Quoted\\" \\',
            '\\ \\',
            '/ \\b\\f\\r\\t \\',
            'u4e',
            '2d ',
            '\\uD8',
            '3D',
            '\\uDE',
            '00',
            ' done"}',
        ];

        for (const chunk of chunks) {
            extractor.feedToolCallDelta(0, {
                name: 'write_file',
                argumentsDelta: chunk,
            });
        }

        for (const preview of previews) {
            expect(preview.includes('\uFFFD')).toBe(false);
            // Ensure no unpaired high surrogate ever escaped into a preview
            for (let i = 0; i < preview.length; i += 1) {
                const code = preview.charCodeAt(i);
                if (code >= 0xd800 && code <= 0xdbff) {
                    const next = preview.charCodeAt(i + 1);
                    expect(next).toBeGreaterThanOrEqual(0xdc00);
                    expect(next).toBeLessThanOrEqual(0xdfff);
                    i += 1;
                }
            }
        }

        const expected = 'Line1\n"Quoted" \\ / \b\f\r\t 中 😀 done';
        expect(previews[previews.length - 1]).toBe(expected);
        expect(extractor.getSalvageableOutput()).toBe(expected);
    });

    it('holds incomplete surrogate pair on interruption without emitting lone surrogate or U+FFFD', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"path":"/output.md","content":"Safe \\uD83D',
        });

        expect(extractor.getSalvageableOutput()).toBe('Safe ');
        expect(previews).toEqual(['Safe ']);

        // Also handles raw UTF-16 literal surrogate pair split across chunks
        extractor.resetRound('');
        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"path":"/output.md","content":"Raw \uD83D',
        });
        expect(extractor.getSalvageableOutput()).toBe('Raw ');

        extractor.feedToolCallDelta(0, {
            argumentsDelta: '\uDE00!"}',
        });
        expect(extractor.getSalvageableOutput()).toBe('Raw 😀!');
    });

    it('buffers content when content arrives before path and emits immediately once path confirms /output.md', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"content":"Reversed key',
        });
        expect(previews).toEqual([]);
        expect(extractor.getSalvageableOutput()).toBeNull();

        extractor.feedToolCallDelta(0, {
            argumentsDelta: ' order!","path":"output',
        });
        expect(previews).toEqual([]);
        expect(extractor.getSalvageableOutput()).toBeNull();

        extractor.feedToolCallDelta(0, {
            argumentsDelta: '.md"}',
        });
        expect(previews).toEqual(['Reversed key order!']);
        expect(extractor.getSalvageableOutput()).toBe('Reversed key order!');
    });

    it('normalizes relative output.md paths and ignores non-/output.md targets', () => {
        const onPreview = vi.fn();
        const extractor = new IncrementalOutputStreamExtractor({ onPreview });

        // ./output.md normalizes to /output.md
        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"path":"./output.md","content":"Normalized"}',
        });
        expect(onPreview).toHaveBeenCalledWith('Normalized');
        expect(extractor.getSalvageableOutput()).toBe('Normalized');

        // /memory/notes.md must be ignored even when content came first
        extractor.resetRound('');
        onPreview.mockClear();

        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"content":"Private note","path":"/memory/notes.md"}',
        });
        expect(onPreview).not.toHaveBeenCalled();
        expect(extractor.getSalvageableOutput()).toBeNull();

        // Path traversal must also be ignored
        extractor.resetRound('');
        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"path":"../output.md","content":"Blocked"}',
        });
        expect(onPreview).not.toHaveBeenCalled();
        expect(extractor.getSalvageableOutput()).toBeNull();
    });

    it('tracks brace/bracket depth so nested objects and extra keys never confuse top-level path/content', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        const payload = [
            '{\n',
            '  "meta" : { "path" : "/output.md", "content" : "TRAP", "arr" : [ { "bad" : "\\" } { \\"" } ] },\n',
            '  "dryRun" : false ,\n',
            '  "retries" : 2 ,\n',
            '  "content" : "Actual body",\n',
            '  "extra" : null ,\n',
            '  "path" : "output.md"\n',
            '}',
        ].join('');

        for (const ch of payload) {
            extractor.feedToolCallDelta(0, { name: 'write_file', argumentsDelta: ch });
        }

        expect(previews).toEqual(['Actual body']);
        expect(extractor.getSalvageableOutput()).toBe('Actual body');
    });

    it('ignores non-target tools and prevents unrelated tool calls from clobbering active /output.md salvage', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            onPreview: (text) => previews.push(text),
        });

        extractor.feedToolCallDelta(0, {
            name: 'edit_file',
            argumentsDelta: '{"path":"/output.md","oldText":"a","newText":"b"}',
        });
        expect(previews).toEqual([]);
        expect(extractor.getSalvageableOutput()).toBeNull();

        extractor.feedToolCallDelta(1, {
            name: 'write_file',
            argumentsDelta: '{"path":"/output.md","content":"Primary story"}',
        });
        expect(extractor.getSalvageableOutput()).toBe('Primary story');

        // A parallel call targeting /memory/notes.md must not discard index 1's salvageable output
        extractor.feedToolCallDelta(2, {
            name: 'write_file',
            argumentsDelta: '{"path":"/memory/notes.md","content":"Side note"}',
        });
        expect(previews).toEqual(['Primary story']);
        expect(extractor.getSalvageableOutput()).toBe('Primary story');
    });

    it('joins append_file content with baseOutput and supports resetRound / markToolExecuted', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            initialOutput: 'Paragraph 1.',
            onPreview: (text) => previews.push(text),
        });

        // No new decoded content yet -> salvageable remains null and no spurious preview
        extractor.feedToolCallDelta(0, {
            name: 'append_file',
            argumentsDelta: '{"path":"/output.md","content":"',
        });
        expect(previews).toEqual([]);
        expect(extractor.getSalvageableOutput()).toBeNull();

        extractor.feedToolCallDelta(0, { argumentsDelta: ' Paragraph ' });
        expect(previews).toEqual(['Paragraph 1. Paragraph ']);
        expect(extractor.getSalvageableOutput()).toBe('Paragraph 1. Paragraph ');

        extractor.feedToolCallDelta(0, { argumentsDelta: '2."}' });
        expect(previews).toEqual(['Paragraph 1. Paragraph ', 'Paragraph 1. Paragraph 2.']);
        expect(extractor.getSalvageableOutput()).toBe('Paragraph 1. Paragraph 2.');

        // markToolExecuted clears pending salvageable output and advances baseOutput
        extractor.markToolExecuted('Paragraph 1. Paragraph 2.');
        expect(extractor.getSalvageableOutput()).toBeNull();

        // Subsequent append_file in the same round uses updated baseOutput
        extractor.feedToolCallDelta(1, {
            name: 'append_file',
            argumentsDelta: '{"content":" Paragraph 3.","path":"output.md"}',
        });
        expect(previews[previews.length - 1]).toBe('Paragraph 1. Paragraph 2. Paragraph 3.');
        expect(extractor.getSalvageableOutput()).toBe('Paragraph 1. Paragraph 2. Paragraph 3.');

        // resetRound clears per-round map and sets baseOutput cleanly
        extractor.resetRound('Committed base.');
        expect(extractor.getSalvageableOutput()).toBeNull();

        // Empty write_file content has no salvageable output
        extractor.feedToolCallDelta(0, {
            name: 'write_file',
            argumentsDelta: '{"path":"/output.md","content":""}',
        });
        expect(extractor.getSalvageableOutput()).toBeNull();
    });

    it('handles arguments arriving before tool name or incremental name chunks', () => {
        const previews: string[] = [];
        const extractor = new IncrementalOutputStreamExtractor({
            initialOutput: 'Start:',
            onPreview: (text) => previews.push(text),
        });

        extractor.feedToolCallDelta(0, { name: 'append', argumentsDelta: '{"path":"/output.md",' });
        expect(previews).toEqual([]);
        extractor.feedToolCallDelta(0, { name: '_file', argumentsDelta: '"content":" End"}' });
        expect(previews).toEqual(['Start: End']);
        expect(extractor.getSalvageableOutput()).toBe('Start: End');
    });
});
