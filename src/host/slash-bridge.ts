import {
    executeSlashCommands,
    executeSlashCommandsWithOptions,
} from '@st/scripts/slash-commands.js';
import { SlashCommandAbortController } from '@st/scripts/slash-commands/SlashCommandAbortController.js';

interface SlashResultLike {
    pipe?: unknown;
    isAborted?: unknown;
    abortReason?: unknown;
    isError?: unknown;
    errorMessage?: unknown;
}

function isAbortLikeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const rec = error as { name?: unknown; code?: unknown };
    return rec.name === 'AbortError' || rec.code === 'ABORT_ERR';
}

function createAbortError(message: string = 'Slash command aborted'): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

function toAbortError(reason: unknown, fallbackMessage: string): Error {
    if (reason instanceof Error && isAbortLikeError(reason)) {
        return reason;
    }
    if (reason instanceof Error && reason.message) {
        return createAbortError(reason.message);
    }
    if (typeof reason === 'string' && reason.trim()) {
        return createAbortError(reason.trim());
    }
    return createAbortError(fallbackMessage);
}

/**
 * Convert an arbitrary SillyTavern slash command `pipe` return value into a clean string.
 */
export function normalizeSlashPipeResult(pipe: unknown): string {
    if (pipe === undefined || pipe === null) {
        return '';
    }
    if (typeof pipe === 'string') {
        return pipe;
    }
    if (typeof pipe === 'number' || typeof pipe === 'boolean' || typeof pipe === 'bigint') {
        return String(pipe);
    }
    try {
        return JSON.stringify(pipe) ?? '';
    } catch {
        return String(pipe);
    }
}

/**
 * Safely execute a SillyTavern slash command (STscript) with `AbortSignal` support
 * and normalize the returned `SlashCommandClosureResult` / `pipe` value to a string.
 */
export async function executeStSlashCommand(
    command: string,
    signal?: AbortSignal,
): Promise<string> {
    if (signal?.aborted) {
        throw toAbortError(signal.reason, 'Slash command aborted before execution');
    }

    const trimmed = typeof command === 'string' ? command.trim() : '';
    if (!trimmed) {
        return '';
    }

    const stAbortController = new SlashCommandAbortController();
    let onAbort: (() => void) | null = null;
    let abortPromise: Promise<never> | null = null;

    if (signal) {
        abortPromise = new Promise<never>((_resolve, reject) => {
            onAbort = () => {
                const abortErr = toAbortError(signal.reason, 'Slash command aborted');
                try {
                    stAbortController.abort(abortErr.message, true);
                } catch {
                    // Ignore secondary errors raised by ST abort listeners.
                }
                reject(abortErr);
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    const execPromise: Promise<unknown> =
        typeof executeSlashCommandsWithOptions === 'function'
            ? executeSlashCommandsWithOptions(trimmed, {
                handleParserErrors: false,
                handleExecutionErrors: false,
                abortController: stAbortController,
            })
            : executeSlashCommands(
                trimmed,
                false,
                undefined,
                false,
                undefined,
                stAbortController,
            );

    // Prevent unhandled rejection noise if the abort race settles first.
    if (abortPromise) {
        void execPromise.catch(() => undefined);
    }

    let rawResult: unknown;
    try {
        rawResult = abortPromise
            ? await Promise.race([execPromise, abortPromise])
            : await execPromise;
    } finally {
        if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
        }
    }

    if (signal?.aborted) {
        throw toAbortError(signal.reason, 'Slash command aborted');
    }

    if (rawResult === null || rawResult === undefined) {
        return '';
    }

    if (typeof rawResult === 'string') {
        return rawResult;
    }

    if (typeof rawResult === 'object') {
        const res = rawResult as SlashResultLike;
        if (res.isAborted) {
            const reasonText =
                typeof res.abortReason === 'string' && res.abortReason.trim()
                    ? res.abortReason.trim()
                    : 'Slash command aborted';
            throw createAbortError(reasonText);
        }
        if (res.isError) {
            const errMsg =
                typeof res.errorMessage === 'string' && res.errorMessage.trim()
                    ? res.errorMessage.trim()
                    : 'Slash command execution failed';
            throw new Error(errMsg);
        }
        if ('pipe' in res) {
            return normalizeSlashPipeResult(res.pipe);
        }
    }

    return normalizeSlashPipeResult(rawResult);
}
