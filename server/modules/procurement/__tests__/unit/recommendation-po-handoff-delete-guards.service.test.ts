import { describe, expect, it, vi } from "vitest";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

describe("recommendation PO handoff delete guards", () => {
  it("blocks hard deletion of a mapped draft PO", async () => {
    const storage = {
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 41, status: "draft" }),
      getRecommendationPoHandoffForPo: vi.fn().mockResolvedValue({ id: 91, purchaseOrderId: 41 }),
      deletePurchaseOrder: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.deletePO(41)).rejects.toMatchObject<PurchasingError>({
      statusCode: 409,
      message: "Cannot delete a recommendation-created PO; cancel it to preserve the handoff audit trail",
      details: { code: "RECOMMENDATION_PO_DELETE_BLOCKED", handoffId: 91 },
    });
    expect(storage.deletePurchaseOrder).not.toHaveBeenCalled();
  });

  it("blocks hard deletion of a mapped recommendation line", async () => {
    const storage = {
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 51, purchaseOrderId: 41 }),
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 41, status: "draft" }),
      getRecommendationPoHandoffForLine: vi.fn().mockResolvedValue({ id: 92, purchaseOrderLineId: 51 }),
      deletePurchaseOrderLine: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.deleteLine(51, "admin-user")).rejects.toMatchObject<PurchasingError>({
      statusCode: 409,
      message: "Cannot delete a recommendation-created PO line; cancel the PO and accept a new recommendation",
      details: { code: "RECOMMENDATION_PO_LINE_DELETE_BLOCKED", handoffId: 92 },
    });
    expect(storage.deletePurchaseOrderLine).not.toHaveBeenCalled();
  });

  it("blocks amendments that would detach a mapped line from its accepted economics", async () => {
    const storage = {
      getPurchaseOrderLineById: vi.fn().mockResolvedValue({ id: 51, purchaseOrderId: 41 }),
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 41, status: "draft" }),
      getRecommendationPoHandoffForLine: vi.fn().mockResolvedValue({ id: 92, purchaseOrderLineId: 51 }),
      updatePurchaseOrderLine: vi.fn(),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.updateLine(51, { unitCostCents: 99 }, "admin-user")).rejects.toMatchObject<PurchasingError>({
      statusCode: 409,
      message: "Cannot amend a recommendation-created PO line; cancel the PO and accept a new recommendation",
      details: { code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED", handoffId: 92 },
    });
    expect(storage.updatePurchaseOrderLine).not.toHaveBeenCalled();
  });

  it("preserves hard deletion behavior for unmapped manual drafts", async () => {
    const storage = {
      getPurchaseOrderById: vi.fn().mockResolvedValue({ id: 41, status: "draft" }),
      getRecommendationPoHandoffForPo: vi.fn().mockResolvedValue(undefined),
      deletePurchaseOrder: vi.fn().mockResolvedValue(true),
    };
    const service = createPurchasingService({} as any, storage as any);

    await expect(service.deletePO(41)).resolves.toBe(true);
    expect(storage.deletePurchaseOrder).toHaveBeenCalledWith(41);
  });
});
