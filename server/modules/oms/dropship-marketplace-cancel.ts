import { sql } from "drizzle-orm";
import { logger as platformLogger } from "../../platform/observability/logger";
import { cancelWmsOrderAndRelease, type ReservationReleaser } from "../orders/cancel-wms-order";
import { handleCustomerCancelOnShipment } from "../orders/shipment-rollup";
import { engineRefFromRow } from "../shipping/adapters/shipstation.adapter";

/**
 * OMS's published stop for a dropship order the marketplace cancelled after
 * Card Shellz accepted it (plan v4 §7.2, v2 §7.2 "OMS function"). OMS owns the
 * order's lifecycle (BOUNDARIES.md): dropship asks through this function and
 * never touches OMS or WMS rows itself. Built from OMS's own cancel pieces
 * (the shipment cancel and the single WMS-order cancel entry point that
 * cancelOrderCascade and the final-state sync use, oms-webhooks.ts
 * cancelOrderCascade; wms-sync.service.ts cancelExistingWmsOrderForFinalOmsOrder),
 * but it never swallows a failure: any throw reaches the caller, which
 * retries later (every step is idempotent).
 *
 * The shipping engine is asked first (review MS1), for every shipment it may
 * ship from (queued or labeled, with an engine ref), and its answer is part
 * of the verdict: the engine says it shipped, or nothing can prove the engine
 * cancelled it (no engine wired, or the engine has no such order), and the
 * stop changes nothing. Only once the engine proved every cancel are the OMS
 * order, its shipments and its WMS orders cancelled here; the shipment cancel
 * itself then never calls the engine again (that call swallows failures,
 * shipment-rollup.ts markShipmentCancelled).
 *
 * The answer comes from the engine and the rows, so a retry after a partial
 * failure gives the same answer:
 * - `already_shipped`: something left the building, by the rows or the engine
 *   (checked first; nothing is changed: a shipped package cannot be stopped here);
 * - `stopped`: every shipment cancelled or voided with no label bought, and
 *   every WMS order cancelled (or none existed);
 * - `not_stopped`: anything else, a bought label included (its tracking
 *   number survives a cancel, shipment-rollup.ts markShipmentCancelled), so a
 *   person decides before any refund;
 * - `not_found`: no such OMS order.
 */

export type DropshipMarketplaceCancelStopKind = "stopped" | "already_shipped" | "not_stopped" | "not_found";

export interface DropshipMarketplaceCancelShipmentResult {
  id: number;
  status: string;
  hadTracking: boolean;
  /** What the cancel step did to it this call: cancelled, noop (with the reason), or not touched. */
  mode: string;
  reason: string | null;
}

export interface DropshipMarketplaceCancelStopResult {
  kind: DropshipMarketplaceCancelStopKind;
  shipments: DropshipMarketplaceCancelShipmentResult[];
}

/** The shipping engine's answer to a cancel (shipstation.service.ts cancelOrder): it never throws for these states. */
export type DropshipMarketplaceCancelEngineState = "cancelled" | "already_cancelled" | "already_shipped" | "not_found";

export interface DropshipMarketplaceCancelStopDeps {
  /** The drizzle handle OMS and the orders module write through. */
  db: any;
  reservation: ReservationReleaser;
  /**
   * The shipping engine's cancel of one engine order. Absent (no engine wired
   * in this process), a shipment the engine may ship cannot be proven
   * stopped: the stop changes nothing and answers not_stopped.
   */
  engine?: { cancelOrder(engineOrderRef: number): Promise<{ state: DropshipMarketplaceCancelEngineState }> };
  clock: () => Date;
}

/** What the caller passes: the OMS order, and the dropship intake that asks (written on the OMS event, CLAUDE.md §10). */
export interface DropshipMarketplaceCancelStopInput { omsOrderId: number; intakeId?: number }

/** The marker on the OMS event this stop writes, so it is written once per order. */
export const DROPSHIP_MARKETPLACE_CANCEL_EVENT_SOURCE = "dropship_marketplace_cancel";
/** The reason the WMS order and its reservations are cancelled with (audit trail). */
const CANCEL_REASON = "dropship_marketplace_cancel";
const SHIPPED_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(["shipped", "returned", "lost"]);
const STOPPED_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(["cancelled", "voided"]);
const SHIPPED_WMS_STATUSES: ReadonlySet<string> = new Set(["shipped", "partially_shipped"]);
/** Shipment statuses the shipping engine may still ship from (they were pushed to it). */
const ENGINE_SHIPMENT_STATUSES: ReadonlySet<string> = new Set(["queued", "labeled"]);
/** The OMS event of the stop's verdict, written once per order and verdict. */
const VERDICT_EVENT_TYPE = "marketplace_cancel_verdict";

export interface MarketplaceCancelVerdictInput {
  wmsOrders: ReadonlyArray<{ id: number; warehouseStatus: string | null }>;
  shipments: ReadonlyArray<{ id: number; status: string; trackingNumber: string | null; shippedAt: Date | null;
    engineOrderRef?: number | null }>;
}

/** The verdict from the rows (pure). */
export function decideMarketplaceCancelVerdict(input: MarketplaceCancelVerdictInput): Exclude<DropshipMarketplaceCancelStopKind, "not_found"> {
  const shipped = input.shipments.some((shipment) => SHIPPED_SHIPMENT_STATUSES.has(shipment.status) || shipment.shippedAt !== null)
    || input.wmsOrders.some((order) => order.warehouseStatus !== null && SHIPPED_WMS_STATUSES.has(order.warehouseStatus));
  if (shipped) return "already_shipped";
  const shipmentsStopped = input.shipments.every((shipment) => STOPPED_SHIPMENT_STATUSES.has(shipment.status) && !hasTracking(shipment.trackingNumber));
  const ordersStopped = input.wmsOrders.every((order) => order.warehouseStatus === "cancelled");
  return shipmentsStopped && ordersStopped ? "stopped" : "not_stopped";
}

export async function stopOrderForMarketplaceCancel(input: DropshipMarketplaceCancelStopInput,
  deps: DropshipMarketplaceCancelStopDeps): Promise<DropshipMarketplaceCancelStopResult> {
  assertOmsOrderId(input.omsOrderId);
  const order = await deps.db.execute(sql`SELECT id, status FROM oms.oms_orders WHERE id = ${input.omsOrderId} LIMIT 1`);
  if (!order?.rows?.[0]) return { kind: "not_found", shipments: [] };

  const before = await loadRows(deps.db, input.omsOrderId);
  const fields = logFields(input, before);
  if (decideMarketplaceCancelVerdict(before) === "already_shipped") {
    platformLogger.info("oms.dropship_marketplace_cancel.stop", { ...fields, outcome: "already_shipped", basis: "rows" });
    return { kind: "already_shipped", shipments: before.shipments.map((shipment) => shipmentResult(shipment, "untouched", null)) };
  }

  // MS1: the engine first. Nothing below runs unless it proved every cancel, so a refund never follows a package it may ship.
  const unproven = await cancelInEngine(input, before, deps);
  if (unproven !== null) {
    const kind = unproven === "already_shipped" ? "already_shipped" : "not_stopped";
    platformLogger.warn("oms.dropship_marketplace_cancel.stop", { ...fields, outcome: kind, basis: "engine", engine_answer: unproven,
      error_code: `OMS_DROPSHIP_MARKETPLACE_CANCEL_ENGINE_${unproven.toUpperCase()}` });
    return { kind, shipments: before.shipments.map((shipment) => shipmentResult(shipment, "untouched", unproven)) };
  }

  const now = deps.clock();
  const flipped = await cancelOmsOrderWithEvent(deps.db, input, now);
  if (flipped !== null) {
    platformLogger.info("oms.dropship_marketplace_cancel.order_cancelled", { ...fields, outcome: "cancelled",
      before: { status: flipped.beforeStatus }, after: { status: "cancelled" } });
  }

  const modes = new Map<number, { mode: string; reason: string | null }>();
  for (const shipment of before.shipments) {
    if (STOPPED_SHIPMENT_STATUSES.has(shipment.status)) continue;
    // No engine hook here: the engine already answered above, and this path would swallow its failure.
    const result = await handleCustomerCancelOnShipment(deps.db, shipment.id, { now });
    modes.set(shipment.id, { mode: result.mode, reason: "reason" in result ? result.reason : null });
  }
  for (const wmsOrder of before.wmsOrders) {
    const outcome = await cancelWmsOrderAndRelease(deps.db, deps.reservation, wmsOrder.id, CANCEL_REASON);
    if (outcome.releaseFailed) throw releaseFailed(input.omsOrderId, wmsOrder.id);
    if (!outcome.transitioned) {
      // Cancelled before (by an earlier attempt or another path): its reservations may still be open if that
      // attempt's release failed. Releasing is order-scoped and idempotent (reservation ledger math, P0.1b).
      const release = await deps.reservation.releaseOrderReservation(wmsOrder.id, CANCEL_REASON, undefined, { disposition: "cancel" });
      if (release.failed.length > 0) throw releaseFailed(input.omsOrderId, wmsOrder.id);
    }
  }

  const after = await loadRows(deps.db, input.omsOrderId);
  const kind = decideMarketplaceCancelVerdict(after);
  await deps.db.execute(sql`INSERT INTO oms.oms_order_events (order_id, event_type, details)
    SELECT ${input.omsOrderId}, ${VERDICT_EVENT_TYPE}, ${JSON.stringify({
      source: DROPSHIP_MARKETPLACE_CANCEL_EVENT_SOURCE, verdict: kind, decidedAt: now.toISOString(), intakeId: input.intakeId ?? null,
      wmsOrderIds: after.wmsOrders.map((wmsOrder) => wmsOrder.id), shipmentIds: after.shipments.map((shipment) => shipment.id),
    })}::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM oms.oms_order_events e WHERE e.order_id = ${input.omsOrderId}
      AND e.event_type = ${VERDICT_EVENT_TYPE} AND e.details->>'source' = ${DROPSHIP_MARKETPLACE_CANCEL_EVENT_SOURCE}
      AND e.details->>'verdict' = ${kind})`);
  platformLogger.info("oms.dropship_marketplace_cancel.stop", { ...logFields(input, after), outcome: kind, basis: "rows" });
  return {
    kind,
    shipments: after.shipments.map((shipment) => {
      const touched = modes.get(shipment.id);
      return shipmentResult(shipment, touched?.mode ?? "untouched", touched?.reason ?? null);
    }),
  };
}

/**
 * Asks the engine to cancel every shipment it may ship from. Null when every
 * cancel is proven (cancelled now or before); otherwise why not: the engine
 * shipped one, has no such order, or is not wired. A thrown failure is a
 * passing one: nothing in OMS or WMS has changed yet, and a retry asks again.
 */
async function cancelInEngine(input: DropshipMarketplaceCancelStopInput, rows: MarketplaceCancelVerdictInput,
  deps: DropshipMarketplaceCancelStopDeps): Promise<"already_shipped" | "not_found" | "engine_not_wired" | null> {
  for (const shipment of rows.shipments) {
    if (!ENGINE_SHIPMENT_STATUSES.has(shipment.status) || !shipment.engineOrderRef) continue;
    if (!deps.engine) return "engine_not_wired";
    let answer: { state: DropshipMarketplaceCancelEngineState };
    try {
      answer = await deps.engine.cancelOrder(shipment.engineOrderRef);
    } catch (error) {
      throw new DropshipMarketplaceCancelStopError("OMS_DROPSHIP_MARKETPLACE_CANCEL_ENGINE_FAILED",
        "The shipping engine did not answer the cancel of a dropship order cancelled on the marketplace.", "transient",
        { omsOrderId: input.omsOrderId, shipmentId: shipment.id, engineOrderRef: shipment.engineOrderRef,
          cause: error instanceof Error ? error.message : String(error) });
    }
    if (answer.state === "already_shipped" || answer.state === "not_found") return answer.state;
  }
  return null;
}

/**
 * The OMS order's status flip and its OMS event in one statement (review
 * ARCH-4), guarded as wms-sync.service.ts reconcileCancellations is: a
 * refunded or already cancelled order is left as is and gets no event from
 * this stop. Null when nothing changed.
 */
async function cancelOmsOrderWithEvent(db: any, input: DropshipMarketplaceCancelStopInput, now: Date): Promise<{ beforeStatus: string } | null> {
  const result = await db.execute(sql`WITH previous AS (
      SELECT id, status FROM oms.oms_orders WHERE id = ${input.omsOrderId} AND status NOT IN ('cancelled', 'refunded') FOR UPDATE),
    flipped AS (
      UPDATE oms.oms_orders o SET status = 'cancelled', cancelled_at = ${now}, updated_at = ${now}
      FROM previous WHERE o.id = previous.id RETURNING o.id, previous.status AS before_status)
    INSERT INTO oms.oms_order_events (order_id, event_type, details)
    SELECT flipped.id, 'cancelled', jsonb_build_object('source', ${DROPSHIP_MARKETPLACE_CANCEL_EVENT_SOURCE}::text,
      'reason', 'marketplace_cancelled_after_acceptance', 'cancelledAt', ${now.toISOString()}::text, 'intakeId', ${input.intakeId ?? null}::integer,
      'before', jsonb_build_object('status', flipped.before_status), 'after', jsonb_build_object('status', 'cancelled'))
    FROM flipped RETURNING (details->'before'->>'status') AS before_status`);
  const row = result?.rows?.[0] as { before_status: string } | undefined;
  return row ? { beforeStatus: row.before_status } : null;
}

function logFields(input: DropshipMarketplaceCancelStopInput, rows: MarketplaceCancelVerdictInput): Record<string, unknown> {
  return { oms_order_id: input.omsOrderId, intake_id: input.intakeId ?? null, wms_order_ids: rows.wmsOrders.map((order) => order.id),
    shipment_ids: rows.shipments.map((shipment) => shipment.id) };
}

/** The port dropship is handed at boot (server/index.ts), with OMS's own handles bound. */
export function createDropshipMarketplaceCancelStop(deps: DropshipMarketplaceCancelStopDeps): {
  stopOrderForMarketplaceCancel(input: DropshipMarketplaceCancelStopInput): Promise<DropshipMarketplaceCancelStopResult>;
} {
  return { stopOrderForMarketplaceCancel: (input) => stopOrderForMarketplaceCancel(input, deps) };
}

async function loadRows(db: any, omsOrderId: number): Promise<MarketplaceCancelVerdictInput> {
  // The WMS orders of an OMS order, as the final-state cancel finds them (wms-sync.service.ts cancelExistingWmsOrderForFinalOmsOrder).
  const orders = await db.execute(sql`SELECT id, warehouse_status FROM wms.orders
    WHERE ((source IN ('oms', 'ebay') AND oms_fulfillment_order_id = ${String(omsOrderId)})
        OR (source = 'shopify' AND source_table_id = ${String(omsOrderId)}))
    ORDER BY id`);
  const wmsOrders = (orders?.rows ?? []).map((row: { id: number | string; warehouse_status: string | null }) => ({
    id: Number(row.id), warehouseStatus: row.warehouse_status,
  }));
  if (wmsOrders.length === 0) return { wmsOrders, shipments: [] };
  const shipments = await db.execute(sql`SELECT id, status, tracking_number, shipped_at, shipping_engine, engine_order_ref,
      shipstation_order_id FROM wms.outbound_shipments
    WHERE order_id IN (${sql.join(wmsOrders.map((wmsOrder: { id: number }) => sql`${wmsOrder.id}`), sql`, `)})
    ORDER BY id`);
  return {
    wmsOrders,
    shipments: (shipments?.rows ?? []).map((row: { id: number | string; status: string; tracking_number: string | null; shipped_at: Date | string | null;
      shipping_engine: string | null; engine_order_ref: string | null; shipstation_order_id: number | string | null }) => ({
      id: Number(row.id), status: row.status, trackingNumber: row.tracking_number,
      shippedAt: row.shipped_at === null ? null : new Date(row.shipped_at),
      engineOrderRef: engineOrderRefOf(row),
    })),
  };
}

/** The engine order a shipment was pushed as (the same ref the shipment cancel uses, shipstation.adapter.ts engineRefFromRow); null when never pushed. */
function engineOrderRefOf(row: { shipping_engine: string | null; engine_order_ref: string | null; shipstation_order_id: number | string | null }): number | null {
  const ref = engineRefFromRow({ shipping_engine: row.shipping_engine, engine_order_ref: row.engine_order_ref,
    shipstation_order_id: row.shipstation_order_id === null ? null : Number(row.shipstation_order_id) });
  const id = ref === null ? NaN : Number(ref.engineOrderRef);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function shipmentResult(shipment: MarketplaceCancelVerdictInput["shipments"][number], mode: string, reason: string | null): DropshipMarketplaceCancelShipmentResult {
  return { id: shipment.id, status: shipment.status, hadTracking: hasTracking(shipment.trackingNumber), mode, reason };
}

function hasTracking(trackingNumber: string | null): boolean {
  return trackingNumber !== null && trackingNumber.trim() !== "";
}

/** A structured failure of the stop (CLAUDE.md §6): the caller branches on `classification`. */
export class DropshipMarketplaceCancelStopError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly classification: "transient" | "fatal",
    readonly context: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DropshipMarketplaceCancelStopError";
  }
}

function assertOmsOrderId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DropshipMarketplaceCancelStopError("OMS_DROPSHIP_MARKETPLACE_CANCEL_INPUT_INVALID", "An OMS order id must be a positive integer.",
      "fatal", { omsOrderId: value });
  }
}

function releaseFailed(omsOrderId: number, wmsOrderId: number): Error {
  return new DropshipMarketplaceCancelStopError("OMS_DROPSHIP_MARKETPLACE_CANCEL_RELEASE_FAILED",
    "Reservations of a dropship order cancelled on the marketplace could not all be released.", "transient", { omsOrderId, wmsOrderId });
}
