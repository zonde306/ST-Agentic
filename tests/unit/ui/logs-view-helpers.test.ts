import { describe, expect, it, vi } from 'vitest';
import type { AgentRunTrace, AssistantRoundLog } from '@/core/types';
import {
    getRenderableRoundParts,
    matchesTraceSearch,
    resolveTraceAssistantSummary,
} from '@/ui/session/LogsView';
import { createMockUIServices } from '@/ui/store';

function makeTrace(overrides: Partial<AgentRunTrace> = {}): AgentRunTrace {
    return {
        runId: 'run_unit_1',
        target: { messageId: 12, swipeId: 0 },
        phase: 'main_turn',
        agentProfileId: 'main',
        agentName: '主叙事 Agent',
        connectionId: 'conn_1',
        model: 'claude-sonnet-4.5',
        status: 'completed',
        startedAt: 1000,
        endedAt: 2000,
        durationMs: 1000,
        usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 20, cacheHitRate: 0.8 },
        toolSteps: [],
        ...overrides,
    };
}

describe('LogsView helpers & mock services (Wave 2)', () => {
    it('converges Assistant 输出摘要 across new and legacy trace shapes', () => {
        // 1. Explicit assistantSummary wins over outputPreview
        const newWithSummary = makeTrace({
            assistantRounds: [
                { roundIndex: 0, beforeStepIndex: 0, content: '中间说明', timestamp: 1100 },
            ],
            assistantSummary: '最终收尾总结（完整文本）',
            outputPreview: '旧预览文本',
        });
        expect(resolveTraceAssistantSummary(newWithSummary)).toBe('最终收尾总结（完整文本）');

        // 2. New trace carrying assistantRounds without assistantSummary does NOT fall back to outputPreview
        const newMidTurnError = makeTrace({
            status: 'error',
            assistantRounds: [
                { roundIndex: 0, beforeStepIndex: 0, content: '我先去查一下设定', timestamp: 1100 },
            ],
            outputPreview: '我先去查一下设定',
        });
        expect(resolveTraceAssistantSummary(newMidTurnError)).toBeNull();

        // 3. Legacy trace (no assistantRounds & no assistantSummary) falls back to outputPreview
        const legacyTrace = makeTrace({
            outputPreview: '旧版日志正文预览',
        });
        expect(resolveTraceAssistantSummary(legacyTrace)).toBe('旧版日志正文预览');

        // 4. Whitespace-only assistantSummary resolves to null
        const blankSummary = makeTrace({
            assistantSummary: '   \n\t  ',
            outputPreview: '不应回退',
        });
        expect(resolveTraceAssistantSummary(blankSummary)).toBeNull();
    });

    it('extracts renderable round interlude parts without duplicating closing summaries', () => {
        const trace = makeTrace({
            toolSteps: [
                {
                    stepIndex: 0,
                    toolCallId: 'c1',
                    toolName: 'read_file',
                    args: { path: '/state/variables.json' },
                    result: '{}',
                    ok: true,
                    durationMs: 5,
                    startedAt: 1200,
                },
            ],
            assistantSummary: '这是最终收尾回复',
        });

        const midRound: AssistantRoundLog = {
            roundIndex: 0,
            beforeStepIndex: 0,
            reasoning: '先读变量',
            content: '正在查看当前状态',
            timestamp: 1100,
        };
        expect(getRenderableRoundParts(midRound, trace)).toEqual({
            reasoning: '先读变量',
            content: '正在查看当前状态',
        });

        // Finish-turn round keeps reasoning but suppresses closing content
        const finishRound: AssistantRoundLog = {
            roundIndex: 1,
            beforeStepIndex: 1,
            reasoning: '复核完毕准备结束',
            content: '这是最终收尾回复',
            isFinishTurn: true,
            finishTurnSummary: '这是最终收尾回复',
            timestamp: 1500,
        };
        expect(getRenderableRoundParts(finishRound, trace)).toEqual({
            reasoning: '复核完毕准备结束',
            content: null,
        });

        // Trailing non-finish round matching assistantSummary keeps reasoning and avoids duplicating text
        const trailingMatchRound: AssistantRoundLog = {
            roundIndex: 1,
            beforeStepIndex: 1,
            reasoning: '最后组织语言',
            content: '这是最终收尾回复',
            timestamp: 1600,
        };
        expect(getRenderableRoundParts(trailingMatchRound, trace)).toEqual({
            reasoning: '最后组织语言',
            content: null,
        });

        // Trailing mid-turn round when no assistantSummary exists shows both reasoning & content
        const erroredTrace = makeTrace({
            status: 'error',
            assistantRounds: [],
        });
        const interruptedTrailing: AssistantRoundLog = {
            roundIndex: 0,
            beforeStepIndex: 0,
            reasoning: '分析中断原因',
            content: '尚未完成的部分输出',
            timestamp: 1300,
        };
        expect(getRenderableRoundParts(interruptedTrailing, erroredTrace)).toEqual({
            reasoning: '分析中断原因',
            content: '尚未完成的部分输出',
        });
    });

    it('includes assistantRounds reasoning, content, finishTurnSummary, and assistantSummary in matchesTraceSearch', () => {
        const trace = makeTrace({
            assistantSummary: '银莲花密道已解锁',
            assistantRounds: [
                {
                    roundIndex: 0,
                    beforeStepIndex: 0,
                    reasoning: '检索青云宗禁地暗格线索',
                    content: '准备调用读取档案工具',
                    finishTurnSummary: '汇总结果卡片',
                    timestamp: 1100,
                },
            ],
        });

        expect(matchesTraceSearch(trace, '禁地暗格')).toBe(true);
        expect(matchesTraceSearch(trace, '读取档案工具')).toBe(true);
        expect(matchesTraceSearch(trace, '汇总结果卡片')).toBe(true);
        expect(matchesTraceSearch(trace, '密道已解锁')).toBe(true);
        expect(matchesTraceSearch(trace, '完全不相关的关键字XYZ')).toBe(false);
    });

    it('provides clean mock implementations for stopTrace, continueTrace, retryTrace, and clearAllPromptCaches', async () => {
        const services = createMockUIServices();
        const events: string[] = [];
        const unsub = services.subscribeEvents?.((ev) => {
            events.push(ev.kind);
        });

        try {
            // clearAllPromptCaches
            const cleared = await services.clearAllPromptCaches?.();
            expect(cleared).toBeDefined();
            expect(cleared!.clearedPrefixes).toBeGreaterThan(0);
            expect(cleared!.clearedVfsCache).toBeGreaterThan(0);
            expect(cleared!.clearedLorebooks).toBeGreaterThan(0);

            // stopTrace returns false on completed trace, true on running trace
            const completedTrace = makeTrace({ status: 'completed' });
            expect(await services.stopTrace?.(completedTrace)).toBe(false);

            const runningTrace = makeTrace({ runId: 'run_running_mock', status: 'running' });
            expect(await services.stopTrace?.(runningTrace)).toBe(true);
            expect(events).toContain('trace_recorded');

            // continueTrace supports rollbackLastToolRound
            const erroredTrace = makeTrace({
                runId: 'run_err_mock',
                status: 'error',
                hasRollbackableRound: true,
                toolSteps: [
                    {
                        stepIndex: 0,
                        toolCallId: 'c1',
                        toolName: 'read_file',
                        args: { path: '/a.md' },
                        result: 'ok',
                        ok: true,
                        durationMs: 2,
                        startedAt: 1000,
                    },
                ],
            });
            await services.continueTrace?.(erroredTrace, { rollbackLastToolRound: true });
            expect(events).toContain('turn_resumed');

            // retryTrace delegates after_turn to this.rerunAfterTurn (even when overridden via spread)
            const rerunSpy = vi.fn(async () => undefined);
            const overridden = { ...services, rerunAfterTurn: rerunSpy };
            const afterTurnErr = makeTrace({
                runId: 'run_after_err',
                phase: 'after_turn',
                triggerId: 'tr_a, tr_b',
                status: 'error',
            });
            await overridden.retryTrace?.(afterTurnErr);
            expect(rerunSpy).toHaveBeenCalledTimes(1);
            expect(rerunSpy).toHaveBeenCalledWith(
                { messageId: 12, swipeId: 0 },
                { triggerIds: ['tr_a', 'tr_b'] },
            );
        } finally {
            unsub?.();
        }
    });
});
