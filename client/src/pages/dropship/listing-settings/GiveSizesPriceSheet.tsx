import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ListingSettingsPricesResponse, ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { LISTING_SETTINGS_GUARD_ID_PREFIX, SIZE_PRICES_EDITOR_ID, isDraftDirty } from "@/lib/dropship-listing-settings-drafts";
import { DRAWER_WORDS, type DrawerNotice } from "@/lib/dropship-listing-settings-drawer";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import {
  emptySizePricesDraft,
  noSizePricesRefusal,
  ownSizePricesDraft,
  sizePriceTyped,
  sizePricesDiscard,
  sizePricesEditAction,
  sizePricesPageQueryOptions,
  sizePricesRefusalWithoutSize,
  sizePricesSheetState,
  type SizePriceRowModel,
  type SizePricesRefusal,
  type SizePricesSheetState,
  type SizePricesSummaryFacts,
} from "@/lib/dropship-listing-settings-size-prices";
import {
  loadLatestSizePrices,
  refreshAfterSizePricesSave,
  runSizePricesSave,
  sendSizePrices,
} from "@/lib/dropship-listing-settings-size-prices-requests";
import { LISTING_SETTINGS_SIZE_PRICES_WORDS } from "@/lib/dropship-listing-settings-words";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { CloseButton, DrawerFooterBar, PRODUCT_DRAWER_CLASS } from "./ProductDrawer";
import { useReportListTooLarge } from "./ProductsTab";

export interface GiveSizesPriceSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=give-prices`, D21) and no other surface is open (D20); shut while the selection is too large (D18). */
  open: boolean;
  /** The step's summary read: the sheet's reads are off while the selection is too large (D18). */
  summary: SizePricesSummaryFacts;
  /** W8's right (`rights.sizePrices`, D3). */
  right: ListingSettingsRight;
  /** The page's pending-save counter (D10). */
  saveCallbacks: ProductSettingsSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads every listing settings view again (D9). */
  onSaved: () => void;
  /** The step takes `?sheet=` off the address in place. Browser Back closes the sheet without this. */
  onClose: () => void;
  /** A save refused because of a block the banner explains (D8), or the read refused as too large (D18). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the sheet closes: the Prices tab's button, or the strip's [Fix] (plan 3.4). */
  returnFocusTo?: FocusReturnTarget;
}

/**
 * "Give these sizes a price" (Listing settings PR 10f, plan 9.1-9.3, 9.5;
 * REC:862, REC:971): every chosen size that can't be priced, in one list with
 * [Load more] on every width, each with an Exact price box. The typed prices
 * live in the step's one draft (D16, editor "sizePrices"), each with the
 * price revision its row was read with (D6), and [Save prices] sends them in
 * one W8 request, at most 200, all or none (D12). The pages are the Prices
 * tab's own "Can't be priced" reads (the same keys, D18), read fresh while
 * the sheet is open (D10): a saved size leaves the list once they are read
 * again (D9). The client parses what is typed into integer cents and
 * computes no price (D1). The title and the intro are the dialog's name and
 * description.
 *
 * It opens at `?sheet=give-prices` as the drawer's right sheet, full screen
 * on a phone. × or Esc with typed prices asks first; Esc keeps the sheet
 * while a save is out or unconfirmed (plan 3.4). Browser Back takes the sheet
 * off the address, which hides it and keeps its draft; opening it again shows
 * the typed prices (D21). After a version conflict, [Load latest and keep my
 * changes] reads the loaded pages again: a typed size still listed takes its
 * new revision, one that left the list leaves the draft, unsaved (9.5,
 * CC-C5). Every decision is the lib's (`dropship-listing-settings-size-prices.ts`,
 * `-size-prices-requests.ts`).
 */
export function GiveSizesPriceSheet(props: GiveSizesPriceSheetProps) {
  const { open, storeConnectionId, onClose } = props;
  // The open body says whether it used Esc (to keep a save in view).
  const escape = useRef<(() => boolean) | null>(null);
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const drafts = useListingSettingsDrafts();
  const guard = useLeaveGuard();
  const guardId = `${LISTING_SETTINGS_GUARD_ID_PREFIX}${storeConnectionId}`;
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;

  // The address decides what shows (D21): once it no longer opens the sheet (Back, a close) the sheet's draft is
  // hidden and kept; coming back shows it again (its typed prices, or a Check again).
  const { open: openDraft, close: closeDraft, discard: discardDraft } = drafts;
  const wasOpen = useRef(open);
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    if (before === open) return;
    const draft = draftRef.current;
    if (draft?.editor !== SIZE_PRICES_EDITOR_ID) return;
    if (!open && draft.open) closeDraft();
    if (open && !draft.open) openDraft(draft.editor, draft.place, draft.base);
  }, [open, openDraft, closeDraft]);

  const dismiss = useCallback(() => {
    const draft = draftRef.current;
    const mine = draft?.editor === SIZE_PRICES_EDITOR_ID ? draft : null;
    // A save in flight is never dropped: the sheet hides and the draft settles on its own.
    if (mine && mine.phase !== "saving" && isDraftDirty(mine)) {
      guard(() => {
        discardDraft();
        onClose();
      }, [guardId]);
      return;
    }
    if (mine) closeDraft();
    onClose();
  }, [guard, guardId, discardDraft, closeDraft, onClose]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <SheetContent
        side="right"
        data-testid="give-sizes-price-sheet"
        className={PRODUCT_DRAWER_CLASS}
        onEscapeKeyDown={(event) => {
          if (escape.current?.()) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          const opener = props.returnFocusTo?.current ?? null;
          if (!opener || !opener.isConnected) return;
          event.preventDefault();
          opener.focus();
        }}
      >
        {open && <GiveSizesPriceBody {...props} compact={compact} onDismiss={dismiss} escapeRef={escape} />}
      </SheetContent>
    </Sheet>
  );
}

interface GiveSizesPriceBodyProps extends GiveSizesPriceSheetProps {
  compact: boolean;
  onDismiss: () => void;
  /** Set by the body: true when Esc must keep the sheet open (a save out or unconfirmed). */
  escapeRef: { current: (() => boolean) | null };
}

type SizeFacts = Pick<ListingSettingsSizePrice, "productVariantId" | "settingRevisionId">;

function GiveSizesPriceBody(props: GiveSizesPriceBodyProps) {
  const { storeConnectionId, compact } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  // The pages loaded so far, 0..k, kept together on every width (9.3): a conflict's Load latest reads them all again (9.5).
  const [pageCount, setPageCount] = useState(1);
  // useQueries can't infer a mapped list: every entry is this read's parsed answer.
  const reads = useQueries({
    queries: Array.from({ length: pageCount }, (_, page) => sizePricesPageQueryOptions(storeConnectionId, page, props.summary, true)),
  }) as UseQueryResult<ListingSettingsPricesResponse>[];
  // Refused because more than 10,000 sizes are chosen now: the banner says so, as for the lists (D18).
  useReportListTooLarge(reads[0]?.error, props.onBlocked);

  // What the last failed save named (the rows outside a limit, the sizes in conflict), kept until the next save or Load latest.
  const [refusal, setRefusal] = useState<SizePricesRefusal>(noSizePricesRefusal);
  // "2 sizes left this list and weren't saved." after Load latest; null for none.
  const [reloadLine, setReloadLine] = useState<string | null>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const saving = useRef(false);
  const latestDraft = useRef(drafts.draft);
  latestDraft.current = drafts.draft;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const sheet = sizePricesSheetState({
    pages: reads.map((read) => ({ data: read.data, error: read.error })),
    draft: drafts.draft,
    right: props.right,
    busy: props.saveCallbacks.disabled === true || reading,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    refusal,
    reloadLine,
  });
  // Each listed size with the revision its row was read with (D6): what a typed price is sent against.
  const sizesById = new Map<number, SizeFacts>();
  for (const read of reads) {
    for (const row of read.data?.rows ?? []) {
      if (!sizesById.has(row.productVariantId)) sizesById.set(row.productVariantId, { productVariantId: row.productVariantId, settingRevisionId: row.settingRevisionId });
    }
  }

  // Esc (plan 3.4): a save out or unconfirmed keeps the sheet open.
  useEffect(() => {
    props.escapeRef.current = () => sheet.escapeKeepsOpen;
    return () => { props.escapeRef.current = null; };
  });

  /**
   * Typing in a size's box (plan 9.2, D16): the text goes in the step's one draft with the row's revision; a clean
   * draft starts again on nothing typed (so a size saved before is never resent with its old revision); another
   * editor's unsaved change is asked about through the leave guard, and after "Discard and leave" the typed text
   * goes in from the draft the provider opened. A mark the last refusal put on the size goes with the retyped price.
   */
  function edit(productVariantId: number, text: string) {
    const size = sizesById.get(productVariantId);
    if (size === undefined) return;
    const action = sizePricesEditAction({ draft: latestDraft.current, size, text });
    switch (action.kind) {
      case "locked":
        return;
      case "edit":
        drafts.edit(action.value);
        break;
      case "start":
        if (!drafts.open(SIZE_PRICES_EDITOR_ID, LISTING_SETTINGS_SIZE_PRICES_WORDS.title, action.base)) return;
        drafts.edit(action.value);
        break;
      case "elsewhere": {
        const value = sizePriceTyped(emptySizePricesDraft(), size, text);
        drafts.open(SIZE_PRICES_EDITOR_ID, LISTING_SETTINGS_SIZE_PRICES_WORDS.title, emptySizePricesDraft(), () => {
          if (mounted.current) drafts.edit(value);
        });
        return;
      }
    }
    setRefusal((current) => sizePricesRefusalWithoutSize(current, productVariantId));
    setFooterMessage(null);
    setReloadLine(null);
  }

  /** [Save prices], or [Check again] after an unconfirmed save (plan 9.4, 9.5): one W8 request of every typed size. */
  async function save() {
    const live = latestDraft.current;
    if (live === null || live.editor !== SIZE_PRICES_EDITOR_ID || saving.current) return;
    saving.current = true;
    setFooterMessage(null);
    try {
      const outcome = await runSizePricesSave({
        storeConnectionId,
        draft: live,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => sendSizePrices(storeConnectionId, body),
        reread: () => refreshAfterSizePricesSave(queryClient, storeConnectionId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      switch (outcome.kind) {
        case "not_started":
        case "invalid":
          if (outcome.message) setFooterMessage(outcome.message);
          return;
        case "saved":
          // The pages are read again (D9): the saved sizes leave the list; "Saved" shows in the footer for 3 seconds.
          setRefusal(noSizePricesRefusal());
          setReloadLine(null);
          return;
        case "failed":
          // The footer words the failure (the draft's); the rows a limit refusal or a conflict named are marked.
          setRefusal(outcome.refusal);
          return;
      }
    } finally {
      saving.current = false;
    }
  }

  /**
   * "Load latest and keep my changes" after a 409 (plan 9.5, CC-C5): the loaded pages read again; each typed size
   * still listed keeps its text with its new revision, one that left the list leaves the draft, unsaved, with the line.
   */
  async function loadLatest() {
    const own = ownSizePricesDraft(latestDraft.current);
    if (own === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      const next = await loadLatestSizePrices(queryClient, storeConnectionId, pageCount, own.value);
      if (!mounted.current) return;
      setRefusal(noSizePricesRefusal());
      setReloadLine(next.line);
      if (!next.keeps) {
        // Every typed size left the list (priced elsewhere, or no longer chosen): nothing is left to keep.
        drafts.discard();
        return;
      }
      drafts.edit(next.value);
      drafts.rebase(emptySizePricesDraft());
    } catch {
      // Deliberate: the draft keeps the conflict and its Load latest; the words say the read failed.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." (reads only, D9); the draft then goes (its prices are saved). */
  async function reload() {
    if (reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      await refreshAfterSizePricesSave(queryClient, storeConnectionId);
      if (mounted.current) drafts.discard();
    } catch {
      // Deliberate: the save stands; the draft keeps "Saved. We couldn't load the latest view." with Reload.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Discard]: every typed price goes; none while a save is out or unconfirmed. */
  function discard() {
    setFooterMessage(null);
    setReloadLine(null);
    setRefusal(noSizePricesRefusal());
    if (sizePricesDiscard(latestDraft.current) === "discard") drafts.discard();
  }

  const lastRead = reads[reads.length - 1];
  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={props.onDismiss} />}
        <div className="min-w-0 flex-1 space-y-1">
          <SheetTitle className="break-words text-base font-semibold text-zinc-900">{sheet.title}</SheetTitle>
          <SheetDescription className="text-sm text-zinc-700">{sheet.intro}</SheetDescription>
        </div>
        {!compact && <CloseButton onClick={props.onDismiss} />}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {sheet.reason && <p className="text-xs text-zinc-600" data-testid="size-prices-reason">{sheet.reason}</p>}
        {sheet.loadingLine && <p role="status" className="text-sm text-zinc-600">{sheet.loadingLine}</p>}
        {sheet.problem && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="size-prices-read-problem">
            <span>{sheet.problem.text}</span>
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void reads[0]?.refetch()}>
              {sheet.problem.retryLabel}
            </Button>
          </div>
        )}
        {sheet.reloadLine && <p role="status" className="text-sm text-amber-900" data-testid="size-prices-reload-line">{sheet.reloadLine}</p>}
        {sheet.empty && <p role="status" className="text-sm text-emerald-800" data-testid="size-prices-empty">{sheet.empty}</p>}
        {sheet.rows.length > 0 && <SizePriceRows sheet={sheet} compact={compact} onEdit={edit} />}
        {sheet.loadMore.loading && <p role="status" className="text-sm text-zinc-600">{LISTING_SETTINGS_SIZE_PRICES_WORDS.loading}</p>}
        {sheet.loadMore.problem && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="size-prices-load-more-problem">
            <span>{sheet.loadMore.problem.text}</span>
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void lastRead?.refetch()}>
              {sheet.loadMore.problem.retryLabel}
            </Button>
          </div>
        )}
        {sheet.loadMore.shown && !sheet.loadMore.loading && sheet.loadMore.problem === null && (
          <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" data-testid="size-prices-load-more"
            onClick={() => setPageCount(sheet.loadMore.nextPage + 1)}>
            {sheet.loadMore.label}
          </Button>
        )}
      </div>

      {sheet.footerShown && (
        <DrawerFooterBar
          testIdPrefix="size-prices"
          footer={sheet.footer}
          message={footerMessage}
          onDiscard={discard}
          onPrimary={() => {
            const action = sheet.footer.primary.action;
            if (action === "save" || action === "resend") void save();
            else if (action === "load_latest") void loadLatest();
            else if (action === "reload") void reload();
          }}
        />
      )}
    </>
  );
}

const NOTICE_CLASS: Readonly<Record<DrawerNotice["tone"], string>> = {
  info: "text-zinc-600",
  warn: "text-amber-800",
  alert: "text-rose-800",
};

/** The sizes of every loaded page (9.3): a table on a wide screen, cards on a phone. Hook-free, so a test can type in a box. */
export function SizePriceRows({ sheet, compact, onEdit }: {
  sheet: Pick<SizePricesSheetState, "rows" | "title">;
  compact: boolean;
  onEdit: (productVariantId: number, text: string) => void;
}) {
  const words = LISTING_SETTINGS_SIZE_PRICES_WORDS;
  if (compact) {
    return (
      <ul aria-label={sheet.title} className="space-y-2" data-testid="size-prices-rows">
        {sheet.rows.map((row) => (
          <li key={row.key} className="space-y-1 rounded-md border border-zinc-200 bg-white p-3 text-sm" data-testid={`size-price-${row.productVariantId}`}
            data-conflict={row.conflict || undefined} data-outside-limit={row.outsideLimit || undefined}>
            <p className="break-words font-medium text-zinc-900">{row.productName}</p>
            <p className="break-words text-xs text-zinc-600">{row.size}</p>
            {row.cost !== null && <p className="text-zinc-700">{row.cost}</p>}
            <SizePriceBox row={row} onEdit={onEdit} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-200 bg-white" data-testid="size-prices-rows">
      <table className="w-full text-sm" aria-label={sheet.title} data-testid="size-prices-table">
        <thead>
          <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs font-medium text-zinc-600">
            <th scope="col" className="px-3 py-2">{words.product}</th>
            <th scope="col" className="px-3 py-2">{words.size}</th>
            <th scope="col" className="px-3 py-2">{words.yourCost}</th>
            <th scope="col" className="px-3 py-2">{words.exactPrice}</th>
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row) => (
            <tr key={row.key} className="border-b border-zinc-100 align-top last:border-0" data-testid={`size-price-${row.productVariantId}`}
              data-conflict={row.conflict || undefined} data-outside-limit={row.outsideLimit || undefined}>
              <td className="px-3 py-2 font-medium text-zinc-900">{row.productName}</td>
              <td className="px-3 py-2 text-zinc-700">{row.size}</td>
              <td className="whitespace-nowrap px-3 py-2 text-zinc-700">{row.costAmount ?? "—"}</td>
              <td className="px-3 py-2"><SizePriceBox row={row} onEdit={onEdit} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One size's Exact price box with the drawer's notes under it (9.3): the
 * parsers' words as a note (the drawer's way: never a live alert for each
 * keystroke), the limit and below-cost notes, a refusal's mark. Hook-free
 * (its ids are the size's), so a test can type in it.
 */
export function SizePriceBox({ row, onEdit }: { row: SizePriceRowModel; onEdit: (productVariantId: number, text: string) => void }) {
  const ids = { error: `size-price-${row.productVariantId}-error`, notes: `size-price-${row.productVariantId}-notes` };
  const described = [row.box.invalid !== null ? ids.error : null, row.notices.length > 0 ? ids.notes : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1">
      <Input
        className={`h-11 w-32 sm:h-9 ${row.conflict || row.outsideLimit ? "border-amber-500 ring-1 ring-amber-400" : ""}`}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={row.box.label}
        value={row.box.text}
        readOnly={row.box.readOnly}
        aria-readonly={row.box.readOnly || undefined}
        aria-invalid={row.box.invalid !== null || row.outsideLimit || undefined}
        aria-describedby={described}
        onChange={(event) => onEdit(row.productVariantId, event.target.value)}
      />
      {row.box.invalid !== null && <p id={ids.error} className="text-xs text-rose-800">{row.box.invalid}</p>}
      {row.notices.length > 0 && (
        <div id={ids.notes} className="space-y-0.5">
          {row.notices.map((notice) => <p key={notice.text} className={`text-xs ${NOTICE_CLASS[notice.tone]}`}>{notice.text}</p>)}
        </div>
      )}
    </div>
  );
}
