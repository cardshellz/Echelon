import { describe, expect, it, vi } from "vitest";

import { createReservationService } from "../../reservation.service";

describe("legacy reservation demand reconciliation", () => {
  it("does not mutate reservations when a retry observed no new WMS demand change", async () => {
    const service = createService();
    const release = vi.spyOn(service, "releaseOrderReservation");
    const reserve = vi.spyOn(service, "reserveOrder");

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: false,
      reason: "order edited",
    })).resolves.toMatchObject({ reconciled: false });
    expect(release).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("retains the deployed release-then-reserve sequence for a changed legacy order", async () => {
    const service = createService();
    const release = vi.spyOn(service, "releaseOrderReservation").mockResolvedValue({
      released: 1,
      failed: [],
    });
    const reservation = {
      orderId: 42,
      reserved: 1,
      promised: 0,
      failed: [],
      totalBaseUnits: 1,
      totalPromisedBaseUnits: 0,
    };
    const reserve = vi.spyOn(service, "reserveOrder").mockResolvedValue(reservation);

    await expect(service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
      userId: "user:7",
    })).resolves.toEqual({
      reconciled: true,
      release: { released: 1, failed: [] },
      reservation,
    });
    expect(release).toHaveBeenCalledWith(
      42,
      "order edited",
      "user:7",
      { disposition: "release" },
    );
    expect(reserve).toHaveBeenCalledWith(42, "user:7");
  });

  it("propagates one authority transaction through both legacy reconciliation steps", async () => {
    const service = createService();
    const dbOverride = { execute: vi.fn() };
    const release = vi.spyOn(service, "releaseOrderReservation").mockResolvedValue({
      released: 0,
      failed: [],
    });
    const reserve = vi.spyOn(service, "reserveOrder").mockResolvedValue({
      orderId: 42,
      reserved: 0,
      promised: 0,
      failed: [],
      totalBaseUnits: 0,
      totalPromisedBaseUnits: 0,
    });

    await service.reconcileOrderDemand({
      orderId: 42,
      sourceEventId: "webhook_inbox:900",
      demandChanged: true,
      reason: "order edited",
      dbOverride,
    });

    expect(release).toHaveBeenCalledWith(
      42,
      "order edited",
      undefined,
      { disposition: "release", dbOverride },
    );
    expect(reserve).toHaveBeenCalledWith(42, undefined, dbOverride);
  });
});

function createService() {
  return createReservationService(
    {} as never,
    {} as never,
    { queueSyncAfterInventoryChange: vi.fn() },
    {} as never,
  );
}
