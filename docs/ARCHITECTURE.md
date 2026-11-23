# ST-Agentic 总体架构设计文档

本文档定义 `ST-Agentic`（`../ST-CustomGeneration` 的新一代完全 Agent 化重构版本）的整体架构、核心不变量、接口契约、兼容策略、UI/UX 规范、自动化测试体系与工程实施路线。

---

## 1. 项目定位与核心设计不变量（Vision & Core Invariants）

### 1.1 演进目标

原版 `ST-CustomGeneration` 虽然引入了工具调用和虚拟文件系统（VFS），但其核心管线仍然沿用 SillyTavern（ST）传统的**“每轮全量重排 Prompt + 一次性文本生成 + 硬编码正则后处理（`@@replace` / `@@variables_*`）”**范式：
- World Info 关键词动态插拔、`@D` 深度注入漂移、逐条滑动窗口、前缀内动态宏与脚本求值，导致**每轮请求几乎 100% 击穿 LLM Prefix KV Cache**。
- 后台触发器每次临时组装 Prompt 盲写 Diff 或 JSON Patch，一旦锚点偏差或 Schema 校验失败就只能整次作废重跑，且同样无法跨轮共享缓存。

`ST-Agentic` 的核心目标是把整个生成与触发系统彻底改造为 **“触发器驱动（Trigger-Driven） + 主动按需拉取（Pull-First） + 严格前缀缓存友好（Cache-Friendly）”** 的多 Agent 执行引擎：
- 连“主回复生成”本身也作为四阶段管线中的一个标准 Agent 阶段执行。
- 所有设定、人设、世界书、状态变量、历史归档统一通过 VFS 暴露，由 Agent 按需查阅与修改，不再无差别推送进 Prompt。
- 通过严格的前缀稳定性设计、高低水位分块压缩及并发控制，在保持现有中文大卡与 `@@` 装饰器生态兼容的同时，榨干现代推理引擎的前缀缓存收益。

### 1.2 四大核心不变量

后续所有模块实现与重构均必须满足以下四条不可违背的系统不变量：

1. **Append-Only 前缀不变性（Prefix Immutability）**
   - 在未触发高水位分块压缩（Block Compaction）前，任意持续会话（主 Agent 或 `persistent` 伴生 Agent）发往 LLM 的请求中，**稳定序列化的 `tools` 定义文本与此前轮次的 `messages[0 .. prevLen - 1]` 必须保持逐字节完全一致（Byte-for-Byte Identical）**。
   - 禁止任何 `@D` 深度插入历史中间、禁止每轮动态修改头部系统提示词、禁止逐条滑动截断或每轮自动折叠上一轮的工具返回值。
2. **Pull 优先的信息获取范式（Pull-First Context）**
   - 系统默认只提供轻量静态指令与文件索引，不把全量角色卡与激活世界书原文强行塞入 Prompt。
   - 信息检索通过 VFS 工具（`read_file`、`search_files`、`grep_search`、`list_dir`）或 `@@agent` 子智能体委托完成，辅以基于已读内容哈希的尾部增量雷达提示。
3. **统一受控执行模型（Unified Trigger + Agent Runtime）**
   - 原版硬编码的十余种文本/变量后处理器统一退化为 `TriggerRule`（调度时机、条件、目标、并发屏障）与 `AgentProfile`（会话模式、模型连接、工具集、VFS 目录读写权限）的组合，或 0 Token 的原生 JS 确定性脚本。
   - 所有状态写入在工具层完成 Schema 与格式校验，出错时在当前 Agent 对话轮次内原地自愈修复。
4. **Swipe 因果分支安全（Causal Branch Isolation）**
   - 聊天推进期间的 VFS 文件改动、变量覆写、持久 Agent 会话轨迹指针（Cursor / Branch Snapshot）以及 `barrier: 'none'` 的异步媒体回填，全部严格绑定到 `(messageId, swipeId)` 坐标。
   - 触发 Swipe、Regenerate、Delete 或中止任务时，对应分支层的暂存/提交数据、异步任务 `AbortController` 与轨迹指针必须精确回滚或中止，严禁跨页污染。

---

## 2. 工程模块划分与宿主防腐层（Directory Structure & Host Boundary）

原版将 `@st/*` 与浏览器全局对象直接散落耦合在几乎所有业务模块中，导致脱离浏览器无法做自动化单元测试。`ST-Agentic` 在物理目录和依赖方向上强制建立**宿主防腐层（Host Anti-Corruption Layer）**。

### 2.1 目录规划

```text
ST-Agentic/
├── manifest.json                 # 注册 generate_interceptor 与资源入口
├── package.json                  # scripts: build, lint, typecheck, dev:ui, test, test:browser, test:e2e
├── webpack.config.js             # 支持 .ts/.tsx (Preact JSX) 打包为单文件 dist/index.js
├── docs/
│   └── ARCHITECTURE.md           # 本文档
├── src/
│   ├── index.ts                  # 唯一启动装配入口：接线 HostBridge -> Core -> UI
│   ├── core/                     # 【纯逻辑内核】严禁直接 import '@st/*', window, document, '$'
│   │   ├── bridge/               # HostBridge 与 LLMTransport 抽象接口定义
│   │   ├── store/                # 分层数据存储 (ChatDataStore)、暂存提交、Swipe 回滚与存档冷层压平 (data-compaction)
│   │   ├── vfs/                  # VFS 路由、挂载树、模糊检索、ScopedToolGuard 权限沙箱
│   │   ├── lore/                 # WI 解析、四类自动分流、已读 xxHash 脏检查尾部雷达
│   │   ├── context/              # 三层上下文构建、Cache 断点注入、高低水位分块压缩
│   │   ├── regex/                # 自研独立正则解析与替换引擎 (display / ingest / lore_read)
│   │   ├── migration/            # 旧版 ST-CustomGeneration 与传统 ST 预设单向自动迁移器
│   │   ├── tools/                # 内置工具集 (fs / vars / history / media / ui_view) & 注册表
│   │   ├── agents/               # Agent 轮次循环、persistent/ephemeral 会话轨管理
│   │   ├── triggers/             # 四阶段调度管线、@@ 装饰器编译器、三级并发屏障
│   │   └── llm/                  # OpenAI/Anthropic 请求适配器、流式解析、重试与限流器
│   ├── sandbox/                  # 【受控脚本运行时】iframe 沙箱与生命周期管理
│   │   ├── js-sandbox.ts         # 原生 JS 自定义工具 (defineTool) 与 @@script 沙箱
│   │   └── lifecycle.ts          # 聊天切换/热重载自动清理定时器与监听防泄漏
│   ├── host/                     # 【唯一允许 import '@st/*' 的薄适配层】
│   │   ├── st-bridge.ts          # 实现 HostBridge（对接 chat, metadata, WI, settings, 角色卡）
│   │   ├── interceptor.ts        # generate_interceptor 拦截与按钮状态托管
│   │   ├── stream-renderer.ts    # rAF 节流流式上屏、<think> 块处理、局部楼层 DOM 刷新
│   │   ├── slash-bridge.ts       # 将 ST Slash Commands 包装为可调用 Tool
│   │   ├── embed-card.ts         # 角色卡管理菜单挂载：PNG 预设与工作区文件嵌入/双读导入
│   │   └── ejs-adapter.ts        # 【可选】桥接 globalThis.EjsTemplate，缺失时静默降级
│   └── ui/                       # 【独立 Shadow DOM 双态 UI】基于 Preact (~4KB)，物理隔离酒馆 CSS 污染
│       ├── dev-preview.ts        # 脱离酒馆的独立热更新预览入口 (npm run dev:ui)
│       ├── shell/                # <dialog id="agentic-app">、ShadowRoot、独立主题变量与键盘护栏
│       ├── session/              # 当前会话三视图 (文件与内容覆盖 / 生成与工具日志 / 缓存与存档压平)
│       ├── studio/               # 预设与系统六视图 (Agents / Pipeline / Tools / Regex / WIRouter / Connections)
│       └── capsule/              # 气泡微组件 <agentic-capsule> (Shadow DOM) 与右侧/魔棒快捷入口
└── tests/
    ├── fixtures/                 # 脱敏中文大卡/EJS/装饰器测试语料
    ├── mocks/                    # MemoryHostBridge, ScriptedLLMTransport, 虚拟时钟闸门
    ├── unit/                     # Layer 1: Vitest 纯 Node 核心引擎与缓存不变性测试
    ├── browser/                  # Layer 2: Vitest Browser 无头 Chromium 沙箱与双视口 UI 测试
    └── e2e/                      # Layer 3: Playwright + 本地 Mock SSE Server 真酒馆冒烟测试
```

### 2.2 核心防腐层接口草案

```typescript
/** 消息锚点坐标：所有写入与异步副作用的唯一归属键 */
export interface MessageTarget {
    messageId: number;
    swipeId: number;
}

/** 世界书条目原始快照（宿主层注入，与 ST 内部对象解耦） */
export interface RawLoreEntry {
    world: string;
    uid: number;
    comment: string;
    content: string;
    keys: string[];
    keysecondary: string[];
    constant: boolean;
    selective: boolean;
    disable: boolean;
    position: number;
    depth: number;
    order: number;
    role: number;
}

export interface WriteChatMessageOptions {
    /** 流式阶段或内部暂存设为 false；后置触发器或独立编辑完结时可设为 true 触发 MESSAGE_UPDATED */
    emitEvent?: boolean;
}

/** 宿主防腐接口：core/ 模块只通过此接口访问聊天状态、资产与 ST 服务 */
export interface HostBridge {
    // 1. 会话与消息读写（直读写 ST 原生 chat[messageId].swipes[swipeId] / mes，取代影子展示层）
    getChat(): ChatMessageSnapshot[];
    getMetadata(): Record<string, unknown>;
    saveChatDebounced(): void;
    getActiveIdentity(): {
        userName: string;
        charName: string;
        characterAvatar: string;
        personaAvatar: string;
    };
    readChatMessage(target: MessageTarget): string | null;
    writeChatMessage(
        target: MessageTarget,
        content: string,
        options?: WriteChatMessageOptions,
    ): Promise<void>;

    // 2. 角色、人设与世界书资产读取
    getCharacterFields(): Record<string, string>;
    getPersonaDescription(): string;
    listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>>;

    // 3. 宏与可选模板渲染（沙箱求值使用）
    substituteMacros(text: string, overrides?: Record<string, string>): string;
    evaluateOptionalEjs?(text: string, vars: Record<string, unknown>): Promise<string>;

    // 4. 外部扩展联动与斜杠命令
    executeSlashCommand?(command: string, signal?: AbortSignal): Promise<string>;
    attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void>;
    refreshMessageView(target: MessageTarget): Promise<void>;

    // 5. 持久存储与哈希原语
    loadExtensionData<T>(key: string, fallback: T): Promise<T>;
    saveExtensionData<T>(key: string, value: T): Promise<void>;
    hashText(text: string): Promise<string>; // 基于 xxhash-wasm
}

/** 统一 LLM 传输接口：运行时对接真实 API，单测时注入 ScriptedLLMTransport */
export interface LLMTransport {
    complete(request: LLMRequest): Promise<LLMResponse>;
    stream(request: LLMRequest): AsyncIterable<LLMStreamChunk>;
}

export interface LLMRequest {
    connectionId: string;
    messages: CanonicalMessage[];
    tools: CanonicalToolSchema[]; // 严格按名称字典序与稳定 JSON 键序序列化
    cacheBreakpoints?: number[];  // Layer 0 尾部及稳定检查点索引，供 Anthropic/OpenRouter 适配器使用
    signal?: AbortSignal;
}
```

---

## 3. 缓存友好的三层上下文架构与分块压缩（Context Layout & Watermark Compaction）

### 3.1 三层上下文内存模型

无论是主 Agent 还是启用 `sessionMode: 'persistent'` 的后台伴生 Agent，其请求消息流都严格划分为只追加（Append-Only）的三层结构：

```text
+-----------------------------------------------------------------------+
| Layer 0: 绝对静态前缀 (Static Prefix — 会话期间字节级冻结)               |
|  1. Tool Schemas (稳定字典序排列，不随轮次增删工具定义)                  |
|  2. System Base (去除了"单人 {{char}} 扮演"硬假设的通用协作底座指令)      |
|  3. 第①类 WI 编译块 (全局文风、防抢话、思维链规则、显式 @@system)         |
|  4. Core Manifest (核心档案路径地图：/character/* + 第②类蓝灯标题与字数) |
+=======================================================================+  <-- Cache Breakpoint #0
| Layer 1: 分块冻结的持久轨迹 (Frozen Trajectory — 跨轮保留并不断追加)     |
|  - Turn 1: User (+ 当轮尾部雷达) -> Assistant (tool_calls) -> Tool ->    |
|            Assistant (最终回复)                                         |
|  - Turn 2: User -> Assistant ...                                       |
|  * 注：后置修改 UI 展示层的 @@append_output 等绝不回改这里的 Assistant    |
+=======================================================================+  <-- Cache Breakpoint #1 (随压缩周期移动)
| Layer 2: 当轮尾部追加区 (Tail-Only Dynamic Zone — 本轮后随历史凝固)       |
|  - 最新 User 输入                                                       |
|  - before_turn 产出的 <turn-brief>                                      |
|  - 第④类高频变动短提醒 (仅此一处允许出现动态变量状态，绝不倒插前文)        |
|  - 去重尾部雷达产出的 <lore-hint> (仅列本轮未读或 xxHash 已变更的路径)    |
+-----------------------------------------------------------------------+
```

- **去耦合扮演假设**：Layer 0 底座指令不再默认“你是角色 A，用户在和角色 A 对话”，而是明确定义“你基于挂载在 `/character/`、`/lorebooks/` 与 `/state/` 中的设定体系运转；它可能是单人角色扮演、多人群像剧场或世界模拟器，请严格遵循第 ① 类规则与核心档案中的角色/旁白定位”。
- **Swipe 分支与持久轨迹映射**：每个持久线程维护一张轻量检查点映射表 `Map<BranchKey, number>`（`BranchKey = "${messageId}#${swipeId}"`），记录该楼层该页结束时在线程消息数组里的截断索引与对应的 `Read-Set` 快照。切回旧 Swipe 并继续发送时，以不可变切片恢复到该锚点继续追加，前序公共历史缓存依然 100% 命中。

### 3.2 高低水位线分块重整（High/Low Watermark Compaction）

为了防止长对话下频繁滑窗或逐轮折叠 `tool_result` 频繁击穿前缀缓存，系统采用**滞回双水位线分块压缩**机制：

```text
Token 占用量
  ▲
  │        /│\                 /│\
H ├───────/-│-\───────────────/-│-\────── 高水位线 (如 36,000 tokens)
  │      /  │  \             /  │  \        • 到达 H 才触发一次性重整
  │     /   │   ▼           /   │   ▼       • 降回 L，之后连续 15~20 轮 100% 命中缓存
L ├────/────┴───●──────────/────┴───●──── 低水位线 (如 18,000 tokens)
  │   /
  └──────────────────────────────────────▶ 对话轮次
```

1. **增长期（`< HighWatermark`）**：严格禁止修改任何已发出的历史消息与 `tool_result`。哪怕某次 `read_file` 返回了 3,000 字设定，只要总长未触达 `H`，就让它安静待在前缀缓存里，后续轮次享受极低成本的缓存读取且无需重复读取。
2. **重整时刻（`maintenance` 阶段原子执行）**：一旦轮次结算后总 Token 跨过高水位 `H`，调度器在后台同一拍内将活跃窗口压回低水位 `L`，同步完成三个动作：
   - **动作 A（历史分块归档）**：从 Layer 1 头部完整切出最早的连续 $N$ 个对话回合（必须包含完整的 `tool_calls -> tool` 配对，不得在工具调用链中间切断），将可读对话与关键事件流转写入 VFS `/history/chunk-001.md`（递增编号）。Agent 日后需要回顾早年细节时，可随时调用内置的 `search_history` / `read_history` 回溯原文。
   - **动作 B（陈旧大体积 `tool_result` 折叠）**：针对**保留在活跃窗口内、但早于最近 $K$ 轮**且体积超过阈值（如 `> 400 chars`）的只读工具输出（如 `read_file`、`search_files`），将其正文替换为紧凑占位符：
     `[已折叠只读输出: /lorebooks/world/银莲花-12.md (约 850 字，内容哈希 a1b2c3d4)；如需重温请重新 read_file]`。
   - **动作 C（同步刷新雷达已读集合）**：将所有被动作 A 切出或动作 B 折叠掉的文件路径，从当前线程的 `Read-Set` 中剔除。这样后续剧情再次提及相关关键词时，雷达才会重新温柔提示一次。
3. **双模式摘要协同（避免与卡作者自建摘要重复花钱）**：
   - **衔接模式（检测到卡片已启用摘要/大纲/重要信息表格触发器）**：切出 `/history/chunk-NNN.md` 时**不额外发起内部摘要 LLM 调用**，仅在 Layer 1 头部插入一条归档索引块，提示归档文件范围及用户自建摘要文件路径（例如 `/memory/summary.md`、`/memory/outline.md`）。
   - **内置兜底模式（卡片无任何摘要触发器）**：唤醒内置 `Compaction Agent`，基于刚切出的对话块生成结构化前情提要并写入 `/history/summary.md` 且固化于保留窗口头部。

### 3.3 跨厂商缓存协议适配

`src/core/llm/` 根据连接配置 `cachePolicy` 自动适配主流提供商：
- **自动前缀缓存模式（OpenAI / DeepSeek / Gemini）**：严格保障序列化稳定性（对象属性顺序确定、Tool 列表不重排、消息只追加），即可自动命中云端前缀缓存。
- **显式断点缓存模式（Anthropic / OpenRouter Claude）**：在适配器编译出最终厂商 Payload 时，自动向 `Layer 0` 末尾工具/系统块、上一轮 `Layer 1` 稳态检查点及当前增量边界插入最多不超过厂商上限（如 4 个）的 `cache_control: { type: "ephemeral" }` 标记。

---

## 4. 虚拟文件系统（VFS）与中文卡 WI 生态兼容方案

### 4.1 VFS 挂载拓扑

沿用并拓展 `ST-CustomGeneration` 的分层回滚理念，所有文件按作用域精确隔离：

| 挂载路径 | 底层数据源 | 读写权限 | 回滚与持久化语义 |
| :--- | :--- | :--- | :--- |
| `/`（工作区根） | `ChatDataStore` (`files` 命名空间) | `rw` | 随 `(messageId, swipeId)` 分层写入，Swipe 切页自动回滚 |
| `/output.md` | `OutputMount`（经 `HostBridge.readChatMessage` / `writeChatMessage` 直连真实 ST 消息；伴生模式 `before_turn` 支持内存 `preCreateBuffers` 预缓冲） | `rw` | 严格绑定单楼层 `(messageId, swipeId)` **非继承**读写，彻底取代 `DATA_NAMESPACES.MESSAGE` 影子覆写；不写入持久化线程 `Read-Set`；配套 15 个内置工具中的 `write_file` / `append_file` / `edit_file` 与流式参数预览 |
| `/state/variables.json` | 变量桥接树（对齐 ST / `[InitVar]` 变量） | `rw` | 随 `(messageId, swipeId)` 分层写入，兼容旧版读写与 `patch_variables` |
| `/character/*` | 角色卡字段只读快照 + `character-files` 层叠 | `ro` / 局部 `rw` | 沿用快照覆写机制（跳过空字段与 `first_mes`） |
| `/persona/*` | 当前人设快照 + `persona-files` 层叠 | `ro` / 局部 `rw` | 同上 |
| `/lorebooks/<book>/<slug>-<uid>.md` | 启用世界书条目原文 + `worldinfo` 覆写 | 原文 `ro` / 覆写 `rw` | 删除覆写即恢复原书文本；读操作触发沙箱动态求值 |
| `/skills/<name>.md` | `@@skill` 世界书条目 | `ro` | 仅供查阅，显式激活通过技能工具 |
| `/preset/*` | 随当前 Preset 携带的参考文档 | `ro` | 随预设导入导出 |
| `/global/*` | 扩展全局持久存储 | `rw` | 跨聊天共享持久化（偏好、通用知识库） |
| `/history/chunk-*.md` | 分块压缩归档对话 | `ro` | 只读归档，配套 `search_history` 与 `read_history` |

> **15 个内置工具与 `/output.md` 强制输出规范**：内置工具集包含 `list_dir`、`glob_files`、`grep_search`、`search_files`、`read_file`、`write_file`、`append_file`、`edit_file`、`read_variables`、`patch_variables`、`search_history`、`read_history`、`append_reply_view`、`replace_reply_view`、`attach_media`。其中 `append_file` 支持长章节分段追加与断点续写；主叙事 Agent（`main_turn`）必须通过文件工具写/修 `/output.md`，普通 `assistant.content` 仅记录在 `TrajectoryStore` 与日志中而不上屏。`read_file('/output.md')` 豁免写入跨轮 `Read-Set`。

### 4.2 针对“空壳角色卡 + 万物皆 WI”的四类语义自动分流

针对大量中文大卡将真正人设、规则、状态面板全部写进 World Info 而原生 `character` 字段几乎为空的现状，构建了在加载阶段运行的 **WI 语义分流器（WI Classifier）**，并在工作台 UI 提供手动覆写纠偏能力：

| 分类 | 职责定位 | 自动启发式识别规则（优先级从高到低） | 运行时去向与缓存策略 |
| :--- | :--- | :--- | :--- |
| **① 全局指令与文风层** (`system_rule`) | 破限、文风约束、防抢话、输出规范、固定思维链格式 | 含显式 `@@system`；或（蓝灯 `constant: true` 且为 `@D0~@D2` System 注入，且不含变量修改/动态脚本） | **会话初始化时直接编译入 Layer 0 静态前缀**（消除 `@D` 每轮搬家破缓存，并确保第一轮就严格生效） |
| **② 核心主干设定** (`core_manifest`) | 空壳卡里真正的主角面板、世界观总纲、全局法则 | 蓝灯 `constant: true` 且非触发器/非高频动态脚本，位置在 `Before/After Char` 或非低深度指令区 | 挂载于 `/lorebooks/`，并在 Layer 0 的 **Core Manifest 清单**置顶显示路径、标题与字数，引导主 Agent 第 1 轮按需 `read` 沉淀 |
| **③ 按需检索档案库** (`on_demand_archive`) | NPC 档案、地点、道具、分支剧情、阶段事件 | 绿灯关键词触发条目（非触发器/纯脚本） | 挂载于 `/lorebooks/`，由 **尾部去重雷达** + Agent 主动 `search_files`/`read_file` 按需拉取 |
| **④ 脚本、变量与动态层** (`dynamic_or_trigger`) | `[InitVar]`、`@@` 后处理触发器、纯脚本、高频动态提醒 | 含已知触发器装饰器（`@@replace*` / `@@variables*` / `@@trigger` / `@@script` / `@@tool` 等）；或含 `setvar` / `[GENERATE:BEFORE]`；或包含高频变动的 `@D` 状态提醒 | 从静态上下文完全剥离！按职责归入 `/state/` 初始化、Trigger 四阶段执行，或将极短动态状态提醒放入 **Layer 2 尾部** |

> **空壳角色卡补偿**：加载时若检测到 `/character/description.md` 等主要角色卡字段缺失或过短（例如 `< 80` 字且无有效信息），Layer 0 会在 Core Manifest 中明确提示当前属于“世界书驱动型卡片，核心设定位于下方常驻世界书条目中”，防止 Agent 误以为没有背景设定。

### 4.3 读取时沙箱求值（Read-Time Evaluation）与 `xxHash` 脏检查雷达

在 `ST-CustomGeneration` 时代，请求发出前广播 `CHAT_COMPLETION_PROMPT_READY` 允许外部脚本任意修改整个 `messages` 数组，这会直接摧毁前缀缓存。`ST-Agentic` 采用**下沉到读取时刻的局部沙箱求值 + 增量哈希雷达**：

1. **禁止外部重写历史前缀**：主请求构造时不向外部广播会任意扫描改写历史消息前缀的事件（仅允许尾部动态区或显示层走正则与局部渲染）。
2. **VFS 读取时渲染（Read-Time Eval）**：当 Agent 调用 `read_file("/lorebooks/...")` 或内部读取核心条目时，VFS 先叠加当前楼层的 `worldinfo` 覆写，再根据当前楼层变量状态依次运行 ST 宏替换与（当检测到宿主安装了 `globalThis.EjsTemplate` 时的）可选 EJS 沙箱渲染，最终将干净的渲染结果返给模型，固化在该轮 `tool_result` 中。
3. **带脏检查的已读去重尾部雷达（Deduplicated Tail Radar）**：
   - 每个持久 Agent 维护自己的 `Read-Set: Map<path, string>`，记录“目前在未压缩活跃上下文中已读过的 VFS 路径及其当时的渲染文本 `xxHash`”。
   - 每轮接收用户输入后，雷达在本地毫秒级跑一遍关键词与正则触发扫描（复用 ST 条目 `keys` / `keysecondary` / `selective` 逻辑）。
   - 对每条命中且属于第 ③ 类的档案条目：
     - **首次未读命中**：纳入尾部提示候选队列；
     - **已读且本地试算渲染后 `xxHash` 与 `Read-Set` 一致**：**完全静默**（哪怕变量值变了但条件分支没跨阈值，只要最终文本一字未变就不打扰模型，保护缓存）；
     - **已读但因覆写或 EJS 条件分支翻转为新的渲染 `xxHash`**：标记为“内容已随剧情/状态更新”，推送尾部更新提醒。
   - **防烂卡刷屏与防诱导护栏**：
     - 严格限制单轮最多输出前 `Top-K` 条（默认 `K = 5`，优先按命中词特异性与 `order` 排序），其余只附带一行摘要计数：`+N 条更多候选匹配，如有需要请调用 search_files 检索`。
     - 输出格式放在本轮末尾：
       ```xml
       <lore-hint>
       以下条目字面匹配本轮输入（可能存在日常词误报，仅在剧情确实需要时按需 read_file，无关请直接忽略）：
       - [未读] /lorebooks/world/银莲花-12.md (命中: "银莲花", ~450字)
       - [已更新] /lorebooks/card/女主好感事件-05.md (~320字)
       </lore-hint>
       ```

### 4.4 兼容性边界声明

| 兼容级别 | 涵盖写法与特性 | 处理机制 |
| :--- | :--- | :--- |
| **一等完全支持** | 原生 ST 角色卡、空壳卡 + 万物皆 WI、第 ①~③ 类条目拆分、`@@` 触发器家族、`[InitVar]`、原生 ST 宏 | 全自动分流、兼容编译与缓存优化 |
| **沙箱桥接支持** | WI 内部 `<% if/for/getvar %>` 条件动态正文（安装 EJS 扩展时）；含每轮变动变量短提醒的 `@D0` 条目 | VFS 读取时局部渲染 + `xxHash` 脏检查重读；动态短提醒自动收拢至 Layer 2 尾部 |
| **明确降级 / 放弃原语义** | ① `ST-Prompt-Template` `@INJECT` 对历史消息任意深度的结构性篡改；② 不拆条目、整张卡写进一个几万字 `[GENERATE:BEFORE]` 巨型拼接脚本 | ① 禁止改写历史前缀，仅支持转为尾部提醒或忽略历史位注入；② 大块动态拼接文本自动托管为 `/state/generated_context.md` 由 Agent 按需读取 |

---

## 5. 基于触发器的 Agent 执行系统与三级并发屏障

### 5.1 核心调度模型：`TriggerRule` 与 `AgentProfile`

整个扩展的自动化行为由**触发规则**和**智能体档案**两个正交结构驱动：

```typescript
export type PipelinePhase = 'before_turn' | 'main_turn' | 'after_turn' | 'maintenance';
export type BarrierPolicy = 'turn' | 'self' | 'none';
export type SessionMode = 'persistent' | 'ephemeral';

export interface ScopedPermissions {
    read: string[];   // Glob 路径模式，如 ['/**'] 或 ['/lorebooks/**', '/state/**']
    write: string[];  // Glob 路径模式，如 ['/state/variables.json', '/memory/**']
}

export interface PromptBlock {
    id: string;
    name: string;
    role: 'system' | 'user' | 'assistant';
    placement: 'prefix' | 'tail';   // 仅允许放入 Layer 0 静态前缀或 Layer 2 当轮末尾
    content: string;
    enabled: boolean;
}

export interface AgentProfile {
    id: string;
    name: string;
    connectionId: string;           // 支持 'inherit'（跟随当前主连接）或指定具体副连接 ID
    sessionMode: SessionMode;       // persistent: 伴生持久缓存轨 | ephemeral: 瞬态按需轨
    promptBlocks: PromptBlock[];    // 模块化指令积木（取代原扁平 PresetPrompt 槽位与单一文本）
    enabledTools: string[];         // 内置工具名 + 自定义 @@tool / 斜杠工具名
    permissions: ScopedPermissions; // 运行时由 ScopedToolGuard 强制校验
    maxToolRounds: number;
    watermark?: { high: number; low: number };
    ephemeralWindowSize?: number;   // 仅 ephemeral 模式生效：拉取最近 K 轮对话
}

export interface TriggerRule {
    id: string;
    label: string;
    source: 'preset' | 'worldinfo';
    phase: PipelinePhase;
    order: number;                  // 对应原版 @@batch_order，决定执行批次顺序
    barrier: BarrierPolicy;         // 并发屏障策略
    agentProfileId: string;         // 指向执行的 Agent；若 kind === 'script' 则直接跑 JS
    kind: 'agent' | 'script';
    tag?: string;                   // 保留原版 @@<decorator> <tag> 的精确与空标签回退匹配语义
    groupName?: string;             // 可选 @@group <name>，显式合并同批同质任务
    condition: {
        type: 'always' | 'interval' | 'regex' | 'keyword' | 'js_predicate';
        interval?: number;
        pattern?: string;
        keys?: string[];
        predicateCode?: string;
    };
    instructionTemplate: string;    // 注入给该触发任务的具体指令
    targetPath?: string;            // 针对特定档案/变量文件赋权的锁定路径
    schemaSource?: { kind: 'json' | 'zod'; raw: string };
    enabled: boolean;
}
```

### 5.2 四阶段生命周期管线

```text
用户发送 / Swipe / Regenerate
  │
  ├─► [Barrier Check] 检查上一轮尚未落盘的 barrier: 'turn' 任务 -> 若未完则在此 await
  │
  ├─► [Phase 1: before_turn] 按 order 分批运行前置触发器 & @@*_before
  │     • 修改的 VFS/变量进入当前楼层暂存层 (Staged)
  │     • 可产出一份简洁文本注入主 Agent 尾部的 <turn-brief>
  │
  ├─► [Phase 2: main_turn] 主叙事 Agent 执行
  │     • 接收：用户输入 + 尾部 <turn-brief> + <lore-hint>
  │     • 工具循环 (按需 read / search / 调 @@agent 子专家) -> 实时流式生成主回复
  │     • 主回复结束：创建/更新 messageId#swipeId，并将当前暂存层首批落盘
  │
  ├─► [Phase 3: after_turn] 按 order 派发后置后台任务（不锁主发送框！）
  │     • barrier: 'turn' -> 如变量/核心状态更新（下一轮前必等）
  │     • barrier: 'self' -> 如摘要/大纲/伏笔追踪（同任务内部队列串行，不阻塞下一轮主聊）
  │     • barrier: 'none' -> 如 NAI/ComfyUI 生图、TTS、视频（独立脱离，按锚点回填）
  │     • 每个后台任务完成后独立将自己对目标楼层的变更 commit 到目标 messageId#swipeId
  │
  └─► [Phase 4: maintenance] 后台水位检查
        • 检查主 Agent 与各 persistent 伴生 Agent 是否跨过高水位 H，若是则原子执行分块压缩
```

### 5.3 原版 `@@` 装饰器无损映射与新装饰器扩展

| 原版 / 新增装饰器 | 编译后行为与工具授权 | 核心收益 |
| :--- | :--- | :--- |
| `@@replace` / `@@replace_diff` / `@@replace_search` (`*_before`) | 编译为指向该 WI 条目路径 `/lorebooks/<book>/<slug>-<uid>.md` 的单文件授权（`read` + `edit_file`/`write_file`）Agent 任务；原条目的提示说明作为指令 | 不再要求 LLM 盲写脆弱的 Git Diff 行号；锚点未命中时工具当场报错，模型多一轮局部微调即可自愈 |
| `@@variables_json` / `yaml` / `jsonpatch` + `@@json_schema` / `@@zod_schema` (`*_before`) | 编译为授权操作 `/state/variables.json` 的 `read_variables` / `patch_variables` 任务，自动把 Zod/JSON Schema 嵌入工具校验 | 违反字段类型或枚举约束时直接通过 `tool_result` 指明错处，原地纠偏无需整次重试 |
| `@@append_output*` / `@@replace_output*`（及 `@@trigger target=/output.md`） | 绑定目标路径 `/output.md`，授予 `read_file` / `edit_file` / `write_file` / `append_file` / `read_variables` 权限（兼容保留直连 `/output.md` 的 `append_reply_view` / `replace_reply_view`）；`@@append_output_ejs*` / `@@replace_output_ejs*` 亦经 `ChatMessageViewAdapter` 直连 `/output.md` | 通过 `OutputMount` / `HostBridge.writeChatMessage` 直接读写目标 `(messageId, swipeId)` 的真实 ST 消息并瞬态重绘 `.mes_text`（不再写入 `DATA_NAMESPACES.MESSAGE` 影子覆写）。由于主 Agent 轨迹独立保存于 `TrajectoryStore`，直改 ST 消息 **0 破坏 Prefix KV Cache**，且锚点失败时可在同一触发轮内重读 `/output.md` 自愈 |
| `@@evaluate_ejs` / `@@evaluate_ejs_before` | 若检测到 `EjsTemplate` 可用，编译为 0 Token 的沙箱脚本任务（向 EJS 注入 `fs`/`vars` 助手）；不可用时跳过提示 | 零模型消耗，保持确定性脚本顺序 |
| `@@agent <name>` | 注册为可供主 Agent 或其他 Agent 随时调用的 Sub-Agent Tool（独立上下文检索后仅向父级返回摘要结论） | 保护主 Agent 上下文不被大量中间搜索结果污染 |
| `@@skill` | 挂载至 `/skills/<name>.md`，维持显式激活语义 | 与原有技能工作流保持一致 |
| **新增 `@@trigger`** | 支持结构化参数（如 `@@trigger phase=after order=1 barrier=self profile=chronicler`），正文直接写自然语言规则 | 新卡作者彻底摆脱选择 Diff/Patch 格式的心智负担 |
| **新增 `@@tool <name>`** | 将 WI 条目内容作为原生 JS 工具定义加载，供指定 Agent 调用（见第 6 章） | 工具可随角色卡或世界书一并打包分发 |
| **新增 `@@script`** | 将 WI 条目内容作为无 LLM 参与的确定性 JS 触发器在指定时机执行 | 彻底取代对 EJS 扩展的强依赖 |
| **新增 `@@group <name>`** | 同 `phase` + 同 `order` + 同 `@@group` 且同 `AgentProfile` 的多条小触发器显式打包为单次合并调用 | 默认严格 1 对 1 独立运行；仅同质批量任务按需合并省开销 |
| **新增 `@@system`** | 强制标记某条蓝灯 WI 编译进 Layer 0 静态系统指令 | 为四类自动分流器提供 100% 确定性的作者逃生舱 |

### 5.4 任务隔离与三级并发屏障策略

1. **默认不合并原则**：后台任务生态横跨变量结算、摘要、大纲、伏笔追踪、重要信息表格、NAI/ComfyUI 生图、TTS 语音、视频生成等完全异构的任务，适合的模型规格和 Prompt 结构截然不同。因此系统**默认 1 个触发器对应 1 次独立的 Agent Run**（各持久 Agent 自己保有前缀缓存，拆开跑同样高缓存命中率且互不稀释注意力），仅在显式配置相同 `@@group` 时才打包合并。
2. **三级并发屏障（`BarrierPolicy`）与楼层锚定**：
   - **`'turn'`（跨轮强屏障 —— 变量更新、状态表格等默认）**：主生成完成后立即解锁用户输入体验；仅当用户发送下一轮请求且上一轮 `turn` 任务仍在跑时，下一轮在进入 `before_turn` 前自动 `await` 其落盘完成，严防读到过期变量。
   - **`'self'`（自身队列串行 —— 摘要、大纲、伏笔与同楼 Edit 触发器默认）**：**完全不阻塞下一轮主对话的立即发送与生成**；同时通过 `BarrierCoordinator.buildSelfQueueKeys` 对同一 `agentProfileId` 或共享写入路径生成 FIFO 串行锁。针对 `/output.md` 目标，锁键精细化为楼层坐标键 **`path:/output.md@${messageId}#${swipeId}`**——保证同一楼层同页多个 Edit 触发器严格串行（后者必读前者写回的最新 ST 消息），同时不同楼层间的后台 Edit 任务完全并发隔离、互不互锁。
   - **`'none'`（完全脱离后台 —— NAI/ComfyUI 生图、TTS、视频等默认）**：创建完全独立的楼层级 `AbortController`，彻底不阻塞任何后续轮次。
   - **防串楼铁律**：所有 `after_turn` 任务在启动瞬间即冻结其锚点 `target: { messageId, swipeId }`。即便用户已经往后聊了三四轮，该任务调用工具挂载插图、音频或写回文件时，永远精确落回锚定楼层并只局部重绘该楼层 DOM。仅当用户针对**该目标楼层**执行 Swipe（切离或删除该页）或点击该任务的独立 `[×]` 取消钮时，才会触发对应的 `AbortSignal`。

---

## 6. 原生 JavaScript 自定义工具与脚本运行时（EJS 可选化）

`ST-Agentic` 彻底解除对 `ST-Prompt-Template`（EJS）的强依赖：
- **核心内置语言是标准现代 JavaScript**：无需安装任何第三方模板插件即可开箱编写工具与脚本触发器。
- **EJS 纯可选适配**：仅当启动时检测到 `globalThis.EjsTemplate` 存在，才由 `src/host/ejs-adapter.ts` 激活旧卡 `<% ... %>` 读取求值与 `@@*_ejs` 兼容支持。

### 6.1 `defineTool` 与强类型执行上下文 `ctx`

参考 `JS-Slash-Runner` 的直觉开发体验，同时结合 Zod 参数校验与楼层锚定安全，用户可在工作台「工具与脚本」页或世界书 `@@tool <name>` 条目中编写如下代码（支持 `export default defineTool(...)` 导出单个工具，或导出工具数组一次注册工具包）：

```javascript
// 示例：调用本地 ComfyUI 生成插图并锚定挂载到对应回复楼层
export default defineTool({
  name: 'comfy_illustrate',
  description: '根据剧情画面构思生图提示词并调用本地 ComfyUI 生成插图挂载到当前消息',
  parameters: z.object({
    positivePrompt: z.string().describe('英文画面 Tag，不含质量词前缀'),
    aspectRatio: z.enum(['portrait', 'landscape', 'square']).default('portrait'),
  }),
  async execute(args, ctx) {
    // 1. 支持原生 fetch，并必须透传 ctx.signal（Swipe/停止时自动中断外部耗时请求）
    const resp = await fetch('http://127.0.0.1:8188/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildComfyWorkflow(args)),
      signal: ctx.signal,
    });
    const imageUrl = await waitComfyResult(resp, ctx.signal);

    // 2. 自动锚定到触发该任务的 (messageId, swipeId)，绝不串楼
    await ctx.message.attachMedia({ type: 'image', url: imageUrl });
    return `插图已生成并挂载到消息 #${ctx.target.messageId}: ${imageUrl}`;
  },
});
```

注入沙箱上下文 `ToolExecutionContext` (`ctx`) 的完整能力矩阵：
- `ctx.fs`：`read / write / edit / list / search / glob`，受当前 Agent 的 `ScopedPermissions` 与目标楼层绑定约束。
- `ctx.vars`：`get(path?) / set(path, value) / patch(ops)`，读写锚定楼层的 `/state/variables.json`。
- `ctx.message`：`attachMedia(media)`、`appendView(text)`、`replaceView(text)`，专门操作展示层，不影响模型底层记忆前缀。
- `ctx.st`：`slash(cmd)`（执行酒馆原生或其他扩展的斜杠命令，如 `/sd`、`/tts`）、`emit(event, data)`、`getActiveInfo()`。
- `ctx.target`：只读的 `{ messageId, swipeId }` 锚点坐标。
- `ctx.signal`：`AbortSignal`，所有异步网络请求与长轮询应透传此信号以便即时中断。
- `z`：预注入的 `zod` v4 构造器；`_`：常用工具函数集。

### 6.2 斜杠命令一键转 Tool 与沙箱安全

1. **零代码包装斜杠命令**：对于已在酒馆里装好插件（如生图、语音、天气、骰子）但不熟悉写 JS 的用户，工作台支持可视化配置一条“斜杠命令工具”——填好工具名、给大模型看的说明、Zod/JSON 参数表单以及命令模板（例如 `/sd {{prompt}}`），系统直接将其包装为标准可校验 Tool。
2. **分级 `iframe` 沙箱隔离与生命周期回收**：
   - 继承并完善 `FunctionSandbox` 架构：仅解析 `@@zod_schema` 等纯数据声明时启用**禁网隔离模式**（屏蔽 `fetch` / `XMLHttpRequest` / `parent` / `top`）；执行自定义工具或 `@@script` 时启用**受控工具沙箱**（按配置开放 `fetch` 以便调用 NAI / ComfyUI / TTS / 视频服务，同时严格隔离宿主页 DOM 破坏与全局原型链污染）。
   - 每个脚本实例的所有定时器（`setInterval` / `setTimeout`）及事件订阅均由 `SandboxLifecycleManager` 统一记账；当用户切换聊天、开关世界书或修改热重载脚本时，自动彻底销毁旧 `iframe` 并清空悬挂回调，杜绝内存与后台轮询泄漏。

---

## 7. 预设生态、自研正则引擎与旧版自动迁移

### 7.1 API 连接与 Preset 容器（保留并升级多连接协同）

1. **多模型连接配置（`ApiConnection`）**：
   - 完整保留原版连接参数体系：`baseUrl`、`apiKey`、`model`、`contextSize`、`maxTokens`、`temperature`、`topK`、`topP`、`frequencyPenalty`、`presencePenalty`、`stream`、`maxConcurrency`、自定义请求头/体/排除字段 YAML 配置，以及 `linkedPreset` 联动。
   - 新增 `cachePolicy`（自动前缀匹配 vs 显式断点标记），并新增测试连通与缓存命中验证能力。
2. **Preset 顶层容器**：
   - 作为可整体分享的一等公民单元，聚合当前预设下的：`agents`（含主叙事 Agent 与后台 Agent 的 `promptBlocks`、权限与连接映射，允许为后台 Agent 独立绑定副连接/快模型，默认 `'inherit'` 跟随主连接）、`triggers`、`regexRules`、`customTools`（JS 工具与斜杠包装）、`files`（`/preset/*`）与 `wiRouterOverrides`。
   - 保留 Preset 与子项清单的导入导出能力；导出预设包（无论是否勾选附带连接参数）**始终强制剥离 `apiKey`**。

### 7.2 模块化提示词积木与传统 ST 预设部分兼容导入

1. **模块化积木替代扁平槽位**：
   - 彻底废除原版 `PresetPrompt` 中的传统内置拼装槽位（`charDescription`、`worldInfoBefore`、`chatExamples` 等）以及会每轮位移击穿缓存的 `@D1 ~ @DN` 历史中间深度注入。
   - 每个 `AgentProfile` 通过 `promptBlocks: PromptBlock[]` 保留“多段积木独立开关、角色标签（`system` / `user` / `assistant`）与排序”的创作手感，但仅允许放置在两种缓存安全位置：
     - `prefix`：固定编译入 Layer 0 静态前缀（例如破限指令、文风规范、防抢话规则）；
     - `tail`：仅追加在 Layer 2 当轮末尾（例如临场格式提醒）。
2. **传统 SillyTavern OpenAI 预设部分兼容导入**：
   - 导入传统 ST 预设 JSON 时，自动提取已启用的用户自定义提示词块：相对位置（`relative`）块转入主 Agent 的 `prefix` 积木，`injectionPosition === 'inChat'` 且 `injectionDepth === 0` 的块转入 `tail` 积木；
   - **所有不支持的内置槽位（`main`/`personaDescription`/`worldInfo*`/`chatHistory` 等）与 `injectionDepth >= 1` 的深度注入直接忽略跳过**，并在导入完成弹窗中给出被忽略条目列表摘要，严防破坏新架构的缓存不变量。

### 7.3 自研独立正则引擎（`src/core/regex/`）

由于 SillyTavern 原生正则引擎大量核心处理函数未向外导出、不便在防腐层内复用，且原版 `RegEx` 按 `minDepth / maxDepth` 在每次发请求时动态回改历史消息会每轮击穿 KV Cache，`ST-Agentic` 在 `src/core/regex/` 内自研独立、纯函数式的正则管线引擎：

```typescript
export type RegexStage = 'display' | 'ingest' | 'lore_read';

export interface RegexRule {
    id: string;
    name: string;
    pattern: string;                // 支持 /pattern/flags 语法或纯文本匹配
    replace: string;                // 支持 $1, $2 与命名捕获组替换
    stage: RegexStage;              // 严格限定三种缓存安全执行阶段
    applyToUser: boolean;           // display / ingest 时是否作用于用户消息
    applyToAssistant: boolean;      // display / ingest 时是否作用于助手回复
    enabled: boolean;
}
```

- **`display`（纯展示层美化）**：仅在消息渲染到聊天 DOM 前运行（支持状态栏 HTML 折叠、思维链/特殊标签美化），不改写聊天原始数据，也绝不碰任何持久 Agent 的记忆轨迹。
- **`ingest`（入轨一次性清洗并固化）**：在用户消息发送或助手最终回复刚落地进入 Layer 1 持久轨迹的那一刻执行一次（例如剥除模型吐出的冗余 HTML 状态块、前端特效注释以节省后续上下文 Token）并**永久固化**在历史轨迹中，后续轮次绝不再按深度回改。
- **`lore_read`（世界书读取清洗）**：在 VFS 读取 `/lorebooks/*` 完成宏/可选 EJS 求值后执行一次，随当轮 `tool_result` 一同凝固进缓存前缀。

### 7.4 预设文件管理（`/preset/*`）与角色卡数据嵌入（`embed-card`）

1. **预设随附文件（`Preset.files`）**：完整保留并在 `/preset/<name>` 只读挂载，便于预设作者随包附带文风参考书、规则手册、设定表模板或初始化文档，由 Agent 按需 `read_file` 拉取而不占静态前缀。
2. **角色卡 PNG 嵌入分发（`src/host/embed-card.ts`）**：
   - 保留在 ST 角色卡管理下拉菜单挂载「关联预设到角色卡」「导入角色卡预设」「关联文件到角色卡」「导入角色卡文件」四项操作，并在写入角色卡时同步更新 live `character`、`character.json_data` 及 `#form_create [name=json_data]` 三处镜像防止保存覆盖丢失。
   - 新写入统一使用版本化扩展字段 `agentic_embed_presets` 与 `agentic_embed_files`；打开新角色卡时自动弹窗提示一键导入其携带的预设与工作区初始文件（`/state/*`、规则书、专属脚本等）。

### 7.5 旧版 `ST-CustomGeneration` 自动检测与无损单向迁移

`src/core/migration/` 负责在零手动干预的前提下，将旧版配置与资产平滑迁入 `ST-Agentic`（所有自动迁移均为**只读读取旧数据并拷贝转换，绝不破坏或删除原 `ST-CustomGeneration` 存储**）：

1. **三大自动迁移触发时机**：
   - **首次启动迁移**：若 `ST-Agentic` 尚无本地设置且检测到 `extension_settings.CustomGeneration`，自动拷贝并转换 API 连接、预设与工作区开关状态；
   - **JSON 导入迁移**：用户导入旧版 `ST-CustomGeneration` 导出的预设/Payload JSON 时，识别旧 Schema 版本并透明转换；
   - **角色卡与历史聊天兼容加载**：打开携带旧 `cg_embed_presets` / `cg_embed_files` 的角色卡时双读并自动升级转换；打开包含旧 `cg_data` / `wi_overrides` / `mes_override` 的历史聊天时由 `ChatDataStore` 无缝读取接管。
2. **核心数据结构迁移映射**：
   - `ApiSettings` → `ApiConnection`（原参数直迁，补默认 `cachePolicy: 'auto_prefix'`）。
   - `Preset.prompts` → 保留自定义文本块转入主 Agent `promptBlocks`（`relative` → `prefix`，`@D0` → `tail`），**忽略原内置槽位与 `@D >= 1` 深度注入**。
   - `Preset.templates`（旧 `Template` / `GenerationProfile`）→ 自动拆解升级为对应的 `AgentProfile`（保留 `promptBlocks` 与过滤范围）+ `TriggerRule`（保留 `kind`/`binding`/`tag`/`findRegex`，不再依赖脆弱的输出提取 `regex`）。
   - `Preset.regexs` → 转为 `RegexRule`：仅展示/临时类（`ephemerality: true` 或仅 `response`）映射至 `display`；世界书类（`worldInfo: true`）映射至 `lore_read`；求值清洗类（非 `ephemerality` 且 `response`/`request`）升级为 `ingest` 并丢弃 `minDepth`/`maxDepth`。
   - `Preset.files` / `cg_embed_files` → 逐文件无损迁入新版 `Preset.files` 与工作区。
   - `Settings.interceptGenerate` → `true` 迁移为运行模式 `runMode: 'takeover'`，`false` 迁移为 `runMode: 'companion'`。

---

## 8. 运行模式与 ST 主生成接管设计（Run Modes, Takeover & In-Chat UX）

### 8.1 三档运行模式（取代原版单一 `替代默认生成` 复选框）

原版单一复选框容易让用户误解“取消勾选即完全关闭扩展”，导致后台触发器仍悄悄扣除 Token。新版将扩展整体状态升级为明确的三档 `runMode: 'off' | 'companion' | 'takeover'`：

| 运行模式 | 定位与适用场景 | 主回复生成管线 | 触发器与后台 Agent 行为 |
| :--- | :--- | :--- | :--- |
| **`'off'`（已关闭）** | 临时彻底停用扩展 | 走酒馆原生管线 | **完全休眠**：不拦截生成、不过滤世界书、不触发任何前后置任务 |
| **`'companion'`（伴生触发模式 —— 不替代默认生成）** | **群聊**、极端强依赖 `@INJECT`/传统拼装的旧卡、以及习惯酒馆主面板出字的老玩家 | 放行给酒馆原生管线 | `core/` 引擎不改动，由 `src/host/` 挂载 4 个轻桥梁运行 `before_turn` / `after_turn` / `maintenance` 与伴生持久轨缓存 |
| **`'takeover'`（完全接管模式 —— 替代默认生成）** | 标准单聊、多人群像单卡、需要完整前缀 KV Cache 优化与 Pull 工具检索的场景 | `ST-Agentic` 全链路接管 | 启用三层前缀缓存、VFS 按需拉取、去重尾部雷达、0ms 占位气泡与全阶段 Agent 调度 |

**`'companion'`（伴生模式）的 4 个宿主桥接钩子**：
1. **`GENERATION_AFTER_COMMANDS`**：酒馆执行原生世界书扫描之前会 `await` 此事件，宿主在此等待上一轮尚未完成的 `barrier: 'turn'` 任务并执行本轮 `before_turn`，确保刚写入的变量与世界书覆写立刻被酒馆原生扫描读取。
2. **`WORLDINFO_ENTRIES_LOADED`**：自动剔除带有 `@@replace*` / `@@variables*` / `@@trigger` / `@@agent` / `@@tool` / `@@script` / `@@*_schema` 等控制装饰器的条目防止混入正文 Prompt，并将 `ChatDataStore` 当前 `(messageId, swipeId)` 分支的 `worldinfo` 覆写注入原生条目。
3. **注册 `{{file::path}}` 全局宏**：向酒馆宏引擎暴露只读桥接，允许原生预设或普通 WI 文本直接引用后台 Agent 维护在 VFS 的 `/memory/summary.md` 等文件。
4. **`CHARACTER_MESSAGE_RENDERED`**：酒馆原生回复渲染完成后，为该楼层气泡挂载 `<agentic-capsule>` 微组件，并异步派发 `after_turn` 与伴生轨 `maintenance`。

**`'takeover'`（完全接管模式）的 `generate_interceptor` 策略**：
1. **挂载入口**：在 `manifest.json` 注册 `generate_interceptor: "Agentic_interceptor"`（及全局函数 `globalThis.Agentic_interceptor`）。
2. **接管范围**：单聊下的 `normal`（含空类型）、`regenerate`、`swipe`、`continue`。**明确放行给 ST 原生**：`quiet`（供第三方插件后台静默调用 `/gen`）以及群聊（`selected_group` 非空；群聊如需自动化请切换 `'companion'` 模式）。
3. **解决原版硬伤（前置扫描短路与按钮不闪跳）**：拦截器调用 `abort(true)` 中止酒馆原生请求发送时，酒馆随后会执行 `unblockGeneration()` 解锁发送按钮；新版通过接管状态管理器统一维护主生成状态标志并同步恢复锁定状态，同时在接管开关开启时通过拦截早期世界书钩子短路掉酒馆在调用 `runGenerationInterceptors` 之前/期间冗余的原生全量扫描开销。

### 8.2 四种生成动作的状态机语义

| 动作类型 | 聊天数组与 DOM 处理 | 持久轨迹指针 & 暂存层行为 | 在途后台任务处理 |
| :--- | :--- | :--- | :--- |
| **`normal`** | 用户消息已由 ST 上屏；0ms 创建占位气泡时 `msg.mes` 与 `swipes[0]` 置为空串 `""`（仅在未定稿且正文与思考均空时在 DOM 视觉呈现 `'...'`），随后通过 `IncrementalOutputStreamExtractor` 实时预览 `/output.md` | 等待前序未完 `barrier: 'turn'` 任务 -> 跑 `before_turn` -> 从上一楼末尾追加 `main_turn`（强制写 `/output.md`，支持轮内 Review + `edit_file` 修错，普通 `assistant.content` 仅入轨迹与日志） | 上一楼 `self` / `none` 任务继续独立跑，不阻塞 |
| **`swipe`** | 切换到新分配的 `swipeId` 槽位，初始化 `swipes[swipeId] = ""` 与 `msg.mes = ""`（DOM 视觉呈 `'...'`） | 中止当前楼旧页关联的任务，清除旧页未提交暂存与 `InterruptedTurnCheckpoint`；将各持久 Agent 轨迹指针回拨至 `messageId - 1` 结束检查点再跑新分支 | 取消归属被切走旧 `swipeId` 的一切在途异步任务 |
| **`regenerate`** | 末条 AI 消息已由 ST 删掉；0ms 新建空串占位重绘 | 彻底清除该楼层所有暂存/已提交层、`preCreateBuffers` 与 `InterruptedTurnCheckpoint`，回拨持久轨迹指针至末条用户消息前，完整重跑 | 中止归属原末楼的一切在途后台任务 |
| **`continue`** | 保留现有末楼原文，在当前气泡原地流式更新（`StreamRenderer.bindExisting` / `continue`） | **跳过 `before_turn`**；若检测到 `trajectoryStore.getInterruptedCheckpoint(target)`，自动委托 `resumeTurn(target)`（原样复用 `completedTurnMessages` 与 `Read-Set`/`stagedSnapshot`，尾部追加 `[System Recovery]` 指令接力续写 `/output.md`）；无断点时则在分支轨迹末尾追加常规续写指令引导补全 `/output.md` | 若为断点恢复，完成后立即提交暂存并补派 `after_turn`；常规续写则保留已有媒体/数据并运行针对续写内容的 `after_turn` |

### 8.3 原生聊天 UI 零替代、流式渲染与 `<agentic-capsule>` 挂载

- **100% 保留 ST 原生聊天 UI 与插件兼容性**：`ST-Agentic` **绝不替代** SillyTavern 内置的 `#chat` 与 `.mes` DOM 结构。所有消息依然通过原生 `addOneMessage()` / `messageFormatting()` 创建与更新，完整保留原生头像、`.mes_buttons`（编辑/删除/翻译/朗读）、Swipe 左右翻页箭头及 `MESSAGE_RECEIVED` / `CHARACTER_MESSAGE_RENDERED` 事件，确保局部正则前端面板、TTS、QR 快捷回复等大量依赖原生聊天 DOM 的第三方扩展零影响运行。
- **告别工具调用期“黑屏假死”与 `/output.md` 流式解包上屏**：点击发送瞬间，原生聊天气泡立即占位渲染（存储层 `msg.mes` 与 `swipes` 保持 `""` 避免污染 `read_file('/output.md')`，仅 DOM 视觉显示 `'...'`）；大模型处于工具检索轮时气泡胶囊呈现进度反馈；调用 `write_file` / `append_file` 写入 `/output.md` 时，由 `IncrementalOutputStreamExtractor` 状态机（支持 `"path"`/`"content"` 任意键序、完整 JSON 转义及 UTF-16 代理对）实时解码正文并触发 `output_preview`，经 `StreamRenderer.setOutputPreview` + `requestAnimationFrame` 合帧节流刷入原生 `.mes_text`（同步支持流式 `<think>` / `reasoning` 折叠块与第 7.3 节瞬态 `display` 正则美化，绝不将展示正则结果写回源码）。
- **全场景可恢复中断与两段式解除锁定**：
  - `main_turn` 运行期间遭遇 `#mes_stop`（`user_stop`）、`finish_reason === 'length'`（`length`）、接口/网络错误（`error`）或自愈重试后仍未写入 `/output.md`（`empty_output`）时：`AgentRunner` 立即从 `IncrementalOutputStreamExtractor.getSalvageableOutput()` 抢救已解码半截正文落盘 `/output.md`（保留暂存写入不执行 `rollbackStagedData`），将 `completedTurnMessages`、`readSetSnapshot` 与 `stagedSnapshot` 写入 `InterruptedTurnCheckpoint` 并随 `chat_metadata.agentic_trajectories` 持久化；拦截器调用 `StreamRenderer.markInterrupted` 保存消息并解锁输入，将胶囊切为琥珀色 `'interrupted'` 状态与 `[↻ 恢复]` 按钮。点击 `[↻ 恢复]`（`services.resumeTurn` -> `resumeTakeoverTurn` -> `StreamRenderer.bindExisting` -> `orchestrator.resumeTurn`）或 ST 原生 Continue 即可在原气泡就地 100% 命中前序 KV Cache 接力恢复（支持跨页面刷新重载恢复与多次截断无限接力）；仅在彻底 0 产出中断时执行静默回滚。
  - 主正文完成后，哪怕仍有耗时的 `after_turn`（生图/视频）在后台跑，**ST 主发送框完全解锁可继续打字聊天**；用户若想单独取消某个慢任务，直接点击气泡胶囊里的独立 `[×]` 按钮即可。
- **无侵入状态胶囊 `<agentic-capsule>`**：封装为独立的 **Shadow DOM 自定义元素**，仅挂载在原生 `[mesid="N"] > .mes_block` 内且位于 `.mes_text` **外部**（支持配置置于正文上方或下方，以及任务结束后保留微缩摘要条或自动隐藏），彻底免受全局气泡美化 CSS 挤压，也不干扰正文脚本。点击胶囊本体可直接唤起大一统控制台 `<dialog>` 并定位过滤至该 `messageId` 的生成日志或 `/output.md` Diff：

```text
[检索中]  ⚡ 正在读取 /lorebooks/world/银莲花-12.md (第 2 步) ...
[流式中]  ▾ 已检索 2 份档案 · 缓存命中 95%                  （下方原生 .mes_text 流式解包 /output.md）
[已中断]  ⏸ 输出截断 · 可续写              [↻ 恢复]         （保留半截 /output.md 与断点检查点）
[已结束]  ✦ 2步 · 缓存95% · [✓变量] [🎨插图生成中 12s ×]     （点击打开控制台定位该楼）
```

---

## 9. Shadow DOM 独立大一统 `<dialog>` UI 设计（Isolated Unified Console）

原版手写 jQuery 模板直接混在酒馆宿主 DOM 中，极易被 `public/style.css` 裸标签规则与第三方美化主题污染，且弹窗套弹窗导致配置、日志、覆盖与文件编辑割裂。新版 UI 采用 **Preact（~4KB JSX 组件化，单文件打包进 `dist/index.js`，零外部运行时依赖）+ 原生 `<dialog>` + Shadow DOM 物理隔离**，将所有配置、查看、编辑与文件管理整合进**唯一一个独立渲染的全功能控制台**，同时保持对酒馆原生聊天区与入口菜单的零侵入挂载。

> 视觉与交互细则（设计令牌、组件规范、外壳布局、文案与 CSS 约定）见 [`docs/UI_DESIGN_SYSTEM.md`](./UI_DESIGN_SYSTEM.md)。本节为其上位硬性约束。

### 9.1 物理样式隔离、Dark/Light 双主题、键盘护栏与独立调试

1. **物理级 CSS 结界（Zero CSS Leakage）**：
   - 顶层容器使用原生 `<dialog id="agentic-app">`，借助浏览器原生 **Top Layer** 自动浮于酒馆任意 `z-index` 层级之上；
   - 内部挂接 `attachShadow({ mode: 'open' })`，根节点显式声明 `:host { all: initial }`，内嵌全部作用域样式表，**完全不引用酒馆 `.text_pole` / `.menu_button` / `.inline-drawer` 等外部类**，彻底隔绝宿主与美化插件的样式污染。
   - 图标采用内置轻量内联矢量 `<svg>` 图标库，不依赖宿主 FontAwesome。
2. **独立 Dark / Light 双主题系统（默认 Dark 对齐 ST）**：
   - 在 Shadow DOM `:host([data-theme="dark" | "light"])` 内维护两套完全自包含的设计系统语义色板，**默认使用 `dark` 深色主题**以契合 SillyTavern 默认暗黑界面。
   - 支持 **`themeMode: 'dark' | 'light' | 'auto'`** 三档切换（可在控制台顶栏一键切换）：`'dark'` 与 `'light'` 强制锁定主题；`'auto'` 模式下仅读取宿主 `--SmartThemeBlurTintColor` / `--SmartThemeBodyColor` 的感知亮度（Luminance）自动判定深浅，绝不引入宿主样式规则。
3. **焦点与快捷键防串台护栏**：
   - 在 `<dialog>` 宿主边界统一拦截 `keydown` / `keyup` 事件向上冒泡（`stopPropagation`），防止用户在控制台里编辑提示词、脚本或文件时按左右方向键移动光标误触发酒馆聊天区的 Swipe 翻页快捷键。
4. **脱离酒馆独立开发调试（`npm run dev:ui`）**：
   - 由于整个 `<dialog>` 仅面向抽象状态与 `HostBridge` 渲染，提供独立轻量的本地预览页面，支持脱离庞大酒馆宿主实现毫秒级热更新（HMR）调试界面与移动端视口，放回酒馆内像素级一致。

### 9.2 单窗大一统信息架构（零嵌套弹窗）与宿主无侵入入口

- **宿主页仅保留 3 个轻量挂载点**：
  - **ST 扩展设置抽屉（`#extensions_settings`）**：一行极简独立状态卡片（三档模式切换 `关闭 / 伴生 / 完全接管` + 状态灯 + **`[打开控制台]`** 按钮）；
  - **ST 输入框魔棒菜单（`#extensionsMenu`）**：延续老用户操作习惯，提供直达控制台对应标签的深链接——`文件与内容覆盖`、`查看生成日志` 以及一键触发 **`重新运行后置触发`**（当网络波动导致生图/更新失败时无需重 roll 主回复即可单独补跑）；
  - **ST 原生消息楼层（`[mesid] > .mes_block`）**：挂载 `<agentic-capsule>` 状态胶囊，点击即唤起控制台并定位到该楼层详情。
- **统一控制台 `<dialog>` 内部布局**（顶栏快捷切换运行模式 / 主连接 / 预设 / 深浅主题切换 / 导入与嵌卡操作；左侧两大分组共 **9 个一级视图**；右侧全高宽敞主画布，彻底消灭大编辑器弹窗等二次套娃弹窗）：

| 分组 | 视图模块 | 核心职能与原版功能承接 |
| :--- | :--- | :--- |
| **当前会话** | **① 文件与内容覆盖** (`Files & Overrides`) | **完整承接并升级「查看内容覆盖」**：左侧虚拟目录树（工作区 `/`、`/state/variables.json`、世界书覆写 `worldinfo`、消息展示覆写 `message`）；右侧原位全高编辑、一键复制、删除恢复原文及**世界书覆写与原书 Diff 对比** |
| **当前会话** | **② 生成与工具日志** (`Generation Logs`) | **完整承接并升级「查看生成日志」**：支持按消息楼层（如 `#12`）或全局过滤；左侧展示 `轮次 → 阶段 → 工具步` 调用树；右侧展示 `Input / Cached (命中率%) / Output Tokens`、耗时、工具入参返回值与原始 `messages` JSON 检视 |
| **当前会话** | **③ 缓存水位与存档压平** (`Cache & Storage`) | **双压缩透明控制台**：上半区展示各持久 Agent 活跃上下文 Token 水位条与 `[立即分块归档]`；下半区保留原版 `ChatDataStore` **存档冷层物理压平**（估算体积、层数、`[预览压平]` 干跑报告、`[立即压平]` 与自动压平阈值设置） |
| **预设与系统** | **④ 智能体** (`Agents`) | 合一原版 Prompt List 与 Profile：配置绑定连接（支持 `'inherit'` 主连接或副连接）、`persistent`/`ephemeral` 会话模式、模块化 `promptBlocks`（`Prefix`/`Tail` 开关与排序）、启用工具、VFS 读写目录权限与高低水位阈值 |
| **预设与系统** | **⑤ 触发管线** (`Pipeline`) | 按 `Before → Main → After → Maintenance` 四阶段泳道汇总预设触发器与当前世界书 `@@` 装饰器条目，清晰调整 `order`、`tag` 与 `barrier (turn/self/none)` 等级 |
| **预设与系统** | **⑥ 工具与脚本** (`Tools & JS`) | 管理内置工具、斜杠命令零代码工具包装及 JS `defineTool` / `@@script` 原位代码编辑，内置 **`[▶ 模拟调用测试]`** 沙箱面板直接填参试跑 |
| **预设与系统** | **⑦ 正则清洗** (`Regex`) | 管理自研预设级 `RegexRule`（`display` / `ingest` / `lore_read`），内建**样本文本实时替换对比测试框**与导入导出 |
| **预设与系统** | **⑧ 世界书路由** (`WI Router`) | 管理预设随附文件（`/preset/*`）与 **中文卡「WI 四类分流预览及手动纠偏器」** |
| **预设与系统** | **⑨ API 连接** (`Connections`) | 管理多模型连接参数、测试连通、并发上限、自定义 Header/Body YAML、`cachePolicy` 策略及 `linkedPreset` 联动 |

### 9.3 移动端一等公民适配规范（`< 768px`）

| 维度 | 桌面端 (`>= 768px`) | 移动端 (`< 768px`) 强制规范 |
| :--- | :--- | :--- |
| **窗口与导航结构** | 居中大尺寸 `<dialog>` 多栏控制台（左分组导航 + 中列表 + 右全高详情同屏） | **全屏单栏 `Master-Detail` 页面推入栈**：严格占用 `100vw × 100dvh`（监听 `visualViewport` 动态避让虚拟键盘，配合 `env(safe-area-inset-*)` 避开刘海与手势条）；顶部横向滑动分组导航；点击条目推入全屏详情页，左上角固定 `[← 返回]` 并拦截 `history.pushState` / 返回键逐级回退 |
| **触控与排序** | 鼠标点击 + 拖拽排序 | **彻底禁用依赖 `:hover` 才显露的操作**；所有按钮/开关/`[×]` 取消热区强制 **`>= 40×40px`**；排序同时提供显式 `[↑]` / `[↓]` 按钮及序号直填，禁止仅靠长按拖拽 |
| **输入法 (IME) 与编辑器** | 完整原位代码/文本编辑面板 | 所有 `<input>`、`<select>`、`<textarea>` 计算字号强制 **`>= 16px`**（根治 iOS Safari 点击输入框强制放大整页错位问题）；**严禁引入 Monaco Editor**，采用移动端原生中文 IME 100% 兼容的增强 `<textarea>` / 轻量代码输入面板，配顶部/底部一键插入模板、缩进、收起键盘触控栏 |
| **聊天内交互与性能** | 气泡顶部 `<agentic-capsule>` 展示摘要，点击唤起主控制台定位 | 气泡胶囊严格 **单行截断省略**（绝不撑爆窄屏气泡）；点击打开全屏控制台直达该楼层日志或 Diff；Shadow DOM 内部在移动端断点下自动关闭大面积多层 `backdrop-filter: blur()` 防止滚动和流式输出卡顿掉帧 |

---

## 10. 三层自动化测试体系与分阶段实施路线图（Testing & Roadmap）

### 10.1 三层测试金字塔设计

依靠第 2 章定义的 `HostBridge` 与 `LLMTransport` 隔离边界，建立三层覆盖、职责清晰的自动化测试套件：

| 层级 | 工具链与运行环境 | 覆盖范围与核心断言 | 触发频率 |
| :--- | :--- | :--- | :--- |
| **Layer 1：核心引擎与不变量测试** (`npm test`) | `Vitest`（纯 Node 运行，毫秒级，注入 `MemoryHostBridge` + `ScriptedLLMTransport`） | 1. **KV Cache 前缀逐字节不变性看门狗**：连续 15 轮对话（含工具轮、雷达提示、状态覆写、`ingest`/`display` 正则），断言 `tools` 与 `messages[0..prevLen-1]` 与前一轮逐字节相等（`ingest` 固化不破缓存）<br>2. **中文卡与正则迁移回放**：空壳卡四类分流、EJS 条件分支变化触发 `xxHash` 脏检查重读、锚点失败工具轮自愈、自研正则三阶段替换、旧版配置/嵌入数据/ST 预设自动迁移与深度忽略校验<br>3. **三级并发屏障竞态**：虚拟异步闸门验证 `turn` 阻塞下轮、`self` 串行队列不挡主聊、`none` 跨三轮精准锚点写回与单楼撤销<br>4. **Swipe/Stop 因果分支与冷层压平**：多页切页文件、持久轨迹指针完全隔离，及 `ChatDataStore` 冷层压平语义无损校验<br>5. **高低水位压缩**：跨 `H` 原子切块归档 + 折叠 + 雷达释放，下一轮立即恢复前缀不变性 | 每次提交与本地开发实时跑 |
| **Layer 2：浏览器组件与沙箱测试** (`npm run test:browser`) | `Vitest Browser Mode`（无头 Chromium） | 1. **`iframe` 沙箱契约**：禁网模式拦截 `fetch`、工具模式 `AbortSignal` 中断、销毁时清空定时器与监听防泄漏<br>2. **Shadow DOM 隔离与双视口契约**：验证宿主全局破坏性 CSS（如 `input { width: 10px !important }`）不穿透 `<dialog>` 与 `<agentic-capsule>`；验证弹窗内方向键不冒泡至宿主触发 Swipe；分别在 `1280×800` 与 `390×844` 校验 9 视图无横向溢出（`scrollWidth <= clientWidth`）、移动端推入栈导航、可点控件 `>= 40×40px` 与表单字号 `>= 16px` | 改动 `sandbox/` 或 `ui/` 后必跑 |
| **Layer 3：真实酒馆端到端冒烟** (`npm run test:e2e`) | `Playwright` + 本地百行 `Mock OpenAI SSE Server` + 真实 SillyTavern 实例 | 5 条黄金路径：① 正常发送（0ms 占位 → 胶囊更新 → 流式正文 → 异步落盘）；② Swipe/Regenerate 数据刷新；③ 中途点击 `#mes_stop` 不锁死按钮；④ 手机视口通过扩展栏/胶囊打开独立控制台改配并持久化；⑤ `'companion'` 伴生模式、`quiet` 静默请求与群聊正常运行 | 接入层改动与发版前跑 |

### 10.2 分阶段实施路线图（Milestones）

1. **M1：工程底座、防腐层、存储与正则/迁移基础**
   - 搭建 `Vitest` + `Preact` + `ESLint` 构建与测试脚本；定义 `HostBridge` / `LLMTransport`；迁移并纯化分层 `ChatDataStore`（含冷层物理压平）、VFS 挂载树及 `xxhash-wasm` 封装；落地 `src/core/regex/` 自研正则引擎及分支存储与正则固化单测。
2. **M2：三层上下文、WI 四类分流与尾部雷达**
   - 实现 `Core Manifest` 构建、`promptBlocks`（Prefix/Tail）编译、WI 四类自动分流器、VFS 读取时求值与 `Read-Set` 脏检查雷达；同步接入 **KV Cache 前缀不变性自动化测试套件** 保驾护航。
3. **M3：Agent 循环、触发器引擎与三级并发屏障**
   - 实现 `persistent` / `ephemeral` 会话管理、`ScopedToolGuard`、内置基础工具、原版 `@@` 装饰器编译器、四阶段调度器与 `turn`/`self`/`none` 三级屏障并发控制；跑通竞态单测。
4. **M4：原生 JS 运行时、旧版自动迁移与水位压缩**
   - 实现类 `JS-Slash-Runner` `defineTool` / `@@tool` / `@@script` 运行时与生命周期回收、斜杠命令工具包装、可选 `ejs-adapter`、高低水位分块压缩器，以及 `src/core/migration/` 旧版自动迁移与 ST 预设部分兼容导入器（附完整迁移单测）。
5. **M5：三档运行模式、ST 主生成接管与角色卡嵌入**
   - 实现 `st-bridge.ts`、`interceptor.ts`、`stream-renderer.ts` 与 `embed-card.ts`；打通 `'off' / 'companion' / 'takeover'` 全流程（含伴生模式 4 钩子桥接、`{{file::path}}` 宏、0ms 占位气泡与 `<agentic-capsule>` 挂载）；跑通 Playwright + Mock SSE 端到端冒烟。
6. **M6：Shadow DOM 独立大一统控制台与双态适配**
   - 落地 `dev:ui` 独立热更新入口、`<dialog id="agentic-app">` Shadow DOM 隔离壳、当前会话 3 视图（含文件/Diff、生成日志、双重压缩）+ 预设系统 6 视图（含模拟测试、正则预览、WI 分流纠偏）及全套移动端 `< 768px` 单栏页面栈；完成 Browser Mode 隔离与双视口契约验收并发布。
