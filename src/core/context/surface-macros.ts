import type { HostBridge } from '../bridge';
import type {
    ApiConnection,
    AssistantSession,
    CanonicalContentPart,
    CanonicalMessage,
} from '../types';
import { buildLayer2MacroOverrides } from './context-assembler';
import { resolveEffectiveContextBudget, type EffectiveContextBudget } from './context-budget';

export type AgenticSurfaceKind = 'main' | 'assistant' | 'sidegen';

export type SurfaceGenerationType = 'normal' | 'regenerate' | 'continue' | 'quiet';

export interface HostChatMacroSnapshot {
    stLastMessage: string;
    stLastMessageId: string;
    stLastUserMessage: string;
    stLastCharMessage: string;
}

export interface AssistantMacroOverridesInput {
    session: Pick<AssistantSession, 'mode' | 'messages'>;
    bridge?: Pick<HostBridge, 'getChat'>;
    excludeMessageId?: string;
    currentUserInput?: string;
    generationType?: SurfaceGenerationType;
    connection?: Pick<ApiConnection, 'model' | 'contextSize' | 'maxTokens'>;
    budget?: EffectiveContextBudget;
    vars?: Record<string, unknown>;
}

export interface SideGenMacroOverridesInput {
    mode: 'once' | 'session';
    historyMessages?: readonly CanonicalMessage[];
    currentPrompt?: string;
    bridge?: Pick<HostBridge, 'getChat'>;
    generationType?: Extract<SurfaceGenerationType, 'normal' | 'quiet'>;
    connection?: Pick<ApiConnection, 'model' | 'contextSize' | 'maxTokens'>;
    budget?: EffectiveContextBudget;
    vars?: Record<string, unknown>;
}

export interface MainSurfaceMacroOverridesInput {
    bridge?: Pick<HostBridge, 'getChat'>;
    userInput?: CanonicalMessage['content'];
    connection?: Pick<ApiConnection, 'model' | 'contextSize' | 'maxTokens'>;
    budget?: EffectiveContextBudget;
    callerOverrides?: Record<string, string>;
}

interface ScopedConversationItem {
    role: 'user' | 'assistant';
    content: string;
}

function extractCanonicalPlainText(content: string | CanonicalContentPart[] | undefined): string {
    if (!content) {
        return '';
    }
    if (typeof content === 'string') {
        return content;
    }
    const parts: string[] = [];
    for (const part of content) {
        if (part.type === 'text' && part.text.length > 0) {
            parts.push(part.text);
        }
    }
    return parts.join('\n');
}

function buildScopedConversationMacros(
    items: readonly ScopedConversationItem[],
    currentUserInput?: string,
): Record<string, string> {
    let lastUserMessage = '';
    for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].role === 'user') {
            lastUserMessage = items[i].content;
            break;
        }
    }
    if (!lastUserMessage && typeof currentUserInput === 'string' && currentUserInput.length > 0) {
        lastUserMessage = currentUserInput;
    }

    let lastCharMessage = '';
    for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].role === 'assistant') {
            lastCharMessage = items[i].content;
            break;
        }
    }

    const hasItems = items.length > 0;
    const lastIdx = items.length - 1;
    const hasCurrentInput = typeof currentUserInput === 'string' && currentUserInput.length > 0;

    const lastMessage = hasItems
        ? items[lastIdx].content
        : (currentUserInput ?? '');
    const lastMessageId = hasItems
        ? String(lastIdx)
        : (hasCurrentInput ? '0' : '');
    const allChatRange = hasItems
        ? `0-${lastIdx}`
        : (hasCurrentInput ? '0-0' : '');
    const hasAnyTurn = hasItems || hasCurrentInput;
    const firstIncludedMessageId = hasAnyTurn ? '0' : '';
    const firstDisplayedMessageId = hasAnyTurn ? '0' : '';
    const lastSwipeId = hasAnyTurn ? '1' : '';
    const currentSwipeId = hasAnyTurn ? '1' : '';
    const lastInput = hasCurrentInput ? currentUserInput : lastUserMessage;

    return {
        lastUserMessage,
        lastCharMessage,
        lastMessage,
        lastMessageId,
        allChatRange,
        firstIncludedMessageId,
        firstDisplayedMessageId,
        lastSwipeId,
        currentSwipeId,
        lastInput,
    };
}

/**
 * Snapshot SillyTavern host chat endpoints (`stLast*`) so off-mainline surfaces
 * (Assistant Workbench, SideGen) can explicitly reference host chat messages even when
 * `{{lastUserMessage}}` and siblings are scoped to the active session.
 */
export function readHostChatMacroSnapshot(
    bridge?: Pick<HostBridge, 'getChat'>,
): HostChatMacroSnapshot {
    let chat: ReturnType<HostBridge['getChat']> = [];
    try {
        const raw = bridge?.getChat?.();
        if (Array.isArray(raw)) {
            chat = raw;
        }
    } catch {
        chat = [];
    }

    if (chat.length === 0) {
        return {
            stLastMessage: '',
            stLastMessageId: '',
            stLastUserMessage: '',
            stLastCharMessage: '',
        };
    }

    const lastEntry = chat[chat.length - 1];
    const stLastMessage = typeof lastEntry?.mes === 'string' ? lastEntry.mes : '';
    const stLastMessageId =
        typeof lastEntry?.id === 'number' && Number.isFinite(lastEntry.id)
            ? String(lastEntry.id)
            : String(chat.length - 1);

    let stLastUserMessage = '';
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const msg = chat[i];
        if (msg?.isUser && !msg.isSystem) {
            stLastUserMessage = typeof msg.mes === 'string' ? msg.mes : '';
            break;
        }
    }

    let stLastCharMessage = '';
    for (let i = chat.length - 1; i >= 0; i -= 1) {
        const msg = chat[i];
        if (msg && !msg.isUser && !msg.isSystem) {
            stLastCharMessage = typeof msg.mes === 'string' ? msg.mes : '';
            break;
        }
    }

    return {
        stLastMessage,
        stLastMessageId,
        stLastUserMessage,
        stLastCharMessage,
    };
}

/**
 * Build `model`, `maxContext*`, `maxResponse*`, and `maxPrompt*` macro overrides
 * from the active ST-Agentic connection and resolved effective context budget.
 */
export function buildModelAndBudgetMacros(
    connection?: Pick<ApiConnection, 'model' | 'contextSize' | 'maxTokens'>,
    budget?: EffectiveContextBudget,
): Record<string, string> {
    if (!connection && !budget) {
        return {};
    }

    const out: Record<string, string> = {};
    if (typeof connection?.model === 'string' && connection.model.trim().length > 0) {
        out.model = connection.model.trim();
    }

    const resolvedBudget = budget ?? (connection ? resolveEffectiveContextBudget(connection) : undefined);
    if (resolvedBudget) {
        const maxContext = String(resolvedBudget.contextLimit);
        const maxResponse = String(resolvedBudget.reservedOutputTokens);
        const maxPrompt = String(
            Math.max(0, resolvedBudget.contextLimit - resolvedBudget.reservedOutputTokens),
        );
        out.maxContext = maxContext;
        out.maxContextTokens = maxContext;
        out.maxResponse = maxResponse;
        out.maxResponseTokens = maxResponse;
        out.maxPrompt = maxPrompt;
        out.maxPromptTokens = maxPrompt;
    }

    return out;
}

export const EMPTY_TRIGGER_MACRO_DEFAULTS = {
    triggerPrompt: '',
    triggerLabel: '',
    triggerId: '',
    triggerPhase: '',
    triggerTargetPath: '',
} as const;

/**
 * Build session-scoped macro overrides for the Assistant Workbench (`AssistantRunner`),
 * overriding ST chat-history macros with Workbench conversation state while preserving
 * read access to ST main chat via `{{stLast*}}` and mapping VFS `vars` into `var:<k>`.
 */
export function buildAssistantMacroOverrides(
    input: AssistantMacroOverridesInput,
): Record<string, string> {
    const rawMessages = input.session.messages ?? [];
    let visibleMessages = rawMessages;
    if (input.excludeMessageId) {
        const excludeIdx = rawMessages.findIndex((m) => m.id === input.excludeMessageId);
        if (excludeIdx >= 0) {
            visibleMessages = rawMessages.slice(0, excludeIdx);
        }
    }

    const items: ScopedConversationItem[] = visibleMessages.map((msg) => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : '',
    }));

    const hasCurrentInput =
        typeof input.currentUserInput === 'string' && input.currentUserInput.length > 0;
    if (hasCurrentInput && (items.length === 0 || items[items.length - 1].role === 'assistant')) {
        items.push({ role: 'user', content: input.currentUserInput! });
    }

    const stSnapshot = readHostChatMacroSnapshot(input.bridge);
    const overrides: Record<string, string> = {
        ...EMPTY_TRIGGER_MACRO_DEFAULTS,
        ...buildScopedConversationMacros(items, input.currentUserInput),
        ...buildModelAndBudgetMacros(input.connection, input.budget),
        stLastMessage: stSnapshot.stLastMessage,
        stLastMessageId: stSnapshot.stLastMessageId,
        stLastUserMessage: stSnapshot.stLastUserMessage,
        stLastCharMessage: stSnapshot.stLastCharMessage,
        lastGenerationType: input.generationType ?? 'normal',
        assistantMode: input.session.mode,
        agenticSurface: 'assistant',
    };

    return buildLayer2MacroOverrides(input.vars, overrides) ?? overrides;
}

/**
 * Build session-scoped macro overrides for off-mainline SideGen (`SideGenService`),
 * scoping `{{lastUserMessage}}` and chat macros to the SideGen turn/session while exposing
 * `{{stLast*}}` and `var:<k>` VFS variables.
 */
export function buildSideGenMacroOverrides(
    input: SideGenMacroOverridesInput,
): Record<string, string> {
    const items: ScopedConversationItem[] = [];
    for (const msg of input.historyMessages ?? []) {
        if (msg.role !== 'user' && msg.role !== 'assistant') {
            continue;
        }
        const plain = extractCanonicalPlainText(msg.content);
        if (msg.role === 'assistant' && !plain && msg.toolCalls && msg.toolCalls.length > 0) {
            continue;
        }
        items.push({ role: msg.role, content: plain });
    }

    if (input.currentPrompt !== undefined) {
        items.push({ role: 'user', content: input.currentPrompt });
    }

    const stSnapshot = readHostChatMacroSnapshot(input.bridge);
    const overrides: Record<string, string> = {
        ...EMPTY_TRIGGER_MACRO_DEFAULTS,
        ...buildScopedConversationMacros(items, input.currentPrompt),
        ...buildModelAndBudgetMacros(input.connection, input.budget),
        stLastMessage: stSnapshot.stLastMessage,
        stLastMessageId: stSnapshot.stLastMessageId,
        stLastUserMessage: stSnapshot.stLastUserMessage,
        stLastCharMessage: stSnapshot.stLastCharMessage,
        lastGenerationType: input.generationType ?? (input.mode === 'once' ? 'quiet' : 'normal'),
        agenticSurface: 'sidegen',
    };

    return buildLayer2MacroOverrides(input.vars, overrides) ?? overrides;
}

/**
 * Build non-destructive surface macro defaults for Main Chat / Pipeline runs (`AgentRunner`),
 * leaving ST-native `{{lastUserMessage}}` / `{{lastMessage}}` untouched while providing
 * `agenticSurface`, `lastInput`, `stLast*`, and ST-Agentic `model` / token-budget macros
 * underneath any explicit caller `macroOverrides`.
 */
export function buildMainSurfaceMacroOverrides(
    input: MainSurfaceMacroOverridesInput,
): Record<string, string> {
    const stSnapshot = readHostChatMacroSnapshot(input.bridge);
    const plainUserInput = extractCanonicalPlainText(input.userInput);
    return {
        ...EMPTY_TRIGGER_MACRO_DEFAULTS,
        stLastMessage: stSnapshot.stLastMessage,
        stLastMessageId: stSnapshot.stLastMessageId,
        stLastUserMessage: stSnapshot.stLastUserMessage,
        stLastCharMessage: stSnapshot.stLastCharMessage,
        ...buildModelAndBudgetMacros(input.connection, input.budget),
        lastInput: plainUserInput || stSnapshot.stLastUserMessage,
        agenticSurface: 'main',
        ...(input.callerOverrides ?? {}),
    };
}
