import { db } from "../db";
import { sql } from "drizzle-orm";
import { repairOrphanedPickedInventoryLevelInTx } from "../modules/inventory/cross-module-inventory-mutations.api";

async function run() {
  const levels = await db.execute(sql`
    SELECT id, product_variant_id, warehouse_location_id, picked_qty 
    FROM inventory.inventory_levels 
    WHERE picked_qty > 0
  `);

  console.log(`Found ${levels.rows.length} inventory levels with picked_qty > 0. Analyzing for orphans...`);
  
  let fixedCount = 0;
  
  await db.transaction(async (tx) => {
    for (const row of levels.rows) {
      const { id, product_variant_id, warehouse_location_id, picked_qty } = row as any;
      
      const activePicks = await tx.execute(sql`
        SELECT COALESCE(SUM(osi.qty), 0) as active_qty
        FROM wms.outbound_shipment_items osi
        JOIN wms.outbound_shipments os ON os.id = osi.shipment_id
        WHERE osi.product_variant_id = ${product_variant_id}
          AND osi.from_location_id = ${warehouse_location_id}
          AND os.status NOT IN ('shipped', 'cancelled', 'voided', 'returned', 'lost')
      `);
      
      const activeQty = Number(activePicks.rows[0].active_qty);
      if (activeQty < picked_qty) {
        const orphanQty = picked_qty - activeQty;
        console.log(`Fixing Variant ${product_variant_id} Loc ${warehouse_location_id}: Picked=${picked_qty}, Active=${activeQty}. Removing ${orphanQty} orphaned items.`);
        
        await repairOrphanedPickedInventoryLevelInTx(tx, {
          levelId: id,
          productVariantId: product_variant_id,
          warehouseLocationId: warehouse_location_id,
          activeQty,
          orphanQty,
        });
        
        fixedCount++;
      }
    }
  });
  
  console.log(`Successfully fixed ${fixedCount} inventory levels.`);
  process.exit(0);
}

run();
