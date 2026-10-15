import { useCallback, useEffect, useRef, useState } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { AcknowledgeCategoryMovesResponse } from "@shared/dropship/listing-setting-writes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import type { AttentionAction } from "@/lib/dropship-listing-settings-attention";
import {
  isDraftLocked,
  reduceListingSettingsDraft,
  UPDATED_PRODUCTS_EDITOR_ID,
  type ListingSettingsDraft,
} from "@/lib/dropship-listing-settings-drafts";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import {
  heldGotItFor,
  isUpdatedProductsDraft,
  uniqueUpdatedProductRows,
  updatedProductsDraftValue,
  updatedProductsSheetQueryOptions,
  updatedProductsSheetState,
  type GotItBody,
  type UpdatedProductRowModel,
  type UpdatedProductsSheetState,
  type UpdatedProductsSummaryFacts,
  type UpdatedProductsView,
} from "@/lib/dropship-listing-settings-updated";
import {
  categoryMovesAcknowledgeEndpoint,
  rereadAfterCategoryMoves,
  runCategoryMovesAcknowledge,
} from "@/lib/dropship-listing-settings-updated-requests";
import { LISTING_SETTINGS_UPDATED_WORDS } from "@/lib/dropship-listing-settings-words";
import { postJson } from "@/lib/dropship-ops-surface";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { CloseButton, PRODUCT_DRAWER_CLASS } from "./ProductDrawer";
import { LISTING_SETTINGS_LIST_WORDS, useReportListTooLarge } from "./ProductsTab";

export type OwnTextCheckAction = Extract<AttentionAction, { kind: "open_product" }>;

export interface UpdatedProductsSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=updated`, D21) and no other surface is open (D20). */
  open: boolean;
  /** The step's summary read: the sheet's reads are off while the selection is too large (D18). */
  summary: UpdatedProductsSummaryFacts;
  /** W13's right (`rights.categoryMoves`, D3). */
  right: ListingSettingsRight;
  /** The page's pending-save counter (D10). */
  saveCallbacks: ProductSettingsSaveCallbacks;
  /** After a confirmed "Got it": the step marks the step 3 preview stale and reads every listing settings view again (D9). */
  onSaved: () => void;
  /** The step takes `?sheet=` off the address in place. Browser Back closes the sheet without this. */
  onClose: () => void;
  /** An own-text row's [Check]: the step closes this sheet and opens the drawer on its Description row (D20). */
  onCheckOwnText: (action: OwnTextCheckAction) => void;
  /** A "Got it" refused because of a block the banner explains (D8). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the sheet closes ([Review], or the strip's [Check]). */
  returnFocusTo?: FocusReturnTarget;
}

/**
 * "Card Shellz updated products" (Listing settings PR 10g, plan 10.1-10.3):
 * the products Card Shellz moved to another category since the vendor last
 * confirmed them, and the products it changed under the vendor's own text.
 * It opens at `?sheet=updated` and reads its page fresh each time (D6: every
 * "Got it" sends the category this read showed). A move row reads "Penny
 * Sleeves · Moved from Sleeves to Toploaders." with the category settings
 * that differ, and [Got it]; the header's [Got it for all N] sends every
 * moved product as the read listed them (W13). An own-text row's [Check]
 * closes the sheet and opens the drawer's Description row (D20).
 *
 * After a confirmed "Got it": "Done.", and what moved again counted from the
 * answer, never from the re-read, which can lag a minute (10.3); the rows
 * are read again, so the acknowledged ones leave the list. The request
 * lives in the step's one draft (D16, editor "updatedProducts") and holds no
 * change: × closes at once, browser Back keeps an unconfirmed "Got it" so
 * [Check again] stays reachable (D21), and Esc keeps the sheet while one is
 * out (plan 3.4). 50 a page: Previous and Next on a wide screen, Load more
 * on a phone. Every decision is the lib's (`dropship-listing-settings-updated.ts`,
 * `-updated-requests.ts`).
 */
export function UpdatedProductsSheet(props: UpdatedProductsSheetProps) {
  const { open, onClose } = props;
  const escape = useRef<(() => boolean) | null>(null);
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const drafts = useListingSettingsDrafts();
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;
  const { close: closeDraft } = drafts;

  // The address decides what shows: once it no longer opens the sheet (Back, or a close), an unconfirmed "Got it"
  // is hidden and kept (D21); a confirmed or refused one goes with the sheet (the draft holds no change).
  const wasOpen = useRef(open);
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    const draft = draftRef.current;
    if (before && !open && isUpdatedProductsDraft(draft) && draft?.open) closeDraft();
  }, [open, closeDraft]);

  const dismiss = useCallback(() => {
    // Nothing to ask about: the draft holds no change. A "Got it" in flight settles on its own, hidden.
    if (isUpdatedProductsDraft(draftRef.current)) closeDraft();
    onClose();
  }, [closeDraft, onClose]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <SheetContent
        side="right"
        data-testid="updated-products-sheet"
        className={PRODUCT_DRAWER_CLASS}
        aria-describedby={undefined}
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
        {open && <UpdatedProductsBody {...props} compact={compact} onDismiss={dismiss} escapeRef={escape} />}
      </SheetContent>
    </Sheet>
  );
}

interface UpdatedProductsBodyProps extends UpdatedProductsSheetProps {
  compact: boolean;
  onDismiss: () => void;
  /** Set by the body: true when Esc must keep the sheet open (a "Got it" out or unconfirmed). */
  escapeRef: { current: (() => boolean) | null };
}

/** The pages shown: one page at a time on a wide screen; on a phone every page loaded so far ("Load more"). */
function pagesShown(compact: boolean, page: number, pagesLoaded: number): number[] {
  return compact ? Array.from({ length: pagesLoaded }, (_, index) => index) : [page];
}

function UpdatedProductsBody(props: UpdatedProductsBodyProps) {
  const { storeConnectionId, compact } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  const [page, setPage] = useState(0);
  const [pagesLoaded, setPagesLoaded] = useState(1);
  const pages = pagesShown(compact, page, pagesLoaded);
  // Fresh each opening (staleTime 0, D6); off while the selection is too large (D18). useQueries can't infer a
  // mapped list: every entry is this read's parsed answer.
  const reads = useQueries({
    queries: pages.map((shown) => updatedProductsSheetQueryOptions(storeConnectionId, shown, props.summary, true)),
  }) as UseQueryResult<UpdatedProductsView>[];
  // Refused because more than 10,000 sizes are chosen now: the banner says so, as for the lists (D18).
  useReportListTooLarge(reads[0]?.error, props.onBlocked);

  // The last confirmed "Got it": its answer (what moved again, 10.3) outlives the 3 s "Saved" flash while the sheet stays open.
  const [lastAnswer, setLastAnswer] = useState<AcknowledgeCategoryMovesResponse | null>(null);
  const [lastDone, setLastDone] = useState(false);
  // Why a "Got it" didn't start (another listing action runs); null otherwise.
  const [notice, setNotice] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const latestDraft = useRef(drafts.draft);
  latestDraft.current = drafts.draft;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const states: UpdatedProductsSheetState[] = reads.map((read) => updatedProductsSheetState({
    read: { data: read.data, error: read.error },
    draft: drafts.draft,
    right: props.right,
    busy: props.saveCallbacks.disabled === true || running,
    nowMs: drafts.now(),
    lastAnswer,
    lastDone,
  }));
  // The first page carries what every page shares (the title, the lines, "Got it for all N", the buttons' state);
  // the last page loaded says whether more is being read, failed, or follows.
  const primary = states[0];
  const last = states[states.length - 1];
  const lastRead = reads[reads.length - 1];
  // A phone shows every page loaded so far, each product once (the pages are read again one by one after a Got it).
  const rows: UpdatedProductRowModel[] = compact ? uniqueUpdatedProductRows(states.map((state) => state.rows)) : primary.rows;

  // After a "Got it" the rows are read again and fewer pages may be left: a page past the end goes back to the last one.
  const pageCount = primary.paging?.pageCount ?? null;
  useEffect(() => {
    if (!compact && pageCount !== null && page > 0 && page >= pageCount) setPage(pageCount - 1);
  }, [compact, page, pageCount]);

  // Esc (plan 3.4): a "Got it" out or unconfirmed keeps the sheet open.
  useEffect(() => {
    props.escapeRef.current = () => primary.escapeKeepsOpen;
    return () => { props.escapeRef.current = null; };
  });

  /** One "Got it" (or Check again) from the button to settled: the lib's runner, with the page's own reads after it. */
  async function run(sent: ListingSettingsDraft) {
    inFlight.current = true;
    setRunning(true);
    setNotice(null);
    try {
      const outcome = await runCategoryMovesAcknowledge({
        storeConnectionId,
        draft: sent,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => postJson<unknown>(categoryMovesAcknowledgeEndpoint(storeConnectionId), body),
        reread: () => rereadAfterCategoryMoves(queryClient, storeConnectionId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      if (outcome.kind === "saved") {
        setLastAnswer(outcome.answer);
        setLastDone(true);
      } else if (outcome.kind === "not_started" && outcome.message !== null) {
        setNotice(outcome.message);
      }
      // A failed "Got it" is worded by the draft (`updatedProductsSheetState` lines).
    } finally {
      inFlight.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  /**
   * [Got it] or [Got it for all N]: the step's one draft takes the items (D16), then the request runs. Another
   * editor's unsaved change asks first; after "Discard and leave" the provider opens this draft and the press runs
   * from there, so the vendor presses once. Open and run go together, so no other editor can take the draft
   * between them. The draft the runner reads is the one the provider just built, reduced here the same way,
   * because the provider's state reaches this render only afterwards. The same "Got it" after a rate limit or a
   * lost connection goes out again as the held draft, with its kept key (D5).
   */
  function gotIt(body: GotItBody) {
    if (inFlight.current) return;
    const held = latestDraft.current;
    // A "Got it" out or unconfirmed is checked again from its own button, never replaced.
    if (isUpdatedProductsDraft(held) && isDraftLocked(held)) return;
    const value = updatedProductsDraftValue(body);
    const again = heldGotItFor(held, storeConnectionId, value.items);
    if (again !== null) {
      void run(again);
      return;
    }
    const place = LISTING_SETTINGS_UPDATED_WORDS.title;
    const opening = { type: "open", editor: UPDATED_PRODUCTS_EDITOR_ID, place, base: value } as const;
    const opened = drafts.open(UPDATED_PRODUCTS_EDITOR_ID, place, value, () => {
      // The other editor's change was discarded on the vendor's say-so and the provider opened this draft (from no draft).
      if (!mounted.current || inFlight.current) return;
      const sent = reduceListingSettingsDraft(null, opening);
      if (sent !== null) void run(sent);
    });
    if (!opened) return;
    const sent = reduceListingSettingsDraft(held, opening);
    if (sent === null) return;
    void run(sent);
  }

  /** [Check again]: the unconfirmed "Got it" again, with the same key and the same items (D5, D7b). */
  function checkAgain() {
    const held = latestDraft.current;
    if (inFlight.current || held === null || !isUpdatedProductsDraft(held) || held.phase !== "uncertain") return;
    void run(held);
  }

  /** [Reload] after a confirmed "Got it" whose re-read failed: the views again, then the draft goes (it holds no change). */
  async function reload() {
    try {
      await rereadAfterCategoryMoves(queryClient, storeConnectionId);
    } catch {
      // Deliberate: a refetch failed again. Each page's own read state shows it, with [Try again]; the "Got it" stood.
    } finally {
      if (mounted.current && isUpdatedProductsDraft(latestDraft.current)) drafts.discard();
    }
  }

  const { gotItAll } = primary;
  return (
    <>
      <div className="space-y-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        <div className="flex items-start gap-2">
          {compact && <CloseButton phone onClick={props.onDismiss} />}
          <SheetTitle className="min-w-0 flex-1 break-words text-base font-semibold text-zinc-900">{primary.title}</SheetTitle>
          {!compact && <CloseButton onClick={props.onDismiss} />}
        </div>
        {/* After ← or ×, as in the drawer: the sheet never opens with its focus on the button that acknowledges every move (plan 3.4). */}
        {gotItAll.shown && (
          <div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              aria-label={gotItAll.label}
              disabled={gotItAll.disabled}
              data-testid="updated-products-got-it-all"
              onClick={() => { if (gotItAll.body !== null) gotIt(gotItAll.body); }}
            >
              {gotItAll.label}
            </Button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {primary.reason && <p className="text-xs text-zinc-600" data-testid="updated-products-reason">{primary.reason}</p>}
        {primary.lines.map((line) => (
          <p
            key={line.text}
            role={line.tone === "alert" ? "alert" : "status"}
            className={line.tone === "ok" ? "text-sm text-emerald-800" : line.tone === "alert" ? "text-sm text-amber-900" : "text-sm text-zinc-700"}
            data-testid="updated-products-line-status"
          >
            {line.text}
          </p>
        ))}
        {notice && <p role="alert" className="text-sm text-amber-900">{notice}</p>}
        {(primary.checkAgain.shown || primary.reload.shown) && (
          <div className="flex flex-wrap gap-2">
            {primary.checkAgain.shown && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={running} onClick={checkAgain}>
                {primary.checkAgain.label}
              </Button>
            )}
            {primary.reload.shown && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void reload()}>
                {primary.reload.label}
              </Button>
            )}
          </div>
        )}
        {rows.length > 0 && (
          <ul aria-label={primary.title} className="divide-y divide-zinc-100 rounded-md border border-zinc-200 px-4" data-testid="updated-products-rows">
            {rows.map((row) => (
              <UpdatedProductRowItem key={row.key} row={row} disabled={primary.buttonsDisabled} onGotIt={gotIt} onCheck={props.onCheckOwnText} />
            ))}
          </ul>
        )}
        {last.loadingLine && <p role="status" className="text-sm text-zinc-600">{last.loadingLine}</p>}
        {last.problem && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="updated-products-read-problem">
            <span>{last.problem.text}</span>
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void lastRead?.refetch()}>
              {last.problem.retryLabel}
            </Button>
          </div>
        )}
        {primary.empty && <p role="status" className="text-sm text-zinc-700" data-testid="updated-products-empty">{primary.empty}</p>}
        {last.paging && (compact ? (
          last.paging.hasNext && (
            <Button type="button" variant="outline" className="min-h-11 w-full" onClick={() => setPagesLoaded((count) => count + 1)}>
              {last.paging.loadMoreLabel}
            </Button>
          )
        ) : (
          last.paging.text !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-600" data-testid="updated-products-paging">
              <span>{last.paging.text}</span>
              {last.paging.pageCount > 1 && (
                <div className="flex gap-2">
                  <Button type="button" variant="outline" size="sm" disabled={!last.paging.hasPrevious} onClick={() => setPage(page - 1)}>
                    {LISTING_SETTINGS_LIST_WORDS.previous}
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={!last.paging.hasNext} onClick={() => setPage(page + 1)}>
                    {LISTING_SETTINGS_LIST_WORDS.next}
                  </Button>
                </div>
              )}
            </div>
          )
        ))}
      </div>
    </>
  );
}

/**
 * One product Card Shellz updated (plan 10.3): "Penny Sleeves · Moved from
 * Sleeves to Toploaders." with the category settings that differ and [Got
 * it]; "Wordy Mailers · Card Shellz changed this product. Check your text
 * still fits." with [Check]; or both for a product with a move and own text.
 * Hook-free, so a test can press its buttons.
 */
export function UpdatedProductRowItem({ row, disabled, onGotIt, onCheck }: {
  row: UpdatedProductRowModel;
  /** Every [Got it] is off: a "Got it" is out or unconfirmed, another action runs, or the right is gone. */
  disabled: boolean;
  onGotIt: (body: GotItBody) => void;
  onCheck: (action: OwnTextCheckAction) => void;
}) {
  const { move, ownText } = row;
  const first = move?.text ?? ownText?.text ?? null;
  return (
    <li className="space-y-2 py-3" data-testid={`updated-product-${row.productId}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1 text-sm text-zinc-800">
          <p className="break-words">
            <span className="font-medium text-zinc-900">{row.productName}</span>
            {first !== null && <> · {first}</>}
          </p>
          {move && <p className="text-xs text-zinc-600">{move.changes}</p>}
          {move && ownText && <p className="break-words">{ownText.text}</p>}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 self-start">
          {move && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              aria-label={move.gotIt.ariaLabel}
              disabled={disabled}
              onClick={() => onGotIt(move.gotIt.body)}
            >
              {move.gotIt.label}
            </Button>
          )}
          {ownText && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-8"
              aria-label={ownText.check.ariaLabel}
              onClick={() => onCheck(ownText.check.action)}
            >
              {ownText.check.label}
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}
