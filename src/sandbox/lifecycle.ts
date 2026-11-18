export type SandboxKind = 'schema' | 'tool' | 'script';

export interface EventTargetLike {
    addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void;
}

interface TrackedListenerRecord {
    target: EventTargetLike;
    type: string;
    listener: EventListenerOrEventListenerObject;
    capture: boolean;
    options?: boolean | AddEventListenerOptions;
}

interface ManagedSandboxRecord {
    id: string;
    kind: SandboxKind;
    iframe: HTMLIFrameElement | null;
    timeouts: Set<ReturnType<typeof setTimeout>>;
    intervals: Set<ReturnType<typeof setInterval>>;
    listeners: TrackedListenerRecord[];
    abortControllers: Set<AbortController>;
    disposers: Array<() => void>;
    disposed: boolean;
    createdAt: number;
}

export interface SandboxStats {
    activeSandboxes: number;
    timeouts: number;
    intervals: number;
    listeners: number;
    iframes: number;
}

export interface ScopedTimerBindings {
    setTimeout: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => number;
    clearTimeout: (id?: number) => void;
    setInterval: (handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => number;
    clearInterval: (id?: number) => void;
}

function extractCaptureFlag(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
    if (typeof options === 'boolean') {
        return options;
    }
    return Boolean(options?.capture);
}

/** Handle representing a single registered sandbox instance inside `SandboxLifecycleManager`. */
export class ManagedSandboxHandle {
    constructor(
        private readonly manager: SandboxLifecycleManager,
        private readonly record: ManagedSandboxRecord,
    ) {}

    get id(): string {
        return this.record.id;
    }

    get kind(): SandboxKind {
        return this.record.kind;
    }

    get iframe(): HTMLIFrameElement | null {
        return this.record.iframe;
    }

    isDisposed(): boolean {
        return this.record.disposed;
    }

    setIframe(iframe: HTMLIFrameElement | null): void {
        if (this.record.disposed) {
            if (iframe?.parentNode) {
                iframe.parentNode.removeChild(iframe);
            }
            return;
        }
        this.record.iframe = iframe;
    }

    trackAbortController(controller: AbortController): AbortController {
        if (this.record.disposed) {
            if (!controller.signal.aborted) {
                controller.abort(new Error(`Sandbox "${this.record.id}" is already disposed`));
            }
            return controller;
        }
        this.record.abortControllers.add(controller);
        return controller;
    }

    untrackAbortController(controller: AbortController): void {
        this.record.abortControllers.delete(controller);
    }

    addDisposer(fn: () => void): void {
        if (this.record.disposed) {
            try {
                fn();
            } catch {
                // Ignore cleanup failure on already-disposed handle
            }
            return;
        }
        this.record.disposers.push(fn);
    }

    createTimerBindings(): ScopedTimerBindings {
        const record = this.record;
        const hostSetTimeout = globalThis.setTimeout.bind(globalThis);
        const hostClearTimeout = globalThis.clearTimeout.bind(globalThis);
        const hostSetInterval = globalThis.setInterval.bind(globalThis);
        const hostClearInterval = globalThis.clearInterval.bind(globalThis);

        const wrappedSetTimeout = (
            handler: (...args: unknown[]) => void,
            timeout?: number,
            ...args: unknown[]
        ): number => {
            if (record.disposed || typeof handler !== 'function') {
                return 0;
            }
            const timerId = hostSetTimeout(() => {
                record.timeouts.delete(timerId);
                if (!record.disposed) {
                    handler(...args);
                }
            }, timeout);
            record.timeouts.add(timerId);
            return timerId as unknown as number;
        };

        const wrappedClearTimeout = (id?: number): void => {
            if (id === undefined || id === null) {
                return;
            }
            const handle = id as unknown as ReturnType<typeof setTimeout>;
            record.timeouts.delete(handle);
            hostClearTimeout(handle);
        };

        const wrappedSetInterval = (
            handler: (...args: unknown[]) => void,
            timeout?: number,
            ...args: unknown[]
        ): number => {
            if (record.disposed || typeof handler !== 'function') {
                return 0;
            }
            const intervalId = hostSetInterval(() => {
                if (record.disposed) {
                    record.intervals.delete(intervalId);
                    hostClearInterval(intervalId);
                    return;
                }
                handler(...args);
            }, timeout);
            record.intervals.add(intervalId);
            return intervalId as unknown as number;
        };

        const wrappedClearInterval = (id?: number): void => {
            if (id === undefined || id === null) {
                return;
            }
            const handle = id as unknown as ReturnType<typeof setInterval>;
            record.intervals.delete(handle);
            hostClearInterval(handle);
        };

        return {
            setTimeout: wrappedSetTimeout,
            clearTimeout: wrappedClearTimeout,
            setInterval: wrappedSetInterval,
            clearInterval: wrappedClearInterval,
        };
    }

    trackListener(
        target: EventTargetLike,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
    ): void {
        if (this.record.disposed || !listener) {
            return;
        }
        const capture = extractCaptureFlag(options);
        const exists = this.record.listeners.some(
            (entry) =>
                entry.target === target
                && entry.type === type
                && entry.listener === listener
                && entry.capture === capture,
        );
        if (!exists) {
            this.record.listeners.push({ target, type, listener, capture, options });
        }
        target.addEventListener(type, listener, options);
    }

    untrackListener(
        target: EventTargetLike,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
    ): void {
        if (!listener) {
            return;
        }
        const capture = extractCaptureFlag(options);
        const idx = this.record.listeners.findIndex(
            (entry) =>
                entry.target === target
                && entry.type === type
                && entry.listener === listener
                && entry.capture === capture,
        );
        if (idx >= 0) {
            this.record.listeners.splice(idx, 1);
        }
        target.removeEventListener(type, listener, options);
    }

    /** Instrument an iframe `Window` (and its `document`) so timers and listeners are tracked. */
    instrumentRealmWindow(win: Window): ScopedTimerBindings {
        const timers = this.createTimerBindings();
        const defineFn = (target: object, key: string, value: unknown) => {
            try {
                Object.defineProperty(target, key, {
                    value,
                    writable: true,
                    configurable: true,
                });
            } catch {
                try {
                    (target as Record<string, unknown>)[key] = value;
                } catch {
                    // Ignore non-writable properties
                }
            }
        };

        defineFn(win, 'setTimeout', timers.setTimeout);
        defineFn(win, 'clearTimeout', timers.clearTimeout);
        defineFn(win, 'setInterval', timers.setInterval);
        defineFn(win, 'clearInterval', timers.clearInterval);

        const wrapEventTarget = (eventTarget: EventTargetLike | null | undefined) => {
            if (!eventTarget || typeof eventTarget.addEventListener !== 'function') {
                return;
            }
            const rawAdd = eventTarget.addEventListener.bind(eventTarget);
            const rawRemove = eventTarget.removeEventListener.bind(eventTarget);
            const rawAdapter: EventTargetLike = {
                addEventListener: (type, listener, opts) => rawAdd(type, listener, opts),
                removeEventListener: (type, listener, opts) => rawRemove(type, listener, opts),
            };

            defineFn(
                eventTarget,
                'addEventListener',
                (
                    type: string,
                    listener: EventListenerOrEventListenerObject | null,
                    options?: boolean | AddEventListenerOptions,
                ) => {
                    this.trackListener(rawAdapter, type, listener, options);
                },
            );
            defineFn(
                eventTarget,
                'removeEventListener',
                (
                    type: string,
                    listener: EventListenerOrEventListenerObject | null,
                    options?: boolean | EventListenerOptions,
                ) => {
                    this.untrackListener(rawAdapter, type, listener, options);
                },
            );
        };

        wrapEventTarget(win as unknown as EventTargetLike);
        try {
            if (win.document) {
                wrapEventTarget(win.document as unknown as EventTargetLike);
            }
        } catch {
            // Ignore inaccessible document
        }

        return timers;
    }

    dispose(): boolean {
        return this.manager.dispose(this.record.id);
    }
}

/**
 * Centralized lifecycle tracker for all sandbox instances, timers (`setTimeout`/`setInterval`),
 * DOM/window event listeners, `AbortController`s, and `<iframe>` elements.
 * Prevents background polling and memory leaks across chat switches and hot-reloads.
 */
export class SandboxLifecycleManager {
    private readonly records = new Map<string, ManagedSandboxRecord>();

    /**
     * Register a sandbox instance under `id`. If an active sandbox with the same `id`
     * already exists (e.g. script hot-reload), it is cleanly disposed before creating the new handle.
     */
    register(
        id: string,
        kind: SandboxKind,
        iframe: HTMLIFrameElement | null = null,
    ): ManagedSandboxHandle {
        const cleanId = id.trim() || `sandbox_${Date.now()}`;
        if (this.records.has(cleanId)) {
            this.dispose(cleanId);
        }

        const record: ManagedSandboxRecord = {
            id: cleanId,
            kind,
            iframe,
            timeouts: new Set(),
            intervals: new Set(),
            listeners: [],
            abortControllers: new Set(),
            disposers: [],
            disposed: false,
            createdAt: Date.now(),
        };
        this.records.set(cleanId, record);
        return new ManagedSandboxHandle(this, record);
    }

    has(id: string): boolean {
        const rec = this.records.get(id);
        return Boolean(rec && !rec.disposed);
    }

    isDisposed(id: string): boolean {
        const rec = this.records.get(id);
        return !rec || rec.disposed;
    }

    getActiveIds(): string[] {
        return Array.from(this.records.keys());
    }

    getStats(id?: string): SandboxStats {
        if (id !== undefined) {
            const rec = this.records.get(id);
            if (!rec || rec.disposed) {
                return { activeSandboxes: 0, timeouts: 0, intervals: 0, listeners: 0, iframes: 0 };
            }
            return {
                activeSandboxes: 1,
                timeouts: rec.timeouts.size,
                intervals: rec.intervals.size,
                listeners: rec.listeners.length,
                iframes: rec.iframe ? 1 : 0,
            };
        }

        let timeouts = 0;
        let intervals = 0;
        let listeners = 0;
        let iframes = 0;
        for (const rec of this.records.values()) {
            timeouts += rec.timeouts.size;
            intervals += rec.intervals.size;
            listeners += rec.listeners.length;
            if (rec.iframe) {
                iframes += 1;
            }
        }
        return {
            activeSandboxes: this.records.size,
            timeouts,
            intervals,
            listeners,
            iframes,
        };
    }

    /** Dispose a single sandbox by `id`, clearing all timers, listeners, controllers, and iframe DOM. */
    dispose(id: string): boolean {
        const record = this.records.get(id);
        if (!record) {
            return false;
        }
        this.records.delete(id);
        this.teardownRecord(record);
        return true;
    }

    /** Dispose all active sandboxes (used on chat switch, preset reload, or shutdown). */
    disposeAll(): number {
        const entries = Array.from(this.records.values());
        this.records.clear();
        for (const record of entries) {
            this.teardownRecord(record);
        }
        return entries.length;
    }

    private teardownRecord(record: ManagedSandboxRecord): void {
        record.disposed = true;

        for (const controller of record.abortControllers) {
            try {
                if (!controller.signal.aborted) {
                    const err = new Error(`Sandbox "${record.id}" disposed`);
                    err.name = 'AbortError';
                    controller.abort(err);
                }
            } catch {
                // Ignore abort failure
            }
        }
        record.abortControllers.clear();

        for (const timerId of record.timeouts) {
            globalThis.clearTimeout(timerId);
        }
        record.timeouts.clear();

        for (const intervalId of record.intervals) {
            globalThis.clearInterval(intervalId);
        }
        record.intervals.clear();

        for (const entry of record.listeners) {
            try {
                entry.target.removeEventListener(entry.type, entry.listener, entry.options);
            } catch {
                // Ignore detach failure
            }
        }
        record.listeners.length = 0;

        for (const disposer of record.disposers) {
            try {
                disposer();
            } catch {
                // Ignore custom disposer failure
            }
        }
        record.disposers.length = 0;

        if (record.iframe) {
            try {
                if (typeof record.iframe.remove === 'function') {
                    record.iframe.remove();
                } else {
                    record.iframe.parentNode?.removeChild(record.iframe);
                }
            } catch {
                // Ignore DOM removal failure
            }
            record.iframe = null;
        }
    }
}
