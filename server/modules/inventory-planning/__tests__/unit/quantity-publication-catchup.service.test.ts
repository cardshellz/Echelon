import { describe, expect, it, vi } from "vitest";
import { QuantityPublicationCatchupService, type QuantityPublicationCatchup, type QuantityPublicationCatchupStore } from "../../application/quantity-publication-admission.port";

const claim: QuantityPublicationCatchup = { catchupId: "10", revision: "2", attemptBoundaryId: "8",
  scope: { destinationKind: "channel_connection", connectionId: 1, providerKey: "ebay", providerScopeType: "account",
    externalScopeId: "account", externalInventoryItemId: "SKU-A", productId: 20, productVariantId: 101 } };
function fixture() {
  const store = { listDue: vi.fn(async () => [claim]), complete: vi.fn<QuantityPublicationCatchupStore["complete"]>(),
    fail: vi.fn<QuantityPublicationCatchupStore["fail"]>().mockResolvedValue(undefined) };
  const replan = vi.fn<ConstructorParameters<typeof QuantityPublicationCatchupService>[1]>();
  return { store, replan, service: new QuantityPublicationCatchupService(store, replan) };
}

describe("exact-scope catch-up completion before replan", () => {
  it("completes delivered work without invoking an unrelated failing resolver", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(true);
    f.replan.mockRejectedValue(new Error("Unrelated channel configuration is invalid"));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(f.store.complete).toHaveBeenCalledExactlyOnceWith(claim);
    expect(f.replan).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
  });
  it("replans unproven work and passes its exact canonical handoff to the second completion check", async () => {
    const f = fixture(); f.store.complete.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    f.replan.mockResolvedValue({ outboxId: "99" });
    await expect(f.service.processDue(1)).resolves.toEqual({ completed: 1, failed: 0 });
    expect(f.store.listDue).toHaveBeenCalledWith(1);
    expect(f.replan).toHaveBeenCalledExactlyOnceWith(claim.scope, claim);
    expect(f.store.complete.mock.calls).toEqual([[claim], [claim, { outboxId: "99" }]]);
    expect(f.store.complete.mock.invocationCallOrder[0]).toBeLessThan(f.replan.mock.invocationCallOrder[0]);
    expect(f.replan.mock.invocationCallOrder[0]).toBeLessThan(f.store.complete.mock.invocationCallOrder[1]);
  });
  it("requires recorded delivery after a void legacy callback instead of treating resolution as delivery", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false); f.replan.mockResolvedValue(undefined);
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.complete.mock.calls).toEqual([[claim], [claim, undefined]]);
    expect(f.store.fail).toHaveBeenCalledWith(claim, "PUBLICATION_CATCHUP_DELIVERY_UNPROVEN", expect.any(String));
  });
  it("retains unproven work when current replanning fails", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(Object.assign(new Error("Exact scope unavailable"), { code: "SCOPE_UNAVAILABLE" }));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.complete).toHaveBeenCalledOnce();
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, "SCOPE_UNAVAILABLE", "Exact scope unavailable");
  });
  it("does not publish when the preflight database proof fails", async () => {
    const f = fixture(); f.store.complete.mockRejectedValue(new Error("Proof read failed"));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.replan).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledWith(claim, "PUBLICATION_CATCHUP_FAILED", "Proof read failed");
  });
  it.each([0, -1, NaN, Infinity, 1.5, 101])("rejects invalid batch bound %s before storage", async limit => {
    const f = fixture(); await expect(f.service.processDue(limit)).rejects.toThrow("Invalid catch-up batch size");
    expect(f.store.listDue).not.toHaveBeenCalled();
  });
});
