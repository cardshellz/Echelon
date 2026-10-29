import { sql } from "drizzle-orm";
import { omsWarehouseCancellationSql } from "../oms/order-merchandise-state.sql";

import { logger } from "../../platform/observability/logger";
import { wmsOmsOrderIdSql } from "../oms/oms-wms-order-link.sql";
import {
  cancelWmsOrderAndRelease,
  completeWmsOrderAndRelease,
  type ReservationReleaser,
} from "./cancel-wms-order";

/**
 * Startup repair for WMS orders whose aggregate status is still active but
 * which have no pending shippable items ("zombies" that sit in the pick queue
 * forever because nothing triggers their status transition).
 *
 * OMS owns the order lifecycle (BOUNDARIES.md). A WMS order with no pending
 * lines is only finished if the OMS agrees nothing more is owed. Until
 * 2026-10, a Shopify fulfillment hold (Global-e) could zero a paid line's
 * authority and cancel its only WMS line; this repair then cancelled the empty
 * order at the next boot (#63275, #63861). So an order whose live OMS order
 * still owes units that no live WMS line carries is skipped and reported, not
 * cancelled or completed. The WMS sync restores such lines when it next
 * reconciles the order.
 */

export const ZOMBIE_REPAIR_REASON = "zombie_data_repair";
export const ZOMBIE_REPAIR_SKIPPED_CODE = "WMS_ZOMBIE_REPAIR_SKIPPED_OMS_STILL_OWES";

/**
 * True when the WMS order (alias contract: the enclosing query aliases
 * wms.orders as `o`) is linked to a live OMS order with a shippable, unfulfilled
 * line whose authority exceeds the non-cancelled quantity materialized for it.
 *
 * Materialized quantity is summed across ALL WMS orders for the line, because
 * a line can be split across partitions; one order's rows alone would
 * under-count and block legitimate completion. OMS finality mirrors
 * WmsSyncService.isFinalOrCancelledOmsOrder plus shipped/fulfilled orders.
 */
export const OMS_STILL_OWES_UNCARRIED_UNITS_FOR_WMS_ORDER_O = sql`
  EXISTS (
    SELECT 1
    FROM oms.oms_orders oo
    JOIN oms.oms_order_lines ol ON ol.order_id = oo.id
    WHERE oo.id = ${wmsOmsOrderIdSql({
      source: sql.raw("o.source"),
      omsFulfillmentOrderId: sql.raw("o.oms_fulfillment_order_id"),
      legacySourceTableId: sql.raw("o.source_table_id"),
    })}
      AND NOT ${omsWarehouseCancellationSql("oo", { legacyFinancialStatuses: ["refunded", "voided"], includeShipped: true })}
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
      AND ol.requires_shipping IS DISTINCT FROM false
      AND COALESCE(ol.fulfillment_status, '') <> 'fulfilled'
      AND COALESCE(ol.authority_fulfillable_quantity, 0) > COALESCE((
        SELECT SUM(wi.quantity)
        FROM wms.order_items wi
        WHERE wi.oms_order_line_id = ol.id
          AND wi.status <> 'cancelled'
      ), 0)
  )
`;

/**
 * True when the WMS order (alias `o`) is linked to an OMS order that the
 * channel has NOT finished: not cancelled (Shopify: real cancelledAt via
 * status='cancelled'), not shipped/fulfilled, not a legacy refund/void stop.
 * #64592 (2026-10-21): an order-edit swap removed the only line, the added
 * line was still being authorized, and this repair cancelled the open order at
 * the next boot. Emptiness is not a cancel signal; only the channel's is.
 */
export const OMS_ORDER_STILL_OPEN_FOR_WMS_ORDER_O = sql`
  EXISTS (
    SELECT 1
    FROM oms.oms_orders oo
    WHERE oo.id = ${wmsOmsOrderIdSql({
      source: sql.raw("o.source"),
      omsFulfillmentOrderId: sql.raw("o.oms_fulfillment_order_id"),
      legacySourceTableId: sql.raw("o.source_table_id"),
    })}
      AND NOT ${omsWarehouseCancellationSql("oo", { legacyFinancialStatuses: ["refunded", "voided"], includeShipped: true })}
      AND COALESCE(oo.fulfillment_status, '') <> 'fulfilled'
  )
`;

export const ZOMBIE_REPAIR_SKIPPED_OPEN_ORDER_CODE = "WMS_ZOMBIE_REPAIR_SKIPPED_OMS_ORDER_OPEN";

export type ZombieTargetStatus = "cancelled" | "completed";
export type ZombieRepairAction = "cancel" | "complete" | "skip_oms_still_owes" | "skip_oms_order_open";

export interface ZombieRepairCandidate {
  wmsOrderId: number;
  orderNumber: string;
  targetStatus: ZombieTargetStatus;
  omsStillOwesUncarriedUnits: boolean;
  /** Linked OMS order exists and the channel has not cancelled or finished it. */
  omsOrderStillOpen: boolean;
}

export interface ZombieRepairSummary {
  transitioned: string[];
  skipped: ZombieRepairCandidate[];
}

interface ZombieRepairDb {
  execute(query: unknown): Promise<{ rows?: unknown[] }>;
}

export function decideZombieRepairAction(
  candidate: Pick<ZombieRepairCandidate, "targetStatus" | "omsStillOwesUncarriedUnits"> & { omsOrderStillOpen?: boolean },
): ZombieRepairAction {
  if (candidate.omsStillOwesUncarriedUnits) return "skip_oms_still_owes";
  // Completing an order whose lines are all done needs no channel signal;
  // cancelling one requires the channel to have cancelled or finished it.
  if (candidate.targetStatus === "cancelled" && candidate.omsOrderStillOpen === true) return "skip_oms_order_open";
  return candidate.targetStatus === "cancelled" ? "cancel" : "complete";
}

/**
 * Candidate selection. `target_status` is unchanged from the original inline
 * repair in server/index.ts: 'cancelled' when every line is cancelled (or
 * there are none), otherwise 'completed'.
 */
const ZOMBIE_CANDIDATES_SQL = sql`
  SELECT o.id, o.order_number,
    CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM wms.order_items ai WHERE ai.order_id = o.id
      ) THEN 'cancelled'
      WHEN EXISTS (
        SELECT 1 FROM wms.order_items ai
        WHERE ai.order_id = o.id
          AND ai.status NOT IN ('cancelled')
      ) THEN 'completed'
      ELSE 'cancelled'
    END AS target_status,
    ${OMS_STILL_OWES_UNCARRIED_UNITS_FOR_WMS_ORDER_O} AS oms_still_owes_uncarried_units,
    ${OMS_ORDER_STILL_OPEN_FOR_WMS_ORDER_O} AS oms_order_still_open
  FROM wms.orders o
  WHERE o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
    AND o.order_edit_operation_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM wms.order_items oi
      WHERE oi.order_id = o.id
        AND COALESCE(oi.requires_shipping, 1) <> 0
        AND COALESCE(oi.quantity, 0) > 0
        AND oi.status NOT IN ('cancelled', 'completed', 'short')
        -- physically picked = not pickable, whatever the label says
        AND COALESCE(oi.picked_quantity, 0) < COALESCE(oi.quantity, 0)
    )
`;

function toCandidate(row: any): ZombieRepairCandidate {
  return {
    wmsOrderId: Number(row.id),
    orderNumber: String(row.order_number ?? row.id),
    targetStatus: row.target_status === "cancelled" ? "cancelled" : "completed",
    omsStillOwesUncarriedUnits: row.oms_still_owes_uncarried_units === true,
    omsOrderStillOpen: row.oms_order_still_open === true,
  };
}

export async function runStartupZombieOrderRepair(deps: {
  db: ZombieRepairDb;
  reservation: ReservationReleaser;
}): Promise<ZombieRepairSummary> {
  const result = await deps.db.execute(ZOMBIE_CANDIDATES_SQL);
  const summary: ZombieRepairSummary = { transitioned: [], skipped: [] };

  for (const row of result.rows ?? []) {
    const candidate = toCandidate(row);
    const action = decideZombieRepairAction(candidate);

    if (action === "skip_oms_still_owes") {
      summary.skipped.push(candidate);
      // ERROR: a paid order has no pickable line. The WMS sync restores the
      // lost line once the OMS line authority is owed again; if it does not,
      // a person must look.
      logger.error("wms_zombie_order_repair", {
        outcome: "skipped",
        error_code: ZOMBIE_REPAIR_SKIPPED_CODE,
        message:
          "WMS order has no pending lines but its live OMS order still owes shippable units; " +
          "not cancelling or completing it.",
        wms_order_id: candidate.wmsOrderId,
        order_number: candidate.orderNumber,
        target_status: candidate.targetStatus,
      });
      continue;
    }

    if (action === "skip_oms_order_open") {
      summary.skipped.push(candidate);
      // WARN: anomaly left untouched. The channel has not cancelled this order
      // (e.g. mid order-edit swap, or an added line awaiting payment); the WMS
      // sync re-materializes its lines when they are authorized.
      logger.warn("wms_zombie_order_repair", {
        outcome: "skipped",
        error_code: ZOMBIE_REPAIR_SKIPPED_OPEN_ORDER_CODE,
        message: "WMS order has no live lines but its channel order is still open; not cancelling it.",
        wms_order_id: candidate.wmsOrderId,
        order_number: candidate.orderNumber,
        target_status: candidate.targetStatus,
      });
      continue;
    }

    // Terminal transitions must release leftover reservations (P0.1c /
    // 'completed'-status fix) — raw transitions here leaked them.
    const outcome = action === "cancel"
      ? await cancelWmsOrderAndRelease(deps.db, deps.reservation, candidate.wmsOrderId, ZOMBIE_REPAIR_REASON, undefined, { requireNoOrderEdit: true })
      : await completeWmsOrderAndRelease(deps.db, deps.reservation, candidate.wmsOrderId, ZOMBIE_REPAIR_REASON, undefined, { requireNoOrderEdit: true });
    if (outcome.transitioned) {
      summary.transitioned.push(`${candidate.orderNumber}→${candidate.targetStatus}`);
    }
  }

  return summary;
}
