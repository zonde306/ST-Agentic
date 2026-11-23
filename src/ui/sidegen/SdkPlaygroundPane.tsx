import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
    SideClueDelivery,
    SideGenOnceOptions,
    SideGenResult,
    SideGenSendOptions,
} from '@/core/types';
import {
    Badge,
    Button,
    FormField,
    SelectInput,
    TextAreaInput,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import {
    IconClose,
    IconCode,
    IconCopy,
    IconPlay,
} from '@/ui/components/Icons';
import type { AppStore } from '@/ui/store';
import {
    DELIVERY_SELECT_OPTIONS,
    copyTextSafe,
    formatDurationMs,
    formatErrorMessage,
    formatTokenCount,
    parseKeywordsInput,
    useSideGenStoreSlice,
} from './sidegen-helpers';

export interface SdkPlaygroundPaneProps {
    store: AppStore;
    isMobile: boolean;
}

type SdkMode = 'send' | 'runOnce';

const SDK_MODE_OPTIONS: readonly { value: SdkMode; label: string }[] = [
    { value: 'send', label: 'send() — 持久线外会话' },
    { value: 'runOnce', label: 'runOnce() — 一次性小插曲' },
];

const CUSTOM_SESSION_SENTINEL = '__custom__';

function computeCacheRateLabel(usage: SideGenResult['usage']): string | null {
    if (!usage || !Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) {
        return null;
    }
    const pct = Math.max(0, Math.min(100, (usage.cachedTokens / usage.inputTokens) * 100));
    return `${pct.toFixed(1)}%`;
}

export function SdkPlaygroundPane({ store, isMobile }: SdkPlaygroundPaneProps) {
    const sideSessions = useSideGenStoreSlice(store, (s) => s.sideSessions);
    const settings = useSideGenStoreSlice(store, (s) => s.settings);
    const activeTarget = useSideGenStoreSlice(store, (s) => s.activeTarget);
    const defaultDelivery = settings.offMainline?.defaultDelivery ?? 'radar_hint';

    const [mode, setMode] = useState<SdkMode>(() =>
        sideSessions.length > 0 ? 'send' : 'runOnce',
    );
    const [selectedSessionId, setSelectedSessionId] = useState<string>(
        () => sideSessions[0]?.id ?? CUSTOM_SESSION_SENTINEL,
    );
    const [customSessionId, setCustomSessionId] = useState<string>('phone:linwan');
    const [systemPrompt, setSystemPrompt] = useState<string>(
        '你是不在主线现场的线外 NPC，仅基于已知信息简洁回复，不泄露未告知主线的私密设定。',
    );
    const [prompt, setPrompt] = useState<string>(
        '今晚十点老码头灯塔下见，把备用门禁卡带上。',
    );
    const [mainChatDepthText, setMainChatDepthText] = useState<string>('4');
    const [includeVars, setIncludeVars] = useState<boolean>(false);
    const [connectionId, setConnectionId] = useState<string>('inherit');

    // Optional `/side/*` bridge configuration for `runOnce()`.
    const [enableBridge, setEnableBridge] = useState<boolean>(false);
    const [bridgePath, setBridgePath] = useState<string>('/side/notes/playground-clue.md');
    const [bridgeDelivery, setBridgeDelivery] = useState<SideClueDelivery>(defaultDelivery);
    const [bridgeTitle, setBridgeTitle] = useState<string>('线外试跑线索');
    const [bridgeKeywordsText, setBridgeKeywordsText] = useState<string>('老码头, 灯塔');

    // Live execution state.
    const [running, setRunning] = useState<boolean>(false);
    const [lastResult, setLastResult] = useState<SideGenResult | null>(null);
    const [lastError, setLastError] = useState<string | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Abort in-flight request on unmount.
    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort('unmount');
            abortControllerRef.current = null;
        };
    }, []);

    // Keep session selection synced when sessions list changes.
    useEffect(() => {
        if (sideSessions.length === 0) {
            return;
        }
        if (
            selectedSessionId !== CUSTOM_SESSION_SENTINEL
            && !sideSessions.some((s) => s.id === selectedSessionId)
        ) {
            setSelectedSessionId(sideSessions[0].id);
        }
    }, [selectedSessionId, sideSessions]);

    const effectiveSessionId = useMemo(() => {
        if (selectedSessionId === CUSTOM_SESSION_SENTINEL || sideSessions.length === 0) {
            return customSessionId.trim();
        }
        return selectedSessionId;
    }, [customSessionId, selectedSessionId, sideSessions.length]);

    const parsedDepth = useMemo(() => {
        const trimmed = mainChatDepthText.trim();
        if (!trimmed) {
            return 0;
        }
        const n = Number(trimmed);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }, [mainChatDepthText]);

    const parsedBridgeKeywords = useMemo(
        () => parseKeywordsInput(bridgeKeywordsText),
        [bridgeKeywordsText],
    );

    const sessionOptions = useMemo(() => {
        const opts = sideSessions.map((ss) => ({
            value: ss.id,
            label: `${ss.id} (${ss.title})`,
        }));
        opts.push({
            value: CUSTOM_SESSION_SENTINEL,
            label: sideSessions.length === 0
                ? '自定义会话 ID（当前暂无已建会话）'
                : '手动输入其他会话 ID…',
        });
        return opts;
    }, [sideSessions]);

    const connectionOptions = useMemo(
        () => [
            { value: 'inherit', label: '跟随主连接 (inherit)' },
            ...Object.values(settings.connections).map((conn) => ({
                value: conn.id,
                label: `${conn.name}${conn.model ? ` (${conn.model})` : ''}`,
            })),
        ],
        [settings.connections],
    );

    const generatedSnippet = useMemo(() => {
        if (mode === 'runOnce') {
            const lines: string[] = ['const res = await Agentic.sideGen.runOnce({'];
            if (systemPrompt.trim()) {
                lines.push(`  systemPrompt: ${JSON.stringify(systemPrompt.trim())},`);
            }
            lines.push(`  prompt: ${JSON.stringify(prompt)},`);
            if (parsedDepth > 0) {
                lines.push(`  mainChatDepth: ${parsedDepth},`);
            }
            if (includeVars) {
                lines.push('  includeVars: true,');
            }
            if (connectionId && connectionId !== 'inherit') {
                lines.push(`  connectionId: ${JSON.stringify(connectionId)},`);
            }
            if (enableBridge && bridgePath.trim()) {
                lines.push('  bridge: {');
                lines.push(`    path: ${JSON.stringify(bridgePath.trim())},`);
                lines.push(`    delivery: ${JSON.stringify(bridgeDelivery)},`);
                if (bridgeTitle.trim()) {
                    lines.push(`    title: ${JSON.stringify(bridgeTitle.trim())},`);
                }
                if (parsedBridgeKeywords.length > 0) {
                    lines.push(`    keywords: ${JSON.stringify(parsedBridgeKeywords)},`);
                }
                lines.push('  },');
            }
            lines.push('});');
            return lines.join('\n');
        }

        const targetId = effectiveSessionId || 'phone:linwan';
        const optLines: string[] = [];
        if (parsedDepth > 0) {
            optLines.push(`  mainChatDepth: ${parsedDepth},`);
        }
        if (includeVars) {
            optLines.push('  includeVars: true,');
        }
        if (connectionId && connectionId !== 'inherit') {
            optLines.push(`  connectionId: ${JSON.stringify(connectionId)},`);
        }

        if (optLines.length === 0) {
            return `const res = await Agentic.sideGen.send(${JSON.stringify(targetId)}, ${JSON.stringify(prompt)});`;
        }

        return [
            `const res = await Agentic.sideGen.send(${JSON.stringify(targetId)}, ${JSON.stringify(prompt)}, {`,
            ...optLines,
            '});',
        ].join('\n');
    }, [
        bridgeDelivery,
        bridgePath,
        bridgeTitle,
        connectionId,
        effectiveSessionId,
        enableBridge,
        includeVars,
        mode,
        parsedBridgeKeywords,
        parsedDepth,
        prompt,
        systemPrompt,
    ]);

    const runtime = store.getSideGenRuntime();
    const hasConfiguredConnection = Object.keys(settings.connections).length > 0;

    const handleCopySnippet = async () => {
        const ok = await copyTextSafe(generatedSnippet);
        store.pushToast(
            ok ? '已复制 Agentic.sideGen JS 代码片段' : '复制失败，请手动选中复制',
            ok ? 'success' : 'warning',
        );
    };

    const handleAbort = () => {
        abortControllerRef.current?.abort('user_cancelled');
    };

    const handleRun = async () => {
        if (running) {
            return;
        }
        const activeRuntime = store.getSideGenRuntime();
        if (!activeRuntime) {
            setLastError(
                'SideGen 运行时尚未接入当前控制台（预览或未装配状态）。你仍可调整参数并点击「复制 JS 代码」粘贴至角色卡脚本使用。',
            );
            store.pushToast('SideGen 运行时未就绪', 'warning');
            return;
        }

        if (!prompt.trim()) {
            setLastError('请输入提示词 / 消息内容后再试跑。');
            return;
        }

        if (mode === 'send' && !effectiveSessionId) {
            setLastError('请先选择或输入目标持久会话 ID，或切换为 runOnce() 模式。');
            return;
        }

        if (mode === 'runOnce' && enableBridge && !bridgePath.trim().startsWith('/side/')) {
            setLastError('桥接路径必须以 /side/ 开头（例如 /side/notes/clue.md）。');
            return;
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;
        setRunning(true);
        setLastError(null);

        try {
            let result: SideGenResult;
            if (mode === 'runOnce') {
                const opts: SideGenOnceOptions = {
                    prompt,
                    ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
                    ...(connectionId !== 'inherit' ? { connectionId } : {}),
                    ...(parsedDepth > 0 ? { mainChatDepth: parsedDepth } : {}),
                    ...(includeVars ? { includeVars: true } : {}),
                    ...(enableBridge && bridgePath.trim()
                        ? {
                            bridge: {
                                path: bridgePath.trim(),
                                delivery: bridgeDelivery,
                                ...(bridgeTitle.trim() ? { title: bridgeTitle.trim() } : {}),
                                ...(parsedBridgeKeywords.length > 0
                                    ? { keywords: parsedBridgeKeywords }
                                    : {}),
                            },
                        }
                        : {}),
                    signal: controller.signal,
                };
                result = await activeRuntime.runOnce(opts);
            } else {
                const sendOpts: SideGenSendOptions = {
                    ...(connectionId !== 'inherit' ? { connectionId } : {}),
                    ...(parsedDepth > 0 ? { mainChatDepth: parsedDepth } : {}),
                    ...(includeVars ? { includeVars: true } : {}),
                    signal: controller.signal,
                };
                result = await activeRuntime.send(effectiveSessionId, prompt, sendOpts);
            }

            setLastResult(result);
            await store.refreshSideGenState(activeTarget);
            store.pushToast(
                mode === 'runOnce'
                    ? `runOnce() 执行完成 (${formatDurationMs(result.durationMs)})`
                    : `send("${effectiveSessionId}") 执行完成 (${formatDurationMs(result.durationMs)})`,
                'success',
            );
        } catch (err) {
            const msg = formatErrorMessage(err);
            setLastError(msg);
            store.pushToast(`SDK 试跑失败：${msg}`, 'error');
        } finally {
            abortControllerRef.current = null;
            setRunning(false);
        }
    };

    const handleJumpToBridgedClue = (path: string) => {
        store.setSideGenSubTab('clues');
        if (isMobile) {
            store.openSideClue(path);
        } else {
            store.setSelectedSideCluePath(path);
        }
    };

    const resultCacheRate = computeCacheRateLabel(lastResult?.usage);

    return (
        <div class="ag-view-scroll ag-thin-scroll">
            <div class="ag-stack-v">
                {!runtime ? (
                    <div class="ag-banner ag-banner-warning">
                        当前处于未连接 SideGen 运行时状态（如独立 UI 预览）。你可以自由配置参数并一键复制标准{' '}
                        <code class="ag-mono">Agentic.sideGen.*</code> JS 代码；实跑调用需先完成运行时装配与 API 连接配置。
                    </div>
                ) : !hasConfiguredConnection ? (
                    <div class="ag-banner ag-banner-warning">
                        尚未检测到可用的 API 连接，请先在「API 连接」页签配置模型连接后再试跑。
                    </div>
                ) : null}

                <div class="ag-grid-2">
                    <FormField label="调用模式">
                        <SelectInput<SdkMode>
                            ariaLabel="SDK 调用模式"
                            value={mode}
                            options={SDK_MODE_OPTIONS}
                            disabled={running}
                            onChange={(nextMode) => {
                                setMode(nextMode);
                                setLastError(null);
                            }}
                        />
                    </FormField>

                    <FormField label="API 连接 (connectionId)">
                        <SelectInput
                            ariaLabel="试跑 API 连接"
                            value={connectionId}
                            options={connectionOptions}
                            disabled={running}
                            onChange={setConnectionId}
                        />
                    </FormField>
                </div>

                {mode === 'send' ? (
                    <div class="ag-stack-v">
                        <FormField
                            label="目标线外会话 (sessionId)"
                            hint="复用 TrajectoryStore 线程键 side:<id>，0 占用主线上下文"
                        >
                            <SelectInput
                                ariaLabel="目标线外会话"
                                value={
                                    sideSessions.length === 0
                                        ? CUSTOM_SESSION_SENTINEL
                                        : selectedSessionId
                                }
                                options={sessionOptions}
                                disabled={running}
                                onChange={setSelectedSessionId}
                            />
                        </FormField>

                        {(selectedSessionId === CUSTOM_SESSION_SENTINEL
                            || sideSessions.length === 0) ? (
                            <FormField
                                label="手动指定会话 ID"
                                hint={
                                    sideSessions.length === 0
                                        ? '提示：请先在「线外会话」页签新建会话，或切换为 runOnce() 一次性试跑。'
                                        : '输入已存在的 SideSession ID'
                                }
                            >
                                <TextInput
                                    ariaLabel="手动指定会话 ID"
                                    value={customSessionId}
                                    placeholder="例如：phone:linwan"
                                    disabled={running}
                                    onInput={setCustomSessionId}
                                />
                            </FormField>
                        ) : null}
                    </div>
                ) : (
                    <FormField
                        label="系统提示词 (systemPrompt)"
                        hint="仅本次 runOnce() 生效，不建立持久线程，默认 0 状态残留"
                    >
                        <TextAreaInput
                            ariaLabel="系统提示词"
                            value={systemPrompt}
                            rows={3}
                            placeholder="描述线外场景角色与视角隔离规则…"
                            disabled={running}
                            onInput={setSystemPrompt}
                        />
                    </FormField>
                )}

                <FormField label="输入提示词 / 消息 (prompt)" required>
                    <TextAreaInput
                        ariaLabel="输入提示词"
                        value={prompt}
                        rows={3}
                        placeholder="输入发给线外模型的内容…"
                        disabled={running}
                        onInput={setPrompt}
                    />
                </FormField>

                <div class="ag-grid-2">
                    <FormField
                        label="只读附带主线最近楼层数 (mainChatDepth)"
                        hint="0 表示不附带主线消息，仅纯线外上下文"
                    >
                        <TextInput
                            ariaLabel="附带主线楼层数"
                            type="number"
                            min={0}
                            max={50}
                            value={mainChatDepthText}
                            disabled={running}
                            onInput={setMainChatDepthText}
                        />
                    </FormField>

                    <div style={{ display: 'flex', alignItems: 'center' }}>
                        <ToggleSwitch
                            checked={includeVars}
                            disabled={running}
                            label="附带分支变量快照 (includeVars)"
                            description="以只读方式注入当前 /state/variables.json"
                            onChange={setIncludeVars}
                        />
                    </div>
                </div>

                {mode === 'runOnce' ? (
                    <div class="ag-stack-v">
                        <ToggleSwitch
                            checked={enableBridge}
                            disabled={running}
                            label="将本次结果桥接沉淀到 /side/* 线索 (bridge)"
                            description="开启后按所选投递策略写入当前分支 /side/* 文件"
                            onChange={setEnableBridge}
                        />

                        {enableBridge ? (
                            <div
                                class="ag-stack-v"
                                style={{
                                    padding: '12px',
                                    borderRadius: '10px',
                                    border: '1px solid var(--border)',
                                    background: 'var(--content)',
                                }}
                            >
                                <div class="ag-grid-2">
                                    <FormField label="桥接路径 (/side/*)" required>
                                        <TextInput
                                            ariaLabel="桥接路径"
                                            value={bridgePath}
                                            placeholder="/side/notes/playground-clue.md"
                                            disabled={running}
                                            onInput={setBridgePath}
                                        />
                                    </FormField>
                                    <FormField label="投递策略 (delivery)">
                                        <SelectInput<SideClueDelivery>
                                            ariaLabel="桥接投递策略"
                                            value={bridgeDelivery}
                                            options={DELIVERY_SELECT_OPTIONS}
                                            disabled={running}
                                            onChange={setBridgeDelivery}
                                        />
                                    </FormField>
                                </div>
                                <div class="ag-grid-2">
                                    <FormField label="线索标题 (title)">
                                        <TextInput
                                            ariaLabel="桥接线索标题"
                                            value={bridgeTitle}
                                            placeholder="可选"
                                            disabled={running}
                                            onInput={setBridgeTitle}
                                        />
                                    </FormField>
                                    <FormField label="雷达关键词 (keywords)" hint="逗号分隔">
                                        <TextInput
                                            ariaLabel="桥接关键词"
                                            value={bridgeKeywordsText}
                                            placeholder="例如：老码头, 灯塔"
                                            disabled={running}
                                            onInput={setBridgeKeywordsText}
                                        />
                                    </FormField>
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}

                <div class="ag-row-wrap">
                    {running ? (
                        <Button
                            variant="danger"
                            size="sm"
                            icon={<IconClose size={14} />}
                            onClick={handleAbort}
                        >
                            ■ 取消试跑
                        </Button>
                    ) : (
                        <Button
                            variant="primary"
                            size="sm"
                            icon={<IconPlay size={14} />}
                            onClick={() => {
                                void handleRun();
                            }}
                        >
                            ▶ 执行 SDK 试跑
                        </Button>
                    )}

                    <Button
                        variant="secondary"
                        size="sm"
                        icon={<IconCopy size={14} />}
                        onClick={() => {
                            void handleCopySnippet();
                        }}
                    >
                        📋 复制 Agentic.sideGen 代码
                    </Button>
                </div>

                {/* Generated Author SDK Snippet */}
                <div class="ag-stack-v" style={{ gap: '6px' }}>
                    <div
                        class="ag-row"
                        style={{
                            justifyContent: 'space-between',
                            fontSize: '12px',
                            color: 'var(--muted-foreground)',
                        }}
                    >
                        <span class="ag-row" style={{ gap: '6px', fontWeight: 600 }}>
                            <IconCode size={14} />
                            <span>角色卡脚本调用代码（可直接粘贴使用）</span>
                        </span>
                    </div>
                    <pre class="ag-pre" style={{ color: 'var(--primary)' }}>
                        {generatedSnippet}
                    </pre>
                </div>

                {/* Error Feedback */}
                {lastError ? (
                    <div class="ag-banner ag-banner-error" role="alert">
                        {lastError}
                    </div>
                ) : null}

                {/* Live Execution Output */}
                {lastResult ? (
                    <div class="ag-stack-v" style={{ gap: '8px' }}>
                        <div class="ag-row-wrap" style={{ gap: '6px' }}>
                            <Badge tone="success">
                                耗时 {formatDurationMs(lastResult.durationMs)}
                            </Badge>
                            {lastResult.sessionId ? (
                                <Badge tone="primary">会话 {lastResult.sessionId}</Badge>
                            ) : (
                                <Badge tone="neutral">一次性 · 0 线程残留</Badge>
                            )}
                            {lastResult.usage ? (
                                <Badge tone="neutral">
                                    输入 {formatTokenCount(lastResult.usage.inputTokens)} / 缓存{' '}
                                    {formatTokenCount(lastResult.usage.cachedTokens)} / 输出{' '}
                                    {formatTokenCount(lastResult.usage.outputTokens)} tok
                                    {resultCacheRate ? ` (${resultCacheRate})` : ''}
                                </Badge>
                            ) : null}
                            {lastResult.bridgedPath ? (
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={() => handleJumpToBridgedClue(lastResult.bridgedPath!)}
                                >
                                    已桥接：{lastResult.bridgedPath} →
                                </Button>
                            ) : null}
                        </div>

                        <div class="ag-side-sdk-output" data-sdk-output="true">
                            {lastResult.text || '(空输出)'}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
