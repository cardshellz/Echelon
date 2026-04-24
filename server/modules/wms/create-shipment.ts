/**
 * WMS outbound-shipment creation helper.
 *
 * Owner: Group B / §6 Commit 8 of shipstation-flow-refactor-plan.md.
 *
 * Purpose:
 *   At OMS→WMS sync time (after wms.orders + wms.order_items have been
 *   inserted), create one `wms.outbound_shipments` row with
 *   status='planned' plus one `wms.outbound_shipment_items` row per
 *   just-inserted order item. The shipment is the unit ShipStation
 *   and Shopify fulfillment ops hang off of — creating it at sync time
 *   means Group C (SS push) and Group E (Shopify fulfillment push)
 *   always have a target row to update.
 *
 * Idempotency (coding-standards rule #6):
 *   The helper checks for an existing `planned` shipment on the same
 *   `order_id`. If one exists, it returns that id with created=false
 *   and performs no writes. Safe to retry.
 *
 * Determinism (rule #2):
 *   The helper takes `db` via argument — no hidden clocks, no global
 *   state beyond the DB client. Caller owns the db handle.
 *
 * Data integrity (rule #3):
 *   - No floats touched; only integer ids and quantities.
 *   - Input `orderItems` is iterated but never mutated.
 *
 * NOTE: this file does NOT touch the feature flag. Flag-gating lives
 * in the caller (oms/wms-sync.service.ts). If the helper is imported
 * and run, it will attempt the writes unconditionally — that's
 * intentional so other callers (reconcile sweep, backfill) can reuse
 * it without replicating flag logic.
 */

import { sql } from "drizzle-orm";
import {
  outboundShipments,
  outboundShipmentItems,
  type InsertOutboundShipment,
  type InsertOutboundShipmentItem,
} from "@shared/schema";

/**
 * Minimal structural type for the db handle the helper needs. We keep
 * it loose to match existing wms-sync patterns (`any`-ish db) while
 * still documenting the methods actually called.
 */
export type DbLike = {
  execute: (query: any) => Promise<{ rows: any[] }>;
  insert: (table: any) => any;
};

/**
 * Source value stamped on shipments created by the OMS→WMS sync path.
 *
 * Existing values on this column (per schema comment on
 * `outbound_shipments.source`): 'shopify_webhook', 'manual', 'api'.
 * We introduce 'echelon_sync' so ops can distinguish shipments that
 * were planned by the sync service at order intake from those created
 * by legacy paths. No DB enum change needed — the column is a plain
 * varchar(30) with a string default.
 */
export const ECHELON_SYNC_SHIPMENT_SOURCE = "echelon_sync";

/**
 * Status marker the helper checks for idempotency. Only a pre-existing
 * 'planned' shipment blocks a new one; shipments that have already
 * advanced to 'queued'/'labeled'/etc. mean the order is past the sync
 * stage and no new planned row should be made.
 */
const PLANNED_STATUS = "planned";

export interface CreateShipmentInput {
  /** wms.outbound_shipment_items.order_item_id */
  id: number;
  /** wms.outbound_shipment_items.qty (full quantity — split happens later) */
  quantity: number;
}

export interface CreateShipmentResult {
  /** id of the wms.outbound_shipments row (new or existing). */
  shipmentId: number;
  /** true = inserted a new row; false = reused an existing planned row. */
  created: boolean;
}

/**
 * Create a planned outbound shipment for a just-synced WMS order.
 *
 * Contract:
 *   - Returns { shipmentId, created:true } on insert.
 *   - Returns { shipmentId, created:false } if a planned shipment
 *     already exists for `wmsOrderId` (no writes performed).
 *   - Throws on DB errors — caller wraps in try/catch and decides
 *     whether to abort the sync (the wms-sync caller treats it as
 *     non-fatal; see §6 Commit 8 in the plan).
 */
export async function createShipmentForOrder(
  db: DbLike,
  wmsOrderId: number,
  channelId: number | null,
  orderItems: ReadonlyArray<CreateShipmentInput>,
): Promise<CreateShipmentResult> {
  if (!Number.isInteger(wmsOrderId) || wmsOrderId <= 0) {
    throw new Error(
      `createShipmentForOrder: wmsOrderId must be a positive integer, got ${wmsOrderId}`,
    );
  }

  // ── 1. Idempotency probe ────────────────────────────────────────
  // One planned shipment per (order_id) is the invariant. Raw SQL
  // keeps the probe trivial and avoids a Drizzle query-builder chain
  // for the test mock layer.
  const existing = await db.execute(sql`
    SELECT id
      FROM wms.outbound_shipments
     WHERE order_id = ${wmsOrderId}
       AND status  = ${PLANNED_STATUS}
     LIMIT 1
  `);

  if (existing.rows.length > 0) {
    const existingId = Number(existing.rows[0].id);
    if (!Number.isInteger(existingId) || existingId <= 0) {
      throw new Error(
        `createShipmentForOrder: existing shipment id is not a positive integer: ${existing.rows[0].id}`,
      );
    }
    return { shipmentId: existingId, created: false };
  }

  // ── 2. Insert the shipment row ──────────────────────────────────
  // All lifecycle columns (voided_at, shopify_fulfillment_id,
  // requires_review, etc.) are left unset so the schema defaults
  // (NULL / false / 0) apply. That keeps the row shape aligned with
  // the state-machine definition in §2.4 of the plan.
  const shipmentValues: InsertOutboundShipment = {
    orderId: wmsOrderId,
    channelId,
    status: PLANNED_STATUS,
    source: ECHELON_SYNC_SHIPMENT_SOURCE,
  };

  const inserted = await db
    .insert(outboundShipments)
    .values(shipmentValues)
    .returning({ id: outboundShipments.id });

  if (!Array.isArray(inserted) || inserted.length === 0 || inserted[0]?.id == null) {
    throw new Error(
      `createShipmentForOrder: insert on wms.outbound_shipments returned no rows for wmsOrderId=${wmsOrderId}`,
    );
  }

  const shipmentId = Number(inserted[0].id);
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new Error(
      `createShipmentForOrder: new shipment id is not a positive integer: ${inserted[0].id}`,
    );
  }

  // ── 3. Insert the per-item rows ────────────────────────────────
  // Empty `orderItems` is valid: gift-card or pure-membership orders
  // produce zero shippable items. The shipment row is still useful
  // (ops dashboards, SS parity checks) even when it carries no
  // inventory.
  if (orderItems.length > 0) {
    const itemRows: InsertOutboundShipmentItem[] = orderItems.map((it) => {
      if (!Number.isInteger(it.id) || it.id <= 0) {
        throw new Error(
          `createShipmentForOrder: orderItem.id must be a positive integer, got ${it.id}`,
        );
      }
      if (!Number.isInteger(it.quantity) || it.quantity < 0) {
        throw new Error(
          `createShipmentForOrder: orderItem.quantity must be a non-negative integer, got ${it.quantity}`,
        );
      }
      return {
        shipmentId,
        orderItemId: it.id,
        qty: it.quantity,
      };
    });

    await db.insert(outboundShipmentItems).values(itemRows);
  }

  return { shipmentId, created: true };
}
