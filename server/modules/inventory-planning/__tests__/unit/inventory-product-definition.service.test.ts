import { describe, expect, it, vi } from "vitest";
import { ProductDefinitionService, type ProductDefinitionStore } from "../../application/inventory-product-definition.service";

const command = { productId: 17, draftModelId: 61, expectedHeadRevision: "4",
  expectedDefinitionHash: "a".repeat(64), expectedReviewHash: "b".repeat(64), idempotencyKey: "test-command" };
function fixture() {
  const store = { review: vi.fn<ProductDefinitionStore["review"]>(), apply: vi.fn<ProductDefinitionStore["apply"]>(), progress: vi.fn<ProductDefinitionStore["progress"]>() } satisfies ProductDefinitionStore;
  const now = new Date("2026-09-18T12:00:00.000Z");
  return { store, now, service: new ProductDefinitionService(store, { now: () => now }) };
}
describe("product definition command boundary", () => {
  it("binds deterministic retries to the authenticated actor and injected clock", () => {
    const { store, service, now } = fixture();
    service.apply(command, "operator");
    service.apply(command, "operator");
    expect(store.apply.mock.calls[0]).toEqual(store.apply.mock.calls[1]);
    expect(store.apply.mock.calls[0]).toEqual([command, "operator", expect.stringMatching(/^[a-f0-9]{64}$/), now]);
    service.apply(command, "different-operator");
    expect(store.apply.mock.calls[2][2]).not.toBe(store.apply.mock.calls[0][2]);
  });
  it("rejects forged actors, missing authentication and malformed selections before storage", () => {
    const { store, service } = fixture();
    expect(() => service.apply({ ...command, actor: "admin" }, "operator")).toThrow();
    expect(() => service.apply(command, undefined)).toThrow();
    expect(() => service.apply({ ...command, expectedReviewHash: "" }, "operator")).toThrow();
    expect(() => service.apply({ ...command, productId: -1 }, "operator")).toThrow();
    expect(store.apply).not.toHaveBeenCalled();
  });
  it("rejects invalid progress identifiers", () => {
    const { store, service } = fixture();
    for (const id of [0, -1, NaN, Infinity, 1.5, "17"]) expect(() => service.progress(id)).toThrow();
    expect(store.progress).not.toHaveBeenCalled();
  });
});
