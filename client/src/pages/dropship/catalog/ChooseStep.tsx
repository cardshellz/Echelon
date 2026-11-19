import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type Ref } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Boxes, Search } from "lucide-react";
import type { SelectionChangePreviewAnswer } from "@shared/dropship/vendor-selection-changes";
import type { DropshipCatalogCategoriesAnswer, DropshipCatalogIdsAnswer } from "@shared/dropship/vendor-catalog-reads";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebounce } from "@/hooks/use-debounce";
import {
  CHOOSE_SEARCH_MAX_LENGTH,
  CHOOSE_SEARCH_PAUSE_MS,
  chooseActionOverLimit,
  chooseAdoptsHead,
  chooseCategoryPurpose,
  chooseCategoryTicks,
  chooseChangesEmpty,
  chooseCounts,
  chooseEverything,
  chooseHeadMovedPast,
  chooseKnownAt,
  chooseMatchGrew,
  chooseMatchLine,
  chooseRoom,
  chooseSavedState,
  describeChooseConfirmButton,
  describeChooseIdsFailure,
  describeChooseShown,
  emptyChooseKnown,
  learnChooseIds,
  learnChooseRows,
  mergeChoosePages,
  reduceChooseChanges,
  shownTick,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseChangesAction,
  type ChooseIdsPurpose,
  type ChooseKnown,
  type ChooseMatchLine,
  type ChooseShownTick,
} from "@/lib/dropship-catalog-choose";
import {
  CHOOSE_CATALOG_QUERY_KEY,
  CHOOSE_EVERYTHING_FILTERS,
  chooseCatalogQueryOptions,
  chooseCategoriesQueryOptions,
  chooseCategoryFilters,
  chooseIdsQueryOptions,
  choosePendingAfter,
  chooseReadErrorData,
  chooseUndoneAfterUnsure,
  describeChooseSaveOutcome,
  describeChooseSaveStatus,
  postChooseChange,
  postChoosePreview,
  runChooseSave,
  type ChooseBarOutcome,
  type ChooseFilters,
  type ChoosePendingSave,
  type ChooseSaveDeps,
  type ChooseSaveStatus,
  type ChooseShow,
} from "@/lib/dropship-catalog-choose-requests";
import { CHOOSE_WORDS } from "@/lib/dropship-catalog-choose-words";
import {
  NEW_ITEMS_NOTICE_LINES_SHOWN,
  endsNewItemsReview,
  newItemsNoticeModel,
  newItemsReviewFilters,
  showsNewItemsOption,
  type NewItemsNoticeLine,
} from "@/lib/dropship-catalog-new-items";
import {
  catalogNewItemsQueryOptions,
  hideAcknowledgedNewItems,
  markNewItemsListsStale,
  postCatalogNewItemsAcknowledge,
  runNewItemsAcknowledge,
} from "@/lib/dropship-catalog-new-items-requests";
import { NEW_ITEMS_WORDS } from "@/lib/dropship-catalog-new-items-words";
import { isOlderCatalogServerError, retryPublishRead } from "@/lib/dropship-catalog-publish";
import { DROPSHIP_SITE_UPDATING_MESSAGE, createDropshipIdempotencyKey, formatStatus } from "@/lib/dropship-ops-surface";
import { CatalogActionBar, type CatalogNextStepAction } from "./CatalogActionBar";
import {
  ChooseCategoryList,
  ChooseChangesBar,
  ChooseMatchLineView,
  ChooseNewItemsNotice,
  ChooseSaveConfirmBody,
  ChooseTable,
  chooseHowId,
  type ChooseBulkNote,
  type ChooseCategoryEntry,
} from "./ChooseTable";
import { useBrowserLeavePrompt } from "./UnsavedChangesGuard";

/**
 * Catalog step 1, "Choose what to sell", on one-time picks (step 1 plan S2-5,
 * PR B; PLAN-B v4.1 §12): the filter card, the list read 200 rows at a time,
 * the table, the new-items notice (B3, §11.4: Review filters the table to a
 * category's new items, Got it hides the line), and the save from "Save
 * changes" to its outcome. The change set
 * lives on the page (`changes`, `onChanges`), so a store switch or a step
 * change never drops it; this step only reads and saves it. Every write goes
 * through `runChooseSave`: the preview, the question with the server's
 * counts, then the save.
 */
export interface ChooseStepProps {
  /** The page's selection summary: the saved count, the head revision and the cap; null while it loads. */
  selection: { selectedTotal: number; cap: number; selectionRevisionId: number | null } | null;
  changes: ChooseChanges;
  onChanges: Dispatch<ChooseChangesAction>;
  /** The bar's Next, as the page builds it (asks first while changes aren't saved). */
  next: CatalogNextStepAction | null;
  /** The bar's saved count ("1 selected"). */
  summary: string;
  /** After the saved selection changed (a save, or another tab's): the page reads the count, the selected rows and onboarding again. */
  onSaved: () => Promise<void>;
  /** While a save runs: the page's leave question asks the vendor to wait, since leaving can't stop it (review MC6). */
  onSavingChange: (saving: boolean) => void;
}

/** The Category menu's "All categories": not a category id (Radix needs a non-empty value). */
const ALL_CATEGORIES = "__all_categories__";

/** No rows yet: one array for every render, so what depends on the rows only changes with them. */
const NO_ROWS: readonly ChooseCatalogRow[] = Object.freeze([]);

/** A note of the "Check all" line, for the filters it was made under (another filter's line says nothing of it). */
interface MatchNote {
  filtersKey: string;
  message: string;
}

/** The composition root's pause (the save's schedules and a "Got it" sent again). */
function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms); });
}

/** The save's network calls, the pause, the clock and the key maker, as the page wires them. */
function chooseSaveDeps(confirm: ChooseSaveDeps["confirm"], onStatus: (status: ChooseSaveStatus) => void): ChooseSaveDeps {
  return {
    preview: (body) => postChoosePreview(body),
    post: (body) => postChooseChange(body),
    confirm,
    sleep: pause,
    // The composition root's clock: only differences are used (the paused window, §12.4).
    now: () => Date.now(),
    newKey: () => createDropshipIdempotencyKey("catalog-selection"),
    onStatus,
  };
}

/** Focus left with a removed or disabled control (after a save, after the last "Load more"): nothing useful has it. */
function focusIsLost(): boolean {
  return typeof document !== "undefined" && (document.activeElement === null || document.activeElement === document.body);
}

export function ChooseStep({ selection, changes, onChanges, next, summary, onSaved, onSavingChange }: ChooseStepProps) {
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const search = useDebounce(searchText.trim().slice(0, CHOOSE_SEARCH_MAX_LENGTH), CHOOSE_SEARCH_PAUSE_MS);
  const [show, setShow] = useState<ChooseShow>("all");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const filters = useMemo<ChooseFilters>(
    () => ({ search, categoryId: category === ALL_CATEGORIES ? null : Number(category), show }),
    [search, category, show],
  );
  const catalog = useInfiniteQuery(chooseCatalogQueryOptions(filters));
  // The categories mount with step 1 only (V26), read once per visit and after each save.
  const categories = useQuery(chooseCategoriesQueryOptions());
  // The new-items notice, step 1 only too (V26): read once per visit, after each save and after each "Got it".
  const newItems = useQuery(catalogNewItemsQueryOptions());
  const [noticeExpanded, setNoticeExpanded] = useState(false);
  const notice = newItemsNoticeModel(newItems.data, noticeExpanded);
  // One "Got it" at a time (the ref blocks a second press before the redraw); the last one that failed, by category.
  const [acknowledging, setAcknowledging] = useState(false);
  const acknowledgingRef = useRef(false);
  const [gotItFailure, setGotItFailure] = useState<{ categoryId: number; message: string } | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  // A notice button went (its line after Got it, Show all after its press): once drawn again, focus goes to the line
  // at this index, or to the search box when the notice is gone.
  const [focusNoticeAt, setFocusNoticeAt] = useState<number | null>(null);
  const merged = useMemo(() => (catalog.data ? mergeChoosePages(catalog.data.pages) : null), [catalog.data]);
  const rows = merged?.rows ?? NO_ROWS;
  const filtersKey = JSON.stringify(filters);
  // The newest changes and filters, for the save's steps after an await (the page re-renders meanwhile).
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // This filter's list failed to read again after the saved choices moved: its rows are older than the picks, so its
  // boxes stay off and it says why until a read of it succeeds (a new `dataUpdatedAt`) (verify V5).
  const [behind, setBehind] = useState<{ filtersKey: string; dataUpdatedAt: number } | null>(null);
  const rowsBehind = behind !== null && behind.filtersKey === filtersKey && behind.dataUpdatedAt === catalog.dataUpdatedAt;
  const [saving, setSaving] = useState(false);
  // Blocks a second press while a save runs; the state above only redraws.
  const savingRef = useRef(false);
  // An id read of "Check all", a category's box or "Select everything" is running: every box and bulk button waits.
  const [idsBusy, setIdsBusy] = useState(false);
  const idsBusyRef = useRef(false);
  // That read is being sent again after an answer from code older than this page: the site-updating line says why
  // everything waits (§12.2; review round 1 CLI-2).
  const [idsSiteUpdating, setIdsSiteUpdating] = useState(false);
  // What the page learned at the saved revision it shows, for the categories' boxes (§12.3): the categories and saved
  // states of the rows it read (across filters) and the complete lists its id reads returned.
  const [learned, setLearned] = useState<ChooseKnown>(() => emptyChooseKnown(null));
  // The header box's last press on a filter (the "Uncheck all" line follows an uncheck), the "Check all" press that
  // found more matching than its button said, the press last applied (its line goes until the next change), and the
  // line's refusal.
  const [headerPress, setHeaderPress] = useState<{ filtersKey: string; checked: boolean } | null>(null);
  const [matchChanged, setMatchChanged] = useState<{ filtersKey: string; purpose: ChooseIdsPurpose; now: number; was: number } | null>(null);
  const [matchApplied, setMatchApplied] = useState<{ filtersKey: string; add: number; remove: number } | null>(null);
  const [matchError, setMatchError] = useState<MatchNote | null>(null);
  // What a category's box or "Select everything" did, or why it did nothing.
  const [categoryNote, setCategoryNote] = useState<ChooseBulkNote | null>(null);
  // A confirmed save kept after an unsure, busy or paused press: the next press of the same changes sends it again.
  const pendingRef = useRef<ChoosePendingSave | null>(null);
  // The changes went while a kept save may have committed, so the saved choices are read again: the revision that save
  // was made on, until the count names a newer head (then the bar says the choices changed) or the vendor changes or
  // saves something (review round 1 CLI-1, TST-2).
  const [undoneCheck, setUndoneCheck] = useState<{ baseRevisionId: number | null } | null>(null);
  // The page's re-read after a move, for this step's unmount (its prop changes identity on every page render).
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const [question, setQuestion] = useState<{ preview: SelectionChangePreviewAnswer; effectsChanged: boolean } | null>(null);
  const answerRef = useRef<((save: boolean) => void) | null>(null);
  const [progress, setProgress] = useState<ChooseSaveStatus | null>(null);
  const [outcome, setOutcome] = useState<ChooseBarOutcome | null>(null);
  // The status line takes focus when a save removes the focused Save button; after "Load more", the first new row's
  // box (or the count line) does (review DUX8).
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const shownRef = useRef<HTMLSpanElement | null>(null);
  const [focusRowAt, setFocusRowAt] = useState<number | null>(null);
  // Set when a save ends; checked once the bar is drawn again (Save is gone after a save, or back on after a refusal).
  const [focusAfterSave, setFocusAfterSave] = useState(false);
  // The question was answered with Save: when it has closed, focus goes to the status line (Radix would leave focus on
  // the page: the question has no trigger).
  const confirmedRef = useRef(false);
  useEffect(() => {
    if (!focusAfterSave) return;
    setFocusAfterSave(false);
    if (focusIsLost()) statusRef.current?.focus();
  }, [focusAfterSave]);
  useEffect(() => {
    if (focusNoticeAt === null) return;
    setFocusNoticeAt(null);
    if (!focusIsLost()) return;
    const lines = noticeRef.current?.querySelectorAll("li") ?? [];
    const line = lines.length > 0 ? lines[Math.min(focusNoticeAt, lines.length - 1)] : null;
    const button = line?.querySelector<HTMLButtonElement>("button") ?? null;
    if (button) button.focus();
    else searchRef.current?.focus();
  }, [focusNoticeAt, notice]);
  // Closing the tab mid-save would lose its answer.
  useBrowserLeavePrompt(saving);
  // Leaving step 1 while the question is open answers it with Cancel, so the save never waits for a gone dialog.
  useEffect(() => () => { answerRef.current?.(false); answerRef.current = null; }, []);
  // Leaving step 1 ("Discard and leave", the rail, a store's Next) while a kept save may have committed: the kept save
  // goes with this step, and nothing here can read again, so the page's count, step 3's list and onboarding are read
  // again now and every list of this step is marked stale for the next visit (review round 1 CLI-1, TST-2). The
  // shown list and the categories are read again on mount anyway (refetchOnMount "always", queryClient.ts).
  useEffect(() => () => {
    if (!pendingRef.current?.mayHaveCommitted) return;
    pendingRef.current = null;
    // Deliberate fire-and-forget: this step is gone, nothing waits for these; invalidateQueries never rejects, and
    // onSaved settles each of its reads (P's afterSelectionSaved).
    void queryClient.invalidateQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY], refetchType: "none" });
    void onSavedRef.current();
  }, [queryClient]);

  // With nothing pending, the changes count from the head revision the page reads now (another tab's save, a save of ours).
  const headRevisionId = selection?.selectionRevisionId ?? null;
  const headRef = useRef(headRevisionId);
  headRef.current = headRevisionId;
  useEffect(() => {
    if (selection !== null && chooseAdoptsHead(changes, headRevisionId)) onChanges({ type: "rebase", revisionId: headRevisionId });
  }, [selection, changes, headRevisionId, onChanges]);

  // Undo, or every box unticked back, while a kept save may have committed: no press of Save can follow, so the saved
  // choices are read again now, as after a save (review round 1 CLI-1, TST-2). The empty set then counts from the head
  // the count brings (the effect above), and the bar says so once that head is newer than the save's base.
  useEffect(() => {
    const kept = pendingRef.current;
    if (!chooseUndoneAfterUnsure(kept, changes)) return;
    pendingRef.current = null;
    setUndoneCheck({ baseRevisionId: kept?.body.expectedRevisionId ?? null });
    // Deliberate fire-and-forget: nothing waits for it (the vendor is not saving); each read that fails keeps its own
    // words on screen (the list's Try again, the count's, the categories'), as after a save.
    void Promise.allSettled([readRowsAfterMove(), onSaved(), categories.refetch(), newItems.refetch()]);
  }, [changes]);
  useEffect(() => {
    if (undoneCheck === null || !chooseHeadMovedPast(undoneCheck.baseRevisionId, headRevisionId)) return;
    setUndoneCheck(null);
    setOutcome({ kind: "info", message: CHOOSE_WORDS.undoneSaveMoved });
  }, [undoneCheck, headRevisionId]);

  // The rows read are remembered across filters until the saved revision moves; the rows on screen count at once.
  useEffect(() => {
    setLearned((previous) => learnChooseRows(chooseKnownAt(previous, headRevisionId), rows));
  }, [rows, headRevisionId]);
  const known = useMemo(() => learnChooseRows(chooseKnownAt(learned, headRevisionId), rows), [learned, headRevisionId, rows]);
  const categoryTicks = useMemo(
    () => chooseCategoryTicks(categories.data?.categories ?? [], changes, known),
    [categories.data, changes, known],
  );

  function setSavingState(value: boolean) {
    savingRef.current = value;
    setSaving(value);
    onSavingChange(value);
  }

  const counts = chooseCounts(changes);
  const hasChanges = !chooseChangesEmpty(changes);
  const room = selection ? chooseRoom(selection, changes) : null;
  const saveOffReason = room?.overCapAdd ? CHOOSE_WORDS.overCapAdd(room.after) : null;
  // The room counts the unsaved changes as the bar does, so its numbers add up to what the boxes show.
  const roomLine = room ? CHOOSE_WORDS.room(room.after, room.room) : null;
  const everything = categories.data && selection ? chooseEverything(categories.data, selection, changes) : null;
  // No change before the count names the head it is made on (§12.1 "head revision when the first change was made";
  // review round 1 CLI-4): Save is off then anyway.
  const bulkLocked = saving || idsBusy || selection === null;
  const locked = bulkLocked || catalog.isPlaceholderData || rowsBehind;
  const header = shownTick(rows, changes);
  const matchLine = merged && !catalog.isPlaceholderData && !rowsBehind ? chooseMatchLine({
    tick: header.tick,
    changeable: header.changeable,
    shown: rows.length,
    total: merged.total,
    lastHeader: headerPress?.filtersKey === filtersKey ? headerPress.checked : null,
    changed: matchChanged?.filtersKey === filtersKey ? matchChanged : null,
    // Counts stand for the changes: a later change (or Undo) moves them and brings the line back.
    applied: matchApplied?.filtersKey === filtersKey && matchApplied.add === counts.add && matchApplied.remove === counts.remove,
  }) : null;

  /**
   * Every change goes through here: one that would hold more ids than one save takes is refused in words, in the bar
   * or, for a bulk press, beside the control (`refused`). True when it was applied.
   */
  function change(action: ChooseChangesAction, refused?: (message: string) => void): boolean {
    const over = chooseActionOverLimit(changesRef.current, action);
    if (over) {
      const message = CHOOSE_WORDS.tooManyMatch(Math.max(over.add, over.remove));
      if (refused) refused(message);
      else setOutcome({ kind: "error", message });
      return false;
    }
    setOutcome(null);
    setUndoneCheck(null);
    onChanges(action);
    return true;
  }

  function toggle(row: ChooseCatalogRow) {
    const saved = chooseSavedState(row);
    if (locked || !saved.changeable) return;
    change({ type: "toggle", productVariantId: row.productVariantId, savedChecked: saved.savedChecked });
  }

  function toggleShown(checked: boolean) {
    if (locked) return;
    setHeaderPress({ filtersKey, checked });
    setMatchChanged(null);
    setMatchError(null);
    change({ type: "setShown", rows: rows.map(chooseSavedState), checked });
  }

  function undo() {
    if (savingRef.current) return;
    setCategoryNote(null);
    setMatchError(null);
    change({ type: "undo" });
  }

  /**
   * One id read for a bulk press (§12.3), retried like every step 1 read (V11); one at a time, never during a save.
   * Its lists teach the page their sizes' categories (`learnChooseIds`). Resolves with the answer, or with the error
   * once the read gave up; undefined when it could not start.
   */
  async function readIds(filters: ChooseFilters, purpose: ChooseIdsPurpose): Promise<{ answer: DropshipCatalogIdsAnswer } | { error: unknown } | undefined> {
    if (savingRef.current || idsBusyRef.current) return undefined;
    idsBusyRef.current = true;
    setIdsBusy(true);
    try {
      const options = chooseIdsQueryOptions(filters, purpose);
      const answer = await queryClient.fetchQuery({
        ...options,
        // The same retry rule, saying while it waits whether the answer came from code older than this page.
        retry: (failureCount: number, error: unknown) => {
          setIdsSiteUpdating(isOlderCatalogServerError(error));
          return retryPublishRead(failureCount, error);
        },
      });
      const scope = { categoryId: filters.categoryId, whole: filters.search === "" && filters.show === "all" };
      setLearned((previous) => learnChooseIds(chooseKnownAt(previous, headRef.current), scope, answer));
      return { answer };
    } catch (error) {
      // Deliberate: the caller says why in words (too many at once, or the read failed), and nothing changed.
      return { error };
    } finally {
      idsBusyRef.current = false;
      setIdsBusy(false);
      setIdsSiteUpdating(false);
    }
  }

  /** The `applyIds` change of an id answer: checked adds the not-selected ids, unchecked removes the selected ones. */
  function applyIdsAction(answer: DropshipCatalogIdsAnswer, purpose: ChooseIdsPurpose): ChooseChangesAction {
    return { type: "applyIds", selectedIds: answer.selectedIds, notSelectedIds: answer.notSelectedIds, checked: purpose === "add" };
  }

  /** "Check all N that match" / "Uncheck all N that match": the ids of the table's filters, as one change. */
  async function pressMatch(line: ChooseMatchLine) {
    const shownFilters = filtersRef.current;
    const key = JSON.stringify(shownFilters);
    setMatchError(null);
    const read = await readIds(shownFilters, line.purpose);
    if (read === undefined) return;
    if ("error" in read) {
      setMatchError({ filtersKey: key, message: describeChooseIdsFailure(read.error, line.total) });
      return;
    }
    // More match than the button said: never check or uncheck more than the vendor was told; ask again (§12.3).
    if (chooseMatchGrew(read.answer.total, line.total)) {
      setMatchChanged({ filtersKey: key, purpose: line.purpose, now: read.answer.total, was: line.total });
      return;
    }
    const action = applyIdsAction(read.answer, line.purpose);
    const next = reduceChooseChanges(changesRef.current, action);
    if (!change(action, (message) => setMatchError({ filtersKey: key, message }))) return;
    setMatchChanged(null);
    setMatchApplied({ filtersKey: key, add: next.add.size, remove: next.remove.size });
  }

  /** A category's box: the whole category's ids (only its id, D26), added when it is not ticked, removed when it is. */
  async function pressCategory(category: ChooseCategoryEntry, tick: ChooseShownTick) {
    const purpose = chooseCategoryPurpose(tick);
    const name = formatStatus(category.name);
    setCategoryNote(null);
    const read = await readIds(chooseCategoryFilters(category.categoryId), purpose);
    if (read === undefined) return;
    if ("error" in read) {
      setCategoryNote({ kind: "error", message: describeChooseIdsFailure(read.error, category.rowCount) });
      return;
    }
    const refuse = (message: string) => setCategoryNote({ kind: "error", message });
    if (!change(applyIdsAction(read.answer, purpose), refuse)) return;
    // The box shows what changed; the words say how many, and that later items are not added. Nothing to say for 0.
    const n = purpose === "add" ? (read.answer.notSelectedIds ?? []).length : (read.answer.selectedIds ?? []).length;
    if (n > 0) setCategoryNote({ kind: "info", message: purpose === "add" ? CHOOSE_WORDS.tickAdds(n, name) : CHOOSE_WORDS.tickRemoves(n, name) });
  }

  /** "Select everything": every changeable id Card Shellz offers, no filter (D27). */
  async function pressEverything() {
    if (!everything || everything.disabled) return;
    setCategoryNote(null);
    const read = await readIds(CHOOSE_EVERYTHING_FILTERS, "add");
    if (read === undefined) return;
    if ("error" in read) {
      setCategoryNote({ kind: "error", message: describeChooseIdsFailure(read.error, everything.offered) });
      return;
    }
    if (!change(applyIdsAction(read.answer, "add"), (message) => setCategoryNote({ kind: "error", message }))) return;
    const n = (read.answer.notSelectedIds ?? []).length;
    if (n > 0) setCategoryNote({ kind: "info", message: CHOOSE_WORDS.everythingAdds(n) });
  }

  /** [Review]: the table shows only the line's category's new items (Show "New from Card Shellz"); nothing is added. */
  function reviewNewItems(line: NewItemsNoticeLine) {
    const review = newItemsReviewFilters(line.categoryId);
    setSearchText(review.search);
    setCategory(String(review.categoryId));
    setShow(review.show);
  }

  /**
   * [Got it] (§11.4): sent, and sent again while the answer says "try again" (the server decides by state). Taken:
   * the line goes at once, the notice is read again, and a review of that category ends (Show "All"). An arrival id
   * past the newest: the notice is read again. Failed: the line stays and says so; the button works again.
   */
  async function acknowledgeNewItems(line: NewItemsNoticeLine, index: number) {
    if (acknowledgingRef.current) return;
    acknowledgingRef.current = true;
    setAcknowledging(true);
    setGotItFailure(null);
    try {
      const outcome = await runNewItemsAcknowledge({ send: (body) => postCatalogNewItemsAcknowledge(body), sleep: pause }, line);
      if (outcome.kind === "failed") {
        setGotItFailure({ categoryId: line.categoryId, message: outcome.message });
        return;
      }
      if (outcome.kind === "acknowledged") {
        await hideAcknowledgedNewItems(queryClient, outcome.answer);
        const reviewEnds = endsNewItemsReview(filtersRef.current, line.categoryId);
        // Deliberate fire-and-forget: every cached "new" list is marked stale, and the shown one read again unless the
        // review ends (UIT-1); invalidateQueries never rejects, and a failed read shows its own error with Try again.
        void markNewItemsListsStale(queryClient, { reviewEnds });
        if (reviewEnds) setShow("all");
        setFocusNoticeAt(index);
      }
      // Deliberate fire-and-forget: a failed re-read keeps its own error and retries by itself; the line taken off above
      // stays off, and the other lines stay as the last answer said.
      void newItems.refetch();
    } finally {
      acknowledgingRef.current = false;
      setAcknowledging(false);
    }
  }

  /** [Show all]: every category's line; focus goes to the first line that was hidden. */
  function showAllNewItems() {
    setNoticeExpanded(true);
    setFocusNoticeAt(NEW_ITEMS_NOTICE_LINES_SHOWN);
  }

  /** The save question: resolved by Save (true), or by Cancel, Escape or leaving the step (false). */
  function ask(preview: SelectionChangePreviewAnswer, context: { effectsChanged: boolean }): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      answerRef.current = resolve;
      setQuestion({ preview, effectsChanged: context.effectsChanged });
    });
  }

  function answer(save: boolean) {
    const resolve = answerRef.current;
    answerRef.current = null;
    setQuestion(null);
    resolve?.(save);
  }

  /**
   * After the saved choices moved (a save, another tab's): every other filter's rows were read under the old picks and
   * would be shown from the cache as they were, so they are dropped and read afresh when shown. This filter's rows are
   * read again: every loaded page. When that read fails, the rows on screen are older than the picks, so their boxes
   * stay off and the list says why until a read succeeds (verify V5).
   */
  async function readRowsAfterMove(): Promise<void> {
    queryClient.removeQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY], type: "inactive" });
    const shownFilters = filtersRef.current;
    const reloaded = await catalog.refetch();
    if (reloaded.isSuccess) return;
    setBehind({ filtersKey: JSON.stringify(shownFilters), dataUpdatedAt: reloaded.dataUpdatedAt });
    // Deliberate fire-and-forget: marks this filter stale (no read now; refetchType "none" resolves at once), so coming
    // back to it after another filter reads it again. The failure itself is on screen with Try again.
    void queryClient.invalidateQueries({ queryKey: chooseCatalogQueryOptions(shownFilters).queryKey, exact: true, refetchType: "none" });
  }

  async function save() {
    if (savingRef.current || idsBusyRef.current || !hasChanges || room === null || room.overCapAdd) return;
    setSavingState(true);
    setOutcome(null);
    setUndoneCheck(null);
    setProgress(null);
    setCategoryNote(null);
    setMatchError(null);
    try {
      const result = await runChooseSave(chooseSaveDeps(ask, setProgress), { changes: changesRef.current, pending: pendingRef.current });
      pendingRef.current = choosePendingAfter(result, pendingRef.current);
      if (result.kind === "saved" || result.kind === "stale") {
        // The saved selection moved either way: the rows, the count, the categories and the new-items notice (a picked
        // item is no longer new) are read again (§12.4 step 4, §11.4).
        await Promise.allSettled([readRowsAfterMove(), onSaved(), categories.refetch(), newItems.refetch()]);
        // The changes clear once the rows were read again, so an added row doesn't flash unchecked, and count from the
        // save's own revision: the count is read again without waiting (P's afterSelectionSaved), so a change made
        // before it lands is on the revision the server just named, never a false `stale` (review round 1 CLI-4). A
        // newer head is adopted when the count brings one (the effect above, forward only). A stale press keeps the
        // changes, counted from the head the server named (§12.4: reload, keep, new key).
        if (result.kind === "saved") {
          onChanges({ type: "saved" });
          onChanges({ type: "rebase", revisionId: result.answer.revisionId });
        } else if (result.headRevisionId !== undefined) onChanges({ type: "rebase", revisionId: result.headRevisionId });
        // The "Check all" line followed a header press made on the old rows: it goes with them.
        setHeaderPress(null);
        setMatchChanged(null);
        setMatchApplied(null);
      }
      setOutcome(describeChooseSaveOutcome(result));
    } catch {
      // Deliberate: runChooseSave throws only on a programming error (no changes, or a body its schema refuses),
      // before anything is sent, so a kept save stays as it was. The vendor is told, and the changes stay on screen.
      setOutcome({ kind: "error", message: CHOOSE_WORDS.rejected });
    } finally {
      answerRef.current = null;
      setQuestion(null);
      setProgress(null);
      setSavingState(false);
      // Save went off while saving (and is gone with the changes after a save), so keyboard focus can fall to the
      // page: once the bar is drawn again it goes to the line that says what happened (review DUX8).
      setFocusAfterSave(true);
    }
  }

  /**
   * "Load more". The button is off while the page loads (and gone after the last one), so keyboard focus falls to the
   * page: once the new rows are drawn, it moves to the first new row's box (review DUX8).
   *
   * Whether focus was lost is checked once the new rows are drawn, not when the read returns: a fast answer can come
   * back before the button was ever drawn off, so it still has focus at that moment and only loses it when the last
   * page's render removes it (seen in CI on J5).
   */
  async function loadMore() {
    const before = rows.length;
    await catalog.fetchNextPage();
    setFocusRowAt(before);
  }
  useEffect(() => {
    if (focusRowAt === null || !merged) return;
    // The new page is not drawn yet: this runs again when it is (or when the read ends without it).
    if (merged.rows.length <= focusRowAt && catalog.isFetchingNextPage) return;
    setFocusRowAt(null);
    if (!focusIsLost()) return;
    const firstNew = merged.rows[focusRowAt];
    const box = firstNew
      ? document.querySelector<HTMLInputElement>(`input[aria-describedby~="${chooseHowId(firstNew.productVariantId)}"]`)
      : null;
    if (box && !box.disabled) box.focus();
    else shownRef.current?.focus();
  }, [focusRowAt, merged, catalog.isFetchingNextPage]);

  const filtered = search !== "" || category !== ALL_CATEGORIES || show !== "all";
  const catalogError = catalog.error;
  // The rows (or a bulk press's ids) are read again after an answer from code older than this page (V11, §12.2): say
  // so while it retries; an older catalog server's 503 for a newer page counts too (review round 1 CLI-2).
  const siteUpdating = (catalog.isFetching && catalog.failureCount > 0 && isOlderCatalogServerError(catalog.failureReason)) || idsSiteUpdating;
  return (
    <>
      {/* Between the step's intro and the filters (§12.3, B3): nothing is added until the vendor checks and saves. */}
      {notice && (
        <ChooseNewItemsNotice
          model={notice}
          acknowledging={acknowledging}
          failure={gotItFailure}
          reviewingCategoryId={filters.show === "new" ? filters.categoryId : null}
          onReview={reviewNewItems}
          onGotIt={(line) => { void acknowledgeNewItems(line, notice.lines.indexOf(line)); }}
          onShowAll={showAllNewItems}
          noticeRef={noticeRef}
        />
      )}

      <CatalogFilterPanel
        searchRef={searchRef}
        search={searchText}
        onSearchChange={setSearchText}
        show={show}
        onShowChange={setShow}
        category={category}
        categories={categories.data}
        onCategoryChange={setCategory}
      />

      {/* The categories card sits left of the table from `lg`, and above it on a phone (§12.3). */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-start">
        <ChooseCategoryList
          categories={categories.data}
          failed={categories.isError && categories.data === undefined && !categories.isFetching}
          ticks={categoryTicks}
          activeCategoryId={filters.categoryId}
          locked={bulkLocked}
          everything={everything}
          roomLine={roomLine}
          note={categoryNote}
          onTick={(entry, tick) => { void pressCategory(entry, tick); }}
          onShowOnly={(categoryId) => setCategory(String(categoryId))}
          onSelectEverything={() => { void pressEverything(); }}
          onRetry={() => { void categories.refetch(); }}
        />

        <section className="min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white" data-testid="catalog-choose-card">
          <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{CHOOSE_WORDS.heading}</h2>
              <p className="mt-1 text-sm text-zinc-500">{CHOOSE_WORDS.intro}</p>
            </div>
            <Badge variant="outline" className="w-fit shrink-0 border-violet-200 bg-violet-50 text-violet-800">
              {selection === null ? CHOOSE_WORDS.loadingSelection : CHOOSE_WORDS.selectedBadge(selection.selectedTotal)}
            </Badge>
          </div>

          {room?.overCapState && (
            // The saved selection is over the cap: removing is always allowed; publishing refuses until it is under (§12.3).
            <p className="border-b border-zinc-200 bg-amber-50 px-4 py-3 text-sm text-amber-900" data-testid="catalog-choose-over-cap">
              {CHOOSE_WORDS.overCapState(room.selected)}
            </p>
          )}

          {siteUpdating && (
            <p role="status" className="border-b border-zinc-200 bg-sky-50 px-4 py-3 text-sm text-sky-900" data-testid="catalog-choose-updating">
              {DROPSHIP_SITE_UPDATING_MESSAGE}
            </p>
          )}

          {catalog.isPending ? (
            <div className="space-y-2 p-4" data-testid="catalog-choose-loading">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : !merged ? (
            <Empty className="p-8" data-testid="catalog-choose-failed" {...chooseReadErrorData(catalogError)}>
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>{CHOOSE_WORDS.catalogFailedTitle}</EmptyTitle>
                <EmptyDescription>{CHOOSE_WORDS.catalogFailedText}</EmptyDescription>
              </EmptyHeader>
              <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={() => { void catalog.refetch(); }}>
                {CHOOSE_WORDS.tryAgain}
              </Button>
            </Empty>
          ) : merged.rows.length === 0 ? (
            <Empty className="p-8" data-testid="catalog-choose-empty">
              <EmptyMedia variant="icon"><Boxes /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>{filtered ? CHOOSE_WORDS.emptyFilteredTitle : CHOOSE_WORDS.emptyTitle}</EmptyTitle>
                <EmptyDescription>{filtered ? CHOOSE_WORDS.emptyFilteredText : CHOOSE_WORDS.emptyText}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 text-sm text-zinc-600">
                <span data-testid="catalog-choose-shown" tabIndex={-1} ref={shownRef}>{describeChooseShown(merged, catalog.hasNextPage)}</span>
              </div>
              {matchLine && (
                <ChooseMatchLineView
                  line={matchLine}
                  locked={bulkLocked}
                  error={matchError?.filtersKey === filtersKey ? matchError.message : null}
                  onPress={() => { void pressMatch(matchLine); }}
                />
              )}
              {show !== "all" && hasChanges && (
                // The server lists what is saved, so checks the vendor just made move rows only after Save (review DUX1).
                <p className="border-b border-zinc-200 bg-amber-50 px-4 py-2 text-sm text-amber-900" data-testid="catalog-choose-saved-note">
                  {CHOOSE_WORDS.showSavedNote}
                </p>
              )}
              {(catalog.isRefetchError || rowsBehind) && (
                <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-red-50 px-4 py-3 text-sm text-red-900"
                  data-testid="catalog-choose-refetch-failed" {...chooseReadErrorData(catalogError)}>
                  <span>{rowsBehind ? CHOOSE_WORDS.listBehindSave : CHOOSE_WORDS.catalogFailedText}</span>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9" onClick={() => { void catalog.refetch(); }}>
                    {CHOOSE_WORDS.tryAgain}
                  </Button>
                </div>
              )}
              <ChooseTable
                rows={merged.rows}
                changes={changes}
                locked={locked}
                dimmed={catalog.isPlaceholderData}
                onToggle={toggle}
                onToggleShown={toggleShown}
              />
              {catalog.hasNextPage && !catalog.isPlaceholderData && (
                <div className="flex flex-wrap items-center justify-center gap-3 border-t border-zinc-200 px-4 py-3 text-sm">
                  {catalog.isFetchNextPageError && <span role="alert" className="text-red-800">{CHOOSE_WORDS.loadMoreFailed}</span>}
                  <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={catalog.isFetchingNextPage || saving}
                    onClick={() => { void loadMore(); }}>
                    {catalog.isFetchingNextPage ? CHOOSE_WORDS.loadingMore : catalog.isFetchNextPageError ? CHOOSE_WORDS.tryAgain : CHOOSE_WORDS.loadMore}
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      <CatalogActionBar summary={summary} next={next}>
        <ChooseChangesBar
          add={counts.add}
          remove={counts.remove}
          hasChanges={hasChanges}
          saving={saving}
          // Off while a bulk press reads its ids: the change it brings is not in the set yet.
          saveOff={room === null || room.overCapAdd || idsBusy}
          saveOffReason={saveOffReason}
          outcome={outcome}
          progress={describeChooseSaveStatus(progress)}
          onSave={() => { void save(); }}
          onUndo={undo}
          statusRef={statusRef}
        />
      </CatalogActionBar>

      <AlertDialog open={question !== null} onOpenChange={(open) => { if (!open) answer(false); }}>
        <AlertDialogContent data-testid="catalog-choose-confirm-dialog" onCloseAutoFocus={(event) => {
          if (!confirmedRef.current) return;
          confirmedRef.current = false;
          event.preventDefault();
          statusRef.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{CHOOSE_WORDS.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>{question && <ChooseSaveConfirmBody preview={question.preview} effectsChanged={question.effectsChanged} />}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{CHOOSE_WORDS.confirmCancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { confirmedRef.current = true; answer(true); }}>
              {question ? describeChooseConfirmButton(question.preview) : CHOOSE_WORDS.confirmSave}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Search, Show and Category, applied as the vendor goes (search after a short pause). Changing them never changes what is selected. */
function CatalogFilterPanel({ searchRef, search, onSearchChange, show, onShowChange, category, categories, onCategoryChange }: {
  /** The search box, where focus goes when the new-items notice it was in is gone. */
  searchRef: Ref<HTMLInputElement>;
  search: string;
  onSearchChange: (value: string) => void;
  show: ChooseShow;
  onShowChange: (value: ChooseShow) => void;
  category: string;
  /** The categories read (V40), keyed by id; undefined while it loads. */
  categories: DropshipCatalogCategoriesAnswer | undefined;
  onCategoryChange: (value: string) => void;
}) {
  const searchId = useId();
  const options = (categories?.categories ?? []).map((entry) => ({
    value: String(entry.categoryId),
    label: CHOOSE_WORDS.categoryOption(entry.name, entry.rowCount),
  }));
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4" data-testid="catalog-choose-filters">
      <h2 className="text-lg font-semibold">{CHOOSE_WORDS.filtersHeading}</h2>
      <p className="mt-1 text-sm text-zinc-500">{CHOOSE_WORDS.filtersLine}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="sm:col-span-2">
          <Label htmlFor={searchId}>{CHOOSE_WORDS.searchLabel}</Label>
          <div className="relative mt-2">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <Input
              ref={searchRef}
              id={searchId}
              type="search"
              value={search}
              maxLength={CHOOSE_SEARCH_MAX_LENGTH}
              onChange={(event) => onSearchChange(event.target.value)}
              className="h-11 pl-9 sm:h-10"
              placeholder={CHOOSE_WORDS.searchPlaceholder}
            />
          </div>
        </div>
        <FilterSelect
          label={CHOOSE_WORDS.showLabel}
          value={show}
          onValueChange={(value) => onShowChange(value === "selected" || value === "not_selected" || value === "new" ? value : "all")}
          options={[
            { value: "all", label: CHOOSE_WORDS.showAll },
            { value: "selected", label: CHOOSE_WORDS.showSelected },
            { value: "not_selected", label: CHOOSE_WORDS.showNotSelected },
            // Only while reviewing the new-items notice (§12.3): Review is the way in.
            ...(showsNewItemsOption(show) ? [{ value: "new", label: NEW_ITEMS_WORDS.showNew }] : []),
          ]}
          testId="catalog-choose-show"
        />
        <FilterSelect
          label={CHOOSE_WORDS.categoryLabel}
          value={category}
          onValueChange={onCategoryChange}
          options={[{ value: ALL_CATEGORIES, label: CHOOSE_WORDS.categoryAll }, ...options]}
          testId="catalog-choose-category"
        />
      </div>
    </section>
  );
}

function FilterSelect({ label, onValueChange, options, testId, value }: {
  label: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  testId: string;
  value: string;
}) {
  const labelId = useId();
  return (
    <div>
      <Label id={labelId}>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger className="mt-2 h-11 sm:h-10" aria-labelledby={labelId} data-testid={testId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
