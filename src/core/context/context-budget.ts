import type { ApiConnection, VfsSearchHit } from '@/core/types';
import { grepLinesInText } from '@/core/vfs';

export const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024;
export const DEFAULT_SPILL_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SPILL_POOL_MAX_BYTES = 16 * 1024 * 1024;
export const SPILL_PATH_PREFIX = '/tmp/tool-spill/';

const SPILL_DIR_PATH = '/tmp/tool-spill';
const DEFAULT_FALLBACK_CONTEXT_SIZE = 64_000;
const DEFAULT_FALLBACK_MAX_TOKENS = 4_096;
const TEXT_HEAD_LINES = 120;
const TEXT_TAIL_LINES = 30;
const KEY_PREVIEW_MAX_CHARS = 100;

const textEncoder = new TextEncoder();

/** Return exact UTF-8 byte length of a string (pure, zero DOM/host deps). */
export function utf8ByteLength(text: string): number {
    if (!text) {
        return 0;
    }
    return textEncoder.encode(text).length;
}

function normalizeSpillLookupPath(rawPath: string): string | null {
    if (typeof rawPath !== 'string') {
        return null;
    }
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes('\0')) {
        return null;
    }
    const collapsed = `/${trimmed.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')}`;
    const segments = collapsed.split('/');
    if (segments.includes('..')) {
        return null;
    }
    return collapsed.length > 1 && collapsed.endsWith('/')
        ? collapsed.slice(0, -1)
        : collapsed;
}

/** Return true if `path` targets the transient `/tmp/tool-spill/*` virtual mount (without traversal). */
export function isSpillPath(path: string): boolean {
    const normalized = normalizeSpillLookupPath(path);
    if (!normalized) {
        return false;
    }
    return normalized === SPILL_DIR_PATH || normalized.startsWith(SPILL_PATH_PREFIX);
}

function sanitizeSpillId(rawId: string): string {
    const cleaned = rawId
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^\.+/, '');
    return cleaned || 'spill';
}

function truncateToUtf8Bytes(text: string, maxBytes: number): string {
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
        let end = mid;
        if (end > 0) {
            const code = text.charCodeAt(end - 1);
            if (code >= 0xd800 && code <= 0xdbff) {
                end -= 1;
            }
        }
        if (utf8ByteLength(text.slice(0, end)) <= maxBytes) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }

    let finalEnd = low;
    if (finalEnd > 0) {
        const code = text.charCodeAt(finalEnd - 1);
        if (code >= 0xd800 && code <= 0xdbff) {
            finalEnd -= 1;
        }
    }
    return text.slice(0, finalEnd);
}

function truncateTailToUtf8Bytes(text: string, maxBytes: number): string {
    if (maxBytes <= 0 || !text) {
        return '';
    }
    if (utf8ByteLength(text) <= maxBytes) {
        return text;
    }

    let low = 0;
    let high = text.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        let start = mid;
        if (start < text.length) {
            const code = text.charCodeAt(start);
            if (code >= 0xdc00 && code <= 0xdfff) {
                start += 1;
            }
        }
        if (utf8ByteLength(text.slice(start)) <= maxBytes) {
            high = mid;
        } else {
            low = mid + 1;
        }
    }

    let finalStart = low;
    if (finalStart < text.length) {
        const code = text.charCodeAt(finalStart);
        if (code >= 0xdc00 && code <= 0xdfff) {
            finalStart += 1;
        }
    }
    return text.slice(finalStart);
}

function clampInt(value: number, min: number, max: number): number {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.min(hi, Math.max(lo, Math.floor(value)));
}

function inferModelContextLimit(model: string | undefined): number {
    const normalized = (model ?? '').trim().toLowerCase();
    if (!normalized) {
        return DEFAULT_FALLBACK_CONTEXT_SIZE;
    }
    if (normalized.includes('gemini-1.5') || normalized.includes('gemini-2') || normalized.includes('gemini-3') || normalized.includes('gemini-pro') || normalized.includes('gemini-flash')) {
        return 1_048_576;
    }
    if (normalized.includes('gpt-4.1') || normalized.includes('gpt-5')) {
        return 1_000_000;
    }
    if (normalized.includes('claude-3') || normalized.includes('claude-4') || normalized.includes('claude-sonnet') || normalized.includes('claude-opus') || normalized.includes('claude-haiku')) {
        return 200_000;
    }
    if (/\b(?:o1|o3|o4)\b/.test(normalized) || /(?:^|[/:_-])(?:o1|o3|o4)(?:$|[/:_-])/.test(normalized)) {
        return 200_000;
    }
    if (normalized.includes('gpt-4o') || normalized.includes('gpt-4-turbo') || normalized.includes('qwen') || normalized.includes('kimi') || normalized.includes('moonshot') || normalized.includes('glm-4')) {
        return 128_000;
    }
    if (normalized.includes('deepseek')) {
        return 64_000;
    }
    return DEFAULT_FALLBACK_CONTEXT_SIZE;
}

// ============================================================================
// Effective Context Budget Resolution
// ============================================================================

export interface EffectiveContextBudget {
    /** Total context window size (from `ApiConnection.contextSize`, `providerLimitOverride`, or model fallback). */
    contextLimit: number;
    /** Reserved output token headroom (`clamp(connection.maxTokens, 1024, floor(contextLimit * 0.25))`). */
    reservedOutputTokens: number;
    /** Safe usable input token budget (`contextLimit - reservedOutputTokens - safetyMargin`). */
    safeInputBudget: number;
    /** Pre-flight compaction threshold (`floor(safeInputBudget * 0.88)`). */
    preFlightThreshold: number;
    /** Adaptive auto-compaction high/low watermarks (strictly bounded within `safeInputBudget`). */
    autoHighWatermark: number;
    autoLowWatermark: number;
}

export interface ResolveEffectiveContextBudgetOptions {
    configuredWatermark?: { high: number; low: number };
    providerLimitOverride?: number;
}

export function resolveEffectiveContextBudget(
    connection: Pick<ApiConnection, 'contextSize' | 'maxTokens' | 'model'>,
    options?: ResolveEffectiveContextBudgetOptions,
): EffectiveContextBudget {
    const configuredContextSize =
        typeof connection.contextSize === 'number' && Number.isFinite(connection.contextSize) && connection.contextSize > 0
            ? Math.floor(connection.contextSize)
            : undefined;

    const overrideLimit =
        typeof options?.providerLimitOverride === 'number'
        && Number.isFinite(options.providerLimitOverride)
        && options.providerLimitOverride > 0
            ? Math.floor(options.providerLimitOverride)
            : undefined;

    const baseLimit = overrideLimit ?? configuredContextSize ?? inferModelContextLimit(connection.model);
    const contextLimit = Math.max(1024, baseLimit);

    const maxReserved = Math.floor(contextLimit * 0.25);
    const minReserved = Math.min(1024, maxReserved);
    const rawMaxTokens =
        typeof connection.maxTokens === 'number' && Number.isFinite(connection.maxTokens) && connection.maxTokens > 0
            ? Math.floor(connection.maxTokens)
            : DEFAULT_FALLBACK_MAX_TOKENS;
    const reservedOutputTokens = clampInt(rawMaxTokens, minReserved, maxReserved);

    const remainingAfterOutput = Math.max(256, contextLimit - reservedOutputTokens);
    const maxSafety = Math.min(8192, Math.floor(remainingAfterOutput * 0.2));
    const minSafety = Math.min(512, maxSafety);
    const safetyMargin = clampInt(Math.floor(contextLimit * 0.05), minSafety, maxSafety);

    const safeInputBudget = Math.max(256, contextLimit - reservedOutputTokens - safetyMargin);
    const preFlightThreshold = Math.max(1, Math.floor(safeInputBudget * 0.88));

    const defaultHigh = Math.max(2, Math.floor(safeInputBudget * 0.75));
    const defaultLow = Math.max(1, Math.floor(safeInputBudget * 0.45));

    const configured = options?.configuredWatermark;
    const hasConfiguredHigh =
        typeof configured?.high === 'number' && Number.isFinite(configured.high) && configured.high > 0;
    const hasConfiguredLow =
        typeof configured?.low === 'number' && Number.isFinite(configured.low) && configured.low > 0;

    const autoHighWatermark = hasConfiguredHigh
        ? clampInt(configured!.high, 2, preFlightThreshold)
        : clampInt(defaultHigh, 2, preFlightThreshold);

    const maxLow = Math.max(1, autoHighWatermark - 1);
    let autoLowWatermark: number;
    if (hasConfiguredLow) {
        if (configured!.low < autoHighWatermark) {
            autoLowWatermark = clampInt(configured!.low, 1, maxLow);
        } else {
            autoLowWatermark = clampInt(Math.floor(autoHighWatermark * 0.5), 1, maxLow);
        }
    } else {
        autoLowWatermark = clampInt(Math.min(defaultLow, Math.floor(autoHighWatermark * 0.6)), 1, maxLow);
    }

    return {
        contextLimit,
        reservedOutputTokens,
        safeInputBudget,
        preFlightThreshold,
        autoHighWatermark,
        autoLowWatermark,
    };
}

// ============================================================================
// Transient In-Memory LRU Tool Spill Store
// ============================================================================

export interface SpillEntry {
    /** Virtual read-only retrieval path, e.g. "/tmp/tool-spill/call_abc123.txt". */
    path: string;
    toolName: string;
    content: string;
    byteLength: number;
    lineCount: number;
    createdAt: number;
}

export interface TransientToolSpillStoreOptions {
    maxEntryBytes?: number;
    maxPoolBytes?: number;
}

export interface SpillPutParams {
    toolCallId: string;
    toolName: string;
    content: string;
    scopeId?: string;
    extension?: 'txt' | 'json';
}

export interface SpillGrepOptions {
    caseSensitive?: boolean;
    regex?: boolean;
    limit?: number;
    contextLines?: number;
    maxMatchesPerFile?: number;
}

interface InternalSpillRecord {
    entry: SpillEntry;
    scopeId?: string;
}

/**
 * In-memory LRU transient spill store holding redacted full outputs of truncated
 * tool calls under `/tmp/tool-spill/*`. Never persisted to `chat_metadata`.
 */
export class TransientToolSpillStore {
    public readonly maxEntryBytes: number;
    public readonly maxPoolBytes: number;

    private readonly records = new Map<string, InternalSpillRecord>();
    private readonly scopeIndex = new Map<string, Set<string>>();
    private currentTotalBytes = 0;

    constructor(options: TransientToolSpillStoreOptions = {}) {
        this.maxEntryBytes = Math.max(
            64,
            Math.floor(options.maxEntryBytes ?? DEFAULT_SPILL_MAX_ENTRY_BYTES),
        );
        this.maxPoolBytes = Math.max(
            64,
            Math.floor(options.maxPoolBytes ?? DEFAULT_SPILL_POOL_MAX_BYTES),
        );
    }

    get totalBytes(): number {
        return this.currentTotalBytes;
    }

    get size(): number {
        return this.records.size;
    }

    listPaths(scopeId?: string): string[] {
        if (scopeId !== undefined) {
            return Array.from(this.scopeIndex.get(scopeId) ?? []);
        }
        return Array.from(this.records.keys());
    }

    put(params: SpillPutParams): SpillEntry {
        const ext = params.extension === 'json' ? 'json' : 'txt';
        const safeId = sanitizeSpillId(params.toolCallId);
        const path = `${SPILL_PATH_PREFIX}${safeId}.${ext}`;
        const ceiling = Math.min(this.maxEntryBytes, this.maxPoolBytes);

        let storedContent = params.content;
        let byteLength = utf8ByteLength(storedContent);
        if (byteLength > ceiling) {
            const marker = '\n...[truncated to spill entry byte limit]';
            const markerBytes = utf8ByteLength(marker);
            if (ceiling > markerBytes + 16) {
                storedContent = `${truncateToUtf8Bytes(storedContent, ceiling - markerBytes)}${marker}`;
            } else {
                storedContent = truncateToUtf8Bytes(storedContent, ceiling);
            }
            byteLength = utf8ByteLength(storedContent);
        }

        const lineCount = storedContent.length === 0 ? 0 : storedContent.split('\n').length;
        const entry: SpillEntry = {
            path,
            toolName: params.toolName,
            content: storedContent,
            byteLength,
            lineCount,
            createdAt: Date.now(),
        };

        // Remove existing record for the same path before re-inserting as MRU.
        this.deleteRecord(path);

        // Evict least-recently-used entries until pool budget accommodates the new entry.
        while (this.currentTotalBytes + byteLength > this.maxPoolBytes && this.records.size > 0) {
            const oldestKey = this.records.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.deleteRecord(oldestKey);
        }

        this.records.set(path, { entry, scopeId: params.scopeId });
        this.currentTotalBytes += byteLength;

        if (params.scopeId) {
            let bucket = this.scopeIndex.get(params.scopeId);
            if (!bucket) {
                bucket = new Set<string>();
                this.scopeIndex.set(params.scopeId, bucket);
            }
            bucket.add(path);
        }

        return entry;
    }

    get(path: string): SpillEntry | null {
        const normalized = normalizeSpillLookupPath(path);
        if (!normalized) {
            return null;
        }
        const record = this.records.get(normalized);
        if (!record) {
            return null;
        }
        // Refresh LRU recency.
        this.records.delete(normalized);
        this.records.set(normalized, record);
        return record.entry;
    }

    readSlice(path: string, startLine?: number, endLine?: number): string | null {
        const entry = this.get(path);
        if (!entry) {
            return null;
        }
        if (startLine === undefined && endLine === undefined) {
            return entry.content;
        }
        const lines = entry.content.split('\n');
        const start = startLine !== undefined ? Math.max(0, Math.floor(startLine) - 1) : 0;
        const end = endLine !== undefined ? Math.max(start, Math.floor(endLine)) : lines.length;
        return lines.slice(start, end).join('\n');
    }

    grep(path: string, query: string, opts: SpillGrepOptions = {}): VfsSearchHit[] {
        const normalized = normalizeSpillLookupPath(path);
        if (!normalized || !query) {
            return [];
        }

        const caseSensitive = opts.caseSensitive !== false;
        const limit = Math.max(1, Math.floor(opts.limit ?? 100));

        const targetEntries: SpillEntry[] = [];
        const exact = this.get(normalized);
        if (exact) {
            targetEntries.push(exact);
        } else if (normalized === SPILL_DIR_PATH) {
            for (const rec of this.records.values()) {
                targetEntries.push(rec.entry);
            }
        } else if (normalized.startsWith(SPILL_PATH_PREFIX)) {
            const prefixWithSlash = `${normalized}/`;
            for (const rec of this.records.values()) {
                if (rec.entry.path.startsWith(prefixWithSlash)) {
                    targetEntries.push(rec.entry);
                }
            }
        }

        // Validate regex even when targetEntries is empty to preserve consistent error behavior.
        if (opts.regex) {
            try {
                new RegExp(query, caseSensitive ? '' : 'i');
            } catch (error) {
                throw new Error(`Invalid grep regex: ${(error as Error).message}`);
            }
        }

        const hits: VfsSearchHit[] = [];
        for (const entry of targetEntries) {
            const remaining = limit - hits.length;
            if (remaining <= 0) {
                break;
            }
            const maxMatches =
                opts.maxMatchesPerFile !== undefined
                    ? Math.min(remaining, Math.max(1, Math.floor(opts.maxMatchesPerFile)))
                    : remaining;
            const entryHits = grepLinesInText({
                path: entry.path,
                title: entry.toolName,
                content: entry.content,
                query,
                caseSensitive,
                regex: Boolean(opts.regex),
                contextLines: opts.contextLines,
                maxMatches,
                matchedTerms: [query],
            });
            hits.push(...entryHits);
            if (hits.length >= limit) {
                return hits.slice(0, limit);
            }
        }

        return hits;
    }

    clearScope(scopeId: string): void {
        const bucket = this.scopeIndex.get(scopeId);
        if (!bucket) {
            return;
        }
        for (const path of Array.from(bucket)) {
            this.deleteRecord(path);
        }
        this.scopeIndex.delete(scopeId);
    }

    clearAll(): void {
        this.records.clear();
        this.scopeIndex.clear();
        this.currentTotalBytes = 0;
    }

    private deleteRecord(path: string): void {
        const existing = this.records.get(path);
        if (!existing) {
            return;
        }
        this.records.delete(path);
        this.currentTotalBytes = Math.max(0, this.currentTotalBytes - existing.entry.byteLength);
        if (existing.scopeId) {
            const bucket = this.scopeIndex.get(existing.scopeId);
            if (bucket) {
                bucket.delete(path);
                if (bucket.size === 0) {
                    this.scopeIndex.delete(existing.scopeId);
                }
            }
        }
    }
}

// ============================================================================
// Tool Output Hard Gate (Key Manifest + Head/Tail Truncation + Spill Pointer)
// ============================================================================

export interface ToolOutputGateOptions {
    toolName: string;
    toolCallId: string;
    /** Maximum UTF-8 byte budget for a single tool result (default 32 KB). */
    maxBytes?: number;
    /** Optional pre-parsed structured data used to construct a JSON Key Manifest without re-parsing. */
    rawData?: unknown;
    spillStore?: TransientToolSpillStore;
    scopeId?: string;
}

export interface ToolOutputGateResult {
    output: string;
    truncated: boolean;
    originalBytes: number;
    finalBytes: number;
    spillPath?: string;
}

export interface ToolOutputKeyManifestItem {
    key: string;
    type: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean';
    bytes: number;
    itemCount?: number;
    preview: string;
}

function classifyJsonValueType(value: unknown): ToolOutputKeyManifestItem['type'] {
    if (value === null || value === undefined) {
        return 'null';
    }
    if (Array.isArray(value)) {
        return 'array';
    }
    switch (typeof value) {
        case 'object':
            return 'object';
        case 'string':
            return 'string';
        case 'number':
            return 'number';
        case 'boolean':
            return 'boolean';
        default:
            return 'string';
    }
}

function safeJsonStringify(value: unknown): string {
    try {
        const serialized = JSON.stringify(value);
        return serialized === undefined ? 'null' : serialized;
    } catch {
        return String(value);
    }
}

function formatPreview(value: unknown, serialized: string, maxChars: number = KEY_PREVIEW_MAX_CHARS): string {
    const raw = typeof value === 'string' ? value : serialized;
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= maxChars) {
        return collapsed;
    }
    return `${collapsed.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

function resolveStructuredJson(rawOutput: string, rawData: unknown): unknown {
    if (rawData !== undefined && rawData !== null && typeof rawData === 'object') {
        return rawData;
    }
    if (rawData === undefined) {
        const trimmed = rawOutput.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(rawOutput) as unknown;
                if (parsed !== null && typeof parsed === 'object') {
                    return parsed;
                }
            } catch {
                // Fall back to plain-text gate
            }
        }
    }
    return null;
}

function buildJsonObjectManifestOutput(
    record: Record<string, unknown>,
    params: {
        toolName: string;
        originalBytes: number;
        maxBytes: number;
        spillEntry?: SpillEntry;
    },
): string {
    const entries = Object.entries(record);
    const items: ToolOutputKeyManifestItem[] = entries.map(([key, value]) => {
        const type = classifyJsonValueType(value);
        const serialized = safeJsonStringify(value);
        const bytes = utf8ByteLength(serialized);
        const itemCount =
            type === 'array'
                ? (value as unknown[]).length
                : type === 'object'
                    ? Object.keys(value as Record<string, unknown>).length
                    : undefined;
        return {
            key,
            type,
            bytes,
            ...(itemCount !== undefined ? { itemCount } : {}),
            preview: formatPreview(value, serialized),
        };
    });

    items.sort((a, b) => b.bytes - a.bytes || compareCodeUnits(a.key, b.key));

    const hint = params.spillEntry
        ? `Output exceeded ${params.maxBytes} bytes (${params.originalBytes} bytes). Drill down by specific keyPath/filter, or inspect ${params.spillEntry.path} (${params.spillEntry.lineCount} lines) via read_file / grep_search.`
        : `Output exceeded ${params.maxBytes} bytes (${params.originalBytes} bytes). Drill down by specific keyPath or narrower query filters.`;

    const buildEnvelope = (manifestSlice: ToolOutputKeyManifestItem[]): string =>
        JSON.stringify({
            truncated: true,
            tool: params.toolName,
            originalBytes: params.originalBytes,
            maxBytes: params.maxBytes,
            totalKeys: items.length,
            shownKeys: manifestSlice.length,
            omittedKeys: Math.max(0, items.length - manifestSlice.length),
            manifest: manifestSlice,
            ...(params.spillEntry
                ? {
                    spillPath: params.spillEntry.path,
                    spillLineCount: params.spillEntry.lineCount,
                }
                : {}),
            hint,
        });

    const selected: ToolOutputKeyManifestItem[] = [];
    for (const item of items) {
        const candidate = [...selected, item];
        if (utf8ByteLength(buildEnvelope(candidate)) <= params.maxBytes) {
            selected.push(item);
        } else {
            break;
        }
    }

    const encoded = buildEnvelope(selected);
    if (utf8ByteLength(encoded) <= params.maxBytes) {
        return encoded;
    }

    // Ultra-small maxBytes fallback: emit a minimal JSON object or hard-truncated summary.
    const minimal = JSON.stringify({
        truncated: true,
        tool: params.toolName,
        originalBytes: params.originalBytes,
        totalKeys: items.length,
        ...(params.spillEntry ? { spillPath: params.spillEntry.path } : {}),
    });
    return utf8ByteLength(minimal) <= params.maxBytes
        ? minimal
        : truncateToUtf8Bytes(minimal, params.maxBytes);
}

interface ToolOutputArraySampleItem {
    index: number;
    type: ToolOutputKeyManifestItem['type'];
    bytes: number;
    itemCount?: number;
    preview: string;
}

function buildJsonArrayManifestOutput(
    arr: unknown[],
    params: {
        toolName: string;
        originalBytes: number;
        maxBytes: number;
        spillEntry?: SpillEntry;
    },
): string {
    const sampleLimit = Math.min(arr.length, 50);
    const sampleCandidates: ToolOutputArraySampleItem[] = [];
    for (let i = 0; i < sampleLimit; i += 1) {
        const value = arr[i];
        const type = classifyJsonValueType(value);
        const serialized = safeJsonStringify(value);
        const bytes = utf8ByteLength(serialized);
        const itemCount =
            type === 'array'
                ? (value as unknown[]).length
                : type === 'object'
                    ? Object.keys(value as Record<string, unknown>).length
                    : undefined;
        sampleCandidates.push({
            index: i,
            type,
            bytes,
            ...(itemCount !== undefined ? { itemCount } : {}),
            preview: formatPreview(value, serialized),
        });
    }

    const hint = params.spillEntry
        ? `Array output (${arr.length} items) exceeded ${params.maxBytes} bytes (${params.originalBytes} bytes). Narrow your query or inspect ${params.spillEntry.path} (${params.spillEntry.lineCount} lines) via read_file / grep_search.`
        : `Array output (${arr.length} items) exceeded ${params.maxBytes} bytes (${params.originalBytes} bytes). Narrow your query or paginate results.`;

    const buildEnvelope = (samples: typeof sampleCandidates): string =>
        JSON.stringify({
            truncated: true,
            tool: params.toolName,
            type: 'array',
            originalBytes: params.originalBytes,
            maxBytes: params.maxBytes,
            itemCount: arr.length,
            shownItems: samples.length,
            omittedItems: Math.max(0, arr.length - samples.length),
            samples,
            ...(params.spillEntry
                ? {
                    spillPath: params.spillEntry.path,
                    spillLineCount: params.spillEntry.lineCount,
                }
                : {}),
            hint,
        });

    const selected: typeof sampleCandidates = [];
    for (const sample of sampleCandidates) {
        const candidate = [...selected, sample];
        if (utf8ByteLength(buildEnvelope(candidate)) <= params.maxBytes) {
            selected.push(sample);
        } else {
            break;
        }
    }

    const encoded = buildEnvelope(selected);
    if (utf8ByteLength(encoded) <= params.maxBytes) {
        return encoded;
    }

    const minimal = JSON.stringify({
        truncated: true,
        tool: params.toolName,
        type: 'array',
        originalBytes: params.originalBytes,
        itemCount: arr.length,
        ...(params.spillEntry ? { spillPath: params.spillEntry.path } : {}),
    });
    return utf8ByteLength(minimal) <= params.maxBytes
        ? minimal
        : truncateToUtf8Bytes(minimal, params.maxBytes);
}

function buildTextTruncatedOutput(
    rawOutput: string,
    params: {
        originalBytes: number;
        maxBytes: number;
        spillEntry?: SpillEntry;
    },
): string {
    const lines = rawOutput.split('\n');
    const totalLines = lines.length;

    const footer = params.spillEntry
        ? `\n[Full output (${params.originalBytes} bytes, ${totalLines} lines) spilled to ${params.spillEntry.path}. Use read_file(path="${params.spillEntry.path}", start_line=..., end_line=...) or grep_search(query=..., path_prefix="${params.spillEntry.path}") to inspect.]`
        : `\n[Output truncated from ${params.originalBytes} bytes (${totalLines} lines) to fit ${params.maxBytes} byte limit.]`;

    const makeBanner = (omittedLines: number): string =>
        omittedLines > 0
            ? `\n... [omitted ${omittedLines} lines; total ${params.originalBytes} bytes, ${totalLines} lines] ...\n`
            : `\n... [truncated middle content; total ${params.originalBytes} bytes, ${totalLines} lines] ...\n`;

    const footerBytes = utf8ByteLength(footer);

    // Fast path: standard multi-line head (120 lines) + omission banner + tail (30 lines)
    if (totalLines > TEXT_HEAD_LINES + TEXT_TAIL_LINES) {
        const headText = lines.slice(0, TEXT_HEAD_LINES).join('\n');
        const tailText = lines.slice(-TEXT_TAIL_LINES).join('\n');
        const banner = makeBanner(totalLines - TEXT_HEAD_LINES - TEXT_TAIL_LINES);
        const combined = `${headText}${banner}${tailText}${footer}`;
        if (utf8ByteLength(combined) <= params.maxBytes) {
            return combined;
        }
    }

    // Budgeted fallback: handles huge single-line blobs or very long lines while strictly enforcing maxBytes.
    const worstBanner = makeBanner(totalLines);
    const overheadBytes = footerBytes + utf8ByteLength(worstBanner);
    const contentBudget = params.maxBytes - overheadBytes;

    if (contentBudget <= 32) {
        const compactNotice = params.spillEntry
            ? `[Truncated ${params.originalBytes} bytes (${totalLines} lines). Spill: ${params.spillEntry.path}]`
            : `[Truncated ${params.originalBytes} bytes (${totalLines} lines) to ${params.maxBytes}B]`;
        return truncateToUtf8Bytes(compactNotice, params.maxBytes);
    }

    const headBudget = Math.floor(contentBudget * 0.75);
    const tailBudget = Math.max(0, contentBudget - headBudget);

    let headText = '';
    let tailText = '';
    let keptHeadLines = 0;
    let keptTailLines = 0;

    if (totalLines > 2) {
        // Pack as many leading lines (up to TEXT_HEAD_LINES) as fit inside headBudget.
        const headParts: string[] = [];
        let headBytes = 0;
        const headCap = Math.min(TEXT_HEAD_LINES, totalLines - 1);
        for (let i = 0; i < headCap; i += 1) {
            const line = lines[i];
            const addBytes = utf8ByteLength(line) + (headParts.length > 0 ? 1 : 0);
            if (headBytes + addBytes > headBudget) {
                if (headParts.length === 0) {
                    headParts.push(truncateToUtf8Bytes(line, headBudget));
                    keptHeadLines = 1;
                }
                break;
            }
            headParts.push(line);
            headBytes += addBytes;
            keptHeadLines = headParts.length;
        }
        headText = headParts.join('\n');

        // Pack as many trailing lines (up to TEXT_TAIL_LINES) as fit inside tailBudget.
        const tailParts: string[] = [];
        let tailBytes = 0;
        const tailStartFloor = Math.max(keptHeadLines, totalLines - TEXT_TAIL_LINES);
        for (let i = totalLines - 1; i >= tailStartFloor; i -= 1) {
            const line = lines[i];
            const addBytes = utf8ByteLength(line) + (tailParts.length > 0 ? 1 : 0);
            if (tailBytes + addBytes > tailBudget) {
                if (tailParts.length === 0 && tailBudget > 0) {
                    tailParts.push(truncateTailToUtf8Bytes(line, tailBudget));
                    keptTailLines = 1;
                }
                break;
            }
            tailParts.push(line);
            tailBytes += addBytes;
            keptTailLines = tailParts.length;
        }
        tailParts.reverse();
        tailText = tailParts.join('\n');
    } else {
        headText = truncateToUtf8Bytes(rawOutput, headBudget);
        tailText = truncateTailToUtf8Bytes(rawOutput, tailBudget);
    }

    const omittedLines = Math.max(0, totalLines - keptHeadLines - keptTailLines);
    const banner = makeBanner(omittedLines);
    const assembled = `${headText}${banner}${tailText}${footer}`;
    return utf8ByteLength(assembled) <= params.maxBytes
        ? assembled
        : truncateToUtf8Bytes(assembled, params.maxBytes);
}

/**
 * Unified single-tool-output size gate.
 * - Passes through untouched when UTF-8 bytes <= `maxBytes` (default 32 KB).
 * - When exceeded, optionally spills the full (already redacted) output into
 *   `TransientToolSpillStore` and returns either a descending-byte JSON Key Manifest
 *   (for JSON payloads) or a head+tail bounded excerpt with spill navigation hints.
 */
export function applyToolOutputGate(
    rawOutput: string,
    options: ToolOutputGateOptions,
): ToolOutputGateResult {
    const maxBytes = Math.max(128, Math.floor(options.maxBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES));
    const originalBytes = utf8ByteLength(rawOutput);

    if (originalBytes <= maxBytes) {
        return {
            output: rawOutput,
            truncated: false,
            originalBytes,
            finalBytes: originalBytes,
        };
    }

    const structured = resolveStructuredJson(rawOutput, options.rawData);
    const isJson = structured !== null;

    const spillEntry = options.spillStore
        ? options.spillStore.put({
            toolCallId: options.toolCallId,
            toolName: options.toolName,
            content: rawOutput,
            scopeId: options.scopeId,
            extension: isJson ? 'json' : 'txt',
        })
        : undefined;

    let output: string;
    if (structured !== null) {
        output = Array.isArray(structured)
            ? buildJsonArrayManifestOutput(structured, {
                toolName: options.toolName,
                originalBytes,
                maxBytes,
                spillEntry,
            })
            : buildJsonObjectManifestOutput(structured as Record<string, unknown>, {
                toolName: options.toolName,
                originalBytes,
                maxBytes,
                spillEntry,
            });
    } else {
        output = buildTextTruncatedOutput(rawOutput, {
            originalBytes,
            maxBytes,
            spillEntry,
        });
    }

    const finalBytes = utf8ByteLength(output);
    return {
        output,
        truncated: true,
        originalBytes,
        finalBytes,
        ...(spillEntry ? { spillPath: spillEntry.path } : {}),
    };
}
