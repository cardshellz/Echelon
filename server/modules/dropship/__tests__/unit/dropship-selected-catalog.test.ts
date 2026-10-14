import { describe, expect, it } from "vitest";
import type { DropshipListingCatalogCandidate } from "../../application/dropship-listing-preview-service";
import {
  loadSelectedCandidates,
  loadSelectedProductIds,
  type SelectedCatalogReader,
} from "../../application/dropship-selected-catalog";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import type { DropshipVendorSelectionRule, DropshipVendorVariantOverride } from "../../domain/vendor-selection";
import { GOLDEN_PREVIEW_CANDIDATES, GOLDEN_PREVIEW_NOW, GOLDEN_PREVIEW_VENDOR_ID } from "../fixtures/listing-preview-golden.fixture";

/**
 * The selected-catalog scan's one batch iterator (plan PR 9, 10.1): the
 * candidates the views and reviews load, and the ids the first-mark job
 * loads, come from the same reads in the same order. Only
 * loadSelectedCandidates keeps candidates and refuses above 10,000.
 */

const INCLUDE_CATALOG: DropshipCatalogExposureRule = { id: 1, scopeType: "catalog", action: "include" };
const VENDOR_INCLUDES_CATALOG: DropshipVendorSelectionRule = { id: 2, vendorId: GOLDEN_PREVIEW_VENDOR_ID, scopeType: "catalog",
  action: "include", autoConnectNewSkus: false, autoListNewSkus: false, isActive: true };

interface CatalogScenario {
  candidates: readonly DropshipListingCatalogCandidate[];
  exposureRules?: readonly DropshipCatalogExposureRule[];
  selectionRules?: readonly DropshipVendorSelectionRule[];
  overrides?: readonly DropshipVendorVariantOverride[];
  /** The ids each listVariantIds call answers, when the catalog's own keyset is not wanted (the cursor case). */
  variantIdPages?: number[][];
}

/** The reads the scan makes, over a fixed catalog, recorded in order. */
function readerOver(scenario: CatalogScenario): { reader: SelectedCatalogReader; calls: string[] } {
  const calls: string[] = [];
  const byId = new Map(scenario.candidates.map((candidate) => [candidate.productVariantId, candidate]));
  const ids = [...byId.keys()].sort((left, right) => left - right);
  const pages = scenario.variantIdPages ? [...scenario.variantIdPages] : null;
  const catalog = {
    listCatalogExposureRules: async () => { calls.push("exposureRules"); return structuredClone([...(scenario.exposureRules ?? [INCLUDE_CATALOG])]); },
    listSelectionRules: async (vendorId: number) => {
      calls.push(`selectionRules:${vendorId}`);
      return structuredClone([...(scenario.selectionRules ?? [VENDOR_INCLUDES_CATALOG])]);
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
    ["the golden catalog with an excluded product, an unchosen size and a size switched off", {
      exposureRules: [INCLUDE_CATALOG, { id: 3, scopeType: "product", action: "exclude", productId: 200 }],
      selectionRules: [VENDOR_INCLUDES_CATALOG, { id: 4, vendorId: GOLDEN_PREVIEW_VENDOR_ID, scopeType: "variant", action: "exclude",
        productVariantId: 6002, isActive: true }],
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

  it("is not a no-op filter: the rules of the second golden case leave products and sizes out", async () => {
    const all = await loadSelectedProductIds(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES }).reader, GOLDEN_PREVIEW_NOW);
    const ruled = await loadSelectedProductIds(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES,
      exposureRules: [INCLUDE_CATALOG, { id: 3, scopeType: "product", action: "exclude", productId: 200 }] }).reader, GOLDEN_PREVIEW_NOW);
    expect(all).toEqual(productIdsOf(GOLDEN_PREVIEW_CANDIDATES));
    expect(ruled).toEqual(all.filter((productId) => productId !== 200));
    // A product stays while any of its sizes is chosen: 100 keeps 1002 and 600 keeps 6001.
    const sizes = await loadSelectedCandidates(readerOver({ candidates: GOLDEN_PREVIEW_CANDIDATES,
      selectionRules: [VENDOR_INCLUDES_CATALOG, { id: 4, vendorId: GOLDEN_PREVIEW_VENDOR_ID, scopeType: "variant", action: "exclude",
        productVariantId: 6002, isActive: true }],
      overrides: [{ productVariantId: 1001, enabledOverride: false }] }).reader, GOLDEN_PREVIEW_NOW);
    expect(sizes.map((size) => size.productVariantId)).toEqual(GOLDEN_PREVIEW_CANDIDATES.map((size) => size.productVariantId)
      .filter((id) => id !== 6002 && id !== 1001).sort((left, right) => left - right));
    expect(productIdsOf(sizes)).toEqual(all);
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
    await expect(loadSelectedCandidates(readerOver({ candidates: over }).reader, GOLDEN_PREVIEW_NOW, "catalog_targets"))
      .rejects.toMatchObject({ code: "DROPSHIP_CATALOG_TARGETS_TOO_LARGE" });
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

  it("answers an empty catalog with no product, after one read of each rule set", async () => {
    const { reader, calls } = readerOver({ candidates: [] });
    await expect(loadSelectedProductIds(reader, GOLDEN_PREVIEW_NOW)).resolves.toEqual([]);
    expect(calls).toEqual(["exposureRules", `selectionRules:${GOLDEN_PREVIEW_VENDOR_ID}`, "variantIds:0:250"]);
  });
});
