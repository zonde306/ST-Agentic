# `@@script`、预设消息预/后处理与事件脚本指南

ST-Agentic 的脚本均在隔离 JS 沙箱中执行，**脚本本身不消耗任何 LLM Token**（如需按条件唤醒 LLM，可在脚本内显式调用 `ctx.agent.run(...)`、`ctx.agent.runTrigger(...)` 或 `ctx.sideGen.*`）。适用于：
- 确定性数值结算、条件文本注入与状态迁移（`@@script` / 预设脚本触发器）
- **预设消息预处理（发给 LLM 前）**：临时改写待发消息、回退工具轮或调整请求 `body`（**绝不修改聊天原文与冻结历史**）
- **预设消息后处理（收到 LLM 返回时）**：就地清洗 `content`/`reasoningContent`/`toolCalls`，或触发 `retry` / `requestFix`
- **事件驱动自动化（`on=<event>`）**：响应 `generation_error` 临时回退绕错、监听 `turn_interrupted` / `message_swiped` 等并联动启动 Agent

---

## 1. 三种定义方式

### 方式一：世界书条目（`@@script`，推荐用于随卡/随世界书分发）
在世界书条目开头写 `@@script`（支持 ```` ```js ```` 代码块包裹，也可直接裸写 JS）：

```markdown
@@script phase=after order=1 barrier=turn
```js
const vars = (await ctx.vars.get()) || {};
const turn = Number(vars.turnCount ?? 0) + 1;
await ctx.vars.patch({ turnCount: turn });
return { turnCount: turn };
```
```

也支持通过 `on=<event>` 声明为事件驱动脚本（详见第 5 节与 `/docs/triggers.md`）：
```markdown
@@script on=generation_error,turn_interrupted order=1
```js
// 仅在对应事件发生时触发，不再按每轮 phase 重复执行
```
```

### 方式二：预设触发器（`TriggerRule`，`kind: 'script'`）
通过控制台「管线触发器」或 `agentic_preset_component_upsert({ kind: 'trigger', ... })` 写入（支持可选 `events?: TriggerEventType[]`）：
```json
{
  "id": "tick_turn_counter",
  "label": "回合计数脚本",
  "source": "preset",
  "phase": "after_turn",
  "order": 1,
  "barrier": "turn",
  "agentProfileId": "script",
  "kind": "script",
  "condition": { "type": "always" },
  "instructionTemplate": "",
  "scriptCode": "const vars = (await ctx.vars.get()) || {};\nawait ctx.vars.patch({ turnCount: Number(vars.turnCount ?? 0) + 1 });",
  "enabled": true
}
```

### 方式三：预设级「消息预处理 / 消息后处理」脚本（`preprocessScript` / `postprocessScript`）
- 控制台入口：**提示词编排（Prompts）→ 顶部「消息预处理」/「消息后处理」弹窗**（可配置 `enabled`、可选触发场景 `triggers` 与代码）。
- 助手 `full` 模式读写入口：`agentic_config_read({ section: 'prompt_scripts' })`、`agentic_preset_component_upsert({ kind: 'prompt_script', item: { id: 'preprocess' | 'postprocess', enabled: true, code: '...' } })`（详见 `/docs/agentic-config.md`）。

---

## 2. 沙箱运行环境与安全限制

1. **顶层 `async` 函数体**：脚本被包装在异步函数中执行，可直接顶层使用 `await` 与 `return`。
2. **注入的全局对象**：
   - `ctx`：`ToolExecutionContext`，同时按同名顶层变量暴露：`fs`、`vars`、`message`、`st`、`sideGen`、`agent`、`messages`、`event`、`control`、`body`、`output`、`target`、`signal`（其中 `messages`、`event`、`control`、`body`、`output` 按当前脚本触发场景按需注入；基础能力 `fs`/`vars`/`message`/`st` 完整签名见 `/docs/js-tools.md`，SideGen 详见 `/docs/sidegen.md`）。
   - `z`：Zod v4，可用于校验数据结构。
   - `_`：冻结的安全版 Lodash（已移除 `template`、`runInContext`、`noConflict`、`mixin`、`VERSION`）。
   - `defineTool`：工具定义辅助函数。
3. **被禁止或受控的全局对象**：
   - 永久拦截宿主窗口逃逸：`parent`、`top`、`frameElement`、`opener`、`open`（以及 `navigator.sendBeacon` / `share` / `clipboard`）。
   - `@@script` 默认允许网络请求（`allowNetwork: true`）；如果把脚本放在 `js_predicate` 触发条件里，则强制 `allowNetwork: false` 禁止联网。
   - `ctx.body` 与 `ctx.output` 经过隔离桥接，仅在脚本正常结束（未抛错、未中止）时原子回写，抛错不会产生半脏写；`ctx.event` 为深度冻结的只读快照。
4. **中断与超时**：
   - 用户 Swipe / 重新生成 / 取消时会立刻触发 `ctx.signal`；执行网络请求、耗时循环或 `ctx.agent.run` 时请检查 `ctx.signal.aborted` 或透传 `signal: ctx.signal`。

---

## 3. 预设「消息预处理（发给 LLM 前）」脚本（`preprocessScript`）

> **核心不变式（严格临时，不污历史）**：`preprocessScript`（以及 `@@script on=prompt_preprocess`）在每轮调用 LLM 发送请求**前**执行，**仅作用于本次即将发出的临时 `LLMRequest`**。无论你如何在脚本内增删、替换或回退 `ctx.messages`，都**绝不会修改 SillyTavern 聊天原文，也不会修改或污染 `TrajectoryStore` 中冻结的 Layer 0 / Layer 1 持久历史与断点**。

### 可用 `ctx` API

| 属性 / 方法 | 签名与说明 |
| :--- | :--- |
| **`ctx.messages.list()`** | `() => CanonicalMessage[]` — 返回当前待发临时消息数组的深拷贝快照 |
| **`ctx.messages.set(nextMessages)`** | `(nextMessages: CanonicalMessage[]) => void` — 用新数组整体替换本次临时消息 |
| **`ctx.messages.rollbackToolRounds(count = 1)`** | `(count?: number) => number` — 在当前轮 `turnStart` 之后按完整 `assistant(toolCalls) + role:'tool'` 成对回退最近 `N` 轮工具调用，返回实际回退轮数 |
| **`ctx.messages.dropHistoryTurns(count = 1, opts?)`** | `(count?: number, opts?: { from?: 'newest' \| 'oldest' }) => number` — 在 Layer 1 区间 `[layer0End, layer1End)` 内按完整对话轮次安全摘除 `N` 轮（自动保留开头的压缩摘要 `system` 消息且绝不拆散工具配对；默认 `from: 'oldest'`），返回实际摘除轮数 |
| **`ctx.messages.replaceContent(selector, replacer)`** | `(selector: number \| ((msg, idx) => boolean), replacer: string \| ((content, msg, idx) => string)) => number` — 按索引或条件替换消息文本；`replacer` 回调返回 `undefined`/非字符串时跳过该条不修改；多模态消息保留非文本 part |
| **`ctx.messages.appendHint(content, role?)`** | `(content: string, role?: 'user' \| 'system') => void` — 在临时消息末尾追加一条提示（默认 `role: 'user'`） |
| **`ctx.messages.toMessages()`** | `() => CanonicalMessage[]` — 返回经 `sanitizeToolCallPairs` 配对清洗后的最终消息数组（框架发模前也会自动执行配对清洗，防止孤立 `tool_call` / `tool` 引发 400） |
| **`ctx.body`** | `Record<string, unknown>` — 可写对象，直接修改/增删本次请求的临时参数（如 `temperature`、`maxTokens`、`topP` 等） |
| **`ctx.event.data.layers`** | 只读分层边界索引 `{ layer0End, layer1End, turnStart, floatingTailStart }`，便于区分静态前缀、历史轨迹、当前轮与尾部浮动区 |
| **`ctx.vars` / `ctx.st` / `ctx.fs`** | 可读取分支/聊天变量、宿主活跃信息或 VFS 参考文件，决定本次临时调参或提示词微调 |

### 实战范例：按变量动态微调采样参数并临时注入提醒
```js
// 预设「消息预处理脚本」（建议设置 triggers: ['main'] 仅对主生成生效）
const vars = (await ctx.vars.get()) ?? {};
const layers = ctx.event?.data?.layers ?? {};

// 1. 战斗或高紧张度时临时降低温度，提高输出稳定性（仅本次请求生效）
if (Number(vars.tension ?? 0) >= 80) {
  ctx.body.temperature = 0.45;
  ctx.messages.appendHint('[临时提醒] 当前处于高危冲突阶段，请保持动作描写紧凑、因果严格。', 'system');
}

// 2. 仅针对当前轮之后的 user 消息做临时脱敏/清洗（不动 Layer 0 / Layer 1 冻结历史）
const turnStart = Number(layers.turnStart ?? 0);
ctx.messages.replaceContent(
  (msg, idx) => idx >= turnStart && msg.role === 'user',
  (text) => (text.includes('[OOC]') ? text.replaceAll('[OOC]', '(场外备注)') : undefined),
);
```

---

## 4. 预设「消息后处理（收到 LLM 返回时）」脚本（`postprocessScript`）

`postprocessScript`（以及 `@@script on=output_postprocess`）在收到单轮 LLM 响应后、进入后续内容解析与工具分派之前立即执行，可原地改写模型输出或要求模型修正/重生成。

### 可用 `ctx` API

| 属性 / 方法 | 说明 |
| :--- | :--- |
| **`ctx.output.text`** | 可写 `string`，与 `ctx.output.content` 双向同步的主文本字段 |
| **`ctx.output.content`** | 可写 `string`，本轮 LLM 返回的正文文本；修改后会直接生效于后续展示与解析 |
| **`ctx.output.reasoningContent`** | 可写 `string \| undefined`，本轮模型思考/思维链文本（可清洗敏感词、精简或置空） |
| **`ctx.output.toolCalls`** | 可写 `CanonicalToolCall[] \| undefined`，本轮模型发出的工具调用数组（每项含 `{ id, name, arguments }`，可校验、过滤或规范化） |
| **`ctx.output.originalText` / `ctx.output.round`** | 只读元数据：原始未改写文本与当前轮次（另按场景提供只读 `stage` / `operation` / `filePath` / `fixAttempt` / `maxFixAttempts`） |
| **`ctx.control.retry(reason?)`** | 触发本轮重新生成（严格受 API 连接的 `roundMaxRetries` 上限保护，超次自动停止重试） |
| **`ctx.control.requestFix(message, options?)`** | 将修正反馈注入当前轮上下文，引导模型在下一轮自我修正（受最大修正次数上限保护；写 `/output.md` 场景支持 `{ rejectWrite: true }` 阻断错误草稿写入） |
| **返回值快捷写法** | 除原地修改 `ctx.output` 外，脚本也可直接 `return '新文本'` 或 `return { content?, text?, reasoningContent?, toolCalls? }` 覆盖对应字段 |

### 实战范例：清洗模型杂项标记 + 缺标签时要求自愈或重试
```js
// 预设「消息后处理脚本」
if (!ctx.output) return;

// 1. 剥离模型偶发泄露的内部草稿标签（直接原地改写 content/text）
const raw = ctx.output.content ?? ctx.output.text ?? '';
const cleaned = raw.replace(/<scratchpad>[\s\S]*?<\/scratchpad>\s*/gi, '').trim();
if (cleaned !== raw) {
  ctx.output.content = cleaned;
  ctx.output.text = cleaned;
}

// 2. 清理过长的思维链（可选）
if (typeof ctx.output.reasoningContent === 'string' && ctx.output.reasoningContent.length > 8000) {
  ctx.output.reasoningContent = ctx.output.reasoningContent.slice(0, 8000) + '\n...[truncated]';
}

// 3. 若本轮无工具调用且包含未闭合状态标签，优先让模型自愈修正；遇到禁用占位符则触发重摇
const hasToolCalls = Array.isArray(ctx.output.toolCalls) && ctx.output.toolCalls.length > 0;
if (!hasToolCalls) {
  if (cleaned.includes('<status>') && !cleaned.includes('</status>')) {
    ctx.control?.requestFix('检测到未闭合的 <status> 标签，请补全 </status> 后再完成输出。');
  } else if (cleaned.includes('{{FORBIDDEN_STUB}}')) {
    ctx.control?.retry('输出包含禁用占位符 {{FORBIDDEN_STUB}}');
  }
}
```

---

## 5. 事件触发脚本（`@@script on=<event>`）与脚本内启动 Agent（`ctx.agent`）

### 5.1 事件绑定语法
- 世界书：`@@script on=generation_error` 或逗号绑定多个事件 `@@script on=generation_error,turn_interrupted`（同样适用于 `@@trigger on=<event>`）。
- 预设：`TriggerRule` 中配置 `events: ['generation_error']`（支持的全部 14 种 `TriggerEventType` 见 `/docs/triggers.md`）。
- 触发时，`ctx.event`（深度冻结的 `ToolEventPayload`）包含：`type`、`timestamp`、`target`、`messageId`、`swipeId`、`phase`、`runId`、`agentId`、`triggerId`、`round`、`attempt`、`maxAttempts`、`error`、`errorCode`、`statusCode`、`reason`、`output`、`data`。

### 5.2 `ctx.agent` API（在任意脚本或自定义工具中按需启动 Agent）
`ctx.agent` 由沙箱通过隔离代理暴露，自动转发并联动 `ctx.signal`（未配置/已销毁/参数非法时抛出 `SandboxAgentError`）：

- **`await ctx.agent.run(opts)`**（`ToolAgentRunOptions`）：
  | 字段 | 类型 | 说明 |
  | :--- | :--- | :--- |
  | `agentId?` | `string` | 目标智能体配置 ID（来自当前预设 `agents`，默认主智能体或调用方智能体） |
  | `prompt?` | `string` | 本次运行的任务指令或用户输入 |
  | `systemPrompt?` | `string` | 可选额外/覆盖系统指令 |
  | `phase?` | `PipelinePhase` | 可选管线阶段覆盖（`'before_turn' \| 'main_turn' \| 'after_turn' \| 'maintenance'`） |
  | `target?` | `MessageTarget` | 可选因果分支锚点（默认当前 `ctx.target`） |
  | `connectionId?` | `string` | 可选 API 连接 ID 覆盖 |
  | `enabledTools?` | `string[]` | 可选启用工具白名单覆盖 |
  | `extraTools?` | `string[]` | 可选在 profile 原有工具基础上追加的工具名 |
  | `permissions?` | `{ read: string[]; write: string[] }` | 可选 VFS 读写权限覆盖 |
  | `maxToolRounds?` | `number` | 可选最大工具调用轮数（`0` = 不限） |
  | `vars?` / `macroOverrides?` | `Record<string, ...>` | 可选变量/宏覆盖 |
  | `staged?` | `boolean` | 写入是否进入分支暂存存储 |
  | `stream?` / `signal?` | `boolean` / `AbortSignal` | 是否流式输出；自定义中止信号（自动与 `ctx.signal` 联动） |

  返回 `ToolAgentRunResult`：`{ runId?, agentId, content, reasoningContent?, ok, skipped?, error?, rounds?, usage?, toolSteps? }`。

- **`await ctx.agent.runTrigger(ruleId, opts?)`**：
  按触发器规则 ID 直接执行某条已注册规则；`opts` 可选 `{ target?, event?, signal? }`，同样返回 `Promise<ToolAgentRunResult>`。

### 5.3 完整实战范例：`on=generation_error` 临时消息回退绕错 + `ctx.control.retry` / `abort`
在 `on=generation_error` 事件中，`ctx.control` 遵循 `ToolErrorRecoveryControl`：
- `ctx.control.retry(reason?, { delayMs?, rollbackToolRounds?, dropHistoryTurns? })`：采用你通过 `ctx.messages.*` 临时修改后的消息（或附加退避延迟）发起重试；**绝不修改聊天原文与 `TrajectoryStore` Layer 0/1 冻结历史**。
- `ctx.control.abort(reason?)`：立即放弃重试并干净中止本轮。

```markdown
@@script on=generation_error order=1
```js
const ev = ctx.event;
if (!ev || !ctx.messages || !ctx.control) return;

const msg = String(ev.error ?? '');
const status = Number(ev.statusCode ?? 0);

// 1. 鉴权/额度等致命错误直接中止，避免无意义重试
if (status === 401 || status === 402 || status === 403) {
  ctx.control.abort(`上游鉴权或额度错误 (HTTP ${status})，停止重试`);
  return;
}

// 2. 上游 400 / 工具协议异常：先临时回退最近 1 轮工具调用并提示模型换用安全策略
if (status === 400 || /tool_call|invalid_request/i.test(msg)) {
  const rolled = ctx.messages.rollbackToolRounds(1);
  ctx.messages.appendHint(
    `[错误恢复] 上一步请求触发 HTTP ${status || '400'}，已临时回退 ${rolled} 轮工具调用。请直接精简参数或换用其他方式继续。`,
    'user',
  );
  ctx.control.retry('回退异常工具轮后重试', { delayMs: 500, rollbackToolRounds: rolled });
  return;
}

// 3. 上下文超限或偶发内容审查：仅在本次临时请求中裁掉最旧 2 轮 Layer 1 历史（不动原聊天记录）
if (status === 413 || /context_length|maximum context|content_filter/i.test(msg)) {
  const dropped = ctx.messages.dropHistoryTurns(2, { from: 'oldest' });
  if (dropped > 0) {
    ctx.messages.appendHint('[错误恢复] 已临时精简早期上下文，请继续完成当前回复。', 'system');
    ctx.control.retry(`临时裁减 ${dropped} 轮历史后重试`, { delayMs: 800, dropHistoryTurns: dropped });
    return;
  }
}

// 4. 限流 / 5xx 临时故障：短退避后重试
if (status === 429 || status >= 500) {
  ctx.control.retry(`上游临时错误 HTTP ${status}，退避重试`, { delayMs: 1500 });
}
```
```

### 5.4 完整实战范例：事件脚本按条件唤起指定 Agent 或触发器
```markdown
@@script on=turn_completed order=10
```js
const vars = (await ctx.vars.get()) ?? {};

// 仅当警戒度跨过阈值时，才消耗 Token 启动侦查子智能体并更新线索
if (Number(vars.alertLevel ?? 0) >= 5 && !vars.alertBriefGenerated) {
  const res = await ctx.agent.run({
    agentId: 'chronicler',
    prompt: '警戒度已达 5 级，请结合最近剧情整理敌人动向并写入 /workspace/shared/threat-brief.md。',
    enabledTools: ['read_file', 'write_file', 'read_variables'],
    permissions: {
      read: ['/**'],
      write: ['/workspace/shared/**'],
    },
    staged: false,
  });
  if (res.ok) {
    await ctx.vars.patch({ alertBriefGenerated: true });
  }
}

// 也可直接按 ruleId 复用已配置好的预设/世界书触发器
if (vars.needManualRecap) {
  await ctx.agent.runTrigger('after_arc_recap');
  await ctx.vars.patch({ needManualRecap: false });
}
```
```

---

## 6. 传统管线阶段脚本模板

### 模板 1：三层变量联动结算（读/写 `message` 与 `chat` 作用域）
```js
const msgVars = (await ctx.vars.get()) ?? {};
const hp = Math.max(0, Number(msgVars.hp ?? 100) - 5);
await ctx.vars.patch({ hp });

// 读取并累加当前聊天的累计回合数（chat_metadata.variables）
const total = Number((await ctx.vars.get('totalTurns', { scope: 'chat' })) ?? 0) + 1;
await ctx.vars.set('totalTurns', total, { scope: 'chat' });
```

### 模板 2：前置阶段准备输出缓冲或读取世界书
```js
// @@script phase=before order=2 barrier=turn
const vars = (await ctx.vars.get()) ?? {};
if (vars.alertMode) {
  await ctx.fs.write('/workspace/shared/runtime-alert.md', '当前处于警戒状态，NPC 戒备度 +2。');
}
```

### 模板 3：后置向当前回复末尾追加结构化标签（配合状态栏正则）
```js
// @@script phase=after order=10 barrier=turn
const hp = await ctx.vars.get('hp');
if (hp !== undefined) {
  await ctx.message.appendView(`\n\n<status-panel data-hp="${Number(hp)}" />`);
}
```
