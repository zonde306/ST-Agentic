import type { LLMRequest } from '@/core/bridge';
import { canonicalStringify } from '@/core/utils';

/**
 * KV Cache Watchdog assertion: verifies byte-for-byte append-only prefix invariance
 * across consecutive LLM requests before High Watermark compaction.
 */
export function assertAppendOnlyPrefix(prevReq: LLMRequest, nextReq: LLMRequest): void {
    const prevTools = canonicalStringify(prevReq.tools);
    const nextTools = canonicalStringify(nextReq.tools);

    if (prevTools !== nextTools) {
        throw new Error(
            `KV Cache prefix violation: tool schemas mutated between turns.\n`
            + `Prev tools: ${prevTools}\n`
            + `Next tools: ${nextTools}`,
        );
    }

    if (nextReq.messages.length < prevReq.messages.length) {
        throw new Error(
            `KV Cache prefix violation: message history shrank from `
            + `${prevReq.messages.length} to ${nextReq.messages.length} without compaction.`,
        );
    }

    for (let i = 0; i < prevReq.messages.length; i += 1) {
        const prevMsg = canonicalStringify(prevReq.messages[i]);
        const nextMsg = canonicalStringify(nextReq.messages[i]);
        if (prevMsg !== nextMsg) {
            throw new Error(
                `KV Cache prefix violation at messages[${i}]: historical message mutated.\n`
                + `Prev: ${prevMsg}\n`
                + `Next: ${nextMsg}`,
            );
        }
    }
}

/**
 * Controllable async gate for deterministic concurrency barrier and race-condition tests.
 */
export class DeferredGate<T = void> {
    private readonly _promise: Promise<T>;
    private _resolve!: (value: T) => void;
    private _reject!: (reason?: unknown) => void;
    private _settled = false;
    private _waitingCount = 0;
    private readonly _waitingWaiters: Array<() => void> = [];

    constructor() {
        this._promise = new Promise<T>((res, rej) => {
            this._resolve = res;
            this._reject = rej;
        });
    }

    /**
     * Promise resolved/rejected when `resolve()` or `reject()` is called.
     * Accessing this property signals that a consumer is entering the gate.
     */
    get promise(): Promise<T> {
        this.markWaiting();
        return this._promise;
    }

    /** Explicit await helper identical to `await gate.promise`. */
    wait(): Promise<T> {
        this.markWaiting();
        return this._promise;
    }

    get isSettled(): boolean {
        return this._settled;
    }

    get waitingCount(): number {
        return this._waitingCount;
    }

    resolve(value: T): void {
        if (this._settled) {
            return;
        }
        this._settled = true;
        this._resolve(value);
    }

    reject(reason?: unknown): void {
        if (this._settled) {
            return;
        }
        this._settled = true;
        this._reject(reason);
    }

    /**
     * Wait until at least one caller has entered `gate.promise` / `gate.wait()`.
     */
    waitUntilWaiting(timeoutMs: number = 5000): Promise<void> {
        if (this._waitingCount > 0) {
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this._waitingWaiters.indexOf(onReady);
                if (idx >= 0) {
                    this._waitingWaiters.splice(idx, 1);
                }
                reject(new Error(`DeferredGate.waitUntilWaiting() timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            const onReady = () => {
                clearTimeout(timer);
                resolve();
            };

            this._waitingWaiters.push(onReady);
        });
    }

    private markWaiting(): void {
        this._waitingCount += 1;
        while (this._waitingWaiters.length > 0) {
            const waiter = this._waitingWaiters.shift();
            waiter?.();
        }
    }
}
