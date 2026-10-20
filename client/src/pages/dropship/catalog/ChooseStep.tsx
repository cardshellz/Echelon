import { useEffect, useId, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertCircle, Boxes, Search } from "lucide-react";
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
  chooseCounts,
  chooseRulesView,
  chooseSaveBlock,
  chooseSaveResult,
  describeChooseMove,
  describeChooseSaveBlock,
  describeChooseShown,
  mergeChoosePages,
  reduceChooseChanges,
  type ChooseBarOutcome,
  type ChooseCatalogRow,
  type ChooseCategoryFacet,
  type ChooseChanges,
  type ChooseChangesAction,
} from "@/lib/dropship-catalog-choose";
import {
  CHOOSE_CATALOG_QUERY_KEY,
  ChooseReadError,
  chooseCatalogQueryOptions,
  chooseReadErrorData,
  freshSelectionRulesReader,
  putChooseSelectionRules,
  runChooseSave,
  selectionRulesQueryOptions,
  type ChooseFilters,
  type ChoosePendingSave,
  type ChooseSaveDeps,
} from "@/lib/dropship-catalog-choose-requests";
import { CHOOSE_WORDS } from "@/lib/dropship-catalog-choose-words";
import { createDropshipIdempotencyKey, formatStatus } from "@/lib/dropship-ops-surface";
import { CatalogActionBar, type CatalogNextStepAction } from "./CatalogActionBar";
import { ChooseChangesBar, ChooseSaveConfirmBody, ChooseTable, chooseHowId } from "./ChooseTable";
import { useBrowserLeavePrompt } from "./UnsavedChangesGuard";

/**
 * Catalog step 1, "Choose what to sell" (step 1 stage 1, "The checkbox is the
 * choice"): the filter card, the list read 200 rows at a time, the table, and
 * the save from "Save changes" to its outcome. The change set lives on the
 * page (`changes`, `onChanges`), so a store switch or a step change never
 * drops it; this step only reads and saves it. Every write goes through
 * `runChooseSave`.
 */
export interface ChooseStepProps {
  /** The saved selected count (the page's "selected" read); null while it loads. */
  selectedCount: number | null;
  changes: ChooseChanges;
  onChanges: Dispatch<ChooseChangesAction>;
  /**
   * A save sent with no sure answer: the next press sends the same key and body (or finds it went through). Held by
   * the page beside the changes, so leaving step 1 never drops it; the page checks it before forgetting it (review MC1).
   */
  pendingRef: MutableRefObject<ChoosePendingSave | null>;
  /** What the page's check behind Undo or "Discard and leave" found (review MC1); shown in the bar. */
  notice: string | null;
  /** The bar's Next, as the page builds it (asks first while changes aren't saved). */
  next: CatalogNextStepAction | null;
  /** The bar's saved count ("1 selected"). */
  summary: string;
  /** After the saved selection changed (a save, or another tab's): the page reads the rules, the selected rows and onboarding again. */
  onSaved: () => Promise<void>;
  /** While a save runs: the page's leave question asks the vendor to wait, since leaving can't stop it (review MC6). */
  onSavingChange: (saving: boolean) => void;
}

type ChooseShow = "all" | "selected";
/** The Category menu's "All categories": not a category name the catalog can hold (Radix needs a non-empty value). */
const ALL_CATEGORIES = "__all_categories__";

/** The save's network calls, the pause and the key maker, as the page wires them. */
function chooseSaveDeps(queryClient: QueryClient): ChooseSaveDeps {
  return {
    readRules: freshSelectionRulesReader(queryClient),
    putRules: (body) => putChooseSelectionRules(body),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    newKey: () => createDropshipIdempotencyKey("catalog-selection"),
  };
}

/** Focus left with a removed or disabled control (after a save, after the last "Load more"): nothing useful has it. */
function focusIsLost(): boolean {
  return typeof document !== "undefined" && (document.activeElement === null || document.activeElement === document.body);
}

export function ChooseStep({ selectedCount, changes, onChanges, pendingRef, notice, next, summary, onSaved, onSavingChange }: ChooseStepProps) {
  const queryClient = useQueryClient();
  // The saved rules, read again whenever step 1 shows, as the rows are (the app reads every query again on mount), so
  // the rows and the rules map come from the same time (review MC8). The same query the page's rail tick reads.
  const rules = useQuery({ ...selectionRulesQueryOptions(), refetchOnMount: "always" });
  const [searchText, setSearchText] = useState("");
  const search = useDebounce(searchText.trim().slice(0, CHOOSE_SEARCH_MAX_LENGTH), CHOOSE_SEARCH_PAUSE_MS);
  const [show, setShow] = useState<ChooseShow>("all");
  const [category, setCategory] = useState(ALL_CATEGORIES);
  const filters = useMemo<ChooseFilters>(
    () => ({ search, category: category === ALL_CATEGORIES ? null : category, selectedOnly: show === "selected" }),
    [search, category, show],
  );
  const catalog = useInfiniteQuery(chooseCatalogQueryOptions(filters));
  const merged = useMemo(() => (catalog.data ? mergeChoosePages(catalog.data.pages) : null), [catalog.data]);
  // The newest changes and filters, for the save's steps after an await (the page re-renders meanwhile).
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // This filter's list failed to read again after the saved choices moved: its rows are older than the rules, so its
  // boxes stay off and it says why until a read of it succeeds (a new `dataUpdatedAt`) (verify V5).
  const [behind, setBehind] = useState<{ filtersKey: string; dataUpdatedAt: number } | null>(null);
  const rowsBehind = behind !== null && behind.filtersKey === JSON.stringify(filters) && behind.dataUpdatedAt === catalog.dataUpdatedAt;
  const rulesView = useMemo(() => (rules.data ? chooseRulesView(rules.data.rules) : null), [rules.data]);
  const [saving, setSaving] = useState(false);
  // Blocks a second confirm while a save runs; the state above only redraws.
  const savingRef = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [outcome, setOutcome] = useState<ChooseBarOutcome | null>(null);
  // The status line takes focus when a save removes the focused Save button; after "Load more", the first new row's
  // box (or the count line) does (review DUX8).
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const shownRef = useRef<HTMLSpanElement | null>(null);
  const [focusRowAt, setFocusRowAt] = useState<number | null>(null);
  // Set when a save ends; checked once the bar is drawn again (Save is gone after a save, or back on after a refusal).
  const [focusAfterSave, setFocusAfterSave] = useState(false);
  // The question was answered with Save: when it has closed, focus goes to the status line, since Save is off while the
  // save runs and gone after it (Radix would leave focus on the page: the question has no trigger).
  const confirmedRef = useRef(false);
  useEffect(() => {
    if (!focusAfterSave) return;
    setFocusAfterSave(false);
    if (focusIsLost()) statusRef.current?.focus();
  }, [focusAfterSave]);
  // Closing the tab mid-save would lose its answer.
  useBrowserLeavePrompt(saving);

  // Rows read again: a mark the reload settled is dropped, the others take the row's new basis.
  useEffect(() => {
    if (merged) onChanges({ type: "reconcile", rows: merged.rows, rules: rulesView });
  }, [merged, rulesView, onChanges]);

  function setSavingState(value: boolean) {
    savingRef.current = value;
    setSaving(value);
    onSavingChange(value);
  }

  const counts = chooseCounts(changes);
  const hasChanges = changes.marks.length > 0;
  const block = useMemo(
    () => (rules.data && changes.marks.length > 0 ? chooseSaveBlock(rules.data.rules, changes.marks) : null),
    [rules.data, changes.marks],
  );
  const rulesMissing = rulesView === null;
  const saveOffReason = block ? describeChooseSaveBlock(block) : rulesMissing && rules.isError ? CHOOSE_WORDS.rulesFailed : null;
  const rows = merged?.rows ?? [];
  const locked = saving || catalog.isPlaceholderData || rulesMissing || rowsBehind;

  function change(action: ChooseChangesAction) {
    setOutcome(null);
    onChanges(action);
  }

  function toggle(row: ChooseCatalogRow) {
    if (locked || !rulesView) return;
    change({ type: "toggle", row, rules: rulesView });
  }

  function toggleShown(checked: boolean) {
    if (locked || !rulesView) return;
    change({ type: "setShown", rows, checked, rules: rulesView });
  }

  // An unconfirmed attempt is not dropped here: the page checks the rules first when the changes empty (review MC1).
  function undo() {
    if (savingRef.current) return;
    change({ type: "undo" });
  }

  function askToSave() {
    if (savingRef.current || !hasChanges || block !== null || rulesMissing) return;
    setConfirmOpen(true);
  }

  /**
   * After the saved choices moved (a save, an earlier save found, another tab's): every other filter's rows were read
   * under the old rules and would be shown from the cache as they were (nothing marks them stale), so they are dropped
   * and read afresh when shown (the rows on screen stay as locked placeholders meanwhile). This filter's rows are read
   * again: every loaded page. Null when that read failed: the rows on screen are then older than the rules, so their
   * boxes stay off and the list says why until a read succeeds (verify V5).
   */
  async function readRowsAfterMove(): Promise<readonly ChooseCatalogRow[] | null> {
    queryClient.removeQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY], type: "inactive" });
    const shownFilters = filtersRef.current;
    const reloaded = await catalog.refetch();
    if (reloaded.isSuccess) return mergeChoosePages(reloaded.data.pages).rows;
    setBehind({ filtersKey: JSON.stringify(shownFilters), dataUpdatedAt: reloaded.dataUpdatedAt });
    // Deliberate fire-and-forget: marks this filter stale (no read now; refetchType "none" resolves at once), so coming
    // back to it after another filter reads it again. The failure itself is on screen with Try again.
    void queryClient.invalidateQueries({ queryKey: chooseCatalogQueryOptions(shownFilters).queryKey, exact: true, refetchType: "none" });
    return null;
  }

  async function save() {
    if (savingRef.current) return;
    setSavingState(true);
    setOutcome(null);
    // The marks this save sends: the saved line counts which of them took once the rows read again (review MC4).
    const sent = changes.marks;
    try {
      const result = await runChooseSave(chooseSaveDeps(queryClient), {
        marks: sent,
        baseFingerprint: changes.baseFingerprint,
        pending: pendingRef.current,
      });
      // Kept for the next press while the outcome is open; a block sent nothing, so an earlier attempt stays as it was.
      if (result.kind === "notSaved" || result.kind === "unconfirmed") pendingRef.current = result.pending;
      else if (result.kind !== "blocked") pendingRef.current = null;
      if (result.kind === "saved") {
        // The marks clear once the rows were read again, so an added row doesn't flash unchecked; when that read
        // fails, the rows on screen stay locked and say so (verify V5).
        const [reloaded] = await Promise.allSettled([readRowsAfterMove(), onSaved()]);
        const rowsAfter = reloaded.status === "fulfilled" ? reloaded.value : null;
        onChanges({ type: "saved" });
        setOutcome({ kind: "saved", ...chooseSaveResult(sent, rowsAfter) });
      } else if (result.kind === "committedEarlier" || result.kind === "stale") {
        // The saved selection moved either way, so the page reads it again too (review MC7). The runner's read already
        // put the newest rules in the cache; the rows are read again under them.
        const [reloaded] = await Promise.allSettled([readRowsAfterMove(), onSaved()]);
        const rowsAfter = reloaded.status === "fulfilled" ? reloaded.value : null;
        const latest = queryClient.getQueryData(selectionRulesQueryOptions().queryKey);
        let marksLeft = changesRef.current.marks.length;
        if (latest) {
          const rebase: ChooseChangesAction = {
            type: "rebase",
            rows: rowsAfter ?? rows,
            rules: chooseRulesView(latest.rules),
            // The marks the earlier save sent are saved, loaded or not (review MC3).
            ...(result.kind === "committedEarlier" ? { committedMarksKey: result.marksKey } : {}),
          };
          // The page holds the changes; the same pure reducer says what this rebase leaves (verify V1).
          marksLeft = reduceChooseChanges(changesRef.current, rebase).marks.length;
          onChanges(rebase);
        }
        setOutcome(describeChooseMove(result.kind, marksLeft, sent, rowsAfter));
      } else if (result.kind === "blocked") {
        setOutcome({ kind: "error", message: describeChooseSaveBlock(result.block) });
      } else if (result.kind === "rejected") {
        setOutcome({ kind: "error", message: result.message });
      } else if (result.kind === "unconfirmed") {
        setOutcome({ kind: "error", message: CHOOSE_WORDS.unconfirmed });
      } else {
        setOutcome({ kind: "error", message: result.busyMessage ?? CHOOSE_WORDS.notSaved });
      }
    } catch {
      // Deliberate: runChooseSave throws only on a programming error (no marks, or a rule it can't build), before
      // anything is sent, so an earlier attempt stays as it was. The vendor is told, and the marks stay on screen.
      setOutcome({ kind: "error", message: CHOOSE_WORDS.rejected });
    } finally {
      setSavingState(false);
      // Save went off while saving (and is gone with the marks after a save), so keyboard focus can fall to the page:
      // once the bar is drawn again it goes to the line that says what happened (review DUX8).
      setFocusAfterSave(true);
    }
  }

  /**
   * "Load more". The button is off while the page loads (and gone after the last one), so keyboard focus falls to the
   * page: once the new rows are drawn, it moves to the first new row's box (review DUX8).
   */
  async function loadMore() {
    const before = rows.length;
    await catalog.fetchNextPage();
    if (focusIsLost()) setFocusRowAt(before);
  }
  useEffect(() => {
    if (focusRowAt === null || !merged) return;
    setFocusRowAt(null);
    if (!focusIsLost()) return;
    const firstNew = merged.rows[focusRowAt];
    const box = firstNew
      ? document.querySelector<HTMLInputElement>(`input[aria-describedby~="${chooseHowId(firstNew.productVariantId)}"]`)
      : null;
    if (box && !box.disabled) box.focus();
    else shownRef.current?.focus();
  }, [focusRowAt, merged]);

  const filtered = search !== "" || category !== ALL_CATEGORIES || show === "selected";
  const catalogError = catalog.error;
  // The page's check behind Undo, "Discard and leave" or a reload that settled the changes is newer than any outcome
  // still held here (the page clears it when a save starts or a change is made), so it speaks first (verify V8).
  const barOutcome: ChooseBarOutcome | null = notice ? { kind: "error", message: notice } : outcome;
  return (
    <>
      <CatalogFilterPanel
        search={searchText}
        onSearchChange={setSearchText}
        show={show}
        onShowChange={setShow}
        category={category}
        categoryOptions={merged?.categories ?? []}
        onCategoryChange={setCategory}
      />

      <section className="mt-5 overflow-hidden rounded-md border border-zinc-200 bg-white" data-testid="catalog-choose-card">
        <div className="flex flex-col gap-3 border-b border-zinc-200 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{CHOOSE_WORDS.heading}</h2>
            <p className="mt-1 text-sm text-zinc-500">{CHOOSE_WORDS.intro}</p>
          </div>
          <Badge variant="outline" className="w-fit shrink-0 border-violet-200 bg-violet-50 text-violet-800">
            {selectedCount === null ? CHOOSE_WORDS.loadingSelection : CHOOSE_WORDS.selectedBadge(selectedCount)}
          </Badge>
        </div>

        {rulesMissing && rules.isError && (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-red-50 px-4 py-3 text-sm text-red-900"
            data-testid="catalog-choose-rules-failed" {...chooseReadErrorData(rules.error)}>
            <span>{rules.error instanceof ChooseReadError ? CHOOSE_WORDS.rulesUnreadable : CHOOSE_WORDS.rulesFailed}</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9" onClick={() => { void rules.refetch(); }}>
              {CHOOSE_WORDS.tryAgain}
            </Button>
          </div>
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
              <EmptyDescription>{catalogError instanceof ChooseReadError ? CHOOSE_WORDS.catalogUnreadable : CHOOSE_WORDS.catalogFailedText}</EmptyDescription>
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
            {show === "selected" && hasChanges && (
              // The server lists what is saved, so checks the vendor just made move rows only after Save (review DUX1).
              <p className="border-b border-zinc-200 bg-amber-50 px-4 py-2 text-sm text-amber-900" data-testid="catalog-choose-saved-note">
                {CHOOSE_WORDS.showSavedNote}
              </p>
            )}
            {(catalog.isRefetchError || rowsBehind) && (
              <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-red-50 px-4 py-3 text-sm text-red-900"
                data-testid="catalog-choose-refetch-failed" {...chooseReadErrorData(catalogError)}>
                <span>{rowsBehind ? CHOOSE_WORDS.listBehindSave
                  : catalogError instanceof ChooseReadError ? CHOOSE_WORDS.catalogUnreadable : CHOOSE_WORDS.catalogFailedText}</span>
                <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9" onClick={() => { void catalog.refetch(); }}>
                  {CHOOSE_WORDS.tryAgain}
                </Button>
              </div>
            )}
            <ChooseTable
              rows={merged.rows}
              changes={changes}
              rulesById={rulesView?.byId ?? null}
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

      <CatalogActionBar summary={summary} next={next}>
        <ChooseChangesBar
          add={counts.add}
          remove={counts.remove}
          hasChanges={hasChanges}
          saving={saving}
          saveOff={block !== null || rulesMissing}
          saveOffReason={saveOffReason}
          outcome={barOutcome}
          onSave={askToSave}
          onUndo={undo}
          statusRef={statusRef}
        />
      </CatalogActionBar>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent data-testid="catalog-choose-confirm-dialog" onCloseAutoFocus={(event) => {
          if (!confirmedRef.current) return;
          confirmedRef.current = false;
          event.preventDefault();
          statusRef.current?.focus();
        }}>
          <AlertDialogHeader>
            <AlertDialogTitle>{CHOOSE_WORDS.confirmTitle}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div><ChooseSaveConfirmBody add={counts.add} remove={counts.remove} /></div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{CHOOSE_WORDS.confirmCancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { confirmedRef.current = true; void save(); }}>{CHOOSE_WORDS.confirmSave}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Search, Show and Category, applied as the vendor goes (search after a short pause). Changing them never changes what is selected. */
function CatalogFilterPanel({ search, onSearchChange, show, onShowChange, category, categoryOptions, onCategoryChange }: {
  search: string;
  onSearchChange: (value: string) => void;
  show: ChooseShow;
  onShowChange: (value: ChooseShow) => void;
  category: string;
  categoryOptions: readonly ChooseCategoryFacet[];
  onCategoryChange: (value: string) => void;
}) {
  const searchId = useId();
  // The facets apply search, so a typed search can drop the chosen category from the list; it stays offered.
  const options = categoryOptions.some((option) => option.category === category) || category === ALL_CATEGORIES
    ? categoryOptions.map((option) => ({ value: option.category, label: CHOOSE_WORDS.categoryOption(option.label, option.rowCount) }))
    : [{ value: category, label: formatStatus(category) },
      ...categoryOptions.map((option) => ({ value: option.category, label: CHOOSE_WORDS.categoryOption(option.label, option.rowCount) }))];
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
          onValueChange={(value) => onShowChange(value === "selected" ? "selected" : "all")}
          options={[{ value: "all", label: CHOOSE_WORDS.showAll }, { value: "selected", label: CHOOSE_WORDS.showSelected }]}
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
