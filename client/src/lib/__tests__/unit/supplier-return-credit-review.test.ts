import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupplierReturnClient, createSupplierReturnRecoveryStore, type SupplierReturnIntent } from "../../supplier-return-command";
import { returnCreditReview, returnCreditReviewRequest, returnCreditReviewResult, returnPreview, returnRequest } from "../../../../../test/fixtures/supplier-return";
const reviewIntent = (): SupplierReturnIntent => ({ command: "review_credit_difference", entitlementId: 111, payload: returnCreditReviewRequest(), reviewed: returnCreditReview() });
const physicalIntent = (): SupplierReturnIntent => ({ command: "record", payload: returnRequest(), reviewed: returnPreview() });
function setup() { const values = new Map<string, string>(); const memory = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } }; const store = createSupplierReturnRecoveryStore(() => memory, "ap-reader"); return { memory, store, client: createSupplierReturnClient(() => "review-key-1", store) }; }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());
describe("supplier return credit review durable receipts", () => {
  it("confirms immutable attribution while leaving a real shortfall unresolved", async () => { const { client, store } = setup(); const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => json(returnCreditReviewResult())); vi.stubGlobal("fetch", fetch); const result = await client.execute(reviewIntent()); expect(result.command).toBe("review_credit_difference"); if (result.command === "review_credit_difference") expect(result.review.differences.totalMills).toBe(2000); expect(store.read()).toBeNull(); expect(fetch.mock.calls[0][0]).toBe("/api/supplier-return-entitlements/111/review"); });
  it("shares an unresolved gate with physical record commands", async () => { const { client, store } = setup(); store.acquire(physicalIntent(), () => "physical-key"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await expect(client.execute(reviewIntent())).rejects.toThrow("unresolved"); expect(fetch).not.toHaveBeenCalled(); });
  it("blocks a physical return while a credit review is uncertain", async () => { const { client, store } = setup(); store.acquire(reviewIntent(), () => "review-key-1"); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch); await expect(client.execute(physicalIntent())).rejects.toThrow("unresolved"); expect(fetch).not.toHaveBeenCalled(); });
  it("retains review through reload and wrong operator, then replays its exact key", async () => { const { client, store, memory } = setup(); vi.stubGlobal("fetch", vi.fn(async () => { throw Error("Lost reply"); })); await expect(client.execute(reviewIntent())).rejects.toThrow(); const saved = store.read()!; const other = createSupplierReturnRecoveryStore(() => memory, "other"); expect(() => other.read()).toThrow("another operator"); const restored = createSupplierReturnRecoveryStore(() => memory, "ap-reader"); vi.stubGlobal("fetch", vi.fn(async () => json(returnCreditReviewResult()))); await createSupplierReturnClient(() => "new-key", restored).execute(saved.body, saved); expect(restored.read()).toBeNull(); });
  const changes: Array<[string, (result: ReturnType<typeof returnCreditReviewResult>) => void]> = [
    ["actor", result => { result.actorId = "other"; }], ["key", result => { result.idempotencyKey = "other-key"; }], ["entitlement", result => { result.entitlementId = 112; }],
    ["request", result => { result.request.reason = "Changed evidence"; }], ["immutable actor", result => { result.review.latestReview!.recordedBy = "other"; }],
    ["version", result => { result.review.version = result.request.expectedVersion; }], ["current evidence", result => { result.review.reviewCurrent = false; }],
    ["return", result => { result.review.returnId = 8; }], ["quantity", result => { result.review.quantity = 3; }], ["credit amount", result => { result.review.creditLinks[0].amountCents++; }],
    ["cost value", result => { result.review.currentCosts.productMills++; result.review.currentCosts.totalMills++; }],
    ["history", result => { result.review.reviewHistory = []; }], ["duplicate history", result => { result.review.reviewHistory.push(result.review.latestReview!); }],
  ];
  it.each(changes)("retains malformed %s evidence", async (_name, change) => { const { client, store } = setup(); const result = returnCreditReviewResult(); change(result); vi.stubGlobal("fetch", vi.fn(async () => json(result))); await expect(client.execute(reviewIntent())).rejects.toThrow("could not be verified"); expect(store.read()).not.toBeNull(); });
  it.each(["removed", "changed"])("retains recovery when prior review history is %s", async change => {
    const { client, store } = setup();
    const before = returnCreditReviewResult().review;
    const payload = { ...returnCreditReviewRequest(), expectedVersion: before.version };
    const result = returnCreditReviewResult(payload, before);
    if (change === "removed") result.review.reviewHistory.shift();
    else result.review.reviewHistory[0].reason = "Rewritten historical evidence";
    vi.stubGlobal("fetch", vi.fn(async () => json(result)));
    await expect(client.execute({ command: "review_credit_difference", entitlementId: before.entitlementId, payload, reviewed: before })).rejects.toThrow("could not be verified");
    expect(store.read()).not.toBeNull();
  });
  it.each([{ status: 409, entitlementId: 111, clear: true }, { status: 503, entitlementId: 111, clear: false }, { status: 409, entitlementId: 112, clear: false }])("requires durable rejection matching the entitlement: %j", async ({ status, entitlementId, clear }) => { const { client, store } = setup(); vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Source changed", details: { supplierReturnCommandOutcome: "rejected", command: "review_credit_difference", actorId: "ap-reader", idempotencyKey: "review-key-1", entitlementId } }, status))); await expect(client.execute(reviewIntent())).rejects.toThrow(); expect(store.read() === null).toBe(clear); });
});
