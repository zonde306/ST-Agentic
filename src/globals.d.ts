/// <reference path="../../../../../global.d.ts" />
/// <reference types="jquery" />
/// <reference types="lodash" />
/// <reference types="toastr" />

import type {
    AssistantRetractResult,
    AssistantSendOptions,
    AssistantSessionPatch,
    CreateAssistantSessionOptions,
    UndoRevertResult,
} from '@/core/assistant';
import type { ToolSideGenApi } from '@/core/bridge';
import type { AgenticDocsPublicApi, ExternalDocRegistration } from '@/core/docs';
import type { TraceLogger } from '@/core/logger';
import type { ChatDataStore } from '@/core/store';
import type { PipelineOrchestrator, RunTurnInput, RunTurnResult } from '@/core/triggers';
import type {
    AssistantMessage,
    AssistantSession,
    ConsoleTabId,
    DeepLinkState,
    MessageTarget,
    PendingApproval,
    Settings,
    UndoRecord,
} from '@/core/types';
import type { VirtualFileSystem } from '@/core/vfs';
import type { EjsTemplateGlobal } from '@/host/ejs-adapter';
import type { STGenerateInterceptor } from '@/host/interceptor';
import type { STHostBridge } from '@/host/st-bridge';
import type { IframeJsSandbox } from '@/sandbox';
import type { AppStore } from '@/ui/store';

/** Public off-mainline Assistant control & read handle exposed on `globalThis.Agentic.assistant`. */
export interface AgenticAssistantPublicApi {
    open(sessionId?: string): void;
    listSessions(): AssistantSession[];
    getSession(sessionId: string): AssistantSession | null;
    createSession(opts?: CreateAssistantSessionOptions): Promise<AssistantSession>;
    updateSession(sessionId: string, patch: AssistantSessionPatch): Promise<AssistantSession | null>;
    deleteSession(sessionId: string): Promise<boolean>;
    send(sessionId: string, prompt: string, opts?: AssistantSendOptions): Promise<AssistantMessage>;
    editMessage(sessionId: string, messageId: string, newContent: string): Promise<AssistantSession | null>;
    editAndResendMessage(
        sessionId: string,
        messageId: string,
        newContent: string,
        opts?: AssistantSendOptions,
    ): Promise<AssistantMessage>;
    retractMessage(sessionId: string, messageId: string): Promise<AssistantRetractResult | null>;
    regenerateLastMessage(sessionId: string, opts?: AssistantSendOptions): Promise<AssistantMessage>;
    continueLastMessage(sessionId: string, opts?: AssistantSendOptions): Promise<AssistantMessage>;
    decideApproval(
        approvalId: string,
        decision: 'approve' | 'reject',
        feedback?: string,
    ): Promise<PendingApproval | null>;
    retryApproval(approvalId: string, feedback?: string): Promise<PendingApproval | null>;
    undo(undoId: string): Promise<UndoRevertResult>;
    listPendingApprovals(sessionId?: string): PendingApproval[];
    listUndoHistory(sessionId?: string): UndoRecord[];
    abort(sessionId?: string): void;
}

/** Public runtime scripting API exposed on `globalThis.Agentic`. */
export interface AgenticPublicApi {
    readonly version: string;
    getSettings(): Settings;
    openConsole(tab?: ConsoleTabId, deepLink?: DeepLinkState): void;
    closeConsole(): void;
    runTurn(input: RunTurnInput): Promise<RunTurnResult>;
    rerunAfterTurn(target?: MessageTarget, options?: { triggerIds?: string[] }): Promise<void>;
    readonly sideGen: ToolSideGenApi;
    readonly assistant: AgenticAssistantPublicApi;
    readonly docs: AgenticDocsPublicApi;
    readonly vfs: VirtualFileSystem;
    readonly store: ChatDataStore;
    readonly traces: TraceLogger;
    readonly orchestrator: PipelineOrchestrator;
    readonly sandbox: IframeJsSandbox;
    readonly uiStore: AppStore;
    readonly bridge: STHostBridge;
}

declare global {
    // eslint-disable-next-line no-var
    var Agentic: AgenticPublicApi | undefined;
    // eslint-disable-next-line no-var
    var Agentic_interceptor: STGenerateInterceptor | undefined;
    // eslint-disable-next-line no-var
    var EjsTemplate: EjsTemplateGlobal | undefined;
    // eslint-disable-next-line no-var
    var __AGENTIC_PENDING_DOCS__: ExternalDocRegistration[] | undefined;
}

export {};
