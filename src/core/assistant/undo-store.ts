import type { MessageTarget, UndoKind, UndoRecord } from '../types';

export const UNDO_KINDS: readonly UndoKind[] = [
    'chat_message',
    'variables',
    'vfs_file',
    'character',
    'worldinfo',
    'regex',
    'st_setting',
] as const;

export function isValidUndoKind(value: unknown): value is UndoKind {
    return typeof value === 'string' && (UNDO_KINDS as readonly string[]).includes(value);
}

export interface PushUndoRecordInput {
    id?: string;
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
    timestamp?: number;
    reverted?: boolean;
}

export interface UndoListFilter {
    sessionId?: string;
    kind?: UndoKind;
    includeReverted?: boolean;
}

export type UndoExecutor = (record: UndoRecord) => Promise<void> | void;

export type UndoRevertStatus = 'reverted' | 'already_reverted' | 'not_found' | 'failed';

export interface UndoRevertResult {
    ok: boolean;
    status: UndoRevertStatus;
    undoId: string;
    record?: UndoRecord;
    error?: string;
}

export interface UndoPersistenceAdapter {
    load(storageKey: string): Promise<UndoRecord[]> | UndoRecord[];
    save(storageKey: string, records: UndoRecord[]): Promise<void> | void;
}

export interface UndoStoreOptions {
    persistence?: UndoPersistenceAdapter;
    storageKey?: string;
    maxRecords?: number;
    now?: () => number;
    idGenerator?: () => string;
}

const DEFAULT_STORAGE_KEY = 'default';
const DEFAULT_MAX_RECORDS = 200;

function deepClone<T>(value: T): T {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (value instanceof Date) {
        return new Date(value.getTime()) as unknown as T;
    }
    if (Array.isArray(value)) {
        return value.map((item) => deepClone(item)) as unknown as T;
    }
    const record = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
        copy[key] = deepClone(record[key]);
    }
    return copy as T;
}

function cloneUndoRecord(record: UndoRecord): UndoRecord {
    return {
        ...record,
        snapshot: deepClone(record.snapshot),
        ...(record.target ? { target: { ...record.target } } : {}),
    };
}

/**
 * Simple in-memory persistence adapter keyed by `storageKey` (sessionId / chat key).
 */
export class MemoryUndoPersistence implements UndoPersistenceAdapter {
    private readonly buckets = new Map<string, UndoRecord[]>();

    public load(storageKey: string): UndoRecord[] {
        const stored = this.buckets.get(storageKey);
        return stored ? stored.map(cloneUndoRecord) : [];
    }

    public save(storageKey: string, records: UndoRecord[]): void {
        this.buckets.set(storageKey, records.map(cloneUndoRecord));
    }

    public delete(storageKey: string): void {
        this.buckets.delete(storageKey);
    }
}

/**
 * Persistence adapter backed by SillyTavern's `chat_metadata` object via HostBridge callbacks.
 */
export function createChatMetadataUndoAdapter(
    getMetadata: () => Record<string, unknown>,
    saveChat: () => void,
    metadataKey: string = 'agentic_undo_records',
): UndoPersistenceAdapter {
    return {
        load(storageKey: string): UndoRecord[] {
            const meta = getMetadata();
            const rawContainer = meta[metadataKey];
            if (!rawContainer || typeof rawContainer !== 'object' || Array.isArray(rawContainer)) {
                return [];
            }
            const bucket = (rawContainer as Record<string, unknown>)[storageKey];
            if (!Array.isArray(bucket)) {
                return [];
            }
            return (bucket as UndoRecord[])
                .filter((item) => item && typeof item === 'object' && isValidUndoKind(item.kind))
                .map(cloneUndoRecord);
        },
        save(storageKey: string, records: UndoRecord[]): void {
            const meta = getMetadata();
            let container = meta[metadataKey];
            if (!container || typeof container !== 'object' || Array.isArray(container)) {
                container = {};
                meta[metadataKey] = container;
            }
            (container as Record<string, unknown>)[storageKey] = records.map(cloneUndoRecord);
            saveChat();
        },
    };
}

/**
 * Persistence adapter backed by `HostBridge.loadExtensionData` / `saveExtensionData`.
 */
export function createExtensionDataUndoAdapter(
    loadExtensionData: <T>(key: string, fallback: T) => Promise<T>,
    saveExtensionData: <T>(key: string, value: T) => Promise<void>,
    keyPrefix: string = 'agentic_undo:',
): UndoPersistenceAdapter {
    return {
        async load(storageKey: string): Promise<UndoRecord[]> {
            const raw = await loadExtensionData<UndoRecord[]>(`${keyPrefix}${storageKey}`, []);
            if (!Array.isArray(raw)) {
                return [];
            }
            return raw
                .filter((item) => item && typeof item === 'object' && isValidUndoKind(item.kind))
                .map(cloneUndoRecord);
        },
        async save(storageKey: string, records: UndoRecord[]): Promise<void> {
            await saveExtensionData(`${keyPrefix}${storageKey}`, records.map(cloneUndoRecord));
        },
    };
}

/**
 * Helper to compose a single `UndoExecutor` by registering per-`UndoKind` rollback handlers.
 */
export function createUndoKindDispatcher(
    handlers: Partial<Record<UndoKind, UndoExecutor>>,
): UndoExecutor {
    return async (record: UndoRecord): Promise<void> => {
        const handler = handlers[record.kind];
        if (!handler) {
            throw new Error(`No undo executor registered for kind "${record.kind}".`);
        }
        await handler(record);
    };
}

/**
 * Pre-write snapshot stack & idempotent rollback engine covering all 7 `UndoKind`s
 * (`chat_message`, `variables`, `vfs_file`, `character`, `worldinfo`, `regex`, `st_setting`).
 */
export class UndoStore {
    private records: UndoRecord[] = [];
    private readonly persistence?: UndoPersistenceAdapter;
    private readonly storageKey: string;
    private readonly maxRecords: number;
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private readonly inFlightReverts = new Map<string, Promise<UndoRevertResult>>();
    private persistChain: Promise<void> = Promise.resolve();
    private seq = 0;

    constructor(options: UndoStoreOptions = {}) {
        this.persistence = options.persistence;
        this.storageKey = options.storageKey?.trim() || DEFAULT_STORAGE_KEY;
        this.maxRecords =
            options.maxRecords !== undefined && options.maxRecords > 0
                ? Math.floor(options.maxRecords)
                : DEFAULT_MAX_RECORDS;
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `undo_${this.now()}_${this.seq}`;
            });
    }

    /**
     * Hydrate the in-memory stack from the configured persistence adapter.
     */
    public async load(): Promise<UndoRecord[]> {
        if (!this.persistence) {
            return this.list();
        }
        const loaded = await this.persistence.load(this.storageKey);
        this.records = Array.isArray(loaded)
            ? loaded
                .filter((item) => item && typeof item === 'object' && isValidUndoKind(item.kind))
                .map(cloneUndoRecord)
            : [];
        this.enforceCapacity();
        return this.list();
    }

    /**
     * Wait for any queued persistence writes to finish.
     */
    public async flush(): Promise<void> {
        await this.persistChain;
    }

    /**
     * Push a new pre-write snapshot onto the undo stack. Deep-clones `snapshot` to keep
     * the pre-write state immutable against subsequent mutations.
     */
    public push(input: PushUndoRecordInput): UndoRecord {
        if (!isValidUndoKind(input.kind)) {
            throw new Error(`Invalid UndoKind: "${String(input.kind)}".`);
        }

        const id = input.id?.trim() || this.idGenerator();
        if (this.records.some((r) => r.id === id)) {
            throw new Error(`UndoRecord with id "${id}" already exists.`);
        }

        const record: UndoRecord = {
            id,
            sessionId: input.sessionId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            kind: input.kind,
            label: input.label,
            scope: input.scope,
            beforeSummary: input.beforeSummary,
            afterSummary: input.afterSummary,
            snapshot: deepClone(input.snapshot),
            ...(input.target ? { target: { ...input.target } } : {}),
            timestamp: input.timestamp ?? this.now(),
            reverted: Boolean(input.reverted),
        };

        this.records.push(record);
        this.enforceCapacity();
        this.schedulePersist();

        return cloneUndoRecord(record);
    }

    /**
     * List undo records in newest-first stack order. Accepts either a `sessionId` string
     * or a structured `UndoListFilter`.
     */
    public list(sessionIdOrFilter?: string | UndoListFilter): UndoRecord[] {
        const filter: UndoListFilter =
            typeof sessionIdOrFilter === 'string'
                ? { sessionId: sessionIdOrFilter }
                : sessionIdOrFilter ?? {};

        const includeReverted = filter.includeReverted ?? true;
        const out: UndoRecord[] = [];

        for (let i = this.records.length - 1; i >= 0; i -= 1) {
            const rec = this.records[i];
            if (filter.sessionId !== undefined && rec.sessionId !== filter.sessionId) {
                continue;
            }
            if (filter.kind !== undefined && rec.kind !== filter.kind) {
                continue;
            }
            if (!includeReverted && rec.reverted) {
                continue;
            }
            out.push(cloneUndoRecord(rec));
        }

        return out;
    }

    /**
     * Retrieve a single cloned `UndoRecord` by `undoId`, or `undefined` if not found.
     */
    public get(undoId: string): UndoRecord | undefined {
        const found = this.records.find((r) => r.id === undoId);
        return found ? cloneUndoRecord(found) : undefined;
    }

    /**
     * Count active (unreverted) undo records, optionally filtered by `sessionId`.
     */
    public countPending(sessionId?: string): number {
        let count = 0;
        for (const rec of this.records) {
            if (rec.reverted) {
                continue;
            }
            if (sessionId !== undefined && rec.sessionId !== sessionId) {
                continue;
            }
            count += 1;
        }
        return count;
    }

    /**
     * Idempotently revert `undoId` via `executor`:
     * - Missing record -> `{ ok: false, status: 'not_found' }`, executor not called.
     * - Already reverted -> `{ ok: true, status: 'already_reverted' }`, executor not called.
     * - Concurrent duplicate call for same `undoId` -> deduplicated without double-applying.
     * - Executor failure -> `{ ok: false, status: 'failed' }`, record remains unreverted for retry.
     */
    public async revert(undoId: string, executor: UndoExecutor): Promise<UndoRevertResult> {
        const inFlight = this.inFlightReverts.get(undoId);
        if (inFlight) {
            const firstResult = await inFlight;
            if (firstResult.ok && firstResult.status === 'reverted') {
                return {
                    ok: true,
                    status: 'already_reverted',
                    undoId,
                    record: firstResult.record ? cloneUndoRecord(firstResult.record) : undefined,
                };
            }
            return firstResult;
        }

        const record = this.records.find((r) => r.id === undoId);
        if (!record) {
            return {
                ok: false,
                status: 'not_found',
                undoId,
                error: `Undo record not found: "${undoId}".`,
            };
        }

        if (record.reverted) {
            return {
                ok: true,
                status: 'already_reverted',
                undoId,
                record: cloneUndoRecord(record),
            };
        }

        const task = (async (): Promise<UndoRevertResult> => {
            try {
                await executor(cloneUndoRecord(record));
                record.reverted = true;
                this.schedulePersist();
                await this.flush();
                return {
                    ok: true,
                    status: 'reverted',
                    undoId,
                    record: cloneUndoRecord(record),
                };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return {
                    ok: false,
                    status: 'failed',
                    undoId,
                    record: cloneUndoRecord(record),
                    error: message,
                };
            } finally {
                this.inFlightReverts.delete(undoId);
            }
        })();

        this.inFlightReverts.set(undoId, task);
        return task;
    }

    public clear(sessionId?: string): void {
        if (sessionId === undefined) {
            this.records = [];
        } else {
            this.records = this.records.filter((r) => r.sessionId !== sessionId);
        }
        this.schedulePersist();
    }

    private enforceCapacity(): void {
        while (this.records.length > this.maxRecords) {
            // Prefer evicting the oldest already-reverted record first.
            const revertedIdx = this.records.findIndex((r) => r.reverted);
            if (revertedIdx >= 0) {
                this.records.splice(revertedIdx, 1);
            } else {
                this.records.shift();
            }
        }
    }

    private schedulePersist(): void {
        if (!this.persistence) {
            return;
        }
        const snapshot = this.records.map(cloneUndoRecord);
        const adapter = this.persistence;
        const key = this.storageKey;
        this.persistChain = this.persistChain
            .catch(() => {
                // Keep persistence chain alive after any prior transient failure.
            })
            .then(async () => {
                await adapter.save(key, snapshot);
            });
    }
}
