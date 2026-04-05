import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "./server/db";
import { sql } from "drizzle-orm";
import { bridgeShopifyOrderToOms } from "./server/modules/oms/shopify-bridge";
import { createOmsService } from "./server/modules/oms/oms.service";

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const omsService = createOmsService(db, null as any); // null fulfillment service
    
    // Get a real recent shopify order id
    const result = await db.execute<{ id: string }>(sql`
      SELECT id FROM shopify_orders ORDER BY order_date DESC LIMIT 1
    `);
    
    if (result.rows.length === 0) {
      console.log("No shopify orders found");
      return;
    }
    
    const shopifyOrderId = result.rows[0].id;
    console.log("Bridging order:", shopifyOrderId);
    
    await bridgeShopifyOrderToOms(db, omsService, shopifyOrderId);
    
    console.log("Bridged successfully. Querying oms tables...");
    
    const omsOrderResult = await db.execute(sql`
      SELECT id, tax_exempt, shipping_method, shipping_method_code, tags
      FROM oms.oms_orders 
      WHERE external_order_id = ${shopifyOrderId}
      ORDER BY created_at DESC LIMIT 1
    `);
    
    console.log("OMS Order details:", JSON.stringify(omsOrderResult.rows[0], null, 2));
    
    if (omsOrderResult.rows.length > 0) {
      const omsLinesResult = await db.execute(sql`
        SELECT id, taxable, requires_shipping, fulfillable_quantity, fulfillment_service, properties, discount_allocations, tax_lines, order_number
        FROM oms.oms_order_lines 
        WHERE order_id = ${omsOrderResult.rows[0].id}
      `);
      
      console.log("OMS Line details:", JSON.stringify(omsLinesResult.rows, null, 2));
    }
  } catch (e: any) {
    console.error("TEST SCRIPT ERROR:", e);
  }
  process.exit(0);
}

run();
