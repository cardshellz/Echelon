import { describe, expect, it } from "vitest";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import {
  countSelectedVariants,
  loadSelectedCandidates,
  loadSelectedCategoryIds,
  loadSelectedProductIds,
  loadSelectedVariantIds,
  selectedVariantIdsAmong,
  type SelectedCatalogReader,
} from "../../application/dropship-selected-catalog";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import type { DropshipVendorVariantOverride } from "../../domain/vendor-selection";
import { GOLDEN_PREVIEW_CANDIDATES, GOLDEN_PREVIEW_NOW, GOLDEN_PREVIEW_VENDOR_ID } from "../fixtures/listing-preview-golden.fixture";

/**
 * The selected-catalog scan's one batch iterator (plan PR 9, 10.1): the
 * candidates the views and reviews load, and the ids the first-mark job
 * loads, come from the same reads in the same order. Only
 * loadSelectedCandidates keeps candidates and refuses above 10,000.
 * One-time picks (PLAN-B v4.1 §9 row 3; FIDELITY-3): the reader's keyset
 * yields the vendor's picks only, so the scan reads no rules and no picks of
 * its own; the stub's keyset below is over `picked` (the real keyset is
 * pinned by the PostgreSQL picks suite).
 */

const INCLUDE_CATALOG: DropshipCatalogExposureRule = { id: 1, scopeType: "catalog", action: "include" };

interface CatalogScenario {
  candidates: readonly DropshipListingCatalogCandidate[];
  exposureRules?: readonly DropshipCatalogExposureRule[];
  /** The vendor's picks; every candidate when absent (the golden vendor picked everything). */
  picked?: readonly number[];
  overrides?: readonly DropshipVendorVariantOverride[];
  /** The ids each listVariantIds call answers, when the catalog's own keyset is not wanted (the cursor case). */
  variantIdPages?: number[][];
}

/** The reads the scan makes, over a fixed catalog, recorded in order. */
function readerOver(scenario: CatalogScenario): { reader: SelectedCatalogReader; calls: string[] } {
  const calls: string[] = [];
  const byId = new Map(scenario.candidates.map((candidate) => [candidate.productVariantId, candidate]));
  const picked = new Set(scenario.picked ?? byId.keys());
  // The keyset over the vendor's picks (SELR): a sellable size the vendor did not pick is never in it.
  const ids = [...picked].sort((left, right) => left - right);
  const pages = scenario.variantIdPages ? [...scenario.variantIdPages] : null;
  const catalog = {
    listCatalogExposureRules: async () => { calls.push("exposureRules"); return structuredClone([...(scenario.exposureRules ?? [INCLUDE_CATALOG])]); },
    listPickedVariantIds: async (vendorId: number, variantIds: readonly number[]) => {
      calls.push(`picks:${vendorId}:${variantIds.length}`);
      return new Set(variantIds.filter((id) => picked.has(id)));
    },
    listCatalogCandidates: async (variantIds: readonly number[]) => {
      calls.push(`candidates:${variantIds.length}`);
      return variantIds.flatMap((id) => byId.has(id) ? [structuredClone(byId.get(id)!)] : []);
    },
    listVariantOverrides: async (input: { vendorId: number; productVariantIds: readonly number[] }) => {
      calls.push(`overrides:${input.vendorId}:${input.productVariantIds.length}`);
      return (scenario.overrides ?? []).filter((override) => input.productVariantIds.includes(override.productVariantId));
    },
  };
  const reader = {
    vendorId: GOLDEN_PREVIEW_VENDOR_ID,
    catalog,
    listVariantIds: async (afterId: number, limit: number) => {
      calls.push(`variantIds:${afterId}:${limit}`);
      if (pages) return pages.shift() ?? [];
      return ids.filter((id) => id > afterId).slice(0, limit);
    },
    listProductLines: async () => [],
  } as unknown as SelectedCatalogReader;
  return { reader, calls };
}

/** `count` selectable sizes, two to a product, made from the first golden size. */
function syntheticCatalog(count: number): DropshipListingCatalogCandidate[] {
  const base = GOLDEN_PREVIEW_CANDIDATES[0];
  return Array.from({ length: count }, (_, index) => ({ ...structuredClone(base), productVariantId: 500_000 + index,
    productId: 900_000 + Math.floor(index / 2) }));
}

const productIdsOf = (candidates: readonly DropshipListingCatalogCandidate[]) =>
  [...new Set(candidates.map((candidate) => candidate.productId))].sort((left, right) => left - right);

describe("loadSelectedProductIds (plan PR 9, 10.1)", () => {
  it.each([
    ["the golden catalog, every size chosen", {}],
    ["the golden catalog with an excluded product, an unpicked size and a size switched off", {
      exposureRules: [INCLUDE_CATALOG, { id: 3, scopeType: "product", action: "exclude", productId: 200 }],
      picked: GOLDEN_PREVIEW_CANDIDATES.map((size) => size.productVariantId).filter((id) => id !== 6002),
      overrides: [{ productVariantId: 1001, enabledOverride: false }],
    }],
  ] as const)("answers the products of the sizes loadSelectedCandidates chooses, from the same reads, on %s", async (_label, rules) => {
    const scenario: CatalogScenario = { candidates: GOLDEN_PREVIEW_CANDIDATES, ...rules };
    const candidates = readerOver(scenario);
    const ids = readerOver(scenario);

    const selected = await loadSelectedCandidates(candidates.reader, GOLDEN_PREVIEW_NOW, "listing_settings");
    const productIds = await loadSelectedProductIds(ids.reader, GOLDEN_PREVIEW_NOW);

    expect(productIds).toEqual(productIdsOf(selected));
    expect(ids.calls).toEqual(candidates.calls);
    expect(selected.length).toBeGreaterThan(0);
  });

  it("is not a no-op filter: exposure and the override leave products and sizes out of the picked ones", async () => {
    const all = await loadSelectedProductIds(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES }).reader, GOLDEN_PREVIEW_NOW);
    const ruled = await loadSelectedProductIds(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES,
      exposureRules: [INCLUDE_CATALOG, { id: 3, scopeType: "product", action: "exclude", productId: 200 }] }).reader, GOLDEN_PREVIEW_NOW);
    expect(all).toEqual(productIdsOf(GOLDEN_PREVIEW_CANDIDATES));
    expect(ruled).toEqual(all.filter((productId) => productId !== 200));
    // A product stays while any of its sizes is chosen: 100 keeps 1002 and 600 keeps 6001.
    const sizes = await loadSelectedCandidates(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES,
      picked: GOLDEN_PREVIEW_CANDIDATES.map((size) => size.productVariantId).filter((id) => id !== 6002),
      overrides: [{ productVariantId: 1001, enabledOverride: false }] }).reader, GOLDEN_PREVIEW_NOW);
    expect(sizes.map((size) => size.productVariantId)).toEqual(GOLDEN_PREVIEW_CANDIDATES.map((size) => size.productVariantId)
      .filter((id) => id !== 6002 && id !== 1001).sort((left, right) => left - right));
    expect(productIdsOf(sizes)).toEqual(all);
  });

  it("never reads or yields a sellable size the vendor did not pick, and reads no rules or picks of its own (FIDELITY-3)", async () => {
    const pickedIds = [1001, 6001];
    const scenario: CatalogScenario = { candidates: GOLDEN_PREVIEW_CANDIDATES, picked: pickedIds };
    const scan = readerOver(scenario);
    const ids = await loadSelectedVariantIds(scan.reader, GOLDEN_PREVIEW_NOW, "listing_push_run");
    expect(ids).toEqual(pickedIds);
    // One batch: the keyset yields the two picks, so only their candidates and overrides are read.
    expect(scan.calls).toEqual(["exposureRules", "variantIds:0:250", "candidates:2", `overrides:${GOLDEN_PREVIEW_VENDOR_ID}:2`,
      "variantIds:6001:250"]);
    expect(await countSelectedVariants(readerOver(scenario).reader, GOLDEN_PREVIEW_NOW, new Set([6001, 2001])))
      .toEqual({ selected: 2, selectedAmong: 1 });
  });

  it("accepts 10,001 chosen sizes, which loadSelectedCandidates refuses with its words, after the same 41 batches", async () => {
    const catalog = syntheticCatalog(10_001);
    const ids = readerOver({ candidates: catalog });
    const candidates = readerOver({ candidates: catalog });

    const productIds = await loadSelectedProductIds(ids.reader, GOLDEN_PREVIEW_NOW);
    const refusal = await loadSelectedCandidates(candidates.reader, GOLDEN_PREVIEW_NOW, "listing_settings").then(() => null, (error) => error);

    expect(productIds).toEqual(productIdsOf(catalog));
    expect(productIds).toHaveLength(5_001);
    expect(refusal).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
      message: "More than 10,000 sizes are chosen for this store. Choose 10,000 or fewer to check their settings." });
    // Batches of 250: the refusal comes after the 41st batch, with no 42nd read; the ids scan reads to the end.
    const batches = (calls: string[]) => calls.filter((call) => call.startsWith("variantIds:"));
    expect(batches(candidates.calls)).toHaveLength(41);
    expect(batches(ids.calls)).toHaveLength(42);
    expect(batches(ids.calls).slice(0, 41)).toEqual(batches(candidates.calls));
    expect(batches(ids.calls)[1]).toBe("variantIds:500249:250");
  });

  it("keeps exactly 10,000 chosen sizes for loadSelectedCandidates, and the other purposes' words above it", async () => {
    await expect(loadSelectedCandidates(readerOver({ candidates: syntheticCatalog(10_000) }).reader, GOLDEN_PREVIEW_NOW, "listing_settings"))
      .resolves.toHaveLength(10_000);
    const over = syntheticCatalog(10_001);
    await expect(loadSelectedCandidates(readerOver({ candidates: over }).reader, GOLDEN_PREVIEW_NOW))
      .rejects.toMatchObject({ code: "DROPSHIP_PRICING_REVIEW_TOO_LARGE" });
    await expect(loadSelectedCandidates(readerOver({ candidates: over }).reader, GOLDEN_PREVIEW_NOW, "category_review"))
      .rejects.toMatchObject({ code: "DROPSHIP_EBAY_CATEGORY_REVIEW_TOO_LARGE" });
  });

  it.each([
    ["repeats the last id", [[1001, 1002], [1002, 2001]]],
    ["goes back within a batch", [[2001, 1002]]],
  ])("keeps the cursor error when the catalog's keyset %s, in both scans", async (_label, pages) => {
    const scenario = { candidates: GOLDEN_PREVIEW_CANDIDATES, variantIdPages: pages };
    await expect(loadSelectedProductIds(readerOver(scenario).reader, GOLDEN_PREVIEW_NOW)).rejects.toThrow("Pricing catalog cursor did not advance.");
    await expect(loadSelectedCandidates(readerOver(scenario).reader, GOLDEN_PREVIEW_NOW)).rejects.toThrow("Pricing catalog cursor did not advance.");
  });

  it("answers an empty catalog with no product, after one read of the exposure rules", async () => {
    const { reader, calls } = readerOver({ candidates: [] });
    await expect(loadSelectedProductIds(reader, GOLDEN_PREVIEW_NOW)).resolves.toEqual([]);
    expect(calls).toEqual(["exposureRules", "variantIds:0:250"]);
  });
});

describe("loadSelectedCategoryIds (the categories a vendor sells from, PLAN-B v4.1 §11.1 stage 3)", () => {
  it("answers the categories of the sizes loadSelectedCandidates chooses, from the same reads, and none for a size with no category", async () => {
    const categorized = GOLDEN_PREVIEW_CANDIDATES.map((candidate, index) => ({ ...structuredClone(candidate),
      categoryId: index % 3 === 0 ? null : 40 + (index % 2) }));
    const scenario: CatalogScenario = { candidates: categorized,
      overrides: [{ productVariantId: categorized[1].productVariantId, enabledOverride: false }] };
    const candidates = readerOver(scenario);
    const ids = readerOver(scenario);
    const selected = await loadSelectedCandidates(candidates.reader, GOLDEN_PREVIEW_NOW, "listing_settings");
    const categoryIds = await loadSelectedCategoryIds(ids.reader, GOLDEN_PREVIEW_NOW);
    const expected = [...new Set(selected.flatMap((candidate) => candidate.categoryId === null ? [] : [candidate.categoryId]))]
      .sort((left, right) => left - right);
    expect(categoryIds).toEqual(expected);
    expect(categoryIds.length).toBeGreaterThan(0);
    expect(ids.calls).toEqual(candidates.calls);
  });

  it("leaves out a category whose only picked size is not exposed, and answers none for no picks", async () => {
    const [first, second] = GOLDEN_PREVIEW_CANDIDATES;
    const scenario: CatalogScenario = {
      candidates: [{ ...structuredClone(first), categoryId: 50 }, { ...structuredClone(second), categoryId: 51 }],
      exposureRules: [INCLUDE_CATALOG, { id: 4, scopeType: "variant", action: "exclude", productVariantId: second.productVariantId }],
    };
    await expect(loadSelectedCategoryIds(readerOver(scenario).reader, GOLDEN_PREVIEW_NOW)).resolves.toEqual([50]);
    await expect(loadSelectedCategoryIds(readerOver({ ...scenario, picked: [] }).reader, GOLDEN_PREVIEW_NOW)).resolves.toEqual([]);
  });
});

describe("selectedVariantIdsAmong (a publish run chunk's pre-filter; PLAN-B v4.1 §9 row 3b)", () => {
  it("keeps the chunk's sizes that are picked, exposed and not turned off, from one bounded picks read", async () => {
    const chunk = [6002, 1001, 2001, 6001, 1001];
    const { reader, calls } = readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES,
      picked: [1001, 2001, 6001],
      exposureRules: [INCLUDE_CATALOG, { id: 3, scopeType: "variant", action: "exclude", productVariantId: 2001 }],
      overrides: [{ productVariantId: 6001, enabledOverride: false }] });
    await expect(selectedVariantIdsAmong(reader, chunk, GOLDEN_PREVIEW_NOW)).resolves.toEqual(new Set([1001]));
    // The picks are read for the chunk's distinct ids only, never by a keyset over the selection.
    expect(calls).toEqual(["exposureRules", `picks:${GOLDEN_PREVIEW_VENDOR_ID}:4`, "candidates:4", `overrides:${GOLDEN_PREVIEW_VENDOR_ID}:4`]);
  });

  it("reads nothing for an empty chunk", async () => {
    const { reader, calls } = readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES });
    await expect(selectedVariantIdsAmong(reader, [], GOLDEN_PREVIEW_NOW)).resolves.toEqual(new Set());
    expect(calls).toEqual([]);
  });
});
