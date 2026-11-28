import {
    activateSendButtons,
    chat,
    deactivateSendButtons,
    hideSwipeButtons,
    setExternalAbortController,
    showSwipeButtons,
} from '@st/script.js';
import { eventSource, event_types } from '@st/scripts/events.js';
import { selected_group } from '@st/scripts/group-chats.js';

import {
    type GenerationAction,
    type PipelineOrchestrator,
    type ResumeTurnInput,
    type RunTurnResult,
    TurnInterruptedError,
} from '@/core/triggers';
import type { MessageTarget, Settings, ToolStepLog } from '@/core/types';
import type { AppStore } from '@/ui/store';

import type { STHostBridge } from './st-bridge';
import { StreamRenderer, type StreamRendererDependencies } from './stream-renderer';

const TAKEOVER_ACTIONS = new Set<GenerationAction>([
    'normal',
    'regenerate',
    'swipe',
    'continue',
]);

const EMPTY_SEND_TRIGGER_TTL_MS = 3000;

export type STGenerateInterceptor = (
    chatArg: unknown[],
    contextSize: number,
    abort: (quiet?: boolean) => void,
    type?: string,
) => void | Promise<void>;

export interface ResumeTakeoverOptions {
    rollbackLastToolRound?: boolean;
}

export interface AgenticInterceptorOptions {
    bridge: STHostBridge;
    orchestrator: PipelineOrchestrator;
    getSettings: () => Settings | undefined;
    getAppStore?: () => AppStore | undefined;
    registerGlobal?: boolean;
}

export interface AgenticInterceptorHandle {
    interceptor: STGenerateInterceptor;
    isTakeoverActive(): boolean;
    abortActiveTakeover(reason?: string): boolean;
    resumeTakeoverTurn(target: MessageTarget, options?: ResumeTakeoverOptions): Promise<void>;
    retryTakeoverTurn(target: MessageTarget): Promise<void>;
    dispose(): void;
}

interface ActiveTakeoverSession {
    controller: AbortController;
    renderer?: StreamRenderer;
    releaseGuard: () => void;
}

function normalizeTakeoverAction(rawType?: string): GenerationAction | null {
    const normalized = (rawType ?? '').trim().toLowerCase();
    if (!normalized) {
        return 'normal';
    }
    if (TAKEOVER_ACTIONS.has(normalized as GenerationAction)) {
        return normalized as GenerationAction;
    }
    return null;
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
    if (signal.aborted) {
        return true;
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
        return true;
    }
    return error instanceof Error && error.name === 'AbortError';
}

function resolveCacheHitRate(usage?: {
    inputTokens: number;
    cachedTokens: number;
    cacheHitRate?: number;
}): number | undefined {
    if (!usage) {
        return undefined;
    }
    if (typeof usage.cacheHitRate === 'number' && Number.isFinite(usage.cacheHitRate)) {
        return usage.cacheHitRate;
    }
    if (usage.inputTokens > 0) {
        return usage.cachedTokens / usage.inputTokens;
    }
    return undefined;
}

function readSendTextareaValue(): string {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
        return '';
    }
    const textarea = document.querySelector('#send_textarea') as { value?: unknown } | null;
    return typeof textarea?.value === 'string' ? textarea.value : '';
}

function eventTargetMatchesId(target: EventTarget | null, id: string): boolean {
    if (!target || typeof target !== 'object') {
        return false;
    }
    const candidate = target as {
        id?: unknown;
        closest?: (selector: string) => unknown;
    };
    if (candidate.id === id) {
        return true;
    }
    if (typeof candidate.closest === 'function') {
        return Boolean(candidate.closest(`#${id}`));
    }
    return false;
}

function isLastChatMessageAssistant(): boolean {
    if (!Array.isArray(chat) || chat.length === 0) {
        return false;
    }
    const last = chat[chat.length - 1] as { is_user?: unknown; is_system?: unknown } | undefined;
    return Boolean(last && !last.is_user && !last.is_system);
}

function resolveTurnUserInput(
    action: GenerationAction,
    messageId: number,
    fallbackUserName: string,
): { userInput: string | undefined; userName: string } {
    if (action === 'continue' || !Array.isArray(chat) || chat.length === 0) {
        return { userInput: undefined, userName: fallbackUserName };
    }
    const startIdx = Math.min(chat.length - 1, messageId - 1);
    for (let i = startIdx; i >= 0; i -= 1) {
        const candidate = chat[i] as
            | { is_user?: unknown; is_system?: unknown; mes?: unknown; name?: unknown }
            | undefined;
        if (!candidate || candidate.is_system) {
            continue;
        }
        if (candidate.is_user && typeof candidate.mes === 'string') {
            return {
                userInput: candidate.mes,
                userName: typeof candidate.name === 'string' ? candidate.name : fallbackUserName,
            };
        }
        return { userInput: undefined, userName: fallbackUserName };
    }
    return { userInput: undefined, userName: fallbackUserName };
}

function isTargetBindableOrRecreateable(target: MessageTarget): boolean {
    if (
        !Array.isArray(chat)
        || !Number.isInteger(target.messageId)
        || target.messageId < 0
        || target.messageId > chat.length
        || !Number.isInteger(target.swipeId)
        || target.swipeId < 0
    ) {
        return false;
    }
    if (target.messageId < chat.length && !chat[target.messageId]) {
        return false;
    }
    return true;
}

function createGenerationUiGuard(): () => void {
    if (typeof document === 'undefined' || !document.body) {
        return () => {};
    }

    let active = true;
    // Scoped CSS on body[data-agentic-takeover="true"] prevents 0ms button flicker while ST unwinds unblockGeneration().
    document.body.dataset.agenticTakeover = 'true';
    document.body.dataset.generating = 'true';

    return () => {
        if (!active) {
            return;
        }
        active = false;
        delete document.body.dataset.agenticTakeover;
    };
}

/**
 * Create and register `globalThis.Agentic_interceptor` alongside the `GENERATION_STOPPED` (`#mes_stop`)
 * handler for `takeover` single-chat generation.
 */
export function createAgenticInterceptor(
    options: AgenticInterceptorOptions,
): AgenticInterceptorHandle {
    const { bridge, orchestrator, getSettings, getAppStore, registerGlobal = true } = options;

    let activeSession: ActiveTakeoverSession | null = null;
    let pendingEmptySendTrigger = false;
    let emptySendTriggerTimer: ReturnType<typeof setTimeout> | null = null;

    const clearEmptySendTrigger = (): void => {
        pendingEmptySendTrigger = false;
        if (emptySendTriggerTimer !== null) {
            clearTimeout(emptySendTriggerTimer);
            emptySendTriggerTimer = null;
        }
    };

    const markEmptySendTrigger = (): void => {
        clearEmptySendTrigger();
        pendingEmptySendTrigger = true;
        emptySendTriggerTimer = setTimeout(() => {
            pendingEmptySendTrigger = false;
            emptySendTriggerTimer = null;
        }, EMPTY_SEND_TRIGGER_TTL_MS);
        (emptySendTriggerTimer as { unref?: () => void }).unref?.();
    };

    const consumeEmptySendTrigger = (): boolean => {
        const triggered = pendingEmptySendTrigger;
        clearEmptySendTrigger();
        return triggered;
    };

    const onDocumentPointerOrClickCapture = (event: Event): void => {
        const target = event.target;
        if (
            eventTargetMatchesId(target, 'option_continue')
            || eventTargetMatchesId(target, 'mes_continue')
        ) {
            clearEmptySendTrigger();
            return;
        }
        if (eventTargetMatchesId(target, 'send_but')) {
            if (readSendTextareaValue().trim().length === 0) {
                markEmptySendTrigger();
            } else {
                clearEmptySendTrigger();
            }
        }
    };

    const onDocumentKeyDownCapture = (event: Event): void => {
        const keyEvent = event as KeyboardEvent;
        if (
            !eventTargetMatchesId(event.target, 'send_textarea')
            || keyEvent.key !== 'Enter'
            || keyEvent.shiftKey
            || keyEvent.altKey
            || keyEvent.isComposing
        ) {
            return;
        }
        const targetVal = (event.target as { value?: unknown } | null)?.value;
        const currentText = typeof targetVal === 'string' ? targetVal : readSendTextareaValue();
        if (currentText.trim().length === 0) {
            markEmptySendTrigger();
        } else {
            clearEmptySendTrigger();
        }
    };

    const hasDocumentEventListeners =
        typeof document !== 'undefined' && typeof document.addEventListener === 'function';
    if (hasDocumentEventListeners) {
        document.addEventListener('pointerdown', onDocumentPointerOrClickCapture, true);
        document.addEventListener('click', onDocumentPointerOrClickCapture, true);
        document.addEventListener('keydown', onDocumentKeyDownCapture, true);
    }

    const abortActiveTakeover = (reason = 'Generation stopped'): boolean => {
        if (!activeSession) {
            return false;
        }
        if (!activeSession.controller.signal.aborted) {
            activeSession.controller.abort(reason);
        }
        return true;
    };

    const onGenerationStopped = () => {
        abortActiveTakeover('Stopped by user');
    };

    if (event_types.GENERATION_STOPPED) {
        eventSource.on(event_types.GENERATION_STOPPED, onGenerationStopped);
    }

    const createRendererDeps = (): StreamRendererDependencies => ({
        getSettings,
        getStore: () => orchestrator.store,
        getAppStore,
        substituteMacros: (text, overrides) => bridge.substituteMacros(text, overrides),
        identity: bridge.getActiveIdentity(),
    });

    const finalizeTurnSession = async (
        activeRenderer: StreamRenderer,
        result: RunTurnResult,
    ): Promise<void> => {
        const backgroundHandles = result.afterTurnTasks ?? [];
        await activeRenderer.finalize({
            finalText: result.content,
            reasoningText: result.reasoningContent,
            hasBackgroundTasks: backgroundHandles.length > 0,
            stepCount: result.mainRun.rounds,
            cacheHitRate: resolveCacheHitRate(result.mainRun.usage),
        });

        if (backgroundHandles.length > 0) {
            let remaining = backgroundHandles.length;
            for (const handle of backgroundHandles) {
                void handle.promise.finally(() => {
                    remaining = Math.max(0, remaining - 1);
                    activeRenderer.updateBackgroundStatus(remaining);
                });
            }
        }
    };

    const handleTurnSessionError = async (
        error: unknown,
        controller: AbortController,
        renderer: StreamRenderer | undefined,
        failurePrefix: string,
    ): Promise<void> => {
        if (error instanceof TurnInterruptedError) {
            if (renderer) {
                await renderer.markInterrupted({
                    reason: error.reason,
                    errorMessage: error.causeError,
                    currentOutput: error.salvagedOutput,
                    stepCount: error.trace.toolSteps.length,
                    cacheHitRate: resolveCacheHitRate(error.trace.usage),
                    onResume: () => resumeTakeoverTurn(renderer.target),
                });
            }
            if (error.reason === 'error') {
                const detail = error.causeError ?? error.message;
                getAppStore?.()?.pushToast(
                    `生成因错误中断（已保存断点，可点击恢复）：${detail}`,
                    'warning',
                );
            }
            return;
        }

        if (renderer) {
            orchestrator.store.rollbackStagedData(renderer.target);
        }
        if (isAbortError(error, controller.signal)) {
            await renderer?.abort({ wasUserStop: true, reason: 'Stopped by user' });
        } else {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[ST-Agentic] ${failurePrefix}:`, error);
            getAppStore?.()?.pushToast(`${failurePrefix}: ${message}`, 'error');
            await renderer?.abort({ errorMessage: message });
        }
    };

    const releaseSession = (session: ActiveTakeoverSession): void => {
        session.releaseGuard();
        if (activeSession === session) {
            activeSession = null;
        }
        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(undefined);
        }
        if (typeof activateSendButtons === 'function') {
            activateSendButtons();
        }
        if (typeof showSwipeButtons === 'function') {
            showSwipeButtons();
        }
    };

    const resumeTakeoverTurn = async (
        target: MessageTarget,
        resumeOptions?: ResumeTakeoverOptions,
    ): Promise<void> => {
        if (activeSession) {
            getAppStore?.()?.pushToast('当前已有生成任务正在运行，请等待或停止后再恢复。', 'warning');
            return;
        }
        if (!isTargetBindableOrRecreateable(target)) {
            getAppStore?.()?.pushToast('无法恢复：目标消息不存在。', 'error');
            return;
        }

        const controller = new AbortController();
        const releaseGuard = createGenerationUiGuard();
        const session: ActiveTakeoverSession = {
            controller,
            releaseGuard,
        };
        activeSession = session;

        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(controller);
        }

        let renderer: StreamRenderer | undefined;

        try {
            if (typeof deactivateSendButtons === 'function') {
                deactivateSendButtons();
            }
            if (typeof hideSwipeButtons === 'function') {
                hideSwipeButtons();
            }

            const activeRenderer = StreamRenderer.bindExisting(target, createRendererDeps());
            renderer = activeRenderer;
            session.renderer = activeRenderer;

            if (controller.signal.aborted) {
                await activeRenderer.abort({ wasUserStop: true, reason: 'Stopped before resume' });
                return;
            }

            activeRenderer.setRetrievingStatus('Resuming turn');
            getAppStore?.()?.setActiveTarget(target);

            const resumeInput: ResumeTurnInput & ResumeTakeoverOptions = {
                target,
                signal: controller.signal,
                stream: true,
                onTextDelta: (delta) => activeRenderer.appendTextDelta(delta),
                onOutputPreview: (preview) => activeRenderer.setOutputPreview(preview),
                onReasoningDelta: (delta) => activeRenderer.appendReasoningDelta(delta),
                onToolStart: (step: ToolStepLog) => activeRenderer.onToolStart(step.toolName),
                onToolComplete: (step: ToolStepLog) => activeRenderer.onToolComplete(step.toolName),
                ...(resumeOptions?.rollbackLastToolRound !== undefined
                    ? { rollbackLastToolRound: resumeOptions.rollbackLastToolRound }
                    : {}),
            };
            const result = await orchestrator.resumeTurn(resumeInput);

            if (controller.signal.aborted) {
                orchestrator.store.rollbackStagedData(target);
                await activeRenderer.abort({
                    wasUserStop: true,
                    reason: 'Generation stopped',
                });
                return;
            }

            await finalizeTurnSession(activeRenderer, result);
        } catch (error) {
            await handleTurnSessionError(
                error,
                controller,
                renderer,
                'Takeover resume failed',
            );
        } finally {
            releaseSession(session);
        }
    };

    const retryTakeoverTurn = async (target: MessageTarget): Promise<void> => {
        if (activeSession) {
            getAppStore?.()?.pushToast('当前已有生成任务正在运行，请等待或停止后再重试。', 'warning');
            return;
        }
        if (!isTargetBindableOrRecreateable(target)) {
            getAppStore?.()?.pushToast('无法重试：目标消息不存在。', 'error');
            return;
        }

        const controller = new AbortController();
        const releaseGuard = createGenerationUiGuard();
        const session: ActiveTakeoverSession = {
            controller,
            releaseGuard,
        };
        activeSession = session;

        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(controller);
        }

        let renderer: StreamRenderer | undefined;

        try {
            if (typeof deactivateSendButtons === 'function') {
                deactivateSendButtons();
            }
            if (typeof hideSwipeButtons === 'function') {
                hideSwipeButtons();
            }

            const floorWasPopped = target.messageId === chat.length;
            const existingMsg = !floorWasPopped
                ? (chat[target.messageId] as Record<string, unknown> | undefined)
                : undefined;
            const existingSwipesLen = Array.isArray(existingMsg?.swipes)
                ? existingMsg.swipes.length
                : 1;
            const runAction: GenerationAction = floorWasPopped
                ? 'normal'
                : target.swipeId > 0
                    || existingSwipesLen > 1
                    || target.messageId < chat.length - 1
                  ? 'swipe'
                  : 'regenerate';
            const rendererAction: GenerationAction = floorWasPopped ? 'normal' : 'regenerate';

            // Clear any stale staged writes and interrupted checkpoint for both popped and in-place retries.
            orchestrator.store.rollbackStagedData(target);
            orchestrator.trajectoryStore?.clearInterruptedCheckpoint?.(target);

            const rendererDeps = createRendererDeps();
            const activeRenderer = StreamRenderer.bindExisting(target, rendererDeps, {
                action: rendererAction,
                resetContent: !floorWasPopped,
            });
            renderer = activeRenderer;
            session.renderer = activeRenderer;

            if (controller.signal.aborted) {
                await activeRenderer.abort({ wasUserStop: true, reason: 'Stopped before retry' });
                return;
            }

            activeRenderer.setRetrievingStatus('Retrying turn');
            getAppStore?.()?.setActiveTarget(activeRenderer.target);

            const { userInput, userName } = resolveTurnUserInput(
                runAction,
                activeRenderer.target.messageId,
                rendererDeps.identity.userName,
            );

            const result = await orchestrator.runTurn({
                action: runAction,
                target: activeRenderer.target,
                userInput,
                userName,
                turnNumber: activeRenderer.target.messageId + 1,
                signal: controller.signal,
                stream: true,
                onTextDelta: (delta) => activeRenderer.appendTextDelta(delta),
                onOutputPreview: (preview) => activeRenderer.setOutputPreview(preview),
                onReasoningDelta: (delta) => activeRenderer.appendReasoningDelta(delta),
                onToolStart: (step: ToolStepLog) => activeRenderer.onToolStart(step.toolName),
                onToolComplete: (step: ToolStepLog) => activeRenderer.onToolComplete(step.toolName),
            });

            if (controller.signal.aborted) {
                orchestrator.store.rollbackStagedData(activeRenderer.target);
                await activeRenderer.abort({
                    wasUserStop: true,
                    reason: 'Generation stopped',
                });
                return;
            }

            await finalizeTurnSession(activeRenderer, result);
        } catch (error) {
            await handleTurnSessionError(
                error,
                controller,
                renderer,
                'Takeover retry failed',
            );
        } finally {
            releaseSession(session);
        }
    };

    const executeTakeoverTurn = async (
        action: GenerationAction,
        session: ActiveTakeoverSession,
    ): Promise<void> => {
        const { controller } = session;
        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(controller);
        }

        let renderer: StreamRenderer | undefined;

        try {
            if (typeof deactivateSendButtons === 'function') {
                deactivateSendButtons();
            }
            if (typeof hideSwipeButtons === 'function') {
                hideSwipeButtons();
            }

            const rendererDeps = createRendererDeps();
            const activeRenderer = StreamRenderer.beginPlaceholder(action, rendererDeps);
            renderer = activeRenderer;
            session.renderer = activeRenderer;

            if (controller.signal.aborted) {
                await activeRenderer.abort({ wasUserStop: true, reason: 'Stopped before start' });
                return;
            }

            activeRenderer.setRetrievingStatus('Preparing turn context');
            getAppStore?.()?.setActiveTarget(activeRenderer.target);

            const { userInput, userName } = resolveTurnUserInput(
                action,
                activeRenderer.target.messageId,
                rendererDeps.identity.userName,
            );

            const result = await orchestrator.runTurn({
                action,
                target: activeRenderer.target,
                previousSwipeId: activeRenderer.previousSwipeId,
                userInput,
                userName,
                existingContent: action === 'continue' ? activeRenderer.existingContent : undefined,
                turnNumber: activeRenderer.target.messageId + 1,
                signal: controller.signal,
                stream: true,
                onTextDelta: (delta) => activeRenderer.appendTextDelta(delta),
                onOutputPreview: (preview) => activeRenderer.setOutputPreview(preview),
                onReasoningDelta: (delta) => activeRenderer.appendReasoningDelta(delta),
                onToolStart: (step: ToolStepLog) => activeRenderer.onToolStart(step.toolName),
                onToolComplete: (step: ToolStepLog) => activeRenderer.onToolComplete(step.toolName),
            });

            if (controller.signal.aborted) {
                orchestrator.store.rollbackStagedData(activeRenderer.target);
                await activeRenderer.abort({
                    wasUserStop: true,
                    reason: 'Generation stopped',
                });
                return;
            }

            await finalizeTurnSession(activeRenderer, result);
        } catch (error) {
            await handleTurnSessionError(
                error,
                controller,
                renderer,
                'Takeover generation failed',
            );
        } finally {
            releaseSession(session);
        }
    };

    const interceptor: STGenerateInterceptor = async (
        _chatArg,
        _contextSize,
        abort,
        type,
    ) => {
        const settings = getSettings();
        if (!settings || settings.runMode !== 'takeover') {
            return;
        }
        if (selected_group) {
            return;
        }

        const rawAction = normalizeTakeoverAction(type);
        if (!rawAction) {
            return;
        }

        const triggeredByEmptySend = consumeEmptySendTrigger();
        // When ST's continue_on_send rewrites an empty send-button/Enter press on an assistant tail
        // into type='continue', normalize back to 'normal' so we allocate a new assistant floor
        // instead of overwriting the previous assistant floor in-place.
        const action: GenerationAction =
            rawAction === 'continue'
            && triggeredByEmptySend
            && isLastChatMessageAssistant()
            && readSendTextareaValue().trim().length === 0
                ? 'normal'
                : rawAction;

        if (activeSession) {
            abort(true);
            return;
        }

        const controller = new AbortController();
        const releaseGuard = createGenerationUiGuard();
        const session: ActiveTakeoverSession = {
            controller,
            releaseGuard,
        };
        activeSession = session;

        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(controller);
        }

        // Prevent native ST API execution while preserving native chat/DOM state.
        abort(true);

        // Await takeover turn inside the interceptor so ST's Generate() (and callers such as
        // swipe()'s endSwipe() and sendTextareaMessage()) stays pending until completion/abort.
        await executeTakeoverTurn(action, session);
    };

    if (registerGlobal) {
        (globalThis as Record<string, unknown>).Agentic_interceptor = interceptor;
    }

    return {
        interceptor,
        isTakeoverActive: () => activeSession !== null,
        abortActiveTakeover,
        resumeTakeoverTurn,
        retryTakeoverTurn,
        dispose() {
            clearEmptySendTrigger();
            if (
                hasDocumentEventListeners
                && typeof document !== 'undefined'
                && typeof document.removeEventListener === 'function'
            ) {
                document.removeEventListener('pointerdown', onDocumentPointerOrClickCapture, true);
                document.removeEventListener('click', onDocumentPointerOrClickCapture, true);
                document.removeEventListener('keydown', onDocumentKeyDownCapture, true);
            }
            abortActiveTakeover('Interceptor disposed');
            if (
                event_types.GENERATION_STOPPED &&
                typeof eventSource.removeListener === 'function'
            ) {
                eventSource.removeListener(event_types.GENERATION_STOPPED, onGenerationStopped);
            }
            if (registerGlobal) {
                const holder = globalThis as Record<string, unknown>;
                if (holder.Agentic_interceptor === interceptor) {
                    delete holder.Agentic_interceptor;
                }
            }
        },
    };
}
