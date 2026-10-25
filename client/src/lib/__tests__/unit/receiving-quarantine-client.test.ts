import { beforeEach, describe, expect, it, vi } from "vitest";
import { acquireReceivingCustodyAttempt, createReceivingCustodyStore, executeReceivingCustodyAttempt } from "../../receiving-quarantine-client";
import { custodyTestIntake, custodyTestResult } from "@shared/procurement/__tests__/receiving-quarantine.fixture";

const key = "191a1c22-3537-47fb-a29a-bb0b7f59306f";
const storageKey = "receiving-custody-command:7";
const fetcher = vi.fn();
beforeEach(() => { vi.unstubAllGlobals(); vi.stubGlobal("fetch", fetcher); fetcher.mockReset(); vi.stubGlobal("crypto", { randomUUID: () => key }); });
function fixture() {
  const entries = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => entries.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { entries.set(key, value); }), removeItem: vi.fn((key: string) => { entries.delete(key); }) };
  const store = createReceivingCustodyStore(7, "operator", () => storage);
  const acquire = () => acquireReceivingCustodyAttempt(store, 7, null, "/api/receiving/7/quarantine", custodyTestIntake);
  const result = () => ({ ...custodyTestResult("intake", 7, custodyTestIntake, "operator"), command: "intake", resourceId: 7,
    actorId: "operator", idempotencyKey: key, request: custodyTestIntake });
  return { entries, storage, store, acquire, result };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
describe("quarantine saved command recovery", () => {
  it("retains one exact request through response loss and restores it from storage", async () => {
    const f = fixture(), saved = f.acquire();
    fetcher.mockRejectedValueOnce(new Error("lost")).mockResolvedValue(response(f.result()));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true });
    const restored = createReceivingCustodyStore(7, "operator", () => f.storage);
    expect(restored.read()).toEqual(saved);
    await executeReceivingCustodyAttempt(restored, restored.read()!);
    expect(f.store.read()).toBeNull(); expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
  });
  it.each([401, 403, 404, 409, 408, 429, 500, 503])("retains HTTP%s without a verified durable rejection", async status => {
    const f = fixture(), saved = f.acquire(); fetcher.mockResolvedValue(response({ error: "Try again", code: status === 409 ? "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" : "UNAVAILABLE" }, status));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.store.read()).toEqual(saved);
  });
  it("only clears a durable rejection for the exact actor, action, resource and key", async () => {
    const f = fixture(), saved = f.acquire();
    fetcher.mockResolvedValue(response({ error: "Source changed", details: { custodyCommandOutcome: "rejected", command: "intake", resourceId: 7, actorId: "operator", idempotencyKey: key } }, 409));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: false });
    expect(f.store.read()).toBeNull();
  });
  it.each([302, 429, 503])("retains a rejection marker on nonterminal HTTP%s", async status => {
    const f = fixture(), saved = f.acquire();
    fetcher.mockResolvedValue(response({ error: "Unconfirmed", details: { custodyCommandOutcome: "rejected", command: "intake", resourceId: 7, actorId: "operator", idempotencyKey: key } }, status));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.store.read()).toEqual(saved);
  });
  it.each(["actorId", "command", "resourceId", "idempotencyKey"])("retains rejection with mismatched %s", async field => {
    const f = fixture(), saved = f.acquire(); const identity = { custodyCommandOutcome: "rejected", command: "intake", resourceId: 7, actorId: "operator", idempotencyKey: key, [field]: "different" };
    fetcher.mockResolvedValue(response({ error: "Rejected", details: identity }, 409));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true }); expect(f.store.read()).toEqual(saved);
  });
  it.each(["actorId", "resourceId", "idempotencyKey", "request", "quantity", "source", "condition"])("retains a plausible success with wrong %s", async field => {
    const f = fixture(), saved = f.acquire(), result = f.result();
    if (field === "quantity") result.observation.observedQty++;
    else if (field === "source") result.observation.receivingOrderId++;
    else if (field === "condition") result.observation.condition = "damaged";
    else Object.assign(result, { [field]: field === "resourceId" ? 8 : field === "request" ? { ...custodyTestIntake, quantity: 3 } : "different" });
    fetcher.mockResolvedValue(response(result));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true }); expect(f.store.read()).toEqual(saved);
  });
  it("blocks another operator before dispatch and preserves the original request", async () => {
    const f = fixture(), saved = f.acquire(); const other = createReceivingCustodyStore(7, "another", () => f.storage);
    expect(() => other.read()).toThrow(/another operator/);
    await expect(executeReceivingCustodyAttempt(other, saved)).rejects.toThrow(/original operator/);
    expect(fetcher).not.toHaveBeenCalled(); expect(f.store.read()).toEqual(saved);
  });
  it("does not adopt a legacy attempt without actor evidence", () => {
    const f = fixture(); f.entries.set(storageKey, JSON.stringify({ receiptId: 7, observationId: null, path: "/api/receiving/7/quarantine", key, body: custodyTestIntake }));
    expect(() => f.acquire()).toThrow(/legacy evidence/); expect(fetcher).not.toHaveBeenCalled(); expect(f.entries.has(storageKey)).toBe(true);
  });
  it("blocks replacing an unresolved payload and failed storage writes", () => {
    const f = fixture(); f.acquire();
    expect(() => acquireReceivingCustodyAttempt(f.store, 7, null, "/api/receiving/7/quarantine", { ...custodyTestIntake, quantity: 3 })).toThrow(/unresolved/);
    const another = fixture(); another.storage.setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(() => another.acquire()).toThrow(/not sent/); expect(fetcher).not.toHaveBeenCalled();
  });
  it("retains a verified result when removing its saved request fails", async () => {
    const f = fixture(), saved = f.acquire(); f.storage.removeItem.mockImplementation(() => { throw new Error("denied"); }); fetcher.mockResolvedValue(response(f.result()));
    await expect(executeReceivingCustodyAttempt(f.store, saved)).rejects.toMatchObject({ outcomeUnknown: true }); expect(f.store.read()).toEqual(saved);
  });
});
