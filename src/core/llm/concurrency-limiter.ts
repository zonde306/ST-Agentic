import { createAbortError } from './errors';

interface QueuedWaiter {
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

function normalizeLimit(limit: number): number {
    if (!Number.isFinite(limit)) {
        return limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : 1;
    }
    return Math.max(1, Math.floor(limit));
}

/**
 * Bounded semaphore queue controlling concurrent async operations with immediate
 * AbortSignal cancellation for queued and running callers.
 */
export class ConcurrencyLimiter {
    private limit: number;
    private active = 0;
    private readonly queue: QueuedWaiter[] = [];

    constructor(maxConcurrency: number = 1) {
        this.limit = normalizeLimit(maxConcurrency);
    }

    get maxConcurrency(): number {
        return this.limit;
    }

    get activeCount(): number {
        return this.active;
    }

    get queuedCount(): number {
        return this.queue.length;
    }

    /**
     * Dynamically adjusts concurrency limit and drains queued waiters if capacity increased.
     */
    setMaxConcurrency(maxConcurrency: number): void {
        this.limit = normalizeLimit(maxConcurrency);
        this.drainQueue();
    }

    /**
     * Acquires a concurrency slot, waiting in FIFO order if the limit is reached.
     * Rejects immediately if `signal` is already aborted or aborts while queued.
     */
    acquire(signal?: AbortSignal): Promise<() => void> {
        if (signal?.aborted) {
            return Promise.reject(createAbortError(signal, 'Concurrency acquire aborted'));
        }

        if (this.active < this.limit) {
            this.active += 1;
            return Promise.resolve(this.createReleaseFn());
        }

        return new Promise<() => void>((resolve, reject) => {
            const waiter: QueuedWaiter = {
                resolve,
                reject,
                signal,
            };

            if (signal) {
                const onAbort = () => {
                    const idx = this.queue.indexOf(waiter);
                    if (idx >= 0) {
                        this.queue.splice(idx, 1);
                    }
                    reject(createAbortError(signal, 'Concurrency acquire aborted while queued'));
                };
                waiter.onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }

            this.queue.push(waiter);
        });
    }

    /**
     * Runs `fn` inside a bounded slot. If `signal` aborts while `fn` is running,
     * the returned promise rejects immediately while the underlying slot remains
     * held until `fn` settles to preserve the true concurrency bound.
     */
    async run<T>(fn: (signal?: AbortSignal) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
        const release = await this.acquire(signal);

        if (signal?.aborted) {
            release();
            throw createAbortError(signal, 'Operation aborted');
        }

        let taskPromise: Promise<T>;
        try {
            taskPromise = Promise.resolve(fn(signal));
        } catch (err) {
            release();
            throw err;
        }

        // Ensure slot is released strictly when the underlying task finishes.
        const trackedTask = taskPromise.finally(() => {
            release();
        });

        if (!signal) {
            return trackedTask;
        }

        // Prevent unhandled rejection if caller aborts early and trackedTask rejects later.
        trackedTask.catch(() => {});

        return new Promise<T>((resolve, reject) => {
            let settled = false;

            const onAbort = () => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(createAbortError(signal, 'Operation aborted'));
            };

            signal.addEventListener('abort', onAbort, { once: true });

            trackedTask.then(
                (value) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    resolve(value);
                },
                (err) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    signal.removeEventListener('abort', onAbort);
                    reject(err);
                },
            );
        });
    }

    private createReleaseFn(): () => void {
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            this.active = Math.max(0, this.active - 1);
            this.drainQueue();
        };
    }

    private drainQueue(): void {
        while (this.active < this.limit && this.queue.length > 0) {
            const next = this.queue.shift()!;
            if (next.signal && next.onAbort) {
                next.signal.removeEventListener('abort', next.onAbort);
            }
            if (next.signal?.aborted) {
                next.reject(createAbortError(next.signal, 'Concurrency acquire aborted'));
                continue;
            }
            this.active += 1;
            next.resolve(this.createReleaseFn());
        }
    }
}

export type ConcurrencyExecuteMode = 'all' | 'allSettled';

/**
 * Batch helper executing tasks through a bounded `ConcurrencyLimiter`.
 */
export async function executeWithConcurrency<T>(
    tasks: Array<(signal?: AbortSignal) => Promise<T>>,
    maxConcurrency: number = 1,
    mode: ConcurrencyExecuteMode = 'allSettled',
    signal?: AbortSignal,
): Promise<PromiseSettledResult<T>[]> {
    if (tasks.length === 0) {
        return [];
    }

    const limiter = new ConcurrencyLimiter(maxConcurrency);
    const settled = await Promise.allSettled(
        tasks.map((task) => limiter.run(task, signal)),
    );

    if (mode === 'all') {
        const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) {
            throw failed.reason;
        }
    }

    return settled;
}
