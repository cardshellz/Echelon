import { describe, expect, it } from "vitest";
import {
  buildChooseSelectionSave,
  ChooseBuildRefusal,
  CHOOSE_MAX_ROWS_SHOWN,
  CHOOSE_PAGE_SIZE,
  chooseCatalogPageSchema,
  chooseCounts,
  chooseMarksKey,
  chooseNextPageParam,
  chooseRowView,
  chooseRulesView,
  chooseSaveBlock,
  chooseSaveBodyBytes,
  chooseSaveResult,
  ChooseUnverifiedAnswerError,
  classifyChooseSaveError,
  describeChooseMove,
  describeChooseSaveBlock,
  describeChooseShown,
  EMPTY_CHOOSE_CHANGES,
  isChangeableRow,
  MAX_SELECTION_RULES,
  mergeChoosePages,
  reduceChooseChanges,
  rulesFingerprint,
  sameRuleContent,
  SELECTION_SAVE_BODY_LIMIT_BYTES,
  shownTick,
  toSelectionRuleInput,
  type ChooseCatalogPage,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseMark,
  type ChooseSelectionReason,
  type ChooseSelectionRule,
} from "../dropship-catalog-choose";
import { CHOOSE_WORDS } from "../dropship-catalog-choose-words";
import { DropshipApiError } from "../dropship-ops-surface";

/** Every input is frozen all the way down, so a function that mutates one throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

type RuleTarget = Partial<Pick<ChooseSelectionRule, "productLineId" | "productId" | "productVariantId" | "category">>;

/** A rule as the server's GET returns it: every target column, null when unused. */
function serverRule(id: number, scopeType: ChooseSelectionRule["scopeType"], action: ChooseSelectionRule["action"], target: RuleTarget = {},
  extra: Partial<ChooseSelectionRule> = {}): ChooseSelectionRule {
  return deepFreeze({
    id, revisionId: 7, scopeType, action,
    productLineId: target.productLineId ?? null, productId: target.productId ?? null,
    productVariantId: target.productVariantId ?? null, category: target.category ?? null,
    autoConnectNewSkus: action === "include", autoListNewSkus: false,
    priority: action === "include" ? 100 : 200,
    metadata: { source: "portal_catalog" }, isActive: true,
    ...extra,
  });
}

const PICK_101 = serverRule(1, "variant", "include", { productVariantId: 101 });
const MAILERS_INCLUDE = serverRule(2, "category", "include", { category: "Mailers" }, { priority: 50, metadata: { source: "portal_catalog_scope" } });
const KEEP_OUT_103 = serverRule(3, "variant", "exclude", { productVariantId: 103 });
const TOPLOADERS_EXCLUDE = serverRule(4, "category", "exclude", { category: "Toploaders" }, { priority: 150 });
const PRODUCT_20_INCLUDE = serverRule(5, "product", "include", { productId: 20 }, { priority: 50 });
const RULES: readonly ChooseSelectionRule[] = deepFreeze([PICK_101, MAILERS_INCLUDE, KEEP_OUT_103, TOPLOADERS_EXCLUDE, PRODUCT_20_INCLUDE]);
const VIEW = chooseRulesView(RULES);

function row(productVariantId: number, reason: ChooseSelectionReason, includeRuleIds: number[] = [], excludeRuleIds: number[] = [],
  extra: Partial<ChooseCatalogRow> = {}): ChooseCatalogRow {
  return deepFreeze({
    productId: 10, productVariantId, productSku: "ENV", productName: "Envelope Single Pocket", variantSku: `ENV-${productVariantId}`,
    variantName: "Pack of 50", category: "Mailers",
    selectionDecision: { selected: reason === "selected", reason, marketplaceQuantity: reason === "selected" ? 25 : 0, includeRuleIds, excludeRuleIds },
    ...extra,
  });
}

/** The fixture catalog: each row as the server evaluates it under RULES. */
const R101 = row(101, "selected", [1, 2]);
const R102 = row(102, "selected", [2]);
const R103 = row(103, "excluded_by_vendor_rule", [2], [3]);
const R104 = row(104, "excluded_by_vendor_rule", [], [4], { category: "Toploaders" });
const R105 = row(105, "missing_vendor_include_rule", [], [], { category: null });
const R106 = row(106, "disabled_by_vendor_override", [2]);
const R107 = row(107, "not_exposed_by_admin");

function mark(productVariantId: number, to: ChooseMark["to"], basisRow?: ChooseCatalogRow): ChooseMark {
  const decision = basisRow?.selectionDecision;
  return deepFreeze({
    productVariantId, to,
    basis: { reason: decision?.reason ?? "missing_vendor_include_rule", includeRuleIds: decision?.includeRuleIds ?? [], excludeRuleIds: decision?.excludeRuleIds ?? [] },
  });
}

function changesOf(marks: ChooseMark[], baseFingerprint = VIEW.fingerprint): ChooseChanges {
  return deepFreeze({ marks, baseFingerprint: marks.length ? baseFingerprint : null });
}

describe("change set (reducer)", () => {
  it("R1 a toggle on a size that isn't selected marks it to add, from the row's basis, and takes the rules' fingerprint", () => {
    const next = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: R105, rules: VIEW });
    expect(next.marks).toEqual([{ productVariantId: 105, to: "selected", basis: { reason: "missing_vendor_include_rule", includeRuleIds: [], excludeRuleIds: [] } }]);
    expect(next.baseFingerprint).toBe("1,2,3,4,5");
  });

  it("R2 a toggle on a selected size marks it to remove", () => {
    const next = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: R101, rules: VIEW });
    expect(next.marks).toEqual([{ productVariantId: 101, to: "not_selected", basis: { reason: "selected", includeRuleIds: [1, 2], excludeRuleIds: [] } }]);
  });

  it("R3 a second toggle drops the mark, and no marks clear the fingerprint", () => {
    const once = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: R101, rules: VIEW });
    const twice = reduceChooseChanges(once, { type: "toggle", row: R101, rules: VIEW });
    expect(twice).toBe(EMPTY_CHOOSE_CHANGES);
    expect(twice.baseFingerprint).toBeNull();
  });

  it("R4 ignores sizes no pick can change: turned off, kept out by an older setting, not offered", () => {
    for (const blocked of [R104, R106, R107]) {
      expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: blocked, rules: VIEW })).toBe(EMPTY_CHOOSE_CHANGES);
    }
    // "Removed by you" is changeable: its only keep-out is the vendor's own.
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: R103, rules: VIEW }).marks).toHaveLength(1);
  });

  it("R5 the header box checks every changeable row shown from a mixed state", () => {
    const start = changesOf([mark(102, "not_selected", R102)]);
    const next = reduceChooseChanges(start, { type: "setShown", rows: [R101, R102, R103, R104, R105, R106], checked: true, rules: VIEW });
    // 102's remove mark is dropped (it is saved checked), 103 and 105 gain add marks; 101 stays as saved; 104 and 106 can't change.
    expect(next.marks.map((entry) => `${entry.productVariantId}:${entry.to}`)).toEqual(["103:selected", "105:selected"]);
    expect(next.baseFingerprint).toBe(VIEW.fingerprint);
  });

  it("R6 the header box unchecks every changeable row shown", () => {
    const start = changesOf([mark(105, "selected", R105)]);
    const next = reduceChooseChanges(start, { type: "setShown", rows: [R101, R102, R103, R104, R105, R106], checked: false, rules: VIEW });
    expect(next.marks.map((entry) => `${entry.productVariantId}:${entry.to}`)).toEqual(["101:not_selected", "102:not_selected"]);
    // Nothing to change: the same object.
    const again = reduceChooseChanges(next, { type: "setShown", rows: [R101, R102, R103, R104, R105, R106], checked: false, rules: VIEW });
    expect(again).toBe(next);
  });

  it("R7 the fingerprint is set when the first mark is made and kept while marks remain", () => {
    const first = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: R105, rules: VIEW });
    const otherView = chooseRulesView([...RULES, serverRule(9, "variant", "include", { productVariantId: 999 })]);
    const second = reduceChooseChanges(first, { type: "toggle", row: R101, rules: otherView });
    expect(second.baseFingerprint).toBe(VIEW.fingerprint);
    expect(second.marks.map((entry) => entry.productVariantId)).toEqual([101, 105]);
  });

  it("R8 a reload drops a mark it made true, refreshes a basis, drops a mark no save could apply and keeps marks of rows not loaded", () => {
    const start = changesOf([mark(101, "not_selected", R101), mark(102, "not_selected", R102), mark(105, "selected", R105), mark(201, "selected")]);
    // 101 was removed in another tab; 102 is now selected by a new rule too; 105 was turned off for the vendor; 201 is not loaded.
    const reloaded = [row(101, "missing_vendor_include_rule"), row(102, "selected", [2, 8]), row(105, "disabled_by_vendor_override", [2])];
    const next = reduceChooseChanges(start, { type: "reconcile", rows: reloaded, rules: VIEW });
    expect(next.marks.map((entry) => entry.productVariantId)).toEqual([102, 201]);
    expect(next.marks[0].basis.includeRuleIds).toEqual([2, 8]);
    expect(next.baseFingerprint).toBe(start.baseFingerprint);
    // An unchanged reload returns the same object (no re-render loop).
    expect(reduceChooseChanges(next, { type: "reconcile", rows: reloaded, rules: VIEW })).toBe(next);
  });

  it("R9 a rebase reconciles and takes the new rules' fingerprint; with no marks left it is null", () => {
    const start = changesOf([mark(105, "selected", R105)], "1,2");
    const moved = chooseRulesView([...RULES, serverRule(12, "variant", "include", { productVariantId: 300 })]);
    const rebased = reduceChooseChanges(start, { type: "rebase", rows: [R105], rules: moved });
    expect(rebased.baseFingerprint).toBe("1,2,3,4,5,12");
    expect(rebased.marks).toEqual(start.marks);
    const settled = reduceChooseChanges(start, { type: "rebase", rows: [row(105, "selected", [12])], rules: moved });
    expect(settled).toBe(EMPTY_CHOOSE_CHANGES);
  });

  it("R10 marks survive a filter that loads other rows; undo and saved empty the set; nothing to do returns the same object", () => {
    const start = changesOf([mark(105, "selected", R105)]);
    expect(reduceChooseChanges(start, { type: "reconcile", rows: [R101, R102], rules: VIEW })).toBe(start);
    expect(reduceChooseChanges(start, { type: "undo" })).toBe(EMPTY_CHOOSE_CHANGES);
    expect(reduceChooseChanges(start, { type: "saved" })).toBe(EMPTY_CHOOSE_CHANGES);
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "undo" })).toBe(EMPTY_CHOOSE_CHANGES);
    expect(chooseCounts(changesOf([mark(101, "not_selected", R101), mark(105, "selected", R105), mark(103, "selected", R103)]))).toEqual({ add: 2, remove: 1 });
    expect(chooseMarksKey([mark(105, "selected"), mark(101, "not_selected")])).toBe("101:not_selected,105:selected");
  });
});

describe("row model", () => {
  const view = (target: ChooseCatalogRow, entry: ChooseMark | null = null, byId: ReadonlyMap<number, ChooseSelectionRule> | null = VIEW.byId) =>
    chooseRowView(target, entry, byId);

  it("V1 V2 a marked row says what will happen and shows the box as it will be", () => {
    expect(view(R105, mark(105, "selected", R105))).toMatchObject({ checked: true, changed: "add", how: "willAdd", changeable: true });
    expect(view(R101, mark(101, "not_selected", R101))).toMatchObject({ checked: false, changed: "remove", how: "willRemove", quantity: 25 });
  });

  it("V3 V4 a selected size reads from its include rules: the vendor's own pick, or only an older setting", () => {
    expect(view(R101)).toMatchObject({ checked: true, changed: null, how: "picked", quantity: 25, changeable: true });
    expect(view(R102)).toMatchObject({ checked: true, how: "olderInclude" });
    expect(view(row(110, "selected", [5]))).toMatchObject({ how: "olderInclude" });
  });

  it("V5 V6 a kept-out size: the vendor's own keep-out can be checked again, an older setting's can't", () => {
    expect(view(R103)).toMatchObject({ checked: false, how: "removed", changeable: true, quantity: null });
    expect(view(R104)).toMatchObject({ checked: false, how: "olderExclude", changeable: false });
  });

  it("V7 V8 V9 not selected, turned off, not offered", () => {
    expect(view(R105)).toMatchObject({ how: "notSelected", changeable: true, quantity: null });
    expect(view(R106)).toMatchObject({ how: "turnedOff", changeable: false, quantity: null });
    expect(view(R107)).toMatchObject({ how: "notOffered", changeable: false, quantity: null });
  });

  it("V10 while the rules load, every box is off and the words are plain", () => {
    expect(view(R101, null, null)).toMatchObject({ how: "selected", changeable: false, checked: true });
    expect(view(R103, null, null)).toMatchObject({ how: "keptOut", changeable: false });
    expect(view(R105, null, null)).toMatchObject({ how: "notSelected", changeable: false });
  });

  it("V11 rule ids the page doesn't hold fall back to the plain words, and an unknown keep-out stays changeable", () => {
    const readUnderOtherRules = row(120, "selected", [70]);
    expect(view(readUnderOtherRules)).toMatchObject({ how: "selected" });
    const unknownExclude = row(121, "excluded_by_vendor_rule", [], [71]);
    expect(view(unknownExclude)).toMatchObject({ how: "keptOut", changeable: true });
    expect(isChangeableRow(unknownExclude, VIEW.byId)).toBe(true);
    // A known older keep-out wins over an unknown id.
    expect(view(row(122, "excluded_by_vendor_rule", [], [4, 71]))).toMatchObject({ how: "olderExclude", changeable: false });
  });

  it("V12 only a selected size has a quantity, and only a selected size shows its tier badge", () => {
    for (const unselected of [R103, R104, R105, R106, R107]) expect(view(unselected).quantity).toBeNull();
    const tier = { tier: "case" as const, eligible: false, reason: "balance_below_tier" as const, policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 1 };
    expect(view(row(130, "selected", [2], [], { listingTier: tier })).tierOff).toBe(true);
    expect(view(row(131, "missing_vendor_include_rule", [], [], { listingTier: tier })).tierOff).toBe(false);
    expect(view(row(132, "selected", [2], [], { listingTier: { ...tier, eligible: true } })).tierOff).toBe(false);
    expect(view(row(133, "selected", [2], [], { selectionDecision: { selected: true, reason: "selected", marketplaceQuantity: 0, includeRuleIds: [2], excludeRuleIds: [] } })).quantity).toBe(0);
  });
});

describe("header box", () => {
  it("H1 H2 H3 H4 all, some, none, and off with no changeable row", () => {
    expect(shownTick([R101, R102, R104, R106], EMPTY_CHOOSE_CHANGES, VIEW.byId)).toEqual({ tick: "all", changeable: 2 });
    expect(shownTick([R101, R105], EMPTY_CHOOSE_CHANGES, VIEW.byId)).toEqual({ tick: "some", changeable: 2 });
    expect(shownTick([R101, R105], changesOf([mark(101, "not_selected", R101)]), VIEW.byId)).toEqual({ tick: "none", changeable: 2 });
    expect(shownTick([R104, R106, R107], EMPTY_CHOOSE_CHANGES, VIEW.byId)).toEqual({ tick: "none", changeable: 0 });
    expect(shownTick([R101], EMPTY_CHOOSE_CHANGES, null)).toEqual({ tick: "none", changeable: 0 });
  });
});

describe("save builder", () => {
  const compact = (rules: readonly ChooseSelectionRule[]) => rules.map((entry) => toSelectionRuleInput(entry));
  const include = (productVariantId: number) => ({ scopeType: "variant", action: "include", productVariantId, autoConnectNewSkus: true,
    autoListNewSkus: false, priority: 100, metadata: { source: "portal_catalog" } });
  const exclude = (productVariantId: number) => ({ scopeType: "variant", action: "exclude", productVariantId, autoConnectNewSkus: false,
    autoListNewSkus: false, priority: 200, metadata: { source: "portal_catalog" } });

  it("B1 adding a size that isn't selected adds one pick", () => {
    expect(buildChooseSelectionSave(RULES, [mark(105, "selected", R105)])).toEqual([...compact(RULES), include(105)]);
  });

  it("B2 adding a size the vendor kept out, with no older include, drops the keep-out and adds a pick", () => {
    const rules = deepFreeze([...RULES, serverRule(6, "variant", "exclude", { productVariantId: 140 })]);
    const target = row(140, "excluded_by_vendor_rule", [], [6]);
    expect(buildChooseSelectionSave(rules, [mark(140, "selected", target)])).toEqual([...compact(RULES), include(140)]);
  });

  it("B3 adding back a size removed under an older include only drops the keep-out", () => {
    expect(buildChooseSelectionSave(RULES, [mark(103, "selected", R103)])).toEqual(compact([PICK_101, MAILERS_INCLUDE, TOPLOADERS_EXCLUDE, PRODUCT_20_INCLUDE]));
  });

  it("B4 adding a size that already has its own pick never adds a second one", () => {
    const ownPick = serverRule(7, "variant", "include", { productVariantId: 150 });
    const ownKeepOut = serverRule(8, "variant", "exclude", { productVariantId: 150 });
    const rules = deepFreeze([...RULES, ownPick, ownKeepOut]);
    const target = row(150, "excluded_by_vendor_rule", [7], [8]);
    expect(buildChooseSelectionSave(rules, [mark(150, "selected", target)])).toEqual([...compact(RULES), toSelectionRuleInput(ownPick)]);
  });

  it("B5 a mark kept out by an older setting is refused, never built", () => {
    expect(() => buildChooseSelectionSave(RULES, [mark(104, "selected", R104)])).toThrow(ChooseBuildRefusal);
    expect(chooseSaveBlock(RULES, [mark(104, "selected", R104)])).toEqual({ kind: "refused" });
    expect(describeChooseSaveBlock({ kind: "refused" })).toBe(CHOOSE_WORDS.rejected);
    // The same size marked both ways is refused too.
    expect(() => buildChooseSelectionSave(RULES, [mark(105, "selected", R105), mark(105, "not_selected", R105)])).toThrow(ChooseBuildRefusal);
  });

  it("B6 (ported from the deleted builder) an add drops the size's keep-out and keeps every other rule", () => {
    const rules = deepFreeze([
      serverRule(1, "catalog", "include"),
      serverRule(2, "variant", "exclude", { productVariantId: 42 }),
      serverRule(3, "variant", "include", { productVariantId: 99 }),
    ]);
    // The row was read under other rules (its ids are gone), so the add brings its own pick.
    const replacement = buildChooseSelectionSave(rules, [mark(42, "selected", row(42, "excluded_by_vendor_rule", [], [77]))]);
    expect(replacement).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 99 }),
      expect.objectContaining({ scopeType: "variant", action: "include", productVariantId: 42 }),
    ]);
    expect(replacement.some((rule) => rule.action === "exclude" && rule.productVariantId === 42)).toBe(false);
  });

  it("B7 (ported from the deleted builder) the same size marked twice is sent once", () => {
    const rules = deepFreeze([serverRule(1, "catalog", "include")]);
    const selectedByCatalog = row(42, "selected", [1]);
    expect(buildChooseSelectionSave(rules, [mark(42, "not_selected", selectedByCatalog), mark(42, "not_selected", selectedByCatalog)])).toEqual([
      expect.objectContaining({ scopeType: "catalog", action: "include" }),
      expect.objectContaining({ scopeType: "variant", action: "exclude", productVariantId: 42 }),
    ]);
  });

  it("B8 removing a lone pick deletes it and writes no keep-out", () => {
    const lone = serverRule(9, "variant", "include", { productVariantId: 160 });
    const rules = deepFreeze([...RULES, lone]);
    const built = buildChooseSelectionSave(rules, [mark(160, "not_selected", row(160, "selected", [9]))]);
    expect(built).toEqual(compact(RULES));
    expect(built.some((rule) => rule.productVariantId === 160)).toBe(false);
  });

  it("B9 removing a pick under an older include deletes it and keeps the size out", () => {
    expect(buildChooseSelectionSave(RULES, [mark(101, "not_selected", R101)]))
      .toEqual([...compact([MAILERS_INCLUDE, KEEP_OUT_103, TOPLOADERS_EXCLUDE, PRODUCT_20_INCLUDE]), exclude(101)]);
  });

  it("B10 removing a size whose basis is stale keeps it out (an exclude always wins)", () => {
    expect(buildChooseSelectionSave(RULES, [mark(170, "not_selected", row(170, "selected", [55]))])).toEqual([...compact(RULES), exclude(170)]);
    // A remove never adds a second keep-out.
    const rules = deepFreeze([...RULES, serverRule(10, "variant", "exclude", { productVariantId: 171 })]);
    expect(buildChooseSelectionSave(rules, [mark(171, "not_selected", row(171, "selected", [56]))])).toEqual(compact(rules));
  });

  it("B11 adds and removes go in one set, and untouched rules pass through unchanged and in order", () => {
    const built = buildChooseSelectionSave(RULES, [mark(105, "selected", R105), mark(102, "not_selected", R102), mark(103, "selected", R103)]);
    expect(built).toEqual([...compact([PICK_101, MAILERS_INCLUDE, TOPLOADERS_EXCLUDE, PRODUCT_20_INCLUDE]), exclude(102), include(105)]);
  });

  it("B12 the order is fixed whatever order the marks come in", () => {
    const marks = [mark(180, "selected"), mark(105, "selected", R105), mark(102, "not_selected", R102)];
    const forward = buildChooseSelectionSave(RULES, marks);
    expect(buildChooseSelectionSave(RULES, [...marks].reverse())).toEqual(forward);
    expect(forward.slice(-3).map((rule) => rule.productVariantId)).toEqual([102, 105, 180]);
  });

  it("B13 the compact form leaves out empty targets and keeps priority, flags and metadata", () => {
    const odd = serverRule(11, "category", "include", { category: "  Sleeves  " }, { priority: -5, autoConnectNewSkus: false, autoListNewSkus: true, metadata: null });
    expect(toSelectionRuleInput(odd)).toEqual({ scopeType: "category", action: "include", category: "Sleeves", autoConnectNewSkus: false,
      autoListNewSkus: true, priority: -5, metadata: {} });
    for (const rule of buildChooseSelectionSave(RULES, [mark(105, "selected", R105)])) {
      expect(Object.values(rule)).not.toContain(null);
      expect(Object.keys(rule)).not.toContain("id");
      expect(Object.keys(rule)).not.toContain("isActive");
    }
    expect(toSelectionRuleInput(serverRule(12, "catalog", "include"))).toEqual({ scopeType: "catalog", action: "include",
      autoConnectNewSkus: true, autoListNewSkus: false, priority: 100, metadata: { source: "portal_catalog" } });
  });

  it("B14 two saved rules the server would call duplicates are sent once (the first)", () => {
    const rules = deepFreeze([MAILERS_INCLUDE, serverRule(13, "category", "include", { category: " mailers " }, { priority: 1 })]);
    expect(buildChooseSelectionSave(rules, [])).toEqual(compact([MAILERS_INCLUDE]));
    // An inactive rule is never sent.
    expect(buildChooseSelectionSave(deepFreeze([{ ...MAILERS_INCLUDE, isActive: false }]), [])).toEqual([]);
  });
});

describe("stops before sending", () => {
  const picks = (count: number, firstId = 1000) => Array.from({ length: count }, (_, index) =>
    serverRule(firstId + index, "variant", "include", { productVariantId: 10_000 + index }));

  it("K1 K2 500 rules may be saved; 501 is stopped with the count", () => {
    const rules = deepFreeze(picks(499));
    expect(chooseSaveBlock(rules, [mark(105, "selected", R105)])).toBeNull();
    expect(chooseSaveBlock(rules, [mark(105, "selected", R105), mark(106, "selected")])).toEqual({ kind: "tooManyRules", count: 501 });
    expect(MAX_SELECTION_RULES).toBe(500);
    expect(describeChooseSaveBlock({ kind: "tooManyRules", count: 501 })).toContain("This save would make 501, which is 1 over.");
  });

  it("K3 a body over 102,400 bytes (large older metadata) is stopped; at the limit it may be sent", () => {
    const withNote = (length: number) => deepFreeze([serverRule(1, "catalog", "include", {}, { metadata: { note: "x".repeat(length) } })]);
    const base = chooseSaveBodyBytes(buildChooseSelectionSave(withNote(0), []));
    const atLimit = SELECTION_SAVE_BODY_LIMIT_BYTES - base;
    expect(chooseSaveBodyBytes(buildChooseSelectionSave(withNote(atLimit), []))).toBe(SELECTION_SAVE_BODY_LIMIT_BYTES);
    expect(chooseSaveBlock(withNote(atLimit), [])).toBeNull();
    expect(chooseSaveBlock(withNote(atLimit + 1), [])).toEqual({ kind: "tooLarge" });
    expect(describeChooseSaveBlock({ kind: "tooLarge" })).toBe(CHOOSE_WORDS.tooLarge);
  });

  it("K4 500 compact picks fit the body limit; 500 in the old full form (null targets) would not", () => {
    const built = buildChooseSelectionSave(deepFreeze(picks(500)), []);
    expect(built).toHaveLength(500);
    expect(chooseSaveBodyBytes(built)).toBeLessThan(SELECTION_SAVE_BODY_LIMIT_BYTES);
    const fullForm = built.map((rule) => ({ productLineId: null, productId: null, category: null, ...rule }));
    const fullBytes = new TextEncoder().encode(JSON.stringify({ idempotencyKey: "catalog-selection:".padEnd(54, "0"), rules: fullForm })).length;
    expect(fullBytes).toBeGreaterThan(SELECTION_SAVE_BODY_LIMIT_BYTES);
  });
});

describe("another tab: fingerprint and content", () => {
  it("F1 F2 F3 the fingerprint is the active ids in order; any id change moves it; two empty sets match", () => {
    expect(rulesFingerprint(RULES)).toBe(rulesFingerprint([...RULES].reverse()));
    expect(rulesFingerprint([...RULES.slice(1), { ...PICK_101, id: 99 }])).not.toBe(rulesFingerprint(RULES));
    expect(rulesFingerprint([{ ...PICK_101, isActive: false }])).toBe("");
    expect(rulesFingerprint([])).toBe(rulesFingerprint([]));
  });

  it("F4 the same rules match across order, new ids and full or compact form", () => {
    const sent = buildChooseSelectionSave(RULES, [mark(105, "selected", R105)]);
    const reread = [...sent].reverse().map((rule, index) => serverRule(500 + index, rule.scopeType, rule.action,
      { productLineId: rule.productLineId, productId: rule.productId, productVariantId: rule.productVariantId, category: rule.category },
      { priority: rule.priority, autoConnectNewSkus: rule.autoConnectNewSkus, autoListNewSkus: rule.autoListNewSkus, metadata: { ...rule.metadata } }));
    expect(sameRuleContent(reread, sent)).toBe(true);
    expect(sameRuleContent(RULES, compactAll(RULES))).toBe(true);
  });

  it("F5 any field that differs makes the content differ", () => {
    const sent = compactAll(RULES);
    const variants: Array<Partial<ChooseSelectionRule>> = [
      { action: "exclude" }, { priority: 101 }, { autoConnectNewSkus: false }, { autoListNewSkus: true }, { metadata: { source: "other" } },
      { productVariantId: 102 },
    ];
    for (const change of variants) expect(sameRuleContent([{ ...PICK_101, ...change }, ...RULES.slice(1)], sent)).toBe(false);
    expect(sameRuleContent(RULES.slice(1), sent)).toBe(false);
    // Metadata key order never matters (the server sorts keys before hashing).
    const ordered = serverRule(1, "variant", "include", { productVariantId: 101 }, { metadata: { a: 1, b: 2 } });
    const reordered = serverRule(2, "variant", "include", { productVariantId: 101 }, { metadata: { b: 2, a: 1 } });
    expect(sameRuleContent([ordered], [reordered])).toBe(true);
  });

  function compactAll(rules: readonly ChooseSelectionRule[]) {
    return rules.map((rule) => toSelectionRuleInput(rule));
  }
});

describe("error classes", () => {
  const apiError = (status: number, code: string | null = null, message = "Server words.") => new DropshipApiError({ status, code, message });

  // Review round MC1: each transient class also says whether the save may have gone through on the server.
  it("E1 no answer is transient, and the save may have gone through", () => {
    expect(classifyChooseSaveError(new TypeError("Failed to fetch"))).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: true });
    expect(classifyChooseSaveError(new DOMException("The operation was aborted.", "AbortError"))).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: true });
  });

  it("E2 a 5xx is transient, and the save may have gone through (a router timeout answers while the app still commits)", () => {
    for (const status of [500, 502, 503]) expect(classifyChooseSaveError(apiError(status))).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: true });
  });

  it("E3 the busy 409 is transient, keeps the server's words, and wrote nothing", () => {
    const busy = apiError(409, "PUBLICATION_SELECTION_BUSY", "A stock update is finishing. Your selection was not saved; retry it in a moment.");
    expect(classifyChooseSaveError(busy)).toEqual({ classification: "transient", busyMessage: "A stock update is finishing. Your selection was not saved; retry it in a moment.", mayHaveCommitted: false });
  });

  it("E4 408 and 429 are transient and wrote nothing", () => {
    expect(classifyChooseSaveError(apiError(408))).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: false });
    expect(classifyChooseSaveError(apiError(429))).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: false });
  });

  it("E7 (review CT6) a 2xx the page can't read is transient and may have gone through: the runner checks the rules", () => {
    const unverified = new ChooseUnverifiedAnswerError("not JSON");
    expect(unverified.code).toBe("DROPSHIP_CATALOG_CHOOSE_ANSWER_UNVERIFIED");
    expect(classifyChooseSaveError(unverified)).toEqual({ classification: "transient", busyMessage: null, mayHaveCommitted: true });
  });

  it("E5 a 400, a key conflict and a 413 are permanent, in the page's words", () => {
    expect(classifyChooseSaveError(apiError(400, "DROPSHIP_VENDOR_CATALOG_INVALID_INPUT"))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(apiError(400, "DROPSHIP_IDEMPOTENCY_KEY_REQUIRED"))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(apiError(409, "DROPSHIP_IDEMPOTENCY_CONFLICT"))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(apiError(413))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.tooLarge });
  });

  it("E6 any other refusal is permanent in the server's words; an unknown error is permanent", () => {
    expect(classifyChooseSaveError(apiError(403, "DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED", "Dropship vendor status does not allow catalog access.")))
      .toEqual({ classification: "permanent", message: "Dropship vendor status does not allow catalog access." });
    for (const status of [401, 404, 422]) expect(classifyChooseSaveError(apiError(status)).classification).toBe("permanent");
    expect(classifyChooseSaveError(apiError(409, "DROPSHIP_VENDOR_PROFILE_REQUIRED", "Profile required."))).toEqual({ classification: "permanent", message: "Profile required." });
    expect(classifyChooseSaveError(apiError(422, null, "  "))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.rejected });
    expect(classifyChooseSaveError(new Error("boom"))).toEqual({ classification: "permanent", message: CHOOSE_WORDS.rejected });
  });
});

describe("paging", () => {
  function catalogPage(page: number, ids: number[], total: number, limit = CHOOSE_PAGE_SIZE): ChooseCatalogPage {
    return deepFreeze({ rows: ids.map((id) => row(id, "missing_vendor_include_rule")), total, page, limit,
      facets: { categories: [{ category: "Mailers", label: "Mailers", rowCount: total }] } });
  }

  it("P1 pages merge, a repeated size counts once, and at most 1,000 rows show", () => {
    const merged = mergeChoosePages([catalogPage(1, [1, 2, 3], 5, 3), catalogPage(2, [3, 4, 5], 5, 3)]);
    expect(merged.rows.map((entry) => entry.productVariantId)).toEqual([1, 2, 3, 4, 5]);
    expect(merged.capped).toBe(false);
    const big = Array.from({ length: 6 }, (_, index) => catalogPage(index + 1, Array.from({ length: 200 }, (__, at) => index * 200 + at + 1), 4_300));
    const capped = mergeChoosePages(big);
    expect(capped.rows).toHaveLength(CHOOSE_MAX_ROWS_SHOWN);
    expect(capped.capped).toBe(true);
  });

  it("P2 the next page stops at the total", () => {
    const first = catalogPage(1, Array.from({ length: 200 }, (_, index) => index + 1), 230);
    expect(chooseNextPageParam(first, [first])).toBe(2);
    const second = catalogPage(2, Array.from({ length: 30 }, (_, index) => index + 201), 230);
    expect(chooseNextPageParam(second, [first, second])).toBeUndefined();
    const exact = catalogPage(1, Array.from({ length: 200 }, (_, index) => index + 1), 200);
    expect(chooseNextPageParam(exact, [exact])).toBeUndefined();
  });

  it("P3 the next page stops at 1,000 rows", () => {
    const pages = Array.from({ length: 5 }, (_, index) => catalogPage(index + 1, [index + 1], 4_300));
    expect(chooseNextPageParam(pages[3], pages.slice(0, 4))).toBe(5);
    expect(chooseNextPageParam(pages[4], pages)).toBeUndefined();
  });

  it("P4 the total comes from the newest page; categories from the first; no pages is empty", () => {
    const merged = mergeChoosePages([catalogPage(1, [1], 300), catalogPage(2, [2], 290)]);
    expect(merged.total).toBe(290);
    expect(merged.categories).toEqual([{ category: "Mailers", label: "Mailers", rowCount: 300 }]);
    expect(mergeChoosePages([])).toEqual({ rows: [], total: 0, categories: [], capped: false });
  });

  it("drops the product-line facts the server still sends, and refuses a reason the server never sends", () => {
    const answer = { rows: [{ ...row(1, "selected", [2]), productLineIds: [4], productLineNames: ["Trading Card Supplies"], unitsPerVariant: 50 }],
      total: 1, page: 1, limit: 200,
      facets: { categories: [], productLines: [{ productLineIds: [4], label: "Trading Card Supplies", rowCount: 1 }], products: [] } };
    const parsed = chooseCatalogPageSchema.parse(answer);
    expect(JSON.stringify(parsed)).not.toContain("Trading Card Supplies");
    expect(JSON.stringify(parsed)).not.toContain("productLine");
    const notAReason = { ...answer, rows: [{ ...answer.rows[0], selectionDecision: { ...answer.rows[0].selectionDecision, reason: "not_selected" } }] };
    expect(chooseCatalogPageSchema.safeParse(notAReason).success).toBe(false);
  });
});

describe("review round (step 1 stage 1)", () => {
  it("R11 (MC3) after an earlier save went through, a rebase drops every mark that save sent, loaded or not", () => {
    // 101's remove and 201's add were sent and committed; 105 was marked after. Only 105's row is loaded now.
    const start = changesOf([mark(101, "not_selected", R101), mark(105, "selected", R105), mark(201, "selected")]);
    const moved = chooseRulesView([serverRule(40, "category", "include", { category: "Mailers" }), serverRule(41, "variant", "include", { productVariantId: 201 })]);
    const rebased = reduceChooseChanges(start, { type: "rebase", rows: [R105], rules: moved, committedMarksKey: "101:not_selected,201:selected" });
    expect(rebased.marks.map((entry) => `${entry.productVariantId}:${entry.to}`)).toEqual(["105:selected"]);
    expect(rebased.baseFingerprint).toBe(moved.fingerprint);
    // A mark whose direction differs from the one sent is not the change that was saved: it stays.
    const flipped = reduceChooseChanges(changesOf([mark(201, "not_selected")]), { type: "rebase", rows: [], rules: moved, committedMarksKey: "201:selected" });
    expect(flipped.marks.map((entry) => entry.productVariantId)).toEqual([201]);
    // Every sent mark gone: empty.
    expect(reduceChooseChanges(changesOf([mark(201, "selected")]), { type: "rebase", rows: [], rules: moved, committedMarksKey: "201:selected" })).toBe(EMPTY_CHOOSE_CHANGES);
  });

  it("R12 (MC8) when the rules now hold the older keep-out an add's row was read under, the add is dropped even when its row is not loaded", () => {
    // 301 was read kept out by rule 60, which the page's rules did not hold then (another tab's save): the box was changeable.
    const unknownExclude = row(301, "excluded_by_vendor_rule", [], [60]);
    const start = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: unknownExclude, rules: VIEW });
    expect(start.marks).toHaveLength(1);
    const withExclude = chooseRulesView([...RULES, serverRule(60, "category", "exclude", { category: "Binders" })]);
    // The vendor has moved to another filter: 301's row is not loaded.
    const next = reduceChooseChanges(start, { type: "reconcile", rows: [R101], rules: withExclude });
    expect(next).toBe(EMPTY_CHOOSE_CHANGES);
    expect(chooseSaveBlock([...RULES, serverRule(60, "category", "exclude", { category: "Binders" })], start.marks)).toEqual({ kind: "refused" });
    // A remove, or a keep-out that is the vendor's own, is never dropped this way.
    const own = changesOf([mark(103, "selected", R103), mark(102, "not_selected", R102)]);
    expect(reduceChooseChanges(own, { type: "reconcile", rows: [], rules: VIEW })).toBe(own);
  });

  it("SR1 (MC4, CT3) the saved line counts what took: a loaded row that doesn't read as marked is named; a row not loaded counts as sent", () => {
    const marks = [mark(101, "not_selected", R101), mark(105, "selected", R105), mark(106, "selected"), mark(201, "selected")];
    const after = [
      row(101, "missing_vendor_include_rule"),
      row(105, "selected", [9]),
      // Turned off for the vendor: the include was written, the size is still not selected.
      row(106, "disabled_by_vendor_override", [9]),
    ];
    expect(chooseSaveResult(marks, after)).toEqual({ add: 2, remove: 1, notTaken: 1 });
    // A remove that an older include still selects did not take either.
    expect(chooseSaveResult([mark(102, "not_selected", R102)], [row(102, "selected", [2])])).toEqual({ add: 0, remove: 0, notTaken: 1 });
    // The rows couldn't be read again: every change counts as sent.
    expect(chooseSaveResult(marks, null)).toEqual({ add: 3, remove: 1, notTaken: 0 });
  });

  it("K5 (CT8, DUX4) the limit words name the server's cap and how far over, and never point at the button that clears everything", () => {
    const words = describeChooseSaveBlock({ kind: "tooManyRules", count: 1_204 });
    expect(words).toContain(`up to ${MAX_SELECTION_RULES} saved choices`);
    expect(words).toContain("This save would make 1,204, which is 704 over.");
    expect(words).not.toMatch(/\bUndo\b/);
    expect(describeChooseSaveBlock({ kind: "tooLarge" })).not.toMatch(/\bUndo\b/);
  });

  it("SL1 (DUX5, DUX11) the shown line: all, some with more to load, past the cap, and rows the paging can't reach", () => {
    const merged = (shown: number, total: number, capped = false) => ({ rows: Array.from({ length: shown }, (_, index) => row(index + 1, "selected")), total, categories: [], capped });
    expect(describeChooseShown(merged(230, 230), false)).toBe("Showing all 230");
    expect(describeChooseShown(merged(200, 230), true)).toBe("Showing 200 of 230");
    expect(describeChooseShown(merged(1_000, 4_300, true), false)).toBe(CHOOSE_WORDS.shownCapLine(1_000, 4_300));
    expect(CHOOSE_WORDS.shownCapLine(1_000, 4_300)).not.toMatch(/choose/i);
    // No next page, not capped, yet fewer rows than the total (a row skipped between pages): say how to reach it.
    expect(describeChooseShown(merged(199, 200), false)).toBe(CHOOSE_WORDS.shownShortLine(199, 200));
  });
});

describe("verify round (step 1 stage 1)", () => {
  // Size 140 is turned off for the vendor while their own pick of it is saved (the server checks the override only
  // after an include matches, domain/vendor-selection.ts); 141 is turned off under an older setting only.
  const OWN_PICK_140 = serverRule(40, "variant", "include", { productVariantId: 140 });
  const WITH_PICK = chooseRulesView([...RULES, OWN_PICK_140]);
  const OFF_PICKED = row(140, "disabled_by_vendor_override", [40]);
  const OFF_PICKED_AND_OLDER = row(140, "disabled_by_vendor_override", [2, 40]);
  const OFF_OLDER_ONLY = row(141, "disabled_by_vendor_override", [2]);

  it("VR1 (V6) a turned-off size holding the vendor's own pick shows checked and can only be unchecked", () => {
    expect(chooseRowView(OFF_PICKED, null, WITH_PICK.byId)).toMatchObject({ checked: true, changeable: true, how: "turnedOff", quantity: null, tierOff: false });
    expect(isChangeableRow(OFF_PICKED, WITH_PICK.byId)).toBe(true);
    // Under an older setting only, or while the rules load, nothing on the page can change it.
    expect(chooseRowView(OFF_OLDER_ONLY, null, WITH_PICK.byId)).toMatchObject({ checked: false, changeable: false, how: "turnedOff" });
    expect(chooseRowView(OFF_PICKED, null, null)).toMatchObject({ checked: false, changeable: false, how: "turnedOff" });
    const marked = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: OFF_PICKED, rules: WITH_PICK });
    expect(marked.marks).toEqual([{ productVariantId: 140, to: "not_selected", basis: { reason: "disabled_by_vendor_override", includeRuleIds: [40], excludeRuleIds: [] } }]);
    expect(chooseRowView(OFF_PICKED, marked.marks[0], WITH_PICK.byId)).toMatchObject({ checked: false, changed: "remove", how: "willRemove" });
    expect(reduceChooseChanges(marked, { type: "toggle", row: OFF_PICKED, rules: WITH_PICK })).toBe(EMPTY_CHOOSE_CHANGES);
    // The header box: checking leaves it (already checked), unchecking marks it; an older-setting-only row is skipped.
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "setShown", rows: [OFF_PICKED, OFF_OLDER_ONLY], checked: true, rules: WITH_PICK })).toBe(EMPTY_CHOOSE_CHANGES);
    expect(reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "setShown", rows: [OFF_PICKED, OFF_OLDER_ONLY], checked: false, rules: WITH_PICK }).marks
      .map((entry) => `${entry.productVariantId}:${entry.to}`)).toEqual(["140:not_selected"]);
    expect(shownTick([OFF_PICKED, OFF_OLDER_ONLY], EMPTY_CHOOSE_CHANGES, WITH_PICK.byId)).toEqual({ tick: "all", changeable: 1 });
  });

  it("VR2 (V6) a reload keeps the remove while the pick is saved, drops it once the size reads not selected, and drops it when the pick is gone", () => {
    const marked = reduceChooseChanges(EMPTY_CHOOSE_CHANGES, { type: "toggle", row: OFF_PICKED, rules: WITH_PICK });
    expect(marked.marks).toHaveLength(1);
    expect(reduceChooseChanges(marked, { type: "reconcile", rows: [OFF_PICKED], rules: WITH_PICK })).toBe(marked);
    expect(reduceChooseChanges(marked, { type: "reconcile", rows: [row(140, "missing_vendor_include_rule")], rules: VIEW })).toBe(EMPTY_CHOOSE_CHANGES);
    // Another tab replaced the pick with an older setting: no pick left to remove.
    expect(reduceChooseChanges(marked, { type: "reconcile", rows: [row(140, "disabled_by_vendor_override", [2])], rules: VIEW })).toBe(EMPTY_CHOOSE_CHANGES);
  });

  it("VR3 (V6) removing a turned-off size's own pick deletes it; under an older include too, a keep-out is written", () => {
    const remove = mark(140, "not_selected", OFF_PICKED);
    expect(buildChooseSelectionSave([...RULES, OWN_PICK_140], [remove])).toEqual(RULES.map((entry) => toSelectionRuleInput(entry)));
    const withOlder = mark(140, "not_selected", OFF_PICKED_AND_OLDER);
    expect(buildChooseSelectionSave([...RULES, OWN_PICK_140], [withOlder])).toEqual([
      ...RULES.map((entry) => toSelectionRuleInput(entry)),
      { scopeType: "variant", action: "exclude", productVariantId: 140, autoConnectNewSkus: false, autoListNewSkus: false, priority: 200, metadata: { source: "portal_catalog" } },
    ]);
    // The saved line: the size now reads not selected, so the remove took.
    expect(chooseSaveResult([remove], [row(140, "missing_vendor_include_rule")])).toEqual({ add: 0, remove: 1, notTaken: 0 });
  });

  it("VR4 (V1) after an earlier save is found or another tab saved: with nothing left to save, the bar says what happened, never an error", () => {
    const sent = [mark(105, "selected", R105), mark(101, "not_selected", R101)];
    const after = [row(105, "selected", [9]), row(101, "missing_vendor_include_rule")];
    expect(describeChooseMove("committedEarlier", 0, sent, after)).toEqual({ kind: "saved", add: 1, remove: 1, notTaken: 0 });
    expect(describeChooseMove("committedEarlier", 0, sent, null)).toEqual({ kind: "saved", add: 1, remove: 1, notTaken: 0 });
    expect(describeChooseMove("stale", 0, sent, after)).toEqual({ kind: "info", message: CHOOSE_WORDS.staleNothingLeft });
    // Changes left: the vendor reviews and saves again.
    expect(describeChooseMove("committedEarlier", 1, sent, after)).toEqual({ kind: "error", message: CHOOSE_WORDS.lastSaveWentThrough });
    expect(describeChooseMove("stale", 2, sent, after)).toEqual({ kind: "error", message: CHOOSE_WORDS.stale });
  });
});
