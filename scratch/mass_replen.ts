import { db } from "../server/db";
import { warehouseLocations, productLocations } from "@shared/schema";
import { ReplenishmentUseCases } from "../server/modules/inventory/application/replenishment.use-cases";
import { eq } from "drizzle-orm";

async function massReplen() {
  console.log("Starting Mass Replenishment Check...");
  // Pass null for inventoryCore since checkReplenForLocation only queries db and delegates execution tasks which might need it later, but we just want to create pending tasks
  const replenApi = new ReplenishmentUseCases(db as any, { 
    withTx: () => ({} as any), adjustInventory: async () => ({})
  } as any);

  const pickableBins = await db.select({ id: warehouseLocations.id, code: warehouseLocations.code })
    .from(warehouseLocations)
    .where(eq(warehouseLocations.isPickable, 1));
  
  console.log(`Evaluating ${pickableBins.length} pickable bins...`);
  
  let checked = 0;
  
  for (const bin of pickableBins) {
    try {
      // Find all assignments for this bin
      const assignments = await db.select({ variantId: productLocations.productVariantId })
        .from(productLocations)
        .where(eq(productLocations.warehouseLocationId, bin.id));
        
      if (assignments.length > 0) {
        await replenApi.checkReplenForLocation(bin.id);
        checked++;
      }
    } catch (err: any) {
      console.warn(`Failed on location ${bin.code}: ${err.message}`);
    }
  }

  console.log(`\nMass Replenishment Complete.`);
  console.log(`Checked ${checked} bins with assignments.`);
  process.exit(0);
}

massReplen().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
