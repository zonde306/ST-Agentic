import { registerConsoleView } from '@/ui/store';
import { CacheStorageView } from './CacheStorageView';
import { FilesOverridesView } from './FilesOverridesView';
import { LogsView } from './LogsView';

export { FilesOverridesView } from './FilesOverridesView';
export { LogsView } from './LogsView';
export { CacheStorageView } from './CacheStorageView';

/**
 * Register the 3 "Current Session" console tabs (`files`, `logs`, `cache`)
 * into the global console view registry.
 */
export function registerSessionViews(): () => void {
    const unregisterFiles = registerConsoleView('files', FilesOverridesView);
    const unregisterLogs = registerConsoleView('logs', LogsView);
    const unregisterCache = registerConsoleView('cache', CacheStorageView);

    return () => {
        unregisterFiles();
        unregisterLogs();
        unregisterCache();
    };
}
