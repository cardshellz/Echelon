import { z } from "zod";

// Bound one interactive transaction, its locks, and the review payload.
export const MAX_BULK_INVENTORY_TRACKING_PRODUCTS = 500;
export const BULK_INVENTORY_TRACKING_PATH = "/api/products/inventory-tracking/bulk";
const id = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();

export const bulkInventoryTrackingRequestSchema = z.object({
  productIds: z.array(id).min(1).max(MAX_BULK_INVENTORY_TRACKING_PRODUCTS)
    .refine(ids => new Set(ids).size === ids.length, "Select each product only once"),
  inventoryTrackingDefault: z.boolean(),
}).strict();

export const bulkInventoryTrackingApplySchema = bulkInventoryTrackingRequestSchema.extend({
  expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const inventoryTrackingBlockerSchema = z.object({
  variantId: id.nullable(),
  code: z.string().min(1),
  message: z.string().min(1),
});

export const bulkInventoryTrackingProductSchema = z.object({
  productId: id,
  name: z.string(),
  sku: z.string().nullable(),
  currentDefault: z.boolean().nullable(),
  status: z.enum(["change", "unchanged", "blocked"]),
  variantCount: count,
  changingVariantCount: count,
  trackedOverrideCount: count,
  untrackedOverrideCount: count,
  blockers: z.array(inventoryTrackingBlockerSchema),
});

export const bulkInventoryTrackingPreviewSchema = z.object({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryTrackingDefault: z.boolean(),
  products: z.array(bulkInventoryTrackingProductSchema).min(1).max(MAX_BULK_INVENTORY_TRACKING_PRODUCTS),
});

export const bulkInventoryTrackingResultSchema = z.object({
  inventoryTrackingDefault: z.boolean(),
  changedProductIds: z.array(id).max(MAX_BULK_INVENTORY_TRACKING_PRODUCTS),
  unchangedProductIds: z.array(id).max(MAX_BULK_INVENTORY_TRACKING_PRODUCTS),
  changingVariantCount: count,
  trackedOverrideCount: count,
  untrackedOverrideCount: count,
});

export type BulkInventoryTrackingRequest = z.infer<typeof bulkInventoryTrackingRequestSchema>;
export type BulkInventoryTrackingApply = z.infer<typeof bulkInventoryTrackingApplySchema>;
export type BulkInventoryTrackingProduct = z.infer<typeof bulkInventoryTrackingProductSchema>;
export type BulkInventoryTrackingPreview = z.infer<typeof bulkInventoryTrackingPreviewSchema>;
export type BulkInventoryTrackingResult = z.infer<typeof bulkInventoryTrackingResultSchema>;
export type InventoryTrackingBlocker = z.infer<typeof inventoryTrackingBlockerSchema>;
