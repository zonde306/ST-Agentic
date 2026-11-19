import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { stringify as stringifyYaml } from 'yaml';
import {
    createMockGate,
    makeAppendFileScenario,
    makeEditFileScenario,
    makeNonStreamToolCallScenario,
    makePartialToolCallScenario,
    makeStreamedToolCallScenario,
    makeWriteFileScenario,
    MockOpenAISseServer,
    type MockScenario,
    type MockToolCallScenarioOptions,
    type RecordedLlmRequest,
} from './mock-sse-server';

const EXTENSION_ROOT = path.resolve(import.meta.dirname, '..', '..');
const ST_ROOT = path.resolve(EXTENSION_ROOT, '..', '..', '..', '..', '..');
const DIST_BUNDLE_PATH = path.join(EXTENSION_ROOT, 'dist', 'index.js');

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
            presets: Record<string, { id: string; name: string; triggers: Array<{ id: string; label: string; enabled: boolean }> }>;
        };
        openConsole: (tab?: string) => void;
        closeConsole: () => void;
        vfs?: {
            readVariables: (opts?: { target?: { messageId: number; swipeId: number } }) => Promise<Record<string, unknown>>;
        };
        store?: {
            listNamespaceEntries?: (ns: string) => unknown[];
        };
        uiStore?: {
            updateSettings: (
                updater: (prev: Record<string, unknown>) => Record<string, unknown>,
            ) => Promise<unknown>;
        };
    };
    SillyTavern?: {
        getContext?: () => {
            characterId?: string | number;
            groupId?: string | null;
            chat?: Array<{ mes?: string; is_user?: boolean; swipe_id?: number; swipes?: string[] }>;
        };
    };
    this_chid?: number;
    selected_group?: string | null;
    online_status?: string;
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
    await fsp.mkdir(path.join(dataRoot, '_css'), { recursive: true });
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
        const text = chunk.toString('utf-8');
        logs.push(text);
        if (logs.length > 200) {
            logs.shift();
        }
    };
    proc.stdout?.on('data', recordLog);
    proc.stderr?.on('data', recordLog);

    const baseUrl = `http://127.0.0.1:${params.port}`;
    const deadline = Date.now() + 120000;

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

/** Build a streamed `patch_variables` tool-call SSE scenario. */
function makePatchVariablesScenario(
    mergePayload: Record<string, unknown>,
    options: { callId?: string; reasoning?: string; cachedTokens?: number } = {},
): MockScenario {
    return makeStreamedToolCallScenario(
        'patch_variables',
        { json_merge: mergePayload },
        {
            callId: options.callId,
            reasoning: options.reasoning,
            cachedTokens: options.cachedTokens,
        },
    );
}

/** Build a streamed `write_file({ path: '/output.md', content })` SSE scenario. */
function makeWriteOutputScenario(
    content: string,
    options: MockToolCallScenarioOptions & { keyOrder?: 'path_first' | 'content_first' } = {},
): MockScenario {
    return makeWriteFileScenario('/output.md', content, options);
}

/** Build a streamed `append_file({ path: '/output.md', content })` SSE scenario. */
function makeAppendOutputScenario(
    content: string,
    options: MockToolCallScenarioOptions = {},
): MockScenario {
    return makeAppendFileScenario('/output.md', content, options);
}

/** Build a streamed `edit_file({ path: '/output.md', search, replace })` SSE scenario. */
function makeEditOutputScenario(
    search: string,
    replace: string,
    options: MockToolCallScenarioOptions = {},
): MockScenario {
    return makeEditFileScenario('/output.md', search, replace, options);
}

/** Build the final plain-text internal review completion round for `main_turn`. */
function makeMainTurnFinishScenario(
    internalSummary = 'Internal review passed.',
    options: { cachedTokens?: number; delayMs?: number } = {},
): MockScenario {
    return {
        chunks: [{ content: internalSummary, delayMs: options.delayMs ?? 5 }],
        finishReason: 'stop',
        usage: {
            prompt_tokens: 280,
            completion_tokens: 16,
            total_tokens: 296,
            prompt_tokens_details: {
                cached_tokens: options.cachedTokens ?? 220,
            },
        },
    };
}

/** Read a specific message entry directly from SillyTavern's live `chat` context. */
async function readHostChatMessage(
    targetPage: Page,
    mesId?: number,
): Promise<{ mesId: number; mes: string; swipeId: number; swipes: string[] }> {
    return await targetPage.evaluate((explicitId) => {
        const win = window as unknown as AgenticWindowBridge;
        const chatList = win.SillyTavern?.getContext?.()?.chat ?? win.chat ?? [];
        const resolvedId =
            typeof explicitId === 'number'
                ? explicitId
                : Number(document.querySelector('#chat .mes:last-of-type')?.getAttribute('mesid') ?? chatList.length - 1);
        const msg = chatList[resolvedId];
        return {
            mesId: resolvedId,
            mes: typeof msg?.mes === 'string' ? msg.mes : '',
            swipeId: typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0,
            swipes: Array.isArray(msg?.swipes) ? msg.swipes.map((s) => String(s ?? '')) : [],
        };
    }, mesId);
}

/** Wait until `#send_but` is visible/enabled and `#mes_stop` is hidden. */
async function waitForSendButtonUnlocked(targetPage: Page, timeoutMs = 10000): Promise<void> {
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
    timeoutMs = 15000,
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

/** Wait until `locator.innerText()` includes `expected` or throw a clear timeout message. */
async function waitForLocatorText(
    locator: Locator,
    expected: string,
    timeoutMs = 15000,
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

describe('ST-Agentic E2E Golden Paths against Real SillyTavern', () => {
    let tmpRoot = '';
    let mockServer: MockOpenAISseServer | undefined;
    let stProc: ChildProcess | undefined;
    let stBaseUrl = '';
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let page: Page;
    const pageErrors: string[] = [];

    /** Wait for ST boot preloader, Agentic extension mount, active character chat, and #send_but. */
    async function waitForStAndAgenticReady(targetPage: Page): Promise<void> {
        await targetPage.waitForFunction(
            () => {
                const win = window as unknown as AgenticWindowBridge;
                const preloader = document.querySelector('#preloader') as HTMLElement | null;
                const preloaderGone =
                    !preloader || getComputedStyle(preloader).display === 'none' || preloader.hidden;
                return Boolean(win.Agentic && win.Agentic.version && preloaderGone);
            },
            undefined,
            { timeout: 30000 },
        );

        await targetPage.waitForSelector('#extensions_settings [data-agentic-settings-mount]', {
            state: 'attached',
            timeout: 15000,
        });

        const stPopupOk = targetPage.locator('dialog.popup[open] .popup-button-ok').first();
        if (await stPopupOk.isVisible().catch(() => false)) {
            await stPopupOk.click().catch(() => undefined);
        }

        // Wait briefly for active_character auto-open or character list population.
        await targetPage.waitForFunction(
            () => {
                const stCtx = (window as unknown as AgenticWindowBridge).SillyTavern?.getContext?.();
                return (
                    (stCtx?.characterId !== undefined && document.querySelectorAll('#chat .mes').length > 0)
                    || document.querySelectorAll('.character_select').length > 0
                );
            },
            undefined,
            { timeout: 15000 },
        );

        // If no character chat is open yet, open Character Management drawer and pick Seraphina.
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
            await charCard.waitFor({ state: 'visible', timeout: 10000 });
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
            { timeout: 15000 },
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
            { timeout: 15000 },
        );
    }

    /** Ensure #extensions_settings drawer and ST-Agentic inline panel are expanded and centered in view. */
    async function ensureAgenticExtCardVisible(targetPage: Page): Promise<Locator> {
        await targetPage.evaluate(() => {
            document.querySelectorAll('#toast-container .toast').forEach((el) => {
                el.remove();
            });
        });

        const card = targetPage.locator('#extensions_settings [data-agentic-settings-mount]');
        const extBlock = targetPage.locator('#rm_extensions_block');
        const extIcon = targetPage.locator('#extensions-settings-button .drawer-icon');
        const openBtn = card.locator('.ag-ext-open-btn');
        const takeoverBtn = card.locator('.ag-ext-mode-btn[data-mode="takeover"]');

        for (let attempt = 0; attempt < 4; attempt += 1) {
            const hasOpenDrawer = await extBlock
                .evaluate((el) => el.classList.contains('openDrawer'))
                .catch(() => false);
            if (!hasOpenDrawer) {
                await extIcon.click();
                await targetPage
                    .waitForFunction(
                        () =>
                            document.querySelector('#rm_extensions_block')?.classList.contains('openDrawer')
                            ?? false,
                        undefined,
                        { timeout: 4000 },
                    )
                    .catch(() => undefined);
            }

            if (await openBtn.isVisible().catch(() => false)) {
                await card.evaluate((el) => {
                    el.scrollIntoView({ block: 'center', inline: 'nearest' });
                });
                await targetPage.waitForTimeout(150);
                const stillOpen = await extBlock
                    .evaluate((el) => el.classList.contains('openDrawer'))
                    .catch(() => false);
                if (stillOpen && (await takeoverBtn.isVisible().catch(() => false))) {
                    return card;
                }
            }
            await targetPage.waitForTimeout(200);
        }

        await openBtn.waitFor({ state: 'visible', timeout: 10000 });
        await card.evaluate((el) => {
            el.scrollIntoView({ block: 'center', inline: 'nearest' });
        });
        await targetPage.waitForTimeout(150);
        await takeoverBtn.waitFor({ state: 'visible', timeout: 5000 });
        return card;
    }

    /** Fill user input, send message via `#send_but`, and wait until send button locks or message appears. */
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

    beforeAll(async () => {
        expect(fs.existsSync(DIST_BUNDLE_PATH)).toBe(true);

        mockServer = await MockOpenAISseServer.start();
        const stPort = await getFreePort();
        tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-agentic-e2e-'));

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
    }, 150000);

    afterEach(async () => {
        if (page && !page.isClosed()) {
            await Promise.race([
                closeConsoleIfOpen(page).catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 3000)),
            ]);
        }
    });

    afterAll(async () => {
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
    }, 30000);

    it('Path 1: takeover mode streams /output.md tool calls, <agentic-capsule>, and detached after_turn while #send_but is unlocked', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.reset();

        // 1. Configure takeover mode + connection endpoint + after_turn trigger via real UI.
        const extCard = await ensureAgenticExtCardVisible(page);
        await extCard.locator('.ag-ext-mode-btn[data-mode="takeover"]').click();
        await extCard.locator('.ag-ext-open-btn').click();

        const dialog = page.locator('dialog#agentic-app');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });

        await dialog.locator('.ag-sidebar button.ag-nav-item', { hasText: '连接' }).click();
        await dialog
            .locator('.ag-field', { hasText: 'Endpoint (Base URL)' })
            .locator('input')
            .fill(mockServer.v1Url);
        await dialog
            .locator('.ag-field', { hasText: 'Model ID' })
            .locator('input')
            .fill('mock-gpt');

        // Run "测试连通与缓存" (non-stream test probe against MockOpenAISseServer).
        mockServer.enqueue({ nonStreamContent: 'Connection verified' });
        await dialog.locator('button', { hasText: '测试连通与缓存' }).click();
        await dialog.locator('.ag-banner-success').waitFor({ state: 'visible', timeout: 10000 });

        // Add an after_turn trigger so Path 1 exercises detached background execution.
        await dialog.locator('.ag-sidebar button.ag-nav-item', { hasText: '管线' }).click();
        await dialog.locator('button[aria-label="在 Phase 3: After Turn 新增规则"]').click();
        await dialog.locator('text=新触发规则 (after_turn)').first().waitFor({ state: 'visible', timeout: 5000 });

        await closeConsoleIfOpen(page);

        // 2. Script Round 1 (patch_variables), Round 2 (gated streamed write_file /output.md), Round 3 (completion), Round 4 (gated detached after_turn).
        mockServer.clearRequests();
        const round2Gate = createMockGate();
        const afterTurnGate = createMockGate();

        try {
            mockServer.enqueue([
                makePatchVariablesScenario(
                    { mood: 'excited', gold: 125, branch: 'swipe0' },
                    { callId: 'call_p1_vars', reasoning: 'Checking variables before response.', cachedTokens: 150 },
                ),
                makeWriteOutputScenario('Hello adventurer, Path 1 reply!', {
                    callId: 'call_p1_output',
                    reasoning: 'Deliberating quietly.',
                    cachedTokens: 210,
                    waitGateBeforeFirstChunk: () => round2Gate.promise,
                }),
                makeMainTurnFinishScenario('Path 1 internal review summary.'),
                {
                    chunks: [
                        { waitGate: () => afterTurnGate.promise, content: 'Background after_turn done.', delayMs: 5 },
                    ],
                    nonStreamContent: 'Background after_turn done.',
                },
            ]);

            const prevMesCount = await page.locator('#chat .mes').count();
            await sendChatText(page, 'Hello Agentic Path 1');

            // 3. Verify 0ms placeholder .mes + <agentic-capsule> mounts cleanly outside .mes_text.
            await page.waitForFunction(
                (expectedMin) => document.querySelectorAll('#chat .mes').length >= expectedMin,
                prevMesCount + 2,
                { timeout: 3000 },
            );

            const lastMes = page.locator('#chat .mes').last();
            const capsuleOutsideMesText = await lastMes.evaluate(
                (el) => Boolean(el.querySelector('agentic-capsule')) && !el.querySelector('.mes_text agentic-capsule'),
            );
            expect(capsuleOutsideMesText).toBe(true);

            // Wait until Round 2 starts (meaning patch_variables executed & capsule updated step state).
            await mockServer.waitForRequest(
                () => mockServer!.requests.filter((r) => r.origin === 'browser').length >= 2,
                15000,
            );
            await page.waitForFunction(
                () => {
                    const cap = document.querySelector('#chat .mes:last-of-type agentic-capsule');
                    const shell = cap?.shadowRoot?.querySelector('.cap-shell');
                    const summary = cap?.shadowRoot?.querySelector('.cap-summary')?.textContent ?? '';
                    const status = shell?.getAttribute('data-status') ?? '';
                    return (
                        (status === 'retrieving' || status === 'streaming')
                        && summary.includes('patch_variables')
                    );
                },
                undefined,
                { timeout: 10000 },
            );

            round2Gate.release();

            // 4. Wait until detached after_turn request hits server while held open by afterTurnGate.
            await mockServer.waitForRequest(
                () => mockServer!.requests.filter((r) => r.origin === 'browser').length >= 4,
                15000,
            );

            const mesTextRaw = await waitForLocatorText(
                lastMes.locator('.mes_text'),
                'Hello adventurer, Path 1 reply!',
                10000,
            );
            expect(mesTextRaw).not.toContain('<think>');
            expect(mesTextRaw).not.toContain('Path 1 internal review summary.');

            const chatMsg = await readHostChatMessage(page);
            expect(chatMsg.mes).toBe('Hello adventurer, Path 1 reply!');
            expect(chatMsg.swipes[0]).toBe('Hello adventurer, Path 1 reply!');

            await page.waitForFunction(
                () => {
                    const cap = document.querySelector('#chat .mes:last-of-type agentic-capsule');
                    const shell = cap?.shadowRoot?.querySelector('.cap-shell');
                    const cancelBtn = cap?.shadowRoot?.querySelector('.cap-cancel-btn');
                    return shell?.getAttribute('data-status') === 'background-running' && Boolean(cancelBtn);
                },
                undefined,
                { timeout: 10000 },
            );

            // Verify #send_but unlocks cleanly while detached after_turn background task is STILL running!
            await waitForSendButtonUnlocked(page, 5000);

            // 5. Release after_turn and verify capsule reaches 'done' and causal variables landed.
            afterTurnGate.release();
            await waitForLastCapsuleStatus(page, 'done', 15000);

            const resolvedVars = await page.evaluate(async () => {
                const win = window as unknown as AgenticWindowBridge;
                const mesId = Number(document.querySelector('#chat .mes:last-of-type')?.getAttribute('mesid') ?? -1);
                return (await win.Agentic?.vfs?.readVariables({ target: { messageId: mesId, swipeId: 0 } })) ?? {};
            });
            expect(resolvedVars).toMatchObject({ mood: 'excited', gold: 125, branch: 'swipe0' });
        } finally {
            round2Gate.release();
            afterTurnGate.release();
        }

        // Cleanly disable the temporary after_turn trigger rule via AppStore before Paths 2-5.
        await page.evaluate(async () => {
            const win = window as unknown as AgenticWindowBridge;
            await win.Agentic?.uiStore?.updateSettings((prev) => {
                const presets = {
                    ...(prev.presets as Record<
                        string,
                        { triggers: Array<{ label: string; enabled: boolean }> }
                    >),
                };
                const presetId = String(prev.currentPresetId ?? '');
                const preset = presets[presetId];
                if (!preset) {
                    return prev;
                }
                presets[presetId] = {
                    ...preset,
                    triggers: preset.triggers.map((trigger) =>
                        trigger.label === '新触发规则 (after_turn)'
                            ? { ...trigger, enabled: false }
                            : trigger,
                    ),
                };
                return { ...prev, presets };
            });
        });
    });

    it('Path 2: swipe & regenerate preserve causal (messageId, swipeId) branches without cross-branch leakage', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        const targetMesId = await page.evaluate(() =>
            Number(document.querySelector('#chat .mes:last-of-type')?.getAttribute('mesid') ?? -1),
        );
        expect(targetMesId).toBeGreaterThanOrEqual(1);

        // 1. Trigger Swipe right -> creates swipeId = 1 via write_file('/output.md') with distinct causal variables.
        mockServer.enqueue([
            makePatchVariablesScenario({ gold: 999, branch: 'swipe1', swipeOnlyKey: 'from-swipe-1' }),
            makeWriteOutputScenario('Swipe One Branch Reply.'),
            makeMainTurnFinishScenario('Swipe 1 internal check passed.'),
        ]);

        const lastMes = page.locator('#chat .mes').last();
        await lastMes.hover();
        await lastMes.locator('.swipe_right').click();

        await waitForLocatorText(lastMes.locator('.mes_text'), 'Swipe One Branch Reply.', 15000);
        await waitForLastCapsuleStatus(page, 'done', 15000);
        await waitForSendButtonUnlocked(page, 10000);
        await page.waitForFunction(
            (id) => {
                const mesEl = document.querySelector(`#chat .mes[mesid="${id}"]`);
                const counterText = (mesEl?.querySelector('.swipes-counter')?.textContent ?? '').replace(/\u200b/g, '');
                const stCtx = (
                    window as unknown as {
                        SillyTavern?: { getContext?: () => { chat?: Array<{ swipe_id?: number }> } };
                    }
                ).SillyTavern?.getContext?.();
                return stCtx?.chat?.[id]?.swipe_id === 1 && counterText === '2/2';
            },
            targetMesId,
            { timeout: 10000 },
        );

        const swipe1HostMsg = await readHostChatMessage(page, targetMesId);
        expect(swipe1HostMsg.mes).toBe('Swipe One Branch Reply.');
        expect(swipe1HostMsg.swipes[1]).toBe('Swipe One Branch Reply.');

        const swipe1Vars = await page.evaluate(async (id) => {
            const win = window as unknown as AgenticWindowBridge;
            return (await win.Agentic?.vfs?.readVariables({ target: { messageId: id, swipeId: 1 } })) ?? {};
        }, targetMesId);
        expect(swipe1Vars).toMatchObject({ gold: 999, branch: 'swipe1', swipeOnlyKey: 'from-swipe-1' });

        // Inspect variable & Diff views inside Console View ①.
        await page.evaluate(() => (window as unknown as AgenticWindowBridge).Agentic?.openConsole('files'));
        const dialog = page.locator('dialog#agentic-app');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
        await dialog.getByRole('button', { name: '变量', exact: true }).click();
        await dialog.locator('.ag-list-item', { hasText: '/state/variables.json' }).first().click();
        await dialog.getByRole('radio', { name: 'Diff 对比' }).click();
        await waitForLocatorText(dialog.locator('.ag-card-body').last(), 'from-swipe-1', 5000);
        await closeConsoleIfOpen(page);

        // 2. Switch left back to swipeId = 0 -> verify DOM, window.chat, and zero leakage from swipeId = 1.
        await lastMes.hover();
        await lastMes.locator('.swipe_left').click();

        await waitForLocatorText(
            lastMes.locator('.mes_text'),
            'Hello adventurer, Path 1 reply!',
            10000,
        );
        const swipe0HostMsg = await readHostChatMessage(page, targetMesId);
        expect(swipe0HostMsg.mes).toBe('Hello adventurer, Path 1 reply!');
        const swipe0Vars = await page.evaluate(async (id) => {
            const win = window as unknown as AgenticWindowBridge;
            return (await win.Agentic?.vfs?.readVariables({ target: { messageId: id, swipeId: 0 } })) ?? {};
        }, targetMesId);
        expect(swipe0Vars).toMatchObject({ mood: 'excited', gold: 125, branch: 'swipe0' });
        expect(swipe0Vars.swipeOnlyKey).toBeUndefined();

        // Confirm swipeId = 1 can also be switched back to cleanly without issuing a new LLM request.
        const reqCountBeforeRevisit = mockServer.requests.length;
        await lastMes.hover();
        await lastMes.locator('.swipe_right').click();
        await waitForLocatorText(lastMes.locator('.mes_text'), 'Swipe One Branch Reply.', 10000);
        expect(mockServer.requests.length).toBe(reqCountBeforeRevisit);

        // 3. Switch back to swipeId = 0 and trigger Regenerate -> verify causal branch resets cleanly without leaking swipe0/swipe1.
        await lastMes.hover();
        await lastMes.locator('.swipe_left').click();
        await waitForLocatorText(
            lastMes.locator('.mes_text'),
            'Hello adventurer, Path 1 reply!',
            10000,
        );

        mockServer.enqueue([
            makePatchVariablesScenario({ gold: 555, branch: 'regen0' }),
            makeWriteOutputScenario('Regenerated Clean Reply.'),
            makeMainTurnFinishScenario('Regen internal check passed.'),
        ]);

        await page.locator('#options_button').click();
        await page.locator('#option_regenerate').click();

        await waitForLocatorText(lastMes.locator('.mes_text'), 'Regenerated Clean Reply.', 15000);
        await waitForLastCapsuleStatus(page, 'done', 15000);
        await waitForSendButtonUnlocked(page, 10000);
        const regenHostMsg = await readHostChatMessage(page, targetMesId);
        expect(regenHostMsg.mes).toBe('Regenerated Clean Reply.');
        expect(regenHostMsg.swipes[0]).toBe('Regenerated Clean Reply.');
        expect(regenHostMsg.mes).not.toContain('Regen internal check passed.');

        const regen0Vars = await page.evaluate(async (id) => {
            const win = window as unknown as AgenticWindowBridge;
            return (await win.Agentic?.vfs?.readVariables({ target: { messageId: id, swipeId: 0 } })) ?? {};
        }, targetMesId);
        expect(regen0Vars).toMatchObject({ gold: 555, branch: 'regen0' });
        expect(regen0Vars.mood).toBeUndefined();
        expect(regen0Vars.swipeOnlyKey).toBeUndefined();

        const swipe1AfterRegen = await page.evaluate(async (id) => {
            const win = window as unknown as AgenticWindowBridge;
            return (await win.Agentic?.vfs?.readVariables({ target: { messageId: id, swipeId: 1 } })) ?? {};
        }, targetMesId);
        expect(swipe1AfterRegen.swipeOnlyKey).toBeUndefined();
    });

    it('Path 3: #mes_stop aborts partial write_file(/output.md) SSE stream, salvages to chat[last].mes, sets capsule interrupted, and unlocks #send_but', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        const slowGate = createMockGate();
        try {
            mockServer.enqueue(
                makePartialToolCallScenario(
                    'write_file',
                    '{"path":"/output.md","content":"Partial streamed prefix before cancel. ',
                    {
                        callId: 'call_p3_partial',
                        delayMs: 10,
                        keepOpenUntilAborted: true,
                        waitGateBeforeTail: () => slowGate.promise,
                        trailingArgs: 'UNEXPECTED_TAIL_AFTER_ABORT"}',
                    },
                ),
            );

            await sendChatText(page, 'Trigger slow stream to cancel');

            const slowReq: RecordedLlmRequest = await mockServer.waitForRequest(
                (req) => req.origin === 'browser',
                15000,
            );
            const lastMes = page.locator('#chat .mes').last();
            await waitForLocatorText(
                lastMes.locator('.mes_text'),
                'Partial streamed prefix before cancel.',
                10000,
            );

            await page.locator('#mes_stop').waitFor({ state: 'visible', timeout: 5000 });
            await page.locator('#mes_stop').click();

            await slowReq.waitForAbort();
            expect(slowReq.aborted).toBe(true);

            // Verify #send_but unlocks cleanly without deadlock and capsule enters 'interrupted'.
            await waitForSendButtonUnlocked(page, 10000);
            await waitForLastCapsuleStatus(page, 'interrupted', 10000);
            await lastMes.locator('agentic-capsule [data-action="resume"]').waitFor({
                state: 'visible',
                timeout: 5000,
            });

            const textAfterStop = await lastMes.locator('.mes_text').innerText();
            expect(textAfterStop).toContain('Partial streamed prefix before cancel.');
            expect(textAfterStop).not.toContain('UNEXPECTED_TAIL_AFTER_ABORT');

            const salvagedChatMsg = await readHostChatMessage(page);
            expect(salvagedChatMsg.mes).toBe('Partial streamed prefix before cancel. ');
            expect(salvagedChatMsg.swipes[salvagedChatMsg.swipeId]).toBe(
                'Partial streamed prefix before cancel. ',
            );

            // Verify subsequent turn succeeds cleanly via /output.md without UI deadlock.
            mockServer.enqueue([
                makeWriteOutputScenario('Post-abort recovery succeeded.'),
                makeMainTurnFinishScenario('Post-abort review passed.'),
            ]);
            await sendChatText(page, 'Verify recovery after stop');
            await waitForLocatorText(
                page.locator('#chat .mes').last().locator('.mes_text'),
                'Post-abort recovery succeeded.',
                15000,
            );
            await waitForLastCapsuleStatus(page, 'done', 10000);
            await waitForSendButtonUnlocked(page, 10000);
            const recoveryMsg = await readHostChatMessage(page);
            expect(recoveryMsg.mes).toBe('Post-abort recovery succeeded.');
        } finally {
            slowGate.release();
        }
    });

    it('Path A: streams /output.md without "..." placeholder pollution, edits in-turn via edit_file, and hides internal review summary', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        const round1CloseGate = createMockGate();
        try {
            mockServer.enqueue([
                makeWriteOutputScenario('Draft with TYPO_TOKEN.', {
                    callId: 'call_pa_write',
                    delayMs: 10,
                    waitGateBeforeClose: () => round1CloseGate.promise,
                }),
                makeEditOutputScenario('TYPO_TOKEN', 'FIXED_TOKEN', {
                    callId: 'call_pa_edit',
                    delayMs: 10,
                }),
                makeMainTurnFinishScenario('Internal review passed.'),
            ]);

            await sendChatText(page, 'Run Path A streaming output and in-turn edit review');

            const lastMes = page.locator('#chat .mes').last();

            // 1. While Round 1 write_file is mid-stream, live .mes_text shows draft and chat[last].mes has zero '...' pollution.
            await waitForLocatorText(lastMes.locator('.mes_text'), 'Draft with TYPO_TOKEN.', 10000);
            const chatMidStream = await readHostChatMessage(page);
            expect(chatMidStream.mes).toBe('');
            expect(chatMidStream.mes).not.toBe('...');

            // 2. Release Round 1 close -> Round 2 edit_file fixes TYPO_TOKEN -> Round 3 internal summary stays off-screen.
            round1CloseGate.release();

            await waitForLastCapsuleStatus(page, 'done', 15000);
            await waitForSendButtonUnlocked(page, 10000);

            const browserReqs = mockServer.requests.filter((r) => r.origin === 'browser');
            expect(
                browserReqs.length,
                `Expected 3 requests in Path A, got ${browserReqs.length}: ${JSON.stringify(
                    browserReqs.map((r) => ({
                        id: r.id,
                        stream: r.stream,
                        msgCount: Array.isArray(r.body.messages) ? r.body.messages.length : 0,
                        lastMsg: Array.isArray(r.body.messages)
                            ? r.body.messages[r.body.messages.length - 1]
                            : null,
                    })),
                )}`,
            ).toBe(3);

            const finalDomText = (await lastMes.locator('.mes_text').innerText()).trim();
            expect(finalDomText).toBe('Draft with FIXED_TOKEN.');
            expect(finalDomText).not.toContain('Internal review passed.');
            expect(finalDomText).not.toContain('TYPO_TOKEN');

            const finalChatMsg = await readHostChatMessage(page);
            expect(finalChatMsg.mes).toBe('Draft with FIXED_TOKEN.');
            expect(finalChatMsg.swipes[finalChatMsg.swipeId]).toBe('Draft with FIXED_TOKEN.');
            expect(finalChatMsg.mes).not.toContain('Internal review passed.');
            expect(finalChatMsg.mes).not.toContain('...');
        } finally {
            round1CloseGate.release();
        }
    });

    it('Path B: salvages mid-stream interruption, resumes via [data-action="resume"] with KV prefix invariance, and applies after_turn edit_file directly to ST chat', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        const tempAgentId = 'ag_path_b_editor';
        const tempTriggerId = 'tr_path_b_edit_output';

        // Enable a temporary ephemeral after_turn Edit trigger targeting /output.md just for Path B.
        const enableSavePromise = page.waitForResponse(
            (res) => res.url().includes('/api/settings/save') && res.request().method() === 'POST' && res.ok(),
            { timeout: 12000 },
        );
        await page.evaluate(
            async ({ agentId, triggerId }) => {
                const win = window as unknown as AgenticWindowBridge;
                await win.Agentic?.uiStore?.updateSettings((prev) => {
                    const presets = { ...(prev.presets as Record<string, Record<string, unknown>>) };
                    const presetId = String(prev.currentPresetId ?? '');
                    const preset = presets[presetId];
                    if (!preset) {
                        return prev;
                    }
                    const agents = { ...((preset.agents as Record<string, unknown>) ?? {}) };
                    agents[agentId] = {
                        id: agentId,
                        name: 'Path B Output Editor',
                        connectionId: 'inherit',
                        sessionMode: 'ephemeral',
                        ephemeralWindowSize: 4,
                        promptBlocks: [
                            {
                                id: 'system_base',
                                name: 'Edit Output Base',
                                role: 'system',
                                placement: 'prefix',
                                content: 'Inspect /output.md and apply surgical edit_file fixes.',
                                enabled: true,
                            },
                        ],
                        enabledTools: ['read_file', 'edit_file', 'append_file', 'write_file'],
                        permissions: {
                            read: ['/**'],
                            write: ['/output.md'],
                        },
                        maxToolRounds: 4,
                    };
                    const triggers = [
                        ...((preset.triggers as Array<{ id: string }>) ?? []).filter(
                            (t) => t.id !== triggerId,
                        ),
                        {
                            id: triggerId,
                            label: 'Path B After-Turn Direct Edit',
                            source: 'preset',
                            phase: 'after_turn',
                            order: 1,
                            barrier: 'self',
                            agentProfileId: agentId,
                            kind: 'agent',
                            decorator: '@@replace_output',
                            targetPath: '/output.md',
                            condition: { type: 'always' },
                            instructionTemplate:
                                'Replace "Part 2 resumed." with "Part 2 edited by trigger." in /output.md via edit_file.',
                            enabled: true,
                        },
                    ];
                    presets[presetId] = {
                        ...preset,
                        agents,
                        triggers,
                    };
                    return { ...prev, presets };
                });
            },
            { agentId: tempAgentId, triggerId: tempTriggerId },
        );
        await enableSavePromise;

        try {
            mockServer.enqueue([
                // Hop 1 Round 1: truncated partial write_file('/output.md') arguments
                makePartialToolCallScenario(
                    'write_file',
                    '{"path":"/output.md","content":"Part 1 before stop. ',
                    {
                        callId: 'call_pb_trunc',
                        delayMs: 10,
                        finishReason: 'length',
                    },
                ),
                // Hop 2 Resumed Round 1: append_file('/output.md', 'Part 2 resumed.')
                makeAppendOutputScenario('Part 2 resumed.', {
                    callId: 'call_pb_append',
                    delayMs: 10,
                }),
                // Hop 2 Resumed Round 2: plain internal review completion
                makeMainTurnFinishScenario('Review done.'),
                // Hop 2 after_turn Edit trigger Round 1 (non-streaming): edit_file('/output.md', ...)
                makeNonStreamToolCallScenario([
                    {
                        id: 'call_pb_after_edit',
                        name: 'edit_file',
                        arguments: {
                            path: '/output.md',
                            search: 'Part 2 resumed.',
                            replace: 'Part 2 edited by trigger.',
                        },
                    },
                ]),
                // Hop 2 after_turn Edit trigger Round 2 (non-streaming): finish
                {
                    nonStreamContent: 'After-turn direct edit applied.',
                    finishReason: 'stop',
                },
            ]);

            await sendChatText(page, 'Start Path B interrupted output and resume');

            const lastMes = page.locator('#chat .mes').last();
            await waitForLastCapsuleStatus(page, 'interrupted', 15000);
            await waitForSendButtonUnlocked(page, 10000);

            const resumeBtn = lastMes.locator('agentic-capsule [data-action="resume"]');
            await resumeBtn.waitFor({ state: 'visible', timeout: 5000 });
            expect(await resumeBtn.evaluate((el) => el.classList.contains('cap-resume-btn'))).toBe(true);

            // Verify salvaged prefix is visible in DOM & stored in window.chat[last].mes
            await waitForLocatorText(lastMes.locator('.mes_text'), 'Part 1 before stop.', 10000);
            const interruptedChatMsg = await readHostChatMessage(page);
            expect(interruptedChatMsg.mes).toBe('Part 1 before stop. ');
            expect(interruptedChatMsg.swipes[interruptedChatMsg.swipeId]).toBe('Part 1 before stop. ');

            const browserReqsBeforeResume = mockServer.requests.filter((r) => r.origin === 'browser');
            expect(browserReqsBeforeResume).toHaveLength(1);
            const hop1Req = browserReqsBeforeResume[0];

            // Click [↻ 恢复] on the capsule to resume seamlessly
            await resumeBtn.click();

            await mockServer.waitForRequest(
                () => mockServer!.requests.filter((r) => r.origin === 'browser').length >= 5,
                15000,
            );
            await waitForLastCapsuleStatus(page, 'done', 15000);
            await waitForSendButtonUnlocked(page, 10000);

            const allBrowserReqs = mockServer.requests.filter((r) => r.origin === 'browser');
            expect(allBrowserReqs).toHaveLength(5);

            // Verify 100% Prefix KV Cache Invariance on the resumed request before [System Recovery]
            const resumedReq = allBrowserReqs[1];
            const hop1Msgs = hop1Req.body.messages as unknown[];
            const resumedMsgs = resumedReq.body.messages as Array<{ role?: string; content?: unknown }>;
            expect(resumedMsgs.length).toBe(hop1Msgs.length + 1);
            expect(resumedMsgs.slice(0, hop1Msgs.length)).toEqual(hop1Msgs);
            expect(resumedReq.body.tools).toEqual(hop1Req.body.tools);
            expect(resumedMsgs[hop1Msgs.length]?.role).toBe('user');
            expect(String(resumedMsgs[hop1Msgs.length]?.content ?? '')).toContain('[System Recovery]');
            expect(String(resumedMsgs[hop1Msgs.length]?.content ?? '')).toContain('Part 1 before stop. ');

            // Verify after_turn Edit trigger ran edit_file('/output.md') and updated ST chat directly
            const triggerRound2Msgs = allBrowserReqs[4].body.messages as Array<{ role?: string; content?: unknown }>;
            const editToolResultMsg = triggerRound2Msgs.find((m) => m.role === 'tool');
            expect(String(editToolResultMsg?.content ?? '')).toContain('"ok":true');
            expect(String(editToolResultMsg?.content ?? '')).toContain('/output.md');

            await waitForLocatorText(
                lastMes.locator('.mes_text'),
                'Part 1 before stop. Part 2 edited by trigger.',
                10000,
            );
            const finalDomText = (await lastMes.locator('.mes_text').innerText()).trim();
            expect(finalDomText).toBe('Part 1 before stop. Part 2 edited by trigger.');
            expect(finalDomText).not.toContain('Review done.');
            expect(finalDomText).not.toContain('After-turn direct edit applied.');

            const finalChatMsg = await readHostChatMessage(page);
            expect(finalChatMsg.mes).toBe('Part 1 before stop. Part 2 edited by trigger.');
            expect(finalChatMsg.swipes[finalChatMsg.swipeId]).toBe(
                'Part 1 before stop. Part 2 edited by trigger.',
            );
        } finally {
            // Clean up temporary trigger and agent profile before Paths 4 & 5.
            const cleanupSavePromise = page
                .waitForResponse(
                    (res) =>
                        res.url().includes('/api/settings/save')
                        && res.request().method() === 'POST'
                        && res.ok(),
                    { timeout: 12000 },
                )
                .catch(() => undefined);
            await page.evaluate(
                async ({ agentId, triggerId }) => {
                    const win = window as unknown as AgenticWindowBridge;
                    await win.Agentic?.uiStore?.updateSettings((prev) => {
                        const presets = { ...(prev.presets as Record<string, Record<string, unknown>>) };
                        const presetId = String(prev.currentPresetId ?? '');
                        const preset = presets[presetId];
                        if (!preset) {
                            return prev;
                        }
                        const agents = { ...((preset.agents as Record<string, unknown>) ?? {}) };
                        delete agents[agentId];
                        const triggers = ((preset.triggers as Array<{ id: string }>) ?? []).filter(
                            (t) => t.id !== triggerId,
                        );
                        presets[presetId] = {
                            ...preset,
                            agents,
                            triggers,
                        };
                        return { ...prev, presets };
                    });
                },
                { agentId: tempAgentId, triggerId: tempTriggerId },
            );
            await cleanupSavePromise;
        }
    });

    it('Path 4: 390x844 mobile console opens via #extensionsMenu, persists settings changes across reload', async () => {
        await page.setViewportSize({ width: 390, height: 844 });

        // Open console from #extensionsMenu wand button.
        await page.locator('#extensionsMenuButton').click();
        await page.locator('#agentic_menu_files').waitFor({ state: 'visible', timeout: 5000 });
        await page.locator('#agentic_menu_files').click();

        const dialog = page.locator('dialog#agentic-app');
        await dialog.waitFor({ state: 'visible', timeout: 10000 });

        // Verify mobile full-screen sheet sizing and mobile bottom nav without horizontal overflow.
        const mobileMetrics = await page.evaluate(() => {
            const dlg = document.querySelector('dialog#agentic-app');
            const host = dlg?.querySelector('[data-agentic-shadow-host]');
            const root = host?.shadowRoot;
            const rect = dlg?.getBoundingClientRect();
            const mobileNav = root?.querySelector('nav.ag-mobile-nav') as HTMLElement | null;
            const shell = root?.querySelector('.ag-console') as HTMLElement | null;
            return {
                width: rect?.width ?? 9999,
                height: rect?.height ?? 0,
                navVisible: Boolean(mobileNav && getComputedStyle(mobileNav).display !== 'none'),
                overflowX: shell ? shell.scrollWidth - shell.clientWidth : 9999,
            };
        });
        expect(mobileMetrics.width).toBeLessThanOrEqual(392);
        expect(mobileMetrics.height).toBeGreaterThanOrEqual(800);
        expect(mobileMetrics.navVisible).toBe(true);
        expect(mobileMetrics.overflowX).toBeLessThanOrEqual(2);

        // Toggle runMode via mobile header SegmentedControl and edit connection name, wait for ST save.
        await dialog.locator('[role="radiogroup"] [role="radio"]', { hasText: '接管' }).click();
        await dialog.locator('nav.ag-mobile-nav button.ag-mobile-tab', { hasText: '连接' }).click();
        await dialog.locator('.ag-list-item').first().click();

        const savePromise = page.waitForResponse(
            (res) => res.url().includes('/api/settings/save') && res.request().method() === 'POST' && res.ok(),
            { timeout: 12000 },
        );
        const connNameInput = dialog.locator('.ag-field', { hasText: '连接名称' }).locator('input');
        await connNameInput.fill('Mock E2E Mobile Conn');
        await savePromise;

        // Verify mobile stack back navigation works cleanly too.
        await dialog.locator('.ag-stack-back-btn').click();
        await closeConsoleIfOpen(page);

        // Reload SillyTavern and confirm persisted settings survived reload.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForStAndAgenticReady(page);

        const reloadedSettings = await page.evaluate(
            () => (window as unknown as AgenticWindowBridge).Agentic?.getSettings(),
        );
        expect(reloadedSettings?.runMode).toBe('takeover');
        const activeConn = reloadedSettings?.connections[reloadedSettings.currentConnectionId];
        expect(activeConn?.name).toBe('Mock E2E Mobile Conn');

        await page.setViewportSize({ width: 1280, height: 800 });
    });

    it('Path 5: companion mode, /gen quiet command, and group chats bypass Agentic takeover cleanly', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        // 1. Switch to companion mode via UI and verify native ST pipeline executes cleanly.
        const extCard = await ensureAgenticExtCardVisible(page);
        await extCard.locator('.ag-ext-mode-btn[data-mode="companion"]').click();
        const modeAfterSwitch = await page.evaluate(
            () => (window as unknown as AgenticWindowBridge).Agentic?.getSettings().runMode,
        );
        expect(modeAfterSwitch).toBe('companion');

        mockServer.enqueue({ chunks: [{ content: 'Native ST Companion Reply.' }] });
        await sendChatText(page, 'Hello companion mode');

        const companionReq = await mockServer.waitForRequest((req) => req.origin === 'server', 15000);
        expect(companionReq.origin).toBe('server');
        await waitForLocatorText(
            page.locator('#chat .mes').last().locator('.mes_text'),
            'Native ST Companion Reply.',
            15000,
        );

        // 2. Switch back to takeover mode to prove quiet (/gen) & group chat still pass through native ST.
        const extCardTakeover = await ensureAgenticExtCardVisible(page);
        await extCardTakeover.locator('.ag-ext-mode-btn[data-mode="takeover"]').click();
        const modeTakeover = await page.evaluate(
            () => (window as unknown as AgenticWindowBridge).Agentic?.getSettings().runMode,
        );
        expect(modeTakeover).toBe('takeover');

        mockServer.clearRequests();
        mockServer.enqueue({
            nonStreamContent: 'Quiet Gen Passthrough OK',
            chunks: [{ content: 'Quiet Gen Passthrough OK' }],
        });
        await sendChatText(page, '/gen Say quiet ok | /echo {{pipe}}');

        const quietReq = await mockServer.waitForRequest((req) => req.origin === 'server', 15000);
        expect(quietReq.origin).toBe('server');
        expect(mockServer.requests.some((r) => r.origin === 'browser')).toBe(false);

        // 3. Create & open a group chat via SillyTavern UI, then verify takeover passes group turns through.
        if (!(await page.locator('#rm_button_characters').isVisible().catch(() => false))) {
            await page.locator('#rightNavDrawerIcon').click();
            await page.locator('#rm_button_characters').waitFor({ state: 'visible', timeout: 10000 });
        }
        await page.locator('#rm_button_characters').click();
        await page.locator('#rm_button_group_chats').waitFor({ state: 'visible', timeout: 10000 });
        await page.locator('#rm_button_group_chats').click();

        const addMemberBtn = page
            .locator('#rm_group_add_members .group_member .right_menu_button[data-action="add"]')
            .first();
        await addMemberBtn.waitFor({ state: 'visible', timeout: 10000 });
        await addMemberBtn.click();
        await page.locator('#rm_group_submit').click();

        const createdGroupCard = page.locator('.group_select').first();
        await createdGroupCard.waitFor({ state: 'visible', timeout: 10000 });
        await createdGroupCard.click();

        await page.waitForFunction(
            () =>
                Boolean(
                    (
                        window as unknown as {
                            SillyTavern?: { getContext?: () => { groupId?: string | null } };
                        }
                    ).SillyTavern?.getContext?.().groupId,
                ),
            undefined,
            { timeout: 10000 },
        );

        mockServer.clearRequests();
        mockServer.enqueue({ chunks: [{ content: 'Group Native Passthrough Reply.' }] });
        await sendChatText(page, 'Hello group chat');

        const groupReq = await mockServer.waitForRequest((req) => req.origin === 'server', 15000);
        expect(groupReq.origin).toBe('server');
        expect(mockServer.requests.some((r) => r.origin === 'browser')).toBe(false);
        await waitForLocatorText(
            page.locator('#chat .mes').last().locator('.mes_text'),
            'Group Native Passthrough Reply.',
            15000,
        );

        expect(pageErrors).toEqual([]);
    });
});
