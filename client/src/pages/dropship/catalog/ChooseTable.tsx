import { useId, type Ref } from "react";
import { TickBox } from "@/components/dropship/TickBox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  chooseRowView,
  shownTick,
  type ChooseBarOutcome,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseRowView,
  type ChooseSelectionRule,
} from "@/lib/dropship-catalog-choose";
import { CHOOSE_WORDS, describeCatalogListingTier, formatChooseCount } from "@/lib/dropship-catalog-choose-words";
import { formatStatus } from "@/lib/dropship-ops-surface";
import { cn } from "@/lib/utils";
import { reloadPageWithoutLeavePrompt } from "./UnsavedChangesGuard";

/**
 * Catalog step 1's table, bar line and save question (step 1 stage 1).
 * Stateless: the change set, the rules and the save live in ChooseStep and the
 * page. Never renders a product line (owner Q2).
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

/** What the vendor can do with a row in this state, or null (review DUX6). Never names the older setting (owner Q2). */
function chooseHint(view: ChooseRowView): string | null {
  if (view.how === "removed") return CHOOSE_WORDS.removedHint;
  if (view.how === "olderInclude") return CHOOSE_WORDS.olderIncludeHint;
  if (view.how === "olderExclude") return CHOOSE_WORDS.olderExcludeHint;
  // Turned off, with the vendor's own pick saved: the box removes the pick (verify V6).
  if (view.how === "turnedOff" && view.changeable) return CHOOSE_WORDS.turnedOffPickHint;
  return null;
}

export interface ChooseTableProps {
  rows: readonly ChooseCatalogRow[];
  changes: Pick<ChooseChanges, "marks">;
  /** The saved rules by id; null while they load or after they failed (every box is off then). */
  rulesById: ReadonlyMap<number, ChooseSelectionRule> | null;
  /** Every box off: a save is running, or the rows are an older filter's, kept on screen while the new ones load. */
  locked: boolean;
  /** The rows are an older filter's (dimmed). */
  dimmed: boolean;
  onToggle: (row: ChooseCatalogRow) => void;
  /** The header box: true checks every changeable row shown, false unchecks them. */
  onToggleShown: (checked: boolean) => void;
}

export function ChooseTable({ rows, changes, rulesById, locked, dimmed, onToggle, onToggleShown }: ChooseTableProps) {
  const marks = new Map(changes.marks.map((mark) => [mark.productVariantId, mark]));
  const header = shownTick(rows, changes, rulesById);
  const headerOff = locked || rulesById === null || header.changeable === 0;
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
            const view = chooseRowView(row, marks.get(row.productVariantId), rulesById);
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
export function ChooseChangesBar({ add, remove, hasChanges, saving, saveOff, saveOffReason, outcome, onSave, onUndo, statusRef }: {
  add: number;
  remove: number;
  hasChanges: boolean;
  saving: boolean;
  /** Save can't be pressed (rules loading or failed, or a limit). */
  saveOff: boolean;
  /** Why, in words, when the vendor can do something about it. */
  saveOffReason: string | null;
  outcome: ChooseBarOutcome | null;
  onSave: () => void;
  onUndo: () => void;
  /** The status line, which takes focus after a save removes the focused Save button (review DUX8). */
  statusRef?: Ref<HTMLParagraphElement>;
}) {
  const reasonId = useId();
  const visible = hasChanges || outcome !== null;
  const status = hasChanges ? CHOOSE_WORDS.pendingLine(add, remove)
    : outcome?.kind === "saved"
      ? [CHOOSE_WORDS.savedLine(outcome.add, outcome.remove), ...(outcome.notTaken > 0 ? [CHOOSE_WORDS.notTakenLine(outcome.notTaken)] : [])].join(" ")
      : outcome?.kind === "info" ? outcome.message : "";
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
 * The question before every save. No listing data reaches this page, so it
 * says what a save does on eBay per size, today (owner Q5), and that it can't
 * tell which items are listed.
 */
export function ChooseSaveConfirmBody({ add, remove }: { add: number; remove: number }) {
  return (
    <div className="space-y-2 text-sm text-zinc-600" data-testid="catalog-choose-confirm">
      {remove > 0 && <p>{CHOOSE_WORDS.confirmRemove}</p>}
      {add > 0 && <p>{CHOOSE_WORDS.confirmAdd}</p>}
      <p>{CHOOSE_WORDS.confirmUnknown}</p>
    </div>
  );
}
