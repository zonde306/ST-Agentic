import { describe, expect, it } from 'vitest';
import { ConcurrencyLimiter, LLMTransportError, withRetry } from '@/core/llm';
import { DeferredGate } from '../../mocks';

describe('ConcurrencyLimiter & withRetry', () => {
    it('bounds active tasks strictly to maxConcurrency in FIFO order', async () => {
        const limiter = new ConcurrencyLimiter(2);
        let active = 0;
        let peak = 0;
        const startOrder: number[] = [];
        const gates = [
            new DeferredGate<void>(),
            new DeferredGate<void>(),
            new DeferredGate<void>(),
            new DeferredGate<void>(),
        ];

        const tasks = gates.map((gate, index) =>
            limiter.run(async () => {
                startOrder.push(index);
                active += 1;
                peak = Math.max(peak, active);
                await gate.wait();
                active -= 1;
                return index;
            }),
        );

        await gates[0].waitUntilWaiting();
        await gates[1].waitUntilWaiting();
        expect(limiter.activeCount).toBe(2);
        expect(limiter.queuedCount).toBe(2);
        expect(startOrder).toEqual([0, 1]);

        gates[0].resolve();
        await gates[2].waitUntilWaiting();
        expect(startOrder).toEqual([0, 1, 2]);
        expect(peak).toBe(2);

        gates[1].resolve();
        await gates[3].waitUntilWaiting();
        expect(startOrder).toEqual([0, 1, 2, 3]);
        expect(peak).toBe(2);

        gates[2].resolve();
        gates[3].resolve();

        await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
        expect(limiter.activeCount).toBe(0);
        expect(limiter.queuedCount).toBe(0);
    });

    it('immediately rejects queued waiters when AbortSignal aborts without blocking remaining queue', async () => {
        const limiter = new ConcurrencyLimiter(1);
        const gate1 = new DeferredGate<void>();
        const gate3 = new DeferredGate<void>();

        const p1 = limiter.run(() => gate1.wait());
        await gate1.waitUntilWaiting();

        const controller = new AbortController();
        let task2Ran = false;
        const p2 = limiter.run(async () => {
            task2Ran = true;
            return 'should-not-run';
        }, controller.signal);

        const p3 = limiter.run(async () => {
            await gate3.wait();
            return 'third-ok';
        });

        expect(limiter.queuedCount).toBe(2);

        controller.abort(new Error('user cancelled'));
        await expect(p2).rejects.toThrow(/user cancelled/);
        expect(limiter.queuedCount).toBe(1);

        gate1.resolve();
        await gate3.waitUntilWaiting();
        gate3.resolve();

        await expect(p1).resolves.toBeUndefined();
        await expect(p3).resolves.toBe('third-ok');
        expect(task2Ran).toBe(false);
    });

    it('retries transient errors with exponential backoff and stops on non-retryable 4xx', async () => {
        let attempts = 0;
        const delays: number[] = [];

        const ok = await withRetry(
            async () => {
                attempts += 1;
                if (attempts < 3) {
                    throw new LLMTransportError('Service unavailable', { status: 503 });
                }
                return 'recovered';
            },
            {
                maxAttempts: 4,
                initialDelayMs: 5,
                backoffFactor: 2,
                onRetry: (_err, _attempt, delayMs) => delays.push(delayMs),
            },
        );

        expect(ok).toBe('recovered');
        expect(attempts).toBe(3);
        expect(delays).toEqual([5, 10]);

        let authAttempts = 0;
        await expect(
            withRetry(
                async () => {
                    authAttempts += 1;
                    throw new LLMTransportError('Invalid API key', { status: 401 });
                },
                { maxAttempts: 5, initialDelayMs: 5 },
            ),
        ).rejects.toThrow(/Invalid API key/);
        expect(authAttempts).toBe(1);
    });

    it('aborts retry backoff immediately when AbortSignal fires', async () => {
        const preAborted = new AbortController();
        preAborted.abort();
        let called = false;
        await expect(
            withRetry(
                async () => {
                    called = true;
                    return 1;
                },
                { signal: preAborted.signal },
            ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(called).toBe(false);

        const controller = new AbortController();
        let retryCount = 0;
        const start = Date.now();

        const retryPromise = withRetry(
            async () => {
                retryCount += 1;
                throw new LLMTransportError('Rate limited', { status: 429 });
            },
            {
                maxAttempts: 5,
                initialDelayMs: 10_000, // very long backoff that must be interrupted immediately
                signal: controller.signal,
            },
        );

        setTimeout(() => controller.abort(), 15);
        await expect(retryPromise).rejects.toMatchObject({ name: 'AbortError' });
        const elapsedMs = Date.now() - start;

        expect(retryCount).toBe(1);
        expect(elapsedMs).toBeLessThan(500);
    });
});
