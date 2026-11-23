import type { ApprovalStatus, DiffLine, PendingApproval } from '../types';
import type { ToolPolicyResult } from './policy';

const MAX_EXACT_DIFF_CELLS = 250_000;

export interface ComputeDiffOptions {
    /**
     * When set to a non-negative integer, collapses unchanged context lines beyond
     * `contextLines` from the nearest `add`/`del` change. Defaults to returning all lines.
     */
    contextLines?: number;
}

function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n?/g, '\n');
}

function splitLines(text: string): string[] {
    if (text === '') {
        return [];
    }
    return normalizeLineEndings(text).split('\n');
}

function trimContextLines(lines: DiffLine[], contextLines: number): DiffLine[] {
    const keep = new Uint8Array(lines.length);
    let hasChanges = false;

    for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].type !== 'ctx') {
            hasChanges = true;
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            for (let j = start; j <= end; j += 1) {
                keep[j] = 1;
            }
        }
    }

    if (!hasChanges) {
        return lines.slice(0, Math.min(lines.length, contextLines));
    }

    const out: DiffLine[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (keep[i] === 1) {
            out.push(lines[i]);
        }
    }
    return out;
}

/**
 * Compute a clean, deterministic line-level diff (`ctx` / `del` / `add`) between
 * `beforeText` and `afterText` using common prefix/suffix trimming plus LCS backtracking.
 */
export function computeDiffLines(
    beforeText: string,
    afterText: string,
    options?: ComputeDiffOptions,
): DiffLine[] {
    const before = splitLines(beforeText ?? '');
    const after = splitLines(afterText ?? '');

    if (before.length === 0 && after.length === 0) {
        return [];
    }

    let prefixLen = 0;
    while (
        prefixLen < before.length &&
        prefixLen < after.length &&
        before[prefixLen] === after[prefixLen]
    ) {
        prefixLen += 1;
    }

    let suffixLen = 0;
    while (
        suffixLen < before.length - prefixLen &&
        suffixLen < after.length - prefixLen &&
        before[before.length - 1 - suffixLen] === after[after.length - 1 - suffixLen]
    ) {
        suffixLen += 1;
    }

    const result: DiffLine[] = [];
    for (let i = 0; i < prefixLen; i += 1) {
        result.push({ type: 'ctx', text: before[i] });
    }

    const midBefore = before.slice(prefixLen, before.length - suffixLen);
    const midAfter = after.slice(prefixLen, after.length - suffixLen);

    if (midBefore.length === 0) {
        for (const line of midAfter) {
            result.push({ type: 'add', text: line });
        }
    } else if (midAfter.length === 0) {
        for (const line of midBefore) {
            result.push({ type: 'del', text: line });
        }
    } else if (midBefore.length * midAfter.length > MAX_EXACT_DIFF_CELLS) {
        // Fallback for very large diffs to guarantee bounded CPU/memory.
        for (const line of midBefore) {
            result.push({ type: 'del', text: line });
        }
        for (const line of midAfter) {
            result.push({ type: 'add', text: line });
        }
    } else {
        const m = midBefore.length;
        const n = midAfter.length;
        const cols = n + 1;
        const dp = new Uint32Array((m + 1) * cols);

        for (let i = m - 1; i >= 0; i -= 1) {
            for (let j = n - 1; j >= 0; j -= 1) {
                if (midBefore[i] === midAfter[j]) {
                    dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
                } else {
                    const down = dp[(i + 1) * cols + j];
                    const right = dp[i * cols + (j + 1)];
                    dp[i * cols + j] = down >= right ? down : right;
                }
            }
        }

        let i = 0;
        let j = 0;
        while (i < m && j < n) {
            if (midBefore[i] === midAfter[j]) {
                result.push({ type: 'ctx', text: midBefore[i] });
                i += 1;
                j += 1;
            } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
                // Emit deletions before insertions within a changed hunk.
                result.push({ type: 'del', text: midBefore[i] });
                i += 1;
            } else {
                result.push({ type: 'add', text: midAfter[j] });
                j += 1;
            }
        }
        while (i < m) {
            result.push({ type: 'del', text: midBefore[i] });
            i += 1;
        }
        while (j < n) {
            result.push({ type: 'add', text: midAfter[j] });
            j += 1;
        }
    }

    for (let k = before.length - suffixLen; k < before.length; k += 1) {
        result.push({ type: 'ctx', text: before[k] });
    }

    if (
        options?.contextLines !== undefined &&
        Number.isFinite(options.contextLines) &&
        options.contextLines >= 0
    ) {
        return trimContextLines(result, Math.floor(options.contextLines));
    }

    return result;
}

export type ApprovalPolicyCheckInput = Pick<
    ToolPolicyResult,
    'allowed' | 'requiresApproval' | 'mandatoryConfirm'
> & {
    baseRequiresApproval?: boolean;
};

/**
 * Strong confirmation gate check (§3.3):
 * - Disallowed tools never enter approval flow (they are rejected by policy).
 * - `mandatoryConfirm: true` ALWAYS returns `true` and can NEVER be skipped by `autoApproveAuthor`.
 * - Non-mandatory approvals are skipped only when `autoApproveAuthor === true`.
 */
export function shouldRequireApproval(
    policyResult: ApprovalPolicyCheckInput,
    autoApproveAuthor: boolean,
): boolean {
    if (!policyResult.allowed) {
        return false;
    }
    if (policyResult.mandatoryConfirm) {
        return true;
    }
    const baseRequires = policyResult.baseRequiresApproval ?? policyResult.requiresApproval;
    if (!baseRequires) {
        return false;
    }
    return !autoApproveAuthor;
}

export interface CreatePendingApprovalInput {
    id?: string;
    sessionId: string;
    messageId: string;
    toolCallId: string;
    toolName: string;
    riskLevel?: 'medium' | 'high';
    mandatoryConfirm: boolean;
    title: string;
    summary: string;
    targetLabel: string;
    rawContent: string;
    diffLines?: DiffLine[];
    beforeText?: string;
    afterText?: string;
    args: Record<string, unknown>;
    createdAt?: number;
}

export interface RetryApprovalInput {
    rejectionFeedback?: string;
    toolCallId?: string;
    title?: string;
    summary?: string;
    targetLabel?: string;
    rawContent?: string;
    diffLines?: DiffLine[];
    beforeText?: string;
    afterText?: string;
    args?: Record<string, unknown>;
}

export interface ApprovalListFilter {
    sessionId?: string;
    messageId?: string;
    status?: ApprovalStatus;
}

export interface ApprovalGateOptions {
    now?: () => number;
    idGenerator?: () => string;
}

function cloneRecord<T>(value: T): T {
    if (value === null || value === undefined || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => cloneRecord(item)) as unknown as T;
    }
    const obj = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        copy[key] = cloneRecord(obj[key]);
    }
    return copy as T;
}

function cloneApproval(approval: PendingApproval): PendingApproval {
    return {
        ...approval,
        diffLines: approval.diffLines.map((line) => ({ ...line })),
        args: cloneRecord(approval.args),
    };
}

/**
 * Manages the inline bubble `PendingApproval` state machine (§3.3):
 * `pending` -> `approved` / `rejected`; `retry` increments `revision` and stores
 * `rejectionFeedback`; `markReverted` binds `undoId` and sets `reverted = true`.
 */
export class ApprovalGate {
    private readonly approvals = new Map<string, PendingApproval>();
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private seq = 0;

    constructor(options: ApprovalGateOptions = {}) {
        this.now = options.now ?? (() => Date.now());
        this.idGenerator =
            options.idGenerator ??
            (() => {
                this.seq += 1;
                return `appr_${this.now()}_${this.seq}`;
            });
    }

    public create(input: CreatePendingApprovalInput): PendingApproval {
        const id = input.id?.trim() || this.idGenerator();
        if (this.approvals.has(id)) {
            throw new Error(`Approval with id "${id}" already exists.`);
        }

        const diffLines = input.diffLines
            ? input.diffLines.map((line) => ({ ...line }))
            : input.beforeText !== undefined || input.afterText !== undefined
                ? computeDiffLines(input.beforeText ?? '', input.afterText ?? input.rawContent)
                : computeDiffLines('', input.rawContent);

        const riskLevel: 'medium' | 'high' = input.mandatoryConfirm
            ? 'high'
            : input.riskLevel ?? 'medium';

        const approval: PendingApproval = {
            id,
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            riskLevel,
            mandatoryConfirm: input.mandatoryConfirm,
            revision: 1,
            title: input.title,
            summary: input.summary,
            targetLabel: input.targetLabel,
            status: 'pending',
            rawContent: input.rawContent,
            diffLines,
            args: cloneRecord(input.args),
            createdAt: input.createdAt ?? this.now(),
        };

        this.approvals.set(id, approval);
        return cloneApproval(approval);
    }

    public get(id: string): PendingApproval | undefined {
        const found = this.approvals.get(id);
        return found ? cloneApproval(found) : undefined;
    }

    public list(filter?: ApprovalListFilter): PendingApproval[] {
        const out: PendingApproval[] = [];
        for (const approval of this.approvals.values()) {
            if (filter?.sessionId !== undefined && approval.sessionId !== filter.sessionId) {
                continue;
            }
            if (filter?.messageId !== undefined && approval.messageId !== filter.messageId) {
                continue;
            }
            if (filter?.status !== undefined && approval.status !== filter.status) {
                continue;
            }
            out.push(cloneApproval(approval));
        }
        return out;
    }

    public listPending(sessionId?: string): PendingApproval[] {
        return this.list({ sessionId, status: 'pending' });
    }

    /**
     * Transition a `pending` approval to `approved`, optionally attaching `undoId`.
     * Throws on invalid transitions (already approved or rejected without retry).
     */
    public approve(id: string, opts?: { undoId?: string }): PendingApproval {
        const approval = this.requireApproval(id);
        if (approval.status !== 'pending') {
            throw new Error(
                `Cannot approve "${id}" from status "${approval.status}"; expected "pending".`,
            );
        }

        approval.status = 'approved';
        if (opts?.undoId !== undefined) {
            approval.undoId = opts.undoId;
        }
        approval.reverted = false;
        return cloneApproval(approval);
    }

    /**
     * Transition a `pending` approval to `rejected`, storing optional user feedback.
     */
    public reject(id: string, feedback?: string): PendingApproval {
        const approval = this.requireApproval(id);
        if (approval.status !== 'pending') {
            throw new Error(
                `Cannot reject "${id}" from status "${approval.status}"; expected "pending".`,
            );
        }

        approval.status = 'rejected';
        if (feedback !== undefined) {
            approval.rejectionFeedback = feedback;
        }
        return cloneApproval(approval);
    }

    /**
     * Retry a `pending` or `rejected` approval: increments `revision`, records
     * `rejectionFeedback`, resets `status` to `'pending'`, and applies any updated proposal fields.
     */
    public retry(id: string, update?: RetryApprovalInput): PendingApproval {
        const approval = this.requireApproval(id);
        if (approval.status === 'approved') {
            throw new Error(
                `Cannot retry already approved item "${id}"; use UndoStore to revert instead.`,
            );
        }

        approval.revision += 1;
        approval.status = 'pending';

        if (update?.rejectionFeedback !== undefined) {
            approval.rejectionFeedback = update.rejectionFeedback;
        }
        if (update?.toolCallId !== undefined) {
            approval.toolCallId = update.toolCallId;
        }
        if (update?.title !== undefined) {
            approval.title = update.title;
        }
        if (update?.summary !== undefined) {
            approval.summary = update.summary;
        }
        if (update?.targetLabel !== undefined) {
            approval.targetLabel = update.targetLabel;
        }
        if (update?.rawContent !== undefined) {
            approval.rawContent = update.rawContent;
        }
        if (update?.args !== undefined) {
            approval.args = cloneRecord(update.args);
        }

        if (update?.diffLines !== undefined) {
            approval.diffLines = update.diffLines.map((line) => ({ ...line }));
        } else if (update?.beforeText !== undefined || update?.afterText !== undefined) {
            approval.diffLines = computeDiffLines(
                update.beforeText ?? '',
                update.afterText ?? approval.rawContent,
            );
        }

        delete approval.undoId;
        delete approval.reverted;

        return cloneApproval(approval);
    }

    /**
     * Attach the pre-write `undoId` generated when an approved write executes.
     */
    public attachUndo(id: string, undoId: string): PendingApproval {
        const approval = this.requireApproval(id);
        if (approval.status !== 'approved') {
            throw new Error(`Cannot attach undoId to approval "${id}" with status "${approval.status}".`);
        }
        approval.undoId = undoId;
        return cloneApproval(approval);
    }

    /**
     * Mark an `approved` item as reverted (idempotent once reverted) and record `undoId`.
     */
    public markReverted(id: string, undoId?: string): PendingApproval {
        const approval = this.requireApproval(id);
        if (approval.status !== 'approved') {
            throw new Error(
                `Cannot mark approval "${id}" as reverted from status "${approval.status}".`,
            );
        }
        if (undoId !== undefined) {
            approval.undoId = undoId;
        }
        approval.reverted = true;
        return cloneApproval(approval);
    }

    public remove(id: string): boolean {
        return this.approvals.delete(id);
    }

    public clear(sessionId?: string): void {
        if (sessionId === undefined) {
            this.approvals.clear();
            return;
        }
        for (const [id, approval] of this.approvals.entries()) {
            if (approval.sessionId === sessionId) {
                this.approvals.delete(id);
            }
        }
    }

    public exportSnapshot(): PendingApproval[] {
        return this.list();
    }

    public hydrate(records: readonly PendingApproval[]): void {
        this.approvals.clear();
        for (const record of records) {
            this.approvals.set(record.id, cloneApproval(record));
        }
    }

    private requireApproval(id: string): PendingApproval {
        const found = this.approvals.get(id);
        if (!found) {
            throw new Error(`Approval not found: "${id}".`);
        }
        return found;
    }
}
