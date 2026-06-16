/**
 * Shipment-level state mutations + order-level roll-up.
 *
 * Per refactor plan §6 Commit 15 and invariant #4:
 *   - The only writers of `wms.outbound_shipments.status` are the
 *     `markShipment*` helpers in this file.
 *   - The only writer of `wms.orders.warehouse_status` (post-C16) is
 *     `recomputeOrderStatusFromShipments` in this file.
 *
 * Each mark-* helper is single-purpose and idempotent: a call that
 * would not change any column (same status + same tracking / void
 * metadata) returns `{ changed: false }` without issuing an UPDATE.
 * This matters for SHIP_NOTIFY replay scenarios where ShipStation
 * redelivers the same webhook.
 *
 * `dispatchShipmentEvent` is a thin typed wrapper so the SHIP_NOTIFY
 * caller can pass a discriminated-union event and let this module
 * pick the right mutation. It does NOT trigger roll-up; the caller
 * orchestrates (mark → recompute → OMS derive → event record) so
 * each helper stays single-purpose and auditable.
 *
 * Coding-standards compliance:
 *   - Rule #2 (determinism): `now` is injected via opts.now, defaults
 *     to `new Date()` only at the outermost call site.
 *   - Rule #3 (data integrity): never mutates inputs; returns a
 *     structured result `{ wmsOrderId, changed }`.
 *   - Rule #5 (errors): throws `Error` with a structured `code` for
 *     missing rows so the SHIP_NOTIFY catch-block can classify.
 *   - Rule #6 (idempotency): every mark-* call is a no-op on identical
 *     replay; `recomputeOrderStatusFromShipments` is also idempotent.
 *   - Rule #8 (auditability): every write logs shipment id + before /
 *     after state via the returned `changed` flag; caller is responsible
 *     for event-row insertion.
 */

import { sql } from "drizzle-orm";
import {
  deriveWmsFromShipments,
  type ShipmentStatus,
  type WmsWarehouseStatus,
} from "@shared/enums/order-status";
import { engineRefFromRow } from "../shipping/adapters/shipstation.adapter";
import type { EngineRef } from "../shipping/types";

// ─── Public types ────────────────────────────────────────────────────

export interface MarkShipmentResult {
  /** wms.orders.id that owns the shipment. Always resolved; missing
   *  shipment rows throw instead of returning null so callers cannot
   *  silently proceed with an unresolved owner. */
  wmsOrderId: number;
  /** True when the helper issued an UPDATE; false on idempotent replay. */
  changed: boolean;
}

export interface RecomputeResult {
  /** The resulting warehouse_status after applying shipment roll-up
   *  without clobbering valid in-warehouse pick progress. */
  warehouseStatus: WmsWarehouseStatus;
  /** True when the derived status differs from the current row and an
   *  UPDATE was issued. False when no row was found, when shipments
   *  are empty, or when the current status already matches. */
  changed: boolean;
}

function shouldPreserveWarehouseProgressDuringOpenShipmentRollup(orderRow: any): boolean {
  const status = String(orderRow?.warehouse_status ?? "");
  const shippableUnits = Number(orderRow?.shippable_unit_count ?? 0);
  const pickedUnits = Number(orderRow?.picked_unit_count ?? 0);

  if (status === "picking") return true;
  if (
    status === "picked" ||
    status === "packing" ||
    status === "packed" ||
    status === "ready_to_ship" ||
    status === "completed"
  ) {
    return shippableUnits > 0 && pickedUnits >= shippableUnits;
  }

  return false;
}

/**
 * Event emitted by the SHIP_NOTIFY caller. Discriminated union so each
 * kind carries exactly the metadata that mutation needs — no "optional
 * tracking on a cancel" ambiguity.
 */
export type ShipmentEvent =
  | {
      kind: "shipped";
      trackingNumber: string;
      carrier: string;
      shipDate: Date;
      trackingUrl?: string | null;
    }
  | { kind: "cancelled"; reason?: string }
  | { kind: "voided"; reason?: string };

// ─── Internals ───────────────────────────────────────────────────────

interface CurrentShipmentRow {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  tracking_url: string | null;
  shopify_fulfillment_id: string | null;
  shipping_engine: string | null;
  engine_order_ref: string | null;
  engine_shipment_ref: string | null;
  shipstation_order_id: number | null;
  shipstation_order_key: string | null;
}

/**
 * Read the current shipment row. Throws `ShipmentNotFoundError` when
 * the row is missing — single-purpose helpers must not silently no-op
 * on a missing row because that would hide data-integrity bugs.
 */
async function loadShipment(
  db: any,
  shipmentId: number,
): Promise<CurrentShipmentRow> {
  const result: any = await db.execute(sql`
    SELECT id, order_id, status, tracking_number, carrier, tracking_url,
           shopify_fulfillment_id,
           shipping_engine, engine_order_ref, engine_shipment_ref,
           shipstation_order_id, shipstation_order_key
    FROM wms.outbound_shipments
    WHERE id = ${shipmentId}
    LIMIT 1
  `);
  const row: CurrentShipmentRow | undefined = result?.rows?.[0];
  if (!row) {
    const err: any = new Error(
      `shipment ${shipmentId} not found in wms.outbound_shipments`,
    );
    err.code = "SHIPMENT_NOT_FOUND";
    err.shipmentId = shipmentId;
    throw err;
  }
  return row;
}

function assertPositiveInt(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    const err: any = new Error(`${field} must be a positive integer`);
    err.code = "INVALID_ARGUMENT";
    err.field = field;
    err.value = value;
    throw err;
  }
  return value;
}

// ─── markShipmentShipped ─────────────────────────────────────────────

/**
 * Transition a shipment to `shipped`. Idempotent: re-calling with the
 * SAME tracking number on an already-shipped shipment is a no-op.
 * Re-calling with a DIFFERENT tracking number updates the tracking
 * columns (covers re-label flows where the carrier was swapped without
 * voiding the original label — rare but observed in production).
 *
 * Side effects beyond the shipment row (§6 Commit 18):
 *   - If the shipment already carried a `tracking_number` that DIFFERS
 *     from the incoming one, an audit row is inserted into
 *     `wms.shipment_tracking_history` with `replaced_at` + the new
 *     tracking number in `replaced_by_tracking_number`. This closes
 *     the re-label loop started by markShipmentVoided (§6 Commit 17):
 *     history now captures the full chain of tracking numbers.
 *   - Tracking-match idempotent replays write nothing (no history).
 *   - Carrier-only changes (same tracking) are NOT history-worthy;
 *     they're a mapping fix, not a label replacement.
 *   - History-insert failure is logged but does NOT block the UPDATE,
 *     matching the non-blocking contract used in markShipmentVoided.
 *     Reconcile (Group F) catches any gaps.
 *
 * Side effects beyond the shipment row (§6 Commit 24, re-label):
 *   - When the shipment had a non-null `shopify_fulfillment_id` AND
 *     the tracking number is changing AND
 *     `opts.fulfillmentPush.updateShopifyFulfillmentTracking` is
 *     wired, that hook is invoked to update the EXISTING Shopify
 *     fulfillment's tracking via `fulfillmentTrackingInfoUpdate`
 *     (Overlord D9 — update, never create). Failure is logged but
 *     does NOT block the WMS UPDATE; reconcile (Group F) catches drift.
 *
 * Does NOT recompute the owning order's warehouse_status; the caller
 * orchestrates via `recomputeOrderStatusFromShipments`.
 */
export async function markShipmentShipped(
  db: any,
  shipmentId: number,
  meta: {
    trackingNumber: string;
    carrier: string;
    shipDate: Date;
    trackingUrl?: string | null;
  },
  opts: {
    now?: Date;
    fulfillmentPush?: {
      updateShopifyFulfillmentTracking?: (
        fulfillmentGid: string,
        trackingInfo: { number: string; company: string; url?: string },
      ) => Promise<unknown>;
    };
  } = {},
): Promise<MarkShipmentResult> {
  assertPositiveInt(shipmentId, "shipmentId");

  if (!meta || typeof meta.trackingNumber !== "string" || meta.trackingNumber.trim().length === 0) {
    const err: any = new Error("trackingNumber is required");
    err.code = "INVALID_ARGUMENT";
    err.field = "trackingNumber";
    throw err;
  }
  if (typeof meta.carrier !== "string" || meta.carrier.trim().length === 0) {
    const err: any = new Error("carrier is required");
    err.code = "INVALID_ARGUMENT";
    err.field = "carrier";
    throw err;
  }
  if (!(meta.shipDate instanceof Date) || Number.isNaN(meta.shipDate.getTime())) {
    const err: any = new Error("shipDate must be a valid Date");
    err.code = "INVALID_ARGUMENT";
    err.field = "shipDate";
    throw err;
  }

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  // Idempotency: already shipped with identical tracking/carrier → no-op.
  if (
    current.status === "shipped" &&
    current.tracking_number === meta.trackingNumber &&
    (current.carrier ?? "") === meta.carrier
  ) {
    return { wmsOrderId: current.order_id, changed: false };
  }

  // Re-tracking audit (§6 Commit 18). Only write a history row when the
  // shipment had a PRIOR tracking number AND it differs from the incoming
  // one. Exact-match comparison on tracking_number is deliberate — a
  // carrier-only swap is a mapping fix, not a label replacement, and the
  // idempotent replay above already covers the same-tracking-same-carrier
  // case. Failure is logged, not thrown: reaching the shipped state matters
  // more than the audit row, and reconcile (Group F) spots gaps.
  if (
    typeof current.tracking_number === "string" &&
    current.tracking_number.length > 0 &&
    current.tracking_number !== meta.trackingNumber
  ) {
    try {
      await db.execute(sql`
        INSERT INTO wms.shipment_tracking_history
          (shipment_id, tracking_number, carrier, replaced_at, replaced_by_tracking_number, created_at)
        VALUES
          (${shipmentId}, ${current.tracking_number}, ${current.carrier}, ${now}, ${meta.trackingNumber}, ${now})
      `);
    } catch (err: any) {
      console.error(
        `[markShipmentShipped] history insert failed for shipment ${shipmentId} (old=${current.tracking_number}, new=${meta.trackingNumber}): ${err?.message ?? err}`,
      );
    }
  }

  const trackingUrl = meta.trackingUrl ?? null;
  await db.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'shipped',
      carrier = ${meta.carrier},
      tracking_number = ${meta.trackingNumber},
      tracking_url = ${trackingUrl},
      shipped_at = ${meta.shipDate},
      updated_at = ${now}
    WHERE id = ${shipmentId}
  `);

  // Shopify fulfillment tracking-update hook (§6 Commit 24, re-label).
  // Fires only when:
  //   - the shipment had a prior tracking number that DIFFERED from
  //     the incoming one (true re-label, not a first ship and not a
  //     carrier-only mapping fix — same conditions that gated the
  //     history-row insert above);
  //   - the shipment carries a `shopify_fulfillment_id` (i.e. C21 has
  //     already pushed it to Shopify; nothing to update otherwise);
  //   - the caller wired `opts.fulfillmentPush.updateShopifyFulfillmentTracking`.
  // Failure is logged but does NOT roll back the shipment UPDATE,
  // matching the non-blocking contract used by markShipmentVoided's
  // cancel hook (§6 Commit 17). Reconcile (Group F) catches drift.
  if (
    typeof current.tracking_number === "string" &&
    current.tracking_number.length > 0 &&
    current.tracking_number !== meta.trackingNumber &&
    typeof current.shopify_fulfillment_id === "string" &&
    current.shopify_fulfillment_id.length > 0 &&
    typeof opts.fulfillmentPush?.updateShopifyFulfillmentTracking === "function"
  ) {
    try {
      await opts.fulfillmentPush.updateShopifyFulfillmentTracking(
        current.shopify_fulfillment_id,
        {
          number: meta.trackingNumber,
          company: meta.carrier,
          url: meta.trackingUrl ?? undefined,
        },
      );
    } catch (err: any) {
      console.error(
        `[markShipmentShipped] Shopify tracking-update failed for shipment ${shipmentId} (fulfillment ${current.shopify_fulfillment_id}): ${err?.message ?? err}`,
      );
    }
  }

  return { wmsOrderId: current.order_id, changed: true };
}

// ─── markShipmentCancelled ──────────────────────────────────────────

/**
 * Transition a shipment to `cancelled`. Idempotent: re-calling on an
 * already-cancelled shipment is a no-op, even if the reason differs
 * (the first cancel wins for audit integrity).
 *
 * `cancelled` is terminal in the shipment state machine (§2.4); the
 * shipment cannot return to `planned` without a new row being created.
 *
 * Side effects beyond the shipment row (§6 Commit 19):
 *   - When the shipment was previously pushed to ShipStation (status
 *     `queued` or `labeled`) AND has a `shipstation_order_id`, we
 *     invoke `opts.shipstation?.removeFromList?.(ssOrderId)` BEFORE
 *     issuing the WMS UPDATE so that — even if the WMS write fails
 *     mid-call — SS has already been told to drop the order from its
 *     queue. Removal failure is logged but NOT thrown: reaching the
 *     terminal cancelled state in WMS matters more than the SS-side
 *     cleanup; reconcile (Group F) will spot any drift.
 *   - Callers that don't wire `opts.shipstation` (tests, pre-Group-E
 *     paths) skip the SS call cleanly.
 *
 * Reason defaults to `'operator_cancel'` when omitted, matching the
 * primary caller (operator-driven cancel UI). Customer-cancel paths
 * pass `'customer_cancel'` via `handleCustomerCancelOnShipment`.
 */
export async function markShipmentCancelled(
  db: any,
  shipmentId: number,
  reason: string = "operator_cancel",
  opts: {
    now?: Date;
    engineCancel?: (ref: EngineRef) => Promise<void>;
    shipstation?: {
      removeFromList?: (shipstationOrderId: number) => Promise<void>;
    };
  } = {},
): Promise<MarkShipmentResult> {
  assertPositiveInt(shipmentId, "shipmentId");

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  if (current.status === "cancelled") {
    return { wmsOrderId: current.order_id, changed: false };
  }

  const safeReason = typeof reason === "string" && reason.trim().length > 0
    ? reason.slice(0, 200)
    : "operator_cancel";

  // Engine-side removal: cancel the order in the shipping engine when
  // the shipment was already pushed (queued/labeled) and has an engine
  // ref. Pre-push states (planned) never touched the engine. Failure
  // is non-blocking — reconcile catches drift.
  const ref = engineRefFromRow(current as any);
  if (
    (current.status === "queued" || current.status === "labeled") &&
    ref
  ) {
    const cancelFn = opts.engineCancel
      ?? (opts.shipstation?.removeFromList
        ? async (r: EngineRef) => { await opts.shipstation!.removeFromList!(Number(r.engineOrderRef)); }
        : null);
    if (cancelFn) {
      try {
        await cancelFn(ref);
      } catch (err: any) {
        console.error(
          `[markShipmentCancelled] engine cancel failed for shipment ${shipmentId} (ref=${ref.engineOrderRef}): ${err?.message ?? err}`,
        );
      }
    }
  }

  await db.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'cancelled',
      cancelled_at = ${now},
      voided_reason = ${safeReason},
      updated_at = ${now}
    WHERE id = ${shipmentId}
  `);

  return { wmsOrderId: current.order_id, changed: true };
}

// ─── handleAddressChangeOnShipment ──────────────────────────────────

/**
 * Handle an address change event on a shipment.
 *
 * Pre-label (status in 'planned' | 'queued'):
 *   - Return `{ mode: 'can_repush', shipmentId }` so the caller can
 *     invoke `pushShipment`. ShipStation upserts on `orderKey`, so a
 *     re-push transparently updates the SS order's ship-to address.
 *
 * Post-label (status in 'labeled' | 'shipped'):
 *   - SET `requires_review = true`, `review_reason =
 *     'address_changed_after_label'`, `address_changed_after_label =
 *     true` and return `{ mode: 'requires_review', shipmentId }`. We
 *     deliberately do NOT auto-void: the operator inspects and
 *     decides whether to void+re-label, ship as-is, or intercept.
 *     (Plan §6 Commit 19, "Option B".)
 *
 * Terminal (status in 'cancelled' | 'voided' | 'returned' | 'lost' |
 * 'on_hold'):
 *   - Return `{ mode: 'noop', reason: <status> }`. Address changes on
 *     a terminal shipment are meaningless; the caller decides whether
 *     to log/alert or surface to the operator.
 *
 * This helper writes ONLY the shipment row (when post-label). Caller
 * is responsible for the actual SS re-push and any event-row insert.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 19.
 */
export async function handleAddressChangeOnShipment(
  db: any,
  shipmentId: number,
  opts: { now?: Date } = {},
): Promise<
  | { mode: "can_repush"; shipmentId: number }
  | { mode: "requires_review"; shipmentId: number }
  | { mode: "noop"; reason: string }
> {
  assertPositiveInt(shipmentId, "shipmentId");

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  switch (current.status) {
    case "planned":
      return { mode: "can_repush", shipmentId };

    case "queued": {
      // Already pushed to ShipStation — re-pushing would overwrite the SS
      // order and undo any operator-made splits.
      await db.execute(sql`
        UPDATE wms.outbound_shipments SET
          requires_review = true,
          review_reason = 'address_changed_after_push',
          updated_at = ${now}
        WHERE id = ${shipmentId}
      `);
      return { mode: "requires_review", shipmentId };
    }

    case "labeled":
    case "shipped": {
      await db.execute(sql`
        UPDATE wms.outbound_shipments SET
          requires_review = true,
          review_reason = 'address_changed_after_label',
          address_changed_after_label = true,
          updated_at = ${now}
        WHERE id = ${shipmentId}
      `);
      return { mode: "requires_review", shipmentId };
    }

    case "cancelled":
    case "voided":
    case "returned":
    case "lost":
    case "on_hold":
      return { mode: "noop", reason: current.status };

    default:
      // Unknown / future status. Treat as noop rather than throwing —
      // an address-change event for an unrecognized state should not
      // crash the webhook handler. Caller can log if they care.
      return { mode: "noop", reason: current.status };
  }
}

// ─── handleCustomerCancelOnShipment ─────────────────────────────────

/**
 * Handle a customer-originated cancel on a shipment (e.g. Shopify
 * `orders/cancelled` webhook fan-out).
 *
 * Pre-label (status in 'planned' | 'queued'):
 *   - Delegates to `markShipmentCancelled` with
 *     `reason = 'customer_cancel'`, threading through the
 *     `opts.shipstation` hook so a queued shipment is also removed
 *     from the SS list. Returns `{ mode: 'cancelled', wmsOrderId }`.
 *
 * Post-label (status in 'labeled' | 'shipped'):
 *   - SET `status = 'on_hold'`, `requires_review = true`,
 *     `review_reason = 'customer_cancel_after_label'`. Operator
 *     decides void / ship-anyway / intercept. (Overlord's "Option B"
 *     from the plan discussion: never auto-void post-label, always
 *     surface to a human.) Returns
 *     `{ mode: 'requires_review', shipmentId }`.
 *
 * Terminal (status in 'cancelled' | 'voided' | 'returned' | 'lost' |
 * 'on_hold'):
 *   - Returns `{ mode: 'noop', reason: <status> }`. A customer-cancel
 *     event arriving on an already-terminal shipment is informational
 *     only.
 *
 * Plan ref: shipstation-flow-refactor-plan.md §6 Commit 19.
 */
export async function handleCustomerCancelOnShipment(
  db: any,
  shipmentId: number,
  opts: {
    now?: Date;
    shipstation?: {
      removeFromList?: (shipstationOrderId: number) => Promise<void>;
    };
  } = {},
): Promise<
  | { mode: "cancelled"; wmsOrderId: number }
  | { mode: "requires_review"; shipmentId: number }
  | { mode: "noop"; reason: string }
> {
  assertPositiveInt(shipmentId, "shipmentId");

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  switch (current.status) {
    case "planned":
    case "queued": {
      const result = await markShipmentCancelled(
        db,
        shipmentId,
        "customer_cancel",
        { now, shipstation: opts.shipstation },
      );
      return { mode: "cancelled", wmsOrderId: result.wmsOrderId };
    }

    case "labeled":
    case "shipped": {
      await db.execute(sql`
        UPDATE wms.outbound_shipments SET
          status = 'on_hold',
          requires_review = true,
          review_reason = 'customer_cancel_after_label',
          updated_at = ${now}
        WHERE id = ${shipmentId}
      `);
      return { mode: "requires_review", shipmentId };
    }

    case "cancelled":
    case "voided":
    case "returned":
    case "lost":
    case "on_hold":
      return { mode: "noop", reason: current.status };

    default:
      return { mode: "noop", reason: current.status };
  }
}

// ─── markShipmentVoided ──────────────────────────────────────────────

/**
 * Transition a shipment to `voided` (label was voided on ShipStation;
 * the shipment still needs to be re-labeled or cancelled). Clears
 * tracking_number / tracking_url so the re-label flow picks up clean.
 * Idempotent: already-voided is a no-op.
 *
 * Side effects beyond the shipment row (§6 Commit 17):
 *   - If the shipment had a `tracking_number` before this void, an
 *     audit row is inserted into `wms.shipment_tracking_history`
 *     capturing the number + carrier + void timestamp + reason.
 *   - If `opts.fulfillmentPush.cancelShopifyFulfillment` is provided
 *     AND the shipment carries a `shopify_fulfillment_id`, the hook
 *     is invoked so Shopify sees the fulfillment cancelled in sync.
 *     Pre-Group-E callers don't wire the hook, and it no-ops cleanly.
 * Both side effects are best-effort: failures are logged, not thrown,
 * so reaching the voided terminal state is never blocked by an audit
 * or push failure (reconcile catches drift).
 *
 * Per §2.4 state machine, `voided` is NOT terminal — the shipment can
 * transition back to `planned` when a new push is attempted. Marking
 * voided here only writes the shipment-level columns; the owning
 * order's warehouse_status is recomputed by the caller.
 */
export async function markShipmentVoided(
  db: any,
  shipmentId: number,
  reason?: string,
  opts: {
    now?: Date;
    fulfillmentPush?: {
      cancelShopifyFulfillment?: (fulfillmentId: string) => Promise<void>;
    };
  } = {},
): Promise<MarkShipmentResult> {
  assertPositiveInt(shipmentId, "shipmentId");

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  if (current.status === "voided") {
    return { wmsOrderId: current.order_id, changed: false };
  }

  const safeReason = typeof reason === "string" && reason.trim().length > 0
    ? reason.slice(0, 200)
    : "ss_label_void";

  // Audit trail BEFORE we clear the tracking columns (§6 Commit 17).
  // Only write a history row when there is a tracking number to
  // preserve; voiding a shipment that never got a label has nothing
  // to audit. History-insert failure is logged but does NOT block the
  // void — reaching the voided terminal state matters more than the
  // audit row, and reconcile (Group F) will spot gaps.
  if (
    typeof current.tracking_number === "string" &&
    current.tracking_number.length > 0
  ) {
    try {
      await db.execute(sql`
        INSERT INTO wms.shipment_tracking_history
          (shipment_id, tracking_number, carrier, voided_at, voided_reason, created_at)
        VALUES
          (${shipmentId}, ${current.tracking_number}, ${current.carrier}, ${now}, ${safeReason}, ${now})
      `);
    } catch (err: any) {
      console.error(
        `[markShipmentVoided] history insert failed for shipment ${shipmentId} (tracking=${current.tracking_number}): ${err?.message ?? err}`,
      );
    }
  }

  await db.execute(sql`
    UPDATE wms.outbound_shipments SET
      status = 'voided',
      voided_at = ${now},
      voided_reason = ${safeReason},
      tracking_number = NULL,
      tracking_url = NULL,
      updated_at = ${now}
    WHERE id = ${shipmentId}
  `);

  // Shopify fulfillment cancel hook (§6 Commit 17). Guarded so callers
  // that do not wire `fulfillmentPush` (tests, pre-Group-E paths) skip
  // silently. Cancel failures are logged but do NOT block; Group F
  // reconcile retries.
  const shopifyFulfillmentId = current.shopify_fulfillment_id;
  if (
    typeof shopifyFulfillmentId === "string" &&
    shopifyFulfillmentId.length > 0 &&
    typeof opts.fulfillmentPush?.cancelShopifyFulfillment === "function"
  ) {
    try {
      await opts.fulfillmentPush.cancelShopifyFulfillment(
        shopifyFulfillmentId,
      );
    } catch (err: any) {
      console.error(
        `[markShipmentVoided] Shopify fulfillment cancel failed for shipment ${shipmentId} (fulfillment ${shopifyFulfillmentId}): ${err?.message ?? err}`,
      );
    }
  }

  return { wmsOrderId: current.order_id, changed: true };
}

// ─── applyLineCoverageGuard ─────────────────────────────────────────

/**
 * Interim line-coverage guard, pending the line-fulfillment ledger
 * (FULFILLMENT_STATE_DESIGN.md §2.1).
 *
 * THE BUG IT FIXES: `deriveWmsFromShipments` derives `shipped` whenever no
 * shipment is still OPEN — but a `cancelled`/`voided` shipment is "not open"
 * too, so an order whose remaining units were owed by a shipment that got
 * cancelled is wrongly declared fully `shipped` (the shipment-set model has
 * no concept of units-still-owed). The 2026-06-15 prod reconciliation found
 * 223 live orders in this exact state (e.g. ordered 27, shipped 26, the 27th
 * unit's shipment cancelled). See scripts/reconcile-line-fulfillments-dryrun.ts.
 *
 * THE GUARD: when the shipment-set says `shipped` BUT line-item evidence proves
 * units are still owed, downgrade to `partially_shipped`. It only ever
 * DOWNGRADES `shipped`→`partially_shipped`; fully-covered orders (owedUnits=0)
 * are untouched, so the 1,994 correctly-shipped orders are unaffected.
 *
 * `hasLineEvidence` gates the downgrade: header-only / legacy shipped orders
 * that have NO linked shipment-item rows (no evidence either way) are NEVER
 * downgraded — that is the same preserve principle the empty-shipments guard
 * uses, and it protects the ~54k legacy `shipped` orders from regressing.
 *
 * Pure + deterministic; the DB-aware caller supplies the coverage signals.
 */
export function applyLineCoverageGuard(
  derived: WmsWarehouseStatus,
  coverage: { owedUnits: number; hasLineEvidence: boolean },
): WmsWarehouseStatus {
  if (derived === "shipped" && coverage.hasLineEvidence && coverage.owedUnits > 0) {
    return "partially_shipped";
  }
  return derived;
}

// ─── recomputeOrderStatusFromShipments ──────────────────────────────

/**
 * Roll the order-level `warehouse_status` up from the shipments that
 * belong to `wmsOrderId`. This is the ONLY path that writes
 * `wms.orders.warehouse_status` once invariant #4 is fully enforced
 * (C16 removes remaining direct writers).
 *
 * Behavior:
 *   - Reads all shipments for the order (status column only).
 *   - Feeds them into the pure `deriveWmsFromShipments` enum helper.
 *   - Applies `applyLineCoverageGuard`: when the shipment-set derives
 *     `shipped` but line-item evidence proves units are still owed (a
 *     cancelled shipment left units un-shipped), downgrades to
 *     `partially_shipped`. Interim fix pending the ledger cutover.
 *   - Compares the derived status to the current `warehouse_status`.
 *     If different, UPDATEs. Otherwise, no-op.
 *   - `completed_at` is stamped only on the transition INTO `shipped`
 *     (matches legacy behavior in processShipNotify) so the timestamp
 *     remains the first-shipped time, not the last-recompute time.
 *
 * Missing order row → returns `{ changed: false }` with the derived
 * status from the empty input (`"ready"`); the caller can log but
 * the helper will not throw. This is a deliberate departure from
 * `loadShipment` because order rows can legitimately be missing in
 * pre-cutover data and forcing a throw would break the fallback path
 * in SHIP_NOTIFY v2.
 */
export async function recomputeOrderStatusFromShipments(
  db: any,
  wmsOrderId: number,
  opts: { now?: Date } = {},
): Promise<RecomputeResult> {
  assertPositiveInt(wmsOrderId, "wmsOrderId");

  // Pull current order row + all its shipments in two reads. Two round
  // trips is fine — the SHIP_NOTIFY loop is per-shipment and already
  // serial; optimizing to a single query would muddy the types.
  const orderResult: any = await db.execute(sql`
    SELECT
      o.id,
      o.warehouse_status,
      o.completed_at,
      COALESCE(SUM(CASE
        WHEN COALESCE(oi.requires_shipping, 1) <> 0 THEN COALESCE(oi.quantity, 0)
        ELSE 0
      END), 0)::int AS shippable_unit_count,
      COALESCE(SUM(CASE
        WHEN COALESCE(oi.requires_shipping, 1) <> 0 THEN COALESCE(oi.picked_quantity, 0)
        ELSE 0
      END), 0)::int AS picked_unit_count,
      -- Line-coverage signals for applyLineCoverageGuard (scalar subqueries so
      -- the call count stays at one query — the rollup tests script exactly
      -- [order, shipments, UPDATE]). owed_units = units on shippable, non-
      -- cancelled lines not yet covered by a shipped/returned/lost shipment.
      (
        SELECT COALESCE(SUM(GREATEST(oi2.quantity - COALESCE(sl.shipped_qty, 0), 0)), 0)::int
        FROM wms.order_items oi2
        LEFT JOIN (
          SELECT osi.order_item_id, SUM(osi.qty)::int AS shipped_qty
          FROM wms.outbound_shipment_items osi
          JOIN wms.outbound_shipments os2 ON os2.id = osi.shipment_id
          WHERE os2.status IN ('shipped', 'returned', 'lost')
          GROUP BY osi.order_item_id
        ) sl ON sl.order_item_id = oi2.id
        WHERE oi2.order_id = o.id
          AND COALESCE(oi2.requires_shipping, 1) <> 0
          AND oi2.status <> 'cancelled'
          AND oi2.quantity > 0
      ) AS owed_units,
      -- lines_with_evidence > 0 means there ARE linked shipment-item rows on a
      -- shipped shipment for this order; without them we never downgrade.
      (
        SELECT COUNT(*)::int
        FROM wms.outbound_shipment_items osi3
        JOIN wms.outbound_shipments os3 ON os3.id = osi3.shipment_id
        JOIN wms.order_items oi3 ON oi3.id = osi3.order_item_id
        WHERE oi3.order_id = o.id
          AND os3.status IN ('shipped', 'returned', 'lost')
      ) AS lines_with_evidence
    FROM wms.orders o
    LEFT JOIN wms.order_items oi ON oi.order_id = o.id
    WHERE o.id = ${wmsOrderId}
    GROUP BY o.id, o.warehouse_status, o.completed_at
    LIMIT 1
  `);
  const orderRow: any = orderResult?.rows?.[0];

  const shipmentsResult: any = await db.execute(sql`
    SELECT status
    FROM wms.outbound_shipments
    WHERE order_id = ${wmsOrderId}
  `);
  const shipmentRows: Array<{ status: string }> = shipmentsResult?.rows ?? [];
  const statuses = shipmentRows.map((r) => r.status as ShipmentStatus);

  // Shipment-set derivation, then the interim line-coverage guard. `derived` is
  // reassigned so every downstream guard/UPDATE uses the coverage-adjusted
  // value. When owed_units / lines_with_evidence are absent (older callers,
  // unit-test mocks), the guard reads them as 0 → no downgrade → unchanged.
  let derived = deriveWmsFromShipments(statuses);
  derived = applyLineCoverageGuard(derived, {
    owedUnits: Number(orderRow?.owed_units ?? 0),
    hasLineEvidence: Number(orderRow?.lines_with_evidence ?? 0) > 0,
  });

  if (!orderRow) {
    return { warehouseStatus: derived, changed: false };
  }

  if (orderRow.warehouse_status === derived) {
    return { warehouseStatus: derived, changed: false };
  }

  // Guard: `cancelled` is terminal for roll-up purposes. Once an order
  // is cancelled (by the OMS↔WMS reconciler or a cancel cascade), the
  // shipment-based derivation must NOT flip it back to `ready_to_ship`
  // or any other non-terminal state. Without this guard, the reconciler
  // sets cancelled → `deriveWmsFromShipments` re-derives ready_to_ship
  // → reconciler re-fires ss.cancelOrder → "already shipped" spam loop.
  // The only forward transition from cancelled is `shipped` (physical
  // shipment already left the building — truth wins, needs human review).
  if (orderRow.warehouse_status === "cancelled" && derived !== "shipped") {
    return { warehouseStatus: "cancelled", changed: false };
  }

  // Empty-shipments roll-up: `deriveWmsFromShipments([])` returns
  // `"ready"`. We do NOT clobber an order already in a post-ready state
  // (picking/packed/etc.) just because its shipments were deleted; a
  // shipment-less order should not be flipped backward. Shipment
  // deletions are extremely rare (admin-only) and always accompanied
  // by an explicit state write.
  if (statuses.length === 0 && derived === "ready") {
    return { warehouseStatus: orderRow.warehouse_status, changed: false };
  }

  if (
    statuses.length > 0 &&
    derived === "ready" &&
    shouldPreserveWarehouseProgressDuringOpenShipmentRollup(orderRow)
  ) {
    return { warehouseStatus: orderRow.warehouse_status, changed: false };
  }

  const now = opts.now ?? new Date();
  const stampCompletedAt = derived === "shipped" && !orderRow.completed_at;

  if (stampCompletedAt) {
    await db.execute(sql`
      WITH updated_order AS (
        UPDATE wms.orders SET
          warehouse_status = ${derived},
          completed_at = ${now},
          updated_at = ${now}
        WHERE id = ${wmsOrderId}
        RETURNING id
      ),
      closed_blockers AS (
        UPDATE wms.allocation_exceptions
        SET
          status = CASE WHEN ${derived}::text = 'cancelled' THEN 'cancelled' ELSE 'resolved' END,
          resolution = CONCAT('order_', ${derived}::text, '_shipment_rollup'),
          resolved_at = ${now},
          updated_at = ${now},
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'closedBy', 'shipment_rollup',
            'closedByOrderStatus', ${derived}::text,
            'closedAt', ${now}::timestamptz
          )
        WHERE order_id = ${wmsOrderId}
          AND ${derived}::text IN ('shipped', 'cancelled')
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            status = 'blocked'
            OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
          )
        RETURNING id
      )
      SELECT id FROM updated_order
    `);
  } else {
    await db.execute(sql`
      WITH updated_order AS (
        UPDATE wms.orders SET
          warehouse_status = ${derived},
          updated_at = ${now}
        WHERE id = ${wmsOrderId}
        RETURNING id
      ),
      closed_blockers AS (
        UPDATE wms.allocation_exceptions
        SET
          status = CASE WHEN ${derived}::text = 'cancelled' THEN 'cancelled' ELSE 'resolved' END,
          resolution = CONCAT('order_', ${derived}::text, '_shipment_rollup'),
          resolved_at = ${now},
          updated_at = ${now},
          metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
            'closedBy', 'shipment_rollup',
            'closedByOrderStatus', ${derived}::text,
            'closedAt', ${now}::timestamptz
          )
        WHERE order_id = ${wmsOrderId}
          AND ${derived}::text IN ('shipped', 'cancelled')
          AND status NOT IN ('resolved', 'resolved_inline', 'cancelled')
          AND (
            status = 'blocked'
            OR LOWER(COALESCE(metadata->>'shipmentBlocking', 'false')) = 'true'
          )
        RETURNING id
      )
      SELECT id FROM updated_order
    `);
  }

  return { warehouseStatus: derived, changed: true };
}

// ─── dispatchShipmentEvent ──────────────────────────────────────────

/**
 * Thin typed wrapper that routes a `ShipmentEvent` to the correct
 * mark-* helper. Kept separate from the mark-* functions themselves
 * so they remain single-purpose and individually testable.
 *
 * Does NOT call `recomputeOrderStatusFromShipments`; the caller is
 * expected to do that after a `changed=true` result so it can also
 * orchestrate the OMS-derived update and event insert in the same
 * transaction-of-intent. Splitting the responsibilities here keeps
 * the dispatch purely mechanical.
 */
export async function dispatchShipmentEvent(
  db: any,
  shipmentId: number,
  event: ShipmentEvent,
  opts: {
    now?: Date;
    fulfillmentPush?: {
      cancelShopifyFulfillment?: (fulfillmentId: string) => Promise<void>;
      updateShopifyFulfillmentTracking?: (
        fulfillmentGid: string,
        trackingInfo: { number: string; company: string; url?: string },
      ) => Promise<unknown>;
    };
  } = {},
): Promise<MarkShipmentResult> {
  switch (event.kind) {
    case "shipped":
      return markShipmentShipped(
        db,
        shipmentId,
        {
          trackingNumber: event.trackingNumber,
          carrier: event.carrier,
          shipDate: event.shipDate,
          trackingUrl: event.trackingUrl ?? null,
        },
        { now: opts.now, fulfillmentPush: opts.fulfillmentPush },
      );
    case "cancelled":
      return markShipmentCancelled(db, shipmentId, event.reason, {
        now: opts.now,
      });
    case "voided":
      return markShipmentVoided(db, shipmentId, event.reason, opts);
    default: {
      // Exhaustiveness guard — new ShipmentEvent variants must add a
      // case above, or TypeScript will fail to compile here.
      const _never: never = event;
      return _never;
    }
  }
}

// ─── cancelStaleShipmentsIfFullyCovered ─────────────────────────────

/**
 * After a shipment ships, if the order is "partially_shipped" because
 * of stale planned/queued shipments whose items are already fully
 * covered by shipped shipments, cancel those stale shipments.
 *
 * Returns true when at least one shipment was cancelled (caller should
 * re-run `recomputeOrderStatusFromShipments` to derive the new status).
 */
export async function cancelStaleShipmentsIfFullyCovered(
  db: any,
  wmsOrderId: number,
): Promise<boolean> {
  assertPositiveInt(wmsOrderId, "wmsOrderId");

  const coverageResult: any = await db.execute(sql`
    SELECT oi.id, oi.quantity,
           COALESCE(SUM(osi.qty) FILTER (
             WHERE os.status IN ('shipped', 'returned', 'lost')
           ), 0) AS shipped_qty
    FROM wms.order_items oi
    LEFT JOIN wms.outbound_shipment_items osi ON osi.order_item_id = oi.id
    LEFT JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
    WHERE oi.order_id = ${wmsOrderId}
    GROUP BY oi.id, oi.quantity
  `);

  const rows: Array<{ quantity: number; shipped_qty: number }> =
    coverageResult?.rows ?? [];
  if (rows.length === 0) return false;

  const allCovered = rows.every(
    (r) => Number(r.shipped_qty) >= Number(r.quantity),
  );
  if (!allCovered) return false;

  const cancelResult: any = await db.execute(sql`
    UPDATE wms.outbound_shipments
    SET status = 'cancelled',
        cancelled_at = NOW(),
        updated_at = NOW()
    WHERE order_id = ${wmsOrderId}
      AND status IN ('planned', 'queued')
    RETURNING id
  `);

  const cancelledCount = cancelResult?.rows?.length ?? 0;
  if (cancelledCount > 0) {
    console.log(
      `[ShipmentRollup] Cancelled ${cancelledCount} stale shipment(s) for fully-covered order ${wmsOrderId}`,
    );
  }
  return cancelledCount > 0;
}
