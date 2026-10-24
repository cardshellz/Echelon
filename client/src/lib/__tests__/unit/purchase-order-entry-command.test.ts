import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { createPurchaseOrderEntryClient, createPurchaseOrderEntryRecoveryStore, purchaseOrderEntryRequest } from "../../purchase-order-entry-command";
import type { PurchaseOrderEntryCommand } from "@shared/procurement/purchase-order-entry-command";

const commands: PurchaseOrderEntryCommand[] = [
  { action: "create", targetId: null, payload: { vendorId: 2, lines: [{ description: "Fee", orderQty: 1 }], prepare_for_supplier: false } },
  { action: "save-draft", targetId: 17, payload: { vendor_id: 2, lines: [{ description: "Fee", orderQty: 1 }], expected_updated_at: "2026-10-24T12:00:00.000Z" } },
  { action: "duplicate", targetId: 99, payload: {} },
  { action: "prepare", targetId: 17, payload: {} },
  { action: "prepare-document", targetId: 17, payload: {} },
];
function result(command: PurchaseOrderEntryCommand, key = "entry-key-1") {
  const status = command.action.startsWith("prepare") || command.payload.prepare_for_supplier ? "approved" : "draft";
  return { id: 17, po_number: "TEST-17", po: { id: 17, poNumber: "TEST-17", status, physicalStatus: "draft", vendorId: 2,
    updatedAt: "2026-10-24T12:01:00.000Z", totalCents: 1000, lineCount: 1 },
    status, pending_approval: false, dispatch_recorded: false, pdf: null,
    lines: [{ id: 7, purchaseOrderId: 17, status: "open", lineNumber: 1, orderQty: 1 }],
    entryCommand: { action: command.action, targetId: command.targetId, actorId: "operator-a", idempotencyKey: key, purchaseOrderId: 17, requestCanonical: canonicalJson(command) } };
}
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createPurchaseOrderEntryRecoveryStore(() => storage, "operator-a");
  let sequence = 0;
  return { values, storage, store, client: createPurchaseOrderEntryClient(() => `entry-key-${++sequence}`, store, () => true) };
}
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

describe("purchase order entry durable client", () => {
  it.each(commands)("persists $action before transport and verifies the exact canonical echo", async command => {
    const { store, client } = setup();
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(store.read()?.body).toEqual(command);
      expect(url).toBe(purchaseOrderEntryRequest(command).url);
      expect(init.method).toBe(purchaseOrderEntryRequest(command).method);
      expect(JSON.parse(String(init.body))).toEqual(command.payload);
      expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("entry-key-1");
      return reply(result(command));
    });
    vi.stubGlobal("fetch", fetch);
    await client.execute(command); expect(store.read()).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(commands)("recovers $action after lost response and reload with identical method, body and key", async command => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("reply lost")).mockResolvedValueOnce(reply(result(command))); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(command)).rejects.toThrow();
    const saved = store.read()!;
    const reloaded = createPurchaseOrderEntryRecoveryStore(() => storage, "operator-a");
    await createPurchaseOrderEntryClient(() => "never-rotate", reloaded, () => true).execute(saved.body, saved);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]); expect(reloaded.read()).toBeNull();
  });
  it.each([401,403,404,409,429,500,503])("retains unproven HTTP %i and refuses changed terms", async status => {
    const { store, client } = setup(); const fetch = vi.fn().mockResolvedValue(reply({ error: "Unknown outcome", code: "PURCHASE_ORDER_ENTRY_LEGACY_REVIEW_REQUIRED" }, status)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(commands[0])).rejects.toThrow();
    await expect(client.execute({ ...commands[0], payload: { vendorId: 3 } })).rejects.toThrow(/unresolved/);
    await expect(client.execute(commands[1])).rejects.toThrow(/unresolved/);
    expect(store.read()?.body).toEqual(commands[0]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["actorId", "action", "targetId", "requestCanonical", "idempotencyKey"])("does not release a durable rejection with mismatched %s", async field => {
    const { store, client } = setup(); const command = commands[1];
    const details = { purchaseOrderEntryOutcome: "rejected", ...result(command).entryCommand, [field]: "wrong" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error: "Rejected", details }, 409)));
    await expect(client.execute(command)).rejects.toThrow(); expect(store.read()).not.toBeNull();
  });
  it("releases a fully bound rejection and permits a deliberate correction with a new key", async () => {
    const { store, client } = setup(); const command = commands[1];
    const fetch = vi.fn().mockResolvedValueOnce(reply({ error: "Stale version", details: { purchaseOrderEntryOutcome: "rejected", ...result(command).entryCommand } }, 409))
      .mockResolvedValueOnce(reply(result(command, "entry-key-2"))); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(command)).rejects.toThrow("Stale version"); expect(store.read()).toBeNull();
    await client.execute(command); expect(fetch.mock.calls[1][1].headers["Idempotency-Key"]).toBe("entry-key-2");
  });
  it.each([
    {}, { ...result(commands[0]), lines: [] },
    { ...result(commands[0]), po: { ...result(commands[0]).po, id: 99 } },
    { ...result(commands[0]), entryCommand: { ...result(commands[0]).entryCommand, actorId: "other" } },
    { ...result(commands[0]), entryCommand: { ...result(commands[0]).entryCommand, requestCanonical: "{}" } },
    { ...result(commands[0]), entryCommand: { ...result(commands[0]).entryCommand, idempotencyKey: "other-key" } },
    { ...result(commands[0]), status: "approved" },
    { ...result(commands[0]), dispatch_recorded: true },
    { ...result(commands[0]), po: { ...result(commands[0]).po, status: "approved" }, status: "approved" },
    { ...result(commands[0]), lines: [{ ...result(commands[0]).lines[0], purchaseOrderId: 99 }] },
  ])("retains malformed or unrelated successful evidence %j", async response => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(commands[0])).rejects.toThrow(/could not be verified/); expect(store.read()).not.toBeNull();
  });
  it("retains unreadable success", async () => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("broken JSON", { status: 201 })));
    await expect(client.execute(commands[0])).rejects.toThrow(); expect(store.read()).not.toBeNull();
  });
  it("confirms saved creation even when supplier preparation failed", async () => {
    const { store, client } = setup(); const command = { ...commands[0], payload: { ...commands[0].payload, prepare_for_supplier: true } };
    const response = result(command); response.po.status = "draft"; response.status = "draft";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ ...response, sendError: "Review supplier quote" })));
    await client.execute(command); expect(store.read()).toBeNull();
  });
  it("blocks dispatch when storage is unavailable or corrupt", async () => {
    const { values, storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    storage.setItem = () => { throw new Error("full"); };
    await expect(client.execute(commands[0])).rejects.toThrow(/not sent/);
    values.set("echelon:purchase-order-entry:v1:operator-a", "corrupt");
    await expect(client.execute(commands[0])).rejects.toThrow(/cannot be verified/); expect(fetch).not.toHaveBeenCalled(); expect(values.size).toBe(1);
  });
  it("keeps confirmed recovery when clearing storage fails", async () => {
    const { storage, store, client } = setup(); storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result(commands[0]))));
    await expect(client.execute(commands[0])).rejects.toThrow(/could not be cleared/); expect(store.read()).not.toBeNull();
  });
  it("isolates actor and pinned body and preserves a newer saved request", async () => {
    const { storage, store, client } = setup(); const saved = store.acquire(commands[0], () => "entry-key-1"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(createPurchaseOrderEntryRecoveryStore(() => storage, "operator-b").read()).toBeNull();
    await expect(client.execute(saved.body, { ...saved, userId: "operator-b" })).rejects.toThrow(/does not match/);
    await expect(client.execute(commands[1], saved)).rejects.toThrow(/does not match/);
    store.complete(saved.key); store.acquire(commands[1], () => "entry-key-2"); store.complete(saved.key);
    expect(store.read()?.key).toBe("entry-key-2"); expect(fetch).not.toHaveBeenCalled();
  });
  it("pins stale visible recovery to its original key even after another view confirmed it", async () => {
    const { store, client } = setup(); const saved = store.acquire(commands[0], () => "entry-key-1"); store.complete(saved.key);
    const fetch = vi.fn().mockResolvedValue(reply(result(commands[0]))); vi.stubGlobal("fetch", fetch);
    await client.execute(saved.body, saved); expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(saved.key);
  });
  it.each(["success", "rejection"])("retains %s arriving after actor or permission context changes", async outcome => {
    const { store } = setup(); let current = true;
    const client = createPurchaseOrderEntryClient(() => "entry-key-1", store, () => current);
    let release!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; })); vi.stubGlobal("fetch", fetch);
    const request = client.execute(commands[0]); const saved = store.read()!; current = false;
    release(outcome === "success" ? reply(result(commands[0])) : reply({ error: "Rejected", details: { purchaseOrderEntryOutcome: "rejected", ...result(commands[0]).entryCommand } }, 409));
    await expect(request).rejects.toThrow(); expect(store.read()).toEqual(saved);
    current = true; fetch.mockResolvedValueOnce(reply(result(commands[0])));
    await client.execute(saved.body, saved); expect(store.read()).toBeNull();
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
  });
  it("refuses to dispatch a callback whose actor context is already stale", async () => {
    const { store } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(createPurchaseOrderEntryClient(() => "entry-key-1", store, () => false).execute(commands[0])).rejects.toThrow(/operator or permission changed/);
    expect(fetch).not.toHaveBeenCalled(); expect(store.read()).toBeNull();
  });

});
