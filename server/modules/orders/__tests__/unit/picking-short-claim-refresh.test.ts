import { describe, expect, it, vi } from "vitest";

import type { InventoryAvailabilityRuntimeClaimContext } from "../../../inventory-planning/application/inventory-availability-runtime-claim.service";
import { PickingUseCases } from "../../picking.use-cases";

// A line claimed while stock was missing has planned 0. Before this fix every
// pick on it failed forever with CLAIM_LINE_PICK_OVERAGE (#63658, #63669, #63678).

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

const beforeItem = {
  id: 500, orderId: 900, sku: "EG-SLV-SLM-P100", name: "Slim sleeves", quantity: 3, pickedQuantity: 0,
  requiresShipping: 1, location: "C-11", status: "pending", shortReason: null, onHold: 0,
} as any;

function harness(options: { replace: ReturnType<typeof vi.fn>; pickClaimLine: ReturnType<typeof vi.fn> }) {
  let latestClaimId = "9";
  // Default: the refresh succeeds and the order's latest claim becomes 10.
  options.replace.mockImplementation(async () => {
    latestClaimId = "10";
    return { replacementClaim: { claimId: "10" }, idempotentReplay: false };
  });
  const context: InventoryAvailabilityRuntimeClaimContext = {
    authority: "canonical", authorityRevision: "2", activationRunId: "8", legacy: {} as any,
    canonical: { pickClaimLine: options.pickClaimLine, replaceOrderClaim: options.replace } as any,
    getLatestClaim: vi.fn(async () => ({ claimId: latestClaimId, revision: 1, status: "active" as const, plan: {} as any })),
    getClaimLinePickMovementCursor: vi.fn(async (claimId: string) => `cursor-${claimId}`),
    getVariantMetadata: vi.fn(async () => new Map()),
    getOrderIdByShopifyOrderId: vi.fn(async () => null),
  };
  const storage = {
    getProductVariantBySku: vi.fn(async () => ({ id: 105, sku: beforeItem.sku, requiresShipping: true, trackInventory: true })),
    getInventoryLevelsByProductVariantId: vi.fn(async () => [{ warehouseLocationId: 1, variantQty: 50 }]),
    getAllWarehouseLocations: vi.fn(async () => [{ id: 1, code: "C-11", warehouseId: 1,
      isPickable: 1, isActive: 1, cycleCountFreezeId: null, locationType: "pick" }]),
    getOrderItemById: vi.fn(async () => ({ ...beforeItem, pickedQuantity: 3, status: "completed" })),
  };
  const service = new PickingUseCases({} as any, { getLevel: vi.fn(async () => ({ variantQty: 47 })) } as any,
    {} as any, storage as any);
  const pick = () => (service as any).applyCanonicalPickProgress(context, { itemId: 500, beforeItem,
    status: "completed", effectivePickedQuantity: 3, warehouseId: 1, userId: "picker", pickMethod: "scan" });
  return { pick, context };
}

describe("picking a line whose claim was planned short", () => {
  it("re-reserves from current stock once and retries the pick against the replacement claim", async () => {
    const pickClaimLine = vi.fn()
      .mockRejectedValueOnce(codedError("CLAIM_LINE_PICK_OVERAGE"))
      .mockResolvedValueOnce({ outcome: "picked", warehouseLocationIds: [1] });
    const replace = vi.fn();
    const { pick } = harness({ replace, pickClaimLine });

    await expect(pick()).resolves.toMatchObject({ item: { pickedQuantity: 3 } });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 900, expectedClaimId: "9", refreshSupply: true, actor: "picker",
    }));
    expect(pickClaimLine).toHaveBeenCalledTimes(2);
    expect(pickClaimLine.mock.calls[0][0]).toMatchObject({ claimId: "9", locationStrategy: "strict" });
    expect(pickClaimLine.mock.calls[1][0]).toMatchObject({ claimId: "10", locationStrategy: "strict" });
    // The retry is a different command, so it must not replay the failed one's key.
    expect(pickClaimLine.mock.calls[1][0].idempotencyKey).not.toBe(pickClaimLine.mock.calls[0][0].idempotencyKey);
  });

  it("explains the shortage plainly when no free stock exists, without retrying the pick", async () => {
    const pickClaimLine = vi.fn().mockRejectedValue(codedError("CLAIM_LINE_PICK_OVERAGE"));
    const replace = vi.fn();
    const context = harness({ replace, pickClaimLine });
    replace.mockReset().mockRejectedValue(codedError("CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT"));

    await expect(context.pick()).rejects.toMatchObject({
      message: expect.stringContaining("Count or receive C-11"),
      context: expect.objectContaining({ reason: "claim_line_unreserved", refreshDeclinedCode: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT" }),
    });
    expect(pickClaimLine).toHaveBeenCalledOnce();
  });

  it("propagates an unexpected refresh failure instead of masking it", async () => {
    const pickClaimLine = vi.fn().mockRejectedValue(codedError("CLAIM_LINE_PICK_OVERAGE"));
    const replace = vi.fn();
    const context = harness({ replace, pickClaimLine });
    replace.mockReset().mockRejectedValue(codedError("CLAIM_REPLACEMENT_RETRY_EXHAUSTED"));

    await expect(context.pick()).rejects.toMatchObject({ code: "CLAIM_REPLACEMENT_RETRY_EXHAUSTED" });
    expect(pickClaimLine).toHaveBeenCalledOnce();
  });

  it("retries against the newer claim when another writer refreshed it first", async () => {
    const pickClaimLine = vi.fn()
      .mockRejectedValueOnce(codedError("CLAIM_LINE_PICK_OVERAGE"))
      .mockResolvedValueOnce({ outcome: "picked", warehouseLocationIds: [1] });
    const replace = vi.fn();
    const context = harness({ replace, pickClaimLine });
    replace.mockReset().mockRejectedValue(codedError("ACTIVE_CLAIM_CHANGED"));

    await expect(context.pick()).resolves.toMatchObject({ item: { pickedQuantity: 3 } });
    expect(pickClaimLine).toHaveBeenCalledTimes(2);
  });

  it("does not refresh for other pick failures", async () => {
    const pickClaimLine = vi.fn().mockRejectedValue(codedError("CLAIM_WMS_PICK_CUSTODY_MISMATCH"));
    const replace = vi.fn();
    const context = harness({ replace, pickClaimLine });

    await expect(context.pick()).rejects.toMatchObject({ code: "CLAIM_WMS_PICK_CUSTODY_MISMATCH" });
    expect(replace).not.toHaveBeenCalled();
  });
});
