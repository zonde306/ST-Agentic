import { describe, expect, it } from 'vitest';
import { createDefaultConnection, createDefaultMainAgent } from '@/core/config';
import {
    ContextAssembler,
    LocalPromptInjectionSession,
    TrajectoryStore,
} from '@/core/context';
import { PayloadCompiler } from '@/core/llm';
import { TailRadar, WIClassifier } from '@/core/lore';
import { RegexPipeline } from '@/core/regex';
import type {
    AgentProfile,
    CanonicalToolSchema,
    ChatMessageSnapshot,
    RawLoreEntry,
    RegexRule,
} from '@/core/types';
import { canonicalStringify } from '@/core/utils';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

describe('ContextAssembler', () => {
    it('builds canonical sorted tools, decoupled system base, Category ① rules, Core Manifest, and prefix blocks in Layer 0', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'prefix_style',
                    name: 'Style Guard',
                    role: 'system',
                    placement: 'prefix',
                    content: '使用写实奇幻叙事风格。',
                    enabled: true,
                },
                {
                    id: 'prefix_disabled',
                    name: 'Disabled Prefix',
                    role: 'system',
                    placement: 'prefix',
                    content: 'NEVER_APPEAR',
                    enabled: false,
                },
                {
                    id: 'tail_note',
                    name: 'Tail Note',
                    role: 'system',
                    placement: 'tail',
                    content: '保持段落简洁。',
                    enabled: true,
                },
            ],
        });

        const toolsA: CanonicalToolSchema[] = [
            {
                name: 'search_files',
                description: 'Search files',
                parameters: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: { query: { type: 'string' }, limit: { type: 'number' } },
                    required: ['query'],
                },
            },
            {
                name: 'list_dir',
                description: 'List dir',
                parameters: {
                    $id: 'list_dir_schema',
                    required: ['path'],
                    properties: { path: { type: 'string' } },
                    type: 'object',
                },
            },
        ];
        // Reverse tool order & reversed JSON keys
        const toolsB: CanonicalToolSchema[] = [
            {
                description: 'List dir',
                name: 'list_dir',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
            },
            {
                name: 'search_files',
                description: 'Search files',
                parameters: {
                    required: ['query'],
                    properties: { limit: { type: 'number' }, query: { type: 'string' } },
                    type: 'object',
                },
            },
        ];

        const assembler = new ContextAssembler();
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];

        const resA = assembler.assemble({
            agent,
            tools: toolsA,
            loreEntries,
            presetFiles: { 'world-guide.md': '世界设定指南' },
            userInput: '你好',
            hostBridge: bridge,
        });
        const resB = assembler.assemble({
            agent,
            tools: toolsB,
            loreEntries,
            presetFiles: { 'world-guide.md': '世界设定指南' },
            userInput: '你好',
            hostBridge: bridge,
        });

        // Deterministic tool sorting and $schema/$id stripping
        expect(resA.request.tools.map((t) => t.name)).toEqual(['list_dir', 'search_files']);
        expect(canonicalStringify(resA.request.tools)).toBe(canonicalStringify(resB.request.tools));
        expect(resA.request.tools[0].parameters.$id).toBeUndefined();
        expect(resA.request.tools[1].parameters.$schema).toBeUndefined();

        // Layer 0 messages:
        // [0] Decoupled System Base (multi-character / world simulator safe)
        // [1] Category ① system_rule compiled block (uid 1 order 1000 before uid 2 order 950)
        // [2] Core Manifest (hollow-card compensation + /character/* + Category ② + /preset/*)
        // [3] enabled prefix PromptBlock
        expect(resA.layer0Messages).toHaveLength(4);
        expect(resA.layer0Messages[0].content).toContain('multi-character ensemble');
        expect(resA.layer0Messages[0].content).not.toContain('{{char}}');

        const rulesText = resA.layer0Messages[1].content as string;
        expect(rulesText).toContain('<system-rules>');
        expect(rulesText).toContain('冷峻克制的写实奇幻笔调');
        expect(rulesText).not.toContain('@@system');
        expect(rulesText).toContain('沈默'); // {{user}} macro substituted at Layer 0 init
        expect(rulesText.indexOf('全局文风与叙事协议')).toBeLessThan(rulesText.indexOf('输出结构与视角守则'));

        const manifestText = resA.layer0Messages[2].content as string;
        expect(resA.coreManifest.isHollowCard).toBe(true);
        expect(manifestText).toContain('世界书驱动型卡片');
        expect(manifestText).toContain('/character/description.md');
        expect(manifestText).toContain('/persona/description.md');
        expect(manifestText).toContain('/lorebooks/霜烬纪元/核心人物林晚-3.md');
        expect(manifestText).toContain('/preset/world-guide.md');

        expect(resA.layer0Messages[3].content).toBe('使用写实奇幻叙事风格。');
        expect(resA.request.messages.some((m) => String(m.content).includes('NEVER_APPEAR'))).toBe(false);

        // Cache breakpoints include Layer 0 end index (3)
        expect(resA.stats.layer0EndIndex).toBe(3);
        expect(resA.cacheBreakpoints).toEqual([3]);

        // Layer 2 contains user input + Category ④ dynamic_at_depth reminder + enabled tail block
        expect(resA.layer2Messages).toHaveLength(2);
        expect(resA.layer2Messages[0].role).toBe('user');
        expect(resA.layer2Messages[0].content).toContain('【实时状态】');
        expect(resA.layer2Messages[1]).toEqual({ role: 'system', content: '保持段落简洁。' });

        // Verify seamless compatibility with Wave 1 PayloadCompiler (Anthropic explicit breakpoints)
        const compiler = new PayloadCompiler();
        const conn = createDefaultConnection({
            providerFormat: 'anthropic',
            cachePolicy: 'anthropic_explicit',
            model: 'claude-3-7-sonnet',
        });
        const compiled = compiler.compile(resA.request, conn);
        expect(compiled.cacheBreakpointsApplied).toBeGreaterThanOrEqual(1);
    });

    it('applies ingest regex ONCE at entry before freezing into Layer 1 and never runs display regex on Layer 1', () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '剧场' },
            characterFields: {
                description:
                    '这是一段足够长且详细的世界背景描述，包含港城地理、地热能源网、各方势力关系与主要角色档案信息，超过八十个字符因此不会触发空壳角色卡补偿提示。',
            },
        });
        const store = new TrajectoryStore();
        const assembler = new ContextAssembler();
        const agent = createDefaultMainAgent();

        const regexRules: RegexRule[] = [
            {
                id: 'strip_ooc',
                name: 'Strip OOC',
                pattern: '/\\s*\\[OOC:[^\\]]*\\]/g',
                replace: '',
                stage: 'ingest',
                applyToUser: true,
                applyToAssistant: false,
                enabled: true,
            },
            {
                id: 'strip_debug',
                name: 'Strip Debug',
                pattern: '/<!--debug:[^>]*-->/g',
                replace: '',
                stage: 'ingest',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'beautify_status',
                name: 'Display Beautifier',
                pattern: '/<status>(.*?)<\\/status>/gs',
                replace: '<details class="ui-card">$1</details>',
                stage: 'display',
                applyToUser: true,
                applyToAssistant: true,
                enabled: true,
            },
        ];
        const regexPipeline = new RegexPipeline(regexRules);

        // Turn 1
        const t1 = assembler.assemble({
            agent,
            trajectoryStore: store,
            hostBridge: bridge,
            regex: regexPipeline,
            userInput: '推开酒馆门。<status>user-ui</status> [OOC: 测试备注]',
            turnBrief: '前置检查：天候多雾。',
            loreHint: '<lore-hint>\n- [未读] /lorebooks/test-1.md\n</lore-hint>',
        });

        // Ingest ran on user input; display regex MUST NOT run on Layer 2
        const t1UserContent = t1.layer2Messages[0].content as string;
        expect(t1UserContent).toContain('推开酒馆门。<status>user-ui</status>');
        expect(t1UserContent).not.toContain('[OOC:');
        expect(t1UserContent).not.toContain('<details class="ui-card">');
        expect(t1UserContent).toContain('<turn-brief>');
        expect(t1UserContent).toContain('<lore-hint>');

        // Finalize Turn 1 with assistant output containing both <!--debug--> and <status>
        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: agent.id,
            target: { messageId: 1, swipeId: 0 },
            turnMessages: t1.layer2Messages,
            finalAssistantMessage: {
                role: 'assistant',
                content: '林晚抬起头。<status>HP=100</status><!--debug:latency=12ms-->',
            },
            regex: regexPipeline,
        });

        // Layer 1 has ingest-cleaned text (no <!--debug-->) while preserving raw <status> (display never ran)
        const frozenLayer1 = store.getMessages(agent.id);
        expect(frozenLayer1).toHaveLength(2);
        expect(frozenLayer1[1].content).toBe('林晚抬起头。<status>HP=100</status>');

        // Add another ingest rule later: MUST NEVER retroactively mutate already-frozen Layer 1 messages
        regexPipeline.setRules([
            ...regexRules,
            {
                id: 'retro_strip',
                name: 'Late Ingest Rule',
                pattern: '林晚',
                replace: 'REDACTED',
                stage: 'ingest',
                applyToUser: true,
                applyToAssistant: true,
                enabled: true,
            },
        ]);

        const t2 = assembler.assemble({
            agent,
            trajectoryStore: store,
            hostBridge: bridge,
            regex: regexPipeline,
            userInput: '向林晚打招呼',
        });

        // Historical Layer 1 assistant message remains untouched; only new Turn 2 user input sees the new rule
        expect(t2.layer1Messages[1].content).toBe('林晚抬起头。<status>HP=100</status>');
        expect(t2.layer2Messages[0].content).toBe('向REDACTED打招呼');
    });

    it('supports ephemeral sessionMode with sliding ephemeralWindowSize turns and never mutates TrajectoryStore', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
        });
        const assembler = new ContextAssembler();
        const store = new TrajectoryStore();

        const ephemeralAgent: AgentProfile = createDefaultMainAgent({
            id: 'chronicler',
            name: 'Chronicler',
            sessionMode: 'ephemeral',
            ephemeralWindowSize: 2,
            promptBlocks: [],
        });

        const chatSnapshots: ChatMessageSnapshot[] = [
            { id: 0, name: 'User', isUser: true, mes: 'Turn 1 user [drop]', swipeId: 0 },
            { id: 1, name: 'Assistant', isUser: false, mes: 'Turn 1 assistant', swipeId: 0 },
            { id: 2, name: 'System', isUser: false, isSystem: true, mes: 'Hidden note', swipeId: 0 },
            { id: 3, name: 'User', isUser: true, mes: 'Turn 2 user', swipeId: 0 },
            { id: 4, name: 'Assistant', isUser: false, mes: 'Turn 2 assistant', swipeId: 0 },
            { id: 5, name: 'User', isUser: true, mes: 'Turn 3 user', swipeId: 0 },
            { id: 6, name: 'Assistant', isUser: false, mes: 'Turn 3 assistant', swipeId: 0 },
        ];

        const regex = new RegexPipeline([
            {
                id: 'r1',
                name: 'Drop tag',
                pattern: '\\s*\\[drop\\]',
                replace: '',
                stage: 'ingest',
                applyToUser: true,
                applyToAssistant: true,
                enabled: true,
            },
        ]);

        const assembled = assembler.assemble({
            agent: ephemeralAgent,
            trajectoryStore: store,
            recentChatMessages: chatSnapshots,
            hostBridge: bridge,
            regex,
            userInput: '总结最近两轮剧情并写入 /memory/summary.md',
        });

        // Sliding window of 2 turns = Turns 2 and 3 only (Turn 1 excluded, isSystem excluded)
        expect(assembled.layer1Messages.map((m) => m.content)).toEqual([
            'Turn 2 user',
            'Turn 2 assistant',
            'Turn 3 user',
            'Turn 3 assistant',
        ]);
        expect(assembled.layer2Messages[0].content).toBe('总结最近两轮剧情并写入 /memory/summary.md');
        expect(store.hasThread('chronicler')).toBe(false);
    });

    it('supports assembleWithHost auto-scanning TailRadar against TrajectoryStore Read-Set', async () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const assembler = new ContextAssembler();
        const store = new TrajectoryStore();
        const radar = TailRadar.fromBridge(bridge);
        const agent = createDefaultMainAgent();

        const first = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            userInput: '展示银莲花铜徽',
        });
        expect(first.layer2Messages[0].content).toContain('<lore-hint>');
        expect(first.layer2Messages[0].content).toContain('/lorebooks/霜烬纪元/银莲花结社档案-5.md');

        // Mark file as read with exact hash -> next scan should be silent
        const classifier = new WIClassifier();
        const classified = classifier.classifyLorebooks(await bridge.listEnabledLorebooks());
        const scan = await radar.scan(classified.all, { input: '展示银莲花铜徽' });
        store.markRead(scan.candidates[0].path, scan.candidates[0].contentHash, agent.id);

        const second = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            userInput: '再次提起银莲花',
        });
        expect(second.layer2Messages[0].content).not.toContain('<lore-hint>');
    });

    it('supports two-phase injectPrompt/getPromptsInjected (forward refs + postprocess + WI pre-collection), ST native {{outlet::key}}, and Category 1/4 EJS + @@if', async () => {
        const bridge = new MemoryHostBridge({
            ejsFeatures: { invertEnabled: true },
            ejsEvaluator: async (text, vars, opts) => {
                const session = opts?.injectionSession;
                if (text.includes('!!(')) {
                    if (text.includes('vars.neverShowOutlet')) {
                        return vars.neverShowOutlet ? 'true' : 'false';
                    }
                    if (text.includes('vars.showRule')) {
                        return vars.showRule ? 'true' : 'false';
                    }
                    if (text.includes('vars.showOutlet')) {
                        return vars.showOutlet ? 'true' : 'false';
                    }
                    return 'true';
                }
                if (text.includes('__PRE_INJECT__')) {
                    session?.injectPrompt('from_wi', 'WI-PreCollected', 10, 0, 'wi1');
                    return '';
                }
                if (text.includes('__TAIL_INJECT__')) {
                    session?.injectPrompt('forward_key', 'Tail-Part-2', 20, 0, 't2');
                    session?.injectPrompt('forward_key', 'Tail-Part-1', 10, 0, 't1');
                    return 'tail_done';
                }
                if (text.includes('__READ_FORWARD__')) {
                    const rendered = `FWD:[${session?.getPromptsInjected('forward_key', [{ search: /Tail-/g, replace: 'X-' }]) ?? ''}]|WI:[${session?.getPromptsInjected('from_wi') ?? ''}]`;
                    return text.replace('<% __READ_FORWARD__ %>', rendered);
                }
                if (text.includes('vars.dynVal')) {
                    return `DYN=${String(vars.dynVal ?? '')}`;
                }
                if (text.includes('vars.sysTag')) {
                    return `SYS=${String(vars.sysTag ?? '')}`;
                }
                if (text.includes('vars.outletTag')) {
                    return `OUTLET=${String(vars.outletTag ?? '')}`;
                }
                return text;
            },
        });

        const loreEntries: RawLoreEntry[] = [
            // [GENERATE:BEFORE] disabled in UI, enabled when invertEnabled: true
            {
                world: 'W',
                uid: 1,
                comment: '[GENERATE:BEFORE] PreInjector',
                content: '<% __PRE_INJECT__ %>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: true,
                position: 0,
                depth: 4,
                order: 100,
                role: 0,
            },
            // ST native outlet (position=7) with @@if and EJS
            {
                world: 'W',
                uid: 2,
                comment: 'Active Outlet',
                content: '@@if vars.showOutlet\n<%- vars.outletTag %>',
                keys: ['触发出口'],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 7,
                outletName: 'status_outlet',
                depth: 4,
                order: 100,
                role: 0,
            },
            // Hidden outlet gated by @@if false
            {
                world: 'W',
                uid: 3,
                comment: 'Filtered Outlet',
                content: '@@if vars.neverShowOutlet\nSHOULD_NOT_APPEAR',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 7,
                outletName: 'status_outlet',
                depth: 4,
                order: 50,
                role: 0,
            },
            // Category ① system_rule with inline EJS
            {
                world: 'W',
                uid: 4,
                comment: 'SysRule',
                content: '@@system\n<%- vars.sysTag %>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 10,
                role: 0,
            },
            // Constant entry with @@if -> conditional_dynamic in Layer 2
            {
                world: 'W',
                uid: 5,
                comment: 'DynRule',
                content: '@@if vars.showRule\n<%- vars.dynVal %>',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 0,
                depth: 4,
                order: 10,
                role: 0,
            },
        ];

        const agent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: '<% __READ_FORWARD__ %> | {{outlet::status_outlet}}',
                    enabled: true,
                },
                {
                    id: 'tail_injector',
                    name: 'Tail Injector',
                    role: 'system',
                    placement: 'tail',
                    content: '<% __TAIL_INJECT__ %>',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const store = new TrajectoryStore();
        const session = new LocalPromptInjectionSession();

        const turn1 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            loreEntries,
            injectionSession: session,
            userInput: '触发出口',
            vars: {
                showOutlet: true,
                showRule: false,
                outletTag: 'V1',
                sysTag: 'CORE',
                dynVal: 'HIDDEN',
            },
        });

        expect(turn1.layer0Messages[0].content).toBe(
            'FWD:[X-Part-1\nX-Part-2]|WI:[WI-PreCollected] | OUTLET=V1',
        );
        expect(turn1.layer0Messages[1].content).toContain('SYS=CORE');
        expect(turn1.layer2Messages[0].content).not.toContain('DYN=');
        expect(turn1.layer2Messages[1].content).toBe('tail_done');

        // Turn 2: outlet value changes -> Layer 0 automatically detects dirty fingerprint and recompiles
        const session2 = new LocalPromptInjectionSession();
        const turn2 = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            trajectoryStore: store,
            loreEntries,
            injectionSession: session2,
            userInput: '触发出口',
            vars: {
                showOutlet: true,
                showRule: true,
                outletTag: 'V2',
                sysTag: 'CORE',
                dynVal: 'VISIBLE',
            },
        });

        expect(turn2.layer0Messages[0].content).toBe(
            'FWD:[X-Part-1\nX-Part-2]|WI:[WI-PreCollected] | OUTLET=V2',
        );
        expect(turn2.layer2Messages[0].content).toContain('DYN=VISIBLE');
    });
});
