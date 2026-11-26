import { render } from 'preact';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type {
    ExportWorldInfoOptions,
    ExportWorldInfoResult,
    SideClueDelivery,
    SideClueDoc,
    SideClueStatus,
    SideGenOnceOptions,
    SideGenResult,
    SideGenSendOptions,
    SideSessionInfo,
    SideSessionTranscriptEntry,
} from '@/core/types';
import { AgenticAppShell } from '@/ui/shell';
import { registerSideGenView } from '@/ui/sidegen';
import {
    AppStore,
    AppStoreProvider,
    type SideGenRuntimeBridge,
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
} from '@/ui/store';
import {
    SAMPLE_LINWAN_COMMS_META,
    SAMPLE_SIDE_SESSION_BRANCH,
    SAMPLE_SIDE_SESSION_CHAT,
} from '../../fixtures/off-mainline-fixtures';

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
        '.ag-side-root',
        '.ag-side-subbar',
        '.ag-side-content',
        '.ag-view-scroll',
        '.ag-split-layout',
        '.ag-stack-layout',
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

function setSelectValue(el: HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findButtonByText(root: ParentNode, textFragment: string): HTMLButtonElement | null {
    const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
    return (
        buttons.find((btn) => isElementVisible(btn) && (btn.textContent ?? '').includes(textFragment))
        ?? null
    );
}

interface MockSideGenController {
    bridge: SideGenRuntimeBridge;
    clues: SideClueDoc[];
    sessions: SideSessionInfo[];
    transcripts: Record<string, SideSessionTranscriptEntry[]>;
    updateDeliverySpy: Mock<(...args: unknown[]) => void>;
    updateStatusSpy: Mock<(...args: unknown[]) => void>;
    writeClueSpy: Mock<(...args: unknown[]) => void>;
    exportToWorldInfoSpy: Mock<(...args: unknown[]) => void>;
    getTranscriptSpy: Mock<(...args: unknown[]) => void>;
    compactSessionSpy: Mock<(...args: unknown[]) => void>;
    deleteSessionSpy: Mock<(...args: unknown[]) => void>;
    sendSpy: Mock<(...args: unknown[]) => void>;
    runOnceSpy: Mock<(...args: unknown[]) => void>;
}

function createInitialClues(): SideClueDoc[] {
    return [
        {
            path: '/side/comms/linwan.md',
            meta: structuredClone(SAMPLE_LINWAN_COMMS_META),
            body: '- [18:10 User]: 今晚十点老码头见，带上门禁卡。\n- [18:11 林晚]: 收到，东区巡逻九点半换防，我提前二十分钟在旧仓库灯塔下等你。',
            contentHash: 'h_linwan_01',
        },
        {
            path: '/side/rumors/harbor-fog.md',
            meta: {
                id: 'clue_harbor_rumor',
                title: '雾港走私船暗语备忘',
                delivery: 'vfs_only',
                status: 'dormant',
                keywords: ['走私船', '黑帆'],
                summary: '仅在主 Agent 主动检索 /side/rumors/* 时查阅的码头暗语清单。',
                anchor: '10#0',
                createdAt: 1732310000000,
                updatedAt: 1732315000000,
            },
            body: '暗语「三声雾笛」代表卸货改期至次日凌晨。',
            contentHash: 'h_rumor_01',
        },
    ];
}

function createMockSideGenRuntime(): MockSideGenController {
    const clues = createInitialClues();
    const sessions: SideSessionInfo[] = [
        structuredClone(SAMPLE_SIDE_SESSION_BRANCH),
        structuredClone(SAMPLE_SIDE_SESSION_CHAT),
    ];
    const transcripts: Record<string, SideSessionTranscriptEntry[]> = {
        'phone:linwan': [
            {
                role: 'system',
                content: SAMPLE_SIDE_SESSION_BRANCH.systemPrompt,
                timestamp: 1732320000000,
            },
            {
                role: 'user',
                content: '今晚十点老码头见，带上门禁卡。',
                timestamp: 1732326500000,
            },
            {
                role: 'assistant',
                content: '收到，东区巡逻九点半换防，我在旧仓库灯塔下等你。',
                timestamp: 1732326600000,
            },
        ],
        'rumor:dock': [
            {
                role: 'system',
                content: SAMPLE_SIDE_SESSION_CHAT.systemPrompt,
                timestamp: 1732325000000,
            },
            {
                role: 'assistant',
                content: '码头酒馆盛传东区巡逻队今晚要提前交班。',
                timestamp: 1732325500000,
            },
        ],
    };

    const controller: MockSideGenController = {
        bridge: null as unknown as SideGenRuntimeBridge,
        clues,
        sessions,
        transcripts,
        updateDeliverySpy: vi.fn(),
        updateStatusSpy: vi.fn(),
        writeClueSpy: vi.fn(),
        exportToWorldInfoSpy: vi.fn(),
        getTranscriptSpy: vi.fn(),
        compactSessionSpy: vi.fn(),
        deleteSessionSpy: vi.fn(),
        sendSpy: vi.fn(),
        runOnceSpy: vi.fn(),
    };

    const bridge: SideGenRuntimeBridge = {
        runOnce: async (opts: SideGenOnceOptions): Promise<SideGenResult> => {
            controller.runOnceSpy(opts);
            return {
                text: `【一次性线外插曲】回应：${opts.prompt}`,
                ...(opts.bridge?.path ? { bridgedPath: opts.bridge.path } : {}),
                usage: { inputTokens: 820, cachedTokens: 0, outputTokens: 96 },
                durationMs: 310,
            };
        },
        createSession: async (opts) => {
            const now = Date.now();
            const created: SideSessionInfo = {
                id: opts.id ?? `side_${now.toString(36)}`,
                title: opts.title,
                scope: opts.scope ?? 'branch',
                systemPrompt: opts.systemPrompt,
                connectionId: opts.connectionId ?? 'inherit',
                watermark: opts.watermark ?? { high: 24000, low: 12000 },
                autoBridge: opts.autoBridge,
                anchor: { messageId: 12, swipeId: 0 },
                turns: 0,
                estimatedTokens: 0,
                createdAt: now,
                updatedAt: now,
            };
            controller.sessions.unshift(created);
            return structuredClone(created);
        },
        send: async (
            sessionId: string,
            prompt: string,
            opts?: SideGenSendOptions,
        ): Promise<SideGenResult> => {
            controller.sendSpy(sessionId, prompt, opts);
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (target) {
                target.turns += 1;
                target.estimatedTokens += 240;
                target.lastCacheHitRate = '94.1%';
                target.updatedAt = Date.now();
            }
            return {
                text: `【${sessionId} 回复】已收到：${prompt}`,
                sessionId,
                bridgedPath: target?.autoBridge?.path,
                usage: { inputTokens: 2000, cachedTokens: 1882, outputTokens: 118 },
                durationMs: 420,
            };
        },
        getSession: async (sessionId) => {
            const found = controller.sessions.find((s) => s.id === sessionId);
            return found ? structuredClone(found) : null;
        },
        listSessions: async () => structuredClone(controller.sessions),
        getTranscript: async (sessionId) => {
            controller.getTranscriptSpy(sessionId);
            return structuredClone(controller.transcripts[sessionId] ?? []);
        },
        compactSession: async (sessionId) => {
            controller.compactSessionSpy(sessionId);
            const target = controller.sessions.find((s) => s.id === sessionId);
            if (target) {
                target.estimatedTokens = 680;
            }
            return { compacted: true, estimatedTokens: 680 };
        },
        deleteSession: async (sessionId) => {
            controller.deleteSessionSpy(sessionId);
            const idx = controller.sessions.findIndex((s) => s.id === sessionId);
            if (idx >= 0) {
                controller.sessions.splice(idx, 1);
                return true;
            }
            return false;
        },
        clues: {
            write: async (input) => {
                controller.writeClueSpy(input);
                const now = Date.now();
                const idx = controller.clues.findIndex((c) => c.path === input.path);
                const existing = idx >= 0 ? controller.clues[idx] : null;
                const doc: SideClueDoc = {
                    path: input.path,
                    meta: {
                        id: input.id ?? existing?.meta.id ?? `clue_${now.toString(36)}`,
                        title: input.title ?? existing?.meta.title ?? input.path,
                        delivery: input.delivery ?? existing?.meta.delivery ?? 'radar_hint',
                        status: input.status ?? existing?.meta.status ?? 'dormant',
                        keywords: input.keywords ? [...input.keywords] : (existing?.meta.keywords ?? []),
                        secondaryKeys: input.secondaryKeys ?? existing?.meta.secondaryKeys,
                        scanDepth: input.scanDepth ?? existing?.meta.scanDepth,
                        order: input.order ?? existing?.meta.order,
                        summary: input.summary ?? existing?.meta.summary ?? '',
                        sourceSessionId: input.sourceSessionId ?? existing?.meta.sourceSessionId,
                        anchor: input.anchor ?? existing?.meta.anchor ?? '12#0',
                        createdAt: existing?.meta.createdAt ?? now,
                        updatedAt: now,
                    },
                    body: input.body,
                    contentHash: `h_updated_${now.toString(36)}`,
                };
                if (idx >= 0) {
                    controller.clues[idx] = doc;
                } else {
                    controller.clues.push(doc);
                }
                return structuredClone(doc);
            },
            read: async (path) => {
                const found = controller.clues.find((c) => c.path === path);
                return found ? structuredClone(found) : null;
            },
            list: async () => structuredClone(controller.clues),
            updateDelivery: async (path, delivery: SideClueDelivery, target) => {
                controller.updateDeliverySpy(path, delivery, target);
                const found = controller.clues.find((c) => c.path === path);
                if (!found) {
                    return null;
                }
                found.meta.delivery = delivery;
                found.meta.updatedAt = Date.now();
                return structuredClone(found);
            },
            updateStatus: async (path, status: SideClueStatus, target) => {
                controller.updateStatusSpy(path, status, target);
                const found = controller.clues.find((c) => c.path === path);
                if (!found) {
                    return null;
                }
                found.meta.status = status;
                found.meta.updatedAt = Date.now();
                return structuredClone(found);
            },
            delete: async (path) => {
                const idx = controller.clues.findIndex((c) => c.path === path);
                if (idx >= 0) {
                    controller.clues.splice(idx, 1);
                    return true;
                }
                return false;
            },
            exportToWorldInfo: async (
                path: string,
                options?: ExportWorldInfoOptions,
            ): Promise<ExportWorldInfoResult> => {
                controller.exportToWorldInfoSpy(path, options);
                if (options?.markResolved) {
                    const found = controller.clues.find((c) => c.path === path);
                    if (found) {
                        found.meta.status = 'resolved';
                    }
                }
                return {
                    bookName: options?.bookName ?? '雾港侦探录',
                    uid: 42,
                    comment: options?.comment ?? '林晚的加密通讯线索',
                    cluePath: path,
                };
            },
        },
    };

    controller.bridge = bridge;
    return controller;
}

interface MountedSideGenHarness {
    store: AppStore;
    runtime: MockSideGenController;
    shellContainer: HTMLDivElement;
    cleanup: () => void;
}

function mountSideGenHarness(options: {
    runtime?: MockSideGenController;
} = {}): MountedSideGenHarness {
    const unregisterSideGen = registerSideGenView();
    const runtime = options.runtime ?? createMockSideGenRuntime();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab: 'sidegen',
        initialSideClues: runtime.clues,
        initialSideSessions: runtime.sessions,
        services: createMockUIServices(),
        sideGenRuntime: runtime.bridge,
    });

    const shellContainer = document.createElement('div');
    shellContainer.setAttribute('data-test-sidegen-shell', 'true');
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
            unregisterSideGen();
            store.dispose();
        },
    };
}

describe('SideGen Console Dual-Viewport UI Contract (TS4.2)', () => {
    let activeHarness: MountedSideGenHarness | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        vi.restoreAllMocks();
        await page.viewport(1280, 800);
    });

    it('manages /side/* clues: list, live delivery switch, edit & save, and ExportWorldInfoModal on Desktop & Mobile (390x844)', async () => {
        // 1. Desktop (1280x800): master-detail split, delivery switch, edit & save, WI export
        await page.viewport(1280, 800);
        activeHarness = mountSideGenHarness();
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();
        expect(shadowRoot.querySelector('[data-view-id="sidegen"]')).toBeTruthy();
        expect(
            shadowRoot.querySelector('[data-sidegen-subtab="clues"]')?.getAttribute('aria-selected'),
        ).toBe('true');

        const linwanItem = shadowRoot.querySelector(
            'button[data-clue-path="/side/comms/linwan.md"]',
        ) as HTMLButtonElement;
        const rumorItem = shadowRoot.querySelector(
            'button[data-clue-path="/side/rumors/harbor-fog.md"]',
        ) as HTMLButtonElement;
        expect(linwanItem).toBeTruthy();
        expect(rumorItem).toBeTruthy();

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:sidegen:clues');
        assertTouchTargetsAndTypography(shadowRoot, 'desktop:sidegen:clues');

        // Live delivery mode switch: radar_hint -> next_turn_brief
        const deliverySelect = shadowRoot.querySelector(
            'select[aria-label="主线投递策略"]',
        ) as HTMLSelectElement;
        expect(deliverySelect).toBeTruthy();
        expect(deliverySelect.value).toBe('radar_hint');

        setSelectValue(deliverySelect, 'next_turn_brief');
        await settleLayout(5);

        expect(activeHarness.runtime.updateDeliverySpy).toHaveBeenCalledWith(
            '/side/comms/linwan.md',
            'next_turn_brief',
            { messageId: 12, swipeId: 0 },
        );
        expect(
            (shadowRoot.querySelector('select[aria-label="主线投递策略"]') as HTMLSelectElement).value,
        ).toBe('next_turn_brief');
        expect(
            shadowRoot.querySelector('button[data-clue-path="/side/comms/linwan.md"]')?.textContent,
        ).toContain('下轮简报');

        // Edit & save clue fields
        const titleInput = shadowRoot.querySelector('input[aria-label="线索标题"]') as HTMLInputElement;
        const summaryInput = shadowRoot.querySelector('input[aria-label="精炼摘要"]') as HTMLInputElement;
        const bodyTextarea = shadowRoot.querySelector('textarea[aria-label="线索正文"]') as HTMLTextAreaElement;

        setInputValue(titleInput, '林晚的加密通讯线索（已核实）');
        setInputValue(summaryInput, '已确认 21:20 提前换防，老码头灯塔接头安全。');
        setInputValue(bodyTextarea, '- [18:15 林晚]: 补充确认门禁卡编号 #09。');
        await settleLayout(3);

        const saveBtn = findButtonByText(shadowRoot, '保存修改');
        expect(saveBtn).toBeTruthy();
        expect(saveBtn!.disabled).toBe(false);
        saveBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.writeClueSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                path: '/side/comms/linwan.md',
                title: '林晚的加密通讯线索（已核实）',
                summary: '已确认 21:20 提前换防，老码头灯塔接头安全。',
                body: '- [18:15 林晚]: 补充确认门禁卡编号 #09。',
                delivery: 'next_turn_brief',
            }),
        );
        expect(
            shadowRoot.querySelector('button[data-clue-path="/side/comms/linwan.md"]')?.textContent,
        ).toContain('林晚的加密通讯线索（已核实）');

        // Open ExportWorldInfoModal & invoke exportToWorldInfo
        const exportBtn = findButtonByText(shadowRoot, '导出到世界书');
        expect(exportBtn).toBeTruthy();
        exportBtn!.click();
        await settleLayout(4);

        const modalBackdrop = shadowRoot.querySelector('.ag-modal-backdrop') as HTMLDivElement;
        expect(modalBackdrop).toBeTruthy();
        expect(modalBackdrop.textContent).toContain('📤 导出线索到 ST 真实世界书');

        const confirmExportBtn = findButtonByText(modalBackdrop, '确认写入世界书');
        expect(confirmExportBtn).toBeTruthy();
        confirmExportBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.exportToWorldInfoSpy).toHaveBeenCalledWith(
            '/side/comms/linwan.md',
            expect.objectContaining({
                comment: '林晚的加密通讯线索（已核实）',
                target: { messageId: 12, swipeId: 0 },
            }),
        );
        expect(modalBackdrop.textContent).toContain('导出成功：已写入《雾港侦探录》');
        expect(modalBackdrop.textContent).toContain('UID 42');

        const doneBtn = findButtonByText(modalBackdrop, '完成');
        expect(doneBtn).toBeTruthy();
        doneBtn!.click();
        await settleLayout(3);

        // 2. Mobile (390x844): list ↔ detail stack navigation
        await page.viewport(390, 844);
        await settleLayout(5);

        expect(shadowRoot.querySelector('.ag-stack-layout')).toBeTruthy();
        expect(shadowRoot.querySelector('.ag-stack-back-btn')).toBeNull();
        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:sidegen:clues:list');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:sidegen:clues:list');

        const mobileClueBtn = shadowRoot.querySelector(
            'button[data-clue-path="/side/comms/linwan.md"]',
        ) as HTMLButtonElement;
        expect(mobileClueBtn).toBeTruthy();
        mobileClueBtn.click();
        await settleLayout(5);

        const backBtn = shadowRoot.querySelector('.ag-stack-back-btn') as HTMLButtonElement;
        expect(backBtn).toBeTruthy();
        expect(isElementVisible(backBtn)).toBe(true);
        expect(shadowRoot.querySelector('select[aria-label="主线投递策略"]')).toBeTruthy();
        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:sidegen:clues:detail');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:sidegen:clues:detail');

        backBtn.click();
        await settleLayout(5);
        expect(shadowRoot.querySelector('.ag-stack-back-btn')).toBeNull();
        expect(shadowRoot.querySelector('button[data-clue-path="/side/comms/linwan.md"]')).toBeTruthy();
    });

    it('renders SideSessionConfig cards (branch/chat, anchor, watermark, cache hit), read-only transcript modal, compactSession, and inline-confirmed deleteSession', async () => {
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

        await page.viewport(1280, 800);
        activeHarness = mountSideGenHarness();
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();

        // Switch to 线外会话 sub-tab
        const sessionsTab = shadowRoot.querySelector(
            'button[data-sidegen-subtab="sessions"]',
        ) as HTMLButtonElement;
        expect(sessionsTab).toBeTruthy();
        sessionsTab.click();
        await settleLayout(4);

        const branchCard = shadowRoot.querySelector(
            'article[data-side-session-id="phone:linwan"]',
        ) as HTMLElement;
        const chatCard = shadowRoot.querySelector(
            'article[data-side-session-id="rumor:dock"]',
        ) as HTMLElement;
        expect(branchCard).toBeTruthy();
        expect(chatCard).toBeTruthy();

        // Verify scope pills, anchor, token watermark, and cache hit rate
        expect(branchCard.textContent).toContain('branch · 因果分支');
        expect(branchCard.textContent).toContain('#12#0');
        expect(branchCard.textContent).toContain('1,420');
        expect(branchCard.textContent).toContain('16,000');
        expect(branchCard.textContent).toContain('92.4%');
        expect(branchCard.querySelector('.ag-progress-track')).toBeTruthy();

        expect(chatCard.textContent).toContain('chat · 聊天级');
        expect(chatCard.textContent).toContain('#12#0');
        expect(chatCard.textContent).toContain('640');
        expect(chatCard.textContent).toContain('0.0%');

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:sidegen:sessions');
        assertTouchTargetsAndTypography(shadowRoot, 'desktop:sidegen:sessions');

        // Open read-only transcript modal
        const viewTranscriptBtn = findButtonByText(branchCard, '查看记录');
        expect(viewTranscriptBtn).toBeTruthy();
        viewTranscriptBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.getTranscriptSpy).toHaveBeenCalledWith('phone:linwan');
        const transcriptModal = shadowRoot.querySelector('.ag-modal-backdrop') as HTMLDivElement;
        expect(transcriptModal).toBeTruthy();
        expect(transcriptModal.textContent).toContain('只读会话记录 · phone:linwan');
        expect(transcriptModal.querySelectorAll('.ag-side-transcript-item').length).toBe(3);
        expect(transcriptModal.textContent).toContain('今晚十点老码头见');
        expect(transcriptModal.textContent).toContain('旧仓库灯塔下等你');

        const closeModalBtn = findButtonByText(transcriptModal, '关闭');
        expect(closeModalBtn).toBeTruthy();
        closeModalBtn!.click();
        await settleLayout(3);
        expect(shadowRoot.querySelector('.ag-modal-backdrop')).toBeNull();

        // Trigger compactSession on phone:linwan
        const compactBtn = findButtonByText(branchCard, '压缩');
        expect(compactBtn).toBeTruthy();
        compactBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.compactSessionSpy).toHaveBeenCalledWith('phone:linwan');
        expect(
            shadowRoot.querySelector('article[data-side-session-id="phone:linwan"]')?.textContent,
        ).toContain('680');

        // Trigger inline-confirmed deleteSession on rumor:dock (zero window.confirm)
        const deleteBtn = findButtonByText(chatCard, '删除');
        expect(deleteBtn).toBeTruthy();
        deleteBtn!.click();
        await settleLayout(3);

        expect(confirmSpy).not.toHaveBeenCalled();
        const confirmDeleteBtn = findButtonByText(chatCard, '确认删除');
        expect(confirmDeleteBtn).toBeTruthy();
        confirmDeleteBtn!.click();
        await settleLayout(5);

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(activeHarness.runtime.deleteSessionSpy).toHaveBeenCalledWith('rumor:dock');
        expect(shadowRoot.querySelector('article[data-side-session-id="rumor:dock"]')).toBeNull();

        // Mobile viewport check on 线外会话
        await page.viewport(390, 844);
        await settleLayout(5);
        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:sidegen:sessions');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:sidegen:sessions');
    });

    it('runs SDK Playground in send() and runOnce() modes, displays execution output, and generates Agentic.sideGen.* JS snippets on Desktop & Mobile', async () => {
        await page.viewport(1280, 800);
        activeHarness = mountSideGenHarness();
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();

        // Switch to SDK 试跑 sub-tab
        const sdkTab = shadowRoot.querySelector(
            'button[data-sidegen-subtab="sdk"]',
        ) as HTMLButtonElement;
        expect(sdkTab).toBeTruthy();
        sdkTab.click();
        await settleLayout(4);

        const modeSelect = shadowRoot.querySelector(
            'select[aria-label="SDK 调用模式"]',
        ) as HTMLSelectElement;
        expect(modeSelect).toBeTruthy();
        expect(modeSelect.value).toBe('send');

        // 1. Verify send() generated JS snippet and execution against mock SideGenRuntimeBridge
        const snippetPre = shadowRoot.querySelector('pre.ag-pre') as HTMLPreElement;
        expect(snippetPre).toBeTruthy();
        expect(snippetPre.textContent).toContain('Agentic.sideGen.send("phone:linwan"');
        expect(snippetPre.textContent).toContain('mainChatDepth: 4');

        const promptTextarea = shadowRoot.querySelector(
            'textarea[aria-label="输入提示词"]',
        ) as HTMLTextAreaElement;
        setInputValue(promptTextarea, '确认东区旧仓库钥匙位置');
        await settleLayout(3);
        expect(snippetPre.textContent).toContain('确认东区旧仓库钥匙位置');

        const runBtn = findButtonByText(shadowRoot, '执行 SDK 试跑');
        expect(runBtn).toBeTruthy();
        runBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.sendSpy).toHaveBeenCalledWith(
            'phone:linwan',
            '确认东区旧仓库钥匙位置',
            expect.objectContaining({
                mainChatDepth: 4,
            }),
        );
        const sendOutput = shadowRoot.querySelector('[data-sdk-output="true"]') as HTMLDivElement;
        expect(sendOutput).toBeTruthy();
        expect(sendOutput.textContent).toContain('【phone:linwan 回复】已收到：确认东区旧仓库钥匙位置');
        expect(shadowRoot.textContent).toContain('94.1%');

        // 2. Switch to runOnce(), enable bridge, verify generated Agentic.sideGen.runOnce(...) snippet, and execute
        setSelectValue(modeSelect, 'runOnce');
        await settleLayout(4);

        expect(shadowRoot.querySelector('textarea[aria-label="系统提示词"]')).toBeTruthy();
        const bridgeSwitch = shadowRoot.querySelector(
            'button[role="switch"][aria-label*="将本次结果桥接沉淀到 /side/* 线索"]',
        ) as HTMLButtonElement | null;
        expect(bridgeSwitch).toBeTruthy();
        bridgeSwitch!.click();
        await settleLayout(4);

        const runOnceSnippetPre = shadowRoot.querySelector('pre.ag-pre') as HTMLPreElement;
        expect(runOnceSnippetPre).toBeTruthy();
        expect(runOnceSnippetPre.textContent).toContain('Agentic.sideGen.runOnce({');
        expect(runOnceSnippetPre.textContent).toContain('bridge: {');
        expect(runOnceSnippetPre.textContent).toContain('/side/notes/playground-clue.md');

        const runOnceBtn = findButtonByText(shadowRoot, '执行 SDK 试跑');
        expect(runOnceBtn).toBeTruthy();
        runOnceBtn!.click();
        await settleLayout(5);

        expect(activeHarness.runtime.runOnceSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: '确认东区旧仓库钥匙位置',
                mainChatDepth: 4,
                bridge: expect.objectContaining({
                    path: '/side/notes/playground-clue.md',
                }),
            }),
        );
        const runOnceOutput = shadowRoot.querySelector('[data-sdk-output="true"]') as HTMLDivElement;
        expect(runOnceOutput).toBeTruthy();
        expect(runOnceOutput.textContent).toContain('【一次性线外插曲】回应：确认东区旧仓库钥匙位置');
        expect(shadowRoot.textContent).toContain('一次性 · 0 线程残留');

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:sidegen:sdk');
        assertTouchTargetsAndTypography(shadowRoot, 'desktop:sidegen:sdk');

        // 3. Mobile (390x844) layout, touch targets, and >=16px inputs check on SDK 试跑
        await page.viewport(390, 844);
        await settleLayout(5);
        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:sidegen:sdk');
        assertTouchTargetsAndTypography(shadowRoot, 'mobile:sidegen:sdk');
    });

    it('applies active preset display regex rules to assistant transcript entries in SideSessionsPane without altering system entries', async () => {
        await page.viewport(1280, 800);
        const runtime = createMockSideGenRuntime();
        runtime.transcripts['phone:linwan'] = [
            {
                role: 'system',
                content: '<think>系统规则保持原文</think>',
                timestamp: 1732320000000,
            },
            {
                role: 'user',
                content: '东区现在什么情况？',
                timestamp: 1732326500000,
            },
            {
                role: 'assistant',
                content: '<think>先确认巡逻时间</think>东区暗哨已经撤离。',
                timestamp: 1732326600000,
            },
        ];

        activeHarness = mountSideGenHarness({ runtime });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const sessionsTab = shadowRoot.querySelector(
            'button[data-sidegen-subtab="sessions"]',
        ) as HTMLButtonElement;
        expect(sessionsTab).toBeTruthy();
        sessionsTab.click();
        await settleLayout(4);

        const branchCard = shadowRoot.querySelector(
            'article[data-side-session-id="phone:linwan"]',
        ) as HTMLElement;
        expect(branchCard).toBeTruthy();

        const viewTranscriptBtn = findButtonByText(branchCard, '查看记录');
        expect(viewTranscriptBtn).toBeTruthy();
        viewTranscriptBtn!.click();
        await settleLayout(5);

        const transcriptModal = shadowRoot.querySelector('.ag-modal-backdrop') as HTMLDivElement;
        expect(transcriptModal).toBeTruthy();
        const items = transcriptModal.querySelectorAll('.ag-side-transcript-item');
        expect(items.length).toBe(3);
        expect(items[0].textContent).toContain('<think>系统规则保持原文</think>');
        expect(items[2].textContent).toContain('[思考已折叠: 先确认巡逻时间]东区暗哨已经撤离。');
        expect(items[2].textContent).not.toContain('<think>先确认巡逻时间</think>');
    });
});
