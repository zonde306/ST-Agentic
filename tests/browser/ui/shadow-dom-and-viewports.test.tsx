import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ConsoleTabId } from '@/core/types';
import { registerAssistantView } from '@/ui/assistant';
import {
    type AgenticCapsuleElement,
    registerAgenticCapsuleElement,
} from '@/ui/capsule';
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

const ALL_CONSOLE_TABS: readonly ConsoleTabId[] = [
    'assistant',
    'sidegen',
    'files',
    'logs',
    'cache',
    'prompts',
    'agents',
    'pipeline',
    'tools',
    'regex',
    'wi',
    'connections',
];

const MASTER_DETAIL_TABS: ReadonlySet<ConsoleTabId> = new Set([
    'files',
    'logs',
    'agents',
    'pipeline',
    'tools',
    'regex',
    'connections',
]);

interface MountedHarness {
    store: AppStore;
    shellContainer: HTMLDivElement;
    capsule: AgenticCapsuleElement;
    cleanup: () => void;
}

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function settleLayout(frames = 3): Promise<void> {
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

function createHarness(
    options: { initialTab?: ConsoleTabId; initialOpen?: boolean; services?: AgenticUIServices } = {},
): MountedHarness {
    registerAgenticCapsuleElement();
    const unregisterAssistant = registerAssistantView();
    const unregisterSideGen = registerSideGenView();
    const unregisterSession = registerSessionViews();
    const unregisterStudio = registerStudioViews();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: options.initialOpen ?? true,
        initialTab: options.initialTab ?? 'files',
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

    const capsule = document.createElement('agentic-capsule') as AgenticCapsuleElement;
    capsule.setState({
        messageId: 12,
        swipeId: 0,
        position: 'bottom',
        persistMode: 'keep',
        theme: 'dark',
        status: 'background-running',
        stepCount: 2,
        cacheHitRate: 0.961,
        badges: [
            { label: '变量', tone: 'success', tab: 'files', filePath: '/state/variables.json' },
        ],
        backgroundTasks: createMockBackgroundTasks(),
    });
    const disconnectCapsuleStore = capsule.connectStore(store, { messageId: 12, swipeId: 0 });
    document.body.appendChild(capsule);

    return {
        store,
        shellContainer,
        capsule,
        cleanup: () => {
            disconnectCapsuleStore();
            capsule.remove();
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

function assertInteractiveTargetsAndTypography(shadowRoot: ShadowRoot, contextLabel: string): void {
    const interactiveEls = Array.from(
        shadowRoot.querySelectorAll('button, [role="switch"], [role="radio"]'),
    ).filter(isElementVisible);

    expect(interactiveEls.length, `${contextLabel}: expected visible interactive controls`).toBeGreaterThan(0);

    for (const el of interactiveEls) {
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
        shadowRoot.querySelectorAll('input, select, textarea'),
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
    const candidates: Array<{ name: string; el: Element }> = [
        { name: 'dialog#agentic-app', el: dialog },
    ];

    const selectors = [
        '[data-agentic-mount]',
        '.ag-console',
        '.ag-header',
        '.ag-body',
        '.ag-main',
        '.ag-view-scroll',
        '.ag-split-layout',
        '.ag-split-master',
        '.ag-split-detail',
        '.ag-stack-layout',
        '.ag-stack-topbar',
        '.ag-stack-body',
    ];

    const shadowHost = dialog.querySelector('[data-agentic-shadow-host="true"]');
    if (shadowHost) {
        candidates.push({ name: '[data-agentic-shadow-host]', el: shadowHost });
    }

    for (const selector of selectors) {
        for (const el of Array.from(shadowRoot.querySelectorAll(selector))) {
            if (isElementVisible(el)) {
                candidates.push({ name: selector, el });
            }
        }
    }

    for (const { name, el } of candidates) {
        const clientW = el.clientWidth;
        const scrollW = el.scrollWidth;
        expect(
            scrollW,
            `${contextLabel}: horizontal overflow on ${name} (scrollWidth=${scrollW} > clientWidth=${clientW})`,
        ).toBeLessThanOrEqual(clientW + 1);
    }
}

async function selectTab(
    shadowRoot: ShadowRoot,
    tabId: ConsoleTabId,
    isMobile: boolean,
): Promise<void> {
    const index = ALL_CONSOLE_TABS.indexOf(tabId);
    expect(index).toBeGreaterThanOrEqual(0);
    const selector = isMobile ? '.ag-mobile-nav .ag-mobile-tab' : '.ag-sidebar .ag-nav-item';
    const buttons = Array.from(shadowRoot.querySelectorAll(selector)) as HTMLButtonElement[];
    expect(buttons.length).toBe(ALL_CONSOLE_TABS.length);
    buttons[index].click();
    await settleLayout(4);
}

describe('Shadow DOM Isolation, Keyboard Guardrail & Dual-Viewport UI Contract', () => {
    let activeHarness: MountedHarness | null = null;
    const extraNodes: Element[] = [];

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        while (extraNodes.length > 0) {
            extraNodes.pop()?.remove();
        }
        document.documentElement.style.removeProperty('--SmartThemeBlurTintColor');
        document.documentElement.style.removeProperty('--SmartThemeBodyColor');
        await page.viewport(1280, 800);
    });

    it('switches Dark (default), Light, and Auto themes cleanly inside <dialog id="agentic-app"> and <agentic-capsule>', async () => {
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(4);

        const { shadowHost, shadowRoot, consoleEl } = getShellElements();
        const capShell = activeHarness.capsule.shadowRoot!.querySelector('.cap-shell') as HTMLDivElement;

        // Default theme must be Dark
        expect(activeHarness.store.getSnapshot().themeMode).toBe('dark');
        expect(shadowHost.getAttribute('data-theme')).toBe('dark');
        expect(capShell.getAttribute('data-theme')).toBe('dark');

        const darkConsoleBg = window.getComputedStyle(consoleEl).backgroundColor;
        const darkConsoleFg = window.getComputedStyle(consoleEl).color;
        const darkCapBg = window.getComputedStyle(capShell).backgroundColor;
        const darkCapFg = window.getComputedStyle(capShell).color;

        expect(darkConsoleBg).toBe('rgb(32, 36, 44)');
        expect(darkConsoleFg).toBe('rgb(230, 233, 239)');
        expect(darkCapBg).toBe('rgb(24, 27, 34)');
        expect(darkCapFg).toBe('rgb(230, 233, 239)');

        // Click the header theme toggle button: dark -> light
        const themeToggleBtn = shadowRoot.querySelector(
            'button[aria-label^="切换主题"]',
        ) as HTMLButtonElement;
        expect(themeToggleBtn).toBeTruthy();
        themeToggleBtn.click();
        await settleLayout(3);

        expect(activeHarness.store.getSnapshot().themeMode).toBe('light');
        expect(shadowHost.getAttribute('data-theme')).toBe('light');
        expect(capShell.getAttribute('data-theme')).toBe('light');

        const lightConsoleBg = window.getComputedStyle(consoleEl).backgroundColor;
        const lightConsoleFg = window.getComputedStyle(consoleEl).color;
        const lightCapBg = window.getComputedStyle(capShell).backgroundColor;
        const lightCapFg = window.getComputedStyle(capShell).color;

        expect(lightConsoleBg).toBe('rgb(255, 255, 255)');
        expect(lightConsoleFg).toBe('rgb(24, 28, 36)');
        expect(lightCapBg).toBe('rgb(244, 246, 250)');
        expect(lightCapFg).toBe('rgb(24, 28, 36)');

        expect(lightConsoleBg).not.toBe(darkConsoleBg);
        expect(lightConsoleFg).not.toBe(darkConsoleFg);
        expect(lightCapBg).not.toBe(darkCapBg);
        expect(lightCapFg).not.toBe(darkCapFg);

        // Switch to 'auto' and verify host luminance detection flips between dark & light
        document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgba(248, 250, 252, 0.96)');
        document.documentElement.style.setProperty('--SmartThemeBodyColor', '#111827');
        themeToggleBtn.click(); // light -> auto
        await settleLayout(3);
        expect(activeHarness.store.getSnapshot().themeMode).toBe('auto');
        expect(shadowHost.getAttribute('data-theme')).toBe('light');

        document.documentElement.style.setProperty('--SmartThemeBlurTintColor', 'rgba(16, 18, 24, 0.96)');
        document.documentElement.style.setProperty('--SmartThemeBodyColor', '#e5e7eb');
        await settleLayout(3);
        expect(shadowHost.getAttribute('data-theme')).toBe('dark');
    });

    it('isolates <dialog id="agentic-app"> and <agentic-capsule> Shadow DOM from hostile host CSS', async () => {
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(4);

        const hostileStyle = document.createElement('style');
        hostileStyle.setAttribute('data-test-hostile-css', 'true');
        hostileStyle.textContent = `
            input, textarea, select, button, div {
                width: 10px !important;
                background: rgb(255, 0, 0) !important;
                font-size: 8px !important;
            }
        `;
        document.head.appendChild(hostileStyle);
        extraNodes.push(hostileStyle);

        // Canary element in host light DOM proving the hostile CSS actually applies outside Shadow DOM
        const hostCanaryDiv = document.createElement('div');
        const hostCanaryInput = document.createElement('input');
        const hostCanaryButton = document.createElement('button');
        hostCanaryButton.textContent = 'host';
        document.body.append(hostCanaryDiv, hostCanaryInput, hostCanaryButton);
        extraNodes.push(hostCanaryDiv, hostCanaryInput, hostCanaryButton);

        await settleLayout(3);

        expect(window.getComputedStyle(hostCanaryDiv).backgroundColor).toBe('rgb(255, 0, 0)');
        expect(window.getComputedStyle(hostCanaryInput).width).toBe('10px');
        expect(window.getComputedStyle(hostCanaryInput).fontSize).toBe('8px');
        expect(window.getComputedStyle(hostCanaryButton).backgroundColor).toBe('rgb(255, 0, 0)');

        const { shadowRoot, consoleEl } = getShellElements();
        const capsuleShadow = activeHarness.capsule.shadowRoot!;
        expect(capsuleShadow).toBeTruthy();

        // Check <agentic-capsule> ShadowRoot elements remain unpolluted
        const capShell = capsuleShadow.querySelector('.cap-shell') as HTMLDivElement;
        const capOpenBtn = capsuleShadow.querySelector('.cap-open-btn') as HTMLButtonElement;
        const capSummary = capsuleShadow.querySelector('.cap-summary') as HTMLSpanElement;
        const capCancelBtn = capsuleShadow.querySelector('.cap-cancel-btn') as HTMLButtonElement;

        for (const el of [capShell, capOpenBtn, capSummary, capCancelBtn]) {
            expect(el).toBeTruthy();
            const st = window.getComputedStyle(el);
            expect(st.width).not.toBe('10px');
            expect(st.backgroundColor).not.toBe('rgb(255, 0, 0)');
            expect(st.fontSize).not.toBe('8px');
        }

        const shellWidgets = Array.from(
            shadowRoot.querySelectorAll('button, input, select, textarea'),
        ).filter(isElementVisible);
        expect(shellWidgets.length).toBeGreaterThan(0);

        for (const el of shellWidgets) {
            const st = window.getComputedStyle(el);
            expect(st.width).not.toBe('10px');
            expect(st.backgroundColor).not.toBe('rgb(255, 0, 0)');
            expect(st.fontSize).not.toBe('8px');
        }

        // Also verify <dialog id="agentic-app"> inner div elements remain unpolluted
        const consoleStyle = window.getComputedStyle(consoleEl);
        expect(consoleStyle.width).not.toBe('10px');
        expect(consoleStyle.backgroundColor).not.toBe('rgb(255, 0, 0)');
        expect(consoleStyle.fontSize).not.toBe('8px');

        const shadowDivs = Array.from(shadowRoot.querySelectorAll('div')).filter(isElementVisible);
        for (const divEl of shadowDivs) {
            const st = window.getComputedStyle(divEl);
            expect(st.width).not.toBe('10px');
            expect(st.backgroundColor).not.toBe('rgb(255, 0, 0)');
            expect(st.fontSize).not.toBe('8px');
        }
    });

    it('stops ArrowLeft/ArrowRight keydown and keyup inside <dialog id="agentic-app"> ShadowRoot from bubbling to document or window', async () => {
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(4);

        const docKeyDownSpy = vi.fn();
        const docKeyUpSpy = vi.fn();
        const winKeyDownSpy = vi.fn();
        const winKeyUpSpy = vi.fn();

        document.addEventListener('keydown', docKeyDownSpy);
        document.addEventListener('keyup', docKeyUpSpy);
        window.addEventListener('keydown', winKeyDownSpy);
        window.addEventListener('keyup', winKeyUpSpy);

        try {
            const { shadowRoot } = getShellElements();

            const searchInput = shadowRoot.querySelector('input[type="search"]') as HTMLInputElement;
            const editorTextarea = shadowRoot.querySelector('textarea.ag-code-textarea') as HTMLTextAreaElement;
            expect(searchInput).toBeTruthy();
            expect(editorTextarea).toBeTruthy();

            // 1. Synthetic composed KeyboardEvents inside <input> and <textarea>
            for (const target of [searchInput, editorTextarea]) {
                target.focus();
                for (const key of ['ArrowLeft', 'ArrowRight']) {
                    target.dispatchEvent(
                        new KeyboardEvent('keydown', {
                            key,
                            code: key,
                            bubbles: true,
                            cancelable: true,
                            composed: true,
                        }),
                    );
                    target.dispatchEvent(
                        new KeyboardEvent('keyup', {
                            key,
                            code: key,
                            bubbles: true,
                            cancelable: true,
                            composed: true,
                        }),
                    );
                }
            }

            // 2. Real browser userEvent keyboard dispatches while focused inside Shadow DOM
            searchInput.focus();
            await userEvent.keyboard('{ArrowLeft}{ArrowRight}');
            editorTextarea.focus();
            await userEvent.keyboard('{ArrowLeft}{ArrowRight}');

            expect(docKeyDownSpy).toHaveBeenCalledTimes(0);
            expect(docKeyUpSpy).toHaveBeenCalledTimes(0);
            expect(winKeyDownSpy).toHaveBeenCalledTimes(0);
            expect(winKeyUpSpy).toHaveBeenCalledTimes(0);

            // Positive control: host light-DOM input outside <dialog> DOES bubble to document & window
            const outsideInput = document.createElement('input');
            document.body.appendChild(outsideInput);
            extraNodes.push(outsideInput);
            outsideInput.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'ArrowLeft',
                    bubbles: true,
                    cancelable: true,
                }),
            );
            outsideInput.dispatchEvent(
                new KeyboardEvent('keyup', {
                    key: 'ArrowRight',
                    bubbles: true,
                    cancelable: true,
                }),
            );
            expect(docKeyDownSpy).toHaveBeenCalledTimes(1);
            expect(winKeyDownSpy).toHaveBeenCalledTimes(1);
            expect(docKeyUpSpy).toHaveBeenCalledTimes(1);
            expect(winKeyUpSpy).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener('keydown', docKeyDownSpy);
            document.removeEventListener('keyup', docKeyUpSpy);
            window.removeEventListener('keydown', winKeyDownSpy);
            window.removeEventListener('keyup', winKeyUpSpy);
        }
    });

    it('satisfies desktop (1280x800) layout, overflow, >=40x40px targets, and >=16px inputs across all 12 views', async () => {
        await page.viewport(1280, 800);
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();

        // Desktop sidebar visible, mobile nav hidden, backdrop blur active
        expect(isElementVisible(shadowRoot.querySelector('.ag-sidebar')!)).toBe(true);
        expect(isElementVisible(shadowRoot.querySelector('.ag-mobile-nav')!)).toBe(false);
        expect(window.getComputedStyle(dialog, '::backdrop').backdropFilter).not.toBe('none');

        for (const tabId of ALL_CONSOLE_TABS) {
            await selectTab(shadowRoot, tabId, false);
            assertNoHorizontalOverflow(dialog, shadowRoot, `desktop:${tabId}`);
            assertInteractiveTargetsAndTypography(shadowRoot, `desktop:${tabId}`);

            // Also verify WIRouterView's secondary sub-tab ('preset_files')
            if (tabId === 'wi') {
                const presetFilesRadio = shadowRoot.querySelector(
                    '[role="radiogroup"][aria-label="世界书路由子视图"] [role="radio"]:nth-child(2)',
                ) as HTMLButtonElement;
                expect(presetFilesRadio).toBeTruthy();
                presetFilesRadio.click();
                await settleLayout(4);
                assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:wi:preset_files');
                assertInteractiveTargetsAndTypography(shadowRoot, 'desktop:wi:preset_files');
            }
        }

        // Verify <agentic-capsule> desktop geometry & touch targets when dialog is closed
        activeHarness.store.closeConsole();
        await settleLayout(3);
        const capShadow = activeHarness.capsule.shadowRoot!;
        const capShell = capShadow.querySelector('.cap-shell') as HTMLDivElement;
        expect(capShell.scrollWidth).toBeLessThanOrEqual(capShell.clientWidth + 1);
        for (const btn of Array.from(capShadow.querySelectorAll('button')).filter(isElementVisible)) {
            const rect = btn.getBoundingClientRect();
            expect(rect.width).toBeGreaterThanOrEqual(40);
            expect(rect.height).toBeGreaterThanOrEqual(40);
        }
    });

    it('satisfies mobile (390x844) single-column push-stack navigation, backdrop-filter: none, zero overflow, >=40x40px targets, and >=16px inputs across all 12 views', async () => {
        await page.viewport(390, 844);
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();

        // Mobile horizontal nav visible, desktop sidebar hidden, dialog fills 100vw x 100dvh
        expect(isElementVisible(shadowRoot.querySelector('.ag-mobile-nav')!)).toBe(true);
        expect(isElementVisible(shadowRoot.querySelector('.ag-sidebar')!)).toBe(false);
        const dialogRect = dialog.getBoundingClientRect();
        expect(Math.round(dialogRect.width)).toBe(390);
        expect(Math.round(dialogRect.height)).toBe(844);

        // Mobile backdrop-filter: none on both dialog::backdrop and ShadowModal .ag-modal-backdrop
        expect(window.getComputedStyle(dialog, '::backdrop').backdropFilter).toBe('none');
        activeHarness.store.openModal({ kind: 'import_manager' });
        await settleLayout(3);
        const modalBackdrop = shadowRoot.querySelector('.ag-modal-backdrop') as HTMLDivElement;
        expect(modalBackdrop).toBeTruthy();
        expect(window.getComputedStyle(modalBackdrop).backdropFilter).toBe('none');
        assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:import_manager_modal');
        assertInteractiveTargetsAndTypography(shadowRoot, 'mobile:import_manager_modal');
        activeHarness.store.closeModal();
        await settleLayout(3);

        for (const tabId of ALL_CONSOLE_TABS) {
            await selectTab(shadowRoot, tabId, true);

            // List / initial view checks
            assertNoHorizontalOverflow(dialog, shadowRoot, `mobile:${tabId}:list`);
            assertInteractiveTargetsAndTypography(shadowRoot, `mobile:${tabId}:list`);

            if (MASTER_DETAIL_TABS.has(tabId)) {
                expect(shadowRoot.querySelector('.ag-stack-layout')).toBeTruthy();
                expect(shadowRoot.querySelector('.ag-stack-back-btn')).toBeNull();

                const firstItem = shadowRoot.querySelector('.ag-list-item') as HTMLButtonElement | null;
                expect(firstItem, `mobile:${tabId}: expected clickable master list item`).toBeTruthy();
                firstItem!.click();
                await settleLayout(4);

                // Pushed detail view with [← 返回列表]
                const backBtn = shadowRoot.querySelector('.ag-stack-back-btn') as HTMLButtonElement | null;
                expect(backBtn, `mobile:${tabId}: expected [← 返回列表] back button`).toBeTruthy();
                expect(backBtn!.textContent).toContain('返回列表');
                expect(isElementVisible(backBtn!)).toBe(true);

                assertNoHorizontalOverflow(dialog, shadowRoot, `mobile:${tabId}:detail`);
                assertInteractiveTargetsAndTypography(shadowRoot, `mobile:${tabId}:detail`);

                if (tabId === 'files') {
                    const diffRadio = shadowRoot.querySelector(
                        '[role="radiogroup"][aria-label="视图模式"] [role="radio"]:nth-child(2)',
                    ) as HTMLButtonElement | null;
                    expect(diffRadio).toBeTruthy();
                    diffRadio!.click();
                    await settleLayout(3);
                    assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:files:detail:diff');
                    assertInteractiveTargetsAndTypography(shadowRoot, 'mobile:files:detail:diff');
                }

                if (tabId === 'logs') {
                    const rawRadio = shadowRoot.querySelector(
                        '[role="radiogroup"][aria-label="日志详情视图"] [role="radio"]:nth-child(2)',
                    ) as HTMLButtonElement | null;
                    expect(rawRadio).toBeTruthy();
                    rawRadio!.click();
                    await settleLayout(3);
                    assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:logs:detail:raw');
                    assertInteractiveTargetsAndTypography(shadowRoot, 'mobile:logs:detail:raw');
                }

                // Return to master list via [← 返回列表]
                backBtn!.click();
                await settleLayout(5);
                expect(shadowRoot.querySelector('.ag-stack-back-btn')).toBeNull();
                expect(shadowRoot.querySelector('.ag-list-item')).toBeTruthy();
            }

            if (tabId === 'wi') {
                const presetFilesRadio = shadowRoot.querySelector(
                    '[role="radiogroup"][aria-label="世界书路由子视图"] [role="radio"]:nth-child(2)',
                ) as HTMLButtonElement;
                expect(presetFilesRadio).toBeTruthy();
                presetFilesRadio.click();
                await settleLayout(4);

                assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:wi:preset_files:list');
                assertInteractiveTargetsAndTypography(shadowRoot, 'mobile:wi:preset_files:list');

                const firstFileBtn = shadowRoot.querySelector('.ag-list-item') as HTMLButtonElement | null;
                expect(firstFileBtn).toBeTruthy();
                firstFileBtn!.click();
                await settleLayout(4);

                const backBtn = shadowRoot.querySelector('.ag-stack-back-btn') as HTMLButtonElement | null;
                expect(backBtn).toBeTruthy();
                expect(backBtn!.textContent).toContain('返回列表');
                assertNoHorizontalOverflow(dialog, shadowRoot, 'mobile:wi:preset_files:detail');
                assertInteractiveTargetsAndTypography(shadowRoot, 'mobile:wi:preset_files:detail');

                backBtn!.click();
                await settleLayout(5);
                expect(shadowRoot.querySelector('.ag-stack-back-btn')).toBeNull();
            }
        }

        // Verify <agentic-capsule> mobile single-line truncation & 40x40px cancel touch target
        activeHarness.store.closeConsole();
        await settleLayout(3);
        const capShadow = activeHarness.capsule.shadowRoot!;
        const capShell = capShadow.querySelector('.cap-shell') as HTMLDivElement;
        const capSummary = capShadow.querySelector('.cap-summary') as HTMLSpanElement;
        const capSummaryStyle = window.getComputedStyle(capSummary);
        expect(capSummaryStyle.whiteSpace).toBe('nowrap');
        expect(capSummaryStyle.textOverflow).toBe('ellipsis');
        expect(capShell.scrollWidth).toBeLessThanOrEqual(capShell.clientWidth + 1);

        for (const btn of Array.from(capShadow.querySelectorAll('button')).filter(isElementVisible)) {
            const rect = btn.getBoundingClientRect();
            expect(rect.width).toBeGreaterThanOrEqual(40);
            expect(rect.height).toBeGreaterThanOrEqual(40);
        }
    });

    it('renders <agentic-capsule> status="interrupted", auto_hide retention, >=40x40px resume touch target, and /output.md filter across desktop (1280x800) and mobile (390x844)', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            // 1. Verify FilesOverridesView displays '输出 (/output.md)' filter pill and renders cleanly
            const outputFilterBtn = Array.from(shadowRoot.querySelectorAll('button')).find(
                (btn) => btn.textContent?.trim() === '输出 (/output.md)',
            ) as HTMLButtonElement | undefined;
            expect(outputFilterBtn, `${vp.label}: expected 输出 (/output.md) filter pill`).toBeTruthy();
            expect(isElementVisible(outputFilterBtn!)).toBe(true);
            outputFilterBtn!.click();
            await settleLayout(4);

            const outputListItem = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find(
                (el) => el.textContent?.includes('/output.md'),
            ) as HTMLButtonElement | undefined;
            expect(outputListItem, `${vp.label}: expected /output.md entry under 输出 filter`).toBeTruthy();
            outputListItem!.click();
            await settleLayout(4);

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:files:output_md`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:files:output_md`);
            expect(shadowRoot.textContent).toContain('/output.md');

            if (vp.isMobile) {
                const backBtn = shadowRoot.querySelector('.ag-stack-back-btn') as HTMLButtonElement | null;
                expect(backBtn, `${vp.label}: expected [← 返回列表] back button`).toBeTruthy();
                backBtn!.click();
                await settleLayout(4);
            }

            // 2. Close <dialog id="agentic-app"> and inspect <agentic-capsule> in status="interrupted"
            activeHarness.store.closeConsole();
            await settleLayout(3);
            expect(dialog.open).toBe(false);

            const onResumeSpy = vi.fn(async () => undefined);
            activeHarness.store.setBackgroundTasks([]);
            const baseTrace = activeHarness.store.getSnapshot().traces[0];
            activeHarness.store.upsertTrace({
                ...baseTrace,
                status: 'completed',
                interruptedReason: undefined,
            });
            await activeHarness.store.updateSettings((prev) => ({
                ...prev,
                capsulePersistMode: 'auto_hide',
            }));
            await settleLayout(3);

            // Baseline: 'done' under auto_hide is hidden
            expect(activeHarness.capsule.getAttribute('data-hidden')).toBe('true');

            // Interrupted state under auto_hide MUST remain visible
            activeHarness.store.upsertTrace({
                ...baseTrace,
                status: 'interrupted',
                interruptedReason: 'user_stop',
            });
            activeHarness.capsule.setState({
                canResume: true,
                onResume: onResumeSpy,
            });
            await settleLayout(4);

            expect(activeHarness.capsule.getAttribute('data-hidden')).toBe('false');
            expect(isElementVisible(activeHarness.capsule)).toBe(true);

            const capShadow = activeHarness.capsule.shadowRoot!;
            const capShell = capShadow.querySelector('.cap-shell') as HTMLDivElement;
            expect(capShell.getAttribute('data-status')).toBe('interrupted');
            expect(
                capShell.scrollWidth,
                `${vp.label}: capsule horizontal overflow (${capShell.scrollWidth} > ${capShell.clientWidth})`,
            ).toBeLessThanOrEqual(capShell.clientWidth + 1);

            const resumeBtn = capShadow.querySelector('[data-action="resume"]') as HTMLButtonElement | null;
            expect(resumeBtn, `${vp.label}: expected [data-action="resume"] button`).toBeTruthy();
            expect(resumeBtn!.classList.contains('cap-resume-btn')).toBe(true);
            expect(resumeBtn!.textContent?.trim()).toBe('↻ 恢复');
            expect(resumeBtn!.hidden).toBe(false);
            expect(isElementVisible(resumeBtn!)).toBe(true);

            const resumeRect = resumeBtn!.getBoundingClientRect();
            expect(
                resumeRect.width,
                `${vp.label}: resume button width (${resumeRect.width}px) must be >= 40px`,
            ).toBeGreaterThanOrEqual(40);
            expect(
                resumeRect.height,
                `${vp.label}: resume button height (${resumeRect.height}px) must be >= 40px`,
            ).toBeGreaterThanOrEqual(40);

            if (vp.isMobile) {
                const capSummary = capShadow.querySelector('.cap-summary') as HTMLSpanElement;
                const capSummaryStyle = window.getComputedStyle(capSummary);
                expect(capSummaryStyle.whiteSpace).toBe('nowrap');
                expect(capSummaryStyle.textOverflow).toBe('ellipsis');
            }

            // Clicking [data-action="resume"] invokes onResume without opening <dialog id="agentic-app">
            resumeBtn!.click();
            await settleLayout(3);
            expect(onResumeSpy).toHaveBeenCalledTimes(1);
            expect(dialog.open).toBe(false);

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('fetches, filters, selects remote models, and displays errors cleanly in ConnectionsView across desktop and mobile viewports', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            await page.viewport(vp.width, vp.height);
            const mockServices = createMockUIServices();
            activeHarness = createHarness({
                initialTab: 'connections',
                initialOpen: true,
                services: mockServices,
            });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            if (vp.isMobile) {
                const firstConnItem = shadowRoot.querySelector('.ag-list-item') as HTMLButtonElement | null;
                expect(firstConnItem, `${vp.label}: expected connection list item`).toBeTruthy();
                firstConnItem!.click();
                await settleLayout(4);
            }

            const fetchBtn = Array.from(shadowRoot.querySelectorAll('button')).find(
                (btn) => btn.textContent?.includes('获取模型'),
            ) as HTMLButtonElement | undefined;
            expect(fetchBtn, `${vp.label}: expected 获取模型 button`).toBeTruthy();
            fetchBtn!.click();
            await settleLayout(6);

            const picker = shadowRoot.querySelector('.ag-model-picker') as HTMLDivElement | null;
            expect(picker, `${vp.label}: expected .ag-model-picker after fetching models`).toBeTruthy();
            const optionBtns = Array.from(
                shadowRoot.querySelectorAll('.ag-model-option'),
            ) as HTMLButtonElement[];
            expect(optionBtns.length).toBeGreaterThan(0);

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:connections:model_picker`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:connections:model_picker`);

            const filterInput = shadowRoot.querySelector(
                'input[type="search"][aria-label="筛选模型"]',
            ) as HTMLInputElement | null;
            expect(filterInput, `${vp.label}: expected model search input`).toBeTruthy();
            filterInput!.value = 'opus';
            filterInput!.dispatchEvent(new Event('input', { bubbles: true }));
            await settleLayout(4);

            const filteredOptions = Array.from(
                shadowRoot.querySelectorAll('.ag-model-option'),
            ) as HTMLButtonElement[];
            expect(filteredOptions.length).toBe(1);
            expect(filteredOptions[0].textContent).toContain('claude-opus-4-20250514');

            filteredOptions[0].click();
            await settleLayout(4);

            // Picker collapses and Model ID + store update to selected model
            expect(shadowRoot.querySelector('.ag-model-picker-list')).toBeNull();
            const activeConnId = activeHarness.store.getSnapshot().settings.currentConnectionId;
            expect(activeHarness.store.getSnapshot().settings.connections[activeConnId].model).toBe(
                'claude-opus-4-20250514',
            );

            const modelInput = shadowRoot.querySelector(
                'input[placeholder*="claude-sonnet-4.5"]',
            ) as HTMLInputElement | null;
            expect(modelInput).toBeTruthy();
            expect(modelInput!.value).toBe('claude-opus-4-20250514');

            // Verify error banner renders cleanly when fetchModels fails
            const failingServices: AgenticUIServices = {
                ...mockServices,
                async fetchModels() {
                    return {
                        ok: false,
                        latencyMs: 35,
                        models: [],
                        message: '获取模型列表失败 (35ms)：HTTP 401 Unauthorized',
                    };
                },
            };
            activeHarness.cleanup();
            activeHarness = createHarness({
                initialTab: 'connections',
                initialOpen: true,
                services: failingServices,
            });
            await settleLayout(5);

            const { dialog: errDialog, shadowRoot: errShadowRoot } = getShellElements();
            if (vp.isMobile) {
                const firstConnItem = errShadowRoot.querySelector('.ag-list-item') as HTMLButtonElement | null;
                firstConnItem!.click();
                await settleLayout(4);
            }
            const errFetchBtn = Array.from(errShadowRoot.querySelectorAll('button')).find(
                (btn) => btn.textContent?.includes('获取模型'),
            ) as HTMLButtonElement | undefined;
            expect(errFetchBtn).toBeTruthy();
            errFetchBtn!.click();
            await settleLayout(5);

            const errBanner = errShadowRoot.querySelector('.ag-banner-error') as HTMLDivElement | null;
            expect(errBanner, `${vp.label}: expected .ag-banner-error on fetch failure`).toBeTruthy();
            expect(errBanner!.textContent).toContain('HTTP 401 Unauthorized');
            assertNoHorizontalOverflow(errDialog, errShadowRoot, `${vp.label}:connections:fetch_error`);
            assertInteractiveTargetsAndTypography(errShadowRoot, `${vp.label}:connections:fetch_error`);

            activeHarness.cleanup();
            activeHarness = null;
        }
    });
});
