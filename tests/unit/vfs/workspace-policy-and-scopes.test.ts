import { describe, expect, it } from 'vitest';
import { DEFAULT_MAIN_AGENT_PERMISSIONS } from '@/core/config';
import { createBuiltinToolRegistry, createToolExecutionContext } from '@/core/tools';
import { ChatDataStore } from '@/core/store';
import { hashText } from '@/core/utils';
import {
    AGENT_WORKSPACE_MAX_FILES,
    AGENT_WORKSPACE_MAX_FILE_BYTES,
    AGENT_WORKSPACE_MAX_TOTAL_BYTES,
    ScopedToolGuard,
    VfsPermissionError,
    VirtualFileSystem,
} from '@/core/vfs';
import { MemoryHostBridge } from '../../mocks';

function setupEnv(presetFiles: Record<string, string> = {}) {
    const bridge = new MemoryHostBridge();
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
    bridge.pushMessage({
        name: 'Assistant',
        isUser: false,
        mes: 'hello',
        swipeId: 0,
        swipes: ['hello', 'alt hello'],
    });
    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({
        bridge,
        store,
        getPresetFiles: () => presetFiles,
    });
    return { bridge, store, vfs };
}

describe('Workspace Policy, Scopes, Base Layer & Quotas', () => {
    it('blocks protected spec/instruction writes even when wildcard write permissions are granted', async () => {
        const { vfs } = setupEnv({
            'AGENTS.md': 'preset index',
            'docs/style.md': 'preset style',
        });

        const wildcardGuard = new ScopedToolGuard(vfs, {
            read: ['/**'],
            write: ['/**', '/workspace/**', '/global/**'],
        });

        const protectedPaths = [
            '/AGENTS.md',
            '/workspace/AGENTS.md',
            '/workspace/agents.md',
            '/workspace/shared/AGENTS.md',
            '/workspace/docs/style.md',
            '/global/AGENTS.md',
            '/global/docs/a.md',
            '/preset/AGENTS.md',
            '/preset/docs/style.md',
        ];

        for (const p of protectedPaths) {
            expect(wildcardGuard.canWrite(p), `canWrite(${p}) must be false`).toBe(false);
            await expect(wildcardGuard.write(p, 'tamper')).rejects.toThrow(VfsPermissionError);
        }

        // Shared non-AGENTS collaboration files remain writable
        await wildcardGuard.write('/workspace/shared/handoff.md', 'collab note');
        expect(await wildcardGuard.read('/workspace/shared/handoff.md')).toBe('collab note');

        // Explicit literal non-preset permission allows writing that exact non-preset spec file
        const explicitSpecGuard = new ScopedToolGuard(vfs, {
            read: ['/**'],
            write: ['/workspace/docs/style.md'],
        });
        expect(explicitSpecGuard.canWrite('/workspace/docs/style.md')).toBe(true);
        await explicitSpecGuard.write('/workspace/docs/style.md', 'explicit write ok');
        expect(await vfs.readFile('/workspace/docs/style.md')).toBe('explicit write ok');
    });

    it('enforces main-agent default permissions: allows /workspace/shared/** and blocks specs', async () => {
        const { vfs } = setupEnv();
        const mainGuard = new ScopedToolGuard(vfs, DEFAULT_MAIN_AGENT_PERMISSIONS, {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            source: 'agent:main',
        });

        expect(mainGuard.canWrite('/workspace/shared/handoff.md')).toBe(true);
        await mainGuard.write('/workspace/shared/handoff.md', 'note from main');
        expect(await mainGuard.read('/workspace/shared/handoff.md')).toBe('note from main');

        expect(mainGuard.canWrite('/workspace/AGENTS.md')).toBe(false);
        expect(mainGuard.canWrite('/workspace/docs/rules.md')).toBe(false);
        await expect(mainGuard.write('/workspace/AGENTS.md', 'hack')).rejects.toThrow(VfsPermissionError);
        await expect(mainGuard.write('/workspace/docs/rules.md', 'hack')).rejects.toThrow(VfsPermissionError);
    });

    it('persists AGENTS.md and /workspace/docs/** in chat base layer across swipes while keeping shared files branch-bound', async () => {
        const { bridge, store, vfs } = setupEnv();

        // Write on swipe 0
        await vfs.writeFile('/workspace/AGENTS.md', '# Rules v1', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            source: 'ui-edit',
        });
        await vfs.writeFile('/workspace/docs/style.md', 'Style v1', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            source: 'assistant:write_file',
        });
        await vfs.writeFile('/workspace/shared/handoff.md', 'Swipe 0 handoff', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            source: 'agent:main',
        });

        expect(store.hasBase('files', 'workspace/AGENTS.md')).toBe(true);
        expect(store.hasBase('files', 'workspace/docs/style.md')).toBe(true);
        expect(store.hasBase('files', 'workspace/shared/handoff.md')).toBe(false);

        // Switch message 1 to swipe 1
        bridge.chat[1].swipeId = 1;
        expect(await vfs.readFile('/workspace/AGENTS.md', { target: { messageId: 1, swipeId: 1 } })).toBe('# Rules v1');
        expect(await vfs.readFile('/workspace/docs/style.md', { target: { messageId: 1, swipeId: 1 } })).toBe('Style v1');
        await expect(
            vfs.readFile('/workspace/shared/handoff.md', { target: { messageId: 1, swipeId: 1 } }),
        ).rejects.toThrow();

        // Editing docs on swipe 1 updates base and remains authoritative across swipes
        await vfs.editFile('/workspace/docs/style.md', 'v1', 'v2', {
            target: { messageId: 1, swipeId: 1 },
            staged: false,
        });
        expect(await vfs.readFile('/workspace/docs/style.md', { target: { messageId: 1, swipeId: 0 } })).toBe('Style v2');

        // Deleting base spec removes it everywhere
        expect(await vfs.deleteFile('/workspace/docs/style.md', { target: { messageId: 1, swipeId: 1 } })).toBe(true);
        await expect(
            vfs.readFile('/workspace/docs/style.md', { target: { messageId: 1, swipeId: 0 } }),
        ).rejects.toThrow();
    });

    it('updates writer Read-Set on write/append/edit, enforces workspace quotas, and returns missing-path hints', async () => {
        const { bridge, store, vfs } = setupEnv({
            'docs/preset-guide.md': 'Preset guide content',
        });
        await vfs.writeFile('/workspace/docs/style.md', 'Workspace style guide');
        await vfs.writeFile('/secret/hidden.md', 'Hidden secret');

        const registry = createBuiltinToolRegistry();
        const readSet = new Map<string, string>();
        const ctx = createToolExecutionContext({
            bridge,
            vfs,
            store,
            target: { messageId: 1, swipeId: 0 },
            permissions: {
                read: ['/workspace/**', '/scratch/**', '/preset/**', '/output.md'],
                write: DEFAULT_MAIN_AGENT_PERMISSIONS.write,
            },
            readSet,
            staged: false,
        });

        // 1. Writer self-dedup updates ctx.readSet on write, append, edit
        const writeRes = JSON.parse(
            await registry.executeToolCallText('write_file', { path: '/workspace/shared/note.md', content: 'line1' }, ctx),
        );
        expect(writeRes.ok).toBe(true);
        expect(readSet.get('/workspace/shared/note.md')).toBe(await hashText('line1'));

        const appendRes = JSON.parse(
            await registry.executeToolCallText('append_file', { path: '/workspace/shared/note.md', content: '\nline2' }, ctx),
        );
        expect(appendRes.ok).toBe(true);
        expect(readSet.get('/workspace/shared/note.md')).toBe(await hashText('line1\nline2'));

        const editRes = JSON.parse(
            await registry.executeToolCallText(
                'edit_file',
                { path: '/workspace/shared/note.md', search: 'line2', replace: 'line2-edited' },
                ctx,
            ),
        );
        expect(editRes.ok).toBe(true);
        expect(readSet.get('/workspace/shared/note.md')).toBe(await hashText('line1\nline2-edited'));

        // 2. Single-file quota enforcement (> 64 KB)
        const oversized = 'a'.repeat(AGENT_WORKSPACE_MAX_FILE_BYTES + 10);
        const oversizedRes = JSON.parse(
            await registry.executeToolCallText('write_file', { path: '/workspace/shared/big.md', content: oversized }, ctx),
        );
        expect(oversizedRes.ok).toBe(false);
        expect(oversizedRes.error).toContain('single-file quota');

        // 3. Total-bytes quota enforcement (> 256 KB)
        const chunk = 'b'.repeat(50 * 1024);
        for (let i = 0; i < 5; ++i) {
            const r = JSON.parse(
                await registry.executeToolCallText('write_file', { path: `/workspace/shared/chunk_${i}.md`, content: chunk }, ctx),
            );
            expect(r.ok).toBe(true);
        }
        const totalExceeded = JSON.parse(
            await registry.executeToolCallText(
                'write_file',
                {
                    path: '/scratch/overflow.md',
                    content: 'c'.repeat(AGENT_WORKSPACE_MAX_TOTAL_BYTES - 5 * 50 * 1024 + 500),
                },
                ctx,
            ),
        );
        expect(totalExceeded.ok).toBe(false);
        expect(totalExceeded.error).toContain('total quota exceeded');

        // 4. File-count quota enforcement (> 32 files)
        const { bridge: b2, store: s2, vfs: vfs2 } = setupEnv();
        const ctx2 = createToolExecutionContext({
            bridge: b2,
            vfs: vfs2,
            store: s2,
            target: { messageId: 1, swipeId: 0 },
            permissions: DEFAULT_MAIN_AGENT_PERMISSIONS,
            readSet: new Map(),
            staged: false,
        });
        for (let i = 0; i < AGENT_WORKSPACE_MAX_FILES; ++i) {
            const r = JSON.parse(
                await registry.executeToolCallText('write_file', { path: `/workspace/shared/f_${i}.md`, content: 'x' }, ctx2),
            );
            expect(r.ok).toBe(true);
        }
        const tooMany = JSON.parse(
            await registry.executeToolCallText('write_file', { path: '/scratch/one_too_many.md', content: 'x' }, ctx2),
        );
        expect(tooMany.ok).toBe(false);
        expect(tooMany.error).toContain(`maximum ${AGENT_WORKSPACE_MAX_FILES} files`);

        // 5. read_file missing-path candidate hints (only suggests readable paths, never hidden ones)
        const hintHit = JSON.parse(
            await registry.executeToolCallText('read_file', { path: '/docs/style.md' }, ctx),
        );
        expect(hintHit.ok).toBe(false);
        expect(hintHit.hint).toContain('/workspace/docs/style.md');

        const hintPreset = JSON.parse(
            await registry.executeToolCallText('read_file', { path: '/docs/preset-guide.md' }, ctx),
        );
        expect(hintPreset.ok).toBe(false);
        expect(hintPreset.hint).toContain('/preset/docs/preset-guide.md');

        const hiddenAttempt = JSON.parse(
            await registry.executeToolCallText('read_file', { path: '/hidden.md' }, ctx),
        );
        expect(hiddenAttempt.ok).toBe(false);
        expect(hiddenAttempt.hint).toBeUndefined();
    });
});
