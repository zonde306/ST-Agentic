import { describe, expect, it } from 'vitest';
import {
    assertAppendOnlyPrefix,
    DeferredGate,
    MemoryHostBridge,
    ScriptedLLMTransport,
} from './index';
import type { LLMRequest } from '@/core/bridge';
import type { CanonicalToolSchema, RawLoreEntry } from '@/core/types';
import hollowChineseCard from '../fixtures/hollow-chinese-card.json';
import ejsConditionalLore from '../fixtures/ejs-conditional-lore.json';
import legacyCustomGeneration from '../fixtures/legacy-custom-generation.json';
import stOpenAiPreset from '../fixtures/st-openai-preset.json';
import {
    createOffMainlineTestBridge,
    SAMPLE_RAW_AUTHOR_WI_ENTRY,
    SAMPLE_SECRET_PAYLOAD,
} from '../fixtures/off-mainline-fixtures';

describe('Wave 0 test mocks', () => {
    it('MemoryHostBridge supports macros, variables, lorebooks, spies, and real xxHash', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '艾琳' },
            characterFields: { description: '银月守望者' },
            personaDescription: '来自北方边境的调查员',
        });

        bridge.setVariable('gold', 120);
        const macroOut = bridge.substituteMacros(
            '{{user}} 对 {{char}} 说：当前金币 {{getvar::gold}} ({{custom}})',
            { custom: '银莲花' },
        );
        expect(macroOut).toBe('旅人 对 艾琳 说：当前金币 120 (银莲花)');

        const h1 = await bridge.hashText('测试文本');
        const h2 = await bridge.hashText('测试文本');
        expect(h1).toBe(h2);
        expect(h1).toMatch(/^[0-9a-f]{16}$/);

        const target = { messageId: 1, swipeId: 0 };
        await bridge.attachMediaToMessage(target, { type: 'image', url: 'https://example.com/a.png' });
        await bridge.refreshMessageView(target);
        expect(bridge.mediaAttachments).toHaveLength(1);
        expect(bridge.refreshedViews).toEqual([target]);

        await bridge.saveExtensionData('settings', { runMode: 'takeover' });
        expect(await bridge.loadExtensionData('settings', { runMode: 'off' })).toEqual({
            runMode: 'takeover',
        });
    });

    it('MemoryHostBridge readChatMessage and writeChatMessage handle swipes, active mes sync, and MESSAGE_UPDATED events', async () => {
        const bridge = new MemoryHostBridge({
            chat: [
                {
                    id: 0,
                    name: 'User',
                    isUser: true,
                    mes: '你好',
                    swipeId: 0,
                },
                {
                    id: 1,
                    name: '艾琳',
                    isUser: false,
                    mes: '第二页内容',
                    swipeId: 1,
                    swipes: ['第一页内容', '第二页内容'],
                    swipeInfo: [{}, {}],
                },
            ],
        });

        // readChatMessage: fallback swipe 0 when swipes is omitted
        expect(bridge.readChatMessage({ messageId: 0, swipeId: 0 })).toBe('你好');
        expect(bridge.readChatMessage({ messageId: 0, swipeId: 1 })).toBeNull();

        // readChatMessage: valid swipes & missing message/swipe -> null
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 0 })).toBe('第一页内容');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 1 })).toBe('第二页内容');
        expect(bridge.readChatMessage({ messageId: 1, swipeId: 2 })).toBeNull();
        expect(bridge.readChatMessage({ messageId: 99, swipeId: 0 })).toBeNull();
        expect(bridge.readChatMessage({ messageId: -1, swipeId: 0 })).toBeNull();

        // writeChatMessage on inactive swipe leaves mes intact and does not refresh view
        await bridge.writeChatMessage({ messageId: 1, swipeId: 0 }, '第一页修订');
        expect(bridge.chat[1].swipes?.[0]).toBe('第一页修订');
        expect(bridge.chat[1].mes).toBe('第二页内容');
        expect(bridge.refreshedViews).toHaveLength(0);
        expect(bridge.saveChatCalls).toBe(1);
        expect(bridge.emittedEvents).toHaveLength(0);

        // writeChatMessage on active swipe updates mes, refreshes view, pads swipes/swipeInfo, and emits MESSAGE_UPDATED when requested
        await bridge.writeChatMessage(
            { messageId: 1, swipeId: 1 },
            '第二页修订',
            { emitEvent: true },
        );
        expect(bridge.chat[1].swipes?.[1]).toBe('第二页修订');
        expect(bridge.chat[1].mes).toBe('第二页修订');
        expect(bridge.refreshedViews).toEqual([{ messageId: 1, swipeId: 1 }]);
        expect(bridge.saveChatCalls).toBe(2);
        expect(bridge.emittedEvents).toEqual([{ event: 'MESSAGE_UPDATED', payload: 1 }]);

        // Writing to a new swipe slot on message without swipes initializes and pads swipes/swipeInfo without altering active swipe 0 mes
        await bridge.writeChatMessage({ messageId: 0, swipeId: 2 }, '第三页');
        expect(bridge.chat[0].swipes).toEqual(['你好', '', '第三页']);
        expect(bridge.chat[0].swipeInfo).toHaveLength(3);
        expect(bridge.chat[0].mes).toBe('你好');
        expect(bridge.writtenMessages).toHaveLength(3);

        // readChatMessage falls back to mes when swipes is empty [] and swipeId is 0
        bridge.pushMessage({
            name: '艾琳',
            isUser: false,
            mes: '空swipes回退',
            swipes: [],
        });
        expect(bridge.readChatMessage({ messageId: 2, swipeId: 0 })).toBe('空swipes回退');
        expect(bridge.readChatMessage({ messageId: 2, swipeId: 1 })).toBeNull();

        // writeChatMessage on missing message/negative swipe is a safe no-op
        await bridge.writeChatMessage({ messageId: 99, swipeId: 0 }, 'ignored');
        await bridge.writeChatMessage({ messageId: 0, swipeId: -1 }, 'ignored');
        expect(bridge.writtenMessages).toHaveLength(3);
        expect(bridge.saveChatCalls).toBe(3);
    });

    it('MemoryHostBridge createChatMessage and deleteChatMessage handle insertion, re-indexing, roles, and events', async () => {
        const bridge = new MemoryHostBridge({
            identity: { userName: '旅人', charName: '艾琳' },
            chat: [
                { id: 0, name: '旅人', isUser: true, mes: '第一条', swipeId: 0, swipes: ['第一条'] },
                { id: 1, name: '艾琳', isUser: false, mes: '第三条', swipeId: 0, swipes: ['第三条'] },
            ],
        });

        // Append assistant message
        const appended = await bridge.createChatMessage({
            role: 'assistant',
            content: '第四条回复',
        });
        expect(appended.id).toBe(2);
        expect(appended.name).toBe('艾琳');
        expect(appended.isUser).toBe(false);
        expect(appended.isSystem).toBe(false);

        // Insert system message in the middle -> re-indexes subsequent messages
        const inserted = await bridge.createChatMessage({
            role: 'system',
            content: '场景切换：暴雨夜。',
            insertAt: 1,
        });
        expect(inserted.id).toBe(1);
        expect(inserted.name).toBe('System');
        expect(inserted.isSystem).toBe(true);
        expect(bridge.chat.map((m) => [m.id, m.mes])).toEqual([
            [0, '第一条'],
            [1, '场景切换：暴雨夜。'],
            [2, '第三条'],
            [3, '第四条回复'],
        ]);

        // Delete middle message -> re-indexes cleanly and returns pre-deletion snapshot
        const deleted = await bridge.deleteChatMessage(1);
        expect(deleted?.messageId).toBe(1);
        expect(deleted?.snapshot.mes).toBe('场景切换：暴雨夜。');
        expect(bridge.chat.map((m) => [m.id, m.mes])).toEqual([
            [0, '第一条'],
            [1, '第三条'],
            [2, '第四条回复'],
        ]);

        // Out-of-bounds delete returns null without mutating chat
        expect(await bridge.deleteChatMessage(99)).toBeNull();
        expect(bridge.emittedEvents.map((e) => e.event)).toEqual([
            'MESSAGE_RECEIVED',
            'MESSAGE_RECEIVED',
            'MESSAGE_DELETED',
        ]);
    });

    it('ScriptedLLMTransport streams text, reasoning, incremental tool calls, usage, and honors AbortSignal', async () => {
        const transport = new ScriptedLLMTransport([
            {
                reasoningContent: '先检索档案',
                content: '好的，让我查一下。',
                toolCalls: [
                    {
                        id: 'call_1',
                        name: 'read_file',
                        arguments: '{"path":"/lorebooks/world/银莲花-12.md"}',
                        thoughtSignature: 'sig-abc',
                    },
                ],
                usage: { inputTokens: 1000, cachedTokens: 900, outputTokens: 42 },
                chunkSize: 6,
            },
            {
                delayMs: 500,
                content: '不会发出',
            },
        ]);

        const req: LLMRequest = {
            connectionId: 'default',
            messages: [{ role: 'user', content: ' silver lotus ' }],
            tools: [],
        };

        let reasoning = '';
        let content = '';
        const argParts: string[] = [];
        let seenCached = 0;

        for await (const chunk of transport.stream(req)) {
            if (chunk.type === 'reasoning_delta' && chunk.reasoningDelta) {
                reasoning += chunk.reasoningDelta;
            } else if (chunk.type === 'text_delta' && chunk.textDelta) {
                content += chunk.textDelta;
            } else if (chunk.type === 'tool_call_delta' && chunk.argumentsDelta) {
                argParts.push(chunk.argumentsDelta);
            } else if (chunk.type === 'usage' && chunk.usage) {
                seenCached = chunk.usage.cachedTokens;
            }
        }

        expect(reasoning).toBe('先检索档案');
        expect(content).toBe('好的，让我查一下。');
        expect(argParts.length).toBeGreaterThan(1);
        expect(argParts.join('')).toBe('{"path":"/lorebooks/world/银莲花-12.md"}');
        expect(seenCached).toBe(900);
        expect(transport.requests).toHaveLength(1);

        const controller = new AbortController();
        setTimeout(() => controller.abort(), 15);
        await expect(
            transport.complete({ ...req, signal: controller.signal }),
        ).rejects.toThrow(/aborted/i);
    });

    it('assertAppendOnlyPrefix passes for append-only turns and throws on key/prefix mutation', () => {
        const toolA: CanonicalToolSchema = {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
        };
        const toolAReordered: CanonicalToolSchema = {
            description: 'Read a file',
            parameters: { properties: { path: { type: 'string' } }, type: 'object' },
            name: 'read_file',
        };

        const req1: LLMRequest = {
            connectionId: 'main',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'turn 1' },
            ],
            tools: [toolA],
        };

        const req2Valid: LLMRequest = {
            connectionId: 'main',
            messages: [
                { role: 'system', content: 'sys' },
                { role: 'user', content: 'turn 1' },
                { role: 'assistant', content: 'reply 1' },
                { role: 'user', content: 'turn 2' },
            ],
            tools: [toolAReordered],
        };

        expect(() => assertAppendOnlyPrefix(req1, req2Valid)).not.toThrow();

        const req2MutatedPrefix: LLMRequest = {
            ...req2Valid,
            messages: [
                { role: 'system', content: 'sys-mutated' },
                ...req2Valid.messages.slice(1),
            ],
        };
        expect(() => assertAppendOnlyPrefix(req1, req2MutatedPrefix)).toThrow(/messages\[0\]/);
    });

    it('DeferredGate coordinates async task waiting and resolution', async () => {
        const gate = new DeferredGate<string>();
        let finished = false;

        const worker = (async () => {
            const val = await gate.promise;
            finished = true;
            return val;
        })();

        await gate.waitUntilWaiting();
        expect(finished).toBe(false);
        expect(gate.waitingCount).toBe(1);

        gate.resolve('committed');
        await expect(worker).resolves.toBe('committed');
        expect(finished).toBe(true);
    });

    it('loads standard Wave 0 corpus fixtures cleanly into MemoryHostBridge', async () => {
        const loreEntries = hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[];
        const ejsEntries = ejsConditionalLore.entries as RawLoreEntry[];

        const bridge = new MemoryHostBridge({
            identity: hollowChineseCard.identity,
            characterFields: hollowChineseCard.characterFields,
            personaDescription: hollowChineseCard.personaDescription,
            lorebooks: {
                '霜烬纪元': loreEntries,
                [ejsConditionalLore.world]: ejsEntries,
            },
        });

        const books = await bridge.listEnabledLorebooks();
        expect(books.get('霜烬纪元')?.length).toBeGreaterThanOrEqual(10);
        expect(books.get(ejsConditionalLore.world)).toHaveLength(2);
        expect(bridge.getCharacterFields().description.length).toBeLessThan(80);
        expect(legacyCustomGeneration.interceptGenerate).toBe(true);
        expect(stOpenAiPreset.prompts.some((p) => p.injection_depth === 4 && p.injection_position === 1)).toBe(true);
    });

    it('MemoryHostBridge.author supports character sync, raw @@/EJS WI writes, scoped regex, hide toggle, and embed', async () => {
        const bridge = createOffMainlineTestBridge();
        expect(bridge.author).toBeDefined();
        const author = bridge.author!;

        // Active character full read & patch syncs characterFields + data mirror
        const activeBefore = await author.getActiveCharacterFull();
        expect(activeBefore?.name).toBe('林晚');
        expect(await author.getPrimaryWorldName()).toBe('雾港侦探录');

        const patched = await author.patchActiveCharacter(
            { description: '更新后的雾港情报联络人设定。' },
            { sessionId: 'ast_1', toolCallId: 'call_1' },
        );
        expect(patched.description).toBe('更新后的雾港情报联络人设定。');
        expect(bridge.getCharacterFields().description).toBe('更新后的雾港情报联络人设定。');
        expect(patched.data?.description).toBe('更新后的雾港情报联络人设定。');
        expect(bridge.characterPatchHistory).toHaveLength(1);

        // Toggle message hidden state
        expect(await author.toggleChatMessageHidden(1, true)).toBe(true);
        expect(bridge.chat[1].isSystem).toBe(true);
        expect(await author.toggleChatMessageHidden(99, true)).toBe(false);

        // Raw WI upsert preserves @@system and <% ... %> EJS verbatim (no escapeAt)
        const rawEntry = await author.upsertWorldInfoEntry('雾港侦探录', {
            comment: '新增原始触发规则',
            content: '@@trigger phase=after\n<% if (getvar("clue")) { %>已触发<% } %>',
            keys: ['触发'],
        });
        expect(rawEntry.content.startsWith('@@trigger')).toBe(true);
        expect(rawEntry.content).toContain('<% if (getvar("clue")) { %>');

        const book = await author.readWorldInfoBook('雾港侦探录');
        expect(book?.entries).toHaveLength(2);
        expect(book?.entries[0].content).toBe(SAMPLE_RAW_AUTHOR_WI_ENTRY.content);
        expect(await author.deleteWorldInfoEntry('雾港侦探录', rawEntry.uid)).toBe(true);
        expect((await author.readWorldInfoBook('雾港侦探录'))?.entries).toHaveLength(1);

        // Scoped regex & embed
        expect(await author.listScopedRegex()).toHaveLength(1);
        await author.saveScopedRegex([]);
        expect(await author.listScopedRegex()).toHaveLength(0);

        const embedResult = await author.embedAgenticPayload({
            includePreset: true,
            includeFiles: true,
            files: { '/notes/a.md': 'hello' },
        });
        expect(embedResult.ok).toBe(true);
        expect(embedResult.embeddedPresets).toBe(1);
        expect(embedResult.embeddedFiles).toBe(1);
    });

    it('MemoryHostBridge.admin supports global WI/characters/personas/presets/settings with secret samples and URL import', async () => {
        const bridge = createOffMainlineTestBridge();
        expect(bridge.admin).toBeDefined();
        const admin = bridge.admin!;

        // Global WI list, create, bind/unbind
        expect(await admin.listAllWorldNames()).toEqual(['全局备用设定集', '雾港侦探录']);
        await admin.createWorldBook('新建世界书');
        await admin.bindWorldBook('全局备用设定集', true);
        expect((await bridge.listEnabledLorebooks()).has('全局备用设定集')).toBe(true);
        await admin.bindWorldBook('全局备用设定集', false);
        expect((await bridge.listEnabledLorebooks()).has('全局备用设定集')).toBe(false);

        // Characters CRUD & select
        const createdChar = await admin.createCharacter({
            name: '沈岸',
            description: '码头值夜警长',
        });
        expect((await admin.listAllCharacters()).length).toBe(2);
        await admin.patchCharacterById(createdChar.chid, { personality: '铁面无私' });
        expect((await admin.readCharacterById(createdChar.chid))?.personality).toBe('铁面无私');
        await admin.selectCharacterById(createdChar.chid);
        expect(bridge.getActiveIdentity().charName).toBe('沈岸');
        expect(await admin.deleteCharacterById(createdChar.chid)).toBe(true);

        // Personas & presets
        await admin.upsertPersona('alt.png', '卧底记者', '林记者');
        await admin.selectPersona('alt.png');
        expect(bridge.getPersonaDescription()).toBe('卧底记者');
        expect(await admin.listPersonas()).toHaveLength(2);

        const presets = await admin.listPresets('openai');
        expect(presets).toHaveLength(1);
        const patchedPreset = await admin.patchPreset('Default', { temperature: 0.6 }, 'openai');
        expect(patchedPreset.data?.temperature).toBe(0.6);

        // Host settings include realistic API keys/tokens for redaction tests
        const powerUser = await admin.readHostSettings('power_user');
        expect(String(powerUser.api_key_custom)).toMatch(/^sk-/);
        expect(String(powerUser.proxy_authorization)).toMatch(/^Bearer /);
        const extSettings = await admin.readHostSettings('extension_settings');
        expect((extSettings.agentic as Record<string, unknown>).apiKey).toBeTruthy();
        expect(SAMPLE_SECRET_PAYLOAD.apiKey).toBeTruthy();

        const patchedSettings = await admin.patchHostSettings('power_user', { fast_ui_mode: false });
        expect(patchedSettings.fast_ui_mode).toBe(false);

        // Global regex & URL import
        await admin.saveGlobalRegex([
            {
                id: 'g1',
                scriptName: 'Global Clean',
                findRegex: '/foo/g',
                replaceString: 'bar',
            },
        ]);
        expect(await admin.listGlobalRegex()).toHaveLength(1);

        const importRes = await admin.importFromUrl('https://example.test/cards/linwan.png');
        expect(importRes.ok).toBe(true);
        expect(importRes.importedType).toBe('character');
        expect(bridge.importedUrls).toEqual(['https://example.test/cards/linwan.png']);
    });
});
