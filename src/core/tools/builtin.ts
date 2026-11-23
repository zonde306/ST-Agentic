import type { HostBridge, ToolExecutionContext, ToolSideGenApi, ToolStApi } from '@/core/bridge';
import { ChatDataStore } from '@/core/store';
import type { MessageTarget, ScopedPermissions } from '@/core/types';
import { VirtualFileSystem } from '@/core/vfs';
import { createFsTools } from './fs-tools';
import { createHistoryTools } from './history-tools';
import { ChatMessageViewAdapter, createMessageTools } from './message-tools';
import { ToolRegistry, type ToolDefinition } from './registry';
import { throwIfAborted } from './script-sandbox';
import {
    createVariableTools,
    type DynamicVariableSchema,
    type VariableToolOptions,
    VfsVarsAdapter,
} from './vars-tools';

export const BUILTIN_TOOL_NAMES = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'write_file',
    'append_file',
    'edit_file',
    'read_variables',
    'patch_variables',
    'search_history',
    'read_history',
    'append_reply_view',
    'replace_reply_view',
    'attach_media',
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

/** Instantiate all 15 built-in ST-Agentic tool definitions. */
export function createBuiltinTools(options: VariableToolOptions = {}): ToolDefinition[] {
    return [
        ...createFsTools(),
        ...createVariableTools(options),
        ...createHistoryTools(),
        ...createMessageTools(),
    ];
}

/** Create a `ToolRegistry` pre-populated with all 15 built-in tools. */
export function createBuiltinToolRegistry(options: VariableToolOptions = {}): ToolRegistry {
    return new ToolRegistry(createBuiltinTools(options));
}

export interface CreateToolContextOptions {
    bridge: HostBridge;
    vfs?: VirtualFileSystem;
    store?: ChatDataStore;
    sideGen?: ToolSideGenApi;
    target: MessageTarget;
    signal?: AbortSignal;
    permissions?: ScopedPermissions;
    readSet?: Map<string, string>;
    staged?: boolean;
    source?: string;
    getVariableSchema?: () => DynamicVariableSchema | undefined;
}

/**
 * Construct a causally bound `ToolExecutionContext` wiring `ScopedToolGuard`,
 * `VfsVarsAdapter`, `ChatMessageViewAdapter`, and `HostBridge` services.
 */
export function createToolExecutionContext(
    options: CreateToolContextOptions,
): ToolExecutionContext {
    const store = options.store ?? options.vfs?.store ?? new ChatDataStore(options.bridge);
    const vfs = options.vfs ?? new VirtualFileSystem({ bridge: options.bridge, store });
    const signal = options.signal ?? new AbortController().signal;
    const target: MessageTarget = Object.freeze({
        messageId: options.target.messageId,
        swipeId: options.target.swipeId,
    });
    const permissions: ScopedPermissions = {
        read: [...(options.permissions?.read ?? ['/**'])],
        write: [...(options.permissions?.write ?? [])],
    };

    const fs = vfs.createScopedGuard(permissions, {
        target,
        staged: options.staged,
        source: options.source,
    });

    const vars = new VfsVarsAdapter(vfs, {
        target,
        staged: options.staged,
        source: options.source,
        signal,
        getSchema: options.getVariableSchema,
    });

    const message = new ChatMessageViewAdapter(options.bridge, store, target, signal, {
        staged: options.staged,
        vfs,
    });

    const st: ToolStApi = {
        async slash(cmd: string): Promise<string> {
            throwIfAborted(signal);
            if (!options.bridge.executeSlashCommand) {
                throw new Error('HostBridge.executeSlashCommand is not available in this environment.');
            }
            return await options.bridge.executeSlashCommand(cmd, signal);
        },
        emit(event: string, data?: unknown): void {
            options.bridge.emitHostEvent?.(event, data);
        },
        getActiveInfo() {
            return options.bridge.getActiveIdentity();
        },
    };

    return {
        fs,
        vars,
        message,
        st,
        ...(options.sideGen ? { sideGen: options.sideGen } : {}),
        target,
        signal,
        permissions,
        ...(options.readSet ? { readSet: options.readSet } : {}),
    };
}
