/**
 * Unit Tests — Shopify Weight Backfill Service
 *
 * All tests use injected fake deps — no network, no DB.
 * Covers: unit conversion (all 4 units + rounding), the null-only update
 * guard, dry-run behavior (updater never called), report aggregation, and
 * error collection (never throws).
 */

import { describe, it, expect, vi } from "vitest";
import {
  runShopifyWeightBackfill,
  toGrams,
  type ShopifyWeightBackfillDeps,
  type WeightBackfillCandidate,
  type ShopifyWeightMeasurement,
} from "../../shopify-weight-backfill.service";

// ---------------------------------------------------------------------------
// Fake deps builder
// ---------------------------------------------------------------------------

function makeDeps(overrides: {
  candidates?: WeightBackfillCandidate[];
  weights?: Record<string, ShopifyWeightMeasurement>;
  fetchErrors?: string[];
  updateResult?: boolean | ((variantId: number, grams: number) => Promise<boolean>);
} = {}) {
  const listCandidateVariants = vi.fn(async (limit?: number) => {
    const all = overrides.candidates ?? [];
    return limit != null && limit > 0 ? all.slice(0, limit) : all;
  });

  const fetchShopifyWeights = vi.fn(async (_ids: string[]) => ({
    weights: new Map(Object.entries(overrides.weights ?? {})),
    errors: overrides.fetchErrors ?? [],
  }));

  const updateVariantWeightIfNull = vi.fn(async (variantId: number, grams: number) => {
    const r = overrides.updateResult ?? true;
    return typeof r === "function" ? r(variantId, grams) : r;
  });

  const deps: ShopifyWeightBackfillDeps = {
    listCandidateVariants,
    fetchShopifyWeights,
    updateVariantWeightIfNull,
  };

  return { deps, listCandidateVariants, fetchShopifyWeights, updateVariantWeightIfNull };
}

function candidate(id: number, sku: string | null, shopifyVariantId: string | null): WeightBackfillCandidate {
  return { id, sku, shopifyVariantId };
}

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

describe("toGrams", () => {
  it("converts GRAMS pass-through with rounding", () => {
    expect(toGrams("GRAMS", 500)).toBe(500);
    expect(toGrams("GRAMS", 12.4)).toBe(12);
    expect(toGrams("GRAMS", 12.5)).toBe(13);
  });

  it("converts KILOGRAMS to grams", () => {
    expect(toGrams("KILOGRAMS", 1)).toBe(1000);
    expect(toGrams("KILOGRAMS", 1.234)).toBe(1234);
    expect(toGrams("KILOGRAMS", 0.0005)).toBe(1); // rounds 0.5g up
  });

  it("converts OUNCES to grams (28.349523125 g/oz)", () => {
    expect(toGrams("OUNCES", 1)).toBe(28);
    expect(toGrams("OUNCES", 16)).toBe(454); // 453.59 → 454
    expect(toGrams("OUNCES", 3.5)).toBe(99); // 99.22 → 99
  });

  it("converts POUNDS to grams (453.59237 g/lb)", () => {
    expect(toGrams("POUNDS", 1)).toBe(454);
    expect(toGrams("POUNDS", 2)).toBe(907); // 907.18 → 907
    expect(toGrams("POUNDS", 0.25)).toBe(113); // 113.398 → 113
  });

  it("returns null for unknown units and non-finite values", () => {
    expect(toGrams("STONES", 1)).toBeNull();
    expect(toGrams("", 1)).toBeNull();
    expect(toGrams("GRAMS", NaN)).toBeNull();
    expect(toGrams("GRAMS", Infinity)).toBeNull();
  });

  it("converts zero (caller treats zero as unusable)", () => {
    expect(toGrams("GRAMS", 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Runner behavior
// ---------------------------------------------------------------------------

describe("runShopifyWeightBackfill", () => {
  it("dry-run (default) computes the report but NEVER calls the updater", async () => {
    const { deps, updateVariantWeightIfNull } = makeDeps({
      candidates: [candidate(1, "SKU-A", "111"), candidate(2, "SKU-B", "222")],
      weights: {
        "111": { unit: "GRAMS", value: 100 },
        "222": { unit: "POUNDS", value: 1 },
      },
    });

    const report = await runShopifyWeightBackfill({}, deps); // dryRun defaults to true

    expect(report.dryRun).toBe(true);
    expect(updateVariantWeightIfNull).not.toHaveBeenCalled();
    expect(report.candidates).toBe(2);
    expect(report.fetched).toBe(2);
    expect(report.updated).toBe(2); // would-be updates
    expect(report.sample).toEqual([
      { sku: "SKU-A", grams: 100 },
      { sku: "SKU-B", grams: 454 },
    ]);
    expect(report.errors).toEqual([]);
  });

  it("live run updates only via the null-guarded updater and counts guard rejections as skippedAlreadySet", async () => {
    const { deps, updateVariantWeightIfNull } = makeDeps({
      candidates: [candidate(1, "SKU-A", "111"), candidate(2, "SKU-B", "222")],
      weights: {
        "111": { unit: "GRAMS", value: 100 },
        "222": { unit: "KILOGRAMS", value: 2 },
      },
      // Variant 2's weight got set by someone else mid-run → guard returns false
      updateResult: async (variantId) => variantId !== 2,
    });

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(report.dryRun).toBe(false);
    expect(updateVariantWeightIfNull).toHaveBeenCalledTimes(2);
    expect(updateVariantWeightIfNull).toHaveBeenCalledWith(1, 100);
    expect(updateVariantWeightIfNull).toHaveBeenCalledWith(2, 2000);
    expect(report.updated).toBe(1);
    expect(report.skippedAlreadySet).toBe(1);
    expect(report.sample).toEqual([{ sku: "SKU-A", grams: 100 }]);
  });

  it("aggregates skippedNoMapping / skippedNoWeight / fetched correctly", async () => {
    const { deps, fetchShopifyWeights } = makeDeps({
      candidates: [
        candidate(1, "MAPPED-OK", "111"),
        candidate(2, "NO-MAPPING", null),
        candidate(3, "EMPTY-MAPPING", ""),
        candidate(4, "NO-WEIGHT", "444"), // Shopify returns nothing for this id
        candidate(5, "ZERO-WEIGHT", "555"), // Shopify's "no weight entered" zero
        candidate(6, "BAD-UNIT", "666"),
      ],
      weights: {
        "111": { unit: "OUNCES", value: 8 },
        "555": { unit: "GRAMS", value: 0 },
        "666": { unit: "FURLONGS", value: 3 },
      },
    });

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(report.candidates).toBe(6);
    expect(report.skippedNoMapping).toBe(2); // null + empty string
    // Only mapped ids are sent to Shopify
    expect(fetchShopifyWeights).toHaveBeenCalledWith(["111", "444", "555", "666"]);
    expect(report.skippedNoWeight).toBe(3); // missing, zero, unknown unit
    expect(report.fetched).toBe(1);
    expect(report.updated).toBe(1);
    expect(report.sample).toEqual([{ sku: "MAPPED-OK", grams: 227 }]); // 8 oz → 226.8 → 227
    expect(report.errors).toEqual([]);
  });

  it("respects the limit option", async () => {
    const { deps, listCandidateVariants } = makeDeps({
      candidates: [candidate(1, "A", "1"), candidate(2, "B", "2"), candidate(3, "C", "3")],
      weights: { "1": { unit: "GRAMS", value: 10 } },
    });

    const report = await runShopifyWeightBackfill({ dryRun: true, limit: 1 }, deps);

    expect(listCandidateVariants).toHaveBeenCalledWith(1);
    expect(report.candidates).toBe(1);
  });

  it("caps the sample at 10 entries", async () => {
    const candidates = Array.from({ length: 15 }, (_, i) => candidate(i + 1, `SKU-${i + 1}`, String(i + 1)));
    const weights = Object.fromEntries(
      candidates.map((c) => [c.shopifyVariantId!, { unit: "GRAMS", value: 100 }]),
    );
    const { deps } = makeDeps({ candidates, weights });

    const report = await runShopifyWeightBackfill({ dryRun: true }, deps);

    expect(report.updated).toBe(15);
    expect(report.sample).toHaveLength(10);
  });

  it("collects batch fetch errors into the report without aborting", async () => {
    const { deps } = makeDeps({
      candidates: [candidate(1, "SKU-A", "111"), candidate(2, "SKU-B", "222")],
      weights: { "111": { unit: "GRAMS", value: 50 } },
      fetchErrors: ["Shopify weight fetch failed for batch starting at index 100: 500"],
    });

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(report.errors).toEqual(["Shopify weight fetch failed for batch starting at index 100: 500"]);
    expect(report.updated).toBe(1); // the successful batch still lands
    expect(report.skippedNoWeight).toBe(1); // 222 lost to the failed batch
  });

  it("collects per-variant update errors and continues (never throws)", async () => {
    const { deps } = makeDeps({
      candidates: [candidate(1, "SKU-A", "111"), candidate(2, "SKU-B", "222")],
      weights: {
        "111": { unit: "GRAMS", value: 50 },
        "222": { unit: "GRAMS", value: 60 },
      },
      updateResult: async (variantId) => {
        if (variantId === 1) throw new Error("deadlock detected");
        return true;
      },
    });

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("variant 1");
    expect(report.errors[0]).toContain("deadlock detected");
    expect(report.updated).toBe(1); // variant 2 still updated
  });

  it("never throws even when enumeration itself fails", async () => {
    const deps: ShopifyWeightBackfillDeps = {
      listCandidateVariants: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      fetchShopifyWeights: vi.fn(),
      updateVariantWeightIfNull: vi.fn(),
    };

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("connection refused");
    expect(report.updated).toBe(0);
  });

  it("skips the Shopify fetch entirely when no candidates are mapped", async () => {
    const { deps, fetchShopifyWeights } = makeDeps({
      candidates: [candidate(1, "UNMAPPED", null)],
    });

    const report = await runShopifyWeightBackfill({ dryRun: false }, deps);

    expect(fetchShopifyWeights).not.toHaveBeenCalled();
    expect(report.candidates).toBe(1);
    expect(report.skippedNoMapping).toBe(1);
    expect(report.updated).toBe(0);
  });
});
