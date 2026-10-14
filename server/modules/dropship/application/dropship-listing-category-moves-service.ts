import {
  acknowledgeCategoryMovesInputSchema,
  type AcknowledgeCategoryMovesInput,
  type AcknowledgeCategoryMovesResponse,
} from "../../../../shared/dropship/listing-setting-writes";
import { classifyRequestKeyUse } from "../domain/listing-setting-request-key-use";
import { listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import {
  MAX_LISTED_SIZES,
  assertListingSettingMember,
  authorizeListingSettingWrite,
  listingSettingStoreIdSchema,
  listingSettingWriteHash,
  parseListingSettingInput,
  requestKeyUsePath,
  type ListingSettingWriteLog,
} from "./dropship-listing-setting-write-support";
import type { CategoryMovesAcknowledgeResult, ListingSettingWriteRepository } from "./dropship-listing-setting-writes";
import type { DropshipClock } from "./dropship-ports";

/**
 * W13, "Got it" for products Card Shellz moved to another category (Listing
 * settings design 8.5; plan PR 9, section 10.4): each product's category mark
 * moves to the category the vendor was shown, while the product is still in
 * it. One vendor action, so a single write (60 a minute, plan P7).
 *
 * 1. Parse, sort the items by product, hash (ids only), one clock reading.
 * 2. One write transaction: the gate, the replay probe (a replay is answered
 *    with empty lists and calls no writer, plan P16), then the 8a writer.
 *    No lockCatalog and no chosen check (plan P11): the writer's
 *    compare-and-set upsert joins catalog.products, so a product that moved
 *    again, or left the catalog, is never acknowledged, and W13 needs no
 *    target pre-lock.
 * 3. One INFO line after commit.
 */

export interface DropshipListingCategoryMovesServiceDependencies {
  repository: ListingSettingWriteRepository;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; the write's time is `clock`, read once. */
  timer: () => number;
  log: ListingSettingWriteLog;
}

/** The writer's versioned operation in the request hash (plan 3.7). */
const CATEGORY_MOVES_ACKNOWLEDGE_OPERATION = "category_moves_acknowledge_v1";
/** A log line names at most this many products, with the full count beside it (plan 3.5). */
const MAX_LISTED_PRODUCTS = MAX_LISTED_SIZES;

type AcknowledgeItem = AcknowledgeCategoryMovesInput["items"][number];

export class DropshipListingCategoryMovesService {
  constructor(private readonly deps: DropshipListingCategoryMovesServiceDependencies) {}

  async acknowledgeForMember(memberId: string, storeId: unknown, body: unknown): Promise<AcknowledgeCategoryMovesResponse> {
    assertListingSettingMember(memberId);
    const storeConnectionId = parseListingSettingInput(listingSettingStoreIdSchema, storeId);
    const parsed = parseListingSettingInput(acknowledgeCategoryMovesInputSchema, body);
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    // Ascending product ids: the hash does not depend on the order sent (the writer locks marks in this order too).
    const items = [...parsed.items].sort((left, right) => left.productId - right.productId);
    const requestHash = listingSettingWriteHash(CATEGORY_MOVES_ACKNOWLEDGE_OPERATION, { storeConnectionId, items });

    const { response, vendorId } = await this.deps.repository.execute({
      memberId, storeConnectionId, idempotencyKey: parsed.idempotencyKey,
    }, async (tx) => {
      await authorizeListingSettingWrite(tx);
      // Replay before anything else (plan P16): a retry of a committed "Got it" is answered from its ledger row.
      const use = await tx.findRequestKeyUse();
      const decision = classifyRequestKeyUse(use, { writer: "category_moves_acknowledge", storeConnectionId, requestHash });
      if (requestKeyUsePath(decision, { storeConnectionId }) === "replay") {
        return { response: replayAnswer(), vendorId: tx.vendorId };
      }
      const result = await tx.acknowledgeCategoryMoves({ items, requestHash, now });
      // The probe found no row under this key, and the request and store locks are held to commit: a
      // same-store retry waits for them and then sees this commit, and the key used on another store makes
      // the writer's own ledger read answer DROPSHIP_IDEMPOTENCY_CONFLICT. So the writer cannot replay here.
      if (result.outcome === "replayed") {
        throw listingSettingsInvariantFailed("A category moves acknowledge in a new listing settings request replayed.", {
          storeConnectionId,
        });
      }
      assertNamesSentProducts(result, items, storeConnectionId);
      return { response: acknowledgedAnswer(result), vendorId: tx.vendorId };
    });

    const replayed = response.outcome === "replayed";
    const shown = new Map(items.map((item) => [item.productId, item.shownCategoryId]));
    this.deps.log.info("dropship.listing_settings.category_moves_acknowledged", {
      outcome: response.outcome,
      vendor_id: vendorId,
      store_connection_id: storeConnectionId,
      actor_id: memberId,
      request_key: parsed.idempotencyKey,
      // A mark has no revision; its category is its state. The writer keeps the marks before the change in
      // its `category_moves_acknowledged` audit row for this request key (`hadMark`, `from`) and answers ids
      // only, so here they are unknown (null), not absent. A replay wrote nothing now: nothing before.
      before: replayed ? [] : null,
      after: response.acknowledgedProductIds.slice(0, MAX_LISTED_PRODUCTS)
        .map((productId) => ({ product_id: productId, category_id: shown.get(productId) ?? null })),
      changed_count: response.acknowledgedProductIds.length,
      // W13 writes no size price.
      size_count: 0,
      elapsed_ms: Math.max(0, Math.round(this.deps.timer() - started)),
      item_count: items.length,
      // A replay is answered from the probe, which does not read what the first request counted: unknown, not 0.
      acknowledged_count: replayed ? null : response.acknowledgedProductIds.length,
      moved_again_count: replayed ? null : response.movedAgainProductIds.length,
      acknowledged_product_ids: response.acknowledgedProductIds.slice(0, MAX_LISTED_PRODUCTS),
      moved_again_product_ids: response.movedAgainProductIds.slice(0, MAX_LISTED_PRODUCTS),
    });
    return response;
  }
}

/** A replay calls no writer and names no product (PR 7 D9): the page re-reads its views after any save. */
function replayAnswer(): AcknowledgeCategoryMovesResponse {
  return { outcome: "replayed", acknowledgedProductIds: [], movedAgainProductIds: [] };
}

function acknowledgedAnswer(result: CategoryMovesAcknowledgeResult): AcknowledgeCategoryMovesResponse {
  return {
    outcome: "acknowledged",
    acknowledgedProductIds: [...result.acknowledgedProductIds],
    movedAgainProductIds: [...result.movedAgainProductIds],
  };
}

/**
 * Every product the writer answers was sent in this request (the response
 * contract cannot see the request). The writer's join guarantees it; a breach
 * is a broken contract, refused inside the transaction so nothing commits.
 */
function assertNamesSentProducts(result: CategoryMovesAcknowledgeResult, items: readonly AcknowledgeItem[], storeConnectionId: number): void {
  const sent = new Set(items.map((item) => item.productId));
  const unsent = [...result.acknowledgedProductIds, ...result.movedAgainProductIds].filter((productId) => !sent.has(productId));
  if (unsent.length > 0) {
    throw listingSettingsInvariantFailed("A category moves acknowledge answered a product the request did not send.", {
      storeConnectionId, productIds: unsent.slice(0, MAX_LISTED_PRODUCTS),
    });
  }
}
