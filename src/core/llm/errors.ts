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

export interface ContextOverflowInfo {
    isOverflow: true;
    providerHint?: 'gemini' | 'openai' | 'anthropic' | 'generic';
    /** Maximum allowed context tokens reported by the upstream provider (when parseable). */
    limitTokens?: number;
    /** Actual input/request tokens reported by the upstream provider (when parseable). */
    actualTokens?: number;
    rawMessage: string;
}

interface ExtractedErrorContext {
    rawMessage: string;
    searchText: string;
    status?: number;
    code?: string;
}

function parsePositiveTokenInt(raw: string | undefined): number | undefined {
    if (!raw) {
        return undefined;
    }
    const cleaned = raw.replace(/[,\s_]/g, '');
    if (!/^\d+$/.test(cleaned)) {
        return undefined;
    }
    const value = Number.parseInt(cleaned, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function extractCodeAndMessageFromBody(body: string): { code?: string; message?: string } {
    const trimmed = body.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
        return {};
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        const target = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            return {};
        }
        const record = target as Record<string, unknown>;
        const nestedErr =
            record.error && typeof record.error === 'object' && !Array.isArray(record.error)
                ? (record.error as Record<string, unknown>)
                : undefined;
        const codeCandidate = [
            nestedErr?.code,
            nestedErr?.type,
            nestedErr?.status,
            record.code,
            record.type,
            record.status,
        ].find((v): v is string => typeof v === 'string' && v.trim().length > 0);
        const msgCandidate =
            nestedErr?.message
            ?? (typeof record.error === 'string' ? record.error : undefined)
            ?? record.message
            ?? (typeof record.detail === 'string' ? record.detail : undefined);
        return {
            ...(codeCandidate ? { code: codeCandidate.trim() } : {}),
            ...(typeof msgCandidate === 'string' && msgCandidate.trim()
                ? { message: msgCandidate.trim() }
                : {}),
        };
    } catch {
        return {};
    }
}

function extractErrorContext(error: unknown): ExtractedErrorContext | null {
    if (error === null || error === undefined) {
        return null;
    }

    if (typeof error === 'string') {
        const trimmed = error.trim();
        return trimmed ? { rawMessage: trimmed, searchText: trimmed } : null;
    }

    if (typeof error !== 'object') {
        return null;
    }

    const obj = error as Record<string, unknown>;
    const cause =
        obj.cause && typeof obj.cause === 'object'
            ? (obj.cause as Record<string, unknown>)
            : undefined;

    const status =
        typeof obj.status === 'number' && Number.isFinite(obj.status)
            ? obj.status
            : typeof cause?.status === 'number' && Number.isFinite(cause.status)
                ? cause.status
                : undefined;

    const responseBody =
        typeof obj.responseBody === 'string'
            ? obj.responseBody
            : typeof cause?.responseBody === 'string'
                ? cause.responseBody
                : undefined;

    const bodyInfo = responseBody ? extractCodeAndMessageFromBody(responseBody) : {};

    const directCode =
        typeof obj.code === 'string' && obj.code.trim()
            ? obj.code.trim()
            : typeof cause?.code === 'string' && cause.code.trim()
                ? cause.code.trim()
                : undefined;
    const code = directCode ?? bodyInfo.code;

    const directMessage =
        typeof obj.message === 'string' && obj.message.trim()
            ? obj.message.trim()
            : typeof cause?.message === 'string' && cause.message.trim()
                ? cause.message.trim()
                : '';

    const rawMessage = directMessage || bodyInfo.message || responseBody?.trim() || '';
    const parts: string[] = [];
    if (directMessage) {
        parts.push(directMessage);
    }
    if (code) {
        parts.push(code);
    }
    if (bodyInfo.message && bodyInfo.message !== directMessage) {
        parts.push(bodyInfo.message);
    }
    if (responseBody && responseBody.trim()) {
        parts.push(responseBody.trim());
    }

    const searchText = parts.join('\n');
    if (!searchText && status === undefined) {
        return null;
    }

    return {
        rawMessage: rawMessage || (status !== undefined ? `HTTP ${status}` : ''),
        searchText,
        ...(status !== undefined ? { status } : {}),
        ...(code !== undefined ? { code } : {}),
    };
}

const RATE_LIMIT_RE =
    /\brate[\s_-]?limit(?:ed|_exceeded)?\b|\btokens?\s+per\s+min(?:ute)?\b|\brequests?\s+per\s+min(?:ute)?\b|\b(?:TPM|RPM)\b|\btoo\s+many\s+requests\b/i;

const EXPLICIT_OVERFLOW_SIGNAL_RE =
    /context_length_exceeded|prompt\s+is\s+too\s+long|maximum\s+context\s+length|exceeds\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed/i;

const ANTHROPIC_PAIR_RE =
    /prompt\s+is\s+too\s+long[:\s]+([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*(?:maximum|max|limit)/i;
const ANTHROPIC_FALLBACK_RE =
    /prompt\s+is\s+too\s+long|input\s+is\s+too\s+long\s+for\s+requested\s+model/i;

const GEMINI_LIMIT_THEN_ACTUAL_RE =
    /exceeds\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed\s*\(?\s*([\d,]+)\s*\)?[\s\S]*?input\s+token\s+count[:\s]+\(?\s*([\d,]+)\s*\)?/i;
const GEMINI_ACTUAL_THEN_LIMIT_RE =
    /input\s+token\s+count\s*\(?\s*([\d,]+)\s*\)?\s*exceeds\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed\s*\(?\s*([\d,]+)\s*\)?/i;
const GEMINI_LIMIT_ONLY_RE =
    /exceeds\s+the\s+maximum\s+number\s+of\s+tokens\s+allowed(?:\s*\(?\s*([\d,]+)\s*\)?)?/i;
const GEMINI_INPUT_COUNT_RE =
    /input\s+token\s+count[:\s]+\(?\s*([\d,]+)\s*\)?/i;

const OPENAI_TRIGGER_RE =
    /context_length_exceeded|maximum\s+context\s+length\s+is\s+[\d,]+\s*tokens?|exceeds?\s+the\s+context\s+window|input\s+tokens?\s+exceed(?:s)?\s+(?:the\s+)?(?:configured\s+)?limit\s+of\s+[\d,]+|reduce\s+the\s+length\s+of\s+the\s+messages/i;
const OPENAI_LIMIT_PATTERNS: readonly RegExp[] = [
    /maximum\s+context\s+length\s+is\s+([\d,]+)\s*tokens?/i,
    /(?:configured\s+)?limit\s+of\s+([\d,]+)\s*tokens?/i,
    /context\s+(?:window|length|limit)\s*(?:is|of|:)\s*([\d,]+)\s*tokens?/i,
];
const OPENAI_ACTUAL_PATTERNS: readonly RegExp[] = [
    /resulted\s+in\s+([\d,]+)\s*tokens?/i,
    /requested\s+(?:about\s+)?([\d,]+)\s*tokens?/i,
    /request\s+has\s+([\d,]+)\s*(?:input\s+)?tokens?/i,
    /got\s+([\d,]+)\s*tokens?/i,
    /(?:your\s+)?input\s+(?:has|contains|is)\s+([\d,]+)\s*tokens?/i,
];

const GENERIC_OVERFLOW_RE =
    /payload\s+too\s+large|request\s+entity\s+too\s+large|request\s+too\s+large|request\s+payload\s+size\s+exceeds|context[\s_-]?(?:length|window|size|limit)\s*(?:exceeded|overflow|too\s+long)|exceed(?:s|ed)?\s+(?:the\s+)?(?:model'?s?\s+)?(?:maximum\s+)?(?:context|token)\s*(?:length|window|limit)|token\s+limit\s+exceeded|too\s+many\s+(?:input\s+)?tokens|maximum\s+token\s+limit|(?:prompt|input|messages?)\s+(?:is\s+|are\s+)?too\s+long/i;

function matchFirstTokenInt(text: string, patterns: readonly RegExp[]): number | undefined {
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match?.[1]) {
            const parsed = parsePositiveTokenInt(match[1]);
            if (parsed !== undefined) {
                return parsed;
            }
        }
    }
    return undefined;
}

/**
 * Recognizes context/token window overflow errors across Gemini, OpenAI, DeepSeek,
 * OpenRouter, vLLM, Anthropic, and generic HTTP 413/proxy gateways, extracting
 * `(limitTokens, actualTokens)` when present.
 */
export function parseContextOverflowError(error: unknown): ContextOverflowInfo | null {
    if (isAbortError(error)) {
        return null;
    }

    const ctx = extractErrorContext(error);
    if (!ctx) {
        return null;
    }

    if (ctx.status === 429) {
        return null;
    }

    const { rawMessage, searchText, status, code } = ctx;

    if (
        (code?.toLowerCase() === 'rate_limit_exceeded' || RATE_LIMIT_RE.test(searchText))
        && !EXPLICIT_OVERFLOW_SIGNAL_RE.test(searchText)
    ) {
        return null;
    }

    // 1. Anthropic
    const anthropicPair = ANTHROPIC_PAIR_RE.exec(searchText);
    if (anthropicPair) {
        const actualTokens = parsePositiveTokenInt(anthropicPair[1]);
        const limitTokens = parsePositiveTokenInt(anthropicPair[2]);
        return {
            isOverflow: true,
            providerHint: 'anthropic',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }
    if (ANTHROPIC_FALLBACK_RE.test(searchText)) {
        return {
            isOverflow: true,
            providerHint: 'anthropic',
            rawMessage,
        };
    }

    // 2. Gemini
    const geminiLimitActual = GEMINI_LIMIT_THEN_ACTUAL_RE.exec(searchText);
    if (geminiLimitActual) {
        const limitTokens = parsePositiveTokenInt(geminiLimitActual[1]);
        const actualTokens = parsePositiveTokenInt(geminiLimitActual[2]);
        return {
            isOverflow: true,
            providerHint: 'gemini',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }

    const geminiActualLimit = GEMINI_ACTUAL_THEN_LIMIT_RE.exec(searchText);
    if (geminiActualLimit) {
        const actualTokens = parsePositiveTokenInt(geminiActualLimit[1]);
        const limitTokens = parsePositiveTokenInt(geminiActualLimit[2]);
        return {
            isOverflow: true,
            providerHint: 'gemini',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }

    const geminiLimitOnly = GEMINI_LIMIT_ONLY_RE.exec(searchText);
    if (geminiLimitOnly) {
        const limitTokens = parsePositiveTokenInt(geminiLimitOnly[1]);
        const actualMatch = GEMINI_INPUT_COUNT_RE.exec(searchText);
        const actualTokens = parsePositiveTokenInt(actualMatch?.[1]);
        return {
            isOverflow: true,
            providerHint: 'gemini',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }

    // 3. OpenAI / DeepSeek / OpenRouter / vLLM
    if (code?.toLowerCase() === 'context_length_exceeded' || OPENAI_TRIGGER_RE.test(searchText)) {
        const limitTokens = matchFirstTokenInt(searchText, OPENAI_LIMIT_PATTERNS);
        const actualTokens = matchFirstTokenInt(searchText, OPENAI_ACTUAL_PATTERNS);
        return {
            isOverflow: true,
            providerHint: 'openai',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }

    // 4. Generic overflow (HTTP 413 or generic proxy token/context limit errors)
    if (status === 413 || GENERIC_OVERFLOW_RE.test(searchText)) {
        const limitTokens = matchFirstTokenInt(searchText, [
            ...OPENAI_LIMIT_PATTERNS,
            /(?:max(?:imum)?|limit)\s*(?:is|of|:)?\s*\(?\s*([\d,]+)\s*\)?\s*tokens?/i,
            />\s*([\d,]+)\s*(?:max(?:imum)?|limit|tokens?)/i,
        ]);
        const actualTokens = matchFirstTokenInt(searchText, [
            ...OPENAI_ACTUAL_PATTERNS,
            /([\d,]+)\s*tokens?\s*>/i,
        ]);
        return {
            isOverflow: true,
            providerHint: 'generic',
            ...(limitTokens !== undefined ? { limitTokens } : {}),
            ...(actualTokens !== undefined ? { actualTokens } : {}),
            rawMessage,
        };
    }

    return null;
}

export function isContextOverflowError(error: unknown): boolean {
    return parseContextOverflowError(error) !== null;
}
