import { db } from "../../db";
import { sql, eq, and, gt, lt, inArray } from "drizzle-orm";
import { omsOrders, channels } from "@shared/schema";
import { withAdvisoryLock } from "../../infrastructure/scheduler-lock";
import { EbayFulfillmentReconciler } from "./reconcilers/ebay.reconciler";
import { ShopifyFulfillmentReconciler } from "./reconcilers/shopify.reconciler";
import type { FulfillmentReconciler } from "./reconcilers/reconciler.interface";

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
      JOIN oms.channels c ON o.channel_id = c.id
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

export function startFulfillmentSweeper(dbArg: any = db) {
  if (process.env.DISABLE_SCHEDULERS === "true") {
    return;
  }

  console.log(`${LOG_PREFIX} Scheduler started (runs every hour, dyno-safe lock)`);

  const SWEEPER_LOCK_ID = 8484; // unique lock ID

  // Run every 1 hour
  setInterval(() => {
    withAdvisoryLock(SWEEPER_LOCK_ID, async () => {
      await runFulfillmentSweep(dbArg);
    }).catch((err) => console.error(`${LOG_PREFIX} Scheduled run error: ${err.message}`));
  }, 60 * 60 * 1000);
}
