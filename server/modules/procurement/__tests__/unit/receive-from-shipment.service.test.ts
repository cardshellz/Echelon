import { describe, it, expect, vi } from "vitest";
import { createPurchasingService } from "../../purchasing.service";

// ─────────────────────────────────────────────────────────────────────────────
// PR3a: createReceiptFromShipment — receive AGAINST an inbound shipment.
// Verifies the receiving order is stamped with the shipment link + source, and
// lines are defaulted from each shipment line's qtyShipped (scaled to the
// product's largest pack), with cost stamped from the PO line.
// ─────────────────────────────────────────────────────────────────────────────

function sqlToStr(query: any): string {
  if (Array.isArray(query?.queryChunks)) {
    return query.queryChunks
      .map((chunk: any) => (Array.isArray(chunk.value) ? chunk.value.join("") : ""))
      .join(" ")
      .toLowerCase();
  }
  return String(query?.sql ?? query ?? "").toLowerCase();
}

function shipmentReceiptDbRows(input: {
  posting?: Record<string, unknown>;
  coverage?: Array<Record<string, unknown>>;
  poPostings?: Array<Record<string, unknown>>;
  reversals?: Array<Record<string, unknown>>;
} = {}) {
  return vi.fn(async (query: any) => {
    const text = sqlToStr(query);
    if (text.includes("rl.units_per_variant_snapshot")) return { rows: input.coverage ?? [] };
    if (text.includes("from procurement.po_receipts") && !text.includes("as line_count")) return { rows: input.poPostings ?? [] };
    if (text.includes("from procurement.receipt_reversals")) return { rows: input.reversals ?? [] };
    if (text.includes("as line_count") && text.includes("po_receipt_count")) {
      return {
        rows: [input.posting ?? {
          line_count: 2,
          expected_qty: 5,
          received_qty: 5,
          po_receipt_count: 1,
          inventory_lot_count: 1,
          inventory_transaction_count: 1,
        }],
      };
    }
    return { rows: [] };
  });
}

function build(overrides: Record<string, any> = {}, dbOverrides: Record<string, any> = {}) {
  const captured: { order: any; lines: any } = { order: null, lines: null };
  const tx = { execute: vi.fn(async (query: any) => {
    const text = sqlToStr(query);
    if (text.includes("from procurement.inbound_shipments") && text.includes("for update")) return { rows: [{ id: 84 }] };
    return db.execute(query);
  }) };
  const db: any = {
    execute: shipmentReceiptDbRows(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn(tx)),
    ...dbOverrides,
  };
  const storage: any = {
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 84, status: "customs_clearance" }),
    getInboundShipmentLines: vi.fn().mockResolvedValue([
      { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, productVariantId: null, sku: "COGS-TEST-001", qtyShipped: 20 },
      { id: 2, purchaseOrderLineId: 229, purchaseOrderId: 140, productVariantId: null, sku: "COGS-TEST-002", qtyShipped: 150 },
    ]),
    getInboundShipmentLinesByPo: vi.fn().mockResolvedValue([
      { id: 1, inboundShipmentId: 84, purchaseOrderLineId: 228, purchaseOrderId: 140, productVariantId: null, sku: "COGS-TEST-001", qtyShipped: 20 },
      { id: 2, inboundShipmentId: 84, purchaseOrderLineId: 229, purchaseOrderId: 140, productVariantId: null, sku: "COGS-TEST-002", qtyShipped: 150 },
    ]),
    getPurchaseOrderById: vi.fn().mockResolvedValue({
      id: 140, poNumber: "PO-20260617-002", vendorId: 101, warehouseId: 1,
      expectedDeliveryDate: null, confirmedDeliveryDate: null,
    }),
    getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([]),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([
      { id: 228, purchaseOrderId: 140, expectedReceiveVariantId: 469, expectedReceiveUnitsPerVariant: 10, productId: 327, sku: "COGS-TEST-001", productName: "Widget A", unitCostMills: 26000, unitCostCents: 260 },
      { id: 229, purchaseOrderId: 140, expectedReceiveVariantId: 471, expectedReceiveUnitsPerVariant: 50, productId: 328, sku: "COGS-TEST-002", productName: "Widget B", unitCostMills: 7867, unitCostCents: 79 },
    ]),
    getProductVariantsByProductId: vi.fn(async (pid: number) =>
      pid === 327
        ? [{ id: 467, productId: 327, unitsPerVariant: 1, isActive: true }, { id: 469, productId: 327, unitsPerVariant: 10, isActive: true }]
        : [{ id: 470, productId: 328, unitsPerVariant: 1, isActive: true }, { id: 471, productId: 328, unitsPerVariant: 50, isActive: true }]),
    getAllProductLocations: vi.fn().mockResolvedValue([]),
    generateReceiptNumber: vi.fn().mockResolvedValue("RCV-TEST-001"),
    createReceivingOrder: vi.fn(async (o: any) => { captured.order = o; return { id: 999, ...o }; }),
    bulkCreateReceivingLines: vi.fn(async (l: any) => { captured.lines = l; return l; }),
    getReceivingLines: vi.fn().mockResolvedValue([{ id: 1, receivingOrderId: 555 }]),
    deleteReceivingOrder: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const svc = createPurchasingService(db, storage as any);
  return { svc, storage, captured, db, tx };
}

describe("createReceiptFromShipment", () => {
  it("creates a shipment-linked draft receipt with lines from qtyShipped (scaled to the case)", async () => {
    const { svc, storage, captured, db, tx } = build();
    const order: any = await svc.createReceiptFromShipment(84, "u1");

    expect(order).toMatchObject({ id: 999 });
    // The order carries the shipment link + source so lots inherit it at close.
    expect(captured.order).toMatchObject({
      sourceType: "shipment",
      inboundShipmentId: 84,
      purchaseOrderId: 140,
      poNumber: "PO-20260617-002",
      status: "draft",
    });
    // Preferred variants divide the exact pieces; each row freezes that factor and shipment-line identity.
    expect(captured.lines).toHaveLength(2);
    expect(captured.lines[0]).toMatchObject({
      productVariantId: 469, purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, expectedQty: 2, unitCostMills: 26000, unitCost: 260,
    });
    expect(captured.lines[1]).toMatchObject({
      productVariantId: 471, purchaseOrderLineId: 229, inboundShipmentLineId: 2, unitsPerVariantSnapshot: 50, expectedQty: 3, unitCostMills: 7867, unitCost: 79,
    });
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(storage.generateReceiptNumber).toHaveBeenCalledWith(tx);
    expect(storage.createReceivingOrder).toHaveBeenCalledWith(expect.any(Object), tx);
    expect(storage.bulkCreateReceivingLines).toHaveBeenCalledWith(expect.any(Array), tx);
    expect(storage.deleteReceivingOrder).not.toHaveBeenCalled();
  });

  it("keeps shipment receipt header and line creation in one rollback boundary", async () => {
    const lineFailure = new Error("line insert failed");
    const { svc, storage, db, tx } = build({
      bulkCreateReceivingLines: vi.fn().mockRejectedValue(lineFailure),
    });

    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toBe(lineFailure);

    expect(db.transaction).toHaveBeenCalledOnce();
    expect(storage.createReceivingOrder).toHaveBeenCalledWith(expect.any(Object), tx);
    expect(storage.bulkCreateReceivingLines).toHaveBeenCalledWith(expect.any(Array), tx);
    expect(storage.deleteReceivingOrder).not.toHaveBeenCalled();
  });

  it("reuses an open receipt already linked to the shipment (idempotent)", async () => {
    const existing = { id: 555, status: "open", inboundShipmentId: 84 };
    const { svc, storage } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([existing]),
    });
    const order: any = await svc.createReceiptFromShipment(84, "u1");
    expect(order).toMatchObject({ id: 555, reusedExisting: true });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("does not reuse an active shipment receipt that has no lines", async () => {
    const existing = { id: 556, status: "draft", inboundShipmentId: 84, purchaseOrderId: 140 };
    const { svc, storage } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([existing]),
      getReceivingLines: vi.fn().mockResolvedValue([]),
    });

    await expect(svc.createReceiptFromShipment(84, "u1"))
      .rejects.toMatchObject({
        statusCode: 409,
        details: {
          code: "EMPTY_SHIPMENT_RECEIPT",
          receivingOrderId: 556,
          purchaseOrderId: 140,
          inboundShipmentId: 84,
        },
      });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  });

  it("rejects receiving a shipment that isn't physically here yet", async () => {
    const { svc } = build({ getInboundShipmentById: vi.fn().mockResolvedValue({ id: 84, status: "booked" }) });
    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toThrow(/status/);
  });

  it("accepts closed shipments as physically receivable", async () => {
    const { svc, captured } = build({
      getInboundShipmentById: vi.fn().mockResolvedValue({ id: 84, status: "closed" }),
    });
    const order: any = await svc.createReceiptFromShipment(84, "u1");
    expect(order).toMatchObject({ id: 999 });
    expect(captured.order).toMatchObject({ inboundShipmentId: 84, purchaseOrderId: 140 });
  });

  it("rejects an unscoped shipment whose lines span multiple POs", async () => {
    const { svc } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 20 },
        { id: 2, purchaseOrderLineId: 300, purchaseOrderId: 141, qtyShipped: 10 },
      ]),
    });
    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toThrow(/choose which PO/);
  });

  it("creates a receipt for one PO in a multi-PO shipment when purchaseOrderId is supplied", async () => {
    const { svc, captured } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 20 },
        { id: 2, purchaseOrderLineId: 300, purchaseOrderId: 141, qtyShipped: 10 },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 141,
        poNumber: "PO-20260617-003",
        vendorId: 101,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        { id: 300, purchaseOrderId: 141, productId: 329, sku: "COGS-TEST-003", productName: "Widget C", unitCostMills: 5000, unitCostCents: 50 },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([{ id: 472, productId: 329, unitsPerVariant: 1, isActive: true }]),
    });

    const order: any = await svc.createReceiptFromShipment(84, "u1", { purchaseOrderId: 141 });

    expect(order).toMatchObject({ id: 999 });
    expect(captured.order).toMatchObject({
      sourceType: "shipment",
      inboundShipmentId: 84,
      purchaseOrderId: 141,
      poNumber: "PO-20260617-003",
    });
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({ purchaseOrderLineId: 300, expectedQty: 10 });
  });

  it("uses the recorded preferred pack independently of physical carton count", async () => {
    const { svc, captured } = build({ getInboundShipmentLines: vi.fn().mockResolvedValue([
      { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, productVariantId: null, qtyShipped: 5000, cartonCount: 3 },
    ]) });
    await svc.createReceiptFromShipment(84, "u1");
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({ inboundShipmentLineId: 1, productVariantId: 469, expectedQty: 500, unitsPerVariantSnapshot: 10 });
  });

  it.each([11, 3])("preserves 501 pieces recorded in %i cartons with a real one-piece variant", async (cartonCount) => {
    const source = { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, productVariantId: null, qtyShipped: 501, cartonCount };
    const { svc, captured } = build({ getInboundShipmentLines: vi.fn().mockResolvedValue([source]) });
    await svc.createReceiptFromShipment(84, "u1");
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({ inboundShipmentLineId: 1, productVariantId: 467, expectedQty: 501, unitsPerVariantSnapshot: 1 });
    expect(source.cartonCount).toBe(cartonCount);
    expect(source.qtyShipped).toBe(501);
  });

  it("fails before writes when a partial preferred pack has no active one-piece variant", async () => {
    const { svc, storage } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 501, cartonCount: 11 }]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 469, productId: 327, unitsPerVariant: 10, isActive: true },
        { id: 467, productId: 327, unitsPerVariant: 1, isActive: false },
      ]),
    });
    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_PIECE_VARIANT_REQUIRED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  });

  it("shows an actionable missing-piece plan before receipt creation", async () => {
    const { svc, storage } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 501, cartonCount: 11 }]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([{ id: 469, productId: 327, unitsPerVariant: 10, isActive: true }]),
    });
    const resolution = await svc.getShipmentReceiptPackResolution(84, { purchaseOrderId: 140 });
    expect(resolution).toMatchObject({ canCreateReceipt: false, unresolvedCount: 1, lineCount: 1 });
    expect(resolution.lines[0]).toMatchObject({ shipmentLineId: 1, status: "missing_piece_variant", blocking: true, receivePlan: null, unitsPerCarton: null });
    expect(resolution.lines[0].issue).toMatch(/one-piece variant/);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("shows the same exact receive plan that receipt creation persists", async () => {
    const { svc, captured } = build({ getInboundShipmentLines: vi.fn().mockResolvedValue([
      { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 501, cartonCount: 3 },
    ]) });
    const resolution = await svc.getShipmentReceiptPackResolution(84, { purchaseOrderId: 140 });
    expect(resolution.canCreateReceipt).toBe(true);
    expect(resolution.lines[0]).toMatchObject({ status: "resolved", blocking: false, unitsPerCarton: null,
      receivePlan: { productVariantId: 467, expectedQty: 501, unitsPerVariant: 1, countsAsPieces: true, preferredUnitsPerVariant: 10 } });
    await svc.createReceiptFromShipment(84, "u1");
    expect(captured.lines[0]).toMatchObject({ productVariantId: resolution.lines[0].receivePlan!.productVariantId,
      expectedQty: resolution.lines[0].receivePlan!.expectedQty, unitsPerVariantSnapshot: resolution.lines[0].receivePlan!.unitsPerVariant });
  });

  it("rejects an inactive recorded preferred variant instead of silently selecting another pack", async () => {
    const { svc, storage } = build({ getProductVariantsByProductId: vi.fn(async (productId: number) =>
      productId === 327 ? [{ id: 469, productId, unitsPerVariant: 10, isActive: false }, { id: 467, productId, unitsPerVariant: 1, isActive: true }]
        : [{ id: 471, productId, unitsPerVariant: 50, isActive: true }]),
    });
    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_VARIANT_REVIEW_REQUIRED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("rejects a live pack size that disagrees with the PO's recorded preferred units", async () => {
    const { svc, storage } = build({ getProductVariantsByProductId: vi.fn(async (productId: number) =>
      productId === 327 ? [{ id: 469, productId, unitsPerVariant: 20, isActive: true }, { id: 467, productId, unitsPerVariant: 1, isActive: true }]
        : [{ id: 471, productId, unitsPerVariant: 50, isActive: true }]),
    });
    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_SOURCE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("blocks duplicate shipment receipts after the shipment/PO pair was already closed", async () => {
    const { svc, storage } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        coverage: [
          { id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 2, reversedQty: 0 },
          { id: 601, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 229, inboundShipmentLineId: 2, unitsPerVariantSnapshot: 50, receivedQty: 3, reversedQty: 0 },
        ],
      }),
    });

    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toThrow(/already been received/);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("does not advertise a creatable receipt plan when exact source coverage is complete", async () => {
    const { svc } = build({}, { execute: shipmentReceiptDbRows({ coverage: [
      { id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 2, reversedQty: 0 },
      { id: 601, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 229, inboundShipmentLineId: 2, unitsPerVariantSnapshot: 50, receivedQty: 3, reversedQty: 0 },
    ] }) });
    const resolution = await svc.getShipmentReceiptPackResolution(84, { purchaseOrderId: 140 });
    expect(resolution.lines).toHaveLength(0);
    expect(resolution.canCreateReceipt).toBe(false);
  });

  it("creates a follow-up shipment receipt only for remaining short-received shipment quantity", async () => {
    const { svc, captured } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        coverage: [
          { id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 1, reversedQty: 0 },
          { id: 601, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 229, inboundShipmentLineId: 2, unitsPerVariantSnapshot: 50, receivedQty: 3, reversedQty: 0 },
        ],
      }),
    });

    await svc.createReceiptFromShipment(84, "u1");

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({
      purchaseOrderLineId: 228,
      productVariantId: 469,
      expectedQty: 1,
    });
  });

  it("creates the remainder against its exact source when one PO line has multiple shipment lines", async () => {
    const coverage = [{ id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed",
      purchaseOrderLineId: 228, inboundShipmentLineId: 3, unitsPerVariantSnapshot: 10, receivedQty: 1, reversedQty: 0 }];
    const { svc, captured } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        { id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 20 },
        { id: 3, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 20 },
      ]),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([{ id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 }]),
    }, { execute: shipmentReceiptDbRows({ coverage }) });
    await svc.createReceiptFromShipment(84, "u1");
    expect(captured.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ inboundShipmentLineId: 1, expectedQty: 2, unitsPerVariantSnapshot: 10 }),
      expect.objectContaining({ inboundShipmentLineId: 3, expectedQty: 1, unitsPerVariantSnapshot: 10 }),
    ]));
  });

  it("uses immutable reversal base pieces to reopen only the correct shipment remainder", async () => {
    const { svc, captured } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([{ id: 1, purchaseOrderLineId: 228, purchaseOrderId: 140, qtyShipped: 20 }]),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([{ id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 }]),
    }, { execute: shipmentReceiptDbRows({
      coverage: [{ id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed",
        purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 2, reversedQty: 1 }],
      reversals: [{ id: 700, receivingLineId: 600, receivingOrderId: 555, qty: 1, baseUnitsReversed: 10 }],
    }) });
    await svc.createReceiptFromShipment(84, "u1");
    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({ inboundShipmentLineId: 1, expectedQty: 1, unitsPerVariantSnapshot: 10 });
  });

  it("reports closed zero-post shipment receipts as voidable receive options", async () => {
    const { svc } = build({
      getInboundShipmentById: vi.fn().mockResolvedValue({
        id: 84,
        shipmentNumber: "SHP-84",
        status: "closed",
        actualTotalCostCents: 12345,
      }),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        posting: {
          line_count: 2,
          expected_qty: 15,
          received_qty: 0,
          po_receipt_count: 0,
          inventory_lot_count: 0,
          inventory_transaction_count: 0,
        },
      }),
    });

    const options: any = await svc.getPurchaseOrderReceiveOptions(140);

    expect(options.shipmentOptions).toHaveLength(1);
    expect(options.shipmentOptions[0]).toMatchObject({
      shipmentId: 84,
      shipmentNumber: "SHP-84",
      status: "closed",
      purchaseOrderId: 140,
      receivable: false,
      action: "void_zero_post_receipt",
      existingReceiptId: 555,
      existingReceiptStatus: "closed",
      existingReceiptLineCount: 2,
      freightWillCarry: false,
    });
    expect(options.shipmentOptions[0].reason).toMatch(/zero received quantity/i);
  });

  it("reports closed short shipment receipts as receivable for remaining quantity", async () => {
    const { svc } = build({
      getInboundShipmentById: vi.fn().mockResolvedValue({
        id: 84,
        shipmentNumber: "SHP-84",
        status: "closed",
        actualTotalCostCents: 12345,
      }),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        coverage: [
          { id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 1, reversedQty: 0 },
          { id: 601, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed", purchaseOrderLineId: 229, inboundShipmentLineId: 2, unitsPerVariantSnapshot: 50, receivedQty: 3, reversedQty: 0 },
        ],
      }),
    });

    const options: any = await svc.getPurchaseOrderReceiveOptions(140);

    expect(options.shipmentOptions).toHaveLength(1);
    expect(options.shipmentOptions[0]).toMatchObject({
      shipmentId: 84,
      shipmentNumber: "SHP-84",
      status: "closed",
      purchaseOrderId: 140,
      receivable: true,
      action: "create_receipt",
      existingReceiptId: 555,
      existingReceiptStatus: "closed",
      receivedBaseQty: 160,
      remainingBaseQty: 10,
      freightWillCarry: true,
    });
    expect(options.shipmentOptions[0].reason).toMatch(/prior shipment receipt was short/i);
  });

  it("does not create over a closed zero-post shipment receipt until it is voided", async () => {
    const { svc, storage } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        posting: {
          line_count: 2,
          expected_qty: 15,
          received_qty: 0,
          po_receipt_count: 0,
          inventory_lot_count: 0,
          inventory_transaction_count: 0,
        },
      }),
    });

    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toMatchObject({
      statusCode: 409,
      details: expect.objectContaining({ code: "ZERO_POST_SHIPMENT_RECEIPT", receivingOrderId: 555 }),
    });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("reports backend receive options using the same closed-shipment predicate", async () => {
    const { svc } = build({
      getInboundShipmentById: vi.fn().mockResolvedValue({
        id: 84,
        shipmentNumber: "SHP-84",
        status: "closed",
        actualTotalCostCents: 12345,
      }),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([]),
    });

    const options: any = await svc.getPurchaseOrderReceiveOptions(140);

    expect(options.shipmentOptions).toHaveLength(1);
    expect(options.shipmentOptions[0]).toMatchObject({
      shipmentId: 84,
      shipmentNumber: "SHP-84",
      status: "closed",
      purchaseOrderId: 140,
      receivable: true,
      action: "create_receipt",
      freightWillCarry: true,
      actualTotalCostCents: 12345,
    });
  });

  it("reports empty active shipment receipts as repairable receive options", async () => {
    const { svc } = build({
      getInboundShipmentById: vi.fn().mockResolvedValue({
        id: 84,
        shipmentNumber: "SHP-84",
        status: "closed",
        actualTotalCostCents: 12345,
      }),
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 556, status: "draft", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
      getReceivingLines: vi.fn().mockResolvedValue([]),
    });

    const options: any = await svc.getPurchaseOrderReceiveOptions(140);

    expect(options.shipmentOptions).toHaveLength(1);
    expect(options.shipmentOptions[0]).toMatchObject({
      shipmentId: 84,
      shipmentNumber: "SHP-84",
      status: "closed",
      purchaseOrderId: 140,
      receivable: false,
      action: "repair_empty_receipt",
      existingReceiptId: 556,
      existingReceiptStatus: "draft",
      existingReceiptLineCount: 0,
      freightWillCarry: false,
    });
    expect(options.shipmentOptions[0].reason).toMatch(/no lines/i);
  });
});


describe("createReceiptFromShipment source serialization", () => {
  const sourceLine = { id: 1, inboundShipmentId: 84, purchaseOrderLineId: 228, purchaseOrderId: 140, productVariantId: null, sku: "WIDGET", qtyShipped: 20 };

  it.each([
    ["quantity", { qtyShipped: 30 }],
    ["cartons", { cartonCount: 4 }],
    ["PO link", { purchaseOrderLineId: 229 }],
    ["receive variant", { productVariantId: 467 }],
    ["physical dimensions", { weightKg: "2.5" }],
  ])("rejects stale receipt creation after a concurrent %s change", async (_name, change) => {
    const { svc, storage, tx } = build();
    storage.getInboundShipmentLines.mockResolvedValueOnce([sourceLine]).mockResolvedValue([{ ...sourceLine, ...(change as object) }]);
    await expect(svc.createReceiptFromShipment(84, "user-1")).rejects.toMatchObject({
      statusCode: 409, details: { code: "SHIPMENT_RECEIPT_SOURCE_CHANGED", inboundShipmentId: 84 },
    });
    expect(storage.getInboundShipmentLines).toHaveBeenLastCalledWith(84, tx);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  });

  it.each(["added", "removed"])("rejects a concurrently %s shipment line", async (change) => {
    const { svc, storage } = build();
    const lockedLines = change === "removed" ? [] : [sourceLine, { ...sourceLine, id: 2, purchaseOrderLineId: 229 }];
    storage.getInboundShipmentLines.mockResolvedValueOnce([sourceLine]).mockResolvedValue(lockedLines);
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_SOURCE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it.each([
    { status: "cancelled" },
    { warehouseId: 2 },
    { updatedAt: new Date("2026-09-06T12:00:01Z") },
  ])("rejects a shipment header changed during preparation: %j", async (change) => {
    const { svc, storage } = build();
    const initial = { id: 84, status: "customs_clearance", warehouseId: 1, updatedAt: new Date("2026-09-06T12:00:00Z") };
    storage.getInboundShipmentById.mockResolvedValueOnce(initial).mockResolvedValue({ ...initial, ...change });
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_SOURCE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("locks shipment before the receipt advisory key and preserves unchanged source quantities", async () => {
    const { svc, storage, tx } = build();
    await svc.createReceiptFromShipment(84);
    const queries = tx.execute.mock.calls.map(([query]: [any]) => sqlToStr(query));
    expect(queries[0]).toContain("from procurement.inbound_shipments");
    expect(queries[0]).toContain("for update");
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(storage.getInboundShipmentById).toHaveBeenLastCalledWith(84, tx);
    expect(storage.createReceivingOrder).toHaveBeenCalledTimes(1);
    expect(storage.bulkCreateReceivingLines).toHaveBeenCalledTimes(1);
  });

  it("rejects a live catalog pack changed after preflight and before the locked write", async () => {
    const { svc, storage } = build({ getProductVariantsByProductId: vi.fn(async (productId: number, executor?: unknown) =>
      productId === 327 ? [{ id: 467, productId, unitsPerVariant: 1, isActive: true }, { id: 469, productId, unitsPerVariant: executor ? 20 : 10, isActive: true }]
        : [{ id: 470, productId, unitsPerVariant: 1, isActive: true }, { id: 471, productId, unitsPerVariant: 50, isActive: true }]),
    });
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_UNIT_SOURCE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("rejects a PO source change after preparation even when shipment rows are unchanged", async () => {
    const { svc, storage } = build();
    const originalPoLines = await storage.getPurchaseOrderLines(140);
    storage.getPurchaseOrderLines.mockImplementation(async (_poId: number, executor?: unknown) =>
      executor ? originalPoLines.map((line: any) => ({ ...line, unitCostMills: line.unitCostMills + 1 })) : originalPoLines);
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409, details: { code: "RECEIVING_PO_SOURCE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("rejects a changed PO destination header before persisting stale receipt details", async () => {
    const { svc, storage } = build();
    const initialHeader = await storage.getPurchaseOrderById(140);
    storage.getPurchaseOrderById.mockImplementation(async (_poId: number, executor?: unknown) =>
      executor ? { ...initialHeader, warehouseId: 2 } : initialHeader);
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409 });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("rejects newly closed receipt coverage that appears while the parent lock is acquired", async () => {
    const { svc, storage, tx } = build();
    const originalExecute = tx.execute.getMockImplementation()!;
    tx.execute.mockImplementation(async (query: any) => {
      if (sqlToStr(query).includes("rl.units_per_variant_snapshot")) {
        return { rows: [{ id: 600, receivingOrderId: 555, purchaseOrderId: 140, inboundShipmentId: 84, receiptStatus: "closed",
          purchaseOrderLineId: 228, inboundShipmentLineId: 1, unitsPerVariantSnapshot: 10, receivedQty: 1, reversedQty: 0 }] };
      }
      return originalExecute(query);
    });
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 409, details: { code: "SHIPMENT_RECEIPT_COVERAGE_CHANGED" } });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("treats row reordering as the same source snapshot", async () => {
    const { svc, storage } = build();
    const other = { ...sourceLine, id: 2, purchaseOrderLineId: 229 };
    storage.getInboundShipmentLines.mockResolvedValueOnce([sourceLine, other]).mockResolvedValue([other, sourceLine]);
    await expect(svc.createReceiptFromShipment(84)).resolves.toMatchObject({ id: 999 });
  });

  it("stops when the shipment was deleted before the parent lock", async () => {
    const { svc, storage, tx } = build();
    tx.execute.mockResolvedValue({ rows: [] });
    await expect(svc.createReceiptFromShipment(84)).rejects.toMatchObject({ statusCode: 404 });
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });
});
