import { describe, expect, it } from 'vitest';
import {
    compileVariableSchemaEntries,
    createBuiltinToolRegistry,
    createToolExecutionContext,
} from '@/core/tools';
import type { RawLoreEntry } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { IframeJsSandbox } from '@/sandbox';
import hollowChineseCard from '../../fixtures/hollow-chinese-card.json';
import { MemoryHostBridge } from '../../mocks';

function setupBridge() {
    const bridge = new MemoryHostBridge({
        identity: hollowChineseCard.identity,
        lorebooks: {
            '霜烬纪元': hollowChineseCard.lorebooks['霜烬纪元'] as RawLoreEntry[],
        },
    });
    bridge.pushMessage({ name: 'User', isUser: true, mes: '开始行动' });
    bridge.pushMessage({
        name: 'Assistant',
        isUser: false,
        mes: '分支正文',
        swipes: ['分支 0', '分支 1'],
        swipeInfo: [{}, {}],
    });
    return bridge;
}

describe('Variable Tools & Dynamic @@json_schema / @@zod_schema Validation', () => {
    it('reads variables by path or full tree and optionally includes active JSON schema', async () => {
        const bridge = setupBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const sandbox = new IframeJsSandbox();

        const schema = await compileVariableSchemaEntries(
            [
                {
                    world: 'Rules',
                    uid: 100,
                    comment: 'Core Vars Schema',
                    content:
                        '@@json_schema {"type":"object","properties":{"hp":{"type":"number","minimum":0,"maximum":100},"location":{"type":"string"}},"required":["hp"]}',
                    keys: [],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 0,
                    order: 1,
                    role: 0,
                },
            ],
            sandbox,
        );

        const registry = createBuiltinToolRegistry();
        const ctx = createToolExecutionContext({
            bridge,
            vfs,
            target: { messageId: 1, swipeId: 0 },
            getVariableSchema: () => schema,
        });

        const full = JSON.parse(
            (await registry.executeToolCall('read_variables', { include_schema: true }, ctx)).output,
        );
        expect(full.ok).toBe(true);
        expect(full.variables).toMatchObject({ hp: 100, location: '灰港码头' });
        expect(full.json_schema.properties.hp.maximum).toBe(100);

        const single = JSON.parse(
            (await registry.executeToolCall('read_variables', { path: 'location' }, ctx)).output,
        );
        expect(single.ok).toBe(true);
        expect(single.variables).toBe('灰港码头');
    });

    it('enforces compiled @@zod_schema and @@json_schema on patch_variables and returns exact error paths for self-healing', async () => {
        const bridge = setupBridge();
        const vfs = new VirtualFileSystem({ bridge });
        const sandbox = new IframeJsSandbox();

        const schemaEntries: RawLoreEntry[] = [
            {
                world: 'Rules',
                uid: 1,
                comment: 'Base JSON Schema',
                content: [
                    '@@json_schema',
                    '```json',
                    JSON.stringify({
                        type: 'object',
                        properties: {
                            hp: { type: 'number', minimum: 0, maximum: 100 },
                            stats: {
                                type: 'object',
                                properties: {
                                    gold: { type: 'number', minimum: 0 },
                                },
                                required: ['gold'],
                            },
                        },
                        required: ['hp'],
                    }),
                    '```',
                ].join('\n'),
                keys: [],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 1,
                role: 0,
            },
            {
                world: 'Rules',
                uid: 2,
                comment: 'Mood Zod Schema',
                content:
                    '@@zod_schema z.object({ mood: z.enum(["calm", "tense", "hostile"]).default("calm"), tags: z.array(z.string()).default([]) }).loose()',
                keys: [],
                keysecondary: [],
                constant: false,
                selective: false,
                disable: false,
                position: 0,
                depth: 0,
                order: 2,
                role: 0,
            },
        ];

        const compiledSchema = await compileVariableSchemaEntries(schemaEntries, sandbox);
        const registry = createBuiltinToolRegistry();

        const ctxS0 = createToolExecutionContext({
            bridge,
            vfs,
            target: { messageId: 1, swipeId: 0 },
            getVariableSchema: () => compiledSchema,
        });
        const ctxS1 = createToolExecutionContext({
            bridge,
            vfs,
            target: { messageId: 1, swipeId: 1 },
            getVariableSchema: () => compiledSchema,
        });

        // Round 1: Model makes invalid updates (hp > 100, invalid nested stats.gold, invalid enum mood)
        const invalidRes = await registry.executeToolCall(
            'patch_variables',
            {
                json_merge: {
                    hp: 150,
                    mood: 'furious',
                    stats: { gold: -5 },
                },
            },
            ctxS0,
        );
        expect(invalidRes.ok).toBe(false);
        const errPayload = JSON.parse(invalidRes.output) as {
            ok: boolean;
            error: string;
            issues: Array<{ path: string; jsonPointer: string }>;
        };
        expect(errPayload.ok).toBe(false);
        expect(errPayload.issues.map((i) => i.path)).toEqual(
            expect.arrayContaining(['hp', 'mood', 'stats.gold']),
        );
        expect(errPayload.error).toContain('hp');
        expect(errPayload.error).toContain('mood');
        expect(errPayload.error).toContain('stats.gold');

        // Nothing mutated on failure!
        expect((await vfs.readVariables({ target: { messageId: 1, swipeId: 0 } })).hp).toBe(100);

        // Round 2: Model self-heals using reported paths via json_merge + json_patch
        const fixedRes = await registry.executeToolCall(
            'patch_variables',
            {
                json_merge: {
                    hp: 85,
                    mood: 'tense',
                    stats: { gold: 40 },
                    tempFlag: true,
                },
                json_patch: [
                    { op: 'add', path: '/tags', value: ['码头'] },
                    { op: 'add', path: '/tags/-', value: '夜袭' },
                    { op: 'remove', path: '/tempFlag' },
                ],
            },
            ctxS0,
        );
        expect(fixedRes.ok).toBe(true);

        const varsS0 = await vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect(varsS0).toMatchObject({
            hp: 85,
            mood: 'tense',
            stats: { gold: 40 },
            tags: ['码头', '夜袭'],
        });
        expect('tempFlag' in varsS0).toBe(false);

        // Swipe 1 remains cleanly isolated from Swipe 0
        const varsS1 = await vfs.readVariables({ target: { messageId: 1, swipeId: 1 } });
        expect(varsS1.hp).toBe(100);
        expect(varsS1.stats).toBeUndefined();

        // Also test JSON Patch failure self-healing (e.g. failed `test` op or missing target path)
        const failedTestOp = await registry.executeToolCall(
            'patch_variables',
            {
                json_patch: [{ op: 'test', path: '/hp', value: 999 }],
            },
            ctxS0,
        );
        expect(failedTestOp.ok).toBe(false);
        expect(failedTestOp.output).toContain('/hp');

        // Also test JSON Merge null deletion removes property
        const mergeDelete = await registry.executeToolCall(
            'patch_variables',
            { json_merge: { stats: null } },
            ctxS0,
        );
        expect(mergeDelete.ok).toBe(true);
        const afterDelete = await vfs.readVariables({ target: { messageId: 1, swipeId: 0 } });
        expect('stats' in afterDelete).toBe(false);
        expect(ctxS1.target.swipeId).toBe(1);

        // Also verify registerSchema() legacy @@zod_schema form and nested deepMergeZod
        const mergedSchema = await compileVariableSchemaEntries(
            [
                {
                    world: 'Rules',
                    uid: 10,
                    comment: 'Legacy Register 1',
                    content: '@@zod_schema\nconst s = z.object({ stats: z.object({ hp: z.number().min(0) }) }); registerSchema(s);',
                    keys: [],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 0,
                    order: 1,
                    role: 0,
                },
                {
                    world: 'Rules',
                    uid: 11,
                    comment: 'Legacy Register 2',
                    content: '@@zod_schema\nz.object({ stats: z.object({ mp: z.number().min(0) }) })',
                    keys: [],
                    keysecondary: [],
                    constant: false,
                    selective: false,
                    disable: false,
                    position: 0,
                    depth: 0,
                    order: 2,
                    role: 0,
                },
            ],
            sandbox,
        );
        expect(mergedSchema.safeParse({ stats: { hp: 10, mp: 20 } }).success).toBe(true);
        expect(mergedSchema.safeParse({ stats: { hp: 10, mp: -1 } }).success).toBe(false);
    });
});
