import { registerConsoleView } from '@/ui/store';
import { AssistantView } from './AssistantView';

export { AssistantView } from './AssistantView';
export { SessionListPanel, type SessionListPanelProps } from './SessionListPanel';
export {
    ModeModelPopover,
    StAdminConfirmModal,
    type AssistantSessionConfig,
    type ComposerPopoverKind,
    type ModeModelPopoverProps,
    type StAdminConfirmModalProps,
} from './ModeModelPopover';
export { MessageBubble, type MessageBubbleProps } from './MessageBubble';
export {
    AttachedApprovalCard,
    type AttachedApprovalCardProps,
} from './AttachedApprovalCard';
export { UndoHistoryModal, type UndoHistoryModalProps } from './UndoHistoryModal';

/**
 * Register the Assistant Workbench console tab (`assistant`) into the global console
 * view registry, returning an unregister cleanup callback.
 */
export function registerAssistantView(): () => void {
    return registerConsoleView('assistant', AssistantView);
}
