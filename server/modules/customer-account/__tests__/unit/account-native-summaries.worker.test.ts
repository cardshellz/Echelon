import { describe, expect, it, vi } from "vitest";
import { AccountNativeSummariesWorker } from "../../application/account-native-summaries.worker";
import type { AccountNativeCursor, AccountNativeFact, AccountNativeObservation } from "../../application/account-native-summaries.ports";
const now = new Date("2026-11-03T12:00:00Z");
const fact: AccountNativeFact = { channelId: 2, connectionId: 4, shopDomain: "fixture.myshopify.com", externalOrderId: "99", externalCustomerId: "100",
  orderReference: "#HISTORY", currency: "USD", totalCents: 741, financialStatus: "Paid", cancelled: false, sourceUpdatedAt: now.toISOString() };
const cursor: AccountNativeCursor = { connectionId: 4, channelId: 2, shopDomain: fact.shopDomain, leaseId: "00000000-0000-4000-8000-000000000001",
  backfillAfter: "199", backfillComplete: false, backfillDue: true, deltaSince: now, deltaAfter: "299", deltaStartedAt: now, deltaDue: true };
const observation: AccountNativeObservation = { facts: [fact], startedAt: now, finishedAt: now };
function fixture() {
  const store = { claim: vi.fn(async (): Promise<AccountNativeCursor | null> => cursor), claimOrders: vi.fn(async () => [{ externalOrderId: "99", generation: "1", attempts: 1, leaseId: cursor.leaseId }]),
    retain: vi.fn(async () => {}), completeOrders: vi.fn(async () => {}), completePage: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const provider = { byIds: vi.fn(async () => observation), page: vi.fn(async () => ({ observation, after: "399" })) };
  const report = vi.fn();
  return { store, provider, report, worker: new AccountNativeSummariesWorker({ store, provider, report, now: () => now, newId: () => cursor.leaseId }) };
}
describe("bounded native account maintenance", () => {
  it("reports a database claim failure before a lease exists and lets the scheduler retry", async () => {
    const h = fixture();
    const cause = Object.assign(new Error("private database details"), { code: "42P08" });
    h.store.claim.mockRejectedValueOnce(cause);
    await expect(h.worker.run()).rejects.toBe(cause);
    expect(h.report).toHaveBeenCalledWith({ code: "ACCOUNT_NATIVE_CLAIM_FAILED", outcome: "failed", causeCode: "42P08" });
    expect(h.store.release).not.toHaveBeenCalled();
    expect(h.provider.page).not.toHaveBeenCalled();
    await h.worker.run();
    expect(h.store.completePage).toHaveBeenCalledTimes(2);
  });
  it("refreshes current changes while historical warming is between its scheduled pages", async () => {
    const h=fixture();h.store.claim.mockResolvedValue({...cursor,backfillDue:false});await h.worker.run();
    expect(h.provider.page.mock.calls).toEqual([[4,"299",now]]);
  });
  it("retains an isolated bad purchase, reports it, and continues the other history work", async () => {
    const h=fixture(); h.provider.byIds.mockResolvedValue({ ...observation, facts: [], failures: [{ channelId: 2, connectionId: 4, shopDomain: fact.shopDomain,
      externalOrderId: "99", externalCustomerId: "100", sourceUpdatedAt: fact.sourceUpdatedAt, code: "ACCOUNT_NATIVE_SOURCE_INVALID" }] });
    await h.worker.run(); expect(h.store.completeOrders).toHaveBeenCalledOnce(); expect(h.store.completePage).toHaveBeenCalledTimes(2);
    expect(h.report).toHaveBeenCalledWith(expect.objectContaining({code:"ACCOUNT_NATIVE_SOURCE_RECORDS_UNAVAILABLE",causeCode:"ACCOUNT_NATIVE_SOURCE_INVALID"}));
    expect(h.store.release).toHaveBeenCalledWith(cursor,now,false);
  });
  it("fills cold owned orders before delta and historical pages, retaining facts before cursor checkpoints", async () => {
    const h = fixture(); await h.worker.run();
    expect(h.provider.byIds).toHaveBeenCalledWith(4, ["99"]);
    expect(h.provider.page.mock.calls).toEqual([[4, "299", now], [4, "199", null]]);
    expect(h.store.retain).toHaveBeenCalledTimes(3);
    expect(h.store.retain.mock.invocationCallOrder[1]).toBeLessThan(h.store.completePage.mock.invocationCallOrder[0]);
    expect(h.store.release).toHaveBeenCalledWith(cursor, now, false);
  });
  it("does no provider work when another worker owns the lease", async () => {
    const h = fixture(); h.store.claim.mockResolvedValue(null); await h.worker.run();
    expect(h.provider.byIds).not.toHaveBeenCalled(); expect(h.provider.page).not.toHaveBeenCalled(); expect(h.store.release).not.toHaveBeenCalled();
  });
  it("does not advance a cursor on provider failure, and retries the same cursor", async () => {
    const h = fixture(); h.provider.page.mockRejectedValueOnce(new Error("timeout")); await h.worker.run();
    expect(h.store.completePage).not.toHaveBeenCalled(); expect(h.store.release).toHaveBeenCalledWith(cursor, now, true);
    await h.worker.run(); expect(h.provider.page.mock.calls.slice(0, 2)).toEqual([[4, "299", now], [4, "299", now]]);
  });
  it("does not checkpoint facts that failed to persist", async () => {
    const h = fixture(); h.store.retain.mockRejectedValueOnce(new Error("database unavailable")); await h.worker.run();
    expect(h.store.completeOrders).not.toHaveBeenCalled(); expect(h.store.completePage).not.toHaveBeenCalled();
    expect(h.store.release).toHaveBeenCalledWith(cursor, now, true);
  });
  it("rejects provider results for a different shop, connection, channel or requested order", async () => {
    for (const altered of [{ shopDomain: "other.myshopify.com" }, { connectionId: 5 }, { channelId: 3 }, { externalOrderId: "101" }]) {
      const h = fixture(); h.provider.byIds.mockResolvedValue({ ...observation, facts: [{ ...fact, ...altered }] }); await h.worker.run();
      expect(h.store.retain).not.toHaveBeenCalled(); expect(h.store.completeOrders).not.toHaveBeenCalled();
      expect(h.store.release).toHaveBeenCalledWith(cursor, now, true);
    }
  });
  it("does not repeat a completed historical scan or poll a delta before its due time", async () => {
    const h = fixture(); h.store.claim.mockResolvedValue({ ...cursor, backfillComplete: true, deltaDue: false }); await h.worker.run();
    expect(h.provider.page).not.toHaveBeenCalled();
  });
});
