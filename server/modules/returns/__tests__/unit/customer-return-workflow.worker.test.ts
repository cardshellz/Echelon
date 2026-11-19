import { describe, expect, it, vi } from "vitest";
import { CustomerReturnWorkflowWorker } from "../../application/customer-return-workflow.worker";
import { CustomerReturnSubmissionProcessingError } from "../../application/customer-return-submission.service";
import { CustomerReturnIntakeError } from "../../application/customer-return-intake.ports";
import type { CustomerReturnWorkflowStore, ReturnWorkflowRecord } from "../../application/customer-return-workflow.ports";
import type { CustomerReturnLabelStatus } from "@shared/returns/customer-return-label.contract";
import { labelPreparationFixture, LABEL_LEASE } from "../support/label-fixtures";
import { LIVE_NOW } from "../support/live-inspection-fixtures";

async function setup(accepted = false) {
  const { input } = await labelPreparationFixture();
  const record: ReturnWorkflowRecord = { request: input, scope: { channelId: 36, omsOrderId: 100, externalOrderId: "1001", externalCustomerId: "901" },
    actor: "customer:36:901", phase: accepted ? "labels" : "preparing", reason: null,
    authorizationId: accepted ? 20 : null, failures: 0, explicitRetry: false, leaseToken: LABEL_LEASE, updatedAt: new Date(LIVE_NOW) };
  const status = (phase: "pending" | "ready" | "processing" | "needs_review" | "failed" = "pending"): CustomerReturnLabelStatus => ({
    channelId: 36, authorizationId: 20, authorizationNumber: "RMA-20", canProgress: phase === "pending" || phase === "needs_review",
    parcels: input.parcels.map((_, index) => ({ parcelId: 30 + index, number: index + 1, status: phase,
      trackingNumber: phase === "ready" ? `TRACK-${index}` : null,
      downloadPath: phase === "ready" ? `/api/returns/admin/portal-preview/live/labels/36/20/parcels/${30 + index}/download` : null })) });
  const store = { claim: vi.fn<CustomerReturnWorkflowStore["claim"]>(async () => [record]),
    settle: vi.fn<CustomerReturnWorkflowStore["settle"]>(async () => true) };
  const submitForOrder = vi.fn(async () => status());
  const labels = { status: vi.fn(async () => status()), progress: vi.fn(async () => status("ready")), retryRejected: vi.fn(async () => status("ready")) };
  const report = vi.fn();
  const worker = new CustomerReturnWorkflowWorker({ store: store as unknown as CustomerReturnWorkflowStore,
    submissions: { submitForOrder }, labels, now: () => new Date(LIVE_NOW), newToken: () => LABEL_LEASE, report });
  return { record, status, store, submitForOrder, labels, report, worker };
}

describe("backend-owned customer label workflow", () => {
  it("creates receiving intent under the original customer scope before progressing any label", async () => {
    const s = await setup(); await s.worker.run();
    expect(s.submitForOrder).toHaveBeenCalledExactlyOnceWith(s.record.request, s.record.actor, s.record.scope);
    expect(s.labels.progress).not.toHaveBeenCalled();
    expect(s.store.settle).toHaveBeenCalledWith(s.record, expect.objectContaining({ phase: "labels", authorizationId: 20 }), expect.any(Date));
  });
  it("completes already saved labels without another purchase or inspection", async () => {
    const s = await setup(true); s.labels.status.mockResolvedValueOnce(s.status("ready")); await s.worker.run();
    expect(s.labels.progress).not.toHaveBeenCalled(); expect(s.submitForOrder).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1].phase).toBe("ready");
  });
  it("observes a recent executing purchase and waits instead of starting another box", async () => {
    const s = await setup(true); s.labels.status.mockResolvedValueOnce(s.status("processing")); await s.worker.run();
    expect(s.labels.progress).not.toHaveBeenCalled(); expect(s.labels.retryRejected).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "labels", failures: 1, reason: null });
    expect(s.store.settle.mock.calls[0][1].nextRunAt.getTime()).toBeGreaterThan(new Date(LIVE_NOW).getTime());
  });
  it("delegates an uncertain purchase to the existing reconciliation owner", async () => {
    const s = await setup(true); s.labels.status.mockResolvedValueOnce(s.status("needs_review")); await s.worker.run();
    expect(s.labels.progress).toHaveBeenCalledExactlyOnceWith(36, 20, s.record.actor);
    expect(s.labels.retryRejected).not.toHaveBeenCalled(); expect(s.store.settle.mock.calls[0][1].phase).toBe("ready");
  });
  it("waits for an explicit action after a definitive carrier rejection", async () => {
    const s = await setup(true); s.labels.status.mockResolvedValueOnce(s.status("failed")); await s.worker.run();
    expect(s.labels.retryRejected).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "retryable_failure", reason: "RETURN_SHIPPING_UNAVAILABLE" });
  });
  it("delegates a new explicit rejected-label retry under the same authorization", async () => {
    const s = await setup(true); s.record.explicitRetry = true; s.labels.status.mockResolvedValueOnce(s.status("failed")); await s.worker.run();
    expect(s.labels.retryRejected).toHaveBeenCalledExactlyOnceWith(36, 20, s.record.actor);
    expect(s.submitForOrder).not.toHaveBeenCalled();
  });
  it.each(["channel", "authorization", "parcel"])("stops on changed %s identity before another carrier operation", async mismatch => {
    const s = await setup(true), bad = s.status();
    if (mismatch === "channel") bad.channelId++;
    if (mismatch === "authorization") bad.authorizationId++;
    if (mismatch === "parcel") bad.parcels.push({ ...bad.parcels[0], parcelId: 99 });
    s.labels.status.mockResolvedValueOnce(bad); await s.worker.run();
    expect(s.labels.progress).not.toHaveBeenCalled();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "needs_help", errorCode: "RETURN_WORKFLOW_IDENTITY_CHANGED" });
  });
  it("reports a proven pre-authorization rejection as editable input", async () => {
    const s = await setup(); s.submitForOrder.mockRejectedValueOnce(new CustomerReturnIntakeError("RETURN_LABEL_SUBMISSION_REJECTED", "changed", 410));
    await s.worker.run(); expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "needs_input", authorizationId: null });
  });
  it("does not turn an accepted return's error into permission to replace its intent", async () => {
    const s = await setup(true); s.labels.status.mockRejectedValueOnce(new CustomerReturnIntakeError("RETURN_LABEL_SUBMISSION_REJECTED", "changed", 410));
    await s.worker.run(); expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "needs_help", authorizationId: 20 });
  });
  it.each(["42702", "23514"])("escalates non-transient database code %s with its actual cause", async code => {
    const s = await setup(); s.submitForOrder.mockRejectedValueOnce(new CustomerReturnSubmissionProcessingError({ code, stage: "intake" }));
    await s.worker.run(); expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "needs_help", errorCode: code });
  });
  it("retries a serialization failure with bounded backoff", async () => {
    const s = await setup(); s.submitForOrder.mockRejectedValueOnce(new CustomerReturnSubmissionProcessingError({ code: "40001", stage: "intake" }));
    await s.worker.run(); expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "preparing", failures: 1, reason: null });
  });
  it("stops repeated transient failures instead of presenting endless processing", async () => {
    const s = await setup(); s.record.failures = 5; s.submitForOrder.mockRejectedValueOnce(new Error("unavailable"));
    await s.worker.run(); expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "retryable_failure", failures: 6, reason: "RETURN_WORKFLOW_TEMPORARY_FAILURE" });
  });
  it("escalates unresolved carrier reconciliation without authorizing a second purchase", async () => {
    const s = await setup(true); s.record.failures = 5; s.labels.status.mockResolvedValueOnce(s.status("needs_review"));
    s.labels.progress.mockResolvedValueOnce(s.status("needs_review")); await s.worker.run();
    expect(s.store.settle.mock.calls[0][1]).toMatchObject({ phase: "needs_help", reason: "RETURN_LABEL_RECONCILIATION_REQUIRED", failures: 6 });
    expect(s.labels.retryRejected).not.toHaveBeenCalled();
  });
  it("does not execute a record without a live workflow lease", async () => {
    const s = await setup(); s.record.leaseToken = null;
    await expect(s.worker.run()).rejects.toMatchObject({ code: "RETURN_WORKFLOW_LEASE_INVALID" });
    expect(s.submitForOrder).not.toHaveBeenCalled(); expect(s.store.settle).not.toHaveBeenCalled();
  });
  it("records superseded completion without overwriting a newer worker", async () => {
    const s = await setup(); s.store.settle.mockResolvedValueOnce(false); await s.worker.run();
    expect(s.report).toHaveBeenCalledWith(expect.objectContaining({ phase: "superseded" }));
  });
});
