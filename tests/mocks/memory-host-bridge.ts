import type { HostBridge, HostIdentity, WriteChatMessageOptions } from '@/core/bridge';
import type {
    ChatMessageSnapshot,
    MediaAttachment,
    MessageTarget,
    RawLoreEntry,
} from '@/core/types';
import { hashText as computeXxHash } from '@/core/utils';

export type EjsEvaluatorStub = (text: string, vars: Record<string, unknown>) => Promise<string> | string;
export type SlashCommandStub = (command: string, signal?: AbortSignal) => Promise<string> | string;

export interface MemoryHostBridgeInit {
    chat?: ChatMessageSnapshot[];
    metadata?: Record<string, unknown>;
    identity?: Partial<HostIdentity>;
    characterFields?: Record<string, string>;
    personaDescription?: string;
    lorebooks?: Map<string, RawLoreEntry[]> | Record<string, RawLoreEntry[]>;
    extensionData?: Record<string, unknown>;
    ejsEvaluator?: EjsEvaluatorStub;
    slashHandler?: SlashCommandStub;
    hostLuminance?: 'dark' | 'light';
}

export class MemoryHostBridge implements HostBridge {
    public chat: ChatMessageSnapshot[];
    public metadata: Record<string, unknown>;
    public identity: HostIdentity;
    public characterFields: Record<string, string>;
    public personaDescription: string;
    public lorebooks: Map<string, RawLoreEntry[]>;
    public extensionData: Map<string, unknown>;
    public hostLuminance: 'dark' | 'light';

    public saveChatCalls = 0;
    public writtenMessages: Array<{
        target: MessageTarget;
        content: string;
        options?: WriteChatMessageOptions;
    }> = [];
    public mediaAttachments: Array<{ target: MessageTarget; media: MediaAttachment }> = [];
    public refreshedViews: MessageTarget[] = [];
    public slashCalls: Array<{ command: string; aborted: boolean }> = [];
    public emittedEvents: Array<{ event: string; payload?: unknown }> = [];

    public evaluateOptionalEjs?: (text: string, vars: Record<string, unknown>) => Promise<string>;
    public executeSlashCommand?: (command: string, signal?: AbortSignal) => Promise<string>;

    private slashHandler?: SlashCommandStub;

    constructor(init: MemoryHostBridgeInit = {}) {
        this.chat = init.chat ? [...init.chat] : [];
        this.metadata = init.metadata ? { ...init.metadata } : {};
        this.identity = {
            userName: init.identity?.userName ?? 'User',
            charName: init.identity?.charName ?? 'Assistant',
            characterAvatar: init.identity?.characterAvatar ?? 'char.png',
            personaAvatar: init.identity?.personaAvatar ?? 'user.png',
        };
        this.characterFields = init.characterFields ? { ...init.characterFields } : {};
        this.personaDescription = init.personaDescription ?? '';

        this.lorebooks = new Map<string, RawLoreEntry[]>();
        if (init.lorebooks instanceof Map) {
            for (const [world, entries] of init.lorebooks.entries()) {
                this.lorebooks.set(world, [...entries]);
            }
        } else if (init.lorebooks) {
            for (const [world, entries] of Object.entries(init.lorebooks)) {
                this.lorebooks.set(world, [...entries]);
            }
        }

        this.extensionData = new Map<string, unknown>(
            init.extensionData ? Object.entries(init.extensionData) : [],
        );
        this.hostLuminance = init.hostLuminance ?? 'dark';

        if (init.ejsEvaluator) {
            this.setEjsEvaluator(init.ejsEvaluator);
        }

        if (init.slashHandler) {
            this.setSlashHandler(init.slashHandler);
        } else {
            this.setSlashHandler(async () => '');
        }
    }

    getChat(): ChatMessageSnapshot[] {
        return this.chat;
    }

    getMetadata(): Record<string, unknown> {
        return this.metadata;
    }

    saveChatDebounced(): void {
        this.saveChatCalls += 1;
    }

    readChatMessage(target: MessageTarget): string | null {
        if (
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return null;
        }
        const msg = this.chat[target.messageId];
        if (!msg) {
            return null;
        }
        if (Array.isArray(msg.swipes) && target.swipeId < msg.swipes.length) {
            return typeof msg.swipes[target.swipeId] === 'string'
                ? msg.swipes[target.swipeId]
                : '';
        }
        if (target.swipeId === 0 && (!Array.isArray(msg.swipes) || msg.swipes.length === 0)) {
            return typeof msg.mes === 'string' ? msg.mes : '';
        }
        return null;
    }

    async writeChatMessage(
        target: MessageTarget,
        content: string,
        options?: WriteChatMessageOptions,
    ): Promise<void> {
        if (
            !Number.isInteger(target.messageId) ||
            target.messageId < 0 ||
            target.messageId >= this.chat.length ||
            !Number.isInteger(target.swipeId) ||
            target.swipeId < 0
        ) {
            return;
        }
        const msg = this.chat[target.messageId];
        if (!msg) {
            return;
        }

        this.writtenMessages.push({
            target: { ...target },
            content,
            ...(options !== undefined ? { options: { ...options } } : {}),
        });

        const swipes = Array.isArray(msg.swipes)
            ? msg.swipes
            : (msg.swipes = [typeof msg.mes === 'string' ? msg.mes : '']);
        const swipeInfo = Array.isArray(msg.swipeInfo)
            ? msg.swipeInfo
            : (msg.swipeInfo = []);

        while (swipes.length <= target.swipeId) {
            swipes.push('');
        }
        while (swipeInfo.length <= target.swipeId) {
            swipeInfo.push({});
        }

        swipes[target.swipeId] = content;

        const activeSwipeId = msg.swipeId ?? 0;
        if (activeSwipeId === target.swipeId) {
            msg.mes = content;
            await this.refreshMessageView(target);
        }

        this.saveChatDebounced();

        if (options?.emitEvent) {
            this.emitHostEvent('MESSAGE_UPDATED', target.messageId);
        }
    }

    getActiveIdentity(): HostIdentity {
        return { ...this.identity };
    }

    getCharacterFields(): Record<string, string> {
        return { ...this.characterFields };
    }

    getPersonaDescription(): string {
        return this.personaDescription;
    }

    async listEnabledLorebooks(): Promise<Map<string, RawLoreEntry[]>> {
        const result = new Map<string, RawLoreEntry[]>();
        for (const [world, entries] of this.lorebooks.entries()) {
            result.set(world, entries.map((entry) => ({ ...entry })));
        }
        return result;
    }

    substituteMacros(text: string, overrides?: Record<string, string>): string {
        if (!text) {
            return '';
        }

        const variables = this.getMetadataVariables();
        const globalVariables = this.getMetadataGlobalVariables();

        let rendered = text.replace(/\{\{user\}\}/gi, overrides?.user ?? this.identity.userName);
        rendered = rendered.replace(/\{\{char\}\}/gi, overrides?.char ?? this.identity.charName);

        rendered = rendered.replace(/\{\{getvar::([^}]+)\}\}/gi, (_match, rawName: string) => {
            const key = rawName.trim();
            if (overrides && Object.hasOwn(overrides, key)) {
                return overrides[key];
            }
            if (overrides && Object.hasOwn(overrides, `var:${key}`)) {
                return overrides[`var:${key}`];
            }
            return stringifyVariable(variables[key]);
        });

        rendered = rendered.replace(/\{\{getglobalvar::([^}]+)\}\}/gi, (_match, rawName: string) => {
            const key = rawName.trim();
            return stringifyVariable(globalVariables[key]);
        });

        if (overrides) {
            rendered = rendered.replace(/\{\{([a-zA-Z0-9_.:-]+)\}\}/g, (match, key: string) => {
                if (Object.hasOwn(overrides, key)) {
                    return overrides[key];
                }
                return match;
            });
        }

        return rendered;
    }

    async attachMediaToMessage(target: MessageTarget, media: MediaAttachment): Promise<void> {
        this.mediaAttachments.push({
            target: { ...target },
            media: { ...media },
        });
    }

    async refreshMessageView(target: MessageTarget): Promise<void> {
        this.refreshedViews.push({ ...target });
    }

    async loadExtensionData<T>(key: string, fallback: T): Promise<T> {
        if (!this.extensionData.has(key)) {
            return structuredClone(fallback);
        }
        return structuredClone(this.extensionData.get(key) as T);
    }

    async saveExtensionData<T>(key: string, value: T): Promise<void> {
        this.extensionData.set(key, structuredClone(value));
    }

    async hashText(text: string): Promise<string> {
        return computeXxHash(text);
    }

    getHostLuminance(): 'dark' | 'light' {
        return this.hostLuminance;
    }

    emitHostEvent(event: string, payload?: unknown): void {
        this.emittedEvents.push({ event, payload });
    }

    // --- Test helper methods ---

    pushMessage(
        partial: Omit<ChatMessageSnapshot, 'id' | 'swipeId'> & { id?: number; swipeId?: number },
    ): ChatMessageSnapshot {
        const id = partial.id ?? this.chat.length;
        const snapshot: ChatMessageSnapshot = {
            ...partial,
            id,
            swipeId: partial.swipeId ?? 0,
            swipes: partial.swipes ? [...partial.swipes] : [partial.mes],
            swipeInfo: partial.swipeInfo ? [...partial.swipeInfo] : [{}],
        };
        this.chat[id] = snapshot;
        return snapshot;
    }

    setLorebook(world: string, entries: RawLoreEntry[]): void {
        this.lorebooks.set(world, [...entries]);
    }

    setCharacterFields(fields: Record<string, string>): void {
        this.characterFields = { ...fields };
    }

    setPersonaDescription(desc: string): void {
        this.personaDescription = desc;
    }

    setVariable(name: string, value: unknown): void {
        const vars = this.getMetadataVariables();
        vars[name] = value;
        this.metadata.variables = vars;
    }

    setEjsEvaluator(fn?: EjsEvaluatorStub): void {
        if (!fn) {
            delete this.evaluateOptionalEjs;
            return;
        }
        this.evaluateOptionalEjs = async (text: string, vars: Record<string, unknown>) => fn(text, vars);
    }

    setSlashHandler(fn?: SlashCommandStub): void {
        this.slashHandler = fn;
        if (!fn) {
            delete this.executeSlashCommand;
            return;
        }
        this.executeSlashCommand = async (command: string, signal?: AbortSignal) => {
            if (signal?.aborted) {
                this.slashCalls.push({ command, aborted: true });
                throw createAbortError();
            }
            const result = await this.slashHandler!(command, signal);
            this.slashCalls.push({ command, aborted: Boolean(signal?.aborted) });
            return result;
        };
    }

    private getMetadataVariables(): Record<string, unknown> {
        const raw = this.metadata.variables;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as Record<string, unknown>;
        }
        const created: Record<string, unknown> = {};
        this.metadata.variables = created;
        return created;
    }

    private getMetadataGlobalVariables(): Record<string, unknown> {
        const raw = this.metadata.globalVariables;
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            return raw as Record<string, unknown>;
        }
        return {};
    }
}

function stringifyVariable(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    return JSON.stringify(value);
}

function createAbortError(): Error {
    const err = new Error('Operation aborted');
    err.name = 'AbortError';
    return err;
}
