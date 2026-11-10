import { z } from "zod";

/**
 * Product merge: fold a duplicate catalog product (the "source") into the
 * product that owns the channel links and history (the "target").
 *
 * The source's live stock, open (unpicked) orders, open purchase-order lines,
 * supplier links and bin assignments move to the paired target variants. The
 * source is then archived. Ledger history (transactions, shipped orders, lots
 * already consumed) intentionally stays on the source ids: financial history is
 * immutable, and the archived source keeps it readable.
 *
 * Optionally the target adopts the source's SKU, so channel orders that already
 * carry the new SKU text resolve to the surviving product.
 */

export const PRODUCT_MERGE_PREVIEW_PATH = (sourceProductId: number) => `/api/products/${sourceProductId}/merge/preview`;
export const PRODUCT_MERGE_EXECUTE_PATH = (sourceProductId: number) => `/api/products/${sourceProductId}/merge`;
export const PRODUCT_MERGE_RUN_PATH = (runId: number) => `/api/product-merges/${runId}`;
export const PRODUCT_MERGE_RESUME_PATH = (runId: number) => `/api/product-merges/${runId}/resume`;

/** Bounds one interactive merge: every open order is released and re-reserved
 * one at a time inside the HTTP request, which must finish well under the
 * 30-second router timeout. A larger set belongs in a reviewed batch. */
export const MAX_PRODUCT_MERGE_OPEN_ORDERS = 50;
/** Products carry a handful of pack sizes; this bounds locks and payloads. */
export const MAX_PRODUCT_MERGE_VARIANTS = 50;
/** Evidence rows shown per section; totals are always exact. */
export const MAX_PRODUCT_MERGE_EVIDENCE = 25;
/** catalog.products.sku / product_variants.sku column width. */
export const MAX_SKU_LENGTH = 100;

const id = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const variantPairSchema = z.object({ sourceVariantId: id, targetVariantId: id }).strict();

export const productMergeRequestSchema = z.object({
  targetProductId: id,
  /** Omit to accept the automatic pairing (same units per variant). */
  variantPairs: z.array(variantPairSchema).min(1).max(MAX_PRODUCT_MERGE_VARIANTS).optional(),
  /** Rename the target product (and its derived variant SKUs) to the source's SKU. */
  adoptSourceSku: z.boolean(),
}).strict();
export type ProductMergeRequest = z.infer<typeof productMergeRequestSchema>;

export const productMergeExecuteSchema = productMergeRequestSchema.extend({
  expectedPreviewHash: hash,
}).strict();
export type ProductMergeExecuteRequest = z.infer<typeof productMergeExecuteSchema>;

export const productMergeBlockerCodes = [
  "MERGE_SAME_PRODUCT",
  "MERGE_SOURCE_NOT_FOUND",
  "MERGE_TARGET_NOT_FOUND",
  "MERGE_SOURCE_ARCHIVED",
  "MERGE_TARGET_INACTIVE",
  "MERGE_TOO_MANY_VARIANTS",
  "MERGE_VARIANT_UNPAIRED",
  "MERGE_PAIR_INVALID",
  "MERGE_PAIR_DUPLICATE_TARGET",
  "MERGE_UNITS_MISMATCH",
  "MERGE_TRACKING_MISMATCH",
  "MERGE_SOURCE_CHANNEL_LINKED",
  "MERGE_SOURCE_ORDER_IN_PROGRESS",
  "MERGE_TOO_MANY_OPEN_ORDERS",
  "MERGE_SOURCE_PO_LINE_IN_RECEIVING",
  "MERGE_SKU_TOO_LONG",
  "MERGE_SKU_CONFLICT",
] as const;
export type ProductMergeBlockerCode = typeof productMergeBlockerCodes[number];

export const productMergeBlockerSchema = z.object({
  code: z.enum(productMergeBlockerCodes),
  message: z.string().min(1),
  variantId: id.nullable(),
});
export type ProductMergeBlocker = z.infer<typeof productMergeBlockerSchema>;

const productSummary = z.object({ id, sku: z.string().nullable(), name: z.string(), status: z.string().nullable(), isActive: z.boolean() });
const variantSummary = z.object({ id, sku: z.string().nullable(), name: z.string(), unitsPerVariant: count, isActive: z.boolean(),
  trackInventory: z.boolean() });

export const productMergePairPreviewSchema = z.object({
  source: variantSummary,
  target: variantSummary.nullable(),
  stock: z.object({ onHand: count, reserved: count, picked: count, packed: count }),
  binAssignments: count,
  /** SKU the target variant will carry after the merge. */
  resultingTargetSku: z.string().nullable(),
});

export const productMergeOrderPreviewSchema = z.object({
  wmsOrderId: id.nullable(),
  omsOrderId: id.nullable(),
  orderNumber: z.string().nullable(),
  warehouseStatus: z.string().nullable(),
  sourceVariantId: id,
  quantity: count,
  movable: z.boolean(),
});

export const productMergePurchaseLinePreviewSchema = z.object({
  lineId: id, poNumber: z.string().nullable(), poStatus: z.string(), sourceVariantId: id.nullable(),
  orderQty: count, receivedQty: count, movable: z.boolean(),
});

export const productMergePreviewSchema = z.object({
  status: z.enum(["ready", "blocked"]),
  previewHash: hash,
  source: productSummary,
  target: productSummary,
  /** Product SKUs after the merge (source is renamed to free its SKU). */
  resultingTargetProductSku: z.string().nullable(),
  resultingSourceProductSku: z.string().nullable(),
  pairs: z.array(productMergePairPreviewSchema),
  openOrders: z.object({ total: count, records: z.array(productMergeOrderPreviewSchema).max(MAX_PRODUCT_MERGE_EVIDENCE) }),
  purchaseOrderLines: z.object({ total: count, records: z.array(productMergePurchaseLinePreviewSchema).max(MAX_PRODUCT_MERGE_EVIDENCE) }),
  supplierLinks: count,
  channelLinks: count,
  /** Rows that stay on the archived source as history (counts only). */
  historyRetained: z.object({ shippedOrderLines: count, inventoryTransactions: count }),
  blockers: z.array(productMergeBlockerSchema),
});
export type ProductMergePreview = z.infer<typeof productMergePreviewSchema>;

export const productMergeRunStatuses = [
  "releasing", "merging", "reclaiming", "completed", "completed_with_review", "compensating", "failed",
] as const;
export type ProductMergeRunStatus = typeof productMergeRunStatuses[number];
export const TERMINAL_PRODUCT_MERGE_STATUSES: readonly ProductMergeRunStatus[] = ["completed", "completed_with_review", "failed"];

export const productMergeRunOrderSchema = z.object({
  wmsOrderId: id,
  /** null until the step ran; true when a live reservation was released. */
  released: z.boolean().nullable(),
  reclaimed: z.boolean().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
});
export type ProductMergeRunOrder = z.infer<typeof productMergeRunOrderSchema>;

export const productMergeResultSchema = z.object({
  stockUnitsMoved: count,
  stockLocationsMoved: count,
  orderLinesMoved: count,
  purchaseOrderLinesMoved: count,
  supplierLinksMoved: count,
  binAssignmentsMoved: count,
  variantsRenamed: count,
  sourceProductSku: z.string().nullable(),
  targetProductSku: z.string().nullable(),
});
export type ProductMergeResult = z.infer<typeof productMergeResultSchema>;

export const productMergeRunSchema = z.object({
  id,
  status: z.enum(productMergeRunStatuses),
  sourceProductId: id,
  targetProductId: id,
  orders: z.array(productMergeRunOrderSchema),
  result: productMergeResultSchema.nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductMergeRun = z.infer<typeof productMergeRunSchema>;
