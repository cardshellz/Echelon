import { describe, expect, it, vi } from "vitest";
import { refreshShortClaims } from "../../oms-flow-reconciliation.service";

function deps(refreshShortClaimSupply?: ReturnType<typeof vi.fn>) {
  return {
    reservation: { reserveOrder: vi.fn(), releaseOrderReservation: vi.fn(), refreshShortClaimSupply },
    fulfillmentAuthority: {} as any,
  } as any;
}
const db = (orderIds: number[]) => ({ execute: vi.fn(async () => ({ rows: orderIds.map((order_id) => ({ order_id })) })) });

describe("refreshShortClaims", () => {
  it("is a no-op when the reservation service cannot refresh (legacy wiring)", async () => {
    const database = db([1]);
    await expect(refreshShortClaims(database, deps(undefined))).resolves.toEqual({ refreshed: 0, declined: 0, failed: 0 });
    expect(database.execute).not.toHaveBeenCalled();
  });

  it("refreshes each candidate and counts expected declines without failing the run", async () => {
    const refresh = vi.fn()
      .mockResolvedValueOnce({ outcome: "refreshed", claimId: "10", idempotentReplay: false })
      .mockResolvedValueOnce({ outcome: "declined", code: "CLAIM_SUPPLY_REFRESH_NO_IMPROVEMENT", message: "none" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(refreshShortClaims(db([63658, 63669]), deps(refresh)))
      .resolves.toEqual({ refreshed: 1, declined: 1, failed: 0 });
    expect(refresh.mock.calls.map(([orderId]) => orderId)).toEqual([63658, 63669]);
    log.mockRestore();
  });

  it("keeps going after an unexpected failure, then reports it on the heartbeat", async () => {
    const refresh = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "CLAIM_REPLACEMENT_RETRY_EXHAUSTED" }))
      .mockResolvedValueOnce({ outcome: "refreshed", claimId: "11", idempotentReplay: false });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(refreshShortClaims(db([1, 2]), deps(refresh))).rejects.toThrow("short-claim refresh failed for 1 order(s)");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain("CLAIM_REPLACEMENT_RETRY_EXHAUSTED");
    error.mockRestore();
    log.mockRestore();
  });
});
