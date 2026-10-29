import { describe, expect, it, vi } from "vitest";
import { QuantityPublicationCatchupService, type QuantityPublicationCatchup, type QuantityPublicationCatchupStore } from "../../application/quantity-publication-admission.port";

const claim: QuantityPublicationCatchup = { catchupId: "10", revision: "2", attemptBoundaryId: "8",
  scope: { destinationKind: "channel_connection", connectionId: 1, providerKey: "ebay", providerScopeType: "account",
    externalScopeId: "account", externalInventoryItemId: "SKU-A", productId: 20, productVariantId: 101 } };
function fixture() {
  const store = { settleArchived: vi.fn<QuantityPublicationCatchupStore["settleArchived"]>().mockResolvedValue(false), listDue: vi.fn(async () => [claim]), complete: vi.fn<QuantityPublicationCatchupStore["complete"]>(),
    fail: vi.fn<QuantityPublicationCatchupStore["fail"]>().mockResolvedValue(1),
    park: vi.fn<QuantityPublicationCatchupStore["park"]>().mockResolvedValue("parked") };
  const replan = vi.fn<ConstructorParameters<typeof QuantityPublicationCatchupService>[1]>();
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { store, replan, log, service: new QuantityPublicationCatchupService(store, replan, undefined, log) };
}

describe("exact-scope catch-up completion before replan", () => {
  it("completes delivered work without invoking an unrelated failing resolver", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(true);
    f.replan.mockRejectedValue(new Error("Unrelated channel configuration is invalid"));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(f.store.complete).toHaveBeenCalledExactlyOnceWith(claim);
    expect(f.replan).not.toHaveBeenCalled(); expect(f.store.fail).not.toHaveBeenCalled();
    expect(f.store.settleArchived).not.toHaveBeenCalled();
  });
  it("settles proven Catalog archival before replanning", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.store.settleArchived.mockResolvedValue(true);
    await expect(f.service.processDue()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(f.store.settleArchived).toHaveBeenCalledExactlyOnceWith(claim);
    expect(f.store.complete).toHaveBeenCalledExactlyOnceWith(claim);
    expect(f.replan).not.toHaveBeenCalled();
    expect(f.store.fail).not.toHaveBeenCalled();
  });
  it("retains the request when archive proof is busy instead of replanning through the conflict", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.store.settleArchived.mockRejectedValue(Object.assign(new Error("Selection changed"), {
      code: "PUBLICATION_CATCHUP_SETTLEMENT_BUSY",
    }));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.replan).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, "PUBLICATION_CATCHUP_SETTLEMENT_BUSY", "Selection changed", "paused");
  });
  it("does not treat generic variant ineligibility as proven archival", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(Object.assign(new Error("Current publication scope omits the member"), {
      code: "CANONICAL_PUBLICATION_VARIANT_NOT_ELIGIBLE",
    }));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.settleArchived).toHaveBeenCalledExactlyOnceWith(claim);
    expect(f.store.fail).toHaveBeenCalledWith(claim, "CANONICAL_PUBLICATION_VARIANT_NOT_ELIGIBLE", expect.any(String), "transient");
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
    expect(f.store.fail).toHaveBeenCalledWith(claim, "PUBLICATION_CATCHUP_DELIVERY_UNPROVEN", expect.any(String), "transient");
  });
  it("retains unproven work when current replanning fails", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(Object.assign(new Error("Exact scope unavailable"), { code: "SCOPE_UNAVAILABLE" }));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.complete).toHaveBeenCalledOnce();
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, "SCOPE_UNAVAILABLE", "Exact scope unavailable", "transient");
  });
  it("does not publish when the preflight database proof fails", async () => {
    const f = fixture(); f.store.complete.mockRejectedValue(new Error("Proof read failed"));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.replan).not.toHaveBeenCalled();
    expect(f.store.fail).toHaveBeenCalledWith(claim, "PUBLICATION_CATCHUP_FAILED", "Proof read failed", "transient");
  });
  it.each([0, -1, NaN, Infinity, 1.5, 101])("rejects invalid batch bound %s before storage", async limit => {
    const f = fixture(); await expect(f.service.processDue(limit)).rejects.toThrow("Invalid catch-up batch size");
    expect(f.store.listDue).not.toHaveBeenCalled();
  });
});

// Channels PR5 (PLAN-CH-v3 section 6): each failure is persisted by its class.
describe("catch-up failure classes", () => {
  const refusal = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), { code, ...extra });

  it.each(["PUBLICATION_LISTING_TARGET_UNMAPPED", "PUBLICATION_LISTING_PLAN_OMITTED", "CANONICAL_PUBLICATION_MAPPING_MISSING"])
  ("parks a missing-link refusal (%s) instead of counting a retry", async code => {
    const f = fixture(); f.store.complete.mockResolvedValue(false); f.replan.mockRejectedValue(refusal(code));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.park).toHaveBeenCalledExactlyOnceWith(claim, code, code);
    expect(f.store.fail).not.toHaveBeenCalled();
    expect(f.log.warn).not.toHaveBeenCalled(); expect(f.log.error).not.toHaveBeenCalled();
    expect(f.log.debug).toHaveBeenCalledWith("inventory.quantity_catchup.parked", expect.objectContaining({ outcome: "parked", error_code: code }));
  });

  it("counts a missing-link row the store settled as completed", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(refusal("PUBLICATION_LISTING_TARGET_UNMAPPED")); f.store.park.mockResolvedValue("settled");
    await expect(f.service.processDue()).resolves.toEqual({ completed: 1, failed: 0 });
    expect(f.log.info).toHaveBeenCalledWith("inventory.quantity_catchup.settled_identity_retired", expect.objectContaining({ catchup_id: "10" }));
  });

  it("persists a failed park proof by its own class without aborting the batch", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(refusal("PUBLICATION_LISTING_TARGET_UNMAPPED"));
    f.store.park.mockRejectedValue(refusal("PUBLICATION_CATCHUP_SCOPE_MISMATCH"));
    await expect(f.service.processDue()).resolves.toEqual({ completed: 0, failed: 1 });
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, "PUBLICATION_CATCHUP_SCOPE_MISMATCH", "PUBLICATION_CATCHUP_SCOPE_MISMATCH", "permanent");
  });

  it.each(["55P03", "PUBLICATION_SCOPE_BUSY", "PUBLICATION_ADMISSION_CAPACITY_BUSY", "CUTOVER_CONFIGURATION_FREEZE_CHANGED", "PUBLICATION_GLOBAL_STOP_ACTIVE"])
  ("pauses a busy condition (%s) without an attempt or a warning", async code => {
    const f = fixture(); f.store.complete.mockResolvedValue(false); f.replan.mockRejectedValue(refusal(code));
    await f.service.processDue();
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, code, code, "paused");
    expect(f.log.warn).not.toHaveBeenCalled(); expect(f.log.error).not.toHaveBeenCalled();
  });

  it("stops an explicitly non-retryable failure for review with one ERROR", async () => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(refusal("SHOPIFY_INVENTORY_ITEM_NOT_FOUND", { retryable: false }));
    await f.service.processDue();
    expect(f.store.fail).toHaveBeenCalledExactlyOnceWith(claim, "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "permanent");
    expect(f.log.error).toHaveBeenCalledExactlyOnceWith("inventory.quantity_catchup.requires_review", expect.objectContaining({ error_class: "permanent" }));
  });

  it.each([[7, null], [8, "warn"], [9, null], [24, "error"], [25, null]] as const)
  ("escalates a transient streak at attempt %s -> %s", async (attempts, level) => {
    const f = fixture(); f.store.complete.mockResolvedValue(false);
    f.replan.mockRejectedValue(refusal("PROVIDER_TIMEOUT")); f.store.fail.mockResolvedValue(attempts);
    await f.service.processDue();
    expect(f.store.fail).toHaveBeenCalledWith(claim, "PROVIDER_TIMEOUT", "PROVIDER_TIMEOUT", "transient");
    expect(f.log.warn).toHaveBeenCalledTimes(level === "warn" ? 1 : 0);
    expect(f.log.error).toHaveBeenCalledTimes(level === "error" ? 1 : 0);
  });
});
