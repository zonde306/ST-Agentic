import { render } from 'preact';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type {
    AssistantAttachment,
    AssistantMessage,
    AssistantRetryStatus,
    AssistantSession,
    AssistantSessionTokenStatus,
    PendingApproval,
    UndoRecord,
} from '@/core/types';
import { registerAssistantView } from '@/ui/assistant';
import { AgenticAppShell } from '@/ui/shell';
import {
    AppStore,
    AppStoreProvider,
    type AssistantRuntimeBridge,
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
} from '@/ui/store';
import {
    SAMPLE_ASSISTANT_SESSION,
    SAMPLE_PENDING_ADMIN_APPROVAL,
    SAMPLE_PENDING_AUTHOR_APPROVAL,
    SAMPLE_UNDO_RECORD,
} from '../../fixtures/off-mainline-fixtures';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function settleLayout(frames = 4): Promise<void> {
    for (let i = 0; i < frames; i += 1) {
        await nextAnimationFrame();
    }
}

function isElementVisible(el: Element | null): boolean {
    if (!el) {
        return false;
    }
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
}

function getShellElements(): {
    dialog: HTMLDialogElement;
    shadowHost: HTMLDivElement;
    shadowRoot: ShadowRoot;
    consoleEl: HTMLDivElement;
} {
    const dialog = document.querySelector('dialog#agentic-app') as HTMLDialogElement | null;
    if (!dialog) {
        throw new Error('Expected <dialog id="agentic-app"> to be mounted');
    }
    const shadowHost = dialog.querySelector('[data-agentic-shadow-host="true"]') as HTMLDivElement | null;
    if (!shadowHost || !shadowHost.shadowRoot) {
        throw new Error('Expected shadow host with open ShadowRoot inside <dialog id="agentic-app">');
    }
    const shadowRoot = shadowHost.shadowRoot;
    const consoleEl = shadowRoot.querySelector('.ag-console') as HTMLDivElement | null;
    if (!consoleEl) {
        throw new Error('Expected .ag-console inside ShadowRoot');
    }
    return { dialog, shadowHost, shadowRoot, consoleEl };
}

function assertTouchTargetsAndTypography(shadowRoot: ShadowRoot, contextLabel: string): void {
    const buttons = Array.from(
        shadowRoot.querySelectorAll('button, [role="switch"], [role="radio"]'),
    ).filter(isElementVisible);
    expect(buttons.length, `${contextLabel}: expected visible interactive controls`).toBeGreaterThan(0);

    for (const el of buttons) {
        const rect = el.getBoundingClientRect();
        const label =
            el.getAttribute('aria-label')
            || el.textContent?.trim()
            || el.className
            || el.tagName;
        expect(
            rect.width,
            `${contextLabel}: control "${label}" width (${rect.width}px) must be >= 40px`,
        ).toBeGreaterThanOrEqual(40);
        expect(
            rect.height,
            `${contextLabel}: control "${label}" height (${rect.height}px) must be >= 40px`,
        ).toBeGreaterThanOrEqual(40);
    }

    const formEls = Array.from(
        shadowRoot.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]), select, textarea'),
    ).filter(isElementVisible);

    for (const el of formEls) {
        const computedFontSize = parseFloat(window.getComputedStyle(el).fontSize);
        const label =
            el.getAttribute('aria-label')
            || el.getAttribute('placeholder')
            || el.id
            || el.tagName;
        expect(
            computedFontSize,
            `${contextLabel}: form field "${label}" fontSize (${computedFontSize}px) must be >= 16px`,
        ).toBeGreaterThanOrEqual(16);
    }
}

function assertNoHorizontalOverflow(
    dialog: HTMLDialogElement,
    shadowRoot: ShadowRoot,
    contextLabel: string,
): void {
    const selectors = [
        '[data-agentic-mount]',
        '.ag-console',
        '.ag-body',
        '.ag-main',
        '.ag-ast-root',
        '.ag-ast-topbar',
        '.ag-ast-thread',
        '.ag-ast-composer-wrap',
    ];
    expect(
        dialog.scrollWidth,
        `${contextLabel}: horizontal overflow on dialog#agentic-app`,
    ).toBeLessThanOrEqual(dialog.clientWidth + 1);

    for (const selector of selectors) {
        for (const el of Array.from(shadowRoot.querySelectorAll(selector))) {
            if (isElementVisible(el)) {
                expect(
                    el.scrollWidth,
                    `${contextLabel}: horizontal overflow on ${selector} (${el.scrollWidth} > ${el.clientWidth})`,
                ).toBeLessThanOrEqual(el.clientWidth + 1);
            }
        }
    }
}

interface MockAssistantController {
    bridge: AssistantRuntimeBridge;
    sessions: AssistantSession[];
    approvals: PendingApproval[];
    undoRecords: UndoRecord[];
    updateSessionConfigSpy: Mock<(...args: unknown[]) => void>;
    sendPromptSpy: Mock<(...args: unknown[]) => void>;
    editMessageSpy: Mock<(...args: unknown[]) => void>;
    editAndResendMessageSpy: Mock<(...args: unknown[]) => void>;
    retractMessageSpy: Mock<(...args: unknown[]) => void>;
    regenerateLastMessageSpy: Mock<(...args: unknown[]) => void>;
    continueLastMessageSpy: Mock<(...args: unknown[]) => void>;
    abortSpy: Mock<(...args: unknown[]) => void>;
    decideApprovalSpy: Mock<(...args: unknown[]) => void>;
    retryApprovalSpy: Mock<(...args: unknown[]) => void>;
    applyUndoSpy: Mock<(...args: unknown[]) => void>;
    nextSendDeferred: Deferred<AssistantMessage | void> | null;
    lastSendOptions: {
        attachments?: AssistantAttachment[];
        onDelta?: (delta: string) => void;
        onRetry?: (status: AssistantRetryStatus) => void;
        onUpdate?: (session: AssistantSession) => void;
        signal?: AbortSignal;
    } | null;
}

function createMockAssistantRuntime(options: {
    sessions?: AssistantSession[];
    approvals?: PendingApproval[];
    undoRecords?: UndoRecord[];
} = {}): MockAssistantController {
    const baseSession: AssistantSession = structuredClone(SAMPLE_ASSISTANT_SESSION);
    const secondSession: AssistantSession = {
        id: 'ast_session_2',
        title: '雾港剧情诊断与线索核查',
        mode: 'chat',
        stAdminEnabled: false,
        autoApproveAuthor: false,
        connectionId: 'conn_flash',
        updatedAt: 1732327000000,
        messages: [
            {
                id: 'ast_s2_msg_1',
                role: 'user',
                content: '检查当前主连接与 ST 设置中的认证状态。',
                timestamp: 1732326900000,
            },
            {
                id: 'ast_s2_msg_2',
                role: 'assistant',
                content: '已核查当前连接配置，敏感凭证均已自动脱敏为 ***REDACTED***。',
                think: '调用 agentic_read_traces 与 st_settings_read 并确认脱敏生效。',
                toolCalls: [
                    {
                        id: 'call_redacted_1',
                        name: 'st_settings_read',
                        scopeLabel: 'ST Settings',
                        status: 'ok',
                        durationMs: 14,
                        argsSummary: '{"scope":"power_user"}',
                        resultSummary: '{"apiKey":"***REDACTED***","Authorization":"Bearer ***REDACTED***","fast_ui_mode":true}',
                        hasSecretRedaction: true,
                    },
                ],
                timestamp: 1732327000000,
            },
        ],
    };

    const defaultApprovals: PendingApproval[] = [
        structuredClone(SAMPLE_PENDING_AUTHOR_APPROVAL),
        {
            ...structuredClone(SAMPLE_PENDING_ADMIN_APPROVAL),
            sessionId: baseSession.id,
            messageId: 'ast_msg_2',
        },
    ];

    // Attach both approvals to ast_msg_2 in baseSession so both medium & mandatoryConfirm render inline.
    if (baseSession.messages[1]) {
        baseSession.messages[1].approvalIds = [
            SAMPLE_PENDING_AUTHOR_APPROVAL.id,
            SAMPLE_PENDING_ADMIN_APPROVAL.id,
        ];
    }

    const sessions = options.sessions
        ? structuredClone(options.sessions)
        : [baseSession, secondSession];
    const approvals = options.approvals
        ? structuredClone(options.approvals)
        : defaultApprovals;
    const undoRecords = options.undoRecords
        ? structuredClone(options.undoRecords)
        : [structuredClone(SAMPLE_UNDO_RECORD)];

    const controller: MockAssistantController = {
        bridge: null as unknown as AssistantRuntimeBridge,
        sessions,
        approvals,
        undoRecords,
        updateSessionConfigSpy: vi.fn(),
        sendPromptSpy: vi.fn(),
        editMessageSpy: vi.fn(),
        editAndResendMessageSpy: vi.fn(),
        retractMessageSpy: vi.fn(),
        regenerateLastMessageSpy: vi.fn(),
        continueLastMessageSpy: vi.fn(),
        abortSpy: vi.fn(),
        decideApprovalSpy: vi.fn(),
        retryApprovalSpy: vi.fn(),
        applyUndoSpy: vi.fn(),
        nextSendDeferred: null,
        lastSendOptions: null,
    };

    const bridge: AssistantRuntimeBridge = {
        listSessions: () => structuredClone(controller.sessions),
        getSession: (sessionId) => {
            const found = controller.sessions.find((s) => s.id === sessionId);
            return found ? structuredClone(found) : null;
        },
        createSession: async (createOpts) => {
            const created: AssistantSession = {
                id: `ast_created_${controller.sessions.length + 1}`,
                title: createOpts?.title ?? `新建助手会话 ${controller.sessions.length + 1}`,
                mode: createOpts?.mode ?? 'chat',
                stAdminEnabled: Boolean(createOpts?.stAdminEnabled),
                autoApproveAuthor: Boolean(createOpts?.autoApproveAuthor),
                autoApproveChatDelete: Boolean(createOpts?.autoApproveChatDelete),
                connectionId: createOpts?.connectionId ?? 'inherit',
                updatedAt: Date.now(),
                messages: [],
            };
            controller.sessions.unshift(created);
            return structuredClone(created);
        },
        deleteSession: async (sessionId) => {
            const idx = controller.sessions.findIndex((s) => s.id === sessionId);
            if (idx >= 0) {
                controller.sessions.splice(idx, 1);
                return true;
            }
            return false;
        },
        updateSessionConfig: async (sessionId, patch) => {
            controller.updateSessionConfigSpy(sessionId, patch);
            const idx = controller.sessions.findIndex((s) => s.id === sessionId);
            if (idx < 0) {
                return null;
            }
            controller.sessions[idx] = {
                ...controller.sessions[idx],
                ...patch,
                updatedAt: Date.now(),
            };
            return structuredClone(controller.sessions[idx]);
        },
        sendPrompt: async (sessionId, prompt, sendOpts) => {
            controller.sendPromptSpy(sessionId, prompt, sendOpts);
            controller.lastSendOptions = sendOpts ?? null;

            const target = controller.sessions.find((s) => s.id === sessionId);
            if (target) {
                target.messages.push({
                    id: `user_${Date.now()}_${target.messages.length}`,
                    role: 'user',
                    content: prompt,
                    ...(sendOpts?.attachments?.length
                        ? { attachments: structuredClone(sendOpts.attachments) }
                        : {}),
                    timestamp: Date.now(),
                });
                sendOpts?.onUpdate?.(structuredClone(target));
            }

            if (controller.nextSendDeferred) {
                const deferred = controller.nextSendDeferred;
                controller.nextSendDeferred = null;
                const resolved = await deferred.promise;
                if (resolved && target && !target.messages.some((m) => m.id === resolved.id)) {
                    target.messages.push(resolved);
                    target.updatedAt = Date.now();
                }
                return resolved;
            }

            const reply: AssistantMessage = {
                id: `ast_reply_${Date.now()}`,
                role: 'assistant',
                content: `已处理指令：${prompt}`,
                timestamp: Date.now(),
            };
            if (target) {
                target.messages.push(reply);
            }
            return reply;
        },
        editMessage: async (sessionId, messageId, newContent) => {
            controller.editMessageSpy(sessionId, messageId, newContent);
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (!target) {
                return null;
            }
            const msg = target.messages.find((m) => m.id === messageId);
            if (!msg) {
                return null;
            }
            msg.content = newContent;
            if (msg.interrupted) {
                msg.interrupted = false;
            }
            target.updatedAt = Date.now();
            return structuredClone(target);
        },
        editAndResendMessage: async (sessionId, messageId, newContent, sendOpts) => {
            controller.editAndResendMessageSpy(sessionId, messageId, newContent, sendOpts);
            controller.lastSendOptions = sendOpts ?? null;
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (!target) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const idx = target.messages.findIndex((m) => m.id === messageId);
            if (idx < 0) {
                throw new Error(`Message not found: ${messageId}`);
            }
            target.messages[idx].content = newContent;
            const removed = target.messages.slice(idx + 1);
            target.messages = target.messages.slice(0, idx + 1);
            const removedIds = new Set(removed.map((m) => m.id));
            for (let i = controller.approvals.length - 1; i >= 0; i -= 1) {
                if (removedIds.has(controller.approvals[i].messageId)) {
                    controller.approvals.splice(i, 1);
                }
            }
            sendOpts?.onUpdate?.(structuredClone(target));

            if (controller.nextSendDeferred) {
                const deferred = controller.nextSendDeferred;
                controller.nextSendDeferred = null;
                const resolved = await deferred.promise;
                if (resolved && !target.messages.some((m) => m.id === resolved.id)) {
                    target.messages.push(resolved);
                }
                return resolved;
            }

            const reply: AssistantMessage = {
                id: `ast_resent_${Date.now()}`,
                role: 'assistant',
                content: `改写重发响应：${newContent}`,
                timestamp: Date.now(),
            };
            target.messages.push(reply);
            return reply;
        },
        retractMessage: async (sessionId, messageId) => {
            controller.retractMessageSpy(sessionId, messageId);
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (!target) {
                return null;
            }
            const idx = target.messages.findIndex((m) => m.id === messageId);
            if (idx < 0) {
                return null;
            }
            const removedMessages = structuredClone(target.messages.slice(idx));
            target.messages = target.messages.slice(0, idx);
            target.updatedAt = Date.now();
            const removedIds = new Set(removedMessages.map((m) => m.id));
            for (let i = controller.approvals.length - 1; i >= 0; i -= 1) {
                if (removedIds.has(controller.approvals[i].messageId)) {
                    controller.approvals.splice(i, 1);
                }
            }
            return {
                session: structuredClone(target),
                removedMessages,
            };
        },
        regenerateLastMessage: async (sessionId, sendOpts) => {
            controller.regenerateLastMessageSpy(sessionId, sendOpts);
            controller.lastSendOptions = sendOpts ?? null;
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (!target) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            let lastUserIdx = -1;
            for (let i = target.messages.length - 1; i >= 0; i -= 1) {
                if (target.messages[i].role === 'user') {
                    lastUserIdx = i;
                    break;
                }
            }
            if (lastUserIdx < 0) {
                throw new Error('No user message available to regenerate.');
            }
            const userMsg = target.messages[lastUserIdx];
            const removed = target.messages.slice(lastUserIdx + 1);
            target.messages = target.messages.slice(0, lastUserIdx + 1);
            const removedIds = new Set(removed.map((m) => m.id));
            for (let i = controller.approvals.length - 1; i >= 0; i -= 1) {
                if (removedIds.has(controller.approvals[i].messageId)) {
                    controller.approvals.splice(i, 1);
                }
            }
            sendOpts?.onUpdate?.(structuredClone(target));

            if (controller.nextSendDeferred) {
                const deferred = controller.nextSendDeferred;
                controller.nextSendDeferred = null;
                const resolved = await deferred.promise;
                if (resolved && !target.messages.some((m) => m.id === resolved.id)) {
                    target.messages.push(resolved);
                }
                return resolved;
            }

            const reply: AssistantMessage = {
                id: `ast_regen_${Date.now()}`,
                role: 'assistant',
                content: `重新生成响应：${userMsg.content}`,
                timestamp: Date.now(),
            };
            target.messages.push(reply);
            return reply;
        },
        continueLastMessage: async (sessionId, sendOpts) => {
            controller.continueLastMessageSpy(sessionId, sendOpts);
            controller.lastSendOptions = sendOpts ?? null;
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (!target) {
                throw new Error(`Session not found: ${sessionId}`);
            }

            if (controller.nextSendDeferred) {
                const deferred = controller.nextSendDeferred;
                controller.nextSendDeferred = null;
                sendOpts?.onUpdate?.(structuredClone(target));
                const resolved = await deferred.promise;
                if (resolved && resolved.role === 'assistant') {
                    const idx = target.messages.findIndex((m) => m.id === resolved.id);
                    if (idx >= 0) {
                        target.messages[idx] = structuredClone(resolved);
                    } else {
                        target.messages.push(structuredClone(resolved));
                    }
                    delete target.interruptedCheckpoint;
                    target.updatedAt = Date.now();
                    sendOpts?.onUpdate?.(structuredClone(target));
                }
                return resolved;
            }

            const lastMsg = target.messages[target.messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
                const base = lastMsg.content.startsWith('[Error] ')
                    ? ''
                    : lastMsg.content.replace(/\n\n\[Error\] [\s\S]*$/, '');
                lastMsg.content = `${base}${base ? '\n\n' : ''}继续完成后的最终答复。`;
                delete lastMsg.interrupted;
                delete lastMsg.errorCode;
                delete lastMsg.errorMessage;
                delete lastMsg.canContinue;
                delete lastMsg.retryStatus;
                delete target.interruptedCheckpoint;
                target.updatedAt = Date.now();
                sendOpts?.onUpdate?.(structuredClone(target));
                return structuredClone(lastMsg);
            }

            const reply: AssistantMessage = {
                id: `ast_cont_${Date.now()}`,
                role: 'assistant',
                content: '继续执行完成。',
                timestamp: Date.now(),
            };
            target.messages.push(reply);
            target.updatedAt = Date.now();
            sendOpts?.onUpdate?.(structuredClone(target));
            return reply;
        },
        abort: (sessionId) => {
            controller.abortSpy(sessionId);
        },
        listApprovals: () => structuredClone(controller.approvals),
        decideApproval: async (approvalId, decision, feedback) => {
            controller.decideApprovalSpy(approvalId, decision, feedback);
            const idx = controller.approvals.findIndex((item) => item.id === approvalId);
            if (idx < 0) {
                return null;
            }
            const current = controller.approvals[idx];
            if (decision === 'approve') {
                const undoId = `undo_appr_${approvalId}_rev${current.revision}`;
                const nextUndo: UndoRecord = {
                    id: undoId,
                    sessionId: current.sessionId,
                    toolCallId: current.toolCallId,
                    toolName: current.toolName,
                    kind: current.toolName === 'st_settings_patch' ? 'st_setting' : 'worldinfo',
                    label: current.title,
                    scope: current.targetLabel,
                    beforeSummary: '旧状态快照',
                    afterSummary: `已应用第 ${current.revision} 版修改`,
                    snapshot: { approvalId, revision: current.revision },
                    timestamp: Date.now(),
                    reverted: false,
                };
                controller.undoRecords.unshift(nextUndo);
                controller.approvals[idx] = {
                    ...current,
                    status: 'approved',
                    undoId,
                    reverted: false,
                };
            } else {
                controller.approvals[idx] = {
                    ...current,
                    status: 'rejected',
                    rejectionFeedback: feedback,
                };
            }
            return structuredClone(controller.approvals[idx]);
        },
        retryApproval: async (approvalId, feedback) => {
            controller.retryApprovalSpy(approvalId, feedback);
            const idx = controller.approvals.findIndex((item) => item.id === approvalId);
            if (idx < 0) {
                return null;
            }
            const current = controller.approvals[idx];
            const nextRev = (current.revision || 1) + 1;
            const revisedLine = feedback
                ? `+ [第 ${nextRev} 版 · 已按意见修订]: ${feedback}`
                : `+ [第 ${nextRev} 版]: 修订后的安全变更方案`;
            controller.approvals[idx] = {
                ...current,
                revision: nextRev,
                status: 'pending',
                undoId: undefined,
                reverted: false,
                rejectionFeedback: feedback,
                diffLines: [
                    ...current.diffLines,
                    { type: 'add', text: revisedLine },
                ],
                rawContent: `${current.rawContent}\n// rev ${nextRev}${feedback ? `: ${feedback}` : ''}`,
            };
            return structuredClone(controller.approvals[idx]);
        },
        listUndoRecords: () => structuredClone(controller.undoRecords),
        applyUndo: async (undoId) => {
            controller.applyUndoSpy(undoId);
            const rec = controller.undoRecords.find((item) => item.id === undoId);
            if (rec) {
                rec.reverted = true;
            }
            for (const appr of controller.approvals) {
                if (appr.undoId === undoId) {
                    appr.reverted = true;
                }
            }
            return rec ? structuredClone(rec) : true;
        },
        readPreviewFile: async (path) => `只读预览：${path}\napiKey: ***REDACTED***`,
    };

    controller.bridge = bridge;
    return controller;
}

interface MountedAssistantHarness {
    store: AppStore;
    runtime: MockAssistantController;
    shellContainer: HTMLDivElement;
    cleanup: () => void;
}

function mountAssistantHarness(options: {
    initialTab?: 'assistant' | 'files';
    initialSessionId?: string | null;
    initialMobileAssistantStack?: 'list' | 'detail';
    runtime?: MockAssistantController;
} = {}): MountedAssistantHarness {
    const unregisterAssistant = registerAssistantView();
    const runtime = options.runtime ?? createMockAssistantRuntime();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab: options.initialTab ?? 'assistant',
        initialAssistantSessionId:
            options.initialSessionId !== undefined
                ? options.initialSessionId
                : runtime.sessions[0]?.id ?? null,
        initialMobileAssistantStack: options.initialMobileAssistantStack ?? 'list',
        initialAssistantSessions: runtime.sessions,
        initialAssistantPendingApprovals: runtime.approvals,
        initialAssistantUndoStack: runtime.undoRecords,
        services: createMockUIServices(),
        assistantRuntime: runtime.bridge,
    });

    const shellContainer = document.createElement('div');
    shellContainer.setAttribute('data-test-assistant-shell', 'true');
    document.body.appendChild(shellContainer);

    render(
        <AppStoreProvider store={store}>
            <AgenticAppShell store={store} />
        </AppStoreProvider>,
        shellContainer,
    );

    return {
        store,
        runtime,
        shellContainer,
        cleanup: () => {
            render(null, shellContainer);
            shellContainer.remove();
            unregisterAssistant();
            store.dispose();
        },
    };
}

function setInputValue(
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string,
): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Assistant Workbench Dual-Viewport UI Contract (TS4.2)', () => {
    let activeHarness: MountedAssistantHarness | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        vi.restoreAllMocks();
        await page.viewport(1280, 800);
    });

    it('renders unified minimal composer (no shortcut bar / attach chips) with 40x40px send/stop streaming switch on desktop', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();
        const assistantRoot = shadowRoot.querySelector('[data-view-id="assistant"]') as HTMLDivElement;
        expect(assistantRoot).toBeTruthy();

        // 1. Verify NO shortcut command bar and NO manual "attach context" chips exist.
        const composerWrap = shadowRoot.querySelector('[data-assistant-composer="true"]') as HTMLDivElement;
        expect(composerWrap).toBeTruthy();
        expect(composerWrap.textContent).not.toContain('快捷指令');
        expect(composerWrap.textContent).not.toContain('附带上下文');
        expect(composerWrap.textContent).not.toContain('附加当前聊天');
        expect(assistantRoot.querySelector('[data-shortcut-bar], [data-attach-context], .ag-ast-shortcuts, .ag-ast-attach-chips')).toBeNull();

        // Composer bar contains strictly: mode button, model button, upload button, and send/stop button.
        const composerBarButtons = Array.from(
            composerWrap.querySelectorAll('.ag-ast-composer-bar button'),
        );
        expect(composerBarButtons.length).toBe(4);

        const modeBtn = composerWrap.querySelector('[data-assistant-mode-btn="true"]') as HTMLButtonElement;
        const modelBtn = composerWrap.querySelector('[data-assistant-model-btn="true"]') as HTMLButtonElement;
        const uploadBtn = composerWrap.querySelector('[data-assistant-upload-btn="true"]') as HTMLButtonElement;
        const sendBtn = composerWrap.querySelector('[data-assistant-send-btn="true"]') as HTMLButtonElement;
        const draftInput = composerWrap.querySelector('textarea[data-assistant-draft-input="true"]') as HTMLTextAreaElement;

        expect(modeBtn).toBeTruthy();
        expect(modelBtn).toBeTruthy();
        expect(uploadBtn).toBeTruthy();
        expect(sendBtn).toBeTruthy();
        expect(draftInput).toBeTruthy();
        expect(sendBtn.querySelector('svg')).toBeTruthy();
        const uploadRect = uploadBtn.getBoundingClientRect();
        expect(Math.round(uploadRect.width)).toBe(40);
        expect(Math.round(uploadRect.height)).toBe(40);

        // Compact 40x40px send button & >=16px textarea
        const sendRect = sendBtn.getBoundingClientRect();
        expect(Math.round(sendRect.width)).toBe(40);
        expect(Math.round(sendRect.height)).toBe(40);
        expect(parseFloat(window.getComputedStyle(draftInput).fontSize)).toBeGreaterThanOrEqual(16);

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:assistant:idle');
        assertTouchTargetsAndTypography(shadowRoot, 'desktop:assistant:idle');

        // 2. Send prompt -> switches ▶ to 40x40px ■ while streaming -> streams delta -> abort restores ▶.
        const deferred = createDeferred<AssistantMessage | void>();
        activeHarness.runtime.nextSendDeferred = deferred;

        setInputValue(draftInput, '请排查主世界书中的重复触发词');
        await settleLayout(2);
        sendBtn.click();
        await settleLayout(4);

        expect(activeHarness.runtime.sendPromptSpy).toHaveBeenCalledTimes(1);
        expect(composerWrap.querySelector('[data-assistant-send-btn="true"]')).toBeNull();

        const stopBtn = composerWrap.querySelector('[data-assistant-stop-btn="true"]') as HTMLButtonElement;
        expect(stopBtn).toBeTruthy();
        expect(stopBtn.querySelector('svg')).toBeTruthy();
        const stopRect = stopBtn.getBoundingClientRect();
        expect(Math.round(stopRect.width)).toBe(40);
        expect(Math.round(stopRect.height)).toBe(40);

        // Emit live streaming delta and verify synthetic streaming bubble
        activeHarness.runtime.lastSendOptions?.onDelta?.('正在扫描主世界书条目...');
        await settleLayout(3);
        expect(shadowRoot.querySelector('.ag-ast-streaming-cursor')).toBeTruthy();
        expect(shadowRoot.textContent).toContain('正在扫描主世界书条目...');

        // Click ■ to abort streaming
        const abortSignal = activeHarness.runtime.lastSendOptions?.signal;
        expect(abortSignal?.aborted).toBe(false);
        stopBtn.click();
        deferred.resolve(undefined);
        await settleLayout(4);

        expect(abortSignal?.aborted).toBe(true);
        expect(activeHarness.runtime.abortSpy).toHaveBeenCalledWith('ast_session_1');
        expect(composerWrap.querySelector('[data-assistant-stop-btn="true"]')).toBeNull();
        const restoredSendBtn = composerWrap.querySelector('[data-assistant-send-btn="true"]') as HTMLButtonElement;
        expect(restoredSendBtn).toBeTruthy();
        expect(restoredSendBtn.querySelector('svg')).toBeTruthy();
    });

    it('switches across all 4 modes, toggles autoApproveAuthor, and confirms ST 全权管家 inside Shadow DOM without window.confirm', async () => {
        await page.viewport(1280, 800);
        const windowConfirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const getModeBtn = () =>
            shadowRoot.querySelector('[data-assistant-mode-btn="true"]') as HTMLButtonElement;

        // Open mode popover
        getModeBtn().click();
        await settleLayout(3);

        const popover = shadowRoot.querySelector('[data-assistant-popover="mode"]') as HTMLDivElement;
        expect(popover).toBeTruthy();
        expect(popover.querySelectorAll('[data-assistant-mode-option]').length).toBe(4);

        // Switch through chat -> adjust -> author -> full
        (popover.querySelector('[data-assistant-mode-option="chat"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'chat', stAdminEnabled: false },
        );
        expect(getModeBtn().textContent).toContain('交流');

        // Popover closes on chat; reopen to select adjust
        getModeBtn().click();
        await settleLayout(3);
        (shadowRoot.querySelector('[data-assistant-mode-option="adjust"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'adjust', stAdminEnabled: false },
        );
        expect(getModeBtn().textContent).toContain('调整');

        // Selecting adjust keeps popover open and exposes autoApproveChatDelete checkbox (unchecked by default)
        const chatDeleteCheckbox = shadowRoot.querySelector(
            'input[data-assistant-auto-approve-chat-delete-checkbox="true"]',
        ) as HTMLInputElement;
        expect(chatDeleteCheckbox).toBeTruthy();
        expect(chatDeleteCheckbox.checked).toBe(false);
        expect(shadowRoot.querySelector('input[data-assistant-auto-approve-checkbox="true"]')).toBeNull();

        // Toggle autoApproveChatDelete ON
        chatDeleteCheckbox.click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { autoApproveChatDelete: true },
        );
        expect(
            (
                shadowRoot.querySelector(
                    'input[data-assistant-auto-approve-chat-delete-checkbox="true"]',
                ) as HTMLInputElement
            ).checked,
        ).toBe(true);

        // Switch directly to author (popover stayed open) -> exposes autoApproveAuthor checkbox and hides chat-delete checkbox
        (shadowRoot.querySelector('[data-assistant-mode-option="author"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'author', stAdminEnabled: false },
        );
        expect(
            shadowRoot.querySelector('input[data-assistant-auto-approve-chat-delete-checkbox="true"]'),
        ).toBeNull();

        const autoApproveCheckbox = shadowRoot.querySelector(
            'input[data-assistant-auto-approve-checkbox="true"]',
        ) as HTMLInputElement;
        expect(autoApproveCheckbox).toBeTruthy();
        expect(autoApproveCheckbox.checked).toBe(false);
        expect(shadowRoot.querySelector('[data-assistant-st-admin-toggle="true"]')).toBeNull();

        // Toggle autoApproveAuthor ON
        autoApproveCheckbox.click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { autoApproveAuthor: true },
        );
        expect(
            (shadowRoot.querySelector('input[data-assistant-auto-approve-checkbox="true"]') as HTMLInputElement).checked,
        ).toBe(true);

        // Switch to full -> exposes 🛡️ ST 全权管家 toggle
        (shadowRoot.querySelector('[data-assistant-mode-option="full"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'full' },
        );

        const stAdminToggle = shadowRoot.querySelector(
            '[data-assistant-st-admin-toggle="true"]',
        ) as HTMLButtonElement;
        expect(stAdminToggle).toBeTruthy();
        expect(stAdminToggle.textContent).toContain('🛡️ ST 全权管家');

        // Click ST 全权管家 -> opens in-Shadow-DOM secondary confirmation modal (zero window.confirm)
        stAdminToggle.click();
        await settleLayout(3);
        expect(windowConfirmSpy).not.toHaveBeenCalled();

        const confirmModal = shadowRoot.querySelector('[data-assistant-st-admin-modal="true"]') as HTMLDivElement;
        expect(confirmModal).toBeTruthy();
        expect(isElementVisible(confirmModal)).toBe(true);
        expect(confirmModal.textContent).toContain('***REDACTED***');

        const confirmBtn = shadowRoot.querySelector(
            '[data-assistant-st-admin-confirm="true"]',
        ) as HTMLButtonElement;
        expect(confirmBtn).toBeTruthy();
        confirmBtn.click();
        await settleLayout(4);

        expect(windowConfirmSpy).not.toHaveBeenCalled();
        expect(shadowRoot.querySelector('[data-assistant-st-admin-modal="true"]')).toBeNull();
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { stAdminEnabled: true },
        );
        expect(getModeBtn().textContent).toContain('⚡ 管家');

        // Model popover switches connection
        const modelBtn = shadowRoot.querySelector('[data-assistant-model-btn="true"]') as HTMLButtonElement;
        modelBtn.click();
        await settleLayout(3);
        const modelPopover = shadowRoot.querySelector('[data-assistant-popover="model"]') as HTMLDivElement;
        expect(modelPopover).toBeTruthy();
        const flashOption = modelPopover.querySelector(
            '[data-assistant-model-option="conn_flash"]',
        ) as HTMLButtonElement;
        expect(flashOption).toBeTruthy();
        flashOption.click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { connectionId: 'conn_flash' },
        );
        expect(modelBtn.textContent).toContain('Gemini Flash');
    });

    it('enforces Mobile (390x844) contract: list view shows header/nav, detail view hides both, ← restores immediately, >=40x40px targets & >=16px textarea', async () => {
        await page.viewport(390, 844);
        activeHarness = mountAssistantHarness({ initialTab: 'files' });
        await settleLayout(5);

        const { dialog, shadowRoot, consoleEl } = getShellElements();

        // 1. Switch to 'assistant' via mobile tab nav -> lands in 'list' view with header & mobile nav visible
        const assistantMobileTab = shadowRoot.querySelector(
            '.ag-mobile-nav button[data-tab-id="assistant"]',
        ) as HTMLButtonElement;
        expect(assistantMobileTab).toBeTruthy();
        assistantMobileTab.click();
        await settleLayout(5);

        expect(activeHarness.store.getSnapshot().activeTab).toBe('assistant');
        expect(activeHarness.store.getSnapshot().mobileAssistantStack).toBe('list');
        expect(consoleEl.getAttribute('data-mobile-chrome-hidden')).toBe('false');
        expect(shadowRoot.querySelector('[data-assistant-mobile-view="list"]')).toBeTruthy();

        const headerInList = shadowRoot.querySelector('.ag-header');
        const mobileNavInList = shadowRoot.querySelector('.ag-mobile-nav');
        expect(isElementVisible(headerInList)).toBe(true);
        expect(isElementVisible(mobileNavInList)).toBe(true);

        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:assistant:list');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:assistant:list');

        // 2. Click a session -> enters 'detail' view (openAssistantSession), COMPLETELY HIDING header & mobile nav
        const sessionSelectBtn = shadowRoot.querySelector(
            '[data-assistant-session-select="ast_session_1"]',
        ) as HTMLButtonElement;
        expect(sessionSelectBtn).toBeTruthy();
        sessionSelectBtn.click();
        await settleLayout(5);

        expect(activeHarness.store.getSnapshot().mobileAssistantStack).toBe('detail');
        expect(activeHarness.store.getSnapshot().selectedAssistantSessionId).toBe('ast_session_1');
        expect(consoleEl.getAttribute('data-mobile-chrome-hidden')).toBe('true');
        expect(shadowRoot.querySelector('[data-assistant-mobile-view="detail"]')).toBeTruthy();
        expect(shadowRoot.querySelector('.ag-header')).toBeNull();
        expect(shadowRoot.querySelector('.ag-mobile-nav')).toBeNull();

        // Verify mobile detail touch targets >= 40x40px, textarea font-size >= 16px, and zero overflow
        const mobileTextarea = shadowRoot.querySelector(
            'textarea[data-assistant-draft-input="true"]',
        ) as HTMLTextAreaElement;
        expect(mobileTextarea).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(mobileTextarea).fontSize)).toBeGreaterThanOrEqual(16);

        const mobileSendBtn = shadowRoot.querySelector(
            '[data-assistant-send-btn="true"]',
        ) as HTMLButtonElement;
        expect(mobileSendBtn).toBeTruthy();
        const mobileSendRect = mobileSendBtn.getBoundingClientRect();
        expect(mobileSendRect.width).toBeGreaterThanOrEqual(40);
        expect(mobileSendRect.height).toBeGreaterThanOrEqual(40);

        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:assistant:detail');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:assistant:detail');

        // 3. Click ← (backToAssistantList) -> returns to 'list' and IMMEDIATELY restores header & mobile nav
        const backBtn = shadowRoot.querySelector(
            'button[data-assistant-back-btn="true"]',
        ) as HTMLButtonElement;
        expect(backBtn).toBeTruthy();
        expect(backBtn.textContent?.trim()).toBe('←');
        backBtn.click();
        await settleLayout(5);

        expect(activeHarness.store.getSnapshot().mobileAssistantStack).toBe('list');
        expect(consoleEl.getAttribute('data-mobile-chrome-hidden')).toBe('false');
        expect(shadowRoot.querySelector('[data-assistant-mobile-view="list"]')).toBeTruthy();
        expect(isElementVisible(shadowRoot.querySelector('.ag-header'))).toBe(true);
        expect(isElementVisible(shadowRoot.querySelector('.ag-mobile-nav'))).toBe(true);
    });

    it('executes full inline AI-bubble approval state machine (Diff/原文, 🔒 强制确认, 拒绝 -> 重试 -> 接受 auto-collapse -> inline & modal 撤销)', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        const { shadowRoot } = getShellElements();

        // Both medium-risk author approval and mandatoryConfirm high-risk approval render inside ast_msg_2
        const authorCard = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_AUTHOR_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        const adminCard = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        expect(authorCard).toBeTruthy();
        expect(adminCard).toBeTruthy();

        // 🔒 强制确认 badge ONLY on mandatoryConfirm item
        expect(authorCard.querySelector('[data-approval-mandatory="true"]')).toBeNull();
        const mandatoryBadge = adminCard.querySelector('[data-approval-mandatory="true"]');
        expect(mandatoryBadge).toBeTruthy();
        expect(mandatoryBadge!.textContent).toContain('🔒 强制确认');

        // 1. Diff / 原文 toggle on author approval card
        expect(authorCard.querySelector('[data-approval-diff="true"]')).toBeTruthy();
        expect(authorCard.querySelector('[data-approval-raw="true"]')).toBeNull();

        (authorCard.querySelector('[data-approval-view-tab="raw"]') as HTMLButtonElement).click();
        await settleLayout(3);
        const rawPreview = authorCard.querySelector('[data-approval-raw="true"]') as HTMLPreElement;
        expect(rawPreview).toBeTruthy();
        expect(rawPreview.textContent).toContain('@@system');
        expect(rawPreview.textContent).toContain('<% if (getvar("heat") > 5) { %>');

        (authorCard.querySelector('[data-approval-view-tab="diff"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(authorCard.querySelector('[data-approval-diff="true"]')).toBeTruthy();

        // 2. Reject mandatoryConfirm approval -> auto-collapses to compact single-line bar
        const feedbackInput = adminCard.querySelector(
            `input[data-approval-feedback-input="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLInputElement;
        setInputValue(feedbackInput, '请保留 fast_ui_mode 注释');
        await settleLayout(2);

        const rejectBtn = adminCard.querySelector(
            `[data-approval-reject-btn="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLButtonElement;
        rejectBtn.click();
        await settleLayout(5);

        expect(activeHarness.runtime.decideApprovalSpy).toHaveBeenCalledWith(
            SAMPLE_PENDING_ADMIN_APPROVAL.id,
            'reject',
            '请保留 fast_ui_mode 注释',
        );

        const collapsedRejected = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        expect(collapsedRejected.getAttribute('data-approval-status')).toBe('rejected');
        expect(collapsedRejected.getAttribute('data-approval-collapsed')).toBe('true');
        expect(collapsedRejected.classList.contains('ag-ast-approval-collapsed')).toBe(true);
        expect(collapsedRejected.textContent).toContain(`已拒绝：${SAMPLE_PENDING_ADMIN_APPROVAL.title}`);

        // 3. Retry from collapsed rejected bar -> expands with revision 2 revised diff
        const retryBtn = collapsedRejected.querySelector(
            `[data-approval-retry-btn="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLButtonElement;
        expect(retryBtn).toBeTruthy();
        retryBtn.click();
        await settleLayout(5);

        expect(activeHarness.runtime.retryApprovalSpy).toHaveBeenCalledWith(
            SAMPLE_PENDING_ADMIN_APPROVAL.id,
            undefined,
        );

        const expandedRetried = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        expect(expandedRetried.getAttribute('data-approval-status')).toBe('pending');
        expect(expandedRetried.getAttribute('data-approval-collapsed')).toBe('false');
        expect(expandedRetried.textContent).toContain('第 2 版');
        expect(expandedRetried.querySelector('[data-approval-diff="true"]')?.textContent).toContain(
            '修订后的安全变更方案',
        );

        // 4. Approve revised card -> executes & AUTO-COLLAPSES back to single compact status line (✓ 已接受：...)
        const approveBtn = expandedRetried.querySelector(
            `[data-approval-approve-btn="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLButtonElement;
        expect(approveBtn).toBeTruthy();
        approveBtn.click();
        await settleLayout(5);

        expect(activeHarness.runtime.decideApprovalSpy).toHaveBeenCalledWith(
            SAMPLE_PENDING_ADMIN_APPROVAL.id,
            'approve',
            undefined,
        );

        const collapsedApproved = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        expect(collapsedApproved.getAttribute('data-approval-status')).toBe('approved');
        expect(collapsedApproved.getAttribute('data-approval-collapsed')).toBe('true');
        expect(collapsedApproved.classList.contains('ag-ast-approval-collapsed')).toBe(true);
        expect(collapsedApproved.textContent).toContain('✓');
        expect(collapsedApproved.textContent).toContain(`已接受：${SAMPLE_PENDING_ADMIN_APPROVAL.title}`);

        // 5. Inline ↩ 撤销 on the collapsed accepted card calls applyUndo and marks reverted
        const inlineUndoBtn = collapsedApproved.querySelector(
            `[data-approval-undo-btn="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLButtonElement;
        expect(inlineUndoBtn).toBeTruthy();
        expect(inlineUndoBtn.textContent?.trim()).toBe('↩ 撤销');
        inlineUndoBtn.click();
        await settleLayout(5);

        const expectedApprovedUndoId = `undo_appr_${SAMPLE_PENDING_ADMIN_APPROVAL.id}_rev2`;
        expect(activeHarness.runtime.applyUndoSpy).toHaveBeenCalledWith(expectedApprovedUndoId);
        const revertedCard = shadowRoot.querySelector(
            `[data-approval-id="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLDivElement;
        expect(revertedCard.textContent).toContain(`已还原：${SAMPLE_PENDING_ADMIN_APPROVAL.title}`);
        const disabledInlineUndo = revertedCard.querySelector(
            `[data-approval-undo-btn="${SAMPLE_PENDING_ADMIN_APPROVAL.id}"]`,
        ) as HTMLButtonElement;
        expect(disabledInlineUndo.disabled).toBe(true);

        // 6. Undo via UndoHistoryModal for pre-existing SAMPLE_UNDO_RECORD
        const topbarUndoBtn = shadowRoot.querySelector(
            '[data-assistant-undo-btn="true"]',
        ) as HTMLButtonElement;
        expect(topbarUndoBtn).toBeTruthy();
        topbarUndoBtn.click();
        await settleLayout(4);

        const undoModal = shadowRoot.querySelector('[data-assistant-undo-modal="true"]') as HTMLDivElement;
        expect(undoModal).toBeTruthy();
        const modalUndoBtn = undoModal.querySelector(
            `[data-undo-apply-btn="${SAMPLE_UNDO_RECORD.id}"]`,
        ) as HTMLButtonElement;
        expect(modalUndoBtn).toBeTruthy();
        expect(modalUndoBtn.disabled).toBe(false);
        modalUndoBtn.click();
        await settleLayout(5);

        expect(activeHarness.runtime.applyUndoSpy).toHaveBeenCalledWith(SAMPLE_UNDO_RECORD.id);
        const revertedRecordRow = undoModal.querySelector(
            `[data-undo-record-id="${SAMPLE_UNDO_RECORD.id}"]`,
        ) as HTMLDivElement;
        expect(revertedRecordRow.getAttribute('data-undo-reverted')).toBe('true');
        expect(
            revertedRecordRow.querySelector(`[data-undo-reverted-badge="${SAMPLE_UNDO_RECORD.id}"]`)?.textContent,
        ).toContain('已撤销');
    });

    it('renders 🔒 已脱敏 badge and ***REDACTED*** tokens on redacted tool outputs', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness({ initialSessionId: 'ast_session_2' });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();

        // Collapsed activity bar shows 🔒 已脱敏 badge
        const activityToggle = shadowRoot.querySelector(
            '[data-assistant-activity-toggle="ast_s2_msg_2"]',
        ) as HTMLButtonElement;
        expect(activityToggle).toBeTruthy();
        const activityRedactedBadge = activityToggle.querySelector('[data-redacted-badge="true"]');
        expect(activityRedactedBadge).toBeTruthy();
        expect(activityRedactedBadge!.textContent).toContain('🔒 已脱敏');

        // Bubble content highlights ***REDACTED***
        const bubbleContent = shadowRoot.querySelector(
            '[data-assistant-message-content="ast_s2_msg_2"]',
        ) as HTMLDivElement;
        expect(bubbleContent.querySelector('.ag-redacted-token')?.textContent).toBe('***REDACTED***');

        // Expand activity strip -> expand redacted tool call -> verify 🔒 已脱敏 badge & ***REDACTED*** tokens
        activityToggle.click();
        await settleLayout(3);

        const toolCard = shadowRoot.querySelector(
            '[data-assistant-tool-call="call_redacted_1"]',
        ) as HTMLDivElement;
        expect(toolCard).toBeTruthy();
        expect(toolCard.querySelector('[data-redacted-badge="true"]')?.textContent).toContain('🔒 已脱敏');

        const toolToggle = toolCard.querySelector('.ag-ast-tool-toggle') as HTMLButtonElement;
        toolToggle.click();
        await settleLayout(3);

        const redactedTokens = Array.from(toolCard.querySelectorAll('.ag-redacted-token'));
        expect(redactedTokens.length).toBeGreaterThanOrEqual(2);
        for (const token of redactedTokens) {
            expect(token.textContent).toBe('***REDACTED***');
        }
        expect(toolCard.textContent).not.toContain('sk-proj-');
    });

    it('renders compact hover/tap-only message action bar below messages, supports inline edit/save/resend & Escape guard across desktop and mobile', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = mountAssistantHarness({
                initialMobileAssistantStack: vp.isMobile ? 'detail' : 'list',
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            const msg1Row = shadowRoot.querySelector(
                '[data-assistant-message="ast_msg_1"]',
            ) as HTMLDivElement;
            const msg2Row = shadowRoot.querySelector(
                '[data-assistant-message="ast_msg_2"]',
            ) as HTMLDivElement;
            const msg1Actions = shadowRoot.querySelector(
                '[data-assistant-msg-actions="ast_msg_1"]',
            ) as HTMLDivElement;
            const msg2Actions = shadowRoot.querySelector(
                '[data-assistant-msg-actions="ast_msg_2"]',
            ) as HTMLDivElement;
            expect(msg1Actions, `${vp.label}: expected user action bar`).toBeTruthy();
            expect(msg2Actions, `${vp.label}: expected assistant action bar`).toBeTruthy();

            // Hidden by default when idle (zero wasted space)
            expect(window.getComputedStyle(msg1Actions).display).toBe('none');
            expect(window.getComputedStyle(msg2Actions).display).toBe('none');

            // Regenerate button (🔄) ONLY renders on the last message (ast_msg_2), NOT on ast_msg_1
            expect(msg1Actions.querySelector('[data-msg-action="copy"]')?.textContent?.trim()).toBe('📋');
            expect(msg1Actions.querySelector('[data-msg-action="edit"]')?.textContent?.trim()).toBe('✏️');
            expect(msg1Actions.querySelector('[data-msg-action="retract"]')?.textContent?.trim()).toBe('↩️');
            expect(msg1Actions.querySelector('[data-msg-action="regenerate"]')).toBeNull();

            expect(msg2Actions.querySelector('[data-msg-action="copy"]')?.textContent?.trim()).toBe('📋');
            expect(msg2Actions.querySelector('[data-msg-action="regenerate"]')?.textContent?.trim()).toBe('🔄');
            expect(msg2Actions.querySelector('[data-msg-action="edit"]')?.textContent?.trim()).toBe('✏️');
            expect(msg2Actions.querySelector('[data-msg-action="retract"]')?.textContent?.trim()).toBe('↩️');

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:msg-actions-idle`);
            assertTouchTargetsAndTypography(shadowRoot, `${vp.label}:msg-actions-idle`);

            if (vp.isMobile) {
                // Tap assistant bubble on mobile -> opens action bar with >= 40x40px touch targets
                (msg2Row.querySelector('.ag-ast-bubble-assistant') as HTMLDivElement).click();
                await settleLayout(3);
                expect(msg2Row.getAttribute('data-actions-open')).toBe('true');
                expect(window.getComputedStyle(msg2Actions).display).toBe('flex');
                assertTouchTargetsAndTypography(shadowRoot, 'mobile:msg-actions-open');
            } else {
                // Hover message row on desktop -> reveals sleek 28x28px floating action bar
                const msg2Bubble = msg2Row.querySelector('.ag-ast-bubble-assistant') as HTMLDivElement;
                await userEvent.hover(msg2Bubble);
                await settleLayout(3);
                expect(window.getComputedStyle(msg2Actions).display).toBe('flex');
                const editRect = (
                    msg2Actions.querySelector('[data-msg-action="edit"]') as HTMLButtonElement
                ).getBoundingClientRect();
                expect(Math.round(editRect.width)).toBe(28);
                expect(Math.round(editRect.height)).toBe(28);
            }

            // Click ✏️ on assistant message ast_msg_2 -> verify >=16px textarea & Escape cancels without closing dialog
            (msg2Actions.querySelector('[data-msg-action="edit"]') as HTMLButtonElement).click();
            await settleLayout(4);

            const astEditInput = shadowRoot.querySelector(
                'textarea[data-assistant-edit-input="ast_msg_2"]',
            ) as HTMLTextAreaElement;
            expect(astEditInput).toBeTruthy();
            expect(parseFloat(window.getComputedStyle(astEditInput).fontSize)).toBeGreaterThanOrEqual(16);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:edit-assistant`);
            assertTouchTargetsAndTypography(shadowRoot, `${vp.label}:edit-assistant`);

            astEditInput.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
            );
            await settleLayout(3);
            expect(dialog.open).toBe(true);
            expect(shadowRoot.querySelector('[data-assistant-edit-box="ast_msg_2"]')).toBeNull();

            // Edit assistant message and click 保存改写
            if (vp.isMobile) {
                (msg2Row.querySelector('.ag-ast-bubble-assistant') as HTMLDivElement).click();
                await settleLayout(2);
            } else {
                await userEvent.hover(msg2Row.querySelector('.ag-ast-bubble-assistant') as HTMLDivElement);
                await settleLayout(2);
            }
            (shadowRoot.querySelector(
                '[data-assistant-msg-actions="ast_msg_2"] [data-msg-action="edit"]',
            ) as HTMLButtonElement).click();
            await settleLayout(3);
            const astEditInput2 = shadowRoot.querySelector(
                'textarea[data-assistant-edit-input="ast_msg_2"]',
            ) as HTMLTextAreaElement;
            setInputValue(astEditInput2, '已手动改写后的助手分析内容');
            await settleLayout(2);
            (shadowRoot.querySelector('[data-assistant-edit-save="ast_msg_2"]') as HTMLButtonElement).click();
            await settleLayout(4);

            expect(activeHarness.runtime.editMessageSpy).toHaveBeenCalledWith(
                'ast_session_1',
                'ast_msg_2',
                '已手动改写后的助手分析内容',
            );
            expect(
                shadowRoot.querySelector('[data-assistant-message-content="ast_msg_2"]')?.textContent,
            ).toContain('已手动改写后的助手分析内容');

            // Edit user message ast_msg_1 -> verify 仅保存 & 保存并发送 buttons, and trigger 保存并发送 with streaming ■
            if (vp.isMobile) {
                (msg1Row.querySelector('.ag-ast-bubble-user') as HTMLDivElement).click();
                await settleLayout(2);
            } else {
                await userEvent.hover(msg1Row.querySelector('.ag-ast-bubble-user') as HTMLDivElement);
                await settleLayout(2);
            }
            (shadowRoot.querySelector(
                '[data-assistant-msg-actions="ast_msg_1"] [data-msg-action="edit"]',
            ) as HTMLButtonElement).click();
            await settleLayout(3);

            const userEditInput = shadowRoot.querySelector(
                'textarea[data-assistant-edit-input="ast_msg_1"]',
            ) as HTMLTextAreaElement;
            expect(userEditInput).toBeTruthy();
            expect(shadowRoot.querySelector('[data-assistant-edit-save="ast_msg_1"]')).toBeTruthy();
            const userResendBtn = shadowRoot.querySelector(
                '[data-assistant-edit-resend="ast_msg_1"]',
            ) as HTMLButtonElement;
            expect(userResendBtn).toBeTruthy();

            const deferred = createDeferred<AssistantMessage | void>();
            activeHarness.runtime.nextSendDeferred = deferred;
            setInputValue(userEditInput, '改写后的用户指令：只看人物设定');
            await settleLayout(2);
            userResendBtn.click();
            await settleLayout(4);

            expect(activeHarness.runtime.editAndResendMessageSpy).toHaveBeenCalledTimes(1);
            expect(shadowRoot.querySelector('[data-assistant-stop-btn="true"]')).toBeTruthy();
            activeHarness.runtime.lastSendOptions?.onDelta?.('正在按改写指令输出...');
            await settleLayout(3);
            expect(shadowRoot.textContent).toContain('正在按改写指令输出...');

            deferred.resolve({
                id: 'ast_resent_final',
                role: 'assistant',
                content: '改写后重发完成的响应',
                timestamp: Date.now(),
            });
            await settleLayout(5);
            expect(shadowRoot.querySelector('[data-assistant-send-btn="true"]')).toBeTruthy();
            expect(shadowRoot.textContent).toContain('改写后重发完成的响应');

            if (!vp.isMobile) {
                // Move pointer to bottom-right send button so :hover hides action bars & stays clear of message thread in mobile/later tests.
                const sendBtnAfter = shadowRoot.querySelector(
                    '[data-assistant-send-btn="true"]',
                ) as HTMLElement | null;
                if (sendBtnAfter) {
                    await userEvent.hover(sendBtnAfter);
                    await settleLayout(2);
                    const remainingActionBars = Array.from(
                        shadowRoot.querySelectorAll('.ag-ast-msg-actions'),
                    );
                    for (const bar of remainingActionBars) {
                        expect(window.getComputedStyle(bar).display).toBe('none');
                    }
                }
            }

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('supports instant retract, draft restore, ShadowModal confirm for multi-message retract, and regenerate last message', async () => {
        await page.viewport(1280, 800);
        const windowConfirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        const fourMsgSession: AssistantSession = {
            ...structuredClone(SAMPLE_ASSISTANT_SESSION),
            messages: [
                ...structuredClone(SAMPLE_ASSISTANT_SESSION.messages),
                {
                    id: 'ast_msg_3',
                    role: 'user',
                    content: '第二轮提问：整理时间线',
                    timestamp: 1732328500000,
                },
                {
                    id: 'ast_msg_4',
                    role: 'assistant',
                    content: '第二轮回复：时间线已整理。',
                    timestamp: 1732328600000,
                },
            ],
        };

        const runtime = createMockAssistantRuntime({ sessions: [fourMsgSession] });
        activeHarness = mountAssistantHarness({ runtime });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();

        // 1. Regenerate last assistant message (ast_msg_4) -> switches ▶ to ■ -> updates trailing reply
        const regenDeferred = createDeferred<AssistantMessage | void>();
        activeHarness.runtime.nextSendDeferred = regenDeferred;

        const regenBtn = shadowRoot.querySelector(
            '[data-assistant-msg-actions="ast_msg_4"] [data-msg-action="regenerate"]',
        ) as HTMLButtonElement;
        expect(regenBtn).toBeTruthy();
        regenBtn.click();
        await settleLayout(4);

        expect(activeHarness.runtime.regenerateLastMessageSpy).toHaveBeenCalledTimes(1);
        expect(shadowRoot.querySelector('[data-assistant-stop-btn="true"]')).toBeTruthy();
        activeHarness.runtime.lastSendOptions?.onDelta?.('流式重新生成中...');
        await settleLayout(3);
        expect(shadowRoot.textContent).toContain('流式重新生成中...');

        regenDeferred.resolve({
            id: 'ast_msg_4_v2',
            role: 'assistant',
            content: '这是重新生成后的第二轮回复。',
            timestamp: Date.now(),
        });
        await settleLayout(5);
        expect(shadowRoot.textContent).toContain('这是重新生成后的第二轮回复。');
        expect(shadowRoot.querySelector('[data-assistant-send-btn="true"]')).toBeTruthy();

        // 2. Retract trailing assistant message (ast_msg_4_v2) -> instant, no confirm modal
        (shadowRoot.querySelector(
            '[data-assistant-msg-actions="ast_msg_4_v2"] [data-msg-action="retract"]',
        ) as HTMLButtonElement).click();
        await settleLayout(4);
        expect(activeHarness.runtime.retractMessageSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            'ast_msg_4_v2',
        );
        expect(shadowRoot.querySelector('[data-assistant-message="ast_msg_4_v2"]')).toBeNull();
        expect(shadowRoot.querySelector('.ag-modal')).toBeNull();

        // Now ast_msg_3 (user) is the last message and STILL has 🔄 regenerate!
        expect(
            shadowRoot.querySelector(
                '[data-assistant-msg-actions="ast_msg_3"] [data-msg-action="regenerate"]',
            ),
        ).toBeTruthy();

        // 3. Retract trailing user message (ast_msg_3) -> instant and restores its text to empty composer draft
        (shadowRoot.querySelector(
            '[data-assistant-msg-actions="ast_msg_3"] [data-msg-action="retract"]',
        ) as HTMLButtonElement).click();
        await settleLayout(4);
        expect(activeHarness.runtime.retractMessageSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            'ast_msg_3',
        );
        const composerDraft = shadowRoot.querySelector(
            'textarea[data-assistant-draft-input="true"]',
        ) as HTMLTextAreaElement;
        expect(composerDraft.value).toBe('第二轮提问：整理时间线');

        // 4. Retract earlier user message (ast_msg_1) while ast_msg_2 follows -> wait: (ast_msg_1 + ast_msg_2) is last turn pair!
        // Let's add back a second turn or test confirm modal with a 4-message session:
        setInputValue(composerDraft, '新的第二轮提问');
        await settleLayout(2);
        (shadowRoot.querySelector('[data-assistant-send-btn="true"]') as HTMLButtonElement).click();
        await settleLayout(5);

        // Now session has 4 messages again; retracting ast_msg_1 removes 4 messages -> opens ShadowModal confirm (zero window.confirm)
        (shadowRoot.querySelector(
            '[data-assistant-msg-actions="ast_msg_1"] [data-msg-action="retract"]',
        ) as HTMLButtonElement).click();
        await settleLayout(4);

        expect(windowConfirmSpy).not.toHaveBeenCalled();
        const modal = shadowRoot.querySelector('.ag-modal') as HTMLDivElement;
        expect(modal).toBeTruthy();
        expect(modal.textContent).toContain('确认撤回消息');

        const confirmRetractBtn = Array.from(modal.querySelectorAll('button')).find(
            (btn) => btn.textContent?.trim() === '确认撤回',
        ) as HTMLButtonElement;
        expect(confirmRetractBtn).toBeTruthy();
        confirmRetractBtn.click();
        await settleLayout(5);

        expect(windowConfirmSpy).not.toHaveBeenCalled();
        expect(activeHarness.runtime.retractMessageSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            'ast_msg_1',
        );
        expect(shadowRoot.querySelectorAll('[data-assistant-message]').length).toBe(0);
    });

    it('supports file picker and drag-and-drop multimodal uploads (image, audio, video) across desktop and mobile', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = mountAssistantHarness({
                initialMobileAssistantStack: vp.isMobile ? 'detail' : 'list',
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            const assistantRoot = shadowRoot.querySelector('[data-view-id="assistant"]') as HTMLDivElement;
            const fileInput = shadowRoot.querySelector(
                'input[data-assistant-file-input="true"]',
            ) as HTMLInputElement;
            expect(fileInput).toBeTruthy();

            // 1. File picker upload: 1 PNG image + 1 WAV audio
            const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
            const imageFile = new File([pngBytes], 'cover.png', { type: 'image/png' });
            const audioFile = new File(['RIFF'], 'voice.wav', { type: 'audio/wav' });
            const dtPicker = new DataTransfer();
            dtPicker.items.add(imageFile);
            dtPicker.items.add(audioFile);
            Object.defineProperty(fileInput, 'files', {
                configurable: true,
                value: dtPicker.files,
            });
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            await settleLayout(6);

            const pendingStrip = shadowRoot.querySelector(
                '[data-assistant-pending-attachments="true"]',
            ) as HTMLDivElement;
            expect(pendingStrip, `${vp.label}: expected pending attachments strip`).toBeTruthy();
            expect(pendingStrip.querySelectorAll('[data-pending-attachment]').length).toBe(2);
            expect(pendingStrip.querySelector('[data-attachment-kind="image"] img')).toBeTruthy();
            expect(pendingStrip.querySelector('[data-attachment-kind="audio"]')).toBeTruthy();

            // Remove audio attachment via 40x40 remove button
            const audioChipRemoveBtn = pendingStrip.querySelector(
                '[data-attachment-kind="audio"] button[data-remove-attachment]',
            ) as HTMLButtonElement;
            expect(audioChipRemoveBtn).toBeTruthy();
            audioChipRemoveBtn.click();
            await settleLayout(3);
            expect(pendingStrip.querySelectorAll('[data-pending-attachment]').length).toBe(1);

            // 2. Drag-and-drop upload: MP4 video + audio file
            const videoFile = new File(['ftypmp42'], 'scene.mp4', { type: 'video/mp4' });
            const dtDrop = new DataTransfer();
            dtDrop.items.add(videoFile);
            dtDrop.items.add(new File(['ID3'], 'bgm.mp3', { type: 'audio/mpeg' }));

            assistantRoot.dispatchEvent(
                new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dtDrop }),
            );
            await settleLayout(2);
            expect(assistantRoot.getAttribute('data-drag-over')).toBe('true');
            expect(shadowRoot.querySelector('[data-assistant-drop-hint="true"]')).toBeTruthy();

            assistantRoot.dispatchEvent(
                new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dtDrop }),
            );
            assistantRoot.dispatchEvent(
                new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dtDrop }),
            );
            await settleLayout(6);

            expect(assistantRoot.getAttribute('data-drag-over')).toBe('false');
            const chipsAfterDrop = shadowRoot.querySelectorAll('[data-pending-attachment]');
            expect(chipsAfterDrop.length).toBe(3);

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pending-attachments`);
            assertTouchTargetsAndTypography(shadowRoot, `${vp.label}:pending-attachments`);

            // 3. Send media-only (empty text) -> clears pending chips, passes attachments to sendPrompt, renders img/audio/video inside bubble
            (shadowRoot.querySelector('[data-assistant-send-btn="true"]') as HTMLButtonElement).click();
            await settleLayout(6);

            expect(shadowRoot.querySelector('[data-assistant-pending-attachments="true"]')).toBeNull();
            expect(activeHarness.runtime.sendPromptSpy).toHaveBeenCalledTimes(1);
            expect(activeHarness.runtime.lastSendOptions?.attachments).toHaveLength(3);

            const renderedBubbleAttachments = shadowRoot.querySelector(
                '[data-assistant-msg-attachments]',
            ) as HTMLDivElement;
            expect(renderedBubbleAttachments).toBeTruthy();
            expect(renderedBubbleAttachments.querySelector('img.ag-ast-att-image')).toBeTruthy();
            expect(renderedBubbleAttachments.querySelector('audio.ag-ast-att-audio')).toBeTruthy();
            expect(renderedBubbleAttachments.querySelector('video.ag-ast-att-video')).toBeTruthy();

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:rendered-attachments`);
            assertTouchTargetsAndTypography(shadowRoot, `${vp.label}:rendered-attachments`);

            // 4. Click rendered image thumbnail -> opens Shadow DOM lightbox preview modal
            const imgBtn = renderedBubbleAttachments.querySelector(
                'button.ag-ast-att-image-btn',
            ) as HTMLButtonElement;
            imgBtn.click();
            await settleLayout(4);
            const previewModalImg = shadowRoot.querySelector(
                '[data-assistant-image-preview="true"] img',
            ) as HTMLImageElement;
            expect(previewModalImg).toBeTruthy();
            expect(previewModalImg.getAttribute('alt')).toBe('cover.png');

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('renders full safe GFM Markdown (headings, lists, code copy, tables, links, streaming, ***REDACTED***) across desktop and mobile', async () => {
        const richMarkdown = [
            '**可以，我现在能够访问 SillyTavern 的 Slash / STscript 命令执行工具 (`st_slash_exec`)。**',
            '',
            '---',
            '',
            '### 一、支持消息操作的常用 Slash 命令',
            '',
            '1. 删除消息：',
            '  - `/del [message_id]` 或 `/delete`：删除指定的单条或最新消息。',
            '  - `/cut [message_id]`：剪切/截断该消息之后的所有历史。',
            '',
            '- [ ] 检查 `fast_ui_mode` 设置',
            '- [x] 已确认 `***REDACTED***` 自动脱敏',
            '',
            '> 提示：使用 [安全文档](https://example.com) 查看详情，忽略 [危险脚本](javascript:alert(1))。',
            '',
            '| 命令 | 说明 | 示例参数 |',
            '| :--- | :---: | ---: |',
            '| `/send` | 发送消息 | `hello_world_parameter_long_value_123456` |',
            '| `/sys` | 系统消息 | ***REDACTED*** |',
            '',
            '```typescript',
            'export async function runSlashCommand(cmd: string): Promise<string> {',
            '    return `executed:${cmd} with token=***REDACTED*** and a_very_long_line_that_scrolls_horizontally`;',
            '}',
            '```',
            '',
            '原始脚本标签应保持纯文本：<script>window.__xss=1</script>',
        ].join('\n');

        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            await page.viewport(vp.width, vp.height);
            const runtime = createMockAssistantRuntime({
                sessions: [
                    {
                        id: 'ast_md_session',
                        title: 'Markdown 渲染验证',
                        mode: 'full',
                        stAdminEnabled: true,
                        autoApproveAuthor: false,
                        connectionId: 'inherit',
                        updatedAt: 1732329000000,
                        messages: [
                            {
                                id: 'ast_md_user',
                                role: 'user',
                                content: '现在你能访问 command 吗',
                                timestamp: 1732328900000,
                            },
                            {
                                id: 'ast_md_ai',
                                role: 'assistant',
                                content: richMarkdown,
                                timestamp: 1732329000000,
                            },
                        ],
                    },
                ],
                approvals: [],
                undoRecords: [],
            });

            activeHarness = mountAssistantHarness({
                runtime,
                initialSessionId: 'ast_md_session',
                initialMobileAssistantStack: vp.isMobile ? 'detail' : 'list',
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            const contentEl = shadowRoot.querySelector(
                '[data-assistant-message-content="ast_md_ai"]',
            ) as HTMLDivElement;
            expect(contentEl, `${vp.label}: expected markdown content container`).toBeTruthy();

            // Verify semantic GFM Markdown DOM elements
            expect(contentEl.querySelector('h3')?.textContent).toBe('一、支持消息操作的常用 Slash 命令');
            expect(contentEl.querySelector('hr')).toBeTruthy();
            expect(contentEl.querySelector('strong code')?.textContent).toBe('st_slash_exec');
            expect(contentEl.querySelectorAll('ol > li').length).toBe(1);
            expect(contentEl.querySelectorAll('ol > li ul > li').length).toBe(2);
            expect(contentEl.querySelectorAll('input[type="checkbox"][disabled]').length).toBe(2);
            expect(contentEl.querySelector('blockquote')).toBeTruthy();
            expect(contentEl.querySelectorAll('table thead th').length).toBe(3);

            const codeEl = contentEl.querySelector('.ag-md-code-block pre code');
            expect(codeEl).toBeTruthy();
            expect(contentEl.querySelector('.ag-md-code-lang')?.textContent).toBe('typescript');

            // Verify safe link & XSS rejection
            const safeLink = contentEl.querySelector('a[href="https://example.com"]');
            expect(safeLink).toBeTruthy();
            expect(safeLink?.getAttribute('target')).toBe('_blank');
            expect(safeLink?.getAttribute('rel')).toBe('noopener noreferrer');
            expect(contentEl.querySelector('a[href^="javascript:"]')).toBeNull();
            expect(contentEl.querySelector('script')).toBeNull();
            expect(contentEl.textContent).toContain('<script>window.__xss=1</script>');
            expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();

            // Verify ***REDACTED*** tokens highlighted in markdown & code blocks
            const redactedTokens = contentEl.querySelectorAll('.ag-redacted-token');
            expect(redactedTokens.length).toBeGreaterThanOrEqual(3);

            // Verify snake_case was NOT converted to <em>
            expect(contentEl.querySelector('em')).toBeNull();

            // Click code copy button -> changes label to ✓ 已复制
            const copyBtn = contentEl.querySelector('[data-md-code-copy="true"]') as HTMLButtonElement;
            expect(copyBtn).toBeTruthy();
            copyBtn.click();
            await settleLayout(3);
            expect(copyBtn.textContent).toContain('已复制');

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:markdown`);
            assertTouchTargetsAndTypography(shadowRoot, `${vp.label}:markdown`);

            // Verify streaming Markdown (unclosed fenced code block + heading + cursor)
            const deferred = createDeferred<AssistantMessage | void>();
            activeHarness.runtime.nextSendDeferred = deferred;
            const draftInput = shadowRoot.querySelector(
                'textarea[data-assistant-draft-input="true"]',
            ) as HTMLTextAreaElement;
            setInputValue(draftInput, '流式测试');
            await settleLayout(2);
            (shadowRoot.querySelector('[data-assistant-send-btn="true"]') as HTMLButtonElement).click();
            await settleLayout(4);

            activeHarness.runtime.lastSendOptions?.onDelta?.('### 流式标题\n\n```ts\nconst x = 1;');
            await settleLayout(3);

            const streamingBubble = shadowRoot.querySelector(
                '[data-assistant-message-content="assistant-streaming-live"]',
            ) as HTMLDivElement;
            expect(streamingBubble).toBeTruthy();
            expect(streamingBubble.querySelector('h3')?.textContent).toBe('流式标题');
            expect(streamingBubble.querySelector('.ag-md-code-block pre code')?.textContent).toContain(
                'const x = 1;',
            );
            expect(streamingBubble.querySelector('.ag-ast-streaming-cursor')).toBeTruthy();

            deferred.resolve({
                id: 'ast_md_stream_done',
                role: 'assistant',
                content: '### 流式标题\n\n```ts\nconst x = 1;\n```',
                timestamp: Date.now(),
            });
            await settleLayout(5);

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('supports renaming session titles via hover/touch-revealed topbar control and always-visible session list action on desktop & mobile', async () => {
        // 1. Desktop (1280x800): topbar rename button is hidden by default, revealed on hover;
        //    drawer session list always displays rename button directly alongside delete.
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        let shell = getShellElements();
        const firstSessionId = activeHarness.runtime.sessions[0].id;
        const secondSessionId = activeHarness.runtime.sessions[1].id;

        const topbarRenameBtn = shell.shadowRoot.querySelector(
            '[data-assistant-topbar-rename-btn="true"]',
        ) as HTMLButtonElement;
        expect(topbarRenameBtn).toBeTruthy();
        expect(window.getComputedStyle(topbarRenameBtn).display).toBe('none');
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'desktop:rename-idle');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'desktop:rename-idle');

        // Hover over title wrapper -> reveals rename button
        const titleEl = shell.shadowRoot.querySelector(
            '[data-assistant-session-title="true"]',
        ) as HTMLSpanElement;
        await userEvent.hover(titleEl);
        await settleLayout(3);
        expect(isElementVisible(topbarRenameBtn)).toBe(true);

        // Click topbar rename -> enters inline edit; Escape cancels without closing dialog
        topbarRenameBtn.click();
        await settleLayout(3);

        let topbarInput = shell.shadowRoot.querySelector(
            '[data-assistant-topbar-rename-input="true"]',
        ) as HTMLInputElement;
        expect(topbarInput).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(topbarInput).fontSize)).toBeGreaterThanOrEqual(16);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'desktop:topbar-rename-edit');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'desktop:topbar-rename-edit');

        setInputValue(topbarInput, '临时取消标题');
        await settleLayout(2);
        topbarInput.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        await settleLayout(3);
        expect(shell.dialog.open).toBe(true);
        expect(
            shell.shadowRoot.querySelector('[data-assistant-topbar-rename-input="true"]'),
        ).toBeNull();
        expect(
            shell.shadowRoot.querySelector('[data-assistant-session-title="true"]')?.textContent,
        ).toBe(SAMPLE_ASSISTANT_SESSION.title);

        // Double-click title -> enter inline edit and save with Enter
        const titleAfterCancel = shell.shadowRoot.querySelector(
            '[data-assistant-session-title="true"]',
        ) as HTMLSpanElement;
        titleAfterCancel.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settleLayout(3);
        topbarInput = shell.shadowRoot.querySelector(
            '[data-assistant-topbar-rename-input="true"]',
        ) as HTMLInputElement;
        expect(topbarInput).toBeTruthy();
        setInputValue(topbarInput, '雾港主线设定整理');
        await settleLayout(2);
        topbarInput.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
        );
        await settleLayout(5);

        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenCalledWith(
            firstSessionId,
            { title: '雾港主线设定整理' },
        );
        expect(
            shell.shadowRoot.querySelector('[data-assistant-session-title="true"]')?.textContent,
        ).toBe('雾港主线设定整理');

        // Open desktop drawer -> session list shows rename buttons directly without hover
        const drawerBtn = shell.shadowRoot.querySelector(
            '[data-assistant-drawer-btn="true"]',
        ) as HTMLButtonElement;
        drawerBtn.click();
        await settleLayout(4);

        const listRenameBtn = shell.shadowRoot.querySelector(
            `[data-assistant-session-rename="${secondSessionId}"]`,
        ) as HTMLButtonElement;
        expect(listRenameBtn).toBeTruthy();
        expect(isElementVisible(listRenameBtn)).toBe(true);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'desktop:drawer-rename-visible');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'desktop:drawer-rename-visible');

        // Click rename on non-active session -> inline editor opens without switching active session or closing drawer
        listRenameBtn.click();
        await settleLayout(3);
        expect(activeHarness.store.getSnapshot().selectedAssistantSessionId).toBe(firstSessionId);
        const listInput = shell.shadowRoot.querySelector(
            `[data-assistant-session-rename-input="${secondSessionId}"]`,
        ) as HTMLInputElement;
        expect(listInput).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(listInput).fontSize)).toBeGreaterThanOrEqual(16);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'desktop:drawer-rename-edit');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'desktop:drawer-rename-edit');

        setInputValue(listInput, '世界书变量排查');
        await settleLayout(2);
        (
            shell.shadowRoot.querySelector(
                `[data-assistant-session-rename-save="${secondSessionId}"]`,
            ) as HTMLButtonElement
        ).click();
        await settleLayout(5);

        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenCalledWith(
            secondSessionId,
            { title: '世界书变量排查' },
        );
        const updatedSecondItem = shell.shadowRoot.querySelector(
            `[data-assistant-session-item="${secondSessionId}"] .ag-ast-session-item-title`,
        );
        expect(updatedSecondItem?.textContent).toBe('世界书变量排查');

        activeHarness.cleanup();
        activeHarness = null;

        // 2. Mobile (390x844): list view always displays rename button; detail view reveals topbar rename on tap.
        await page.viewport(390, 844);
        activeHarness = mountAssistantHarness({ initialMobileAssistantStack: 'list' });
        await settleLayout(5);
        shell = getShellElements();

        const mobileFirstId = activeHarness.runtime.sessions[0].id;
        const mobileListRenameBtn = shell.shadowRoot.querySelector(
            `[data-assistant-session-rename="${mobileFirstId}"]`,
        ) as HTMLButtonElement;
        expect(mobileListRenameBtn).toBeTruthy();
        expect(isElementVisible(mobileListRenameBtn)).toBe(true);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'mobile:list-rename-visible');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'mobile:list-rename-visible');

        // Enter detail view -> topbar rename button is hidden until title is tapped
        (
            shell.shadowRoot.querySelector(
                `[data-assistant-session-select="${mobileFirstId}"]`,
            ) as HTMLButtonElement
        ).click();
        await settleLayout(5);

        const mobileTopbarRenameBtn = shell.shadowRoot.querySelector(
            '[data-assistant-topbar-rename-btn="true"]',
        ) as HTMLButtonElement;
        expect(mobileTopbarRenameBtn).toBeTruthy();
        expect(window.getComputedStyle(mobileTopbarRenameBtn).display).toBe('none');

        const mobileTitleEl = shell.shadowRoot.querySelector(
            '[data-assistant-session-title="true"]',
        ) as HTMLSpanElement;
        mobileTitleEl.click();
        await settleLayout(3);
        expect(isElementVisible(mobileTopbarRenameBtn)).toBe(true);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'mobile:topbar-rename-revealed');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'mobile:topbar-rename-revealed');

        // Tap rename button -> edit and save on mobile with >=40px controls & >=16px input
        mobileTopbarRenameBtn.click();
        await settleLayout(3);
        const mobileTopbarInput = shell.shadowRoot.querySelector(
            '[data-assistant-topbar-rename-input="true"]',
        ) as HTMLInputElement;
        expect(mobileTopbarInput).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(mobileTopbarInput).fontSize)).toBeGreaterThanOrEqual(16);
        assertNoHorizontalOverflow(shell.dialog, shell.shadowRoot, 'mobile:topbar-rename-edit');
        assertTouchTargetsAndTypography(shell.shadowRoot, 'mobile:topbar-rename-edit');

        setInputValue(mobileTopbarInput, '移动端新标题');
        await settleLayout(2);
        (
            shell.shadowRoot.querySelector(
                '[data-assistant-topbar-rename-save="true"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(5);

        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenCalledWith(
            mobileFirstId,
            { title: '移动端新标题' },
        );
        expect(
            shell.shadowRoot.querySelector('[data-assistant-session-title="true"]')?.textContent,
        ).toBe('移动端新标题');
    });

    it('renders live auto-retry banner, inline continue recovery cards across interrupted reasons, invokes continueLastMessage(), and passes mobile compliance', async () => {
        await page.viewport(1280, 800);

        const retrySession: AssistantSession = {
            id: 'ast_retry_ui',
            title: '自动重试与手动继续测试',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732329000000,
            messages: [
                {
                    id: 'u_net',
                    role: 'user',
                    content: '请帮我分析日志',
                    timestamp: 1732328990000,
                },
                {
                    id: 'a_net',
                    role: 'assistant',
                    content: '前段分析已完成。\n\n[Error] SSE connection dropped',
                    interrupted: true,
                    errorCode: 'network',
                    canContinue: true,
                    toolCalls: [
                        {
                            id: 'tc_net_1',
                            name: 'list_dir',
                            scopeLabel: 'VFS: /',
                            status: 'ok',
                            durationMs: 2,
                            argsSummary: '{"path":"/"}',
                            resultSummary: '["character"]',
                        },
                    ],
                    timestamp: 1732329000000,
                },
            ],
        };

        const cappedSession: AssistantSession = {
            id: 'ast_capped_ui',
            title: '轮次上限会话',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732328500000,
            messages: [
                {
                    id: 'u_cap',
                    role: 'user',
                    content: '读取全量世界书',
                    timestamp: 1732328490000,
                },
                {
                    id: 'a_cap',
                    role: 'assistant',
                    content: '',
                    interrupted: true,
                    errorCode: 'max_tool_rounds',
                    canContinue: true,
                    timestamp: 1732328500000,
                },
            ],
        };

        const legacyEmptyToolsSession: AssistantSession = {
            id: 'ast_legacy_empty_ui',
            title: '旧版工具后空回复会话',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732328400000,
            messages: [
                {
                    id: 'u_leg',
                    role: 'user',
                    content: '查一下描述文件',
                    timestamp: 1732328390000,
                },
                {
                    id: 'a_leg',
                    role: 'assistant',
                    content: '',
                    toolCalls: [
                        {
                            id: 'tc_leg_1',
                            name: 'read_file',
                            scopeLabel: 'VFS: /character/description.md',
                            status: 'ok',
                            durationMs: 1,
                            argsSummary: '{"path":"/character/description.md"}',
                            resultSummary: '描述文本',
                        },
                    ],
                    timestamp: 1732328400000,
                },
            ],
        };

        const overflowSession: AssistantSession = {
            id: 'ast_overflow_ui',
            title: '上下文超限会话',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732328300000,
            messages: [
                {
                    id: 'u_ovf',
                    role: 'user',
                    content: '超长对话',
                    timestamp: 1732328290000,
                },
                {
                    id: 'a_ovf',
                    role: 'assistant',
                    content: '[Error] prompt is too long: 210000 tokens > 200000 maximum',
                    interrupted: true,
                    errorCode: 'context_overflow',
                    timestamp: 1732328300000,
                },
            ],
        };

        const pendingApprovalSession: AssistantSession = {
            id: 'ast_pending_ui',
            title: '待审批会话',
            mode: 'author',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732328200000,
            messages: [
                {
                    id: 'u_pend',
                    role: 'user',
                    content: '更新规则',
                    timestamp: 1732328190000,
                },
                {
                    id: 'a_pend',
                    role: 'assistant',
                    content: '',
                    approvalIds: [SAMPLE_PENDING_AUTHOR_APPROVAL.id],
                    timestamp: 1732328200000,
                },
            ],
        };

        const pendingApproval = {
            ...structuredClone(SAMPLE_PENDING_AUTHOR_APPROVAL),
            sessionId: pendingApprovalSession.id,
            messageId: 'a_pend',
        };

        const runtime = createMockAssistantRuntime({
            sessions: [
                retrySession,
                cappedSession,
                legacyEmptyToolsSession,
                overflowSession,
                pendingApprovalSession,
            ],
            approvals: [pendingApproval],
        });
        activeHarness = mountAssistantHarness({
            runtime,
            initialSessionId: retrySession.id,
        });
        await settleLayout(5);

        const shell = getShellElements();
        const { shadowRoot } = shell;

        // 1. Network interrupted bubble shows [data-assistant-continue-bar] + footer label
        const netContinueBar = shadowRoot.querySelector(
            '[data-assistant-continue-bar="a_net"]',
        ) as HTMLDivElement;
        expect(netContinueBar).toBeTruthy();
        expect(netContinueBar.getAttribute('data-tone')).toBe('warning');
        expect(netContinueBar.textContent).toContain('网络波动或连接中断');
        expect(shadowRoot.textContent).toContain('网络中断');

        // 2. max_tool_rounds session shows '继续执行' (SVG play icon + label)
        activeHarness.store.openAssistantSession(cappedSession.id);
        await settleLayout(4);
        const capBar = shadowRoot.querySelector(
            '[data-assistant-continue-bar="a_cap"]',
        ) as HTMLDivElement;
        expect(capBar).toBeTruthy();
        expect(capBar.getAttribute('data-tone')).toBe('neutral');
        expect(
            capBar.querySelector('[data-continue-action="continue"]')?.textContent?.trim(),
        ).toBe('继续执行');

        // 3. Legacy empty-after-tools bubble (no interrupted flag) also shows continue bar
        activeHarness.store.openAssistantSession(legacyEmptyToolsSession.id);
        await settleLayout(4);
        expect(
            shadowRoot.querySelector('[data-assistant-continue-bar="a_leg"]'),
        ).toBeTruthy();

        // 4. context_overflow must NOT render continue bar (keeps overflow escape UI)
        activeHarness.store.openAssistantSession(overflowSession.id);
        await settleLayout(4);
        expect(shadowRoot.querySelector('[data-assistant-continue-bar="a_ovf"]')).toBeNull();
        expect(shadowRoot.querySelector('[data-assistant-overflow-escape="a_ovf"]')).toBeTruthy();

        // 5. Pending approval message must NOT render continue bar
        activeHarness.store.openAssistantSession(pendingApprovalSession.id);
        await settleLayout(4);
        expect(shadowRoot.querySelector('[data-assistant-continue-bar="a_pend"]')).toBeNull();

        // 6. Switch back to retrySession -> test mobile viewport (390x844) compliance while continue bar is visible
        activeHarness.store.openAssistantSession(retrySession.id);
        await page.viewport(390, 844);
        await settleLayout(5);
        assertNoHorizontalOverflow(shell.dialog, shadowRoot, 'mobile:continue-bar-visible');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:continue-bar-visible');

        // 7. Click Continue -> live retry banner renders while streaming, then resolves cleanly
        await page.viewport(1280, 800);
        await settleLayout(3);
        const deferred = createDeferred<AssistantMessage | void>();
        activeHarness.runtime.nextSendDeferred = deferred;

        const continueBtn = shadowRoot.querySelector(
            '[data-assistant-continue-bar="a_net"] [data-continue-action="continue"]',
        ) as HTMLButtonElement;
        expect(continueBtn).toBeTruthy();
        continueBtn.click();
        await settleLayout(4);

        expect(activeHarness.runtime.continueLastMessageSpy).toHaveBeenCalledTimes(1);
        expect(activeHarness.runtime.continueLastMessageSpy).toHaveBeenCalledWith(
            retrySession.id,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        // Simulate live auto-retry status update on streaming bubble
        const liveSession = structuredClone(activeHarness.runtime.sessions[0]);
        liveSession.messages[1] = {
            ...liveSession.messages[1],
            content: '前段分析已完成。',
            interrupted: false,
            canContinue: false,
            retryStatus: {
                attempt: 1,
                maxAttempts: 2,
                reason: '502 Bad Gateway',
                delayMs: 1000,
            },
        };
        activeHarness.runtime.lastSendOptions?.onUpdate?.(liveSession);
        await settleLayout(4);

        const retryBanner = shadowRoot.querySelector(
            '[data-assistant-retry-banner="a_net"]',
        ) as HTMLDivElement;
        expect(retryBanner).toBeTruthy();
        expect(retryBanner.textContent).toContain('自动重试 (1/2)');
        expect(retryBanner.textContent).toContain('502 Bad Gateway');
        expect(shadowRoot.textContent).toContain('自动重试 1/2...');

        deferred.resolve({
            ...liveSession.messages[1],
            content: '前段分析已完成。\n\n继续完成后的最终答复。',
            retryStatus: undefined,
            interrupted: undefined,
            errorCode: undefined,
            canContinue: undefined,
        });
        await settleLayout(5);

        expect(shadowRoot.querySelector('[data-assistant-retry-banner="a_net"]')).toBeNull();
        expect(shadowRoot.querySelector('[data-assistant-continue-bar="a_net"]')).toBeNull();
        expect(shadowRoot.textContent).toContain('继续完成后的最终答复。');
    });

    it('preserves `this` binding on class-backed AssistantRuntimeBridge for readPreviewFile and getSessionTokenStatus', async () => {
        const lorePath = '/lorebooks/创世回廊6.1/插画插入-111.md';
        const loreContent = '## 插画插入规则\n在章节高潮处输出插画标记。';

        const sessionWithRefs: AssistantSession = {
            id: 'ast_class_runtime',
            title: '类实例运行时绑定测试',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732329000000,
            messages: [
                {
                    id: 'u_cls_1',
                    role: 'user',
                    content: '查看世界书插画条目',
                    timestamp: 1732328990000,
                },
                {
                    id: 'a_cls_1',
                    role: 'assistant',
                    content: '已读取目标条目。',
                    fileRefs: [lorePath],
                    timestamp: 1732329000000,
                },
            ],
        };

        const delegate = createMockAssistantRuntime({ sessions: [sessionWithRefs] });
        const tokenStatusCalls: Array<{ bound: boolean; sessionId: string }> = [];
        const previewCalls: Array<{ bound: boolean; path: string }> = [];

        class ClassBackedRuntime implements AssistantRuntimeBridge {
            private readonly files = new Map<string, string>([[lorePath, loreContent]]);
            private readonly tokenStatus: AssistantSessionTokenStatus = {
                sessionId: sessionWithRefs.id,
                currentTokens: 5610,
                contextLimit: 128000,
                highWatermark: 96000,
                lowWatermark: 32000,
                usagePercent: 4,
                level: 'normal',
                activeTurnCount: 1,
                activeMessageCount: 2,
                foldableToolResultCount: 0,
                compactedCount: 0,
                isCompacting: false,
            };

            public listSessions(): AssistantSession[] {
                return delegate.bridge.listSessions() as AssistantSession[];
            }

            public createSession(options?: Parameters<AssistantRuntimeBridge['createSession']>[0]) {
                return delegate.bridge.createSession(options);
            }

            public sendPrompt(
                sessionId: string,
                prompt: string,
                options?: Parameters<AssistantRuntimeBridge['sendPrompt']>[2],
            ) {
                return delegate.bridge.sendPrompt(sessionId, prompt, options);
            }

            public decideApproval(
                approvalId: string,
                decision: 'approve' | 'reject',
                feedback?: string,
            ) {
                return delegate.bridge.decideApproval(approvalId, decision, feedback);
            }

            public retryApproval(approvalId: string, feedback?: string) {
                return delegate.bridge.retryApproval(approvalId, feedback);
            }

            public applyUndo(undoId: string) {
                return delegate.bridge.applyUndo(undoId);
            }

            public getSessionTokenStatus(sessionId: string): AssistantSessionTokenStatus | null {
                // Accessing `this.tokenStatus` throws TypeError if invoked detached (`this === undefined`).
                const isBound = this instanceof ClassBackedRuntime;
                tokenStatusCalls.push({ bound: isBound, sessionId });
                return sessionId === this.tokenStatus.sessionId
                    ? structuredClone(this.tokenStatus)
                    : null;
            }

            public async readPreviewFile(path: string): Promise<string | null> {
                // Accessing `this.files` throws TypeError if invoked detached (`this === undefined`).
                const isBound = this instanceof ClassBackedRuntime;
                previewCalls.push({ bound: isBound, path });
                return this.files.get(path) ?? null;
            }
        }

        const classRuntime = new ClassBackedRuntime();
        delegate.bridge = classRuntime;

        activeHarness = mountAssistantHarness({
            runtime: delegate,
            initialSessionId: sessionWithRefs.id,
        });
        await settleLayout(6);

        const { shadowRoot } = getShellElements();

        // 1. getSessionTokenStatus ran with bound `this` and populated the topbar token pill
        expect(tokenStatusCalls.length).toBeGreaterThan(0);
        expect(tokenStatusCalls.every((c) => c.bound && c.sessionId === sessionWithRefs.id)).toBe(true);
        expect(shadowRoot.textContent).toContain('5.6k');

        // 2. Click the file reference chip -> readPreviewFile runs with bound `this` and renders real content
        const fileChip = shadowRoot.querySelector('.ag-ast-file-chip') as HTMLButtonElement;
        expect(fileChip).toBeTruthy();
        expect(fileChip.textContent).toContain(lorePath);

        fileChip.click();
        await settleLayout(5);

        expect(previewCalls).toEqual([{ bound: true, path: lorePath }]);
        expect(shadowRoot.textContent).toContain(`只读文件预览 · ${lorePath}`);
        expect(shadowRoot.textContent).toContain('在章节高潮处输出插画标记。');
        expect(shadowRoot.textContent).not.toContain('（文件不存在或内容为空）');
    });
    it('collapses many referenced files into a single expandable summary row and keeps <= 2 refs inline', async () => {
        await page.viewport(1280, 800);

        const manyRefs = [
            ...Array.from({ length: 15 }, (_, i) => `/lorebooks/创世回响6.1/mod-角色${i + 1}-正文-1-${100000 + i}.md`),
            '/state/variables.json',
            '/character/card.md',
        ];
        const manyRefsSession: AssistantSession = {
            id: 'ast_file_refs_many',
            title: '大量引用文件会话',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732330000000,
            messages: [
                { id: 'u_refs', role: 'user', content: '统一插画格式', timestamp: 1732329990000 },
                {
                    id: 'a_refs_many',
                    role: 'assistant',
                    content: '已逐个核对并统一插画插入格式。',
                    fileRefs: manyRefs,
                    timestamp: 1732330000000,
                },
                {
                    id: 'a_refs_two',
                    role: 'assistant',
                    content: '变量与角色卡已同步。',
                    fileRefs: ['/state/variables.json', '/character/card.md'],
                    timestamp: 1732330001000,
                },
            ],
        };

        const runtime = createMockAssistantRuntime({ sessions: [manyRefsSession] });
        activeHarness = mountAssistantHarness({ runtime, initialSessionId: manyRefsSession.id });
        await settleLayout(5);

        const shell = getShellElements();
        const { shadowRoot } = shell;

        // 1. 17 refs -> one collapsed summary row, no chips rendered yet
        const manyStrip = shadowRoot.querySelector('[data-assistant-file-refs="a_refs_many"]') as HTMLDivElement;
        expect(manyStrip).toBeTruthy();
        expect(manyStrip.getAttribute('data-expanded')).toBe('false');
        expect(manyStrip.querySelectorAll('.ag-ast-file-chip').length).toBe(0);
        const toggle = manyStrip.querySelector('[data-assistant-file-refs-toggle="a_refs_many"]') as HTMLButtonElement;
        expect(toggle.textContent).toContain('引用 17 个文件');
        expect(toggle.getBoundingClientRect().height).toBeLessThanOrEqual(48);

        // 2. <= 2 refs render inline with full path text
        const twoStrip = shadowRoot.querySelector('[data-assistant-file-refs="a_refs_two"]') as HTMLDivElement;
        const twoChips = twoStrip.querySelectorAll('.ag-ast-file-chip');
        expect(twoChips.length).toBe(2);
        expect(twoChips[0].textContent).toContain('/state/variables.json');

        // 3. Expand -> grouped by directory, scroll-capped panel, chips open the preview
        toggle.click();
        await settleLayout(3);
        expect(manyStrip.getAttribute('data-expanded')).toBe('true');
        expect(manyStrip.querySelectorAll('.ag-ast-file-chip').length).toBe(17);
        const groupLabels = Array.from(manyStrip.querySelectorAll('.ag-ast-file-group-label')).map((el) => el.textContent);
        expect(groupLabels.some((t) => t?.includes('/lorebooks/创世回响6.1/'))).toBe(true);
        const panel = manyStrip.querySelector('.ag-ast-file-refs-panel') as HTMLDivElement;
        expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(240);
        // Scope the >= 40px target check to the strip itself (the topbar rename button is
        // hover-revealed at 28px on desktop and depends on the real pointer position).
        for (const btn of Array.from(manyStrip.querySelectorAll('button'))) {
            const rect = btn.getBoundingClientRect();
            if (rect.width === 0) {
                continue;
            }
            expect(rect.width, 'file-refs control width').toBeGreaterThanOrEqual(40);
            expect(rect.height, 'file-refs control height').toBeGreaterThanOrEqual(40);
        }

        const firstChip = manyStrip.querySelector('.ag-ast-file-chip') as HTMLButtonElement;
        expect(firstChip.getAttribute('data-file-path')).toBe(manyRefs[0]);
        firstChip.click();
        await settleLayout(4);
        expect(shadowRoot.textContent).toContain(`只读文件预览 · ${manyRefs[0]}`);

        // 4. Mobile (390x844): collapsed row stays single-line without horizontal overflow
        await page.viewport(390, 844);
        activeHarness.cleanup();
        activeHarness = mountAssistantHarness({ runtime, initialSessionId: manyRefsSession.id });
        await settleLayout(6);
        activeHarness.store.openAssistantSession(manyRefsSession.id);
        await settleLayout(4);
        const mobile = getShellElements();
        expect(
            mobile.shadowRoot.querySelector('[data-assistant-file-refs-toggle="a_refs_many"]'),
        ).toBeTruthy();
        assertNoHorizontalOverflow(mobile.dialog, mobile.shadowRoot, 'mobile:file-refs');
        assertTouchTargetsAndTypography(mobile.shadowRoot, 'mobile:file-refs');
    });

    it('allows switching mode, safety toggles, and model connection before any session exists and carries them into session creation', async () => {
        await page.viewport(1280, 800);

        // Part A: configure mode + safety flags + model in empty state, then send prompt to auto-create session.
        const runtimeA = createMockAssistantRuntime({
            sessions: [],
            approvals: [],
            undoRecords: [],
        });
        activeHarness = mountAssistantHarness({
            runtime: runtimeA,
            initialSessionId: null,
        });
        await settleLayout(5);

        const shellA = getShellElements();
        const emptyTitleA = shellA.shadowRoot.querySelector('.ag-empty-title');
        expect(emptyTitleA?.textContent).toContain('独立线外助手工作台');

        const modeBtnA = shellA.shadowRoot.querySelector(
            '[data-assistant-mode-btn="true"]',
        ) as HTMLButtonElement;
        const modelBtnA = shellA.shadowRoot.querySelector(
            '[data-assistant-model-btn="true"]',
        ) as HTMLButtonElement;
        expect(modeBtnA).toBeTruthy();
        expect(modelBtnA).toBeTruthy();
        expect(modeBtnA.disabled).toBe(false);
        expect(modelBtnA.disabled).toBe(false);
        expect(modeBtnA.textContent).toContain('交流');
        expect(modelBtnA.textContent).toContain('跟随主连接');

        // Open mode popover without an active session
        modeBtnA.click();
        await settleLayout(3);
        expect(shellA.shadowRoot.querySelector('[data-assistant-popover="mode"]')).toBeTruthy();

        // Switch to adjust and toggle autoApproveChatDelete
        (
            shellA.shadowRoot.querySelector(
                '[data-assistant-mode-option="adjust"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        const chatDeleteCheckboxA = shellA.shadowRoot.querySelector(
            'input[data-assistant-auto-approve-chat-delete-checkbox="true"]',
        ) as HTMLInputElement;
        expect(chatDeleteCheckboxA).toBeTruthy();
        chatDeleteCheckboxA.click();
        await settleLayout(3);
        expect(chatDeleteCheckboxA.checked).toBe(true);

        // Switch to author and toggle autoApproveAuthor
        (
            shellA.shadowRoot.querySelector(
                '[data-assistant-mode-option="author"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        const autoApproveCheckboxA = shellA.shadowRoot.querySelector(
            'input[data-assistant-auto-approve-checkbox="true"]',
        ) as HTMLInputElement;
        expect(autoApproveCheckboxA).toBeTruthy();
        autoApproveCheckboxA.click();
        await settleLayout(3);
        expect(autoApproveCheckboxA.checked).toBe(true);

        // Switch to full and confirm ST 全权管家
        (
            shellA.shadowRoot.querySelector(
                '[data-assistant-mode-option="full"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        (
            shellA.shadowRoot.querySelector(
                '[data-assistant-st-admin-toggle="true"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        expect(
            shellA.shadowRoot.querySelector('[data-assistant-st-admin-modal="true"]'),
        ).toBeTruthy();
        (
            shellA.shadowRoot.querySelector(
                '[data-assistant-st-admin-confirm="true"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(4);

        expect(modeBtnA.textContent).toContain('⚡ 管家');
        expect(runtimeA.sessions.length).toBe(0);

        // Open model popover without an active session and select conn_flash
        modelBtnA.click();
        await settleLayout(3);
        const modelPopoverA = shellA.shadowRoot.querySelector(
            '[data-assistant-popover="model"]',
        ) as HTMLDivElement;
        expect(modelPopoverA).toBeTruthy();
        (
            modelPopoverA.querySelector(
                '[data-assistant-model-option="conn_flash"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);

        expect(modelBtnA.textContent).toContain('Gemini Flash');
        expect(runtimeA.sessions.length).toBe(0);

        // Send prompt -> auto-creates session carrying pre-selected draft config
        const draftInputA = shellA.shadowRoot.querySelector(
            'textarea[data-assistant-draft-input="true"]',
        ) as HTMLTextAreaElement;
        const sendBtnA = shellA.shadowRoot.querySelector(
            '[data-assistant-send-btn="true"]',
        ) as HTMLButtonElement;
        setInputValue(draftInputA, '先核查当前角色卡状态');
        await settleLayout(2);
        sendBtnA.click();
        await settleLayout(6);

        expect(runtimeA.sessions.length).toBe(1);
        const createdA = runtimeA.sessions[0];
        expect(createdA.mode).toBe('full');
        expect(createdA.stAdminEnabled).toBe(true);
        expect(createdA.autoApproveAuthor).toBe(true);
        expect(createdA.autoApproveChatDelete).toBe(true);
        expect(createdA.connectionId).toBe('conn_flash');
        expect(runtimeA.sendPromptSpy).toHaveBeenCalledTimes(1);
        expect(runtimeA.sendPromptSpy).toHaveBeenCalledWith(
            createdA.id,
            '先核查当前角色卡状态',
            expect.any(Object),
        );

        activeHarness.cleanup();
        activeHarness = null;

        // Part B: configure in empty state, click empty-state create button, then delete session and verify reset.
        const runtimeB = createMockAssistantRuntime({
            sessions: [],
            approvals: [],
            undoRecords: [],
        });
        activeHarness = mountAssistantHarness({
            runtime: runtimeB,
            initialSessionId: null,
        });
        await settleLayout(5);

        const shellB = getShellElements();
        const modeBtnB = shellB.shadowRoot.querySelector(
            '[data-assistant-mode-btn="true"]',
        ) as HTMLButtonElement;
        const modelBtnB = shellB.shadowRoot.querySelector(
            '[data-assistant-model-btn="true"]',
        ) as HTMLButtonElement;

        modeBtnB.click();
        await settleLayout(3);
        (
            shellB.shadowRoot.querySelector(
                '[data-assistant-mode-option="adjust"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        (
            shellB.shadowRoot.querySelector(
                'input[data-assistant-auto-approve-chat-delete-checkbox="true"]',
            ) as HTMLInputElement
        ).click();
        await settleLayout(3);

        modelBtnB.click();
        await settleLayout(3);
        (
            shellB.shadowRoot.querySelector(
                '[data-assistant-model-option="conn_flash"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);

        // Landing screen has no inline create button; use the topbar ＋ action.
        expect(shellB.shadowRoot.querySelector('.ag-empty button')).toBeNull();
        const emptyCreateBtnB = shellB.shadowRoot.querySelector(
            '[data-assistant-new-session-btn="true"]',
        ) as HTMLButtonElement;
        expect(emptyCreateBtnB).toBeTruthy();
        emptyCreateBtnB.click();
        await settleLayout(6);

        expect(runtimeB.sessions.length).toBe(1);
        const createdB = runtimeB.sessions[0];
        expect(createdB.mode).toBe('adjust');
        expect(createdB.stAdminEnabled).toBe(false);
        expect(createdB.autoApproveAuthor).toBe(false);
        expect(createdB.autoApproveChatDelete).toBe(true);
        expect(createdB.connectionId).toBe('conn_flash');

        // Delete the only session via drawer and verify composer resets to defaults (交流 / 跟随主连接)
        (
            shellB.shadowRoot.querySelector(
                '[data-assistant-drawer-btn="true"]',
            ) as HTMLButtonElement
        ).click();
        await settleLayout(3);
        (
            shellB.shadowRoot.querySelector(
                `[data-assistant-session-delete="${createdB.id}"]`,
            ) as HTMLButtonElement
        ).click();
        await settleLayout(6);

        expect(runtimeB.sessions.length).toBe(0);
        expect(shellB.shadowRoot.querySelector('.ag-empty-title')?.textContent).toContain(
            '独立线外助手工作台',
        );
        expect(
            (
                shellB.shadowRoot.querySelector(
                    '[data-assistant-mode-btn="true"]',
                ) as HTMLButtonElement
            ).textContent,
        ).toContain('交流');
        expect(
            (
                shellB.shadowRoot.querySelector(
                    '[data-assistant-model-btn="true"]',
                ) as HTMLButtonElement
            ).textContent,
        ).toContain('跟随主连接');
    });

    it('automatically invokes continueLastMessage only after the final pending approval on a trailing bubble is approved', async () => {
        await page.viewport(1280, 800);

        const singleApprovalSession: AssistantSession = {
            id: 'ast_auto_cont_1',
            title: '单审批自动续写',
            mode: 'author',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732329000000,
            messages: [
                {
                    id: 'u_ac_1',
                    role: 'user',
                    content: '帮我改一下脚本',
                    timestamp: 1732328990000,
                },
                {
                    id: 'a_ac_1',
                    role: 'assistant',
                    content: '',
                    approvalIds: ['appr_ac_single'],
                    timestamp: 1732329000000,
                },
            ],
        };

        const multiApprovalSession: AssistantSession = {
            id: 'ast_auto_cont_2',
            title: '多审批等待全部接受后再续写',
            mode: 'full',
            stAdminEnabled: true,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: 1732329100000,
            messages: [
                {
                    id: 'u_ac_2',
                    role: 'user',
                    content: '同时改两条配置',
                    timestamp: 1732329090000,
                },
                {
                    id: 'a_ac_2',
                    role: 'assistant',
                    content: '',
                    approvalIds: ['appr_ac_m1', 'appr_ac_m2'],
                    timestamp: 1732329100000,
                },
            ],
        };

        const singleApproval: PendingApproval = {
            ...structuredClone(SAMPLE_PENDING_AUTHOR_APPROVAL),
            id: 'appr_ac_single',
            sessionId: singleApprovalSession.id,
            messageId: 'a_ac_1',
            title: 'Edit TavernHelper script "02_战术雷达控制台"',
        };
        const multi1: PendingApproval = {
            ...structuredClone(SAMPLE_PENDING_AUTHOR_APPROVAL),
            id: 'appr_ac_m1',
            sessionId: multiApprovalSession.id,
            messageId: 'a_ac_2',
            title: '修改条目 A',
        };
        const multi2: PendingApproval = {
            ...structuredClone(SAMPLE_PENDING_ADMIN_APPROVAL),
            id: 'appr_ac_m2',
            sessionId: multiApprovalSession.id,
            messageId: 'a_ac_2',
            title: '修改条目 B',
        };

        const runtime = createMockAssistantRuntime({
            sessions: [singleApprovalSession, multiApprovalSession],
            approvals: [singleApproval, multi1, multi2],
        });

        const baseDecide = runtime.bridge.decideApproval.bind(runtime.bridge);
        runtime.bridge.decideApproval = async (approvalId, decision, feedback) => {
            const updated = await baseDecide(approvalId, decision, feedback);
            if (updated && decision === 'approve') {
                const sess = runtime.sessions.find((s) => s.id === updated.sessionId);
                const hasPendingOnMsg = runtime.approvals.some(
                    (a) =>
                        a.sessionId === updated.sessionId
                        && a.messageId === updated.messageId
                        && a.status === 'pending',
                );
                if (sess && !hasPendingOnMsg) {
                    sess.interruptedCheckpoint = {
                        messageId: updated.messageId,
                        reason: 'user_stop',
                        inFlightMessages: [],
                        roundsCompleted: 1,
                        createdAt: Date.now(),
                    };
                }
            }
            return updated;
        };

        activeHarness = mountAssistantHarness({
            runtime,
            initialSessionId: singleApprovalSession.id,
        });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();

        // 1. Single pending approval -> clicking 接受 collapses card & auto-invokes continueLastMessage
        const singleApproveBtn = shadowRoot.querySelector(
            '[data-approval-approve-btn="appr_ac_single"]',
        ) as HTMLButtonElement;
        expect(singleApproveBtn).toBeTruthy();
        singleApproveBtn.click();
        await settleLayout(8);

        expect(runtime.decideApprovalSpy).toHaveBeenCalledWith(
            'appr_ac_single',
            'approve',
            undefined,
        );
        expect(runtime.continueLastMessageSpy).toHaveBeenCalledTimes(1);
        expect(runtime.continueLastMessageSpy).toHaveBeenCalledWith(
            singleApprovalSession.id,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );

        const collapsedSingle = shadowRoot.querySelector(
            '[data-approval-id="appr_ac_single"]',
        ) as HTMLDivElement;
        expect(collapsedSingle.getAttribute('data-approval-collapsed')).toBe('true');
        expect(collapsedSingle.textContent).toContain('已接受：');
        expect(
            shadowRoot.querySelector('[data-assistant-message-content="a_ac_1"]')?.textContent,
        ).toContain('继续完成后的最终答复。');

        // 2. Multi-approval round -> first approval does NOT auto-continue; second approval DOES
        activeHarness.store.openAssistantSession(multiApprovalSession.id);
        await settleLayout(4);

        const m1ApproveBtn = shadowRoot.querySelector(
            '[data-approval-approve-btn="appr_ac_m1"]',
        ) as HTMLButtonElement;
        m1ApproveBtn.click();
        await settleLayout(6);

        expect(runtime.continueLastMessageSpy).toHaveBeenCalledTimes(1);
        expect(
            shadowRoot
                .querySelector('[data-approval-id="appr_ac_m1"]')
                ?.getAttribute('data-approval-collapsed'),
        ).toBe('true');

        const m2ApproveBtn = shadowRoot.querySelector(
            '[data-approval-approve-btn="appr_ac_m2"]',
        ) as HTMLButtonElement;
        m2ApproveBtn.click();
        await settleLayout(8);

        expect(runtime.continueLastMessageSpy).toHaveBeenCalledTimes(2);
        expect(runtime.continueLastMessageSpy).toHaveBeenLastCalledWith(
            multiApprovalSession.id,
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(
            shadowRoot.querySelector('[data-assistant-message-content="a_ac_2"]')?.textContent,
        ).toContain('继续完成后的最终答复。');
    });

    it('keeps generation running in the background when switching away from the assistant tab and reattaches on return', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const draftInput = shadowRoot.querySelector(
            'textarea[data-assistant-draft-input="true"]',
        ) as HTMLTextAreaElement;
        const sendBtn = shadowRoot.querySelector(
            '[data-assistant-send-btn="true"]',
        ) as HTMLButtonElement;

        const deferred = createDeferred<AssistantMessage | void>();
        activeHarness.runtime.nextSendDeferred = deferred;

        setInputValue(draftInput, '请在后台持续生成这段设定分析');
        await settleLayout(2);
        sendBtn.click();
        await settleLayout(4);

        const abortSignal = activeHarness.runtime.lastSendOptions?.signal;
        expect(abortSignal).toBeTruthy();
        expect(abortSignal?.aborted).toBe(false);
        expect(shadowRoot.querySelector('[data-assistant-stop-btn="true"]')).toBeTruthy();

        activeHarness.runtime.lastSendOptions?.onDelta?.('第一段分析...');
        await settleLayout(3);
        expect(shadowRoot.textContent).toContain('第一段分析...');

        // Switch to another Agentic console tab ('logs') while streaming is in progress.
        const logsTabBtn = shadowRoot.querySelector(
            'aside#ag-sidebar button[data-tab-id="logs"]',
        ) as HTMLButtonElement;
        expect(logsTabBtn).toBeTruthy();
        logsTabBtn.click();
        await settleLayout(4);

        expect(shadowRoot.querySelector('[data-view-id="assistant"]')).toBeNull();
        expect(abortSignal?.aborted).toBe(false);
        expect(activeHarness.runtime.abortSpy).not.toHaveBeenCalled();

        // Continue receiving deltas in the background while on another tab.
        activeHarness.runtime.lastSendOptions?.onDelta?.('第二段后台续写...');
        await settleLayout(2);
        expect(activeHarness.store.getSnapshot().assistantStreamingSessionId).toBe('ast_session_1');
        expect(activeHarness.store.getSnapshot().assistantStreamingDeltas['ast_session_1']).toBe(
            '第一段分析...第二段后台续写...',
        );

        // Switch back to the assistant tab and verify live stream state & stop control reattach cleanly.
        const assistantTabBtn = shadowRoot.querySelector(
            'aside#ag-sidebar button[data-tab-id="assistant"]',
        ) as HTMLButtonElement;
        expect(assistantTabBtn).toBeTruthy();
        assistantTabBtn.click();
        await settleLayout(4);

        const stopBtnAfterReturn = shadowRoot.querySelector(
            '[data-assistant-stop-btn="true"]',
        ) as HTMLButtonElement;
        expect(stopBtnAfterReturn).toBeTruthy();
        expect(shadowRoot.querySelector('.ag-ast-streaming-cursor')).toBeTruthy();
        expect(shadowRoot.textContent).toContain('第一段分析...第二段后台续写...');

        // Clicking Stop after returning must abort the original AbortSignal and runtime session.
        stopBtnAfterReturn.click();
        deferred.resolve(undefined);
        await settleLayout(4);

        expect(abortSignal?.aborted).toBe(true);
        expect(activeHarness.runtime.abortSpy).toHaveBeenCalledWith('ast_session_1');
        expect(shadowRoot.querySelector('[data-assistant-stop-btn="true"]')).toBeNull();
        expect(shadowRoot.querySelector('[data-assistant-send-btn="true"]')).toBeTruthy();
    });

    it('completes background assistant generation while on another tab and renders final reply on return', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountAssistantHarness();
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const draftInput = shadowRoot.querySelector(
            'textarea[data-assistant-draft-input="true"]',
        ) as HTMLTextAreaElement;
        const sendBtn = shadowRoot.querySelector(
            '[data-assistant-send-btn="true"]',
        ) as HTMLButtonElement;

        const deferred = createDeferred<AssistantMessage | void>();
        activeHarness.runtime.nextSendDeferred = deferred;

        setInputValue(draftInput, '切走标签页后完成回复');
        await settleLayout(2);
        sendBtn.click();
        await settleLayout(4);

        const abortSignal = activeHarness.runtime.lastSendOptions?.signal;
        expect(abortSignal?.aborted).toBe(false);

        const logsTabBtn = shadowRoot.querySelector(
            'aside#ag-sidebar button[data-tab-id="logs"]',
        ) as HTMLButtonElement;
        logsTabBtn.click();
        await settleLayout(4);

        expect(shadowRoot.querySelector('[data-view-id="assistant"]')).toBeNull();
        expect(abortSignal?.aborted).toBe(false);

        // Complete the stream while viewing the Logs tab.
        deferred.resolve({
            id: 'ast_bg_done',
            role: 'assistant',
            content: '后台生成已完成。',
            timestamp: Date.now(),
        });
        await settleLayout(6);

        expect(activeHarness.store.getSnapshot().assistantStreamingSessionId).toBeNull();
        expect(activeHarness.store.getSnapshot().assistantStreamingSessionIds).toEqual([]);

        const assistantTabBtn = shadowRoot.querySelector(
            'aside#ag-sidebar button[data-tab-id="assistant"]',
        ) as HTMLButtonElement;
        assistantTabBtn.click();
        await settleLayout(4);

        expect(shadowRoot.textContent).toContain('后台生成已完成。');
        expect(shadowRoot.querySelector('[data-assistant-stop-btn="true"]')).toBeNull();
        expect(shadowRoot.querySelector('[data-assistant-send-btn="true"]')).toBeTruthy();
    });
});
