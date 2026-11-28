import { useEffect, useMemo, useState } from 'preact/hooks';
import type {
    ExportWorldInfoOptions,
    ExportWorldInfoResult,
    SideClueDoc,
} from '@/core/types';
import {
    Badge,
    Button,
    FormField,
    SelectInput,
    ShadowModal,
    TextAreaInput,
    TextInput,
    ToggleSwitch,
} from '@/ui/components';
import { IconCheck, IconExport } from '@/ui/components/Icons';
import type { AppStore } from '@/ui/store';
import {
    formatErrorMessage,
    parseKeywordsInput,
    useSideGenStoreSlice,
} from './sidegen-helpers';

export interface ExportWorldInfoModalProps {
    open: boolean;
    clue: SideClueDoc | null;
    store: AppStore;
    hasUnsavedChanges?: boolean;
    onClose: () => void;
    onExported?: (result: ExportWorldInfoResult) => void;
}

const PRIMARY_BOOK_SENTINEL = '__primary__';
const CUSTOM_BOOK_SENTINEL = '__custom__';

export function ExportWorldInfoModal({
    open,
    clue,
    store,
    hasUnsavedChanges = false,
    onClose,
    onExported,
}: ExportWorldInfoModalProps) {
    const activeTarget = useSideGenStoreSlice(store, (s) => s.activeTarget);

    const [availableBooks, setAvailableBooks] = useState<string[]>([]);
    const [selectedBookMode, setSelectedBookMode] = useState<string>(PRIMARY_BOOK_SENTINEL);
    const [customBookName, setCustomBookName] = useState<string>('');
    const [comment, setComment] = useState<string>('');
    const [keysText, setKeysText] = useState<string>('');
    const [secondaryKeysText, setSecondaryKeysText] = useState<string>('');
    const [depthText, setDepthText] = useState<string>('4');
    const [orderText, setOrderText] = useState<string>('100');
    const [constant, setConstant] = useState<boolean>(false);
    const [markResolved, setMarkResolved] = useState<boolean>(false);
    const [submitting, setSubmitting] = useState<boolean>(false);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [exportResult, setExportResult] = useState<ExportWorldInfoResult | null>(null);

    // Populate form defaults whenever the modal opens for a clue.
    useEffect(() => {
        if (!open || !clue) {
            return;
        }
        setSelectedBookMode(PRIMARY_BOOK_SENTINEL);
        setCustomBookName('');
        setComment(clue.meta.title || clue.path);
        setKeysText(clue.meta.keywords.join(', '));
        setSecondaryKeysText((clue.meta.secondaryKeys ?? []).join(', '));
        setDepthText('4');
        setOrderText(String(clue.meta.order ?? 100));
        setConstant(false);
        setMarkResolved(false);
        setErrorText(null);
        setExportResult(null);
    }, [open, clue?.path, clue?.contentHash]);

    // Discover known World Info books from UI services so users can pick them without leaving Shadow DOM.
    useEffect(() => {
        if (!open) {
            return;
        }
        let cancelled = false;
        void store.services
            .listClassifiedLoreEntries()
            .then((res) => {
                if (cancelled) {
                    return;
                }
                const uniqueBooks = Array.from(
                    new Set(
                        res.entries
                            .map((item) => item.entry.world?.trim())
                            .filter((name): name is string => Boolean(name)),
                    ),
                ).sort();
                setAvailableBooks(uniqueBooks);
            })
            .catch(() => {
                if (!cancelled) {
                    setAvailableBooks([]);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [open, store]);

    const bookOptions = useMemo(() => {
        const opts = [
            {
                value: PRIMARY_BOOK_SENTINEL,
                label: '默认：当前角色绑定主世界书',
            },
            ...availableBooks.map((book) => ({
                value: book,
                label: book,
            })),
            {
                value: CUSTOM_BOOK_SENTINEL,
                label: '手动指定其他世界书名称…',
            },
        ];
        return opts;
    }, [availableBooks]);

    const previewBody = clue ? (clue.body.trim() || clue.meta.summary.trim()) : '';

    const handleSubmit = async () => {
        if (!clue || submitting) {
            return;
        }
        const runtime = store.getSideGenRuntime();
        if (!runtime) {
            setErrorText('SideGen 运行时未连接，暂时无法写入宿主世界书。');
            store.pushToast('SideGen 运行时未连接，无法导出到世界书', 'warning');
            return;
        }

        const resolvedBookName =
            selectedBookMode === PRIMARY_BOOK_SENTINEL
                ? undefined
                : selectedBookMode === CUSTOM_BOOK_SENTINEL
                    ? customBookName.trim() || undefined
                    : selectedBookMode;

        if (selectedBookMode === CUSTOM_BOOK_SENTINEL && !resolvedBookName) {
            setErrorText('请输入目标世界书名称，或切换为默认主世界书。');
            return;
        }

        const parsedKeys = parseKeywordsInput(keysText);
        const parsedSecondary = parseKeywordsInput(secondaryKeysText);
        const parsedDepth = depthText.trim() !== '' ? Number(depthText) : undefined;
        const parsedOrder = orderText.trim() !== '' ? Number(orderText) : undefined;

        const options: ExportWorldInfoOptions = {
            ...(resolvedBookName ? { bookName: resolvedBookName } : {}),
            comment: comment.trim() || clue.meta.title || clue.path,
            keys: parsedKeys,
            ...(parsedSecondary.length > 0 ? { secondaryKeys: parsedSecondary, selective: true } : {}),
            constant,
            ...(parsedDepth !== undefined && Number.isFinite(parsedDepth)
                ? { depth: Math.max(0, Math.floor(parsedDepth)) }
                : {}),
            ...(parsedOrder !== undefined && Number.isFinite(parsedOrder)
                ? { order: Math.floor(parsedOrder) }
                : {}),
            markResolved,
            target: activeTarget,
        };

        setSubmitting(true);
        setErrorText(null);
        try {
            const result = await runtime.clues.exportToWorldInfo(clue.path, options);
            setExportResult(result);
            store.pushToast(
                `已写入世界书《${result.bookName}》· ${result.comment} (UID ${result.uid})`,
                'success',
            );
            await store.refreshSideGenState(activeTarget);
            onExported?.(result);
        } catch (err) {
            const msg = formatErrorMessage(err);
            setErrorText(`导出失败：${msg}`);
            store.pushToast(`导出到世界书失败：${msg}`, 'error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <ShadowModal
            open={open && Boolean(clue)}
            title="📤 导出线索到 ST 真实世界书"
            maxWidth="620px"
            onClose={onClose}
            footer={
                <>
                    <Button variant="secondary" size="sm" onClick={onClose}>
                        {exportResult ? '完成' : '取消'}
                    </Button>
                    {!exportResult ? (
                        <Button
                            variant="primary"
                            size="sm"
                            loading={submitting}
                            icon={<IconExport size={14} />}
                            onClick={() => {
                                void handleSubmit();
                            }}
                        >
                            {submitting ? '写入中…' : '确认写入世界书'}
                        </Button>
                    ) : null}
                </>
            }
        >
            {clue ? (
                <div class="ag-stack-v">
                    <div class="ag-banner ag-banner-success">
                        确认后将经 <span class="ag-mono">HostAuthorBridge</span> 写入 SillyTavern 真实世界书，跨聊天永久生效。
                    </div>

                    {hasUnsavedChanges ? (
                        <div class="ag-banner ag-banner-warning">
                            当前线索存在未保存编辑；导出将读取已保存的 <span class="ag-mono">{clue.path}</span> 内容。建议先点击「保存修改」再导出。
                        </div>
                    ) : null}

                    {exportResult ? (
                        <div class="ag-banner ag-banner-success">
                            <div class="ag-row" style={{ fontWeight: 600 }}>
                                <IconCheck size={15} />
                                <span>
                                    导出成功：已写入《{exportResult.bookName}》
                                </span>
                            </div>
                            <div class="ag-row-wrap" style={{ marginTop: '6px' }}>
                                <Badge tone="success">UID {exportResult.uid}</Badge>
                                <Badge tone="primary">{exportResult.comment}</Badge>
                                <span class="ag-mono" style={{ fontSize: '11px' }}>
                                    {exportResult.cluePath}
                                </span>
                            </div>
                        </div>
                    ) : null}

                    {errorText ? (
                        <div class="ag-banner ag-banner-error" role="alert">
                            {errorText}
                        </div>
                    ) : null}

                    <div class="ag-grid-2">
                        <FormField
                            label="目标世界书"
                            hint="留默认将自动解析当前角色绑定主世界书"
                        >
                            <SelectInput
                                ariaLabel="目标世界书"
                                value={selectedBookMode}
                                options={bookOptions}
                                disabled={submitting}
                                onChange={setSelectedBookMode}
                            />
                        </FormField>

                        <FormField label="世界书条目名称 (Comment)" required>
                            <TextInput
                                ariaLabel="世界书条目名称"
                                value={comment}
                                placeholder="例如：林晚的加密通讯线索"
                                disabled={submitting}
                                onInput={setComment}
                            />
                        </FormField>
                    </div>

                    {selectedBookMode === CUSTOM_BOOK_SENTINEL ? (
                        <FormField label="自定义目标世界书名称" required>
                            <TextInput
                                ariaLabel="自定义目标世界书名称"
                                value={customBookName}
                                placeholder="输入已存在的 ST 世界书名称"
                                disabled={submitting}
                                onInput={setCustomBookName}
                            />
                        </FormField>
                    ) : null}

                    <FormField
                        label="触发关键词 (Keys)"
                        hint="使用逗号（, 或 ，）分隔多个关键词"
                    >
                        <TextInput
                            ariaLabel="触发关键词"
                            value={keysText}
                            placeholder="例如：老码头, 灯塔, 林晚, 门禁卡"
                            disabled={submitting}
                            onInput={setKeysText}
                        />
                    </FormField>

                    <FormField
                        label="次级关键词 (Secondary Keys · 可选)"
                        hint="留空则不启用次级选择性过滤"
                    >
                        <TextInput
                            ariaLabel="次级关键词"
                            value={secondaryKeysText}
                            placeholder="可选，逗号分隔"
                            disabled={submitting}
                            onInput={setSecondaryKeysText}
                        />
                    </FormField>

                    <div class="ag-grid-2">
                        <FormField
                            label="插入深度 (Depth)"
                            hint="对应 @D 插入深度，默认 4"
                        >
                            <TextInput
                                ariaLabel="插入深度"
                                type="number"
                                min={0}
                                value={depthText}
                                disabled={submitting}
                                onInput={setDepthText}
                            />
                        </FormField>

                        <FormField
                            label="插入顺序 (Order)"
                            hint="数值越大越靠后注入，默认 100"
                        >
                            <TextInput
                                ariaLabel="插入顺序"
                                type="number"
                                value={orderText}
                                disabled={submitting}
                                onInput={setOrderText}
                            />
                        </FormField>
                    </div>

                    <div class="ag-stack-v" style={{ gap: '6px' }}>
                        <ToggleSwitch
                            checked={constant}
                            disabled={submitting}
                            label="蓝灯常驻条目 (Constant)"
                            description="开启后无视关键词常驻生效；关闭则为绿灯关键词触发"
                            onChange={setConstant}
                        />
                        <ToggleSwitch
                            checked={markResolved}
                            disabled={submitting}
                            label="导出后将 /side/* 线索标为已回收 (resolved)"
                            description="避免已升级到世界书的伏笔在后续回合重复提醒"
                            onChange={setMarkResolved}
                        />
                    </div>

                    <FormField
                        label="将写入世界书的正文预览"
                        hint={`来源路径：${clue.path}`}
                    >
                        <TextAreaInput
                            ariaLabel="将写入世界书的正文预览"
                            value={previewBody}
                            rows={5}
                            readOnly
                            className="ag-mono"
                        />
                    </FormField>
                </div>
            ) : null}
        </ShadowModal>
    );
}
