import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { resolveActivePreset } from '@/core/config';
import type { AgentRunTrace, ConsoleTabId } from '@/core/types';
import { registerAssistantView } from '@/ui/assistant';
import { registerSessionViews } from '@/ui/session';
import { AgenticAppShell } from '@/ui/shell';
import { registerSideGenView } from '@/ui/sidegen';
import {
    type AgenticUIServices,
    AppStore,
    AppStoreProvider,
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
} from '@/ui/store';
import { registerStudioViews } from '@/ui/studio';

interface MountedHarness {
    store: AppStore;
    shellContainer: HTMLDivElement;
    cleanup: () => void;
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

function isElementVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') {
        return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && el.getClientRects().length > 0;
}

function getShellElements(): {
    dialog: HTMLDialogElement;
    shadowRoot: ShadowRoot;
} {
    const dialog = document.querySelector('dialog#agentic-app') as HTMLDialogElement | null;
    if (!dialog) {
        throw new Error('Expected <dialog id="agentic-app"> to be mounted');
    }
    const shadowHost = dialog.querySelector(
        '[data-agentic-shadow-host="true"]',
    ) as HTMLDivElement | null;
    if (!shadowHost || !shadowHost.shadowRoot) {
        throw new Error('Expected open ShadowRoot inside <dialog id="agentic-app">');
    }
    return { dialog, shadowRoot: shadowHost.shadowRoot };
}

function createHarness(options: {
    initialTab: ConsoleTabId;
    initialTraces?: AgentRunTrace[];
    services?: AgenticUIServices;
}): MountedHarness {
    const unregisterAssistant = registerAssistantView();
    const unregisterSideGen = registerSideGenView();
    const unregisterSession = registerSessionViews();
    const unregisterStudio = registerStudioViews();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: options.initialTraces ?? createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab: options.initialTab,
        services: options.services ?? createMockUIServices(),
    });

    const shellContainer = document.createElement('div');
    shellContainer.setAttribute('data-test-shell-container', 'true');
    document.body.appendChild(shellContainer);

    render(
        <AppStoreProvider store={store}>
            <AgenticAppShell store={store} />
        </AppStoreProvider>,
        shellContainer,
    );

    return {
        store,
        shellContainer,
        cleanup: () => {
            render(null, shellContainer);
            shellContainer.remove();
            unregisterAssistant();
            unregisterSideGen();
            unregisterSession();
            unregisterStudio();
            store.dispose();
        },
    };
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
        el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function assertTouchTargetsAndInputs(shadowRoot: ShadowRoot, label: string): void {
    const interactive = Array.from(
        shadowRoot.querySelectorAll('button, [role="switch"], [role="radio"]'),
    ).filter(isElementVisible);
    expect(interactive.length, `${label}: expected visible interactive controls`).toBeGreaterThan(0);

    for (const el of interactive) {
        const rect = el.getBoundingClientRect();
        const name = el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName;
        expect(rect.width, `${label}: "${name}" width >= 40px`).toBeGreaterThanOrEqual(40);
        expect(rect.height, `${label}: "${name}" height >= 40px`).toBeGreaterThanOrEqual(40);
    }

    const inputs = Array.from(
        shadowRoot.querySelectorAll('input, select, textarea'),
    ).filter(isElementVisible);
    for (const el of inputs) {
        const fontSize = parseFloat(window.getComputedStyle(el).fontSize);
        const name = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName;
        expect(fontSize, `${label}: "${name}" fontSize >= 16px`).toBeGreaterThanOrEqual(16);
    }
}

function assertNoHorizontalOverflow(
    dialog: HTMLDialogElement,
    shadowRoot: ShadowRoot,
    label: string,
): void {
    const selectors = [
        '.ag-console',
        '.ag-main',
        '.ag-view-scroll',
        '.ag-modal',
        '.ag-modal-body',
        '.ag-split-detail',
        '.ag-stack-body',
    ];
    expect(dialog.scrollWidth, `${label}: dialog overflow`).toBeLessThanOrEqual(
        dialog.clientWidth + 1,
    );
    for (const selector of selectors) {
        for (const el of Array.from(shadowRoot.querySelectorAll(selector))) {
            if (isElementVisible(el)) {
                expect(
                    el.scrollWidth,
                    `${label}: ${selector} overflow (${el.scrollWidth} > ${el.clientWidth})`,
                ).toBeLessThanOrEqual(el.clientWidth + 1);
            }
        }
    }
}

function makeBaseTrace(overrides: Partial<AgentRunTrace> = {}): AgentRunTrace {
    const now = Date.now();
    return {
        runId: 'run_wave2_base',
        target: { messageId: 12, swipeId: 0 },
        phase: 'main_turn',
        agentProfileId: 'main',
        agentName: '主叙事 Agent',
        connectionId: 'conn_claude',
        model: 'anthropic/claude-sonnet-4.5',
        status: 'completed',
        startedAt: now - 4000,
        endedAt: now - 1000,
        durationMs: 3000,
        usage: {
            inputTokens: 8000,
            cachedTokens: 6400,
            outputTokens: 320,
            totalTokens: 8320,
            cacheHitRate: 0.8,
        },
        toolSteps: [],
        ...overrides,
    };
}

describe('Console UI Wave 2 Views (LogsView, PromptsView, CacheStorageView, PipelineView)', () => {
    let activeHarness: MountedHarness | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        await page.viewport(1280, 800);
    });

    it('LogsView renders Stop for running, SplitActionButton (continue/rollback/retry) for recoverable states, interleaved rounds, and converged summary', async () => {
        const stopSpy = vi.fn<(trace: AgentRunTrace) => Promise<boolean>>(async () => true);
        const continueSpy = vi.fn<
            (trace: AgentRunTrace, options?: { rollbackLastToolRound?: boolean }) => Promise<void>
        >(async () => undefined);
        const retrySpy = vi.fn<(trace: AgentRunTrace) => Promise<void>>(async () => undefined);
        const rerunSpy = vi.fn(async () => undefined);

        const runningTrace = makeBaseTrace({
            runId: 'run_live_1',
            status: 'running',
            taskId: 'task_live_1',
        });

        const errorWithToolsTrace = makeBaseTrace({
            runId: 'run_err_tools',
            status: 'error',
            error: 'HTTP 502 Bad Gateway',
            hasRollbackableRound: true,
            toolSteps: [
                {
                    stepIndex: 0,
                    toolCallId: 'call_r0',
                    toolName: 'read_file',
                    args: { path: '/state/variables.json' },
                    result: '{"hp":80}',
                    ok: true,
                    durationMs: 12,
                    startedAt: Date.now() - 3000,
                },
                {
                    stepIndex: 1,
                    toolCallId: 'call_r1',
                    toolName: 'write_file',
                    args: { path: '/output.md' },
                    result: 'ok',
                    ok: true,
                    durationMs: 18,
                    startedAt: Date.now() - 2000,
                },
            ],
            assistantRounds: [
                {
                    roundIndex: 0,
                    beforeStepIndex: 0,
                    reasoning: '先确认当前变量中的灵力数值',
                    content: '我先查看一下当前角色状态。',
                    timestamp: Date.now() - 3200,
                },
                {
                    roundIndex: 1,
                    beforeStepIndex: 1,
                    reasoning: '已确认状态，准备写入正文',
                    content: '接下来整理输出正文。',
                    timestamp: Date.now() - 2200,
                },
                {
                    roundIndex: 2,
                    beforeStepIndex: 2,
                    reasoning: '尾段复核时上游超时',
                    timestamp: Date.now() - 1500,
                },
            ],
            // New-format trace with assistantRounds and NO assistantSummary -> summary card must NOT show outputPreview!
            outputPreview: '这段中间轮预览不应被强行塞进摘要卡片',
        });

        const interruptedNoStepsTrace = makeBaseTrace({
            runId: 'run_interrupted_empty',
            status: 'interrupted',
            interruptedReason: 'user_stop',
            hasRollbackableRound: false,
            toolSteps: [],
        });

        const completedWithSummaryTrace = makeBaseTrace({
            runId: 'run_done_summary',
            phase: 'after_turn',
            triggerId: 'tr_vars',
            triggerLabel: '好感与灵力结算',
            status: 'completed',
            assistantRounds: [
                {
                    roundIndex: 0,
                    beforeStepIndex: 0,
                    reasoning: '核对好感度增量',
                    content: '完整结算摘要正文：林婉儿好感 +2，当前为 64。',
                    isFinishTurn: true,
                    finishTurnSummary: '完整结算摘要正文：林婉儿好感 +2，当前为 64。',
                    timestamp: Date.now() - 1000,
                },
            ],
            assistantSummary: '完整结算摘要正文：林婉儿好感 +2，当前为 64。',
        });

        const allTraces = [
            runningTrace,
            errorWithToolsTrace,
            interruptedNoStepsTrace,
            completedWithSummaryTrace,
        ];

        const baseServices = createMockUIServices();
        const services: AgenticUIServices = {
            ...baseServices,
            listTraces: async () => allTraces,
            stopTrace: stopSpy,
            continueTrace: continueSpy,
            retryTrace: retrySpy,
            rerunAfterTurn: rerunSpy,
        };

        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            activeHarness = createHarness({
                initialTab: 'logs',
                initialTraces: allTraces,
                services,
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            const backToList = async () => {
                if (!vp.isMobile) {
                    return;
                }
                const backBtn = shadowRoot.querySelector(
                    'button.ag-stack-back-btn',
                ) as HTMLButtonElement | null;
                if (backBtn) {
                    backBtn.click();
                    await settleLayout(4);
                }
            };

            const selectRun = async (runId: string) => {
                await backToList();
                const btn = shadowRoot.querySelector(
                    `[data-log-run-item="${runId}"]`,
                ) as HTMLButtonElement | null;
                expect(btn, `${vp.label}: expected run item ${runId}`).toBeTruthy();
                btn!.click();
                await settleLayout(5);
            };

            // 1. Running trace -> ONLY single Stop button
            await selectRun('run_live_1');
            const stopBtn = shadowRoot.querySelector('button.ag-log-stop-btn') as HTMLButtonElement | null;
            expect(stopBtn, `${vp.label}: expected stop button for running trace`).toBeTruthy();
            expect(stopBtn!.textContent).toContain('停止');
            expect(shadowRoot.querySelector('.ag-log-recovery-btn')).toBeNull();
            expect(shadowRoot.querySelector('.ag-log-rerun-btn')).toBeNull();
            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:logs:running`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:logs:running`);

            stopBtn!.click();
            await vi.waitFor(() => {
                expect(stopSpy).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run_live_1' }));
            });

            // 2. Error trace with tool steps & assistantRounds -> SplitActionButton + interleaved rounds + no fake summary
            await selectRun('run_err_tools');
            expect(shadowRoot.querySelector('button.ag-log-stop-btn')).toBeNull();
            const mainContinueBtn = shadowRoot.querySelector(
                '.ag-log-recovery-btn .ag-split-btn-main',
            ) as HTMLButtonElement | null;
            const caretBtn = shadowRoot.querySelector(
                '.ag-log-recovery-btn .ag-split-btn-caret',
            ) as HTMLButtonElement | null;
            expect(mainContinueBtn).toBeTruthy();
            expect(caretBtn).toBeTruthy();
            expect(mainContinueBtn!.textContent).toContain('继续');

            // Verify interleaved round blocks appear in exact order relative to tool step cards
            const orderedNodes = Array.from(
                shadowRoot.querySelectorAll('[data-log-round-interlude], [data-log-step-card]'),
            );
            expect(orderedNodes).toHaveLength(5); // round0, step0, round1, step1, round2
            expect(orderedNodes[0].getAttribute('data-log-round-interlude')).toBe('0');
            expect(orderedNodes[1].getAttribute('data-log-step-index')).toBe('0');
            expect(orderedNodes[2].getAttribute('data-log-round-interlude')).toBe('1');
            expect(orderedNodes[3].getAttribute('data-log-step-index')).toBe('1');
            expect(orderedNodes[4].getAttribute('data-log-round-interlude')).toBe('2');

            // Reasoning is inside collapsible <details class="ag-round-reasoning">, content in .ag-round-content
            expect(orderedNodes[0].querySelector('details.ag-round-reasoning')?.textContent).toContain(
                '先确认当前变量中的灵力数值',
            );
            expect(orderedNodes[0].querySelector('.ag-round-content')?.textContent).toContain(
                '我先查看一下当前角色状态。',
            );

            // Summary card must NOT appear for new trace lacking assistantSummary
            expect(shadowRoot.querySelector('[data-log-assistant-summary="run_err_tools"]')).toBeNull();

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:logs:err-rounds`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:logs:err-rounds`);

            // Click main button -> calls continueTrace(trace)
            const prevContinueCount = continueSpy.mock.calls.length;
            mainContinueBtn!.click();
            await vi.waitFor(() => {
                expect(continueSpy.mock.calls.length).toBe(prevContinueCount + 1);
            });
            await settleLayout(5);
            expect(continueSpy.mock.calls[prevContinueCount][0]).toEqual(
                expect.objectContaining({ runId: 'run_err_tools' }),
            );
            expect(continueSpy.mock.calls[prevContinueCount][1]).toBeUndefined();

            // Re-query caret after continueTrace settles (SplitActionButton temporarily switches to Stop while busy)
            const freshCaretBtn = shadowRoot.querySelector(
                '.ag-log-recovery-btn .ag-split-btn-caret',
            ) as HTMLButtonElement | null;
            expect(freshCaretBtn, `${vp.label}: expected recovery split caret after settle`).toBeTruthy();

            // Open dropdown -> verify Rollback & Retry (enabled) and Retry
            freshCaretBtn!.click();
            await settleLayout(4);
            const rollbackItem = shadowRoot.querySelector(
                '[data-menu-item-id="rollback_retry"]',
            ) as HTMLButtonElement | null;
            const retryItem = shadowRoot.querySelector(
                '[data-menu-item-id="retry"]',
            ) as HTMLButtonElement | null;
            expect(rollbackItem).toBeTruthy();
            expect(rollbackItem!.disabled).toBe(false);
            expect(rollbackItem!.textContent).toContain('回退并重试');
            expect(rollbackItem!.textContent).toContain('回退最近 1 轮工具调用及暂存状态后继续');
            expect(retryItem).toBeTruthy();
            expect(retryItem!.textContent).toContain('重试');
            expect(retryItem!.textContent).toContain('清空断点，整轮从头重跑');

            rollbackItem!.click();
            await vi.waitFor(() => {
                expect(continueSpy.mock.calls.length).toBe(prevContinueCount + 2);
            });
            await settleLayout(5);
            expect(continueSpy.mock.calls[prevContinueCount + 1][1]).toEqual({
                rollbackLastToolRound: true,
            });

            // Open dropdown again -> click Retry
            const prevRetryCount = retrySpy.mock.calls.length;
            const freshCaretBtn2 = shadowRoot.querySelector(
                '.ag-log-recovery-btn .ag-split-btn-caret',
            ) as HTMLButtonElement | null;
            expect(freshCaretBtn2).toBeTruthy();
            freshCaretBtn2!.click();
            await settleLayout(4);
            (shadowRoot.querySelector('[data-menu-item-id="retry"]') as HTMLButtonElement).click();
            await vi.waitFor(() => {
                expect(retrySpy.mock.calls.length).toBe(prevRetryCount + 1);
            });
            await settleLayout(5);

            // 3. Interrupted trace with 0 steps & !hasRollbackableRound -> Rollback & Retry disabled with clear title
            await selectRun('run_interrupted_empty');
            const emptyCaret = shadowRoot.querySelector(
                '.ag-log-recovery-btn .ag-split-btn-caret',
            ) as HTMLButtonElement | null;
            expect(emptyCaret).toBeTruthy();
            emptyCaret!.click();
            await settleLayout(4);
            const disabledRollback = shadowRoot.querySelector(
                '[data-menu-item-id="rollback_retry"]',
            ) as HTMLButtonElement | null;
            expect(disabledRollback).toBeTruthy();
            expect(disabledRollback!.disabled).toBe(true);
            expect(disabledRollback!.title).toContain('尚无已完成工具轮可回退');

            // 4. Completed after_turn trace -> keeps simple "重跑此触发器" button & shows full assistantSummary
            await selectRun('run_done_summary');
            const simpleRerunBtn = shadowRoot.querySelector(
                'button.ag-log-rerun-btn',
            ) as HTMLButtonElement | null;
            expect(simpleRerunBtn).toBeTruthy();
            expect(simpleRerunBtn!.textContent).toContain('重跑此触发器');
            const summaryCard = shadowRoot.querySelector(
                '[data-log-assistant-summary="run_done_summary"]',
            ) as HTMLElement | null;
            expect(summaryCard).toBeTruthy();
            expect(summaryCard!.textContent).toContain('完整结算摘要正文：林婉儿好感 +2，当前为 64。');

            // 5. Search matches reasoning text inside assistantRounds
            await backToList();
            const searchInput = shadowRoot.querySelector(
                'input[aria-label="全局搜索生成日志"]',
            ) as HTMLInputElement;
            setInputValue(searchInput, '尾段复核时上游超时');
            await settleLayout(4);
            const matchedItems = Array.from(shadowRoot.querySelectorAll('[data-log-run-item]'));
            expect(matchedItems).toHaveLength(1);
            expect(matchedItems[0].getAttribute('data-log-run-item')).toBe('run_err_tools');
        }
    });

    it('LogsView flips to Stop button while continueTrace is in-flight and honors legacy service fallbacks', async () => {
        // 1. In-flight continueTrace flips SplitActionButton -> single Stop button
        let resolveContinue!: () => void;
        const pendingContinue = new Promise<void>((resolve) => {
            resolveContinue = resolve;
        });
        const stopSpy = vi.fn(async () => true);
        const abortedTrace = makeBaseTrace({
            runId: 'run_aborted_inflight',
            status: 'aborted',
            interruptedReason: 'user_stop',
            hasRollbackableRound: true,
        });
        const baseServices = createMockUIServices();
        activeHarness = createHarness({
            initialTab: 'logs',
            initialTraces: [abortedTrace],
            services: {
                ...baseServices,
                listTraces: async () => [abortedTrace],
                continueTrace: () => pendingContinue,
                stopTrace: stopSpy,
            },
        });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const mainBtn = shadowRoot.querySelector(
            '.ag-log-recovery-btn .ag-split-btn-main',
        ) as HTMLButtonElement;
        expect(mainBtn).toBeTruthy();
        mainBtn.click();
        await settleLayout(4);

        // While continueTrace is pending, ONLY Stop button is visible
        const stopBtn = shadowRoot.querySelector('button.ag-log-stop-btn') as HTMLButtonElement | null;
        expect(stopBtn).toBeTruthy();
        expect(shadowRoot.querySelector('.ag-log-recovery-btn')).toBeNull();
        stopBtn!.click();
        await vi.waitFor(() => {
            expect(stopSpy).toHaveBeenCalledTimes(1);
        });

        resolveContinue();
        await settleLayout(5);
        expect(shadowRoot.querySelector('.ag-log-recovery-btn .ag-split-btn-main')).toBeTruthy();

        activeHarness.cleanup();
        activeHarness = null;

        // 2. Legacy fallbacks when stopTrace / continueTrace / retryTrace are omitted
        const cancelTaskSpy = vi.fn(async () => undefined);
        const resumeTurnSpy = vi.fn(async () => undefined);
        const rerunAfterTurnSpy = vi.fn(async () => undefined);

        const legacyRunning = makeBaseTrace({
            runId: 'run_legacy_running',
            status: 'running',
            taskId: 'task_bg_99',
        });
        const legacyInterrupted = makeBaseTrace({
            runId: 'run_legacy_interrupted',
            status: 'interrupted',
            outputPreview: '旧日志回退摘要文本',
        });
        const legacyAfterTurnErr = makeBaseTrace({
            runId: 'run_legacy_after_err',
            phase: 'after_turn',
            triggerId: 'tr_legacy_1',
            status: 'error',
            error: 'Legacy fail',
        });
        const legacyTraces = [legacyRunning, legacyInterrupted, legacyAfterTurnErr];

        const legacyServicesBase: AgenticUIServices = {
            ...createMockUIServices(),
            stopTrace: undefined,
            continueTrace: undefined,
            retryTrace: undefined,
            listTraces: async () => legacyTraces,
            cancelBackgroundTask: cancelTaskSpy,
            resumeTurn: resumeTurnSpy,
            rerunAfterTurn: rerunAfterTurnSpy,
        };

        activeHarness = createHarness({
            initialTab: 'logs',
            initialTraces: legacyTraces,
            services: legacyServicesBase,
        });
        await settleLayout(5);

        const { shadowRoot: sr2 } = getShellElements();

        // Fallback Stop -> cancelBackgroundTask(taskId)
        (sr2.querySelector('button.ag-log-stop-btn') as HTMLButtonElement).click();
        await vi.waitFor(() => {
            expect(cancelTaskSpy).toHaveBeenCalledWith('task_bg_99');
        });

        // Fallback Continue -> resumeTurn(target) & legacy outputPreview fallback in summary card
        (sr2.querySelector('[data-log-run-item="run_legacy_interrupted"]') as HTMLButtonElement).click();
        await settleLayout(4);
        expect(
            sr2.querySelector('[data-log-assistant-summary="run_legacy_interrupted"]')?.textContent,
        ).toContain('旧日志回退摘要文本');
        (sr2.querySelector('.ag-log-recovery-btn .ag-split-btn-main') as HTMLButtonElement).click();
        await vi.waitFor(() => {
            expect(resumeTurnSpy).toHaveBeenCalledWith({ messageId: 12, swipeId: 0 });
        });
        await settleLayout(4);

        // Fallback Retry for after_turn -> rerunAfterTurn
        (sr2.querySelector('[data-log-run-item="run_legacy_after_err"]') as HTMLButtonElement).click();
        await settleLayout(4);
        (sr2.querySelector('.ag-log-recovery-btn .ag-split-btn-caret') as HTMLButtonElement).click();
        await settleLayout(4);
        (sr2.querySelector('[data-menu-item-id="retry"]') as HTMLButtonElement).click();
        await vi.waitFor(() => {
            expect(rerunAfterTurnSpy).toHaveBeenCalledWith(
                { messageId: 12, swipeId: 0 },
                { triggerIds: ['tr_legacy_1'] },
            );
        });
    });

    it('PromptsView opens preset preprocess/postprocess script modals, saves to activePreset, and shows active badge', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            activeHarness = createHarness({ initialTab: 'prompts' });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            const preBtn = shadowRoot.querySelector(
                'button.ag-preset-preprocess-btn',
            ) as HTMLButtonElement | null;
            const postBtn = shadowRoot.querySelector(
                'button.ag-preset-postprocess-btn',
            ) as HTMLButtonElement | null;
            expect(preBtn, `${vp.label}: expected 消息预处理 button`).toBeTruthy();
            expect(postBtn, `${vp.label}: expected 消息后处理 button`).toBeTruthy();
            expect(preBtn!.textContent).not.toContain('已启用');

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:prompts:header`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:prompts:header`);

            // 1. Open preprocess modal, enable, enter code, inspect ctx cheat sheet, and save
            preBtn!.click();
            await settleLayout(4);

            const preModal = shadowRoot.querySelector('.ag-modal') as HTMLElement | null;
            expect(preModal).toBeTruthy();
            expect(preModal!.querySelector('.ag-modal-title')?.textContent).toBe(
                '消息预处理脚本（发给 LLM 前）',
            );
            expect(preModal!.textContent).toContain('ctx.messages');
            expect(preModal!.textContent).toContain('ctx.body');
            expect(preModal!.textContent).toContain('ctx.event.data.layers');
            expect(preModal!.textContent).toContain('ctx.vars');

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:prompts:preprocess-modal`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:prompts:preprocess-modal`);

            const preSwitch = preModal!.querySelector('button[role="switch"]') as HTMLButtonElement;
            preSwitch.click();
            const preEditor = preModal!.querySelector(
                'textarea.ag-code-textarea',
            ) as HTMLTextAreaElement;
            setInputValue(preEditor, 'ctx.messages.appendHint("保持克制白描");');
            await settleLayout(3);

            const savePreBtn = Array.from(preModal!.querySelectorAll('button')).find(
                (btn) => btn.textContent?.trim() === '保存',
            ) as HTMLButtonElement;
            savePreBtn.click();
            await settleLayout(4);

            expect(shadowRoot.querySelector('.ag-modal')).toBeNull();
            const presetAfterPre = resolveActivePreset(activeHarness.store.getSnapshot().settings);
            expect(presetAfterPre.preprocessScript).toEqual({
                enabled: true,
                code: 'ctx.messages.appendHint("保持克制白描");',
            });
            expect(preBtn!.textContent).toContain('已启用');

            // 2. Open postprocess modal, verify ctx cheat sheet and save
            postBtn!.click();
            await settleLayout(4);

            const postModal = shadowRoot.querySelector('.ag-modal') as HTMLElement | null;
            expect(postModal).toBeTruthy();
            expect(postModal!.querySelector('.ag-modal-title')?.textContent).toBe(
                '消息后处理脚本（收到 LLM 返回时）',
            );
            expect(postModal!.textContent).toContain('ctx.output.text');
            expect(postModal!.textContent).toContain('ctx.output.content');
            expect(postModal!.textContent).toContain('ctx.control.retry');
            expect(postModal!.textContent).toContain('ctx.control.requestFix');

            const postSwitch = postModal!.querySelector('button[role="switch"]') as HTMLButtonElement;
            postSwitch.click();
            const postEditor = postModal!.querySelector(
                'textarea.ag-code-textarea',
            ) as HTMLTextAreaElement;
            setInputValue(postEditor, 'if (!ctx.output.text.trim()) ctx.control.retry("empty");');
            await settleLayout(3);

            const savePostBtn = Array.from(postModal!.querySelectorAll('button')).find(
                (btn) => btn.textContent?.trim() === '保存',
            ) as HTMLButtonElement;
            savePostBtn.click();
            await settleLayout(4);

            const presetAfterPost = resolveActivePreset(activeHarness.store.getSnapshot().settings);
            expect(presetAfterPost.postprocessScript).toEqual({
                enabled: true,
                code: 'if (!ctx.output.text.trim()) ctx.control.retry("empty");',
            });
            expect(postBtn!.textContent).toContain('已启用');
        }
    });

    it('CacheStorageView clears all prompt caches, refreshes telemetry, and shows non-destructive toast feedback', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            const baseServices = createMockUIServices();
            const getWatermarkSpy = vi.fn(() => baseServices.getWatermarkStatuses());
            const clearCacheSpy = vi.fn(async () => ({
                clearedPrefixes: 3,
                clearedVfsCache: 11,
                clearedLorebooks: 2,
            }));

            activeHarness = createHarness({
                initialTab: 'cache',
                services: {
                    ...baseServices,
                    getWatermarkStatuses: getWatermarkSpy,
                    clearAllPromptCaches: clearCacheSpy,
                },
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            const clearBtn = shadowRoot.querySelector(
                'button.ag-cache-clear-prompts-btn',
            ) as HTMLButtonElement | null;
            expect(clearBtn, `${vp.label}: expected 清除所有提示词缓存 button`).toBeTruthy();
            expect(clearBtn!.textContent).toContain('清除所有提示词缓存');
            expect(clearBtn!.classList.contains('ag-btn-secondary')).toBe(true);

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:cache`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:cache`);

            const initialTelemetryCalls = getWatermarkSpy.mock.calls.length;
            clearBtn!.click();

            await vi.waitFor(() => {
                expect(clearCacheSpy).toHaveBeenCalledTimes(1);
                expect(getWatermarkSpy.mock.calls.length).toBeGreaterThan(initialTelemetryCalls);
            });
            await settleLayout(4);

            const toasts = activeHarness.store.getSnapshot().toastQueue;
            const latestToast = toasts[toasts.length - 1];
            expect(latestToast?.tone).toBe('success');
            expect(latestToast?.message).toContain('前缀缓存 3 条');
            expect(latestToast?.message).toContain('VFS 缓存 11 条');
            expect(latestToast?.message).toContain('世界书缓存 2 条');
            expect(latestToast?.message).toContain('未删除聊天历史');
        }
    });

    it('PipelineView edits rule.events, shows prominent on:<event> badges, and filters/groups by event while preserving 4 swimlanes', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            activeHarness = createHarness({ initialTab: 'pipeline' });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            // Select tr_vars rule (open detail on mobile)
            const varsItem = shadowRoot.querySelector(
                '[data-pipeline-rule-id="tr_vars"]',
            ) as HTMLButtonElement | null;
            expect(varsItem, `${vp.label}: expected tr_vars item`).toBeTruthy();
            varsItem!.click();
            await settleLayout(5);

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:pipeline:detail`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pipeline:detail`);

            // Toggle generation_error & output_updated in detail panel
            const genErrToggle = shadowRoot.querySelector(
                '[data-pipeline-event-toggle="generation_error"]',
            ) as HTMLButtonElement | null;
            const outputToggle = shadowRoot.querySelector(
                '[data-pipeline-event-toggle="output_updated"]',
            ) as HTMLButtonElement | null;
            expect(genErrToggle).toBeTruthy();
            expect(outputToggle).toBeTruthy();

            genErrToggle!.click();
            outputToggle!.click();
            await settleLayout(4);

            const updatedRule = resolveActivePreset(
                activeHarness.store.getSnapshot().settings,
            ).triggers.find((r) => r.id === 'tr_vars');
            expect(updatedRule?.events).toEqual(['generation_error', 'output_updated']);

            // Return to list on mobile to verify master list badges and filters
            if (vp.isMobile) {
                const backBtn = shadowRoot.querySelector(
                    'button.ag-stack-back-btn',
                ) as HTMLButtonElement;
                backBtn.click();
                await settleLayout(4);
            }

            const updatedListItem = shadowRoot.querySelector(
                '[data-pipeline-rule-id="tr_vars"]',
            ) as HTMLButtonElement | null;
            expect(updatedListItem).toBeTruthy();
            expect(updatedListItem!.textContent).toContain('on:generation_error');
            expect(updatedListItem!.textContent).toContain('on:output_updated');

            // Switch to "仅事件" filter -> only tr_vars remains visible
            const eventsOnlyRadio = shadowRoot.querySelector(
                '[role="radiogroup"][aria-label="触发管线筛选视图"] [role="radio"][data-value="events_only"]',
            ) as HTMLButtonElement | null;
            expect(eventsOnlyRadio).toBeTruthy();
            eventsOnlyRadio!.click();
            await settleLayout(4);

            const filteredItems = Array.from(shadowRoot.querySelectorAll('[data-pipeline-rule-id]'));
            expect(filteredItems).toHaveLength(1);
            expect(filteredItems[0].getAttribute('data-pipeline-rule-id')).toBe('tr_vars');

            // Switch to "按事件分组" -> renders groups for generation_error & output_updated
            const byEventRadio = shadowRoot.querySelector(
                '[role="radiogroup"][aria-label="触发管线筛选视图"] [role="radio"][data-value="by_event"]',
            ) as HTMLButtonElement | null;
            expect(byEventRadio).toBeTruthy();
            byEventRadio!.click();
            await settleLayout(4);

            expect(
                shadowRoot.querySelector('[data-pipeline-event-group="generation_error"]'),
            ).toBeTruthy();
            expect(
                shadowRoot.querySelector('[data-pipeline-event-group="output_updated"]'),
            ).toBeTruthy();

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:pipeline:by-event`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pipeline:by-event`);

            // Switch back to "全部泳道" -> all 4 swimlanes remain intact
            const allRadio = shadowRoot.querySelector(
                '[role="radiogroup"][aria-label="触发管线筛选视图"] [role="radio"][data-value="all"]',
            ) as HTMLButtonElement;
            allRadio.click();
            await settleLayout(4);
            expect(shadowRoot.textContent).toContain('Phase 1: Before Turn');
            expect(shadowRoot.textContent).toContain('Phase 2: Main Turn');
            expect(shadowRoot.textContent).toContain('Phase 3: After Turn');
            expect(shadowRoot.textContent).toContain('Phase 4: Maintenance');
        }
    });
});
