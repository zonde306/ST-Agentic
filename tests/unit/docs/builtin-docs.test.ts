import { afterEach, describe, expect, it } from 'vitest';
import {
    AssistantRunner,
    FULL_AGENTIC_CONFIG_TOOLS,
    lintWorldInfoContent,
} from '@/core/assistant';
import { buildWorkspaceNotices } from '@/core/context';
import { PROMPT_TRANSFORM_EVENTS } from '@/core/bridge';
import {
    BUILTIN_DOCS,
    clearExternalDocs,
    DocsRegistry,
    getBuiltinDoc,
} from '@/core/docs';
import { AGENTIC_DECORATORS, LEGACY_DECORATORS } from '@/core/lore';
import {
    createDefaultSettings,
    DEFAULT_MAIN_AGENT_PERMISSIONS,
} from '@/core/config';
import {
    hashText,
    SIDE_CLUE_DELIVERIES,
    SIDE_CLUE_STATUSES,
} from '@/core/utils';
import {
    VfsNotFoundError,
    VfsReadOnlyError,
    VirtualFileSystem,
} from '@/core/vfs';
import { MemoryHostBridge, ScriptedLLMTransport } from '../../mocks';

describe('Built-in /docs/ VFS mount & authoring docs', () => {
    afterEach(() => {
        clearExternalDocs();
    });
    it('mounts all 10 built-in reference docs read-only at /docs/ and isolates them from default root search', async () => {
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge });

        const rootEntries = await vfs.listDir('/');
        const docsDir = rootEntries.find((entry) => entry.name === 'docs');
        expect(docsDir).toMatchObject({
            path: '/docs',
            name: 'docs',
            kind: 'directory',
            writable: false,
            mount: 'docs',
        });

        const docEntries = await vfs.listDir('/docs');
        expect(docEntries).toHaveLength(10);
        expect(docEntries.every((entry) => entry.writable === false && entry.size > 0)).toBe(true);
        expect(docEntries.map((entry) => entry.name)).toEqual(
            BUILTIN_DOCS.map((doc) => doc.fileName).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        );

        const stNative = await vfs.readFile('/docs/st-native.md');
        expect(stNative).toContain('wi_upsert_primary_entry');
        expect(stNative).toContain('/state/chat_variables.json');

        const sliced = await vfs.readFile('/docs/st-native.md', { startLine: 1, endLine: 1 });
        expect(sliced).toContain('SillyTavern');

        await expect(vfs.readFile('/docs/does-not-exist.md')).rejects.toBeInstanceOf(
            VfsNotFoundError,
        );
        await expect(vfs.writeFile('/docs/st-native.md', 'hack')).rejects.toBeInstanceOf(
            VfsReadOnlyError,
        );
        await expect(vfs.appendFile('/docs/st-native.md', 'hack')).rejects.toBeInstanceOf(
            VfsReadOnlyError,
        );
        await expect(
            vfs.editFile('/docs/st-native.md', 'SillyTavern', 'Hack'),
        ).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.deleteFile('/docs/st-native.md')).rejects.toBeInstanceOf(VfsReadOnlyError);

        // Default root search & grep must NOT include /docs/*
        const rootSearchHits = await vfs.searchFiles('defineTool');
        expect(rootSearchHits.some((hit) => hit.path.startsWith('/docs/'))).toBe(false);
        const rootGrepHits = await vfs.grepSearch('getCurrentMessageId');
        expect(rootGrepHits.some((hit) => hit.path.startsWith('/docs/'))).toBe(false);

        // Explicit /docs scoped search, grep, and glob DO return /docs/* hits
        const scopedSearchHits = await vfs.searchFiles('defineTool', { pathPrefix: '/docs' });
        expect(scopedSearchHits.some((hit) => hit.path === '/docs/js-tools.md')).toBe(true);

        const scopedGrepHits = await vfs.grepSearch('getCurrentMessageId', { pathPrefix: '/docs' });
        expect(scopedGrepHits.some((hit) => hit.path === '/docs/status-ui.md')).toBe(true);

        const globbed = await vfs.globFiles('/docs/*.md');
        expect(globbed).toHaveLength(10);
        expect(globbed).toContain('/docs/status-ui.md');
        expect(globbed).toContain('/docs/event-hooks.md');
        expect(globbed).toContain('/docs/sidegen.md');

        const sidegenSearchHits = await vfs.searchFiles('exportToWorldInfo', { pathPrefix: '/docs' });
        expect(sidegenSearchHits.some((hit) => hit.path === '/docs/sidegen.md')).toBe(true);

        // Mainline workspace notices never emit /docs/*
        const notices = await buildWorkspaceNotices({
            vfs,
            permissions: DEFAULT_MAIN_AGENT_PERMISSIONS,
            hashText,
        });
        expect(notices.noticeXml).not.toContain('/docs/');
    });

    it('keeps triggers, ST native routing, and agentic-config docs aligned with codebase contracts', () => {
        const triggersDoc = getBuiltinDoc('triggers.md')?.content ?? '';
        for (const dec of AGENTIC_DECORATORS) {
            expect(triggersDoc).toContain(dec);
        }
        for (const dec of LEGACY_DECORATORS) {
            expect(triggersDoc).toContain(dec);
        }

        const stNativeDoc = getBuiltinDoc('st-native.md')?.content ?? '';
        for (const toolName of [
            'wi_upsert_primary_entry',
            'wi_upsert_enabled_entry',
            'card_patch_active',
            'regex_upsert_scoped',
            'tavern_helper_scripts_upsert',
            'st_settings_read',
            'chat_reload_messages',
            'st_sync_runtime',
            'read_variables',
            'patch_variables',
        ]) {
            expect(stNativeDoc).toContain(toolName);
        }

        const agenticConfigDoc = getBuiltinDoc('agentic-config.md')?.content ?? '';
        for (const toolName of FULL_AGENTIC_CONFIG_TOOLS) {
            expect(agenticConfigDoc).toContain(toolName);
        }

        const eventHooksDoc = getBuiltinDoc('event-hooks.md')?.content ?? '';
        for (const eventName of Object.values(PROMPT_TRANSFORM_EVENTS)) {
            expect(eventHooksDoc).toContain(eventName);
        }
        for (const token of [
            'messageId',
            'swipeId',
            'editable',
            'cache.disable',
            'requestFix',
            'rejectWrite',
            'plain_finish',
            'eventOn',
        ]) {
            expect(eventHooksDoc).toContain(token);
        }

        const sidegenDoc = getBuiltinDoc('sidegen.md')?.content ?? '';
        for (const delivery of SIDE_CLUE_DELIVERIES) {
            expect(sidegenDoc).toContain(delivery);
        }
        for (const status of SIDE_CLUE_STATUSES) {
            expect(sidegenDoc).toContain(status);
        }
        for (const token of [
            'runOnce',
            'createSession',
            'compactSession',
            'getTranscript',
            'exportToWorldInfo',
            'updateDelivery',
            'updateStatus',
            '/sidegen-once',
            '/sidegen-send',
            '/sidegen-clue',
            'autoBridge',
            'mainChatDepth',
            'includeVars',
            'triggers',
            'sidegen',
            '{{systemBase}}',
        ]) {
            expect(sidegenDoc).toContain(token);
        }
    });

    it('accepts ST-Prompt-Template decorators in lintWorldInfoContent without spurious warnings', () => {
        const validTemplate = [
            '@@render_after',
            '@@message_formatting',
            '@@if !is_user && !is_system',
            '@@preload',
            '```html',
            '<html><body><div><%- variables.hp ?? 100 %></div></body></html>',
            '```',
        ].join('\n');
        expect(lintWorldInfoContent(validTemplate)).toEqual([]);

        const unknownWarnings = lintWorldInfoContent('@@totally_fake_decorator foo=bar\nBody');
        expect(unknownWarnings).toHaveLength(1);
        expect(unknownWarnings[0]).toContain('@@totally_fake_decorator');
    });

    it('includes the /docs/ routing index in the Assistant system prompt', async () => {
        const bridge = new MemoryHostBridge({
            extensionCapabilities: {
                tavernHelperScripts: true,
                tavernHelperAudio: true,
                ejsTemplate: true,
            },
        });
        const transport = new ScriptedLLMTransport([
            { content: 'ok', finishReason: 'stop' },
        ]);
        const runner = new AssistantRunner({
            bridge,
            transport,
            settings: createDefaultSettings(),
        });

        const session = await runner.createSession({ mode: 'chat', title: 'docs index check' });
        await runner.sendPrompt(session.id, 'hi');

        expect(transport.requests).toHaveLength(1);
        const sysMsg = transport.requests[0].messages.find((m) => m.role === 'system');
        const sysText = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
        expect(sysText).toContain('/docs/st-native.md');
        expect(sysText).toContain('/docs/triggers.md');
        expect(sysText).toContain('/docs/ejs-reference.md');
        expect(sysText).toContain('/docs/status-ui.md');
        expect(sysText).toContain('/docs/event-hooks.md');
        expect(sysText).toContain('/docs/sidegen.md');
        expect(sysText).not.toContain('External Extension Docs');
    });

    it('supports external extension docs registration under /docs/extensions/<namespace>/ with isolation, lazy providers, and prompt discovery', async () => {
        const registry = new DocsRegistry(BUILTIN_DOCS);
        const bridge = new MemoryHostBridge();
        const vfs = new VirtualFileSystem({ bridge, docsRegistry: registry });

        // Initially no /docs/extensions dir is shown
        expect((await vfs.listDir('/docs')).some((e) => e.name === 'extensions')).toBe(false);

        let dynamicVersion = 1;
        const disposeBundle = registry.register({
            namespace: 'my-ext',
            docs: [
                {
                    path: 'guide.md',
                    title: 'My Ext 指南',
                    summary: 'My Ext 基础用法与命令',
                    content: '# My Ext Guide\nUse `/my-ext-run` to execute.',
                },
                {
                    path: 'api/hooks.md',
                    summary: 'Hooks 参考',
                    content: () => `# Hooks v${dynamicVersion}\nHook API reference.`,
                },
                {
                    path: 'internal.md',
                    content: 'Hidden from index, readable via VFS',
                    includeInAssistantIndex: false,
                },
            ],
        });

        const disposeSingle = registry.register({
            namespace: 'other_ext',
            path: 'overview.md',
            content: 'Other extension overview',
        });

        // Root /docs now shows extensions/, /docs/extensions shows namespaces, nested dirs work
        const docsEntries = await vfs.listDir('/docs');
        expect(docsEntries.some((e) => e.name === 'extensions' && e.kind === 'directory' && e.writable === false)).toBe(true);

        const extNamespaces = await vfs.listDir('/docs/extensions');
        expect(extNamespaces.map((e) => e.name)).toEqual(['my-ext', 'other_ext']);

        const myExtRoot = await vfs.listDir('/docs/extensions/my-ext');
        expect(myExtRoot.map((e) => `${e.name}:${e.kind}`)).toEqual([
            'api:directory',
            'guide.md:file',
            'internal.md:file',
        ]);
        expect((await vfs.listDir('/docs/extensions/my-ext/api')).map((e) => e.name)).toEqual(['hooks.md']);

        // Lazy provider evaluates dynamically & reads/sliceLines work
        expect(await vfs.readFile('/docs/extensions/my-ext/api/hooks.md')).toContain('# Hooks v1');
        dynamicVersion = 2;
        expect(await vfs.readFile('/docs/extensions/my-ext/api/hooks.md', { startLine: 1, endLine: 1 })).toBe('# Hooks v2');
        expect(await vfs.readFile('/docs/extensions/my-ext/internal.md')).toContain('Hidden from index');

        // Read-only enforcement on external docs
        await expect(vfs.writeFile('/docs/extensions/my-ext/guide.md', 'hack')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.editFile('/docs/extensions/my-ext/guide.md', 'My Ext', 'Hack')).rejects.toBeInstanceOf(VfsReadOnlyError);
        await expect(vfs.deleteFile('/docs/extensions/my-ext/guide.md')).rejects.toBeInstanceOf(VfsReadOnlyError);

        // Default '/' search still excludes external docs, while '/docs' and '/docs/extensions/my-ext' find them
        const rootSearch = await vfs.searchFiles('my-ext-run');
        expect(rootSearch.some((h) => h.path.startsWith('/docs/'))).toBe(false);

        const scopedSearch = await vfs.searchFiles('my-ext-run', { pathPrefix: '/docs/extensions/my-ext' });
        expect(scopedSearch.some((h) => h.path === '/docs/extensions/my-ext/guide.md')).toBe(true);

        const scopedGrep = await vfs.grepSearch('Hook API reference', { pathPrefix: '/docs' });
        expect(scopedGrep.some((h) => h.path === '/docs/extensions/my-ext/api/hooks.md')).toBe(true);

        const globExt = await vfs.globFiles('/docs/extensions/**/*.md');
        expect(globExt).toEqual([
            '/docs/extensions/my-ext/api/hooks.md',
            '/docs/extensions/my-ext/guide.md',
            '/docs/extensions/my-ext/internal.md',
            '/docs/extensions/other_ext/overview.md',
        ]);

        // Assistant prompt includes indexed external docs and omits includeInAssistantIndex=false
        const transport = new ScriptedLLMTransport([{ content: 'ok', finishReason: 'stop' }]);
        const runner = new AssistantRunner({
            bridge,
            transport,
            vfs,
            docsRegistry: registry,
            settings: createDefaultSettings(),
        });
        const session = await runner.createSession({ mode: 'chat', title: 'ext docs prompt' });
        await runner.sendPrompt(session.id, 'hi');
        const sysText = String(transport.requests[0].messages.find((m) => m.role === 'system')?.content ?? '');
        expect(sysText).toContain('External Extension Docs (/docs/extensions/, read-only):');
        expect(sysText).toContain('/docs/extensions/my-ext/guide.md — My Ext 基础用法与命令');
        expect(sysText).toContain('/docs/extensions/my-ext/api/hooks.md — Hooks 参考');
        expect(sysText).toContain('/docs/extensions/other_ext/overview.md');
        expect(sysText).not.toContain('/docs/extensions/my-ext/internal.md');

        // Overwrite protection: old unregister handle must NOT clobber newer registration at same path
        registry.register({ namespace: 'other_ext', path: 'overview.md', content: 'New v2' });
        disposeSingle();
        expect(await vfs.readFile('/docs/extensions/other_ext/overview.md')).toBe('New v2');

        // Unregister namespace & bundle cleanup restores clean /docs state
        expect(registry.unregisterNamespace('other_ext')).toBe(1);
        disposeBundle();
        expect((await vfs.listDir('/docs')).some((e) => e.name === 'extensions')).toBe(false);

        // Path traversal / invalid namespace rejection
        expect(() => registry.register({ namespace: '../evil', path: 'a.md', content: 'x' })).toThrow();
        expect(() => registry.register({ namespace: 'bad/ns', path: 'a.md', content: 'x' })).toThrow();
        expect(() => registry.register({ namespace: 'valid-ns', path: '../secret.md', content: 'x' })).toThrow();
        expect(() => registry.register({ namespace: 'valid-ns', path: 'a/../b.md', content: 'x' })).toThrow();
    });
});
