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
    display: block !important;
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
    display: block;
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
    min-width: 0;
}

.ag-nav-item-label {
    font-size: 13px;
    font-weight: 600;
    line-height: 1.3;
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
    background: color-mix(in srgb, var(--success) 14%, transparent);
    color: var(--success);
    padding: 2px 6px;
    border-radius: 4px;
}

.ag-diff-del {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
    padding: 2px 6px;
    border-radius: 4px;
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
    .ag-grid-4 {
        grid-template-columns: minmax(0, 1fr);
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

    input,
    select,
    textarea {
        font-size: 16px;
    }
}
`;
