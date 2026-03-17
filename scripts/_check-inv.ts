import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  console.log("=== GLV-TOP-35PT-P50 INVENTORY ===");
  const inv = await pool.query(`
    SELECT il.id, il.variant_qty, il.reserved_qty, il.picked_qty, il.packed_qty,
           wl.code as location_code, w.code as warehouse_code, pv.sku
    FROM inventory_levels il
    JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
    JOIN warehouses w ON w.id = wl.warehouse_id
    JOIN product_variants pv ON pv.id = il.product_variant_id
    WHERE pv.sku = 'GLV-TOP-35PT-P50'
  `);
  for (const r of inv.rows) {
    console.log(`  ${r.warehouse_code} ${r.location_code}: qty=${r.variant_qty} reserved=${r.reserved_qty} picked=${r.picked_qty}`);
  }

  // Check if inventory_audit_log exists
  console.log("\n=== RECENT AUDIT LOG ===");
  try {
    const adj = await pool.query(`
      SELECT * FROM inventory_audit_log 
      WHERE created_at > NOW() - INTERVAL '2 hours'
      ORDER BY created_at DESC LIMIT 10
    `);
    for (const r of adj.rows) {
      console.log(`  ${JSON.stringify(r)}`);
    }
  } catch { console.log("  (no audit log table)"); }

  console.log("\n=== WAREHOUSE SETTINGS ===");
  const ws = await pool.query("SELECT channel_sync_enabled, channel_sync_interval_minutes FROM warehouse_settings LIMIT 1");
  console.log("  sync enabled:", ws.rows[0]?.channel_sync_enabled, "interval:", ws.rows[0]?.channel_sync_interval_minutes);

  console.log("\n=== CHANNEL FEEDS FOR GLV-TOP-35PT-P50 ===");
  const feeds = await pool.query(`
    SELECT cf.channel_id, cf.last_synced_qty, cf.last_synced_at, c.name as channel_name
    FROM channel_feeds cf
    JOIN product_variants pv ON pv.id = cf.product_variant_id
    JOIN channels c ON c.id = cf.channel_id
    WHERE pv.sku = 'GLV-TOP-35PT-P50'
  `);
  for (const r of feeds.rows) {
    console.log(`  ${r.channel_name}: last_synced_qty=${r.last_synced_qty} at ${r.last_synced_at}`);
  }

  // Check what Shopify actually shows
  console.log("\n=== ALLOCATION FOR THIS VARIANT ===");
  const variant = await pool.query("SELECT id, product_id FROM product_variants WHERE sku = 'GLV-TOP-35PT-P50'");
  if (variant.rows[0]) {
    const vid = variant.rows[0].id;
    const pid = variant.rows[0].product_id;
    // Total ATP
    const atp = await pool.query(`
      SELECT COALESCE(SUM(il.variant_qty), 0) - COALESCE(SUM(il.reserved_qty), 0) - COALESCE(SUM(il.picked_qty), 0) - COALESCE(SUM(il.packed_qty), 0) as atp
      FROM inventory_levels il
      JOIN warehouse_locations wl ON wl.id = il.warehouse_location_id
      WHERE il.product_variant_id = $1
    `, [vid]);
    console.log(`  Total ATP: ${atp.rows[0]?.atp}`);
  }

  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
