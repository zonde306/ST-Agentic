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

import type { GenerationAction, PipelineOrchestrator } from '@/core/triggers';
import type { Settings, ToolStepLog } from '@/core/types';
import type { AppStore } from '@/ui/store';

import type { STHostBridge } from './st-bridge';
import { StreamRenderer } from './stream-renderer';

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

function createGenerationUiGuard(controller: AbortController): () => void {
    if (typeof document === 'undefined') {
        return () => {};
    }

    let active = true;
    const applyLockState = () => {
        if (!active || controller.signal.aborted) {
            return;
        }
        document.body.dataset.generating = 'true';
        document.body.dataset.agenticTakeover = 'true';
        if (typeof deactivateSendButtons === 'function') {
            deactivateSendButtons();
        }
        if (typeof hideSwipeButtons === 'function') {
            hideSwipeButtons();
        }

        const mesStop = document.getElementById('mes_stop');
        if (mesStop && mesStop.style.display === 'none') {
            mesStop.style.display = 'flex';
        }
        const sendBut = document.getElementById('send_but');
        if (sendBut && sendBut.style.display !== 'none') {
            sendBut.style.display = 'none';
        }
    };

    applyLockState();

    const observer =
        typeof MutationObserver === 'function'
            ? new MutationObserver(() => {
                  applyLockState();
              })
            : null;

    if (observer) {
        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ['data-generating'],
        });
        const mesStop = document.getElementById('mes_stop');
        if (mesStop) {
            observer.observe(mesStop, {
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
        }
        const sendBut = document.getElementById('send_but');
        if (sendBut) {
            observer.observe(sendBut, {
                attributes: true,
                attributeFilter: ['style', 'class'],
            });
        }
    }

    return () => {
        if (!active) {
            return;
        }
        active = false;
        observer?.disconnect();
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

    const executeTakeoverTurn = async (
        action: GenerationAction,
        session: ActiveTakeoverSession,
    ): Promise<void> => {
        const { controller } = session;
        if (typeof setExternalAbortController === 'function') {
            setExternalAbortController(controller);
        }

        const identity = bridge.getActiveIdentity();
        const renderer = StreamRenderer.beginPlaceholder(action, {
            getSettings,
            getStore: () => orchestrator.store,
            getAppStore,
            substituteMacros: (text, overrides) => bridge.substituteMacros(text, overrides),
            identity,
        });
        session.renderer = renderer;

        try {
            if (controller.signal.aborted) {
                await renderer.abort({ wasUserStop: true, reason: 'Stopped before start' });
                return;
            }

            renderer.setRetrievingStatus('Preparing turn context');
            getAppStore?.()?.setActiveTarget(renderer.target);

            const prevMsg =
                Array.isArray(chat) && renderer.target.messageId > 0
                    ? (chat[renderer.target.messageId - 1] as
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
                    : identity.userName;

            const result = await orchestrator.runTurn({
                action,
                target: renderer.target,
                previousSwipeId: renderer.previousSwipeId,
                userInput,
                userName,
                existingContent: action === 'continue' ? renderer.existingContent : undefined,
                turnNumber: renderer.target.messageId + 1,
                signal: controller.signal,
                stream: true,
                onTextDelta: (delta) => renderer.appendTextDelta(delta),
                onReasoningDelta: (delta) => renderer.appendReasoningDelta(delta),
                onToolStart: (step: ToolStepLog) => renderer.onToolStart(step.toolName),
                onToolComplete: (step: ToolStepLog) => renderer.onToolComplete(step.toolName),
            });

            if (controller.signal.aborted) {
                orchestrator.store.rollbackStagedData(renderer.target);
                await renderer.abort({
                    wasUserStop: true,
                    reason: 'Generation stopped',
                });
                return;
            }

            const backgroundHandles = result.afterTurnTasks ?? [];
            await renderer.finalize({
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
                        renderer.updateBackgroundStatus(remaining);
                    });
                }
            }
        } catch (error) {
            orchestrator.store.rollbackStagedData(renderer.target);
            if (isAbortError(error, controller.signal)) {
                await renderer.abort({ wasUserStop: true, reason: 'Stopped by user' });
            } else {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[ST-Agentic] Takeover generation failed:', error);
                getAppStore?.()?.pushToast(`Generation failed: ${message}`, 'error');
                await renderer.abort({ errorMessage: message });
            }
        } finally {
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
        }
    };

    const interceptor: STGenerateInterceptor = (
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
        const releaseGuard = createGenerationUiGuard(controller);
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

        // Start takeover turn immediately after ST's synchronous Generate() unwinds.
        setTimeout(() => {
            void executeTakeoverTurn(action, session);
        }, 0);
    };

    if (registerGlobal) {
        (globalThis as Record<string, unknown>).Agentic_interceptor = interceptor;
    }

    return {
        interceptor,
        isTakeoverActive: () => activeSession !== null,
        abortActiveTakeover,
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
