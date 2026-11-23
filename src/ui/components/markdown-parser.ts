export type MarkdownTableAlign = 'left' | 'center' | 'right' | null;

export type MarkdownInlineNode =
    | { type: 'text'; text: string }
    | { type: 'code'; code: string }
    | { type: 'strong'; children: MarkdownInlineNode[] }
    | { type: 'em'; children: MarkdownInlineNode[] }
    | { type: 'del'; children: MarkdownInlineNode[] }
    | { type: 'link'; href: string; title?: string; children: MarkdownInlineNode[] }
    | { type: 'image'; src: string; alt: string; title?: string }
    | { type: 'redacted' }
    | { type: 'break' };

export interface MarkdownListItem {
    checked?: boolean;
    blocks: MarkdownBlockNode[];
}

export type MarkdownBlockNode =
    | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: MarkdownInlineNode[] }
    | { type: 'paragraph'; children: MarkdownInlineNode[] }
    | { type: 'code_block'; lang?: string; code: string }
    | { type: 'blockquote'; blocks: MarkdownBlockNode[] }
    | { type: 'list'; ordered: boolean; start: number; items: MarkdownListItem[] }
    | {
        type: 'table';
        headers: MarkdownInlineNode[][];
        aligns: MarkdownTableAlign[];
        rows: MarkdownInlineNode[][][];
    }
    | { type: 'hr' };

const MAX_BLOCK_DEPTH = 16;
const MAX_INLINE_DEPTH = 8;
const REDACTED_MARKER = '***REDACTED***';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;
const ESCAPABLE_PUNCT_RE = /^[\\`*{}[\]()#+\-.!|>~<]$/;
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const UNORDERED_MARKER_RE = /^([-*+])(?:[ \t]+(.*)|[ \t]*)$/;
const ORDERED_MARKER_RE = /^(\d{1,9})([.)])(?:[ \t]+(.*)|[ \t]*)$/;
const TASK_PREFIX_RE = /^\[([ xX])\](?:[ \t]+(.*)|[ \t]*)$/;
const TABLE_DELIM_CELL_RE = /^:?-{1,}:?$/;
const BR_TAG_RE = /^<br\s*\/?>/i;
const ANGLE_AUTOLINK_RE = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;
const BARE_URL_RE = /^https?:\/\/[^\s<>，。；：！？）】』」》”’]+/i;
const TRAILING_URL_PUNCT_RE = /[.,;:!?。，；：！？）】』」'"”’]+$/;

/** Sanitize link URLs: allow only http(s) and mailto schemes. */
export function sanitizeMarkdownUrl(raw: string): string | null {
    const cleaned = raw.replace(CONTROL_CHARS_RE, '').trim();
    if (!cleaned) {
        return null;
    }
    if (/^https?:\/\/[^\s/]+/i.test(cleaned)) {
        return cleaned;
    }
    if (/^mailto:[^\s]+/i.test(cleaned)) {
        return cleaned;
    }
    return null;
}

/** Sanitize image URLs: allow http(s) or raster data:image/*;base64 (reject SVG and scripts). */
export function sanitizeMarkdownImageUrl(raw: string): string | null {
    const cleaned = raw.replace(CONTROL_CHARS_RE, '').trim();
    if (!cleaned) {
        return null;
    }
    if (/^https?:\/\/[^\s/]+/i.test(cleaned)) {
        return cleaned;
    }
    if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/i.test(cleaned)) {
        return cleaned;
    }
    return null;
}

function measureIndent(line: string): { indent: number; restIndex: number } {
    let indent = 0;
    let idx = 0;
    while (idx < line.length) {
        const ch = line[idx];
        if (ch === ' ') {
            indent += 1;
            idx += 1;
        } else if (ch === '\t') {
            indent += 4 - (indent % 4);
            idx += 1;
        } else {
            break;
        }
    }
    return { indent, restIndex: idx };
}

function stripIndent(line: string, targetColumns: number): string {
    if (targetColumns <= 0 || !line) {
        return line;
    }
    let cols = 0;
    let idx = 0;
    while (idx < line.length && cols < targetColumns) {
        const ch = line[idx];
        if (ch === ' ') {
            cols += 1;
            idx += 1;
        } else if (ch === '\t') {
            const tabStop = 4 - (cols % 4);
            if (cols + tabStop > targetColumns) {
                const remaining = cols + tabStop - targetColumns;
                return ' '.repeat(remaining) + line.slice(idx + 1);
            }
            cols += tabStop;
            idx += 1;
        } else {
            break;
        }
    }
    return line.slice(idx);
}

interface FenceMatch {
    char: '`' | '~';
    length: number;
    lang?: string;
}

function matchFenceOpen(line: string): FenceMatch | null {
    const match = FENCE_OPEN_RE.exec(line);
    if (!match) {
        return null;
    }
    const fence = match[1];
    const fenceChar = fence[0] as '`' | '~';
    const info = match[2] ?? '';
    if (fenceChar === '`' && info.includes('`')) {
        return null;
    }
    const trimmedInfo = info.trim();
    const langMatch = /^([^\s]+)/.exec(trimmedInfo);
    return {
        char: fenceChar,
        length: fence.length,
        ...(langMatch ? { lang: langMatch[1] } : {}),
    };
}

function isFenceClose(line: string, fenceChar: '`' | '~', fenceLen: number): boolean {
    const { indent, restIndex } = measureIndent(line);
    if (indent > 3) {
        return false;
    }
    let count = 0;
    let idx = restIndex;
    while (idx < line.length && line[idx] === fenceChar) {
        count += 1;
        idx += 1;
    }
    if (count < fenceLen) {
        return false;
    }
    while (idx < line.length) {
        if (line[idx] !== ' ' && line[idx] !== '\t') {
            return false;
        }
        idx += 1;
    }
    return true;
}

function matchHeading(
    line: string,
): { level: 1 | 2 | 3 | 4 | 5 | 6; text: string } | null {
    const match = ATX_HEADING_RE.exec(line);
    if (!match) {
        return null;
    }
    const level = match[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    const rawText = (match[2] ?? '').trimEnd();
    const text = rawText.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
    return { level, text };
}

function isThematicBreak(line: string): boolean {
    return HR_RE.test(line);
}

function findTablePipes(trimmed: string): number[] {
    const pipes: number[] = [];
    let i = 0;
    const len = trimmed.length;
    while (i < len) {
        const ch = trimmed[i];
        if (ch === '\\' && i + 1 < len) {
            i += 2;
            continue;
        }
        if (ch === '`') {
            let ticks = 0;
            while (i + ticks < len && trimmed[i + ticks] === '`') {
                ticks += 1;
            }
            let j = i + ticks;
            let closed = -1;
            while (j < len) {
                if (trimmed[j] === '`') {
                    let run = 0;
                    while (j + run < len && trimmed[j + run] === '`') {
                        run += 1;
                    }
                    if (run === ticks) {
                        closed = j + run;
                        break;
                    }
                    j += run;
                } else {
                    j += 1;
                }
            }
            i = closed !== -1 ? closed : i + ticks;
            continue;
        }
        if (ch === '|') {
            pipes.push(i);
        }
        i += 1;
    }
    return pipes;
}

function splitTableRow(line: string): string[] {
    const trimmed = line.trim();
    const pipes = findTablePipes(trimmed);
    if (pipes.length === 0) {
        return [trimmed.replace(/\\\|/g, '|')];
    }

    const segments: string[] = [];
    let start = 0;
    for (const pipeIdx of pipes) {
        segments.push(trimmed.slice(start, pipeIdx));
        start = pipeIdx + 1;
    }
    segments.push(trimmed.slice(start));

    if (pipes[0] === 0) {
        segments.shift();
    }
    if (pipes[pipes.length - 1] === trimmed.length - 1 && segments.length > 0) {
        segments.pop();
    }

    return segments.map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function parseTableStart(
    lines: string[],
    index: number,
): { headerCells: string[]; aligns: MarkdownTableAlign[] } | null {
    if (index + 1 >= lines.length) {
        return null;
    }
    const headerLine = lines[index];
    const delimLine = lines[index + 1];
    if (!headerLine.trim() || !delimLine.trim()) {
        return null;
    }
    if (isThematicBreak(delimLine) || matchFenceOpen(headerLine) || matchHeading(headerLine)) {
        return null;
    }
    if (findTablePipes(headerLine.trim()).length === 0 && findTablePipes(delimLine.trim()).length === 0) {
        return null;
    }

    const headerCells = splitTableRow(headerLine);
    const delimCells = splitTableRow(delimLine);
    if (headerCells.length === 0 || headerCells.length !== delimCells.length) {
        return null;
    }

    const aligns: MarkdownTableAlign[] = [];
    for (const cell of delimCells) {
        if (!TABLE_DELIM_CELL_RE.test(cell)) {
            return null;
        }
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) {
            aligns.push('center');
        } else if (right) {
            aligns.push('right');
        } else if (left) {
            aligns.push('left');
        } else {
            aligns.push(null);
        }
    }

    return { headerCells, aligns };
}

interface ListMarkerMatch {
    indent: number;
    ordered: boolean;
    start: number;
    contentIndent: number;
    rest: string;
}

function matchListMarker(line: string): ListMarkerMatch | null {
    if (isThematicBreak(line)) {
        return null;
    }
    const { indent, restIndex } = measureIndent(line);
    const restSlice = line.slice(restIndex);

    const unordered = UNORDERED_MARKER_RE.exec(restSlice);
    if (unordered) {
        const afterMarker = restSlice.slice(1);
        const spacingMatch = /^([ \t]+)/.exec(afterMarker);
        const spacingCols = spacingMatch ? measureIndent(spacingMatch[1]).indent : 1;
        const clampedSpacing = spacingMatch ? Math.min(Math.max(spacingCols, 1), 4) : 1;
        return {
            indent,
            ordered: false,
            start: 1,
            contentIndent: indent + 1 + clampedSpacing,
            rest: unordered[2] ?? '',
        };
    }

    const ordered = ORDERED_MARKER_RE.exec(restSlice);
    if (ordered) {
        const numStr = ordered[1];
        const markerWidth = numStr.length + 1;
        const afterMarker = restSlice.slice(markerWidth);
        const spacingMatch = /^([ \t]+)/.exec(afterMarker);
        const spacingCols = spacingMatch ? measureIndent(spacingMatch[1]).indent : 1;
        const clampedSpacing = spacingMatch ? Math.min(Math.max(spacingCols, 1), 4) : 1;
        return {
            indent,
            ordered: true,
            start: Number(numStr),
            contentIndent: indent + markerWidth + clampedSpacing,
            rest: ordered[3] ?? '',
        };
    }

    return null;
}

function isBlockStart(lines: string[], index: number, inParagraph: boolean): boolean {
    const line = lines[index];
    if (!line.trim()) {
        return true;
    }
    if (matchFenceOpen(line)) {
        return true;
    }
    if (matchHeading(line)) {
        return true;
    }
    if (isThematicBreak(line)) {
        return true;
    }
    if (BLOCKQUOTE_RE.test(line)) {
        return true;
    }
    if (parseTableStart(lines, index)) {
        return true;
    }
    const listMarker = matchListMarker(line);
    if (listMarker && listMarker.indent <= 3) {
        if (!inParagraph || listMarker.rest.trim().length > 0) {
            return true;
        }
    }
    return false;
}

/** Parse Markdown text into block-level AST nodes. */
export function parseMarkdownBlocks(input: string, depth = 0): MarkdownBlockNode[] {
    if (!input) {
        return [];
    }
    const normalized = input.replace(/\r\n?/g, '\n');
    if (depth >= MAX_BLOCK_DEPTH) {
        return normalized.trim()
            ? [{ type: 'paragraph', children: [{ type: 'text', text: normalized }] }]
            : [];
    }

    const lines = normalized.split('\n');
    const blocks: MarkdownBlockNode[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
            i += 1;
            continue;
        }

        const fence = matchFenceOpen(line);
        if (fence) {
            const codeLines: string[] = [];
            i += 1;
            while (i < lines.length) {
                if (isFenceClose(lines[i], fence.char, fence.length)) {
                    i += 1;
                    break;
                }
                codeLines.push(lines[i]);
                i += 1;
            }
            blocks.push({
                type: 'code_block',
                ...(fence.lang ? { lang: fence.lang } : {}),
                code: codeLines.join('\n'),
            });
            continue;
        }

        const heading = matchHeading(line);
        if (heading) {
            blocks.push({
                type: 'heading',
                level: heading.level,
                children: parseMarkdownInline(heading.text),
            });
            i += 1;
            continue;
        }

        if (isThematicBreak(line)) {
            blocks.push({ type: 'hr' });
            i += 1;
            continue;
        }

        if (BLOCKQUOTE_RE.test(line)) {
            const quoteLines: string[] = [];
            while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
                quoteLines.push(lines[i].replace(/^ {0,3}> ?/, ''));
                i += 1;
            }
            blocks.push({
                type: 'blockquote',
                blocks: parseMarkdownBlocks(quoteLines.join('\n'), depth + 1),
            });
            continue;
        }

        const tableStart = parseTableStart(lines, i);
        if (tableStart) {
            const colCount = tableStart.headerCells.length;
            const headers = tableStart.headerCells.map((cell) => parseMarkdownInline(cell));
            const rows: MarkdownInlineNode[][][] = [];
            i += 2;
            while (i < lines.length) {
                const rowLine = lines[i];
                if (!rowLine.trim()) {
                    break;
                }
                if (
                    matchFenceOpen(rowLine)
                    || matchHeading(rowLine)
                    || isThematicBreak(rowLine)
                    || BLOCKQUOTE_RE.test(rowLine)
                ) {
                    break;
                }
                const listCheck = matchListMarker(rowLine);
                if (listCheck && listCheck.indent <= 3) {
                    break;
                }
                if (findTablePipes(rowLine.trim()).length === 0) {
                    break;
                }
                const parsedCells = splitTableRow(rowLine);
                const normalizedRow: MarkdownInlineNode[][] = [];
                for (let col = 0; col < colCount; col += 1) {
                    normalizedRow.push(parseMarkdownInline(parsedCells[col] ?? ''));
                }
                rows.push(normalizedRow);
                i += 1;
            }
            blocks.push({
                type: 'table',
                headers,
                aligns: tableStart.aligns,
                rows,
            });
            continue;
        }

        const firstMarker = matchListMarker(line);
        if (firstMarker && firstMarker.indent <= 3) {
            const ordered = firstMarker.ordered;
            const start = firstMarker.start;
            const baseIndent = firstMarker.indent;
            const items: MarkdownListItem[] = [];

            let currentMarker: ListMarkerMatch | null = firstMarker;
            while (currentMarker && i < lines.length) {
                const itemLines: string[] = [];
                let firstContent = currentMarker.rest;
                let checked: boolean | undefined;

                if (!ordered) {
                    const taskMatch = TASK_PREFIX_RE.exec(firstContent);
                    if (taskMatch) {
                        checked = taskMatch[1].toLowerCase() === 'x';
                        firstContent = taskMatch[2] ?? '';
                    }
                }

                itemLines.push(firstContent);
                let activeFence = matchFenceOpen(firstContent);
                const stripAmount = currentMarker.contentIndent;
                i += 1;

                let nextSiblingMarker: ListMarkerMatch | null = null;
                while (i < lines.length) {
                    const nextLine = lines[i];

                    if (activeFence) {
                        const stripped = stripIndent(
                            nextLine,
                            Math.min(measureIndent(nextLine).indent, stripAmount),
                        );
                        itemLines.push(stripped);
                        if (isFenceClose(stripped, activeFence.char, activeFence.length)) {
                            activeFence = null;
                        }
                        i += 1;
                        continue;
                    }

                    if (!nextLine.trim()) {
                        let lookahead = i + 1;
                        while (lookahead < lines.length && !lines[lookahead].trim()) {
                            lookahead += 1;
                        }
                        if (lookahead >= lines.length) {
                            i = lookahead;
                            break;
                        }
                        const resumeLine = lines[lookahead];
                        const resumeIndent = measureIndent(resumeLine).indent;
                        const resumeMarker = matchListMarker(resumeLine);

                        if (
                            resumeMarker
                            && resumeMarker.ordered === ordered
                            && resumeMarker.indent >= Math.max(0, baseIndent - 1)
                            && resumeMarker.indent <= baseIndent + 1
                        ) {
                            i = lookahead;
                            nextSiblingMarker = resumeMarker;
                            break;
                        }

                        if (resumeIndent >= baseIndent + 2) {
                            itemLines.push('');
                            i += 1;
                            continue;
                        }

                        i = lookahead;
                        break;
                    }

                    const nextIndent = measureIndent(nextLine).indent;
                    const candidateMarker = matchListMarker(nextLine);
                    if (
                        candidateMarker
                        && candidateMarker.ordered === ordered
                        && candidateMarker.indent >= Math.max(0, baseIndent - 1)
                        && candidateMarker.indent <= baseIndent + 1
                    ) {
                        nextSiblingMarker = candidateMarker;
                        break;
                    }

                    if (nextIndent > baseIndent) {
                        const stripped = stripIndent(nextLine, Math.min(nextIndent, stripAmount));
                        itemLines.push(stripped);
                        const openedFence = matchFenceOpen(stripped);
                        if (openedFence) {
                            activeFence = openedFence;
                        }
                        i += 1;
                        continue;
                    }

                    break;
                }

                while (itemLines.length > 0 && !itemLines[itemLines.length - 1].trim()) {
                    itemLines.pop();
                }

                const parsedItemBlocks = parseMarkdownBlocks(itemLines.join('\n'), depth + 1);
                items.push({
                    ...(checked !== undefined ? { checked } : {}),
                    blocks: parsedItemBlocks,
                });

                currentMarker = nextSiblingMarker;
            }

            blocks.push({
                type: 'list',
                ordered,
                start,
                items,
            });
            continue;
        }

        const paraLines: string[] = [line];
        i += 1;
        while (i < lines.length && !isBlockStart(lines, i, true)) {
            paraLines.push(lines[i]);
            i += 1;
        }

        const children: MarkdownInlineNode[] = [];
        for (let pIdx = 0; pIdx < paraLines.length; pIdx += 1) {
            let pLine = paraLines[pIdx];
            if (pIdx < paraLines.length - 1) {
                if (pLine.endsWith('\\')) {
                    pLine = pLine.slice(0, -1);
                } else {
                    pLine = pLine.replace(/[ ]{2,}$/, '');
                }
            }
            const parsedLine = parseMarkdownInline(pLine);
            for (const node of parsedLine) {
                children.push(node);
            }
            if (pIdx < paraLines.length - 1) {
                children.push({ type: 'break' });
            }
        }
        blocks.push({ type: 'paragraph', children });
    }

    return blocks;
}

interface ParsedBracketLink {
    label: string;
    rawUrl: string;
    title?: string;
    endIndex: number;
}

function skipInlineCodeSpan(text: string, start: number): number {
    let ticks = 0;
    const len = text.length;
    while (start + ticks < len && text[start + ticks] === '`') {
        ticks += 1;
    }
    let j = start + ticks;
    while (j < len) {
        if (text[j] === '`') {
            let run = 0;
            while (j + run < len && text[j + run] === '`') {
                run += 1;
            }
            if (run === ticks) {
                return j + run;
            }
            j += run;
        } else {
            j += 1;
        }
    }
    return start + ticks;
}

function parseLinkDestination(destRaw: string): { rawUrl: string; title?: string } | null {
    const trimmed = destRaw.trim();
    if (!trimmed) {
        return null;
    }

    let rawUrl = '';
    let rest = '';
    if (trimmed.startsWith('<')) {
        const closeAngle = trimmed.indexOf('>');
        if (closeAngle < 0) {
            return null;
        }
        rawUrl = trimmed.slice(1, closeAngle).trim();
        rest = trimmed.slice(closeAngle + 1).trim();
    } else {
        let idx = 0;
        let parenDepth = 0;
        while (idx < trimmed.length) {
            const ch = trimmed[idx];
            if (ch === '\\' && idx + 1 < trimmed.length) {
                idx += 2;
                continue;
            }
            if (ch === '(') {
                parenDepth += 1;
            } else if (ch === ')') {
                if (parenDepth === 0) {
                    break;
                }
                parenDepth -= 1;
            } else if (/\s/.test(ch) && parenDepth === 0) {
                break;
            }
            idx += 1;
        }
        rawUrl = trimmed.slice(0, idx);
        rest = trimmed.slice(idx).trim();
    }

    if (!rawUrl) {
        return null;
    }

    let title: string | undefined;
    if (rest.length >= 2) {
        const q = rest[0];
        const endQ = rest[rest.length - 1];
        if ((q === '"' && endQ === '"') || (q === "'" && endQ === "'") || (q === '(' && endQ === ')')) {
            title = rest.slice(1, -1);
        }
    }

    return { rawUrl, ...(title !== undefined ? { title } : {}) };
}

function parseBracketLinkOrImage(text: string, bracketStart: number): ParsedBracketLink | null {
    const len = text.length;
    if (text[bracketStart] !== '[') {
        return null;
    }
    let idx = bracketStart + 1;
    let bracketDepth = 1;
    let closeBracket = -1;

    while (idx < len) {
        const ch = text[idx];
        if (ch === '\\' && idx + 1 < len) {
            idx += 2;
            continue;
        }
        if (ch === '`') {
            idx = skipInlineCodeSpan(text, idx);
            continue;
        }
        if (ch === '[') {
            bracketDepth += 1;
        } else if (ch === ']') {
            bracketDepth -= 1;
            if (bracketDepth === 0) {
                closeBracket = idx;
                break;
            }
        }
        idx += 1;
    }

    if (closeBracket < 0 || text[closeBracket + 1] !== '(') {
        return null;
    }

    let destIdx = closeBracket + 2;
    let parenDepth = 1;
    let quoteChar: string | null = null;
    let closeParen = -1;

    while (destIdx < len) {
        const ch = text[destIdx];
        if (ch === '\n') {
            return null;
        }
        if (ch === '\\' && destIdx + 1 < len) {
            destIdx += 2;
            continue;
        }
        if (quoteChar) {
            if (ch === quoteChar) {
                quoteChar = null;
            }
            destIdx += 1;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quoteChar = ch;
            destIdx += 1;
            continue;
        }
        if (ch === '(') {
            parenDepth += 1;
        } else if (ch === ')') {
            parenDepth -= 1;
            if (parenDepth === 0) {
                closeParen = destIdx;
                break;
            }
        }
        destIdx += 1;
    }

    if (closeParen < 0) {
        return null;
    }

    const parsedDest = parseLinkDestination(text.slice(closeBracket + 2, closeParen));
    if (!parsedDest) {
        return null;
    }

    return {
        label: text.slice(bracketStart + 1, closeBracket),
        rawUrl: parsedDest.rawUrl,
        ...(parsedDest.title !== undefined ? { title: parsedDest.title } : {}),
        endIndex: closeParen + 1,
    };
}

function findClosingDelimiter(
    input: string,
    start: number,
    markerChar: '*' | '_' | '~',
    targetLen: 1 | 2 | 3,
): number {
    const len = input.length;
    const isUnderscore = markerChar === '_';
    let j = start;
    let nested1 = 0;
    let nested2 = 0;
    let nested3 = 0;

    while (j < len) {
        if (input.startsWith(REDACTED_MARKER, j)) {
            j += REDACTED_MARKER.length;
            continue;
        }
        if (input[j] === '\\' && j + 1 < len) {
            j += 2;
            continue;
        }
        if (input[j] === '`') {
            j = skipInlineCodeSpan(input, j);
            continue;
        }
        if (input[j] !== markerChar) {
            j += 1;
            continue;
        }

        let run = 0;
        while (j + run < len && input[j + run] === markerChar) {
            run += 1;
        }

        const prevChar = j > 0 ? input[j - 1] : '';
        const afterChar = j + run < len ? input[j + run] : '';
        const canCloseBoundary =
            Boolean(prevChar)
            && !/\s/.test(prevChar)
            && (!isUnderscore || !/[A-Za-z0-9]/.test(afterChar));
        const canOpenBoundary =
            Boolean(afterChar)
            && !/\s/.test(afterChar)
            && (!isUnderscore || !/[A-Za-z0-9]/.test(prevChar));

        if (markerChar === '~') {
            if (targetLen === 2 && run === 2 && canCloseBoundary) {
                return j;
            }
            j += run;
            continue;
        }

        if (run === targetLen && canCloseBoundary) {
            if (targetLen === 1 && nested1 > 0) {
                nested1 -= 1;
                j += run;
                continue;
            }
            if (targetLen === 2 && nested2 > 0) {
                nested2 -= 1;
                j += run;
                continue;
            }
            if (targetLen === 3 && nested3 > 0) {
                nested3 -= 1;
                j += run;
                continue;
            }
            return j;
        }

        if (targetLen === 2 && run === 3 && canCloseBoundary && nested1 > 0) {
            nested1 -= 1;
            return j + 1;
        }

        if (targetLen === 1 && run === 3 && canCloseBoundary && nested2 > 0) {
            nested2 -= 1;
            return j + 2;
        }

        if (canOpenBoundary) {
            if (run === 1 && targetLen !== 1) {
                nested1 += 1;
            } else if (run === 2 && targetLen !== 2) {
                nested2 += 1;
            } else if (run === 3 && targetLen !== 3) {
                nested3 += 1;
            }
        } else if (canCloseBoundary) {
            if (run === 1 && nested1 > 0) {
                nested1 -= 1;
            } else if (run === 2 && nested2 > 0) {
                nested2 -= 1;
            } else if (run === 3 && nested3 > 0) {
                nested3 -= 1;
            }
        }

        j += run;
    }

    return -1;
}

function trimBareUrlCandidate(raw: string): string {
    let url = raw.replace(TRAILING_URL_PUNCT_RE, '');
    while (url.length > 0) {
        const last = url[url.length - 1];
        if (last === ')') {
            const opens = (url.match(/\(/g) ?? []).length;
            const closes = (url.match(/\)/g) ?? []).length;
            if (closes > opens) {
                url = url.slice(0, -1).replace(TRAILING_URL_PUNCT_RE, '');
                continue;
            }
        } else if (last === ']') {
            const opens = (url.match(/\[/g) ?? []).length;
            const closes = (url.match(/\]/g) ?? []).length;
            if (closes > opens) {
                url = url.slice(0, -1).replace(TRAILING_URL_PUNCT_RE, '');
                continue;
            }
        }
        break;
    }
    return url;
}

function canStartBareUrl(prevChar: string): boolean {
    if (!prevChar) {
        return true;
    }
    if (/\s/.test(prevChar)) {
        return true;
    }
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(prevChar)) {
        return true;
    }
    return '([{"\'‘“（【《「『：:'.includes(prevChar);
}

/** Parse inline Markdown text into inline AST nodes (never uses HTML injection). */
export function parseMarkdownInline(input: string, depth = 0): MarkdownInlineNode[] {
    if (!input) {
        return [];
    }
    if (depth >= MAX_INLINE_DEPTH) {
        return [{ type: 'text', text: input }];
    }

    const nodes: MarkdownInlineNode[] = [];
    const pushText = (text: string) => {
        if (!text) {
            return;
        }
        const prev = nodes[nodes.length - 1];
        if (prev && prev.type === 'text') {
            prev.text += text;
        } else {
            nodes.push({ type: 'text', text });
        }
    };

    let i = 0;
    const len = input.length;

    while (i < len) {
        if (input.startsWith(REDACTED_MARKER, i)) {
            nodes.push({ type: 'redacted' });
            i += REDACTED_MARKER.length;
            continue;
        }

        const ch = input[i];

        if (ch === '\\' && i + 1 < len) {
            const next = input[i + 1];
            if (ESCAPABLE_PUNCT_RE.test(next)) {
                pushText(next);
                i += 2;
                continue;
            }
        }

        if (ch === '<') {
            const rest = input.slice(i);
            const brMatch = BR_TAG_RE.exec(rest);
            if (brMatch) {
                nodes.push({ type: 'break' });
                i += brMatch[0].length;
                continue;
            }
            const angleMatch = ANGLE_AUTOLINK_RE.exec(rest);
            if (angleMatch) {
                const safeHref = sanitizeMarkdownUrl(angleMatch[1]);
                if (safeHref) {
                    nodes.push({
                        type: 'link',
                        href: safeHref,
                        children: [{ type: 'text', text: angleMatch[1] }],
                    });
                    i += angleMatch[0].length;
                    continue;
                }
            }
        }

        if (ch === '`') {
            let ticksLen = 0;
            while (i + ticksLen < len && input[i + ticksLen] === '`') {
                ticksLen += 1;
            }
            let j = i + ticksLen;
            let closeStart = -1;
            while (j < len) {
                if (input[j] === '`') {
                    let run = 0;
                    while (j + run < len && input[j + run] === '`') {
                        run += 1;
                    }
                    if (run === ticksLen) {
                        closeStart = j;
                        break;
                    }
                    j += run;
                } else {
                    j += 1;
                }
            }
            if (closeStart !== -1) {
                let code = input.slice(i + ticksLen, closeStart).replace(/\n/g, ' ');
                if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code)) {
                    code = code.slice(1, -1);
                }
                nodes.push({ type: 'code', code });
                i = closeStart + ticksLen;
                continue;
            }
            pushText(input.slice(i, i + ticksLen));
            i += ticksLen;
            continue;
        }

        if (ch === '!' && input[i + 1] === '[') {
            const parsed = parseBracketLinkOrImage(input, i + 1);
            if (parsed) {
                const safeSrc = sanitizeMarkdownImageUrl(parsed.rawUrl);
                if (safeSrc) {
                    nodes.push({
                        type: 'image',
                        src: safeSrc,
                        alt: parsed.label,
                        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
                    });
                } else {
                    pushText(parsed.label ? `[图片: ${parsed.label}]` : '[图片]');
                }
                i = parsed.endIndex;
                continue;
            }
        }

        if (ch === '[') {
            const parsed = parseBracketLinkOrImage(input, i);
            if (parsed) {
                const labelChildren = parseMarkdownInline(parsed.label, depth + 1);
                const safeHref = sanitizeMarkdownUrl(parsed.rawUrl);
                if (safeHref) {
                    nodes.push({
                        type: 'link',
                        href: safeHref,
                        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
                        children: labelChildren,
                    });
                } else {
                    for (const child of labelChildren) {
                        if (child.type === 'text') {
                            pushText(child.text);
                        } else {
                            nodes.push(child);
                        }
                    }
                }
                i = parsed.endIndex;
                continue;
            }
        }

        if (
            (ch === 'h' || ch === 'H')
            && /^https?:\/\//i.test(input.slice(i, i + 8))
            && canStartBareUrl(i > 0 ? input[i - 1] : '')
        ) {
            const match = BARE_URL_RE.exec(input.slice(i));
            if (match) {
                const candidate = trimBareUrlCandidate(match[0]);
                const safeHref = candidate ? sanitizeMarkdownUrl(candidate) : null;
                if (safeHref) {
                    nodes.push({
                        type: 'link',
                        href: safeHref,
                        children: [{ type: 'text', text: candidate }],
                    });
                    i += candidate.length;
                    continue;
                }
            }
        }

        if (ch === '~' && input.startsWith('~~', i) && input[i + 2] !== '~') {
            const after = input[i + 2];
            if (after && !/\s/.test(after)) {
                const closeIdx = findClosingDelimiter(input, i + 2, '~', 2);
                if (closeIdx > i + 2) {
                    nodes.push({
                        type: 'del',
                        children: parseMarkdownInline(input.slice(i + 2, closeIdx), depth + 1),
                    });
                    i = closeIdx + 2;
                    continue;
                }
            }
        }

        if (ch === '*' || ch === '_') {
            let runLen = 0;
            while (i + runLen < len && input[i + runLen] === ch) {
                runLen += 1;
            }
            if (runLen > 3) {
                pushText(input.slice(i, i + runLen));
                i += runLen;
                continue;
            }

            const prevChar = i > 0 ? input[i - 1] : '';
            const afterChar = i + runLen < len ? input[i + runLen] : '';
            const isUnderscore = ch === '_';
            const canOpen =
                Boolean(afterChar)
                && !/\s/.test(afterChar)
                && (!isUnderscore || !/[A-Za-z0-9]/.test(prevChar));

            if (canOpen) {
                if (runLen === 3) {
                    const close3 = findClosingDelimiter(input, i + 3, ch, 3);
                    if (close3 > i + 3) {
                        const inner = parseMarkdownInline(input.slice(i + 3, close3), depth + 1);
                        nodes.push({
                            type: 'em',
                            children: [{ type: 'strong', children: inner }],
                        });
                        i = close3 + 3;
                        continue;
                    }
                    // Fallback: allow leading single delimiter wrapping **bold**
                    const close1 = findClosingDelimiter(input, i + 1, ch, 1);
                    if (close1 > i + 1) {
                        nodes.push({
                            type: 'em',
                            children: parseMarkdownInline(input.slice(i + 1, close1), depth + 1),
                        });
                        i = close1 + 1;
                        continue;
                    }
                    // Allow leading literal * followed by **bold** (e.g. ***bold**)
                    pushText(ch);
                    i += 1;
                    continue;
                } else if (runLen === 2) {
                    const close2 = findClosingDelimiter(input, i + 2, ch, 2);
                    if (close2 > i + 2) {
                        nodes.push({
                            type: 'strong',
                            children: parseMarkdownInline(input.slice(i + 2, close2), depth + 1),
                        });
                        i = close2 + 2;
                        continue;
                    }
                } else {
                    const close1 = findClosingDelimiter(input, i + 1, ch, 1);
                    if (close1 > i + 1) {
                        nodes.push({
                            type: 'em',
                            children: parseMarkdownInline(input.slice(i + 1, close1), depth + 1),
                        });
                        i = close1 + 1;
                        continue;
                    }
                }
            }

            pushText(input.slice(i, i + runLen));
            i += runLen;
            continue;
        }

        pushText(ch);
        i += 1;
    }

    return nodes;
}
