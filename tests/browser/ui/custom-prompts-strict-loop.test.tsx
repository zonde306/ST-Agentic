import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { resolveActivePreset } from '@/core/config';
import type { ConsoleTabId } from '@/core/types';
import { registerAssistantView } from '@/ui/assistant';
import { registerSessionViews } from '@/ui/session';
import { AgenticAppShell } from '@/ui/shell';
import { registerSideGenView } from '@/ui/sidegen';
import {
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
    shadowHost: HTMLDivElement;
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
    return { dialog, shadowHost, shadowRoot: shadowHost.shadowRoot };
}

function createHarness(initialTab: ConsoleTabId): MountedHarness {
    const unregisterAssistant = registerAssistantView();
    const unregisterSideGen = registerSideGenView();
    const unregisterSession = registerSessionViews();
    const unregisterStudio = registerStudioViews();

    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab,
        services: createMockUIServices(),
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

function setSelectValue(el: HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

function findButtonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
    return Array.from(root.querySelectorAll('button')).find(
        (btn) => btn.textContent?.trim() === text,
    ) as HTMLButtonElement | undefined;
}

function assertTouchTargetsAndInputs(shadowRoot: ShadowRoot, label: string): void {
    const interactive = Array.from(
        shadowRoot.querySelectorAll('button, [role="switch"], [role="radio"]'),
    ).filter(isElementVisible);
    expect(interactive.length, `${label}: expected visible controls`).toBeGreaterThan(0);

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

describe('Studio UI: custom JSON prompt blocks & strict tool loop controls', () => {
    let activeHarness: MountedHarness | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        activeHarness?.cleanup();
        activeHarness = null;
        await page.viewport(1280, 800);
    });

    it('supports custom role, templates, JSON/EJS validation, and prefix system ordering warning in PromptsView (desktop & mobile)', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = createHarness('prompts');
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();
            if (vp.label === 'mobile') {
                const dialogRect = dialog.getBoundingClientRect();
                expect(Math.round(dialogRect.width)).toBe(390);
                expect(Math.round(dialogRect.height)).toBe(844);
            }

            // Open create modal
            const addBtn = findButtonByText(shadowRoot, '添加');
            expect(addBtn, `${vp.label}: expected 添加 button`).toBeTruthy();
            addBtn!.click();
            await settleLayout(4);

            const modal = shadowRoot.querySelector('.ag-modal') as HTMLElement | null;
            expect(modal, `${vp.label}: expected prompt editor ShadowModal`).toBeTruthy();

            // Enter block name
            const nameInput = modal!.querySelector(
                'input[placeholder*="身份定义"]',
            ) as HTMLInputElement;
            expect(nameInput).toBeTruthy();
            setInputValue(nameInput, '初始工具上下文');

            // Select role === 'custom'
            const roleSelect = modal!.querySelector(
                'select[aria-label="提示词消息角色"]',
            ) as HTMLSelectElement;
            expect(roleSelect).toBeTruthy();
            const customOption = Array.from(roleSelect.options).find((o) => o.value === 'custom');
            expect(customOption?.textContent).toBe('custom (自定义 JSON 消息)');
            setSelectValue(roleSelect, 'custom');
            await settleLayout(3);

            // CodeEditor languageHint switches to JSON
            const langBadge = modal!.querySelector('.ag-code-lang');
            expect(langBadge?.textContent?.trim()).toBe('JSON');

            // Quick-insert toolbar buttons exist and meet >=40x40px touch target & overflow constraints
            const initTemplateBtn = findButtonByText(modal!, '插入初始工具上下文模板');
            const prefillTemplateBtn = findButtonByText(modal!, '插入 Assistant Prefill 模板');
            expect(initTemplateBtn).toBeTruthy();
            expect(prefillTemplateBtn).toBeTruthy();
            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:prompts:modal-custom`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:prompts:modal-custom`);

            const textarea = modal!.querySelector(
                'textarea.ag-code-textarea',
            ) as HTMLTextAreaElement;
            expect(textarea).toBeTruthy();

            // Verify keyboard propagation stop inside custom JSON textarea
            const docKeyDownSpy = vi.fn();
            document.addEventListener('keydown', docKeyDownSpy);
            try {
                textarea.focus();
                textarea.dispatchEvent(
                    new KeyboardEvent('keydown', {
                        key: 'ArrowLeft',
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                    }),
                );
                expect(docKeyDownSpy).not.toHaveBeenCalled();
            } finally {
                document.removeEventListener('keydown', docKeyDownSpy);
            }

            // Insert Template 1: initial tool context
            initTemplateBtn!.click();
            await settleLayout(3);
            const parsedInit = JSON.parse(textarea.value) as Array<{ role: string }>;
            expect(Array.isArray(parsedInit)).toBe(true);
            expect(parsedInit.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);

            // Insert Template 2: assistant prefill
            prefillTemplateBtn!.click();
            await settleLayout(3);
            const parsedPrefill = JSON.parse(textarea.value) as {
                role: string;
                partial?: boolean;
            };
            expect(parsedPrefill.role).toBe('assistant');
            expect(parsedPrefill.partial).toBe(true);

            // Invalid JSON must block saving and show inline red error
            const beforeCount =
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .promptBlocks.length;
            setInputValue(textarea, '{ invalid json');
            await settleLayout(3);

            const saveBtn = findButtonByText(modal!, '添加');
            expect(saveBtn).toBeTruthy();
            saveBtn!.click();
            await settleLayout(3);

            const errorBanner = modal!.querySelector('.ag-banner-error');
            expect(errorBanner, `${vp.label}: expected inline validation error`).toBeTruthy();
            expect(
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .promptBlocks.length,
            ).toBe(beforeCount);

            // Balanced outer EJS template shows non-blocking info hint and saves cleanly
            setInputValue(
                textarea,
                '<% if (true) { %>[{"role":"user","content":"hello"}]<% } %>',
            );
            await settleLayout(3);

            const ejsBanner = modal!.querySelector('.ag-banner-primary');
            expect(ejsBanner?.textContent).toContain(
                '检测到外层 EJS 控制流，将在上下文组装时求值后解析为 JSON 消息',
            );

            saveBtn!.click();
            await settleLayout(4);

            // Modal closed & block saved with role 'custom'
            expect(shadowRoot.querySelector('.ag-modal')).toBeNull();
            const blocksAfterEjs = resolveActivePreset(
                activeHarness.store.getSnapshot().settings,
            ).agents.main.promptBlocks;
            expect(blocksAfterEjs.length).toBe(beforeCount + 1);
            const savedEjsBlock = blocksAfterEjs[blocksAfterEjs.length - 1];
            expect(savedEjsBlock.role).toBe('custom');

            // List badge renders 'custom' cleanly
            const customBadges = Array.from(shadowRoot.querySelectorAll('.ag-badge')).filter(
                (el) => el.textContent?.trim() === 'custom',
            );
            expect(customBadges.length).toBeGreaterThanOrEqual(1);

            // Create a valid JSON custom block via template button and verify saving
            findButtonByText(shadowRoot, '添加')!.click();
            await settleLayout(3);
            const modal2 = shadowRoot.querySelector('.ag-modal') as HTMLElement;
            setInputValue(
                modal2.querySelector('input[placeholder*="身份定义"]') as HTMLInputElement,
                '标准工具示例',
            );
            setSelectValue(
                modal2.querySelector('select[aria-label="提示词消息角色"]') as HTMLSelectElement,
                'custom',
            );
            await settleLayout(2);
            findButtonByText(modal2, '插入初始工具上下文模板')!.click();
            await settleLayout(2);
            findButtonByText(modal2, '添加')!.click();
            await settleLayout(4);

            // Now add a trailing `system` block in `prefix` after `custom` -> non-blocking warning appears
            findButtonByText(shadowRoot, '添加')!.click();
            await settleLayout(3);
            const modal3 = shadowRoot.querySelector('.ag-modal') as HTMLElement;
            setInputValue(
                modal3.querySelector('input[placeholder*="身份定义"]') as HTMLInputElement,
                '后置系统指令',
            );
            setInputValue(
                modal3.querySelector('textarea.ag-code-textarea') as HTMLTextAreaElement,
                '后置系统提醒',
            );
            await settleLayout(3);
            // Non-blocking warning shown inside modal too
            expect(modal3.querySelector('.ag-banner-warning')?.textContent).toContain(
                'Gemini 与 Claude',
            );
            findButtonByText(modal3, '添加')!.click();
            await settleLayout(4);

            // Non-blocking ordering warning banner visible on the prompt list card
            const listWarning = shadowRoot.querySelector('.ag-banner-warning');
            expect(listWarning?.textContent).toContain('Gemini 与 Claude');
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:prompts:list-warning`);

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('updates strictToolLoop toggle and roundMaxRetries in ConnectionsView (desktop & mobile)', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = createHarness('connections');
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            // On mobile, push into the conn_claude detail view
            if (vp.label === 'mobile') {
                const targetItem = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find(
                    (el) => el.textContent?.includes('主力写作'),
                ) as HTMLButtonElement | undefined;
                expect(targetItem, `${vp.label}: expected 主力写作 list item`).toBeTruthy();
                targetItem!.click();
                await settleLayout(4);
            }

            // Default values from mock-services.ts match defaults.ts
            const initialConn =
                activeHarness.store.getSnapshot().settings.connections.conn_claude;
            expect(initialConn.strictToolLoop).toBe(false);
            expect(initialConn.roundMaxRetries).toBe(2);
            expect(initialConn.systemInstructionMode).toBe('native');

            const sysModeSelect = shadowRoot.querySelector(
                'select[aria-label="系统指令兼容模式"]',
            ) as HTMLSelectElement | null;
            expect(sysModeSelect, `${vp.label}: expected systemInstructionMode select`).toBeTruthy();
            expect(sysModeSelect!.value).toBe('native');

            const strictSwitch = shadowRoot.querySelector(
                'button[role="switch"][aria-label*="强约束工具闭环"]',
            ) as HTMLButtonElement | null;
            expect(strictSwitch, `${vp.label}: expected strictToolLoop switch`).toBeTruthy();
            expect(strictSwitch!.getAttribute('aria-checked')).toBe('false');

            const retriesInput = shadowRoot.querySelector(
                'input[aria-label="单拍自动重试次数"]',
            ) as HTMLInputElement | null;
            expect(retriesInput, `${vp.label}: expected roundMaxRetries input`).toBeTruthy();
            expect(retriesInput!.value).toBe('2');

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:connections`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:connections`);

            // Toggle strictToolLoop on
            strictSwitch!.click();
            await settleLayout(3);
            expect(
                activeHarness.store.getSnapshot().settings.connections.conn_claude.strictToolLoop,
            ).toBe(true);
            expect(strictSwitch!.getAttribute('aria-checked')).toBe('true');

            // Update roundMaxRetries to 0 (disable single-round auto-retry)
            setInputValue(retriesInput!, '0');
            await settleLayout(3);
            expect(
                activeHarness.store.getSnapshot().settings.connections.conn_claude.roundMaxRetries,
            ).toBe(0);

            // Clamps out-of-range value (> 10) to 10 on change
            setInputValue(retriesInput!, '15');
            await settleLayout(3);
            expect(
                activeHarness.store.getSnapshot().settings.connections.conn_claude.roundMaxRetries,
            ).toBe(10);

            // Update systemInstructionMode to 'user' and 'model'
            setSelectValue(sysModeSelect!, 'user');
            await settleLayout(3);
            expect(
                activeHarness.store.getSnapshot().settings.connections.conn_claude
                    .systemInstructionMode,
            ).toBe('user');

            setSelectValue(sysModeSelect!, 'model');
            await settleLayout(3);
            expect(
                activeHarness.store.getSnapshot().settings.connections.conn_claude
                    .systemInstructionMode,
            ).toBe('model');

            activeHarness.cleanup();
            activeHarness = null;
        }
    });

    it('updates 3-state strictToolLoop and custom PromptBlockCard validation/templates in AgentsView (desktop & mobile)', async () => {
        for (const vp of [
            { label: 'desktop', width: 1280, height: 800 },
            { label: 'mobile', width: 390, height: 844 },
        ]) {
            await page.viewport(vp.width, vp.height);
            activeHarness = createHarness('agents');
            await settleLayout(5);

            const { dialog, shadowRoot } = getShellElements();

            // On mobile, push into main agent detail view
            if (vp.label === 'mobile') {
                const mainItem = Array.from(shadowRoot.querySelectorAll('.ag-list-item')).find(
                    (el) => el.textContent?.includes('主叙事 Agent'),
                ) as HTMLButtonElement | undefined;
                expect(mainItem, `${vp.label}: expected 主叙事 Agent list item`).toBeTruthy();
                mainItem!.click();
                await settleLayout(4);
            }

            // 1. 3-state strictToolLoop SelectInput
            const strictSelect = shadowRoot.querySelector(
                'select[aria-label="强约束工具闭环"]',
            ) as HTMLSelectElement | null;
            expect(strictSelect, `${vp.label}: expected strictToolLoop SelectInput`).toBeTruthy();
            expect(strictSelect!.value).toBe('inherit');
            expect(Array.from(strictSelect!.options).map((o) => o.value)).toEqual([
                'inherit',
                'on',
                'off',
            ]);

            setSelectValue(strictSelect!, 'on');
            await settleLayout(3);
            expect(
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .strictToolLoop,
            ).toBe('on');

            setSelectValue(strictSelect!, 'off');
            await settleLayout(3);
            expect(
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .strictToolLoop,
            ).toBe('off');

            // 2. Switch first PromptBlockCard (prefix) to 'custom' -> triggers non-leading system warning
            const roleSelects = Array.from(
                shadowRoot.querySelectorAll('select[aria-label="积木角色"]'),
            ) as HTMLSelectElement[];
            expect(roleSelects.length).toBeGreaterThanOrEqual(2);
            setSelectValue(roleSelects[0], 'custom');
            await settleLayout(4);

            // Since block 1 is now 'custom' (prefix) and block 2 is 'system' (prefix), ordering hint appears
            const orderingWarning = Array.from(
                shadowRoot.querySelectorAll('.ag-banner-warning'),
            ).find((el) => el.textContent?.includes('Gemini 与 Claude'));
            expect(orderingWarning, `${vp.label}: expected prefix ordering hint`).toBeTruthy();

            // Original plain-text content is invalid JSON, so error banner shows and blocks invalid edits
            expect(shadowRoot.querySelector('.ag-banner-error')).toBeTruthy();

            // Click template button in PromptBlockCard -> populates valid JSON and persists to store
            const insertInitBtn = findButtonByText(shadowRoot, '插入初始工具上下文模板');
            expect(insertInitBtn).toBeTruthy();
            insertInitBtn!.click();
            await settleLayout(4);

            expect(shadowRoot.querySelector('.ag-banner-error')).toBeNull();
            const firstBlockAfterTemplate = resolveActivePreset(
                activeHarness.store.getSnapshot().settings,
            ).agents.main.promptBlocks[0];
            expect(firstBlockAfterTemplate.role).toBe('custom');
            expect(JSON.parse(firstBlockAfterTemplate.content)).toHaveLength(3);

            // Typing invalid JSON does NOT overwrite the valid stored content and shows red error
            const firstTextarea = shadowRoot.querySelector(
                'textarea.ag-code-textarea',
            ) as HTMLTextAreaElement;
            setInputValue(firstTextarea, '{"broken": ');
            await settleLayout(3);
            expect(shadowRoot.querySelector('.ag-banner-error')).toBeTruthy();
            expect(
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .promptBlocks[0].content,
            ).toBe(firstBlockAfterTemplate.content);

            // Typing balanced EJS template persists and displays non-blocking info hint
            const ejsTemplate = '<% if (true) { %>[{"role":"user","content":"ok"}]<% } %>';
            setInputValue(firstTextarea, ejsTemplate);
            await settleLayout(3);
            expect(shadowRoot.querySelector('.ag-banner-error')).toBeNull();
            expect(shadowRoot.querySelector('.ag-banner-primary')?.textContent).toContain(
                '检测到外层 EJS 控制流，将在上下文组装时求值后解析为 JSON 消息',
            );
            expect(
                resolveActivePreset(activeHarness.store.getSnapshot().settings).agents.main
                    .promptBlocks[0].content,
            ).toBe(ejsTemplate);

            assertTouchTargetsAndInputs(shadowRoot, `${vp.label}:agents:custom-block`);
            assertNoHorizontalOverflow(dialog, shadowRoot, `${vp.label}:agents:custom-block`);

            activeHarness.cleanup();
            activeHarness = null;
        }
    });
});
