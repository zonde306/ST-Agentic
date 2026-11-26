/**
 * Light-DOM reset stylesheet scoped exclusively to `#agentic-app` and its immediate
 * ShadowRoot host wrapper so SillyTavern / third-party themes cannot warp the dialog frame.
 */
export const AGENTIC_DIALOG_RESET_STYLES = `
#agentic-app {
    all: revert;
    box-sizing: border-box !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    color: inherit !important;
    overflow: visible !important;
    max-width: none !important;
    max-height: none !important;
    margin: auto !important;
    width: min(1180px, calc(100vw - 32px)) !important;
    height: min(760px, calc(100dvh - 32px)) !important;
}
#agentic-app:not([open]) {
    display: none !important;
}
#agentic-app:focus,
#agentic-app:focus-visible {
    outline: none !important;
}
#agentic-app[open] {
    display: flex !important;
    flex-direction: column !important;
}
#agentic-app::backdrop {
    background: rgba(6, 6, 10, 0.6) !important;
    backdrop-filter: blur(6px) saturate(120%) !important;
}
#agentic-app > [data-agentic-shadow-host] {
    display: flex !important;
    flex-direction: column !important;
    flex: 1 1 auto !important;
    width: 100% !important;
    height: 100% !important;
    min-width: 0 !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    background: transparent !important;
    font-family: "Inter", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif !important;
    font-size: 13px !important;
    line-height: 1.5 !important;
}
#agentic-app[data-maximized="true"] {
    width: 100vw !important;
    height: var(--ag-viewport-height, 100dvh) !important;
    max-width: 100vw !important;
    max-height: var(--ag-viewport-height, 100dvh) !important;
    margin: 0 !important;
    inset: 0 !important;
}
#agentic-app[data-maximized="true"]::backdrop {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
}
@media (max-width: 767px) {
    #agentic-app {
        width: 100vw !important;
        height: var(--ag-viewport-height, 100dvh) !important;
        max-width: 100vw !important;
        max-height: var(--ag-viewport-height, 100dvh) !important;
        margin: 0 !important;
        inset: 0 !important;
    }
    #agentic-app::backdrop {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background: rgba(0, 0, 0, 0.8) !important;
    }
}
`;

/**
 * Self-contained Shadow DOM CSS stylesheet (`:host { all: initial }` physical boundary).
 * Contains zero references to SillyTavern host classes or external icon fonts.
 */
export const AGENTIC_SHELL_STYLES = `
/* ========================================================================= */
/* Design Tokens — "Iris" Design System v2 (docs/UI_DESIGN_SYSTEM.md §1)     */
/* ========================================================================= */
:host {
    all: initial;
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;

    /* Typography */
    --font-sans: "Inter", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;

    /* Radius */
    --radius-xs: 4px;
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
    --radius-xl: 14px;
    --radius-window: 16px;

    /* Motion */
    --dur-fast: 120ms;
    --dur: 180ms;
    --ease: cubic-bezier(0.2, 0.8, 0.2, 1);

    /* Dark palette (default) */
    --background: #0e0e10;
    --sidebar: #141416;
    --content: #19191c;
    --card: #1f1f23;
    --secondary: #28282d;
    --secondary-foreground: #ececf1;
    --hover: rgba(255, 255, 255, 0.045);
    --active: rgba(255, 255, 255, 0.075);
    --border: #2a2a30;
    --card-border: #25252a;
    --border-strong: #3a3a42;
    --foreground: #ececf1;
    --muted-foreground: #a1a1ab;
    --subtle-foreground: #6c6c77;
    --primary: #7d7bf6;
    --primary-hover: #8e8cf8;
    --primary-foreground: #ffffff;
    --primary-soft: color-mix(in srgb, var(--primary) 14%, transparent);
    --ring: color-mix(in srgb, var(--primary) 55%, transparent);
    --success: #4cc38a;
    --warning: #e8a93c;
    --error: #f06470;
    --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.35);
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.35), 0 1px 2px rgba(0, 0, 0, 0.25);
    --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a1a1ab' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    color-scheme: dark;

    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    color: var(--foreground);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
}

:host([data-theme="dark"]) {
    --background: #0e0e10;
    --sidebar: #141416;
    --content: #19191c;
    --card: #1f1f23;
    --secondary: #28282d;
    --secondary-foreground: #ececf1;
    --hover: rgba(255, 255, 255, 0.045);
    --active: rgba(255, 255, 255, 0.075);
    --border: #2a2a30;
    --card-border: #25252a;
    --border-strong: #3a3a42;
    --foreground: #ececf1;
    --muted-foreground: #a1a1ab;
    --subtle-foreground: #6c6c77;
    --primary: #7d7bf6;
    --primary-hover: #8e8cf8;
    --primary-foreground: #ffffff;
    --primary-soft: color-mix(in srgb, var(--primary) 14%, transparent);
    --ring: color-mix(in srgb, var(--primary) 55%, transparent);
    --success: #4cc38a;
    --warning: #e8a93c;
    --error: #f06470;
    --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.35);
    --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.35), 0 1px 2px rgba(0, 0, 0, 0.25);
    --shadow-md: 0 8px 24px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.04);
    --shadow-lg: 0 24px 64px rgba(0, 0, 0, 0.55), 0 4px 16px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a1a1ab' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    color-scheme: dark;
}

:host([data-theme="light"]) {
    --background: #ececef;
    --sidebar: #f4f4f6;
    --content: #fbfbfc;
    --card: #ffffff;
    --secondary: #efeff2;
    --secondary-foreground: #1a1a1f;
    --hover: rgba(15, 15, 30, 0.04);
    --active: rgba(15, 15, 30, 0.065);
    --border: #e3e3e8;
    --card-border: #ececf0;
    --border-strong: #d0d0d8;
    --foreground: #1a1a1f;
    --muted-foreground: #62626d;
    --subtle-foreground: #9c9ca7;
    --primary: #5753e0;
    --primary-hover: #4a46d3;
    --primary-foreground: #ffffff;
    --primary-soft: color-mix(in srgb, var(--primary) 9%, transparent);
    --ring: color-mix(in srgb, var(--primary) 45%, transparent);
    --success: #1a8a52;
    --warning: #b5650b;
    --error: #d3344a;
    --shadow-xs: 0 1px 2px rgba(20, 20, 40, 0.08);
    --shadow-sm: 0 1px 3px rgba(20, 20, 40, 0.08), 0 1px 2px rgba(20, 20, 40, 0.05);
    --shadow-md: 0 10px 28px rgba(20, 20, 40, 0.12), 0 2px 6px rgba(20, 20, 40, 0.06);
    --shadow-lg: 0 24px 60px rgba(20, 20, 40, 0.18), 0 4px 14px rgba(20, 20, 40, 0.08);
    --select-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2362626d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
    color-scheme: light;
}

:host > [data-agentic-mount] {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    color: var(--foreground);
}

*, *::before, *::after {
    box-sizing: border-box;
}

* {
    scrollbar-width: thin;
    scrollbar-color: color-mix(in srgb, var(--muted-foreground) 28%, transparent) transparent;
}

button, input, select, textarea {
    font-family: inherit;
    color: inherit;
    margin: 0;
}

button,
[role="switch"],
[role="radio"],
.ag-touch-target {
    min-width: 40px;
    min-height: 40px;
}

input,
select,
textarea {
    font-size: 16px;
    max-width: 100%;
}

input:not([type="checkbox"]):not([type="radio"]),
select {
    min-height: 40px;
}

input[type="checkbox"],
input[type="radio"] {
    accent-color: var(--primary);
    width: 16px;
    height: 16px;
    cursor: pointer;
}

::placeholder {
    color: var(--subtle-foreground);
    opacity: 1;
}

::selection {
    background: color-mix(in srgb, var(--primary) 32%, transparent);
}

:focus {
    outline: none;
}

:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
}

input:focus-visible,
select:focus-visible,
textarea:focus-visible {
    outline: none;
}

@media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
        transition-duration: 0ms !important;
        animation-duration: 0ms !important;
    }
}

.ag-icon {
    flex-shrink: 0;
}

.ag-thin-scroll::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}
.ag-thin-scroll::-webkit-scrollbar-track {
    background: transparent;
}
.ag-thin-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--muted-foreground) 26%, transparent);
    border-radius: 9999px;
    border: 2px solid transparent;
    background-clip: padding-box;
}
.ag-thin-scroll::-webkit-scrollbar-thumb:hover {
    background-color: color-mix(in srgb, var(--muted-foreground) 42%, transparent);
}

/* ========================================================================= */
/* Shell — Window Frame, Header, Sidebar, Main Canvas (§2)                   */
/* ========================================================================= */
.ag-console {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--sidebar);
    color: var(--foreground);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    border: 1px solid var(--border);
    border-radius: var(--radius-window);
    overflow: hidden;
    box-shadow: var(--shadow-lg);
}

.ag-console[data-maximized="true"] {
    border-radius: 0;
    border: none;
    box-shadow: none;
}

/* Header */
.ag-header {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    min-height: 56px;
    padding: 8px 10px 8px 16px;
    background: var(--sidebar);
    max-width: 100%;
    overflow-x: hidden;
}

.ag-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    user-select: none;
    cursor: default;
}

.ag-brand-logo {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
    background: linear-gradient(140deg, color-mix(in srgb, var(--primary) 82%, #ffffff) 0%, var(--primary) 55%, color-mix(in srgb, var(--primary) 70%, #000000) 100%);
    color: var(--primary-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: var(--shadow-xs), inset 0 1px 0 rgba(255, 255, 255, 0.22);
}

.ag-brand-title {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
}

.ag-isolation-pill {
    display: none;
}

.ag-header-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
    flex: 1 1 auto;
}

.ag-header-select-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    padding: 0 2px;
    border-radius: var(--radius-lg);
}

.ag-ctx-select {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-width: 0;
    border-radius: var(--radius-md);
    color: var(--muted-foreground);
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ctx-select:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-ctx-select-icon {
    position: absolute;
    left: 10px;
    display: inline-flex;
    pointer-events: none;
}

.ag-ctx-select .ag-select.ag-header-select {
    width: auto;
    min-width: 120px;
    max-width: 200px;
    padding-left: 32px;
    padding-right: 30px;
    border-color: transparent;
    background-color: transparent;
    color: var(--foreground);
    font-size: 16px;
    font-weight: 500;
    text-overflow: ellipsis;
}

.ag-ctx-select .ag-select.ag-header-select:hover {
    border-color: transparent;
}

.ag-header-select {
    width: auto;
    min-width: 136px;
    max-width: 210px;
}

.ag-header-actions {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-wrap: wrap;
}

.ag-header-divider {
    width: 1px;
    height: 20px;
    margin: 0 6px;
    background: var(--border);
    flex-shrink: 0;
}

.ag-window-toggle-btn {
    padding: 0;
}

.ag-header .ag-btn-ghost {
    color: var(--muted-foreground);
}

.ag-header .ag-btn-ghost:hover:not(:disabled) {
    color: var(--foreground);
}

/* Mobile Top Horizontal Nav */
.ag-mobile-nav {
    display: none;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 4px 10px 8px;
    background: var(--sidebar);
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
}

.ag-mobile-nav::-webkit-scrollbar {
    display: none;
}

.ag-mobile-nav-divider {
    width: 1px;
    height: 18px;
    background: var(--border);
    flex-shrink: 0;
    margin: 0 4px;
}

.ag-mobile-tab {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    min-height: 40px;
    min-width: 40px;
    border-radius: 9999px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-mobile-tab:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-mobile-tab-active,
.ag-mobile-tab-active:hover {
    background: var(--card);
    color: var(--foreground);
    border-color: var(--border);
    box-shadow: var(--shadow-xs);
}

.ag-mobile-tab-active .ag-icon {
    color: var(--primary);
}

/* Main Body */
.ag-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    overflow: hidden;
    padding: 0 8px 8px 0;
}

.ag-console[data-maximized="true"] .ag-body {
    padding: 0 8px 8px 0;
}

/* Desktop Left Sidebar */
.ag-sidebar {
    width: 212px;
    flex-shrink: 0;
    background: var(--sidebar);
    padding: 4px 10px 0;
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    transition: width 180ms var(--ease);
}

.ag-nav-group {
    display: flex;
    flex-direction: column;
    gap: 1px;
}

.ag-nav-group-label {
    position: relative;
    padding: 6px 10px 4px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: var(--subtle-foreground);
    white-space: nowrap;
    overflow: hidden;
    user-select: none;
    transition: color var(--dur-fast) var(--ease);
}

.ag-nav-item {
    position: relative;
    width: 100%;
    text-align: left;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 10px;
    min-height: 40px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), padding 180ms var(--ease);
}

.ag-nav-item:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-nav-item-active,
.ag-nav-item-active:hover {
    background: var(--active);
    color: var(--foreground);
}

.ag-nav-item-active::before {
    content: "";
    position: absolute;
    left: -10px;
    top: 10px;
    bottom: 10px;
    width: 3px;
    border-radius: 0 3px 3px 0;
    background: var(--primary);
}

.ag-nav-item-icon {
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
    color: inherit;
    opacity: 0.9;
}

.ag-nav-item-active .ag-nav-item-icon {
    color: var(--primary);
    opacity: 1;
}

.ag-nav-item-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    transition: opacity var(--dur-fast) var(--ease);
}

.ag-nav-item-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}

.ag-nav-item-label {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-nav-count-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 9999px;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
}

.ag-nav-count-badge-on-active {
    background: color-mix(in srgb, var(--warning) 22%, transparent);
    color: var(--warning);
}

.ag-nav-item-desc {
    display: none;
}

/* Collapsed-only attention dot (replaces the count badge in icon-rail mode) */
.ag-nav-item-dot {
    position: absolute;
    top: -3px;
    right: -4px;
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    background: var(--warning);
    box-shadow: 0 0 0 2px var(--sidebar);
    opacity: 0;
    transform: scale(0.4);
    transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
    pointer-events: none;
}

/* Sidebar footer — collapse / expand toggle, pinned to the rail bottom */
.ag-sidebar-footer {
    position: sticky;
    bottom: 0;
    margin-top: auto;
    padding: 6px 0 10px;
    background: var(--sidebar);
}

.ag-sidebar-footer::before {
    content: "";
    position: absolute;
    top: 0;
    left: 10px;
    right: 10px;
    height: 1px;
    background: var(--border);
}

.ag-sidebar-toggle {
    color: var(--subtle-foreground);
}

/* Collapsed icon-rail mode: 60px = 10px padding + 40px target + 10px padding */
.ag-sidebar[data-collapsed="true"] {
    width: 60px;
}

.ag-sidebar[data-collapsed="true"] .ag-nav-item {
    padding: 0 12px;
}

.ag-sidebar[data-collapsed="true"] .ag-nav-item-text {
    opacity: 0;
    pointer-events: none;
}

.ag-sidebar[data-collapsed="true"] .ag-nav-item-dot {
    opacity: 1;
    transform: scale(1);
}

/* Group titles keep their height (no vertical jump) and turn into hairline dividers */
.ag-sidebar[data-collapsed="true"] .ag-nav-group-label {
    color: transparent;
}

.ag-sidebar[data-collapsed="true"] .ag-nav-group:not(:first-child) .ag-nav-group-label::after {
    content: "";
    position: absolute;
    left: 10px;
    right: 10px;
    top: 50%;
    height: 1px;
    background: var(--border);
}

/* Main Content Slot — inset canvas panel */
.ag-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--content);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    overflow: hidden;
    box-shadow: var(--shadow-xs);
}

.ag-view-scroll {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 20px;
}

/* MasterDetailLayout */
.ag-split-layout {
    display: grid;
    grid-template-columns: minmax(240px, 32%) minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
}

.ag-split-master {
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--content);
    overflow-y: auto;
    overflow-x: hidden;
}

.ag-split-detail {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--content);
}

.ag-stack-layout {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
}

.ag-stack-topbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 6px 10px;
    background: var(--content);
    border-bottom: 1px solid var(--border);
    min-width: 0;
}

.ag-stack-back-btn {
    flex-shrink: 0;
}

.ag-stack-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ag-stack-extra {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
}

.ag-stack-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
}

/* ========================================================================= */
/* Base Components (§3)                                                      */
/* ========================================================================= */

/* Button */
.ag-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 14px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0;
    cursor: pointer;
    white-space: nowrap;
    user-select: none;
    transition:
        background-color var(--dur-fast) var(--ease),
        border-color var(--dur-fast) var(--ease),
        color var(--dur-fast) var(--ease),
        box-shadow var(--dur-fast) var(--ease),
        opacity var(--dur-fast) var(--ease);
}

.ag-btn-sm {
    padding: 0 12px;
    font-size: 13px;
}

.ag-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-btn:active:not(:disabled) {
    transform: translateY(0.5px);
}

.ag-btn-primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: transparent;
    box-shadow: var(--shadow-xs), inset 0 1px 0 rgba(255, 255, 255, 0.14);
}

.ag-btn-primary:hover:not(:disabled) {
    background: var(--primary-hover);
}

.ag-btn-secondary {
    background: var(--card);
    color: var(--foreground);
    border-color: var(--border);
    box-shadow: var(--shadow-xs);
}

.ag-btn-secondary:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: color-mix(in srgb, var(--card) 85%, var(--secondary));
}

.ag-btn-ghost {
    background: transparent;
    color: var(--foreground);
    border-color: transparent;
}

.ag-btn-ghost:hover:not(:disabled) {
    background: var(--hover);
}

.ag-btn-danger {
    background: transparent;
    color: var(--error);
    border-color: transparent;
}

.ag-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 12%, transparent);
}

.ag-btn-danger-solid,
.ag-modal-footer .ag-btn-danger {
    background: var(--error);
    color: #ffffff;
    border-color: transparent;
    box-shadow: var(--shadow-xs);
}

.ag-btn-danger-solid:hover:not(:disabled),
.ag-modal-footer .ag-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 88%, #000000);
}

.ag-btn-active,
.ag-btn-active:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--primary) 40%, transparent);
    background: var(--primary-soft);
    color: var(--primary);
}

.ag-btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.ag-btn-label {
    display: inline-flex;
    align-items: center;
}

/* Segmented Control */
.ag-segmented {
    display: inline-flex;
    align-items: center;
    padding: 3px;
    gap: 2px;
    background: var(--content);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
}

.ag-segmented::-webkit-scrollbar {
    display: none;
}

.ag-segmented-item {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color var(--dur) var(--ease), color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.ag-segmented-item:hover:not(.ag-segmented-item-active):not(:disabled) {
    color: var(--foreground);
}

.ag-segmented-item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-segmented-item-active {
    background: var(--card);
    color: var(--foreground);
    font-weight: 600;
    box-shadow: var(--shadow-xs), 0 0 0 1px var(--border);
}

/* Run-mode segmented control (header) */
.ag-runmode {
    padding: 2px;
}

.ag-runmode .ag-segmented-item-active::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--subtle-foreground);
    flex-shrink: 0;
}

.ag-runmode .ag-segmented-item-active[data-value="companion"]::before {
    background: var(--success);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 22%, transparent);
}

.ag-runmode .ag-segmented-item-active[data-value="takeover"]::before {
    background: var(--primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 26%, transparent);
}

.ag-runmode .ag-segmented-item-active[data-value="takeover"] {
    color: var(--primary);
}

/* Toggle Switch */
.ag-switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
}

.ag-switch-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    cursor: pointer;
}

.ag-switch-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--foreground);
}

.ag-switch-desc {
    font-size: 12px;
    color: var(--muted-foreground);
}

.ag-switch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 44px;
    min-height: 40px;
    padding: 0 4px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
}

.ag-switch:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-switch-track {
    position: relative;
    width: 36px;
    height: 20px;
    border-radius: 9999px;
    background: var(--secondary);
    box-shadow: inset 0 0 0 1px var(--border);
    transition: background-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.ag-switch:hover:not(:disabled) .ag-switch-track {
    box-shadow: inset 0 0 0 1px var(--border-strong);
}

.ag-switch-on .ag-switch-track,
.ag-switch-on:hover:not(:disabled) .ag-switch-track {
    background: var(--primary);
    box-shadow: none;
}

.ag-switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 9999px;
    background: #ffffff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform var(--dur) var(--ease);
}

.ag-switch-on .ag-switch-thumb {
    transform: translateX(16px);
}

/* Badges */
.ag-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-sm);
    border: none;
    overflow: hidden;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

.ag-badge-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-badge-neutral {
    background: var(--secondary);
    color: var(--muted-foreground);
}

.ag-badge-primary {
    background: var(--primary-soft);
    color: var(--primary);
}

.ag-badge-success {
    background: color-mix(in srgb, var(--success) 13%, transparent);
    color: var(--success);
}

.ag-badge-warning {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
}

.ag-badge-error {
    background: color-mix(in srgb, var(--error) 13%, transparent);
    color: var(--error);
}

/* Forms */
.ag-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.ag-field-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted-foreground);
    display: flex;
    align-items: center;
    gap: 4px;
}

.ag-field-required {
    color: var(--error);
}

.ag-field-hint {
    font-size: 12px;
    line-height: 1.5;
    color: var(--subtle-foreground);
}

.ag-field-error {
    font-size: 12px;
    color: var(--error);
}

.ag-input,
.ag-select,
.ag-textarea {
    width: 100%;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-size: 16px;
    line-height: 1.4;
    outline: none;
    transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}

.ag-input,
.ag-select {
    min-height: 40px;
}

.ag-select {
    appearance: none;
    -webkit-appearance: none;
    padding-right: 34px;
    background-image: var(--select-chevron);
    background-repeat: no-repeat;
    background-position: right 10px center;
    background-size: 16px 16px;
    cursor: pointer;
    text-overflow: ellipsis;
}

.ag-select option {
    background: var(--card);
    color: var(--foreground);
}

.ag-textarea {
    resize: vertical;
    min-height: 88px;
    line-height: 1.55;
}

.ag-input:hover:not(:disabled):not(:focus),
.ag-select:hover:not(:disabled):not(:focus),
.ag-textarea:hover:not(:disabled):not(:focus),
.ag-code-textarea:hover:not(:disabled):not(:focus) {
    border-color: var(--border-strong);
}

.ag-input:focus,
.ag-select:focus,
.ag-textarea:focus,
.ag-code-textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
}

.ag-input:disabled,
.ag-select:disabled,
.ag-textarea:disabled,
.ag-input[readonly],
.ag-textarea[readonly] {
    color: var(--muted-foreground);
    background-color: color-mix(in srgb, var(--content) 60%, var(--secondary));
}

.ag-input:disabled,
.ag-select:disabled,
.ag-textarea:disabled {
    cursor: not-allowed;
}

/* Code Editor */
.ag-code-editor {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    min-width: 0;
}

.ag-code-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.ag-code-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted-foreground);
}

.ag-code-lang {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    padding: 2px 6px;
    border-radius: var(--radius-xs);
    background: var(--secondary);
    color: var(--muted-foreground);
}

.ag-code-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    overflow-x: auto;
    overflow-y: hidden;
}

.ag-code-toolbar .ag-btn {
    background: transparent;
    border-color: transparent;
    box-shadow: none;
    color: var(--muted-foreground);
    padding: 0 10px;
    font-size: 12px;
}

.ag-code-toolbar .ag-btn:hover:not(:disabled) {
    background: var(--hover);
    color: var(--foreground);
}

.ag-code-textarea {
    width: 100%;
    padding: 12px 14px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: 16px;
    line-height: 1.6;
    tab-size: 2;
    outline: none;
    resize: vertical;
    transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

/* Cards & Empty States */
.ag-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
    min-width: 0;
}

.ag-card .ag-card {
    background: var(--content);
    border-color: var(--card-border);
}

.ag-card-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--card-border);
    background: transparent;
}

.ag-card-headings {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1 1 200px;
}

.ag-card-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.005em;
    color: var(--foreground);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.ag-card-subtitle {
    margin: 0;
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-foreground);
}

.ag-card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.ag-card-body {
    padding: 16px;
    min-width: 0;
}

.ag-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 8px;
    padding: 40px 24px;
    min-height: 220px;
    color: var(--muted-foreground);
}

.ag-empty-icon {
    width: 40px;
    height: 40px;
    margin-bottom: 4px;
    border-radius: var(--radius-lg);
    background: var(--secondary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted-foreground);
}

.ag-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--foreground);
}

.ag-empty-desc {
    font-size: 12px;
    line-height: 1.6;
    max-width: 360px;
    color: var(--muted-foreground);
}

.ag-empty-action {
    margin-top: 8px;
}

/* Lists inside Master Pane */
.ag-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px;
}

.ag-list-item {
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    min-height: 48px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ag-list-item:hover {
    background: var(--hover);
}

.ag-list-item-active,
.ag-list-item-active:hover {
    background: var(--primary-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent);
}

.ag-list-item-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--foreground);
    word-break: break-word;
}

.ag-list-item-meta {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    font-size: 12px;
    color: var(--muted-foreground);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

/* Dropdown Menu (§3.9) */
.ag-menu {
    position: relative;
    display: inline-flex;
}

.ag-menu-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 45;
    min-width: 188px;
    max-width: min(280px, calc(100vw - 24px));
    padding: 4px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    box-shadow: var(--shadow-md);
    display: flex;
    flex-direction: column;
    gap: 1px;
    animation: ag-menu-in var(--dur) var(--ease);
}

.ag-menu-panel[data-align="left"] {
    right: auto;
    left: 0;
}

@keyframes ag-menu-in {
    from { opacity: 0; }
    to { opacity: 1; }
}

.ag-menu-item {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 40px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease);
}

.ag-menu-item:hover:not(:disabled),
.ag-menu-item:focus-visible {
    background: var(--hover);
    outline: none;
}

.ag-menu-item:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-menu-item-icon {
    display: inline-flex;
    color: var(--muted-foreground);
    flex-shrink: 0;
}

.ag-menu-item-danger,
.ag-menu-item-danger .ag-menu-item-icon {
    color: var(--error);
}

.ag-menu-item-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 10%, transparent);
}

.ag-menu-separator {
    height: 1px;
    margin: 4px 6px;
    background: var(--card-border);
}

/* Modal Inside Shadow DOM */
.ag-modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    background: color-mix(in srgb, var(--background) 62%, transparent);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    animation: ag-fade-in var(--dur) var(--ease);
}

@keyframes ag-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
}

@keyframes ag-modal-in {
    from { opacity: 0; }
    to { opacity: 1; }
}

.ag-modal {
    width: 100%;
    max-height: 100%;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-lg);
    animation: ag-modal-in var(--dur) var(--ease);
}

.ag-modal-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 56px;
    padding: 8px 8px 8px 20px;
    border-bottom: 1px solid var(--card-border);
    background: transparent;
}

.ag-modal-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-modal-header .ag-btn-ghost {
    color: var(--muted-foreground);
}

.ag-modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ag-modal-footer {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px;
    border-top: 1px solid var(--card-border);
    background: transparent;
}

/* Toasts Inside Shadow DOM — top-centre, just below the header, so they never
   cover the composer / send button or the bottom-right actions. */
.ag-toast-container {
    position: absolute;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: min(420px, calc(100% - 32px));
    pointer-events: none;
}

@keyframes ag-toast-in {
    from { opacity: 0; transform: translateY(-6px); }
    to { opacity: 1; transform: translateY(0); }
}

.ag-toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 100%;
    padding: 0 4px 0 14px;
    min-height: 44px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 13px;
    font-weight: 500;
    box-shadow: var(--shadow-md);
    animation: ag-toast-in var(--dur) var(--ease);
}

.ag-toast-icon {
    display: inline-flex;
    flex-shrink: 0;
}

.ag-toast-primary .ag-toast-icon { color: var(--primary); }
.ag-toast-success .ag-toast-icon { color: var(--success); }
.ag-toast-warning .ag-toast-icon { color: var(--warning); }
.ag-toast-error .ag-toast-icon { color: var(--error); }

.ag-toast-msg {
    flex: 1 1 auto;
    min-width: 0;
    word-break: break-word;
    line-height: 1.45;
    padding: 6px 0;
}

.ag-toast-close {
    min-width: 42px;
    min-height: 42px;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--subtle-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-toast-close:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-toast-action {
    min-height: 42px;
    min-width: 42px;
    padding: 0 10px;
    border-radius: var(--radius-md);
    border: 1px solid color-mix(in srgb, var(--primary) 30%, transparent);
    background: var(--primary-soft);
    color: var(--primary);
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background var(--dur) var(--ease);
}

.ag-toast-action:hover {
    background: color-mix(in srgb, var(--primary) 20%, transparent);
}

.ag-toast-action:focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 1px;
}

/* ========================================================================= */
/* Layout Utilities                                                          */
/* ========================================================================= */
.ag-stack-v {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
}

.ag-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.ag-row-wrap {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.ag-grid-2 {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
}

.ag-grid-3 {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
}

.ag-grid-4 {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
}

.ag-mono {
    font-family: var(--font-mono);
}

.ag-pre {
    margin: 0;
    padding: 12px 14px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-diff-add {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
}

.ag-diff-del {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
}

.ag-diff-ctx {
    color: var(--muted-foreground);
    padding: 2px 6px;
    border-radius: var(--radius-xs);
}

.ag-diff-box {
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
}

.ag-diff-line {
    padding: 1px 10px;
    white-space: pre-wrap;
    word-break: break-all;
    border-bottom: none;
}

.ag-diff-line-add {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success);
    box-shadow: inset 2px 0 0 var(--success);
}

.ag-diff-line-del {
    background: color-mix(in srgb, var(--error) 12%, transparent);
    color: var(--error);
    box-shadow: inset 2px 0 0 var(--error);
}

.ag-diff-line-ctx {
    color: var(--muted-foreground);
}

/* Soft Pills & Redaction Highlights */
.ag-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-sm);
    border: none;
    background: var(--secondary);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
}

.ag-pill-primary {
    background: var(--primary-soft);
    color: var(--primary);
}

.ag-pill-success {
    background: color-mix(in srgb, var(--success) 13%, transparent);
    color: var(--success);
}

.ag-pill-warning {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
}

.ag-pill-error {
    background: color-mix(in srgb, var(--error) 13%, transparent);
    color: var(--error);
}

.ag-pill-muted {
    background: var(--secondary);
    color: var(--muted-foreground);
}

.ag-redacted-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
    font-size: 11px;
    font-weight: 500;
    flex-shrink: 0;
    white-space: nowrap;
}

.ag-redacted-token {
    display: inline-block;
    padding: 0 4px;
    border-radius: var(--radius-xs);
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
    font-weight: 600;
}

.ag-min-h-0 {
    min-height: 0;
}

.ag-min-w-0 {
    min-width: 0;
}

.ag-no-scrollbar {
    scrollbar-width: none;
    -ms-overflow-style: none;
}

.ag-no-scrollbar::-webkit-scrollbar {
    display: none;
}

/* Section toolbar shared by studio views (e.g. preset bar) */
.ag-toolbar {
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    min-height: 60px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--content);
    min-width: 0;
}

.ag-toolbar-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.ag-toolbar-label {
    font-size: 12px;
    font-weight: 500;
    color: var(--muted-foreground);
    white-space: nowrap;
}

.ag-toolbar-meta {
    font-size: 12px;
    color: var(--subtle-foreground);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
}

/* ========================================================================= */
/* Assistant Workbench (TS2.3 / TS3.1) — Shadow DOM Isolated Styles          */
/* ========================================================================= */

.ag-ast-root {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--content);
}

/* Slim Single-Line Top Bar (min-height: 46px) */
.ag-ast-topbar {
    flex-shrink: 0;
    min-height: 52px;
    padding: 6px 10px 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--content);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ag-ast-topbar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    flex: 1 1 auto;
}

.ag-ast-topbar-right {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.ag-ast-title-wrap {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    flex: 0 1 auto;
}

.ag-ast-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

.ag-ast-title-interactive {
    cursor: pointer;
    border-radius: var(--radius-sm);
    padding: 4px 6px;
    margin: -4px 0 -4px -6px;
    transition: background-color var(--dur-fast) var(--ease);
}

.ag-ast-title-interactive:hover,
.ag-ast-title-wrap[data-rename-revealed="true"] .ag-ast-title-interactive {
    background: color-mix(in srgb, var(--secondary) 75%, transparent);
}

.ag-ast-title-rename-btn {
    display: none;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    padding: 0;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-ast-title-rename-btn:hover:not(:disabled) {
    background: var(--secondary);
    color: var(--foreground);
    border-color: var(--border);
}

@media (hover: hover) and (pointer: fine) {
    .ag-ast-title-wrap:hover .ag-ast-title-rename-btn {
        display: inline-flex;
    }
}

.ag-ast-title-wrap:focus-within .ag-ast-title-rename-btn,
.ag-ast-title-wrap[data-rename-revealed="true"] .ag-ast-title-rename-btn {
    display: inline-flex;
}

.ag-ast-title-edit {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 380px;
}

.ag-ast-title-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 36px;
    padding: 4px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--primary);
    background: var(--content);
    color: var(--foreground);
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent);
}

.ag-ast-title-edit-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-title-edit-btn:hover:not(:disabled) {
    background: var(--secondary);
}

.ag-ast-title-edit-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.ag-ast-title-edit-save {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
    background: color-mix(in srgb, var(--primary) 14%, var(--card));
    color: var(--primary);
}

.ag-ast-title-edit-save:hover:not(:disabled) {
    background: color-mix(in srgb, var(--primary) 24%, var(--card));
}

.ag-ast-topbar-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-topbar-btn:hover:not(:disabled) {
    background: var(--hover);
    color: var(--foreground);
}

.ag-ast-undo-count {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    color: var(--warning);
}

/* Topbar Token Counter Pill (§4.1) */
@keyframes ag-ast-token-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
}

.ag-ast-token-pill {
    gap: 5px;
    padding: 0 10px;
    min-width: 40px;
    min-height: 40px;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
}

.ag-ast-token-dot {
    width: 7px;
    height: 7px;
    border-radius: 9999px;
    flex-shrink: 0;
    background: var(--muted-foreground);
}

.ag-ast-token-text {
    line-height: 1;
}

.ag-ast-token-normal {
    border-color: var(--border);
    background: transparent;
    color: var(--muted-foreground);
}

.ag-ast-token-normal:hover:not(:disabled) {
    color: var(--foreground);
}

.ag-ast-token-normal .ag-ast-token-dot {
    background: var(--success);
}

.ag-ast-token-warning {
    border-color: color-mix(in srgb, var(--warning) 62%, var(--border));
    background: color-mix(in srgb, var(--warning) 12%, var(--card));
    color: var(--warning);
}

.ag-ast-token-warning:hover:not(:disabled) {
    background: color-mix(in srgb, var(--warning) 20%, var(--card));
}

.ag-ast-token-warning .ag-ast-token-dot {
    background: var(--warning);
}

.ag-ast-token-danger {
    border-color: color-mix(in srgb, var(--error) 68%, var(--border));
    background: color-mix(in srgb, var(--error) 14%, var(--card));
    color: var(--error);
}

.ag-ast-token-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 22%, var(--card));
}

.ag-ast-token-danger .ag-ast-token-dot {
    background: var(--error);
}

.ag-ast-token-compacting {
    opacity: 0.82;
    cursor: progress;
    animation: ag-ast-token-pulse 1.2s ease-in-out infinite;
}

.ag-ast-token-compacting .ag-ast-token-dot {
    background: var(--primary);
}

/* Compaction Confirmation Modal (§4.2) */
.ag-compact-modal-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
}

.ag-compact-meter-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    min-width: 0;
}

.ag-compact-meter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}

.ag-compact-meter-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
}

.ag-compact-meter-value {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
}

.ag-compact-progress-track {
    position: relative;
    height: 10px;
    border-radius: 9999px;
    background: var(--card);
    border: 1px solid var(--border);
    overflow: hidden;
}

.ag-compact-progress-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.2s ease;
}

.ag-compact-progress-normal {
    background: var(--primary);
}

.ag-compact-progress-warning {
    background: var(--warning);
}

.ag-compact-progress-danger {
    background: var(--error);
}

.ag-compact-progress-marker {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--warning);
}

.ag-compact-stats {
    font-size: 12px;
    color: var(--muted-foreground);
    line-height: 1.45;
}

.ag-compact-preview-box {
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    overflow: hidden;
    min-width: 0;
}

.ag-compact-summary-toggle {
    width: 100%;
    min-width: 40px;
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 12px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
}

.ag-compact-summary-toggle:hover {
    background: var(--secondary);
}

.ag-compact-summary-pre {
    margin: 0;
    padding: 10px 12px;
    border-top: 1px solid var(--card-border);
    max-height: 180px;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--foreground);
}

.ag-compact-focus-textarea {
    width: 100%;
    min-height: 76px;
    max-height: 180px;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-family: inherit;
    font-size: 16px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
    box-sizing: border-box;
}

.ag-compact-focus-textarea:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent);
}

.ag-compact-modal-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    width: 100%;
}

/* Chat-Stream Compaction Separator Pill & Overflow Escape Bar (§4.3) */
.ag-ast-compaction-sep {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    margin: 2px 0;
    min-width: 0;
}

.ag-ast-compaction-line-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
}

.ag-ast-compaction-rule {
    flex: 1 1 16px;
    min-width: 8px;
    height: 1px;
    background: var(--card-border);
}

.ag-ast-compaction-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    padding: 6px 14px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--muted-foreground);
    font-size: 11px;
    line-height: 1.4;
    font-weight: 500;
    text-align: center;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-compaction-pill:hover {
    background: var(--secondary);
    color: var(--foreground);
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
}

.ag-ast-compaction-pill-static {
    cursor: default;
}

.ag-ast-compaction-pill-static:hover {
    background: var(--card);
    color: var(--muted-foreground);
    border-color: var(--border);
}

.ag-ast-compaction-pill-text {
    word-break: break-word;
    overflow-wrap: anywhere;
}

.ag-ast-compaction-summary {
    width: 100%;
    max-width: 720px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    box-sizing: border-box;
}

.ag-ast-compaction-meta {
    font-size: 11px;
    color: var(--muted-foreground);
    line-height: 1.45;
    word-break: break-word;
}

.ag-ast-compaction-pre {
    margin: 0;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-ast-overflow-escape {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: none;
    background: color-mix(in srgb, var(--error) 8%, transparent);
    box-shadow: inset 3px 0 0 var(--error);
    min-width: 0;
}

.ag-ast-overflow-hint {
    font-size: 12px;
    font-weight: 500;
    color: var(--error);
    line-height: 1.5;
}

.ag-ast-overflow-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.ag-ast-overflow-btn {
    min-width: 40px;
    min-height: 40px;
}

/* Live auto-retry banner & continue/recovery card (design spec §3.11 banner pattern) */
@keyframes ag-spin {
    to { transform: rotate(360deg); }
}

.ag-ast-retry-banner {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    border: none;
    background: color-mix(in srgb, var(--warning) 9%, transparent);
    box-shadow: inset 3px 0 0 var(--warning);
    color: var(--warning);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
    min-width: 0;
}

.ag-ast-retry-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.ag-ast-retry-spin {
    display: inline-flex;
    flex-shrink: 0;
    animation: ag-spin 1.1s linear infinite;
}

.ag-ast-retry-reason {
    padding-left: 19px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted-foreground);
    word-break: break-word;
}

.ag-ast-continue-bar {
    --ag-continue-tone: var(--muted-foreground);
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: none;
    background: var(--secondary);
    box-shadow: inset 3px 0 0 var(--ag-continue-tone);
    min-width: 0;
}

.ag-ast-continue-bar[data-tone="warning"] {
    --ag-continue-tone: var(--warning);
    background: color-mix(in srgb, var(--warning) 9%, transparent);
}

.ag-ast-continue-hint {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    font-weight: 500;
    color: var(--foreground);
    line-height: 1.5;
}

.ag-ast-continue-hint-icon {
    display: inline-flex;
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--ag-continue-tone);
}

.ag-ast-continue-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.ag-ast-continue-btn {
    min-width: 40px;
    min-height: 40px;
}

/* Session List Panel & Desktop Slide-Out Drawer */
.ag-ast-drawer-backdrop {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: color-mix(in srgb, var(--background) 55%, transparent);
    display: flex;
    justify-content: flex-start;
}

.ag-ast-drawer {
    width: min(312px, 88%);
    height: 100%;
    min-height: 0;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.ag-ast-session-panel {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    background: var(--sidebar);
}

.ag-ast-session-header {
    flex-shrink: 0;
    padding: 10px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

.ag-ast-session-list {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ag-ast-session-item {
    width: 100%;
    text-align: left;
    padding: 10px;
    min-height: 48px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--card-border);
    background: color-mix(in srgb, var(--content) 65%, var(--sidebar));
    color: var(--foreground);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-ast-session-item:hover {
    background: var(--secondary);
}

.ag-ast-session-item-active {
    background: var(--card);
    border-color: color-mix(in srgb, var(--primary) 60%, transparent);
    box-shadow: var(--shadow-sm);
}

.ag-ast-session-item-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
}

.ag-ast-session-item-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}

.ag-ast-session-item-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    font-size: 11px;
    color: var(--muted-foreground);
}

.ag-ast-session-item-actions {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
}

.ag-ast-session-icon-btn {
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    flex-shrink: 0;
    color: var(--muted-foreground);
}

.ag-ast-session-icon-btn:hover:not(:disabled) {
    color: var(--foreground);
}

.ag-ast-session-rename-row {
    display: flex;
    align-items: center;
    gap: 4px;
    width: 100%;
    min-width: 0;
    padding: 4px 0;
}

.ag-ast-session-rename-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 38px;
    padding: 4px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--primary);
    background: var(--content);
    color: var(--foreground);
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary) 18%, transparent);
}

.ag-ast-session-footer {
    flex-shrink: 0;
    padding: 10px;
    border-top: 1px solid var(--border);
    background: var(--sidebar);
}

/* Main Assistant Thread & Bubbles */
.ag-ast-thread {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 14px 14px 38px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    background: var(--content);
}

.ag-ast-msg-row {
    display: flex;
    min-width: 0;
}

.ag-ast-msg-row-user {
    justify-content: flex-end;
}

.ag-ast-msg-row-assistant {
    justify-content: flex-start;
}

.ag-ast-msg-col {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.ag-ast-msg-col-user {
    align-items: flex-end;
    max-width: min(86%, 760px);
}

.ag-ast-msg-col-user.ag-ast-msg-col-editing {
    width: min(86%, 760px);
}

.ag-ast-msg-col-assistant {
    align-items: flex-start;
    width: 100%;
    max-width: 96%;
}

.ag-ast-bubble-user {
    max-width: 100%;
    min-width: 0;
    padding: 9px 12px;
    border-radius: 16px 4px 16px 16px;
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--primary) 35%, transparent);
    color: var(--foreground);
    font-size: 13px;
    line-height: 1.55;
    word-break: break-word;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ag-ast-bubble-assistant {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    padding: 10px 12px;
    border-radius: 4px 16px 16px 16px;
    background: var(--card);
    border: 1px solid var(--card-border);
    color: var(--foreground);
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: var(--shadow-sm);
}

/* DeepSeek-style Hover/Tap Below-Message Action Bar & Inline Rewrite Editor */
.ag-ast-msg-actions {
    display: none;
    position: absolute;
    top: 100%;
    z-index: 8;
    padding-top: 3px;
    align-items: center;
    max-width: 100%;
}

.ag-ast-msg-actions-user {
    right: 0;
    justify-content: flex-end;
}

.ag-ast-msg-actions-assistant {
    left: 0;
    justify-content: flex-start;
}

.ag-ast-msg-actions-inner {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-md);
}

@media (hover: hover) and (pointer: fine) {
    .ag-ast-msg-row:hover .ag-ast-msg-actions {
        display: flex;
    }
}

.ag-ast-msg-row:focus-within .ag-ast-msg-actions,
.ag-ast-msg-row[data-actions-open="true"] .ag-ast-msg-actions {
    display: flex;
}

.ag-ast-action-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    padding: 0;
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.84;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-ast-action-btn:hover:not(:disabled) {
    background: var(--secondary);
    color: var(--foreground);
    opacity: 1;
}

.ag-ast-action-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 35%, transparent);
    opacity: 1;
}

.ag-ast-action-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
}

/* Multimodal Attachments inside User Bubbles */
.ag-ast-msg-attachments {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
}

.ag-ast-att-image-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--content);
    overflow: hidden;
    cursor: pointer;
    align-self: flex-start;
}

.ag-ast-att-image {
    display: block;
    max-width: min(260px, 100%);
    max-height: 200px;
    object-fit: cover;
}

.ag-ast-att-media-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    min-width: 0;
    max-width: 100%;
}

.ag-ast-att-media-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--muted-foreground);
    min-width: 0;
}

.ag-ast-att-media-name {
    font-weight: 600;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-att-audio {
    width: 100%;
    max-width: 100%;
    height: 36px;
}

.ag-ast-att-video {
    width: 100%;
    max-width: 100%;
    max-height: 220px;
    border-radius: var(--radius-md);
    background: #000000;
    display: block;
}

.ag-ast-att-file-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--card);
    font-size: 12px;
    color: var(--foreground);
    max-width: 100%;
    min-width: 0;
}

.ag-ast-edit-att-hint {
    font-size: 11px;
    color: var(--muted-foreground);
}

.ag-ast-edit-box {
    width: 100%;
    min-width: 0;
    padding: 10px;
    border-radius: var(--radius-xl);
    border: 1px solid var(--primary);
    background: var(--card);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: var(--shadow-sm);
}

.ag-ast-edit-textarea {
    width: 100%;
    min-height: 84px;
    max-height: 320px;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-size: 16px;
    line-height: 1.5;
    resize: vertical;
    outline: none;
}

.ag-ast-edit-textarea:focus {
    border-color: var(--primary);
}

.ag-ast-edit-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
}

.ag-ast-bubble-content {
    line-height: 1.6;
    color: var(--foreground);
    word-break: break-word;
    white-space: pre-wrap;
}

.ag-ast-bubble-content:not(.ag-ast-bubble-markdown) :not(pre) > code {
    padding: 1px 5px;
    border-radius: var(--radius-xs);
    background: var(--content);
    border: 1px solid var(--card-border);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--primary);
    word-break: break-all;
}

.ag-ast-bubble-markdown {
    white-space: normal;
    min-width: 0;
    max-width: 100%;
}

/* Safe GFM Markdown Content */
.ag-md {
    display: block;
    min-width: 0;
    max-width: 100%;
    font-size: 13px;
    line-height: 1.65;
    color: var(--foreground);
    overflow-wrap: break-word;
    word-break: break-word;
}

.ag-md > :first-child {
    margin-top: 0;
}

.ag-md > :last-child {
    margin-bottom: 0;
}

.ag-md-p {
    margin: 0.5em 0;
    line-height: 1.65;
}

.ag-md-h {
    margin: 0.9em 0 0.45em;
    font-weight: 700;
    line-height: 1.35;
    color: var(--foreground);
    letter-spacing: -0.01em;
}

.ag-md-h1 {
    font-size: 1.35em;
    padding-bottom: 0.25em;
    border-bottom: 1px solid var(--card-border);
}

.ag-md-h2 {
    font-size: 1.22em;
    padding-bottom: 0.2em;
    border-bottom: 1px solid var(--card-border);
}

.ag-md-h3 {
    font-size: 1.12em;
}

.ag-md-h4 {
    font-size: 1.04em;
}

.ag-md-h5,
.ag-md-h6 {
    font-size: 0.96em;
    color: var(--muted-foreground);
}

.ag-md-hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.85em 0;
}

.ag-md-list {
    margin: 0.5em 0;
    padding-left: 1.45em;
    min-width: 0;
}

.ag-md-ul {
    list-style-type: disc;
}

.ag-md-ul .ag-md-ul {
    list-style-type: circle;
}

.ag-md-ul .ag-md-ul .ag-md-ul {
    list-style-type: square;
}

.ag-md-ol {
    list-style-type: decimal;
}

.ag-md-li {
    margin: 0.25em 0;
    min-width: 0;
}

.ag-md-li > .ag-md-p {
    margin: 0.2em 0;
}

.ag-md-li > .ag-md-p:first-child {
    margin-top: 0;
}

.ag-md-li > .ag-md-p:last-child {
    margin-bottom: 0;
}

.ag-md-li > .ag-md-list {
    margin: 0.3em 0 0.2em;
}

.ag-md-task-item {
    list-style-type: none;
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin-left: -1.1em;
}

.ag-md-checkbox {
    margin-top: 3px;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    accent-color: var(--primary);
    cursor: default;
}

.ag-md-task-body {
    flex: 1 1 auto;
    min-width: 0;
}

.ag-md-task-body > :first-child {
    margin-top: 0;
}

.ag-md-task-body > :last-child {
    margin-bottom: 0;
}

.ag-md-blockquote {
    margin: 0.6em 0;
    padding: 6px 12px;
    border-left: 3px solid var(--primary);
    border-radius: 0 8px 8px 0;
    background: color-mix(in srgb, var(--primary) 6%, var(--content));
    color: var(--muted-foreground);
    min-width: 0;
}

.ag-md-blockquote > :first-child {
    margin-top: 0;
}

.ag-md-blockquote > :last-child {
    margin-bottom: 0;
}

.ag-md-inline-code {
    padding: 1px 5px;
    border-radius: var(--radius-xs);
    background: var(--content);
    border: 1px solid var(--card-border);
    font-family: var(--font-mono);
    font-size: 0.88em;
    color: var(--primary);
    overflow-wrap: anywhere;
    word-break: break-word;
}

.ag-md-code-block {
    margin: 0.65em 0;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    overflow: hidden;
    max-width: 100%;
    min-width: 0;
}

.ag-md-code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 40px;
    padding: 0 4px 0 12px;
    background: var(--sidebar);
    border-bottom: 1px solid var(--card-border);
}

.ag-md-code-lang {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    color: var(--muted-foreground);
    text-transform: lowercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-md-code-copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-md-code-copy:hover {
    background: var(--secondary);
    color: var(--foreground);
}

.ag-md-pre {
    margin: 0;
    padding: 10px 12px;
    max-width: 100%;
    overflow-x: auto;
    background: var(--content);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--foreground);
    white-space: pre;
    tab-size: 4;
}

.ag-md-pre code {
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: inherit;
    word-break: normal;
    overflow-wrap: normal;
}

.ag-md-table-wrap {
    margin: 0.65em 0;
    max-width: 100%;
    min-width: 0;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--content);
}

.ag-md-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
    line-height: 1.5;
}

.ag-md-table th,
.ag-md-table td {
    padding: 7px 10px;
    border-bottom: 1px solid var(--card-border);
    border-right: 1px solid var(--card-border);
    text-align: left;
    vertical-align: top;
}

.ag-md-table th:last-child,
.ag-md-table td:last-child {
    border-right: none;
}

.ag-md-table tbody tr:last-child td {
    border-bottom: none;
}

.ag-md-table thead th {
    background: var(--sidebar);
    color: var(--foreground);
    font-weight: 600;
    border-bottom: 1px solid var(--border);
}

.ag-md-table tbody tr:nth-child(even) {
    background: color-mix(in srgb, var(--secondary) 35%, transparent);
}

.ag-md-strong {
    font-weight: 600;
    color: var(--foreground);
}

.ag-md-em {
    font-style: italic;
}

.ag-md-del {
    text-decoration: line-through;
    color: var(--muted-foreground);
}

.ag-md-link {
    color: var(--primary);
    text-decoration: underline;
    text-underline-offset: 2px;
    word-break: break-word;
}

.ag-md-link:hover {
    opacity: 0.85;
}

.ag-md-img {
    display: block;
    max-width: min(100%, 420px);
    max-height: 320px;
    height: auto;
    margin: 0.5em 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    object-fit: contain;
}

.ag-ast-bubble-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted-foreground);
    padding-top: 2px;
}

@keyframes ag-ast-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
}

.ag-ast-streaming-cursor {
    display: inline-block;
    width: 6px;
    height: 14px;
    margin-left: 2px;
    vertical-align: middle;
    background: var(--primary);
    border-radius: 1px;
    animation: ag-ast-pulse 1s ease-in-out infinite;
}

/* Activity timeline (per-round think -> preface -> tools); design: activity-timeline */
.ag-ast-tl {
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.ag-ast-tl-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.ag-ast-tl-summary {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 -8px;
    padding: 4px 8px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    line-height: 20px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-tl-summary:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-ast-tl-status {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
}

.ag-ast-tl-status[data-tone="ok"] {
    color: var(--success);
}

.ag-ast-tl-status[data-tone="warning"] {
    color: var(--warning);
}

.ag-ast-tl-status[data-tone="live"] {
    color: var(--primary);
}

.ag-ast-tl-headline {
    flex-shrink: 0;
    color: var(--foreground);
    font-weight: 500;
    white-space: nowrap;
}

.ag-ast-tl-headline-detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
}

.ag-ast-tl-meta {
    flex-shrink: 0;
    font-size: 12px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.ag-ast-tl-badge {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    line-height: 16px;
    font-weight: 500;
}

.ag-ast-tl-badge[data-tone="error"] {
    color: var(--error);
    background: color-mix(in srgb, var(--error) 12%, transparent);
}

.ag-ast-tl-chevron {
    flex-shrink: 0;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    color: var(--subtle-foreground);
    transition: transform var(--dur) var(--ease);
}

.ag-ast-tl-chevron[data-open="true"] {
    transform: rotate(90deg);
}

.ag-ast-tl-undo {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 40px;
    min-width: 40px;
    padding: 0 8px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 12px;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-tl-undo:hover:not(:disabled) {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    color: var(--warning);
}

.ag-ast-tl-undo:disabled {
    cursor: default;
    opacity: 0.7;
}

.ag-ast-tl-undo[data-reverted="true"] {
    color: var(--success);
}

/* Steps rail */
.ag-ast-tl-steps {
    list-style: none;
    margin: 2px 0 4px;
    padding: 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.ag-ast-tl-step {
    position: relative;
    display: flex;
    gap: 10px;
    padding-bottom: 6px;
    min-width: 0;
}

.ag-ast-tl-step:last-child {
    padding-bottom: 4px;
}

.ag-ast-tl-step::before {
    content: "";
    position: absolute;
    left: 9px;
    top: 31px;
    bottom: 0;
    width: 1px;
    background: var(--border);
}

.ag-ast-tl-step:last-child::before {
    display: none;
}

.ag-ast-tl-node {
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    width: 19px;
    height: 19px;
    margin-top: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}

.ag-ast-tl-step[data-error="true"] .ag-ast-tl-node {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 50%, transparent);
}

.ag-ast-tl-step[data-live="true"] .ag-ast-tl-node {
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
}

.ag-ast-tl-step-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ag-ast-tl-step-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    min-height: 40px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
}

.ag-ast-tl-step-head:disabled {
    cursor: default;
}

.ag-ast-tl-step-head:not(:disabled):hover .ag-ast-tl-step-title {
    color: var(--primary);
}

.ag-ast-tl-step-title {
    min-width: 0;
    font-size: 13px;
    line-height: 20px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--dur-fast) var(--ease);
}

.ag-ast-tl-step-time {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 12px;
    color: var(--subtle-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.ag-ast-tl-think {
    font-size: 13px;
    line-height: 20px;
    color: var(--muted-foreground);
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-ast-tl-think[data-clamped="true"] {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}

/* Live reasoning: fixed 3-line tail window, older lines fade out at the top */
.ag-ast-tl-live-think {
    max-height: 60px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, var(--foreground) 45%);
    mask-image: linear-gradient(to bottom, transparent 0, var(--foreground) 45%);
}

.ag-ast-tl-live-think-inner {
    font-size: 13px;
    line-height: 20px;
    color: var(--muted-foreground);
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-ast-tl-preface {
    margin-top: 2px;
    font-size: 13px;
    line-height: 20px;
    color: var(--foreground);
}

.ag-ast-tl-preface > :first-child {
    margin-top: 0;
}

.ag-ast-tl-preface > :last-child {
    margin-bottom: 0;
}

/* Tool rows: borderless single lines; only the expanded detail is a surface */
.ag-ast-tl-tools {
    display: flex;
    flex-direction: column;
    margin: 0 0 0 -6px;
    min-width: 0;
}

.ag-ast-tl-tool,
.ag-ast-tl-group {
    min-width: 0;
}

.ag-ast-tl-tool-line {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.ag-ast-tl-tool-row {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--foreground);
    font-size: 13px;
    line-height: 20px;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease);
}

.ag-ast-tl-tool-row:hover:not(:disabled) {
    background: var(--hover);
}

.ag-ast-tl-tool-row:disabled {
    cursor: default;
}

.ag-ast-tl-tool-icon {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    color: var(--muted-foreground);
}

.ag-ast-tl-tool[data-state="error"] .ag-ast-tl-tool-icon {
    color: var(--error);
}

.ag-ast-tl-tool-verb {
    flex-shrink: 0;
    font-weight: 500;
    white-space: nowrap;
}

.ag-ast-tl-tool-count {
    margin-left: 4px;
    font-weight: 400;
    color: var(--muted-foreground);
}

.ag-ast-tl-tool-arg {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--muted-foreground);
}

.ag-ast-tl-tool-meta {
    flex-shrink: 0;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--subtle-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
}

.ag-ast-tl-dot {
    width: 6px;
    height: 6px;
    border-radius: 9999px;
    background: var(--success);
}

.ag-ast-tl-dot[data-state="error"] {
    background: var(--error);
}

.ag-ast-tl-dot[data-state="pending"] {
    background: var(--subtle-foreground);
}

.ag-ast-tl-tool-nested .ag-ast-tl-tool-row {
    padding-left: 22px;
}

.ag-ast-tl-group-children {
    display: flex;
    flex-direction: column;
    min-width: 0;
}

.ag-ast-tl-tool-detail {
    margin: 2px 0 6px 28px;
    padding: 8px;
    border-radius: var(--radius-md);
    background: var(--content);
    border: 1px solid var(--card-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.ag-ast-tl-tool-detail-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    color: var(--muted-foreground);
}

.ag-ast-tl-tool-detail .ag-ast-tool-pre {
    max-height: 240px;
    overflow-y: auto;
    background: var(--card);
}

.ag-ast-tool-pre[data-tone="error"] {
    color: var(--error);
}

/* Live indicators */
.ag-ast-tl-spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--primary) 30%, transparent);
    border-top-color: var(--primary);
    animation: ag-ast-tl-spin 0.9s linear infinite;
}

@keyframes ag-ast-tl-spin {
    to {
        transform: rotate(360deg);
    }
}

.ag-ast-tl-shimmer {
    background: linear-gradient(
        90deg,
        var(--muted-foreground) 0%,
        var(--foreground) 50%,
        var(--muted-foreground) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: ag-ast-tl-shimmer 1.6s linear infinite;
}

@keyframes ag-ast-tl-shimmer {
    from {
        background-position: 200% 0;
    }
    to {
        background-position: -200% 0;
    }
}

@media (prefers-reduced-motion: reduce) {
    .ag-ast-tl-shimmer {
        background: none;
        color: inherit;
    }
}

@media (max-width: 767px) {
    .ag-ast-tl-summary {
        min-height: 40px;
        flex-wrap: wrap;
        row-gap: 0;
    }

    .ag-ast-tl-tool-row {
        min-height: 40px;
        flex-wrap: wrap;
        row-gap: 0;
    }

    .ag-ast-tl-tool-arg {
        flex-basis: 100%;
        order: 10;
        padding-left: 24px;
    }

    .ag-ast-tl-undo {
        min-height: 40px;
        min-width: 40px;
        justify-content: center;
    }

    .ag-ast-tl-tool-detail {
        margin-left: 6px;
    }

    .ag-ast-tl-tool-detail .ag-ast-tool-pre {
        max-height: 40dvh;
    }
}

.ag-ast-tool-pre {
    margin: 0;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: var(--content);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
}

/* Referenced-file strip (design spec §3.15): inline <= 2, else one collapsible summary row */
.ag-ast-file-refs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.ag-ast-file-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    padding: 0 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--card-border);
    background: transparent;
    color: var(--foreground);
    font-family: var(--font-mono);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-ast-file-chip:hover {
    background: var(--hover);
    border-color: var(--border);
}

.ag-ast-file-chip-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--subtle-foreground);
}

.ag-ast-file-chip:hover .ag-ast-file-chip-icon {
    color: var(--primary);
}

.ag-ast-file-chip-dir {
    flex: 0 100 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--subtle-foreground);
}

.ag-ast-file-chip-name {
    flex: 0 1 auto;
    min-width: 3em;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ag-ast-file-refs-collapsible {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    border: 1px solid var(--card-border);
    border-radius: var(--radius-lg);
    overflow: hidden;
}

.ag-ast-file-refs-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px 0 12px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-file-refs-toggle:hover {
    background: var(--hover);
    color: var(--foreground);
}

.ag-ast-file-refs-toggle-icon,
.ag-ast-file-refs-chevron {
    display: inline-flex;
    flex-shrink: 0;
}

.ag-ast-file-refs-toggle-icon {
    color: var(--primary);
}

.ag-ast-file-refs-count {
    flex-shrink: 0;
    font-weight: 500;
    color: var(--foreground);
}

.ag-ast-file-refs-preview {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtle-foreground);
}

.ag-ast-file-refs-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 232px;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 6px;
    border-top: 1px solid var(--card-border);
    background: var(--content);
}

.ag-ast-file-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ag-ast-file-group-label {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--subtle-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-ast-file-group-count {
    flex-shrink: 0;
    padding: 0 6px;
    border-radius: 9999px;
    background: var(--secondary);
    color: var(--muted-foreground);
    font-family: var(--font-sans);
    font-variant-numeric: tabular-nums;
}

.ag-ast-file-group-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 2px;
    min-width: 0;
}

.ag-ast-file-group-grid .ag-ast-file-chip {
    width: 100%;
    border-color: transparent;
}

.ag-ast-file-group-grid .ag-ast-file-chip:hover {
    border-color: transparent;
}

/* Inline Bubble Approval Card & Collapsed Single-Line Approval Badge */
.ag-ast-approvals-wrap {
    padding-top: 8px;
    margin-top: 2px;
    border-top: 1px solid var(--card-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ag-ast-approval-card {
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ag-ast-approval-medium {
    border-color: color-mix(in srgb, var(--warning) 60%, transparent);
}

.ag-ast-approval-high {
    border-color: color-mix(in srgb, var(--error) 65%, transparent);
}

.ag-ast-approval-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ag-ast-approval-title-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
}

.ag-ast-approval-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-approval-view-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--sidebar);
    border: 1px solid var(--border);
    flex-shrink: 0;
}

.ag-ast-approval-view-tab {
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
}

.ag-ast-approval-view-tab-active {
    background: var(--card);
    color: var(--foreground);
    font-weight: 600;
    box-shadow: var(--shadow-xs), 0 0 0 1px var(--border);
}

.ag-ast-approval-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 2px;
}

.ag-ast-approval-tool {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-approval-btn-group {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.ag-ast-approval-collapsed {
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    padding: 4px 8px 4px 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
    min-height: 44px;
}

.ag-ast-approval-collapsed-approved {
    border-color: color-mix(in srgb, var(--success) 42%, transparent);
}

.ag-ast-approval-collapsed-rejected {
    border-color: color-mix(in srgb, var(--error) 42%, transparent);
}

.ag-ast-approval-collapsed-reverted {
    border-color: color-mix(in srgb, var(--warning) 42%, transparent);
}

.ag-ast-approval-collapsed-label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 12px;
    font-weight: 500;
}

.ag-ast-approval-collapsed-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-approval-collapsed-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

/* Unified Bottom Composer & Mode/Model Popovers */
.ag-ast-composer-wrap {
    flex-shrink: 0;
    position: relative;
    background: var(--content);
    padding: 4px 14px 14px;
}

.ag-ast-composer-box {
    border-radius: 22px;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 8px 8px 4px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ag-ast-composer-box:focus-within {
    border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
    box-shadow: var(--shadow-sm), 0 0 0 3px color-mix(in srgb, var(--primary) 12%, transparent);
}

.ag-ast-composer-box-dragover {
    border-style: dashed;
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, var(--content));
}

.ag-ast-drop-hint {
    padding: 6px 10px;
    border-radius: var(--radius-lg);
    border: 1px dashed color-mix(in srgb, var(--primary) 55%, transparent);
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    color: var(--primary);
    font-size: 12px;
    font-weight: 600;
    text-align: center;
}

.ag-ast-pending-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-bottom: 4px;
    max-width: 100%;
}

.ag-ast-pending-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 4px 4px 6px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    max-width: min(260px, 100%);
    min-width: 0;
}

.ag-ast-pending-thumb {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    object-fit: cover;
    flex-shrink: 0;
}

.ag-ast-pending-icon {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--content);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    flex-shrink: 0;
}

.ag-ast-pending-meta {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1 1 auto;
}

.ag-ast-pending-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ag-ast-pending-size {
    font-size: 11px;
    color: var(--muted-foreground);
}

.ag-ast-pending-remove {
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
}

.ag-ast-pending-remove:hover {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
}

.ag-ast-composer-right {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
}

/*
 * Composer controls keep a 40x40 hit area (design-system red line) while the
 * visible face is smaller: a transparent border + padding-box background clip
 * shrinks the painted area without shrinking the clickable box.
 */
.ag-ast-upload-btn {
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    flex-shrink: 0;
    border: 4px solid transparent;
    border-radius: 999px;
    background-color: transparent;
    background-clip: padding-box;
    color: var(--muted-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-ast-upload-btn:hover:not(:disabled) {
    background-color: var(--hover);
    color: var(--foreground);
}

.ag-ast-upload-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.ag-ast-composer-input {
    width: 100%;
    min-height: 28px;
    max-height: 160px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 16px;
    line-height: 1.45;
    resize: none;
    outline: none;
    padding: 4px 8px 2px;
}

.ag-ast-composer-input::placeholder {
    color: var(--subtle-foreground);
}

.ag-ast-composer-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ag-ast-composer-left {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
}

/* Compact chips: 40px tall hit area, 28px visible pill. */
.ag-ast-mode-btn,
.ag-ast-model-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-style: solid;
    border-color: transparent;
    border-width: 6px 0;
    border-radius: 999px;
    background-clip: padding-box;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease);
}

.ag-ast-mode-btn {
    flex-shrink: 0;
    font-weight: 600;
}

.ag-ast-mode-btn:hover {
    filter: brightness(1.06);
}

.ag-ast-model-btn {
    max-width: 100%;
    overflow: hidden;
}

.ag-ast-model-btn:not(.ag-pill-primary) {
    background-color: transparent;
    color: var(--muted-foreground);
}

.ag-ast-model-btn:not(.ag-pill-primary):hover {
    background-color: var(--hover);
    color: var(--foreground);
}

.ag-ast-chip-icon {
    opacity: 0.85;
}

.ag-ast-chip-caret {
    opacity: 0.6;
    margin-left: -1px;
}

.ag-ast-model-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

/* Send / stop: 40px hit area, 32px round face. */
.ag-ast-send-btn,
.ag-ast-stop-btn {
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    flex-shrink: 0;
    border: 4px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease);
}

.ag-ast-send-btn {
    background-color: var(--primary);
    color: var(--primary-foreground);
}

.ag-ast-send-btn[data-empty="true"] {
    background-color: var(--secondary);
    color: var(--subtle-foreground);
}

.ag-ast-stop-btn {
    background-color: var(--foreground);
    color: var(--card);
}

.ag-ast-send-btn:hover:not(:disabled),
.ag-ast-stop-btn:hover:not(:disabled) {
    filter: brightness(1.1);
}

.ag-ast-send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

/*
 * Landing (no active session): hero + composer float around the vertical
 * centre like ChatGPT / Claude / Gemini new-chat screens. The thread and a
 * trailing spacer share the free space; the composer keeps its natural height.
 */
.ag-ast-root-landing .ag-ast-thread {
    flex: 1 1 0;
    padding-bottom: 20px;
}

.ag-ast-landing-hero {
    margin: auto auto 0;
    min-height: 0;
    padding: 24px 16px 0;
    gap: 10px;
}

.ag-ast-landing-mark {
    width: 40px;
    height: 40px;
    border-radius: var(--radius-lg);
    background: var(--primary-soft);
    color: var(--primary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 2px;
}

.ag-ast-landing-hero .ag-empty-title {
    font-size: 20px;
    font-weight: 600;
    letter-spacing: 0.01em;
}

.ag-ast-landing-hero .ag-empty-desc {
    font-size: 13px;
    max-width: 440px;
}

.ag-ast-root-landing .ag-ast-composer-wrap {
    width: 100%;
    max-width: 720px;
    margin: 0 auto;
    padding: 0 16px;
    background: transparent;
}

.ag-ast-root-landing .ag-ast-composer-box {
    padding: 10px 8px 4px;
}

.ag-ast-root-landing .ag-ast-composer-input {
    min-height: 52px;
}

.ag-ast-landing-spacer {
    flex: 1.35 1 0;
    min-height: 16px;
}

.ag-ast-popover-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: color-mix(in srgb, var(--background) 55%, transparent);
}

.ag-ast-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 12px;
    width: min(340px, calc(100% - 24px));
    max-height: var(--ag-ast-popover-max, min(430px, 65vh));
    z-index: 30;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-lg);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    font-size: 12px;
}

.ag-ast-composer-wrap[data-popover-dir="down"] .ag-ast-popover {
    bottom: auto;
    top: calc(100% + 8px);
}

.ag-ast-popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
    font-weight: 600;
}

.ag-ast-popover-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ag-ast-popover-option {
    width: 100%;
    min-height: 44px;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-ast-popover-option:hover {
    background: var(--secondary);
}

.ag-ast-popover-option-active {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--primary) 55%, transparent);
}

.ag-ast-popover-option-desc {
    font-size: 11px;
    color: var(--muted-foreground);
    margin-top: 2px;
    line-height: 1.4;
}

.ag-ast-popover-checkbox-row {
    min-height: 44px;
    padding: 8px 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    cursor: pointer;
    user-select: none;
}

.ag-ast-popover-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-top: 6px;
    border-top: 1px solid var(--card-border);
}

/* Undo Snapshot History List (Modal / Drawer) */
.ag-undo-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}

.ag-undo-item {
    padding: 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ag-undo-item-reverted {
    border-color: var(--card-border);
    opacity: 0.68;
}

.ag-undo-item-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
}

.ag-undo-diff-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    font-size: 11px;
}

.ag-undo-before,
.ag-undo-after {
    padding: 6px 8px;
    border-radius: var(--radius-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-undo-before {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--error) 28%, transparent);
    color: var(--error);
}

.ag-undo-after {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 28%, transparent);
    color: var(--success);
}

/* ========================================================================= */
/* SideGen Console Views (TS2.3 / TS3.2) — Clues / Sessions / SDK Playground */
/* ========================================================================= */

.ag-side-root {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    background: var(--content);
}

.ag-side-subbar {
    flex-shrink: 0;
    min-height: 52px;
    padding: 6px 12px 6px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--content);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ag-side-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-lg);
    background: var(--content);
    border: 1px solid var(--border);
    max-width: 100%;
    overflow-x: auto;
}

.ag-side-tab {
    flex-shrink: 0;
    min-width: 40px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: var(--radius-sm);
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-side-tab:hover:not(.ag-side-tab-active) {
    color: var(--foreground);
}

.ag-side-tab-active {
    background: var(--card);
    color: var(--foreground);
    font-weight: 600;
    box-shadow: var(--shadow-xs), 0 0 0 1px var(--border);
}

.ag-side-subbar-hint {
    font-size: 11px;
    color: var(--muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-side-content {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.ag-side-clue-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--border);
}

.ag-side-keyword-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.ag-side-session-card {
    padding: 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--content);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ag-side-session-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
}

.ag-side-session-stats {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted-foreground);
}

.ag-side-transcript-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.ag-side-transcript-item {
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--card-border);
    background: var(--content);
    font-size: 12px;
    line-height: 1.55;
    word-break: break-word;
}

.ag-side-transcript-user {
    border-color: color-mix(in srgb, var(--primary) 35%, transparent);
    background: color-mix(in srgb, var(--primary) 10%, transparent);
}

.ag-side-sdk-output {
    padding: 12px;
    border-radius: var(--radius-lg);
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success);
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-banner {
    --ag-banner-tone: var(--muted-foreground);
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    border: none;
    background: var(--secondary);
    color: var(--foreground);
    box-shadow: inset 3px 0 0 var(--ag-banner-tone);
    font-size: 12px;
    line-height: 1.6;
}

.ag-banner-primary {
    --ag-banner-tone: var(--primary);
    background: color-mix(in srgb, var(--primary) 9%, transparent);
}

.ag-banner-success {
    --ag-banner-tone: var(--success);
    background: color-mix(in srgb, var(--success) 9%, transparent);
}

.ag-banner-warning {
    --ag-banner-tone: var(--warning);
    background: color-mix(in srgb, var(--warning) 10%, transparent);
}

.ag-banner-error {
    --ag-banner-tone: var(--error);
    background: color-mix(in srgb, var(--error) 9%, transparent);
}

.ag-progress-track {
    position: relative;
    height: 6px;
    border-radius: 9999px;
    background: var(--secondary);
    border: none;
    overflow: hidden;
}

.ag-progress-fill {
    height: 100%;
    border-radius: 9999px;
    background: var(--primary);
    transition: width var(--dur) var(--ease);
}

.ag-progress-marker {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--warning);
}

/* Remote Model Picker (ConnectionsView) */
.ag-model-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
}

.ag-model-picker-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
}

.ag-model-picker-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 240px;
    overflow-y: auto;
    overflow-x: hidden;
    min-width: 0;
}

.ag-model-option {
    width: 100%;
    min-width: 40px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-model-option:hover {
    background: var(--secondary);
}

.ag-model-option-active {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, var(--content));
}

.ag-model-option-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.ag-model-option-id {
    font-size: 13px;
    font-weight: 600;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-model-option-sub {
    font-size: 11px;
    color: var(--muted-foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-model-option-meta {
    flex-shrink: 0;
    max-width: 48%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
}

.ag-model-option-meta .ag-badge {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ag-model-option-check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--primary);
    flex-shrink: 0;
}

.ag-model-picker-empty,
.ag-model-picker-more {
    padding: 8px 4px;
    font-size: 12px;
    color: var(--muted-foreground);
    text-align: center;
}

/* Prompt Trigger Picker */
.ag-trigger-picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ag-trigger-picker-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 40px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--content);
}

.ag-trigger-picker-chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    flex: 1 1 200px;
    min-width: 0;
}

.ag-trigger-picker-placeholder {
    font-size: 12px;
    color: var(--muted-foreground);
    line-height: 1.4;
}

.ag-trigger-chip {
    cursor: pointer;
    font-family: inherit;
    transition: opacity var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}

.ag-trigger-chip:hover {
    opacity: 0.85;
}

.ag-trigger-chip-x {
    font-size: 13px;
    line-height: 1;
    opacity: 0.75;
    margin-left: 2px;
}

.ag-trigger-picker-actions {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
}

.ag-trigger-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border);
    background: var(--card);
    max-height: 280px;
    overflow-y: auto;
}

.ag-trigger-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}

.ag-trigger-group-title {
    font-size: 11px;
    font-weight: 700;
    color: var(--muted-foreground);
    letter-spacing: 0.02em;
}

.ag-trigger-options {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(175px, 1fr));
    gap: 6px;
}

.ag-trigger-option {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
    transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}

.ag-trigger-option:hover {
    border-color: color-mix(in srgb, var(--primary) 55%, var(--border));
}

.ag-trigger-option-active {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 12%, var(--content));
}

.ag-trigger-option-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    width: 100%;
    min-width: 0;
}

.ag-trigger-option-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--foreground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-trigger-option-active .ag-trigger-option-label {
    color: var(--primary);
}

.ag-trigger-option-check {
    display: inline-flex;
    align-items: center;
    color: var(--primary);
    flex-shrink: 0;
}

.ag-trigger-option-desc {
    font-size: 11px;
    color: var(--muted-foreground);
    line-height: 1.35;
}

/* Generation Logs — Accordion Tool Steps & Focused Step Card */
.ag-log-run-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}

.ag-log-run-superseded {
    opacity: 0.66;
}

.ag-log-run-superseded:hover,
.ag-log-run-superseded.ag-list-item-active {
    opacity: 1;
}

.ag-log-run-steps-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
}

.ag-log-steps-chevron {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    color: var(--subtle-foreground);
    transition: transform var(--dur) var(--ease), color var(--dur-fast) var(--ease);
}

.ag-log-steps-chevron[data-open="true"] {
    transform: rotate(90deg);
    color: var(--foreground);
}

.ag-log-step-branch {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-left: 10px;
    padding-left: 10px;
    border-left: 2px solid var(--border);
    min-width: 0;
}

.ag-log-step-item {
    width: 100%;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    overflow: hidden;
    text-align: left;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 12px;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.ag-log-step-item:hover {
    background: var(--hover);
}

.ag-log-step-item-active,
.ag-log-step-item-active:hover {
    background: var(--primary-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent);
}

.ag-log-step-name {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-log-step-meta {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
}

.ag-log-step-duration {
    font-size: 11px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
}

.ag-log-step-card {
    scroll-margin-top: 12px;
    transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}

.ag-log-step-card-focused {
    border-color: var(--primary);
    box-shadow: 0 0 0 2px var(--primary-soft);
}

/* Mobile First-Class Breakpoint (< 768px) */
@media (max-width: 767px) {
    .ag-console {
        width: 100vw;
        max-width: 100vw;
        height: 100%;
        border-radius: 0;
        border: none;
        box-shadow: none;
        overflow-x: hidden;
        padding-top: env(safe-area-inset-top, 0px);
        padding-bottom: env(safe-area-inset-bottom, 0px);
        padding-left: env(safe-area-inset-left, 0px);
        padding-right: env(safe-area-inset-right, 0px);
    }

    .ag-header {
        padding: 8px 8px 6px 12px;
        gap: 6px 8px;
        min-height: 0;
    }

    .ag-brand {
        flex: 1 1 auto;
    }

    .ag-isolation-pill {
        display: none;
    }

    .ag-header-controls {
        display: contents;
    }

    .ag-header-actions {
        order: 1;
        flex-wrap: nowrap;
    }

    .ag-header-actions .ag-header-import-btn .ag-btn-label {
        display: none;
    }

    .ag-header-divider {
        display: none;
    }

    .ag-runmode {
        order: 2;
        flex: 1 1 100%;
    }

    .ag-runmode .ag-segmented-item {
        flex: 1 1 0;
    }

    .ag-header-select-wrap {
        order: 3;
        flex: 1 1 100%;
        flex-wrap: wrap;
        padding: 0;
    }

    .ag-ctx-select {
        flex: 1 1 140px;
        min-width: 0;
    }

    .ag-ctx-select .ag-select.ag-header-select,
    .ag-header-select {
        flex: 1 1 140px;
        width: 100%;
        min-width: 0;
        max-width: 100%;
    }

    .ag-body {
        padding: 0;
    }

    .ag-main {
        border-radius: 0;
        border: none;
        border-top: 1px solid var(--border);
        box-shadow: none;
    }

    .ag-sidebar {
        display: none;
    }

    .ag-mobile-nav {
        display: flex;
    }

    .ag-view-scroll {
        padding: 12px;
    }

    .ag-card-body {
        padding: 12px;
    }

    .ag-card-header {
        padding: 12px;
    }

    .ag-toolbar {
        padding: 8px 12px;
    }

    .ag-modal-body {
        padding: 16px;
    }

    .ag-modal-footer {
        padding: 10px 16px;
    }

    .ag-grid-2,
    .ag-grid-3,
    .ag-grid-4,
    .ag-undo-diff-grid {
        grid-template-columns: minmax(0, 1fr);
    }

    .ag-ast-topbar {
        padding: 4px 8px;
        gap: 6px;
    }

    .ag-ast-topbar-right {
        gap: 4px;
    }

    .ag-ast-token-pill {
        padding: 0 8px;
        min-width: 40px;
        min-height: 40px;
    }

    .ag-ast-compaction-rule {
        display: none;
    }

    .ag-ast-compaction-pill {
        border-radius: var(--radius-xl);
        padding: 8px 12px;
    }

    .ag-ast-overflow-btn,
    .ag-ast-continue-btn {
        min-width: 40px;
        min-height: 40px;
    }

    .ag-ast-title-rename-btn {
        width: 40px;
        height: 40px;
        min-width: 40px;
        min-height: 40px;
    }

    .ag-ast-title-edit {
        max-width: 100%;
    }

    .ag-ast-thread {
        padding: 10px;
        gap: 10px;
    }

    .ag-ast-bubble-assistant {
        max-width: 100%;
    }

    .ag-ast-msg-col-assistant {
        max-width: 100%;
    }

    .ag-ast-msg-col-user {
        max-width: 92%;
    }

    .ag-ast-msg-col-user.ag-ast-msg-col-editing {
        width: 100%;
        max-width: 100%;
    }

    .ag-ast-msg-actions {
        position: static;
        padding-top: 4px;
        flex-wrap: wrap;
    }

    .ag-ast-msg-actions-inner {
        flex-wrap: wrap;
    }

    .ag-ast-action-btn {
        width: auto;
        height: auto;
        min-width: 40px;
        min-height: 40px;
        padding: 0 8px;
        font-size: 15px;
    }

    .ag-ast-composer-wrap {
        padding: 2px 8px 8px;
    }

    .ag-ast-root-landing .ag-ast-composer-wrap {
        padding: 0 10px;
    }

    .ag-ast-landing-hero .ag-empty-title {
        font-size: 18px;
    }

    .ag-toast-container {
        top: calc(env(safe-area-inset-top, 0px) + 56px);
        max-width: calc(100% - 24px);
    }

    .ag-ast-popover {
        left: 8px;
        right: 8px;
        width: auto;
    }

    .ag-side-subbar {
        padding: 6px 8px;
    }

    .ag-side-subbar-hint {
        display: none;
    }

    .ag-modal-backdrop {
        padding: 10px;
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
    }

    button,
    [role="switch"],
    [role="radio"],
    .ag-touch-target {
        min-width: 40px;
        min-height: 40px;
    }

    .ag-trigger-options {
        grid-template-columns: minmax(0, 1fr);
    }

    .ag-trigger-chip {
        padding: 4px 10px;
    }

    input,
    select,
    textarea {
        font-size: 16px;
    }
}
`;
