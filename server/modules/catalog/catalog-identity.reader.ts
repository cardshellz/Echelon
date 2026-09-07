import { eq } from "drizzle-orm";
import { productVariants } from "@shared/schema";

/** Published catalog read; callers may hold a share lock in their own transaction. */
export async function readCatalogInventoryIdentity(
  client: Pick<typeof import("../../db").db, "select">,
  variantId: number,
  lock = false,
) {
  if (!Number.isSafeInteger(variantId) || variantId <= 0) throw new Error("Invalid catalog variant ID");
  let query = client.select({ id: productVariants.id, sku: productVariants.sku,
    requiresShipping: productVariants.requiresShipping, trackInventory: productVariants.trackInventory,
    salesEligibility: productVariants.salesEligibility,
  }).from(productVariants).where(eq(productVariants.id, variantId)).limit(1).$dynamic();
  if (lock) query = query.for("share");
  const [identity] = await query;
  return identity ?? null;
}
