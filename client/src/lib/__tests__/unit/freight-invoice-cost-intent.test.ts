import { describe, expect, it } from "vitest";
import { createFreightInvoiceIntentStore } from "../../../features/purchasing/freight-invoice-cost-intent";
import { freightInvoicePreviewSchema } from "@shared/procurement/freight-invoice-costs";

function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const preview = freightInvoicePreviewSchema.parse({ invoiceId: 71, invoiceNumber: "FREIGHT", sourceVersion: "a".repeat(64), previewVersion: "b".repeat(64),
    invoiceAmountCents: 0, paidAmountCents: 0, balanceCents: 0, invoiceStatus: { before: "received", after: "approved" },
    charges: [{ chargeId: 31, shipmentId: 42, label: "Waived charge", estimatedCents: 100, actualCents: null, invoiceCents: 0 }],
    shipmentStates: [{ shipmentId: 42, shipmentNumber: "SHIP", state: "applied" }], allocations: [],
    impact: { lots: [], orderCosts: [], historicalCosts: [] }, inventoryValues: [], issues: [] });
  const body = { request: { sourceVersion: preview.sourceVersion, previewVersion: preview.previewVersion, reason: "Checked supplier evidence", approvalConfirmed: true as const }, preview };
  const store = createFreightInvoiceIntentStore("admin", 71, () => storage);
  return { store, values, storage, body };
}
const key = "19790000-0000-4000-8000-000000000001";
describe("receipt-bound freight invoice approval recovery", () => {
  it("retains the exact request and preview across a reload and ignores a new proposed key", () => {
    const { store, storage, body } = setup(); const saved = store.acquire(body, () => key);
    const reopened = createFreightInvoiceIntentStore("admin", 71, () => storage);
    expect(reopened.acquire(body, () => "must-not-replace")).toEqual(saved);
    expect(reopened.read()?.key).toBe(key);
  });
  it("refuses a changed reason while the original approval remains unresolved", () => {
    const { store, body } = setup(); store.acquire(body, () => key);
    expect(() => store.acquire({ ...body, request: { ...body.request, reason: "Changed request reason" } }, () => key)).toThrow(/Resolve the saved approval/);
  });
  it.each(["sourceVersion", "previewVersion"] as const)("rejects a saved request with a different %s than its preview", field => {
    const { store, body } = setup();
    expect(() => store.acquire({ ...body, request: { ...body.request, [field]: "c".repeat(64) } }, () => key)).toThrow();
  });
  it("rejects another invoice's preview", () => {
    const { store, body } = setup(); expect(() => store.acquire({ ...body, preview: { ...body.preview, invoiceId: 72 } }, () => key)).toThrow(/another invoice/);
  });
  it("rejects tampered stored operator identity", () => {
    const { store, body, values } = setup(); const saved = store.acquire(body, () => key);
    values.set("freight-invoice-costs:admin:71", JSON.stringify({ ...saved, userId: "other-admin" }));
    expect(() => store.read()).toThrow(/cannot be verified/);
  });
  it("clears only the matching confirmed or durably rejected approval", () => {
    const { store, body } = setup(); store.acquire(body, () => key);
    store.complete("different-key"); expect(store.read()?.key).toBe(key);
    store.complete(key); expect(store.read()).toBeNull();
  });
  it("blocks dispatch when browser persistence fails", () => {
    const { body } = setup();
    const store = createFreightInvoiceIntentStore("admin", 71, () => ({ getItem: () => null, setItem: () => { throw new Error("unavailable"); }, removeItem: () => {} }));
    expect(() => store.acquire(body, () => key)).toThrow(/No request was sent/);
  });
});
