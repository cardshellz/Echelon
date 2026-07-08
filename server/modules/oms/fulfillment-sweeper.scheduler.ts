import { db } from "../../db";
import { sql, eq, and, gt, lt, inArray } from "drizzle-orm";
import { omsOrders, channels } from "@shared/schema";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { EbayFulfillmentReconciler } from "./reconcilers/ebay.reconciler";
import { ShopifyFulfillmentReconciler } from "./reconcilers/shopify.reconciler";
import type { FulfillmentReconciler } from "./reconcilers/reconciler.interface";
import { applyChannelFulfillment } from "./channel-fulfillment.service";

const LOG_PREFIX = "[Fulfillment Sweeper]";

function getReconciler(provider: string, dbArg: any): FulfillmentReconciler | null {
  if (provider === "ebay") {
    return new EbayFulfillmentReconciler(dbArg);
  }
  if (provider === "shopify") {
    return new ShopifyFulfillmentReconciler(dbArg);
  }
  // Dropship reconciler can be added here
  return null;
}

export async function runFulfillmentSweep(dbArg: any = db) {
  try {
    console.log(`${LOG_PREFIX} Starting hourly fulfillment sweep...`);

    // Find orders shipped between 1 hour ago and 7 days ago
    // We ignore the first hour to allow the standard 5-minute delayed push queue to complete
    const sweepOrders = await dbArg.execute(sql`
      SELECT o.*, c.provider 
      FROM oms.oms_orders o
      JOIN channels.channels c ON o.channel_id = c.id
      WHERE o.status = 'shipped'
        AND o.shipped_at < NOW() - INTERVAL '1 hour'
        AND o.shipped_at > NOW() - INTERVAL '7 days'
    `);

    if (sweepOrders.rows.length === 0) {
      console.log(`${LOG_PREFIX} No shipped orders in the sweep window.`);
      return;
    }

    let processed = 0;
    let repushed = 0;

    for (const row of sweepOrders.rows) {
      const provider = row.provider;
      const orderId = row.id;
      
      const reconciler = getReconciler(provider, dbArg);
      if (!reconciler) {
        // Skip channels we don't have a reconciler for yet
        continue;
      }

      processed++;
      
      try {
        const status = await reconciler.checkStatus(row);
        if (status === "unfulfilled") {
          console.warn(`${LOG_PREFIX} Order ${orderId} (${row.external_order_id}) is still unfulfilled on ${provider}. Repushing...`);
          const success = await reconciler.repush(row);
          if (success) {
            repushed++;
          } else {
            console.error(`${LOG_PREFIX} Repush failed for order ${orderId} on ${provider}.`);
          }
        }
      } catch (err: any) {
        console.error(`${LOG_PREFIX} Error reconciling order ${orderId} on ${provider}: ${err.message}`);
      }
    }

    console.log(`${LOG_PREFIX} Complete. Processed: ${processed}, Repushed: ${repushed}`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Critical error during sweep: ${err.message}`);
  }
}

/**
 * Inbound sweep: find WMS orders still awaiting shipment where the channel
 * already reports the order as fulfilled (label bought outside ShipStation).
 * Pulls tracking from the channel and flows it through WMS shipments.
 */
export async function runInboundFulfillmentSweep(dbArg: any = db) {
  try {
    console.log(`${LOG_PREFIX} Starting inbound fulfillment sweep...`);

    // Orders that are paid/active in OMS but NOT shipped in WMS — candidates
    // where someone may have bought a label on the channel directly.
    const candidates = await dbArg.execute(sql`
      SELECT o.id, o.external_order_id, o.channel_id, c.provider,
             w.id AS wms_order_id, w.warehouse_status
      FROM oms.oms_orders o
      JOIN channels.channels c ON o.channel_id = c.id
      JOIN wms.orders w ON w.source = 'oms'
        AND w.oms_fulfillment_order_id = o.id::text
      WHERE o.status NOT IN ('shipped', 'cancelled', 'refunded')
        AND w.warehouse_status NOT IN ('shipped', 'cancelled')
        AND o.ordered_at > NOW() - INTERVAL '14 days'
      ORDER BY o.ordered_at DESC
      LIMIT 50
    `);

    if (candidates.rows.length === 0) {
      console.log(`${LOG_PREFIX} No inbound fulfillment candidates found.`);
      return;
    }

    let synced = 0;

    for (const row of candidates.rows) {
      const provider = row.provider;
      const reconciler = getReconciler(provider, dbArg);
      if (!reconciler) continue;

      try {
        const status = await reconciler.checkStatus(row);
        if (status !== "fulfilled") continue;

        // Channel says fulfilled — pull tracking and flow through WMS
        if (provider === "ebay" && reconciler instanceof EbayFulfillmentReconciler) {
          const ok = await reconciler.syncFulfillmentFromChannel(row);
          if (ok) synced++;
        } else if (provider === "shopify" && reconciler instanceof ShopifyFulfillmentReconciler) {
          const tracking = await reconciler.getTrackingInfo(row);
          if (tracking?.trackingNumber) {
            await applyChannelFulfillment(dbArg, row.wms_order_id, {
              trackingNumber: tracking.trackingNumber,
              carrier: tracking.carrier || "other",
              source: "shopify_fulfillment_sweep",
            }, {
              shippingEngine: dbArg?.__shippingEngine ?? null,
            });
            synced++;
          }
        }
      } catch (err: any) {
        console.error(
          `${LOG_PREFIX} Error syncing inbound fulfillment for order ${row.id} (${provider}): ${err.message}`,
        );
      }
    }

    console.log(`${LOG_PREFIX} Inbound sweep complete. Synced: ${synced}/${candidates.rows.length} candidates.`);
  } catch (err: any) {
    console.error(`${LOG_PREFIX} Critical error during inbound sweep: ${err.message}`);
  }
}

export function startFulfillmentSweeper(dbArg: any = db) {
  if (process.env.DISABLE_SCHEDULERS === "true") {
    return;
  }

  console.log(`${LOG_PREFIX} Scheduler started (runs every hour, dyno-safe lock)`);

  const SWEEPER_LOCK_ID = 8484;
  const INBOUND_LOCK_ID = 8485;

  // Run immediately on boot
  setTimeout(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Boot run error: ${err.message}`));
  }, 5000);

  // Inbound sweep on boot (staggered)
  setTimeout(() => {
    withAdvisoryLock(INBOUND_LOCK_ID, async () => {
      await runInboundFulfillmentSweep(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Inbound boot run error: ${err.message}`));
  }, 15000);

  // Run every 1 hour thereafter
  setInterval(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Scheduled run error: ${err.message}`));
  }, 60 * 60 * 1000);

  // Inbound sweep every hour (offset by 30 min from outbound)
  setTimeout(() => {
    setInterval(() => {
      withAdvisoryLock(INBOUND_LOCK_ID, async () => {
        await runInboundFulfillmentSweep(dbArg);
      }).catch((err) => console.error(`${LOG_PREFIX} Inbound sweep error: ${err.message}`));
    }, 60 * 60 * 1000);
  }, 30 * 60 * 1000);
}
