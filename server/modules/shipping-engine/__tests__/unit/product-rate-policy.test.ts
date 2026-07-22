import { describe, expect, it } from "vitest";
import {
  evaluateProductRatePolicy,
  validateProductRateRules,
  type ProductRateLine,
  type ProductRateRule,
} from "../../domain/product-rate-policy";

const DESTINATION = { country: "US", region: "CA", postalCode: "90210" };
const SCOPE = { country: "US", regions: ["CA"], postalPrefixes: [] };
const LINES: ProductRateLine[] = [
  { sku: "CASE-1", productVariantId: 10, quantity: 1, unitWeightGrams: 9_000, unitPriceCents: 6_000 },
  { sku: "PACK-1", productVariantId: 20, quantity: 2, unitWeightGrams: 500, unitPriceCents: 1_500 },
];

function rule(overrides: Partial<ProductRateRule> = {}): ProductRateRule {
  return {
    id: 1,
    name: "Case pricing",
    kind: "base_charge",
    action: "fixed",
    measurementScope: "matched_items",
    destinationScope: SCOPE,
    rateCents: 1_299,
    perStartedPoundCents: null,
    thresholdCents: null,
    memberVariantIds: [10],
    bands: [],
    isActive: true,
    ...overrides,
  };
}

describe("product shipping policy", () => {
  it("charges a product exception and rates unmatched lines from their own weight", () => {
    const fallbackWeights: number[] = [];
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [rule()],
      defaultRateForWeightGrams: (grams) => {
        fallbackWeights.push(grams);
        return 599;
      },
    });
    expect(result).toMatchObject({ ok: true, totalCents: 1_898 });
    expect(fallbackWeights).toEqual([1_000]);
    if (!result.ok) return;
    expect(result.trace).toEqual([
      expect.objectContaining({ kind: "default", amountCents: 599, skus: ["PACK-1"] }),
      expect.objectContaining({ kind: "base_charge", ruleId: 1, amountCents: 1_299, skus: ["CASE-1"] }),
    ]);
  });

  it("blocks before calculating a customer charge", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [rule({ kind: "restriction", action: "block", rateCents: null })],
      defaultRateForWeightGrams: () => {
        throw new Error("blocked shipments must not be rated");
      },
    });
    expect(result).toMatchObject({ ok: false, code: "BLOCKED", ruleId: 1 });
  });

  it("fails closed when one variant has overlapping base charges", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [rule(), rule({ id: 2, name: "Second case price", rateCents: 999 })],
      defaultRateForWeightGrams: () => 599,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_POLICY" });
    expect(result.ok ? "" : result.message).toContain("both price variant 10");
  });

  it("rates each matching unit from a gapless band schedule", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: [LINES[1]],
      rules: [rule({
        action: "fixed_band",
        measurementScope: "each_item",
        memberVariantIds: [20],
        rateCents: null,
        bands: [
          { minMeasure: 0, maxMeasure: 500, rateCents: 399 },
          { minMeasure: 501, maxMeasure: null, rateCents: 699 },
        ],
      })],
      defaultRateForWeightGrams: () => null,
    });
    expect(result).toMatchObject({ ok: true, totalCents: 798 });
  });

  it("makes matching buckets free after the configured item subtotal", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [
        rule(),
        rule({
          id: 3,
          name: "Cases free over $50",
          kind: "threshold",
          action: "free_threshold",
          rateCents: null,
          thresholdCents: 5_000,
        }),
      ],
      defaultRateForWeightGrams: () => 599,
    });
    expect(result).toMatchObject({ ok: true, totalCents: 599 });
  });

  it("removes qualifying threshold items from a mixed destination-default bucket", () => {
    const fallbackWeights: number[] = [];
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [rule({
        id: 3,
        name: "Cases free over $50",
        kind: "threshold",
        action: "free_threshold",
        rateCents: null,
        thresholdCents: 5_000,
      })],
      defaultRateForWeightGrams: (grams) => {
        fallbackWeights.push(grams);
        return 599;
      },
    });
    expect(result).toMatchObject({ ok: true, totalCents: 599 });
    expect(fallbackWeights).toEqual([1_000]);
  });

  it("fails closed when destination-default items have missing weight", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: [{ ...LINES[1], unitWeightGrams: null }],
      rules: [rule()],
      defaultRateForWeightGrams: () => 599,
    });
    expect(result).toMatchObject({ ok: false, code: "NO_RATE" });
  });

  it("fails closed when a free-shipping threshold cannot read item value", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: [{ ...LINES[0], unitPriceCents: null }],
      rules: [rule({
        kind: "threshold",
        action: "free_threshold",
        rateCents: null,
        thresholdCents: 5_000,
      })],
      defaultRateForWeightGrams: () => 599,
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_INPUT", ruleId: 1 });
  });

  it("adds a fixed surcharge after base charges", () => {
    const result = evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [
        rule(),
        rule({
          id: 4,
          name: "Oversize handling",
          kind: "adjustment",
          action: "surcharge",
          rateCents: 250,
        }),
      ],
      defaultRateForWeightGrams: () => 599,
    });
    expect(result).toMatchObject({ ok: true, totalCents: 2_148 });
  });

  it("does not apply a rule outside its destination scope", () => {
    const result = evaluateProductRatePolicy({
      destination: { country: "US", region: "PA", postalCode: "16066" },
      lines: LINES,
      rules: [rule()],
      defaultRateForWeightGrams: (grams) => grams === 10_000 ? 899 : null,
    });
    expect(result).toMatchObject({ ok: true, totalCents: 899 });
  });

  it("rejects gaps and carton-dependent rules at activation", () => {
    expect(validateProductRateRules([rule({
      action: "fixed_band",
      measurementScope: "carton",
      rateCents: null,
      bands: [{ minMeasure: 1, maxMeasure: 100, rateCents: 100 }],
    })])).toEqual(expect.arrayContaining([
      expect.stringContaining("carton measurement is unavailable"),
      expect.stringContaining("gapless and begin at zero"),
      expect.stringContaining("final weight band must be open-ended"),
    ]));
  });

  it("allows separate ZIP-prefix policies in the same state", () => {
    const errors = validateProductRateRules([
      rule({
        destinationScope: {
          country: "US",
          regions: [],
          postalPrefixes: [{ region: "CA", prefixes: ["90"] }],
        },
      }),
      rule({
        id: 2,
        name: "Northern California",
        destinationScope: {
          country: "US",
          regions: [],
          postalPrefixes: [{ region: "CA", prefixes: ["94"] }],
        },
      }),
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects nested ZIP-prefix policies for the same product", () => {
    const errors = validateProductRateRules([
      rule({
        destinationScope: {
          country: "US",
          regions: [],
          postalPrefixes: [{ region: "CA", prefixes: ["9"] }],
        },
      }),
      rule({
        id: 2,
        name: "Los Angeles",
        destinationScope: {
          country: "US",
          regions: [],
          postalPrefixes: [{ region: "CA", prefixes: ["90"] }],
        },
      }),
    ]);
    expect(errors).toEqual([expect.stringContaining("both price variant 10")]);
  });

  it("fails closed instead of throwing when stored destination JSON is malformed", () => {
    const malformedRule = rule({
      destinationScope: null as unknown as ProductRateRule["destinationScope"],
    });

    expect(validateProductRateRules([malformedRule])).toEqual([
      expect.stringContaining("select a valid destination scope"),
    ]);
    expect(evaluateProductRatePolicy({
      destination: DESTINATION,
      lines: LINES,
      rules: [malformedRule],
      defaultRateForWeightGrams: () => 599,
    })).toMatchObject({ ok: false, code: "INVALID_POLICY" });
  });
});
