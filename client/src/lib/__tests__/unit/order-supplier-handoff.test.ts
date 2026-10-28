import { describe, expect, it } from "vitest";
import { captureOrderSupplierHandoff, createOrderSupplierHandoffStore, orderSupplierSetupHref,
  restoreOrderSupplierHandoff, type SupplierHandoffItem } from "../../order-supplier-handoff";
import { parseSupplierSetupDeepLink } from "../../../features/supplier-catalog/supplierSetupDeepLink";

const missing: SupplierHandoffItem = { recommendationId: "10:100:30", productId: 10, productVariantId: 100,
  preferredVendorId: null, supplierBasis: { vendorProductId: null } };
const assigned: SupplierHandoffItem = { recommendationId: "11:101:30", productId: 11, productVariantId: 101,
  preferredVendorId: 7, supplierBasis: { vendorProductId: 71 } };
const selected = new Map([[missing.recommendationId, { pieces: 210, exceedReason: "Keep this reviewed quantity" }],
  [assigned.recommendationId, { pieces: 0, exceedReason: "Skip this line" }]]);
const capture = () => captureOrderSupplierHandoff(missing.recommendationId, [missing, assigned], selected, {}, { "7": "rfq" }, "Original order reason");
function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}

describe("order supplier handoff", () => {
  it("retains all exact selected identities, zero quantities, reasons and modes without pricing or approvals", () => {
    const body = capture();
    expect(body).toEqual({ targetRecommendationId: missing.recommendationId, lines: [
      { recommendationId: missing.recommendationId, productId: 10, productVariantId: 100, vendorProductId: null, pieces: 210, exceedReason: "Keep this reviewed quantity" },
      { recommendationId: assigned.recommendationId, productId: 11, productVariantId: 101, vendorProductId: 71, pieces: 0, exceedReason: "Skip this line" },
    ], vendorModes: { "7": "rfq" }, decisionNote: "Original order reason" });
    expect(body).not.toHaveProperty("prices"); expect(body).not.toHaveProperty("ackedControls");
    body.lines[0].pieces = 999;
    expect(selected.get(missing.recommendationId)?.pieces).toBe(210);
  });
  it("reuses the exact existing supplier setup parser with an allowlisted return path", () => {
    const url = new URL(orderSupplierSetupHref(capture()), "http://localhost");
    expect(url.pathname).toBe("/suppliers");
    expect(parseSupplierSetupDeepLink(url.search)).toEqual({ productId: 10, productVariantId: 100, vendorId: null,
      vendorProductId: null, recommendationId: missing.recommendationId, action: "assign_vendor", returnTo: "/reorder-analysis" });
  });
  it("preserves an explicitly absent receive variant instead of inventing one", () => {
    const base = { ...missing, productVariantId: undefined };
    const body = captureOrderSupplierHandoff(base.recommendationId, [base], new Map([[base.recommendationId, { pieces: 1, exceedReason: "" }]]), {}, {}, "");
    expect(new URL(orderSupplierSetupHref(body), "http://localhost").searchParams.has("setupVariantId")).toBe(false);
    expect(restoreOrderSupplierHandoff(body, [base]).selection.get(base.recommendationId)?.pieces).toBe(1);
  });
  it("restores quantities using the newly selected current supplier while keeping the other supplier", () => {
    const restored = restoreOrderSupplierHandoff(capture(), [{ ...missing, preferredVendorId: 8, supplierBasis: { vendorProductId: 81 } }, assigned]);
    expect(restored.selection).toEqual(selected); expect(restored.vendorModes).toEqual({ "7": "rfq" });
    expect(restored.decisionNote).toBe("Original order reason"); expect(restored.supplierOverrides).toEqual({});
  });
  it("restores an explicitly chosen eligible alternate mapping instead of changing supplier silently", () => {
    const body = captureOrderSupplierHandoff(missing.recommendationId, [missing, assigned], selected, { [assigned.recommendationId]: 72 }, {}, "");
    expect(restoreOrderSupplierHandoff(body, [missing, { ...assigned, supplierBasis: { vendorProductId: 71,
      sourcingSelection: { options: [{ vendorProductId: 72, eligible: true }] } } }]).supplierOverrides).toEqual({ [assigned.recommendationId]: 72 });
  });
  it.each([
    { label: "missing recommendation", current: [assigned] },
    { label: "excluded recommendation", current: [{ ...missing, skippedReason: "excluded" }, assigned] },
    { label: "changed product", current: [{ ...missing, productId: 12 }, assigned] },
    { label: "changed receive unit", current: [{ ...missing, productVariantId: 102 }, assigned] },
    { label: "disappearing receive unit", current: [{ ...missing, productVariantId: undefined }, assigned] },
    { label: "changed prior supplier", current: [missing, { ...assigned, supplierBasis: { vendorProductId: 73 } }] },
  ])("retains recovery when $label prevents a complete restoration", ({ current }) => {
    const storage = memory(), store = createOrderSupplierHandoffStore(() => storage, "operator");
    const saved = store.acquire(capture(), () => "original-key");
    expect(() => restoreOrderSupplierHandoff(saved.body, current)).toThrow(/saved/);
    expect(store.read()).toEqual(saved);
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid saved quantity %s", pieces => {
    expect(() => captureOrderSupplierHandoff(missing.recommendationId, [missing], new Map([[missing.recommendationId, { pieces, exceedReason: "" }]]), {}, {}, "")).toThrow();
  });
  it("does not open setup for an unselected or already assigned target", () => {
    expect(() => captureOrderSupplierHandoff(missing.recommendationId, [missing], new Map(), {}, {}, "")).toThrow(/Select/);
    expect(() => captureOrderSupplierHandoff(assigned.recommendationId, [assigned], selected, {}, {}, "")).toThrow(/Select/);
  });
  it("rejects incomplete selections, duplicate saved identities and extra authority fields", () => {
    expect(() => captureOrderSupplierHandoff(missing.recommendationId, [missing], selected, {}, {}, "")).toThrow(/selected recommendation/);
    const body = capture();
    expect(() => orderSupplierSetupHref({ ...body, lines: [body.lines[0], body.lines[0]] })).toThrow();
    expect(() => orderSupplierSetupHref({ ...body, approved: true } as never)).toThrow();
  });
  it("allows exactly the bounded 500 selected lines and refuses overflow without truncating", () => {
    const items = Array.from({ length: 501 }, (_, index) => ({ ...missing, recommendationId: String(index), productId: index + 1 }));
    const selection = new Map(items.map(item => [item.recommendationId, { pieces: 1, exceedReason: "" }]));
    expect(() => captureOrderSupplierHandoff("0", items, selection, {}, {}, "")).toThrow();
    selection.delete("500");
    expect(captureOrderSupplierHandoff("0", items, selection, {}, {}, "").lines).toHaveLength(500);
  });
  it("saves before handoff, survives reload, reuses the same key and refuses replacement", () => {
    const storage = memory(), original = createOrderSupplierHandoffStore(() => storage, "operator");
    const saved = original.acquire(capture(), () => "original-key");
    const reloaded = createOrderSupplierHandoffStore(() => storage, "operator");
    expect(reloaded.read()).toEqual(saved);
    expect(reloaded.acquire(capture(), () => { throw new Error("No new key"); })).toEqual(saved);
    expect(() => reloaded.acquire({ ...capture(), decisionNote: "Different order" }, () => "new-key-1")).toThrow(/earlier order/);
    reloaded.complete("another-key"); expect(reloaded.read()).toEqual(saved);
    reloaded.complete(saved.key); expect(reloaded.read()).toBeNull();
  });
  it("isolates operators and rejects a forged owner in persisted evidence", () => {
    const storage = memory(), store = createOrderSupplierHandoffStore(() => storage, "operator");
    const saved = store.acquire(capture(), () => "original-key");
    expect(createOrderSupplierHandoffStore(() => storage, "different-operator").read()).toBeNull();
    const key = [...storage.values.keys()][0]; storage.setItem(key, JSON.stringify({ ...saved, userId: "other" }));
    expect(() => store.read()).toThrow(/verified/); store.discard(); expect(store.read()).toBeNull();
  });
  it("reports read, save, clear and discard failures without clearing an unresolved draft", () => {
    const storage = memory();
    const failedRead = createOrderSupplierHandoffStore(() => ({ ...storage, getItem: () => { throw new Error("Denied"); } }), "operator");
    expect(() => failedRead.read()).toThrow(/cannot be read/);
    const failedSave = createOrderSupplierHandoffStore(() => ({ ...storage, setItem: () => { throw new Error("Quota"); } }), "operator");
    expect(() => failedSave.acquire(capture(), () => "original-key")).toThrow(/not opened/);
    const store = createOrderSupplierHandoffStore(() => storage, "operator"); const saved = store.acquire(capture(), () => "original-key");
    const failedClear = createOrderSupplierHandoffStore(() => ({ ...storage, removeItem: () => { throw new Error("Denied"); } }), "operator");
    expect(() => failedClear.complete(saved.key)).toThrow(/cleared/); expect(store.read()).toEqual(saved);
    expect(() => failedClear.discard()).toThrow(/discarded/); expect(store.read()).toEqual(saved);
  });
});
