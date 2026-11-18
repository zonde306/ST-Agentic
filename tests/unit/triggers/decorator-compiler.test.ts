import { describe, expect, it } from 'vitest';
import { createDefaultMainAgent, createDefaultPreset } from '@/core/config';
import { DecoratorCompiler, groupTriggersForExecution } from '@/core/triggers';
import type { RawLoreEntry, TriggerRule } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { MemoryHostBridge } from '../../mocks';

function makeEntry(partial: Partial<RawLoreEntry> & { uid: number; content: string }): RawLoreEntry {
    return {
        world: partial.world ?? '霜烬纪元',
        uid: partial.uid,
        comment: partial.comment ?? `Entry ${partial.uid}`,
        content: partial.content,
        keys: partial.keys ?? [],
        keysecondary: partial.keysecondary ?? [],
        constant: partial.constant ?? true,
        selective: partial.selective ?? false,
        disable: partial.disable ?? false,
        position: partial.position ?? 1,
        depth: partial.depth ?? 4,
        order: partial.order ?? 1,
        role: partial.role ?? 0,
        decorators: partial.decorators,
    };
}

describe('DecoratorCompiler & Trigger Grouping', () => {
    it('compiles legacy @@replace* to scoped VFS read/edit/write permissions on that entry path', async () => {
        const compiler = new DecoratorCompiler();
        const entry = makeEntry({
            uid: 9,
            comment: '动态事件日志',
            content: '@@replace\n@@batch_order 2\n记录本轮灰港公开事件。',
        });
        const otherEntry = makeEntry({
            uid: 99,
            comment: '其他档案',
            content: '不可被 @@replace(9) 篡改的档案',
        });

        const compiled = compiler.compile([entry, otherEntry]);
        expect(compiled.triggers).toHaveLength(1);

        const rule = compiled.triggers[0];
        expect(rule.phase).toBe('after_turn');
        expect(rule.order).toBe(2);
        expect(rule.barrier).toBe('self');
        expect(rule.kind).toBe('agent');
        expect(rule.targetPath).toBe('/lorebooks/霜烬纪元/动态事件日志-9.md');
        expect(rule.instructionTemplate).toBe('记录本轮灰港公开事件。');

        const derivedAgent = compiled.derivedAgents[rule.agentProfileId];
        expect(derivedAgent).toBeDefined();
        expect(derivedAgent.enabledTools).toEqual(
            expect.arrayContaining(['read_file', 'edit_file', 'write_file']),
        );
        expect(derivedAgent.permissions.write).toEqual(['/lorebooks/霜烬纪元/动态事件日志-9.md']);

        // Verify ScopedToolGuard strictly blocks writes outside the compiled entry path
        const bridge = new MemoryHostBridge({
            lorebooks: { 霜烬纪元: [entry, otherEntry] },
        });
        bridge.pushMessage({ id: 0, name: 'User', isUser: true, mes: 'hello' });
        const vfs = new VirtualFileSystem({ bridge });
        const guard = vfs.createScopedGuard(derivedAgent.permissions, {
            target: { messageId: 0, swipeId: 0 },
        });

        await expect(
            guard.write('/lorebooks/霜烬纪元/其他档案-99.md', 'illegal overwrite'),
        ).rejects.toThrow(/unauthorized|denied|permission|not allowed/i);

        await guard.write('/lorebooks/霜烬纪元/动态事件日志-9.md', '合法更新事件');
        expect(await guard.read('/lorebooks/霜烬纪元/动态事件日志-9.md')).toContain('合法更新事件');

        // @@replace_before maps to before_turn + turn barrier
        const beforeEntry = makeEntry({
            uid: 10,
            comment: '前置日程',
            content: '@@replace_before\n更新前置日程。',
        });
        const beforeCompiled = compiler.compile([beforeEntry]);
        expect(beforeCompiled.triggers[0].phase).toBe('before_turn');
        expect(beforeCompiled.triggers[0].barrier).toBe('turn');
    });

    it('compiles @@variables_json + @@zod_schema into /state/variables.json scoped rule with schemaSource', () => {
        const compiler = new DecoratorCompiler();
        const entry = makeEntry({
            uid: 11,
            comment: '变量状态结算',
            content: [
                '@@variables_json',
                '@@zod_schema z.object({ hp: z.number().min(0).max(100), location: z.string() }).loose()',
                '根据剧情变化更新 hp 与 location。',
            ].join('\n'),
        });

        const compiled = compiler.compile([entry]);
        expect(compiled.triggers).toHaveLength(1);
        const rule = compiled.triggers[0];
        expect(rule.phase).toBe('after_turn');
        expect(rule.barrier).toBe('turn');
        expect(rule.targetPath).toBe('/state/variables.json');
        expect(rule.schemaSource).toEqual({
            kind: 'zod',
            raw: 'z.object({ hp: z.number().min(0).max(100), location: z.string() }).loose()',
        });
        expect(rule.instructionTemplate).toBe('根据剧情变化更新 hp 与 location。');

        const agent = compiled.derivedAgents[rule.agentProfileId];
        expect(agent.enabledTools).toEqual(
            expect.arrayContaining(['read_variables', 'patch_variables', 'read_file']),
        );
        expect(agent.permissions.write).toEqual(['/state/variables.json']);
    });

    it('compiles @@append_output, @@replace_output, @@evaluate_ejs, @@trigger, @@script, @@agent, and @@tool', () => {
        const compiler = new DecoratorCompiler();
        const chronicler = createDefaultMainAgent({
            id: 'chronicler',
            name: 'Chronicler',
            enabledTools: ['read_file', 'write_file'],
            permissions: { read: ['/**'], write: ['/memory/**'] },
        });
        const preset = createDefaultPreset({
            agents: {
                main: createDefaultMainAgent(),
                chronicler,
            },
        });

        const compiled = compiler.compile(
            [
                makeEntry({
                    uid: 20,
                    comment: '状态卡附加',
                    content: '@@append_output\n在正文下方追加简短状态栏。',
                }),
                makeEntry({
                    uid: 21,
                    comment: 'EJS 零消耗脚本',
                    content: '@@evaluate_ejs_before\n<% setvar("turn_flag", true); %>',
                }),
                makeEntry({
                    uid: 22,
                    comment: '结构化触发器',
                    content: '@@trigger phase=after order=3 barrier=none profile=chronicler target=/memory/chronicle.md\n记录章节编年史。',
                }),
                makeEntry({
                    uid: 23,
                    comment: '确定性 JS 脚本',
                    content: '@@script phase=before order=1 barrier=turn\nawait vars.set("turnPhase", "ready");',
                }),
                makeEntry({
                    uid: 24,
                    comment: '考据专家',
                    content: '@@agent archivist topic\n检索相关资料并总结。',
                }),
                makeEntry({
                    uid: 25,
                    comment: '自定义工具',
                    content: '@@tool dice_roll\nexport default defineTool({ name: "dice_roll", description: "roll", parameters: z.object({}), execute: () => 6 });',
                }),
            ],
            { preset },
        );

        expect(compiled.triggers).toHaveLength(4);
        const [appendRule, ejsRule, triggerRule, scriptRule] = compiled.triggers;

        expect(compiled.derivedAgents[appendRule.agentProfileId].enabledTools).toContain('append_reply_view');
        expect(appendRule.phase).toBe('after_turn');

        expect(ejsRule.kind).toBe('script');
        expect(ejsRule.phase).toBe('before_turn');
        expect(ejsRule.barrier).toBe('turn');
        expect(ejsRule.decorator).toBe('@@evaluate_ejs_before');

        expect(triggerRule.kind).toBe('agent');
        expect(triggerRule.phase).toBe('after_turn');
        expect(triggerRule.order).toBe(3);
        expect(triggerRule.barrier).toBe('none');
        expect(triggerRule.agentProfileId).toBe('chronicler');
        expect(triggerRule.targetPath).toBe('/memory/chronicle.md');

        expect(scriptRule.kind).toBe('script');
        expect(scriptRule.phase).toBe('before_turn');
        expect(scriptRule.order).toBe(1);
        expect(scriptRule.barrier).toBe('turn');
        expect(scriptRule.scriptCode).toContain('vars.set("turnPhase"');

        expect(compiled.subAgents).toHaveLength(1);
        expect(compiled.subAgents[0]).toMatchObject({
            name: 'archivist',
            toolName: 'delegate_agent_archivist',
            paramNames: ['topic'],
        });

        expect(compiled.toolEntries).toHaveLength(1);
        expect(compiled.toolEntries[0].name).toBe('dice_roll');
    });

    it('enforces default 1 Trigger = 1 Run isolation and merges ONLY when phase + order + groupName + agentProfileId match', () => {
        const compiler = new DecoratorCompiler();
        const chronicler = createDefaultMainAgent({ id: 'chronicler' });
        const observer = createDefaultMainAgent({ id: 'observer' });
        const preset = createDefaultPreset({
            agents: {
                main: createDefaultMainAgent(),
                chronicler,
                observer,
            },
        });

        const compiled = compiler.compile(
            [
                // No @@group -> must remain isolated even with identical phase + order + profile
                makeEntry({
                    uid: 1,
                    comment: 'NoGroup A',
                    content: '@@trigger phase=after order=1 barrier=self profile=chronicler\n任务A',
                }),
                makeEntry({
                    uid: 2,
                    comment: 'NoGroup B',
                    content: '@@trigger phase=after order=1 barrier=self profile=chronicler\n任务B',
                }),
                // Matching phase + order + groupName + profile -> merged into 1 run!
                makeEntry({
                    uid: 3,
                    comment: 'Grouped 1',
                    content: '@@trigger phase=after order=2 barrier=self profile=chronicler\n@@group memo_pack\n合并任务1',
                }),
                makeEntry({
                    uid: 4,
                    comment: 'Grouped 2',
                    content: '@@trigger phase=after order=2 barrier=self profile=chronicler\n@@group memo_pack\n合并任务2',
                }),
                // Same groupName + order + phase, DIFFERENT profile -> must NOT merge!
                makeEntry({
                    uid: 5,
                    comment: 'Diff Profile',
                    content: '@@trigger phase=after order=2 barrier=self profile=observer\n@@group memo_pack\n不同Agent不合并',
                }),
                // Same groupName + profile + phase, DIFFERENT order -> must NOT merge!
                makeEntry({
                    uid: 6,
                    comment: 'Diff Order',
                    content: '@@trigger phase=after order=3 barrier=self profile=chronicler\n@@group memo_pack\n不同Order不合并',
                }),
            ],
            { preset },
        );

        const units = groupTriggersForExecution(compiled.triggers);
        expect(units).toHaveLength(5);

        expect(units[0].isGrouped).toBe(false);
        expect(units[0].triggers.map((t) => t.label)).toEqual(['NoGroup A']);

        expect(units[1].isGrouped).toBe(false);
        expect(units[1].triggers.map((t) => t.label)).toEqual(['NoGroup B']);

        const mergedUnit = units.find((u) => u.triggers.length === 2);
        expect(mergedUnit).toBeDefined();
        expect(mergedUnit!.isGrouped).toBe(true);
        expect(mergedUnit!.groupName).toBe('memo_pack');
        expect(mergedUnit!.agentProfileId).toBe('chronicler');
        expect(mergedUnit!.triggers.map((t) => t.label)).toEqual(['Grouped 1', 'Grouped 2']);

        // Also ensure scripts never merge even if they share @@group
        const scriptRules: TriggerRule[] = [
            {
                id: 's1',
                label: 'Script 1',
                source: 'worldinfo',
                phase: 'after_turn',
                order: 1,
                barrier: 'self',
                agentProfileId: 'script',
                kind: 'script',
                groupName: 'g',
                condition: { type: 'always' },
                instructionTemplate: '1',
                scriptCode: '1',
                enabled: true,
            },
            {
                id: 's2',
                label: 'Script 2',
                source: 'worldinfo',
                phase: 'after_turn',
                order: 1,
                barrier: 'self',
                agentProfileId: 'script',
                kind: 'script',
                groupName: 'g',
                condition: { type: 'always' },
                instructionTemplate: '2',
                scriptCode: '2',
                enabled: true,
            },
        ];
        expect(groupTriggersForExecution(scriptRules)).toHaveLength(2);
    });
});
