import { describe, expect, it } from 'vitest';
import { isPathAllowed, matchGlob, normalizeVfsPath } from '@/core/utils';

describe('glob & VFS path utilities', () => {
    it('normalizes POSIX/Windows slashes and rejects .. traversal', () => {
        expect(normalizeVfsPath('')).toBe('/');
        expect(normalizeVfsPath('/')).toBe('/');
        expect(normalizeVfsPath('lorebooks\\world\\./entry-1.md/')).toBe('/lorebooks/world/entry-1.md');
        expect(normalizeVfsPath('/a/./b//c')).toBe('/a/b/c');

        expect(() => normalizeVfsPath('../secret')).toThrow(/traversal/i);
        expect(() => normalizeVfsPath('/lorebooks/../../etc/passwd')).toThrow(/traversal/i);
        expect(() => normalizeVfsPath('/bad\0path')).toThrow();
    });

    it('matches *, **, ?, and root / globs accurately', () => {
        expect(matchGlob('/**', '/')).toBe(true);
        expect(matchGlob('/**', '/state/variables.json')).toBe(true);

        expect(matchGlob('/lorebooks/**', '/lorebooks/world/银莲花-12.md')).toBe(true);
        expect(matchGlob('/lorebooks/**', '/lorebooks/entry.md')).toBe(true);
        expect(matchGlob('/lorebooks/**', '/lorebooks')).toBe(false);
        expect(matchGlob('/lorebooks/**', '/lorebooks2/entry.md')).toBe(false);

        expect(matchGlob('/a/**/c.md', '/a/c.md')).toBe(true);
        expect(matchGlob('/a/**/c.md', '/a/b/c.md')).toBe(true);
        expect(matchGlob('/a/**/c.md', '/a/b/d/c.md')).toBe(true);
        expect(matchGlob('/ax/**/c.md', '/a/c.md')).toBe(false);

        expect(matchGlob('/*.md', '/readme.md')).toBe(true);
        expect(matchGlob('/*.md', '/dir/readme.md')).toBe(false);
        expect(matchGlob('/**/*.md', '/readme.md')).toBe(true);
        expect(matchGlob('/**/*.md', '/dir/sub/readme.md')).toBe(true);

        expect(matchGlob('/dir/file?.txt', '/dir/file1.txt')).toBe(true);
        expect(matchGlob('/dir/file?.txt', '/dir/file12.txt')).toBe(false);
        expect(matchGlob('/dir/file?.txt', '/dir/file/.txt')).toBe(false);

        expect(matchGlob('/**', '/lorebooks/../secret.md')).toBe(false);
        expect(matchGlob('/../**', '/secret.md')).toBe(false);
    });

    it('evaluates ordered allow/negation lists and denies traversal in isPathAllowed', () => {
        const patterns = ['/**', '!/state/**', '/state/public.json'];

        expect(isPathAllowed(patterns, '/lorebooks/world/a.md')).toBe(true);
        expect(isPathAllowed(patterns, '/state/variables.json')).toBe(false);
        expect(isPathAllowed(patterns, '/state/public.json')).toBe(true);
        expect(isPathAllowed(['/**'], '/a/../b')).toBe(false);
        expect(isPathAllowed([], '/anything.md')).toBe(false);
    });
});
