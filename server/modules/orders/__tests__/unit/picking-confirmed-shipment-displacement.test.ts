import { describe, expect, it, vi } from "vitest";

import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../picking.use-cases";

// #63688 shipped 10 packs from C-11 with nothing reserved, while every C-11 pack
// was promised to newer orders not yet picked. A confirmed shipment takes those
// units back from the newest unstarted orders; a live scan never does.

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const beforeItem = {
  id: 5, orderId: 63688, sku: "EG-SLV-SLM-P100", name: "Slim sleeves", quantity: 10, pickedQuantity: 0,
  fulfilledQuantity: 10, requiresShipping: 1, location: "C-11", status: "pending", shortReason: null, onHold: 0,
} as any;

function harness(options: { displace: ReturnType<typeof vi.fn>; pickClaimLine: ReturnType<typeof vi.fn> }) {
  let latestClaimId = "9";
  const replaceOrderClaim = vi.fn(async () => {
    throw codedError("CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT");
  });
  const displace = options.displace.getMockImplementation()
    ? options.displace
    : options.displace.mockImplementation(async () => {
      latestClaimId = "12";
      return { replacementClaim: { claimId: "12" }, displacedOrderIds: [63815, 63808] };
    });
  const context: InventoryAvailabilityRuntimeClaimContext = {
    authority: "canonical", authorityRevision: "2", activationRunId: "8", legacy: {} as any,
    canonical: { pickClaimLine: options.pickClaimLine, replaceOrderClaim, displaceForConfirmedShipment: displace } as any,
    getLatestClaim: vi.fn(async () => ({ claimId: latestClaimId, revision: 1, status: "active" as const, plan: {} as any })),
    getClaimLinePickMovementCursor: vi.fn(async (claimId: string) => `cursor-${claimId}`),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
  const storage = {
    getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: beforeItem.sku, requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 11, variantQty: 146 }]),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 11, code: "C-11", warehouseId: 1,
      isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
    getOrderItemById: vi.fn(async () => ({ ...beforeItem, pickedQuantity: 10, status: "completed" })),
  };
  const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 136 })) } as any,
    {} as any, storage as any);
  // A live scan is of an item that has not shipped; a confirmation is of one that has.
  const pick = (pickMethod: string) => (service as any).applyCanonicalPickProgress(context, { itemId: 5,
    beforeItem: pickMethod === "missed_pick_confirmation" ? beforeItem : { ...beforeItem, fulfilledQuantity: 0 },
    status: "completed", effectivePickedQuantity: 10, warehouseId: 1, warehouseLocationId: 11, userId: "picker", pickMethod,
    ...(pickMethod === "missed_pick_confirmation" ? { pickCorrectionId: 3, pickCorrectionRevision: 2 } : {}) });
  return { pick, displace, replaceOrderClaim };
}

describe("a confirmed shipment whose stock is promised to unstarted orders", () => {
  it("takes the shipped units from the newest unstarted orders, then records the pick", async () => {
    const pickClaimLine = vi.fn()
      .mockRejectedValueOnce(codedError("CLAIM_LINE_PICK_OVERAGE"))
      .mockResolvedValueOnce({ outcome: "picked", warehouseLocationIds: [11] });
    const { pick, displace } = harness({ displace: vi.fn(), pickClaimLine });

    await expect(pick("missed_pick_confirmation")).resolves.toMatchObject({ item: { pickedQuantity: 10 } });

    expect(displace).toHaveBeenCalledOnce();
    expect(displace).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 63688, expectedClaimId: "9", orderItemId: 5, quantity: "10", actor: "picker" }));
    expect(pickClaimLine.mock.calls[1][0]).toMatchObject({ claimId: "12", locationStrategy: "strict" });
  });

  it("explains a declined displacement without changing anything", async () => {
    const pickClaimLine = vi.fn().mockRejectedValue(codedError("CLAIM_LINE_PICK_OVERAGE"));
    const displace = vi.fn(async () => { throw codedError("CLAIM_DISPLACEMENT_NO_DONORS"); });
    const { pick } = harness({ displace, pickClaimLine });

    await expect(pick("missed_pick_confirmation")).rejects.toMatchObject({
      message: expect.stringContaining("Count or receive C-11"),
      context: expect.objectContaining({ reason: "claim_line_unreserved", refreshDeclinedCode: "CLAIM_DISPLACEMENT_NO_DONORS" }),
    });
    expect(pickClaimLine).toHaveBeenCalledOnce();
  });

  it("never displaces other orders for a live scan", async () => {
    const pickClaimLine = vi.fn().mockRejectedValue(codedError("CLAIM_LINE_PICK_OVERAGE"));
    const { pick, displace } = harness({ displace: vi.fn(), pickClaimLine });
    await expect(pick("scan")).rejects.toMatchObject({ context: expect.objectContaining({ reason: "claim_line_unreserved" }) });
    expect(displace).not.toHaveBeenCalled();
  });
});
