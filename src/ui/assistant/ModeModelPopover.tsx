import type { ApiConnection, AssistantMode, AssistantSession } from '@/core/types';
import { Button, ShadowModal } from '@/ui/components';
import {
    ASSISTANT_MODE_META,
    ASSISTANT_MODE_ORDER,
    getEffectiveModePills,
} from './assistant-helpers';

export type ComposerPopoverKind = 'mode' | 'model' | null;

export type AssistantSessionConfig = Pick<
    AssistantSession,
    'mode' | 'stAdminEnabled' | 'autoApproveAuthor' | 'autoApproveChatDelete' | 'connectionId'
>;

export interface ModeModelPopoverProps {
    kind: ComposerPopoverKind;
    session: AssistantSessionConfig;
    connections: Record<string, ApiConnection>;
    currentConnectionId: string;
    onSelectMode: (mode: AssistantMode) => void;
    onToggleAutoApproveAuthor: (checked: boolean) => void;
    onToggleAutoApproveChatDelete?: (checked: boolean) => void;
    onRequestToggleStAdmin: () => void;
    onSelectConnection: (connectionId: string) => void;
    onClose: () => void;
}

/**
 * Floating Mode / Model selector popover anchored above the bottom composer.
 */
export function ModeModelPopover({
    kind,
    session,
    connections,
    currentConnectionId,
    onSelectMode,
    onToggleAutoApproveAuthor,
    onToggleAutoApproveChatDelete,
    onRequestToggleStAdmin,
    onSelectConnection,
    onClose,
}: ModeModelPopoverProps) {
    if (kind === null) {
        return null;
    }

    if (kind === 'mode') {
        const scopePills = getEffectiveModePills(session);
        const showAutoApproveChatDelete = session.mode === 'adjust';
        const showAutoApprove = session.mode === 'author' || session.mode === 'full';
        const showStAdmin = session.mode === 'full';

        return (
            <div
                class="ag-ast-popover ag-thin-scroll"
                role="dialog"
                aria-label="助手权限模式"
                data-assistant-popover="mode"
            >
                <div class="ag-ast-popover-header">
                    <span>助手权限模式</span>
                    <button
                        type="button"
                        aria-label="关闭权限模式选择"
                        class="ag-btn ag-btn-ghost ag-btn-sm"
                        style={{ padding: 0, width: '40px', height: '40px' }}
                        onClick={onClose}
                    >
                        ✕
                    </button>
                </div>

                <div class="ag-ast-popover-list">
                    {ASSISTANT_MODE_ORDER.map((mode) => {
                        const meta = ASSISTANT_MODE_META[mode];
                        const isActive = session.mode === mode;
                        return (
                            <button
                                key={mode}
                                type="button"
                                data-assistant-mode-option={mode}
                                aria-pressed={isActive}
                                class={
                                    isActive
                                        ? 'ag-ast-popover-option ag-ast-popover-option-active'
                                        : 'ag-ast-popover-option'
                                }
                                onClick={() => onSelectMode(mode)}
                            >
                                <div class="ag-min-w-0" style={{ flex: '1 1 auto' }}>
                                    <div
                                        style={{
                                            fontWeight: 600,
                                            fontSize: '12px',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '6px',
                                            color: isActive
                                                ? 'var(--primary)'
                                                : 'var(--foreground)',
                                        }}
                                    >
                                        <span>{meta.icon}</span>
                                        <span>{meta.fullLabel}</span>
                                    </div>
                                    <div class="ag-ast-popover-option-desc">{meta.desc}</div>
                                </div>
                                {isActive ? (
                                    <span
                                        style={{
                                            color: 'var(--primary)',
                                            fontWeight: 700,
                                            flexShrink: 0,
                                        }}
                                    >
                                        ✓
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>

                {showAutoApproveChatDelete ? (
                    <label
                        class="ag-ast-popover-checkbox-row"
                        data-assistant-auto-approve-chat-delete-row="true"
                    >
                        <div class="ag-min-w-0">
                            <div style={{ fontWeight: 600, fontSize: '12px' }}>
                                本会话自动批准删除消息
                            </div>
                            <div style={{ fontSize: '10px', color: 'var(--muted-foreground)' }}>
                                未勾选时删除消息需气泡确认；均保留快照可撤销
                            </div>
                        </div>
                        <input
                            type="checkbox"
                            data-assistant-auto-approve-chat-delete-checkbox="true"
                            checked={Boolean(session.autoApproveChatDelete)}
                            onChange={(e) => onToggleAutoApproveChatDelete?.(e.currentTarget.checked)}
                            style={{
                                width: '18px',
                                height: '18px',
                                flexShrink: 0,
                                accentColor: 'var(--primary)',
                                cursor: 'pointer',
                            }}
                        />
                    </label>
                ) : null}

                {showAutoApprove ? (
                    <label
                        class="ag-ast-popover-checkbox-row"
                        data-assistant-auto-approve-row="true"
                    >
                        <div class="ag-min-w-0">
                            <div style={{ fontWeight: 600, fontSize: '12px' }}>
                                本会话自动批准写卡
                            </div>
                            <div style={{ fontSize: '10px', color: 'var(--muted-foreground)' }}>
                                常规写卡/删消息直接执行；永久删除与高危仍强制确认
                            </div>
                        </div>
                        <input
                            type="checkbox"
                            data-assistant-auto-approve-checkbox="true"
                            checked={session.autoApproveAuthor}
                            onChange={(e) => onToggleAutoApproveAuthor(e.currentTarget.checked)}
                            style={{
                                width: '18px',
                                height: '18px',
                                flexShrink: 0,
                                accentColor: 'var(--primary)',
                                cursor: 'pointer',
                            }}
                        />
                    </label>
                ) : null}

                {showStAdmin ? (
                    <button
                        type="button"
                        data-assistant-st-admin-toggle="true"
                        aria-pressed={session.stAdminEnabled}
                        class={
                            session.stAdminEnabled
                                ? 'ag-ast-popover-option ag-pill-error'
                                : 'ag-ast-popover-option'
                        }
                        style={{ alignItems: 'center' }}
                        onClick={onRequestToggleStAdmin}
                    >
                        <div class="ag-min-w-0" style={{ flex: '1 1 auto' }}>
                            <div style={{ fontWeight: 600, fontSize: '12px' }}>
                                🛡️ ST 全权管家
                            </div>
                            <div
                                style={{
                                    fontSize: '10px',
                                    opacity: 0.85,
                                    marginTop: '2px',
                                }}
                            >
                                全库卡片/世界书/设置/预设/斜杠/导入
                            </div>
                        </div>
                        <span
                            class={
                                session.stAdminEnabled
                                    ? 'ag-pill ag-pill-error'
                                    : 'ag-pill ag-pill-muted'
                            }
                            style={{ borderRadius: '9999px', flexShrink: 0 }}
                        >
                            {session.stAdminEnabled ? '已启用' : '关闭'}
                        </span>
                    </button>
                ) : null}

                <div class="ag-ast-popover-pills">
                    {scopePills.map((pill) => (
                        <span key={pill.text} class={`ag-pill ${pill.cls}`}>
                            {pill.text}
                        </span>
                    ))}
                </div>
            </div>
        );
    }

    // kind === 'model'
    const primaryConn = connections[currentConnectionId];
    const connectionEntries = Object.values(connections);
    const modelItems: { id: string; label: string }[] = [
        {
            id: 'inherit',
            label: primaryConn ? `跟随主连接 (${primaryConn.name})` : '跟随主连接',
        },
        ...connectionEntries.map((conn) => ({
            id: conn.id,
            label: conn.model ? `${conn.name} (${conn.model})` : conn.name,
        })),
    ];

    return (
        <div
            class="ag-ast-popover ag-thin-scroll"
            role="dialog"
            aria-label="助手独立模型连接"
            data-assistant-popover="model"
        >
            <div class="ag-ast-popover-header">
                <span>助手独立模型连接</span>
                <button
                    type="button"
                    aria-label="关闭模型连接选择"
                    class="ag-btn ag-btn-ghost ag-btn-sm"
                    style={{ padding: 0, width: '40px', height: '40px' }}
                    onClick={onClose}
                >
                    ✕
                </button>
            </div>

            <div class="ag-ast-popover-list">
                {modelItems.map((item) => {
                    const isActive = (session.connectionId || 'inherit') === item.id;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            data-assistant-model-option={item.id}
                            aria-pressed={isActive}
                            class={
                                isActive
                                    ? 'ag-ast-popover-option ag-ast-popover-option-active'
                                    : 'ag-ast-popover-option'
                            }
                            style={{ alignItems: 'center' }}
                            onClick={() => onSelectConnection(item.id)}
                        >
                            <span
                                style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                    minWidth: 0,
                                    fontWeight: isActive ? 600 : 400,
                                    color: isActive ? 'var(--primary)' : 'var(--foreground)',
                                }}
                            >
                                {item.label}
                            </span>
                            {isActive ? (
                                <span
                                    style={{
                                        color: 'var(--primary)',
                                        fontWeight: 700,
                                        flexShrink: 0,
                                    }}
                                >
                                    ✓
                                </span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export interface StAdminConfirmModalProps {
    open: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * Explicit in-Shadow-DOM secondary confirmation modal for enabling `🛡️ ST 全权管家`.
 * Never uses `window.confirm`.
 */
export function StAdminConfirmModal({ open, onCancel, onConfirm }: StAdminConfirmModalProps) {
    return (
        <ShadowModal
            open={open}
            title="🛡️ 确认开启「ST 全权管家」能力？"
            maxWidth="520px"
            onClose={onCancel}
            footer={
                <>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={onCancel}
                    >
                        取消
                    </Button>
                    <button
                        type="button"
                        data-assistant-st-admin-confirm="true"
                        class="ag-btn ag-btn-sm"
                        style={{
                            background: 'var(--error)',
                            color: '#ffffff',
                            borderColor: 'transparent',
                            fontWeight: 600,
                        }}
                        onClick={onConfirm}
                    >
                        确认开启 ST 全权管家
                    </button>
                </>
            }
        >
            <div class="ag-stack-v" data-assistant-st-admin-modal="true">
                <div class="ag-banner ag-banner-error">
                    开启后，当前助手会话将获得完整 SillyTavern
                    管理权限：读写全库世界书与角色卡、修改人设与 ST
                    全局设置、切换预设、执行斜杠命令以及从 URL 导入资源。
                </div>
                <div
                    class="ag-card"
                    style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}
                >
                    <div style={{ fontWeight: 600, fontSize: '12px' }}>
                        强制安全红线（不可关闭）：
                    </div>
                    <ul
                        style={{
                            margin: 0,
                            paddingLeft: '18px',
                            fontSize: '12px',
                            color: 'var(--muted-foreground)',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '4px',
                        }}
                    >
                        <li>
                            删除、修改设置/预设、全局正则、斜杠命令、URL 导入与跨卡批量操作{' '}
                            <strong style={{ color: 'var(--foreground)' }}>
                                永远强制人工审批
                            </strong>
                            ；
                        </li>
                        <li>
                            所有读工具返回的设置与连接中，<code class="ag-mono">apiKey</code> /{' '}
                            <code class="ag-mono">token</code> / <code class="ag-mono">secret</code>{' '}
                            一律脱敏为 <span class="ag-redacted-token">***REDACTED***</span>；
                        </li>
                        <li>每次写入均保留写前快照，支持随时一键撤销。</li>
                    </ul>
                </div>
            </div>
        </ShadowModal>
    );
}
