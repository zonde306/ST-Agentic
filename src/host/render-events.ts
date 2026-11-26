import { eventSource, event_types } from '@st/scripts/events.js';

export const AGENTIC_RERENDER_EVENT_TYPE = 'agentic_rerender';

let internalMessageRenderEmitDepth = 0;

/**
 * Returns `true` while ST-Agentic is synchronously/awaiting an internal
 * `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` emission so companion hooks
 * never treat internal DOM re-renders as a newly generated turn.
 */
export function isInternalMessageRenderEmit(): boolean {
    return internalMessageRenderEmitDepth > 0;
}

/**
 * Emit SillyTavern's `USER_MESSAGE_RENDERED` or `CHARACTER_MESSAGE_RENDERED` event
 * for an updated message so downstream renderers (e.g. JS-Slash-Runner) re-mount.
 * Skips hidden system messages (`is_system && !is_user`) and guards against re-entrancy.
 */
export async function emitMessageRenderedEvent(
    messageId: number,
    msg: Record<string, unknown>,
    renderType: string = AGENTIC_RERENDER_EVENT_TYPE,
): Promise<boolean> {
    if (typeof eventSource?.emit !== 'function') {
        return false;
    }
    const isUser = Boolean(msg.is_user);
    const isSystem = Boolean(msg.is_system);
    if (!isUser && isSystem) {
        return false;
    }

    const eventsMap = event_types as Record<string, string | undefined>;
    const eventName = isUser ? eventsMap?.USER_MESSAGE_RENDERED : eventsMap?.CHARACTER_MESSAGE_RENDERED;
    if (!eventName) {
        return false;
    }

    internalMessageRenderEmitDepth += 1;
    try {
        if (isUser) {
            await eventSource.emit(eventName, messageId);
        } else {
            await eventSource.emit(eventName, messageId, renderType);
        }
        return true;
    } finally {
        internalMessageRenderEmitDepth = Math.max(0, internalMessageRenderEmitDepth - 1);
    }
}
