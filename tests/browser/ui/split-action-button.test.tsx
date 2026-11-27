import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import {
    IconPlay,
    IconRefresh,
    IconUndo,
    SplitActionButton,
    type SplitActionButtonProps,
} from '@/ui/components';
import { AGENTIC_SHELL_STYLES } from '@/ui/shell/styles';

interface ShadowFixture {
    host: HTMLDivElement;
    shadowRoot: ShadowRoot;
    mount: HTMLDivElement;
    insideSibling: HTMLButtonElement;
    outsideButton: HTMLButtonElement;
    cleanup: () => void;
}

function nextAnimationFrame(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => resolve());
    });
}

async function settle(frames = 3): Promise<void> {
    for (let i = 0; i < frames; i += 1) {
        await nextAnimationFrame();
    }
}

function createShadowFixture(theme: 'dark' | 'light' = 'dark'): ShadowFixture {
    const outsideButton = document.createElement('button');
    outsideButton.type = 'button';
    outsideButton.textContent = 'Light DOM Outside';
    document.body.appendChild(outsideButton);

    const host = document.createElement('div');
    host.setAttribute('data-theme', theme);
    host.style.width = '100%';
    host.style.height = '100vh';
    document.body.appendChild(host);

    const shadowRoot = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = AGENTIC_SHELL_STYLES;
    shadowRoot.appendChild(styleEl);

    const mount = document.createElement('div');
    mount.setAttribute('data-agentic-mount', 'true');
    mount.style.padding = '12px';
    shadowRoot.appendChild(mount);

    const insideSibling = document.createElement('button');
    insideSibling.type = 'button';
    insideSibling.textContent = 'Shadow Sibling';
    shadowRoot.appendChild(insideSibling);

    return {
        host,
        shadowRoot,
        mount,
        insideSibling,
        outsideButton,
        cleanup: () => {
            render(null, mount);
            host.remove();
            outsideButton.remove();
        },
    };
}

describe('SplitActionButton', () => {
    let fixture: ShadowFixture | null = null;

    beforeEach(async () => {
        await page.viewport(1280, 800);
    });

    afterEach(async () => {
        fixture?.cleanup();
        fixture = null;
        await page.viewport(1280, 800);
    });

    it('invokes main action on click without opening menu and supports disabled/loading states', async () => {
        fixture = createShadowFixture('dark');
        const onMain = vi.fn();
        const onRollback = vi.fn();
        const onRetry = vi.fn();

        const baseProps: SplitActionButtonProps = {
            label: '继续',
            icon: <IconPlay size={14} />,
            variant: 'primary',
            size: 'sm',
            title: '继续当前生成',
            ariaLabel: '继续生成',
            onClick: onMain,
            menuItems: [
                {
                    id: 'rollback_retry',
                    label: '回退并重试',
                    description: '撤销上一轮工具调用后重新生成',
                    icon: <IconUndo size={14} />,
                    onClick: onRollback,
                },
                {
                    id: 'retry',
                    label: '重试',
                    icon: <IconRefresh size={14} />,
                    tone: 'danger',
                    onClick: onRetry,
                },
            ],
        };

        render(<SplitActionButton {...baseProps} />, fixture.mount);
        await settle();

        const mainBtn = fixture.shadowRoot.querySelector('.ag-split-btn-main') as HTMLButtonElement;
        const caretBtn = fixture.shadowRoot.querySelector('.ag-split-btn-caret') as HTMLButtonElement;
        expect(mainBtn).toBeTruthy();
        expect(caretBtn).toBeTruthy();
        expect(caretBtn.getAttribute('aria-expanded')).toBe('false');
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        mainBtn.click();
        await settle();

        expect(onMain).toHaveBeenCalledTimes(1);
        expect(onRollback).not.toHaveBeenCalled();
        expect(onRetry).not.toHaveBeenCalled();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // Disabled state blocks both main and caret buttons
        render(<SplitActionButton {...baseProps} disabled />, fixture.mount);
        await settle();
        expect(mainBtn.disabled).toBe(true);
        expect(caretBtn.disabled).toBe(true);
        mainBtn.click();
        caretBtn.click();
        await settle();
        expect(onMain).toHaveBeenCalledTimes(1);
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // Loading state sets aria-busy and disables interaction
        render(<SplitActionButton {...baseProps} loading />, fixture.mount);
        await settle();
        expect(mainBtn.getAttribute('aria-busy')).toBe('true');
        expect(mainBtn.disabled).toBe(true);
        expect(caretBtn.disabled).toBe(true);
    });

    it('toggles dropdown menu, handles enabled/disabled menu items, and closes on selection', async () => {
        fixture = createShadowFixture('dark');
        const onMain = vi.fn();
        const onRollback = vi.fn();
        const onDisabledItem = vi.fn();

        render(
            <SplitActionButton
                label="继续"
                variant="secondary"
                onClick={onMain}
                menuItems={[
                    {
                        id: 'rollback_retry',
                        label: '回退并重试',
                        description: '回退到上一轮检查点',
                        icon: <IconUndo size={14} />,
                        onClick: onRollback,
                    },
                    {
                        id: 'disabled_action',
                        label: '无可用快照',
                        tone: 'danger',
                        disabled: true,
                        title: '当前没有可回退的工具轮次',
                        onClick: onDisabledItem,
                    },
                ]}
            />,
            fixture.mount,
        );
        await settle();

        const caretBtn = fixture.shadowRoot.querySelector('.ag-split-btn-caret') as HTMLButtonElement;
        const mainBtn = fixture.shadowRoot.querySelector('.ag-split-btn-main') as HTMLButtonElement;

        // Open menu
        caretBtn.click();
        await settle();
        expect(caretBtn.getAttribute('aria-expanded')).toBe('true');
        const menu = fixture.shadowRoot.querySelector('.ag-split-menu') as HTMLDivElement | null;
        expect(menu).toBeTruthy();
        expect(menu?.getAttribute('role')).toBe('menu');

        // Disabled item does not fire callback and keeps menu open
        const disabledBtn = fixture.shadowRoot.querySelector(
            '[data-menu-item-id="disabled_action"]',
        ) as HTMLButtonElement;
        expect(disabledBtn).toBeTruthy();
        expect(disabledBtn.disabled).toBe(true);
        expect(disabledBtn.classList.contains('ag-split-menu-item-danger')).toBe(true);
        expect(disabledBtn.title).toBe('当前没有可回退的工具轮次');
        disabledBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
        disabledBtn.click();
        await settle();
        expect(onDisabledItem).not.toHaveBeenCalled();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();

        // Clicking an enabled item fires its callback and automatically closes the menu
        const rollbackBtn = fixture.shadowRoot.querySelector(
            '[data-menu-item-id="rollback_retry"]',
        ) as HTMLButtonElement;
        expect(rollbackBtn.textContent).toContain('回退并重试');
        expect(rollbackBtn.textContent).toContain('回退到上一轮检查点');
        rollbackBtn.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
        rollbackBtn.click();
        await settle();

        expect(onRollback).toHaveBeenCalledTimes(1);
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();
        expect(caretBtn.getAttribute('aria-expanded')).toBe('false');

        // Clicking caret twice toggles open -> closed
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // Clicking main button while open closes menu and triggers main action
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();
        mainBtn.click();
        await settle();
        expect(onMain).toHaveBeenCalledTimes(1);
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();
    });

    it('closes on Escape key and stops propagation so outer dialogs are not dismissed', async () => {
        fixture = createShadowFixture('light');
        const outerEscapeSpy = vi.fn();
        document.addEventListener('keydown', outerEscapeSpy);

        try {
            render(
                <SplitActionButton
                    label="继续"
                    onClick={() => {}}
                    menuItems={[
                        { id: 'retry', label: '重试', onClick: () => {} },
                    ]}
                />,
                fixture.mount,
            );
            await settle();

            const caretBtn = fixture.shadowRoot.querySelector(
                '.ag-split-btn-caret',
            ) as HTMLButtonElement;
            caretBtn.focus();
            caretBtn.click();
            await settle();
            expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();

            const firstItem = fixture.shadowRoot.querySelector(
                '.ag-split-menu-item',
            ) as HTMLButtonElement;
            firstItem.focus();

            firstItem.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                }),
            );
            await settle();

            expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();
            expect(caretBtn.getAttribute('aria-expanded')).toBe('false');
            expect(outerEscapeSpy).not.toHaveBeenCalled();
            expect(fixture.shadowRoot.activeElement).toBe(caretBtn);
        } finally {
            document.removeEventListener('keydown', outerEscapeSpy);
        }
    });

    it('closes on outside clicks inside Shadow Root and in Light DOM, without falsely closing on inside clicks', async () => {
        fixture = createShadowFixture('dark');
        const onItem = vi.fn();

        render(
            <SplitActionButton
                label="继续"
                onClick={() => {}}
                menuItems={[
                    { id: 'retry', label: '重试', onClick: onItem },
                ]}
            />,
            fixture.mount,
        );
        await settle();

        const caretBtn = fixture.shadowRoot.querySelector('.ag-split-btn-caret') as HTMLButtonElement;

        // 1. Inside-menu container pointerdown should NOT close the menu before item click runs
        caretBtn.click();
        await settle();
        const menu = fixture.shadowRoot.querySelector('.ag-split-menu') as HTMLDivElement;
        expect(menu).toBeTruthy();
        menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();

        // 2. Clicking a sibling inside the SAME Shadow Root closes the menu
        fixture.insideSibling.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, composed: true }),
        );
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // 3. Non-composed click inside Shadow Root also closes the menu
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();
        fixture.insideSibling.dispatchEvent(
            new MouseEvent('click', { bubbles: true, composed: false }),
        );
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // 4. Clicking outside the Shadow Root in Light DOM (document.body) closes the menu
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();
        fixture.outsideButton.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, composed: true }),
        );
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();

        // 5. Synthetic Light DOM `.click()` (without pointerdown) also closes the menu
        caretBtn.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeTruthy();
        fixture.outsideButton.click();
        await settle();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();
    });

    it('enforces >= 40x40 touch targets and prevents viewport overflow on mobile (390x844), even inside overflow-hidden cards', async () => {
        await page.viewport(390, 844);
        fixture = createShadowFixture('dark');

        // Place right-aligned menu near left edge inside an `.ag-card` (which has overflow: hidden)
        render(
            <div class="ag-card">
                <div class="ag-card-header">
                    <SplitActionButton
                        label="继续"
                        variant="primary"
                        size="sm"
                        menuAlign="right"
                        onClick={() => {}}
                        menuItems={[
                            {
                                id: 'rollback_retry',
                                label: '回退上一轮并重试',
                                description: '回退上一轮工具调用后重新尝试生成',
                                onClick: () => {},
                            },
                            {
                                id: 'retry',
                                label: '完全重试',
                                tone: 'danger',
                                onClick: () => {},
                            },
                        ]}
                    />
                </div>
            </div>,
            fixture.mount,
        );
        await settle(4);

        const mainBtn = fixture.shadowRoot.querySelector('.ag-split-btn-main') as HTMLButtonElement;
        const caretBtn = fixture.shadowRoot.querySelector('.ag-split-btn-caret') as HTMLButtonElement;

        const mainRect = mainBtn.getBoundingClientRect();
        const caretRect = caretBtn.getBoundingClientRect();
        expect(mainRect.width).toBeGreaterThanOrEqual(40);
        expect(mainRect.height).toBeGreaterThanOrEqual(40);
        expect(caretRect.width).toBeGreaterThanOrEqual(40);
        expect(caretRect.height).toBeGreaterThanOrEqual(40);

        caretBtn.click();
        await settle(4);

        const menu = fixture.shadowRoot.querySelector('.ag-split-menu') as HTMLDivElement;
        expect(menu).toBeTruthy();
        const menuRect = menu.getBoundingClientRect();
        expect(menuRect.left).toBeGreaterThanOrEqual(0);
        expect(menuRect.right).toBeLessThanOrEqual(390);
        expect(menuRect.top).toBeGreaterThanOrEqual(0);
        expect(menuRect.bottom).toBeLessThanOrEqual(844);

        const items = Array.from(
            fixture.shadowRoot.querySelectorAll('.ag-split-menu-item'),
        ) as HTMLButtonElement[];
        expect(items.length).toBe(2);
        for (const item of items) {
            const rect = item.getBoundingClientRect();
            expect(rect.height).toBeGreaterThanOrEqual(40);
            expect(rect.width).toBeGreaterThanOrEqual(40);
        }
    });

    it('renders cleanly as a single button when menuItems is empty', async () => {
        fixture = createShadowFixture('dark');
        const onMain = vi.fn();

        render(
            <SplitActionButton
                label="继续"
                variant="ghost"
                onClick={onMain}
                menuItems={[]}
            />,
            fixture.mount,
        );
        await settle();

        expect(fixture.shadowRoot.querySelector('.ag-split-btn-main')).toBeTruthy();
        expect(fixture.shadowRoot.querySelector('.ag-split-btn-caret')).toBeNull();
        expect(fixture.shadowRoot.querySelector('.ag-split-menu')).toBeNull();
        (fixture.shadowRoot.querySelector('.ag-split-btn-main') as HTMLButtonElement).click();
        expect(onMain).toHaveBeenCalledTimes(1);
    });
});
