import { describe, expect, it, vi } from "vitest";
import { SafetyDefinitionService, type SafetyDefinitionStore } from "../../application/inventory-safety-definition.service";
import { safetyDefinitionSelectionSchema } from "@shared/types/inventory-safety-definition";
const command = { scopeKey: "business", draftPolicyId: 1, expectedHeadRevision: "0",
  expectedDefinitionHash: "a".repeat(64), expectedReviewHash: "b".repeat(64), idempotencyKey: "apply" };
describe("safety definition boundary", () => {
  it("accepts initial revision zero and binds retries to authenticated actor", () => {
    const store = { review: vi.fn<SafetyDefinitionStore["review"]>(), apply: vi.fn<SafetyDefinitionStore["apply"]>(), progress: vi.fn<SafetyDefinitionStore["progress"]>() };
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
  it.each(["business", "network:variant:101", "warehouse:2:variant:101"])("validates exact scope %s", scopeKey => {
    expect(safetyDefinitionSelectionSchema.parse({ scopeKey, draftPolicyId: 1, expectedHeadRevision: "0", expectedDefinitionHash: "a".repeat(64) }).scopeKey).toBe(scopeKey);
  });
});
