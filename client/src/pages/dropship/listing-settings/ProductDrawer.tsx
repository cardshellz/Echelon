import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import type { ListingSettingsProductDetail, ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { listingPriceEndpoint, type ListingPriceIdentity } from "@/lib/dropship-listing-price";
import {
  listingSettingsProductOwnQueryOptions,
  listingSettingsProductQueryOptions,
  listingSettingsQueryKey,
} from "@/lib/dropship-listing-settings";
import type { ListingSettingsEditRights, ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  productEditorId,
  type EditorId,
  type ListingSettingsDraft,
  type WriteFailure,
} from "@/lib/dropship-listing-settings-drafts";
import {
  clearOutcome,
  decideSizeEdit,
  DRAWER_WORDS,
  drawerCategoryLine,
  drawerDraftState,
  drawerFooter,
  drawerOwnReadProblem,
  drawerOwnSettingsLine,
  drawerPhoneSummary,
  drawerReadProblem,
  drawerSettingRows,
  drawerLanding,
  drawerSizeEditState,
  shownFieldEditor,
  drawerSizeLine,
  drawerSizeList,
  drawerStartsWithAllSizes,
  isPolicyRowEdit,
  ownSizePriceDraft,
  priceHeadWords,
  rebaseSizePriceDraft,
  refreshAfterSizePriceSave,
  rereadSizePrice,
  runSizePriceSave,
  sizePriceDraftValue,
  sizePriceQueryOptions,
  sizePriceSave,
  sizesNotChosenWords,
  type DrawerEditTarget,
  type DrawerEntryPick,
  type DrawerFooter,
  type DrawerSettingRowKey,
  type DrawerSettingRowModel,
  type DrawerTarget,
  type SizePriceSaveCallbacks,
} from "@/lib/dropship-listing-settings-drawer";
import {
  descriptionFieldEditor,
  ebayCategoryFieldEditor,
  policyFieldEditor,
  productSettingsEditAction,
  readProductSettingsDraft,
  sizeLeftoverFields,
  storeShelfFieldEditor,
  type FieldChoice,
  type MainTextChoiceValue,
  type ProductOwnSettings,
  type ProductSettingsEditAction,
  type ProductSettingsPicks,
} from "@/lib/dropship-listing-settings-product-edit";
import {
  loadLatestProductSettings,
  productSettingsEndpoint,
  rereadProductSettings,
  runProductSettingsSave,
} from "@/lib/dropship-listing-settings-product-requests";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_EDIT_WORDS, rightReasonLine } from "@/lib/dropship-listing-settings-words";
import { putJson, type DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import { DrawerDescriptionEditor } from "./DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor } from "./DrawerFieldEditor";
import { DrawerPriceSection } from "./DrawerPriceSection";
import { DrawerSettingRow } from "./DrawerSettingRow";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";

/** How the vendor closed the drawer: × / Esc / ← with nothing to lose, or "Discard and leave". */
export type ProductDrawerCloseReason = "dismissed" | "discarded";

/**
 * A row the drawer lands on when it opens (an attention [Fix], plan 5.2): the
 * description conflict opens the Description row's editor. One request per
 * [Fix] press (`requestId`); the drawer handles it once, then calls `onLanded`.
 */
export interface DrawerLandingRequest {
  productId: number;
  row: DrawerSettingRowKey;
  requestId: number;
}

export interface ProductDrawerProps {
  storeConnectionId: number;
  storeName: string;
  /** What the address opens (`drawerTargetFromSearch`); null keeps the drawer closed. */
  target: DrawerTarget | null;
  /**
   * The step's edit rights (plan 4.3): `exactPrice` for a size's exact price
   * (W9); `productSettings` for the product's own settings (W5, PR 10), with
   * `shipping` and `policies` to pick a new eBay policy, `ebayCategory` and
   * `shelfPick` to pick a new eBay category or shelf (D3, D4; 10b).
   */
  rights: Pick<ListingSettingsEditRights, "exactPrice" | "productSettings" | "shipping" | "policies" | "ebayCategory" | "shelfPick">;
  /** The live eBay setup read: policy names (A4) and, from PR 10, the policies a row's editor lists with their Card Shellz fit. */
  setup: ListingSettingsReadState<PolicySetupFacts>;
  /**
   * The step's store shelves read (`categories`) while it answers, else null:
   * the shelf editor's choices and a picked shelf's name (10b). Left out, no
   * new shelf can be picked (`rights.shelfPick` says the same).
   */
  shelves?: readonly DropshipEbayStoreCategoryOption[] | null;
  /** The row to land on when the drawer opens on this product; null or left out for none. */
  landing?: DrawerLandingRequest | null;
  /** The landing request was handled (or can't be): the step forgets it. */
  onLanded?: () => void;
  /** `summary.storeDefaults.price.recipe`; undefined until the summary answers. */
  summaryRecipe: PricingRecipe | null | undefined;
  /** The step takes `?product=` off the address. Browser Back closes the drawer without this. */
  onClose: (reason: ProductDrawerCloseReason) => void;
  /** The page's pending-save counter (D10). */
  saveCallbacks: SizePriceSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  onGoToStep1: () => void;
  /** "See the full listing in step 3 ›". */
  onGoToStep3: () => void;
  /** A save refused because of a block the banner explains (plan 4.4); the draft is kept. */
  onBlocked?: (error: unknown) => void;
  /** Gets focus back when the drawer closes (the row or [Change] that opened it). */
  returnFocusTo?: FocusReturnTarget;
}

/** Full screen below 640 px (R:412); a wide right-side sheet above. The built-in × is replaced by the header's own. */
export const PRODUCT_DRAWER_CLASS =
  "flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl [&>button]:hidden motion-reduce:animate-none motion-reduce:transition-none";

/**
 * The product drawer (M4, R:237-296; plan 2E). Opened by the address
 * (`?product=<id>&size=<variantId>`); the PRICE section saves one size's
 * exact price per Save through W9. From PR 10 every setting row can be
 * changed too (the shipping, return and payment policy, the eBay category,
 * the store shelf, and the description's text above, text below and main
 * text), or set back to the default, and Save sends them through W5, from
 * the product's own settings read. Each row says where its value comes from
 * (R:968); values whose sizes differ get a one-button fix (5.3), and own main
 * text Card Shellz changed under asks to be checked (5.4).
 *
 * One kind of change per Save (D2): a size's price or the product's
 * settings; starting the other kind says "Save or discard your other change
 * first." One field editor is open at a time, in place under its row.
 *
 * × or Esc with a change asks first (plan 4.6). Esc closes an open field
 * editor first, and keeps the drawer open while a settings save is out or
 * unconfirmed (plan 3.4). Browser Back takes `?product=` off the address,
 * which closes the drawer and keeps its draft; the bar still says
 * "Not saved · 1 change in <Product>".
 */
export function ProductDrawer(props: ProductDrawerProps) {
  const { target, storeConnectionId, onClose } = props;
  // The open body says whether it used Esc (to close its field editor, or to keep a settings save in view).
  const escape = useRef<(() => boolean) | null>(null);
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const drafts = useListingSettingsDrafts();
  const guard = useLeaveGuard();
  const productId = target?.productId ?? null;
  const guardId = `${LISTING_SETTINGS_GUARD_ID_PREFIX}${storeConnectionId}`;
  const draftRef = useRef(drafts.draft);
  draftRef.current = drafts.draft;

  // The address decides what shows. A draft of a product that is no longer shown is
  // hidden and kept (browser Back); coming back to that product shows it again.
  const { open: openDraft, close: closeDraft, discard: discardDraft } = drafts;
  const shownProduct = useRef<number | null>(null);
  useEffect(() => {
    const previous = shownProduct.current;
    shownProduct.current = productId;
    if (previous === productId) return;
    const draft = draftRef.current;
    if (previous !== null && draft?.editor === productEditorId(previous) && draft.open) closeDraft();
    if (productId !== null && draft?.editor === productEditorId(productId) && !draft.open) openDraft(draft.editor, draft.place, draft.base);
  }, [productId, openDraft, closeDraft]);

  const dismiss = useCallback(() => {
    if (productId === null) return;
    const editor = productEditorId(productId);
    const draft = draftRef.current;
    const mine = draft?.editor === editor ? draft : null;
    // A save in flight is never dropped: the drawer hides and the draft settles on its own.
    if (mine && mine.phase !== "saving" && isDraftDirty(mine)) {
      guard(() => {
        discardDraft();
        onClose("discarded");
      }, [guardId]);
      return;
    }
    if (mine) closeDraft();
    onClose("dismissed");
  }, [productId, guard, guardId, discardDraft, closeDraft, onClose]);

  return (
    <Sheet open={target !== null} onOpenChange={(next) => { if (!next) dismiss(); }}>
      <SheetContent
        side="right"
        data-testid="product-drawer"
        className={PRODUCT_DRAWER_CLASS}
        // The header's lines describe the product; Radix's aria-describedby would point at nothing.
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
        {target && (
          <ProductDrawerBody
            // Another product is another drawer: its sizes, search and focus start over.
            key={target.productId}
            {...props}
            productId={target.productId}
            targetVariantId={target.productVariantId ?? null}
            compact={compact}
            onDismiss={dismiss}
            escapeRef={escape}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

interface ProductDrawerBodyProps extends ProductDrawerProps {
  productId: number;
  targetVariantId: number | null;
  compact: boolean;
  onDismiss: () => void;
  /** Set by the body: true when it used an Esc, so the drawer stays open. */
  escapeRef: { current: (() => boolean) | null };
}

type FieldError = { productVariantId: number; message: string } | null;

/** The open row editor and why its last [Done] didn't take ("Save or discard your other change first."). */
type OpenField = { target: DrawerEditTarget; message: string | null } | null;

/** What putting a choice in the draft came to: in it, nothing to change, or why not. */
type PutResult = Exclude<ProductSettingsEditAction["kind"], "start"> | "asked";

/** The product's draft whatever it holds, or null when the step's draft is another editor's. */
function productDraftOf(draft: ListingSettingsDraft | null, editor: EditorId): ListingSettingsDraft | null {
  return draft !== null && draft.editor === editor ? draft : null;
}

function ProductDrawerBody(props: ProductDrawerBodyProps) {
  const { storeConnectionId, productId, targetVariantId, compact, rights } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  const editor: EditorId = productEditorId(productId);
  const detailQuery = useQuery(listingSettingsProductQueryOptions(storeConnectionId, productId));
  const detail = detailQuery.data ?? null;
  // The product's own values and revision, from one answer (D6); read while the drawer is open.
  const ownQuery = useQuery(listingSettingsProductOwnQueryOptions(storeConnectionId, productId));
  const ownSettings: ProductOwnSettings | null = ownQuery.data !== undefined && !ownQuery.isError ? ownQuery.data : null;
  const productDraft = productDraftOf(drafts.draft, editor);
  // The fields a size still sets for itself: there the product's own value is still a change (W5 clears it).
  const leftovers = useMemo(() => (detail === null ? [] : sizeLeftoverFields(detail.settings)), [detail]);

  const own = ownSizePriceDraft(drafts.draft, editor);
  const changedId = own !== null && isDraftDirty(own.draft) ? own.value.productVariantId : null;
  const [focusedId, setFocusedId] = useState<number | null>(targetVariantId);
  const sizeIds = useMemo(() => new Set(detail?.sizes.map((size) => size.price.productVariantId) ?? []), [detail]);
  // The size in edit: the one holding a change, else the one the vendor is on (D4).
  const candidate = changedId ?? focusedId ?? own?.value.productVariantId ?? null;
  const inEditId = candidate !== null && sizeIds.has(candidate) ? candidate : null;
  const identity = useMemo<ListingPriceIdentity | null>(
    () => (inEditId === null ? null : { storeConnectionId, productVariantId: inEditId }),
    [storeConnectionId, inEditId],
  );
  const w9Query = useQuery(sizePriceQueryOptions(identity, { inEdit: identity !== null, right: rights.exactPrice }));
  const w9 = w9Query.data && w9Query.data.productVariantId === inEditId ? w9Query.data : null;

  const [showAll, setShowAll] = useState<boolean | null>(null);
  const [sizeSearch, setSizeSearch] = useState("");
  const [fieldError, setFieldError] = useState<FieldError>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [openField, setOpenField] = useState<OpenField>(null);
  // The last refused settings save, with the fields it named (the draft keeps its words only).
  const [settingsFailure, setSettingsFailure] = useState<WriteFailure | null>(null);
  const changeButtons = useRef(new Map<DrawerEditTarget, HTMLButtonElement>());
  const settingRowElements = useRef(new Map<DrawerEditTarget, HTMLElement>());
  const saving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // The drawer opens with the target size's Exact price box focused (R:360, R:552).
  const inputs = useRef(new Map<number, HTMLInputElement>());
  const focusedTarget = useRef(false);
  useEffect(() => {
    if (focusedTarget.current || detail === null || targetVariantId === null) return;
    const input = inputs.current.get(targetVariantId);
    if (!input) return;
    focusedTarget.current = true;
    input.focus();
  }, [detail, targetVariantId]);
  const inputRef = useCallback((productVariantId: number, element: HTMLInputElement | null) => {
    if (element) inputs.current.set(productVariantId, element);
    else inputs.current.delete(productVariantId);
  }, []);

  const place = detail?.product.productName ?? own?.draft.place ?? "";
  const editable = rights.exactPrice.editable;

  function edit(price: ListingSettingsSizePrice, text: string) {
    if (!editable) return;
    setFieldError(null);
    setFooterMessage(null);
    setSettingsFailure(null);
    const action = decideSizeEdit(drafts.draft, editor, price, w9, text);
    switch (action.kind) {
      case "wait":
        // Another size holds a change: it is saved or discarded first (D4).
        return;
      case "edit":
        if (action.reopen && drafts.draft) drafts.open(editor, place, drafts.draft.base);
        drafts.edit(sizePriceDraftValue(action.value));
        return;
      case "start":
        // False when another editor holds changes: the vendor is asked first, and nothing is typed.
        if (!drafts.open(editor, place, sizePriceDraftValue(action.base))) return;
        drafts.edit(sizePriceDraftValue(action.value));
        return;
    }
  }

  async function saveSize() {
    const live = ownSizePriceDraft(drafts.draft, editor);
    if (live === null || saving.current) return;
    const target: ListingPriceIdentity = { storeConnectionId, productVariantId: live.value.productVariantId };
    const prepared = sizePriceSave(target, live.value);
    if (!prepared.ok) {
      setFieldError({ productVariantId: target.productVariantId, message: prepared.message });
      return;
    }
    // A clear waits until the size's own read says something would price it (the footer keeps Save off too).
    if (prepared.intent.kind === "inherit" && clearOutcome(w9).kind !== "allowed") return;
    // "14.9" is saved as 14.90, so the box reads the same as the price it saved.
    let draft = live.value;
    if (prepared.normalized.exact !== live.value.exact && !isDraftLocked(live.draft)) {
      draft = prepared.normalized;
      drafts.edit(sizePriceDraftValue(draft));
    }
    saving.current = true;
    setFieldError(null);
    setFooterMessage(null);
    try {
      const outcome = await runSizePriceSave({
        identity: target,
        draft,
        drafts,
        callbacks: props.saveCallbacks,
        send: (input) => putJson<unknown>(listingPriceEndpoint(target), input),
        refresh: () => refreshAfterSizePriceSave(queryClient, target),
        onSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      if (outcome.kind === "invalid") setFieldError({ productVariantId: target.productVariantId, message: outcome.message });
      else if (outcome.kind === "not_started" && outcome.message) setFooterMessage(outcome.message);
    } finally {
      saving.current = false;
    }
  }

  /** "Load latest and keep my changes" (R:542): the vendor's price on top of what is saved now. */
  async function loadLatest() {
    const live = ownSizePriceDraft(drafts.draft, editor);
    if (live === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      const fresh = await rereadSizePrice(queryClient, { storeConnectionId, productVariantId: live.value.productVariantId });
      if (!mounted.current) return;
      const next = rebaseSizePriceDraft(live.value, fresh);
      drafts.edit(sizePriceDraftValue(next.edited));
      drafts.rebase(sizePriceDraftValue(next.latest));
      // Deliberate: the product's lines catch up in the background; its own error shows if that read fails.
      void queryClient.invalidateQueries({ queryKey: listingSettingsQueryKey(storeConnectionId) });
    } catch {
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." (reads only). */
  async function reload() {
    const live = ownSizePriceDraft(drafts.draft, editor);
    if (live === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      await refreshAfterSizePriceSave(queryClient, { storeConnectionId, productVariantId: live.value.productVariantId });
      if (mounted.current) drafts.discard();
    } catch {
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /**
   * Gives focus back to a row's [Change] (plan 3.4). When it can't take it (a
   * size's price waits, D2, or a banner took the right away), the row takes
   * it, so focus is never lost to the page.
   */
  function focusChange(target: DrawerEditTarget) {
    const button = changeButtons.current.get(target);
    if (button && button.isConnected && !button.disabled) {
      button.focus();
      return;
    }
    const row = settingRowElements.current.get(target);
    if (row && row.isConnected) row.focus();
  }

  /** [Change] opens its row's editor (one at a time); pressed again, it closes it, as its aria-expanded says. */
  function toggleFieldEditor(target: DrawerEditTarget) {
    if (shownField === target) {
      closeFieldEditor();
      return;
    }
    setOpenField({ target, message: null });
  }

  /** [Cancel] or Esc: the pick is dropped, and focus goes back to the row's [Change]. */
  function closeFieldEditor() {
    const target = openField?.target ?? null;
    setOpenField(null);
    if (target !== null) focusChange(target);
  }

  /**
   * Puts choices in the drawer's one draft (nothing is sent until Save): an
   * editor's [Done], a "Sizes differ" quick pick or a check's answer. One kind
   * of change per Save (D2), and a save that is out or unconfirmed changes
   * nothing (`productSettingsEditAction` decides).
   */
  function putInDraft(picks: ProductSettingsPicks): PutResult {
    if (ownSettings === null || !props.rights.productSettings.editable) return "locked";
    const action = productSettingsEditAction({ draft: drafts.draft, editor, own: ownSettings, leftovers, picks });
    switch (action.kind) {
      case "locked":
      case "no_change":
      case "finish_first":
        return action.kind;
      case "edit":
        if (action.reopen && drafts.draft) drafts.open(editor, place, drafts.draft.base);
        drafts.edit(action.value);
        break;
      case "start":
        // False when another editor holds changes: the vendor is asked first, and nothing changes yet.
        if (!drafts.open(editor, place, action.base)) return "asked";
        drafts.edit(action.value);
        break;
    }
    setSettingsFailure(null);
    setFooterMessage(null);
    return "edit";
  }

  /** [Done] (plan 4.5): the editor's choice goes into the draft, and focus goes back to its [Change]. */
  function finishEditor(target: DrawerEditTarget, picks: ProductSettingsPicks) {
    const result = putInDraft(picks);
    if (result === "locked" || result === "asked") return;
    if (result === "finish_first") {
      // D2: a size's price holds a change; the editor stays open with the words.
      setOpenField({ target, message: LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst });
      return;
    }
    // In the draft, or what the product has already (no draft opens, nothing is asked): the editor closes.
    setOpenField(null);
    focusChange(target);
  }

  /** A quick pick from a closed row: the choice goes into the draft; focus stays on the button, which reads the pending line. */
  function pickFromRow(picks: ProductSettingsPicks): PutResult {
    const result = putInDraft(picks);
    if (result === "finish_first") setFooterMessage(LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst);
    return result;
  }

  /**
   * The check answered under the closed Description row: once the draft takes
   * it, the notice and the pressed button go, so focus goes to the row's
   * [Change], which reads the pending line (plan 3.4).
   */
  function answerCheckFromRow(answer: FieldChoice<MainTextChoiceValue>) {
    if (pickFromRow({ mainText: answer }) === "edit") focusChange("description");
  }

  /** Save (or Check again) of the product's settings through W5 (plan 4.6). */
  async function saveSettings() {
    const live = productDraftOf(drafts.draft, editor);
    if (live === null || readProductSettingsDraft(live.value) === null || saving.current) return;
    saving.current = true;
    setFooterMessage(null);
    setSettingsFailure(null);
    try {
      const outcome = await runProductSettingsSave({
        storeConnectionId,
        productId,
        storeName: props.storeName,
        draft: live,
        drafts,
        callbacks: props.saveCallbacks,
        send: (body) => putJson<unknown>(productSettingsEndpoint(storeConnectionId, productId), body),
        reread: () => rereadProductSettings(queryClient, storeConnectionId, productId),
        onSettingsSaved: props.onSaved,
        onBlocked: props.onBlocked,
      });
      if (!mounted.current) return;
      if (outcome.kind === "not_started" && outcome.message) setFooterMessage(outcome.message);
      else if (outcome.kind === "failed") setSettingsFailure(outcome.failure);
    } finally {
      saving.current = false;
    }
  }

  /** "Load latest and keep my changes" after a 409 (R:542, plan 4.7): the choices on what is saved now, moved fields marked. */
  async function loadLatestSettings() {
    const live = productDraftOf(drafts.draft, editor);
    const mine = live === null ? null : readProductSettingsDraft(live.value);
    if (mine === null || reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      const next = await loadLatestProductSettings(queryClient, storeConnectionId, productId, mine);
      if (!mounted.current) return;
      if (!next.keeps) {
        // Another window saved the same choices: nothing of the vendor's is left to put on top.
        setSettingsFailure(null);
        drafts.discard();
        return;
      }
      drafts.edit(next.edited);
      drafts.rebase(next.latest, next.marked);
    } catch {
      // Deliberate: the draft keeps the conflict and its Load latest; the words say the read failed.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." for a settings save (reads only, D9). */
  async function reloadSettings() {
    if (reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      await rereadProductSettings(queryClient, storeConnectionId, productId);
      if (mounted.current) drafts.discard();
    } catch {
      // Deliberate: the save stands; the draft keeps "Saved. We couldn't load the latest view." with Reload.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  function discard() {
    setFieldError(null);
    setFooterMessage(null);
    setSettingsFailure(null);
    setOpenField(null);
    drafts.discard();
  }

  // The rows, and the one field editor that shows: it closes when its row can no longer be changed (D3) or
  // the own read is gone, and that pick was never in the draft.
  const shelves = props.shelves ?? null;
  const rowsFor = (target: DrawerEditTarget | null) => detail === null ? [] : drawerSettingRows(detail, props.setup, {
    own: { data: ownQuery.data, error: ownQuery.error },
    rights: props.rights,
    draft: drafts.draft,
    editor,
    openField: target,
    failure: productDraft?.phase === "refused" ? settingsFailure : null,
    shelves,
  });
  const closedRows = rowsFor(null);
  const shownField = shownFieldEditor(closedRows, openField?.target ?? null, ownSettings !== null);
  const settingRows = shownField === null ? closedRows : rowsFor(shownField);
  useEffect(() => {
    if (openField === null || shownField !== null) return;
    setOpenField(null);
    // The editor closed itself: focus that was in it fell to the page or the sheet, so it goes to the row (plan 3.4).
    const active = document.activeElement;
    if (active === null || active === document.body || active.getAttribute("tabindex") === "-1") focusChange(openField.target);
  }, [openField, shownField]);

  // An attention [Fix] that names a row (plan 5.2): once the product and its own settings are read, the drawer
  // goes to that row and opens its editor when the row can be changed now; else it only takes focus there.
  const landing = props.landing !== undefined && props.landing !== null && props.landing.productId === productId ? props.landing : null;
  const landed = useRef<number | null>(null);
  const ownSettled = ownQuery.data !== undefined || ownQuery.isError;
  useEffect(() => {
    if (landing === null || landed.current === landing.requestId || detail === null || !ownSettled) return;
    landed.current = landing.requestId;
    const spot = drawerLanding(closedRows, landing.row);
    props.onLanded?.();
    if (spot === null) return;
    const row = settingRowElements.current.get(spot.target);
    row?.scrollIntoView?.({ block: "center" });
    // The editor takes focus itself when it opens (plan 3.4); a row that can't be changed now takes it instead.
    if (spot.open) setOpenField({ target: spot.target, message: null });
    else row?.focus();
  });

  // Which writer the draft is for, the right the footer saves with, and what Esc does (D2, plan 3.4).
  const draftState = drawerDraftState({ draft: drafts.draft, editor, rights: props.rights, failure: settingsFailure });

  // Esc (plan 3.4): closes the open field editor first; a settings save that is out or unconfirmed keeps the drawer open.
  useEffect(() => {
    props.escapeRef.current = () => {
      if (shownField !== null) {
        closeFieldEditor();
        return true;
      }
      return draftState.escapeKeepsOpen;
    };
    return () => { props.escapeRef.current = null; };
  });

  const pendingClear = own !== null && changedId !== null && own.value.exact.trim() === "" ? clearOutcome(w9) : null;
  const footer = drawerFooter({
    draft: draftState.footerDraft,
    editable: draftState.editable,
    busy: props.saveCallbacks.disabled === true || reading,
    // An open field editor holds a pick that isn't in the draft yet: [Done] or [Cancel] first, so Save never drops it.
    fieldEditorOpen: shownField !== null,
    clear: draftState.writer === "W5" ? null : pendingClear,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    showRefusal: draftState.showRefusal,
  });

  const problem = detail === null && detailQuery.isError ? drawerReadProblem(detailQuery.error, props.storeName) : null;
  const ownProblem = detail !== null && ownQuery.isError ? drawerOwnReadProblem(ownQuery.error, props.storeName) : null;
  const title = detail?.product.productName ?? (own?.draft.place || DRAWER_WORDS.untitled);

  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={props.onDismiss} />}
        <div className="min-w-0 flex-1 space-y-1">
          <SheetTitle className="break-words text-base font-semibold text-zinc-900">{title}</SheetTitle>
          {detail && (
            <>
              <p className="text-sm text-zinc-700">{compact ? drawerPhoneSummary(detail.product) : drawerCategoryLine(detail.product, detail.settings)}</p>
              <p className="text-sm text-zinc-600">{drawerOwnSettingsLine(detail)}</p>
            </>
          )}
        </div>
        {!compact && <CloseButton onClick={props.onDismiss} />}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
        {detail === null && !problem && <p role="status" className="text-sm text-zinc-600">{DRAWER_WORDS.loading}</p>}
        {problem && (
          <div role="alert" className="space-y-2 text-sm text-zinc-800">
            <p>{problem.message}</p>
            {problem.kind === "not_found" && (
              <Button type="button" size="sm" variant="outline" onClick={props.onGoToStep1}>{DRAWER_WORDS.goToStep1}</Button>
            )}
            {(problem.kind === "failed" || problem.kind === "rate_limited") && (
              <Button type="button" size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>{DRAWER_WORDS.tryAgain}</Button>
            )}
          </div>
        )}
        {detail && detailQuery.isError && (
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
            {DRAWER_WORDS.latestFailed}
            <Button type="button" size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>{DRAWER_WORDS.tryAgain}</Button>
          </p>
        )}
        {ownProblem && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="drawer-own-read-problem">
            <span>{ownProblem.message}</span>
            {(ownProblem.kind === "failed" || ownProblem.kind === "rate_limited") && (
              <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => void ownQuery.refetch()}>
                {DRAWER_WORDS.tryAgain}
              </Button>
            )}
          </div>
        )}
        {detail && identity !== null && w9Query.isError && (
          <p role="status" className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
            {DRAWER_WORDS.sizePriceReadFailed}
            <Button type="button" size="sm" variant="outline" onClick={() => void w9Query.refetch()}>{DRAWER_WORDS.tryAgain}</Button>
          </p>
        )}
        {detail && (
          <DrawerContent
            detail={detail}
            props={props}
            editor={editor}
            own={own}
            inEditId={inEditId}
            w9={w9}
            showAll={showAll ?? drawerStartsWithAllSizes(detail.sizes, targetVariantId)}
            onShowAll={() => setShowAll(true)}
            sizeSearch={sizeSearch}
            onSizeSearch={setSizeSearch}
            fieldError={fieldError}
            onEdit={edit}
            onFocusSize={setFocusedId}
            inputRef={inputRef}
            settingRows={settingRows}
            renderEditor={(row) => {
              const rowEdit = row.edit;
              if (rowEdit === null || !rowEdit.open || ownSettings === null || openField === null) return null;
              const common = { title: row.label, productName: place, message: openField.message, onCancel: closeFieldEditor };
              if (rowEdit.kind === "description") {
                return (
                  <DrawerDescriptionEditor
                    key="description"
                    {...common}
                    model={descriptionFieldEditor({ rights: rowEdit, draftChoices: rowEdit.choices, own: ownSettings, leftovers, detail })}
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
                    model={ebayCategoryFieldEditor({ rights: rowEdit, draftChoice: rowEdit.choice, own: ownSettings })}
                    onDone={(choice) => finishEditor("ebayCategory", { ebayCategory: choice })}
                  />
                );
              }
              if (rowEdit.target === "storeShelf") {
                return (
                  <DrawerShelfEditor
                    key="storeShelf"
                    {...common}
                    model={storeShelfFieldEditor({
                      rights: rowEdit, draftChoice: rowEdit.choice, own: ownSettings, leftover: leftovers.includes("storeShelf"), shelves,
                    })}
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
                  model={policyFieldEditor({
                    field, rights: rowEdit, draftChoice: rowEdit.choice, own: ownSettings, leftover: leftovers.includes(field), setup: props.setup,
                  })}
                  onDone={(choice) => finishEditor(field, { [field]: choice })}
                />
              );
            }}
            onPick={(pick) => { pickFromRow(pick.picks); }}
            onAnswerCheck={answerCheckFromRow}
            onChangeField={toggleFieldEditor}
            changeRef={(field, element) => {
              if (element) changeButtons.current.set(field, element);
              else changeButtons.current.delete(field);
            }}
            rowRef={(field, element) => {
              if (element) settingRowElements.current.set(field, element);
              else settingRowElements.current.delete(field);
            }}
            settingsHoldChange={draftState.settingsHoldChange}
          />
        )}
      </div>

      {detail && (
        <DrawerFooterBar
          footer={footer}
          message={footerMessage}
          onDiscard={discard}
          onPrimary={() => {
            // The draft's kind decides the writer (D2): the product's settings (W5) or one size's price (W9).
            const action = footer.primary.action;
            const settingsSave = draftState.writer === "W5";
            if (action === "save" || action === "resend") void (settingsSave ? saveSettings() : saveSize());
            else if (action === "load_latest") void (settingsSave ? loadLatestSettings() : loadLatest());
            else if (action === "reload") void (settingsSave ? reloadSettings() : reload());
          }}
        />
      )}
    </>
  );
}

function CloseButton({ phone = false, onClick }: { phone?: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label={phone ? DRAWER_WORDS.back : DRAWER_WORDS.close} onClick={onClick}>
      {phone ? <ArrowLeft aria-hidden="true" className="h-4 w-4" /> : <X aria-hidden="true" className="h-4 w-4" />}
    </Button>
  );
}

function DrawerContent({
  detail, props, editor, own, inEditId, w9, showAll, onShowAll, sizeSearch, onSizeSearch, fieldError, onEdit, onFocusSize, inputRef,
  settingRows, renderEditor, onPick, onAnswerCheck, onChangeField, changeRef, rowRef, settingsHoldChange,
}: {
  detail: ListingSettingsProductDetail;
  props: ProductDrawerBodyProps;
  editor: EditorId;
  own: ReturnType<typeof ownSizePriceDraft>;
  inEditId: number | null;
  /** The size in edit's own price read (W9), when it answered. */
  w9: ListingPriceSetting | null;
  showAll: boolean;
  onShowAll: () => void;
  sizeSearch: string;
  onSizeSearch: (value: string) => void;
  fieldError: FieldError;
  onEdit: (price: ListingSettingsSizePrice, text: string) => void;
  onFocusSize: (productVariantId: number) => void;
  inputRef: (productVariantId: number, element: HTMLInputElement | null) => void;
  /** The rows, with how each can be changed (`drawerSettingRows` with edit facts). */
  settingRows: DrawerSettingRowModel[];
  /** The open row's inline editor, or null. */
  renderEditor: (row: DrawerSettingRowModel) => ReactNode;
  /** A "Sizes differ" quick pick pressed (5.3). */
  onPick: (pick: DrawerEntryPick) => void;
  /** The main text's check answered from the closed Description row (5.4). */
  onAnswerCheck: (answer: FieldChoice<MainTextChoiceValue>) => void;
  onChangeField: (target: DrawerEditTarget) => void;
  changeRef: (target: DrawerEditTarget, element: HTMLButtonElement | null) => void;
  /** A changeable row, so focus can go back to it when its [Change] can't take it. */
  rowRef: (target: DrawerEditTarget, element: HTMLElement | null) => void;
  /** The product's settings hold a change (or a save of them is out): every size's price waits (D2). */
  settingsHoldChange: boolean;
}) {
  const drafts = useListingSettingsDrafts();
  const changedId = own !== null && isDraftDirty(own.draft) ? own.value.productVariantId : null;
  const locked = own !== null && isDraftLocked(own.draft);
  const list = drawerSizeList(detail.sizes, { showAll, search: sizeSearch, keepVariantIds: changedId === null ? [] : [changedId] });
  const refusedFor = own !== null && own.draft.phase === "refused" ? own.value.productVariantId : null;
  const sizesById = useMemo(() => new Map(detail.sizes.map((size) => [size.price.productVariantId, size.price])), [detail]);
  const lines = list.shown.map((size) => {
    const id = size.price.productVariantId;
    return drawerSizeLine({
      size,
      stock: detail.stock,
      edit: drawerSizeEditState(drafts.draft, editor, size.price),
      w9: id === inEditId ? w9 : null,
      editable: props.rights.exactPrice.editable,
      locked,
      fieldError: fieldError?.productVariantId === id ? fieldError.message
        : refusedFor === id ? own?.draft.message ?? null : null,
    });
  });
  const reason = props.rights.exactPrice.editable ? null : rightReasonLine(props.rights.exactPrice.reason);
  const waitingHint = settingsHoldChange
    ? LISTING_SETTINGS_EDIT_WORDS.otherChangeFirst
    : changedId !== null && detail.sizes.length > 1 ? DRAWER_WORDS.oneSizeAtATime : null;
  const withSize = (productVariantId: number, run: (price: ListingSettingsSizePrice) => void) => {
    const price = sizesById.get(productVariantId);
    if (price) run(price);
  };

  return (
    <>
      <DrawerPriceSection
        head={priceHeadWords(props.summaryRecipe)}
        reason={reason}
        waitingHint={waitingHint}
        sizes={lines}
        notChosen={sizesNotChosenWords(detail.product)}
        onGoToStep1={props.onGoToStep1}
        showAllLabel={list.showAllLabel}
        onShowAll={onShowAll}
        search={list.searchable ? { value: sizeSearch, onChange: onSizeSearch, noMatch: list.noMatch } : null}
        onEdit={(productVariantId, text) => withSize(productVariantId, (price) => onEdit(price, text))}
        onClear={(productVariantId) => withSize(productVariantId, (price) => onEdit(price, ""))}
        onFocusSize={onFocusSize}
        inputRef={inputRef}
      />
      <section aria-label="Other settings" className="rounded-md border border-zinc-200 px-4" data-testid="drawer-settings">
        {settingRows.map((row) => {
          const target = row.edit?.target ?? null;
          return (
            <DrawerSettingRow
              key={row.key}
              row={row}
              productName={detail.product.productName}
              onChange={target === null ? undefined : () => onChangeField(target)}
              changeRef={target === null ? undefined : (element) => changeRef(target, element)}
              rowRef={target === null ? undefined : (element) => rowRef(target, element)}
              editor={renderEditor(row)}
              onPick={onPick}
              onAnswerCheck={onAnswerCheck}
            />
          );
        })}
      </section>
      <Button type="button" variant="link" className="h-auto p-0 text-sm" onClick={props.onGoToStep3}>{DRAWER_WORDS.seeFullListing}</Button>
    </>
  );
}

/** The drawer's sticky footer (R:272): "● Not saved · 1 change" [Discard] [Save product]. Stateless, so every state renders in tests. */
export function DrawerFooterBar({ footer, message, onDiscard, onPrimary }: {
  footer: DrawerFooter;
  /** Words outside the draft (a save that didn't start, a read that failed); they replace the draft's. */
  message: string | null;
  onDiscard: () => void;
  onPrimary: () => void;
}) {
  const shown = message !== null ? { text: message, tone: "alert" as const } : footer.message;
  return (
    <div
      className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-background px-4 py-3 sm:px-6"
      data-testid="product-drawer-footer"
    >
      {footer.notSaved && (
        <span className="mr-auto text-sm font-medium text-amber-900" data-testid="product-drawer-not-saved">{footer.notSaved}</span>
      )}
      {shown && (
        <span role={shown.tone === "alert" ? "alert" : "status"} className={`text-sm ${shown.tone === "alert" ? "text-amber-900" : "text-zinc-700"}`}>
          {shown.text}
        </span>
      )}
      <Button type="button" variant="outline" size="sm" disabled={footer.discardDisabled} onClick={onDiscard}>{DRAWER_WORDS.discard}</Button>
      <Button type="button" size="sm" disabled={footer.primary.disabled} onClick={onPrimary}>{footer.primary.label}</Button>
    </div>
  );
}

