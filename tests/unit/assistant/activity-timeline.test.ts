import { describe, expect, it } from 'vitest';
import { AssistantRunner } from '@/core/assistant';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { TraceLogger } from '@/core/logger';
import type { AssistantMessage } from '@/core/types';
import {
    buildActivityTimeline,
    extractPrimaryArg,
    splitFirstSentence,
} from '@/ui/assistant/activity-timeline-model';
import { createOffMainlineTestBridge } from '../../fixtures/off-mainline-fixtures';
import { ScriptedLLMTransport, type ScriptedTurnInput } from '../../mocks/scripted-llm';

function createRunner(turns: ScriptedTurnInput[], stream: boolean) {
    const transport = new ScriptedLLMTransport(turns);
    const runner = new AssistantRunner({
        bridge: createOffMainlineTestBridge(),
        transport,
        trajectoryStore: new TrajectoryStore(),
        traceLogger: new TraceLogger(),
        settings: createDefaultSettings(),
        stream,
        autoRetry: false,
    });
    return { runner, transport };
}

const MULTI_ROUND_TURNS: ScriptedTurnInput[] = [
    {
        reasoningContent: '先看看根目录。然后决定下一步。',
        content: '我先列一下目录。',
        toolCalls: [
            { id: 'call_a', name: 'list_dir', arguments: JSON.stringify({ path: '/' }) },
            { id: 'call_b', name: 'list_dir', arguments: JSON.stringify({ path: '/character' }) },
        ],
    },
    {
        reasoningContent: '目录里有角色卡。',
        toolCalls: [
            { id: 'call_c', name: 'grep_search', arguments: JSON.stringify({ pattern: 'name' }) },
        ],
    },
    {
        reasoningContent: '可以总结了。',
        content: '总结完毕。',
    },
];

describe('Assistant activity timeline (per-round think / preface / tools)', () => {
    for (const stream of [true, false]) {
        it(`records one activity step per model round (stream=${stream})`, async () => {
            const { runner, transport } = createRunner(MULTI_ROUND_TURNS, stream);
            const session = await runner.createSession({ title: 'timeline', mode: 'chat' });
            const msg = await runner.sendPrompt(session.id, '看看目录');

            expect(msg.activity).toHaveLength(3);
            const [s1, s2, s3] = msg.activity!;
            expect(s1.think).toBe('先看看根目录。然后决定下一步。');
            expect(s1.preface).toBe('我先列一下目录。');
            expect(s1.toolCallIds).toEqual(['call_a', 'call_b']);
            expect(s2.think).toBe('目录里有角色卡。');
            expect(s2.preface).toBeUndefined();
            expect(s2.toolCallIds).toEqual(['call_c']);
            expect(s3.think).toBe('可以总结了。');
            expect(s3.toolCallIds).toEqual([]);
            expect(typeof s1.thinkMs).toBe('number');

            // Replay views stay concatenated & untouched (KV-cache invariance).
            expect(msg.think).toBe('先看看根目录。然后决定下一步。目录里有角色卡。可以总结了。');
            expect(msg.content).toContain('我先列一下目录。');
            expect(msg.content).toContain('总结完毕。');
            expect(JSON.stringify(transport.requests)).not.toContain('toolCallIds');

            const timeline = buildActivityTimeline(msg);
            expect(timeline.finalContent).toBe('总结完毕。');
            expect(timeline.steps).toHaveLength(3);
            expect(timeline.steps[0].title).toBe('先看看根目录');
            expect(timeline.steps[0].body).toBe('然后决定下一步。');
            expect(timeline.steps[0].groups).toHaveLength(1);
            expect(timeline.steps[0].groups[0].calls.map((c) => c.id)).toEqual(['call_a', 'call_b']);
            expect(timeline.toolCount).toBe(3);
            expect(timeline.livePhase).toBeNull();
        });
    }
});

describe('activity-timeline-model', () => {
    const legacy: AssistantMessage = {
        id: 'legacy_1',
        role: 'assistant',
        content: '完成。',
        think: '读取配置。确认无误。',
        toolCalls: [
            {
                id: 't1',
                name: 'read_file',
                scopeLabel: 'VFS',
                status: 'ok',
                durationMs: 5,
                argsSummary: '{"path":"/state/variables.json"}',
                resultSummary: '{}',
            },
            {
                id: 't2',
                name: 'grep_search',
                scopeLabel: 'VFS Search',
                status: 'error',
                durationMs: 1,
                argsSummary: '{"pattern":"blur"}',
                resultSummary: 'boom',
            },
        ],
        timestamp: 1,
    };

    it('folds legacy messages (no activity) into one synthesized round', () => {
        const timeline = buildActivityTimeline(legacy);
        expect(timeline.steps).toHaveLength(1);
        expect(timeline.steps[0].title).toBe('读取配置');
        expect(timeline.steps[0].groups).toHaveLength(2);
        expect(timeline.steps[0].hasError).toBe(true);
        expect(timeline.errorCount).toBe(1);
        expect(timeline.finalContent).toBe('完成。');
    });

    it('marks unresolved tool calls of the live round as running', () => {
        const live: AssistantMessage = {
            ...legacy,
            content: '',
            think: '想一想。',
            toolCalls: [],
            activity: [{ id: 's1', startedAt: 1, think: '想一想。', toolCallIds: ['x1', 'x2'] }],
        };
        const timeline = buildActivityTimeline(live, { isStreaming: true });
        expect(timeline.livePhase).toBe('tools');
        expect(timeline.liveTotalTools).toBe(2);
        expect(timeline.steps[0].groups.flatMap((g) => g.calls).every((c) => c.state === 'running')).toBe(true);
        const settled = buildActivityTimeline(live);
        expect(settled.steps[0].groups[0].calls[0].state).toBe('pending');
    });

    it('extracts primary args from complete and truncated summaries', () => {
        expect(extractPrimaryArg('{"path":"/tmp/a.json","offset":0}')).toBe('/tmp/a.json');
        expect(extractPrimaryArg('{"pattern":"setInterval|blur","path":"/tmp"}')).toBe('/tmp');
        expect(extractPrimaryArg('{"pattern":"setInterval|blur"}')).toBe('"setInterval|blur"');
        expect(extractPrimaryArg('{"scope":"character","content":"very long…')).toBe('character');
        expect(extractPrimaryArg('')).toBe('');
    });

    it('splits first sentence and truncates overly long headlines', () => {
        expect(splitFirstSentence('**分析** 脚本体积。下一步读取。')).toEqual({
            title: '分析 脚本体积',
            rest: '下一步读取。',
        });
        const long = '这'.repeat(60);
        const split = splitFirstSentence(long);
        expect(split.title.endsWith('…')).toBe(true);
        expect(split.rest).toBe(long);
    });
});
