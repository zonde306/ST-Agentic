# 提示词变换与输出校验事件钩子指南（`JS-Slash-Runner` & 扩展）

ST-Agentic 通过 SillyTavern 原生 `eventSource` 向 `JS-Slash-Runner`（酒馆助手脚本）与第三方扩展开放两套**对底层 API 协议透明**的纯文本钩子：
1. **输入侧**：`agentic_prompt_transform`（及回合生命周期 `agentic_turn_transform_start` / `agentic_turn_transform_end`）
2. **输出侧**：`agentic_output_process`

---

## 1. 事件总览

所有事件常量统一挂载在 `globalThis.Agentic.events`（`PROMPT_TRANSFORM_EVENTS`）上，同时也推荐直接使用事件字符串字面量以脱离扩展加载顺序耦合：

| 事件常量（`Agentic.events.*`） | 事件名字符串 | 触发时机 | 常见用途 |
| :--- | :--- | :--- | :--- |
| `TRANSFORM` | `'agentic_prompt_transform'` | ST `{{...}}` 宏展开**之后**、进入协议编译之前 | 解析自定义模板语法、条件分支重写、按楼层/变量动态注入 |
| `TURN_START` | `'agentic_turn_transform_start'` | 单次生成（`assembleWithHost`）开始时 | 初始化回合级 `sessionBag` 上下文或预加载脚本状态 |
| `TURN_END` | `'agentic_turn_transform_end'` | 单次生成（`assembleWithHost`）结束时（`finally`） | 清理回合状态或回写统计结果 |
| `OUTPUT_PROCESS` | `'agentic_output_process'` | `/output.md` 写入/编辑或回合结束输出校验时 | 正文格式化/清洗、语法检查、要求模型修正或触发重生成 |

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
| `source` | `PromptTransformSource` | `'prompt_block'` \| `'system_rule'` \| `'dynamic_reminder'` \| `'user_input'` \| `'chat_message'` \| `'trigger_prompt'` \| `'vfs_read'` \| `'lore_radar'` \| `'lore_outlet'` \| `'lore_precollect'` |
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
| `editable` | `boolean?` | `vfs_read` / `lore_radar` 专属：`read_file` 目标路径允许当前 Agent `edit_file` 时为 `true`。**重要约定**：若你的扩展会转换自定义语法且想兼容模型 `edit_file`，看到 `editable === true` 时请跳过展开或保留原文，避免搜索片段失配 |
| `writable` | `boolean?` | 当前路径是否允许写入 |
| `path` / `mount` | `string?` | VFS 文件路径与挂载点（`vfs_read` / `lore_radar` 时提供） |
| `blockId` / `blockName` / `placement` | `string?` | 预设 `PromptBlock` 元数据 |
| `lore` | `{ world, uid, comment, overridden }?` | 世界书条目元数据 |
| `vars` | `Readonly<Record<string, unknown>>?` | 当前可用变量只读快照 |

### 缓存控制（KV Cache 友好）
- **默认可缓存**：若脚本改写结果对固定前置输入确定（或仅改静态内容），无需额外操作；ST-Agentic 会冻结 Layer 0 / 静态块，保持前缀 KV Cache 稳定。
- **标记为不可缓存（仅重算该块/该条目）**：如果你的脚本支持**依赖运行时变量的动态分支**，调用：
  ```js
  payload.cache.disable('depends on runtime hp', 'my-ext');
  ```
  ST-Agentic 会仅对该 `PromptBlock` 或该 `system_rule` 在后续回合/轮次中**选择性重算**，不会破坏其他静态缓存块。
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

## 5. `JS-Slash-Runner` 实战模板（可直接复制）

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
