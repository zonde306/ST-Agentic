import { describe, expect, it } from 'vitest';
import type { RawLoreEntry } from '@/core/types';
import {
    ScopedToolGuard,
    VfsInvalidPathError,
    VfsPermissionError,
    VfsReadOnlyError,
    VirtualFileSystem,
} from '@/core/vfs';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function setupVfs(): VirtualFileSystem {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        characterFields: hollowChineseCard.characterFields,
        personaDescription: hollowChineseCard.personaDescription,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'ok' });
    return new VirtualFileSystem({ bridge });
}

describe('ScopedToolGuard', () => {
    it('enforces read and write Glob whitelists with clear error diagnostics', async () => {
        const vfs = setupVfs();
        await vfs.writeFile('/memory/outline.md', '大纲初稿');
        await vfs.writeFile('/secret.md', '机密文件');

        const guard = new ScopedToolGuard(vfs, {
            read: ['/lorebooks/**', '/state/variables.json', '/memory/**'],
            write: ['/memory/**', '/state/variables.json'],
        });

        // Allowed reads
        expect(await guard.read('/lorebooks/霜烬纪元/银莲花结社档案-5.md')).toContain('银莲花');
        expect(JSON.parse(await guard.read('/state/variables.json')).hp).toBe(100);
        expect(await guard.read('/memory/outline.md')).toBe('大纲初稿');

        // Allowed writes & edits
        await guard.write('/memory/notes.md', '新增笔记');
        await guard.append('/memory/notes.md', '（追加）');
        expect(await guard.read('/memory/notes.md')).toBe('新增笔记（追加）');
        const editRes = await guard.edit('/memory/outline.md', '初稿', '终稿');
        expect(editRes.ok).toBe(true);
        expect(await guard.read('/memory/outline.md')).toBe('大纲终稿');

        // Out-of-scope reads fail with VfsPermissionError diagnostic
        await expect(guard.read('/character/description.md')).rejects.toThrow(VfsPermissionError);
        await expect(guard.read('/secret.md')).rejects.toThrow(/Unauthorized VFS read access.*"\/secret\.md"/);
        await expect(guard.list('/character')).rejects.toThrow(VfsPermissionError);

        // Out-of-scope writes & appends fail with VfsPermissionError diagnostic (even on readable lorebooks!)
        await expect(guard.write('/lorebooks/霜烬纪元/银莲花结社档案-5.md', 'hack')).rejects.toThrow(
            /Unauthorized VFS write access/,
        );
        await expect(guard.append('/output.md', 'hack')).rejects.toThrow(VfsPermissionError);
        await expect(guard.edit('/lorebooks/霜烬纪元/银莲花结社档案-5.md', '银莲花', '金莲花')).rejects.toThrow(
            VfsPermissionError,
        );
        await expect(guard.write('/global/prefs.md', 'hack')).rejects.toThrow(VfsPermissionError);
    });

    it('rejects .. path traversal and null bytes across all guard methods', async () => {
        const vfs = setupVfs();
        const guard = vfs.createScopedGuard({
            read: ['/**'],
            write: ['/**'],
        });

        await expect(guard.read('/lorebooks/../character/description.md')).rejects.toThrow(VfsInvalidPathError);
        await expect(guard.write('../escape.md', 'bad')).rejects.toThrow(/traversal/i);
        await expect(guard.append('../escape.md', 'bad')).rejects.toThrow(/traversal/i);
        await expect(guard.edit('/memory/../secret.md', 'a', 'b')).rejects.toThrow(VfsInvalidPathError);
        await expect(guard.list('/lorebooks/..')).rejects.toThrow(VfsInvalidPathError);
        await expect(guard.glob('/lorebooks/../**')).rejects.toThrow(VfsInvalidPathError);
        await expect(guard.search('x', { pathPrefix: '/lorebooks/..' })).rejects.toThrow(VfsInvalidPathError);
        await expect(guard.read('/bad\0path')).rejects.toThrow(VfsInvalidPathError);
    });

    it('filters list, search, grep, and glob results strictly to permitted paths and supports negation rules', async () => {
        const vfs = setupVfs();
        await vfs.writeFile('/state/generated_context.md', '秘密动态上下文 银莲花');
        await vfs.writeFile('/public/readme.md', '公开指南 银莲花');
        await vfs.writeHistoryInternal('/history/chunk-001.md', '历史归档');

        const guard = vfs.createScopedGuard({
            read: ['/**', '!/state/**', '/state/variables.json', '!/character/**'],
            write: ['/**'],
        });

        // Root list excludes /character because !/character/** blocks it
        const rootNames = (await guard.list('/')).map((e) => e.name);
        expect(rootNames).not.toContain('character');
        expect(rootNames).toContain('state');
        expect(rootNames).toContain('lorebooks');
        await expect(guard.list('/character')).rejects.toThrow(VfsPermissionError);
        await expect(guard.stat('/character')).rejects.toThrow(VfsPermissionError);

        // /state list reveals ONLY re-allowed variables.json, hiding generated_context.md
        const stateNames = (await guard.list('/state')).map((e) => e.name);
        expect(stateNames).toEqual(['variables.json']);

        await expect(guard.read('/state/generated_context.md')).rejects.toThrow(VfsPermissionError);
        expect(JSON.parse(await guard.read('/state/variables.json')).hp).toBe(100);

        // search, grep, and glob never leak /state/generated_context.md or /character/*
        const searchHits = await guard.search('银莲花');
        expect(searchHits.some((h) => h.path === '/state/generated_context.md')).toBe(false);
        expect(searchHits.some((h) => h.path === '/public/readme.md')).toBe(true);

        const grepHits = await guard.grep('银莲花');
        expect(grepHits.some((h) => h.path === '/state/generated_context.md')).toBe(false);
        expect(grepHits.some((h) => h.path === '/public/readme.md')).toBe(true);

        const globPaths = await guard.glob('/**/*.md');
        expect(globPaths).not.toContain('/state/generated_context.md');
        expect(globPaths).not.toContain('/character/description.md');
        expect(globPaths).toContain('/public/readme.md');

        // Even with write: ['/**'], read-only mounts (/history, /skills, /preset) reject agent writes
        await expect(guard.write('/history/chunk-001.md', 'tamper')).rejects.toThrow(VfsReadOnlyError);
        await expect(guard.write('/skills/rune-decode.md', 'tamper')).rejects.toThrow(VfsReadOnlyError);
    });
});
