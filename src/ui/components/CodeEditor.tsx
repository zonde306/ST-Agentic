import type {
    ComponentChild,
    TargetedCompositionEvent,
    TargetedEvent,
    TargetedKeyboardEvent,
} from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Button } from './CommonControls';
import { IconCheck, IconCopy, IconKeyboard } from './Icons';
import {
    MAX_HIGHLIGHT_CHARS,
    isHighlightLanguage,
    tokenizeCode,
    type HighlightLanguage,
} from './syntax-highlight';

export interface CodeSnippet {
    label: string;
    insertText: string;
    title?: string;
}

export const DEFAULT_CODE_SNIPPETS: readonly CodeSnippet[] = [
    { label: '{{user}}', insertText: '{{user}}', title: '插入用户名宏' },
    { label: '{{char}}', insertText: '{{char}}', title: '插入角色名宏' },
    { label: '{{file::}}', insertText: '{{file::}}', title: '插入 VFS 文件引用宏' },
    { label: '{ }', insertText: '{}', title: '插入花括号' },
    { label: '[ ]', insertText: '[]', title: '插入方括号' },
];

export interface CodeEditorProps {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    label?: string;
    languageHint?: 'json' | 'javascript' | 'markdown' | 'yaml' | 'regex' | 'text';
    placeholder?: string;
    rows?: number;
    minHeight?: string;
    readOnly?: boolean;
    disabled?: boolean;
    showToolbar?: boolean;
    snippets?: readonly CodeSnippet[];
    ariaLabel?: string;
    className?: string;
    /**
     * Syntax highlight overlay for `javascript` / `json` / `markdown` hints (default `true`).
     * Uses a zero-dependency tokenizer rendered into an `aria-hidden` `<pre>` behind-the-glass;
     * the real `<textarea>` stays in charge of input, IME, selection and accessibility.
     */
    highlight?: boolean;
}

function renderHighlightedNodes(code: string, lang: HighlightLanguage): ComponentChild[] {
    const nodes: ComponentChild[] = tokenizeCode(code, lang).map((token, index) =>
        token.type ? (
            <span key={index} class={`ag-tok-${token.type}`}>
                {token.text}
            </span>
        ) : (
            token.text
        ),
    );
    // A trailing space keeps the final (possibly empty) line box so scroll heights match the textarea.
    nodes.push(' ');
    return nodes;
}

/**
 * Mobile Chinese IME-safe `<textarea>` code/JSON/prompt editor.
 * - Avoids Monaco Editor for zero bundle bloat and full mobile IME fidelity.
 * - Never overwrites DOM value mid-IME composition (`compositionstart` .. `compositionend`).
 * - Enforces `>= 16px` font size and `>= 40x40px` toolbar touch targets.
 * - Lightweight syntax highlighting: transparent-text textarea over a glyph-aligned `<pre>` mirror.
 */
export function CodeEditor({
    id,
    value,
    onChange,
    label,
    languageHint,
    placeholder,
    rows = 10,
    minHeight = '220px',
    readOnly = false,
    disabled = false,
    showToolbar = true,
    snippets = DEFAULT_CODE_SNIPPETS,
    ariaLabel,
    className,
    highlight = true,
}: CodeEditorProps) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const highlightRef = useRef<HTMLPreElement | null>(null);
    const isComposingRef = useRef<boolean>(false);
    const [copied, setCopied] = useState(false);
    // Live mirror of the DOM value (including in-flight IME composition text) for the overlay.
    const [mirror, setMirror] = useState<string>(value);

    const highlightLang: HighlightLanguage | null =
        highlight && isHighlightLanguage(languageHint) && mirror.length <= MAX_HIGHLIGHT_CHARS
            ? languageHint
            : null;

    const highlightedNodes = useMemo(
        () => (highlightLang ? renderHighlightedNodes(mirror, highlightLang) : null),
        [mirror, highlightLang],
    );

    /** Keeps the overlay box equal to the textarea's padding box (excludes scrollbars) and scroll-locked. */
    const syncOverlay = useCallback(() => {
        const el = textareaRef.current;
        const pre = highlightRef.current;
        if (!el || !pre) {
            return;
        }
        pre.style.width = `${el.clientWidth}px`;
        pre.style.height = `${el.clientHeight}px`;
        pre.style.top = `${el.clientTop}px`;
        pre.style.left = `${el.clientLeft}px`;
        pre.scrollTop = el.scrollTop;
        pre.scrollLeft = el.scrollLeft;
    }, []);

    useLayoutEffect(() => {
        if (highlightLang) {
            syncOverlay();
        }
    }, [highlightLang, highlightedNodes, syncOverlay]);

    useEffect(() => {
        const el = textareaRef.current;
        if (!highlightLang || !el || typeof ResizeObserver === 'undefined') {
            return undefined;
        }
        const observer = new ResizeObserver(() => syncOverlay());
        observer.observe(el);
        return () => observer.disconnect();
    }, [highlightLang, syncOverlay]);

    // Sync external `value` prop only when user is NOT mid-IME composition.
    // The mount pass is skipped (`defaultValue` already seeded the DOM): Preact runs pending
    // effects lazily, so a mount-time sync could otherwise clobber keystrokes typed before it ran.
    const lastSyncedValueRef = useRef<string>(value);
    useEffect(() => {
        const el = textareaRef.current;
        if (!el || isComposingRef.current || value === lastSyncedValueRef.current) {
            return;
        }
        lastSyncedValueRef.current = value;
        if (el.value !== value) {
            el.value = value;
        }
        setMirror(el.value);
    }, [value]);

    const handleCompositionStart = () => {
        isComposingRef.current = true;
    };

    const handleCompositionEnd = (event: TargetedCompositionEvent<HTMLTextAreaElement>) => {
        isComposingRef.current = false;
        setMirror(event.currentTarget.value);
        onChange(event.currentTarget.value);
    };

    const handleInput = (event: TargetedEvent<HTMLTextAreaElement, Event>) => {
        // The overlay must follow every keystroke, including uncommitted IME text,
        // because the textarea's own glyphs are transparent while highlighting.
        setMirror(event.currentTarget.value);
        const nativeEvt = event as unknown as { isComposing?: boolean };
        if (isComposingRef.current || nativeEvt.isComposing) {
            return;
        }
        onChange(event.currentTarget.value);
    };

    const applyEdit = useCallback(
        (transform: (current: string, start: number, end: number) => {
            nextText: string;
            nextStart: number;
            nextEnd: number;
        }) => {
            const el = textareaRef.current;
            if (!el || readOnly || disabled || isComposingRef.current) {
                return;
            }
            const current = el.value;
            const start = el.selectionStart ?? current.length;
            const end = el.selectionEnd ?? current.length;
            const { nextText, nextStart, nextEnd } = transform(current, start, end);
            el.value = nextText;
            el.focus();
            el.setSelectionRange(nextStart, nextEnd);
            setMirror(nextText);
            onChange(nextText);
        },
        [disabled, onChange, readOnly],
    );

    const indentSelection = useCallback(() => {
        applyEdit((current, start, end) => {
            if (start === end) {
                const nextText = `${current.slice(0, start)}  ${current.slice(end)}`;
                return { nextText, nextStart: start + 2, nextEnd: start + 2 };
            }
            const lineStart = current.lastIndexOf('\n', start - 1) + 1;
            const block = current.slice(lineStart, end);
            const lines = block.split('\n');
            const indented = lines.map((line) => `  ${line}`).join('\n');
            const nextText = current.slice(0, lineStart) + indented + current.slice(end);
            return {
                nextText,
                nextStart: start + 2,
                nextEnd: end + lines.length * 2,
            };
        });
    }, [applyEdit]);

    const outdentSelection = useCallback(() => {
        applyEdit((current, start, end) => {
            const lineStart = current.lastIndexOf('\n', start - 1) + 1;
            const block = current.slice(lineStart, end);
            const lines = block.split('\n');
            let removedBeforeStart = 0;
            let totalRemoved = 0;

            const outdented = lines
                .map((line, index) => {
                    let removeCount = 0;
                    if (line.startsWith('  ')) {
                        removeCount = 2;
                    } else if (line.startsWith('\t') || line.startsWith(' ')) {
                        removeCount = 1;
                    }
                    if (index === 0) {
                        removedBeforeStart = removeCount;
                    }
                    totalRemoved += removeCount;
                    return line.slice(removeCount);
                })
                .join('\n');

            const nextText = current.slice(0, lineStart) + outdented + current.slice(end);
            return {
                nextText,
                nextStart: Math.max(lineStart, start - removedBeforeStart),
                nextEnd: Math.max(lineStart, end - totalRemoved),
            };
        });
    }, [applyEdit]);

    const insertSnippet = useCallback(
        (insertText: string) => {
            applyEdit((current, start, end) => {
                const nextText = current.slice(0, start) + insertText + current.slice(end);
                const cursor =
                    insertText === '{}' || insertText === '[]'
                        ? start + 1
                        : insertText === '{{file::}}'
                            ? start + insertText.length - 2
                            : start + insertText.length;
                return { nextText, nextStart: cursor, nextEnd: cursor };
            });
        },
        [applyEdit],
    );

    const handleKeyDown = (event: TargetedKeyboardEvent<HTMLTextAreaElement>) => {
        if (isComposingRef.current) {
            return;
        }
        if (event.key === 'Tab' && !readOnly && !disabled) {
            event.preventDefault();
            if (event.shiftKey) {
                outdentSelection();
            } else {
                indentSelection();
            }
        }
    };

    const handleCopy = async () => {
        const text = textareaRef.current?.value ?? value;
        try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
            }
        } catch {
            // Clipboard permission may be unavailable in restricted contexts.
        }
    };

    const handleCollapseKeyboard = () => {
        textareaRef.current?.blur();
    };

    return (
        <div class={className ? `ag-code-editor ${className}` : 'ag-code-editor'}>
            {(label || languageHint) ? (
                <div class="ag-code-meta">
                    {label ? <span class="ag-code-label">{label}</span> : <span />}
                    {languageHint ? (
                        <span class="ag-code-lang">{languageHint.toUpperCase()}</span>
                    ) : null}
                </div>
            ) : null}

            {showToolbar ? (
                <div class="ag-code-toolbar ag-thin-scroll" role="toolbar" aria-label="编辑器快捷栏">
                    {!readOnly && !disabled ? (
                        <>
                            <Button
                                size="sm"
                                variant="secondary"
                                title="向右缩进 2 空格 (Tab)"
                                onClick={indentSelection}
                            >
                                缩进
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                title="向左反缩进 (Shift+Tab)"
                                onClick={outdentSelection}
                            >
                                反缩进
                            </Button>
                            {snippets.map((snippet) => (
                                <Button
                                    key={snippet.label}
                                    size="sm"
                                    variant="ghost"
                                    title={snippet.title ?? snippet.insertText}
                                    onClick={() => insertSnippet(snippet.insertText)}
                                >
                                    {snippet.label}
                                </Button>
                            ))}
                        </>
                    ) : null}
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                        title="复制内容"
                        onClick={() => void handleCopy()}
                    >
                        {copied ? '已复制' : '复制'}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        icon={<IconKeyboard size={14} />}
                        title="收起移动键盘"
                        onClick={handleCollapseKeyboard}
                    >
                        收起键盘
                    </Button>
                </div>
            ) : null}

            <div class="ag-code-surface" data-highlight={highlightLang ?? undefined}>
                <textarea
                    ref={textareaRef}
                    id={id}
                    defaultValue={value}
                    rows={rows}
                    placeholder={placeholder}
                    readOnly={readOnly}
                    disabled={disabled}
                    spellcheck={false}
                    autocapitalize="off"
                    autocomplete="off"
                    aria-label={ariaLabel ?? label ?? '代码编辑区'}
                    class={
                        highlightLang
                            ? 'ag-code-textarea ag-code-textarea-hl ag-thin-scroll'
                            : 'ag-code-textarea ag-thin-scroll'
                    }
                    style={{ minHeight }}
                    onCompositionStart={handleCompositionStart}
                    onCompositionEnd={handleCompositionEnd}
                    onInput={handleInput}
                    onKeyDown={handleKeyDown}
                    onScroll={highlightLang ? syncOverlay : undefined}
                />
                {highlightLang ? (
                    <pre ref={highlightRef} class="ag-code-highlight" aria-hidden="true">
                        <code>{highlightedNodes}</code>
                    </pre>
                ) : null}
            </div>
        </div>
    );
}
