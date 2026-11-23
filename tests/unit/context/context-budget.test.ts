import { describe, expect, it } from 'vitest';
import {
    applyToolOutputGate,
    DEFAULT_MAX_TOOL_RESULT_BYTES,
    DEFAULT_SPILL_MAX_ENTRY_BYTES,
    DEFAULT_SPILL_POOL_MAX_BYTES,
    isSpillPath,
    resolveEffectiveContextBudget,
    SPILL_PATH_PREFIX,
    TransientToolSpillStore,
    utf8ByteLength,
} from '@/core/context';

describe('resolveEffectiveContextBudget', () => {
    it('computes reserved output, safety margin, preFlightThreshold, and adaptive watermarks from contextSize', () => {
        const budget = resolveEffectiveContextBudget({
            contextSize: 128_000,
            maxTokens: 4_096,
            model: 'gpt-4o',
        });

        expect(budget.contextLimit).toBe(128_000);
        expect(budget.reservedOutputTokens).toBe(4_096);
        expect(budget.safeInputBudget).toBeLessThan(budget.contextLimit - budget.reservedOutputTokens);
        expect(budget.preFlightThreshold).toBe(Math.floor(budget.safeInputBudget * 0.88));
        expect(budget.autoHighWatermark).toBeLessThanOrEqual(budget.preFlightThreshold);
        expect(budget.autoHighWatermark).toBeLessThanOrEqual(budget.safeInputBudget);
        expect(budget.autoLowWatermark).toBeGreaterThan(0);
        expect(budget.autoLowWatermark).toBeLessThan(budget.autoHighWatermark);
    });

    it('clamps reservedOutputTokens into [1024, floor(contextLimit * 0.25)]', () => {
        const tinyOutput = resolveEffectiveContextBudget({
            contextSize: 64_000,
            maxTokens: 128,
            model: 'deepseek-chat',
        });
        expect(tinyOutput.reservedOutputTokens).toBe(1024);

        const hugeOutput = resolveEffectiveContextBudget({
            contextSize: 16_000,
            maxTokens: 12_000,
            model: 'custom-16k',
        });
        expect(hugeOutput.reservedOutputTokens).toBe(4_000);
    });

    it('falls back to sensible model-name context limits when contextSize is missing or invalid', () => {
        const gemini = resolveEffectiveContextBudget({
            contextSize: 0,
            maxTokens: 8192,
            model: 'gemini-2.5-pro',
        });
        expect(gemini.contextLimit).toBe(1_048_576);

        const claude = resolveEffectiveContextBudget({
            contextSize: Number.NaN,
            maxTokens: 4096,
            model: 'claude-3-7-sonnet',
        });
        expect(claude.contextLimit).toBe(200_000);

        const unknown = resolveEffectiveContextBudget({
            contextSize: -100,
            maxTokens: 2048,
            model: 'my-local-model',
        });
        expect(unknown.contextLimit).toBe(64_000);
    });

    it('honors providerLimitOverride and clamps configuredWatermark never to exceed safeInputBudget', () => {
        const overridden = resolveEffectiveContextBudget(
            { contextSize: 200_000, maxTokens: 4096, model: 'claude-3-5-sonnet' },
            {
                providerLimitOverride: 32_768,
                configuredWatermark: { high: 120_000, low: 60_000 },
            },
        );

        expect(overridden.contextLimit).toBe(32_768);
        expect(overridden.autoHighWatermark).toBeLessThanOrEqual(overridden.preFlightThreshold);
        expect(overridden.autoHighWatermark).toBeLessThanOrEqual(overridden.safeInputBudget);
        expect(overridden.autoLowWatermark).toBeLessThan(overridden.autoHighWatermark);

        const withinBudget = resolveEffectiveContextBudget(
            { contextSize: 128_000, maxTokens: 4096, model: 'gpt-4o' },
            { configuredWatermark: { high: 36_000, low: 18_000 } },
        );
        expect(withinBudget.autoHighWatermark).toBe(36_000);
        expect(withinBudget.autoLowWatermark).toBe(18_000);
    });
});

describe('TransientToolSpillStore', () => {
    it('exports expected default limits and validates spill paths safely', () => {
        expect(DEFAULT_MAX_TOOL_RESULT_BYTES).toBe(32 * 1024);
        expect(DEFAULT_SPILL_MAX_ENTRY_BYTES).toBe(2 * 1024 * 1024);
        expect(DEFAULT_SPILL_POOL_MAX_BYTES).toBe(16 * 1024 * 1024);

        expect(isSpillPath('/tmp/tool-spill/call_1.txt')).toBe(true);
        expect(isSpillPath('/tmp/tool-spill')).toBe(true);
        expect(isSpillPath('/tmp/tool-spill/../secret.txt')).toBe(false);
        expect(isSpillPath('/tmp/other/call_1.txt')).toBe(false);
        expect(isSpillPath('/memory/notes.md')).toBe(false);
    });

    it('stores, slices by 1-based lines, and greps spill entries', () => {
        const store = new TransientToolSpillStore();
        const content = [
            'alpha line 1',
            'Beta keyword line 2',
            'gamma line 3',
            'delta KEYWORD line 4',
            'epsilon line 5',
        ].join('\n');

        const entry = store.put({
            toolCallId: 'call/abc 123',
            toolName: 'read_file',
            content,
            scopeId: 'session-1',
        });

        expect(entry.path.startsWith(SPILL_PATH_PREFIX)).toBe(true);
        expect(entry.lineCount).toBe(5);
        expect(entry.byteLength).toBe(utf8ByteLength(content));
        expect(store.get(entry.path)?.content).toBe(content);

        expect(store.readSlice(entry.path, 2, 4)).toBe(
            'Beta keyword line 2\ngamma line 3\ndelta KEYWORD line 4',
        );
        expect(store.readSlice('/tmp/tool-spill/does-not-exist.txt', 1, 5)).toBeNull();

        const caseSensitiveHits = store.grep(entry.path, 'keyword');
        expect(caseSensitiveHits).toHaveLength(1);
        expect(caseSensitiveHits[0]).toMatchObject({
            path: entry.path,
            title: 'read_file',
            line: 2,
            snippet: 'Beta keyword line 2',
        });

        const caseInsensitiveHits = store.grep(entry.path, 'keyword', { caseSensitive: false });
        expect(caseInsensitiveHits.map((h) => h.line)).toEqual([2, 4]);

        const regexHits = store.grep('/tmp/tool-spill', '^(gamma|epsilon)', { regex: true, limit: 1 });
        expect(regexHits).toHaveLength(1);
        expect(regexHits[0].line).toBe(3);
    });

    it('enforces maxEntryBytes, LRU maxPoolBytes eviction, clearScope, and clearAll', () => {
        const store = new TransientToolSpillStore({
            maxEntryBytes: 120,
            maxPoolBytes: 250,
        });

        const oversized = '汉'.repeat(100); // 300 UTF-8 bytes
        const e1 = store.put({
            toolCallId: 'c1',
            toolName: 'tool_a',
            content: oversized,
            scopeId: 'scope-a',
        });
        expect(e1.byteLength).toBeLessThanOrEqual(120);
        expect(utf8ByteLength(e1.content)).toBe(e1.byteLength);

        const e2 = store.put({
            toolCallId: 'c2',
            toolName: 'tool_b',
            content: 'b'.repeat(100),
            scopeId: 'scope-b',
        });
        // Touch e1 so e2 becomes least-recently-used.
        expect(store.get(e1.path)).not.toBeNull();

        const e3 = store.put({
            toolCallId: 'c3',
            toolName: 'tool_c',
            content: 'c'.repeat(100),
            scopeId: 'scope-a',
        });

        expect(store.totalBytes).toBeLessThanOrEqual(250);
        expect(store.get(e2.path)).toBeNull(); // LRU evicted
        expect(store.get(e1.path)).not.toBeNull();
        expect(store.get(e3.path)).not.toBeNull();

        store.clearScope('scope-a');
        expect(store.size).toBe(0);
        expect(store.totalBytes).toBe(0);

        store.put({ toolCallId: 'c4', toolName: 'tool_d', content: 'hello' });
        expect(store.size).toBe(1);
        store.clearAll();
        expect(store.size).toBe(0);
        expect(store.totalBytes).toBe(0);
    });
});

describe('applyToolOutputGate', () => {
    it('passes through payloads within maxBytes without truncation or spilling', () => {
        const spillStore = new TransientToolSpillStore();
        const raw = '{"ok":true,"value":"small"}';

        const result = applyToolOutputGate(raw, {
            toolName: 'st_settings_read',
            toolCallId: 'call_small',
            maxBytes: 1024,
            spillStore,
        });

        expect(result).toEqual({
            output: raw,
            truncated: false,
            originalBytes: utf8ByteLength(raw),
            finalBytes: utf8ByteLength(raw),
        });
        expect(spillStore.size).toBe(0);
    });

    it('emits a descending-byte JSON Key Manifest with <=100-char previews and spill pointer', () => {
        const spillStore = new TransientToolSpillStore();
        const payload = {
            tinyFlag: true,
            mediumList: Array.from({ length: 12 }, (_, i) => `item-${i}-${'x'.repeat(20)}`),
            hugeExtension: {
                scripts: 'const x = 1;\n'.repeat(300),
                themeData: 'A'.repeat(2000),
            },
        };
        const raw = JSON.stringify(payload);

        const result = applyToolOutputGate(raw, {
            toolName: 'st_settings_read',
            toolCallId: 'call_json_1',
            maxBytes: 1500,
            rawData: payload,
            spillStore,
            scopeId: 'sess-1',
        });

        expect(result.truncated).toBe(true);
        expect(result.originalBytes).toBe(utf8ByteLength(raw));
        expect(result.finalBytes).toBeLessThanOrEqual(1500);
        expect(result.spillPath).toBe('/tmp/tool-spill/call_json_1.json');
        expect(spillStore.get(result.spillPath!)?.content).toBe(raw);

        const parsed = JSON.parse(result.output) as {
            truncated: boolean;
            totalKeys: number;
            manifest: Array<{ key: string; type: string; bytes: number; itemCount?: number; preview: string }>;
            spillPath: string;
        };
        expect(parsed.truncated).toBe(true);
        expect(parsed.totalKeys).toBe(3);
        expect(parsed.spillPath).toBe('/tmp/tool-spill/call_json_1.json');
        expect(parsed.manifest[0].key).toBe('hugeExtension');
        expect(parsed.manifest[0].type).toBe('object');
        expect(parsed.manifest[0].itemCount).toBe(2);
        expect(parsed.manifest[1].key).toBe('mediumList');
        expect(parsed.manifest[1].itemCount).toBe(12);
        for (const item of parsed.manifest) {
            expect(item.preview.length).toBeLessThanOrEqual(100);
        }
        for (let i = 1; i < parsed.manifest.length; i += 1) {
            expect(parsed.manifest[i - 1].bytes).toBeGreaterThanOrEqual(parsed.manifest[i].bytes);
        }
    });

    it('keeps JSON Key Manifest within maxBytes even when object has thousands of keys', () => {
        const bigObj: Record<string, string> = {};
        for (let i = 0; i < 1500; i += 1) {
            bigObj[`key_${String(i).padStart(4, '0')}`] = `value_${'v'.repeat(30)}`;
        }
        const raw = JSON.stringify(bigObj);

        const result = applyToolOutputGate(raw, {
            toolName: 'st_settings_read',
            toolCallId: 'call_many_keys',
            maxBytes: 2048,
        });

        expect(result.truncated).toBe(true);
        expect(result.finalBytes).toBeLessThanOrEqual(2048);
        const parsed = JSON.parse(result.output) as {
            totalKeys: number;
            shownKeys: number;
            omittedKeys: number;
        };
        expect(parsed.totalKeys).toBe(1500);
        expect(parsed.shownKeys).toBeGreaterThan(0);
        expect(parsed.shownKeys + parsed.omittedKeys).toBe(1500);
    });

    it('keeps head (120 lines) + omission banner + tail (30 lines) + spill pointer for long multi-line text', () => {
        const spillStore = new TransientToolSpillStore();
        const lines = Array.from(
            { length: 400 },
            (_, i) => `Line ${String(i + 1).padStart(3, '0')}: ${'content '.repeat(12)}`,
        );
        lines[200] = 'Line 201: SECRET_NEEDLE_IN_MIDDLE';
        const raw = lines.join('\n');

        const result = applyToolOutputGate(raw, {
            toolName: 'read_file',
            toolCallId: 'call_text_1',
            maxBytes: 32 * 1024,
            spillStore,
            scopeId: 'sess-2',
        });

        expect(result.truncated).toBe(true);
        expect(result.finalBytes).toBeLessThanOrEqual(32 * 1024);
        expect(result.spillPath).toBe('/tmp/tool-spill/call_text_1.txt');
        expect(result.output).toContain('Line 001:');
        expect(result.output).toContain('Line 120:');
        expect(result.output).not.toContain('Line 121:');
        expect(result.output).toContain('omitted 250 lines');
        expect(result.output).toContain('400 lines');
        expect(result.output).toContain('Line 371:');
        expect(result.output).toContain('Line 400:');
        expect(result.output).toContain('read_file');
        expect(result.output).toContain('grep_search');
        expect(result.output).toContain(result.spillPath!);

        // Full middle content remains retrievable via spill store
        const hits = spillStore.grep(result.spillPath!, 'SECRET_NEEDLE_IN_MIDDLE');
        expect(hits).toHaveLength(1);
        expect(hits[0].line).toBe(201);
        expect(spillStore.readSlice(result.spillPath!, 201, 201)).toBe('Line 201: SECRET_NEEDLE_IN_MIDDLE');
    });

    it('strictly bounds huge single-line text payloads within maxBytes', () => {
        const spillStore = new TransientToolSpillStore();
        const raw = `START_${'X'.repeat(80_000)}_END`;

        const result = applyToolOutputGate(raw, {
            toolName: 'custom_tool',
            toolCallId: 'call_single_line',
            maxBytes: 2048,
            spillStore,
        });

        expect(result.truncated).toBe(true);
        expect(result.finalBytes).toBeLessThanOrEqual(2048);
        expect(utf8ByteLength(result.output)).toBe(result.finalBytes);
        expect(result.output.startsWith('START_')).toBe(true);
        expect(result.output).toContain('_END');
        expect(result.output).toContain('/tmp/tool-spill/call_single_line.txt');
        expect(spillStore.get(result.spillPath!)?.content).toBe(raw);
    });
});
