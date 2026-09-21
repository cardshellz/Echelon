import { sql } from "drizzle-orm";

import {
  cancelWmsOrderAndRelease,
  completeWmsOrderAndRelease,
  type ReservationReleaser,
} from "./cancel-wms-order";
import { LIVE_OMS_DEMAND_NOT_CARRIED_BY_WMS_ORDER_O } from "./wms-terminal-transition-guard";

/**
 * Startup repair for WMS orders whose aggregate status is still active but
 * which have no pending shippable items ("zombies" that sit in the pick queue
 * forever because nothing triggers their status transition).
 *
 * Orders whose live OMS order still owes units that no live WMS line carries
 * are skipped and reported rather than cancelled or completed; see
 * wms-terminal-transition-guard.ts for why. The WMS sync restores such lines
 * when it next reconciles the order.
 */

export const ZOMBIE_REPAIR_REASON = "zombie_data_repair";
export const ZOMBIE_REPAIR_SKIPPED_CODE = "WMS_ZOMBIE_REPAIR_SKIPPED_OMS_STILL_OWES";

export type ZombieTargetStatus = "cancelled" | "completed";
export type ZombieRepairAction = "cancel" | "complete" | "skip_oms_still_owes";

export interface ZombieRepairCandidate {
  wmsOrderId: number;
  orderNumber: string;
  omsOrderId: number | null;
  targetStatus: ZombieTargetStatus;
  omsStillOwesUnmaterializedUnits: boolean;
}

export interface ZombieRepairSummary {
  transitioned: string[];
  skipped: ZombieRepairCandidate[];
}

interface ZombieRepairDb {
  execute(query: unknown): Promise<{ rows: unknown[] }>;
}

export function decideZombieRepairAction(
  candidate: Pick<ZombieRepairCandidate, "targetStatus" | "omsStillOwesUnmaterializedUnits">,
): ZombieRepairAction {
  if (candidate.omsStillOwesUnmaterializedUnits) return "skip_oms_still_owes";
  return candidate.targetStatus === "cancelled" ? "cancel" : "complete";
}

/**
 * Candidate selection. `target_status` is unchanged from the original inline
 * repair: 'cancelled' when every line is cancelled (or there are none),
 * otherwise 'completed'. `oms_still_owes_unmaterialized_units` is the shared
 * terminal-transition guard (wms-terminal-transition-guard.ts).
 */
const ZOMBIE_CANDIDATES_SQL = sql`
  SELECT o.id, o.order_number,
    CASE WHEN o.oms_fulfillment_order_id ~ '^[1-9][0-9]{0,17}$'
      THEN o.oms_fulfillment_order_id::bigint END AS oms_order_id,
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
    ${LIVE_OMS_DEMAND_NOT_CARRIED_BY_WMS_ORDER_O} AS oms_still_owes_unmaterialized_units
  FROM wms.orders o
  WHERE o.warehouse_status IN ('ready', 'in_progress', 'partially_shipped', 'ready_to_ship')
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
  const targetStatus = row.target_status === "cancelled" ? "cancelled" : "completed";
  const omsOrderId = row.oms_order_id == null ? null : Number(row.oms_order_id);
  return {
    wmsOrderId: Number(row.id),
    orderNumber: String(row.order_number ?? row.id),
    omsOrderId: Number.isSafeInteger(omsOrderId) ? omsOrderId : null,
    targetStatus,
    omsStillOwesUnmaterializedUnits: row.oms_still_owes_unmaterialized_units === true,
  };
}

export async function runStartupZombieOrderRepair(deps: {
  db: ZombieRepairDb;
  reservation: ReservationReleaser;
}): Promise<ZombieRepairSummary> {
  const result = await deps.db.execute(ZOMBIE_CANDIDATES_SQL);
  const summary: ZombieRepairSummary = { transitioned: [], skipped: [] };

  for (const row of result.rows) {
    const candidate = toCandidate(row);
    const action = decideZombieRepairAction(candidate);

    if (action === "skip_oms_still_owes") {
      summary.skipped.push(candidate);
      console.error(JSON.stringify({
        level: "error",
        code: ZOMBIE_REPAIR_SKIPPED_CODE,
        action: "wms_zombie_order_repair",
        outcome: "skipped",
        message:
          "WMS order has no pending lines but its live OMS order still owes shippable units; " +
          "not cancelling or completing — restore the lost WMS lines.",
        context: {
          wms_order_id: candidate.wmsOrderId,
          oms_order_id: candidate.omsOrderId,
          order_number: candidate.orderNumber,
          target_status: candidate.targetStatus,
        },
      }));
      continue;
    }

    // Terminal transitions must release leftover reservations (P0.1c /
    // 'completed'-status fix) — raw transitions here leaked them.
    const outcome = action === "cancel"
      ? await cancelWmsOrderAndRelease(deps.db, deps.reservation, candidate.wmsOrderId, ZOMBIE_REPAIR_REASON)
      : await completeWmsOrderAndRelease(deps.db, deps.reservation, candidate.wmsOrderId, ZOMBIE_REPAIR_REASON);
    if (outcome.transitioned) {
      summary.transitioned.push(`${candidate.orderNumber}→${candidate.targetStatus}`);
    }
  }

  return summary;
}
