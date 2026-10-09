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
  "imageUrls",
  "ebayBrowseCategoryId",
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

/**
 * A whole-config replacement as a writer sends it: the config plus the
 * revision it was read at. The save is a compare-and-set on that revision
 * (migration 0728), so a writer that read an older config is refused instead
 * of overwriting a save it never saw.
 */
export const replaceDropshipStoreListingConfigRequestSchema = replaceDropshipStoreListingConfigInputSchema.extend({
  expectedRevision: z.number().int().positive().max(2_147_483_647),
}).strict();

export type ReplaceDropshipStoreListingConfigRequest = z.infer<
  typeof replaceDropshipStoreListingConfigRequestSchema
>;

/** Request keys are recorded in a ledger whose CHECK allows only these characters (migration 0728). */
export const dropshipListingConfigIdempotencyKeySchema = z.string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9:_-]+$/, "Request keys may only contain letters, numbers, colons, underscores, and hyphens.");
