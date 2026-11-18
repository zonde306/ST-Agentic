import { describe, expect, it } from 'vitest';
import { hashText, hashTextSync, initXxHash, isXxHashInitialized } from '@/core/utils';

describe('xxhash', () => {
    it('computes deterministic 64-bit hex digests across async and sync APIs', async () => {
        await initXxHash();
        expect(isXxHashInitialized()).toBe(true);

        const text = '银莲花档案：#12 世界观条目测试内容';
        const syncDigest = hashTextSync(text);
        const asyncDigest = await hashText(text);

        expect(syncDigest).toBe(asyncDigest);
        expect(syncDigest).toMatch(/^[0-9a-f]{16}$/);
        expect(hashTextSync(`${text}!`)).not.toBe(syncDigest);
    });

    it('handles concurrent initXxHash calls idempotently', async () => {
        await Promise.all([initXxHash(), initXxHash(), initXxHash()]);
        expect(hashTextSync('')).toBe(await hashText(''));
    });
});
