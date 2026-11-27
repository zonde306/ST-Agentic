import type {
    CanonicalMessage,
    CanonicalToolCall,
    InterruptedReason,
    MediaAttachment,
    MessageTarget,
    PipelinePhase,
    ScopedPermissions,
    TokenUsage,
    ToolStepLog,
    TriggerEventType,
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

export interface ToolEventPayload {
    type: TriggerEventType | string;
    timestamp: number;
    target?: MessageTarget;
    phase?: PipelinePhase;
    runId?: string;
    agentId?: string;
    triggerId?: string;
    round?: number;
    attempt?: number;
    maxAttempts?: number;
    error?: string;
    errorCode?: string;
    statusCode?: number;
    reason?: InterruptedReason | string;
    output?: string;
    messageId?: number;
    swipeId?: number;
    data?: Record<string, unknown>;
}

export interface ToolAgentRunOptions {
    /** Agent profile ID from the active preset (defaults to the preset's main agent or caller agent). */
    agentId?: string;
    /** User prompt or task instruction for the agent run. */
    prompt?: string;
    /** Optional system prompt override or additional system instruction. */
    systemPrompt?: string;
    /** Optional pipeline phase override. */
    phase?: PipelinePhase;
    /** Optional causal target override (defaults to current ctx.target). */
    target?: MessageTarget;
    /** Optional API connection ID override. */
    connectionId?: string;
    /** Optional allowlist of enabled tool names. */
    enabledTools?: string[];
    /** Optional extra tool names appended to the profile's tools. */
    extraTools?: string[];
    /** Optional VFS read/write permission override. */
    permissions?: ScopedPermissions;
    /** Optional maximum tool rounds override (`0` = unlimited). */
    maxToolRounds?: number;
    /** Optional variable overrides for macro/EJS rendering. */
    vars?: Record<string, unknown>;
    /** Optional macro overrides. */
    macroOverrides?: Record<string, string>;
    /** Whether writes go into staged branch storage. */
    staged?: boolean;
    /** Whether to stream model output. */
    stream?: boolean;
    /** Optional AbortSignal linked with parent sandbox cancellation. */
    signal?: AbortSignal;
}

export interface ToolAgentRunTriggerOptions {
    /** Optional causal target override (defaults to current ctx.target). */
    target?: MessageTarget;
    /** Optional event payload forwarded to the triggered rule. */
    event?: ToolEventPayload;
    /** Optional AbortSignal linked with parent sandbox cancellation. */
    signal?: AbortSignal;
}

export interface ToolAgentRunResult {
    runId?: string;
    agentId: string;
    content: string;
    reasoningContent?: string;
    ok: boolean;
    skipped?: boolean;
    error?: string;
    rounds?: number;
    usage?: TokenUsage;
    toolSteps?: ToolStepLog[];
}

export interface ToolAgentApi {
    run(opts: ToolAgentRunOptions): Promise<ToolAgentRunResult>;
    runTrigger(ruleId: string, opts?: ToolAgentRunTriggerOptions): Promise<ToolAgentRunResult>;
}

export interface ToolEphemeralMessagesApi {
    list(): CanonicalMessage[];
    set(nextMessages: CanonicalMessage[]): void;
    rollbackToolRounds(count?: number): number;
    dropHistoryTurns(count?: number, opts?: { from?: 'newest' | 'oldest' }): number;
    replaceContent(
        selector: number | ((msg: CanonicalMessage, idx: number) => boolean),
        replacer: string | ((content: string, msg: CanonicalMessage, idx: number) => string),
    ): number;
    appendHint(content: string, role?: 'user' | 'system'): void;
    toMessages(): CanonicalMessage[];
}

export type ToolErrorRecoveryAction = 'none' | 'retry' | 'abort' | 'fallback';

export interface ToolErrorRecoveryRetryOptions {
    delayMs?: number;
    rollbackToolRounds?: number;
    dropHistoryTurns?: number;
    connectionId?: string;
    temperature?: number;
    maxTokens?: number;
    mode?: 'round' | 'turn';
}

export interface ToolErrorRecoveryControl {
    retry(reason?: string, opts?: ToolErrorRecoveryRetryOptions): void;
    abort(reason?: string): void;
    fallback?(content: string, reason?: string): void;
    readonly action: ToolErrorRecoveryAction;
    readonly reason?: string;
    readonly delayMs?: number;
    readonly rollbackToolRounds?: number;
    readonly dropHistoryTurns?: number;
    readonly connectionId?: string;
    readonly temperature?: number;
    readonly maxTokens?: number;
    readonly mode?: 'round' | 'turn';
    readonly retryOptions?: ToolErrorRecoveryRetryOptions;
    readonly fallbackContent?: string;
}

export interface ToolPostprocessOutput {
    text: string;
    content?: string;
    reasoningContent?: string;
    toolCalls?: CanonicalToolCall[];
    readonly originalText: string;
    readonly stage?: 'output_mutation' | 'turn_finish';
    readonly operation?: string;
    readonly filePath?: string;
    readonly round?: number;
    readonly fixAttempt?: number;
    readonly maxFixAttempts?: number;
}

export type ToolPostprocessAction = 'accept' | 'fix' | 'retry' | 'abort';

export interface ToolPostprocessControl {
    retry(reason?: string): void;
    requestFix(message: string, options?: { rejectWrite?: boolean }): void;
    accept?(): void;
    abort?(reason?: string): void;
    readonly action: ToolPostprocessAction;
    readonly retryReason?: string;
    readonly fixMessage?: string;
    readonly rejectWrite: boolean;
    readonly abortReason?: string;
}

export interface ToolExecutionContext {
    fs: ToolFsApi;
    vars: ToolVarsApi;
    message: ToolMessageApi;
    st: ToolStApi;
    readonly sideGen?: ToolSideGenApi;
    readonly agent?: ToolAgentApi;
    readonly messages?: ToolEphemeralMessagesApi;
    readonly event?: ToolEventPayload;
    readonly control?: ToolErrorRecoveryControl | ToolPostprocessControl;
    body?: Record<string, unknown>;
    output?: ToolPostprocessOutput;
    readonly target: MessageTarget;
    signal: AbortSignal;
    permissions: ScopedPermissions;
    readonly canEditFiles?: boolean;
    readonly agentId?: string;
    readonly phase?: string;
    readSet?: Map<string, string>;
    spillStore?: ToolSpillStoreApi;
}
