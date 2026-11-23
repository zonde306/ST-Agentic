import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    chromium,
    expect,
    test,
    type Browser,
    type BrowserContext,
    type Locator,
    type Page,
} from '@playwright/test';
import { stringify as stringifyYaml } from 'yaml';
import {
    createMockGate,
    makeStreamedToolCallScenario,
    makeWriteFileScenario,
    MockOpenAISseServer,
    type MockScenario,
    type RecordedLlmRequest,
} from './mock-sse-server';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');
const ST_ROOT = path.resolve(EXTENSION_ROOT, '..', '..', '..', '..', '..');
const DIST_BUNDLE_PATH = path.join(EXTENSION_ROOT, 'dist', 'index.js');

interface SerializedMessageLike {
    role?: string;
    content?: unknown;
    tool_call_id?: string;
    name?: string;
}

interface AgenticWindowBridge {
    Agentic?: {
        version: string;
        getSettings: () => {
            runMode: 'off' | 'companion' | 'takeover';
            currentConnectionId: string;
            connections: Record<
                string,
                {
                    id: string;
                    name: string;
                    baseUrl: string;
                    model: string;
                    stream: boolean;
                }
            >;
            currentPresetId: string;
            presets: Record<string, unknown>;
        };
        openConsole: (tab?: string, deepLink?: Record<string, unknown>) => void;
        closeConsole: () => void;
        sideGen: {
            createSession: (opts: {
                id?: string;
                title: string;
                scope?: 'branch' | 'chat';
                systemPrompt: string;
                connectionId?: string;
                autoBridge?: {
                    path: string;
                    delivery: 'none' | 'vfs_only' | 'radar_hint' | 'next_turn_brief';
                    keywords: string[];
                    title: string;
                    mode?: 'append' | 'replace';
                    summaryPrefix?: string;
                };
            }) => Promise<{ id: string; turns: number; scope: 'branch' | 'chat' }>;
            send: (
                sessionId: string,
                prompt: string,
                opts?: Record<string, unknown>,
            ) => Promise<{ text: string; sessionId?: string; bridgedPath?: string }>;
            getSession: (
                sessionId: string,
            ) => Promise<{ id: string; turns: number; scope: 'branch' | 'chat' } | null>;
            listSessions: () => Promise<Array<{ id: string; turns: number }>>;
            getTranscript: (
                sessionId: string,
            ) => Promise<Array<{ role: string; content: string }>>;
            clues: {
                write: (input: {
                    path: string;
                    body: string;
                    delivery?: 'none' | 'vfs_only' | 'radar_hint' | 'next_turn_brief';
                    title?: string;
                    keywords?: string[];
                    summary?: string;
                    status?: 'dormant' | 'surfaced' | 'resolved';
                }) => Promise<{
                    path: string;
                    body: string;
                    contentHash: string;
                    meta: {
                        delivery: string;
                        keywords: string[];
                        title: string;
                        summary?: string;
                        status: string;
                    };
                }>;
                read: (
                    path: string,
                    target?: { messageId: number; swipeId: number },
                ) => Promise<{
                    path: string;
                    body: string;
                    contentHash: string;
                    meta: {
                        delivery: string;
                        keywords: string[];
                        title: string;
                        summary?: string;
                        status: string;
                    };
                } | null>;
                list: (
                    target?: { messageId: number; swipeId: number },
                ) => Promise<Array<{ path: string; body: string }>>;
            };
        };
        assistant: {
            open: (sessionId?: string) => void;
            listSessions: () => Array<{
                id: string;
                mode: string;
                stAdminEnabled: boolean;
                autoApproveAuthor: boolean;
            }>;
            getSession: (sessionId: string) => {
                id: string;
                mode: string;
                stAdminEnabled: boolean;
                autoApproveAuthor: boolean;
            } | null;
            createSession: (opts?: Record<string, unknown>) => Promise<{ id: string }>;
            listPendingApprovals: (sessionId?: string) => Array<{
                id: string;
                toolName: string;
                status: string;
                mandatoryConfirm: boolean;
                undoId?: string;
            }>;
            listUndoHistory: (sessionId?: string) => Array<{
                id: string;
                toolName: string;
                reverted: boolean;
            }>;
        };
        uiStore: {
            updateSettings: (
                updater: (prev: Record<string, unknown>) => Record<string, unknown>,
            ) => Promise<unknown>;
            refreshAssistantState: () => Promise<void>;
        };
        bridge: {
            author?: {
                getPrimaryWorldName: () => Promise<string | null>;
                readWorldInfoBook: (bookName: string) => Promise<{
                    name: string;
                    entries: Array<{ uid: number; comment: string; content: string; keys: string[] }>;
                } | null>;
                upsertWorldInfoEntry: (
                    bookName: string,
                    entry: {
                        uid?: number;
                        comment?: string;
                        content: string;
                        keys: string[];
                    },
                    opts?: { rawDirect?: boolean },
                ) => Promise<{ uid: number; content: string }>;
                patchActiveCharacter: (fields: Record<string, unknown>) => Promise<unknown>;
            };
            admin?: {
                createWorldBook: (name: string) => Promise<{ name: string; entries: unknown[] }>;
                readHostSettings: (scope: string) => Promise<Record<string, unknown>>;
                patchHostSettings: (
                    scope: string,
                    patch: Record<string, unknown>,
                ) => Promise<Record<string, unknown>>;
            };
        };
    };
    SillyTavern?: {
        getContext?: () => {
            characterId?: string | number;
            groupId?: string | null;
            chat?: Array<{ mes?: string; is_user?: boolean; swipe_id?: number; swipes?: string[] }>;
            extensionPrompts?: Record<string, { value?: string; position?: number; depth?: number }>;
            extensionSettings?: Record<string, unknown>;
            eventSource?: {
                emit?: (event: string, ...args: unknown[]) => Promise<unknown> | unknown;
            };
            eventTypes?: Record<string, string>;
        };
    };
    chat?: Array<{ mes?: string; is_user?: boolean; swipe_id?: number; swipes?: string[] }>;
}

/** Reserve an available localhost TCP port for the isolated SillyTavern test server. */
async function getFreePort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            if (!addr || typeof addr === 'string') {
                srv.close();
                reject(new Error('Failed to bind ephemeral TCP port'));
                return;
            }
            const port = addr.port;
            srv.close((err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(port);
            });
        });
    });
}

/** Write isolated SillyTavern `config.yaml` and pre-seeded `default-user/settings.json` in tmpdir. */
async function prepareIsolatedStWorkspace(
    tmpRoot: string,
    stPort: number,
    mockV1Url: string,
): Promise<{ configPath: string; dataRoot: string }> {
    const configPath = path.join(tmpRoot, 'config.yaml');
    const dataRoot = path.join(tmpRoot, 'data');
    const defaultUserDir = path.join(dataRoot, 'default-user');
    await fsp.mkdir(defaultUserDir, { recursive: true });

    const baseConfig = {
        port: stPort,
        listen: false,
        whitelistMode: false,
        basicAuthMode: false,
        enableUserAccounts: false,
        disableCsrfProtection: true,
        skipContentCheck: true,
        browserLaunch: { enabled: false },
        cors: { enabled: true },
        extensions: { enabled: true, autoUpdate: false },
        logging: { minLogLevel: 2 },
    };
    await fsp.writeFile(configPath, stringifyYaml(baseConfig), 'utf-8');

    const charactersDir = path.join(defaultUserDir, 'characters');
    const avatarsDir = path.join(defaultUserDir, 'User Avatars');
    const themesDir = path.join(defaultUserDir, 'themes');
    await fsp.mkdir(charactersDir, { recursive: true });
    await fsp.mkdir(avatarsDir, { recursive: true });
    await fsp.mkdir(themesDir, { recursive: true });
    await fsp.mkdir(path.join(dataRoot, '_css'), { recursive: true });

    const essentialCopies: Array<[string, string]> = [
        [
            path.join(ST_ROOT, 'default', 'content', 'default_Seraphina.png'),
            path.join(charactersDir, 'default_Seraphina.png'),
        ],
        [
            path.join(ST_ROOT, 'default', 'content', 'user-default.png'),
            path.join(avatarsDir, 'user-default.png'),
        ],
        [
            path.join(ST_ROOT, 'default', 'content', 'themes', 'Dark Lite.json'),
            path.join(themesDir, 'Dark Lite.json'),
        ],
        [
            path.join(ST_ROOT, 'default', 'content', 'user.css'),
            path.join(dataRoot, '_css', 'user.css'),
        ],
    ];
    for (const [src, dst] of essentialCopies) {
        if (fs.existsSync(src)) {
            await fsp.copyFile(src, dst);
        }
    }

    const stWebpackCache = path.join(ST_ROOT, 'data', '_webpack');
    if (fs.existsSync(stWebpackCache)) {
        await fsp.cp(stWebpackCache, path.join(dataRoot, '_webpack'), { recursive: true });
    }

    const defaultSettingsPath = path.join(ST_ROOT, 'default', 'content', 'settings.json');
    const rawSettings = await fsp.readFile(defaultSettingsPath, 'utf-8');
    const settings = JSON.parse(rawSettings) as Record<string, unknown>;
    const existingOai =
        settings.oai_settings && typeof settings.oai_settings === 'object'
            ? (settings.oai_settings as Record<string, unknown>)
            : {};
    const existingPowerUser =
        settings.power_user && typeof settings.power_user === 'object'
            ? (settings.power_user as Record<string, unknown>)
            : {};

    const thirdPartyDir = path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party');
    const disabledExtensions: string[] = [];
    if (fs.existsSync(thirdPartyDir)) {
        for (const entry of fs.readdirSync(thirdPartyDir, { withFileTypes: true })) {
            if (entry.isDirectory() && entry.name !== 'ST-Agentic') {
                disabledExtensions.push(`third-party/${entry.name}`);
            }
        }
    }

    settings.firstRun = false;
    settings.main_api = 'openai';
    settings.active_character = 'default_Seraphina.png';
    settings.extension_settings = {
        disabledExtensions,
    };
    settings.power_user = {
        ...existingPowerUser,
        auto_connect: true,
        auto_load_chat: true,
    };
    settings.oai_settings = {
        ...existingOai,
        chat_completion_source: 'custom',
        custom_url: mockV1Url,
        custom_model: 'mock-gpt',
        stream_openai: true,
        show_thoughts: true,
        bypass_status_check: true,
    };

    await fsp.writeFile(
        path.join(defaultUserDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
        'utf-8',
    );

    return { configPath, dataRoot };
}

/** Terminate SillyTavern process tree reliably across Windows and POSIX platforms. */
async function stopChildProcessTree(proc: ChildProcess | undefined): Promise<void> {
    if (!proc || proc.pid === undefined || proc.exitCode !== null) {
        return;
    }

    const exited = new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
    });

    try {
        proc.kill('SIGTERM');
    } catch {
        // Ignore ESRCH if already exited.
    }

    const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 3000)),
    ]);

    if (timedOut && proc.exitCode === null) {
        if (process.platform === 'win32') {
            try {
                execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
                    stdio: 'ignore',
                });
            } catch {
                // Ignore if process disappeared concurrently.
            }
        } else {
            try {
                proc.kill('SIGKILL');
            } catch {
                // Ignore.
            }
        }
        await Promise.race([
            exited,
            new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
    }
}

/** Spawn isolated SillyTavern server and poll until HTTP responds cleanly. */
async function startIsolatedSillyTavern(params: {
    configPath: string;
    dataRoot: string;
    port: number;
}): Promise<{ proc: ChildProcess; baseUrl: string; logs: string[] }> {
    const logs: string[] = [];
    const args = [
        path.join(ST_ROOT, 'server.js'),
        '--configPath',
        params.configPath,
        '--dataRoot',
        params.dataRoot,
        '--port',
        String(params.port),
        '--browserLaunchEnabled',
        'false',
        '--whitelist',
        'false',
        '--basicAuthMode',
        'false',
        '--disableCsrf',
        'true',
    ];

    const proc = spawn(process.execPath, args, {
        cwd: ST_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            NODE_ENV: 'test',
        },
    });

    const recordLog = (chunk: Buffer) => {
        logs.push(chunk.toString('utf-8'));
        if (logs.length > 200) {
            logs.shift();
        }
    };
    proc.stdout?.on('data', recordLog);
    proc.stderr?.on('data', recordLog);

    const baseUrl = `http://127.0.0.1:${params.port}`;
    const deadline = Date.now() + 120_000;

    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            throw new Error(
                `SillyTavern exited early with code ${proc.exitCode}:\n${logs.join('')}`,
            );
        }
        try {
            const res = await fetch(`${baseUrl}/api/ping`, { method: 'POST' });
            if (res.status === 204 || res.ok) {
                return { proc, baseUrl, logs };
            }
        } catch {
            // Server is still binding HTTP listener.
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    await stopChildProcessTree(proc);
    throw new Error(`Timed out waiting for SillyTavern server on ${baseUrl}:\n${logs.join('')}`);
}

/** Build the final plain-text internal review completion round for `main_turn`. */
function makeMainTurnFinishScenario(internalSummary = 'Internal review passed.'): MockScenario {
    return {
        chunks: [{ content: internalSummary, delayMs: 5 }],
        finishReason: 'stop',
        usage: {
            prompt_tokens: 260,
            completion_tokens: 14,
            total_tokens: 274,
            prompt_tokens_details: {
                cached_tokens: 200,
            },
        },
    };
}

/** Extract readable string text from an OpenAI-format message `content` field. */
function stringifyMessageContent(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (part && typeof part === 'object' && 'text' in part) {
                    return String((part as { text?: unknown }).text ?? '');
                }
                return JSON.stringify(part);
            })
            .join('\n');
    }
    if (content === null || content === undefined) {
        return '';
    }
    return JSON.stringify(content);
}

/** Extract `messages` array from a `RecordedLlmRequest`. */
function getRequestMessages(req: RecordedLlmRequest): SerializedMessageLike[] {
    return Array.isArray(req.body.messages)
        ? (req.body.messages as SerializedMessageLike[])
        : [];
}

/** Wait until `#send_but` is visible/enabled and `#mes_stop` is hidden. */
async function waitForSendButtonUnlocked(targetPage: Page, timeoutMs = 15_000): Promise<void> {
    await targetPage.waitForFunction(
        () => {
            const sendBtn = document.querySelector('#send_but') as HTMLElement | null;
            const stopBtn = document.querySelector('#mes_stop') as HTMLElement | null;
            return (
                sendBtn !== null
                && !sendBtn.classList.contains('displayNone')
                && getComputedStyle(sendBtn).display !== 'none'
                && sendBtn.getAttribute('disabled') === null
                && (!stopBtn || getComputedStyle(stopBtn).display === 'none')
            );
        },
        undefined,
        { timeout: timeoutMs },
    );
}

/** Wait until the last `.mes` `<agentic-capsule>` reaches `expectedStatus`. */
async function waitForLastCapsuleStatus(
    targetPage: Page,
    expectedStatus: string,
    timeoutMs = 15_000,
): Promise<void> {
    await targetPage.waitForFunction(
        (status) => {
            const cap = document.querySelector('#chat .mes:last-of-type agentic-capsule');
            const current = cap?.shadowRoot?.querySelector('.cap-shell')?.getAttribute('data-status');
            return current === status;
        },
        expectedStatus,
        { timeout: timeoutMs },
    );
}

/** Wait until `locator.innerText()` includes `expected`. */
async function waitForLocatorText(
    locator: Locator,
    expected: string,
    timeoutMs = 15_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastText = '';
    while (Date.now() < deadline) {
        try {
            if ((await locator.count()) > 0) {
                lastText = await locator.innerText();
                if (lastText.includes(expected)) {
                    return lastText;
                }
            }
        } catch {
            // Element may be mid-rerender during streaming or swipe transitions.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for text ${JSON.stringify(expected)}; last seen: ${JSON.stringify(lastText)}`,
    );
}

/** Send a chat message through SillyTavern's real input box and send button. */
async function sendChatText(targetPage: Page, text: string): Promise<void> {
    const input = targetPage.locator('#send_textarea');
    await input.fill(text);
    await targetPage.locator('#send_but').click();
}

/** Close `#agentic-app` dialog if currently open. */
async function closeConsoleIfOpen(targetPage: Page): Promise<void> {
    const dialog = targetPage.locator('dialog#agentic-app');
    if (await dialog.evaluate((el) => (el as HTMLDialogElement).open).catch(() => false)) {
        const closeBtn = dialog.locator('button[aria-label="关闭控制台"]');
        if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click({ timeout: 5000 });
        } else {
            await targetPage.evaluate(() =>
                (window as unknown as AgenticWindowBridge).Agentic?.closeConsole(),
            );
        }
        await targetPage.waitForFunction(
            () => !(document.querySelector('dialog#agentic-app') as HTMLDialogElement | null)?.open,
            undefined,
            { timeout: 5000 },
        );
    }
}

test.describe('ST-Agentic Off-Mainline E2E Golden Paths against Real SillyTavern', () => {
    test.describe.configure({ mode: 'serial', timeout: 90_000 });

    let tmpRoot = '';
    let mockServer: MockOpenAISseServer | undefined;
    let stProc: ChildProcess | undefined;
    let stBaseUrl = '';
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page;
    const pageErrors: string[] = [];

    /** Wait for ST preloader, Agentic extension mount, active character chat, and `#send_but`. */
    async function waitForStAndAgenticReady(targetPage: Page): Promise<void> {
        await targetPage.waitForFunction(
            () => {
                const win = window as unknown as AgenticWindowBridge;
                const preloader = document.querySelector('#preloader') as HTMLElement | null;
                const preloaderGone =
                    !preloader || getComputedStyle(preloader).display === 'none' || preloader.hidden;
                return Boolean(
                    win.Agentic
                    && win.Agentic.version
                    && win.Agentic.sideGen
                    && win.Agentic.assistant
                    && preloaderGone,
                );
            },
            undefined,
            { timeout: 30_000 },
        );

        await targetPage.waitForSelector('#extensions_settings [data-agentic-settings-mount]', {
            state: 'attached',
            timeout: 15_000,
        });

        const stPopupOk = targetPage.locator('dialog.popup[open] .popup-button-ok').first();
        if (await stPopupOk.isVisible().catch(() => false)) {
            await stPopupOk.click().catch(() => undefined);
        }

        await targetPage.waitForFunction(
            () => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return (
                    (stCtx?.characterId !== undefined && document.querySelectorAll('#chat .mes').length > 0)
                    || document.querySelectorAll('.character_select').length > 0
                );
            },
            undefined,
            { timeout: 15_000 },
        );

        const hasCharacterLoaded = await targetPage.evaluate(
            () => (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.().characterId !== undefined,
        );
        if (!hasCharacterLoaded) {
            const charCard = targetPage.locator('.character_select').first();
            if (!(await charCard.isVisible().catch(() => false))) {
                const navDrawerIcon = targetPage.locator('#rightNavDrawerIcon');
                if (await navDrawerIcon.isVisible().catch(() => false)) {
                    await navDrawerIcon.click();
                }
                const charListBtn = targetPage.locator('#rm_button_characters');
                if (await charListBtn.isVisible().catch(() => false)) {
                    await charListBtn.click();
                }
            }
            await charCard.waitFor({ state: 'visible', timeout: 10_000 });
            await charCard.click();
        }

        await targetPage.waitForFunction(
            () => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return (
                    stCtx?.characterId !== undefined
                    && Boolean(document.querySelector('#chat .mes[mesid="0"]'))
                );
            },
            undefined,
            { timeout: 15_000 },
        );

        await targetPage.waitForFunction(
            () => {
                const sendBtn = document.querySelector('#send_but');
                const apiStatus = document.querySelector('#API-status-top');
                return (
                    Boolean(sendBtn)
                    && !sendBtn?.classList.contains('displayNone')
                    && Boolean(apiStatus?.classList.contains('fa-plug'))
                );
            },
            undefined,
            { timeout: 15_000 },
        );
    }

    /** Configure ST-Agentic default connection to MockOpenAISseServer and set `runMode`. */
    async function configureAgenticConnectionAndMode(
        targetPage: Page,
        v1Url: string,
        runMode: 'off' | 'companion' | 'takeover',
    ): Promise<void> {
        await targetPage.evaluate(
            async ({ endpoint, mode }) => {
                const win = window as unknown as AgenticWindowBridge;
                await win.Agentic?.uiStore.updateSettings((prev) => {
                    const currentConnectionId = String(prev.currentConnectionId ?? 'conn_default');
                    const prevConns = (prev.connections ?? {}) as Record<string, Record<string, unknown>>;
                    const prevConn = prevConns[currentConnectionId] ?? {
                        id: currentConnectionId,
                        name: 'Mock E2E',
                        provider: 'openai',
                    };
                    return {
                        ...prev,
                        runMode: mode,
                        connections: {
                            ...prevConns,
                            [currentConnectionId]: {
                                ...prevConn,
                                id: currentConnectionId,
                                name: 'Mock E2E',
                                provider: 'openai',
                                baseUrl: endpoint,
                                model: 'mock-gpt',
                                apiKey: 'sk-mock-e2e-conn-key',
                                stream: true,
                            },
                        },
                    };
                });
            },
            { endpoint: v1Url, mode: runMode },
        );
    }

    test.beforeAll(async () => {
        test.setTimeout(150_000);
        expect(fs.existsSync(DIST_BUNDLE_PATH)).toBe(true);

        mockServer = await MockOpenAISseServer.start();
        const stPort = await getFreePort();
        tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-agentic-offmain-e2e-'));

        const { configPath, dataRoot } = await prepareIsolatedStWorkspace(
            tmpRoot,
            stPort,
            mockServer.v1Url,
        );

        const started = await startIsolatedSillyTavern({
            configPath,
            dataRoot,
            port: stPort,
        });
        stProc = started.proc;
        stBaseUrl = started.baseUrl;

        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        page = await context.newPage();

        page.on('pageerror', (err) => {
            pageErrors.push(`pageerror: ${err.stack ?? err.message}`);
        });
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                const text = msg.text();
                if (/agentic|dist\/index\.js/i.test(text)) {
                    pageErrors.push(`console.error: ${text}`);
                }
            }
        });

        await page.goto(stBaseUrl, { waitUntil: 'domcontentloaded' });
        await waitForStAndAgenticReady(page);
        await configureAgenticConnectionAndMode(page, mockServer.v1Url, 'takeover');
    });

    test.afterEach(async () => {
        if (page && !page.isClosed()) {
            await Promise.race([
                closeConsoleIfOpen(page).catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 3000)),
            ]);
        }
    });

    test.afterAll(async () => {
        try {
            await page?.close().catch(() => undefined);
            await context?.close().catch(() => undefined);
            await browser?.close().catch(() => undefined);
        } finally {
            await stopChildProcessTree(stProc);
            await mockServer?.close().catch(() => undefined);
            if (tmpRoot) {
                for (let attempt = 0; attempt < 4; attempt += 1) {
                    try {
                        await fsp.rm(tmpRoot, { recursive: true, force: true });
                        break;
                    } catch {
                        await new Promise((resolve) => setTimeout(resolve, 250));
                    }
                }
            }
        }
    });

    test('GP-1: SideGen -> /side/* -> TailRadar on-demand <side-hint> trigger & Read-Set dedup', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        // 1. Create persistent SideSession & send a turn auto-bridged to /side/comms/linwan.md
        mockServer.enqueue({
            nonStreamContent: '别去老码头，三号仓今晚有埋伏。',
            finishReason: 'stop',
        });

        const sideResult = await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            const sg = win.Agentic!.sideGen;
            await sg.createSession({
                id: 'phone:linwan',
                title: '林晚加密短信',
                scope: 'branch',
                systemPrompt: '你是林晚，只通过加密短信发送简短线报。',
                autoBridge: {
                    path: '/side/comms/linwan.md',
                    delivery: 'radar_hint',
                    keywords: ['老码头', '林晚'],
                    title: '林晚来信',
                    mode: 'append',
                },
            });
            const sent = await sg.send('phone:linwan', '今晚碰头地点安全吗？');
            const clue = await sg.clues.read('/side/comms/linwan.md');
            return { sent, clue };
        });

        expect(sideResult.sent.bridgedPath).toBe('/side/comms/linwan.md');
        expect(sideResult.clue).not.toBeNull();
        expect(sideResult.clue?.meta.delivery).toBe('radar_hint');
        expect(sideResult.clue?.meta.keywords).toEqual(expect.arrayContaining(['老码头', '林晚']));
        expect(sideResult.clue?.body).toContain('三号仓今晚有埋伏');

        // 2. Mainline Turn 1 (unmentioned keywords): ZERO /side/comms/linwan.md or <side-hint> injection
        mockServer.clearRequests();
        mockServer.enqueue([
            makeWriteFileScenario('/output.md', '今天天气晴朗，我们在酒馆喝茶歇息。'),
            makeMainTurnFinishScenario('Turn 1 review ok.'),
        ]);

        await sendChatText(page, '今天天气真不错，我们先在酒馆喝杯茶。');
        await waitForLocatorText(
            page.locator('#chat .mes').last().locator('.mes_text'),
            '今天天气晴朗，我们在酒馆喝茶歇息。',
            15_000,
        );
        await waitForLastCapsuleStatus(page, 'done', 15_000);
        await waitForSendButtonUnlocked(page, 10_000);

        const turn1BrowserReqs = mockServer.requests.filter((r) => r.origin === 'browser');
        expect(turn1BrowserReqs.length).toBeGreaterThanOrEqual(2);
        const turn1Msgs = getRequestMessages(turn1BrowserReqs[0]);
        const turn1Serialized = JSON.stringify(turn1Msgs);
        expect(turn1Serialized).not.toContain('<side-hint>');
        expect(turn1Serialized).not.toContain('/side/comms/linwan.md');
        const turn1Layer0Prefix = turn1Msgs.slice(0, Math.max(1, turn1Msgs.length - 1));

        // 3. Mainline Turn 2 (user mentions keyword "老码头"): <side-hint> activates in Layer 2,
        //    Layer 0/1 remain intact, and mainline reads /side/comms/linwan.md updating Read-Set.
        mockServer.clearRequests();
        mockServer.enqueue([
            makeStreamedToolCallScenario(
                'read_file',
                { path: '/side/comms/linwan.md' },
                { callId: 'call_gp1_read_side' },
            ),
            makeWriteFileScenario('/output.md', '我记起来了，老码头三号仓今晚有埋伏！'),
            makeMainTurnFinishScenario('Turn 2 review ok.'),
        ]);

        await sendChatText(page, '今晚我打算去老码头那边看看。');
        await waitForLocatorText(
            page.locator('#chat .mes').last().locator('.mes_text'),
            '我记起来了，老码头三号仓今晚有埋伏！',
            15_000,
        );
        await waitForLastCapsuleStatus(page, 'done', 15_000);
        await waitForSendButtonUnlocked(page, 10_000);

        const turn2BrowserReqs = mockServer.requests.filter((r) => r.origin === 'browser');
        expect(turn2BrowserReqs.length).toBeGreaterThanOrEqual(3);

        const turn2Round1Msgs = getRequestMessages(turn2BrowserReqs[0]);
        // Layer 0 prefix stays intact (append-only KV invariance).
        expect(turn2Round1Msgs.slice(0, turn1Layer0Prefix.length)).toEqual(turn1Layer0Prefix);

        // Layer 2 (last user message) receives <side-hint> referencing /side/comms/linwan.md.
        const turn2Layer2Msg = turn2Round1Msgs[turn2Round1Msgs.length - 1];
        expect(turn2Layer2Msg?.role).toBe('user');
        const turn2Layer2Text = stringifyMessageContent(turn2Layer2Msg?.content);
        expect(turn2Layer2Text).toContain('<side-hint>');
        expect(turn2Layer2Text).toContain('/side/comms/linwan.md');
        expect(turn2Layer2Text).toContain('老码头');

        // Earlier historical messages (Layer 0 + Turn 1 Layer 1) remain free of <side-hint>.
        const turn2HistoryBeforeLayer2 = JSON.stringify(turn2Round1Msgs.slice(0, -1));
        expect(turn2HistoryBeforeLayer2).not.toContain('<side-hint>');

        // Round 2 tool result proves mainline read the real /side/comms/linwan.md content.
        const turn2Round2Msgs = getRequestMessages(turn2BrowserReqs[1]);
        const readToolMsg = turn2Round2Msgs.find(
            (m) => m.role === 'tool' && m.tool_call_id === 'call_gp1_read_side',
        );
        expect(stringifyMessageContent(readToolMsg?.content)).toContain('三号仓今晚有埋伏');

        // 4. Mainline Turn 3 (same keyword "老码头", unchanged clue): <side-hint> is 100% silent!
        mockServer.clearRequests();
        mockServer.enqueue([
            makeWriteFileScenario('/output.md', '明白，避开老码头，改走北门。'),
            makeMainTurnFinishScenario('Turn 3 review ok.'),
        ]);

        await sendChatText(page, '那老码头就不去了，我们改走北门吧。');
        await waitForLocatorText(
            page.locator('#chat .mes').last().locator('.mes_text'),
            '明白，避开老码头，改走北门。',
            15_000,
        );
        await waitForLastCapsuleStatus(page, 'done', 15_000);
        await waitForSendButtonUnlocked(page, 10_000);

        const turn3BrowserReqs = mockServer.requests.filter((r) => r.origin === 'browser');
        expect(turn3BrowserReqs.length).toBeGreaterThanOrEqual(2);
        const turn3Round1Msgs = getRequestMessages(turn3BrowserReqs[0]);
        const turn3Layer2Msg = turn3Round1Msgs[turn3Round1Msgs.length - 1];
        expect(turn3Layer2Msg?.role).toBe('user');
        const turn3Layer2Text = stringifyMessageContent(turn3Layer2Msg?.content);
        expect(turn3Layer2Text).toContain('改走北门');
        expect(turn3Layer2Text).not.toContain('<side-hint>');
        expect(turn3Layer2Text).not.toContain('/side/comms/linwan.md');
    });

    test('GP-2: Causal branch isolation across swipes rolls back branch SideSession & /side/* clues', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        const targetMesId = await page.evaluate(() =>
            Number(document.querySelector('#chat .mes:last-of-type')?.getAttribute('mesid') ?? -1),
        );
        expect(targetMesId).toBeGreaterThanOrEqual(1);

        // 1. Create Swipe B (swipeId = 1) on the latest assistant message via real .swipe_right click.
        mockServer.enqueue([
            makeWriteFileScenario('/output.md', '分支 B 剧情：我们转向钟楼探查。'),
            makeMainTurnFinishScenario('Swipe B review ok.'),
        ]);

        const lastMes = page.locator('#chat .mes').last();
        await lastMes.hover();
        await lastMes.locator('.swipe_right').click();

        await waitForLocatorText(
            lastMes.locator('.mes_text'),
            '分支 B 剧情：我们转向钟楼探查。',
            15_000,
        );
        await waitForLastCapsuleStatus(page, 'done', 15_000);
        await waitForSendButtonUnlocked(page, 10_000);
        await page.waitForFunction(
            (id) => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return stCtx?.chat?.[id]?.swipe_id === 1;
            },
            targetMesId,
            { timeout: 10_000 },
        );

        // 2. Under Swipe B, run a `scope: 'branch'` SideSession turn + write a branch-only /side/* clue.
        mockServer.clearRequests();
        mockServer.enqueue({
            nonStreamContent: '分支B独占情报：钟楼地下藏有秘密通道。',
            finishReason: 'stop',
        });

        const swipeBState = await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            const sg = win.Agentic!.sideGen;
            await sg.createSession({
                id: 'branch:clocktower',
                title: '钟楼线外密谈',
                scope: 'branch',
                systemPrompt: '你是线人，提供钟楼暗道线索。',
                autoBridge: {
                    path: '/side/notes/swipe-b-clue.md',
                    delivery: 'radar_hint',
                    keywords: ['钟楼', '密道'],
                    title: '分支B钟楼密道',
                    mode: 'replace',
                },
            });
            const sent = await sg.send('branch:clocktower', '钟楼下面有什么？');
            const session = await sg.getSession('branch:clocktower');
            const transcript = await sg.getTranscript('branch:clocktower');
            const clue = await sg.clues.read('/side/notes/swipe-b-clue.md');
            return { sent, session, transcript, clue };
        });

        expect(swipeBState.sent.bridgedPath).toBe('/side/notes/swipe-b-clue.md');
        expect(swipeBState.session?.turns).toBe(1);
        expect(
            swipeBState.transcript.some((entry) => entry.content.includes('钟楼地下藏有秘密通道')),
        ).toBe(true);
        expect(swipeBState.clue?.body).toContain('钟楼地下藏有秘密通道');

        // 3. Switch back to Swipe A (swipeId = 0) via real .swipe_left click.
        await lastMes.hover();
        await lastMes.locator('.swipe_left').click();

        await waitForLocatorText(
            lastMes.locator('.mes_text'),
            '明白，避开老码头，改走北门。',
            10_000,
        );
        await page.waitForFunction(
            (id) => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return stCtx?.chat?.[id]?.swipe_id === 0;
            },
            targetMesId,
            { timeout: 10_000 },
        );

        // Wait until SideSessionStore branch rollback completes on MESSAGE_SWIPED.
        await page.waitForFunction(
            async () => {
                const win = window as unknown as AgenticWindowBridge;
                const sess = await win.Agentic?.sideGen.getSession('branch:clocktower');
                return sess?.turns === 0;
            },
            undefined,
            { timeout: 10_000 },
        );

        const swipeAState = await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            const sg = win.Agentic!.sideGen;
            const session = await sg.getSession('branch:clocktower');
            const transcript = await sg.getTranscript('branch:clocktower');
            const swipeBClue = await sg.clues.read('/side/notes/swipe-b-clue.md');
            const allClues = await sg.clues.list();
            const ancestorClue = await sg.clues.read('/side/comms/linwan.md');
            return { session, transcript, swipeBClue, allClues, ancestorClue };
        });

        // Branch-scoped SideSession & /side/* clue rolled back cleanly without leaking into Swipe A.
        expect(swipeAState.session?.turns).toBe(0);
        expect(
            swipeAState.transcript.some((entry) => entry.content.includes('钟楼地下藏有秘密通道')),
        ).toBe(false);
        expect(swipeAState.swipeBClue).toBeNull();
        expect(swipeAState.allClues.some((c) => c.path === '/side/notes/swipe-b-clue.md')).toBe(false);
        // Ancestor clue created before Swipe B remains intact on Swipe A.
        expect(swipeAState.ancestorClue?.body).toContain('三号仓今晚有埋伏');
    });

    test('GP-3: Author mode raw @@ / <% %> EJS + inline bubble approval + Undo restores primary World Info', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        const bookName = 'E2E_Primary_Author_Book';
        const baselineContent = 'ORIGINAL_BASELINE_WI_TEXT';
        const rawAuthorContent = [
            '@@system',
            '@@depth 2',
            '<% if (getvar("gold") > 0) { %>',
            '玩家持有金币：<%- getvar("gold") %>',
            '<% } %>',
        ].join('\n');

        // 1. Seed a real SillyTavern primary World Info book bound to the active character.
        const seededPrimary = await page.evaluate(
            async ({ name, baseline }) => {
                const win = window as unknown as AgenticWindowBridge;
                const bridge = win.Agentic!.bridge;
                await bridge.admin!.createWorldBook(name);
                await bridge.author!.upsertWorldInfoEntry(
                    name,
                    {
                        uid: 0,
                        comment: 'Rule Baseline',
                        keys: ['rules'],
                        content: baseline,
                    },
                    { rawDirect: true },
                );
                await bridge.author!.patchActiveCharacter({
                    extensions: { world: name },
                });
                const primary = await bridge.author!.getPrimaryWorldName();
                const book = await bridge.author!.readWorldInfoBook(name);
                return { primary, entry0: book?.entries.find((e) => e.uid === 0) ?? null };
            },
            { name: bookName, baseline: baselineContent },
        );

        expect(seededPrimary.primary).toBe(bookName);
        expect(seededPrimary.entry0?.content).toBe(baselineContent);

        // 2. Open Assistant Workbench via globalThis.Agentic.assistant.open() and switch to `author` mode.
        await page.evaluate(() => {
            (window as unknown as AgenticWindowBridge).Agentic!.assistant.open();
        });

        const dialog = page.locator('dialog#agentic-app');
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.locator('[data-view-id="assistant"]').waitFor({ state: 'visible', timeout: 10_000 });

        await dialog.locator('[data-assistant-new-session-btn="true"]').click();
        await dialog.locator('[data-assistant-mode-btn="true"]').waitFor({ state: 'visible', timeout: 5000 });
        await dialog.locator('[data-assistant-mode-btn="true"]').click();
        await dialog.locator('[data-assistant-popover="mode"]').waitFor({ state: 'visible', timeout: 5000 });
        await dialog.locator('[data-assistant-mode-option="author"]').click();
        // Close mode popover before typing.
        await dialog.locator('[data-assistant-popover-backdrop="true"]').click();

        // 3. Mock SSE returns `wi_upsert_primary_entry` with raw @@system + <% ... %> EJS.
        mockServer.enqueue(
            makeStreamedToolCallScenario(
                'wi_upsert_primary_entry',
                {
                    uid: 0,
                    comment: 'Dynamic EJS System Rule',
                    keys: ['rules', 'gold'],
                    content: rawAuthorContent,
                },
                {
                    callId: 'call_gp3_wi_upsert',
                    content: '已生成主世界书条目 #0 的修改方案，请确认 Diff：',
                },
            ),
        );

        await dialog
            .locator('[data-assistant-draft-input="true"]')
            .fill('把主世界书条目 #0 改为带 @@system 和 EJS 条件金币展示的规则。');
        await dialog.locator('[data-assistant-send-btn="true"]').click();

        // 4. Verify inline approval card appears inside the AI bubble with Diff preview.
        const pendingCard = dialog.locator('[data-approval-status="pending"]').first();
        await pendingCard.waitFor({ state: 'visible', timeout: 15_000 });
        const diffBox = pendingCard.locator('[data-approval-diff="true"]');
        const diffText = await diffBox.innerText();
        expect(diffText).toContain('@@system');
        expect(diffText).toContain('<% if (getvar("gold") > 0) { %>');
        expect(diffText).toContain(baselineContent);

        // Before approval, real primary World Info MUST remain unmodified.
        const beforeAcceptContent = await page.evaluate(async (name) => {
            const win = window as unknown as AgenticWindowBridge;
            const book = await win.Agentic!.bridge.author!.readWorldInfoBook(name);
            return book?.entries.find((e) => e.uid === 0)?.content ?? null;
        }, bookName);
        expect(beforeAcceptContent).toBe(baselineContent);

        // 5. Click `✓ 接受` -> verify auto-collapse AND raw verbatim persistence (NO \@@ escaping!).
        await pendingCard.locator('[data-approval-approve-btn]').click();
        const approvedCollapsed = dialog
            .locator('[data-approval-collapsed="true"][data-approval-status="approved"]')
            .first();
        await approvedCollapsed.waitFor({ state: 'visible', timeout: 15_000 });

        const afterAcceptContent = await page.evaluate(async (name) => {
            const win = window as unknown as AgenticWindowBridge;
            const book = await win.Agentic!.bridge.author!.readWorldInfoBook(name);
            return book?.entries.find((e) => e.uid === 0)?.content ?? null;
        }, bookName);

        expect(afterAcceptContent).toBe(rawAuthorContent);
        expect(afterAcceptContent).toContain('@@system');
        expect(afterAcceptContent).toContain('<% if (getvar("gold") > 0) { %>');
        expect(afterAcceptContent).not.toContain('\\@@');
        expect(afterAcceptContent).not.toContain('@@@');

        // 6. Click `↩ 撤销` -> verify primary World Info entry #0 is restored to pre-write baseline.
        const undoBtn = approvedCollapsed.locator('[data-approval-undo-btn]');
        await undoBtn.waitFor({ state: 'visible', timeout: 5000 });
        await undoBtn.click();
        await waitForLocatorText(undoBtn, '已还原', 10_000);

        const afterUndoContent = await page.evaluate(async (name) => {
            const win = window as unknown as AgenticWindowBridge;
            const book = await win.Agentic!.bridge.author!.readWorldInfoBook(name);
            return book?.entries.find((e) => e.uid === 0)?.content ?? null;
        }, bookName);
        expect(afterUndoContent).toBe(baselineContent);

        await closeConsoleIfOpen(page);
    });

    test('GP-4: ST Admin red lines — secret redaction (***REDACTED***) and non-bypassable mandatoryConfirm', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        const rawApiKey = 'sk-live-super-secret-e2e-99999';
        const rawBearer = 'Bearer eyJ-secret-jwt-token-e2e-xyz';
        const initialSafeLabel = 'initial-safe-label';
        const patchedSafeLabel = 'patched-after-mandatory-confirm';

        // 1. Seed a real extension_settings bucket containing secrets + a safe field.
        await page.evaluate(
            async ({ apiKey, authToken, safeLabel }) => {
                const win = window as unknown as AgenticWindowBridge;
                await win.Agentic!.bridge.admin!.patchHostSettings('e2e_secret_probe', {
                    apiKey,
                    authToken,
                    safeLabel,
                });
            },
            { apiKey: rawApiKey, authToken: rawBearer, safeLabel: initialSafeLabel },
        );

        // 2. Open Assistant Workbench, create a session, switch to `full`, check autoApproveAuthor,
        //    and enable `🛡️ ST 全权管家` via the in-Shadow-DOM secondary confirmation modal.
        await page.evaluate(() => {
            (window as unknown as AgenticWindowBridge).Agentic!.assistant.open();
        });

        const dialog = page.locator('dialog#agentic-app');
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.locator('[data-assistant-new-session-btn="true"]').click();

        await dialog.locator('[data-assistant-mode-btn="true"]').click();
        await dialog.locator('[data-assistant-popover="mode"]').waitFor({ state: 'visible', timeout: 5000 });
        await dialog.locator('[data-assistant-mode-option="full"]').click();

        // Check `本会话自动批准写卡` (`autoApproveAuthor: true`)
        const autoApproveCheckbox = dialog.locator('[data-assistant-auto-approve-checkbox="true"]');
        await autoApproveCheckbox.waitFor({ state: 'visible', timeout: 5000 });
        await autoApproveCheckbox.check();
        await expect(autoApproveCheckbox).toBeChecked();

        // Click `🛡️ ST 全权管家` -> confirm inside in-Shadow-DOM modal (no window.confirm)
        await dialog.locator('[data-assistant-st-admin-toggle="true"]').click();
        await dialog.locator('[data-assistant-st-admin-modal="true"]').waitFor({ state: 'visible', timeout: 5000 });
        await dialog.locator('[data-assistant-st-admin-confirm="true"]').click();
        await dialog.locator('[data-assistant-st-admin-modal="true"]').waitFor({ state: 'hidden', timeout: 5000 });

        await waitForLocatorText(dialog.locator('[data-assistant-mode-btn="true"]'), '管家', 5000);

        // 3. Part A: `st_settings_read` returns secret-bearing config -> redacted to ***REDACTED*** + badge.
        mockServer.clearRequests();
        mockServer.enqueue([
            makeStreamedToolCallScenario(
                'st_settings_read',
                { scope: 'e2e_secret_probe' },
                { callId: 'call_gp4_settings_read' },
            ),
            {
                chunks: [
                    {
                        content: '已完成配置检查：敏感字段已脱敏为 ***REDACTED***，safeLabel 可见。',
                        delayMs: 5,
                    },
                ],
                finishReason: 'stop',
            },
        ]);

        await dialog
            .locator('[data-assistant-draft-input="true"]')
            .fill('读取 e2e_secret_probe 的配置内容。');
        await dialog.locator('[data-assistant-send-btn="true"]').click();

        await waitForLocatorText(
            dialog.locator('[data-assistant-thread="true"]'),
            '已完成配置检查',
            15_000,
        );

        // Verify tool output delivered to the LLM in Round 2 is strictly redacted.
        const readPhaseReqs = mockServer.requests.filter((r) => r.origin === 'browser');
        expect(readPhaseReqs.length).toBeGreaterThanOrEqual(2);
        const round2ToolMsg = getRequestMessages(readPhaseReqs[1]).find((m) => m.role === 'tool');
        const round2ToolText = stringifyMessageContent(round2ToolMsg?.content);
        expect(round2ToolText).toContain('***REDACTED***');
        expect(round2ToolText).toContain(initialSafeLabel);
        expect(round2ToolText).not.toContain(rawApiKey);
        expect(round2ToolText).not.toContain(rawBearer);

        // Verify UI redaction badge (`🔒 已脱敏`) and expanded tool output never leak raw secrets.
        const redactedBadge = dialog.locator('[data-redacted-badge="true"]').first();
        await redactedBadge.waitFor({ state: 'visible', timeout: 5000 });
        expect(await redactedBadge.innerText()).toContain('已脱敏');

        const activityToggle = dialog.locator('[data-assistant-activity-toggle]').last();
        await activityToggle.click();
        const toolToggle = dialog.locator('.ag-ast-tool-toggle').last();
        await toolToggle.waitFor({ state: 'visible', timeout: 5000 });
        await toolToggle.click();

        const threadText = await dialog.locator('[data-assistant-thread="true"]').innerText();
        expect(threadText).toContain('***REDACTED***');
        expect(threadText).not.toContain(rawApiKey);
        expect(threadText).not.toContain(rawBearer);

        // 4. Part B: High-risk `st_settings_patch` STILL halts in `pending` with `🔒 强制确认`
        //    EVEN WITH `autoApproveAuthor: true`!
        mockServer.clearRequests();
        mockServer.enqueue(
            makeStreamedToolCallScenario(
                'st_settings_patch',
                {
                    scope: 'e2e_secret_probe',
                    patch: { safeLabel: patchedSafeLabel },
                },
                {
                    callId: 'call_gp4_settings_patch',
                    content: '准备修改 e2e_secret_probe 配置，该高危操作需人工强制确认：',
                },
            ),
        );

        await dialog
            .locator('[data-assistant-draft-input="true"]')
            .fill('把 e2e_secret_probe.safeLabel 改为 patched-after-mandatory-confirm。');
        await dialog.locator('[data-assistant-send-btn="true"]').click();

        const mandatoryCard = dialog.locator('[data-approval-status="pending"]').last();
        await mandatoryCard.waitFor({ state: 'visible', timeout: 15_000 });
        const mandatoryBadge = mandatoryCard.locator('[data-approval-mandatory="true"]');
        await mandatoryBadge.waitFor({ state: 'visible', timeout: 5000 });
        expect(await mandatoryBadge.innerText()).toContain('强制确认');

        // Confirm setting was NOT mutated while awaiting mandatory confirmation.
        const labelBeforeConfirm = await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            const cfg = await win.Agentic!.bridge.admin!.readHostSettings('e2e_secret_probe');
            return cfg.safeLabel;
        });
        expect(labelBeforeConfirm).toBe(initialSafeLabel);

        // Explicitly click `✓ 接受` -> setting mutation executes and persists.
        await mandatoryCard.locator('[data-approval-approve-btn]').click();
        await dialog
            .locator('[data-approval-collapsed="true"][data-approval-status="approved"]')
            .last()
            .waitFor({ state: 'visible', timeout: 15_000 });

        const labelAfterConfirm = await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            const cfg = await win.Agentic!.bridge.admin!.readHostSettings('e2e_secret_probe');
            return cfg.safeLabel;
        });
        expect(labelAfterConfirm).toBe(patchedSafeLabel);

        await closeConsoleIfOpen(page);
    });

    test('GP-5: Companion mode /side/* prompt bridge sets extension_prompts["agentic_side_bridge"] and off mode clears it completely', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        // 1. Switch to `companion` mode and write a matching `/side/*` radar_hint clue.
        await configureAgenticConnectionAndMode(page, mockServer.v1Url, 'companion');
        const modeAfterSwitch = await page.evaluate(
            () => (window as unknown as AgenticWindowBridge).Agentic!.getSettings().runMode,
        );
        expect(modeAfterSwitch).toBe('companion');

        await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            await win.Agentic!.sideGen.clues.write({
                path: '/side/rumors/lighthouse.md',
                title: '旧灯塔异响传闻',
                delivery: 'radar_hint',
                keywords: ['旧灯塔'],
                summary: '午夜旧灯塔曾出现神秘信号灯',
                body: '码头守夜人报告称，午夜时分旧灯塔顶层闪过三短三长的神秘信号灯。',
                status: 'dormant',
            });
        });

        // 2. Trigger a real native ST companion generation mentioning "旧灯塔", holding the Mock SSE
        //    stream open long enough to inspect `extension_prompts['agentic_side_bridge']` live.
        const companionGate = createMockGate();
        try {
            mockServer.enqueue({
                chunks: [
                    {
                        waitGate: () => companionGate.promise,
                        content: '伴生模式已收到关于旧灯塔的线索提示。',
                        delayMs: 5,
                    },
                ],
                finishReason: 'stop',
            });

            await sendChatText(page, '听说旧灯塔那边最近有点不对劲。');

            const companionReq = await mockServer.waitForRequest(
                (req) => req.origin === 'server',
                15_000,
            );

            // Inspect SillyTavern's live `extension_prompts['agentic_side_bridge']`.
            const bridgePromptDuringGen = await page.evaluate(() => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return stCtx?.extensionPrompts?.['agentic_side_bridge']?.value ?? '';
            });

            expect(bridgePromptDuringGen).toContain('<side-hint>');
            expect(bridgePromptDuringGen).toContain('旧灯塔异响传闻');
            expect(bridgePromptDuringGen).toContain('午夜旧灯塔曾出现神秘信号灯');
            expect(bridgePromptDuringGen).toContain('/side/rumors/lighthouse.md');

            // Verify SillyTavern actually injected the bridge prompt into the native LLM payload.
            const serializedCompanionReq = JSON.stringify(getRequestMessages(companionReq));
            expect(serializedCompanionReq).toContain('午夜旧灯塔曾出现神秘信号灯');
            expect(serializedCompanionReq).toContain('<side-hint>');

            companionGate.release();
            await waitForLocatorText(
                page.locator('#chat .mes').last().locator('.mes_text'),
                '伴生模式已收到关于旧灯塔的线索提示。',
                15_000,
            );
            await waitForSendButtonUnlocked(page, 10_000);
        } finally {
            companionGate.release();
        }

        // 3. Re-arm companion side bridge via GENERATION_AFTER_COMMANDS, confirm it is non-empty,
        //    then switch `runMode = 'off'` and assert `extension_prompts['agentic_side_bridge']` is cleared to ''.
        const rearmedPrompt = await page.evaluate(async () => {
            const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
            const eventName = stCtx?.eventTypes?.GENERATION_AFTER_COMMANDS ?? 'generation_after_commands';
            await stCtx?.eventSource?.emit?.(eventName, 'normal', {}, false);
            return stCtx?.extensionPrompts?.['agentic_side_bridge']?.value ?? '';
        });
        expect(rearmedPrompt).toContain('<side-hint>');
        expect(rearmedPrompt).toContain('/side/rumors/lighthouse.md');

        await configureAgenticConnectionAndMode(page, mockServer.v1Url, 'off');

        const promptAfterOff = await page.evaluate(() => {
            const win = window as unknown as AgenticWindowBridge;
            const stCtx = win.SillyTavern?.getContext?.();
            return {
                runMode: win.Agentic?.getSettings().runMode,
                bridgeValue: stCtx?.extensionPrompts?.['agentic_side_bridge']?.value ?? '',
            };
        });
        expect(promptAfterOff.runMode).toBe('off');
        expect(promptAfterOff.bridgeValue).toBe('');

        expect(pageErrors).toEqual([]);
    });
});
