import { describe, it, expect, vi, beforeEach } from "vitest";
import { createShipmentTrackingService, ShipmentTrackingError } from "../../shipment-tracking.service";

// ─────────────────────────────────────────────────────────────────────────────
// addLinesFromPO — per-line qty selection, validation, backward compat.
//
// Tests the new lineSelections parameter that allows specifying per-line
// quantities instead of always using orderQty.
// ─────────────────────────────────────────────────────────────────────────────

function buildMockStorage(overrides: Record<string, any> = {}): any {
  return {
    getInboundShipmentById: vi.fn().mockResolvedValue({ id: 1, status: "booked" }),
    getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 10, vendorId: 100 }),
    getPurchaseOrderLines: vi.fn().mockResolvedValue([]),
    getInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundShipmentLinesByPo: vi.fn().mockResolvedValue([]),
    getProductVariantById: vi.fn().mockResolvedValue(null),
    getVendorProducts: vi.fn().mockResolvedValue([]),
    bulkCreateInboundShipmentLines: vi.fn().mockResolvedValue([]),
    getInboundFreightCosts: vi.fn().mockResolvedValue([]),
    updateInboundShipment: vi.fn().mockResolvedValue({}),
    getInboundShipmentCosts: vi.fn().mockResolvedValue([]),
    getInboundFreightCostAllocations: vi.fn().mockResolvedValue([]),
    getAllocationsForLine: vi.fn().mockResolvedValue([]),
    createInboundShipmentStatusHistory: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function makeProductLine(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    purchaseOrderId: 10,
    lineNumber: 1,
    productVariantId: 200,
    sku: "SKU-001",
    productName: "Widget",
    lineType: "product",
    status: "open",
    orderQty: 100,
    cancelledQty: 0,
    ...overrides,
  };
}

describe("addLinesFromPO", () => {
  let storage: ReturnType<typeof buildMockStorage>;
  let svc: ReturnType<typeof createShipmentTrackingService>;

  beforeEach(() => {
    storage = buildMockStorage();
    svc = createShipmentTrackingService(null, storage);
  });

  it("uses orderQty when no lineSelections provided (legacy behavior)", async () => {
    const poLine = makeProductLine({ orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10);

    expect(storage.bulkCreateInboundShipmentLines).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 100, purchaseOrderLineId: 1 }),
      ]),
    );
  });

  it("uses provided qty from lineSelections instead of orderQty", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 40 }]);

    expect(storage.bulkCreateInboundShipmentLines).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 40, purchaseOrderLineId: 5 }),
      ]),
    );
  });

  it("rejects qty > remaining (ordered - already shipped - cancelled)", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100, cancelledQty: 10 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    // 60 already shipped on another shipment
    storage.getInboundShipmentLinesByPo.mockResolvedValue([
      { purchaseOrderLineId: 5, qtyShipped: 60, inboundShipmentId: 99 },
    ]);

    // remaining = 100 - 60 - 10 = 30, requesting 31
    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 31 }]),
    ).rejects.toThrow(/exceeds remaining 30/);
  });

  it("rejects qty <= 0", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 0 }]),
    ).rejects.toThrow(/qty must be > 0/);
  });

  it("skips non-product lines (lineType !== product)", async () => {
    const discountLine = makeProductLine({ id: 5, lineType: "discount", orderQty: 1 });
    storage.getPurchaseOrderLines.mockResolvedValue([discountLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 1 }]),
    ).rejects.toThrow(/cannot be shipped/);
  });

  it("rejects closed/cancelled PO lines", async () => {
    const closedLine = makeProductLine({ id: 5, status: "closed" });
    storage.getPurchaseOrderLines.mockResolvedValue([closedLine]);

    await expect(
      svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 10 }]),
    ).rejects.toThrow(/is closed and cannot be shipped/);
  });

  it("recomputes cartonCount from new qty (not orderQty)", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getProductVariantById.mockResolvedValue({ unitsPerVariant: 10 });

    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 25 }]);

    // 25 pieces / 10 per case = 3 cartons (ceil)
    expect(storage.bulkCreateInboundShipmentLines).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 25, cartonCount: 3 }),
      ]),
    );
  });

  it("legacy lineIds shape uses orderQty", async () => {
    const line1 = makeProductLine({ id: 1, sku: "A", orderQty: 50 });
    const line2 = makeProductLine({ id: 2, sku: "B", orderQty: 60 });
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);

    // lineIds param (4th arg) filters to those lines, uses orderQty
    await svc.addLinesFromPO(1, 10, undefined, [2]);

    const created = storage.bulkCreateInboundShipmentLines.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].purchaseOrderLineId).toBe(2);
    expect(created[0].qtyShipped).toBe(60); // orderQty, not custom qty
  });

  it("filters to selected poLineIds when lineSelections provided", async () => {
    const line1 = makeProductLine({ id: 1, sku: "A", orderQty: 50 });
    const line2 = makeProductLine({ id: 2, sku: "B", orderQty: 60 });
    storage.getPurchaseOrderLines.mockResolvedValue([line1, line2]);

    await svc.addLinesFromPO(1, 10, [{ poLineId: 2, qty: 30 }]);

    const created = storage.bulkCreateInboundShipmentLines.mock.calls[0][0];
    expect(created).toHaveLength(1);
    expect(created[0].purchaseOrderLineId).toBe(2);
    expect(created[0].qtyShipped).toBe(30);
  });

  it("allows qty equal to remaining", async () => {
    const poLine = makeProductLine({ id: 5, orderQty: 100, cancelledQty: 10 });
    storage.getPurchaseOrderLines.mockResolvedValue([poLine]);
    storage.getInboundShipmentLinesByPo.mockResolvedValue([
      { purchaseOrderLineId: 5, qtyShipped: 60, inboundShipmentId: 99 },
    ]);

    // remaining = 100 - 60 - 10 = 30
    await svc.addLinesFromPO(1, 10, [{ poLineId: 5, qty: 30 }]);

    expect(storage.bulkCreateInboundShipmentLines).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ qtyShipped: 30 }),
      ]),
    );
  });
});
