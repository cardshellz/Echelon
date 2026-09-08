import type { ListingPriceCatalogReader } from "./dropship-listing-price-service";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import { DropshipError } from "../domain/errors";
import { MAX_NAMED_CATALOG_GROUP_ITEMS, CATALOG_TARGET_PAGE_SIZE,
  catalogTargetsInputSchema } from "../../../../shared/dropship/catalog-scope";

export interface SelectedCatalogReader {
  vendorId: number; catalog: ListingPriceCatalogReader;
  listVariantIds(afterId: number, limit: number): Promise<number[]>;
  listProductLines(ids: number[]): Promise<Array<{ id: number; name: string }>>;
}
export async function loadSelectedCandidates(tx: SelectedCatalogReader, now: Date, purpose: "pricing_review" | "catalog_targets" = "pricing_review"): Promise<DropshipListingCatalogCandidate[]> {
  const [exposureRules, selectionRules] = await Promise.all([tx.catalog.listCatalogExposureRules(), tx.catalog.listSelectionRules(tx.vendorId)]);
  const selected: DropshipListingCatalogCandidate[] = [];
  // Keyset scan, independent of the browser's filters, pages and 500-item listing
  // publication request cap. Only selected items are retained in memory.
  let afterId = 0;
  const batchSize = 250;
  for (;;) {
    const ids = await tx.listVariantIds(afterId, batchSize);
    if (!ids.length) break;
    if (ids.some((id, index) => id <= (index === 0 ? afterId : ids[index - 1]))) throw new Error("Pricing catalog cursor did not advance.");
    const [candidates, overrides] = await Promise.all([tx.catalog.listCatalogCandidates(ids),
      tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: ids })]);
    const overrideById = new Map(overrides.map((row) => [row.productVariantId, row]));
    for (const candidate of candidates) {
      const exposure = evaluateDropshipCatalogExposure(candidate, exposureRules, now);
      const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        rules: selectionRules, rawAtpUnits: 0, override: overrideById.get(candidate.productVariantId) ?? null });
      if (exposure.exposed && selection.selected) selected.push(candidate);
    }
    if (selected.length > MAX_NAMED_CATALOG_GROUP_ITEMS) {
      if (purpose === "catalog_targets") throw new DropshipError("DROPSHIP_CATALOG_TARGETS_TOO_LARGE",
        "This selection exceeds the 10,000-item group picker limit. Reduce the catalog selection before choosing group targets.");
      throw new DropshipError("DROPSHIP_PRICING_REVIEW_TOO_LARGE",
        "This store exceeds the 10,000-listing pricing review limit. No rules were changed.");
    }
    afterId = ids[ids.length - 1];
  }
  return selected.sort((a, b) => a.productVariantId - b.productVariantId);
}

export async function selectedCatalogTargets(tx: SelectedCatalogReader, now: Date, input: unknown) {
  const parsed = catalogTargetsInputSchema.parse(input);
  const candidates = await loadSelectedCandidates(tx, now, "catalog_targets");
  const options = parsed.type === "product_line"
    ? (await tx.listProductLines([...new Set(candidates.flatMap((row) => [...row.productLineIds]))])).map((row) => ({ id: String(row.id), name: row.name }))
    : candidates.flatMap((row) => parsed.type === "category" ? row.category ? [{ id: row.category, name: row.category }] : []
      : [{ id: String(parsed.type === "product" ? row.productId : row.productVariantId),
        name: parsed.type === "product" ? row.productName : `${row.productName} · ${row.variantName} · ${row.sku ?? "No SKU"}` }]);
  const unique = [...new Map(options.map((row) => [row.id, row])).values()]
    .filter((row) => row.name.toLocaleLowerCase("en-US").includes(parsed.search.toLocaleLowerCase("en-US")))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { total: unique.length, rows: unique.slice(parsed.page * CATALOG_TARGET_PAGE_SIZE, (parsed.page + 1) * CATALOG_TARGET_PAGE_SIZE) };
}
