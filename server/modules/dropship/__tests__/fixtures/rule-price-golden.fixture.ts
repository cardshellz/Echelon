/**
 * Golden rule prices: one store profile, sizes that reach every branch of the
 * rule resolver, and the exact result each must keep. The expected values,
 * evidence hashes included, were produced by resolveListingRulePrice before
 * the shared rule-price resolver existed. A refactor that changes any of them
 * changes what vendors were shown and what a queued push checks, so they are
 * written out here, never regenerated to make a test pass.
 */
import type { PricingProfileState } from "../../../../../shared/dropship/pricing-rules";
import type { DropshipProductCost } from "../../application/dropship-product-cost";

// Keys in the order readPricingProfile returns them (the schema's order): the
// evidence hash serializes this object, so the order is part of the hash.
export const GOLDEN_RULE_PROFILE_STATE: PricingProfileState = {
  revisionId: 41,
  profile: {
    defaultRecipe: { basis: "product_cost", markupBps: 4_250, flatCents: 0, rounding: "up_99" },
    groups: [
      { id: "sleeves", name: "Sleeves", priority: 10, scope: { type: "category", category: "Sleeves" },
        recipe: { basis: "catalog_retail", markupBps: 0, flatCents: 0, rounding: "cent" } },
      { id: "summer-line", name: "Summer line", priority: 20, scope: { type: "product_line", productLineId: 7 },
        recipe: { basis: "product_cost", markupBps: 10_000, flatCents: 150, rounding: "cent" } },
      { id: "toploader-35pt", name: "35pt toploaders", priority: 5, scope: { type: "product", productId: 300 },
        recipe: { basis: "product_cost", markupBps: 5_000, flatCents: 1, rounding: "cent" } },
      { id: "hand-picked", name: "Hand picked", priority: 1, scope: { type: "listings", productVariantIds: [5001] },
        recipe: { basis: "catalog_retail", markupBps: 2_500, flatCents: 0, rounding: "up_99" } },
      // Two groups at one priority that both match a size are a conflict.
      { id: "binders-a", name: "Binders A", priority: 30, scope: { type: "category", category: "Binders" },
        recipe: { basis: "product_cost", markupBps: 0, flatCents: 0, rounding: "cent" } },
      { id: "binders-b", name: "Binders B", priority: 30, scope: { type: "product_line", productLineId: 9 },
        recipe: { basis: "product_cost", markupBps: 0, flatCents: 0, rounding: "cent" } },
      { id: "huge-markup", name: "Huge markup", priority: 40, scope: { type: "category", category: "Graded slabs" },
        recipe: { basis: "catalog_retail", markupBps: 1_000_000, flatCents: 0, rounding: "cent" } },
    ],
  },
  updatedAt: "2026-10-01T12:00:00.000Z",
};

function cost(unitCostCents: number): DropshipProductCost {
  return { status: "available", unitCostCents, planId: "ops", source: "variant_fixed_price", overrideId: "override-1",
    issue: null, retailPriceCents: null, discountBps: null };
}
const unavailableCost: DropshipProductCost = { status: "unavailable", unitCostCents: null, planId: "ops", source: null,
  overrideId: null, issue: "variant_unmapped", retailPriceCents: null, discountBps: null };

export interface GoldenRulePriceCase {
  name: string;
  candidate: {
    productVariantId: number; productId: number; category: string | null;
    productLineIds: readonly number[]; defaultRetailPriceCents: number | null;
  };
  cost: DropshipProductCost | null;
}

export const GOLDEN_RULE_PRICE_CASES: readonly GoldenRulePriceCase[] = [
  { name: "store default from the .ops cost, rounded up to .99",
    candidate: { productVariantId: 1001, productId: 100, category: "Mailers", productLineIds: [], defaultRetailPriceCents: 999 }, cost: cost(809) },
  { name: "category rule from the catalog retail",
    candidate: { productVariantId: 2001, productId: 200, category: "Sleeves", productLineIds: [], defaultRetailPriceCents: 1_499 }, cost: cost(700) },
  { name: "product line rule with a flat amount, product lines given out of order",
    candidate: { productVariantId: 3001, productId: 310, category: "Toploaders", productLineIds: [11, 7, 3], defaultRetailPriceCents: 1_299 }, cost: cost(455) },
  { name: "product rule wins over the product line rule by priority",
    candidate: { productVariantId: 3002, productId: 300, category: "Toploaders", productLineIds: [7], defaultRetailPriceCents: 1_299 }, cost: cost(455) },
  { name: "hand-picked size rule wins over everything",
    candidate: { productVariantId: 5001, productId: 300, category: "Sleeves", productLineIds: [7], defaultRetailPriceCents: 2_000 }, cost: cost(455) },
  { name: "two matching rules at one priority",
    candidate: { productVariantId: 6001, productId: 600, category: "Binders", productLineIds: [9], defaultRetailPriceCents: 2_499 }, cost: cost(1_000) },
  { name: "store default with the .ops cost unknown",
    candidate: { productVariantId: 7001, productId: 700, category: "Mailers", productLineIds: [], defaultRetailPriceCents: 999 }, cost: unavailableCost },
  { name: "store default with no cost read at all",
    candidate: { productVariantId: 7002, productId: 700, category: "Mailers", productLineIds: [], defaultRetailPriceCents: 999 }, cost: null },
  { name: "category rule with no catalog retail",
    candidate: { productVariantId: 8001, productId: 800, category: "Sleeves", productLineIds: [], defaultRetailPriceCents: null }, cost: cost(300) },
  { name: "a recipe that lands above the largest listing price",
    candidate: { productVariantId: 9001, productId: 900, category: "Graded slabs", productLineIds: [], defaultRetailPriceCents: 99_999_999 }, cost: cost(5_000) },
  { name: "a zero cost with no markup or flat amount prices at zero, which is out of range",
    candidate: { productVariantId: 9101, productId: 910, category: "Binders", productLineIds: [], defaultRetailPriceCents: 500 }, cost: cost(0) },
  { name: "half a cent rounds up (15 x 1.5 + 1 = 23.5)",
    candidate: { productVariantId: 9201, productId: 300, category: "Toploaders", productLineIds: [], defaultRetailPriceCents: 1_299 }, cost: cost(15) },
];

export interface GoldenRulePrice {
  productVariantId: number;
  priceCents: number | null;
  ruleName: string | null;
  ruleId: string | null;
  issue: string | null;
  basis: "product_cost" | "catalog_retail" | null;
  profileRevisionId: number | null;
  evidenceHash: string;
}

/**
 * Pinned from resolveListingRulePrice as it was before the shared resolver
 * (commit 9665e780), one entry per case above, in order.
 */
export const GOLDEN_RULE_PRICES: readonly GoldenRulePrice[] = [
  { productVariantId: 1001, priceCents: 1_199, ruleName: "Store default rule", ruleId: null,
    issue: null, basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "e3b7cda35e4a30d15bba0ebfe688c1aac2841553c800f2ad823265f8d13c9d01" },
  { productVariantId: 2001, priceCents: 1_499, ruleName: "Sleeves", ruleId: "sleeves",
    issue: null, basis: "catalog_retail", profileRevisionId: 41,
    evidenceHash: "86f3f10eff622119600872dc6ff0bdd9902c0d7c35cabff8849e3b6ba807ae9e" },
  { productVariantId: 3001, priceCents: 1_060, ruleName: "Summer line", ruleId: "summer-line",
    issue: null, basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "1acc06c68fbaf4e2eda7544e7bdc255e0c87f2c632221cc4035ceb1261d3acc3" },
  { productVariantId: 3002, priceCents: 684, ruleName: "35pt toploaders", ruleId: "toploader-35pt",
    issue: null, basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "66a957215fae844974e0d49ab35857056bf01c10acf76dc3e29f44756b6b9e74" },
  { productVariantId: 5001, priceCents: 2_599, ruleName: "Hand picked", ruleId: "hand-picked",
    issue: null, basis: "catalog_retail", profileRevisionId: 41,
    evidenceHash: "6a697e738208d4666d7960302d55fd646362cb23a348f955dc16091f333077a3" },
  { productVariantId: 6001, priceCents: null, ruleName: null, ruleId: null,
    issue: "pricing_rule_priority_conflict", basis: null, profileRevisionId: 41,
    evidenceHash: "89397db8f1ba04c57dd1d865c77b03fb879cb735a813a3277be3a8d43379ab6e" },
  { productVariantId: 7001, priceCents: null, ruleName: "Store default rule", ruleId: null,
    issue: "pricing_basis_unavailable", basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "5ae9a9c721d167360b87a6f2d9e1906adc1faa0c3478c83f112deb72958026be" },
  { productVariantId: 7002, priceCents: null, ruleName: "Store default rule", ruleId: null,
    issue: "pricing_basis_unavailable", basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "7735ffb7c64c9799eaccbd0697fad9dbc6152e3a96aa3f2cc170e1fddf81e879" },
  { productVariantId: 8001, priceCents: null, ruleName: "Sleeves", ruleId: "sleeves",
    issue: "pricing_basis_unavailable", basis: "catalog_retail", profileRevisionId: 41,
    evidenceHash: "6ee63b80e7054da6e6153872f244364870efe8c2a899cc501623bc77f83a0cf0" },
  { productVariantId: 9001, priceCents: null, ruleName: "Huge markup", ruleId: "huge-markup",
    issue: "pricing_result_out_of_range", basis: "catalog_retail", profileRevisionId: 41,
    evidenceHash: "60ac97a9c42fd2e53390c9aa19eba52faa6b3dbca62fe93805e11c140cfeff80" },
  { productVariantId: 9101, priceCents: null, ruleName: "Binders A", ruleId: "binders-a",
    issue: "pricing_result_out_of_range", basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "a2bcf1e9495e64b703b3466d95d44e1834d4a501e4e68120487b8b093ec1f5ac" },
  { productVariantId: 9201, priceCents: 24, ruleName: "35pt toploaders", ruleId: "toploader-35pt",
    issue: null, basis: "product_cost", profileRevisionId: 41,
    evidenceHash: "8c7ec637995fdceaef04e1cefdfb6c0369ca1c2d1b8b0e257fd6fafc4b054117" },
];
