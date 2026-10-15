import { describe, expect, it } from "vitest";
import { presentEbayListingJob } from "../ebay-listing-progress";
import { resolveEbayListingIssue } from "../ebay-listing-issue";
import { ebayListingSyncJobSchema, ebayListingSyncProgressSchema, type EbayListingSyncJob } from "../types/ebay-listing-sync";

const job: EbayListingSyncJob = {
  id: "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775", productId: 1, kind: "sync", operation: "sync",
  state: "queued", code: null, message: null, nextAttemptAt: "2026-10-15T13:34:50.000Z", updatedAt: "2026-10-15T13:34:50.000Z",
};
const progress = {
  phase: null, phaseState: null, requestedAt: "2026-10-15T13:34:50.000Z",
  lastActivityAt: "2026-10-15T13:34:50.000Z", lastWorkerActivityAt: "2026-10-15T13:45:00.000Z", queuedAhead: 28,
} as const;

describe("saved eBay listing progress presentation", () => {
  it("shows queue evidence without inventing execution progress or a finish time", () => {
    const result = presentEbayListingJob({ ...job, progress });
    expect(result.summary).toBe("Waiting for 28 earlier updates");
    expect(result.verification).toBe("This request has not yet confirmed that the listing and pictures are current.");
    expect(result.phase).toBeNull();
    expect(result.times).toEqual([
      { label: "Requested", at: progress.requestedAt },
      { label: "Last recorded activity", at: progress.lastActivityAt },
      { label: "Latest queue activity", at: progress.lastWorkerActivityAt },
    ]);
  });
  it("distinguishes a stage checkpoint from verified job completion", () => {
    const running = presentEbayListingJob({ ...job, state: "running", progress: { ...progress, queuedAhead: null, phase: "verify", phaseState: "completed" } });
    expect(running.summary).toBe("Verification recorded; saving the result");
    expect(running.summary).not.toContain("pictures verified");
    expect(presentEbayListingJob({ ...job, state: "completed", progress }).summary).toBe("Listing update and pictures verified.");
    expect(presentEbayListingJob({ ...job, state: "completed", progress }).times).toEqual([]);
  });
  it("keeps durable state authoritative when evidence contains a completed step", () => {
    const result = presentEbayListingJob({ ...job, progress: { ...progress, phase: "prepare_inventory", phaseState: "completed" } });
    expect(result.summary).toBe("Waiting for 28 earlier updates");
    expect(result.phase).toBeNull();
  });
  it("describes withdrawal verification without promising published pictures", () => {
    const result = presentEbayListingJob({ ...job, operation: "withdraw", state: "running",
      progress: { ...progress, queuedAhead: null, phase: "verify", phaseState: "started" } });
    expect(result.summary).toBe("Verifying removal on eBay");
    expect(result.verification).toBe("Removal from eBay has not yet been verified.");
  });
  it.each(["recovering", "awaiting_evidence"] as const)("uses saved retry eligibility for %s without promising the worker will start then", state => {
    const result = presentEbayListingJob({ ...job, state, progress: { ...progress, queuedAhead: null } });
    expect(result.times.at(-1)).toEqual({ label: "Next automatic check eligible at", at: job.nextAttemptAt });
    expect(result.summary).not.toContain("earlier updates");
  });
  it("keeps older responses usable without fabricating queue or phase evidence", () => {
    const legacy = ebayListingSyncJobSchema.parse(job);
    expect(presentEbayListingJob(legacy)).toMatchObject({ summary: "Queued for eBay", phase: null, activity: null, times: [] });
  });
  it.each([0, null])("does not claim there is no other work when the queue count is %s", queuedAhead => {
    const result = presentEbayListingJob({ ...job, progress: { ...progress, queuedAhead } });
    expect(result.summary).toBe("Queued for eBay");
  });
  it("shows the classified stopped cause and the exact recorded step without inventing a next action", () => {
    const result = presentEbayListingJob({ ...job, state: "needs_attention", code: "CANONICAL_PUBLICATION_MAPPING_MISSING",
      progress: { ...progress, queuedAhead: null, phase: "prepare_inventory", phaseState: "started" } });
    expect(result.summary).toBe("Inventory setup stopped this update");
    expect(result.phase).toBe("Preparing the listing's inventory connection");
    expect(result.times.map(({ label }) => label)).not.toContain("Next automatic check eligible at");
    expect(presentEbayListingJob({ ...job, state: "needs_attention" }).summary).toBe("Update stopped");
  });
  it("shows the recorded recovery cause and eligibility without promising completion", () => {
    const result = presentEbayListingJob({ ...job, state: "recovering", code: "INVENTORY_PUBLICATION_TARGET_BUSY", progress });
    expect(result.summary).toBe("Waiting for an inventory update");
    expect(result.times.at(-1)).toEqual({ label: "Next automatic check eligible at", at: job.nextAttemptAt });
    expect(result.verification).toContain("not yet confirmed");
  });
  it("keeps request activity separate from missing queue activity", () => {
    const result = presentEbayListingJob({ ...job, progress: { ...progress, lastWorkerActivityAt: null } });
    expect(result.activity).toBe("No recent queue activity is available.");
    expect(result.times).toEqual([
      { label: "Requested", at: progress.requestedAt }, { label: "Last recorded activity", at: progress.lastActivityAt },
    ]);
  });
  it("validates phase pairs, queue counts and timestamps at the response boundary", () => {
    expect(ebayListingSyncProgressSchema.safeParse(progress).success).toBe(true);
    for (const invalid of [{ queuedAhead: -1 }, { queuedAhead: 1.5 }, { phase: "unknown" }, { phase: "verify", phaseState: null }, { lastActivityAt: "yesterday" }]) {
      expect(ebayListingSyncProgressSchema.safeParse({ ...progress, ...invalid }).success).toBe(false);
    }
  });
});

describe("actionable saved eBay failures", () => {
  it("offers normal sync for the classified canonical mapping preparation failure", () => {
    const issue = resolveEbayListingIssue({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING", jobId: job.id,
      productId: job.productId, state: "needs_attention", message: "The listing update could not finish. Inspect the saved sync job before retrying." });
    expect(issue).toMatchObject({ title: "Inventory setup stopped this update", retryable: true,
      action: { kind: "retry_sync", label: "Retry Sync" } });
    expect(issue.message).toContain("inventory connection");
    expect(issue.message).not.toContain("Inspect the saved sync job");
    expect(issue.nextStep).toBe("Retry Sync to recheck this listing and prepare missing inventory connections for its verified variants.");
  });
  it.each(["ETIMEDOUT", "EBAY_SYNC_READBACK_PENDING", "PUBLICATION_PROVIDER_COOLDOWN", "EBAY_PROVIDER_RATE_LIMITED"])("keeps automatic %s observation read-only", code => {
    expect(resolveEbayListingIssue({ code, jobId: job.id, state: "recovering" })).toMatchObject({ retryable: false, action: { kind: "check_status" } });
  });
  it("keeps genuine uncertain responses in their existing reviewed recovery flow", () => {
    expect(resolveEbayListingIssue({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", jobId: job.id, state: "awaiting_evidence" }))
      .toMatchObject({ retryable: false, action: { kind: "check_recovery" } });
  });
  it("opens saved details for unclassified failure without authorizing a mutation", () => {
    expect(resolveEbayListingIssue({ code: "UNCLASSIFIED_FAILURE", jobId: job.id, state: "needs_attention" }))
      .toMatchObject({ title: "The automated update stopped", code: "UNCLASSIFIED_FAILURE", reference: job.id,
        message: "Echelon could not identify a recovery step for this error. The update is not confirmed complete.",
        retryable: false, action: { kind: "check_status", label: "View saved update details" } });
  });
});
