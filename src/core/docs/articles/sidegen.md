# SideGen 线外生成与 `/side/*` 线索指南

SideGen 是 ST-Agentic 的**线外（Off-Mainline）LLM 生成与 `/side/*` 线索桥接引擎**：在不占用主线 RP 上下文 Token、不污染主线聊天记录的前提下，于侧边独立执行一次性推演或长线多轮对话，并支持将结果按 4 档投递策略安全同步回主线。

### 核心模式与因果分支安全
1. **`runOnce`（无状态单次生成）**：
   - 不创建 `TrajectoryStore` 线程、不写入主线聊天；可选只读挂载最近主线消息（`mainChatDepth` → `<main-chat-context>`）与当前变量快照（`includeVars` → `<main-vars-snapshot>`），并可选将结果单次 `bridge` 到 `/side/*`。
2. **`createSession` / `send`（持久 SideSession）**：
   - 在 `TrajectoryStore` 中使用独立线程 `side:<sessionId>`：冻结 Layer 0 `systemPrompt`、严格 append-only 追加 Layer 1 对话历史、自动计算最多 4 个显式缓存断点（`cacheBreakpoints`）、按独立高低水位自动压缩历史（默认 `{ high: 16000, low: 8000 }`），并支持配置 `autoBridge` 在每轮自动更新 `/side/*`。
3. **作用域与因果分支回滚（`scope: 'branch' | 'chat'`）**：
   - `'branch'`（默认）：绑定当前主线 `(messageId, swipeId)` 锚点并保存检查点；主线发生 Swipe、Regenerate 或删除楼层时，自动中止所有在途请求并将会话回滚到最近有效祖先节点（绝不向错误分支提交过期响应）。
   - `'chat'`：同一聊天内跨 Swipe 持久保留（切聊天时仍自动中止并重载）。
4. **四大入口**：
   - **宿主脚本 / 扩展**：`globalThis.Agentic.sideGen`（支持监听 `agentic:ready` 处理加载顺序；`JS-Slash-Runner` iframe 内推荐通过 `triggerSlash('/sidegen-...')` 调用，或同源场景访问 `window.parent.Agentic?.sideGen`）。
   - **自定义 JS 工具（`defineTool` / `@@tool`）与 `@@script`**：`ctx.sideGen`（`IframeJsSandbox` 通过冻结的 null-prototype 宿主代理暴露，自动转发 `ctx.signal`，LLM 请求在宿主侧执行而不放开 iframe 网络隔离；未配置/已销毁/参数非法时抛出 `SandboxSideGenError`，`code` 为 `'SIDEGEN_UNAVAILABLE' | 'SIDEGEN_DISPOSED' | 'SIDEGEN_INVALID_ARGS'`）。
   - **SillyTavern 原生 Slash 命令**：`/sidegen-once`、`/sidegen-send`、`/sidegen-clue`。
   - **控制台 UI**：「线外生成 (SideGen)」标签页（会话管理、`/side/*` 线索管理与世界书导出弹窗、SDK Playground）。

---

## 1. SDK 全量 API 速查（`ToolSideGenApi`：`Agentic.sideGen` / `ctx.sideGen`）

| 方法 | 签名 | 说明 |
| :--- | :--- | :--- |
| **`runOnce`** | `(opts: SideGenOnceOptions) => Promise<SideGenResult>` | 无状态一次性线外生成；可选只读主线快照与 `bridge` |
| **`createSession`** | `(opts: CreateSideSessionOptions) => Promise<SideSessionInfo>` | 创建持久线外会话并冻结 Layer 0 `systemPrompt` |
| **`send`** | `(sessionId: string, prompt: string, opts?: SideGenSendOptions) => Promise<SideGenResult>` | 向已有会话发送一轮对话（含 KV 缓存断点、水位压缩与 `autoBridge`） |
| **`getSession`** | `(sessionId: string) => Promise<SideSessionInfo \| null>` | 查询单个会话配置与统计（`turns`、`estimatedTokens`、`lastCacheHitRate` 等） |
| **`listSessions`** | `(filter?: SideSessionFilter) => Promise<SideSessionInfo[]>` | 列出会话，可按 `{ scope?, branchKey? }` 过滤 |
| **`getTranscript`** | `(sessionId: string) => Promise<SideSessionTranscriptEntry[]>` | 读取当前会话的 `{ role, content, timestamp? }[]` 对话记录 |
| **`compactSession`** | `(sessionId: string) => Promise<{ compacted: boolean; estimatedTokens: number }>` | 手动触发该会话的摘要压缩 |
| **`deleteSession`** | `(sessionId: string) => Promise<boolean>` | 删除会话及其轨迹 |
| **`clues`** | `ToolSideCluesApi` | `/side/*` 线索文档管理与世界书导出外观（见第 2 节） |

### 关键选项与返回值字段
- **`SideGenOnceOptions`**：
  - `prompt: string`（必填）
  - `systemPrompt?: string`
  - `connectionId?: string`（默认 `'inherit'`，可传指定连接 ID）
  - `mainChatDepth?: number`（附带最近 N 条可见主线消息，包装为 `<main-chat-context>`）
  - `includeVars?: boolean`（附带当前目标分支变量只读快照 `<main-vars-snapshot>`）
  - `bridge?: { path: string; delivery: SideClueDelivery; title?: string; keywords?: string[]; summary?: string }`
  - `signal?: AbortSignal`（在 `ctx.sideGen` 中会自动与 `ctx.signal` 联动中止）
- **`CreateSideSessionOptions`**：
  - `id?: string`（可选自定义 ID，如 `'phone:linwan'`；省略自动生成）
  - `title: string`（必填）
  - `scope?: 'branch' | 'chat'`（默认 `'branch'`）
  - `systemPrompt: string`（必填，冻结进 Layer 0 前缀；若不需系统提示词可传 `''`）
  - `connectionId?: string`（默认 `'inherit'`）
  - `watermark?: { high: number; low: number }`（默认 `{ high: 16000, low: 8000 }`）
  - `autoBridge?: { path: string; delivery: SideClueDelivery; keywords: string[]; title: string; mode: 'append' | 'replace'; summaryPrefix?: string }`
- **`SideGenSendOptions`**：`{ connectionId?: string; mainChatDepth?: number; includeVars?: boolean; signal?: AbortSignal }`
- **`SideGenResult`**：`{ text: string; sessionId?: string; bridgedPath?: string; usage?: { inputTokens: number; cachedTokens: number; outputTokens: number }; durationMs: number }`

---

## 2. `/side/*` 线索系统与 `clues` API（`ToolSideCluesApi`）

### 路径规范与文档结构
- 约定子目录：`/side/comms/*`（通讯）、`/side/rumors/*`（传闻）、`/side/notes/*`（笔记）；传入不带前缀的相对路径（如 `'comms/linwan.md'`）会自动锚定到 `/side/comms/linwan.md`，越界/路径穿越会被拒绝。
- 每篇 `/side/*` 文档由 **YAML Frontmatter（`SideClueMeta`）+ Markdown 正文**组成，并计算 64-bit `xxHash` `contentHash` 供 `Read-Set` 脏检查使用：
  - 元数据字段：`id`、`title`、`delivery`、`status`、`keywords`、`secondaryKeys?`、`scanDepth?`、`order?`、`summary`、`sourceSessionId?`、`anchor`、`createdAt`、`updatedAt`、`consumedByTurn?`。

### 4 档投递策略（`SideClueDelivery`）与 3 种状态（`SideClueStatus`）

| `delivery` | 行为与主线注入方式 |
| :--- | :--- |
| **`none`** | 仅存储，永不主动提醒或自动注入主线 |
| **`vfs_only`** | 挂载在 `/side/*` VFS 中，仅在智能体显式调用 `read_file` / `search_files` 时可读 |
| **`radar_hint`**（默认，可在设置 `offMainline.defaultDelivery` 修改） | 由 `TailRadar.scanSideClues()` 扫描 `keywords`（及可选 `secondaryKeys`、`scanDepth`）；仅当 `status !== 'resolved'` 且相对 `Read-Set` 为**未读或内容有更新**时在 Layer 2 注入紧凑 `<side-hint>`（默认 Top-K = 5）；已读且哈希未变时 **100% 静默** |
| **`next_turn_brief`** | 下一次主线回合在 Layer 2 注入一次性 `<side-brief>`（按 `order` 降序、`path` 升序排列），随后自动标记 `status: 'surfaced'` 与 `consumedByTurn`；重新写入或调用 `updateDelivery(..., 'next_turn_brief')` 会清除 `consumedByTurn` 以便再次触发 |

- **`status` 取值**：`'dormant'`（默认，休眠/待触发） | `'surfaced'`（已向主线浮现） | `'resolved'`（已完结，不再触发雷达提示或简报）。

### `clues` 全量方法（7 个）
- `write(input: SideClueWriteInput): Promise<SideClueDoc>` — 写入或更新线索（`{ path, body, id?, title?, delivery?, status?, keywords?, secondaryKeys?, scanDepth?, order?, summary?, sourceSessionId?, anchor?, target? }`）
- `read(path, target?): Promise<SideClueDoc | null>`
- `list(target?): Promise<SideClueDoc[]>`
- `updateDelivery(path, delivery, target?): Promise<SideClueDoc | null>`
- `updateStatus(path, status, target?): Promise<SideClueDoc | null>`
- `delete(path, target?): Promise<boolean>`
- `exportToWorldInfo(path, options?): Promise<ExportWorldInfoResult>` — 将线索升格导出到 SillyTavern 世界书条目（默认写入当前角色绑定的主世界书）；`options` 支持 `bookName`、`comment`、`keys`、`secondaryKeys`、`constant`、`selective`、`position`、`depth`、`order`、`role`、`disable`、`markResolved`、`target`。

---

## 3. SillyTavern 原生 Slash 命令

三个命令均**同时支持**酒馆原生命名参数（`key=value`）与 CLI 风格参数（`--flag value` / `--flag="带空格内容"`）；`--keywords` 支持逗号/分号分隔字符串或 JSON 数组。

| 命令 | 常用参数 | 返回值与说明 |
| :--- | :--- | :--- |
| **`/sidegen-once`** | `system`、`depth`、`connection`、`path`、`delivery`、`keywords`、`title`、`summary`、`include-vars` + 提示词正文 | 返回生成的文本；传 `path` 时自动桥接到 `/side/*` |
| **`/sidegen-send`** | `session`（必填）、`scope`（`branch`/`chat`）、`system`、`path`、`delivery`、`keywords`、`title`、`connection`、`depth`、`include-vars` + 本轮消息 | 返回会话回复；若 `session` 尚不存在会自动创建（`autoBridge.mode` 默认为 `'append'`） |
| **`/sidegen-clue`** | `action`（`list` \| `read` \| `write` \| `delivery` \| `status` \| `export` \| `delete`）、`path`、`delivery`、`status`、`keywords`、`title`、`summary`、`book` + 可选正文/目标值 | 除 `delete` 返回 `'true'` / `'false'` 字符串外，其余操作返回 JSON 字符串（未找到时返回空字符串） |

---

## 4. 提示词积木、宏、`strictToolLoop` 与事件钩子联动

1. **显式 `triggers: ['sidegen']` 隔离**：
   - `SideGenService` 通过 `selectPresetBlocksForContext(..., { kind: 'sidegen', mode }, { requireExplicit: true })` 筛选预设积木；未勾选 `sidegen` 的主线/全局积木**不会**混入线外上下文。
2. **`{{systemBase}}` 接管 SideGen 系统提示词**：
   - 当任一匹配 `triggers: ['sidegen']` 且已启用的 `PromptBlock` 包含 `{{systemBase}}`（或 `{{system_base}}` / `{{system-base}}`）时，SideGen 会自动取消顶层独立 `systemPrompt` 注入，改为在该积木的 `placement`（`prefix` / `tail`）与 `role` 位置展开 `opts.systemPrompt` / `session.systemPrompt`。
3. **表面宏与主线定位宏**：
   - SideGen 上下文中 `{{agenticSurface}}` 为 `'sidegen'`；`{{lastUserMessage}}` / `{{lastCharMessage}}` / `{{lastMessage}}` 隔离为当前 SideGen 会话，而 `{{stLastUserMessage}}` / `{{stLastCharMessage}}` / `{{stLastMessage}}` / `{{stLastMessageId}}` 始终指向主聊天。
   - 在主线/触发器预设积木中可用 `{{sideBrief}}` 与 `{{sideHint}}` 精确控制 `<side-brief>` 与 `<side-hint>` 的注入位置（详见 `/docs/ejs-macros.md`）。
4. **正则、`strictToolLoop` 与输出事件钩子**：
   - 输入 prompt 与输出 text 会自动应用 ST-Agentic 预设的 `ingest` / `display` 正则。
   - 若所用连接开启 `strictToolLoop`，SideGen 会透明使用 `finish_turn`（支持 `roundMaxRetries` 重试）并在落盘会话历史前剥离伪工具调用，只保留干净对话消息。
   - 回合结束会触发 `agentic_output_process`（`meta.runner === 'sidegen'`、`meta.stage === 'turn_finish'`、`meta.surface === 'sidegen'`，支持就地清洗、`requestFix` 与 `retry`，详见 `/docs/event-hooks.md`），并写入 `TraceLogger`（`offMainlineKind: 'sidegen_once' | 'sidegen_session'`）。

---

## 5. 实战模板（可直接复制）

### 模板 1：宿主脚本 / 扩展建立持久加密通讯频道并自动桥接线索
```js
const sideGen = globalThis.Agentic?.sideGen;
if (sideGen) {
  const sessionId = 'phone:linwan';
  if (!(await sideGen.getSession(sessionId))) {
    await sideGen.createSession({
      id: sessionId,
      title: '林晚加密通讯',
      scope: 'branch',
      systemPrompt: '你是林晚，通过加密短信与主角保持简短联络，语气谨慎。',
      autoBridge: {
        path: '/side/comms/linwan.md',
        delivery: 'radar_hint',
        keywords: ['老码头', '林晚', '门禁卡'],
        title: '林晚的加密通讯线索',
        mode: 'append',
        summaryPrefix: '加密通讯：',
      },
    });
  }
  const reply = await sideGen.send(sessionId, '今晚十点老码头见，把备用门禁卡带上。', {
    mainChatDepth: 4,
    includeVars: true,
  });
  console.log('SideGen 回复:', reply.text, '已同步:', reply.bridgedPath);
}
```

### 模板 2：在自定义工具（`defineTool`）或 `@@script` 中使用 `ctx.sideGen`
```js
export default defineTool({
  name: 'scout_rumor',
  description: '线外推演目标地点近期流传的情报并写入下一轮简报',
  parameters: z.object({
    location: z.string().describe('侦察地点名称'),
  }),
  async execute(args, ctx) {
    if (!ctx.sideGen) {
      throw new Error('SideGen runtime unavailable');
    }
    const res = await ctx.sideGen.runOnce({
      systemPrompt: '你是情报整理员，只输出 3 条简明、可验证的传闻要点。',
      prompt: `整理关于「${args.location}」的最新线外传闻。`,
      mainChatDepth: 4,
      includeVars: true,
      signal: ctx.signal,
      bridge: {
        path: `/side/rumors/${encodeURIComponent(args.location)}.md`,
        delivery: 'next_turn_brief',
        title: `${args.location} 传闻简报`,
        keywords: [args.location],
      },
    });
    return { ok: true, bridgedPath: res.bridgedPath, preview: res.text };
  },
});
```

### 模板 3：Slash 命令速查（`JS-Slash-Runner` / 酒馆输入框）
```stscript
/sidegen-once --depth 4 --include-vars --path /side/notes/dock.md --delivery next_turn_brief --keywords "码头,货船" --title "码头夜探简报" 推演今晚码头守卫换班规律
```
```stscript
/sidegen-send --session phone:linwan --scope branch --system "你是林晚，简短回复加密短信" --path /side/comms/linwan.md --delivery radar_hint --keywords "林晚,暗号" 暗号确认好了吗？
```
```stscript
/sidegen-clue --action export --path /side/comms/linwan.md --keywords "林晚,老码头"
```
