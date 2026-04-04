import "dotenv/config";
import { db } from "./server/db";
import { productVariants, products } from "@shared/schema";
import { ilike } from "drizzle-orm";

async function run() {
  const vars = await db.select().from(productVariants).where(ilike(productVariants.sku, '%arm-env-sgl%'));
  console.log("Variants found:");
  vars.forEach(v => {
    console.log(`ID: ${v.id}, SKU: ${v.sku}, ProductID: ${v.productId}, Units: ${v.unitsPerVariant}, Level: ${v.hierarchyLevel}`);
  });
  process.exit();
}
run();
