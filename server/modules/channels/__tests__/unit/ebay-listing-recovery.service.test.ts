import { describe, expect, it, vi } from "vitest";
import { EbayListingRecoveryService, type EbayListingRecoveryContinuation } from "../../ebay-listing-recovery.service";
import { EbayListingSyncError, storedEbayListingSyncJobSchema, publicationRetryReviewHash } from "../../ebay-listing-sync.domain";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

const id = "655ca747-20b9-4940-9c61-019baf1c11c1";
const command = { previewHash: "a".repeat(64), idempotencyKey: "00bd62b1-dd51-4ac5-b89a-85ca327d31fa", acknowledgeUnknownOutcome: true as const };
function fixture() {
  const job = storedEbayListingSyncJobSchema.parse({ id, productId: 20, state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
    message: "A saved request needs review.", nextAttemptAt: "2026-10-09T12:00:00.000Z", updatedAt: "2026-10-09T12:00:00.000Z",
    identity: syncIdentity, providerIdentity: { ...syncIdentity, groupKey: "ACTUAL-EBAY-GROUP" }, revision: "1", claimedRevision: null,
    ownerToken: null, attempts: 0, result: null, verificationIntentHash: null, verificationRevision: null });
  const jobs = { get: vi.fn(async () => job), getByCommand: vi.fn<() => Promise<typeof job | null>>(async () => null), getAdmission: vi.fn(async () => null) };
  const recovery = {
    preview: vi.fn(async () => ({ previewHash: command.previewHash, canResume: false, blockReason: "no_pending_attempts" as const, attempts: [] })),
    resume: vi.fn(async () => ({ attemptIds: ["16323"], replayed: false, providerWriteAttempted: false as const })),
  };
  const continuation = { resume: vi.fn<EbayListingRecoveryContinuation["resume"]>(async input => ({
    attemptIds: ["16323"], replayed: false, providerWriteAttempted: false,
    job: { ...input.job, state: "queued" },
    ...(input.confirmation.publicationRetryHash ? { publicationRetryAuthorized: true } : {}),
  })) };
  return { job, jobs, recovery, continuation, service: new EbayListingRecoveryService(jobs, recovery, continuation) };
}
describe("listing recovery application boundary", () => {
  it.each(["publish", "withdraw"] as const)("uses the same atomic continuation for interrupted %s", async operation => {
    const f = fixture(); Object.assign(f.job, { operation, publicationWriteStarted: operation === "publish", withdrawalWriteStarted: operation === "withdraw" });
    const preview = await f.service.preview(id, 1);
    expect(preview).toMatchObject({ canResume: true, blockReason: null, publicationRetry: { reviewHash: publicationRetryReviewHash(f.job) } });
    const input = { ...command, publicationRetryHash: preview.publicationRetry!.reviewHash };
    expect(await f.service.resume(id, 1, "operator", input)).toMatchObject({ publicationRetryAuthorized: true, job: { operation, state: "queued" } });
    expect(f.continuation.resume).toHaveBeenCalledWith(expect.objectContaining({ job: f.job, actor: "operator", confirmation: input }));
    expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it("requires workflow acknowledgement for a possibly sent publish", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: true });
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toMatchObject({ code: "EBAY_RECOVERY_PREVIEW_CHANGED" });
    expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it("lets the transactional owner replay the original review even after the current revision advanced", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", revision: "2" });
    f.continuation.resume.mockResolvedValueOnce({ attemptIds: [], replayed: true, providerWriteAttempted: false, publicationRetryAuthorized: true, job: f.job });
    expect(await f.service.resume(id, 1, "operator", { ...command, publicationRetryHash: "d".repeat(64) })).toMatchObject({ replayed: true, publicationRetryAuthorized: true });
    expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it("keeps the same confirmation after a lost response without inventing a partial success", async () => {
    const f = fixture(); f.continuation.resume.mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toThrow("connection lost");
    f.continuation.resume.mockResolvedValueOnce({ attemptIds: ["16323"], replayed: true, providerWriteAttempted: false, job: f.job });
    expect(await f.service.resume(id, 1, "operator", command)).toMatchObject({ replayed: true });
    expect(f.continuation.resume.mock.calls.map(([input]) => input.confirmation.idempotencyKey)).toEqual([command.idempotencyKey, command.idempotencyKey]);
    expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it.each(["EBAY_RECOVERY_PREVIEW_CHANGED", "EBAY_RECOVERY_SCOPE_CHANGED", "EBAY_SYNC_REPLAY_CONFLICT"])("preserves the owner rejection %s", async code => {
    const f = fixture(); f.continuation.resume.mockRejectedValueOnce(new EbayListingSyncError(code, "Review again."));
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toMatchObject({ code });
    expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it("carries the exact saved publication and target without requiring a saved listing ID", async () => {
    const f = fixture(); f.job.operation = "publish"; f.job.providerIdentity = null;
    f.job.publicationTarget = { ...f.job.identity, groupKey: "RECORDED-PUBLICATION-GROUP" };
    await f.service.resume(id, 1, "operator", command);
    expect(f.continuation.resume).toHaveBeenCalledWith(expect.objectContaining({ job: f.job, scopes: expect.arrayContaining([
      expect.objectContaining({ externalInventoryItemId: "group:RECORDED-PUBLICATION-GROUP", productId: 20 }),
    ]) }));
  });
  it("finds the exact coalesced command after a lost response without writing", async () => {
    const f = fixture(); f.jobs.get.mockRejectedValueOnce(new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "Missing job."));
    f.jobs.getByCommand.mockResolvedValueOnce(f.job);
    expect((await f.service.inspect(command.idempotencyKey, 1)).job.id).toBe(id);
    expect(f.jobs.getByCommand).toHaveBeenCalledWith(command.idempotencyKey, 1);
    expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it("does not substitute another job or expose another channel", async () => {
    const f = fixture(); f.jobs.get.mockRejectedValue(new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "Missing job."));
    await expect(f.service.inspect(command.idempotencyKey, 1)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    f.jobs.getByCommand.mockResolvedValueOnce(f.job);
    await expect(f.service.inspect(command.idempotencyKey, 2)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it("exposes saved and observed identities and safe diagnostics without owner tokens", async () => {
    const f = fixture(); const result = await f.service.inspect(id, 1);
    expect(result.sourceIdentity?.groupKey).toBe("PACK");
    expect(result.providerIdentity?.groupKey).toBe("ACTUAL-EBAY-GROUP");
    expect(result.job.issue).toMatchObject({ action: { kind: "retry_sync" }, diagnosticAction: { kind: "check_recovery" } });
    expect(result.job).not.toHaveProperty("ownerToken");
    expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it("previews only exact observed scopes and local variant identities", async () => {
    const f = fixture(); await f.service.preview(id, 1);
    expect(f.recovery.preview).toHaveBeenCalledWith([
      expect.objectContaining({ externalInventoryItemId: "group:ACTUAL-EBAY-GROUP", productId: 20, productVariantId: null }),
      expect.objectContaining({ externalInventoryItemId: "P5", productId: 20, productVariantId: 101 }),
    ]);
  });
  it("never uses an old catalog-derived group hint as recovery evidence", async () => {
    const f = fixture(); f.job.providerIdentity = null; await f.service.preview(id, 1);
    expect(f.recovery.preview).toHaveBeenCalledWith([expect.objectContaining({ externalInventoryItemId: "P5" })]);
  });
  it.each(["inspect", "preview", "resume"] as const)("rejects another channel before %s", async method => {
    const f = fixture();
    await expect(method === "resume" ? f.service.resume(id, 2, "operator", command) : f.service[method](id, 2)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    expect(f.recovery.preview).not.toHaveBeenCalled(); expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it.each([{ ...command, acknowledgeUnknownOutcome: false }, { ...command, actor: "spoofed" }, { ...command, idempotencyKey: "bad" }])("validates confirmation before recovery: %#", async input => {
    const f = fixture(); await expect(f.service.resume(id, 1, "operator", input)).rejects.toThrow();
    expect(f.recovery.resume).not.toHaveBeenCalled(); expect(f.continuation.resume).not.toHaveBeenCalled();
  });
  it("keeps initial publication recovery explicit without inventing a saved maintenance job", async () => {
    const f = fixture(); const reader = vi.fn(async () => structuredClone(syncIdentity));
    const service = new EbayListingRecoveryService(f.jobs, f.recovery, f.continuation, reader);
    expect(await service.previewProduct(20, 1)).toMatchObject({ jobId: null, productId: 20 });
    expect(await service.resumeProduct(20, 1, "operator", command)).toMatchObject({ job: null, nextAction: "retry_publish", providerWriteAttempted: false });
    expect(f.continuation.resume).not.toHaveBeenCalled();
    expect(f.recovery.resume).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.arrayContaining([
      expect.objectContaining({ externalInventoryItemId: "P5", productId: 20, productVariantId: 101 }),
    ]) }));
  });
});
