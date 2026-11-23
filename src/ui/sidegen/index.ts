import { registerConsoleView } from '@/ui/store';
import { SideGenView } from './SideGenView';

export { SideGenView } from './SideGenView';
export { CluesManagerPane, type CluesManagerPaneProps } from './CluesManagerPane';
export { SideSessionsPane, type SideSessionsPaneProps } from './SideSessionsPane';
export { SdkPlaygroundPane, type SdkPlaygroundPaneProps } from './SdkPlaygroundPane';
export {
    ExportWorldInfoModal,
    type ExportWorldInfoModalProps,
} from './ExportWorldInfoModal';

/**
 * Register the SideGen console tab (`sidegen`) into the global console view registry,
 * returning an unregister cleanup callback.
 */
export function registerSideGenView(): () => void {
    return registerConsoleView('sidegen', SideGenView);
}
