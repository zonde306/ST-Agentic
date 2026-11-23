import { Fragment, type ComponentChildren, type TargetedMouseEvent } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
    type MarkdownBlockNode,
    type MarkdownInlineNode,
    parseMarkdownBlocks,
} from './markdown-parser';

export interface MarkdownContentProps {
    content: string;
    class?: string;
}

const REDACTED_MARKER = '***REDACTED***';

function renderRedactedCodeText(text: string): ComponentChildren {
    if (!text) {
        return '';
    }
    const parts = text.split(REDACTED_MARKER);
    if (parts.length === 1) {
        return text;
    }
    return parts.map((part, idx) => (
        <Fragment key={`code-red-${idx}`}>
            {part}
            {idx < parts.length - 1 ? (
                <span class="ag-redacted-token">{REDACTED_MARKER}</span>
            ) : null}
        </Fragment>
    ));
}

async function copyCodeToClipboard(text: string, anchor: HTMLElement | null): Promise<boolean> {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            // Fall through to execCommand fallback.
        }
    }

    if (typeof document === 'undefined') {
        return false;
    }
    const container = anchor?.parentElement ?? document.body;
    if (!container) {
        return false;
    }

    const textarea = document.createElement('textarea');
    try {
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        textarea.style.top = '-9999px';
        textarea.style.opacity = '0';
        container.appendChild(textarea);
        textarea.select();
        return typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch {
        return false;
    } finally {
        textarea.remove();
    }
}

interface MarkdownCodeBlockProps {
    lang?: string;
    code: string;
}

function MarkdownCodeBlock({ lang, code }: MarkdownCodeBlockProps) {
    const [copied, setCopied] = useState<boolean>(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) {
                clearTimeout(timerRef.current);
            }
        };
    }, []);

    const handleCopy = async (event: TargetedMouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        await copyCodeToClipboard(code, event.currentTarget);
        setCopied(true);
        if (timerRef.current) {
            clearTimeout(timerRef.current);
        }
        timerRef.current = setTimeout(() => {
            setCopied(false);
        }, 1500);
    };

    return (
        <div class="ag-md-code-block" data-md-code-block="true">
            <div class="ag-md-code-header">
                <span class="ag-md-code-lang">{lang || 'code'}</span>
                <button
                    type="button"
                    class="ag-md-code-copy"
                    data-md-code-copy="true"
                    aria-label={copied ? '已复制代码' : '复制代码'}
                    onClick={(e) => void handleCopy(e)}
                >
                    {copied ? '✓ 已复制' : '复制'}
                </button>
            </div>
            <pre class="ag-md-pre ag-thin-scroll">
                <code>{renderRedactedCodeText(code)}</code>
            </pre>
        </div>
    );
}

function renderInlineNodes(nodes: readonly MarkdownInlineNode[], keyPrefix: string): ComponentChildren {
    return nodes.map((node, idx) => {
        const key = `${keyPrefix}-${idx}`;
        switch (node.type) {
            case 'text':
                return <Fragment key={key}>{node.text}</Fragment>;
            case 'code':
                return (
                    <code key={key} class="ag-md-inline-code">
                        {renderRedactedCodeText(node.code)}
                    </code>
                );
            case 'strong':
                return (
                    <strong key={key} class="ag-md-strong">
                        {renderInlineNodes(node.children, key)}
                    </strong>
                );
            case 'em':
                return (
                    <em key={key} class="ag-md-em">
                        {renderInlineNodes(node.children, key)}
                    </em>
                );
            case 'del':
                return (
                    <del key={key} class="ag-md-del">
                        {renderInlineNodes(node.children, key)}
                    </del>
                );
            case 'link':
                return (
                    <a
                        key={key}
                        class="ag-md-link"
                        href={node.href}
                        title={node.title}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {renderInlineNodes(node.children, key)}
                    </a>
                );
            case 'image':
                return (
                    <img
                        key={key}
                        class="ag-md-img"
                        src={node.src}
                        alt={node.alt}
                        title={node.title}
                        loading="lazy"
                    />
                );
            case 'redacted':
                return (
                    <span key={key} class="ag-redacted-token">
                        {REDACTED_MARKER}
                    </span>
                );
            case 'break':
                return <br key={key} />;
        }
    });
}

function renderHeading(
    level: 1 | 2 | 3 | 4 | 5 | 6,
    children: readonly MarkdownInlineNode[],
    key: string,
): ComponentChildren {
    const rendered = renderInlineNodes(children, key);
    const cls = `ag-md-h ag-md-h${level}`;
    switch (level) {
        case 1:
            return <h1 key={key} class={cls}>{rendered}</h1>;
        case 2:
            return <h2 key={key} class={cls}>{rendered}</h2>;
        case 3:
            return <h3 key={key} class={cls}>{rendered}</h3>;
        case 4:
            return <h4 key={key} class={cls}>{rendered}</h4>;
        case 5:
            return <h5 key={key} class={cls}>{rendered}</h5>;
        case 6:
            return <h6 key={key} class={cls}>{rendered}</h6>;
    }
}

function renderBlockNodes(blocks: readonly MarkdownBlockNode[], keyPrefix: string): ComponentChildren {
    return blocks.map((block, idx) => {
        const key = `${keyPrefix}-b${idx}`;
        switch (block.type) {
            case 'heading':
                return renderHeading(block.level, block.children, key);
            case 'paragraph':
                return (
                    <p key={key} class="ag-md-p">
                        {renderInlineNodes(block.children, key)}
                    </p>
                );
            case 'code_block':
                return <MarkdownCodeBlock key={key} lang={block.lang} code={block.code} />;
            case 'blockquote':
                return (
                    <blockquote key={key} class="ag-md-blockquote">
                        {renderBlockNodes(block.blocks, key)}
                    </blockquote>
                );
            case 'hr':
                return <hr key={key} class="ag-md-hr" />;
            case 'list': {
                const items = block.items.map((item, itemIdx) => {
                    const itemKey = `${key}-i${itemIdx}`;
                    if (item.checked !== undefined) {
                        return (
                            <li key={itemKey} class="ag-md-li ag-md-task-item">
                                <input
                                    type="checkbox"
                                    class="ag-md-checkbox"
                                    checked={item.checked}
                                    disabled
                                    aria-label={item.checked ? '已完成' : '未完成'}
                                />
                                <div class="ag-md-task-body">
                                    {renderBlockNodes(item.blocks, itemKey)}
                                </div>
                            </li>
                        );
                    }
                    return (
                        <li key={itemKey} class="ag-md-li">
                            {renderBlockNodes(item.blocks, itemKey)}
                        </li>
                    );
                });

                if (block.ordered) {
                    return (
                        <ol
                            key={key}
                            class="ag-md-list ag-md-ol"
                            start={block.start !== 1 ? block.start : undefined}
                        >
                            {items}
                        </ol>
                    );
                }
                return (
                    <ul key={key} class="ag-md-list ag-md-ul">
                        {items}
                    </ul>
                );
            }
            case 'table':
                return (
                    <div key={key} class="ag-md-table-wrap ag-thin-scroll" data-md-table="true">
                        <table class="ag-md-table">
                            <thead>
                                <tr>
                                    {block.headers.map((cell, colIdx) => (
                                        <th
                                            key={`${key}-th-${colIdx}`}
                                            style={
                                                block.aligns[colIdx]
                                                    ? { textAlign: block.aligns[colIdx]! }
                                                    : undefined
                                            }
                                        >
                                            {renderInlineNodes(cell, `${key}-th-${colIdx}`)}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {block.rows.map((row, rowIdx) => (
                                    <tr key={`${key}-tr-${rowIdx}`}>
                                        {row.map((cell, colIdx) => (
                                            <td
                                                key={`${key}-td-${rowIdx}-${colIdx}`}
                                                style={
                                                    block.aligns[colIdx]
                                                        ? { textAlign: block.aligns[colIdx]! }
                                                        : undefined
                                                }
                                            >
                                                {renderInlineNodes(
                                                    cell,
                                                    `${key}-td-${rowIdx}-${colIdx}`,
                                                )}
                                            </td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                );
        }
    });
}

/**
 * Safely render GFM Markdown into pure Preact VNodes without `dangerouslySetInnerHTML`.
 */
export function MarkdownContent({ content, class: className }: MarkdownContentProps) {
    const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
    if (!content) {
        return null;
    }
    return (
        <div class={className ? `ag-md ${className}` : 'ag-md'}>
            {renderBlockNodes(blocks, 'md')}
        </div>
    );
}
