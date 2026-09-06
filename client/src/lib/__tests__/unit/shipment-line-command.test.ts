import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentLineCommandClient, createShipmentLineRecoveryStore, shipmentLineEditorFromRecord, refreshShipmentLineDraftVersion, updateShipmentLinePayload } from "../../shipment-line-command";
import { autoMapPackingList, mapPackingListRows, updatePackingListCell } from "../../shipment-packing-list";
const version = "a".repeat(64);
const nextVersion = "b".repeat(64);
const record = { id: 7, inboundShipmentId: 42, version, sku: "PARTIAL-CASE", qtyShipped: 501, cartonCount: 11,
  weightKg: "2.000", lengthCm: "10.00", widthCm: "20.00", heightCm: "30.00", notes: null, unitsPerVariant: 50 };
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const recovery = createShipmentLineRecoveryStore(() => storage, "operator-a");
  let sequence = 0;
  return { values, storage, recovery, client: createShipmentLineCommandClient(() => `line-key-${++sequence}`, recovery) };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
describe("shipment line piece authority", () => {
  it("preserves 501 pieces and 11 cartons during a dimension-only correction", () => {
    const editor = shipmentLineEditorFromRecord(record, 42);
    editor.form.lengthCm = "12.50";
    expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: version, lengthCm: "12.50" });
    expect(editor.form.qtyShipped).toBe("501");
    expect(editor.form.cartonCount).toBe("11");
    expect(record.lengthCm).toBe("10.00");
  });
  it("changes pieces and cartons independently and can clear dimensions", () => {
    const editor = shipmentLineEditorFromRecord(record, 42);
    editor.form.qtyShipped = "499"; editor.form.cartonCount = ""; editor.form.weightKg = "";
    expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: version, qtyShipped: 499, cartonCount: null, weightKg: null });
  });
  it.each(["0", "-1", "1.5", "1e3", "2147483648", ""]) ("rejects invalid pieces %s instead of falling back", (qty) => {
    const editor = shipmentLineEditorFromRecord(record, 42); editor.form.qtyShipped = qty;
    expect(() => updateShipmentLinePayload(editor)).toThrow();
  });
  it("rejects too much decimal precision, missing version and cross-shipment records", () => {
    const editor = shipmentLineEditorFromRecord(record, 42); editor.form.weightKg = "1.2345";
    expect(() => updateShipmentLinePayload(editor)).toThrow(/weightKg/);
    expect(() => shipmentLineEditorFromRecord({ ...record, version: undefined }, 42)).toThrow(/incomplete/);
    expect(() => shipmentLineEditorFromRecord(record, 99)).toThrow(/another shipment/);
  });
});
describe("packing list adapter", () => {
  it("maps snake-case CSV headings into typed camelCase without rounding or unsupported fields", () => {
    const headers = ["SKU", "qty_shipped", "carton_count", "weight_kg", "length_cm", "gross_volume_cbm", "pallet_count"];
    const mapping = autoMapPackingList(headers);
    expect(mapPackingListRows([{ SKU: "CASE-A", qty_shipped: "501", carton_count: "11", weight_kg: "2.125", length_cm: "12.50", gross_volume_cbm: "99", pallet_count: "3" }], mapping))
      .toEqual([{ sku: "CASE-A", qtyShipped: 501, cartonCount: 11, weightKg: "2.125", lengthCm: "12.50" }]);
  });
  it("retains malformed values for explicit per-row rejection; rejects oversized batches", () => {
    expect(mapPackingListRows([{ sku: "bad", qty: "2.5" }], { sku: "sku", qtyShipped: "qty" })).toEqual([{ sku: "bad", qtyShipped: "2.5" }]);
    expect(() => mapPackingListRows(Array.from({ length: 501 }, () => ({ sku: "A" })), {})).toThrow(/500/);
  });
});
describe("shipment line durable commands", () => {
  it("retains an exact import after a lost response and recovers the same key after reload", async () => {
    const { client, recovery, storage } = setup();
    const command = { operation: "import" as const, body: { rows: [{ sku: "A", qtyShipped: 501 }] } };
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("connection lost")); vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(42, command)).rejects.toMatchObject({ ambiguous: true });
    const saved = recovery.read(42)!;
    expect(saved.key).toBe("line-key-1");
    await expect(client.execute(42, { operation: "import", body: { rows: [{ sku: "B", qtyShipped: 1 }] } })).rejects.toThrow(/unresolved/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const reloaded = createShipmentLineCommandClient(() => "different-key", createShipmentLineRecoveryStore(() => storage, "operator-a"));
    fetcher.mockResolvedValueOnce(reply({ imported: 1, errors: [], lines: [record] }));
    await expect(reloaded.execute(42, saved.command)).resolves.toMatchObject({ operation: "import", result: { imported: 1 } });
    const first = fetcher.mock.calls[0][1]; const second = fetcher.mock.calls[1][1];
    expect(second.body).toBe(first.body); expect(second.headers["Idempotency-Key"]).toBe(first.headers["Idempotency-Key"]);
    expect(recovery.read(42)).toBeNull();
  });
  it("persists PATCH and DELETE intents too so navigation cannot strand a stale version", async () => {
    const { client, recovery } = setup();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("lost")));
    await expect(client.execute(42, { operation: "update", lineId: 7, body: { expectedVersion: version, notes: "original" } })).rejects.toThrow();
    expect(recovery.read(42)?.command).toEqual({ operation: "update", lineId: 7, body: { expectedVersion: version, notes: "original" } });
    await expect(client.execute(42, { operation: "delete", lineId: 7, body: { expectedVersion: version } })).rejects.toThrow(/unresolved/);
  });
  it("retains the entire batch on definitive capacity conflict and rotates after review", async () => {
    const { client, recovery } = setup();
    const fetcher = vi.fn().mockResolvedValueOnce(reply({ code: "SHIPMENT_LINE_SOURCE_CAPACITY_CHANGED", error: "Review remaining quantities" }, 409))
      .mockResolvedValueOnce(reply({ imported: 1, errors: [], lines: [record] })); vi.stubGlobal("fetch", fetcher);
    const command = { operation: "import" as const, body: { rows: [{ sku: "A", qtyShipped: 501 }] } };
    await expect(client.execute(42, command)).rejects.toMatchObject({ status: 409, ambiguous: false });
    expect(recovery.read(42)).toBeNull();
    await client.execute(42, command);
    expect(fetcher.mock.calls.map((call) => call[1].headers["Idempotency-Key"])).toEqual(["line-key-1", "line-key-2"]);
  });
  it("validates partial row accounting and returns each rejected row without hiding it", async () => {
    const { client } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ imported: 1, errors: [{ row: 2, error: "Quantity invalid", code: "INVALID_ROW" }], lines: [record] })));
    const result = await client.execute(42, { operation: "import", body: { rows: [{ sku: "A", qtyShipped: 501 }, { sku: "B", qtyShipped: 0 }] } });
    expect(result).toMatchObject({ operation: "import", result: { imported: 1, errors: [{ row: 2, error: "Quantity invalid" }] } });
  });
  it.each([
    { imported: 1, errors: [], lines: [] },
    { imported: 0, errors: [{ row: 2, error: "outside batch" }], lines: [] },
    { imported: 1, errors: [], lines: [{ ...record, inboundShipmentId: 99 }] },
    { imported: 1, errors: [], lines: [{ ...record, version: undefined }] },
  ])("treats unverifiable success as unresolved", async (response) => {
    const { client, recovery } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(42, { operation: "import", body: { rows: [{ sku: "A", qtyShipped: 1 }] } })).rejects.toMatchObject({ ambiguous: true });
    expect(recovery.read(42)).not.toBeNull();
  });
  it("sends an explicit empty resolve body and validates the updated count", async () => {
    const { client } = setup(); const fetcher = vi.fn().mockResolvedValue(reply({ updated: 2, total: 3 })); vi.stubGlobal("fetch", fetcher);
    expect(await client.execute(42, { operation: "resolve-dimensions", body: {} })).toEqual({ operation: "resolve-dimensions", updated: 2, total: 3 });
    expect(fetcher.mock.calls[0][1].body).toBe("{}");
  });
  it("rotates a PATCH key only after definitive conflict and explicit new version", async () => {
    const { client } = setup(); const fetcher = vi.fn().mockResolvedValueOnce(reply({ error: "Line changed" }, 409)).mockResolvedValueOnce(reply({ ...record, version: nextVersion })); vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(42, { operation: "update", lineId: 7, body: { expectedVersion: version, notes: "review" } })).rejects.toMatchObject({ ambiguous: false });
    await client.execute(42, { operation: "update", lineId: 7, body: { expectedVersion: nextVersion, notes: "reviewed" } });
    expect(fetcher.mock.calls.map((call) => call[1].headers["Idempotency-Key"])).toEqual(["line-key-1", "line-key-2"]);
  });
  it("fails closed when storage fails and isolates users and shipments", async () => {
    const { storage, recovery, client } = setup(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.spyOn(storage, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await expect(client.execute(42, { operation: "resolve-dimensions", body: {} })).rejects.toThrow(/not sent/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(recovery.read(43)).toBeNull(); expect(createShipmentLineRecoveryStore(() => storage, "operator-b").read(42)).toBeNull();
  });
});

describe("reviewed recovery and sibling-allocation edge cases", () => {
  it("pins the original key when a delayed success cleared storage behind a stale recovery card", async () => {
    const { client, recovery } = setup();
    const command = { operation: "import" as const, body: { rows: [{ sku: "A", qtyShipped: 1 }] } };
    const staleCard = recovery.acquire(42, command, () => "original-key");
    recovery.complete(42, staleCard.key);
    const fetcher = vi.fn().mockResolvedValue(reply({ imported: 1, errors: [], lines: [record] }));
    vi.stubGlobal("fetch", fetcher);
    await client.execute(42, staleCard.command, staleCard);
    expect(fetcher.mock.calls[0][1].headers["Idempotency-Key"]).toBe("original-key");
    expect(recovery.read(42)).toBeNull();
  });
  it("rejects a recovery record from a different authenticated user", async () => {
    const { client, recovery } = setup();
    const saved = recovery.acquire(42, { operation: "resolve-dimensions", body: {} }, () => "original-key");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(42, saved.command, { ...saved, userId: "other-user" })).rejects.toThrow(/does not match/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("adopts a sibling allocation version without replacing the operator's dimension draft", () => {
    const editor = shipmentLineEditorFromRecord(record, 42); editor.form.lengthCm = "19.50";
    const latest = shipmentLineEditorFromRecord({ ...record, version: nextVersion, allocatedCostCents: 500 }, 42);
    const revised = refreshShipmentLineDraftVersion(editor, latest);
    expect(revised.version).toBe(nextVersion); expect(revised.form.lengthCm).toBe("19.50");
    expect(editor.version).toBe(version);
  });
  it.each([{ qtyShipped: 500 }, { notes: "another operator" }, { productVariantId: 91 }, { lengthCm: "10.50" }])("stops rather than rebasing changed source/physical values %j", (changed) => {
    const editor = shipmentLineEditorFromRecord(record, 42); editor.form.widthCm = "25.00";
    const latest = shipmentLineEditorFromRecord({ ...record, ...changed, version: nextVersion }, 42);
    expect(() => refreshShipmentLineDraftVersion(editor, latest)).toThrow(/changed/);
    expect(editor.form.widthCm).toBe("25.00");
  });
  it("can remove invalid optional import values without mutating or losing the rejected row", () => {
    const row = { sku: "REJECTED", qtyShipped: 5, weightKg: "bad", productVariantId: "bad" };
    const corrected = updatePackingListCell(updatePackingListCell(row, "weightKg", ""), "productVariantId", "");
    expect(corrected).toEqual({ sku: "REJECTED", qtyShipped: 5 });
    expect(row.weightKg).toBe("bad");
  });
});

describe("legacy physical evidence", () => {
  it.each([{ qtyShipped: 0, cartonCount: 0 }, { qtyShipped: -1, cartonCount: -2, weightKg: "-1.000" }])("preserves invalid recorded values during notes-only corrections %j", (legacy) => {
    const editor = shipmentLineEditorFromRecord({ ...record, ...legacy }, 42);
    expect(editor.physicalReviewRequired).toBe(true);
    editor.form.notes = "Documenting historical evidence";
    expect(updateShipmentLinePayload(editor)).toEqual({ expectedVersion: version, notes: "Documenting historical evidence" });
    editor.form.qtyShipped = "-3";
    expect(() => updateShipmentLinePayload(editor)).toThrow(/qtyShipped/);
  });
});

it("accepts and replays confirmed notes-only responses that preserve legacy physical evidence", async () => {
  const { client, recovery } = setup();
  const command = { operation: "update" as const, lineId: 7, body: { expectedVersion: version, notes: "Historical evidence" } };
  const saved = recovery.acquire(42, command, () => "legacy-notes-key");
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(reply({ ...record, qtyShipped: -1, cartonCount: 0, version: nextVersion, notes: "Historical evidence" })));
  vi.stubGlobal("fetch", fetcher);
  await expect(client.execute(42, command, saved)).resolves.toMatchObject({ operation: "update", line: { qtyShipped: -1, cartonCount: 0 } });
  await expect(client.execute(42, command, saved)).resolves.toMatchObject({ operation: "update" });
  expect(fetcher.mock.calls.map((call) => call[1].headers["Idempotency-Key"])).toEqual(["legacy-notes-key", "legacy-notes-key"]);
});
