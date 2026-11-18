import type { RawLoreEntry } from './messages';

export type WICategory =
    | 'system_rule'
    | 'core_manifest'
    | 'on_demand_archive'
    | 'dynamic_or_trigger';

export interface ParsedDecorator {
    name: string;
    rawArgs: string;
    args: string[];
    params: Record<string, string>;
}

export interface ClassifiedLoreEntry {
    entry: RawLoreEntry;
    category: WICategory;
    vfsPath: string;
    slug: string;
    decorators: ParsedDecorator[];
    cleanContent: string;
    charCount: number;
    overridden?: boolean;
    reason?: string;
}

export interface RadarCandidate {
    path: string;
    world: string;
    uid: number;
    title: string;
    status: 'unread' | 'updated';
    matchedKeywords: string[];
    charCount: number;
    contentHash: string;
    order: number;
    specificity: number;
}

export interface RadarScanResult {
    candidates: RadarCandidate[];
    totalMatched: number;
    overflowCount: number;
    hintXml: string;
}
