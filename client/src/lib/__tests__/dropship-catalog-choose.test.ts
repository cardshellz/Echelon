import { describe, expect, it } from "vitest";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "@shared/dropship/vendor-catalog-reads";
import {
  SELECTION_CHANGE_ERROR_CODES,
  emptySelectionChangeEnds,
  selectionChangePreviewRequestSchema,
  type SelectionChangeAnswer,
  type SelectionChangeEnds,
  type SelectionChangePreviewAnswer,
} from "@shared/dropship/vendor-selection-changes";
import {
  CHOOSE_BULK_BODY_LIMIT_BYTES,
  CHOOSE_CHANGE_IDS_MAX,
  CHOOSE_MAX_ROWS_SHOWN,
  CHOOSE_PAGE_SIZE,
  CHOOSE_PAUSED_MAX_SENDS,
  CHOOSE_SELECTION_CAP,
  EMPTY_CHOOSE_CHANGES,
  chooseActionOverLimit,
  chooseAdoptsHead,
  chooseHeadMovedPast,
  chooseBodyBytes,
  chooseCategoryPurpose,
  chooseCategoryTicks,
  chooseCatalogPageSchema,
  chooseCatalogRowSchema,
  chooseChangeBody,
  chooseChangesEmpty,
  chooseChangesKey,
  chooseCounts,
  chooseEverything,
  chooseIdsTooMany,
  chooseKnownAt,
  chooseMatchGrew,
  chooseMatchLine,
  chooseNextPageParam,
  choosePausedDelayMs,
  chooseRoom,
  chooseRowView,
  chooseSavedState,
  classifyChooseSaveError,
  describeChooseConfirm,
  describeChooseConfirmButton,
  describeChooseIdsFailure,
  describeChooseSaved,
  describeChooseShown,
  emptyChooseKnown,
  learnChooseIds,
  learnChooseRows,
  mergeChoosePages,
  reduceChooseChanges,
  shownTick,
  type ChooseCatalogPage,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseChangesAction,
  type ChooseKnown,
  type ChooseSelectionReason,
} from "../dropship-catalog-choose";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { CATALOG_PAGE_CLIENT_VERSION } from "../dropship-catalog-publish";
import { DROPSHIP_SITE_UPDATING_CODE, DropshipApiError } from "../dropship-ops-surface";

/** Every input is frozen all the way down, so a function that mutates one throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/** A set whose writers throw: the reducer must copy before it writes. */
function frozenSet(ids: Iterable<number>): ReadonlySet<number> {
  const set = new Set(ids);
  const refuse = (): never => { throw new Error("a change set was mutated"); };
  Object.assign(set, { add: refuse, delete: refuse, clear: refuse });
  return Object.freeze(set);
}

function changes(add: Iterable<number>, remove: Iterable<number>, baseRevisionId: number | null = 7): ChooseChanges {
  return Object.freeze({ add: frozenSet(add), remove: frozenSet(remove), baseRevisionId });
}

function action(value: ChooseChangesAction): ChooseChangesAction {
  return deepFreeze(value);
}

const ids = (set: ReadonlySet<number>) => [...set].sort((left, right) => left - right);
const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

function expectDisjoint(value: ChooseChanges) {
  for (const id of value.add) expect(value.remove.has(id), `id ${id} on both sides`).toBe(false);
}

/** A row as the server sends it (rule ids, product-line facts and all), read through the step's own contract. */
function row(productVariantId: number, reason: ChooseSelectionReason, picked: boolean, extra: Record<string, unknown> = {}): ChooseCatalogRow {
  return deepFreeze(chooseCatalogRowSchema.parse({
    productId: 11, productVariantId, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: `ENV-${productVariantId}`,
    variantName: "Pack of 50", category: "Mailers", categoryId: 5, categoryName: "Mailers", productLineIds: [7],
    productLineNames: ["Trading Card Supplies"], unitsPerVariant: 50,
    selectionDecision: { selected: reason === "selected", reason, picked, marketplaceQuantity: reason === "selected" ? 1_433 : 0,
      quantityCapApplied: false, autoConnectNewSkus: false, autoListNewSkus: false, includeRuleIds: [], excludeRuleIds: [] },
    ...extra,
  }));
}

describe("change set (reducer)", () => {
  it("C1 a toggle on an unpicked size adds it; a second toggle drops it; a picked size is removed and put back", () => {
    const start = changes([], []);
    const added = reduceChooseChanges(start, action({ type: "toggle", productVariantId: 102, savedChecked: false }));
    expect([ids(added.add), ids(added.remove), added.baseRevisionId]).toEqual([[102], [], 7]);
    const back = reduceChooseChanges(changes(added.add, added.remove), action({ type: "toggle", productVariantId: 102, savedChecked: false }));
    expect(chooseChangesEmpty(back)).toBe(true);
    const removed = reduceChooseChanges(start, action({ type: "toggle", productVariantId: 101, savedChecked: true }));
    expect([ids(removed.add), ids(removed.remove)]).toEqual([[], [101]]);
    expect(chooseChangesEmpty(reduceChooseChanges(changes(removed.add, removed.remove), action({ type: "toggle", productVariantId: 101, savedChecked: true })))).toBe(true);
  });

  it("C2 the sides stay disjoint: a stale add on a size that reads picked now becomes its remove", () => {
    const next = reduceChooseChanges(changes([101], []), action({ type: "toggle", productVariantId: 101, savedChecked: true }));
    expect([ids(next.add), ids(next.remove)]).toEqual([[], [101]]);
    expectDisjoint(next);
  });

  it("C3 the header box sets every changeable row shown, clearing a change that matches the saved pick and skipping the rest", () => {
    const rows = deepFreeze([
      { productVariantId: 101, savedChecked: true, changeable: true },
      { productVariantId: 102, savedChecked: false, changeable: true },
      { productVariantId: 103, savedChecked: false, changeable: false },
      { productVariantId: 104, savedChecked: true, changeable: true },
    ]);
    const start = changes([], [104, 900]);
    const checked = reduceChooseChanges(start, action({ type: "setShown", rows, checked: true }));
    // 104's remove is cleared (it is saved checked), 102 is added, 103 can't change, 900 (not shown) keeps its remove.
    expect([ids(checked.add), ids(checked.remove)]).toEqual([[102], [900]]);
    const unchecked = reduceChooseChanges(changes(checked.add, checked.remove), action({ type: "setShown", rows, checked: false }));
    expect([ids(unchecked.add), ids(unchecked.remove)]).toEqual([[], [101, 104, 900]]);
    expectDisjoint(unchecked);
  });

  it("C4 applyIds checked adds every not-selected id and clears the pending removes of the selected ones; unchecked the reverse", () => {
    const start = changes([50], [10, 11, 60]);
    const add = reduceChooseChanges(start, action({ type: "applyIds", selectedIds: [10, 11], notSelectedIds: [20, 21], checked: true }));
    expect([ids(add.add), ids(add.remove)]).toEqual([[20, 21, 50], [60]]);
    const remove = reduceChooseChanges(changes([20, 21, 50], [60]), action({ type: "applyIds", selectedIds: [10, 11], notSelectedIds: [20, 21], checked: false }));
    expect([ids(remove.add), ids(remove.remove)]).toEqual([[50], [10, 11, 60]]);
    expectDisjoint(remove);
  });

  it("C5 a null list (over 10,000) leaves the other side's pending changes as they are", () => {
    const start = changes([30], [10]);
    const add = reduceChooseChanges(start, action({ type: "applyIds", selectedIds: null, notSelectedIds: [20], checked: true }));
    expect([ids(add.add), ids(add.remove)]).toEqual([[20, 30], [10]]);
    const remove = reduceChooseChanges(start, action({ type: "applyIds", selectedIds: [11], notSelectedIds: null, checked: false }));
    expect([ids(remove.add), ids(remove.remove)]).toEqual([[30], [10, 11]]);
  });

  it("C6 an action that changes nothing returns the same object", () => {
    const start = changes([102], [101]);
    expect(reduceChooseChanges(start, action({ type: "setShown", rows: [{ productVariantId: 102, savedChecked: false, changeable: true }], checked: true }))).toBe(start);
    expect(reduceChooseChanges(start, action({ type: "applyIds", selectedIds: [], notSelectedIds: [102], checked: true }))).toBe(start);
    expect(reduceChooseChanges(start, action({ type: "rebase", revisionId: 7 }))).toBe(start);
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, action({ type: "undo" }))).toBe(EMPTY_CHOOSE_CHANGES);
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, action({ type: "saved" }))).toBe(EMPTY_CHOOSE_CHANGES);
  });

  it("C7 a rebase moves the base and keeps the changes; undo and saved clear them and keep the base", () => {
    const start = changes([102], [101], 7);
    const rebased = reduceChooseChanges(start, action({ type: "rebase", revisionId: 9 }));
    expect([ids(rebased.add), ids(rebased.remove), rebased.baseRevisionId]).toEqual([[102], [101], 9]);
    for (const type of ["undo", "saved"] as const) {
      const cleared = reduceChooseChanges(start, action({ type }));
      expect([cleared.add.size, cleared.remove.size, cleared.baseRevisionId]).toEqual([0, 0, 7]);
    }
    expect(chooseAdoptsHead(changes([], [], 7), 9)).toBe(true);
    expect(chooseAdoptsHead(changes([], [], 9), 9)).toBe(false);
    expect(chooseAdoptsHead(changes([], [], null), null)).toBe(false);
    // With changes pending the head is never adopted silently: the save's preview says stale instead.
    expect(chooseAdoptsHead(changes([1], [], 7), 9)).toBe(false);
  });

  it("C8 holds 20,000 ids (10,000 a side) and refuses whole an action past that, saying how many", () => {
    const full = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, action({ type: "applyIds", selectedIds: range(1, 10_000), notSelectedIds: range(20_001, 10_000), checked: true }));
    expect(full.add.size).toBe(10_000);
    const both = reduceChooseChanges(changes(full.add, []), action({ type: "applyIds", selectedIds: range(1, 10_000), notSelectedIds: null, checked: false }));
    expect([both.add.size, both.remove.size]).toEqual([10_000, 10_000]);
    expect(CHOOSE_CHANGE_IDS_MAX * 2).toBe(20_000);
    const frozen = changes(both.add, both.remove);
    const oneMore = action({ type: "toggle", productVariantId: 40_000, savedChecked: false });
    expect(reduceChooseChanges(frozen, oneMore)).toBe(frozen);
    expect(chooseActionOverLimit(frozen, oneMore)).toEqual({ add: 10_001, remove: 10_000 });
    expect(chooseActionOverLimit(frozen, action({ type: "toggle", productVariantId: 20_001, savedChecked: false }))).toBeNull();
    const overRemove = action({ type: "applyIds", selectedIds: range(50_000, 10_001), notSelectedIds: null, checked: false });
    expect(chooseActionOverLimit(EMPTY_CHOOSE_CHANGES, overRemove)).toEqual({ add: 0, remove: 10_001 });
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, overRemove)).toBe(EMPTY_CHOOSE_CHANGES);
  });

  it("C9 the body: both sides ascending, the base revision and this page's version; the key names exactly the changes", () => {
    const body = chooseChangeBody(changes([30, 10, 20], [5, 1], 42));
    expect(body).toEqual({ clientVersion: 3, expectedRevisionId: 42, add: { productVariantIds: [10, 20, 30] }, remove: { productVariantIds: [1, 5] } });
    expect(CATALOG_PAGE_CLIENT_VERSION).toBe(3);
    // The client's body parses with the shared strict schema the server reads.
    expect(selectionChangePreviewRequestSchema.safeParse(body).success).toBe(true);
    expect(chooseChangesKey(changes([30, 10], [5], 42))).toBe("42|10,30|5");
    expect(chooseChangesKey(changes([10, 30], [5], null))).toBe("none|10,30|5");
    expect(chooseCounts(changes([1, 2], [3]))).toEqual({ add: 2, remove: 1 });
  });

  it("C10 20,000 ids are about 140 KB: over an older dyno's 100 KiB parser, within the bulk parser's 1 MiB", () => {
    const body = { ...chooseChangeBody(changes(range(1_000_000, 10_000), range(2_000_000, 10_000), 2_147_000_000)),
      idempotencyKey: `catalog-selection:${"0".repeat(36)}`, expectedEffectsHash: "a".repeat(64) };
    const bytes = chooseBodyBytes(body);
    expect(bytes).toBeGreaterThan(100 * 1024);
    expect(bytes).toBeLessThan(CHOOSE_BULK_BODY_LIMIT_BYTES);
    expect(bytes).toBeLessThan(200 * 1024);
  });

  it("C11 an unknown action is a programming error", () => {
    expect(() => reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "nope" } as unknown as ChooseChangesAction)).toThrow(/Unknown catalog choose action/);
  });

  it("C12 (review round 1 CLI-4) the head is adopted only forward: a cached older head never pulls an empty set's base back; a null base takes the first head", () => {
    // Revision ids are serial and the head is the newest (dropship_selection_rule_revisions), so a head never goes down.
    expect(chooseHeadMovedPast(7, 8)).toBe(true);
    expect(chooseHeadMovedPast(null, 7)).toBe(true);
    expect(chooseHeadMovedPast(8, 8)).toBe(false);
    expect(chooseHeadMovedPast(8, 7)).toBe(false);
    expect(chooseHeadMovedPast(7, null)).toBe(false);
    expect(chooseHeadMovedPast(null, null)).toBe(false);
    // After our own save the base is its revision (8) while the count read again still holds 7: the base stays 8.
    expect(chooseAdoptsHead(changes([], [], 8), 7)).toBe(false);
    expect(chooseAdoptsHead(changes([], [], 8), 9)).toBe(true);
    // Before any count was read the base is null: the first count's head is adopted.
    expect(chooseAdoptsHead(changes([], [], null), 7)).toBe(true);
    expect(chooseAdoptsHead(changes([], [], 7), null)).toBe(false);
    // Pending changes still never move by themselves.
    expect(chooseAdoptsHead(changes([1], [], null), 7)).toBe(false);
  });
});

describe("row model (from picked, V24)", () => {
  const none = changes([], []);

  it("V1 a picked selected size is checked, picked by you, with its quantity", () => {
    expect(chooseRowView(row(101, "selected", true), none)).toEqual({
      checked: true, savedChecked: true, changed: null, changeable: true, how: "picked", quantity: 1_433, tierOff: false, pickTurnedOff: false,
    });
  });

  it("V2 an unpicked size is unchecked and changeable; a pending add says Will be added and shows checked", () => {
    expect(chooseRowView(row(102, "missing_vendor_include_rule", false), none)).toMatchObject({ checked: false, changeable: true, how: "notSelected", quantity: null });
    expect(chooseRowView(row(102, "missing_vendor_include_rule", false), changes([102], []))).toMatchObject({ checked: true, changed: "add", how: "willAdd" });
    expect(chooseRowView(row(101, "selected", true), changes([], [101]))).toMatchObject({ checked: false, changed: "remove", how: "willRemove", quantity: 1_433 });
  });

  it("V3 a pending change that equals the saved pick shows no change", () => {
    expect(chooseRowView(row(101, "selected", true), changes([101], []))).toMatchObject({ checked: true, changed: null, how: "picked" });
    expect(chooseRowView(row(102, "missing_vendor_include_rule", false), changes([], [102]))).toMatchObject({ checked: false, changed: null, how: "notSelected" });
  });

  it("V4 turned off with the pick saved: checked, can only remove the pick, and says so; with no pick it can't change", () => {
    const offPicked = chooseRowView(row(104, "disabled_by_vendor_override", true), none);
    expect(offPicked).toMatchObject({ checked: true, changeable: true, how: "turnedOff", pickTurnedOff: true, quantity: null });
    expect(chooseRowView(row(104, "disabled_by_vendor_override", true), changes([], [104]))).toMatchObject({ checked: false, how: "willRemove" });
    expect(chooseRowView(row(105, "disabled_by_vendor_override", false), none)).toMatchObject({ checked: false, changeable: false, how: "turnedOff", pickTurnedOff: false });
  });

  it("V5 not offered can't change; a keep-out reason from older code reads as not selected", () => {
    expect(chooseRowView(row(106, "not_exposed_by_admin", true), none)).toMatchObject({ changeable: false, how: "notOffered", quantity: null });
    expect(chooseRowView(row(107, "excluded_by_vendor_rule", false), none)).toMatchObject({ changeable: true, how: "notSelected" });
    expect(chooseSavedState(row(106, "not_exposed_by_admin", false))).toEqual({ productVariantId: 106, savedChecked: false, changeable: false });
  });

  it("V6 only a selected size shows its tier badge", () => {
    const tier = { tier: "case", eligible: false, reason: "balance_below_tier", policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 38_000 };
    expect(chooseRowView(row(101, "selected", true, { listingTier: tier }), none).tierOff).toBe(true);
    expect(chooseRowView(row(102, "missing_vendor_include_rule", false, { listingTier: tier }), none).tierOff).toBe(false);
    expect(chooseRowView(row(101, "selected", true, { listingTier: { ...tier, eligible: true, reason: null } }), none).tierOff).toBe(false);
  });

  it("V7 the header box: all, some, none, and off with no changeable row", () => {
    const rows = [row(101, "selected", true), row(102, "missing_vendor_include_rule", false), row(105, "disabled_by_vendor_override", false)];
    expect(shownTick(rows, changes([102], []))).toEqual({ tick: "all", changeable: 2 });
    expect(shownTick(rows, none)).toEqual({ tick: "some", changeable: 2 });
    expect(shownTick(rows, changes([], [101]))).toEqual({ tick: "none", changeable: 2 });
    expect(shownTick([row(105, "disabled_by_vendor_override", false)], none)).toEqual({ tick: "none", changeable: 0 });
  });

  it("V8 a row needs picked and a category id: an older dyno's row (no picked) is off the contract; rule ids and product lines are dropped", () => {
    const base = { productId: 1, productVariantId: 2, productSku: null, productName: "P", variantSku: null, variantName: "S", category: null,
      categoryId: null, selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 1, includeRuleIds: [3], excludeRuleIds: [] } };
    expect(chooseCatalogRowSchema.safeParse(base).success).toBe(false);
    const withPick = chooseCatalogRowSchema.parse({ ...base, productLineNames: ["Trading Card Supplies"], selectionDecision: { ...base.selectionDecision, picked: true } });
    expect(JSON.stringify(withPick)).not.toMatch(/includeRuleIds|excludeRuleIds|Trading Card Supplies/);
    const { categoryId: _categoryId, ...noCategoryId } = base;
    expect(chooseCatalogRowSchema.safeParse({ ...noCategoryId, selectionDecision: { ...base.selectionDecision, picked: true } }).success).toBe(false);
    expect(chooseCatalogRowSchema.safeParse({ ...base, selectionDecision: { ...base.selectionDecision, picked: true, reason: "kept_out" } }).success).toBe(false);
  });

  it("V9 a page accepts facets: null and requires the summary", () => {
    const page = { rows: [], total: 0, page: 1, limit: 200, facets: null, summary: { matching: 0, matchingSelected: 0 } };
    expect(chooseCatalogPageSchema.safeParse(page).success).toBe(true);
    const { summary: _summary, ...noSummary } = page;
    expect(chooseCatalogPageSchema.safeParse(noSummary).success).toBe(false);
  });
});

describe("room under the cap (§12.3)", () => {
  it("M1 room = cap − selected − add + remove, never below 0", () => {
    expect(chooseRoom({ selectedTotal: 4_000, cap: 10_000 }, changes(range(1, 1_500), range(20_000, 400)))).toEqual({
      selected: 4_000, after: 5_100, room: 4_900, grows: true, overCapAdd: false, overCapState: false,
    });
    expect(chooseRoom({ selectedTotal: 9_000, cap: 10_000 }, changes(range(1, 1_500), range(20_000, 400)))).toMatchObject({ after: 10_100, room: 0, overCapAdd: true });
    expect(chooseRoom({ selectedTotal: 9_000, cap: 10_000 }, changes(range(1, 1_000), []))).toMatchObject({ after: 10_000, room: 0, overCapAdd: false });
    expect(CHOOSE_SELECTION_CAP).toBe(10_000);
  });

  it("M2 an over-cap vendor (10,050) may always remove; adding one is refused before sending", () => {
    expect(chooseRoom({ selectedTotal: 10_050, cap: 10_000 }, changes([], range(1, 100)))).toMatchObject({ after: 9_950, grows: false, overCapAdd: false, overCapState: true });
    expect(chooseRoom({ selectedTotal: 10_050, cap: 10_000 }, changes([1], []))).toMatchObject({ after: 10_051, grows: true, overCapAdd: true, overCapState: true });
    // A swap that does not grow the count is a shrinking-or-equal change: allowed even over the cap.
    expect(chooseRoom({ selectedTotal: 10_050, cap: 10_000 }, changes([1], [2]))).toMatchObject({ grows: false, overCapAdd: false });
  });

  it("M3 zero: nothing selected and nothing pending", () => {
    expect(chooseRoom({ selectedTotal: 0, cap: 10_000 }, EMPTY_CHOOSE_CHANGES)).toEqual({
      selected: 0, after: 0, room: 10_000, grows: false, overCapAdd: false, overCapState: false,
    });
  });
});

describe("bulk controls (§12.3)", () => {
  /** A row in a category, frozen like every input. */
  const inCategory = (productVariantId: number, categoryId: number | null, reason: ChooseSelectionReason, picked: boolean) =>
    row(productVariantId, reason, picked, { categoryId });
  const counts = (categoryId: number, rowCount: number, selectedCount: number) => deepFreeze({ categoryId, rowCount, selectedCount });
  const frozenKnown = (known: ChooseKnown): ChooseKnown => deepFreeze(known);

  it("B1 the Check all line follows the header box: checked every row shown and more match → Check all; unchecked → Uncheck all", () => {
    const base = { changeable: 200, shown: 200, total: 1_433, changed: null, applied: false } as const;
    expect(chooseMatchLine({ ...base, tick: "all", lastHeader: true })).toEqual({ purpose: "add", total: 1_433, shownChecked: 200, changed: null });
    expect(chooseMatchLine({ ...base, tick: "none", lastHeader: false })).toEqual({ purpose: "remove", total: 1_433, shownChecked: null, changed: null });
    // Not after a row's own box, not while some rows differ, not once everything matching is shown, not once applied.
    expect(chooseMatchLine({ ...base, tick: "all", lastHeader: null })).toBeNull();
    expect(chooseMatchLine({ ...base, tick: "some", lastHeader: true })).toBeNull();
    expect(chooseMatchLine({ ...base, tick: "none", lastHeader: true })).toBeNull();
    expect(chooseMatchLine({ ...base, tick: "all", lastHeader: true, total: 200 })).toBeNull();
    expect(chooseMatchLine({ ...base, tick: "all", lastHeader: true, applied: true })).toBeNull();
    expect(chooseMatchLine({ ...base, tick: "all", lastHeader: true, changeable: 0 })).toBeNull();
    // "All {shown} shown are checked" counts the rows a box can change (a turned-off row is shown but never checked).
    expect(chooseMatchLine({ ...base, changeable: 197, tick: "all", lastHeader: true })?.shownChecked).toBe(197);
  });

  it("B2 more matching at the press than the button said: the line says so and asks again with the new number; fewer is not a change", () => {
    const changed = { purpose: "add" as const, now: 1_500, was: 1_433 };
    const line = chooseMatchLine({ tick: "all", changeable: 200, shown: 200, total: 1_433, lastHeader: true, changed, applied: false });
    expect(line).toEqual({ purpose: "add", total: 1_500, shownChecked: 200, changed: { now: 1_500, was: 1_433 } });
    expect(CHOOSE_WORDS.matchChanged(1_500, 1_433)).toBe("1,500 now match (was 1,433).");
    // A change found for the other purpose says nothing here.
    expect(chooseMatchLine({ tick: "none", changeable: 200, shown: 200, total: 1_433, lastHeader: false, changed, applied: false })?.changed).toBeNull();
    expect(chooseMatchGrew(1_434, 1_433)).toBe(true);
    // The ids count only changeable sizes: three turned off among 1,433 read 1,430, which is no change.
    expect(chooseMatchGrew(1_430, 1_433)).toBe(false);
    expect(chooseMatchGrew(1_433, 1_433)).toBe(false);
  });

  it("B3 what the page learns: rows across filters, a category's id read (complete without search or Show), Select everything; another revision forgets", () => {
    const empty = frozenKnown(emptyChooseKnown(7));
    const rows = [inCategory(1, 5, "selected", true), inCategory(2, 5, "missing_vendor_include_rule", false), inCategory(3, null, "selected", true)];
    const learned = learnChooseRows(empty, rows);
    expect(learned).not.toBe(empty);
    expect([...learned.sizes.entries()]).toEqual([[1, { categoryId: 5, selected: true }], [2, { categoryId: 5, selected: false }], [3, { categoryId: null, selected: true }]]);
    // Rows already known change nothing: the same object.
    expect(learnChooseRows(frozenKnown(learned), rows)).toBe(learned);
    const byCategory = learnChooseIds(frozenKnown(learned), { categoryId: 9, whole: true }, deepFreeze({ selectedIds: [10], notSelectedIds: [11, 12] }));
    expect(byCategory.sizes.get(11)).toEqual({ categoryId: 9, selected: false });
    expect([...(byCategory.categories.get(9)?.notSelectedIds ?? [])]).toEqual([11, 12]);
    // With a search (or a Show filter) the ids are the category's but not all of it; a null list is not complete.
    expect(learnChooseIds(empty, { categoryId: 9, whole: false }, { selectedIds: [10], notSelectedIds: [11] }).categories.size).toBe(0);
    expect(learnChooseIds(empty, { categoryId: 9, whole: true }, { selectedIds: null, notSelectedIds: [11] }).categories.size).toBe(0);
    const everything = learnChooseIds(empty, { categoryId: null, whole: true }, { selectedIds: [1], notSelectedIds: [2, 20] });
    expect([...(everything.everything?.notSelectedIds ?? [])]).toEqual([2, 20]);
    expect(everything.sizes.size).toBe(0);
    expect(learnChooseIds(empty, { categoryId: null, whole: false }, { selectedIds: [1], notSelectedIds: [2] })).toBe(empty);
    expect(chooseKnownAt(byCategory, 7)).toBe(byCategory);
    expect(chooseKnownAt(byCategory, 8)).toEqual(emptyChooseKnown(8));
  });

  it("B4 a category's box from the counts: selected plus its known pending adds, minus its known pending removes of selected sizes (B2a observation)", () => {
    const known = frozenKnown(learnChooseRows(emptyChooseKnown(7), [
      inCategory(1, 5, "selected", true), inCategory(2, 5, "missing_vendor_include_rule", false),
      inCategory(3, 5, "disabled_by_vendor_override", true), inCategory(4, 6, "missing_vendor_include_rule", false),
    ]));
    const categories = [counts(5, 3, 1), counts(6, 1, 0), counts(8, 2, 2), counts(9, 0, 0)];
    const saved = chooseCategoryTicks(categories, changes([], []), known);
    expect(saved.get(5)).toEqual({ tick: "some", empty: false });
    expect(saved.get(6)).toEqual({ tick: "none", empty: false });
    expect(saved.get(8)).toEqual({ tick: "all", empty: false });
    expect(saved.get(9)).toEqual({ tick: "none", empty: false });
    // A pending add counts in its category; the other category does not move.
    const added = chooseCategoryTicks(categories, changes([4], []), known);
    expect(added.get(6)?.tick).toBe("all");
    expect(added.get(5)?.tick).toBe("some");
    // A pending remove of the only selected size unticks the category to none; a turned-off pick's remove moves nothing.
    expect(chooseCategoryTicks(categories, changes([], [1]), known).get(5)?.tick).toBe("none");
    expect(chooseCategoryTicks(categories, changes([], [3]), known).get(5)?.tick).toBe("some");
    // A pending change whose category is not known counts nowhere.
    expect(chooseCategoryTicks(categories, changes([999], [998]), known)).toEqual(saved);
  });

  it("B4b (review round 1 CLI-5) a pending add of a size already selected (kept after a stale stop) is in selectedCount already: never counted twice", () => {
    // X (1) is selected, Y (2) is not, both in category 5: "1 of 2 selected". Another tab picked X while this tab's
    // add of X was pending; the stale stop kept the add and the rows read again teach X as selected (J21, C5).
    const known = frozenKnown(learnChooseRows(emptyChooseKnown(7), [
      inCategory(1, 5, "selected", true), inCategory(2, 5, "missing_vendor_include_rule", false),
    ]));
    const categories = [counts(5, 2, 1)];
    const keptAdd = chooseCategoryTicks(categories, changes([1], []), known).get(5);
    expect(keptAdd).toEqual({ tick: "some", empty: false });
    // So a press of the box adds Y, never removes X.
    expect(chooseCategoryPurpose(keptAdd?.tick ?? "none")).toBe("add");
    // With Y marked to add too, every size of the category is checked.
    expect(chooseCategoryTicks(categories, changes([1, 2], []), known).get(5)).toEqual({ tick: "all", empty: false });
    expect(chooseCategoryTicks(categories, changes([2], []), known).get(5)).toEqual({ tick: "all", empty: false });
  });

  it("B5 after its own id read a category's box is exact: a size turned off for the vendor no longer keeps it from reading ticked", () => {
    const categories = [counts(5, 4, 3)];
    // 4 rows, 3 selected, 1 turned off: the counts alone read "some".
    expect(chooseCategoryTicks(categories, changes([], []), emptyChooseKnown(7)).get(5)?.tick).toBe("some");
    const known = frozenKnown(learnChooseIds(emptyChooseKnown(7), { categoryId: 5, whole: true }, { selectedIds: [1, 2, 3], notSelectedIds: [] }));
    expect(chooseCategoryTicks(categories, changes([], []), known).get(5)).toEqual({ tick: "all", empty: false });
    expect(chooseCategoryTicks(categories, changes([], [2]), known).get(5)?.tick).toBe("some");
    expect(chooseCategoryTicks(categories, changes([], [1, 2, 3]), known).get(5)?.tick).toBe("none");
    const adds = frozenKnown(learnChooseIds(emptyChooseKnown(7), { categoryId: 5, whole: true }, { selectedIds: [1], notSelectedIds: [2, 3] }));
    expect(chooseCategoryTicks(categories, changes([2, 3], []), adds).get(5)?.tick).toBe("all");
    // Nothing in it a box can change: the box is off.
    const none = learnChooseIds(emptyChooseKnown(7), { categoryId: 5, whole: true }, { selectedIds: [], notSelectedIds: [] });
    expect(chooseCategoryTicks(categories, changes([], []), none).get(5)).toEqual({ tick: "none", empty: true });
  });

  it("B6 after Select everything every category reads ticked; a size left unchecked in a known category unticks only that one", () => {
    const categories = [counts(5, 2, 0), counts(6, 1, 1), counts(7, 3, 0)];
    let known = learnChooseIds(emptyChooseKnown(7), { categoryId: null, whole: true }, { selectedIds: [3], notSelectedIds: [1, 2, 4, 5, 6] });
    known = frozenKnown(learnChooseRows(known, [inCategory(1, 5, "missing_vendor_include_rule", false), inCategory(3, 6, "selected", true)]));
    const all = chooseCategoryTicks(categories, changes([1, 2, 4, 5, 6], []), known);
    expect([...all.values()].map((value) => value.tick)).toEqual(["all", "all", "all"]);
    // Size 1 (category 5) unchecked again: only category 5 reads "some".
    const one = chooseCategoryTicks(categories, changes([2, 4, 5, 6], []), known);
    expect([one.get(5)?.tick, one.get(6)?.tick, one.get(7)?.tick]).toEqual(["some", "all", "all"]);
    // A size left out whose category is unknown: back to the counts (nothing known pending in 7, so its saved state).
    expect(chooseCategoryTicks(categories, changes([1, 2, 4, 5], []), known).get(7)?.tick).toBe("none");
  });

  it("B7 a category's press: a ticked box removes, any other adds", () => {
    expect(chooseCategoryPurpose("all")).toBe("remove");
    expect(chooseCategoryPurpose("some")).toBe("add");
    expect(chooseCategoryPurpose("none")).toBe("add");
  });

  it("B8 Select everything counts every size offered and is off while the room is smaller than what is not yet selected (D27)", () => {
    const categories = deepFreeze({ categories: [{ rowCount: 3_000 }, { rowCount: 1_200 }], uncategorizedCount: 100 });
    expect(chooseEverything(categories, { selectedTotal: 0, cap: 10_000 }, EMPTY_CHOOSE_CHANGES)).toEqual({ offered: 4_300, disabled: false, overRoom: false });
    const big = deepFreeze({ categories: [{ rowCount: 12_000 }], uncategorizedCount: 0 });
    expect(chooseEverything(big, { selectedTotal: 9_000, cap: 10_000 }, EMPTY_CHOOSE_CHANGES)).toEqual({ offered: 12_000, disabled: true, overRoom: true });
    // An over-cap vendor has no room at all.
    expect(chooseEverything(big, { selectedTotal: 10_050, cap: 10_000 }, EMPTY_CHOOSE_CHANGES)).toMatchObject({ disabled: true, overRoom: true });
    // Everything already checked: nothing to add, off without a room reason.
    expect(chooseEverything(categories, { selectedTotal: 4_000, cap: 10_000 }, changes(range(1, 300), []))).toEqual({ offered: 4_300, disabled: true, overRoom: false });
    // Zero offered.
    expect(chooseEverything({ categories: [], uncategorizedCount: 0 }, { selectedTotal: 0, cap: 10_000 }, EMPTY_CHOOSE_CHANGES)).toEqual({ offered: 0, disabled: true, overRoom: false });
  });

  it("B9 a bulk press that changed nothing says why: too many at once (the server's count, else the button's), or the read failed", () => {
    const tooMany = new DropshipApiError({ message: "x", status: 422, code: DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany, context: { needed: 10_050 } });
    expect(describeChooseIdsFailure(tooMany, 9_000)).toBe(CHOOSE_WORDS.tooManyMatch(10_050));
    expect(CHOOSE_WORDS.tooManyMatch(10_050)).toBe("Too many to change at once (10,050). Search or pick a category to narrow the list.");
    const unnamed = new DropshipApiError({ message: "x", status: 422, code: DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany });
    expect(describeChooseIdsFailure(unnamed, 9_000)).toBe(CHOOSE_WORDS.tooManyMatch(9_000));
    expect(describeChooseIdsFailure(new TypeError("Failed to fetch"), 1)).toBe(CHOOSE_WORDS.catalogFailedText);
  });
});

type StoreEffects = SelectionChangePreviewAnswer["effects"][number];

/** One store's counts as the server sends them (PR C's `ends` and `storeConnected` included). */
function storeEffects(storeConnectionId: number, storeName: string, counts: Partial<Omit<StoreEffects, "storeConnectionId" | "storeName">> = {}): StoreEffects {
  return { storeConnectionId, storeName, platform: "ebay", goesToZero: 0, startsSelling: 0, ends: 0, storeConnected: true, ...counts };
}

/** PR C's vendor-level ends (none by default, as every answer PR B stored). */
function endsOf(overrides: Partial<SelectionChangeEnds> = {}): SelectionChangeEnds {
  return { ...emptySelectionChangeEnds(), ...overrides };
}

function preview(overrides: Partial<SelectionChangePreviewAnswer> = {}): SelectionChangePreviewAnswer {
  return deepFreeze({
    headRevisionId: 7, toAdd: 3, toRemove: 2, alreadySelected: 0, alreadyNotSelected: 0, skipped: { count: 0, first: [] },
    selectedBefore: 10, selectedAfter: 11, cap: 10_000, overCapAfter: false, refused: null,
    effects: [
      storeEffects(1, "Card Corner", { goesToZero: 12, startsSelling: 8 }),
      storeEffects(2, "Second Store", { startsSelling: 1 }),
    ],
    effectsHash: "a".repeat(64), otherEntriesHash: "c".repeat(64), ends: endsOf(),
    ...overrides,
  } satisfies SelectionChangePreviewAnswer);
}

function answer(overrides: Partial<SelectionChangeAnswer>): SelectionChangeAnswer {
  const { headRevisionId: _head, refused: _refused, ...planned } = preview();
  return { ...planned, revisionId: 9, confirmedEffectsHash: "a".repeat(64), drifted: false, ...overrides };
}

describe("the save question and the saved line (§13; PLAN-C v4.1 §11)", () => {
  it("Q1 counts, then each store's quantity 0 and resumes in the server's order, then every store; no line says a listing is not ended", () => {
    expect(describeChooseConfirm(preview({ alreadySelected: 2, alreadyNotSelected: 1 }))).toEqual([
      "3 added · 2 removed · 3 were already as you chose",
      "On Card Corner: 12 listings are set to quantity 0, so buyers can't buy them.",
      "On Card Corner: 8 listings get their quantity back shortly after you save, at the price they have on eBay now. To send today's prices, publish them in step 3.",
      CHOOSE_WORDS.confirmResume("Second Store", 1),
      "Your choice applies to all your stores.",
    ]);
    // B's "Their listings aren't ended" is gone (PLAN-C v4.1 §11): a removal now ends its eBay listings instead.
    for (const line of describeChooseConfirm(preview())) expect(line).not.toMatch(/aren't ended/);
  });

  it("Q2 no store with any entry says nothing changes; an add-only change never says anything is ended", () => {
    const quiet = describeChooseConfirm(preview({ toRemove: 0, effects: [storeEffects(1, "Card Corner")] }));
    expect(quiet).toEqual(["3 added · 0 removed", "Nothing changes on your eBay listings now.", "Your choice applies to all your stores."]);
    // No store at all (no connected store): the same.
    expect(describeChooseConfirm(preview({ toRemove: 0, effects: [] }))).toEqual(quiet);
    // No ended-listing line exists (V20, FIDELITY-9): an ended listing is counted nowhere.
    for (const line of describeChooseConfirm(preview())) expect(line).not.toMatch(/\bended on eBay\b|relist/i);
  });

  it("Q3 the saved line from the server's answer; drift, ends and skipped sizes are said, in that order", () => {
    expect(describeChooseSaved(answer({}))).toBe("Saved. 3 added, 2 removed.");
    expect(describeChooseSaved(answer({ drifted: true, effectsHash: "b".repeat(64) })))
      .toBe("Saved. A few listings changed on eBay while you were deciding; 12 listings are set to quantity 0.");
    expect(describeChooseSaved(answer({ skipped: { count: 2, first: [5, 6] } })))
      .toBe("Saved. 3 added, 2 removed. 2 are no longer offered by Card Shellz and were skipped.");
    // PR C: the ends follow B's line, then the skipped sizes.
    const ending = { ends: endsOf({ listingIds: [5_000_101] }), effects: [storeEffects(1, "Card Corner", { ends: 1 })] };
    expect(describeChooseSaved(answer({ ...ending, toAdd: 0, toRemove: 1 }))).toBe("Saved. 0 added, 1 removed. 1 eBay listing is being ended.");
    expect(describeChooseSaved(answer({ ...ending, toAdd: 1, toRemove: 1, skipped: { count: 1, first: [7] } })))
      .toBe("Saved. 1 added, 1 removed. 1 eBay listing is being ended. 1 is no longer offered by Card Shellz and was skipped.");
    // Drift counts the listings set to quantity 0 and the ends (both stop selling, FID-14), then says the ends.
    const drifted = answer({ toAdd: 0, toRemove: 3, drifted: true, effectsHash: "b".repeat(64),
      ends: endsOf({ listingIds: [5_000_101, 5_000_102], otherSizes: 1 }),
      effects: [storeEffects(1, "Card Corner", { ends: 2 }), storeEffects(3, "Test Shop", { goesToZero: 1 })] });
    expect(describeChooseSaved(drifted))
      .toBe("Saved. A few listings changed on eBay while you were deciding; 3 listings are set to quantity 0. 2 eBay listings are being ended.");
    // An answer PR B stored (no ends, defaulted) reads as before.
    expect(describeChooseSaved(answer({ ends: emptySelectionChangeEnds() }))).toBe("Saved. 3 added, 2 removed.");
  });

  it("Q4 (review round 1 CLI-6) removals no store sets to quantity 0 or ends: nothing about eBay but that nothing changes", () => {
    // Five removals whose listings never existed or ended on eBay (V20's no-entry cases): nothing changes there.
    const removalOnly = describeChooseConfirm(preview({ toAdd: 0, toRemove: 5, effects: [storeEffects(1, "Card Corner")] }));
    expect(removalOnly).toEqual(["0 added · 5 removed", CHOOSE_WORDS.confirmNone, CHOOSE_WORDS.confirmScope]);
    // No store at all: the same.
    expect(describeChooseConfirm(preview({ toAdd: 0, toRemove: 5, effects: [] }))).toEqual(removalOnly);
    // The only entries are the adds' resumes.
    expect(describeChooseConfirm(preview({ toAdd: 3, toRemove: 2, effects: [storeEffects(1, "Card Corner", { startsSelling: 3 })] })))
      .toEqual(["3 added · 2 removed", CHOOSE_WORDS.confirmResume("Card Corner", 3), CHOOSE_WORDS.confirmScope]);
    // One listing set to quantity 0 (a Shopify store keeps quantity 0, D18): its line, and no other.
    expect(describeChooseConfirm(preview({ toAdd: 0, toRemove: 2, effects: [storeEffects(1, "Card Corner"),
      storeEffects(2, "Second Store", { platform: "shopify", goesToZero: 1 })] })))
      .toEqual(["0 added · 2 removed", CHOOSE_WORDS.confirmZero("Second Store", 1), CHOOSE_WORDS.confirmScope]);
  });

  it("Q5 (PLAN-C v4.1 §11) per store its ends, then quantity 0 and resumes; then the vendor-level end lines; nothing changes is left out", () => {
    const lines = describeChooseConfirm(preview({
      toAdd: 3, toRemove: 2,
      effects: [
        storeEffects(3, "Test Shop", { platform: "shopify", goesToZero: 2 }),
        storeEffects(5, "Marz Cards", { ends: 4, startsSelling: 1 }),
        storeEffects(9, "Marz Cards Outlet", { ends: 1, storeConnected: false }),
      ],
      ends: endsOf({ listingIds: [1, 2, 3, 4, 5], hiddenRemovedIds: [901, 902], otherSizes: 3, stillEnding: 1, endReview: 2, endedReAdd: 1 }),
    }));
    expect(lines).toEqual([
      "3 added · 2 removed",
      CHOOSE_WORDS.confirmZero("Test Shop", 2),
      "On Marz Cards: 4 eBay listings will be ended. To sell one again later, choose it here and publish it in step 3.",
      CHOOSE_WORDS.confirmResume("Marz Cards", 1),
      "On Marz Cards Outlet: 1 eBay listing will be ended when the store can be used again. It stays at quantity 0 until then.",
      CHOOSE_WORDS.confirmEndOtherSizes(3),
      CHOOSE_WORDS.confirmEndHidden(2),
      CHOOSE_WORDS.confirmStillEnding(1),
      CHOOSE_WORDS.confirmEndReview(2),
      CHOOSE_WORDS.confirmEndedReAdd(1),
      CHOOSE_WORDS.confirmScope,
    ]);
    expect(lines).not.toContain(CHOOSE_WORDS.confirmNone);
    // A store's own end line comes before its quantity 0 (FID-14: an end is not a quantity 0).
    const both = describeChooseConfirm(preview({ toAdd: 0, toRemove: 2, effects: [storeEffects(5, "Marz Cards", { ends: 1, goesToZero: 1 })],
      ends: endsOf({ listingIds: [1] }) }));
    expect(both).toEqual(["0 added · 2 removed", CHOOSE_WORDS.confirmEnd("Marz Cards", 1), CHOOSE_WORDS.confirmZero("Marz Cards", 1), CHOOSE_WORDS.confirmScope]);
  });

  it("Q6 (PLAN-C v4.1 §11) vendor-level lines alone stand in for nothing changes: an add whose listing is still being ended", () => {
    expect(describeChooseConfirm(preview({ toAdd: 1, toRemove: 0, effects: [storeEffects(5, "Marz Cards")], ends: endsOf({ stillEnding: 1 }) })))
      .toEqual(["1 added · 0 removed", CHOOSE_WORDS.confirmStillEnding(1), CHOOSE_WORDS.confirmScope]);
    expect(describeChooseConfirm(preview({ toAdd: 2, toRemove: 0, effects: [], ends: endsOf({ endReview: 1, endedReAdd: 1 }) })))
      .toEqual(["2 added · 0 removed", CHOOSE_WORDS.confirmEndReview(1), CHOOSE_WORDS.confirmEndedReAdd(1), CHOOSE_WORDS.confirmScope]);
    // A wholly removed product whose hidden pick has no listing: its line still says the pick goes.
    expect(describeChooseConfirm(preview({ toAdd: 0, toRemove: 1, effects: [storeEffects(5, "Marz Cards")], ends: endsOf({ hiddenRemovedIds: [902] }) })))
      .toEqual(["0 added · 1 removed", CHOOSE_WORDS.confirmEndHidden(1), CHOOSE_WORDS.confirmScope]);
  });

  it("Q7 (PLAN-C v4.1 §11) the question's button names the eBay listings it ends, from the vendor-level set; else Save changes", () => {
    expect(describeChooseConfirmButton(preview())).toBe("Save changes");
    expect(describeChooseConfirmButton(preview({ ends: endsOf({ listingIds: [5_000_101] }) }))).toBe("End 1 listing and save");
    expect(describeChooseConfirmButton(preview({ ends: endsOf({ listingIds: [5_000_101, 5_000_102, 9_000_102] }) }))).toBe("End 3 listings and save");
    // Hidden removals and re-add reports end nothing on eBay by this save: the plain button.
    expect(describeChooseConfirmButton(preview({ ends: endsOf({ hiddenRemovedIds: [902], stillEnding: 2, endReview: 1, endedReAdd: 1 }) })))
      .toBe("Save changes");
  });
});

describe("error classes (§12.4, §12.5, §14)", () => {
  const small = { bodyBytes: 2_000 };
  const api = (status: number, code: string | null, context: Record<string, unknown> | null = null, message = "Server words.") =>
    new DropshipApiError({ status, code, context, message });

  it("E1 writes paused, site updating and an older dyno's 413 follow the paused schedule", () => {
    expect(classifyChooseSaveError(api(503, SELECTION_CHANGE_ERROR_CODES.writesPaused, { reason: "older_version_running" }), small)).toEqual({ kind: "paused" });
    expect(classifyChooseSaveError(api(503, DROPSHIP_SITE_UPDATING_CODE, { reason: "not_json" }), small)).toEqual({ kind: "paused" });
    expect(classifyChooseSaveError(api(503, DROPSHIP_SITE_UPDATING_CODE, { reason: "answer_shape" }), small)).toEqual({ kind: "paused" });
    // §12.5: a 413 without the bulk parser's code, for a body within its 1 MiB, came from an older dyno's 100 KiB parser.
    expect(classifyChooseSaveError(api(413, null), { bodyBytes: 140_000 })).toEqual({ kind: "paused" });
    expect(classifyChooseSaveError(api(413, null), { bodyBytes: CHOOSE_BULK_BODY_LIMIT_BYTES })).toEqual({ kind: "paused" });
    expect(classifyChooseSaveError(api(413, null), { bodyBytes: CHOOSE_BULK_BODY_LIMIT_BYTES + 1 })).toEqual({ kind: "tooLarge" });
    expect(classifyChooseSaveError(api(413, SELECTION_CHANGE_ERROR_CODES.requestTooLarge), small)).toEqual({ kind: "tooLarge" });
  });

  it("E2 busy, revision conflict (with the head the server named), effects changed, key conflict", () => {
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.busy), small)).toEqual({ kind: "busy" });
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.revisionConflict, { currentRevisionId: 12 }), small)).toEqual({ kind: "stale", headRevisionId: 12 });
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.revisionConflict, { currentRevisionId: null }), small)).toEqual({ kind: "stale", headRevisionId: null });
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.revisionConflict, { currentRevisionId: "12" }), small)).toEqual({ kind: "stale", headRevisionId: undefined });
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.effectsChanged), small)).toEqual({ kind: "effectsChanged" });
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.keyConflict), small)).toEqual({ kind: "keyConflict" });
  });

  it("E3 PR C's 409 page outdated and the 410 rules retired both say retired (Reload); another 410 is the server's words", () => {
    expect(classifyChooseSaveError(api(409, SELECTION_CHANGE_ERROR_CODES.pageOutdated), small)).toEqual({ kind: "retired" });
    expect(classifyChooseSaveError(api(410, DROPSHIP_CATALOG_READ_ERROR_CODES.rulesRetired), small)).toEqual({ kind: "retired" });
    expect(classifyChooseSaveError(api(410, "SOMETHING_ELSE"), small)).toEqual({ kind: "permanent", message: "Server words." });
  });

  it("E3b PR C's 422 REMOVAL_TOO_LARGE is its own class, never the over-cap one (FID-4)", () => {
    expect(classifyChooseSaveError(api(422, SELECTION_CHANGE_ERROR_CODES.removalTooLarge, { factSizes: 30_001, limit: 30_000 }), small))
      .toEqual({ kind: "tooManyRemoved" });
    expect(classifyChooseSaveError(api(422, SELECTION_CHANGE_ERROR_CODES.tooLarge), small)).toEqual({ kind: "overCap", after: null });
    // Only at 422: the same code at another status is the server's words.
    expect(classifyChooseSaveError(api(400, SELECTION_CHANGE_ERROR_CODES.removalTooLarge), small)).toEqual({ kind: "permanent", message: CHOOSE_WORDS.rejected });
  });

  it("E4 the cap's 422 names the count; no answer, a 5xx and an unreadable 2xx may have committed; 408 and 429 wrote nothing", () => {
    expect(classifyChooseSaveError(api(422, SELECTION_CHANGE_ERROR_CODES.tooLarge, { selectedAfter: 10_001 }), small)).toEqual({ kind: "overCap", after: 10_001 });
    expect(classifyChooseSaveError(api(422, SELECTION_CHANGE_ERROR_CODES.tooLarge), small)).toEqual({ kind: "overCap", after: null });
    expect(classifyChooseSaveError(api(500, "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR"), small)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classifyChooseSaveError(api(503, "DROPSHIP_ALLOCATION_UNAVAILABLE"), small)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classifyChooseSaveError(new TypeError("Failed to fetch"), small)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classifyChooseSaveError(new SyntaxError("Unexpected end of JSON input"), small)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classifyChooseSaveError(new DOMException("aborted", "AbortError"), small)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classifyChooseSaveError(api(408, null), small)).toEqual({ kind: "network", mayHaveCommitted: false });
    expect(classifyChooseSaveError(api(429, DROPSHIP_CATALOG_READ_ERROR_CODES.rateLimited), small)).toEqual({ kind: "network", mayHaveCommitted: false });
  });

  it("E5 a 400 is the page's words; any other refusal the server's; an unknown error the page's", () => {
    expect(classifyChooseSaveError(api(400, SELECTION_CHANGE_ERROR_CODES.invalidInput), small)).toEqual({ kind: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(api(400, SELECTION_CHANGE_ERROR_CODES.conflicting), small)).toEqual({ kind: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(api(403, "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED", null, "Your account is paused."), small)).toEqual({ kind: "permanent", message: "Your account is paused." });
    expect(classifyChooseSaveError(api(403, null, null, "  "), small)).toEqual({ kind: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(new Error("boom"), small)).toEqual({ kind: "permanent", message: CHOOSE_WORDS.rejected });
  });

  it("E6 an idsOnly read refused for too many ids says how many it needed", () => {
    expect(chooseIdsTooMany(api(422, DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany, { needed: 10_050, total: 10_050, limit: 10_000 }))).toEqual({ needed: 10_050 });
    expect(chooseIdsTooMany(api(422, DROPSHIP_CATALOG_READ_ERROR_CODES.idsTooMany))).toEqual({ needed: null });
    expect(chooseIdsTooMany(api(422, SELECTION_CHANGE_ERROR_CODES.tooLarge))).toBeNull();
    expect(chooseIdsTooMany(new Error("x"))).toBeNull();
  });

  it("E7 the paused schedule: 2 s, 4 s, 8 s, then 15 s; 32 sends fill the 420 s window", () => {
    expect([0, 1, 2, 3, 4, 40].map(choosePausedDelayMs)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
    expect(CHOOSE_PAUSED_MAX_SENDS).toBe(32);
  });
});

function catalogPage(page: number, sizes: number[], total: number, limit = CHOOSE_PAGE_SIZE): ChooseCatalogPage {
  return deepFreeze({
    rows: sizes.map((size) => row(size, "missing_vendor_include_rule", false)),
    total, page, limit, summary: { matching: total, matchingSelected: 0 },
  });
}

describe("paging", () => {
  it("P1 pages merge, a repeated size counts once, and at most 1,000 rows show", () => {
    const merged = mergeChoosePages([catalogPage(1, [1, 2, 3], 5, 3), catalogPage(2, [3, 4, 5], 5, 3)]);
    expect(merged.rows.map((entry) => entry.productVariantId)).toEqual([1, 2, 3, 4, 5]);
    expect(merged.capped).toBe(false);
    const big = Array.from({ length: 6 }, (_, index) => catalogPage(index + 1, Array.from({ length: 200 }, (__, at) => index * 200 + at + 1), 4_300));
    const capped = mergeChoosePages(big);
    expect(capped.rows).toHaveLength(CHOOSE_MAX_ROWS_SHOWN);
    expect(capped.capped).toBe(true);
  });

  it("P2 P3 the next page stops at the total and at 1,000 rows", () => {
    const first = catalogPage(1, Array.from({ length: 200 }, (_, index) => index + 1), 230);
    expect(chooseNextPageParam(first, [first])).toBe(2);
    const second = catalogPage(2, Array.from({ length: 30 }, (_, index) => index + 201), 230);
    expect(chooseNextPageParam(second, [first, second])).toBeUndefined();
    const pages = Array.from({ length: 5 }, (_, index) => catalogPage(index + 1, Array.from({ length: 200 }, (__, at) => index * 200 + at + 1), 4_300));
    expect(chooseNextPageParam(pages[3], pages.slice(0, 4))).toBe(5);
    expect(chooseNextPageParam(pages[4], pages)).toBeUndefined();
  });

  it("P4 the total and the summary come from the newest page; no pages is empty", () => {
    const merged = mergeChoosePages([catalogPage(1, [1], 300), catalogPage(2, [2], 290)]);
    expect(merged.total).toBe(290);
    expect(merged.summary).toEqual({ matching: 290, matchingSelected: 0 });
    expect(mergeChoosePages([])).toEqual({ rows: [], total: 0, summary: null, capped: false });
  });

  it("P5 the shown line: all, some with more to load, past the cap, and rows the paging can't reach", () => {
    const merged = (shown: number, total: number, capped = false) => ({ rows: Array.from({ length: shown }, (_, index) => row(index + 1, "selected", true)), total, summary: null, capped });
    expect(describeChooseShown(merged(230, 230), false)).toBe("Showing all 230");
    expect(describeChooseShown(merged(200, 230), true)).toBe("Showing 200 of 230");
    expect(describeChooseShown(merged(1_000, 4_300, true), false)).toBe(CHOOSE_WORDS.shownCapLine(1_000, 4_300));
    expect(describeChooseShown(merged(199, 200), false)).toBe(CHOOSE_WORDS.shownShortLine(199, 200));
  });
});
