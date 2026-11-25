# SillyTavern 原生资产读写路由、权限与三层变量对照

> 本页用于消灭「工具打转」：先查操作目标对应的工具、模式门槛与存储位置，再动手调用。

---

## 1. 最常见误区（动手前必看）

1. **VFS 覆写 ≠ 修改 ST 原生资产**
   - `write_file` / `edit_file` 修改 `/lorebooks/**`、`/character/CONSTRAINTS.md`、`/persona/LESSONS.md`、`/workspace/**` 只会写入 **ST-Agentic 的当前聊天/分支覆盖层**，**不会**永久修改 SillyTavern 原生世界书、角色卡或人设。
   - `/character/description.md`、`/persona/description.md`、`/skills/*`、`/preset/*`、`/history/*`、`/docs/*` 在 VFS 中均为**只读**，尝试 `write_file` 会直接报 `VfsReadOnlyError`。
2. **读取原始 `@@` 装饰器与 `<% ... %>` EJS 必须用专用工具**
   - VFS 中的 `/lorebooks/*` 可能经过 `LoreReadHook` 清洗/宏替换；读写含 `@@` 装饰器或 `<% ... %>` 的原始世界书条目，必须使用 `wi_read_raw_book` / `wi_read_enabled` 与 `wi_upsert_*`。
3. **权限不足时的标准动作**
   - 如果所需工具不在当前工具列表中，直接向用户说明需要切换到的助手模式（如 `adjust` / `author` / `full`）或开启 `ST 全权管家 (stAdminEnabled)`，**禁止**改写只读 VFS 路径替代。

---

## 2. 四档模式与工具总路由表

| 目标资产 / 操作 | 只读 (`chat`) | 调整当前聊天 (`adjust`) | 写卡 (`author`) | 完全控制 (`full`) | `full + stAdmin` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **当前角色卡** | `card_read_active` | — | `card_read_full` / `card_patch_active` / `card_embed_agentic` | 同 `author` | 同左 + `card_admin_*` |
| **主世界书** | `wi_read_enabled` | VFS `/lorebooks/**` 分支覆写 | `wi_read_raw_book` / `wi_upsert_primary_entry` / `wi_delete_primary_entry` | 同 `author` | 同左 |
| **任意已启用世界书** | `wi_read_enabled` | — | `wi_read_raw_book`（传入 `bookName`） | `wi_read_raw_book` / `wi_list_enabled_books` / `wi_upsert_enabled_entry` / `wi_delete_enabled_entry` | 同左 |
| **全部/未启用世界书与绑定** | — | — | — | — | `wi_read_raw_book`（含未启用书） / `wi_admin_list_all` / `wi_admin_create_book` / `wi_admin_bind_book` / `wi_admin_upsert_entry` / `wi_admin_delete_entry` |
| **ST 原生正则** | — | — | `regex_list_scoped` / `regex_upsert_scoped` / `regex_delete_scoped` | 同 `author` | 同左 + `regex_admin_global_upsert` / `regex_admin_global_delete` |
| **刷新前端消息显示** | — | — | `chat_reload_messages` | `chat_reload_messages` | `chat_reload_messages` |
| **聊天消息楼层** | `search_history` / `read_history` | `chat_create_message` / `chat_edit_message` / `chat_delete_message` / `chat_toggle_hide_message` / `message_override_display` | 同 `adjust` | 同 `adjust` | 同 `adjust` |
| **三层状态变量** | `read_variables` / `/state/*.json` | `patch_variables` / `write_file` / `edit_file` | 同 `adjust` | 同 `adjust` | 同 `adjust` |
| **酒馆助手脚本 (`JS-Slash-Runner`)** | — | — | — | — | `tavern_helper_scripts_read` / `tavern_helper_scripts_upsert` |
| **ST 全局设置 / 预设 / 人设** | — | — | — | — | `st_settings_read` / `st_settings_patch` / `st_preset_*` / `persona_admin_*` / `st_sync_runtime` |
| **ST Slash / URL 导入** | — | — | — | — | `st_slash_exec` / `st_import_url` |
| **ST-Agentic 自身配置** | `agentic_read_status` / `agentic_read_traces` | — | — | `agentic_config_read` / `agentic_settings_patch` / `agentic_preset_component_*` / `agentic_connection_upsert` | 同 `full` |

---

## 3. 三层统一变量系统（与 ST 原生 & `ST-Prompt-Template` 互通）

ST-Agentic 的三层变量已与 SillyTavern 原生存储完全打通，不存在两套割裂的变量表：

| ST-Agentic `scope` | VFS 路径 | SillyTavern 原生存储 | `ST-Prompt-Template` `scope` | `JS-Slash-Runner` `type` | 说明 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `message`（默认） | `/state/variables.json` | `chat[msgId].variables[swipeId]` | `message` | `{ type: 'message', message_id }` | 跟随 `(messageId, swipeId)` 因果分支；支持 `[InitVar]` 回退与 `@@json_schema` / `@@zod_schema` 校验 |
| `chat` | `/state/chat_variables.json` | `chat_metadata.variables` | `local`（注意命名差异） | `{ type: 'chat' }` | 当前聊天全局共享，跨分支 |
| `global` | `/state/global_variables.json` | `extension_settings.variables.global` | `global` | `{ type: 'global' }` | 跨聊天全局共享 |

### 读写工具要点
- **`read_variables`**：`{ path?, scope?: 'message'|'chat'|'global', include_schema?: boolean, default_value? }`
  - `path` 支持点路径（`"player.hp"`）或 JSON Pointer（`"/stats/gold"`）。
- **`patch_variables`**：`{ scope?: 'message'|'chat'|'global', json_merge?, json_patch? }`
  - `json_merge`：RFC 7396 合并补丁（对象递归合并，`null` 删除键）。
  - `json_patch`：RFC 6902 操作数组（`[{ op: 'replace'|'add'|'remove'|'move'|'copy'|'test', path: '/a/b', value? }]`）。
  - `scope: 'message'` 写入前会自动按活跃 `@@json_schema` / `@@zod_schema` 校验。

---

## 4. 各类 ST 原生资产的防踩坑细节

### 世界书（World Info）
- 所有 `wi_upsert_*` 均**原样保留**开头的 `@@` 装饰器和 `<% ... %>` EJS 块（不转义 `@`）。
- 新建条目省略 `uid`，更新条目传入已有 `uid`。
- `wi_read_raw_book` 省略 `bookName` 时默认读取当前角色绑定的主世界书；传入 `bookName` 时可直接读取任意**已启用/全局启用**世界书（即使当前角色未绑定主世界书），开启 `full + stAdmin` 时还可读未启用的世界书。遇到超大世界书（> 24 KB）时会自动降级为条目目录，可传 `uid`（配 `start_line` / `end_line`）逐段读取或 `query` 跨条目检索（默认自动折叠超长 Base64）。
- `wi_upsert_primary_entry` 只写主绑定世界书；如主角色卡未绑定主世界书或需要改额外附加世界书，用 `wi_upsert_enabled_entry`（`full`）或 `wi_admin_bind_book` + `wi_admin_upsert_entry`（`full + stAdmin`）。

### 正则（不要混淆两套正则）
1. **ST 原生正则**（作用于酒馆聊天渲染或原生提示词）：
   - 角色局部正则：`regex_list_scoped` / `regex_upsert_scoped` / `regex_delete_scoped`（`author`）。
   - 全局正则：`regex_admin_global_upsert` / `regex_admin_global_delete`（`full + stAdmin`）。
   - 修改展示正则（如状态栏 HTML 替换）后，调用 **`chat_reload_messages`** 立即重渲染当前聊天界面。
2. **ST-Agentic 三阶段正则**（`display` / `ingest` / `lore_read`）：
   - 使用 `agentic_preset_component_upsert`（`kind: 'regex_rule'`），详见 `/docs/agentic-config.md`。

### 酒馆助手脚本（`JS-Slash-Runner` / `TavernHelper`）
- **不要**用 `st_settings_read` 翻大对象找脚本，直接调用专用工具：
  - `tavern_helper_scripts_read({ scope: 'global' | 'character' | 'preset' })`：脚本总体积超过 16 KB 时自动返回轻量目录（含各脚本 `id` / `name` / 行数 / 字节数）；传 `scriptId`（配 `start_line` / `end_line`）精准读取单脚本源码（默认折叠 `data` 与超长 Base64），或传 `query` 跨脚本搜索行号与上下文。
  - `tavern_helper_scripts_upsert({ scope, mode, ... })`：支持全量/新建 `upsert`、局部行定位替换 `edit_content`（配合 `contentEdits: [{ search, replace, start_line?, end_line?, replace_all? }]`，可无损修改含超大 Base64 资源的脚本）、`delete` 与 `replace_all`。
- 如需让运行中的扩展立刻应用变更，调用 `st_sync_runtime`。

### ST 设置读取（避免浪费轮次）
- `st_settings_read` 整包超过 16 KB 时只会返回 `summaryOnly: true` 的键清单。
- 务必优先传入具体的 `scope`（如 `"Agentic"`、`"EjsTemplate"`、`"tavern_helper"`）或 `keyPath`（如 `"power_user.theme"`、`"tavern_helper.script.scripts"`）。
