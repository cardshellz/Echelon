import { describe, expect, it, vi } from "vitest";
import {
  purchaseOrderLines,
  purchaseOrders,
  purchasingRecommendationPoHandoffs,
} from "@shared/schema";
import { createPurchasingService, PurchasingError } from "../../purchasing.service";

const VERSION = new Date("2026-07-13T12:00:00.000Z");

function recommendationOwnedLineDb() {
  const rowsFor = (table: unknown) => {
    if (table === purchaseOrderLines) return [{ id: 51, purchaseOrderId: 41 }];
    if (table === purchaseOrders) {
      return [{
        id: 41,
        status: "draft",
        physicalStatus: "draft",
        financialStatus: "unbilled",
        invoicedTotalCents: 0,
        paidTotalCents: 0,
        updatedAt: VERSION,
      }];
    }
    if (table === purchasingRecommendationPoHandoffs) return [{ id: 92 }];
    return [];
  };
  const tx = {
    select: vi.fn(() => {
      let table: unknown;
      const builder: any = {
        from: vi.fn((nextTable: unknown) => {
          table = nextTable;
          return builder;
        }),
        where: vi.fn(() => builder),
        limit: vi.fn(() => builder),
        for: vi.fn(async () => rowsFor(table)),
        then: (resolve: (rows: unknown[]) => unknown) => resolve(rowsFor(table)),
      };
      return builder;
    }),
  };
  return {
    transaction: vi.fn((work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  };
}

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

  it("blocks soft cancellation of a recommendation-owned line", async () => {
    const db = recommendationOwnedLineDb();
    const service = createPurchasingService(db as any, {} as any);

    await expect(service.deleteLine(51, {
      expectedPoUpdatedAt: VERSION.toISOString(),
      expectedLineUpdatedAt: VERSION.toISOString(),
      reason: "Operator requested removal",
    }, "admin-user")).rejects.toMatchObject<PurchasingError>({
      statusCode: 409,
      message: "Recommendation-created purchase orders must be cancelled and regenerated instead of edited",
      details: { code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED", handoffId: 92 },
    });
  });

  it("blocks amendments that would detach a mapped line from its accepted economics", async () => {
    const db = recommendationOwnedLineDb();
    const service = createPurchasingService(db as any, {} as any);

    await expect(service.updateLine(51, {
      expectedPoUpdatedAt: VERSION.toISOString(),
      expectedLineUpdatedAt: VERSION.toISOString(),
      notes: "Attempted edit",
    }, "admin-user")).rejects.toMatchObject<PurchasingError>({
      statusCode: 409,
      message: "Recommendation-created purchase orders must be cancelled and regenerated instead of edited",
      details: { code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED", handoffId: 92 },
    });
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
