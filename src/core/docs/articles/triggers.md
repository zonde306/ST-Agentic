# 触发器（Triggers）与世界书 `@@` 装饰器指南

ST-Agentic 的自动化逻辑可以放在**预设触发器规则（`TriggerRule`）**或**世界书条目（`@@` 装饰器）**中，由四阶段管线（`PipelineOrchestrator`）按阶段、顺序和屏障策略统一调度。

---

## 1. 四阶段管线（`phase`）与屏障（`barrier`）

| `phase` | 别名（`@@` 参数） | 执行时机 | 默认 `barrier` | 典型用途 |
| :--- | :--- | :--- | :--- | :--- |
| `before_turn` | `before` | 主生成发送请求前 | `turn` | 前置状态推演、条件注入、变量初始化、输出前准备 |
| `main_turn` | `main` | 主叙事生成通道 | `turn` | 主回复流式生成（通常由 `Main Narrative` 执行） |
| `after_turn` | `after` | 主生成完成后 | `self` | 变量提取更新、剧情摘要、世界书日志追加、媒体/线索生成 |
| `maintenance` | `maintenance` | 水位线维护阶段 | `self` | 高低水位线分块压缩与冷存档维护 |

### `barrier` 并发与阻塞语义
- `turn`：**回合屏障**——必须等待该单元彻底执行完毕并提交结果后，后续阶段/主回复才继续（如 `before_turn` 变量修改、`@@variables*`）。
- `self`：**自屏障**——同一规则/分支串行，但不阻塞主聊天回复先行展示（适合 `after_turn` 后台更新）。
- `none`：**无阻塞**——后台异步触发，与主流程解耦。

### `order` 与 `groupName`（合并与隔离）
- 同一 `phase` 内按 `order` 升序执行（由 `@@trigger order=10` 或 `@@batch_order 10` 指定；均未指定时默认 `1`，不随世界书条目的插入顺序 `entry.order` 打散）。
- **默认隔离（`1 Trigger = 1 Run`）**：`@@trigger`、`@@replace*`、`@@append_output*`、`@@replace_output*` 默认各自独立运行。
- **旧版变量触发器默认自动合并**：同一 `phase`、同 `@@batch_order` 且同 `<tag>` 的旧版 `@@variables*`（如 `@@variables_json` / `yaml` / `jsonpatch` 及其 `*_before`）条目默认自动合组为同一次 Agent 调用（合并各自规则与 `@@zod_schema` / `@@json_schema`）；如需强制单独执行，可显式写 `@@group none` 或 `@@group isolate`（或设置不同的 `<tag>` / `@@batch_order`）。
- **显式同组打包（含跨类型合组）**：当 `kind === 'agent'`、显式设置了相同的 `groupName`（或 `@@group <name>`），且 `phase`、`order`、`agentProfileId` 一致时，多条触发器（包括旧版 `@@replace*`、`@@*_output*`、`@@variables*` 或混合类型）会合并为同一次 LLM 调用；合并后取最严格的 `barrier`，并自动合并工具与读写权限。`@@script` 与 `@@*_ejs*` 始终独立执行，不参与合并。

---

## 2. 触发条件（`condition`）

| `condition.type` | 对应 `@@trigger` / `@@script` 参数 | 说明 |
| :--- | :--- | :--- |
| `always` | 默认（无条件参数且条目常驻/无关键词） | 每轮均触发 |
| `interval` | `interval=3` | 每 N 轮触发一次（`interval >= 1`） |
| `regex` | `regex="pattern"` | 最近用户/模型文本匹配正则时触发 |
| `keyword` | `keys="词1,词2"` 或世界书条目自身 `keys` | 命中关键词时触发（非 `constant` 条目自动继承其 `keys`） |
| `js_predicate` | 仅预设 `TriggerRule`：`predicateCode` | 在沙箱中执行 JS 表达式（禁网），返回真值时触发 |

---

## 3. 世界书 `@@` 装饰器语法规则

1. **位置要求**：必须写在世界书条目**开头连续行**，每行一个 `@@...`，遇到非 `@@` 行即结束装饰器区。
2. **转义**：行首写 `@@@` 表示字面量 `@@`，不作为装饰器解析（如 `@@@replace`）。
3. **参数格式**：`@@name arg0 arg1 key1=val1 key2="带空格的值"`，支持单/双引号与反斜杠转义；`@@json_schema` 与 `@@zod_schema` 会保留原样载荷不剥引号。
4. **注意**：带 `@@trigger` / `@@script` / `@@tool` / `@@agent` / `@@skill` / `@@replace*` / `@@variables*` / `@@*_output*` / `@@*_ejs*` 的控制类条目会被路由为扩展动作，**不会**作为普通设定文本放进 `/lorebooks/*`。

---

## 4. ST-Agentic 全部 `@@` 装饰器速查

### 核心结构化装饰器（`AGENTIC_DECORATORS`）

| 装饰器 | 常用参数 | 说明 |
| :--- | :--- | :--- |
| `@@trigger` | `[tag] phase=before\|after\|main\|maintenance order=1 barrier=turn\|self\|none profile=<agentId> group=<name> target=/state/variables.json\|/output.md tools="a,b" interval=3 regex="..." keys="a,b"` | 声明式触发器；可配合 `@@zod_schema` / `@@json_schema` 约束变量写回；`profile` 可绑定已有智能体，省略则自动生成最小权限专用智能体；`tools` 可显式追加跨世界书 `@@tool` 或预设自定义工具（同世界书内启用的 `@@tool` 会自动继承） |
| `@@script` | `phase=... order=... barrier=... group=... target=... interval=... regex="..." keys="..."` | 零 Token 确定性 JS 脚本（正文写 JS，支持 ```` ```js ```` 代码块）；可与 `@@trigger` 同用 |
| `@@tool` | `<toolName> allowNetwork=true\|false` | 把世界书条目编译为自定义 JS 工具（正文使用 `export default defineTool(...)`） |
| `@@group` | `<groupName>` | 指定同 `phase`/`order`/`profile` 的 Agent 触发器合并分组名 |
| `@@system` | — | 将该世界书条目标记为系统规则层（`system_rule`） |

### 原生与兼容装饰器（`ST_NATIVE_DECORATORS` & `LEGACY_DECORATORS`）

| 装饰器 | 归类 | 说明 |
| :--- | :--- | :--- |
| `@@activate` | 原生 | 强制激活该世界书条目 |
| `@@dont_activate` | 原生 | 禁止激活该世界书条目 |
| `@@replace` / `@@replace_before` | 兼容 | 触发专用 Agent 对当前条目对应的 `/lorebooks/...` 执行覆写（`_before` 在 `before_turn`，否则 `after_turn`） |
| `@@replace_diff` / `@@replace_diff_before` | 兼容 | 同上（语义标记 diff 局部编辑） |
| `@@replace_search` / `@@replace_search_before` | 兼容 | 同上（语义标记检索后编辑） |
| `@@variables_json` / `@@variables_json_before` | 兼容 | 触发变量维护 Agent 更新 `/state/variables.json`（默认 `barrier=turn`） |
| `@@variables_yaml` / `@@variables_yaml_before` | 兼容 | 同上（兼容历史 YAML 提示词风格） |
| `@@variables_jsonpatch` / `@@variables_jsonpatch_before` | 兼容 | 同上（强调 `patch_variables` 增量补丁） |
| `@@append_output` / `@@append_output_before` | 兼容 | 触发专用 Agent 向 `/output.md` 追加内容 |
| `@@replace_output` / `@@replace_output_before` | 兼容 | 触发专用 Agent 编辑替换 `/output.md` |
| `@@evaluate_ejs` / `@@evaluate_ejs_before` | 兼容 | 零 Token EJS 执行器：运行 `<% ... %>` 副作用，不输出文本 |
| `@@replace_ejs` / `@@replace_ejs_before` | 兼容 | 运行 EJS 后将结果写回该条目对应的 `/lorebooks/...` 覆写 |
| `@@append_output_ejs` / `@@append_output_ejs_before` | 兼容 | 运行 EJS 后追加到 `/output.md` |
| `@@replace_output_ejs` / `@@replace_output_ejs_before` | 兼容 | 运行 EJS 后替换 `/output.md` |
| `@@batch_order` | 兼容 | `<order>` 指定同批执行顺序 |
| `@@preset` | 兼容 | 标记预设参考条目 |
| `@@json_schema` | 兼容 | 内联 JSON Schema（写在参数行或紧随首个代码块）校验变量 |
| `@@zod_schema` | 兼容 | 内联 Zod Schema（如 `z.object({ hp: z.number() })`）校验变量 |
| `@@agent` | 兼容 | 将条目声明为可被主智能体委派的子智能体定义 |
| `@@skill` | 兼容 | 将条目挂载为只读 `/skills/<name>.md` 技能文件 |

---

## 5. 可直接复制的实用模板

### 示例 A：后置自动更新分支变量（带 Zod Schema 校验）
```markdown
@@trigger phase=after order=1 barrier=turn target=/state/variables.json
@@zod_schema z.object({ hp: z.number().min(0).max(100), location: z.string() })
根据本轮最新剧情，调用 read_variables 读取当前状态，再用 patch_variables 更新 hp 与 location。
```

### 示例 B：前置推演或条件检查（`before_turn`）
```markdown
@@trigger phase=before order=5 barrier=turn keys="战斗,袭击"
检查角色当前装备与伤势变量，将本场战斗的关键限制写入 /workspace/shared/combat-brief.md。
```

### 示例 C：每 5 轮触发一次总结
```markdown
@@trigger phase=after order=20 barrier=self interval=5
阅读最近 5 轮对话并更新 /memory/arc-summary.md。
```

### 预设 `TriggerRule` 数据结构（用于 `agentic_preset_component_upsert`）
```json
{
  "id": "after_vars_update",
  "label": "后置状态结算",
  "source": "preset",
  "phase": "after_turn",
  "order": 1,
  "barrier": "turn",
  "agentProfileId": "main",
  "kind": "agent",
  "condition": { "type": "always" },
  "instructionTemplate": "检查最新剧情并更新 /state/variables.json。",
  "targetPath": "/state/variables.json",
  "enabled": true
}
```
