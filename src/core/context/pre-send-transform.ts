import type {
    HostBridge,
    PromptTransformLayer,
    PromptTransformMeta,
    PromptTransformRole,
    PromptTransformSource,
} from '@/core/bridge';
import type { CanonicalContentPart, CanonicalMessage, MessageTarget } from '@/core/types';
import { canonicalClone, normalizeVfsPath } from '@/core/utils';
import {
    TrajectoryStore,
    type TrajectoryMessageTransformMeta,
    type TrajectoryMessageTransformState,
} from './trajectory-store';

export function hashString64Hex(input: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < input.length; i += 1) {
        const code = input.charCodeAt(i);
        h1 ^= code;
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 ^= code;
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    const lenHex = input.length.toString(16);
    return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}_${lenHex}`;
}

export interface TransformCanonicalContentResult {
    content: string | CanonicalContentPart[];
    changed: boolean;
    cacheable: boolean;
    cacheKeys: Readonly<Record<string, string>>;
}

function buildTargetMeta(
    target: MessageTarget | undefined,
    meta?: TrajectoryMessageTransformMeta,
): {
    target?: MessageTarget;
    messageId?: number;
    swipeId?: number;
} {
    const resolvedTarget =
        meta?.messageId !== undefined && meta?.swipeId !== undefined
            ? { messageId: meta.messageId, swipeId: meta.swipeId }
            : target;
    const messageId = meta?.messageId ?? target?.messageId;
    const swipeId = meta?.swipeId ?? target?.swipeId;
    return {
        ...(target ? { target } : resolvedTarget ? { target: resolvedTarget } : {}),
        ...(messageId !== undefined ? { messageId } : {}),
        ...(swipeId !== undefined ? { swipeId } : {}),
    };
}

/**
 * Run `agentic_prompt_transform` over string content or all text parts of a multimodal array,
 * keeping non-text parts (images/audio/video/files) protocol-transparent and untouched.
 */
export async function transformCanonicalContent(
    bridge: Pick<HostBridge, 'transformPromptText' | 'evaluateOptionalEjs'>,
    rawContent: string | CanonicalContentPart[],
    buildMeta: () => {
        source: PromptTransformSource;
        layer: PromptTransformLayer;
        role?: PromptTransformRole;
        meta: Omit<PromptTransformMeta, 'isChatMessage'> & { isChatMessage?: boolean };
        sessionBag?: Record<string, unknown>;
        signal?: AbortSignal;
    },
): Promise<TransformCanonicalContentResult> {
    if (!bridge.transformPromptText) {
        return {
            content: canonicalClone(rawContent),
            changed: false,
            cacheable: true,
            cacheKeys: {},
        };
    }

    if (typeof rawContent === 'string') {
        const spec = buildMeta();
        const res = await bridge.transformPromptText({
            text: rawContent,
            source: spec.source,
            layer: spec.layer,
            ...(spec.role ? { role: spec.role } : {}),
            dryRun: false,
            meta: spec.meta,
            ...(spec.sessionBag ? { sessionBag: spec.sessionBag } : {}),
            ...(spec.signal ? { signal: spec.signal } : {}),
        });
        return {
            content: res.text,
            changed: res.changed,
            cacheable: res.cacheable,
            cacheKeys: res.cacheKeys,
        };
    }

    let anyChanged = false;
    let allCacheable = true;
    const mergedKeys: Record<string, string> = {};
    const nextParts: CanonicalContentPart[] = [];

    for (const part of rawContent) {
        if (part.type === 'text') {
            const spec = buildMeta();
            const res = await bridge.transformPromptText({
                text: part.text,
                source: spec.source,
                layer: spec.layer,
                ...(spec.role ? { role: spec.role } : {}),
                dryRun: false,
                meta: spec.meta,
                ...(spec.sessionBag ? { sessionBag: spec.sessionBag } : {}),
                ...(spec.signal ? { signal: spec.signal } : {}),
            });
            if (res.changed) {
                anyChanged = true;
            }
            if (!res.cacheable) {
                allCacheable = false;
            }
            Object.assign(mergedKeys, res.cacheKeys);
            nextParts.push({ ...part, text: res.text });
        } else {
            nextParts.push({ ...part });
        }
    }

    return {
        content: nextParts,
        changed: anyChanged,
        cacheable: allCacheable,
        cacheKeys: mergedKeys,
    };
}

function inferReadFileHeaderMeta(
    content: string | CanonicalContentPart[],
): { path?: string; mount?: string } | undefined {
    const firstText =
        typeof content === 'string'
            ? content
            : content.find((p): p is { type: 'text'; text: string } => p.type === 'text')?.text;
    if (!firstText) {
        return undefined;
    }
    const match = firstText.match(/^\[File:\s*(\/[^|\r\n\]]+?)\s*(?:\||])/m);
    if (!match?.[1]) {
        return undefined;
    }
    try {
        const norm = normalizeVfsPath(match[1].trim());
        const seg = norm.split('/').filter(Boolean)[0];
        return {
            path: norm,
            ...(seg ? { mount: seg } : {}),
        };
    } catch {
        return undefined;
    }
}

function resolveDefaultSourceForLayer1(
    msg: CanonicalMessage,
    meta?: TrajectoryMessageTransformMeta,
): { source: PromptTransformSource; layer: PromptTransformLayer } | null {
    if (meta?.source) {
        if (meta.source === 'history_read' || meta.source === 'variables_read' || meta.source === 'vfs_read') {
            return { source: meta.source, layer: 'tool_read' };
        }
        return { source: meta.source, layer: 'layer1_ephemeral' };
    }
    if (msg.role === 'user' || msg.role === 'assistant') {
        // Intermediate tool-call stubs with empty content do not carry prose/prompt templates.
        const hasText = typeof msg.content === 'string'
            ? msg.content.length > 0
            : msg.content.some((p) => p.type === 'text' && p.text.length > 0);
        if (msg.toolCalls && msg.toolCalls.length > 0 && !hasText) {
            return null;
        }
        return { source: 'chat_message', layer: 'layer1_ephemeral' };
    }
    if (msg.role === 'tool') {
        if (msg.toolName === 'read_history') {
            return { source: 'history_read', layer: 'tool_read' };
        }
        if (msg.toolName === 'read_variables') {
            return { source: 'variables_read', layer: 'tool_read' };
        }
        if (msg.toolName === 'read_file') {
            return { source: 'vfs_read', layer: 'tool_read' };
        }
    }
    return null;
}

/**
 * Resolve Layer 1 `TrajectoryStore` messages right before sending to LLM:
 * - Any message with `transformState.cached === true` is returned verbatim with zero hook calls.
 * - Uncached or `cacheable: false` messages invoke `agentic_prompt_transform`.
 * - As soon as one pass succeeds without `cache.disable()` (`cacheable && empty cacheKeys`),
 *   the message is promoted to `{ cached: true }` in `TrajectoryStore` so future turns skip it.
 */
export async function resolveTrajectoryLayer1Messages(params: {
    bridge: Pick<HostBridge, 'transformPromptText'>;
    trajectoryStore: TrajectoryStore;
    threadId: string;
    sessionId: string;
    agentId?: string;
    phase?: string;
    target?: MessageTarget;
    defaultIsChatMessage?: boolean;
    vars?: Readonly<Record<string, unknown>>;
    sessionBag?: Record<string, unknown>;
    signal?: AbortSignal;
}): Promise<CanonicalMessage[]> {
    const messages = params.trajectoryStore.getMessages(params.threadId);
    if (messages.length === 0 || !params.bridge.transformPromptText) {
        return messages.map((m) => canonicalClone(m));
    }

    const states = params.trajectoryStore.getTransformStates(params.threadId);
    const out: CanonicalMessage[] = [];

    for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i];
        const state = states[i];

        if (state?.cached === true) {
            out.push(canonicalClone(msg));
            continue;
        }

        const meta = state?.meta;
        const resolved = resolveDefaultSourceForLayer1(msg, meta);
        if (!resolved) {
            params.trajectoryStore.updateMessageTransformState(
                i,
                { cached: true },
                undefined,
                params.threadId,
            );
            out.push(canonicalClone(msg));
            continue;
        }

        const rawContent = state?.rawContent !== undefined ? state.rawContent : msg.content;
        const coords = buildTargetMeta(params.target, meta);
        const inferredVfs =
            resolved.source === 'vfs_read' && (!meta?.path || !meta?.mount)
                ? inferReadFileHeaderMeta(rawContent)
                : undefined;
        const resolvedPath = meta?.path ?? inferredVfs?.path;
        const resolvedMount = meta?.mount ?? inferredVfs?.mount;
        const isChatMsg =
            meta?.isChatMessage
            ?? (resolved.source === 'chat_message'
                ? (params.defaultIsChatMessage ?? true)
                : false);
        const role: PromptTransformRole =
            msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
                ? msg.role
                : 'user';

        const nextMeta: TrajectoryMessageTransformMeta = {
            ...(meta ? { ...meta } : {}),
            source: resolved.source,
            isChatMessage: isChatMsg,
            ...(coords.messageId !== undefined ? { messageId: coords.messageId } : {}),
            ...(coords.swipeId !== undefined ? { swipeId: coords.swipeId } : {}),
            ...(meta?.name !== undefined ? { name: meta.name } : msg.name ? { name: msg.name } : {}),
            ...(meta?.isUser !== undefined
                ? { isUser: meta.isUser }
                : msg.role === 'user'
                    ? { isUser: true }
                    : msg.role === 'assistant'
                        ? { isUser: false }
                        : {}),
            ...(meta?.toolName ? { toolName: meta.toolName } : msg.toolName ? { toolName: msg.toolName } : {}),
            ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
            ...(resolvedPath ? { path: resolvedPath } : {}),
            ...(resolvedMount ? { mount: resolvedMount } : {}),
            ...(meta?.editable !== undefined ? { editable: meta.editable } : {}),
            ...(meta?.writable !== undefined ? { writable: meta.writable } : {}),
        };

        const transformed = await transformCanonicalContent(params.bridge, rawContent, () => ({
            source: resolved.source,
            layer: resolved.layer,
            role,
            meta: {
                sessionId: params.sessionId,
                ...(params.agentId ? { agentId: params.agentId } : {}),
                ...(params.phase ? { phase: params.phase } : {}),
                ...(coords.target ? { target: coords.target } : {}),
                ...nextMeta,
                ...(params.vars ? { vars: params.vars } : {}),
            },
            sessionBag: params.sessionBag,
            signal: params.signal,
        }));

        const canPromoteToCache =
            transformed.cacheable && Object.keys(transformed.cacheKeys).length === 0;
        const msgClone = canonicalClone(msg);
        msgClone.content = canonicalClone(transformed.content);

        if (canPromoteToCache) {
            params.trajectoryStore.updateMessageTransformState(
                i,
                {
                    cached: true,
                    ...(transformed.changed ? { rawContent: canonicalClone(rawContent) } : {}),
                    meta: nextMeta,
                },
                transformed.content,
                params.threadId,
            );
        } else if (!state) {
            params.trajectoryStore.updateMessageTransformState(
                i,
                {
                    cached: false,
                    rawContent: canonicalClone(rawContent),
                    meta: nextMeta,
                },
                undefined,
                params.threadId,
            );
        }

        out.push(msgClone);
    }

    return out;
}

const VARIABLE_VFS_PATHS = new Set<string>([
    '/state/variables.json',
    '/state/chat_variables.json',
    '/state/global_variables.json',
]);

/**
 * Run pre-send `agentic_prompt_transform` on eligible read tool outputs (`read_history`,
 * `read_variables`, and `read_file` for raw/history/state paths) right before appending the
 * tool result to in-flight messages sent to the LLM.
 */
export async function transformToolResultBeforeSend(params: {
    bridge: Pick<HostBridge, 'transformPromptText'>;
    toolName: string;
    toolCallId: string;
    toolArgs: Record<string, unknown> | string;
    outputText: string;
    ok: boolean;
    sessionId: string;
    agentId?: string;
    phase?: string;
    target?: MessageTarget;
    canEditVariables?: boolean;
    alreadyTransformedByVfs?: boolean;
    vars?: Readonly<Record<string, unknown>>;
    sessionBag?: Record<string, unknown>;
    signal?: AbortSignal;
}): Promise<{
    text: string;
    transformState: TrajectoryMessageTransformState;
}> {
    if (!params.ok || !params.bridge.transformPromptText) {
        return {
            text: params.outputText,
            transformState: { cached: true },
        };
    }

    let source: PromptTransformSource | undefined;
    let filePath: string | undefined;
    let mount: string | undefined;
    let editable = false;
    let writable = false;

    if (params.toolName === 'read_history') {
        source = 'history_read';
        mount = 'history';
        const chunkArg =
            typeof params.toolArgs === 'object' && params.toolArgs !== null
                ? params.toolArgs.chunk
                : undefined;
        if (typeof chunkArg === 'string' && chunkArg.trim()) {
            try {
                const norm = normalizeVfsPath(chunkArg.trim());
                filePath = norm.startsWith('/history/') ? norm : normalizeVfsPath(`/history/${chunkArg.trim()}`);
            } catch {
                filePath = undefined;
            }
        }
    } else if (params.toolName === 'read_variables') {
        source = 'variables_read';
        mount = 'state';
        const scope =
            typeof params.toolArgs === 'object' && params.toolArgs !== null
                ? params.toolArgs.scope
                : undefined;
        filePath =
            scope === 'chat'
                ? '/state/chat_variables.json'
                : scope === 'global'
                    ? '/state/global_variables.json'
                    : '/state/variables.json';
        editable = Boolean(params.canEditVariables);
        writable = Boolean(params.canEditVariables);
    } else if (params.toolName === 'read_file') {
        const rawPath =
            typeof params.toolArgs === 'object' && params.toolArgs !== null
                ? params.toolArgs.path
                : undefined;
        if (typeof rawPath === 'string' && rawPath.trim()) {
            try {
                const norm = normalizeVfsPath(rawPath.trim());
                filePath = norm;
                if (norm.startsWith('/history/')) {
                    source = 'history_read';
                    mount = 'history';
                } else if (VARIABLE_VFS_PATHS.has(norm)) {
                    source = 'variables_read';
                    mount = 'state';
                    editable = Boolean(params.canEditVariables);
                    writable = Boolean(params.canEditVariables);
                } else if (params.alreadyTransformedByVfs === false) {
                    // Preserve editability when Workbench / edit mode read raw VFS contents.
                    source = 'vfs_read';
                    editable = true;
                    writable = true;
                }
            } catch {
                filePath = undefined;
            }
        }
    }

    if (!source) {
        if (params.toolName === 'read_file') {
            const headerMeta = filePath
                ? { path: filePath, mount: filePath.split('/').filter(Boolean)[0] }
                : inferReadFileHeaderMeta(params.outputText);
            return {
                text: params.outputText,
                transformState: {
                    cached: true,
                    meta: {
                        source: 'vfs_read',
                        isChatMessage: false,
                        ...(params.target
                            ? {
                                  messageId: params.target.messageId,
                                  swipeId: params.target.swipeId,
                              }
                            : {}),
                        toolName: params.toolName,
                        toolCallId: params.toolCallId,
                        ...(headerMeta?.path ? { path: headerMeta.path } : {}),
                        ...(headerMeta?.mount ? { mount: headerMeta.mount } : {}),
                        editable: false,
                        writable: false,
                    },
                },
            };
        }
        return {
            text: params.outputText,
            transformState: { cached: true },
        };
    }

    const resultMeta: TrajectoryMessageTransformMeta = {
        source,
        isChatMessage: false,
        ...(params.target
            ? {
                  messageId: params.target.messageId,
                  swipeId: params.target.swipeId,
              }
            : {}),
        toolName: params.toolName,
        toolCallId: params.toolCallId,
        ...(filePath ? { path: filePath } : {}),
        ...(mount ? { mount } : {}),
        editable,
        writable,
    };

    const res = await params.bridge.transformPromptText({
        text: params.outputText,
        source,
        layer: 'tool_read',
        role: 'tool',
        dryRun: false,
        meta: {
            sessionId: params.sessionId,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            ...(params.phase ? { phase: params.phase } : {}),
            ...(params.target
                ? {
                      target: params.target,
                      messageId: params.target.messageId,
                      swipeId: params.target.swipeId,
                  }
                : {}),
            ...resultMeta,
            ...(params.vars ? { vars: params.vars } : {}),
        },
        ...(params.sessionBag ? { sessionBag: params.sessionBag } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });

    if (res.cacheable && Object.keys(res.cacheKeys).length === 0) {
        return {
            text: res.text,
            transformState: {
                cached: true,
                ...(res.changed ? { rawContent: params.outputText } : {}),
                meta: resultMeta,
            },
        };
    }

    return {
        text: res.text,
        transformState: {
            cached: false,
            rawContent: params.outputText,
            meta: resultMeta,
        },
    };
}

/**
 * Re-evaluate in-flight messages that were marked `cacheable: false` before Round 2+
 * LLM calls, promoting any entry to `{ cached: true }` once a pass succeeds cleanly.
 */
export async function refreshNonCacheableInFlightMessages(params: {
    bridge: Pick<HostBridge, 'transformPromptText'>;
    messages: CanonicalMessage[];
    states: Array<TrajectoryMessageTransformState | undefined>;
    sessionId: string;
    agentId?: string;
    phase?: string;
    target?: MessageTarget;
    vars?: Readonly<Record<string, unknown>>;
    sessionBag?: Record<string, unknown>;
    signal?: AbortSignal;
}): Promise<void> {
    if (!params.bridge.transformPromptText) {
        return;
    }

    for (let i = 0; i < params.messages.length; i += 1) {
        const state = params.states[i];
        if (!state || state.cached !== false || state.rawContent === undefined) {
            continue;
        }
        const msg = params.messages[i];
        const meta = state.meta;
        const source = meta?.source ?? (msg.role === 'tool' ? 'vfs_read' : 'user_input');
        const layer: PromptTransformLayer =
            source === 'history_read' || source === 'variables_read' || source === 'vfs_read'
                ? 'tool_read'
                : source === 'chat_message'
                    ? 'layer1_ephemeral'
                    : 'layer2_tail';
        const role: PromptTransformRole =
            msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant' || msg.role === 'tool'
                ? msg.role
                : 'user';
        const coords = buildTargetMeta(params.target, meta);

        const transformed = await transformCanonicalContent(params.bridge, state.rawContent, () => ({
            source,
            layer,
            role,
            meta: {
                sessionId: params.sessionId,
                ...(params.agentId ? { agentId: params.agentId } : {}),
                ...(params.phase ? { phase: params.phase } : {}),
                ...coords,
                isChatMessage: Boolean(meta?.isChatMessage),
                ...(meta?.name !== undefined ? { name: meta.name } : msg.name ? { name: msg.name } : {}),
                ...(meta?.isUser !== undefined ? { isUser: meta.isUser } : {}),
                ...(meta?.toolName ? { toolName: meta.toolName } : msg.toolName ? { toolName: msg.toolName } : {}),
                ...(meta?.toolCallId ? { toolCallId: meta.toolCallId } : msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
                ...(meta?.path ? { path: meta.path } : {}),
                ...(meta?.mount ? { mount: meta.mount } : {}),
                ...(meta?.editable !== undefined ? { editable: meta.editable } : {}),
                ...(meta?.writable !== undefined ? { writable: meta.writable } : {}),
                ...(params.vars ? { vars: params.vars } : {}),
            },
            sessionBag: params.sessionBag,
            signal: params.signal,
        }));

        msg.content = canonicalClone(transformed.content);
        if (transformed.cacheable && Object.keys(transformed.cacheKeys).length === 0) {
            params.states[i] = { cached: true };
        }
    }
}
