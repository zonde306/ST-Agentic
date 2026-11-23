import { describe, expect, it, vi } from 'vitest';
import {
    createAbortError,
    defaultShouldRetry,
    isContextOverflowError,
    LLMTransportError,
    parseContextOverflowError,
    withRetry,
} from '@/core/llm';

describe('parseContextOverflowError & isContextOverflowError', () => {
    it('parses Gemini input token overflow messages and extracts limit & actual counts', () => {
        const err = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
            { status: 400 },
        );

        const parsed = parseContextOverflowError(err);
        expect(parsed).toEqual({
            isOverflow: true,
            providerHint: 'gemini',
            limitTokens: 1048576,
            actualTokens: 1795404,
            rawMessage: err.message,
        });
        expect(isContextOverflowError(err)).toBe(true);
    });

    it('parses Gemini overflow from responseBody JSON and comma-formatted numbers', () => {
        const err = new LLMTransportError('HTTP 400 Bad Request', {
            status: 400,
            responseBody: JSON.stringify({
                error: {
                    code: 400,
                    message:
                        'The input token count (1,826,763) exceeds the maximum number of tokens allowed (1,048,576).',
                    status: 'INVALID_ARGUMENT',
                },
            }),
        });

        const parsed = parseContextOverflowError(err);
        expect(parsed).not.toBeNull();
        expect(parsed?.providerHint).toBe('gemini');
        expect(parsed?.limitTokens).toBe(1048576);
        expect(parsed?.actualTokens).toBe(1826763);
    });

    it('parses OpenAI context_length_exceeded errors with limit and actual counts', () => {
        const err = new LLMTransportError(
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens. Please reduce the length of the messages.",
            {
                status: 400,
                code: 'context_length_exceeded',
            },
        );

        const parsed = parseContextOverflowError(err);
        expect(parsed).toEqual({
            isOverflow: true,
            providerHint: 'openai',
            limitTokens: 128000,
            actualTokens: 145000,
            rawMessage: err.message,
        });
    });

    it('parses DeepSeek, OpenRouter, and vLLM context length variants', () => {
        const openRouterErr = new LLMTransportError(
            "This endpoint's maximum context length is 131072 tokens. However, you requested about 150000 tokens (146000 of text input, 4000 in the output).",
            { status: 400 },
        );
        expect(parseContextOverflowError(openRouterErr)).toMatchObject({
            isOverflow: true,
            providerHint: 'openai',
            limitTokens: 131072,
            actualTokens: 150000,
        });

        const vllmErr = new Error(
            "This model's maximum context length is 32768 tokens. However, your request has 40123 input tokens.",
        );
        expect(parseContextOverflowError(vllmErr)).toMatchObject({
            isOverflow: true,
            providerHint: 'openai',
            limitTokens: 32768,
            actualTokens: 40123,
        });

        const deepSeekBodyErr = new LLMTransportError('Bad Request', {
            status: 400,
            responseBody: JSON.stringify({
                error: {
                    code: 'context_length_exceeded',
                    message:
                        'This model maximum context length is 65536 tokens, however you requested 80000 tokens.',
                },
            }),
        });
        expect(parseContextOverflowError(deepSeekBodyErr)).toMatchObject({
            isOverflow: true,
            providerHint: 'openai',
            limitTokens: 65536,
            actualTokens: 80000,
        });
    });

    it('parses Anthropic prompt-too-long errors', () => {
        const err = new LLMTransportError('prompt is too long: 215000 tokens > 200000 maximum', {
            status: 400,
            code: 'invalid_request_error',
        });

        expect(parseContextOverflowError(err)).toEqual({
            isOverflow: true,
            providerHint: 'anthropic',
            actualTokens: 215000,
            limitTokens: 200000,
            rawMessage: err.message,
        });

        const bedrockErr = new Error('Input is too long for requested model.');
        expect(parseContextOverflowError(bedrockErr)).toMatchObject({
            isOverflow: true,
            providerHint: 'anthropic',
        });
    });

    it('parses generic HTTP 413 and proxy token-limit overflow errors', () => {
        const http413 = new LLMTransportError('HTTP 413 Payload Too Large', { status: 413 });
        expect(parseContextOverflowError(http413)).toMatchObject({
            isOverflow: true,
            providerHint: 'generic',
        });

        const proxyErr = new Error('Upstream gateway rejected request: token limit exceeded');
        expect(parseContextOverflowError(proxyErr)).toMatchObject({
            isOverflow: true,
            providerHint: 'generic',
        });

        const rawString = 'Request Entity Too Large';
        expect(parseContextOverflowError(rawString)).toMatchObject({
            isOverflow: true,
            providerHint: 'generic',
            rawMessage: rawString,
        });
    });

    it('does NOT misclassify rate limits, auth/server/network errors, or aborts as context overflow', () => {
        const tpm429 = new LLMTransportError(
            'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 30000, Used 28000, Requested 5000',
            { status: 429, code: 'rate_limit_exceeded' },
        );
        expect(parseContextOverflowError(tpm429)).toBeNull();
        expect(isContextOverflowError(tpm429)).toBe(false);

        const rateLimitNoStatus = new Error(
            'Rate limit exceeded: tokens per minute limit reached (50000 > 30000)',
        );
        expect(parseContextOverflowError(rateLimitNoStatus)).toBeNull();

        expect(parseContextOverflowError(new LLMTransportError('Invalid API key', { status: 401 }))).toBeNull();
        expect(parseContextOverflowError(new LLMTransportError('Model not found', { status: 404 }))).toBeNull();
        expect(parseContextOverflowError(new LLMTransportError('Internal server error', { status: 500 }))).toBeNull();
        expect(parseContextOverflowError(new Error('Network request failed: Failed to fetch'))).toBeNull();
        expect(parseContextOverflowError(createAbortError())).toBeNull();
        expect(parseContextOverflowError(null)).toBeNull();
        expect(parseContextOverflowError(undefined)).toBeNull();
    });
});

describe('defaultShouldRetry & withRetry overflow protection', () => {
    it('returns false on context overflow even when status is 400, 413, or 500 with retryable=true', () => {
        const overflow400 = new LLMTransportError(
            'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
            { status: 400 },
        );
        const overflow413 = new LLMTransportError('Payload Too Large', {
            status: 413,
            retryable: true,
        });
        const overflow500 = new LLMTransportError(
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 145000 tokens.",
            { status: 500, retryable: true },
        );
        const plainOverflow500 = {
            status: 500,
            message: 'prompt is too long: 215000 tokens > 200000 maximum',
        };

        expect(defaultShouldRetry(overflow400)).toBe(false);
        expect(defaultShouldRetry(overflow413)).toBe(false);
        expect(defaultShouldRetry(overflow500)).toBe(false);
        expect(defaultShouldRetry(plainOverflow500)).toBe(false);
    });

    it('still allows retry for ordinary 429 and 500 transport errors', () => {
        expect(defaultShouldRetry(new LLMTransportError('Rate limited', { status: 429 }))).toBe(true);
        expect(defaultShouldRetry(new LLMTransportError('Bad gateway', { status: 502 }))).toBe(true);
        expect(defaultShouldRetry(new Error('Transient socket hang up'))).toBe(true);
    });

    it('short-circuits withRetry on the first attempt for context overflow errors', async () => {
        const fn = vi.fn(async () => {
            throw new LLMTransportError(
                'The input token count exceeds the maximum number of tokens allowed (1048576); input token count: 1795404',
                { status: 500, retryable: true },
            );
        });

        await expect(
            withRetry(fn, { maxAttempts: 3, initialDelayMs: 1 }),
        ).rejects.toThrow(/maximum number of tokens allowed/i);

        expect(fn).toHaveBeenCalledTimes(1);
    });
});
