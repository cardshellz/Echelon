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
export type SelectedCatalogPurpose = "pricing_review" | "catalog_targets" | "category_review" | "listing_settings";
/** The keyset scan's batch: this many sellable sizes are read, and their candidates held, at a time. */
const SELECTED_CATALOG_BATCH_SIZE = 250;

/**
 * The vendor's selected sizes, one keyset batch at a time, in ascending size
 * id: every sellable size, independent of the browser's filters, pages and
 * 500-item listing publication request cap, kept only when Card Shellz
 * exposes it and the vendor's selection chooses it. Each batch is handed to
 * the caller before the next is read, so a caller that keeps less than a
 * candidate (loadSelectedProductIds) holds one batch of candidates at most.
 */
async function* selectedCandidateBatches(tx: SelectedCatalogReader, now: Date): AsyncGenerator<DropshipListingCatalogCandidate[]> {
  const [exposureRules, selectionRules] = await Promise.all([tx.catalog.listCatalogExposureRules(), tx.catalog.listSelectionRules(tx.vendorId)]);
  let afterId = 0;
  for (;;) {
    const ids = await tx.listVariantIds(afterId, SELECTED_CATALOG_BATCH_SIZE);
    if (!ids.length) return;
    if (ids.some((id, index) => id <= (index === 0 ? afterId : ids[index - 1]))) throw new Error("Pricing catalog cursor did not advance.");
    const [candidates, overrides] = await Promise.all([tx.catalog.listCatalogCandidates(ids),
      tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: ids })]);
    const overrideById = new Map(overrides.map((row) => [row.productVariantId, row]));
    const selected: DropshipListingCatalogCandidate[] = [];
    for (const candidate of candidates) {
      const exposure = evaluateDropshipCatalogExposure(candidate, exposureRules, now);
      const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        rules: selectionRules, rawAtpUnits: 0, override: overrideById.get(candidate.productVariantId) ?? null });
      if (exposure.exposed && selection.selected) selected.push(candidate);
    }
    yield selected;
    afterId = ids[ids.length - 1];
  }
}

/**
 * Every selected size with its candidate, ascending by size id. Refused
 * above 10,000 sizes with the purpose's own code and words: the views and
 * reviews built from them cannot hold more. Only selected items are
 * retained in memory.
 */
export async function loadSelectedCandidates(tx: SelectedCatalogReader, now: Date, purpose: SelectedCatalogPurpose = "pricing_review"): Promise<DropshipListingCatalogCandidate[]> {
  const selected: DropshipListingCatalogCandidate[] = [];
  for await (const batch of selectedCandidateBatches(tx, now)) {
    selected.push(...batch);
    if (selected.length > MAX_NAMED_CATALOG_GROUP_ITEMS) {
      if (purpose === "catalog_targets") throw new DropshipError("DROPSHIP_CATALOG_TARGETS_TOO_LARGE",
        "This selection exceeds the 10,000-item group picker limit. Reduce the catalog selection before choosing group targets.");
      if (purpose === "category_review") throw new DropshipError("DROPSHIP_EBAY_CATEGORY_REVIEW_TOO_LARGE",
        "This store exceeds the 10,000-listing eBay category review limit. No category rules were changed.");
      if (purpose === "listing_settings") throw new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
        "More than 10,000 sizes are chosen for this store. Choose 10,000 or fewer to check their settings.");
      throw new DropshipError("DROPSHIP_PRICING_REVIEW_TOO_LARGE",
        "This store exceeds the 10,000-listing pricing review limit. No rules were changed.");
    }
  }
  return selected.sort((a, b) => a.productVariantId - b.productVariantId);
}

/**
 * The products with at least one selected size, ascending (the first-mark
 * job, plan PR 9, 10.5). Ids only: it keeps a set of product ids and one
 * batch of candidates at a time, so it has no 10,000 cap (plan 10.8 #2; P12
 * does not hold writes to the store's view cap).
 */
export async function loadSelectedProductIds(tx: SelectedCatalogReader, now: Date): Promise<number[]> {
  const productIds = new Set<number>();
  for await (const batch of selectedCandidateBatches(tx, now)) {
    for (const candidate of batch) productIds.add(candidate.productId);
  }
  return [...productIds].sort((left, right) => left - right);
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
