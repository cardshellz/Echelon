import { describe, expect, it, vi } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

describe("createPOFromReorder", () => {
  it("persists recommendation quantities as base pieces with explicit receive configuration", async () => {
    const po = { id: 99, vendorId: 7, status: "draft", discountCents: 0, taxCents: 0, shippingCostCents: 0 };
    const lines: any[] = [];
    const storage = {
      getVendorProductById: vi.fn().mockResolvedValue({
        id: 501,
        vendorId: 7,
        productId: 1,
        productVariantId: null,
        isActive: 1,
        isPreferred: 1,
        unitCostCents: 1,
        unitCostMills: 50,
        vendorSku: "VENDOR-CASE-100",
      }),
      getPurchaseOrders: vi.fn().mockResolvedValue([]),
      getVendorById: vi.fn().mockResolvedValue({
        id: 7,
        currency: "USD",
        paymentTermsDays: 30,
        paymentTermsType: "net",
        shipFromAddress: "Vendor",
      }),
      generatePoNumber: vi.fn().mockResolvedValue("PO-20260711-001"),
      createPurchaseOrder: vi.fn().mockResolvedValue(po),
      getPurchaseOrderById: vi.fn().mockImplementation(async () => po),
      getPurchaseOrderLines: vi.fn().mockImplementation(async () => lines),
      getProductVariantById: vi.fn().mockResolvedValue({
        id: 11,
        productId: 1,
        name: "Case of 100",
        sku: "CASE-100",
        unitsPerVariant: 100,
      }),
      getProductById: vi.fn().mockResolvedValue({ id: 1, sku: "PRODUCT-1", name: "Product", baseUnit: "piece" }),
      bulkCreatePurchaseOrderLines: vi.fn().mockImplementation(async (created) => {
        lines.push(...created.map((line: any, index: number) => ({ id: index + 1, ...line })));
        return lines;
      }),
      updatePurchaseOrderLine: vi.fn(),
      updatePurchaseOrder: vi.fn().mockImplementation(async (_id, updates) => Object.assign(po, updates)),
    };
    const service = createPurchasingService({} as any, storage as any);

    const result = await service.createPOFromReorder([{
      productId: 1,
      productVariantId: 11,
      suggestedPieces: 300,
      vendorProductId: 501,
      vendorId: 7,
    }], "buyer-1");

    expect(storage.createPurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorId: 7,
        source: "reorder",
        createdBy: "buyer-1",
      }),
      expect.objectContaining({
        fromStatus: null,
        toStatus: "draft",
        changedBy: "buyer-1",
      }),
    );
    expect(storage.bulkCreatePurchaseOrderLines).toHaveBeenCalledWith([
      expect.objectContaining({
        purchaseOrderId: 99,
        productId: 1,
        productVariantId: 11,
        expectedReceiveVariantId: 11,
        expectedReceiveUnitsPerVariant: 100,
        orderQty: 300,
        unitsPerUom: 100,
        unitCostMills: 50,
        unitCostCents: 1,
        totalProductCostCents: 150,
        packagingCostCents: 0,
        lineTotalCents: 150,
      }),
    ]);
    expect(result).toEqual([expect.objectContaining({ id: 99, subtotalCents: 150, totalCents: 150 })]);
  });

  it("rejects non-piece-safe quantities before reading or writing storage", async () => {
    const storage = {
      getVendorProductById: vi.fn(),
      getPreferredVendorProduct: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.createPOFromReorder([{
      productId: 1,
      productVariantId: 11,
      suggestedPieces: 1.5,
      vendorId: 7,
    }], "buyer-1")).rejects.toMatchObject<PurchasingError>({
      message: "Reorder suggested pieces must be a positive safe integer",
      statusCode: 400,
    });
    expect(storage.getVendorProductById).not.toHaveBeenCalled();
    expect(storage.getPreferredVendorProduct).not.toHaveBeenCalled();
  });

  it("rejects an exact supplier row with no positive cost before creating a PO", async () => {
    const storage = {
      getVendorProductById: vi.fn().mockResolvedValue({
        id: 501,
        vendorId: 7,
        productId: 1,
        productVariantId: null,
        isActive: 1,
        isPreferred: 1,
        unitCostCents: 0,
        unitCostMills: null,
      }),
      getPurchaseOrders: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.createPOFromReorder([{
      productId: 1,
      productVariantId: 11,
      suggestedPieces: 300,
      vendorProductId: 501,
      vendorId: 7,
    }], "buyer-1")).rejects.toMatchObject<PurchasingError>({
      message: "Vendor product 501 has invalid supplier cost: estimatedCostCents must be a positive safe integer",
      statusCode: 409,
    });
    expect(storage.getPurchaseOrders).not.toHaveBeenCalled();
  });

  it("rejects an exact supplier row that belongs to another vendor", async () => {
    const storage = {
      getVendorProductById: vi.fn().mockResolvedValue({
        id: 501,
        vendorId: 8,
        productId: 1,
        productVariantId: null,
        isActive: 1,
        isPreferred: 1,
        unitCostCents: 1,
        unitCostMills: 50,
      }),
      getPurchaseOrders: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.createPOFromReorder([{
      productId: 1,
      productVariantId: 11,
      suggestedPieces: 300,
      vendorProductId: 501,
      vendorId: 7,
    }], "buyer-1")).rejects.toMatchObject<PurchasingError>({
      message: "Vendor product 501 does not belong to vendor 7",
      statusCode: 400,
    });
    expect(storage.getPurchaseOrders).not.toHaveBeenCalled();
  });
});
