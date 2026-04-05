import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "../server/db.js";
import { sql } from "drizzle-orm";
import { createOmsService } from "../server/modules/oms/oms.service.js";
import { bridgeShopifyOrderToOms } from "../server/modules/oms/shopify-bridge.js";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("Starting OMS Backfill...");
  const omsService = createOmsService(db);

  // Clear existing oms_orders to force rehydrating with correct taxes/discounts
  await db.execute(sql`DELETE FROM oms_orders`);
  console.log("Cleared old oms_orders.");

  const unsynced = await db.execute(sql`
    SELECT id FROM shopify_orders
    ORDER BY created_at DESC
  `);

  console.log(`Found ${unsynced.rows.length} total orders to backfill...`);

  let bridged = 0;
  for (const row of unsynced.rows as any[]) {
    try {
      await bridgeShopifyOrderToOms(db, omsService, row.id);
    } catch (e: any) {
      console.error(`[Shopify Bridge] Failed to bridge order ${row.id}: ${e.message}`);
    }
    bridged++;
    if (bridged % 50 === 0) {
      console.log(`Backfilled ${bridged}/${unsynced.rows.length} orders...`);
    }
  }

  console.log(`[Shopify Bridge] Backfilled ${bridged} orders to OMS`);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
