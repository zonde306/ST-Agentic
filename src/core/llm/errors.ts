export interface LLMTransportErrorOptions {
    status?: number;
    code?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    responseBody?: string;
    cause?: unknown;
}

/**
 * Structured error thrown by LLM transport, payload compilation, and SSE stream parsing.
 */
export class LLMTransportError extends Error {
    public readonly status?: number;
    public readonly code?: string;
    public readonly retryable: boolean;
    public readonly retryAfterMs?: number;
    public readonly responseBody?: string;

    constructor(message: string, options: LLMTransportErrorOptions = {}) {
        super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'LLMTransportError';
        this.status = options.status;
        this.code = options.code;
        this.retryable =
            options.retryable ?? (options.status !== undefined ? isRetryableStatus(options.status) : false);
        this.retryAfterMs = options.retryAfterMs;
        this.responseBody = options.responseBody;
    }
}

export function isRetryableStatus(status: number): boolean {
    if (status === 408 || status === 429) {
        return true;
    }
    return status >= 500 && status <= 599;
}

export function createAbortError(signal?: AbortSignal, fallbackMessage: string = 'Operation aborted'): Error {
    const reason = signal?.reason;
    if (reason instanceof Error) {
        if (reason.name !== 'AbortError') {
            const err = new Error(reason.message || fallbackMessage, { cause: reason });
            err.name = 'AbortError';
            return err;
        }
        return reason;
    }
    const message = typeof reason === 'string' && reason ? reason : fallbackMessage;
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

export function isAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const err = error as { name?: unknown; code?: unknown };
    return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}

export function throwIfAborted(signal?: AbortSignal, message?: string): void {
    if (signal?.aborted) {
        throw createAbortError(signal, message);
    }
}
