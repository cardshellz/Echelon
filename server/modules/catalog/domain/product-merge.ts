import { createHash } from "node:crypto";
import {
  MAX_PRODUCT_MERGE_EVIDENCE,
  MAX_PRODUCT_MERGE_OPEN_ORDERS,
  MAX_PRODUCT_MERGE_VARIANTS,
  MAX_SKU_LENGTH,
  type ProductMergeBlocker,
  type ProductMergePreview,
  type ProductMergeRequest,
} from "@shared/catalog/product-merge";

/**
 * Pure product-merge rules. No I/O, no clock: the repository supplies a locked
 * or read-only snapshot and these functions decide what may move and what
 * blocks the merge. The same evaluation runs in preview and again inside the
 * merge transaction, so a stale preview is detected by hash comparison.
 */

export interface MergeProductRow { id: number; sku: string | null; name: string; status: string | null; isActive: boolean }
export interface MergeVariantRow {
  id: number; productId: number; sku: string | null; name: string; unitsPerVariant: number;
  isActive: boolean; trackInventory: boolean;
}
export interface MergeStockRow { productVariantId: number; onHand: number; reserved: number; picked: number; packed: number }
export interface MergeOpenOrderLine {
  omsOrderId: number | null; omsLineId: number | null; wmsOrderId: number | null; wmsItemId: number | null;
  orderNumber: string | null; warehouseStatus: string | null; productVariantId: number;
  quantity: number; pickedQuantity: number; fulfilledQuantity: number; hasFulfillmentPlan: boolean;
}
export interface MergePurchaseLine {
  lineId: number; purchaseOrderId: number; poNumber: string | null; status: string;
  productVariantId: number | null; expectedReceiveVariantId: number | null; vendorProductId: number | null;
  orderQty: number; receivedQty: number; damagedQty: number; returnedQty: number;
}
export interface MergeSupplierLink { id: number; vendorId: number; productId: number; productVariantId: number | null; isActive: boolean }

export interface ProductMergeSnapshot {
  source: MergeProductRow | null;
  target: MergeProductRow | null;
  sourceVariants: MergeVariantRow[];
  targetVariants: MergeVariantRow[];
  stock: MergeStockRow[];
  binAssignments: Array<{ productVariantId: number; count: number }>;
  openOrderLines: MergeOpenOrderLine[];
  purchaseLines: MergePurchaseLine[];
  supplierLinks: MergeSupplierLink[];
  /** Active channel listings, feeds, product identities and publication mappings on the source. */
  sourceChannelLinks: number;
  /** Active variant SKUs (upper-cased) owned by products other than source and target. */
  foreignActiveVariantSkus: string[];
  /** Product SKUs (upper-cased) owned by products other than source and target. */
  foreignProductSkus: string[];
  history: { shippedOrderLines: number; inventoryTransactions: number };
}

/** Warehouse states in which no unit has been physically handled yet. A null
 * state is an OMS line that has not materialized into a WMS order. */
const UNSTARTED_WAREHOUSE_STATUSES = new Set(["ready", "exception"]);
/** PO line states that are history and stay on the archived source. */
const CLOSED_PO_LINE_STATUSES = new Set(["received", "closed", "cancelled"]);

export interface ResolvedPair { source: MergeVariantRow; target: MergeVariantRow | null }

/** Pair source variants to target variants. Explicit pairs win; otherwise a
 * source variant pairs with the single active target variant that has the same
 * units per variant. Ambiguity is never guessed: it leaves the variant unpaired. */
export function resolveVariantPairs(
  sourceVariants: readonly MergeVariantRow[],
  targetVariants: readonly MergeVariantRow[],
  explicit: ProductMergeRequest["variantPairs"],
): ResolvedPair[] {
  const targetsById = new Map(targetVariants.map(variant => [variant.id, variant]));
  const activeSources = sourceVariants.filter(variant => variant.isActive);
  if (explicit) {
    const bySource = new Map(explicit.map(pair => [pair.sourceVariantId, pair.targetVariantId]));
    return activeSources.map(source => {
      const targetId = bySource.get(source.id);
      return { source, target: targetId === undefined ? null : targetsById.get(targetId) ?? null };
    });
  }
  const activeTargets = targetVariants.filter(variant => variant.isActive);
  return activeSources.map(source => {
    const candidates = activeTargets.filter(target => target.unitsPerVariant === source.unitsPerVariant);
    return { source, target: candidates.length === 1 ? candidates[0] : null };
  });
}

/** Same derivation the product SKU rename uses: a variant SKU equal to, or
 * prefixed by, the old product SKU follows the new product SKU. */
export function deriveVariantSku(oldProductSku: string | null, newProductSku: string | null, variantSku: string | null): string | null {
  if (!variantSku || !oldProductSku || !newProductSku || oldProductSku === newProductSku) return variantSku;
  if (variantSku === oldProductSku) return newProductSku;
  if (variantSku.startsWith(`${oldProductSku}-`)) return newProductSku + variantSku.slice(oldProductSku.length);
  return variantSku;
}

/** The archived source keeps a recognisable SKU that can never collide with a
 * live one; catalog.products.sku is unique even for archived rows. */
export function retiredSku(sku: string | null, ownerId: number): string | null {
  return sku ? `${sku}-MERGED-${ownerId}` : null;
}

export function isOrderLineMovable(line: MergeOpenOrderLine): boolean {
  const unstarted = line.warehouseStatus === null || UNSTARTED_WAREHOUSE_STATUSES.has(line.warehouseStatus);
  return unstarted && line.pickedQuantity === 0 && line.fulfilledQuantity === 0 && !line.hasFulfillmentPlan;
}

export function isPurchaseLineOpen(line: MergePurchaseLine): boolean {
  return !CLOSED_PO_LINE_STATUSES.has(line.status);
}

export function isPurchaseLineMovable(line: MergePurchaseLine): boolean {
  return line.status === "open" && line.receivedQty === 0 && line.damagedQty === 0 && line.returnedQty === 0;
}

/** Distinct WMS orders whose reservations must be released before stock moves. */
export function ordersToRelease(lines: readonly MergeOpenOrderLine[]): number[] {
  return [...new Set(lines.map(line => line.wmsOrderId).filter((orderId): orderId is number => orderId !== null))]
    .sort((a, b) => a - b);
}

function stockFor(snapshot: ProductMergeSnapshot, variantId: number) {
  return snapshot.stock.filter(row => row.productVariantId === variantId).reduce((sum, row) => ({
    onHand: sum.onHand + row.onHand, reserved: sum.reserved + row.reserved,
    picked: sum.picked + row.picked, packed: sum.packed + row.packed,
  }), { onHand: 0, reserved: 0, picked: 0, packed: 0 });
}

export interface ProductMergeEvaluation {
  preview: Omit<ProductMergePreview, "previewHash">;
  pairs: ResolvedPair[];
  /** Fields that must not change between preview and execution. Reservation
   * quantities are excluded: releasing order holds is part of the merge. */
  hashBasis: unknown;
}

export function evaluateProductMerge(
  sourceProductId: number,
  request: ProductMergeRequest,
  snapshot: ProductMergeSnapshot,
): ProductMergeEvaluation {
  const blockers: ProductMergeBlocker[] = [];
  const block = (code: ProductMergeBlocker["code"], message: string, variantId: number | null = null) =>
    blockers.push({ code, message, variantId });

  const missing = (id: number): MergeProductRow => ({ id, sku: null, name: "(not found)", status: null, isActive: false });
  const source = snapshot.source ?? missing(sourceProductId);
  const target = snapshot.target ?? missing(request.targetProductId);
  if (sourceProductId === request.targetProductId) block("MERGE_SAME_PRODUCT", "A product cannot be merged into itself");
  if (!snapshot.source) block("MERGE_SOURCE_NOT_FOUND", "The product being merged was not found");
  if (!snapshot.target) block("MERGE_TARGET_NOT_FOUND", "The product to merge into was not found");
  if (snapshot.source && (snapshot.source.status === "archived" || !snapshot.source.isActive)) {
    block("MERGE_SOURCE_ARCHIVED", "The product being merged is already archived");
  }
  if (snapshot.target && (snapshot.target.status === "archived" || !snapshot.target.isActive)) {
    block("MERGE_TARGET_INACTIVE", "The product to merge into is archived or inactive");
  }
  if (snapshot.sourceVariants.length > MAX_PRODUCT_MERGE_VARIANTS || snapshot.targetVariants.length > MAX_PRODUCT_MERGE_VARIANTS) {
    block("MERGE_TOO_MANY_VARIANTS", `Products with more than ${MAX_PRODUCT_MERGE_VARIANTS} variants need a reviewed batch merge`);
  }

  const pairs = resolveVariantPairs(snapshot.sourceVariants, snapshot.targetVariants, request.variantPairs);
  const sourceIds = new Set(snapshot.sourceVariants.map(variant => variant.id));
  for (const pair of request.variantPairs ?? []) {
    const sourceVariant = snapshot.sourceVariants.find(variant => variant.id === pair.sourceVariantId);
    const targetVariant = snapshot.targetVariants.find(variant => variant.id === pair.targetVariantId);
    if (!sourceVariant?.isActive || !targetVariant?.isActive) {
      block("MERGE_PAIR_INVALID", `Pair ${pair.sourceVariantId} → ${pair.targetVariantId} must name an active variant of each product`,
        pair.sourceVariantId);
    }
  }
  const usedTargets = new Map<number, number>();
  for (const pair of pairs) {
    if (!pair.target) {
      block("MERGE_VARIANT_UNPAIRED", `Choose which ${target.sku ?? "target"} variant receives ${pair.source.sku ?? pair.source.id}`, pair.source.id);
      continue;
    }
    const previous = usedTargets.get(pair.target.id);
    if (previous !== undefined) {
      block("MERGE_PAIR_DUPLICATE_TARGET", `Variants ${previous} and ${pair.source.id} cannot both merge into ${pair.target.sku ?? pair.target.id}`, pair.source.id);
    }
    usedTargets.set(pair.target.id, pair.source.id);
    if (pair.target.unitsPerVariant !== pair.source.unitsPerVariant) {
      block("MERGE_UNITS_MISMATCH", `${pair.source.sku} holds ${pair.source.unitsPerVariant} units but ${pair.target.sku} holds ${pair.target.unitsPerVariant}`, pair.source.id);
    }
    if (pair.target.trackInventory !== pair.source.trackInventory) {
      block("MERGE_TRACKING_MISMATCH", `${pair.source.sku} and ${pair.target.sku} must have the same inventory tracking setting`, pair.source.id);
    }
  }

  if (snapshot.sourceChannelLinks > 0) {
    block("MERGE_SOURCE_CHANNEL_LINKED",
      `${source.sku ?? "This product"} is linked to ${snapshot.sourceChannelLinks} channel listing(s). Merge in the other direction, or unlink it first, so channel links are never moved silently`);
  }

  const sourceLines = snapshot.openOrderLines.filter(line => sourceIds.has(line.productVariantId));
  for (const line of sourceLines.filter(line => !isOrderLineMovable(line))) {
    block("MERGE_SOURCE_ORDER_IN_PROGRESS",
      `Order ${line.orderNumber ?? line.wmsOrderId ?? line.omsOrderId} is already being picked, packed or shipped. Finish it before merging`,
      line.productVariantId);
  }
  if (ordersToRelease(sourceLines).length > MAX_PRODUCT_MERGE_OPEN_ORDERS) {
    block("MERGE_TOO_MANY_OPEN_ORDERS", `More than ${MAX_PRODUCT_MERGE_OPEN_ORDERS} open orders use this product`);
  }

  const openPurchaseLines = snapshot.purchaseLines.filter(isPurchaseLineOpen);
  for (const line of openPurchaseLines.filter(line => !isPurchaseLineMovable(line))) {
    block("MERGE_SOURCE_PO_LINE_IN_RECEIVING", `${line.poNumber ?? `PO line ${line.lineId}`} is partially received. Finish or close it before merging`,
      line.productVariantId);
  }

  // SKU outcome. Both checks are case-insensitive, like the variant SKU index.
  const resultingTargetProductSku = request.adoptSourceSku ? source.sku : target.sku;
  const resultingSourceProductSku = retiredSku(source.sku, source.id);
  const foreignVariantSkus = new Set(snapshot.foreignActiveVariantSkus);
  const foreignProductSkus = new Set(snapshot.foreignProductSkus);
  const resultingVariantSku = (variant: MergeVariantRow) =>
    request.adoptSourceSku ? deriveVariantSku(target.sku, source.sku, variant.sku) : variant.sku;
  if (request.adoptSourceSku && resultingTargetProductSku && foreignProductSkus.has(resultingTargetProductSku.toUpperCase())) {
    block("MERGE_SKU_CONFLICT", `Another product already uses SKU ${resultingTargetProductSku}`);
  }
  for (const sku of [resultingSourceProductSku, ...snapshot.sourceVariants.map(variant => retiredSku(variant.sku, variant.id))]) {
    if (sku && sku.length > MAX_SKU_LENGTH) block("MERGE_SKU_TOO_LONG", `Retired SKU ${sku} exceeds ${MAX_SKU_LENGTH} characters`);
  }
  if (request.adoptSourceSku) {
    for (const variant of snapshot.targetVariants.filter(row => row.isActive)) {
      const next = resultingVariantSku(variant);
      if (!next || next === variant.sku) continue;
      if (next.length > MAX_SKU_LENGTH) block("MERGE_SKU_TOO_LONG", `SKU ${next} exceeds ${MAX_SKU_LENGTH} characters`, variant.id);
      if (foreignVariantSkus.has(next.toUpperCase())) block("MERGE_SKU_CONFLICT", `Another product already uses SKU ${next}`, variant.id);
    }
  }

  const pairPreviews = pairs.map(pair => ({
    source: variantSummary(pair.source),
    target: pair.target ? variantSummary(pair.target) : null,
    stock: stockFor(snapshot, pair.source.id),
    binAssignments: snapshot.binAssignments.find(row => row.productVariantId === pair.source.id)?.count ?? 0,
    resultingTargetSku: pair.target ? resultingVariantSku(pair.target) : null,
  }));

  const preview: Omit<ProductMergePreview, "previewHash"> = {
    status: blockers.length === 0 ? "ready" : "blocked",
    source, target,
    resultingTargetProductSku,
    resultingSourceProductSku,
    pairs: pairPreviews,
    openOrders: {
      total: sourceLines.length,
      records: sourceLines.slice(0, MAX_PRODUCT_MERGE_EVIDENCE).map(line => ({
        wmsOrderId: line.wmsOrderId, omsOrderId: line.omsOrderId, orderNumber: line.orderNumber,
        warehouseStatus: line.warehouseStatus, sourceVariantId: line.productVariantId,
        quantity: line.quantity, movable: isOrderLineMovable(line),
      })),
    },
    purchaseOrderLines: {
      total: openPurchaseLines.length,
      records: openPurchaseLines.slice(0, MAX_PRODUCT_MERGE_EVIDENCE).map(line => ({
        lineId: line.lineId, poNumber: line.poNumber, poStatus: line.status, sourceVariantId: line.productVariantId,
        orderQty: line.orderQty, receivedQty: line.receivedQty, movable: isPurchaseLineMovable(line),
      })),
    },
    supplierLinks: snapshot.supplierLinks.filter(link => link.productId === source.id && link.isActive).length,
    channelLinks: snapshot.sourceChannelLinks,
    historyRetained: snapshot.history,
    blockers,
  };

  const hashBasis = {
    version: 1,
    request: { sourceProductId, targetProductId: request.targetProductId, adoptSourceSku: request.adoptSourceSku,
      pairs: pairs.map(pair => [pair.source.id, pair.target?.id ?? null]) },
    source, target,
    sourceVariants: snapshot.sourceVariants, targetVariants: snapshot.targetVariants,
    onHand: snapshot.stock.filter(row => sourceIds.has(row.productVariantId))
      .map(row => [row.productVariantId, row.onHand]).sort(compareTuples),
    orderLines: sourceLines.map(line => [line.omsLineId, line.wmsItemId, line.productVariantId, line.quantity, line.warehouseStatus])
      .sort(compareTuples),
    purchaseLines: openPurchaseLines.map(line => [line.lineId, line.status, line.productVariantId, line.orderQty]).sort(compareTuples),
    supplierLinks: snapshot.supplierLinks.map(link => [link.id, link.productId, link.productVariantId, link.isActive]).sort(compareTuples),
    sourceChannelLinks: snapshot.sourceChannelLinks,
    blockers: blockers.map(blocker => blocker.code).sort(),
  };
  return { preview, pairs, hashBasis };
}

function variantSummary(variant: MergeVariantRow) {
  return { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant,
    isActive: variant.isActive, trackInventory: variant.trackInventory };
}

function compareTuples(a: unknown[], b: unknown[]): number {
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
}

export function productMergeHash(hashBasis: unknown): string {
  return createHash("sha256").update(JSON.stringify(hashBasis)).digest("hex");
}

/** Stable request identity for idempotency-key reuse detection. */
export function productMergeRequestHash(sourceProductId: number, request: ProductMergeRequest & { expectedPreviewHash: string }): string {
  return createHash("sha256").update(JSON.stringify({
    sourceProductId, targetProductId: request.targetProductId, adoptSourceSku: request.adoptSourceSku,
    variantPairs: [...(request.variantPairs ?? [])].sort((a, b) => a.sourceVariantId - b.sourceVariantId),
    expectedPreviewHash: request.expectedPreviewHash,
  })).digest("hex");
}
