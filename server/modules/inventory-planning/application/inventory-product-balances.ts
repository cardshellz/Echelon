import { z } from "zod";
import { PRODUCT_INVENTORY_STRATEGIES } from "@shared/catalog/inventory-strategy";

const quantity = z.coerce.number().int().safe();

/** Physical projection only. Neither Catalog flags nor these totals authorize ATP. */
export const inventoryProductBalancesSchema = z.object({
  productId: z.number().int().positive(),
  sku: z.string(),
  name: z.string(),
  inventoryStrategy: z.enum(PRODUCT_INVENTORY_STRATEGIES),
  variants: z.array(z.object({
    productVariantId: z.number().int().positive(),
    sku: z.string(),
    name: z.string(),
    isActive: z.boolean(),
    unitsPerVariant: quantity.positive(),
    physicalQty: quantity,
    reservedQty: quantity,
    pickedQty: quantity,
  })),
});

export type InventoryProductBalances = z.infer<typeof inventoryProductBalancesSchema>;

export function totalBalanceBaseUnits(
  variants: InventoryProductBalances["variants"],
  field: "physicalQty" | "reservedQty",
): number {
  const total = variants.reduce((sum, variant) => sum + BigInt(variant[field]) * BigInt(variant.unitsPerVariant), BigInt(0));
  const value = Number(total);
  if (!Number.isSafeInteger(value)) throw new RangeError(`Inventory ${field} base-unit total exceeds safe integer range.`);
  return value;
}
