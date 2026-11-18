import { describe, expect, it, vi } from "vitest";
import type { InventoryAvailabilityClaimStore } from "../../application/inventory-availability-claim.port";
import { withChannelQuantityUpdates } from "../../application/order-claim-channel-quantity";

const claimed = { outcome: "claimed", orderId: 7, idempotentReplay: false } as never;
const noClaim = { outcome: "no_claim_required", orderId: 7, idempotentReplay: false } as never;
const replaced = { outcome: "replaced", orderId: 7 } as never;

function harness(overrides: Partial<Record<keyof InventoryAvailabilityClaimStore, unknown>> = {}) {
  const calls: string[] = [];
  const store = {
    getReservationStatus: vi.fn(async () => "status"),
    claimOrder: vi.fn(async () => { calls.push("claim"); return claimed; }),
    releaseOrderClaim: vi.fn(async () => { calls.push("release"); return claimed; }),
    replaceOrderClaim: vi.fn(async () => { calls.push("replace"); return replaced; }),
    displaceForConfirmedShipment: vi.fn(async () => ({ outcome: "replaced", orderId: 7, displacedOrderIds: [9, 11] })),
    executePackageOperation: vi.fn(async () => "package"),
    executeBuildOperation: vi.fn(async () => "build"),
    handoffBuildOperation: vi.fn(async () => "handoff"),
    pickClaimLine: vi.fn(async () => "pick"),
    unpickClaimLine: vi.fn(async () => "unpick"),
    reconcileCycleCount: vi.fn(async () => "count"),
    ...overrides,
  } as unknown as InventoryAvailabilityClaimStore;
  const variants = { listClaimedVariantIds: vi.fn(async (_orderIds: readonly number[]) => { calls.push("read"); return [101, 102]; }) };
  const announce = vi.fn(async (variantId: number) => { calls.push(`announce:${variantId}`); });
  const log = vi.fn();
  return { store, variants, announce, log, calls, wrapped: withChannelQuantityUpdates(store, { variants, announce, log }) };
}

describe("order claims update channel quantities", () => {
  it("marks every SKU the order touches, only after the claim has committed", async () => {
    const h = harness();
    await expect(h.wrapped.claimOrder({} as never)).resolves.toBe(claimed);
    expect(h.calls).toEqual(["claim", "read", "announce:101", "announce:102"]);
    expect(h.variants.listClaimedVariantIds).toHaveBeenCalledWith([7]);
    expect(h.announce).toHaveBeenCalledWith(101, "order_claim");
  });

  it("marks on release and on replacement, which give stock back", async () => {
    const h = harness();
    await h.wrapped.releaseOrderClaim({} as never);
    await h.wrapped.replaceOrderClaim({} as never);
    expect(h.announce).toHaveBeenCalledTimes(4);
  });

  it("marks the orders that gave up stock when a confirmed shipment displaces them", async () => {
    const h = harness();
    await h.wrapped.displaceForConfirmedShipment({} as never);
    expect(h.variants.listClaimedVariantIds).toHaveBeenCalledWith([7, 9, 11]);
  });

  it("marks again on an idempotent replay, because the first mark may have failed", async () => {
    const replay = { outcome: "claimed", orderId: 7, idempotentReplay: true } as never;
    const h = harness({ claimOrder: vi.fn(async () => replay) });
    await h.wrapped.claimOrder({} as never);
    expect(h.announce).toHaveBeenCalledTimes(2);
  });

  it("does nothing when no stock was claimed or released", async () => {
    const h = harness({ claimOrder: vi.fn(async () => noClaim), releaseOrderClaim: vi.fn(async () => noClaim) });
    await h.wrapped.claimOrder({} as never);
    await h.wrapped.releaseOrderClaim({} as never);
    expect(h.variants.listClaimedVariantIds).not.toHaveBeenCalled();
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("does not mark when the claim itself fails", async () => {
    const failure = new Error("claim rejected");
    const h = harness({ claimOrder: vi.fn(async () => { throw failure; }) });
    await expect(h.wrapped.claimOrder({} as never)).rejects.toBe(failure);
    expect(h.announce).not.toHaveBeenCalled();
  });

  it("returns the committed claim and logs a structured error when the mark fails", async () => {
    const h = harness();
    h.announce.mockRejectedValueOnce(new Error("lock timeout"));
    await expect(h.wrapped.claimOrder({} as never)).resolves.toBe(claimed);
    expect(h.log).toHaveBeenCalledWith({ level: "error", action: "order_claim", outcome: "channel_quantity_mark_failed",
      error_code: "ORDER_CLAIM_CHANNEL_QUANTITY_MARK_FAILED", wms_order_ids: [7], error: "lock timeout" });
  });

  it("passes every other claim command straight through without marking", async () => {
    const h = harness();
    await expect(h.wrapped.getReservationStatus({} as never)).resolves.toBe("status");
    await expect(h.wrapped.pickClaimLine({} as never)).resolves.toBe("pick");
    await expect(h.wrapped.unpickClaimLine({} as never)).resolves.toBe("unpick");
    await expect(h.wrapped.executePackageOperation({} as never)).resolves.toBe("package");
    await expect(h.wrapped.executeBuildOperation({} as never)).resolves.toBe("build");
    await expect(h.wrapped.handoffBuildOperation({} as never)).resolves.toBe("handoff");
    await expect(h.wrapped.reconcileCycleCount({} as never)).resolves.toBe("count");
    expect(h.announce).not.toHaveBeenCalled();
  });
});
