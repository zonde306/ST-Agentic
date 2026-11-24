import { describe, expect, it } from 'vitest';
import {
    DEFAULT_MAIN_AGENT_PERMISSIONS,
    DEFAULT_MAIN_AGENT_TOOLS,
    createDefaultMainAgent,
    normalizePreset,
} from '@/core/config';

const LEGACY_8_TOOLS = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'read_variables',
    'search_history',
    'read_history',
];

describe('Main Agent /output.md Defaults & Legacy Preset Upgrade', () => {
    it('enables write_file, append_file, edit_file, /output.md permissions, and output protocol in defaults', () => {
        expect(DEFAULT_MAIN_AGENT_TOOLS).toEqual(
            expect.arrayContaining(['write_file', 'append_file', 'edit_file']),
        );
        expect(DEFAULT_MAIN_AGENT_PERMISSIONS.write).toEqual([
            '/output.md',
            '/memory/**',
            '/scratch/**',
            '/workspace/shared/**',
        ]);

        const main = createDefaultMainAgent();
        expect(main.enabledTools).toEqual(expect.arrayContaining(['write_file', 'append_file', 'edit_file']));
        expect(main.permissions.write).toContain('/output.md');

        const basePrompt = main.promptBlocks.find((b) => b.id === 'system_base')?.content ?? '';
        expect(basePrompt).toContain('/output.md');
        expect(basePrompt).toContain('write_file');
        expect(basePrompt).toContain('append_file');
        expect(basePrompt).toContain('edit_file');
    });

    it('upgrades legacy mainAgent presets to write /output.md while respecting disabled tools and custom agents', () => {
        // 1. Legacy 8-tool mainAgent + legacy write permissions -> upgraded cleanly
        const upgradedLegacy = normalizePreset({
            id: 'legacy_preset',
            name: 'Legacy',
            mainAgentId: 'main',
            agents: {
                main: {
                    id: 'main',
                    enabledTools: [...LEGACY_8_TOOLS],
                    permissions: { read: ['/**'], write: ['/memory/**', '/scratch/**'] },
                },
                chronicler: {
                    id: 'chronicler',
                    enabledTools: [...LEGACY_8_TOOLS],
                    permissions: { read: ['/**'], write: ['/memory/**', '/scratch/**'] },
                },
            },
        });

        expect(upgradedLegacy.agents.main.enabledTools).toEqual(
            expect.arrayContaining([...LEGACY_8_TOOLS, 'write_file', 'append_file', 'edit_file']),
        );
        expect(upgradedLegacy.agents.main.permissions.write).toEqual(
            expect.arrayContaining(['/output.md', '/memory/**', '/scratch/**', '/workspace/shared/**']),
        );
        // V2 mainAgent write permissions also upgrade cleanly to include /workspace/shared/**
        const upgradedV2 = normalizePreset({
            id: 'v2_preset',
            name: 'V2',
            mainAgentId: 'main',
            agents: {
                main: {
                    id: 'main',
                    permissions: { read: ['/**'], write: ['/output.md', '/memory/**', '/scratch/**'] },
                },
            },
        });
        expect(upgradedV2.agents.main.permissions.write).toEqual([
            '/output.md',
            '/memory/**',
            '/scratch/**',
            '/workspace/shared/**',
        ]);
        // Non-main agent must NOT be mutated even if it happens to have legacy 8 tools
        expect(upgradedLegacy.agents.chronicler.enabledTools).toEqual(LEGACY_8_TOOLS);
        expect(upgradedLegacy.agents.chronicler.permissions.write).toEqual(['/memory/**', '/scratch/**']);

        // 2. Omitted enabledTools/permissions on mainAgent + builtinToolSettings disabling append_file
        const withDisabled = normalizePreset({
            id: 'omitted_with_disabled',
            name: 'Partial',
            mainAgentId: 'main',
            agents: {
                main: { id: 'main' },
            },
            builtinToolSettings: {
                append_file: { enabled: false },
            },
        });
        expect(withDisabled.agents.main.enabledTools).toEqual(['write_file', 'edit_file']);
        expect(withDisabled.agents.main.permissions.write).toContain('/output.md');

        // 3. Explicit custom mainAgent tool list & permissions must NOT be overwritten
        const customMain = normalizePreset({
            id: 'custom_preset',
            name: 'Custom',
            mainAgentId: 'main',
            agents: {
                main: {
                    id: 'main',
                    enabledTools: ['read_file'],
                    permissions: { read: ['/**'], write: ['/scratch/**'] },
                },
            },
        });
        expect(customMain.agents.main.enabledTools).toEqual(['read_file']);
        expect(customMain.agents.main.permissions.write).toEqual(['/scratch/**']);
    });
});
