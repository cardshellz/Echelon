import { purchaseCostTraceFixture } from "./purchase-cost-trace";
import type { PurchaseCostTrace } from "../../shared/procurement/purchase-cost-trace";

/** Fictional API projection for rendering and request/retry acceptance. Financial
 * writer behavior and immutable fingerprint verification use separate DB tests. */
export function purchaseCostApplicationsFixture(): PurchaseCostTrace {
  const trace = purchaseCostTraceFixture();
  const recordedAt = "2026-09-07T12:00:00.000Z";
  const before = { productMills: 333350, packagingMills: 60000, landedMills: 25000 };
  const after = { productMills: 330000, packagingMills: 60000, landedMills: 25000, totalMills: 415000,
    component: "product" as const, allocatedMills: 330000, quantity: 1, remainderMills: 0 };
  trace.applicationEvidence = "recorded";
  trace.invoiceLines[0] = { ...trace.invoiceLines[0], unitCostCents: 66, unitCostMills: 6600, lineTotalCents: 11700,
    componentEvidence: "explicit_recorded", componentIssues: [], components: { contractVersion: 1, packagingTreatment: "separate",
      productMills: 990000, packagingMills: 180000, adjustmentMills: 0, source: "operator_review" } };
  trace.receiptLines[0].postings[0].lot = { ...trace.receiptLines[0].postings[0].lot!, onHandUnits: 0,
    productUnitMills: 330000, totalUnitMills: 415000 };
  trace.applicationHistory = { coverage: "recorded_application_snapshots", revisions: [{
    id: 11, purchaseOrderLineId: 171, shipmentLineId: null, component: "product", revision: 2,
    fingerprint: "a".repeat(64), latestRecordedSourceRevision: true, recordedBy: "test-owner", recordedAt, issues: [],
    source: { contractVersion: 1, revision: 2, fingerprint: "a".repeat(64), component: "product",
      scope: { kind: "purchase_order_line", purchaseOrderId: 17, purchaseOrderLineId: 171 },
      sources: [{ kind: "vendor_invoice_line", documentId: 71, lineId: 711, version: "b".repeat(64) }],
      currency: "USD", totalMills: 990000, basePieces: 150, evidence: "confirmed", packagingTreatment: "separate", issue: null, manualOverride: null },
    applications: [{ id: 21, status: "applied", latestRecordedApplication: true, recordedBy: "test-owner", recordedAt,
      evidenceState: "verified_record", issues: [], outcome: { lotsUpdated: 2, cogsRowsUpdated: 1, totalCogsDeltaCents: -34 },
      lotChanges: [
        { lotId: 901, lotNumber: "TEST-LOT-901", variantId: 91, locationId: 9, currentOnHandUnits: 0,
          lineage: "original_receipt", receivingLineId: 311, originalPurchaseOrderLineId: 171, contributions: [], before, after, issues: [] },
        { lotId: 902, lotNumber: "TEST-TRANSFER-902", variantId: 91, locationId: 10, currentOnHandUnits: 0,
          lineage: "transformed", receivingLineId: null, originalPurchaseOrderLineId: null,
          contributions: [{ id: 31, sourceLotId: 901, sourceQty: 1, outputQty: 1, outputStartQty: 0, operationKind: "transfer", operationKey: "transfer:synthetic" }],
          before, after, issues: [] },
      ], reportingEvent: { id: 41, contractVersion: 1, recordedAt, evidenceState: "verified_record", externalDelivery: "not_verified" },
    }],
  }] };
  trace.receiptCostRequests = [{ id: 61, receiptId: 31, receiptStatus: "closed", purchaseOrderLineId: 171,
    requestedBy: "test-owner", requestedAt: recordedAt, state: "retry_required", attempts: [{
      id: 71, state: "retry_required", latestRecordedAttempt: true, recordedBy: "test-owner", recordedAt,
      evidenceState: "verified_record", applicationIds: [],
      issues: [{ code: "RECEIPT_COST_RETRY_REQUIRED", message: "Stock was received. A later cost transaction needs another attempt." }],
    }] }];
  trace.limitations = ["Synthetic recorded application snapshots. External delivery and historical costs outside recorded lineage are not verified."];
  return trace;
}
