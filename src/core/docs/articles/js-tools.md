# 自定义工具开发指南（JS Tool & Slash 桥接）

ST-Agentic 支持两种自定义工具，编译后可分配给主智能体、触发器智能体或子智能体使用，也可在面板「工具与脚本」做 Dry-run 模拟测试。

---

## 1. JS Tool（`defineTool`）写法

### 方式一：预设 `customTools`（`kind: 'js'`）
使用 `export default defineTool(...)` 导出单个工具，或导出数组 `export default [defineTool(...), defineTool(...)]` 一次注册多个工具：

```js
export default defineTool({
  name: 'roll_skill_check',
  description: '基于当前角色属性执行技能检定并记录结果',
  parameters: z.object({
    stat: z.enum(['str', 'dex', 'int']).describe('检定属性'),
    dc: z.number().int().min(1).max(30).describe('难度等级'),
  }),
  // strict: true, // 可选：启用严格 schema 标志
  // timeoutMs: 150000, // 可选：覆盖默认 30s 超时（毫秒，上限 600000）
  async execute(args, ctx) {
    if (ctx.signal.aborted) {
      throw new Error('Aborted');
    }
    const base = Number((await ctx.vars.get(`stats.${args.stat}`)) ?? 10);
    const roll = Math.floor(Math.random() * 20) + 1;
    const mod = Math.floor((base - 10) / 2);
    const total = roll + mod;
    return {
      ok: true,
      stat: args.stat,
      roll,
      mod,
      total,
      success: total >= args.dc,
      target: ctx.target,
    };
  },
});
```

### 方式二：世界书 `@@tool` 条目
```markdown
@@tool web_lookup allowNetwork=false
```js
export default defineTool({
  name: 'web_lookup',
  description: '读取内置词典文件',
  parameters: z.object({ key: z.string() }),
  async execute(args, ctx) {
    return await ctx.fs.search(args.key, { pathPrefix: '/lorebooks', limit: 5 });
  },
});
```
```
- `allowNetwork` 默认 `true`，设为 `false` 会拦截沙箱内的 `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `Worker` 等网络 API。
- 可选 `timeoutMs=<毫秒>`（如 `@@tool comfyui_generate allowNetwork=true timeoutMs=150000`）或在 `defineTool({ ..., timeoutMs })` 中指定单次执行超时时间；默认 `30000` ms，上限 `600000` ms。
- 代码允许使用 ```` ```js ```` 包裹，也支持 `export const helper = ...` 与顶层 `export default`。

---

## 2. `ctx`（`ToolExecutionContext`）全量 API 速查

| 命名空间 / 属性 | 方法与签名 | 说明 |
| :--- | :--- | :--- |
| **`ctx.fs`** | `read(path)` | 读取 VFS 文件内容 |
| | `write(path, content)` | 写入文件（受 `permissions.write` 与挂载只读限制） |
| | `append?.(path, content)` | 追加文本 |
| | `edit(path, oldText, newText)` | 原地局部替换，返回 `{ ok, path, message }` |
| | `list(dirPath?)` | 列目录，返回 `VfsEntryStat[]` |
| | `search(query, { pathPrefix?, limit? })` | MiniSearch 检索，返回 `VfsSearchHit[]` |
| | `glob(pattern)` | Glob 路径匹配，返回 `string[]` |
| **`ctx.vars`** | `get(path?, { scope? })` | 读变量；`scope`: `'message'`（默认）\| `'chat'` \| `'global'` |
| | `set(path, value, { scope? })` | 设置指定路径变量 |
| | `patch(ops, { scope? })` | 传入对象（Merge Patch）或 RFC 6902 操作数组（JSON Patch） |
| **`ctx.message`** | `attachMedia(media)` | 挂载媒体附件到当前锚定消息 |
| | `appendView(text)` | 追加文本到 `/output.md` 展示视图 |
| | `replaceView(text)` | 替换 `/output.md` 展示视图内容 |
| **`ctx.st`** | `slash(cmd)` | 执行 SillyTavern Slash 命令，返回 `Promise<string>` |
| | `emit(event, data?)` | 发送宿主事件 |
| | `getActiveInfo()` | 获取当前角色/人设/聊天 ID 等宿主上下文 (`HostIdentity`) |
| **`ctx.sideGen`** | 可选对象 | 线外生成与 `/side/*` 线索操作 API（见 `ToolSideGenApi`） |
| **`ctx.target`** | `{ messageId, swipeId }` | 当前因果分支锚点（只读） |
| **`ctx.signal`** | `AbortSignal` | Swipe/取消信号；发起 `fetch` 务必传入 `signal: ctx.signal` |
| **`ctx.permissions`** | `{ read: string[], write: string[] }` | 当前运行者的读写权限规则 |

> **返回值**：`execute` 可返回字符串或任意可 JSON 序列化对象，框架会自动序列化后喂给模型。

---

## 3. Slash 桥接工具（`kind: 'slash_bridge'`）

无需写 JS 代码，直接把带参数的 SillyTavern Slash 命令暴露成 Agent 工具：

```json
{
  "id": "play_bgm",
  "name": "play_bgm",
  "kind": "slash_bridge",
  "description": "切换背景音乐曲目",
  "enabled": true,
  "commandTemplate": "/audioselect type=bgm \"{{track}}\" | /audioplay type=bgm",
  "params": [
    {
      "name": "track",
      "type": "enum",
      "description": "曲目名称",
      "required": true,
      "enumValues": ["tavern", "battle", "rain"]
    }
  ]
}
```

### 字段与安全机制
- `params[].type` 支持 `'string' | 'number' | 'boolean' | 'enum'`；可配置 `required`（默认必填）、`defaultValue`、`enumValues`。
- `commandTemplate` 中使用 `{{paramName}}` 插值。
- 内置防注入转义：自动剥离 `\0` 与换行，对引号内插值转义引号和反斜杠，把 `|` 转为 `\|`、把 `{{` / `}}` 拆开防宏注入，再通过 `ctx.st.slash(command)` 执行。
- `allowedAgents`：可选字符串数组，限制仅哪些智能体 ID 可调用该工具（省略则按各智能体的 `enabledTools` 控制）。
