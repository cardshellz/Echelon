import "dotenv/config";
import { createRequire } from "module";
global.require = createRequire(import.meta.url);
import { db } from "../server/db.js";
import { sql } from "drizzle-orm";

async function check() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    const res = await db.execute(sql`
      SELECT id, external_order_id, external_order_number, subtotal_cents, discount_cents, tax_cents, tax_exempt, total_cents
      FROM oms.oms_orders
      ORDER BY id ASC LIMIT 5
    `);
    const lines = await db.execute(sql`
      SELECT order_id, sku, paid_price_cents, total_price_cents, total_discount_cents, plan_discount_cents, coupon_discount_cents, compare_at_price_cents
      FROM oms.oms_order_lines
      ORDER BY id ASC LIMIT 5
    `);
    const fs = require('fs');
    fs.writeFileSync('oms-data.json', JSON.stringify({ orders: res.rows, lines: lines.rows }, null, 2));
  } catch(e) {
    console.error(e);
  }
  process.exit(0);
}
check();
