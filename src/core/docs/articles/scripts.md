# `@@script` 确定性脚本编写指南

`@@script`（以及预设里 `kind: 'script'` 的触发器）在隔离 JS 沙箱中直接运行，**不消耗任何 LLM Token**，适合确定性数值结算、条件文本注入、状态迁移和输出后处理。

---

## 1. 两种定义方式

### 方式一：世界书条目（推荐）
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

### 方式二：预设触发器（`TriggerRule`）
通过 `agentic_preset_component_upsert`（`kind: 'trigger'`）写入：
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

---

## 2. 沙箱运行环境与安全限制

1. **顶层 `async` 函数体**：脚本被包装在异步函数中执行，可直接顶层使用 `await` 与 `return`。
2. **注入的全局对象**：
   - `ctx`：`ToolExecutionContext`（含 `ctx.fs`、`ctx.vars`、`ctx.message`、`ctx.st`、`ctx.sideGen`、`ctx.target`、`ctx.signal`、`ctx.permissions`，完整签名见 `/docs/js-tools.md`，SideGen 详解见 `/docs/sidegen.md`）。
   - `z`：Zod v4，可用于校验数据结构。
   - `_`：冻结的安全版 Lodash（已移除 `template`、`runInContext`、`noConflict`、`mixin`、`VERSION`）。
   - `defineTool`：工具定义辅助函数。
3. **被禁止或受控的全局对象**：
   - 永久拦截宿主窗口逃逸：`parent`、`top`、`frameElement`、`opener`、`open`（以及 `navigator.sendBeacon` / `share` / `clipboard`）。
   - `@@script` 默认允许网络请求（`allowNetwork: true`）；如果把脚本放在 `js_predicate` 触发条件里，则强制 `allowNetwork: false` 禁止联网。
4. **中断与超时**：
   - 用户 Swipe / 重新生成 / 取消时会立刻触发 `ctx.signal`；执行网络请求或耗时循环时请检查 `ctx.signal.aborted` 或透传 `signal: ctx.signal`。

---

## 3. 常用实战模板

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
