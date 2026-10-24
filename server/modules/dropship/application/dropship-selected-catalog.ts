import type { ListingPriceCatalogReader } from "./dropship-listing-price-service";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import { DropshipError } from "../domain/errors";
import { LISTING_PUSH_RUN_WORDS } from "../domain/listing-push-run-words";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "../../../../shared/dropship/catalog-scope";

export interface SelectedCatalogReader {
  vendorId: number; catalog: ListingPriceCatalogReader;
  /**
   * The vendor's picked sizes that are sellable, ascending by id after
   * `afterId` (a keyset over the vendor's picks, PLAN-B v4.1 §9 row 3;
   * FIDELITY-3): every id it yields is picked, so the scan decides each with
   * `picked: true`, and a sellable size the vendor did not pick is never read.
   */
  listVariantIds(afterId: number, limit: number): Promise<number[]>;
  listProductLines(ids: number[]): Promise<Array<{ id: number; name: string }>>;
}
export type SelectedCatalogPurpose = "pricing_review" | "category_review" | "listing_settings" | "listing_push_run";
/** Stage 2 (step 1 plan S2-5): the page's runTooLarge words (PROPOSED, §4.11), also the server's refusal. */
export const LISTING_PUSH_RUN_TOO_LARGE_MESSAGE = LISTING_PUSH_RUN_WORDS.runTooLarge;
/** The keyset scan's batch: this many picked sellable sizes are read, and their candidates held, at a time. */
const SELECTED_CATALOG_BATCH_SIZE = 250;

/**
 * The vendor's selected sizes, one keyset batch at a time, in ascending size
 * id: every sellable size the vendor picked (the reader's keyset, O(selected)),
 * independent of the browser's filters, pages and 500-item listing
 * publication request cap, kept only when Card Shellz exposes it and the
 * vendor's override does not turn it off. Each batch is handed to the caller
 * before the next is read, so a caller that keeps less than a candidate
 * (loadSelectedProductIds) holds one batch of candidates at most.
 */
async function* selectedCandidateBatches(tx: SelectedCatalogReader, now: Date): AsyncGenerator<DropshipListingCatalogCandidate[]> {
  const exposureRules = await tx.catalog.listCatalogExposureRules();
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
      // Picked: the keyset yields only the vendor's picks (listVariantIds).
      const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        picked: true, rawAtpUnits: 0, override: overrideById.get(candidate.productVariantId) ?? null });
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
    if (selected.length > MAX_NAMED_CATALOG_GROUP_ITEMS) throw selectedCatalogTooLarge(purpose);
  }
  return selected.sort((a, b) => a.productVariantId - b.productVariantId);
}

/**
 * Every selected size id, ascending, by the same scan and evaluation as
 * loadSelectedCandidates and refused above 10,000 the same way. Ids only: it
 * holds one batch of candidates at a time, so a publish run's snapshot of
 * 10,000 sizes never holds 10,000 descriptions (step 1 plan S2-5, §4.2).
 */
export async function loadSelectedVariantIds(tx: SelectedCatalogReader, now: Date, purpose: SelectedCatalogPurpose): Promise<number[]> {
  const selected: number[] = [];
  for await (const batch of selectedCandidateBatches(tx, now)) {
    for (const candidate of batch) selected.push(candidate.productVariantId);
    if (selected.length > MAX_NAMED_CATALOG_GROUP_ITEMS) throw selectedCatalogTooLarge(purpose);
  }
  return selected.sort((left, right) => left - right);
}

/**
 * How many sizes the vendor's selection chooses, by the same scan and
 * evaluation as loadSelectedVariantIds, with no cap and no refusal: the
 * selection summary counts an over-cap selection too, so the page can say so
 * (step 1 plan S2-5 §4.8). `among` counts how many selected sizes are also in
 * that set (the store's live sizes). Only counters are kept: one batch of
 * candidates at a time.
 */
export async function countSelectedVariants(
  tx: SelectedCatalogReader,
  now: Date,
  among: ReadonlySet<number> = new Set(),
): Promise<{ selected: number; selectedAmong: number }> {
  let selected = 0;
  let selectedAmong = 0;
  for await (const batch of selectedCandidateBatches(tx, now)) {
    selected += batch.length;
    for (const candidate of batch) if (among.has(candidate.productVariantId)) selectedAmong += 1;
  }
  return { selected, selectedAmong };
}

/** The purpose's own refusal of a selection above 10,000 sizes. */
function selectedCatalogTooLarge(purpose: SelectedCatalogPurpose): DropshipError {
  if (purpose === "category_review") return new DropshipError("DROPSHIP_EBAY_CATEGORY_REVIEW_TOO_LARGE",
    "This store exceeds the 10,000-listing eBay category review limit. No category rules were changed.");
  if (purpose === "listing_settings") return new DropshipError("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    "More than 10,000 sizes are chosen for this store. Choose 10,000 or fewer to check their settings.");
  if (purpose === "listing_push_run") return new DropshipError("DROPSHIP_LISTING_PUSH_RUN_TOO_LARGE",
    LISTING_PUSH_RUN_TOO_LARGE_MESSAGE, { limit: MAX_NAMED_CATALOG_GROUP_ITEMS, classification: "permanent" });
  return new DropshipError("DROPSHIP_PRICING_REVIEW_TOO_LARGE",
    "This store exceeds the 10,000-listing pricing review limit. No rules were changed.");
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

/**
 * The categories the vendor sells from: the Card Shellz categories of its
 * selected sizes, ascending (the new-items notice, PLAN-B v4.1 §11.1 stage
 * 3). Ids only, with no cap, one batch of candidates at a time, like
 * loadSelectedProductIds; a selected size whose product has no category adds
 * nothing.
 */
export async function loadSelectedCategoryIds(tx: SelectedCatalogReader, now: Date): Promise<number[]> {
  const categoryIds = new Set<number>();
  for await (const batch of selectedCandidateBatches(tx, now)) {
    for (const candidate of batch) if (candidate.categoryId !== null) categoryIds.add(candidate.categoryId);
  }
  return [...categoryIds].sort((left, right) => left - right);
}

/**
 * Which of the given sizes the vendor's selection chooses now, by the same
 * evaluation as the scans above but reading only those sizes (a publish run
 * chunk's pre-filter, step 1 plan S2-5, §4.3 step 2; TESTS10): a size that is
 * not sellable, not exposed, not picked or turned off is left out. The picks
 * are a bounded lookup over the chunk's ids, not a keyset (PLAN-B v4.1 §9
 * row 3b).
 */
export async function selectedVariantIdsAmong(tx: SelectedCatalogReader, productVariantIds: readonly number[], now: Date): Promise<Set<number>> {
  return decidedVariantIdsAmong(tx, productVariantIds, now, "picks");
}

/**
 * Which of the given sizes Card Shellz offers the vendor now: sellable,
 * exposed by the admin rules and not turned off by the vendor's override,
 * picked or not (a step 1 save's plan, PLAN-B v4.1 §7.3, §8.3 step 5). The
 * same evaluation as selectedVariantIdsAmong with every size taken as
 * picked, so "selected" is always "picked and offered".
 */
export async function offeredVariantIdsAmong(tx: SelectedCatalogReader, productVariantIds: readonly number[], now: Date): Promise<Set<number>> {
  return decidedVariantIdsAmong(tx, productVariantIds, now, "every_size_picked");
}

async function decidedVariantIdsAmong(tx: SelectedCatalogReader, productVariantIds: readonly number[], now: Date,
  picks: "picks" | "every_size_picked"): Promise<Set<number>> {
  const ids = [...new Set(productVariantIds)].sort((left, right) => left - right);
  if (ids.length === 0) return new Set();
  // One after another: the reader is one transaction's client, which runs one query at a time.
  const exposureRules = await tx.catalog.listCatalogExposureRules();
  const pickedIds = picks === "picks" ? await tx.catalog.listPickedVariantIds(tx.vendorId, ids) : null;
  const candidates = await tx.catalog.listCatalogCandidates(ids);
  const overrides = await tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: ids });
  const overrideById = new Map(overrides.map((row) => [row.productVariantId, row]));
  const selected = new Set<number>();
  for (const candidate of candidates) {
    const exposure = evaluateDropshipCatalogExposure(candidate, exposureRules, now);
    const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
      picked: pickedIds === null || pickedIds.has(candidate.productVariantId), rawAtpUnits: 0,
      override: overrideById.get(candidate.productVariantId) ?? null });
    if (exposure.exposed && selection.selected) selected.add(candidate.productVariantId);
  }
  return selected;
}
