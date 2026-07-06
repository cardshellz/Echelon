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
} = {}) {
  return vi.fn(async (query: any) => {
    const text = sqlToStr(query);
    if (text.includes("received_base_qty")) {
      return { rows: input.coverage ?? [] };
    }
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
  const db: any = {
    execute: vi.fn(),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(async (fn: any) => fn({ execute: vi.fn() })),
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
      { id: 228, productId: 327, sku: "COGS-TEST-001", productName: "Widget A", unitCostMills: 26000, unitCostCents: 260 },
      { id: 229, productId: 328, sku: "COGS-TEST-002", productName: "Widget B", unitCostMills: 7867, unitCostCents: 79 },
    ]),
    getProductVariantsByProductId: vi.fn(async (pid: number) =>
      pid === 327
        ? [{ id: 467, unitsPerVariant: 1 }, { id: 469, unitsPerVariant: 10 }]
        : [{ id: 470, unitsPerVariant: 1 }, { id: 471, unitsPerVariant: 50 }]),
    getAllProductLocations: vi.fn().mockResolvedValue([]),
    generateReceiptNumber: vi.fn().mockResolvedValue("RCV-TEST-001"),
    createReceivingOrder: vi.fn(async (o: any) => { captured.order = o; return { id: 999, ...o }; }),
    bulkCreateReceivingLines: vi.fn(async (l: any) => { captured.lines = l; return l; }),
    getReceivingLines: vi.fn().mockResolvedValue([{ id: 1, receivingOrderId: 555 }]),
    deleteReceivingOrder: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  const svc = createPurchasingService(db, storage as any);
  return { svc, storage, captured, db };
}

describe("createReceiptFromShipment", () => {
  it("creates a shipment-linked draft receipt with lines from qtyShipped (scaled to the case)", async () => {
    const { svc, captured } = build();
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
    // Lines: Expected = ceil(qtyShipped / largest-pack units); cost from PO line (mills-first).
    expect(captured.lines).toHaveLength(2);
    expect(captured.lines[0]).toMatchObject({
      productVariantId: 469, purchaseOrderLineId: 228, expectedQty: 2, unitCostMills: 26000, unitCost: 260,
    });
    expect(captured.lines[1]).toMatchObject({
      productVariantId: 471, purchaseOrderLineId: 229, expectedQty: 3, unitCostMills: 7867, unitCost: 79,
    });
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
      getProductVariantsByProductId: vi.fn().mockResolvedValue([{ id: 472, unitsPerVariant: 1 }]),
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

  it("uses shipment carton count as expected qty when cartons imply an active receive pack", async () => {
    const { svc, captured } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 132,
          purchaseOrderLineId: 176,
          purchaseOrderId: 117,
          productVariantId: null,
          sku: "SHLZ-TOP-TOB",
          qtyShipped: 5000,
          cartonCount: 10,
        },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 117,
        poNumber: "PO-20260511-004",
        vendorId: 2,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        {
          id: 176,
          purchaseOrderId: 117,
          productId: 1,
          sku: "SHLZ-TOP-TOB",
          productName: "2\"x3\" Tobacco/Mini Toploader - Blue UV Hint",
          unitCostMills: 604,
          unitCostCents: 6,
        },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 1, productId: 1, sku: "SHLZ-TOP-TOB-P25", name: "1 Pack of 25", unitsPerVariant: 25, isActive: true },
        { id: 500, productId: 1, sku: "SHLZ-TOP-TOB-C500", name: "Case of 500", unitsPerVariant: 500, isActive: true },
        { id: 2, productId: 1, sku: "SHLZ-TOP-TOB-C1000", name: "Case of 1000", unitsPerVariant: 1000, isActive: true },
        { id: 213, productId: 1, sku: "SHLZ-TOP-TOB-SK100000", name: "Skid of 10000", unitsPerVariant: 10000, isActive: false },
      ]),
    });

    await svc.createReceiptFromShipment(84, "u1", { purchaseOrderId: 117 });

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({
      purchaseOrderLineId: 176,
      productVariantId: 500,
      expectedQty: 10,
    });
  });

  it("rejects shipment cartons when the implied receive pack has no active variant", async () => {
    const { svc, storage } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 132,
          purchaseOrderLineId: 176,
          purchaseOrderId: 117,
          productVariantId: null,
          sku: "SHLZ-TOP-TOB",
          qtyShipped: 5000,
          cartonCount: 10,
        },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 117,
        poNumber: "PO-20260511-004",
        vendorId: 2,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        {
          id: 176,
          purchaseOrderId: 117,
          productId: 1,
          sku: "SHLZ-TOP-TOB",
          productName: "2\"x3\" Tobacco/Mini Toploader - Blue UV Hint",
          unitCostMills: 604,
          unitCostCents: 6,
        },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 1, productId: 1, sku: "SHLZ-TOP-TOB-P25", name: "1 Pack of 25", unitsPerVariant: 25, isActive: true },
        { id: 2, productId: 1, sku: "SHLZ-TOP-TOB-C1000", name: "Case of 1000", unitsPerVariant: 1000, isActive: true },
        { id: 213, productId: 1, sku: "SHLZ-TOP-TOB-SK100000", name: "Skid of 10000", unitsPerVariant: 10000, isActive: false },
      ]),
    });

    await expect(svc.createReceiptFromShipment(84, "u1", { purchaseOrderId: 117 }))
      .rejects.toThrow(/units_per_variant=500/);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
    expect(storage.bulkCreateReceivingLines).not.toHaveBeenCalled();
  });

  it("reports unresolved shipment receipt packs before receipt creation", async () => {
    const { svc, storage } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 132,
          purchaseOrderLineId: 176,
          purchaseOrderId: 117,
          productVariantId: null,
          sku: "SHLZ-TOP-TOB",
          qtyShipped: 5000,
          cartonCount: 10,
        },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 117,
        poNumber: "PO-20260511-004",
        vendorId: 2,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        {
          id: 176,
          purchaseOrderId: 117,
          productId: 1,
          sku: "SHLZ-TOP-TOB",
          productName: "2\"x3\" Tobacco/Mini Toploader - Blue UV Hint",
          unitCostMills: 604,
          unitCostCents: 6,
        },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 1, productId: 1, sku: "SHLZ-TOP-TOB-P25", name: "1 Pack of 25", unitsPerVariant: 25, isActive: true },
        { id: 2, productId: 1, sku: "SHLZ-TOP-TOB-C1000", name: "Case of 1000", unitsPerVariant: 1000, isActive: true },
        { id: 213, productId: 1, sku: "SHLZ-TOP-TOB-SK100000", name: "Skid of 10000", unitsPerVariant: 10000, isActive: false },
      ]),
    });

    const resolution: any = await svc.getShipmentReceiptPackResolution(84, { purchaseOrderId: 117 });

    expect(resolution).toMatchObject({
      shipmentId: 84,
      purchaseOrderId: 117,
      canCreateReceipt: false,
      unresolvedCount: 1,
      lineCount: 1,
    });
    expect(resolution.lines[0]).toMatchObject({
      shipmentLineId: 132,
      purchaseOrderLineId: 176,
      productId: 1,
      sku: "SHLZ-TOP-TOB",
      qtyShipped: 5000,
      cartonCount: 10,
      unitsPerCarton: 500,
      status: "missing_variant",
      blocking: true,
      matchedVariant: null,
    });
    expect(resolution.lines[0].issue).toMatch(/units_per_variant=500/);
    expect(resolution.lines[0].activeVariants.map((variant: any) => variant.unitsPerVariant)).toEqual([1000, 25]);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("reports shipment receipt packs as creatable when the implied variant is active", async () => {
    const { svc } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 132,
          purchaseOrderLineId: 176,
          purchaseOrderId: 117,
          productVariantId: null,
          sku: "SHLZ-TOP-TOB",
          qtyShipped: 5000,
          cartonCount: 10,
        },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 117,
        poNumber: "PO-20260511-004",
        vendorId: 2,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        {
          id: 176,
          purchaseOrderId: 117,
          productId: 1,
          sku: "SHLZ-TOP-TOB",
          productName: "2\"x3\" Tobacco/Mini Toploader - Blue UV Hint",
          unitCostMills: 604,
          unitCostCents: 6,
        },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 500, productId: 1, sku: "SHLZ-TOP-TOB-C500", name: "Case of 500", unitsPerVariant: 500, isActive: true },
      ]),
    });

    const resolution: any = await svc.getShipmentReceiptPackResolution(84, { purchaseOrderId: 117 });

    expect(resolution.canCreateReceipt).toBe(true);
    expect(resolution.unresolvedCount).toBe(0);
    expect(resolution.lines[0]).toMatchObject({
      status: "resolved",
      blocking: false,
      matchedVariant: {
        id: 500,
        sku: "SHLZ-TOP-TOB-C500",
        unitsPerVariant: 500,
      },
    });
  });

  it("does not choose inactive oversized variants when no shipment carton pack exists", async () => {
    const { svc, captured } = build({
      getInboundShipmentLines: vi.fn().mockResolvedValue([
        {
          id: 132,
          purchaseOrderLineId: 176,
          purchaseOrderId: 117,
          productVariantId: null,
          sku: "SHLZ-TOP-TOB",
          qtyShipped: 5000,
        },
      ]),
      getPurchaseOrderById: vi.fn().mockResolvedValue({
        id: 117,
        poNumber: "PO-20260511-004",
        vendorId: 2,
        warehouseId: 1,
        expectedDeliveryDate: null,
        confirmedDeliveryDate: null,
      }),
      getPurchaseOrderLines: vi.fn().mockResolvedValue([
        {
          id: 176,
          purchaseOrderId: 117,
          productId: 1,
          sku: "SHLZ-TOP-TOB",
          productName: "2\"x3\" Tobacco/Mini Toploader - Blue UV Hint",
          unitCostMills: 604,
          unitCostCents: 6,
        },
      ]),
      getProductVariantsByProductId: vi.fn().mockResolvedValue([
        { id: 1, productId: 1, sku: "SHLZ-TOP-TOB-P25", name: "1 Pack of 25", unitsPerVariant: 25, isActive: true },
        { id: 2, productId: 1, sku: "SHLZ-TOP-TOB-C1000", name: "Case of 1000", unitsPerVariant: 1000, isActive: true },
        { id: 213, productId: 1, sku: "SHLZ-TOP-TOB-SK100000", name: "Skid of 10000", unitsPerVariant: 10000, isActive: false },
      ]),
    });

    await svc.createReceiptFromShipment(84, "u1", { purchaseOrderId: 117 });

    expect(captured.lines).toHaveLength(1);
    expect(captured.lines[0]).toMatchObject({
      purchaseOrderLineId: 176,
      productVariantId: 2,
      expectedQty: 5,
    });
  });

  it("blocks duplicate shipment receipts after the shipment/PO pair was already closed", async () => {
    const { svc, storage } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        coverage: [
          { purchase_order_line_id: 228, received_base_qty: 20 },
          { purchase_order_line_id: 229, received_base_qty: 150 },
        ],
      }),
    });

    await expect(svc.createReceiptFromShipment(84, "u1")).rejects.toThrow(/already been received/);
    expect(storage.createReceivingOrder).not.toHaveBeenCalled();
  });

  it("creates a follow-up shipment receipt only for remaining short-received shipment quantity", async () => {
    const { svc, captured } = build({
      getReceivingOrdersForPurchaseOrder: vi.fn().mockResolvedValue([
        { id: 555, status: "closed", inboundShipmentId: 84, purchaseOrderId: 140 },
      ]),
    }, {
      execute: shipmentReceiptDbRows({
        coverage: [
          { purchase_order_line_id: 228, received_base_qty: 10 },
          { purchase_order_line_id: 229, received_base_qty: 150 },
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
          { purchase_order_line_id: 228, received_base_qty: 10 },
          { purchase_order_line_id: 229, received_base_qty: 150 },
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
