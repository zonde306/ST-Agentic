# 修改 ST-Agentic 自身配置与预设指南

在助手 `full` 模式下，可直接通过以下 5 个专用工具读写 ST-Agentic 自身设置、预设、智能体、触发器、工具、正则与 API 连接（永久写入会触发审批并支持撤销）。

---

## 1. 工具总览

| 工具名 | 用途 | 关键参数 |
| :--- | :--- | :--- |
| `agentic_config_read` | 只读检查 ST-Agentic 配置 | `section`: `'summary' \| 'settings' \| 'presets' \| 'preset' \| 'prompts' \| 'agents' \| 'triggers' \| 'tools' \| 'regex' \| 'wi_router' \| 'connections'`；可选 `presetId`、`agentId`、`itemId` |
| `agentic_settings_patch` | 修改全局设置、切换/新建/重命名/删除预设、改预设全局字段 | `runMode`、`themeMode`、`capsulePosition`、`capsulePersistMode`、`currentPresetId`、`currentConnectionId`、`storage`、`offMainline`、`createPreset`、`renamePreset`、`deletePresetId`、`presetPatch` |
| `agentic_preset_component_upsert` | 新增或按 ID/名称合并更新预设组件 | `presetId?`、`kind`、`agentId?`、`insertAt?`、`item`、`reloadMessages?` |
| `agentic_preset_component_delete` | 删除预设组件 | `presetId?`、`kind`、`id`、`agentId?`、`reloadMessages?` |
| `agentic_connection_upsert` | 新增或更新 API 连接（不传 `apiKey` 自动保留原密钥） | `id`、`name`、`providerFormat`、`baseUrl`、`apiKey`、`clearApiKey`、`model`、`contextSize`、`maxTokens`、`cachePolicy`、`systemInstructionMode`、`strictToolLoop`、`roundMaxRetries`、`setAsCurrent` |

> **最佳实践**：修改前先调 `agentic_config_read({ section: 'summary' })` 或 targeted `section + itemId` 查看现有 ID，再做局部 `upsert`（`item` 会与同 ID 现有项合并，只需传变更字段或完整新项）。

---

## 2. `agentic_preset_component_upsert` 支持的 6 种 `kind`

`kind` 取值：`'prompt_block' | 'agent' | 'trigger' | 'custom_tool' | 'regex_rule' | 'preset_file'`。

### 1) `prompt_block`（需配合 `agentId?`，默认主智能体）
```json
{
  "kind": "prompt_block",
  "agentId": "main",
  "item": {
    "id": "combat_style",
    "name": "战斗描写规范",
    "role": "system",
    "placement": "tail",
    "content": "当前 HP: {{var:hp}}",
    "enabled": true,
    "triggers": ["main"]
  }
}
```

### 2) `agent`（智能体配置）
```json
{
  "kind": "agent",
  "item": {
    "id": "chronicler",
    "name": "编年史记录员",
    "connectionId": "inherit",
    "sessionMode": "ephemeral",
    "enabledTools": ["read_file", "write_file", "read_variables"],
    "permissions": {
      "read": ["/**"],
      "write": ["/memory/**"]
    },
    "maxToolRounds": 6,
    "strictToolLoop": "inherit"
  }
}
```

### 3) `trigger`（管线触发器：`kind: 'agent' | 'script'`）
```json
{
  "kind": "trigger",
  "item": {
    "id": "after_state_sync",
    "label": "后置状态更新",
    "source": "preset",
    "phase": "after_turn",
    "order": 1,
    "barrier": "turn",
    "agentProfileId": "main",
    "kind": "agent",
    "condition": { "type": "always" },
    "instructionTemplate": "读取本轮剧情并更新 /state/variables.json。",
    "targetPath": "/state/variables.json",
    "enabled": true
  }
}
```

### 4) `custom_tool`（JS 工具或 Slash 桥接工具）
```json
{
  "kind": "custom_tool",
  "item": {
    "id": "dice_roller",
    "name": "dice_roller",
    "kind": "js",
    "description": "投掷 N 面骰子",
    "enabled": true,
    "allowNetwork": false,
    "code": "export default defineTool({ name: 'dice_roller', description: '投掷 N 面骰子', parameters: z.object({ sides: z.number().int().min(2).default(20) }), async execute(args) { return { roll: Math.floor(Math.random() * args.sides) + 1 }; } });"
  }
}
```

### 5) `regex_rule`（ST-Agentic 三阶段正则）
```json
{
  "kind": "regex_rule",
  "reloadMessages": true,
  "item": {
    "id": "hide_thinking",
    "name": "隐藏思考标签",
    "pattern": "<think>[\\s\\S]*?</think>",
    "replace": "",
    "stage": "display",
    "applyToUser": false,
    "applyToAssistant": true,
    "enabled": true
  }
}
```
- `stage` 可选：`'display'`（展示视图清洗，默认更新后触发消息刷新）| `'ingest'`（写入规范化清洗）| `'lore_read'`（读取 `/lorebooks/*` 时清洗）。

### 6) `preset_file`（挂载到 `/preset/*` 的随包只读参考文件）
```json
{
  "kind": "preset_file",
  "item": {
    "path": "style-guide.md",
    "content": "# 叙事文风规范\n保持克制与临场感。"
  }
}
```
- 删除时传 `kind: 'preset_file'` 与 `id: 'style-guide.md'`。

---

## 3. 世界书路由器覆写（`wiRouterOverrides`）

通过 `agentic_settings_patch` 的 `presetPatch.wiRouterOverrides` 修正条目的四类分流归属（键为 `world/uid` 或 `/lorebooks/...` 路径，值为分类或 `null` 清除）：
- `'system_rule'` | `'core_manifest'` | `'on_demand_archive'` | `'dynamic_or_trigger'`

---

## 4. 第三方扩展注册自定义文档 API（`globalThis.Agentic.docs`）

其他 SillyTavern 扩展可以通过 `globalThis.Agentic.docs` 将自己的使用指南/API 文档注册到只读目录 `/docs/extensions/<namespace>/...`，Agent 可通过 `read_file` / `list_dir` / `grep_search(..., { pathPrefix: '/docs' })` 读取，并自动出现在助手系统提示词索引中。

### 注册与注销方法
```ts
// 单篇或批量注册，返回幂等注销函数 unregister()
const unregister = globalThis.Agentic?.docs.register({
  namespace: 'my-ext', // 仅允许 [a-zA-Z0-9._-]
  docs: [
    {
      path: 'guide.md', // 挂载为 /docs/extensions/my-ext/guide.md（支持子目录如 api/hooks.md）
      title: 'My Extension 指南',
      summary: '说明 My Extension 的命令、事件与变量格式',
      content: '# My Extension\n...', // 也支持惰性函数 () => string
      includeInAssistantIndex: true,   // 默认 true，设为 false 仅挂 VFS 不进提示词索引
    },
  ],
});

// 其他管理方法：
globalThis.Agentic?.docs.unregister('my-ext', 'guide.md');
globalThis.Agentic?.docs.unregisterNamespace('my-ext');
globalThis.Agentic?.docs.list('my-ext'); // 省略参数返回全部内置+扩展文档
globalThis.Agentic?.docs.get('/docs/extensions/my-ext/guide.md');
```

### 处理扩展加载顺序（推荐写法）
由于 SillyTavern 第三方扩展加载顺序不固定，推荐同时兼容「已就绪」与「未就绪队列 + `agentic:ready` 事件」：
```ts
const myDocs = {
  namespace: 'my-ext',
  path: 'guide.md',
  summary: '扩展开发文档',
  content: '# ...',
};

if (globalThis.Agentic?.docs) {
  globalThis.Agentic.docs.register(myDocs);
} else {
  (globalThis.__AGENTIC_PENDING_DOCS__ ??= []).push(myDocs);
}
```
（ST-Agentic 初始化完成挂载 `globalThis.Agentic` 后会自动清空 `__AGENTIC_PENDING_DOCS__` 并派发 `CustomEvent('agentic:ready', { detail: Agentic })`。）

