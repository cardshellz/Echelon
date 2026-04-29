import { db } from "../db";
import { sql } from "drizzle-orm";

async function run() {
  const levels = await db.execute(sql`
    SELECT product_variant_id, warehouse_location_id, picked_qty 
    FROM inventory.inventory_levels 
    WHERE picked_qty > 0
  `);

  console.log(`Found ${levels.rows.length} inventory levels with picked_qty > 0`);
  
  let orphanedCount = 0;
  for (const row of levels.rows) {
    const { product_variant_id, warehouse_location_id, picked_qty } = row as any;
    
    // Find how many items are currently picked/packed for this variant at this location
    // that belong to shipments that are NOT yet shipped, cancelled, or voided.
    const activePicks = await db.execute(sql`
      SELECT COALESCE(SUM(osi.qty), 0) as active_qty
      FROM wms.outbound_shipment_items osi
      JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
      WHERE osi.product_variant_id = ${product_variant_id}
        AND osi.from_location_id = ${warehouse_location_id}
        AND os.status NOT IN ('shipped', 'cancelled', 'voided', 'returned', 'lost')
    `);
    
    const activeQty = Number(activePicks.rows[0].active_qty);
    if (activeQty < picked_qty) {
      orphanedCount++;
      // console.log(`Variant ${product_variant_id} Loc ${warehouse_location_id}: Picked=${picked_qty}, Active=${activeQty}. Orphaned=${picked_qty - activeQty}`);
    }
  }
  
  console.log(`Found ${orphanedCount} levels with orphaned picked_qty`);
  process.exit(0);
}

run();
