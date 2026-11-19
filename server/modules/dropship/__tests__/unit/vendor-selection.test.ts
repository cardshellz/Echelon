import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DropshipCatalogExposureDecision, DropshipCatalogVariantCandidate } from "../../domain/catalog-exposure";
import {
  computeDropshipMarketplaceQuantity,
  evaluateDropshipVendorCatalogSelection,
  vendorRulesPick,
  type DropshipVendorCatalogSelectionDecision,
  type DropshipVendorSelectionRule,
  type DropshipVendorVariantOverride,
  type EvaluateDropshipVendorCatalogSelectionInput,
} from "../../domain/vendor-selection";
import { legacyEvaluateVendorSelection, type LegacyVendorSelectionInput } from "../fixtures/legacy-vendor-selection";
import { legacyDecisionUnderPicks } from "../fixtures/legacy-vendor-selection-meaning";

/**
 * PR B's evaluator (step 1 plan S2-5, PLAN-B v4.1 §7.1, §15.1; TESTS-2, SAFETY-12): selection from the
 * vendor's pick, and the frozen oracle, a verbatim copy of A's evaluator pinned by sha256. Recorded green at
 * main (B1a) against the evaluator then in the tree; since B1c it proves that B's evaluator fed the frozen
 * rules' pick (`vendorRulesPick`) decides every size as A's evaluator did, over every scope, include+exclude
 * pair and override fixture.
 */

const ORACLE_PATH = "server/modules/dropship/__tests__/fixtures/legacy-vendor-selection.ts";
const ORACLE_SOURCE_COMMIT = "cea5cb0279982a5688dd96a712a0ed2f522f88af";
/**
 * The sha256 of each frozen region, taken at main with
 * `git show cea5cb027:server/modules/dropship/domain/vendor-selection.ts | sed -n '<from>,<to>p' | sha256sum`.
 * Keyed by the source line range the region's marker names.
 */
const FROZEN_REGION_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "10-50": "cc2c5ee08f1b4d8436aafc0ac05e07b5673cb3c60393c5540bafdb726933f5bb",
  "52-141": "961d333228f15e28bd301d92d92e31b23143123ce97e202664777081b4f78ce3",
  "143-153": "40a8be61a07d4e5c31c2552311441cc90a3a658122baea6eddbd754f4f56c820",
  "189-221": "168f548cd98a311550b20ef4fff394a4307a08e130929726dae8710f6be9d546",
});
/** The only code the oracle file may hold outside its frozen regions (comments dropped, whitespace collapsed). */
const ORACLE_CODE_OUTSIDE_REGIONS = [
  "import { dropshipCatalogRuleMatchesVariant, type DropshipCatalogExposureDecision,",
  "type DropshipCatalogExposureScope, type DropshipCatalogVariantCandidate, } from \"../../domain/catalog-exposure\";",
  "export const legacyEvaluateVendorSelection = evaluateDropshipVendorCatalogSelection;",
  "export type LegacyVendorSelectionRule = DropshipVendorSelectionRule;",
  "export type LegacyVendorSelectionInput = EvaluateDropshipVendorCatalogSelectionInput;",
  "export type LegacyVendorSelectionDecision = DropshipVendorCatalogSelectionDecision;",
].join(" ");
const FROZEN_REGION = /^\/\/ <frozen-source lines="(\d+)-(\d+)">\n([\s\S]*?)^\/\/ <\/frozen-source>$/gm;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("frozen A evaluator (the oracle)", () => {
  it("is main's evaluator byte for byte: every frozen region hashes to its recorded sha256", () => {
    const text = readFileSync(resolve(process.cwd(), ORACLE_PATH), "utf8");
    const regions = [...text.matchAll(FROZEN_REGION)].map((match) => ({
      range: `${match[1]}-${match[2]}`, from: Number(match[1]), to: Number(match[2]), body: match[3],
    }));

    expect(regions.map((region) => region.range)).toEqual(Object.keys(FROZEN_REGION_SHA256));
    for (const region of regions) {
      // A region is exactly its source lines: one newline-terminated line per source line.
      expect(region.body.endsWith("\n")).toBe(true);
      expect(region.body.split("\n").length - 1).toBe(region.to - region.from + 1);
      expect(sha256(region.body), `region ${region.range}`).toBe(FROZEN_REGION_SHA256[region.range]);
      expect(text, "the header names every region's sha256").toContain(FROZEN_REGION_SHA256[region.range]);
    }
    expect(text).toContain(ORACLE_SOURCE_COMMIT);

    const outside = text.replace(FROZEN_REGION, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    expect(outside).toBe(ORACLE_CODE_OUTSIDE_REGIONS);
  });

  it("decides the stored A meanings (anchors independent of the live evaluator)", () => {
    const candidate = CANDIDATES[0];
    const exposed = EXPOSURES[0];
    expect(legacyEvaluateVendorSelection({
      candidate, adminExposureDecision: EXPOSURES[1], rules: [{ id: 1, scopeType: "catalog", action: "include" }], rawAtpUnits: 5,
    })).toMatchObject({ selected: false, reason: "not_exposed_by_admin", marketplaceQuantity: 0 });
    expect(legacyEvaluateVendorSelection({
      candidate, adminExposureDecision: exposed, rawAtpUnits: 5, rules: [
        { id: 1, scopeType: "catalog", action: "include" },
        { id: 2, scopeType: "variant", action: "exclude", productVariantId: candidate.productVariantId },
      ],
    })).toMatchObject({ selected: false, reason: "excluded_by_vendor_rule", includeRuleIds: [1], excludeRuleIds: [2] });
    expect(legacyEvaluateVendorSelection({
      candidate, adminExposureDecision: exposed, rules: [], rawAtpUnits: 5,
    })).toMatchObject({ selected: false, reason: "missing_vendor_include_rule" });
    expect(legacyEvaluateVendorSelection({
      candidate, adminExposureDecision: exposed, rawAtpUnits: 9,
      rules: [{ id: 1, scopeType: "category", action: "include", category: " SUPPLIES " }],
      override: { productVariantId: candidate.productVariantId, enabledOverride: false },
    })).toMatchObject({ selected: false, reason: "disabled_by_vendor_override", includeRuleIds: [1] });
    expect(legacyEvaluateVendorSelection({
      candidate, adminExposureDecision: exposed, rawAtpUnits: 9,
      rules: [{ id: 1, scopeType: "product_line", action: "include", productLineId: 30, autoListNewSkus: true }],
      override: { productVariantId: candidate.productVariantId, marketplaceQuantityCap: 4 },
    })).toEqual({
      selected: true, reason: "selected", adminExposureReason: "exposed", includeRuleIds: [1], excludeRuleIds: [],
      autoConnectNewSkus: true, autoListNewSkus: true, marketplaceQuantity: 4, quantityCapApplied: true,
    });
  });

  it("equals B's evaluator fed the frozen rules' pick over every scope, include+exclude pair and override fixture", () => {
    const cases = equivalenceCases();
    const mismatches: string[] = [];
    const reasons = new Set<DropshipVendorCatalogSelectionDecision["reason"]>();
    const seen = { capApplied: false, autoList: false, autoConnectOff: false, includeIds: false, excludeIds: false };
    let selectedCount = 0;
    for (const testCase of cases) {
      const input = deepFreeze(testCase.input);
      const before = JSON.stringify(input);
      const oracle = legacyEvaluateVendorSelection(input);
      const picked = vendorRulesPick(input.rules, input.candidate);
      const { rules: _rules, ...rest } = input;
      const live = evaluateDropshipVendorCatalogSelection({ ...rest, picked });
      // Same selection, quantity and exposure reason; the keep-out reason under its retained name; no rule ids.
      if (JSON.stringify(live) !== JSON.stringify(legacyDecisionUnderPicks(oracle, picked))) mismatches.push(testCase.label);
      if (live.selected !== oracle.selected) mismatches.push(`${testCase.label}: selected`);
      if (JSON.stringify(input) !== before) mismatches.push(`${testCase.label}: input mutated`);
      reasons.add(oracle.reason);
      if (oracle.selected) selectedCount += 1;
      seen.capApplied ||= oracle.quantityCapApplied;
      seen.autoList ||= oracle.autoListNewSkus;
      seen.autoConnectOff ||= oracle.selected && !oracle.autoConnectNewSkus;
      seen.includeIds ||= oracle.includeRuleIds.length > 1;
      seen.excludeIds ||= oracle.excludeRuleIds.length > 0;
    }

    expect(mismatches).toEqual([]);
    // The fixture reaches every branch of A's evaluator, so equality is not vacuous.
    expect(cases.length).toBeGreaterThan(15_000);
    expect(selectedCount).toBeGreaterThan(1_000);
    expect([...reasons].sort()).toEqual([
      "disabled_by_vendor_override", "excluded_by_vendor_rule", "missing_vendor_include_rule", "not_exposed_by_admin", "selected",
    ]);
    expect(seen).toEqual({ capApplied: true, autoList: true, autoConnectOff: true, includeIds: true, excludeIds: true });
  });
});

const PICK_CANDIDATE = { productId: 10, productVariantId: 20, productLineIds: [30], category: "Supplies",
  productIsActive: true, variantIsActive: true, variantUomType: "pack" as const } satisfies DropshipCatalogVariantCandidate;

function pickedInput(overrides: Partial<EvaluateDropshipVendorCatalogSelectionInput> = {}): EvaluateDropshipVendorCatalogSelectionInput {
  return { candidate: PICK_CANDIDATE, adminExposureDecision: EXPOSURES[0], picked: true, rawAtpUnits: 9, ...overrides };
}

describe("B's evaluator: selection from the vendor's pick (§7.1)", () => {
  it("decides every reason from picked, exposure and the override", () => {
    expect(evaluateDropshipVendorCatalogSelection(pickedInput())).toEqual({
      selected: true, reason: "selected", adminExposureReason: "exposed", picked: true, includeRuleIds: [], excludeRuleIds: [],
      autoConnectNewSkus: false, autoListNewSkus: false, marketplaceQuantity: 9, quantityCapApplied: false,
    });
    expect(evaluateDropshipVendorCatalogSelection(pickedInput({ picked: false }))).toEqual({
      selected: false, reason: "missing_vendor_include_rule", adminExposureReason: "exposed", picked: false, includeRuleIds: [],
      excludeRuleIds: [], autoConnectNewSkus: false, autoListNewSkus: false, marketplaceQuantity: 0, quantityCapApplied: false,
    });
    expect(evaluateDropshipVendorCatalogSelection(pickedInput({ override: { productVariantId: 20, enabledOverride: false } })))
      .toMatchObject({ selected: false, reason: "disabled_by_vendor_override", picked: true, marketplaceQuantity: 0 });
    expect(evaluateDropshipVendorCatalogSelection(pickedInput({ adminExposureDecision: EXPOSURES[2] })))
      .toMatchObject({ selected: false, reason: "not_exposed_by_admin", adminExposureReason: "excluded_by_admin_rule", picked: true, marketplaceQuantity: 0 });
    expect(evaluateDropshipVendorCatalogSelection(pickedInput({ adminExposureDecision: EXPOSURES[1], picked: false })))
      .toMatchObject({ selected: false, reason: "not_exposed_by_admin", picked: false });
  });

  it("a pick never bypasses Card Shellz's exposure (moved from dropship-selection-atp.test.ts)", () => {
    const decision = evaluateDropshipVendorCatalogSelection(pickedInput({ adminExposureDecision: EXPOSURES[1], rawAtpUnits: 5 }));
    expect(decision.selected).toBe(false);
    expect(decision.reason).toBe("not_exposed_by_admin");
    expect(decision.marketplaceQuantity).toBe(0);
  });

  it("selected exactly when exposed, picked and not turned off; never the retired keep-out reason; compatibility fields empty", () => {
    const reasons = new Set<string>();
    let cases = 0;
    for (const adminExposureDecision of EXPOSURES) {
      for (const picked of [true, false]) {
        for (const override of OVERRIDES) {
          for (const rawAtpUnits of RAW_ATP_UNITS) {
            for (const applyMarketplaceQuantityCap of APPLY_CAP) {
              const input = deepFreeze(pickedInput({ adminExposureDecision, picked, rawAtpUnits,
                override: override ? { ...override, productVariantId: 20 } : override,
                ...(applyMarketplaceQuantityCap === undefined ? {} : { applyMarketplaceQuantityCap }) }));
              const before = JSON.stringify(input);
              const decision = evaluateDropshipVendorCatalogSelection(input);
              cases += 1;
              reasons.add(decision.reason);
              expect(decision.selected).toBe(adminExposureDecision.exposed && picked && override?.enabledOverride !== false);
              expect(decision.picked).toBe(picked);
              expect(decision).toMatchObject({ includeRuleIds: [], excludeRuleIds: [], autoConnectNewSkus: false, autoListNewSkus: false });
              if (!decision.selected) expect(decision).toMatchObject({ marketplaceQuantity: 0, quantityCapApplied: false });
              expect(JSON.stringify(input)).toBe(before);
            }
          }
        }
      }
    }
    expect(cases).toBe(EXPOSURES.length * 2 * OVERRIDES.length * RAW_ATP_UNITS.length * APPLY_CAP.length);
    expect(reasons.has("excluded_by_vendor_rule")).toBe(false);
    expect([...reasons].sort()).toEqual(["disabled_by_vendor_override", "missing_vendor_include_rule", "not_exposed_by_admin", "selected"]);
  });

  it("applies the vendor's turn-off and the legacy quantity cap after selection (moved)", () => {
    const capped = evaluateDropshipVendorCatalogSelection(pickedInput({ override: { productVariantId: 20, marketplaceQuantityCap: 4 } }));
    const off = evaluateDropshipVendorCatalogSelection(pickedInput({ override: { productVariantId: 20, enabledOverride: false, marketplaceQuantityCap: 4 } }));
    expect(capped).toMatchObject({ selected: true, marketplaceQuantity: 4, quantityCapApplied: true });
    expect(off).toMatchObject({ selected: false, reason: "disabled_by_vendor_override", marketplaceQuantity: 0 });
  });

  it("does not apply the retired vendor cap to a canonical target quantity (moved)", () => {
    expect(evaluateDropshipVendorCatalogSelection(pickedInput({ override: { productVariantId: 20, marketplaceQuantityCap: 4 },
      applyMarketplaceQuantityCap: false }))).toMatchObject({ selected: true, marketplaceQuantity: 9, quantityCapApplied: false });
  });

  it("a picked category item adds no automation: picks are one-time (replaces the auto-connect case)", () => {
    expect(evaluateDropshipVendorCatalogSelection(pickedInput())).toMatchObject({ autoConnectNewSkus: false, autoListNewSkus: false });
  });

  it("normalizes invalid or negative ATP to zero (moved)", () => {
    expect(computeDropshipMarketplaceQuantity(-5)).toBe(0);
    expect(computeDropshipMarketplaceQuantity(Number.NaN)).toBe(0);
    expect(computeDropshipMarketplaceQuantity(7.9)).toBe(7);
  });
});

describe("vendorRulesPick: the frozen rules' pick (V36)", () => {
  const candidate = PICK_CANDIDATE;

  it("picks a size some active include matches and no active exclude matches", () => {
    expect(vendorRulesPick([], candidate)).toBe(false);
    expect(vendorRulesPick([{ id: 1, scopeType: "category", action: "include", category: " SUPPLIES " }], candidate)).toBe(true);
    expect(vendorRulesPick([{ id: 1, scopeType: "product_line", action: "include", productLineId: 31 }], candidate)).toBe(false);
  });

  it("an exclude blocks a broader include (moved from dropship-selection-atp.test.ts, rewritten)", () => {
    const rules: DropshipVendorSelectionRule[] = [
      { id: 10, scopeType: "catalog", action: "include" },
      { id: 11, scopeType: "variant", action: "exclude", productVariantId: 20 },
    ];
    expect(vendorRulesPick(rules, candidate)).toBe(false);
    expect(vendorRulesPick(rules, { ...candidate, productVariantId: 21 })).toBe(true);
  });

  it("skips inactive rules and, as A's evaluator did, rules without an id", () => {
    expect(vendorRulesPick([{ id: 1, scopeType: "catalog", action: "include", isActive: false }], candidate)).toBe(false);
    expect(vendorRulesPick([{ id: 1, scopeType: "catalog", action: "include" },
      { id: 2, scopeType: "variant", action: "exclude", productVariantId: 20, isActive: false }], candidate)).toBe(true);
    expect(vendorRulesPick([{ scopeType: "catalog", action: "include" }], candidate)).toBe(false);
    expect(vendorRulesPick([{ id: 1, scopeType: "catalog", action: "include" },
      { scopeType: "variant", action: "exclude", productVariantId: 20 }], candidate)).toBe(true);
  });

  it("does not mutate its inputs", () => {
    const rules = deepFreeze([{ id: 1, scopeType: "catalog" as const, action: "include" as const }]);
    expect(vendorRulesPick(rules, deepFreeze({ ...candidate }))).toBe(true);
  });
});

/**
 * Sizes covering every match path of `dropshipCatalogRuleMatchesVariant`: product lines (none, one, two),
 * the category in case, tab, no-break-space and trailing-space spellings, no category, and a category that
 * only shares a prefix.
 */
const CANDIDATES: readonly DropshipCatalogVariantCandidate[] = [
  { productId: 10, productVariantId: 20, productLineIds: [30], category: "Supplies" },
  { productId: 10, productVariantId: 21, productLineIds: [30], category: "Supplies" },
  { productId: 11, productVariantId: 22, productLineIds: [30, 31], category: "  SUPPLIES\t" },
  { productId: 12, productVariantId: 23, productLineIds: [], category: "supplies " },
  { productId: 13, productVariantId: 24, productLineIds: [31], category: null },
  { productId: 14, productVariantId: 25, productLineIds: [], category: "Supplies Pro " },
].map((candidate) => ({ ...candidate, productIsActive: true, variantIsActive: true, variantUomType: "pack" as const }));

const EXPOSURES: readonly DropshipCatalogExposureDecision[] = [
  { exposed: true, reason: "exposed", includeRuleIds: [1], excludeRuleIds: [] },
  { exposed: false, reason: "missing_include_rule", includeRuleIds: [], excludeRuleIds: [] },
  { exposed: false, reason: "excluded_by_admin_rule", includeRuleIds: [1], excludeRuleIds: [2] },
  { exposed: false, reason: "inactive_product_or_variant", includeRuleIds: [], excludeRuleIds: [] },
];

type RuleTarget = Omit<DropshipVendorSelectionRule, "id" | "action">;

/** Every scope, with targets that match some sizes, all sizes or none. */
const TARGETS: readonly RuleTarget[] = [
  { scopeType: "catalog" },
  { scopeType: "product_line", productLineId: 30 },
  { scopeType: "product_line", productLineId: 31 },
  { scopeType: "product_line", productLineId: 99 },
  { scopeType: "category", category: "supplies" },
  { scopeType: "category", category: " Supplies " },
  { scopeType: "category", category: "SUPPLIES\t" },
  { scopeType: "category", category: "supplies pro" },
  { scopeType: "category", category: "toploaders" },
  { scopeType: "category", category: "   " },
  { scopeType: "category", category: null },
  { scopeType: "product", productId: 10 },
  { scopeType: "product", productId: 11 },
  { scopeType: "product", productId: 99 },
  { scopeType: "variant", productVariantId: 20 },
  { scopeType: "variant", productVariantId: 23 },
  { scopeType: "variant", productVariantId: 999 },
];

const OVERRIDES: readonly (DropshipVendorVariantOverride | null | undefined)[] = [
  undefined,
  null,
  { productVariantId: 20 },
  { productVariantId: 20, enabledOverride: true },
  { productVariantId: 20, enabledOverride: false },
  { productVariantId: 20, enabledOverride: null, marketplaceQuantityCap: null },
  { productVariantId: 20, marketplaceQuantityCap: 2 },
  { productVariantId: 20, marketplaceQuantityCap: 2.7, enabledOverride: true },
  { productVariantId: 20, marketplaceQuantityCap: -1 },
  { productVariantId: 20, marketplaceQuantityCap: 50, enabledOverride: false },
];
const RAW_ATP_UNITS: readonly number[] = [0, 5, 7.9, -3, Number.NaN, Number.POSITIVE_INFINITY];
const APPLY_CAP: readonly (boolean | undefined)[] = [undefined, true, false];

function numbered(rules: readonly Omit<DropshipVendorSelectionRule, "id">[], options: { withIds?: boolean } = {}): DropshipVendorSelectionRule[] {
  return rules.map((rule, index) => (options.withIds === false ? { ...rule } : { ...rule, id: 100 + index }));
}

function ruleSets(): { label: string; rules: DropshipVendorSelectionRule[] }[] {
  const include = (target: RuleTarget, extra: Partial<DropshipVendorSelectionRule> = {}) => ({ ...target, action: "include" as const, ...extra });
  const exclude = (target: RuleTarget, extra: Partial<DropshipVendorSelectionRule> = {}) => ({ ...target, action: "exclude" as const, ...extra });
  const catalog = TARGETS[0];
  const sets: { label: string; rules: DropshipVendorSelectionRule[] }[] = [{ label: "no rules", rules: [] }];
  TARGETS.forEach((target, i) => {
    sets.push({ label: `include ${i}`, rules: numbered([include(target)]) });
    sets.push({ label: `exclude ${i}`, rules: numbered([exclude(target)]) });
    sets.push({ label: `inactive include ${i}`, rules: numbered([include(target, { isActive: false })]) });
    sets.push({ label: `catalog + inactive exclude ${i}`, rules: numbered([include(catalog), exclude(target, { isActive: false })]) });
    TARGETS.forEach((other, j) => {
      sets.push({ label: `include ${i} + exclude ${j}`, rules: numbered([include(target), exclude(other)]) });
    });
  });
  // Overlapping includes that all match one size, with and without a narrower exclude.
  sets.push({ label: "overlapping includes", rules: numbered([include(catalog), include(TARGETS[4]), include(TARGETS[14])]) });
  sets.push({ label: "overlapping includes + exclude", rules: numbered([include(catalog), include(TARGETS[4]), include(TARGETS[14]), exclude(TARGETS[11])]) });
  sets.push({ label: "exclude before include", rules: numbered([exclude(TARGETS[14]), include(TARGETS[1])]) });
  // The automation flags each include carries, alone and mixed.
  for (const autoConnectNewSkus of [true, false, null, undefined]) {
    for (const autoListNewSkus of [true, false, null, undefined]) {
      sets.push({ label: `flags ${autoConnectNewSkus}/${autoListNewSkus}`, rules: numbered([include(catalog, { autoConnectNewSkus, autoListNewSkus })]) });
      sets.push({ label: `mixed flags ${autoConnectNewSkus}/${autoListNewSkus}`, rules: numbered([
        include(catalog, { autoConnectNewSkus: false, autoListNewSkus: false }),
        include(TARGETS[14], { autoConnectNewSkus, autoListNewSkus }),
      ]) });
    }
  }
  // Rules without ids (never saved) still decide; their ids are simply not reported.
  sets.push({ label: "include without id", rules: numbered([include(catalog)], { withIds: false }) });
  sets.push({ label: "include + exclude without ids", rules: numbered([include(catalog), exclude(TARGETS[14])], { withIds: false }) });
  sets.push({ label: "vendor id on rules", rules: numbered([include(catalog, { vendorId: 7 }), exclude(TARGETS[15], { vendorId: 7 })]) });
  return sets;
}

function equivalenceCases(): { label: string; input: LegacyVendorSelectionInput }[] {
  const cases: { label: string; input: LegacyVendorSelectionInput }[] = [];
  const sets = ruleSets();
  for (const set of sets) {
    CANDIDATES.forEach((candidate, c) => {
      EXPOSURES.forEach((adminExposureDecision, e) => {
        cases.push({ label: `${set.label} | size ${c} | exposure ${e}`, input: { candidate, adminExposureDecision, rules: set.rules, rawAtpUnits: 5 } });
      });
    });
  }
  // Overrides and the quantity inputs, under rule sets that select, exclude or miss.
  const quantitySets = sets.filter((set) => ["no rules", "include 0", "include 14", "include 0 + exclude 14"].includes(set.label));
  for (const set of quantitySets) {
    CANDIDATES.forEach((candidate, c) => {
      EXPOSURES.slice(0, 2).forEach((adminExposureDecision, e) => {
        OVERRIDES.forEach((override, o) => {
          RAW_ATP_UNITS.forEach((rawAtpUnits) => {
            APPLY_CAP.forEach((applyMarketplaceQuantityCap) => {
              const overrideForSize = override ? { ...override, productVariantId: candidate.productVariantId } : override;
              cases.push({
                label: `${set.label} | size ${c} | exposure ${e} | override ${o} | atp ${rawAtpUnits} | apply ${applyMarketplaceQuantityCap}`,
                input: {
                  candidate, adminExposureDecision, rules: set.rules, rawAtpUnits, override: overrideForSize,
                  ...(applyMarketplaceQuantityCap === undefined ? {} : { applyMarketplaceQuantityCap }),
                },
              });
            });
          });
        });
      });
    });
  }
  return cases;
}
