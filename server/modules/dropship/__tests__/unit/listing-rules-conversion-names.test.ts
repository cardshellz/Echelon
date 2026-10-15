import { describe, expect, it } from "vitest";
import { MAX_CONVERSION_REPORT_ITEMS } from "../../../../../shared/dropship/listing-rules-conversion";
import { conversionList, planRulesConversion } from "../../application/dropship-listing-rules-conversion";
import { DropshipError } from "../../domain/errors";
import {
  assertConversionCategoriesByName, categoryNameMismatches, categoryTargets, type ConversionCategory, type ConversionNameCandidate,
} from "../../domain/listing-rules-conversion-names";
import {
  COST_PLUS_40, SLEEVES, TOPLOADERS, byCategory, candidate, categoriesByName, conversionInputs, deepFreeze, inCategory,
  listingInputs, pricingState,
} from "../fixtures/listing-rules-conversion.fixture";

/*
 * Names to ids (plan D8, 4.A.5, 4.A.9 "Names"; REC:930): exact and raw, every
 * category, the report's unmatched, shared and mismatched names, in a fixed
 * order. Planner cases here go through planRulesConversion so the names are
 * read the way the plan reads them.
 */

const NAMES: ReadonlyMap<number, string> = new Map([[SLEEVES.id, SLEEVES.name], [TOPLOADERS.id, TOPLOADERS.name]]);

function product(productId: number, category: string | null, categoryId: number | null, productName = `Product ${productId}`): ConversionNameCandidate {
  return { productId, productName, category, categoryId };
}

function expectInvariant(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DropshipError);
    expect((error as DropshipError).code).toBe("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED");
    expect((error as DropshipError).context).toMatchObject({ classification: "fatal", retryable: false });
    return;
  }
  throw new Error("Expected a fatal invariant failure.");
}

describe("categoryTargets", () => {
  it("finds the one category with exactly the rule's name", () => {
    expect(categoryTargets("Sleeves", categoriesByName(SLEEVES, TOPLOADERS))).toEqual([SLEEVES]);
  });

  it("finds none for a name no category has", () => {
    expect(categoryTargets("Binders", new Map([...categoriesByName(SLEEVES, TOPLOADERS), ["Binders", []]]))).toEqual([]);
  });

  it("refuses a name that was never looked up, rather than read it as one no category has", () => {
    expectInvariant(() => categoryTargets("Binders", categoriesByName(SLEEVES, TOPLOADERS)));
  });

  it("finds every category of a shared name, by id", () => {
    const second: ConversionCategory = { id: 4, name: "Sleeves" };
    expect(categoryTargets("Sleeves", categoriesByName(SLEEVES, second))).toEqual([second, SLEEVES]);
  });

  it("takes case and surrounding spaces as they are: no match", () => {
    // "Sleeves" was looked up and no category has exactly that name.
    const names = new Map([...categoriesByName({ id: 20, name: " Sleeves" }, { id: 21, name: "sleeves" }, { id: 22, name: "Sleeves " }),
      ["Sleeves", []]]);
    expect(categoryTargets("Sleeves", names)).toEqual([]);
    expect(categoryTargets(" Sleeves", names)).toEqual([{ id: 20, name: " Sleeves" }]);
  });

  it("counts an inactive category as a target: nothing but its name and id is read", () => {
    const inactive = { id: 30, name: "Old sleeves", isActive: false };
    expect(categoryTargets("Old sleeves", new Map([["Old sleeves", [inactive]]]))).toEqual([{ id: 30, name: "Old sleeves" }]);
  });

  it("refuses a category listed under a name it does not have, or twice", () => {
    expectInvariant(() => categoryTargets("Sleeves", new Map([["Sleeves", [TOPLOADERS]]])));
    expectInvariant(() => categoryTargets("Sleeves", new Map([["Sleeves", [SLEEVES, SLEEVES]]])));
    expectInvariant(() => categoryTargets("Sleeves", new Map([["Sleeves", [{ id: 0, name: "Sleeves" }]]])));
    expectInvariant(() => assertConversionCategoriesByName(new Map([["Sleeves", [SLEEVES]], ["Toploaders", [{ id: SLEEVES.id, name: "Toploaders" }]]])));
  });

  it("returns new objects and leaves its frozen inputs alone", () => {
    const names = deepFreeze(categoriesByName(SLEEVES, { id: 4, name: "Sleeves" }));
    const targets = categoryTargets("Sleeves", names);
    targets.push({ id: 99, name: "Sleeves" });
    expect(categoryTargets("Sleeves", names)).toEqual([{ id: 4, name: "Sleeves" }, SLEEVES]);
  });
});

describe("categoryNameMismatches", () => {
  it("lists a copy with no category, a category with no copy, and a copy that differs, once per product", () => {
    const mismatches = categoryNameMismatches([
      product(1, "Binders", null, "Binder A"),
      product(2, null, SLEEVES.id, "Binder B"),
      product(3, "Sleeves", TOPLOADERS.id, "Binder C"),
      product(3, "Sleeves", TOPLOADERS.id, "Binder C"),
      product(4, "Sleeves", SLEEVES.id, "Matches"),
      product(5, null, null, "No category"),
    ], NAMES);
    expect(mismatches).toEqual([
      { productId: 1, productName: "Binder A", listedAs: "Binders", categoryName: null },
      { productId: 2, productName: "Binder B", listedAs: null, categoryName: "Sleeves" },
      { productId: 3, productName: "Binder C", listedAs: "Sleeves", categoryName: "Toploaders" },
    ]);
  });

  it("takes case and surrounding spaces as they are", () => {
    expect(categoryNameMismatches([product(1, "sleeves", SLEEVES.id), product(2, "Sleeves ", SLEEVES.id)], NAMES)).toEqual([
      { productId: 1, productName: "Product 1", listedAs: "sleeves", categoryName: "Sleeves" },
      { productId: 2, productName: "Product 2", listedAs: "Sleeves ", categoryName: "Sleeves" },
    ]);
  });

  it("sorts by product name as a person reads it, then id", () => {
    const mismatches = categoryNameMismatches([
      product(9, "X", null, "pack 10"), product(8, "X", null, "Pack 2"), product(7, "X", null, "Pack 2"), product(6, "X", null, "apple"),
    ], NAMES);
    expect(mismatches.map((item) => item.productId)).toEqual([6, 7, 8, 9]);
  });

  it("refuses a category with no current name and a product whose sizes disagree", () => {
    expectInvariant(() => categoryNameMismatches([product(1, "Mailers", 99)], NAMES));
    expectInvariant(() => categoryNameMismatches([product(1, "Sleeves", SLEEVES.id), product(1, "Sleeves", TOPLOADERS.id)], NAMES));
    expectInvariant(() => categoryNameMismatches([product(1, "Sleeves", SLEEVES.id), product(1, "Toploaders", SLEEVES.id)], NAMES));
  });

  it("leaves its frozen inputs alone", () => {
    const products = deepFreeze([product(1, "Binders", null), product(2, "Sleeves", SLEEVES.id)]);
    expect(categoryNameMismatches(products, deepFreeze(new Map(NAMES)))).toHaveLength(1);
  });
});

describe("names through the planner", () => {
  const sleevesRule = pricingState([{ id: "sleeves", name: "Sleeves rule", priority: 10, scope: byCategory("Sleeves"), value: COST_PLUS_40 }]);

  it("writes a shared name's rule to every category of that name and lists it once, with the count", () => {
    const second: ConversionCategory = { id: 4, name: "Sleeves" };
    const plan = planRulesConversion(conversionInputs(listingInputs([inCategory(SLEEVES, { productVariantId: 101, productId: 1 })],
      { pricing: sleevesRule }), { categoriesByName: categoriesByName(SLEEVES, second, TOPLOADERS) }));
    expect(plan.categories.map((write) => [write.categoryId, write.patch])).toEqual([[4, { price: COST_PLUS_40 }], [12, { price: COST_PLUS_40 }]]);
    expect(plan.report.shared).toEqual([{ ruleName: "Sleeves rule", categoryName: "Sleeves", categoryCount: 2, kind: "price" }]);
    expect(plan.report.unmatched).toEqual([]);
    expect(plan.report.neverApplies).toEqual([]);
  });

  it("lists a rule saved before a Card Shellz rename as unmatched, never as never applying", () => {
    // Card Shellz renamed "Sleeves" to "Card Sleeves": the rename rewrote the products' copies, not the rule.
    const renamed: ConversionCategory = { id: SLEEVES.id, name: "Card Sleeves" };
    const listing = listingInputs([inCategory(renamed, { productVariantId: 101, productId: 1 })], { pricing: sleevesRule,
      categoryNames: new Map([[SLEEVES.id, "Card Sleeves"]]) });
    const plan = planRulesConversion(conversionInputs(listing, { catalog: [renamed] }));
    expect(conversionInputs(listing, { catalog: [renamed] }).categoriesByName).toEqual(new Map([["Sleeves", []]]));
    expect(plan.categories).toEqual([]);
    expect(plan.report.unmatched).toEqual([{ ruleName: "Sleeves rule", categoryName: "Sleeves", kind: "price" }]);
    expect(plan.report.neverApplies).toEqual([]);
    expect(plan.report.nameMismatches).toEqual([]);
  });

  it("lists an unmatched name that still wins through a copy once, under unmatched", () => {
    // A copy written alone (the Shopify backfill) still lets the "Binders" rule price the size today.
    const binders = pricingState([{ id: "binders", name: "Binders rule", priority: 10, scope: byCategory("Binders"), value: COST_PLUS_40 }]);
    const plan = planRulesConversion(conversionInputs(listingInputs([candidate({ productVariantId: 101, productId: 1, category: "Binders" })],
      { pricing: binders })));
    expect(plan.report.unmatched).toEqual([{ ruleName: "Binders rule", categoryName: "Binders", kind: "price" }]);
    expect(plan.report.neverApplies).toEqual([]);
    expect(plan.report.nameMismatches).toEqual([{ productId: 1, productName: "Product 1", listedAs: "Binders", categoryName: null }]);
    expect(plan.categories).toEqual([]);
    expect(plan.products).toEqual([]);
  });

  it("never gives a mismatched product a value of its own from a category rule", () => {
    const plan = planRulesConversion(conversionInputs(listingInputs([
      candidate({ productVariantId: 101, productId: 1, category: "Sleeves", categoryId: TOPLOADERS.id }),
    ], { pricing: sleevesRule })));
    expect(plan.products).toEqual([]);
    expect(plan.categories.map((write) => write.categoryId)).toEqual([SLEEVES.id]);
    expect(plan.report.nameMismatches).toEqual([{ productId: 1, productName: "Product 1", listedAs: "Sleeves", categoryName: "Toploaders" }]);
  });

  it("caps a long list at 100 items in order and counts them all", () => {
    const sizes = Array.from({ length: 150 }, (_, index) =>
      candidate({ productVariantId: 1_000 + index, productId: 500 + index, productName: `Binder ${index + 1}`, category: "Binders" }));
    const plan = planRulesConversion(conversionInputs(listingInputs(sizes, { pricing: sleevesRule })));
    const list = conversionList(plan.report.nameMismatches);
    expect(list.total).toBe(150);
    expect(list.items).toHaveLength(MAX_CONVERSION_REPORT_ITEMS);
    expect(list.items.slice(0, 3).map((item) => item.productName)).toEqual(["Binder 1", "Binder 2", "Binder 3"]);
    expect(list.items.at(-1)?.productName).toBe("Binder 100");
  });
});
