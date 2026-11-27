import { describe, expect, it } from 'vitest';
import {
    buildPresetFromPromptsImport,
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
    EXPORT_FORMAT_PROMPT,
    EXPORT_FORMAT_PROMPTS,
    exportConnections,
    exportPreset,
    exportSettings,
    importConnections,
    importPreset,
    importSettings,
    normalizeAgentProfile,
    normalizeConnection,
    normalizePreset,
    normalizeSettings,
    resolveActivePreset,
    resolveConnection,
    validateConnectionsImport,
    validatePresetImport,
    validatePromptsImport,
    validateSettingsImport,
} from '@/core/config';
import { parseImportedPromptBlocks } from '@/ui/studio/PromptsView';
import stOpenAiPreset from '../../fixtures/st-openai-preset.json';

describe('src/core/config defaults, normalization, and secret-free exports', () => {
    it('creates sensible defaults including persistent main agent tools, permissions, watermark, and PromptBlocks', () => {
        const settings = createDefaultSettings();
        const preset = resolveActivePreset(settings);
        const mainAgent = preset.agents[preset.mainAgentId];
        const conn = resolveConnection(settings, mainAgent.connectionId);

        expect(settings.version).toBe(1);
        expect(settings.themeMode).toBe('dark');
        expect(settings.runMode).toBe('companion');
        expect(mainAgent.sessionMode).toBe('persistent');
        expect(mainAgent.connectionId).toBe('inherit');
        expect(mainAgent.enabledTools).toContain('read_file');
        expect(mainAgent.enabledTools).toContain('search_files');
        expect(mainAgent.permissions.read).toContain('/**');
        expect(mainAgent.permissions.write).toContain('/memory/**');
        expect(mainAgent.watermark).toEqual({ high: 36000, low: 18000 });
        expect(mainAgent.maxToolRounds).toBe(0);
        expect(mainAgent.promptBlocks.some((b) => b.placement === 'prefix' && b.enabled)).toBe(true);
        expect(conn.id).toBe('default');
        expect(conn.cachePolicy).toBe('auto_prefix');
        expect(conn.systemInstructionMode).toBe('native');
    });

    it('normalizes malformed inputs and clamps bounds safely', () => {
        const conn = normalizeConnection({
            id: 'claude_conn',
            providerFormat: 'anthropic',
            temperature: 99,
            maxConcurrency: -5,
            maxCacheBreakpoints: 12,
            apiKey: 'sk-ant-123',
        });
        expect(conn.providerFormat).toBe('anthropic');
        expect(conn.cachePolicy).toBe('anthropic_explicit');
        expect(conn.temperature).toBe(2);
        expect(conn.maxConcurrency).toBe(1);
        expect(conn.maxCacheBreakpoints).toBe(4);
        expect(conn.apiKey).toBe('sk-ant-123');

        const geminiConn = normalizeConnection({
            id: 'gemini_conn',
            providerFormat: 'gemini',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            model: 'gemini-2.5-pro',
        });
        expect(geminiConn.providerFormat).toBe('gemini');
        expect(geminiConn.cachePolicy).toBe('auto_prefix');
        expect(geminiConn.systemInstructionMode).toBe('native');

        expect(normalizeConnection({ systemInstructionMode: 'user' }).systemInstructionMode).toBe('user');
        expect(normalizeConnection({ systemInstructionMode: 'model' }).systemInstructionMode).toBe('model');
        expect(normalizeConnection({ systemInstructionMode: 'assistant' }).systemInstructionMode).toBe('model');
        expect(normalizeConnection({ systemInstructionMode: 'invalid' }).systemInstructionMode).toBe('native');

        const preset = normalizePreset({
            id: 'p1',
            name: 'Custom',
            mainAgentId: 'missing',
            agents: {
                narrator: {
                    id: 'narrator',
                    watermark: { high: 12000, low: 50000 },
                    enabledTools: ['read_file', 'read_file', '  '],
                },
            },
            files: {
                'valid.md': 'ok',
                '../escape.md': 'bad',
                '.hidden': 'bad',
                'docs/.hidden': 'bad',
                '/leading.md': 'bad',
                'a//b.md': 'bad',
                'back\\slash.md': 'bad',
                'nested/path.md': 'ok',
            },
        });
        expect(preset.mainAgentId).toBe('narrator');
        expect(preset.agents.narrator.maxToolRounds).toBe(0);
        expect(preset.agents.narrator.watermark).toEqual({ high: 12000, low: 12000 });
        expect(preset.agents.narrator.enabledTools).toEqual(['read_file']);
        expect(preset.files).toEqual({ 'valid.md': 'ok', 'nested/path.md': 'ok' });

        expect(normalizeAgentProfile({ id: 'a_default' }).maxToolRounds).toBe(0);
        expect(normalizeAgentProfile({ id: 'a_zero', maxToolRounds: 0 }).maxToolRounds).toBe(0);
        expect(normalizeAgentProfile({ id: 'a_neg', maxToolRounds: -5 }).maxToolRounds).toBe(0);
        expect(normalizeAgentProfile({ id: 'a_pos', maxToolRounds: 12 }).maxToolRounds).toBe(12);
        expect(normalizeAgentProfile({ id: 'a_max', maxToolRounds: 5000 }).maxToolRounds).toBe(1000);

        const repaired = normalizeSettings({
            runMode: 'invalid_mode',
            themeMode: 'neon',
            connections: {},
            presets: {},
            currentConnectionId: 'nonexistent',
            currentPresetId: 'nonexistent',
        });
        expect(repaired.runMode).toBe('companion');
        expect(repaired.themeMode).toBe('dark');
        expect(Object.keys(repaired.connections).length).toBe(1);
        expect(Object.keys(repaired.presets).length).toBe(1);
        expect(repaired.connections[repaired.currentConnectionId]).toBeDefined();
        expect(repaired.presets[repaired.currentPresetId]).toBeDefined();
    });

    it('strictly strips apiKey from exportPreset, exportSettings, and exportConnections', () => {
        const secretPrimary = 'sk-live-primary-secret-999';
        const secretSecondary = 'sk-ant-secondary-secret-888';

        const primaryConn = createDefaultConnection({
            id: 'main_conn',
            name: 'Main OpenAI',
            apiKey: secretPrimary,
            model: 'gpt-4o',
        });
        const secondaryConn = createDefaultConnection({
            id: 'claude_conn',
            name: 'Claude',
            providerFormat: 'anthropic',
            cachePolicy: 'anthropic_explicit',
            apiKey: secretSecondary,
            model: 'claude-sonnet-4-5',
        });

        const preset = createDefaultPreset({
            id: 'story_preset',
            name: 'Story Preset',
            agents: {
                main: createDefaultMainAgent({ id: 'main' }),
            },
        });

        const settings = createDefaultSettings({
            connections: {
                main_conn: primaryConn,
                claude_conn: secondaryConn,
            },
            currentConnectionId: 'main_conn',
            presets: { story_preset: preset },
            currentPresetId: 'story_preset',
        });

        const exportedPresetOnly = exportPreset(preset);
        expect(exportedPresetOnly.connection).toBeUndefined();
        expect(JSON.stringify(exportedPresetOnly)).not.toContain(secretPrimary);

        const exportedPresetWithConn = exportPreset(preset, { includeConnection: primaryConn });
        expect(exportedPresetWithConn.connection?.apiKey).toBe('');
        expect(exportedPresetWithConn.connection?.model).toBe('gpt-4o');
        expect(JSON.stringify(exportedPresetWithConn)).not.toContain(secretPrimary);

        const exportedConns = exportConnections(settings);
        expect(exportedConns.connections.main_conn.apiKey).toBe('');
        expect(exportedConns.connections.claude_conn.apiKey).toBe('');
        expect(JSON.stringify(exportedConns)).not.toContain(secretPrimary);
        expect(JSON.stringify(exportedConns)).not.toContain(secretSecondary);

        const exportedAll = exportSettings(settings);
        expect(exportedAll.connections.main_conn.apiKey).toBe('');
        expect(exportedAll.connections.claude_conn.apiKey).toBe('');
        expect(JSON.stringify(exportedAll)).not.toContain(secretPrimary);
        expect(JSON.stringify(exportedAll)).not.toContain(secretSecondary);

        // Original settings must remain untouched in memory
        expect(settings.connections.main_conn.apiKey).toBe(secretPrimary);
        expect(settings.connections.claude_conn.apiKey).toBe(secretSecondary);
    });

    it('validates imports and rejects malformed payloads cleanly', () => {
        const preset = createDefaultPreset({ id: 'p_export', name: 'Exported' });
        const conn = createDefaultConnection({
            id: 'c_export',
            apiKey: 'sk-must-be-stripped',
            systemInstructionMode: 'model',
        });
        const presetPayload = exportPreset(preset, { includeConnection: conn });

        const importedPreset = importPreset(presetPayload);
        expect(importedPreset.presets).toHaveLength(1);
        expect(importedPreset.presets[0].name).toBe('Exported');
        expect(importedPreset.connection?.apiKey).toBe('');

        // Even if someone tampers an apiKey into a preset export JSON, preset import strips it
        const tampered = { ...presetPayload, connection: { ...conn, apiKey: 'sk-smuggled' } };
        expect(importPreset(tampered).connection?.apiKey).toBe('');

        const connsPayload = exportConnections({ c_export: conn }, 'c_export');
        const importedConns = importConnections(connsPayload);
        expect(importedConns.currentConnectionId).toBe('c_export');
        expect(importedConns.connections.c_export.apiKey).toBe('');
        expect(importedConns.connections.c_export.systemInstructionMode).toBe('model');

        const settingsPayload = exportSettings(createDefaultSettings());
        const importedSettings = importSettings(settingsPayload);
        expect(importedSettings.currentPresetId).toBe('default');

        expect(validatePresetImport(null).ok).toBe(false);
        expect(validatePresetImport({ format: 'wrong-format', preset }).ok).toBe(false);
        expect(validateConnectionsImport({ connections: {} }).ok).toBe(false);
        expect(validateSettingsImport({ foo: 'bar' }).ok).toBe(false);
    });

    it('preserves tail/floating_tail placement, custom role, prompt triggers, and rule ifConditions across export/import round-trips', () => {
        const preset = createDefaultPreset({
            id: 'roundtrip_preset',
            name: 'Roundtrip Preset',
            mainAgentId: 'main',
            agents: {
                main: createDefaultMainAgent({
                    id: 'main',
                    promptBlocks: [
                        {
                            id: 'sys_prefix',
                            name: 'System Prefix',
                            role: 'system',
                            placement: 'prefix',
                            content: 'Base system rules.',
                            enabled: true,
                        },
                        {
                            id: 'tail_custom',
                            name: 'Tail Custom JSON',
                            role: 'custom',
                            placement: 'tail',
                            content: '{"role":"assistant","content":"prefill","partial":true}',
                            enabled: true,
                            triggers: ['main', 'trigger_after', 'trigger_rule:r1'],
                        },
                        {
                            id: 'floating_tail_block',
                            name: 'Floating Tail Reminder',
                            role: 'user',
                            placement: 'floating_tail',
                            content: 'Stay in character.',
                            enabled: false,
                            triggers: ['main_continue', 'sidegen'],
                        },
                    ],
                }),
            },
            triggers: [
                {
                    id: 'r1',
                    label: 'Post Turn Rule',
                    source: 'preset',
                    phase: 'after_turn',
                    order: 1,
                    barrier: 'turn',
                    agentProfileId: 'main',
                    kind: 'agent',
                    condition: { type: 'always' },
                    instructionTemplate: 'Sync state.',
                    ifConditions: ['vars.allowSync', 'vars.sceneActive'],
                    enabled: true,
                },
            ],
        });

        const exportedJson = JSON.stringify(exportPreset(preset));
        const reimported = importPreset(JSON.parse(exportedJson));
        expect(reimported.presets).toHaveLength(1);
        const restored = reimported.presets[0];

        expect(restored.triggers[0]?.ifConditions).toEqual(['vars.allowSync', 'vars.sceneActive']);

        const blocks = restored.agents.main.promptBlocks;
        expect(blocks).toHaveLength(3);
        expect(blocks[1]).toMatchObject({
            id: 'tail_custom',
            role: 'custom',
            placement: 'tail',
            triggers: ['main', 'trigger_after', 'trigger_rule:r1'],
            enabled: true,
        });
        expect(blocks[2]).toMatchObject({
            id: 'floating_tail_block',
            role: 'user',
            placement: 'floating_tail',
            triggers: ['main_continue', 'sidegen'],
            enabled: false,
        });

        // Prompt-pack export (`st-agentic-prompts`) & single-prompt (`st-agentic-prompt`) round-trip
        const promptsPayload = {
            format: EXPORT_FORMAT_PROMPTS,
            version: 1,
            presetName: 'Exported Prompts Preset',
            agentId: 'main',
            prompts: blocks,
        };
        const promptsValidation = validatePromptsImport(promptsPayload);
        expect(promptsValidation.ok).toBe(true);
        if (promptsValidation.ok) {
            const builtPreset = buildPresetFromPromptsImport(promptsValidation.data);
            expect(builtPreset.name).toBe('Exported Prompts Preset');
            expect(builtPreset.agents.main.promptBlocks[1]).toMatchObject({
                role: 'custom',
                placement: 'tail',
                triggers: ['main', 'trigger_after', 'trigger_rule:r1'],
            });
            expect(builtPreset.agents.main.promptBlocks[2]).toMatchObject({
                role: 'user',
                placement: 'floating_tail',
                triggers: ['main_continue', 'sidegen'],
                enabled: false,
            });
        }

        const singlePromptValidation = validatePromptsImport({
            format: EXPORT_FORMAT_PROMPT,
            version: 1,
            prompt: blocks[1],
        });
        expect(singlePromptValidation.ok).toBe(true);
        if (singlePromptValidation.ok) {
            expect(singlePromptValidation.data.prompts[0]).toMatchObject({
                id: 'tail_custom',
                role: 'custom',
                placement: 'tail',
                triggers: ['main', 'trigger_after', 'trigger_rule:r1'],
            });
        }

        // PromptsView.parseImportedPromptBlocks must keep ST-Agentic fields & still migrate ST OpenAI presets
        const parsedFromPromptsPack = parseImportedPromptBlocks(promptsPayload);
        expect(parsedFromPromptsPack.skippedCount).toBe(0);
        expect(parsedFromPromptsPack.blocks[1]).toMatchObject({
            id: 'tail_custom',
            role: 'custom',
            placement: 'tail',
            triggers: ['main', 'trigger_after', 'trigger_rule:r1'],
        });
        expect(parsedFromPromptsPack.blocks[2]).toMatchObject({
            id: 'floating_tail_block',
            role: 'user',
            placement: 'floating_tail',
            triggers: ['main_continue', 'sidegen'],
            enabled: false,
        });

        const parsedFromStPreset = parseImportedPromptBlocks(stOpenAiPreset);
        expect(parsedFromStPreset.blocks.length).toBe(2);
        expect(parsedFromStPreset.blocks[0].placement).toBe('prefix');
        expect(parsedFromStPreset.blocks[1].placement).toBe('tail');
    });

    it('normalizes and losslessly round-trips PresetMessageScript and TriggerRule.events across preset, prompts, and settings export/import', () => {
        const allEvents = [
            'generation_error',
            'turn_interrupted',
            'turn_aborted',
            'turn_started',
            'turn_completed',
            'output_updated',
            'prompt_preprocess',
            'output_postprocess',
            'chat_changed',
            'message_sent',
            'message_received',
            'message_edited',
            'message_deleted',
            'message_swiped',
        ] as const;

        const normalizedPreset = normalizePreset({
            id: 'scripted_preset',
            name: 'Scripted Preset',
            preprocessScript: {
                enabled: true,
                code: 'messages.appendHint("Stay sharp");',
                triggers: ['main', 'main', 'invalid_trigger', 'trigger_after'],
            },
            postprocessScript: {
                enabled: false,
                code: 'output.text = output.text.trim();',
            },
            triggers: [
                {
                    id: 'ev_rule',
                    label: 'Event Recovery Rule',
                    source: 'preset',
                    phase: 'after_turn',
                    order: 1,
                    barrier: 'turn',
                    agentProfileId: 'main',
                    kind: 'script',
                    condition: { type: 'always' },
                    instructionTemplate: '',
                    scriptCode: 'control.retry("auto");',
                    events: [...allEvents, 'generation_error', 'not_a_real_event'],
                    enabled: true,
                },
                {
                    id: 'bad_ev_rule',
                    label: 'Invalid Events Only',
                    source: 'preset',
                    phase: 'after_turn',
                    order: 2,
                    barrier: 'none',
                    agentProfileId: 'main',
                    kind: 'script',
                    condition: { type: 'always' },
                    instructionTemplate: '',
                    events: ['unknown_event', 123],
                    enabled: true,
                },
            ],
        });

        expect(normalizedPreset.preprocessScript).toEqual({
            enabled: true,
            code: 'messages.appendHint("Stay sharp");',
            triggers: ['main', 'trigger_after'],
        });
        expect(normalizedPreset.postprocessScript).toEqual({
            enabled: false,
            code: 'output.text = output.text.trim();',
        });
        expect(normalizedPreset.triggers[0]?.events).toEqual([...allEvents]);
        expect(normalizedPreset.triggers[1]?.events).toBeUndefined();

        // Preset export / import round-trip
        const exportedPreset = exportPreset(normalizedPreset);
        const reimportedPreset = importPreset(JSON.parse(JSON.stringify(exportedPreset))).presets[0];
        expect(reimportedPreset.preprocessScript).toEqual(normalizedPreset.preprocessScript);
        expect(reimportedPreset.postprocessScript).toEqual(normalizedPreset.postprocessScript);
        expect(reimportedPreset.triggers[0]?.events).toEqual([...allEvents]);

        // Full Settings export / import round-trip
        const settings = createDefaultSettings({
            presets: { scripted_preset: normalizedPreset },
            currentPresetId: 'scripted_preset',
        });
        const reimportedSettings = importSettings(JSON.parse(JSON.stringify(exportSettings(settings))));
        expect(reimportedSettings.presets.scripted_preset.preprocessScript).toEqual(
            normalizedPreset.preprocessScript,
        );
        expect(reimportedSettings.presets.scripted_preset.postprocessScript).toEqual(
            normalizedPreset.postprocessScript,
        );
        expect(reimportedSettings.presets.scripted_preset.triggers[0]?.events).toEqual([
            ...allEvents,
        ]);

        // Prompt-pack (`st-agentic-prompts`) export / import preserves optional preprocess/postprocess scripts
        const promptsValidation = validatePromptsImport({
            format: EXPORT_FORMAT_PROMPTS,
            version: 1,
            presetName: 'With Scripts',
            prompts: normalizedPreset.agents[normalizedPreset.mainAgentId].promptBlocks,
            preprocessScript: normalizedPreset.preprocessScript,
            postprocessScript: normalizedPreset.postprocessScript,
        });
        expect(promptsValidation.ok).toBe(true);
        if (promptsValidation.ok) {
            const built = buildPresetFromPromptsImport(promptsValidation.data);
            expect(built.preprocessScript).toEqual(normalizedPreset.preprocessScript);
            expect(built.postprocessScript).toEqual(normalizedPreset.postprocessScript);
        }
    });
});
