# 状态栏与自定义 UI 渲染指南（`JS-Slash-Runner` & `ST-Prompt-Template`）

在酒馆中实现角色状态栏、属性面板或交互式自定义 UI，推荐让 AI **只维护状态变量 / 极简占位标签**（避免每轮生成数百行 HTML 浪费 Token），再通过以下两条标准路线之一在前端渲染成独立 `<iframe>`。

---

## 1. 两条标准路线对比

| 维度 | 路线 A：展示正则 + `JS-Slash-Runner`（推荐通用） | 路线 B：`ST-Prompt-Template` `@@render_after` |
| :--- | :--- | :--- |
| **前置依赖** | 只需安装 `JS-Slash-Runner`（酒馆助手） | 需安装 `ST-Prompt-Template`（若要交互变量 API 还需同时装 `JS-Slash-Runner`） |
| **正文中是否需要占位符** | 通常由 AI 输出轻量标签（如 `<status/>`）或由后置脚本追加 | **不需要**正文占位符，世界书条目自动挂到每层消息末尾 |
| **数据读写方式** | iframe 内直接调 `getVariables` / `insertOrAssignVariables` 等 | 纯展示可直接 `<%- variables.xxx %>`；加 `@@message_formatting` 后与路线 A 完全一致 |
| **修改后生效** | 写正则后调 `chat_reload_messages` 立即重渲染 | 保存世界书条目并刷新消息显示即可 |

---

## 2. 路线 A：正则替换 + `JS-Slash-Runner` 渲染

### 触发前端渲染的硬性条件
`JS-Slash-Runner`（`isFrontend()`）只会把满足下列条件之一的内容渲染成前端 `<iframe>`：
1. Markdown 代码块（通常用 ```` ```html ... ``` ````）的文本中**必须包含 `html>`、`<head>` 或 `<body` 任意一个字符串**；否则只会当普通代码框展示！
2. 或者直接包含带 `TH-render` 类名的容器（`div.TH-render`）。

### 配置展示正则的正确参数
- 通过 `regex_upsert_scoped`（`author` 模式，绑定到角色）或 `regex_admin_global_upsert`（`full + stAdmin` 模式，全局生效）写入正则规则：
  - `markdownOnly: true`（**关键**：只在页面显示时替换，**不污染**发送给模型的提示词和原始聊天记录）
  - `promptOnly: false`
  - `placement: [2]`（作用于 AI 输出楼层）
  - `runOnEdit: true`
- 如果你走 ST-Agentic 自身的三阶段正则，也可以用 `agentic_preset_component_upsert` 写 `kind: 'regex_rule'`、`stage: 'display'`（同样只改展示视图，不污染原文）。
- 写入后调用 **`chat_reload_messages`** 立刻刷新前台楼层渲染。

---

## 3. 路线 B：`ST-Prompt-Template` 世界书直出状态栏

### B1. 纯 `ST-Prompt-Template`（折叠/静态状态栏）
```ejs
@@render_after
@@iframe 状态栏（点击展开）
@@if !is_user && !is_system
<html>
<head></head>
<body>
  <div>好感度：<%- variables.favorability ?? 0 %> / 100</div>
</body>
</html>
```

### B2. 交给 `JS-Slash-Runner` 渲染（获得完整交互 API）
```html
@@render_after
@@message_formatting
@@if !is_user && !is_system
```html
<!DOCTYPE html>
<html>
<head></head>
<body>
  <div id="app">加载中...</div>
  <script>
    const msgId = getCurrentMessageId();
    const vars = getVariables({ type: 'message', message_id: msgId });
    document.getElementById('app').textContent = 'HP: ' + (vars.hp ?? 100);
  </script>
</body>
</html>
```
```

---

## 4. `JS-Slash-Runner` iframe 内核心 API 速查

> **头号防坑**：楼层状态栏读取当前楼层变量时，**必须传 `message_id: getCurrentMessageId()`**！如果省略或写 `'latest'`，用户翻看历史楼层时所有状态栏都会错误地显示最后一楼的数据。

### 楼层与环境
- `getCurrentMessageId(): number` — 获取当前 iframe 所在消息楼层 ID（仅楼层消息 iframe 可用）。
- `getIframeName(): string` — 获取当前 iframe 名称（`TH-message--楼层--序号` 或 `TH-script--脚本名--id`）。
- `reloadIframe(): void` — 重载当前 iframe。
- 全局库：默认注入 `_`（Lodash）、`$`（jQuery）、`toastr`、`SillyTavern`。

### 变量读写（与 ST-Agentic 三层变量直接互通）
```ts
// 1. 获取指定作用域变量表
getVariables({ type: 'message', message_id: getCurrentMessageId() }) // ↔ /state/variables.json
getVariables({ type: 'chat' })   // ↔ /state/chat_variables.json (chat_metadata.variables)
getVariables({ type: 'global' }) // ↔ /state/global_variables.json (extension_settings.variables.global)
// 其他可用 type: 'preset' | 'character' | 'script' | { type: 'extension', extension_id }

// 2. 获取按 全局→角色卡→聊天→0..当前楼层 自动合并后的完整变量树
getAllVariables(): Record<string, any>

// 3. 写入 / 更新 / 删除变量（按钮交互后回写）
insertOrAssignVariables(patchObj, option) // 不存在则新增，存在则覆盖
insertVariables(patchObj, option)         // 仅在不存在时写入
updateVariablesWith((vars) => { ...; return vars; }, option)
replaceVariables(newVarsObj, option)
deleteVariable('a.b', option)
```

### 事件与 Slash 命令
- `await triggerSlash('/echo severity=success 已保存')` — 执行 SillyTavern Slash 命令（错误会抛异常）。
- `eventOn(tavern_events.MESSAGE_UPDATED, (msgId) => ...)` / `eventOnce(...)` / `await eventEmit(eventName, ...data)` — 监听与派发酒馆事件或自定义事件（iframe 关闭时自动卸载监听）。

### 常驻全局/角色脚本（非楼层内嵌 UI）
- 如果需要监听全局事件、做后台 HUD 或跨楼层脚本库，使用 `tavern_helper_scripts_read` / `tavern_helper_scripts_upsert`（`full + stAdmin` 模式），改完后可调用 `st_sync_runtime` 立即同步到运行中的 `TavernHelper`。
- 若要在 `JS-Slash-Runner` 脚本中监听 ST-Agentic 的提示词变换或输出校验事件（`agentic_prompt_transform`、`agentic_output_process`），请先阅读 **`/docs/event-hooks.md`**。

---

## 5. 最小可复制模板（路线 A：展示正则 + 交互按钮）

### 1) 正则规则（通过 `regex_upsert_scoped` 写入）
- `scriptName`: `"渲染状态栏占位符"`
- `findRegex`: `/<status\s*\/?>/g`
- `replaceString`（注意包含 `<!DOCTYPE html><html><head>...</head><body>...</body></html>`）：

````html
```html
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; font-family: sans-serif; font-size: 13px; color: #e5e7eb; background: #18181b; }
  .bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border: 1px solid #27272a; border-radius: 8px; }
  button { cursor: pointer; padding: 4px 10px; border-radius: 6px; border: 1px solid #3f3f46; background: #27272a; color: #fff; }
</style>
</head>
<body>
  <div class="bar">
    <span id="info">读取中...</span>
    <button id="heal" type="button">休息 (+10 HP)</button>
  </div>
  <script>
    const msgId = getCurrentMessageId();
    const opt = { type: 'message', message_id: msgId };
    function render() {
      const v = getVariables(opt) || {};
      const hp = Number(v.hp ?? 100);
      document.getElementById('info').textContent = `HP: ${hp} · 位置: ${v.location ?? '未知'}`;
    }
    document.getElementById('heal').addEventListener('click', () => {
      updateVariablesWith((v) => ({ ...v, hp: Math.min(100, Number(v.hp ?? 100) + 10) }), opt);
      render();
    });
    render();
  </script>
</body>
</html>
```
````
- `placement`: `[2]`，`markdownOnly: true`，`promptOnly: false`，`runOnEdit: true`。
