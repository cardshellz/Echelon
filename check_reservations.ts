import "dotenv/config";
import { db } from "./server/db";
import { inventoryLevels, productVariants, warehouseLocations, replenTasks } from "@shared/schema";
import { eq, gt, or, lt, sql } from "drizzle-orm";
import { createReplenishmentService } from "./server/modules/inventory/replen.service";
import { createInventoryCoreService } from "./server/modules/inventory/core.service";

async function run() {
  const inventoryCore = createInventoryCoreService(db);
  const replenishment = createReplenishmentService(db, inventoryCore);

  console.log("--- FINDING BLOCKED TASKS ---");
  const blockedTasks = await db.select().from(replenTasks).where(eq(replenTasks.status, "blocked"));
  console.log(`Found ${blockedTasks.length} blocked tasks.`);

  // Trigger re-evaluate for these products
  const productIds = Array.from(new Set(blockedTasks.filter(t => t.productId !== null).map(t => t.productId)));
  for (const pid of productIds) {
    if (pid) {
      console.log(`Re-evaluating replen for product ${pid}`);
      await replenishment.reevaluateReplenForProduct(pid);
    }
  }

  console.log("--- FINDING OVER-RESERVED INVENTORY ---");
  const levels = await db.select({
    id: inventoryLevels.id,
    variantQty: inventoryLevels.variantQty,
    reservedQty: inventoryLevels.reservedQty,
    locCode: warehouseLocations.code,
    sku: productVariants.sku,
  })
  .from(inventoryLevels)
  .innerJoin(warehouseLocations, eq(warehouseLocations.id, inventoryLevels.warehouseLocationId))
  .innerJoin(productVariants, eq(productVariants.id, inventoryLevels.productVariantId))
  .where(or(
    lt(inventoryLevels.variantQty, 0),
    gt(inventoryLevels.reservedQty, inventoryLevels.variantQty)
  ));
  
  if (levels.length === 0) {
    console.log("No over-reserved inventory levels found (reservedQty > variantQty or negative variantQty).");
  } else {
    for (const l of levels) {
      console.log(`- Level ${l.id} (${l.sku} at ${l.locCode}): variantQty=${l.variantQty}, reservedQty=${l.reservedQty}`);
    }
  }

  process.exit(0);
}
run();
