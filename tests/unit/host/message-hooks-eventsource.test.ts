import { beforeEach, describe, expect, it, vi } from 'vitest';

const stMocks = vi.hoisted(() => {
    const events: Record<string, Array<(...args: unknown[]) => unknown>> = {};

    const eventSource = {
        events,
        on(event: string, listener: (...args: unknown[]) => unknown) {
            (events[event] ??= []).push(listener);
        },
        makeFirst(event: string, listener: (...args: unknown[]) => unknown) {
            (events[event] ??= []).unshift(listener);
        },
        makeLast(event: string, listener: (...args: unknown[]) => unknown) {
            (events[event] ??= []).push(listener);
        },
        removeListener(event: string, listener: (...args: unknown[]) => unknown) {
            const list = events[event];
            if (!list) {
                return;
            }
            const idx = list.indexOf(listener);
            if (idx >= 0) {
                list.splice(idx, 1);
            }
        },
        emit: vi.fn(async (event: string, ...args: unknown[]) => {
            const list = [...(events[event] ?? [])];
            for (const fn of list) {
                await fn(...args);
            }
        }),
        clearAll() {
            for (const key of Object.keys(events)) {
                delete events[key];
            }
            eventSource.emit.mockClear();
        },
    };

    const state = {
        chat: [
            { name: 'User', is_user: true, is_system: false, mes: 'Hello' },
            { name: 'Alice', is_user: false, is_system: false, mes: '' },
        ] as Array<Record<string, unknown>>,
        chat_metadata: {} as Record<string, unknown>,
        extension_settings: {} as Record<string, unknown>,
    };

    return { eventSource, state };
});

vi.mock('@st/script.js', () => ({
    addCopyToCodeBlocks: vi.fn(),
    addOneMessage: vi.fn(),
    appendMediaToMessage: vi.fn(),
    characters: [],
    chat: stMocks.state.chat,
    chat_metadata: stMocks.state.chat_metadata,
    deleteMessage: vi.fn(),
    getCharacterCardFields: vi.fn(() => ({})),
    messageFormatting: vi.fn((text: string) => text),
    name1: 'User',
    name2: 'Alice',
    refreshSwipeButtons: vi.fn(),
    saveChatDebounced: vi.fn(),
    saveSettingsDebounced: vi.fn(),
    substituteParams: vi.fn((text: string) => text),
    syncMesToSwipe: vi.fn(),
    this_chid: 0,
    updateMessageBlock: vi.fn(),
    updateViewMessageIds: vi.fn(),
}));

vi.mock('@st/scripts/constants.js', () => ({
    MEDIA_SOURCE: {},
    MEDIA_TYPE: {},
}));

vi.mock('@st/scripts/events.js', () => ({
    eventSource: stMocks.eventSource,
    event_types: {
        MESSAGE_UPDATED: 'message_updated',
        USER_MESSAGE_RENDERED: 'user_message_rendered',
        CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    },
}));

vi.mock('@st/scripts/extensions.js', () => ({
    extension_settings: stMocks.state.extension_settings,
    saveMetadataDebounced: vi.fn(),
}));

vi.mock('@st/scripts/personas.js', () => ({
    user_avatar: 'user.png',
}));

vi.mock('@st/scripts/power-user.js', () => ({
    power_user: {},
}));

vi.mock('@st/scripts/reasoning.js', () => ({
    updateReasoningUI: vi.fn(),
}));

vi.mock('@st/scripts/utils.js', () => ({
    getCharaFilename: vi.fn(() => 'alice'),
}));

vi.mock('@st/scripts/world-info.js', () => ({
    loadWorldInfo: vi.fn(async () => ({ entries: {} })),
    METADATA_KEY: 'world',
    selected_world_info: [],
    world_info: { globalSelect: [], charLore: [] },
}));

vi.mock('@/host/st-admin-bridge', () => ({
    STAdminBridge: class {},
}));

vi.mock('@/host/st-author-bridge', () => ({
    STAuthorBridge: class {},
}));

import { AgentRunner } from '@/core/agents';
import {
    type LLMRequest,
    type LLMResponse,
    type LLMTransport,
    type OutputPostprocessHookPayload,
    PROMPT_TRANSFORM_EVENTS,
    type PromptPreprocessHookPayload,
    createOutputPostprocessPayload,
    createPromptPreprocessPayload,
    runOutputPostprocessHook,
    runPromptPreprocessHook,
} from '@/core/bridge';
import { createDefaultSettings } from '@/core/config';
import { TrajectoryStore } from '@/core/context';
import { createEphemeralMessagesController } from '@/core/llm';
import { STHostBridge } from '@/host/st-bridge';
import { IframeJsSandbox } from '@/sandbox';

class QueueTransport implements LLMTransport {
    readonly requests: LLMRequest[] = [];
    private readonly queue: Array<(req: LLMRequest) => LLMResponse> = [];

    enqueue(...items: Array<Partial<LLMResponse> | ((req: LLMRequest) => Partial<LLMResponse>)>) {
        for (const item of items) {
            this.queue.push((req) => {
                const raw = typeof item === 'function' ? item(req) : item;
                return {
                    content: raw.content ?? '',
                    ...(raw.reasoningContent !== undefined
                        ? { reasoningContent: raw.reasoningContent }
                        : {}),
                    toolCalls: raw.toolCalls ?? [],
                    usage: raw.usage ?? {
                        inputTokens: 100,
                        cachedTokens: 0,
                        outputTokens: 20,
                        totalTokens: 120,
                    },
                    finishReason: raw.finishReason ?? 'stop',
                };
            });
        }
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(request);
        const next = this.queue.shift();
        if (!next) {
            throw new Error('Unexpected LLM request: queue exhausted');
        }
        return next(request);
    }

    async *stream(request: LLMRequest) {
        const res = await this.complete(request);
        if (res.content) {
            yield { type: 'text_delta' as const, text: res.content };
        }
        yield {
            type: 'done' as const,
            usage: res.usage,
            finishReason: res.finishReason,
        };
    }
}

describe('eventSource message preprocess & postprocess hooks', () => {
    beforeEach(() => {
        stMocks.eventSource.clearAll();
        stMocks.state.chat.length = 0;
        stMocks.state.chat.push(
            { name: 'User', is_user: true, is_system: false, mes: 'Hello' },
            { name: 'Alice', is_user: false, is_system: false, mes: '' },
        );
    });

    it('exports canonical event constants and skips eventSource.emit when no listener is registered', async () => {
        expect(PROMPT_TRANSFORM_EVENTS.PROMPT_PREPROCESS).toBe('agentic_prompt_preprocess');
        expect(PROMPT_TRANSFORM_EVENTS.OUTPUT_POSTPROCESS).toBe('agentic_output_postprocess');
        expect(PROMPT_TRANSFORM_EVENTS.GENERATION_ERROR).toBe('agentic_generation_error');
        expect(PROMPT_TRANSFORM_EVENTS.TURN_INTERRUPTED).toBe('agentic_turn_interrupted');
        expect(PROMPT_TRANSFORM_EVENTS.TURN_ABORTED).toBe('agentic_turn_aborted');

        const bridge = new STHostBridge();
        expect(bridge.hasPromptPreprocessListeners()).toBe(false);
        expect(bridge.hasOutputPostprocessListeners()).toBe(false);

        const controller = createEphemeralMessagesController(
            [{ role: 'user', content: 'hi' }],
            { layer0End: 0, layer1End: 0, turnStart: 0 },
        );
        const prePayload = createPromptPreprocessPayload({
            messages: controller,
            body: { temperature: 0.7 },
            layers: { layer0End: 0, layer1End: 0, turnStart: 0, floatingTailStart: 1 },
            event: { type: 'prompt_preprocess', timestamp: Date.now() },
            meta: { runner: 'agent', runId: 'r1', round: 1, attempt: 0, maxRetries: 2 },
        });
        await runPromptPreprocessHook(bridge, prePayload);

        const postPayload = createOutputPostprocessPayload({
            output: { text: 'hello', content: 'hello', originalText: 'hello', toolCalls: [] },
            control: {
                retry: vi.fn(),
                requestFix: vi.fn(),
                action: 'accept',
                rejectWrite: false,
            },
            event: { type: 'output_postprocess', timestamp: Date.now() },
            meta: {
                runner: 'agent',
                runId: 'r1',
                round: 1,
                attempt: 0,
                maxRetries: 2,
                fixAttempt: 0,
                maxFixAttempts: 3,
            },
        });
        await runOutputPostprocessHook(bridge, postPayload);

        expect(stMocks.eventSource.emit).not.toHaveBeenCalled();
    });

    it('enforces re-entrancy depth guard (< 8) and isolates non-abort listener errors', async () => {
        const bridge = new STHostBridge();
        let depthCalls = 0;

        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.PROMPT_PREPROCESS, async (payload) => {
            depthCalls += 1;
            await bridge.preprocessPromptMessages(payload as PromptPreprocessHookPayload);
        });

        const controller = createEphemeralMessagesController(
            [{ role: 'user', content: 'hi' }],
            { layer0End: 0, layer1End: 0, turnStart: 0 },
        );
        const payload = createPromptPreprocessPayload({
            messages: controller,
            body: {},
            layers: { layer0End: 0, layer1End: 0, turnStart: 0, floatingTailStart: 1 },
            event: { type: 'prompt_preprocess', timestamp: Date.now() },
            meta: { runner: 'agent', runId: 'r_depth', round: 1, attempt: 0, maxRetries: 2 },
        });

        await runPromptPreprocessHook(bridge, payload);
        expect(depthCalls).toBe(8);

        stMocks.eventSource.clearAll();
        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.OUTPUT_POSTPROCESS, () => {
            throw new Error('third-party boom');
        });
        const postPayload = createOutputPostprocessPayload({
            output: { text: 'ok', content: 'ok', originalText: 'ok', toolCalls: [] },
            control: {
                retry: vi.fn(),
                requestFix: vi.fn(),
                action: 'accept',
                rejectWrite: false,
            },
            event: { type: 'output_postprocess', timestamp: Date.now() },
            meta: {
                runner: 'agent',
                runId: 'r_err',
                round: 1,
                attempt: 0,
                maxRetries: 2,
                fixAttempt: 0,
                maxFixAttempts: 3,
            },
        });
        await expect(runOutputPostprocessHook(bridge, postPayload)).resolves.toBeUndefined();
        expect(postPayload.errors).toHaveLength(1);
    });

    it('lets external eventSource extensions participate in AgentRunner preprocess & postprocess (standalone and chained)', async () => {
        const bridge = new STHostBridge();
        const transport = new QueueTransport();
        const trajectoryStore = new TrajectoryStore();
        const sandbox = new IframeJsSandbox();
        const settings = createDefaultSettings();
        const preset = settings.presets[settings.currentPresetId]!;
        const mainAgent = preset.agents[preset.mainAgentId]!;
        mainAgent.sessionMode = 'persistent';
        mainAgent.enabledTools = ['read_file', 'write_file', 'edit_file', 'append_file'];

        // Seed frozen Layer 1 history to prove ephemeral modification does not pollute it
        trajectoryStore.appendTurn(
            [
                { role: 'user', content: 'History turn 1' },
                { role: 'assistant', content: 'History reply 1' },
            ],
            mainAgent.id,
        );

        const order: string[] = [];
        preset.preprocessScript = {
            enabled: true,
            code: `
                ctx.messages.appendHint('[Preset Pre]', 'user');
                ctx.body.temperature = 0.42;
            `,
        };
        preset.postprocessScript = {
            enabled: true,
            code: `
                ctx.output.content = (ctx.output.content || '') + ' [Preset Post]';
            `,
        };

        const seenPreMeta: Array<PromptPreprocessHookPayload['meta']> = [];
        const seenLayerSnapshots: Array<{ before: number; after: number }> = [];
        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.PROMPT_PREPROCESS, (raw) => {
            const payload = raw as PromptPreprocessHookPayload;
            order.push('eventSource:preprocess');
            seenPreMeta.push(payload.meta);
            const before = payload.layers.layer1End;
            payload.messages.dropHistoryTurns(1, { from: 'oldest' });
            const after = payload.layers.layer1End;
            seenLayerSnapshots.push({ before, after });
            payload.messages.appendHint('[Ext Pre]', 'user');
            payload.body.temperature = 0.65;
        });

        let postCalls = 0;
        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.OUTPUT_POSTPROCESS, (raw) => {
            const payload = raw as OutputPostprocessHookPayload;
            postCalls += 1;
            order.push(`eventSource:postprocess:${postCalls}`);
            if (postCalls === 1) {
                expect(payload.output.content).toContain('[Preset Post]');
                payload.control.retry('External validator requires retry');
                return;
            }
            payload.output.content = `${payload.output.content ?? ''} [Ext Post]`;
            payload.output.reasoningContent = 'cleaned reasoning';
        });

        transport.enqueue(
            // Round 1 attempt 0 -> retried by external eventSource postprocess listener
            { content: 'Draft v1' },
            // Round 1 attempt 1 -> accepted and mutated by preset + external listener
            { content: 'Final answer', reasoningContent: 'raw reasoning' },
        );

        const runner = new AgentRunner({
            bridge,
            transport,
            settings: () => settings,
            trajectoryStore,
            sandbox,
            roundRetryInitialDelayMs: 1,
            roundRetryMaxDelayMs: 1,
            onPreprocessMessages: () => {
                order.push('callback:preprocess');
            },
            onPostprocessResponse: () => {
                order.push('callback:postprocess');
            },
        });

        const result = await runner.run({
            agent: mainAgent.id,
            target: { messageId: 1, swipeId: 0 },
            phase: 'after_turn',
            userInput: 'Run summary',
            stream: false,
        });

        expect(result.content).toBe('Final answer [Preset Post] [Ext Post]');
        expect(result.reasoningContent).toBe('cleaned reasoning');
        expect(transport.requests).toHaveLength(2);
        expect(transport.requests[0]!.connection?.temperature).toBe(0.65);

        // External preprocess saw dynamic layer shift after dropHistoryTurns(1)
        expect(seenLayerSnapshots[0]!.after).toBeLessThan(seenLayerSnapshots[0]!.before);
        expect(seenPreMeta[0]).toMatchObject({
            runner: 'agent',
            phase: 'after_turn',
            agentId: mainAgent.id,
            round: 1,
        });

        // Verify execution order: callback (@@script) runs before eventSource external listeners
        expect(order.indexOf('callback:preprocess')).toBeLessThan(
            order.indexOf('eventSource:preprocess'),
        );
        expect(order.indexOf('callback:postprocess')).toBeLessThan(
            order.indexOf('eventSource:postprocess:1'),
        );

        // Verify both preset & ext hints were sent ephemerally and original connection/history stayed intact
        const sentTexts = transport.requests[0]!.messages.map((m) => String(m.content));
        expect(sentTexts.some((t) => t.includes('[Preset Pre]'))).toBe(true);
        expect(sentTexts.some((t) => t.includes('[Ext Pre]'))).toBe(true);
        expect(sentTexts.some((t) => t.includes('History turn 1'))).toBe(false);
        expect(settings.connections[settings.currentConnectionId]!.temperature).not.toBe(0.65);

        // Original frozen Layer 1 history in TrajectoryStore was NOT mutated
        const persistedHistory = trajectoryStore.getMessages(mainAgent.id);
        expect(persistedHistory.some((m) => String(m.content) === 'History turn 1')).toBe(true);
    });

    it('runs external eventSource preprocess/postprocess even when preset scripts are disabled and supports control.abort()', async () => {
        const bridge = new STHostBridge();
        const transport = new QueueTransport();
        const settings = createDefaultSettings();
        const preset = settings.presets[settings.currentPresetId]!;
        preset.preprocessScript = undefined;
        preset.postprocessScript = undefined;

        let preFired = false;
        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.PROMPT_PREPROCESS, (raw) => {
            preFired = true;
            const payload = raw as PromptPreprocessHookPayload;
            payload.messages.appendHint('[Standalone Ext Pre]', 'user');
        });
        stMocks.eventSource.on(PROMPT_TRANSFORM_EVENTS.OUTPUT_POSTPROCESS, (raw) => {
            const payload = raw as OutputPostprocessHookPayload;
            payload.control.abort?.('Blocked by external policy extension');
        });

        transport.enqueue({ content: 'Forbidden response' });

        const runner = new AgentRunner({
            bridge,
            transport,
            settings: () => settings,
        });

        await expect(
            runner.run({
                agent: preset.mainAgentId,
                target: { messageId: 1, swipeId: 0 },
                phase: 'after_turn',
                userInput: 'Test standalone ext',
                stream: false,
            }),
        ).rejects.toMatchObject({ name: 'AbortError' });

        expect(preFired).toBe(true);
        expect(
            transport.requests[0]!.messages.some((m) =>
                String(m.content).includes('[Standalone Ext Pre]'),
            ),
        ).toBe(true);
    });
});
