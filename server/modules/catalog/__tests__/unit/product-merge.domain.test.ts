import { describe, expect, it } from "vitest";
import {
  deriveVariantSku,
  evaluateProductMerge,
  isOrderLineMovable,
  ordersToRelease,
  productMergeHash,
  resolveVariantPairs,
  retiredSku,
  type MergeOpenOrderLine,
  type MergeVariantRow,
  type ProductMergeSnapshot,
} from "../../domain/product-merge";
import { MAX_PRODUCT_MERGE_OPEN_ORDERS, type ProductMergeRequest } from "@shared/catalog/product-merge";

// Mirrors the production case: duplicate SHLZ-TOP-75PT-BLU (101) into SHLZ-TOP-75PT (17).
const variant = (overrides: Partial<MergeVariantRow> & Pick<MergeVariantRow, "id" | "productId" | "sku" | "unitsPerVariant">): MergeVariantRow => ({
  name: overrides.sku ?? "", isActive: true, trackInventory: true, ...overrides,
});
const SOURCE_P25 = variant({ id: 439, productId: 101, sku: "SHLZ-TOP-75PT-BLU-P25", unitsPerVariant: 25 });
const SOURCE_C800 = variant({ id: 204, productId: 101, sku: "SHLZ-TOP-75PT-BLU-C800", unitsPerVariant: 800 });
const TARGET_P25 = variant({ id: 33, productId: 17, sku: "SHLZ-TOP-75PT-P25", unitsPerVariant: 25 });
const TARGET_C800 = variant({ id: 34, productId: 17, sku: "SHLZ-TOP-75PT-C800", unitsPerVariant: 800 });

const openLine = (overrides: Partial<MergeOpenOrderLine> = {}): MergeOpenOrderLine => ({
  omsOrderId: 1243390, omsLineId: 124932, wmsOrderId: 210898, wmsItemId: 327227, orderNumber: "#65356",
  warehouseStatus: "ready", productVariantId: 439, quantity: 1, pickedQuantity: 0, fulfilledQuantity: 0,
  hasFulfillmentPlan: false, ...overrides,
});

function snapshot(overrides: Partial<ProductMergeSnapshot> = {}): ProductMergeSnapshot {
  return {
    source: { id: 101, sku: "SHLZ-TOP-75PT-BLU", name: "SHLZ-TOP-75PT-BLU", status: "active", isActive: true },
    target: { id: 17, sku: "SHLZ-TOP-75PT", name: "75PT Toploader", status: "active", isActive: true },
    sourceVariants: [SOURCE_C800, SOURCE_P25],
    targetVariants: [TARGET_P25, TARGET_C800],
    stock: [
      { productVariantId: 439, onHand: 32, reserved: 0, picked: 0, packed: 0 },
      { productVariantId: 204, onHand: 29, reserved: 0, picked: 0, packed: 0 },
      { productVariantId: 204, onHand: 6, reserved: 6, picked: 0, packed: 0 },
    ],
    binAssignments: [{ productVariantId: 439, count: 1 }],
    openOrderLines: [openLine()],
    purchaseLines: [{ lineId: 264, purchaseOrderId: 9, poNumber: "PO-20261108-001", status: "open", productVariantId: 204,
      expectedReceiveVariantId: 204, vendorProductId: 5, orderQty: 28800, receivedQty: 0, damagedQty: 0, returnedQty: 0 }],
    supplierLinks: [{ id: 5, vendorId: 2, productId: 101, productVariantId: 204, isActive: true }],
    sourceChannelLinks: 0,
    foreignActiveVariantSkus: [],
    foreignProductSkus: [],
    history: { shippedOrderLines: 1, inventoryTransactions: 13 },
    ...overrides,
  };
}
const request: ProductMergeRequest = { targetProductId: 17, adoptSourceSku: true };

describe("product merge pairing", () => {
  it("pairs each source variant with the single target variant of the same pack size", () => {
    const pairs = resolveVariantPairs([SOURCE_C800, SOURCE_P25], [TARGET_P25, TARGET_C800], undefined);
    expect(pairs.map(pair => [pair.source.id, pair.target?.id])).toEqual([[204, 34], [439, 33]]);
  });

  it("never guesses when two target variants share a pack size", () => {
    const twin = variant({ id: 99, productId: 17, sku: "SHLZ-TOP-75PT-P25B", unitsPerVariant: 25 });
    const pairs = resolveVariantPairs([SOURCE_P25], [TARGET_P25, twin], undefined);
    expect(pairs[0].target).toBeNull();
  });

  it("uses explicit pairs and ignores inactive source variants", () => {
    const retired = { ...SOURCE_C800, isActive: false };
    const pairs = resolveVariantPairs([retired, SOURCE_P25], [TARGET_P25, TARGET_C800],
      [{ sourceVariantId: 439, targetVariantId: 33 }]);
    expect(pairs.map(pair => [pair.source.id, pair.target?.id])).toEqual([[439, 33]]);
  });
});

describe("SKU derivation", () => {
  it("matches the product-edit rename rule", () => {
    expect(deriveVariantSku("SHLZ-TOP-75PT", "SHLZ-TOP-75PT-BLU", "SHLZ-TOP-75PT-P25")).toBe("SHLZ-TOP-75PT-BLU-P25");
    expect(deriveVariantSku("SHLZ-TOP-75PT", "SHLZ-TOP-75PT-BLU", "SHLZ-TOP-75PT")).toBe("SHLZ-TOP-75PT-BLU");
    // A prefix that is not followed by "-" is a different SKU and is left alone.
    expect(deriveVariantSku("SHLZ-TOP-75PT", "SHLZ-TOP-75PT-BLU", "SHLZ-TOP-75PTX")).toBe("SHLZ-TOP-75PTX");
    expect(deriveVariantSku(null, "X", "Y")).toBe("Y");
  });

  it("retires a SKU with a suffix that cannot collide with a live one", () => {
    expect(retiredSku("SHLZ-TOP-75PT-BLU", 101)).toBe("SHLZ-TOP-75PT-BLU-MERGED-101");
    expect(retiredSku(null, 1)).toBeNull();
  });
});

describe("open order movability", () => {
  it("moves only unstarted lines", () => {
    expect(isOrderLineMovable(openLine())).toBe(true);
    expect(isOrderLineMovable(openLine({ warehouseStatus: null, wmsOrderId: null, wmsItemId: null }))).toBe(true);
    expect(isOrderLineMovable(openLine({ pickedQuantity: 1 }))).toBe(false);
    expect(isOrderLineMovable(openLine({ fulfilledQuantity: 1 }))).toBe(false);
    expect(isOrderLineMovable(openLine({ warehouseStatus: "picking" }))).toBe(false);
    expect(isOrderLineMovable(openLine({ warehouseStatus: "partially_shipped" }))).toBe(false);
    expect(isOrderLineMovable(openLine({ warehouseStatus: "oms:partially_shipped" }))).toBe(false);
    expect(isOrderLineMovable(openLine({ hasFulfillmentPlan: true }))).toBe(false);
  });

  it("releases each WMS order once, in id order", () => {
    expect(ordersToRelease([openLine({ wmsOrderId: 9 }), openLine({ wmsOrderId: 3 }), openLine({ wmsOrderId: 9 }),
      openLine({ wmsOrderId: null })])).toEqual([3, 9]);
  });
});

describe("evaluateProductMerge", () => {
  it("is ready for the production duplicate and previews the resulting SKUs", () => {
    const { preview } = evaluateProductMerge(101, request, snapshot());
    expect(preview.blockers).toEqual([]);
    expect(preview.status).toBe("ready");
    expect(preview.resultingTargetProductSku).toBe("SHLZ-TOP-75PT-BLU");
    expect(preview.resultingSourceProductSku).toBe("SHLZ-TOP-75PT-BLU-MERGED-101");
    expect(preview.pairs.map(pair => [pair.source.id, pair.resultingTargetSku])).toEqual([
      [204, "SHLZ-TOP-75PT-BLU-C800"], [439, "SHLZ-TOP-75PT-BLU-P25"],
    ]);
    expect(preview.pairs.find(pair => pair.source.id === 204)!.stock).toEqual({ onHand: 35, reserved: 6, picked: 0, packed: 0 });
    expect(preview.openOrders.total).toBe(1);
    expect(preview.purchaseOrderLines.total).toBe(1);
  });

  it("keeps target SKUs when not adopting the source SKU", () => {
    const { preview } = evaluateProductMerge(101, { ...request, adoptSourceSku: false }, snapshot());
    expect(preview.resultingTargetProductSku).toBe("SHLZ-TOP-75PT");
    expect(preview.pairs.map(pair => pair.resultingTargetSku)).toEqual(["SHLZ-TOP-75PT-C800", "SHLZ-TOP-75PT-P25"]);
  });

  const blockerCodes = (input: ProductMergeSnapshot, req = request) =>
    evaluateProductMerge(101, req, input).preview.blockers.map(blocker => blocker.code);

  it("blocks merging into itself and missing or archived products", () => {
    expect(blockerCodes(snapshot(), { ...request, targetProductId: 101 })).toContain("MERGE_SAME_PRODUCT");
    expect(blockerCodes(snapshot({ source: null }))).toContain("MERGE_SOURCE_NOT_FOUND");
    expect(blockerCodes(snapshot({ target: null }))).toContain("MERGE_TARGET_NOT_FOUND");
    expect(blockerCodes(snapshot({ source: { ...snapshot().source!, status: "archived" } }))).toContain("MERGE_SOURCE_ARCHIVED");
    expect(blockerCodes(snapshot({ target: { ...snapshot().target!, isActive: false } }))).toContain("MERGE_TARGET_INACTIVE");
  });

  it("blocks unpaired variants, pack-size mismatches and duplicate targets", () => {
    expect(blockerCodes(snapshot({ targetVariants: [TARGET_P25] }))).toContain("MERGE_VARIANT_UNPAIRED");
    expect(blockerCodes(snapshot(), { ...request, variantPairs: [
      { sourceVariantId: 439, targetVariantId: 34 }, { sourceVariantId: 204, targetVariantId: 34 },
    ] })).toEqual(expect.arrayContaining(["MERGE_UNITS_MISMATCH", "MERGE_PAIR_DUPLICATE_TARGET"]));
    expect(blockerCodes(snapshot(), { ...request, variantPairs: [{ sourceVariantId: 439, targetVariantId: 777 }] }))
      .toEqual(expect.arrayContaining(["MERGE_PAIR_INVALID", "MERGE_VARIANT_UNPAIRED"]));
  });

  it("blocks a tracking-policy mismatch", () => {
    expect(blockerCodes(snapshot({ targetVariants: [{ ...TARGET_P25, trackInventory: false }, TARGET_C800] })))
      .toContain("MERGE_TRACKING_MISMATCH");
  });

  it("blocks a source that owns channel links, so links never move silently", () => {
    expect(blockerCodes(snapshot({ sourceChannelLinks: 2 }))).toContain("MERGE_SOURCE_CHANNEL_LINKED");
  });

  it("blocks orders already in progress and too many open orders", () => {
    expect(blockerCodes(snapshot({ openOrderLines: [openLine({ pickedQuantity: 1 })] }))).toContain("MERGE_SOURCE_ORDER_IN_PROGRESS");
    const many = Array.from({ length: MAX_PRODUCT_MERGE_OPEN_ORDERS + 1 }, (_, index) => openLine({ wmsOrderId: index + 1, wmsItemId: index + 1 }));
    expect(blockerCodes(snapshot({ openOrderLines: many }))).toContain("MERGE_TOO_MANY_OPEN_ORDERS");
  });

  it("blocks partially received PO lines but treats closed lines as history", () => {
    const base = snapshot().purchaseLines[0];
    expect(blockerCodes(snapshot({ purchaseLines: [{ ...base, status: "partially_received", receivedQty: 10 }] })))
      .toContain("MERGE_SOURCE_PO_LINE_IN_RECEIVING");
    const closed = evaluateProductMerge(101, request, snapshot({ purchaseLines: [{ ...base, status: "received", receivedQty: 28800 }] }));
    expect(closed.preview.blockers).toEqual([]);
    expect(closed.preview.purchaseOrderLines.total).toBe(0);
  });

  it("blocks SKU collisions with other products, case-insensitively", () => {
    expect(blockerCodes(snapshot({ foreignActiveVariantSkus: ["SHLZ-TOP-75PT-BLU-P25"] }))).toContain("MERGE_SKU_CONFLICT");
    expect(blockerCodes(snapshot({ foreignProductSkus: ["SHLZ-TOP-75PT-BLU"] }))).toContain("MERGE_SKU_CONFLICT");
    // Without adopting, the target's own SKUs do not change, so no collision check applies.
    expect(blockerCodes(snapshot({ foreignActiveVariantSkus: ["SHLZ-TOP-75PT-BLU-P25"] }), { ...request, adoptSourceSku: false }))
      .not.toContain("MERGE_SKU_CONFLICT");
  });

  it("blocks retired SKUs that would exceed the column width", () => {
    const longSku = "X".repeat(95);
    expect(blockerCodes(snapshot({ source: { ...snapshot().source!, sku: longSku } }))).toContain("MERGE_SKU_TOO_LONG");
  });
});

describe("preview hash", () => {
  it("ignores reservation changes, so releasing order holds does not stale the preview", () => {
    const before = evaluateProductMerge(101, request, snapshot()).hashBasis;
    const released = snapshot({ stock: snapshot().stock.map(row => ({ ...row, reserved: 0 })) });
    expect(productMergeHash(evaluateProductMerge(101, request, released).hashBasis)).toBe(productMergeHash(before));
  });

  it("changes when on-hand stock, open orders or the request change", () => {
    const base = productMergeHash(evaluateProductMerge(101, request, snapshot()).hashBasis);
    const moreStock = snapshot({ stock: [...snapshot().stock, { productVariantId: 439, onHand: 1, reserved: 0, picked: 0, packed: 0 }] });
    expect(productMergeHash(evaluateProductMerge(101, request, moreStock).hashBasis)).not.toBe(base);
    const newOrder = snapshot({ openOrderLines: [openLine(), openLine({ wmsOrderId: 5, wmsItemId: 6, omsLineId: 7 })] });
    expect(productMergeHash(evaluateProductMerge(101, request, newOrder).hashBasis)).not.toBe(base);
    expect(productMergeHash(evaluateProductMerge(101, { ...request, adoptSourceSku: false }, snapshot()).hashBasis)).not.toBe(base);
  });

  it("is independent of row order", () => {
    const reordered = snapshot({ stock: [...snapshot().stock].reverse() });
    expect(productMergeHash(evaluateProductMerge(101, request, reordered).hashBasis))
      .toBe(productMergeHash(evaluateProductMerge(101, request, snapshot()).hashBasis));
  });
});
