import type {
    MediaAttachment,
    MessageTarget,
    ScopedPermissions,
    VariableScope,
    VfsEntryStat,
    VfsSearchHit,
} from '../types';
import type { HostIdentity } from './host-bridge';
import type { ToolSideGenApi } from './host-admin-bridge';

export interface ToolEditRange {
    startLine: number;
    endLine: number;
}

export interface ToolEditOperation {
    search: string;
    replace: string;
    startLine?: number;
    endLine?: number;
    replaceAll?: boolean;
}

export interface ToolEditOptions {
    startLine?: number;
    endLine?: number;
    replaceAll?: boolean;
    edits?: readonly ToolEditOperation[];
}

export interface ToolEditResult {
    ok: boolean;
    path: string;
    message: string;
    code?: string;
    matchLines?: number[];
    changedRanges?: ToolEditRange[];
    replacements?: number;
    totalLines?: number;
    bytes?: number;
}

export interface ToolSpillEntryMeta {
    path: string;
    toolName: string;
    content: string;
    byteLength: number;
    lineCount: number;
}

export interface ToolSpillStoreApi {
    get(path: string): ToolSpillEntryMeta | null;
    listPaths(scopeId?: string): string[];
    readSlice(path: string, startLine?: number, endLine?: number): string | null;
    grep(
        path: string,
        query: string,
        opts?: {
            caseSensitive?: boolean;
            regex?: boolean;
            limit?: number;
            contextLines?: number;
            maxMatchesPerFile?: number;
        },
    ): VfsSearchHit[];
}

export interface ToolFsApi {
    read(
        path: string,
        opts?: {
            startLine?: number;
            endLine?: number;
            editable?: boolean;
            writable?: boolean;
            transformSessionId?: string;
            transformAgentId?: string;
            transformPhase?: string;
            transformSessionBag?: Record<string, unknown>;
        },
    ): Promise<string>;
    write(path: string, content: string): Promise<void>;
    append?(path: string, content: string): Promise<void>;
    edit(
        path: string,
        oldText: string,
        newText: string,
        opts?: ToolEditOptions,
    ): Promise<ToolEditResult>;
    list(dirPath?: string): Promise<VfsEntryStat[]>;
    search(query: string, opts?: { pathPrefix?: string; limit?: number }): Promise<VfsSearchHit[]>;
    grep?(
        query: string,
        opts?: {
            pathPrefix?: string;
            caseSensitive?: boolean;
            regex?: boolean;
            limit?: number;
            contextLines?: number;
            maxMatchesPerFile?: number;
        },
    ): Promise<VfsSearchHit[]>;
    glob(pattern: string): Promise<string[]>;
}

export interface ToolVarsOptions {
    scope?: VariableScope;
}

export interface ToolVarsApi {
    get(path?: string, opts?: ToolVarsOptions): Promise<unknown>;
    set(path: string, value: unknown, opts?: ToolVarsOptions): Promise<void>;
    patch(
        ops: Record<string, unknown> | Array<Record<string, unknown>>,
        opts?: ToolVarsOptions,
    ): Promise<Record<string, unknown>>;
}

export interface ToolMessageApi {
    attachMedia(media: MediaAttachment): Promise<void>;
    appendView(text: string): Promise<void>;
    replaceView(text: string): Promise<void>;
}

export interface ToolStApi {
    slash(cmd: string): Promise<string>;
    emit(event: string, data?: unknown): void;
    getActiveInfo(): HostIdentity;
}

export interface ToolExecutionContext {
    fs: ToolFsApi;
    vars: ToolVarsApi;
    message: ToolMessageApi;
    st: ToolStApi;
    readonly sideGen?: ToolSideGenApi;
    readonly target: MessageTarget;
    signal: AbortSignal;
    permissions: ScopedPermissions;
    readonly canEditFiles?: boolean;
    readonly agentId?: string;
    readonly phase?: string;
    readSet?: Map<string, string>;
    spillStore?: ToolSpillStoreApi;
}
