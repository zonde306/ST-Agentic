import { render } from 'preact';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type {
    AssistantAttachment,
    AssistantMessage,
    AssistantSession,
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
    abortSpy: Mock<(...args: unknown[]) => void>;
    decideApprovalSpy: Mock<(...args: unknown[]) => void>;
    retryApprovalSpy: Mock<(...args: unknown[]) => void>;
    applyUndoSpy: Mock<(...args: unknown[]) => void>;
    nextSendDeferred: Deferred<AssistantMessage | void> | null;
    lastSendOptions: {
        attachments?: AssistantAttachment[];
        onDelta?: (delta: string) => void;
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
                return deferred.promise;
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
        expect(sendBtn.textContent?.trim()).toBe('▶');
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
        expect(stopBtn.textContent?.trim()).toBe('■');
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
        expect(restoredSendBtn.textContent?.trim()).toBe('▶');
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

        // Popover closes on chat/adjust; reopen to select adjust
        getModeBtn().click();
        await settleLayout(3);
        (shadowRoot.querySelector('[data-assistant-mode-option="adjust"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'adjust', stAdminEnabled: false },
        );
        expect(getModeBtn().textContent).toContain('调整');

        // Reopen and switch to author -> popover stays open and exposes autoApproveAuthor checkbox
        getModeBtn().click();
        await settleLayout(3);
        (shadowRoot.querySelector('[data-assistant-mode-option="author"]') as HTMLButtonElement).click();
        await settleLayout(3);
        expect(activeHarness.runtime.updateSessionConfigSpy).toHaveBeenLastCalledWith(
            'ast_session_1',
            { mode: 'author', stAdminEnabled: false },
        );

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
});
