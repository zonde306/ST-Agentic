import { createAbortError, isAbortError, LLMTransportError, throwIfAborted } from './errors';

export interface RetryOptions {
    /** Total attempts including the initial call (default: 3, minimum: 1). */
    maxAttempts?: number;
    /** Base delay in ms before the first retry (default: 300). */
    initialDelayMs?: number;
    /** Maximum backoff delay in ms (default: 30_000). */
    maxDelayMs?: number;
    /** Exponential multiplier between retries (default: 2). */
    backoffFactor?: number;
    /** Optional proportional jitter in [0, 1] applied to computed delay (default: 0). */
    jitterRatio?: number;
    /** Cancellation signal checked before each attempt and during backoff sleep. */
    signal?: AbortSignal;
    /** Custom predicate overriding default retryability check. */
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    /** Optional hook invoked right before sleeping for retry backoff. */
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Sleeps for `ms` milliseconds, rejecting immediately if `signal` aborts.
 */
export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(createAbortError(signal, 'Retry delay aborted'));
    }

    if (ms <= 0) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);

        function onAbort(): void {
            clearTimeout(timer);
            reject(createAbortError(signal, 'Retry delay aborted'));
        }

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

export function defaultShouldRetry(error: unknown): boolean {
    if (isAbortError(error)) {
        return false;
    }

    if (error instanceof LLMTransportError) {
        return error.retryable;
    }

    if (error && typeof error === 'object') {
        const maybe = error as { retryable?: unknown; status?: unknown };
        if (typeof maybe.retryable === 'boolean') {
            return maybe.retryable;
        }
        if (typeof maybe.status === 'number') {
            return maybe.status === 408 || maybe.status === 429 || (maybe.status >= 500 && maybe.status <= 599);
        }
    }

    return true;
}

function computeBackoffDelay(
    error: unknown,
    attempt: number,
    initialDelayMs: number,
    maxDelayMs: number,
    backoffFactor: number,
    jitterRatio: number,
): number {
    const expDelay = initialDelayMs * Math.pow(backoffFactor, Math.max(0, attempt - 1));
    let delay = Math.min(maxDelayMs, Math.max(0, expDelay));

    if (error instanceof LLMTransportError && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)) {
        delay = Math.min(maxDelayMs, Math.max(delay, error.retryAfterMs));
    }

    if (jitterRatio > 0 && delay > 0) {
        const clampedJitter = Math.min(1, Math.max(0, jitterRatio));
        const factor = 1 - clampedJitter + Math.random() * clampedJitter;
        delay = Math.round(delay * factor);
    }

    return delay;
}

/**
 * Executes `fn` with exponential backoff retries, immediately stopping and rejecting
 * whenever `options.signal` is aborted.
 */
export async function withRetry<T>(
    fn: (attempt: number) => Promise<T>,
    options: RetryOptions = {},
): Promise<T> {
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? 300);
    const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 30_000);
    const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
    const jitterRatio = options.jitterRatio ?? 0;
    const signal = options.signal;
    const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        throwIfAborted(signal, 'Retry operation aborted');

        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;

            if (signal?.aborted) {
                throw createAbortError(signal, 'Retry operation aborted');
            }

            if (attempt >= maxAttempts || !shouldRetry(error, attempt)) {
                throw error;
            }

            const delayMs = computeBackoffDelay(
                error,
                attempt,
                initialDelayMs,
                maxDelayMs,
                backoffFactor,
                jitterRatio,
            );

            options.onRetry?.(error, attempt, delayMs);

            if (delayMs > 0) {
                await delayWithAbort(delayMs, signal);
            }
        }
    }

    throw lastError;
}
