import { afterEach, describe, expect, it, vi } from "vitest";
import { createPurchaseApprovalClient, createPurchaseApprovalRecoveryStore } from "../../purchase-approval-command";
const body = { purchaseOrderId: 31, expectedUpdatedAt: "2026-10-23T12:00:00.000Z", expectedTotalCents: 10000, expectedLinesFingerprint: "a".repeat(64) };
const result = { id: 31, status: "approved", approvedBy: "operator-a", totalCents: 10000, updatedAt: "2026-10-23T12:01:00.000Z", reviewedUpdatedAt: body.expectedUpdatedAt, reviewedLinesFingerprint: body.expectedLinesFingerprint, approvalCommand: { name: "procurement.purchase_order.approve", idempotencyKey: "approval-key-1" } };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createPurchaseApprovalRecoveryStore(() => storage, "operator-a");
  const client = createPurchaseApprovalClient(() => "approval-key-1", store);
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());
describe("review-bound durable purchase approval", () => {
  it("persists the exact reviewed terms before dispatch and validates the matching result", async () => {
    const { store, client } = setup();
    const fetch = vi.fn(async (url, init) => {
      expect(url).toBe("/api/purchase-orders/31/approve");
      expect(store.read()?.body).toEqual(body);
      expect(JSON.parse(init.body)).toEqual({ expectedUpdatedAt: body.expectedUpdatedAt, expectedTotalCents: 10000, expectedLinesFingerprint: body.expectedLinesFingerprint });
      expect(init.headers["Idempotency-Key"]).toBe(store.read()?.key);
      return reply(result);
    });
    vi.stubGlobal("fetch", fetch);
    expect(await client.execute(body)).toEqual(result);
    expect(store.read()).toBeNull();
  });
  it("recovers the same key and original review after response loss and a reload", async () => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(reply(result));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body)).rejects.toThrow();
    const saved = store.read()!;
    const reloaded = createPurchaseApprovalRecoveryStore(() => storage, "operator-a");
    await createPurchaseApprovalClient(() => "must-not-rotate", reloaded).execute(saved.body, saved);
    expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(reloaded.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 422, 429, 500, 503])("retains unknown HTTP %i outcome and refuses a changed PO or review", async status => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValue(reply({ error: "unconfirmed" }, status));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body)).rejects.toThrow();
    await expect(client.execute({ ...body, purchaseOrderId: 32 })).rejects.toThrow(/unresolved/);
    await expect(client.execute({ ...body, expectedTotalCents: 100000 })).rejects.toThrow(/unresolved/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(store.read()?.body).toEqual(body);
  });
  it("clears only a durable rejection for the original key", async () => {
    const { store, client } = setup();
    const fetch = vi.fn().mockResolvedValueOnce(reply({ error: "stale", details: { purchaseApprovalOutcome: "rejected", idempotencyKey: "different-key" } }, 409))
      .mockResolvedValueOnce(reply({ error: "stale", details: { purchaseApprovalOutcome: "rejected", idempotencyKey: "approval-key-1" } }, 409));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(body)).rejects.toThrow("stale");
    expect(store.read()).not.toBeNull();
    await expect(client.execute(body)).rejects.toThrow("stale");
    expect(store.read()).toBeNull();
  });
  it.each([{}, { ...result, id: 99 }, { ...result, approvedBy: "other" }, { ...result, totalCents: 100000 }, { ...result, reviewedUpdatedAt: result.updatedAt }, { ...result, status: "pending_approval" }, { ...result, approvalCommand: { ...result.approvalCommand, idempotencyKey: "different-key" } }])("keeps malformed or mismatched success recoverable: %j", async response => {
    const { store, client } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(body)).rejects.toThrow(/could not be verified/);
    expect(store.read()?.body).toEqual(body);
  });
  it("refuses invalid totals and unavailable storage before any network write", async () => {
    const { storage, client } = setup();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...body, expectedTotalCents: 1.5 })).rejects.toThrow();
    storage.setItem = () => { throw new Error("full"); };
    await expect(client.execute(body)).rejects.toThrow(/not sent/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains corrupt storage and rejects a different actor's pinned recovery", async () => {
    const { values, store, client } = setup();
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const saved = store.acquire(body, () => "original-key");
    await expect(client.execute(body, { ...saved, userId: "other" })).rejects.toThrow(/does not match/);
    values.set("echelon:purchase-approval:v1:operator-a", "broken");
    await expect(client.execute(body)).rejects.toThrow(/cannot be verified/);
    expect(values.get("echelon:purchase-approval:v1:operator-a")).toBe("broken");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains recovery if confirmed success cannot clear storage", async () => {
    const { storage, store, client } = setup();
    storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(result)));
    await expect(client.execute(body)).rejects.toThrow(/could not be cleared/);
    expect(store.read()?.key).toBe("approval-key-1");
  });
  it("isolates actors and prevents a late result from clearing a newer saved command", () => {
    const { storage, store } = setup();
    store.acquire(body, () => "original-key");
    expect(createPurchaseApprovalRecoveryStore(() => storage, "operator-b").read()).toBeNull();
    store.complete("original-key");
    store.acquire({ ...body, purchaseOrderId: 32 }, () => "newer-key");
    store.complete("original-key");
    expect(store.read()?.key).toBe("newer-key");
  });
});
