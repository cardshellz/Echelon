import { useCallback, useEffect, useReducer, useRef, useState, type Ref } from "react";
import { useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { ListingRulesConversionCheck } from "@shared/dropship/listing-rules-conversion";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  OLDER_RULES_SHEET_OPENED,
  conversionCheckQueryOptions,
  conversionOutcomeOf,
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
  type OlderRulesSheetFooter,
  type OlderRulesSheetOutcome,
  type OlderRulesSheetProblem,
  type OlderRulesSheetState,
} from "@/lib/dropship-listing-settings-conversion";
import { conversionNoticeModel, conversionNoticeQueryOptions } from "@/lib/dropship-listing-settings-conversion-notice";
import {
  heldConversionFor,
  isConversionDraft,
  rereadAfterConversion,
  runConversionApply,
  sendConversionApply,
  type ConversionDraftValue,
} from "@/lib/dropship-listing-settings-conversion-requests";
import {
  CONVERSION_EDITOR_ID,
  isDraftLocked,
  reduceListingSettingsDraft,
  type ListingSettingsDraft,
} from "@/lib/dropship-listing-settings-drafts";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import { LISTING_SETTINGS_CONVERSION_WORDS } from "@/lib/dropship-listing-settings-words";
import type { FocusReturnTarget } from "./EditorSurface";
import { firstConnected } from "./focusTarget";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { CloseButton, PRODUCT_DRAWER_CLASS, anotherDialogOpen } from "./ProductDrawer";
import { useReportListTooLarge } from "./ProductsTab";
import { useConversionNoticeGotIt } from "./useConversionNoticeGotIt";

export type SetPriceFromSheetAction = Extract<ConversionSizeAction, { kind: "set_price" }>;
export type FixFromSheetAction = Extract<ConversionSizeAction, { kind: "fix" }>;

export interface OlderRulesSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=convert`, D21), no drawer is open (D20) and the selection is not too large (D18). */
  open: boolean;
  /** The step's summary read: the dry run's read is off while it says too large (D18). */
  summary: ConversionSummaryFacts;
  /** W11's right (`rights.conversion`, PLAN10 D3): [Move them over] is off without it, with the right's line. */
  right: ListingSettingsRight;
  /** The page's pending-save counter (PLAN10 D10). */
  saveCallbacks: ProductSettingsSaveCallbacks;
  /** After a confirmed move: the step marks the step 3 preview stale and reads every listing settings view again (8.4). */
  onSaved: () => void;
  /** The step takes `?sheet=` off the address in place. Browser Back closes the sheet without this. */
  onClose: () => void;
  /** [Set a price]: the step takes the sheet off the address and opens the drawer on the size's Exact price, in one push (D20, D21). */
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  /** [Fix]: the same, on the drawer row of the size's first blocker. */
  onFix: (action: FixFromSheetAction) => void;
  /** The check refused as too large, or a move refused because of a block: the banner says why (D18; PLAN10 D8). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the sheet closes: [See what changes] on the line or the card (plan 3.4). */
  returnFocusTo?: FocusReturnTarget;
  /** Where focus goes when that opener is gone (the editor's button, say): the Category settings card's heading, then the step's (11.2). */
  focusFallbacks?: () => readonly (HTMLElement | null | undefined)[];
}

/**
 * "Your older group rules" (Listing settings PR 11b, plan 5.2, 5.3, 11.2,
 * 11.5; 11d, plan 8.2, 8.3): what moving the store's older group rules into
 * category and product settings would do, from the dry run (`GET
 * …/conversion?page=N`, 11a2), read fresh on every opening and only while it
 * is open (D18: never a mount read). In 11.2's order: whether the move
 * changes anything; what blocks it, each size with [Set a price] or [Fix];
 * what the rules become; why some sizes would change; the sizes that would
 * change, 50 at a time with [Load more]; the rules that never apply; what is
 * kept as it is. The footer has [Move them over] (W11, 8.3), which sends the
 * two hashes of page 0 as shown and nothing else, and only when pressed (D1).
 *
 * It opens at `?sheet=convert` as the drawer's right sheet, full screen on a
 * phone, with cards for its rows there. Browser Back, × (← on a phone), Esc
 * and [Close] close it. The move lives in the step's one draft (editor
 * `convert`) and holds no change: Back keeps an unconfirmed move so [Check
 * again] stays reachable (D21), Esc keeps the sheet while one is out (plan
 * 3.4), and a confirmed outcome stays until the sheet closes (CUX#11). A later
 * page answered for another plan resets the list to page 0 and says
 * something changed (one plan per screen, CUX#12); a store already moved
 * re-reads the summary, the categories, the notice and the three profiles
 * once (11.5), and when the job moved it and no one saw its notice yet, says
 * what moved with [Got it] (11e1, D19).
 * Every decision and every word is the lib's
 * (`dropship-listing-settings-conversion.ts`, `-conversion-requests.ts`).
 */
export function OlderRulesSheet(props: OlderRulesSheetProps) {
  const { open, onClose } = props;
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const escape = useRef<(() => boolean) | null>(null);
  const drafts = useListingSettingsDrafts();
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;
  const { close: closeDraft } = drafts;

  // The address decides what shows: once it no longer opens the sheet (Back, or a close), an unconfirmed move is hidden
  // and kept (D21); a confirmed or refused one goes with the sheet (the draft holds no change).
  const wasOpen = useRef(open);
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    const draft = draftRef.current;
    if (before && !open && isConversionDraft(draft) && draft?.open) closeDraft();
  }, [open, closeDraft]);

  const dismiss = useCallback(() => {
    // Nothing to ask about: the draft holds no change. A move in flight settles on its own, hidden.
    if (isConversionDraft(draftRef.current)) closeDraft();
    onClose();
  }, [closeDraft, onClose]);

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <SheetContent
        side="right"
        data-testid="older-rules-sheet"
        className={PRODUCT_DRAWER_CLASS}
        // The title names the sheet; Radix's aria-describedby would point at nothing.
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          if (escape.current?.()) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          // Closed into another surface ([Set a price] or [Fix] opened the drawer): that surface keeps the focus it took.
          if (anotherDialogOpen()) {
            event.preventDefault();
            return;
          }
          // The opener, else the Category settings card's heading, else the step's (11.2, CUX#11).
          const target = firstConnected([props.returnFocusTo?.current ?? null, ...(props.focusFallbacks?.() ?? [])]);
          if (target === null) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Mounted per opening: each one starts at page 0 with a new session and no outcome (11.2, 11.5). */}
        {open && <OlderRulesSheetBody {...props} compact={compact} onDismiss={dismiss} escapeRef={escape} />}
      </SheetContent>
    </Sheet>
  );
}

interface OlderRulesSheetBodyProps extends OlderRulesSheetProps {
  compact: boolean;
  /** ×, ←, [Close] and a too-large refusal: the draft closes (an unconfirmed move is kept) and the sheet leaves the address. */
  onDismiss: () => void;
  /** Set by the body: true when Esc must keep the sheet open (a move out or unconfirmed). */
  escapeRef: { current: (() => boolean) | null };
}

function OlderRulesSheetBody(props: OlderRulesSheetBodyProps) {
  const { storeConnectionId, summary, compact, onDismiss } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
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

  // A confirmed move's outcome stays until the sheet closes, whatever the re-reads answer (CUX#11); the body mounts per
  // opening, so closing drops it.
  const [outcome, setOutcome] = useState<OlderRulesSheetOutcome | null>(null);
  // Why a press didn't start (another listing action runs); null otherwise.
  const [notStartedLine, setNotStartedLine] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const inFlight = useRef(false);
  const latestDraft = useRef(drafts.draft);
  latestDraft.current = drafts.draft;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The one-time notice (11e1, D19, D25): the step's mount read, shared by key, so the sheet reads nothing more for it. Its
  // words and [Got it] show only where the sheet finds the store already moved (the lib decides where).
  const noticeRead = useQuery(conversionNoticeQueryOptions(storeConnectionId));
  const gotIt = useConversionNoticeGotIt(storeConnectionId);
  const noticeId = noticeRead.data?.notice?.conversionId ?? null;
  const noticeModel = conversionNoticeModel({ data: noticeRead.data, error: noticeRead.error },
    noticeId === null ? null : gotIt.failureFor(noticeId));

  const first = reads[0];
  const firstRead = useRef(first);
  firstRead.current = first;
  const state = olderRulesSheetState({
    pages: reads.map((read) => ({ data: read.data, error: read.error })),
    session,
    outcome,
    apply: {
      draft: drafts.draft,
      right: props.right,
      busy: props.saveCallbacks.disabled === true || running,
      // A press waits while page 0 is read again: its hashes are about to be replaced (D1).
      checking: first?.isFetching === true,
      notStartedLine,
    },
    notice: noticeModel === null ? null : { model: noticeModel, sending: gotIt.sending },
  });

  // Esc (plan 3.4): a move out or unconfirmed keeps the sheet open.
  const { escapeRef } = props;
  const escapeKeepsOpen = state.footer.escapeKeepsOpen;
  useEffect(() => {
    escapeRef.current = () => escapeKeepsOpen;
    return () => { escapeRef.current = null; };
  }, [escapeRef, escapeKeepsOpen]);

  // A page of another plan than page 0's (CUX#12): the further pages drop and page 0 is read again. The body goes back
  // to its top, where "Something changed…" is: [Load more] was pressed under the rows, far below it.
  const { resetPages, rereadAfterMoved, close } = state;
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
    if (close) onDismiss();
  }, [close, onDismiss]);

  // A confirmed move took [Move them over] away: focus goes to [Close], beside the outcome's words.
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const confirmed = outcome !== null;
  useEffect(() => {
    if (confirmed) closeButton.current?.focus();
  }, [confirmed]);

  /** One move (or Check again) from the button to settled: the lib's runner, with the sheet's own reads after it. */
  async function run(sent: ListingSettingsDraft) {
    inFlight.current = true;
    setRunning(true);
    setNotStartedLine(null);
    try {
      const result = await runConversionApply({
        storeConnectionId,
        draft: sent,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => sendConversionApply(storeConnectionId, body),
        reread: () => rereadAfterConversion(queryClient, storeConnectionId),
        // After a refusal that says the plan moved (8.3): page 0 alone, read again; nothing more is sent.
        rereadCheck: async () => {
          dispatch({ type: "check_again" });
          await firstRead.current?.refetch({ throwOnError: true });
        },
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      if (result.kind === "applied") setOutcome(conversionOutcomeOf(result.answer, result.viewStale));
      else if (result.kind === "not_started" && result.message !== null) setNotStartedLine(result.message);
      // A failed move is worded by the draft (the footer's lines).
    } finally {
      inFlight.current = false;
      if (mounted.current) setRunning(false);
    }
  }

  /**
   * [Move them over]: the step's one draft takes page 0's two hashes as shown (`footer.press`, D1), then the move runs.
   * Another editor's unsaved change asks first; after "Discard and leave" the provider opens this draft and the press
   * runs from there, so the vendor presses once. Open and run go together, so no other editor can take the draft
   * between them. The same plan after a rate limit or an answer that said "not now" goes out again as the held draft,
   * with its kept key (PLAN10 D5).
   */
  function move(value: ConversionDraftValue) {
    if (inFlight.current) return;
    const held = latestDraft.current;
    // A move out or unconfirmed is checked again from its own button, never replaced.
    if (isConversionDraft(held) && isDraftLocked(held)) return;
    const again = heldConversionFor(held, storeConnectionId, value);
    if (again !== null) {
      void run(again);
      return;
    }
    const place = LISTING_SETTINGS_CONVERSION_WORDS.sheetTitle;
    const opening = { type: "open", editor: CONVERSION_EDITOR_ID, place, base: value } as const;
    const opened = drafts.open(CONVERSION_EDITOR_ID, place, value, () => {
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

  /**
   * [Check again]: the unconfirmed move again, with the same key and the same hashes (PLAN10 D5, D7b). It is this
   * opening's move from here: a sheet reopened after Back finds it kept closed (D21), so the draft is opened first (the
   * reducer keeps a locked draft of the same editor and only sets `open`), and the sheet stays quiet while the move
   * settles, as for a first press (the lib's moveSettling counts an open draft only).
   */
  function checkAgain() {
    const held = latestDraft.current;
    if (inFlight.current || held === null || !isConversionDraft(held) || held.phase !== "uncertain") return;
    const place = LISTING_SETTINGS_CONVERSION_WORDS.sheetTitle;
    if (!drafts.open(CONVERSION_EDITOR_ID, place, held.value)) return;
    const sent = reduceListingSettingsDraft(held, { type: "open", editor: CONVERSION_EDITOR_ID, place, base: held.value });
    if (sent === null) return;
    void run(sent);
  }

  /** The notice's [Got it] (11e1): once it is seen, [Got it] leaves the footer, so focus goes to [Close] beside the words left. */
  async function acknowledgeNotice(conversionId: number) {
    const outcome = await gotIt.press(conversionId);
    if (mounted.current && outcome !== null && outcome.kind !== "failed") closeButton.current?.focus();
  }

  /** [Reload] after a confirmed move whose views couldn't be read: the same re-reads again; the outcome stays. */
  async function reload() {
    try {
      await rereadAfterConversion(queryClient, storeConnectionId);
      if (mounted.current) setOutcome((current) => (current === null ? null : { ...current, viewStale: false }));
    } catch {
      // Deliberate: a refetch failed again; the line stays with [Reload], and each view's own read state shows it.
    }
  }

  const { press } = state.footer;
  return (
    <OlderRulesSheetView
      state={state}
      compact={compact}
      bodyRef={body}
      closeRef={closeButton}
      onClose={onDismiss}
      onRetry={() => void first?.refetch()}
      onSetPrice={props.onSetPrice}
      onFix={props.onFix}
      onLoadMore={() => dispatch({ type: "load_more" })}
      // A later page's [Try again] reads the page that failed: the first one not answered yet.
      onRetryMore={() => void reads.find((read, index) => index > 0 && (read.error != null || read.data === undefined))?.refetch()}
      onMove={() => { if (press !== null) move(press); }}
      onCheckAgain={checkAgain}
      onReload={() => void reload()}
      onGotIt={() => { if (noticeModel !== null) void acknowledgeNotice(noticeModel.conversionId); }}
    />
  );
}

/**
 * The sheet's title, body and footer as its model says (hook-free, so every
 * state renders in a test): the changed line, page 0 loading, a problem
 * with [Try again], "no older group rules any more", or the report; then the
 * footer (8.3) with its lines, [Check again] or [Reload] when they apply,
 * [Close] and [Move them over].
 */
export function OlderRulesSheetView({
  state, compact, bodyRef, closeRef, onClose, onRetry, onSetPrice, onFix, onLoadMore, onRetryMore, onMove, onCheckAgain, onReload, onGotIt,
}: {
  state: OlderRulesSheetState;
  compact: boolean;
  /** The scrolling body, so the sheet can bring "Something changed…" back into view (CUX#12). */
  bodyRef?: Ref<HTMLDivElement>;
  /** The footer's [Close], which takes focus once a move is confirmed. */
  closeRef?: Ref<HTMLButtonElement>;
  onClose: () => void;
  /** Page 0's [Try again]. */
  onRetry: () => void;
  onSetPrice: (action: SetPriceFromSheetAction) => void;
  onFix: (action: FixFromSheetAction) => void;
  onLoadMore: () => void;
  /** A later page's [Try again]. */
  onRetryMore: () => void;
  /** [Move them over]: the step's draft takes page 0's hashes, then the move runs. */
  onMove: () => void;
  /** [Check again] for an unconfirmed move. */
  onCheckAgain: () => void;
  /** [Reload] after a confirmed move whose views couldn't be read again. */
  onReload: () => void;
  /** The one-time notice's [Got it] (11e1), when the footer shows it. */
  onGotIt: () => void;
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

      <SheetFooterBar footer={state.footer} closeRef={closeRef} onClose={onClose} onMove={onMove} onCheckAgain={onCheckAgain} onReload={onReload}
        onGotIt={onGotIt} />
    </>
  );
}

const FOOTER_LINE_TONE: Readonly<Record<OlderRulesSheetFooter["lines"][number]["tone"], string>> = {
  ok: "text-sm text-emerald-800",
  info: "text-sm text-zinc-700",
  alert: "text-sm text-amber-900",
};

/**
 * The sticky footer (8.3; PLAN10 3.4): the last answer's words and what stops
 * the move, each its own line (a failure or a stop `role="alert"`, the rest
 * `role="status"`); then [Check again], [Reload] or the notice's [Got it]
 * (11e1) when they apply, [Close], and [Move them over] last, the sheet's one
 * write of listing settings.
 */
export function SheetFooterBar({ footer, closeRef, onClose, onMove, onCheckAgain, onReload, onGotIt }: {
  footer: OlderRulesSheetFooter;
  closeRef?: Ref<HTMLButtonElement>;
  onClose: () => void;
  onMove: () => void;
  onCheckAgain: () => void;
  onReload: () => void;
  onGotIt: () => void;
}) {
  return (
    <div className="sticky bottom-0 space-y-2 border-t border-zinc-200 bg-background px-4 py-3 sm:px-6" data-testid="older-rules-footer">
      {footer.lines.map((line, index) => (
        <p
          key={`${index}:${line.text}`}
          role={line.tone === "alert" ? "alert" : "status"}
          className={FOOTER_LINE_TONE[line.tone]}
          data-testid="older-rules-footer-line"
        >
          {line.text}
        </p>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {footer.checkAgain.shown && (
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={footer.checkAgain.disabled} onClick={onCheckAgain}>
            {footer.checkAgain.label}
          </Button>
        )}
        {footer.reload.shown && (
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onReload}>{footer.reload.label}</Button>
        )}
        {footer.gotIt.shown && (
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" aria-label={footer.gotIt.ariaLabel}
            disabled={footer.gotIt.disabled} data-testid="older-rules-got-it" onClick={onGotIt}>
            {footer.gotIt.label}
          </Button>
        )}
        <Button ref={closeRef} type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={onClose}>{footer.closeLabel}</Button>
        {footer.move.shown && (
          <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={footer.move.disabled} data-testid="older-rules-move" onClick={onMove}>
            {footer.move.label}
          </Button>
        )}
      </div>
    </div>
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
