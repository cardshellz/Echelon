import { sql } from "drizzle-orm";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { runOneShotIfNeverCompleted } from "../../infrastructure/scheduler-run-registry";
import { enqueueShipStationSortRankSyncRetry } from "../oms/webhook-retry.api";
import {
  engineRefFromRow,
  type ShippingEngine,
} from "../shipping/engine-and-reconcile.api";
import { cancelDuplicateOutboundShipmentInWms } from "../wms/outbound-shipment-mutations.api";
import { recomputeAllActiveSortRanksDetailed } from "./sort-rank-and-priority.api";

export const ONE_SHOT_SORT_RANK_RECOMPUTE_JOB_KEY =
  "oneshot.orders.active_sort_rank_recompute_v1";
export const ONE_SHOT_SORT_RANK_RECOMPUTE_LOCK_ID = 918508;

export const ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_JOB_KEY =
  "oneshot.orders.retired_duplicate_shipment_cleanup_v1";
export const ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_LOCK_ID = 918509;

/**
 * One-time sort_rank recompute for active orders (`P1.5` / `P1.7`).
 *
 * Moved out of `server/index.ts` every-deploy boot code into an explicit
 * ledger-gated (`public.scheduler_runs`) + advisory-locked maintenance job.
 */
export async function runOneTimeActiveSortRankRecompute(deps: {
  db: any;
  force?: boolean;
}): Promise<{
  status: "executed" | "already_completed" | "lock_held";
  updated: number;
  queuedForShipStationSync: number;
}> {
  const { db } = deps;
  let updatedCount = 0;
  let queuedCount = 0;

  const executeBody = async () => {
    const { updated, orderIds } = await recomputeAllActiveSortRanksDetailed();
    updatedCount = updated;
    if (updated > 0) {
      console.log(`[Sort-Rank] Recomputed sort_rank for ${updated} active order(s)`);
      for (const orderId of orderIds) {
        await enqueueShipStationSortRankSyncRetry(
          db,
          orderId,
          "startup sort_rank recompute",
        );
      }
      queuedCount = orderIds.length;
      console.log(
        `[Sort-Rank] Queued ShipStation customField1 sync for ${orderIds.length} active order(s)`,
      );
    }
  };

  const lockOutcome = await withAdvisoryLock(
    ONE_SHOT_SORT_RANK_RECOMPUTE_LOCK_ID,
    async (): Promise<"executed" | "already_completed"> => {
      if (deps.force) {
        await executeBody();
        return "executed";
      }
      const ledgerOutcome = await runOneShotIfNeverCompleted({
        db,
        oneShotKey: ONE_SHOT_SORT_RANK_RECOMPUTE_JOB_KEY,
        logPrefix: "[Sort-Rank]",
        run: executeBody,
      });
      return ledgerOutcome.executed ? "executed" : "already_completed";
    },
  );

  if (lockOutcome === null) {
    return { status: "lock_held", updated: 0, queuedForShipStationSync: 0 };
  }

  return {
    status: lockOutcome,
    updated: updatedCount,
    queuedForShipStationSync: queuedCount,
  };
}

/**
 * Retired one-time duplicate shipment cleanup (`P1.5` / `P1.7`).
 *
 * DISABLED 2026-06-15 because ranking shipments per order conflated legitimate
 * split shipments with duplicates. Evicted from `server/index.ts` and gated by
 * both `ENABLE_DUP_SHIPMENT_CLEANUP=true` and the `public.scheduler_runs`
 * one-shot ledger.
 */
export async function runRetiredDuplicateShipmentCleanup(deps: {
  db: any;
  shippingEngine?: ShippingEngine;
}): Promise<{
  status: "disabled" | "executed" | "already_completed" | "lock_held";
  cancelledCount: number;
}> {
  if (process.env.ENABLE_DUP_SHIPMENT_CLEANUP !== "true") {
    return { status: "disabled", cancelledCount: 0 };
  }

  const { db } = deps;
  const engine = deps.shippingEngine;
  let cancelledCount = 0;

  const lockOutcome = await withAdvisoryLock(
    ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_LOCK_ID,
    async (): Promise<"executed" | "already_completed"> => {
      const ledgerOutcome = await runOneShotIfNeverCompleted({
        db,
        oneShotKey: ONE_SHOT_DUPLICATE_SHIPMENT_CLEANUP_JOB_KEY,
        logPrefix: "[Data Repair]",
        run: async () => {
          const dupes = await db.execute(sql`
            WITH ranked AS (
              SELECT
                os.id,
                os.order_id,
                os.status,
                os.shipstation_order_id,
                os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
                os.shipstation_order_key,
                ROW_NUMBER() OVER (
                  PARTITION BY os.order_id
                  ORDER BY CASE os.status
                    WHEN 'shipped'  THEN 0
                    WHEN 'labeled'  THEN 1
                    WHEN 'queued'   THEN 2
                    WHEN 'planned'  THEN 3
                    ELSE 5
                  END,
                  os.created_at ASC
                ) AS rn
              FROM wms.outbound_shipments os
              WHERE os.status NOT IN ('voided', 'cancelled')
            )
            SELECT id, order_id, status,
                   shipping_engine, engine_order_ref, engine_shipment_ref,
                   shipstation_order_id, shipstation_order_key
            FROM ranked
            WHERE rn > 1
          `);
          if (dupes.rows.length > 0) {
            for (const row of dupes.rows as any[]) {
              await cancelDuplicateOutboundShipmentInWms(db, row.id);
              const ref = engineRefFromRow(row);
              if (ref && engine?.isConfigured()) {
                try {
                  await engine.cancel(ref);
                } catch (ssErr: any) {
                  console.warn(
                    `[Data Repair] Could not cancel engine order ${ref.engineOrderRef}: ${ssErr?.message}`,
                  );
                }
              }
            }
            cancelledCount = dupes.rows.length;
            console.warn(
              `[Data Repair] Cancelled ${dupes.rows.length} duplicate shipment(s):`,
              (dupes.rows as any[])
                .map((r: any) => `shipment ${r.id} (order ${r.order_id}, status=${r.status})`)
                .join(", "),
            );
          }
        },
      });
      return ledgerOutcome.executed ? "executed" : "already_completed";
    },
  );

  if (lockOutcome === null) {
    return { status: "lock_held", cancelledCount: 0 };
  }

  return {
    status: lockOutcome,
    cancelledCount,
  };
}
