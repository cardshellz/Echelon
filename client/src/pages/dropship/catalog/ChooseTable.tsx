import { useId, type Ref } from "react";
import { TickBox } from "@/components/dropship/TickBox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DropshipCatalogCategoriesAnswer } from "@shared/dropship/vendor-catalog-reads";
import type { SelectionChangePreviewAnswer } from "@shared/dropship/vendor-selection-changes";
import {
  chooseRowView,
  describeChooseConfirm,
  shownTick,
  type ChooseCatalogRow,
  type ChooseCategoryTick,
  type ChooseChanges,
  type ChooseEverything,
  type ChooseMatchLine,
  type ChooseRowView,
  type ChooseShownTick,
} from "@/lib/dropship-catalog-choose";
import type { ChooseBarOutcome } from "@/lib/dropship-catalog-choose-requests";
import { CHOOSE_WORDS, describeCatalogListingTier, formatChooseCount } from "@/lib/dropship-catalog-choose-words";
import type { NewItemsNoticeLine, NewItemsNoticeModel } from "@/lib/dropship-catalog-new-items";
import { NEW_ITEMS_WORDS } from "@/lib/dropship-catalog-new-items-words";
import { formatStatus } from "@/lib/dropship-ops-surface";
import { cn } from "@/lib/utils";
import { reloadPageWithoutLeavePrompt } from "./UnsavedChangesGuard";

/**
 * Catalog step 1's table, bar line and save question (step 1 stage 1; one-time
 * picks since PR B, PLAN-B v4.1 §12), with PR B's categories card and "Check
 * all N that match" line (§12.3) and new-items notice (§11.4). Stateless: the
 * change set, the reads and the save live in ChooseStep and the page. Never
 * renders a product line (owner Q2).
 */

/** The box's cell: the whole cell is its label, so the target is 44 px on a phone (36 px from `sm`). */
const BOX_LABEL_CLASS = "flex min-h-11 min-w-11 cursor-pointer items-center justify-center sm:min-h-9 sm:min-w-9";

/** The id of a row's How words, which its box names as its description. */
export function chooseHowId(productVariantId: number): string {
  return `catalog-choose-how-${productVariantId}`;
}

/** The id of a row's hint (what the vendor can do), which its box names after the How words. */
export function chooseHintId(productVariantId: number): string {
  return `catalog-choose-hint-${productVariantId}`;
}

/** What the vendor can do with a row in this state, or null (review DUX6). */
function chooseHint(view: ChooseRowView): string | null {
  // Turned off, with the vendor's own pick saved: the box removes the pick (verify V6).
  if (view.how === "turnedOff" && view.pickTurnedOff) return CHOOSE_WORDS.turnedOffPickHint;
  return null;
}

export interface ChooseTableProps {
  rows: readonly ChooseCatalogRow[];
  changes: Pick<ChooseChanges, "add" | "remove">;
  /** Every box off: a save is running, or the rows are an older filter's, kept on screen while the new ones load. */
  locked: boolean;
  /** The rows are an older filter's (dimmed). */
  dimmed: boolean;
  onToggle: (row: ChooseCatalogRow) => void;
  /** The header box: true checks every changeable row shown, false unchecks them. */
  onToggleShown: (checked: boolean) => void;
}

export function ChooseTable({ rows, changes, locked, dimmed, onToggle, onToggleShown }: ChooseTableProps) {
  const header = shownTick(rows, changes);
  const headerOff = locked || header.changeable === 0;
  return (
    <div className={cn(dimmed && "opacity-60")} data-testid="catalog-choose-table">
      <Table>
        <caption className="sr-only">{CHOOSE_WORDS.tableCaption}</caption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-12 p-0" data-testid="catalog-choose-select-shown">
              <label className={BOX_LABEL_CLASS}>
                <TickBox
                  label={CHOOSE_WORDS.selectAllShown}
                  checked={header.tick === "all"}
                  indeterminate={header.tick === "some"}
                  disabled={headerOff}
                  onChange={() => onToggleShown(header.tick !== "all")}
                />
              </label>
            </TableHead>
            <TableHead>{CHOOSE_WORDS.columns.item}</TableHead>
            <TableHead className="hidden sm:table-cell">{CHOOSE_WORDS.columns.category}</TableHead>
            <TableHead className="hidden sm:table-cell">{CHOOSE_WORDS.columns.available}</TableHead>
            <TableHead className="hidden sm:table-cell">{CHOOSE_WORDS.columns.how}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const view = chooseRowView(row, changes);
            return <ChooseTableRow key={row.productVariantId} row={row} view={view} locked={locked} onToggle={onToggle} />;
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function ChooseTableRow({ row, view, locked, onToggle }: {
  row: ChooseCatalogRow;
  view: ChooseRowView;
  locked: boolean;
  onToggle: (row: ChooseCatalogRow) => void;
}) {
  const howId = chooseHowId(row.productVariantId);
  const hintId = chooseHintId(row.productVariantId);
  const howText = CHOOSE_WORDS.how[view.how];
  const hint = chooseHint(view);
  return (
    <TableRow
      data-testid={`catalog-choose-row-${row.productVariantId}`}
      data-changed={view.changed ?? undefined}
      // A changed row is highlighted, and its How words say what will happen (never colour alone).
      className={cn(view.changed && "bg-violet-50 hover:bg-violet-50")}
    >
      <TableCell className="w-12 p-0">
        <label className={BOX_LABEL_CLASS}>
          <TickBox
            label={CHOOSE_WORDS.rowCheckbox(row.productName, row.variantName)}
            checked={view.checked}
            disabled={locked || !view.changeable}
            // The How words and the hint, on every screen (the cell holding them is hidden on a phone; a description reads it anyway).
            describedBy={hint ? `${howId} ${hintId}` : howId}
            onChange={() => onToggle(row)}
          />
        </label>
      </TableCell>
      <TableCell className="min-w-0 py-2">
        <div className="break-words font-medium">{row.productName}</div>
        <div className="break-words text-xs text-zinc-500">{CHOOSE_WORDS.itemSizeLine(row.variantName, row.variantSku, row.productVariantId)}</div>
        {view.tierOff && row.listingTier && (
          <Badge
            variant="outline"
            className="mt-1 border-amber-200 bg-amber-50 text-amber-900"
            data-testid={`catalog-tier-off-sale-${row.productVariantId}`}
            title={describeCatalogListingTier(row.listingTier)}
          >
            {row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}
          </Badge>
        )}
        {/* A phone has no How or Available column: the item says both, and the hint (review DUX9). */}
        <div className="mt-1 text-xs text-zinc-600 sm:hidden" data-testid={`catalog-choose-how-line-${row.productVariantId}`}>
          <span className={cn(view.changed && "font-medium text-violet-800")}>{howText}</span>
          <span aria-hidden="true"> · </span>
          <span>{CHOOSE_WORDS.columns.available} <ChooseQuantity quantity={view.quantity} /></span>
          {hint && <span className="block text-zinc-500">{hint}</span>}
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">{row.category ? formatStatus(row.category) : CHOOSE_WORDS.uncategorized}</TableCell>
      <TableCell className="font-mono hidden sm:table-cell"><ChooseQuantity quantity={view.quantity} /></TableCell>
      <TableCell className="hidden sm:table-cell">
        <span id={howId} className={cn("text-sm", view.changed ? "font-medium text-violet-800" : "text-zinc-700")}>{howText}</span>
        {hint && <span id={hintId} className="block text-xs text-zinc-500">{hint}</span>}
      </TableCell>
    </TableRow>
  );
}

/** A selected size's quantity; "—" with words read out for any other (the server sends 0, which is not "out of stock"). */
function ChooseQuantity({ quantity }: { quantity: number | null }) {
  if (quantity !== null) return <>{formatChooseCount(quantity)}</>;
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{CHOOSE_WORDS.noQuantitySr}</span>
    </>
  );
}

export type { ChooseBarOutcome };

/**
 * "Not saved: 3 to add · 9 to remove · [Save changes] · [Undo changes]" above
 * the step's "N selected · [Next]" row. One polite status region carries the
 * counts and the saved line; refusals are alerts.
 */
export function ChooseChangesBar({ add, remove, hasChanges, saving, saveOff, saveOffReason, outcome, progress = null, onSave, onUndo, statusRef }: {
  add: number;
  remove: number;
  hasChanges: boolean;
  saving: boolean;
  /** Save can't be pressed (the count is not read yet, or the change grows past the cap). */
  saveOff: boolean;
  /** Why, in words, when the vendor can do something about it. */
  saveOffReason: string | null;
  outcome: ChooseBarOutcome | null;
  /** While a save is sent again: paused or still saving (PLAN-B v4.1 §12.4), in words. */
  progress?: string | null;
  onSave: () => void;
  onUndo: () => void;
  /** The status line, which takes focus after a save removes the focused Save button (review DUX8). */
  statusRef?: Ref<HTMLParagraphElement>;
}) {
  const reasonId = useId();
  const visible = hasChanges || outcome !== null;
  const status = hasChanges ? CHOOSE_WORDS.pendingLine(add, remove)
    : outcome?.kind === "saved" || outcome?.kind === "info" ? outcome.message : "";
  // A disabled Save leaves the Tab order, so its reason is also read out with the counts (review DUX3).
  const spokenReason = hasChanges && saveOffReason ? `. ${saveOffReason}` : null;
  return (
    <div data-testid="catalog-choose-bar" className={cn(visible && "mb-2 space-y-2 border-b border-zinc-200 pb-2")}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">
        {/* Always in the page, so a screen reader hears the counts change. */}
        <p role="status" aria-live="polite" tabIndex={-1} ref={statusRef} data-testid="catalog-choose-status"
          className={cn("font-medium", hasChanges ? "text-zinc-900" : "text-emerald-800")}>
          {status}{spokenReason && <span className="sr-only">{spokenReason}</span>}
        </p>
        {hasChanges && (
          <>
            <Button type="button" size="sm" className="min-h-11 bg-[#C060E0] hover:bg-[#a94bc9] sm:min-h-9"
              disabled={saving || saveOff} aria-describedby={saveOffReason ? reasonId : undefined} onClick={onSave}>
              {saving ? CHOOSE_WORDS.saving : CHOOSE_WORDS.save}
            </Button>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={saving} onClick={onUndo}>
              {CHOOSE_WORDS.undo}
            </Button>
          </>
        )}
      </div>
      {hasChanges && saveOffReason && <p id={reasonId} className="text-xs text-amber-900" data-testid="catalog-choose-save-off">{saveOffReason}</p>}
      {saving && progress && <p role="status" className="text-sm text-sky-900" data-testid="catalog-choose-progress">{progress}</p>}
      {outcome?.kind === "error" && <p role="alert" className="text-sm text-red-800" data-testid="catalog-choose-error">{outcome.message}</p>}
      {/* Stage 2 (step 1 plan S2-5 §4.9 item 2): this page is older than the server; only a reload can save again. */}
      {outcome?.kind === "error" && outcome.reload && (
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" data-testid="catalog-choose-reload"
          // The words already said the changes are lost: the reload asks nothing more (verify VC10).
          onClick={() => reloadPageWithoutLeavePrompt()}>
          {CHOOSE_WORDS.reload}
        </Button>
      )}
    </div>
  );
}

/**
 * The question before every save, with the server's counts and what Echelon
 * does on each store (PLAN-B v4.1 §13): only what Echelon does, never what
 * eBay shows. Asked again after the effects moved, it says so first.
 */
export function ChooseSaveConfirmBody({ preview, effectsChanged = false }: { preview: SelectionChangePreviewAnswer; effectsChanged?: boolean }) {
  return (
    <div className="space-y-2 text-sm text-zinc-600" data-testid="catalog-choose-confirm">
      {effectsChanged && <p className="font-medium text-amber-900" data-testid="catalog-choose-confirm-changed">{CHOOSE_WORDS.effectsChanged}</p>}
      {describeChooseConfirm(preview).map((line, index) => <p key={index}>{line}</p>)}
    </div>
  );
}

/** How many skeleton lines the categories card shows while its read loads: about a short card's worth. */
const CATEGORY_SKELETON_LINES = 3;

/** One category of the categories read (VCR:73-81). */
export type ChooseCategoryEntry = DropshipCatalogCategoriesAnswer["categories"][number];

/** A note under the categories list or on the "Check all" line: what a press did, or why it did nothing. */
export interface ChooseBulkNote {
  kind: "info" | "error";
  message: string;
}

export interface ChooseCategoryListProps {
  /** The categories read; undefined while it loads or after it failed. */
  categories: DropshipCatalogCategoriesAnswer | undefined;
  /** The read gave up after its retries. */
  failed: boolean;
  /** Each category's box (`chooseCategoryTicks`). */
  ticks: ReadonlyMap<number, ChooseCategoryTick>;
  /** The table's Category filter, which a name button sets (V40). */
  activeCategoryId: number | null;
  /** Every box and button off: a save or an id read is running. */
  locked: boolean;
  /** "Select everything"; null until the selection count and the categories are read. */
  everything: ChooseEverything | null;
  /** The room line ("You can have up to 10,000 selected…"): Select everything's reason while the room is too small. */
  roomLine: string | null;
  note: ChooseBulkNote | null;
  onTick: (category: ChooseCategoryEntry, tick: ChooseShownTick) => void;
  onShowOnly: (categoryId: number) => void;
  onSelectEverything: () => void;
  onRetry: () => void;
}

/**
 * The Categories card (PLAN-B v4.1 §12.3; left of the table from `lg`, above
 * it on a phone): one line per category with a box that adds or removes the
 * whole category today, its name as a button that shows only it, and
 * "{name} · 142 of 311 selected" (the saved counts); the items with no
 * category; "Select everything" with the room line. What a press did is a
 * polite status under the list; why it did nothing is an alert.
 */
export function ChooseCategoryList(props: ChooseCategoryListProps) {
  const { categories, failed, ticks, activeCategoryId, locked, everything, roomLine, note, onTick, onShowOnly, onSelectEverything, onRetry } = props;
  const headingId = useId();
  const roomId = useId();
  return (
    <section aria-labelledby={headingId} data-testid="catalog-choose-categories" className="min-w-0 rounded-md border border-zinc-200 bg-white p-4">
      <h2 id={headingId} className="text-lg font-semibold">{CHOOSE_WORDS.categoriesHeading}</h2>
      {categories === undefined ? (
        failed ? (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-red-900" data-testid="catalog-choose-categories-failed">
            <span>{CHOOSE_WORDS.catalogFailedText}</span>
            <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={onRetry}>{CHOOSE_WORDS.tryAgain}</Button>
          </div>
        ) : (
          <div aria-hidden="true" className="mt-3 space-y-2" data-testid="catalog-choose-categories-loading">
            {Array.from({ length: CATEGORY_SKELETON_LINES }, (_, index) => <Skeleton key={index} className="h-8 w-full" />)}
          </div>
        )
      ) : (
        <>
          {/* A long list scrolls inside the card, so a phone reaches the table without scrolling past every category. */}
          <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto" data-testid="catalog-choose-category-list">
            {categories.categories.map((category) => (
              <ChooseCategoryLine
                key={category.categoryId}
                category={category}
                tick={ticks.get(category.categoryId) ?? { tick: "none", empty: false }}
                active={activeCategoryId === category.categoryId}
                locked={locked}
                onTick={onTick}
                onShowOnly={onShowOnly}
              />
            ))}
          </ul>
          {categories.uncategorizedCount > 0 && (
            <p className="mt-3 text-xs text-zinc-500" data-testid="catalog-choose-no-category">{CHOOSE_WORDS.noCategory}</p>
          )}
        </>
      )}
      {/* Always in the page, so a screen reader hears what a press did. */}
      <p role="status" aria-live="polite" className={cn("text-sm text-zinc-700", note?.kind === "info" && "mt-2")} data-testid="catalog-choose-categories-status">
        {note?.kind === "info" ? note.message : ""}
      </p>
      {note?.kind === "error" && <p role="alert" className="mt-2 text-sm text-red-800" data-testid="catalog-choose-categories-error">{note.message}</p>}
      {everything && (
        <div className="mt-4 border-t border-zinc-200 pt-4">
          <Button type="button" variant="outline" className="min-h-11 w-full whitespace-normal sm:min-h-9" data-testid="catalog-choose-everything"
            disabled={locked || everything.disabled} aria-describedby={roomLine ? roomId : undefined} onClick={onSelectEverything}>
            {CHOOSE_WORDS.selectEverything(everything.offered)}
          </Button>
          {roomLine && <p id={roomId} className="mt-2 text-xs text-zinc-600" data-testid="catalog-choose-room">{roomLine}</p>}
        </div>
      )}
    </section>
  );
}

function ChooseCategoryLine({ category, tick, active, locked, onTick, onShowOnly }: {
  category: ChooseCategoryEntry;
  tick: ChooseCategoryTick;
  active: boolean;
  locked: boolean;
  onTick: (category: ChooseCategoryEntry, tick: ChooseShownTick) => void;
  onShowOnly: (categoryId: number) => void;
}) {
  const name = formatStatus(category.name);
  // `categoryLine` begins with the name: the name is the button, the counts follow it ("Envelopes · 142 of 311 selected").
  const counts = CHOOSE_WORDS.categoryLine(name, category.selectedCount, category.rowCount).slice(name.length);
  return (
    // `data-tick`: the box's state where markup can't show it ("some" is the `indeterminate` property, never an attribute).
    <li className="flex items-start gap-1" data-testid={`catalog-choose-category-${category.categoryId}`} data-tick={tick.tick}>
      <label className={BOX_LABEL_CLASS}>
        <TickBox
          label={CHOOSE_WORDS.categoryBox(name)}
          checked={tick.tick === "all"}
          indeterminate={tick.tick === "some"}
          disabled={locked || tick.empty || category.rowCount === 0}
          onChange={() => onTick(category, tick.tick)}
        />
      </label>
      <p className="min-w-0 flex-1 break-words text-sm text-zinc-600">
        <button
          type="button"
          aria-label={CHOOSE_WORDS.categoryShowOnly(name)}
          aria-current={active ? "true" : undefined}
          className={cn("inline-flex min-h-11 items-center text-left font-medium text-violet-800 underline-offset-2 hover:underline sm:min-h-9",
            active && "underline")}
          onClick={() => onShowOnly(category.categoryId)}
        >
          {name}
        </button>
        <span>{counts}</span>
      </p>
    </li>
  );
}

/**
 * The line under the header box when more rows match than are shown
 * (PLAN-B v4.1 §12.3): "All 200 shown are checked. [Check all 1,433 that
 * match]", or after unchecking "[Uncheck all 1,433 that match]". When more
 * matched at the press than the button said, it says so and asks again.
 */
export function ChooseMatchLineView({ line, locked, error, onPress }: {
  line: ChooseMatchLine;
  locked: boolean;
  error: string | null;
  onPress: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-200 bg-violet-50 px-4 py-2 text-sm text-violet-950" data-testid="catalog-choose-match">
      {line.changed ? (
        <span role="status" data-testid="catalog-choose-match-changed">{CHOOSE_WORDS.matchChanged(line.changed.now, line.changed.was)}</span>
      ) : line.shownChecked !== null && <span>{CHOOSE_WORDS.checkAllShown(line.shownChecked)}</span>}
      <Button type="button" variant="outline" size="sm" className="min-h-11 whitespace-normal bg-white sm:min-h-9" data-testid="catalog-choose-match-button"
        disabled={locked} onClick={onPress}>
        {line.purpose === "add" ? CHOOSE_WORDS.checkAll(line.total) : CHOOSE_WORDS.uncheckAll(line.total)}
      </Button>
      {error && <span role="alert" className="text-red-800" data-testid="catalog-choose-match-error">{error}</span>}
    </div>
  );
}

export interface ChooseNewItemsNoticeProps {
  model: NewItemsNoticeModel;
  /** A "Got it" is being sent: every Got it is off until it is answered (one at a time); Review still works. */
  acknowledging: boolean;
  /** The last "Got it" that failed, by the category it named, in words; null otherwise. */
  failure: { categoryId: number; message: string } | null;
  /** The category whose new items the table shows (its Review is marked current); null when not reviewing. */
  reviewingCategoryId: number | null;
  onReview: (line: NewItemsNoticeLine) => void;
  onGotIt: (line: NewItemsNoticeLine) => void;
  onShowAll: () => void;
  /** The notice's box, where focus goes after a line it held is gone (ChooseStep). */
  noticeRef?: Ref<HTMLDivElement>;
}

/**
 * The new-items notice (PLAN-B v4.1 §11.4, §12.3, §13), between the step's
 * intro and the filters: "3 new items from Card Shellz in Armalope ·
 * [Review] · [Got it]" per category the vendor sells from, the first three,
 * then "and 2 more categories · [Show all]". Each button is named for its
 * line, so a screen reader tells one line's from the next; 44 px targets on a
 * phone. A "Got it" that failed says so under its line (an alert). Nothing
 * here adds an item: Review only filters the table.
 */
export function ChooseNewItemsNotice({ model, acknowledging, failure, reviewingCategoryId, onReview, onGotIt, onShowAll, noticeRef }: ChooseNewItemsNoticeProps) {
  return (
    <div ref={noticeRef} tabIndex={-1} data-testid="catalog-new-items"
      className="mt-5 min-w-0 rounded-md border border-violet-200 bg-violet-50 p-4 text-sm text-violet-950">
      <ul className="space-y-2">
        {model.lines.map((line) => (
          <li key={line.categoryId} data-testid={`catalog-new-items-${line.categoryId}`} className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 break-words font-medium">{line.text}</span>
            <span className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9"
                aria-label={line.reviewName} aria-current={reviewingCategoryId === line.categoryId ? "true" : undefined}
                onClick={() => onReview(line)}>
                {NEW_ITEMS_WORDS.review}
              </Button>
              <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9"
                aria-label={line.gotItName} disabled={acknowledging} onClick={() => onGotIt(line)}>
                {NEW_ITEMS_WORDS.gotIt}
              </Button>
            </span>
            {failure?.categoryId === line.categoryId && (
              <p role="alert" className="w-full text-red-800" data-testid={`catalog-new-items-failed-${line.categoryId}`}>{failure.message}</p>
            )}
          </li>
        ))}
      </ul>
      {model.more && (
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="catalog-new-items-more">
          <span>{model.more.text}</span>
          <Button type="button" variant="outline" size="sm" className="min-h-11 bg-white sm:min-h-9" onClick={onShowAll}>
            {NEW_ITEMS_WORDS.noticeShowAll}
          </Button>
        </p>
      )}
    </div>
  );
}
