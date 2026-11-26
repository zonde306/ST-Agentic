import { describe, expect, it } from 'vitest';
import { exportSettings } from '@/core/config';
import { applyRegexRules } from '@/core/regex';
import {
    createEmbeddedFilesPayload,
    createEmbeddedPresetsPayload,
    importSillyTavernOpenAIPreset,
    isLegacyCustomGenerationData,
    isSillyTavernOpenAIPreset,
    migrateEmbeddedCharacterData,
    migrateFromCustomGeneration,
} from '@/core/migration';
import legacyCustomGeneration from '../../fixtures/legacy-custom-generation.json';
import stOpenAiPreset from '../../fixtures/st-openai-preset.json';

describe('src/core/migration', () => {
    it('losslessly migrates legacy ST-CustomGeneration settings fixture', () => {
        expect(isLegacyCustomGenerationData(legacyCustomGeneration)).toBe(true);
        expect(isSillyTavernOpenAIPreset(legacyCustomGeneration)).toBe(false);

        const { settings, report } = migrateFromCustomGeneration(legacyCustomGeneration);

        expect(isLegacyCustomGenerationData(settings)).toBe(false);
        expect(report.sourceFormat).toBe('st_custom_generation');
        expect(settings.runMode).toBe('takeover');
        expect(settings.currentConnectionId).toBe('Default');
        expect(settings.currentPresetId).toBe('LegacyRP');
        expect(settings.migrations.legacy_custom_generation).toBe(true);
        expect(settings.storage).toEqual(legacyCustomGeneration.storage);

        // Connections migrated with cachePolicy: 'auto_prefix'
        expect(report.migratedConnections).toBe(2);
        const defaultConn = settings.connections.Default;
        expect(defaultConn.providerFormat).toBe('openai');
        expect(defaultConn.cachePolicy).toBe('auto_prefix');
        expect(defaultConn.model).toBe('gpt-4o');
        expect(defaultConn.includeHeaders).toEqual({ 'X-Custom': '1' });
        expect(defaultConn.linkedPreset).toBe('LegacyRP');
        expect(defaultConn.apiKey).toBe('sk-legacy-secret-key');
        expect(settings.connections.FastModel.cachePolicy).toBe('auto_prefix');
        expect(settings.connections.FastModel.promptPostProcessing).toBe('merge');

        // Exporting migrated settings strips apiKey
        const exported = exportSettings(settings);
        expect(exported.connections.Default.apiKey).toBe('');
        expect(exported.connections.FastModel.apiKey).toBe('');

        const preset = settings.presets.LegacyRP;
        expect(preset).toBeDefined();
        expect(preset.files).toEqual({
            'style-guide.md': '# 文风参考\n优先使用感官细节描写。',
        });
        expect(preset.builtinToolSettings?.read_file?.enabled).toBe(true);

        // Main Agent PromptBlocks: custom relative -> prefix, @D0 -> tail; built-in & @D3 skipped
        const mainAgent = preset.agents[preset.mainAgentId];
        expect(mainAgent.promptBlocks).toHaveLength(2);
        expect(mainAgent.promptBlocks[0]).toMatchObject({
            name: '全局文风指导',
            placement: 'prefix',
            content: '保持描写细腻，避免空洞总结。',
            enabled: true,
        });
        expect(mainAgent.promptBlocks[1]).toMatchObject({
            name: '尾部格式提醒',
            placement: 'tail',
            content: '回复末尾附带简短环境声响描写。',
            enabled: true,
        });
        expect(mainAgent.enabledTools).toContain('read_file');

        expect(report.skippedItems).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: 'Main Prompt', reason: 'builtin_slot' }),
                expect.objectContaining({ name: 'Chat History', reason: 'builtin_slot' }),
                expect.objectContaining({
                    name: '旧版深度3注入',
                    reason: 'depth_injection',
                    detail: '@D3',
                }),
            ]),
        );

        // Templates split into AgentProfile + TriggerRule (kind='agent' creates AgentProfile only)
        expect(report.migratedTriggers).toBe(2);
        expect(report.migratedAgents).toBe(4);
        expect(preset.agents.archivist).toMatchObject({
            id: 'archivist',
            name: 'archivist',
            sessionMode: 'ephemeral',
        });
        expect(preset.agents.archivist.promptBlocks[0].content).toBe(
            'You are a concise lore archivist.',
        );

        const replaceTrigger = preset.triggers.find((t) => t.decorator === '@@replace');
        expect(replaceTrigger).toBeDefined();
        expect(replaceTrigger?.phase).toBe('after_turn');
        expect(replaceTrigger?.barrier).toBe('self');
        expect(replaceTrigger?.condition).toEqual({ type: 'always' });
        expect(replaceTrigger?.instructionTemplate).toBe(
            'Update the document based on the latest turn.',
        );
        expect(preset.agents[replaceTrigger!.agentProfileId].enabledTools).toContain('edit_file');

        const varsTrigger = preset.triggers.find((t) => t.decorator === '@@variables_json');
        expect(varsTrigger).toBeDefined();
        expect(varsTrigger?.tag).toBe('stats');
        expect(varsTrigger?.barrier).toBe('turn');
        expect(varsTrigger?.findRegex).toBe('/<scene>([\\s\\S]+?)<\\/scene>/');
        expect(varsTrigger?.condition).toEqual({
            type: 'regex',
            pattern: '/<scene>([\\s\\S]+?)<\\/scene>/',
        });
        expect(preset.agents[varsTrigger!.agentProfileId].enabledTools).toContain('patch_variables');

        // Regexes mapped to display / lore_read / ingest dropping minDepth/maxDepth
        expect(report.migratedRegexRules).toBe(3);
        expect(preset.regexRules.map((r) => ({ name: r.name, stage: r.stage }))).toEqual([
            { name: '展示层状态栏折叠', stage: 'display' },
            { name: '世界书注释清洗', stage: 'lore_read' },
            { name: '入轨冗余标签剥离', stage: 'ingest' },
        ]);
        expect(report.warnings.some((w) => w.includes('minDepth=1'))).toBe(true);
        expect(report.warnings.some((w) => w.includes('output extraction regex'))).toBe(true);

        // Migrated regexes execute cleanly with our standalone regex engine
        const cleanedDisplay = applyRegexRules(
            '正文<status>HP:80</status>',
            preset.regexRules,
            { stage: 'display', sender: 'assistant' },
        );
        expect(cleanedDisplay).toBe('正文<details><summary>状态</summary>HP:80</details>');

        const cleanedLore = applyRegexRules(
            '设定内容<!-- author comment -->',
            preset.regexRules,
            { stage: 'lore_read', sender: 'lore' },
        );
        expect(cleanedLore).toBe('设定内容');

        const cleanedIngest = applyRegexRules(
            '回复文本<debug_note>scratch</debug_note>',
            preset.regexRules,
            { stage: 'ingest', sender: 'assistant' },
        );
        expect(cleanedIngest).toBe('回复文本');
    });

    it('migrates interceptGenerate=false to companion mode and supports legacy ExportPayload arrays', () => {
        const { settings } = migrateFromCustomGeneration({
            interceptGenerate: false,
            presets: [
                {
                    name: 'ExportedLegacy',
                    prompts: [
                        {
                            name: 'System Rule',
                            role: 'system',
                            prompt: 'Stay concise.',
                            injectionPosition: 'relative',
                            enabled: true,
                            internal: null,
                        },
                    ],
                    regexs: [],
                    templates: {},
                    files: { 'notes.txt': 'hello' },
                },
            ],
            currentPreset: 0,
            apiConnection: {
                baseUrl: 'https://api.example.com/v1',
                model: 'gpt-4o-mini',
                contextSize: 32000,
                maxTokens: 2048,
                temperature: 0.5,
                topK: 0,
                topP: 1,
                frequencyPenalty: 0,
                presencePenalty: 0,
                promptPostProcessing: 'none',
                includeHeaders: {},
                includeBody: {},
                excludeBody: {},
                maxConcurrency: 3,
                stream: true,
            },
        });

        expect(settings.runMode).toBe('companion');
        expect(settings.currentPresetId).toBe('ExportedLegacy');
        expect(settings.presets.ExportedLegacy.files).toEqual({ 'notes.txt': 'hello' });
        expect(settings.connections.default.apiKey).toBe('');
        expect(settings.connections.default.cachePolicy).toBe('auto_prefix');
    });

    it('imports traditional ST OpenAI preset fixture keeping relative/D0 and reporting skipped built-in & D>=1 slots', () => {
        expect(isSillyTavernOpenAIPreset(stOpenAiPreset)).toBe(true);

        const { preset, connection, report } = importSillyTavernOpenAIPreset(stOpenAiPreset, {
            presetName: 'ST Imported',
        });

        expect(report.sourceFormat).toBe('st_openai_preset');
        expect(report.migratedPresets).toBe(1);
        expect(report.migratedConnections).toBe(1);
        expect(report.migratedPromptBlocks).toBe(2);
        expect(report.migratedRegexRules).toBe(1);

        expect(connection.model).toBe('gpt-4o');
        expect(connection.contextSize).toBe(64000);
        expect(connection.maxTokens).toBe(4096);
        expect(connection.temperature).toBe(0.9);
        expect(connection.apiKey).toBe('');
        expect(connection.cachePolicy).toBe('auto_prefix');

        const mainAgent = preset.agents[preset.mainAgentId];
        expect(mainAgent.promptBlocks).toHaveLength(2);
        expect(mainAgent.promptBlocks[0]).toMatchObject({
            name: '核心文风与破限规则',
            placement: 'prefix',
            content: '避免出现重复排比句式，优先描写人物细微肢体与环境氛围。',
            enabled: true,
        });
        expect(mainAgent.promptBlocks[1]).toMatchObject({
            name: '文末视角锚定 (@D0)',
            placement: 'tail',
            content: '紧承上一句剧情继续叙事，保持第三人称克制口吻。',
            enabled: true,
        });

        // Built-in slots (including `main` and 8 markers) + @D4 injection are skipped with report details
        const builtinSkips = report.skippedItems.filter((item) => item.reason === 'builtin_slot');
        const depthSkips = report.skippedItems.filter((item) => item.reason === 'depth_injection');
        expect(builtinSkips.length).toBe(9);
        expect(builtinSkips.some((item) => item.detail === 'main')).toBe(true);
        expect(builtinSkips.some((item) => item.detail === 'chatHistory')).toBe(true);
        expect(depthSkips).toEqual([
            {
                name: '历史中间深度提醒 (@D4)',
                reason: 'depth_injection',
                detail: '@D4',
            },
        ]);

        // Regex script converted to ingest rule
        expect(preset.regexRules[0]).toMatchObject({
            name: '剥离思考标签',
            stage: 'ingest',
            applyToAssistant: true,
            applyToUser: false,
            enabled: true,
        });
    });

    it('supports Claude/custom ST OpenAI preset YAML fields and anthropic_explicit policy', () => {
        const { connection } = importSillyTavernOpenAIPreset({
            chat_completion_source: 'custom',
            custom_url: 'https://api.anthropic.com/v1',
            custom_model: 'claude-sonnet-4-5',
            custom_include_headers: 'x-test: enabled\n',
            custom_include_body: 'thinking:\n  type: enabled\n',
            prompts: [],
        });
        expect(connection.includeHeaders).toEqual({ 'x-test': 'enabled' });
        expect(connection.includeBody).toEqual({ thinking: { type: 'enabled' } });
        expect(connection.apiKey).toBe('');

        const claude = importSillyTavernOpenAIPreset({
            chat_completion_source: 'claude',
            claude_model: 'claude-3-7-sonnet',
            prompts: [],
        });
        expect(claude.connection.providerFormat).toBe('anthropic');
        expect(claude.connection.cachePolicy).toBe('anthropic_explicit');

        const gemini = importSillyTavernOpenAIPreset({
            chat_completion_source: 'makersuite',
            google_model: 'gemini-2.5-pro',
            prompts: [],
        });
        expect(gemini.connection.providerFormat).toBe('gemini');
        expect(gemini.connection.cachePolicy).toBe('auto_prefix');
        expect(gemini.connection.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
        expect(gemini.connection.model).toBe('gemini-2.5-pro');
    });

    it('dual-reads embedded character card cg_embed_* and agentic_embed_* payloads', () => {
        // 1. Legacy cg_embed_presets + cg_embed_files upgrade
        const legacyCardExtensions = {
            cg_embed_presets: [legacyCustomGeneration.presets.LegacyRP],
            cg_embed_files: {
                version: 1,
                files: {
                    'lore-intro.md': '# 序章',
                    '../bad.md': 'ignored',
                },
            },
        };

        const upgraded = migrateEmbeddedCharacterData({
            data: { extensions: legacyCardExtensions },
        });
        expect(upgraded.fromLegacy).toBe(true);
        expect(upgraded.hasPresets).toBe(true);
        expect(upgraded.hasFiles).toBe(true);
        expect(upgraded.report.sourceFormat).toBe('cg_embed');
        expect(upgraded.presetsPayload?.version).toBe(1);
        expect(upgraded.presetsPayload?.presets[0].name).toBe('LegacyRP');
        expect(upgraded.presetsPayload?.presets[0].triggers).toHaveLength(2);
        expect(upgraded.filesPayload).toEqual({
            version: 1,
            files: { 'lore-intro.md': '# 序章' },
        });

        // 2. Native agentic_embed_* takes precedence when both exist
        const newPresets = createEmbeddedPresetsPayload([upgraded.presetsPayload!.presets[0]]);
        const newFiles = createEmbeddedFilesPayload({ 'v2.md': 'updated' });
        const dualRead = migrateEmbeddedCharacterData({
            agentic_embed_presets: newPresets,
            agentic_embed_files: newFiles,
            cg_embed_presets: [legacyCustomGeneration.presets.LegacyRP],
            cg_embed_files: { version: 1, files: { 'old.md': 'stale' } },
        });

        expect(dualRead.fromLegacy).toBe(false);
        expect(dualRead.filesPayload).toEqual({
            version: 1,
            files: { 'v2.md': 'updated' },
        });
        expect(dualRead.presetsPayload?.presets[0].name).toBe('LegacyRP');

        // 3. Oversized embedded files throw to protect PNG chunk size
        expect(() =>
            createEmbeddedFilesPayload({ 'huge.txt': 'x'.repeat(300 * 1024) }),
        ).toThrow(/limit/i);
    });

    it('does not misclassify ST-Agentic prompt packs, presets, or PromptBlock lists as ST OpenAI presets', () => {
        expect(
            isSillyTavernOpenAIPreset({
                format: 'st-agentic-prompts',
                version: 1,
                presetName: 'My Preset',
                agentId: 'main',
                prompts: [
                    {
                        id: 'tail_custom',
                        name: 'Tail Custom',
                        role: 'custom',
                        placement: 'tail',
                        content: '{"role":"assistant","content":"prefill","partial":true}',
                        enabled: true,
                        triggers: ['main', 'trigger_after'],
                    },
                ],
            }),
        ).toBe(false);

        expect(
            isSillyTavernOpenAIPreset({
                format: 'st-agentic-prompt',
                version: 1,
                prompt: {
                    id: 'single',
                    name: 'Single',
                    role: 'custom',
                    placement: 'floating_tail',
                    content: '{"role":"user","content":"hi"}',
                    enabled: true,
                    triggers: ['main_normal'],
                },
            }),
        ).toBe(false);

        expect(
            isSillyTavernOpenAIPreset({
                format: 'st-agentic-preset',
                version: 1,
                preset: {
                    id: 'p1',
                    name: 'P1',
                    mainAgentId: 'main',
                    agents: { main: { id: 'main', promptBlocks: [] } },
                },
            }),
        ).toBe(false);

        expect(
            isSillyTavernOpenAIPreset({
                prompts: [
                    {
                        id: 'bare_block',
                        name: 'Bare',
                        role: 'custom',
                        placement: 'tail',
                        content: '{"role":"user","content":"hi"}',
                        triggers: ['main'],
                    },
                ],
            }),
        ).toBe(false);

        // Genuine ST OpenAI presets (with or without chat_completion_source) still match
        expect(
            isSillyTavernOpenAIPreset({
                prompts: [
                    {
                        identifier: 'custom-rule',
                        name: 'Custom Rule',
                        role: 'system',
                        content: 'Be concise.',
                        injection_position: 1,
                        injection_depth: 0,
                        injection_trigger: ['normal'],
                    },
                ],
            }),
        ).toBe(true);
    });
});
