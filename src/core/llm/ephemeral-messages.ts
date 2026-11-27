import type { ToolEphemeralMessagesApi } from '../bridge';
import type {
    CanonicalContentPart,
    CanonicalMessage,
    CanonicalRole,
    CanonicalToolCall,
} from '../types';
import { canonicalClone } from '../utils';

export interface EphemeralMessageLayers {
    /** Exclusive end index of Layer 0 static prefix (start of Layer 1 history). Defaults to `0`. */
    layer0End?: number;
    /** Exclusive end index of Layer 1 persistent history. Defaults to `turnStart` or `layer0End`. */
    layer1End?: number;
    /** Inclusive start index of the current in-flight turn. Defaults to `layer1End`. */
    turnStart?: number;
}

export type EphemeralMessagesController = ToolEphemeralMessagesApi;

const VALID_ROLES = new Set<CanonicalRole>(['system', 'user', 'assistant', 'tool']);

function isValidRole(role: unknown): role is CanonicalRole {
    return typeof role === 'string' && VALID_ROLES.has(role as CanonicalRole);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneContent(content: string | CanonicalContentPart[]): string | CanonicalContentPart[] {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map((part) => canonicalClone(part));
    }
    return '';
}

function hasNonEmptyContent(content: string | CanonicalContentPart[]): boolean {
    if (typeof content === 'string') {
        return content.trim().length > 0;
    }
    if (!Array.isArray(content) || content.length === 0) {
        return false;
    }
    return content.some((part) => {
        if (!part || typeof part !== 'object') {
            return false;
        }
        if (part.type === 'text') {
            return typeof part.text === 'string' && part.text.trim().length > 0;
        }
        return true;
    });
}

function cloneToolCall(tc: CanonicalToolCall): CanonicalToolCall {
    return {
        id: tc.id,
        name: tc.name,
        arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        ...(tc.thoughtSignature !== undefined ? { thoughtSignature: tc.thoughtSignature } : {}),
        ...(tc.extraFields !== undefined ? { extraFields: canonicalClone(tc.extraFields) } : {}),
    };
}

function cloneMessage(msg: CanonicalMessage): CanonicalMessage {
    return {
        role: msg.role,
        content: cloneContent(msg.content),
        ...(msg.name !== undefined ? { name: msg.name } : {}),
        ...(msg.reasoningContent !== undefined ? { reasoningContent: msg.reasoningContent } : {}),
        ...(msg.toolCalls !== undefined ? { toolCalls: msg.toolCalls.map(cloneToolCall) } : {}),
        ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName !== undefined ? { toolName: msg.toolName } : {}),
        ...(msg.extraFields !== undefined ? { extraFields: canonicalClone(msg.extraFields) } : {}),
    };
}

function normalizeValidToolCalls(toolCalls: unknown): CanonicalToolCall[] {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return [];
    }
    const seenIds = new Set<string>();
    const valid: CanonicalToolCall[] = [];
    for (const rawTc of toolCalls) {
        if (!isPlainRecord(rawTc)) {
            continue;
        }
        const id = typeof rawTc.id === 'string' ? rawTc.id.trim() : '';
        const name = typeof rawTc.name === 'string' ? rawTc.name.trim() : '';
        if (!id || !name || seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);
        valid.push(
            cloneToolCall({
                id,
                name,
                arguments:
                    typeof rawTc.arguments === 'string'
                        ? rawTc.arguments
                        : JSON.stringify(rawTc.arguments ?? {}),
                ...(typeof rawTc.thoughtSignature === 'string'
                    ? { thoughtSignature: rawTc.thoughtSignature }
                    : {}),
                ...(isPlainRecord(rawTc.extraFields)
                    ? { extraFields: rawTc.extraFields }
                    : {}),
            }),
        );
    }
    return valid;
}

/**
 * Enforce strict 1:1 pairing between `assistant(toolCalls)` and immediately following
 * contiguous `role: 'tool'` results matched by `toolCallId`.
 *
 * - Drops orphan `role: 'tool'` messages lacking a preceding matching `assistant.toolCalls`.
 * - Deduplicates repeated `role: 'tool'` responses sharing the same `toolCallId`.
 * - Drops unmatched `toolCalls` from `assistant` messages; if an `assistant` message has no
 *   matched `toolCalls` and no remaining content, the now-empty message is dropped as well.
 * - Never mutates the input array or its message objects.
 */
export function sanitizeToolCallPairs(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) {
        return [];
    }

    const validMessages: CanonicalMessage[] = [];
    for (const item of messages) {
        if (!isPlainRecord(item) || !isValidRole(item.role)) {
            continue;
        }
        validMessages.push(item as unknown as CanonicalMessage);
    }

    const sanitized: CanonicalMessage[] = [];
    let i = 0;

    while (i < validMessages.length) {
        const msg = validMessages[i];

        if (msg.role === 'tool') {
            // Orphan tool message not immediately following an assistant(toolCalls) block.
            i += 1;
            continue;
        }

        if (msg.role === 'assistant') {
            const declaredCalls = normalizeValidToolCalls(msg.toolCalls);
            if (declaredCalls.length > 0) {
                const declaredIdSet = new Set(declaredCalls.map((tc) => tc.id));
                const matchedToolMessages: CanonicalMessage[] = [];
                const matchedIdSet = new Set<string>();

                let j = i + 1;
                while (j < validMessages.length && validMessages[j].role === 'tool') {
                    const toolMsg = validMessages[j];
                    const callId =
                        typeof toolMsg.toolCallId === 'string' ? toolMsg.toolCallId.trim() : '';
                    if (callId && declaredIdSet.has(callId) && !matchedIdSet.has(callId)) {
                        matchedIdSet.add(callId);
                        const clonedTool = cloneMessage(toolMsg);
                        clonedTool.toolCallId = callId;
                        delete clonedTool.toolCalls;
                        matchedToolMessages.push(clonedTool);
                    }
                    j += 1;
                }

                const matchedCalls = declaredCalls.filter((tc) => matchedIdSet.has(tc.id));
                const clonedAssistant = cloneMessage(msg);
                delete clonedAssistant.toolCallId;
                delete clonedAssistant.toolName;

                if (matchedCalls.length > 0) {
                    clonedAssistant.toolCalls = matchedCalls;
                    sanitized.push(clonedAssistant, ...matchedToolMessages);
                } else {
                    delete clonedAssistant.toolCalls;
                    if (hasNonEmptyContent(clonedAssistant.content)) {
                        sanitized.push(clonedAssistant);
                    }
                }

                i = j;
                continue;
            }

            // Assistant without toolCalls (strip empty toolCalls: [] if present).
            const clonedAssistant = cloneMessage(msg);
            delete clonedAssistant.toolCalls;
            delete clonedAssistant.toolCallId;
            delete clonedAssistant.toolName;
            sanitized.push(clonedAssistant);
            i += 1;
            continue;
        }

        // 'system' or 'user'
        const cloned = cloneMessage(msg);
        delete cloned.toolCalls;
        delete cloned.toolCallId;
        delete cloned.toolName;
        sanitized.push(cloned);
        i += 1;
    }

    return sanitized;
}

function clampIndex(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }
    const truncated = Math.trunc(value);
    return Math.min(max, Math.max(min, truncated));
}

function extractTextContent(content: string | CanonicalContentPart[]): string {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
}

function applyTextReplacement(
    content: string | CanonicalContentPart[],
    nextText: string,
): string | CanonicalContentPart[] {
    if (typeof content === 'string' || !Array.isArray(content)) {
        return nextText;
    }
    const nonTextParts = content
        .filter((part) => part.type !== 'text')
        .map((part) => canonicalClone(part));
    if (nonTextParts.length === 0) {
        return nextText;
    }
    const updatedParts: CanonicalContentPart[] = [];
    let insertedText = false;
    for (const part of content) {
        if (part.type === 'text') {
            if (!insertedText) {
                updatedParts.push({ type: 'text', text: nextText });
                insertedText = true;
            }
        } else {
            updatedParts.push(canonicalClone(part));
        }
    }
    if (!insertedText) {
        updatedParts.unshift({ type: 'text', text: nextText });
    }
    return updatedParts;
}

interface TurnSpan {
    start: number;
    end: number;
    hasUser: boolean;
}

function segmentHistoryTurns(
    messages: readonly CanonicalMessage[],
    startIndex: number,
    endIndex: number,
): TurnSpan[] {
    const start = clampIndex(startIndex, 0, messages.length);
    const end = clampIndex(endIndex, start, messages.length);
    if (start >= end) {
        return [];
    }

    // Preserve leading Layer 1 compaction summary/header system messages.
    let firstDialogue = start;
    while (firstDialogue < end && messages[firstDialogue].role === 'system') {
        firstDialogue += 1;
    }
    if (firstDialogue >= end) {
        return [];
    }

    const spans: TurnSpan[] = [];
    for (let i = firstDialogue; i < end; i += 1) {
        const msg = messages[i];
        const currentSpan = spans.length > 0 ? spans[spans.length - 1] : undefined;

        if (!currentSpan) {
            spans.push({ start: i, end: i + 1, hasUser: msg.role === 'user' });
            continue;
        }

        if (msg.role === 'tool') {
            // Never split a tool result from its preceding assistant(toolCalls) turn.
            currentSpan.end = i + 1;
            continue;
        }

        if (msg.role === 'user') {
            spans.push({ start: i, end: i + 1, hasUser: true });
            continue;
        }

        if (msg.role === 'assistant') {
            const prevMsg = messages[i - 1];
            const prevIsPlainAssistant =
                prevMsg.role === 'assistant'
                && (!Array.isArray(prevMsg.toolCalls) || prevMsg.toolCalls.length === 0);
            if (!currentSpan.hasUser && prevIsPlainAssistant) {
                spans.push({ start: i, end: i + 1, hasUser: false });
            } else {
                currentSpan.end = i + 1;
            }
            continue;
        }

        // Mid-history system note stays attached to the current turn span.
        currentSpan.end = i + 1;
    }

    return spans;
}

/**
 * Create an ephemeral pre-send message controller that lets preprocess / error-recovery
 * scripts safely inspect, rewrite, roll back in-flight tool rounds, or drop Layer 1
 * history turns without ever mutating Layer 0/Layer 1 storage or emitting broken
 * `tool_call` / `tool` pairs.
 */
export function createEphemeralMessagesController(
    messages: readonly CanonicalMessage[],
    layers?: EphemeralMessageLayers,
): EphemeralMessagesController {
    let current: CanonicalMessage[] = Array.isArray(messages)
        ? messages
            .filter((item): item is CanonicalMessage => isPlainRecord(item) && isValidRole(item.role))
            .map(cloneMessage)
        : [];

    let layer0End = clampIndex(layers?.layer0End ?? 0, 0, current.length);
    let layer1End = clampIndex(
        layers?.layer1End ?? layers?.turnStart ?? layer0End,
        layer0End,
        current.length,
    );
    let turnStart = clampIndex(layers?.turnStart ?? layer1End, layer1End, current.length);

    return {
        list(): CanonicalMessage[] {
            return current.map(cloneMessage);
        },

        set(nextMessages: CanonicalMessage[]): void {
            if (!Array.isArray(nextMessages)) {
                throw new TypeError('messages.set() requires an array of CanonicalMessage objects.');
            }
            current = nextMessages
                .filter((item): item is CanonicalMessage => isPlainRecord(item) && isValidRole(item.role))
                .map(cloneMessage);
            layer0End = clampIndex(layer0End, 0, current.length);
            layer1End = clampIndex(layer1End, layer0End, current.length);
            turnStart = clampIndex(turnStart, layer1End, current.length);
        },

        rollbackToolRounds(count: number = 1): number {
            if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
                return 0;
            }
            const targetRounds = Math.floor(count);
            let rolledBack = 0;

            for (let step = 0; step < targetRounds; step += 1) {
                let assistantIdx = -1;
                for (let idx = current.length - 1; idx >= turnStart; idx -= 1) {
                    const msg = current[idx];
                    if (
                        msg.role === 'assistant'
                        && Array.isArray(msg.toolCalls)
                        && msg.toolCalls.length > 0
                    ) {
                        assistantIdx = idx;
                        break;
                    }
                }
                if (assistantIdx < 0) {
                    break;
                }

                let endIdx = assistantIdx + 1;
                while (endIdx < current.length && current[endIdx].role === 'tool') {
                    endIdx += 1;
                }
                current.splice(assistantIdx, endIdx - assistantIdx);
                rolledBack += 1;
            }

            return rolledBack;
        },

        dropHistoryTurns(
            count: number = 1,
            opts?: { from?: 'newest' | 'oldest' },
        ): number {
            if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
                return 0;
            }
            const targetTurns = Math.floor(count);
            const spans = segmentHistoryTurns(current, layer0End, layer1End);
            if (spans.length === 0) {
                return 0;
            }

            const toDrop = Math.min(targetTurns, spans.length);
            const fromNewest = opts?.from === 'newest';
            const removeStart = fromNewest
                ? spans[spans.length - toDrop].start
                : spans[0].start;
            const removeEnd = fromNewest
                ? spans[spans.length - 1].end
                : spans[toDrop - 1].end;
            const removeCount = removeEnd - removeStart;

            if (removeCount <= 0) {
                return 0;
            }

            current.splice(removeStart, removeCount);
            layer1End = Math.max(layer0End, layer1End - removeCount);
            turnStart = Math.max(layer1End, turnStart - removeCount);
            return toDrop;
        },

        replaceContent(
            selector: number | ((msg: CanonicalMessage, idx: number) => boolean),
            replacer: string | ((content: string, msg: CanonicalMessage, idx: number) => string),
        ): number {
            const isIndexSelector = typeof selector === 'number';
            const isFnSelector = typeof selector === 'function';
            if (!isIndexSelector && !isFnSelector) {
                throw new TypeError('messages.replaceContent() selector must be an index or predicate function.');
            }
            if (typeof replacer !== 'string' && typeof replacer !== 'function') {
                throw new TypeError('messages.replaceContent() replacer must be a string or function.');
            }

            if (isIndexSelector) {
                if (!Number.isInteger(selector) || selector < 0 || selector >= current.length) {
                    return 0;
                }
                const msg = current[selector];
                const currentText = extractTextContent(msg.content);
                const nextText =
                    typeof replacer === 'function'
                        ? replacer(currentText, cloneMessage(msg), selector)
                        : replacer;
                if (typeof nextText !== 'string') {
                    return 0;
                }
                msg.content = applyTextReplacement(msg.content, nextText);
                return 1;
            }

            let replaced = 0;
            for (let idx = 0; idx < current.length; idx += 1) {
                const msg = current[idx];
                const snapshot = cloneMessage(msg);
                if (!selector(snapshot, idx)) {
                    continue;
                }
                const currentText = extractTextContent(msg.content);
                const nextText =
                    typeof replacer === 'function'
                        ? replacer(currentText, cloneMessage(msg), idx)
                        : replacer;
                if (typeof nextText === 'string') {
                    msg.content = applyTextReplacement(msg.content, nextText);
                    replaced += 1;
                }
            }
            return replaced;
        },

        appendHint(content: string, role?: 'user' | 'system'): void {
            if (typeof content !== 'string' || content.length === 0) {
                return;
            }
            const safeRole: 'user' | 'system' = role === 'system' ? 'system' : 'user';
            current.push({
                role: safeRole,
                content,
            });
        },

        toMessages(): CanonicalMessage[] {
            return sanitizeToolCallPairs(current);
        },
    };
}
