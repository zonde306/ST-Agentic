import { describe, expect, it } from 'vitest';
import {
    ChatDataStore,
    DATA_NAMESPACES,
    DataCompactor,
    NAMESPACE_POLICY,
    isCompactableNamespace,
    isLayeredNamespace,
} from '@/core/store';
import { hashText } from '@/core/utils';
import {
    SIDE_MOUNT,
    SIDE_SUBDIRS,
    SideMount,
    VfsError,
    VfsInvalidPathError,
    VfsNotFoundError,
    VirtualFileSystem,
} from '@/core/vfs';
import {
    SAMPLE_ISOLATED_NOTE_RAW,
    SAMPLE_LINWAN_COMMS_RAW,
    SAMPLE_NEXT_TURN_BRIEF_RAW,
    SAMPLE_VFS_ONLY_RUMOR_RAW,
    createOffMainlineTestBridge,
} from '../../fixtures/off-mainline-fixtures';
import { MemoryHostBridge } from '../../mocks';

function createBranchingBridge(): MemoryHostBridge {
    const bridge = createOffMainlineTestBridge();
    // Message 1 gets two swipes so we can verify causal branch isolation.
    const msg1 = bridge.chat[1];
    msg1.swipes = [msg1.mes, '另一条时间线：林晚没有出现在灯塔。'];
    msg1.swipeInfo = [{}, {}];
    bridge.pushMessage({
        name: '调查员',
        isUser: true,
        mes: '继续向旧仓库推进。',
        swipes: ['继续向旧仓库推进。'],
        swipeInfo: [{}],
    });
    return bridge;
}

describe('DATA_NAMESPACES.SIDE_FILES & SideMount (/side/*)', () => {
    it('registers side-files as a layered and compactable namespace in ChatDataStore', () => {
        expect(DATA_NAMESPACES.SIDE_FILES).toBe('side-files');
        expect(NAMESPACE_POLICY['side-files']).toEqual({ layered: true });
        expect(isLayeredNamespace(DATA_NAMESPACES.SIDE_FILES)).toBe(true);
        expect(isCompactableNamespace(DATA_NAMESPACES.SIDE_FILES)).toBe(true);
    });

    it('mounts /side in VirtualFileSystem with standard subdirs and supports full CRUD, glob, grep, and BM25 search', async () => {
        const bridge = createBranchingBridge();
        const vfs = new VirtualFileSystem({ bridge });

        const rootEntries = await vfs.listDir('/');
        expect(rootEntries.map((e) => e.name)).toContain(SIDE_MOUNT);

        const sideStat = await vfs.stat('/side');
        expect(sideStat).toMatchObject({
            path: '/side',
            name: 'side',
            kind: 'directory',
            writable: true,
            mount: 'side',
        });

        // Standard subdirs are advertised even before clues are written
        const sideDirEntries = await vfs.listDir('/side');
        expect(sideDirEntries.map((e) => e.name)).toEqual([...SIDE_SUBDIRS].sort());
        expect(await vfs.stat('/side/comms')).toMatchObject({ kind: 'directory', path: '/side/comms' });
        expect(await vfs.listDir('/side/comms')).toEqual([]);

        // Write clues across /side/comms/*, /side/rumors/*, /side/notes/*
        await vfs.writeFile('/side/comms/linwan.md', SAMPLE_LINWAN_COMMS_RAW);
        await vfs.writeFile('/side/rumors/harbor.md', SAMPLE_VFS_ONLY_RUMOR_RAW);
        await vfs.writeFile('/side/notes/dock-brief.md', SAMPLE_NEXT_TURN_BRIEF_RAW);
        await vfs.writeFile('/side/notes/private.md', SAMPLE_ISOLATED_NOTE_RAW);

        expect(await vfs.exists('/side/comms/linwan.md')).toBe(true);
        expect(await vfs.readFile('/side/comms/linwan.md')).toBe(SAMPLE_LINWAN_COMMS_RAW);
        expect(await vfs.readFile('/side/comms/linwan.md', { startLine: 1, endLine: 3 })).toBe(
            '---\nid: clue_linwan_comms\ntitle: 林晚的加密通讯线索',
        );

        // Append & edit
        await vfs.appendFile('/side/comms/linwan.md', '\n- [18:15 林晚]: 补充：北门摄像头已失灵。');
        expect(await vfs.readFile('/side/comms/linwan.md')).toContain('北门摄像头已失灵');

        const editRes = await vfs.editFile(
            '/side/comms/linwan.md',
            '北门摄像头已失灵',
            '北门红外与摄像头均已失灵',
        );
        expect(editRes.ok).toBe(true);
        expect(await vfs.readFile('/side/comms/linwan.md')).toContain('北门红外与摄像头均已失灵');

        // Glob across /side/**
        const allSideFiles = await vfs.globFiles('/side/**/*.md');
        expect(allSideFiles).toEqual([
            '/side/comms/linwan.md',
            '/side/notes/dock-brief.md',
            '/side/notes/private.md',
            '/side/rumors/harbor.md',
        ]);
        expect(await vfs.globFiles('/side/comms/*')).toEqual(['/side/comms/linwan.md']);

        // Grep search scoped to /side
        const grepHits = await vfs.grepSearch('三声雾笛', { pathPrefix: '/side' });
        expect(grepHits).toHaveLength(1);
        expect(grepHits[0].path).toBe('/side/rumors/harbor.md');

        // BM25 searchFiles boosted by Frontmatter title & keywords
        const searchHits = await vfs.searchFiles('走私船', { pathPrefix: '/side' });
        expect(searchHits.length).toBeGreaterThanOrEqual(1);
        expect(searchHits[0].path).toBe('/side/rumors/harbor.md');
        expect(searchHits[0].title).toBe('雾港走私船暗语备忘');

        // Delete removes file cleanly
        expect(await vfs.deleteFile('/side/notes/private.md')).toBe(true);
        expect(await vfs.exists('/side/notes/private.md')).toBe(false);
        await expect(vfs.readFile('/side/notes/private.md')).rejects.toBeInstanceOf(VfsNotFoundError);

        // Directory & traversal errors
        await expect(vfs.readFile('/side/comms')).rejects.toBeInstanceOf(VfsError);
        await expect(vfs.writeFile('/side/comms', 'illegal')).rejects.toBeInstanceOf(VfsError);
        await expect(vfs.readFile('/side/../secret.md')).rejects.toBeInstanceOf(VfsInvalidPathError);

        const mount = new SideMount(vfs.store);
        await expect(mount.readSideClue('/workspace/outside.md')).rejects.toBeInstanceOf(VfsInvalidPathError);
    });

    it('enforces causal (messageId, swipeId) branch isolation, tombstones, staging, and cold compaction', async () => {
        const bridge = createBranchingBridge();
        const vfs = new VirtualFileSystem({ bridge });

        // Base clue at message 0#0 propagates forward to later turns on both swipe 0 and swipe 1
        await vfs.writeSideClue(
            {
                path: '/side/rumors/shared.md',
                title: '共有流言',
                delivery: 'radar_hint',
                keywords: ['雾港'],
                summary: '开局已存在的共有流言。',
                body: '开局流言正文。',
            },
            { target: { messageId: 0, swipeId: 0 } },
        );

        // Branch-specific clue written ONLY on swipe 0 of message 1
        await vfs.writeSideClue(
            {
                path: '/side/comms/linwan.md',
                title: '时间线 A 通讯',
                delivery: 'radar_hint',
                keywords: ['老码头'],
                summary: '仅存在于 swipe 0 的加密联络。',
                body: '时间线 A 正文。',
            },
            { target: { messageId: 1, swipeId: 0 } },
        );

        // Different clue content on swipe 1 of message 1
        await vfs.writeSideClue(
            {
                path: '/side/notes/alt-branch.md',
                title: '时间线 B 备忘',
                delivery: 'vfs_only',
                keywords: ['失联'],
                summary: '仅存在于 swipe 1 的分支备忘。',
                body: '时间线 B 正文。',
            },
            { target: { messageId: 1, swipeId: 1 } },
        );

        // Delete shared rumor ONLY on swipe 1
        await vfs.deleteFile('/side/rumors/shared.md', { target: { messageId: 1, swipeId: 1 } });

        // Inspect swipe 0 at message 1: sees shared + linwan, NOT alt-branch
        const cluesSwipe0 = await vfs.listSideClues({ messageId: 1, swipeId: 0 });
        expect(cluesSwipe0.map((c) => c.path)).toEqual([
            '/side/comms/linwan.md',
            '/side/rumors/shared.md',
        ]);

        // Inspect swipe 1 at message 1: sees alt-branch only (shared tombstoned, linwan absent)
        const cluesSwipe1 = await vfs.listSideClues({ messageId: 1, swipeId: 1 });
        expect(cluesSwipe1.map((c) => c.path)).toEqual(['/side/notes/alt-branch.md']);

        // Forward propagation: message 2 inherits active swipe of message 1 (currently swipe 0)
        expect((await vfs.readSideClue('/side/comms/linwan.md', { messageId: 2, swipeId: 0 }))?.meta.title).toBe(
            '时间线 A 通讯',
        );
        expect(await vfs.readSideClue('/side/notes/alt-branch.md', { messageId: 2, swipeId: 0 })).toBeNull();

        // Switching message 1 active swipe to 1 flips what message 2 sees automatically!
        bridge.chat[1].swipeId = 1;
        expect(await vfs.readSideClue('/side/comms/linwan.md', { messageId: 2, swipeId: 0 })).toBeNull();
        expect(await vfs.readSideClue('/side/rumors/shared.md', { messageId: 2, swipeId: 0 })).toBeNull();
        expect((await vfs.readSideClue('/side/notes/alt-branch.md', { messageId: 2, swipeId: 0 }))?.meta.title).toBe(
            '时间线 B 备忘',
        );

        // Staged writes remain invisible to committed reads until commitStagedData
        await vfs.writeFile('/side/notes/staged.md', '暂存线索', {
            target: { messageId: 2, swipeId: 0 },
            staged: true,
        });
        expect(await vfs.exists('/side/notes/staged.md', { target: { messageId: 2, swipeId: 0 } })).toBe(true);
        expect(
            await vfs.exists('/side/notes/staged.md', { target: { messageId: 2, swipeId: 0 }, staged: false }),
        ).toBe(false);

        vfs.store.commitStagedData({ messageId: 2, swipeId: 0 });
        expect(
            await vfs.exists('/side/notes/staged.md', { target: { messageId: 2, swipeId: 0 }, staged: false }),
        ).toBe(true);

        // Cold compaction flattens cold side-files along active swipe chain (msg 1 swipe 1) into base
        const compactor = new DataCompactor(bridge);
        const report = compactor.compactColdLayers({ keepDepth: 1 });
        expect(report.flattenedEntries).toBeGreaterThanOrEqual(2);

        // Post-compaction reads still reflect active branch state (alt-branch present, shared tombstoned)
        expect((await vfs.readSideClue('/side/notes/alt-branch.md', { messageId: 2, swipeId: 0 }))?.meta.title).toBe(
            '时间线 B 备忘',
        );
        expect(await vfs.readSideClue('/side/rumors/shared.md', { messageId: 2, swipeId: 0 })).toBeNull();
        expect(await vfs.readSideClue('/side/comms/linwan.md', { messageId: 2, swipeId: 0 })).toBeNull();
    });

    it('roundtrips SideClueDoc codec, preserves createdAt on metadata patch, and aligns contentHash with readFile', async () => {
        const bridge = createBranchingBridge();
        const store = new ChatDataStore(bridge);
        const vfs = new VirtualFileSystem({ bridge, store });

        const written = await vfs.writeSideClue(
            {
                path: '/side/comms/linwan.md',
                id: 'clue_linwan_comms',
                title: '林晚的加密通讯线索',
                delivery: 'next_turn_brief',
                status: 'dormant',
                keywords: ['老码头', '灯塔'],
                secondaryKeys: ['门禁卡'],
                scanDepth: 3,
                order: 120,
                summary: '林晚已在旧仓库灯塔下接应。',
                sourceSessionId: 'phone:linwan',
                body: '- [18:10 User]: 今晚十点见。\n- [18:11 林晚]: 收到。',
            },
            { target: { messageId: 1, swipeId: 0 } },
        );

        const rawText = await vfs.readFile('/side/comms/linwan.md', { target: { messageId: 1, swipeId: 0 } });
        const rawHash = await hashText(rawText);
        expect(written.contentHash).toBe(rawHash);
        expect(written.meta.anchor).toBe('1#0');

        const readBack = await vfs.readSideClue('/side/comms/linwan.md', { target: { messageId: 1, swipeId: 0 } });
        expect(readBack).toEqual(written);

        // Filter listSideClues by subdir / delivery / status
        expect(
            (await vfs.listSideClues({ target: { messageId: 1, swipeId: 0 }, subdir: 'comms' })).map((c) => c.path),
        ).toEqual(['/side/comms/linwan.md']);
        expect(
            (await vfs.listSideClues({ target: { messageId: 1, swipeId: 0 }, subdir: 'rumors' })),
        ).toEqual([]);
        expect(
            (await vfs.listSideClues({ target: { messageId: 1, swipeId: 0 }, delivery: 'next_turn_brief' })),
        ).toHaveLength(1);

        // markSideCluesConsumed transitions dormant -> surfaced and stamps consumedByTurn while preserving body
        const consumed = await vfs.markSideCluesConsumed(['/side/comms/linwan.md'], 5, {
            target: { messageId: 1, swipeId: 0 },
        });
        expect(consumed).toHaveLength(1);
        expect(consumed[0].meta.status).toBe('surfaced');
        expect(consumed[0].meta.consumedByTurn).toBe(5);
        expect(consumed[0].meta.createdAt).toBe(written.meta.createdAt);
        expect(consumed[0].body).toBe(written.body);
        expect(consumed[0].contentHash).not.toBe(written.contentHash);
    });
});
