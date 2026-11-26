import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ConsoleTabId, GenerationEventPayload } from '@/core/types';
import { buildWorldInfoTriggerRuleId } from '@/core/triggers';
import { registerAssistantView } from '@/ui/assistant';
import {
    type AgenticCapsuleElement,
    placeAgenticCapsule,
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

async function waitForScrollIdle(el: HTMLElement, maxFrames = 60): Promise<void> {
    let prev = el.scrollTop;
    let stableFrames = 0;
    for (let i = 0; i < maxFrames; i += 1) {
        await nextAnimationFrame();
        const cur = el.scrollTop;
        if (Math.abs(cur - prev) < 0.5) {
            stableFrames += 1;
            if (stableFrames >= 4) {
                return;
            }
        } else {
            stableFrames = 0;
            prev = cur;
        }
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
    const selector = isMobile ? '.ag-mobile-nav .ag-mobile-tab' : '.ag-sidebar .ag-nav-item[data-tab-id]';
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

        // "Iris" design tokens (docs/UI_DESIGN_SYSTEM.md §1): console frame = --sidebar chrome
        expect(darkConsoleBg).toBe('rgb(20, 20, 22)');
        expect(darkConsoleFg).toBe('rgb(236, 236, 241)');
        expect(darkCapBg).toBe('rgb(31, 31, 35)');
        expect(darkCapFg).toBe('rgb(236, 236, 241)');

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

        expect(lightConsoleBg).toBe('rgb(244, 244, 246)');
        expect(lightConsoleFg).toBe('rgb(26, 26, 31)');
        expect(lightCapBg).toBe('rgb(244, 244, 246)');
        expect(lightCapFg).toBe('rgb(26, 26, 31)');

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

    it('collapses the desktop sidebar into a 60px icon rail with >=40x40px targets and persists the choice', async () => {
        await page.viewport(1280, 800);
        window.localStorage.removeItem('st-agentic:sidebar-collapsed');
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const sidebar = shadowRoot.querySelector('.ag-sidebar') as HTMLElement;
        const toggle = shadowRoot.querySelector('.ag-sidebar-toggle') as HTMLButtonElement;
        expect(sidebar.dataset.collapsed).toBe('false');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');

        try {
            toggle.click();
            await new Promise((resolve) => setTimeout(resolve, 260));
            await settleLayout(3);

            expect(sidebar.dataset.collapsed).toBe('true');
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(window.localStorage.getItem('st-agentic:sidebar-collapsed')).toBe('1');
            expect(Math.round(sidebar.getBoundingClientRect().width)).toBe(60);
            for (const btn of Array.from(sidebar.querySelectorAll('button')) as HTMLButtonElement[]) {
                const rect = btn.getBoundingClientRect();
                expect(rect.width).toBeGreaterThanOrEqual(40);
                expect(rect.height).toBeGreaterThanOrEqual(40);
            }

            // Navigation still works from the rail.
            (sidebar.querySelector('[data-tab-id="logs"]') as HTMLButtonElement).click();
            await settleLayout(2);
            expect(activeHarness.store.getSnapshot().activeTab).toBe('logs');

            toggle.click();
            await settleLayout(2);
            expect(sidebar.dataset.collapsed).toBe('false');
            expect(window.localStorage.getItem('st-agentic:sidebar-collapsed')).toBe('0');
        } finally {
            window.localStorage.removeItem('st-agentic:sidebar-collapsed');
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

    it('toggles Windows-style webpage fullscreen maximize and restore on desktop while keeping mobile hidden', async () => {
        // 1. Desktop (1280x800): maximize button and header double-click toggle fullscreen cleanly
        await page.viewport(1280, 800);
        activeHarness = createHarness({ initialTab: 'assistant', initialOpen: true });
        await settleLayout(5);

        const { dialog, shadowHost, shadowRoot, consoleEl } = getShellElements();

        const maximizeBtn = shadowRoot.querySelector(
            'button[aria-label="网页全屏"]',
        ) as HTMLButtonElement | null;
        expect(maximizeBtn).toBeTruthy();
        expect(isElementVisible(maximizeBtn!)).toBe(true);
        expect(dialog.getAttribute('data-maximized')).toBe('false');
        expect(shadowHost.getAttribute('data-maximized')).toBe('false');
        expect(consoleEl.getAttribute('data-maximized')).toBe('false');

        const normalRect = dialog.getBoundingClientRect();
        expect(Math.round(normalRect.width)).toBe(1180);
        expect(Math.round(normalRect.height)).toBe(760);
        expect(window.getComputedStyle(consoleEl).borderRadius).toBe('16px');

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:normal');
        assertInteractiveTargetsAndTypography(shadowRoot, 'desktop:normal');

        // Click maximize button -> expands to full 1280x800 viewport with 0px border-radius
        maximizeBtn!.click();
        await settleLayout(5);

        expect(activeHarness.store.getSnapshot().isMaximized).toBe(true);
        expect(dialog.getAttribute('data-maximized')).toBe('true');
        expect(shadowHost.getAttribute('data-maximized')).toBe('true');
        expect(consoleEl.getAttribute('data-maximized')).toBe('true');

        const maxRect = dialog.getBoundingClientRect();
        expect(Math.round(maxRect.width)).toBe(1280);
        expect(Math.round(maxRect.height)).toBe(800);
        expect(window.getComputedStyle(consoleEl).borderRadius).toBe('0px');

        const restoreBtn = shadowRoot.querySelector(
            'button[aria-label="还原窗口"]',
        ) as HTMLButtonElement | null;
        expect(restoreBtn).toBeTruthy();
        expect(isElementVisible(restoreBtn!)).toBe(true);

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:maximized');
        assertInteractiveTargetsAndTypography(shadowRoot, 'desktop:maximized');

        // Double-click .ag-brand -> restores back to windowed 1180x760 frame
        const brandEl = shadowRoot.querySelector('.ag-brand') as HTMLDivElement;
        expect(brandEl).toBeTruthy();
        brandEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await settleLayout(5);

        expect(activeHarness.store.getSnapshot().isMaximized).toBe(false);
        expect(dialog.getAttribute('data-maximized')).toBe('false');
        const restoredRect = dialog.getBoundingClientRect();
        expect(Math.round(restoredRect.width)).toBe(1180);
        expect(Math.round(restoredRect.height)).toBe(760);
        expect(window.getComputedStyle(consoleEl).borderRadius).toBe('16px');

        activeHarness.cleanup();
        activeHarness = null;

        // 2. Mobile (390x844): maximize/restore button is hidden on mobile viewport
        await page.viewport(390, 844);
        activeHarness = createHarness({ initialTab: 'files', initialOpen: true });
        await settleLayout(5);
        const { shadowRoot: mobileShadowRoot } = getShellElements();
        expect(mobileShadowRoot.querySelector('button[aria-label="网页全屏"]')).toBeNull();
        expect(mobileShadowRoot.querySelector('button[aria-label="还原窗口"]')).toBeNull();
    });

    it('mounts <agentic-capsule> inside .mes_block without squeezing SillyTavern .mes flex-row layout', async () => {
        await page.viewport(1280, 800);
        activeHarness = createHarness({ initialTab: 'files', initialOpen: false });
        await settleLayout(4);

        const chatStyle = document.createElement('style');
        chatStyle.textContent = `
            #test-st-chat { width: 900px; box-sizing: border-box; }
            #test-st-chat .mes {
                display: flex;
                align-items: flex-start;
                width: 100%;
                box-sizing: border-box;
                padding: 10px 10px 0 10px;
            }
            #test-st-chat .mesAvatarWrapper { width: 50px; flex-shrink: 0; }
            #test-st-chat .mes_block {
                padding-left: 10px;
                width: 100%;
                overflow-x: hidden;
                overflow-y: clip;
                box-sizing: border-box;
            }
            #test-st-chat .mes_text { padding: 5px 0; }
            #test-st-chat .swipeRightBlock { width: 25px; flex-shrink: 0; }
        `;

        const chatContainer = document.createElement('div');
        chatContainer.id = 'test-st-chat';
        chatContainer.innerHTML = `
            <div class="mes" mesid="0">
                <div class="mesAvatarWrapper"><div class="avatar"></div></div>
                <div class="mes_block">
                    <div class="ch_name"><span>角色名</span></div>
                    <div class="mes_text"><p>开场白与自定义卡片内容</p></div>
                    <div class="mes_media_wrapper"></div>
                </div>
                <div class="swipeRightBlock"></div>
            </div>
        `;

        document.head.appendChild(chatStyle);
        document.body.appendChild(chatContainer);

        try {
            const mesEl = chatContainer.querySelector<HTMLElement>('.mes')!;
            const mesBlock = chatContainer.querySelector<HTMLElement>('.mes_block')!;
            const mesText = chatContainer.querySelector<HTMLElement>('.mes_text')!;

            await settleLayout(3);
            const baselineBlockWidth = mesBlock.getBoundingClientRect().width;
            expect(baselineBlockWidth).toBeGreaterThan(700);

            // Simulate runtime callers passing `#chat .mes[mesid="0"]`
            placeAgenticCapsule(mesEl, activeHarness.capsule, 'bottom');
            await settleLayout(4);

            expect(activeHarness.capsule.parentElement).toBe(mesBlock);
            expect(mesEl.querySelectorAll('agentic-capsule').length).toBe(1);
            expect(mesText.querySelector('agentic-capsule')).toBeNull();
            expect(mesText.nextElementSibling).toBe(activeHarness.capsule);

            const blockRectAfterBottom = mesBlock.getBoundingClientRect();
            const textRectAfterBottom = mesText.getBoundingClientRect();
            const capsuleRectBottom = activeHarness.capsule.getBoundingClientRect();

            expect(Math.abs(blockRectAfterBottom.width - baselineBlockWidth)).toBeLessThanOrEqual(2);
            expect(Math.abs(capsuleRectBottom.width - textRectAfterBottom.width)).toBeLessThanOrEqual(2);
            expect(capsuleRectBottom.top).toBeGreaterThanOrEqual(textRectAfterBottom.bottom - 1);

            // Idempotent re-placement keeps the exact same DOM position
            placeAgenticCapsule(mesEl, activeHarness.capsule, 'bottom');
            await settleLayout(2);
            expect(activeHarness.capsule.parentElement).toBe(mesBlock);
            expect(mesText.nextElementSibling).toBe(activeHarness.capsule);

            // Toggling capsulePosition in settings dynamically moves mounted capsule above .mes_text
            await activeHarness.store.updateSettings((prev) => ({
                ...prev,
                capsulePosition: 'top',
            }));
            await settleLayout(4);

            expect(activeHarness.capsule.parentElement).toBe(mesBlock);
            expect(activeHarness.capsule.nextElementSibling).toBe(mesText);

            const blockRectAfterTop = mesBlock.getBoundingClientRect();
            const textRectAfterTop = mesText.getBoundingClientRect();
            const capsuleRectTop = activeHarness.capsule.getBoundingClientRect();

            expect(Math.abs(blockRectAfterTop.width - baselineBlockWidth)).toBeLessThanOrEqual(2);
            expect(capsuleRectTop.bottom).toBeLessThanOrEqual(textRectAfterTop.top + 1);
        } finally {
            chatContainer.remove();
            chatStyle.remove();
        }
    });

    it('displays lorebook names and preset trigger source in LogsView and supports filtering by lorebook name', async () => {
        await page.viewport(1280, 800);
        activeHarness = createHarness({ initialTab: 'logs', initialOpen: true });
        await settleLayout(3);

        const longBookName = '超长世界书名称测试_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789';
        const now = Date.now();
        activeHarness.store.setTraces([
            {
                runId: 'run_wi_script_err',
                target: { messageId: 2, swipeId: 1 },
                phase: 'after_turn',
                agentProfileId: 'script',
                agentName: '@@script 脚本 1',
                triggerId: 'wi_phys_1',
                triggerLabel: '@@script 脚本 1',
                triggerSource: 'worldinfo',
                lorebookNames: [longBookName],
                connectionId: 'conn_1',
                model: '0-token-script',
                status: 'error',
                startedAt: now - 1000,
                endedAt: now - 960,
                durationMs: 40,
                usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitRate: 0 },
                toolSteps: [],
                error: 'JSON Merge Patch payload must be a plain object.',
            },
            {
                runId: 'run_preset_script_err',
                target: { messageId: 2, swipeId: 1 },
                phase: 'after_turn',
                agentProfileId: 'script',
                agentName: '预设结算脚本',
                triggerId: 'preset_script_1',
                triggerLabel: '预设结算脚本',
                triggerSource: 'preset',
                connectionId: 'conn_1',
                model: '0-token-script',
                status: 'error',
                startedAt: now - 2000,
                endedAt: now - 1970,
                durationMs: 30,
                usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitRate: 0 },
                toolSteps: [],
                error: 'preset script error',
            },
        ]);
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();
        const listItems = Array.from(shadowRoot.querySelectorAll('.ag-list-item')) as HTMLButtonElement[];
        expect(listItems).toHaveLength(2);
        expect(listItems[0].textContent).toContain(longBookName);
        expect(listItems[1].textContent).toContain('来源：预设触发器');

        // Default selection is first trace (WI script error) -> detail header shows lorebook badge
        expect(shadowRoot.textContent).toContain(`世界书：${longBookName}`);
        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:logs:lorebook-name');

        // Click second trace (preset script) -> detail header shows preset source badge
        listItems[1].click();
        await settleLayout(4);
        expect(shadowRoot.textContent).toContain('来源：预设触发器');

        // Global search by lorebook name filters down to the matching WI trace
        const searchInput = shadowRoot.querySelector(
            'input[aria-label="全局搜索生成日志"]',
        ) as HTMLInputElement | null;
        expect(searchInput).toBeTruthy();
        await userEvent.fill(searchInput!, '超长世界书名称测试');
        await settleLayout(4);

        const filteredItems = Array.from(shadowRoot.querySelectorAll('.ag-list-item')) as HTMLButtonElement[];
        expect(filteredItems).toHaveLength(1);
        expect(filteredItems[0].textContent).toContain(longBookName);
    });

    it('collapses tool steps by default in LogsView and auto-scrolls the detail pane to clicked steps on desktop and mobile', async () => {
        const now = Date.now();
        const longArgsPayload = Array.from({ length: 8 }, (_, idx) => `line_${idx}: value_${idx}`).join('\n');
        const longResultPayload = Array.from(
            { length: 14 },
            (_, idx) => `${idx + 1}| 详情输出行_${idx + 1}_abcdefghijklmnopqrstuvwxyz_0123456789`,
        ).join('\n');

        const manySteps = Array.from({ length: 12 }, (_, idx) => ({
            stepIndex: idx,
            toolCallId: `call_many_${idx + 1}`,
            toolName: idx === 7 ? 'search_files' : idx === 11 ? 'write_file' : 'read_file',
            args: { path: `/lorebooks/entry_${idx + 1}.md`, detail: longArgsPayload },
            result: `[Step ${idx + 1}]\n${longResultPayload}`,
            ok: idx !== 5,
            error: idx === 5 ? 'Simulated tool failure on step #6' : undefined,
            durationMs: 4 + idx,
            startedAt: now - (12 - idx) * 100,
        }));

        const twoSteps = Array.from({ length: 2 }, (_, idx) => ({
            stepIndex: idx,
            toolCallId: `call_prev_${idx + 1}`,
            toolName: idx === 0 ? 'read_variables' : 'patch_variables',
            args: { path: '/state/variables.json' },
            result: `prev_result_${idx + 1}`,
            ok: true,
            durationMs: 2,
            startedAt: now - 20000 + idx * 50,
        }));

        const sampleTraces = [
            {
                runId: 'run_many',
                target: { messageId: 12, swipeId: 0 },
                phase: 'main_turn' as const,
                agentProfileId: 'main',
                agentName: 'Main Narrative',
                connectionId: 'conn_1',
                model: 'claude-sonnet-4.5',
                status: 'completed' as const,
                startedAt: now - 5000,
                endedAt: now - 1000,
                durationMs: 4000,
                usage: {
                    inputTokens: 12000,
                    cachedTokens: 8200,
                    outputTokens: 600,
                    totalTokens: 12600,
                    cacheHitRate: 0.683,
                },
                toolSteps: manySteps,
                outputPreview: '最终生成正文预览。',
            },
            {
                runId: 'run_prev',
                target: { messageId: 11, swipeId: 0 },
                phase: 'after_turn' as const,
                agentProfileId: 'ag_vars',
                agentName: '变量管家',
                connectionId: 'conn_1',
                model: 'gemini-2.5-flash',
                status: 'completed' as const,
                startedAt: now - 25000,
                endedAt: now - 24500,
                durationMs: 500,
                usage: {
                    inputTokens: 4000,
                    cachedTokens: 3200,
                    outputTokens: 120,
                    totalTokens: 4120,
                    cacheHitRate: 0.8,
                },
                toolSteps: twoSteps,
            },
        ];

        // 1. Desktop (1280x800)
        await page.viewport(1280, 800);
        activeHarness = createHarness({ initialTab: 'logs', initialOpen: true });
        activeHarness.store.setTraces(sampleTraces);
        await settleLayout(5);

        const { dialog, shadowRoot } = getShellElements();

        // No secondary toggle button should exist; both runs start collapsed
        expect(shadowRoot.querySelector('[data-log-steps-toggle]')).toBeNull();
        const manyRunBtn = shadowRoot.querySelector(
            '[data-log-run-item="run_many"]',
        ) as HTMLButtonElement | null;
        const prevRunBtn = shadowRoot.querySelector(
            '[data-log-run-item="run_prev"]',
        ) as HTMLButtonElement | null;
        expect(manyRunBtn).toBeTruthy();
        expect(prevRunBtn).toBeTruthy();
        expect(manyRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(prevRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(shadowRoot.querySelector('[data-log-steps-list="run_many"]')).toBeNull();
        expect(shadowRoot.querySelector('[data-log-steps-list="run_prev"]')).toBeNull();

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:logs:collapsed');
        assertInteractiveTargetsAndTypography(shadowRoot, 'desktop:logs:collapsed');

        // Click the initially selected run card (run_many) -> expands run_many, keeps run_prev collapsed
        manyRunBtn!.click();
        await settleLayout(4);

        expect(manyRunBtn!.getAttribute('aria-expanded')).toBe('true');
        expect(prevRunBtn!.getAttribute('aria-expanded')).toBe('false');
        const manyStepsListAfterFirstClick = shadowRoot.querySelector(
            '[data-log-steps-list="run_many"]',
        ) as HTMLDivElement | null;
        expect(manyStepsListAfterFirstClick).toBeTruthy();
        expect(manyStepsListAfterFirstClick!.querySelectorAll('.ag-log-step-item')).toHaveLength(12);
        expect(shadowRoot.querySelector('[data-log-steps-list="run_prev"]')).toBeNull();

        assertNoHorizontalOverflow(dialog, shadowRoot, 'desktop:logs:expanded');
        assertInteractiveTargetsAndTypography(shadowRoot, 'desktop:logs:expanded');

        // Click run_prev -> expands run_prev and automatically collapses run_many
        prevRunBtn!.click();
        await settleLayout(4);

        expect(prevRunBtn!.getAttribute('aria-expanded')).toBe('true');
        expect(manyRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(shadowRoot.querySelector('[data-log-steps-list="run_many"]')).toBeNull();
        const prevStepsList = shadowRoot.querySelector(
            '[data-log-steps-list="run_prev"]',
        ) as HTMLDivElement | null;
        expect(prevStepsList).toBeTruthy();
        expect(prevStepsList!.querySelectorAll('.ag-log-step-item')).toHaveLength(2);

        // Click run_many again -> expands run_many and automatically collapses run_prev
        manyRunBtn!.click();
        await settleLayout(4);

        expect(manyRunBtn!.getAttribute('aria-expanded')).toBe('true');
        expect(prevRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(shadowRoot.querySelector('[data-log-steps-list="run_prev"]')).toBeNull();
        const manyStepsList = shadowRoot.querySelector(
            '[data-log-steps-list="run_many"]',
        ) as HTMLDivElement | null;
        expect(manyStepsList).toBeTruthy();
        expect(manyStepsList!.querySelectorAll('.ag-log-step-item')).toHaveLength(12);

        // Click step #10 -> scrolls .ag-split-detail to step #10 card with focused highlight
        const detailEl = shadowRoot.querySelector('.ag-split-detail') as HTMLDivElement;
        expect(detailEl).toBeTruthy();
        expect(detailEl.scrollHeight).toBeGreaterThan(detailEl.clientHeight);

        const step10Btn = manyStepsList!.querySelector(
            '[data-log-step-index="9"]',
        ) as HTMLButtonElement;
        expect(step10Btn).toBeTruthy();
        step10Btn.click();

        await vi.waitFor(
            () => {
                const card10 = shadowRoot.querySelector(
                    '[data-log-step-card][data-log-step-index="9"]',
                ) as HTMLDivElement | null;
                expect(card10).toBeTruthy();
                expect(card10!.classList.contains('ag-log-step-card-focused')).toBe(true);
                expect(card10!.getAttribute('data-focused')).toBe('true');
                expect(detailEl.scrollTop).toBeGreaterThan(0);

                const detailRect = detailEl.getBoundingClientRect();
                const cardRect = card10!.getBoundingClientRect();
                expect(cardRect.top).toBeGreaterThanOrEqual(detailRect.top - 2);
                expect(cardRect.top).toBeLessThan(detailRect.top + detailRect.height / 2);
            },
            { timeout: 2500 },
        );

        // Switch to 'raw' JSON tab, then click step #12 -> switches back to 'steps' & scrolls to step #12
        const rawRadio = shadowRoot.querySelector(
            '[role="radiogroup"][aria-label="日志详情视图"] [role="radio"]:nth-child(2)',
        ) as HTMLButtonElement;
        expect(rawRadio).toBeTruthy();
        rawRadio.click();
        await settleLayout(3);

        const step12Btn = manyStepsList!.querySelector(
            '[data-log-step-index="11"]',
        ) as HTMLButtonElement;
        expect(step12Btn).toBeTruthy();
        step12Btn.click();

        await vi.waitFor(
            () => {
                const card12 = shadowRoot.querySelector(
                    '[data-log-step-card][data-log-step-index="11"]',
                ) as HTMLDivElement | null;
                expect(card12).toBeTruthy();
                expect(card12!.classList.contains('ag-log-step-card-focused')).toBe(true);
                expect(detailEl.scrollTop).toBeGreaterThan(0);

                const detailRect = detailEl.getBoundingClientRect();
                const cardRect = card12!.getBoundingClientRect();
                expect(cardRect.top).toBeGreaterThanOrEqual(detailRect.top - 2);
                expect(cardRect.top).toBeLessThan(detailRect.bottom - 24);
            },
            { timeout: 2500 },
        );

        await waitForScrollIdle(detailEl);

        // Manually scroll back to top (after smooth scroll finishes), then re-click step #12 -> scrolls down again
        detailEl.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
        await waitForScrollIdle(detailEl);
        expect(detailEl.scrollTop).toBe(0);
        step12Btn.click();

        await vi.waitFor(
            () => {
                const card12 = shadowRoot.querySelector(
                    '[data-log-step-card][data-log-step-index="11"]',
                ) as HTMLDivElement | null;
                expect(card12).toBeTruthy();
                expect(detailEl.scrollTop).toBeGreaterThan(0);
                const detailRect = detailEl.getBoundingClientRect();
                const cardRect = card12!.getBoundingClientRect();
                expect(cardRect.top).toBeGreaterThanOrEqual(detailRect.top - 2);
                expect(cardRect.top).toBeLessThan(detailRect.bottom - 24);
            },
            { timeout: 2500 },
        );

        // Click already-selected & expanded run_many -> collapses run_many AND scrolls detail pane back to top
        manyRunBtn!.click();

        await vi.waitFor(
            () => {
                expect(detailEl.scrollTop).toBeLessThanOrEqual(2);
            },
            { timeout: 2500 },
        );
        expect(manyRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(shadowRoot.querySelector('[data-log-steps-list="run_many"]')).toBeNull();

        activeHarness.cleanup();
        activeHarness = null;

        // 2. Mobile (390x844)
        await page.viewport(390, 844);
        activeHarness = createHarness({ initialTab: 'logs', initialOpen: true });
        activeHarness.store.setTraces(sampleTraces);
        await settleLayout(5);

        const { dialog: mobileDialog, shadowRoot: mobileShadow } = getShellElements();
        expect(mobileShadow.querySelector('[data-log-steps-toggle]')).toBeNull();
        const mobileManyRunBtn = mobileShadow.querySelector(
            '[data-log-run-item="run_many"]',
        ) as HTMLButtonElement | null;
        expect(mobileManyRunBtn).toBeTruthy();
        expect(mobileManyRunBtn!.getAttribute('aria-expanded')).toBe('false');
        expect(mobileShadow.querySelector('[data-log-steps-list="run_many"]')).toBeNull();

        // Tap run_many -> expands run_many and pushes into detail view
        mobileManyRunBtn!.click();
        await settleLayout(4);

        const backBtnToMaster = mobileShadow.querySelector('.ag-stack-back-btn') as HTMLButtonElement | null;
        expect(backBtnToMaster).toBeTruthy();
        expect(isElementVisible(backBtnToMaster!)).toBe(true);

        // Return to master list -> run_many is expanded with 12 step buttons
        backBtnToMaster!.click();
        await settleLayout(4);
        expect(mobileShadow.querySelector('.ag-stack-back-btn')).toBeNull();

        const mobileRunBtnAfterBack = mobileShadow.querySelector(
            '[data-log-run-item="run_many"]',
        ) as HTMLButtonElement | null;
        expect(mobileRunBtnAfterBack).toBeTruthy();
        expect(mobileRunBtnAfterBack!.getAttribute('aria-expanded')).toBe('true');

        const mobileStepsList = mobileShadow.querySelector(
            '[data-log-steps-list="run_many"]',
        ) as HTMLDivElement | null;
        expect(mobileStepsList).toBeTruthy();
        expect(mobileStepsList!.querySelectorAll('.ag-log-step-item')).toHaveLength(12);

        assertNoHorizontalOverflow(mobileDialog, mobileShadow, 'mobile:logs:expanded');
        assertInteractiveTargetsAndTypography(mobileShadow, 'mobile:logs:expanded');

        // Tap step #10 -> pushes into detail view & scrolls .ag-stack-body to step #10
        const mobileStep10Btn = mobileStepsList!.querySelector(
            '[data-log-step-index="9"]',
        ) as HTMLButtonElement;
        expect(mobileStep10Btn).toBeTruthy();
        mobileStep10Btn.click();
        await settleLayout(4);

        const backBtn = mobileShadow.querySelector('.ag-stack-back-btn') as HTMLButtonElement | null;
        expect(backBtn).toBeTruthy();
        expect(isElementVisible(backBtn!)).toBe(true);

        const stackBody = mobileShadow.querySelector('.ag-stack-body') as HTMLDivElement;
        expect(stackBody).toBeTruthy();

        await vi.waitFor(
            () => {
                const card10 = mobileShadow.querySelector(
                    '[data-log-step-card][data-log-step-index="9"]',
                ) as HTMLDivElement | null;
                expect(card10).toBeTruthy();
                expect(card10!.classList.contains('ag-log-step-card-focused')).toBe(true);
                expect(stackBody.scrollTop).toBeGreaterThan(0);

                const bodyRect = stackBody.getBoundingClientRect();
                const cardRect = card10!.getBoundingClientRect();
                expect(cardRect.top).toBeGreaterThanOrEqual(bodyRect.top - 2);
                expect(cardRect.top).toBeLessThan(bodyRect.bottom - 24);
            },
            { timeout: 2500 },
        );
    });

    it('clips long text in <agentic-capsule> badges/tasks and FilesOverridesView list-item badges without horizontal overflow across desktop and mobile', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);
            const baseServices = createMockUIServices();
            activeHarness = createHarness({
                initialTab: 'files',
                initialOpen: true,
                services: {
                    ...baseServices,
                    async listFilesAndOverrides(target) {
                        const base = await baseServices.listFilesAndOverrides(target);
                        return [
                            {
                                id: 'variables:global_variables.json',
                                category: 'variables',
                                storageScope: 'global',
                                namespace: 'variables',
                                path: '/state/global_variables.json',
                                key: 'global_variables.json',
                                target: { messageId: 12, swipeId: 0 },
                                layerLabel: '全局变量 (ST extension_settings.variables.global)',
                                source: 'st-global',
                                content: '{}',
                                baseContent: '{}',
                                overridden: false,
                                writable: true,
                            },
                            ...base,
                        ];
                    },
                },
            });
            await settleLayout(5);

            // 1. Verify FilesOverridesView long layerLabel badge clips inside .ag-list-item bounds
            const { dialog, shadowRoot } = getShellElements();
            const globalVarsItem = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find(
                (el) => el.textContent?.includes('/state/global_variables.json'),
            ) as HTMLElement | undefined;
            expect(globalVarsItem, `${vp.label}: expected /state/global_variables.json item`).toBeTruthy();

            const itemRect = globalVarsItem!.getBoundingClientRect();
            const badges = Array.from(globalVarsItem!.querySelectorAll('.ag-badge')) as HTMLElement[];
            expect(badges.length).toBeGreaterThan(0);
            for (const badge of badges) {
                const badgeRect = badge.getBoundingClientRect();
                expect(
                    badgeRect.right,
                    `${vp.label}: badge "${badge.textContent?.trim()}" overflows item right (${badgeRect.right} > ${itemRect.right})`,
                ).toBeLessThanOrEqual(itemRect.right + 1);
            }
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:files:badge_clip`);

            // 2. Verify <agentic-capsule> clips long summary, badge labels, and background task labels
            activeHarness.store.closeConsole();
            await settleLayout(3);

            activeHarness.capsule.setState({
                status: 'background-running',
                persistMode: 'keep',
                summary:
                    '超长胶囊摘要文本测试_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_用于验证溢出裁剪与省略号截断',
                badges: [
                    {
                        label: '全局变量 (ST extension_settings.variables.global) 超长胶囊标签测试',
                        tone: 'warning',
                        tab: 'files',
                    },
                ],
                backgroundTasks: [
                    {
                        taskId: 'bg_overflow_1',
                        target: { messageId: 0, swipeId: 0 },
                        phase: 'after_turn',
                        barrier: 'none',
                        agentProfileId: 'ag_test',
                        label: '超长后台任务名称_ComfyUI生图工作流执行中_ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                        state: 'running',
                        startedAt: Date.now() - 5000,
                    },
                ],
            });
            await settleLayout(4);

            const capShadow = activeHarness.capsule.shadowRoot!;
            const capShell = capShadow.querySelector('.cap-shell') as HTMLDivElement;
            const shellRect = capShell.getBoundingClientRect();
            expect(
                capShell.scrollWidth,
                `${vp.label}: capsule horizontal overflow (${capShell.scrollWidth} > ${capShell.clientWidth})`,
            ).toBeLessThanOrEqual(capShell.clientWidth + 1);

            const capPill = capShadow.querySelector('.cap-badge-pill') as HTMLElement | null;
            expect(capPill).toBeTruthy();
            expect(capPill!.getBoundingClientRect().right).toBeLessThanOrEqual(shellRect.right + 1);

            const taskGroup = capShadow.querySelector('.cap-task-group') as HTMLElement | null;
            expect(taskGroup).toBeTruthy();
            expect(taskGroup!.getBoundingClientRect().right).toBeLessThanOrEqual(shellRect.right + 1);
        }
    });

    it('renders retry telemetry, retry history, and targeted rerun button in LogsView across desktop and mobile viewports', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            const rerunCalls: Array<{
                target?: { messageId: number; swipeId: number };
                options?: { triggerIds?: string[] };
            }> = [];
            const baseServices = createMockUIServices();
            const failedAfterTurnTrace = {
                runId: 'run_4_3_phys_retry',
                target: { messageId: 4, swipeId: 3 },
                phase: 'after_turn' as const,
                agentProfileId: 'ag_phys',
                agentName: '🍌生理更新',
                triggerId: 'tr_phys_1',
                triggerLabel: '🍌生理更新',
                triggerSource: 'worldinfo' as const,
                lorebookNames: ['生理系统'],
                connectionId: 'conn_gemini',
                model: 'gemini-4-hydrogen',
                status: 'error' as const,
                startedAt: Date.now() - 108_000,
                endedAt: Date.now() - 100,
                durationMs: 107_950,
                usage: {
                    inputTokens: 9641,
                    cachedTokens: 0,
                    outputTokens: 223,
                    totalTokens: 9864,
                    cacheHitRate: 0,
                },
                toolSteps: [
                    {
                        stepIndex: 0,
                        toolCallId: 'call_read_vars_1',
                        toolName: 'read_variables',
                        args: { scope: 'message' },
                        result: '{"ok":true}',
                        ok: true,
                        durationMs: 1,
                        startedAt: Date.now() - 107_000,
                    },
                ],
                retryCount: 2,
                roundMaxRetries: 2,
                retryEvents: [
                    {
                        round: 2,
                        attempt: 1,
                        maxAttempts: 2,
                        reason: 'EMPTY_RESPONSE',
                        delayMs: 1200,
                        timestamp: Date.now() - 50_000,
                        finishReason: 'STOP',
                        outputTokens: 223,
                        hasReasoning: true,
                    },
                    {
                        round: 2,
                        attempt: 2,
                        maxAttempts: 2,
                        reason: 'EMPTY_RESPONSE',
                        delayMs: 2400,
                        timestamp: Date.now() - 20_000,
                        finishReason: 'STOP',
                    },
                ],
                error: 'Model returned an empty response with no tool calls.',
            };

            const traces = [failedAfterTurnTrace, ...createMockTraces()];
            activeHarness = createHarness({
                initialTab: 'logs',
                initialOpen: true,
                services: {
                    ...baseServices,
                    listTraces: async () => traces,
                    rerunAfterTurn: async (target, options) => {
                        rerunCalls.push({ target, options });
                    },
                },
            });
            activeHarness.store.setTraces(traces);
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            const failedItem = shadowRoot.querySelector(
                '[data-log-run-item="run_4_3_phys_retry"]',
            ) as HTMLButtonElement | null;
            expect(failedItem, `${vp.label}: expected failed run item`).toBeTruthy();
            expect(failedItem!.textContent).toContain('重试 2 次');

            failedItem!.click();
            await settleLayout(5);

            const retryHistoryCard = shadowRoot.querySelector(
                '[data-log-retry-history="run_4_3_phys_retry"]',
            ) as HTMLElement | null;
            expect(retryHistoryCard, `${vp.label}: expected retry history card`).toBeTruthy();
            expect(retryHistoryCard!.textContent).toContain('自动重试记录 (2)');
            expect(retryHistoryCard!.textContent).toContain('EMPTY_RESPONSE');
            expect(retryHistoryCard!.textContent).toContain('含思考内容');

            const rerunBtn = shadowRoot.querySelector(
                'button.ag-log-rerun-btn',
            ) as HTMLButtonElement | null;
            expect(rerunBtn, `${vp.label}: expected manual rerun button`).toBeTruthy();
            expect(rerunBtn!.textContent).toContain('重试此触发器');

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:logs:retry_detail`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:logs:retry_detail`);

            rerunBtn!.click();
            await vi.waitFor(() => {
                expect(rerunCalls).toHaveLength(1);
            });
            expect(rerunCalls[0]).toEqual({
                target: { messageId: 4, swipeId: 3 },
                options: { triggerIds: ['tr_phys_1'] },
            });
        }
    });

    it('supports single-trigger manual run in PipelineView and superseded log badges in LogsView across desktop and mobile', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800, isMobile: false },
            { label: 'mobile', width: 390, height: 844, isMobile: true },
        ]) {
            activeHarness?.cleanup();
            activeHarness = null;
            await page.viewport(vp.width, vp.height);

            const rerunCalls: Array<{
                target?: { messageId: number; swipeId: number };
                options?: { triggerIds?: string[]; force?: boolean };
            }> = [];
            const baseServices = createMockUIServices();
            const now = Date.now();
            const initialTraces = [...createMockTraces()];
            let dynamicTraces = [...initialTraces];

            activeHarness = createHarness({
                initialTab: 'pipeline',
                initialOpen: true,
                services: {
                    ...baseServices,
                    listTraces: async () => dynamicTraces.map((t) => ({ ...t })),
                    rerunAfterTurn: async (target, options) => {
                        rerunCalls.push({ target, options });
                        const triggerId = options?.triggerIds?.[0] ?? 'tr_manual';
                        dynamicTraces = [
                            {
                                runId: `run_manual_${rerunCalls.length}`,
                                target: target ?? { messageId: 12, swipeId: 0 },
                                phase: 'after_turn',
                                agentProfileId: 'ag_vars',
                                agentName: '手动运行测试',
                                triggerId,
                                triggerLabel: triggerId,
                                triggerSource: 'preset',
                                connectionId: 'conn_gemini',
                                model: 'gemini-4-hydrogen',
                                status: 'completed',
                                startedAt: now + rerunCalls.length * 1000,
                                endedAt: now + rerunCalls.length * 1000 + 250,
                                durationMs: 250,
                                usage: {
                                    inputTokens: 500,
                                    cachedTokens: 300,
                                    outputTokens: 60,
                                    totalTokens: 560,
                                    cacheHitRate: 0.6,
                                },
                                toolSteps: [],
                            },
                            ...dynamicTraces,
                        ];
                    },
                },
            });
            activeHarness.store.setActiveTarget({ messageId: 12, swipeId: 0 });
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            const returnToListIfMobile = async () => {
                if (!vp.isMobile) {
                    return;
                }
                const backBtn = shadowRoot.querySelector(
                    'button.ag-stack-back-btn',
                ) as HTMLButtonElement | null;
                if (backBtn) {
                    backBtn.click();
                    await settleLayout(5);
                }
            };

            // 1. Select an after_turn preset rule (e.g., tr_outline) and run it manually.
            const outlineBtn = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find((el) =>
                el.textContent?.includes('大纲与伏笔记录'),
            ) as HTMLButtonElement | undefined;
            expect(outlineBtn, `${vp.label}: expected tr_outline rule item`).toBeTruthy();
            outlineBtn!.click();
            await settleLayout(5);

            const runPresetBtn = shadowRoot.querySelector(
                'button.ag-pipeline-run-btn',
            ) as HTMLButtonElement | null;
            expect(runPresetBtn, `${vp.label}: expected preset manual run button`).toBeTruthy();
            expect(runPresetBtn!.disabled).toBe(false);
            expect(runPresetBtn!.textContent).toContain('立即运行 (#12#0)');

            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pipeline:preset_detail`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:pipeline:preset_detail`);

            runPresetBtn!.click();
            await vi.waitFor(() => {
                expect(rerunCalls).toHaveLength(1);
            });
            expect(rerunCalls[0]).toEqual({
                target: { messageId: 12, swipeId: 0 },
                options: { triggerIds: ['tr_outline'], force: true },
            });

            await settleLayout(5);
            const toastActionBtn = shadowRoot.querySelector(
                'button.ag-toast-action',
            ) as HTMLButtonElement | null;
            expect(toastActionBtn, `${vp.label}: expected toast 查看日志 button`).toBeTruthy();
            expect(toastActionBtn!.textContent).toContain('查看日志');
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pipeline:toast_action`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:pipeline:toast_action`);

            // 2. Select non-after_turn rule (maintenance: Watermark Compaction) -> disabled.
            await returnToListIfMobile();
            const compactBtn = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find((el) =>
                el.textContent?.includes('Watermark Compaction'),
            ) as HTMLButtonElement | undefined;
            expect(compactBtn, `${vp.label}: expected maintenance rule item`).toBeTruthy();
            compactBtn!.click();
            await settleLayout(5);

            const disabledRunBtn = shadowRoot.querySelector(
                'button.ag-pipeline-run-btn',
            ) as HTMLButtonElement | null;
            expect(disabledRunBtn).toBeTruthy();
            expect(disabledRunBtn!.disabled).toBe(true);

            // 3. Select scanned WI after_turn rule (uid 20 in 玄幻世界) -> can run without importing.
            await returnToListIfMobile();
            const scannedWiBtn = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find(
                (el) =>
                    el.textContent?.includes('好感与灵力结算')
                    && el.textContent?.includes('世界书 @@ (实时扫描)'),
            ) as HTMLButtonElement | undefined;
            expect(scannedWiBtn, `${vp.label}: expected scanned WI rule item`).toBeTruthy();
            scannedWiBtn!.click();
            await settleLayout(5);

            const runWiBtn = shadowRoot.querySelector(
                'button.ag-pipeline-run-btn',
            ) as HTMLButtonElement | null;
            expect(runWiBtn).toBeTruthy();
            expect(runWiBtn!.disabled).toBe(false);
            expect(runWiBtn!.textContent).toContain('立即运行 (#12#0)');
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:pipeline:scanned_wi`);
            assertInteractiveTargetsAndTypography(shadowRoot, `${vp.label}:pipeline:scanned_wi`);

            runWiBtn!.click();
            await vi.waitFor(() => {
                expect(rerunCalls).toHaveLength(2);
            });
            expect(rerunCalls[1]).toEqual({
                target: { messageId: 12, swipeId: 0 },
                options: {
                    triggerIds: [buildWorldInfoTriggerRuleId('玄幻世界', 20)],
                    force: true,
                },
            });

            // 4. Click "查看日志" on toast -> jumps to logs tab and highlights newest manual trace.
            await settleLayout(5);
            const jumpLogsBtn = shadowRoot.querySelector(
                'button.ag-toast-action',
            ) as HTMLButtonElement | null;
            expect(jumpLogsBtn).toBeTruthy();
            jumpLogsBtn!.click();
            await settleLayout(5);
            expect(activeHarness.store.getSnapshot().activeTab).toBe('logs');

            // 5. Verify LogsView non-destructive superseded markers ("已重跑") and button labels.
            const newerDoneTrace = {
                runId: 'run_superseded_new',
                target: { messageId: 8, swipeId: 0 },
                phase: 'after_turn' as const,
                agentProfileId: 'ag_phys',
                agentName: '生理更新',
                triggerId: 'tr_phys_8',
                triggerLabel: '生理更新',
                connectionId: 'conn_gemini',
                model: 'gemini-4-hydrogen',
                status: 'completed' as const,
                startedAt: now + 50_000,
                endedAt: now + 51_000,
                durationMs: 1000,
                usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20, cacheHitRate: 0 },
                toolSteps: [],
            };
            const olderErrTrace = {
                ...newerDoneTrace,
                runId: 'run_superseded_old',
                status: 'error' as const,
                startedAt: now + 10_000,
                endedAt: now + 12_000,
                durationMs: 2000,
                error: 'Transient failure',
            };
            const unrecoveredErrTrace = {
                ...newerDoneTrace,
                runId: 'run_unrecovered_err',
                target: { messageId: 9, swipeId: 0 },
                triggerId: 'tr_other_9',
                status: 'error' as const,
                startedAt: now + 20_000,
                endedAt: now + 22_000,
                durationMs: 2000,
                error: 'Still failing',
            };
            activeHarness.store.setTraces([
                newerDoneTrace,
                olderErrTrace,
                unrecoveredErrTrace,
            ]);
            await settleLayout(5);
            await returnToListIfMobile();

            const allFloorsBtn = Array.from(shadowRoot.querySelectorAll('button')).find((el) =>
                el.textContent?.trim() === '全部楼层',
            ) as HTMLButtonElement | undefined;
            expect(allFloorsBtn).toBeTruthy();
            allFloorsBtn!.click();
            await settleLayout(5);

            const getOldItem = () =>
                shadowRoot.querySelector(
                    '[data-log-run-item="run_superseded_old"]',
                ) as HTMLButtonElement | null;
            const getNewItem = () =>
                shadowRoot.querySelector(
                    '[data-log-run-item="run_superseded_new"]',
                ) as HTMLButtonElement | null;
            const getUnrecoveredItem = () =>
                shadowRoot.querySelector(
                    '[data-log-run-item="run_unrecovered_err"]',
                ) as HTMLButtonElement | null;

            expect(getOldItem()).toBeTruthy();
            expect(getNewItem()).toBeTruthy();
            expect(getUnrecoveredItem()).toBeTruthy();

            expect(getOldItem()!.getAttribute('data-log-superseded')).toBe('true');
            expect(getOldItem()!.classList.contains('ag-log-run-superseded')).toBe(true);
            expect(getOldItem()!.textContent).toContain('已重跑');

            expect(getNewItem()!.getAttribute('data-log-superseded')).toBeNull();
            expect(getNewItem()!.textContent).not.toContain('已重跑');

            expect(getUnrecoveredItem()!.getAttribute('data-log-superseded')).toBeNull();
            expect(getUnrecoveredItem()!.textContent).not.toContain('已重跑');

            // Select superseded old error -> shows 已重跑 in detail and secondary button
            getOldItem()!.click();
            await settleLayout(5);
            const oldRerunBtn = shadowRoot.querySelector(
                'button.ag-log-rerun-btn',
            ) as HTMLButtonElement | null;
            expect(oldRerunBtn).toBeTruthy();
            expect(oldRerunBtn!.textContent).toContain('重试此触发器');
            expect(oldRerunBtn!.classList.contains('ag-btn-secondary')).toBe(true);

            // Select newer completed trace -> button says "重跑此触发器" (secondary)
            await returnToListIfMobile();
            getNewItem()!.click();
            await settleLayout(5);
            const newRerunBtn = shadowRoot.querySelector(
                'button.ag-log-rerun-btn',
            ) as HTMLButtonElement | null;
            expect(newRerunBtn).toBeTruthy();
            expect(newRerunBtn!.textContent).toContain('重跑此触发器');
            expect(newRerunBtn!.classList.contains('ag-btn-secondary')).toBe(true);

            // Select unrecovered error trace -> button says "重试此触发器" (primary)
            await returnToListIfMobile();
            getUnrecoveredItem()!.click();
            await settleLayout(5);
            const unrecoveredBtn = shadowRoot.querySelector(
                'button.ag-log-rerun-btn',
            ) as HTMLButtonElement | null;
            expect(unrecoveredBtn).toBeTruthy();
            expect(unrecoveredBtn!.textContent).toContain('重试此触发器');
            expect(unrecoveredBtn!.classList.contains('ag-btn-primary')).toBe(true);
        }
    });

    it('updates LogsView in real time for running traces and in-flight tool steps without manual refresh', async () => {
        await page.viewport(1280, 800);
        const listeners = new Set<(event: GenerationEventPayload) => void>();
        const services: AgenticUIServices = {
            ...createMockUIServices(),
            subscribeEvents: (listener) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        const emit = (event: GenerationEventPayload) => {
            for (const listener of listeners) {
                listener(event);
            }
        };

        activeHarness = createHarness({ initialTab: 'logs', initialOpen: true, services });
        activeHarness.store.setTraces([]);
        await settleLayout(5);

        const { shadowRoot } = getShellElements();
        const startedAt = Date.now();
        const baseTrace = {
            runId: 'run_live_draw_2',
            target: { messageId: 2, swipeId: 0 },
            phase: 'after_turn' as const,
            agentProfileId: 'ag_draw',
            agentName: '生图调用',
            triggerId: 'tr_draw_2',
            triggerLabel: '生图调用',
            lorebookNames: ['ComfyUI生图'],
            connectionId: 'conn_gemini',
            model: 'gemini-4-hydrogen',
            status: 'running' as const,
            startedAt,
            durationMs: 0,
            usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, cacheHitRate: 0 },
            toolSteps: [],
        };

        // 1. Initial running trace with 0 steps shows waiting message, not "本轮运行未调用工具"
        emit({
            kind: 'trace_recorded',
            target: baseTrace.target,
            timestamp: startedAt,
            phase: 'after_turn',
            runId: baseTrace.runId,
            agentProfileId: baseTrace.agentProfileId,
            trace: baseTrace,
        });
        await settleLayout(5);

        expect(shadowRoot.textContent).toContain('运行中，正在等待模型响应或工具调用...');
        expect(shadowRoot.textContent).not.toContain('本轮运行未调用工具');

        // 2. Tool starts -> trace_recorded + tool_started updates UI immediately without clicking refresh
        const runningStep = {
            stepIndex: 0,
            toolCallId: 'call_comfy_live_1',
            toolName: 'comfyui_generate',
            args: { prompt: 'cyber_alley' },
            result: '',
            ok: true,
            status: 'running' as const,
            durationMs: 0,
            startedAt: startedAt + 500,
        };
        emit({
            kind: 'trace_recorded',
            target: baseTrace.target,
            timestamp: startedAt + 500,
            phase: 'after_turn',
            runId: baseTrace.runId,
            agentProfileId: baseTrace.agentProfileId,
            trace: {
                ...baseTrace,
                durationMs: 500,
                usage: { inputTokens: 1200, cachedTokens: 800, outputTokens: 35, cacheHitRate: 800 / 1200 },
                toolSteps: [runningStep],
            },
        });
        await settleLayout(5);

        const stepCard = shadowRoot.querySelector('[data-log-step-index="0"]') as HTMLElement | null;
        expect(stepCard).toBeTruthy();
        expect(stepCard!.textContent).toContain('comfyui_generate');
        expect(stepCard!.textContent).toContain('执行中');
        expect(stepCard!.textContent).toContain('进行中...');
        expect(stepCard!.textContent).toContain('工具执行中，等待返回结果...');
        expect(stepCard!.textContent).toContain('cyber_alley');

        // Expand left tree to verify running badge in step branch
        const runItem = shadowRoot.querySelector(
            '[data-log-run-item="run_live_draw_2"]',
        ) as HTMLButtonElement | null;
        expect(runItem).toBeTruthy();
        runItem!.click();
        await settleLayout(5);
        const stepTreeBtn = shadowRoot.querySelector('[data-log-step-index="0"].ag-log-step-item') as HTMLElement | null;
        expect(stepTreeBtn).toBeTruthy();
        expect(stepTreeBtn!.textContent).toContain('运行中');

        // 3. Tool completes via tool_completed event (and second tool starts via tool_started)
        emit({
            kind: 'tool_completed',
            target: baseTrace.target,
            timestamp: startedAt + 2500,
            phase: 'after_turn',
            runId: baseTrace.runId,
            agentProfileId: baseTrace.agentProfileId,
            toolStep: {
                ...runningStep,
                result: '{"ok":true,"url":"/img/cyber.png"}',
                ok: true,
                status: 'completed',
                durationMs: 2000,
            },
        });
        emit({
            kind: 'tool_started',
            target: baseTrace.target,
            timestamp: startedAt + 2600,
            phase: 'after_turn',
            runId: baseTrace.runId,
            agentProfileId: baseTrace.agentProfileId,
            toolStep: {
                stepIndex: 1,
                toolCallId: 'call_write_vars_2',
                toolName: 'patch_variables',
                args: { lastImage: '/img/cyber.png' },
                result: '',
                ok: true,
                status: 'running',
                durationMs: 0,
                startedAt: startedAt + 2600,
            },
        });
        await settleLayout(5);

        const updatedCard0 = shadowRoot.querySelector('[data-log-step-index="0"].ag-log-step-card') as HTMLElement | null;
        const card1 = shadowRoot.querySelector('[data-log-step-index="1"].ag-log-step-card') as HTMLElement | null;
        expect(updatedCard0).toBeTruthy();
        expect(updatedCard0!.textContent).toContain('成功');
        expect(updatedCard0!.textContent).toContain('/img/cyber.png');
        expect(card1).toBeTruthy();
        expect(card1!.textContent).toContain('patch_variables');
        expect(card1!.textContent).toContain('执行中');
    });
});
