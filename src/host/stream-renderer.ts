import {
    addCopyToCodeBlocks,
    addOneMessage,
    chat,
    ensureSwipes,
    getGeneratingApi,
    getGeneratingModel,
    messageFormatting,
    refreshSwipeButtons,
    saveChatConditional,
    saveChatDebounced,
    scrollChatToBottom,
    showSwipeButtons,
    syncMesToSwipe,
    syncSwipeToMes,
    updateMessageBlock,
    updateSwipeCounter,
} from '@st/script.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import { power_user } from '@st/scripts/power-user.js';
import { parseReasoningFromString, ReasoningType, updateReasoningUI } from '@st/scripts/reasoning.js';
import { getMessageTimeStamp } from '@st/scripts/RossAscends-mods.js';

import type { HostIdentity } from '@/core/bridge';
import { resolveActivePreset } from '@/core/config';
import { applyRegexRules } from '@/core/regex';
import type { ChatDataStore } from '@/core/store';
import type { GenerationAction } from '@/core/triggers';
import type {
    CapsulePosition,
    GenerationEventPayload,
    InterruptedReason,
    MessageTarget,
    RegexRule,
    Settings,
} from '@/core/types';
import {
    AgenticCapsuleElement,
    placeAgenticCapsule,
    registerAgenticCapsuleElement,
} from '@/ui/capsule';
import type { AppStore } from '@/ui/store';

import { emitMessageRenderedEvent } from './st-bridge';

export interface StreamRendererDependencies {
    getSettings: () => Settings | undefined;
    getStore: () => ChatDataStore | undefined;
    getAppStore?: () => AppStore | undefined;
    substituteMacros: (text: string, overrides?: Record<string, string>) => string;
    identity: HostIdentity;
}

export interface StreamSessionFinalizeOptions {
    finalText: string;
    reasoningText?: string;
    hasBackgroundTasks?: boolean;
    stepCount?: number;
    cacheHitRate?: number;
}

export interface StreamSessionAbortOptions {
    reason?: string;
    errorMessage?: string;
    wasUserStop?: boolean;
}

export interface StreamSessionInterruptedOptions {
    reason: InterruptedReason;
    errorMessage?: string;
    currentOutput: string;
    stepCount?: number;
    cacheHitRate?: number;
    onResume?: () => void | Promise<void>;
}

export interface StreamSessionRetryingOptions {
    attempt: number;
    maxAttempts?: number;
    delayMs?: number;
    reason?: string;
    rollbackPreviewText?: string;
}

interface ExtractedDisplayParts {
    visibleText: string;
    reasoningText: string;
}

function formatInterruptedSummary(reason: InterruptedReason): string {
    switch (reason) {
        case 'user_stop':
            return '已暂停 · 可恢复';
        case 'length':
            return '输出截断 · 可续写';
        case 'empty_output':
            return '未写入 /output.md · 可重试';
        case 'error':
            return '连接中断 · 可恢复';
    }
}

function getReasoningMarkers(): { prefix: string; suffix: string } {
    const reasoningCfg = (power_user?.reasoning ?? {}) as {
        prefix?: unknown;
        suffix?: unknown;
    };
    const prefix =
        typeof reasoningCfg.prefix === 'string' && reasoningCfg.prefix.length > 0
            ? reasoningCfg.prefix
            : '<think>';
    const suffix =
        typeof reasoningCfg.suffix === 'string' && reasoningCfg.suffix.length > 0
            ? reasoningCfg.suffix
            : '</think>';
    return { prefix, suffix };
}

function splitStreamingReasoning(rawText: string, explicitReasoning: string): ExtractedDisplayParts {
    const { prefix, suffix } = getReasoningMarkers();
    if (!rawText) {
        return { visibleText: '', reasoningText: explicitReasoning };
    }

    if (typeof parseReasoningFromString === 'function') {
        const parsed = parseReasoningFromString(rawText, { strict: false }) as
            | { reasoning?: string; content?: string }
            | null
            | undefined;
        if (parsed && typeof parsed.content === 'string') {
            let content = parsed.content;
            let reasoning = parsed.reasoning ?? '';

            // Handle in-progress unclosed thinking block while streaming.
            const openIdx = content.indexOf(prefix);
            if (openIdx !== -1 && content.indexOf(suffix, openIdx + prefix.length) === -1) {
                const pendingThought = content.slice(openIdx + prefix.length).trimStart();
                content = content.slice(0, openIdx).trimEnd();
                reasoning = reasoning ? `${reasoning}\n${pendingThought}` : pendingThought;
            }

            const combinedReasoning = [explicitReasoning, reasoning]
                .map((part) => part.trim())
                .filter(Boolean)
                .join('\n\n');
            return { visibleText: content, reasoningText: combinedReasoning };
        }
    }

    let visible = rawText;
    const blocks: string[] = [];
    let searchFrom = 0;
    while (searchFrom < visible.length) {
        const start = visible.indexOf(prefix, searchFrom);
        if (start === -1) {
            break;
        }
        const end = visible.indexOf(suffix, start + prefix.length);
        if (end === -1) {
            blocks.push(visible.slice(start + prefix.length).trim());
            visible = visible.slice(0, start);
            break;
        }
        blocks.push(visible.slice(start + prefix.length, end).trim());
        visible = visible.slice(0, start) + visible.slice(end + suffix.length);
        searchFrom = start;
    }

    const combinedReasoning = [explicitReasoning, ...blocks]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');

    return {
        visibleText: blocks.length > 0 ? visible.trimStart() : visible,
        reasoningText: combinedReasoning,
    };
}

function collectDisplayRules(settings?: Settings): RegexRule[] {
    if (!settings) {
        return [];
    }
    const preset = resolveActivePreset(settings);
    return Array.isArray(preset?.regexRules) ? preset.regexRules : [];
}

function resolveCapsulePosition(settings?: Settings): CapsulePosition {
    return settings?.capsulePosition ?? 'bottom';
}

function resolveModelLabel(settings?: Settings): string {
    const hostModel = typeof getGeneratingModel === 'function' ? getGeneratingModel() : '';
    if (hostModel) {
        return hostModel;
    }
    if (settings) {
        const preset = resolveActivePreset(settings);
        const connId = preset?.agents?.[preset.mainAgentId]?.connectionId ?? settings.currentConnectionId;
        const conn = settings.connections?.[connId];
        if (conn?.model) {
            return conn.model;
        }
    }
    return 'agentic';
}

function getMesElement(messageId: number): HTMLElement | null {
    if (typeof document === 'undefined') {
        return null;
    }
    return document.querySelector<HTMLElement>(`#chat .mes[mesid="${messageId}"]`);
}

function removeMesElement(messageId: number): void {
    const el = getMesElement(messageId);
    el?.remove();
}

/**
 * Manages 0ms native SillyTavern `.mes` placeholder creation, `requestAnimationFrame`-throttled
 * markdown & reasoning updates, final persistence, and `<agentic-capsule>` lifecycle during takeover turns.
 */
export class StreamRenderer {
    readonly target: MessageTarget;
    readonly action: GenerationAction;
    readonly previousSwipeId?: number;
    readonly existingContent: string;

    private readonly deps: StreamRendererDependencies;
    private readonly createdNewMessage: boolean;
    private readonly previousChatSwipeMes?: string;
    private readonly previousChatSwipeInfo?: Record<string, unknown>;
    private readonly startedAt = Date.now();

    private currentRoundText = '';
    private outputPreviewText = '';
    private hasOutputPreview = false;
    private explicitReasoningText = '';
    private pendingToolReset = false;
    private reasoningStartMs?: number;
    private reasoningEndMs?: number;
    private stepCount = 0;

    private rafHandle: number | null = null;
    private needsFlush = false;
    private finalized = false;

    private capsuleEl: AgenticCapsuleElement | null = null;
    private capsuleDisconnect?: () => void;
    private eventsUnsubscribe?: () => void;

    private constructor(
        deps: StreamRendererDependencies,
        target: MessageTarget,
        action: GenerationAction,
        createdNewMessage: boolean,
        existingContent: string,
        previousSwipeId?: number,
        previousChatSwipeMes?: string,
        previousChatSwipeInfo?: Record<string, unknown>,
    ) {
        this.deps = deps;
        this.target = target;
        this.action = action;
        this.createdNewMessage = createdNewMessage;
        this.existingContent = existingContent;
        this.previousSwipeId = previousSwipeId;
        this.previousChatSwipeMes = previousChatSwipeMes;
        this.previousChatSwipeInfo = previousChatSwipeInfo;

        this.mountCapsule();
        this.attachEventListener();
    }

    /**
     * Create or bind the native SillyTavern `.mes` block at 0ms before generation begins.
     */
    static beginPlaceholder(
        action: GenerationAction,
        deps: StreamRendererDependencies,
        explicitPreviousSwipeId?: number,
    ): StreamRenderer {
        const chatList = Array.isArray(chat) ? chat : [];
        const settings = deps.getSettings();
        const modelTag = resolveModelLabel(settings);
        const apiTag =
            (typeof getGeneratingApi === 'function' ? getGeneratingApi() : '') || 'agentic';

        if (action === 'continue' && chatList.length > 0) {
            const messageId = chatList.length - 1;
            const msg = chatList[messageId] as Record<string, unknown>;
            const swipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
            const swipes = Array.isArray(msg.swipes) ? (msg.swipes as unknown[]) : undefined;
            const swipeRaw =
                swipes && swipeId >= 0 && swipeId < swipes.length ? swipes[swipeId] : undefined;
            const existingContent =
                typeof swipeRaw === 'string'
                    ? swipeRaw
                    : typeof msg.mes === 'string'
                      ? msg.mes
                      : '';
            const renderer = new StreamRenderer(
                deps,
                { messageId, swipeId },
                action,
                false,
                existingContent,
            );
            if (!existingContent) {
                renderer.renderToDom(msg, '', '', false, false);
            }
            return renderer;
        }

        if (action === 'swipe' && chatList.length > 0) {
            const messageId = chatList.length - 1;
            const msg = chatList[messageId] as Record<string, unknown>;
            if (typeof ensureSwipes === 'function') {
                ensureSwipes(msg);
            }
            const swipes = Array.isArray(msg.swipes)
                ? (msg.swipes as string[])
                : ((msg.swipes = [String(msg.mes ?? '')]) as string[]);
            const swipeInfo = Array.isArray(msg.swipe_info)
                ? (msg.swipe_info as Array<Record<string, unknown>>)
                : ((msg.swipe_info = [{}]) as Array<Record<string, unknown>>);

            const targetSwipeId =
                typeof msg.swipe_id === 'number' && msg.swipe_id >= 0
                    ? msg.swipe_id
                    : swipes.length;
            const prevSwipeId =
                explicitPreviousSwipeId !== undefined
                    ? explicitPreviousSwipeId
                    : Math.max(0, targetSwipeId - 1);

            const prevMes =
                typeof swipes[prevSwipeId] === 'string'
                    ? swipes[prevSwipeId]
                    : typeof msg.mes === 'string'
                      ? msg.mes
                      : '';
            const prevInfo = swipeInfo[prevSwipeId]
                ? { ...swipeInfo[prevSwipeId] }
                : undefined;

            while (swipes.length <= targetSwipeId) {
                swipes.push('');
            }
            while (swipeInfo.length <= targetSwipeId) {
                swipeInfo.push({});
            }

            const msgExtra = ((msg.extra ??= {}) as Record<string, unknown>);
            delete msgExtra.display_text;
            delete msgExtra.reasoning;
            delete msgExtra.reasoning_type;
            delete msgExtra.reasoning_duration;
            msgExtra.api = apiTag;
            msgExtra.model = modelTag;

            swipes[targetSwipeId] = '';
            swipeInfo[targetSwipeId] = {
                send_date: typeof getMessageTimeStamp === 'function' ? getMessageTimeStamp() : Date.now(),
                gen_started: new Date().toISOString(),
                extra: {
                    api: apiTag,
                    model: modelTag,
                },
            };
            msg.mes = '';
            msg.swipe_id = targetSwipeId;

            if (typeof updateReasoningUI === 'function') {
                const mesEl = getMesElement(messageId);
                if (mesEl) {
                    (updateReasoningUI as (el: HTMLElement, opts?: { reset?: boolean }) => void)(
                        mesEl,
                        { reset: true },
                    );
                }
            }

            if (typeof updateMessageBlock === 'function') {
                const rawMes = msg.mes;
                updateMessageBlock(
                    messageId,
                    {
                        ...msg,
                        mes: '',
                        extra: {
                            ...((msg.extra as Record<string, unknown> | undefined) ?? {}),
                            display_text: '...',
                        },
                    },
                    { rerenderMessage: true },
                );
                if (msg.mes !== rawMes) {
                    msg.mes = rawMes;
                }
            }
            if (typeof updateSwipeCounter === 'function') {
                void updateSwipeCounter(messageId);
            }

            const renderer = new StreamRenderer(
                deps,
                { messageId, swipeId: targetSwipeId },
                action,
                false,
                '',
                prevSwipeId,
                prevMes,
                prevInfo,
            );
            if (typeof updateMessageBlock !== 'function') {
                renderer.renderToDom(msg, '', '', false, false);
            }
            return renderer;
        }

        // 'normal' or 'regenerate': append new native assistant message + placeholder DOM at 0ms.
        const messageId = chatList.length;
        const timestamp = typeof getMessageTimeStamp === 'function' ? getMessageTimeStamp() : Date.now();
        const extra = {
            api: apiTag,
            model: modelTag,
        };
        const placeholder: Record<string, unknown> = {
            name: deps.identity.charName || 'Assistant',
            is_user: false,
            is_system: false,
            send_date: timestamp,
            mes: '',
            swipes: [''],
            swipe_id: 0,
            swipe_info: [
                {
                    send_date: timestamp,
                    gen_started: new Date().toISOString(),
                    extra: { ...extra },
                },
            ],
            extra,
        };

        chatList.push(placeholder);
        if (typeof addOneMessage === 'function') {
            addOneMessage(placeholder, {
                type: 'normal',
                showSwipes: false,
                scroll: true,
            });
        }

        const renderer = new StreamRenderer(
            deps,
            { messageId, swipeId: 0 },
            action,
            true,
            '',
        );
        renderer.renderToDom(placeholder, '', '', false, false);
        return renderer;
    }

    /**
     * Bind to an existing SillyTavern message & swipe in-place (for interrupted checkpoint resume)
     * without pushing a new message or incrementing `swipe_id`.
     */
    static bindExisting(
        target: MessageTarget,
        deps: StreamRendererDependencies,
    ): StreamRenderer {
        const chatList = Array.isArray(chat) ? chat : [];
        const msg =
            target.messageId >= 0 && target.messageId < chatList.length
                ? (chatList[target.messageId] as Record<string, unknown> | undefined)
                : undefined;
        const swipes = msg && Array.isArray(msg.swipes) ? (msg.swipes as unknown[]) : undefined;
        const swipeRaw =
            swipes && target.swipeId >= 0 && target.swipeId < swipes.length
                ? swipes[target.swipeId]
                : undefined;
        const existingContent =
            typeof swipeRaw === 'string'
                ? swipeRaw
                : typeof msg?.mes === 'string'
                  ? msg.mes
                  : '';

        const renderer = new StreamRenderer(
            deps,
            { messageId: target.messageId, swipeId: target.swipeId },
            'continue',
            false,
            existingContent,
        );
        if (msg && !existingContent) {
            renderer.renderToDom(msg, '', '', false, false);
        }
        return renderer;
    }

    /** Update `<agentic-capsule>` state during `before_turn` retrieval. */
    setRetrievingStatus(stepLabel = 'Preparing context'): void {
        if (this.finalized) {
            return;
        }
        this.capsuleEl?.setState({
            status: 'retrieving',
            currentStep: stepLabel,
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
    }

    /**
     * Handle live `GenerationEventPayload` notifications (e.g. `turn_retrying`) bound to
     * this renderer's `(messageId, swipeId)` target.
     */
    handleGenerationEvent(event: GenerationEventPayload): void {
        if (this.finalized) {
            return;
        }
        if (
            event.target.messageId !== this.target.messageId
            || event.target.swipeId !== this.target.swipeId
        ) {
            return;
        }
        if (event.kind === 'turn_retrying') {
            this.onTurnRetrying({
                attempt: event.retryAttempt ?? 1,
                maxAttempts: event.retryMaxAttempts,
                delayMs: event.retryDelayMs,
                reason: event.retryReason,
            });
        }
    }

    /**
     * Surface transient single-round auto-retry status inside `<agentic-capsule>` and
     * roll back any dirty streaming preview until the next retry chunk arrives.
     */
    onTurnRetrying(options: StreamSessionRetryingOptions): void {
        if (this.finalized) {
            return;
        }
        const attempt = Math.max(1, Math.floor(options.attempt));
        const maxAttempts =
            typeof options.maxAttempts === 'number' && options.maxAttempts > 0
                ? Math.floor(options.maxAttempts)
                : undefined;
        const progress = maxAttempts !== undefined ? `(${attempt}/${maxAttempts})` : `(${attempt})`;

        this.currentRoundText = '';
        this.pendingToolReset = false;
        if (options.rollbackPreviewText !== undefined) {
            this.outputPreviewText = options.rollbackPreviewText;
            this.hasOutputPreview = true;
        }

        this.capsuleEl?.setState({
            status: 'retrying',
            currentStep: `自动重试 ${progress}...`,
            summary: '',
            stepCount: this.stepCount,
            retryAttempt: attempt,
            retryMaxAttempts: maxAttempts,
            retryReason: options.reason,
        });
        this.scheduleFlush();
    }

    /** Push an incremental full `/output.md` preview extracted from streaming tool arguments. */
    setOutputPreview(fullPreviewText: string): void {
        if (this.finalized) {
            return;
        }
        this.outputPreviewText = fullPreviewText;
        this.hasOutputPreview = true;
        this.capsuleEl?.setState({
            status: 'streaming',
            currentStep: 'Writing /output.md',
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
        this.scheduleFlush();
    }

    /** Push an incremental model text chunk and schedule a `requestAnimationFrame` DOM update. */
    appendTextDelta(delta: string): void {
        if (this.finalized || !delta) {
            return;
        }
        if (this.pendingToolReset) {
            this.currentRoundText = '';
            this.pendingToolReset = false;
        }
        this.currentRoundText += delta;
        this.capsuleEl?.setState({
            status: 'streaming',
            currentStep: 'Streaming response',
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
        this.scheduleFlush();
    }

    /** Push an incremental model reasoning chunk and update reasoning UI on next frame. */
    appendReasoningDelta(delta: string): void {
        if (this.finalized || !delta) {
            return;
        }
        if (this.reasoningStartMs === undefined) {
            this.reasoningStartMs = Date.now();
        }
        this.reasoningEndMs = Date.now();
        this.explicitReasoningText += delta;
        this.capsuleEl?.setState({
            status: 'streaming',
            currentStep: 'Reasoning',
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
        this.scheduleFlush();
    }

    /** Handle tool start mid-turn: mark round reset boundary and reflect active tool in capsule. */
    onToolStart(toolName: string): void {
        if (this.finalized) {
            return;
        }
        this.stepCount += 1;
        this.pendingToolReset = true;
        this.capsuleEl?.setState({
            status: 'retrieving',
            currentStep: `Tool: ${toolName}`,
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
    }

    /** Handle tool completion mid-turn. */
    onToolComplete(toolName: string): void {
        if (this.finalized) {
            return;
        }
        if (
            toolName === 'write_file'
            || toolName === 'append_file'
            || toolName === 'edit_file'
            || toolName === 'append_reply_view'
            || toolName === 'replace_reply_view'
        ) {
            const msg = this.getChatMessage();
            if (msg) {
                const swipes = Array.isArray(msg.swipes) ? (msg.swipes as unknown[]) : undefined;
                const latest =
                    swipes && this.target.swipeId >= 0 && this.target.swipeId < swipes.length
                        ? swipes[this.target.swipeId]
                        : msg.mes;
                if (typeof latest === 'string' && latest.length > 0) {
                    this.outputPreviewText = latest;
                    this.hasOutputPreview = true;
                }
            }
        }
        this.capsuleEl?.setState({
            status: 'retrieving',
            currentStep: `Finished: ${toolName}`,
            stepCount: this.stepCount,
            summary: '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
        });
    }

    /** Sync `<agentic-capsule>` background task indicator after `after_turn` is dispatched. */
    updateBackgroundStatus(activeCount: number): void {
        if (!this.capsuleEl) {
            return;
        }
        if (activeCount > 0) {
            this.capsuleEl.setState({
                status: 'background-running',
                currentStep: `${activeCount} background task${activeCount === 1 ? '' : 's'}`,
            });
        } else if (this.finalized) {
            this.capsuleEl.setState({
                status: 'done',
                currentStep: '',
            });
        }
    }

    /** Return streamed raw text captured so far (or full `/output.md` preview when active). */
    getAccumulatedText(): string {
        if (this.hasOutputPreview) {
            return this.outputPreviewText;
        }
        if (this.action === 'continue') {
            return `${this.existingContent}${this.currentRoundText}`;
        }
        return this.currentRoundText;
    }

    /**
     * Commit the final assistant text, persist chat & swipe state, render `display` regex/overrides,
     * and emit native SillyTavern events.
     */
    async finalize(options: StreamSessionFinalizeOptions): Promise<void> {
        if (this.finalized) {
            return;
        }
        this.finalized = true;
        this.cancelScheduledFlush();

        const msg = this.getChatMessage();
        if (msg) {
            const explicitTrimmed = this.explicitReasoningText.trim();
            const finalReasoningTrimmed = (options.reasoningText ?? '').trim();
            const mergedReasoning = !explicitTrimmed
                ? finalReasoningTrimmed
                : !finalReasoningTrimmed || explicitTrimmed.endsWith(finalReasoningTrimmed)
                  ? explicitTrimmed
                  : `${explicitTrimmed}\n\n${finalReasoningTrimmed}`;

            const { visibleText, reasoningText } = splitStreamingReasoning(
                options.finalText,
                mergedReasoning,
            );

            await this.persistCommittedOutput(msg, visibleText, reasoningText, {
                showSwipeFallback: true,
            });

            const eventName =
                this.action === 'continue'
                    ? event_types.MESSAGE_UPDATED
                    : event_types.MESSAGE_RECEIVED;
            if (eventName) {
                await eventSource.emit(eventName, this.target.messageId, this.action);
            }
            if (event_types.CHARACTER_MESSAGE_RENDERED) {
                await eventSource.emit(
                    event_types.CHARACTER_MESSAGE_RENDERED,
                    this.target.messageId,
                    this.action,
                );
            }
        }

        if (typeof scrollChatToBottom === 'function') {
            scrollChatToBottom();
        }

        this.ensureCapsuleMounted();
        this.capsuleEl?.setState({
            status: options.hasBackgroundTasks ? 'background-running' : 'done',
            currentStep: options.hasBackgroundTasks ? 'Background tasks running' : '',
            stepCount: options.stepCount ?? this.stepCount,
            ...(options.cacheHitRate !== undefined ? { cacheHitRate: options.cacheHitRate } : {}),
            canResume: false,
            interruptedReason: undefined,
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
            summary: '',
            errorMessage: '',
            onResume: undefined,
        });
        this.detachEventListener();
    }

    /**
     * Persist salvaged `/output.md` content, render final DOM state, and switch `<agentic-capsule>`
     * to `'interrupted'` with an interactive resume callback.
     */
    async markInterrupted(options: StreamSessionInterruptedOptions): Promise<void> {
        if (this.finalized) {
            return;
        }
        this.finalized = true;
        this.cancelScheduledFlush();

        const msg = this.getChatMessage();
        if (msg) {
            const { visibleText, reasoningText } = splitStreamingReasoning(
                options.currentOutput,
                this.explicitReasoningText,
            );
            await this.persistCommittedOutput(msg, visibleText, reasoningText, {
                showSwipeFallback: true,
            });
            if (visibleText.trim().length > 0) {
                await emitMessageRenderedEvent(this.target.messageId, msg);
            }
        }

        if (typeof scrollChatToBottom === 'function') {
            scrollChatToBottom();
        }

        this.ensureCapsuleMounted();
        this.capsuleEl?.setState({
            status: 'interrupted',
            canResume: true,
            interruptedReason: options.reason,
            summary: formatInterruptedSummary(options.reason),
            currentStep: '',
            errorMessage: options.errorMessage ?? '',
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
            stepCount: options.stepCount ?? this.stepCount,
            ...(options.cacheHitRate !== undefined ? { cacheHitRate: options.cacheHitRate } : {}),
            ...(options.onResume ? { onResume: options.onResume } : {}),
        });
        this.detachEventListener();
    }

    /**
     * Abort streaming gracefully: keep partial text if generated (or on `continue`),
     * otherwise cleanly revert the empty placeholder or failed swipe.
     */
    async abort(options: StreamSessionAbortOptions = {}): Promise<void> {
        if (this.finalized) {
            return;
        }
        this.finalized = true;
        this.cancelScheduledFlush();

        const partialRaw = this.hasOutputPreview ? this.outputPreviewText : this.currentRoundText;
        const hasPartialText = partialRaw.trim().length > 0;
        const msg = this.getChatMessage();

        if (this.action === 'continue') {
            if (msg) {
                const combined = this.hasOutputPreview
                    ? partialRaw
                    : hasPartialText
                      ? `${this.existingContent}${partialRaw}`
                      : this.existingContent;
                const { visibleText, reasoningText } = splitStreamingReasoning(
                    combined,
                    this.explicitReasoningText,
                );
                await this.persistCommittedOutput(msg, visibleText, reasoningText);
            }
        } else if (hasPartialText && msg) {
            const { visibleText, reasoningText } = splitStreamingReasoning(
                partialRaw,
                this.explicitReasoningText,
            );
            await this.persistCommittedOutput(msg, visibleText, reasoningText);
        } else if (this.createdNewMessage) {
            if (Array.isArray(chat) && this.target.messageId === chat.length - 1) {
                chat.pop();
            }
            removeMesElement(this.target.messageId);
            this.detachStoreListener();
            this.capsuleEl?.remove();
            this.capsuleEl = null;
            if (typeof showSwipeButtons === 'function') {
                showSwipeButtons();
            }
            return;
        } else if (this.action === 'swipe' && msg) {
            this.revertAbortedSwipe(msg);
            if (typeof updateSwipeCounter === 'function') {
                await updateSwipeCounter(this.target.messageId);
            }
            if (typeof refreshSwipeButtons === 'function') {
                refreshSwipeButtons(true);
            }
            if (typeof showSwipeButtons === 'function') {
                showSwipeButtons();
            }
            const prevSwipeId = this.previousSwipeId ?? 0;
            const revertedTarget: MessageTarget = {
                messageId: this.target.messageId,
                swipeId: prevSwipeId,
            };
            const appStore = this.deps.getAppStore?.();
            appStore?.setActiveTarget(revertedTarget);
            this.ensureCapsuleMounted();
            if (this.capsuleEl && appStore) {
                this.capsuleDisconnect?.();
                this.capsuleDisconnect = this.capsuleEl.connectStore(appStore, revertedTarget);
            }
            this.detachEventListener();
            return;
        }

        if (typeof showSwipeButtons === 'function') {
            showSwipeButtons();
        }

        this.ensureCapsuleMounted();
        if (this.capsuleEl) {
            if (options.errorMessage) {
                this.capsuleEl.setState({
                    status: 'error',
                    errorMessage: options.errorMessage,
                    currentStep: '',
                    summary: '',
                    retryAttempt: undefined,
                    retryMaxAttempts: undefined,
                    retryReason: undefined,
                    stepCount: this.stepCount,
                });
            } else {
                this.capsuleEl.setState({
                    status: 'done',
                    currentStep: options.wasUserStop ? 'Stopped' : '',
                    summary: '',
                    retryAttempt: undefined,
                    retryMaxAttempts: undefined,
                    retryReason: undefined,
                    stepCount: this.stepCount,
                });
            }
        }
        this.detachEventListener();
    }

    private getChatMessage(): Record<string, unknown> | undefined {
        if (!Array.isArray(chat)) {
            return undefined;
        }
        return chat[this.target.messageId] as Record<string, unknown> | undefined;
    }

    private mountCapsule(): void {
        if (typeof document === 'undefined') {
            return;
        }
        const mesElement = getMesElement(this.target.messageId);
        if (!mesElement) {
            return;
        }

        registerAgenticCapsuleElement();
        const existing = mesElement.querySelector<AgenticCapsuleElement>('agentic-capsule');
        const capsule =
            existing ?? (document.createElement('agentic-capsule') as AgenticCapsuleElement);
        placeAgenticCapsule(mesElement, capsule, resolveCapsulePosition(this.deps.getSettings()));

        const appStore = this.deps.getAppStore?.();
        if (appStore) {
            this.capsuleDisconnect?.();
            this.capsuleDisconnect = capsule.connectStore(appStore, this.target);
        }

        capsule.setState({
            status: 'retrieving',
            currentStep: 'Starting turn',
            stepCount: 0,
            canResume: false,
            interruptedReason: undefined,
            retryAttempt: undefined,
            retryMaxAttempts: undefined,
            retryReason: undefined,
            summary: '',
            errorMessage: '',
            onResume: undefined,
        });
        this.capsuleEl = capsule;
    }

    private attachEventListener(): void {
        this.eventsUnsubscribe?.();
        this.eventsUnsubscribe = undefined;
        const appStore = this.deps.getAppStore?.();
        if (appStore?.services?.subscribeEvents) {
            this.eventsUnsubscribe = appStore.services.subscribeEvents((event) => {
                this.handleGenerationEvent(event);
            });
        }
    }

    private async persistCommittedOutput(
        msg: Record<string, unknown>,
        visibleText: string,
        reasoningText: string,
        options?: { showSwipeFallback?: boolean },
    ): Promise<void> {
        if (this.action === 'swipe') {
            msg.swipe_id = this.target.swipeId;
        }
        this.commitSwipeAndMetadata(msg, visibleText, reasoningText);
        const activeSwipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (activeSwipeId === this.target.swipeId) {
            msg.mes = visibleText;
            this.renderToDom(msg, visibleText, reasoningText, true, true);
            if (typeof syncMesToSwipe === 'function') {
                syncMesToSwipe(this.target.messageId);
            }
        }

        if (typeof updateSwipeCounter === 'function') {
            await updateSwipeCounter(this.target.messageId);
        }
        if (typeof refreshSwipeButtons === 'function') {
            refreshSwipeButtons(true);
        } else if (options?.showSwipeFallback && typeof showSwipeButtons === 'function') {
            showSwipeButtons();
        }

        if (typeof saveChatConditional === 'function') {
            await saveChatConditional();
        } else {
            saveChatDebounced();
        }
    }

    private ensureCapsuleMounted(): void {
        if (!this.capsuleEl || this.capsuleEl.isConnected === false) {
            this.mountCapsule();
        }
    }

    private detachEventListener(): void {
        this.eventsUnsubscribe?.();
        this.eventsUnsubscribe = undefined;
    }

    private detachStoreListener(): void {
        this.capsuleDisconnect?.();
        this.capsuleDisconnect = undefined;
        this.detachEventListener();
    }

    private scheduleFlush(): void {
        this.needsFlush = true;
        if (this.rafHandle !== null) {
            return;
        }
        const schedule =
            typeof requestAnimationFrame === 'function'
                ? requestAnimationFrame
                : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;

        this.rafHandle = schedule(() => {
            this.rafHandle = null;
            if (!this.needsFlush || this.finalized) {
                return;
            }
            this.needsFlush = false;
            this.flushStreamingFrame();
        });
    }

    private cancelScheduledFlush(): void {
        if (this.rafHandle === null) {
            return;
        }
        if (typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this.rafHandle);
        } else {
            clearTimeout(this.rafHandle);
        }
        this.rafHandle = null;
        this.needsFlush = false;
    }

    private flushStreamingFrame(): void {
        const msg = this.getChatMessage();
        if (!msg) {
            return;
        }
        const activeSwipeId = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (activeSwipeId !== this.target.swipeId) {
            return;
        }
        const rawCombined = this.getAccumulatedText();
        const { visibleText, reasoningText } = splitStreamingReasoning(
            rawCombined,
            this.explicitReasoningText,
        );
        this.commitReasoningFields(msg, reasoningText);
        this.renderToDom(msg, visibleText, reasoningText, false, false);
    }

    private commitReasoningFields(msg: Record<string, unknown>, reasoningText: string): void {
        if (!reasoningText) {
            return;
        }
        const extra = ((msg.extra ??= {}) as Record<string, unknown>);
        extra.reasoning = reasoningText;
        extra.reasoning_type = this.explicitReasoningText.trim()
            ? (ReasoningType?.Model ?? 'model')
            : (ReasoningType?.Parsed ?? 'parsed');
        if (this.reasoningStartMs !== undefined) {
            extra.reasoning_duration = Math.max(
                0,
                (this.reasoningEndMs ?? Date.now()) - this.reasoningStartMs,
            );
        }
    }

    private commitSwipeAndMetadata(
        msg: Record<string, unknown>,
        visibleText: string,
        reasoningText: string,
    ): void {
        this.commitReasoningFields(msg, reasoningText);

        const swipes = Array.isArray(msg.swipes)
            ? (msg.swipes as string[])
            : ((msg.swipes = []) as string[]);
        while (swipes.length <= this.target.swipeId) {
            swipes.push('');
        }
        swipes[this.target.swipeId] = visibleText;

        const swipeInfo = Array.isArray(msg.swipe_info)
            ? (msg.swipe_info as Array<Record<string, unknown>>)
            : ((msg.swipe_info = []) as Array<Record<string, unknown>>);
        while (swipeInfo.length <= this.target.swipeId) {
            swipeInfo.push({});
        }

        const existingInfo = swipeInfo[this.target.swipeId] ?? {};
        swipeInfo[this.target.swipeId] = {
            ...existingInfo,
            send_date: existingInfo.send_date ?? msg.send_date ?? Date.now(),
            gen_started: existingInfo.gen_started ?? new Date(this.startedAt).toISOString(),
            gen_finished: new Date().toISOString(),
            extra: {
                ...((existingInfo.extra as Record<string, unknown> | undefined) ?? {}),
                ...((msg.extra as Record<string, unknown> | undefined) ?? {}),
            },
        };
    }

    private renderToDom(
        msg: Record<string, unknown>,
        visibleText: string,
        reasoningText: string,
        addCopyButtons: boolean,
        isFinal: boolean = true,
    ): void {
        const mesElement = getMesElement(this.target.messageId);
        if (!mesElement) {
            return;
        }

        const baseDisplayText =
            !isFinal && !visibleText && !reasoningText
                ? '...'
                : visibleText;

        const displayRules = collectDisplayRules(this.deps.getSettings());
        const formattedInput =
            displayRules.length > 0
                ? this.deps.substituteMacros(
                      applyRegexRules(baseDisplayText, displayRules, {
                          stage: 'display',
                          sender: 'assistant',
                      }),
                  )
                : baseDisplayText;

        const mesTextEl = mesElement.querySelector<HTMLElement>('.mes_text');
        if (mesTextEl && typeof messageFormatting === 'function') {
            const html = messageFormatting(
                formattedInput,
                typeof msg.name === 'string' ? msg.name : this.deps.identity.charName,
                Boolean(msg.is_system),
                Boolean(msg.is_user),
                this.target.messageId,
            );
            mesTextEl.innerHTML = html;
        } else if (typeof updateMessageBlock === 'function') {
            const rawSnapshot = msg.mes;
            updateMessageBlock(
                this.target.messageId,
                {
                    ...msg,
                    mes: formattedInput,
                    extra: {
                        ...((msg.extra as Record<string, unknown> | undefined) ?? {}),
                        display_text: formattedInput,
                    },
                },
                { rerenderMessage: true },
            );
            if (msg.mes !== rawSnapshot) {
                msg.mes = rawSnapshot;
            }
        }

        if (reasoningText && typeof updateReasoningUI === 'function') {
            updateReasoningUI(mesElement);
        }
        if (addCopyButtons && typeof addCopyToCodeBlocks === 'function') {
            addCopyToCodeBlocks(mesElement);
        }
    }

    private revertAbortedSwipe(msg: Record<string, unknown>): void {
        const prevSwipeId = this.previousSwipeId ?? 0;
        const swipes = Array.isArray(msg.swipes) ? (msg.swipes as string[]) : undefined;
        const swipeInfo = Array.isArray(msg.swipe_info)
            ? (msg.swipe_info as Array<Record<string, unknown>>)
            : undefined;

        if (swipes && this.target.swipeId === swipes.length - 1 && swipes.length > 1) {
            swipes.pop();
        }
        if (swipeInfo && this.target.swipeId === swipeInfo.length - 1 && swipeInfo.length > 1) {
            swipeInfo.pop();
        }

        msg.swipe_id = prevSwipeId;
        if (this.previousChatSwipeMes !== undefined) {
            msg.mes = this.previousChatSwipeMes;
            if (swipes && prevSwipeId < swipes.length) {
                swipes[prevSwipeId] = this.previousChatSwipeMes;
            }
        }
        if (this.previousChatSwipeInfo && swipeInfo && prevSwipeId < swipeInfo.length) {
            swipeInfo[prevSwipeId] = this.previousChatSwipeInfo;
        }

        if (typeof syncSwipeToMes === 'function') {
            syncSwipeToMes(this.target.messageId, prevSwipeId);
        }

        const mesElement = getMesElement(this.target.messageId);
        if (mesElement && typeof msg.mes === 'string') {
            this.renderToDom(
                msg,
                msg.mes,
                typeof (msg.extra as Record<string, unknown> | undefined)?.reasoning === 'string'
                    ? String((msg.extra as Record<string, unknown>).reasoning)
                    : '',
                true,
                true,
            );
        }
    }
}
