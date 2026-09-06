import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipmentCostRecoveryStore } from "../../shipment-cost-create-recovery";
import { createShipmentCostCommandClient, createShipmentCostPayload } from "../../shipment-cost-command";

const body = createShipmentCostPayload({ costType: "freight", description: "Freight", amount: "-0.55", allocationMethod: "default", vendorId: null, vendorName: "", performedByName: "", costDate: "" });
const command = { method: "POST" as const, shipmentId: 42, body };
const saved = () => new Response(JSON.stringify({ id: 31, inboundShipmentId: 42, version: "a".repeat(64) }));
function session() {
  const values = new Map<string, string>();
  return { values, storage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } };
}
afterEach(() => vi.unstubAllGlobals());

describe("shipment cost create recovery", () => {
  it("persists before sending and restores the exact key/body after a reload without autoexecuting", async () => {
    const { storage, values } = session();
    const firstStore = createShipmentCostRecoveryStore(() => storage, "user-a");
    const fetch = vi.fn().mockImplementationOnce(() => {
      expect(values.size).toBe(1);
      expect(firstStore.read(42)?.key).toBe("first-key");
      return Promise.reject(new TypeError("Connection lost"));
    }).mockImplementation(() => Promise.resolve(saved()));
    vi.stubGlobal("fetch", fetch);
    await expect(createShipmentCostCommandClient(() => "first-key", firstStore).execute(command)).rejects.toMatchObject({ ambiguous: true });
    const reloadedStore = createShipmentCostRecoveryStore(() => storage, "user-a");
    const recovered = reloadedStore.read(42)!;
    expect(fetch).toHaveBeenCalledTimes(1);
    await createShipmentCostCommandClient(() => "wrong-new-key", reloadedStore).execute({ ...command, body: recovered.body });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe("first-key");
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(body);
    expect(reloadedStore.read(42)).toBeNull();
  });

  it("rejects changed create payloads while an earlier command remains unresolved", async () => {
    const { storage } = session();
    const recovery = createShipmentCostRecoveryStore(() => storage, "user-a");
    const fetch = vi.fn().mockRejectedValue(new TypeError("Connection lost"));
    vi.stubGlobal("fetch", fetch);
    const client = createShipmentCostCommandClient(() => "original-key", recovery);
    await client.execute(command).catch(() => undefined);
    await expect(client.execute({ ...command, body: { ...body, description: "Different cost" } })).rejects.toThrow("earlier cost creation is unresolved");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recovery.read(42)?.body).toEqual(body);
  });

  it("separates authenticated users and shipments", () => {
    const { storage } = session();
    const userA = createShipmentCostRecoveryStore(() => storage, "user-a");
    userA.acquire(42, body, () => "user-a-key");
    expect(createShipmentCostRecoveryStore(() => storage, "user-b").read(42)).toBeNull();
    expect(userA.read(43)).toBeNull();
    expect(userA.read(42)?.key).toBe("user-a-key");
  });

  it.each([
    "not json",
    JSON.stringify({ schemaVersion: 1, userId: "other-user", shipmentId: 42, key: "original-key", body }),
    JSON.stringify({ schemaVersion: 1, userId: "user-a", shipmentId: 42, key: "bad key", body }),
    JSON.stringify({ schemaVersion: 1, userId: "user-a", shipmentId: 42, key: "original-key", body: { ...body, vendorInvoiceId: 71 } }),
    JSON.stringify({ schemaVersion: 1, userId: "user-a", shipmentId: 99, key: "original-key", body }),
  ])("blocks unverifiable recovered commands without discarding evidence", (raw) => {
    const { storage, values } = session();
    values.set("echelon:shipment-cost-create:v1:user-a:42", raw);
    const store = createShipmentCostRecoveryStore(() => storage, "user-a");
    expect(() => store.read(42)).toThrow("could not be verified");
    expect(() => store.acquire(42, body, () => "new-key-1")).toThrow();
    expect(values.get("echelon:shipment-cost-create:v1:user-a:42")).toBe(raw);
  });

  it("does not send if recovery storage is unavailable or full", async () => {
    const { storage } = session();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const unreadable = createShipmentCostRecoveryStore(() => { throw new Error("Blocked"); }, "user-a");
    await expect(createShipmentCostCommandClient(() => "saved-key", unreadable).execute(command)).rejects.toThrow("cannot be read");
    const full = createShipmentCostRecoveryStore(() => ({ ...storage, setItem: () => { throw new Error("Quota"); } }), "user-a");
    await expect(createShipmentCostCommandClient(() => "saved-key", full).execute(command)).rejects.toThrow("was not sent");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears a definitively rejected command so the operator can correct its draft", async () => {
    const { storage } = session();
    const recovery = createShipmentCostRecoveryStore(() => storage, "user-a");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Rejected" }), { status: 422 })));
    await expect(createShipmentCostCommandClient(() => "saved-key", recovery).execute(command)).rejects.toMatchObject({ ambiguous: false });
    expect(recovery.read(42)).toBeNull();
  });

  it("retains the original command when storage cleanup fails after a confirmed save", async () => {
    const { storage } = session();
    let canClear = false;
    const recovery = createShipmentCostRecoveryStore(() => ({ ...storage, removeItem: (key) => {
      if (!canClear) throw new Error("Blocked");
      storage.removeItem(key);
    } }), "user-a");
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(saved()));
    vi.stubGlobal("fetch", fetch);
    const client = createShipmentCostCommandClient(() => "original-key", recovery);
    await expect(client.execute(command)).rejects.toMatchObject({ ambiguous: true, code: "SHIPMENT_COST_RECOVERY_STORAGE_FAILED" });
    expect(recovery.read(42)?.key).toBe("original-key");
    canClear = true;
    await client.execute(command);
    expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe("original-key");
    expect(recovery.read(42)).toBeNull();
  });
});
