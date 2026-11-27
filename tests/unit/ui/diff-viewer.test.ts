import { describe, expect, it } from 'vitest';
import {
    annotateDiffRows,
    buildDiffSegments,
    computeDiffStats,
    type DiffViewerLine,
    type DiffViewerSegment,
} from '@/ui/components/DiffViewer';

function ctx(count: number, prefix = 'c'): DiffViewerLine[] {
    return Array.from({ length: count }, (_, i) => ({ type: 'ctx' as const, text: `${prefix}${i}` }));
}

function describeSegments(segments: DiffViewerSegment[]): string[] {
    return segments.map((seg) =>
        seg.kind === 'line'
            ? `${seg.row.type}:${seg.row.text}`
            : `gap:${seg.position}:${seg.hiddenEnd - seg.hiddenStart}`,
    );
}

describe('DiffViewer segment builder', () => {
    const lines: DiffViewerLine[] = [
        ...ctx(10, 'a'),
        { type: 'del', text: 'old' },
        { type: 'add', text: 'new' },
        ...ctx(30, 'b'),
        { type: 'add', text: 'tail-added' },
        ...ctx(8, 'z'),
    ];

    it('annotates old/new line numbers like a unified diff', () => {
        const rows = annotateDiffRows(lines);
        expect(rows[10]).toMatchObject({ type: 'del', oldNo: 11, newNo: null });
        expect(rows[11]).toMatchObject({ type: 'add', oldNo: null, newNo: 11 });
        expect(rows[12]).toMatchObject({ type: 'ctx', oldNo: 12, newNo: 12 });
        expect(rows[42]).toMatchObject({ type: 'add', oldNo: null, newNo: 42 });
    });

    it('computes stats with hunk count', () => {
        expect(computeDiffStats(lines)).toEqual({ added: 2, removed: 1, hunks: 2 });
    });

    it('collapses unchanged runs while keeping 3 lines of context around each change', () => {
        const segments = buildDiffSegments(annotateDiffRows(lines));
        const described = describeSegments(segments);
        expect(described[0]).toBe('gap:top:7');
        expect(described.slice(1, 4)).toEqual(['ctx:a7', 'ctx:a8', 'ctx:a9']);
        expect(described).toContain('gap:middle:24');
        expect(described[described.length - 1]).toBe('gap:bottom:5');
        expect(segments.filter((s) => s.kind === 'line')).toHaveLength(3 + 2 + 3 + 3 + 1 + 3);
    });

    it('keeps short unchanged runs inline instead of collapsing them', () => {
        const short: DiffViewerLine[] = [
            ...ctx(4),
            { type: 'add', text: 'x' },
            ...ctx(5, 'd'),
            { type: 'del', text: 'y' },
        ];
        const described = describeSegments(buildDiffSegments(annotateDiffRows(short)));
        expect(described.some((d) => d.startsWith('gap'))).toBe(false);
    });

    it('reveals lines from the top and bottom of a gap incrementally', () => {
        const rows = annotateDiffRows(lines);
        const middle = buildDiffSegments(rows).find(
            (s) => s.kind === 'gap' && s.position === 'middle',
        );
        expect(middle?.kind).toBe('gap');
        if (middle?.kind !== 'gap') {
            return;
        }
        const partially = buildDiffSegments(rows, {
            reveals: { [middle.gapStart]: { top: 5, bottom: 4 } },
        });
        expect(describeSegments(partially)).toContain('gap:middle:15');

        const fully = buildDiffSegments(rows, {
            reveals: { [middle.gapStart]: { top: 30, bottom: 0 } },
        });
        expect(describeSegments(fully).filter((d) => d.startsWith('gap'))).toEqual([
            'gap:top:7',
            'gap:bottom:5',
        ]);
    });

    it('shows every line when showAll is set or when nothing changed', () => {
        const rows = annotateDiffRows(lines);
        expect(buildDiffSegments(rows, { showAll: true })).toHaveLength(lines.length);
        const unchanged = annotateDiffRows(ctx(50));
        expect(buildDiffSegments(unchanged)).toHaveLength(50);
    });
});
