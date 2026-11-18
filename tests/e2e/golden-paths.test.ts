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
    MockOpenAISseServer,
    type MockScenario,
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

    settings.firstRun = false;
    settings.main_api = 'openai';
    settings.active_character = 'default_Seraphina.png';
    settings.extension_settings = {};
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
    const deadline = Date.now() + 75000;

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

/** Build a tool-call SSE scenario followed by text or delayed execution. */
function makePatchVariablesScenario(
    mergePayload: Record<string, unknown>,
    options: { callId?: string; reasoning?: string; cachedTokens?: number } = {},
): MockScenario {
    const jsonArgs = JSON.stringify({ json_merge: mergePayload });
    const splitAt = Math.max(1, Math.floor(jsonArgs.length / 2));
    const partA = jsonArgs.slice(0, splitAt);
    const partB = jsonArgs.slice(splitAt);
    const callId = options.callId ?? `call_patch_${Date.now()}`;

    return {
        chunks: [
            ...(options.reasoning
                ? [{ reasoningContent: options.reasoning, delayMs: 10 }]
                : []),
            {
                toolCalls: [
                    {
                        index: 0,
                        id: callId,
                        type: 'function',
                        function: {
                            name: 'patch_variables',
                            arguments: partA,
                        },
                    },
                ],
                delayMs: 10,
            },
            {
                toolCalls: [
                    {
                        index: 0,
                        function: {
                            arguments: partB,
                        },
                    },
                ],
                finishReason: 'tool_calls',
                delayMs: 10,
            },
        ],
        usage: {
            prompt_tokens: 240,
            completion_tokens: 32,
            total_tokens: 272,
            prompt_tokens_details: {
                cached_tokens: options.cachedTokens ?? 180,
            },
        },
    };
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

    /** Ensure #extensions_settings drawer and ST-Agentic inline panel are expanded. */
    async function ensureAgenticExtCardVisible(targetPage: Page): Promise<Locator> {
        const card = targetPage.locator('#extensions_settings [data-agentic-settings-mount]');
        if (!(await card.locator('.ag-ext-open-btn').isVisible().catch(() => false))) {
            const extBlock = targetPage.locator('#rm_extensions_block');
            if (!(await extBlock.isVisible().catch(() => false))) {
                await targetPage.locator('#extensions-settings-button .drawer-toggle').click();
                await extBlock.waitFor({ state: 'visible', timeout: 10000 });
            }
            const toggle = card.locator('.inline-drawer-toggle').first();
            if (await toggle.isVisible().catch(() => false)) {
                await toggle.click();
            }
        }
        await card.locator('.ag-ext-open-btn').waitFor({ state: 'visible', timeout: 10000 });
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
            pageErrors.push(`pageerror: ${err.message}`);
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
    }, 90000);

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

    it('Path 1: takeover mode streams tool calls, <agentic-capsule>, and detached after_turn while #send_but is unlocked', async () => {
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

        // 2. Script Round 1 (tool call), Round 2 (gated streamed text), Round 3 (gated detached after_turn).
        mockServer.clearRequests();
        const round2Gate = createMockGate();
        const afterTurnGate = createMockGate();

        try {
            mockServer.enqueue([
                makePatchVariablesScenario(
                    { mood: 'excited', gold: 125, branch: 'swipe0' },
                    { callId: 'call_p1_vars', reasoning: 'Checking variables before response.', cachedTokens: 150 },
                ),
                {
                    chunks: [
                        { waitGate: () => round2Gate.promise, content: '<think>Deliberating quietly. </think>', delayMs: 5 },
                        { content: 'Hello adventurer, ', delayMs: 15 },
                        { content: 'Path 1 reply!', delayMs: 15 },
                    ],
                    usage: {
                        prompt_tokens: 300,
                        completion_tokens: 24,
                        total_tokens: 324,
                        prompt_tokens_details: { cached_tokens: 210 },
                    },
                },
                {
                    chunks: [
                        { waitGate: () => afterTurnGate.promise, content: 'Background after_turn done.', delayMs: 5 },
                    ],
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

            // 4. Wait until after_turn request hits server while held open by afterTurnGate.
            await mockServer.waitForRequest(
                () => mockServer!.requests.filter((r) => r.origin === 'browser').length >= 3,
                15000,
            );

            const mesTextRaw = await waitForLocatorText(
                lastMes.locator('.mes_text'),
                'Hello adventurer, Path 1 reply!',
                10000,
            );
            expect(mesTextRaw).not.toContain('<think>');

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
            await page.waitForFunction(
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
                { timeout: 5000 },
            );

            // 5. Release after_turn and verify capsule reaches 'done' and causal variables landed.
            afterTurnGate.release();
            await page.waitForFunction(
                () => {
                    const cap = document.querySelector('#chat .mes:last-of-type agentic-capsule');
                    const status = cap?.shadowRoot?.querySelector('.cap-shell')?.getAttribute('data-status');
                    return status === 'done';
                },
                undefined,
                { timeout: 15000 },
            );

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

        // 1. Trigger Swipe right -> creates swipeId = 1 with distinct causal variables.
        mockServer.enqueue([
            makePatchVariablesScenario({ gold: 999, branch: 'swipe1', swipeOnlyKey: 'from-swipe-1' }),
            { chunks: [{ content: 'Swipe One Branch Reply.' }] },
        ]);

        const lastMes = page.locator('#chat .mes').last();
        await lastMes.hover();
        await lastMes.locator('.swipe_right').click();

        await waitForLocatorText(lastMes.locator('.mes_text'), 'Swipe One Branch Reply.', 15000);
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

        // 2. Switch left back to swipeId = 0 -> verify DOM and zero leakage from swipeId = 1.
        await lastMes.hover();
        await lastMes.locator('.swipe_left').click();

        await waitForLocatorText(
            lastMes.locator('.mes_text'),
            'Hello adventurer, Path 1 reply!',
            10000,
        );
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
            { chunks: [{ content: 'Regenerated Clean Reply.' }] },
        ]);

        await page.locator('#options_button').click();
        await page.locator('#option_regenerate').click();

        await waitForLocatorText(lastMes.locator('.mes_text'), 'Regenerated Clean Reply.', 15000);
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

    it('Path 3: #mes_stop aborts slow SSE stream cleanly, preserves safe partial text, and unlocks #send_but', async () => {
        if (!mockServer) {
            throw new Error('MockOpenAISseServer was not initialized');
        }
        mockServer.clearRequests();
        mockServer.clearScenarios();

        const slowGate = createMockGate();
        try {
            mockServer.enqueue({
                chunks: [
                    { content: 'Partial streamed prefix before cancel. ', delayMs: 10 },
                    { waitGate: () => slowGate.promise, content: 'UNEXPECTED_TAIL_AFTER_ABORT' },
                ],
                keepOpenUntilAborted: true,
            });

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

            // Verify #send_but unlocks cleanly without deadlock.
            await page.waitForFunction(
                () => {
                    const sendBtn = document.querySelector('#send_but') as HTMLElement | null;
                    const stopBtn = document.querySelector('#mes_stop') as HTMLElement | null;
                    return (
                        Boolean(sendBtn)
                        && !sendBtn?.classList.contains('displayNone')
                        && sendBtn?.getAttribute('disabled') === null
                        && (!stopBtn || getComputedStyle(stopBtn).display === 'none')
                    );
                },
                undefined,
                { timeout: 10000 },
            );

            const textAfterStop = await lastMes.locator('.mes_text').innerText();
            expect(textAfterStop).toContain('Partial streamed prefix before cancel.');
            expect(textAfterStop).not.toContain('UNEXPECTED_TAIL_AFTER_ABORT');

            // Verify subsequent turn succeeds cleanly without UI deadlock.
            mockServer.enqueue({ chunks: [{ content: 'Post-abort recovery succeeded.' }] });
            await sendChatText(page, 'Verify recovery after stop');
            await waitForLocatorText(
                page.locator('#chat .mes').last().locator('.mes_text'),
                'Post-abort recovery succeeded.',
                15000,
            );
        } finally {
            slowGate.release();
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
