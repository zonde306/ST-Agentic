import type {
    MessageTarget,
    ScopedPermissions,
    VfsEntryStat,
} from '@/core/types';
import { isPathAllowed } from '@/core/utils';
import {
    VirtualFileSystem,
    canDescendIntoDir,
    isInstructionDocPath,
    isInstructionIndexPath,
    isSharedWorkspacePath,
} from '@/core/vfs';

export interface WorkspaceNoticeBuildOptions {
    vfs: VirtualFileSystem;
    permissions: ScopedPermissions;
    readSet?: ReadonlyMap<string, string>;
    target?: MessageTarget;
    staged?: boolean;
    hashText: (text: string) => Promise<string>;
    maxSharedItems?: number;
}

export interface WorkspaceNoticeResult {
    noticeXml: string;
    unreadIndexPaths: string[];
    updatedIndexPaths: string[];
    staleDocPaths: string[];
    sharedUpdatePaths: string[];
}

function compareCodeUnits(a: string, b: string): number {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}

function formatCompactBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    if (bytes < 1024) {
        return `${Math.round(bytes)} B`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function extractOneLineSummary(content: string): string {
    const normalized = content.replace(/\r\n/g, '\n');
    let body = normalized;
    if (normalized.startsWith('---\n')) {
        const endIdx = normalized.indexOf('\n---\n', 4);
        if (endIdx > 0) {
            const frontmatter = normalized.slice(4, endIdx);
            const descMatch = /^description:\s*(.+)$/im.exec(frontmatter);
            if (descMatch && descMatch[1]) {
                const desc = descMatch[1].trim().replace(/^["']|["']$/g, '').trim();
                if (desc) {
                    return desc.length > 80 ? `${desc.slice(0, 79)}…` : desc;
                }
            }
            body = normalized.slice(endIdx + 5);
        }
    }

    for (const rawLine of body.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) {
            continue;
        }
        const cleaned = trimmed.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
        if (cleaned) {
            return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
        }
    }
    return '(空文档)';
}

async function collectReadableFilesUnderDir(
    vfs: VirtualFileSystem,
    permissions: ScopedPermissions,
    rootDir: string,
    opts: { target?: MessageTarget; staged?: boolean },
): Promise<VfsEntryStat[]> {
    if (!canDescendIntoDir(permissions.read, rootDir)) {
        return [];
    }

    const collected: VfsEntryStat[] = [];
    const queue: string[] = [rootDir];
    const visitedDirs = new Set<string>();

    while (queue.length > 0) {
        const currentDir = queue.shift()!;
        if (visitedDirs.has(currentDir)) {
            continue;
        }
        visitedDirs.add(currentDir);

        let entries: VfsEntryStat[];
        try {
            entries = await vfs.listDir(currentDir, opts);
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.kind === 'directory') {
                if (canDescendIntoDir(permissions.read, entry.path)) {
                    queue.push(entry.path);
                }
            } else if (entry.kind === 'file' && isPathAllowed(permissions.read, entry.path)) {
                collected.push(entry);
            }
        }
    }

    return collected.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/**
 * Build Layer 2 progressive-disclosure workspace notices filtered strictly by `permissions.read`:
 * 1. Tier 1 (`AGENTS.md` indexes): notify when unread or changed since last `Read-Set` hash.
 * 2. Tier 2 (`docs/**`, `/preset/*`, `/global/*`): notify ONLY for previously read docs whose hash changed.
 * 3. Tier 3 (`/workspace/shared/**`): concise 1-line summaries for unread or updated cross-agent collaboration files.
 */
export async function buildWorkspaceNotices(
    options: WorkspaceNoticeBuildOptions,
): Promise<WorkspaceNoticeResult> {
    const readOpts = {
        target: options.target,
        staged: options.staged,
    };
    const readSet = options.readSet;
    const maxSharedItems = Math.max(1, options.maxSharedItems ?? 24);

    // Enumerate only instruction & workspace directories (avoiding /lorebooks and /history).
    const [globalFiles, presetFiles, workspaceFiles, rootEntries] = await Promise.all([
        collectReadableFilesUnderDir(options.vfs, options.permissions, '/global', readOpts),
        collectReadableFilesUnderDir(options.vfs, options.permissions, '/preset', readOpts),
        collectReadableFilesUnderDir(options.vfs, options.permissions, '/workspace', readOpts),
        canDescendIntoDir(options.permissions.read, '/')
            ? options.vfs.listDir('/', readOpts).catch(() => [] as VfsEntryStat[])
            : Promise.resolve([] as VfsEntryStat[]),
    ]);

    const fileMap = new Map<string, VfsEntryStat>();
    for (const stat of [...globalFiles, ...presetFiles, ...workspaceFiles]) {
        fileMap.set(stat.path, stat);
    }
    for (const entry of rootEntries) {
        if (
            entry.kind === 'file'
            && isInstructionIndexPath(entry.path)
            && isPathAllowed(options.permissions.read, entry.path)
        ) {
            fileMap.set(entry.path, entry);
        }
    }

    const sortedFiles = Array.from(fileMap.values()).sort((a, b) =>
        compareCodeUnits(a.path, b.path),
    );

    const unreadIndexPaths: string[] = [];
    const updatedIndexPaths: string[] = [];
    const indexNoticeLines: string[] = [];

    const staleDocPaths: string[] = [];
    const staleDocLines: string[] = [];

    const sharedUpdatePaths: string[] = [];
    const sharedUpdateLines: string[] = [];

    for (const stat of sortedFiles) {
        if (isInstructionIndexPath(stat.path)) {
            let content: string;
            try {
                content = await options.vfs.readFile(stat.path, readOpts);
            } catch {
                continue;
            }
            const digest = await options.hashText(content);
            const prev = readSet?.get(stat.path);
            if (prev === undefined) {
                unreadIndexPaths.push(stat.path);
                indexNoticeLines.push(`- ${stat.path} (未读 · ${formatCompactBytes(stat.size)})`);
            } else if (prev !== digest) {
                updatedIndexPaths.push(stat.path);
                indexNoticeLines.push(`- ${stat.path} (已更新 · ${formatCompactBytes(stat.size)})`);
            }
            continue;
        }

        if (isInstructionDocPath(stat.path)) {
            // Tier 2: Never force-read unread docs; only alert if already in Read-Set and modified.
            const prev = readSet?.get(stat.path);
            if (prev === undefined) {
                continue;
            }
            let content: string;
            try {
                content = await options.vfs.readFile(stat.path, readOpts);
            } catch {
                continue;
            }
            const digest = await options.hashText(content);
            if (prev !== digest) {
                staleDocPaths.push(stat.path);
                staleDocLines.push(`- ${stat.path} (已更新 · ${formatCompactBytes(stat.size)})`);
            }
            continue;
        }

        if (isSharedWorkspacePath(stat.path)) {
            if (sharedUpdateLines.length >= maxSharedItems) {
                continue;
            }
            let content: string;
            try {
                content = await options.vfs.readFile(stat.path, readOpts);
            } catch {
                continue;
            }
            const digest = await options.hashText(content);
            const prev = readSet?.get(stat.path);
            if (prev === undefined || prev !== digest) {
                sharedUpdatePaths.push(stat.path);
                const statusTag = prev === undefined ? '新增' : '已更新';
                const summary = extractOneLineSummary(content);
                const sourceLabel = stat.source || 'workspace';
                sharedUpdateLines.push(
                    `- ${stat.path} [${statusTag}] | ${summary} | 来源: ${sourceLabel} | ${formatCompactBytes(stat.size)}`,
                );
            }
        }
    }

    const sections: string[] = [];

    if (indexNoticeLines.length > 0) {
        sections.push([
            '<workspace-instructions-notice>',
            '以下工作规范索引文件尚未阅读或刚刚更新，行动前请先调用 read_file 查阅：',
            ...indexNoticeLines,
            '说明：若索引中引用了相对路径（如 docs/<topic>.md），请以该 AGENTS.md 所在目录为基准解析完整路径，并仅在当前回合相关时按需 read_file 对应子文档。',
            '</workspace-instructions-notice>',
        ].join('\n'));
    }

    if (staleDocLines.length > 0) {
        sections.push([
            '<workspace-doc-updates>',
            '以下你之前读取过的参考文档已更新；若本轮任务仍涉及相关主题，请重新调用 read_file 查阅最新版本：',
            ...staleDocLines,
            '</workspace-doc-updates>',
        ].join('\n'));
    }

    if (sharedUpdateLines.length > 0) {
        sections.push([
            '<workspace-shared-updates>',
            '以下跨 Agent 协作工作区文件为新增或已更新（按需调用 read_file 查阅）：',
            ...sharedUpdateLines,
            '</workspace-shared-updates>',
        ].join('\n'));
    }

    return {
        noticeXml: sections.join('\n\n'),
        unreadIndexPaths,
        updatedIndexPaths,
        staleDocPaths,
        sharedUpdatePaths,
    };
}
