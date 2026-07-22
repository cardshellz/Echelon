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
      serviceCode?: string | null;
      carrierCostCents?: number;
      carrierCostSource?: string;
    }
  | { kind: "cancelled"; reason?: string }
  | { kind: "voided"; reason?: string; trackingNumber?: string | null };

// ─── Internals ───────────────────────────────────────────────────────

interface CurrentShipmentRow {
  id: number;
  order_id: number;
  status: string;
  tracking_number: string | null;
  carrier: string | null;
  service_code: string | null;
  tracking_url: string | null;
  carrier_cost_cents: string | number | null;
  carrier_cost_source: string | null;
  carrier_cost_recorded_at: Date | string | null;
  shopify_fulfillment_id: string | null;
  shipped_at: Date | string | null;
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
    SELECT id, order_id, status, tracking_number, carrier, service_code, tracking_url,
           carrier_cost_cents, carrier_cost_source, carrier_cost_recorded_at,
           shopify_fulfillment_id, shipped_at,
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
    serviceCode?: string | null;
    carrierCostCents?: number;
    carrierCostSource?: string;
  },
  opts: {
    now?: Date;
    fulfillmentPush?: {
      reconcileShopifyFulfillment?: (
        shipmentId: number,
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

  const serviceCode = typeof meta.serviceCode === "string" && meta.serviceCode.trim()
    ? meta.serviceCode.trim().slice(0, 100)
    : null;
  const hasCarrierCost = meta.carrierCostCents !== undefined;
  if (hasCarrierCost && (!Number.isSafeInteger(meta.carrierCostCents) || meta.carrierCostCents! <= 0)) {
    const err: any = new Error("carrierCostCents must be a positive integer when provided");
    err.code = "INVALID_ARGUMENT";
    err.field = "carrierCostCents";
    throw err;
  }
  const carrierCostSource = typeof meta.carrierCostSource === "string"
    ? meta.carrierCostSource.trim().slice(0, 40)
    : "";
  if (hasCarrierCost && !carrierCostSource) {
    const err: any = new Error("carrierCostSource is required when carrierCostCents is provided");
    err.code = "INVALID_ARGUMENT";
    err.field = "carrierCostSource";
    throw err;
  }

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  const currentCarrierCostCents = Number(current.carrier_cost_cents ?? 0);
  const serviceMatches = serviceCode === null || current.service_code === serviceCode;
  const carrierCostMatches = !hasCarrierCost || (
    currentCarrierCostCents === meta.carrierCostCents
    && current.carrier_cost_source === carrierCostSource
    && current.carrier_cost_recorded_at != null
  );

  // Idempotency: already shipped with identical tracking/carrier → no-op.
  if (
    current.status === "shipped" &&
    current.tracking_number === meta.trackingNumber &&
    (current.carrier ?? "") === meta.carrier &&
    serviceMatches &&
    carrierCostMatches
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
      service_code = COALESCE(${serviceCode}, service_code),
      tracking_number = ${meta.trackingNumber},
      tracking_url = ${trackingUrl},
      shipped_at = ${meta.shipDate},
      carrier_cost_cents = CASE
        WHEN ${hasCarrierCost} THEN ${meta.carrierCostCents ?? null}
        ELSE carrier_cost_cents
      END,
      carrier_cost_source = CASE
        WHEN ${hasCarrierCost} THEN ${carrierCostSource || null}
        ELSE carrier_cost_source
      END,
      carrier_cost_recorded_at = CASE
        WHEN ${hasCarrierCost} THEN ${now}
        ELSE carrier_cost_recorded_at
      END,
      updated_at = ${now}
    WHERE id = ${shipmentId}
  `);

  // Shopify fulfillment convergence (void→re-ship heal; supersedes the
  // §6 Commit 24 re-label-only hook). Fires whenever incoming tracking
  // differs from the row. The fulfillment
  // service resolves every known Shopify handle from the legacy column and
  // append-only event evidence; a shipment without handles is an idempotent
  // no-op and remains owned by the create path.
  // We deliberately do NOT require `current.tracking_number` to be
  // non-empty: a label void nulls it (markShipmentVoided) before the
  // re-ship, and that null-out is exactly why the old re-label gate
  // silently missed void→re-ship and left channel tracking stale
  // (CHANNEL_TRACKING_STALE / #58910). `null !== meta.trackingNumber`
  // is true, so the void→re-ship now converges; an unchanged tracking
  // (e.g. carrier-only mapping fix) still no-ops.
  //
  // `reconcileShopifyFulfillment` is idempotent (no-op when Shopify
  // already carries this tracking) and self-healing (updates an open
  // fulfillment, recreates a cancelled one). Failure is logged but does
  // NOT roll back the shipment UPDATE, matching the non-blocking
  // contract used by markShipmentVoided's cancel hook (§6 Commit 17);
  // reconcile + the CHANNEL_TRACKING_STALE detector catch drift.
  if (
    current.tracking_number !== meta.trackingNumber &&
    typeof opts.fulfillmentPush?.reconcileShopifyFulfillment === "function"
  ) {
    try {
      await opts.fulfillmentPush.reconcileShopifyFulfillment(shipmentId, {
        number: meta.trackingNumber,
        company: meta.carrier,
        url: meta.trackingUrl ?? undefined,
      });
    } catch (err: any) {
      console.error(
        `[markShipmentShipped] Shopify fulfillment convergence failed for shipment ${shipmentId}: ${err?.message ?? err}`,
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
    /**
     * Only for a locally stale aggregate row whose provider order is proven
     * to have already shipped through a terminal sibling row.
     */
    skipEngineCancel?: boolean;
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

  // A shipped shipment is TERMINAL. Once it physically left the building
  // (status 'shipped', or 'returned'/'lost' which both presuppose a ship), it
  // must NEVER be cancelled — the only valid post-ship transitions are
  // returned/lost (recorded as their own events). Refuse here rather than
  // throw so reconcile/cleanup callers log and move on instead of crashing.
  // This is the single-writer enforcement of the invariant whose absence let a
  // boot-time dedup cancel 600+ already-shipped split shipments (2026-06-15).
  if (
    current.status === "shipped" ||
    current.status === "returned" ||
    current.status === "lost"
  ) {
    console.warn(
      `[markShipmentCancelled] refused: shipment ${shipmentId} is '${current.status}' (terminal-shipped); not cancelling`,
    );
    return { wmsOrderId: current.order_id, changed: false };
  }

  const safeReason = typeof reason === "string" && reason.trim().length > 0
    ? reason.slice(0, 200)
    : "operator_cancel";

  // Engine-side removal: cancel the order in the shipping engine when the
  // shipment was already pushed (queued/labeled) and has an engine ref.
  // Pre-push states (planned) never touched the engine. Idempotent when SS
  // is already cancelled. Failure is non-blocking — reconcile catches drift.
  const ref = engineRefFromRow(current as any);
  if (
    !opts.skipEngineCancel &&
    (current.status === "queued" ||
      current.status === "labeled") &&
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
 * Terminal (status in 'cancelled' | 'voided' | 'returned' | 'lost'):
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

    case "queued":
      // Pushed to ShipStation but NO label yet — re-push so the new address flows
      // straight through. ShipStation upserts on orderKey and transparently updates
      // the ship-to (same as the 'planned' path). An address change is normal business,
      // not an error to review. (Restores the documented pre-label behavior; this case
      // had drifted to requires_review out of an over-cautious split-clobber concern.)
      return { mode: "can_repush", shipmentId };

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
 * Pre-ship (status in 'planned' | 'queued' | 'labeled'):
 *   - Delegates to `markShipmentCancelled` with
 *     `reason = 'customer_cancel'`, threading through the
 *     `opts.shipstation` hook so a queued/labeled shipment is also
 *     cancelled in the SS list (#668). A row that already carries
 *     `shipped_at` is treated as terminal and left alone. Returns
 *     `{ mode: 'cancelled', wmsOrderId }`.
 *
 * Terminal (status in 'shipped' | 'cancelled' | 'voided' | 'returned' |
 * 'lost'):
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

  // Sales-channel cancel model: cancel the shipment UNLESS it already shipped.
  // A package that physically left can't be un-shipped — only a refund applies
  // (and per the physical-fact rule, the refund must not regress status). So
  // every NOT-yet-shipped state cancels (and a refund hold defers to the
  // channel cancel); shipped/returned/lost stay put.
  switch (current.status) {
    case "planned":
    case "queued":
    case "labeled": {
      // Defensive: a pre-ship row that already carries shipped_at (a legacy
      // regressed state) is treated as terminal — do not regress it.
      if (current.shipped_at != null) {
        return { mode: "noop", reason: "already_shipped" };
      }
      // markShipmentCancelled also cancels the SS order / drops the label for
      // queued/labeled rows that carry an engine ref.
      const result = await markShipmentCancelled(
        db,
        shipmentId,
        "customer_cancel",
        { now, shipstation: opts.shipstation },
      );
      return { mode: "cancelled", wmsOrderId: result.wmsOrderId };
    }

    case "shipped":
    case "returned":
    case "lost":
      // Terminal physical fact: already shipped — do not regress status.
      return { mode: "noop", reason: "already_shipped" };

    case "cancelled":
    case "voided":
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
    /**
     * Tracking number of the label THIS void targets (from the engine's
     * void event). When provided, the void only takes effect if it matches
     * the shipment's current label of record — see the guard below.
     */
    voidedTrackingNumber?: string | null;
    fulfillmentPush?: {
      cancelShopifyFulfillment?: (fulfillmentId: string) => Promise<void>;
      cancelShopifyFulfillmentsForShipment?: (shipmentId: number) => Promise<unknown>;
    };
  } = {},
): Promise<MarkShipmentResult> {
  assertPositiveInt(shipmentId, "shipmentId");

  const current = await loadShipment(db, shipmentId);
  const now = opts.now ?? new Date();

  if (current.status === "voided") {
    return { wmsOrderId: current.order_id, changed: false };
  }

  // Label-of-record guard. A void cancels the physical shipment ONLY when it
  // targets the shipment's CURRENT label. ShipStation keys events to a SS
  // *order*, which can accumulate multiple labels over a void → re-label
  // cycle. After an old label is voided and the shipment re-ships on a NEW
  // label, SS (or the sweeper re-reading that order) can re-deliver the OLD
  // label's void. Applying it blindly wipes the live tracking and cancels a
  // valid Shopify fulfillment — exactly what stranded order #58984 / shipment
  // 3649 (shipped on 1Z…03752644, then re-voided by the dead 1Z…02547145).
  // If the void's tracking differs from the current label of record, it is a
  // stale void of a superseded label: ignore it; the current label stands.
  const voidedTrackingNumber = opts.voidedTrackingNumber;
  if (
    typeof voidedTrackingNumber === "string" &&
    voidedTrackingNumber.length > 0 &&
    typeof current.tracking_number === "string" &&
    current.tracking_number.length > 0 &&
    voidedTrackingNumber !== current.tracking_number
  ) {
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
  if (typeof opts.fulfillmentPush?.cancelShopifyFulfillmentsForShipment === "function") {
    try {
      await opts.fulfillmentPush.cancelShopifyFulfillmentsForShipment(shipmentId);
    } catch (err: any) {
      console.error(
        `[markShipmentVoided] Shopify fulfillment cancel failed for shipment ${shipmentId}: ${err?.message ?? err}`,
      );
    }
  } else if (
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
      END), 0)::int AS picked_unit_count
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
      AND COALESCE(shipment_purpose, 'customer_fulfillment') = 'customer_fulfillment'
  `);
  const shipmentRows: Array<{ status: string }> = shipmentsResult?.rows ?? [];
  const statuses = shipmentRows.map((r) => r.status as ShipmentStatus);

  const derived = deriveWmsFromShipments(statuses);

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
      cancelShopifyFulfillmentsForShipment?: (shipmentId: number) => Promise<unknown>;
      reconcileShopifyFulfillment?: (
        shipmentId: number,
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
          serviceCode: event.serviceCode ?? null,
          carrierCostCents: event.carrierCostCents,
          carrierCostSource: event.carrierCostSource,
        },
        { now: opts.now, fulfillmentPush: opts.fulfillmentPush },
      );
    case "cancelled":
      return markShipmentCancelled(db, shipmentId, event.reason, {
        now: opts.now,
      });
    case "voided":
      return markShipmentVoided(db, shipmentId, event.reason, {
        ...opts,
        voidedTrackingNumber: event.trackingNumber ?? null,
      });
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
      AND shipped_at IS NULL
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
