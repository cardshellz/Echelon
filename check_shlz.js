import pkg from 'pg';
const { Client } = pkg;
const client = new Client({ 
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
client.connect().then(async () => {
  try {
    const pRes = await client.query(`SELECT p.id, p.sku FROM catalog.products p WHERE p.sku = 'SHLZ-SEMI-OVR'`);
    console.log("PRODUCT:", pRes.rows);
    if (pRes.rows.length === 0) return client.end();
    
    const vRes = await client.query(`SELECT id, sku, units_per_variant, is_active FROM catalog.product_variants WHERE product_id = $1`, [pRes.rows[0].id]);
    console.log("VARIANTS:");
    console.table(vRes.rows);
    
    const vids = vRes.rows.map(r => r.id);
    const invRes = await client.query(`
      SELECT il.product_variant_id, il.variant_qty, il.reserved_qty, il.picked_qty, il.packed_qty,
             wl.warehouse_id, w.name as warehouse_name
      FROM inventory.inventory_levels il
      JOIN public.warehouse_locations wl ON wl.id = il.warehouse_location_id
      JOIN public.warehouses w ON w.id = wl.warehouse_id
      WHERE il.product_variant_id = ANY($1)
    `, [vids]);
    console.log("INVENTORY:");
    console.table(invRes.rows);
    
    const rulesRes = await client.query(`
      SELECT * FROM channels.channel_allocation_rules 
      WHERE product_id = $1 OR product_variant_id = ANY($2)
    `, [pRes.rows[0].id, vids]);
    console.log("RULES:");
    console.table(rulesRes.rows);
  } catch (err) {
    console.error(err);
  } finally {
    client.end();
  }
}).catch(console.error);
