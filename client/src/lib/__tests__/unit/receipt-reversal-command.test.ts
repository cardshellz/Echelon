import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReceiptReversalLineTarget, createReceiptReversalClient, createReceiptReversalRecoveryStore, type ReceiptReversalCommand } from "../../receipt-reversal-command";

const command: ReceiptReversalCommand = { action: "line", targetId: 7, receivingOrderId: 31, payload: { qty: 2, reason: "Incorrect receipt count", allowNegative: false } };
const lineResult = { reversalId: 61, receivingLineId: 7, receivingOrderId: 31, qty: 2, baseUnitsReversed: 20, lotUnitCostMills: 250, apReconciliationReopened: true, idempotentReplay: false };
const result = { ...lineResult, action: "line", targetId: 7, actorId: "operator-a", idempotencyKey: "reversal-key-1" };
const order: ReceiptReversalCommand = { action: "order", targetId: 31, receivingOrderId: 31, payload: { reason: "Incorrect receipt", allowNegative: true } };
const orderResult = { action: "order", targetId: 31, receivingOrderId: 31, actorId: "operator-a", idempotencyKey: "reversal-key-1", reversals: [lineResult], poStatusUpdate: null };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createReceiptReversalRecoveryStore(() => storage, "operator-a");
  let sequence = 0;
  const client = createReceiptReversalClient(() => `reversal-key-${++sequence}`, store);
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());
describe("persisted receipt reversal client", () => {
  it.each([[command, result, "/api/procurement/receiving-lines/7/reverse"], [order, orderResult, "/api/procurement/receiving-orders/31/reverse"]] as const)("persists identity and exact intent before sending %j", async (input, response, path) => {
    const { store, client } = setup();
    const fetch = vi.fn(async (url, init) => {
      expect(store.read()?.body).toEqual(input);
      expect(url).toBe(path); expect(JSON.parse(init.body)).toEqual(input.payload);
      expect(init.headers["Idempotency-Key"]).toBe(store.read()?.key);
      return reply(response);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await client.execute(input)).toEqual(response); expect(store.read()).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("retains exact request after response loss, reload and manual retry", async () => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce(reply(result)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(command)).rejects.toThrow();
    const saved = store.read()!;
    const reloaded = createReceiptReversalRecoveryStore(() => storage, "operator-a");
    await createReceiptReversalClient(() => "must-not-rotate", reloaded).execute(saved.body, saved);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]); expect(reloaded.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 429, 500, 503])("retains ambiguous HTTP %i and blocks changed line/order intent", async status => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error: "Unconfirmed" }, status)));
    await expect(client.execute(command)).rejects.toThrow(); expect(store.read()?.body).toEqual(command);
    await expect(client.execute(order)).rejects.toThrow(/unresolved/);
  });
  it("clears only a matching durable rejection", async () => {
    const { store, client } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ error: "Consumed", details: { receiptReversalOutcome: "rejected", idempotencyKey: "other-key" } }, 409))
      .mockResolvedValueOnce(reply({ error: "Consumed", details: { receiptReversalOutcome: "rejected", idempotencyKey: "reversal-key-1" } }, 409)));
    await expect(client.execute(command)).rejects.toThrow("Consumed"); expect(store.read()).not.toBeNull();
    await expect(client.execute(command)).rejects.toThrow("Consumed"); expect(store.read()).toBeNull();
  });
  it.each([
    {}, { ...result, actorId: "operator-b" }, { ...result, targetId: 9 }, { ...result, receivingOrderId: 99 },
    { ...result, qty: 1 }, { ...result, idempotencyKey: "other-key" }, { ...result, baseUnitsReversed: 1.5 },
    { ...result, reversalId: 0 }, { ...result, error: "Not reversed" }, orderResult,
  ])("retains saved request for malformed or mismatched success %j", async response => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(command)).rejects.toThrow(/could not be verified/); expect(store.read()?.body).toEqual(command);
  });
  it.each([
    { ...orderResult, reversals: [] }, { ...orderResult, reversals: [lineResult, lineResult] },
    { ...orderResult, reversals: [{ ...lineResult, receivingOrderId: 99 }] },
  ])("rejects invalid full-receipt evidence %j", async response => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(order)).rejects.toThrow(/could not be verified/); expect(store.read()?.body).toEqual(order);
  });
  it("does not send invalid inputs or requests that cannot be saved", async () => {
    const { storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...command, payload: { ...command.payload, qty: 0 } })).rejects.toThrow();
    storage.setItem = () => { throw new Error("full"); };
    await expect(client.execute(command)).rejects.toThrow(/not sent/); expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves corrupt evidence without sending or deleting it", async () => {
    const { values, store, client } = setup(); values.set("echelon:receipt-reversal:v1:operator-a", "broken");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect(() => store.read()).toThrow(/cannot be verified/); await expect(client.execute(command)).rejects.toThrow(/cannot be verified/);
    expect(values.size).toBe(1); expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the saved command when verified success cannot clear storage", async () => {
    const { storage, store, client } = setup(); storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result)));
    await expect(client.execute(command)).rejects.toThrow(/could not be cleared/); expect(store.read()?.key).toBe("reversal-key-1");
  });
  it("pins a visible recovery card after a late successful reply clears storage", async () => {
    const { store, client } = setup(); const saved = store.acquire(command, () => "reversal-key-1"); store.complete(saved.key);
    const fetch = vi.fn().mockResolvedValue(reply(result)); vi.stubGlobal("fetch", fetch);
    await client.execute(saved.body, saved); expect(fetch.mock.calls[0][1].headers["Idempotency-Key"]).toBe(saved.key);
  });
  it("rejects a changed pinned operator or payload before dispatch", async () => {
    const { store, client } = setup(); const saved = store.acquire(command, () => "reversal-key-1"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(command, { ...saved, userId: "other" })).rejects.toThrow(/does not match/);
    await expect(client.execute(order, saved)).rejects.toThrow(/does not match/); expect(fetch).not.toHaveBeenCalled();
  });
  it("isolates operators and does not clear a newer request", () => {
    const { storage, store } = setup(); store.acquire(command, () => "reversal-key-1");
    expect(createReceiptReversalRecoveryStore(() => storage, "operator-b").read()).toBeNull();
    store.complete("reversal-key-1"); store.acquire(order, () => "reversal-key-2"); store.complete("reversal-key-1");
    expect(store.read()?.key).toBe("reversal-key-2");
  });
});

describe("reviewed reversal source identity", () => {
  it.each([[], [{ id: 7, receivingOrderId: 99 }], [{ id: 7, receivingOrderId: 31 }, { id: 7, receivingOrderId: 31 }]].map(lines => ({ lines })))("rejects missing, foreign or duplicate line identity $lines", ({ lines }) => {
    expect(() => assertReceiptReversalLineTarget(31, 7, lines)).toThrow(/ownership could not be verified/);
  });
  it("accepts exactly one line from the displayed receipt", () => {
    expect(() => assertReceiptReversalLineTarget(31, 7, [{ id: 7, receivingOrderId: 31 }])).not.toThrow();
  });
});
