import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  bulkSavedFor,
  bulkSettingRows,
  bulkSheetOpen,
  bulkSheetState,
  bulkStoreShelfFieldEditor,
  emptyBulkChoices,
  readBulkDraft,
  type BulkDraftValue,
  type BulkOpenedOn,
  type BulkPicks,
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
  LISTING_SETTINGS_GUARD_ID_PREFIX,
  type WriteFailure,
} from "@/lib/dropship-listing-settings-drafts";
import {
  DRAWER_WORDS,
  isPolicyRowEdit,
  shownFieldEditor,
  type DrawerEditTarget,
  type DrawerSettingRowModel,
} from "@/lib/dropship-listing-settings-drawer";
import type { DescriptionEditField } from "@/lib/dropship-listing-settings-product-edit";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import { idsRequestFor, pickSelected, type ListingSettingsSelection } from "@/lib/dropship-listing-settings-selection";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_BULK_WORDS } from "@/lib/dropship-listing-settings-words";
import { postJson, type DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import { DrawerDescriptionEditor } from "./DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor } from "./DrawerFieldEditor";
import { DrawerSettingRow } from "./DrawerSettingRow";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { CloseButton, DrawerFooterBar, PRODUCT_DRAWER_CLASS } from "./ProductDrawer";
import { useReportListTooLarge } from "./ProductsTab";

export interface BulkSettingsSheetProps {
  storeConnectionId: number;
  /** The page address opens it (`?sheet=bulk`, D21), something is ticked, and no other surface is open (D20). */
  open: boolean;
  /** The ticks the sheet is for; its ids read is made from them when it opens (D6). */
  selection: ListingSettingsSelection;
  /** W6's right, and the rights a row picks a new eBay value with (D3, D4). */
  rights: BulkSettingsRights;
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

  const [openField, setOpenField] = useState<OpenField>(null);
  // The last refused save, with the rows it named (the draft keeps its words only).
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const [footerMessage, setFooterMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const changeButtons = useRef(new Map<DrawerEditTarget, HTMLButtonElement>());
  const rowElements = useRef(new Map<DrawerEditTarget, HTMLElement>());
  const saving = useRef(false);
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
    // [Change] waits for the draft and for a save out or unconfirmed, so neither is reached from an open editor.
    if (action.kind !== "edit") return;
    drafts.edit(action.value);
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
    const decision = bulkDiscard(drafts.draft);
    if (decision.kind === "reset") drafts.edit(decision.value);
    else if (decision.kind === "reread" && ownValue !== null) void loadLatest(bulkDraftValue(ownValue.products));
  }

  // The rows, and the one row editor that shows: it closes when its row can no longer be changed (D3).
  const rowsFor = (target: DrawerEditTarget | null) => bulkSettingRows({
    draft: drafts.draft, rights, openTarget: target, failure, setup: props.setup, shelves: props.shelves,
  });
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
    busy: props.saveCallbacks.disabled === true || reading,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    // An open row editor holds a pick that isn't in the draft yet: [Done] or [Cancel] first, so Save never drops it.
    fieldEditorOpen: shownField !== null,
    failure,
  });

  // Esc (plan 3.4): closes the open row editor first; a save that is out or unconfirmed keeps the sheet open.
  useEffect(() => {
    props.escapeRef.current = () => {
      if (shownField !== null) {
        closeFieldEditor();
        return true;
      }
      return sheet.escapeKeepsOpen;
    };
    return () => { props.escapeRef.current = null; };
  });

  const choices = ownValue ?? emptyBulkChoices();
  const selected = LISTING_SETTINGS_BULK_WORDS.selectedProducts;
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
          const action = sheet.footer.primary.action;
          if (action === "save" || action === "resend") void save();
          else if (action === "load_latest") void loadLatest();
          else if (action === "reload") void reload();
        }}
      />
    </>
  );
}
