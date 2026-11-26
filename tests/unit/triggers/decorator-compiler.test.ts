import { describe, expect, it } from 'vitest';
import { createDefaultMainAgent, createDefaultPreset } from '@/core/config';
import { WIClassifier } from '@/core/lore';
import { DecoratorCompiler, groupTriggersForExecution } from '@/core/triggers';
import type { RawLoreEntry, TriggerRule } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { inferRuleFromLoreEntry } from '@/ui/studio/PipelineView';
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

        expect(appendRule.targetPath).toBe('/output.md');
        expect(appendRule.sourceWorld).toBe('霜烬纪元');
        expect(appendRule.sourceEntryUid).toBe(20);
        expect(compiled.derivedAgents[appendRule.agentProfileId].enabledTools).toEqual(
            expect.arrayContaining(['read_file', 'append_file', 'edit_file', 'read_variables', 'append_reply_view']),
        );
        expect(compiled.derivedAgents[appendRule.agentProfileId].permissions.write).toEqual(['/output.md']);
        expect(appendRule.phase).toBe('after_turn');

        expect(ejsRule.kind).toBe('script');
        expect(ejsRule.phase).toBe('before_turn');
        expect(ejsRule.barrier).toBe('turn');
        expect(ejsRule.decorator).toBe('@@evaluate_ejs_before');
        expect(ejsRule.sourceWorld).toBe('霜烬纪元');
        expect(ejsRule.sourceEntryUid).toBe(21);

        expect(triggerRule.kind).toBe('agent');
        expect(triggerRule.phase).toBe('after_turn');
        expect(triggerRule.order).toBe(3);
        expect(triggerRule.barrier).toBe('none');
        expect(triggerRule.agentProfileId).toBe('chronicler');
        expect(triggerRule.targetPath).toBe('/memory/chronicle.md');
        expect(triggerRule.sourceWorld).toBe('霜烬纪元');
        expect(triggerRule.sourceEntryUid).toBe(22);

        expect(scriptRule.kind).toBe('script');
        expect(scriptRule.phase).toBe('before_turn');
        expect(scriptRule.order).toBe(1);
        expect(scriptRule.barrier).toBe('turn');
        expect(scriptRule.scriptCode).toContain('vars.set("turnPhase"');
        expect(scriptRule.sourceWorld).toBe('霜烬纪元');
        expect(scriptRule.sourceEntryUid).toBe(23);

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

    it('compiles @@replace_output*, @@append_output*, @@trigger target=/output.md, and *_output_ejs* to /output.md direct-edit contracts', () => {
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([
            makeEntry({
                uid: 30,
                comment: '正文局部修校',
                content: '@@replace_output\n修正正文中的错别字与状态数值。',
            }),
            makeEntry({
                uid: 31,
                comment: '前置占位写入',
                content: '@@append_output_before\n预设开场分隔符。',
            }),
            makeEntry({
                uid: 32,
                comment: '输出文件触发器',
                content: '@@trigger phase=after order=2 barrier=self target=/output.md\n润色 /output.md 末尾段落。',
            }),
            makeEntry({
                uid: 33,
                comment: 'EJS 输出追加',
                content: '@@append_output_ejs\n[HP=<%= hp %>]',
            }),
            makeEntry({
                uid: 34,
                comment: 'EJS 输出替换',
                content: '@@replace_output_ejs_before\n[Init]',
            }),
        ]);

        expect(compiled.triggers).toHaveLength(5);
        const [replaceOut, appendBefore, triggerOut, appendEjs, replaceEjsBefore] = compiled.triggers;

        expect(replaceOut.targetPath).toBe('/output.md');
        expect(replaceOut.phase).toBe('after_turn');
        expect(replaceOut.barrier).toBe('self');
        expect(compiled.derivedAgents[replaceOut.agentProfileId].enabledTools).toEqual(
            expect.arrayContaining(['read_file', 'edit_file', 'write_file', 'append_file', 'read_variables', 'replace_reply_view']),
        );
        expect(compiled.derivedAgents[replaceOut.agentProfileId].permissions).toEqual({
            read: ['/**'],
            write: ['/output.md'],
        });

        expect(appendBefore.targetPath).toBe('/output.md');
        expect(appendBefore.phase).toBe('before_turn');
        expect(appendBefore.barrier).toBe('turn');
        expect(compiled.derivedAgents[appendBefore.agentProfileId].permissions.write).toEqual(['/output.md']);

        expect(triggerOut.targetPath).toBe('/output.md');
        expect(compiled.derivedAgents[triggerOut.agentProfileId].enabledTools).toEqual(
            expect.arrayContaining(['read_file', 'edit_file', 'append_file', 'write_file', 'read_variables']),
        );
        expect(compiled.derivedAgents[triggerOut.agentProfileId].permissions).toEqual({
            read: ['/**', '/state/variables.json'],
            write: ['/output.md'],
        });

        expect(appendEjs.targetPath).toBe('/output.md');
        expect(appendEjs.kind).toBe('script');
        expect(replaceEjsBefore.targetPath).toBe('/output.md');
        expect(replaceEjsBefore.phase).toBe('before_turn');
    });

    it('auto-merges legacy @@variables* across different WI entry.order and respects tag, @@batch_order, and @@group none/isolate', () => {
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([
            makeEntry({
                uid: 101,
                comment: 'HP与体力',
                order: 100,
                content: '@@variables_json\n根据剧情更新 hp。',
            }),
            makeEntry({
                uid: 102,
                comment: '背包与金币',
                order: 105,
                content: '@@variables_yaml\n更新 gold 与 inventory。',
            }),
            makeEntry({
                uid: 103,
                comment: '任务进度',
                order: 110,
                content: '@@variables_jsonpatch\n更新 quest。',
            }),
            // Different tag -> separate unit
            makeEntry({
                uid: 104,
                comment: '好感度结算',
                order: 120,
                content: '@@variables_json affinity\n更新好感度。',
            }),
            // Different @@batch_order -> separate unit
            makeEntry({
                uid: 105,
                comment: '二批变量',
                order: 125,
                content: '@@variables_json\n@@batch_order 2\n第二批结算。',
            }),
            // Explicit @@group none / @@group isolate -> isolated
            makeEntry({
                uid: 106,
                comment: '强制隔离A',
                order: 130,
                content: '@@variables_json\n@@group none\n强制单独运行A。',
            }),
            makeEntry({
                uid: 107,
                comment: '强制隔离B',
                order: 135,
                content: '@@variables_json\n@@group isolate\n强制单独运行B。',
            }),
        ]);

        const units = groupTriggersForExecution(compiled.triggers);
        expect(units).toHaveLength(5);

        const defaultVarsUnit = units.find((u) => u.groupName === 'variables');
        expect(defaultVarsUnit).toBeDefined();
        expect(defaultVarsUnit!.isGrouped).toBe(true);
        expect(defaultVarsUnit!.order).toBe(1);
        expect(defaultVarsUnit!.triggers.map((t) => t.label)).toEqual([
            'HP与体力',
            '背包与金币',
            '任务进度',
        ]);
        expect(new Set(defaultVarsUnit!.triggers.map((t) => t.agentProfileId)).size).toBe(1);

        const affinityUnit = units.find((u) => u.groupName === 'variables:affinity');
        expect(affinityUnit).toBeDefined();
        expect(affinityUnit!.isGrouped).toBe(false);

        const batch2Unit = units.find((u) => u.order === 2);
        expect(batch2Unit).toBeDefined();
        expect(batch2Unit!.isGrouped).toBe(false);

        const isolatedA = units.find((u) => u.label === '强制隔离A');
        const isolatedB = units.find((u) => u.label === '强制隔离B');
        expect(isolatedA?.isGrouped).toBe(false);
        expect(isolatedA?.groupName).toBeUndefined();
        expect(isolatedB?.isGrouped).toBe(false);
        expect(isolatedB?.groupName).toBeUndefined();
        expect(isolatedA?.agentProfileId).not.toBe(isolatedB?.agentProfileId);
    });

    it('keeps legacy @@replace* isolated by default, merges on explicit @@group, and supports cross-type explicit @@group', () => {
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([
            // Legacy @@replace* without @@group -> isolated
            makeEntry({
                uid: 201,
                comment: '独立日志A',
                order: 50,
                content: '@@replace\n记录事件A。',
            }),
            makeEntry({
                uid: 202,
                comment: '独立日志B',
                order: 50,
                content: '@@replace\n记录事件B。',
            }),
            // Legacy @@replace* with matching @@group -> merged with unioned write permissions
            makeEntry({
                uid: 203,
                comment: '同行角色甲',
                order: 10,
                content: '@@replace\n@@group party_cards\n更新角色甲状态。',
            }),
            makeEntry({
                uid: 204,
                comment: '同行角色乙',
                order: 20,
                content: '@@replace\n@@group party_cards\n更新角色乙状态。',
            }),
            // Cross-type explicit @@group: @@variables_json + @@replace sharing @@group sync_pack
            makeEntry({
                uid: 205,
                comment: '同步变量',
                order: 30,
                content: '@@variables_json\n@@group sync_pack\n更新 hp 与状态。',
            }),
            makeEntry({
                uid: 206,
                comment: '同步档案',
                order: 40,
                content: '@@replace\n@@group sync_pack\n同步更新档案文本。',
            }),
        ]);

        const units = groupTriggersForExecution(compiled.triggers);
        expect(units).toHaveLength(4);

        expect(units.find((u) => u.label === '独立日志A')?.isGrouped).toBe(false);
        expect(units.find((u) => u.label === '独立日志B')?.isGrouped).toBe(false);

        const partyUnit = units.find((u) => u.groupName === 'party_cards');
        expect(partyUnit).toBeDefined();
        expect(partyUnit!.isGrouped).toBe(true);
        expect(partyUnit!.triggers.map((t) => t.label)).toEqual(['同行角色甲', '同行角色乙']);
        const partyAgent = compiled.derivedAgents[partyUnit!.agentProfileId];
        expect(partyAgent).toBeDefined();
        expect(partyAgent.permissions.write).toEqual([
            '/lorebooks/霜烬纪元/同行角色甲-203.md',
            '/lorebooks/霜烬纪元/同行角色乙-204.md',
        ]);
        expect(partyAgent.promptBlocks[0].content).toContain('grouped batch of scoped trigger tasks');

        const syncUnit = units.find((u) => u.groupName === 'sync_pack');
        expect(syncUnit).toBeDefined();
        expect(syncUnit!.isGrouped).toBe(true);
        expect(syncUnit!.barrier).toBe('turn');
        expect(syncUnit!.triggers.map((t) => t.label)).toEqual(['同步变量', '同步档案']);

        const syncAgent = compiled.derivedAgents[syncUnit!.agentProfileId];
        expect(syncAgent).toBeDefined();
        expect(syncAgent.enabledTools).toEqual(
            expect.arrayContaining([
                'read_variables',
                'patch_variables',
                'read_file',
                'edit_file',
                'write_file',
            ]),
        );
        expect(syncAgent.permissions.write).toEqual([
            '/state/variables.json',
            '/lorebooks/霜烬纪元/同步档案-206.md',
        ]);
        expect(syncAgent.promptBlocks[0].content).toContain('Complete EVERY task');
    });

    it('captures @@if conditions on TriggerRule and keeps per-rule derivedAgentsByRuleId isolated for filter-then-merge', () => {
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([
            makeEntry({
                uid: 301,
                comment: 'Group Vars',
                content: '@@variables_json\n@@group sync_pack\n@@if vars.allowVars\n更新变量。',
            }),
            makeEntry({
                uid: 302,
                comment: 'Group Lore',
                content: '@@replace\n@@group sync_pack\n@@if vars.allowLore\n更新档案。',
            }),
        ]);

        expect(compiled.triggers).toHaveLength(2);
        const varsRule = compiled.triggers.find((t) => t.label === 'Group Vars')!;
        const loreRule = compiled.triggers.find((t) => t.label === 'Group Lore')!;
        expect(varsRule.ifConditions).toEqual(['vars.allowVars']);
        expect(loreRule.ifConditions).toEqual(['vars.allowLore']);

        const isolatedVarsAgent = compiled.derivedAgentsByRuleId[varsRule.id];
        const isolatedLoreAgent = compiled.derivedAgentsByRuleId[loreRule.id];
        expect(isolatedVarsAgent.permissions.write).toEqual(['/state/variables.json']);
        expect(isolatedLoreAgent.permissions.write).toEqual(['/lorebooks/霜烬纪元/Group-Lore-302.md']);
    });

    it('compiles @@trigger with target=/state/variables.json and multiline fenced @@zod_schema and preserves metadata in inferRuleFromLoreEntry', () => {
        const entry = makeEntry({
            uid: 303,
            comment: '通用状态栏结算',
            constant: false,
            keys: ['状态', '结算'],
            content: [
                '@@trigger status_data_update phase=after order=3 barrier=turn target=/state/variables.json',
                '@@zod_schema',
                '```js',
                'const StatusDataSchema = z.object({ 地点: z.string().optional() });',
                'return z.looseObject({ statusData: StatusDataSchema });',
                '```',
                '请读取并更新 statusData。',
            ].join('\n'),
        });

        const preset = createDefaultPreset({
            mainAgentId: 'main',
            agents: { main: createDefaultMainAgent() },
        });
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([entry], { preset });
        expect(compiled.triggers).toHaveLength(1);

        const rule = compiled.triggers[0];
        expect(rule.targetPath).toBe('/state/variables.json');
        expect(rule.barrier).toBe('turn');
        expect(rule.order).toBe(3);
        expect(rule.tag).toBe('status_data_update');
        expect(rule.condition).toEqual({ type: 'keyword', keys: ['状态', '结算'] });
        expect(rule.schemaSource).toEqual({
            kind: 'zod',
            raw: [
                'const StatusDataSchema = z.object({ 地点: z.string().optional() });',
                'return z.looseObject({ statusData: StatusDataSchema });',
            ].join('\n'),
        });
        expect(rule.instructionTemplate).toBe('请读取并更新 statusData。');

        const classified = new WIClassifier().classifyEntry(entry);
        const inferred = inferRuleFromLoreEntry(classified, preset);
        expect(inferred.targetPath).toBe('/state/variables.json');
        expect(inferred.schemaSource).toEqual(rule.schemaSource);
        expect(inferred.instructionTemplate).toBe('请读取并更新 statusData。');
        expect(inferred.condition).toEqual({ type: 'keyword', keys: ['状态', '结算'] });
        expect(inferred.agentProfileId).toBe('main');
        expect(inferred.enabled).toBe(true);
    });

    it('auto-inherits same-world enabled @@tool entries and parses @@trigger tools=... opt-in', () => {
        const compiler = new DecoratorCompiler();
        const compiled = compiler.compile([
            makeEntry({
                world: 'ComfyUI生图',
                uid: 1,
                comment: '生图工具',
                content: '@@tool comfyui_generate allowNetwork=true\nexport default defineTool({ name: "comfyui_generate", description: "gen", parameters: z.object({}), execute: () => "ok" });',
            }),
            makeEntry({
                world: 'ComfyUI生图',
                uid: 2,
                comment: '禁用工具',
                disable: true,
                content: '@@tool disabled_tool\nexport default defineTool({ name: "disabled_tool", description: "off", parameters: z.object({}), execute: () => "no" });',
            }),
            makeEntry({
                world: 'ComfyUI生图',
                uid: 3,
                comment: '生图调用',
                content: '@@trigger phase=after order=2 barrier=self target=/output.md\n调用生图工具。',
            }),
            makeEntry({
                world: '其他世界书',
                uid: 4,
                comment: '外部工具',
                content: '@@tool external_lookup\nexport default defineTool({ name: "external_lookup", description: "ext", parameters: z.object({}), execute: () => "ext" });',
            }),
            makeEntry({
                world: '通用状态栏',
                uid: 5,
                comment: '状态栏更新',
                content: '@@trigger phase=after order=3 barrier=turn target=/state/variables.json\n更新状态栏。',
            }),
            makeEntry({
                world: '通用状态栏',
                uid: 6,
                comment: '跨世界书显式引用',
                content: '@@trigger phase=after order=4 barrier=self tools="comfyui_generate, external_lookup"\n显式引用指定工具。',
            }),
        ]);

        const drawRule = compiled.triggers.find((t) => t.label === '生图调用')!;
        const statusRule = compiled.triggers.find((t) => t.label === '状态栏更新')!;
        const crossRule = compiled.triggers.find((t) => t.label === '跨世界书显式引用')!;

        expect(drawRule).toBeDefined();
        expect(compiled.derivedAgents[drawRule.agentProfileId].enabledTools).toContain('comfyui_generate');
        expect(compiled.derivedAgents[drawRule.agentProfileId].enabledTools).not.toContain('disabled_tool');
        expect(compiled.derivedAgents[drawRule.agentProfileId].enabledTools).not.toContain('external_lookup');
        expect(compiled.derivedAgentsByRuleId[drawRule.id].enabledTools).toContain('comfyui_generate');

        expect(statusRule).toBeDefined();
        expect(compiled.derivedAgents[statusRule.agentProfileId].enabledTools).not.toContain('comfyui_generate');
        expect(compiled.derivedAgents[statusRule.agentProfileId].enabledTools).not.toContain('external_lookup');

        expect(crossRule).toBeDefined();
        expect(crossRule.extraTools).toEqual(['comfyui_generate', 'external_lookup']);
        expect(compiled.derivedAgents[crossRule.agentProfileId].enabledTools).toEqual(
            expect.arrayContaining(['comfyui_generate', 'external_lookup']),
        );
    });
});
