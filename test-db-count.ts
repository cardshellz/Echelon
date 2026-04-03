import * as schema from "./shared/schema";
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function main() {
  try {
    const res = await db.execute(sql`SELECT count(*) FROM public.orders WHERE warehouse_status IN ('ready', 'in_progress')`);
    console.log("Count in public.orders:", res.rows[0]);
    
    // Test the exact query from the picker queue
    const orderList = await db.execute(sql`
      SELECT o.id, o.order_number, o.warehouse_status
      FROM public.orders o
      WHERE o.warehouse_status NOT IN ('shipped', 'ready_to_ship', 'cancelled')
        AND (
          o.warehouse_status IN ('ready', 'in_progress')
        )
      LIMIT 5
    `);
    console.log("Picker query sample:", orderList.rows);
  } catch(e) {
    console.error("DB Error:", e);
  }
  process.exit();
}
main();
