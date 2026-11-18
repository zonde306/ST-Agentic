import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '@/core/bridge';
import { createDefaultConnection, createDefaultMainAgent } from '@/core/config';
import {
    ContextAssembler,
    FOLDED_OUTPUT_PREFIX,
    TrajectoryStore,
    WatermarkCompactor,
} from '@/core/context';
import { PayloadCompiler } from '@/core/llm';
import { LoreReadEvaluator, TailRadar, WIClassifier } from '@/core/lore';
import { RegexPipeline } from '@/core/regex';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import type {
    CanonicalMessage,
    CanonicalToolSchema,
    RawLoreEntry,
    RegexRule,
} from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import ejsConditionalLore from '../../fixtures/ejs-conditional-lore.json';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import {
    MemoryHostBridge,
    ScriptedLLMTransport,
    assertAppendOnlyPrefix,
} from '../../mocks';

function evaluateLocalFixtureEjs(text: string, vars: Record<string, unknown>): string {
    const getvar = (name: string): unknown => vars[name];

    let rendered = text.replace(
        /<%\s*if\s*\(\s*getvar\(['"]([^'"]+)['"]\)\s*(>=|===)\s*([^)]+?)\s*\)\s*\{\s*%>\s*([\s\S]*?)<%\s*\}\s*else\s*\{\s*%>\s*([\s\S]*?)<%\s*\}\s*%>/g,
        (_m, varName: string, op: string, rawRhs: string, thenBranch: string, elseBranch: string) => {
            const lhs = getvar(varName);
            const rhsTrimmed = rawRhs.trim();
            const rhs = rhsTrimmed.startsWith("'") || rhsTrimmed.startsWith('"')
                ? rhsTrimmed.slice(1, -1)
                : Number(rhsTrimmed);
            const condition = op === '>=' ? Number(lhs) >= Number(rhs) : lhs === rhs;
            return condition ? thenBranch : elseBranch;
        },
    );

    rendered = rendered.replace(
        /<%=\s*getvar\(['"]([^'"]+)['"]\)\s*>=\s*(\d+)\s*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*%>/g,
        (_m, varName: string, threshold: string, tVal: string, fVal: string) =>
            Number(getvar(varName)) >= Number(threshold) ? tVal : fVal,
    );

    return rendered;
}

describe('KV Cache Prefix Watchdog (15 Continuous Turns)', () => {
    it('maintains byte-for-byte append-only prefix invariance across 15 turns with tool calls, variable patches, <lore-hint> radar, display overrides, ingest regexes, swipe fork, and watermark compaction resumption', async () => {
        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: {
                '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
                [ejsConditionalLore.world]: ejsConditionalLore.entries as RawLoreEntry[],
            },
            ejsEvaluator: evaluateLocalFixtureEjs,
        });
        bridge.setVariable('hp', 100);
        bridge.setVariable('sanity', 85);
        bridge.setVariable('location', '灰港码头');
        bridge.setVariable('favorability', 20);

        const dataStore = new ChatDataStore(bridge);
        const loreEvaluator = new LoreReadEvaluator(bridge);
        const evaluatedLoreHashes = new Map<string, string>();
        const vfs = new VirtualFileSystem({
            bridge,
            store: dataStore,
            loreReadHook: async (ctx) => {
                const res = await loreEvaluator.evaluateFromContext(ctx);
                evaluatedLoreHashes.set(ctx.path, res.contentHash);
                return res.text;
            },
        });
        const radar = new TailRadar(loreEvaluator);
        const classifier = new WIClassifier();
        const classified = classifier.classifyLorebooks(await bridge.listEnabledLorebooks());

        const regexRules: RegexRule[] = [
            {
                id: 'ingest_user_ooc',
                name: 'Strip user OOC',
                pattern: '/\\s*\\[OOC:[^\\]]*\\]/g',
                replace: '',
                stage: 'ingest',
                applyToUser: true,
                applyToAssistant: false,
                enabled: true,
            },
            {
                id: 'ingest_asst_debug',
                name: 'Strip assistant debug comment',
                pattern: '/<!--internal-trace:[^>]*-->/g',
                replace: '',
                stage: 'ingest',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
            {
                id: 'display_status_html',
                name: 'Beautify status block for DOM only',
                pattern: '/<status-panel>([\\s\\S]*?)<\\/status-panel>/g',
                replace: '<details class="status-card">$1</details>',
                stage: 'display',
                applyToUser: false,
                applyToAssistant: true,
                enabled: true,
            },
        ];
        const regexPipeline = new RegexPipeline(regexRules);

        const tools: CanonicalToolSchema[] = [
            {
                name: 'read_file',
                description: 'Read VFS file',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
            },
            {
                name: 'search_files',
                description: 'Search VFS files',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string' }, pathPrefix: { type: 'string' } },
                    required: ['query'],
                },
            },
            {
                name: 'list_dir',
                description: 'List VFS directory',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string' } },
                    required: ['path'],
                },
            },
        ];

        const agent = createDefaultMainAgent({
            id: 'main',
            promptBlocks: [
                {
                    id: 'system_base',
                    name: 'Decoupled Base',
                    role: 'system',
                    placement: 'prefix',
                    content:
                        'You operate on top of a VFS workspace supporting single-character, multi-character ensemble, or world simulation.',
                    enabled: true,
                },
                {
                    id: 'prefix_style',
                    name: 'Narrative Style',
                    role: 'system',
                    placement: 'prefix',
                    content: '保持写实冷峻节奏，禁止代替用户说话。',
                    enabled: true,
                },
            ],
        });

        const trajectoryStore = new TrajectoryStore();
        const assembler = new ContextAssembler();
        const compactor = new WatermarkCompactor({ vfs, bridge });
        const payloadCompiler = new PayloadCompiler();
        const explicitConn = createDefaultConnection({
            providerFormat: 'anthropic',
            cachePolicy: 'anthropic_explicit',
            model: 'claude-3-7-sonnet',
        });

        // Pre-populate a large workspace lore supplement so search/read outputs exceed 400 chars
        await vfs.writeFile(
            '/notes/harbor-ledger.md',
            '灰港走私账册长篇记录：'.repeat(35),
            { target: { messageId: 0, swipeId: 0 } },
        );

        const transport = new ScriptedLLMTransport();

        // Helper executing a full turn (with optional tool loop) through ScriptedLLMTransport
        const runTurn = async (params: {
            turnNumber: number;
            userMsgId: number;
            asstMsgId: number;
            swipeId: number;
            userText: string;
            turnBrief?: string;
            toolCall?: { id: string; name: string; args: Record<string, unknown>; resultOverride?: string };
            finalAssistantText: string;
            displayOverrideText?: string;
            prevRequestForAssert: LLMRequest | null;
        }): Promise<{ lastReq: LLMRequest; firstReq: LLMRequest; displayText: string }> => {
            bridge.pushMessage({ id: params.userMsgId, name: '沈默', isUser: true, mes: params.userText });
            bridge.pushMessage({
                id: params.asstMsgId,
                name: '银莲花剧场',
                isUser: false,
                mes: '',
                swipeId: params.swipeId,
            });
            const target = { messageId: params.asstMsgId, swipeId: params.swipeId };

            const assembledStep1 = await assembler.assembleWithHost({
                agent,
                tools,
                loreEntries: classified.all,
                trajectoryStore,
                hostBridge: bridge,
                tailRadar: radar,
                target,
                userInput: params.userText,
                turnBrief: params.turnBrief,
                regex: regexPipeline,
            });

            if (params.prevRequestForAssert) {
                assertAppendOnlyPrefix(params.prevRequestForAssert, assembledStep1.request);
            }

            const turnMessages: CanonicalMessage[] = [...assembledStep1.layer2Messages];

            if (params.toolCall) {
                transport.enqueue({
                    content: '',
                    toolCalls: [
                        {
                            id: params.toolCall.id,
                            name: params.toolCall.name,
                            arguments: JSON.stringify(params.toolCall.args),
                        },
                    ],
                });

                const res1 = await transport.complete(assembledStep1.request);
                const tc = res1.toolCalls[0];

                let toolOutput = params.toolCall.resultOverride;
                if (toolOutput === undefined) {
                    if (tc.name === 'read_file') {
                        const filePath = String(params.toolCall.args.path);
                        toolOutput = await vfs.readFile(filePath, { target });
                        const h = evaluatedLoreHashes.get(filePath) ?? (await bridge.hashText(toolOutput));
                        trajectoryStore.markRead(filePath, h, agent.id);
                    } else if (tc.name === 'search_files') {
                        const hits = await vfs.searchFiles(String(params.toolCall.args.query), { target });
                        toolOutput = hits.map((h) => `${h.path}: ${h.snippet}`).join('\n')
                            + '\n'
                            + '补充检索引文：'.repeat(30);
                    } else if (tc.name === 'list_dir') {
                        const entries = await vfs.listDir(String(params.toolCall.args.path), { target });
                        toolOutput = entries.map((e) => `${e.path} (${e.kind})`).join('\n');
                    } else {
                        toolOutput = '';
                    }
                }

                turnMessages.push(
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [tc],
                    },
                    {
                        role: 'tool',
                        toolCallId: tc.id,
                        toolName: tc.name,
                        content: toolOutput,
                    },
                );

                const assembledStep2 = assembler.assemble({
                    agent,
                    tools,
                    loreEntries: classified.all,
                    trajectoryStore,
                    hostBridge: bridge,
                    inFlightMessages: turnMessages,
                    regex: regexPipeline,
                });

                assertAppendOnlyPrefix(assembledStep1.request, assembledStep2.request);

                transport.enqueue({ content: params.finalAssistantText });
                const res2 = await transport.complete(assembledStep2.request);

                const rawReply = res2.content;
                const displayText = regexPipeline.run(rawReply, { stage: 'display', sender: 'assistant' });
                if (params.displayOverrideText) {
                    dataStore.set(DATA_NAMESPACES.MESSAGE, '', 'append_output', params.displayOverrideText, target);
                }

                assembler.finalizeTurn({
                    trajectoryStore,
                    agentId: agent.id,
                    target,
                    turnMessages,
                    finalAssistantMessage: { role: 'assistant', content: rawReply },
                    regex: regexPipeline,
                });

                return {
                    firstReq: assembledStep1.request,
                    lastReq: assembledStep2.request,
                    displayText,
                };
            }

            transport.enqueue({ content: params.finalAssistantText });
            const res = await transport.complete(assembledStep1.request);
            const rawReply = res.content;
            const displayText = regexPipeline.run(rawReply, { stage: 'display', sender: 'assistant' });
            if (params.displayOverrideText) {
                dataStore.set(DATA_NAMESPACES.MESSAGE, '', 'append_output', params.displayOverrideText, target);
            }

            assembler.finalizeTurn({
                trajectoryStore,
                agentId: agent.id,
                target,
                turnMessages,
                finalAssistantMessage: { role: 'assistant', content: rawReply },
                regex: regexPipeline,
            });

            return {
                firstReq: assembledStep1.request,
                lastReq: assembledStep1.request,
                displayText,
            };
        };

        // ========================
        // PHASE 1: TURNS 1..8 (Pre-Compaction Append-Only Prefix Invariance)
        // ========================

        // Turn 1: User with [OOC] ingest regex + radar [未读] 银莲花 + read_file + display regex/override
        const t1 = await runTurn({
            turnNumber: 1,
            userMsgId: 0,
            asstMsgId: 1,
            swipeId: 0,
            userText: '我亮出银莲花铜徽，观察对方反应。[OOC: 保持悬疑感]',
            turnBrief: '前置事件：码头夜雾加重。',
            toolCall: {
                id: 'call_t1',
                name: 'read_file',
                args: { path: '/lorebooks/霜烬纪元/银莲花结社档案-5.md' },
            },
            finalAssistantText:
                '对方的目光骤然一凝。<status-panel>体力:100</status-panel><!--internal-trace:ok-->',
            displayOverrideText: '\n[前端特效卡片]',
            prevRequestForAssert: null,
        });
        expect(t1.firstReq.messages.length).toBeGreaterThan(0);
        expect(String(t1.firstReq.messages[t1.firstReq.messages.length - 1].content)).toContain('<lore-hint>');
        expect(String(t1.firstReq.messages[t1.firstReq.messages.length - 1].content)).not.toContain('[OOC:');
        expect(t1.displayText).toContain('<details class="status-card">');

        // Turn 2: Variable patch (hp 100->85, favorability 20->35 < 50 threshold), mention 银莲花 -> radar silent!
        bridge.setVariable('hp', 85);
        bridge.setVariable('favorability', 35);
        const t2 = await runTurn({
            turnNumber: 2,
            userMsgId: 2,
            asstMsgId: 3,
            swipeId: 0,
            userText: '我再次提起银莲花暗语，询问港口情况。',
            finalAssistantText: '林晚压低声音告诉你旧灯塔酒馆的事。',
            prevRequestForAssert: t1.lastReq,
        });
        expect(String(t2.firstReq.messages[t2.firstReq.messages.length - 1].content)).not.toContain('<lore-hint>');
        expect(String(t2.firstReq.messages[t2.firstReq.messages.length - 1].content)).toContain('体力=85');

        // Turn 3: Mention 林晚好感度档案 (unread) + search_files (>400 chars) -> read_file on turn 3 too
        const t3 = await runTurn({
            turnNumber: 3,
            userMsgId: 4,
            asstMsgId: 5,
            swipeId: 0,
            userText: '我试探林晚的过往档案，并搜查灰港走私账册。',
            toolCall: {
                id: 'call_t3',
                name: 'read_file',
                args: { path: '/lorebooks/条件分支测试书/林晚好感度阶段档案-201.md' },
            },
            finalAssistantText: '林晚暂时保持礼貌的距离。<!--internal-trace:t3-->',
            prevRequestForAssert: t2.lastReq,
        });

        // Turn 4: SWIPE FORK! First generate Swipe 0, then swipe to Swipe 1 rolling back to Turn 3 checkpoint!
        const t4Swipe0 = await runTurn({
            turnNumber: 4,
            userMsgId: 6,
            asstMsgId: 7,
            swipeId: 0,
            userText: '我们去旧灯塔酒馆二楼详谈。',
            toolCall: {
                id: 'call_t4_s0',
                name: 'read_file',
                args: { path: '/lorebooks/霜烬纪元/灰港码头与旧灯塔酒馆-6.md' },
            },
            finalAssistantText: '分支零：你独自走上二楼。',
            prevRequestForAssert: t3.lastReq,
        });
        expect(t4Swipe0.lastReq.messages.length).toBeGreaterThan(t3.lastReq.messages.length);

        // Swipe at messageId 7 -> roll back to checkpoint before messageId 7 (message 5 swipe 0)
        expect(trajectoryStore.restoreBeforeMessage(7, 'main')).toBe(true);
        expect(trajectoryStore.getReadSet('main').has('/lorebooks/霜烬纪元/灰港码头与旧灯塔酒馆-6.md')).toBe(false);

        const t4Swipe1 = await runTurn({
            turnNumber: 4,
            userMsgId: 6,
            asstMsgId: 7,
            swipeId: 1,
            userText: '我们去旧灯塔酒馆二楼详谈。',
            toolCall: {
                id: 'call_t4_s1',
                name: 'read_file',
                args: { path: '/lorebooks/霜烬纪元/灰港码头与旧灯塔酒馆-6.md' },
            },
            finalAssistantText: '分支一：林晚示意你先检查隔音铅板。',
            prevRequestForAssert: t3.lastReq, // MUST preserve byte-for-byte prefix from Turn 3!
        });

        // Turn 5: Variable patch crosses EJS threshold (favorability 35 -> 60 >= 50) -> radar emits [已更新]!
        bridge.setVariable('favorability', 60);
        bridge.setVariable('location', '旧灯塔酒馆二楼');
        const t5 = await runTurn({
            turnNumber: 5,
            userMsgId: 8,
            asstMsgId: 9,
            swipeId: 0,
            userText: '林晚看我的眼神变了，她主动递来半张蓝图。',
            toolCall: {
                id: 'call_t5',
                name: 'read_file',
                args: { path: '/lorebooks/条件分支测试书/林晚好感度阶段档案-201.md' },
            },
            finalAssistantText: '好感突破阈值，林晚决定向你敞开部分真相。',
            prevRequestForAssert: t4Swipe1.lastReq,
        });
        expect(String(t5.firstReq.messages[t5.firstReq.messages.length - 1].content)).toContain('[已更新]');

        // Turn 6: Large read-only search_files (>400 chars) + display override
        const t6 = await runTurn({
            turnNumber: 6,
            userMsgId: 10,
            asstMsgId: 11,
            swipeId: 0,
            userText: '检索守夜人相关的走私账册线索。',
            toolCall: {
                id: 'call_t6',
                name: 'search_files',
                args: { query: '账册', pathPrefix: '/' },
            },
            finalAssistantText: '你梳理出了三批异常货柜编号。<status-panel>线索+1</status-panel>',
            displayOverrideText: '\n[摘要卡片]',
            prevRequestForAssert: t5.lastReq,
        });

        // Turn 7: Large read_file (>400 chars) on harbor-ledger.md
        const t7 = await runTurn({
            turnNumber: 7,
            userMsgId: 12,
            asstMsgId: 13,
            swipeId: 0,
            userText: '逐行读取灰港走私账册。',
            toolCall: {
                id: 'call_t7',
                name: 'read_file',
                args: { path: '/notes/harbor-ledger.md' },
            },
            finalAssistantText: '账册里记载着地热炉核心部件的流向。',
            prevRequestForAssert: t6.lastReq,
        });

        // Turn 8: Another tool turn triggering High Watermark afterwards
        const t8 = await runTurn({
            turnNumber: 8,
            userMsgId: 14,
            asstMsgId: 15,
            swipeId: 0,
            userText: '我核对守夜人应急协议与密码。',
            toolCall: {
                id: 'call_t8',
                name: 'read_file',
                args: { path: '/lorebooks/霜烬纪元/守夜人应急协议-7.md' },
            },
            finalAssistantText: '一切线索在三号泊位汇合。',
            prevRequestForAssert: t7.lastReq,
        });
        expect(t8.lastReq.messages.length).toBeGreaterThan(t7.lastReq.messages.length);

        // Verify frozen Layer 1 NEVER had display regex applied!
        const preCompactLayer1 = trajectoryStore.getMessages('main');
        const hasDisplayDetails = preCompactLayer1.some((m) =>
            String(m.content).includes('<details class="status-card">'),
        );
        expect(hasDisplayDetails).toBe(false);
        expect(
            preCompactLayer1.some((m) => String(m.content).includes('<!--internal-trace:')),
        ).toBe(false);

        // ========================
        // PHASE 2: WATERMARK COMPACTION (High -> Low)
        // ========================
        const tokensAtTurn8 = compactor.estimateCurrentTokens(trajectoryStore);
        const targetHigh = tokensAtTurn8 - 10;
        const targetLow = Math.floor(tokensAtTurn8 * 0.55);

        const compactionResult = await compactor.compact(trajectoryStore, {
            agentId: 'main',
            watermark: { high: targetHigh, low: targetLow },
            keepRecentTurns: 2,
            foldThresholdChars: 400,
            summarizeChunk: async (chunkText) => {
                expect(chunkText).toContain('银莲花铜徽');
                return '前情提要：调查员沈默与林晚在灰港达成初步合作，追查走私账册与守夜人协议。';
            },
        });

        expect(compactionResult.compacted).toBe(true);
        expect(compactionResult.archivedChunkPath).toBe('/history/chunk-001.md');
        expect(compactionResult.archivedTurnCount).toBeGreaterThanOrEqual(1);
        expect(compactionResult.foldedToolResultCount).toBeGreaterThanOrEqual(1);
        expect(compactionResult.estimatedTokensAfter).toBeLessThanOrEqual(targetLow);

        // Verify archived chunk exists in VFS and evicted paths can be re-hinted
        expect(await vfs.readFile('/history/chunk-001.md')).toContain('银莲花铜徽');
        expect(trajectoryStore.getMessages('main').some((m) => String(m.content).startsWith(FOLDED_OUTPUT_PREFIX))).toBe(true);
        expect(trajectoryStore.getReadSet('main').has('/lorebooks/霜烬纪元/银莲花结社档案-5.md')).toBe(false);

        // ========================
        // PHASE 3: TURNS 9..15 (Post-Compaction Resumption of Byte-for-Byte Prefix Invariance!)
        // ========================

        // Turn 9: Re-mention archived 银莲花 -> TailRadar gently re-hints [未读]!
        const t9 = await runTurn({
            turnNumber: 9,
            userMsgId: 16,
            asstMsgId: 17,
            swipeId: 0,
            userText: '我再次检查手里的银莲花铜徽，确认接头细节。',
            toolCall: {
                id: 'call_t9',
                name: 'read_file',
                args: { path: '/lorebooks/霜烬纪元/银莲花结社档案-5.md' },
            },
            finalAssistantText: '铜徽背面的刻痕指向旧泵站。',
            prevRequestForAssert: null, // Post-compaction baseline turn
        });
        expect(String(t9.firstReq.messages[t9.firstReq.messages.length - 1].content)).toContain('<lore-hint>');
        expect(String(t9.firstReq.messages[t9.firstReq.messages.length - 1].content)).toContain('[未读] /lorebooks/霜烬纪元/银莲花结社档案-5.md');

        // Turn 10
        bridge.setVariable('hp', 72);
        const t10 = await runTurn({
            turnNumber: 10,
            userMsgId: 18,
            asstMsgId: 19,
            swipeId: 0,
            userText: '我们潜入旧泵站外围。',
            finalAssistantText: '蒸汽阀门发出嘶嘶声，无人把守。',
            prevRequestForAssert: t9.lastReq,
        });

        // Turn 11 (with tool call + ingest regex)
        const t11 = await runTurn({
            turnNumber: 11,
            userMsgId: 20,
            asstMsgId: 21,
            swipeId: 0,
            userText: '查看目录里的历史归档。[OOC: 保持紧凑]',
            toolCall: {
                id: 'call_t11',
                name: 'list_dir',
                args: { path: '/history' },
            },
            finalAssistantText: '归档列表确认无误。<!--internal-trace:t11-->',
            prevRequestForAssert: t10.lastReq,
        });

        // Turn 12
        const t12 = await runTurn({
            turnNumber: 12,
            userMsgId: 22,
            asstMsgId: 23,
            swipeId: 0,
            userText: '林晚打开了地热总闸的检修门。',
            finalAssistantText: '蓝色幽光从铭文矩阵中亮起。',
            prevRequestForAssert: t11.lastReq,
        });

        // Turn 13 (with variable patch + display override)
        bridge.setVariable('sanity', 78);
        const t13 = await runTurn({
            turnNumber: 13,
            userMsgId: 24,
            asstMsgId: 25,
            swipeId: 0,
            userText: '记录当前压力读数并准备撤离。',
            finalAssistantText: '读数稳定在安全区间。<status-panel>理智:78</status-panel>',
            displayOverrideText: '\n[阶段完成]',
            prevRequestForAssert: t12.lastReq,
        });
        expect(t13.displayText).toContain('<details class="status-card">');

        // Turn 14
        const t14 = await runTurn({
            turnNumber: 14,
            userMsgId: 26,
            asstMsgId: 27,
            swipeId: 0,
            userText: '沿着防空坑道返回三号泊位。',
            finalAssistantText: '雨已经停了，远方传来蒸汽汽笛。',
            prevRequestForAssert: t13.lastReq,
        });

        // Turn 15
        const t15 = await runTurn({
            turnNumber: 15,
            userMsgId: 28,
            asstMsgId: 29,
            swipeId: 0,
            userText: '整理今夜所有收获并向学院发送电报。',
            turnBrief: '收尾回合：无额外冲突。',
            finalAssistantText: '电报已加密发出，银莲花之夜落下帷幕。',
            prevRequestForAssert: t14.lastReq,
        });

        // Assert PayloadCompiler places explicit cache breakpoints cleanly at Layer 0 end + Layer 1 checkpoints
        const compiledFinal = payloadCompiler.compile(t15.lastReq, explicitConn);
        expect(compiledFinal.cacheBreakpointsApplied).toBeGreaterThanOrEqual(2);
        expect(compiledFinal.cacheBreakpointsApplied).toBeLessThanOrEqual(4);
        expect(t15.lastReq.cacheBreakpoints?.[0]).toBe(3); // Layer 0 end index unchanged across all 15 turns!
    });
});
