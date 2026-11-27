import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type ExtensionsMenuActionId,
    buildExtensionsMenuItems,
    mountExtensionsMenuItems,
} from '@/ui/capsule/HostEntryWidgets';
import type { AppStore } from '@/ui/store';

interface FakeElement {
    tagName: string;
    id: string;
    className: string;
    tabIndex: number;
    title: string;
    textContent: string;
    attributes: Map<string, string>;
    children: FakeElement[];
    parent: FakeElement | null;
    listeners: Map<string, Array<(event: Record<string, unknown>) => void>>;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    append(...nodes: FakeElement[]): void;
    appendChild(node: FakeElement): FakeElement;
    remove(): void;
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void;
    dispatch(type: string, event?: Record<string, unknown>): void;
    querySelectorAll(selector: string): FakeElement[];
}

function createFakeElement(tagName: string): FakeElement {
    const el: FakeElement = {
        tagName: tagName.toUpperCase(),
        id: '',
        className: '',
        tabIndex: -1,
        title: '',
        textContent: '',
        attributes: new Map(),
        children: [],
        parent: null,
        listeners: new Map(),
        setAttribute(name: string, value: string) {
            this.attributes.set(name, value);
        },
        getAttribute(name: string) {
            return this.attributes.get(name) ?? null;
        },
        append(...nodes: FakeElement[]) {
            for (const node of nodes) {
                this.appendChild(node);
            }
        },
        appendChild(node: FakeElement) {
            if (node.parent) {
                node.remove();
            }
            node.parent = this;
            this.children.push(node);
            return node;
        },
        remove() {
            if (!this.parent) {
                return;
            }
            const idx = this.parent.children.indexOf(this);
            if (idx >= 0) {
                this.parent.children.splice(idx, 1);
            }
            this.parent = null;
        },
        addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
            const list = this.listeners.get(type) ?? [];
            list.push(listener);
            this.listeners.set(type, list);
        },
        dispatch(type: string, event: Record<string, unknown> = {}) {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        },
        querySelectorAll(selector: string) {
            const matches: FakeElement[] = [];
            const visit = (node: FakeElement) => {
                for (const child of node.children) {
                    if (
                        selector === '[data-agentic-menu-item]'
                        && child.attributes.has('data-agentic-menu-item')
                    ) {
                        matches.push(child);
                    }
                    visit(child);
                }
            };
            visit(this);
            return matches;
        },
    };
    return el;
}

describe('HostEntryWidgets wand menu (#extensionsMenu)', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = {
            createElement: (tag: string) => createFakeElement(tag),
        };
    });

    afterEach(() => {
        if (originalDocument === undefined) {
            delete (globalThis as { document?: unknown }).document;
        } else {
            (globalThis as { document?: unknown }).document = originalDocument;
        }
    });

    it('builds only assistant and rerun_after_turn items and omits sidegen, files, and logs', () => {
        const openConsole = vi.fn();
        const rerunAfterTurn = vi.fn(async () => undefined);
        const pushToast = vi.fn();
        const store = {
            getSnapshot: () => ({
                activeTarget: { messageId: 5, swipeId: 2 },
            }),
            openConsole,
            rerunAfterTurn,
            pushToast,
        } as unknown as AppStore;

        const actions: ExtensionsMenuActionId[] = [];
        const items = buildExtensionsMenuItems(store, {
            onAction: (action) => actions.push(action),
        }) as unknown as FakeElement[];

        expect(items).toHaveLength(2);
        expect(items.map((item) => item.id)).toEqual([
            'agentic_menu_assistant',
            'agentic_menu_rerun_after',
        ]);
        expect(items.map((item) => item.getAttribute('data-agentic-menu-item'))).toEqual([
            'assistant',
            'rerun_after_turn',
        ]);
        expect(items.map((item) => item.children[1]?.textContent)).toEqual([
            '打开 Agentic 助手',
            '重新运行后置触发',
        ]);

        // Removed entries must not exist
        expect(items.some((item) => item.id === 'agentic_menu_sidegen')).toBe(false);
        expect(items.some((item) => item.id === 'agentic_menu_files')).toBe(false);
        expect(items.some((item) => item.id === 'agentic_menu_logs')).toBe(false);

        // Clicking assistant opens console on 'assistant' with active target
        items[0].dispatch('click');
        expect(openConsole).toHaveBeenCalledWith('assistant', { messageId: 5, swipeId: 2 });

        // Pressing Enter on rerun_after_turn triggers rerunAfterTurn
        const preventDefault = vi.fn();
        items[1].dispatch('keydown', { key: 'Enter', preventDefault });
        expect(preventDefault).toHaveBeenCalledTimes(1);
        expect(rerunAfterTurn).toHaveBeenCalledWith(undefined);
        expect(actions).toEqual(['assistant', 'rerun_after_turn']);
    });

    it('mounts idempotently into #extensionsMenu container and removes entries on cleanup', () => {
        const store = {
            getSnapshot: () => ({
                activeTarget: { messageId: 1, swipeId: 0 },
            }),
            openConsole: vi.fn(),
            rerunAfterTurn: vi.fn(async () => undefined),
            pushToast: vi.fn(),
        } as unknown as AppStore;

        const container = createFakeElement('div');
        const firstUnmount = mountExtensionsMenuItems(container as unknown as HTMLElement, store);
        expect(container.children).toHaveLength(2);

        // Remounting replaces existing items instead of duplicating them
        const secondUnmount = mountExtensionsMenuItems(container as unknown as HTMLElement, store);
        expect(container.children).toHaveLength(2);
        expect(container.children.map((c) => c.id)).toEqual([
            'agentic_menu_assistant',
            'agentic_menu_rerun_after',
        ]);

        firstUnmount();
        expect(container.children).toHaveLength(2);

        secondUnmount();
        expect(container.children).toHaveLength(0);
    });
});
