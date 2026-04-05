require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    // 1. Sync orders
    console.log("Migrating missing orders from public...");
    const ores1 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='wms' AND table_name='orders'");
    const ores2 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='orders'");
    
    // Intersect
    const oCols = ores1.rows.filter(c1 => ores2.rows.some(c2 => c2.column_name === c1.column_name)).map(c => c.column_name);
    const oColStr = oCols.join(', ');

    await pool.query(`
      INSERT INTO wms.orders (${oColStr})
      OVERRIDING SYSTEM VALUE
      SELECT ${oColStr}
      FROM public.orders WHERE id NOT IN (SELECT id FROM wms.orders);
    `);
    
    // 2. Sync order items
    console.log("Migrating missing order items...");
    const ires1 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='wms' AND table_name='order_items'");
    const ires2 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='order_items'");
    
    const iCols = ires1.rows.filter(c1 => ires2.rows.some(c2 => c2.column_name === c1.column_name)).map(c => c.column_name);
    const iColStr = iCols.join(', ');

    await pool.query(`
      INSERT INTO wms.order_items (${iColStr})
      OVERRIDING SYSTEM VALUE
      SELECT ${iColStr}
      FROM public.order_items WHERE id NOT IN (SELECT id FROM wms.order_items);
    `);
    
    console.log("Missing orders & items synced perfectly!");
    process.exit(0);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
}

run();
