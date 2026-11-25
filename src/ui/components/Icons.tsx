import type { JSX } from 'preact';

export interface IconProps {
    size?: number;
    className?: string;
    title?: string;
}

function SvgIcon({
    size = 16,
    className,
    title,
    children,
}: IconProps & { children: JSX.Element | JSX.Element[] }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            class={className ? `ag-icon ${className}` : 'ag-icon'}
            aria-hidden={title ? undefined : 'true'}
            role={title ? 'img' : undefined}
        >
            {title ? <title>{title}</title> : null}
            {children}
        </svg>
    );
}

export function IconBolt(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </SvgIcon>
    );
}

export function IconFolder(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </SvgIcon>
    );
}

export function IconTerminal(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </SvgIcon>
    );
}

export function IconDatabase(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
        </SvgIcon>
    );
}

export function IconBot(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="3" y="11" width="18" height="10" rx="2" />
            <circle cx="12" cy="5" r="2" />
            <path d="M12 7v4" />
            <line x1="8" y1="16" x2="8" y2="16" />
            <line x1="16" y1="16" x2="16" y2="16" />
        </SvgIcon>
    );
}

export function IconGitBranch(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </SvgIcon>
    );
}

export function IconWrench(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </SvgIcon>
    );
}

export function IconFilter(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
        </SvgIcon>
    );
}

export function IconBookOpen(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </SvgIcon>
    );
}

export function IconPlug(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M12 22v-5" />
            <path d="M9 8V2" />
            <path d="M15 8V2" />
            <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
        </SvgIcon>
    );
}

export function IconMoon(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </SvgIcon>
    );
}

export function IconSun(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2" />
            <path d="M12 20v2" />
            <path d="m4.93 4.93 1.41 1.41" />
            <path d="m17.66 17.66 1.41 1.41" />
            <path d="M2 12h2" />
            <path d="M20 12h2" />
            <path d="m6.34 17.66-1.41 1.41" />
            <path d="m19.07 4.93-1.41 1.41" />
        </SvgIcon>
    );
}

export function IconMonitor(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
        </SvgIcon>
    );
}

export function IconUpload(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
        </SvgIcon>
    );
}

export function IconDownload(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
        </SvgIcon>
    );
}

export function IconClose(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </SvgIcon>
    );
}

export function IconArrowLeft(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
        </SvgIcon>
    );
}

export function IconArrowUp(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </SvgIcon>
    );
}

export function IconArrowDown(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
        </SvgIcon>
    );
}

export function IconChevronRight(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="9 18 15 12 9 6" />
        </SvgIcon>
    );
}

export function IconChevronDown(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="6 9 12 15 18 9" />
        </SvgIcon>
    );
}

export function IconCheck(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="20 6 9 17 4 12" />
        </SvgIcon>
    );
}

export function IconAlertTriangle(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
        </SvgIcon>
    );
}

export function IconInfo(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
        </SvgIcon>
    );
}

export function IconPlay(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polygon points="6 3 20 12 6 21 6 3" />
        </SvgIcon>
    );
}

export function IconCopy(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </SvgIcon>
    );
}

export function IconTrash(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </SvgIcon>
    );
}

export function IconEdit(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
        </SvgIcon>
    );
}

export function IconPlus(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </SvgIcon>
    );
}

export function IconRefresh(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
        </SvgIcon>
    );
}

export function IconCode(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
        </SvgIcon>
    );
}

export function IconKeyboard(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="2" y="4" width="20" height="14" rx="2" />
            <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 15h10" />
        </SvgIcon>
    );
}

export function IconMaximize(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
        </SvgIcon>
    );
}

export function IconMinimize(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M4 14h6v6" />
            <path d="M20 10h-6V4" />
            <path d="M14 10l7-7" />
            <path d="M3 21l7-7" />
        </SvgIcon>
    );
}

export function IconMore(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
        </SvgIcon>
    );
}

export function IconLayers(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="m12 2 9 5-9 5-9-5 9-5Z" />
            <path d="m3 12 9 5 9-5" />
            <path d="m3 17 9 5 9-5" />
        </SvgIcon>
    );
}

export function IconCreditCard(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="2" y="5" width="20" height="14" rx="2" />
            <path d="M2 10h20" />
        </SvgIcon>
    );
}

export function IconFileText(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
        </SvgIcon>
    );
}

export function IconFiles(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <path d="M15 2H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7z" />
            <path d="M15 2v5h5" />
            <path d="M4 7v13a2 2 0 0 0 2 2h9" />
        </SvgIcon>
    );
}

export function IconPanelLeftClose(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="m16 15-3-3 3-3" />
        </SvgIcon>
    );
}

export function IconPanelLeftOpen(props: IconProps) {
    return (
        <SvgIcon {...props}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M9 3v18" />
            <path d="m14 9 3 3-3 3" />
        </SvgIcon>
    );
}
