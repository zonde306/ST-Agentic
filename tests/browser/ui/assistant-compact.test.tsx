import { render } from 'preact';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type {
    AssistantCompactOptions,
    AssistantCompactReport,
    AssistantCompactionNotice,
    AssistantMessage,
    AssistantSession,
    AssistantSessionTokenStatus,
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

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function settleLayout(frames = 5): Promise<void> {
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
        '.ag-modal',
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

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

interface CompactMockController {
    bridge: AssistantRuntimeBridge;
    sessions: AssistantSession[];
    tokenStatusBySession: Map<string, AssistantSessionTokenStatus>;
    getSessionTokenStatusSpy: Mock<(sessionId: string) => AssistantSessionTokenStatus | null>;
    compactSessionSpy: Mock<
        (sessionId: string, options?: AssistantCompactOptions) => Promise<AssistantCompactReport>
    >;
    regenerateLastMessageSpy: Mock<(sessionId: string) => Promise<AssistantMessage>>;
    retractMessageSpy: Mock<(sessionId: string, messageId: string) => void>;
    failNextCompactWith: string | null;
    notify: () => void;
}

function createCompactMockController(options: {
    sessions?: AssistantSession[];
    tokenStatuses?: Record<string, AssistantSessionTokenStatus>;
} = {}): CompactMockController {
    const now = 1732400000000;
    const defaultSession: AssistantSession = {
        id: 'ast_compact_1',
        title: '超长世界书排查与上下文防爆测试会话标题用于验证移动端省略号截断',
        mode: 'adjust',
        stAdminEnabled: false,
        autoApproveAuthor: false,
        autoApproveChatDelete: false,
        connectionId: 'inherit',
        updatedAt: now,
        messages: [
            {
                id: 'msg_u1',
                role: 'user',
                content: '第一轮：读取全量世界书并排查重复触发词。',
                timestamp: now - 120_000,
            },
            {
                id: 'msg_a1',
                role: 'assistant',
                content: '已读取全部启用世界书条目，共发现 3 条高冲突触发词。',
                timestamp: now - 100_000,
            },
            {
                id: 'msg_u2',
                role: 'user',
                content: '第二轮：继续检查角色变量与最近对话轨迹。',
                timestamp: now - 60_000,
            },
            {
                id: 'msg_a2',
                role: 'assistant',
                content: '变量快照核对完成，等待下一步调整指令。',
                timestamp: now - 40_000,
            },
        ],
    };

    const sessions = options.sessions
        ? structuredClone(options.sessions)
        : [defaultSession];

    const tokenStatusBySession = new Map<string, AssistantSessionTokenStatus>();
    if (options.tokenStatuses) {
        for (const [sid, st] of Object.entries(options.tokenStatuses)) {
            tokenStatusBySession.set(sid, structuredClone(st));
        }
    } else {
        tokenStatusBySession.set('ast_compact_1', {
            sessionId: 'ast_compact_1',
            currentTokens: 62_840,
            contextLimit: 128_000,
            highWatermark: 96_000,
            lowWatermark: 32_000,
            usagePercent: 49,
            level: 'normal',
            activeTurnCount: 12,
            activeMessageCount: 28,
            foldableToolResultCount: 6,
            compactedCount: 0,
            summaryPreview: '上次交接摘要：已完成青云宗主世界书关键词分类。',
            isCompacting: false,
        });
    }

    const listeners = new Set<() => void>();
    const notify = () => {
        for (const fn of Array.from(listeners)) {
            fn();
        }
    };

    const controller: CompactMockController = {
        bridge: null as unknown as AssistantRuntimeBridge,
        sessions,
        tokenStatusBySession,
        getSessionTokenStatusSpy: vi.fn((sessionId: string) => {
            const st = tokenStatusBySession.get(sessionId);
            return st ? structuredClone(st) : null;
        }),
        compactSessionSpy: vi.fn(),
        regenerateLastMessageSpy: vi.fn(),
        retractMessageSpy: vi.fn(),
        failNextCompactWith: null,
        notify,
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
                title: createOpts?.title ?? '新会话',
                mode: createOpts?.mode ?? 'chat',
                stAdminEnabled: Boolean(createOpts?.stAdminEnabled),
                autoApproveAuthor: Boolean(createOpts?.autoApproveAuthor),
                connectionId: createOpts?.connectionId ?? 'inherit',
                updatedAt: Date.now(),
                messages: [],
            };
            controller.sessions.unshift(created);
            tokenStatusBySession.set(created.id, {
                sessionId: created.id,
                currentTokens: 867,
                contextLimit: 128_000,
                highWatermark: 96_000,
                lowWatermark: 32_000,
                usagePercent: 1,
                level: 'normal',
                activeTurnCount: 0,
                activeMessageCount: 0,
                foldableToolResultCount: 0,
                compactedCount: 0,
            });
            notify();
            return structuredClone(created);
        },
        sendPrompt: async (sessionId, prompt) => {
            const target = controller.sessions.find((s) => s.id === sessionId);
            const reply: AssistantMessage = {
                id: `reply_${Date.now()}`,
                role: 'assistant',
                content: `OK: ${prompt}`,
                timestamp: Date.now(),
            };
            target?.messages.push(reply);
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
            notify();
            return {
                session: structuredClone(target),
                removedMessages,
            };
        },
        regenerateLastMessage: async (sessionId, sendOpts) => {
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
            target.messages = target.messages.slice(0, Math.max(0, lastUserIdx + 1));
            const reply: AssistantMessage = {
                id: `regen_${Date.now()}`,
                role: 'assistant',
                content: '压缩历史后已成功重新生成回复。',
                timestamp: Date.now(),
            };
            target.messages.push(reply);
            target.updatedAt = reply.timestamp;
            sendOpts?.onUpdate?.(structuredClone(target));
            notify();
            await controller.regenerateLastMessageSpy(sessionId);
            return structuredClone(reply);
        },
        decideApproval: async () => null,
        retryApproval: async () => null,
        applyUndo: async () => null,
        getSessionTokenStatus: (sessionId) => controller.getSessionTokenStatusSpy(sessionId),
        compactSession: async (sessionId, compactOptions) => {
            if (controller.failNextCompactWith) {
                const msg = controller.failNextCompactWith;
                controller.failNextCompactWith = null;
                throw new Error(msg);
            }

            const session = controller.sessions.find((s) => s.id === sessionId);
            const status = tokenStatusBySession.get(sessionId);
            if (!session || !status) {
                throw new Error(`Session not found: ${sessionId}`);
            }

            const mode = compactOptions?.mode ?? 'auto';
            const focus = compactOptions?.focusInstruction?.trim();
            const tokensBefore = status.currentTokens;
            const folded = status.foldableToolResultCount;
            const ts = Date.now();

            let report: AssistantCompactReport;
            if (mode === 'fold_only') {
                const tokensAfter = 24_800;
                status.currentTokens = tokensAfter;
                status.usagePercent = Math.round((tokensAfter / status.contextLimit) * 100);
                status.level = 'normal';
                status.foldableToolResultCount = 0;

                const notice: AssistantCompactionNotice = {
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns: 0,
                    summaryMode: 'fold_only',
                    timestamp: ts,
                };
                if (session.messages.length > 0) {
                    session.messages[session.messages.length - 1] = {
                        ...session.messages[session.messages.length - 1],
                        compactionNotice: notice,
                    };
                }
                session.updatedAt = ts;

                report = {
                    compacted: true,
                    reason: 'manual',
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns: 0,
                    summaryMode: 'fold_only',
                    timestamp: ts,
                };
            } else {
                const tokensAfter = 5_400;
                const archivedTurns = 10;
                const summaryText = [
                    '1. 用户核心目标：梳理世界书触发路由并消除冲突。',
                    ...(focus ? [`2. 重点保留：${focus}`] : []),
                    '3. 待继续步骤：完成剩余条目的精确查询与修正。',
                ].join('\n');
                const archivedChunkPath = `/side/.assistant-archive/${sessionId}/chunk-001.md`;

                status.currentTokens = tokensAfter;
                status.usagePercent = Math.round((tokensAfter / status.contextLimit) * 100);
                status.level = 'normal';
                status.foldableToolResultCount = 0;
                status.activeTurnCount = 2;
                status.compactedCount += 1;
                status.summaryPreview = summaryText;

                const notice: AssistantCompactionNotice = {
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns,
                    summaryMode: 'llm',
                    summaryText,
                    ...(focus ? { focusInstruction: focus } : {}),
                    archivedChunkPath,
                    timestamp: ts,
                };
                if (session.messages.length > 0) {
                    session.messages[session.messages.length - 1] = {
                        ...session.messages[session.messages.length - 1],
                        compactionNotice: notice,
                    };
                }
                session.updatedAt = ts;

                report = {
                    compacted: true,
                    reason: 'manual',
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns,
                    archivedChunkPath,
                    summaryMode: 'llm',
                    summaryText,
                    timestamp: ts,
                };
            }

            controller.compactSessionSpy(sessionId, compactOptions);
            notify();
            return report;
        },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };

    controller.bridge = bridge;
    return controller;
}

interface MountedHarness {
    store: AppStore;
    controller: CompactMockController;
    shellContainer: HTMLDivElement;
    cleanup: () => void;
}

function mountHarness(options: {
    controller?: CompactMockController;
    initialSessionId?: string;
    initialMobileAssistantStack?: 'list' | 'detail';
} = {}): MountedHarness {
    const unregisterAssistant = registerAssistantView();
    const controller = options.controller ?? createCompactMockController();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab: 'assistant',
        initialAssistantSessionId: options.initialSessionId ?? controller.sessions[0]?.id ?? null,
        initialMobileAssistantStack: options.initialMobileAssistantStack ?? 'detail',
        initialAssistantSessions: controller.sessions,
        services: createMockUIServices(),
        assistantRuntime: controller.bridge,
    });

    const shellContainer = document.createElement('div');
    shellContainer.setAttribute('data-test-compact-shell', 'true');
    document.body.appendChild(shellContainer);

    render(
        <AppStoreProvider store={store}>
            <AgenticAppShell store={store} />
        </AppStoreProvider>,
        shellContainer,
    );

    return {
        store,
        controller,
        shellContainer,
        cleanup: () => {
            render(null, shellContainer);
            shellContainer.remove();
            unregisterAssistant();
            store.dispose();
        },
    };
}

describe('Assistant Context Compaction & Overflow UI (C2.1)', () => {
    let activeHarness: MountedHarness | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        vi.restoreAllMocks();
        await page.viewport(1280, 800);
    });

    it('renders topbar token counter pill immediately left of ＋ across normal/warning/danger/compacting states', async () => {
        await page.viewport(1280, 800);
        const controller = createCompactMockController({
            tokenStatuses: {
                ast_compact_1: {
                    sessionId: 'ast_compact_1',
                    currentTokens: 867,
                    contextLimit: 128_000,
                    highWatermark: 96_000,
                    lowWatermark: 32_000,
                    usagePercent: 1,
                    level: 'normal',
                    activeTurnCount: 2,
                    activeMessageCount: 4,
                    foldableToolResultCount: 1,
                    compactedCount: 0,
                },
            },
        });
        activeHarness = mountHarness({ controller });
        await settleLayout(6);

        const { dialog, shadowRoot } = getShellElements();
        const tokenPill = shadowRoot.querySelector(
            '[data-assistant-token-pill="true"]',
        ) as HTMLButtonElement;
        const newBtn = shadowRoot.querySelector(
            '[data-assistant-new-session-btn="true"]',
        ) as HTMLButtonElement;

        expect(tokenPill).toBeTruthy();
        expect(newBtn).toBeTruthy();
        // Immediately to the LEFT of ＋ inside .ag-ast-topbar-right
        expect(tokenPill.nextElementSibling).toBe(newBtn);
        expect(tokenPill.textContent?.trim()).toBe('867 tok');
        expect(tokenPill.getAttribute('data-token-level')).toBe('normal');
        expect(tokenPill.classList.contains('ag-ast-token-normal')).toBe(true);
        expect(tokenPill.title).toContain('867');
        expect(tokenPill.title).toContain('128,000');
        expect(tokenPill.title).toContain('点击管理/压缩上下文');
        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:token-pill-normal');

        // Transition to warning (75% -> 96k/128k with highWatermark=110k)
        controller.tokenStatusBySession.set('ast_compact_1', {
            sessionId: 'ast_compact_1',
            currentTokens: 96_000,
            contextLimit: 128_000,
            highWatermark: 110_000,
            lowWatermark: 32_000,
            usagePercent: 75,
            level: 'warning',
            activeTurnCount: 8,
            activeMessageCount: 18,
            foldableToolResultCount: 4,
            compactedCount: 0,
        });
        controller.sessions[0].updatedAt += 1;
        controller.notify();
        await settleLayout(6);

        expect(tokenPill.textContent?.trim()).toBe('96k');
        expect(tokenPill.getAttribute('data-token-level')).toBe('warning');
        expect(tokenPill.classList.contains('ag-ast-token-warning')).toBe(true);

        // Transition to danger (>=90%, 182k)
        controller.tokenStatusBySession.set('ast_compact_1', {
            sessionId: 'ast_compact_1',
            currentTokens: 182_000,
            contextLimit: 200_000,
            highWatermark: 160_000,
            lowWatermark: 40_000,
            usagePercent: 91,
            level: 'danger',
            activeTurnCount: 14,
            activeMessageCount: 34,
            foldableToolResultCount: 9,
            compactedCount: 1,
        });
        controller.sessions[0].updatedAt += 1;
        controller.notify();
        await settleLayout(6);

        expect(tokenPill.textContent?.trim()).toBe('182k');
        expect(tokenPill.getAttribute('data-token-level')).toBe('danger');
        expect(tokenPill.classList.contains('ag-ast-token-danger')).toBe(true);

        // Transition to isCompacting -> shows 压缩中... and disables button
        controller.tokenStatusBySession.set('ast_compact_1', {
            sessionId: 'ast_compact_1',
            currentTokens: 182_000,
            contextLimit: 200_000,
            highWatermark: 160_000,
            lowWatermark: 40_000,
            usagePercent: 91,
            level: 'danger',
            activeTurnCount: 14,
            activeMessageCount: 34,
            foldableToolResultCount: 9,
            compactedCount: 1,
            isCompacting: true,
        });
        controller.sessions[0].updatedAt += 1;
        controller.notify();
        await settleLayout(6);

        expect(tokenPill.textContent?.trim()).toBe('压缩中...');
        expect(tokenPill.disabled).toBe(true);
        expect(tokenPill.classList.contains('ag-ast-token-compacting')).toBe(true);
    });

    it('opens compaction ShadowModal, isolates keyboard events, supports fold_only and full compaction while preserving all UI messages', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountHarness();
        await settleLayout(6);

        const { dialog, shadowRoot } = getShellElements();
        const initialMessageCount = activeHarness.controller.sessions[0].messages.length;
        expect(initialMessageCount).toBe(4);

        const tokenPill = shadowRoot.querySelector(
            '[data-assistant-token-pill="true"]',
        ) as HTMLButtonElement;
        expect(tokenPill.textContent?.trim()).toBe('62.8k');

        // 1. Open compaction modal
        tokenPill.click();
        await settleLayout(5);

        const modal = shadowRoot.querySelector('[data-assistant-compact-modal="true"]') as HTMLDivElement;
        expect(modal).toBeTruthy();
        expect(shadowRoot.querySelector('.ag-modal-title')?.textContent).toBe('压缩当前会话上下文');
        expect(modal.textContent).toContain('62,840 / 128,000 tok (49%)');
        expect(modal.textContent).toContain('当前活跃 12 轮 · 包含 6 条可折叠旧工具输出 · 已归档 0 块');
        expect(modal.textContent).toContain('仅精简发给模型的轨迹上下文，界面聊天记录、审批卡与写前撤销记录将完整保留。');

        // Expand existing summary preview
        const previewToggle = modal.querySelector(
            '[data-assistant-compact-preview-toggle="true"]',
        ) as HTMLButtonElement;
        expect(previewToggle).toBeTruthy();
        previewToggle.click();
        await settleLayout(3);
        expect(
            modal.querySelector('[data-assistant-compact-preview-body="true"]')?.textContent,
        ).toContain('已完成青云宗主世界书关键词分类');

        // 2. Verify keyboard stopPropagation on focus instruction textarea
        const focusTextarea = modal.querySelector(
            'textarea[data-assistant-compact-focus="true"]',
        ) as HTMLTextAreaElement;
        expect(focusTextarea).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(focusTextarea).fontSize)).toBeGreaterThanOrEqual(16);

        const winKeyDown = vi.fn();
        const winKeyUp = vi.fn();
        const docKeyDown = vi.fn();
        const docKeyUp = vi.fn();
        window.addEventListener('keydown', winKeyDown);
        window.addEventListener('keyup', winKeyUp);
        document.addEventListener('keydown', docKeyDown);
        document.addEventListener('keyup', docKeyUp);

        try {
            focusTextarea.focus();
            for (const key of ['ArrowLeft', 'ArrowRight', 'a']) {
                focusTextarea.dispatchEvent(
                    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true }),
                );
                focusTextarea.dispatchEvent(
                    new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, composed: true }),
                );
            }
            await userEvent.keyboard('{ArrowLeft}{ArrowRight}');

            expect(winKeyDown).toHaveBeenCalledTimes(0);
            expect(winKeyUp).toHaveBeenCalledTimes(0);
            expect(docKeyDown).toHaveBeenCalledTimes(0);
            expect(docKeyUp).toHaveBeenCalledTimes(0);
        } finally {
            window.removeEventListener('keydown', winKeyDown);
            window.removeEventListener('keyup', winKeyUp);
            document.removeEventListener('keydown', docKeyDown);
            document.removeEventListener('keyup', docKeyUp);
        }

        // 3. Test "仅折叠旧工具" -> calls compactSession(sessionId, { mode: 'fold_only' })
        const foldBtn = shadowRoot.querySelector(
            '[data-assistant-compact-fold="true"]',
        ) as HTMLButtonElement;
        expect(foldBtn).toBeTruthy();
        expect(foldBtn.disabled).toBe(false);
        foldBtn.click();
        await settleLayout(6);

        expect(activeHarness.controller.compactSessionSpy).toHaveBeenCalledWith('ast_compact_1', {
            mode: 'fold_only',
        });
        expect(shadowRoot.querySelector('[data-assistant-compact-modal="true"]')).toBeNull();
        expect(tokenPill.textContent?.trim()).toBe('24.8k');
        expect(shadowRoot.querySelectorAll('[data-assistant-message]').length).toBe(initialMessageCount);

        // 4. Re-open modal -> fold_only is now disabled (0 foldable tools); verify error handling first
        tokenPill.click();
        await settleLayout(5);
        const foldBtnDisabled = shadowRoot.querySelector(
            '[data-assistant-compact-fold="true"]',
        ) as HTMLButtonElement;
        expect(foldBtnDisabled.disabled).toBe(true);

        const focusTextarea2 = shadowRoot.querySelector(
            'textarea[data-assistant-compact-focus="true"]',
        ) as HTMLTextAreaElement;
        setInputValue(focusTextarea2, '保留世界书路由改造细节与变量校验规则');
        await settleLayout(2);

        activeHarness.controller.failNextCompactWith = 'Mock network timeout';
        (shadowRoot.querySelector('[data-assistant-compact-confirm="true"]') as HTMLButtonElement).click();
        await settleLayout(5);
        expect(
            shadowRoot.querySelector('[data-assistant-compact-error="true"]')?.textContent,
        ).toContain('Mock network timeout');

        // 5. Confirm full compaction with focusInstruction -> preserves all messages, updates pill, renders separator pill + summary
        (shadowRoot.querySelector('[data-assistant-compact-confirm="true"]') as HTMLButtonElement).click();
        await settleLayout(6);

        expect(activeHarness.controller.compactSessionSpy).toHaveBeenLastCalledWith('ast_compact_1', {
            mode: 'full',
            focusInstruction: '保留世界书路由改造细节与变量校验规则',
        });
        expect(shadowRoot.querySelector('[data-assistant-compact-modal="true"]')).toBeNull();
        expect(tokenPill.textContent?.trim()).toBe('5.4k');

        // ALL UI messages MUST be preserved!
        expect(shadowRoot.querySelectorAll('[data-assistant-message]').length).toBe(initialMessageCount);
        expect(shadowRoot.textContent).toContain('第一轮：读取全量世界书并排查重复触发词。');

        // Compaction separator pill renders and expands handoff summary
        const sepToggle = shadowRoot.querySelector(
            '[data-assistant-compaction-toggle="msg_a2"]',
        ) as HTMLButtonElement;
        expect(sepToggle).toBeTruthy();
        expect(sepToggle.textContent).toContain('已压缩上下文：24.8k → 5.4k tok（归档 10 轮 · 折叠 0 条工具输出）');
        expect(sepToggle.textContent).toContain('查看交接摘要');

        sepToggle.click();
        await settleLayout(4);

        const summaryPanel = shadowRoot.querySelector(
            '[data-assistant-compaction-summary="msg_a2"]',
        ) as HTMLDivElement;
        expect(summaryPanel).toBeTruthy();
        expect(summaryPanel.textContent).toContain('保留世界书路由改造细节与变量校验规则');
        expect(summaryPanel.textContent).toContain('/side/.assistant-archive/ast_compact_1/chunk-001.md');
        expect(summaryPanel.textContent).toContain('梳理世界书触发路由并消除冲突');
        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:after-full-compaction');
    });

    it('renders context_overflow escape actions (压缩历史后重试 & 撤回本轮消息) and invokes callbacks', async () => {
        await page.viewport(1280, 800);
        const now = 1732400100000;
        const overflowSession: AssistantSession = {
            id: 'ast_overflow_1',
            title: '超限自愈逃生测试',
            mode: 'chat',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: now,
            messages: [
                {
                    id: 'ov_u1',
                    role: 'user',
                    content: '请分析这份超长日志附件。',
                    timestamp: now - 10_000,
                },
                {
                    id: 'ov_a1',
                    role: 'assistant',
                    content: '[Error] The input token count exceeds the maximum number of tokens allowed (1048576).',
                    interrupted: true,
                    errorCode: 'context_overflow',
                    timestamp: now - 5_000,
                },
            ],
        };

        const controller = createCompactMockController({
            sessions: [overflowSession],
            tokenStatuses: {
                ast_overflow_1: {
                    sessionId: 'ast_overflow_1',
                    currentTokens: 1_060_000,
                    contextLimit: 1_048_576,
                    highWatermark: 900_000,
                    lowWatermark: 300_000,
                    usagePercent: 100,
                    level: 'danger',
                    activeTurnCount: 6,
                    activeMessageCount: 14,
                    foldableToolResultCount: 3,
                    compactedCount: 0,
                },
            },
        });
        activeHarness = mountHarness({ controller, initialSessionId: 'ast_overflow_1' });
        await settleLayout(6);

        const { shadowRoot } = getShellElements();
        const escapeBox = shadowRoot.querySelector(
            '[data-assistant-overflow-escape="ov_a1"]',
        ) as HTMLDivElement;
        expect(escapeBox).toBeTruthy();

        const compactRetryBtn = escapeBox.querySelector(
            '[data-overflow-action="compact-retry"]',
        ) as HTMLButtonElement;
        const retractBtn = escapeBox.querySelector(
            '[data-overflow-action="retract"]',
        ) as HTMLButtonElement;
        expect(compactRetryBtn).toBeTruthy();
        expect(retractBtn).toBeTruthy();
        expect(compactRetryBtn.textContent?.trim()).toBe('压缩历史后重试');
        expect(retractBtn.textContent?.trim()).toBe('撤回本轮消息');

        // 1. Click "压缩历史后重试" -> runs full compactSession then regenerateLastMessage
        compactRetryBtn.click();
        await settleLayout(6);

        expect(controller.compactSessionSpy).toHaveBeenCalledWith('ast_overflow_1', { mode: 'full' });
        expect(controller.regenerateLastMessageSpy).toHaveBeenCalledWith('ast_overflow_1');
        expect(shadowRoot.textContent).toContain('压缩历史后已成功重新生成回复。');

        // 2. Re-mount overflow bubble and test "撤回本轮消息"
        activeHarness.cleanup();
        activeHarness = null;

        const controller2 = createCompactMockController({
            sessions: [structuredClone(overflowSession)],
            tokenStatuses: {
                ast_overflow_1: {
                    sessionId: 'ast_overflow_1',
                    currentTokens: 1_060_000,
                    contextLimit: 1_048_576,
                    highWatermark: 900_000,
                    lowWatermark: 300_000,
                    usagePercent: 100,
                    level: 'danger',
                    activeTurnCount: 6,
                    activeMessageCount: 14,
                    foldableToolResultCount: 3,
                    compactedCount: 0,
                },
            },
        });
        activeHarness = mountHarness({ controller: controller2, initialSessionId: 'ast_overflow_1' });
        await settleLayout(6);

        const { shadowRoot: sr2 } = getShellElements();
        const retractBtn2 = sr2.querySelector(
            '[data-assistant-overflow-escape="ov_a1"] [data-overflow-action="retract"]',
        ) as HTMLButtonElement;
        expect(retractBtn2).toBeTruthy();
        retractBtn2.click();
        await settleLayout(6);

        expect(controller2.retractMessageSpy).toHaveBeenCalledWith('ast_overflow_1', 'ov_a1');
        expect(sr2.querySelector('[data-assistant-message="ov_a1"]')).toBeNull();
    });

    it('enforces mobile (390x844) >=40px touch targets, >=16px focus textarea, title ellipsis, and zero horizontal overflow', async () => {
        await page.viewport(390, 844);
        const now = 1732400200000;
        const mobileSession: AssistantSession = {
            id: 'ast_compact_1',
            title: '超长移动端会话标题验证省略号截断且绝不挤破顶栏或产生横向滚动条',
            mode: 'adjust',
            stAdminEnabled: false,
            autoApproveAuthor: false,
            connectionId: 'inherit',
            updatedAt: now,
            messages: [
                {
                    id: 'm_u1',
                    role: 'user',
                    content: '测试移动端布局与超限逃生按钮。',
                    timestamp: now - 10_000,
                },
                {
                    id: 'm_a1',
                    role: 'assistant',
                    content: '[Error] Context length exceeded (128000 tokens).',
                    interrupted: true,
                    errorCode: 'context_overflow',
                    compactionNotice: {
                        tokensBefore: 62_840,
                        tokensAfter: 5_400,
                        foldedToolResults: 6,
                        archivedTurns: 10,
                        summaryMode: 'llm',
                        summaryText: '移动端交接摘要内容验证。',
                        timestamp: now - 4_000,
                    },
                    timestamp: now - 5_000,
                },
            ],
        };

        const controller = createCompactMockController({
            sessions: [mobileSession],
            tokenStatuses: {
                ast_compact_1: {
                    sessionId: 'ast_compact_1',
                    currentTokens: 98_400,
                    contextLimit: 128_000,
                    highWatermark: 96_000,
                    lowWatermark: 32_000,
                    usagePercent: 77,
                    level: 'danger',
                    activeTurnCount: 12,
                    activeMessageCount: 24,
                    foldableToolResultCount: 4,
                    compactedCount: 1,
                    summaryPreview: '已有移动端交接摘要预览。',
                },
            },
        });

        activeHarness = mountHarness({
            controller,
            initialSessionId: 'ast_compact_1',
            initialMobileAssistantStack: 'detail',
        });
        await settleLayout(6);

        const { dialog, shadowRoot } = getShellElements();

        // 1. Topbar token pill >=40px touch target, title ellipsis, zero horizontal overflow
        const tokenPill = shadowRoot.querySelector(
            '[data-assistant-token-pill="true"]',
        ) as HTMLButtonElement;
        expect(tokenPill).toBeTruthy();
        const pillRect = tokenPill.getBoundingClientRect();
        expect(pillRect.width).toBeGreaterThanOrEqual(40);
        expect(pillRect.height).toBeGreaterThanOrEqual(40);

        const titleEl = shadowRoot.querySelector(
            '[data-assistant-session-title="true"]',
        ) as HTMLSpanElement;
        const titleStyle = window.getComputedStyle(titleEl);
        expect(titleStyle.textOverflow).toBe('ellipsis');
        expect(titleStyle.whiteSpace).toBe('nowrap');

        // 2. Overflow escape buttons & compaction separator toggle >=40px height
        for (const btn of Array.from(
            shadowRoot.querySelectorAll(
                '[data-assistant-overflow-escape="m_a1"] button, [data-assistant-compaction-toggle="m_a1"]',
            ),
        )) {
            const rect = btn.getBoundingClientRect();
            expect(rect.height).toBeGreaterThanOrEqual(40);
            expect(rect.width).toBeGreaterThanOrEqual(40);
        }

        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:assistant-detail');

        // 3. Open compaction modal on mobile -> textarea font-size >=16px, buttons >=40px, zero overflow
        tokenPill.click();
        await settleLayout(5);

        const focusTextarea = shadowRoot.querySelector(
            'textarea[data-assistant-compact-focus="true"]',
        ) as HTMLTextAreaElement;
        expect(focusTextarea).toBeTruthy();
        expect(parseFloat(window.getComputedStyle(focusTextarea).fontSize)).toBeGreaterThanOrEqual(16);

        for (const btn of Array.from(shadowRoot.querySelectorAll('.ag-modal button')).filter(
            isElementVisible,
        )) {
            const rect = btn.getBoundingClientRect();
            expect(rect.height).toBeGreaterThanOrEqual(40);
            expect(rect.width).toBeGreaterThanOrEqual(40);
        }

        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:compact-modal');
    });
});
