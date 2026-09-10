import { afterEach, describe, expect, it, vi } from "vitest";
import { createInventoryCommandRequester, InventoryIntentRecoveryError } from "../../inventory-command";

afterEach(() => vi.unstubAllGlobals());
const payload = { productVariantId: 10, warehouseLocationId: 20, qtyDelta: 5, reason: "Observed stock" };
const ok = () => new Response(JSON.stringify({ success: true }), { status: 200 });
function retainedStore() {
  const data = new Map<string, string>();
  return { data, getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }) };
}

describe("inventory command client intent", () => {
  it.each(["network", "server", "invalid-success", "rejection"])("retains the exact key after %s failure", async failure => {
    const fetchMock = vi.fn();
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("Lost response"));
    else fetchMock.mockResolvedValueOnce(new Response(failure === "invalid-success" ? "incomplete" : "{}", {
      status: failure === "server" ? 500 : failure === "rejection" ? 400 : 200,
    }));
    fetchMock.mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);
    const generate = vi.fn(() => "same-intent");
    const request = createInventoryCommandRequester(generate);
    await expect(request("/api/inventory/adjust", payload)).rejects.toThrow();
    await expect(request("/api/inventory/adjust", { ...payload })).resolves.toEqual({ success: true });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["same-intent", "same-intent"]);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  });

  it("creates a new key after success, even for another identical physical operation", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ok()); vi.stubGlobal("fetch", fetchMock);
    let sequence = 0;
    const request = createInventoryCommandRequester(() => `intent-${++sequence}`);
    await request("/api/inventory/adjust", payload);
    await request("/api/inventory/adjust", payload);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["intent-1", "intent-2"]);
  });

  it("changes identity for edited intent while preserving another route's pending command", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Lost response")); vi.stubGlobal("fetch", fetchMock);
    let sequence = 0;
    const request = createInventoryCommandRequester(() => `intent-${++sequence}`);
    for (const [url, body] of [["/adjust", payload], ["/receive", payload], ["/adjust", payload],
      ["/adjust", { ...payload, qtyDelta: 6 }]] as const) {
      await expect(request(url, body)).rejects.toThrow();
    }
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["intent-1", "intent-2", "intent-1", "intent-3"]);
    expect(payload).not.toHaveProperty("commandKey");
  });

  it("prevents callers from overriding the retained command key", async () => {
    const request = createInventoryCommandRequester(() => "owner-key");
    await expect(request("/adjust", { ...payload, commandKey: "another-key" })).rejects.toThrow(/intent owner/);
  });

  it("reuses the exact wire payload after a reload and preserves edited unresolved intents", async () => {
    const store = retainedStore();
    const persistence = { actorId: "operator-1", storage: () => store };
    const fetchMock = vi.fn().mockRejectedValue(new Error("Lost response")); vi.stubGlobal("fetch", fetchMock);
    let sequence = 0;
    const generate = vi.fn(() => `intent-${++sequence}`);
    const firstPage = createInventoryCommandRequester(generate, undefined, persistence);
    await expect(firstPage("/adjust", payload)).rejects.toThrow();
    await expect(firstPage("/adjust", { ...payload, qtyDelta: 9 })).rejects.toThrow();
    const reloadedPage = createInventoryCommandRequester(generate, undefined, persistence);
    await expect(reloadedPage("/adjust", { reason: payload.reason, qtyDelta: 5,
      warehouseLocationId: 20, productVariantId: 10 })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[0][1].body);
    expect(JSON.parse([...store.data.values()][0]).pending).toHaveLength(2);
  });

  it("scopes pending intents to the authenticated actor", async () => {
    const store = retainedStore();
    const fetchMock = vi.fn().mockRejectedValue(new Error("Lost response")); vi.stubGlobal("fetch", fetchMock);
    for (const actorId of ["alice", "bob"]) {
      const request = createInventoryCommandRequester(() => actorId, undefined, { actorId, storage: () => store });
      await expect(request("/adjust", payload)).rejects.toThrow();
    }
    expect(store.data.size).toBe(2);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["alice", "bob"]);
  });

  it.each(["read", "write", "corrupt", "actor"])("does not send when %s persistence is unsafe", async failure => {
    const store = retainedStore();
    if (failure === "read") store.getItem.mockImplementation(() => { throw new Error("Denied"); });
    if (failure === "write") store.setItem.mockImplementation(() => { throw new Error("Quota"); });
    if (failure === "corrupt") store.data.set("echelon:inventory-intents:v1:alice", "not-json");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const request = createInventoryCommandRequester(() => "new-intent", undefined,
      { actorId: failure === "actor" ? "" : "alice", storage: () => store });
    await expect(request("/adjust", payload)).rejects.toBeInstanceOf(InventoryIntentRecoveryError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears only acknowledged intent and starts a new operation after reload", async () => {
    const store = retainedStore(); const persistence = { actorId: "alice", storage: () => store };
    const fetchMock = vi.fn().mockImplementation(async () => ok()); vi.stubGlobal("fetch", fetchMock);
    await createInventoryCommandRequester(() => "first", undefined, persistence)("/adjust", payload);
    await createInventoryCommandRequester(() => "second", undefined, persistence)("/adjust", payload);
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["first", "second"]);
    expect(JSON.parse([...store.data.values()][0]).pending).toEqual([]);
  });

  it("does not lose committed intent when acknowledgement cleanup fails", async () => {
    const store = retainedStore(); const persistence = { actorId: "alice", storage: () => store };
    const fetchMock = vi.fn().mockImplementation(async () => ok()); vi.stubGlobal("fetch", fetchMock);
    store.setItem.mockImplementationOnce((key, value) => { store.data.set(key, value); })
      .mockImplementationOnce(() => { throw new Error("Quota"); });
    await expect(createInventoryCommandRequester(() => "first", undefined, persistence)("/adjust", payload))
      .rejects.toThrow(/may already have completed/);
    const neverGenerate = vi.fn(() => "unsafe-new-intent");
    await createInventoryCommandRequester(neverGenerate, undefined, persistence)("/adjust", payload);
    expect(neverGenerate).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body).commandKey)).toEqual(["first", "first"]);
  });
});
