import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PriceChangeReviewResponse } from "@shared/dropship/listing-setting-writes";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { listingSettingsProductIdsQueryOptions } from "@/lib/dropship-listing-settings";
import type { ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
  bulkDescriptionFieldEditor,
  bulkDiscard,
  bulkDraftValue,
  bulkEbayCategoryFieldEditor,
  bulkEditAction,
  bulkPolicyFieldEditor,
  bulkPriceDraftWithCheck,
  bulkPriceEditAction,
  bulkPriceProductIds,
  bulkPriceRow,
  bulkSavedFor,
  bulkSettingRows,
  bulkSheetOpen,
  bulkSheetState,
  bulkStoreShelfFieldEditor,
  emptyBulkChoices,
  readBulkDraft,
  readBulkPriceDraft,
  type BulkDraftValue,
  type BulkOpenedOn,
  type BulkPicks,
  type BulkPriceDraftValue,
  type BulkPriceRowModel,
  type BulkReload,
  type BulkSavedFor,
  type BulkSettingsRights,
  type BulkSheetOpen,
} from "@/lib/dropship-listing-settings-bulk";
import {
  loadLatestBulk,
  productsBulkEndpoint,
  rereadAfterBulkSave,
  runProductsBulkSave,
} from "@/lib/dropship-listing-settings-bulk-requests";
import {
  BULK_EDITOR_ID,
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  LISTING_SETTINGS_SAVE_WORDS,
  type WriteFailure,
} from "@/lib/dropship-listing-settings-drafts";
import {
  DRAWER_WORDS,
  isPolicyRowEdit,
  shownFieldEditor,
  type DrawerEditTarget,
  type DrawerSettingRowModel,
} from "@/lib/dropship-listing-settings-drawer";
import {
  priceCheckBack,
  priceCheckShown,
  productPriceEditorModel,
  type PriceCheckShown,
} from "@/lib/dropship-listing-settings-price-check";
import {
  fetchPriceChangeReviewPage,
  readPriceCheckPage,
  refreshAfterPriceChangeApply,
  runPriceChangeApply,
  runPriceChangeCheck,
  sendPriceChangeApply,
  sendPriceChangeReview,
  type PriceChangeCheckOutcome,
} from "@/lib/dropship-listing-settings-price-check-requests";
import {
  type DescriptionEditField,
  type PriceCheckAfter,
  type PriceCheckRef,
  type ProductPriceChange,
} from "@/lib/dropship-listing-settings-product-edit";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import { idsRequestFor, pickSelected, type ListingSettingsSelection } from "@/lib/dropship-listing-settings-selection";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { changeSettingLabel, LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "@/lib/dropship-listing-settings-words";
import { postJson, type DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";
import { cn } from "@/lib/utils";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import { DrawerDescriptionEditor } from "./DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor } from "./DrawerFieldEditor";
import { DrawerSettingRow } from "./DrawerSettingRow";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { PriceChangeCheckBody, type PriceCheckRead } from "./PriceChangeCheckBody";
import { CloseButton, DrawerFooterBar, PRODUCT_DRAWER_CLASS } from "./ProductDrawer";
import { ProductPriceEditor } from "./ProductPriceEditor";
import { useReportListTooLarge } from "./ProductsTab";

export interface BulkSettingsSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=bulk`, D21), something is ticked, and no other surface is open (D20). */
  open: boolean;
  /** The ticks the sheet is for; its ids read is made from them when it opens (D6). */
  selection: ListingSettingsSelection;
  /** W6's right, the rights a row picks a new eBay value with (D3, D4), and W7's for the Price row (PR 10d). */
  rights: BulkSettingsRights;
  /** `summary.storeDefaults.price.recipe`, the fields under "Use default" in the Price row's editor; undefined until the summary answers. */
  summaryRecipe?: PricingRecipe | null | undefined;
  /** The live eBay setup read: the policies the rows' editors list, with their Card Shellz fit. */
  setup: ListingSettingsReadState<PolicySetupFacts>;
  /** The step's store shelves read while it answers, else null (no new shelf can be picked then). */
  shelves: readonly DropshipEbayStoreCategoryOption[] | null;
  /** The page's pending-save counter (D10). */
  saveCallbacks: ProductSettingsSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads every listing settings view again (D9). */
  onSaved: () => void;
  /** The step takes `?sheet=` off the address in place. Browser Back closes the sheet without this. */
  onClose: () => void;
  /** A confirmed save, with the products it named (`bulkSavedFor`): the sheet closed itself, and the tab says "Saved for 312 products. Still selected." */
  onSavedFor: (saved: BulkSavedFor) => void;
  /** A save refused because of a block the banner explains; the draft is kept (D8). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the sheet closes ([Set for selected]). */
  returnFocusTo?: FocusReturnTarget;
}

/**
 * "Set for selected" (Listing settings PR 10, plan 6.3): one change for the
 * ticked products, every setting but price, saved in one transaction (W6).
 * It opens at `?sheet=bulk`, reads the ticked products' ids and revisions
 * (`GET …/products/ids`, D6) and titles itself from that read ("Set for 312
 * products", with what moved since the ticks). One row per setting reads
 * "Leave as is" with [Change]; its editor (the drawer's, in "bulk" mode)
 * offers Leave as is, Use default and Set, and the main text only "Use Card
 * Shellz text". Save sends one request; after it the sheet closes and the
 * ticks stay (D22).
 *
 * From PR 10d a Price row sits beside them (plan 7.2): its editor sets a
 * recipe or "Use default" and "Clear exact prices too" for the ticked
 * products; [Check new prices] runs the W7 check for the products the ids
 * read gave (D6), whose rows replace the sheet's until [Back to editing] or
 * [Save new prices] (D20). One kind of change per Save (D2): the price, or
 * the other settings; the other rows wait while the price holds a change.
 *
 * The change lives in the step's one draft (D16, editor "bulk"), so the bar
 * and the leave guard count it. × or Esc with a change asks first; Esc
 * closes an open row editor first and keeps the sheet open while a save is
 * out or unconfirmed (plan 3.4). Browser Back takes `?sheet=` off the
 * address, which closes the sheet and keeps its draft (D21); opening it
 * again on the same products and revisions shows the change again. One
 * surface at a time (D20): no other sheet opens from here. Every decision is
 * the lib's (`dropship-listing-settings-bulk.ts`, `-bulk-requests.ts`).
 */
export function BulkSettingsSheet(props: BulkSettingsSheetProps) {
  const { open, storeConnectionId, onClose } = props;
  // The open body says whether it used Esc (to close its row editor, or to keep a save in view).
  const escape = useRef<(() => boolean) | null>(null);
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const drafts = useListingSettingsDrafts();
  const guard = useLeaveGuard();
  const guardId = `${LISTING_SETTINGS_GUARD_ID_PREFIX}${storeConnectionId}`;
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;
  const { close: closeDraft, discard: discardDraft } = drafts;

  // The address decides what shows: once it no longer opens the sheet (Back, or a close), the sheet's draft is
  // hidden and kept (D21); opening the sheet again shows it.
  const wasOpen = useRef(open);
  useEffect(() => {
    const before = wasOpen.current;
    wasOpen.current = open;
    const draft = draftRef.current;
    if (before && !open && draft?.editor === BULK_EDITOR_ID && draft.open) closeDraft();
  }, [open, closeDraft]);

  const dismiss = useCallback(() => {
    const draft = draftRef.current;
    const mine = draft?.editor === BULK_EDITOR_ID ? draft : null;
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
        data-testid="bulk-settings-sheet"
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
        {open && <BulkSettingsBody {...props} compact={compact} onDismiss={dismiss} escapeRef={escape} />}
      </SheetContent>
    </Sheet>
  );
}

interface BulkSettingsBodyProps extends BulkSettingsSheetProps {
  compact: boolean;
  onDismiss: () => void;
  /** Set by the body: true when it used an Esc, so the sheet stays open. */
  escapeRef: { current: (() => boolean) | null };
}

/** The open row editor and why its last [Done] didn't take; null for none. */
type OpenField = { target: DrawerEditTarget; message: string | null } | null;

/** The open Price row editor and why its last [Check new prices] didn't take, or the check's words; null while closed. */
type OpenPriceEditor = { message: string | null } | null;

const NO_SIZES: ReadonlySet<number> = new Set();

function BulkSettingsBody(props: BulkSettingsBodyProps) {
  const { storeConnectionId, selection, rights, compact } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  const request = idsRequestFor(selection);
  // What this opening did to the step's draft (below), once it decided. From then on the ids read is made again only
  // on purpose (after a save, Load latest, Try again), never by another view's refresh while the sheet is open.
  const [opening, setOpening] = useState<BulkSheetOpen["kind"] | null>(null);
  // Read as the sheet opens, and dropped when it closes (D6): the search and filter for "Select all N", else every
  // chosen product, which the ticks are picked from. A held save, or another editor's change, needs no read.
  const needsRead = bulkSheetOpen(drafts.draft, null).kind === "wait";
  const idsQuery = useQuery(listingSettingsProductIdsQueryOptions(storeConnectionId, request ?? {}, {
    enabled: request !== null && opening === null && needsRead,
  }));
  // Refused because more than 10,000 sizes are chosen now: the banner says so, as for the lists (D18).
  useReportListTooLarge(idsQuery.error, props.onBlocked);
  const own = drafts.draft?.editor === BULK_EDITOR_ID ? drafts.draft : null;
  const ownValue = own === null ? null : readBulkDraft(own.value);
  // The sheet's draft while it holds the price (W7, PR 10d): its change and check, for the products the ids read gave.
  const ownPrice = own === null ? null : readBulkPriceDraft(own.value);
  const priceChange = ownPrice?.priceChange ?? null;
  const shownCheck = priceCheckShown(own, priceChange);

  const [openField, setOpenField] = useState<OpenField>(null);
  // The last refused save, with the rows it named (the draft keeps its words only).
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const changeButtons = useRef(new Map<DrawerEditTarget, HTMLButtonElement>());
  const rowElements = useRef(new Map<DrawerEditTarget, HTMLElement>());
  const saving = useRef(false);
  // The Price row (W7): its editor, the check's rows (page 0 from the review, later pages from the page read; never the
  // apply's answer, D9), and what a refused apply named. The draft holds the check itself.
  const [priceEditor, setPriceEditor] = useState<OpenPriceEditor>(null);
  const [checking, setChecking] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [paging, setPaging] = useState(false);
  const [checkReview, setCheckReview] = useState<PriceChangeReviewResponse | null>(null);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);
  const [checkRead, setCheckRead] = useState<PriceCheckRead | null>(null);
  const [refusedSizes, setRefusedSizes] = useState<ReadonlySet<number>>(NO_SIZES);
  const changePriceButton = useRef<HTMLButtonElement | null>(null);
  const priceRowElement = useRef<HTMLDivElement | null>(null);
  const checkInFlight = useRef(false);
  const checkGeneration = useRef(0);
  const latestDraft = useRef(drafts.draft);
  latestDraft.current = drafts.draft;
  const lastCheck = useRef<PriceCheckRef | null>(null);
  if (shownCheck !== null) lastCheck.current = shownCheck.check;
  // The selection and ids read the draft's products came from (the opening's, or Load latest's): a save for them is
  // "Still selected" while the tab's ticks are that selection (D22).
  const openedOn = useRef<BulkOpenedOn | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Once its ids read answers, the step's one draft becomes the sheet's, on the products and revisions that read gave
  // (D6); a change kept from before is shown again, or moved onto the products read now (`bulkSheetOpen`). Only a read
  // made for this opening counts, never an answer cached from an earlier one. Once per opening: a later read (after a
  // save, Load latest) never moves the draft under the vendor.
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current) return;
    const data = idsQuery.data;
    const fresh = data !== undefined && !idsQuery.isError && idsQuery.isFetchedAfterMount && !idsQuery.isFetching;
    const picked = fresh ? pickSelected(data, selection) : null;
    const decision = bulkSheetOpen(drafts.draft, picked);
    if (decision.kind === "wait") return;
    decided.current = true;
    setOpening(decision.kind);
    if (picked !== null) openedOn.current = { selection, picked };
    switch (decision.kind) {
      case "elsewhere":
        // The address opened the sheet over another editor's change (D16 asks only from [Set for selected]).
        props.onClose();
        return;
      case "open":
        drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, decision.base);
        return;
      case "keep":
        if (drafts.draft !== null) drafts.open(BULK_EDITOR_ID, drafts.draft.place, drafts.draft.base);
        return;
      case "restart":
        drafts.discard();
        drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, decision.base);
        drafts.edit(decision.value);
        return;
      case "none_left":
        return;
    }
  });

  /** Gives focus back to a row's [Change] (plan 3.4); when it can't take it, the row takes it, so focus is never lost. */
  function focusChange(target: DrawerEditTarget) {
    const button = changeButtons.current.get(target);
    if (button && button.isConnected && !button.disabled) {
      button.focus();
      return;
    }
    const row = rowElements.current.get(target);
    if (row && row.isConnected) row.focus();
  }

  /** [Cancel] or Esc: the pick is dropped, and focus goes back to the row's [Change]. */
  function closeFieldEditor() {
    const target = openField?.target ?? null;
    setOpenField(null);
    if (target !== null) focusChange(target);
  }

  /** [Change] opens its row's editor (one at a time); pressed again, it closes it, as its aria-expanded says. */
  function toggleFieldEditor(target: DrawerEditTarget) {
    if (shownField === target) {
      closeFieldEditor();
      return;
    }
    setOpenField({ target, message: null });
  }

  /** [Done]: the editor's choices go in the sheet's draft (nothing is sent until Save), and focus goes back to its [Change]. */
  function finishEditor(target: DrawerEditTarget, picks: BulkPicks) {
    const action = bulkEditAction({ draft: drafts.draft, picks });
    switch (action.kind) {
      case "locked":
      case "not_open":
        // [Change] waits for the draft and for a save out or unconfirmed, so neither is reached from an open editor.
        return;
      case "finish_first":
        // D2: the price holds a change; the editor stays open with the words.
        setOpenField({ target, message: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
        return;
      case "start":
        // A clean price draft (a price change discarded, or its apply saved) gives way to the settings on the same products; never asks.
        if (!drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, action.base)) return;
        drafts.edit(action.value);
        break;
      case "edit":
        drafts.edit(action.value);
        break;
    }
    setFailure(null);
    setFooterMessage(null);
    setOpenField(null);
    focusChange(target);
  }

  /** Save (or Check again): one W6 request for every product the sheet opened on (plan 6.4). */
  async function save() {
    const live = drafts.draft;
    const sent = live === null ? null : readBulkDraft(live.value);
    if (live === null || live.editor !== BULK_EDITOR_ID || sent === null || saving.current) return;
    saving.current = true;
    setFooterMessage(null);
    setFailure(null);
    try {
      const outcome = await runProductsBulkSave({
        storeConnectionId,
        draft: live,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => postJson<unknown>(productsBulkEndpoint(storeConnectionId), body),
        reread: () => rereadAfterBulkSave(queryClient, storeConnectionId, idsRequestFor(selection)),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (outcome.kind === "saved" && !outcome.viewStale) {
        // The sheet closes and the ticks stay (D22); the tab says so. Also when the sheet was closed while saving.
        props.onSavedFor(bulkSavedFor({ products: sent.products, openedOn: openedOn.current }));
        if (mounted.current) props.onClose();
        return;
      }
      if (!mounted.current) return;
      if (outcome.kind === "not_started" && outcome.message) setFooterMessage(outcome.message);
      else if (outcome.kind === "failed") setFailure(outcome.failure);
    } finally {
      saving.current = false;
    }
  }

  /** Puts what a new ids read gave into the draft, as `bulkReload` decided. */
  function applyReload(next: BulkReload) {
    openedOn.current = { selection, picked: next.picked };
    switch (next.kind) {
      case "rebase":
        drafts.edit(next.edited);
        drafts.rebase(next.latest, []);
        return;
      case "restart":
        drafts.discard();
        drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, next.base);
        return;
      case "none_left":
        drafts.discard();
        return;
    }
  }

  /**
   * "Load latest and keep my changes" after a 409 (plan 6.5): the ids read again, the choices kept on what it gives;
   * with `mine` of no choices ([Discard] after a 409), a fresh start on it.
   */
  async function loadLatest(mine: BulkDraftValue | null = ownValue) {
    if (mine === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      const next = await loadLatestBulk(queryClient, storeConnectionId, selection, mine);
      if (!mounted.current) return;
      setFailure(null);
      applyReload(next);
    } catch {
      // Deliberate: the draft keeps the conflict and its Load latest; the words say the read failed.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." (reads only, D9); then the sheet closes as after a save. */
  async function reload() {
    if (ownValue === null || reading) return;
    const { products } = ownValue;
    setReading(true);
    setFooterMessage(null);
    try {
      await rereadAfterBulkSave(queryClient, storeConnectionId, idsRequestFor(selection));
      if (!mounted.current) return;
      drafts.discard();
      props.onSavedFor(bulkSavedFor({ products, openedOn: openedOn.current }));
      props.onClose();
    } catch {
      // Deliberate: the save stands; the draft keeps "Saved. We couldn't load the latest view." with Reload.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Discard]: every row back to "Leave as is", on the same products, or after a 409 on the products read again (`bulkDiscard`). */
  function discard() {
    setFailure(null);
    setFooterMessage(null);
    setOpenField(null);
    setPriceEditor(null);
    dropCheckViews();
    const decision = bulkDiscard(drafts.draft);
    if (decision.kind === "reset") drafts.edit(decision.value);
    else if (decision.kind === "reread" && ownValue !== null) void loadLatest(bulkDraftValue(ownValue.products));
  }

  // ---------------------------------------------------------------------------
  // The Price row (W7, PR 10d; plan 7.2, 7.6, D1, D2, D6, D20, D21)
  // ---------------------------------------------------------------------------

  /** The sheet's price draft value as it is at call time: a check's answer lands after renders. */
  function currentPriceValue(): BulkPriceDraftValue | null {
    const live = latestDraft.current;
    return live !== null && live.editor === BULK_EDITOR_ID ? readBulkPriceDraft(live.value) : null;
  }

  /** Forgets the check's rows and what an apply named; a check still on its way is dropped when it lands. */
  function dropCheckViews() {
    checkGeneration.current += 1;
    setCheckReview(null);
    setCheckNotice(null);
    setCheckRead(null);
    setRefusedSizes(NO_SIZES);
  }

  /** One check of `change` for the products the draft holds (the ids read's, D6); no guard: the apply's hash is the check. */
  function checkRun(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">, value: BulkPriceDraftValue, after: PriceCheckAfter | null) {
    return runPriceChangeCheck({
      productIds: bulkPriceProductIds(value),
      change,
      after,
      send: (body) => sendPriceChangeReview(storeConnectionId, body),
    });
  }

  async function checkPrices(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">, value: BulkPriceDraftValue, after: PriceCheckAfter | null = null) {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    const generation = checkGeneration.current;
    setChecking(true);
    setCheckNotice(null);
    try {
      const outcome = await checkRun(change, value, after);
      if (!mounted.current || generation !== checkGeneration.current) return;
      takeCheckOutcome(outcome);
    } finally {
      checkInFlight.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  function takeCheckOutcome(outcome: PriceChangeCheckOutcome) {
    switch (outcome.kind) {
      case "checked": {
        const live = currentPriceValue();
        // Discarded meanwhile: the answer is dropped.
        if (live === null) return;
        drafts.edit(bulkPriceDraftWithCheck(live, outcome.check));
        setCheckReview(outcome.review);
        setCheckRead(null);
        setRefusedSizes(NO_SIZES);
        setPriceEditor(null);
        return;
      }
      case "conflict":
        // Never for "Set for selected": there is no guard (D6).
        setPriceEditor(null);
        return;
      case "blocked":
        props.onBlocked?.(outcome.error);
        setPriceEditor({ message: LISTING_SETTINGS_SAVE_WORDS.blocked });
        return;
      case "failed":
        setPriceEditor({ message: outcome.message });
        return;
    }
  }

  /** The Price row's [Change] opens its editor (one at a time); pressed again, it closes it. */
  function togglePriceEditor() {
    if (priceEditor !== null) {
      closePriceEditor();
      return;
    }
    setOpenField(null);
    setPriceEditor({ message: null });
  }

  /** [Cancel] or Esc: what was typed is dropped, and focus goes back to the row's [Change] (or the row). */
  function closePriceEditor() {
    setPriceEditor(null);
    const button = changePriceButton.current;
    if (button && button.isConnected && !button.disabled) {
      button.focus();
      return;
    }
    const row = priceRowElement.current;
    if (row && row.isConnected) row.focus();
  }

  /**
   * [Check new prices] in the Price row's editor (plan 7.2): the choice goes in the sheet's draft as its price
   * change, for the products the ids read gave (`bulkPriceEditAction`, D2), then the check runs on it.
   */
  function checkFromEditor(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">) {
    const action = bulkPriceEditAction({ draft: drafts.draft, change });
    let value: BulkPriceDraftValue;
    switch (action.kind) {
      case "locked":
      case "not_open":
        return;
      case "finish_first":
        setPriceEditor({ message: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
        return;
      case "no_change":
        closePriceEditor();
        return;
      case "edit":
        drafts.edit(action.value);
        value = action.value;
        break;
      case "start":
        // The sheet's own clean draft gives way to the price on the same products (never asks).
        if (!drafts.open(BULK_EDITOR_ID, LISTING_SETTINGS_BULK_WORDS.setForSelected, action.base)) return;
        drafts.edit(action.value);
        value = action.value;
        break;
    }
    setFailure(null);
    setFooterMessage(null);
    setPriceEditor({ message: null });
    void checkPrices({ price: value.priceChange.price, releaseExactPrices: value.priceChange.releaseExactPrices }, value);
  }

  /** The footer's [Check new prices] while the draft holds a price change with no check (after Back to editing). */
  function checkFromFooter() {
    const live = currentPriceValue();
    if (live === null) return;
    setFooterMessage(null);
    void checkPrices({ price: live.priceChange.price, releaseExactPrices: live.priceChange.releaseExactPrices }, live);
  }

  /**
   * The check the server dropped (404 on a page read): a new one for the same change, with its line, once the draft can
   * take it (`page_expired`: no apply was tried for it). While locked, Check again answers it from the draft's reference.
   */
  function checkAgainAfterExpiry(check: PriceCheckShown) {
    const live = currentPriceValue();
    if (live === null || check.locked) {
      setCheckRead({ kind: "failed", message: LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone });
      return;
    }
    const value = bulkPriceDraftWithCheck(live, null);
    drafts.edit(value);
    dropCheckViews();
    setPriceEditor({ message: null });
    void checkPrices({ price: value.priceChange.price, releaseExactPrices: value.priceChange.releaseExactPrices }, value, "page_expired");
  }

  /**
   * [Save new prices], or [Check again] after an unconfirmed apply (plan 7.3, 7.5): one W7 apply of the check the
   * draft holds. A refusal a new check answers gets one, once, for the same products; the new check shows with its
   * line. After a confirmed save the views are read again (D9), the sheet closes and the ticks stay (D22).
   */
  async function applyPrices() {
    const live = drafts.draft;
    const value = live === null || live.editor !== BULK_EDITOR_ID ? null : readBulkPriceDraft(live.value);
    const check = value?.priceChange.check ?? null;
    if (live === null || value === null || check === null || saving.current) return;
    saving.current = true;
    setCheckNotice(null);
    const change = { price: value.priceChange.price, releaseExactPrices: value.priceChange.releaseExactPrices };
    try {
      const outcome = await runPriceChangeApply({
        draft: live,
        check,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => sendPriceChangeApply(storeConnectionId, body),
        reread: () => refreshAfterPriceChangeApply(queryClient, storeConnectionId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
        recheck: {
          check: async (after) => {
            setRechecking(true);
            try {
              return await checkRun(change, value, after);
            } finally {
              if (mounted.current) setRechecking(false);
            }
          },
          withCheck: (next) => bulkPriceDraftWithCheck(currentPriceValue() ?? value, next),
        },
      });
      if (outcome.kind === "saved" && !outcome.viewStale) {
        // The sheet closes and the ticks stay (D22); the tab says so. Also when the sheet was closed while saving.
        props.onSavedFor(bulkSavedFor({ products: value.products, openedOn: openedOn.current }));
        if (mounted.current) props.onClose();
        return;
      }
      if (!mounted.current) return;
      switch (outcome.kind) {
        case "not_started":
          if (outcome.message) setCheckNotice(outcome.message);
          return;
        case "saved":
          // Saved, but the views couldn't be read again: the footer offers Reload, which then closes the sheet.
          dropCheckViews();
          return;
        case "failed":
          setRefusedSizes(outcome.refusedSizes);
          return;
        case "rechecked":
          setCheckReview(outcome.review);
          setCheckRead(null);
          setRefusedSizes(NO_SIZES);
          return;
        case "recheck_failed":
          dropCheckViews();
          setPriceEditor({ message: outcome.message });
          return;
        case "conflict":
          dropCheckViews();
          return;
      }
    } finally {
      saving.current = false;
    }
  }

  /** Another page of the check (plan 7.5): the same review by id; a dropped review means a new check. */
  async function showCheckPage(page: number) {
    if (shownCheck === null || paging) return;
    const { check } = shownCheck;
    setPaging(true);
    setCheckNotice(null);
    try {
      const outcome = await readPriceCheckPage(check, () => fetchPriceChangeReviewPage(storeConnectionId, check.reviewId, page));
      if (!mounted.current) return;
      if (outcome.kind === "ok") setCheckReview(outcome.review);
      else if (outcome.kind === "expired") checkAgainAfterExpiry(shownCheck);
      else setCheckNotice(outcome.message);
    } finally {
      if (mounted.current) setPaging(false);
    }
  }

  /** [Back to editing] (D20, D21): the check leaves the draft and the Price editor opens on the change; a locked draft closes the sheet and is kept. */
  function backToEditing() {
    const decision = priceCheckBack(own, priceChange);
    switch (decision.kind) {
      case "edit": {
        const live = currentPriceValue();
        if (live !== null) drafts.edit(bulkPriceDraftWithCheck(live, null));
        dropCheckViews();
        setPriceEditor({ message: null });
        return;
      }
      case "close":
        drafts.close();
        props.onClose();
        return;
      case "none":
        return;
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." for a price apply (reads only, D9); then the sheet closes as after a save. */
  async function reloadAfterPrices() {
    if (ownPrice === null || reading) return;
    const { products } = ownPrice;
    setReading(true);
    setFooterMessage(null);
    try {
      await refreshAfterPriceChangeApply(queryClient, storeConnectionId);
      if (!mounted.current) return;
      drafts.discard();
      props.onSavedFor(bulkSavedFor({ products, openedOn: openedOn.current }));
      props.onClose();
    } catch {
      // Deliberate: the save stands; the draft keeps "Saved. We couldn't load the latest view." with Reload.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  // The sheet reopened on a draft that holds a check (browser Back, D21): its rows are read again, page 0, by the
  // review's id; a check the server dropped means a new check once the draft can take it. Only once per check.
  const shownReviewId = shownCheck?.check.reviewId ?? null;
  const reviewShown = checkReview !== null && checkReview.reviewId === shownReviewId ? checkReview : null;
  const readFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownCheck === null || reviewShown !== null || checking || rechecking || checkRead !== null || readFor.current === shownCheck.check.reviewId) return;
    readFor.current = shownCheck.check.reviewId;
    const { check } = shownCheck;
    const generation = checkGeneration.current;
    setCheckRead({ kind: "loading" });
    void (async () => {
      const outcome = await readPriceCheckPage(check, () => fetchPriceChangeReviewPage(storeConnectionId, check.reviewId, 0));
      if (!mounted.current || generation !== checkGeneration.current) return;
      if (outcome.kind === "ok") {
        setCheckReview(outcome.review);
        setCheckRead(null);
      } else if (outcome.kind === "expired") {
        checkAgainAfterExpiry(shownCheck);
      } else {
        setCheckRead({ kind: "failed", message: outcome.message });
      }
      if (outcome.kind !== "ok") readFor.current = null;
    })();
  });

  // The rows, and the one row editor that shows: it closes when its row can no longer be changed (D3).
  const rowsFor = (target: DrawerEditTarget | null) => bulkSettingRows({
    draft: drafts.draft, rights, openTarget: target, failure, setup: props.setup, shelves: props.shelves,
  });
  // The Price row (PR 10d) beside them: its editor is the product price editor in bulk mode (no own price).
  const priceRow = bulkPriceRow({ draft: drafts.draft, rights, open: priceEditor !== null });
  const priceLocked = own !== null && ownPrice !== null && isDraftLocked(own);
  // The price editor closes itself when the row can no longer be changed (a banner took W7's right away).
  useEffect(() => {
    if (priceEditor !== null && !priceRow.change.shown) setPriceEditor(null);
  }, [priceEditor, priceRow.change.shown]);
  const closedRows = rowsFor(null);
  const shownField = shownFieldEditor(closedRows, openField?.target ?? null, true);
  const rows = shownField === null ? closedRows : rowsFor(shownField);
  useEffect(() => {
    if (openField === null || shownField !== null) return;
    setOpenField(null);
    // The editor closed itself: focus that was in it fell to the page or the sheet, so it goes to the row (plan 3.4).
    const active = document.activeElement;
    if (active === null || active === document.body || active.getAttribute("tabindex") === "-1") focusChange(openField.target);
  }, [openField, shownField]);

  const sheet = bulkSheetState({
    selection,
    ids: { data: idsQuery.data, error: idsQuery.error },
    draft: drafts.draft,
    opening,
    rights,
    busy: props.saveCallbacks.disabled === true || reading || checking,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    // An open row or price editor holds a pick that isn't in the draft yet: [Done] or [Cancel] first, so Save never drops it.
    fieldEditorOpen: shownField !== null || priceEditor !== null,
    failure,
  });

  // Esc (plan 3.4): closes the open row or price editor first, then takes a shown check back to editing (D20); a
  // save that is out or unconfirmed keeps the sheet open.
  useEffect(() => {
    props.escapeRef.current = () => {
      if (shownField !== null) {
        closeFieldEditor();
        return true;
      }
      if (priceEditor !== null) {
        closePriceEditor();
        return true;
      }
      if (shownCheck !== null && !shownCheck.locked) {
        backToEditing();
        return true;
      }
      return sheet.escapeKeepsOpen;
    };
    return () => { props.escapeRef.current = null; };
  });

  const choices = ownValue ?? emptyBulkChoices();
  const selected = LISTING_SETTINGS_BULK_WORDS.selectedProducts;
  const priceEditorNode = priceEditor !== null && priceRow.change.shown ? (
    <ProductPriceEditor
      model={productPriceEditorModel({
        rights: { canSet: priceRow.canSet, canDefault: priceRow.canDefault, reason: priceRow.reason },
        change: priceRow.draftChange,
        ownPrice: null,
        storeRecipe: props.summaryRecipe ?? null,
      })}
      title={priceRow.label}
      productName={selected}
      message={priceEditor.message}
      checking={checking}
      locked={priceLocked}
      onCheck={checkFromEditor}
      onCancel={closePriceEditor}
    />
  ) : null;

  // The check replaces the sheet's rows (D20): the draft's check, or the stale one while a refused apply's new check is made.
  const bodyCheck: PriceCheckShown | null = shownCheck
    ?? (rechecking && lastCheck.current !== null ? { check: lastCheck.current, phase: "saving", message: null, code: null, locked: true } : null);

  function renderEditor(row: DrawerSettingRowModel): ReactNode {
    const rowEdit = row.edit;
    if (rowEdit === null || !rowEdit.open || openField === null) return null;
    const common = { title: row.label, productName: selected, message: openField.message, onCancel: closeFieldEditor };
    if (rowEdit.kind === "description") {
      return (
        <DrawerDescriptionEditor
          key="description"
          {...common}
          bulk
          model={bulkDescriptionFieldEditor({
            rights: rowEdit, draftChoices: { textAbove: choices.textAbove, textBelow: choices.textBelow, mainText: choices.mainText },
          })}
          onDone={(picks: Pick<BulkPicks, DescriptionEditField>) => finishEditor("description", picks)}
        />
      );
    }
    if (rowEdit.target === "ebayCategory") {
      return (
        <DrawerEbayCategoryEditor
          key="ebayCategory"
          {...common}
          bulk
          storeConnectionId={storeConnectionId}
          model={bulkEbayCategoryFieldEditor({ rights: rowEdit, draftChoice: choices.ebayCategory })}
          onDone={(choice) => finishEditor("ebayCategory", { ebayCategory: choice })}
        />
      );
    }
    if (rowEdit.target === "storeShelf") {
      return (
        <DrawerShelfEditor
          key="storeShelf"
          {...common}
          bulk
          model={bulkStoreShelfFieldEditor({ rights: rowEdit, draftChoice: choices.storeShelf, shelves: props.shelves })}
          onDone={(choice) => finishEditor("storeShelf", { storeShelf: choice })}
        />
      );
    }
    if (!isPolicyRowEdit(rowEdit)) return null;
    const field = rowEdit.field;
    return (
      <DrawerFieldEditor
        key={field}
        {...common}
        bulk
        model={bulkPolicyFieldEditor({ field, rights: rowEdit, draftChoice: choices[field], setup: props.setup })}
        onDone={(choice) => finishEditor(field, { [field]: choice })}
      />
    );
  }

  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={props.onDismiss} />}
        <div className="min-w-0 flex-1 space-y-1">
          <SheetTitle className="break-words text-base font-semibold text-zinc-900">{sheet.title}</SheetTitle>
          <SheetDescription className="text-sm text-zinc-700">{LISTING_SETTINGS_BULK_WORDS.intro}</SheetDescription>
        </div>
        {!compact && <CloseButton onClick={props.onDismiss} />}
      </div>

      {bodyCheck !== null && priceChange !== null ? (
        <PriceChangeCheckBody
          check={bodyCheck.check}
          review={rechecking ? null : reviewShown}
          change={priceChange}
          phase={bodyCheck.phase}
          message={bodyCheck.message}
          code={bodyCheck.code}
          notice={checkNotice}
          refusedSizes={refusedSizes}
          busy={props.saveCallbacks.disabled === true || checking || rechecking}
          paging={paging}
          read={rechecking ? { kind: "loading" } : checkRead}
          compact={compact}
          onBack={backToEditing}
          onSave={() => void applyPrices()}
          onResend={() => void applyPrices()}
          onPage={(page) => void showCheckPage(page)}
          onRetryRead={() => { readFor.current = null; setCheckRead(null); }}
        />
      ) : (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
            {sheet.loadingLine && <p role="status" className="text-sm text-zinc-600">{sheet.loadingLine}</p>}
            {sheet.readProblem && (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="bulk-settings-read-problem">
                <span>{sheet.readProblem}</span>
                <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void idsQuery.refetch()}>
                  {DRAWER_WORDS.tryAgain}
                </Button>
              </div>
            )}
            {sheet.lines.map((line) => (
              <p key={line} role="status" className="text-sm text-amber-900" data-testid="bulk-settings-line">{line}</p>
            ))}
            {sheet.noneLeft && <p role="alert" className="text-sm font-medium text-amber-900">{sheet.noneLeft}</p>}
            <section aria-label={LISTING_SETTINGS_BULK_WORDS.setForSelected} aria-busy={sheet.read === "loading" || undefined}
              className="rounded-md border border-zinc-200 px-4" data-testid="bulk-settings-rows">
              <BulkPriceRow
                row={priceRow}
                productName={selected}
                onChange={togglePriceEditor}
                changeRef={(element) => { changePriceButton.current = element; }}
                rowRef={(element) => { priceRowElement.current = element; }}
                editor={priceEditorNode}
              />
              {rows.map((row) => {
                const target = row.edit?.target ?? null;
                return (
                  <DrawerSettingRow
                    key={row.key}
                    row={row}
                    productName={selected}
                    onChange={target === null ? undefined : () => toggleFieldEditor(target)}
                    changeRef={target === null ? undefined : (element) => {
                      if (element) changeButtons.current.set(target, element);
                      else changeButtons.current.delete(target);
                    }}
                    rowRef={target === null ? undefined : (element) => {
                      if (element) rowElements.current.set(target, element);
                      else rowElements.current.delete(target);
                    }}
                    editor={renderEditor(row)}
                  />
                );
              })}
            </section>
          </div>

          <DrawerFooterBar
            testIdPrefix="bulk-settings"
            footer={sheet.footer}
            message={footerMessage}
            onDiscard={discard}
            onPrimary={() => {
              // The draft's shape decides the writer (D2): the settings (W6), or the price (W7: Save runs the check,
              // Check again the apply, Reload the re-read; a clean price draft after its apply is still the price's).
              const action = sheet.footer.primary.action;
              if (sheet.shape === "price") {
                if (action === "save") checkFromFooter();
                else if (action === "resend") void applyPrices();
                else if (action === "reload") void reloadAfterPrices();
                return;
              }
              if (action === "save" || action === "resend") void save();
              else if (action === "load_latest") void loadLatest();
              else if (action === "reload") void reload();
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * The sheet's Price row (PR 10d, plan 7.2): "Leave as is" with [Change], the
 * price change not saved yet under it ("→ Retail price + 20%, round up to .99
 * · Clear exact prices too · Not saved"), why [Change] waits, a refused
 * apply's words, and the price editor under it while it is open. Drawn as the
 * setting rows are (`DrawerSettingRow`), so the sheet reads as one list.
 */
function BulkPriceRow({ row, productName, onChange, changeRef, rowRef, editor }: {
  row: BulkPriceRowModel;
  productName: string;
  onChange: () => void;
  changeRef: (element: HTMLButtonElement | null) => void;
  rowRef: (element: HTMLDivElement | null) => void;
  editor: ReactNode;
}) {
  const pendingId = useId();
  const shown = row.change.shown;
  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={cn(
        "grid gap-1 border-t border-zinc-100 py-3 outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-[#C060E0] sm:gap-4",
        shown ? "sm:grid-cols-[10rem_minmax(0,1fr)_auto]" : "sm:grid-cols-[10rem_minmax(0,1fr)]",
      )}
      data-testid={`drawer-setting-${row.key}`}
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{row.label}</h4>
      <div className="min-w-0 space-y-2">
        <p className="text-sm text-zinc-900">{row.value}</p>
        {row.pending && (
          <p id={pendingId} className="break-words text-sm font-medium text-zinc-900" data-testid={`drawer-setting-${row.key}-pending`}>{row.pending}</p>
        )}
        {row.line && <p className="text-xs text-zinc-600" data-testid={`drawer-setting-${row.key}-line`}>{row.line}</p>}
      </div>
      {shown && (
        <div>
          <Button
            ref={changeRef}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-label={changeSettingLabel(row.label, productName)}
            aria-describedby={row.pending ? pendingId : undefined}
            aria-expanded={row.open}
            disabled={row.change.disabled}
            onClick={onChange}
          >
            {LISTING_SETTINGS_SAVE_WORDS.change}
          </Button>
        </div>
      )}
      {editor}
    </div>
  );
}
