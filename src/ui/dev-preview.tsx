import { registerAssistantView } from './assistant';
import { registerAgenticCapsuleElement } from './capsule';
import { registerSessionViews } from './session';
import { type MountedAgenticShell, mountAgenticAppShell } from './shell';
import {
    AppStore,
    createMockBackgroundTasks,
    createMockSettings,
    createMockTraces,
    createMockUIServices,
    setDefaultAppStore,
} from './store';
import { registerSideGenView } from './sidegen';
import { registerStudioViews } from './studio';

export interface DevPreviewInstance extends MountedAgenticShell {
    dispose: () => void;
}

/**
 * Standalone development entry mounting `<dialog id="agentic-app">` with rich mock
 * settings, traces, background tasks, and UI services (`npm run dev:ui` / `build:dev-ui`).
 */
export function mountDevPreview(): DevPreviewInstance {
    registerAgenticCapsuleElement();
    const unregisterAssistant = registerAssistantView();
    const unregisterSideGen = registerSideGenView();
    const unregisterSession = registerSessionViews();
    const unregisterStudio = registerStudioViews();

    const services = createMockUIServices();
    const store = new AppStore({
        initialSettings: createMockSettings(),
        initialTraces: createMockTraces(),
        initialBackgroundTasks: createMockBackgroundTasks(),
        initialOpen: true,
        initialTab: 'files',
        services,
    });
    setDefaultAppStore(store);

    const mounted = mountAgenticAppShell({ store });

    const openBtn = document.getElementById('dev-open-console');
    const onOpenClick = () => store.openConsole();
    openBtn?.addEventListener('click', onOpenClick);

    const hostThemeBtn = document.getElementById('dev-toggle-host-theme');
    let hostIsDark = true;
    const onToggleHostTheme = () => {
        hostIsDark = !hostIsDark;
        const root = document.documentElement;
        if (hostIsDark) {
            root.style.setProperty('--SmartThemeBlurTintColor', 'rgba(20, 22, 27, 0.92)');
            root.style.setProperty('--SmartThemeBodyColor', '#e6e9ef');
        } else {
            root.style.setProperty('--SmartThemeBlurTintColor', 'rgba(244, 246, 250, 0.96)');
            root.style.setProperty('--SmartThemeBodyColor', '#181c24');
        }
        store.refreshResolvedTheme();
    };
    hostThemeBtn?.addEventListener('click', onToggleHostTheme);

    return {
        ...mounted,
        dispose: () => {
            openBtn?.removeEventListener('click', onOpenClick);
            hostThemeBtn?.removeEventListener('click', onToggleHostTheme);
            mounted.unmount();
            unregisterAssistant();
            unregisterSideGen();
            unregisterSession();
            unregisterStudio();
            store.dispose();
        },
    };
}

if (typeof document !== 'undefined') {
    const boot = () => {
        mountDevPreview();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}

export default mountDevPreview;
