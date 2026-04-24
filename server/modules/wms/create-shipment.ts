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
 * Source value stamped on shipments created by the combined-orders
 * child-link path (plan §6 Commit 14). A child order in a combined
 * group gets its own `wms.outbound_shipments` row (so per-order
 * finance / Shopify-fulfillment tracking stays correct) but that row
 * shares the parent's `shipstation_order_id` — only the parent's
 * shipment is pushed to SS. The marker lets Group C push code, the
 * reconcile sweep (Group H / C15), and ops dashboards distinguish
 * these synthetic child rows from standalone shipments.
 */
export const ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE = "echelon_combined_child";

/**
 * Status marker the helper checks for idempotency. Only a pre-existing
 * 'planned' shipment blocks a new one; shipments that have already
 * advanced to 'queued'/'labeled'/etc. mean the order is past the sync
 * stage and no new planned row should be made.
 */
const PLANNED_STATUS = "planned";

/**
 * Raised by `linkChildToParentShipment` when the combined-group parent
 * has not yet had a `wms.outbound_shipments` row created. The caller
 * (wms-sync) treats this as a race — the child arrived before the
 * parent finished sync — and relies on the reconcile sweep (Group H /
 * C15) to retry the link once the parent catches up.
 *
 * The error is surfaced loud (named class, structured fields) rather
 * than silently swallowed so ops / logs can distinguish it from real
 * DB failures.
 */
export class ChildWithoutParentShipmentError extends Error {
  constructor(
    public readonly childWmsOrderId: number,
    public readonly parentWmsOrderId: number,
  ) {
    super(
      `linkChildToParentShipment: parent order ${parentWmsOrderId} has no shipment (child ${childWmsOrderId} cannot link)`,
    );
    this.name = "ChildWithoutParentShipmentError";
  }
}

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

/**
 * For a child order in a combined group, create a `wms.outbound_shipments`
 * row that SHARES the parent's physical-shipment identity.
 *
 * Owner: Group C / §6 Commit 14 of shipstation-flow-refactor-plan.md.
 *
 * Unlike {@link createShipmentForOrder}, this helper:
 *   - Does NOT represent a separate SS-facing shipment — the parent's
 *     shipment is the one pushed to ShipStation and the one that
 *     carries the physical label / tracking number.
 *   - Creates a WMS row whose `shipstation_order_id` /
 *     `shipstation_order_key` are inherited from the parent's row.
 *     Those values may legitimately be NULL at link time (if the
 *     parent hasn't been pushed to SS yet); the reconcile sweep
 *     (Group H / C15) backfills them once the parent lands in SS.
 *   - Stamps `source='echelon_combined_child'` so downstream code
 *     (Group C push, Group H reconcile, ops dashboards) can tell
 *     these apart from standalone shipments.
 *   - Uses the CHILD's own `wms.order_items` (so per-order finance
 *     snapshots and Shopify fulfillment-per-order semantics are
 *     preserved — each child still emits its own Shopify fulfillment
 *     in Group E, sharing only the tracking number with the parent).
 *
 * Idempotency (Rule #6): if a shipment already exists for the child
 * order, returns that row's id with `created:false` and performs no
 * writes. Status is NOT part of the probe (unlike createShipmentForOrder
 * which gates on 'planned') because a child's shipment can advance
 * past 'planned' via the parent's lifecycle reconcile — re-running
 * the link must not duplicate it.
 *
 * Determinism (Rule #2): db handle injected; no clocks, no globals.
 *
 * Data integrity (Rule #3): inputs validated (positive-integer ids,
 * non-negative integer quantities); `childOrderItems` iterated but
 * never mutated.
 *
 * Error surface (Rule #5):
 *   - {@link ChildWithoutParentShipmentError} — parent has no
 *     shipment row yet. Caller decides whether to retry via reconcile.
 *   - Plain `Error` — invalid inputs / DB failures. Caller wraps.
 */
export async function linkChildToParentShipment(
  db: DbLike,
  childWmsOrderId: number,
  parentWmsOrderId: number,
  channelId: number | null,
  childOrderItems: ReadonlyArray<CreateShipmentInput>,
): Promise<CreateShipmentResult> {
  // ── 0. Input validation ────────────────────────────────────────
  if (!Number.isInteger(childWmsOrderId) || childWmsOrderId <= 0) {
    throw new Error(
      `linkChildToParentShipment: childWmsOrderId must be a positive integer, got ${childWmsOrderId}`,
    );
  }
  if (!Number.isInteger(parentWmsOrderId) || parentWmsOrderId <= 0) {
    throw new Error(
      `linkChildToParentShipment: parentWmsOrderId must be a positive integer, got ${parentWmsOrderId}`,
    );
  }
  if (childWmsOrderId === parentWmsOrderId) {
    throw new Error(
      `linkChildToParentShipment: childWmsOrderId must differ from parentWmsOrderId (got ${childWmsOrderId})`,
    );
  }

  // ── 1. Idempotency probe — ANY status on the child's order ─────
  // Unlike createShipmentForOrder's planned-only gate, we match any
  // status: the child's shipment may have been advanced past planned
  // by a prior reconcile run that inherited the parent's shipped
  // state. Re-running the link must not duplicate the row.
  const existing = await db.execute(sql`
    SELECT id
      FROM wms.outbound_shipments
     WHERE order_id = ${childWmsOrderId}
     LIMIT 1
  `);

  if (existing.rows.length > 0) {
    const existingId = Number(existing.rows[0].id);
    if (!Number.isInteger(existingId) || existingId <= 0) {
      throw new Error(
        `linkChildToParentShipment: existing shipment id is not a positive integer: ${existing.rows[0].id}`,
      );
    }
    return { shipmentId: existingId, created: false };
  }

  // ── 2. Fetch parent's shipment identity ────────────────────────
  // We need the parent's SS linkage columns so the child inherits
  // them. `shipstation_order_id` / `shipstation_order_key` may be
  // NULL (parent hasn't been pushed yet); that's legal — reconcile
  // backfills later. But the parent's shipment ROW must exist,
  // otherwise we have a race and surface it loud.
  const parent = await db.execute(sql`
    SELECT id, shipstation_order_id, shipstation_order_key
      FROM wms.outbound_shipments
     WHERE order_id = ${parentWmsOrderId}
     LIMIT 1
  `);

  if (parent.rows.length === 0) {
    throw new ChildWithoutParentShipmentError(
      childWmsOrderId,
      parentWmsOrderId,
    );
  }

  // Parent's SS linkage columns are nullable in schema; normalize
  // `undefined` (missing key) to `null` so the insert payload is
  // explicit and audit-readable (Rule #8).
  const parentRow: any = parent.rows[0];
  const parentShipstationOrderId: number | null =
    parentRow.shipstation_order_id ?? parentRow.shipstationOrderId ?? null;
  const parentShipstationOrderKey: string | null =
    parentRow.shipstation_order_key ?? parentRow.shipstationOrderKey ?? null;

  // ── 3. Insert the child shipment row ───────────────────────────
  // Status stays 'planned' until the parent ships; C15 reconcile
  // advances the child in lockstep with the parent.
  const shipmentValues: InsertOutboundShipment = {
    orderId: childWmsOrderId,
    channelId,
    status: PLANNED_STATUS,
    source: ECHELON_COMBINED_CHILD_SHIPMENT_SOURCE,
    shipstationOrderId: parentShipstationOrderId,
    shipstationOrderKey: parentShipstationOrderKey,
  };

  const inserted = await db
    .insert(outboundShipments)
    .values(shipmentValues)
    .returning({ id: outboundShipments.id });

  if (!Array.isArray(inserted) || inserted.length === 0 || inserted[0]?.id == null) {
    throw new Error(
      `linkChildToParentShipment: insert on wms.outbound_shipments returned no rows for childWmsOrderId=${childWmsOrderId}`,
    );
  }

  const shipmentId = Number(inserted[0].id);
  if (!Number.isInteger(shipmentId) || shipmentId <= 0) {
    throw new Error(
      `linkChildToParentShipment: new shipment id is not a positive integer: ${inserted[0].id}`,
    );
  }

  // ── 4. Insert the child's own item rows ────────────────────────
  // Uses the CHILD's wms.order_items (not the parent's) so
  // per-order Shopify fulfillment push in Group E carries the right
  // line items. Empty items is valid (gift-card / pure-membership
  // children) — shipment row is still useful for reconcile.
  if (childOrderItems.length > 0) {
    const itemRows: InsertOutboundShipmentItem[] = childOrderItems.map((it) => {
      if (!Number.isInteger(it.id) || it.id <= 0) {
        throw new Error(
          `linkChildToParentShipment: orderItem.id must be a positive integer, got ${it.id}`,
        );
      }
      if (!Number.isInteger(it.quantity) || it.quantity < 0) {
        throw new Error(
          `linkChildToParentShipment: orderItem.quantity must be a non-negative integer, got ${it.quantity}`,
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
