import { isCustomerSellableVariant, type VariantSalesEligibility } from "../../../../shared/catalog/variant-sales-eligibility";
import { MAX_SELECTION_END_LISTINGS, SELECTION_CHANGE_ERROR_CODES } from "../../../../shared/dropship/vendor-selection-changes";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureRule,
  type DropshipCatalogExposureSubject,
} from "./catalog-exposure";
import { DropshipError } from "./errors";

/**
 * Which eBay listings a step 1 save ends (PR C, PLAN-C v4.1 §4.3, §4.4; owner decisions D18, D20, D43). Pure: the
 * save reads every fact (the touched sizes and every size of each product a removal touches, on every store of the
 * vendor) and passes them in with its plan and the caller's `now`. Inputs are never mutated; every list it returns
 * is ascending.
 *
 * Words: "removed now" = the picks this save deletes (the plan's `deleteIds`); "added" = the picks it inserts;
 * "visible" = what step 1 lists (isVisibleInStep1); "has something on eBay" = an eBay listing that is not ended and
 * has an eBay id, or a push that may be on its way to eBay.
 *
 * The rules, in the order they are applied:
 * 6. Supersede (first, so rules 1, 2 and 5 see a superseded end as closed): a `pending` end whose size is added
 *    (`size_removed`), or whose product has an added size (`product_removed`). `ending` and `failed` ends are never
 *    touched by a save.
 * 1. A removed size ends its own listing on every eBay store, whatever its siblings do (each size is its own listing).
 * 2. A product is wholly removed when a removed size is one of its sizes, it had a visible pick before the save and
 *    has none after it. Then its hidden picks are removed too, and every other size's listing is ended.
 * 3. Nothing else ever ends a listing: no removal, no end (stock, cost, exposure and overrides only set quantity 0).
 * 4. Only eBay stores get ends; a Shopify store keeps quantity 0.
 * 5. An open end is never requested again: an added size's `ending` end is reported `stillEnding`, a `failed` one
 *    `endReview` (it stays at quantity 0 until staff act).
 * 8. An added size whose listing Card Shellz ended (`ended`, no eBay end time) is reported `endedReAdd`: it is
 *    published again only in step 3.
 * Archived sizes are never planned (DC31): retirement owns them and holds their rows across its own eBay calls.
 *
 * Imported only by relative paths from pure modules, so the step 1 browser stubs call this very function (TST-10).
 * The caller names the archived sizes with the catalog's published rule (isArchivedCatalogMember); the input types
 * are the facts this decision reads, which the effects reader's rows satisfy.
 */

export const LISTING_END_REASONS = ["size_removed", "product_removed"] as const;
/** The code an end request a save takes back carries (§4.7 step 9a; terminal `superseded`, INFO). */
export const LISTING_END_SUPERSEDED_BY_SELECTION = "DROPSHIP_LISTING_END_SUPERSEDED_BY_SELECTION";
export type ListingEndReason = (typeof LISTING_END_REASONS)[number];

/** What the save knew of the listing's eBay identity when it asked for the end; ids may be null. */
export interface ListingEndRequestedIdentity {
  externalListingId: string | null;
  externalOfferId: string | null;
  externalAccountId: string | null;
  providerEnvironment: string | null;
}

/** One end request the save inserts (`pending`, due now). */
export interface PlannedListingEnd {
  storeConnectionId: number;
  listingId: number;
  productId: number;
  productVariantId: number;
  reason: ListingEndReason;
  requestedIdentity: ListingEndRequestedIdentity;
}

/** A `pending` end of a product this save adds a size of (the supersede candidates, §4.2 item 5). */
export interface PendingListingEnd {
  id: number;
  listingId: number;
  productId: number;
  productVariantId: number;
  reason: ListingEndReason;
}

/** The catalog facts of one size this decision reads (a DropshipStockSelectionCandidate satisfies it). */
export type ListingEndCandidate = DropshipCatalogExposureSubject & {
  requiresShipping: boolean | null;
  trackInventory: boolean | null;
  salesEligibility: VariantSalesEligibility | null;
};

/** One listing row as this decision reads it (a SelectionEffectsListing satisfies it). */
export interface ListingEndListingFacts {
  id: number;
  productVariantId: number;
  status: string;
  externalListingId: string | null;
  externalOfferId: string | null;
  marketplaceEndedAt: Date | null;
  openEndId: number | null;
  openEndState: "pending" | "ending" | "failed" | null;
  pushInFlight: boolean;
}

/** One store of the vendor with its listing rows of every size in the facts (a SelectionEffectsStore satisfies it). */
export interface ListingEndStoreFacts {
  storeConnectionId: number;
  platform: string;
  externalAccountId: string | null;
  providerEnvironment: string | null;
  listings: readonly ListingEndListingFacts[];
}

/** An added size's listing reported to the vendor (rules 5 and 8). */
export interface AddedListingEnd {
  storeConnectionId: number;
  listingId: number;
  productVariantId: number;
}

export interface DecideListingEndsInput {
  now: Date;
  /** The picks this save deletes (the plan's `deleteIds`). */
  removedNow: readonly number[];
  /** The picks this save inserts (the plan's `insertIds`). */
  added: readonly number[];
  /** The vendor's picks before the save among every size in the facts (the touched sizes and their siblings). */
  pickedBefore: ReadonlySet<number> | readonly number[];
  /** Catalog facts of every size in the facts; a size without facts is never planned. */
  candidates: readonly ListingEndCandidate[];
  /** The sizes the catalog has archived (isArchivedCatalogMember): never planned, retirement owns them (DC31). */
  archivedIds: ReadonlySet<number> | readonly number[];
  /** Card Shellz's active catalog exposure rules. */
  rules: readonly DropshipCatalogExposureRule[];
  /** Every store of the vendor with its listing rows of every size in the facts. */
  stores: readonly ListingEndStoreFacts[];
  /** The `pending` ends of the products of the added sizes. */
  pendingEnds: readonly PendingListingEnd[];
}

export interface ListingEndDecision {
  /** Ascending by listing id (a listing id is unique across stores). */
  endPlans: PlannedListingEnd[];
  /** Hidden picks of wholly removed products, removed in the same picks delete. */
  hiddenRemovedIds: number[];
  /** `pending` ends this save takes back. */
  supersedeIds: number[];
  stillEnding: AddedListingEnd[];
  endReview: AddedListingEnd[];
  endedReAdd: AddedListingEnd[];
}

/** Postgres `integer`, the type of every catalog and listing id. */
const MAX_ROW_ID = 2_147_483_647;

/**
 * Whether step 1 lists this size (§4.3): the list's filter (an active product and size that ships, tracks inventory
 * and is sellable; dropship-selection-atp.repository.ts listVendorCatalogCandidates) and the service's exposure skip
 * (dropship-selection-atp-service.ts decideCatalogRows). The vendor's override is ignored: "Turned off for you" is
 * listed in step 1. The product's `status` is not read, because the list does not read it (BUILD-NOTES D-C3-1); with
 * it every visible size is also offered unless turned off, so a hidden pick is never a selected one.
 */
export function isVisibleInStep1(candidate: ListingEndCandidate, rules: readonly DropshipCatalogExposureRule[],
  now: Date): boolean {
  return candidate.productIsActive
    && candidate.variantIsActive
    && candidate.requiresShipping === true
    && candidate.trackInventory !== false
    && isCustomerSellableVariant(candidate)
    && evaluateDropshipCatalogExposure(candidate, rules, now).exposed;
}

/**
 * Whether the listing has something on eBay to end (§4.4): an eBay store, not ended (by status or by an eBay end
 * time), and an eBay id or a push that may be on its way. eBay's own stock-out end keeps its ids and a live status,
 * so it qualifies (owner question QC1, default a).
 */
export function hasSomethingOnEbay(store: Pick<ListingEndStoreFacts, "platform">, listing: ListingEndListingFacts): boolean {
  if (store.platform !== "ebay") return false;
  if (listing.status === "ended" || listing.marketplaceEndedAt !== null) return false;
  return isNonBlank(listing.externalOfferId) || isNonBlank(listing.externalListingId) || listing.pushInFlight;
}

export function decideListingEnds(input: DecideListingEndsInput): ListingEndDecision {
  const removed = new Set(validIds(input.removedNow, "removedNow"));
  const added = new Set(validIds(input.added, "added"));
  for (const id of added) {
    if (removed.has(id)) {
      throw new DropshipError(
        SELECTION_CHANGE_ERROR_CODES.conflicting,
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "An item can't be added and removed in the same save.",
        { classification: "permanent", productVariantId: id },
      );
    }
  }
  const picked = input.pickedBefore instanceof Set ? input.pickedBefore : new Set(input.pickedBefore);
  const candidates = new Map<number, ListingEndCandidate>();
  for (const candidate of input.candidates) {
    if (candidates.has(candidate.productVariantId)) throw ambiguous({ field: "candidates", productVariantId: candidate.productVariantId });
    candidates.set(candidate.productVariantId, candidate);
  }
  // Decided once per size: a removal near the bound reads up to 30,000 sizes.
  const visibility = new Map<number, boolean>();
  const visible = (productVariantId: number): boolean => {
    let answer = visibility.get(productVariantId);
    if (answer === undefined) {
      const candidate = candidates.get(productVariantId);
      answer = candidate !== undefined && isVisibleInStep1(candidate, input.rules, input.now);
      visibility.set(productVariantId, answer);
    }
    return answer;
  };
  const archivedIds = input.archivedIds instanceof Set ? input.archivedIds : new Set(input.archivedIds);
  const stores = [...input.stores].sort((left, right) => left.storeConnectionId - right.storeConnectionId);

  // Rule 6 first: an end superseded now is closed for every rule below.
  const addedProducts = new Set<number>();
  for (const id of added) {
    const candidate = candidates.get(id);
    if (candidate) addedProducts.add(candidate.productId);
  }
  const supersedeIds = uniqueAscending(input.pendingEnds
    .filter((end) => (end.reason === "size_removed" ? added.has(end.productVariantId) : addedProducts.has(end.productId)))
    .map((end) => end.id));
  const superseded = new Set(supersedeIds);
  const endOpen = (listing: ListingEndListingFacts): boolean =>
    listing.openEndState !== null && !(listing.openEndId !== null && superseded.has(listing.openEndId));

  const endPlans: PlannedListingEnd[] = [];
  const planned = new Set<number>();
  const plan = (store: ListingEndStoreFacts, listing: ListingEndListingFacts, reason: ListingEndReason): void => {
    const candidate = candidates.get(listing.productVariantId);
    // No catalog facts: the product is unknown (the listing's key keeps the size, so this is not expected); an
    // archived size is retirement's (DC31). Neither is planned: the listing keeps quantity 0.
    if (!candidate || archivedIds.has(listing.productVariantId)) return;
    if (planned.has(listing.id) || !hasSomethingOnEbay(store, listing) || endOpen(listing)) return;
    planned.add(listing.id);
    endPlans.push({
      storeConnectionId: store.storeConnectionId, listingId: listing.id, productId: candidate.productId,
      productVariantId: listing.productVariantId, reason,
      requestedIdentity: { externalListingId: listing.externalListingId, externalOfferId: listing.externalOfferId,
        externalAccountId: store.externalAccountId, providerEnvironment: store.providerEnvironment },
    });
  };

  // Rule 1: each removed size's own listing on every eBay store.
  for (const store of stores) {
    for (const listing of store.listings) if (removed.has(listing.productVariantId)) plan(store, listing, "size_removed");
  }

  // Rule 2: wholly removed products.
  const sizesByProduct = new Map<number, number[]>();
  for (const candidate of candidates.values()) {
    const sizes = sizesByProduct.get(candidate.productId) ?? [];
    sizes.push(candidate.productVariantId);
    sizesByProduct.set(candidate.productId, sizes);
  }
  const removedProducts = new Set<number>();
  for (const id of removed) {
    const candidate = candidates.get(id);
    if (candidate) removedProducts.add(candidate.productId);
  }
  const hiddenRemoved: number[] = [];
  const otherSizesOfRemovedProducts = new Set<number>();
  for (const productId of removedProducts) {
    const sizes = sizesByProduct.get(productId) ?? [];
    const visibleBefore = sizes.some((size) => picked.has(size) && visible(size));
    const visibleAfter = sizes.some((size) => ((picked.has(size) && !removed.has(size)) || added.has(size)) && visible(size));
    if (!visibleBefore || visibleAfter) continue;
    for (const size of sizes) {
      if (removed.has(size) || added.has(size)) continue;
      if (picked.has(size) && !visible(size)) hiddenRemoved.push(size);
      otherSizesOfRemovedProducts.add(size);
    }
  }
  for (const store of stores) {
    for (const listing of store.listings) {
      if (otherSizesOfRemovedProducts.has(listing.productVariantId)) plan(store, listing, "product_removed");
    }
  }
  if (endPlans.length > MAX_SELECTION_END_LISTINGS) throw selectionRemovalTooLarge({ endListings: endPlans.length });

  // Rules 5 and 8: what the vendor is told about the sizes it adds back.
  const stillEnding: AddedListingEnd[] = [];
  const endReview: AddedListingEnd[] = [];
  const endedReAdd: AddedListingEnd[] = [];
  for (const store of stores) {
    if (store.platform !== "ebay") continue;
    for (const listing of store.listings) {
      if (!added.has(listing.productVariantId)) continue;
      const entry = { storeConnectionId: store.storeConnectionId, listingId: listing.id, productVariantId: listing.productVariantId };
      if (endOpen(listing) && listing.openEndState === "ending") stillEnding.push(entry);
      else if (endOpen(listing) && listing.openEndState === "failed") endReview.push(entry);
      else if (listing.status === "ended" && listing.marketplaceEndedAt === null && !endOpen(listing)) endedReAdd.push(entry);
    }
  }

  const byListing = (left: { listingId: number }, right: { listingId: number }) => left.listingId - right.listingId;
  return {
    endPlans: endPlans.sort(byListing),
    hiddenRemovedIds: uniqueAscending(hiddenRemoved),
    supersedeIds,
    stillEnding: stillEnding.sort(byListing),
    endReview: endReview.sort(byListing),
    endedReAdd: endedReAdd.sort(byListing),
  };
}

/** The 422 a save and its preview answer when a removal covers more than one save may (§4.2 item 2, §4.5; FID-4). */
export function selectionRemovalTooLarge(context: { factSizes?: number; endListings?: number }): DropshipError {
  return new DropshipError(
    SELECTION_CHANGE_ERROR_CODES.removalTooLarge,
    // PROPOSED (Stage 4, step 1 plan S2-5)
    "That's too many items to change at once. Remove fewer products in one save.",
    { ...context, limit: MAX_SELECTION_END_LISTINGS, classification: "permanent", retryable: false },
  );
}

function isNonBlank(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueAscending(ids: readonly number[]): number[] {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function validIds(ids: readonly number[], field: string): number[] {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ROW_ID) {
      throw new DropshipError(
        SELECTION_CHANGE_ERROR_CODES.invalidInput,
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "Each item must be a catalog item id.",
        { classification: "permanent", field, value: typeof id === "number" ? id : String(id) },
      );
    }
  }
  return [...new Set(ids)];
}

function ambiguous(context: Record<string, unknown>): DropshipError {
  // The stock reader's refusal for the same data (dropship-stock-publication-selection.reader.ts).
  return new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "Multiple saved selections or listings describe this store variant.",
    { classification: "permanent", ...context });
}
