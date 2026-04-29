import { db } from "../db";
import { sql } from "drizzle-orm";

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
        
        // Update the inventory level to match reality
        await tx.execute(sql`
          UPDATE inventory.inventory_levels
          SET picked_qty = ${activeQty},
              updated_at = NOW()
          WHERE id = ${id}
        `);
        
        // Record an audit transaction to explain the sudden drop in picked_qty
        await tx.execute(sql`
          INSERT INTO inventory.inventory_transactions (
            product_variant_id,
            from_location_id,
            transaction_type,
            variant_qty_delta,
            variant_qty_before,
            variant_qty_after,
            source_state,
            target_state,
            reference_type,
            reference_id,
            notes,
            created_at
          ) VALUES (
            ${product_variant_id},
            ${warehouse_location_id},
            'ship',
            0,
            0,
            0,
            'picked',
            'shipped',
            'system_cleanup',
            'script_fix_orphans',
            ${`Backfilled ${orphanQty} orphaned picked items missing from ShipStation V2 webhook.`},
            NOW()
          )
        `);
        
        fixedCount++;
      }
    }
  });
  
  console.log(`Successfully fixed ${fixedCount} inventory levels.`);
  process.exit(0);
}

run();
