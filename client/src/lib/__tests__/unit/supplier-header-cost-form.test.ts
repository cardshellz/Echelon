import { describe, expect, it } from "vitest";
import { supplierHeaderEntryForm, supplierHeaderEntriesFromForm } from "../../supplier-header-cost-form";
import { createSupplierHeaderIntentStore } from "../../../features/purchasing/supplier-header-cost-intent";
import { supplierHeaderPreviewSchema, type SupplierHeaderEntry } from "@shared/procurement/supplier-header-costs";

const entry: SupplierHeaderEntry = { key: "discount", label: "Discount", category: "discount", amountMills: -10100,
  destination: "product", taxTypeId: null, method: "manual", shares: [{ lineId: 72, amountMills: -10100 }] };
const target = { kind: "invoice", id: 71 } as const;
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const preview = supplierHeaderPreviewSchema.parse({ target, sourceVersion: "a".repeat(64), previewVersion: "b".repeat(64),
    before: [], after: [], impact: { lots: [], orderCosts: [], historicalCosts: [], applications: [] }, inventoryValues: [], issues: [] });
  const body = { request: { target, sourceVersion: preview.sourceVersion, previewVersion: preview.previewVersion,
    entries: [entry], reason: "Checked supplier document", approvalConfirmed: true as const }, preview };
  return { values, storage, body, store: createSupplierHeaderIntentStore("admin", target, () => storage) };
}
const key = "20000000-0000-4000-8000-000000000001";
describe("exact header inputs and durable approvals", () => {
  it("roundtrips signed cent amounts without floating point or changing the caller", () => {
    const before = structuredClone(entry), form = supplierHeaderEntryForm(entry);
    expect(form.amount).toBe("-1.01"); expect(supplierHeaderEntriesFromForm([form])).toEqual([entry]); expect(entry).toEqual(before);
  });
  it.each(["0.001", "NaN", "Infinity", "9007199254740992"])("rejects invalid or inexact input %s", amount => {
    expect(() => supplierHeaderEntriesFromForm([{ ...supplierHeaderEntryForm(entry), amount }])).toThrow();
  });
  it("recovers the original exact request after reload and rejects another change until confirmed", () => {
    const { store, storage, body } = setup(), saved = store.acquire(body, () => key);
    const reopened = createSupplierHeaderIntentStore("admin", target, () => storage);
    expect(reopened.acquire(body, () => "must-not-replace")).toEqual(saved);
    expect(() => reopened.acquire({ ...body, request: { ...body.request, reason: "A different reason" } }, () => key)).toThrow();
    reopened.complete("wrong-key"); expect(reopened.read()).toEqual(saved); reopened.complete(key); expect(reopened.read()).toBeNull();
  });
  it.each(["sourceVersion", "previewVersion"] as const)("rejects a mismatched reviewed %s", field => {
    const { store, body } = setup(); expect(() => store.acquire({ ...body, request: { ...body.request, [field]: "c".repeat(64) } }, () => key)).toThrow();
  });
  it("rejects a different document and fails closed when browser storage is unavailable", () => {
    const { store, body } = setup(); expect(() => store.acquire({ ...body, preview: { ...body.preview, target: { kind: "invoice", id: 72 } } }, () => key)).toThrow();
    const blocked = createSupplierHeaderIntentStore("admin", target, () => ({ getItem: () => null, setItem: () => { throw new Error("unavailable"); }, removeItem: () => {} }));
    expect(() => blocked.acquire(body, () => key)).toThrow(/No approval was sent/);
  });
});
