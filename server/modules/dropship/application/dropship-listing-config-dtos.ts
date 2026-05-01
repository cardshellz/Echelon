import { z } from "zod";

export const dropshipListingModeSchema = z.enum(["draft_first", "live", "manual_only"]);
export const dropshipListingInventoryModeSchema = z.enum(["managed_quantity_sync", "manual_quantity", "disabled"]);
export const dropshipListingPriceModeSchema = z.enum(["vendor_defined", "connection_default", "disabled"]);

export const dropshipListingRequiredProductFieldSchema = z.enum([
  "sku",
  "productName",
  "variantName",
  "title",
  "description",
  "category",
  "brand",
  "gtin",
  "mpn",
  "condition",
  "itemSpecifics",
]);

const requiredConfigKeySchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.-]+$/, "Required config keys may only contain letters, numbers, dots, underscores, and hyphens.");

export const replaceDropshipStoreListingConfigInputSchema = z.object({
  listingMode: dropshipListingModeSchema,
  inventoryMode: dropshipListingInventoryModeSchema,
  priceMode: dropshipListingPriceModeSchema,
  marketplaceConfig: z.record(z.unknown()).default({}),
  requiredConfigKeys: z.array(requiredConfigKeySchema).max(100).default([]),
  requiredProductFields: z.array(dropshipListingRequiredProductFieldSchema).max(25).default([]),
  isActive: z.boolean(),
}).strict();

export type ReplaceDropshipStoreListingConfigInput = z.infer<
  typeof replaceDropshipStoreListingConfigInputSchema
>;
