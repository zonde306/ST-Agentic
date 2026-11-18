/// <reference path="../../../../../global.d.ts" />
/// <reference types="jquery" />
/// <reference types="lodash" />
/// <reference types="toastr" />

import type { TraceLogger } from '@/core/logger';
import type { ChatDataStore } from '@/core/store';
import type { PipelineOrchestrator, RunTurnInput, RunTurnResult } from '@/core/triggers';
import type { ConsoleTabId, DeepLinkState, MessageTarget, Settings } from '@/core/types';
import type { VirtualFileSystem } from '@/core/vfs';
import type { EjsTemplateGlobal } from '@/host/ejs-adapter';
import type { STGenerateInterceptor } from '@/host/interceptor';
import type { STHostBridge } from '@/host/st-bridge';
import type { IframeJsSandbox } from '@/sandbox';
import type { AppStore } from '@/ui/store';

/** Public runtime scripting API exposed on `globalThis.Agentic`. */
export interface AgenticPublicApi {
    readonly version: string;
    getSettings(): Settings;
    openConsole(tab?: ConsoleTabId, deepLink?: DeepLinkState): void;
    closeConsole(): void;
    runTurn(input: RunTurnInput): Promise<RunTurnResult>;
    rerunAfterTurn(target?: MessageTarget): Promise<void>;
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
}

export {};
