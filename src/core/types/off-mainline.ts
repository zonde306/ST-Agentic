import type { MessageTarget, RawLoreEntry } from './messages';

// ============================================================================
// Assistant Subsystem Domain Contracts (§3 & §5.1)
// ============================================================================

export type AssistantMode = 'chat' | 'adjust' | 'author' | 'full';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface DiffLine {
    type: 'ctx' | 'del' | 'add';
    text: string;
}

export interface PendingApproval {
    id: string;
    sessionId: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
    riskLevel: 'medium' | 'high';
    mandatoryConfirm: boolean;
    revision: number;
    title: string;
    summary: string;
    targetLabel: string;
    status: ApprovalStatus;
    rawContent: string;
    diffLines: DiffLine[];
    args: Record<string, unknown>;
    undoId?: string;
    rejectionFeedback?: string;
    reverted?: boolean;
    createdAt: number;
}

export type UndoKind =
    | 'chat_message'
    | 'variables'
    | 'vfs_file'
    | 'character'
    | 'worldinfo'
    | 'regex'
    | 'st_setting';

export interface UndoRecord {
    id: string;
    sessionId: string;
    toolCallId: string;
    toolName: string;
    kind: UndoKind;
    label: string;
    scope: string;
    beforeSummary: string;
    afterSummary: string;
    snapshot: Record<string, unknown>;
    target?: MessageTarget;
    timestamp: number;
    reverted: boolean;
}

export interface AssistantToolCallRecord {
    id: string;
    name: string;
    scopeLabel: string;
    status: 'ok' | 'error';
    durationMs: number;
    argsSummary: string;
    resultSummary: string;
    hasSecretRedaction?: boolean;
    undoId?: string;
}

export interface AssistantMessageUsage {
    inputTokens: number;
    cachedTokens: number;
    outputTokens: number;
    cacheRate: string;
}

export type AssistantAttachmentKind = 'image' | 'audio' | 'video' | 'file';

export interface AssistantAttachment {
    id: string;
    kind: AssistantAttachmentKind;
    name: string;
    mimeType: string;
    size: number;
    dataUrl: string;
    textContent?: string;
}

export interface AssistantMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    attachments?: AssistantAttachment[];
    think?: string;
    toolCalls?: AssistantToolCallRecord[];
    approvalIds?: string[];
    fileRefs?: string[];
    usage?: AssistantMessageUsage;
    interrupted?: boolean;
    timestamp: number;
}

export interface AssistantSession {
    id: string;
    title: string;
    mode: AssistantMode;
    stAdminEnabled: boolean;
    autoApproveAuthor: boolean;
    connectionId: string; // 'inherit' | connection.id
    updatedAt: number;
    messages: AssistantMessage[];
}

export type ChatEditSyncTrajectory = 'none' | 'rewrite' | 'fork';

// ============================================================================
// SideGen & `/side/*` Clue Domain Contracts (§2, §4 & §5.1)
// ============================================================================

export type SideClueDelivery = 'none' | 'vfs_only' | 'radar_hint' | 'next_turn_brief';

export type SideClueStatus = 'dormant' | 'surfaced' | 'resolved';

export interface SideClueMeta {
    id: string;
    title: string;
    delivery: SideClueDelivery;
    status: SideClueStatus;
    keywords: string[];
    secondaryKeys?: string[];
    scanDepth?: number;
    order?: number;
    summary: string;
    sourceSessionId?: string;
    anchor: string;
    createdAt: number;
    updatedAt: number;
    consumedByTurn?: number;
}

export interface SideClueDoc {
    path: string;
    meta: SideClueMeta;
    body: string;
    contentHash: string;
}

export interface SideClueWriteInput {
    path: string;
    body: string;
    id?: string;
    title?: string;
    delivery?: SideClueDelivery;
    status?: SideClueStatus;
    keywords?: string[];
    secondaryKeys?: string[];
    scanDepth?: number;
    order?: number;
    summary?: string;
    sourceSessionId?: string;
    anchor?: string;
    target?: MessageTarget;
}

export interface SideClueRadarCandidate {
    path: string;
    id: string;
    title: string;
    summary: string;
    status: 'unread' | 'updated';
    matchedKeywords: string[];
    contentHash: string;
    order: number;
    specificity: number;
}

export interface SideClueRadarScanResult {
    candidates: SideClueRadarCandidate[];
    totalMatched: number;
    overflowCount: number;
    hintXml: string;
}

export type SideSessionScope = 'branch' | 'chat';

export interface SideSessionAutoBridge {
    path: string;
    delivery: SideClueDelivery;
    keywords: string[];
    title: string;
    mode: 'append' | 'replace';
    summaryPrefix?: string;
}

export interface SideSessionConfig {
    id: string;
    title: string;
    scope: SideSessionScope;
    systemPrompt: string;
    connectionId: string;
    watermark: { high: number; low: number };
    autoBridge?: SideSessionAutoBridge;
    anchor: MessageTarget;
    turns: number;
    estimatedTokens: number;
    lastCacheHitRate?: string;
    createdAt: number;
    updatedAt: number;
}

export interface CreateSideSessionOptions {
    id?: string;
    title: string;
    scope?: SideSessionScope;
    systemPrompt: string;
    connectionId?: string;
    watermark?: { high: number; low: number };
    autoBridge?: SideSessionAutoBridge;
}

export type SideSessionInfo = SideSessionConfig;

export interface SideSessionFilter {
    scope?: SideSessionScope;
    branchKey?: string;
}

export interface SideSessionTranscriptEntry {
    role: 'system' | 'user' | 'assistant';
    content: string;
    timestamp?: number;
}

export interface SideGenOnceBridgeOptions {
    path: string;
    delivery: SideClueDelivery;
    title?: string;
    keywords?: string[];
    summary?: string;
}

export interface SideGenOnceOptions {
    prompt: string;
    systemPrompt?: string;
    connectionId?: string;
    mainChatDepth?: number;
    includeVars?: boolean;
    bridge?: SideGenOnceBridgeOptions;
    signal?: AbortSignal;
}

export interface SideGenSendOptions {
    connectionId?: string;
    mainChatDepth?: number;
    includeVars?: boolean;
    signal?: AbortSignal;
}

export interface SideGenResult {
    text: string;
    sessionId?: string;
    bridgedPath?: string;
    usage?: { inputTokens: number; cachedTokens: number; outputTokens: number };
    durationMs: number;
}

export interface ExportWorldInfoOptions {
    bookName?: string;
    comment?: string;
    keys?: string[];
    secondaryKeys?: string[];
    constant?: boolean;
    selective?: boolean;
    position?: number;
    depth?: number;
    order?: number;
    role?: number;
    disable?: boolean;
    markResolved?: boolean;
    target?: MessageTarget;
}

export interface ExportWorldInfoResult {
    bookName: string;
    uid: number;
    comment: string;
    cluePath: string;
}

export interface OffMainlineSettings {
    defaultAssistantConnectionId?: string;
    defaultDelivery?: SideClueDelivery;
}

// ============================================================================
// Authoring & ST Admin Supporting Contracts (§3.2 & §5.2)
// ============================================================================

export interface AuthorUndoMeta {
    sessionId?: string;
    toolCallId?: string;
    reason?: string;
}

export interface HostCharacterSummary {
    chid: number;
    name: string;
    avatar: string;
    description?: string;
    tags?: string[];
    primaryWorld?: string;
}

export interface HostCharacterFull extends HostCharacterSummary {
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    character_version?: string;
    creator?: string;
    extensions?: Record<string, unknown>;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface HostCharacterPatch {
    name?: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    data?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface HostCharacterCreatePayload {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface WorldInfoBookSnapshot {
    name: string;
    entries: RawLoreEntry[];
}

export interface WorldInfoEntryUpsert {
    uid?: number;
    comment?: string;
    content: string;
    keys: string[];
    keysecondary?: string[];
    constant?: boolean;
    selective?: boolean;
    selectiveLogic?: number;
    disable?: boolean;
    position?: number;
    depth?: number;
    order?: number;
    role?: number;
    caseSensitive?: boolean | null;
    matchWholeWords?: boolean | number | null;
    probability?: number;
    useProbability?: boolean;
    group?: string;
    groupOverride?: boolean;
    groupWeight?: number;
    scanDepth?: number | null;
    extensions?: Record<string, unknown>;
}

export interface UpsertWorldInfoEntryOptions {
    /**
     * Author/admin permanent World Info writes preserve raw `@@` decorators and
     * `<% ... %>` EJS code verbatim (bypassing VFS `escapeAt`). Defaults to `true`.
     */
    rawDirect?: boolean;
    undoMeta?: AuthorUndoMeta;
}

export interface HostRegexScript {
    id: string;
    scriptName: string;
    findRegex: string;
    replaceString: string;
    trimStrings?: string[];
    placement?: number[];
    disabled?: boolean;
    markdownOnly?: boolean;
    promptOnly?: boolean;
    runOnEdit?: boolean;
    substituteRegex?: number;
    minDepth?: number | null;
    maxDepth?: number | null;
    [key: string]: unknown;
}

export interface EmbedAgenticOptions {
    includePreset?: boolean;
    presetId?: string;
    includeFiles?: boolean;
    filePaths?: string[];
    files?: Record<string, string>;
}

export interface EmbedAgenticResult {
    ok: boolean;
    embeddedPresets: number;
    embeddedFiles: number;
    message: string;
}

export interface HostPersonaEntry {
    key: string;
    name: string;
    title?: string;
    description: string;
    active?: boolean;
}

export interface HostPresetInfo {
    name: string;
    apiType: string;
    active?: boolean;
    data?: Record<string, unknown>;
}

export type HostSettingsScope = 'power_user' | 'extension_settings' | 'all' | (string & {});

export interface HostImportUrlResult {
    ok: boolean;
    url: string;
    importedType?: 'character' | 'worldinfo' | 'preset' | 'unknown';
    name?: string;
    detail?: string;
}
