import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { ReceivingService } from "../../receiving.service";
import { receivingUnitVersion } from "../../receiving-unit-contract";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const RECORDED_AT = new Date("2026-09-05T12:00:00.000Z");
const ACTOR = "receipt-import-operator";
const MAX_PG_INTEGER = 2_147_483_647;
const dialect = new PgDialect();

function receiptLine() {
  return {
    id: 11, receivingOrderId: 10, sku: "PACK-250", productName: "Pack",
    productId: 1 as number | null, productVariantId: 100 as number | null,
    purchaseOrderLineId: null as number | null, inboundShipmentLineId: null as number | null,
    unitsPerVariantSnapshot: 250 as number | null,
    expectedQty: 4, receivedQty: 2, damagedQty: 1,
    putawayLocationId: 99 as number | null, putawayComplete: 0,
    status: "partial", unitCost: 4 as number | null, unitCostMills: 375 as number | null,
    updatedAt: RECORDED_AT,
  };
}
type TestLine = ReturnType<typeof receiptLine>;
type TestOrder = {
  id: number; status: string; sourceType: string; vendorId: number | null;
  warehouseId: number; purchaseOrderId: number | null; inboundShipmentId: number | null;
  updatedAt: Date;
};
type TestVariant = { id: number; sku: string; name: string; productId: number; unitsPerVariant: number; isActive: boolean };
type PurchaseSource = { id: number; purchaseOrderId: number; productId: number; lineType: string };
type ShipmentSource = { inbound_shipment_id: number; purchase_order_id: number; purchase_order_line_id: number; qty_shipped: number };

/** Executes the real owner service with an observable storage boundary. This
 * harness proves validation and submitted writes, not PostgreSQL rollback or
 * lock exclusion; the receiving integration suite owns those proofs. */
function harness(options: {
  lines?: TestLine[];
  order?: Partial<TestOrder>;
  variants?: TestVariant[];
  lockedVariant?: Partial<TestVariant> | null;
  purchaseSource?: Partial<PurchaseSource> | null;
  shipmentSource?: Partial<ShipmentSource> | null;
  atTransactionStart?: (state: { lines: TestLine[]; order: TestOrder }) => void;
} = {}) {
  const state = {
    lines: (options.lines ?? []).map((line) => ({ ...line })),
    order: { id: 10, status: "open", sourceType: "blind", vendorId: null,
      warehouseId: 1, purchaseOrderId: null, inboundShipmentId: null,
      updatedAt: RECORDED_AT, ...options.order } as TestOrder,
  };
  const variants = options.variants ?? [{ id: 100, sku: "PACK-250", name: "Pack",
    productId: 1, unitsPerVariant: 250, isActive: true }];
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let nextId = 20;
  const tx = {
    execute: vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const rendered = dialect.sqlToQuery(query);
      if (rendered.sql.includes("inventory.cost_graph")) return { rows: [] };
      queries.push(rendered);
      if (rendered.sql.includes("FROM catalog.product_variants")) {
        const existing = variants.find((variant) => variant.id === rendered.params[0]);
        const variant = options.lockedVariant === null ? null : existing ? { ...existing, ...options.lockedVariant } : null;
        return { rows: variant ? [{ id: variant.id, product_id: variant.productId,
          units_per_variant: variant.unitsPerVariant, is_active: variant.isActive }] : [] };
      }
      if (rendered.sql.includes("FROM procurement.inbound_shipment_lines")) {
        return { rows: options.shipmentSource === null ? [] : [{ inbound_shipment_id: 7,
          purchase_order_id: 3, purchase_order_line_id: 31, qty_shipped: 1000, ...options.shipmentSource }] };
      }
      if (rendered.sql.includes("SELECT receiving_order_id")) return { rows: [{ receiving_order_id: state.order.id }] };
      if (rendered.sql.includes("FROM procurement.receiving_orders")) return { rows: [{ id: state.order.id }] };
      if (rendered.sql.includes("FROM procurement.receiving_lines")) return { rows: state.lines.map((line) => ({ id: line.id })) };
      if (rendered.sql.includes("FROM procurement.purchase_orders")) return { rows: [{ id: state.order.purchaseOrderId }] };
      if (rendered.sql.includes("FROM procurement.purchase_order_lines")) return { rows: [{ id: 31 }] };
      if (rendered.sql.includes("INSERT INTO public.audit_events")) return { rows: [] };
      throw new Error(`Unimplemented receipt import test query: ${rendered.sql}`);
    }),
  };
  const storage = {
    getSetting: vi.fn(async () => "true"),
    getReceivingOrderById: vi.fn(async () => ({ ...state.order })),
    getReceivingLines: vi.fn(async () => state.lines.map((line) => ({ ...line }))),
    getReceivingLineById: vi.fn(async (id: number) => state.lines.find((line) => line.id === id)),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 99, warehouseId: 1, code: "A-01", name: "Receiving" }]),
    // The pack SKU deliberately has no matching product SKU. Product ownership
    // must come from the locked variant, not the import's separate SKU map.
    getAllProducts: vi.fn(async () => []),
    getAllProductVariants: vi.fn(async () => variants.map((variant) => ({ ...variant }))),
    getPurchaseOrderLineById: vi.fn(async (_id: number, executor?: unknown) => {
      expect(executor).toBe(tx);
      return options.purchaseSource === null ? null : { id: 31, purchaseOrderId: 3,
        productId: 1, lineType: "product", ...options.purchaseSource };
    }),
    createReceivingLine: vi.fn(async (input: Partial<TestLine>, executor: unknown) => {
      expect(executor).toBe(tx);
      const line = { ...receiptLine(), expectedQty: 0, receivedQty: 0, damagedQty: 0, id: nextId++, ...input };
      state.lines.push(line);
      return { ...line };
    }),
    bulkCreateReceivingLines: vi.fn(async (inputs: Partial<TestLine>[], executor: unknown) => {
      expect(executor).toBe(tx);
      const inserted = inputs.map((input) => ({ ...receiptLine(), expectedQty: 0, receivedQty: 0, damagedQty: 0, id: nextId++, ...input }));
      state.lines.push(...inserted);
      return inserted.map((line) => ({ ...line }));
    }),
    updateReceivingLine: vi.fn(async (id: number, patch: Partial<TestLine>, executor: unknown) => {
      expect(executor).toBe(tx);
      const index = state.lines.findIndex((line) => line.id === id);
      if (index < 0) throw new Error(`Missing fixture receipt line ${id}`);
      state.lines[index] = { ...state.lines[index], ...patch };
      return { ...state.lines[index] };
    }),
    updateReceivingOrder: vi.fn(async (_id: number, patch: Partial<TestOrder>, executor: unknown) => {
      expect(executor).toBe(tx);
      Object.assign(state.order, patch);
      return { ...state.order };
    }),
  };
  const db = { execute: tx.execute, transaction: vi.fn(async <T>(work: (executor: typeof tx) => Promise<T>) => {
    options.atTransactionStart?.(state);
    return await work(tx);
  }) };
  const inventory = { receiveInventory: vi.fn() };
  const channelSync = { queueSyncAfterInventoryChange: vi.fn(async () => undefined) };
  const service = new ReceivingService(db as any, inventory as any, channelSync, storage as any,
    null, null, null, null, null, null, () => NOW);
  return { service, storage, db, tx, state, inventory, channelSync, queries, variants };
}

function expectNoWrites(test: ReturnType<typeof harness>) {
  expect(test.storage.createReceivingLine).not.toHaveBeenCalled();
  expect(test.storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
  expect(test.storage.updateReceivingOrder).not.toHaveBeenCalled();
  expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  expect(test.channelSync.queueSyncAfterInventoryChange).not.toHaveBeenCalled();
}

describe("ReceivingService manual add unit evidence", () => {
  it("keeps an unresolved SKU's unit snapshot unknown instead of inventing one piece", async () => {
    const test = harness();
    const input = { sku: "UNRESOLVED", expectedQty: 3, receivedQty: 0, damagedQty: 0 };
    const result = await test.service.addLine(10, input);
    expect(test.storage.createReceivingLine).toHaveBeenCalledWith(expect.objectContaining({
      sku: "UNRESOLVED", unitsPerVariantSnapshot: null, expectedQty: 3, receivedQty: 0,
    }), test.tx);
    expect(result.lines[0].unitsPerVariantSnapshot).toBeNull();
    expect(input).toEqual({ sku: "UNRESOLVED", expectedQty: 3, receivedQty: 0, damagedQty: 0 });
    expect(test.queries.some((query) => query.sql.includes("catalog.product_variants"))).toBe(false);
  });

  it("freezes the locked variant factor and product even without an input product ID", async () => {
    const test = harness({ lockedVariant: { unitsPerVariant: 10, productId: 8 } });
    await test.service.addLine(10, { sku: "PACK-250", productVariantId: 100, expectedUnitsPerVariant: 10, expectedQty: 3 });
    expect(test.storage.createReceivingLine).toHaveBeenCalledWith(expect.objectContaining({
      productId: 8, productVariantId: 100, unitsPerVariantSnapshot: 10, expectedQty: 3,
    }), test.tx);
    expect(test.queries.find((query) => query.sql.includes("catalog.product_variants"))?.sql).toContain("FOR SHARE");
  });

  it.each(["expectedQty", "receivedQty", "damagedQty"] as const)("validates %s even without a resolved variant", async (field) => {
    for (const value of [-1, 1.5, "12junk", MAX_PG_INTEGER + 1, null]) {
      const test = harness();
      await expect(test.service.addLine(10, { sku: "UNKNOWN", [field]: value })).rejects.toMatchObject({ statusCode: 400 });
      expectNoWrites(test);
    }
  });

  it.each([[undefined, 400], [500, 409]] as const)("rejects an unreviewed or changed add-line pack factor %s", async (expectedUnitsPerVariant, statusCode) => {
    const test = harness();
    await expect(test.service.addLine(10, { sku: "PACK-250", productVariantId: 100,
      expectedUnitsPerVariant, expectedQty: 3 })).rejects.toMatchObject({ statusCode });
    expectNoWrites(test);
  });

  it("does not accept a caller pack factor for an unresolved SKU", async () => {
    const test = harness();
    await expect(test.service.addLine(10, { sku: "UNKNOWN", expectedUnitsPerVariant: 1, receivedQty: 2 }))
      .rejects.toMatchObject({ statusCode: 400 });
    expectNoWrites(test);
  });

  it("rejects piece overflow even when the entered pack count is a valid integer", async () => {
    const test = harness();
    await expect(test.service.addLine(10, { productVariantId: 100, expectedUnitsPerVariant: 250, receivedQty: MAX_PG_INTEGER }))
      .rejects.toMatchObject({ statusCode: 400, details: { field: "receivedQty in pieces" } });
    expectNoWrites(test);
  });

  it.each(["purchaseOrderLineId", "inboundShipmentLineId", "unitsPerVariantSnapshot"])("rejects caller-owned %s source evidence", async (field) => {
    const test = harness();
    await expect(test.service.addLine(10, { sku: "UNKNOWN", [field]: 1 })).rejects.toMatchObject({ statusCode: 400 });
    expectNoWrites(test);
  });
});

describe("ReceivingService imported whole counts", () => {
  it.each(["qty", "damaged_qty"] as const)("reports malformed unresolved %s rows and never truncates them", async (field) => {
    const test = harness();
    const invalid = [1.5, "1.5", "12junk", -1, "-1", MAX_PG_INTEGER + 1, "2147483648", Number.NaN, Number.POSITIVE_INFINITY];
    const result = await test.service.bulkImportLines(10,
      invalid.map((value, index) => ({ sku: `UNKNOWN-${index}`, qty: "1", [field]: value })), ACTOR);
    expect(result).toMatchObject({ success: true, created: 0, updated: 0 });
    expect(result.errors).toHaveLength(invalid.length);
    invalid.forEach((_value, index) => expect(result.errors?.[index]).toContain(`SKU UNKNOWN-${index}:`));
    expect(test.storage.bulkCreateReceivingLines).toHaveBeenCalledWith([], test.tx);
    expect(test.storage.updateReceivingLine).not.toHaveBeenCalled();
    expect(test.inventory.receiveInventory).not.toHaveBeenCalled();
  });

  it("retains partial row acceptance while keeping valid unresolved counts and unknown units", async () => {
    const test = harness();
    const input = [{ sku: "BAD", qty: "12junk" }, { sku: "GOOD", qty: " 12 ", damaged_qty: "0" }];
    const result = await test.service.bulkImportLines(10, input, ACTOR);
    expect(result).toMatchObject({ success: true, created: 1, updated: 0, errors: [expect.stringContaining("SKU BAD:")] });
    expect(test.storage.bulkCreateReceivingLines).toHaveBeenCalledWith([expect.objectContaining({
      sku: "GOOD", expectedQty: 12, receivedQty: 12, damagedQty: 0,
      productId: null, productVariantId: null, unitsPerVariantSnapshot: null, receivedBy: ACTOR,
    })], test.tx);
    expect(input).toEqual([{ sku: "BAD", qty: "12junk" }, { sku: "GOOD", qty: " 12 ", damaged_qty: "0" }]);
  });

  it.each([0, "0", "", undefined, MAX_PG_INTEGER])("preserves the supported unresolved quantity %s", async (qty) => {
    const test = harness();
    const result = await test.service.bulkImportLines(10, [{ sku: "UNKNOWN", qty }], ACTOR);
    expect(result.errors).toBeUndefined();
    expect(test.storage.bulkCreateReceivingLines).toHaveBeenCalledWith([expect.objectContaining({
      receivedQty: qty === MAX_PG_INTEGER ? MAX_PG_INTEGER : 0, unitsPerVariantSnapshot: null,
    })], test.tx);
  });

  it("gets resolved ownership and frozen conversion from the locked variant", async () => {
    const test = harness({ lockedVariant: { productId: 8, unitsPerVariant: 10 } });
    await test.service.bulkImportLines(10, [{ sku: "PACK-250", qty: "3", damaged_qty: "1" }], ACTOR);
    expect(test.storage.bulkCreateReceivingLines).toHaveBeenCalledWith([expect.objectContaining({
      productId: 8, productVariantId: 100, unitsPerVariantSnapshot: 10,
      expectedQty: 3, receivedQty: 3, damagedQty: 1,
    })], test.tx);
  });

  it.each([null, { isActive: false }])("rejects an unavailable locked variant %j before any writes", async (lockedVariant) => {
    const test = harness({ lockedVariant });
    await expect(test.service.bulkImportLines(10, [{ sku: "PACK-250", qty: "3" }], ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_VARIANT_REVIEW_REQUIRED" } });
    expectNoWrites(test);
  });

  it("rejects resolved piece overflow before inserting any imported rows", async () => {
    const test = harness();
    await expect(test.service.bulkImportLines(10, [{ sku: "PACK-250", qty: MAX_PG_INTEGER }], ACTOR))
      .rejects.toMatchObject({ statusCode: 400, details: { field: "expectedQty in pieces" } });
    expectNoWrites(test);
  });
});

describe("ReceivingService import source preservation", () => {
  const linkedLine = () => ({ ...receiptLine(), purchaseOrderLineId: 31 });
  const imported = [{ sku: "PACK-250", qty: "3", location: "A-01" }];

  it("retains a matching PO product and source ID when the pack has no product SKU match", async () => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 } });
    await test.service.bulkImportLines(10, imported, ACTOR);
    expect(test.storage.updateReceivingLine).toHaveBeenCalledWith(11, expect.objectContaining({
      productId: 1, productVariantId: 100, expectedQty: 3, receivedQty: 3,
    }), test.tx);
    expect(test.state.lines[0]).toMatchObject({ purchaseOrderLineId: 31, unitsPerVariantSnapshot: 250 });
    expect(test.storage.getPurchaseOrderLineById).toHaveBeenCalledWith(31, test.tx);
  });

  it("cannot clear a recorded PO product when the SKU no longer resolves to a variant", async () => {
    const test = harness({ lines: [{ ...linkedLine(), unitsPerVariantSnapshot: null }],
      order: { purchaseOrderId: 3 }, variants: [] });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_VARIANT_REVIEW_REQUIRED" } });
    expectNoWrites(test);
  });

  it("cannot replace a recorded receipt product with another variant's product", async () => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 }, lockedVariant: { productId: 2 } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_VARIANT_PRODUCT_MISMATCH" } });
    expectNoWrites(test);
  });

  it.each([null, { productId: 2 }, { purchaseOrderId: 4 }, { lineType: "fee" }])("rejects inconsistent PO source %j even when the legacy receipt product is empty", async (purchaseSource) => {
    const test = harness({ lines: [{ ...linkedLine(), productId: null }],
      order: { purchaseOrderId: 3 }, purchaseSource });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_SOURCE_PRODUCT_MISMATCH" } });
    expectNoWrites(test);
  });

  it("does not rewrite a linked shipment expectation through import", async () => {
    const test = harness({ lines: [{ ...linkedLine(), inboundShipmentLineId: 55 }],
      order: { purchaseOrderId: 3, inboundShipmentId: 7, sourceType: "shipment" } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_EXPECTED_SOURCE_IMMUTABLE" } });
    expectNoWrites(test);
    expect(test.state.lines[0]).toMatchObject({ expectedQty: 4, receivedQty: 2, inboundShipmentLineId: 55 });
  });

  it("rejects an imported pack whose catalog factor differs from the recorded factor", async () => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 }, lockedVariant: { unitsPerVariant: 500 } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_SOURCE_CHANGED" } });
    expectNoWrites(test);
  });

  it.each(["expectedQty", "receivedQty", "damagedQty"] as const)("rejects %s changed after import preparation even when the header timestamp matches", async (field) => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 },
      atTransactionStart: (state) => { state.lines[0][field] += 1; } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED" } });
    expectNoWrites(test);
  });
  it.each(["added", "removed"])("rejects a line set %s after import preparation", async (change) => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 },
      atTransactionStart: (state) => {
        if (change === "added") state.lines.push({ ...receiptLine(), id: 12, sku: "OTHER" });
        else state.lines.length = 0;
      } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED" } });
    expectNoWrites(test);
  });

  it("accepts the same source line set returned in another order", async () => {
    const test = harness({ lines: [linkedLine(), { ...receiptLine(), id: 12, sku: "OTHER" }],
      order: { purchaseOrderId: 3 }, atTransactionStart: (state) => { state.lines.reverse(); } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR)).resolves.toMatchObject({ updated: 1 });
  });

  it.each(["warehouseId", "purchaseOrderId", "inboundShipmentId"] as const)("rejects header %s changed under the same timestamp", async (field) => {
    const test = harness({ lines: [linkedLine()], order: { purchaseOrderId: 3 },
      atTransactionStart: (state) => { state.order[field] = 9; } });
    await expect(test.service.bulkImportLines(10, imported, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_IMPORT_SNAPSHOT_CHANGED" } });
    expectNoWrites(test);
  });
});

describe("ReceivingService source checks before posting", () => {
  it.each(["purchaseOrderLineId", "headerPurchaseOrderId", "headerShipmentId"] as const)("rejects an explicit shipment line with missing %s before posting", async (missing) => {
    const test = harness({
      lines: [{ ...receiptLine(), inboundShipmentLineId: 55,
        purchaseOrderLineId: missing === "purchaseOrderLineId" ? null : 31 }],
      order: {
        sourceType: "shipment",
        purchaseOrderId: missing === "headerPurchaseOrderId" ? null : 3,
        inboundShipmentId: missing === "headerShipmentId" ? null : 7,
      },
    });
    await expect(test.service.close(10, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_SHIPMENT_SOURCE_MISMATCH" } });
    expectNoWrites(test);
  });

  it.each([null, { productId: 2 }, { purchaseOrderId: 4 }, { lineType: "fee" }])("blocks bad purchase source %j before inventory is posted", async (purchaseSource) => {
    const test = harness({ lines: [{ ...receiptLine(), purchaseOrderLineId: 31 }],
      order: { purchaseOrderId: 3 }, purchaseSource });
    await expect(test.service.close(10, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_SOURCE_PRODUCT_MISMATCH" } });
    expectNoWrites(test);
  });

  it.each([null, { inbound_shipment_id: 8 }, { purchase_order_line_id: 32 }, { purchase_order_id: 4 }])("blocks inconsistent shipment source %j before inventory is posted", async (shipmentSource) => {
    const test = harness({ lines: [{ ...receiptLine(), purchaseOrderLineId: 31, inboundShipmentLineId: 55 }],
      order: { purchaseOrderId: 3, inboundShipmentId: 7, sourceType: "shipment" }, shipmentSource });
    await expect(test.service.close(10, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_SHIPMENT_SOURCE_MISMATCH" } });
    expectNoWrites(test);
  });

  it.each([0, -1, 1.5, MAX_PG_INTEGER + 1])("blocks malformed shipment source piece quantity %s before inventory is posted", async (qty_shipped) => {
    const test = harness({ lines: [{ ...receiptLine(), purchaseOrderLineId: 31, inboundShipmentLineId: 55 }],
      order: { purchaseOrderId: 3, inboundShipmentId: 7, sourceType: "shipment" }, shipmentSource: { qty_shipped } });
    await expect(test.service.close(10, ACTOR))
      .rejects.toMatchObject({ statusCode: 400, details: { field: "Shipment source pieces" } });
    expectNoWrites(test);
  });

  it("blocks a catalog pack change after explicit legacy unit confirmation", async () => {
    const test = harness({ lines: [{ ...receiptLine(), unitsPerVariantSnapshot: null }] });
    const confirmed = await test.service.updateLine(11, { productVariantId: 100, confirmLegacyUnit: true, expectedUnitsPerVariant: 250,
      expectedUnitVersion: receivingUnitVersion(test.state.lines[0]) }, ACTOR);
    expect(confirmed).toMatchObject({ unitsPerVariantSnapshot: 250, expectedQty: 4, receivedQty: 2, damagedQty: 1 });
    test.storage.updateReceivingLine.mockClear();
    test.storage.updateReceivingOrder.mockClear();
    test.variants[0].unitsPerVariant = 500;
    await expect(test.service.close(10, ACTOR))
      .rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_SOURCE_CHANGED" } });
    expectNoWrites(test);
  });
});
