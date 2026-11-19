import type {
    MediaAttachment,
    MessageTarget,
    ScopedPermissions,
    VfsEntryStat,
    VfsSearchHit,
} from '../types';
import type { HostIdentity } from './host-bridge';

export interface ToolEditResult {
    ok: boolean;
    path: string;
    message: string;
}

export interface ToolFsApi {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<void>;
    append?(path: string, content: string): Promise<void>;
    edit(path: string, oldText: string, newText: string): Promise<ToolEditResult>;
    list(dirPath?: string): Promise<VfsEntryStat[]>;
    search(query: string, opts?: { pathPrefix?: string; limit?: number }): Promise<VfsSearchHit[]>;
    glob(pattern: string): Promise<string[]>;
}

export interface ToolVarsApi {
    get(path?: string): Promise<unknown>;
    set(path: string, value: unknown): Promise<void>;
    patch(ops: Record<string, unknown> | Array<Record<string, unknown>>): Promise<Record<string, unknown>>;
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
    readonly target: MessageTarget;
    signal: AbortSignal;
    permissions: ScopedPermissions;
    readSet?: Map<string, string>;
}
