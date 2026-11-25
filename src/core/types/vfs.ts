import type { MessageTarget } from './messages';

export type VariableScope = 'message' | 'chat' | 'global';

export type DataNamespace =
    | 'files'
    | 'variables'
    | 'worldinfo'
    | 'message'
    | 'character-files'
    | 'persona-files'
    | 'side-files'
    | 'ejs-injections';

export interface CompactionReport {
    dryRun: boolean;
    compactedMessages: number;
    removedLayers: number;
    flattenedEntries: number;
    estimatedBytesBefore: number;
    estimatedBytesAfter: number;
    freedBytes: number;
    previousWatermark: number;
    newWatermark: number;
    prunedScratchFiles?: number;
    prunedCheckpoints?: number;
    trajectoryBytesBefore?: number;
    trajectoryBytesAfter?: number;
}

export type VfsEntryKind = 'file' | 'directory';

export interface VfsEntryStat {
    path: string;
    name: string;
    kind: VfsEntryKind;
    size: number;
    writable: boolean;
    mount: string;
    source?: string;
    overridden?: boolean;
}

export interface VfsSearchHit {
    path: string;
    score: number;
    title?: string;
    snippet?: string;
    line?: number;
    totalLines?: number;
    context?: string[];
    matchedIn?: 'content' | 'meta';
    matchedTerms?: string[];
}

export interface LoreReadContext {
    world: string;
    uid: number;
    path: string;
    target?: MessageTarget;
    rawContent: string;
    overriddenContent?: string;
}

export type LoreReadHook = (context: LoreReadContext) => Promise<string> | string;
