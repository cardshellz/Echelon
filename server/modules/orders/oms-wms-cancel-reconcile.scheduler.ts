import { sql } from "drizzle-orm";
import {
  registerScheduledJob,
  type RegisteredJobHandle,
} from "../../infrastructure/job-registry";
import { omsWarehouseCancellationSql } from "../oms/order-linkage-sql.api";
import {
  engineRefFromRow,
  type ShippingEngine,
} from "../shipping/engine-and-reconcile.api";
import {
  cancelOutboundShipmentAfterEngineCascadeInWms,
  recordOutboundShipmentAlreadyShippedInEngineInWms,
} from "../wms/outbound-shipment-mutations.api";
import { cancelWmsOrderAndRelease } from "./cancel-wms-order";

export const OMS_WMS_CANCEL_RECONCILE_LOCK_ID = 918504;

export interface OmsWmsCancelReconcileSchedulerDeps {
  db: any;
  reservation: any;
  shippingEngine: ShippingEngine;
}

/**
 * OMS<->WMS cancellation reconciliation (`P1.5` / `P1.7`) — catches webhook
 * delivery failures where a commercially terminal order still has active
 * warehouse work. Shipped state is deliberately excluded: only canonical
 * physical-shipment projection may advance WMS fulfillment quantities or
 * shipped status.
 */
export function startOmsWmsCancelReconcileScheduler(
  deps: OmsWmsCancelReconcileSchedulerDeps,
): RegisteredJobHandle {
  const { db, services } = {
    db: deps.db,
    services: {
      reservation: deps.reservation,
      shippingEngine: deps.shippingEngine,
    },
  };

  const runOmsWmsReconcile = async (): Promise<void> => {
    try {
      const divergent: any = await db.execute(sql`
        SELECT w.id, w.order_number, oms.status AS oms_status
        FROM wms.orders w
        JOIN oms.oms_orders oms ON (
                (w.source = 'oms'     AND w.oms_fulfillment_order_id = oms.id::text)
            OR  (w.source = 'shopify' AND w.source_table_id = oms.id::text)
              )
        WHERE ${omsWarehouseCancellationSql("oms")}
          AND w.warehouse_status IN ('ready', 'in_progress', 'ready_to_ship', 'completed')
      `);
      const corrected: any[] = [];
      for (const row of divergent.rows as any[]) {
        const transResult = await cancelWmsOrderAndRelease(
          db,
          services.reservation,
          row.id,
          "oms_wms_reconcile",
        );
        if (transResult.transitioned) {
          corrected.push(row);
        }
      }
      if (corrected.length > 0) {
        console.warn(
          `[OMS<->WMS Reconcile] Corrected ${corrected.length} divergent order(s):`,
          corrected.map((r: any) => `${r.order_number} (oms=${r.oms_status})`).join(", "),
        );

        const cancelledIds = corrected.map((r: any) => r.id);
        if (cancelledIds.length > 0) {
          try {
            const ssRows: any = await db.execute(sql`
              SELECT os.id AS shipment_id, os.shipstation_order_id,
                     os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
                     os.shipstation_order_key
              FROM wms.outbound_shipments os
              WHERE os.order_id = ANY(${cancelledIds})
                AND COALESCE(os.engine_order_ref, os.shipstation_order_id::text) IS NOT NULL
                AND os.status NOT IN ('cancelled', 'shipped', 'voided', 'returned', 'lost')
                AND os.shipped_at IS NULL
            `);
            const engine = services.shippingEngine;
            if (engine?.isConfigured() && ssRows.rows.length > 0) {
              for (const row of ssRows.rows) {
                try {
                  const ref = engineRefFromRow(row);
                  if (!ref) continue;
                  const cancelResult = await engine.cancel(ref);
                  // P0.3: only "already_shipped" proves a package left the building.
                  if (cancelResult?.state === "already_shipped") {
                    await recordOutboundShipmentAlreadyShippedInEngineInWms(db, row.shipment_id);
                    console.log(
                      `[OMS<->WMS Reconcile] Engine order ${ref.engineOrderRef} already shipped — recorded shipped for shipment ${row.shipment_id}`,
                    );
                  } else {
                    await cancelOutboundShipmentAfterEngineCascadeInWms(db, row.shipment_id);
                    console.log(
                      `[OMS<->WMS Reconcile] Cancelled engine order ${ref.engineOrderRef} for shipment ${row.shipment_id} (${cancelResult?.state ?? "cancelled"})`,
                    );
                  }
                } catch (ssErr: any) {
                  console.warn(
                    `[OMS<->WMS Reconcile] Failed to cancel engine order for shipment ${row.shipment_id}: ${ssErr?.message}`,
                  );
                }
              }
            }
          } catch (err: any) {
            console.warn("[OMS<->WMS Reconcile] SS cascade error:", err?.message);
          }
        }
      }
    } catch (err: any) {
      console.warn("[OMS<->WMS Reconcile] Sweep error:", err?.message);
    }
  };

  return registerScheduledJob({
    name: "orders.oms_wms_reconcile",
    cadenceMs: 60 * 60 * 1000,
    initialDelayMs: 15_000,
    advisoryLockId: OMS_WMS_CANCEL_RECONCILE_LOCK_ID,
    writableStates: [
      "wms.orders.warehouse_status:cancelled",
      "wms.outbound_shipments.status:cancelled",
      "wms.outbound_shipments.status:shipped",
    ],
    deadLetterPolicy: "log_and_retry_next_tick",
    disableEnvVar: "OMS_WMS_RECONCILE_DISABLED",
    db,
    gateInitialRunOnSchedule: true,
    run: runOmsWmsReconcile,
  });
}
