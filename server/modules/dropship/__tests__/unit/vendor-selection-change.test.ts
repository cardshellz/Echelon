import { describe, expect, it } from "vitest";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "../../../../../shared/dropship/catalog-scope";
import { DropshipError } from "../../domain/errors";
import {
  planSelectionChange,
  refuseGrowthOverCap,
  selectedCountAfterChange,
  selectedCountBeforeChange,
  type PlanSelectionChangeInput,
} from "../../domain/vendor-selection-change";

/** Step 1's one-time picks: the planner and the cap (step 1 plan S2-5, PLAN-B v4.1 §7.3, §7.4, §15.1). */

const ids = (from: number, count: number): number[] => Array.from({ length: count }, (_, index) => from + index);

function frozenInput(input: PlanSelectionChangeInput): PlanSelectionChangeInput {
  const freezeIds = (value: ReadonlySet<number> | readonly number[]) => (value instanceof Set ? value : Object.freeze([...value]));
  return Object.freeze({
    pickedBefore: freezeIds(input.pickedBefore),
    add: Object.freeze([...input.add]),
    remove: Object.freeze([...input.remove]),
    offered: freezeIds(input.offered),
  });
}

function refusal(run: () => unknown): DropshipError {
  try {
    run();
  } catch (error) {
    if (error instanceof DropshipError) return error;
    throw error;
  }
  throw new Error("expected a DropshipError");
}

describe("planSelectionChange (§7.3)", () => {
  it("inserts offered, unpicked adds and deletes picked removes", () => {
    expect(planSelectionChange({ pickedBefore: [5, 7], add: [3, 4], remove: [5, 6], offered: [3, 4, 9] })).toEqual({
      insertIds: [3, 4], deleteIds: [5], skipped: [], alreadySelected: [], alreadyNotSelected: [6],
    });
  });

  it("skips an add Card Shellz does not offer now and writes nothing for it", () => {
    expect(planSelectionChange({ pickedBefore: [], add: [8, 2], remove: [], offered: [2] })).toEqual({
      insertIds: [2], deleteIds: [], skipped: [{ id: 8, reason: "not_offered" }], alreadySelected: [], alreadyNotSelected: [],
    });
  });

  it("an add already picked is already selected whatever its offer; a remove needs no offer", () => {
    expect(planSelectionChange({ pickedBefore: [1, 2, 3], add: [1, 2], remove: [3], offered: [1] })).toEqual({
      insertIds: [], deleteIds: [3], skipped: [], alreadySelected: [1, 2], alreadyNotSelected: [],
    });
  });

  it("a no-op change plans no write", () => {
    const plan = planSelectionChange({ pickedBefore: [1], add: [1], remove: [2], offered: [1, 2] });
    expect(plan).toEqual({ insertIds: [], deleteIds: [], skipped: [], alreadySelected: [1], alreadyNotSelected: [2] });
  });

  it("plans 0 and 1 ids", () => {
    expect(planSelectionChange({ pickedBefore: [], add: [], remove: [], offered: [] })).toEqual({
      insertIds: [], deleteIds: [], skipped: [], alreadySelected: [], alreadyNotSelected: [],
    });
    expect(planSelectionChange({ pickedBefore: [], add: [42], remove: [], offered: [42] }).insertIds).toEqual([42]);
    expect(planSelectionChange({ pickedBefore: [42], add: [], remove: [42], offered: [] }).deleteIds).toEqual([42]);
  });

  it("plans 10,000 and 10,001 ids in each direction, sorted (the request schema bounds a list at 10,000)", () => {
    for (const count of [MAX_NAMED_CATALOG_GROUP_ITEMS, MAX_NAMED_CATALOG_GROUP_ITEMS + 1]) {
      const adds = ids(1, count).reverse();
      const removes = ids(100_000, count);
      const plan = planSelectionChange({ pickedBefore: new Set(removes), add: adds, remove: removes, offered: new Set(adds) });
      expect(plan.insertIds).toHaveLength(count);
      expect(plan.deleteIds).toHaveLength(count);
      expect(plan.insertIds).toEqual(ids(1, count));
      expect(plan.deleteIds).toEqual(removes);
    }
  });

  it("de-duplicates ids and returns every list sorted ascending", () => {
    const plan = planSelectionChange({ pickedBefore: [30, 10], add: [9, 3, 9, 3, 7, 30, 10, 30], remove: [40, 20, 40, 50],
      offered: [3, 9] });
    expect(plan).toEqual({
      insertIds: [3, 9], deleteIds: [], skipped: [{ id: 7, reason: "not_offered" }], alreadySelected: [10, 30],
      alreadyNotSelected: [20, 40, 50],
    });
  });

  it("never mutates its inputs (frozen arrays and sets)", () => {
    const pickedBefore = new Set([5, 1]);
    const offered = new Set([4, 2]);
    const input = frozenInput({ pickedBefore, add: [4, 2, 6], remove: [5, 3], offered });
    const before = JSON.stringify({ add: input.add, remove: input.remove, picked: [...pickedBefore], offered: [...offered] });
    planSelectionChange(input);
    expect(JSON.stringify({ add: input.add, remove: input.remove, picked: [...pickedBefore], offered: [...offered] })).toBe(before);
    expect([...pickedBefore]).toEqual([5, 1]);
    expect([...offered]).toEqual([4, 2]);
  });

  it("refuses the same id in add and remove as permanent CONFLICTING", () => {
    const error = refusal(() => planSelectionChange({ pickedBefore: [], add: [1, 2], remove: [2, 3], offered: [1, 2] }));
    expect(error.code).toBe("DROPSHIP_SELECTION_CHANGE_CONFLICTING");
    expect(error.context).toMatchObject({ classification: "permanent", productVariantIds: [2] });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("refuses the id %s as permanent INVALID_INPUT", (bad) => {
    const error = refusal(() => planSelectionChange({ pickedBefore: [], add: [1, bad], remove: [], offered: [] }));
    expect(error.code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    expect(error.context).toMatchObject({ classification: "permanent", field: "add" });
    expect(refusal(() => planSelectionChange({ pickedBefore: [], add: [], remove: [bad], offered: [] })).context)
      .toMatchObject({ field: "remove" });
  });

  it("accepts the largest integer id", () => {
    expect(planSelectionChange({ pickedBefore: [], add: [2_147_483_647], remove: [], offered: [2_147_483_647] }).insertIds)
      .toEqual([2_147_483_647]);
  });
});

describe("refuseGrowthOverCap (§7.4): refuses only growth that ends over the cap", () => {
  const cap = MAX_NAMED_CATALOG_GROUP_ITEMS;

  it.each([
    { before: 0, after: 0, refused: false },
    { before: 0, after: 1, refused: false },
    { before: 9_999, after: 10_000, refused: false },
    { before: 0, after: 10_000, refused: false },
    { before: 10_000, after: 10_001, refused: true },
    { before: 0, after: 10_001, refused: true },
    // Over the cap already: removing is always allowed, and so is a change that ends smaller.
    { before: 10_002, after: 10_001, refused: false },
    { before: 12_000, after: 0, refused: false },
    { before: 10_001, after: 10_001, refused: false },
    { before: 10_001, after: 10_002, refused: true },
  ])("before $before, after $after → refused $refused", ({ before, after, refused }) => {
    expect(refuseGrowthOverCap({ before, after, cap })).toBe(refused);
  });

  it("a cap of 0 refuses any growth and allows staying at 0", () => {
    expect(refuseGrowthOverCap({ before: 0, after: 1, cap: 0 })).toBe(true);
    expect(refuseGrowthOverCap({ before: 0, after: 0, cap: 0 })).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN])("refuses the count %s", (bad) => {
    expect(refusal(() => refuseGrowthOverCap({ before: bad, after: 0, cap })).code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    expect(refusal(() => refuseGrowthOverCap({ before: 0, after: bad, cap })).code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    expect(refusal(() => refuseGrowthOverCap({ before: 0, after: 0, cap: bad })).code).toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
  });
});

describe("selectedCountAfterChange: selected = picked and offered", () => {
  it("adds every insert and subtracts only the deletes that are offered now", () => {
    const plan = { insertIds: [1, 2], deleteIds: [7, 8, 9] };
    expect(selectedCountAfterChange({ selectedBefore: 5, plan, offeredDeletes: [7, 9] })).toBe(5);
    expect(selectedCountAfterChange({ selectedBefore: 5, plan, offeredDeletes: new Set<number>() })).toBe(7);
    expect(selectedCountAfterChange({ selectedBefore: 0, plan: { insertIds: [], deleteIds: [] }, offeredDeletes: [] })).toBe(0);
    expect(selectedCountAfterChange({ selectedBefore: 9_999, plan: { insertIds: [1, 2], deleteIds: [] }, offeredDeletes: [] })).toBe(10_001);
  });

  it("refuses a count that would go below 0 as fatal, never clamps it", () => {
    const error = refusal(() => selectedCountAfterChange({ selectedBefore: 1, plan: { insertIds: [], deleteIds: [7, 8] }, offeredDeletes: [7, 8] }));
    expect(error.code).toBe("DROPSHIP_SELECTION_COUNT_INCONSISTENT");
    expect(error.context).toMatchObject({ classification: "fatal", selectedBefore: 1, removedSelected: 2 });
  });

  it("refuses a selected count that is not a whole number", () => {
    expect(refusal(() => selectedCountAfterChange({ selectedBefore: -1, plan: { insertIds: [], deleteIds: [] }, offeredDeletes: [] })).code)
      .toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
  });
});

describe("selectedCountBeforeChange (SRV-1): untouched sizes from the scan, touched sizes from the plan's own reads", () => {
  it("in one snapshot (the preview) it is the scan's own count", () => {
    // The scan counted 10 selected, 2 of them touched (5 and 6); the plan's reads agree: 5 and 6 are picked and offered.
    expect(selectedCountBeforeChange({ selected: 10, selectedAmongTouched: 2, touchedIds: [5, 6, 7, 8],
      pickedBefore: new Set([5, 6, 7]), offered: new Set([5, 6, 8]) })).toBe(10);
    expect(selectedCountBeforeChange({ selected: 0, selectedAmongTouched: 0, touchedIds: [], pickedBefore: [], offered: [] })).toBe(0);
  });

  it("a touched size that stopped being offered after the offer read is counted as the plan saw it, so removing it never goes below 0", () => {
    // pickedBefore {7}, offered {7}; the scan ran after 7 stopped being sellable, so it counted neither 7 nor anything else.
    const before = selectedCountBeforeChange({ selected: 0, selectedAmongTouched: 0, touchedIds: [7], pickedBefore: [7], offered: [7] });
    expect(before).toBe(1);
    expect(selectedCountAfterChange({ selectedBefore: before, plan: { insertIds: [], deleteIds: [7] }, offeredDeletes: [7] })).toBe(0);
    // Every selected size removed while one of them races: the untouched remainder and the count after stay whole.
    const all = selectedCountBeforeChange({ selected: 4, selectedAmongTouched: 4, touchedIds: [1, 2, 3, 4, 5],
      pickedBefore: [1, 2, 3, 4, 5], offered: [1, 2, 3, 4, 5] });
    expect(all).toBe(5);
    expect(selectedCountAfterChange({ selectedBefore: all, plan: { insertIds: [], deleteIds: [1, 2, 3, 4, 5] },
      offeredDeletes: [1, 2, 3, 4, 5] })).toBe(0);
  });

  it("a touched size that became offered after the offer read is not counted twice", () => {
    // The offer read did not see 8; the scan did. The plan's reads decide the touched sizes, so 8 counts 0, not 1.
    expect(selectedCountBeforeChange({ selected: 3, selectedAmongTouched: 1, touchedIds: [8], pickedBefore: [8], offered: [] })).toBe(2);
  });

  it("counts only touched ids, once each, whatever extra ids or duplicates the sets carry", () => {
    expect(selectedCountBeforeChange({ selected: 1, selectedAmongTouched: 0, touchedIds: [2, 2, 3],
      pickedBefore: [1, 2, 2, 3], offered: [1, 2, 3, 4] })).toBe(3);
  });

  it("never mutates its inputs (frozen arrays and sets)", () => {
    const touchedIds = Object.freeze([5, 6]);
    const pickedBefore = new Set([5, 6]);
    const offered = Object.freeze([5]);
    expect(selectedCountBeforeChange({ selected: 1, selectedAmongTouched: 1, touchedIds, pickedBefore, offered })).toBe(1);
    expect([...pickedBefore]).toEqual([5, 6]);
    expect(touchedIds).toEqual([5, 6]);
    expect(offered).toEqual([5]);
  });

  it("refuses a scan whose touched count exceeds its whole count as fatal (one scan's subset cannot be larger: a bug)", () => {
    const error = refusal(() => selectedCountBeforeChange({ selected: 1, selectedAmongTouched: 2, touchedIds: [1, 2],
      pickedBefore: [1, 2], offered: [1, 2] }));
    expect(error.code).toBe("DROPSHIP_SELECTION_COUNT_INCONSISTENT");
    expect(error.context).toMatchObject({ classification: "fatal", selected: 1, selectedAmongTouched: 2 });
  });

  it.each([-1, 1.5, Number.NaN])("refuses the count %s", (bad) => {
    const base = { touchedIds: [], pickedBefore: [], offered: [] };
    expect(refusal(() => selectedCountBeforeChange({ ...base, selected: bad, selectedAmongTouched: 0 })).code)
      .toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
    expect(refusal(() => selectedCountBeforeChange({ ...base, selected: 0, selectedAmongTouched: bad })).code)
      .toBe("DROPSHIP_SELECTION_CHANGE_INVALID_INPUT");
  });
});
