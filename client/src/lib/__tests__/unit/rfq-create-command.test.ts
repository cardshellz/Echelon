import { afterEach, describe, expect, it, vi } from "vitest";
import { createRfqCommandClient, createRfqRecoveryStore } from "../../rfq-command";
import { rfqCreateIntent, rfqCreateReceipt } from "../../../../../test/fixtures/rfq-create-command";
import { rfqCreateIntentSchema, type RfqCreateIntent } from "@shared/procurement/rfq-create-command";
import { rfqIntents, rfqReceipt } from "../fixtures/rfq-command";

const key = "rfq-create-request-1";
function setup() {
  const values = new Map<string, string>();
  const storage = { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
  const store = createRfqRecoveryStore(() => storage, "operator-a");
  const state = { allowed: true };
  const client = createRfqCommandClient(() => key, store, { canExecute: () => state.allowed });
  return { values, storage, store, client, state };
}
function response(body: unknown, status = 201) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
afterEach(() => vi.unstubAllGlobals());

describe("initial RFQ batch recovery through the shared workflow client", () => {
  it("persists before dispatch and exactly replays after reload, independent of current demand", async () => {
    const { store, storage, client } = setup();
    const fetch = vi.fn().mockImplementationOnce(async () => { expect(store.read()?.body).toEqual(rfqCreateIntent); throw new TypeError("response lost"); })
      .mockResolvedValue(response(rfqCreateReceipt(rfqCreateIntent, key)));
    vi.stubGlobal("fetch", fetch);
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow();
    const saved = store.read()!;
    const reloaded = createRfqCommandClient(() => "must-not-be-used", createRfqRecoveryStore(() => storage, "operator-a"), { canExecute: () => true });
    await expect(reloaded.execute({ ...rfqCreateIntent, payload: { ...rfqCreateIntent.payload, lines: [{ ...rfqCreateIntent.payload.lines[0], requestedPieces: 50 }] } })).rejects.toThrow(/unresolved/);
    await reloaded.execute(saved.body, saved);
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1]).toEqual(fetch.mock.calls[0]);
    expect(fetch.mock.calls[0][0]).toBe("/api/purchasing/rfq-queue"); expect(store.read()).toBeNull();
  });
  it.each(["missing", "actor", "key", "supplier", "pieces", "line", "extra", "request", "creator"])("retains malformed %s success evidence", async fault => {
    const { store, client } = setup(); const receipt = rfqCreateReceipt(rfqCreateIntent, key); let result: unknown = receipt;
    if (fault === "missing") result = {};
    if (fault === "actor") receipt.actorId = "operator-b";
    if (fault === "key") receipt.idempotencyKey = "wrong-key";
    if (fault === "supplier") receipt.result.rfqs[0].vendorId = 3;
    if (fault === "pieces") receipt.result.lines[0].requestedPieces = 99;
    if (fault === "line") receipt.result.lines[0].recommendationLineId = 900;
    if (fault === "extra") receipt.result.lines.push({ ...receipt.result.lines[0], id: 999 });
    if (fault === "request") receipt.intent = { ...rfqCreateIntent, payload: { ...rfqCreateIntent.payload, requestNote: "another review" } };
    if (fault === "creator") receipt.result.rfqs[0].createdBy = "operator-b";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(result)));
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(/could not be verified/); expect(store.read()).not.toBeNull();
  });
  it.each([400, 401, 403, 409, 422, 500, 503])("retains unproven HTTP %i rejection", async status => {
    const { store, client } = setup(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "RFQ_IDEMPOTENCY_CONFLICT", error: "Retain original request" }, status)));
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(); expect(store.read()).not.toBeNull();
  });
  it("clears only matching durable rejection so current demand can be reviewed for a new batch", async () => {
    const { store, client } = setup(); const details = { rfqCommandOutcome: "rejected", actorId: "operator-a", idempotencyKey: key, intent: rfqCreateIntent };
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: "changed", details: { ...details, idempotencyKey: "wrong-key" } }, 409))
      .mockResolvedValueOnce(response({ error: "changed", details }, 409)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(); const saved = store.read()!;
    await expect(client.execute(saved.body, saved)).rejects.toThrow(); expect(store.read()).toBeNull();
  });
  it.each(["read", "save", "corrupt"])("does not dispatch when storage %s fails", async fault => {
    const { values, storage, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    if (fault === "read") storage.getItem = () => { throw new Error("blocked"); };
    if (fault === "save") storage.setItem = () => { throw new Error("blocked"); };
    if (fault === "corrupt") values.set("echelon:rfq-workflow:v1", "invalid");
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains confirmed intent if storage clearing fails", async () => {
    const { store, storage, client } = setup(); storage.removeItem = () => { throw new Error("blocked"); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(rfqCreateReceipt(rfqCreateIntent, key))));
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(/could not be cleared/); expect(store.read()).not.toBeNull();
  });
  it("does not disclose or clear a different operator's saved batch", async () => {
    const { store, storage } = setup(); store.acquire(rfqCreateIntent, () => key); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const other = createRfqCommandClient(() => "another-key", createRfqRecoveryStore(() => storage, "operator-b"), { canExecute: () => true });
    await expect(other.execute(rfqCreateIntent)).rejects.toThrow(/another operator/); expect(store.read()).not.toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("retains creation after authority changes while its response is in flight", async () => {
    const { store, state, client } = setup(); vi.stubGlobal("fetch", vi.fn(async () => { state.allowed = false; return response(rfqCreateReceipt(rfqCreateIntent, key)); }));
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(/permission/); expect(store.read()).not.toBeNull();
  });
  it("keeps existing v1 workflow recovery readable and mutually exclusive with creation", async () => {
    const { store, client } = setup(); const saved = store.acquire(rfqIntents[0], () => "rfq-request-1");
    const fetch = vi.fn().mockResolvedValue(response(rfqReceipt(rfqIntents[0]), 200)); vi.stubGlobal("fetch", fetch);
    await expect(client.execute(rfqCreateIntent)).rejects.toThrow(/unresolved/);
    await client.execute(saved.body, saved); expect(store.read()).toBeNull();
  });
  it.each([0, -1, 0.5, 2147483648, Number.MAX_SAFE_INTEGER])("rejects invalid requested pieces %s before storage", async requestedPieces => {
    const { store, client } = setup(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(client.execute({ ...rfqCreateIntent, payload: { lines: [{ ...rfqCreateIntent.payload.lines[0], requestedPieces }] } })).rejects.toThrow();
    expect(store.read()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects duplicate supplier recommendations and impossible dates", () => {
    expect(rfqCreateIntentSchema.safeParse({ ...rfqCreateIntent, payload: { lines: [rfqCreateIntent.payload.lines[0], rfqCreateIntent.payload.lines[0]] } }).success).toBe(false);
    expect(rfqCreateIntentSchema.safeParse({ ...rfqCreateIntent, payload: { ...rfqCreateIntent.payload, responseDueDate: "2026-02-30" } } as RfqCreateIntent).success).toBe(false);
  });
});
