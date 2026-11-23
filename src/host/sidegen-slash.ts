import { SlashCommand } from '@st/scripts/slash-commands/SlashCommand.js';
import {
    ARGUMENT_TYPE,
    SlashCommandArgument,
    SlashCommandNamedArgument,
} from '@st/scripts/slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '@st/scripts/slash-commands/SlashCommandParser.js';

import type { ToolSideGenApi } from '@/core/bridge';
import type {
    SideClueDelivery,
    SideClueStatus,
    SideGenOnceOptions,
    SideSessionScope,
} from '@/core/types';
import {
    DEFAULT_SIDE_CLUE_DELIVERY,
    isValidSideClueDelivery,
    isValidSideClueStatus,
} from '@/core/utils';

export const SIDEGEN_SLASH_COMMANDS = {
    ONCE: 'sidegen-once',
    SEND: 'sidegen-send',
    CLUE: 'sidegen-clue',
} as const;

export type SideGenClueSlashAction =
    | 'list'
    | 'read'
    | 'write'
    | 'delivery'
    | 'status'
    | 'export'
    | 'delete';

export interface SideGenSlashOptions {
    getSideGen: () => ToolSideGenApi | undefined;
    getAbortSignal?: () => AbortSignal | undefined;
}

export interface SideGenSlashHandle {
    readonly commands: readonly string[];
    dispose(): void;
}

export interface ParsedSideGenSlashInput {
    flags: Record<string, string>;
    text: string;
}

const VALID_CLUE_ACTIONS = new Set<SideGenClueSlashAction>([
    'list',
    'read',
    'write',
    'delivery',
    'status',
    'export',
    'delete',
]);

const KNOWN_CLI_FLAGS = new Set([
    'system',
    'depth',
    'connection',
    'path',
    'delivery',
    'keywords',
    'title',
    'session',
    'scope',
    'action',
    'status',
    'summary',
    'book',
    'include-vars',
    'includevars',
]);

function normalizeFlagKey(raw: string): string {
    return raw.trim().replace(/^--+/, '').toLowerCase();
}

function normalizeUnnamedText(unnamed: unknown): string {
    if (typeof unnamed === 'string') {
        return unnamed;
    }
    if (Array.isArray(unnamed)) {
        return unnamed.map((part) => String(part ?? '')).join(' ');
    }
    if (unnamed === null || unnamed === undefined) {
        return '';
    }
    return String(unnamed);
}

/**
 * Parse both SillyTavern `namedArgs` (`key=value`) AND CLI-style `--flag value` / `--flag="quoted"`
 * tokens embedded in the unnamed command text.
 */
export function parseSideGenSlashInput(
    namedArgs: Record<string, unknown> | undefined,
    unnamed: unknown,
): ParsedSideGenSlashInput {
    const flags: Record<string, string> = {};

    if (namedArgs && typeof namedArgs === 'object') {
        for (const [rawKey, rawVal] of Object.entries(namedArgs)) {
            if (rawVal === undefined || rawVal === null) {
                continue;
            }
            const key = normalizeFlagKey(rawKey);
            if (!key) {
                continue;
            }
            const strVal = String(rawVal).trim();
            if (strVal.length > 0) {
                flags[key] = strVal;
            }
        }
    }

    const rawText = normalizeUnnamedText(unnamed);
    const remainingParts: string[] = [];
    let i = 0;
    const len = rawText.length;

    const skipSpaces = () => {
        while (i < len && /\s/.test(rawText[i]!)) {
            i += 1;
        }
    };

    const readValueToken = (): string => {
        skipSpaces();
        if (i >= len) {
            return '';
        }
        const quote = rawText[i];
        if (quote === '"' || quote === "'") {
            i += 1;
            let buf = '';
            while (i < len && rawText[i] !== quote) {
                if (rawText[i] === '\\' && i + 1 < len) {
                    i += 1;
                }
                buf += rawText[i]!;
                i += 1;
            }
            if (i < len && rawText[i] === quote) {
                i += 1;
            }
            return buf;
        }
        const start = i;
        while (i < len && !/\s/.test(rawText[i]!)) {
            i += 1;
        }
        return rawText.slice(start, i);
    };

    while (i < len) {
        skipSpaces();
        if (i >= len) {
            break;
        }

        if (rawText.startsWith('--', i)) {
            const flagStart = i;
            let cursor = i + 2;
            while (cursor < len && /[a-zA-Z0-9_-]/.test(rawText[cursor]!)) {
                cursor += 1;
            }
            const candidateKey = rawText.slice(i + 2, cursor).toLowerCase();
            if (candidateKey && KNOWN_CLI_FLAGS.has(candidateKey)) {
                if (cursor < len && rawText[cursor] === '=') {
                    i = cursor + 1;
                    flags[candidateKey] = readValueToken();
                    continue;
                }
                if (cursor === len || /\s/.test(rawText[cursor]!)) {
                    i = cursor;
                    if (candidateKey === 'include-vars' || candidateKey === 'includevars') {
                        const peekStart = i;
                        skipSpaces();
                        const nextWordStart = i;
                        while (i < len && !/\s/.test(rawText[i]!)) {
                            i += 1;
                        }
                        const nextWord = rawText.slice(nextWordStart, i).toLowerCase();
                        if (nextWord === 'true' || nextWord === 'false') {
                            flags['include-vars'] = nextWord;
                        } else {
                            flags['include-vars'] = 'true';
                            i = peekStart;
                        }
                    } else {
                        flags[candidateKey] = readValueToken();
                    }
                    continue;
                }
            }
            // Unknown `--token`: keep verbatim as part of prompt text.
            i = flagStart;
        }

        const restStart = i;
        while (i < len && !/\s/.test(rawText[i]!)) {
            i += 1;
        }
        remainingParts.push(rawText.slice(restStart, i));
    }

    return {
        flags,
        text: remainingParts.join(' ').trim(),
    };
}

function parseKeywords(raw: string | undefined): string[] {
    if (!raw || !raw.trim()) {
        return [];
    }
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((item) => String(item).trim()).filter(Boolean);
            }
        } catch {
            // Fall through to comma/semicolon splitting.
        }
    }
    return trimmed
        .split(/[,;，；]/)
        .map((part) => part.trim())
        .filter(Boolean);
}

function parseOptionalDepth(raw: string | undefined): number | undefined {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseDelivery(raw: string | undefined, fallback: SideClueDelivery = DEFAULT_SIDE_CLUE_DELIVERY): SideClueDelivery {
    if (!raw || !raw.trim()) {
        return fallback;
    }
    const normalized = raw.trim();
    if (isValidSideClueDelivery(normalized)) {
        return normalized;
    }
    throw new Error(
        `Invalid --delivery "${raw}". Expected one of: none, vfs_only, radar_hint, next_turn_brief.`,
    );
}

function parseScope(raw: string | undefined): SideSessionScope {
    if (!raw || !raw.trim()) {
        return 'branch';
    }
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'branch' || normalized === 'chat') {
        return normalized;
    }
    throw new Error(`Invalid --scope "${raw}". Expected "branch" or "chat".`);
}

function parseClueStatus(raw: string | undefined): SideClueStatus {
    const normalized = (raw ?? '').trim();
    if (isValidSideClueStatus(normalized)) {
        return normalized;
    }
    throw new Error(`Invalid --status "${raw ?? ''}". Expected one of: dormant, surfaced, resolved.`);
}

function parseIncludeVars(flags: Record<string, string>): boolean | undefined {
    const raw = flags['include-vars'] ?? flags.includevars;
    if (raw === undefined) {
        return undefined;
    }
    return raw.toLowerCase() !== 'false' && raw !== '0';
}

function requireSideGen(getSideGen: () => ToolSideGenApi | undefined): ToolSideGenApi {
    const api = getSideGen();
    if (!api) {
        throw new Error('ST-Agentic SideGen runtime is not initialized.');
    }
    return api;
}

/**
 * Execute `/sidegen-once` with named args / `--flags` and prompt text.
 */
export async function dispatchSideGenOnce(
    sideGen: ToolSideGenApi,
    namedArgs: Record<string, unknown> | undefined,
    unnamed: unknown,
    signal?: AbortSignal,
): Promise<string> {
    const { flags, text } = parseSideGenSlashInput(namedArgs, unnamed);
    if (!text) {
        throw new Error('/sidegen-once requires a prompt.');
    }

    const depth = parseOptionalDepth(flags.depth);
    const includeVars = parseIncludeVars(flags);
    const path = flags.path?.trim();
    const keywords = parseKeywords(flags.keywords);

    const opts: SideGenOnceOptions = {
        prompt: text,
        ...(flags.system ? { systemPrompt: flags.system } : {}),
        ...(flags.connection ? { connectionId: flags.connection } : {}),
        ...(depth !== undefined ? { mainChatDepth: depth } : {}),
        ...(includeVars !== undefined ? { includeVars } : {}),
        ...(path
            ? {
                  bridge: {
                      path,
                      delivery: parseDelivery(flags.delivery),
                      ...(flags.title ? { title: flags.title } : {}),
                      ...(keywords.length > 0 ? { keywords } : {}),
                      ...(flags.summary ? { summary: flags.summary } : {}),
                  },
              }
            : {}),
        ...(signal ? { signal } : {}),
    };

    const result = await sideGen.runOnce(opts);
    return result.text;
}

/**
 * Execute `/sidegen-send` with named args / `--flags` and user message text.
 * Automatically creates the named session when it does not exist yet.
 */
export async function dispatchSideGenSend(
    sideGen: ToolSideGenApi,
    namedArgs: Record<string, unknown> | undefined,
    unnamed: unknown,
    signal?: AbortSignal,
): Promise<string> {
    const { flags, text } = parseSideGenSlashInput(namedArgs, unnamed);
    const sessionId = flags.session?.trim();
    if (!sessionId) {
        throw new Error('/sidegen-send requires --session <sessionId>.');
    }
    if (!text) {
        throw new Error('/sidegen-send requires a prompt.');
    }

    const existing = await sideGen.getSession(sessionId);
    if (!existing) {
        const scope = parseScope(flags.scope);
        const path = flags.path?.trim();
        const keywords = parseKeywords(flags.keywords);
        const title = flags.title?.trim() || sessionId;
        await sideGen.createSession({
            id: sessionId,
            title,
            scope,
            systemPrompt: flags.system ?? '',
            ...(flags.connection ? { connectionId: flags.connection } : {}),
            ...(path
                ? {
                      autoBridge: {
                          path,
                          delivery: parseDelivery(flags.delivery),
                          keywords,
                          title,
                          mode: 'append',
                      },
                  }
                : {}),
        });
    }

    const depth = parseOptionalDepth(flags.depth);
    const includeVars = parseIncludeVars(flags);
    const result = await sideGen.send(sessionId, text, {
        ...(flags.connection ? { connectionId: flags.connection } : {}),
        ...(depth !== undefined ? { mainChatDepth: depth } : {}),
        ...(includeVars !== undefined ? { includeVars } : {}),
        ...(signal ? { signal } : {}),
    });
    return result.text;
}

/**
 * Execute `/sidegen-clue` actions: `list | read | write | delivery | status | export | delete`.
 */
export async function dispatchSideGenClue(
    sideGen: ToolSideGenApi,
    namedArgs: Record<string, unknown> | undefined,
    unnamed: unknown,
): Promise<string> {
    const { flags, text } = parseSideGenSlashInput(namedArgs, unnamed);
    const rawAction = (flags.action ?? 'list').trim().toLowerCase() as SideGenClueSlashAction;
    if (!VALID_CLUE_ACTIONS.has(rawAction)) {
        throw new Error(
            `Invalid --action "${flags.action ?? ''}". Expected one of: list, read, write, delivery, status, export, delete.`,
        );
    }

    const path = flags.path?.trim();

    switch (rawAction) {
        case 'list': {
            const clues = await sideGen.clues.list();
            return JSON.stringify(
                clues.map((c) => ({
                    path: c.path,
                    id: c.meta.id,
                    title: c.meta.title,
                    delivery: c.meta.delivery,
                    status: c.meta.status,
                    keywords: c.meta.keywords,
                    summary: c.meta.summary,
                })),
            );
        }

        case 'read': {
            if (!path) {
                throw new Error('/sidegen-clue --action read requires --path <vfsPath>.');
            }
            const clue = await sideGen.clues.read(path);
            return clue ? JSON.stringify(clue) : '';
        }

        case 'write': {
            if (!path) {
                throw new Error('/sidegen-clue --action write requires --path <vfsPath>.');
            }
            const keywords = parseKeywords(flags.keywords);
            const doc = await sideGen.clues.write({
                path,
                body: text,
                ...(flags.title ? { title: flags.title } : {}),
                ...(flags.delivery ? { delivery: parseDelivery(flags.delivery) } : {}),
                ...(flags.status ? { status: parseClueStatus(flags.status) } : {}),
                ...(keywords.length > 0 ? { keywords } : {}),
                ...(flags.summary ? { summary: flags.summary } : {}),
            });
            return JSON.stringify({
                path: doc.path,
                delivery: doc.meta.delivery,
                status: doc.meta.status,
                contentHash: doc.contentHash,
            });
        }

        case 'delivery': {
            if (!path) {
                throw new Error('/sidegen-clue --action delivery requires --path <vfsPath>.');
            }
            const delivery = parseDelivery(flags.delivery ?? text);
            const updated = await sideGen.clues.updateDelivery(path, delivery);
            return updated ? JSON.stringify({ path: updated.path, delivery: updated.meta.delivery }) : '';
        }

        case 'status': {
            if (!path) {
                throw new Error('/sidegen-clue --action status requires --path <vfsPath>.');
            }
            const status = parseClueStatus(flags.status ?? text);
            const updated = await sideGen.clues.updateStatus(path, status);
            return updated ? JSON.stringify({ path: updated.path, status: updated.meta.status }) : '';
        }

        case 'delete': {
            if (!path) {
                throw new Error('/sidegen-clue --action delete requires --path <vfsPath>.');
            }
            const deleted = await sideGen.clues.delete(path);
            return String(deleted);
        }

        case 'export': {
            if (!path) {
                throw new Error('/sidegen-clue --action export requires --path <vfsPath>.');
            }
            const keywords = parseKeywords(flags.keywords);
            const exported = await sideGen.clues.exportToWorldInfo(path, {
                ...(flags.book ? { bookName: flags.book } : {}),
                ...(flags.title ? { comment: flags.title } : {}),
                ...(keywords.length > 0 ? { keys: keywords } : {}),
            });
            return JSON.stringify(exported);
        }
    }
}

function makeNamedArg(
    name: string,
    description: string,
    type: string = ARGUMENT_TYPE?.STRING ?? 'string',
    enumList: string[] = [],
) {
    return SlashCommandNamedArgument.fromProps({
        name,
        description,
        typeList: [type],
        isRequired: false,
        ...(enumList.length > 0 ? { enumList } : {}),
    });
}

/**
 * Register native SillyTavern slash commands: `/sidegen-once`, `/sidegen-send`, and `/sidegen-clue`.
 */
export function registerSideGenSlashCommands(options: SideGenSlashOptions): SideGenSlashHandle {
    const { getSideGen, getAbortSignal } = options;
    const registeredNames: string[] = [];

    const registerCmd = (props: Record<string, unknown>) => {
        const command = SlashCommand.fromProps(props);
        SlashCommandParser.addCommandObject(command);
        if (typeof props.name === 'string') {
            registeredNames.push(props.name);
        }
    };

    const stringType = ARGUMENT_TYPE?.STRING ?? 'string';
    const numberType = ARGUMENT_TYPE?.NUMBER ?? 'number';

    registerCmd({
        name: SIDEGEN_SLASH_COMMANDS.ONCE,
        callback: async (namedArgs: Record<string, unknown>, unnamedArgs: unknown) =>
            dispatchSideGenOnce(
                requireSideGen(getSideGen),
                namedArgs,
                unnamedArgs,
                getAbortSignal?.(),
            ),
        namedArgumentList: [
            makeNamedArg('system', 'System prompt for the one-shot off-mainline generation', stringType),
            makeNamedArg('depth', 'Optional number of recent main-chat messages to attach read-only', numberType),
            makeNamedArg('connection', 'Optional API connection id', stringType),
            makeNamedArg('path', 'Optional /side/* VFS path to bridge output into', stringType),
            makeNamedArg('delivery', 'Side clue delivery policy', stringType, [
                'none',
                'vfs_only',
                'radar_hint',
                'next_turn_brief',
            ]),
            makeNamedArg('keywords', 'Comma-separated radar keywords for bridged clue', stringType),
            makeNamedArg('title', 'Title for bridged /side/* clue', stringType),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Prompt text (also accepts CLI-style --flag value options)',
                typeList: [stringType],
                isRequired: true,
            }),
        ],
        returns: 'Generated off-mainline text',
        helpString:
            'Run a stateless off-mainline generation without consuming main-chat context. Supports --system, --depth, --connection, --path, --delivery, --keywords, --title.',
    });

    registerCmd({
        name: SIDEGEN_SLASH_COMMANDS.SEND,
        callback: async (namedArgs: Record<string, unknown>, unnamedArgs: unknown) =>
            dispatchSideGenSend(
                requireSideGen(getSideGen),
                namedArgs,
                unnamedArgs,
                getAbortSignal?.(),
            ),
        namedArgumentList: [
            makeNamedArg('session', 'Persistent SideSession id (e.g. phone:linwan)', stringType),
            makeNamedArg('scope', 'Session scope: branch or chat', stringType, ['branch', 'chat']),
            makeNamedArg('system', 'System prompt used when creating a new session', stringType),
            makeNamedArg('path', 'Optional /side/* VFS path for autoBridge when creating a session', stringType),
            makeNamedArg('delivery', 'AutoBridge delivery policy', stringType, [
                'none',
                'vfs_only',
                'radar_hint',
                'next_turn_brief',
            ]),
            makeNamedArg('keywords', 'Comma-separated radar keywords for autoBridge', stringType),
            makeNamedArg('title', 'Optional title for new session / bridged clue', stringType),
            makeNamedArg('connection', 'Optional API connection id', stringType),
            makeNamedArg('depth', 'Optional number of recent main-chat messages to attach', numberType),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message to send to the persistent off-mainline session',
                typeList: [stringType],
                isRequired: true,
            }),
        ],
        returns: 'Assistant reply from the persistent SideSession',
        helpString:
            'Send a turn to a persistent KV-cache-friendly off-mainline SideSession (auto-creating it if needed). Supports --session, --scope, --system, --path, --delivery, --keywords.',
    });

    registerCmd({
        name: SIDEGEN_SLASH_COMMANDS.CLUE,
        callback: async (namedArgs: Record<string, unknown>, unnamedArgs: unknown) =>
            dispatchSideGenClue(requireSideGen(getSideGen), namedArgs, unnamedArgs),
        namedArgumentList: [
            makeNamedArg('action', 'Clue operation', stringType, [
                'list',
                'read',
                'write',
                'delivery',
                'status',
                'export',
                'delete',
            ]),
            makeNamedArg('path', 'Target /side/* VFS path', stringType),
            makeNamedArg('delivery', 'Side clue delivery policy', stringType, [
                'none',
                'vfs_only',
                'radar_hint',
                'next_turn_brief',
            ]),
            makeNamedArg('status', 'Side clue status', stringType, [
                'dormant',
                'surfaced',
                'resolved',
            ]),
            makeNamedArg('keywords', 'Comma-separated radar keywords', stringType),
            makeNamedArg('title', 'Clue title or exported World Info comment', stringType),
            makeNamedArg('summary', 'Compact summary shown in hints/briefs', stringType),
            makeNamedArg('book', 'Target World Info book name for export', stringType),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Optional clue body (for write) or value (for delivery/status)',
                typeList: [stringType],
                isRequired: false,
            }),
        ],
        returns: 'JSON-encoded clue result or status',
        helpString:
            'Inspect, update, or export /side/* clues. Supports --action list|read|write|delivery|status|export|delete, --path, --delivery, --keywords, --title.',
    });

    return {
        commands: registeredNames,
        dispose() {
            const commandsRegistry = SlashCommandParser?.commands as Record<string, unknown> | undefined;
            if (!commandsRegistry) {
                return;
            }
            for (const name of registeredNames) {
                delete commandsRegistry[name];
            }
        },
    };
}
