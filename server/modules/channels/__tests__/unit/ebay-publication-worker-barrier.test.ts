import { describe, expect, it, vi } from "vitest";
import { EbayListingSyncService, type EbayListingSyncStore, type EbayListingSyncExecution } from "../../ebay-listing-sync.service";
import { EbayListingSyncError, storedEbayListingSyncJobSchema } from "../../ebay-listing-sync.domain";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

const uuid = "f52374be-d3aa-4542-a83c-127285c582db";
function fixture() {
  const job = storedEbayListingSyncJobSchema.parse({ id: uuid, productId: 20, operation: "publish", state: "running", code: null, message: null,
    nextAttemptAt: "2026-10-11T20:00:00Z", updatedAt: "2026-10-11T20:00:00Z", identity: syncIdentity,
    revision: "1", claimedRevision: "1", ownerToken: uuid, attempts: 10, result: null, verificationIntentHash: null, verificationRevision: null });
  const finish = vi.fn(); const release = vi.fn(); const stage = vi.fn();
  const store = { claim: vi.fn().mockResolvedValueOnce({ job, release }), stage, finish,
    bindPublicationAccepted: vi.fn(), bindPublicationTarget: vi.fn(), bindProviderIdentity: vi.fn() } as unknown as EbayListingSyncStore;
  const execute = vi.fn<EbayListingSyncExecution["execute"]>();
  const service = new EbayListingSyncService(store, { execute }, () => new Date("2026-10-11T20:00:00Z"), () => uuid);
  return { job, finish, release, stage, execute, service };
}
describe("durable publication barriers survive worker errors", () => {
  it("retains an interrupted publish even after the ordinary retry limit", async () => {
    const f = fixture(); f.job.publicationWriteStarted = true;
    f.execute.mockRejectedValue(new EbayListingSyncError("EBAY_SYNC_IDENTITY_CHANGED", "Review the changed mapping."));
    await f.service.processDue(1);
    expect(f.finish).toHaveBeenCalledWith(f.job, expect.objectContaining({ state: "awaiting_evidence", code: "EBAY_SYNC_IDENTITY_CHANGED", resetAttempts: true }), expect.any(Date));
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("retains accepted publication on a transient provider read failure", async () => {
    const f = fixture(); f.job.publicationAccepted = { listingId: "listing-20", offerIds: { 101: "offer-101" } };
    f.execute.mockRejectedValue(new Error("transport failed"));
    await f.service.processDue(1);
    expect(f.finish).toHaveBeenCalledWith(f.job, expect.objectContaining({ state: "recovering", resetAttempts: true }), expect.any(Date));
  });
  it("protects a publish started during this execution before the provider throws", async () => {
    const f = fixture(); f.execute.mockImplementation(async (_source, stage) => {
      await stage("publish", "a".repeat(64), async () => { throw new Error("lost HTTP response"); });
      throw new Error("unreachable");
    });
    await f.service.processDue(1);
    expect(f.finish).toHaveBeenCalledWith(f.job, expect.objectContaining({ state: "awaiting_evidence" }), expect.any(Date));
    expect(f.job.publicationWriteStarted).toBe(false); // The claim snapshot remains immutable.
  });
  it("protects a completed HTTP call when its listing stage completion cannot commit", async () => {
    const f = fixture(); f.stage.mockImplementation(async (_job, _key, _hash, state) => {
      if (state === "completed") throw new Error("stage commit lost");
    });
    f.execute.mockImplementation(async (_source, stage) => {
      await stage("publish", "b".repeat(64), async () => {}); throw new Error("unreachable");
    });
    await f.service.processDue(1);
    expect(f.finish).toHaveBeenCalledWith(f.job, expect.objectContaining({ state: "awaiting_evidence" }), expect.any(Date));
    expect(f.job.publicationWriteCompleted).toBe(false); expect(f.job.publicationWriteStarted).toBe(false);
  });
});
