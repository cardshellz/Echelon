import { z } from "zod";

// Bound one interactive transaction, its locks, and the review payload.
export const MAX_BULK_INVENTORY_TRACKING_PRODUCTS = 500;
export const BULK_INVENTORY_TRACKING_PATH = "/api/products/inventory-tracking/bulk";
const id = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const quantity = z.number().int().safe();
const bigintText = z.string().regex(/^\d+$/);
export const MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS = 20;
const location = { locationId: id, locationCode: z.string().nullable() };
const custody = { onHand: quantity, reserved: quantity, picked: quantity, packed: quantity };
const warehouseOrder = z.object({ orderId: id, orderNumber: z.string(), status: z.string() });

export const inventoryTrackingEvidenceRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stock"), recordId: id, ...location, ...custody, backorder: quantity }),
  z.object({ kind: z.literal("lots"), recordId: id, lotNumber: z.string(), ...location, ...custody }),
  z.object({ kind: z.literal("open_orders"), recordId: id, orderId: id, orderNumber: z.string(),
    status: z.string(), itemStatus: z.string(), quantity, picked: quantity, fulfilled: quantity }),
  z.object({ kind: z.literal("oms_orders"), recordId: id, orderId: id, orderNumber: z.string().nullable(),
    status: z.string(), fulfillmentStatus: z.string().nullable(), quantity,
    warehouseOrders: z.array(warehouseOrder).max(MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS), warehouseOrderCount: count }),
  z.object({ kind: z.literal("claims"), recordId: bigintText, claimId: bigintText, orderItemId: id,
    planned: bigintText, released: bigintText, consumed: bigintText }),
  z.object({ kind: z.literal("resources"), recordId: bigintText, claimId: bigintText, ...location,
    claimed: bigintText, released: bigintText, consumed: bigintText }),
  z.object({ kind: z.literal("publication"), recordId: bigintText, state: z.string() }),
]);
export const inventoryTrackingEvidenceSchema = z.object({
  totalCount: count,
  records: z.array(inventoryTrackingEvidenceRecordSchema).max(MAX_INVENTORY_TRACKING_EVIDENCE_RECORDS),
});

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
  // Optional for compatibility with a server that has not yet deployed details.
  evidence: inventoryTrackingEvidenceSchema.optional(),
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
export type InventoryTrackingEvidence = z.infer<typeof inventoryTrackingEvidenceSchema>;
export type InventoryTrackingEvidenceRecord = z.infer<typeof inventoryTrackingEvidenceRecordSchema>;
