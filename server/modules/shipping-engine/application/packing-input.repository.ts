/**
 * Packing-input loaders — read-only application-layer repository.
 *
 * Bridges the catalog/shipping schemas to the pure cartonizer: variant
 * dims/weight (catalog.product_variants) + shipping group code
 * (catalog.products → catalog.shipping_groups) + packing behavior
 * (shipping.variant_shipping_attrs, null-defaulted) into the exact
 * CartonizeItem shape cartonize() expects, and the active box suite
 * (shipping.box_catalog + box_warehouse_stock) into CartonizeBox[].
 *
 * NO writes here. Design: docs/SHIPPING-ENGINE-DESIGN.md.
 */

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import {
  productVariants,
  products,
  shippingBoxCatalog,
  shippingBoxWarehouseStock,
  shippingGroups,
  shippingVariantAttrs,
} from "@shared/schema";
import { db } from "../../../db";
import type { CartonizeBox, CartonizeItem } from "../domain/cartonize";

/**
 * Load per-variant packing inputs keyed by variant id.
 *
 * Returned CartonizeItems carry `quantity: 0` — the caller owns line
 * quantities and must spread its own (`{ ...input, quantity }`) before
 * handing them to cartonize(). Unknown variant ids are simply absent from
 * the map (caller decides how to degrade).
 */
export async function loadPackingInputs(
  variantIds: number[],
): Promise<Map<number, CartonizeItem>> {
  const uniqueIds = [...new Set(variantIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (uniqueIds.length === 0) return new Map();

  const rows = await db
    .select({
      productVariantId: productVariants.id,
      sku: productVariants.sku,
      weightGrams: productVariants.weightGrams,
      lengthMm: productVariants.lengthMm,
      widthMm: productVariants.widthMm,
      heightMm: productVariants.heightMm,
      shippingGroupCode: shippingGroups.code,
      shipsInOwnContainer: shippingVariantAttrs.shipsInOwnContainer,
      riderEligible: shippingVariantAttrs.riderEligible,
      riderVoidCm3: shippingVariantAttrs.riderVoidCm3,
      riderVoidMaxWeightGrams: shippingVariantAttrs.riderVoidMaxWeightGrams,
      riderVoidMaxItems: shippingVariantAttrs.riderVoidMaxItems,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(shippingGroups, eq(shippingGroups.id, products.shippingGroupId))
    .leftJoin(shippingVariantAttrs, eq(shippingVariantAttrs.productVariantId, productVariants.id))
    .where(inArray(productVariants.id, uniqueIds));

  const inputs = new Map<number, CartonizeItem>();
  for (const row of rows) {
    inputs.set(row.productVariantId, {
      productVariantId: row.productVariantId,
      sku: row.sku,
      quantity: 0, // caller sets the line quantity
      weightGrams: row.weightGrams,
      lengthMm: row.lengthMm,
      widthMm: row.widthMm,
      heightMm: row.heightMm,
      shippingGroupCode: row.shippingGroupCode ?? null,
      // No attrs row = default packing behavior (boxed, no rider/void).
      shipsInOwnContainer: row.shipsInOwnContainer ?? false,
      riderEligible: row.riderEligible ?? false,
      riderVoidCm3: row.riderVoidCm3 ?? null,
      riderVoidMaxWeightGrams: row.riderVoidMaxWeightGrams ?? null,
      riderVoidMaxItems: row.riderVoidMaxItems ?? null,
    });
  }
  return inputs;
}

/**
 * Resolve catalog variant ids by SKU (exact match). Both the Shopify
 * callback and shadow mode key on SKU: wms.order_items carries no variant
 * id (orders.schema.ts — sku/productId only), and Shopify's rate request
 * identifies items by SKU. Unresolved SKUs are absent from the map.
 * When duplicate active SKUs exist, the lowest variant id wins (stable).
 */
export async function resolveVariantIdsBySku(
  skus: string[],
): Promise<Map<string, number>> {
  const uniqueSkus = [...new Set(skus.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (uniqueSkus.length === 0) return new Map();

  const rows = await db
    .select({ id: productVariants.id, sku: productVariants.sku })
    .from(productVariants)
    .where(and(isNotNull(productVariants.sku), inArray(productVariants.sku, uniqueSkus)));

  const bySku = new Map<string, number>();
  for (const row of rows) {
    if (row.sku == null) continue;
    const incumbent = bySku.get(row.sku);
    if (incumbent === undefined || row.id < incumbent) bySku.set(row.sku, row.id);
  }
  return bySku;
}

/**
 * Load the active box suite for cartonization.
 *
 * Warehouse availability semantics: box_warehouse_stock is an OPT-IN
 * restriction. A box with NO stock rows at all is treated as available at
 * every warehouse (the catalog predates per-warehouse stocking and most
 * boxes are universal). A box WITH stock rows is only offered at
 * warehouses that have an is_stocked=true row. When no warehouseId is
 * given, every active box qualifies.
 */
export async function loadActiveBoxes(warehouseId?: number): Promise<CartonizeBox[]> {
  const boxes = await db
    .select({
      id: shippingBoxCatalog.id,
      code: shippingBoxCatalog.code,
      kind: shippingBoxCatalog.kind,
      lengthMm: shippingBoxCatalog.lengthMm,
      widthMm: shippingBoxCatalog.widthMm,
      heightMm: shippingBoxCatalog.heightMm,
      tareWeightGrams: shippingBoxCatalog.tareWeightGrams,
      maxWeightGrams: shippingBoxCatalog.maxWeightGrams,
      costCents: shippingBoxCatalog.costCents,
      fillFactorBps: shippingBoxCatalog.fillFactorBps,
      isActive: shippingBoxCatalog.isActive,
    })
    .from(shippingBoxCatalog)
    .where(eq(shippingBoxCatalog.isActive, true));

  const toCartonizeBox = (box: (typeof boxes)[number]): CartonizeBox => ({
    ...box,
    // The DB CHECK constrains kind to these values; coerce for the domain type.
    kind: box.kind as CartonizeBox["kind"],
  });

  if (warehouseId == null || boxes.length === 0) {
    return boxes.map(toCartonizeBox);
  }

  const stockRows = await db
    .select({
      boxId: shippingBoxWarehouseStock.boxId,
      warehouseId: shippingBoxWarehouseStock.warehouseId,
      isStocked: shippingBoxWarehouseStock.isStocked,
    })
    .from(shippingBoxWarehouseStock)
    .where(inArray(shippingBoxWarehouseStock.boxId, boxes.map((b) => b.id)));

  const restricted = new Set<number>();
  const stockedHere = new Set<number>();
  for (const row of stockRows) {
    restricted.add(row.boxId);
    if (row.warehouseId === warehouseId && row.isStocked) stockedHere.add(row.boxId);
  }

  return boxes
    .filter((box) => !restricted.has(box.id) || stockedHere.has(box.id))
    .map(toCartonizeBox);
}
