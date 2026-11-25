# ST-Agentic UI 设计规范（Design System v2 · "Iris"）

> 适用范围：`<dialog id="agentic-app">` Shadow DOM 控制台内的全部界面（`src/ui/**`）。
> 实现载体：`src/ui/shell/styles.ts`（唯一样式表）+ `src/ui/components/**`（基础组件）。
> 上位约束：`docs/ARCHITECTURE.md` §9（Shadow DOM 隔离、双主题、移动端红线）。本文件是 §9 的视觉与交互细则，二者冲突时以 §9 的硬性约束为准。

---

## 0. 设计定位

**精致中性风**（参考 Linear / Raycast）：灰阶承载结构，单一靛紫（Iris）强调色承载交互焦点；层级靠**底色明度差**而不是边框堆叠；信息密度高但留白克制。

### 五条设计原则

| # | 原则 | 落地要求 |
| :-- | :-- | :-- |
| 1 | **结构靠底色，不靠框** | 同一视觉层级内禁止"卡片套卡片 + 双层边框"。需要分组时优先用留白、分隔线或底色差。卡片最多嵌套 1 层。 |
| 2 | **一个视图只有一个主操作** | 每个工具栏 / 卡片头最多 1 个 `primary` 按钮；其余为 `secondary` / `ghost`；低频操作收进「更多 ⋯」菜单。 |
| 3 | **颜色只表达语义** | 强调色 = 当前选中 / 主操作 / 焦点；绿 = 成功启用；黄 = 注意；红 = 危险 / 错误。禁止为装饰而上色。 |
| 4 | **危险操作克制呈现** | 删除默认用 `ghost` 图标按钮，悬停才显红；确认弹窗中才使用实心 `danger`。禁止常驻粉红实心删除按钮。 |
| 5 | **中文优先，术语降级** | 标签使用中文业务词；英文标识符（`sessionMode`、`cachePolicy`）只出现在 hint / 等宽徽章中，不进主标签。 |

---

## 1. 设计令牌（Design Tokens）

所有颜色、圆角、阴影、字体都必须通过 CSS 自定义属性引用。**TSX inline style 与样式表中禁止出现裸 hex / rgb 颜色**（唯一例外：令牌定义处与 `<select>` 下拉箭头 data-URI）。

令牌定义于 `:host`（默认 Dark）、`:host([data-theme="dark"])`、`:host([data-theme="light"])` 三处，三处的键集合必须一致。

### 1.1 表面层级（Surface Elevation）

从低到高 5 层，层级越高越"亮"（Dark）/ 越"白"（Light）：

| 令牌 | 语义 | Dark | Light | 典型使用 |
| :-- | :-- | :-- | :-- | :-- |
| `--background` | L0 底座 | `#0e0e10` | `#ececef` | dialog backdrop 内侧、极少直接使用 |
| `--sidebar` | L1 外壳 Chrome | `#141416` | `#f4f4f6` | 顶栏、侧栏、子工具栏、模态框头尾 |
| `--content` | L2 画布 / 凹槽 | `#19191c` | `#fbfbfc` | 主画布、输入框、代码区、对话流底色 |
| `--card` | L3 表面 | `#1f1f23` | `#ffffff` | 卡片、列表项、气泡、弹层、模态框 |
| `--secondary` | 中性填充 | `#28282d` | `#efeff2` | 悬停底色、中性徽章、开关轨道 |

辅助交互令牌：

| 令牌 | Dark | Light | 说明 |
| :-- | :-- | :-- | :-- |
| `--hover` | `rgba(255,255,255,.045)` | `rgba(15,15,30,.04)` | 透明悬停层（ghost 按钮 / 导航项） |
| `--active` | `rgba(255,255,255,.07)` | `rgba(15,15,30,.06)` | 按下 / 选中的中性底 |

### 1.2 边框

| 令牌 | Dark | Light | 说明 |
| :-- | :-- | :-- | :-- |
| `--border` | `#2a2a30` | `#e3e3e8` | 默认边框（输入框、卡片外框、分隔线） |
| `--card-border` | `#25252a` | `#ececf0` | 卡片内部弱分隔 |
| `--border-strong` | `#3a3a42` | `#d0d0d8` | 悬停时的输入框 / 次要按钮边框 |

### 1.3 文本

| 令牌 | Dark | Light | 用途 |
| :-- | :-- | :-- | :-- |
| `--foreground` | `#ececf1` | `#1a1a1f` | 正文、标题 |
| `--muted-foreground` | `#a1a1ab` | `#62626d` | 次要信息、标签、说明 |
| `--subtle-foreground` | `#6c6c77` | `#9c9ca7` | 占位符、禁用、分组标题 |

### 1.4 强调色与语义色

| 令牌 | Dark | Light | 用途 |
| :-- | :-- | :-- | :-- |
| `--primary` | `#7d7bf6` | `#5753e0` | 主按钮、选中、焦点、链接 |
| `--primary-hover` | `#8e8cf8` | `#4a46d3` | 主按钮悬停 |
| `--primary-foreground` | `#ffffff` | `#ffffff` | 主色上的文字 |
| `--primary-soft` | primary 14% | primary 9% | 选中项底色、主色徽章底 |
| `--ring` | primary 55% | primary 45% | `:focus-visible` 焦点环 |
| `--success` | `#4cc38a` | `#1a8a52` | 启用 / 成功 / 命中 |
| `--warning` | `#e8a93c` | `#b5650b` | 注意 / 待审批 / 水位预警 |
| `--error` | `#f06470` | `#d3344a` | 危险 / 错误 / 删除 |

语义色的**派生规则**统一用 `color-mix`：

```css
/* 柔和底（徽章、横幅、选中） */  background: color-mix(in srgb, var(--success) 12%, transparent);
/* 柔和边 */                      border-color: color-mix(in srgb, var(--success) 30%, transparent);
/* 文字 */                        color: var(--success);
```

禁止自行发明第二种强调色；需要区分类别（例如 Prefix / Tail、四类 WI 分流）时使用 `primary / success / warning / muted` 组合，不新增色相。

### 1.5 圆角

| 令牌 | 值 | 用途 |
| :-- | :-- | :-- |
| `--radius-xs` | 4px | 行内代码、Kbd、极小标签 |
| `--radius-sm` | 6px | 徽章 / Pill、分段控件内项、菜单项 |
| `--radius-md` | 8px | 按钮、输入框、列表项 |
| `--radius-lg` | 10px | 卡片、横幅、代码块、弹出菜单 |
| `--radius-xl` | 14px | 模态框、主画布内嵌面板 |
| `--radius-window` | 16px | 控制台窗口外框（最大化 / 移动端为 0） |
| 胶囊 | 9999px | 计数徽标、开关、状态点 |

**嵌套圆角公式**：内层圆角 = 外层圆角 − 内边距（最小 4px）。

### 1.6 阴影（Elevation）

| 令牌 | 用途 |
| :-- | :-- |
| `--shadow-xs` | 分段控件选中块、开关滑块 |
| `--shadow-sm` | 卡片悬停、选中列表项 |
| `--shadow-md` | 弹出菜单、Popover、Toast |
| `--shadow-lg` | 模态框、抽屉、控制台窗口 |

Dark 主题阴影以**内描边高光 + 深阴影**组合呈现（`inset 0 1px 0 rgba(255,255,255,.04)`），Light 主题使用低透明度冷灰阴影。卡片默认**无阴影**。

### 1.7 字体与排版

```css
--font-sans: "Inter", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont,
             "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace;
```

| 级别 | 字号 / 行高 / 字重 | 用途 |
| :-- | :-- | :-- |
| Display | 18 / 26 / 600 | 空状态标题、模态框大标题（少用） |
| Title | 15 / 22 / 600 | 模态框标题、详情面板主标题 |
| Heading | 14 / 20 / 600 | 卡片标题、品牌名 |
| Body | 13 / 20 / 400 | 默认 UI 正文、按钮、列表标题（500） |
| Reading | 14 / 22 / 400 | 助手对话气泡、Markdown 正文 |
| Small | 12 / 18 / 400 | 字段标签（500）、元信息、横幅正文 |
| Caption | 11 / 16 / 500 | 徽章、分组标题、hint |
| Input | **16** / 22 / 400 | 所有 `input / select / textarea`（硬性红线，防 iOS 缩放） |

- 数字（Token 数、计数、耗时）一律 `font-variant-numeric: tabular-nums`。
- 字间距：标题 `-0.01em`；分组标题 `0.02em`；正文 0。
- 最小可读字号 **11px**，禁止使用 10px 及以下。

### 1.8 间距

4px 基准网格：`4 · 8 · 12 · 16 · 20 · 24 · 32`。

| 场景 | 规范 |
| :-- | :-- |
| 控件之间（行内） | 8px |
| 表单字段之间 | 垂直 16px，水平栅格 gap 16px |
| 字段标签 → 控件 | 6px |
| 卡片内边距 | 16px（移动端 12px） |
| 视图外边距 | 20px（移动端 12px） |
| 卡片之间 | 16px |

### 1.9 动效

| 令牌 | 值 | 用途 |
| :-- | :-- | :-- |
| `--dur-fast` | 120ms | 悬停底色、边框 |
| `--dur` | 180ms | 开关、分段控件、展开 |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | 统一缓动 |

仅对 `background-color / border-color / color / box-shadow / transform / opacity` 做过渡。遵循 `prefers-reduced-motion: reduce` 时关闭所有动画。

---

## 2. 外壳布局（Shell Anatomy）

```
┌──────────────────────────────────────────────────────────────────────┐
│ [◆ ST-Agentic]  [关闭|伴生|接管]  [⌁ 连接 ▾] [▤ 预设 ▾]   [导入] ◐ ⛶ ✕ │  ← 顶栏 52px（--sidebar）
├────────────┬─────────────────────────────────────────────────────────┤
│ 线外协作    │ ╭─────────────────────────────────────────────────────╮ │
│ ▸ 助手工作台│ │                                                     │ │
│   线外会话  │ │            主画布（--content，圆角 14px 内嵌面板）    │ │
│ 当前会话    │ │                                                     │ │
│   文件覆盖  │ │                                                     │ │
│   …        │ ╰─────────────────────────────────────────────────────╯ │
└────────────┴─────────────────────────────────────────────────────────┘
   侧栏 212px                         8px 外边距
```

### 2.1 顶栏 `.ag-header`

- 高度 52px，底色 `--sidebar`，**无底边框**（与侧栏融为一体的 Chrome）。
- 左：品牌（28px Logo 方块 + "ST-Agentic"），不再展示「Shadow DOM 隔离」等技术标签。双击品牌区切换网页全屏。
- 中：运行模式分段控件 → 上下文选择器组（连接 / 预设，各带前置图标的无边框下拉）。
- 右：`导入` ghost 按钮 → 竖向分隔 → 主题 / 全屏 / 关闭三个 40×40 图标按钮。窗口按钮使用 SVG 图标，**禁止使用 Emoji 作为图标**。

### 2.2 侧栏 `.ag-sidebar`

- 宽 212px，底色 `--sidebar`，无右边框。
- 导航项**单行**：16px 图标 + 13px 标签；模块说明移入 `title` 悬停提示。
- 状态：默认 `--muted-foreground`；悬停 `--hover` 底 + `--foreground`；选中 `--active` 底 + `--foreground` + 图标染 `--primary` + 左侧 3px 主色指示条。
- 分组标题：11px / 500 / `--subtle-foreground`，上间距 16px。
- 计数徽标：胶囊、`--warning` 柔和底。
- **折叠为图标栏**：侧栏底部固定一个「收起侧栏 / 展开侧栏」切换项（`.ag-sidebar-toggle`，`aria-expanded` + `aria-controls`），状态写入 `localStorage['st-agentic:sidebar-collapsed']`。
  - 折叠态 `.ag-sidebar[data-collapsed="true"]` 宽 60px（10px 内边距 + 40×40 热区），宽度 180ms 过渡；标签淡出但保留在 DOM 中（可访问名称与 `title` 悬停提示不变）。
  - 分组标题保持原高度、文字透明，非首组改绘 1px `--border` 细分隔线，避免折叠时纵向跳动。
  - 计数徽标在折叠态替换为图标右上角 7px `--warning` 圆点（`.ag-nav-item-dot`）。
  - 仅桌面端生效；< 768px 侧栏隐藏，改用顶部横向导航。

### 2.3 主画布 `.ag-main`

- 桌面端为内嵌面板：外边距 `0 8px 8px 0`，圆角 `--radius-xl`，1px `--border`，底色 `--content`。
- 视图内的子工具栏（如预设栏、助手顶栏）使用 `--content` 底 + 底部分隔线，不再使用第三种灰。

### 2.4 Master-Detail `.ag-split-layout`

- 左列 `minmax(240px, 32%)`，底色 `--content`，右边框分隔；右列底色 `--content`。
- 列表项：无边框表面块；悬停 `--hover`；选中 `--primary-soft` 底 + 主色 1px 内描边。
- 详情区内边距 20px，卡片间距 16px。

---

## 3. 组件规范

所有交互控件的点击热区 **≥ 40×40px**（桌面与移动端一致，见 §9.3 与浏览器测试）。视觉上可以更轻，但热区不能缩。

### 3.1 按钮 `Button`

| 变体 | 外观 | 场景 |
| :-- | :-- | :-- |
| `primary` | `--primary` 实心、白字、`--shadow-xs` | 视图唯一主操作（保存、新建、发送） |
| `secondary` | `--card` 底 + `--border` 边；悬停边框 `--border-strong` | 常规操作 |
| `ghost` | 透明；悬停 `--hover` | 工具栏图标、次要操作、关闭 |
| `danger` | 透明 + `--error` 文字；悬停 `--error` 12% 底 | 删除（列表内 / 详情头） |

- 高度 40px；水平内边距 14px（`sm`：12px）；字号 13px / 500；图标 16px，与文字间距 6px。
- 纯图标按钮：40×40 正方形，必须提供 `aria-label` 与 `title`。
- 禁用：`opacity .45`，`cursor: not-allowed`，不响应悬停。
- `active`（切换态）：`--primary-soft` 底 + `--primary` 文字。

### 3.2 输入 `TextInput / SelectInput / TextAreaInput`

- 高度 40px，圆角 `--radius-md`，底色 `--content`，1px `--border`，字号 16px。
- 悬停：边框 `--border-strong`；聚焦：边框 `--primary` + `0 0 0 3px var(--primary-soft)` 光晕。
- `<select>`：`appearance: none` + 主题化 SVG 下拉箭头（右侧 12px）。
- 占位符：`--subtle-foreground`。
- `<input type=checkbox|radio>`：`accent-color: var(--primary)`，18px。

### 3.3 表单字段 `FormField`

- 标签 12px / 500 / `--muted-foreground`；必填星号 `--error`。
- hint 11–12px / `--subtle-foreground`；错误 12px / `--error`。
- 英文字段名放入 hint，如：标签「会话轨迹模式」，hint「sessionMode · persistent 享受三层前缀缓存…」。

### 3.4 分段控件 `SegmentedControl`

- 容器：`--content` 凹槽底、`--border` 1px、圆角 `--radius-lg`、内边距 3px。
- 选中项：`--card` 表面 + `--shadow-xs` + `--foreground` 文字（**不使用主色实心块**）。
- 顶栏运行模式（`.ag-runmode`）选中项按语义染色：`off` 中性、`companion` 成功绿、`takeover` 主色，带 6px 状态圆点。

### 3.5 开关 `ToggleSwitch`

- 轨道 36×20，关闭 `--secondary`，开启 `--primary`；滑块 16px 白色 + `--shadow-xs`；热区 40px。

### 3.6 徽章 `Badge` 与 Pill

- Badge：高 20px，圆角 `--radius-sm`，11px / 500，柔和底 + 无边框（中性用 `--secondary` 底）。
- Pill：同 Badge，用于行内标签（Prefix / Tail / system）。
- 一行内徽章不超过 3 个；超过时合并为摘要文本。

### 3.7 卡片 `Card`

- 底色 `--card`，1px `--border`，圆角 `--radius-lg`，**无阴影**。
- 卡片头：内边距 `14px 16px`，透明底（不再使用灰色头部条），与正文以 `--card-border` 分隔。
- 标题 14px / 600；副标题 12px / `--muted-foreground`。
- 卡片头操作区：至多 1 个 primary + 2 个 secondary/ghost，其余进「更多」菜单。

### 3.8 列表项 `.ag-list-item`

- 无边框表面块，圆角 `--radius-md`，内边距 `10px 12px`，最小高 48px。
- 标题 13px / 500；元信息 11–12px / `--muted-foreground`，等宽 ID 使用 `--font-mono`。
- 选中：`--primary-soft` 底 + `inset 0 0 0 1px` 主色 40% 描边。

### 3.9 下拉菜单 `DropdownMenu`（新增）

- 触发器：`ghost` 或 `secondary` 按钮（默认「⋯ 更多」）。
- 面板：`--card` 底、1px `--border`、圆角 `--radius-lg`、`--shadow-md`、内边距 4px、最小宽 180px。
- 菜单项：40px 高、圆角 `--radius-sm`、13px；悬停 `--hover`；危险项 `--error` 文字，前置分隔线。
- 交互：点击外部 / `Esc` / 选择后关闭；`role="menu"` + `role="menuitem"`。

### 3.10 模态框 `ShadowModal`

- 背板：`color-mix(--background 70%, transparent)` + 桌面端 `blur(6px)`（移动端关闭模糊）。
- 面板：`--card` 底、圆角 `--radius-xl`、`--shadow-lg`。
- 头 / 尾：透明底 + 分隔线（不使用灰色头尾条），头部标题 15px / 600，关闭按钮 ghost 图标。
- 尾部按钮右对齐：次要在左、主要在右。

### 3.11 横幅 `.ag-banner`

- 圆角 `--radius-lg`，内边距 `10px 12px`，12px / 1.6；语义色 10% 底 + 左侧 3px 语义色条（不用全描边）。
- 同一视图同时出现的横幅 ≤ 2 条；纯说明性文字优先改为 hint。

**助手气泡内的状态卡片（同一横幅范式）**

| 卡片 | 类名 | 色调 | 内容 |
| :-- | :-- | :-- | :-- |
| 自动重试中 | `.ag-ast-retry-banner` | `warning` | 旋转的刷新图标 + 「正在自动重试 (n/m)…」+ 等宽错误原因 |
| 中断恢复 | `.ag-ast-continue-bar[data-tone]` | `network / empty_response / generic` → `warning`；`max_tool_rounds / length / user_stop` 及工具后无回复 → `neutral`（`--secondary` 底 + 灰色条） | 图标 + 一句话说明（句号结尾，不加 Emoji）+ `primary`「继续生成 / 继续执行」+ `ghost`「重新生成」 |
| 上下文超限 | `.ag-ast-overflow-escape` | `error` | 说明 + 压缩重试 / 撤回操作 |

- 失败原因只在气泡页脚出现**一次**（左侧状态位；有 usage 时移至右侧），不左右重复。

### 3.12 Toast

- `--card` 底、`--shadow-md`、圆角 `--radius-lg`；左侧图标染语义色；顶部居中（Header 下方）向下堆叠，最多 3 条，避免遮挡底部输入框与操作按钮。

### 3.13 代码编辑器 `CodeEditor`

- 文本区：`--content` 底、`--font-mono` 16px（移动端红线）、行高 1.6、圆角 `--radius-lg`。
- 工具栏：透明底 + ghost 小按钮，置于文本区上方，横向可滚动。
- 语言标签：Caption 级等宽徽章。

### 3.14 空状态 `EmptyState`

- 40px 圆角方块图标（`--secondary` 底 + `--muted-foreground` 图标）、标题 14px / 600、描述 12px，最大宽 360px，居中。

### 3.15 助手回复的引用文件条 `FileRefsStrip`

工具调用常一次读取十几个文件，逐个平铺会把回复撑成一大面墙。规则：

| 文件数 | 呈现 |
| :-- | :-- |
| ≤ 2 | 行内文件块：文件图标 + 目录（`--subtle-foreground`，空间不足时**目录先省略**）+ 文件名（等宽 12px） |
| > 2 | **默认折叠为单行摘要**（≤ 48px）：多文件图标 +「引用 N 个文件」+ 前 2 个文件名预览（单行省略）+ 展开箭头 |

- 展开后：`--content` 凹槽面板，`max-height: 232px` 内部滚动；按所在目录分组，组标题显示目录与数量徽标，组内只显示文件名（完整路径放 `title`）；网格 `minmax(220px, 1fr)` 自适应列数。
- 文件块无底色、弱边框，悬停显示 `--hover` 底并将图标染为主色；点击打开只读预览。
- 每条回复独立记忆展开状态；流式输出过程中保持折叠，避免列表增长导致滚动跳动。
- 测试锚点：`[data-assistant-file-refs]`、`[data-assistant-file-refs-toggle]`、`.ag-ast-file-chip[data-file-path]`。

---

## 4. 图标

- 全部使用 `src/ui/components/Icons.tsx` 内联 SVG（Lucide 风格）：24 viewBox、`stroke-width: 1.8`、`round` 端点。
- 尺寸：导航 / 按钮 16px；顶栏窗口按钮 16px；密集列表 14px。
- 颜色继承 `currentColor`；禁止 Emoji 作为功能图标（用户内容中的 Emoji 不受限）。
- **存量待迁移**：助手工作台的消息悬浮操作条（✏️ / 🔄 / ↩️ / ▶）、发送 / 停止键（▶ / ■）、审批卡片（✓ / ✕ / ↻）仍使用字符图标且被浏览器测试按文本断言；迁移时需同步更新 `tests/browser/ui/assistant-ui.test.tsx`，新增代码不得再引入此类写法。

---

## 5. 状态与反馈

| 状态 | 规范 |
| :-- | :-- |
| 焦点 | 所有可聚焦元素 `:focus-visible` → `2px solid var(--ring)`、`outline-offset: 2px`；鼠标点击不显示焦点环 |
| 加载 | 按钮内 `aria-busy` + 文字不变；区域加载使用骨架或 `--muted` 文案，不使用全屏遮罩 |
| 禁用 | `opacity .45`；保留布局，不隐藏 |
| 危险确认 | 统一走 `confirm` 模态，确认按钮 `danger` 实心（`--error` 底、白字） |
| 成功反馈 | Toast（success），不弹模态 |

---

## 6. 移动端（< 768px）

继承 `ARCHITECTURE.md` §9.3 全部红线，额外视觉规则：

- 主画布取消内嵌面板（无外边距、无圆角、无边框）；窗口 `100vw × 100dvh`。
- 顶栏分两行：第 1 行品牌 + 窗口按钮，第 2 行运行模式 + 上下文选择器（可横向换行）。
- 横向导航 `.ag-mobile-nav`：胶囊标签，选中为 `--active` 底 + `--foreground`，非主色实心。
- 关闭所有 `backdrop-filter`；阴影降一级。
- 卡片内边距 12px，视图外边距 12px。

---

## 7. 文案规范

- 按钮用**动词**开头，2–4 字：保存、新建、导入、导出、复制、删除、测试连接。
- 标签用**名词**，不加冒号；单位放 hint（如「高水位线」hint「Tokens · 达到后触发分块归档」）。
- 括号内英文 / 技术注释从标签移至 hint；徽章中的英文标识符使用等宽字体。
- 数字与单位之间留空格：`3 个积木`、`954 tok`、`51.9%`。

---

## 8. CSS 编写约定

1. 类名前缀 `ag-`，BEM-lite：`ag-<block>-<element>`、修饰符 `ag-<block>-<modifier>`；状态优先用 `data-*` / `aria-*` 属性选择器。
2. 只引用令牌：颜色、圆角、阴影、字体、时长都用 `var(--*)`。
3. TSX inline style 只允许布局属性（`flex / gap / grid / width / margin`）；颜色、边框、背景写进样式表。
4. 新增组件样式放入 `styles.ts` 对应分区，并在本文件 §3 登记。
5. 移动端覆盖统一写在文件末尾 `@media (max-width: 767px)` 区块。
6. 不得引用宿主（SillyTavern）任何类名或 CSS 变量（`auto` 主题亮度探测除外）。

---

## 9. 交付自检清单

- [ ] Dark / Light 两套主题下截图无"刺眼"大色块，主色面积 < 10%
- [ ] 每个视图只有 1 个 primary 按钮
- [ ] 无裸 hex 颜色（`rg "#[0-9a-fA-F]{3,6}" src/ui --glob '!styles.ts'`）
- [ ] 所有按钮热区 ≥ 40×40px，所有表单字段字号 ≥ 16px
- [ ] `:focus-visible` 焦点环可见，鼠标点击不残留黑框
- [ ] 390×844 视口无横向溢出
- [ ] `npm run typecheck && npm run lint && npm test` 通过；`npm run test:browser` 视口用例通过
