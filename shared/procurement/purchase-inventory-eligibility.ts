import { z } from "zod";
import { isInventoryManagedVariant } from "../catalog/variant-inventory-eligibility";

const variantPoliciesSchema = z.array(z.object({
  requiresShipping: z.boolean().nullable(),
  trackInventory: z.boolean().nullable(),
}));

/** Only explicit catalog evidence excludes a product; missing legacy evidence stays unknown. */
export function isPurchaseInventoryManaged(policies: unknown): boolean {
  if (policies === undefined || policies === null) return true;
  const variants = variantPoliciesSchema.parse(policies);
  return variants.length === 0 || variants.some(isInventoryManagedVariant);
}
