import { type ComponentChildren, Fragment, type TargetedMouseEvent } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ToastItem, ToastTone } from '../store/app-store';
import { IconAlertTriangle, IconCheck, IconClose, IconInfo, IconMore } from './Icons';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps {
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: ComponentChildren;
    disabled?: boolean;
    loading?: boolean;
    active?: boolean;
    type?: 'button' | 'submit' | 'reset';
    title?: string;
    ariaLabel?: string;
    className?: string;
    onClick?: (event: TargetedMouseEvent<HTMLButtonElement>) => void;
    children?: ComponentChildren;
}

export function Button({
    variant = 'secondary',
    size = 'md',
    icon,
    disabled = false,
    loading = false,
    active = false,
    type = 'button',
    title,
    ariaLabel,
    className,
    onClick,
    children,
}: ButtonProps) {
    const classes = [
        'ag-btn',
        `ag-btn-${variant}`,
        size === 'sm' ? 'ag-btn-sm' : 'ag-btn-md',
        active ? 'ag-btn-active' : '',
        className ?? '',
    ]
        .filter(Boolean)
        .join(' ');

    return (
        <button
            type={type}
            class={classes}
            disabled={disabled || loading}
            title={title}
            aria-label={ariaLabel}
            aria-busy={loading || undefined}
            onClick={onClick}
        >
            {icon ? <span class="ag-btn-icon">{icon}</span> : null}
            {children !== undefined && children !== null ? (
                <span class="ag-btn-label">{children}</span>
            ) : null}
        </button>
    );
}

export interface ToggleSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    description?: string;
    disabled?: boolean;
    className?: string;
}

export function ToggleSwitch({
    checked,
    onChange,
    label,
    description,
    disabled = false,
    className,
}: ToggleSwitchProps) {
    const handleToggle = () => {
        if (!disabled) {
            onChange(!checked);
        }
    };

    return (
        <div class={className ? `ag-switch-row ${className}` : 'ag-switch-row'}>
            {(label || description) ? (
                <div class="ag-switch-text" onClick={handleToggle}>
                    {label ? <span class="ag-switch-label">{label}</span> : null}
                    {description ? <span class="ag-switch-desc">{description}</span> : null}
                </div>
            ) : null}
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label ?? 'Toggle switch'}
                disabled={disabled}
                class={checked ? 'ag-switch ag-switch-on' : 'ag-switch'}
                onClick={handleToggle}
            >
                <span class="ag-switch-track">
                    <span class="ag-switch-thumb" />
                </span>
            </button>
        </div>
    );
}

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'error';

export interface BadgeProps {
    tone?: BadgeTone;
    className?: string;
    title?: string;
    children?: ComponentChildren;
}

function isPlainBadgeText(children: ComponentChildren): boolean {
    if (typeof children === 'string' || typeof children === 'number') {
        return true;
    }
    if (Array.isArray(children)) {
        return children.every(
            (child) =>
                typeof child === 'string'
                || typeof child === 'number'
                || child == null
                || typeof child === 'boolean',
        );
    }
    return false;
}

export function Badge({ tone = 'neutral', className, title, children }: BadgeProps) {
    const classes = ['ag-badge', `ag-badge-${tone}`, className ?? ''].filter(Boolean).join(' ');
    return (
        <span class={classes} title={title}>
            {isPlainBadgeText(children) ? <span class="ag-badge-text">{children}</span> : children}
        </span>
    );
}

export interface FormFieldProps {
    label: string;
    hint?: string;
    error?: string;
    htmlFor?: string;
    required?: boolean;
    className?: string;
    children?: ComponentChildren;
}

export function FormField({
    label,
    hint,
    error,
    htmlFor,
    required = false,
    className,
    children,
}: FormFieldProps) {
    return (
        <div class={className ? `ag-field ${className}` : 'ag-field'}>
            <label class="ag-field-label" for={htmlFor}>
                <span>{label}</span>
                {required ? <span class="ag-field-required">*</span> : null}
            </label>
            <div class="ag-field-control">{children}</div>
            {error ? (
                <div class="ag-field-error">{error}</div>
            ) : hint ? (
                <div class="ag-field-hint">{hint}</div>
            ) : null}
        </div>
    );
}

export interface TextInputProps {
    id?: string;
    type?: 'text' | 'password' | 'number' | 'search' | 'url';
    value: string | number;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    min?: number;
    max?: number;
    step?: number;
    ariaLabel?: string;
    className?: string;
    onInput?: (value: string) => void;
    onChange?: (value: string) => void;
}

export function TextInput({
    id,
    type = 'text',
    value,
    placeholder,
    disabled = false,
    readOnly = false,
    min,
    max,
    step,
    ariaLabel,
    className,
    onInput,
    onChange,
}: TextInputProps) {
    return (
        <input
            id={id}
            type={type as 'text'}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            min={min}
            max={max}
            step={step}
            aria-label={ariaLabel}
            class={className ? `ag-input ${className}` : 'ag-input'}
            onInput={(e) => onInput?.(e.currentTarget.value)}
            onChange={(e) => onChange?.(e.currentTarget.value)}
        />
    );
}

export interface SelectOption<T extends string = string> {
    value: T;
    label: string;
    disabled?: boolean;
}

export interface SelectInputProps<T extends string = string> {
    id?: string;
    value: T;
    options: readonly SelectOption<T>[];
    disabled?: boolean;
    ariaLabel?: string;
    className?: string;
    onChange: (value: T) => void;
}

export function SelectInput<T extends string = string>({
    id,
    value,
    options,
    disabled = false,
    ariaLabel,
    className,
    onChange,
}: SelectInputProps<T>) {
    return (
        <select
            id={id}
            value={value}
            disabled={disabled}
            aria-label={ariaLabel}
            class={className ? `ag-select ${className}` : 'ag-select'}
            onChange={(e) => onChange(e.currentTarget.value as T)}
        >
            {options.map((opt) => (
                <option key={opt.value} value={opt.value} disabled={opt.disabled}>
                    {opt.label}
                </option>
            ))}
        </select>
    );
}

export interface TextAreaInputProps {
    id?: string;
    value: string;
    rows?: number;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    ariaLabel?: string;
    className?: string;
    onInput?: (value: string) => void;
    onChange?: (value: string) => void;
}

export function TextAreaInput({
    id,
    value,
    rows = 4,
    placeholder,
    disabled = false,
    readOnly = false,
    ariaLabel,
    className,
    onInput,
    onChange,
}: TextAreaInputProps) {
    return (
        <textarea
            id={id}
            value={value}
            rows={rows}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={readOnly}
            aria-label={ariaLabel}
            class={className ? `ag-textarea ${className}` : 'ag-textarea'}
            onInput={(e) => onInput?.(e.currentTarget.value)}
            onChange={(e) => onChange?.(e.currentTarget.value)}
        />
    );
}

export interface SegmentedOption<T extends string = string> {
    value: T;
    label: string;
    title?: string;
    disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
    value: T;
    options: readonly SegmentedOption<T>[];
    onChange: (value: T) => void;
    ariaLabel?: string;
    className?: string;
}

export function SegmentedControl<T extends string = string>({
    value,
    options,
    onChange,
    ariaLabel,
    className,
}: SegmentedControlProps<T>) {
    return (
        <div
            class={className ? `ag-segmented ${className}` : 'ag-segmented'}
            role="radiogroup"
            aria-label={ariaLabel}
        >
            {options.map((opt) => {
                const selected = opt.value === value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-value={opt.value}
                        disabled={opt.disabled}
                        title={opt.title}
                        class={
                            selected
                                ? 'ag-segmented-item ag-segmented-item-active'
                                : 'ag-segmented-item'
                        }
                        onClick={() => onChange(opt.value)}
                    >
                        {opt.label}
                    </button>
                );
            })}
        </div>
    );
}

export interface CardProps {
    title?: ComponentChildren;
    subtitle?: ComponentChildren;
    actions?: ComponentChildren;
    className?: string;
    children?: ComponentChildren;
}

export function Card({ title, subtitle, actions, className, children }: CardProps) {
    return (
        <section class={className ? `ag-card ${className}` : 'ag-card'}>
            {(title || subtitle || actions) ? (
                <header class="ag-card-header">
                    <div class="ag-card-headings">
                        {title ? <h3 class="ag-card-title">{title}</h3> : null}
                        {subtitle ? <p class="ag-card-subtitle">{subtitle}</p> : null}
                    </div>
                    {actions ? <div class="ag-card-actions">{actions}</div> : null}
                </header>
            ) : null}
            <div class="ag-card-body">{children}</div>
        </section>
    );
}

export interface EmptyStateProps {
    icon?: ComponentChildren;
    title: string;
    description?: string;
    action?: ComponentChildren;
    className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
    return (
        <div class={className ? `ag-empty ${className}` : 'ag-empty'}>
            {icon ? <div class="ag-empty-icon">{icon}</div> : null}
            <div class="ag-empty-title">{title}</div>
            {description ? <div class="ag-empty-desc">{description}</div> : null}
            {action ? <div class="ag-empty-action">{action}</div> : null}
        </div>
    );
}

export interface ShadowModalProps {
    open: boolean;
    title: string;
    onClose: () => void;
    footer?: ComponentChildren;
    maxWidth?: string;
    closeLabel?: string;
    children?: ComponentChildren;
}

/**
 * Accessible modal overlay rendered strictly INSIDE the Shadow DOM root
 * (never creating nested native `<dialog>` elements or leaking into host DOM).
 */
export function ShadowModal({
    open,
    title,
    onClose,
    footer,
    maxWidth = '560px',
    closeLabel = '关闭',
    children,
}: ShadowModalProps) {
    useEffect(() => {
        if (!open) {
            return;
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onClose();
            }
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open, onClose]);

    if (!open) {
        return null;
    }

    return (
        <div
            class="ag-modal-backdrop"
            role="presentation"
            onClick={(e) => {
                if (e.target === e.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                class="ag-modal"
                role="dialog"
                aria-modal="true"
                aria-label={title}
                style={{ maxWidth }}
            >
                <div class="ag-modal-header">
                    <h2 class="ag-modal-title">{title}</h2>
                    <Button
                        variant="ghost"
                        size="sm"
                        ariaLabel={closeLabel}
                        title={closeLabel}
                        icon={<IconClose size={16} />}
                        onClick={onClose}
                    />
                </div>
                <div class="ag-modal-body ag-thin-scroll">{children}</div>
                {footer ? <div class="ag-modal-footer">{footer}</div> : null}
            </div>
        </div>
    );
}

export interface DropdownMenuItem {
    id: string;
    label: string;
    icon?: ComponentChildren;
    danger?: boolean;
    disabled?: boolean;
    /** Render a separator line above this item. */
    separatorBefore?: boolean;
    onSelect: () => void;
}

export interface DropdownMenuProps {
    items: readonly DropdownMenuItem[];
    ariaLabel: string;
    title?: string;
    /** Optional trigger text; defaults to an icon-only `⋯` trigger. */
    label?: ComponentChildren;
    icon?: ComponentChildren;
    variant?: ButtonVariant;
    size?: ButtonSize;
    align?: 'left' | 'right';
    className?: string;
}

/**
 * Lightweight overflow menu rendered inside the Shadow DOM (design spec §3.9).
 * Closes on outside pointer, `Escape`, or item selection.
 */
export function DropdownMenu({
    items,
    ariaLabel,
    title,
    label,
    icon,
    variant = 'ghost',
    size = 'sm',
    align = 'right',
    className,
}: DropdownMenuProps) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: Event) => {
            const wrap = wrapRef.current;
            if (wrap && !event.composedPath().includes(wrap)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
            }
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('keydown', onKeyDown, true);
        };
    }, [open]);

    return (
        <div ref={wrapRef} class={className ? `ag-menu ${className}` : 'ag-menu'}>
            <Button
                variant={variant}
                size={size}
                ariaLabel={ariaLabel}
                title={title ?? ariaLabel}
                active={open}
                icon={icon ?? <IconMore size={16} />}
                onClick={() => setOpen((prev) => !prev)}
            >
                {label}
            </Button>
            {open ? (
                <div class="ag-menu-panel" role="menu" aria-label={ariaLabel} data-align={align}>
                    {items.map((item) => (
                        <Fragment key={item.id}>
                            {item.separatorBefore ? (
                                <div class="ag-menu-separator" role="separator" />
                            ) : null}
                            <button
                                type="button"
                                role="menuitem"
                                class={item.danger ? 'ag-menu-item ag-menu-item-danger' : 'ag-menu-item'}
                                disabled={item.disabled}
                                onClick={() => {
                                    setOpen(false);
                                    item.onSelect();
                                }}
                            >
                                {item.icon ? <span class="ag-menu-item-icon">{item.icon}</span> : null}
                                <span>{item.label}</span>
                            </button>
                        </Fragment>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function ToastToneIcon({ tone }: { tone: ToastTone }) {
    if (tone === 'success') {
        return <IconCheck size={15} />;
    }
    if (tone === 'warning' || tone === 'error') {
        return <IconAlertTriangle size={15} />;
    }
    return <IconInfo size={15} />;
}

export interface ToastContainerProps {
    toasts: readonly ToastItem[];
    onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
    if (toasts.length === 0) {
        return null;
    }

    return (
        <div class="ag-toast-container" role="status" aria-live="polite">
            {toasts.map((toast) => (
                <div key={toast.id} class={`ag-toast ag-toast-${toast.tone}`}>
                    <span class="ag-toast-icon">
                        <ToastToneIcon tone={toast.tone} />
                    </span>
                    <span class="ag-toast-msg">{toast.message}</span>
                    <button
                        type="button"
                        class="ag-toast-close"
                        aria-label="关闭通知"
                        onClick={() => onDismiss(toast.id)}
                    >
                        <IconClose size={14} />
                    </button>
                </div>
            ))}
        </div>
    );
}
