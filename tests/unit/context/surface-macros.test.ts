import { describe, expect, it } from 'vitest';
import { AgentRunner } from '@/core/agents';
import { AssistantRunner } from '@/core/assistant';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
} from '@/core/config';
import {
    buildAssistantMacroOverrides,
    buildMainSurfaceMacroOverrides,
    buildModelAndBudgetMacros,
    buildSideGenMacroOverrides,
    EMPTY_TRIGGER_MACRO_DEFAULTS,
    readHostChatMacroSnapshot,
    resolveEffectiveContextBudget,
    TrajectoryStore,
} from '@/core/context';
import { SideGenService } from '@/core/sidegen';
import { PipelineOrchestrator } from '@/core/triggers';
import type { PromptBlock, RawLoreEntry } from '@/core/types';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

function createMacroAuditTemplate(extraFields?: Record<string, string>): string {
    const lines = [
        'lastUser={{lastUserMessage}}',
        'lastUserLower={{lastusermessage}}',
        'lastChar={{lastCharMessage}}',
        'lastMsg={{lastMessage}}',
        'lastId={{lastMessageId}}',
        'range={{allChatRange}}',
        'firstInc={{firstIncludedMessageId}}',
        'firstDisp={{firstDisplayedMessageId}}',
        'lastSwipe={{lastSwipeId}}',
        'currSwipe={{currentSwipeId}}',
        'genType={{lastGenerationType}}',
        'lastIn={{lastInput}}',
        'surface={{agenticSurface}}',
        'model={{model}}',
        'maxCtx={{maxContext}}',
        'maxCtxTokens={{maxContextTokens}}',
        'maxResp={{maxResponse}}',
        'maxRespTokens={{maxResponseTokens}}',
        'maxPrompt={{maxPrompt}}',
        'maxPromptTokens={{maxPromptTokens}}',
        'varGold={{getvar::gold}}',
        'stUser={{stLastUserMessage}}',
        'stChar={{stLastCharMessage}}',
        'stMsg={{stLastMessage}}',
        'stId={{stLastMessageId}}',
    ];
    if (extraFields) {
        for (const [k, v] of Object.entries(extraFields)) {
            lines.push(`${k}=${v}`);
        }
    }
    return lines.join('\n');
}

function parseAuditLines(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx > 0) {
            out[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
        }
    }
    return out;
}

describe('surface-scoped macro helpers & end-to-end integration', () => {
    it('builds scoped macro snapshots and overrides across main, assistant, and sidegen builders', () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Traveler', charName: 'Aria' },
            chat: [
                { id: 0, name: 'Traveler', isUser: true, mes: 'ST user 0', swipeId: 0 },
                { id: 1, name: 'Narrator', isUser: false, isSystem: true, mes: 'System note', swipeId: 0 },
                { id: 2, name: 'Aria', isUser: false, mes: 'ST char 2', swipeId: 0 },
                { id: 3, name: 'Traveler', isUser: true, mes: 'ST user 3', swipeId: 0 },
            ],
        });

        expect(readHostChatMacroSnapshot(bridge)).toEqual({
            stLastMessage: 'ST user 3',
            stLastMessageId: '3',
            stLastUserMessage: 'ST user 3',
            stLastCharMessage: 'ST char 2',
        });

        const connection = createDefaultConnection({
            id: 'conn_1',
            model: 'claude-sonnet-4-20250514',
            contextSize: 64000,
            maxTokens: 4000,
        });
        const budget = resolveEffectiveContextBudget(connection);
        expect(buildModelAndBudgetMacros(connection, budget)).toEqual({
            model: 'claude-sonnet-4-20250514',
            maxContext: '64000',
            maxContextTokens: '64000',
            maxResponse: '4000',
            maxResponseTokens: '4000',
            maxPrompt: '60000',
            maxPromptTokens: '60000',
        });

        // Empty assistant session fallback
        const emptyAssistant = buildAssistantMacroOverrides({
            session: { mode: 'chat', messages: [] },
            bridge,
            connection,
            budget,
            vars: { gold: 42 },
        });
        expect(emptyAssistant.lastUserMessage).toBe('');
        expect(emptyAssistant.lastMessageId).toBe('');
        expect(emptyAssistant.allChatRange).toBe('');
        expect(emptyAssistant.stLastUserMessage).toBe('ST user 3');
        expect(emptyAssistant.stLastCharMessage).toBe('ST char 2');
        expect(emptyAssistant.agenticSurface).toBe('assistant');
        expect(emptyAssistant.assistantMode).toBe('chat');
        expect(emptyAssistant['var:gold']).toBe('42');
        expect(emptyAssistant.triggerPrompt).toBe('');
        expect(emptyAssistant.triggerLabel).toBe('');
        expect(emptyAssistant.triggerId).toBe('');
        expect(emptyAssistant.triggerPhase).toBe('');
        expect(emptyAssistant.triggerTargetPath).toBe('');

        // Populated assistant session excluding pending empty assistant bubble + empty resume prompt
        const populatedAssistant = buildAssistantMacroOverrides({
            session: {
                mode: 'author',
                messages: [
                    { id: 'm1', role: 'user', content: 'WB User 1', timestamp: 1 },
                    { id: 'm2', role: 'assistant', content: 'WB Assistant 1', timestamp: 2 },
                    { id: 'm3', role: 'user', content: 'WB User 2', timestamp: 3 },
                    { id: 'm4', role: 'assistant', content: '', timestamp: 4 },
                ],
            },
            bridge,
            excludeMessageId: 'm4',
            currentUserInput: '',
            generationType: 'continue',
            connection,
            budget,
        });
        expect(populatedAssistant.lastUserMessage).toBe('WB User 2');
        expect(populatedAssistant.lastCharMessage).toBe('WB Assistant 1');
        expect(populatedAssistant.lastMessage).toBe('WB User 2');
        expect(populatedAssistant.lastMessageId).toBe('2');
        expect(populatedAssistant.allChatRange).toBe('0-2');
        expect(populatedAssistant.lastInput).toBe('WB User 2');
        expect(populatedAssistant.lastGenerationType).toBe('continue');
        expect(populatedAssistant.assistantMode).toBe('author');

        // SideGen skips tool messages and tool-only assistant messages
        const sideOverrides = buildSideGenMacroOverrides({
            mode: 'session',
            historyMessages: [
                { role: 'user', content: 'Side U1' },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{}' }],
                },
                { role: 'tool', toolCallId: 'tc1', toolName: 'read_file', content: 'ignored' },
                { role: 'assistant', content: 'Side A1' },
            ],
            currentPrompt: 'Side U2',
            bridge,
            connection,
            budget,
        });
        expect(sideOverrides.lastUserMessage).toBe('Side U2');
        expect(sideOverrides.lastCharMessage).toBe('Side A1');
        expect(sideOverrides.lastMessage).toBe('Side U2');
        expect(sideOverrides.lastMessageId).toBe('2');
        expect(sideOverrides.allChatRange).toBe('0-2');
        expect(sideOverrides.agenticSurface).toBe('sidegen');
        expect(sideOverrides.lastGenerationType).toBe('normal');
        expect(sideOverrides.triggerPrompt).toBe('');

        // Main chat preserves callerOverrides precedence and defaults trigger macros to ''
        const mainOverrides = buildMainSurfaceMacroOverrides({
            bridge,
            userInput: 'Main fresh input',
            connection,
            budget,
            callerOverrides: { lastInput: 'Caller Override Input' },
        });
        expect(mainOverrides.agenticSurface).toBe('main');
        expect(mainOverrides.lastInput).toBe('Caller Override Input');
        expect(mainOverrides.stLastUserMessage).toBe('ST user 3');
        expect(mainOverrides.lastUserMessage).toBeUndefined();
        expect(mainOverrides).toMatchObject(EMPTY_TRIGGER_MACRO_DEFAULTS);
    });

    it('scopes macros to Workbench across Turn 1, Turn 2, regenerate, and checkpoint continue while preventing cascading expansion', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '雾港守夜人' },
            chat: [
                { id: 0, name: '旅人', isUser: true, mes: 'ST_MAIN_USER_OLD', swipeId: 0 },
                { id: 1, name: '雾港守夜人', isUser: false, mes: 'ST_MAIN_CHAR_LAST', swipeId: 0 },
                { id: 2, name: '旅人', isUser: true, mes: 'ST_MAIN_USER_LAST', swipeId: 0 },
            ],
            metadata: {
                variables: { gold: 99 },
            },
        });

        const settings = createDefaultSettings();
        const conn = createDefaultConnection({
            id: 'wb-conn',
            model: 'claude-3-7-sonnet',
            contextSize: 32000,
            maxTokens: 2048,
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        settings.connections['wb-conn'] = conn;
        settings.currentConnectionId = 'wb-conn';

        const preset = settings.presets[settings.currentPresetId];
        const mainAgent = preset.agents[preset.mainAgentId];
        const tailBlock: PromptBlock = {
            id: 'wb_macro_tail',
            name: 'WB Macro Audit Tail',
            role: 'system',
            placement: 'floating_tail',
            enabled: true,
            triggers: ['assistant'],
            content: createMacroAuditTemplate({ assistantMode: '{{assistantMode}}' }),
        };
        mainAgent.promptBlocks = [tailBlock];

        const expectedBudget = resolveEffectiveContextBudget(conn);
        const expectedMaxPrompt = String(
            expectedBudget.contextLimit - expectedBudget.reservedOutputTokens,
        );

        const transport = new ScriptedLLMTransport([
            // Turn 1
            { content: 'WB_REPLY_1' },
            // Turn 2 (user sends literal {{model}} inside prompt to verify single-pass safety)
            { content: 'WB_REPLY_2' },
            // Regenerate Turn 2
            { content: 'WB_REPLY_2_REGEN' },
            // Interrupted Turn 3 (tool call reaches maxToolRounds=1) -> Continue
            {
                toolCalls: [
                    {
                        id: 'tc_cap',
                        name: 'list_dir',
                        arguments: JSON.stringify({ path: '/character' }),
                    },
                ],
            },
            { content: 'WB_REPLY_3_CONTINUED' },
        ]);

        const runner = new AssistantRunner({
            bridge,
            transport,
            trajectoryStore: new TrajectoryStore(),
            settings,
            stream: false,
            maxToolRounds: 1,
            autoRetry: false,
        });

        const session = await runner.createSession({
            title: '宏兼容测试会话',
            mode: 'chat',
            connectionId: 'wb-conn',
        });

        // Turn 1
        await runner.sendPrompt(session.id, 'WB_USER_1');
        const req1Tail = parseAuditLines(
            String(transport.requests[0].messages[transport.requests[0].messages.length - 1].content),
        );
        expect(req1Tail).toEqual({
            lastUser: 'WB_USER_1',
            lastUserLower: 'WB_USER_1',
            lastChar: '',
            lastMsg: 'WB_USER_1',
            lastId: '0',
            range: '0-0',
            firstInc: '0',
            firstDisp: '0',
            lastSwipe: '1',
            currSwipe: '1',
            genType: 'normal',
            lastIn: 'WB_USER_1',
            surface: 'assistant',
            model: 'claude-3-7-sonnet',
            maxCtx: String(expectedBudget.contextLimit),
            maxCtxTokens: String(expectedBudget.contextLimit),
            maxResp: String(expectedBudget.reservedOutputTokens),
            maxRespTokens: String(expectedBudget.reservedOutputTokens),
            maxPrompt: expectedMaxPrompt,
            maxPromptTokens: expectedMaxPrompt,
            varGold: '99',
            stUser: 'ST_MAIN_USER_LAST',
            stChar: 'ST_MAIN_CHAR_LAST',
            stMsg: 'ST_MAIN_USER_LAST',
            stId: '2',
            assistantMode: 'chat',
        });

        // Turn 2 with literal {{model}} inside user input (must stay literal!)
        await runner.sendPrompt(session.id, 'Check literal {{model}} text');
        const req2Tail = parseAuditLines(
            String(transport.requests[1].messages[transport.requests[1].messages.length - 1].content),
        );
        expect(req2Tail.lastUser).toBe('Check literal {{model}} text');
        expect(req2Tail.lastChar).toBe('WB_REPLY_1');
        expect(req2Tail.lastMsg).toBe('Check literal {{model}} text');
        expect(req2Tail.lastId).toBe('2');
        expect(req2Tail.range).toBe('0-2');
        expect(req2Tail.genType).toBe('normal');
        expect(req2Tail.lastIn).toBe('Check literal {{model}} text');
        expect(req2Tail.model).toBe('claude-3-7-sonnet');

        // Regenerate Turn 2: truncated WB_REPLY_2 must NOT show up as lastChar; generationType='regenerate'
        await runner.regenerateLastMessage(session.id);
        const req3Tail = parseAuditLines(
            String(transport.requests[2].messages[transport.requests[2].messages.length - 1].content),
        );
        expect(req3Tail.lastUser).toBe('Check literal {{model}} text');
        expect(req3Tail.lastChar).toBe('WB_REPLY_1');
        expect(req3Tail.lastId).toBe('2');
        expect(req3Tail.genType).toBe('regenerate');

        // Turn 3 hits maxToolRounds=1 checkpoint, then continueLastMessage passes internal prompt=''
        const capped = await runner.sendPrompt(session.id, 'WB_USER_3_TRIGGER');
        expect(capped.interrupted).toBe(true);
        const req4Tail = parseAuditLines(
            String(transport.requests[3].messages[transport.requests[3].messages.length - 1].content),
        );
        expect(req4Tail.lastUser).toBe('WB_USER_3_TRIGGER');
        expect(req4Tail.lastChar).toBe('WB_REPLY_2_REGEN');
        expect(req4Tail.lastId).toBe('4');

        const continued = await runner.continueLastMessage(session.id);
        expect(continued.content).toBe('WB_REPLY_3_CONTINUED');
        const req5Tail = parseAuditLines(
            String(transport.requests[4].messages[transport.requests[4].messages.length - 1].content),
        );
        expect(req5Tail.lastUser).toBe('WB_USER_3_TRIGGER');
        expect(req5Tail.lastChar).toBe('WB_REPLY_2_REGEN');
        expect(req5Tail.lastId).toBe('4');
        expect(req5Tail.lastIn).toBe('WB_USER_3_TRIGGER');
        expect(req5Tail.genType).toBe('continue');
    });

    it('scopes macros to SideGen runOnce (quiet) and SideSession send (normal) while exposing stLast* and var:*', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '向导' },
            chat: [
                { id: 0, name: '向导', isUser: false, mes: 'ST_CHAR_0', swipeId: 0 },
                { id: 1, name: '旅人', isUser: true, mes: 'ST_USER_1', swipeId: 0 },
            ],
            metadata: {
                variables: { gold: 777 },
            },
        });

        const settings = createDefaultSettings();
        const sideConn = createDefaultConnection({
            id: 'side-conn',
            model: 'gemini-2.5-flash',
            contextSize: 48000,
            maxTokens: 3000,
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        settings.connections['side-conn'] = sideConn;

        const preset = settings.presets[settings.currentPresetId];
        const mainAgent = preset.agents[preset.mainAgentId];
        mainAgent.promptBlocks = [
            {
                id: 'side_tail',
                name: 'Side Audit Tail',
                role: 'system',
                placement: 'tail',
                enabled: true,
                triggers: ['sidegen'],
                content: createMacroAuditTemplate(),
            },
        ];

        const transport = new ScriptedLLMTransport([
            { content: 'ONCE_OUT' },
            { content: 'SIDE_SESS_REPLY_1' },
            { content: 'SIDE_SESS_REPLY_2' },
        ]);
        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore: new TrajectoryStore(),
            getDefaultConnectionId: () => 'side-conn',
            getSettings: () => settings,
            resolveConnection: (id) => settings.connections[id],
        });

        await service.runOnce({
            systemPrompt: 'Side once system.',
            prompt: 'SIDE_ONCE_PROMPT',
            connectionId: 'side-conn',
        });
        const onceTail = parseAuditLines(
            String(transport.requests[0].messages[transport.requests[0].messages.length - 1].content),
        );
        expect(onceTail.lastUser).toBe('SIDE_ONCE_PROMPT');
        expect(onceTail.lastChar).toBe('');
        expect(onceTail.lastId).toBe('0');
        expect(onceTail.range).toBe('0-0');
        expect(onceTail.genType).toBe('quiet');
        expect(onceTail.surface).toBe('sidegen');
        expect(onceTail.model).toBe('gemini-2.5-flash');
        expect(onceTail.varGold).toBe('777');
        expect(onceTail.stUser).toBe('ST_USER_1');
        expect(onceTail.stChar).toBe('ST_CHAR_0');

        const sess = await service.createSession({
            title: 'Side Macro Session',
            systemPrompt: 'Side session sys.',
            connectionId: 'side-conn',
        });
        await service.send(sess.id, 'SIDE_TURN_1');
        const sess1Tail = parseAuditLines(
            String(transport.requests[1].messages[transport.requests[1].messages.length - 1].content),
        );
        expect(sess1Tail.lastUser).toBe('SIDE_TURN_1');
        expect(sess1Tail.lastChar).toBe('');
        expect(sess1Tail.genType).toBe('normal');

        await service.send(sess.id, 'SIDE_TURN_2');
        const sess2Tail = parseAuditLines(
            String(transport.requests[2].messages[transport.requests[2].messages.length - 1].content),
        );
        expect(sess2Tail.lastUser).toBe('SIDE_TURN_2');
        expect(sess2Tail.lastChar).toBe('SIDE_SESS_REPLY_1');
        expect(sess2Tail.lastId).toBe('2');
        expect(sess2Tail.range).toBe('0-2');
        expect(sess2Tail.genType).toBe('normal');
    });

    it('provides Main Chat surface defaults in AgentRunner while letting caller macroOverrides win', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Player', charName: 'Companion' },
            chat: [
                { id: 0, name: 'Companion', isUser: false, mes: 'ST_COMPANION_0', swipeId: 0 },
                { id: 1, name: 'Player', isUser: true, mes: 'ST_PLAYER_1', swipeId: 0 },
            ],
        });

        const agent = createDefaultMainAgent({
            strictToolLoop: 'off',
            promptBlocks: [
                {
                    id: 'main_surface_tail',
                    name: 'Main Surface Tail',
                    role: 'system',
                    placement: 'floating_tail',
                    enabled: true,
                    content: [
                        'surface={{agenticSurface}}',
                        'lastInput={{lastInput}}',
                        'lastUser={{lastUserMessage}}',
                        'stUser={{stLastUserMessage}}',
                        'model={{model}}',
                        'maxCtx={{maxContext}}',
                    ].join('\n'),
                },
            ],
        });
        const connection = createDefaultConnection({
            id: 'main_conn',
            model: 'gpt-4.1',
            contextSize: 128000,
            maxTokens: 4096,
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const preset = createDefaultPreset({ agents: { main: agent } });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport([
            { content: 'Main output 1' },
            { content: 'Main output 2' },
        ]);
        const runner = new AgentRunner({
            bridge,
            transport,
            settings,
            trajectoryStore: new TrajectoryStore(),
        });

        await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Live Main Turn Input',
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        const req1Tail = parseAuditLines(
            String(transport.requests[0].messages[transport.requests[0].messages.length - 1].content),
        );
        expect(req1Tail).toEqual({
            surface: 'main',
            lastInput: 'Live Main Turn Input',
            lastUser: 'ST_PLAYER_1',
            stUser: 'ST_PLAYER_1',
            model: 'gpt-4.1',
            maxCtx: '128000',
        });

        // Explicit caller macroOverrides must take precedence over surface defaults
        await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 1, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Turn 2',
            macroOverrides: {
                lastInput: 'CUSTOM_OVERRIDE_INPUT',
                lastUserMessage: 'CALLER_USER_MSG',
            },
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        const req2Tail = parseAuditLines(
            String(transport.requests[1].messages[transport.requests[1].messages.length - 1].content),
        );
        expect(req2Tail.lastInput).toBe('CUSTOM_OVERRIDE_INPUT');
        expect(req2Tail.lastUser).toBe('CALLER_USER_MSG');
        expect(req2Tail.surface).toBe('main');
    });

    it('defaults {{triggerPrompt}} and trigger metadata macros to empty string in non-trigger runs', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Player', charName: 'Companion' },
            chat: [{ id: 0, name: 'Player', isUser: true, mes: 'Hi', swipeId: 0 }],
        });

        const agent = createDefaultMainAgent({
            strictToolLoop: 'off',
            promptBlocks: [
                {
                    id: 'non_trigger_block',
                    name: 'Non-Trigger Block',
                    role: 'system',
                    placement: 'floating_tail',
                    enabled: true,
                    content:
                        'macros={{triggerPrompt}}|{{triggerLabel}}|{{triggerId}}|{{triggerPhase}}|{{triggerTargetPath}}',
                },
            ],
        });
        const connection = createDefaultConnection({
            id: 'conn_nontrig',
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const preset = createDefaultPreset({ agents: { main: agent } });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport([{ content: 'Main done' }]);
        const runner = new AgentRunner({
            bridge,
            transport,
            settings,
            trajectoryStore: new TrajectoryStore(),
        });

        await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 0, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Hi',
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        const tailContent = String(
            transport.requests[0].messages[transport.requests[0].messages.length - 1].content,
        );
        expect(tailContent).toBe('macros=||||');
    });

    it('populates {{triggerPrompt}} and metadata macros from WI trigger entries in single and grouped PipelineOrchestrator runs', async () => {
        const singleWiEntry: RawLoreEntry = {
            world: 'StateBook',
            uid: 101,
            comment: 'HP Tracker',
            content: '@@variables_json\n@@group isolate\nUpdate {{char}} HP based on the latest scene.',
            keys: [],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 1,
            role: 0,
        };
        const groupedEntryA: RawLoreEntry = {
            world: 'ComboBook',
            uid: 201,
            comment: 'Task Alpha',
            content: '@@trigger phase=after_turn group=combo\nInspect mood of {{char}}.',
            keys: [],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 2,
            role: 0,
        };
        const groupedEntryB: RawLoreEntry = {
            world: 'ComboBook',
            uid: 202,
            comment: 'Task Beta',
            content: '@@trigger phase=after_turn group=combo\nInspect inventory of {{user}}.',
            keys: [],
            keysecondary: [],
            constant: true,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 2,
            role: 0,
        };

        const bridge = new MemoryHostBridge({
            identity: { userName: 'Traveler', charName: 'Aria' },
            chat: [
                { id: 0, name: 'Traveler', isUser: true, mes: 'I check the potion.', swipeId: 0 },
                { id: 1, name: 'Aria', isUser: false, mes: 'Aria takes the potion.', swipeId: 0 },
            ],
            lorebooks: {
                StateBook: [singleWiEntry],
                ComboBook: [groupedEntryA, groupedEntryB],
            },
        });

        const connection = createDefaultConnection({
            id: 'conn_trig',
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const mainAgent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'trigger_tail_audit',
                    name: 'Trigger Tail Audit',
                    role: 'system',
                    placement: 'floating_tail',
                    enabled: true,
                    triggers: ['trigger'],
                    content: [
                        'LABEL={{triggerLabel}}',
                        'ID={{triggerId}}',
                        'PHASE={{triggerPhase}}',
                        'TARGET={{triggerTargetPath}}',
                        'PROMPT_START',
                        '{{triggerPrompt}}',
                        'PROMPT_END',
                    ].join('\n'),
                },
            ],
        });
        const preset = createDefaultPreset({
            agents: { main: mainAgent },
        });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport([
            { content: 'Single trigger done' },
            { content: 'Grouped trigger done' },
        ]);
        const orchestrator = new PipelineOrchestrator({
            bridge,
            transport,
            settings: () => settings,
        });

        const handles = await orchestrator.rerunAfterTurn({ messageId: 1, swipeId: 0 });
        await Promise.all(handles.map((h) => h.promise));

        expect(transport.requests).toHaveLength(2);

        const singleTail = String(
            transport.requests.find((r) => String(r.messages[r.messages.length - 1].content).includes('LABEL=HP Tracker'))
                ?.messages.slice(-1)[0].content ?? '',
        );
        expect(singleTail).toContain('LABEL=HP Tracker');
        expect(singleTail).toContain('ID=wi_StateBook_101');
        expect(singleTail).toContain('PHASE=after_turn');
        expect(singleTail).toContain('TARGET=/state/variables.json');
        expect(singleTail).toContain('PROMPT_START\nUpdate Aria HP based on the latest scene.\nPROMPT_END');
        expect(singleTail).not.toContain('Target VFS Path:');
        expect(singleTail).not.toContain('Latest User Input:');
        expect(singleTail).not.toContain('Latest Assistant Output:');

        const groupedTail = String(
            transport.requests.find((r) => String(r.messages[r.messages.length - 1].content).includes('ID=wi_ComboBook_201,wi_ComboBook_202'))
                ?.messages.slice(-1)[0].content ?? '',
        );
        expect(groupedTail).toContain('PHASE=after_turn');
        expect(groupedTail).toContain('Inspect mood of Aria.');
        expect(groupedTail).toContain('Inspect inventory of Traveler.');
        expect(groupedTail).not.toContain('Latest User Input:');
    });

    it('populates {{triggerPrompt}} and {{triggerLabel}} from @@agent WI entry instructions during subagent delegation', async () => {
        const archivistEntry: RawLoreEntry = {
            world: 'Lore',
            uid: 50,
            comment: 'Archivist Agent',
            content: '@@agent archivist\nInspect /lorebooks/ and return only verified facts.',
            keys: [],
            keysecondary: [],
            constant: false,
            selective: false,
            disable: false,
            position: 0,
            depth: 0,
            order: 1,
            role: 0,
        };
        const bridge = new MemoryHostBridge({
            identity: { userName: 'Traveler', charName: 'Guide' },
            chat: [{ id: 0, name: 'Traveler', isUser: true, mes: 'Check lore', swipeId: 0 }],
            lorebooks: { Lore: [archivistEntry] },
        });
        const agent = createDefaultMainAgent({
            strictToolLoop: 'off',
            promptBlocks: [
                {
                    id: 'subagent_prompt_audit',
                    name: 'Subagent Prompt Audit',
                    role: 'system',
                    placement: 'floating_tail',
                    enabled: true,
                    triggers: ['subagent'],
                    content:
                        'SUB_LABEL={{triggerLabel}}|SUB_ID={{triggerId}}|SUB_PROMPT={{triggerPrompt}}',
                },
            ],
        });
        const connection = createDefaultConnection({
            id: 'conn_sub',
            strictToolLoop: false,
            roundMaxRetries: 0,
        });
        const preset = createDefaultPreset({ agents: { main: agent } });
        const settings = createDefaultSettings({
            currentConnectionId: connection.id,
            connections: { [connection.id]: connection },
            presets: { [preset.id]: preset },
            currentPresetId: preset.id,
        });

        const transport = new ScriptedLLMTransport([
            {
                toolCalls: [
                    {
                        id: 'call_sub_1',
                        name: 'delegate_agent_archivist',
                        arguments: JSON.stringify({ task: 'Find archive facts' }),
                    },
                ],
            },
            { content: 'Verified child fact.' },
            { content: 'Parent finished.' },
        ]);
        const runner = new AgentRunner({
            bridge,
            transport,
            settings,
            trajectoryStore: new TrajectoryStore(),
        });

        const res = await runner.run({
            agent,
            preset,
            connection,
            target: { messageId: 0, swipeId: 0 },
            phase: 'main_turn',
            userInput: 'Check lore',
            requireOutputFile: false,
            runTailRadar: false,
            includeCategory4DynamicEntries: false,
        });

        expect(res.content).toBe('Parent finished.');
        // transport.requests[1] is the delegated child @@agent request
        const childTail = String(
            transport.requests[1].messages[transport.requests[1].messages.length - 1].content,
        );
        expect(childTail).toBe(
            'SUB_LABEL=archivist|SUB_ID=subagent_archivist|SUB_PROMPT=Inspect /lorebooks/ and return only verified facts.',
        );
    });
});
