import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PriceChangeClearField, PriceChangeReviewResponse } from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsCategoryDetail, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
  CATEGORY_PRICE_TARGET,
  CategoryRequestError,
  categoryDescriptionFieldEditor,
  categoryDiscard,
  categoryEbayCategoryFieldEditor,
  categoryEditorOpen,
  categoryEditorQueryOptions,
  categoryEditorState,
  categoryClearAction,
  categoryGoneDiscards,
  categoryPickAction,
  categoryPolicyFieldEditor,
  categoryPriceAction,
  categoryPriceChanged,
  categoryPriceCheckAnswers,
  categoryPriceCheckBack,
  categoryPriceCheckBaseOf,
  categoryPriceCheckBody,
  categoryPriceDraftWithCheck,
  categoryPriceReviewRequest,
  categorySavedThroughCheck,
  categoryStoreShelfFieldEditor,
  ownCategoryDraft,
  readCategoryDraft,
  type CategoryClearBox,
  type CategoryDraftValue,
  type CategoryEditAction,
  type CategoryEditorRow,
  type CategoryPicks,
  type CategoryPriceCheckShown,
  type CategoryPriceReviewInput,
  type CategoryPriceRow,
  type CategorySettingsRights,
} from "@/lib/dropship-listing-settings-categories";
import {
  categoryFailureFollowUp,
  categorySettingsEndpoint,
  loadLatestCategory,
  reloadAfterCategorySave,
  rereadAfterCategorySave,
  rereadCategoryCard,
  rereadCategoryDetail,
  runCategorySettingsSave,
} from "@/lib/dropship-listing-settings-category-requests";
import {
  categoryEditorId, LISTING_SETTINGS_GUARD_ID_PREFIX, LISTING_SETTINGS_SAVE_WORDS, isDraftDirty, type WriteFailure,
} from "@/lib/dropship-listing-settings-drafts";
import { DRAWER_WORDS, isPolicyRowEdit, shownFieldEditor, type DrawerEditTarget } from "@/lib/dropship-listing-settings-drawer";
import { categoryPriceCheckChangeWords } from "@/lib/dropship-listing-settings-price-check";
import {
  fetchPriceChangeReviewPage,
  readPriceCheckPage,
  refreshAfterCategoryPriceApply,
  runPriceChangeApply,
  runPriceChangeCheck,
  sendPriceChangeApply,
  sendPriceChangeReview,
  type PriceChangeCheckOutcome,
} from "@/lib/dropship-listing-settings-price-check-requests";
import type { PriceCheckAfter, ProductPriceChange } from "@/lib/dropship-listing-settings-product-edit";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import { PRICE_DEFAULT_WORDS } from "@/lib/dropship-listing-settings-recipe";
import { STORE_DEFAULT_EDITOR_WORDS, type PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_CATEGORY_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "@/lib/dropship-listing-settings-words";
import { putJson, type DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";
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

/** The card row the editor opened from: its name and count title the editor while the detail loads; null from the address alone. */
export type CategoryEditorOpenedFrom = { categoryId: number; name: string; productCount: number } | null;

/** Why the editor closed itself: no chosen product is in the category any more (8.6), so the step can say so under the card. */
export type CategoryEditorCloseReason = "not_found";

export interface CategoryEditorProps {
  storeConnectionId: number;
  /** The category the page address opens (`?category=<id>`, D21); null keeps the editor closed, as does another open surface (D20). */
  categoryId: number | null;
  category: CategoryEditorOpenedFrom;
  /** The step's summary read: the editor's read is off while the selection is too large (D18), and no save is offered while older group rules are present (D11). */
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog" | "storeDefaults">>;
  /** W12's right and the rights its fields pick eBay values with (D3, D4). */
  rights: CategorySettingsRights;
  /** The live eBay setup read: policy names and the policies a row's editor lists. */
  setup: ListingSettingsReadState<PolicySetupFacts>;
  /** The step's store shelves read while it answers, else null: the shelf editor's choices. */
  shelves?: readonly DropshipEbayStoreCategoryOption[] | null;
  /** The page's pending-save counter (D10). */
  saveCallbacks: ProductSettingsSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads every listing settings view again (D9). */
  onSaved: () => void;
  /** The step takes `?category=` off the address in place, and says why under the card when the editor closed itself. Browser Back closes the editor without this. */
  onClose: (reason?: CategoryEditorCloseReason) => void;
  /** A save refused because of a block the banner explains (D8), or the read refused as too large (D18). */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the editor closes: the card row's [Change] (plan 3.4). */
  returnFocusTo?: FocusReturnTarget;
}

/**
 * The category editor (Listing settings PR 10e, plan 8.1-8.4): one Card
 * Shellz category's settings in the drawer's rows, each value with "Set for
 * Sleeves" or "Store default", changed with the drawer's own editors offering
 * "Use store default" (D17), and "Also clear theirs" under a field whose
 * products hold their own value (8.4). Save sends one W12 request from the
 * detail read the editor opened on (D6); the footer reads "● Not saved · 2
 * changes" [Discard] [Save].
 *
 * From PR 10f (plan 9.1, 9.2, 9.4) the Price row can be changed too: its
 * editor (10d's, with "Use store default") puts the recipe in the same draft,
 * and Save becomes [Check new prices]: one W7 `category_price` check carries
 * the price with the editor's other changes and "Also clear theirs" (D2), its
 * rows replace this body (D20), and [Save new prices] applies it. Before each
 * check the detail is read again: a moved revision or clear set is the
 * conflict, nothing sent (9.4). A price never goes through W12 (9.7).
 *
 * It opens at `?category=<id>` (D21) as the drawer's right sheet, full screen
 * on a phone. × or Esc with a change asks first; Esc closes an open field
 * editor first and keeps the editor while a save is out or unconfirmed (plan
 * 3.4). Browser Back takes `?category=` off the address, which closes the
 * editor and keeps its draft in the step's one draft (D16); opening the
 * category again shows it, a Check again included. Every decision is the
 * lib's (`dropship-listing-settings-categories.ts`, `-category-requests.ts`).
 */
export function CategoryEditor(props: CategoryEditorProps) {
  const { categoryId, storeConnectionId, onClose } = props;
  // The open body says whether it used Esc (to close its field editor, or to keep a save in view).
  const escape = useRef<(() => boolean) | null>(null);
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const drafts = useListingSettingsDrafts();
  const guard = useLeaveGuard();
  const guardId = `${LISTING_SETTINGS_GUARD_ID_PREFIX}${storeConnectionId}`;
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;

  // The address decides what shows (D21). A draft of a category no longer shown is hidden and kept (browser Back);
  // coming back to that category shows it again; the body opens a new one from its read when there is none.
  const { open: openDraft, close: closeDraft, discard: discardDraft } = drafts;
  const shownCategory = useRef<number | null>(null);
  useEffect(() => {
    const previous = shownCategory.current;
    shownCategory.current = categoryId;
    if (previous === categoryId) return;
    const draft = draftRef.current;
    if (previous !== null && draft?.editor === categoryEditorId(previous) && draft.open) closeDraft();
    if (categoryId !== null && draft?.editor === categoryEditorId(categoryId) && !draft.open) openDraft(draft.editor, draft.place, draft.base);
  }, [categoryId, openDraft, closeDraft]);

  const dismiss = useCallback(() => {
    if (categoryId === null) return;
    const draft = draftRef.current;
    const mine = draft?.editor === categoryEditorId(categoryId) ? draft : null;
    // A save in flight is never dropped: the editor hides and the draft settles on its own.
    if (mine && mine.phase !== "saving" && isDraftDirty(mine)) {
      guard(() => {
        discardDraft();
        onClose();
      }, [guardId]);
      return;
    }
    if (mine) closeDraft();
    onClose();
  }, [categoryId, guard, guardId, discardDraft, closeDraft, onClose]);

  return (
    <Sheet open={categoryId !== null} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <SheetContent
        side="right"
        data-testid="category-editor"
        className={PRODUCT_DRAWER_CLASS}
        // The title names the category; Radix's aria-describedby would point at nothing.
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
        {categoryId !== null && (
          <CategoryEditorBody
            // Another category is another editor: its open field editor and focus start over.
            key={categoryId}
            {...props}
            categoryId={categoryId}
            compact={compact}
            onDismiss={dismiss}
            escapeRef={escape}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

interface CategoryEditorBodyProps extends Omit<CategoryEditorProps, "categoryId"> {
  categoryId: number;
  compact: boolean;
  onDismiss: () => void;
  /** Set by the body: true when it used an Esc, so the editor stays open. */
  escapeRef: { current: (() => boolean) | null };
}

/** The open row editor and why its last [Done] didn't take; null while closed. */
type OpenField = { target: DrawerEditTarget; message: string | null } | null;

/** The open price editor and why its last [Check new prices] didn't take, or what the check answered; null while closed. */
type OpenPriceEditor = { message: string | null } | null;

const NO_SIZES: ReadonlySet<number> = new Set<number>();

function CategoryEditorBody(props: CategoryEditorBodyProps) {
  const { storeConnectionId, categoryId, compact } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  const editor = categoryEditorId(categoryId);
  // Fresh each opening (staleTime 0, D6): the revision and the "Also clear theirs" set come from this answer.
  const detailQuery = useQuery(categoryEditorQueryOptions(storeConnectionId, categoryId, props.summary, true));
  // Refused because more than 10,000 sizes are chosen now: the banner says so, as for the lists (D18).
  useReportListTooLarge(detailQuery.error, props.onBlocked);

  const [openField, setOpenField] = useState<OpenField>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  // The last refused save, with the fields it named (the draft keeps its words only).
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [reading, setReading] = useState(false);
  const changeButtons = useRef(new Map<DrawerEditTarget, HTMLButtonElement>());
  const rowElements = useRef(new Map<DrawerEditTarget, HTMLElement>());
  const saving = useRef(false);
  const closing = useRef(false);
  const latestDraft = useRef(drafts.draft);
  latestDraft.current = drafts.draft;
  // The Price row (W7, PR 10f): its editor, the check's rows (page 0 from the review, later pages from the page read;
  // never the apply's answer, D9), and what a refused apply named. The draft holds the check itself (D16).
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
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const state = categoryEditorState({
    category: props.category?.categoryId === categoryId ? props.category : null,
    categoryId,
    detail: { data: detailQuery.data, error: detailQuery.error },
    summary: props.summary,
    draft: drafts.draft,
    rights: props.rights,
    setup: props.setup,
    shelves: props.shelves ?? null,
    // One editor at a time: the price's, or a row's.
    openTarget: priceEditor !== null ? CATEGORY_PRICE_TARGET : openField?.target ?? null,
    failure,
    busy: props.saveCallbacks.disabled === true || reading || checking,
    // A check out (first, or a refused apply's): the rows and the boxes wait, so its answer is for this draft (plan 9.4).
    checking: checking || rechecking,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    // An open row or price editor holds a pick that isn't in the draft yet: [Done] or [Cancel] first, so Save never drops it.
    fieldEditorOpen: openField !== null || priceEditor !== null,
  });
  // The check shown last, kept so the stale check stays on screen as "Saving…" while a refused apply's new check is made.
  const lastShown = useRef<CategoryPriceCheckShown | null>(null);
  if (state.priceCheck !== null) lastShown.current = state.priceCheck;
  // The answer the rows show, kept across a failed refresh (the lib decides what counts as this category's answer).
  const detail: ListingSettingsCategoryDetail | null = state.detail;

  // The draft opens on the detail read made for this opening, once there is none for this category (D6, D16): a
  // draft held from before (Back, a save out or unconfirmed) is reopened by the sheet and kept as it is. The
  // address can open the editor while another editor holds a change (a link, Forward): then it closes (D16).
  const own = ownCategoryDraft(drafts.draft, categoryId);
  const { open: openDraft } = drafts;
  useEffect(() => {
    if (own !== null || closing.current) return;
    const decision = categoryEditorOpen(latestDraft.current, categoryId, detail);
    if (decision.kind === "open") openDraft(editor, detail?.name ?? props.category?.name ?? "", decision.base);
    else if (decision.kind === "elsewhere") {
      closing.current = true;
      props.onClose();
    }
  });

  // No chosen product is in the category any more (8.6): the editor closes, the step says so under the card, and
  // the card reads again. Its draft goes unless a save is out or unconfirmed (never dropped by the surface, 3.4).
  const notFound = state.problem?.kind === "not_found";
  useEffect(() => {
    if (!notFound || closing.current) return;
    closing.current = true;
    if (categoryGoneDiscards(latestDraft.current, categoryId)) drafts.discard();
    props.onClose("not_found");
    void rereadCategoryCard(queryClient, storeConnectionId).catch(() => {
      // Deliberate: the card's own read state shows a failure with Try again; nothing was saved here.
    });
  }, [notFound, categoryId, drafts, props, queryClient, storeConnectionId]);

  // The one field editor that shows closes itself when its row can no longer be changed (D3) or the read is gone,
  // and that pick was never in the draft.
  const shownField = shownFieldEditor(state.rows.map((row) => row.row), openField?.target ?? null, state.own !== null);
  useEffect(() => {
    if (openField === null || shownField !== null) return;
    setOpenField(null);
    const active = document.activeElement;
    if (active === null || active === document.body || active.getAttribute("tabindex") === "-1") focusChange(openField.target);
  }, [openField, shownField]);

  // The price editor closes itself when the row can no longer be changed (a banner took W7's right away, D11 came).
  const priceChangeShown = state.price?.change.shown === true;
  useEffect(() => {
    if (priceEditor !== null && !priceChangeShown) setPriceEditor(null);
  }, [priceEditor, priceChangeShown]);

  // Esc (plan 3.4): closes the open row or price editor first, then takes a shown check back to editing (D20); a
  // save that is out or unconfirmed keeps the editor open.
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
      if (state.priceCheck !== null && !state.priceCheck.locked) {
        backToEditing();
        return true;
      }
      return state.escapeKeepsOpen;
    };
    return () => { props.escapeRef.current = null; };
  });

  /** Gives focus back to a row's [Change]; when it can't take it (a save is out), the row takes it, so focus is never lost. */
  function focusChange(target: DrawerEditTarget) {
    const button = changeButtons.current.get(target);
    if (button && button.isConnected && !button.disabled) {
      button.focus();
      return;
    }
    const row = rowElements.current.get(target);
    if (row && row.isConnected) row.focus();
  }

  /** [Change] opens its row's editor (one at a time); pressed again, it closes it, as its aria-expanded says. */
  function toggleFieldEditor(target: DrawerEditTarget) {
    if (shownField === target) {
      closeFieldEditor();
      return;
    }
    setPriceEditor(null);
    setOpenField({ target, message: null });
  }

  /** [Cancel] or Esc: the pick is dropped, and focus goes back to the row's [Change]. */
  function closeFieldEditor() {
    const target = openField?.target ?? null;
    setOpenField(null);
    if (target !== null) focusChange(target);
  }

  /** Puts a pick or a tick in the step's one draft (nothing is sent until Save); false when the draft couldn't take it. */
  function takeAction(action: CategoryEditAction): boolean {
    switch (action.kind) {
      case "locked":
      case "not_open":
        return false;
      case "edit":
        drafts.edit(action.value);
        break;
      case "start":
        // A clean draft starts again on the read now (after a save its revision moved, D6); false when another
        // editor's change is asked about first, and nothing changes yet.
        if (!drafts.open(action.editor, action.place, action.base)) return false;
        drafts.edit(action.value);
        break;
    }
    setFailure(null);
    setFooterMessage(null);
    return true;
  }

  /**
   * [Done] in a field editor: its choices go in the draft, the editor closes, and focus goes back to its [Change].
   * When the draft couldn't take them (another editor's change was asked about, or a save settled meanwhile), the
   * editor stays open and says so, as the drawer's does (D2).
   */
  function finishEditor(target: DrawerEditTarget, picks: CategoryPicks) {
    if (!takeAction(categoryPickAction({ draft: latestDraft.current, categoryId, detail, picks }))) {
      setOpenField({ target, message: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
      return;
    }
    setOpenField(null);
    focusChange(target);
  }

  /** "Also clear theirs" ticked or unticked (8.4; the price's box too, 9.1): one field of the draft; focus stays on the box. */
  function tick(field: PriceChangeClearField, ticked: boolean) {
    takeAction(categoryClearAction({ draft: latestDraft.current, categoryId, detail, field, ticked }));
  }

  /** Save (or Check again) through W12 (plan 8.5, 8.6): the lib's runner, then what its follow-up asks of the editor. */
  async function save() {
    const live = latestDraft.current;
    if (live === null || live.editor !== editor || readCategoryDraft(live.value) === null || saving.current) return;
    saving.current = true;
    setFooterMessage(null);
    setFailure(null);
    try {
      const outcome = await runCategorySettingsSave({
        storeConnectionId,
        categoryId,
        categoryName: state.name,
        draft: live,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => putJson<unknown>(categorySettingsEndpoint(storeConnectionId, categoryId), body),
        reread: (options) => rereadAfterCategorySave(queryClient, storeConnectionId, categoryId, options),
        rereadCard: () => rereadCategoryCard(queryClient, storeConnectionId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      if (outcome.kind === "not_started" && outcome.message) setFooterMessage(outcome.message);
      else if (outcome.kind === "failed") {
        setFailure(outcome.failure);
        if (outcome.followUp === "close") {
          // No chosen product is in the category any more: the draft goes with the editor, the step says so under
          // the card; the runner read the card.
          closing.current = true;
          drafts.discard();
          props.onClose("not_found");
        }
        // "reread_card": the runner read the summary again and the card takes [Change] away (D11); the words are in
        // the footer. "load_latest": the footer offers [Load latest and keep my changes] from the draft's conflict.
      }
    } finally {
      saving.current = false;
    }
  }

  /** "Load latest and keep my changes" after a 409 (R:542, plan 8.6): the choices on what is saved now, the clear set rebuilt. */
  async function loadLatest() {
    const live = latestDraft.current;
    const mine = live !== null && live.editor === editor ? readCategoryDraft(live.value) : null;
    if (mine === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      const next = await loadLatestCategory(queryClient, storeConnectionId, categoryId, mine);
      if (!mounted.current) return;
      if (!next.keeps) {
        // Another window saved the same choices: nothing of the vendor's is left to put on top.
        setFailure(null);
        drafts.discard();
        return;
      }
      drafts.edit(next.edited);
      // The price choice rides along; its check goes with the rebase (plan 9.4), so the rows show again.
      drafts.rebase(next.latest, next.marked);
      dropCheckViews();
    } catch {
      // Deliberate: the draft keeps the conflict and its Load latest; the words say the read failed.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /**
   * [Reload] after "Saved. We couldn't load the latest view." (reads only, D9): W12's views, or, after a price
   * apply (the draft holds its check), the apply's (the lists, every product, every size price, the category).
   */
  async function reload() {
    if (reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      if (categorySavedThroughCheck(latestDraft.current, categoryId)) await refreshAfterCategoryPriceApply(queryClient, storeConnectionId, categoryId);
      else await reloadAfterCategorySave(queryClient, storeConnectionId, categoryId, latestDraft.current);
      if (mounted.current) drafts.discard();
    } catch {
      // Deliberate: the save stands; the draft keeps "Saved. We couldn't load the latest view." with Reload.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Discard]: every field back to as it is; after a 409 the detail is read again first, since the draft's facts are old. */
  async function discard() {
    setFooterMessage(null);
    setFailure(null);
    setOpenField(null);
    setPriceEditor(null);
    dropCheckViews();
    const decision = categoryDiscard(latestDraft.current, categoryId);
    switch (decision.kind) {
      case "none":
        return;
      case "reset":
        drafts.edit(decision.value);
        return;
      case "reread":
        setReading(true);
        try {
          await rereadCategoryDetail(queryClient, storeConnectionId, categoryId);
        } catch {
          // Deliberate: the read failed; the draft goes anyway (the vendor asked to drop their changes), and the
          // editor opens again on the read it has, whose Try again reads it afresh.
        } finally {
          if (mounted.current) {
            setReading(false);
            drafts.discard();
          }
        }
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // The Price row and its check (W7 `category_price`, PR 10f; plan 9.2, 9.4; D1, D2, D6, D20, D21)
  // ---------------------------------------------------------------------------

  /** This category's draft value as it is at call time: a check's answer lands after renders. */
  function currentCategoryValue(): CategoryDraftValue | null {
    const live = latestDraft.current;
    return live !== null && live.editor === editor ? readCategoryDraft(live.value) : null;
  }

  /** Forgets the check's rows and what an apply named; a check still on its way is dropped when it lands. */
  function dropCheckViews() {
    checkGeneration.current += 1;
    setCheckReview(null);
    setCheckNotice(null);
    setCheckRead(null);
    setRefusedSizes(NO_SIZES);
  }

  /** Where a check's words go: the price editor while it is open, else the footer. */
  function sayOfCheck(message: string) {
    if (priceEditor !== null) setPriceEditor({ message });
    else setFooterMessage(message);
  }

  /**
   * What the editor does beside the words after a check or an apply the server refused for good (plan 9.4, as after
   * W12's, 8.6): older rules present → the card reads the summary again and takes [Change] away (D11; the Price row's
   * goes with it); the category gone → the editor closes, its draft goes (never a save out or unconfirmed, 3.4), the
   * step says so under the card, and the card reads again. The card's read is best effort: its own state shows a failure.
   */
  function followUpRefusal(followUp: ReturnType<typeof categoryFailureFollowUp>) {
    if (followUp !== "reread_card" && followUp !== "close") return;
    if (followUp === "close") {
      closing.current = true;
      if (categoryGoneDiscards(latestDraft.current, categoryId)) drafts.discard();
      props.onClose("not_found");
    }
    void rereadCategoryCard(queryClient, storeConnectionId).catch(() => {
      // Deliberate: the card's own read state shows a failure with Try again; nothing was saved here.
    });
  }

  /**
   * One check of the draft `value` (plan 9.2, 9.4): the editor's request (the price with the other changes and
   * "Also clear theirs", checked by the shared schema), after the guard reads the detail again and compares the
   * revision and clear set the value was made against (D6). A request this page can't build is never sent.
   */
  function checkRun(value: CategoryDraftValue, after: PriceCheckAfter | null): Promise<PriceChangeCheckOutcome> {
    let request: CategoryPriceReviewInput;
    try {
      request = categoryPriceReviewRequest(value);
    } catch (error) {
      return Promise.resolve({ kind: "failed", message: error instanceof CategoryRequestError ? error.message : PRICE_DEFAULT_WORDS.reviewFailed });
    }
    return runPriceChangeCheck({
      kind: "category_price",
      request,
      categoryName: state.name,
      after,
      send: (body) => sendPriceChangeReview(storeConnectionId, body),
      drafts,
      guard: {
        base: categoryPriceCheckBaseOf(value),
        reread: () => rereadCategoryDetail(queryClient, storeConnectionId, categoryId),
      },
    });
  }

  /** Runs the check and shows it: the check goes in the draft and its rows replace the body (D20); a moved category is the conflict. */
  async function checkPrices(value: CategoryDraftValue, after: PriceCheckAfter | null = null) {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    const generation = checkGeneration.current;
    setChecking(true);
    setCheckNotice(null);
    try {
      const outcome = await checkRun(value, after);
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
        const live = currentCategoryValue();
        // Discarded meanwhile: the answer is dropped. Changed meanwhile (the rows wait during a check, but a draft can
        // still move under it): the check is of an older request and goes; Save offers a new one (plan 9.4).
        if (live === null || !categoryPriceCheckAnswers(live, outcome.request)) return;
        drafts.edit(categoryPriceDraftWithCheck(live, outcome.check));
        setCheckReview(outcome.review);
        setCheckRead(null);
        setRefusedSizes(NO_SIZES);
        setPriceEditor(null);
        return;
      }
      case "conflict":
        // The draft shows the conflict's words with [Load latest and keep my changes] in the footer (plan 9.4).
        setPriceEditor(null);
        setCheckReview(null);
        return;
      case "blocked":
        props.onBlocked?.(outcome.error);
        sayOfCheck(LISTING_SETTINGS_SAVE_WORDS.blocked);
        return;
      case "failed":
        // The review's own refusals (older rules, the category gone, too heavy), worded by the lib; two of them the
        // editor acts on too (plan 9.4).
        sayOfCheck(outcome.message);
        followUpRefusal(outcome.followUp ?? null);
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

  /** [Cancel] or Esc: what was typed is dropped (the draft keeps a change it already holds), and focus goes back to the row's [Change] (or the row). */
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
   * [Check new prices] in the price editor (plan 9.2): the choice goes in the draft as the category's price change
   * (`categoryPriceAction`; the other changes and ticks stay, D2), then the check runs on it. A choice the category
   * already has is nothing to check: the editor just closes.
   */
  function checkFromEditor(change: Pick<ProductPriceChange, "price" | "releaseExactPrices">) {
    const action = categoryPriceAction({ draft: latestDraft.current, categoryId, detail, choice: change.price });
    let value: CategoryDraftValue;
    switch (action.kind) {
      case "locked":
      case "not_open":
        setPriceEditor({ message: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
        return;
      case "edit":
        drafts.edit(action.value);
        value = action.value;
        break;
      case "start":
        // False when another editor's change is asked about first: nothing is checked yet.
        if (!drafts.open(action.editor, action.place, action.base)) return;
        drafts.edit(action.value);
        value = action.value;
        break;
    }
    setFailure(null);
    setFooterMessage(null);
    if (!categoryPriceChanged(value)) {
      closePriceEditor();
      return;
    }
    setPriceEditor({ message: null });
    void checkPrices(value);
  }

  /** The footer's [Check new prices] while the draft holds a price change with no check (after Back to editing, Load latest). */
  function checkFromFooter() {
    const live = currentCategoryValue();
    if (live === null || !categoryPriceChanged(live)) return;
    setFooterMessage(null);
    void checkPrices(live);
  }

  /**
   * The check the server dropped (404 on a page read): a new one for the same change, with its line, once the draft
   * can take it (`page_expired`: no apply was tried for it). While locked, Check again answers it from the draft's reference.
   */
  function checkAgainAfterExpiry(shown: CategoryPriceCheckShown) {
    const live = currentCategoryValue();
    if (live === null || shown.locked) {
      setCheckRead({ kind: "failed", message: LISTING_SETTINGS_SAVE_WORDS.pricingReviewGone });
      return;
    }
    const value = categoryPriceDraftWithCheck(live, null);
    drafts.edit(value);
    dropCheckViews();
    void checkPrices(value, "page_expired");
  }

  /**
   * [Save new prices], or [Check again] after an unconfirmed apply (plan 9.4): one W7 apply of the check the draft
   * holds, with `categoryRevisionId` in its answer. A refusal a new check answers gets one, once, after the guard
   * read the detail again (a moved revision or clear set is the conflict instead); the category's version conflicts
   * put the editor's body back with [Load latest and keep my changes]. After a confirmed save the categories, the
   * category, the lists, every product and every size price are read again (D9); the answer is never shown.
   */
  async function applyPrices() {
    const live = latestDraft.current;
    const value = live !== null && live.editor === editor ? readCategoryDraft(live.value) : null;
    const check = value?.price.check ?? null;
    if (live === null || value === null || check === null || saving.current) return;
    saving.current = true;
    setCheckNotice(null);
    try {
      const outcome = await runPriceChangeApply({
        kind: "category_price",
        categoryName: state.name,
        draft: live,
        check,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => sendPriceChangeApply(storeConnectionId, body),
        reread: () => refreshAfterCategoryPriceApply(queryClient, storeConnectionId, categoryId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
        recheck: {
          check: async (after) => {
            setRechecking(true);
            try {
              return await checkRun(currentCategoryValue() ?? value, after);
            } finally {
              if (mounted.current) setRechecking(false);
            }
          },
          withCheck: (next) => categoryPriceDraftWithCheck(currentCategoryValue() ?? value, next),
        },
      });
      if (!mounted.current) return;
      switch (outcome.kind) {
        case "not_started":
          if (outcome.message) setCheckNotice(outcome.message);
          return;
        case "saved":
          // The body shows again from the views read again; "Saved" shows in the footer for 3 seconds.
          dropCheckViews();
          return;
        case "failed":
          // Shown by the check body with [Back to editing]; older rules and a gone category are acted on too (plan 9.4).
          setRefusedSizes(outcome.refusedSizes);
          followUpRefusal(categoryFailureFollowUp(outcome.failure));
          return;
        case "rechecked":
          setCheckReview(outcome.review);
          setCheckRead(null);
          setRefusedSizes(NO_SIZES);
          return;
        case "recheck_failed":
          // The refused check left the draft: the editor's body shows with the words; [Check new prices] is the way on,
          // unless the new check was refused for good (older rules, the category gone), which the editor acts on.
          dropCheckViews();
          setFooterMessage(outcome.message);
          followUpRefusal(outcome.followUp ?? null);
          return;
        case "conflict":
          // The editor's body shows with [Load latest and keep my changes] (plan 9.4).
          dropCheckViews();
          return;
      }
    } finally {
      saving.current = false;
    }
  }

  /** Another page of the check (plan 7.5): the same review by id; a dropped review means a new check. */
  async function showCheckPage(page: number) {
    const shown = state.priceCheck;
    if (shown === null || paging) return;
    const { check } = shown;
    setPaging(true);
    setCheckNotice(null);
    try {
      const outcome = await readPriceCheckPage(check, () => fetchPriceChangeReviewPage(storeConnectionId, check.reviewId, page), "category_price");
      if (!mounted.current) return;
      if (outcome.kind === "ok") setCheckReview(outcome.review);
      else if (outcome.kind === "expired") checkAgainAfterExpiry(shown);
      else setCheckNotice(outcome.message);
    } finally {
      if (mounted.current) setPaging(false);
    }
  }

  /** [Back to editing] (D20, D21): the check leaves the draft and the price editor opens on the change; a locked draft closes the editor and is kept. */
  function backToEditing() {
    const decision = categoryPriceCheckBack(latestDraft.current, categoryId);
    switch (decision.kind) {
      case "edit":
        drafts.edit(decision.value);
        dropCheckViews();
        setPriceEditor({ message: null });
        return;
      case "close":
        drafts.close();
        props.onClose();
        return;
      case "none":
        return;
    }
  }

  // The editor reopened on a draft that holds a check (browser Back, D21): its rows are read again, page 0, by the
  // review's id; a check the server dropped means a new check once the draft can take it. Only once per check.
  const shownCheck = state.priceCheck;
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
      const outcome = await readPriceCheckPage(check, () => fetchPriceChangeReviewPage(storeConnectionId, check.reviewId, 0), "category_price");
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

  // The check replaces the editor's body (D20): the draft's check, or the stale one while a refused apply's new check is made.
  const bodyCheck = categoryPriceCheckBody({ shown: shownCheck, lastShown: lastShown.current, rechecking, draft: drafts.draft, categoryId });

  const shelves = props.shelves ?? null;
  const facts = state.own;
  const priceEditorNode = priceEditor !== null && state.price !== null && state.price.change.shown ? (
    <ProductPriceEditor
      model={state.price.editor}
      title={state.price.label}
      productName={state.name}
      message={priceEditor.message}
      checking={checking}
      locked={state.held}
      defaultLabel={LISTING_SETTINGS_CATEGORY_WORDS.useStoreDefault}
      release={false}
      onCheck={checkFromEditor}
      onCancel={closePriceEditor}
    />
  ) : null;

  function renderEditor(row: CategoryEditorRow): ReactNode {
    const rowEdit = row.row.edit;
    if (rowEdit === null || !rowEdit.open || openField === null || facts === null) return null;
    const common = {
      title: row.row.label, productName: state.name, message: openField.message, onCancel: closeFieldEditor,
      defaultLabel: LISTING_SETTINGS_CATEGORY_WORDS.useStoreDefault,
    };
    if (rowEdit.kind === "description") {
      return (
        <DrawerDescriptionEditor
          key="description"
          {...common}
          category
          model={categoryDescriptionFieldEditor({ rights: rowEdit, draftChoices: rowEdit.choices, own: facts })}
          onDone={(picks) => finishEditor("description", picks)}
        />
      );
    }
    if (rowEdit.target === "ebayCategory") {
      return (
        <DrawerEbayCategoryEditor
          key="ebayCategory"
          {...common}
          storeConnectionId={storeConnectionId}
          model={categoryEbayCategoryFieldEditor({ rights: rowEdit, draftChoice: rowEdit.choice, own: facts })}
          onDone={(choice) => finishEditor("ebayCategory", { ebayCategory: choice })}
        />
      );
    }
    if (rowEdit.target === "storeShelf") {
      return (
        <DrawerShelfEditor
          key="storeShelf"
          {...common}
          model={categoryStoreShelfFieldEditor({ rights: rowEdit, draftChoice: rowEdit.choice, own: facts, shelves })}
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
        model={categoryPolicyFieldEditor({ field, rights: rowEdit, draftChoice: rowEdit.choice, own: facts, setup: props.setup })}
        onDone={(choice) => finishEditor(field, { [field]: choice })}
      />
    );
  }

  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={props.onDismiss} />}
        <SheetTitle className="min-w-0 flex-1 break-words text-base font-semibold text-zinc-900">{state.title}</SheetTitle>
        {!compact && <CloseButton onClick={props.onDismiss} />}
      </div>

      {bodyCheck !== null ? (
        <PriceChangeCheckBody
          check={bodyCheck.check}
          review={rechecking ? null : reviewShown}
          change={bodyCheck.change}
          changeWords={categoryPriceCheckChangeWords(bodyCheck.change)}
          also={bodyCheck.also}
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
        {state.loadingLine && <p role="status" className="text-sm text-zinc-600">{state.loadingLine}</p>}
        {state.problem && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="category-editor-read-problem">
            <span>{state.problem.text}</span>
            {state.problem.retryLabel !== null && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void detailQuery.refetch()}>
                {state.problem.retryLabel}
              </Button>
            )}
          </div>
        )}
        {state.latestFailed && (
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="category-editor-latest-failed">
            {state.latestFailed.text}
            <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void detailQuery.refetch()}>
              {state.latestFailed.retryLabel}
            </Button>
          </p>
        )}
        {state.read === "answered" && (
          <section aria-label={state.title} className="rounded-md border border-zinc-200 px-4" data-testid="category-editor-rows">
            {state.price && (
              <CategoryPriceRowItem
                price={state.price}
                onChange={togglePriceEditor}
                changeRef={(element) => { changePriceButton.current = element; }}
                rowRef={(element) => { priceRowElement.current = element; }}
                editor={(
                  <>
                    {state.price.clears.map((box) => <ClearTheirsBox key={box.field} box={box} onTick={tick} />)}
                    {priceEditorNode}
                  </>
                )}
              />
            )}
            {state.rows.map((row) => {
              const target = row.row.edit?.target ?? null;
              return (
                <DrawerSettingRow
                  key={row.key}
                  row={row.row}
                  productName={state.name}
                  onChange={target === null ? undefined : () => toggleFieldEditor(target)}
                  changeRef={target === null ? undefined : (element) => {
                    if (element) changeButtons.current.set(target, element);
                    else changeButtons.current.delete(target);
                  }}
                  rowRef={target === null ? undefined : (element) => {
                    if (element) rowElements.current.set(target, element);
                    else rowElements.current.delete(target);
                  }}
                  editor={(
                    <>
                      {row.clears.map((box) => <ClearTheirsBox key={box.field} box={box} onTick={tick} />)}
                      {renderEditor(row)}
                    </>
                  )}
                />
              );
            })}
          </section>
        )}
      </div>

      {state.read === "answered" && (
        <DrawerFooterBar
          testIdPrefix="category-editor"
          footer={state.footer}
          message={footerMessage}
          onDiscard={() => void discard()}
          onPrimary={() => {
            // The draft's shape decides the writer (plan 9.2, 9.7): a price change is checked (W7), never saved through
            // W12; Check again over a price check is its apply; Load latest and Reload are the editor's either way.
            const action = state.footer.primary.action;
            if (action === "save") {
              if (state.priceHoldsChange) checkFromFooter();
              else void save();
            } else if (action === "resend") {
              if (categorySavedThroughCheck(latestDraft.current, categoryId)) void applyPrices();
              else void save();
            } else if (action === "load_latest") void loadLatest();
            else if (action === "reload") void reload();
          }}
        />
      )}
      </>
      )}
    </>
  );
}

/**
 * The Price row (PR 10f, plan 9.2, 9.3; UX-m9 lifted): the category's own
 * recipe, else the store's, with "Set for Sleeves" or "Store default"; its
 * example prices as they are now ("Now: Pack of 100 $4.99 · …", CC-C23),
 * hidden while the price is changed; the change not saved yet ("→ Retail
 * price + 20%, round up to .99 · Not saved"); why there is no [Change] when
 * there is none; the price's "Also clear theirs" box and the price editor
 * under it while it is open. Drawn as the setting rows are, so the editor
 * reads as one list. Hook-free (one Price row per editor, so its pending
 * line's id is fixed), so a test can press its button.
 */
export function CategoryPriceRowItem({ price, onChange, changeRef, rowRef, editor }: {
  price: CategoryPriceRow;
  onChange?: () => void;
  changeRef?: (element: HTMLButtonElement | null) => void;
  rowRef?: (element: HTMLDivElement | null) => void;
  /** The price's clear box and its editor, under the row. */
  editor?: ReactNode;
}) {
  const pendingId = "category-price-pending";
  const shown = price.change.shown;
  return (
    <div
      ref={rowRef}
      tabIndex={-1}
      className={`grid gap-1 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0] sm:gap-4 ${shown ? "sm:grid-cols-[10rem_minmax(0,1fr)_auto]" : "sm:grid-cols-[10rem_minmax(0,1fr)]"}`}
      data-testid="category-price-row"
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{price.label}</h4>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="break-words text-zinc-900">{price.value}</span>
          {price.tag !== null && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">{price.tag}</span>}
        </p>
        {price.examples !== null && <p className="text-xs text-zinc-600" data-testid="category-price-examples">{price.examples}</p>}
        {price.pending !== null && (
          <p id={pendingId} className="break-words text-sm font-medium text-zinc-900" data-testid="category-price-pending">{price.pending}</p>
        )}
        {price.marked && <p className="text-xs font-medium text-amber-900">{STORE_DEFAULT_EDITOR_WORDS.changedElsewhereToo}</p>}
        {price.fieldError !== null && <p role="alert" className="text-sm text-rose-800">{price.fieldError}</p>}
        {price.line !== null && <p className="text-xs text-zinc-600" data-testid="category-price-line">{price.line}</p>}
      </div>
      {shown && (
        <div>
          <Button
            ref={changeRef}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-label={price.change.ariaLabel}
            aria-describedby={price.pending !== null ? pendingId : undefined}
            aria-expanded={price.open}
            disabled={price.change.disabled}
            onClick={onChange}
          >
            {price.change.label}
          </Button>
        </div>
      )}
      {editor}
    </div>
  );
}

/**
 * "3 products in Sleeves have their own shipping policy. [ ] Also clear theirs,
 * so all 15 use this one." (REC:869, plan 8.4) under a field whose products
 * hold their own value, while the save would set the field on the category.
 * The box is read out with its line, which names the setting and the category
 * (plan 3.4: up to seven boxes share the label). Hook-free, so a test can tick
 * it; the line's id is the field's, one box per field in the one open editor.
 */
export function ClearTheirsBox({ box, onTick }: { box: CategoryClearBox; onTick: (field: PriceChangeClearField, ticked: boolean) => void }) {
  const lineId = `category-clear-${box.field}-line`;
  return (
    <div className="mt-2 space-y-1 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm sm:col-span-3" data-testid={`category-clear-${box.field}`}>
      <p id={lineId} className="text-zinc-700">{box.line}</p>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-zinc-900 sm:min-h-0">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 accent-[#C060E0]"
          aria-describedby={lineId}
          checked={box.ticked}
          disabled={box.disabled}
          onChange={(event) => onTick(box.field, event.target.checked)}
        />
        <span>{box.label}</span>
      </label>
    </div>
  );
}
