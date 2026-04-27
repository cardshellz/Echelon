import * as dotenv from "dotenv";
dotenv.config();
import { db } from "./server/db";
import { sql } from "drizzle-orm";

async function run() {
  try {
    const res = await db.execute(sql`
      SELECT id, external_order_number, raw_payload
      FROM oms.oms_orders 
      WHERE external_order_number = '#56522'
    `);
    
    if (res.rows.length > 0) {
      const payload = typeof res.rows[0].raw_payload === "string" ? JSON.parse(res.rows[0].raw_payload) : res.rows[0].raw_payload;
      console.log("Discount Applications:");
      console.dir(payload.discount_applications, { depth: null });
      console.log("Discount Codes:");
      console.dir(payload.discount_codes, { depth: null });
      console.log("Line Items (first 2):");
      console.dir(payload.line_items.slice(0, 2).map((l: any) => ({
        title: l.title,
        price: l.price,
        discount_allocations: l.discount_allocations
      })), { depth: null });
    }
  } catch (e) {
    console.error(e);
  }
  process.exit(0);
}
run();
