import * as dotenv from "dotenv";
dotenv.config();
process.env.PGSSLMODE = "require";
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function run() {
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  const tablesToCheck = [
    { s1: 'public', t1: 'products', s2: 'catalog', t2: 'products' },
    { s1: 'public', t1: 'product_variants', s2: 'catalog', t2: 'product_variants' },
    { s1: 'public', t1: 'product_assets', s2: 'catalog', t2: 'product_assets' },
    { s1: 'public', t1: 'orders', s2: 'wms', t2: 'orders' },
    { s1: 'public', t1: 'order_items', s2: 'wms', t2: 'order_items' },
    { s1: 'public', t1: 'oms_orders', s2: 'oms', t2: 'oms_orders' },
  ];

  const results = [];
  for (const pair of tablesToCheck) {
    try {
      const q1 = await db.execute(sql.raw(`SELECT COUNT(*) as c FROM ${pair.s1}.${pair.t1}`));
      const q2 = await db.execute(sql.raw(`SELECT COUNT(*) as c FROM ${pair.s2}.${pair.t2}`));
      results.push({
        table: pair.t1,
        legacyCount: parseInt(q1.rows[0].c as string),
        newCount: parseInt(q2.rows[0].c as string),
      });
    } catch (e: any) {
      results.push({ table: pair.t1, error: e.message });
    }
  }
  
  const fs = await import("fs");
  fs.writeFileSync("counts.json", JSON.stringify(results, null, 2), "utf8");
  process.exit();
}

run();
