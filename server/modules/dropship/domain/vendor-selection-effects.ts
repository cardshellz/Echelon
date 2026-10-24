import { createHash } from "node:crypto";
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

/**
 * What a step 1 save does to the vendor's listings (PLAN-B v4.1 §7.5, §7.6;
 * V20, V39), counted for the confirm before anything is written. Pure: the
 * effects reader reads every fact for the touched sizes and passes them in,
 * and the clock is the caller's `now`. Each listing is decided by the stock
 * publication decision (stock-publication-selection.ts) with the vendor's pick
 * before and after the change, then classified by `classifySelectionEffect`.
 * The confirm promises only what Echelon does: between PR B and PR C a removal
 * sets quantity 0 and never ends a listing (PR C adds `ends`).
 */

export const SELECTION_EFFECTS = ["goesToZero", "startsSelling"] as const;
export type SelectionEffect = (typeof SELECTION_EFFECTS)[number];

/** eBay sync-back's issue for a listing eBay ended because it ran out of stock (marketplace-sync-decision.ts). */
const ENDED_OUT_OF_STOCK_ISSUE = "ended_out_of_stock";

/** A listing row as the effects reader reads it: the stock decision's listing state plus #1900's end facts. */
export interface SelectionEffectsListing extends DropshipStockListingState {
  /** Set when the vendor ended the listing on eBay; a later queue, failure or blocked preview keeps it (V20). */
  marketplaceEndedAt: Date | null;
  marketplaceIssueCodes: readonly string[];
}

export interface SelectionEffectsStore {
  storeConnectionId: number;
  storeName: string;
  platform: string;
  config: DropshipStockSelectionConfig | null;
  storePaused: boolean;
  /** The store's listing rows of the touched sizes, at most one per size. */
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
}

export interface SelectionEffectsStoreCounts {
  storeConnectionId: number;
  storeName: string;
  platform: string;
  goesToZero: number;
  startsSelling: number;
}

/** `[storeConnectionId, listingId, productVariantId, effect]`. */
export type SelectionEffectEntry = readonly [number, number, number, SelectionEffect];

export interface SelectionEffects {
  /** One per store, ascending by store id, zero counts included. */
  stores: SelectionEffectsStoreCounts[];
  /** Ascending by store, then listing, then size. */
  entries: SelectionEffectEntry[];
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
}): SelectionEffect | null {
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

  const counts: SelectionEffectsStoreCounts[] = [];
  const entries: SelectionEffectEntry[] = [];
  for (const store of stores) {
    const storeCounts: SelectionEffectsStoreCounts = {
      storeConnectionId: store.storeConnectionId, storeName: store.storeName, platform: store.platform,
      goesToZero: 0, startsSelling: 0,
    };
    const listings = uniqueBySize(store.listings, (row) => row.productVariantId, "listings", store.storeConnectionId);
    for (const listing of [...listings.values()].sort((left, right) => left.productVariantId - right.productVariantId)) {
      const pickedAfter = pickedAfterById.get(listing.productVariantId);
      if (pickedAfter === undefined) continue;
      const decide = (picked: boolean) => decideDropshipStockPublicationSelection({
        productVariantId: listing.productVariantId,
        candidate: candidates.get(listing.productVariantId) ?? null,
        rules: input.adminRules,
        picked,
        override: overrides.get(listing.productVariantId) ?? null,
        listing,
        config: store.config,
        storePaused: store.storePaused,
        now: input.now,
      });
      const effect = classifySelectionEffect({ before: decide(!pickedAfter), after: decide(pickedAfter), listing });
      if (effect === null) continue;
      storeCounts[effect] += 1;
      entries.push([store.storeConnectionId, listing.id, listing.productVariantId, effect]);
    }
    counts.push(storeCounts);
  }
  const sortedEntries = sortEntries(entries);
  return { stores: counts, entries: sortedEntries, effectsHash: selectionEffectsHash(sortedEntries) };
}

/** sha256 of the canonical (sorted) entries, so it does not depend on read order and changes with any entry's bucket. */
export function selectionEffectsHash(entries: readonly SelectionEffectEntry[]): string {
  return createHash("sha256").update(JSON.stringify(sortEntries(entries))).digest("hex");
}

export type SelectionEffectsComparison =
  | { outcome: "unchanged"; effectsHash: string }
  /** No adds: proceed; the result and audit carry the actual effects and both hashes. */
  | { outcome: "drifted"; expectedEffectsHash: string; actualEffectsHash: string }
  /** Anything else that differs: refuse (409 `DROPSHIP_SELECTION_EFFECTS_CHANGED`); the page re-confirms. */
  | { outcome: "changed"; expectedEffectsHash: string; actualEffectsHash: string };

/**
 * The drift rule (§7.5). The save recomputes the effects; when they differ
 * from what the vendor confirmed, a change with no adds proceeds. With no adds
 * every touched size is unpicked after the change, so every after-decision is
 * `zero` or `none` and no `startsSelling` entry can appear: drift (an eBay end,
 * a store pause) can only move entries between `goesToZero` and nothing (V39).
 * `addIds` are the ids the request asked to add.
 */
export function compareSelectionEffects(input: {
  expectedEffectsHash: string;
  actualEffectsHash: string;
  addIds: readonly number[];
}): SelectionEffectsComparison {
  for (const [field, value] of [["expectedEffectsHash", input.expectedEffectsHash], ["actualEffectsHash", input.actualEffectsHash]] as const) {
    if (!SHA256_HEX.test(value)) {
      throw new DropshipError(
        "DROPSHIP_SELECTION_CHANGE_INVALID_INPUT",
        // PROPOSED (Stage 3/5, step 1 plan S2-5)
        "The confirmed effects are not recognised. Check the numbers and save again.",
        { classification: "permanent", field },
      );
    }
  }
  if (input.expectedEffectsHash === input.actualEffectsHash) return { outcome: "unchanged", effectsHash: input.actualEffectsHash };
  const hashes = { expectedEffectsHash: input.expectedEffectsHash, actualEffectsHash: input.actualEffectsHash };
  return input.addIds.length === 0 ? { outcome: "drifted", ...hashes } : { outcome: "changed", ...hashes };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;
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

function sortEntries(entries: readonly SelectionEffectEntry[]): SelectionEffectEntry[] {
  return [...entries].sort((left, right) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2] || compareText(left[3], right[3]));
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
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
