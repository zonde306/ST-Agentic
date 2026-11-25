import { z } from 'zod';
import type { DeletedChatMessageSnapshot, ToolEditOperation } from '@/core/bridge';
import { DEFAULT_MAIN_AGENT_ID } from '@/core/config';
import { DATA_NAMESPACES, MESSAGE_OVERRIDE_KEY } from '@/core/store';
import { VfsVarsAdapter } from '@/core/tools';
import type { ChatEditSyncTrajectory, MessageTarget, VariableScope } from '@/core/types';
import { canonicalClone, normalizeVfsPath } from '@/core/utils';
import {
    applyTextEdits,
    countLines,
    scopeToVariablesPath,
    utf8ByteLength,
    VfsNotFoundError,
} from '@/core/vfs';
import { computeDiffLines } from './approval';
import { isVfsWritePathAllowed } from './policy';
import {
    finalizeMutationToolResult,
    finalizeToolError,
    throwIfAssistantAborted,
    truncateSummary,
    type AssistantToolContext,
    type AssistantToolDefinition,
} from './tools-chat';

const JSON_PATCH_OP_SCHEMA = z.object({
    op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
    path: z.string(),
    from: z.string().optional(),
    value: z.unknown().optional(),
});

const PATCH_VARIABLES_SCHEMA = z.object({
    scope: z
        .enum(['message', 'chat', 'global'])
        .optional()
        .default('message')
        .describe(
            'Variable scope: "message" (default, /state/variables.json), "chat" (/state/chat_variables.json), or "global" (/state/global_variables.json).',
        ),
    json_merge: z.record(z.string(), z.unknown()).optional(),
    json_patch: z.array(JSON_PATCH_OP_SCHEMA).optional(),
});

const WRITE_FILE_SCHEMA = z.object({
    path: z
        .string()
        .min(1)
        .describe('Writable VFS path strictly under /workspace/**, /state/**, /lorebooks/**, or /side/**.'),
    content: z.string().describe('Full replacement content.'),
});

const APPEND_FILE_SCHEMA = z.object({
    path: z
        .string()
        .min(1)
        .describe('Writable VFS path strictly under /workspace/**, /state/**, /lorebooks/**, or /side/**.'),
    content: z.string().describe('Content to append verbatim.'),
});

const ADJUST_EDIT_OPERATION_SCHEMA = z.object({
    search: z.string().min(1).optional().describe('Exact text snippet to replace (do NOT include "N| " line-number prefixes).'),
    replace: z.string().optional().describe('Replacement text.'),
    oldText: z.string().min(1).optional().describe('Alias for search.'),
    newText: z.string().optional().describe('Alias for replace.'),
    start_line: z.number().int().min(1).optional().describe('Optional 1-based inclusive start line to scope matching.'),
    end_line: z.number().int().min(1).optional().describe('Optional 1-based inclusive end line to scope matching.'),
    replace_all: z.boolean().optional().default(false).describe('Replace every match within scope.'),
});

const EDIT_FILE_SCHEMA = z.object({
    path: z
        .string()
        .min(1)
        .describe('Writable VFS path strictly under /workspace/**, /state/**, /lorebooks/**, or /side/**.'),
    search: z.string().min(1).optional().describe('Exact text snippet to replace (do NOT include "N| " line-number prefixes).'),
    replace: z.string().optional().describe('Replacement text.'),
    oldText: z.string().min(1).optional().describe('Alias for search.'),
    newText: z.string().optional().describe('Alias for replace.'),
    start_line: z.number().int().min(1).optional().describe('Optional 1-based inclusive start line to disambiguate matching.'),
    end_line: z.number().int().min(1).optional().describe('Optional 1-based inclusive end line to disambiguate matching.'),
    replace_all: z.boolean().optional().default(false).describe('Replace every match within scope instead of failing on ambiguity.'),
    edits: z
        .array(ADJUST_EDIT_OPERATION_SCHEMA)
        .min(1)
        .max(50)
        .optional()
        .describe('Optional batch of atomic non-overlapping edits (all line numbers refer to the file before edits).'),
});

function resolveAdjustEditOps(
    args: z.infer<typeof EDIT_FILE_SCHEMA>,
): ToolEditOperation[] | null {
    if (args.edits && args.edits.length > 0) {
        const ops: ToolEditOperation[] = [];
        for (const item of args.edits) {
            const search = item.search ?? item.oldText;
            const replace = item.replace ?? item.newText;
            if (!search || replace === undefined) {
                return null;
            }
            ops.push({
                search,
                replace,
                ...(item.start_line !== undefined ? { startLine: item.start_line } : {}),
                ...(item.end_line !== undefined ? { endLine: item.end_line } : {}),
                ...(item.replace_all !== undefined ? { replaceAll: item.replace_all } : {}),
            });
        }
        return ops;
    }

    const search = args.search ?? args.oldText;
    const replace = args.replace ?? args.newText;
    if (!search || replace === undefined) {
        return null;
    }
    return [
        {
            search,
            replace,
            ...(args.start_line !== undefined ? { startLine: args.start_line } : {}),
            ...(args.end_line !== undefined ? { endLine: args.end_line } : {}),
            ...(args.replace_all !== undefined ? { replaceAll: args.replace_all } : {}),
        },
    ];
}

const MESSAGE_TARGET_SCHEMA = z.object({
    messageId: z.number().int().min(0),
    swipeId: z.number().int().min(0).optional().default(0),
});

const CHAT_CREATE_MESSAGE_SCHEMA = z.object({
    role: z
        .enum(['user', 'assistant', 'system'])
        .describe('Message speaker role: "user", "assistant", or "system".'),
    content: z.string().describe('Raw markdown/text content of the new message.'),
    name: z
        .string()
        .optional()
        .describe('Optional display name override; defaults to current user, character, or System name.'),
    insertAt: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Optional 0-based insertion index (0..chat.length). Omit to append at the end of chat.'),
    hidden: z
        .boolean()
        .optional()
        .describe('Optional is_system visibility override (defaults to true for "system", false otherwise).'),
    syncTrajectory: z
        .enum(['none', 'rewrite'])
        .optional()
        .default('none')
        .describe(
            'Mainline trajectory sync strategy. Defaults to "none" (zero mutation to mainline TrajectoryStore prefix cache).',
        ),
});

const CHAT_DELETE_MESSAGE_SCHEMA = z.object({
    messageId: z.number().int().min(0).optional().describe('Single 0-based chat message index to delete.'),
    messageIds: z
        .array(z.number().int().min(0))
        .min(1)
        .optional()
        .describe('Optional array of 0-based chat message indices to delete atomically.'),
    syncTrajectory: z
        .enum(['none', 'rewrite'])
        .optional()
        .default('none')
        .describe(
            'Mainline trajectory sync strategy. Defaults to "none" (zero mutation to mainline TrajectoryStore prefix cache).',
        ),
});

const CHAT_EDIT_MESSAGE_SCHEMA = z.object({
    target: MESSAGE_TARGET_SCHEMA.describe('Target chat message { messageId, swipeId }.'),
    oldText: z
        .string()
        .optional()
        .describe('Optional exact snippet to replace inside the target message; omit to replace entire content.'),
    newText: z.string().describe('Replacement text (or full new content when oldText is omitted).'),
    syncTrajectory: z
        .enum(['none', 'rewrite', 'fork'])
        .optional()
        .default('none')
        .describe(
            'Mainline trajectory sync strategy. Defaults to "none" (zero mutation to mainline TrajectoryStore prefix cache).',
        ),
});

const CHAT_TOGGLE_HIDE_MESSAGE_SCHEMA = z.object({
    messageId: z.number().int().min(0).describe('0-based chat message index.'),
    hidden: z.boolean().describe('true to mark as hidden/system message (is_system), false to show.'),
});

const MESSAGE_OVERRIDE_DISPLAY_SCHEMA = z.object({
    target: MESSAGE_TARGET_SCHEMA.describe('Target chat message { messageId, swipeId }.'),
    content: z.string().describe('Display-only override content (does not alter LLM context).'),
});

interface VfsPreWriteSnapshot {
    path: string;
    existed: boolean;
    hadOverride: boolean;
    previousContent: string | null;
}

async function captureVfsSnapshot(
    normalizedPath: string,
    ctx: AssistantToolContext,
): Promise<VfsPreWriteSnapshot> {
    const stat = await ctx.vfs.stat(normalizedPath, { target: ctx.target, staged: false });
    if (!stat || stat.kind !== 'file') {
        return {
            path: normalizedPath,
            existed: false,
            hadOverride: false,
            previousContent: null,
        };
    }

    let previousContent: string | null = null;
    try {
        previousContent = await ctx.vfs.readFile(normalizedPath, {
            target: ctx.target,
            staged: false,
        });
    } catch (error) {
        if (!(error instanceof VfsNotFoundError)) {
            throw error;
        }
    }

    return {
        path: normalizedPath,
        existed: previousContent !== null,
        hadOverride: Boolean(stat.overridden),
        previousContent,
    };
}

function recordVfsUndo(
    ctx: AssistantToolContext,
    toolName: string,
    snapshot: VfsPreWriteSnapshot,
    afterContent: string,
): string | undefined {
    if (ctx.captureUndo === false) {
        return undefined;
    }
    const rec = ctx.undoStore.push({
        sessionId: ctx.sessionId,
        toolCallId: ctx.toolCallId,
        toolName,
        kind: 'vfs_file',
        label: `${toolName}: ${snapshot.path}`,
        scope: `vfs:${snapshot.path}`,
        beforeSummary: snapshot.existed
            ? truncateSummary(snapshot.previousContent ?? '')
            : '(file did not exist)',
        afterSummary: truncateSummary(afterContent),
        snapshot: {
            path: snapshot.path,
            existed: snapshot.existed,
            hadOverride: snapshot.hadOverride,
            isLorebook: snapshot.path.startsWith('/lorebooks/'),
            previousContent: snapshot.previousContent,
        },
        target: ctx.target,
    });
    return rec.id;
}

function assertAllowedAdjustPath(rawPath: string): string {
    if (!isVfsWritePathAllowed(rawPath)) {
        throw new Error(
            `VFS write path "${rawPath}" is outside allowed scopes (/workspace/**, /state/**, /lorebooks/**, /side/**).`,
        );
    }
    return normalizeVfsPath(rawPath);
}

function resolveDeleteMessageIds(args: {
    messageId?: number;
    messageIds?: number[];
}): number[] {
    const idSet = new Set<number>();
    if (typeof args.messageId === 'number' && Number.isInteger(args.messageId) && args.messageId >= 0) {
        idSet.add(args.messageId);
    }
    if (Array.isArray(args.messageIds)) {
        for (const id of args.messageIds) {
            if (typeof id === 'number' && Number.isInteger(id) && id >= 0) {
                idSet.add(id);
            }
        }
    }
    return Array.from(idSet).sort((a, b) => a - b);
}

/**
 * Create the 9 `adjust` current-chat mutation tools (`ADJUST_WRITE_TOOLS`).
 * Every write enforces scope allowlists and captures a pre-write `UndoRecord`.
 */
export function createAdjustTools(): AssistantToolDefinition[] {
    const patchVariablesTool: AssistantToolDefinition<typeof PATCH_VARIABLES_SCHEMA> = {
        name: 'patch_variables',
        description:
            'Apply an RFC 7396 JSON Merge Patch (`json_merge`) and/or RFC 6902 JSON Patch (`json_patch`) to SillyTavern native variables (/state/variables.json for message branch, /state/chat_variables.json for chat, /state/global_variables.json for global).',
        parameters: PATCH_VARIABLES_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const scope: VariableScope = args.scope ?? 'message';
            const filePath = scopeToVariablesPath(scope);
            const beforeVars = await ctx.vfs.readVariables({
                target: ctx.target,
                staged: false,
                scope,
            });
            const beforeText = JSON.stringify(beforeVars, null, 2);
            const rawContent = JSON.stringify(args, null, 2);
            return {
                title: `Patch ${scope} variables`,
                summary: `Update ${filePath} (${scope} scope).`,
                targetLabel: `VFS: ${filePath}`,
                beforeText,
                afterText: rawContent,
                rawContent,
                diffLines: computeDiffLines(beforeText, rawContent),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (!args.json_merge && (!args.json_patch || args.json_patch.length === 0)) {
                return finalizeToolError(
                    'patch_variables requires at least one of "json_merge" or "json_patch".',
                    ctx.signal,
                );
            }

            const scope: VariableScope = args.scope ?? 'message';
            const filePath = scopeToVariablesPath(scope);
            const beforeVars = canonicalClone(
                await ctx.vfs.readVariables({ target: ctx.target, staged: false, scope }),
            );
            const adapter = new VfsVarsAdapter(ctx.vfs, {
                target: ctx.target,
                staged: false,
                source: 'assistant:patch_variables',
                signal: ctx.signal,
                getSchema: ctx.getVariableSchema,
            });

            let updated = beforeVars;
            if (args.json_merge) {
                updated = await adapter.patch(args.json_merge, { scope });
            }
            if (args.json_patch && args.json_patch.length > 0) {
                updated = await adapter.patch(args.json_patch, { scope });
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'patch_variables',
                        kind: 'variables',
                        label: `Patch ${scope} variables (${filePath})`,
                        scope: `vfs:${filePath}`,
                        beforeSummary: truncateSummary(JSON.stringify(beforeVars)),
                        afterSummary: truncateSummary(JSON.stringify(updated)),
                        snapshot: {
                            previousVars: beforeVars,
                            scope,
                        },
                        target: ctx.target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    scope,
                    path: filePath,
                    variables: updated,
                    target: ctx.target,
                },
                { undoId, fileRefs: [filePath] },
            );
        },
    };

    const writeFileTool: AssistantToolDefinition<typeof WRITE_FILE_SCHEMA> = {
        name: 'write_file',
        description:
            'Create or overwrite a VFS file under /workspace/** (/workspace/AGENTS.md asks mandatory user confirmation; /workspace/docs/** and /workspace/shared/** apply directly), /state/**, /lorebooks/** (preserves escapeAt), or /side/**. Captures pre-write UndoRecord.',
        parameters: WRITE_FILE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const snap = await captureVfsSnapshot(normalizedPath, ctx);
            const beforeText = snap.previousContent ?? '';
            return {
                title: `Write ${normalizedPath}`,
                summary: `Write ${utf8ByteLength(args.content)} bytes to ${normalizedPath}.`,
                targetLabel: `VFS: ${normalizedPath}`,
                beforeText,
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, args.content),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const snapshot = await captureVfsSnapshot(normalizedPath, ctx);

            await ctx.vfs.writeFile(normalizedPath, args.content, {
                target: ctx.target,
                staged: false,
                source: 'assistant:write_file',
            });

            const undoId = recordVfsUndo(ctx, 'write_file', snapshot, args.content);
            return finalizeMutationToolResult(
                {
                    path: normalizedPath,
                    bytes: utf8ByteLength(args.content),
                    totalLines: countLines(args.content),
                    target: ctx.target,
                },
                { undoId, fileRefs: [normalizedPath] },
            );
        },
    };

    const appendFileTool: AssistantToolDefinition<typeof APPEND_FILE_SCHEMA> = {
        name: 'append_file',
        description:
            'Append content verbatim to a VFS file under /workspace/** (/workspace/AGENTS.md requires confirmation; /workspace/docs/** and /workspace/shared/** apply directly), /state/**, /lorebooks/**, or /side/**. Captures pre-write UndoRecord.',
        parameters: APPEND_FILE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const snap = await captureVfsSnapshot(normalizedPath, ctx);
            const beforeText = snap.previousContent ?? '';
            const afterText = `${beforeText}${args.content}`;
            return {
                title: `Append ${normalizedPath}`,
                summary: `Append ${utf8ByteLength(args.content)} bytes to ${normalizedPath}.`,
                targetLabel: `VFS: ${normalizedPath}`,
                beforeText,
                afterText,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const snapshot = await captureVfsSnapshot(normalizedPath, ctx);

            await ctx.vfs.appendFile(normalizedPath, args.content, {
                target: ctx.target,
                staged: false,
                source: 'assistant:append_file',
            });

            const afterContent = `${snapshot.previousContent ?? ''}${args.content}`;
            const undoId = recordVfsUndo(ctx, 'append_file', snapshot, afterContent);
            return finalizeMutationToolResult(
                {
                    path: normalizedPath,
                    appendedBytes: utf8ByteLength(args.content),
                    totalLines: countLines(afterContent),
                    target: ctx.target,
                },
                { undoId, fileRefs: [normalizedPath] },
            );
        },
    };

    const editFileTool: AssistantToolDefinition<typeof EDIT_FILE_SCHEMA> = {
        name: 'edit_file',
        description:
            'Safely replace exact match(es) in a VFS file under /workspace/**, /state/**, /lorebooks/**, or /side/**. Rejects ambiguous multi-matches unless scoped via start_line/end_line or replace_all: true, and supports atomic batch edits[]. Do NOT copy "N| " line-number prefixes. Captures pre-write UndoRecord.',
        parameters: EDIT_FILE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const snap = await captureVfsSnapshot(normalizedPath, ctx);
            const beforeText = snap.previousContent ?? '';
            const ops = resolveAdjustEditOps(args);
            const previewApplied = ops
                ? applyTextEdits({ path: normalizedPath, content: beforeText, edits: ops })
                : null;
            const afterText =
                previewApplied?.ok && previewApplied.updatedContent !== undefined
                    ? previewApplied.updatedContent
                    : beforeText;
            return {
                title: `Edit ${normalizedPath}`,
                summary:
                    ops && ops.length > 1
                        ? `Apply ${ops.length} edits in ${normalizedPath}.`
                        : `Replace snippet in ${normalizedPath}.`,
                targetLabel: `VFS: ${normalizedPath}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const normalizedPath = assertAllowedAdjustPath(args.path);
            const ops = resolveAdjustEditOps(args);

            if (!ops) {
                return finalizeToolError(
                    'edit_file requires "search" (or "oldText") and "replace" (or "newText"), or a valid "edits" array.',
                    ctx.signal,
                );
            }

            const snapshot = await captureVfsSnapshot(normalizedPath, ctx);
            const first = ops[0];
            const result = await ctx.vfs.editFile(normalizedPath, first.search, first.replace, {
                ...(first.startLine !== undefined ? { startLine: first.startLine } : {}),
                ...(first.endLine !== undefined ? { endLine: first.endLine } : {}),
                ...(first.replaceAll !== undefined ? { replaceAll: first.replaceAll } : {}),
                edits: ops,
                target: ctx.target,
                staged: false,
                source: 'assistant:edit_file',
            });

            if (!result.ok) {
                return finalizeToolError(result.message, ctx.signal, {
                    path: result.path,
                    ...(result.code ? { code: result.code } : {}),
                    ...(result.matchLines ? { matchLines: result.matchLines } : {}),
                });
            }

            const afterContent = await ctx.vfs
                .readFile(normalizedPath, { target: ctx.target, staged: false })
                .catch(() => '');
            const undoId = recordVfsUndo(ctx, 'edit_file', snapshot, afterContent);
            return finalizeMutationToolResult(
                {
                    path: result.path,
                    message: result.message,
                    ...(result.replacements !== undefined ? { replacements: result.replacements } : {}),
                    ...(result.changedRanges ? { changedRanges: result.changedRanges } : {}),
                    ...(result.totalLines !== undefined ? { totalLines: result.totalLines } : {}),
                    ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
                    target: ctx.target,
                },
                { undoId, fileRefs: [normalizedPath] },
            );
        },
    };

    const chatCreateMessageTool: AssistantToolDefinition<typeof CHAT_CREATE_MESSAGE_SCHEMA> = {
        name: 'chat_create_message',
        description:
            'Create a new chat message (user, assistant, or system) via HostBridge.createChatMessage(..., { emitEvent: true }). Supports appending or inserting at insertAt. Defaults to syncTrajectory: "none". Captures pre-write UndoRecord.',
        parameters: CHAT_CREATE_MESSAGE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const chat = ctx.bridge.getChat();
            const targetIndex = args.insertAt ?? chat.length;
            const identity = ctx.bridge.getActiveIdentity();
            const speakerName =
                args.name?.trim()
                || (args.role === 'user'
                    ? identity.userName || 'User'
                    : args.role === 'system'
                      ? 'System'
                      : identity.charName || 'Assistant');
            const actionLabel =
                args.insertAt !== undefined
                    ? `Insert at #${targetIndex}`
                    : `Append as #${targetIndex}`;
            return {
                title: `Create ${args.role} message (${actionLabel})`,
                summary: `${actionLabel} (${speakerName}, syncTrajectory=${args.syncTrajectory ?? 'none'}).`,
                targetLabel: `Chat: #${targetIndex}`,
                beforeText: '',
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines('', args.content),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (!ctx.bridge.createChatMessage) {
                return finalizeToolError(
                    'HostBridge.createChatMessage is not available in this environment.',
                    ctx.signal,
                );
            }

            const chat = ctx.bridge.getChat();
            if (args.insertAt !== undefined && (args.insertAt < 0 || args.insertAt > chat.length)) {
                return finalizeToolError(
                    `Invalid insertAt index ${args.insertAt} for chat length ${chat.length}.`,
                    ctx.signal,
                );
            }

            const syncTrajectory = args.syncTrajectory ?? 'none';
            const created = await ctx.bridge.createChatMessage(
                {
                    role: args.role,
                    content: args.content,
                    ...(args.name !== undefined ? { name: args.name } : {}),
                    ...(args.insertAt !== undefined ? { insertAt: args.insertAt } : {}),
                    ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
                },
                { emitEvent: true },
            );

            // Default syncTrajectory: 'none' MUST NOT touch mainline TrajectoryStore prefix cache.
            if (syncTrajectory === 'rewrite' && ctx.trajectoryStore) {
                ctx.trajectoryStore.pruneFromMessage(created.id, DEFAULT_MAIN_AGENT_ID);
            }

            const target: MessageTarget = {
                messageId: created.id,
                swipeId: created.swipeId ?? 0,
            };

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                          sessionId: ctx.sessionId,
                          toolCallId: ctx.toolCallId,
                          toolName: 'chat_create_message',
                          kind: 'chat_message',
                          label: `Create ${args.role} message #${created.id}`,
                          scope: `chat:${created.id}`,
                          beforeSummary: '(message did not exist)',
                          afterSummary: truncateSummary(created.mes),
                          snapshot: {
                              action: 'create',
                              messageId: created.id,
                              role: args.role,
                              name: created.name,
                              content: created.mes,
                              isUser: created.isUser,
                              isSystem: Boolean(created.isSystem),
                              syncTrajectory,
                          },
                          target,
                      }).id;

            return finalizeMutationToolResult(
                {
                    messageId: created.id,
                    target,
                    role: args.role,
                    name: created.name,
                    isUser: created.isUser,
                    isSystem: Boolean(created.isSystem),
                    content: created.mes,
                    chatLength: ctx.bridge.getChat().length,
                    syncTrajectory,
                },
                { undoId },
            );
        },
    };

    const chatEditMessageTool: AssistantToolDefinition<typeof CHAT_EDIT_MESSAGE_SCHEMA> = {
        name: 'chat_edit_message',
        description:
            'Edit a chat message via HostBridge.writeChatMessage(..., { emitEvent: true }). Defaults to syncTrajectory: "none" (zero mainline KV cache invalidation). Captures pre-write UndoRecord.',
        parameters: CHAT_EDIT_MESSAGE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const target: MessageTarget = {
                messageId: args.target.messageId,
                swipeId: args.target.swipeId ?? 0,
            };
            const current = ctx.bridge.readChatMessage(target) ?? '';
            const nextContent =
                args.oldText !== undefined && args.oldText.length > 0
                    ? current.replace(args.oldText, args.newText)
                    : args.newText;
            return {
                title: `Edit chat message #${target.messageId}#${target.swipeId}`,
                summary: `Update message #${target.messageId}#${target.swipeId} (syncTrajectory=${args.syncTrajectory}).`,
                targetLabel: `Chat: #${target.messageId}#${target.swipeId}`,
                beforeText: current,
                afterText: nextContent,
                rawContent: nextContent,
                diffLines: computeDiffLines(current, nextContent),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const target: MessageTarget = {
                messageId: args.target.messageId,
                swipeId: args.target.swipeId ?? 0,
            };
            const syncTrajectory: ChatEditSyncTrajectory = args.syncTrajectory ?? 'none';
            const current = ctx.bridge.readChatMessage(target);
            if (current === null) {
                return finalizeToolError(
                    `Chat message target #${target.messageId}#${target.swipeId} not found.`,
                    ctx.signal,
                );
            }

            let nextContent: string;
            if (args.oldText !== undefined && args.oldText.length > 0) {
                if (!current.includes(args.oldText)) {
                    return finalizeToolError(
                        `oldText snippet not found in chat message #${target.messageId}#${target.swipeId}.`,
                        ctx.signal,
                    );
                }
                nextContent = current.replace(args.oldText, args.newText);
            } else {
                nextContent = args.newText;
            }

            await ctx.bridge.writeChatMessage(target, nextContent, { emitEvent: true });

            // Default syncTrajectory: 'none' MUST NOT touch mainline TrajectoryStore prefix cache.
            if (syncTrajectory === 'rewrite' && ctx.trajectoryStore) {
                ctx.trajectoryStore.pruneFromMessage(target.messageId, DEFAULT_MAIN_AGENT_ID);
            } else if (syncTrajectory === 'fork' && ctx.trajectoryStore) {
                ctx.trajectoryStore.pruneSwipe(target, DEFAULT_MAIN_AGENT_ID);
                ctx.trajectoryStore.restoreBeforeMessage(target.messageId, DEFAULT_MAIN_AGENT_ID);
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'chat_edit_message',
                        kind: 'chat_message',
                        label: `Edit chat message #${target.messageId}#${target.swipeId}`,
                        scope: `chat:${target.messageId}#${target.swipeId}`,
                        beforeSummary: truncateSummary(current),
                        afterSummary: truncateSummary(nextContent),
                        snapshot: {
                            action: 'edit',
                            target,
                            previousContent: current,
                            newContent: nextContent,
                            syncTrajectory,
                        },
                        target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    target,
                    syncTrajectory,
                    content: nextContent,
                },
                { undoId },
            );
        },
    };

    const chatDeleteMessageTool: AssistantToolDefinition<typeof CHAT_DELETE_MESSAGE_SCHEMA> = {
        name: 'chat_delete_message',
        description:
            'Physically delete one or more chat messages (`messageId` or `messageIds`) via HostBridge.deleteChatMessage(..., { emitEvent: true }). Defaults to syncTrajectory: "none". Captures pre-write UndoRecord for atomic restoration.',
        parameters: CHAT_DELETE_MESSAGE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const ids = resolveDeleteMessageIds(args);
            const chat = ctx.bridge.getChat();
            if (ids.length === 0) {
                return {
                    title: 'Delete chat message(s)',
                    summary: 'No messageId or messageIds specified.',
                    targetLabel: 'Chat Message',
                    beforeText: '',
                    afterText: '',
                    rawContent: '',
                    diffLines: [],
                    warnings: ['Missing messageId or messageIds.'],
                };
            }

            if (ids.length === 1) {
                const id = ids[0];
                const msg = chat[id];
                const roleLabel = !msg
                    ? 'unknown'
                    : msg.isUser
                      ? 'user'
                      : msg.isSystem
                        ? 'system'
                        : 'assistant';
                const swipeCount = msg?.swipes?.length ?? 1;
                const swipeNote = swipeCount > 1 ? `, ${swipeCount} swipes` : '';
                const beforeText = msg?.mes ?? '';
                const summary = msg
                    ? `Delete #${id} (${msg.name || roleLabel}, ${roleLabel}${swipeNote}, syncTrajectory=${args.syncTrajectory ?? 'none'}).`
                    : `Target #${id} not found in current chat (length=${chat.length}).`;
                return {
                    title: `Delete chat message #${id}`,
                    summary,
                    targetLabel: `Chat: #${id}`,
                    beforeText,
                    afterText: '',
                    rawContent: beforeText,
                    diffLines: computeDiffLines(beforeText, ''),
                    ...(msg ? {} : { warnings: [`Message #${id} not found.`] }),
                };
            }

            const missingIds = ids.filter((id) => !chat[id]);
            const beforeText = ids
                .map((id) => {
                    const msg = chat[id];
                    if (!msg) {
                        return `--- #${id} (not found) ---`;
                    }
                    const speaker =
                        msg.name || (msg.isUser ? 'User' : msg.isSystem ? 'System' : 'Assistant');
                    return `--- #${id} [${speaker}] ---\n${msg.mes}`;
                })
                .join('\n\n');
            const previewLabels = ids.slice(0, 3).map((id) => `#${id}`).join(', ');
            const targetLabel =
                ids.length > 3 ? `Chat: ${previewLabels} (+${ids.length - 3})` : `Chat: ${previewLabels}`;

            return {
                title: `Delete ${ids.length} chat messages (${ids.map((id) => `#${id}`).join(', ')})`,
                summary: `Delete ${ids.length} messages in chat (syncTrajectory=${args.syncTrajectory ?? 'none'}).`,
                targetLabel,
                beforeText,
                afterText: '',
                rawContent: beforeText,
                diffLines: computeDiffLines(beforeText, ''),
                ...(missingIds.length > 0
                    ? { warnings: [`Missing message(s): ${missingIds.map((id) => `#${id}`).join(', ')}.`] }
                    : {}),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            if (!ctx.bridge.deleteChatMessage) {
                return finalizeToolError(
                    'HostBridge.deleteChatMessage is not available in this environment.',
                    ctx.signal,
                );
            }

            const ids = resolveDeleteMessageIds(args);
            if (ids.length === 0) {
                return finalizeToolError(
                    'chat_delete_message requires "messageId" or a non-empty "messageIds" array.',
                    ctx.signal,
                );
            }

            const chat = ctx.bridge.getChat();
            const missingIds = ids.filter((id) => id < 0 || id >= chat.length || !chat[id]);
            if (missingIds.length > 0) {
                return finalizeToolError(
                    `Chat message(s) not found: ${missingIds.map((id) => `#${id}`).join(', ')} (chat length: ${chat.length}).`,
                    ctx.signal,
                );
            }

            // Delete from highest index down so lower indices stay stable during batch deletion.
            const deletedAscending: DeletedChatMessageSnapshot[] = [];
            for (const id of [...ids].reverse()) {
                throwIfAssistantAborted(ctx.signal);
                const removed = await ctx.bridge.deleteChatMessage(id, { emitEvent: true });
                if (!removed) {
                    return finalizeToolError(
                        `Failed to delete chat message #${id}.`,
                        ctx.signal,
                    );
                }
                deletedAscending.unshift(removed);
            }

            const syncTrajectory = args.syncTrajectory ?? 'none';
            // Default syncTrajectory: 'none' MUST NOT touch mainline TrajectoryStore prefix cache.
            if (syncTrajectory === 'rewrite' && ctx.trajectoryStore) {
                ctx.trajectoryStore.pruneFromMessage(ids[0], DEFAULT_MAIN_AGENT_ID);
            }

            const firstRemoved = deletedAscending[0];
            const scope = ids.length === 1 ? `chat:${ids[0]}` : `chat:${ids.join(',')}`;
            const label =
                ids.length === 1
                    ? `Delete chat message #${ids[0]}`
                    : `Delete ${ids.length} chat messages (${ids.map((id) => `#${id}`).join(', ')})`;
            const beforeSummary =
                ids.length === 1
                    ? truncateSummary(firstRemoved.snapshot.mes)
                    : truncateSummary(
                          deletedAscending
                              .map((item) => `#${item.messageId}: ${item.snapshot.mes}`)
                              .join(' | '),
                      );

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                          sessionId: ctx.sessionId,
                          toolCallId: ctx.toolCallId,
                          toolName: 'chat_delete_message',
                          kind: 'chat_message',
                          label,
                          scope,
                          beforeSummary,
                          afterSummary: `(deleted ${ids.length} message${ids.length === 1 ? '' : 's'})`,
                          snapshot: {
                              action: 'delete',
                              deletedMessages: deletedAscending.map((item) => ({
                                  messageId: item.messageId,
                                  snapshot: item.snapshot,
                                  ...(item.rawMessage ? { rawMessage: item.rawMessage } : {}),
                              })),
                              syncTrajectory,
                          },
                          target: {
                              messageId: firstRemoved.messageId,
                              swipeId: firstRemoved.snapshot.swipeId ?? 0,
                          },
                      }).id;

            return finalizeMutationToolResult(
                {
                    deletedIds: ids,
                    deletedCount: ids.length,
                    remainingChatLength: ctx.bridge.getChat().length,
                    syncTrajectory,
                },
                { undoId },
            );
        },
    };

    const chatToggleHideMessageTool: AssistantToolDefinition<typeof CHAT_TOGGLE_HIDE_MESSAGE_SCHEMA> = {
        name: 'chat_toggle_hide_message',
        description:
            'Toggle SillyTavern hidden/system status (`is_system`) of a chat message and refresh its view. Captures pre-write UndoRecord.',
        parameters: CHAT_TOGGLE_HIDE_MESSAGE_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const msg = ctx.bridge.getChat()[args.messageId];
            const prevHidden = Boolean(msg?.isSystem);
            const beforeText = `hidden: ${String(prevHidden)}`;
            const afterText = `hidden: ${String(args.hidden)}`;
            return {
                title: `${args.hidden ? 'Hide' : 'Unhide'} chat message #${args.messageId}`,
                summary: `Set message #${args.messageId} is_system=${String(args.hidden)}.`,
                targetLabel: `Chat: #${args.messageId}`,
                beforeText,
                afterText,
                rawContent: afterText,
                diffLines: computeDiffLines(beforeText, afterText),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const chat = ctx.bridge.getChat();
            const msg = chat[args.messageId];
            if (!msg) {
                return finalizeToolError(`Chat message #${args.messageId} not found.`, ctx.signal);
            }
            if (!ctx.bridge.author) {
                return finalizeToolError(
                    'HostAuthorBridge is not available to toggle chat message visibility.',
                    ctx.signal,
                );
            }

            const previousHidden = Boolean(msg.isSystem);
            const target: MessageTarget = {
                messageId: args.messageId,
                swipeId: msg.swipeId ?? 0,
            };
            const toggled = await ctx.bridge.author.toggleChatMessageHidden(
                args.messageId,
                args.hidden,
            );
            if (!toggled) {
                return finalizeToolError(
                    `Failed to toggle visibility for message #${args.messageId}.`,
                    ctx.signal,
                );
            }

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'chat_toggle_hide_message',
                        kind: 'chat_message',
                        label: `${args.hidden ? 'Hide' : 'Show'} message #${args.messageId}`,
                        scope: `chat:${args.messageId}`,
                        beforeSummary: `hidden=${String(previousHidden)}`,
                        afterSummary: `hidden=${String(args.hidden)}`,
                        snapshot: {
                            action: 'toggle_hide',
                            messageId: args.messageId,
                            previousHidden,
                            newHidden: args.hidden,
                        },
                        target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    messageId: args.messageId,
                    hidden: args.hidden,
                },
                { undoId },
            );
        },
    };

    const messageOverrideDisplayTool: AssistantToolDefinition<typeof MESSAGE_OVERRIDE_DISPLAY_SCHEMA> = {
        name: 'message_override_display',
        description:
            'Write a display-only message override to DATA_NAMESPACES.MESSAGE (does not alter LLM context). Captures pre-write UndoRecord.',
        parameters: MESSAGE_OVERRIDE_DISPLAY_SCHEMA,
        tier: 'adjust',
        readOnly: false,
        async preview(args, ctx) {
            const target: MessageTarget = {
                messageId: args.target.messageId,
                swipeId: args.target.swipeId ?? 0,
            };
            const prev = ctx.store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, {
                target,
                includeStaged: false,
            });
            const beforeText = prev?.content ?? '';
            return {
                title: `Override display of message #${target.messageId}#${target.swipeId}`,
                summary: `Set display-only override on #${target.messageId}#${target.swipeId}.`,
                targetLabel: `Chat: #${target.messageId}#${target.swipeId}`,
                beforeText,
                afterText: args.content,
                rawContent: args.content,
                diffLines: computeDiffLines(beforeText, args.content),
            };
        },
        async execute(args, ctx) {
            throwIfAssistantAborted(ctx.signal);
            const target: MessageTarget = {
                messageId: args.target.messageId,
                swipeId: args.target.swipeId ?? 0,
            };
            const prev = ctx.store.get(DATA_NAMESPACES.MESSAGE, MESSAGE_OVERRIDE_KEY, {
                target,
                includeStaged: false,
            });

            ctx.store.set(
                DATA_NAMESPACES.MESSAGE,
                MESSAGE_OVERRIDE_KEY,
                'assistant:message_override_display',
                args.content,
                { target, staged: false },
            );
            await ctx.bridge.refreshMessageView(target);

            const undoId =
                ctx.captureUndo === false
                    ? undefined
                    : ctx.undoStore.push({
                        sessionId: ctx.sessionId,
                        toolCallId: ctx.toolCallId,
                        toolName: 'message_override_display',
                        kind: 'chat_message',
                        label: `Override display #${target.messageId}#${target.swipeId}`,
                        scope: `display:${target.messageId}#${target.swipeId}`,
                        beforeSummary: prev ? truncateSummary(prev.content) : '(no display override)',
                        afterSummary: truncateSummary(args.content),
                        snapshot: {
                            action: 'override_display',
                            target,
                            hadPreviousOverride: Boolean(prev),
                            previousOverrideContent: prev?.content ?? null,
                            previousOverrideSource: prev?.source ?? null,
                        },
                        target,
                    }).id;

            return finalizeMutationToolResult(
                {
                    target,
                    content: args.content,
                },
                { undoId },
            );
        },
    };

    return [
        patchVariablesTool,
        writeFileTool,
        appendFileTool,
        editFileTool,
        chatCreateMessageTool,
        chatEditMessageTool,
        chatDeleteMessageTool,
        chatToggleHideMessageTool,
        messageOverrideDisplayTool,
    ];
}
