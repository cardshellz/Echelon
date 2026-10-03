import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { isUnmappedOrderLine } from "@shared/unmapped-order-line";
import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../picking.use-cases";
import { isPermanentOrderReservationDataError, reservationErrorCode } from "../../../oms/reservation-error-classification";

// 2026-10-02: an order with an unmapped graded card (SKU "UNKNOWN") had no
// claim at all, so every line failed "The order has no active canonical
// availability claim to pick" and the order never reached ShipStation.

describe("isUnmappedOrderLine", () => {
  it("is true only for a line with no catalog identity at all", () => {
    expect(isUnmappedOrderLine({ sku: "UNKNOWN", catalogProductId: null, productId: null })).toBe(true);
    expect(isUnmappedOrderLine({ sku: " unknown ", catalogProductId: null, productId: null })).toBe(true);
    expect(isUnmappedOrderLine({ sku: "", catalogProductId: null, productId: null })).toBe(true);
    expect(isUnmappedOrderLine({ sku: null, catalogProductId: null, productId: null })).toBe(true);
  });

  it("never treats a real SKU or a catalog-linked line as unmapped", () => {
    expect(isUnmappedOrderLine({ sku: "EG-SLV-PF-P100", catalogProductId: null, productId: null })).toBe(false);
    expect(isUnmappedOrderLine({ sku: "UNKNOWN", catalogProductId: 5, productId: null })).toBe(false);
    expect(isUnmappedOrderLine({ sku: "UNKNOWN", catalogProductId: null, productId: 9 })).toBe(false);
  });
});

describe("reservation error classification", () => {
  it("treats bad order-line data as permanent and infrastructure failures as retryable", () => {
    expect(isPermanentOrderReservationDataError(Object.assign(new Error("x"), { code: "ORDER_ITEM_VARIANT_MISSING" }))).toBe(true);
    expect(isPermanentOrderReservationDataError(Object.assign(new Error("x"), { code: "CLAIM_RETRY_EXHAUSTED" }))).toBe(false);
    expect(isPermanentOrderReservationDataError(new Error("connection reset"))).toBe(false);
    expect(reservationErrorCode({ cause: { cause: { code: "ORDER_ITEM_NOT_CLAIMABLE" } } })).toBe("ORDER_ITEM_NOT_CLAIMABLE");
  });
});

function harness(options: { item: Record<string, unknown>; latest: null | { claimId: string; status: "active" | "released" };
  claimOrder?: ReturnType<typeof vi.fn> }) {
  const beforeItem = { id: 7, orderId: 63662, quantity: 1, pickedQuantity: 0, fulfilledQuantity: 0,
    requiresShipping: 1, status: "pending", shortReason: null, onHold: 0, ...options.item } as any;
  let latest = options.latest;
  const claimOrder = options.claimOrder ?? vi.fn(async () => {
    latest = { claimId: "70", status: "active" };
    return { outcome: "claimed", claimId: "70" };
  });
  const pickClaimLine = vi.fn(async () => ({ outcome: "picked", warehouseLocationIds: [13] }));
  const context: InventoryAvailabilityRuntimeClaimContext = {
    authority: "canonical", authorityRevision: "2", activationRunId: "8", legacy: {} as any,
    canonical: { pickClaimLine, claimOrder, replaceOrderClaim: vi.fn() } as any,
    getLatestClaim: vi.fn(async () => latest && { ...latest, revision: 1, plan: {} as any }),
    getClaimLinePickMovementCursor: vi.fn(async () => "cursor"),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
  const audit = vi.fn(async () => undefined);
  const after = { ...beforeItem, pickedQuantity: 1, status: "completed" };
  const tx = {
    execute: vi.fn(async (statement: unknown) => {
      const text = JSON.stringify(statement);
      if (text.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "ready", on_hold: 0 }] };
      return { rows: [{ status: beforeItem.status, picked_quantity: 0, fulfilled_quantity: 0,
        quantity: beforeItem.quantity, short_reason: null, picked_at: null }] };
    }),
    update: vi.fn(() => ({ set: () => ({ where: () => ({ returning: async () => [after] }) }) })),
    insert: vi.fn(() => ({ values: audit })),
  };
  const db = { transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(tx)) };
  const storage = {
    getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: "EG-SLV-PF-P100", requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 13, variantQty: 5 }]),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 13, code: "C-13", warehouseId: 1,
      isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
    getOrderItemById: vi.fn(async () => after),
  };
  const service = new PickingUseCases(db as any, { getLevel: vi.fn(async () => ({ variantQty: 4 })) } as any,
    {} as any, storage as any);
  const pick = () => (service as any).applyCanonicalPickProgress(context, { itemId: 7, beforeItem,
    status: "completed", effectivePickedQuantity: 1, warehouseId: 1, userId: "picker", pickMethod: "scan" });
  return { pick, claimOrder, pickClaimLine, storage, audit };
}

describe("picking an order that carries an unmapped line", () => {
  it("confirms the unmapped line without stock, a claim or a catalog lookup", async () => {
    const { pick, claimOrder, pickClaimLine, storage, audit } = harness({
      item: { sku: "UNKNOWN", name: "2023 Topps Now Victor Wembanyama Draft RC PSA 9", catalogProductId: null, productId: null },
      latest: null,
    });
    await expect(pick()).resolves.toMatchObject({ item: { pickedQuantity: 1 } });
    expect(pickClaimLine).not.toHaveBeenCalled();
    expect(claimOrder).not.toHaveBeenCalled();
    expect(storage.getProductVariantBySku).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "wms.unmapped_item_pick_confirmed" }));
  });

  it("reserves a never-reserved order on the spot, then picks its normal line", async () => {
    const { pick, claimOrder, pickClaimLine } = harness({
      item: { sku: "EG-SLV-PF-P100", catalogProductId: null, productId: null, location: "C-13" },
      latest: null,
    });
    await expect(pick()).resolves.toMatchObject({ item: { pickedQuantity: 1 } });
    expect(claimOrder).toHaveBeenCalledWith(expect.objectContaining({ orderId: 63662, actor: "picker" }));
    expect((claimOrder.mock.calls as unknown as Array<[Record<string, unknown>]>)[0][0]).not.toHaveProperty("recordConfirmedShipment");
    expect(pickClaimLine).toHaveBeenCalledWith(expect.objectContaining({ claimId: "70" }));
  });

  it("never re-creates a claim that was released", async () => {
    const claimOrder = vi.fn();
    const { pick } = harness({
      item: { sku: "EG-SLV-PF-P100", catalogProductId: null, productId: null, location: "C-13" },
      latest: { claimId: "69", status: "released" },
      claimOrder,
    });
    await expect(pick()).rejects.toMatchObject({ context: expect.objectContaining({ reason: "active_canonical_claim_missing" }) });
    expect(claimOrder).not.toHaveBeenCalled();
  });
});

describe("claim contract for unmapped lines", () => {
  const repository = readFileSync(resolve(process.cwd(),
    "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts"), "utf8");

  it("skips a line with no catalog identity before the missing-variant refusal", () => {
    const skip = repository.indexOf("if (isUnmappedOrderLine({ sku:");
    expect(skip).toBeGreaterThan(0);
    expect(skip).toBeLessThan(repository.indexOf('"ORDER_ITEM_VARIANT_MISSING"'));
  });
});
