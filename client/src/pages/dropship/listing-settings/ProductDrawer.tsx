import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, X } from "lucide-react";
import type { ListingPriceSetting } from "@shared/dropship/listing-price";
import type { ListingSettingsProductDetail, ListingSettingsSizePrice } from "@shared/dropship/listing-settings";
import type { PricingRecipe } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { listingPriceEndpoint, type ListingPriceIdentity } from "@/lib/dropship-listing-price";
import { listingSettingsProductQueryOptions, listingSettingsQueryKey } from "@/lib/dropship-listing-settings";
import type { ListingSettingsEditRights, ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  productEditorId,
  type EditorId,
} from "@/lib/dropship-listing-settings-drafts";
import {
  clearOutcome,
  decideSizeEdit,
  DRAWER_WORDS,
  drawerCategoryLine,
  drawerFooter,
  drawerOwnSettingsLine,
  drawerPhoneSummary,
  drawerReadProblem,
  drawerSettingRows,
  drawerSizeEditState,
  drawerSizeLine,
  drawerSizeList,
  drawerStartsWithAllSizes,
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
  type DrawerFooter,
  type DrawerTarget,
  type SizePriceSaveCallbacks,
} from "@/lib/dropship-listing-settings-drawer";
import { rightReasonLine, type PolicySetupFacts } from "@/lib/dropship-listing-settings-words";
import { putJson } from "@/lib/dropship-ops-surface";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import { DrawerPriceSection } from "./DrawerPriceSection";
import { DrawerSettingRow } from "./DrawerSettingRow";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";

/** How the vendor closed the drawer: × / Esc / ← with nothing to lose, or "Discard and leave". */
export type ProductDrawerCloseReason = "dismissed" | "discarded";

export interface ProductDrawerProps {
  storeConnectionId: number;
  storeName: string;
  /** What the address opens (`drawerTargetFromSearch`); null keeps the drawer closed. */
  target: DrawerTarget | null;
  /** The step's edit rights (plan 4.3); the drawer changes exact prices only (`exactPrice`, W9). */
  rights: Pick<ListingSettingsEditRights, "exactPrice">;
  /** The live eBay setup read, for policy names (A4). */
  setup: ListingSettingsReadState<PolicySetupFacts>;
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
 * exact price per Save through W9, and every other row is read-only with
 * where its value comes from (R:968).
 *
 * × or Esc with a change asks first (plan 4.6). Browser Back takes
 * `?product=` off the address, which closes the drawer and keeps its draft;
 * the bar still says "Not saved · 1 change in <Product>".
 */
export function ProductDrawer(props: ProductDrawerProps) {
  const { target, storeConnectionId, onClose } = props;
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
}

type FieldError = { productVariantId: number; message: string } | null;

function ProductDrawerBody(props: ProductDrawerBodyProps) {
  const { storeConnectionId, productId, targetVariantId, compact, rights } = props;
  const queryClient = useQueryClient();
  const drafts = useListingSettingsDrafts();
  const editor: EditorId = productEditorId(productId);
  const detailQuery = useQuery(listingSettingsProductQueryOptions(storeConnectionId, productId));
  const detail = detailQuery.data ?? null;

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

  async function save() {
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

  function discard() {
    setFieldError(null);
    setFooterMessage(null);
    drafts.discard();
  }

  const pendingClear = own !== null && changedId !== null && own.value.exact.trim() === "" ? clearOutcome(w9) : null;
  const footer = drawerFooter({
    draft: own?.draft ?? null,
    editable,
    busy: props.saveCallbacks.disabled === true || reading,
    clear: pendingClear,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
  });

  const problem = detail === null && detailQuery.isError ? drawerReadProblem(detailQuery.error, props.storeName) : null;
  const title = detail?.product.productName ?? (own?.draft.place || DRAWER_WORDS.untitled);

  return (
    <>
      <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 sm:px-6">
        {compact && <CloseButton phone onClick={props.onDismiss} />}
        <div className="min-w-0 flex-1 space-y-1">
          <SheetTitle className="break-words text-base font-semibold text-zinc-900">{title}</SheetTitle>
          {detail && (
            <>
              <p className="text-sm text-zinc-700">{compact ? drawerPhoneSummary(detail.product) : drawerCategoryLine(detail.product)}</p>
              <p className="text-sm text-zinc-600">{drawerOwnSettingsLine(detail.product)}</p>
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
          />
        )}
      </div>

      {detail && (
        <DrawerFooterBar
          footer={footer}
          message={footerMessage}
          onDiscard={discard}
          onPrimary={() => {
            if (footer.primary.action === "save" || footer.primary.action === "resend") void save();
            else if (footer.primary.action === "load_latest") void loadLatest();
            else if (footer.primary.action === "reload") void reload();
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

function DrawerContent({ detail, props, editor, own, inEditId, w9, showAll, onShowAll, sizeSearch, onSizeSearch, fieldError, onEdit, onFocusSize, inputRef }: {
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
  const rows = drawerSettingRows(detail, props.setup);
  const withSize = (productVariantId: number, run: (price: ListingSettingsSizePrice) => void) => {
    const price = sizesById.get(productVariantId);
    if (price) run(price);
  };

  return (
    <>
      <DrawerPriceSection
        head={priceHeadWords(props.summaryRecipe)}
        reason={reason}
        waitingHint={changedId !== null && detail.sizes.length > 1 ? DRAWER_WORDS.oneSizeAtATime : null}
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
        {rows.map((row) => <DrawerSettingRow key={row.key} row={row} />)}
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

