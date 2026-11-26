import { z } from 'zod';
import type { HostBridge, ToolMessageApi } from '@/core/bridge';
import type { ChatDataStore } from '@/core/store';
import type { MediaAttachment, MessageTarget } from '@/core/types';
import { OUTPUT_FILE_PATH, type VirtualFileSystem } from '@/core/vfs';
import type { ToolDefinition } from './registry';
import { createAbortError, isAbortError, throwIfAborted } from './script-sandbox';

function assertValidMessageTarget(target: MessageTarget | undefined): MessageTarget {
    if (
        !target
        || !Number.isInteger(target.messageId)
        || target.messageId < 0
        || !Number.isInteger(target.swipeId)
        || target.swipeId < 0
    ) {
        throw new Error(
            `Invalid message target coordinates: ${JSON.stringify(target)}. Expected non-negative integer { messageId, swipeId }.`,
        );
    }
    return { messageId: target.messageId, swipeId: target.swipeId };
}

export interface ChatMessageViewAdapterOptions {
    staged?: boolean;
    vfs?: VirtualFileSystem;
    emitRenderEvent?: boolean;
}

/**
 * `ToolMessageApi` adapter strictly bound to a frozen `MessageTarget` and `AbortSignal`.
 * Reads and writes `/output.md` (real host `chat[messageId]` / `swipes[swipeId]` via VFS
 * or `HostBridge.readChatMessage`/`writeChatMessage`) and triggers native render events.
 */
export class ChatMessageViewAdapter implements ToolMessageApi {
    private readonly target: MessageTarget;
    private readonly staged: boolean;
    private readonly vfs?: VirtualFileSystem;
    private readonly emitRenderEvent?: boolean;

    constructor(
        private readonly bridge: HostBridge,
        _store: ChatDataStore,
        target: MessageTarget,
        private readonly signal: AbortSignal,
        options: ChatMessageViewAdapterOptions = {},
    ) {
        this.target = { messageId: target.messageId, swipeId: target.swipeId };
        this.staged = options.staged === true;
        this.vfs = options.vfs;
        this.emitRenderEvent = options.emitRenderEvent;
    }

    async appendView(text: string): Promise<void> {
        throwIfAborted(this.signal);
        const boundTarget = assertValidMessageTarget(this.target);

        const baseText = this.vfs
            ? await this.vfs.readFile(OUTPUT_FILE_PATH, {
                target: boundTarget,
                staged: this.staged,
            })
            : (this.bridge.readChatMessage(boundTarget) ?? '');

        const nextText = !baseText
            ? text
            : baseText.endsWith('\n') || text.startsWith('\n')
                ? `${baseText}${text}`
                : `${baseText}\n${text}`;

        throwIfAborted(this.signal);
        if (this.vfs) {
            await this.vfs.writeFile(OUTPUT_FILE_PATH, nextText, {
                target: boundTarget,
                staged: this.staged,
                source: 'append_reply_view',
                ...(this.emitRenderEvent !== undefined
                    ? { emitRenderEvent: this.emitRenderEvent }
                    : {}),
            });
        } else {
            await this.bridge.writeChatMessage(boundTarget, nextText, {
                emitEvent: false,
                emitRenderEvent: this.emitRenderEvent !== false,
            });
        }

        throwIfAborted(this.signal);
    }

    async replaceView(text: string): Promise<void> {
        throwIfAborted(this.signal);
        const boundTarget = assertValidMessageTarget(this.target);

        if (this.vfs) {
            await this.vfs.writeFile(OUTPUT_FILE_PATH, text, {
                target: boundTarget,
                staged: this.staged,
                source: 'replace_reply_view',
                ...(this.emitRenderEvent !== undefined
                    ? { emitRenderEvent: this.emitRenderEvent }
                    : {}),
            });
        } else {
            await this.bridge.writeChatMessage(boundTarget, text, {
                emitEvent: false,
                emitRenderEvent: this.emitRenderEvent !== false,
            });
        }

        throwIfAborted(this.signal);
    }

    async attachMedia(media: MediaAttachment): Promise<void> {
        throwIfAborted(this.signal);
        const boundTarget = assertValidMessageTarget(this.target);
        await this.bridge.attachMediaToMessage({ ...boundTarget }, { ...media });
        throwIfAborted(this.signal);
    }
}

const APPEND_REPLY_VIEW_SCHEMA = z.object({
    text: z
        .string()
        .min(1)
        .describe('Markdown, text, or HTML block to append to the rendered UI view of the anchored reply (does not mutate underlying LLM conversation history).'),
});

const REPLACE_REPLY_VIEW_SCHEMA = z.object({
    text: z
        .string()
        .describe('Full replacement display view text for the anchored reply (stored as a reversible ChatDataStore "message" override).'),
});

const ATTACH_MEDIA_SCHEMA = z.object({
    type: z
        .enum(['image', 'audio', 'video', 'file'])
        .describe('Media attachment type.'),
    url: z
        .string()
        .min(1)
        .describe('URL or data URI of the generated or external media resource.'),
    mimeType: z
        .string()
        .optional()
        .describe('Optional MIME type (e.g. "image/png", "audio/mpeg").'),
    name: z
        .string()
        .optional()
        .describe('Optional display filename.'),
    caption: z
        .string()
        .optional()
        .describe('Optional caption shown alongside the attached media.'),
    inline: z
        .boolean()
        .optional()
        .describe('Whether to display inline inside the message block.'),
});

/** Create built-in `append_reply_view`, `replace_reply_view`, and `attach_media` tools. */
export function createMessageTools(): ToolDefinition[] {
    const appendReplyViewTool: ToolDefinition<typeof APPEND_REPLY_VIEW_SCHEMA> = {
        name: 'append_reply_view',
        description:
            'Append content (e.g. status panel or post-reply card) to the anchored message display override in ChatDataStore without mutating raw chat history or breaking KV cache.',
        parameters: APPEND_REPLY_VIEW_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const target = assertValidMessageTarget(ctx.target);
                await ctx.message.appendView(args.text);
                return JSON.stringify({
                    ok: true,
                    action: 'append_reply_view',
                    target,
                    appendedChars: args.text.length,
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ ok: false, error: message });
            }
        },
    };

    const replaceReplyViewTool: ToolDefinition<typeof REPLACE_REPLY_VIEW_SCHEMA> = {
        name: 'replace_reply_view',
        description:
            'Replace the rendered UI display view of the anchored message via ChatDataStore "message" override without mutating underlying LLM history.',
        parameters: REPLACE_REPLY_VIEW_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const target = assertValidMessageTarget(ctx.target);
                await ctx.message.replaceView(args.text);
                return JSON.stringify({
                    ok: true,
                    action: 'replace_reply_view',
                    target,
                    chars: args.text.length,
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ ok: false, error: message });
            }
        },
    };

    const attachMediaTool: ToolDefinition<typeof ATTACH_MEDIA_SCHEMA> = {
        name: 'attach_media',
        description:
            'Attach an image, audio, video, or file asset strictly to the anchored message target (messageId, swipeId).',
        parameters: ATTACH_MEDIA_SCHEMA,
        source: 'builtin',
        async execute(args, ctx) {
            throwIfAborted(ctx.signal);
            try {
                const target = assertValidMessageTarget(ctx.target);
                const media: MediaAttachment = {
                    type: args.type,
                    url: args.url,
                    ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
                    ...(args.name !== undefined ? { name: args.name } : {}),
                    ...(args.caption !== undefined ? { caption: args.caption } : {}),
                    ...(args.inline !== undefined ? { inline: args.inline } : {}),
                };
                await ctx.message.attachMedia(media);
                return JSON.stringify({
                    ok: true,
                    action: 'attach_media',
                    target,
                    media,
                });
            } catch (error) {
                if (isAbortError(error) || ctx.signal.aborted) {
                    throw error instanceof Error && isAbortError(error) ? error : createAbortError();
                }
                const message = error instanceof Error ? error.message : String(error);
                return JSON.stringify({ ok: false, error: message });
            }
        },
    };

    return [appendReplyViewTool, replaceReplyViewTool, attachMediaTool];
}
