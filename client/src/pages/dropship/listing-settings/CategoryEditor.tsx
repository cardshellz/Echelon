import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CategoryClearField } from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsCategoryDetail, ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
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
  categoryStoreShelfFieldEditor,
  ownCategoryDraft,
  readCategoryDraft,
  type CategoryClearBox,
  type CategoryEditAction,
  type CategoryEditorRow,
  type CategoryPicks,
  type CategoryPriceRow,
  type CategorySettingsRights,
} from "@/lib/dropship-listing-settings-categories";
import {
  categorySettingsEndpoint,
  loadLatestCategory,
  reloadAfterCategorySave,
  rereadAfterCategorySave,
  rereadCategoryCard,
  rereadCategoryDetail,
  runCategorySettingsSave,
} from "@/lib/dropship-listing-settings-category-requests";
import { categoryEditorId, LISTING_SETTINGS_GUARD_ID_PREFIX, isDraftDirty, type WriteFailure } from "@/lib/dropship-listing-settings-drafts";
import { DRAWER_WORDS, isPolicyRowEdit, shownFieldEditor, type DrawerEditTarget } from "@/lib/dropship-listing-settings-drawer";
import type { ProductSettingsSaveCallbacks } from "@/lib/dropship-listing-settings-product-requests";
import type { PolicySetupFacts } from "@/lib/dropship-listing-settings-store-requests";
import { LISTING_SETTINGS_CATEGORY_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "@/lib/dropship-listing-settings-words";
import { putJson, type DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";
import { useLeaveGuard } from "../catalog/UnsavedChangesGuard";
import { DrawerDescriptionEditor } from "./DrawerDescriptionEditor";
import { DrawerEbayCategoryEditor, DrawerFieldEditor, DrawerShelfEditor } from "./DrawerFieldEditor";
import { DrawerSettingRow } from "./DrawerSettingRow";
import type { FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { CloseButton, DrawerFooterBar, PRODUCT_DRAWER_CLASS } from "./ProductDrawer";
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
 * "Use store default" (D17), the Price row read-only until the category price
 * check (10f, UX-m9), and "Also clear theirs" under a field whose products
 * hold their own value (8.4). Save sends one W12 request from the detail read
 * the editor opened on (D6); the footer reads "● Not saved · 2 changes"
 * [Discard] [Save].
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
    openTarget: openField?.target ?? null,
    failure,
    busy: props.saveCallbacks.disabled === true || reading,
    savedFlashVisible: drafts.savedFlashVisible,
    compact,
    fieldEditorOpen: openField !== null,
  });
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

  // Esc (plan 3.4): closes the open field editor first; a save that is out or unconfirmed keeps the editor open.
  useEffect(() => {
    props.escapeRef.current = () => {
      if (shownField !== null) {
        closeFieldEditor();
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

  /** "Also clear theirs" ticked or unticked (8.4): one field of the draft; focus stays on the box. */
  function tick(field: CategoryClearField, ticked: boolean) {
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
      drafts.rebase(next.latest, next.marked);
    } catch {
      // Deliberate: the draft keeps the conflict and its Load latest; the words say the read failed.
      if (mounted.current) setFooterMessage(DRAWER_WORDS.latestFailed);
    } finally {
      if (mounted.current) setReading(false);
    }
  }

  /** [Reload] after "Saved. We couldn't load the latest view." (reads only, D9). */
  async function reload() {
    if (reading) return;
    setReading(true);
    setFooterMessage(null);
    try {
      await reloadAfterCategorySave(queryClient, storeConnectionId, categoryId, latestDraft.current);
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

  const shelves = props.shelves ?? null;
  const facts = state.own;
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
            {state.price && <CategoryPriceRowItem price={state.price} />}
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
            const action = state.footer.primary.action;
            if (action === "save" || action === "resend") void save();
            else if (action === "load_latest") void loadLatest();
            else if (action === "reload") void reload();
          }}
        />
      )}
    </>
  );
}

/** The Price row, read-only until the category price check (10f, UX-m9): the category's own recipe, else the store's, and why there is no [Change]. */
function CategoryPriceRowItem({ price }: { price: CategoryPriceRow }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4" data-testid="category-price-row">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{price.label}</h4>
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="break-words text-zinc-900">{price.value}</span>
          {price.tag !== null && <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">{price.tag}</span>}
        </p>
        <p className="text-xs text-zinc-600">{price.line}</p>
      </div>
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
export function ClearTheirsBox({ box, onTick }: { box: CategoryClearBox; onTick: (field: CategoryClearField, ticked: boolean) => void }) {
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
