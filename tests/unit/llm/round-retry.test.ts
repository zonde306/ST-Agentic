import { describe, expect, it, vi } from 'vitest';
import {
    LLMTransportError,
    ROUND_RETRY_ERROR_CODES,
    computeRoundRetryDelayMs,
    createAbortError,
    isLengthFinishReason,
    isRetryableRoundError,
    isRoundRetryErrorCode,
    isValidJsonObjectString,
} from '@/core/llm';

describe('round retry primitives (errors.ts & retry.ts)', () => {
    it('exports standardized ROUND_RETRY_ERROR_CODES and classifies them as retryable', () => {
        expect(ROUND_RETRY_ERROR_CODES).toEqual({
            EMPTY_RESPONSE: 'EMPTY_RESPONSE',
            TOOL_CHOICE_VIOLATION: 'TOOL_CHOICE_VIOLATION',
            MALFORMED_TOOL_CALL: 'MALFORMED_TOOL_CALL',
            OUTPUT_VALIDATION_RETRY: 'OUTPUT_VALIDATION_RETRY',
        });

        expect(isRoundRetryErrorCode('EMPTY_RESPONSE')).toBe(true);
        expect(isRoundRetryErrorCode('TOOL_CHOICE_VIOLATION')).toBe(true);
        expect(isRoundRetryErrorCode('MALFORMED_TOOL_CALL')).toBe(true);
        expect(isRoundRetryErrorCode('OUTPUT_VALIDATION_RETRY')).toBe(true);
        expect(isRoundRetryErrorCode('OTHER')).toBe(false);

        for (const code of Object.values(ROUND_RETRY_ERROR_CODES)) {
            const err = new LLMTransportError(`Round failed: ${code}`, { code });
            expect(err.retryable).toBe(true);
            expect(isRetryableRoundError(err)).toBe(true);
        }
    });

    it('rejects aborts, context overflows, and non-retryable 4xx errors', () => {
        expect(isRetryableRoundError(null)).toBe(false);
        expect(isRetryableRoundError(undefined)).toBe(false);
        expect(isRetryableRoundError(createAbortError(undefined, 'user stop'))).toBe(false);

        const assistantAbort = new Error('Assistant aborted');
        assistantAbort.name = 'AssistantAbortError';
        expect(isRetryableRoundError(assistantAbort)).toBe(false);

        const overflow = new LLMTransportError('context_length_exceeded: max 128000 tokens', {
            status: 400,
            code: 'context_length_exceeded',
        });
        expect(isRetryableRoundError(overflow)).toBe(false);

        const badRequest = new LLMTransportError('Bad request', { status: 400 });
        expect(isRetryableRoundError(badRequest)).toBe(false);

        const authErr = new LLMTransportError('Unauthorized', { status: 401 });
        expect(isRetryableRoundError(authErr)).toBe(false);

        const explicitFalse = new LLMTransportError('Forced stop', {
            code: ROUND_RETRY_ERROR_CODES.EMPTY_RESPONSE,
            retryable: false,
        });
        expect(isRetryableRoundError(explicitFalse)).toBe(false);
    });

    it('recognizes retryable HTTP statuses and transient stream/network drop messages', () => {
        expect(isRetryableRoundError(new LLMTransportError('Timeout', { status: 408 }))).toBe(true);
        expect(isRetryableRoundError(new LLMTransportError('Rate limited', { status: 429 }))).toBe(true);
        expect(isRetryableRoundError(new LLMTransportError('Bad gateway', { status: 502 }))).toBe(true);
        expect(isRetryableRoundError(new LLMTransportError('Unavailable', { status: 503 }))).toBe(true);
        expect(isRetryableRoundError({ status: 504 })).toBe(true);
        expect(isRetryableRoundError({ status: 404 })).toBe(false);
        expect(isRetryableRoundError({ code: 'TOOL_CHOICE_VIOLATION' })).toBe(true);

        const transientMessages = [
            'TypeError: Failed to fetch',
            'NetworkError when attempting to fetch resource',
            'socket hang up',
            'read ECONNRESET',
            'ERR_INCOMPLETE_CHUNKED_ENCODING',
            'premature close of body stream',
            'SSE stream dropped unexpectedly',
            'Server overloaded, please retry',
            'MALFORMED_TOOL_CALL detected',
        ];
        for (const msg of transientMessages) {
            expect(isRetryableRoundError(new Error(msg))).toBe(true);
        }

        expect(isRetryableRoundError(new Error('Invalid API key format'))).toBe(false);
    });

    it('computes exponential backoff with default 25% jitter and honors retryAfterMs', () => {
        // Deterministic when jitterRatio = 0
        expect(
            computeRoundRetryDelayMs({
                attempt: 1,
                initialDelayMs: 1200,
                maxDelayMs: 10_000,
                backoffFactor: 2,
                jitterRatio: 0,
            }),
        ).toBe(1200);
        expect(
            computeRoundRetryDelayMs({
                attempt: 2,
                initialDelayMs: 1200,
                maxDelayMs: 10_000,
                backoffFactor: 2,
                jitterRatio: 0,
            }),
        ).toBe(2400);
        expect(
            computeRoundRetryDelayMs({
                attempt: 5,
                initialDelayMs: 1200,
                maxDelayMs: 10_000,
                backoffFactor: 2,
                jitterRatio: 0,
            }),
        ).toBe(10_000);

        // Default jitterRatio = 0.25 stays in [0.75 * base, 1.0 * base]
        const randomSpy = vi.spyOn(Math, 'random');
        try {
            randomSpy.mockReturnValue(0);
            expect(computeRoundRetryDelayMs({ attempt: 1, initialDelayMs: 1200 })).toBe(900);

            randomSpy.mockReturnValue(1);
            expect(computeRoundRetryDelayMs({ attempt: 1, initialDelayMs: 1200 })).toBe(1200);

            randomSpy.mockReturnValue(0.5);
            expect(computeRoundRetryDelayMs({ attempt: 1, initialDelayMs: 1200 })).toBe(1050);
        } finally {
            randomSpy.mockRestore();
        }

        // Honors retryAfterMs (clamped by maxDelayMs)
        const rateLimitErr = new LLMTransportError('Too many requests', {
            status: 429,
            retryAfterMs: 4500,
        });
        expect(
            computeRoundRetryDelayMs({
                error: rateLimitErr,
                attempt: 1,
                initialDelayMs: 1200,
                maxDelayMs: 10_000,
                jitterRatio: 0,
            }),
        ).toBe(4500);

        const hugeRetryAfter = new LLMTransportError('Too many requests', {
            status: 429,
            retryAfterMs: 60_000,
        });
        expect(
            computeRoundRetryDelayMs({
                error: hugeRetryAfter,
                attempt: 1,
                initialDelayMs: 1200,
                maxDelayMs: 8000,
                jitterRatio: 0,
            }),
        ).toBe(8000);
    });

    it('validates JSON object strings and length finish reasons accurately', () => {
        expect(isValidJsonObjectString('{}')).toBe(true);
        expect(isValidJsonObjectString('  {"a": 1, "b": [true]}  ')).toBe(true);
        expect(isValidJsonObjectString('{"truncated": ')).toBe(false);
        expect(isValidJsonObjectString('[1, 2, 3]')).toBe(false);
        expect(isValidJsonObjectString('"string"')).toBe(false);
        expect(isValidJsonObjectString('null')).toBe(false);
        expect(isValidJsonObjectString('')).toBe(false);
        expect(isValidJsonObjectString(123)).toBe(false);

        expect(isLengthFinishReason('length')).toBe(true);
        expect(isLengthFinishReason('max_tokens')).toBe(true);
        expect(isLengthFinishReason('MAX_TOKENS')).toBe(true);
        expect(isLengthFinishReason('stop')).toBe(false);
        expect(isLengthFinishReason(undefined)).toBe(false);
    });
});
