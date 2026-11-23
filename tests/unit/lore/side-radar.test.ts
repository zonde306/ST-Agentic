import { describe, expect, it } from 'vitest';
import { createDefaultMainAgent } from '@/core/config';
import { ContextAssembler, TrajectoryStore } from '@/core/context';
import { TailRadar } from '@/core/lore';
import type { CanonicalToolSchema, SideClueDoc } from '@/core/types';
import { canonicalStringify, parseSideClue } from '@/core/utils';
import { VirtualFileSystem } from '@/core/vfs';
import {
    SAMPLE_ISOLATED_NOTE_RAW,
    SAMPLE_LINWAN_COMMS_RAW,
    SAMPLE_NEXT_TURN_BRIEF_RAW,
    SAMPLE_VFS_ONLY_RUMOR_RAW,
    createOffMainlineTestBridge,
} from '../../fixtures/off-mainline-fixtures';

async function loadFixtureClues(): Promise<SideClueDoc[]> {
    return await Promise.all([
        parseSideClue('/side/comms/linwan.md', SAMPLE_LINWAN_COMMS_RAW),
        parseSideClue('/side/notes/dock-brief.md', SAMPLE_NEXT_TURN_BRIEF_RAW),
        parseSideClue('/side/rumors/harbor.md', SAMPLE_VFS_ONLY_RUMOR_RAW),
        parseSideClue('/side/notes/private.md', SAMPLE_ISOLATED_NOTE_RAW),
    ]);
}

describe('TailRadar.scanSideClues & ContextAssembler Layer 2 side bridge', () => {
    it('enforces all 4 delivery modes: radar_hint triggers, none/vfs_only/next_turn_brief stay silent on radar', async () => {
        const bridge = createOffMainlineTestBridge();
        const radar = TailRadar.fromBridge(bridge);
        const clues = await loadFixtureClues();

        // Mention keywords from ALL four fixtures simultaneously:
        // - radar_hint: 老码头
        // - next_turn_brief: 巡逻
        // - vfs_only: 走私船
        // - none: 咖啡馆
        const result = radar.scanSideClues(
            clues,
            '我们在咖啡馆听说走私船将在老码头靠岸，而东区巡逻队正在换防。',
        );

        expect(result.candidates).toHaveLength(1);
        expect(result.totalMatched).toBe(1);
        expect(result.overflowCount).toBe(0);
        expect(result.candidates[0]).toMatchObject({
            path: '/side/comms/linwan.md',
            id: 'clue_linwan_comms',
            title: '林晚的加密通讯线索',
            status: 'unread',
            matchedKeywords: ['老码头'],
        });
        expect(result.hintXml).toContain('<side-hint>');
        expect(result.hintXml).toContain('[未读] 林晚的加密通讯线索 (/side/comms/linwan.md)');
        expect(result.hintXml).toContain('林晚已在老码头旧仓库灯塔下接应');
        expect(result.hintXml).not.toContain('/side/rumors/harbor.md');
        expect(result.hintXml).not.toContain('/side/notes/private.md');
        expect(result.hintXml).not.toContain('/side/notes/dock-brief.md');
    });

    it('supports parseLoreRegex, secondaryKeys, scanDepth, resolved skipping, and topK overflow', async () => {
        const bridge = createOffMainlineTestBridge();
        const radar = TailRadar.fromBridge(bridge);

        const vfs = new VirtualFileSystem({ bridge });
        const regexClue = await vfs.writeSideClue({
            path: '/side/comms/radio.md',
            title: '加密电台频道',
            delivery: 'radar_hint',
            keywords: ['/freq\\s+148\\.5/ig'],
            secondaryKeys: ['{{char}}', '接头'],
            scanDepth: 1,
            order: 200,
            summary: '148.5MHz 频道已启用。',
            body: '电台频段记录。',
        });

        const resolvedClue = await vfs.writeSideClue({
            path: '/side/notes/closed.md',
            title: '已结案线索',
            delivery: 'radar_hint',
            status: 'resolved',
            keywords: ['老码头'],
            summary: '已完成，不应再触发。',
            body: '归档内容。',
        });

        const extra1 = await vfs.writeSideClue({
            path: '/side/rumors/r1.md',
            title: '流言一',
            delivery: 'radar_hint',
            keywords: ['老码头'],
            order: 90,
            summary: '流言一摘要。',
            body: '正文一',
        });

        const extra2 = await vfs.writeSideClue({
            path: '/side/rumors/r2.md',
            title: '流言二',
            delivery: 'radar_hint',
            keywords: ['老码头'],
            order: 80,
            summary: '流言二摘要。',
            body: '正文二',
        });

        // Regex matches primary but missing secondaryKey -> must NOT match
        const missingSecondary = radar.scanSideClues([regexClue], '收到 FREQ 148.5 信号');
        expect(missingSecondary.candidates).toHaveLength(0);
        expect(missingSecondary.hintXml).toBe('');

        // Regex + macro-substituted secondaryKey ("{{char}}" -> "林晚") -> matches cleanly and stays stateless
        const hit1 = radar.scanSideClues([regexClue], '林晚在 FREQ 148.5 发来讯号');
        const hit2 = radar.scanSideClues([regexClue], '接头频段 freq 148.5');
        expect(hit1.candidates.map((c) => c.path)).toEqual(['/side/comms/radio.md']);
        expect(hit2.candidates.map((c) => c.path)).toEqual(['/side/comms/radio.md']);

        // scanDepth=1 ignores older recentMessages
        const depthSkipped = radar.scanSideClues([regexClue], {
            input: '今晚风平浪静。',
            recentMessages: ['林晚在 freq 148.5 呼叫'],
        });
        expect(depthSkipped.candidates).toHaveLength(0);

        // Resolved clue is never surfaced; topK=1 caps output and reports overflowCount=1
        const capped = radar.scanSideClues([resolvedClue, extra2, extra1], {
            input: '前往老码头调查',
            topK: 1,
        });
        expect(capped.totalMatched).toBe(2);
        expect(capped.candidates).toHaveLength(1);
        expect(capped.candidates[0].path).toBe('/side/rumors/r1.md');
        expect(capped.overflowCount).toBe(1);
        expect(capped.hintXml).toContain('+1 条更多线外线索匹配');
    });

    it('deduplicates via xxHash Read-Set (100% silent when unchanged) and re-triggers with [已更新] when contentHash changes', async () => {
        const bridge = createOffMainlineTestBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const radar = TailRadar.fromBridge(bridge);
        const readSet = new Map<string, string>();

        const target = { messageId: 1, swipeId: 0 };
        await vfs.writeFile('/side/comms/linwan.md', SAMPLE_LINWAN_COMMS_RAW, { target });

        // 1. First scan -> [未读]
        const cluesV1 = await vfs.listSideClues(target);
        const scan1 = radar.scanSideClues(cluesV1, {
            input: '我们今晚去老码头灯塔。',
            readSet,
        });
        expect(scan1.candidates).toHaveLength(1);
        expect(scan1.candidates[0].status).toBe('unread');
        expect(scan1.hintXml).toContain('[未读]');

        // Simulate main agent reading the file and recording its xxHash into Read-Set
        readSet.set(scan1.candidates[0].path, scan1.candidates[0].contentHash);

        // 2. Second scan with identical file -> 100% silent
        const scan2 = radar.scanSideClues(cluesV1, {
            input: '再确认一次老码头灯塔的接头时间。',
            readSet,
        });
        expect(scan2.candidates).toHaveLength(0);
        expect(scan2.totalMatched).toBe(0);
        expect(scan2.hintXml).toBe('');

        // 3. SideGen updates /side/comms/linwan.md -> contentHash changes -> re-triggers as [已更新]!
        await vfs.appendFile('/side/comms/linwan.md', '\n- [19:00 林晚]: 紧急变更：改在三号泊位汇合。', {
            target,
        });
        const cluesV2 = await vfs.listSideClues(target);
        const scan3 = radar.scanSideClues(cluesV2, {
            input: '出发前往老码头。',
            readSet,
        });
        expect(scan3.candidates).toHaveLength(1);
        expect(scan3.candidates[0].status).toBe('updated');
        expect(scan3.candidates[0].contentHash).not.toBe(scan1.candidates[0].contentHash);
        expect(scan3.hintXml).toContain('<side-hint>');
        expect(scan3.hintXml).toContain('[已更新] 林晚的加密通讯线索 (/side/comms/linwan.md)');

        // 4. After re-reading updated version -> silent again
        readSet.set(scan3.candidates[0].path, scan3.candidates[0].contentHash);
        const scan4 = radar.scanSideClues(cluesV2, {
            input: '已经抵达老码头。',
            readSet,
        });
        expect(scan4.candidates).toHaveLength(0);
        expect(scan4.hintXml).toBe('');
    });

    it('injects <side-hint> and one-shot <side-brief> strictly in Layer 2 while keeping Layer 0 and historical Layer 1 byte-identical', async () => {
        const bridge = createOffMainlineTestBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const store = new TrajectoryStore();
        const radar = TailRadar.fromBridge(bridge);
        const assembler = new ContextAssembler();
        const agent = createDefaultMainAgent();
        const tools: CanonicalToolSchema[] = [
            {
                name: 'read_file',
                description: 'Read a VFS file',
                parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
            },
        ];

        const target = { messageId: 1, swipeId: 0 };

        // Turn 1: baseline without any /side/* clues
        const turn1 = await assembler.assembleWithHost({
            agent,
            tools,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            vfs,
            target,
            userInput: '我们在雾港雨夜整理行装。',
        });
        expect(turn1.consumedSideBriefPaths).toEqual([]);
        expect(turn1.layer2Messages[0].content).not.toContain('<side-hint>');
        expect(turn1.layer2Messages[0].content).not.toContain('<side-brief>');

        // Freeze Turn 1 into Layer 1
        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: agent.id,
            target,
            turnMessages: turn1.layer2Messages,
            finalAssistantMessage: { role: 'assistant', content: '雨声拍打着窗棂，调查员检查了手电。' },
        });

        const baselineLayer0Json = canonicalStringify(turn1.layer0Messages);
        const baselineToolsJson = canonicalStringify(turn1.request.tools);
        const baselineLayer1Json = canonicalStringify(store.getMessages(agent.id));

        // Now populate all 4 delivery modes in /side/*
        await vfs.writeFile('/side/comms/linwan.md', SAMPLE_LINWAN_COMMS_RAW, { target });
        await vfs.writeFile('/side/notes/dock-brief.md', SAMPLE_NEXT_TURN_BRIEF_RAW, { target });
        await vfs.writeFile('/side/rumors/harbor.md', SAMPLE_VFS_ONLY_RUMOR_RAW, { target });
        await vfs.writeFile('/side/notes/private.md', SAMPLE_ISOLATED_NOTE_RAW, { target });

        // Turn 2: triggers <side-hint> (radar_hint) AND surfaces one-shot <side-brief> (next_turn_brief)
        const turn2 = await assembler.assembleWithHost({
            agent,
            tools,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            vfs,
            target,
            userInput: '现在动身去老码头，咖啡馆和走私船先不管。',
        });

        // STRICT KV CACHE RED LINE: Layer 0, tools, and historical Layer 1 are 100% byte-identical!
        expect(canonicalStringify(turn2.layer0Messages)).toBe(baselineLayer0Json);
        expect(canonicalStringify(turn2.request.tools)).toBe(baselineToolsJson);
        expect(canonicalStringify(turn2.layer1Messages)).toBe(baselineLayer1Json);

        // Layer 2 carries <side-brief> and <side-hint> ONLY for eligible clues
        const turn2Content = turn2.layer2Messages[0].content as string;
        expect(turn2Content).toContain('<side-brief>');
        expect(turn2Content).toContain('东区巡逻换防紧急通报 (/side/notes/dock-brief.md)');
        expect(turn2Content).toContain('<side-hint>');
        expect(turn2Content).toContain('/side/comms/linwan.md');
        expect(turn2Content).not.toContain('/side/rumors/harbor.md');
        expect(turn2Content).not.toContain('/side/notes/private.md');

        // Consumed next_turn_brief paths returned for caller persistence
        expect(turn2.consumedSideBriefPaths).toEqual(['/side/notes/dock-brief.md']);
        expect(turn2.sideHintResult?.candidates).toHaveLength(1);

        // Mid-turn inFlightMessages must NOT re-consume next_turn_brief clues
        const inFlight = await assembler.assembleWithHost({
            agent,
            tools,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            vfs,
            target,
            inFlightMessages: turn2.layer2Messages,
        });
        expect(inFlight.consumedSideBriefPaths).toEqual([]);
        expect(canonicalStringify(inFlight.layer0Messages)).toBe(baselineLayer0Json);
        expect(canonicalStringify(inFlight.layer1Messages)).toBe(baselineLayer1Json);

        // Caller marks next_turn_brief consumed AND marks linwan clue read in Read-Set, then finalizes Turn 2
        await vfs.markSideCluesConsumed(turn2.consumedSideBriefPaths, 2, { target });
        store.markRead(
            turn2.sideHintResult!.candidates[0].path,
            turn2.sideHintResult!.candidates[0].contentHash,
            agent.id,
        );
        assembler.finalizeTurn({
            trajectoryStore: store,
            agentId: agent.id,
            target,
            turnMessages: turn2.layer2Messages,
            finalAssistantMessage: { role: 'assistant', content: '你沿着防波堤潜行接近旧仓库。' },
        });
        const postTurn2Layer1Json = canonicalStringify(store.getMessages(agent.id));

        // Turn 3: next_turn_brief was consumed & radar_hint is in Read-Set -> ZERO side noise, Layer 0/1 invariant!
        // Even though Turn 2's frozen Layer 1 contains <side-hint> / <side-brief>, stripTailMetadataTags prevents echo.
        const turn3 = await assembler.assembleWithHost({
            agent,
            tools,
            hostBridge: bridge,
            trajectoryStore: store,
            tailRadar: radar,
            vfs,
            target,
            userInput: '推开仓库侧门观察四周。',
        });

        expect(canonicalStringify(turn3.layer0Messages)).toBe(baselineLayer0Json);
        expect(canonicalStringify(turn3.layer1Messages)).toBe(postTurn2Layer1Json);
        expect(turn3.consumedSideBriefPaths).toEqual([]);
        expect(turn3.layer2Messages[0].content).not.toContain('<side-brief>');
        expect(turn3.layer2Messages[0].content).not.toContain('<side-hint>');
    });
});
