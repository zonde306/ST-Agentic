import { describe, expect, it } from 'vitest';
import {
    SideCluesFacade,
    type SideClueVfsLike,
    normalizeSideCluePath,
} from '@/core/sidegen';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { MemoryHostBridge } from '../../mocks';

describe('SideCluesFacade — CRUD, path safety & branch isolation', () => {
    it('normalizes /side/* paths and rejects traversal or paths outside /side/*', () => {
        expect(normalizeSideCluePath('/side/comms/linwan.md')).toEqual({
            path: '/side/comms/linwan.md',
            relKey: 'comms/linwan.md',
        });
        expect(normalizeSideCluePath('rumors/dock.md')).toEqual({
            path: '/side/rumors/dock.md',
            relKey: 'rumors/dock.md',
        });
        expect(normalizeSideCluePath('side/notes/memo.md')).toEqual({
            path: '/side/notes/memo.md',
            relKey: 'notes/memo.md',
        });

        expect(() => normalizeSideCluePath('/workspace/secret.md')).toThrow(/under \/side\/\*/);
        expect(() => normalizeSideCluePath('/side/../secret.md')).toThrow(/\.\./);
        expect(() => normalizeSideCluePath('/side')).toThrow();
        expect(() => normalizeSideCluePath('   ')).toThrow();
    });

    it('supports write, read, list, updateDelivery, updateStatus, delete with canonical frontmatter & xxHash', async () => {
        const bridge = createOffMainlineTestBridge();
        let tick = 1_732_320_000_000;
        const facade = new SideCluesFacade({
            bridge,
            now: () => {
                tick += 1000;
                return tick;
            },
        });

        const docA = await facade.write({
            path: '/side/comms/linwan.md',
            title: '林晚加密通讯',
            delivery: 'radar_hint',
            keywords: ['老码头', '灯塔'],
            summary: '林晚在旧仓库灯塔下接应。',
            body: '- [18:10] 老码头见。',
        });
        const docB = await facade.write({
            path: '/side/rumors/harbor.md',
            title: '雾港走私船暗语',
            delivery: 'vfs_only',
            keywords: ['走私船'],
            summary: '暗语清单',
            body: '三声雾笛代表改期。',
        });

        expect(docA.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect((await facade.list()).map((d) => d.path)).toEqual([
            '/side/comms/linwan.md',
            '/side/rumors/harbor.md',
        ]);

        // updateDelivery changes delivery and refreshes contentHash while preserving body & createdAt
        const updatedDelivery = await facade.updateDelivery(
            '/side/comms/linwan.md',
            'next_turn_brief',
        );
        expect(updatedDelivery?.meta.delivery).toBe('next_turn_brief');
        expect(updatedDelivery?.meta.createdAt).toBe(docA.meta.createdAt);
        expect(updatedDelivery?.meta.updatedAt).toBeGreaterThan(docA.meta.updatedAt);
        expect(updatedDelivery?.body).toBe(docA.body);
        expect(updatedDelivery?.contentHash).not.toBe(docA.contentHash);

        // updateStatus changes status cleanly
        const updatedStatus = await facade.updateStatus('/side/comms/linwan.md', 'surfaced');
        expect(updatedStatus?.meta.status).toBe('surfaced');

        // Missing paths return null / false cleanly
        expect(await facade.updateDelivery('/side/notes/missing.md', 'none')).toBeNull();
        expect(await facade.updateStatus('/side/notes/missing.md', 'resolved')).toBeNull();

        // Delete removes clue
        expect(await facade.delete('/side/rumors/harbor.md')).toBe(true);
        expect(await facade.read(docB.path)).toBeNull();
        expect((await facade.list()).map((d) => d.path)).toEqual(['/side/comms/linwan.md']);
    });

    it('isolates /side/* clues across sibling swipe branches in DATA_NAMESPACES.SIDE_FILES', async () => {
        const bridge = createOffMainlineTestBridge();
        const facade = new SideCluesFacade({ bridge });

        // Clue at base anchor 0#0 visible to both swipes at message 1
        await facade.write({
            path: '/side/notes/shared.md',
            body: '共享祖先线索',
            target: { messageId: 0, swipeId: 0 },
        });

        // Clue at swipe 1#0
        await facade.write({
            path: '/side/comms/branch-a.md',
            body: '分支 A 独有线索',
            target: { messageId: 1, swipeId: 0 },
        });

        // Switch active swipe of message 1 to swipe 1 (1#1)
        bridge.chat[1].swipeId = 1;
        expect(await facade.read('/side/notes/shared.md')).not.toBeNull();
        expect(await facade.read('/side/comms/branch-a.md')).toBeNull();
        expect((await facade.list()).map((d) => d.path)).toEqual(['/side/notes/shared.md']);

        // Switch back to swipe 0 (1#0) -> branch-a resurfaces
        bridge.chat[1].swipeId = 0;
        expect(await facade.read('/side/comms/branch-a.md')).not.toBeNull();
    });

    it('supports an optional injected VFS adapter cleanly', async () => {
        const bridge = createOffMainlineTestBridge();
        const files = new Map<string, string>();
        const mockVfs: SideClueVfsLike = {
            async readFile(path) {
                const content = files.get(path);
                if (content === undefined) {
                    const err = new Error(`File not found: ${path}`);
                    err.name = 'VfsNotFoundError';
                    throw err;
                }
                return content;
            },
            async writeFile(path, content) {
                files.set(path, content);
            },
            async deleteFile(path) {
                return files.delete(path);
            },
            async listFiles() {
                return Array.from(files.keys()).map((path) => ({ path, kind: 'file' as const }));
            },
        };

        const facade = new SideCluesFacade({ bridge, vfs: mockVfs });
        await facade.write({
            path: '/side/notes/via-vfs.md',
            title: 'VFS 适配测试',
            body: '通过注入 VFS 写入',
            keywords: ['适配'],
        });

        expect(files.has('/side/notes/via-vfs.md')).toBe(true);
        const readBack = await facade.read('/side/notes/via-vfs.md');
        expect(readBack?.body).toBe('通过注入 VFS 写入');
        expect((await facade.list()).map((d) => d.path)).toEqual(['/side/notes/via-vfs.md']);
        expect(await facade.delete('/side/notes/via-vfs.md')).toBe(true);
        expect(await facade.list()).toEqual([]);
    });
});

describe('SideCluesFacade — exportToWorldInfo', () => {
    it('exports a /side/* clue to the primary World Info book via HostAuthorBridge and optionally marks resolved', async () => {
        const bridge = createOffMainlineTestBridge();
        const facade = new SideCluesFacade({ bridge });

        await facade.write({
            path: '/side/comms/linwan.md',
            title: '林晚的加密通讯线索',
            delivery: 'radar_hint',
            keywords: ['老码头', '灯塔', '林晚'],
            secondaryKeys: ['门禁卡'],
            order: 88,
            scanDepth: 3,
            summary: '林晚在灯塔下接应。',
            body: '@@system\n林晚确认东区巡逻 21:30 换防，将在旧仓库灯塔下接应。',
        });

        const exported = await facade.exportToWorldInfo('/side/comms/linwan.md', {
            markResolved: true,
        });

        expect(exported).toEqual({
            bookName: '雾港侦探录',
            uid: 8, // fixture book already had uid=7
            comment: '林晚的加密通讯线索',
            cluePath: '/side/comms/linwan.md',
        });

        const book = await bridge.author!.readWorldInfoBook('雾港侦探录');
        const createdEntry = book?.entries.find((e) => e.uid === exported.uid);
        expect(createdEntry).toBeDefined();
        expect(createdEntry?.keys).toEqual(['老码头', '灯塔', '林晚']);
        expect(createdEntry?.keysecondary).toEqual(['门禁卡']);
        expect(createdEntry?.order).toBe(88);
        expect(createdEntry?.selective).toBe(true);
        // Raw content preserved verbatim (no escapeAt)
        expect(createdEntry?.content).toContain('@@system');

        // Clue status marked resolved
        const updatedClue = await facade.read('/side/comms/linwan.md');
        expect(updatedClue?.meta.status).toBe('resolved');
    });

    it('throws clean errors when HostAuthorBridge is unavailable, clue is missing, or no book is bound', async () => {
        // 1. HostAuthorBridge unavailable
        const noAuthorBridge = new MemoryHostBridge({
            enableAuthorBridge: false,
            chat: [{ id: 0, name: 'User', isUser: true, mes: 'Hi', swipeId: 0 }],
        });
        const noAuthorFacade = new SideCluesFacade({ bridge: noAuthorBridge });
        await noAuthorFacade.write({ path: '/side/notes/a.md', body: 'test' });
        await expect(noAuthorFacade.exportToWorldInfo('/side/notes/a.md')).rejects.toThrow(
            /HostAuthorBridge is unavailable/,
        );

        // 2. Clue missing
        const bridgeWithAuthor = createOffMainlineTestBridge();
        const facade = new SideCluesFacade({ bridge: bridgeWithAuthor });
        await expect(facade.exportToWorldInfo('/side/notes/missing.md')).rejects.toThrow(
            /Side clue not found/,
        );

        // 3. No primary world book bound and no explicit bookName
        const unboundBridge = new MemoryHostBridge({
            primaryWorldName: null,
            chat: [{ id: 0, name: 'User', isUser: true, mes: 'Hi', swipeId: 0 }],
        });
        const unboundFacade = new SideCluesFacade({ bridge: unboundBridge });
        await unboundFacade.write({ path: '/side/notes/b.md', body: 'content' });
        await expect(unboundFacade.exportToWorldInfo('/side/notes/b.md')).rejects.toThrow(
            /No target World Info book/,
        );
    });
});
