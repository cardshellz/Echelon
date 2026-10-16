import { useEffect, useReducer, useRef, type Ref } from "react";
import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ListingRulesConversionCheck } from "@shared/dropship/listing-rules-conversion";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import {
  OLDER_RULES_SHEET_OPENED,
  conversionCheckQueryOptions,
  conversionTooLargeError,
  olderRulesGoneRereadKeys,
  olderRulesSheetPages,
  olderRulesSheetSession,
  olderRulesSheetState,
  type ConversionBlockedList,
  type ConversionBlockedSize,
  type ConversionLinesList,
  type ConversionRowModel,
  type ConversionSizeAction,
  type ConversionSummaryFacts,
  type OlderRulesSheetContent,
  type OlderRulesSheetProblem,
  type OlderRulesSheetState,
} from "@/lib/dropship-listing-settings-conversion";
import type { FocusReturnTarget } from "./EditorSurface";
import { CloseButton, PRODUCT_DRAWER_CLASS, anotherDialogOpen } from "./ProductDrawer";
import { useReportListTooLarge } from "./ProductsTab";

export type SetPriceFromSheetAction = Extract<ConversionSizeAction, { kind: "set_price" }>;
export type FixFromSheetAction = Extract<ConversionSizeAction, { kind: "fix" }>;

export interface OlderRulesSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=convert`, D21), no drawer is open (D20) and the selection is not too large (D18). */
  open: boolean;
  /** The step's summary read: the dry run's read is off while it says too large (D18). */
  summary: ConversionSummaryFacts;
  /** The step takes `?sheet=` off the address in place. Browser Back closes the sheet without this. */
  onClose: () => void;
  /** [Set a price]: the step takes the sheet off the address and opens the drawer on the size's Exact price, in one push (D20, D21). */
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  /** [Fix]: the same, on the drawer row of the size's first blocker. */
  onFix: (action: FixFromSheetAction) => void;
  /** The check refused as too large: the banner says why, as for the lists (D18). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the sheet closes: [See what changes] on the line or the card (plan 3.4). */
  returnFocusTo?: FocusReturnTarget;
  /** Where focus goes when that opener is gone (the editor's button, say): the Category settings card's heading, then the step's (11.2). */
  focusFallbacks?: () => readonly (HTMLElement | null | undefined)[];
}

/**
 * The first element of `candidates` still on the page (11.2, CUX#11): the
 * opener, else the Category settings card's heading, else the step's heading.
 */
export function sheetFocusTarget(candidates: readonly (HTMLElement | null | undefined)[]): HTMLElement | null {
  return candidates.find((element): element is HTMLElement => element !== null && element !== undefined && element.isConnected) ?? null;
}

/**
 * "Your older group rules" (Listing settings PR 11b, plan 5.2, 5.3, 11.2,
 * 11.5): a read-only preview of moving the store's older group rules into
 * category and product settings, from the dry run (`GET …/conversion?page=N`,
 * 11a2), read fresh on every opening and only while it is open (D18: never
 * a mount read). In 11.2's order: whether the move changes anything; what
 * blocks it, each size with [Set a price] or [Fix]; what the rules become;
 * why some sizes would change; the sizes that would change, 50 at a time
 * with [Load more]; the rules that never apply; what is kept as it is. The
 * footer says nothing is moved yet: nothing can be (11b).
 *
 * It opens at `?sheet=convert` as the drawer's right sheet, full screen on a
 * phone, with cards for its rows there. Browser Back, × (← on a phone), Esc
 * and [Close] close it; it holds no draft. A later page answered for
 * another plan resets the list to page 0 and says something changed (one
 * plan per screen, CUX#12); a store already moved re-reads the summary, the
 * categories and the three profiles once (11.5). Every decision and every
 * word is the lib's (`dropship-listing-settings-conversion.ts`).
 */
export function OlderRulesSheet(props: OlderRulesSheetProps) {
  const { open, onClose } = props;
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent
        side="right"
        data-testid="older-rules-sheet"
        className={PRODUCT_DRAWER_CLASS}
        // The title names the sheet; Radix's aria-describedby would point at nothing.
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          // Closed into another surface ([Set a price] or [Fix] opened the drawer): that surface keeps the focus it took.
          if (anotherDialogOpen()) {
            event.preventDefault();
            return;
          }
          const target = sheetFocusTarget([props.returnFocusTo?.current ?? null, ...(props.focusFallbacks?.() ?? [])]);
          if (target === null) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Mounted per opening: each one starts at page 0 with a new session (11.2, 11.5). */}
        {open && <OlderRulesSheetBody {...props} compact={compact} />}
      </SheetContent>
    </Sheet>
  );
}

function OlderRulesSheetBody(props: OlderRulesSheetProps & { compact: boolean }) {
  const { storeConnectionId, summary, compact, onClose } = props;
  const queryClient = useQueryClient();
  const [session, dispatch] = useReducer(olderRulesSheetSession, OLDER_RULES_SHEET_OPENED);
  const pages = olderRulesSheetPages(session);
  // One read per page shown, fresh each opening (staleTime 0, gcTime 0); off while the summary says too large (D18).
  // useQueries can't infer a mapped list: every entry is this read's parsed answer.
  const reads = useQueries({
    queries: pages.map((page) => conversionCheckQueryOptions(storeConnectionId, page, { open: true, summary })),
  }) as UseQueryResult<ListingRulesConversionCheck>[];
  // Refused because more than 10,000 sizes are chosen now, on page 0 or a later page: the banner says so (D18), and
  // the sheet closes below (5.3).
  useReportListTooLarge(conversionTooLargeError(reads), props.onBlocked);
  // 11b moves nothing, so no confirmed outcome exists yet (11d adds them).
  const state = olderRulesSheetState({ pages: reads.map((read) => ({ data: read.data, error: read.error })), session, outcome: null });

  // A page of another plan than page 0's (CUX#12): the further pages drop and page 0 is read again. The body goes back
  // to its top, where "Something changed…" is: [Load more] was pressed under the rows, far below it.
  const { resetPages, rereadAfterMoved, close } = state;
  const first = reads[0];
  const firstRead = useRef(first);
  firstRead.current = first;
  const body = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!resetPages) return;
    dispatch({ type: "plan_changed" });
    if (body.current) body.current.scrollTop = 0;
    void firstRead.current?.refetch();
  }, [resetPages]);

  // The store has no older rules any more (an old address, or moved meanwhile, 11.5): the summary, the categories and
  // the three profiles are read again once per opening, never the dry run itself, so this cannot loop.
  useEffect(() => {
    if (!rereadAfterMoved) return;
    dispatch({ type: "moved_reread" });
    for (const queryKey of olderRulesGoneRereadKeys(storeConnectionId)) {
      void queryClient.invalidateQueries({ queryKey: [...queryKey], exact: true });
    }
  }, [rereadAfterMoved, queryClient, storeConnectionId]);

  // The check refused the selection as too large: the sheet leaves the address; the banner says why.
  useEffect(() => {
    if (close) onClose();
  }, [close, onClose]);

  return (
    <OlderRulesSheetView
      state={state}
      compact={compact}
      bodyRef={body}
      onClose={onClose}
      onRetry={() => void first?.refetch()}
      onSetPrice={props.onSetPrice}
      onFix={props.onFix}
      onLoadMore={() => dispatch({ type: "load_more" })}
      // A later page's [Try again] reads the page that failed: the first one not answered yet.
      onRetryMore={() => void reads.find((read, index) => index > 0 && (read.error != null || read.data === undefined))?.refetch()}
    />
  );
}

/**
 * The sheet's title, body and footer as its model says (hook-free, so every
 * state renders in a test): the changed line, page 0 loading, a problem
 * with [Try again], "no older group rules any more", or the report; then the
 * read-only footer with [Close].
 */
export function OlderRulesSheetView({ state, compact, bodyRef, onClose, onRetry, onSetPrice, onFix, onLoadMore, onRetryMore }: {
  state: OlderRulesSheetState;
  compact: boolean;
  /** The scrolling body, so the sheet can bring "Something changed…" back into view (CUX#12). */
  bodyRef?: Ref<HTMLDivElement>;
  onClose: () => void;
  /** Page 0's [Try again]. */
  onRetry: () => void;
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  onFix: (action: FixFromSheetAction) => void;
  onLoadMore: () => void;
  /** A later page's [Try again]. */
  onRetryMore: () => void;
}) {
  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={onClose} />}
        <SheetTitle className="min-w-0 flex-1 break-words text-base font-semibold text-zinc-900">{state.title}</SheetTitle>
        {!compact && <CloseButton onClick={onClose} />}
      </div>

      <div ref={bodyRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6" data-testid="older-rules-sheet-body">
        {state.changedLine && <p role="status" className="text-sm text-amber-900" data-testid="older-rules-changed">{state.changedLine}</p>}
        {state.loadingLine && <p role="status" className="text-sm text-zinc-600" data-testid="older-rules-loading">{state.loadingLine}</p>}
        {state.problem && <ProblemLine problem={state.problem} testId="older-rules-problem" onRetry={onRetry} />}
        {state.noneLine && <p role="status" className="text-sm text-zinc-800" data-testid="older-rules-none">{state.noneLine}</p>}
        {state.content && (
          <ReportBody content={state.content} onSetPrice={onSetPrice} onFix={onFix} onLoadMore={onLoadMore} onRetryMore={onRetryMore} />
        )}
      </div>

      <div
        className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-background px-4 py-3 sm:px-6"
        data-testid="older-rules-footer"
      >
        <span className="mr-auto text-sm text-zinc-700">{state.footer.text}</span>
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onClose}>{state.footer.closeLabel}</Button>
      </div>
    </>
  );
}

/** A read that failed, in the vendor's words, with [Try again] unless it can't help (too large closes the sheet). */
function ProblemLine({ problem, testId, onRetry }: { problem: OlderRulesSheetProblem; testId: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid={testId}>
      <span>{problem.text}</span>
      {problem.retryLabel !== null && (
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={onRetry}>{problem.retryLabel}</Button>
      )}
    </div>
  );
}

const HEADING = "text-sm font-semibold text-zinc-900";

/**
 * The dry run's answer in 11.2's order (hook-free, so a test can press its
 * buttons): the summary line and `laterProducts`; "Before you can move them
 * over"; "They become:"; "Why some sizes would change"; "Sizes that would
 * change" with [Load more]; the rules that never apply; "Kept as they are".
 */
export function ReportBody({ content, onSetPrice, onFix, onLoadMore, onRetryMore }: {
  content: OlderRulesSheetContent;
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  onFix: (action: FixFromSheetAction) => void;
  onLoadMore: () => void;
  onRetryMore: () => void;
}) {
  const { blocked, becomes, reasons, changes, neverApplies } = content;
  return (
    <>
      <div className="space-y-1 text-sm text-zinc-800">
        <p className="font-medium text-zinc-900" data-testid="older-rules-summary">{content.summary}</p>
        {content.laterProducts && <p className="text-zinc-600" data-testid="older-rules-later">{content.laterProducts}</p>}
      </div>

      {blocked && (
        <section aria-label={blocked.heading} className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-3 sm:p-4" data-testid="older-rules-blocked">
          <h3 className={HEADING}>{blocked.heading}</h3>
          {blocked.wouldLosePrice && (
            <BlockedSizes list={blocked.wouldLosePrice} testId="older-rules-lose-price" onSetPrice={onSetPrice} onFix={onFix} />
          )}
          {blocked.wouldBlockListing && (
            <BlockedSizes list={blocked.wouldBlockListing} testId="older-rules-block-listing" onSetPrice={onSetPrice} onFix={onFix} />
          )}
          {blocked.tooMuchText && <p className="text-sm text-amber-900" data-testid="older-rules-too-much-text">{blocked.tooMuchText}</p>}
        </section>
      )}

      {becomes && (
        <section aria-label={becomes.heading} className="space-y-2" data-testid="older-rules-becomes">
          <h3 className={HEADING}>{becomes.heading}</h3>
          <Lines list={becomes.categories} testId="older-rules-becomes-categories" />
          <Lines list={becomes.products} testId="older-rules-becomes-products" />
        </section>
      )}

      {reasons && (
        <section aria-label={reasons.heading ?? undefined} className="space-y-2" data-testid="older-rules-reasons">
          {reasons.heading && <h3 className={HEADING}>{reasons.heading}</h3>}
          {reasons.lists.map((list) => <Lines key={list.key} list={list} testId={`older-rules-reason-${list.key}`} />)}
        </section>
      )}

      {changes && (
        <section aria-label={changes.heading} className="space-y-2" data-testid="older-rules-changes">
          <h3 className={HEADING}>{changes.heading}</h3>
          {/* Cards on a phone, a list from 640 px (11.2, PLAN10 3.4). */}
          <ul className="space-y-2 sm:space-y-0 sm:divide-y sm:divide-zinc-100 sm:rounded-md sm:border sm:border-zinc-200 sm:px-4" data-testid="older-rules-rows">
            {changes.rows.map((row) => <ChangedRow key={row.key} row={row} />)}
          </ul>
          {changes.more?.kind === "loading" && <p role="status" className="text-sm text-zinc-600" data-testid="older-rules-more-loading">{changes.more.text}</p>}
          {changes.more?.kind === "problem" && <ProblemLine problem={changes.more.problem} testId="older-rules-more-problem" onRetry={onRetryMore} />}
          {changes.loadMore.shown && (
            <Button type="button" variant="outline" className="min-h-11 w-full sm:min-h-9 sm:w-auto" data-testid="older-rules-load-more" onClick={onLoadMore}>
              {changes.loadMore.label}
            </Button>
          )}
        </section>
      )}

      {neverApplies && <Lines list={neverApplies} testId="older-rules-never-applies" />}
      {content.kept && <p className="text-sm text-zinc-700" data-testid="older-rules-kept">{content.kept}</p>}
    </>
  );
}

/** A list of the server's lines with its "and 12 more". */
function Lines({ list, testId }: { list: ConversionLinesList; testId: string }) {
  if (list.lines.length === 0 && list.more === null) return null;
  return (
    <ul className="space-y-1 text-sm text-zinc-800" data-testid={testId}>
      {list.lines.map((line, index) => <li key={`${index}:${line}`} className="break-words">{line}</li>)}
      {list.more && <li className="text-zinc-600">{list.more}</li>}
    </ul>
  );
}

/** One kind of block: what it means, then each size with its one button, then "and 12 more". */
function BlockedSizes({ list, testId, onSetPrice, onFix }: {
  list: ConversionBlockedList;
  testId: string;
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  onFix: (action: FixFromSheetAction) => void;
}) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <p className="text-sm text-amber-900">{list.text}</p>
      <ul className="space-y-2">
        {list.sizes.map((size) => <BlockedSizeItem key={size.key} size={size} onSetPrice={onSetPrice} onFix={onFix} />)}
      </ul>
      {list.more && <p className="text-sm text-zinc-600">{list.more}</p>}
    </div>
  );
}

/** A blocked size: "Penny Sleeves · Pack of 100", "Now: $4.99", why, and [Set a price] or [Fix] named with the size (plan 3.4). */
export function BlockedSizeItem({ size, onSetPrice, onFix }: {
  size: ConversionBlockedSize;
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  onFix: (action: FixFromSheetAction) => void;
}) {
  const { action } = size;
  return (
    <li
      className="flex flex-col gap-2 rounded-md border border-amber-200 bg-white p-3 sm:flex-row sm:items-start sm:justify-between"
      data-testid={`older-rules-blocked-${size.key}`}
    >
      <div className="min-w-0 space-y-1 text-sm">
        <p className="break-words font-medium text-zinc-900">{size.text}</p>
        {size.priceNow && <p className="text-zinc-600">{size.priceNow}</p>}
        {size.reasons && <p className="break-words text-zinc-700">{size.reasons}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 shrink-0 self-start sm:min-h-8"
        aria-label={action.ariaLabel}
        onClick={() => (action.kind === "set_price" ? onSetPrice(action) : onFix(action))}
      >
        {action.label}
      </Button>
    </li>
  );
}

/** A changed size: its head, then one line per changed key (the server's diff, the page's words). */
function ChangedRow({ row }: { row: ConversionRowModel }) {
  return (
    <li className="space-y-1 rounded-md border border-zinc-200 p-3 text-sm sm:rounded-none sm:border-0 sm:px-0" data-testid={`older-rules-row-${row.productVariantId}`}>
      <p className="break-words font-medium text-zinc-900">{row.head}</p>
      <ul className="space-y-0.5 text-zinc-700">
        {row.lines.map((line, index) => <li key={`${index}:${line}`} className="break-words">{line}</li>)}
      </ul>
    </li>
  );
}
