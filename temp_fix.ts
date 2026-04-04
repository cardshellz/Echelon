import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  try {
    console.log("Fixing dangling 0/x completed quantities in wms.order_items");
    
    // Any item that is 'completed' but expected 'quantity' > 0 and 'pickedQuantity' == 0
    const res = await db.execute(sql`
      UPDATE wms.order_items
      SET picked_quantity = quantity,
          fulfilled_quantity = quantity
      WHERE status = 'completed'
        AND quantity > 0
        AND picked_quantity = 0;
    `);
    
    console.log(`Updated ${(res as any).rowCount} row(s) to fix the '0/x' display issue.`);

  } catch (err: any) {
    console.error("DB Error:", err.message);
  }
  process.exit(0);
}

run();
