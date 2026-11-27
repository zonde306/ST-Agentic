import type { ComponentChildren } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { IconArrowDown, IconArrowUp, IconFold, IconUnfold } from './Icons';

export type DiffViewerLineType = 'ctx' | 'add' | 'del';

export interface DiffViewerLine {
    type: DiffViewerLineType;
    text: string;
}

export interface DiffViewerRow extends DiffViewerLine {
    /** 1-based line number in the "before" text (null for added lines). */
    oldNo: number | null;
    /** 1-based line number in the "after" text (null for removed lines). */
    newNo: number | null;
}

export interface DiffViewerGapSegment {
    kind: 'gap';
    /** Index of the first line of the original collapsed run (stable reveal key). */
    gapStart: number;
    /** Exclusive end of the original collapsed run. */
    gapEnd: number;
    /** First still-hidden line index. */
    hiddenStart: number;
    /** Exclusive end of the still-hidden line range. */
    hiddenEnd: number;
    position: 'top' | 'middle' | 'bottom';
}

export type DiffViewerSegment =
    | { kind: 'line'; index: number; row: DiffViewerRow }
    | DiffViewerGapSegment;

export interface DiffGapReveal {
    /** Lines revealed from the top of the gap (expanding downward from the previous hunk). */
    top: number;
    /** Lines revealed from the bottom of the gap (expanding upward from the next hunk). */
    bottom: number;
}

export interface BuildDiffSegmentsOptions {
    contextLines?: number;
    /** Unchanged runs shorter than this are always shown inline instead of collapsed. */
    minCollapsedLines?: number;
    showAll?: boolean;
    reveals?: Readonly<Record<number, DiffGapReveal>>;
}

export interface DiffViewerStats {
    added: number;
    removed: number;
    hunks: number;
}

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MIN_COLLAPSED_LINES = 3;
const DEFAULT_EXPAND_STEP = 20;

/** Annotate raw diff lines with GitHub-style old/new line numbers. */
export function annotateDiffRows(lines: readonly DiffViewerLine[]): DiffViewerRow[] {
    let oldNo = 0;
    let newNo = 0;
    return lines.map((line) => {
        if (line.type === 'add') {
            newNo += 1;
            return { type: line.type, text: line.text, oldNo: null, newNo };
        }
        if (line.type === 'del') {
            oldNo += 1;
            return { type: line.type, text: line.text, oldNo, newNo: null };
        }
        oldNo += 1;
        newNo += 1;
        return { type: line.type, text: line.text, oldNo, newNo };
    });
}

export function computeDiffStats(lines: readonly DiffViewerLine[]): DiffViewerStats {
    let added = 0;
    let removed = 0;
    let hunks = 0;
    let inHunk = false;
    for (const line of lines) {
        if (line.type === 'ctx') {
            inHunk = false;
            continue;
        }
        if (line.type === 'add') {
            added += 1;
        } else {
            removed += 1;
        }
        if (!inHunk) {
            hunks += 1;
            inHunk = true;
        }
    }
    return { added, removed, hunks };
}

/**
 * Split annotated rows into visible lines and collapsed "unchanged" gaps, mirroring
 * GitHub's hunk view: every change keeps `contextLines` of surrounding context, and
 * the remaining unchanged runs collapse into expandable gap rows.
 */
export function buildDiffSegments(
    rows: readonly DiffViewerRow[],
    options: BuildDiffSegmentsOptions = {},
): DiffViewerSegment[] {
    const n = rows.length;
    const contextLines = Math.max(0, options.contextLines ?? DEFAULT_CONTEXT_LINES);
    const minCollapsed = Math.max(1, options.minCollapsedLines ?? DEFAULT_MIN_COLLAPSED_LINES);
    const reveals = options.reveals ?? {};
    const hasChanges = rows.some((row) => row.type !== 'ctx');

    if (options.showAll || !hasChanges) {
        return rows.map((row, index) => ({ kind: 'line', index, row }));
    }

    const visible = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
        if (rows[i].type === 'ctx') {
            continue;
        }
        const from = Math.max(0, i - contextLines);
        const to = Math.min(n - 1, i + contextLines);
        for (let k = from; k <= to; k += 1) {
            visible[k] = 1;
        }
    }

    const segments: DiffViewerSegment[] = [];
    let i = 0;
    while (i < n) {
        if (visible[i]) {
            segments.push({ kind: 'line', index: i, row: rows[i] });
            i += 1;
            continue;
        }
        let j = i;
        while (j < n && !visible[j]) {
            j += 1;
        }
        const runLength = j - i;
        if (runLength < minCollapsed) {
            for (let k = i; k < j; k += 1) {
                segments.push({ kind: 'line', index: k, row: rows[k] });
            }
            i = j;
            continue;
        }

        const reveal = reveals[i] ?? { top: 0, bottom: 0 };
        const top = Math.max(0, Math.min(runLength, reveal.top));
        const bottom = Math.max(0, Math.min(runLength - top, reveal.bottom));
        const hiddenStart = i + top;
        const hiddenEnd = j - bottom;

        for (let k = i; k < hiddenStart; k += 1) {
            segments.push({ kind: 'line', index: k, row: rows[k] });
        }
        if (hiddenStart < hiddenEnd) {
            segments.push({
                kind: 'gap',
                gapStart: i,
                gapEnd: j,
                hiddenStart,
                hiddenEnd,
                position: i === 0 ? 'top' : j === n ? 'bottom' : 'middle',
            });
        }
        for (let k = hiddenEnd; k < j; k += 1) {
            segments.push({ kind: 'line', index: k, row: rows[k] });
        }
        i = j;
    }
    return segments;
}

export interface DiffViewerProps {
    lines: readonly DiffViewerLine[];
    /** Unchanged lines kept around each change while collapsed (default 3). */
    contextLines?: number;
    /** Lines revealed per click on an expand-up / expand-down button (default 20). */
    expandStep?: number;
    /** Custom renderer for line text (e.g. redaction highlighting). */
    renderText?: (text: string) => ComponentChildren;
    /** Rendered instead of the diff body when there are no added / removed lines. */
    emptyText?: ComponentChildren;
    /** Show the stats + collapse toggle toolbar (default true). */
    showToolbar?: boolean;
    /** Extra content placed at the right side of the toolbar. */
    toolbarExtra?: ComponentChildren;
    /** Optional max height of the scrollable body (e.g. `'360px'`). */
    maxHeight?: string;
    /** Start with every unchanged line expanded. */
    defaultShowAll?: boolean;
    class?: string;
}

interface RevealState {
    source: readonly DiffViewerLine[];
    reveals: Record<number, DiffGapReveal>;
}

const STAT_BLOCKS = 5;

function StatBlocks({ added, removed }: { added: number; removed: number }) {
    const total = added + removed;
    let addBlocks = total > 0 ? Math.round((added / total) * STAT_BLOCKS) : 0;
    let delBlocks = total > 0 ? Math.round((removed / total) * STAT_BLOCKS) : 0;
    if (added > 0 && addBlocks === 0) {
        addBlocks = 1;
    }
    if (removed > 0 && delBlocks === 0) {
        delBlocks = 1;
    }
    while (addBlocks + delBlocks > STAT_BLOCKS) {
        if (addBlocks >= delBlocks) {
            addBlocks -= 1;
        } else {
            delBlocks -= 1;
        }
    }
    const cells: string[] = [];
    for (let k = 0; k < STAT_BLOCKS; k += 1) {
        cells.push(k < addBlocks ? 'add' : k < addBlocks + delBlocks ? 'del' : 'neutral');
    }
    return (
        <span class="ag-diffv-statbar" aria-hidden="true">
            {cells.map((tone, k) => (
                <span key={k} class={`ag-diffv-statbar-cell ag-diffv-statbar-${tone}`} />
            ))}
        </span>
    );
}

interface ExpandButtonProps {
    direction: 'up' | 'down' | 'all';
    label: string;
    onClick: () => void;
}

function ExpandButton({ direction, label, onClick }: ExpandButtonProps) {
    return (
        <button
            type="button"
            class="ag-diffv-expand-btn"
            title={label}
            aria-label={label}
            data-diff-expand={direction}
            onClick={onClick}
        >
            {direction === 'up' ? (
                <IconArrowUp size={13} />
            ) : direction === 'down' ? (
                <IconArrowDown size={13} />
            ) : (
                <IconUnfold size={13} />
            )}
        </button>
    );
}

/**
 * GitHub-style unified diff viewer: line-number gutters, collapsible unchanged
 * regions with incremental expand-up / expand-down controls, and a toolbar
 * toggle between "changes only" and the full file.
 */
export function DiffViewer({
    lines,
    contextLines = DEFAULT_CONTEXT_LINES,
    expandStep = DEFAULT_EXPAND_STEP,
    renderText,
    emptyText,
    showToolbar = true,
    toolbarExtra,
    maxHeight,
    defaultShowAll = false,
    class: className,
}: DiffViewerProps) {
    const [showAll, setShowAll] = useState<boolean>(defaultShowAll);
    const [revealState, setRevealState] = useState<RevealState>({ source: lines, reveals: {} });
    // Derived reset: a new `lines` array (new revision / new file) discards stale gap reveals.
    const reveals = revealState.source === lines ? revealState.reveals : {};

    const rows = useMemo(() => annotateDiffRows(lines), [lines]);
    const stats = useMemo(() => computeDiffStats(lines), [lines]);
    const hasChanges = stats.added + stats.removed > 0;

    const hasCollapsible = useMemo(
        () => buildDiffSegments(rows, { contextLines }).some((seg) => seg.kind === 'gap'),
        [rows, contextLines],
    );

    const segments = useMemo(
        () => buildDiffSegments(rows, { contextLines, showAll, reveals }),
        [rows, contextLines, showAll, reveals],
    );

    const numDigits = useMemo(() => {
        let maxLineNo = 1;
        for (const row of rows) {
            maxLineNo = Math.max(maxLineNo, row.oldNo ?? 0, row.newNo ?? 0);
        }
        return Math.max(2, String(maxLineNo).length);
    }, [rows]);

    const updateReveal = (gapStart: number, patch: (prev: DiffGapReveal) => DiffGapReveal) => {
        setRevealState((prev) => {
            const base = prev.source === lines ? prev.reveals : {};
            const current = base[gapStart] ?? { top: 0, bottom: 0 };
            return { source: lines, reveals: { ...base, [gapStart]: patch(current) } };
        });
    };

    const expandDown = (gapStart: number, count: number) =>
        updateReveal(gapStart, (prev) => ({ ...prev, top: prev.top + count }));
    const expandUp = (gapStart: number, count: number) =>
        updateReveal(gapStart, (prev) => ({ ...prev, bottom: prev.bottom + count }));

    const renderLine = (row: DiffViewerRow, index: number) => {
        const sign = row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' ';
        return (
            <div
                key={`l-${index}`}
                class={`ag-diffv-row ag-diffv-row-${row.type}`}
                data-diff-line={row.type}
            >
                <span class="ag-diffv-num ag-diffv-num-old">{row.oldNo ?? ''}</span>
                <span class="ag-diffv-num ag-diffv-num-new">{row.newNo ?? ''}</span>
                <span class="ag-diffv-sign" aria-hidden="true">{sign}</span>
                <span class="ag-diffv-code">
                    {row.text ? (renderText ? renderText(row.text) : row.text) : ' '}
                </span>
            </div>
        );
    };

    const renderGap = (seg: DiffViewerGapSegment) => {
        const hidden = seg.hiddenEnd - seg.hiddenStart;
        const firstHidden = rows[seg.hiddenStart];
        const lastHidden = rows[seg.hiddenEnd - 1];
        const rangeLabel = firstHidden && lastHidden
            ? `${firstHidden.newNo ?? firstHidden.oldNo}-${lastHidden.newNo ?? lastHidden.oldNo}`
            : '';
        const small = hidden <= expandStep;
        const allLabel = `展开全部 ${hidden} 行`;
        const upLabel = `向上展开 ${expandStep} 行`;
        const downLabel = `向下展开 ${expandStep} 行`;
        const expandAll = () => expandDown(seg.gapStart, hidden);

        let buttons: ComponentChildren;
        if (seg.position === 'top') {
            buttons = (
                <ExpandButton
                    direction="up"
                    label={small ? allLabel : upLabel}
                    onClick={() => expandUp(seg.gapStart, small ? hidden : expandStep)}
                />
            );
        } else if (seg.position === 'bottom') {
            buttons = (
                <ExpandButton
                    direction="down"
                    label={small ? allLabel : downLabel}
                    onClick={() => expandDown(seg.gapStart, small ? hidden : expandStep)}
                />
            );
        } else if (small) {
            buttons = <ExpandButton direction="all" label={allLabel} onClick={expandAll} />;
        } else {
            buttons = (
                <>
                    <ExpandButton
                        direction="down"
                        label={downLabel}
                        onClick={() => expandDown(seg.gapStart, expandStep)}
                    />
                    <ExpandButton
                        direction="up"
                        label={upLabel}
                        onClick={() => expandUp(seg.gapStart, expandStep)}
                    />
                </>
            );
        }

        return (
            <div
                key={`g-${seg.gapStart}`}
                class="ag-diffv-gap"
                data-diff-gap={String(hidden)}
                data-diff-gap-position={seg.position}
            >
                <span class="ag-diffv-gap-actions">{buttons}</span>
                <button
                    type="button"
                    class="ag-diffv-gap-label"
                    title={allLabel}
                    onClick={expandAll}
                >
                    <span class="ag-diffv-gap-dots" aria-hidden="true">···</span>
                    <span>{hidden} 行未更改</span>
                    {rangeLabel ? (
                        <span class="ag-diffv-gap-range">第 {rangeLabel} 行</span>
                    ) : null}
                </button>
            </div>
        );
    };

    const rootClass = className ? `ag-diffv ${className}` : 'ag-diffv';
    const rootStyle = { '--ag-diffv-num-w': `calc(${numDigits}ch + 12px)` } as Record<
        string,
        string
    >;

    return (
        <div class={rootClass} style={rootStyle} data-diff-viewer="true">
            {showToolbar ? (
                <div class="ag-diffv-toolbar">
                    <div class="ag-diffv-stats">
                        <span class="ag-diffv-stat-add">+{stats.added}</span>
                        <span class="ag-diffv-stat-del">-{stats.removed}</span>
                        <StatBlocks added={stats.added} removed={stats.removed} />
                        {stats.hunks > 0 ? (
                            <span class="ag-diffv-stat-hunks">{stats.hunks} 处更改</span>
                        ) : null}
                    </div>
                    <div class="ag-diffv-toolbar-actions">
                        {toolbarExtra}
                        {hasChanges && hasCollapsible ? (
                            <button
                                type="button"
                                class="ag-diffv-toggle"
                                aria-pressed={showAll}
                                data-diff-toggle-all="true"
                                title={showAll ? '折叠未更改的行，只显示更改及上下文' : '展开所有未更改的行'}
                                onClick={() => {
                                    setShowAll((prev) => !prev);
                                    setRevealState({ source: lines, reveals: {} });
                                }}
                            >
                                {showAll ? <IconFold size={12} /> : <IconUnfold size={12} />}
                                <span>{showAll ? '仅看更改' : '展开全部'}</span>
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {!hasChanges && emptyText !== undefined ? (
                <div class="ag-diffv-empty">{emptyText}</div>
            ) : (
                <div
                    class="ag-diffv-body ag-thin-scroll"
                    style={maxHeight ? { maxHeight } : undefined}
                >
                    {segments.map((seg) =>
                        seg.kind === 'line' ? renderLine(seg.row, seg.index) : renderGap(seg),
                    )}
                </div>
            )}
        </div>
    );
}
