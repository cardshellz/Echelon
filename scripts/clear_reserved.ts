import "dotenv/config";
import { db } from "../server/db";
import { inventoryLevels, productVariants } from "@shared/schema";
import { inArray } from "drizzle-orm";

async function run() {
  const skus = ["SHLZ-SEMI-OVR-B200", "SHLZ-SEMI-OVR-C2000"];
  const variants = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(inArray(productVariants.sku, skus));
    
  if (variants.length === 0) {
    console.log("No variants found");
    return;
  }
  
  const variantIds = variants.map(v => v.id);
  
  const res = await db
    .update(inventoryLevels)
    .set({ reservedQty: 0 })
    .where(inArray(inventoryLevels.productVariantId, variantIds))
    .returning();
    
  console.log(`Cleared reserved_qty for ${res.length} inventory records`);
  process.exit(0);
}

run().catch(console.error);
