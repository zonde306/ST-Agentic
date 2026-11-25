import type { AssistantMode, HostExtensionCapabilities } from '../types';
import { isPathAllowed, normalizeVfsPath } from '../utils/glob';
import { isAgentsMdApprovalRequiredPath } from '../vfs/workspace-policy';

export type PolicyRiskLevel = 'low' | 'medium' | 'high';

export const ASSISTANT_MODES = ['chat', 'adjust', 'author', 'full'] as const;

const MODE_RANK: Record<AssistantMode, number> = {
    chat: 0,
    adjust: 1,
    author: 2,
    full: 3,
};

/**
 * Strict VFS path allowlist for `adjust` / `author` / `full` file-write tools
 * (`write_file`, `append_file`, `edit_file`).
 */
export const ADJUST_ALLOWED_VFS_PATTERNS = [
    '/workspace/**',
    '/state/**',
    '/lorebooks/**',
    '/side/**',
] as const;

export const VFS_SCOPED_WRITE_TOOLS = [
    'write_file',
    'append_file',
    'edit_file',
] as const;

export const CHAT_READONLY_TOOLS = [
    'list_dir',
    'glob_files',
    'grep_search',
    'search_files',
    'read_file',
    'read_variables',
    'search_history',
    'read_history',
    'agentic_read_status',
    'agentic_read_traces',
    'card_read_active',
    'wi_read_enabled',
] as const;

export const ADJUST_WRITE_TOOLS = [
    'patch_variables',
    'write_file',
    'append_file',
    'edit_file',
    'chat_create_message',
    'chat_edit_message',
    'chat_delete_message',
    'chat_toggle_hide_message',
    'message_override_display',
] as const;

export const AUTHOR_TOOLS = [
    'card_read_full',
    'card_patch_active',
    'wi_read_raw_book',
    'wi_upsert_primary_entry',
    'wi_delete_primary_entry',
    'regex_list_scoped',
    'regex_upsert_scoped',
    'regex_delete_scoped',
    'card_embed_agentic',
    'chat_reload_messages',
] as const;

export const FULL_ENABLED_WI_TOOLS = [
    'wi_list_enabled_books',
    'wi_upsert_enabled_entry',
    'wi_delete_enabled_entry',
] as const;

export const FULL_AGENTIC_CONFIG_TOOLS = [
    'agentic_config_read',
    'agentic_settings_patch',
    'agentic_preset_component_upsert',
    'agentic_preset_component_delete',
    'agentic_connection_upsert',
] as const;

export const ADMIN_TOOLS = [
    'wi_admin_list_all',
    'wi_admin_create_book',
    'wi_admin_bind_book',
    'wi_admin_upsert_entry',
    'wi_admin_delete_entry',
    'card_admin_list_all',
    'card_admin_read',
    'card_admin_create',
    'card_admin_patch',
    'card_admin_delete',
    'card_admin_select',
    'persona_admin_list',
    'persona_admin_upsert',
    'persona_admin_select',
    'st_settings_read',
    'st_settings_patch',
    'st_preset_list',
    'st_preset_select',
    'st_preset_patch',
    'regex_admin_global_upsert',
    'regex_admin_global_delete',
    'st_slash_exec',
    'st_import_url',
    'tavern_helper_scripts_read',
    'tavern_helper_scripts_upsert',
    'st_sync_runtime',
] as const;

const ADMIN_DYNAMIC_PREFIXES = [
    'wi_admin_',
    'card_admin_',
    'persona_admin_',
    'st_settings_',
    'st_preset_',
    'regex_admin_global_',
] as const;

interface ToolPolicySpec {
    requiredMode: AssistantMode;
    requiresAdmin: boolean;
    mutating: boolean;
    baseRequiresApproval: boolean;
    baseMandatoryConfirm: boolean;
    baseRiskLevel: PolicyRiskLevel;
    vfsScoped?: boolean;
    requiredCapability?: keyof HostExtensionCapabilities;
    defaultScopeLabel: string;
}

const TOOL_CATALOG: Record<string, ToolPolicySpec> = {
    // 1. chat read-only base tools
    list_dir: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'VFS Read',
    },
    glob_files: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'VFS Read',
    },
    grep_search: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'VFS Search',
    },
    search_files: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'VFS Search',
    },
    read_file: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'VFS Read',
    },
    read_variables: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Variables Read',
    },
    search_history: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat History',
    },
    read_history: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat History',
    },
    agentic_read_status: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Agentic Status',
    },
    agentic_read_traces: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Agentic Traces',
    },
    card_read_active: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Active Card',
    },
    wi_read_enabled: {
        requiredMode: 'chat',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Enabled WI',
    },

    // 2. adjust current-chat write tools (direct exec + auto UndoRecord)
    patch_variables: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Branch Variables',
    },
    write_file: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        vfsScoped: true,
        defaultScopeLabel: 'VFS Write',
    },
    append_file: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        vfsScoped: true,
        defaultScopeLabel: 'VFS Write',
    },
    edit_file: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        vfsScoped: true,
        defaultScopeLabel: 'VFS Write',
    },
    chat_create_message: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat Message',
    },
    chat_edit_message: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat Message',
    },
    chat_delete_message: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Chat Message',
    },
    chat_toggle_hide_message: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat Visibility',
    },
    message_override_display: {
        requiredMode: 'adjust',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Display Override',
    },

    // 3. author permanent active-card / primary-WI / scoped-regex tools
    card_read_full: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Active Card',
    },
    card_patch_active: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Active Card',
    },
    wi_read_raw_book: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Primary WI',
    },
    wi_upsert_primary_entry: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Primary WI',
    },
    wi_delete_primary_entry: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Primary WI',
    },
    regex_list_scoped: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Scoped Regex',
    },
    regex_upsert_scoped: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Scoped Regex',
    },
    regex_delete_scoped: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Scoped Regex',
    },
    card_embed_agentic: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Card Embed',
    },
    chat_reload_messages: {
        requiredMode: 'author',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Chat Reload',
    },

    // 4. full mode (default stAdminEnabled: false) — enabled World Info books & ST-Agentic config
    wi_list_enabled_books: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Enabled WI',
    },
    wi_upsert_enabled_entry: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Enabled WI',
    },
    wi_delete_enabled_entry: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Enabled WI',
    },
    agentic_config_read: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Agentic Config',
    },
    agentic_settings_patch: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Agentic Settings',
    },
    agentic_preset_component_upsert: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Agentic Preset',
    },
    agentic_preset_component_delete: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Agentic Preset',
    },
    agentic_connection_upsert: {
        requiredMode: 'full',
        requiresAdmin: false,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Agentic Connection',
    },

    // 5. full + stAdminEnabled: true — ST Admin tools
    wi_admin_list_all: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Admin WI',
    },
    wi_admin_create_book: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin WI',
    },
    wi_admin_bind_book: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin WI',
    },
    wi_admin_upsert_entry: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin WI',
    },
    wi_admin_delete_entry: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Admin WI',
    },
    card_admin_list_all: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Admin Card',
    },
    card_admin_read: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Admin Card',
    },
    card_admin_create: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin Card',
    },
    card_admin_patch: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin Card',
    },
    card_admin_delete: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Admin Card',
    },
    card_admin_select: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin Card',
    },
    persona_admin_list: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Admin Persona',
    },
    persona_admin_upsert: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin Persona',
    },
    persona_admin_select: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'medium',
        defaultScopeLabel: 'Admin Persona',
    },
    st_settings_read: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'ST Settings',
    },
    st_settings_patch: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'ST Settings',
    },
    st_preset_list: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'ST Presets',
    },
    st_preset_select: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'ST Presets',
    },
    st_preset_patch: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'ST Presets',
    },
    regex_admin_global_upsert: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Global Regex',
    },
    regex_admin_global_delete: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'Global Regex',
    },
    st_slash_exec: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'ST Slash',
    },
    st_import_url: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        defaultScopeLabel: 'ST Import URL',
    },
    tavern_helper_scripts_read: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        requiredCapability: 'tavernHelperScripts',
        defaultScopeLabel: 'TavernHelper Scripts',
    },
    tavern_helper_scripts_upsert: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: true,
        baseRequiresApproval: true,
        baseMandatoryConfirm: true,
        baseRiskLevel: 'high',
        requiredCapability: 'tavernHelperScripts',
        defaultScopeLabel: 'TavernHelper Scripts',
    },
    st_sync_runtime: {
        requiredMode: 'full',
        requiresAdmin: true,
        mutating: false,
        baseRequiresApproval: false,
        baseMandatoryConfirm: false,
        baseRiskLevel: 'low',
        defaultScopeLabel: 'Runtime Sync',
    },
};

export interface PolicyEvaluationContext {
    mode: AssistantMode;
    stAdminEnabled?: boolean;
    autoApproveAuthor?: boolean;
    autoApproveChatDelete?: boolean;
    extensionCapabilities?: HostExtensionCapabilities;
}

/**
 * Determine whether the current session auto-approve settings bypass non-mandatory approval
 * for a specific tool.
 */
export function isToolAutoApproved(
    toolName: string,
    ctx: PolicyEvaluationContext,
): boolean {
    if (toolName === 'chat_delete_message') {
        return ctx.mode === 'adjust'
            ? Boolean(ctx.autoApproveChatDelete)
            : Boolean(ctx.autoApproveAuthor || ctx.autoApproveChatDelete);
    }
    return Boolean(ctx.autoApproveAuthor);
}

export interface ToolPolicyResult {
    allowed: boolean;
    reason?: string;
    toolName: string;
    requiredMode?: AssistantMode;
    requiresAdmin: boolean;
    mutating: boolean;
    requiresApproval: boolean;
    baseRequiresApproval: boolean;
    mandatoryConfirm: boolean;
    riskLevel: PolicyRiskLevel;
    scopeLabel: string;
}

function isDeleteToolName(toolName: string): boolean {
    return /(?:^|_)delete(?:_|$)/i.test(toolName);
}

function isReadOnlyAdminSuffix(toolName: string): boolean {
    return /(?:^|_)(?:read|list|list_all|get)(?:_|$)/i.test(toolName);
}

/**
 * Detect cross-card batch operations from either tool name conventions or batch arguments.
 */
export function isCrossCardBatchOperation(
    toolName: string,
    args?: Record<string, unknown>,
): boolean {
    if (/(?:^|_)batch(?:_|$)/i.test(toolName)) {
        return true;
    }

    if (!toolName.startsWith('card_admin_') || !args) {
        return false;
    }

    if (args.batch === true || args.allCharacters === true) {
        return true;
    }

    const batchArrayKeys = ['chids', 'characterIds', 'targets', 'cards', 'items', 'operations'];
    for (const key of batchArrayKeys) {
        const val = args[key];
        if (Array.isArray(val) && val.length > 0) {
            return true;
        }
    }

    return false;
}

/**
 * Determine whether a tool invocation triggers the non-bypassable `mandatoryConfirm`
 * red line (§3.3): ALL `*_delete_*`, `st_settings_patch`, mutating `st_preset_*`,
 * `regex_admin_global_*`, `st_slash_exec`, `st_import_url`, and cross-card batch ops.
 */
export function isMandatoryConfirmTool(
    toolName: string,
    args?: Record<string, unknown>,
): boolean {
    // Current-chat message deletion is gated by per-session opt-in approval (+ UndoRecord),
    // whereas permanent asset/admin deletes remain non-bypassable mandatoryConfirm.
    if (toolName === 'chat_delete_message') {
        return false;
    }
    if (isDeleteToolName(toolName)) {
        return true;
    }
    if (toolName === 'st_settings_patch') {
        return true;
    }
    if (toolName.startsWith('st_preset_') && !isReadOnlyAdminSuffix(toolName)) {
        return true;
    }
    if (toolName.startsWith('regex_admin_global_') && !isReadOnlyAdminSuffix(toolName)) {
        return true;
    }
    if (toolName === 'st_slash_exec' || toolName === 'st_import_url') {
        return true;
    }
    if (toolName === 'agentic_connection_upsert' || toolName === 'tavern_helper_scripts_upsert') {
        return true;
    }
    if (
        toolName === 'agentic_settings_patch'
        && typeof args?.deletePresetId === 'string'
        && args.deletePresetId.trim().length > 0
    ) {
        return true;
    }
    if (
        (VFS_SCOPED_WRITE_TOOLS as readonly string[]).includes(toolName)
        && typeof args?.path === 'string'
        && isAgentsMdApprovalRequiredPath(args.path)
    ) {
        return true;
    }
    if (isCrossCardBatchOperation(toolName, args)) {
        return true;
    }
    return false;
}

/**
 * Validate whether a VFS path falls within the strict `adjust` write allowlist
 * (`/workspace/**`, `/state/**`, `/lorebooks/**`, `/side/**`) with zero traversal.
 */
export function isVfsWritePathAllowed(targetPath: string): boolean {
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
        return false;
    }
    return isPathAllowed(ADJUST_ALLOWED_VFS_PATTERNS, targetPath);
}

function resolveToolSpec(toolName: string): ToolPolicySpec | null {
    const exact = TOOL_CATALOG[toolName];
    if (exact) {
        return exact;
    }

    for (const prefix of ADMIN_DYNAMIC_PREFIXES) {
        if (toolName.startsWith(prefix)) {
            const readOnly = isReadOnlyAdminSuffix(toolName);
            const mandatory = !readOnly && isMandatoryConfirmTool(toolName);
            return {
                requiredMode: 'full',
                requiresAdmin: true,
                mutating: !readOnly,
                baseRequiresApproval: !readOnly,
                baseMandatoryConfirm: mandatory,
                baseRiskLevel: readOnly ? 'low' : mandatory ? 'high' : 'medium',
                defaultScopeLabel: 'ST Admin',
            };
        }
    }

    return null;
}

function buildScopeLabel(
    toolName: string,
    spec: ToolPolicySpec,
    args?: Record<string, unknown>,
): string {
    if (!args) {
        return spec.defaultScopeLabel;
    }

    if (typeof args.path === 'string' && args.path.trim() !== '') {
        try {
            return `VFS: ${normalizeVfsPath(args.path)}`;
        } catch {
            return `VFS: ${args.path}`;
        }
    }

    if (typeof args.bookName === 'string' && args.bookName.trim() !== '') {
        const uidSuffix =
            typeof args.uid === 'number' || typeof args.uid === 'string' ? ` / #${args.uid}` : '';
        return `WI: ${args.bookName}${uidSuffix}`;
    }

    if (typeof args.scope === 'string' && args.scope.trim() !== '' && toolName.startsWith('st_settings_')) {
        return `ST Settings: ${args.scope}`;
    }

    if (typeof args.name === 'string' && args.name.trim() !== '' && toolName.startsWith('st_preset_')) {
        return `ST Preset: ${args.name}`;
    }

    if (args.target && typeof args.target === 'object') {
        const target = args.target as { messageId?: unknown; swipeId?: unknown };
        if (typeof target.messageId === 'number') {
            const swipe = typeof target.swipeId === 'number' ? `#${target.swipeId}` : '';
            return `Chat: #${target.messageId}${swipe}`;
        }
    }

    if (Array.isArray(args.messageIds)) {
        const ids = args.messageIds.filter(
            (id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0,
        );
        if (ids.length > 0) {
            const previewIds = ids.slice(0, 3).map((id) => `#${id}`).join(', ');
            return ids.length > 3
                ? `Chat: ${previewIds} (+${ids.length - 3})`
                : `Chat: ${previewIds}`;
        }
    }

    if (typeof args.messageId === 'number') {
        return `Chat: #${args.messageId}`;
    }

    if (toolName === 'chat_create_message' && typeof args.insertAt === 'number') {
        return `Chat: insert #${args.insertAt}`;
    }

    if (typeof args.chid === 'number') {
        return `Card: #${args.chid}`;
    }

    if (typeof args.url === 'string' && args.url.trim() !== '') {
        return `Import: ${args.url}`;
    }

    if (
        toolName === 'agentic_preset_component_upsert'
        || toolName === 'agentic_preset_component_delete'
    ) {
        const kind = typeof args.kind === 'string' ? args.kind.trim() : '';
        const item =
            args.item && typeof args.item === 'object'
                ? (args.item as { id?: unknown; name?: unknown })
                : undefined;
        const itemId =
            typeof args.id === 'string' && args.id.trim() !== ''
                ? args.id.trim()
                : typeof item?.id === 'string' && item.id.trim() !== ''
                    ? item.id.trim()
                    : typeof item?.name === 'string' && item.name.trim() !== ''
                        ? item.name.trim()
                        : '';
        if (kind && itemId) {
            return `Agentic Preset: ${kind}/${itemId}`;
        }
        if (kind) {
            return `Agentic Preset: ${kind}`;
        }
    }

    if (toolName === 'agentic_connection_upsert' && typeof args.id === 'string' && args.id.trim() !== '') {
        return `Agentic Connection: ${args.id.trim()}`;
    }

    if (
        (toolName === 'tavern_helper_scripts_read' || toolName === 'tavern_helper_scripts_upsert')
        && typeof args.scope === 'string'
        && args.scope.trim() !== ''
    ) {
        return `TavernHelper (${args.scope.trim()})`;
    }

    if (toolName === 'st_sync_runtime' && Array.isArray(args.targets) && args.targets.length > 0) {
        const targets = args.targets
            .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
            .map((t) => t.trim());
        if (targets.length > 0) {
            return `Runtime Sync: ${targets.join(', ')}`;
        }
    }

    if (toolName === 'chat_reload_messages' && Array.isArray(args.messageIds) && args.messageIds.length > 0) {
        const ids = args.messageIds.filter(
            (id): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0,
        );
        if (ids.length > 0) {
            const previewIds = ids.slice(0, 3).map((id) => `#${id}`).join(', ');
            return ids.length > 3
                ? `Chat Reload: ${previewIds} (+${ids.length - 3})`
                : `Chat Reload: ${previewIds}`;
        }
    }

    return spec.defaultScopeLabel;
}

/**
 * Return the full ordered allowlist of registered tools unlocked for a given
 * `(mode, stAdminEnabled)` pair.
 */
export function getAllowedToolsForMode(
    mode: AssistantMode,
    stAdminEnabled: boolean = false,
    extensionCapabilities?: HostExtensionCapabilities,
): string[] {
    const tools: string[] = [...CHAT_READONLY_TOOLS];

    if (MODE_RANK[mode] >= MODE_RANK.adjust) {
        tools.push(...ADJUST_WRITE_TOOLS);
    }
    if (MODE_RANK[mode] >= MODE_RANK.author) {
        tools.push(...AUTHOR_TOOLS);
    }
    if (MODE_RANK[mode] >= MODE_RANK.full) {
        tools.push(...FULL_ENABLED_WI_TOOLS, ...FULL_AGENTIC_CONFIG_TOOLS);
        if (stAdminEnabled) {
            tools.push(...ADMIN_TOOLS);
        }
    }

    if (!extensionCapabilities) {
        return tools;
    }

    return tools.filter((name) => {
        const cap = TOOL_CATALOG[name]?.requiredCapability;
        return !cap || Boolean(extensionCapabilities[cap]);
    });
}

/**
 * Evaluate whether `toolName` with `args` is allowed under `ctx`, whether it requires
 * user approval, whether `mandatoryConfirm` is enforced, its risk level, and a scope label.
 */
export function evaluateToolPolicy(
    toolName: string,
    args: Record<string, unknown> | undefined,
    ctx: PolicyEvaluationContext,
): ToolPolicyResult {
    const spec = resolveToolSpec(toolName);
    if (!spec) {
        return {
            allowed: false,
            reason: `Tool "${toolName}" is not in the assistant allowlist.`,
            toolName,
            requiresAdmin: false,
            mutating: true,
            requiresApproval: true,
            baseRequiresApproval: true,
            mandatoryConfirm: true,
            riskLevel: 'high',
            scopeLabel: 'Unknown Tool',
        };
    }

    const mandatoryConfirm =
        spec.baseMandatoryConfirm || isMandatoryConfirmTool(toolName, args);
    const baseRequiresApproval = spec.baseRequiresApproval || mandatoryConfirm;
    const riskLevel: PolicyRiskLevel = mandatoryConfirm ? 'high' : spec.baseRiskLevel;
    const scopeLabel = buildScopeLabel(toolName, spec, args);

    const stAdminEnabled = Boolean(ctx.stAdminEnabled);
    const effectiveAutoApprove = isToolAutoApproved(toolName, ctx);

    if (MODE_RANK[ctx.mode] < MODE_RANK[spec.requiredMode]) {
        return {
            allowed: false,
            reason: `Tool "${toolName}" requires "${spec.requiredMode}" mode (current mode: "${ctx.mode}").`,
            toolName,
            requiredMode: spec.requiredMode,
            requiresAdmin: spec.requiresAdmin,
            mutating: spec.mutating,
            requiresApproval: baseRequiresApproval,
            baseRequiresApproval,
            mandatoryConfirm,
            riskLevel,
            scopeLabel,
        };
    }

    if (spec.requiresAdmin && !(ctx.mode === 'full' && stAdminEnabled)) {
        return {
            allowed: false,
            reason: `Tool "${toolName}" requires "full" mode with ST Admin (stAdminEnabled: true).`,
            toolName,
            requiredMode: spec.requiredMode,
            requiresAdmin: true,
            mutating: spec.mutating,
            requiresApproval: baseRequiresApproval,
            baseRequiresApproval,
            mandatoryConfirm,
            riskLevel,
            scopeLabel,
        };
    }

    if (
        spec.requiredCapability
        && ctx.extensionCapabilities
        && !ctx.extensionCapabilities[spec.requiredCapability]
    ) {
        return {
            allowed: false,
            reason: `Tool "${toolName}" is unavailable because optional host extension capability "${spec.requiredCapability}" is not installed or active.`,
            toolName,
            requiredMode: spec.requiredMode,
            requiresAdmin: spec.requiresAdmin,
            mutating: spec.mutating,
            requiresApproval: baseRequiresApproval,
            baseRequiresApproval,
            mandatoryConfirm,
            riskLevel,
            scopeLabel,
        };
    }

    if (spec.vfsScoped) {
        const targetPath = typeof args?.path === 'string' ? args.path : '';
        if (!isVfsWritePathAllowed(targetPath)) {
            return {
                allowed: false,
                reason:
                    targetPath.trim() === ''
                        ? `Tool "${toolName}" requires a valid VFS "path" within /workspace/**, /state/**, /lorebooks/**, or /side/**.`
                        : `VFS write path "${targetPath}" is outside allowed scopes (/workspace/**, /state/**, /lorebooks/**, /side/**).`,
                toolName,
                requiredMode: spec.requiredMode,
                requiresAdmin: false,
                mutating: true,
                requiresApproval: false,
                baseRequiresApproval: false,
                mandatoryConfirm: false,
                riskLevel: 'medium',
                scopeLabel,
            };
        }
    }

    const requiresApproval = mandatoryConfirm
        ? true
        : baseRequiresApproval && !effectiveAutoApprove;

    return {
        allowed: true,
        toolName,
        requiredMode: spec.requiredMode,
        requiresAdmin: spec.requiresAdmin,
        mutating: spec.mutating,
        requiresApproval,
        baseRequiresApproval,
        mandatoryConfirm,
        riskLevel,
        scopeLabel,
    };
}
