import { registerConsoleView } from '@/ui/store';
import { AgentsView } from './AgentsView';
import { ConnectionsView } from './ConnectionsView';
import { PipelineView } from './PipelineView';
import { RegexView } from './RegexView';
import { ToolsView } from './ToolsView';
import { WIRouterView } from './WIRouterView';

export { AgentsView } from './AgentsView';
export { PipelineView } from './PipelineView';
export { ToolsView } from './ToolsView';
export { RegexView } from './RegexView';
export { WIRouterView } from './WIRouterView';
export {
    ConnectionsView,
    buildSanitizedConnectionsExportJson,
} from './ConnectionsView';
export {
    PresetManagerPanel,
    buildSanitizedPresetExportJson,
    type PresetManagerPanelProps,
} from './PresetManagerPanel';

/**
 * Register all 6 Studio ("预设与系统") console views with `registerConsoleView`,
 * returning a cleanup callback that unregisters all 6 tabs.
 */
export function registerStudioViews(): () => void {
    const unregisters = [
        registerConsoleView('agents', AgentsView),
        registerConsoleView('pipeline', PipelineView),
        registerConsoleView('tools', ToolsView),
        registerConsoleView('regex', RegexView),
        registerConsoleView('wi', WIRouterView),
        registerConsoleView('connections', ConnectionsView),
    ];

    return () => {
        for (const unregister of unregisters) {
            unregister();
        }
    };
}
