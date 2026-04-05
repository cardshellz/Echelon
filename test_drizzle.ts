import "dotenv/config";
import { db } from "./server/db";
import { productVariants, products } from "@shared/schema";
import { like } from "drizzle-orm";

async function run() {
  const vars = await db.select().from(productVariants).where(like(productVariants.sku, '%arm-env-sgl%'));
  console.log("Variations:");
  console.table(vars.map(v => ({ id: v.id, sku: v.sku, productId: v.productId, unitsPerVariant: v.unitsPerVariant, hierarchyLevel: v.hierarchyLevel })));
  process.exit(0);
}
run();
