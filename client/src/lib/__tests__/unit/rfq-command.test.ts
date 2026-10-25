import { afterEach, describe, expect, it, vi } from "vitest";
import { createRfqCommandClient, createRfqRecoveryStore } from "../../rfq-command";
import { rfqIntents, rfqReceipt } from "../fixtures/rfq-command";
import type { RfqCommandIntent } from "@shared/procurement/rfq-command";
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup(options: { canExecute?: () => boolean; changed?: () => void } = {}) {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const store = createRfqRecoveryStore(() => storage, "operator-a");
  const client = createRfqCommandClient(() => "rfq-request-1", store, { canExecute: options.canExecute ?? (() => true), changed: options.changed });
  return { values, storage, store, client };
}
afterEach(() => vi.unstubAllGlobals());
describe("RFQ immutable request recovery", () => {
  it.each(rfqIntents)("saves $operation before dispatch and validates its exact receipt", async intent => {
    const { store, client } = setup();
    const fetch = vi.fn(async (url, init) => {
      expect(store.read()?.body).toEqual(intent); expect(JSON.parse(init.body)).toEqual(intent.payload);
      expect(init.headers).toMatchObject({ "Idempotency-Key": "rfq-request-1", "X-RFQ-Receipt-Version": "1" });
      expect(url).toBe(intent.operation === "capture_quote" ? "/api/purchasing/rfqs/42/lines/9/quotes" : `/api/purchasing/rfqs/42/${intent.operation}`);
      return reply(rfqReceipt(intent));
    }); vi.stubGlobal("fetch", fetch);
    expect(await client.execute(intent)).toEqual(rfqReceipt(intent)); expect(store.read()).toBeNull();
  });
  it.each(rfqIntents)("preserves $operation after lost success, reload and authentication refusal", async intent => {
    const { storage, store, client } = setup();
    const fetch = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce(reply({ error: "Sign in" }, 401)).mockResolvedValueOnce(reply(rfqReceipt(intent)));
    vi.stubGlobal("fetch", fetch); await expect(client.execute(intent)).rejects.toThrow(); const saved = store.read()!;
    const reloaded = createRfqRecoveryStore(() => storage, "operator-a");
    const recovered = createRfqCommandClient(() => "must-not-rotate", reloaded, { canExecute: () => true });
    await expect(recovered.execute(saved.body, saved)).rejects.toThrow(); expect(reloaded.read()).toEqual(saved);
    await recovered.execute(saved.body, saved); expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]); expect(fetch.mock.calls[2]).toEqual(fetch.mock.calls[0]);
    expect(reloaded.read()).toBeNull();
  });
  it.each([401, 403, 404, 409, 429, 500, 503])("retains HTTP %i without durable rejection proof", async status => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error: "Unavailable" }, status)));
    await expect(client.execute(rfqIntents[0])).rejects.toThrow(); expect(store.read()?.body).toEqual(rfqIntents[0]);
    await expect(client.execute(rfqIntents[1])).rejects.toThrow(/unresolved/);
  });
  it.each(["actor", "key", "rfq", "operation", "payload", "economics", "legacy", "missing"])("retains an unverified %s receipt", async fault => {
    const intent = rfqIntents[0]; const result = rfqReceipt(intent); let response: unknown = result;
    if (fault === "actor") result.actorId = "operator-b";
    if (fault === "key") result.idempotencyKey = "wrong-key";
    if (fault === "rfq") result.intent = { ...intent, rfqId: 43 };
    if (fault === "operation") result.intent = rfqIntents[1];
    if (fault === "payload" && intent.operation === "capture_quote") result.intent = { ...intent, payload: { ...intent.payload, expectedVersion: "d".repeat(64) } };
    if (fault === "economics" && "lines" in result.result && "id" in result.result) result.result.lines[0].latestQuote!.quotedUnitCostMills = 1;
    if (fault === "legacy") response = result.result;
    if (fault === "missing") response = {};
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(response)));
    await expect(client.execute(intent)).rejects.toThrow(/could not be verified/); expect(store.read()?.body).toEqual(intent);
  });
  it("clears only an exact durable rejection and preserves the original payload version", async () => {
    const intent = rfqIntents[1]; const { store, client } = setup();
    const details = { rfqCommandOutcome: "rejected", actorId: "operator-a", idempotencyKey: "rfq-request-1", intent };
    const fetch = vi.fn().mockResolvedValueOnce(reply({ error: "Conflict", details: { ...details, actorId: "operator-b" } }, 409))
      .mockResolvedValueOnce(reply({ error: "Conflict", details: { ...details, intent: rfqIntents[0] } }, 409))
      .mockResolvedValueOnce(reply({ error: "Conflict", details }, 409)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(intent)).rejects.toThrow(); const saved = store.read()!;
    await expect(client.execute(intent, saved)).rejects.toThrow(); expect(store.read()).toEqual(saved);
    await expect(client.execute(intent, saved)).rejects.toThrow(); expect(store.read()).toBeNull();
  });
  it("prevents a second panel from replacing the original RFQ or action", async () => {
    const { storage, store, client } = setup(); const intent = rfqIntents[0]; const saved = store.acquire(intent, () => "rfq-request-1");
    const other = createRfqCommandClient(() => "different-key", createRfqRecoveryStore(() => storage, "operator-a"), { canExecute: () => true });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(reply(rfqReceipt(intent)))); vi.stubGlobal("fetch", fetch);
    await expect(other.execute({ ...intent, rfqId: 43 })).rejects.toThrow(/unresolved/);
    await expect(other.execute(rfqIntents[1])).rejects.toThrow(/unresolved/); expect(fetch).not.toHaveBeenCalled();
    await other.execute(intent, saved); expect(store.read()).toBeNull(); await client.execute(intent, saved);
    expect(fetch.mock.calls[0]).toEqual(fetch.mock.calls[1]);
  });
  it("refuses a different operator or mismatched pinned action without deleting evidence", async () => {
    const { storage, store, client } = setup(); const saved = store.acquire(rfqIntents[0], () => "rfq-request-1");
    const other = createRfqCommandClient(() => "wrong-key", createRfqRecoveryStore(() => storage, "operator-b"), { canExecute: () => true });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(other.execute(rfqIntents[0])).rejects.toThrow(/another operator/);
    await expect(client.execute(rfqIntents[1], saved)).rejects.toThrow(/another operator or action/);
    expect(store.read()).toEqual(saved); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["read", "save", "corrupt"])("fails closed on storage %s", async fault => {
    const { storage, values, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    if (fault === "read") storage.getItem = () => { throw new Error("denied"); };
    if (fault === "save") storage.setItem = () => { throw new Error("full"); };
    if (fault === "corrupt") values.set("echelon:rfq-workflow:v1", "broken");
    await expect(client.execute(rfqIntents[0])).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    if (fault === "corrupt") expect(values.get("echelon:rfq-workflow:v1")).toBe("broken");
  });
  it("retains confirmed evidence when storage removal fails", async () => {
    const { storage, store, client } = setup(); storage.removeItem = () => { throw new Error("denied"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(rfqReceipt(rfqIntents[0]))));
    await expect(client.execute(rfqIntents[0])).rejects.toThrow(/could not be cleared/); expect(store.read()).not.toBeNull();
  });
  it("checks permission before acquiring and immediately before dispatch", async () => {
    let allowed = false; const { store, client } = setup({ canExecute: () => allowed, changed: () => { allowed = false; } });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await expect(client.execute(rfqIntents[0])).rejects.toThrow(/permission/); expect(store.read()).toBeNull();
    allowed = true; await expect(client.execute(rfqIntents[0])).rejects.toThrow(/permission/); expect(store.read()).not.toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains an old actor's late response after authority changes", async () => {
    let allowed = true; const { store, client } = setup({ canExecute: () => allowed });
    vi.stubGlobal("fetch", vi.fn(async () => { allowed = false; return reply(rfqReceipt(rfqIntents[0])); }));
    await expect(client.execute(rfqIntents[0])).rejects.toThrow(/permission/); expect(store.read()).not.toBeNull();
  });
  it("rejects invalid command payloads before saving or dispatch", async () => {
    const { store, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...rfqIntents[0], rfqId: 0 } as RfqCommandIntent)).rejects.toThrow(); expect(store.read()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
});
