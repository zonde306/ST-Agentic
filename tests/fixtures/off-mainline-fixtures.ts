import type {
    AssistantSession,
    HostRegexScript,
    PendingApproval,
    RawLoreEntry,
    SideClueMeta,
    SideSessionConfig,
    UndoRecord,
} from '@/core/types';
import { MemoryHostBridge } from '../mocks/memory-host-bridge';

/** Canonical §2.1 `/side/comms/linwan.md` fixture matching OFF_MAINLINE_PLAN.md verbatim. */
export const SAMPLE_LINWAN_COMMS_RAW = `---
id: clue_linwan_comms
title: 林晚的加密通讯线索
delivery: radar_hint
status: dormant
keywords:
  - 老码头
  - 灯塔
  - 林晚
  - 门禁卡
secondaryKeys: []
scanDepth: 2
order: 100
summary: 林晚已在老码头旧仓库灯塔下接应，并确认东区巡逻 21:30 换防。
sourceSessionId: phone:linwan
anchor: 12#0
createdAt: 1732320000000
updatedAt: 1732326600000
---
- [18:10 User]: 今晚十点老码头见，带上门禁卡。
- [18:11 林晚]: 收到，东区巡逻九点半换防，我提前二十分钟在旧仓库灯塔下等你。`;

export const SAMPLE_LINWAN_COMMS_META: SideClueMeta = {
    id: 'clue_linwan_comms',
    title: '林晚的加密通讯线索',
    delivery: 'radar_hint',
    status: 'dormant',
    keywords: ['老码头', '灯塔', '林晚', '门禁卡'],
    secondaryKeys: [],
    scanDepth: 2,
    order: 100,
    summary: '林晚已在老码头旧仓库灯塔下接应，并确认东区巡逻 21:30 换防。',
    sourceSessionId: 'phone:linwan',
    anchor: '12#0',
    createdAt: 1732320000000,
    updatedAt: 1732326600000,
};

export const SAMPLE_NEXT_TURN_BRIEF_RAW = `---
id: clue_dock_brief
title: 东区巡逻换防紧急通报
delivery: next_turn_brief
status: dormant
keywords:
  - 巡逻
  - 东区
order: 50
summary: 东区巡逻队今晚临时提前十分钟换防，旧仓库后门将出现三分钟空窗。
sourceSessionId: rumor:dock
anchor: 12#0
createdAt: 1732327000000
updatedAt: 1732327000000
---
据码头值夜工透露，东区巡逻今晚 21:20 提前交班。`;

export const SAMPLE_VFS_ONLY_RUMOR_RAW = `---
id: clue_harbor_rumor
title: 雾港走私船暗语备忘
delivery: vfs_only
status: dormant
keywords:
  - 走私船
  - 黑帆
summary: 仅在主 Agent 主动检索 /side/rumors/* 时查阅的码头暗语清单。
anchor: 10#0
createdAt: 1732310000000
updatedAt: 1732315000000
---
暗语「三声雾笛」代表卸货改期至次日凌晨。`;

export const SAMPLE_ISOLATED_NOTE_RAW = `---
id: clue_private_interlude
title: 纯娱乐线外小插曲
delivery: none
status: dormant
keywords:
  - 咖啡馆
summary: 完全隔离，主线雷达与简报均不可见。
anchor: 8#0
createdAt: 1732300000000
updatedAt: 1732300000000
---
主角与林晚在咖啡馆闲聊了一段与主线无关的旧事。`;

export const SAMPLE_SIDE_SESSION_BRANCH: SideSessionConfig = {
    id: 'phone:linwan',
    title: '林晚加密手机通讯',
    scope: 'branch',
    systemPrompt: '你是林晚，通过加密频道与调查员简短联络，不直接推进主线场景。',
    connectionId: 'inherit',
    watermark: { high: 16000, low: 8000 },
    autoBridge: {
        path: '/side/comms/linwan.md',
        delivery: 'radar_hint',
        keywords: ['老码头', '灯塔', '林晚', '门禁卡'],
        title: '林晚的加密通讯线索',
        mode: 'append',
        summaryPrefix: '加密通讯更新：',
    },
    anchor: { messageId: 12, swipeId: 0 },
    turns: 2,
    estimatedTokens: 1420,
    lastCacheHitRate: '92.4%',
    createdAt: 1732320000000,
    updatedAt: 1732326600000,
};

export const SAMPLE_SIDE_SESSION_CHAT: SideSessionConfig = {
    id: 'rumor:dock',
    title: '雾港流言演化轨',
    scope: 'chat',
    systemPrompt: '根据当前时间线推演雾港酒馆与码头流言变化。',
    connectionId: 'fast-aux',
    watermark: { high: 12000, low: 6000 },
    anchor: { messageId: 12, swipeId: 0 },
    turns: 1,
    estimatedTokens: 640,
    lastCacheHitRate: '0.0%',
    createdAt: 1732325000000,
    updatedAt: 1732325500000,
};

/** Raw World Info entry containing `@@` decorators and `<% ... %>` EJS logic for author-mode tests. */
export const SAMPLE_RAW_AUTHOR_WI_ENTRY: RawLoreEntry = {
    world: '雾港侦探录',
    uid: 7,
    comment: '全局叙事规则与动态状态检查',
    content: [
        '@@system',
        '保持冷硬派侦探叙事口吻，禁止代替用户发言。',
        '<% if (getvar("heat") > 5) { %>',
        '【警戒提示】全城通缉等级偏高，巡逻密度加倍。',
        '<% } %>',
    ].join('\n'),
    keys: ['规则', '警戒'],
    keysecondary: [],
    constant: true,
    selective: false,
    disable: false,
    position: 0,
    depth: 0,
    order: 10,
    role: 0,
};

export const SAMPLE_SCOPED_REGEX: HostRegexScript[] = [
    {
        id: 'regex_scoped_1',
        scriptName: '隐藏内部思考标签',
        findRegex: '/<internal>[\\s\\S]*?<\\/internal>/g',
        replaceString: '',
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
    },
];

export const SAMPLE_PENDING_AUTHOR_APPROVAL: PendingApproval = {
    id: 'appr_wi_001',
    sessionId: 'ast_session_1',
    messageId: 'ast_msg_2',
    toolCallId: 'call_wi_upsert_1',
    toolName: 'wi_upsert_primary_entry',
    riskLevel: 'medium',
    mandatoryConfirm: false,
    revision: 1,
    title: '更新主世界书条目 #7（含原始 @@ 与 EJS）',
    summary: '向绑定主世界书《雾港侦探录》写入 @@system 与热力值 EJS 条件块。',
    targetLabel: 'WI: 雾港侦探录 / #7',
    status: 'pending',
    rawContent: SAMPLE_RAW_AUTHOR_WI_ENTRY.content,
    diffLines: [
        { type: 'ctx', text: '@@system' },
        { type: 'del', text: '保持侦探口吻。' },
        { type: 'add', text: '保持冷硬派侦探叙事口吻，禁止代替用户发言。' },
        { type: 'add', text: '<% if (getvar("heat") > 5) { %>' },
    ],
    args: {
        bookName: '雾港侦探录',
        uid: 7,
        content: SAMPLE_RAW_AUTHOR_WI_ENTRY.content,
    },
    createdAt: 1732328000000,
};

export const SAMPLE_PENDING_ADMIN_APPROVAL: PendingApproval = {
    id: 'appr_admin_002',
    sessionId: 'ast_session_1',
    messageId: 'ast_msg_3',
    toolCallId: 'call_settings_patch_1',
    toolName: 'st_settings_patch',
    riskLevel: 'high',
    mandatoryConfirm: true,
    revision: 1,
    title: '修改酒馆全局设置 (power_user)',
    summary: '高危 ST 全权管家操作，强制人工确认。',
    targetLabel: 'ST Settings: power_user',
    status: 'pending',
    rawContent: '{"fast_ui_mode": false}',
    diffLines: [
        { type: 'del', text: '"fast_ui_mode": true' },
        { type: 'add', text: '"fast_ui_mode": false' },
    ],
    args: {
        scope: 'power_user',
        patch: { fast_ui_mode: false },
    },
    createdAt: 1732328100000,
};

export const SAMPLE_UNDO_RECORD: UndoRecord = {
    id: 'undo_001',
    sessionId: 'ast_session_1',
    toolCallId: 'call_chat_edit_1',
    toolName: 'chat_edit_message',
    kind: 'chat_message',
    label: '修正楼层 #1 错别字',
    scope: 'chat:1#0',
    beforeSummary: '旧文本：老玛头灯塔',
    afterSummary: '新文本：老码头灯塔',
    snapshot: {
        messageId: 1,
        swipeId: 0,
        previousContent: '我们在老玛头灯塔下碰面。',
    },
    target: { messageId: 1, swipeId: 0 },
    timestamp: 1732327500000,
    reverted: false,
};

export const SAMPLE_ASSISTANT_SESSION: AssistantSession = {
    id: 'ast_session_1',
    title: '雾港剧本写卡协作',
    mode: 'author',
    stAdminEnabled: false,
    autoApproveAuthor: false,
    connectionId: 'inherit',
    updatedAt: 1732328000000,
    messages: [
        {
            id: 'ast_msg_1',
            role: 'user',
            content: '帮我检查主世界书 #7 条目并补上热力值 EJS 警戒规则。',
            timestamp: 1732327900000,
        },
        {
            id: 'ast_msg_2',
            role: 'assistant',
            content: '已准备好主世界书 #7 条目的修改方案，请在下方确认 Diff。',
            think: '先读取绑定主世界书原始条目，再构造保留 @@system 与 EJS 的补丁。',
            toolCalls: [
                {
                    id: 'call_read_wi_1',
                    name: 'wi_read_raw_book',
                    scopeLabel: 'WI: 雾港侦探录',
                    status: 'ok',
                    durationMs: 12,
                    argsSummary: '{"bookName":"雾港侦探录"}',
                    resultSummary: 'Read 1 entry (uid=7)',
                },
            ],
            approvalIds: ['appr_wi_001'],
            fileRefs: ['/side/comms/linwan.md'],
            usage: {
                inputTokens: 1800,
                cachedTokens: 1500,
                outputTokens: 210,
                cacheRate: '83.3%',
            },
            timestamp: 1732328000000,
        },
    ],
};

/**
 * Realistic secret-bearing payload fixture for testing `src/core/assistant/redact.ts`
 * across nested objects, arrays, Bearer tokens, and serialized JSON strings.
 */
export const SAMPLE_SECRET_PAYLOAD: Record<string, unknown> = {
    safeField: '雾港侦探录',
    apiKey: 'sk-proj-live-1234567890abcdef',
    api_key: 'sk-legacy-underscore-key-999',
    'x-api-key': 'sk-header-hyphen-key-888',
    nested: {
        accessToken: 'ghp_mockAccessTokenValue12345',
        clientSecret: 'super-secret-client-value',
        dbPassword: 'correct-horse-battery-staple',
        private_key: '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----',
        headers: {
            Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.mock.signature',
            Cookie: 'connect.sid=s%3AmockSessionCookie',
            Accept: 'application/json',
        },
    },
    connections: [
        {
            id: 'main',
            model: 'claude-3-7-sonnet',
            apiKey: 'sk-ant-api03-mock-secret',
            inlineNote: 'Header was Bearer raw_inline_bearer_token_777 in logs',
        },
    ],
    jsonBlob: JSON.stringify({
        endpoint: 'https://api.example.test/v1',
        token: 'tok_embedded_inside_json_string',
        ok: true,
    }),
};

/**
 * Create a pre-populated `MemoryHostBridge` with character card, primary & disabled
 * World Info books, scoped/global regex, chat messages, and secret-bearing host settings.
 */
export function createOffMainlineTestBridge(): MemoryHostBridge {
    return new MemoryHostBridge({
        identity: {
            userName: '调查员',
            charName: '林晚',
            characterAvatar: 'linwan.png',
            personaAvatar: 'investigator.png',
        },
        characterFields: {
            description: '雾港档案科情报联络人，行事冷静果断。',
            personality: '谨慎、敏锐、守口如瓶',
            scenario: '雾港雨夜，东区旧码头暗流涌动。',
        },
        personaDescription: '来自城北的私家调查员，手持旧码头门禁卡。',
        primaryWorldName: '雾港侦探录',
        lorebooks: {
            '雾港侦探录': [SAMPLE_RAW_AUTHOR_WI_ENTRY],
        },
        disabledLorebooks: {
            '全局备用设定集': [
                {
                    world: '全局备用设定集',
                    uid: 1,
                    comment: '未启用世界书测试条目',
                    content: '仅在 ST 全权管家开启后可见并可绑定。',
                    keys: ['备用'],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 4,
                    order: 100,
                    role: 0,
                },
            ],
        },
        scopedRegex: SAMPLE_SCOPED_REGEX,
        chat: [
            {
                id: 0,
                name: '调查员',
                isUser: true,
                mes: '我们今晚在老码头碰头。',
                swipeId: 0,
                swipes: ['我们今晚在老码头碰头。'],
                swipeInfo: [{}],
            },
            {
                id: 1,
                name: '林晚',
                isUser: false,
                mes: '雾港的雨下得很大，我已提前抵达灯塔。',
                swipeId: 0,
                swipes: ['雾港的雨下得很大，我已提前抵达灯塔。'],
                swipeInfo: [{}],
            },
        ],
    });
}
