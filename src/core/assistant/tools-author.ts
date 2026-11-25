import { z } from 'zod';
import type { HostAuthorBridge } from '@/core/bridge';
import { DecoratorParser, parseDecoratorLine } from '@/core/lore';
import type {
    HostCharacterFull,
    HostCharacterPatch,
    HostRegexScript,
    RawLoreEntry,
    WorldInfoEntryUpsert,
} from '@/core/types';
import { canonicalClone } from '@/core/utils';
import { computeDiffLines } from './approval';
import { redactWithReport } from './redact';
import {
    finalizeMutationToolResult,
    finalizeReadToolResult,
    finalizeToolError,
    throwIfAssistantAborted,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';

/**
 * Lightweight, non-blocking syntax checker for raw World Info entries authored in
 * `author` / `full` modes. Flags unclosed `<%` EJS tags and unknown leading `@@`
 * decorators without mutating or blocking the write.
 */
export function lintWorldInfoContent(content: string): string[] {
    if (!content) {
        return [];
    }

    const warnings: string[] = [];
    const lines = content.split(/\r?\n/);

    // 1. Check leading @@ decorator lines (stop once non-@@ body begins)
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.startsWith('@@')) {
            break;
        }
        if (line.startsWith('@@@')) {
            // Escaped literal @@, stop decorator header scan
            break;
        }
        const parsed = parseDecoratorLine(line);
        if (parsed && !DecoratorParser.isKnownDecorator(parsed.name)) {
            warnings.push(
                `Line ${i + 1}: unknown decorator "${parsed.name}" (non-blocking warning).`,
            );
        }
    }

    // 2. Check EJS `<% ... %>` balance
    let cursor = 0;
    let openCount = 0;
    while (cursor < content.length) {
        const openIdx = content.indexOf('<%', cursor);
        const closeIdx = content.indexOf('%>', cursor);

        if (openIdx === -1 && closeIdx === -1) {
            break;
        }

        if (openIdx !== -1 && (closeIdx === -1 || openIdx < closeIdx)) {
            if (openCount > 0) {
                warnings.push(
                    `Nested or unclosed EJS opening tag "<%" near offset ${openIdx} (non-blocking warning).`,
                );
            }
            openCount += 1;
            cursor = openIdx + 2;
        } else {
            if (openCount === 0) {
                warnings.push(
                    `Unmatched EJS closing tag "%>" near offset ${closeIdx} (non-blocking warning).`,
                );
            } else {
                openCount -= 1;
            }
            cursor = closeIdx + 2;
        }
    }

    if (openCount > 0) {
        warnings.push('Unclosed EJS tag "<%" detected without matching "%>" (non-blocking warning).');
    }

    return warnings;
}

export function requireAuthorBridge(ctx: AssistantToolContext): HostAuthorBridge {
    if (!ctx.bridge.author) {
        throw new Error('HostAuthorBridge is not available in this environment.');
    }
    return ctx.bridge.author;
}

export const WORLD_INFO_ENTRY_FIELDS_SHAPE = {
    uid: z.number().int().min(0).optional().describe('Existing entry UID to update; omit to create new entry.'),
    comment: z.string().optional().describe('Entry title / comment.'),
    content: z
        .string()
        .describe('Raw entry content. Raw @@ decorators and <% ... %> EJS code are preserved verbatim.'),
    keys: z.array(z.string()).optional().describe('Primary activation keywords.'),
    keysecondary: z.array(z.string()).optional(),
    constant: z.boolean().optional(),
    selective: z.boolean().optional(),
    selectiveLogic: z.number().int().optional(),
    disable: z.boolean().optional(),
    position: z.number().int().optional(),
    depth: z.number().int().optional(),
    order: z.number().int().optional(),
    role: z.number().int().optional(),
    caseSensitive: z.boolean().nullable().optional(),
    matchWholeWords: z.union([z.boolean(), z.number().int()]).nullable().optional(),
    probability: z.number().optional(),
    useProbability: z.boolean().optional(),
    group: z.string().optional(),
    groupOverride: z.boolean().optional(),
    groupWeight: z.number().optional(),
    scanDepth: z.number().int().nullable().optional(),
    extensions: z.record(z.string(), z.unknown()).optional(),
};

export function toWorldInfoUpsertPayload(
    args: {
        uid?: number;
        comment?: string;
        content: string;
        keys?: string[];
        keysecondary?: string[];
        constant?: boolean;
        selective?: boolean;
        selectiveLogic?: number;
        disable?: boolean;
        position?: number;
        depth?: number;
        order?: number;
        role?: number;
        caseSensitive?: boolean | null;
        matchWholeWords?: boolean | number | null;
        probability?: number;
        useProbability?: boolean;
        group?: string;
        groupOverride?: boolean;
        groupWeight?: number;
        scanDepth?: number | null;
        extensions?: Record<string, unknown>;
    },
    existing?: RawLoreEntry,
): WorldInfoEntryUpsert {
    return {
        ...(args.uid !== undefined ? { uid: args.uid } : {}),
        ...(args.comment !== undefined ? { comment: args.comment } : {}),
        content: args.content,
        keys: args.keys !== undefined ? [...args.keys] : existing ? [...existing.keys] : [],
        ...(args.keysecondary !== undefined ? { keysecondary: [...args.keysecondary] } : {}),
        ...(args.constant !== undefined ? { constant: args.constant } : {}),
        ...(args.selective !== undefined ? { selective: args.selective } : {}),
        ...(args.selectiveLogic !== undefined ? { selectiveLogic: args.selectiveLogic } : {}),
        ...(args.disable !== undefined ? { disable: args.disable } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.depth !== undefined ? { depth: args.depth } : {}),
        ...(args.order !== undefined ? { order: args.order } : {}),
        ...(args.role !== undefined ? { role: args.role } : {}),
        ...(args.caseSensitive !== undefined ? { caseSensitive: args.caseSensitive } : {}),
        ...(args.matchWholeWords !== undefined ? { matchWholeWords: args.matchWholeWords } : {}),
        ...(args.probability !== undefined ? { probability: args.probability } : {}),
        ...(args.useProbability !== undefined ? { useProbability: args.useProbability } : {}),
        ...(args.group !== undefined ? { group: args.group } : {}),
        ...(args.groupOverride !== undefined ? { groupOverride: args.groupOverride } : {}),
        ...(args.groupWeight !== undefined ? { groupWeight: args.groupWeight } : {}),
        ...(args.scanDepth !== undefined ? { scanDepth: args.scanDepth } : {}),
        ...(args.extensions !== undefined ? { extensions: canonicalClone(args.extensions) } : {}),
    };
}

export const REGEX_SCRIPT_OBJECT_SCHEMA = z.object({
    id: z.string().optional(),
    scriptName: z.string().min(1),
    findRegex: z.string(),
    replaceString: z.string(),
    trimStrings: z.array(z.string()).optional(),
    placement: z.array(z.number().int()).optional(),
    disabled: z.boolean().optional(),
    markdownOnly: z.boolean().optional(),
    promptOnly: z.boolean().optional(),
    runOnEdit: z.boolean().optional(),
    substituteRegex: z.number().int().optional(),
    minDepth: z.number().int().nullable().optional(),
    maxDepth: z.number().int().nullable().optional(),
});

export const REGEX_UPSERT_SCHEMA = z.object({
    script: REGEX_SCRIPT_OBJECT_SCHEMA.optional(),
    id: z.string().optional(),
    scriptName: z.string().min(1).optional(),
    findRegex: z.string().optional(),
    replaceString: z.string().optional(),
    trimStrings: z.array(z.string()).optional(),
    placement: z.array(z.number().int()).optional(),
    disabled: z.boolean().optional(),
    markdownOnly: z.boolean().optional(),
    promptOnly: z.boolean().optional(),
    runOnEdit: z.boolean().optional(),
    substituteRegex: z.number().int().optional(),
    minDepth: z.number().int().nullable().optional(),
    maxDepth: z.number().int().nullable().optional(),
});

export function normalizeRegexUpsertInput(
    args: z.infer<typeof REGEX_UPSERT_SCHEMA>,
    idPrefix: string,
): HostRegexScript {
    const src = args.script ?? args;
    if (!src.scriptName || src.findRegex === undefined || src.replaceString === undefined) {
        throw new Error(
            'Regex upsert requires scriptName, findRegex, and replaceString (either top-level or inside `script`).',
        );
    }
    const id = src.id?.trim() || `${idPrefix}_${Date.now()}`;
    return {
        id,
        scriptName: src.scriptName,
        findRegex: src.findRegex,
        replaceString: src.replaceString,
        ...(src.trimStrings !== undefined ? { trimStrings: [...src.trimStrings] } : {}),
        ...(src.placement !== undefined ? { placement: [...src.placement] } : {}),
        ...(src.disabled !== undefined ? { disabled: src.disabled } : {}),
        ...(src.markdownOnly !== undefined ? { markdownOnly: src.markdownOnly } : {}),
        ...(src.promptOnly !== undefined ? { promptOnly: src.promptOnly } : {}),
        ...(src.runOnEdit !== undefined ? { runOnEdit: src.runOnEdit } : {}),
        ...(src.substituteRegex !== undefined ? { substituteRegex: src.substituteRegex } : {}),
        ...(src.minDepth !== undefined ? { minDepth: src.minDepth } : {}),
        ...(src.maxDepth !== undefined ? { maxDepth: src.maxDepth } : {}),
    };
}

export function extractPreviousCharacterFields(
    before: HostCharacterFull,
    patch: HostCharacterPatch,
): HostCharacterPatch {
    const prev: HostCharacterPatch = {};
    for (const key of Object.keys(patch)) {
        const val = before[key];
        prev[key] = val !== undefined ? canonicalClone(val) : '';
    }
    return prev;
}

// ============================================================================
// Zod Parameter Schemas for `author` Tools (9 tools)
// ============================================================================

const CARD_READ_FULL_SCHEMA = z.object({});

const CARD_PATCH_ACTIVE_SCHEMA = z.object({
    fields: z
        .record(z.string(), z.unknown())
        .describe('Character card fields to permanently merge into the active character card.'),
});

const WI_READ_RAW_BOOK_SCHEMA = z.object({
    bookName: z
        .string()
        .optional()
        .describe('World Info book name; defaults to the active character primary World Info book.'),
});

const WI_UPSERT_PRIMARY_ENTRY_SCHEMA = z.object({
    bookName: z
        .string()
        .optional()
        .describe('Optional primary World Info book name (must match active character primary world if provided).'),
    ...WORLD_INFO_ENTRY_FIELDS_SHAPE,
});

const WI_DELETE_PRIMARY_ENTRY_SCHEMA = z.object({
    bookName: z.string().optional(),
    uid: z.number().int().min(0).describe('UID of the primary World Info entry to permanently delete.'),
});

const REGEX_LIST_SCOPED_SCHEMA = z.object({});

const REGEX_DELETE_SCOPED_SCHEMA = z.object({
    id: z.string().min(1).describe('ID of the character-scoped regex script to delete.'),
});

const CARD_EMBED_AGENTIC_SCHEMA = z.object({
    includePreset: z.boolean().optional().default(true),
    presetId: z.string().optional(),
    includeFiles: z.boolean().optional().default(false),
    filePaths: z.array(z.string()).optional(),
    files: z.record(z.string(), z.string()).optional(),
});

const CHAT_RELOAD_MESSAGES_SCHEMA = z.object({
    messageIds: z
        .array(z.number().int().min(0))
        .optional()
        .describe('Optional specific 0-based chat message IDs to reload; omit to reload recent displayed messages.'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(50)
        .describe('Maximum number of displayed messages to reload when messageIds is omitted.'),
    emitUpdateEvent: z
        .boolean()
        .optional()
        .default(true)
        .describe('Emit MESSAGE_UPDATED so active message-rendering extensions can re-mount or update UI immediately.'),
});

async function resolvePrimaryBookName(
    author: HostAuthorBridge,
    requestedBookName?: string,
): Promise<string> {
    const primary = await author.getPrimaryWorldName();
    if (!primary) {
        throw new Error('Active character has no primary bound World Info book.');
    }
    if (requestedBookName && requestedBookName.trim() !== '' && requestedBookName !== primary) {
        throw new Error(
            `Book "${requestedBookName}" is not the active character's primary World Info book ("${primary}"). Use full mode for other enabled books.`,
        );
    }
    return primary;
}

/**
 * Create the 9 `author` mode tools (`AUTHOR_TOOLS`): active character card,
 * primary World Info (raw `@@` & `<% ... %>` EJS, NO `escapeAt`), scoped regex,
 * and card-embed.
 */
export function createAuthorTools(): AssistantToolDefinition[] {
    const cardReadFullTool: AssistantToolDefinition<typeof CARD_READ_FULL_SCHEMA> = {
        name: 'card_read_full',
        description:
            'Read the complete active character card fields, data, and extensions via HostAuthorBridge. Read-only.',
        parameters: CARD_READ_FULL_SCHEMA,
        tier: 'author',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const card = await author.getActiveCharacterFull();
            if (!card) {
                return finalizeToolError('No active character card is selected.', ctx.signal);
            }
            return finalizeReadToolResult({ ok: true, character: card });
        },
    };

    const cardPatchActiveTool: AssistantToolDefinition<typeof CARD_PATCH_ACTIVE_SCHEMA> = {
        name: 'card_patch_active',
        description:
            'Permanently patch fields on the active character card via HostAuthorBridge. Requires approval unless autoApproveAuthor is enabled. Captures pre-write UndoRecord.',
        parameters: CARD_PATCH_ACTIVE_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const before = await author.getActiveCharacterFull();
            const fields = args.fields as HostCharacterPatch;
            const beforeSubset: Record<string, unknown> = {};
            for (const key of Object.keys(fields)) {
                beforeSubset[key] = before ? before[key] ?? '' : '';
            }
            const beforeRedacted = redactWithReport(beforeSubset).value;
            const afterRedacted = redactWithReport(fields).value;
            const beforeText = JSON.stringify(beforeRedacted, null, 2);
            const afterText = JSON.stringify(afterRedacted, null, 2);
            const fieldList = Object.keys(fields).join(', ');
            return {
                title: `Patch active character card (${before?.name ?? 'Active Card'})`,
                summary: `Permanently update fields: ${fieldList || '(none)'}.`,
                targetLabel: `Active Card: ${before?.name ?? 'current'}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const fields = args.fields as HostCharacterPatch;
            if (!fields || Object.keys(fields).length === 0) {
                return finalizeToolError('card_patch_active requires at least one field to patch.', ctx.signal);
            }

            const before = await author.getActiveCharacterFull();
            if (!before) {
                return finalizeToolError('No active character card is selected.', ctx.signal);
            }

            const previousFields = extractPreviousCharacterFields(before, fields);
            const updated = await author.patchActiveCharacter(fields, {
                sessionId: ctx.sessionId,
                toolCallId: ctx.toolCallId,
                reason: 'assistant:card_patch_active',
            });

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_patch_active',
                        kind: 'character',
                        label: `Patch active card: ${before.name}`,
                        scope: `card:active:${before.chid}`,
                        beforeSummary: truncateSummary(JSON.stringify(previousFields)),
                        afterSummary: truncateSummary(JSON.stringify(fields)),
                        snapshot: {
                            scope: 'active',
                            chid: before.chid,
                            previousFields,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    chid: updated.chid,
                    name: updated.name,
                    patchedFields: Object.keys(fields),
                    character: updated,
                },
                { undoId },
            );
        },
    };

    const wiReadRawBookTool: AssistantToolDefinition<typeof WI_READ_RAW_BOOK_SCHEMA> = {
        name: 'wi_read_raw_book',
        description:
            'Read raw entries (including raw @@ decorators and <% ... %> EJS code) from the active character primary World Info book. Read-only.',
        parameters: WI_READ_RAW_BOOK_SCHEMA,
        tier: 'author',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const primaryBook = await resolvePrimaryBookName(author, args.bookName);
            const snapshot = await author.readWorldInfoBook(primaryBook);
            if (!snapshot) {
                return finalizeToolError(
                    `World Info book "${primaryBook}" was not found.`,
                    ctx.signal,
                );
            }
            return finalizeReadToolResult({
                ok: true,
                bookName: snapshot.name,
                entryCount: snapshot.entries.length,
                entries: snapshot.entries,
            });
        },
    };

    const wiUpsertPrimaryEntryTool: AssistantToolDefinition<typeof WI_UPSERT_PRIMARY_ENTRY_SCHEMA> = {
        name: 'wi_upsert_primary_entry',
        description:
            'Permanently create or update an entry in the active character primary World Info book. Preserves raw @@ decorators and <% ... %> EJS verbatim (no escapeAt) with non-blocking syntax warnings.',
        parameters: WI_UPSERT_PRIMARY_ENTRY_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const primaryBook = await resolvePrimaryBookName(author, args.bookName);
            const book = await author.readWorldInfoBook(primaryBook);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;
            const beforeText = existing?.content ?? '';
            const warnings = lintWorldInfoContent(args.content);
            const warnNote = warnings.length > 0 ? ` (${warnings.length} syntax warning(s))` : '';
            const uidLabel = args.uid !== undefined ? `#${args.uid}` : 'new entry';
            return {
                title: `${existing ? 'Update' : 'Create'} primary WI ${uidLabel}${args.comment ? ` (${args.comment})` : ''}`,
                summary: `Write raw World Info entry to "${primaryBook}"${warnNote}.`,
                targetLabel: `WI: ${primaryBook} / ${uidLabel}`,
                beforeText,
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, args.content),
                ...(warnings.length > 0 ? { warnings } : {}),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const primaryBook = await resolvePrimaryBookName(author, args.bookName);
            const book = await author.readWorldInfoBook(primaryBook);
            const existing =
                args.uid !== undefined
                    ? book?.entries.find((e) => e.uid === args.uid)
                    : undefined;

            const warnings = lintWorldInfoContent(args.content);
            const payload = toWorldInfoUpsertPayload(args, existing);

            // CRITICAL: rawDirect: true passes raw @@ decorators and <% ... %> EJS verbatim WITHOUT escapeAt
            const saved = await author.upsertWorldInfoEntry(primaryBook, payload, {
                rawDirect: true,
                undoMeta: {
                    sessionId: ctx.sessionId,
                    toolCallId: ctx.toolCallId,
                    reason: 'assistant:wi_upsert_primary_entry',
                },
            });

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_upsert_primary_entry',
                        kind: 'worldinfo',
                        label: `${existing ? 'Update' : 'Create'} WI ${primaryBook} #${saved.uid}`,
                        scope: `wi:${primaryBook}#${saved.uid}`,
                        beforeSummary: existing
                            ? truncateSummary(existing.content)
                            : '(new entry)',
                        afterSummary: truncateSummary(saved.content),
                        snapshot: {
                            action: existing ? 'update_entry' : 'create_entry',
                            bookName: primaryBook,
                            uid: saved.uid,
                            previousEntry: existing ? canonicalClone(existing) : null,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    bookName: primaryBook,
                    entry: saved,
                },
                { undoId, warnings },
            );
        },
    };

    const wiDeletePrimaryEntryTool: AssistantToolDefinition<typeof WI_DELETE_PRIMARY_ENTRY_SCHEMA> = {
        name: 'wi_delete_primary_entry',
        description:
            'Permanently delete an entry by UID from the active character primary World Info book. High-risk mandatoryConfirm operation.',
        parameters: WI_DELETE_PRIMARY_ENTRY_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const primaryBook = await resolvePrimaryBookName(author, args.bookName);
            const book = await author.readWorldInfoBook(primaryBook);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            const beforeText = existing?.content ?? `(entry #${args.uid} not found)`;
            return {
                title: `Delete primary WI #${args.uid}${existing?.comment ? ` (${existing.comment})` : ''}`,
                summary: `Permanently delete entry #${args.uid} from "${primaryBook}".`,
                targetLabel: `WI: ${primaryBook} / #${args.uid}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const primaryBook = await resolvePrimaryBookName(author, args.bookName);
            const book = await author.readWorldInfoBook(primaryBook);
            const existing = book?.entries.find((e) => e.uid === args.uid);
            if (!existing) {
                return finalizeToolError(
                    `World Info entry #${args.uid} not found in "${primaryBook}".`,
                    ctx.signal,
                );
            }

            const deleted = await author.deleteWorldInfoEntry(primaryBook, args.uid);
            if (!deleted) {
                return finalizeToolError(
                    `Failed to delete World Info entry #${args.uid} from "${primaryBook}".`,
                    ctx.signal,
                );
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'wi_delete_primary_entry',
                        kind: 'worldinfo',
                        label: `Delete WI ${primaryBook} #${args.uid}`,
                        scope: `wi:${primaryBook}#${args.uid}`,
                        beforeSummary: truncateSummary(existing.content),
                        afterSummary: '(deleted)',
                        snapshot: {
                            action: 'delete_entry',
                            bookName: primaryBook,
                            uid: args.uid,
                            previousEntry: canonicalClone(existing),
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    bookName: primaryBook,
                    deletedUid: args.uid,
                },
                { undoId },
            );
        },
    };

    const regexListScopedTool: AssistantToolDefinition<typeof REGEX_LIST_SCOPED_SCHEMA> = {
        name: 'regex_list_scoped',
        description:
            'List character-scoped regex scripts (SCRIPT_TYPES.SCOPED) for the active character. Read-only.',
        parameters: REGEX_LIST_SCOPED_SCHEMA,
        tier: 'author',
        readOnly: true,
        async execute(_args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const scripts = await author.listScopedRegex();
            return finalizeReadToolResult({
                ok: true,
                total: scripts.length,
                scripts,
            });
        },
    };

    const regexUpsertScopedTool: AssistantToolDefinition<typeof REGEX_UPSERT_SCHEMA> = {
        name: 'regex_upsert_scoped',
        description:
            'Create or update a character-scoped regex script (SCRIPT_TYPES.SCOPED). Captures pre-write UndoRecord.',
        parameters: REGEX_UPSERT_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const before = await author.listScopedRegex();
            const candidate = normalizeRegexUpsertInput(args, 'regex_scoped');
            const existing = before.find((s) => s.id === candidate.id);
            const beforeText = existing ? JSON.stringify(existing, null, 2) : '';
            const afterText = JSON.stringify(candidate, null, 2);
            return {
                title: `${existing ? 'Update' : 'Add'} scoped regex "${candidate.scriptName}"`,
                summary: `${existing ? 'Modify' : 'Create'} character-scoped regex "${candidate.scriptName}" (${candidate.id}).`,
                targetLabel: `Scoped Regex: ${candidate.scriptName}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const previousScripts = canonicalClone(await author.listScopedRegex());
            const script = normalizeRegexUpsertInput(args, 'regex_scoped');

            const nextScripts = canonicalClone(previousScripts);
            const idx = nextScripts.findIndex((s) => s.id === script.id);
            if (idx >= 0) {
                nextScripts[idx] = script;
            } else {
                nextScripts.push(script);
            }

            await author.saveScopedRegex(nextScripts);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'regex_upsert_scoped',
                        kind: 'regex',
                        label: `${idx >= 0 ? 'Update' : 'Create'} scoped regex: ${script.scriptName}`,
                        scope: `regex:scoped:${script.id}`,
                        beforeSummary: `${previousScripts.length} scoped regex script(s)`,
                        afterSummary: `${nextScripts.length} scoped regex script(s) (${script.scriptName})`,
                        snapshot: {
                            scope: 'scoped',
                            previousScripts,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    script,
                    total: nextScripts.length,
                },
                { undoId },
            );
        },
    };

    const regexDeleteScopedTool: AssistantToolDefinition<typeof REGEX_DELETE_SCOPED_SCHEMA> = {
        name: 'regex_delete_scoped',
        description:
            'Permanently delete a character-scoped regex script by ID. High-risk mandatoryConfirm operation.',
        parameters: REGEX_DELETE_SCOPED_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const before = await author.listScopedRegex();
            const existing = before.find((s) => s.id === args.id);
            const beforeText = existing
                ? JSON.stringify(existing, null, 2)
                : `(scoped regex "${args.id}" not found)`;
            return {
                title: `Delete scoped regex "${existing?.scriptName ?? args.id}"`,
                summary: `Permanently delete character-scoped regex "${args.id}".`,
                targetLabel: `Scoped Regex: ${existing?.scriptName ?? args.id}`,
                beforeText,
                afterText: '',
                rawContent: '',
                diffLines: computeDiffLines(beforeText, ''),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const previousScripts = canonicalClone(await author.listScopedRegex());
            const existing = previousScripts.find((s) => s.id === args.id);
            if (!existing) {
                return finalizeToolError(`Scoped regex "${args.id}" not found.`, ctx.signal);
            }

            const nextScripts = previousScripts.filter((s) => s.id !== args.id);
            await author.saveScopedRegex(nextScripts);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'regex_delete_scoped',
                        kind: 'regex',
                        label: `Delete scoped regex: ${existing.scriptName}`,
                        scope: `regex:scoped:${args.id}`,
                        beforeSummary: truncateSummary(JSON.stringify(existing)),
                        afterSummary: '(deleted)',
                        snapshot: {
                            scope: 'scoped',
                            previousScripts,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    deletedId: args.id,
                    remaining: nextScripts.length,
                },
                { undoId },
            );
        },
    };

    const cardEmbedAgenticTool: AssistantToolDefinition<typeof CARD_EMBED_AGENTIC_SCHEMA> = {
        name: 'card_embed_agentic',
        description:
            'Package and embed ST-Agentic presets and/or files into the active character card extensions.',
        parameters: CARD_EMBED_AGENTIC_SCHEMA,
        tier: 'author',
        readOnly: false,
        async preview(args, ctx) {
            const author = requireAuthorBridge(ctx);
            const before = await author.getActiveCharacterFull();
            const beforeExt = JSON.stringify(before?.extensions ?? {}, null, 2);
            const afterPayload = JSON.stringify(args, null, 2);
            return {
                title: `Embed ST-Agentic payload into ${before?.name ?? 'active card'}`,
                summary: `Embed preset=${String(args.includePreset)}, files=${String(args.includeFiles)} into character extensions.`,
                targetLabel: `Card Embed: ${before?.name ?? 'active'}`,
                beforeText: beforeExt,
                afterText: afterPayload,
                rawContent: afterPayload,
                diffLines: computeDiffLines(beforeExt, afterPayload),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const author = requireAuthorBridge(ctx);
            const before = await author.getActiveCharacterFull();
            const result = await author.embedAgenticPayload(args);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'card_embed_agentic',
                        kind: 'character',
                        label: `Embed Agentic payload (${before?.name ?? 'active'})`,
                        scope: `card:embed:${before?.chid ?? 'active'}`,
                        beforeSummary: truncateSummary(JSON.stringify(before?.extensions ?? {})),
                        afterSummary: result.message,
                        snapshot: {
                            scope: 'active',
                            chid: before?.chid,
                            previousFields: {
                                extensions: canonicalClone(before?.extensions ?? {}),
                            },
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    embedResult: result,
                },
                { undoId },
            );
        },
    };

    const chatReloadMessagesTool: AssistantToolDefinition<typeof CHAT_RELOAD_MESSAGES_SCHEMA> = {
        name: 'chat_reload_messages',
        description:
            'Re-render displayed chat messages in place (re-applying ST formatting, regex rules, and any active third-party message renderers) without reloading the whole chat or triggering after_turn generation hooks. Read-only display refresh.',
        parameters: CHAT_RELOAD_MESSAGES_SCHEMA,
        tier: 'author',
        readOnly: true,
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (ctx.bridge.reloadDisplayedMessages) {
                const res = await ctx.bridge.reloadDisplayedMessages({
                    ...(args.messageIds ? { messageIds: args.messageIds } : {}),
                    limit: args.limit,
                    emitUpdateEvent: args.emitUpdateEvent,
                });
                return finalizeReadToolResult({
                    ok: true,
                    ...res,
                });
            }

            const chat = ctx.bridge.getChat();
            const limit = args.limit ?? 50;
            const candidateIds =
                args.messageIds && args.messageIds.length > 0
                    ? Array.from(new Set(args.messageIds))
                    : chat
                        .slice(Math.max(0, chat.length - limit))
                        .map((_, offset) => Math.max(0, chat.length - limit) + offset);

            const reloadedIds: number[] = [];
            const skippedIds: number[] = [];
            let emittedEvents = 0;

            for (const id of candidateIds) {
                if (id < 0 || id >= chat.length || !chat[id]) {
                    skippedIds.push(id);
                    continue;
                }
                const swipeId = chat[id]?.swipeId ?? 0;
                await ctx.bridge.refreshMessageView({ messageId: id, swipeId });
                reloadedIds.push(id);
                if (args.emitUpdateEvent !== false) {
                    ctx.bridge.emitHostEvent?.('message_updated', id);
                    emittedEvents += 1;
                }
            }

            return finalizeReadToolResult({
                ok: true,
                reloadedIds,
                skippedIds,
                emittedEvents,
            });
        },
    };

    return [
        cardReadFullTool,
        cardPatchActiveTool,
        wiReadRawBookTool,
        wiUpsertPrimaryEntryTool,
        wiDeletePrimaryEntryTool,
        regexListScopedTool,
        regexUpsertScopedTool,
        regexDeleteScopedTool,
        cardEmbedAgenticTool,
        chatReloadMessagesTool,
    ];
}
