import { sql } from "drizzle-orm";
import {
  registerScheduledJob,
  type RegisteredJobHandle,
} from "../../../infrastructure/job-registry";
import {
  engineRefFromRow,
  toEngineRef,
  type ShippingEngine,
} from "../../shipping/engine-and-reconcile.api";
import { logger } from "../../../platform/observability/logger";

export const EBAY_FULFILLMENT_RECONCILE_LOCK_ID = 918503;

export interface EbayFulfillmentStuckOrderSchedulerDeps {
  db: { execute: (query: any) => Promise<any> };
  shippingEngine: ShippingEngine;
}

/**
 * eBay Stuck-Order Fulfillment Reconciliation Scheduler (`P1.5` / `P1.7`).
 * Checks eBay OMS orders stuck in `confirmed` > 2 hours against the shipping
 * engine and routes proven physical package facts through `applyInboundShipmentAuthority`.
 */
export function startEbayFulfillmentStuckOrderScheduler(
  deps: EbayFulfillmentStuckOrderSchedulerDeps,
): RegisteredJobHandle {
  const runEbayReconcile = async (): Promise<void> => {
    try {
      const engine = deps.shippingEngine;
      if (!engine?.isConfigured()) return;

      const stuckOrders = await deps.db.execute(sql`
        SELECT DISTINCT ON (o.id)
               o.id, o.external_order_id, o.external_order_number,
               o.shipstation_order_id AS oms_shipstation_order_id,
               os.shipping_engine, os.engine_order_ref, os.engine_shipment_ref,
               os.shipstation_order_id, os.shipstation_order_key
        FROM oms.oms_orders o
        LEFT JOIN wms.orders w ON w.oms_fulfillment_order_id = o.id::text
        LEFT JOIN wms.outbound_shipments os ON os.order_id = w.id
          AND os.status NOT IN ('cancelled', 'voided')
        WHERE o.channel_id = 67
          AND o.status = 'confirmed'
          AND o.created_at < NOW() - INTERVAL '2 hours'
        ORDER BY o.id, os.engine_order_ref NULLS LAST
        LIMIT 50
      `);
      if (!stuckOrders.rows?.length) return;

      logger.info("oms.ebay_fulfillment_stuck_order_scheduler", { message: `[eBay Reconcile] Found ${stuckOrders.rows.length} stuck orders, checking engine...` });

      for (const order of stuckOrders.rows) {
        try {
          let ref = engineRefFromRow(order);
          if (!ref && order.oms_shipstation_order_id) {
            ref = toEngineRef(Number(order.oms_shipstation_order_id));
          }
          if (!ref) {
            logger.warn("oms.ebay_fulfillment_stuck_order_scheduler", { message: `[eBay Reconcile] No engine ref for OMS order ${order.id} — skipping` });
            continue;
          }

          const engineState = await engine.getState(ref);
          if (engineState && engineState.status === "shipped") {
            const orderNumber = String(order.external_order_number ?? "").trim();
            if (!engine.applyInboundShipmentAuthority || !orderNumber) {
              logger.error("EBAY_RECONCILE_PHYSICAL_AUTHORITY_UNAVAILABLE", { code: "EBAY_RECONCILE_PHYSICAL_AUTHORITY_UNAVAILABLE", omsOrderId: Number(order.id), externalOrderId: order.external_order_id ?? null, orderNumber: orderNumber || null, engine: engine.engineName });
              continue;
            }

            const processed = await engine.applyInboundShipmentAuthority({
              engineRef: ref,
              orderNumber,
            });
            logger.info("EBAY_RECONCILE_PHYSICAL_AUTHORITY_APPLIED", { code: "EBAY_RECONCILE_PHYSICAL_AUTHORITY_APPLIED", omsOrderId: Number(order.id), externalOrderId: order.external_order_id ?? null, orderNumber, processedPhysicalShipments: processed });
          }
        } catch (e: any) {
          logger.warn("oms.ebay_fulfillment_stuck_order_scheduler", { message: `[eBay Reconcile] Failed to check order ${order.id}: ${e.message}` });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err: any) {
      logger.warn("oms.ebay_fulfillment_stuck_order_scheduler", { message: "[eBay Reconcile] Sweep error:", error: err?.message });
    }
  };

  return registerScheduledJob({
    name: "channels.ebay_fulfillment_reconcile",
    cadenceMs: 60 * 60 * 1000,
    initialDelayMs: 5_000,
    advisoryLockId: EBAY_FULFILLMENT_RECONCILE_LOCK_ID,
    writableStates: ["wms.physical_shipments", "oms.oms_orders.status:shipped"],
    deadLetterPolicy: "review_flag",
    disableEnvVar: "EBAY_FULFILLMENT_RECONCILE_DISABLED",
    db: deps.db,
    gateInitialRunOnSchedule: true,
    run: runEbayReconcile,
  });
}
