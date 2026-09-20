import { describe, expect, it, vi } from "vitest";
import { InventoryAvailabilityMasterDataError } from "../../../inventory-planning/domain/inventory-availability-master-data.contracts";
import { InventoryPlanningDropshipListingVariantHoldGate } from "../../infrastructure/dropship-listing-variant-hold.gate";

const COMMAND = {
  storeConnectionId: 77,
  productVariantIds: [105, 102],
  reason: "Dropship vendor 10: case tier below minimum (rev 3)",
  idempotencyKey: "dropship-listing-tier:10:3:case:hold:77:abcd1234",
};

function holdResult(command: "hold" | "release") {
  return {
    destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
    command,
    productVariantIds: [105, 102],
    targets: [
      { publicationTargetId: 5, revision: "4", changedProductVariantIds: [102, 105], publicationRows: 2, blockedProductIds: [9, 3] },
      { publicationTargetId: 6, revision: "2", changedProductVariantIds: [], publicationRows: 0, blockedProductIds: [3] },
    ],
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: true,
  };
}

describe("InventoryPlanningDropshipListingVariantHoldGate", () => {
  it("asks inventory planning to hold the named SKUs of the store's live targets and sums what it touched", async () => {
    const holdVariants = vi.fn(async () => holdResult("hold"));
    const releaseVariants = vi.fn(async () => holdResult("release"));
    const gate = new InventoryPlanningDropshipListingVariantHoldGate({ holdService: { holdVariants, releaseVariants } });

    expect(gate.maxVariantsPerCommand).toBe(500);
    await expect(gate.holdVariants(COMMAND)).resolves.toEqual({
      applied: true, targetCount: 2, publicationRows: 2, changedProductVariantIds: [102, 105], blockedProductIds: [3, 9],
    });
    expect(holdVariants).toHaveBeenCalledWith({
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      productVariantIds: [105, 102],
      reason: COMMAND.reason,
      idempotencyKey: COMMAND.idempotencyKey,
    }, "dropship-listing-tiers");
    expect(releaseVariants).not.toHaveBeenCalled();

    await expect(gate.releaseVariants(COMMAND)).resolves.toMatchObject({ applied: true, targetCount: 2 });
    expect(releaseVariants).toHaveBeenCalledTimes(1);
  });

  it("reports a busy or concurrent-change refusal as not applied so the reconciler retries", async () => {
    for (const status of [409, 503]) {
      const holdVariants = vi.fn(async () => {
        throw new InventoryAvailabilityMasterDataError(status, "INVENTORY_PUBLICATION_TARGET_BUSY", "Busy.");
      });
      const gate = new InventoryPlanningDropshipListingVariantHoldGate({ holdService: { holdVariants, releaseVariants: vi.fn() } });
      await expect(gate.holdVariants(COMMAND)).resolves.toEqual({ applied: false, code: "INVENTORY_PUBLICATION_TARGET_BUSY", message: "Busy." });
    }
  });

  it("propagates anything else: a bad request or a bug is not something to retry hourly", async () => {
    const holdVariants = vi.fn(async () => {
      throw new InventoryAvailabilityMasterDataError(400, "INVENTORY_PUBLICATION_TARGET_VARIANT_HOLD_INVALID_REQUEST", "Bad.");
    });
    const gate = new InventoryPlanningDropshipListingVariantHoldGate({ holdService: { holdVariants, releaseVariants: vi.fn() } });
    await expect(gate.holdVariants(COMMAND)).rejects.toMatchObject({ status: 400 });

    const crash = new InventoryPlanningDropshipListingVariantHoldGate({
      holdService: { holdVariants: vi.fn(async () => { throw new Error("boom"); }), releaseVariants: vi.fn() },
    });
    await expect(crash.holdVariants(COMMAND)).rejects.toThrow("boom");
  });
});
