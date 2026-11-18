import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
    canonicalClone,
    canonicalStringify,
    stripJsonSchemaMeta,
} from '@/core/utils';
import { parseBranchKey, toBranchKey } from '@/core/types';

describe('canonical-json', () => {
    it('serializes objects identically regardless of insertion key order', () => {
        const objA = {
            z: 1,
            a: { d: true, b: [3, { y: 'y', x: 'x' }, 1] },
            m: 'hello',
        };
        const objB = {
            m: 'hello',
            a: { b: [3, { x: 'x', y: 'y' }, 1], d: true },
            z: 1,
        };

        expect(canonicalStringify(objA)).toBe(canonicalStringify(objB));
        expect(canonicalStringify(objA)).toBe(
            '{"a":{"b":[3,{"x":"x","y":"y"},1],"d":true},"m":"hello","z":1}',
        );
    });

    it('omits undefined/function/symbol properties and normalizes non-finite numbers and -0', () => {
        const cloned = canonicalClone({
            keep: 0,
            negZero: -0,
            nanVal: Number.NaN,
            infVal: Number.POSITIVE_INFINITY,
            undef: undefined,
            fn: () => 42,
            arr: [1, undefined, () => 1, 'ok'],
        });

        expect(cloned).toEqual({
            arr: [1, null, null, 'ok'],
            infVal: null,
            keep: 0,
            nanVal: null,
            negZero: 0,
        });
        expect(Object.is(cloned.negZero, -0)).toBe(false);
    });

    it('throws on circular structures and BigInt', () => {
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;

        expect(() => canonicalStringify(circular)).toThrow(/circular/i);
        expect(() => canonicalStringify({ big: BigInt(10) })).toThrow(/BigInt/i);
    });

    it('strips $schema and $id emitted by Zod v4 z.toJSONSchema while preserving structure', () => {
        const schema = z.object({
            path: z.string().describe('Target VFS path'),
            recursive: z.boolean().optional(),
        });

        const rawJsonSchema = z.toJSONSchema(schema);
        expect(rawJsonSchema.$schema).toBeDefined();

        const cleaned = stripJsonSchemaMeta(rawJsonSchema);
        expect('$schema' in cleaned).toBe(false);
        expect('$id' in cleaned).toBe(false);
        expect(cleaned.type).toBe('object');
        expect((cleaned.properties as Record<string, unknown>).path).toBeDefined();
        expect(canonicalStringify(cleaned)).toBe(
            canonicalStringify(stripJsonSchemaMeta(z.toJSONSchema(schema))),
        );
    });

    it('serializes and parses causal BranchKey coordinates', () => {
        const key = toBranchKey({ messageId: 12, swipeId: 3 });
        expect(key).toBe('12#3');
        expect(parseBranchKey(key)).toEqual({ messageId: 12, swipeId: 3 });
        expect(parseBranchKey('bad')).toBeNull();
        expect(parseBranchKey('-1#0')).toBeNull();
        expect(parseBranchKey('1#2#3')).toBeNull();
    });
});
