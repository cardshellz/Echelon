import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipEbayMarketplaceOrderEffects,
  DropshipEbayOrderSaleLine,
  DropshipEbayUnmatchedOrderLine,
  DropshipParkedOrderLine,
} from "../application/dropship-ebay-order-intake-poll-service";
import { EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE, MARKETPLACE_CANCEL_STATUSES } from "../domain/marketplace-order-cancel";
import { marketplaceSyncNotice } from "../domain/marketplace-sync-decision";
import { marketplaceItemSubjectKey } from "../domain/marketplace-sync-keys";
import {
  recordMarketplaceSaleLinesWithClient,
  startMarketplaceSalesLedgerWithClient,
} from "./dropship-listing-marketplace-sales.repository";
import { applyMarketplaceCancellationWithClient } from "./dropship-marketplace-order-cancel.repository";
import { enqueueMarketplaceSyncNoticesWithClient } from "./dropship-marketplace-sync-notices.repository";
import {
  expireUnmatchedOrderLinesWithClient,
  parkUnmatchedOrderLineWithClient,
  resolveUnmatchedOrderLineWithClient,
} from "./dropship-unmatched-marketplace-orders.repository";

/** Why a line is parked (dropship_unmatched_marketplace_orders.reason). */
const UNMATCHED_SKU_REASON = "unmatched_sku";
const CANCEL_DEAD_LETTER_ENTITY = "dropship_ebay_order";
const POLL_ACTOR = { actorType: "system", actorId: "system:ebay-order-poll" } as const;

/**
 * The eBay order poll's writes besides intake (plan v4 §6.4, §7.2, §7.3),
 * each in its own transaction, each a replay-safe no-op the second time:
 * sales-ledger lines and parked lines are unique per store, order and line;
 * a cancellation is compare-and-set on the intake; the dead letter and the
 * vendor question are written once per store and order or item.
 */
export class PgDropshipEbayMarketplaceOrderEffects implements DropshipEbayMarketplaceOrderEffects {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async recordPollFacts(input: {
    storeConnectionId: number; saleLines: readonly DropshipEbayOrderSaleLine[]; unmatchedLines: readonly DropshipEbayUnmatchedOrderLine[];
    seenAt: Date;
  }): Promise<{ saleLinesRecorded: number; linesParked: number }> {
    if (input.saleLines.length === 0 && input.unmatchedLines.length === 0) return { saleLinesRecorded: 0, linesParked: 0 };
    return this.inTransaction(async (client) => {
      const saleLinesRecorded = await recordMarketplaceSaleLinesWithClient(client, {
        storeConnectionId: input.storeConnectionId, lines: input.saleLines, firstSeenAt: input.seenAt,
      });
      let linesParked = 0;
      for (const line of input.unmatchedLines) {
        const parked = await parkUnmatchedOrderLineWithClient(client, {
          storeConnectionId: input.storeConnectionId, externalOrderId: line.externalOrderId, externalLineItemId: line.externalLineItemId,
          externalListingId: line.externalListingId, sku: line.sku, candidateListingId: line.candidateListingId, reason: UNMATCHED_SKU_REASON,
          orderedAt: line.orderedAt, seenAt: input.seenAt,
        });
        if (!parked) continue;
        linesParked += 1;
        // The sweep reads the candidate next (plan v4 §7.3 step 3): its own offer proves or disproves the relist.
        await client.query(`UPDATE dropship.dropship_vendor_listings SET marketplace_sync_attempted_at = NULL
          WHERE id = $1 AND store_connection_id = $2`, [line.candidateListingId, input.storeConnectionId]);
      }
      return { saleLinesRecorded, linesParked };
    });
  }

  async applyCancellation(input: { storeConnectionId: number; externalOrderId: string; at: Date }): Promise<{ action: string; intakeId: number | null }> {
    return this.inTransaction(async (client) => {
      const applied = await applyMarketplaceCancellationWithClient(client, { ...input, actor: POLL_ACTOR });
      return { action: applied.action, intakeId: applied.intakeId };
    });
  }

  /**
   * A cancel no retry fixes (review ARCH-2/3), in one transaction: the
   * intake, if Card Shellz took the order in, is kept as review state
   * (cancellation_status marketplace_cancel_unprocessable), so the poll never
   * checks or applies it again and ops health counts it until a person clears
   * it; and the audit row, written once per store and order with the change.
   * Answers whether the dead letter is new.
   */
  async recordCancellationDeadLetter(input: {
    vendorId: number; storeConnectionId: number; externalOrderId: string; failureCode: string; message: string; at: Date;
  }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const entityId = `${input.storeConnectionId}:${input.externalOrderId}`;
      // The same xact-lock shape as the immutable-conflict audit (dropship-ebay-order-intake.repository.ts): once per store and order.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE, entityId]);
      const intake = (await client.query<{ id: number; cancellation_status: string | null }>(`SELECT id, cancellation_status
        FROM dropship.dropship_order_intake WHERE store_connection_id = $1 AND external_order_id = $2 FOR UPDATE`,
      [input.storeConnectionId, input.externalOrderId])).rows[0] ?? null;
      const unprocessable = MARKETPLACE_CANCEL_STATUSES.unprocessable;
      if (intake !== null && intake.cancellation_status !== unprocessable) {
        await client.query(`UPDATE dropship.dropship_order_intake SET cancellation_status = $2, updated_at = $3 WHERE id = $1`,
          [intake.id, unprocessable, input.at]);
      }
      const result = await client.query(`INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
        SELECT $1, $2, $3::varchar, $4::varchar, $5::varchar, 'system', $6, 'error', $7::jsonb, $8
        WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_audit_events
          WHERE entity_type = $3::varchar AND entity_id = $4::varchar AND event_type = $5::varchar)`,
      [input.vendorId, input.storeConnectionId, CANCEL_DEAD_LETTER_ENTITY, entityId, EBAY_ORDER_CANCEL_DEAD_LETTER_EVENT_TYPE, POLL_ACTOR.actorId,
        JSON.stringify({ failureCode: input.failureCode, message: input.message, externalOrderId: input.externalOrderId, requiresReview: true,
          intakeId: intake?.id ?? null, before: { cancellationStatus: intake?.cancellation_status ?? null },
          after: { cancellationStatus: intake === null ? null : unprocessable } }),
        input.at]);
      return result.rowCount === 1;
    });
  }

  async listAcceptedOrdersToCheck(input: {
    storeConnectionId: number; now: Date; limit: number; acceptedWithinMs: number; recheckAfterMs: number;
  }): Promise<Array<{ intakeId: number; externalOrderId: string }>> {
    // Accepted and not shipped yet (no tracking pushed for it), within 14 days, not asked about for an hour (plan v2 §7.2),
    // and not dead-lettered for review (a permanent failure is never retried, review ARCH-2).
    const result = await this.dbPool.query<{ id: number; external_order_id: string }>(`SELECT oi.id, oi.external_order_id
      FROM dropship.dropship_order_intake oi
      WHERE oi.store_connection_id = $1 AND oi.status = 'accepted' AND oi.marketplace_cancelled_at IS NULL
        AND oi.cancellation_status IS DISTINCT FROM $5
        AND oi.accepted_at >= $2 AND (oi.marketplace_status_checked_at IS NULL OR oi.marketplace_status_checked_at <= $3)
        AND NOT EXISTS (SELECT 1 FROM dropship.dropship_marketplace_tracking_pushes tp WHERE tp.intake_id = oi.id)
      ORDER BY oi.marketplace_status_checked_at ASC NULLS FIRST, oi.id ASC
      LIMIT $4`,
    [input.storeConnectionId, new Date(input.now.getTime() - input.acceptedWithinMs), new Date(input.now.getTime() - input.recheckAfterMs),
      input.limit, MARKETPLACE_CANCEL_STATUSES.unprocessable]);
    return result.rows.map((row) => ({ intakeId: row.id, externalOrderId: row.external_order_id }));
  }

  async markMarketplaceStatusChecked(input: { intakeIds: readonly number[]; at: Date }): Promise<void> {
    if (input.intakeIds.length === 0) return;
    // An eBay fact (eBay still shows the order open), not an operator action: no audit row.
    await this.dbPool.query(`UPDATE dropship.dropship_order_intake SET marketplace_status_checked_at = $2
      WHERE id = ANY($1::int[]) AND status = 'accepted'`, [[...input.intakeIds], input.at]);
  }

  async listOpenParkedLines(input: { storeConnectionId: number }): Promise<DropshipParkedOrderLine[]> {
    const result = await this.dbPool.query<{
      id: number; external_order_id: string; external_listing_id: string; sku: string; candidate_listing_id: number | null; first_seen_at: Date;
      candidate_external_listing_id: string | null; candidate_had_item_number: boolean; candidate_read_at: Date | null;
    }>(`SELECT u.id, u.external_order_id, u.external_listing_id, u.sku, u.candidate_listing_id, u.first_seen_at,
        l.external_listing_id AS candidate_external_listing_id,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_previous_marketplace_ids prev
                WHERE prev.listing_id = u.candidate_listing_id AND prev.external_listing_id = u.external_listing_id) AS candidate_had_item_number,
        l.marketplace_sync_attempted_at AS candidate_read_at
      FROM dropship.dropship_unmatched_marketplace_orders u
      LEFT JOIN dropship.dropship_vendor_listings l ON l.id = u.candidate_listing_id
      WHERE u.store_connection_id = $1 AND u.status = 'open'
      ORDER BY u.first_seen_at, u.id`, [input.storeConnectionId]);
    return result.rows.map((row) => ({
      id: row.id, externalOrderId: row.external_order_id, externalListingId: row.external_listing_id, sku: row.sku,
      candidateListingId: row.candidate_listing_id, firstSeenAt: row.first_seen_at, candidateExternalListingId: row.candidate_external_listing_id,
      candidateHadItemNumber: row.candidate_had_item_number, candidateReadAt: row.candidate_read_at,
    }));
  }

  async resolveParkedLines(input: { ids: readonly number[]; resolution: "relinked" | "cancelled" | "fulfilled_elsewhere"; at: Date }): Promise<number> {
    if (input.ids.length === 0) return 0;
    return this.inTransaction(async (client) => {
      let resolved = 0;
      for (const id of input.ids) {
        if (await resolveUnmatchedOrderLineWithClient(client, { id, resolution: input.resolution, at: input.at })) resolved += 1;
      }
      return resolved;
    });
  }

  async askAboutUnknownItem(input: {
    vendorId: number; storeConnectionId: number; externalListingId: string; sku: string; at: Date;
  }): Promise<boolean> {
    return this.inTransaction(async (client) => {
      const written = await enqueueMarketplaceSyncNoticesWithClient(client, {
        vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, createdAt: input.at,
        notices: [marketplaceSyncNotice("unknown_item_number", marketplaceItemSubjectKey(input.externalListingId), {
          externalListingId: input.externalListingId, sku: input.sku,
        })],
      });
      return written === 1;
    });
  }

  async expireParkedLines(input: { now: Date }): Promise<number> {
    return this.inTransaction((client) => expireUnmatchedOrderLinesWithClient(client, input.now));
  }

  async startSalesLedger(input: { storeConnectionId: number; since: Date }): Promise<boolean> {
    return this.inTransaction((client) => startMarketplaceSalesLedgerWithClient(client, input));
  }

  private async inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {
        // The original error is the one to report; a failed rollback ends with the connection.
      });
      throw error;
    } finally {
      client.release();
    }
  }
}
