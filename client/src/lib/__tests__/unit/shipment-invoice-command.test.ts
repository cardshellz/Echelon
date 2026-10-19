import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentInvoiceClient, createShipmentInvoiceRecoveryStore, parseShipmentInvoiceAmount, shipmentInvoiceAmountInput } from "../../shipment-invoice-command";
const input = { vendorId: 2, invoiceNumber: "FREIGHT-1", invoiceDate: "2026-10-19", costRowIds: [9, 10], lineOverrides: [{ freightCostId: 9, qtyInvoiced: 1, unitCostCents: 29 }] };
const result = { invoiceId: 71, id: 71, shipmentId: 42, inboundShipmentId: 42, vendorId: 2, invoiceNumber: "FREIGHT-1", actorId: "operator-a", idempotencyKey: "shipment-invoice-1", costRowIds: [10, 9], totalCents: 10029, currency: "USD" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createShipmentInvoiceRecoveryStore(() => storage, "operator-a", 42);
  const client = createShipmentInvoiceClient(() => "shipment-invoice-1", store, 42);
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());
describe("shipment invoice command recovery", () => {
  it("persists the explicit selection and exact overrides before dispatch and verifies complete result", async () => {
    const { store, client } = setup();
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      expect(store.read()?.body).toEqual({ shipmentId: 42, payload: input });
      expect(url).toBe("/api/inbound-shipments/42/create-invoice"); expect(JSON.parse(init.body)).toEqual(input);
      expect(init.headers["Idempotency-Key"]).toBe(store.read()?.key); return reply(result);
    }));
    expect(await client.execute(input)).toEqual(result); expect(store.read()).toBeNull();
  });
  it("replays the original request after response loss and a new page instance", async () => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(reply(result)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(input)).rejects.toThrow(); const saved = store.read()!;
    const reloaded = createShipmentInvoiceRecoveryStore(() => storage, "operator-a", 42);
    await createShipmentInvoiceClient(() => "must-not-rotate", reloaded, 42).execute(saved.body.payload, saved);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]); expect(reloaded.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 429, 500, 503])("retains unresolved HTTP %i without manufacturing a fresh invoice", async status => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error: "Unavailable" }, status)));
    await expect(client.execute(input)).rejects.toThrow(); expect(store.read()).not.toBeNull();
    await expect(client.execute({ ...input, invoiceNumber: "DIFFERENT" })).rejects.toThrow(/unresolved/);
  });
  it.each([
    {}, { ...result, id: 72 }, { ...result, actorId: "operator-b" }, { ...result, shipmentId: 43, inboundShipmentId: 43 },
    { ...result, vendorId: 3 }, { ...result, costRowIds: [9] }, { ...result, costRowIds: [9, 9] },
    { ...result, invoiceNumber: "DIFFERENT" }, { ...result, idempotencyKey: "other-key" }, { ...result, totalCents: 0.29 },
  ])("retains identity when success is unverified %j", async body => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(body)));
    await expect(client.execute(input)).rejects.toThrow(/could not be verified/); expect(store.read()).not.toBeNull();
  });
  it("retains a response whose total differs from every explicitly reviewed line", async () => {
    const { store, client } = setup(); const allLines = { ...input, lineOverrides: [...input.lineOverrides, { freightCostId: 10, qtyInvoiced: 1, unitCostCents: 10000 }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ...result, totalCents: 10030 })));
    await expect(client.execute(allLines)).rejects.toThrow(/could not be verified/); expect(store.read()).not.toBeNull();
  });
  it("only clears a matching persisted rejection", async () => {
    const { store, client } = setup();
    const rejected = { code: "AP_COST_ALREADY_BILLED", error: "Review charge ownership", commandOutcome: "rejected", shipmentId: 42, actorId: "operator-a", idempotencyKey: "shipment-invoice-1" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ ...rejected, actorId: "operator-b" }, 409)).mockResolvedValueOnce(reply(rejected, 409)));
    await expect(client.execute(input)).rejects.toThrow(); expect(store.read()).not.toBeNull();
    await expect(client.execute(input)).rejects.toThrow(); expect(store.read()).toBeNull();
  });
  it("does not send invalid input or unsaved intent", async () => {
    const { storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...input, costRowIds: [] })).rejects.toThrow();
    storage.setItem = () => { throw new Error("storage full"); };
    await expect(client.execute(input)).rejects.toThrow(/not sent/); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves corrupt records and refuses cross-shipment recovery", async () => {
    const { values, store, client } = setup(); values.set("echelon:shipment-invoice:v1:operator-a:42", "broken");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => store.read()).toThrow(/cannot be verified/); await expect(client.execute(input)).rejects.toThrow();
    expect(values.size).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("isolates operator and shipment stores and checks pinned identity", async () => {
    const { storage, store, client } = setup(); const saved = store.acquire({ shipmentId: 42, payload: input }, () => "shipment-invoice-1");
    expect(createShipmentInvoiceRecoveryStore(() => storage, "operator-b", 42).read()).toBeNull();
    expect(createShipmentInvoiceRecoveryStore(() => storage, "operator-a", 43).read()).toBeNull();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(input, { ...saved, userId: "operator-b" })).rejects.toThrow(/does not match/);
    await expect(client.execute({ ...input, costRowIds: [9] }, saved)).rejects.toThrow(/does not match/); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains evidence when clearing fails and pins an old visible request after successful clear", async () => {
    const { storage, store, client } = setup(); const remove = storage.removeItem;
    storage.removeItem = () => { throw new Error("blocked"); }; vi.stubGlobal("fetch", vi.fn().mockImplementation(() => reply(result)));
    await expect(client.execute(input)).rejects.toThrow(/could not be cleared/); const saved = store.read()!;
    storage.removeItem = remove; store.complete(saved.key); await client.execute(saved.body.payload, saved);
    expect(store.read()).toBeNull();
  });
});
describe("exact shipment invoice amount input", () => {
  it.each([["0", 0], ["0.29", 29], ["12.30", 1230], ["-0.29", -29], ["21474836.47", 2147483647], ["21474836.48", 2147483648], ["90071992547409.91", Number.MAX_SAFE_INTEGER], ["-90071992547409.91", Number.MIN_SAFE_INTEGER]] as const)("parses %s exactly", (raw, cents) => {
    expect(parseShipmentInvoiceAmount(raw)).toBe(cents); expect(parseShipmentInvoiceAmount(shipmentInvoiceAmountInput(cents))).toBe(cents);
  });
  it.each(["", "1.234", "1e2", "1,000", "Infinity", "--1", "90071992547409.92", "-90071992547409.92"])("rejects unsupported text %s", raw => expect(() => parseShipmentInvoiceAmount(raw)).toThrow());
});
