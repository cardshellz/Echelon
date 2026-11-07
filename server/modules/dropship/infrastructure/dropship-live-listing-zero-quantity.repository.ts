import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { logger as platformLogger } from "../../../platform/observability/logger";
import { DropshipError } from "../domain/errors";
import { LIVE_LISTING_ZERO_QUANTITY_STATUSES } from "../domain/live-listing-zero-quantity";
import type { DropshipLiveListingZeroQuantityRepository } from "../application/dropship-live-listing-zero-quantity-service";
import type { MarketplaceIssueCode } from "../domain/marketplace-sync-decision";
import {
  markListingsMarketplaceSyncDueWithClient,
  updateMarketplaceIssueCodesWithClient,
} from "./dropship-marketplace-listing-sync-state.repository";

const QUANTITY_RESTORE_BLOCKED_ISSUE: MarketplaceIssueCode = "quantity_restore_blocked";

/** The sync event a settled zero-quantity update writes (audit trail; not a push completion, so no price or policy baseline). */
export const LIVE_LISTING_ZERO_QUANTITY_SYNC_EVENT = "listing_quantity_zeroed";
const SYNC_EVENT_SOURCE = "dropship_zero_quantity";

/**
 * Settles a sent 0 on the listing, in one transaction under its row lock:
 * - re-checks that the listing is still live on the same recorded offer (the
 *   0 went to that offer); otherwise nothing is written and the caller retries
 *   from current state (retryable conflict);
 * - pushed_quantity = 0 and last_pushed_at = now: the push baseline eBay
 *   sync-back reads under legacy authority (marketplacePublishBaseline), so a
 *   later read of 0 on eBay is Card Shellz's own number, not a vendor limit;
 * - the listing is made due for the sweep's next read, and its quantity_restore_blocked issue is cleared;
 * - an append-only sync event and audit row record who/what/when/before/after.
 * Price, status, content and policy columns are not touched. Idempotent: a
 * replay writes 0 again with its own time and its own audit row.
 */
export class PgDropshipLiveListingZeroQuantityRepository implements DropshipLiveListingZeroQuantityRepository {
  constructor(private readonly dbPool: Pick<Pool, "connect"> = defaultPool) {}

  async settleZeroQuantity(
    input: Parameters<DropshipLiveListingZeroQuantityRepository["settleZeroQuantity"]>[0],
  ): Promise<{ pushedQuantityBefore: number; lastPushedAtBefore: Date | null }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const before = (await client.query<{ pushed_quantity: number; last_pushed_at: Date | null }>(
        `SELECT pushed_quantity, last_pushed_at
         FROM dropship.dropship_vendor_listings
         WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND product_variant_id = $4
           AND NULLIF(BTRIM(external_listing_id), '') IS NOT NULL
           AND BTRIM(external_offer_id) = $5
           AND status = ANY($6::text[])
         FOR UPDATE`,
        [input.listingId, input.vendorId, input.storeConnectionId, input.productVariantId, input.externalOfferId,
          [...LIVE_LISTING_ZERO_QUANTITY_STATUSES]],
      )).rows[0];
      if (!before) {
        throw new DropshipError("DROPSHIP_LISTING_ZERO_QUANTITY_SETTLEMENT_CONFLICT",
          "The listing stopped being live on the offer the zero quantity was sent to; it is decided again from current state.",
          { listingId: input.listingId, productVariantId: input.productVariantId, externalOfferId: input.externalOfferId,
            retryable: true });
      }
      await client.query(
        `UPDATE dropship.dropship_vendor_listings
         SET pushed_quantity = 0,
             last_pushed_at = $2,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = $2
         WHERE id = $1`,
        [input.listingId, input.now, JSON.stringify({
          lastZeroQuantity: { at: input.now.toISOString(), actorId: input.actorId, reason: input.reason },
        })],
      );
      await markListingsMarketplaceSyncDueWithClient(client, [input.listingId]);
      // eBay now shows Card Shellz's own 0: a restore is no longer blocked (eBay sync-back's staff flag clears with it).
      await updateMarketplaceIssueCodesWithClient(client, { listingId: input.listingId, add: [],
        remove: [QUANTITY_RESTORE_BLOCKED_ISSUE], at: input.now });
      const payload = {
        externalOfferId: input.externalOfferId, sku: input.sku, quantity: 0, reason: input.reason,
        before: { pushedQuantity: before.pushed_quantity, lastPushedAt: before.last_pushed_at?.toISOString() ?? null },
        after: { pushedQuantity: 0, lastPushedAt: input.now.toISOString() },
      };
      await insertSyncEvent(client, input.listingId, payload, input.now);
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, 'dropship_vendor_listing', $3, 'listing_quantity_zeroed', 'system', $4, 'info', $5::jsonb, $6)`,
        [input.vendorId, input.storeConnectionId, String(input.listingId), input.actorId, JSON.stringify(payload), input.now],
      );
      await client.query("COMMIT");
      return { pushedQuantityBefore: before.pushed_quantity, lastPushedAtBefore: before.last_pushed_at };
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: unknown) => {
        // The settlement's own error is the one rethrown; the rollback failure is logged so it is not lost.
        platformLogger.warn("dropship.listing_quantity.zero_settlement_rollback_failed", {
          outcome: "rollback_failed", error_code: "DROPSHIP_LISTING_ZERO_QUANTITY_ROLLBACK_FAILED",
          listing_id: input.listingId, store_connection_id: input.storeConnectionId,
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      });
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertSyncEvent(client: PoolClient, listingId: number, payload: Record<string, unknown>, at: Date): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_listing_sync_events (listing_id, event_type, source, payload, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [listingId, LIVE_LISTING_ZERO_QUANTITY_SYNC_EVENT, SYNC_EVENT_SOURCE, JSON.stringify(payload), at],
  );
}
