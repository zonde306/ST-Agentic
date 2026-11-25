import { describe, expect, it } from 'vitest';
import { isUnmodifiedWorldInfoItem } from '@/ui/session/FilesOverridesView';
import type { FileOverrideItem } from '@/ui/store';
import { createMockUIServices } from '@/ui/store/mock-services';

function makeItem(overrides: Partial<FileOverrideItem> = {}): FileOverrideItem {
    return {
        id: 'worldinfo:Book/1',
        category: 'worldinfo',
        namespace: 'worldinfo',
        path: '/lorebooks/Book/entry-1.md',
        key: 'Book/1',
        target: { messageId: 2, swipeId: 1 },
        layerLabel: 'L2#1',
        source: 'lorebook',
        content: 'original content',
        baseContent: 'original content',
        overridden: false,
        writable: true,
        ...overrides,
    };
}

describe('FilesOverridesView worldinfo filtering', () => {
    it('omits unmodified worldinfo items (overridden: false)', () => {
        expect(isUnmodifiedWorldInfoItem(makeItem({ overridden: false }))).toBe(true);
    });

    it('omits worldinfo overrides whose content matches baseContent (ignoring CRLF vs LF)', () => {
        expect(
            isUnmodifiedWorldInfoItem(
                makeItem({
                    overridden: true,
                    content: 'line1\r\nline2',
                    baseContent: 'line1\nline2',
                }),
            ),
        ).toBe(true);
    });

    it('keeps worldinfo overrides that differ from baseContent or lack baseContent', () => {
        expect(
            isUnmodifiedWorldInfoItem(
                makeItem({
                    overridden: true,
                    content: 'updated content',
                    baseContent: 'original content',
                }),
            ),
        ).toBe(false);

        expect(
            isUnmodifiedWorldInfoItem(
                makeItem({
                    overridden: true,
                    content: 'orphan override',
                    baseContent: undefined,
                }),
            ),
        ).toBe(false);
    });

    it('never filters out non-worldinfo categories', () => {
        for (const category of ['variables', 'workspace', 'instructions', 'message'] as const) {
            expect(
                isUnmodifiedWorldInfoItem(
                    makeItem({
                        id: `${category}:1`,
                        category,
                        namespace: category === 'variables' ? 'variables' : 'files',
                        overridden: false,
                        content: 'same',
                        baseContent: 'same',
                    }),
                ),
            ).toBe(false);
        }
    });

    it('omits worldinfo entries from mock listFilesAndOverrides once restored or saved equal to base', async () => {
        const services = createMockUIServices();
        const initial = await services.listFilesAndOverrides();
        const wiItem = initial.find((item) => item.category === 'worldinfo');
        expect(wiItem).toBeDefined();

        // Saving identical content to baseContent causes it to be omitted from the list
        await services.saveFileOrOverride({
            path: wiItem!.path,
            namespace: wiItem!.namespace,
            key: wiItem!.key,
            content: wiItem!.baseContent ?? '',
            target: wiItem!.target,
        });
        const afterIdenticalSave = await services.listFilesAndOverrides();
        expect(afterIdenticalSave.some((item) => item.id === wiItem!.id)).toBe(false);

        // Editing back to differing content restores it to the list
        await services.saveFileOrOverride({
            path: wiItem!.path,
            namespace: wiItem!.namespace,
            key: wiItem!.key,
            content: 'modified worldinfo body',
            target: wiItem!.target,
        });
        const afterDiffSave = await services.listFilesAndOverrides();
        expect(afterDiffSave.some((item) => item.id === wiItem!.id)).toBe(true);

        // Restoring original lorebook removes it from the override list
        await services.deleteFileOrOverride({
            path: wiItem!.path,
            namespace: wiItem!.namespace,
            key: wiItem!.key,
            target: wiItem!.target,
        });
        const afterRestore = await services.listFilesAndOverrides();
        expect(afterRestore.some((item) => item.id === wiItem!.id)).toBe(false);
    });
});
