import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { PickingUseCases } from "../../picking.use-cases";
import { type PickCorrection } from "@shared/pick-corrections";

const correction: PickCorrection = { id: 1, orderId: 70, orderItemId: 71, orderNumber: "#70", sku: "P5",
  name: "Pack", location: "A-01", barcode: "123", declaredQuantity: 3, pickedQuantity: 1,
  state: "picking_required", answer: "yes", revision: 2, assignedPickerId: "picker", reviewReason: null };

describe("existing inventory owner corrective-pick fences", () => {
  it("allows a shipped non-stock item to confirm its pick without inventory movement", async () => {
    const before = { id: 71, orderId: 70, quantity: 3, pickedQuantity: 1,
      status: "in_progress", shortReason: null, inventoryTracking: false, catalogProductId: 5 };
    const after = { ...before, pickedQuantity: 3, status: "completed" };
    const audit = vi.fn(async () => undefined);
    const tx = {
      execute: vi.fn(async statement => {
        const query = new PgDialect().sqlToQuery(statement).sql;
        if (query.includes('AS "orderNumber"')) return { rows: [correction] };
        if (query.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "shipped", on_hold: 0 }] };
        if (query.includes("FROM wms.order_items")) return { rows: [{ status: before.status,
          picked_quantity: 1, fulfilled_quantity: 3, quantity: 3, short_reason: null }] };
        return { rows: [{ id: 1 }] };
      }),
      update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [after] }) }) })),
      insert: vi.fn(() => ({ values: audit })),
    };
    const db = { transaction: vi.fn(async work => work(tx)) };
    const inventoryCore = { pickItem: vi.fn() };
    const owner = new PickingUseCases(db as any, inventoryCore as any, {} as any, {} as any);
    await expect((owner as any).persistWmsOnlyPickProgress({ itemId: 71, beforeItem: before,
      effectivePickedQuantity: 3, status: "completed", userId: "picker",
      pickCorrectionId: 1, pickCorrectionRevision: 2,
    })).resolves.toMatchObject({ item: { pickedQuantity: 3 }, deductResult: { noVariant: true } });
    expect(inventoryCore.pickItem).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "wms.non_inventory_pick_confirmed" }));
  });
  it.each([{ quantity: 3, unproven: 0 }, { quantity: 0, unproven: 1 }])(
    "does not debit stock already shipped or with unproven shipment quantity: %j", async posted => {
      const tx = { execute: vi.fn(async statement => {
        const query = new PgDialect().sqlToQuery(statement).sql;
        if (query.includes('AS "orderNumber"')) return { rows: [correction] };
        if (query.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "shipped", on_hold: 0 }] };
        if (query.includes("FROM wms.order_items")) return { rows: [{ status: "in_progress", picked_quantity: 1, quantity: 3 }] };
        if (query.includes("FROM inventory.inventory_transactions")) return { rows: [posted] };
        return { rows: [{ id: 1 }] };
      }) };
      const inventoryCore = { pickItem: vi.fn() };
      const service = new PickingUseCases({} as any, inventoryCore as any, {} as any, {} as any);
      await expect((service as any).applyLegacyPickProgressTransaction(tx, {
        itemId: 71, beforeItem: { orderId: 70 }, status: "completed", effectivePickedQuantity: 3,
        inventoryCore, pickCorrectionId: 1, pickCorrectionRevision: 2, userId: "picker",
      })).rejects.toMatchObject({ code: "POSTED_INVENTORY_REVIEW_REQUIRED" });
      expect(inventoryCore.pickItem).not.toHaveBeenCalled();
      expect(tx.execute.mock.calls.some(([statement]) => /UPDATE|INSERT/.test(new PgDialect().sqlToQuery(statement).sql.replace("FOR UPDATE", "")))).toBe(false);
    });

  it("cannot use a correction to pick a cancelled order", async () => {
    const tx = { execute: vi.fn(async () => ({ rows: [{ warehouse_status: "cancelled", on_hold: 0 }] })) };
    const service = new PickingUseCases({} as any, {} as any, {} as any, {} as any);
    await expect((service as any).applyLegacyPickProgressTransaction(tx, {
      itemId: 71, beforeItem: { orderId: 70 }, pickCorrectionId: 1,
    })).rejects.toThrow("cancelled");
    expect(tx.execute).toHaveBeenCalledOnce();
  });
});
