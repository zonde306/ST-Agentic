import { render, type ComponentChild } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { CodeEditor } from '@/ui/components';
import { AGENTIC_SHELL_STYLES } from '@/ui/shell/styles';

function nextFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

let cleanup: (() => void) | null = null;

afterEach(() => {
    cleanup?.();
    cleanup = null;
});

function mount(node: ComponentChild): ShadowRoot {
    const host = document.createElement('div');
    host.style.width = '420px';
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = AGENTIC_SHELL_STYLES;
    root.appendChild(style);
    const container = document.createElement('div');
    root.appendChild(container);
    render(node, container);
    cleanup = () => {
        render(null, container);
        host.remove();
    };
    return root;
}

const LONG_JSON = `{\n  "description": "${'wrap me '.repeat(30)}",\n${Array.from({ length: 30 }, (_, i) => `  "k${i}": ${i},`).join('\n')}\n  "end": true\n}\n`;

describe('CodeEditor syntax highlight overlay', () => {
    it('renders an aligned, scroll-synced, aria-hidden token mirror for JSON', async () => {
        let latest = LONG_JSON;
        const root = mount(
            <CodeEditor value={LONG_JSON} onChange={(v) => { latest = v; }} languageHint="json" rows={8} minHeight="160px" />,
        );
        await nextFrame();

        const ta = root.querySelector('textarea.ag-code-textarea') as HTMLTextAreaElement;
        const pre = root.querySelector('pre.ag-code-highlight') as HTMLPreElement;
        expect(ta).toBeTruthy();
        expect(pre).toBeTruthy();
        expect(pre.getAttribute('aria-hidden')).toBe('true');
        expect(ta.classList.contains('ag-code-textarea-hl')).toBe(true);
        expect(getComputedStyle(ta).color).toBe('rgba(0, 0, 0, 0)');

        // Lossless mirror (+ trailing sentinel space) with real token spans.
        expect(pre.textContent).toBe(`${LONG_JSON} `);
        expect(pre.querySelectorAll('.ag-tok-property').length).toBeGreaterThan(5);
        expect(pre.querySelector('.ag-tok-constant')?.textContent).toBe('true');

        // Same padding box, same wrapped content height -> glyph alignment.
        expect(pre.clientWidth).toBe(ta.clientWidth);
        expect(pre.clientHeight).toBe(ta.clientHeight);
        expect(Math.abs(pre.scrollHeight - ta.scrollHeight)).toBeLessThanOrEqual(2);

        ta.scrollTop = 120;
        ta.dispatchEvent(new Event('scroll'));
        expect(pre.scrollTop).toBe(ta.scrollTop);

        // Typing updates the mirror immediately.
        ta.value = '{"typed": 1}';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        await nextFrame();
        expect(latest).toBe('{"typed": 1}');
        expect(pre.textContent).toBe('{"typed": 1} ');
        expect(pre.querySelector('.ag-tok-property')?.textContent).toBe('"typed"');
    });

    it('keeps the overlay in sync during IME composition before onChange fires', async () => {
        let changes = 0;
        const root = mount(<CodeEditor value="" onChange={() => { changes += 1; }} languageHint="markdown" />);
        await nextFrame();
        const ta = root.querySelector('textarea') as HTMLTextAreaElement;
        ta.dispatchEvent(new CompositionEvent('compositionstart'));
        ta.value = '# 你好';
        ta.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        await nextFrame();
        const pre = root.querySelector('pre.ag-code-highlight') as HTMLPreElement;
        expect(changes).toBe(0);
        expect(pre.querySelector('.ag-tok-heading')?.textContent).toBe('# 你好');
    });

    it('falls back to a plain textarea for non-highlighted languages or when disabled', async () => {
        const root = mount(
            <div>
                <CodeEditor value="a: 1" onChange={() => undefined} languageHint="yaml" />
                <CodeEditor value="{}" onChange={() => undefined} languageHint="json" highlight={false} />
            </div>,
        );
        await nextFrame();
        expect(root.querySelector('pre.ag-code-highlight')).toBeNull();
        expect(root.querySelectorAll('textarea.ag-code-textarea-hl').length).toBe(0);
    });
});
