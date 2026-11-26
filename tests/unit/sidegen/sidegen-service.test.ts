import { describe, expect, it, vi } from 'vitest';
import { createDefaultConnection, createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import {
    AGENTIC_SIDE_SESSIONS_KEY,
    SideGenService,
    SideSessionStore,
    toSideThreadId,
} from '@/core/sidegen';
import { ChatDataStore, DATA_NAMESPACES } from '@/core/store';
import type { AgentRunTrace } from '@/core/types';
import { canonicalStringify } from '@/core/utils';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

function createDeterministicClock(start = 1_732_320_000_000, step = 1000) {
    let current = start;
    return () => {
        const value = current;
        current += step;
        return value;
    };
}

describe('SideGenService — runOnce', () => {
    it('runs statelessly with zero residue in TrajectoryStore, SideSessionStore, main chat, or /side/*', async () => {
        const bridge = createOffMainlineTestBridge();
        const trajectoryStore = new TrajectoryStore();
        trajectoryStore.appendTurn(
            [
                { role: 'user', content: '主线消息' },
                { role: 'assistant', content: '主线回复' },
            ],
            'main',
        );

        const transport = new ScriptedLLMTransport([
            {
                content: '码头暗哨悄悄换了班，无人察觉。',
                usage: { inputTokens: 120, cachedTokens: 0, outputTokens: 25 },
            },
        ]);

        const traces: AgentRunTrace[] = [];
        const fastConn = createDefaultConnection({ id: 'fast-aux', model: 'gpt-4o-mini' });
        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            getDefaultConnectionId: () => 'main-conn',
            resolveConnection: (id) => (id === 'fast-aux' ? fastConn : undefined),
            onTrace: (t) => traces.push(t),
            now: createDeterministicClock(),
        });

        const result = await service.runOnce({
            systemPrompt: '你是幕后观察者。',
            prompt: '生成一段 50 字的码头动态。',
            connectionId: 'fast-aux',
        });

        expect(result.text).toBe('码头暗哨悄悄换了班，无人察觉。');
        expect(result.sessionId).toBeUndefined();
        expect(result.bridgedPath).toBeUndefined();
        expect(result.usage).toEqual({
            inputTokens: 120,
            cachedTokens: 0,
            outputTokens: 25,
        });

        // Zero residue guarantees
        expect(trajectoryStore.listAgentIds()).toEqual(['main']);
        expect(trajectoryStore.getMessageCount('main')).toBe(2);
        expect(bridge.writtenMessages).toHaveLength(0);
        expect(bridge.metadata[AGENTIC_SIDE_SESSIONS_KEY]).toBeUndefined();
        expect(await service.listSessions()).toEqual([]);
        expect(await service.clues.list()).toEqual([]);

        // Request shape & connection resolution
        expect(transport.requests).toHaveLength(1);
        expect(transport.requests[0].connectionId).toBe('fast-aux');
        expect(transport.requests[0].connection?.model).toBe('gpt-4o-mini');
        expect(transport.requests[0].messages).toEqual([
            { role: 'system', content: '你是幕后观察者。' },
            { role: 'user', content: '生成一段 50 字的码头动态。' },
        ]);

        // Trace recorded cleanly
        expect(traces).toHaveLength(1);
        expect(traces[0].offMainlineKind).toBe('sidegen_once');
    });

    it('injects optional read-only mainChatDepth tail and canonically ordered includeVars without mutating host state', async () => {
        const bridge = createOffMainlineTestBridge();
        bridge.pushMessage({
            name: 'System',
            isUser: false,
            isSystem: true,
            mes: '隐藏系统楼层不应进入尾片',
        });
        bridge.pushMessage({
            name: '调查员',
            isUser: true,
            mes: '检查旧仓库门锁。',
        });
        bridge.setVariable('z_flag', true);
        bridge.setVariable('a_heat', 7);

        const chatBefore = structuredClone(bridge.chat);
        const varsBefore = structuredClone(bridge.metadata.variables);

        const transport = new ScriptedLLMTransport([{ content: '门锁留有新鲜撬痕。' }]);
        const service = new SideGenService({
            bridge,
            transport,
            getDefaultConnectionId: () => 'default-conn',
        });

        await service.runOnce({
            prompt: '分析现场细节',
            mainChatDepth: 2,
            includeVars: true,
        });

        const req = transport.requests[0];
        expect(req.connectionId).toBe('default-conn');
        const userText = String(req.messages[0].content);
        expect(userText).toContain('<main-chat-context>');
        expect(userText).toContain('雾港的雨下得很大，我已提前抵达灯塔。');
        expect(userText).toContain('检查旧仓库门锁。');
        expect(userText).not.toContain('隐藏系统楼层不应进入尾片');
        expect(userText).not.toContain('我们今晚在老码头碰头。'); // outside depth=2
        expect(userText).toContain('<main-vars-snapshot>');
        expect(userText).toContain('{"a_heat":7,"z_flag":true}'); // canonical key order

        // Strict read-only check
        expect(bridge.chat).toEqual(chatBefore);
        expect(bridge.metadata.variables).toEqual(varsBefore);
    });

    it('bridges runOnce output to /side/* via side-clue-codec when bridge option is provided', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: '码头值夜工透露：东区巡逻 21:20 提前交班。' },
        ]);
        const service = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(1_732_327_000_000),
        });

        const result = await service.runOnce({
            prompt: '推演码头暗线流言',
            bridge: {
                path: '/side/rumors/dock-patrol.md',
                delivery: 'next_turn_brief',
                title: '东区巡逻换防紧急通报',
                keywords: ['巡逻', '东区'],
                summary: '东区巡逻 21:20 提前换防。',
            },
        });

        expect(result.bridgedPath).toBe('/side/rumors/dock-patrol.md');

        const doc = await service.clues.read('/side/rumors/dock-patrol.md');
        expect(doc).not.toBeNull();
        expect(doc!.path).toBe('/side/rumors/dock-patrol.md');
        expect(doc!.meta.title).toBe('东区巡逻换防紧急通报');
        expect(doc!.meta.delivery).toBe('next_turn_brief');
        expect(doc!.meta.status).toBe('dormant');
        expect(doc!.meta.keywords).toEqual(['巡逻', '东区']);
        expect(doc!.meta.summary).toBe('东区巡逻 21:20 提前换防。');
        expect(doc!.meta.anchor).toBe('1#0');
        expect(doc!.body).toBe('码头值夜工透露：东区巡逻 21:20 提前交班。');
        expect(doc!.contentHash).toMatch(/^[0-9a-f]{16}$/);

        // Stored inside DATA_NAMESPACES.SIDE_FILES under ChatDataStore
        const store = new ChatDataStore(bridge);
        const rawEntry = store.get(DATA_NAMESPACES.SIDE_FILES, 'rumors/dock-patrol.md');
        expect(rawEntry?.content).toContain('delivery: next_turn_brief');
    });
});

describe('SideGenService — SideSession KV stability, compaction & autoBridge', () => {
    it('freezes Layer 0 prefix, maintains append-only KV invariance with cacheBreakpoints, and tracks hit rate', async () => {
        const bridge = createOffMainlineTestBridge();
        const trajectoryStore = new TrajectoryStore();
        const transport = new ScriptedLLMTransport([
            {
                content: '收到，东区巡逻 21:30 换防。',
                usage: { inputTokens: 100, cachedTokens: 0, outputTokens: 20 },
            },
            {
                content: '我带了两张门禁卡，在灯塔下等你。',
                usage: { inputTokens: 200, cachedTokens: 185, outputTokens: 25 },
            },
            {
                content: '记住暗号：三声雾笛。',
                usage: { inputTokens: 300, cachedTokens: 280, outputTokens: 18 },
            },
        ]);

        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            now: createDeterministicClock(),
        });

        const created = await service.createSession({
            id: 'phone:linwan',
            title: '林晚加密手机通讯',
            scope: 'branch',
            systemPrompt: '你是林晚，通过加密频道与调查员简短联络。',
        });

        expect(created.id).toBe('phone:linwan');
        expect(created.turns).toBe(0);
        expect(trajectoryStore.hasThread(toSideThreadId('phone:linwan'))).toBe(true);

        const r1 = await service.send('phone:linwan', '今晚老码头巡逻几点换防？');
        const r2 = await service.send('phone:linwan', '门禁卡带了吗？');
        const r3 = await service.send('phone:linwan', '暗号是什么？');

        expect(r1.sessionId).toBe('phone:linwan');
        expect(r2.text).toBe('我带了两张门禁卡，在灯塔下等你。');
        expect(r3.text).toBe('记住暗号：三声雾笛。');

        // Verify byte-for-byte append-only prefix stability across Turn 1 -> Turn 2 -> Turn 3
        const req1 = transport.requests[0];
        const req2 = transport.requests[1];
        const req3 = transport.requests[2];

        expect(req1.cacheBreakpoints).toEqual([0]);
        expect(req2.cacheBreakpoints).toEqual([0, 2]);
        expect(req3.cacheBreakpoints).toEqual([0, 2, 4]);

        // Layer 0 identical across all turns
        expect(canonicalStringify(req2.messages[0])).toBe(canonicalStringify(req1.messages[0]));
        expect(canonicalStringify(req3.messages[0])).toBe(canonicalStringify(req1.messages[0]));

        // Turn 1 messages untouched in Turn 2 & Turn 3 requests
        expect(canonicalStringify(req2.messages.slice(0, 2))).toBe(
            canonicalStringify(req1.messages.slice(0, 2)),
        );
        expect(canonicalStringify(req3.messages.slice(0, 4))).toBe(
            canonicalStringify(req2.messages.slice(0, 4)),
        );

        const info = await service.getSession('phone:linwan');
        expect(info?.turns).toBe(3);
        expect(info?.lastCacheHitRate).toBe('93.3%');
        expect(info?.estimatedTokens).toBeGreaterThan(created.estimatedTokens);

        const transcript = await service.getTranscript('phone:linwan');
        expect(transcript.map((m) => m.role)).toEqual([
            'system',
            'user',
            'assistant',
            'user',
            'assistant',
            'user',
            'assistant',
        ]);
    });

    it('automatically compacts off-mainline thread at watermark.high without touching mainline /history', async () => {
        const bridge = createOffMainlineTestBridge();
        const trajectoryStore = new TrajectoryStore();
        trajectoryStore.appendTurn(
            [
                { role: 'user', content: '主线回合1' },
                { role: 'assistant', content: '主线回复1' },
            ],
            'main',
        );

        const longReply = '这是非常详细的码头情报分析。'.repeat(20);
        const transport = new ScriptedLLMTransport([
            { content: `第一轮：${longReply}` },
            { content: `第二轮：${longReply}` },
            { content: '第三轮：简短线索确认，未达高水位。' },
        ]);

        const summarizeSpy = vi.fn(async (chunk: string) => `压缩摘要(${chunk.length}字): 老码头巡逻与灯塔联络已确认。`);

        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            summarizeCompaction: summarizeSpy,
            now: createDeterministicClock(),
        });

        await service.createSession({
            id: 'rumor:compact',
            title: '流言推演',
            scope: 'chat',
            systemPrompt: '系统规则。',
            watermark: { high: 450, low: 240 },
        });

        await service.send('rumor:compact', '第1问：码头情况？');
        expect(summarizeSpy).not.toHaveBeenCalled();

        await service.send('rumor:compact', '第2问：船只动向？');
        const afterTurn2 = await service.getSession('rumor:compact');
        // Turn 2 crosses watermark.high (450), triggering automatic compaction down toward watermark.low
        expect(summarizeSpy).toHaveBeenCalledTimes(1);
        expect(afterTurn2!.estimatedTokens).toBeLessThan(450);

        const transcript = await service.getTranscript('rumor:compact');
        expect(transcript[0]).toEqual({ role: 'system', content: '系统规则。' });
        expect(transcript[1].role).toBe('system');
        expect(transcript[1].content).toContain('<side-session-summary');
        expect(transcript[1].content).toContain('老码头巡逻与灯塔联络已确认');
        // Retained most recent turn
        expect(transcript.some((m) => m.role === 'user' && m.content.includes('第2问'))).toBe(true);
        // Oldest turn was compacted out of Layer 1
        expect(transcript.some((m) => m.role === 'user' && m.content.includes('第1问'))).toBe(false);

        // Mainline trajectory & /history completely untouched
        expect(trajectoryStore.getMessageCount('main')).toBe(2);
        expect(bridge.metadata.agentic_history).toBeUndefined();

        // Manual compactSession works cleanly too
        await service.send('rumor:compact', '第3问：最新线索？');
        const manual = await service.compactSession('rumor:compact');
        expect(manual.compacted).toBe(true);
        expect(manual.estimatedTokens).toBeGreaterThan(0);
    });

    it('updates /side/* clues automatically via autoBridge in append and replace modes with updated contentHash', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: '我已到灯塔下。' },
            { content: '巡逻队刚走过去，安全。' },
            { content: '第一版摘要内容' },
            { content: '第二版覆盖内容' },
        ]);

        const service = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(),
        });

        await service.createSession({
            id: 'phone:append',
            title: '林晚',
            scope: 'branch',
            systemPrompt: '你是林晚。',
            autoBridge: {
                path: '/side/comms/linwan.md',
                delivery: 'radar_hint',
                keywords: ['老码头', '灯塔'],
                title: '林晚加密通讯',
                mode: 'append',
                summaryPrefix: '加密通讯：',
            },
        });

        const res1 = await service.send('phone:append', '到了吗？');
        expect(res1.bridgedPath).toBe('/side/comms/linwan.md');
        const doc1 = await service.clues.read('/side/comms/linwan.md');
        expect(doc1!.body).toContain('- [调查员]: 到了吗？');
        expect(doc1!.body).toContain('- [林晚]: 我已到灯塔下。');
        expect(doc1!.meta.summary).toBe('加密通讯：我已到灯塔下。');
        expect(doc1!.meta.sourceSessionId).toBe('phone:append');

        await service.send('phone:append', '巡逻队走了吗？');
        const doc2 = await service.clues.read('/side/comms/linwan.md');
        expect(doc2!.body).toContain('我已到灯塔下。');
        expect(doc2!.body).toContain('巡逻队刚走过去，安全。');
        expect(doc2!.contentHash).not.toBe(doc1!.contentHash);

        // Replace mode
        await service.createSession({
            id: 'notes:replace',
            title: '势力简报',
            scope: 'chat',
            systemPrompt: '总结局势。',
            autoBridge: {
                path: '/side/notes/faction.md',
                delivery: 'vfs_only',
                keywords: ['雾港'],
                title: '势力快照',
                mode: 'replace',
            },
        });

        await service.send('notes:replace', '局势一');
        const rep1 = await service.clues.read('/side/notes/faction.md');
        expect(rep1!.body).toBe('第一版摘要内容');

        await service.send('notes:replace', '局势二');
        const rep2 = await service.clues.read('/side/notes/faction.md');
        expect(rep2!.body).toBe('第二版覆盖内容');
        expect(rep2!.body).not.toContain('第一版摘要内容');
        expect(rep2!.contentHash).not.toBe(rep1!.contentHash);
    });
});

describe('SideGenService & SideSessionStore — Causal Branch Rollback', () => {
    it('rolls back branch-scoped sessions on swipe switch while preserving chat-scoped sessions', async () => {
        const bridge = createOffMainlineTestBridge(); // has msg 0 (0#0) and msg 1 (1#0)
        const trajectoryStore = new TrajectoryStore();
        const transport = new ScriptedLLMTransport([
            { content: '分支Turn1回复(1#0)' },
            { content: '全聊天Turn1回复(1#0)' },
            { content: '分支Turn2A回复(2#0)' },
            { content: '全聊天Turn2回复(2#0)' },
            { content: '分支Turn3A回复(3#0)' },
            { content: '分支Turn2B回复(2#1)' },
        ]);

        const service = new SideGenService({
            bridge,
            transport,
            trajectoryStore,
            now: createDeterministicClock(),
        });

        await service.createSession({
            id: 'branch:phone',
            title: '分支手机',
            scope: 'branch',
            systemPrompt: '分支系统词',
        });
        await service.createSession({
            id: 'chat:rumor',
            title: '全聊天流言',
            scope: 'chat',
            systemPrompt: '全聊天系统词',
        });

        // At anchor 1#0
        await service.send('branch:phone', 'B1');
        await service.send('chat:rumor', 'C1');

        // Advance main chat to msg 2 (swipe 0)
        bridge.pushMessage({ name: '调查员', isUser: true, mes: '前进到第2楼', swipeId: 0 });
        await service.send('branch:phone', 'B2A');
        await service.send('chat:rumor', 'C2');

        // Advance main chat to msg 3 (swipe 0)
        bridge.pushMessage({ name: '林晚', isUser: false, mes: '前进到第3楼', swipeId: 0 });
        await service.send('branch:phone', 'B3A');

        expect((await service.getSession('branch:phone'))?.turns).toBe(3);
        expect((await service.getSession('chat:rumor'))?.turns).toBe(2);

        // User deletes msg 3 and swipes msg 2 from swipe 0 to swipe 1 (2#1)
        bridge.chat.pop();
        bridge.chat[2].swipeId = 1;
        bridge.chat[2].swipes = ['前进到第2楼', '第2楼备选分支'];
        bridge.chat[2].mes = '第2楼备选分支';

        const rollback = service.onBranchChanged({ messageId: 2, swipeId: 1 });
        expect(rollback.rolledBackSessionIds).toEqual(['branch:phone']);
        expect(rollback.skippedChatScopeIds).toEqual(['chat:rumor']);
        expect(rollback.prunedCheckpointCount).toBe(1); // 3#0 future checkpoint pruned

        // branch:phone rolled back to latest valid ancestor 1#0 (discards 2#0 & 3#0 turns from active state)
        const branchAfterRollback = await service.getSession('branch:phone');
        expect(branchAfterRollback?.turns).toBe(1);
        expect(branchAfterRollback?.anchor).toEqual({ messageId: 1, swipeId: 0 });
        const branchTranscript = await service.getTranscript('branch:phone');
        expect(branchTranscript.map((m) => m.content)).toEqual([
            '分支系统词',
            'B1',
            '分支Turn1回复(1#0)',
        ]);

        // chat:rumor completely unaffected
        const chatAfterRollback = await service.getSession('chat:rumor');
        expect(chatAfterRollback?.turns).toBe(2);
        const chatTranscript = await service.getTranscript('chat:rumor');
        expect(chatTranscript.map((m) => m.content)).toEqual([
            '全聊天系统词',
            'C1',
            '全聊天Turn1回复(1#0)',
            'C2',
            '全聊天Turn2回复(2#0)',
        ]);

        // Send a new turn on sibling branch 2#1
        await service.send('branch:phone', 'B2B');
        const transcript2B = await service.getTranscript('branch:phone');
        expect(transcript2B.map((m) => m.content)).toEqual([
            '分支系统词',
            'B1',
            '分支Turn1回复(1#0)',
            'B2B',
            '分支Turn2B回复(2#1)',
        ]);

        // Switch back to swipe 2#0 -> restores 2#0 losslessly (without 3#0 which was pruned!)
        bridge.chat[2].swipeId = 0;
        service.onBranchChanged({ messageId: 2, swipeId: 0 });
        const transcript2A = await service.getTranscript('branch:phone');
        expect(transcript2A.map((m) => m.content)).toEqual([
            '分支系统词',
            'B1',
            '分支Turn1回复(1#0)',
            'B2A',
            '分支Turn2A回复(2#0)',
        ]);
    });

    it('resets branch session to empty Layer 1 when rolled back before any valid ancestor checkpoint', async () => {
        const bridge = createOffMainlineTestBridge(); // msg 0, msg 1
        const transport = new ScriptedLLMTransport([{ content: '仅在 1#0 生成的回复' }]);
        const service = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(),
        });

        // Created at 1#0
        await service.createSession({
            id: 'branch:late',
            title: '后期会话',
            scope: 'branch',
            systemPrompt: '保留静态系统提示词',
        });
        await service.send('branch:late', '只在 1#0 发出的消息');

        // Swipe msg 1 to swipe 1 (1#1) — no ancestor checkpoint exists at msg 0
        bridge.chat[1].swipeId = 1;
        service.onBranchChanged({ messageId: 1, swipeId: 1 });

        const info = await service.getSession('branch:late');
        expect(info?.turns).toBe(0);
        const transcript = await service.getTranscript('branch:late');
        expect(transcript).toEqual([{ role: 'system', content: '保留静态系统提示词' }]);
    });

    it('reconstructs persisted sessions and branch checkpoints cleanly on reloadFromHost', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([{ content: '已持久化回复' }]);
        const service1 = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(),
        });

        await service1.createSession({
            id: 'phone:persist',
            title: '持久化测试',
            scope: 'branch',
            systemPrompt: '系统提示词',
        });
        await service1.send('phone:persist', '测试持久化');

        // Create a fresh SideSessionStore & SideGenService over the same HostBridge metadata
        const reloadedStore = new SideSessionStore({ bridge });
        const service2 = new SideGenService({
            bridge,
            transport,
            sessionStore: reloadedStore,
        });

        const loaded = await service2.getSession('phone:persist');
        expect(loaded?.turns).toBe(1);
        expect(loaded?.anchor).toEqual({ messageId: 1, swipeId: 0 });
        expect(await service2.getTranscript('phone:persist')).toEqual([
            { role: 'system', content: '系统提示词' },
            { role: 'user', content: '测试持久化' },
            { role: 'assistant', content: '已持久化回复' },
        ]);

        // List filter + deleteSession
        expect((await service2.listSessions({ scope: 'branch', branchKey: '1#0' })).map((s) => s.id))
            .toEqual(['phone:persist']);
        expect(await service2.deleteSession('phone:persist')).toBe(true);
        expect(await service2.getSession('phone:persist')).toBeNull();
        expect(reloadedStore.trajectoryStore.hasThread(toSideThreadId('phone:persist'))).toBe(false);
    });
});

describe('SideGenService — AbortSignal & Stale Race Write Protection', () => {
    it('aborts in-flight runOnce and send via caller AbortSignal without committing any writes', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            { content: '不应落地', delayMs: 60 },
            { content: '也不应落地', delayMs: 60 },
        ]);
        const service = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(),
        });

        await service.createSession({
            id: 'phone:abort',
            title: '中断测试',
            scope: 'branch',
            systemPrompt: '系统词',
            autoBridge: {
                path: '/side/comms/abort.md',
                delivery: 'radar_hint',
                keywords: ['测试'],
                title: '中断线索',
                mode: 'append',
            },
        });

        // 1. Abort runOnce mid-flight
        const ac1 = new AbortController();
        const oncePromise = service.runOnce({
            prompt: '一次性中断',
            bridge: { path: '/side/notes/aborted.md', delivery: 'radar_hint' },
            signal: ac1.signal,
        });
        setTimeout(() => ac1.abort(), 10);
        await expect(oncePromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(await service.clues.read('/side/notes/aborted.md')).toBeNull();

        // 2. Abort session send mid-flight
        const ac2 = new AbortController();
        const sendPromise = service.send('phone:abort', '会话中断', { signal: ac2.signal });
        setTimeout(() => ac2.abort(), 10);
        await expect(sendPromise).rejects.toMatchObject({ name: 'AbortError' });

        expect((await service.getSession('phone:abort'))?.turns).toBe(0);
        expect(await service.clues.read('/side/comms/abort.md')).toBeNull();
    });

    it('prevents stale race writes when branch anchor changes before LLM response commits', async () => {
        const bridge = createOffMainlineTestBridge();
        const transport = new ScriptedLLMTransport([
            // Simulate swipe happening right before transport resolves (without explicit abort call)
            async () => {
                bridge.chat[1].swipeId = 1;
                return { content: '过期分支产生的响应' };
            },
        ]);

        const service = new SideGenService({
            bridge,
            transport,
            now: createDeterministicClock(),
        });

        await service.createSession({
            id: 'phone:race',
            title: '竞态保护',
            scope: 'branch',
            systemPrompt: '系统词',
            autoBridge: {
                path: '/side/comms/race.md',
                delivery: 'radar_hint',
                keywords: ['竞态'],
                title: '竞态线索',
                mode: 'append',
            },
        });

        await expect(service.send('phone:race', '旧分支消息')).rejects.toMatchObject({
            name: 'AbortError',
        });

        // Zero stale commits to TrajectoryStore, SideSessionStore, or /side/*
        expect((await service.getSession('phone:race'))?.turns).toBe(0);
        expect(await service.getTranscript('phone:race')).toEqual([
            { role: 'system', content: '系统词' },
        ]);
        expect(await service.clues.read('/side/comms/race.md', { messageId: 1, swipeId: 0 })).toBeNull();
        expect(await service.clues.read('/side/comms/race.md', { messageId: 1, swipeId: 1 })).toBeNull();
    });

    it('aborts in-flight send when onBranchChanged or onChatChanged fires', async () => {
        const bridge = new MemoryHostBridge({
            chat: [
                { id: 0, name: 'User', isUser: true, mes: 'Hi', swipeId: 0 },
            ],
        });
        const transport = new ScriptedLLMTransport([
            { content: '切卡前过期响应', delayMs: 80 },
        ]);
        const service = new SideGenService({ bridge, transport });

        await service.createSession({
            id: 'chat:switch',
            title: '切卡测试',
            scope: 'chat',
            systemPrompt: '系统词',
        });

        const pending = service.send('chat:switch', '正在生成...');
        setTimeout(() => {
            bridge.metadata = {};
            service.onChatChanged({ reloadTrajectory: true });
        }, 10);

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(await service.listSessions()).toEqual([]);
    });

    it('takes over SideGen systemPrompt via {{systemBase}} in sidegen-triggered blocks for runOnce and persistent sessions', async () => {
        const bridge = createOffMainlineTestBridge();
        const settings = createDefaultSettings();
        settings.presets.default.agents.main.promptBlocks = [
            {
                id: 'sidegen_user_base',
                name: 'SideGen User Base',
                role: 'user',
                placement: 'prefix',
                content: '线外接管：{{systemBase}}',
                enabled: true,
                triggers: ['sidegen'],
            },
        ];

        const transport = new ScriptedLLMTransport([
            { content: 'once ok' },
            { content: 'session ok' },
        ]);
        const service = new SideGenService({
            bridge,
            transport,
            getSettings: () => settings,
            now: createDeterministicClock(),
        });

        await service.runOnce({
            systemPrompt: '你是线外观察员。',
            prompt: '汇报情况',
        });
        const onceReq = transport.requests[0]!;
        expect(onceReq.messages.some((m) => m.role === 'system')).toBe(false);
        expect(onceReq.messages[0]).toEqual({
            role: 'user',
            content: '线外接管：你是线外观察员。',
        });

        await service.createSession({
            id: 'phone:takeover',
            title: '线外接管会话',
            scope: 'branch',
            systemPrompt: '你是线外联络员。',
        });
        await service.send('phone:takeover', '收到请回答');
        const sendReq = transport.requests[1]!;
        expect(sendReq.messages.some((m) => m.role === 'system')).toBe(false);
        expect(sendReq.messages[0]).toEqual({
            role: 'user',
            content: '线外接管：你是线外联络员。',
        });
    });
});
