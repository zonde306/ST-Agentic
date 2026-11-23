import { describe, expect, it, vi } from 'vitest';
import {
    ApprovalGate,
    computeDiffLines,
    shouldRequireApproval,
} from '@/core/assistant/approval';
import {
    ADJUST_WRITE_TOOLS,
    ADMIN_TOOLS,
    AUTHOR_TOOLS,
    CHAT_READONLY_TOOLS,
    FULL_ENABLED_WI_TOOLS,
    evaluateToolPolicy,
    getAllowedToolsForMode,
    isCrossCardBatchOperation,
    isMandatoryConfirmTool,
    isVfsWritePathAllowed,
} from '@/core/assistant/policy';
import {
    REDACTED_PLACEHOLDER,
    isSecretKey,
    redactSecrets,
    redactString,
    redactWithReport,
} from '@/core/assistant/redact';
import {
    MemoryUndoPersistence,
    UNDO_KINDS,
    UndoStore,
    createChatMetadataUndoAdapter,
    createExtensionDataUndoAdapter,
    createUndoKindDispatcher,
} from '@/core/assistant/undo-store';
import type { UndoKind, UndoRecord } from '@/core/types';
import {
    SAMPLE_RAW_AUTHOR_WI_ENTRY,
    SAMPLE_SECRET_PAYLOAD,
    SAMPLE_UNDO_RECORD,
    createOffMainlineTestBridge,
} from '../../fixtures/off-mainline-fixtures';

// ============================================================================
// 1. Secret Redactor (`src/core/assistant/redact.ts`)
// ============================================================================

describe('redact.ts — Secret Redactor', () => {
    it('recursively redacts nested objects, arrays, Bearer tokens, and embedded JSON strings', () => {
        const report = redactWithReport(SAMPLE_SECRET_PAYLOAD);
        expect(report.hasSecretRedaction).toBe(true);
        expect(report.redactionCount).toBeGreaterThanOrEqual(12);

        const out = report.value as Record<string, any>;
        // Safe fields remain intact
        expect(out.safeField).toBe('雾港侦探录');
        expect(out.nested.headers.Accept).toBe('application/json');
        expect(out.connections[0].id).toBe('main');
        expect(out.connections[0].model).toBe('claude-3-7-sonnet');

        // Sensitive keys are replaced with ***REDACTED***
        expect(out.apiKey).toBe(REDACTED_PLACEHOLDER);
        expect(out.api_key).toBe(REDACTED_PLACEHOLDER);
        expect(out['x-api-key']).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.accessToken).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.clientSecret).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.dbPassword).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.private_key).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.headers.Authorization).toBe(REDACTED_PLACEHOLDER);
        expect(out.nested.headers.Cookie).toBe(REDACTED_PLACEHOLDER);
        expect(out.connections[0].apiKey).toBe(REDACTED_PLACEHOLDER);

        // Inline Bearer token in a non-secret key is redacted
        expect(out.connections[0].inlineNote).toBe(
            `Header was ${REDACTED_PLACEHOLDER} in logs`,
        );
        expect(out.connections[0].inlineNote).not.toContain('raw_inline_bearer_token_777');

        // Serialized JSON string is parsed, redacted, and re-serialized
        const parsedBlob = JSON.parse(out.jsonBlob) as Record<string, unknown>;
        expect(parsedBlob.endpoint).toBe('https://api.example.test/v1');
        expect(parsedBlob.token).toBe(REDACTED_PLACEHOLDER);
        expect(parsedBlob.ok).toBe(true);

        // Original input object is not mutated
        expect(SAMPLE_SECRET_PAYLOAD.apiKey).toBe('sk-proj-live-1234567890abcdef');
    });

    it('redacts all secret fields in MemoryHostBridge default host settings', async () => {
        const bridge = createOffMainlineTestBridge();
        expect(bridge.admin).toBeDefined();
        const rawSettings = await bridge.admin!.readHostSettings('all');
        const report = redactWithReport(rawSettings);

        expect(report.hasSecretRedaction).toBe(true);
        const serialized = JSON.stringify(report.value);
        expect(serialized).not.toContain('sk-test-power-user-secret');
        expect(serialized).not.toContain('tok_live_mock');
        expect(serialized).not.toContain('sk-ant-mock-agentic-key');
        expect(serialized).not.toContain('el_mock_token_secret');
        expect(serialized).not.toContain('mock_tts_bearer_token');
        expect(serialized).not.toContain('whsec_mock_secret');
        expect(serialized).not.toContain('mock-db-password');
        expect(serialized).not.toContain('mock_cookie_secret');
        expect(serialized).toContain('***REDACTED***');

        // Safe settings survive intact
        const out = report.value as Record<string, any>;
        expect(out.power_user.theme).toBe('Dark');
        expect(out.power_user.fast_ui_mode).toBe(true);
        expect(out.extension_settings.agentic.runMode).toBe('takeover');
    });

    it('redacts Error messages, stack traces, causes, and custom properties', () => {
        const cause = new Error('Upstream rejected Bearer eyJ_secret_jwt_payload_999');
        const err = new Error(
            'Request failed: {"apiKey":"sk-proj-abc123456789","ok":false} with api_key=my_raw_key',
        ) as Error & { cause?: unknown; authorization?: string; statusCode?: number };
        err.stack =
            'Error: boom\n    at callApi (https://example.test/v1?token=secret_query_tok&x=1)\n    at sk-ant-api03-leak123456';
        err.cause = cause;
        err.authorization = 'Bearer leaked_header_token';
        err.statusCode = 401;

        const report = redactWithReport(err);
        expect(report.hasSecretRedaction).toBe(true);
        expect(report.value).toBeInstanceOf(Error);
        expect(report.value.message).not.toContain('sk-proj-abc123456789');
        expect(report.value.message).not.toContain('my_raw_key');
        expect(report.value.message).toContain(REDACTED_PLACEHOLDER);
        expect(report.value.stack).not.toContain('secret_query_tok');
        expect(report.value.stack).not.toContain('sk-ant-api03-leak123456');
        expect((report.value.cause as Error).message).not.toContain('eyJ_secret_jwt_payload_999');
        expect(report.value.authorization).toBe(REDACTED_PLACEHOLDER);
        expect(report.value.statusCode).toBe(401);
    });

    it('preserves numeric LLM token usage metrics while redacting string secret tokens', () => {
        const traceLike = {
            runId: 'run_1',
            usage: {
                inputTokens: 1800,
                cachedTokens: 1500,
                outputTokens: 210,
                totalTokens: 2010,
            },
            estimatedTokens: 1420,
            maxTokens: 4096,
            safeMessage: 'All clear',
        };

        const cleanReport = redactWithReport(traceLike);
        expect(cleanReport.hasSecretRedaction).toBe(false);
        expect(cleanReport.redactionCount).toBe(0);
        expect(cleanReport.value).toEqual(traceLike);

        // String secret under `token` or even `inputTokens` must still be redacted
        expect(isSecretKey('inputTokens', 1800)).toBe(false);
        expect(isSecretKey('inputTokens', 'Bearer secret_val')).toBe(true);
        expect(isSecretKey('token', 'tok_123')).toBe(true);
        expect(isSecretKey('token', 12345)).toBe(true);
    });

    it('handles circular references, shared DAG objects, Maps, and Sets safely', () => {
        const shared = { secret: 'shared_secret_val', safe: 'ok' };
        const circular: Record<string, unknown> = {
            name: 'root',
            a: shared,
            b: shared,
            password: 'root_password',
        };
        circular.self = circular;
        const circularArr: unknown[] = ['sk-live-arraysecret999'];
        circularArr.push(circularArr);
        circular.arr = circularArr;

        const mapVal = new Map<string, unknown>([
            ['api_key', 'map_secret_key'],
            ['public', 'hello'],
        ]);
        const setVal = new Set<string>(['Bearer set_bearer_token_123', 'normal_text']);
        circular.mapVal = mapVal;
        circular.setVal = setVal;

        const report = redactWithReport(circular);
        expect(report.hasSecretRedaction).toBe(true);
        expect(report.value.self).toBe('[Circular]');
        expect(report.value.password).toBe(REDACTED_PLACEHOLDER);
        expect((report.value.a as Record<string, unknown>).secret).toBe(REDACTED_PLACEHOLDER);
        expect((report.value.b as Record<string, unknown>).secret).toBe(REDACTED_PLACEHOLDER);
        expect((report.value.b as Record<string, unknown>).safe).toBe('ok');

        const redactedArr = report.value.arr as unknown[];
        expect(redactedArr[0]).toBe(REDACTED_PLACEHOLDER);
        expect(redactedArr[1]).toBe('[Circular]');

        const redactedMap = report.value.mapVal as Map<string, unknown>;
        expect(redactedMap.get('api_key')).toBe(REDACTED_PLACEHOLDER);
        expect(redactedMap.get('public')).toBe('hello');

        const redactedSet = report.value.setVal as Set<string>;
        expect(redactedSet.has(REDACTED_PLACEHOLDER)).toBe(true);
        expect(redactedSet.has('normal_text')).toBe(true);
    });

    it('is idempotent on already-redacted output and supports redactSecrets / redactString', () => {
        const once = redactSecrets(SAMPLE_SECRET_PAYLOAD);
        const twice = redactWithReport(once);
        expect(twice.hasSecretRedaction).toBe(false);
        expect(twice.redactionCount).toBe(0);

        const strReport = redactString('Authorization: Bearer super_secret_tok\nAccept: text/plain');
        expect(strReport.hasSecretRedaction).toBe(true);
        expect(strReport.value).toBe(`Authorization: ${REDACTED_PLACEHOLDER}\nAccept: text/plain`);

        const alreadyRedactedHeader = redactString(`Authorization: ${REDACTED_PLACEHOLDER}`);
        expect(alreadyRedactedHeader.hasSecretRedaction).toBe(false);
    });
});

// ============================================================================
// 2. Four-Mode Policy Guard (`src/core/assistant/policy.ts`)
// ============================================================================

describe('policy.ts — 4-Mode Permission Matrix & Mandatory Confirm', () => {
    it('strictly enforces chat mode as read-only', () => {
        const allowedList = getAllowedToolsForMode('chat', false);
        expect(allowedList).toEqual([...CHAT_READONLY_TOOLS]);

        for (const tool of CHAT_READONLY_TOOLS) {
            const res = evaluateToolPolicy(tool, {}, { mode: 'chat' });
            expect(res.allowed, `chat should allow ${tool}`).toBe(true);
            expect(res.mutating).toBe(false);
            expect(res.requiresApproval).toBe(false);
            expect(res.mandatoryConfirm).toBe(false);
            expect(res.riskLevel).toBe('low');
        }

        const deniedInChat = [
            ...ADJUST_WRITE_TOOLS,
            ...AUTHOR_TOOLS,
            ...FULL_ENABLED_WI_TOOLS,
            ...ADMIN_TOOLS,
        ];
        for (const tool of deniedInChat) {
            const res = evaluateToolPolicy(tool, { path: '/workspace/a.md' }, { mode: 'chat', stAdminEnabled: true });
            expect(res.allowed, `chat must deny ${tool}`).toBe(false);
            expect(res.reason).toBeTruthy();
        }
    });

    it('allows current-chat writes in adjust mode with strict VFS path scoping and opt-in chat delete approval', () => {
        const allowedList = getAllowedToolsForMode('adjust', false);
        expect(allowedList).toEqual([...CHAT_READONLY_TOOLS, ...ADJUST_WRITE_TOOLS]);

        for (const tool of ADJUST_WRITE_TOOLS) {
            const args = ['write_file', 'append_file', 'edit_file'].includes(tool)
                ? { path: '/workspace/notes.md' }
                : tool === 'chat_create_message'
                  ? { role: 'assistant', content: '新增对白' }
                  : { messageId: 1 };
            const res = evaluateToolPolicy(tool, args, { mode: 'adjust' });
            expect(res.allowed, `adjust should allow ${tool}`).toBe(true);
            expect(res.mutating).toBe(true);
            expect(res.mandatoryConfirm).toBe(false);
            if (tool === 'chat_delete_message') {
                expect(res.requiresApproval).toBe(true);
                expect(res.baseRequiresApproval).toBe(true);
                expect(res.riskLevel).toBe('medium');
            } else {
                expect(res.requiresApproval).toBe(false);
            }
        }

        // chat_delete_message auto-approve gating in adjust / author / full
        const deleteAdjustDefault = evaluateToolPolicy(
            'chat_delete_message',
            { messageId: 1 },
            { mode: 'adjust', autoApproveChatDelete: false, autoApproveAuthor: true },
        );
        expect(deleteAdjustDefault.requiresApproval).toBe(true);
        expect(shouldRequireApproval(deleteAdjustDefault, false)).toBe(true);

        const deleteAdjustAuto = evaluateToolPolicy(
            'chat_delete_message',
            { messageId: 1 },
            { mode: 'adjust', autoApproveChatDelete: true },
        );
        expect(deleteAdjustAuto.requiresApproval).toBe(false);
        expect(shouldRequireApproval(deleteAdjustAuto, true)).toBe(false);

        const deleteAuthorAuto = evaluateToolPolicy(
            'chat_delete_message',
            { messageId: 1 },
            { mode: 'author', autoApproveAuthor: true },
        );
        expect(deleteAuthorAuto.requiresApproval).toBe(false);

        // VFS path scoping checks
        expect(isVfsWritePathAllowed('/workspace/draft.md')).toBe(true);
        expect(isVfsWritePathAllowed('/state/vars.json')).toBe(true);
        expect(isVfsWritePathAllowed('/lorebooks/chapter1.md')).toBe(true);
        expect(isVfsWritePathAllowed('/side/comms/linwan.md')).toBe(true);

        const disallowedPaths = [
            '/output.md',
            '/system/rules.md',
            '/chat/0.md',
            '/workspace/../system/rules.md',
            '/side/../../etc/passwd',
            '/workspace',
            '',
        ];
        for (const badPath of disallowedPaths) {
            expect(isVfsWritePathAllowed(badPath), `path ${badPath} must be denied`).toBe(false);
            for (const vfsTool of ['write_file', 'append_file', 'edit_file']) {
                const res = evaluateToolPolicy(vfsTool, { path: badPath }, { mode: 'full', stAdminEnabled: true });
                expect(res.allowed, `${vfsTool}(${badPath}) must be denied even in full+admin`).toBe(false);
            }
        }

        // Author, full, and admin tools remain denied in adjust mode
        for (const tool of [...AUTHOR_TOOLS, ...FULL_ENABLED_WI_TOOLS, ...ADMIN_TOOLS]) {
            const res = evaluateToolPolicy(tool, {}, { mode: 'adjust', stAdminEnabled: true });
            expect(res.allowed, `adjust must deny ${tool}`).toBe(false);
        }
    });

    it('allows author tools (inheriting chat + adjust) and denies full/admin tools in author mode', () => {
        const allowedList = getAllowedToolsForMode('author', false);
        expect(allowedList).toEqual([
            ...CHAT_READONLY_TOOLS,
            ...ADJUST_WRITE_TOOLS,
            ...AUTHOR_TOOLS,
        ]);

        // Read-only author tools do not require approval
        for (const roTool of ['card_read_full', 'wi_read_raw_book', 'regex_list_scoped']) {
            const res = evaluateToolPolicy(roTool, { bookName: '雾港侦探录' }, { mode: 'author' });
            expect(res.allowed).toBe(true);
            expect(res.mutating).toBe(false);
            expect(res.requiresApproval).toBe(false);
            expect(res.mandatoryConfirm).toBe(false);
        }

        // Standard author writes require approval by default, skippable with autoApproveAuthor
        for (const writeTool of [
            'card_patch_active',
            'wi_upsert_primary_entry',
            'regex_upsert_scoped',
            'card_embed_agentic',
        ]) {
            const defaultRes = evaluateToolPolicy(writeTool, { bookName: '雾港侦探录' }, { mode: 'author' });
            expect(defaultRes.allowed).toBe(true);
            expect(defaultRes.requiresApproval).toBe(true);
            expect(defaultRes.baseRequiresApproval).toBe(true);
            expect(defaultRes.mandatoryConfirm).toBe(false);
            expect(defaultRes.riskLevel).toBe('medium');

            const autoRes = evaluateToolPolicy(
                writeTool,
                { bookName: '雾港侦探录' },
                { mode: 'author', autoApproveAuthor: true },
            );
            expect(autoRes.allowed).toBe(true);
            expect(autoRes.requiresApproval).toBe(false);
            expect(autoRes.mandatoryConfirm).toBe(false);
        }

        // Full and admin tools remain denied in author mode even if stAdminEnabled is true
        for (const tool of [...FULL_ENABLED_WI_TOOLS, ...ADMIN_TOOLS]) {
            const res = evaluateToolPolicy(tool, {}, { mode: 'author', stAdminEnabled: true });
            expect(res.allowed, `author must deny ${tool}`).toBe(false);
        }
    });

    it('separates full (stAdminEnabled: false) from full + ST Admin (stAdminEnabled: true)', () => {
        // full without stAdminEnabled unlocks enabled WI tools ONLY, NOT admin tools
        expect(getAllowedToolsForMode('full', false)).toEqual([
            ...CHAT_READONLY_TOOLS,
            ...ADJUST_WRITE_TOOLS,
            ...AUTHOR_TOOLS,
            ...FULL_ENABLED_WI_TOOLS,
        ]);

        for (const tool of FULL_ENABLED_WI_TOOLS) {
            const res = evaluateToolPolicy(tool, { bookName: '雾港侦探录' }, { mode: 'full', stAdminEnabled: false });
            expect(res.allowed, `full(admin=false) should allow ${tool}`).toBe(true);
        }

        for (const adminTool of ADMIN_TOOLS) {
            const blocked = evaluateToolPolicy(adminTool, {}, { mode: 'full', stAdminEnabled: false });
            expect(blocked.allowed, `full(admin=false) must deny ${adminTool}`).toBe(false);
            expect(blocked.requiresAdmin).toBe(true);

            const unlocked = evaluateToolPolicy(adminTool, {}, { mode: 'full', stAdminEnabled: true });
            expect(unlocked.allowed, `full(admin=true) should allow ${adminTool}`).toBe(true);
        }

        expect(getAllowedToolsForMode('full', true)).toEqual([
            ...CHAT_READONLY_TOOLS,
            ...ADJUST_WRITE_TOOLS,
            ...AUTHOR_TOOLS,
            ...FULL_ENABLED_WI_TOOLS,
            ...ADMIN_TOOLS,
        ]);
    });

    it('enforces non-bypassable mandatoryConfirm even when autoApproveAuthor === true', () => {
        const mandatoryCases: Array<{ tool: string; args?: Record<string, unknown> }> = [
            { tool: 'wi_delete_primary_entry', args: { bookName: '雾港侦探录', uid: 7 } },
            { tool: 'regex_delete_scoped', args: { id: 'regex_1' } },
            { tool: 'wi_delete_enabled_entry', args: { bookName: '雾港侦探录', uid: 7 } },
            { tool: 'wi_admin_delete_entry', args: { bookName: '全局备用设定集', uid: 1 } },
            { tool: 'card_admin_delete', args: { chid: 2 } },
            { tool: 'st_settings_patch', args: { scope: 'power_user', patch: { fast_ui_mode: false } } },
            { tool: 'st_preset_select', args: { name: 'Default' } },
            { tool: 'st_preset_patch', args: { name: 'Default', patch: { temp: 0.7 } } },
            { tool: 'regex_admin_global_upsert', args: { script: {} } },
            { tool: 'regex_admin_global_delete', args: { id: 'g_1' } },
            { tool: 'st_slash_exec', args: { command: '/echo hi' } },
            { tool: 'st_import_url', args: { url: 'https://example.test/card.png' } },
            { tool: 'card_admin_patch', args: { chids: [0, 1, 2], fields: { creator: 'x' } } },
            { tool: 'card_admin_patch', args: { batch: true, fields: { tags: ['v2'] } } },
            { tool: 'card_admin_batch_update', args: { targets: [0, 1] } },
        ];

        for (const testCase of mandatoryCases) {
            expect(isMandatoryConfirmTool(testCase.tool, testCase.args)).toBe(true);

            const policy = evaluateToolPolicy(testCase.tool, testCase.args, {
                mode: 'full',
                stAdminEnabled: true,
                autoApproveAuthor: true,
            });
            expect(policy.allowed, `${testCase.tool} should be allowed in full+admin`).toBe(true);
            expect(policy.mandatoryConfirm, `${testCase.tool} must be mandatoryConfirm`).toBe(true);
            expect(policy.requiresApproval, `${testCase.tool} must require approval`).toBe(true);
            expect(policy.riskLevel).toBe('high');
            expect(shouldRequireApproval(policy, true)).toBe(true);
            expect(shouldRequireApproval(policy, false)).toBe(true);
        }

        // Cross-card batch helper distinguishes single-card vs multi-card batch
        expect(isCrossCardBatchOperation('card_admin_patch', { chid: 1 })).toBe(false);
        expect(isCrossCardBatchOperation('card_admin_patch', { chids: [1, 2] })).toBe(true);
        expect(isCrossCardBatchOperation('card_admin_patch', { allCharacters: true })).toBe(true);

        // Read-only admin tools do NOT trigger mandatoryConfirm or approval
        for (const roAdmin of ['st_settings_read', 'st_preset_list', 'card_admin_list_all', 'wi_admin_list_all']) {
            const res = evaluateToolPolicy(roAdmin, {}, { mode: 'full', stAdminEnabled: true });
            expect(res.allowed).toBe(true);
            expect(res.requiresApproval).toBe(false);
            expect(res.mandatoryConfirm).toBe(false);
        }
    });

    it('denies unknown tools in every mode and produces informative scope labels', () => {
        const unknown = evaluateToolPolicy('exec_arbitrary_shell', {}, { mode: 'full', stAdminEnabled: true });
        expect(unknown.allowed).toBe(false);
        expect(unknown.mandatoryConfirm).toBe(true);
        expect(shouldRequireApproval(unknown, true)).toBe(false);

        const wiPolicy = evaluateToolPolicy(
            'wi_upsert_primary_entry',
            { bookName: '雾港侦探录', uid: 7 },
            { mode: 'author' },
        );
        expect(wiPolicy.scopeLabel).toBe('WI: 雾港侦探录 / #7');

        const vfsPolicy = evaluateToolPolicy(
            'write_file',
            { path: '/side/comms/linwan.md' },
            { mode: 'adjust' },
        );
        expect(vfsPolicy.scopeLabel).toBe('VFS: /side/comms/linwan.md');

        const chatPolicy = evaluateToolPolicy(
            'chat_edit_message',
            { target: { messageId: 12, swipeId: 0 } },
            { mode: 'adjust' },
        );
        expect(chatPolicy.scopeLabel).toBe('Chat: #12#0');

        const createInsertPolicy = evaluateToolPolicy(
            'chat_create_message',
            { role: 'assistant', content: '插入消息', insertAt: 2 },
            { mode: 'adjust' },
        );
        expect(createInsertPolicy.scopeLabel).toBe('Chat: insert #2');

        const deleteSinglePolicy = evaluateToolPolicy(
            'chat_delete_message',
            { messageId: 3 },
            { mode: 'adjust' },
        );
        expect(deleteSinglePolicy.scopeLabel).toBe('Chat: #3');

        const deleteBatchPolicy = evaluateToolPolicy(
            'chat_delete_message',
            { messageIds: [1, 2, 3, 4] },
            { mode: 'adjust' },
        );
        expect(deleteBatchPolicy.scopeLabel).toBe('Chat: #1, #2, #3 (+1)');
    });
});

// ============================================================================
// 3. Diff & Approval State Machine (`src/core/assistant/approval.ts`)
// ============================================================================

describe('approval.ts — Line Diff & ApprovalGate Lifecycle', () => {
    it('computes accurate line-level diffs across add, del, ctx, CRLF, and context trimming', () => {
        expect(computeDiffLines('', '')).toEqual([]);

        expect(computeDiffLines('', 'line 1\nline 2')).toEqual([
            { type: 'add', text: 'line 1' },
            { type: 'add', text: 'line 2' },
        ]);

        expect(computeDiffLines('only old', '')).toEqual([
            { type: 'del', text: 'only old' },
        ]);

        const before = '@@system\r\n保持侦探口吻。\r\n尾注保留。';
        const after = '@@system\n保持冷硬派侦探叙事口吻。\n<% if (getvar("heat") > 5) { %>\n尾注保留。';
        const diff = computeDiffLines(before, after);
        expect(diff).toEqual([
            { type: 'ctx', text: '@@system' },
            { type: 'del', text: '保持侦探口吻。' },
            { type: 'add', text: '保持冷硬派侦探叙事口吻。' },
            { type: 'add', text: '<% if (getvar("heat") > 5) { %>' },
            { type: 'ctx', text: '尾注保留。' },
        ]);

        // Context trimming collapses distant unchanged lines
        const manyBefore = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
        const manyAfter = manyBefore.replace('line 6', 'line 6 EDITED');
        const trimmed = computeDiffLines(manyBefore, manyAfter, { contextLines: 1 });
        expect(trimmed).toEqual([
            { type: 'ctx', text: 'line 5' },
            { type: 'del', text: 'line 6' },
            { type: 'add', text: 'line 6 EDITED' },
            { type: 'ctx', text: 'line 7' },
        ]);
    });

    it('enforces shouldRequireApproval consistently with autoApproveAuthor and mandatoryConfirm', () => {
        const mediumPolicy = evaluateToolPolicy(
            'card_patch_active',
            { fields: { description: 'updated' } },
            { mode: 'author', autoApproveAuthor: false },
        );
        expect(shouldRequireApproval(mediumPolicy, false)).toBe(true);
        expect(shouldRequireApproval(mediumPolicy, true)).toBe(false);

        // Even if policy was evaluated with autoApproveAuthor: true, passing false to shouldRequireApproval still respects baseRequiresApproval
        const mediumPolicyAuto = evaluateToolPolicy(
            'card_patch_active',
            { fields: { description: 'updated' } },
            { mode: 'author', autoApproveAuthor: true },
        );
        expect(shouldRequireApproval(mediumPolicyAuto, true)).toBe(false);
        expect(shouldRequireApproval(mediumPolicyAuto, false)).toBe(true);

        const highPolicy = evaluateToolPolicy(
            'wi_delete_primary_entry',
            { bookName: '雾港侦探录', uid: 7 },
            { mode: 'author', autoApproveAuthor: true },
        );
        expect(shouldRequireApproval(highPolicy, true)).toBe(true);
        expect(shouldRequireApproval(highPolicy, false)).toBe(true);

        const adjustPolicy = evaluateToolPolicy('patch_variables', {}, { mode: 'adjust' });
        expect(shouldRequireApproval(adjustPolicy, false)).toBe(false);
    });

    it('runs the full pending -> rejected -> retry -> approved -> reverted state machine', () => {
        let nowMs = 1_732_328_000_000;
        const gate = new ApprovalGate({ now: () => nowMs });

        const created = gate.create({
            id: 'appr_1',
            sessionId: 'sess_1',
            messageId: 'msg_1',
            toolCallId: 'call_1',
            toolName: 'wi_upsert_primary_entry',
            mandatoryConfirm: false,
            title: '更新主世界书条目 #7',
            summary: '写入 @@system 规则',
            targetLabel: 'WI: 雾港侦探录 / #7',
            beforeText: '@@system\n旧规则',
            afterText: SAMPLE_RAW_AUTHOR_WI_ENTRY.content,
            rawContent: SAMPLE_RAW_AUTHOR_WI_ENTRY.content,
            args: { bookName: '雾港侦探录', uid: 7 },
        });

        expect(created.status).toBe('pending');
        expect(created.revision).toBe(1);
        expect(created.riskLevel).toBe('medium');
        expect(created.diffLines.some((d) => d.type === 'add')).toBe(true);
        expect(gate.listPending('sess_1')).toHaveLength(1);

        // Reject with feedback
        const rejected = gate.reject('appr_1', '请把 heat 阈值改成 > 8');
        expect(rejected.status).toBe('rejected');
        expect(rejected.rejectionFeedback).toBe('请把 heat 阈值改成 > 8');
        expect(gate.listPending('sess_1')).toHaveLength(0);

        // Cannot approve directly while rejected
        expect(() => gate.approve('appr_1')).toThrow(/Cannot approve/);

        // Retry increments revision, preserves/updates feedback, returns to pending with new diff
        const revisedContent = SAMPLE_RAW_AUTHOR_WI_ENTRY.content.replace('heat") > 5', 'heat") > 8');
        const retried = gate.retry('appr_1', {
            rawContent: revisedContent,
            beforeText: '@@system\n旧规则',
            afterText: revisedContent,
            args: { bookName: '雾港侦探录', uid: 7, threshold: 8 },
        });
        expect(retried.status).toBe('pending');
        expect(retried.revision).toBe(2);
        expect(retried.rejectionFeedback).toBe('请把 heat 阈值改成 > 8');
        expect(retried.rawContent).toContain('heat") > 8');

        // Retry again directly from pending with additional feedback
        const retriedAgain = gate.retry('appr_1', {
            rejectionFeedback: '再加一句夜间戒严说明',
        });
        expect(retriedAgain.revision).toBe(3);
        expect(retriedAgain.status).toBe('pending');
        expect(retriedAgain.rejectionFeedback).toBe('再加一句夜间戒严说明');

        // Approve and attach undoId
        const approved = gate.approve('appr_1');
        expect(approved.status).toBe('approved');
        expect(approved.reverted).toBe(false);

        const withUndo = gate.attachUndo('appr_1', 'undo_wi_7');
        expect(withUndo.undoId).toBe('undo_wi_7');

        // Cannot reject, approve again, or retry once approved
        expect(() => gate.approve('appr_1')).toThrow(/Cannot approve/);
        expect(() => gate.reject('appr_1')).toThrow(/Cannot reject/);
        expect(() => gate.retry('appr_1')).toThrow(/Cannot retry/);

        // Mark reverted
        const reverted = gate.markReverted('appr_1', 'undo_wi_7');
        expect(reverted.reverted).toBe(true);
        expect(reverted.undoId).toBe('undo_wi_7');

        // Mandatory confirm automatically upgrades riskLevel to high
        nowMs += 1000;
        const mandatoryItem = gate.create({
            sessionId: 'sess_1',
            messageId: 'msg_2',
            toolCallId: 'call_2',
            toolName: 'st_settings_patch',
            riskLevel: 'medium',
            mandatoryConfirm: true,
            title: 'Patch ST settings',
            summary: 'High risk',
            targetLabel: 'ST Settings: power_user',
            rawContent: '{"fast_ui_mode":false}',
            args: { scope: 'power_user' },
        });
        expect(mandatoryItem.riskLevel).toBe('high');
        expect(mandatoryItem.mandatoryConfirm).toBe(true);
        expect(() => gate.markReverted(mandatoryItem.id)).toThrow(/Cannot mark/);

        // Snapshot export/hydrate round-trip
        const snapshot = gate.exportSnapshot();
        const restored = new ApprovalGate();
        restored.hydrate(snapshot);
        expect(restored.get('appr_1')?.reverted).toBe(true);
        expect(restored.get(mandatoryItem.id)?.status).toBe('pending');
    });
});

// ============================================================================
// 4. Pre-Write Snapshot Undo Engine (`src/core/assistant/undo-store.ts`)
// ============================================================================

describe('undo-store.ts — 7-Kind Pre-Write Snapshot & Idempotent Rollback', () => {
    it('supports pushing, listing, filtering, and dispatching rollback across all 7 UndoKinds', async () => {
        const store = new UndoStore({ now: () => 1_732_328_000_000 });
        const revertedKinds: UndoKind[] = [];

        const handlers: Record<UndoKind, (record: UndoRecord) => Promise<void>> = {
            chat_message: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            variables: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            vfs_file: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            character: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            worldinfo: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            regex: async (rec) => {
                revertedKinds.push(rec.kind);
            },
            st_setting: async (rec) => {
                revertedKinds.push(rec.kind);
            },
        };
        const dispatcher = createUndoKindDispatcher(handlers);

        const pushedIds: string[] = [];
        for (const [idx, kind] of UNDO_KINDS.entries()) {
            const rec = store.push({
                sessionId: idx % 2 === 0 ? 'sess_a' : 'sess_b',
                toolCallId: `call_${kind}`,
                toolName: `tool_${kind}`,
                kind,
                label: `Snapshot for ${kind}`,
                scope: `scope:${kind}`,
                beforeSummary: 'before',
                afterSummary: 'after',
                snapshot: { kind, prev: { nested: idx } },
                target: { messageId: idx, swipeId: 0 },
            });
            pushedIds.push(rec.id);
        }

        // Stack order is newest-first
        const all = store.list();
        expect(all).toHaveLength(7);
        expect(all[0].kind).toBe('st_setting');
        expect(all[6].kind).toBe('chat_message');

        // Filter by sessionId string or structured filter
        expect(store.list('sess_a')).toHaveLength(4);
        expect(store.list('sess_b')).toHaveLength(3);
        expect(store.list({ kind: 'worldinfo' })).toHaveLength(1);
        expect(store.countPending()).toBe(7);

        // Revert every kind via dispatcher
        for (const id of pushedIds) {
            const res = await store.revert(id, dispatcher);
            expect(res.ok).toBe(true);
            expect(res.status).toBe('reverted');
            expect(res.record?.reverted).toBe(true);
        }

        expect(revertedKinds).toEqual([...UNDO_KINDS]);
        expect(store.countPending()).toBe(0);
        expect(store.list({ includeReverted: false })).toHaveLength(0);
    });

    it('guarantees idempotent revert without double-applying (sequential & concurrent) and safe failure retry', async () => {
        const store = new UndoStore();
        const mutableSnapshot = { nested: { content: '原始正文' } };
        const pushed = store.push({
            ...SAMPLE_UNDO_RECORD,
            snapshot: mutableSnapshot,
        });

        // Mutating original object or returned copy must NOT mutate stored snapshot
        mutableSnapshot.nested.content = '被外部污染的正文';
        pushed.snapshot.nested = { content: '被返回值污染' };
        expect((store.get(pushed.id)?.snapshot.nested as { content: string }).content).toBe('原始正文');

        // Failure leaves record unreverted so caller can retry
        let attempt = 0;
        const flakyExecutor = vi.fn(async () => {
            attempt += 1;
            if (attempt === 1) {
                throw new Error('transient host error');
            }
        });

        const failed = await store.revert(pushed.id, flakyExecutor);
        expect(failed.ok).toBe(false);
        expect(failed.status).toBe('failed');
        expect(failed.error).toContain('transient host error');
        expect(store.get(pushed.id)?.reverted).toBe(false);

        // Retry succeeds
        const succeeded = await store.revert(pushed.id, flakyExecutor);
        expect(succeeded.ok).toBe(true);
        expect(succeeded.status).toBe('reverted');
        expect(store.get(pushed.id)?.reverted).toBe(true);
        expect(flakyExecutor).toHaveBeenCalledTimes(2);

        // Subsequent revert is an idempotent no-op — executor is NOT called again
        const noop = await store.revert(pushed.id, flakyExecutor);
        expect(noop.ok).toBe(true);
        expect(noop.status).toBe('already_reverted');
        expect(flakyExecutor).toHaveBeenCalledTimes(2);

        // Missing record returns not_found and never calls executor
        const missing = await store.revert('undo_does_not_exist', flakyExecutor);
        expect(missing.ok).toBe(false);
        expect(missing.status).toBe('not_found');
        expect(flakyExecutor).toHaveBeenCalledTimes(2);

        // Concurrent revert calls on the same undoId only execute once
        const second = store.push({
            sessionId: 'sess_concurrent',
            toolCallId: 'call_conc',
            toolName: 'patch_variables',
            kind: 'variables',
            label: 'Concurrent test',
            scope: 'vars',
            beforeSummary: 'hp=10',
            afterSummary: 'hp=5',
            snapshot: { hp: 10 },
        });
        const slowExecutor = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
        });

        const [r1, r2] = await Promise.all([
            store.revert(second.id, slowExecutor),
            store.revert(second.id, slowExecutor),
        ]);
        expect(slowExecutor).toHaveBeenCalledTimes(1);
        expect(r1.ok && r2.ok).toBe(true);
        expect([r1.status, r2.status].sort()).toEqual(['already_reverted', 'reverted']);
    });

    it('persists and reloads across Memory, ChatMetadata, and ExtensionData adapters with capacity eviction', async () => {
        // 1. MemoryUndoPersistence isolated by storageKey
        const memAdapter = new MemoryUndoPersistence();
        const storeA = new UndoStore({ persistence: memAdapter, storageKey: 'chat_1' });
        const storeB = new UndoStore({ persistence: memAdapter, storageKey: 'chat_2' });

        const recA = storeA.push(SAMPLE_UNDO_RECORD);
        await storeA.flush();

        const reloadedA = new UndoStore({ persistence: memAdapter, storageKey: 'chat_1' });
        await reloadedA.load();
        expect(reloadedA.get(recA.id)?.label).toBe(SAMPLE_UNDO_RECORD.label);

        await storeB.load();
        expect(storeB.list()).toHaveLength(0);

        // 2. ChatMetadata adapter via MemoryHostBridge
        const bridge = createOffMainlineTestBridge();
        const metaAdapter = createChatMetadataUndoAdapter(
            () => bridge.getMetadata(),
            () => bridge.saveChatDebounced(),
        );
        const metaStore = new UndoStore({ persistence: metaAdapter, storageKey: 'ast_session_1' });
        metaStore.push(SAMPLE_UNDO_RECORD);
        await metaStore.flush();
        expect(bridge.saveChatCalls).toBeGreaterThanOrEqual(1);

        const metaStore2 = new UndoStore({ persistence: metaAdapter, storageKey: 'ast_session_1' });
        const loadedMeta = await metaStore2.load();
        expect(loadedMeta).toHaveLength(1);
        expect(loadedMeta[0].id).toBe(SAMPLE_UNDO_RECORD.id);

        // 3. ExtensionData adapter via MemoryHostBridge
        const extAdapter = createExtensionDataUndoAdapter(
            (key, fallback) => bridge.loadExtensionData(key, fallback),
            (key, value) => bridge.saveExtensionData(key, value),
        );
        const extStore = new UndoStore({ persistence: extAdapter, storageKey: 'global_ast' });
        const extRec = extStore.push({
            ...SAMPLE_UNDO_RECORD,
            id: 'undo_ext_1',
            kind: 'character',
        });
        await extStore.flush();

        const extStore2 = new UndoStore({ persistence: extAdapter, storageKey: 'global_ast' });
        await extStore2.load();
        expect(extStore2.get(extRec.id)?.kind).toBe('character');

        // 4. Capacity limit prefers evicting already-reverted entries before active ones
        const bounded = new UndoStore({ maxRecords: 2 });
        const u1 = bounded.push({ ...SAMPLE_UNDO_RECORD, id: 'u1' });
        const u2 = bounded.push({ ...SAMPLE_UNDO_RECORD, id: 'u2' });
        await bounded.revert(u2.id, async () => {});
        const u3 = bounded.push({ ...SAMPLE_UNDO_RECORD, id: 'u3' });

        expect(bounded.list().map((r) => r.id)).toEqual([u3.id, u1.id]);
        expect(bounded.get(u2.id)).toBeUndefined();
    });
});
