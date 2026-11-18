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

            const identity = bridge.getActiveIdentity();
            const activeRenderer = StreamRenderer.beginPlaceholder(action, {
                getSettings,
                getStore: () => orchestrator.store,
                getAppStore,
                substituteMacros: (text, overrides) => bridge.substituteMacros(text, overrides),
                identity,
            });
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
                    : identity.userName;

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
        } catch (error) {
            if (renderer) {
                orchestrator.store.rollbackStagedData(renderer.target);
            }
            if (isAbortError(error, controller.signal)) {
                await renderer?.abort({ wasUserStop: true, reason: 'Stopped by user' });
            } else {
                const message = error instanceof Error ? error.message : String(error);
                console.error('[ST-Agentic] Takeover generation failed:', error);
                getAppStore?.()?.pushToast(`Generation failed: ${message}`, 'error');
                await renderer?.abort({ errorMessage: message });
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
