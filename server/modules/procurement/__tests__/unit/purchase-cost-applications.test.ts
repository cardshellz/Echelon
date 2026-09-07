import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { projectPurchaseCostApplications, type PurchaseCostApplicationRead } from "../../purchase-cost-application-read.service";
import { projectReceiptCostQueue, type ReceiptCostQueueRead } from "../../receipt-cost-queue-read.service";

const recordedAt = "2026-09-07T12:00:00.000Z";
function withFingerprint(input: Record<string, unknown>) {
  const { revision = 1, fingerprint: ignored, ...economicInput } = input;
  return { ...economicInput, revision, fingerprint: createHash("sha256").update(canonicalJson(economicInput)).digest("hex") };
}
export function applicationReadFixture(): PurchaseCostApplicationRead {
  const contract = withFingerprint({
    contractVersion: 1, revision: 2, component: "product", scope: { kind: "purchase_order_line", purchaseOrderId: 17, purchaseOrderLineId: 171 },
    sources: [{ kind: "vendor_invoice_line", documentId: 71, lineId: 711, version: "a".repeat(64) }],
    currency: "USD", totalMills: 2000, basePieces: 10, evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null,
  });
  return {
    revisions: [{ id: 11, purchaseOrderLineId: 171, shipmentLineId: null, shipmentId: null, component: "product", revision: 2,
      fingerprint: contract.fingerprint, contract, recordedBy: "test-owner", recordedAt }],
    applications: [{ id: 21, sourceRevisionId: 11, status: "applied", recordedBy: "test-owner", recordedAt,
      result: { status: "applied", lotsUpdated: 2, cogsRowsUpdated: 1, totalCogsDeltaCents: -1, issues: [] } }],
    lotChanges: [
      { applicationId: 21, lotId: 901, lotNumber: "ROOT-901", variantId: 91, locationId: 9, currentOnHandUnits: 5,
        receivingLineId: 311, originalPurchaseOrderLineId: 171,
        before: { productMills: 300, packagingMills: 20, landedMills: 5 },
        after: { productMills: 200, packagingMills: 20, landedMills: 5, totalMills: 225, component: "product", allocatedMills: 2000, quantity: 10, remainderMills: 0 } },
      { applicationId: 21, lotId: 902, lotNumber: "TRANSFER-902", variantId: 91, locationId: 10, currentOnHandUnits: 3,
        receivingLineId: null, originalPurchaseOrderLineId: null,
        before: { productMills: 300, packagingMills: 20, landedMills: 5 },
        after: { productMills: 200, packagingMills: 20, landedMills: 5, totalMills: 225, component: "product", allocatedMills: 600, quantity: 3, remainderMills: 0 } },
    ],
    contributions: [{ id: 31, sourceLotId: 901, outputLotId: 902, sourceQty: 3, outputQty: 3, outputStartQty: 0, operationKind: "transfer", operationKey: "transfer:synthetic" }],
    reportingEvents: [{ id: 41, applicationId: 21, contractVersion: 1, payloadContractVersion: 1, changeCount: 2, recordedAt, sourceRevisionId: 11,
      sourceFingerprint: contract.fingerprint, component: "product", currency: "USD", cogsDeltaCents: -1 }],
  };
}

describe("immutable purchase cost application projection", () => {
  it("exposes recorded sources, original and descendant snapshots, signed COGS and internal-only reporting", () => {
    const input = applicationReadFixture(); const before = structuredClone(input);
    const result = projectPurchaseCostApplications(input, 17);
    expect(result.coverage).toBe("recorded_application_snapshots");
    const revision = result.revisions[0];
    expect(revision).toMatchObject({ id: 11, latestRecordedSourceRevision: true, source: { evidence: "confirmed", totalMills: 2000 } });
    expect(revision.applications[0]).toMatchObject({ evidenceState: "verified_record", outcome: { lotsUpdated: 2, cogsRowsUpdated: 1, totalCogsDeltaCents: -1 },
      reportingEvent: { id: 41, evidenceState: "verified_record", externalDelivery: "not_verified" } });
    expect(revision.applications[0].lotChanges.map((row) => row.lineage)).toEqual(["original_receipt", "transformed"]);
    expect(revision.applications[0].lotChanges[1].contributions[0]).toMatchObject({ id: 31, sourceLotId: 901, outputStartQty: 0 });
    expect(input).toEqual(before);
  });

  it.each([false, true])("verifies the current fingerprint including raw source evidence (tampered=%s)", (tampered) => {
    const input = applicationReadFixture();
    const { revision, fingerprint: ignored, ...economicInput } = input.revisions[0].contract as Record<string, unknown>;
    const sourceEvidence = { purchaseOrderLine: { id: 171 }, approvedInvoices: [{ id: 711, productMills: 2000 }] };
    const fingerprint = createHash("sha256").update(canonicalJson({ input: economicInput, sourceEvidence })).digest("hex");
    Object.assign(input.revisions[0], { sourceEvidence, fingerprint, contract: { ...economicInput, revision, fingerprint } });
    input.reportingEvents[0].sourceFingerprint = fingerprint;
    if (tampered) sourceEvidence.approvedInvoices[0].productMills = 2001;
    const result = projectPurchaseCostApplications(input, 17).revisions[0];
    expect(result.applications[0].evidenceState).toBe(tampered ? "review_required" : "verified_record");
    expect(result.source === null).toBe(tampered);
  });

  it("does not reuse a past application as proof that a newer source revision was applied", () => {
    const input = applicationReadFixture();
    const contract = withFingerprint({ ...(input.revisions[0].contract as object), revision: 3, totalMills: 3000 });
    input.revisions.unshift({ ...input.revisions[0], id: 12, revision: 3, fingerprint: contract.fingerprint, contract });
    const result = projectPurchaseCostApplications(input, 17);
    expect(result.revisions[0]).toMatchObject({ latestRecordedSourceRevision: true, applications: [] });
    expect(result.revisions[1]).toMatchObject({ latestRecordedSourceRevision: false });
    expect(result.revisions[1].applications[0].status).toBe("applied");
  });

  it.each(["fingerprint", "purchase_scope", "unsafe_amount"])("keeps invalid %s source evidence explicit", (kind) => {
    const input = applicationReadFixture();
    const contract = input.revisions[0].contract as Record<string, unknown>;
    if (kind === "fingerprint") contract.totalMills = 2001;
    if (kind === "purchase_scope") contract.scope = { kind: "purchase_order_line", purchaseOrderId: 99, purchaseOrderLineId: 171 };
    if (kind === "unsafe_amount") contract.totalMills = Number.MAX_SAFE_INTEGER + 1;
    const revision = projectPurchaseCostApplications(input, 17).revisions[0];
    expect(revision.source).toBeNull(); expect(revision.issues.length).toBeGreaterThan(0);
    expect(revision.applications[0].evidenceState).toBe("review_required");
  });

  it.each(["missing_event", "wrong_event_source", "wrong_event_version", "wrong_event_count", "wrong_cogs", "missing_lot", "bad_snapshot", "missing_origin", "bad_result"])("requires review for %s without claiming verified application", (kind) => {
    const input = applicationReadFixture();
    if (kind === "missing_event") input.reportingEvents = [];
    if (kind === "wrong_event_source") input.reportingEvents[0].sourceRevisionId = 99;
    if (kind === "wrong_event_version") input.reportingEvents[0].payloadContractVersion = 2;
    if (kind === "wrong_event_count") input.reportingEvents[0].changeCount = 0;
    if (kind === "wrong_cogs") input.reportingEvents[0].cogsDeltaCents = 0;
    if (kind === "missing_lot") input.lotChanges.pop();
    if (kind === "bad_snapshot") (input.lotChanges[0].after as Record<string, unknown>).allocatedMills = 2001;
    if (kind === "missing_origin") input.contributions = [];
    if (kind === "bad_result") input.applications[0].result = { status: "applied" };
    const application = projectPurchaseCostApplications(input, 17).revisions[0].applications[0];
    expect(application.evidenceState).toBe("review_required"); expect(application.issues.length).toBeGreaterThan(0);
    expect(application.status).toBe("applied"); // Recorded state is preserved alongside its evidence problem.
  });

  it.each(["unknown", "review_required", "missing_currency"])("requires review when a recorded application has %s source authority", (kind) => {
    const input = applicationReadFixture();
    const contract = withFingerprint({ ...(input.revisions[0].contract as object),
      ...(kind === "missing_currency" ? { currency: null } : { evidence: kind, issue: { code: "SOURCE_REVIEW", message: "The source needs review." } }),
    });
    Object.assign(input.revisions[0], { contract, fingerprint: contract.fingerprint });
    Object.assign(input.reportingEvents[0], { sourceFingerprint: contract.fingerprint, ...(kind === "missing_currency" ? { currency: null } : {}) });
    const application = projectPurchaseCostApplications(input, 17).revisions[0].applications[0];
    expect(application.status).toBe("applied");
    expect(application.evidenceState).toBe("review_required");
    expect(application.issues.map((entry) => entry.code)).toContain("COST_APPLICATION_SOURCE_UNRESOLVED");
  });

  it("keeps exact zero sources and applications with no captured lots distinct from missing evidence", () => {
    const input = applicationReadFixture();
    const contract = withFingerprint({ ...(input.revisions[0].contract as object), totalMills: 0 });
    Object.assign(input.revisions[0], { contract, fingerprint: contract.fingerprint });
    input.lotChanges = []; input.contributions = [];
    input.applications[0].result = { status: "applied", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, issues: [] };
    Object.assign(input.reportingEvents[0], { sourceFingerprint: contract.fingerprint, cogsDeltaCents: 0, changeCount: 0 });
    const revision = projectPurchaseCostApplications(input, 17).revisions[0];
    expect(revision.source?.totalMills).toBe(0);
    expect(revision.applications[0]).toMatchObject({ evidenceState: "verified_record", outcome: { lotsUpdated: 0 } });
  });
});

function queueFixture(): ReceiptCostQueueRead {
  return { requests: [{ id: 1, receiptId: 31, receiptStatus: "closed", purchaseOrderLineId: 171, requestedBy: "test-owner", requestedAt: recordedAt }], attempts: [] };
}
describe("receipt cost request history projection", () => {
  it("retains a closed physical receipt with a pending durable cost request", () => {
    expect(projectReceiptCostQueue(queueFixture())).toEqual([expect.objectContaining({ state: "pending", receiptStatus: "closed", attempts: [] })]);
  });
  it("shows every failed and successful attempt with its exact application references", () => {
    const input = queueFixture();
    input.attempts = [
      { id: 3, requestId: 1, state: "applied", recordedBy: "reviewer", recordedAt, applications: [{ applicationId: 21 }],
        summary: { requestId: 1, purchaseOrderLineId: 171, state: "applied", attemptRecorded: true, issues: [] } },
      { id: 2, requestId: 1, state: "retry_required", recordedBy: "test-owner", recordedAt, applications: null,
        summary: { requestId: 1, purchaseOrderLineId: 171, state: "retry_required", attemptRecorded: true, issues: [{ code: "RECEIPT_COST_RETRY_REQUIRED", message: "Cost transaction failed." }] } },
    ];
    const result = projectReceiptCostQueue(input, new Map([[21, { purchaseOrderLineId: 171, status: "applied" }]]))[0];
    expect(result.state).toBe("applied"); expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ latestRecordedAttempt: true, applicationIds: [21], evidenceState: "verified_record" });
    expect(result.attempts[1]).toMatchObject({ state: "retry_required", latestRecordedAttempt: false });
  });
  it.each(["summary", "application_scope", "missing_application"])("does not verify an attempt with invalid %s", (kind) => {
    const input = queueFixture();
    input.attempts = [{ id: 2, requestId: 1, state: "applied", recordedBy: "test-owner", recordedAt,
      summary: { requestId: kind === "summary" ? 999 : 1, purchaseOrderLineId: 171, state: "applied", attemptRecorded: true, issues: [] },
      applications: kind === "missing_application" ? [] : [{ applicationId: 21 }] }];
    const result = projectReceiptCostQueue(input, new Map([[21, { purchaseOrderLineId: kind === "application_scope" ? 999 : 171, status: "applied" }]]))[0];
    expect(result.state).toBe("review_required"); expect(result.attempts[0].evidenceState).toBe("review_required");
  });
});
