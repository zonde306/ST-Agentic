import { describe, expect, it } from 'vitest';
import { createDefaultConnection, createDefaultMainAgent } from '@/core/config';
import { ContextAssembler, TrajectoryStore } from '@/core/context';
import { PayloadCompiler } from '@/core/llm';
import type { RawLoreEntry, SideClueDoc } from '@/core/types';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) {
        return 0;
    }
    return haystack.split(needle).length - 1;
}

describe('Auto-injected prompt macros ({{coreManifest}}, {{systemRules}}, Layer 2 tail macros)', () => {
    it('places <core-manifest> into a role=user prefix block and omits it from Layer 0 system & Gemini systemInstruction', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base Rules.',
                    enabled: true,
                },
                {
                    id: 'user_manifest_slot',
                    name: 'User Manifest Slot',
                    role: 'user',
                    placement: 'prefix',
                    content: '角色卡与索引：\n{{coreManifest}}',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];

        const assembled = assembler.assemble({
            agent,
            loreEntries,
            presetFiles: { 'world-guide.md': '世界设定指南' },
            userInput: '开始探索',
            hostBridge: bridge,
        });

        // Layer 0 messages: [0] system_base, [1] <system-rules> (unclaimed), [2] user_manifest_slot (no separate <core-manifest> system msg)
        expect(assembled.layer0Messages).toHaveLength(3);
        expect(assembled.layer0Messages[0]).toEqual({ role: 'system', content: 'System Base Rules.' });
        expect(assembled.layer0Messages[1].role).toBe('system');
        expect(assembled.layer0Messages[1].content).toContain('<system-rules>');
        expect(assembled.layer0Messages[2].role).toBe('user');
        const userSlotText = assembled.layer0Messages[2].content as string;
        expect(userSlotText).toContain('角色卡与索引：');
        expect(userSlotText).toContain('<core-manifest>');
        expect(userSlotText).toContain('世界书驱动型卡片');
        expect(userSlotText).toContain('/character/description.md');
        expect(userSlotText).toContain('/lorebooks/霜烬纪元/核心人物林晚-3.md');
        expect(userSlotText).toContain('/preset/world-guide.md');
        expect(userSlotText).toContain('</core-manifest>');

        // Compile for Gemini: systemInstruction MUST NOT contain <core-manifest>, contents MUST contain it
        const compiler = new PayloadCompiler();
        const geminiConn = createDefaultConnection({
            providerFormat: 'gemini',
            model: 'gemini-2.5-pro',
        });
        const compiled = compiler.compile(assembled.request, geminiConn);
        const sysInstText = JSON.stringify(compiled.body.systemInstruction ?? {});
        const contentsText = JSON.stringify(compiled.body.contents ?? []);

        expect(sysInstText).toContain('System Base Rules.');
        expect(sysInstText).toContain('<system-rules>');
        expect(sysInstText).not.toContain('<core-manifest>');
        expect(contentsText).toContain('<core-manifest>');
        expect(contentsText).toContain('/preset/world-guide.md');
    });

    it('supports snake_case, kebab-case, and whitespace-padded aliases for {{coreManifest}} and {{systemRules}}', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const assembler = new ContextAssembler();

        for (const macroPair of [
            ['{{core_manifest}}', '{{system_rules}}'],
            ['{{core-manifest}}', '{{system-rules}}'],
            ['{{ coreManifest }}', '{{ systemRules }}'],
        ] as const) {
            const agent = createDefaultMainAgent({
                promptBlocks: [
                    {
                        id: 'system_base',
                        name: 'Base',
                        role: 'system',
                        placement: 'prefix',
                        content: 'Static Base',
                        enabled: true,
                    },
                    {
                        id: 'user_bundle',
                        name: 'Bundle',
                        role: 'user',
                        placement: 'prefix',
                        content: `${macroPair[1]}\n\n${macroPair[0]}`,
                        enabled: true,
                    },
                ],
            });

            const assembled = assembler.assemble({
                agent,
                loreEntries,
                userInput: '测试别名',
                hostBridge: bridge,
            });

            expect(assembled.layer0Messages).toHaveLength(2);
            expect(assembled.layer0Messages[0]).toEqual({ role: 'system', content: 'Static Base' });
            expect(assembled.layer0Messages[1].role).toBe('user');
            const body = assembled.layer0Messages[1].content as string;
            expect(body).toContain('<system-rules>');
            expect(body).toContain('<core-manifest>');
            expect(countOccurrences(body, '<core-manifest>')).toBe(1);
            expect(countOccurrences(body, '<system-rules>')).toBe(1);
        }
    });

    it('expands {{systemRules}} to empty string and omits block when no Category ① system rules exist', () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '用户', charName: '助手' },
            characterFields: {
                description:
                    '一段足够长的角色设定文本，超过八十个字符以确保不会触发空壳角色卡提示，用于测试无系统规则时的展开行为。',
            },
        });

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'Base Only',
                    enabled: true,
                },
                {
                    id: 'rules_only_slot',
                    name: 'Rules Slot',
                    role: 'user',
                    placement: 'prefix',
                    content: '  {{systemRules}}  ',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const assembled = assembler.assemble({
            agent,
            userInput: '你好',
            hostBridge: bridge,
        });

        // rules_only_slot trimmed to empty -> omitted; <core-manifest> still auto-injected
        expect(assembled.layer0Messages).toHaveLength(2);
        expect(assembled.layer0Messages[0]).toEqual({ role: 'system', content: 'Base Only' });
        expect(assembled.layer0Messages[1].role).toBe('system');
        expect(assembled.layer0Messages[1].content).toContain('<core-manifest>');
    });

    it('expands {{coreManifest}} inside system_base and explicit systemBasePrompt without duplication', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const assembler = new ContextAssembler();

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'BEFORE\n{{coreManifest}}\nAFTER',
                    enabled: true,
                },
            ],
        });

        const fromBlock = assembler.assemble({
            agent,
            loreEntries,
            userInput: 'hi',
            hostBridge: bridge,
        });
        expect(fromBlock.layer0Messages).toHaveLength(2); // system_base (with inline manifest) + <system-rules>
        const baseText = fromBlock.layer0Messages[0].content as string;
        expect(baseText).toMatch(/^BEFORE\n<core-manifest>[\s\S]*<\/core-manifest>\nAFTER$/);
        expect(countOccurrences(JSON.stringify(fromBlock.layer0Messages), '<core-manifest>')).toBe(1);

        const fromExplicit = assembler.assemble({
            agent,
            loreEntries,
            systemBasePrompt: 'EXPLICIT\n{{core-manifest}}',
            userInput: 'hi',
            hostBridge: bridge,
        });
        expect(fromExplicit.layer0Messages).toHaveLength(2);
        expect(fromExplicit.layer0Messages[0].content).toContain('EXPLICIT\n<core-manifest>');
        expect(countOccurrences(JSON.stringify(fromExplicit.layer0Messages), '<core-manifest>')).toBe(1);
    });

    it('suppresses Layer 0 auto-injection when {{coreManifest}} is placed in tail, across frozen Turn 2 and prefix invalidation', async () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const store = new TrajectoryStore();
        const assembler = new ContextAssembler();

        const tailAgent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'tail_manifest',
                    name: 'Tail Manifest',
                    role: 'user',
                    placement: 'tail',
                    content: '尾部注入清单：\n{{coreManifest}}\n{{systemRules}}',
                    enabled: true,
                },
            ],
        });

        const turn1 = await assembler.assembleWithHost({
            agent: tailAgent,
            trajectoryStore: store,
            hostBridge: bridge,
            loreEntries,
            userInput: '第一回合',
        });

        expect(turn1.layer0Messages).toEqual([{ role: 'system', content: 'System Base' }]);
        expect(turn1.floatingTailMessages).toHaveLength(1);
        expect(turn1.floatingTailMessages[0].role).toBe('user');
        expect(turn1.floatingTailMessages[0].content).toContain('<core-manifest>');
        expect(turn1.floatingTailMessages[0].content).toContain('<system-rules>');

        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: tailAgent.id,
            target: { messageId: 1, swipeId: 0 },
            turnMessages: turn1.layer2Messages,
            finalAssistantMessage: { role: 'assistant', content: '收到。' },
        });

        // Turn 2: frozen prefix hits, Layer 0 still omits <core-manifest>/<system-rules>, floating tail still expands both
        const turn2 = await assembler.assembleWithHost({
            agent: tailAgent,
            trajectoryStore: store,
            hostBridge: bridge,
            loreEntries,
            userInput: '第二回合',
        });

        expect(turn2.layer0Messages).toEqual([{ role: 'system', content: 'System Base' }]);
        expect(turn2.floatingTailMessages[0].content).toContain('<core-manifest>');
        expect(turn2.floatingTailMessages[0].content).toContain('<system-rules>');

        // Now test invalidation: start with a default agent (no macro -> Layer 0 frozen with <core-manifest>),
        // then add {{coreManifest}} into a tail block -> fingerprint MUST invalidate stale Layer 0 prefix!
        const store2 = new TrajectoryStore();
        const unconfiguredAgent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
            ],
        });
        const t1 = assembler.assemble({
            agent: unconfiguredAgent,
            trajectoryStore: store2,
            hostBridge: bridge,
            loreEntries,
            userInput: '回合一',
        });
        expect(t1.layer0Messages.some((m) => String(m.content).includes('<core-manifest>'))).toBe(true);

        const updatedAgent = createDefaultMainAgent({
            sessionMode: 'persistent',
            promptBlocks: [
                ...unconfiguredAgent.promptBlocks,
                {
                    id: 'new_tail_manifest',
                    name: 'New Tail Manifest',
                    role: 'user',
                    placement: 'tail',
                    content: '{{coreManifest}}',
                    enabled: true,
                },
            ],
        });
        const t2 = assembler.assemble({
            agent: updatedAgent,
            trajectoryStore: store2,
            hostBridge: bridge,
            loreEntries,
            userInput: '回合二',
        });
        expect(t2.layer0Messages.some((m) => String(m.content).includes('<core-manifest>'))).toBe(false);
        expect(t2.floatingTailMessages[0].content).toContain('<core-manifest>');
    });

    it('does not suppress auto-injection when block is disabled or trigger does not match, and suppresses when trigger matches', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const assembler = new ContextAssembler();

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'disabled_manifest',
                    name: 'Disabled',
                    role: 'user',
                    placement: 'prefix',
                    content: '{{coreManifest}}',
                    enabled: false,
                },
                {
                    id: 'trigger_only_manifest',
                    name: 'Trigger Scoped',
                    role: 'user',
                    placement: 'prefix',
                    content: 'TRIGGER_SLOT:\n{{coreManifest}}',
                    enabled: true,
                    triggers: ['trigger'],
                },
            ],
        });

        const mainRun = assembler.assemble({
            agent,
            loreEntries,
            userInput: '主线请求',
            promptTriggerContext: { kind: 'main', action: 'normal' },
            hostBridge: bridge,
        });
        expect(mainRun.layer0Messages.some((m) => m.role === 'system' && String(m.content).includes('<core-manifest>'))).toBe(true);
        expect(mainRun.layer0Messages.some((m) => String(m.content).includes('TRIGGER_SLOT:'))).toBe(false);

        const triggerRun = assembler.assemble({
            agent,
            loreEntries,
            userInput: '触发器请求',
            promptTriggerContext: { kind: 'trigger', phase: 'after_turn' },
            hostBridge: bridge,
        });
        expect(triggerRun.layer0Messages.some((m) => m.role === 'system' && String(m.content).includes('<core-manifest>'))).toBe(false);
        const triggerSlot = triggerRun.layer0Messages.find((m) => String(m.content).includes('TRIGGER_SLOT:'));
        expect(triggerSlot?.role).toBe('user');
        expect(triggerSlot?.content).toContain('<core-manifest>');
    });

    it('controls Layer 2 auto-injected XML blocks via tail macros across assemble(), assembleWithHost(), and inFlight rounds', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '沈默', charName: '剧场' },
            characterFields: {
                description:
                    '这是一段超过八十个字符的背景设定描述，包含都市街道、秘密档案室、线外联络通道与调查规则等完整细节。',
            },
        });
        bridge.setVariable('phase', '保持低调');

        const sideClues: SideClueDoc[] = [
            {
                path: '/side/comms/linwan-1.md',
                meta: {
                    id: 'linwan-1',
                    title: '林晚加密来信',
                    keywords: ['码头'],
                    delivery: 'next_turn_brief',
                    status: 'dormant',
                    anchor: '0:0',
                    summary: '码头三号仓库今晚有动静。',
                    createdAt: 1,
                    updatedAt: 1,
                },
                body: '正文详情',
                contentHash: 'hash-linwan-1',
            },
        ];

        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'tail_router',
                    name: 'Tail Router',
                    role: 'system',
                    placement: 'tail',
                    content: [
                        '[BRIEF]',
                        '{{turnBrief}}',
                        '[SIDE_BRIEF]',
                        '{{sideBrief}}',
                        '[NOTICE]',
                        '{{workspaceNotice}}',
                        '[REMINDERS]',
                        '{{dynamicReminders}}',
                        '[LORE]',
                        '{{loreHint}}',
                        '[SIDE_HINT]',
                        '{{sideHint}}',
                    ].join('\n'),
                    enabled: true,
                },
            ],
        });

        const loreEntries: RawLoreEntry[] = [
            {
                world: 'W',
                uid: 10,
                comment: 'Dynamic Rule',
                content: '当前阶段：{{getvar::phase}}。',
                keys: [],
                keysecondary: [],
                constant: true,
                selective: false,
                disable: false,
                position: 4,
                depth: 2,
                order: 50,
                role: 0,
            },
        ];

        const assembler = new ContextAssembler();
        const assembled = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            loreEntries,
            sideClues,
            userInput: '推开档案室门',
            turnBrief: '前置检查：门锁已松动。',
            workspaceNotice: '<workspace-instructions-notice>\n- /workspace/AGENTS.md (未读)\n</workspace-instructions-notice>',
            loreHint: '<lore-hint>\n- [未读] /lorebooks/W/dock-1.md\n</lore-hint>',
            sideHint: '<side-hint>\n- [未读] /side/notes/clue-1.md\n</side-hint>',
        });

        // Layer 2 user message MUST contain ONLY userInput (all 6 tail XML blocks claimed by tail_router)
        expect(assembled.layer2Messages).toHaveLength(1);
        expect(assembled.layer2Messages[0]).toEqual({
            role: 'user',
            content: '推开档案室门',
        });

        // Floating tail MUST contain all 6 expanded blocks
        expect(assembled.floatingTailMessages).toHaveLength(1);
        const tailText = assembled.floatingTailMessages[0].content as string;
        expect(tailText).toContain('<turn-brief>\n前置检查：门锁已松动。\n</turn-brief>');
        expect(tailText).toContain('<side-brief>');
        expect(tailText).toContain('林晚加密来信');
        expect(tailText).toContain('<workspace-instructions-notice>');
        expect(tailText).toContain('<dynamic-reminders>\n当前阶段：保持低调。\n</dynamic-reminders>');
        expect(tailText).toContain('<lore-hint>');
        expect(tailText).toContain('<side-hint>');

        // consumedSideBriefPaths is still preserved
        expect(assembled.consumedSideBriefPaths).toEqual(['/side/comms/linwan-1.md']);

        // Round 2 in-flight re-assembly preserves Round 1 Layer 2 macro values
        const round2 = assembler.assemble({
            agent,
            hostBridge: bridge,
            loreEntries,
            inFlightMessages: [
                ...assembled.layer2Messages,
                { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"/lorebooks/W/dock-1.md"}' }] },
                { role: 'tool', toolCallId: 'c1', toolName: 'read_file', content: '内容' },
            ],
            macroOverrides: assembled.effectiveMacroOverrides,
        });
        expect(round2.floatingTailMessages[0].content).toContain('<lore-hint>');
        expect(round2.floatingTailMessages[0].content).toContain('<turn-brief>');

        // Absent Layer 2 macro values expand cleanly to '' (never raw {{loreHint}})
        const emptyTurn = await assembler.assembleWithHost({
            agent,
            hostBridge: bridge,
            userInput: '纯粹对话',
        });
        const emptyTailText = emptyTurn.floatingTailMessages[0].content as string;
        expect(emptyTailText).not.toContain('{{loreHint}}');
        expect(emptyTailText).not.toContain('{{turnBrief}}');
        expect(emptyTailText).toContain('[BRIEF]\n\n[SIDE_BRIEF]');
    });

    it('keeps unclaimed Layer 2 blocks in Layer 2 user message while suppressing only claimed ones', () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: 'User', charName: 'Char' },
            characterFields: {
                description:
                    'Sufficiently long character description over eighty characters so hollow-card notice is not emitted.',
            },
        });
        const agent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'claim_lore_only',
                    name: 'Claim Lore Only',
                    role: 'system',
                    placement: 'tail',
                    content: '按需参考：{{loreHint}}',
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const assembled = assembler.assemble({
            agent,
            hostBridge: bridge,
            userInput: '继续调查',
            turnBrief: '保持状态',
            loreHint: '<lore-hint>\n- [未读] /lorebooks/W/entry-1.md\n</lore-hint>',
        });

        const userMsgText = assembled.layer2Messages[0].content as string;
        expect(userMsgText).toContain('继续调查');
        expect(userMsgText).toContain('<turn-brief>');
        expect(userMsgText).not.toContain('<lore-hint>');
        expect(assembled.floatingTailMessages[0].content).toContain('<lore-hint>');
    });

    it('expands {{coreManifest}} safely inside role=custom JSON tool-response blocks and without hostBridge', () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: hollowChineseCard.lorebooks as Record<string, RawLoreEntry[]>,
        });
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];

        const customAgent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'custom_manifest_tool',
                    name: 'Simulated Manifest Read',
                    role: 'custom',
                    placement: 'prefix',
                    content: JSON.stringify([
                        {
                            role: 'user',
                            content: '请读取角色与核心设定清单。',
                        },
                        {
                            role: 'assistant',
                            content: '',
                            tool_calls: [
                                {
                                    id: 'call_manifest_1',
                                    type: 'function',
                                    function: {
                                        name: 'read_file',
                                        arguments: '{"path":"/character/manifest"}',
                                    },
                                },
                            ],
                        },
                        {
                            role: 'tool',
                            tool_call_id: 'call_manifest_1',
                            name: 'read_file',
                            content: '{{coreManifest}}',
                        },
                    ]),
                    enabled: true,
                },
            ],
        });

        const assembler = new ContextAssembler();
        const assembled = assembler.assemble({
            agent: customAgent,
            loreEntries,
            userInput: '你好',
            hostBridge: bridge,
        });

        const toolMsg = assembled.layer0Messages.find((m) => m.role === 'tool');
        expect(toolMsg).toBeDefined();
        expect(toolMsg?.content).toContain('<core-manifest>');
        expect(toolMsg?.content).toContain('世界书驱动型卡片');

        const compiler = new PayloadCompiler();
        const compiled = compiler.compile(
            assembled.request,
            createDefaultConnection({ providerFormat: 'gemini', model: 'gemini-2.5-pro' }),
        );
        expect(JSON.stringify(compiled.body.systemInstruction ?? {})).not.toContain('<core-manifest>');

        // Also works without hostBridge via substituteAutoPromptMacrosFallback
        const noBridgeAgent = createDefaultMainAgent({
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Base',
                    role: 'system',
                    placement: 'prefix',
                    content: 'System Base',
                    enabled: true,
                },
                {
                    id: 'user_manifest',
                    name: 'User Manifest',
                    role: 'user',
                    placement: 'prefix',
                    content: '清单：\n{{coreManifest}}',
                    enabled: true,
                },
            ],
        });
        const noBridgeRes = assembler.assemble({
            agent: noBridgeAgent,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            loreEntries,
            userInput: 'hi',
        });
        expect(noBridgeRes.layer0Messages).toHaveLength(3);
        expect(noBridgeRes.layer0Messages[2].role).toBe('user');
        expect(noBridgeRes.layer0Messages[2].content).toContain('<core-manifest>');
        expect(noBridgeRes.layer0Messages[0].content).not.toContain('<core-manifest>');
        expect(noBridgeRes.layer0Messages[1].content).toContain('<system-rules>');
    });
});
