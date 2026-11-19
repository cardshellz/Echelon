import { and, asc, eq, sql } from "drizzle-orm";
import { inboundShipmentLines, poEvents, purchaseOrderLines, vendorProducts } from "@shared/schema";
import type { db } from "../../db";

/**
 * Procurement-owned command for a catalog product merge: re-point open,
 * unreceived purchase-order lines and supplier links from the retired source
 * product to the surviving target product.
 *
 * Rules:
 *  - Only lines with status `open` and zero received/damaged/returned units
 *    move. Received, closed and cancelled lines are history and stay on the
 *    archived source (the catalog preview blocks partially received lines).
 *  - A supplier link moves to the target unless the target already has a link
 *    with the same (vendor, variant) key; then the source link is deactivated
 *    and moved PO lines point at the target's link. A moved link drops its
 *    preferred flag when the target already has a preferred supplier for that
 *    variant (one active preferred per key is a schema invariant).
 *  - Every moved line gets a `product_identity_corrected` po_events row with
 *    before/after, matching the reviewed product-102 cleanup precedent.
 * Quantities, prices and costs are never changed.
 */
export class PurchasingProductMergeError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) {
    super(message);
    this.name = "PurchasingProductMergeError";
  }
}

type Executor = Pick<typeof db, "select" | "update" | "insert">;

export interface PurchasingProductMergeInput {
  sourceProductId: number;
  targetProductId: number;
  /** source variant id → target variant id, for every source variant. */
  variantMap: ReadonlyMap<number, number>;
  /** Old SKU text → SKU text the moved line should carry. */
  skuMap: ReadonlyMap<string, string>;
  actorId: string;
  mergeRunId: number;
  now: Date;
}

export interface PurchasingProductMergeResult { linesMoved: number; supplierLinksMoved: number; supplierLinksRetired: number }

const PO_EVENT_TYPE = "product_identity_corrected";

export async function mergePurchasingProductIdentity(
  executor: Executor,
  input: PurchasingProductMergeInput,
): Promise<PurchasingProductMergeResult> {
  const mapVariant = (variantId: number | null): number | null => {
    if (variantId === null) return null;
    const mapped = input.variantMap.get(variantId);
    if (mapped === undefined) {
      throw new PurchasingProductMergeError("PROCUREMENT_MERGE_VARIANT_UNMAPPED",
        `Source variant ${variantId} has no target variant`, { variantId });
    }
    return mapped;
  };

  // 1. Supplier links (locked in id order, like every other procurement writer).
  const sourceLinks = await executor.select().from(vendorProducts)
    .where(eq(vendorProducts.productId, input.sourceProductId)).orderBy(asc(vendorProducts.id)).for("update");
  const targetLinks = await executor.select().from(vendorProducts)
    .where(eq(vendorProducts.productId, input.targetProductId)).orderBy(asc(vendorProducts.id)).for("update");
  const linkRedirect = new Map<number, number>();
  let supplierLinksMoved = 0;
  let supplierLinksRetired = 0;
  for (const link of sourceLinks) {
    const targetVariantId = mapVariant(link.productVariantId);
    const existing = targetLinks.find(row => row.vendorId === link.vendorId && row.productVariantId === targetVariantId);
    if (existing) {
      linkRedirect.set(link.id, existing.id);
      if (link.isActive === 1) {
        await executor.update(vendorProducts).set({ isActive: 0, isPreferred: 0, updatedAt: input.now })
          .where(eq(vendorProducts.id, link.id));
        supplierLinksRetired++;
      }
      continue;
    }
    const targetHasPreferred = targetLinks.some(row => row.productVariantId === targetVariantId
      && row.isActive === 1 && row.isPreferred === 1);
    await executor.update(vendorProducts).set({
      productId: input.targetProductId,
      productVariantId: targetVariantId,
      ...(targetHasPreferred ? { isPreferred: 0 } : {}),
      updatedAt: input.now,
    }).where(eq(vendorProducts.id, link.id));
    supplierLinksMoved++;
  }

  // 2. Open, unreceived PO lines.
  const lines = await executor.select().from(purchaseOrderLines)
    .where(and(
      eq(purchaseOrderLines.productId, input.sourceProductId),
      eq(purchaseOrderLines.status, "open"),
      sql`COALESCE(${purchaseOrderLines.receivedQty}, 0) = 0`,
      sql`COALESCE(${purchaseOrderLines.damagedQty}, 0) = 0`,
      sql`COALESCE(${purchaseOrderLines.returnedQty}, 0) = 0`,
    ))
    .orderBy(asc(purchaseOrderLines.id)).for("update");
  for (const line of lines) {
    const before = {
      id: line.id, productId: line.productId, productVariantId: line.productVariantId,
      expectedReceiveVariantId: line.expectedReceiveVariantId, vendorProductId: line.vendorProductId, sku: line.sku,
    };
    const after = {
      id: line.id,
      productId: input.targetProductId,
      productVariantId: mapVariant(line.productVariantId),
      expectedReceiveVariantId: mapVariant(line.expectedReceiveVariantId),
      vendorProductId: line.vendorProductId === null ? null : linkRedirect.get(line.vendorProductId) ?? line.vendorProductId,
      sku: line.sku === null ? null : input.skuMap.get(line.sku) ?? line.sku,
    };
    const [updated] = await executor.update(purchaseOrderLines).set({
      productId: after.productId, productVariantId: after.productVariantId,
      expectedReceiveVariantId: after.expectedReceiveVariantId, vendorProductId: after.vendorProductId,
      sku: after.sku, updatedAt: input.now,
    }).where(and(eq(purchaseOrderLines.id, line.id), eq(purchaseOrderLines.productId, input.sourceProductId)))
      .returning({ id: purchaseOrderLines.id });
    if (!updated) {
      throw new PurchasingProductMergeError("PROCUREMENT_MERGE_LINE_CHANGED", `PO line ${line.id} changed during the merge`,
        { lineId: line.id });
    }
    await executor.insert(poEvents).values({
      poId: line.purchaseOrderId,
      eventType: PO_EVENT_TYPE,
      actorType: "user",
      actorId: input.actorId,
      payloadJson: { mergeRunId: input.mergeRunId, lineId: line.id, before, after },
      createdAt: input.now,
    });
    // Inbound shipment lines planned against this PO line follow it; they are
    // pre-receipt planning rows (receipts block the line above).
    for (const [sourceVariantId, targetVariantId] of input.variantMap) {
      await executor.update(inboundShipmentLines).set({ productVariantId: targetVariantId, updatedAt: input.now })
        .where(and(eq(inboundShipmentLines.purchaseOrderLineId, line.id),
          eq(inboundShipmentLines.productVariantId, sourceVariantId)));
    }
    for (const [oldSku, newSku] of input.skuMap) {
      await executor.update(inboundShipmentLines).set({ sku: newSku, updatedAt: input.now })
        .where(and(eq(inboundShipmentLines.purchaseOrderLineId, line.id), eq(inboundShipmentLines.sku, oldSku)));
    }
  }
  return { linesMoved: lines.length, supplierLinksMoved, supplierLinksRetired };
}

/** Read helper for the catalog preview (no writes). */
export async function readPurchasingMergeEvidence(executor: Pick<typeof db, "execute">, sourceProductId: number) {
  const result = await executor.execute(sql`
    SELECT line.id AS "lineId", line.purchase_order_id AS "purchaseOrderId", po.po_number AS "poNumber",
           line.status, line.product_variant_id AS "productVariantId",
           line.expected_receive_variant_id AS "expectedReceiveVariantId",
           line.vendor_product_id AS "vendorProductId", line.order_qty AS "orderQty",
           COALESCE(line.received_qty, 0) AS "receivedQty", COALESCE(line.damaged_qty, 0) AS "damagedQty",
           COALESCE(line.returned_qty, 0) AS "returnedQty"
    FROM procurement.purchase_order_lines line
    JOIN procurement.purchase_orders po ON po.id = line.purchase_order_id
    WHERE line.product_id = ${sourceProductId}
    ORDER BY line.id`);
  const links = await executor.execute(sql`
    SELECT id, vendor_id AS "vendorId", product_id AS "productId", product_variant_id AS "productVariantId",
           (COALESCE(is_active, 0) = 1) AS "isActive"
    FROM procurement.vendor_products WHERE product_id = ${sourceProductId} ORDER BY id`);
  return {
    lines: (result.rows as Array<Record<string, unknown>>).map(row => ({
      lineId: Number(row.lineId), purchaseOrderId: Number(row.purchaseOrderId), poNumber: row.poNumber as string | null,
      status: String(row.status), productVariantId: row.productVariantId === null ? null : Number(row.productVariantId),
      expectedReceiveVariantId: row.expectedReceiveVariantId === null ? null : Number(row.expectedReceiveVariantId),
      vendorProductId: row.vendorProductId === null ? null : Number(row.vendorProductId),
      orderQty: Number(row.orderQty), receivedQty: Number(row.receivedQty), damagedQty: Number(row.damagedQty),
      returnedQty: Number(row.returnedQty),
    })),
    supplierLinks: (links.rows as Array<Record<string, unknown>>).map(row => ({
      id: Number(row.id), vendorId: Number(row.vendorId), productId: Number(row.productId),
      productVariantId: row.productVariantId === null ? null : Number(row.productVariantId), isActive: Boolean(row.isActive),
    })),
  };
}

