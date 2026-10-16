import { describe, expect, it } from "vitest";
import { presentEbayListingJob } from "../ebay-listing-progress";
import { resolveEbayListingIssue, resolveEbayListingJobIssue } from "../ebay-listing-issue";
import { ebayInventoryReconciliationSchema, ebayListingSyncJobSchema, ebayListingSyncProgressSchema, type EbayListingSyncJob } from "../types/ebay-listing-sync";

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
    expect(presentEbayListingJob({ ...job, state: "completed", progress }).summary).toBe("Listing and pictures verified.");
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
  it("uses automatic retry eligibility without promising processing will start then", () => {
    const result = presentEbayListingJob({ ...job, state: "recovering", progress: { ...progress, queuedAhead: null } });
    expect(result.times.at(-1)).toEqual({ label: "Next automatic check eligible at", at: job.nextAttemptAt });
    expect(result.summary).not.toContain("earlier updates");
  });
  it("does not present a manual-review timestamp as an automatic way to unblock an unknown operation", () => {
    const result = presentEbayListingJob({ ...job, state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", progress });
    expect(result.summary).toBe("An earlier quantity update needs review");
    expect(result.times.map(({ label }) => label)).not.toContain("Next automatic check eligible at");
  });
  it.each(["queued", "running", "completed"] as const)("does not revive a prior blocker while the saved request is %s", state => {
    const issue = resolveEbayListingIssue({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", jobId: job.id });
    const current = { ...job, state, code: issue.code, message: issue.message, issue, progress };
    expect(resolveEbayListingJobIssue(current)).toBeNull();
    expect(presentEbayListingJob(current).summary).not.toContain("needs review");
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
    expect(presentEbayListingJob({ ...job, state: "needs_attention" }).summary).toBe("The automated update stopped");
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

describe("independent stock reconciliation evidence", () => {
  const inventoryReconciliation = {
    state: "pending" as const, checkedAt: null,
    nextCheckAt: "2026-10-15T14:00:00.000Z", code: null, message: null,
  };
  it("keeps completed content separate from pending stock and legacy missing evidence", () => {
    const completed = { ...job, state: "completed" as const };
    const presented = presentEbayListingJob({ ...completed, inventoryReconciliation });
    expect(presented.summary).toBe("Listing and pictures verified.");
    expect(presented.inventory?.summary).toBe("Checking current stock");
    expect(presented.inventory?.detail).toContain("does not confirm current stock");
    expect(presentEbayListingJob(completed).inventory).toBeNull();
  });
  it("only describes verified stock as the provider check at its recorded time", () => {
    const checkedAt = "2026-10-15T13:59:30.000Z";
    const presented = presentEbayListingJob({ ...job, state: "completed",
      inventoryReconciliation: { ...inventoryReconciliation, state: "verified", checkedAt } });
    expect(presented.inventory).toMatchObject({ summary: "Stock matched current inventory at the last check.",
      times: [{ label: "Stock checked", at: checkedAt }, { label: "Next stock check eligible at", at: inventoryReconciliation.nextCheckAt }] });
    expect(presented.inventory?.detail).toContain("Monitoring continues");
  });
  it("describes a corrective stock enqueue without treating it as provider success", () => {
    const presented = presentEbayListingJob({ ...job, state: "completed",
      inventoryReconciliation: { ...inventoryReconciliation, code: "PUBLICATION_RECONCILIATION_DRIFT" } });
    expect(presented.inventory?.summary).toBe("Restoring current stock");
    expect(presented.inventory?.detail).toBe("The last stock check found a difference. A correction was requested. The next check will confirm the current quantity.");
    expect(presented.inventory?.times).toContainEqual({ label: "Next stock check eligible at", at: inventoryReconciliation.nextCheckAt });
  });
  it("retains content evidence when optional stock status is unavailable without inventing retry timing", () => {
    const presented = presentEbayListingJob({ ...job, state: "completed", inventoryReconciliation: {
      ...inventoryReconciliation, state: "unavailable", nextCheckAt: null, code: "PUBLICATION_RECONCILIATION_STATUS_UNAVAILABLE",
    } });
    expect(presented.summary).toBe("Listing and pictures verified.");
    expect(presented.inventory).toMatchObject({ summary: "Stock verification status is unavailable.", times: [] });
  });
  it.each([null, "Provider read failed: Bearer private-token"])("shows a safe stock failure and its automatic follow-up (%s)", message => {
    const presented = presentEbayListingJob({ ...job, state: "completed", inventoryReconciliation: {
      ...inventoryReconciliation, state: "needs_attention", code: "PUBLICATION_RECONCILIATION_FAILED", message,
    } });
    expect(presented.summary).toBe("Listing and pictures verified.");
    expect(presented.inventory?.summary).toBe("Stock check could not finish");
    expect(presented.inventory?.detail).toContain("Stock monitoring will retry automatically.");
    expect(presented.inventory?.detail).not.toContain("private-token");
  });
  it("validates stock evidence before the UI can describe a provider check", () => {
    expect(ebayInventoryReconciliationSchema.safeParse(inventoryReconciliation).success).toBe(true);
    for (const invalid of [{ state: "verified" }, { state: "completed" }, { checkedAt: "yesterday" },
      { nextCheckAt: "tomorrow" }, { code: "x".repeat(101) }, { message: "x".repeat(1001) }, { inferredSuccess: true }]) {
      expect(ebayInventoryReconciliationSchema.safeParse({ ...inventoryReconciliation, ...invalid }).success).toBe(false);
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
  it.each(["ETIMEDOUT", "EBAY_SYNC_READBACK_PENDING", "PUBLICATION_PROVIDER_COOLDOWN", "EBAY_PROVIDER_RATE_LIMITED", "PUBLICATION_AUTOMATIC_RECOVERY_FAILED", "PUBLICATION_SCOPE_BUSY", "EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT"])("keeps automatic %s observation read-only", code => {
    expect(resolveEbayListingIssue({ code, jobId: job.id, state: "recovering" })).toMatchObject({ retryable: false, action: { kind: "check_status" } });
  });
  it.each(["EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT"])("replaces a cached manual %s card with the saved automatic retry state", code => {
    const issue = resolveEbayListingIssue({ code, jobId: job.id, state: "awaiting_evidence" });
    const recovering = { ...job, state: "recovering" as const, code, issue, message: issue.message,
      progress: { ...progress, phase: "recover_prior_requests" as const, phaseState: "started" as const } };
    const currentIssue = resolveEbayListingJobIssue(recovering);
    expect(currentIssue).toMatchObject({ title: "Recovering an interrupted update", retryable: false,
      action: { kind: "check_status", label: "View update status" } });
    expect(currentIssue?.message).toContain("outcome remains unknown");
    expect(currentIssue?.nextStep).toContain("will retry automatically");
    expect(currentIssue?.nextStep).not.toContain("administrator");
    expect(presentEbayListingJob(recovering)).toMatchObject({ summary: "Recovering an interrupted update",
      phase: "Checking earlier eBay request outcomes",
      times: expect.arrayContaining([{ label: "Next automatic check eligible at", at: job.nextAttemptAt }]) });
    expect(resolveEbayListingIssue({ code, state: "recovering", message: "Ask an administrator to resume." }).message).not.toContain("administrator");
  });
  it.each(["EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", "EBAY_PUBLICATION_RESPONSE_UNCERTAIN", "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN",
    "EBAY_QUANTITY_RESPONSE_UNCERTAIN", "QUANTITY_PROVIDER_REQUEST_TIMEOUT"])("keeps genuine uncertain %s in its existing reviewed recovery flow", code => {
    expect(resolveEbayListingIssue({ code, jobId: job.id, state: "awaiting_evidence" }))
      .toMatchObject({ retryable: false, action: { kind: "check_recovery" } });
  });
  it("opens saved details for unclassified failure without authorizing a mutation", () => {
    expect(resolveEbayListingIssue({ code: "UNCLASSIFIED_FAILURE", jobId: job.id, state: "needs_attention" }))
      .toMatchObject({ title: "The automated update stopped", code: "UNCLASSIFIED_FAILURE", reference: job.id,
        message: "Echelon could not identify a recovery step for this error. The update is not confirmed complete.",
        retryable: false, action: { kind: "check_status", label: "View saved update details" } });
  });
});
