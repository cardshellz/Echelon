import { afterEach, describe, expect, it, vi } from "vitest";
import { createPoShipmentClient } from "../../shipment-create-from-po";
import { shipmentCreateFromPoSchema, verifyShipmentCreatedFromPo } from "@shared/procurement/shipment-create-from-po";

const input = { header: { shipmentNumber: "SHIP-123" }, source: { purchaseOrderId: 10, lineSelections: [{ poLineId: 21, qty: 2 }] } };
const receipt = { shipment: { id: 7, shipmentNumber: "SHIP-123" }, purchaseOrderId: 10,
  lines: [{ id: 31, inboundShipmentId: 7, purchaseOrderId: 10, purchaseOrderLineId: 21, qtyShipped: 2 }] };
const response = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status });
function setup() {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const generateKey = vi.fn(() => "po-shipment-fixture-key");
  const client = createPoShipmentClient("user-1", () => storage, generateKey);
  return { data, storage, generateKey, client };
}
afterEach(() => vi.unstubAllGlobals());

describe("atomic PO shipment client", () => {
  it("sends exactly one request with explicit source quantities and a saved recovery key", async () => {
    const { client, data } = setup();
    const fetcher = vi.fn(async () => { expect(data.size).toBe(1); return response(receipt); }); vi.stubGlobal("fetch", fetcher);
    expect(await client.execute(input)).toEqual(receipt);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith("/api/inbound-shipments/from-po", expect.objectContaining({ credentials: "include", body: JSON.stringify(input), headers: expect.objectContaining({ "Idempotency-Key": "po-shipment-fixture-key" }) }));
    expect(client.read(10)).toBeNull();
  });
  it("reloads the exact body and key after a lost response and blocks a changed request", async () => {
    const { client, storage, generateKey } = setup();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("Lost response")).mockResolvedValue(response(receipt)); vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(input)).rejects.toMatchObject({ ambiguous: true });
    const reloaded = createPoShipmentClient("user-1", () => storage, generateKey);
    const saved = reloaded.read(10)!;
    await expect(reloaded.execute({ ...input, header: { shipmentNumber: "CHANGED" } })).rejects.toThrow("unresolved");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(reloaded.execute(saved.input, saved)).resolves.toEqual(receipt);
    expect(fetcher.mock.calls[1][1]).toEqual(fetcher.mock.calls[0][1]);
    expect(generateKey).toHaveBeenCalledOnce();
  });
  it("pins a displayed recovery request after another response has already cleared storage", async () => {
    const { client, storage, data } = setup();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("Lost")).mockResolvedValue(response(receipt)); vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(input)).rejects.toThrow(); const saved = client.read(10)!;
    data.clear();
    const reloaded = createPoShipmentClient("user-1", () => storage, () => "should-not-be-generated");
    await reloaded.execute(saved.input, saved);
    expect(fetcher.mock.calls[1][1].headers["Idempotency-Key"]).toBe(saved.key);
  });
  it.each([{}, { ...receipt, lines: [] }, { ...receipt, purchaseOrderId: 11 },
    { ...receipt, lines: [{ ...receipt.lines[0], qtyShipped: 1 }] },
    { ...receipt, lines: [{ ...receipt.lines[0], inboundShipmentId: 99 }] }])("retains the command on an invalid or incomplete success receipt", async (body) => {
    const { client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(body)));
    await expect(client.execute(input)).rejects.toMatchObject({ ambiguous: true, code: "SHIPMENT_CREATE_RESPONSE_INVALID" });
    expect(client.read(10)).not.toBeNull();
  });
  it("clears a definitive rejection so the user can correct the selection", async () => {
    const { client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: "Not enough remaining quantity", commandStatus: "rejected" }, 409)));
    await expect(client.execute(input)).rejects.toMatchObject({ ambiguous: false });
    expect(client.read(10)).toBeNull();
  });
  it.each(["read", "write", "corrupt"])("does not send when recovery storage cannot %s safely", async (failure) => {
    const { storage, data } = setup();
    if (failure === "read") storage.getItem = () => { throw new Error("denied"); };
    if (failure === "write") storage.setItem = () => { throw new Error("quota"); };
    if (failure === "corrupt") data.set("echelon:po-shipment:v1:user-1:10", "{}");
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const client = createPoShipmentClient("user-1", () => storage, () => "fixture-command-key");
    await expect(client.execute(input)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains a committed result's key if clearing storage fails", async () => {
    const { storage, client } = setup(); storage.removeItem = () => { throw new Error("denied"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(receipt)));
    await expect(client.execute(input)).rejects.toMatchObject({ ambiguous: true, code: "SHIPMENT_CREATE_STORAGE_FAILED" });
    expect(client.read(10)).not.toBeNull();
  });
  it.each([[], [{ poLineId: 21, qty: 0 }], [{ poLineId: 21, qty: 2_147_483_648 }], [{ poLineId: 21, qty: 1 }, { poLineId: 21, qty: 2 }]].map((lineSelections) => ({ lineSelections })))("rejects invalid explicit selections before dispatch", ({ lineSelections }) => {
    expect(shipmentCreateFromPoSchema.safeParse({ ...input, source: { purchaseOrderId: 10, lineSelections } }).success).toBe(false);
  });
  it("checks source identities and quantities even when response counts match", () => {
    expect(() => verifyShipmentCreatedFromPo(input, { ...receipt, lines: [{ ...receipt.lines[0], purchaseOrderLineId: 22 }] })).toThrow();
  });
  it.each([401, 403, 404, 422])("retains the original key when HTTP %s cannot establish the prior attempt's outcome", async (status) => {
    const { client, storage, generateKey } = setup();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce(response({ error: "Request denied" }, status)).mockResolvedValue(response(receipt));
    vi.stubGlobal("fetch", fetcher);
    await expect(client.execute(input)).rejects.toMatchObject({ ambiguous: true });
    const reloaded = createPoShipmentClient("user-1", () => storage, generateKey);
    await expect(reloaded.execute(input)).rejects.toMatchObject({ status, ambiguous: true });
    expect(reloaded.read(10)).not.toBeNull();
    await expect(reloaded.execute(input)).resolves.toEqual(receipt);
    expect(fetcher.mock.calls.map((call) => call[1].headers["Idempotency-Key"]))
      .toEqual(["po-shipment-fixture-key", "po-shipment-fixture-key", "po-shipment-fixture-key"]);
  });

});
