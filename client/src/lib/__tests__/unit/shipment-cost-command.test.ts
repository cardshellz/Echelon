import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createShipmentCostCommandClient,
  createShipmentCostPayload,
  effectiveShipmentCostCents,
  deleteShipmentCostPayload,
  isInvoiceOwnedShipmentCost,
  shipmentCostEditorFromRecord,
  shipmentCostNeedsRefresh,
  updateShipmentCostPayload,
  type ShipmentCostForm,
} from "../../shipment-cost-command";

const version = "a".repeat(64);
const nextVersion = "b".repeat(64);
const record = {
  id: 31, inboundShipmentId: 12, version, costType: "freight", description: "Sea freight",
  estimatedCents: 5000, actualCents: 4800, allocationMethod: "by_volume", vendorId: 7,
  vendorName: "Carrier", performedByName: "Forwarder", invoiceDate: "2026-09-06T12:30:00Z",
  vendorInvoiceId: null, hasInvoiceSourceReference: false, currency: "USD", exchangeRate: "1.0000",
};
const form: ShipmentCostForm = {
  costType: "freight", description: "Sea freight", amount: "50.00", allocationMethod: "default",
  vendorId: 7, vendorName: "Carrier", performedByName: "Forwarder", costDate: "2026-09-06",
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const saved = { id: 31, inboundShipmentId: 12, version: nextVersion };

afterEach(() => vi.unstubAllGlobals());

describe("shipment cost edit payloads", () => {
  it("only sends allowed create fields, converts default allocation and excludes server-owned fields", () => {
    const payload = createShipmentCostPayload({ ...form, inboundShipmentId: 999, vendorInvoiceId: 88, updatedAt: "forged", costStatus: "paid" } as ShipmentCostForm);
    expect(payload).toEqual({
      costType: "freight", description: "Sea freight", estimatedCents: 5000, actualCents: 5000,
      allocationMethod: null, vendorId: 7, performedByName: "Forwarder",
      invoiceDate: new Date("2026-09-06T00:00:00").toISOString(),
      reason: "Added shipment charge from shipment detail",
    });
  });

  it.each([["0", 0], ["-0.55", -55], ["-55.00", -5500], [".05", 5], ["90071992547409.91", Number.MAX_SAFE_INTEGER]])("parses signed exact cents from %s", (amount, cents) => {
    expect(createShipmentCostPayload({ ...form, amount }).actualCents).toBe(cents);
  });

  it.each(["", "1e3", "12.345", "NaN", "90071992547409.92", "--1"]) ("rejects invalid amount %s before dispatch", (amount) => {
    expect(() => createShipmentCostPayload({ ...form, amount })).toThrow();
  });

  it("rejects impossible dates and malformed versions", () => {
    expect(() => createShipmentCostPayload({ ...form, costDate: "2026-02-30" })).toThrow("valid cost date");
    expect(() => shipmentCostEditorFromRecord({ ...record, version: "old" })).toThrow("Refresh");
    expect(() => shipmentCostEditorFromRecord(record, 99)).toThrow("different shipment");
  });

  it("preserves separate estimate/actual, exact source timestamp and historical category during metadata edits", () => {
    const editor = shipmentCostEditorFromRecord({ ...record, costType: "legacy_credit" });
    const payload = updateShipmentCostPayload({ ...editor, description: "Corrected description" });
    expect(payload).toEqual({
      description: "Corrected description", performedByName: "Forwarder", expectedVersion: version,
      reason: "Updated shipment cost from shipment detail",
    });
    expect(record.actualCents).toBe(4800);
  });

  it("sends only changed economic fields and retains the captured version", () => {
    const editor = shipmentCostEditorFromRecord(record);
    const payload = updateShipmentCostPayload({ ...editor, amount: "-0.55", vendorId: 8 });
    expect(payload).toMatchObject({ actualCents: -55, estimatedCents: -55, vendorId: 8, expectedVersion: version });
    expect(payload).not.toHaveProperty("costType");
    expect(payload).not.toHaveProperty("invoiceDate");
    expect(editor.version).toBe(version);
  });

  it.each([
    { vendorInvoiceId: 71 }, { hasInvoiceSourceReference: true }, { currency: "CAD" }, { currency: null }, { exchangeRate: null }, { exchangeRate: "2" },
  ])("restricts protected cost %j to metadata and prevents deletion", (patch) => {
    const cost = { ...record, ...patch };
    const editor = shipmentCostEditorFromRecord(cost);
    expect(editor.economicFieldsLocked).toBe(true);
    const payload = updateShipmentCostPayload({ ...editor, amount: "not a charge", costDate: "invalid", vendorId: 99, costType: "other", allocationMethod: "by_weight" });
    expect(Object.keys(payload).sort()).toEqual(["description", "expectedVersion", "performedByName", "reason"]);
    expect(() => deleteShipmentCostPayload(cost)).toThrow("cannot be removed");
  });

  it("treats source references as protected even when the header invoice link is empty", () => {
    expect(isInvoiceOwnedShipmentCost({ vendorInvoiceId: null, hasInvoiceSourceReference: true })).toBe(true);
    expect(isInvoiceOwnedShipmentCost({ vendorInvoiceId: null, hasInvoiceSourceReference: false })).toBe(false);
  });

  it.each([
    [0, 1000, "10.00"],
    [1000, 0, "0.00"],
    [1000, -55, "-0.55"],
    [-55, null, "-0.55"],
  ])("uses actual-first recorded amounts consistently (%s estimate, %s actual)", (estimatedCents, actualCents, amount) => {
    const cost = { ...record, estimatedCents, actualCents };
    expect(effectiveShipmentCostCents(cost)).toBe(actualCents ?? estimatedCents);
    expect(shipmentCostEditorFromRecord(cost).amount).toBe(amount);
    expect(updateShipmentCostPayload(shipmentCostEditorFromRecord(cost))).not.toHaveProperty("actualCents");
    expect(updateShipmentCostPayload(shipmentCostEditorFromRecord(cost))).not.toHaveProperty("estimatedCents");
  });
});

describe("shipment cost retained commands", () => {
  const client = () => {
    let sequence = 0;
    return createShipmentCostCommandClient(() => `cost-intent-${++sequence}`);
  };
  const keyAt = (fetch: ReturnType<typeof vi.fn>, index: number) => (fetch.mock.calls[index][1].headers as Record<string, string>)["Idempotency-Key"];

  it("reuses the same key after a transport failure and rotates after a verified success", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Connection lost"))
      .mockImplementation(() => Promise.resolve(response(saved)));
    vi.stubGlobal("fetch", fetch);
    const commands = client();
    const command = { method: "POST" as const, shipmentId: 12, body: createShipmentCostPayload(form) };
    await expect(commands.execute(command)).rejects.toMatchObject({ ambiguous: true });
    await commands.execute(command);
    await commands.execute(command);
    expect(keyAt(fetch, 0)).toBe(keyAt(fetch, 1));
    expect(keyAt(fetch, 2)).not.toBe(keyAt(fetch, 1));
  });

  it("retains an uncertain cost intent while another record is edited and rotates changed payloads", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Connection lost"));
    vi.stubGlobal("fetch", fetch);
    const commands = client();
    const body = updateShipmentCostPayload(shipmentCostEditorFromRecord(record));
    const command = { method: "PATCH" as const, shipmentId: 12, costId: 31, body };
    await commands.execute(command).catch(() => undefined);
    await commands.execute({ ...command, costId: 32 }).catch(() => undefined);
    await commands.execute(command).catch(() => undefined);
    await commands.execute({ ...command, body: { ...body, description: "New intent" } }).catch(() => undefined);
    expect(keyAt(fetch, 0)).toBe(keyAt(fetch, 2));
    expect(keyAt(fetch, 1)).not.toBe(keyAt(fetch, 0));
    expect(keyAt(fetch, 3)).not.toBe(keyAt(fetch, 0));
  });

  it("classifies a definitive conflict for refresh and dispatches the next version with a new key", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "Cost changed", details: { code: "SHIPMENT_COST_VERSION_CONFLICT" } }, 409))
      .mockResolvedValueOnce(response(saved));
    vi.stubGlobal("fetch", fetch);
    const commands = client();
    const command = { method: "PATCH" as const, shipmentId: 12, costId: 31, body: updateShipmentCostPayload(shipmentCostEditorFromRecord(record)) };
    const error = await commands.execute(command).catch((caught) => caught);
    expect(shipmentCostNeedsRefresh(error)).toBe(true);
    const reloaded = shipmentCostEditorFromRecord({ ...record, version: nextVersion });
    await commands.execute({ ...command, body: updateShipmentCostPayload(reloaded) });
    expect(keyAt(fetch, 0)).not.toBe(keyAt(fetch, 1));
    expect(JSON.parse(fetch.mock.calls[1][1].body).expectedVersion).toBe(nextVersion);
  });

  it.each([{ ...saved, id: 99 }, { ...saved, inboundShipmentId: 99 }, { id: 31 }, null])("retains the key for an unverifiable successful response %j", async (body) => {
    const fetch = vi.fn().mockResolvedValueOnce(response(body)).mockResolvedValueOnce(response(saved));
    vi.stubGlobal("fetch", fetch);
    const commands = client();
    const command = { method: "PATCH" as const, shipmentId: 12, costId: 31, body: updateShipmentCostPayload(shipmentCostEditorFromRecord(record)) };
    await expect(commands.execute(command)).rejects.toMatchObject({ ambiguous: true });
    await commands.execute(command);
    expect(keyAt(fetch, 0)).toBe(keyAt(fetch, 1));
  });

  it("sends a versioned DELETE JSON command and checks its confirmation", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await client().execute({ method: "DELETE", shipmentId: 12, costId: 31, body: deleteShipmentCostPayload(record) });
    expect(fetch.mock.calls[0][0]).toBe("/api/inbound-shipments/costs/31");
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "DELETE", credentials: "include" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ expectedVersion: version, reason: "Removed shipment charge from shipment detail" });
  });
});
