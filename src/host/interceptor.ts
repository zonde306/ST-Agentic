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

export type STGenerateInterceptor = (
    chatArg: unknown[],
    contextSize: number,
    abort: (quiet?: boolean) => void,
    type?: string,
) => void | Promise<void>;

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
    resumeTakeoverTurn(target: MessageTarget): Promise<void>;
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

    const resumeTakeoverTurn = async (target: MessageTarget): Promise<void> => {
        if (activeSession) {
            getAppStore?.()?.pushToast('当前已有生成任务正在运行，请等待或停止后再恢复。', 'warning');
            return;
        }
        if (
            !Array.isArray(chat)
            || !Number.isInteger(target.messageId)
            || target.messageId < 0
            || target.messageId >= chat.length
            || !chat[target.messageId]
        ) {
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

            const result = await orchestrator.resumeTurn({
                target,
                signal: controller.signal,
                stream: true,
                onOutputPreview: (preview) => activeRenderer.setOutputPreview(preview),
                onReasoningDelta: (delta) => activeRenderer.appendReasoningDelta(delta),
                onToolStart: (step: ToolStepLog) => activeRenderer.onToolStart(step.toolName),
                onToolComplete: (step: ToolStepLog) => activeRenderer.onToolComplete(step.toolName),
            });

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

            const prevMsg =
                Array.isArray(chat) && activeRenderer.target.messageId > 0
                    ? (chat[activeRenderer.target.messageId - 1] as
                          | { is_user?: unknown; mes?: unknown; name?: unknown }
                          | undefined)
                    : undefined;
            const userInput =
                action === 'normal' && prevMsg?.is_user && typeof prevMsg.mes === 'string'
                    ? prevMsg.mes
                    : undefined;
            const userName =
                action === 'normal' && prevMsg?.is_user && typeof prevMsg.name === 'string'
                    ? prevMsg.name
                    : rendererDeps.identity.userName;

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

        const action = normalizeTakeoverAction(type);
        if (!action) {
            return;
        }

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
        dispose() {
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
