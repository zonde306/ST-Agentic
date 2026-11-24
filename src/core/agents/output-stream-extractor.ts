import { normalizeVfsPath } from '@/core/utils';

export interface IncrementalOutputStreamExtractorOptions {
    initialOutput?: string;
    onPreview?: (fullText: string) => void;
}

export interface ToolCallDeltaInput {
    name?: string;
    argumentsDelta?: string;
}

type TargetToolName = 'write_file' | 'append_file';

type JsonParserPhase =
    | 'wait_root_open'
    | 'top_expect_key_or_end'
    | 'top_after_key'
    | 'top_expect_value'
    | 'top_in_primitive'
    | 'top_after_value'
    | 'nested_value'
    | 'in_string'
    | 'done'
    | 'malformed';

type StringTarget = 'top_key' | 'path' | 'content' | 'skip';
type StringReturnPhase = 'top_after_key' | 'top_after_value' | 'nested_value';
type EscapeMode = 'none' | 'backslash' | 'unicode';
type PathMatchStatus = 'pending' | 'matched' | 'ignored';

interface ToolCallParserState {
    name: string;
    pendingRawArgs: string;
    phase: JsonParserPhase;
    depth: number;
    currentKey: string;
    keyBuffer: string;
    pathBuffer: string;
    decodedContent: string;
    pathStatus: PathMatchStatus;
    stringTarget: StringTarget;
    stringReturnPhase: StringReturnPhase;
    escapeMode: EscapeMode;
    unicodeHex: string;
    pendingHighSurrogate: number | null;
    lastEmittedPreview: string | null;
    committed: boolean;
}

const TARGET_OUTPUT_PATH = '/output.md';
const TARGET_TOOL_NAMES: readonly TargetToolName[] = ['write_file', 'append_file'];

function isTargetToolName(name: string): name is TargetToolName {
    return name === 'write_file' || name === 'append_file';
}

function isTargetToolPrefix(name: string): boolean {
    if (!name) {
        return true;
    }
    return TARGET_TOOL_NAMES.some((target) => target.startsWith(name));
}

function isJsonWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isHexDigit(ch: string): boolean {
    const code = ch.charCodeAt(0);
    return (
        (code >= 48 && code <= 57) // 0-9
        || (code >= 65 && code <= 70) // A-F
        || (code >= 97 && code <= 102) // a-f
    );
}

function createInitialCallState(): ToolCallParserState {
    return {
        name: '',
        pendingRawArgs: '',
        phase: 'wait_root_open',
        depth: 0,
        currentKey: '',
        keyBuffer: '',
        pathBuffer: '',
        decodedContent: '',
        pathStatus: 'pending',
        stringTarget: 'skip',
        stringReturnPhase: 'top_after_value',
        escapeMode: 'none',
        unicodeHex: '',
        pendingHighSurrogate: null,
        lastEmittedPreview: null,
        committed: false,
    };
}

/**
 * Incrementally parses streaming `write_file` / `append_file` tool-call JSON arguments
 * to surface live `/output.md` text previews and salvage un-committed output on interruption.
 */
export class IncrementalOutputStreamExtractor {
    private readonly onPreview?: (fullText: string) => void;
    private readonly calls = new Map<number, ToolCallParserState>();
    private baseOutput: string;
    private lastSalvageableIndex: number | null = null;

    constructor(options?: IncrementalOutputStreamExtractorOptions) {
        this.baseOutput = options?.initialOutput ?? '';
        this.onPreview = options?.onPreview;
    }

    /** Reset per-round tool call parsers and update the committed `/output.md` baseline. */
    resetRound(currentCommittedOutput: string): void {
        this.calls.clear();
        this.lastSalvageableIndex = null;
        this.baseOutput = currentCommittedOutput;
    }

    /** Clear pending un-committed preview state after a tool executes and update the baseline. */
    markToolExecuted(committedOutput: string): void {
        this.lastSalvageableIndex = null;
        this.baseOutput = committedOutput;
        for (const call of this.calls.values()) {
            call.committed = true;
        }
    }

    /** Feed an incremental tool-call delta for `index` and emit live `/output.md` previews. */
    feedToolCallDelta(index: number, delta: ToolCallDeltaInput): void {
        let call = this.calls.get(index);
        if (!call) {
            call = createInitialCallState();
            this.calls.set(index, call);
        }

        if (delta.name) {
            if (!call.name) {
                call.name = delta.name;
            } else if (delta.name === call.name || delta.name.startsWith(call.name)) {
                call.name = delta.name;
            } else {
                call.name += delta.name;
            }
        }

        if (call.committed || call.pathStatus === 'ignored') {
            return;
        }

        const chunk = delta.argumentsDelta ?? '';
        if (!isTargetToolName(call.name)) {
            if (!isTargetToolPrefix(call.name)) {
                call.pathStatus = 'ignored';
                call.pendingRawArgs = '';
                call.decodedContent = '';
                return;
            }
            if (chunk) {
                call.pendingRawArgs += chunk;
            }
            return;
        }

        const toProcess = call.pendingRawArgs ? `${call.pendingRawArgs}${chunk}` : chunk;
        call.pendingRawArgs = '';

        if (!toProcess) {
            return;
        }

        this.consumeArgumentsChunk(call, toProcess);

        if (
            !call.committed
            && call.pathStatus === 'matched'
            && call.decodedContent.length > 0
        ) {
            const preview = this.composePreview(call);
            this.lastSalvageableIndex = index;
            if (preview !== call.lastEmittedPreview) {
                call.lastEmittedPreview = preview;
                this.onPreview?.(preview);
            }
        }
    }

    /**
     * Return the latest un-committed `/output.md` preview text if an active tool call has
     * confirmed `path === '/output.md'` with non-empty/new decoded content; otherwise `null`.
     */
    getSalvageableOutput(): string | null {
        if (this.lastSalvageableIndex === null) {
            return null;
        }
        const call = this.calls.get(this.lastSalvageableIndex);
        if (
            !call
            || call.committed
            || call.pathStatus !== 'matched'
            || call.decodedContent.length === 0
        ) {
            return null;
        }
        return this.composePreview(call);
    }

    private composePreview(call: ToolCallParserState): string {
        return call.name === 'append_file'
            ? `${this.baseOutput}${call.decodedContent}`
            : call.decodedContent;
    }

    private consumeArgumentsChunk(call: ToolCallParserState, chunk: string): void {
        for (let i = 0; i < chunk.length; i += 1) {
            if (
                call.pathStatus === 'ignored'
                || call.phase === 'done'
                || call.phase === 'malformed'
            ) {
                return;
            }

            const ch = chunk[i];

            if (call.phase === 'in_string') {
                this.processStringChar(call, ch);
                continue;
            }

            switch (call.phase) {
                case 'wait_root_open': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '{') {
                        call.depth = 1;
                        call.phase = 'top_expect_key_or_end';
                    } else {
                        call.phase = 'malformed';
                    }
                    break;
                }

                case 'top_expect_key_or_end': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '}') {
                        call.depth = 0;
                        call.phase = 'done';
                    } else if (ch === '"') {
                        this.enterString(call, 'top_key', 'top_after_key');
                    } else {
                        call.phase = 'malformed';
                    }
                    break;
                }

                case 'top_after_key': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === ':') {
                        call.phase = 'top_expect_value';
                    } else {
                        call.phase = 'malformed';
                    }
                    break;
                }

                case 'top_expect_value': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '"') {
                        if (call.currentKey === 'path') {
                            call.pathBuffer = '';
                            this.enterString(call, 'path', 'top_after_value');
                        } else if (call.currentKey === 'content') {
                            call.decodedContent = '';
                            call.lastEmittedPreview = null;
                            this.enterString(call, 'content', 'top_after_value');
                        } else {
                            this.enterString(call, 'skip', 'top_after_value');
                        }
                    } else if (ch === '{' || ch === '[') {
                        if (call.currentKey === 'path') {
                            this.markCallIgnored(call);
                            return;
                        }
                        call.depth = 2;
                        call.phase = 'nested_value';
                    } else if (ch === ',' || ch === '}' || ch === ']') {
                        call.phase = 'malformed';
                    } else {
                        if (call.currentKey === 'path') {
                            this.markCallIgnored(call);
                            return;
                        }
                        call.phase = 'top_in_primitive';
                    }
                    break;
                }

                case 'top_in_primitive': {
                    if (isJsonWhitespace(ch)) {
                        call.phase = 'top_after_value';
                    } else if (ch === ',') {
                        call.phase = 'top_expect_key_or_end';
                    } else if (ch === '}') {
                        call.depth = 0;
                        call.phase = 'done';
                    }
                    break;
                }

                case 'top_after_value': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === ',') {
                        call.phase = 'top_expect_key_or_end';
                    } else if (ch === '}') {
                        call.depth = 0;
                        call.phase = 'done';
                    } else {
                        call.phase = 'malformed';
                    }
                    break;
                }

                case 'nested_value': {
                    if (ch === '"') {
                        this.enterString(call, 'skip', 'nested_value');
                    } else if (ch === '{' || ch === '[') {
                        call.depth += 1;
                    } else if (ch === '}' || ch === ']') {
                        call.depth -= 1;
                        if (call.depth <= 1) {
                            call.depth = 1;
                            call.phase = 'top_after_value';
                        }
                    }
                    break;
                }
            }
        }
    }

    private enterString(
        call: ToolCallParserState,
        target: StringTarget,
        returnPhase: StringReturnPhase,
    ): void {
        call.phase = 'in_string';
        call.stringTarget = target;
        call.stringReturnPhase = returnPhase;
        call.escapeMode = 'none';
        call.unicodeHex = '';
        call.pendingHighSurrogate = null;
        if (target === 'top_key') {
            call.keyBuffer = '';
        }
    }

    private processStringChar(call: ToolCallParserState, ch: string): void {
        if (call.escapeMode === 'backslash') {
            switch (ch) {
                case '"':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x22);
                    return;
                case '\\':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x5c);
                    return;
                case '/':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x2f);
                    return;
                case 'b':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x08);
                    return;
                case 'f':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x0c);
                    return;
                case 'n':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x0a);
                    return;
                case 'r':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x0d);
                    return;
                case 't':
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, 0x09);
                    return;
                case 'u':
                    call.escapeMode = 'unicode';
                    call.unicodeHex = '';
                    return;
                default:
                    call.escapeMode = 'none';
                    this.emitCodeUnit(call, ch.charCodeAt(0));
                    return;
            }
        }

        if (call.escapeMode === 'unicode') {
            if (isHexDigit(ch)) {
                call.unicodeHex += ch;
                if (call.unicodeHex.length === 4) {
                    const codeUnit = Number.parseInt(call.unicodeHex, 16);
                    call.escapeMode = 'none';
                    call.unicodeHex = '';
                    this.emitCodeUnit(call, codeUnit);
                }
                return;
            }
            call.escapeMode = 'none';
            call.unicodeHex = '';
            call.phase = 'malformed';
            return;
        }

        if (ch === '\\') {
            call.escapeMode = 'backslash';
            return;
        }

        if (ch === '"') {
            if (call.pendingHighSurrogate !== null) {
                this.appendDecodedText(call, String.fromCharCode(call.pendingHighSurrogate));
                call.pendingHighSurrogate = null;
            }
            this.finishString(call);
            return;
        }

        this.emitCodeUnit(call, ch.charCodeAt(0));
    }

    private emitCodeUnit(call: ToolCallParserState, codeUnit: number): void {
        if (call.stringTarget === 'skip') {
            return;
        }

        if (call.pendingHighSurrogate !== null) {
            if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
                const pair = String.fromCharCode(call.pendingHighSurrogate, codeUnit);
                call.pendingHighSurrogate = null;
                this.appendDecodedText(call, pair);
                return;
            }
            this.appendDecodedText(call, String.fromCharCode(call.pendingHighSurrogate));
            call.pendingHighSurrogate = null;
        }

        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            call.pendingHighSurrogate = codeUnit;
            return;
        }

        this.appendDecodedText(call, String.fromCharCode(codeUnit));
    }

    private appendDecodedText(call: ToolCallParserState, text: string): void {
        if (call.stringTarget === 'top_key') {
            call.keyBuffer += text;
        } else if (call.stringTarget === 'path') {
            call.pathBuffer += text;
        } else if (call.stringTarget === 'content') {
            call.decodedContent += text;
        }
    }

    private finishString(call: ToolCallParserState): void {
        if (call.stringTarget === 'top_key') {
            call.currentKey = call.keyBuffer;
            call.keyBuffer = '';
        } else if (call.stringTarget === 'path') {
            let normalized: string | null = null;
            try {
                normalized = normalizeVfsPath(call.pathBuffer);
            } catch {
                normalized = null;
            }
            if (normalized === TARGET_OUTPUT_PATH) {
                call.pathStatus = 'matched';
            } else {
                this.markCallIgnored(call);
                return;
            }
        }
        call.phase = call.stringReturnPhase;
    }

    private markCallIgnored(call: ToolCallParserState): void {
        call.pathStatus = 'ignored';
        call.pathBuffer = '';
        call.decodedContent = '';
        call.lastEmittedPreview = null;
    }
}

export interface FinishTurnStreamExtractorOptions {
    /** Emitted with each newly decoded incremental slice of `finish_turn.response`. */
    onResponseDelta?: (delta: string) => void;
    /** Emitted with each newly decoded incremental slice of `finish_turn.step_brief`. */
    onStepBriefDelta?: (delta: string) => void;
    /** Invoked once per round when a parallel tool call (`index > 0`) suppresses streaming output. */
    onSuppressed?: () => void;
}

type FinishStringTarget = 'top_key' | 'response' | 'step_brief' | 'skip';

const FINISH_TURN_TOOL_NAME = 'finish_turn';

/**
 * Incrementally parses streaming `finish_turn` tool-call JSON arguments for tool slot `index === 0`,
 * decoding `response` and `step_brief` (including JSON escapes and UTF-16 `\uXXXX` surrogate pairs).
 * Immediately suppresses output if any parallel tool call (`index > 0`) appears in the same round.
 */
export class FinishTurnStreamExtractor {
    private readonly onResponseDelta?: (delta: string) => void;
    private readonly onStepBriefDelta?: (delta: string) => void;
    private readonly onSuppressed?: () => void;

    private name = '';
    private pendingRawArgs = '';
    private phase: JsonParserPhase = 'wait_root_open';
    private depth = 0;
    private currentKey = '';
    private keyBuffer = '';
    private decodedResponse = '';
    private decodedStepBrief = '';
    private stringTarget: FinishStringTarget = 'skip';
    private stringReturnPhase: StringReturnPhase = 'top_after_value';
    private escapeMode: EscapeMode = 'none';
    private unicodeHex = '';
    private pendingHighSurrogate: number | null = null;
    private suppressed = false;
    private ignored = false;

    private chunkResponseDelta = '';
    private chunkStepBriefDelta = '';

    constructor(options?: FinishTurnStreamExtractorOptions) {
        this.onResponseDelta = options?.onResponseDelta;
        this.onStepBriefDelta = options?.onStepBriefDelta;
        this.onSuppressed = options?.onSuppressed;
    }

    /** Reset all parser and suppression state for a fresh LLM round or retry attempt. */
    resetRound(): void {
        this.name = '';
        this.pendingRawArgs = '';
        this.phase = 'wait_root_open';
        this.depth = 0;
        this.currentKey = '';
        this.keyBuffer = '';
        this.decodedResponse = '';
        this.decodedStepBrief = '';
        this.stringTarget = 'skip';
        this.stringReturnPhase = 'top_after_value';
        this.escapeMode = 'none';
        this.unicodeHex = '';
        this.pendingHighSurrogate = null;
        this.suppressed = false;
        this.ignored = false;
        this.chunkResponseDelta = '';
        this.chunkStepBriefDelta = '';
    }

    /** Returns `true` once any parallel tool call slot (`index > 0`) has been observed this round. */
    isSuppressed(): boolean {
        return this.suppressed;
    }

    /** Returns `true` when slot `0` is confirmed as `'finish_turn'` and not suppressed. */
    isFinishTurnConfirmed(): boolean {
        return !this.suppressed && this.name === FINISH_TURN_TOOL_NAME;
    }

    /** Returns full decoded `response` accumulated so far, or `''` when suppressed. */
    getDecodedResponse(): string {
        return this.suppressed ? '' : this.decodedResponse;
    }

    /** Returns full decoded `step_brief` accumulated so far, or `''` when suppressed. */
    getDecodedStepBrief(): string {
        return this.suppressed ? '' : this.decodedStepBrief;
    }

    /** Feed an incremental tool-call delta for slot `index`. */
    feedToolCallDelta(index: number, delta: ToolCallDeltaInput): void {
        if (index > 0) {
            if (!this.suppressed) {
                this.suppressed = true;
                this.pendingRawArgs = '';
                this.onSuppressed?.();
            }
            return;
        }

        if (index !== 0 || this.suppressed || this.ignored) {
            return;
        }

        if (delta.name) {
            if (!this.name) {
                this.name = delta.name;
            } else if (delta.name === this.name || delta.name.startsWith(this.name)) {
                this.name = delta.name;
            } else {
                this.name += delta.name;
            }
        }

        const chunk = delta.argumentsDelta ?? '';
        if (this.name !== FINISH_TURN_TOOL_NAME) {
            if (this.name && !FINISH_TURN_TOOL_NAME.startsWith(this.name)) {
                this.ignored = true;
                this.pendingRawArgs = '';
                this.decodedResponse = '';
                this.decodedStepBrief = '';
                return;
            }
            if (chunk) {
                this.pendingRawArgs += chunk;
            }
            return;
        }

        const toProcess = this.pendingRawArgs ? `${this.pendingRawArgs}${chunk}` : chunk;
        this.pendingRawArgs = '';

        if (!toProcess) {
            return;
        }

        this.chunkResponseDelta = '';
        this.chunkStepBriefDelta = '';
        this.consumeArgumentsChunk(toProcess);

        if (this.chunkStepBriefDelta) {
            const deltaText = this.chunkStepBriefDelta;
            this.chunkStepBriefDelta = '';
            this.onStepBriefDelta?.(deltaText);
        }
        if (this.chunkResponseDelta) {
            const deltaText = this.chunkResponseDelta;
            this.chunkResponseDelta = '';
            this.onResponseDelta?.(deltaText);
        }
    }

    private consumeArgumentsChunk(chunk: string): void {
        for (let i = 0; i < chunk.length; i += 1) {
            if (this.phase === 'done' || this.phase === 'malformed') {
                return;
            }

            const ch = chunk[i];

            if (this.phase === 'in_string') {
                this.processStringChar(ch);
                continue;
            }

            switch (this.phase) {
                case 'wait_root_open': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '{') {
                        this.depth = 1;
                        this.phase = 'top_expect_key_or_end';
                    } else {
                        this.phase = 'malformed';
                    }
                    break;
                }

                case 'top_expect_key_or_end': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '}') {
                        this.depth = 0;
                        this.phase = 'done';
                    } else if (ch === '"') {
                        this.enterString('top_key', 'top_after_key');
                    } else {
                        this.phase = 'malformed';
                    }
                    break;
                }

                case 'top_after_key': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === ':') {
                        this.phase = 'top_expect_value';
                    } else {
                        this.phase = 'malformed';
                    }
                    break;
                }

                case 'top_expect_value': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === '"') {
                        if (this.currentKey === 'response') {
                            this.decodedResponse = '';
                            this.chunkResponseDelta = '';
                            this.enterString('response', 'top_after_value');
                        } else if (this.currentKey === 'step_brief') {
                            this.decodedStepBrief = '';
                            this.chunkStepBriefDelta = '';
                            this.enterString('step_brief', 'top_after_value');
                        } else {
                            this.enterString('skip', 'top_after_value');
                        }
                    } else if (ch === '{' || ch === '[') {
                        this.depth = 2;
                        this.phase = 'nested_value';
                    } else if (ch === ',' || ch === '}' || ch === ']') {
                        this.phase = 'malformed';
                    } else {
                        this.phase = 'top_in_primitive';
                    }
                    break;
                }

                case 'top_in_primitive': {
                    if (isJsonWhitespace(ch)) {
                        this.phase = 'top_after_value';
                    } else if (ch === ',') {
                        this.phase = 'top_expect_key_or_end';
                    } else if (ch === '}') {
                        this.depth = 0;
                        this.phase = 'done';
                    }
                    break;
                }

                case 'top_after_value': {
                    if (isJsonWhitespace(ch)) {
                        break;
                    }
                    if (ch === ',') {
                        this.phase = 'top_expect_key_or_end';
                    } else if (ch === '}') {
                        this.depth = 0;
                        this.phase = 'done';
                    } else {
                        this.phase = 'malformed';
                    }
                    break;
                }

                case 'nested_value': {
                    if (ch === '"') {
                        this.enterString('skip', 'nested_value');
                    } else if (ch === '{' || ch === '[') {
                        this.depth += 1;
                    } else if (ch === '}' || ch === ']') {
                        this.depth -= 1;
                        if (this.depth <= 1) {
                            this.depth = 1;
                            this.phase = 'top_after_value';
                        }
                    }
                    break;
                }
            }
        }
    }

    private enterString(target: FinishStringTarget, returnPhase: StringReturnPhase): void {
        this.phase = 'in_string';
        this.stringTarget = target;
        this.stringReturnPhase = returnPhase;
        this.escapeMode = 'none';
        this.unicodeHex = '';
        this.pendingHighSurrogate = null;
        if (target === 'top_key') {
            this.keyBuffer = '';
        }
    }

    private processStringChar(ch: string): void {
        if (this.escapeMode === 'backslash') {
            switch (ch) {
                case '"':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x22);
                    return;
                case '\\':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x5c);
                    return;
                case '/':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x2f);
                    return;
                case 'b':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x08);
                    return;
                case 'f':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x0c);
                    return;
                case 'n':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x0a);
                    return;
                case 'r':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x0d);
                    return;
                case 't':
                    this.escapeMode = 'none';
                    this.emitCodeUnit(0x09);
                    return;
                case 'u':
                    this.escapeMode = 'unicode';
                    this.unicodeHex = '';
                    return;
                default:
                    this.escapeMode = 'none';
                    this.emitCodeUnit(ch.charCodeAt(0));
                    return;
            }
        }

        if (this.escapeMode === 'unicode') {
            if (isHexDigit(ch)) {
                this.unicodeHex += ch;
                if (this.unicodeHex.length === 4) {
                    const codeUnit = Number.parseInt(this.unicodeHex, 16);
                    this.escapeMode = 'none';
                    this.unicodeHex = '';
                    this.emitCodeUnit(codeUnit);
                }
                return;
            }
            this.escapeMode = 'none';
            this.unicodeHex = '';
            this.phase = 'malformed';
            return;
        }

        if (ch === '\\') {
            this.escapeMode = 'backslash';
            return;
        }

        if (ch === '"') {
            if (this.pendingHighSurrogate !== null) {
                this.appendDecodedText(String.fromCharCode(this.pendingHighSurrogate));
                this.pendingHighSurrogate = null;
            }
            this.finishString();
            return;
        }

        this.emitCodeUnit(ch.charCodeAt(0));
    }

    private emitCodeUnit(codeUnit: number): void {
        if (this.stringTarget === 'skip') {
            return;
        }

        if (this.pendingHighSurrogate !== null) {
            if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
                const pair = String.fromCharCode(this.pendingHighSurrogate, codeUnit);
                this.pendingHighSurrogate = null;
                this.appendDecodedText(pair);
                return;
            }
            this.appendDecodedText(String.fromCharCode(this.pendingHighSurrogate));
            this.pendingHighSurrogate = null;
        }

        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            this.pendingHighSurrogate = codeUnit;
            return;
        }

        this.appendDecodedText(String.fromCharCode(codeUnit));
    }

    private appendDecodedText(text: string): void {
        if (this.stringTarget === 'top_key') {
            this.keyBuffer += text;
        } else if (this.stringTarget === 'response') {
            this.decodedResponse += text;
            this.chunkResponseDelta += text;
        } else if (this.stringTarget === 'step_brief') {
            this.decodedStepBrief += text;
            this.chunkStepBriefDelta += text;
        }
    }

    private finishString(): void {
        if (this.stringTarget === 'top_key') {
            this.currentKey = this.keyBuffer;
            this.keyBuffer = '';
        }
        this.phase = this.stringReturnPhase;
    }
}
