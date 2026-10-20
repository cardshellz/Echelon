import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { purchaseCostApplicationHistorySchema } from "@shared/procurement/purchase-cost-applications";
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

function reconciledHistoryFixture(): PurchaseCostApplicationRead {
  const input = applicationReadFixture();
  const contract = withFingerprint({ ...(input.revisions[0].contract as object), component: "landed", evidence: "estimated",
    scope: { kind: "shipment_line", purchaseOrderId: 17, purchaseOrderLineId: 171, inboundShipmentId: 7, inboundShipmentLineId: 71 } });
  Object.assign(input.revisions[0], { component: "landed", shipmentId: 7, shipmentLineId: 71, contract, fingerprint: contract.fingerprint });
  const issues = [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Historical stock destination remains unknown." }];
  const result = { status: "review_required", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0, issues };
  input.applications = [
    { ...input.applications[0], status: "review_required", result },
    { ...input.applications[0], id: 22, status: "review_required", result },
  ];
  input.lotChanges = []; input.contributions = [];
  const posting = { id: 51, approvalId: 61, applicationId: 22, sourceRevisionId: 11,
    destination: "inventory_variance" as const, beforeMills: 0, afterMills: 2000, deltaMills: 2000,
    actorName: "Approval reviewer", reason: "Historical destination reviewed and approved.", recordedAt };
  input.reconciliationPostings = [posting];
  input.currentResolutions = [{ sourceRevisionId: 11, sourceFingerprint: contract.fingerprint, applicationId: 22,
    currency: "USD", destination: "inventory_variance", postedMills: 2000, postings: [posting] }];
  input.reportingEvents = [{ ...input.reportingEvents[0], id: 42, applicationId: 22, component: "landed", sourceFingerprint: contract.fingerprint,
    cogsDeltaCents: 0, changeCount: 0,
    historicalCostAdjustments: [{ id: 51, approvalId: 61, destination: "inventory_variance", beforeMills: 0, afterMills: 2000, deltaMills: 2000 }] }];
  return input;
}

describe("purchase history current cost reconciliation", () => {
  it("shows verified current approval and reporting while preserving the original failed attempt", () => {
    const input = reconciledHistoryFixture(), before = structuredClone(input);
    const revision = projectPurchaseCostApplications(input, 17).revisions[0];
    expect(revision.currentResolution).toEqual(input.currentResolutions![0]);
    expect(revision.applications[0]).toMatchObject({ id: 21, status: "review_required", latestRecordedApplication: false, resolvedByCurrentPosting: true,
      issues: [{ code: "COST_HISTORICAL_LINEAGE_MISSING" }], reportingEvent: null });
    expect(revision.applications[1]).toMatchObject({ id: 22, status: "review_required", evidenceState: "review_required", resolvedByCurrentPosting: true,
      issues: [{ code: "COST_HISTORICAL_LINEAGE_MISSING" }], reportingEvent: { evidenceState: "verified_record" } });
    expect(input).toEqual(before);
  });

  it.each(["stale_fingerprint", "old_revision", "old_attempt", "unknown_issue", "missing_posting", "conflicting_posted_amount", "duplicate_resolution", "duplicate_posting"])(
    "does not assert current resolution from %s evidence", (kind) => {
      const input = reconciledHistoryFixture();
      if (kind === "stale_fingerprint") input.currentResolutions![0].sourceFingerprint = "f".repeat(64);
      if (kind === "old_revision") input.revisions.unshift({ ...input.revisions[0], id: 12, revision: 3 });
      if (kind === "old_attempt") input.applications.push({ ...input.applications[1], id: 23 });
      if (kind === "unknown_issue") input.applications[1].result = { ...(input.applications[1].result as object), issues: [{ code: "COST_GRAPH_CONFLICT", message: "Graph requires repair." }] };
      if (kind === "missing_posting") input.reconciliationPostings = [];
      if (kind === "conflicting_posted_amount") input.currentResolutions![0].postedMills = 2001;
      if (kind === "duplicate_resolution") input.currentResolutions!.push(input.currentResolutions![0]);
      if (kind === "duplicate_posting") { input.currentResolutions![0].postings.push(input.currentResolutions![0].postings[0]); input.currentResolutions![0].postedMills = 4000; }
      expect(projectPurchaseCostApplications(input, 17).revisions.every((revision) => revision.currentResolution === null)).toBe(true);
    },
  );

  it.each(["wrong_delta", "wrong_approval", "wrong_posting", "missing_event", "wrong_posting_revision"])(
    "keeps %s reporting evidence under review even with a current approval", (kind) => {
      const input = reconciledHistoryFixture();
      const adjustments = input.reportingEvents[0].historicalCostAdjustments as Array<Record<string, unknown>>;
      if (kind === "wrong_delta") adjustments[0].deltaMills = 2001;
      if (kind === "wrong_approval") adjustments[0].approvalId = 62;
      if (kind === "wrong_posting") adjustments[0].id = 52;
      if (kind === "missing_event") input.reportingEvents = [];
      if (kind === "wrong_posting_revision") input.reconciliationPostings![0].sourceRevisionId = 12;
      const revision = projectPurchaseCostApplications(input, 17).revisions[0];
      expect(revision.currentResolution).toBeNull();
      expect(revision.applications[1].issues.map((issue) => issue.code)).toContain("COST_REPORTING_EVENT_UNVERIFIED");
    },
  );

  it("allows an unchanged approved balance on a new current revision without attributing the old posting to the new attempt", () => {
    const input = reconciledHistoryFixture();
    const contract = withFingerprint({ ...(input.revisions[0].contract as object), revision: 3 });
    input.revisions.unshift({ ...input.revisions[0], id: 12, revision: 3, contract, fingerprint: contract.fingerprint });
    input.applications.push({ ...input.applications[1], id: 23, sourceRevisionId: 12 });
    input.currentResolutions = [{ ...input.currentResolutions![0], sourceRevisionId: 12, sourceFingerprint: contract.fingerprint, applicationId: 23 }];
    const history = projectPurchaseCostApplications(input, 17);
    expect(history.revisions[0].currentResolution).toMatchObject({ sourceRevisionId: 12, applicationId: 23,
      postings: [{ applicationId: 22, sourceRevisionId: 11 }] });
    expect(history.revisions[1].currentResolution).toBeNull();
    expect(history.revisions[0].applications[0].reportingEvent).toBeNull();
  });

  it.each(["fingerprint", "source", "missing_event", "unknown_issue"])("does not carry forward an invalid backing posting %s", (kind) => {
    const input = reconciledHistoryFixture();
    const contract = withFingerprint({ ...(input.revisions[0].contract as object), revision: 3 });
    input.revisions.unshift({ ...input.revisions[0], id: 12, revision: 3, contract, fingerprint: contract.fingerprint });
    input.applications.push({ ...input.applications[1], id: 23, sourceRevisionId: 12 });
    input.currentResolutions = [{ ...input.currentResolutions![0], sourceRevisionId: 12, sourceFingerprint: contract.fingerprint, applicationId: 23 }];
    if (kind === "fingerprint") input.reportingEvents[0].sourceFingerprint = "e".repeat(64);
    if (kind === "source") input.reportingEvents[0].sourceRevisionId = 12;
    if (kind === "missing_event") input.reportingEvents = [];
    if (kind === "unknown_issue") input.applications[1].result = { ...(input.applications[1].result as object), issues: [{ code: "COST_GRAPH_CONFLICT", message: "Unverified graph." }] };
    expect(projectPurchaseCostApplications(input, 17).revisions.every((revision) => revision.currentResolution === null)).toBe(true);
  });

  it.each(["unknown_issue", "wrong_application", "wrong_source", "missing_event"])("rejects malformed %s resolution at the outbound/browser contract", (kind) => {
    const history = projectPurchaseCostApplications(reconciledHistoryFixture(), 17);
    const revision = history.revisions[0];
    if (kind === "unknown_issue") revision.applications[1].issues = [{ code: "COST_GRAPH_CONFLICT", message: "Unknown authority." }];
    if (kind === "wrong_application") revision.currentResolution!.applicationId = 21;
    if (kind === "wrong_source") revision.currentResolution!.sourceRevisionId = 12;
    if (kind === "missing_event") revision.applications[1].reportingEvent = null;
    expect(purchaseCostApplicationHistorySchema.safeParse(history).success).toBe(false);
  });

  it("verifies a retained-quantity reporting event without treating its recorded review as a failed lot write", () => {
    const input = applicationReadFixture();
    const unresolved = { allocationId: 71, inventoryLotId: 901, lotNumber: "ROOT-901", component: "product", quantity: 2, originalQuantity: 10, onHandQuantityAtReview: 5, recordedOutflowQuantityAtReview: 3, amountMills: 400 };
    input.applications[0].status = "review_required";
    input.applications[0].result = { ...(input.applications[0].result as object), status: "review_required",
      issues: [{ code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "Two units retain their historical gap.", unresolvedQuantity: unresolved }] };
    input.reportingEvents[0].unresolvedQuantities = [unresolved];
    const application = projectPurchaseCostApplications(input, 17).revisions[0].applications[0];
    expect(application.reportingEvent?.evidenceState).toBe("verified_record");
    expect(application.issues.map((issue) => issue.code)).toEqual(["COST_UNRESOLVED_QUANTITY_RETAINED"]);
    expect(application.status).toBe("review_required");
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


function fullQuarantineReturnHistory(): PurchaseCostApplicationRead {
  const input = applicationReadFixture();
  const inventoryEffect = { kind: "none", reason: "full_quarantine_return", returnedBasePieces: 10,
    returns: [{ supplierCreditLineId: 811, returnDispositionId: 41, observationId: 31,
      receivingLineId: 311, quantity: 2, unitsPerVariant: 5 }] };
  const contract = withFingerprint({ ...(input.revisions[0].contract as object), totalMills: 0, basePieces: 0, inventoryEffect,
    sources: [{ kind: "vendor_invoice_line", documentId: 71, lineId: 711, version: "a".repeat(64) },
      { kind: "supplier_credit_line", documentId: 81, lineId: 811, version: "b".repeat(64) }] });
  const noInventoryEffectEvidence = { purchaseOrderLineId: 171, recognizedQuantity: false, inventoryHistory: false,
    costHistory: false, outstandingCustody: false, invoices: [{ documentId: 71, lineId: 711, version: "a".repeat(64) }],
    returns: [{ supplierCreditLineId: 811, supplierCreditId: 81, creditVersion: "b".repeat(64), returnDispositionId: 41,
      observationId: 31, receivingLineId: 311, purchaseOrderLineId: 171, quantity: 2, unitsPerVariant: 5,
      dispositionQuantity: 2, returnedQuantity: 2, observedQuantity: 2, receivedQuantity: 0, pendingQuantity: 0,
      sourceMatches: true, receiptClosed: true }] };
  input.applications[0].noInventoryEffectEvidence = noInventoryEffectEvidence;
  const inventoryEffectProof = { contractVersion: 1, purchaseOrderLineId: 171, inventoryEffect,
    evidenceFingerprint: createHash("sha256").update(canonicalJson(noInventoryEffectEvidence)).digest("hex") };
  Object.assign(input.revisions[0], { contract, fingerprint: contract.fingerprint });
  input.applications[0].result = { status: "applied", lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0,
    issues: [], inventoryEffectProof: structuredClone(inventoryEffectProof) };
  input.lotChanges = []; input.contributions = [];
  Object.assign(input.reportingEvents[0], { sourceFingerprint: contract.fingerprint, cogsDeltaCents: 0, changeCount: 0,
    inventoryEffectProof: structuredClone(inventoryEffectProof) });
  return input;
}

describe("full quarantine return application history", () => {
  it("preserves a verified zero-effect disposition without fabricating a quantity denominator", () => {
    const input = fullQuarantineReturnHistory(), before = structuredClone(input);
    const revision = projectPurchaseCostApplications(input, 17).revisions[0];
    expect(revision.source).toMatchObject({ totalMills: 0, basePieces: 0 });
    expect(revision.applications[0]).toMatchObject({ status: "applied", evidenceState: "verified_record", issues: [],
      inventoryEffect: { kind: "none", reason: "full_quarantine_return", returnedBasePieces: 10 },
      outcome: { lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 }, lotChanges: [] });
    expect(input).toEqual(before);
  });

  it.each(["missing_result_proof", "missing_event_proof", "different_event_proof", "wrong_po_line", "wrong_effect",
    "cogs_changed", "sold_rows_changed", "lots_changed", "missing_event", "missing_snapshot", "accepted_stock_snapshot"])("does not claim completion with %s", kind => {
    const input = fullQuarantineReturnHistory();
    const result = input.applications[0].result as Record<string, unknown>;
    const proof = result.inventoryEffectProof as Record<string, unknown>;
    if (kind === "missing_snapshot") delete input.applications[0].noInventoryEffectEvidence;
    if (kind === "accepted_stock_snapshot") (input.applications[0].noInventoryEffectEvidence as Record<string, unknown>).recognizedQuantity = true;
    if (kind === "missing_result_proof") delete result.inventoryEffectProof;
    if (kind === "missing_event_proof") delete input.reportingEvents[0].inventoryEffectProof;
    if (kind === "different_event_proof") (input.reportingEvents[0].inventoryEffectProof as Record<string, unknown>).evidenceFingerprint = "d".repeat(64);
    if (kind === "wrong_po_line") proof.purchaseOrderLineId = 172;
    if (kind === "wrong_effect") (proof.inventoryEffect as Record<string, unknown>).returnedBasePieces = 11;
    if (kind === "cogs_changed") { result.totalCogsDeltaCents = 1; input.reportingEvents[0].cogsDeltaCents = 1; }
    if (kind === "sold_rows_changed") result.cogsRowsUpdated = 1;
    if (kind === "lots_changed") result.lotsUpdated = 1;
    if (kind === "missing_event") input.reportingEvents = [];
    const application = projectPurchaseCostApplications(input, 17).revisions[0].applications[0];
    expect(application.status).toBe("applied");
    expect(application.evidenceState).toBe("review_required");
    expect(application.inventoryEffect).toBeUndefined();
    expect(application.issues.some(row => row.code === "COST_INVENTORY_EFFECT_UNVERIFIED")).toBe(true);
  });

  it("rejects a response that adds a return-completion claim to an ordinary lot application", () => {
    const history = projectPurchaseCostApplications(applicationReadFixture(), 17);
    const noEffect = projectPurchaseCostApplications(fullQuarantineReturnHistory(), 17).revisions[0].applications[0].inventoryEffect;
    history.revisions[0].applications[0].inventoryEffect = noEffect;
    expect(purchaseCostApplicationHistorySchema.safeParse(history).success).toBe(false);
  });
});
