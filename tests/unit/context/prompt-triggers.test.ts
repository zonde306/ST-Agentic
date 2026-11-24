import { describe, expect, it, vi } from 'vitest';
import { AssistantRunner, toAssistantThreadId } from '@/core/assistant';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
    normalizePromptBlock,
    normalizePromptTriggers,
} from '@/core/config';
import { ContextAssembler, TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import { importSillyTavernOpenAIPreset } from '@/core/migration';
import { SideGenService, toSideThreadId } from '@/core/sidegen';
import { PipelineOrchestrator } from '@/core/triggers';
import type { RawLoreEntry, Settings, TriggerRule } from '@/core/types';
import { IframeJsSandbox } from '@/sandbox';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

function writeOutputTurn(text: string, id: string = 'write_out') {
    return {
        content: '',
        toolCalls: [
            {
                id,
                name: 'write_file',
                arguments: JSON.stringify({ path: '/output.md', content: text }),
            },
        ],
    };
}

describe('PromptBlock trigger filtering (ST-native triggers compatibility)', () => {
    it('normalizes built-in triggers, ST native injection_trigger aliases, and trigger_rule IDs', () => {
        expect(normalizePromptTriggers([])).toBeUndefined();
        expect(normalizePromptTriggers(undefined)).toBeUndefined();

        expect(
            normalizePromptTriggers([
                'normal',
                'CONTINUE',
                'regenerate',
                'swipe',
                'quiet',
                'assistant_author',
                'trigger_rule:MyRule_1',
                'normal',
                '  ',
                'unknown_trigger',
            ]),
        ).toEqual([
            'main_normal',
            'main_continue',
            'main_regenerate',
            'main_swipe',
            'trigger',
            'assistant_author',
            'trigger_rule:MyRule_1',
        ]);

        const normalizedBlock = normalizePromptBlock({
            id: 'b1',
            name: 'Tagged Block',
            role: 'system',
            placement: 'tail',
            content: 'hello',
            injection_trigger: ['continue', 'assistant_chat'],
        });
        expect(normalizedBlock.triggers).toEqual(['main_continue', 'assistant_chat']);

        const untaggedBlock = normalizePromptBlock({
            id: 'b2',
            name: 'Untagged Block',
            role: 'system',
            placement: 'prefix',
            content: 'world',
            triggers: [],
        });
        expect('triggers' in untaggedBlock).toBe(false);
    });

    it('preserves ST OpenAI preset injection_trigger mappings during import', () => {
        const { preset } = importSillyTavernOpenAIPreset({
            chat_completion_source: 'openai',
            openai_model: 'gpt-4o',
            prompts: [
                {
                    identifier: 'continue-only',
                    name: '续写衔接提示',
                    role: 'system',
                    content: '继续补全上一句末尾。',
                    injection_position: 1,
                    injection_depth: 0,
                    injection_trigger: ['continue', 'quiet'],
                },
                {
                    identifier: 'always-style',
                    name: '全局文风',
                    role: 'system',
                    content: '保持细腻写实。',
                    injection_position: 0,
                    injection_depth: 4,
                    injection_trigger: [],
                },
            ],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'always-style', enabled: true },
                        { identifier: 'continue-only', enabled: true },
                    ],
                },
            ],
        });

        const blocks = preset.agents[preset.mainAgentId].promptBlocks;
        expect(blocks).toHaveLength(2);
        expect(blocks[0].triggers).toBeUndefined();
        expect(blocks[1].placement).toBe('tail');
        expect(blocks[1].triggers).toEqual(['main_continue', 'trigger']);
    });

    it('filters system_base, prefix, and tail in ContextAssembler without corrupting persistent main Layer 0', () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '林晚' },
            characterFields: { description: '调查员。' },
        });
        const assembler = new ContextAssembler();
        const trajectoryStore = new TrajectoryStore();

        const agent = createDefaultMainAgent({
            id: 'main',
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Main System Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'MAIN_ONLY_SYSTEM_BASE',
                    enabled: true,
                    triggers: ['main'],
                },
                {
                    id: 'p_untagged',
                    name: 'Untagged Prefix',
                    role: 'system',
                    placement: 'prefix',
                    content: 'UNTAGGED_PREFIX',
                    enabled: true,
                },
                {
                    id: 'p_trigger_only',
                    name: 'Trigger Prefix',
                    role: 'system',
                    placement: 'prefix',
                    content: 'TRIGGER_ONLY_PREFIX',
                    enabled: true,
                    triggers: ['trigger_before'],
                },
                {
                    id: 't_continue',
                    name: 'Continue Tail',
                    role: 'system',
                    placement: 'tail',
                    content: 'CONTINUE_ONLY_TAIL',
                    enabled: true,
                    triggers: ['main_continue'],
                },
                {
                    id: 't_normal',
                    name: 'Normal Tail',
                    role: 'system',
                    placement: 'tail',
                    content: 'NORMAL_ONLY_TAIL',
                    enabled: true,
                    triggers: ['main_normal'],
                },
            ],
        });

        // 1. Main normal turn: includes MAIN_ONLY_SYSTEM_BASE, UNTAGGED_PREFIX, NORMAL_ONLY_TAIL
        const normalCtx = assembler.assemble({
            agent,
            trajectoryStore,
            hostBridge: bridge,
            userInput: '你好',
            promptTriggerContext: { kind: 'main', action: 'normal' },
        });
        const normalLayer0Text = normalCtx.layer0Messages.map((m) => String(m.content)).join('\n');
        const normalLayer2Text = normalCtx.layer2Messages.map((m) => String(m.content)).join('\n');
        expect(normalLayer0Text).toContain('MAIN_ONLY_SYSTEM_BASE');
        expect(normalLayer0Text).toContain('UNTAGGED_PREFIX');
        expect(normalLayer0Text).not.toContain('TRIGGER_ONLY_PREFIX');
        expect(normalLayer2Text).toContain('NORMAL_ONLY_TAIL');
        expect(normalLayer2Text).not.toContain('CONTINUE_ONLY_TAIL');

        // 2. Non-main trigger_before run on the SAME persistent agent:
        //    - excludes MAIN_ONLY_SYSTEM_BASE (and does NOT fall back to defaultSystemBase)
        //    - includes TRIGGER_ONLY_PREFIX and UNTAGGED_PREFIX
        //    - does NOT overwrite main's frozen Layer 0 prefix
        const triggerCtx = assembler.assemble({
            agent,
            trajectoryStore,
            hostBridge: bridge,
            userInput: '推演本轮',
            promptTriggerContext: { kind: 'trigger', phase: 'before_turn' },
        });
        const triggerLayer0Text = triggerCtx.layer0Messages.map((m) => String(m.content)).join('\n');
        expect(triggerLayer0Text).not.toContain('MAIN_ONLY_SYSTEM_BASE');
        expect(triggerLayer0Text).not.toContain('Output Protocol:');
        expect(triggerLayer0Text).toContain('UNTAGGED_PREFIX');
        expect(triggerLayer0Text).toContain('TRIGGER_ONLY_PREFIX');

        // 3. Subsequent main continue turn still reuses main's intact frozen Layer 0 + filters Layer 2 tail
        const continueCtx = assembler.assemble({
            agent,
            trajectoryStore,
            hostBridge: bridge,
            userInput: '继续',
            promptTriggerContext: { kind: 'main', action: 'continue' },
        });
        const continueLayer0Text = continueCtx.layer0Messages.map((m) => String(m.content)).join('\n');
        const continueLayer2Text = continueCtx.layer2Messages.map((m) => String(m.content)).join('\n');
        expect(continueLayer0Text).toContain('MAIN_ONLY_SYSTEM_BASE');
        expect(continueLayer0Text).not.toContain('TRIGGER_ONLY_PREFIX');
        expect(continueLayer2Text).toContain('CONTINUE_ONLY_TAIL');
        expect(continueLayer2Text).not.toContain('NORMAL_ONLY_TAIL');
    });

    it('filters prompts across main actions, triggers, derived WI agents, and subagents in PipelineOrchestrator', async () => {
        const lorebooks: Record<string, RawLoreEntry[]> = {
            TestBook: [
                {
                    world: 'TestBook',
                    uid: 101,
                    comment: '状态变量更新',
                    content: '@@variables_json\n更新状态变量。',
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
                {
                    world: 'TestBook',
                    uid: 102,
                    comment: '考据员子智能体',
                    content: '@@agent lore_checker\n检索并返回简短设定摘要。',
                    keys: [],
                    keysecondary: [],
                    constant: true,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 4,
                    order: 20,
                    role: 0,
                },
            ],
        };

        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '林晚' },
            characterFields: { description: '调查员。' },
            lorebooks,
        });
        bridge.pushMessage({ id: 0, name: '沈默', isUser: true, mes: '检查旧仓库' });
        bridge.pushMessage({ id: 1, name: '林晚', isUser: false, mes: '', swipeId: 0 });

        const conn = createDefaultConnection({ id: 'conn', model: 'test-model', stream: false });
        const mainAgent = createDefaultMainAgent({
            id: 'main',
            connectionId: 'conn',
            sessionMode: 'persistent',
            enabledTools: ['read_file', 'write_file', 'read_variables', 'patch_variables'],
            permissions: { read: ['/**'], write: ['/memory/**', '/state/variables.json'] },
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Main Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'MAIN_BASE_UNTAGGED',
                    enabled: true,
                },
                {
                    id: 'main_normal_tail',
                    name: 'Normal Tail',
                    role: 'system',
                    placement: 'tail',
                    content: 'TAG_MAIN_NORMAL',
                    enabled: true,
                    triggers: ['main_normal'],
                },
                {
                    id: 'main_swipe_tail',
                    name: 'Swipe Tail',
                    role: 'system',
                    placement: 'tail',
                    content: 'TAG_MAIN_SWIPE',
                    enabled: true,
                    triggers: ['main_swipe'],
                },
                {
                    id: 'before_rule_prompt',
                    name: 'Before Rule Prompt',
                    role: 'system',
                    placement: 'prefix',
                    content: 'TAG_BEFORE_RULE_ONLY',
                    enabled: true,
                    triggers: ['trigger_rule:tr_before_specific'],
                },
                {
                    id: 'vars_prompt',
                    name: 'Vars Trigger Prompt',
                    role: 'system',
                    placement: 'prefix',
                    content: 'TAG_VARS_TRIGGER_ONLY',
                    enabled: true,
                    triggers: ['trigger_variables'],
                },
                {
                    id: 'subagent_prompt',
                    name: 'Subagent Prompt',
                    role: 'system',
                    placement: 'prefix',
                    content: 'TAG_SUBAGENT_ONLY',
                    enabled: true,
                    triggers: ['subagent'],
                },
            ],
        });

        const beforeAgent = createDefaultMainAgent({
            id: 'ag_before',
            connectionId: 'conn',
            sessionMode: 'ephemeral',
            enabledTools: ['read_variables'],
            permissions: { read: ['/state/variables.json'], write: [] },
            promptBlocks: [
                {
                    id: 'before_base',
                    name: 'Before Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'BEFORE_AGENT_OWN_BASE',
                    enabled: true,
                },
            ],
        });

        const triggers: TriggerRule[] = [
            {
                id: 'tr_before_specific',
                label: 'Specific Before',
                source: 'preset',
                phase: 'before_turn',
                order: 1,
                barrier: 'turn',
                agentProfileId: 'ag_before',
                kind: 'agent',
                condition: { type: 'always' },
                instructionTemplate: '生成前置简报。',
                enabled: true,
            },
        ];

        const preset = createDefaultPreset({
            id: 'p_test',
            mainAgentId: 'main',
            agents: { main: mainAgent, ag_before: beforeAgent },
            triggers,
        });

        const settings: Settings = createDefaultSettings({
            runMode: 'takeover',
            connections: { [conn.id]: conn },
            currentConnectionId: conn.id,
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport([
            // 1. before_turn: tr_before_specific
            { content: '简报内容' },
            // 2. main_turn delegates to @@agent lore_checker
            {
                content: '',
                toolCalls: [
                    {
                        id: 'call_sub_1',
                        name: 'call_agent',
                        arguments: JSON.stringify({ agent: 'lore_checker', task: '查询仓库背景' }),
                    },
                ],
            },
            // 3. subagent response
            { content: '仓库位于旧码头北侧。' },
            // 4. main_turn writes /output.md
            writeOutputTurn('调查员推开了仓库铁门。'),
            // 5. main_turn finishes
            { content: 'done' },
            // 6. after_turn: @@variables derived WI agent
            { content: '变量无需修改。' },
        ]);

        const orchestrator = new PipelineOrchestrator({
            bridge,
            transport,
            settings: () => settings,
            traceLogger: new TraceLogger(),
            sandbox: new IframeJsSandbox(),
        });

        const res = await orchestrator.runTurn({
            action: 'normal',
            target: { messageId: 1, swipeId: 0 },
            userInput: '检查旧仓库',
            stream: false,
        });

        await Promise.all(res.afterTurnTasks.map((h) => h.promise));

        expect(transport.requests.length).toBeGreaterThanOrEqual(5);

        // Request 0: before_turn (ag_before) inherited TAG_BEFORE_RULE_ONLY, NOT untagged MAIN_BASE_UNTAGGED
        const reqBefore = transport.requests[0].messages.map((m) => String(m.content)).join('\n');
        expect(reqBefore).toContain('BEFORE_AGENT_OWN_BASE');
        expect(reqBefore).toContain('TAG_BEFORE_RULE_ONLY');
        expect(reqBefore).not.toContain('MAIN_BASE_UNTAGGED');
        expect(reqBefore).not.toContain('TAG_VARS_TRIGGER_ONLY');

        // Request 1: main_turn normal
        const reqMain = transport.requests[1].messages.map((m) => String(m.content)).join('\n');
        expect(reqMain).toContain('MAIN_BASE_UNTAGGED');
        expect(reqMain).toContain('TAG_MAIN_NORMAL');
        expect(reqMain).not.toContain('TAG_MAIN_SWIPE');
        expect(reqMain).not.toContain('TAG_BEFORE_RULE_ONLY');
        expect(reqMain).not.toContain('TAG_SUBAGENT_ONLY');

        // Request 2: subagent inherited TAG_SUBAGENT_ONLY, NOT untagged MAIN_BASE_UNTAGGED
        const reqSub = transport.requests[2].messages.map((m) => String(m.content)).join('\n');
        expect(reqSub).toContain('TAG_SUBAGENT_ONLY');
        expect(reqSub).not.toContain('MAIN_BASE_UNTAGGED');
        expect(reqSub).not.toContain('TAG_MAIN_NORMAL');

        // Request 5: derived @@variables agent inherited TAG_VARS_TRIGGER_ONLY, NOT untagged MAIN_BASE_UNTAGGED
        const reqVars = transport.requests[transport.requests.length - 1].messages
            .map((m) => String(m.content))
            .join('\n');
        expect(reqVars).toContain('TAG_VARS_TRIGGER_ONLY');
        expect(reqVars).not.toContain('MAIN_BASE_UNTAGGED');
        expect(reqVars).not.toContain('TAG_BEFORE_RULE_ONLY');
    });

    it('injects matching triggered prefix and tail blocks in AssistantRunner per Workbench mode without polluting Layer 1', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: 'Author reply 1' },
            { content: 'Author reply 2' },
            { content: 'Admin reply 1' },
        ]);
        const trajectoryStore = new TrajectoryStore();

        const settings = createDefaultSettings();
        const mainAgent = settings.presets.default.agents.main;
        mainAgent.promptBlocks = [
            {
                id: 'system_base',
                name: 'Untagged Main Base',
                role: 'system',
                placement: 'prefix',
                content: 'UNTRACKED_MAIN_ONLY',
                enabled: true,
            },
            {
                id: 'ast_all_prefix',
                name: 'All Assistant Prefix',
                role: 'system',
                placement: 'prefix',
                content: 'ASSISTANT_ALL_PREFIX ({{user}})',
                enabled: true,
                triggers: ['assistant'],
            },
            {
                id: 'ast_author_tail',
                name: 'Author Mode Tail',
                role: 'system',
                placement: 'tail',
                content: 'ASSISTANT_AUTHOR_TAIL',
                enabled: true,
                triggers: ['assistant_author'],
            },
            {
                id: 'ast_admin_prefix',
                name: 'Admin Prefix',
                role: 'system',
                placement: 'prefix',
                content: 'ASSISTANT_ADMIN_PREFIX',
                enabled: true,
                triggers: ['assistant_admin'],
            },
        ];

        const runner = new AssistantRunner({
            bridge,
            transport,
            trajectoryStore,
            settings: () => settings,
            stream: false,
        });

        // Author mode session: gets ASSISTANT_ALL_PREFIX (in Layer 0) + ASSISTANT_AUTHOR_TAIL (per-request tail)
        const authorSession = await runner.createSession({
            title: '写卡测试',
            mode: 'author',
        });

        await runner.sendPrompt(authorSession.id, '帮我润色设定');
        const req1 = transport.requests[0];
        const req1PrefixTexts = req1.messages.slice(0, 2).map((m) => String(m.content));
        expect(req1PrefixTexts[1]).toContain('ASSISTANT_ALL_PREFIX');
        expect(req1PrefixTexts.join('\n')).not.toContain('UNTRACKED_MAIN_ONLY');
        expect(req1PrefixTexts.join('\n')).not.toContain('ASSISTANT_ADMIN_PREFIX');
        expect(String(req1.messages[req1.messages.length - 1].content)).toBe('ASSISTANT_AUTHOR_TAIL');
        expect(req1.cacheBreakpoints).toEqual([1]);

        // Layer 1 trajectory must NOT retain ephemeral tail prompt messages
        const authorThread = toAssistantThreadId(authorSession.id);
        const storedAuthorLayer1 = trajectoryStore.getMessages(authorThread);
        expect(storedAuthorLayer1.some((m) => String(m.content).includes('ASSISTANT_AUTHOR_TAIL'))).toBe(
            false,
        );

        await runner.sendPrompt(authorSession.id, '再来一段');
        const req2 = transport.requests[1];
        expect(String(req2.messages[1].content)).toBe(String(req1.messages[1].content));
        expect(String(req2.messages[req2.messages.length - 1].content)).toBe('ASSISTANT_AUTHOR_TAIL');

        // Full + ST Admin session: gets ASSISTANT_ALL_PREFIX + ASSISTANT_ADMIN_PREFIX, NOT ASSISTANT_AUTHOR_TAIL
        const adminSession = await runner.createSession({
            title: '管家测试',
            mode: 'full',
            stAdminEnabled: true,
        });
        await runner.sendPrompt(adminSession.id, '检查预设');
        const reqAdmin = transport.requests[2];
        const adminText = reqAdmin.messages.map((m) => String(m.content)).join('\n');
        expect(adminText).toContain('ASSISTANT_ALL_PREFIX');
        expect(adminText).toContain('ASSISTANT_ADMIN_PREFIX');
        expect(adminText).not.toContain('ASSISTANT_AUTHOR_TAIL');
        expect(adminText).not.toContain('UNTRACKED_MAIN_ONLY');
    });

    it('recomputes Workbench Prefix blocks when preset/triggers/content change or legacy frozenPrefix lacks prefixFingerprint, across send/regenerate/continue/tokenStatus', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: 'Turn 1 (before prefix configured)' },
            { content: 'Turn 2 (after switching preset with Prefix)' },
            { content: 'Turn 3 (after regenerate with updated Prefix)' },
            { content: 'Turn 4 (continued after abort with updated Prefix)' },
            { content: 'Turn 5 (after hydrating legacy frozenPrefix without fingerprint)' },
        ]);
        const trajectoryStore = new TrajectoryStore();

        const settings = createDefaultSettings();
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'prefix_untriggered',
                name: 'Initially Main-Only Prefix',
                role: 'system',
                placement: 'prefix',
                content: 'MAIN_ONLY_PREFIX',
                enabled: true,
                triggers: ['main'],
            },
            {
                id: 'tail_ast',
                name: 'Tail Block',
                role: 'system',
                placement: 'tail',
                content: 'TAIL_STILL_PRESENT',
                enabled: true,
                triggers: ['assistant'],
            },
        ];

        const runner = new AssistantRunner({
            bridge,
            transport,
            trajectoryStore,
            settings: () => settings,
            stream: false,
        });

        const session = await runner.createSession({ title: 'Prefix 失效重算测试', mode: 'chat' });

        // 1. Turn 1: no assistant-triggered Prefix blocks yet -> freezes prefix with empty extraPrefixMessages
        await runner.sendPrompt(session.id, '第一问');
        const req1Texts = transport.requests[0].messages.map((m) => String(m.content));
        expect(req1Texts.join('\n')).not.toContain('MAIN_ONLY_PREFIX');
        expect(req1Texts[req1Texts.length - 1]).toBe('TAIL_STILL_PRESENT');

        const tokensBeforePresetSwitch = runner.getSessionTokenStatus(session.id)!.currentTokens;

        // 2. Switch to a new preset ("cat_preset") that has assistant-triggered Prefix + custom JSON Prefix + Tail
        const catPreset = createDefaultPreset();
        catPreset.id = 'cat_preset';
        catPreset.name = '猫猫';
        catPreset.agents.main.promptBlocks = [
            {
                id: 'cat_think_prefix',
                name: '思考强度',
                role: 'system',
                placement: 'prefix',
                content: 'CAT_THINK_PREFIX_V1 ' + '长前缀内容'.repeat(40),
                enabled: true,
                triggers: ['main', 'assistant'],
            },
            {
                id: 'cat_custom_prefix',
                name: '主体前缀',
                role: 'custom',
                placement: 'prefix',
                content: JSON.stringify([
                    { role: 'user', content: 'CAT_CUSTOM_USER_PREFIX' },
                    { role: 'assistant', content: 'CAT_CUSTOM_MODEL_PREFIX' },
                ]),
                enabled: true,
                triggers: ['main', 'assistant'],
            },
            {
                id: 'cat_tail',
                name: '末尾结束',
                role: 'user',
                placement: 'tail',
                content: 'CAT_TAIL_END',
                enabled: true,
                triggers: ['main', 'assistant'],
            },
        ];
        settings.presets.cat_preset = catPreset;
        settings.currentPresetId = 'cat_preset';

        // getSessionTokenStatus immediately reflects the updated Prefix before sending next turn
        const tokensAfterPresetSwitch = runner.getSessionTokenStatus(session.id)!.currentTokens;
        expect(tokensAfterPresetSwitch).toBeGreaterThan(tokensBeforePresetSwitch);

        // Next sendPrompt must NOT reuse the stale empty frozenPrefix!
        await runner.sendPrompt(session.id, '第二问');
        const req2Texts = transport.requests[1].messages.map((m) => String(m.content));
        expect(req2Texts.some((t) => t.includes('CAT_THINK_PREFIX_V1'))).toBe(true);
        expect(req2Texts).toContain('CAT_CUSTOM_USER_PREFIX');
        expect(req2Texts).toContain('CAT_CUSTOM_MODEL_PREFIX');
        expect(req2Texts[req2Texts.length - 1]).toBe('CAT_TAIL_END');

        // 3. Edit Prefix block content and call regenerateLastMessage -> picks up V2 immediately
        catPreset.agents.main.promptBlocks[0].content = 'CAT_THINK_PREFIX_V2';
        await runner.regenerateLastMessage(session.id);
        const req3Texts = transport.requests[2].messages.map((m) => String(m.content));
        expect(req3Texts).toContain('CAT_THINK_PREFIX_V2');
        expect(req3Texts.some((t) => t.includes('CAT_THINK_PREFIX_V1'))).toBe(false);

        // 4. Simulate interrupted message with checkpoint, mutate Prefix trigger/content, and continueLastMessage
        const astThreadId = toAssistantThreadId(session.id);
        const currentSession = runner.getSession(session.id)!;
        const lastAssistantMsg = currentSession.messages[currentSession.messages.length - 1];
        runner.sessionStore.updateMessage(session.id, lastAssistantMsg.id, (prev) => ({
            ...prev,
            interrupted: true,
            canContinue: true,
        }));
        runner.sessionStore.setInterruptedCheckpoint(session.id, {
            messageId: lastAssistantMsg.id,
            reason: 'user_stop',
            inFlightMessages: [{ role: 'user', content: '第二问' }],
            target: { messageId: 0, swipeId: 0 },
            roundsCompleted: 1,
            createdAt: Date.now(),
        });

        catPreset.agents.main.promptBlocks[0].content = 'CAT_THINK_PREFIX_V3_CONTINUED';
        await runner.continueLastMessage(session.id);
        const req4Texts = transport.requests[3].messages.map((m) => String(m.content));
        expect(req4Texts).toContain('CAT_THINK_PREFIX_V3_CONTINUED');

        // 5. Legacy hydrated frozenPrefix lacking prefixFingerprint must be invalidated and re-rendered
        const existingFrozen = trajectoryStore.getFrozenPrefix(astThreadId)!;
        trajectoryStore.setFrozenPrefix(
            {
                tools: existingFrozen.tools,
                messages: [existingFrozen.messages[0]], // only built-in systemPrompt, no prefixFingerprint
                layer0EndIndex: 0,
            },
            astThreadId,
        );
        await runner.sendPrompt(session.id, '第五问');
        const req5Texts = transport.requests[4].messages.map((m) => String(m.content));
        expect(req5Texts).toContain('CAT_THINK_PREFIX_V3_CONTINUED');
        expect(req5Texts).toContain('CAT_CUSTOM_USER_PREFIX');
    });

    it('preserves KV-cache invariance when Prefix blocks are unchanged, and clears frozenPrefix on full retract / Turn-1 regenerate', async () => {
        const bridge = createOffMainlineTestBridge();
        let prefixEjsCount = 0;
        bridge.evaluateOptionalEjs = vi.fn(async (text: string, vars: Record<string, unknown>) => {
            if (text.includes('PREFIX_EJS')) {
                prefixEjsCount += 1;
                return text.replace('<%- PREFIX_EJS %>', `run${prefixEjsCount}:${String(vars.scene ?? 'none')}`);
            }
            return text;
        });

        const transport = new ScriptedLLMTransport([
            { content: 'Reply 1' },
            { content: 'Reply 2 (KV reused)' },
            { content: 'Reply 1 regenerated (Turn 1 fresh)' },
            { content: 'Reply after full retract' },
        ]);
        const trajectoryStore = new TrajectoryStore();

        const settings = createDefaultSettings();
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'ast_ejs_prefix',
                name: 'Static EJS Prefix',
                role: 'system',
                placement: 'prefix',
                content: 'FROZEN_PREFIX_<%- PREFIX_EJS %>',
                enabled: true,
                triggers: ['assistant'],
            },
            {
                id: 'ast_tail_only',
                name: 'Dynamic Tail',
                role: 'system',
                placement: 'tail',
                content: 'DYNAMIC_TAIL_SCENE',
                enabled: true,
                triggers: ['assistant'],
            },
        ];

        const runner = new AssistantRunner({
            bridge,
            transport,
            trajectoryStore,
            settings: () => settings,
            stream: false,
        });

        const session = await runner.createSession({ title: 'KV 缓存复用与清零测试', mode: 'chat' });
        const threadId = toAssistantThreadId(session.id);

        bridge.setVariable('scene', 's1');
        await runner.sendPrompt(session.id, 'Turn 1');
        expect(prefixEjsCount).toBe(1);
        expect(transport.requests[0].messages[1].content).toBe('FROZEN_PREFIX_run1:s1');

        // Changing runtime variable or tail block does NOT invalidate unchanged Prefix blocks
        bridge.setVariable('scene', 's2');
        settings.presets.default.agents.main.promptBlocks[1].content = 'DYNAMIC_TAIL_UPDATED';
        await runner.sendPrompt(session.id, 'Turn 2');
        expect(prefixEjsCount).toBe(1);
        expect(transport.requests[1].messages[1].content).toBe('FROZEN_PREFIX_run1:s1');
        expect(transport.requests[1].messages[transport.requests[1].messages.length - 1].content).toBe(
            'DYNAMIC_TAIL_UPDATED',
        );

        // Retract Turn 2 so only Turn 1 remains, then regenerate Turn 1 (Layer 1 becomes empty -> Prefix re-evaluates)
        const sAfterTurn2 = runner.getSession(session.id)!;
        const turn2UserMsg = sAfterTurn2.messages[2];
        await runner.retractMessage(session.id, turn2UserMsg.id);
        expect(trajectoryStore.getFrozenPrefix(threadId)).not.toBeNull();

        await runner.regenerateLastMessage(session.id);
        expect(prefixEjsCount).toBe(2);
        expect(transport.requests[2].messages[1].content).toBe('FROZEN_PREFIX_run2:s2');

        // Retracting all messages from Turn 1 clears frozenPrefix completely
        const sBeforeFullRetract = runner.getSession(session.id)!;
        await runner.retractMessage(session.id, sBeforeFullRetract.messages[0].id);
        expect(runner.getSession(session.id)!.messages).toHaveLength(0);
        expect(trajectoryStore.getFrozenPrefix(threadId)).toBeNull();

        bridge.setVariable('scene', 's3');
        await runner.sendPrompt(session.id, 'Fresh Turn 1 after retract');
        expect(prefixEjsCount).toBe(3);
        expect(transport.requests[3].messages[1].content).toBe('FROZEN_PREFIX_run3:s3');
    });

    it('injects sidegen-triggered preset blocks in SideGenService.runOnce and persistent SideSessions', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: 'once-result' },
            { content: 'session-result-1' },
            { content: 'session-result-2' },
        ]);
        const trajectoryStore = new TrajectoryStore();

        const settings = createDefaultSettings();
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'system_base',
                name: 'Main Only',
                role: 'system',
                placement: 'prefix',
                content: 'UNTRACKED_MAIN_BASE',
                enabled: true,
            },
            {
                id: 'side_prefix',
                name: 'SideGen Prefix',
                role: 'system',
                placement: 'prefix',
                content: 'SIDEGEN_PREFIX_RULE',
                enabled: true,
                triggers: ['sidegen'],
            },
            {
                id: 'side_tail',
                name: 'SideGen Tail',
                role: 'system',
                placement: 'tail',
                content: 'SIDEGEN_TAIL_RULE',
                enabled: true,
                triggers: ['sidegen'],
            },
        ];

        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            getDefaultConnectionId: () => 'default',
            getSettings: () => settings,
        });

        // 1. runOnce
        await service.runOnce({
            systemPrompt: 'ONCE_SYSTEM',
            prompt: 'ONCE_USER',
        });
        expect(transport.requests[0].messages).toEqual([
            { role: 'system', content: 'ONCE_SYSTEM' },
            { role: 'system', content: 'SIDEGEN_PREFIX_RULE' },
            { role: 'user', content: 'ONCE_USER' },
            { role: 'system', content: 'SIDEGEN_TAIL_RULE' },
        ]);

        // 2. Persistent SideSession
        const sideSession = await service.createSession({
            id: 'side_triggered',
            title: 'Side Test',
            systemPrompt: 'SIDE_SESSION_SYSTEM',
        });

        await service.send(sideSession.id, 'SIDE_TURN_1');
        expect(transport.requests[1].messages).toEqual([
            { role: 'system', content: 'SIDE_SESSION_SYSTEM' },
            { role: 'system', content: 'SIDEGEN_PREFIX_RULE' },
            { role: 'user', content: 'SIDE_TURN_1' },
            { role: 'system', content: 'SIDEGEN_TAIL_RULE' },
        ]);

        // Layer 1 does NOT store SIDEGEN_TAIL_RULE
        const storedLayer1 = trajectoryStore.getMessages(toSideThreadId(sideSession.id));
        expect(storedLayer1).toEqual([
            { role: 'user', content: 'SIDE_TURN_1' },
            { role: 'assistant', content: 'session-result-1' },
        ]);

        await service.send(sideSession.id, 'SIDE_TURN_2');
        expect(transport.requests[2].messages).toEqual([
            { role: 'system', content: 'SIDE_SESSION_SYSTEM' },
            { role: 'system', content: 'SIDEGEN_PREFIX_RULE' },
            { role: 'user', content: 'SIDE_TURN_1' },
            { role: 'assistant', content: 'session-result-1' },
            { role: 'user', content: 'SIDE_TURN_2' },
            { role: 'system', content: 'SIDEGEN_TAIL_RULE' },
        ]);
    });
});
