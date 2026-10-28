import type {
  StockLinkDestination,
  StockLinkItemObservation,
  StockLinkOfferLookup,
  StockLinkSkuLookup,
} from "@shared/types/stock-link";
import type { StockSelectionQueryClient } from "@shared/types/stock-publication-selection";
import type { StockLinkEnrollmentListing } from "../domain/stock-link-enrollment";

/**
 * The stock-link engine's ports (channels PR2, PLAN-CH2 v4.1 §4.1, §6). The engine (inventory planning) owns the
 * decision, the link transaction and the check rows; the owner module of a destination supplies two pieces behind
 * these interfaces and is registered beside the publication transports (server/services/index.ts):
 * - an adapter: provider I/O only, read-only, with that destination's own credentials, never inside a transaction;
 * - a source: the owner's read-only SQL, run on the engine's client (the engine's transaction where one is open).
 * No business rule lives in either; neither writes an inventory table (writer ratchet, P-19).
 */

/** Every provider call is bounded by the tick's signal (the tick stops starting work at 30 s, hard stop 45 s). */
export interface StockLinkProviderCallOptions {
  readonly signal: AbortSignal;
}

/**
 * Provider I/O. Each call is one batch read; a failure is thrown as an error the engine classifies
 * (domain/stock-link-errors.ts): destination-scoped, never naming one item (SAF-9). Results are validated with the
 * shared schemas before they are returned.
 */
export interface StockLinkAdapter {
  readonly destinationKind: StockLinkDestination["destinationKind"];
  readonly providerKey: string;
  /** Every store item whose SKU exactly equals one of `skus` (1..50 trimmed Card Shellz SKUs), complete or thrown. */
  findItemsBySku(destination: StockLinkDestination, skus: readonly string[],
    options: StockLinkProviderCallOptions): Promise<StockLinkSkuLookup>;
  /** Each saved item (1..100 decimal ids) read by id; a missing item is `item: null`. */
  observeItems(destination: StockLinkDestination, itemIds: readonly string[],
    options: StockLinkProviderCallOptions): Promise<StockLinkItemObservation>;
}

/** One carried size of the destination, in variant-id order (sweep page). */
export interface StockLinkCandidate {
  readonly productVariantId: number;
  readonly productId: number;
}

export interface StockLinkCandidatePage {
  readonly candidates: readonly StockLinkCandidate[];
  /** The last variant id of this page, or null when the sweep reached the end (it wraps). */
  readonly nextAfterVariantId: number | null;
}

/** A size whose listing record changed since the cursor (TST-8: the raw feed value, never compared with a clock). */
export interface StockLinkRecentChange {
  readonly productVariantId: number;
  readonly productId: number;
  /** channel_feeds.updated_at as text (timestamp without time zone, microseconds kept). */
  readonly changedAtRaw: string;
  readonly feedId: number;
  /** Whether the size is still carried (the listCandidates set): a changed feed of a size no longer carried still
   * wakes its existing row, but never adds one (P6 refinement, BUILD-NOTES D-P6). */
  readonly carried: boolean;
  /** Whether the change is after the cursor itself, not only inside the overlap behind it (P7 refinement, BUILD-NOTES
   * D-P7-1): only a fresh change wakes an existing row, so the overlap never re-checks the same rows every tick. */
  readonly fresh: boolean;
}

export interface StockLinkRecentCursor {
  readonly raw: string | null;
  readonly id: number | null;
}

/** A carried size's Card Shellz SKU, as stored (COALESCE(sku_override, v.sku) for the channel; N6). */
export interface StockLinkCarriedSkuRow {
  readonly productVariantId: number;
  readonly sku: string | null;
}

/** What the engine reads per claimed size before deciding. */
export interface StockLinkSizeSkuRow {
  readonly productVariantId: number;
  readonly productId: number;
  readonly cardShellzSku: string | null;
  /** The saved feed's store item (a hint the engine observes, never proof). */
  readonly feedHintItemId: string | null;
}

/**
 * What the source reads under lock for the engine's re-confirmation (§4.3 step 5). The engine compares it with the
 * evidence the decision was made on (the reads' fingerprint, each member's Card Shellz SKU) and refuses on any
 * difference; the source only reads (BUILD-NOTES D-P4-1: no business rule in a source).
 */
export interface StockLinkConfirmation {
  /** The fingerprint of the destination's credentials as stored now (the same function the adapter uses). */
  readonly fingerprint: string;
  /** Each asked size's Card Shellz SKU as stored now (COALESCE(sku_override, v.sku) for the channel), in variant order;
   * a size whose variant row is gone is absent. */
  readonly skus: readonly { readonly productVariantId: number; readonly cardShellzSku: string | null }[];
}

/** The owner module's reads. Read-only SQL; never a write. */
export interface StockLinkSource {
  readonly destinationKind: StockLinkDestination["destinationKind"];
  readonly providerKey: string;
  /** One sweep page of carried sizes after `afterVariantId` (OQ2 default: only sizes with an active feed). */
  listCandidates(client: StockSelectionQueryClient, destination: StockLinkDestination, afterVariantId: number,
    limit: number): Promise<StockLinkCandidatePage>;
  /** Sizes whose feed changed after `cursor` minus the overlap (SAF-6, TST-8): the changes after the cursor first, oldest
   * first, then the overlap's, oldest first, so a full overlap can never hold the cursor back. */
  listRecentlyChanged(client: StockSelectionQueryClient, destination: StockLinkDestination, cursor: StockLinkRecentCursor,
    limit: number): Promise<readonly StockLinkRecentChange[]>;
  /** Every carried size's Card Shellz SKU (publish and zero), the whole destination (N6). */
  listCarriedSkus(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<readonly StockLinkCarriedSkuRow[]>;
  /** Card Shellz SKU and feed hint of the given sizes. */
  readSkus(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkSizeSkuRow[]>;
  /** The fingerprint of the destination's current credentials (the same function the adapter uses). */
  readFingerprint(client: StockSelectionQueryClient, destination: StockLinkDestination): Promise<string>;
  /**
   * Inside the engine's transaction: the destination's connection row and each size's variant and override rows
   * FOR SHARE (so neither can change until the command commits), then their current fingerprint and SKUs. The engine
   * compares them with what the decision read (STOCK_LINK_CONNECTION_CHANGED / STOCK_LINK_SKU_CHANGED_SINCE_READ).
   */
  lockForConfirmation(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<StockLinkConfirmation>;
}

/** The adapter and source of one destination kind and provider whose link is a store item id (Shopify). */
export interface StockLinkPolicyBinding {
  readonly kind?: "store_item";
  readonly adapter: StockLinkAdapter;
  readonly source: StockLinkSource;
}

// ---------------------------------------------------------------------------
// Listing enrollment (channels PR3): Dropship eBay listings that were live before stock links existed
// ---------------------------------------------------------------------------

export type { StockLinkEnrollmentListing, StockLinkEnrollmentSkip } from "../domain/stock-link-enrollment";

/** The owner module's read-only SQL for enrollment (run on the engine's client, never a write). */
export interface StockLinkEnrollmentSource {
  readonly destinationKind: StockLinkDestination["destinationKind"];
  readonly providerKey: string;
  /** One sweep page of the store's already-live listings' sizes (see the source for the exact rule). */
  listCandidates: StockLinkSource["listCandidates"];
  /** Changed listings since the cursor; a source without a change feed returns none (the sweep finds every size). */
  listRecentlyChanged: StockLinkSource["listRecentlyChanged"];
  /** Every candidate size's Card Shellz SKU (N6 mirror: two sizes with one SKU are flagged, never linked). */
  listCarriedSkus: StockLinkSource["listCarriedSkus"];
  /** The listing of each asked size that has one on this store (a size without a listing is absent). */
  readListings(client: StockSelectionQueryClient, destination: StockLinkDestination,
    productVariantIds: readonly number[]): Promise<readonly StockLinkEnrollmentListing[]>;
}

/** Provider I/O for enrollment: one SKU's offers, read-only, the store's own login, complete or thrown (classified). */
export interface StockLinkOfferAdapter {
  readonly destinationKind: StockLinkDestination["destinationKind"];
  readonly providerKey: string;
  findOffersBySku(destination: StockLinkDestination, sku: string, options: StockLinkProviderCallOptions): Promise<StockLinkOfferLookup>;
}

/**
 * A destination whose link is the SKU and whose link writer is an existing wrapper (Dropship eBay:
 * ensureDropshipEbayStockReady with origin live_listing_enrollment). The tick keeps the check rows, the budgets and
 * Ops Health; the decision is domain/stock-link-enrollment.ts.
 */
export interface StockLinkEnrollmentBinding {
  readonly kind: "listing_enrollment";
  readonly adapter: StockLinkOfferAdapter;
  readonly source: StockLinkEnrollmentSource;
}

export type StockLinkBinding = StockLinkPolicyBinding | StockLinkEnrollmentBinding;

export function isStockLinkEnrollmentBinding(binding: StockLinkBinding): binding is StockLinkEnrollmentBinding {
  return binding.kind === "listing_enrollment";
}

/** Resolves a destination's binding; null = no policy (the tick skips it at DEBUG, the status says unsupported). */
export interface StockLinkRegistry {
  resolve(destinationKind: StockLinkDestination["destinationKind"], providerKey: string): StockLinkBinding | null;
}
