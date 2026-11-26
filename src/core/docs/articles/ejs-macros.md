# EJS 模板、提示词积木、宏与 VFS 速查

---

## 1. EJS 模板在 ST-Agentic 中的运行机制

ST-Agentic 通过 `evaluateOptionalEjs()` 集成可选插件 **`ST-Prompt-Template`**（检测 `globalThis.EjsTemplate`）：

- **可选依赖**：未安装 `ST-Prompt-Template` 或文本不含 `<%` 时静默原样返回（不报错）；在零 Token EJS 触发器里若缺少该全局 API 则跳过执行并记警告。
- **上下文注入**：调用 `EjsTemplate.prepareContext(mergedEnv)`，并把当前目标分支的 `/state/variables.json` 变量同时作为 `vars` 对象和顶级展开键注入，同时在提示词积木渲染中提供 `json(val)` 辅助函数（以及触发器运行时的 `input` / `target`）。
- **常用标签语法**：
  - `<% code %>`：纯 JS 执行（条件、循环、计算、赋值），不输出文本（用 `-%>` 去掉末尾换行）。
  - `<%= expr %>`：输出表达式结果（在 ST 消息渲染阶段会被格式化/转义）。
  - `<%- expr %>`：原样输出表达式结果（适合 HTML 片段或原始 Markdown）。
  - `print(...)`：在 `<% ... %>` 块中输出字符串（不可在 `<%-`/`<%=` 内调用）。

### 与三层统一变量的关系
- 三层变量底层已与 ST 原生存储打通，但注意命名差：ST-Agentic 的 `scope: 'chat'` 对应 `ST-Prompt-Template` 的 `scope: 'local'`（`getLocalVar` / `setLocalVar`）。
- 在 `before_turn` 阶段刚通过 `ctx.vars` 写入的 `message` 变量尚未正式落盘（处于 staged），ST-Agentic 注入的 `vars` 已包含最新暂存值，而直接调用原生 `getvar` 可能仍读到旧缓存；因此在 ST-Agentic 提示词积木和 `@@*_ejs` 触发器里优先读 `vars.xxx`（如 `<%- vars.hp ?? 100 %>`）。

### 世界书 EJS 零 Token 触发器
| 装饰器 | 阶段 | 行为 |
| :--- | :--- | :--- |
| `@@evaluate_ejs` / `@@evaluate_ejs_before` | `after_turn` / `before_turn` | 仅执行 EJS 副作用（如调 `setvar` / `activewi`），输出丢弃 |
| `@@replace_ejs` / `@@replace_ejs_before` | `after_turn` / `before_turn` | 求值后非空结果写回当前条目对应的 `/lorebooks/...` 覆写 |
| `@@append_output_ejs` / `@@append_output_ejs_before` | `after_turn` / `before_turn` | 求值后非空结果直接追加到 `/output.md` |
| `@@replace_output_ejs` / `@@replace_output_ejs_before` | `after_turn` / `before_turn` | 求值后非空结果直接替换 `/output.md` |

> 需要 `ST-Prompt-Template` 全部内置函数、`flags`/`scope` 选项、常量、标题标记（`[GENERATE:*]` / `@INJECT`）及 16 个原生装饰器详情，请阅读 **`/docs/ejs-reference.md`**。

---

## 2. 提示词积木（`PromptBlock`）与 KV 缓存位置

| `placement` | 所在缓存层 | 适用内容 |
| :--- | :--- | :--- |
| `prefix` | Layer 0 静态前缀（高命中缓存） | 固定系统指令、输出协议、静态人设与 `{{file::/preset/...}}`；**禁止**塞动态变化内容，否则每次都会破坏前缀缓存 |
| `tail` | 瞬态尾部锚定（紧贴当前轮与工具链末尾） | 需要强遵循的格式约束、最后提醒、场景变量与浮动指令（全表面一致：工具链夹在中间且不固化入 Layer 1 历史） |
| `floating_tail` | 瞬态尾部锚定（`tail` 的兼容别名） | 与 `tail` 行为相同，保留用于兼容既有预设配置 |

### `triggers` 作用域过滤标签（留空表示对所有上下文生效）
- 主生成：`main`、`main_normal`、`main_continue`、`main_regenerate`、`main_swipe`
- 助手工作台：`assistant`、`assistant_chat`、`assistant_adjust`、`assistant_author`、`assistant_full`、`assistant_admin`
- 触发器与线外：`trigger`、`trigger_before`、`trigger_after`、`trigger_maintenance`、`trigger_variables`、`trigger_lore`、`trigger_output`、`subagent`、`sidegen`
- 精准绑定单条规则：`trigger_rule:<triggerRuleId>`

---

## 3. 常用宏速查

| 宏 | 含义 | 适用范围 |
| :--- | :--- | :--- |
| `{{file::/path}}` | 同步内联读取 VFS 文件文本（如 `{{file::/preset/style.md}}`） | 提示词积木 / 文本模板 |
| `{{var:key}}` | 读取当前变量键值 | Layer 2 动态块 / 表面宏 |
| `{{model}}` | 当前连接模型名 | 全表面 |
| `{{maxContext}}` / `{{maxContextTokens}}` | 有效上下文上限 Token 数 | 全表面 |
| `{{maxResponse}}` / `{{maxResponseTokens}}` | 预留最大输出 Token 数 | 全表面 |
| `{{maxPrompt}}` / `{{maxPromptTokens}}` | 可用提示词预算 (`maxContext - maxResponse`) | 全表面 |
| `{{lastUserMessage}}` / `{{lastCharMessage}}` / `{{lastMessage}}` | 当前表面会话的最近一条用户/角色/任意消息（助手工作台与 SideGen 中隔离为各自会话） | 全表面 |
| `{{stLastUserMessage}}` / `{{stLastCharMessage}}` / `{{stLastMessage}}` / `{{stLastMessageId}}` | **始终指向 SillyTavern 主聊天**的最近消息与楼层 ID | 助手工作台 / SideGen / 主流程 |
| `{{agenticSurface}}` | `'main'` \| `'assistant'` \| `'sidegen'` | 全表面 |
| `{{triggerPrompt}}` | 当前触发器 / `@@agent` 子智能体对应的世界书条目指令正文（已渲染宏与 EJS，不含 `Target VFS Path` / `Latest User Input` 等外围包装；非触发场景为空字符串） | 触发器 / `@@agent` 子智能体 |
| `{{triggerLabel}}` / `{{triggerId}}` / `{{triggerPhase}}` / `{{triggerTargetPath}}` | 当前触发器标题、规则 ID、阶段（`before_turn`/`after_turn`/`maintenance`）与目标 VFS 路径 | 触发器 / `@@agent` 子智能体 |

### 自动注入提示词宏（精准控制预设位置与角色）

当任一**已启用且匹配当前触发条件**的 `PromptBlock` 引用了下方任意宏（同时支持 `camelCase`、`snake_case` 与 `kebab-case` 别名，如 `{{coreManifest}}` / `{{core_manifest}}` / `{{core-manifest}}`）时，ST-Agentic 会自动**取消该块原有的默认位置自动注入**（不再作为独立的 Layer 0 `system` 消息 / Gemini `systemInstruction` 或 Layer 2 默认 user 尾部拼接），改为在预设指定的积木位置与角色原样展开；若当前没有任何生效积木引用该宏，则保持原有的自动注入行为。

| 宏（及别名） | 对应自动注入内容 | 推荐 `placement`（KV 缓存建议） |
| :--- | :--- | :--- |
| `{{systemBase}}` / `{{system_base}}` / `{{system-base}}` | 内置 VFS 与输出协议基础指令（`DEFAULT_SYSTEM_BASE_PROMPT` 或启用中的 `system_base` 积木；引用后可将其从 Layer 0 `system` / Gemini `systemInstruction` 移至任意预设积木，即使已删除 `system_base` 条目也不会强行兜底注入到顶层系统指令；同时支持接管 SideGen 与助手工作台系统提示词） | `prefix`（静态前缀） |
| `{{assistantSystemPrompt}}` / `{{assistant_system_prompt}}` / `{{assistant-system-prompt}}` | 助手工作台内置系统提示词（`You are the ST-Agentic Off-Mainline Assistant...`；在匹配 `assistant*` 触发条件的积木中引用后，自动取消 Layer 0 `system` / Gemini `systemInstruction` 注入，改为在指定积木位置展开） | `prefix`（静态前缀） |
| `{{coreManifest}}` / `{{core_manifest}}` / `{{core-manifest}}` | `<core-manifest>`（空壳卡提示、`/character/*`、`/persona/description.md`、Category ② 常驻世界书与 `/preset/*` 索引） | `prefix`（静态前缀） |
| `{{systemRules}}` / `{{system_rules}}` / `{{system-rules}}` | `<system-rules>`（Category ① `@@system` 系统规则汇总；无规则时展开为空） | `prefix`（静态前缀） |
| `{{turnBrief}}` / `{{turn_brief}}` / `{{turn-brief}}` | `<turn-brief>`（`before_turn` 触发器回合简报） | `tail` |
| `{{sideBrief}}` / `{{side_brief}}` / `{{side-brief}}` | `<side-brief>`（未消费的 `next_turn_brief` `/side/*` 线索简报） | `tail` |
| `{{workspaceNotice}}` / `{{workspace_notice}}` / `{{workspace-notice}}` | `<workspace-instructions-notice>` / `<workspace-doc-updates>` / `<workspace-shared-updates>` | `tail` |
| `{{dynamicReminders}}` / `{{dynamic_reminders}}` / `{{dynamic-reminders}}` | `<dynamic-reminders>`（Category ④ `dynamic_at_depth` / `conditional_dynamic` 动态提醒） | `tail` |
| `{{loreHint}}` / `{{lore_hint}}` / `{{lore-hint}}` | `<lore-hint>`（TailRadar 世界书关键词雷达提示） | `tail` |
| `{{sideHint}}` / `{{side_hint}}` / `{{side-hint}}` | `<side-hint>`（TailRadar `/side/*` 线索雷达提示） | `tail` |

> 提示：请勿将 `{{loreHint}}`、`{{turnBrief}}`、`{{dynamicReminders}}` 等 Layer 2 动态宏放入 `prefix` 积木中，否则每回合都会导致 Layer 0 前缀缓存失效。

---

## 4. VFS 全量挂载点速查

| 路径 | 权限 | 作用域 / 说明 |
| :--- | :--- | :--- |
| `/output.md` | `rw` | 当前目标消息 `(messageId, swipeId)` 的用户可见正文输出（严格不跨楼层/Swipe 继承） |
| `/state/variables.json` | `rw` | `message` 作用域变量（`chat[id].variables[swipe_id]` + `[InitVar]` 回退） |
| `/state/chat_variables.json` | `rw` | `chat` 作用域变量（`chat_metadata.variables`） |
| `/state/global_variables.json` | `rw` | `global` 作用域变量（`extension_settings.variables.global`） |
| `/workspace/**` | `rw` | 当前聊天工作区；`/workspace/AGENTS.md` 与 `/workspace/docs/**` 跨 Swipe 持久，`/workspace/shared/**` 跟随分支 |
| `/memory/**`、`/scratch/**` | `rw` | 根目录工作区存储（跟随当前分支） |
| `/lorebooks/<book>/<slug>-<uid>.md` | `ro` 基底 + `rw` 分支覆写 | 世界书设定视图（写入只影响当前聊天分支，不改原书） |
| `/character/*` | `ro` + allowlist 覆写 | 当前角色卡字段快照；仅 `CONSTRAINTS.md` / `LESSONS.md` 可写分支覆写 |
| `/persona/*` | `ro` + allowlist 覆写 | 当前人设快照；仅 `CONSTRAINTS.md` / `LESSONS.md` 可写分支覆写 |
| `/skills/<name>.md` | `ro` | `@@skill` 世界书条目挂载 |
| `/preset/*` | `ro` | 当前 ST-Agentic 预设随包静态文件（可随预设导出） |
| `/global/*` | `rw` | 跨聊天全局扩展存储（含 `/global/AGENTS.md`） |
| `/history/*` | `ro` | 分块压缩归档与摘要 |
| `/side/*` | `rw` | 线外探索线索（`comms/*` / `rumors/*` / `notes/*`） |
| `/docs/*` | `ro` | 扩展内置只读文档（默认 `/` 搜索不混入，需显式读或 `pathPrefix: '/docs'`） |
