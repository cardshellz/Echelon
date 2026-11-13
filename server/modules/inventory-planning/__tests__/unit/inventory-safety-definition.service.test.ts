import { describe, expect, it, vi } from "vitest";
import { SafetyDefinitionService, type SafetyDefinitionStore } from "../../application/inventory-safety-definition.service";
import { safetyDefinitionSelectionSchema } from "@shared/types/inventory-safety-definition";
const command = { scopeKey: "business", draftPolicyId: 1, expectedHeadRevision: "0",
  expectedDefinitionHash: "a".repeat(64), expectedReviewHash: "b".repeat(64), idempotencyKey: "apply" };
describe("safety definition boundary", () => {
  it("accepts initial revision zero and binds retries to authenticated actor", () => {
    const store = { review: vi.fn<SafetyDefinitionStore["review"]>(), apply: vi.fn<SafetyDefinitionStore["apply"]>(), progress: vi.fn<SafetyDefinitionStore["progress"]>(),
      set: vi.fn<SafetyDefinitionStore["set"]>(), overview: vi.fn<SafetyDefinitionStore["overview"]>() };
    const now = new Date("2026-09-18T12:00:00.000Z");
    const service = new SafetyDefinitionService(store, { now: () => now });
    service.apply(command,"operator"); service.apply(command,"operator");
    expect(store.apply.mock.calls[0]).toEqual(store.apply.mock.calls[1]);
    service.apply(command,"other");
    expect(store.apply.mock.calls[2][2]).not.toBe(store.apply.mock.calls[0][2]);
    expect(store.apply.mock.calls[0][3]).toBe(now);
    expect(() => service.apply({ ...command, actor: "forged" },"operator")).toThrow();
    expect(() => service.apply(command,undefined)).toThrow();
    expect(() => service.progress("business' OR true")).toThrow();
    expect(store.apply).toHaveBeenCalledTimes(3);
  });
  it("validates a one-step set, binds its retry key to the actor and never returns an unverified result", async () => {
    const receipt = { scopeKey: "business", policyId: 4, appliedAt: "2026-09-18T12:00:00.000Z", appliedBy: "operator",
      reviewHash: "c".repeat(64), publicationIds: ["7"], alreadyApplied: false };
    const committed = { receipt, affectedProducts: 2, changedRows: 1, skippedDestinations: [],
      changes: [{ sku: "P5", warehouseName: "MAIN", current: "10", proposed: "7" }] };
    const store = { review: vi.fn<SafetyDefinitionStore["review"]>(), apply: vi.fn<SafetyDefinitionStore["apply"]>(), progress: vi.fn<SafetyDefinitionStore["progress"]>(),
      set: vi.fn<SafetyDefinitionStore["set"]>(async () => committed), overview: vi.fn<SafetyDefinitionStore["overview"]>() };
    const now = new Date("2026-09-18T12:00:00.000Z");
    const service = new SafetyDefinitionService(store, { now: () => now });
    const set = { scope: { scopeType: "business" as const }, value: { policyMode: "fixed_units" as const, fixedUnits: 3 },
      expectedHeadRevision: "1", idempotencyKey: " set-1 " };
    await expect(service.set(set, "operator")).resolves.toEqual(committed);
    // Trimmed key, a blank note stored as none, the injected clock, and a hash that covers the actor.
    expect(store.set.mock.calls[0][0]).toMatchObject({ idempotencyKey: "set-1", changeReason: null, expectedHeadRevision: "1" });
    expect(store.set.mock.calls[0][3]).toEqual(now);
    await service.set(set, "operator"); await service.set(set, "other");
    expect(store.set.mock.calls[1][2]).toBe(store.set.mock.calls[0][2]);
    expect(store.set.mock.calls[2][2]).not.toBe(store.set.mock.calls[0][2]);
    await service.set({ ...set, expectedHeadRevision: null, scope: { scopeType: "network_variant", productVariantId: 101 }, value: { policyMode: "inherit" } }, "operator");

    // Rejected before the store is reached.
    const calls = store.set.mock.calls.length;
    await expect(service.set({ ...set, value: { policyMode: "inherit" } }, "operator")).rejects.toThrow();
    await expect(service.set({ ...set, value: { policyMode: "fixed_units", fixedUnits: -1 } }, "operator")).rejects.toThrow();
    await expect(service.set({ ...set, value: { policyMode: "fixed_units", fixedUnits: 1.5 } }, "operator")).rejects.toThrow();
    await expect(service.set({ ...set, expectedHeadRevision: "-1" }, "operator")).rejects.toThrow();
    await expect(service.set({ ...set, idempotencyKey: "k".repeat(101) }, "operator")).rejects.toThrow();
    await expect(service.set({ ...set, actor: "forged" }, "operator")).rejects.toThrow();
    await expect(service.set(set, undefined)).rejects.toThrow();
    expect(store.set).toHaveBeenCalledTimes(calls);

    // A committed set whose answer cannot be verified is a server error (keep the retry key), never a 4xx.
    store.set.mockResolvedValueOnce({ ...committed, changedRows: -1 });
    await expect(service.set(set, "operator")).rejects.toMatchObject({ code: "DEFINITION_RESULT_INVALID", status: 500 });
  });
  it.each(["business", "network:variant:101", "warehouse:2:variant:101"])("validates exact scope %s", scopeKey => {
    expect(safetyDefinitionSelectionSchema.parse({ scopeKey, draftPolicyId: 1, expectedHeadRevision: "0", expectedDefinitionHash: "a".repeat(64) }).scopeKey).toBe(scopeKey);
  });
});
