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
#agentic-app[open] {
    display: flex !important;
    flex-direction: column !important;
}
#agentic-app::backdrop {
    background: rgba(8, 10, 14, 0.65) !important;
    backdrop-filter: blur(4px) !important;
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
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif !important;
    font-size: 14px !important;
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
:host {
    all: initial;
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    --background: #14161b;
    --sidebar: #1b1e25;
    --content: #101216;
    --card: #20242c;
    --border: #2f3542;
    --card-border: #2a303c;
    --foreground: #e6e9ef;
    --muted-foreground: #9aa3b2;
    --primary: #6c8cff;
    --primary-foreground: #ffffff;
    --secondary: #2a303c;
    --secondary-foreground: #e6e9ef;
    --success: #34d399;
    --warning: #fbbf24;
    --error: #f87171;
    color-scheme: dark;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--foreground);
    -webkit-font-smoothing: antialiased;
}

:host([data-theme="dark"]) {
    --background: #14161b;
    --sidebar: #1b1e25;
    --content: #101216;
    --card: #20242c;
    --border: #2f3542;
    --card-border: #2a303c;
    --foreground: #e6e9ef;
    --muted-foreground: #9aa3b2;
    --primary: #6c8cff;
    --primary-foreground: #ffffff;
    --secondary: #2a303c;
    --secondary-foreground: #e6e9ef;
    --success: #34d399;
    --warning: #fbbf24;
    --error: #f87171;
    color-scheme: dark;
}

:host([data-theme="light"]) {
    --background: #f4f6fa;
    --sidebar: #eef1f6;
    --content: #f8fafc;
    --card: #ffffff;
    --border: #dbe1eb;
    --card-border: #e5eaf2;
    --foreground: #181c24;
    --muted-foreground: #5f697a;
    --primary: #3b66f5;
    --primary-foreground: #ffffff;
    --secondary: #e8edf5;
    --secondary-foreground: #181c24;
    --success: #10b981;
    --warning: #d97706;
    --error: #dc2626;
    color-scheme: light;
}

:host > [data-agentic-mount] {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--foreground);
}

*, *::before, *::after {
    box-sizing: border-box;
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

.ag-thin-scroll::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}
.ag-thin-scroll::-webkit-scrollbar-track {
    background: transparent;
}
.ag-thin-scroll::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--muted-foreground) 30%, transparent);
    border-radius: 9999px;
}

/* Main Console Frame */
.ag-console {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    color: var(--foreground);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
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
    gap: 8px 12px;
    padding: 10px 14px;
    background: var(--sidebar);
    border-bottom: 1px solid var(--border);
    max-width: 100%;
    overflow-x: hidden;
}

.ag-brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    user-select: none;
}

.ag-brand-logo {
    width: 30px;
    height: 30px;
    border-radius: 8px;
    background: var(--primary);
    color: var(--primary-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.ag-brand-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
    white-space: nowrap;
}

.ag-isolation-pill {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--primary) 10%, transparent);
    border: 1px dashed color-mix(in srgb, var(--primary) 42%, transparent);
    color: var(--primary);
    white-space: nowrap;
}

.ag-header-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 100%;
}

.ag-header-select-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
}

.ag-header-select {
    width: auto;
    min-width: 136px;
    max-width: 210px;
}

.ag-header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
}

.ag-window-toggle-btn {
    padding: 0;
}

/* Mobile Top Horizontal Nav */
.ag-mobile-nav {
    display: none;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    background: var(--content);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
}

.ag-mobile-nav-divider {
    width: 1px;
    height: 22px;
    background: var(--border);
    flex-shrink: 0;
    margin: 0 2px;
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
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--muted-foreground);
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s, color 0.15s, border-color 0.15s;
}

.ag-mobile-tab-active {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: transparent;
}

/* Main Body */
.ag-body {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    overflow: hidden;
}

/* Desktop Left Sidebar */
.ag-sidebar {
    width: 228px;
    flex-shrink: 0;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    padding: 12px 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 16px;
}

.ag-nav-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ag-nav-group-label {
    padding: 0 10px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--muted-foreground);
}

.ag-nav-item {
    width: 100%;
    text-align: left;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 10px;
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-nav-item:hover {
    background: var(--secondary);
}

.ag-nav-item-active {
    background: var(--primary);
    color: var(--primary-foreground);
}

.ag-nav-item-active:hover {
    background: var(--primary);
}

.ag-nav-item-icon {
    margin-top: 2px;
    flex-shrink: 0;
    display: inline-flex;
}

.ag-nav-item-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
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
    font-weight: 600;
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
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
    flex-shrink: 0;
    background: color-mix(in srgb, var(--warning) 18%, transparent);
    color: var(--warning);
    border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent);
}

.ag-nav-count-badge-on-active {
    background: color-mix(in srgb, var(--primary-foreground) 22%, transparent);
    color: var(--primary-foreground);
    border-color: color-mix(in srgb, var(--primary-foreground) 35%, transparent);
}

.ag-nav-item-desc {
    font-size: 11px;
    line-height: 1.3;
    color: var(--muted-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.ag-nav-item-active .ag-nav-item-desc {
    color: color-mix(in srgb, var(--primary-foreground) 85%, transparent);
}

/* Main Content Slot */
.ag-main {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--card);
    overflow: hidden;
}

.ag-view-scroll {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 16px;
}

/* MasterDetailLayout */
.ag-split-layout {
    display: grid;
    grid-template-columns: minmax(230px, 34%) minmax(0, 1fr);
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
}

.ag-split-master {
    min-width: 0;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--sidebar) 55%, var(--card));
    overflow-y: auto;
    overflow-x: hidden;
}

.ag-split-detail {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--card);
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
    gap: 10px;
    padding: 8px 12px;
    background: var(--sidebar);
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

/* Common Controls */
.ag-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    font-size: 13px;
    font-weight: 500;
    line-height: 1.2;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s, border-color 0.15s, opacity 0.15s;
}

.ag-btn-sm {
    padding: 0 10px;
    font-size: 12px;
}

.ag-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.ag-btn-primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: transparent;
}

.ag-btn-primary:hover:not(:disabled) {
    filter: brightness(1.06);
}

.ag-btn-secondary {
    background: var(--content);
    color: var(--foreground);
    border-color: var(--border);
}

.ag-btn-secondary:hover:not(:disabled) {
    background: var(--secondary);
}

.ag-btn-ghost {
    background: transparent;
    color: var(--foreground);
    border-color: transparent;
}

.ag-btn-ghost:hover:not(:disabled) {
    background: var(--secondary);
}

.ag-btn-danger {
    background: color-mix(in srgb, var(--error) 16%, transparent);
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 40%, transparent);
}

.ag-btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--error) 24%, transparent);
}

.ag-btn-active {
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 14%, transparent);
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
    padding: 2px;
    gap: 2px;
    background: var(--content);
    border: 1px solid var(--border);
    border-radius: 10px;
    max-width: 100%;
    overflow-x: auto;
}

.ag-segmented-item {
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s, color 0.15s;
}

.ag-segmented-item-active {
    background: var(--primary);
    color: var(--primary-foreground);
    font-weight: 600;
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
    min-width: 0;
    cursor: pointer;
}

.ag-switch-label {
    font-size: 13px;
    font-weight: 500;
}

.ag-switch-desc {
    font-size: 12px;
    color: var(--muted-foreground);
}

.ag-switch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 48px;
    min-height: 40px;
    padding: 0 4px;
    border: none;
    background: transparent;
    cursor: pointer;
    flex-shrink: 0;
}

.ag-switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.ag-switch-track {
    position: relative;
    width: 42px;
    height: 24px;
    border-radius: 9999px;
    background: var(--secondary);
    border: 1px solid var(--border);
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-switch-on .ag-switch-track {
    background: var(--primary);
    border-color: var(--primary);
}

.ag-switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 9999px;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
    transition: transform 0.15s;
}

.ag-switch-on .ag-switch-thumb {
    transform: translateX(18px);
}

/* Badges */
.ag-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 9999px;
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
}

.ag-badge-neutral {
    background: var(--content);
    color: var(--muted-foreground);
}

.ag-badge-primary {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 34%, transparent);
}

.ag-badge-success {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 34%, transparent);
}

.ag-badge-warning {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 34%, transparent);
}

.ag-badge-error {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 34%, transparent);
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
    font-weight: 600;
    color: var(--muted-foreground);
    display: flex;
    align-items: center;
    gap: 4px;
}

.ag-field-required {
    color: var(--error);
}

.ag-field-hint {
    font-size: 11px;
    color: var(--muted-foreground);
}

.ag-field-error {
    font-size: 12px;
    color: var(--error);
}

.ag-input,
.ag-select,
.ag-textarea {
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-size: 16px;
    line-height: 1.4;
    outline: none;
    transition: border-color 0.15s;
}

.ag-input,
.ag-select {
    min-height: 40px;
}

.ag-textarea {
    resize: vertical;
    min-height: 88px;
}

.ag-input:focus,
.ag-select:focus,
.ag-textarea:focus,
.ag-code-textarea:focus {
    border-color: var(--primary);
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
    font-weight: 600;
    color: var(--muted-foreground);
}

.ag-code-lang {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--content);
    border: 1px solid var(--border);
    color: var(--muted-foreground);
}

.ag-code-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border-radius: 10px;
    background: var(--sidebar);
    border: 1px solid var(--border);
    overflow-x: auto;
    overflow-y: hidden;
}

.ag-code-textarea {
    width: 100%;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 16px;
    line-height: 1.55;
    tab-size: 2;
    outline: none;
    resize: vertical;
}

/* Cards & Empty States */
.ag-card {
    background: var(--content);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    min-width: 0;
}

.ag-card-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--card-border);
    background: color-mix(in srgb, var(--sidebar) 60%, var(--content));
}

.ag-card-headings {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.ag-card-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
}

.ag-card-subtitle {
    margin: 0;
    font-size: 12px;
    color: var(--muted-foreground);
}

.ag-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.ag-card-body {
    padding: 14px;
    min-width: 0;
}

.ag-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 8px;
    padding: 36px 20px;
    min-height: 220px;
    color: var(--muted-foreground);
}

.ag-empty-icon {
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--content);
    border: 1px solid var(--border);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--primary);
}

.ag-empty-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--foreground);
}

.ag-empty-desc {
    font-size: 12px;
    max-width: 380px;
}

/* Lists inside Master Pane */
.ag-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
}

.ag-list-item {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 12px;
    min-height: 48px;
    border-radius: 10px;
    border: 1px solid var(--card-border);
    background: var(--card);
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-list-item:hover {
    background: var(--secondary);
}

.ag-list-item-active {
    background: var(--content);
    border-color: var(--primary);
}

.ag-list-item-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--foreground);
    word-break: break-word;
}

.ag-list-item-meta {
    font-size: 11px;
    color: var(--muted-foreground);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}

/* Modal Inside Shadow DOM */
.ag-modal-backdrop {
    position: absolute;
    inset: 0;
    z-index: 40;
    background: rgba(8, 10, 14, 0.65);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
}

.ag-modal {
    width: 100%;
    max-height: 100%;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
}

.ag-modal-header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
}

.ag-modal-title {
    margin: 0;
    font-size: 15px;
    font-weight: 700;
}

.ag-modal-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.ag-modal-footer {
    flex-shrink: 0;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
    background: var(--sidebar);
}

/* Toasts Inside Shadow DOM */
.ag-toast-container {
    position: absolute;
    right: 14px;
    bottom: 14px;
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: calc(100% - 28px);
    pointer-events: none;
}

.ag-toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px 4px 12px;
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 12px;
    font-weight: 500;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}

.ag-toast-primary {
    border-color: color-mix(in srgb, var(--primary) 45%, transparent);
}
.ag-toast-success {
    border-color: color-mix(in srgb, var(--success) 45%, transparent);
}
.ag-toast-warning {
    border-color: color-mix(in srgb, var(--warning) 45%, transparent);
}
.ag-toast-error {
    border-color: color-mix(in srgb, var(--error) 45%, transparent);
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
}

.ag-toast-close {
    min-width: 40px;
    min-height: 40px;
    border-radius: 8px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.ag-toast-close:hover {
    background: var(--secondary);
    color: var(--foreground);
}

/* Shared Layout & Utility Classes */
.ag-stack-v {
    display: flex;
    flex-direction: column;
    gap: 12px;
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
    gap: 12px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

.ag-pre {
    margin: 0;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--content);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 12px;
    line-height: 1.5;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-diff-add {
    background: color-mix(in srgb, var(--success) 15%, transparent);
    color: var(--success);
    padding: 2px 6px;
    border-radius: 4px;
}

.ag-diff-del {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
    padding: 2px 6px;
    border-radius: 4px;
}

.ag-diff-ctx {
    color: var(--muted-foreground);
    padding: 2px 6px;
    border-radius: 4px;
}

.ag-diff-box {
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--sidebar);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 11px;
    line-height: 1.5;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
}

.ag-diff-line {
    padding: 2px 8px;
    white-space: pre-wrap;
    word-break: break-all;
    border-bottom: 1px solid color-mix(in srgb, var(--card-border) 45%, transparent);
}

.ag-diff-line:last-child {
    border-bottom: none;
}

.ag-diff-line-add {
    background: color-mix(in srgb, var(--success) 15%, transparent);
    color: var(--success);
}

.ag-diff-line-del {
    background: color-mix(in srgb, var(--error) 15%, transparent);
    color: var(--error);
}

.ag-diff-line-ctx {
    color: var(--muted-foreground);
}

/* Soft Pills & Redaction Highlights (matching assistant-ui-prototype.html) */
.ag-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border-radius: 6px;
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 600;
    line-height: 1.35;
    white-space: nowrap;
}

.ag-pill-primary {
    background: color-mix(in srgb, var(--primary) 14%, transparent);
    color: var(--primary);
    border-color: color-mix(in srgb, var(--primary) 34%, transparent);
}

.ag-pill-success {
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
    border-color: color-mix(in srgb, var(--success) 34%, transparent);
}

.ag-pill-warning {
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
    border-color: color-mix(in srgb, var(--warning) 34%, transparent);
}

.ag-pill-error {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 34%, transparent);
}

.ag-pill-muted {
    background: color-mix(in srgb, var(--muted-foreground) 12%, transparent);
    color: var(--muted-foreground);
    border-color: color-mix(in srgb, var(--border) 85%, transparent);
}

.ag-redacted-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--warning) 40%, transparent);
    background: color-mix(in srgb, var(--warning) 14%, transparent);
    color: var(--warning);
    font-size: 10px;
    font-weight: 600;
    flex-shrink: 0;
    white-space: nowrap;
}

.ag-redacted-token {
    display: inline-block;
    padding: 0 4px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--warning) 20%, transparent);
    color: var(--warning);
    font-weight: 700;
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
    min-height: 46px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--sidebar) 80%, var(--card));
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
    border-radius: 6px;
    padding: 4px 6px;
    margin: -4px 0 -4px -6px;
    transition: background-color 0.15s;
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
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s, color 0.15s, border-color 0.15s;
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
    border-radius: 10px;
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
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
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
    gap: 5px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-ast-topbar-btn:hover:not(:disabled) {
    background: var(--secondary);
}

.ag-ast-undo-count {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    background: var(--card);
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
    border-radius: 10px;
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
    border-radius: 10px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    border-radius: 10px;
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
    transition: background-color 0.15s, border-color 0.15s, color 0.15s;
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
    border-radius: 12px;
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
    border-radius: 8px;
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    padding: 10px;
    border-radius: 10px;
    border: 1px solid color-mix(in srgb, var(--error) 55%, var(--border));
    background: color-mix(in srgb, var(--error) 10%, var(--content));
    min-width: 0;
}

.ag-ast-overflow-hint {
    font-size: 12px;
    font-weight: 600;
    color: var(--error);
    line-height: 1.45;
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

/* Session List Panel & Desktop Slide-Out Drawer */
.ag-ast-drawer-backdrop {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: rgba(0, 0, 0, 0.35);
    display: flex;
    justify-content: flex-start;
}

.ag-ast-drawer {
    width: min(312px, 88%);
    height: 100%;
    min-height: 0;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
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
    border-radius: 12px;
    border: 1px solid var(--card-border);
    background: color-mix(in srgb, var(--content) 65%, var(--sidebar));
    color: var(--foreground);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-ast-session-item:hover {
    background: var(--secondary);
}

.ag-ast-session-item-active {
    background: var(--card);
    border-color: color-mix(in srgb, var(--primary) 60%, transparent);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
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
    font-size: 10px;
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
    border-radius: 10px;
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
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
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
    border-radius: 8px;
    background: var(--card);
    border: 1px solid var(--border);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.16);
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
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.84;
    transition: background-color 0.15s, color 0.15s, opacity 0.15s, border-color 0.15s;
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
    border-radius: 10px;
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
    border-radius: 10px;
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
    border-radius: 8px;
    background: #000000;
    display: block;
}

.ag-ast-att-file-card {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
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
    border-radius: 14px;
    border: 1px solid var(--primary);
    background: var(--card);
    display: flex;
    flex-direction: column;
    gap: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
}

.ag-ast-edit-textarea {
    width: 100%;
    min-height: 84px;
    max-height: 320px;
    padding: 8px 10px;
    border-radius: 10px;
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
    border-radius: 4px;
    background: var(--content);
    border: 1px solid var(--card-border);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    border-radius: 4px;
    background: var(--content);
    border: 1px solid var(--card-border);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.88em;
    color: var(--primary);
    overflow-wrap: anywhere;
    word-break: break-word;
}

.ag-md-code-block {
    margin: 0.65em 0;
    border-radius: 10px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    border-radius: 6px;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    flex-shrink: 0;
    transition: background-color 0.15s, color 0.15s;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    border-radius: 8px;
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
    border-radius: 8px;
    border: 1px solid var(--border);
    object-fit: contain;
}

.ag-ast-bubble-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 10px;
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

/* Collapsible Thinking / Tool Bar */
.ag-ast-activity {
    border-radius: 10px;
    background: var(--content);
    border: 1px solid var(--card-border);
    overflow: hidden;
    min-width: 0;
}

.ag-ast-activity-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 6px;
    min-width: 0;
}

.ag-ast-activity-toggle {
    flex: 1 1 auto;
    min-width: 40px;
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
}

.ag-ast-activity-toggle:hover {
    color: var(--foreground);
}

.ag-ast-activity-summary {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-activity-body {
    padding: 8px 10px 10px;
    border-top: 1px solid var(--card-border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
}

.ag-ast-think {
    font-size: 11px;
    color: var(--muted-foreground);
    line-height: 1.55;
    word-break: break-word;
}

.ag-ast-tool-card {
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--sidebar);
    overflow: hidden;
    min-width: 0;
}

.ag-ast-tool-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 2px 6px;
}

.ag-ast-tool-toggle {
    flex: 1 1 auto;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: 4px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
}

.ag-ast-tool-body {
    padding: 6px 8px 8px;
    border-top: 1px solid var(--card-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.ag-ast-tool-pre {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--content);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 10px;
    line-height: 1.45;
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
}

.ag-ast-file-refs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
}

.ag-ast-file-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 40px;
    min-height: 40px;
    max-width: 100%;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 11px;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.ag-ast-file-chip:hover {
    background: var(--secondary);
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
    border-radius: 12px;
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
    border-radius: 8px;
    background: var(--sidebar);
    border: 1px solid var(--border);
    flex-shrink: 0;
}

.ag-ast-approval-view-tab {
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 6px;
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
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 10px;
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
    border-radius: 12px;
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
    background: var(--sidebar);
    border-top: 1px solid var(--border);
    padding: 8px 12px;
}

.ag-ast-composer-box {
    border-radius: 16px;
    border: 1px solid var(--border);
    background: var(--content);
    padding: 8px 10px 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.15s;
}

.ag-ast-composer-box:focus-within {
    border-color: var(--primary);
}

.ag-ast-composer-box-dragover {
    border-style: dashed;
    border-color: var(--primary);
    background: color-mix(in srgb, var(--primary) 10%, var(--content));
}

.ag-ast-drop-hint {
    padding: 6px 10px;
    border-radius: 10px;
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
    border-radius: 10px;
    border: 1px solid var(--border);
    background: var(--card);
    max-width: min(260px, 100%);
    min-width: 0;
}

.ag-ast-pending-thumb {
    width: 40px;
    height: 40px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
}

.ag-ast-pending-icon {
    width: 40px;
    height: 40px;
    border-radius: 6px;
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
    font-size: 10px;
    color: var(--muted-foreground);
}

.ag-ast-pending-remove {
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    border: none;
    border-radius: 8px;
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
    gap: 6px;
    flex-shrink: 0;
}

.ag-ast-upload-btn {
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    flex-shrink: 0;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 16px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-ast-upload-btn:hover:not(:disabled) {
    background: var(--secondary);
    border-color: var(--primary);
}

.ag-ast-upload-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-ast-composer-input {
    width: 100%;
    min-height: 40px;
    max-height: 160px;
    border: none;
    background: transparent;
    color: var(--foreground);
    font-size: 16px;
    line-height: 1.4;
    resize: none;
    outline: none;
    padding: 4px 2px;
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
    gap: 6px;
    min-width: 0;
    flex: 1 1 auto;
}

.ag-ast-mode-btn,
.ag-ast-model-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--card);
    color: var(--foreground);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: background-color 0.15s, border-color 0.15s;
}

.ag-ast-mode-btn {
    flex-shrink: 0;
}

.ag-ast-model-btn {
    min-width: 40px;
    max-width: 100%;
    overflow: hidden;
    font-weight: 500;
}

.ag-ast-model-btn:hover,
.ag-ast-mode-btn:hover {
    filter: brightness(1.06);
}

.ag-ast-model-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.ag-ast-send-btn,
.ag-ast-stop-btn {
    width: 40px;
    height: 40px;
    min-width: 40px;
    min-height: 40px;
    padding: 0;
    flex-shrink: 0;
    border-radius: 12px;
    border: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    transition: opacity 0.15s, filter 0.15s;
}

.ag-ast-send-btn {
    background: var(--primary);
    color: var(--primary-foreground);
}

.ag-ast-stop-btn {
    background: var(--error);
    color: #ffffff;
}

.ag-ast-send-btn:hover:not(:disabled),
.ag-ast-stop-btn:hover:not(:disabled) {
    filter: brightness(1.08);
}

.ag-ast-send-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
}

.ag-ast-popover-backdrop {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: rgba(0, 0, 0, 0.25);
}

.ag-ast-popover {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 12px;
    width: min(340px, calc(100% - 24px));
    max-height: min(430px, 65vh);
    z-index: 30;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
    font-size: 12px;
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
    border-radius: 12px;
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
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
    border-radius: 12px;
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
    border-radius: 12px;
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
    border-radius: 8px;
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
    background: var(--card);
}

.ag-side-subbar {
    flex-shrink: 0;
    min-height: 48px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    background: color-mix(in srgb, var(--sidebar) 75%, var(--card));
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
    border-radius: 12px;
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
    border-radius: 9px;
    border: none;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
    transition: background-color 0.15s, color 0.15s;
}

.ag-side-tab-active {
    background: var(--card);
    color: var(--foreground);
    font-weight: 600;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
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
    border-radius: 12px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
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
    border-radius: 12px;
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
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--success) 35%, transparent);
    background: color-mix(in srgb, var(--success) 12%, transparent);
    color: var(--success);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 11px;
    line-height: 1.55;
    white-space: pre-wrap;
    word-break: break-word;
}

.ag-banner {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font-size: 12px;
    line-height: 1.5;
}

.ag-banner-primary {
    background: color-mix(in srgb, var(--primary) 12%, transparent);
    border-color: color-mix(in srgb, var(--primary) 35%, transparent);
}

.ag-banner-success {
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border-color: color-mix(in srgb, var(--success) 35%, transparent);
}

.ag-banner-warning {
    background: color-mix(in srgb, var(--warning) 12%, transparent);
    border-color: color-mix(in srgb, var(--warning) 35%, transparent);
}

.ag-banner-error {
    background: color-mix(in srgb, var(--error) 12%, transparent);
    border-color: color-mix(in srgb, var(--error) 35%, transparent);
}

.ag-progress-track {
    position: relative;
    height: 10px;
    border-radius: 9999px;
    background: var(--card);
    border: 1px solid var(--border);
    overflow: hidden;
}

.ag-progress-fill {
    height: 100%;
    background: var(--primary);
    transition: width 0.2s ease;
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
    border-radius: 10px;
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
    border-radius: 8px;
    border: 1px solid var(--card-border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
    transition: background-color 0.15s, border-color 0.15s;
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
    border-radius: 8px;
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
    transition: opacity 0.15s, border-color 0.15s;
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
    border-radius: 10px;
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
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--content);
    color: var(--foreground);
    text-align: left;
    font-family: inherit;
    cursor: pointer;
    min-width: 0;
    transition: border-color 0.15s, background-color 0.15s;
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
        padding: 8px 10px;
        gap: 8px;
    }

    .ag-isolation-pill {
        display: none;
    }

    .ag-header-controls {
        width: 100%;
        justify-content: space-between;
    }

    .ag-header-select-wrap {
        flex: 1 1 100%;
        flex-wrap: wrap;
    }

    .ag-header-select {
        flex: 1 1 140px;
        max-width: 100%;
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
        border-radius: 14px;
        padding: 8px 12px;
    }

    .ag-ast-overflow-btn {
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
        padding: 6px 8px;
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
