import { describe, expect, it, vi } from "vitest";
import { InventoryAvailabilityMasterDataError } from "../../../inventory-planning/domain/inventory-availability-master-data.contracts";
import { InventoryPlanningDropshipListingHoldGate } from "../../infrastructure/dropship-listing-hold.gate";

const COMMAND = { storeConnectionId: 77, reason: "Dropship vendor 10 paused: card_declined", idempotencyKey: "dropship-vendor-standing:10:1:held:77" };

function holdResult(command: "hold" | "release") {
  return {
    destination: { destinationKind: "dropship_store_connection" as const, connectionId: 77 },
    command,
    targets: [
      { publicationTargetId: 5, revision: "4", changed: true, publicationRows: 2, blockedProductIds: [9, 3] },
      { publicationTargetId: 6, revision: "2", changed: false, publicationRows: 1, blockedProductIds: [3] },
    ],
    alreadyApplied: false,
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: true,
  };
}

describe("InventoryPlanningDropshipListingHoldGate", () => {
  it("asks inventory planning to hold the store connection's live targets and sums what it touched", async () => {
    const hold = vi.fn(async () => holdResult("hold"));
    const release = vi.fn(async () => holdResult("release"));
    const gate = new InventoryPlanningDropshipListingHoldGate({ holdService: { hold, release } });

    await expect(gate.hold(COMMAND)).resolves.toEqual({ applied: true, targetCount: 2, publicationRows: 3, blockedProductIds: [3, 9] });
    expect(hold).toHaveBeenCalledWith({
      destination: { destinationKind: "dropship_store_connection", connectionId: 77 },
      reason: COMMAND.reason,
      idempotencyKey: COMMAND.idempotencyKey,
    }, "dropship-vendor-standing");
    expect(release).not.toHaveBeenCalled();

    await expect(gate.release(COMMAND)).resolves.toMatchObject({ applied: true, targetCount: 2 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("reports a busy or concurrent-change refusal as not applied so the reconciler retries", async () => {
    for (const status of [409, 503]) {
      const hold = vi.fn(async () => {
        throw new InventoryAvailabilityMasterDataError(status, "INVENTORY_PUBLICATION_TARGET_HOLD_BUSY", "Busy.");
      });
      const gate = new InventoryPlanningDropshipListingHoldGate({ holdService: { hold, release: vi.fn() } });
      await expect(gate.hold(COMMAND)).resolves.toEqual({ applied: false, code: "INVENTORY_PUBLICATION_TARGET_HOLD_BUSY", message: "Busy." });
    }
  });

  it("propagates anything else: a bad request or a bug is not something to retry hourly", async () => {
    const hold = vi.fn(async () => {
      throw new InventoryAvailabilityMasterDataError(400, "INVENTORY_PUBLICATION_TARGET_HOLD_INVALID_REQUEST", "Bad.");
    });
    const gate = new InventoryPlanningDropshipListingHoldGate({ holdService: { hold, release: vi.fn() } });
    await expect(gate.hold(COMMAND)).rejects.toMatchObject({ status: 400 });

    const crash = new InventoryPlanningDropshipListingHoldGate({
      holdService: { hold: vi.fn(async () => { throw new Error("boom"); }), release: vi.fn() },
    });
    await expect(crash.hold(COMMAND)).rejects.toThrow("boom");
  });
});
