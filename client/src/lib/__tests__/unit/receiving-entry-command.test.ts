import { afterEach, describe, expect, it, vi } from "vitest";
import { createReceivingEntryClient, createReceivingEntryRecoveryStore } from "../../receiving-entry-command";
import type { ReceivingEntryCommand } from "@shared/procurement/receiving-entry-command";

const create: ReceivingEntryCommand = { action: "create", targetId: null, payload: { sourceType: "blind", warehouseId: 1, notes: "Physical batch A" } };
const add: ReceivingEntryCommand = { action: "add-line", targetId: 31, payload: { sku: "CASE-5", productId: 10, productVariantId: 12, expectedQty: 5, receivedQty: 5, expectedUnitsPerVariant: 5, putawayLocationId: 3 } };
function result(command: ReceivingEntryCommand, key = "entry-key-1") {
  return { id: 31, receiptNumber: "RCV-001", status: command.action === "create" ? "draft" : "open", sourceType: "blind", warehouseId: 1, vendorId: null, poNumber: null,
    createdBy: "operator-a", asnNumber: null, expectedDate: null, notes: command.action === "create" ? command.payload.notes ?? null : null,
    lines: command.action === "create" ? [] : [{ productName: null, barcode: null, unitCost: null, unitCostMills: null, damagedQty: 0, ...command.payload, id: 7, receivingOrderId: 31, unitsPerVariantSnapshot: 5 }],
    entryCommand: { action: command.action, targetId: command.targetId, actorId: "operator-a", idempotencyKey: key, receivingOrderId: 31, receivingLineId: command.action === "create" ? null : 7 } };
}
const reply = (value: unknown, status = 201) => new Response(JSON.stringify(value), { status });
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createReceivingEntryRecoveryStore(() => storage, "operator-a");
  let sequence = 0;
  const client = createReceivingEntryClient(() => `entry-key-${++sequence}`, store);
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());

describe("manual receiving entry recovery", () => {
  it.each([create, add])("saves $action before dispatch and clears only the verified command result", async command => {
    const { store, client } = setup();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(store.read()?.body).toEqual(command);
      expect(url).toBe(command.action === "create" ? "/api/receiving" : "/api/receiving/31/lines");
      expect(JSON.parse(String(init.body))).toEqual(command.payload);
      expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(store.read()?.key);
      return reply(result(command));
    });
    vi.stubGlobal("fetch", fetch);
    expect(await client.execute(command)).toEqual(result(command));
    expect(store.read()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([create, add])("recovers $action after commit/reply loss and client reload with exact key/body", async command => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValueOnce(reply(result(command)));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(command)).rejects.toThrow();
    const saved = store.read()!;
    const reloaded = createReceivingEntryRecoveryStore(() => storage, "operator-a");
    await createReceivingEntryClient(() => "never-rotate", reloaded).execute(saved.body, saved);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
    expect(reloaded.read()).toBeNull();
  });
  it("allows a distinct identical physical batch only after confirming the first", async () => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValueOnce(reply(result(add))).mockResolvedValueOnce(reply(result(add, "entry-key-2")));
    vi.stubGlobal("fetch", fetch);
    await client.execute(add); await client.execute(add);
    expect(fetch.mock.calls.map(call => call[1].headers["Idempotency-Key"])).toEqual(["entry-key-1", "entry-key-2"]);
    expect(store.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 429, 500, 503])("retains the exact intent for unproven HTTP %i", async status => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValue(reply({ error: "Unconfirmed result" }, status)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(add)).rejects.toThrow();
    await expect(client.execute(create)).rejects.toThrow(/unresolved/);
    await expect(client.execute({ ...add, targetId: 32 })).rejects.toThrow(/unresolved/);
    expect(store.read()?.body).toEqual(add); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("only a matching durable rejection releases a failed intent", async () => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValueOnce(reply({ error: "Changed unit", details: { receivingEntryOutcome: "rejected", idempotencyKey: "other-key" } }, 409))
      .mockResolvedValueOnce(reply({ error: "Changed unit", details: { receivingEntryOutcome: "rejected", idempotencyKey: "entry-key-1" } }, 409));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(add)).rejects.toThrow("Changed unit"); expect(store.read()).not.toBeNull();
    await expect(client.execute(add)).rejects.toThrow("Changed unit"); expect(store.read()).toBeNull();
  });
  it.each([
    {}, { ...result(add), id: 32 }, { ...result(add), lines: [] },
    { ...result(add), lines: [{ id: 7, receivingOrderId: 32 }] },
    { ...result(add), entryCommand: { ...result(add).entryCommand, actorId: "operator-b" } },
    { ...result(add), entryCommand: { ...result(add).entryCommand, idempotencyKey: "other-key" } },
    { ...result(add), entryCommand: { ...result(add).entryCommand, targetId: 32 } },
    result(create),
    { ...result(add), lines: [{ ...result(add).lines[0], receivedQty: 50 }] },
    { ...result(add), lines: [{ ...result(add).lines[0], unitsPerVariantSnapshot: 50 }] },
  ])("preserves recovery on malformed/mismatched success %j", async response => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(add)).rejects.toThrow(/could not be verified/);
    expect(store.read()?.body).toEqual(add);
  });
  it("preserves successful-but-unreadable responses for exact recovery", async () => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("broken JSON", { status: 201 })));
    await expect(client.execute(add)).rejects.toThrow(); expect(store.read()?.body).toEqual(add);
  });
  it("fails before sending invalid input or unsavable recovery", async () => {
    const { storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...add, payload: { expectedQty: -1 } })).rejects.toThrow();
    storage.setItem = () => { throw new Error("full"); };
    await expect(client.execute(add)).rejects.toThrow(/not sent/); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps corrupt saved evidence and refuses dispatch", async () => {
    const { values, client } = setup(); values.set("echelon:receiving-entry:v1:operator-a", "broken");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(add)).rejects.toThrow(/cannot be verified/);
    expect(values.size).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains confirmed results if clearing storage fails", async () => {
    const { storage, store, client } = setup(); storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result(add))));
    await expect(client.execute(add)).rejects.toThrow(/could not be cleared/); expect(store.read()?.body).toEqual(add);
  });
  it("pins a stale visible recovery card without creating a fresh command", async () => {
    const { store, client } = setup(); const saved = store.acquire(add, () => "entry-key-1"); store.complete(saved.key);
    const fetch = vi.fn().mockResolvedValue(reply(result(add))); vi.stubGlobal("fetch", fetch);
    await client.execute(saved.body, saved); expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(saved.key);
  });
  it("does not send another actor's request or clear a newer intent", async () => {
    const { storage, store, client } = setup(); const saved = store.acquire(add, () => "entry-key-1");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(createReceivingEntryRecoveryStore(() => storage, "operator-b").read()).toBeNull();
    await expect(client.execute(add, { ...saved, userId: "operator-b" })).rejects.toThrow(/does not match/);
    await expect(client.execute(create, saved)).rejects.toThrow(/does not match/);
    store.complete(saved.key); store.acquire(create, () => "entry-key-2"); store.complete(saved.key);
    expect(store.read()?.key).toBe("entry-key-2"); expect(fetch).not.toHaveBeenCalled();
  });
});
