import { useEffect, useRef, useState } from "react";
import { EbayStoreCategoryCombobox } from "@/components/dropship/EbayStoreCategoryCombobox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ConnectionBanner, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import { STORE_DEFAULT_LABELS, isDraftDirty, isDraftLocked, type ListingSettingsDraft } from "@/lib/dropship-listing-settings-drafts";
import {
  STORE_DEFAULT_EDITOR_WORDS,
  planFromSignature,
  planStoreShelfDefaultSave,
  shelfDraftFromSetup,
  shelfDraftProblem,
  shelfIdsFromDraft,
  shelfPathWords,
  shelfPickerOptions,
  type ShelfDraftValue,
  type StoreSetupSaveCallbacks,
} from "@/lib/dropship-listing-settings-store-requests";
import { CHECKING_EBAY, rightReasonLine, storeShelfValue } from "@/lib/dropship-listing-settings-words";
import type { DropshipEbayListingSetupResponse, DropshipEbayStoreCategoryResponse } from "@/lib/dropship-ops-surface";
import { NotSavedBadge } from "../catalog/UnsavedChangesGuard";
import { EditorSurface } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import {
  SavedRowStatus,
  StoreSetupEditorFooter,
  StoreSetupSaveNotice,
  liveSetup,
  readFailed,
  reasonLineFor,
  shouldRebase,
  useStoreSetupSave,
  type ListingSetupRead,
} from "./PolicyDefaultRow";
import { StoreDefaultRow } from "./StoreDefaultRow";

/** The vendor's eBay store shelves (`GET /api/dropship/ebay/store-categories/:id`, the page's read). */
export interface StoreShelvesRead {
  data?: Pick<DropshipEbayStoreCategoryResponse, "categories">;
  error?: unknown;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
}

export interface ShelfDefaultRowProps {
  setup: ListingSetupRead;
  shelves: StoreShelvesRead;
  /** `rights.shelfPick`: picking a shelf needs eBay's live shelf list. */
  rightPick: ListingSettingsRight;
  /** `rights.shelfNone`: "None" needs no eBay read, only the setup revision (C1). */
  rightNone: ListingSettingsRight;
  onSaved: () => void;
  saveCallbacks: StoreSetupSaveCallbacks;
  onBlocked?: (banner: ConnectionBanner | null) => void;
  compact?: boolean;
}

const FIELD = "shelf";

/** The saved default with its names in the record's words ("Supplies › Toploaders"). */
function namedShelfDefault(setup: DropshipEbayListingSetupResponse) {
  const saved = setup.storeShelfDefault;
  if (saved === undefined || saved === null) return saved;
  return { ids: saved.ids, names: saved.names.map(shelfPathWords) };
}

function shelfValue(value: ListingSettingsDraft["value"]): ShelfDraftValue {
  const text = (field: unknown) => (typeof field === "string" && field.length > 0 ? field : null);
  return { first: text(value.first), second: text(value.second) };
}

/**
 * The Store shelf store default (R:581) and its editor: a first and an
 * optional second shelf, picked independently, or None. Saves the shelf
 * default alone through W2 (`buildStoreShelfDefaultSave`). "None" works while
 * eBay needs a sign-in (R:500), because it reads nothing from eBay.
 */
export function ShelfDefaultRow({ setup, shelves, rightPick, rightNone, onSaved, saveCallbacks, onBlocked, compact }: ShelfDefaultRowProps) {
  const label = STORE_DEFAULT_LABELS[FIELD];
  const drafts = useListingSettingsDrafts();
  const { edit, rebase } = drafts;
  const wide = useMinWidth(SM_MIN_WIDTH_PX);
  const changeRef = useRef<HTMLButtonElement>(null);
  const draft = drafts.draft?.editor === FIELD ? drafts.draft : null;
  const save = useStoreSetupSave({ setup, saveCallbacks, onSaved, onBlocked });
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [reloadingView, setReloadingView] = useState(false);

  const live = liveSetup(setup);
  const liveShelves = shelves.data !== undefined && !readFailed(shelves.error) ? shelves.data.categories : null;
  const savedIds = live?.storeShelfDefault?.ids ?? [];
  const value = live
    ? storeShelfValue(namedShelfDefault(live), liveShelves) ?? STORE_DEFAULT_EDITOR_WORDS.none
    : readFailed(setup.error) ? STORE_DEFAULT_EDITOR_WORDS.shelfUnknown : CHECKING_EBAY;
  // Nothing to pick and nothing to clear: the row only says shelves are optional (R:514).
  const noShelves = liveShelves !== null && liveShelves.length === 0 && live !== null && savedIds.length === 0;
  const editable = !noShelves && live !== null && (rightPick.editable || (rightNone.editable && savedIds.length > 0));

  const latestShelves = live ? shelfDraftFromSetup(live) : null;
  const latestFirst = latestShelves?.first;
  const latestSecond = latestShelves?.second;
  useEffect(() => {
    const latestValue = latestFirst === undefined || latestSecond === undefined ? null : { first: latestFirst, second: latestSecond };
    if (shouldRebase(draft, latestValue) && latestValue) rebase(latestValue);
  }, [draft, latestFirst, latestSecond, rebase]);

  const openEditor = () => {
    if (!editable || live === null) return;
    drafts.open(FIELD, label, shelfDraftFromSetup(live));
  };

  const picked = draft ? shelfValue(draft.value) : null;
  const problem = picked ? shelfDraftProblem(picked) : null;
  const savesNone = picked !== null && picked.first === null && picked.second === null;
  const allowed = savesNone ? rightNone.editable : rightPick.editable;
  const canSave = draft !== null && draft.open && picked !== null && isDraftDirty(draft) && !isDraftLocked(draft)
    && problem === null && allowed && live !== null && !setup.isFetching && saveCallbacks.disabled !== true;

  const onSave = () => {
    if (!canSave || live === null || picked === null) return;
    const plan = save.prepare(() => planStoreShelfDefaultSave(live, shelfIdsFromDraft(picked)));
    if (plan) void save.run(plan);
  };
  const onCheckAgain = () => {
    const attempt = draft?.attempt;
    if (draft?.phase !== "uncertain" || !attempt) return;
    const plan = save.prepare(() => planFromSignature(attempt.signature));
    if (plan) void save.run(plan);
  };
  const onLoadLatest = async () => {
    setLoadingLatest(true);
    try {
      const result = await setup.refetch();
      if (result.data !== undefined && !readFailed(result.error)) rebase(shelfDraftFromSetup(result.data));
    } finally {
      setLoadingLatest(false);
    }
  };
  const onReloadView = async () => {
    setReloadingView(true);
    try {
      const result = await setup.refetch();
      if (result.data !== undefined && !readFailed(result.error)) drafts.discard();
    } finally {
      setReloadingView(false);
    }
  };
  const onCheckEbayAgain = () => {
    void shelves.refetch();
    void setup.refetch();
  };

  const status = draft && (draft.phase === "saved" || draft.phase === "saved_view_stale")
    ? <SavedRowStatus draft={draft} flashVisible={drafts.savedFlashVisible} onReload={() => void onReloadView()} reloading={reloadingView} />
    : noShelves ? STORE_DEFAULT_EDITOR_WORDS.noShelves : null;
  const reason = noShelves || editable ? null : reasonLineFor(rightPick, value);

  return (
    <StoreDefaultRow
      field={FIELD}
      value={value}
      status={status}
      editable={editable}
      reason={reason}
      notSaved={isDraftDirty(draft)}
      onChange={openEditor}
      compact={compact ?? !wide}
      changeRef={changeRef}
    >
      <EditorSurface
        open={draft?.open === true}
        title={label}
        notSaved={isDraftDirty(draft)}
        onClose={drafts.requestClose}
        returnFocusTo={changeRef}
        description={STORE_DEFAULT_EDITOR_WORDS.shelfIntro}
        footer={(
          <StoreSetupEditorFooter
            draft={draft}
            canSave={canSave}
            onCancel={() => {
              save.clearProblem();
              drafts.discard();
            }}
            onSave={onSave}
            onCheckAgain={onCheckAgain}
            checkAgainDisabled={saveCallbacks.disabled === true}
          />
        )}
      >
        <ShelfEditorBody
          draft={draft}
          picked={picked ?? { first: null, second: null }}
          problem={problem}
          live={live}
          liveShelves={liveShelves}
          rightPick={rightPick}
          rightNone={rightNone}
          checking={shelves.isFetching || setup.isFetching}
          onChange={(next) => edit(next)}
          onCheckEbayAgain={onCheckEbayAgain}
        />
        <StoreSetupSaveNotice draft={draft} problem={save.problem} onLoadLatest={() => void onLoadLatest()} loadingLatest={loadingLatest} />
      </EditorSurface>
    </StoreDefaultRow>
  );
}

function ShelfEditorBody({
  draft,
  picked,
  problem,
  live,
  liveShelves,
  rightPick,
  rightNone,
  checking,
  onChange,
  onCheckEbayAgain,
}: {
  draft: ListingSettingsDraft | null;
  picked: ShelfDraftValue;
  problem: string | null;
  live: DropshipEbayListingSetupResponse | null;
  liveShelves: DropshipEbayStoreCategoryResponse["categories"] | null;
  rightPick: ListingSettingsRight;
  rightNone: ListingSettingsRight;
  checking: boolean;
  onChange: (next: ShelfDraftValue) => void;
  onCheckEbayAgain: () => void;
}) {
  const locked = isDraftLocked(draft);
  const canPick = rightPick.editable && liveShelves !== null && !locked;
  const options = shelfPickerOptions(liveShelves, live?.storeShelfDefault ?? null);
  const changed = (field: "first" | "second") => draft !== null && draft.base[field] !== draft.value[field];
  const marked = (field: "first" | "second") => draft?.marked.includes(field) === true;
  const pickReason = rightPick.editable ? null : rightReasonLine(rightPick.reason);
  const anyPicked = picked.first !== null || picked.second !== null;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <FieldLabel text={STORE_DEFAULT_EDITOR_WORDS.shelf} changed={changed("first")} marked={marked("first")} />
          <EbayStoreCategoryCombobox
            ariaLabel={STORE_DEFAULT_EDITOR_WORDS.shelf}
            categories={options}
            value={picked.first}
            placeholder={STORE_DEFAULT_EDITOR_WORDS.none}
            clearLabel={STORE_DEFAULT_EDITOR_WORDS.none}
            searchPlaceholder={STORE_DEFAULT_EDITOR_WORDS.shelfSearch}
            emptyMessage={STORE_DEFAULT_EDITOR_WORDS.shelfSearchEmpty}
            hideIds
            disabled={!canPick}
            // The two pickers are independent: changing the first never changes the second (R:581).
            onValueChange={(first) => onChange({ ...picked, first })}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <FieldLabel text={STORE_DEFAULT_EDITOR_WORDS.secondShelf} changed={changed("second")} marked={marked("second")} />
          <EbayStoreCategoryCombobox
            ariaLabel={STORE_DEFAULT_EDITOR_WORDS.secondShelf}
            categories={options}
            value={picked.second}
            placeholder={STORE_DEFAULT_EDITOR_WORDS.none}
            clearLabel={STORE_DEFAULT_EDITOR_WORDS.none}
            searchPlaceholder={STORE_DEFAULT_EDITOR_WORDS.shelfSearch}
            emptyMessage={STORE_DEFAULT_EDITOR_WORDS.shelfSearchEmpty}
            hideIds
            // Off until a first shelf is picked, unless a second one is left to clear.
            disabled={!canPick || (picked.first === null && picked.second === null)}
            onValueChange={(second) => onChange({ ...picked, second })}
          />
          {picked.first === null && <p className="text-xs text-zinc-600">{STORE_DEFAULT_EDITOR_WORDS.pickFirstShelfFirst}</p>}
        </div>
      </div>
      <p className="text-xs text-zinc-600">{STORE_DEFAULT_EDITOR_WORDS.shelvesIndependent}</p>
      {problem === STORE_DEFAULT_EDITOR_WORDS.sameShelfTwice && <p role="alert" className="text-sm text-rose-800">{problem}</p>}
      {pickReason && <p className="text-sm text-zinc-600">{pickReason}</p>}
      {!rightPick.editable && rightNone.editable && anyPicked && (
        <Button type="button" variant="outline" size="sm" disabled={locked} onClick={() => onChange({ first: null, second: null })}>
          {STORE_DEFAULT_EDITOR_WORDS.setShelfToNone}
        </Button>
      )}
      <div className="flex flex-wrap gap-2">
        <EbayChoiceRefresh checking={checking} disabled={locked} onCheckAgain={onCheckEbayAgain} />
      </div>
    </div>
  );
}

/** Shelves are made in eBay too, so [Open eBay Seller Hub ↗] would point at the wrong page: only [Check eBay again]. */
function EbayChoiceRefresh({ checking, disabled, onCheckAgain }: { checking: boolean; disabled: boolean; onCheckAgain: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" disabled={checking || disabled} onClick={onCheckAgain}>
      {checking ? STORE_DEFAULT_EDITOR_WORDS.checkingEbay : STORE_DEFAULT_EDITOR_WORDS.checkEbayAgain}
    </Button>
  );
}

function FieldLabel({ text, changed, marked }: { text: string; changed: boolean; marked: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label>{text}</Label>
      {changed && <NotSavedBadge />}
      {marked && <span className="text-xs font-medium text-amber-900">{STORE_DEFAULT_EDITOR_WORDS.changedElsewhereToo}</span>}
    </div>
  );
}
