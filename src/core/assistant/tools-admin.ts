import { z } from 'zod';
import type { HostAdminBridge, ReadHostSettingsOptions } from '@/core/bridge';
import { utf8ByteLength } from '@/core/context';
import type {
    HostCharacterCreatePayload,
    HostCharacterPatch,
    HostCharacterSummary,
    HostSettingsScope,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { computeDiffLines } from './approval';
import { redactWithReport } from './redact';
import {
    extractPreviousCharacterFields,
    lintWorldInfoContent,
    normalizeRegexUpsertInput,
    REGEX_UPSERT_SCHEMA,
    requireAuthorBridge,
    toWorldInfoUpsertPayload,
    WORLD_INFO_ENTRY_FIELDS_SHAPE,
} from './tools-author';
import {
    finalizeMutationToolResult,
    finalizeReadToolResult,
    finalizeToolError,
    throwIfAssistantAborted,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';

const SETTINGS_READ_MANIFEST_THRESHOLD_BYTES = 16 * 1024;
const CARD_DESCRIPTION_PREVIEW_MAX_CHARS = 120;
const SETTINGS_PREVIEW_MAX_CHARS = 100;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatBoundedPreview(raw: string, maxChars: number): string {
    const clean = raw.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxChars) {
        return clean;
    }
    return `${clean.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function toBoundedCharacterSummary(character: HostCharacterSummary): Record<string, unknown> {
    const rawDesc = typeof character.description === 'string' ? character.description : undefined;
    const boundedDesc =
        rawDesc !== undefined
            ? formatBoundedPreview(rawDesc, CARD_DESCRIPTION_PREVIEW_MAX_CHARS)
            : undefined;
    return {
        chid: character.chid,
        name: character.name,
        avatar: character.avatar,
        ...(boundedDesc !== undefined
            ? {
                description: boundedDesc,
                descriptionPreview: boundedDesc,
                descriptionLength: rawDesc!.length,
            }
            : { descriptionLength: 0 }),
        ...(character.tags !== undefined ? { tags: [...character.tags] } : {}),
        ...(character.primaryWorld !== undefined ? { primaryWorld: character.primaryWorld } : {}),
    };
}

function isSettingsSummaryManifest(value: unknown): boolean {
    if (!isPlainRecord(value)) {
        return false;
    }
    return value.summaryOnly === true && Array.isArray(value.manifest);
}

function buildAdminSettingsManifest(
    record: Record<string, unknown>,
    scope: string,
    totalBytes: number,
    keyPath?: string,
): Record<string, unknown> {
    const manifest = Object.entries(record)
        .map(([key, value]) => {
            const type =
                value === null || value === undefined
                    ? 'null'
                    : Array.isArray(value)
                        ? 'array'
                        : typeof value;
            const serialized = JSON.stringify(value) ?? 'null';
            const bytes = utf8ByteLength(serialized);
            const itemCount =
                type === 'array'
                    ? (value as unknown[]).length
                    : type === 'object'
                        ? Object.keys(value as Record<string, unknown>).length
                        : undefined;
            const previewSource = typeof value === 'string' ? value : serialized;
            return {
                key,
                type,
                bytes,
                ...(itemCount !== undefined ? { itemCount } : {}),
                preview: formatBoundedPreview(previewSource, SETTINGS_PREVIEW_MAX_CHARS),
            };
        })
        .sort((a, b) => b.bytes - a.bytes || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    return {
        scope,
        ...(keyPath ? { keyPath } : {}),
        summaryOnly: true,
        totalBytes,
        manifest,
        hint: 'Returned summary manifest to keep context compact. Pass a specific extension scope (e.g. scope: "ST-Agentic") or keyPath (e.g. keyPath: "power_user.theme") to drill down.',
    };
}

function requireAdminBridge(ctx: AssistantToolContext): HostAdminBridge {
    if (!ctx.bridge.admin) {
        throw new Error('HostAdminBridge is not available in this environment.');
    }
    return ctx.bridge.admin;
}

// ============================================================================
// Part 1: `full` Mode Enabled-WI Tools (3 tools, unlocked even if stAdminEnabled=false)
// ============================================================================

const WI_LIST_ENABLED_BOOKS_SCHEMA = z.object({});

const WI_UPSERT_ENABLED_ENTRY_SCHEMA = z.object({
    bookName: z.string().min(1).describe('Name of a currently enabled World Info book.'),
    ...WORLD_INFO_ENTRY_FIELDS_SHAPE,
});

const WI_DELETE_ENABLED_ENTRY_SCHEMA = z.object({
    bookName: z.string().min(1).describe('Name of a currently enabled World Info book.'),
    uid: z.number().int().min(0).describe('UID of the entry to permanently delete.'),
});

async function assertBookIsEnabled(ctx: AssistantToolContext, bookName: string): Promise<void> {
    const enabled = await ctx.bridge.listEnabledLorebooks();
    if (!enabled.has(bookName)) {
        throw new Error(
            `World Info book "${bookName}" is not currently enabled. Enable ST Admin (stAdminEnabled: true) to edit disabled/global books.`,
        );
    }
}

/** Create the 3 `full`-tier enabled World Info tools (`FULL_ENABLED_WI_TOOLS`). */
export function createFullEnabledWiTools(): AssistantToolDefinition[] {
    const wiListEnabledBooksTool: AssistantToolDefinition<typeof WI_LIST_ENABLED_BOOKS_SCHEMA> = {
        name: 'wi_list_enabled_books',
        description: 'List all currently enabled World Info books and entry counts. Read-only.',
        parameters: WI_LIST_ENABLED_BOOKS_SCHEMA,
        tier: 'full',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const enabled = await ctx.bridge.listEnabledLorebooks();
            const books = Array.from(enabled.entries()).map(([name, entries]) => ({
                name,
                entryCount: entries.length,
            }));
            return finalizeReadToolResult({
                ok: true,
                total: books.length,
                books,
            });
        },
    };

    const wiUpsertEnabledEntryTool: AssistantToolDefinition<typeof WI_UPSERT_ENABLED_ENTRY_SCHEMA> = {
        name: 'wi_upsert_enabled_entry',
        description:
            'Permanently create or update an entry in any currently enabled World Info book. Preserves raw @@ decorators and <% ... %> EJS verbatim (no escapeAt).',
        parameters: WI_UPSERT_ENABLED_ENTRY_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            await assertBookIsEnabled(ctx, args.bookName);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;
            const beforeText = existing?.content ?? '';
            const warnings = lintWorldInfoContent(args.content);
            const uidLabel = args.uid !== undefined ? `#${args.uid}` : 'new entry';
            return {
                title: `${existing ? 'Update' : 'Create'} enabled WI ${args.bookName} ${uidLabel}`,
                summary: `Write raw World Info entry to enabled book "${args.bookName}".`,
                targetLabel: `WI: ${args.bookName} / ${uidLabel}`,
                beforeText,
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, args.content),
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            await assertBookIsEnabled(ctx, args.bookName);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;
            const warnings = lintWorldInfoContent(args.content);
            const payload = toWorldInfoUpsertPayload(args, existing);

            const saved = await author.upsertWorldInfoEntry(args.bookName, payload, {
                rawDirect: true,
                undoMeta: {
                    sessionId: ctx.sessionId,
                    toolCallId: ctx.toolCallId,
                    reason: 'assistant:wi_upsert_enabled_entry',
                },
            });

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_upsert_enabled_entry',
                        kind: 'worldinfo',
                        label: `${existing ? 'Update' : 'Create'} WI ${args.bookName} #${saved.uid}`,
                        scope: `wi:${args.bookName}#${saved.uid}`,
                        beforeSummary: existing ? truncateSummary(existing.content) : '(new entry)',
                        afterSummary: truncateSummary(saved.content),
                        snapshot: {
                            action: existing ? 'update_entry' : 'create_entry',
                            bookName: args.bookName,
                            uid: saved.uid,
                            previousEntry: existing ? canonicalClone(existing) : null,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { bookName: args.bookName, entry: saved },
                { undoId, warnings },
            );
        },
    };

    const wiDeleteEnabledEntryTool: AssistantToolDefinition<typeof WI_DELETE_ENABLED_ENTRY_SCHEMA> = {
        name: 'wi_delete_enabled_entry',
        description:
            'Permanently delete an entry by UID from any currently enabled World Info book. High-risk mandatoryConfirm operation.',
        parameters: WI_DELETE_ENABLED_ENTRY_SCHEMA,
        tier: 'full',
        readOnly: false,
        async preview(args, ctx) {
            await assertBookIsEnabled(ctx, args.bookName);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            const beforeText = existing?.content ?? `(entry #${args.uid} not found)`;
            return {
                title: `Delete enabled WI ${args.bookName} #${args.uid}`,
                summary: `Permanently delete entry #${args.uid} from enabled book "${args.bookName}".`,
                targetLabel: `WI: ${args.bookName} / #${args.uid}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            await assertBookIsEnabled(ctx, args.bookName);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            if (!existing) {
                return finalizeToolError(
                    `World Info entry #${args.uid} not found in "${args.bookName}".`,
                    ctx.signal,
                );
            }

            const deleted = await author.deleteWorldInfoEntry(args.bookName, args.uid);
            if (!deleted) {
                return finalizeToolError(
                    `Failed to delete World Info entry #${args.uid} from "${args.bookName}".`,
                    ctx.signal,
                );
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_delete_enabled_entry',
                        kind: 'worldinfo',
                        label: `Delete WI ${args.bookName} #${args.uid}`,
                        scope: `wi:${args.bookName}#${args.uid}`,
                        beforeSummary: truncateSummary(existing.content),
                        afterSummary: '(deleted)',
                        snapshot: {
                            action: 'delete_entry',
                            bookName: args.bookName,
                            uid: args.uid,
                            previousEntry: canonicalClone(existing),
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { bookName: args.bookName, deletedUid: args.uid },
                { undoId },
            );
        },
    };

    return [wiListEnabledBooksTool, wiUpsertEnabledEntryTool, wiDeleteEnabledEntryTool];
}

// ============================================================================
// Part 2: `stAdminEnabled` Global Admin Tools (23 tools)
// ============================================================================

const EMPTY_SCHEMA = z.object({});

const WI_ADMIN_CREATE_BOOK_SCHEMA = z.object({
    name: z.string().min(1).describe('Name of the new global World Info book.'),
});

const WI_ADMIN_BIND_BOOK_SCHEMA = z.object({
    name: z.string().min(1).describe('World Info book name.'),
    enabled: z.boolean().describe('true to enable/bind globally, false to disable/unbind.'),
});

const WI_ADMIN_UPSERT_ENTRY_SCHEMA = z.object({
    bookName: z.string().min(1).describe('Any World Info book name (enabled or disabled).'),
    ...WORLD_INFO_ENTRY_FIELDS_SHAPE,
});

const WI_ADMIN_DELETE_ENTRY_SCHEMA = z.object({
    bookName: z.string().min(1),
    uid: z.number().int().min(0),
});

const CARD_ADMIN_READ_SCHEMA = z.object({
    chid: z.number().int().min(0),
});

const CARD_ADMIN_CREATE_SCHEMA = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    personality: z.string().optional(),
    scenario: z.string().optional(),
    first_mes: z.string().optional(),
    mes_example: z.string().optional(),
    creator_notes: z.string().optional(),
    system_prompt: z.string().optional(),
    post_history_instructions: z.string().optional(),
    alternate_greetings: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
});

const CARD_ADMIN_PATCH_SCHEMA = z.object({
    chid: z.number().int().min(0),
    fields: z.record(z.string(), z.unknown()),
});

const CARD_ADMIN_DELETE_SCHEMA = z.object({
    chid: z.number().int().min(0),
});

const CARD_ADMIN_SELECT_SCHEMA = z.object({
    chid: z.number().int().min(0),
});

const PERSONA_ADMIN_UPSERT_SCHEMA = z.object({
    key: z.string().min(1),
    description: z.string().optional(),
    desc: z.string().optional(),
    title: z.string().optional(),
});

const PERSONA_ADMIN_SELECT_SCHEMA = z.object({
    key: z.string().min(1),
});

const ST_SETTINGS_READ_SCHEMA = z.object({
    scope: z
        .string()
        .optional()
        .default('all')
        .describe('Settings scope: "power_user", "extension_settings", "all", or specific extension key.'),
    keyPath: z
        .string()
        .optional()
        .describe(
            'Optional dot/slash key path for drill-down reads (e.g. "TavernHelper.scripts" or "power_user.theme").',
        ),
    summaryOnly: z
        .boolean()
        .optional()
        .describe(
            'When true, return only a descending-byte manifest (key, type, bytes, itemCount, preview) instead of full nested objects.',
        ),
});

const ST_SETTINGS_PATCH_SCHEMA = z.object({
    scope: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
});

const ST_PRESET_LIST_SCHEMA = z.object({
    apiType: z.string().optional().describe('Optional SillyTavern API type filter (e.g. "openai").'),
    name: z.string().optional().describe('Optional exact preset name to filter by.'),
    includeData: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            'Default false: returns only metadata ({ name, apiType, active }). Set true (ideally with name) to load full preset data.',
        ),
});

const ST_PRESET_SELECT_SCHEMA = z.object({
    name: z.string().min(1),
    apiType: z.string().optional(),
});

const ST_PRESET_PATCH_SCHEMA = z.object({
    name: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
    apiType: z.string().optional(),
});

const REGEX_ADMIN_GLOBAL_DELETE_SCHEMA = z.object({
    id: z.string().min(1),
});

const ST_SLASH_EXEC_SCHEMA = z.object({
    command: z.string().min(1).describe('SillyTavern STscript / slash command to execute.'),
});

const ST_IMPORT_URL_SCHEMA = z.object({
    url: z.string().min(1).describe('Remote URL of character card, World Info, or preset to import.'),
});

/** Create the 23 ST Admin tools (`ADMIN_TOOLS`), accessible only when `mode === 'full' && stAdminEnabled`. */
export function createStAdminTools(): AssistantToolDefinition[] {
    const wiAdminListAllTool: AssistantToolDefinition<typeof EMPTY_SCHEMA> = {
        name: 'wi_admin_list_all',
        description: 'List all World Info books in SillyTavern (enabled and disabled). Read-only.',
        parameters: EMPTY_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const [allNames, enabledMap] = await Promise.all([
                admin.listAllWorldNames(),
                ctx.bridge.listEnabledLorebooks(),
            ]);
            const books = allNames.map((name) => ({
                name,
                enabled: enabledMap.has(name),
            }));
            return finalizeReadToolResult({ ok: true, total: books.length, books });
        },
    };

    const wiAdminCreateBookTool: AssistantToolDefinition<typeof WI_ADMIN_CREATE_BOOK_SCHEMA> = {
        name: 'wi_admin_create_book',
        description: 'Create a new global World Info book in SillyTavern.',
        parameters: WI_ADMIN_CREATE_BOOK_SCHEMA,
        tier: 'admin',
        readOnly: false,
        preview(args) {
            const raw = JSON.stringify({ name: args.name }, null, 2);
            return {
                title: `Create World Info book "${args.name}"`,
                summary: `Create new World Info book "${args.name}".`,
                targetLabel: `WI: ${args.name}`,
                beforeText: '',
                afterText: raw,
                rawContent: raw,
                diffLines: computeDiffLines('', raw),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const created = await admin.createWorldBook(args.name);
            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_admin_create_book',
                        kind: 'worldinfo',
                        label: `Create WI book "${args.name}"`,
                        scope: `wi:${args.name}`,
                        beforeSummary: '(book did not exist)',
                        afterSummary: `Created book "${args.name}"`,
                        snapshot: {
                            action: 'create_book',
                            bookName: args.name,
                        },
                        target: ctx.target,
                    }).id;
            return finalizeMutationToolResult({ book: created }, { undoId });
        },
    };

    const wiAdminBindBookTool: AssistantToolDefinition<typeof WI_ADMIN_BIND_BOOK_SCHEMA> = {
        name: 'wi_admin_bind_book',
        description: 'Enable or disable (bind/unbind) a World Info book globally.',
        parameters: WI_ADMIN_BIND_BOOK_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const enabledMap = await ctx.bridge.listEnabledLorebooks();
            const prevEnabled = enabledMap.has(args.name);
            const beforeText = `enabled: ${String(prevEnabled)}`;
            const afterText = `enabled: ${String(args.enabled)}`;
            return {
                title: `${args.enabled ? 'Enable' : 'Disable'} WI book "${args.name}"`,
                summary: `Set World Info book "${args.name}" enabled=${String(args.enabled)}.`,
                targetLabel: `WI: ${args.name}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const enabledMap = await ctx.bridge.listEnabledLorebooks();
            const previousEnabled = enabledMap.has(args.name);
            await admin.bindWorldBook(args.name, args.enabled);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_admin_bind_book',
                        kind: 'worldinfo',
                        label: `${args.enabled ? 'Bind' : 'Unbind'} WI book "${args.name}"`,
                        scope: `wi:${args.name}`,
                        beforeSummary: `enabled=${String(previousEnabled)}`,
                        afterSummary: `enabled=${String(args.enabled)}`,
                        snapshot: {
                            action: 'bind_book',
                            bookName: args.name,
                            previousEnabled,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { name: args.name, enabled: args.enabled },
                { undoId },
            );
        },
    };

    const wiAdminUpsertEntryTool: AssistantToolDefinition<typeof WI_ADMIN_UPSERT_ENTRY_SCHEMA> = {
        name: 'wi_admin_upsert_entry',
        description:
            'Create or update an entry in ANY World Info book (enabled or disabled). Preserves raw @@ decorators and <% ... %> EJS verbatim (no escapeAt).',
        parameters: WI_ADMIN_UPSERT_ENTRY_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;
            const beforeText = existing?.content ?? '';
            const warnings = lintWorldInfoContent(args.content);
            const uidLabel = args.uid !== undefined ? `#${args.uid}` : 'new entry';
            return {
                title: `${existing ? 'Update' : 'Create'} global WI ${args.bookName} ${uidLabel}`,
                summary: `Write raw entry to global World Info book "${args.bookName}".`,
                targetLabel: `WI: ${args.bookName} / ${uidLabel}`,
                beforeText,
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, args.content),
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            requireAdminBridge(ctx);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;
            const warnings = lintWorldInfoContent(args.content);
            const payload = toWorldInfoUpsertPayload(args, existing);
            const saved = await author.upsertWorldInfoEntry(args.bookName, payload, {
                rawDirect: true,
                undoMeta: {
                    sessionId: ctx.sessionId,
                    toolCallId: ctx.toolCallId,
                    reason: 'assistant:wi_admin_upsert_entry',
                },
            });

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_admin_upsert_entry',
                        kind: 'worldinfo',
                        label: `${existing ? 'Update' : 'Create'} WI ${args.bookName} #${saved.uid}`,
                        scope: `wi:${args.bookName}#${saved.uid}`,
                        beforeSummary: existing ? truncateSummary(existing.content) : '(new entry)',
                        afterSummary: truncateSummary(saved.content),
                        snapshot: {
                            action: existing ? 'update_entry' : 'create_entry',
                            bookName: args.bookName,
                            uid: saved.uid,
                            previousEntry: existing ? canonicalClone(existing) : null,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { bookName: args.bookName, entry: saved },
                { undoId, warnings },
            );
        },
    };

    const wiAdminDeleteEntryTool: AssistantToolDefinition<typeof WI_ADMIN_DELETE_ENTRY_SCHEMA> = {
        name: 'wi_admin_delete_entry',
        description:
            'Permanently delete an entry by UID from any World Info book. High-risk mandatoryConfirm operation.',
        parameters: WI_ADMIN_DELETE_ENTRY_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            const beforeText = existing?.content ?? `(entry #${args.uid} not found)`;
            return {
                title: `Delete global WI ${args.bookName} #${args.uid}`,
                summary: `Permanently delete entry #${args.uid} from "${args.bookName}".`,
                targetLabel: `WI: ${args.bookName} / #${args.uid}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            requireAdminBridge(ctx);
            const author = requireAuthorBridge(ctx);
            const book = await author.readWorldInfoBook(args.bookName);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            if (!existing) {
                return finalizeToolError(
                    `World Info entry #${args.uid} not found in "${args.bookName}".`,
                    ctx.signal,
                );
            }
            const deleted = await author.deleteWorldInfoEntry(args.bookName, args.uid);
            if (!deleted) {
                return finalizeToolError(
                    `Failed to delete World Info entry #${args.uid} from "${args.bookName}".`,
                    ctx.signal,
                );
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_admin_delete_entry',
                        kind: 'worldinfo',
                        label: `Delete WI ${args.bookName} #${args.uid}`,
                        scope: `wi:${args.bookName}#${args.uid}`,
                        beforeSummary: truncateSummary(existing.content),
                        afterSummary: '(deleted)',
                        snapshot: {
                            action: 'delete_entry',
                            bookName: args.bookName,
                            uid: args.uid,
                            previousEntry: canonicalClone(existing),
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { bookName: args.bookName, deletedUid: args.uid },
                { undoId },
            );
        },
    };

    const cardAdminListAllTool: AssistantToolDefinition<typeof EMPTY_SCHEMA> = {
        name: 'card_admin_list_all',
        description:
            'List all character cards in SillyTavern with bounded description previews (<= 120 chars). Use card_admin_read(chid) for full card fields. Read-only.',
        parameters: EMPTY_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const rawCharacters = await admin.listAllCharacters();
            const characters = rawCharacters.map((c) => toBoundedCharacterSummary(c));
            return finalizeReadToolResult({
                ok: true,
                total: characters.length,
                characters,
                hint: 'Descriptions are truncated to <= 120 chars preview. Call card_admin_read(chid) to read a full character card.',
            });
        },
    };

    const cardAdminReadTool: AssistantToolDefinition<typeof CARD_ADMIN_READ_SCHEMA> = {
        name: 'card_admin_read',
        description: 'Read a character card by numeric chid. Read-only.',
        parameters: CARD_ADMIN_READ_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const card = await admin.readCharacterById(args.chid);
            if (!card) {
                return finalizeToolError(`Character chid=${args.chid} not found.`, ctx.signal);
            }
            return finalizeReadToolResult({ ok: true, character: card });
        },
    };

    const cardAdminCreateTool: AssistantToolDefinition<typeof CARD_ADMIN_CREATE_SCHEMA> = {
        name: 'card_admin_create',
        description: 'Create a new character card in SillyTavern.',
        parameters: CARD_ADMIN_CREATE_SCHEMA,
        tier: 'admin',
        readOnly: false,
        preview(args) {
            const raw = JSON.stringify(redactWithReport(args).value, null, 2);
            return {
                title: `Create character card "${args.name}"`,
                summary: `Create new character "${args.name}".`,
                targetLabel: `Card: ${args.name}`,
                beforeText: '',
                afterText: raw,
                rawContent: raw,
                diffLines: computeDiffLines('', raw),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const created = await admin.createCharacter(args as HostCharacterCreatePayload);
            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_admin_create',
                        kind: 'character',
                        label: `Create character "${created.name}" (#${created.chid})`,
                        scope: `card:admin:${created.chid}`,
                        beforeSummary: '(character did not exist)',
                        afterSummary: `Created character "${created.name}"`,
                        snapshot: {
                            scope: 'admin_create',
                            chid: created.chid,
                        },
                        target: ctx.target,
                    }).id;
            return finalizeMutationToolResult({ character: created }, { undoId });
        },
    };

    const cardAdminPatchTool: AssistantToolDefinition<typeof CARD_ADMIN_PATCH_SCHEMA> = {
        name: 'card_admin_patch',
        description: 'Patch any character card by numeric chid.',
        parameters: CARD_ADMIN_PATCH_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const before = await admin.readCharacterById(args.chid);
            const fields = args.fields as HostCharacterPatch;
            const beforeSubset: Record<string, unknown> = {};
            for (const key of Object.keys(fields)) {
                beforeSubset[key] = before ? before[key] ?? '' : '';
            }
            const beforeText = JSON.stringify(redactWithReport(beforeSubset).value, null, 2);
            const afterText = JSON.stringify(redactWithReport(fields).value, null, 2);
            return {
                title: `Patch character #${args.chid} (${before?.name ?? 'unknown'})`,
                summary: `Patch fields ${Object.keys(fields).join(', ')} on chid=${args.chid}.`,
                targetLabel: `Card: #${args.chid}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const before = await admin.readCharacterById(args.chid);
            if (!before) {
                return finalizeToolError(`Character chid=${args.chid} not found.`, ctx.signal);
            }
            const fields = args.fields as HostCharacterPatch;
            const previousFields = extractPreviousCharacterFields(before, fields);
            const updated = await admin.patchCharacterById(args.chid, fields);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_admin_patch',
                        kind: 'character',
                        label: `Patch character #${args.chid} (${before.name})`,
                        scope: `card:admin:${args.chid}`,
                        beforeSummary: truncateSummary(JSON.stringify(previousFields)),
                        afterSummary: truncateSummary(JSON.stringify(fields)),
                        snapshot: {
                            scope: 'admin_patch',
                            chid: args.chid,
                            previousFields,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ character: updated }, { undoId });
        },
    };

    const cardAdminDeleteTool: AssistantToolDefinition<typeof CARD_ADMIN_DELETE_SCHEMA> = {
        name: 'card_admin_delete',
        description: 'Permanently delete a character card by chid. High-risk mandatoryConfirm operation.',
        parameters: CARD_ADMIN_DELETE_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const before = await admin.readCharacterById(args.chid);
            const beforeText = before
                ? JSON.stringify(redactWithReport(before).value, null, 2)
                : `(character chid=${args.chid} not found)`;
            return {
                title: `Delete character #${args.chid} (${before?.name ?? 'unknown'})`,
                summary: `Permanently delete character card chid=${args.chid}.`,
                targetLabel: `Card: #${args.chid}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const before = await admin.readCharacterById(args.chid);
            if (!before) {
                return finalizeToolError(`Character chid=${args.chid} not found.`, ctx.signal);
            }
            const deleted = await admin.deleteCharacterById(args.chid);
            if (!deleted) {
                return finalizeToolError(`Failed to delete character chid=${args.chid}.`, ctx.signal);
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_admin_delete',
                        kind: 'character',
                        label: `Delete character #${args.chid} (${before.name})`,
                        scope: `card:admin:${args.chid}`,
                        beforeSummary: `Character "${before.name}"`,
                        afterSummary: '(deleted)',
                        snapshot: {
                            scope: 'admin_delete',
                            chid: args.chid,
                            previousCharacter: canonicalClone(before),
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ deletedChid: args.chid }, { undoId });
        },
    };

    const cardAdminSelectTool: AssistantToolDefinition<typeof CARD_ADMIN_SELECT_SCHEMA> = {
        name: 'card_admin_select',
        description: 'Switch the active character card in SillyTavern by chid.',
        parameters: CARD_ADMIN_SELECT_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const [prev, next] = await Promise.all([
                ctx.bridge.author?.getActiveCharacterFull() ?? Promise.resolve(null),
                admin.readCharacterById(args.chid),
            ]);
            const beforeText = prev ? `active: #${prev.chid} ${prev.name}` : 'active: none';
            const afterText = `active: #${args.chid} ${next?.name ?? 'unknown'}`;
            return {
                title: `Select character #${args.chid} (${next?.name ?? 'unknown'})`,
                summary: `Switch active character to chid=${args.chid}.`,
                targetLabel: `Card: #${args.chid}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const prev = (await ctx.bridge.author?.getActiveCharacterFull()) ?? null;
            await admin.selectCharacterById(args.chid);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_admin_select',
                        kind: 'character',
                        label: `Select character #${args.chid}`,
                        scope: `card:select:${args.chid}`,
                        beforeSummary: prev ? `chid=${prev.chid} (${prev.name})` : '(none)',
                        afterSummary: `chid=${args.chid}`,
                        snapshot: {
                            scope: 'admin_select',
                            previousChid: prev?.chid ?? null,
                            newChid: args.chid,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ selectedChid: args.chid }, { undoId });
        },
    };

    const personaAdminListTool: AssistantToolDefinition<typeof EMPTY_SCHEMA> = {
        name: 'persona_admin_list',
        description: 'List all SillyTavern user personas. Read-only.',
        parameters: EMPTY_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const personas = await admin.listPersonas();
            return finalizeReadToolResult({ ok: true, total: personas.length, personas });
        },
    };

    const personaAdminUpsertTool: AssistantToolDefinition<typeof PERSONA_ADMIN_UPSERT_SCHEMA> = {
        name: 'persona_admin_upsert',
        description: 'Create or update a SillyTavern user persona.',
        parameters: PERSONA_ADMIN_UPSERT_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const personas = await admin.listPersonas();
            const existing = personas.find((p) => p.key === args.key);
            const description = args.description ?? args.desc ?? '';
            const beforeText = existing?.description ?? '';
            return {
                title: `${existing ? 'Update' : 'Create'} persona "${args.key}"`,
                summary: `${existing ? 'Update' : 'Create'} persona "${args.key}".`,
                targetLabel: `Persona: ${args.key}`,
                beforeText,
                afterText: description,
                rawContent: description,
                diffLines: computeDiffLines(beforeText, description),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const description = args.description ?? args.desc;
            if (description === undefined) {
                return finalizeToolError(
                    'persona_admin_upsert requires "description" (or "desc").',
                    ctx.signal,
                );
            }
            const personas = await admin.listPersonas();
            const existing = personas.find((p) => p.key === args.key) ?? null;
            const saved = await admin.upsertPersona(args.key, description, args.title);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'persona_admin_upsert',
                        kind: 'st_setting',
                        label: `${existing ? 'Update' : 'Create'} persona "${args.key}"`,
                        scope: `persona:${args.key}`,
                        beforeSummary: existing ? truncateSummary(existing.description) : '(new persona)',
                        afterSummary: truncateSummary(description),
                        snapshot: {
                            action: 'persona_upsert',
                            key: args.key,
                            previousPersona: existing ? canonicalClone(existing) : null,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ persona: saved }, { undoId });
        },
    };

    const personaAdminSelectTool: AssistantToolDefinition<typeof PERSONA_ADMIN_SELECT_SCHEMA> = {
        name: 'persona_admin_select',
        description: 'Select the active SillyTavern user persona.',
        parameters: PERSONA_ADMIN_SELECT_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const personas = await admin.listPersonas();
            const active = personas.find((p) => p.active);
            const beforeText = `activePersona: ${active?.key ?? 'none'}`;
            const afterText = `activePersona: ${args.key}`;
            return {
                title: `Select persona "${args.key}"`,
                summary: `Switch active persona to "${args.key}".`,
                targetLabel: `Persona: ${args.key}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const personas = await admin.listPersonas();
            const previousActive = personas.find((p) => p.active)?.key ?? null;
            await admin.selectPersona(args.key);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'persona_admin_select',
                        kind: 'st_setting',
                        label: `Select persona "${args.key}"`,
                        scope: `persona:${args.key}`,
                        beforeSummary: previousActive ?? '(none)',
                        afterSummary: args.key,
                        snapshot: {
                            action: 'persona_select',
                            previousKey: previousActive,
                            newKey: args.key,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ selectedKey: args.key }, { undoId });
        },
    };

    const stSettingsReadTool: AssistantToolDefinition<typeof ST_SETTINGS_READ_SCHEMA> = {
        name: 'st_settings_read',
        description:
            'Read SillyTavern global/extension settings (secrets are recursively redacted to ***REDACTED***). Supports keyPath drill-down and summaryOnly manifest; large broad reads automatically return a size manifest. Read-only.',
        parameters: ST_SETTINGS_READ_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const readOptions: ReadHostSettingsOptions = {
                ...(args.keyPath !== undefined ? { keyPath: args.keyPath } : {}),
                ...(args.summaryOnly !== undefined ? { summaryOnly: args.summaryOnly } : {}),
            };
            const rawSettings = await admin.readHostSettings(
                args.scope as HostSettingsScope,
                readOptions,
            );

            // Always redact BEFORE computing summary manifest previews so secrets never leak.
            const redactedReport = redactWithReport(rawSettings);
            let finalSettings: Record<string, unknown> = isPlainRecord(redactedReport.value)
                ? redactedReport.value
                : { value: redactedReport.value };

            if (!isSettingsSummaryManifest(finalSettings)) {
                const serializedBytes = utf8ByteLength(JSON.stringify(finalSettings));
                const shouldDegradeToManifest =
                    args.summaryOnly === true
                    || (args.summaryOnly !== false
                        && !args.keyPath
                        && serializedBytes > SETTINGS_READ_MANIFEST_THRESHOLD_BYTES);
                if (shouldDegradeToManifest) {
                    finalSettings = buildAdminSettingsManifest(
                        finalSettings,
                        args.scope,
                        serializedBytes,
                        args.keyPath,
                    );
                }
            }

            const finalized = finalizeReadToolResult({
                ok: true,
                scope: args.scope,
                ...(args.keyPath ? { keyPath: args.keyPath } : {}),
                settings: finalSettings,
            });
            return {
                ...finalized,
                hasSecretRedaction:
                    finalized.hasSecretRedaction || redactedReport.hasSecretRedaction,
                redactionCount: finalized.redactionCount + redactedReport.redactionCount,
            };
        },
    };

    const stSettingsPatchTool: AssistantToolDefinition<typeof ST_SETTINGS_PATCH_SCHEMA> = {
        name: 'st_settings_patch',
        description:
            'Patch SillyTavern global or extension settings. High-risk mandatoryConfirm operation. Captures pre-write UndoRecord.',
        parameters: ST_SETTINGS_PATCH_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const before = await admin.readHostSettings(args.scope as HostSettingsScope, {
                summaryOnly: false,
            });
            const beforeSubset: Record<string, unknown> = {};
            for (const key of Object.keys(args.patch)) {
                beforeSubset[key] = before[key];
            }
            const beforeText = JSON.stringify(redactWithReport(beforeSubset).value, null, 2);
            const afterText = JSON.stringify(redactWithReport(args.patch).value, null, 2);
            return {
                title: `Patch ST settings (${args.scope})`,
                summary: `Update SillyTavern settings keys: ${Object.keys(args.patch).join(', ')}.`,
                targetLabel: `ST Settings: ${args.scope}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const scope = args.scope as HostSettingsScope;
            const before = await admin.readHostSettings(scope, { summaryOnly: false });
            const previousValues: Record<string, unknown> = {};
            for (const key of Object.keys(args.patch)) {
                if (Object.hasOwn(before, key)) {
                    previousValues[key] = canonicalClone(before[key]);
                }
            }

            const updated = await admin.patchHostSettings(scope, args.patch);
            const redactedBefore = redactWithReport(previousValues).value;
            const redactedPatch = redactWithReport(args.patch).value;

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'st_settings_patch',
                        kind: 'st_setting',
                        label: `Patch ST settings (${scope})`,
                        scope: `st_settings:${scope}`,
                        beforeSummary: truncateSummary(JSON.stringify(redactedBefore)),
                        afterSummary: truncateSummary(JSON.stringify(redactedPatch)),
                        snapshot: {
                            action: 'settings_patch',
                            scope,
                            previousValues,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ scope, settings: updated }, { undoId });
        },
    };

    const stPresetListTool: AssistantToolDefinition<typeof ST_PRESET_LIST_SCHEMA> = {
        name: 'st_preset_list',
        description:
            'List SillyTavern generation presets (metadata only by default: name, apiType, active; pass name + includeData=true to inspect a single preset body). Read-only.',
        parameters: ST_PRESET_LIST_SCHEMA,
        tier: 'admin',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const includeData = args.includeData ?? false;
            const rawPresets = await admin.listPresets({
                apiType: args.apiType,
                includeData,
                name: args.name,
            });
            const filtered = args.name
                ? rawPresets.filter((p) => p.name === args.name)
                : rawPresets;
            // Defense-in-depth: strip heavy `data` field when includeData is false even if a custom bridge returned it.
            const presets = includeData
                ? filtered
                : filtered.map(({ name, apiType, active }) => ({
                    name,
                    apiType,
                    ...(active !== undefined ? { active } : {}),
                }));
            return finalizeReadToolResult({
                ok: true,
                total: presets.length,
                includeData,
                presets,
            });
        },
    };

    const stPresetSelectTool: AssistantToolDefinition<typeof ST_PRESET_SELECT_SCHEMA> = {
        name: 'st_preset_select',
        description:
            'Switch active SillyTavern generation preset. High-risk mandatoryConfirm operation.',
        parameters: ST_PRESET_SELECT_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const presets = await admin.listPresets({
                apiType: args.apiType,
                includeData: false,
            });
            const current = presets.find((p) => p.active);
            const beforeText = `activePreset: ${current?.name ?? 'none'}`;
            const afterText = `activePreset: ${args.name}`;
            return {
                title: `Select ST preset "${args.name}"`,
                summary: `Switch SillyTavern preset to "${args.name}".`,
                targetLabel: `ST Preset: ${args.name}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const presets = await admin.listPresets({
                apiType: args.apiType,
                includeData: false,
            });
            const previousName = presets.find((p) => p.active)?.name ?? null;
            await admin.selectPreset(args.name, args.apiType);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'st_preset_select',
                        kind: 'st_setting',
                        label: `Select ST preset "${args.name}"`,
                        scope: `st_preset:${args.name}`,
                        beforeSummary: previousName ?? '(none)',
                        afterSummary: args.name,
                        snapshot: {
                            action: 'preset_select',
                            apiType: args.apiType,
                            previousName,
                            newName: args.name,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { name: args.name, apiType: args.apiType },
                { undoId },
            );
        },
    };

    const stPresetPatchTool: AssistantToolDefinition<typeof ST_PRESET_PATCH_SCHEMA> = {
        name: 'st_preset_patch',
        description:
            'Patch parameters of a SillyTavern generation preset. High-risk mandatoryConfirm operation.',
        parameters: ST_PRESET_PATCH_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const presets = await admin.listPresets({
                apiType: args.apiType,
                includeData: true,
                name: args.name,
            });
            const target = presets.find((p) => p.name === args.name);
            const beforeSubset: Record<string, unknown> = {};
            for (const key of Object.keys(args.patch)) {
                beforeSubset[key] = target?.data?.[key];
            }
            const beforeText = JSON.stringify(redactWithReport(beforeSubset).value, null, 2);
            const afterText = JSON.stringify(redactWithReport(args.patch).value, null, 2);
            return {
                title: `Patch ST preset "${args.name}"`,
                summary: `Modify preset "${args.name}" keys: ${Object.keys(args.patch).join(', ')}.`,
                targetLabel: `ST Preset: ${args.name}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const presets = await admin.listPresets({
                apiType: args.apiType,
                includeData: true,
                name: args.name,
            });
            const existing = presets.find((p) => p.name === args.name);
            const previousData: Record<string, unknown> = {};
            for (const key of Object.keys(args.patch)) {
                if (existing?.data && Object.hasOwn(existing.data, key)) {
                    previousData[key] = canonicalClone(existing.data[key]);
                }
            }

            const updated = await admin.patchPreset(args.name, args.patch, args.apiType);
            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'st_preset_patch',
                        kind: 'st_setting',
                        label: `Patch ST preset "${args.name}"`,
                        scope: `st_preset:${args.name}`,
                        beforeSummary: truncateSummary(JSON.stringify(previousData)),
                        afterSummary: truncateSummary(JSON.stringify(args.patch)),
                        snapshot: {
                            action: 'preset_patch',
                            name: args.name,
                            apiType: args.apiType,
                            previousData,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ preset: updated }, { undoId });
        },
    };

    const regexAdminGlobalUpsertTool: AssistantToolDefinition<typeof REGEX_UPSERT_SCHEMA> = {
        name: 'regex_admin_global_upsert',
        description:
            'Create or update a global SillyTavern regex script (SCRIPT_TYPES.GLOBAL). High-risk mandatoryConfirm operation.',
        parameters: REGEX_UPSERT_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const before = await admin.listGlobalRegex();
            const candidate = normalizeRegexUpsertInput(args, 'regex_global');
            const existing = before.find((s) => s.id === candidate.id);
            const beforeText = existing ? JSON.stringify(existing, null, 2) : '';
            const afterText = JSON.stringify(candidate, null, 2);
            return {
                title: `${existing ? 'Update' : 'Add'} global regex "${candidate.scriptName}"`,
                summary: `${existing ? 'Modify' : 'Create'} global ST regex "${candidate.scriptName}".`,
                targetLabel: `Global Regex: ${candidate.scriptName}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const previousScripts = canonicalClone(await admin.listGlobalRegex());
            const script = normalizeRegexUpsertInput(args, 'regex_global');
            const nextScripts = canonicalClone(previousScripts);
            const idx = nextScripts.findIndex((s) => s.id === script.id);
            if (idx >= 0) {
                nextScripts[idx] = script;
            } else {
                nextScripts.push(script);
            }
            await admin.saveGlobalRegex(nextScripts);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'regex_admin_global_upsert',
                        kind: 'regex',
                        label: `${idx >= 0 ? 'Update' : 'Create'} global regex: ${script.scriptName}`,
                        scope: `regex:global:${script.id}`,
                        beforeSummary: `${previousScripts.length} global regex script(s)`,
                        afterSummary: `${nextScripts.length} global regex script(s) (${script.scriptName})`,
                        snapshot: {
                            scope: 'global',
                            previousScripts,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { script, total: nextScripts.length },
                { undoId },
            );
        },
    };

    const regexAdminGlobalDeleteTool: AssistantToolDefinition<
        typeof REGEX_ADMIN_GLOBAL_DELETE_SCHEMA
    > = {
        name: 'regex_admin_global_delete',
        description:
            'Permanently delete a global SillyTavern regex script by ID. High-risk mandatoryConfirm operation.',
        parameters: REGEX_ADMIN_GLOBAL_DELETE_SCHEMA,
        tier: 'admin',
        readOnly: false,
        async preview(args, ctx) {
            const admin = requireAdminBridge(ctx);
            const before = await admin.listGlobalRegex();
            const existing = before.find((s) => s.id === args.id);
            const beforeText = existing
                ? JSON.stringify(existing, null, 2)
                : `(global regex "${args.id}" not found)`;
            return {
                title: `Delete global regex "${existing?.scriptName ?? args.id}"`,
                summary: `Permanently delete global regex "${args.id}".`,
                targetLabel: `Global Regex: ${existing?.scriptName ?? args.id}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const previousScripts = canonicalClone(await admin.listGlobalRegex());
            const existing = previousScripts.find((s) => s.id === args.id);
            if (!existing) {
                return finalizeToolError(`Global regex "${args.id}" not found.`, ctx.signal);
            }
            const nextScripts = previousScripts.filter((s) => s.id !== args.id);
            await admin.saveGlobalRegex(nextScripts);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'regex_admin_global_delete',
                        kind: 'regex',
                        label: `Delete global regex: ${existing.scriptName}`,
                        scope: `regex:global:${args.id}`,
                        beforeSummary: truncateSummary(JSON.stringify(existing)),
                        afterSummary: '(deleted)',
                        snapshot: {
                            scope: 'global',
                            previousScripts,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                { deletedId: args.id, remaining: nextScripts.length },
                { undoId },
            );
        },
    };

    const stSlashExecTool: AssistantToolDefinition<typeof ST_SLASH_EXEC_SCHEMA> = {
        name: 'st_slash_exec',
        description:
            'Execute a SillyTavern slash / STscript command. High-risk mandatoryConfirm operation.',
        parameters: ST_SLASH_EXEC_SCHEMA,
        tier: 'admin',
        readOnly: false,
        preview(args) {
            const redacted = String(redactWithReport(args.command).value);
            return {
                title: 'Execute ST slash command',
                summary: `Run slash command: ${truncateSummary(redacted, 80)}`,
                targetLabel: 'ST Slash',
                beforeText: '',
                afterText: redacted,
                rawContent: redacted,
                diffLines: computeDiffLines('', redacted),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (!ctx.bridge.executeSlashCommand) {
                return finalizeToolError(
                    'HostBridge.executeSlashCommand is not available in this environment.',
                    ctx.signal,
                );
            }
            const result = await ctx.bridge.executeSlashCommand(args.command, ctx.signal);
            const redactedCmd = String(redactWithReport(args.command).value);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'st_slash_exec',
                        kind: 'st_setting',
                        label: `Slash: ${truncateSummary(redactedCmd, 60)}`,
                        scope: 'st_slash',
                        beforeSummary: '(slash command execution)',
                        afterSummary: truncateSummary(String(redactWithReport(result).value)),
                        snapshot: {
                            action: 'slash_exec',
                            command: redactedCmd,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ command: args.command, result }, { undoId });
        },
    };

    const stImportUrlTool: AssistantToolDefinition<typeof ST_IMPORT_URL_SCHEMA> = {
        name: 'st_import_url',
        description:
            'Import a remote character card, World Info, or preset via SillyTavern /api/content/importURL. High-risk mandatoryConfirm operation.',
        parameters: ST_IMPORT_URL_SCHEMA,
        tier: 'admin',
        readOnly: false,
        preview(args) {
            const redactedUrl = String(redactWithReport(args.url).value);
            return {
                title: `Import URL resource`,
                summary: `Import remote resource from ${redactedUrl}.`,
                targetLabel: `Import: ${redactedUrl}`,
                beforeText: '',
                afterText: redactedUrl,
                rawContent: redactedUrl,
                diffLines: computeDiffLines('', redactedUrl),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const admin = requireAdminBridge(ctx);
            const result = await admin.importFromUrl(args.url);
            const redactedUrl = String(redactWithReport(args.url).value);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'st_import_url',
                        kind: 'st_setting',
                        label: `Import URL: ${result.name ?? truncateSummary(redactedUrl, 40)}`,
                        scope: `st_import:${redactedUrl}`,
                        beforeSummary: '(remote resource)',
                        afterSummary: result.detail ?? `Imported ${result.name ?? redactedUrl}`,
                        snapshot: {
                            action: 'import_url',
                            url: redactedUrl,
                            result: canonicalClone(result),
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult({ importResult: result }, { undoId });
        },
    };

    return [
        wiAdminListAllTool,
        wiAdminCreateBookTool,
        wiAdminBindBookTool,
        wiAdminUpsertEntryTool,
        wiAdminDeleteEntryTool,
        cardAdminListAllTool,
        cardAdminReadTool,
        cardAdminCreateTool,
        cardAdminPatchTool,
        cardAdminDeleteTool,
        cardAdminSelectTool,
        personaAdminListTool,
        personaAdminUpsertTool,
        personaAdminSelectTool,
        stSettingsReadTool,
        stSettingsPatchTool,
        stPresetListTool,
        stPresetSelectTool,
        stPresetPatchTool,
        regexAdminGlobalUpsertTool,
        regexAdminGlobalDeleteTool,
        stSlashExecTool,
        stImportUrlTool,
    ];
}

/** Combine `full` enabled-WI tools (3) and `stAdminEnabled` admin tools (23). */
export function createAdminTierTools(): AssistantToolDefinition[] {
    return [...createFullEnabledWiTools(), ...createStAdminTools()];
}
