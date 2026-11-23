import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
    SideClueDelivery,
    SideClueDoc,
    SideClueMeta,
    SideClueStatus,
} from '../types';
import { normalizeVfsPath } from './glob';
import { hashText, hashTextSync } from './xxhash';

export const SIDE_CLUE_DELIVERIES = [
    'none',
    'vfs_only',
    'radar_hint',
    'next_turn_brief',
] as const;

export const SIDE_CLUE_STATUSES = [
    'dormant',
    'surfaced',
    'resolved',
] as const;

export const DEFAULT_SIDE_CLUE_DELIVERY: SideClueDelivery = 'radar_hint';
export const DEFAULT_SIDE_CLUE_STATUS: SideClueStatus = 'dormant';

export interface ParsedSideClueRaw {
    path: string;
    meta: SideClueMeta;
    body: string;
    hasFrontmatter: boolean;
}

export interface SerializedSideClueResult {
    content: string;
    doc: SideClueDoc;
}

export function isValidSideClueDelivery(value: unknown): value is SideClueDelivery {
    return (
        typeof value === 'string' &&
        (SIDE_CLUE_DELIVERIES as readonly string[]).includes(value)
    );
}

export function isValidSideClueStatus(value: unknown): value is SideClueStatus {
    return (
        typeof value === 'string' &&
        (SIDE_CLUE_STATUSES as readonly string[]).includes(value)
    );
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

function safeNormalizePath(path: string): string {
    try {
        return normalizeVfsPath(path);
    } catch {
        return path.startsWith('/') ? path : `/${path}`;
    }
}

function deriveDefaultId(normalizedPath: string): string {
    const withoutPrefix = normalizedPath.replace(/^\/side\/?/, '').replace(/\.md$/i, '');
    const slug = withoutPrefix
        .replace(/[^a-zA-Z0-9\p{L}_-]+/gu, '_')
        .replace(/^_+|_+$/g, '');
    return slug ? `clue_${slug}` : 'clue_untitled';
}

function deriveDefaultTitle(normalizedPath: string, body: string): string {
    const headingMatch = /^\s*#\s+(.+)$/m.exec(body);
    if (headingMatch?.[1]?.trim()) {
        return headingMatch[1].trim();
    }
    const base = normalizedPath.split('/').filter(Boolean).pop() ?? 'untitled';
    return base.replace(/\.md$/i, '') || 'untitled';
}

function normalizeStringList(value: unknown): string[] {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }
    if (!Array.isArray(value)) {
        return [];
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') {
            continue;
        }
        const trimmed = item.trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return undefined;
}

function normalizeTimestamp(value: unknown, fallback: number): number {
    const num = normalizeOptionalFiniteNumber(value);
    if (num !== undefined && num >= 0) {
        return Math.floor(num);
    }
    return fallback;
}

/**
 * Split optional YAML frontmatter (`--- ... ---`) from the Markdown body.
 * Only an opening `---` fence at the start of the document is recognized; horizontal
 * rules inside the Markdown body are preserved verbatim.
 */
export function splitSideClueFrontmatter(raw: string): {
    frontmatter: string | null;
    body: string;
} {
    const stripped = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
    const normalized = normalizeLineEndings(stripped);

    if (!normalized.startsWith('---\n') && normalized !== '---') {
        return { frontmatter: null, body: normalized };
    }

    // Empty frontmatter block: `---\n---` (followed by optional `\n` and body)
    if (normalized.startsWith('---\n---')) {
        const afterFence = normalized.slice('---\n---'.length);
        if (afterFence === '') {
            return { frontmatter: '', body: '' };
        }
        if (afterFence.startsWith('\n')) {
            return { frontmatter: '', body: afterFence.slice(1) };
        }
    }

    const closeMatch = /\n---(?:\n|$)/.exec(normalized.slice(3));
    if (!closeMatch || closeMatch.index === undefined) {
        return { frontmatter: null, body: normalized };
    }

    const yamlStart = 4; // after `---\n`
    const yamlEnd = 3 + closeMatch.index;
    const bodyStart = yamlEnd + closeMatch[0].length;

    return {
        frontmatter: normalized.slice(yamlStart, yamlEnd),
        body: normalized.slice(bodyStart),
    };
}

/**
 * Build a validated, canonically structured `SideClueMeta` object from untrusted
 * parsed frontmatter fields and optional fallback defaults.
 */
export function normalizeSideClueMeta(
    raw: Record<string, unknown>,
    path: string,
    defaults?: Partial<SideClueMeta>,
    body: string = '',
): SideClueMeta {
    const normalizedPath = safeNormalizePath(path);

    const id =
        typeof raw.id === 'string' && raw.id.trim()
            ? raw.id.trim()
            : defaults?.id?.trim() || deriveDefaultId(normalizedPath);

    const title =
        typeof raw.title === 'string' && raw.title.trim()
            ? raw.title.trim()
            : defaults?.title?.trim() || deriveDefaultTitle(normalizedPath, body);

    const delivery: SideClueDelivery = isValidSideClueDelivery(raw.delivery)
        ? raw.delivery
        : isValidSideClueDelivery(defaults?.delivery)
            ? defaults.delivery
            : DEFAULT_SIDE_CLUE_DELIVERY;

    const status: SideClueStatus = isValidSideClueStatus(raw.status)
        ? raw.status
        : isValidSideClueStatus(defaults?.status)
            ? defaults.status
            : DEFAULT_SIDE_CLUE_STATUS;

    const keywords =
        raw.keywords !== undefined
            ? normalizeStringList(raw.keywords)
            : normalizeStringList(defaults?.keywords);

    const hasSecondaryKeys =
        Object.hasOwn(raw, 'secondaryKeys') || defaults?.secondaryKeys !== undefined;
    const secondaryKeys = hasSecondaryKeys
        ? normalizeStringList(
            Object.hasOwn(raw, 'secondaryKeys') ? raw.secondaryKeys : defaults?.secondaryKeys,
        )
        : undefined;

    const rawScanDepth = normalizeOptionalFiniteNumber(
        Object.hasOwn(raw, 'scanDepth') ? raw.scanDepth : defaults?.scanDepth,
    );
    const scanDepth =
        rawScanDepth !== undefined && rawScanDepth >= 0
            ? Math.floor(rawScanDepth)
            : undefined;

    const order = normalizeOptionalFiniteNumber(
        Object.hasOwn(raw, 'order') ? raw.order : defaults?.order,
    );

    const summary =
        typeof raw.summary === 'string'
            ? raw.summary.trim()
            : typeof defaults?.summary === 'string'
                ? defaults.summary.trim()
                : '';

    const rawSourceSession =
        typeof raw.sourceSessionId === 'string'
            ? raw.sourceSessionId.trim()
            : typeof defaults?.sourceSessionId === 'string'
                ? defaults.sourceSessionId.trim()
                : '';
    const sourceSessionId = rawSourceSession || undefined;

    const anchor =
        typeof raw.anchor === 'string' && raw.anchor.trim()
            ? raw.anchor.trim()
            : defaults?.anchor?.trim() || '0#0';

    const createdAt = normalizeTimestamp(raw.createdAt, defaults?.createdAt ?? 0);
    const updatedAt = normalizeTimestamp(raw.updatedAt, defaults?.updatedAt ?? createdAt);

    const rawConsumedByTurn = normalizeOptionalFiniteNumber(
        Object.hasOwn(raw, 'consumedByTurn') ? raw.consumedByTurn : defaults?.consumedByTurn,
    );
    const consumedByTurn =
        rawConsumedByTurn !== undefined && rawConsumedByTurn >= 0
            ? Math.floor(rawConsumedByTurn)
            : undefined;

    const meta: SideClueMeta = {
        id,
        title,
        delivery,
        status,
        keywords,
        ...(secondaryKeys !== undefined ? { secondaryKeys } : {}),
        ...(scanDepth !== undefined ? { scanDepth } : {}),
        ...(order !== undefined ? { order } : {}),
        summary,
        ...(sourceSessionId !== undefined ? { sourceSessionId } : {}),
        anchor,
        createdAt,
        updatedAt,
        ...(consumedByTurn !== undefined ? { consumedByTurn } : {}),
    };

    return meta;
}

/**
 * Canonically serialize a `/side/*` clue document (YAML frontmatter in deterministic
 * key order + Markdown body) using LF line endings.
 */
export function serializeSideClue(meta: SideClueMeta, body: string): string {
    const ordered: Record<string, unknown> = {
        id: meta.id,
        title: meta.title,
        delivery: meta.delivery,
        status: meta.status,
        keywords: normalizeStringList(meta.keywords),
    };

    if (meta.secondaryKeys !== undefined) {
        ordered.secondaryKeys = normalizeStringList(meta.secondaryKeys);
    }
    if (meta.scanDepth !== undefined && Number.isFinite(meta.scanDepth)) {
        ordered.scanDepth = Math.max(0, Math.floor(meta.scanDepth));
    }
    if (meta.order !== undefined && Number.isFinite(meta.order)) {
        ordered.order = meta.order;
    }

    ordered.summary = meta.summary ?? '';

    if (meta.sourceSessionId !== undefined && meta.sourceSessionId.trim() !== '') {
        ordered.sourceSessionId = meta.sourceSessionId.trim();
    }

    ordered.anchor = meta.anchor || '0#0';
    ordered.createdAt = Math.max(0, Math.floor(meta.createdAt || 0));
    ordered.updatedAt = Math.max(0, Math.floor(meta.updatedAt || 0));

    if (meta.consumedByTurn !== undefined && Number.isFinite(meta.consumedByTurn)) {
        ordered.consumedByTurn = Math.max(0, Math.floor(meta.consumedByTurn));
    }

    const yamlBlock = stringifyYaml(ordered, { lineWidth: 0 }).replace(/\n+$/, '');
    const normalizedBody = normalizeLineEndings(body ?? '');
    return `---\n${yamlBlock}\n---\n${normalizedBody}`;
}

/**
 * Synchronously parse `/side/*` YAML frontmatter and Markdown body without computing `contentHash`.
 */
export function parseSideClueRaw(
    path: string,
    raw: string,
    defaults?: Partial<SideClueMeta>,
): ParsedSideClueRaw {
    const normalizedPath = safeNormalizePath(path);
    const { frontmatter, body } = splitSideClueFrontmatter(raw ?? '');

    let parsedObj: Record<string, unknown> = {};
    let hasFrontmatter = false;

    if (frontmatter !== null) {
        hasFrontmatter = true;
        if (frontmatter.trim() !== '') {
            try {
                const parsed = parseYaml(frontmatter);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    parsedObj = parsed as Record<string, unknown>;
                }
            } catch {
                // Malformed frontmatter degrades gracefully to defaults instead of crashing reads.
                parsedObj = {};
            }
        }
    }

    const meta = normalizeSideClueMeta(parsedObj, normalizedPath, defaults, body);
    return {
        path: normalizedPath,
        meta,
        body,
        hasFrontmatter,
    };
}

/**
 * Parse a `/side/*` clue document and compute its 64-bit `xxHash` `contentHash` asynchronously.
 * `contentHash` hashes the raw document string so it matches `read_file`'s `Read-Set` digest.
 */
export async function parseSideClue(
    path: string,
    raw: string,
    defaults?: Partial<SideClueMeta>,
): Promise<SideClueDoc> {
    const parsed = parseSideClueRaw(path, raw, defaults);
    const contentHash = await hashText(raw ?? '');
    return {
        path: parsed.path,
        meta: parsed.meta,
        body: parsed.body,
        contentHash,
    };
}

/**
 * Synchronously parse a `/side/*` clue document and compute `contentHash`
 * (requires `await initXxHash()` beforehand).
 */
export function parseSideClueSync(
    path: string,
    raw: string,
    defaults?: Partial<SideClueMeta>,
): SideClueDoc {
    const parsed = parseSideClueRaw(path, raw, defaults);
    const contentHash = hashTextSync(raw ?? '');
    return {
        path: parsed.path,
        meta: parsed.meta,
        body: parsed.body,
        contentHash,
    };
}

/**
 * Canonically normalize, serialize, and hash a `/side/*` clue document in one step.
 */
export async function serializeSideClueWithHash(
    path: string,
    meta: SideClueMeta,
    body: string,
): Promise<SerializedSideClueResult> {
    const normalizedPath = safeNormalizePath(path);
    const normalizedBody = normalizeLineEndings(body ?? '');
    const normalizedMeta = normalizeSideClueMeta(
        meta as unknown as Record<string, unknown>,
        normalizedPath,
        meta,
        normalizedBody,
    );
    const content = serializeSideClue(normalizedMeta, normalizedBody);
    const contentHash = await hashText(content);
    return {
        content,
        doc: {
            path: normalizedPath,
            meta: normalizedMeta,
            body: normalizedBody,
            contentHash,
        },
    };
}
