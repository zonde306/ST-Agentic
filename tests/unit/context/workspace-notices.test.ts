import { describe, expect, it } from 'vitest';
import { buildWorkspaceNotices } from '@/core/context';
import { ChatDataStore } from '@/core/store';
import { hashText } from '@/core/utils';
import { VirtualFileSystem } from '@/core/vfs';
import { MemoryHostBridge } from '../../mocks';

function setupWorkspace(presetFiles: Record<string, string> = {}) {
    const bridge = new MemoryHostBridge();
    bridge.pushMessage({ name: 'User', isUser: true, mes: 'hi' });
    bridge.pushMessage({ name: 'Assistant', isUser: false, mes: 'ok' });
    const store = new ChatDataStore(bridge);
    const vfs = new VirtualFileSystem({
        bridge,
        store,
        getPresetFiles: () => presetFiles,
    });
    return { bridge, store, vfs };
}

describe('buildWorkspaceNotices (Two-Tier Progressive Disclosure & Cross-Agent Awareness)', () => {
    it('implements Tier 1 required-read index notices, Tier 2 stale-only doc updates, and Tier 3 shared summaries', async () => {
        const { vfs } = setupWorkspace({
            'AGENTS.md': '# Preset Index\nSee docs/preset-guide.md when needed.',
            'docs/preset-guide.md': 'Preset guide body',
        });

        await vfs.writeFile('/global/AGENTS.md', '# Global Rules\nBe concise.');
        await vfs.writeFile('/workspace/AGENTS.md', '# Chat Index\nRead docs/style.md when writing prose.');
        await vfs.writeFile('/workspace/docs/style.md', 'Style v1');
        await vfs.writeFile('/workspace/docs/combat.md', 'Combat rules v1 (never read)');
        await vfs.writeFile('/workspace/shared/handoff.md', '# Handoff Note\nKeep tension high in scene 2.', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            source: 'assistant:write_file',
        });

        const readSet = new Map<string, string>();
        const target = { messageId: 1, swipeId: 0 };

        // 1. Initial state: Tier 1 indexes unread, Tier 2 unread docs stay SILENT, Tier 3 shared shows summary
        const first = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/**'], write: ['/output.md'] },
            readSet,
            target,
            staged: false,
            hashText,
        });

        expect(first.unreadIndexPaths).toEqual([
            '/global/AGENTS.md',
            '/preset/AGENTS.md',
            '/workspace/AGENTS.md',
        ]);
        expect(first.staleDocPaths).toEqual([]);
        expect(first.sharedUpdatePaths).toEqual(['/workspace/shared/handoff.md']);

        expect(first.noticeXml).toContain('<workspace-instructions-notice>');
        expect(first.noticeXml).toContain('/global/AGENTS.md');
        expect(first.noticeXml).toContain('/preset/AGENTS.md');
        expect(first.noticeXml).toContain('/workspace/AGENTS.md');
        // Unread Tier 2 docs must NOT be forced into notices
        expect(first.noticeXml).not.toContain('style.md');
        expect(first.noticeXml).not.toContain('combat.md');
        expect(first.noticeXml).not.toContain('preset-guide.md');
        // Tier 3 shows concise summary without dumping arbitrary full body
        expect(first.noticeXml).toContain('<workspace-shared-updates>');
        expect(first.noticeXml).toContain('/workspace/shared/handoff.md');
        expect(first.noticeXml).toContain('Handoff Note');
        expect(first.noticeXml).not.toContain('Keep tension high in scene 2.');

        // 2. Agent reads all 3 indexes + style.md + handoff.md -> next turn is 0-token silent!
        readSet.set('/global/AGENTS.md', await hashText('# Global Rules\nBe concise.'));
        readSet.set('/preset/AGENTS.md', await hashText('# Preset Index\nSee docs/preset-guide.md when needed.'));
        readSet.set('/workspace/AGENTS.md', await hashText('# Chat Index\nRead docs/style.md when writing prose.'));
        readSet.set('/workspace/docs/style.md', await hashText('Style v1'));
        readSet.set('/workspace/shared/handoff.md', await hashText('# Handoff Note\nKeep tension high in scene 2.'));

        const silent = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/**'], write: ['/output.md'] },
            readSet,
            target,
            staged: false,
            hashText,
        });
        expect(silent.noticeXml).toBe('');

        // 3. Modify previously-read style.md, unread combat.md, and /workspace/AGENTS.md
        await vfs.writeFile('/workspace/docs/style.md', 'Style v2 updated');
        await vfs.writeFile('/workspace/docs/combat.md', 'Combat rules v2 updated');
        await vfs.writeFile('/workspace/AGENTS.md', '# Chat Index v2');

        const updated = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/**'], write: ['/output.md'] },
            readSet,
            target,
            staged: false,
            hashText,
        });
        expect(updated.updatedIndexPaths).toEqual(['/workspace/AGENTS.md']);
        expect(updated.staleDocPaths).toEqual(['/workspace/docs/style.md']);
        expect(updated.noticeXml).toContain('<workspace-instructions-notice>');
        expect(updated.noticeXml).toContain('/workspace/AGENTS.md (已更新');
        expect(updated.noticeXml).toContain('<workspace-doc-updates>');
        expect(updated.noticeXml).toContain('/workspace/docs/style.md');
        // Still never notifies for unread combat.md!
        expect(updated.noticeXml).not.toContain('combat.md');

        // 4. Eviction from Read-Set (e.g. after watermark compaction) re-emits Tier 1 index notice
        readSet.delete('/global/AGENTS.md');
        const postEvict = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/**'], write: ['/output.md'] },
            readSet,
            target,
            staged: false,
            hashText,
        });
        expect(postEvict.unreadIndexPaths).toEqual(['/global/AGENTS.md']);
    });

    it('strictly filters notices by agent permissions.read without leaking unreadable files', async () => {
        const { vfs } = setupWorkspace({ 'AGENTS.md': 'Preset secret' });
        await vfs.writeFile('/global/AGENTS.md', 'Global secret');
        await vfs.writeFile('/workspace/AGENTS.md', 'Workspace secret');
        await vfs.writeFile('/workspace/shared/secret-note.md', 'Shared secret', {
            target: { messageId: 1, swipeId: 0 },
            staged: false,
        });

        const narrowVarsOnly = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/state/variables.json'], write: [] },
            readSet: new Map(),
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            hashText,
        });
        expect(narrowVarsOnly.noticeXml).toBe('');
        expect(narrowVarsOnly.unreadIndexPaths).toEqual([]);
        expect(narrowVarsOnly.sharedUpdatePaths).toEqual([]);

        const presetOnly = await buildWorkspaceNotices({
            vfs,
            permissions: { read: ['/preset/**'], write: [] },
            readSet: new Map(),
            target: { messageId: 1, swipeId: 0 },
            staged: false,
            hashText,
        });
        expect(presetOnly.unreadIndexPaths).toEqual(['/preset/AGENTS.md']);
        expect(presetOnly.noticeXml).not.toContain('/workspace/');
        expect(presetOnly.noticeXml).not.toContain('/global/');
    });
});
