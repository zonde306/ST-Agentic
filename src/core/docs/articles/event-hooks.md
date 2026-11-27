# 提示词变换与输出校验事件钩子指南（`JS-Slash-Runner` & 扩展）

ST-Agentic 通过 SillyTavern 原生 `eventSource` 向 `JS-Slash-Runner`（酒馆助手脚本）与第三方扩展开放四类事件钩子：
1. **输入文本变换侧**：`agentic_prompt_transform`（及回合生命周期 `agentic_turn_transform_start` / `agentic_turn_transform_end`）
2. **发模前消息预处理 & 收包后响应后处理**：`agentic_prompt_preprocess`、`agentic_output_postprocess`
3. **输出落盘与收尾校验侧**：`agentic_output_process`
4. **异常与中止生命周期**：`agentic_generation_error`、`agentic_turn_interrupted`、`agentic_turn_aborted`

---

## 1. 事件总览

全部事件常量均挂载在 `globalThis.Agentic.events`（`PROMPT_TRANSFORM_EVENTS`）上；所有事件均推荐直接使用事件字符串字面量以脱离扩展加载顺序耦合：

| 事件常量（`Agentic.events.*`） | 事件名字符串 | 触发时机 | 常见用途 |
| :--- | :--- | :--- | :--- |
| `TRANSFORM` | `'agentic_prompt_transform'` | ST `{{...}}` 宏展开**之后**、进入协议编译之前 | 解析自定义模板语法、条件分支重写、按楼层/变量动态注入 |
| `TURN_START` | `'agentic_turn_transform_start'` | 单次生成（`assembleWithHost`）开始时 | 初始化回合级 `sessionBag` 上下文或预加载脚本状态 |
| `TURN_END` | `'agentic_turn_transform_end'` | 单次生成（`assembleWithHost`）结束时（`finally`） | 清理回合状态或回写统计结果 |
| `PROMPT_PREPROCESS` | `'agentic_prompt_preprocess'` | 每轮 LLM 请求发出**之前**（预设预处理脚本与 `@@script on=prompt_preprocess` 之后） | 临时修改发模 `messages` 数组、裁剪历史/工具轮次或覆写请求体 `body`（不污染原楼层与冻结历史） |
| `OUTPUT_POSTPROCESS` | `'agentic_output_postprocess'` | 收到单轮 LLM 原始返回**之时**（预设后处理脚本与 `@@script on=output_postprocess` 之后，工具分派前） | 清洗/改写 `content` / `reasoningContent` / `toolCalls`，或调用 `control.retry` / `requestFix` / `abort` |
| `OUTPUT_PROCESS` | `'agentic_output_process'` | `/output.md` 写入/编辑或回合结束输出校验时 | 正文格式化/清洗、语法检查、要求模型修正或触发重生成 |
| `GENERATION_ERROR` | `'agentic_generation_error'` | 接管模式生成出错且恢复未绕过，或伴生模式检测到酒馆原生 `Generate()` 失败释放生成锁时 | 外部告警提示、错误日志上报、清理扩展临时状态或触发外部补救 |
| `TURN_INTERRUPTED` | `'agentic_turn_interrupted'` | 回合因 `user_stop` / `length` / `error` / `empty_output` 中断并保存可恢复断点时 | 更新外部状态指示、提示用户可「继续」或「回退并重试」 |
| `TURN_ABORTED` | `'agentic_turn_aborted'` | 回合被取消中止（手动停止、Swipe/重生成/删楼/切聊天或脚本调用 `ctx.control.abort()`）时 | 立即回收外部扩展为本次回合创建的临时 UI、定时器或未提交状态 |

---

## 2. 在 `JS-Slash-Runner` 脚本中监听（关键要点）

1. **推荐直接使用事件名字符串**：在酒馆助手常驻脚本（`global` / `character` / `preset`）中，推荐用 `eventOn('agentic_prompt_transform', ...)`、`eventOn('agentic_output_process', ...)`，无需依赖 `globalThis.Agentic` 的加载先后顺序，也无需手动跨 iframe 读取 `window.parent.Agentic`。
2. **`payload` 按引用透传修改**：`eventSource.emit` / `eventOn` 传递的是同一份可变 `payload` 对象，直接在回调内修改 `payload.text` 或调用 `payload.cache.disable(...)` / `payload.control.*` 即可生效。
3. **自动生命周期清理**：`JS-Slash-Runner` 在脚本重载、卸载或楼层 iframe 销毁时会自动移除通过 `eventOn` 注册的监听器。
4. **控制监听优先级与接管内置 EJS**：
   - ST-Agentic 内置的 EJS 处理器通过 `eventSource.makeLast('agentic_prompt_transform', ...)` 注册在**最后**。
   - 若外部脚本想自定义或覆盖 `<% ... %>` EJS 语法处理，只需在自己的处理器中调用 **`payload.handledSyntaxes.add('ejs')`**（可用 `eventMakeFirst` 或普通 `eventOn`），内置 EJS 就会自动让步跳过，防止双重求值。

---

## 3. 输入侧：`agentic_prompt_transform`

### 执行时机与协议透明性
- 触发顺序：**ST 原生宏 `{{...}}` 之后**（与酒馆原生扩展生态一致），处于协议透明的纯文本层——无论是 OpenAI、Claude、Google 还是自定义格式，**只有文本部分会经过该钩子**，图片/多模态非文本 part 不会被破坏。

### `payload` 字段说明
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `text` | `string` | **可写**，当前待发送/待读取的文本；改写请直接赋值给 `payload.text` |
| `rawText` | `string` | 只读，宏展开后、进入本次钩子管线前的原始文本 |
| `source` | `PromptTransformSource` | `'prompt_block'` \| `'system_rule'` \| `'dynamic_reminder'` \| `'user_input'` \| `'chat_message'` \| `'history_read'` \| `'variables_read'` \| `'trigger_prompt'` \| `'vfs_read'` \| `'lore_radar'` \| `'lore_outlet'` \| `'lore_precollect'` |
| `layer` | `PromptTransformLayer` | `'layer0_prefix'` \| `'layer1_ephemeral'` \| `'layer2_tail'` \| `'layer2_floating'` \| `'tool_read'` \| `'trigger'` |
| `role` | `'system' \| 'user' \| 'assistant' \| 'tool'` | 当前消息角色（按区块适用时提供） |
| `dryRun` | `boolean` | 只读；如 `TailRadar` 触发预览扫描时为 `true`，此时外部逻辑应避免产生持久化副作用 |
| `handledSyntaxes` | `Set<string>` | 已接管语法标记集合（例如 `payload.handledSyntaxes.add('ejs')`、`payload.handledSyntaxes.add('my-syntax')`） |
| `sessionBag` | `Record<string, unknown>` | 同一回合多次变换间共享的可变状态包（在 `TURN_START` → 各区块 `TRANSFORM` → `TURN_END` 之间共享） |
| `cache` | `PromptTransformCacheControl` | 缓存控制器（见下节） |
| `signal` | `AbortSignal?` | 中止信号（用户 Stop / Swipe / Regenerate 时触发） |
| `reportError(err, extId?)` | `(unknown, string?) => void` | 记录非致命错误而不中断整次上下文装配 |

### `payload.meta` 元数据与 ST 楼层定位
依赖**聊天楼层 / depth** 的扩展（如读取当前楼层变量或按历史位置分支）务必关注以下坐标字段：

| `meta` 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `target` | `{ messageId: number; swipeId: number }?` | 本次生成回合锚定的 ST 聊天目标楼层与 Swipe |
| `messageId` | `number?` | 若 `isChatMessage === true` 则是**该历史/用户输入消息自身**的 ST 楼层索引；若 `isChatMessage === false`（如 `prompt_block`、`system_rule`、`vfs_read`、`lore_radar` 等）则自动对齐为锚点 `target.messageId` |
| `swipeId` | `number?` | 同上规则对应的 Swipe 索引 |
| `isChatMessage` | `boolean` | 区分当前文本是否属于 ST 聊天消息楼层（`chat_message` 或主回合 `user_input`） |
| `name` | `string?` | 发送者或消息块自定义 `name` |
| `isUser` | `boolean?` | `isChatMessage === true` 时标明是否为用户消息 |
| `editable` | `boolean?` | `vfs_read` / `lore_radar` / `variables_read` 专属：`read_file` 目标路径允许当前 Agent `edit_file` 时（或工作台可写模式 `read_variables` 时）为 `true`。**重要约定**：若你的扩展会转换自定义语法且想兼容模型 `edit_file`，看到 `editable === true` 时请跳过展开或保留原文，避免搜索片段失配 |
| `writable` | `boolean?` | 当前路径或变量作用域是否允许写入 |
| `toolName` / `toolCallId` | `string?` | 工具返回送入上下文前的拦截标识（如 `'read_history'`、`'read_variables'`、`'read_file'`） |
| `path` / `mount` | `string?` | VFS 文件路径与挂载点（`vfs_read` / `history_read` / `variables_read` / `lore_radar` 时提供） |
| `blockId` / `blockName` / `placement` | `string?` | 预设 `PromptBlock` 元数据 |
| `lore` | `{ world, uid, comment, overridden }?` | 世界书条目元数据 |
| `vars` | `Readonly<Record<string, unknown>>?` | 当前可用变量只读快照 |

### 缓存控制（KV Cache 友好 + 历史/工具/工作台统一规则）
- **「一次未禁缓存即可入缓存」原则**：对于所有文本消息——包括 **ST 聊天/历史消息**（`ephemeral`、`persistent` Layer 1 轨迹、工作台 `AssistantRunner` 对话与 `SideGenService` 主聊天参考/会话历史）、预设积木、以及 **`read_history`（整段文本）** 和 **`read_variables`（原始 JSON 字符串，不做强修解析）**——只要任意一次经过 `agentic_prompt_transform` **未调用 `payload.cache.disable()`**，结果就会自动进入缓存并固化到上下文中，**后续回合不再重复触发钩子**，保证 KV Cache 命中率。
- **标记为不可缓存（动态分支）**：如果你的脚本支持**依赖运行时变量的动态分支**，调用：
  ```js
  payload.cache.disable('depends on runtime hp', 'my-ext');
  ```
  ST-Agentic 会保留原文并仅对该 `PromptBlock`、`system_rule`、历史消息或工具结果在后续回合/轮次中**选择性重算**（直到某次不再禁缓存后才入缓存），不会破坏其他静态缓存块。
- 若结果仅随特定键值变化，也可调用 `payload.cache.addKey('my-ext', String(keyValue))` 将该键纳入分支指纹。

### 生命周期事件：`agentic_turn_transform_start` & `agentic_turn_transform_end`
`payload` 包含 `{ version: 1, sessionId, agentId?, phase?, target?, messageId?, swipeId?, vars?, sessionBag, signal? }`，用于在多段变换开始/结束时做一次性状态准备或回收。

---

## 4. 输出侧：`agentic_output_process`

### 触发边界（仅核心输出，不打扰普通过程）
该事件覆盖 **`AgentRunner`（主回合 / Trigger / 子代理）、`AssistantRunner`（侧边助手）、`SideGenService`（侧边支线/辅助生成）** 三大执行引擎，但**仅在以下两类时机触发**：
1. **`stage: 'output_mutation'`**：模型调用工具修改 `/output.md`（仅限目标为 `/output.md` 的 `write_file` / `append_file` / `edit_file`，以及 `append_reply_view` / `replace_reply_view`）。
2. **`stage: 'turn_finish'`**：回合即将结束产出最终结果时——同时兼容开启 `strictToolLoop` 的 **`finish_turn`**（`operation: 'finish_turn'`）与关闭 `strictToolLoop` 的无工具纯文本结束（**`operation: 'plain_finish'`**）。

> **不会触发的场景**：读写 `/memory/**`、`/notes/**`、`read_file` 等普通工具调用，以及工具循环中途未结束时的过程思考/预热 `assistant.content`，均**不会**触发 `agentic_output_process`。

### `payload` 与 `meta` 字段说明
| 字段 | 说明 |
| :--- | :--- |
| `payload.text` / `payload.originalText` | `text` **可写**（就地清洗/重写最终正文或草稿）；`originalText` 为本次事件原始文本 |
| `meta.runner` | `'agent'` \| `'assistant'` \| `'sidegen'` |
| `meta.stage` | `'output_mutation'` \| `'turn_finish'` |
| `meta.operation` | `'write_file'` \| `'append_file'` \| `'edit_file'` \| `'append_reply_view'` \| `'replace_reply_view'` \| `'finish_turn'` \| `'plain_finish'` |
| `meta.finishMode` | `'strict_tool'` \| `'plain_text'` |
| `meta.target` / `meta.messageId` / `meta.swipeId` | 当前生成绑定的 ST 聊天锚点楼层与 Swipe（方便通过 `getVariables({ type: 'message', message_id: meta.messageId })` 做上下文校验） |
| `meta.round` | 当前轮次（从 1 开始） |
| `meta.retryAttempt` / `meta.maxRetries` | 当前重试次数及连接配置的 `roundMaxRetries` 上限 |
| `meta.fixAttempt` / `meta.maxFixAttempts` | 当前回退自愈修正次数及上限（默认 `3`） |
| `meta.previousText` | `output_mutation` 专属：变更前的 `/output.md` 内容（`edit_file` 时 `payload.text` 已是合并模拟后的完整候选内容） |
| `meta.toolCallId` / `meta.toolName` / `meta.filePath` | 相关工具调用与路径信息 |
| `meta.agentId` / `meta.agentName` / `meta.triggerId` / `meta.surface` | 运行来源识别信息 |
| `meta.sessionBag` | 同一次执行全过程共享的对象 |

### 三种响应动作（严格遵循次数上限）
通过 `payload.control` 控制后续流程（单调优先级：**`retry` > `fix` > `accept`**）：

1. **直接放行 / 就地改写**（默认 `accept`）：
   - 直接修改 `payload.text = sanitizedText` 即可；`output_mutation` 会写入改写后的文本，`turn_finish` 会以改写后的文本作为最终输出。
2. **要求模型在回合内自我修正（`requestFix`）**：
   - 语法错误或内容不合规但不想直接浪费轮次整轮重摇时使用：
     ```js
     payload.control.requestFix('缺少闭合的 </scene> 标签', {
       rejectWrite: true, // 仅对 output_mutation 生效：true=拦截本次写入；false(默认)=落盘草稿并在 tool_result 注入 validationWarning 提醒改正
       extId: 'my-validator',
     });
     ```
   - 在 `turn_finish` 阶段调用 `requestFix(...)` 时，会拒绝结束（对 `finish_turn` 返回错误回执、对 `plain_finish` 追加修正提示消息，并自动回滚本轮未提交的流式缓冲），让模型在下一轮改正。
   - **上限兜底**：当 `meta.fixAttempt >= meta.maxFixAttempts` 时自动停止拦截并放行，防止无限死循环。
3. **触发重新生成（`retry`）**：
   - 调用 **`payload.control.retry('格式校验失败', 'my-validator')`**。
   - 触发后在 `output_mutation` 会在写入 `/output.md` 或追加对话历史前直接丢弃该次尝试，走各 Runner 原生指数退避 + `roundMaxRetries` 重试循环重新生成。
   - **上限兜底**：严格遵守 `roundMaxRetries`；一旦达到 `meta.retryAttempt >= meta.maxRetries`，**不再继续重试**，直接放行当前输出。
   - 补充：`AgentRunner` 的 `main_output` 模式在 `turn_finish` 阶段（此时 `/output.md` 已在上一轮写完，纯重摇 `finish_turn` 工具调用无法改动文件内容）若触发 `retry()`，会自动转为打回修正请求，引导模型去 `edit_file`/`write_file` 修改 `/output.md`（若额度已满同样直接放行）。

---

## 4b. 发模前预处理 & 收包后响应后处理（`agentic_prompt_preprocess` / `agentic_output_postprocess`）

除了预设内建脚本与世界书 `@@script on=prompt_preprocess` / `on=output_postprocess`，ST-Agentic 也将这两处扩展点直接通过 `eventSource` 导出，便于外部扩展与 `JS-Slash-Runner` 脚本参与每轮 LLM 请求的临时消息预处理和原始响应后处理（无监听器时自动零开销跳过）。

### 执行顺序与安全隔离
- **预处理链路**：预设 `preprocessScript` → `@@script on=prompt_preprocess` → `eventSource.emit('agentic_prompt_preprocess', payload)`（共享同一份临时 `messages` 控制器与 `body` 覆写对象）。修改**仅作用于当前单次 LLM 请求**，绝不写回酒馆原消息或污染 `TrajectoryStore` 冻结历史，且发出前自动校验并清洗 `tool_call_id` 成对完整性。
- **后处理链路**：预设 `postprocessScript` → `@@script on=output_postprocess` → `eventSource.emit('agentic_output_postprocess', payload)`（共享同一份 `output` 与单调控制器 `control`，优先级 `abort > retry > fix > accept`）。
- **异常隔离**：外部监听器抛出非中止异常会被捕获并记录到 `payload.errors`，不会中断整轮生成。

### `agentic_prompt_preprocess` 的 `payload` 字段
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `payload.messages` | `ToolEphemeralMessagesApi` | 安全临时消息控制器：`list()`、`set(next)`、`rollbackToolRounds(n)`、`dropHistoryTurns(n, { from })`、`replaceContent(selector, replacer)`、`appendHint(content, role?)`、`toMessages()` |
| `payload.body` | `Record<string, unknown>` | 可变请求体参数覆写（如 `temperature`、`max_tokens`、`stream` 或供应商自定义字段） |
| `payload.layers` | `{ layer0End, layer1End, turnStart, floatingTailStart }` | 实时分层边界索引（随 `dropHistoryTurns` / `rollbackToolRounds` 动态更新） |
| `payload.event` | `ToolEventPayload` | 规范事件快照（`type: 'prompt_preprocess'`，`event.data.layers` 同上） |
| `payload.meta` | `PromptPreprocessHookMeta` | `{ runner, runId, phase, agentId, agentName, triggerId, target, messageId, swipeId, round, attempt, maxRetries, model, connectionId, providerFormat, vars }` |
| `payload.signal` | `AbortSignal?` | 中止信号 |
| `payload.reportError(err, extId?)` | `(unknown, string?) => void` | 记录非致命错误 |

### `agentic_output_postprocess` 的 `payload` 字段
| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `payload.output` | `ToolPostprocessOutput` | 可写对象：`content` / `text`（双向同步）、`reasoningContent`、`toolCalls`（以及只读 `originalText`、`round`、`fixAttempt`、`maxFixAttempts`） |
| `payload.control` | `ToolPostprocessControl` | 单调流控：`retry(reason?)`、`requestFix(message, { rejectWrite? })`、`accept()`、`abort(reason?)`（自动受 `roundMaxRetries` 与 `maxFixAttempts` 上限保护） |
| `payload.event` | `ToolEventPayload` | 规范事件快照（`type: 'output_postprocess'`） |
| `payload.meta` | `OutputPostprocessHookMeta` | `{ runner, runId, phase, agentId, agentName, triggerId, target, messageId, swipeId, round, attempt, maxRetries, fixAttempt, maxFixAttempts, model, connectionId, providerFormat, finishReason, vars }` |
| `payload.signal` | `AbortSignal?` | 中止信号 |
| `payload.reportError(err, extId?)` | `(unknown, string?) => void` | 记录非致命错误 |

---

## 5. 异常与中止生命周期事件（`agentic_generation_error` / `agentic_turn_interrupted` / `agentic_turn_aborted`）

除了输入/输出文本变换外，ST-Agentic 会在生成报错、回合中断保存断点或回合中止取消时，向 SillyTavern 原生 `eventSource` 广播通知事件（只读通知，外部扩展或 `JS-Slash-Runner` 通过 `eventOn(...)` 直接监听；若需在沙箱内执行消息回退重试控制，请使用 `/docs/scripts.md` 中的 `@@script on=generation_error`）。

### 触发时机对照

| 事件名 | 触发时机 | 典型触发来源 |
| :--- | :--- | :--- |
| **`'agentic_generation_error'`** | 1. **接管模式**：单轮请求耗尽自动重试且错误恢复脚本未成功绕过，或发生不可恢复异常导致失败时；<br>2. **伴生模式**：检测到 ST 原生 `Generate()` 出错导致生成锁释放且未收到 `MESSAGE_RECEIVED` / `GENERATION_ENDED` 时（同步已清理残留暂存与注入提示词） | API HTTP 4xx/5xx、网络断流、内容审查、工具异常、原生 `Generate()` 失败 |
| **`'agentic_turn_interrupted'`** | 回合非正常结束但已保存 `InterruptedTurnCheckpoint` 断点，可在控制台日志中点击「继续」或「回退并重试」时 | `reason` 为 `'user_stop'` \| `'length'` \| `'error'` \| `'empty_output'` |
| **`'agentic_turn_aborted'`** | 回合被彻底中止取消时 | 用户手动停止、Swipe 切分支、Regenerate、删除楼层、切换聊天，或恢复脚本调用 `ctx.control.abort(...)` |

### `payload` 字段说明（统一遵循 `ToolEventPayload`）

三个事件对外派发的 `payload` 统一采用 `ToolEventPayload` 结构（未涉及的上下文可选字段为 `undefined`）：

| 字段 | 类型 | 说明 |
| :--- | :--- | :--- |
| `type` | `TriggerEventType \| string` | 对应内部事件名：`'generation_error'` \| `'turn_interrupted'` \| `'turn_aborted'` |
| `timestamp` | `number` | 事件触发时的 Unix 毫秒时间戳 |
| `target` | `{ messageId: number; swipeId: number }?` | 本次生成锚定的 ST 聊天目标楼层与 Swipe |
| `messageId` | `number?` | 目标楼层索引（便捷顶层字段，等同 `target.messageId`） |
| `swipeId` | `number?` | 目标 Swipe 索引（便捷顶层字段，等同 `target.swipeId`） |
| `phase` | `'before_turn' \| 'main_turn' \| 'after_turn' \| 'maintenance'?` | 所属四阶段管线阶段 |
| `runId` | `string?` | 对应 `AgentRunTrace.runId`，可用于关联控制台日志 |
| `agentId` | `string?` | 执行中的智能体 Profile ID |
| `triggerId` | `string?` | 若由触发器发起，为对应的 `TriggerRule.id` |
| `round` | `number?` | 发生事件时所在的工具循环轮次 |
| `attempt` / `maxAttempts` | `number?` | 当前重试/恢复尝试次数及上限 |
| `error` | `string?` | 错误描述文本（`agentic_generation_error` / `error` 中断时提供） |
| `errorCode` | `string?` | 结构化错误码（如有，如上游错误码或内部异常码） |
| `statusCode` | `number?` | 上游 HTTP 状态码（如 `400`、`429`、`500`，如有） |
| `reason` | `'user_stop' \| 'length' \| 'error' \| 'empty_output' \| string?` | 中断或中止原因（`agentic_turn_interrupted` / `agentic_turn_aborted` 重点字段） |
| `output` | `string?` | 中断或失败前已产生的部分输出预览（如有） |
| `data` | `Record<string, unknown>?` | 附加结构化上下文（如 `layers`、模式标识、是否可回退等扩展信息） |

---

## 6. `JS-Slash-Runner` 实战模板（可直接复制）

### 模板 1：按楼层变量展开自定义语法（兼容 `edit_file` 与缓存控制）
```js
// 在全局或角色常驻 JS-Slash-Runner 脚本中使用
eventOn('agentic_prompt_transform', (payload) => {
  // 1. 仅预览干跑不改，或遵循 edit_file 保护约定：可编辑的 read_file 原样保留源码
  if (payload.meta.editable === true) {
    return;
  }
  if (typeof payload.text !== 'string' || !payload.text.includes('[[HP_STATUS]]')) {
    return;
  }

  // 2. 用 meta.messageId 精确定位对应楼层的 ST 变量（与 depth / 楼层隔离一致）
  const msgId = payload.meta.messageId;
  const msgVars = typeof msgId === 'number'
    ? (getVariables({ type: 'message', message_id: msgId }) || {})
    : (getVariables({ type: 'chat' }) || {});

  const hp = Number(msgVars.hp ?? 100);
  // 3. 声明依赖运行时变量、不可静态缓存：ST-Agentic 会仅对当前区块按回合/轮次重算
  payload.cache.disable('depends on message variable hp', 'my-status-macro');
  payload.handledSyntaxes.add('my-status-macro');

  payload.text = payload.text.replaceAll('[[HP_STATUS]]', `当前生命值：${hp}`);
});
```

### 模板 2：输出标签校验与自动修正 / 限次重生成
```js
eventOn('agentic_output_process', (payload) => {
  // 只校验写往 /output.md 或最终回合提交的内容（包括 agent / assistant / sidegen）
  const text = payload.text;

  // 示例 1：写入 /output.md 时如缺少必需标签，优先让模型在回合内自己补正
  if (payload.meta.stage === 'output_mutation') {
    if (text.includes('<panel>') && !text.includes('</panel>')) {
      payload.control.requestFix('检测到未闭合的 <panel> 标签，请补全 </panel>。', {
        rejectWrite: true, // 阻断错误草稿覆盖 /output.md；若设为 false 则先落盘并给警告
        extId: 'panel-linter',
      });
    }
    return;
  }

  // 示例 2：turn_finish 阶段（同时兼容 finish_turn 与关闭工具循环后的 plain_finish）
  if (payload.meta.stage === 'turn_finish') {
    if (text.includes('<FORBIDDEN_MARKER>')) {
      if (payload.meta.retryAttempt < payload.meta.maxRetries) {
        // 仍有重试额度时触发重生成；额度耗尽后框架也会自动放行不会死循环
        payload.control.retry('输出包含禁用占位符 <FORBIDDEN_MARKER>', 'panel-linter');
      } else {
        // 兜底清洗
        payload.text = text.replaceAll('<FORBIDDEN_MARKER>', '').trim();
      }
    }
  }
});
```

### 模板 3：利用 `TURN_START` / `TURN_END` 共享回合统计（`sessionBag`）
```js
eventOn('agentic_turn_transform_start', (ev) => {
  ev.sessionBag.myExtHits = 0;
  ev.sessionBag.anchorMsgId = ev.messageId;
});

eventOn('agentic_turn_transform_end', (ev) => {
  // 可在回合装配完成时查看本轮命中次数或清理临时状态
  // console.debug('[my-ext] msgId:', ev.messageId, 'hits:', ev.sessionBag.myExtHits);
});
```

### 模板 4：监听 `agentic_generation_error` / `agentic_turn_interrupted` / `agentic_turn_aborted` 做外部状态同步与告警
```js
eventOn('agentic_generation_error', (ev) => {
  console.warn(
    `[my-ext] 生成失败 phase=${ev.phase ?? 'unknown'} msg=#${ev.messageId ?? '?'} HTTP=${ev.statusCode ?? '-'}:`,
    ev.error,
  );
  // 可在此关闭自定义面板的 loading 指示器或写入外部故障记录
});

eventOn('agentic_turn_interrupted', (ev) => {
  console.info(
    `[my-ext] 回合已中断并保留断点 runId=${ev.runId ?? '-'} reason=${ev.reason ?? 'unknown'}`,
  );
});

eventOn('agentic_turn_aborted', (ev) => {
  console.info(
    `[my-ext] 回合已中止 msg=#${ev.messageId ?? '?'} reason=${ev.reason ?? 'aborted'}`,
  );
  // 清理外部脚本为该楼层创建的临时状态或定时器
});
```

### 模板 5：外部扩展参与发模前预处理与收包后响应后处理
```js
// 发给 LLM 前：临时附加提示或动态微调采样参数（绝不改写原聊天与历史缓存）
eventOn('agentic_prompt_preprocess', (payload) => {
  if (payload.meta.phase !== 'main_turn') return;
  if (payload.meta.round === 1) {
    payload.messages.appendHint('[External Ext] 保持对话简洁自然。', 'user');
    payload.body.temperature = 0.85;
  }
});

// 收到 LLM 原始返回时：清洗多余包裹标签，或触发单轮重试/修正
eventOn('agentic_output_postprocess', (payload) => {
  if (payload.output.content?.includes('<UNWANTED_TAG>')) {
    payload.output.content = payload.output.content.replace(/<UNWANTED_TAG>[\s\S]*?<\/UNWANTED_TAG>/g, '').trim();
  }
  if (payload.output.toolCalls?.length === 0 && !payload.output.content?.trim()) {
    payload.control.retry('模型返回空内容');
  }
});
```
