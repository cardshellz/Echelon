import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentCreateClient, createShipmentCreateRecoveryStore } from "../../shipment-create-command";
import type { ShipmentCreateInput } from "@shared/procurement/shipment-create-command";
const body: ShipmentCreateInput = { mode: "ground", purchaseOrder: { purchaseOrderId: 31, lineSelections: [{ poLineId: 7, qty: 501 }] } };
const result = { id: 42, shipmentNumber: "SHP-20261018-001", status: "draft", lineCount: 1, createdBy: "operator-a", createdAt: "2026-10-18T12:00:00Z", updatedAt: "2026-10-18T12:00:00Z" };
const reply = (value: unknown, status = 201) => new Response(JSON.stringify(value), { status });
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createShipmentCreateRecoveryStore(() => storage, "operator-a");
  let sequence = 0;
  const client = createShipmentCreateClient(() => `create-key-${++sequence}`, store);
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());
describe("durable shipment creation client", () => {
  it("persists exact selected pieces before dispatch and clears only verified success", async () => {
    const { store, client } = setup();
    const fetch = vi.fn(async (_url, init) => {
      expect(store.read()?.body).toEqual(body);
      expect(JSON.parse(init.body)).toEqual(body);
      expect(init.headers["Idempotency-Key"]).toBe(store.read()?.key);
      return reply(result);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await client.execute(body)).toEqual(result);
    expect(store.read()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(body.purchaseOrder?.lineSelections?.[0].qty).toBe(501);
  });
  it("replays exact key and body after response loss and client reload", async () => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(reply(result));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body)).rejects.toThrow();
    const saved = store.read()!;
    const reloadedStore = createShipmentCreateRecoveryStore(() => storage, "operator-a");
    await createShipmentCreateClient(() => "must-not-rotate", reloadedStore).execute(saved.body, saved);
    expect(fetch.mock.calls[0][1]).toEqual(fetch.mock.calls[1][1]);
    expect(reloadedStore.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 429, 500, 503])("retains exact intent through unproven HTTP %i outcomes", async status => {
    const { store, client } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ code: "UNCONFIRMED", error: "retry later" }, status)));
    await expect(client.execute(body)).rejects.toThrow();
    expect(store.read()?.key).toBe("create-key-1");
    await expect(client.execute({ mode: "air" })).rejects.toThrow(/unresolved/);
  });
  it("clears a matching recorded rejection but not a different key's rejection", async () => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValueOnce(reply({ error: "capacity", details: { shipmentCreateOutcome: "rejected", idempotencyKey: "other-key" } }, 409))
      .mockResolvedValueOnce(reply({ error: "capacity", details: { shipmentCreateOutcome: "rejected", idempotencyKey: "create-key-1" } }, 409));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body)).rejects.toThrow("capacity");
    expect(store.read()).not.toBeNull();
    await expect(client.execute(body)).rejects.toThrow("capacity");
    expect(store.read()).toBeNull();
  });
  it.each([{ ...result, id: 0 }, { ...result, lineCount: 0 }, { ...result, createdBy: "other" }, { ...result, status: "closed" }, { ...result, createdAt: "bad" }, {}])("retains recovery for malformed or mismatched success %j", async response => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(body)).rejects.toThrow(/could not be verified/);
    expect(store.read()?.body).toEqual(body);
  });
  it("checks a manually requested shipment number", async () => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result)));
    await expect(client.execute({ ...body, shipmentNumber: "EXPECTED" })).rejects.toThrow(/could not be verified/);
    expect(store.read()).not.toBeNull();
  });
  it("does not dispatch invalid payloads or blocked recovery storage", async () => {
    const { storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ mode: "invalid" } as unknown as ShipmentCreateInput)).rejects.toThrow();
    storage.setItem = () => { throw new Error("full"); };
    await expect(client.execute(body)).rejects.toThrow(/not sent/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves corrupt storage without sending or deleting it", async () => {
    const { values, store, client } = setup(); values.set("echelon:shipment-create:v1:operator-a", "broken");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => store.read()).toThrow(/cannot be verified/);
    await expect(client.execute(body)).rejects.toThrow(/cannot be verified/);
    expect(values.size).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps a successful request recoverable when storage removal fails", async () => {
    const { storage, store, client } = setup(); storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result)));
    await expect(client.execute(body)).rejects.toThrow(/could not be cleared/);
    expect(store.read()?.key).toBe("create-key-1");
  });
  it("pins a stale visible recovery card after a late response cleared storage", async () => {
    const { store, client } = setup(); const saved = store.acquire(body, () => "original-key"); store.complete(saved.key);
    const fetch = vi.fn().mockResolvedValue(reply(result)); vi.stubGlobal("fetch", fetch);
    await client.execute(saved.body, saved);
    expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe("original-key");
  });
  it("rejects recovery across operator or changed intent without dispatch", async () => {
    const { store, client } = setup(); const saved = store.acquire(body, () => "original-key"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body, { ...saved, userId: "other" })).rejects.toThrow(/does not match/);
    await expect(client.execute({ mode: "air" }, saved)).rejects.toThrow(/does not match/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("an older success cannot clear a newer saved request", async () => {
    const { store } = setup(); store.acquire(body, () => "original-key"); store.complete("original-key");
    store.acquire({ mode: "air" }, () => "newer-key"); store.complete("original-key");
    expect(store.read()?.key).toBe("newer-key");
  });
  it("isolates operator recovery in the same browser", () => {
    const { store, storage } = setup(); store.acquire(body, () => "original-key");
    expect(createShipmentCreateRecoveryStore(() => storage, "operator-b").read()).toBeNull();
    expect(store.read()?.key).toBe("original-key");
  });
});
