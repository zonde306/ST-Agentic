import {
    buildPresetFromPromptsImport,
    DEFAULT_MAIN_AGENT_TOOLS,
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
    exportPreset,
    importConnections,
    importSettings,
    normalizePreset,
    normalizeSettings,
    validateConnectionsImport,
    validatePresetImport,
    validatePromptsImport,
    validateSettingsImport,
} from '@/core/config';
import {
    importSillyTavernOpenAIPreset,
    isLegacyCustomGenerationData,
    isSillyTavernOpenAIPreset,
    migrateFromCustomGeneration,
    migrateLegacyPreset,
} from '@/core/migration';
import type {
    AgentRunTrace,
    ApiConnection,
    AssistantCompactOptions,
    AssistantCompactReport,
    AssistantCompactionNotice,
    AssistantMessage,
    AssistantSession,
    AssistantSessionTokenStatus,
    AssistantTokenLevel,
    BackgroundTaskStatus,
    ClassifiedLoreEntry,
    CompactionReport,
    CustomToolConfig,
    GenerationEventPayload,
    MessageTarget,
    PendingApproval,
    Settings,
    UndoRecord,
    WICategory,
} from '@/core/types';
import type {
    AgentWatermarkStatus,
    AgenticUIServices,
    AssistantRuntimeBridge,
    ConnectionModelsResult,
    ConnectionTestResult,
    EmbeddedCardStatus,
    FileOverrideItem,
    ImportPresetResult,
    RemoteModelInfo,
    ResolvedTheme,
    StorageOverview,
    ToastTone,
    ToolTestResult,
} from './app-store';

export function createMockSettings(): Settings {
    const connMain = createDefaultConnection({
        id: 'conn_claude',
        name: '主力写作 (Claude / OpenRouter)',
        providerFormat: 'anthropic',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'anthropic/claude-sonnet-4.5',
        contextSize: 200000,
        maxTokens: 4096,
        temperature: 0.75,
        maxConcurrency: 3,
        cachePolicy: 'anthropic_explicit',
        maxCacheBreakpoints: 4,
        stream: true,
        systemInstructionMode: 'native',
        strictToolLoop: false,
        roundMaxRetries: 2,
        includeHeaders: { 'HTTP-Referer': 'https://sillytavern.local' },
    });

    const connFlash = createDefaultConnection({
        id: 'conn_flash',
        name: '后台快模型 (Gemini Flash)',
        providerFormat: 'openai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash',
        contextSize: 128000,
        maxTokens: 2048,
        temperature: 0.2,
        maxConcurrency: 6,
        cachePolicy: 'auto_prefix',
        stream: false,
        systemInstructionMode: 'native',
        strictToolLoop: false,
        roundMaxRetries: 2,
    });

    const connLocal = createDefaultConnection({
        id: 'conn_local',
        name: '本地模型 (LM Studio)',
        providerFormat: 'openai',
        baseUrl: 'http://127.0.0.1:1234/v1',
        model: 'qwen3-32b-instruct',
        contextSize: 32768,
        maxTokens: 2048,
        temperature: 0.7,
        maxConcurrency: 1,
        cachePolicy: 'auto_prefix',
        stream: true,
        systemInstructionMode: 'native',
        strictToolLoop: false,
        roundMaxRetries: 2,
    });

    const mainAgent = createDefaultMainAgent({
        id: 'main',
        name: '主叙事 Agent',
        connectionId: 'inherit',
        sessionMode: 'persistent',
        strictToolLoop: 'inherit',
        watermark: { high: 36000, low: 18000 },
        enabledTools: [...DEFAULT_MAIN_AGENT_TOOLS],
        permissions: { read: ['/**'], write: ['/output.md', '/memory/**', '/scratch/**'] },
        promptBlocks: [
            {
                id: 'b1',
                name: '通用叙事底座与 Pull 准则',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content:
                    '你基于挂载在 /character/、/lorebooks/ 与 /state/ 中的设定体系运转。涉及专有名词、历史伏笔或角色属性时，请优先调用 read_file 或 search_files 查证后再动笔，不要凭常识编造。',
            },
            {
                id: 'b2',
                name: '文风规范：古风白描与防抢话',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content:
                    '保持第三人称沉浸式描写；严禁代替用户控制主角行动或内心独白；每段动作描写注重环境细节呼应。',
            },
            {
                id: 'b3',
                name: '尾部状态与雷达注意提醒',
                role: 'system',
                placement: 'tail',
                enabled: true,
                content:
                    '<lore-hint> 中包含与当前输入字面匹配的未读条目，可能是日常词汇误报，仅在剧情确实需要时 read_file。',
            },
        ],
    });

    const varsAgent = createDefaultMainAgent({
        id: 'ag_vars',
        name: '变量管家',
        connectionId: 'conn_flash',
        sessionMode: 'persistent',
        strictToolLoop: 'inherit',
        watermark: { high: 16000, low: 6000 },
        enabledTools: ['read_variables', 'patch_variables', 'read_file'],
        permissions: { read: ['/state/variables.json', '/lorebooks/**'], write: ['/state/variables.json'] },
        promptBlocks: [
            {
                id: 'bv1',
                name: '变量结算职责',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content:
                    '根据最新一轮对话中的行动、消耗与人物态度变化，调用 patch_variables 对 /state/variables.json 做增量更新；若无变化则直接结束。',
            },
        ],
    });

    const illustAgent = createDefaultMainAgent({
        id: 'ag_illust',
        name: '插图导演',
        connectionId: 'conn_flash',
        sessionMode: 'ephemeral',
        ephemeralWindowSize: 4,
        strictToolLoop: 'inherit',
        enabledTools: ['read_file', 'comfy_illustrate'],
        permissions: { read: ['/character/**', '/lorebooks/**'], write: [] },
        promptBlocks: [
            {
                id: 'bi1',
                name: '构图与 Tag 提取',
                role: 'system',
                placement: 'prefix',
                enabled: true,
                content:
                    '阅读本轮最富画面感的场景，查阅角色外貌档案后调用 comfy_illustrate 生成插图并自动挂载。',
            },
        ],
    });

    const defaultPreset = createDefaultPreset({
        id: 'preset_ensemble',
        name: '群像通用 Agent 预设',
        mainAgentId: 'main',
        agents: {
            main: mainAgent,
            ag_vars: varsAgent,
            ag_illust: illustAgent,
        },
        triggers: [
            {
                id: 'tr_before',
                label: '世界事件推演',
                source: 'worldinfo',
                phase: 'before_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_vars',
                kind: 'agent',
                decorator: '@@trigger',
                condition: { type: 'always' },
                instructionTemplate: '前置检查时间流逝与宗门事件触发',
                enabled: true,
            },
            {
                id: 'tr_main',
                label: '主叙事生成通道',
                source: 'preset',
                phase: 'main_turn',
                order: 0,
                barrier: 'turn',
                agentProfileId: 'main',
                kind: 'agent',
                condition: { type: 'always' },
                instructionTemplate: '主叙事生成通道（流式输出）',
                enabled: true,
            },
            {
                id: 'tr_vars',
                label: '好感与灵力结算',
                source: 'worldinfo',
                phase: 'after_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_vars',
                kind: 'agent',
                decorator: '@@variables_jsonpatch',
                targetPath: '/state/variables.json',
                condition: { type: 'always' },
                instructionTemplate: '结算灵力/好感/线索变量，下一轮前必等落盘',
                enabled: true,
            },
            {
                id: 'tr_outline',
                label: '大纲与伏笔记录',
                source: 'preset',
                phase: 'after_turn',
                order: 2,
                barrier: 'self',
                agentProfileId: 'ag_vars',
                kind: 'agent',
                decorator: '@@trigger',
                condition: { type: 'interval', interval: 2 },
                instructionTemplate: '写 /memory/outline.md，自身队列串行不卡下一轮打字',
                enabled: true,
            },
            {
                id: 'tr_illust',
                label: '场景插图导演',
                source: 'worldinfo',
                phase: 'after_turn',
                order: 3,
                barrier: 'none',
                agentProfileId: 'ag_illust',
                kind: 'agent',
                decorator: '@@trigger',
                condition: { type: 'regex', pattern: '/(月色|战斗|对峙)/' },
                instructionTemplate: '完全脱离后台生成，完成后严格回填到触发楼层',
                enabled: true,
            },
            {
                id: 'tr_compact',
                label: 'Watermark Compaction',
                source: 'preset',
                phase: 'maintenance',
                order: 1,
                barrier: 'self',
                agentProfileId: 'main',
                kind: 'script',
                condition: { type: 'always' },
                instructionTemplate: '跨过高水位时原子分块归档 /history/chunk-*.md',
                enabled: true,
            },
        ],
        regexRules: [
            {
                id: 'rx_status',
                name: '剥除历史内联状态注释',
                stage: 'ingest',
                pattern: '/<!--\\s*status:[\\s\\S]*?-->/g',
                replace: '',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'rx_think',
                name: '思考块样式折叠美化',
                stage: 'display',
                pattern: '/<think>([\\s\\S]*?)<\\/think>/g',
                replace: '[思考已折叠: $1]',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'rx_lore',
                name: '移除世界书作者注释',
                stage: 'lore_read',
                pattern: '/\\[作者注:[^\\]]*\\]/g',
                replace: '',
                applyToUser: false,
                applyToAssistant: false,
                enabled: true,
            },
        ],
        customTools: [
            {
                id: 't_comfy',
                name: 'comfy_illustrate',
                kind: 'js',
                description: '根据剧情画面构思提示词并调用本地 ComfyUI 生成插图挂载到当前消息',
                enabled: true,
                allowNetwork: true,
                code: `export default defineTool({
  name: 'comfy_illustrate',
  description: '根据当前剧情生成插图并挂载到本轮回复中',
  parameters: z.object({
    positivePrompt: z.string(),
    aspectRatio: z.enum(['portrait', 'landscape', 'square']).default('portrait'),
  }),
  async execute(args, ctx) {
    const url = '/user/images/comfy_mock_12.png';
    await ctx.message.attachMedia({ type: 'image', url });
    return \`插图已挂载至 #\${ctx.target.messageId}#\${ctx.target.swipeId}: \${url}\`;
  },
});`,
            },
            {
                id: 't_tts',
                name: 'voice_narrate',
                kind: 'slash_bridge',
                description: '调用酒馆 TTS 插件为关键对白生成角色语音并挂载到消息',
                enabled: true,
                commandTemplate: '/tts {{charName}} {{line}}',
                params: [
                    { name: 'charName', type: 'string', description: '说话角色名', required: true },
                    { name: 'line', type: 'string', description: '需要配音的对白台词', required: true },
                ],
            },
        ],
        files: {
            'style_guide.md': '# 文风手册\n- 禁用现代网络词汇\n- 动作描写优先于心理直白抒情',
            'init_variables.json': '{\n  "时间": "永历三年 · 秋分 申时",\n  "主角灵力": 90\n}',
        },
        wiRouterOverrides: {},
    });

    const singlePreset = createDefaultPreset({
        id: 'preset_solo',
        name: '单人深度扮演 (低开销)',
        mainAgentId: 'main',
    });

    return createDefaultSettings({
        runMode: 'takeover',
        themeMode: 'dark',
        capsulePosition: 'bottom',
        capsulePersistMode: 'keep',
        connections: {
            [connMain.id]: connMain,
            [connFlash.id]: connFlash,
            [connLocal.id]: connLocal,
        },
        currentConnectionId: connMain.id,
        presets: {
            [defaultPreset.id]: defaultPreset,
            [singlePreset.id]: singlePreset,
        },
        currentPresetId: defaultPreset.id,
    });
}

export function createMockTraces(): AgentRunTrace[] {
    const now = Date.now();
    return [
        {
            runId: 'run_12_main',
            target: { messageId: 12, swipeId: 0 },
            phase: 'main_turn',
            agentProfileId: 'main',
            agentName: '主叙事 Agent',
            connectionId: 'conn_claude',
            model: 'anthropic/claude-sonnet-4.5',
            status: 'completed',
            startedAt: now - 35000,
            endedAt: now - 33200,
            durationMs: 1800,
            usage: {
                inputTokens: 28420,
                cachedTokens: 27310,
                outputTokens: 640,
                totalTokens: 29060,
                cacheHitRate: 0.961,
            },
            toolSteps: [
                {
                    stepIndex: 0,
                    toolCallId: 'call_1',
                    toolName: 'read_file',
                    args: { path: '/lorebooks/玄幻世界/银莲花结社-12.md' },
                    result: '已返回 412 字（命中尾部雷达建议，已触发沙箱宏求值）',
                    ok: true,
                    durationMs: 12,
                    startedAt: now - 34950,
                },
                {
                    stepIndex: 1,
                    toolCallId: 'call_2',
                    toolName: 'read_file',
                    args: { path: '/state/variables.json' },
                    result: '{"地点":"青云宗 · 听竹小筑","林婉儿好感":62}',
                    ok: true,
                    durationMs: 4,
                    startedAt: now - 34900,
                },
            ],
            outputPreview: '夜风穿过竹梢，石井边缘那道极浅的银莲花刻痕在月色下泛起冷光……',
            requestSnapshot: {
                messages: [
                    { role: 'system', content: 'Layer 0 静态前缀 (14,200 tokens · Cache Breakpoint #0)' },
                    { role: 'user', content: '...Turn 1..11 冻结轨迹 (13,110 tokens · Cache Breakpoint #1)...' },
                    {
                        role: 'user',
                        content:
                            '我蹲下身摸向井沿刻痕。\n<lore-hint>- [未读] /lorebooks/玄幻世界/银莲花结社-12.md (命中: "银莲花", ~412字)</lore-hint>',
                    },
                ],
                tools: [
                    {
                        name: 'read_file',
                        description: 'Read a file from the VFS.',
                        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
                    },
                ],
                cacheBreakpoints: [0, 1],
            },
        },
        {
            runId: 'run_12_vars',
            target: { messageId: 12, swipeId: 0 },
            phase: 'after_turn',
            agentProfileId: 'ag_vars',
            agentName: '变量管家',
            triggerId: 'tr_vars',
            triggerLabel: '@@variables_jsonpatch',
            triggerSource: 'worldinfo',
            lorebookNames: ['玄幻世界'],
            connectionId: 'conn_flash',
            model: 'gemini-2.5-flash',
            status: 'completed',
            startedAt: now - 32000,
            endedAt: now - 31100,
            durationMs: 900,
            usage: {
                inputTokens: 6820,
                cachedTokens: 6480,
                outputTokens: 118,
                totalTokens: 6938,
                cacheHitRate: 0.95,
            },
            toolSteps: [
                {
                    stepIndex: 0,
                    toolCallId: 'call_vars_1',
                    toolName: 'patch_variables',
                    args: { ops: [{ op: 'replace', path: '/林婉儿好感', value: 62 }] },
                    result: 'Schema 校验通过，已原子写入 #12#0 暂存层',
                    ok: true,
                    durationMs: 6,
                    startedAt: now - 31800,
                },
            ],
        },
        {
            runId: 'run_10_main',
            target: { messageId: 10, swipeId: 0 },
            phase: 'main_turn',
            agentProfileId: 'main',
            agentName: '主叙事 Agent',
            connectionId: 'conn_claude',
            model: 'anthropic/claude-sonnet-4.5',
            status: 'completed',
            startedAt: now - 120000,
            endedAt: now - 118600,
            durationMs: 1400,
            usage: {
                inputTokens: 24910,
                cachedTokens: 23760,
                outputTokens: 520,
                totalTokens: 25430,
                cacheHitRate: 0.954,
            },
            toolSteps: [
                {
                    stepIndex: 0,
                    toolCallId: 'call_10_1',
                    toolName: 'search_files',
                    args: { query: '林婉儿 身世', topN: 3 },
                    result: '命中 2 条档案：/lorebooks/人物/林婉儿-03.md (0.91)',
                    ok: true,
                    durationMs: 9,
                    startedAt: now - 119900,
                },
            ],
            outputPreview: '林婉儿指尖微顿，并没有立刻回答你关于旧玉佩的试探。',
        },
    ];
}

export function createMockBackgroundTasks(): BackgroundTaskStatus[] {
    return [
        {
            taskId: 'task_12_illust',
            target: { messageId: 12, swipeId: 0 },
            phase: 'after_turn',
            barrier: 'none',
            agentProfileId: 'ag_illust',
            label: '插图生成中',
            state: 'running',
            startedAt: Date.now() - 8000,
            currentStep: 'comfy_illustrate (ComfyUI queue #3)',
        },
    ];
}

function createInitialMockFiles(): FileOverrideItem[] {
    return [
        {
            id: 'f_agents_ws',
            category: 'instructions',
            storageScope: 'chat_base',
            namespace: 'files',
            path: '/workspace/AGENTS.md',
            key: 'workspace/AGENTS.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '聊天规范层 (全分支)',
            source: 'user-edit',
            content:
                '# 本局叙事规范索引\n\n## 核心要求\n- 保持第三人称克制白描，禁止抢写 {{user}} 台词与心理。\n- 出场前先核对 `/state/variables.json` 中的灵力与位置。\n\n## 按需参考文档（遇到对应场景再 read_file）\n- 文风细节与禁用词表：`docs/writing-style.md`（实际路径 `/workspace/docs/writing-style.md`）\n',
            overridden: false,
            writable: true,
        },
        {
            id: 'f_docs_style',
            category: 'instructions',
            storageScope: 'chat_base',
            namespace: 'files',
            path: '/workspace/docs/writing-style.md',
            key: 'workspace/docs/writing-style.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '聊天规范层 (全分支)',
            source: 'assistant:write_file',
            content:
                '---\ndescription: 古风白描文风细则与动作描写规范\n---\n\n# 文风细则\n1. 环境描写控制在两句以内，优先推进人物对话与互动。\n2. 避免使用现代网络用语与过度感叹号。\n',
            overridden: false,
            writable: true,
        },
        {
            id: 'f_preset_agents',
            category: 'instructions',
            storageScope: 'preset',
            namespace: 'files',
            path: '/preset/AGENTS.md',
            key: 'AGENTS.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '预设参考 (/preset/*)',
            source: 'preset',
            content:
                '# 预设通用规范\n\n- 每次主线生成结束前必须自检 `/output.md` 的标签闭合与人称一致。\n',
            baseContent:
                '# 预设通用规范\n\n- 每次主线生成结束前必须自检 `/output.md` 的标签闭合与人称一致。\n',
            overridden: false,
            writable: true,
        },
        {
            id: 'f_global_agents',
            category: 'instructions',
            storageScope: 'global',
            namespace: 'files',
            path: '/global/AGENTS.md',
            key: 'AGENTS.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '全局规范 (/global/*)',
            source: 'global',
            content:
                '# 全局偏好\n\n- 默认保留叙事张力，不要在结尾强行升华总结。\n',
            baseContent:
                '# 全局偏好\n\n- 默认保留叙事张力，不要在结尾强行升华总结。\n',
            overridden: false,
            writable: true,
        },
        {
            id: 'f_shared_handoff',
            category: 'workspace',
            storageScope: 'chat_branch',
            namespace: 'files',
            path: '/workspace/shared/handoff.md',
            key: 'workspace/shared/handoff.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '#12#0',
            source: 'assistant:write_file',
            content:
                '# 跨 Agent 交接笔记\n\n- 用户希望接下来两轮把重心放在听竹小筑密道潜入，暂时不要直接揭晓黑衣人身份。\n',
            overridden: true,
            writable: true,
        },
        {
            id: 'f_vars',
            category: 'variables',
            namespace: 'variables',
            path: '/state/variables.json',
            key: 'variables.json',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '#12#0 (已提交)',
            source: 'patch_variables',
            content: JSON.stringify(
                {
                    时间: '永历三年 · 秋分 戌时',
                    地点: '青云宗 · 听竹小筑',
                    主角灵力: 84,
                    林婉儿好感: 62,
                    银莲花线索: ['枯井密道', '半枚玉佩'],
                },
                null,
                2,
            ),
            baseContent: JSON.stringify(
                {
                    时间: '永历三年 · 秋分 申时',
                    地点: '青云宗 · 山门',
                    主角灵力: 90,
                    林婉儿好感: 55,
                    银莲花线索: ['枯井密道'],
                },
                null,
                2,
            ),
            overridden: true,
            writable: true,
        },
        {
            id: 'f_wi_12',
            category: 'worldinfo',
            namespace: 'worldinfo',
            path: '/lorebooks/玄幻世界/银莲花结社-12.md',
            key: '玄幻世界/12',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: '#12#0 (WI 覆写)',
            source: '@@replace (after_turn)',
            content:
                '# 银莲花结社\n\n隐匿于各大仙门阴影中的地下组织。\n- 当前状态：**听竹小筑密道已被主角发现**\n- 警戒等级：中（尚未察觉主角持有半枚玉佩）',
            baseContent:
                '# 银莲花结社\n\n隐匿于各大仙门阴影中的地下组织。\n- 当前状态：休眠潜伏中\n- 警戒等级：低',
            overridden: true,
            writable: true,
        },
        {
            id: 'f_outline',
            category: 'workspace',
            namespace: 'files',
            path: '/memory/outline.md',
            key: '/memory/outline.md',
            target: { messageId: 11, swipeId: 0 },
            layerLabel: '#11#0',
            source: 'tool:write_file',
            content:
                '## 第三卷：秋分暗涌\n1. 山门偶遇林婉儿（已完成）\n2. 查探听竹小筑枯井异象（进行中）\n3. 宗门大比前夜暗杀伏笔（待触发）',
            baseContent: '## 第三卷：秋分暗涌\n1. 山门偶遇林婉儿（进行中）',
            overridden: true,
            writable: true,
        },
        {
            id: 'output:12#0',
            category: 'message',
            namespace: 'files',
            path: '/output.md',
            key: '/output.md',
            target: { messageId: 12, swipeId: 0 },
            layerLabel: 'L12#0',
            source: 'tool:write_file',
            content:
                '夜风穿过竹梢，石井边缘那道极浅的银莲花刻痕在月色下泛起冷光……\n\n<details><summary>📊 当前状态快照（不进入模型缓存前缀）</summary>\n灵力：84/100 | 林婉儿好感：62 | 地点：听竹小筑\n</details>',
            baseContent:
                '夜风穿过竹梢，石井边缘那道极浅的银莲花刻痕在月色下泛起冷光……',
            overridden: true,
            writable: true,
        },
    ];
}

function createInitialMockLore(): ClassifiedLoreEntry[] {
    return [
        {
            entry: {
                world: '玄幻世界',
                uid: 1,
                comment: '【规则】古风白描与防抢话指令',
                content: '保持第三人称沉浸式古风白描叙事。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 4,
                depth: 0,
                order: 100,
                role: 0,
            },
            category: 'system_rule',
            vfsPath: '/lorebooks/玄幻世界/规则古风白描与防抢话指令-1.md',
            slug: '规则古风白描与防抢话指令',
            decorators: [],
            cleanContent: '保持第三人称沉浸式古风白描叙事。',
            charCount: 420,
            reason: 'Constant @D0 system entry',
        },
        {
            entry: {
                world: '玄幻世界',
                uid: 2,
                comment: '主角林玄 · 人物总纲 (空壳卡核心)',
                content: '林玄，青云宗外门弟子，身怀半枚古玉佩。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 90,
                role: 0,
            },
            category: 'core_manifest',
            vfsPath: '/lorebooks/玄幻世界/主角林玄人物总纲-2.md',
            slug: '主角林玄人物总纲',
            decorators: [],
            cleanContent: '林玄，青云宗外门弟子，身怀半枚古玉佩。',
            charCount: 1380,
            reason: 'Hollow card core setting entry',
        },
        {
            entry: {
                world: '玄幻世界',
                uid: 12,
                comment: '银莲花结社-12',
                content: '隐匿于各大仙门阴影中的地下组织。',
                keys: ['银莲花', '密道'],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 50,
                role: 0,
            },
            category: 'on_demand_archive',
            vfsPath: '/lorebooks/玄幻世界/银莲花结社-12.md',
            slug: '银莲花结社',
            decorators: [],
            cleanContent: '隐匿于各大仙门阴影中的地下组织。',
            charCount: 412,
            reason: 'Keyword-triggered lore archive',
        },
        {
            entry: {
                world: '玄幻世界',
                uid: 20,
                comment: '@@variables_jsonpatch 好感与灵力结算',
                content: '根据剧情更新主角灵力与人物好感度。',
                keys: [],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 10,
                role: 0,
                decorators: ['@@variables_jsonpatch'],
            },
            category: 'dynamic_or_trigger',
            vfsPath: '/lorebooks/玄幻世界/好感与灵力结算-20.md',
            slug: '好感与灵力结算',
            decorators: [{ name: '@@variables_jsonpatch', rawArgs: '', args: [], params: {} }],
            cleanContent: '根据剧情更新主角灵力与人物好感度。',
            charCount: 290,
            reason: 'Contains @@variables_jsonpatch control decorator',
        },
    ];
}

interface MockSessionTokenMeta {
    currentTokens: number;
    contextLimit: number;
    highWatermark: number;
    lowWatermark: number;
    activeTurnCount: number;
    activeMessageCount: number;
    foldableToolResultCount: number;
    compactedCount: number;
    summaryPreview?: string;
    isCompacting?: boolean;
}

function computeMockTokenLevel(
    currentTokens: number,
    contextLimit: number,
    highWatermark: number,
): { usagePercent: number; level: AssistantTokenLevel } {
    const safeLimit = Math.max(1, contextLimit);
    const usagePercent = Math.max(0, Math.min(100, Math.round((currentTokens / safeLimit) * 100)));
    const level: AssistantTokenLevel =
        usagePercent >= 90 || currentTokens >= highWatermark
            ? 'danger'
            : usagePercent >= 70
                ? 'warning'
                : 'normal';
    return { usagePercent, level };
}

export interface CreateMockAssistantRuntimeOptions {
    initialSessions?: AssistantSession[];
    initialTokenMeta?: Record<string, Partial<MockSessionTokenMeta>>;
}

export function createMockAssistantRuntime(
    options: CreateMockAssistantRuntimeOptions = {},
): AssistantRuntimeBridge {
    const now = Date.now();
    const sessions: AssistantSession[] = options.initialSessions
        ? structuredClone(options.initialSessions)
        : [
            {
                id: 'ast_mock_main',
                title: '世界书路由与状态排查 (Mock)',
                mode: 'adjust',
                stAdminEnabled: false,
                autoApproveAuthor: false,
                autoApproveChatDelete: false,
                connectionId: 'inherit',
                updatedAt: now - 30_000,
                messages: [
                    {
                        id: 'ast_mock_m1',
                        role: 'user',
                        content: '请帮我核查当前世界书的触发路由，并确认变量快照与上下文水位。',
                        timestamp: now - 90_000,
                    },
                    {
                        id: 'ast_mock_m2',
                        role: 'assistant',
                        content:
                            '已核查 `/lorebooks/玄幻世界/` 与 `/state/variables.json`：当前主世界书按需归档路由正常，且已开启工具输出 `32 KB` 防爆闸门。',
                        think: '读取已启用的世界书目录清单与当前变量快照。',
                        toolCalls: [
                            {
                                id: 'call_mock_wi',
                                name: 'wi_read_enabled',
                                scopeLabel: 'World Info',
                                status: 'ok',
                                durationMs: 18,
                                argsSummary: '{"bookName":"玄幻世界"}',
                                resultSummary: '返回 4 条世界书摘要（~12.4 KB）',
                            },
                            {
                                id: 'call_mock_vars',
                                name: 'read_file',
                                scopeLabel: 'VFS',
                                status: 'ok',
                                durationMs: 7,
                                argsSummary: '{"path":"/state/variables.json"}',
                                resultSummary: '{"地点":"青云宗 · 听竹小筑","林婉儿好感":62}',
                            },
                        ],
                        fileRefs: ['/state/variables.json'],
                        usage: {
                            inputTokens: 24800,
                            cachedTokens: 21400,
                            outputTokens: 186,
                            cacheRate: '86.3%',
                        },
                        timestamp: now - 60_000,
                    },
                ],
            },
        ];

    const approvals: PendingApproval[] = [];
    const undoRecords: UndoRecord[] = [];
    const listeners = new Set<() => void>();
    const tokenMetaBySession = new Map<string, MockSessionTokenMeta>();

    const buildDefaultMeta = (session: AssistantSession): MockSessionTokenMeta => {
        const override = options.initialTokenMeta?.[session.id];
        const turns = Math.max(
            1,
            session.messages.filter((m) => m.role === 'user').length || 1,
        );
        const toolCount = session.messages.reduce(
            (sum, msg) => sum + (msg.toolCalls?.length ?? 0),
            0,
        );
        const estimated = session.messages.length === 0
            ? 860
            : Math.max(
                860,
                session.messages.reduce((sum, msg) => sum + Math.ceil(msg.content.length * 1.4), 0)
                    + toolCount * 11_600,
            );
        return {
            currentTokens: override?.currentTokens ?? (session.id === 'ast_mock_main' ? 24_800 : estimated),
            contextLimit: override?.contextLimit ?? 128_000,
            highWatermark: override?.highWatermark ?? 96_000,
            lowWatermark: override?.lowWatermark ?? 32_000,
            activeTurnCount: override?.activeTurnCount ?? turns,
            activeMessageCount: override?.activeMessageCount ?? Math.max(1, session.messages.length + toolCount * 2),
            foldableToolResultCount: override?.foldableToolResultCount ?? Math.max(0, toolCount),
            compactedCount: override?.compactedCount ?? 0,
            ...(override?.summaryPreview ? { summaryPreview: override.summaryPreview } : {}),
            isCompacting: Boolean(override?.isCompacting),
        };
    };

    for (const s of sessions) {
        tokenMetaBySession.set(s.id, buildDefaultMeta(s));
    }

    const ensureMeta = (session: AssistantSession): MockSessionTokenMeta => {
        const existing = tokenMetaBySession.get(session.id);
        if (existing) {
            return existing;
        }
        const created = buildDefaultMeta(session);
        tokenMetaBySession.set(session.id, created);
        return created;
    };

    const notify = () => {
        for (const listener of Array.from(listeners)) {
            try {
                listener();
            } catch {
                // Keep mock subscriber loop fault-tolerant.
            }
        }
    };

    return {
        listSessions: () => structuredClone(sessions),
        getSession: (sessionId) => {
            const found = sessions.find((s) => s.id === sessionId);
            return found ? structuredClone(found) : null;
        },
        async createSession(createOpts) {
            const created: AssistantSession = {
                id: `ast_mock_${Date.now().toString(36)}_${sessions.length + 1}`,
                title: createOpts?.title ?? `新助手会话 ${sessions.length + 1}`,
                mode: createOpts?.mode ?? 'chat',
                stAdminEnabled: Boolean(createOpts?.stAdminEnabled),
                autoApproveAuthor: Boolean(createOpts?.autoApproveAuthor),
                autoApproveChatDelete: Boolean(createOpts?.autoApproveChatDelete),
                connectionId: createOpts?.connectionId ?? 'inherit',
                updatedAt: Date.now(),
                messages: [],
            };
            sessions.unshift(created);
            tokenMetaBySession.set(created.id, buildDefaultMeta(created));
            notify();
            return structuredClone(created);
        },
        async deleteSession(sessionId) {
            const idx = sessions.findIndex((s) => s.id === sessionId);
            if (idx < 0) {
                return false;
            }
            sessions.splice(idx, 1);
            tokenMetaBySession.delete(sessionId);
            notify();
            return true;
        },
        async updateSessionConfig(sessionId, patch) {
            const idx = sessions.findIndex((s) => s.id === sessionId);
            if (idx < 0) {
                return null;
            }
            sessions[idx] = {
                ...sessions[idx],
                ...patch,
                updatedAt: Date.now(),
            };
            notify();
            return structuredClone(sessions[idx]);
        },
        async sendPrompt(sessionId, prompt, sendOpts) {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const ts = Date.now();
            session.messages.push({
                id: `ast_mock_u_${ts}_${session.messages.length}`,
                role: 'user',
                content: prompt,
                ...(sendOpts?.attachments?.length
                    ? { attachments: structuredClone(sendOpts.attachments) }
                    : {}),
                timestamp: ts,
            });
            sendOpts?.onUpdate?.(structuredClone(session));

            const reply: AssistantMessage = {
                id: `ast_mock_a_${ts + 1}_${session.messages.length}`,
                role: 'assistant',
                content: `已收到指令（Mock）：${prompt}`,
                timestamp: ts + 1,
            };
            session.messages.push(reply);
            session.updatedAt = ts + 1;

            const meta = ensureMeta(session);
            meta.currentTokens += Math.max(420, Math.ceil(prompt.length * 1.5) + 320);
            meta.activeTurnCount += 1;
            meta.activeMessageCount += 2;

            sendOpts?.onUpdate?.(structuredClone(session));
            notify();
            return structuredClone(reply);
        },
        async editMessage(sessionId, messageId, newContent) {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                return null;
            }
            const msg = session.messages.find((m) => m.id === messageId);
            if (!msg) {
                return null;
            }
            msg.content = newContent;
            if (msg.interrupted) {
                msg.interrupted = false;
            }
            session.updatedAt = Date.now();
            notify();
            return structuredClone(session);
        },
        async retractMessage(sessionId, messageId) {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                return null;
            }
            const idx = session.messages.findIndex((m) => m.id === messageId);
            if (idx < 0) {
                return null;
            }
            const removedMessages = structuredClone(session.messages.slice(idx));
            session.messages = session.messages.slice(0, idx);
            session.updatedAt = Date.now();
            const meta = ensureMeta(session);
            meta.currentTokens = Math.max(860, meta.currentTokens - removedMessages.length * 600);
            meta.activeTurnCount = Math.max(
                0,
                session.messages.filter((m) => m.role === 'user').length,
            );
            meta.activeMessageCount = session.messages.length;
            notify();
            return {
                session: structuredClone(session),
                removedMessages,
            };
        },
        async regenerateLastMessage(sessionId, sendOpts) {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            let lastUserIdx = -1;
            for (let i = session.messages.length - 1; i >= 0; i -= 1) {
                if (session.messages[i].role === 'user') {
                    lastUserIdx = i;
                    break;
                }
            }
            if (lastUserIdx < 0) {
                throw new Error('No user message available to regenerate.');
            }
            const userPrompt = session.messages[lastUserIdx].content;
            session.messages = session.messages.slice(0, lastUserIdx + 1);
            sendOpts?.onUpdate?.(structuredClone(session));
            const reply: AssistantMessage = {
                id: `ast_mock_regen_${Date.now()}`,
                role: 'assistant',
                content: `重新生成完成（Mock）：${userPrompt}`,
                timestamp: Date.now(),
            };
            session.messages.push(reply);
            session.updatedAt = reply.timestamp;
            notify();
            return structuredClone(reply);
        },
        async continueLastMessage(sessionId, sendOpts) {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            if (session.messages.length === 0) {
                throw new Error('No message available to continue.');
            }
            const lastMsg = session.messages[session.messages.length - 1];
            if (lastMsg.role === 'assistant') {
                const cleaned = lastMsg.content.startsWith('[Error] ')
                    ? ''
                    : lastMsg.content.replace(/\n\n\[Error\] [\s\S]*$/, '');
                const addition = cleaned.trim()
                    ? '\n\n已接着继续完成剩余内容（Mock）。'
                    : '已继续执行并完成回复（Mock）。';
                lastMsg.content = `${cleaned}${addition}`;
                delete lastMsg.interrupted;
                delete lastMsg.errorCode;
                delete lastMsg.errorMessage;
                delete lastMsg.canContinue;
                delete lastMsg.retryStatus;
                delete session.interruptedCheckpoint;
                session.updatedAt = Date.now();
                sendOpts?.onUpdate?.(structuredClone(session));
                notify();
                return structuredClone(lastMsg);
            }
            const reply: AssistantMessage = {
                id: `ast_mock_cont_${Date.now()}`,
                role: 'assistant',
                content: `已继续处理上一条指令（Mock）：${lastMsg.content}`,
                timestamp: Date.now(),
            };
            session.messages.push(reply);
            session.updatedAt = reply.timestamp;
            sendOpts?.onUpdate?.(structuredClone(session));
            notify();
            return structuredClone(reply);
        },
        abort: () => {
            // Mock no-op
        },
        listApprovals: () => structuredClone(approvals),
        async decideApproval() {
            return null;
        },
        async retryApproval() {
            return null;
        },
        listUndoRecords: () => structuredClone(undoRecords),
        async applyUndo() {
            return null;
        },
        async readPreviewFile(path) {
            return `只读预览（Mock）：${path}`;
        },
        getSessionTokenStatus(sessionId): AssistantSessionTokenStatus | null {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                return null;
            }
            const meta = ensureMeta(session);
            const { usagePercent, level } = computeMockTokenLevel(
                meta.currentTokens,
                meta.contextLimit,
                meta.highWatermark,
            );
            return {
                sessionId,
                currentTokens: meta.currentTokens,
                contextLimit: meta.contextLimit,
                highWatermark: meta.highWatermark,
                lowWatermark: meta.lowWatermark,
                usagePercent,
                level,
                activeTurnCount: meta.activeTurnCount,
                activeMessageCount: meta.activeMessageCount,
                foldableToolResultCount: meta.foldableToolResultCount,
                compactedCount: meta.compactedCount,
                ...(meta.summaryPreview ? { summaryPreview: meta.summaryPreview } : {}),
                isCompacting: Boolean(meta.isCompacting),
            };
        },
        async compactSession(
            sessionId: string,
            compactOptions: AssistantCompactOptions = {},
        ): Promise<AssistantCompactReport> {
            const session = sessions.find((s) => s.id === sessionId);
            if (!session) {
                throw new Error(`Session not found: ${sessionId}`);
            }
            const meta = ensureMeta(session);
            const ts = Date.now();
            const mode = compactOptions.mode ?? 'auto';
            const focus = compactOptions.focusInstruction?.trim();
            const tokensBefore = meta.currentTokens;

            if (mode === 'fold_only') {
                if (meta.foldableToolResultCount <= 0) {
                    return {
                        compacted: false,
                        reason: 'nothing_to_compact',
                        tokensBefore,
                        tokensAfter: tokensBefore,
                        foldedToolResults: 0,
                        archivedTurns: 0,
                        summaryMode: 'none',
                        timestamp: ts,
                    };
                }
                const folded = meta.foldableToolResultCount;
                const tokensAfter = Math.max(
                    860,
                    Math.round(tokensBefore * 0.58),
                );
                meta.foldableToolResultCount = 0;
                meta.currentTokens = tokensAfter;

                const notice: AssistantCompactionNotice = {
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns: 0,
                    summaryMode: 'fold_only',
                    timestamp: ts,
                };
                if (session.messages.length > 0) {
                    const last = session.messages[session.messages.length - 1];
                    session.messages[session.messages.length - 1] = {
                        ...last,
                        compactionNotice: notice,
                    };
                }
                session.updatedAt = ts;
                notify();

                return {
                    compacted: true,
                    reason: 'manual',
                    tokensBefore,
                    tokensAfter,
                    foldedToolResults: folded,
                    archivedTurns: 0,
                    summaryMode: 'fold_only',
                    timestamp: ts,
                };
            }

            const folded = meta.foldableToolResultCount;
            const archivedTurns = Math.max(1, meta.activeTurnCount - 1);
            const nextChunkNum = meta.compactedCount + 1;
            const archivedChunkPath = `/side/.assistant-archive/${sessionId}/chunk-${String(nextChunkNum).padStart(3, '0')}.md`;
            const targetLow = compactOptions.targetLowTokens ?? meta.lowWatermark;
            const tokensAfter = Math.max(
                860,
                Math.min(targetLow, Math.round(tokensBefore * 0.16)),
            );

            const summaryLines = [
                '1. 用户核心目标与当前进度：持续核查世界书按需路由与上下文防爆闸门状态。',
                '2. 已修改或读取的关键文件与对象：`/state/variables.json`、`/lorebooks/玄幻世界/`。',
                ...(focus ? [`3. 用户指定保留重点：${focus}`] : ['3. 已确认的约束与踩坑经验：保持界面聊天记录完整，仅精简模型轨迹上下文。']),
                '4. 待继续步骤：按精确过滤参数继续读取与调整目标条目。',
            ];
            const summaryText = summaryLines.join('\n');

            meta.currentTokens = tokensAfter;
            meta.foldableToolResultCount = 0;
            meta.activeTurnCount = 1;
            meta.activeMessageCount = Math.max(2, Math.min(meta.activeMessageCount, 3));
            meta.compactedCount = nextChunkNum;
            meta.summaryPreview = summaryText;

            const notice: AssistantCompactionNotice = {
                tokensBefore,
                tokensAfter,
                foldedToolResults: folded,
                archivedTurns,
                summaryMode: compactOptions.useLLMSummary === false ? 'deterministic' : 'llm',
                summaryText,
                ...(focus ? { focusInstruction: focus } : {}),
                archivedChunkPath,
                timestamp: ts,
            };

            if (session.messages.length > 0) {
                const last = session.messages[session.messages.length - 1];
                session.messages[session.messages.length - 1] = {
                    ...last,
                    compactionNotice: notice,
                };
            }
            session.updatedAt = ts;
            notify();

            return {
                compacted: true,
                reason: 'manual',
                tokensBefore,
                tokensAfter,
                foldedToolResults: folded,
                archivedTurns,
                archivedChunkPath,
                summaryMode: notice.summaryMode,
                summaryText,
                timestamp: ts,
            };
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export interface MockUIServicesOptions {
    getHostLuminance?: () => ResolvedTheme;
    onToast?: (message: string, tone: ToastTone) => void;
}

export function createMockUIServices(options: MockUIServicesOptions = {}): AgenticUIServices {
    let settingsSnapshot = createMockSettings();
    let files = createInitialMockFiles();
    const traces = createMockTraces();
    const eventListeners = new Set<(event: GenerationEventPayload) => void>();
    const emitEvent = (event: GenerationEventPayload) => {
        eventListeners.forEach((listener) => {
            try {
                listener(event);
            } catch {
                // Keep mock event dispatch fault-tolerant.
            }
        });
    };
    let watermarks: AgentWatermarkStatus[] = [
        {
            agentId: 'main',
            agentName: '主叙事 Agent',
            currentTokens: 31400,
            lowWatermark: 18000,
            highWatermark: 36000,
            archivedChunks: 2,
            summaryMode: '衔接用户 /memory/outline.md',
        },
        {
            agentId: 'ag_vars',
            agentName: '变量管家 (persistent)',
            currentTokens: 9200,
            lowWatermark: 6000,
            highWatermark: 16000,
            archivedChunks: 1,
            summaryMode: '内置兜底块压缩',
        },
        {
            agentId: 'ag_outline',
            agentName: '大纲记录员 (persistent)',
            currentTokens: 14800,
            lowWatermark: 8000,
            highWatermark: 20000,
            archivedChunks: 1,
            summaryMode: '衔接用户 /memory/outline.md',
        },
    ];
    let storageOverview: StorageOverview = {
        estimatedBytes: 2480 * 1024,
        activeLayers: 26,
        compactedWatermark: 4,
        keepDepth: 12,
        autoCompact: true,
        sizeThreshold: 256 * 1024,
        trajectoryBytes: 840 * 1024,
        trajectoryCheckpoints: 18,
    };
    const loreEntries = createInitialMockLore();
    let embeddedCardState: EmbeddedCardStatus = {
        characterName: '林婉儿 · 听竹小筑 (Mock)',
        hasPresets: true,
        hasFiles: true,
        fromLegacy: true,
        presetCount: 1,
        fileCount: 2,
    };

    return {
        async listFilesAndOverrides(target?: MessageTarget) {
            const visibleFiles = files.filter(
                (f) =>
                    !(
                        f.category === 'worldinfo'
                        && (!f.overridden
                            || (f.baseContent !== undefined
                                && f.content.replace(/\r\n/g, '\n') === f.baseContent.replace(/\r\n/g, '\n')))
                    ),
            );
            const scopedFiles = target
                ? visibleFiles.filter((f) => f.target.messageId <= target.messageId)
                : visibleFiles;
            const messageFiles = scopedFiles.filter((f) => f.category === 'message');
            if (messageFiles.length <= 1) {
                return scopedFiles.map((f) => ({ ...f }));
            }
            const keptMessage =
                (target
                    ? messageFiles.find(
                          (f) =>
                              f.target.messageId === target.messageId
                              && f.target.swipeId === target.swipeId,
                      ) ?? messageFiles.find((f) => f.target.messageId === target.messageId)
                    : undefined)
                ?? messageFiles.reduce((latest, candidate) => {
                    if (candidate.target.messageId !== latest.target.messageId) {
                        return candidate.target.messageId > latest.target.messageId ? candidate : latest;
                    }
                    return candidate.target.swipeId > latest.target.swipeId ? candidate : latest;
                });
            return scopedFiles
                .filter((f) => f.category !== 'message' || f === keptMessage)
                .map((f) => ({ ...f }));
        },

        async saveFileOrOverride(input) {
            const target = input.target ?? { messageId: 12, swipeId: 0 };
            const normalizedPath = input.path.startsWith('/') ? input.path : `/${input.path}`;
            const scope =
                input.storageScope
                ?? (normalizedPath.startsWith('/preset/')
                    ? 'preset'
                    : normalizedPath.startsWith('/global/')
                        ? 'global'
                        : normalizedPath === '/workspace/AGENTS.md'
                            || normalizedPath === '/AGENTS.md'
                            || normalizedPath.startsWith('/workspace/docs/')
                            ? 'chat_base'
                            : 'chat_branch');
            const existingIdx = files.findIndex(
                (f) =>
                    f.path === normalizedPath
                    && (f.path !== '/output.md'
                        || (f.target.messageId === target.messageId && f.target.swipeId === target.swipeId)),
            );
            if (existingIdx >= 0) {
                const updated: FileOverrideItem = {
                    ...files[existingIdx],
                    storageScope: scope,
                    content: input.content,
                    target,
                    source: 'user-edit',
                    overridden: scope === 'chat_branch' || files[existingIdx].overridden,
                };
                files[existingIdx] = updated;
                return { ...updated };
            }
            const isSpec =
                scope === 'preset'
                || scope === 'global'
                || normalizedPath === '/workspace/AGENTS.md'
                || normalizedPath === '/AGENTS.md'
                || normalizedPath.startsWith('/workspace/docs/');
            const category =
                normalizedPath === '/output.md'
                    ? 'message'
                    : input.namespace === 'variables'
                        ? 'variables'
                        : input.namespace === 'worldinfo'
                            ? 'worldinfo'
                            : input.namespace === 'message'
                                ? 'message'
                                : isSpec
                                    ? 'instructions'
                                    : 'workspace';
            const layerLabel =
                scope === 'preset'
                    ? '预设参考 (/preset/*)'
                    : scope === 'global'
                        ? '全局规范 (/global/*)'
                        : scope === 'chat_base'
                            ? '聊天规范层 (全分支)'
                            : `L${target.messageId}#${target.swipeId}`;
            const created: FileOverrideItem = {
                id:
                    normalizedPath === '/output.md'
                        ? `output:${target.messageId}#${target.swipeId}`
                        : `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                category,
                storageScope: scope,
                namespace: input.namespace,
                path: normalizedPath,
                key: input.key,
                target,
                layerLabel,
                source: scope === 'preset' ? 'preset' : scope === 'global' ? 'global' : 'user-edit',
                content: input.content,
                baseContent: scope === 'preset' || scope === 'global' ? input.content : '',
                overridden: scope === 'chat_branch',
                writable: true,
            };
            files = [created, ...files];
            return { ...created };
        },

        async deleteFileOrOverride(input) {
            const target = input.target;
            const normalizedPath = input.path.startsWith('/') ? input.path : `/${input.path}`;
            const isWorldInfo = input.namespace === 'worldinfo';
            if (!isWorldInfo && normalizedPath !== '/output.md' && input.namespace !== 'variables') {
                files = files.filter((f) => f.path !== normalizedPath);
                return;
            }
            files = files.map((f) => {
                if (
                    f.namespace === input.namespace
                    && f.key === input.key
                    && (!target
                        || f.path !== '/output.md'
                        || (f.target.messageId === target.messageId && f.target.swipeId === target.swipeId))
                ) {
                    return {
                        ...f,
                        content: f.baseContent ?? '',
                        overridden: false,
                        source: 'restored',
                    };
                }
                return f;
            });
        },

        async getWatermarkStatuses() {
            return watermarks.map((w) => ({ ...w }));
        },

        async compactAgentContext(agentId: string) {
            let updatedItem: AgentWatermarkStatus | undefined;
            watermarks = watermarks.map((w) => {
                if (w.agentId === agentId) {
                    updatedItem = {
                        ...w,
                        currentTokens: w.lowWatermark,
                        archivedChunks: w.archivedChunks + 1,
                    };
                    return updatedItem;
                }
                return w;
            });
            return updatedItem ?? { ...watermarks[0] };
        },

        async clearAllPromptCaches() {
            const loreWorlds = new Set(
                loreEntries.map((item) => item.entry.world).filter(Boolean),
            );
            return {
                clearedPrefixes: watermarks.length,
                clearedVfsCache: files.length,
                clearedLorebooks: Math.max(1, loreWorlds.size),
                clearedMessageCaches: watermarks.length * 2,
            };
        },

        async getStorageOverview() {
            return { ...storageOverview };
        },

        async previewColdCompaction(keepDepth?: number): Promise<CompactionReport> {
            const bytesBefore = storageOverview.estimatedBytes;
            const bytesAfter = Math.max(256 * 1024, Math.floor(bytesBefore * 0.52));
            const trajBefore = storageOverview.trajectoryBytes ?? 840 * 1024;
            const trajAfter = Math.max(128 * 1024, Math.floor(trajBefore * 0.35));
            return {
                dryRun: true,
                compactedMessages: Math.max(0, 12 - (keepDepth ?? storageOverview.keepDepth)),
                removedLayers: 8,
                flattenedEntries: 14,
                estimatedBytesBefore: bytesBefore,
                estimatedBytesAfter: bytesAfter,
                freedBytes: bytesBefore - bytesAfter,
                previousWatermark: storageOverview.compactedWatermark,
                newWatermark: 9,
                prunedScratchFiles: 3,
                prunedCheckpoints: 11,
                trajectoryBytesBefore: trajBefore,
                trajectoryBytesAfter: trajAfter,
            };
        },

        async runColdCompaction(keepDepth?: number): Promise<CompactionReport> {
            const report = await this.previewColdCompaction(keepDepth);
            storageOverview = {
                ...storageOverview,
                estimatedBytes: report.estimatedBytesAfter,
                activeLayers: Math.max(4, storageOverview.activeLayers - report.removedLayers),
                compactedWatermark: report.newWatermark,
                trajectoryBytes: report.trajectoryBytesAfter,
                trajectoryCheckpoints: Math.max(
                    1,
                    (storageOverview.trajectoryCheckpoints ?? 18) - (report.prunedCheckpoints ?? 0),
                ),
            };
            return {
                ...report,
                dryRun: false,
            };
        },

        async listTraces(filter) {
            if (!filter || filter.messageId === undefined) {
                return traces.map((t) => ({ ...t }));
            }
            return traces
                .filter(
                    (t) =>
                        t.target.messageId === filter.messageId
                        && (filter.swipeId === undefined || t.target.swipeId === filter.swipeId),
                )
                .map((t) => ({ ...t }));
        },

        async stopTrace(trace: AgentRunTrace): Promise<boolean> {
            const now = Date.now();
            const idx = traces.findIndex((t) => t.runId === trace.runId);
            const targetTrace = idx >= 0 ? traces[idx] : trace;
            if (targetTrace.status !== 'running') {
                return false;
            }
            const abortedTrace: AgentRunTrace = {
                ...targetTrace,
                status: 'aborted',
                interruptedReason: 'user_stop',
                endedAt: now,
                durationMs: Math.max(targetTrace.durationMs, Math.max(0, now - targetTrace.startedAt)),
            };
            if (idx >= 0) {
                traces[idx] = abortedTrace;
            }
            emitEvent({
                kind: 'trace_recorded',
                target: { ...abortedTrace.target },
                timestamp: now,
                phase: abortedTrace.phase,
                runId: abortedTrace.runId,
                agentProfileId: abortedTrace.agentProfileId,
                trace: { ...abortedTrace },
            });
            return true;
        },

        async continueTrace(
            trace: AgentRunTrace,
            continueOptions?: { rollbackLastToolRound?: boolean },
        ): Promise<void> {
            const now = Date.now();
            const idx = traces.findIndex((t) => t.runId === trace.runId);
            const baseTrace = idx >= 0 ? traces[idx] : trace;
            const nextSteps =
                continueOptions?.rollbackLastToolRound && baseTrace.toolSteps.length > 0
                    ? baseTrace.toolSteps.slice(0, -1)
                    : [...baseTrace.toolSteps];
            const resumedTrace: AgentRunTrace = {
                ...baseTrace,
                status: 'completed',
                interruptedReason: undefined,
                error: undefined,
                hasRollbackableRound: false,
                toolSteps: nextSteps,
                endedAt: now,
                durationMs: Math.max(baseTrace.durationMs, Math.max(0, now - baseTrace.startedAt)),
            };
            if (idx >= 0) {
                traces[idx] = resumedTrace;
            }
            if (resumedTrace.phase === 'main_turn') {
                emitEvent({
                    kind: 'turn_resumed',
                    target: { ...resumedTrace.target },
                    timestamp: now,
                    phase: 'main_turn',
                    runId: resumedTrace.runId,
                    trace: { ...resumedTrace },
                });
            }
            emitEvent({
                kind: 'trace_recorded',
                target: { ...resumedTrace.target },
                timestamp: now,
                phase: resumedTrace.phase,
                runId: resumedTrace.runId,
                agentProfileId: resumedTrace.agentProfileId,
                trace: { ...resumedTrace },
            });
        },

        async retryTrace(trace: AgentRunTrace): Promise<void> {
            if (trace.phase === 'after_turn') {
                const triggerIds = trace.triggerId
                    ?.split(',')
                    .map((id) => id.trim())
                    .filter(Boolean);
                await this.rerunAfterTurn(
                    trace.target,
                    triggerIds && triggerIds.length > 0 ? { triggerIds } : undefined,
                );
                return;
            }
            const now = Date.now();
            const idx = traces.findIndex((t) => t.runId === trace.runId);
            const baseTrace = idx >= 0 ? traces[idx] : trace;
            const retriedTrace: AgentRunTrace = {
                ...baseTrace,
                status: 'completed',
                interruptedReason: undefined,
                error: undefined,
                endedAt: now,
                durationMs: Math.max(baseTrace.durationMs, Math.max(0, now - baseTrace.startedAt)),
            };
            if (idx >= 0) {
                traces[idx] = retriedTrace;
            }
            emitEvent({
                kind: 'trace_recorded',
                target: { ...retriedTrace.target },
                timestamp: now,
                phase: retriedTrace.phase,
                runId: retriedTrace.runId,
                agentProfileId: retriedTrace.agentProfileId,
                trace: { ...retriedTrace },
            });
        },

        async rerunAfterTurn(
            _target?: MessageTarget,
            _options?: { triggerIds?: string[]; force?: boolean },
        ) {
            // Mock hook: real runtime dispatches TriggerPipeline.runPhase('after_turn')
        },

        async resumeTurn(target: MessageTarget) {
            const now = Date.now();
            let updatedTrace: AgentRunTrace | undefined;
            for (let i = 0; i < traces.length; i += 1) {
                const trace = traces[i];
                if (
                    trace.target.messageId === target.messageId
                    && trace.target.swipeId === target.swipeId
                    && trace.phase === 'main_turn'
                    && trace.status === 'interrupted'
                ) {
                    updatedTrace = {
                        ...trace,
                        status: 'completed',
                        interruptedReason: undefined,
                        error: undefined,
                        endedAt: now,
                    };
                    traces[i] = updatedTrace;
                    break;
                }
            }

            options.onToast?.(
                `已恢复 #${target.messageId}#${target.swipeId} 的 /output.md 生成`,
                'success',
            );
            emitEvent({
                kind: 'turn_resumed',
                target: { ...target },
                timestamp: now,
                phase: 'main_turn',
                ...(updatedTrace ? { runId: updatedTrace.runId } : {}),
            });
            if (updatedTrace) {
                emitEvent({
                    kind: 'trace_recorded',
                    target: { ...target },
                    timestamp: now,
                    phase: 'main_turn',
                    runId: updatedTrace.runId,
                    trace: { ...updatedTrace },
                });
            }
        },

        async cancelBackgroundTask() {
            // Mock hook: real runtime aborts the task's AbortController
        },

        async saveSettings(nextSettings: Settings) {
            settingsSnapshot = normalizeSettings(nextSettings);
        },

        async importPresetOrConfig(rawJson: unknown, importOptions?: { presetName?: string }): Promise<ImportPresetResult> {
            if (isLegacyCustomGenerationData(rawJson)) {
                if (
                    rawJson
                    && typeof rawJson === 'object'
                    && ('apis' in rawJson || 'interceptGenerate' in rawJson)
                ) {
                    const migrated = migrateFromCustomGeneration(rawJson);
                    return {
                        settings: migrated.settings,
                        report: migrated.report,
                        message: `已从旧版 ST-CustomGeneration 无损迁移 ${migrated.report.migratedPresets} 套预设与 ${migrated.report.migratedConnections} 个连接`,
                    };
                }
                const report = {
                    sourceFormat: 'st_custom_generation' as const,
                    migratedConnections: 0,
                    migratedPresets: 1,
                    migratedAgents: 0,
                    migratedPromptBlocks: 0,
                    migratedTriggers: 0,
                    migratedRegexRules: 0,
                    migratedFiles: 0,
                    skippedItems: [],
                    warnings: [],
                };
                const preset = migrateLegacyPreset(
                    rawJson,
                    importOptions?.presetName || 'Migrated Legacy Preset',
                    report,
                );
                return {
                    preset,
                    report,
                    message: `已从旧版 ST-CustomGeneration 预设迁移「${preset.name}」`,
                };
            }

            const presetValidation = validatePresetImport(rawJson);
            if (presetValidation.ok) {
                const imported = presetValidation.data.presets[0];
                const resolvedName = importOptions?.presetName?.trim() || imported.name;
                return {
                    preset: normalizePreset({ ...imported, name: resolvedName }, imported.id),
                    connection: presetValidation.data.connection,
                    message: `已导入 ST-Agentic 预设「${resolvedName}」`,
                };
            }

            if (validateSettingsImport(rawJson).ok) {
                const full = importSettings(rawJson);
                return {
                    settings: full,
                    preset: full.presets[full.currentPresetId],
                    message: '已导入完整 Agentic 配置',
                };
            }

            if (validateConnectionsImport(rawJson).ok) {
                const imported = importConnections(rawJson);
                const nextConnections = {
                    ...settingsSnapshot.connections,
                    ...imported.connections,
                };
                return {
                    settings: {
                        ...settingsSnapshot,
                        connections: nextConnections,
                        currentConnectionId:
                            imported.currentConnectionId in nextConnections
                                ? imported.currentConnectionId
                                : settingsSnapshot.currentConnectionId,
                    },
                    message: `已导入 ${Object.keys(imported.connections).length} 条 API 连接配置`,
                };
            }

            const promptsValidation = validatePromptsImport(rawJson);
            if (promptsValidation.ok) {
                const preset = buildPresetFromPromptsImport(promptsValidation.data, {
                    presetName: importOptions?.presetName,
                });
                return {
                    preset,
                    message: `已导入 ST-Agentic 提示词预设「${preset.name}」`,
                };
            }

            if (isSillyTavernOpenAIPreset(rawJson)) {
                const imported = importSillyTavernOpenAIPreset(rawJson, {
                    presetName: importOptions?.presetName,
                });
                return {
                    preset: imported.preset,
                    connection: imported.connection,
                    report: imported.report,
                    message: `已部分兼容导入传统 ST 预设「${imported.preset.name}」（忽略 ${imported.report.skippedItems.length} 项破坏缓存项）`,
                };
            }

            throw new Error(presetValidation.error);
        },

        async exportPresetJson(presetId: string, includeConnection = false) {
            const preset =
                settingsSnapshot.presets[presetId] ?? Object.values(settingsSnapshot.presets)[0];
            const conn = includeConnection
                ? settingsSnapshot.connections[settingsSnapshot.currentConnectionId]
                : undefined;
            const payload = exportPreset(preset, { includeConnection: conn });
            return JSON.stringify(payload, null, 2);
        },

        async getEmbeddedCardStatus() {
            return { ...embeddedCardState };
        },

        async embedPresetToCard(presetId: string) {
            const presetName = settingsSnapshot.presets[presetId]?.name ?? presetId;
            embeddedCardState = {
                ...embeddedCardState,
                hasPresets: true,
                fromLegacy: false,
                presetCount: 1,
            };
            return `已将预设「${presetName}」写入角色卡三处镜像 (agentic_embed_presets)`;
        },

        async embedFilesToCard(fileMap: Record<string, string>) {
            embeddedCardState = {
                ...embeddedCardState,
                hasFiles: true,
                fromLegacy: false,
                fileCount: Object.keys(fileMap).length,
            };
            return `已将 ${Object.keys(fileMap).length} 个初始文件写入角色卡 (agentic_embed_files)`;
        },

        async importEmbeddedFromCard() {
            embeddedCardState = {
                ...embeddedCardState,
                fromLegacy: false,
            };
            return {
                presetsImported: embeddedCardState.presetCount,
                filesImported: embeddedCardState.fileCount,
                message: `已从角色卡「${embeddedCardState.characterName}」导入 ${embeddedCardState.presetCount} 套预设与 ${embeddedCardState.fileCount} 个工作区文件`,
            };
        },

        async testConnection(connection: ApiConnection): Promise<ConnectionTestResult> {
            const policyText =
                connection.cachePolicy === 'anthropic_explicit'
                    ? 'cache_control 显式断点'
                    : connection.cachePolicy === 'auto_prefix'
                        ? '自动前缀缓存'
                        : '未启用缓存优化';
            return {
                ok: Boolean(connection.baseUrl.trim()),
                latencyMs: 248,
                cacheSupport: policyText,
                message: `✓ 模拟握手成功 (248ms) · ${connection.model || '未填模型'} · ${policyText}`,
            };
        },

        async fetchModels(connection: ApiConnection): Promise<ConnectionModelsResult> {
            if (!connection.baseUrl.trim()) {
                return {
                    ok: false,
                    latencyMs: 12,
                    models: [],
                    message: '获取模型列表失败：请先填写 Endpoint (Base URL)',
                };
            }

            const baseModels: RemoteModelInfo[] =
                connection.providerFormat === 'anthropic'
                    ? [
                        {
                            id: 'claude-sonnet-4-5-20250929',
                            displayName: 'Claude Sonnet 4.5',
                            ownedBy: 'anthropic',
                            contextLength: 200000,
                        },
                        {
                            id: 'claude-opus-4-20250514',
                            displayName: 'Claude Opus 4',
                            ownedBy: 'anthropic',
                            contextLength: 200000,
                        },
                        {
                            id: 'claude-haiku-4-5-20251001',
                            displayName: 'Claude Haiku 4.5',
                            ownedBy: 'anthropic',
                            contextLength: 200000,
                        },
                    ]
                    : connection.providerFormat === 'gemini'
                        ? [
                            {
                                id: 'gemini-2.5-pro',
                                displayName: 'Gemini 2.5 Pro',
                                ownedBy: 'google',
                                contextLength: 1048576,
                            },
                            {
                                id: 'gemini-2.5-flash',
                                displayName: 'Gemini 2.5 Flash',
                                ownedBy: 'google',
                                contextLength: 1048576,
                            },
                            {
                                id: 'gemini-2.5-flash-lite',
                                displayName: 'Gemini 2.5 Flash-Lite',
                                ownedBy: 'google',
                                contextLength: 1048576,
                            },
                        ]
                        : [
                        {
                            id: 'gemini-2.5-flash',
                            displayName: 'Gemini 2.5 Flash',
                            ownedBy: 'google',
                            contextLength: 1048576,
                        },
                        {
                            id: 'gemini-2.5-pro',
                            displayName: 'Gemini 2.5 Pro',
                            ownedBy: 'google',
                            contextLength: 1048576,
                        },
                        {
                            id: 'gpt-4.1',
                            displayName: 'GPT-4.1',
                            ownedBy: 'openai',
                            contextLength: 1047576,
                        },
                        {
                            id: 'deepseek-chat',
                            displayName: 'DeepSeek Chat',
                            ownedBy: 'deepseek',
                            contextLength: 128000,
                        },
                        {
                            id: 'qwen3-32b-instruct',
                            displayName: 'Qwen3 32B Instruct',
                            ownedBy: 'qwen',
                            contextLength: 32768,
                        },
                    ];

            const currentModel = connection.model.trim();
            const models = [...baseModels];
            if (currentModel && !models.some((m) => m.id === currentModel)) {
                models.push({ id: currentModel });
            }
            models.sort((a, b) => a.id.localeCompare(b.id, undefined, { sensitivity: 'base' }));

            return {
                ok: true,
                latencyMs: 142,
                models,
                message: `已获取 ${models.length} 个可用模型 (142ms)`,
            };
        },

        async testToolInSandbox(
            tool: CustomToolConfig | { name: string; code?: string; commandTemplate?: string },
            argsJson: string,
            target?: MessageTarget,
        ): Promise<ToolTestResult> {
            const resolvedTarget = target ?? { messageId: 12, swipeId: 0 };
            try {
                const parsed: unknown = JSON.parse(argsJson || '{}');
                return {
                    ok: true,
                    durationMs: 42,
                    target: resolvedTarget,
                    output: [
                        `[iframe 沙箱] Zod 参数校验通过: ${JSON.stringify(parsed)}`,
                        `[锚定上下文] target = { messageId: ${resolvedTarget.messageId}, swipeId: ${resolvedTarget.swipeId} }`,
                        `[返回值] "${tool.name} 执行成功 (耗时 42ms，已安全清理内部定时器)"`,
                    ].join('\n'),
                };
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    ok: false,
                    durationMs: 2,
                    target: resolvedTarget,
                    output: '',
                    error: `参数 JSON 解析失败: ${msg}`,
                };
            }
        },

        async listClassifiedLoreEntries(overrides?: Record<string, WICategory>) {
            const resolved = loreEntries.map((item) => {
                const key = `${item.entry.world}/${item.entry.uid}`;
                const manual = overrides?.[item.vfsPath] ?? overrides?.[key];
                return manual
                    ? { ...item, category: manual, overridden: true }
                    : { ...item };
            });
            return {
                entries: resolved,
                isHollowCard: true,
            };
        },

        getHostLuminance: options.getHostLuminance,

        subscribeEvents(listener) {
            eventListeners.add(listener);
            return () => {
                eventListeners.delete(listener);
            };
        },

        assistantRuntime: createMockAssistantRuntime(),
    };
}
