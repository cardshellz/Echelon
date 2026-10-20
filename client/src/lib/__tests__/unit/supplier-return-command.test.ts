import { receiptReversalSourceCapability } from "../../receipt-reversal-capability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupplierReturnClient, createSupplierReturnRecoveryStore, verifySupplierReturnPreview, type SupplierReturnIntent } from "../../supplier-return-command";
import { supplierReturnMaximumPieces, supplierReturnQuantity, supplierReturnUnits } from "../../supplier-return-quantity";
import { selectShipmentQuantityUnit } from "../../shipment-unit-entry";
import { returnOption, returnPreview, returnRequest, returnResult } from "../../../../../test/fixtures/supplier-return";
import { procurementChildHref, procurementBackHref, parseProcurementJourney, procurementRecordHref } from "../../procurement-navigation";
import { supplierReturnHref } from "../../../features/purchasing/SupplierReturnLink";
const intent = (): SupplierReturnIntent => ({ command: "record", payload: returnRequest(), reviewed: returnPreview() });
function setup() { const values = new Map<string, string>(); const memory = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; const store = createSupplierReturnRecoveryStore(() => memory, "ap-reader"); return { memory, store, client: createSupplierReturnClient(() => "return-key-1", store) }; }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());
describe("accepted-stock return command evidence", () => {
  it("confirms exact frozen quantity, value and stock receipt without a new credit", async () => { const { client, store } = setup(); const fetch = vi.fn(async () => json(returnResult())); vi.stubGlobal("fetch", fetch); await client.execute(intent()); expect(store.read()).toBeNull(); expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0]).toHaveLength(2); });
  it("recovers the same request after lost response, reload and expired session", async () => {
    const { memory, client, store } = setup(); const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, input: RequestInit) => { requests.push(input); throw Error("Lost response"); })); await expect(client.execute(intent())).rejects.toThrow(); const saved = store.read()!;
    const restored = createSupplierReturnRecoveryStore(() => memory, "ap-reader"); const replay = createSupplierReturnClient(() => "other-key", restored);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, input: RequestInit) => { requests.push(input); return json({ error: "Session expired" }, 401); })); await expect(replay.execute(saved.body, saved)).rejects.toThrow("Session expired"); expect(restored.read()).toEqual(saved);
    vi.stubGlobal("fetch", vi.fn(async (_url: string, input: RequestInit) => { requests.push(input); return json(returnResult()); })); await replay.execute(saved.body, saved);
    expect(restored.read()).toBeNull(); expect(requests.every(row => row.body === JSON.stringify(saved.body.payload) && (row.headers as Record<string, string>)["Idempotency-Key"] === saved.key)).toBe(true);
  });
  it("blocks another operator from replacing the saved physical return", async () => { const { memory, store } = setup(); store.acquire(intent(), () => "return-key-1"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); const other = createSupplierReturnRecoveryStore(() => memory, "other"); await expect(createSupplierReturnClient(() => "other-key", other).execute(intent())).rejects.toThrow("another operator"); expect(fetch).not.toHaveBeenCalled(); });
  it.each([401, 403, 409, 429, 500, 503])("retains unproven HTTP %s", async status => { const { client, store } = setup(); vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Unavailable" }, status))); await expect(client.execute(intent())).rejects.toThrow(); expect(store.read()).not.toBeNull(); });
  it.each([409, 503])("only a durable nonambiguous rejection clears HTTP %s", async status => { const { client, store } = setup(); vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Stock changed", details: { supplierReturnCommandOutcome: "rejected", command: "record", actorId: "ap-reader", idempotencyKey: "return-key-1" } }, status))); await expect(client.execute(intent())).rejects.toThrow(); expect(store.read() === null).toBe(status === 409); });
  const mutations: Array<[string, (reply: ReturnType<typeof returnResult>) => void]> = [
    ["actor", value => { value.actorId = "other"; }], ["key", value => { value.idempotencyKey = "other-key"; }], ["resource", value => { value.returnId = 99; }],
    ["echo", value => { value.request.reason = "Other reason"; }], ["collection", value => { value.return.evidenceReference = "Other collection"; }],
    ["vendor", value => { value.return.vendorId = 3; }], ["initial value", value => { value.return.lines[0].costEntries[0].nextMills++; value.return.lines[0].costEntries[0].deltaMills++; }],
    ["initial actor", value => { value.return.lines[0].costEntries[0].recordedBy = "other"; }],
    ["frozen location", value => { value.return.lines[0].source.locationCode = "OTHER"; }], ["frozen availability", value => { value.return.lines[0].source.availableQuantity = 9; }],
    ["missing stock receipt", value => { value.return.inventoryReceipt.lines = []; }], ["duplicate value entry", value => { value.return.lines[0].costEntries.push(value.return.lines[0].costEntries[0]); }],
  ];
  it.each(mutations)("retains response with mismatched %s", async (_name, mutate) => { const { client, store } = setup(); const result = returnResult(); mutate(result); vi.stubGlobal("fetch", vi.fn(async () => json(result))); await expect(client.execute(intent())).rejects.toThrow("could not be verified"); expect(store.read()).not.toBeNull(); });
  it("accepts later value history without replacing the initially reviewed values", async () => { const { client, store } = setup(); const result = returnResult(); result.return.lines[0].currentCosts.productMills += 100; result.return.lines[0].currentCosts.totalMills += 100; result.return.lines[0].costEntries.push({ ...result.return.lines[0].costEntries[0], id: 901, previousMills: 20002, nextMills: 20102, deltaMills: 100, reason: "Late verified invoice", postingKey: "revision:901", recordedBy: "accountant" }); vi.stubGlobal("fetch", vi.fn(async () => json(result))); await client.execute(intent()); expect(store.read()).toBeNull(); });
  it("does not send when recovery cannot be saved", async () => { const store = createSupplierReturnRecoveryStore(() => ({ getItem: () => null, setItem: () => { throw Error("full"); }, removeItem: () => undefined }), "ap-reader"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await expect(createSupplierReturnClient(() => "return-key-1", store).execute(intent())).rejects.toThrow("not sent"); expect(fetch).not.toHaveBeenCalled(); });
  it("rejects another lot's preview before recording", () => { expect(() => verifySupplierReturnPreview({ vendorId: 2, lines: [{ inventoryLotId: 599, quantity: 2 }] }, returnPreview())).toThrow("different selected stock"); });
});
describe("frozen supplier return conversion and navigation", () => {
  it("converts cases and pieces through the shared workflow without changing the frozen factor", () => { const option = returnOption(); const draft = { variantId: 101, unitsPerVariant: 10, quantity: "2" }; const pieces = selectShipmentQuantityUnit(draft, null, supplierReturnUnits(option)); expect(pieces).toEqual({ variantId: null, unitsPerVariant: 1, quantity: "20" }); expect(supplierReturnQuantity(pieces, option)).toBe(2); });
  it.each(["1", "19", "21"])("rejects %s pieces that cannot be whole frozen stock units", quantity => { expect(() => supplierReturnQuantity({ variantId: null, unitsPerVariant: 1, quantity }, returnOption())).toThrow(); });
  it.each(["0", "-1", "1.5", "101", "9007199254740993"])("rejects invalid or unavailable quantity %s", quantity => { expect(() => supplierReturnQuantity({ variantId: null, unitsPerVariant: 1, quantity }, returnOption())).toThrow(); });
  it("caps the converter display without crashing when total lot pieces exceed its range", () => { expect(supplierReturnMaximumPieces({ ...returnOption(), availableQuantity: 2_147_483_647 })).toBe(2_147_483_647); });
  it("cannot turn a blocked source into piece entry", () => { expect(() => supplierReturnUnits({ ...returnOption(), eligible: false, unitsPerVariant: null })).toThrow("no verified"); });
  it("preserves PO and receipt journeys through return work list and detail", () => {
    const source = supplierReturnHref({ vendorId: 2, receivingOrderId: 31 }, "/receiving", "open=31"); const search = source.split("?")[1];
    const detail = procurementRecordHref({ kind: "supplier-return", id: 9, tab: "details" }, parseProcurementJourney(search)); expect(procurementBackHref(detail.split("?")[1], "/supplier-returns")).toBe("/receiving?open=31");
    const invoice = procurementChildHref("/supplier-returns/9", detail.split("?")[1], "/ap-invoices/71"); expect(procurementBackHref(invoice.split("?")[1], "/ap-invoices")).toBe(detail);
  });
});

describe("receipt return-history capability", () => {
  it("requires explicit successful source review", () => { expect(receiptReversalSourceCapability({ allowed: true, code: null, reason: null })).toEqual({ allowed: true, reason: null }); });
  it.each([undefined, null, {}, { allowed: true }, { allowed: true, code: "BLOCKED", reason: "inconsistent" }])("blocks unverified reversal evidence %j", value => { expect(receiptReversalSourceCapability(value).allowed).toBe(false); });
  it("preserves canonical retained-return reason", () => { expect(receiptReversalSourceCapability({ allowed: false, code: "RECEIPT_REVERSAL_SUPPLIER_RETURN_HISTORY", reason: "Stock was returned to supplier" })).toEqual({ allowed: false, reason: "Stock was returned to supplier" }); });
});
