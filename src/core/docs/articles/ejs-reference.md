# `ST-Prompt-Template` 完整 API、装饰器与标记速查

> 本文件精炼整理自 `ST-Prompt-Template` 官方参考与功能文档。
>
> **与 ST-Agentic 的集成边界**：
> 1. **接管模式 (`takeover`)**：`@@render_*`、`@@iframe`、`@@message_formatting`、`@@preload`、`@@only_preload`、`@@initial_variables` 在消息渲染和开卡加载阶段依然生效；但 `@@generate_*`、`[GENERATE:*]`、`@INJECT` 仅在 ST 原生拼装链路运行，**接管模式下不会生效**（接管模式请改用 ST-Agentic 的 `PromptBlock` 或 `@@trigger phase=before`）。
> 2. **变量互通**：`getvar`/`setvar` 的 `scope` 中，`message` ↔ `/state/variables.json`，`local` ↔ `/state/chat_variables.json`（ST-Agentic 称 `chat`），`global` ↔ `/state/global_variables.json`。在 ST-Agentic 的 `@@*_ejs` 与 `PromptBlock` 中优先读 `vars`（含当前轮 staged 最新值）。

---

## 1. EJS 内置函数速查

### 变量读写与补丁
```ts
// options 可传对象，也可直接简写传 FlagOption | ScopeOption | ResultOption | dryRun(boolean)
setvar(key: string | null, value: any, options?: SetVarOption | SimpleOptions)
setLocalVar(key, value, options?) / setGlobalVar(key, value, options?) / setMessageVar(key, value, options?)

getvar(key: string | null, options?: GetVarOption | SimpleOptions): any
getLocalVar(key, options?) / getGlobalVar(key, options?) / getMessageVar(key, options?)

incvar(key: string, value = 1, options?: GetSetVarOption | SimpleOptions)
incLocalVar(...) / incGlobalVar(...) / incMessageVar(...)
decvar(key: string, value = 1, options?: GetSetVarOption | SimpleOptions)
decLocalVar(...) / decGlobalVar(...) / decMessageVar(...)

delvar(key: string, index?: string | number, options?: SetVarOption)
delLocalVar(...) / delGlobalVar(...) / delMessageVar(...)

insvar(key: string, value: any, index?: string | number, options?: SetVarOption)
insertLocalVar(...) / insertGlobalVar(...) / insertMessageVar(...)

patchVariables(key: string | null, change: JsonPatchOp[], options?: SetVarOption)
jsonPatch(dest: object, change: JsonPatchOp[]): object
parseJSON(text: string): any // 宽松 JSON 解析器，容忍部分 LLM 畸形 JSON
setVariableSchema(schema: z.ZodType<object> | object): void // 根对象需 loose
```

**关键选项说明**：
- `scope`（`getvar` 默认 `'cache'`，`setvar` 默认 `'message'`；`incvar/decvar` 用 `inscope` 默认 `'cache'`、`outscope` 默认 `'message'`）：
  - `'global'`（全局 `extension_settings.variables.global`）| `'local'`（当前聊天 `chat_metadata.variables`）| `'message'`（消息楼层 `chat[id].variables[swipe_id]`）| `'cache'`（本次渲染临时 `variables`，不保存）| `'initial'`（`[InitialVariables]`）
- `flags`：`'n'` 直接写入（默认）| `'nx'` `cache` 不存在时才写 | `'xx'` `cache` 存在时才写 | `'nxs'` 按目标 `scope` 不存在时写 | `'xxs'` 按目标 `scope` 存在时写
- `results`：`'new'` 返回新值（默认）| `'old'` 返回旧值 | `'fullcache'` 返回更新后的整个 `variables` 缓存
- `noCache: true`：写入后若同一次模板内要立刻读取新值，需传 `noCache: true`（否则 `variables` 缓存只在开局加载一次）
- `dryRun: true`：允许在 `preparation` 准备阶段也执行写变量（通常不建议开，防止准备阶段重复执行多次；更新楼层消息不算准备阶段）
- `merge: true`：使用 `_.merge` 合并设置
- `withMsg`：`{ role?: 'system'|'user'|'assistant'|'any', id?: number, swipe_id?: number }`（`id` 支持负数从末尾倒数；设置 `id` 后 `role` 失效）
- `clone: true`（`getvar`）：返回深拷贝而非引用；`defaults`：不存在时的默认值；`min` / `max`（`incvar`/`decvar`）

### 读取与激活世界书 / 角色 / 预设 / 快速回复 / 楼层
```ts
// 读取条目并经过模板求值（同世界书递归调用可省略 lorebook）
await getwi(lorebook: string, title: string | RegExp | number, data = {}): Promise<string>
await getwi(title: string | RegExp | number, data = {}): Promise<string>
// 别名: getWorldInfo(...)

// 触发酒馆原生 🟢 关键词激活（支持隐藏条目；force=true 忽略关键词/分组/冷却强制激活；建议在 [GENERATE:BEFORE]/@@generate_before 中调用）
await activewi(lorebook: string, title: string | RegExp | number, force = false): Promise<WorldInfoData | null>
await activewi(title: string | RegExp | number, force = false): Promise<WorldInfoData | null>
// 别名: activateWorldInfo(...)
await activateWorldInfoByKeywords(keywords: string, condition?: ActivateWorldInfoCondition): Promise<WorldInfoData[]>

// 读取未经过模板处理的原始世界书数组 / 已激活条目
await getWorldInfoData(name: string): Promise<WorldInfoData[]>
await getWorldInfoActivatedData(name: string, keyword: string | string[], condition?: ActivateWorldInfoCondition): Promise<WorldInfoData[]>
await getEnabledWorldInfoEntries(chara = true, global = true, persona = true, charaExtra = true, onlyExisting = true): Promise<WorldInfoData[]>
selectActivatedEntries(entries: WorldInfoData[], keywords: string | string[], condition?: ActivateWorldInfoCondition): WorldInfoData[]
// ActivateWorldInfoCondition: { constant?: boolean|null, disabled?: boolean|null, vectorized?: boolean|null }

// 读取角色卡 / 预设 / 快速回复 / 聊天消息
await getchar(name = this_chid, template = DEFAULT_CHAR_DEFINE, data = {}): Promise<string> // 别名 getChara
await getCharData(name = this_chid): Promise<v1CharData | null> // 原始未求值角色卡数据
await getpreset(name: string | RegExp, data = {}): Promise<string> // 别名 getPresetPrompt
await getqr(name: string | RegExp, label: string | RegExp, data = {}): Promise<string> // 别名 getQuickReply（仅已启用 QR 集）
getQuickReplyData(name: string | RegExp): QuickReplySetLink | null

getChatMessage(idx: number, role?: 'user' | 'assistant' | 'system'): string
getChatMessages(count: number, role?): string[]
getChatMessages(start: number, end: number, role?): string[]
matchChatMessages(pattern: string | RegExp | (string | RegExp)[], options?: { start?: number, end?: number, role?, and?: boolean }): boolean
```

### 函数定义、输出、Slash、临时正则与依赖注入
```ts
// 全局注册变量或函数（定义函数必须用 function() {} 且内部用 this.getvar / this.setvar）
define(name: string, value: any, merge = false): void
print(...args: string[]): void // 只能在 <% %> 语句块中调用，不可在 <%= 或 <%- 内调用
await execute(cmd: string): Promise<string> // 执行 ST Slash 命令
await evalTemplate(content: string, data = {}, options = {}): Promise<string>

// 在 ST-Prompt-Template 管线内临时注入正则或提示词分组
activateRegex(pattern: string | RegExp, replace: string | ((m, ...args) => string), opts?: {
  uuid?: string, minDepth?: number, maxDepth?: number,
  user?: boolean, assistant?: boolean, worldinfo?: boolean, reasoning?: boolean,
  message?: boolean, generate?: boolean, basic?: boolean,
  order?: number, before?: boolean, html?: boolean, sticky?: number
})
injectPrompt(key: string, prompt: string, order = 100, sticky = 0, uid = ''): void
getPromptsInjected(key: string, postprocess?: { search: string | RegExp, replace: string }[]): string
hasPromptsInjected(key: string): boolean
```

---

## 2. 内置常量与阶段字段

- **通用常量**：`variables`（按 `global → local → message` 合并，渲染某楼层时不计入当前及后续楼层）、`SillyTavern`（`SillyTavern.getContext()`）、`faker`（`faker.fakerCN` / `faker.fakerEN`）、`_`（Lodash）、`$`（jQuery）、`toastr`
- **会话与环境**：`runType`（`'generate' | 'preparation' | 'render' | 'render_permanent'`）、`charLoreBook`、`userLoreBook`、`chatLoreBook`、`userName`、`charName`、`chatId`、`characterId`、`groupId`、`groups`、`charAvatar`、`userAvatar`、`lastUserMessageId`、`lastCharMessageId`、`model`、`generateType`、`lastUserMessage`、`lastCharMessage`、`lastMessageId`
- **仅 `runType === 'render'` 可用**：`message_id`、`swipe_id`、`name`、`is_last`、`is_user`、`is_system`
- **仅 `@@generate_*` / `[GENERATE:*]` 可用**：`world_info`、`generateBuffer`、`generateData`
- **Regex 标题匹配可用**：`matched_message`、`matched_message_index`、`matched_message_role`
- **统计变量（只读）**：`LAST_SEND_TOKENS`、`LAST_SEND_CHARS`、`LAST_RECEIVE_TOKENS`、`LAST_RECEIVE_CHARS`

---

## 3. `ST-Prompt-Template` 16 个装饰器与标题标记

### 16 个 `@@` 装饰器（写在世界书条目开头连续行，无空行）
| 装饰器 | 作用 |
| :--- | :--- |
| `@@activate` | 忽略 🟢 关键词，视同 🔵 常驻激活 |
| `@@dont_activate` | 彻底禁止激活（连 `activewi` 也跳过） |
| `@@generate_before` | 等同 `[GENERATE:BEFORE]`：仅在 🔵 常驻时注入发送到 LLM 的提示词最前（接管模式不走） |
| `@@generate_after` | 等同 `[GENERATE:AFTER]`：注入发送到 LLM 的提示词末尾（接管模式不走） |
| `@@render_before` | 等同 `[RENDER:BEFORE]`：仅在 🔵 时注入接收到的消息渲染内容最前（不发给 LLM） |
| `@@render_after` | 等同 `[RENDER:AFTER]`：注入每条消息渲染内容末尾（不发给 LLM，常用于状态栏） |
| `@@message_formatting` | 仅对 `[RENDER]` / `@@render_*` 生效：按 Markdown/HTML/正则格式化输出（配合 ```` ```html ```` 可转交 `JS-Slash-Runner` 渲染） |
| `@@iframe [折叠标题]` | 把 `@@render_before` / `@@render_after` 包裹进独立 `<iframe>` 防样式污染；带标题且非空时自动折叠 |
| `@@if <单行JS条件>` | 条件为假时把该条目从处理流程排除（如 `@@if !is_user && !is_system`） |
| `@@preload` | 开卡「立即加载世界书」阶段强制执行一次（可与 `@@generate_*`/`@@render_*` 共存） |
| `@@only_preload` | 仅在开卡预加载阶段执行，不在生成或渲染阶段激活 |
| `@@dont_preload` | 最高优先级禁止预加载 |
| `@@initial_variables` | 等同 `[InitialVariables]`：将正文解析为 JSON 或 YAML 作为初始变量树（始终参与预加载） |
| `@@always_enabled` | 强制启用特殊条目（无视禁用状态） |
| `@@private` | 自动在条目首尾包裹 `<% { %>` 和 `<% } %>`，防止跨条目 `let`/`const` 重名报错 |
| `@@preprocessing` | 等同 `[Preprocessing]`：在 ST 原生世界书关键词扫描之前先跑模板计算，实现动态 🟢 递归激活 |

> **关键规则**：
> - `ST-Prompt-Template` 会**静默丢弃不认识的 `@@xxx` 行**；用 `@@@` 转义字面量 `@@`。
> - 默认开启「仅预加载 PRELOAD 条目」，需要在开卡时执行的 `define()` 初始化必须显式加 `@@preload` 或 `@@only_preload`。
> - 旧版兼容开关 `invert_enabled` 开启时，特殊条目需处于**禁用**状态才会被执行；关闭时需处于**启用**状态（或加 `@@always_enabled`）。

### 标题前缀标记 & 作用域转义
- `[GENERATE:BEFORE]`、`[GENERATE:AFTER]`、`[GENERATE:{idx}:BEFORE|AFTER]`（`idx` 从 0 起）、`[GENERATE:REGEX:pattern]`
- `[RENDER:BEFORE]`、`[RENDER:AFTER]`、`[InitialVariables]`（支持 JSON / YAML）、`[Preprocessing]`
- `@INJECT pos=<1起/负数>,role=system|user|assistant` / `@INJECT target=user|assistant|system,index=1,at=before|after,role=...` / `@INJECT regex=pattern,at=before|after,role=...`（注意条目需按设置置为未激活/特殊条目状态，接管模式不生效）
- `<#escape-ejs>...<#/escape-ejs>`：包裹区间内的 `<%` / `%>` 会自动转义为 `<%%` / `%%>` 避免提前求值。

---

## 4. STscript、`globalThis.EjsTemplate` 与 `EjsSettings`

- **STscript**：`/ejs [ctx=object] [block=boolean] code`、`/ejs-refresh`（重载全部世界书模板）。
- **扩展全局 API (`globalThis.EjsTemplate`)**：
  - `await prepareContext(context = {}, last_message_id = 65535)` / `await evalTemplate(code, context = {}, options = {})` / `await compileTemplate(code, options = {})`
  - 修改 `prepareContext()` 返回对象时**必须原地修改**（如 `_.merge(env, { a: 1 })`），不要 `{ ...env, a: 1 }` 浅拷贝，否则内置函数 `this` 上下文会丢失。
  - 辅助方法：`getSyntaxErrorInfo(code, max_lines = 4)`、`allVariables(end = Infinity)`、`await saveVariables()`、`await refreshWorldInfo()`、`getFeatures()` / `setFeatures(patch)` / `resetFeatures()`。
- **`extension_settings.EjsTemplate` 主要配置键**（可用 `st_settings_read({ scope: 'EjsTemplate' })` 查看）：
  `enabled`, `generate_enabled`, `generate_loader_enabled`, `render_enabled`, `render_loader_enabled`, `with_context_disabled`, `debug_enabled`, `autosave_enabled`, `preload_worldinfo_enabled`, `code_blocks_enabled`, `raw_message_evaluation_enabled`, `filter_message_enabled`, `cache_enabled` (`0|1|2`), `cache_size`, `cache_hasher`, `inject_loader_enabled`, `invert_enabled`, `compile_workers`, `sandbox`。
