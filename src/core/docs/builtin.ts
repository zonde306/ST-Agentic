import agenticConfigDoc from './articles/agentic-config.md';
import ejsMacrosDoc from './articles/ejs-macros.md';
import ejsReferenceDoc from './articles/ejs-reference.md';
import jsToolsDoc from './articles/js-tools.md';
import scriptsDoc from './articles/scripts.md';
import stNativeDoc from './articles/st-native.md';
import statusUiDoc from './articles/status-ui.md';
import triggersDoc from './articles/triggers.md';

export type DocSource = 'builtin' | 'extension';

export interface BuiltinDocEntry {
    fileName: string;
    path: string;
    title: string;
    summary: string;
    content: string;
    source?: DocSource;
    namespace?: string;
    relPath?: string;
    includeInAssistantIndex?: boolean;
}

export const BUILTIN_DOCS: readonly BuiltinDocEntry[] = [
    {
        fileName: 'st-native.md',
        path: '/docs/st-native.md',
        title: 'SillyTavern 原生资产读写路由与三层统一变量对照',
        summary: '角色卡、世界书、正则、酒馆助手脚本、设置、消息、Slash 工具路由与三层变量映射',
        content: stNativeDoc,
        source: 'builtin',
    },
    {
        fileName: 'triggers.md',
        path: '/docs/triggers.md',
        title: '触发器与世界书 @@ 装饰器指南',
        summary: 'TriggerRule 四阶段/屏障/条件、@@trigger、全部核心与兼容 @@ 装饰器语法',
        content: triggersDoc,
        source: 'builtin',
    },
    {
        fileName: 'scripts.md',
        path: '/docs/scripts.md',
        title: '@@script 确定性脚本编写指南',
        summary: '零 Token 脚本触发器写法、沙箱全局对象、allowNetwork 与中断规范',
        content: scriptsDoc,
        source: 'builtin',
    },
    {
        fileName: 'js-tools.md',
        path: '/docs/js-tools.md',
        title: '自定义工具开发指南（JS Tool & Slash 桥接）',
        summary: 'defineTool / @@tool 写法、ctx 全量 API 速查与 slash_bridge 配置',
        content: jsToolsDoc,
        source: 'builtin',
    },
    {
        fileName: 'ejs-macros.md',
        path: '/docs/ejs-macros.md',
        title: 'EJS 模板、提示词积木、宏与 VFS 速查',
        summary: 'EJS 执行机制与变量注入、@@*_ejs、PromptBlock、宏与全量 VFS 挂载点',
        content: ejsMacrosDoc,
        source: 'builtin',
    },
    {
        fileName: 'ejs-reference.md',
        path: '/docs/ejs-reference.md',
        title: 'ST-Prompt-Template 完整 API、装饰器与标记速查',
        summary: 'EJS 全部内置函数/常量、16 个装饰器、[GENERATE]/[RENDER]/@INJECT 标记与 EjsSettings',
        content: ejsReferenceDoc,
        source: 'builtin',
    },
    {
        fileName: 'status-ui.md',
        path: '/docs/status-ui.md',
        title: '状态栏与自定义 UI 渲染指南',
        summary: '基于正则 + JS-Slash-Runner 或 @@render_after 的状态栏架构、iframe 变量与事件 API',
        content: statusUiDoc,
        source: 'builtin',
    },
    {
        fileName: 'agentic-config.md',
        path: '/docs/agentic-config.md',
        title: '修改 ST-Agentic 自身配置与预设指南',
        summary: 'agentic_config_read / agentic_settings_patch / agentic_preset_component_* / agentic_connection_upsert',
        content: agenticConfigDoc,
        source: 'builtin',
    },
];

export const BUILTIN_DOC_MAP: ReadonlyMap<string, BuiltinDocEntry> = new Map(
    BUILTIN_DOCS.map((doc) => [doc.fileName, doc]),
);

export function getBuiltinDoc(fileName: string): BuiltinDocEntry | undefined {
    const clean = fileName.replace(/^\/+/, '').replace(/^docs\//i, '');
    return BUILTIN_DOC_MAP.get(clean);
}
