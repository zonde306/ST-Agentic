import { describe, expect, it } from 'vitest';
import {
    createDefaultConnection,
    createDefaultMainAgent,
    createDefaultPreset,
    createDefaultSettings,
    exportConnections,
    exportPreset,
    exportSettings,
    importConnections,
    importPreset,
    importSettings,
    normalizeConnection,
    normalizePreset,
    normalizeSettings,
    resolveActivePreset,
    resolveConnection,
    validateConnectionsImport,
    validatePresetImport,
    validateSettingsImport,
} from '@/core/config';

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
        expect(mainAgent.promptBlocks.some((b) => b.placement === 'prefix' && b.enabled)).toBe(true);
        expect(conn.id).toBe('default');
        expect(conn.cachePolicy).toBe('auto_prefix');
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
                'nested/path.md': 'bad',
            },
        });
        expect(preset.mainAgentId).toBe('narrator');
        expect(preset.agents.narrator.watermark).toEqual({ high: 12000, low: 12000 });
        expect(preset.agents.narrator.enabledTools).toEqual(['read_file']);
        expect(preset.files).toEqual({ 'valid.md': 'ok' });

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
        const conn = createDefaultConnection({ id: 'c_export', apiKey: 'sk-must-be-stripped' });
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

        const settingsPayload = exportSettings(createDefaultSettings());
        const importedSettings = importSettings(settingsPayload);
        expect(importedSettings.currentPresetId).toBe('default');

        expect(validatePresetImport(null).ok).toBe(false);
        expect(validatePresetImport({ format: 'wrong-format', preset }).ok).toBe(false);
        expect(validateConnectionsImport({ connections: {} }).ok).toBe(false);
        expect(validateSettingsImport({ foo: 'bar' }).ok).toBe(false);
    });
});
