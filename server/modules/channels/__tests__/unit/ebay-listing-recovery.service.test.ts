import { describe, expect, it, vi } from "vitest";
import { EbayListingRecoveryService } from "../../ebay-listing-recovery.service";
import { EbayListingSyncError, storedEbayListingSyncJobSchema, publicationRetryReviewHash } from "../../ebay-listing-sync.domain";
import { ebayProductSyncResultSchema } from "@shared/types/ebay-listing-sync";
import { syncIdentity } from "../fixtures/ebay-listing-sync.fixture";

const id = "655ca747-20b9-4940-9c61-019baf1c11c1";
const command = { previewHash: "a".repeat(64), idempotencyKey: "00bd62b1-dd51-4ac5-b89a-85ca327d31fa", acknowledgeUnknownOutcome: true as const };
function fixture() {
  const job = storedEbayListingSyncJobSchema.parse({ id, productId: 20, state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED",
    message: "A saved request needs review.", nextAttemptAt: "2026-10-09T12:00:00.000Z", updatedAt: "2026-10-09T12:00:00.000Z",
    identity: syncIdentity, providerIdentity: { ...syncIdentity, groupKey: "ACTUAL-EBAY-GROUP" }, revision: "1", claimedRevision: null,
    ownerToken: null, attempts: 0, result: null, verificationIntentHash: null, verificationRevision: null });
  const jobs = { get: vi.fn(async () => job), getByCommand: vi.fn<() => Promise<typeof job | null>>(async () => null), getAdmission: vi.fn(async () => null), enqueue: vi.fn(async () => ({ ...job, state: "queued" as const })),
    authorizePublicationRetry: vi.fn<(_input: { commandKey: string }) => Promise<{ job: typeof job; replayed: boolean }>>(async () => ({ job: { ...job, state: "queued" }, replayed: false })) };
  const recovery = {
    preview: vi.fn(async () => ({ previewHash: command.previewHash, canResume: false, blockReason: "no_pending_attempts" as const, attempts: [] })),
    resume: vi.fn(async () => ({ attemptIds: ["16323"], replayed: false, providerWriteAttempted: false as const })),
  };
  const enqueue = vi.fn(async () => ebayProductSyncResultSchema.parse({ synced: 0,priceChanges: 0,qtyChanges: 0,policyChanges: 0,errors: 0,pending: 1,details: [],jobs: [{ ...job, state: "queued" }] }));
  return { job,jobs,recovery,enqueue,service: new EbayListingRecoveryService(jobs,recovery,enqueue) };
}
describe("listing recovery application boundary", () => {
  it("offers an explicit audited workflow retry when no inventory request was recorded", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: true, providerIdentity: null,
      publicationTarget: { ...f.job.identity, groupKey: "RECORDED-GROUP" } });
    const preview = await f.service.preview(id, 1);
    expect(preview).toMatchObject({ canResume: true, blockReason: null, attempts: [], publicationRetry: { reviewHash: publicationRetryReviewHash(f.job) } });
    f.recovery.resume.mockRejectedValueOnce(new EbayListingSyncError("EBAY_RECOVERY_SCOPE_CHANGED", "No pending requests."));
    const result = await f.service.resume(id, 1, "operator", { ...command, publicationRetryHash: preview.publicationRetry!.reviewHash });
    expect(result).toMatchObject({ attemptIds: [], publicationRetryAuthorized: true, providerWriteAttempted: false, job: { operation: "publish", state: "queued" } });
    expect(f.jobs.authorizePublicationRetry).toHaveBeenCalledWith(expect.objectContaining({ jobId: id, expectedRevision: "1", actor: "operator", commandKey: command.idempotencyKey }));
    expect(f.jobs.enqueue).not.toHaveBeenCalled();
  });
  it("will not authorize a started publication without the exact fresh workflow review", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: true, providerIdentity: null });
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toMatchObject({ code: "EBAY_RECOVERY_PREVIEW_CHANGED" });
    await expect(f.service.resume(id, 1, "operator", { ...command, publicationRetryHash: "f".repeat(64) })).rejects.toMatchObject({ code: "EBAY_RECOVERY_PREVIEW_CHANGED" });
    expect(f.jobs.authorizePublicationRetry).not.toHaveBeenCalled(); expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it("replays the inventory receipt after a lost channel authorization and retains the same key", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: true, providerIdentity: null });
    const input = { ...command, publicationRetryHash: publicationRetryReviewHash(f.job) };
    f.jobs.authorizePublicationRetry.mockRejectedValueOnce(new Error("connection lost"));
    await expect(f.service.resume(id, 1, "operator", input)).rejects.toMatchObject({ code: "EBAY_RECOVERY_FOLLOWUP_PENDING" });
    f.recovery.resume.mockResolvedValueOnce({ attemptIds: ["16323"], replayed: true, providerWriteAttempted: false });
    const result = await f.service.resume(id, 1, "operator", input);
    expect(result).toMatchObject({ attemptIds: ["16323"], replayed: true, publicationRetryAuthorized: true });
    expect(f.jobs.authorizePublicationRetry.mock.calls[1][0].commandKey).toBe(command.idempotencyKey);
  });
  it("retrieves a committed workflow authorization before stale current-state validation", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: false, revision: "2" });
    f.jobs.getByCommand.mockResolvedValueOnce(f.job); f.jobs.authorizePublicationRetry.mockResolvedValueOnce({ job: f.job, replayed: true });
    const result = await f.service.resume(id, 1, "operator", { ...command, publicationRetryHash: "d".repeat(64) });
    expect(result).toMatchObject({ publicationRetryAuthorized: true, replayed: true });
    expect(f.recovery.resume).not.toHaveBeenCalled(); expect(f.recovery.preview).not.toHaveBeenCalled();
  });
  it("does not convert changed inventory evidence into an empty workflow recovery", async () => {
    const f = fixture(); Object.assign(f.job, { operation: "publish", publicationWriteStarted: true });
    f.recovery.resume.mockRejectedValueOnce(new EbayListingSyncError("EBAY_RECOVERY_SCOPE_CHANGED", "Changed."));
    f.recovery.preview.mockResolvedValueOnce({ previewHash: "b".repeat(64), canResume: false, blockReason: "no_pending_attempts", attempts: [] });
    await expect(f.service.resume(id, 1, "operator", { ...command, publicationRetryHash: publicationRetryReviewHash(f.job) })).rejects.toMatchObject({ code: "EBAY_RECOVERY_PREVIEW_CHANGED" });
    expect(f.jobs.authorizePublicationRetry).not.toHaveBeenCalled();
  });
  it("resumes the exact saved publication and target after recovery without requiring a saved listing ID", async () => {
    const f = fixture(); f.job.operation = "publish"; f.job.providerIdentity = null;
    f.job.publicationTarget = { ...f.job.identity, groupKey: "RECORDED-PUBLICATION-GROUP" };
    await f.service.preview(id, 1);
    expect(f.recovery.preview).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ externalInventoryItemId: "group:RECORDED-PUBLICATION-GROUP" }),
    ]));
    const result = await f.service.resume(id, 1, "operator", command);
    expect(f.jobs.enqueue).toHaveBeenCalledWith(f.job.identity, "operator", command.idempotencyKey, "publish");
    expect(f.enqueue).not.toHaveBeenCalled(); expect(result.job).toMatchObject({ operation: "publish", state: "queued" });
    expect(f.recovery.resume.mock.invocationCallOrder[0]).toBeLessThan(f.jobs.enqueue.mock.invocationCallOrder[0]);
  });
  it("finds the exact coalesced command after a lost response without writing or enqueueing", async () => {
    const f = fixture();
    f.jobs.get.mockRejectedValueOnce(new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "Missing job."));
    f.jobs.getByCommand.mockResolvedValueOnce(f.job);
    const result = await f.service.inspect(command.idempotencyKey, 1);
    expect(result.job.id).toBe(id);
    expect(f.jobs.getByCommand).toHaveBeenCalledWith(command.idempotencyKey, 1);
    expect(f.recovery.resume).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("does not replace a missing command with a different job or expose another channel", async () => {
    const f = fixture();
    f.jobs.get.mockRejectedValue(new EbayListingSyncError("EBAY_SYNC_JOB_NOT_FOUND", "Missing job."));
    await expect(f.service.inspect(command.idempotencyKey, 1)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    f.jobs.getByCommand.mockResolvedValueOnce(f.job);
    await expect(f.service.inspect(command.idempotencyKey, 2)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("exposes separate saved and observed identities with actionable diagnostics and no owner token", async () => {
    const f = fixture(); const result = await f.service.inspect(id, 1);
    expect(result.sourceIdentity?.groupKey).toBe("PACK");
    expect(result.providerIdentity?.groupKey).toBe("ACTUAL-EBAY-GROUP");
    expect(result.job.issue?.action.kind).toBe("check_recovery");
    expect(result.job).not.toHaveProperty("ownerToken");
    expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it("previews only exact observed provider scopes and carries real local variant identity", async () => {
    const f = fixture(); await f.service.preview(id, 1);
    expect(f.recovery.preview).toHaveBeenCalledWith([
      expect.objectContaining({ externalInventoryItemId: "group:ACTUAL-EBAY-GROUP",productId: 20,productVariantId: null }),
      expect.objectContaining({ externalInventoryItemId: "P5",productId: 20,productVariantId: 101 }),
    ]);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("never uses an old catalog-derived group hint as recovery evidence", async () => {
    const f = fixture(); f.job.providerIdentity = null;
    await f.service.preview(id, 1);
    expect(f.recovery.preview).toHaveBeenCalledWith([expect.objectContaining({ externalInventoryItemId: "P5" })]);
  });
  it.each(["inspect", "preview", "resume"] as const)("rejects another channel before %s or inventory access", async method => {
    const f = fixture();
    await expect(method === "resume" ? f.service.resume(id, 2, "operator", command) : f.service[method](id, 2)).rejects.toMatchObject({ code: "EBAY_SYNC_JOB_NOT_FOUND" });
    expect(f.recovery.preview).not.toHaveBeenCalled(); expect(f.recovery.resume).not.toHaveBeenCalled();
  });
  it.each([{ ...command, acknowledgeUnknownOutcome: false }, { ...command, actor: "spoofed" }, { ...command, idempotencyKey: "bad" }])("rejects invalid confirmation before recovery: %#", async input => {
    const f = fixture(); await expect(f.service.resume(id, 1, "operator", input)).rejects.toThrow();
    expect(f.recovery.resume).not.toHaveBeenCalled(); expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("commits inventory-owned recovery before enqueueing and keeps the same command on retry after a lost follow-up", async () => {
    const f = fixture(); f.enqueue.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toMatchObject({ code: "EBAY_RECOVERY_FOLLOWUP_PENDING" });
    expect(f.recovery.resume.mock.invocationCallOrder[0]).toBeLessThan(f.enqueue.mock.invocationCallOrder[0]);
    f.recovery.resume.mockResolvedValueOnce({ attemptIds: ["16323"],replayed: true,providerWriteAttempted: false });
    expect(await f.service.resume(id, 1, "operator", command)).toMatchObject({ replayed: true, providerWriteAttempted: false, job: { state: "queued" } });
    expect(f.enqueue).toHaveBeenNthCalledWith(2, 20, "operator", command.idempotencyKey);
  });
  it("does not enqueue if inventory rejects stale evidence", async () => {
    const f = fixture(); f.recovery.resume.mockRejectedValueOnce(new EbayListingSyncError("EBAY_RECOVERY_PREVIEW_CHANGED", "Review again."));
    await expect(f.service.resume(id, 1, "operator", command)).rejects.toMatchObject({ code: "EBAY_RECOVERY_PREVIEW_CHANGED" });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("returns a durable admission rejection after recovery rather than trapping the operator on the old key", async () => {
    const f = fixture();
    f.enqueue.mockResolvedValueOnce(ebayProductSyncResultSchema.parse({ synced: 0,priceChanges: 0,qtyChanges: 0,policyChanges: 0,errors: 1,details: [],
      jobs: [{ ...f.job,id: command.idempotencyKey,kind: "admission",state: "needs_attention",code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" }] }));
    expect(await f.service.resume(id, 1, "operator", command)).toMatchObject({ attemptIds: ["16323"],job: { kind: "admission",code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" } });
    expect(f.recovery.resume).toHaveBeenCalledOnce();
  });
  it("gives initial publication a recovery path without inventing a saved maintenance job or publishing", async () => {
    const f = fixture(); const reader = vi.fn(async () => structuredClone(syncIdentity));
    const service = new EbayListingRecoveryService(f.jobs,f.recovery,f.enqueue,reader);
    expect(await service.previewProduct(20,1)).toMatchObject({ jobId: null,productId: 20 });
    expect(await service.resumeProduct(20,1,"operator",command)).toMatchObject({ job: null,nextAction: "retry_publish",providerWriteAttempted: false });
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.recovery.resume).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.arrayContaining([
      expect.objectContaining({ externalInventoryItemId: "P5",productId: 20,productVariantId: 101 }),
    ]) }));
  });
  it("returns a durable admission rejection after recovery instead of promising same-key enqueue retry", async () => {
    const f = fixture();
    const admission = { ...f.job, id: command.idempotencyKey, kind: "admission" as const, state: "needs_attention" as const,
      code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE", message: "Review the product inclusion before requesting a fresh sync." };
    f.enqueue.mockResolvedValueOnce(ebayProductSyncResultSchema.parse({ synced: 0, priceChanges: 0, qtyChanges: 0,
      policyChanges: 0, errors: 1, pending: 0, jobs: [admission], details: [{ productId: 20, success: false,
        code: admission.code, error: admission.message }] }));
    const result = await f.service.resume(id, 1, "operator", command);
    expect(result).toMatchObject({ attemptIds: ["16323"], providerWriteAttempted: false,
      job: { id: command.idempotencyKey, kind: "admission", state: "needs_attention", code: "EBAY_SYNC_PRODUCT_NOT_ELIGIBLE" } });
    expect(f.recovery.resume).toHaveBeenCalledOnce();
    expect(f.enqueue).toHaveBeenCalledExactlyOnceWith(20, "operator", command.idempotencyKey);
    expect(result.job.state).not.toBe("queued");
  });
});
