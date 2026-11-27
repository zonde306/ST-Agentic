import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { DiffViewer, type DiffViewerLine } from '@/ui/components';
import { AGENTIC_SHELL_STYLES } from '@/ui/shell/styles';

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

function mountInShadow(): { root: ShadowRoot; mount: HTMLDivElement; cleanup: () => void } {
    const host = document.createElement('div');
    host.setAttribute('data-theme', 'dark');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const styleEl = document.createElement('style');
    styleEl.textContent = AGENTIC_SHELL_STYLES;
    root.appendChild(styleEl);
    const mount = document.createElement('div');
    root.appendChild(mount);
    return {
        root,
        mount,
        cleanup: () => {
            render(null, mount);
            host.remove();
        },
    };
}

function buildLines(): DiffViewerLine[] {
    const lines: DiffViewerLine[] = [];
    for (let i = 1; i <= 40; i += 1) {
        lines.push({ type: 'ctx', text: `head-${i}` });
    }
    lines.push({ type: 'del', text: 'before-value' });
    lines.push({ type: 'add', text: 'after-value' });
    for (let i = 1; i <= 60; i += 1) {
        lines.push({ type: 'ctx', text: `mid-${i}` });
    }
    lines.push({ type: 'add', text: 'second-change' });
    for (let i = 1; i <= 10; i += 1) {
        lines.push({ type: 'ctx', text: `tail-${i}` });
    }
    return lines;
}

describe('DiffViewer (GitHub-style collapsible diff)', () => {
    let cleanup: (() => void) | null = null;

    afterEach(async () => {
        cleanup?.();
        cleanup = null;
        await page.viewport(1280, 800);
    });

    it('collapses unchanged regions, expands incrementally and toggles full view', async () => {
        const fixture = mountInShadow();
        cleanup = fixture.cleanup;
        render(<DiffViewer lines={buildLines()} />, fixture.mount);
        await settle();

        const root = fixture.root;
        const rowCount = () => root.querySelectorAll('[data-diff-line]').length;
        const gaps = () => Array.from(root.querySelectorAll<HTMLElement>('[data-diff-gap]'));

        // 2 changes with 3 context lines on each side => 3+2+3 + 3+1+3 = 15 rows.
        expect(rowCount()).toBe(15);
        expect(gaps().map((g) => g.getAttribute('data-diff-gap-position'))).toEqual([
            'top',
            'middle',
            'bottom',
        ]);
        expect(root.textContent).toContain('before-value');
        expect(root.textContent).toContain('second-change');
        expect(root.textContent).toContain('head-38');
        expect(root.textContent).not.toContain('head-37');
        expect(root.textContent).toContain('+2');
        expect(root.textContent).toContain('2 处更改');

        // Middle gap (54 hidden) offers both expand directions; expand down by 20.
        const middle = gaps()[1];
        expect(middle.getAttribute('data-diff-gap')).toBe('54');
        (middle.querySelector('[data-diff-expand="down"]') as HTMLButtonElement).click();
        await settle();
        expect(rowCount()).toBe(35);
        expect(gaps()[1].getAttribute('data-diff-gap')).toBe('34');

        // Clicking the gap label reveals the remaining hidden lines of that gap.
        (gaps()[1].querySelector('.ag-diffv-gap-label') as HTMLButtonElement).click();
        await settle();
        expect(rowCount()).toBe(69);
        expect(gaps().map((g) => g.getAttribute('data-diff-gap-position'))).toEqual([
            'top',
            'bottom',
        ]);

        // Toolbar toggle shows the full file, then folds back to changes only.
        const toggle = root.querySelector('[data-diff-toggle-all="true"]') as HTMLButtonElement;
        toggle.click();
        await settle();
        expect(rowCount()).toBe(113);
        expect(gaps()).toHaveLength(0);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');

        toggle.click();
        await settle();
        expect(rowCount()).toBe(15);
    });

    it('renders the empty state when no lines changed', async () => {
        const fixture = mountInShadow();
        cleanup = fixture.cleanup;
        render(
            <DiffViewer
                lines={[{ type: 'ctx', text: 'same' }]}
                emptyText={<div data-test-empty="true">no diff</div>}
            />,
            fixture.mount,
        );
        await settle();
        expect(fixture.root.querySelector('[data-test-empty="true"]')).toBeTruthy();
        expect(fixture.root.querySelector('[data-diff-toggle-all="true"]')).toBeNull();
    });
});
