import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { WmsSyncService } from "./server/modules/oms/wms-sync.service";
import { omsOrders } from "./shared/schema/oms.schema";
import { sql } from "drizzle-orm";

async function runSync() {
  try {
    console.log("Initializing WMS Sync validation...");

    const syncService = new WmsSyncService({
      inventoryCore: { getPrimaryBinLocation: async () => ({ location: 'mock', zone: 'M' }) },
      reservation: { reserveForOrder: async () => ({ success: true }) },
      fulfillmentRouter: { routeOrder: async () => {} },
    });

    // 1. Fetch a valid channel to satisfy referential integrity
    const channelResult = await db.execute(sql`SELECT id FROM channels LIMIT 1`);
    if (channelResult.rows.length === 0) throw new Error("No channels found to link OMS order.");
    const validChannelId = channelResult.rows[0].id as number;

    // 2. Create a mock OMS order to guarantee it exists in the 'oms' namespace
    console.log(`Inserting test OMS order using channel ID ${validChannelId}...`);
    const [mockOrder] = await db.insert(omsOrders).values({
      channelId: validChannelId,
      externalOrderId: `TEST-${Date.now()}`,
      externalOrderNumber: `TST-${Date.now()}`,
      status: "pending",
      financialStatus: "paid",
      shippingMethod: "Express Overnight", // Should trigger high priority
      subtotalCents: 1000,
      totalCents: 1000,
      customerEmail: "test@example.com",
      orderedAt: new Date()
    }).returning({ id: omsOrders.id });

    // 2.5 Insert a dummy line item
    const { omsOrderLines } = await import("./shared/schema/oms.schema");
    const variantResult = await db.execute(sql`SELECT id FROM product_variants LIMIT 1`);
    if (variantResult.rows.length === 0) throw new Error("No product_variants found.");
    const variantId = variantResult.rows[0].id as number;

    await db.insert(omsOrderLines).values({
      orderId: mockOrder.id,
      productVariantId: variantId,
      quantity: 1,
      title: "Test Item",
      sku: "TEST-SKU-123"
    });

    // 2.6 Diagnose what Drizzle actually returns
    const diagLines = await db.select().from(omsOrderLines).where(sql`order_id = ${mockOrder.id}`);
    console.log("Diag lines:", diagLines);
    if (!diagLines[0].productVariantId) {
       console.log("WARNING! productVariantId is missing or null in the returned object!");
       // Let's force it on the actual wms service by overriding the DB prototype or something?
       // Actually let's just find out what properties it DOES have
       Object.keys(diagLines[0]).forEach(k => console.log(k, (diagLines[0] as any)[k]));
    }

    console.log(`Created mock OMS Order ID: ${mockOrder.id} with 1 line item`);

    // 2. Sync it
    console.log("Triggering Sync to WMS...");
    const wmsOrderId = await syncService.syncOmsOrderToWms(mockOrder.id);
    
    if (wmsOrderId) {
      console.log(`Successfully synced! WMS Order ID: ${wmsOrderId}`);

      // 3. Verify priority
      const wmsOrder = await db.execute(sql`
        SELECT id, order_number, priority, warehouse_status 
        FROM orders WHERE id = ${wmsOrderId}
      `);
      console.log("WMS Order details:", wmsOrder.rows[0]);
    } else {
      console.error("Sync returned null. Sync failed.");
    }
    
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

runSync();
