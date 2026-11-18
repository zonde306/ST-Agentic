import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Button, EmptyState } from './CommonControls';
import { IconArrowLeft } from './Icons';

const MOBILE_MEDIA_QUERY = '(max-width: 767px)';

export function useIsMobileViewport(breakpointPx = 768): boolean {
    const getMatch = () => {
        if (typeof window === 'undefined') {
            return false;
        }
        if (breakpointPx === 768 && typeof window.matchMedia === 'function') {
            return window.matchMedia(MOBILE_MEDIA_QUERY).matches;
        }
        return window.innerWidth < breakpointPx;
    };

    const [isMobile, setIsMobile] = useState<boolean>(getMatch);

    useEffect(() => {
        if (typeof window === 'undefined') {
            return;
        }
        const update = () => {
            setIsMobile(getMatch());
        };
        update();

        if (breakpointPx === 768 && typeof window.matchMedia === 'function') {
            const mql = window.matchMedia(MOBILE_MEDIA_QUERY);
            mql.addEventListener('change', update);
            window.addEventListener('resize', update);
            return () => {
                mql.removeEventListener('change', update);
                window.removeEventListener('resize', update);
            };
        }

        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('resize', update);
        };
    }, [breakpointPx]);

    return isMobile;
}

export interface MasterDetailLayoutProps {
    master: ComponentChildren;
    detail: ComponentChildren;
    detailOpen?: boolean;
    onDetailOpenChange?: (open: boolean) => void;
    detailTitle?: string;
    backLabel?: string;
    detailHeaderExtra?: ComponentChildren;
    emptyDetailTitle?: string;
    emptyDetailDescription?: string;
    isMobile?: boolean;
    enableHistoryBack?: boolean;
    className?: string;
}

/**
 * Responsive Master-Detail layout:
 * - Desktop (`>= 768px`): side-by-side master list + full-height detail workspace.
 * - Mobile (`< 768px`): single-column push stack with `[← 返回列表]` and `history.pushState`/`popstate`.
 */
export function MasterDetailLayout({
    master,
    detail,
    detailOpen: controlledDetailOpen,
    onDetailOpenChange,
    detailTitle = '详情',
    backLabel = '返回列表',
    detailHeaderExtra,
    emptyDetailTitle = '请选择左侧条目',
    emptyDetailDescription,
    isMobile: isMobileOverride,
    enableHistoryBack = true,
    className,
}: MasterDetailLayoutProps) {
    const detectedMobile = useIsMobileViewport();
    const isMobile = isMobileOverride ?? detectedMobile;

    const [internalDetailOpen, setInternalDetailOpen] = useState(false);
    const isControlled = controlledDetailOpen !== undefined;
    const resolvedDetailOpen = isControlled ? controlledDetailOpen : internalDetailOpen;

    const setDetailOpen = useCallback(
        (nextOpen: boolean) => {
            if (!isControlled) {
                setInternalDetailOpen(nextOpen);
            }
            onDetailOpenChange?.(nextOpen);
        },
        [isControlled, onDetailOpenChange],
    );

    const stackTokenRef = useRef<string>(
        `ag_md_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`,
    );
    const pushedHistoryRef = useRef<boolean>(false);

    useEffect(() => {
        if (!enableHistoryBack || typeof window === 'undefined') {
            pushedHistoryRef.current = false;
            return;
        }

        if (isMobile && resolvedDetailOpen) {
            if (!pushedHistoryRef.current && typeof window.history?.pushState === 'function') {
                try {
                    const currentState =
                        window.history.state && typeof window.history.state === 'object'
                            ? window.history.state
                            : {};
                    window.history.pushState(
                        {
                            ...currentState,
                            __agenticMasterDetail: stackTokenRef.current,
                        },
                        '',
                    );
                    pushedHistoryRef.current = true;
                } catch {
                    pushedHistoryRef.current = false;
                }
            }
        } else if (!resolvedDetailOpen || !isMobile) {
            pushedHistoryRef.current = false;
        }
    }, [enableHistoryBack, isMobile, resolvedDetailOpen]);

    useEffect(() => {
        if (!enableHistoryBack || typeof window === 'undefined') {
            return;
        }

        const handlePopState = () => {
            if (!pushedHistoryRef.current) {
                return;
            }
            const stateObj = window.history.state as { __agenticMasterDetail?: string } | null;
            if (stateObj?.__agenticMasterDetail !== stackTokenRef.current) {
                pushedHistoryRef.current = false;
                setDetailOpen(false);
            }
        };

        window.addEventListener('popstate', handlePopState);
        return () => {
            window.removeEventListener('popstate', handlePopState);
        };
    }, [enableHistoryBack, setDetailOpen]);

    const handleBack = useCallback(() => {
        const shouldPopHistory =
            enableHistoryBack
            && pushedHistoryRef.current
            && typeof window !== 'undefined'
            && (window.history.state as { __agenticMasterDetail?: string } | null)
                ?.__agenticMasterDetail === stackTokenRef.current;

        pushedHistoryRef.current = false;
        setDetailOpen(false);

        if (shouldPopHistory) {
            try {
                window.history.back();
            } catch {
                // Ignore history API restrictions in embedded environments.
            }
        }
    }, [enableHistoryBack, setDetailOpen]);

    if (isMobile) {
        if (resolvedDetailOpen) {
            return (
                <div class={className ? `ag-stack-layout ${className}` : 'ag-stack-layout'}>
                    <div class="ag-stack-topbar">
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={<IconArrowLeft size={15} />}
                            onClick={handleBack}
                            className="ag-stack-back-btn"
                        >
                            {backLabel}
                        </Button>
                        <div class="ag-stack-title" title={detailTitle}>
                            {detailTitle}
                        </div>
                        {detailHeaderExtra ? (
                            <div class="ag-stack-extra">{detailHeaderExtra}</div>
                        ) : null}
                    </div>
                    <div class="ag-stack-body ag-thin-scroll">
                        {detail ?? (
                            <EmptyState
                                title={emptyDetailTitle}
                                description={emptyDetailDescription}
                            />
                        )}
                    </div>
                </div>
            );
        }

        return (
            <div class={className ? `ag-stack-layout ${className}` : 'ag-stack-layout'}>
                <div class="ag-stack-body ag-thin-scroll">{master}</div>
            </div>
        );
    }

    return (
        <div class={className ? `ag-split-layout ${className}` : 'ag-split-layout'}>
            <aside class="ag-split-master ag-thin-scroll">{master}</aside>
            <div class="ag-split-detail ag-thin-scroll">
                {detail ?? (
                    <EmptyState
                        title={emptyDetailTitle}
                        description={emptyDetailDescription}
                    />
                )}
            </div>
        </div>
    );
}
