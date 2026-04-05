import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("Fetching order data...");
    const ordersResult = await db.execute(sql`
      SELECT id, order_number, source, external_order_id, oms_fulfillment_order_id, warehouse_status, item_count
      FROM wms.orders
      WHERE order_number IN ('#55555', '#55554', '55555', '55554')
         OR external_order_id IN ('55555', '55554')
    `);
    console.log("\n=== WMS ORDERS ===");
    console.table(ordersResult.rows);

    if (ordersResult.rows.length > 0) {
      const orderIds = ordersResult.rows.map(r => r.id);
      const itemsResult = await db.execute(sql`
        SELECT id, order_id, sku, name, quantity, picked_quantity, fulfilled_quantity, status, requires_shipping
        FROM wms.order_items
        WHERE order_id IN (${sql.raw(orderIds.join(','))})
      `);
      console.log("\n=== WMS ORDER ITEMS ===");
      console.table(itemsResult.rows);
    }

    const omsOrdersResult = await db.execute(sql`
      SELECT id, external_order_id, external_order_number, source, status
      FROM oms_orders
      WHERE external_order_number IN ('#55555', '#55554', '55555', '55554')
         OR external_order_id IN ('55555', '55554')
    `);
    console.log("\n=== OMS ORDERS ===");
    console.table(omsOrdersResult.rows);

    if (omsOrdersResult.rows.length > 0) {
      const omsOrderIds = omsOrdersResult.rows.map(r => r.id);
      const omsItems = await db.execute(sql`
         SELECT id, order_id, sku, title, quantity, requires_shipping
         FROM oms_order_lines
         WHERE order_id IN (${sql.raw(omsOrderIds.join(','))})
      `);
      console.log("\n=== OMS ORDER LINES ===");
      console.table(omsItems.rows);
    }

    // Checking if there are any Shopify Raw tables references
    const shopifyOrdersResult = await db.execute(sql`
      SELECT id, order_number, source_name, financial_status, fulfillment_status
      FROM shopify_orders
      WHERE order_number IN ('#55555', '#55554', '55555', '55554')
    `);
    console.log("\n=== SHOPIFY RAW ORDERS ===");
    console.table(shopifyOrdersResult.rows);

    if (shopifyOrdersResult.rows.length > 0) {
      const shopifyOrderIds = shopifyOrdersResult.rows.map(r => `'${r.id}'`).join(',');
      const shopifyItems = await db.execute(sql`
         SELECT id, order_id, sku, name, quantity, requires_shipping
         FROM shopify_order_items
         WHERE order_id IN (${sql.raw(shopifyOrderIds)})
      `);
      console.log("\n=== SHOPIFY RAW ORDER ITEMS ===");
      console.table(shopifyItems.rows);
    }

  } catch (err: any) {
    console.error("DB Error:", err.message);
  }
  process.exit(0);
}

run();
