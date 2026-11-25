import type { ToolEditOperation, ToolEditRange, ToolEditResult } from '@/core/bridge';
import type { VfsSearchHit } from '@/core/types';
import { VfsError, utf8ByteLength } from './fs-base';

export const DEFAULT_READ_SOFT_MAX_LINES = 200;
export const DEFAULT_READ_SOFT_MAX_BYTES = 24 * 1024;
export const DEFAULT_MAX_CHARS_PER_LINE = 4000;

const MIN_CHAR_LIMIT = 200;
const MAX_CHAR_LIMIT = 20_000;
const MAX_CONTEXT_LINES = 10;
const SNIPPET_MAX_CHARS = 200;
const CONTEXT_LINE_MAX_CHARS = 240;
const HEADER_FOOTER_RESERVE_BYTES = 360;

export interface GrepLinesParams {
    path: string;
    title?: string;
    content: string;
    query: string;
    caseSensitive: boolean;
    regex: boolean;
    lineOffset?: number;
    totalLines?: number;
    contextLines?: number;
    maxMatches?: number;
    matchedTerms?: string[];
}

export interface FormatReadOptions {
    path: string;
    rawContent: string;
    startLine?: number;
    endLine?: number;
    lineNumbers?: boolean;
    charOffset?: number;
    charLimit?: number;
    softMaxLines?: number;
    softMaxBytes?: number;
}

export interface FormattedReadResult {
    text: string;
    totalLines: number;
    totalBytes: number;
    shownStartLine: number;
    shownEndLine: number;
    hasMore: boolean;
    truncated: boolean;
    coveredFullFile: boolean;
}

export interface ApplyTextEditsParams {
    path: string;
    content: string;
    edits: readonly ToolEditOperation[];
    lineOffset?: number;
    readonlyHeaderLabel?: string;
}

export interface ApplyTextEditsResult extends ToolEditResult {
    updatedContent?: string;
}

/** Normalize single or batch edit arguments into `ToolEditOperation[]`. */
export function resolveEditOperations(
    oldText: string,
    newText: string,
    opts?: {
        startLine?: number;
        endLine?: number;
        replaceAll?: boolean;
        edits?: readonly ToolEditOperation[];
    },
): readonly ToolEditOperation[] {
    if (opts?.edits && opts.edits.length > 0) {
        return opts.edits;
    }
    return [
        {
            search: oldText,
            replace: newText,
            ...(opts?.startLine !== undefined ? { startLine: opts.startLine } : {}),
            ...(opts?.endLine !== undefined ? { endLine: opts.endLine } : {}),
            ...(opts?.replaceAll !== undefined ? { replaceAll: opts.replaceAll } : {}),
        },
    ];
}

/** Count 1-based lines in `text` (empty string has 0 lines). */
export function countLines(text: string): number {
    if (!text) {
        return 0;
    }
    let count = 1;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) {
            count += 1;
        }
    }
    return count;
}

/** Return 1-based line number for a 0-based character offset in `text`. */
export function lineNumberAtOffset(text: string, charOffset: number): number {
    const limit = Math.max(0, Math.min(charOffset, text.length));
    let line = 1;
    for (let i = 0; i < limit; i += 1) {
        if (text.charCodeAt(i) === 10) {
            line += 1;
        }
    }
    return line;
}

/** Format byte size compactly for read_file headers. */
export function formatByteSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stripTrailingCr(line: string): string {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function clampSurrogateStart(text: string, index: number): number {
    if (index <= 0 || index >= text.length) {
        return Math.max(0, Math.min(index, text.length));
    }
    const code = text.charCodeAt(index);
    if (code >= 0xdc00 && code <= 0xdfff) {
        return index + 1;
    }
    return index;
}

function clampSurrogateEnd(text: string, index: number): number {
    if (index <= 0 || index >= text.length) {
        return Math.max(0, Math.min(index, text.length));
    }
    const code = text.charCodeAt(index - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
        return index - 1;
    }
    return index;
}

function sliceSafe(text: string, rawStart: number, rawEnd: number): string {
    const start = clampSurrogateStart(text, Math.max(0, rawStart));
    const end = clampSurrogateEnd(text, Math.min(text.length, rawEnd));
    if (end <= start) {
        return '';
    }
    return text.slice(start, end);
}

function truncateToUtf8BytesSafe(text: string, maxBytes: number): string {
    if (maxBytes <= 0 || !text) {
        return '';
    }
    if (utf8ByteLength(text) <= maxBytes) {
        return text;
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        const end = clampSurrogateEnd(text, mid);
        if (utf8ByteLength(text.slice(0, end)) <= maxBytes) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return text.slice(0, clampSurrogateEnd(text, low));
}

function truncateContextLine(rawLine: string, maxChars: number = CONTEXT_LINE_MAX_CHARS): string {
    const line = stripTrailingCr(rawLine);
    if (line.length <= maxChars) {
        return line;
    }
    const sliced = sliceSafe(line, 0, Math.max(1, maxChars - 3)).trimEnd();
    return `${sliced}...`;
}

/**
 * Extract a snippet from `line` centered around `[matchStart, matchStart + matchLen]`,
 * ensuring the matched region remains visible even on multi-thousand-character lines.
 */
export function extractCenteredSnippet(
    rawLine: string,
    matchStart: number,
    matchLen: number,
    maxChars: number = SNIPPET_MAX_CHARS,
): string {
    const line = stripTrailingCr(rawLine);
    const trimmed = line.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }

    const safeStart = Math.max(0, Math.min(matchStart, line.length));
    const safeLen = Math.max(0, Math.min(matchLen, line.length - safeStart));
    const matchEnd = safeStart + safeLen;

    let windowStart = 0;
    let windowEnd = Math.min(line.length, maxChars);

    if (safeLen >= maxChars) {
        windowStart = safeStart;
        windowEnd = Math.min(line.length, safeStart + maxChars);
    } else {
        const matchCenter = safeStart + Math.floor(safeLen / 2);
        windowStart = Math.max(0, matchCenter - Math.floor(maxChars / 2));
        windowEnd = windowStart + maxChars;
        if (windowEnd > line.length) {
            windowEnd = line.length;
            windowStart = Math.max(0, windowEnd - maxChars);
        }
        // Guarantee the match start is inside the window.
        if (safeStart < windowStart) {
            windowStart = safeStart;
            windowEnd = Math.min(line.length, windowStart + maxChars);
        } else if (matchEnd > windowEnd && safeLen < maxChars) {
            windowEnd = Math.min(line.length, matchEnd + 16);
            windowStart = Math.max(0, windowEnd - maxChars);
        }
    }

    const body = sliceSafe(line, windowStart, windowEnd);
    const leftTrimmed = windowStart === 0 ? body.trimStart() : body;
    const finalBody = windowEnd === line.length ? leftTrimmed.trimEnd() : leftTrimmed;
    return `${windowStart > 0 ? '...' : ''}${finalBody}${windowEnd < line.length ? '...' : ''}`;
}

/**
 * Search `params.content` line-by-line, returning 1-based line numbers, centered
 * snippets, total line count, and optional formatted surrounding context lines.
 */
export function grepLinesInText(params: GrepLinesParams): VfsSearchHit[] {
    if (!params.query) {
        return [];
    }

    const lineOffset = Math.max(0, Math.floor(params.lineOffset ?? 0));
    const ctxCount = Math.max(0, Math.min(MAX_CONTEXT_LINES, Math.floor(params.contextLines ?? 0)));
    const maxMatches = Math.max(1, Math.floor(params.maxMatches ?? 100));

    let findMatch: (line: string) => { index: number; length: number } | null;
    if (params.regex) {
        let re: RegExp;
        try {
            re = new RegExp(params.query, params.caseSensitive ? '' : 'i');
        } catch (error) {
            throw new VfsError(
                `Invalid grep regex: ${(error as Error).message}`,
                'EINVAL',
                params.path,
            );
        }
        findMatch = (line) => {
            const match = re.exec(line);
            if (!match) {
                return null;
            }
            return { index: match.index, length: match[0].length };
        };
    } else {
        const needle = params.caseSensitive ? params.query : params.query.toLowerCase();
        findMatch = (line) => {
            const haystack = params.caseSensitive ? line : line.toLowerCase();
            const idx = haystack.indexOf(needle);
            return idx >= 0 ? { index: idx, length: needle.length } : null;
        };
    }

    if (!params.content) {
        return [];
    }

    const lines = params.content.split('\n');
    const totalLines = params.totalLines ?? (lines.length + lineOffset);
    const hits: VfsSearchHit[] = [];

    for (let idx = 0; idx < lines.length; idx += 1) {
        const cleanLine = stripTrailingCr(lines[idx]);
        const match = findMatch(cleanLine);
        if (!match) {
            continue;
        }

        const lineNum = idx + 1 + lineOffset;
        const snippet = extractCenteredSnippet(cleanLine, match.index, match.length, SNIPPET_MAX_CHARS);

        let context: string[] | undefined;
        if (ctxCount > 0) {
            context = [];
            const startIdx = Math.max(0, idx - ctxCount);
            const endIdx = Math.min(lines.length - 1, idx + ctxCount);
            for (let j = startIdx; j <= endIdx; j += 1) {
                const ctxLineNum = j + 1 + lineOffset;
                if (j === idx) {
                    const centered = extractCenteredSnippet(
                        cleanLine,
                        match.index,
                        match.length,
                        CONTEXT_LINE_MAX_CHARS,
                    );
                    context.push(`>${ctxLineNum}| ${centered}`);
                } else {
                    context.push(` ${ctxLineNum}| ${truncateContextLine(lines[j], CONTEXT_LINE_MAX_CHARS)}`);
                }
            }
        }

        hits.push({
            path: params.path,
            score: 1,
            ...(params.title !== undefined ? { title: params.title } : {}),
            line: lineNum,
            totalLines,
            snippet,
            ...(context ? { context } : {}),
            ...(params.matchedTerms ? { matchedTerms: [...params.matchedTerms] } : {}),
        });

        if (hits.length >= maxMatches) {
            return hits;
        }
    }

    return hits;
}

/**
 * Format a file (or line slice) for LLM consumption with metadata header,
 * optional `N| ` line prefixes, soft line/byte pagination, and long-line slicing.
 */
export function formatFileReadResult(options: FormatReadOptions): FormattedReadResult {
    const rawContent = options.rawContent ?? '';
    const totalBytes = utf8ByteLength(rawContent);
    const totalLines = countLines(rawContent);
    const showLineNumbers = options.lineNumbers !== false;
    const softMaxLines = Math.max(1, Math.floor(options.softMaxLines ?? DEFAULT_READ_SOFT_MAX_LINES));
    const softMaxBytes = Math.max(1024, Math.floor(options.softMaxBytes ?? DEFAULT_READ_SOFT_MAX_BYTES));
    const charOffset = Math.max(0, Math.floor(options.charOffset ?? 0));
    const charLimit = Math.max(
        MIN_CHAR_LIMIT,
        Math.min(MAX_CHAR_LIMIT, Math.floor(options.charLimit ?? DEFAULT_MAX_CHARS_PER_LINE)),
    );

    if (totalLines === 0) {
        return {
            text: `[File: ${options.path} | 0 lines | 0 B | empty]`,
            totalLines: 0,
            totalBytes: 0,
            shownStartLine: 0,
            shownEndLine: 0,
            hasMore: false,
            truncated: false,
            coveredFullFile: true,
        };
    }

    const lines = rawContent.split('\n');
    const hasExplicitRange = options.startLine !== undefined || options.endLine !== undefined;
    const effectiveStart = options.startLine !== undefined
        ? Math.max(1, Math.floor(options.startLine))
        : 1;

    if (effectiveStart > totalLines) {
        return {
            text: `[File: ${options.path} | total ${totalLines} lines | ${formatByteSize(totalBytes)} | start_line=${effectiveStart} is past end of file]`,
            totalLines,
            totalBytes,
            shownStartLine: totalLines,
            shownEndLine: totalLines,
            hasMore: false,
            truncated: false,
            coveredFullFile: false,
        };
    }

    let requestedEnd: number;
    let hitSoftLineCap = false;
    if (!hasExplicitRange) {
        requestedEnd = Math.min(totalLines, effectiveStart + softMaxLines - 1);
        hitSoftLineCap = totalLines > requestedEnd;
    } else {
        requestedEnd = options.endLine !== undefined
            ? Math.min(totalLines, Math.floor(options.endLine))
            : totalLines;
    }

    const contentByteBudget = Math.max(512, softMaxBytes - HEADER_FOOTER_RESERVE_BYTES);
    const formattedLines: string[] = [];
    let accumulatedBytes = 0;
    let shownEndLine = effectiveStart - 1;
    let byteTruncated = false;
    let lineCharTruncated = false;

    for (let lineNum = effectiveStart; lineNum <= requestedEnd; lineNum += 1) {
        const cleanLine = stripTrailingCr(lines[lineNum - 1] ?? '');
        const prefix = showLineNumbers ? `${lineNum}| ` : '';

        let bodySlice = '';
        let suffix = '';
        const clampedOffset = Math.min(charOffset, cleanLine.length);

        if (cleanLine.length > 0 && clampedOffset < cleanLine.length) {
            const rawSlice = sliceSafe(cleanLine, clampedOffset, clampedOffset + charLimit);
            let actualEnd = clampedOffset + rawSlice.length;
            bodySlice = rawSlice;

            const remainingBudget = contentByteBudget - accumulatedBytes - utf8ByteLength(prefix);
            if (formattedLines.length === 0 && remainingBudget > 128 && utf8ByteLength(bodySlice) > remainingBudget - 96) {
                bodySlice = truncateToUtf8BytesSafe(bodySlice, Math.max(64, remainingBudget - 96));
                actualEnd = clampedOffset + bodySlice.length;
            }

            if (clampedOffset > 0 || actualEnd < cleanLine.length) {
                lineCharTruncated = true;
                suffix = actualEnd < cleanLine.length
                    ? ` ... [line ${lineNum} chars ${clampedOffset + 1}-${actualEnd} of ${cleanLine.length}; pass start_line=${lineNum}, end_line=${lineNum}, char_offset=${actualEnd} to continue]`
                    : ` ... [line ${lineNum} chars ${clampedOffset + 1}-${actualEnd} of ${cleanLine.length}]`;
            }
        } else if (charOffset > 0 && cleanLine.length > 0) {
            lineCharTruncated = true;
            suffix = `[line ${lineNum} has ${cleanLine.length} chars; char_offset=${charOffset} is at end of line]`;
        }

        const renderedLine = `${prefix}${bodySlice}${suffix}`;
        const lineBytes = utf8ByteLength(renderedLine) + (formattedLines.length > 0 ? 1 : 0);

        if (formattedLines.length > 0 && accumulatedBytes + lineBytes > contentByteBudget) {
            byteTruncated = true;
            break;
        }

        formattedLines.push(renderedLine);
        accumulatedBytes += lineBytes;
        shownEndLine = lineNum;
    }

    const hasMore = shownEndLine < totalLines;
    const truncated = (hasMore && (hitSoftLineCap || byteTruncated)) || lineCharTruncated || byteTruncated;
    const coveredFullFile =
        effectiveStart === 1
        && shownEndLine === totalLines
        && !lineCharTruncated
        && !byteTruncated
        && charOffset === 0;

    const nextStart = shownEndLine + 1;
    const nextEnd = Math.min(totalLines, shownEndLine + softMaxLines);
    const headerParts = [
        `File: ${options.path}`,
        `lines ${effectiveStart}-${shownEndLine} of ${totalLines}`,
        formatByteSize(totalBytes),
    ];
    if (truncated) {
        headerParts.push('truncated');
    }
    if (hasMore) {
        headerParts.push(`next: start_line=${nextStart}, end_line=${nextEnd}`);
    }

    const outputParts = [`[${headerParts.join(' | ')}]`, ...formattedLines];
    if (hasMore && (hitSoftLineCap || byteTruncated)) {
        outputParts.push(
            `[... ${totalLines - shownEndLine} more line(s) omitted. Use read_file(path="${options.path}", start_line=${nextStart}, end_line=${nextEnd}) or grep_search(query=..., path_prefix="${options.path}") to jump directly.]`,
        );
    }

    return {
        text: outputParts.join('\n'),
        totalLines,
        totalBytes,
        shownStartLine: effectiveStart,
        shownEndLine,
        hasMore,
        truncated,
        coveredFullFile,
    };
}

function buildLineStarts(content: string): number[] {
    if (!content) {
        return [];
    }
    const starts: number[] = [0];
    for (let i = 0; i < content.length; i += 1) {
        if (content.charCodeAt(i) === 10) {
            starts.push(i + 1);
        }
    }
    return starts;
}

function lineAtOffsetFromStarts(lineStarts: readonly number[], charOffset: number): number {
    if (lineStarts.length === 0) {
        return 1;
    }
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lineStarts[mid] <= charOffset) {
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return Math.max(1, high + 1);
}

function countNewlines(text: string): number {
    let count = 0;
    for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) === 10) {
            count += 1;
        }
    }
    return count;
}

function findAllOccurrences(haystack: string, needle: string, baseOffset: number): number[] {
    const indices: number[] = [];
    if (!needle) {
        return indices;
    }
    let cursor = 0;
    while (cursor <= haystack.length - needle.length) {
        const idx = haystack.indexOf(needle, cursor);
        if (idx < 0) {
            break;
        }
        indices.push(baseOffset + idx);
        cursor = idx + needle.length;
    }
    return indices;
}

function stripReadLineNumberPrefixes(snippet: string): string {
    return snippet
        .split('\n')
        .map((line) => line.replace(/^\s*>?\d+\|\s?/, ''))
        .join('\n');
}

/**
 * Validate and atomically apply one or more text edit operations against `content`,
 * enforcing unambiguous matching, line-range bounds, overlap detection, and verbatim
 * `$`-safe replacement.
 */
export function applyTextEdits(params: ApplyTextEditsParams): ApplyTextEditsResult {
    const lineOffset = Math.max(0, Math.floor(params.lineOffset ?? 0));
    const edits = params.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
        return {
            ok: false,
            code: 'INVALID_EDITS',
            path: params.path,
            message: `edit_file requires at least one edit operation for ${params.path}.`,
        };
    }

    const content = params.content;
    const lineStarts = buildLineStarts(content);
    const bodyLineCount = lineStarts.length;

    interface PlannedSpan {
        start: number;
        end: number;
        replace: string;
    }

    const spans: PlannedSpan[] = [];
    const allMatchLines: number[] = [];

    for (let opIdx = 0; opIdx < edits.length; opIdx += 1) {
        const op = edits[opIdx];
        if (!op || typeof op.search !== 'string' || op.search.length === 0 || typeof op.replace !== 'string') {
            return {
                ok: false,
                code: 'INVALID_EDITS',
                path: params.path,
                message: `Edit #${opIdx + 1} for ${params.path} must provide non-empty "search" and string "replace".`,
            };
        }

        const startLine = op.startLine !== undefined ? Math.floor(op.startLine) : undefined;
        const endLine = op.endLine !== undefined ? Math.floor(op.endLine) : undefined;

        if (startLine !== undefined && startLine < 1) {
            return {
                ok: false,
                code: 'INVALID_RANGE',
                path: params.path,
                message: `Invalid start_line (${startLine}) for ${params.path}: must be >= 1.`,
            };
        }
        if (endLine !== undefined && endLine < 1) {
            return {
                ok: false,
                code: 'INVALID_RANGE',
                path: params.path,
                message: `Invalid end_line (${endLine}) for ${params.path}: must be >= 1.`,
            };
        }
        if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
            return {
                ok: false,
                code: 'INVALID_RANGE',
                path: params.path,
                message: `Invalid line range for ${params.path}: start_line (${startLine}) must be <= end_line (${endLine}).`,
            };
        }

        if (lineOffset > 0 && endLine !== undefined && endLine <= lineOffset) {
            const label = params.readonlyHeaderLabel ?? 'header';
            return {
                ok: false,
                code: 'READONLY_REGION',
                path: params.path,
                message: `Lines 1-${lineOffset} of ${params.path} are read-only ${label}. Editable content starts at line ${lineOffset + 1}.`,
            };
        }

        const bodyStart = startLine !== undefined ? Math.max(1, startLine - lineOffset) : 1;
        const bodyEnd = endLine !== undefined ? endLine - lineOffset : undefined;

        if (bodyStart > Math.max(1, bodyLineCount)) {
            return {
                ok: false,
                code: 'INVALID_RANGE',
                path: params.path,
                message: `start_line (${startLine}) exceeds total lines (${bodyLineCount + lineOffset}) of ${params.path}.`,
            };
        }

        const regionStart = bodyLineCount === 0 ? 0 : lineStarts[bodyStart - 1];
        const regionEnd =
            bodyEnd !== undefined && bodyEnd < bodyLineCount
                ? lineStarts[bodyEnd]
                : content.length;

        const regionSlice = content.slice(regionStart, regionEnd);
        const offsets = findAllOccurrences(regionSlice, op.search, regionStart);

        if (offsets.length === 0) {
            const hints: string[] = [];
            const hasLinePrefix = op.search
                .split('\n')
                .some((l: string) => /^\s*>?\d+\|\s?/.test(l));
            if (hasLinePrefix) {
                const stripped = stripReadLineNumberPrefixes(op.search);
                if (stripped && stripped !== op.search && content.includes(stripped)) {
                    hints.push(
                        'Hint: Remove "N| " line-number prefixes copied from read_file output and pass only verbatim file text.',
                    );
                }
            }
            if ((startLine !== undefined || endLine !== undefined) && hints.length === 0) {
                const globalOffsets = findAllOccurrences(content, op.search, 0);
                if (globalOffsets.length > 0) {
                    const globalLines = globalOffsets.map(
                        (off) => lineAtOffsetFromStarts(lineStarts, off) + lineOffset,
                    );
                    const preview = globalLines.slice(0, 10).join(', ');
                    const suffix = globalLines.length > 10 ? ', ...' : '';
                    hints.push(
                        `Found outside requested range [${startLine ?? 1}..${endLine ?? bodyLineCount + lineOffset}] at line(s) [${preview}${suffix}].`,
                    );
                }
            }
            const rangeDesc =
                startLine !== undefined || endLine !== undefined
                    ? ` within lines ${startLine ?? 1}-${endLine ?? bodyLineCount + lineOffset}`
                    : '';
            const hintSuffix = hints.length > 0 ? ` ${hints.join(' ')}` : '';
            return {
                ok: false,
                code: 'NOT_FOUND',
                path: params.path,
                message: `Target text not found in ${params.path}${rangeDesc}.${hintSuffix}`,
            };
        }

        const matchLines = offsets.map((off) => lineAtOffsetFromStarts(lineStarts, off) + lineOffset);

        if (offsets.length > 1 && !op.replaceAll) {
            const preview = matchLines.slice(0, 20).join(', ');
            const suffix = matchLines.length > 20 ? ', ...' : '';
            return {
                ok: false,
                code: 'AMBIGUOUS_MATCH',
                path: params.path,
                matchLines,
                message: `Ambiguous edit in ${params.path}: search text matched ${offsets.length} times at line(s) [${preview}${suffix}]. Provide start_line/end_line, include more surrounding context in search, or set replace_all: true.`,
            };
        }

        for (let i = 0; i < offsets.length; i += 1) {
            spans.push({
                start: offsets[i],
                end: offsets[i] + op.search.length,
                replace: op.replace,
            });
            allMatchLines.push(matchLines[i]);
        }
    }

    spans.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i += 1) {
        if (spans[i - 1].end > spans[i].start) {
            return {
                ok: false,
                code: 'OVERLAPPING_EDITS',
                path: params.path,
                message: `Multiple edits overlap in ${params.path}; adjust target ranges or combine them.`,
            };
        }
    }

    // Reconstruct via slice concatenation so JS `$&` / `$$` / `$'` sequences stay verbatim.
    const parts: string[] = [];
    const changedRanges: ToolEditRange[] = [];
    let cursor = 0;
    let cumulativeLineDelta = 0;

    for (const span of spans) {
        parts.push(content.slice(cursor, span.start));
        parts.push(span.replace);
        cursor = span.end;

        const origStartLine = lineAtOffsetFromStarts(lineStarts, span.start) + lineOffset;
        const removedNewlines = countNewlines(content.slice(span.start, span.end));
        const addedNewlines = countNewlines(span.replace);
        const newStartLine = origStartLine + cumulativeLineDelta;
        const newEndLine = newStartLine + addedNewlines;
        changedRanges.push({ startLine: newStartLine, endLine: newEndLine });
        cumulativeLineDelta += addedNewlines - removedNewlines;
    }
    parts.push(content.slice(cursor));

    const updatedContent = parts.join('');
    const totalLines = countLines(updatedContent) + lineOffset;
    const bytes = utf8ByteLength(updatedContent);

    return {
        ok: true,
        path: params.path,
        message: `Edited ${params.path} (${spans.length} replacement${spans.length === 1 ? '' : 's'})`,
        updatedContent,
        matchLines: allMatchLines,
        changedRanges,
        replacements: spans.length,
        totalLines,
        bytes,
    };
}
