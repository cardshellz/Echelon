import { db } from "./server/storage/base";
import { sql } from "drizzle-orm";

async function investigate() {
  console.log("=== Investigating Order 55555 ===");
  const o55555 = await db.execute(sql`
    SELECT id, order_number, channel, financial_status, source_name, display_financial_status 
    FROM orders WHERE order_number = '55555' OR order_number = '#55555'
  `);
  console.log(o55555.rows);

  if (o55555.rows.length > 0) {
    const orderId = (o55555.rows[0] as any).id;
    console.log(`\n=== Pick Tasks for Order 55555 (ID: ${orderId}) ===`);
    const tasks = await db.execute(sql`
      SELECT id, status, assigned_to FROM pick_tasks WHERE order_id = ${orderId}
    `);
    console.log(tasks.rows);

    console.log(`\n=== Pick Task Items for Order 55555 ===`);
    const items = await db.execute(sql`
      SELECT pti.id, pti.sku, pti.expected_qty, pti.picked_qty, pti.status 
      FROM pick_task_items pti
      JOIN pick_tasks pt ON pt.id = pti.pick_task_id
      WHERE pt.order_id = ${orderId}
    `);
    console.log(items.rows);
  }

  console.log("\n=== Investigating Order 55554 ===");
  const o55554 = await db.execute(sql`
    SELECT id, order_number, channel, financial_status, source_name, display_financial_status 
    FROM orders WHERE order_number = '55554' OR order_number = '#55554'
  `);
  console.log(o55554.rows);

  process.exit(0);
}

investigate().catch(console.error);
