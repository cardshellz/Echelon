import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";
import type { DropshipCatalogExposureRule } from "./catalog-exposure";
import { DropshipError } from "./errors";
import {
  decideDropshipStockPublicationSelection,
  type DropshipStockListingState,
  type DropshipStockSelectionCandidate,
  type DropshipStockSelectionConfig,
} from "./stock-publication-selection";
import type { DropshipVendorVariantOverride } from "./vendor-selection";
import {
  combineSelectionEffectsHash,
  selectionEffectsHash,
  selectionEndsHash,
  sortEntries,
  type SelectionEffect,
  type SelectionEffectEntry,
} from "./vendor-selection-drift";
import type { ListingEndDecision } from "./vendor-selection-ends";

// The confirmation form lives in vendor-selection-drift.ts (so the browser stubs can import it); re-exported here so
// callers keep one import for the effects.
export {
  SELECTION_EFFECTS,
  combineSelectionEffectsHash,
  compareSelectionEffects,
  selectionEffectsHash,
  selectionEndsEchoMatches,
  selectionEndsHash,
  type SelectionEffect,
  type SelectionEffectEntry,
  type SelectionEffectsComparison,
  type SelectionEndSets,
} from "./vendor-selection-drift";

/**
 * What a step 1 save does to the vendor's listings (PLAN-B v4.1 §7.5, §7.6;
 * V20, V39), counted for the confirm before anything is written. Pure: the
 * effects reader reads every fact for the touched sizes and passes them in,
 * and the clock is the caller's `now`. Each listing is decided by the stock
 * publication decision (stock-publication-selection.ts) with the vendor's pick
 * before and after the change, then classified by `classifySelectionEffect`.
 * The confirm promises only what Echelon does.
 *
 * PR C (PLAN-C v4.1 §4.5) adds the eBay listings the save ends (decideListingEnds, vendor-selection-ends.ts): a
 * listing with an end planned now is an `ends` entry instead of B's `goesToZero`; an added size whose listing is
 * still being ended, could not be ended yet or was ended by Card Shellz is `stillEnding`, `endReview` or
 * `endedReAdd`; each hidden pick removed with a wholly removed product is a vendor-level `removedWithProduct` entry
 * `[0, 0, size, …]`. The after-decision sees an end superseded now as closed and an end planned now as open.
 */

/** B's two kinds, classified from the stock decisions before and after (classifySelectionEffect). */
export type StockSelectionEffect = Extract<SelectionEffect, "goesToZero" | "startsSelling">;

/** eBay sync-back's issue for a listing eBay ended because it ran out of stock (marketplace-sync-decision.ts). */
const ENDED_OUT_OF_STOCK_ISSUE = "ended_out_of_stock";

/**
 * A listing row as the effects reader reads it: the stock decision's listing state (with `endOpen` while an end
 * request is open, PLAN-C v4.1 §7) plus #1900's end facts and PR C's end request facts (§4.2 item 4).
 */
export interface SelectionEffectsListing extends DropshipStockListingState {
  /** Set when the vendor ended the listing on eBay; a later queue, failure or blocked preview keeps it (V20). */
  marketplaceEndedAt: Date | null;
  marketplaceIssueCodes: readonly string[];
  /** The listing's open end request (at most one), or null. */
  openEndId: number | null;
  openEndState: "pending" | "ending" | "failed" | null;
  /** A push item is being sent to eBay, or stale recovery put back one that may have been sent unrecorded. */
  pushInFlight: boolean;
}

/**
 * The listing state with an end open or not, in the shape SPR gives the stock decision (`withListingEndState`:
 * `endOpen: true` while open, no key otherwise), so both readers hand the decision the same input (R5, V21).
 */
function withEndOpen(listing: SelectionEffectsListing, open: boolean): SelectionEffectsListing {
  const { endOpen: _endOpen, ...state } = listing;
  return open ? { ...state, endOpen: true } : state;
}

export interface SelectionEffectsStore {
  storeConnectionId: number;
  storeName: string;
  platform: string;
  /** The store connection's raw status (`connected`, `paused`, `needs_reauth`, …). */
  status: string;
  /** The eBay account and environment the store is connected to (an end request records them, PR C §4.4). */
  externalAccountId: string | null;
  providerEnvironment: string | null;
  config: DropshipStockSelectionConfig | null;
  storePaused: boolean;
  /** The store's listing rows of every size in the facts (the touched sizes and their siblings), at most one per size. */
  listings: readonly SelectionEffectsListing[];
}

export interface DecideSelectionEffectsInput {
  now: Date;
  /** The planned picks to insert and delete (planSelectionChange); every other size keeps its pick. */
  insertIds: readonly number[];
  deleteIds: readonly number[];
  /** Catalog facts of the touched sizes; a size without facts is decided as a missing catalog identity. */
  candidates: readonly DropshipStockSelectionCandidate[];
  /** Card Shellz's active catalog exposure rules, in the stock reader's order. */
  adminRules: readonly DropshipCatalogExposureRule[];
  overrides: readonly DropshipVendorVariantOverride[];
  /** Every store of the vendor: a pick applies to all of them. */
  stores: readonly SelectionEffectsStore[];
  /** What the save ends (decideListingEnds over the same facts); its hidden removals are in `deleteIds` too. */
  ends: ListingEndDecision;
}

export interface SelectionEffectsStoreCounts {
  storeConnectionId: number;
  storeName: string;
  platform: string;
  goesToZero: number;
  startsSelling: number;
  ends: number;
  storeConnected: boolean;
}

/** The vendor-level end summary of an answer (`ends`, shared/dropship/vendor-selection-changes.ts). */
export interface SelectionEndsSummary {
  listingIds: number[];
  hiddenRemovedIds: number[];
  /** Ends of other sizes of products removed completely (`product_removed`). */
  otherSizes: number;
  /**
   * Added sizes (not listings) whose listing is still being ended, could not be ended yet, or was ended by Card
   * Shellz: the page says "{n} of the items you're adding" (PLAN-C v4.1 §11), so a size listed on two eBay stores
   * counts once. Each listing still has its own entry (and hash part).
   */
  stillEnding: number;
  endReview: number;
  endedReAdd: number;
}

export interface SelectionEffects {
  /** One per store, ascending by store id, zero counts included. */
  stores: SelectionEffectsStoreCounts[];
  /** Ascending by store, then listing, then size. */
  entries: SelectionEffectEntry[];
  ends: SelectionEndsSummary;
  /** sha256 of B's form over every entry except `ends` and `removedWithProduct`. */
  otherEntriesHash: string;
  /** sha256(endsHash ":" otherEntriesHash) (combineSelectionEffectsHash). */
  effectsHash: string;
}

type StockDecision = StockPublicationSelection["variants"][number];

/**
 * One listing's effect (§7.6). No eBay identity: nothing is on eBay, so
 * nothing is promised (a blocked or failed first push keeps a live-push item
 * without a listing). Ended on eBay (the status, the end time that survives a
 * status overwrite, or eBay's stock-out end): no change either way, never
 * `startsSelling`, because Echelon skips the automatic push and re-ends it, and
 * sync-back's restore push already republishes a proven stock-out end. A
 * decision "sells" when it publishes a quantity that is not capped at 0 by the
 * vendor's limit.
 */
export function classifySelectionEffect(input: {
  before: Pick<StockDecision, "action" | "publishLimitUnits">;
  after: Pick<StockDecision, "action" | "publishLimitUnits">;
  listing: SelectionEffectsListing;
}): StockSelectionEffect | null {
  const { listing } = input;
  if (!isNonBlankId(listing.externalListingId) && !isNonBlankId(listing.externalOfferId)) return null;
  if (isEndedOnMarketplace(listing)) return null;
  const sellsBefore = sells(input.before);
  const sellsAfter = sells(input.after);
  if (sellsBefore && !sellsAfter) return "goesToZero";
  if (!sellsBefore && sellsAfter) return "startsSelling";
  return null;
}

/** Every touched listing on every store of the vendor, decided before and after, classified and counted. */
export function decideSelectionEffects(input: DecideSelectionEffectsInput): SelectionEffects {
  const pickedAfterById = new Map<number, boolean>();
  for (const id of validIds(input.insertIds, "insertIds")) pickedAfterById.set(id, true);
  for (const id of validIds(input.deleteIds, "deleteIds")) {
    if (pickedAfterById.get(id) === true) {
      throw new DropshipError(
        "DROPSHIP_SELECTION_CHANGE_CONFLICTING",
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "An item can't be added and removed in the same save.",
        { classification: "permanent", productVariantId: id },
      );
    }
    pickedAfterById.set(id, false);
  }
  const candidates = uniqueBySize(input.candidates, (row) => row.productVariantId, "candidates");
  const overrides = uniqueBySize(input.overrides, (row) => row.productVariantId, "overrides");
  const stores = [...input.stores].sort((left, right) => left.storeConnectionId - right.storeConnectionId);
  if (new Set(stores.map((store) => store.storeConnectionId)).size !== stores.length) {
    throw ambiguous({ field: "stores" });
  }

  const plannedEnds = new Set(input.ends.endPlans.map((end) => end.listingId));
  const superseded = new Set(input.ends.supersedeIds);
  const reported = new Map<number, SelectionEffect>();
  for (const [effect, rows] of [["stillEnding", input.ends.stillEnding], ["endReview", input.ends.endReview],
    ["endedReAdd", input.ends.endedReAdd]] as const) {
    for (const row of rows) reported.set(row.listingId, effect);
  }

  const counts: SelectionEffectsStoreCounts[] = [];
  const entries: SelectionEffectEntry[] = [];
  for (const store of stores) {
    const storeCounts: SelectionEffectsStoreCounts = {
      storeConnectionId: store.storeConnectionId, storeName: store.storeName, platform: store.platform,
      goesToZero: 0, startsSelling: 0, ends: 0, storeConnected: store.status === "connected",
    };
    const listings = uniqueBySize(store.listings, (row) => row.productVariantId, "listings", store.storeConnectionId);
    for (const listing of [...listings.values()].sort((left, right) => left.productVariantId - right.productVariantId)) {
      // An end planned now replaces B's quantity 0, whether the size is touched or a sibling of a wholly removed product.
      if (plannedEnds.has(listing.id)) {
        storeCounts.ends += 1;
        entries.push([store.storeConnectionId, listing.id, listing.productVariantId, "ends"]);
        continue;
      }
      const pickedAfter = pickedAfterById.get(listing.productVariantId);
      if (pickedAfter === undefined) continue;
      const decide = (picked: boolean, state: SelectionEffectsListing) => decideDropshipStockPublicationSelection({
        productVariantId: listing.productVariantId,
        candidate: candidates.get(listing.productVariantId) ?? null,
        rules: input.adminRules,
        picked,
        override: overrides.get(listing.productVariantId) ?? null,
        listing: state,
        config: store.config,
        storePaused: store.storePaused,
        now: input.now,
      });
      // Before the save an end is open as read. After it an end superseded now is closed, so a re-picked size sells
      // again; an `ending` or `failed` one stays open (stock zero, §7).
      const openBefore = listing.openEndState !== null;
      const openAfter = openBefore && !(listing.openEndId !== null && superseded.has(listing.openEndId));
      const effect = classifySelectionEffect({
        before: decide(!pickedAfter, withEndOpen(listing, openBefore)),
        after: decide(pickedAfter, withEndOpen(listing, openAfter)),
        listing,
      });
      if (effect !== null) {
        storeCounts[effect] += 1;
        entries.push([store.storeConnectionId, listing.id, listing.productVariantId, effect]);
      }
      const told = reported.get(listing.id);
      if (told !== undefined) entries.push([store.storeConnectionId, listing.id, listing.productVariantId, told]);
    }
    counts.push(storeCounts);
  }
  for (const productVariantId of input.ends.hiddenRemovedIds) entries.push([0, 0, productVariantId, "removedWithProduct"]);
  const sortedEntries = sortEntries(entries);
  const ends: SelectionEndsSummary = {
    listingIds: input.ends.endPlans.map((end) => end.listingId).sort((left, right) => left - right),
    hiddenRemovedIds: [...input.ends.hiddenRemovedIds].sort((left, right) => left - right),
    otherSizes: input.ends.endPlans.filter((end) => end.reason === "product_removed").length,
    stillEnding: distinctSizes(input.ends.stillEnding),
    endReview: distinctSizes(input.ends.endReview),
    endedReAdd: distinctSizes(input.ends.endedReAdd),
  };
  const otherEntriesHash = selectionEffectsHash(sortedEntries.filter((entry) => !END_SET_EFFECTS.has(entry[3])));
  return {
    stores: counts, entries: sortedEntries, ends, otherEntriesHash,
    effectsHash: combineSelectionEffectsHash(selectionEndsHash(ends), otherEntriesHash),
  };
}

/** How many sizes a re-add report names: one per size, whatever number of stores list it. */
function distinctSizes(rows: readonly { productVariantId: number }[]): number {
  return new Set(rows.map((row) => row.productVariantId)).size;
}

/** The kinds the ends hash covers (by the sets the page echoes); every other kind is in the other entries' hash. */
const END_SET_EFFECTS: ReadonlySet<SelectionEffect> = new Set<SelectionEffect>(["ends", "removedWithProduct"]);

/** Postgres `integer`, the type of every catalog and listing id. */
const MAX_ROW_ID = 2_147_483_647;

function sells(decision: Pick<StockDecision, "action" | "publishLimitUnits">): boolean {
  // A vendor limit of 0 publishes 0 (stock-publication-selection.ts, publishLimitUnits).
  return decision.action === "publish" && decision.publishLimitUnits !== 0;
}

function isEndedOnMarketplace(listing: SelectionEffectsListing): boolean {
  return listing.status === "ended"
    || listing.marketplaceEndedAt !== null
    || listing.marketplaceIssueCodes.includes(ENDED_OUT_OF_STOCK_ISSUE);
}

function isNonBlankId(value: string | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function validIds(ids: readonly number[], field: string): number[] {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_ROW_ID) {
      throw new DropshipError(
        "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "Each item must be a catalog item id.",
        { classification: "permanent", field, value: typeof id === "number" ? id : String(id) },
      );
    }
  }
  return [...new Set(ids)];
}

function uniqueBySize<Row>(rows: readonly Row[], key: (row: Row) => number, field: string, storeConnectionId?: number): Map<number, Row> {
  const bySize = new Map<number, Row>();
  for (const row of rows) {
    const productVariantId = key(row);
    if (bySize.has(productVariantId)) throw ambiguous({ field, productVariantId, ...(storeConnectionId === undefined ? {} : { storeConnectionId }) });
    bySize.set(productVariantId, row);
  }
  return bySize;
}

function ambiguous(context: Record<string, unknown>): DropshipError {
  // The stock reader's refusal for the same data (dropship-stock-publication-selection.reader.ts).
  return new DropshipError("DROPSHIP_STOCK_SELECTION_AMBIGUOUS", "Multiple saved selections or listings describe this store variant.",
    { classification: "permanent", ...context });
}
