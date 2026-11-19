import { DropshipError } from "./errors";

/**
 * One save of step 1's one-time picks (PLAN-B v4.1 §7.3, §7.4): which picks a
 * change writes and whether it may grow the selection. Pure: no clock, no
 * database; the caller reads the vendor's picks and Card Shellz's offer of the
 * touched sizes under its vendor lock and passes them in. Inputs are never
 * mutated; every id list it returns is sorted ascending and has no duplicate.
 *
 * Words: "selected" = picked by the vendor and offered by Card Shellz now
 * (exposed, sellable, not turned off), the count steps 2 and 3 cap on;
 * "picked" = a row of `dropship.dropship_vendor_selected_variants`.
 */

/** Postgres `integer`, the type of every catalog size id. */
const MAX_CATALOG_ID = 2_147_483_647;

export type SelectionChangeSkipReason = "not_offered";

export interface SelectionChangeSkip {
  id: number;
  reason: SelectionChangeSkipReason;
}

export interface PlanSelectionChangeInput {
  /** The vendor's picks; only the touched sizes are read, so a superset is fine. */
  pickedBefore: ReadonlySet<number> | readonly number[];
  add: readonly number[];
  remove: readonly number[];
  /** The added sizes Card Shellz offers now (exposed, sellable, not turned off); a superset is fine. */
  offered: ReadonlySet<number> | readonly number[];
}

export interface SelectionChangePlan {
  /** Added sizes that are offered and not yet picked: the picks to insert. */
  insertIds: number[];
  /** Removed sizes that are picked: the picks to delete. Offer does not matter; removing is always allowed. */
  deleteIds: number[];
  /** Added sizes Card Shellz does not offer now and that are not picked: nothing is written for them. */
  skipped: SelectionChangeSkip[];
  /** Added sizes the vendor already picked: nothing to write. */
  alreadySelected: number[];
  /** Removed sizes the vendor has not picked: nothing to write. */
  alreadyNotSelected: number[];
}

/**
 * Plans the writes of one change. An added size already picked is
 * `alreadySelected` whatever its offer (its pick stays, so it was not
 * skipped); an added size not picked and not offered is skipped
 * `not_offered`. The same size in add and remove is refused (the request
 * schema refuses it first; this keeps the planner safe on its own).
 */
export function planSelectionChange(input: PlanSelectionChangeInput): SelectionChangePlan {
  const add = uniqueSortedCatalogIds(input.add, "add");
  const remove = uniqueSortedCatalogIds(input.remove, "remove");
  const removed = new Set(remove);
  const conflicting = add.filter((id) => removed.has(id));
  if (conflicting.length > 0) {
    throw new DropshipError(
      "DROPSHIP_SELECTION_CHANGE_CONFLICTING",
      // PROPOSED (Stage 3/5, step 1 plan S2-5)
      "An item can't be added and removed in the same save.",
      { classification: "permanent", productVariantIds: conflicting.slice(0, CONFLICT_IDS_IN_CONTEXT) },
    );
  }
  const pickedBefore = asIdSet(input.pickedBefore);
  const offered = asIdSet(input.offered);

  const plan: SelectionChangePlan = { insertIds: [], deleteIds: [], skipped: [], alreadySelected: [], alreadyNotSelected: [] };
  for (const id of add) {
    if (pickedBefore.has(id)) plan.alreadySelected.push(id);
    else if (offered.has(id)) plan.insertIds.push(id);
    else plan.skipped.push({ id, reason: "not_offered" });
  }
  for (const id of remove) {
    if (pickedBefore.has(id)) plan.deleteIds.push(id);
    else plan.alreadyNotSelected.push(id);
  }
  return plan;
}

/** How many conflicting ids a refusal names in its context (the log line stays small). */
const CONFLICT_IDS_IN_CONTEXT = 20;

/**
 * The selected count before a change (SRV-1). A save reads its facts one
 * statement at a time under READ COMMITTED, and a catalog change (a size
 * deleted, made unsellable or no longer exposed) takes no vendor lock, so it
 * can commit between the plan's reads and the count. The sizes outside the
 * change are therefore counted by the scan of the whole selection
 * (`selected` less `selectedAmongTouched`, one scan), and the touched sizes
 * by the plan's own reads (picked in `pickedBefore` and offered in
 * `offered`). Every planned delete is in `pickedBefore`, so
 * selectedCountAfterChange can never go below 0 from such a race. In one
 * snapshot (the preview) the two reads agree, `selectedAmongTouched` equals
 * the touched sizes picked and offered, and this is `selected` itself.
 * Only ids in `touchedIds` are counted, each once; inputs are never mutated.
 */
export function selectedCountBeforeChange(input: {
  selected: number;
  selectedAmongTouched: number;
  touchedIds: readonly number[];
  pickedBefore: ReadonlySet<number> | readonly number[];
  offered: ReadonlySet<number> | readonly number[];
}): number {
  assertCount(input.selected, "selected");
  assertCount(input.selectedAmongTouched, "selectedAmongTouched");
  if (input.selectedAmongTouched > input.selected) {
    // Both counts come from one scan, and the touched count is a subset of it: a larger one is a bug, never a race.
    throw new DropshipError(
      "DROPSHIP_SELECTION_COUNT_INCONSISTENT",
      // PROPOSED (Stage 3/5, step 1 plan S2-5)
      "The selected count read for this save does not match its picks.",
      { classification: "fatal", selected: input.selected, selectedAmongTouched: input.selectedAmongTouched },
    );
  }
  const pickedBefore = asIdSet(input.pickedBefore);
  const offered = asIdSet(input.offered);
  let touchedSelected = 0;
  for (const id of new Set(input.touchedIds)) if (pickedBefore.has(id) && offered.has(id)) touchedSelected += 1;
  return input.selected - input.selectedAmongTouched + touchedSelected;
}

/**
 * The selected count after a plan is written: every inserted size is offered
 * (planSelectionChange inserts only offered sizes), and a deleted size counted
 * before only when it is offered now. `offeredDeletes` are the planned deletes
 * Card Shellz offers now. With `selectedBefore` from selectedCountBeforeChange
 * the count cannot go below 0, so one that would is a bug: refused as fatal,
 * never clamped.
 */
export function selectedCountAfterChange(input: {
  selectedBefore: number;
  plan: Pick<SelectionChangePlan, "insertIds" | "deleteIds">;
  offeredDeletes: ReadonlySet<number> | readonly number[];
}): number {
  assertCount(input.selectedBefore, "selectedBefore");
  const offeredDeletes = asIdSet(input.offeredDeletes);
  const removedSelected = input.plan.deleteIds.filter((id) => offeredDeletes.has(id)).length;
  const after = input.selectedBefore + input.plan.insertIds.length - removedSelected;
  if (after < 0) {
    throw new DropshipError(
      "DROPSHIP_SELECTION_COUNT_INCONSISTENT",
      // PROPOSED (Stage 3/5, step 1 plan S2-5)
      "The selected count read for this save does not match its picks.",
      { classification: "fatal", selectedBefore: input.selectedBefore, inserts: input.plan.insertIds.length, removedSelected },
    );
  }
  return after;
}

/**
 * The cap (§7.4): a change is refused only when it ends over the cap and
 * grows the selection. Removing is always allowed, even while over the cap,
 * and a change that ends over the cap but smaller than it started is allowed.
 * `before` and `after` count selected sizes.
 */
export function refuseGrowthOverCap(input: { before: number; after: number; cap: number }): boolean {
  assertCount(input.before, "before");
  assertCount(input.after, "after");
  assertCount(input.cap, "cap");
  return input.after > input.cap && input.after > input.before;
}

function uniqueSortedCatalogIds(ids: readonly number[], field: string): number[] {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_CATALOG_ID) {
      throw new DropshipError(
        "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "Each item must be a catalog item id.",
        { classification: "permanent", field, value: typeof id === "number" ? id : String(id) },
      );
    }
  }
  return [...new Set(ids)].sort((left, right) => left - right);
}

function asIdSet(ids: ReadonlySet<number> | readonly number[]): ReadonlySet<number> {
  return ids instanceof Set ? ids : new Set(ids);
}

function assertCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
      // PROPOSED (Stage 3/5, step 1 plan S2-5)
      "A selection count must be a whole number of items.",
      { classification: "permanent", field, value },
    );
  }
}
