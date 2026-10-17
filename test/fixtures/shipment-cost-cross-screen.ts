import type { PoShipmentCosts } from "../../shared/procurement/po-shipment-costs";
import type { ShipmentCostReview } from "../../shared/procurement/shipment-cost-workflow";
import type { PurchaseWorkspace } from "../../shared/procurement/purchase-workspace";
import { purchaseCostApplicationsFixture } from "./purchase-cost-applications";

// Fixed, fictional API projections for screen acceptance. Server and database
// suites establish how posting evidence produces these projections; this fixture
// deliberately does not recalculate the financial completion rule.
export const originalCostIssue = {
  code: "COST_UNRESOLVED_QUANTITY_RETAINED",
  message: "The original attempt could not explain the historical received quantity.",
  unresolvedQuantity: { inventoryLotId: 901, allocationId: 9011, lotNumber: "TEST-LOT-901", originalQuantity: 100,
    onHandQuantityAtReview: 90, recordedOutflowQuantityAtReview: 0, quantity: 10, component: "landed" as const, amountMills: 100000 },
};
export const currentCostIssue = {
  code: "COST_SOURCE_CHANGED",
  message: "Shipment charges changed after the saved cost application. Review the current source.",
};
export const shipmentDocument = {
  id: 42, shipmentNumber: "TEST-COST-42", status: "closed", mode: "sea_fcl", purchaseOrderId: 17,
  purchaseOrders: [{ id: 17, poNumber: "TEST-PO-17" }], allocationMethodDefault: "by_value",
  createdAt: "2026-10-01T12:00:00Z", estimatedTotalCostCents: 10000, actualTotalCostCents: null,
  statusHistory: [],
  lines: [{ id: 23, purchaseOrderId: 17, purchaseOrderLineId: 171, sku: "TEST-COST-SKU", productName: "Fictional cost test product",
    qtyShipped: 100, cartonCount: 10, allocatedCostCents: 10000, poUnitCostMills: 10000, landedUnitCostMills: 20000 }],
  costs: [{ id: 71, costType: "freight", actualCents: null, estimatedCents: 10000, allocationMethod: "by_value", currency: "USD", costStatus: "estimated" }],
};
export const currentAllocation = {
  shipmentId: 42, status: "allocated", lineCount: 1, allocatableCostCount: 1,
  effectiveCostCents: 10000, allocatedCostCents: 10000, unallocatedCents: 0, blockerCount: 0, warningCount: 0, issues: [],
  costs: [{ costId: 71, costType: "freight", effectiveCents: 10000, allocatedCents: 10000, method: "by_value",
    methodSource: "cost_type_override", basisTotal: 100, rawBasisTotal: 100, usedFallback: false, status: "allocated" }],
};
export function ordinaryPostedCosts(): PoShipmentCosts {
  return {
    summary: { currency: "USD", shipmentCount: 1, chargeCount: 1, freightCents: 10000, dutyCents: 0,
      otherCents: 0, totalCents: 10000, poAmountCents: 100000, combinedCostCents: 110000, estimatedCents: 10000,
      unallocatedChargeCount: 0, unsupportedCurrencyCount: 0, appliedLines: 1, reviewLines: 0, pendingLines: 0,
      inventoryCosting: "applied" },
    supplier: { freightCents: 0, dutyCents: 0 },
    totals: { freightCents: 10000, dutyCents: 0, combinedCostCents: 110000 },
    lines: [{ lineId: 23, shipmentId: 42, shipmentNumber: "TEST-COST-42", shipmentStatus: "closed", sku: "TEST-COST-SKU",
      allocatedCents: 10000, status: "applied", applicationId: 21, recordedAt: "2026-10-14T12:00:00Z", issues: [] }],
  };
}
export function ordinaryPostedReview(): ShipmentCostReview {
  return { shipmentId: 42, lines: [{ lineId: 23, sku: "TEST-COST-SKU", sourceIssue: null,
    application: { id: 21, status: "applied", recordedAt: "2026-10-14T12:00:00Z", lotsUpdated: 1, cogsRowsUpdated: 0, issues: [] } }] };
}
export function currentSourceNeedsReview(): { costs: PoShipmentCosts; review: ShipmentCostReview } {
  const costs = ordinaryPostedCosts();
  costs.summary = { ...costs.summary, appliedLines: 0, reviewLines: 1, inventoryCosting: "review_required" };
  costs.lines[0] = { ...costs.lines[0], status: "review_required", issues: [currentCostIssue] };
  const review = ordinaryPostedReview();
  review.lines[0].sourceIssue = currentCostIssue;
  return { costs, review };
}
export function historyWorkspace(): PurchaseWorkspace {
  return {
    purchase: { id: 17, poNumber: "TEST-PO-17", status: "received", physicalStatus: "received", financialStatus: "unpaid",
      currency: "USD", vendorName: "Test vendor", totalCents: 100000, invoicedTotalCents: 0, paidTotalCents: 0,
      outstandingCents: 0, expectedDeliveryDate: null, confirmedDeliveryDate: null, actualDeliveryDate: null,
      lines: [{ id: 171, sku: "TEST-COST-SKU", productName: "Fictional cost test product", lineType: "product",
        orderedQty: 100, receivedQty: 100, cancelledQty: 0, quantityBasis: "pieces" }] },
    shipments: [{ id: 42, shipmentNumber: "TEST-COST-42", status: "closed", mode: "sea_fcl", containerNumber: null,
      eta: null, deliveredDate: null, estimatedTotalCostCents: 10000, actualTotalCostCents: null, amountScope: "whole_shipment",
      purchaseOrderIds: [17], unlinkedLineCount: 0,
      lines: [{ id: 23, purchaseOrderId: 17, purchaseOrderLineId: 171, purchaseOrderLinePurchaseOrderId: 17,
        sku: "TEST-COST-SKU", qtyShipped: 100, allocatedCostCents: 10000 }] }],
    receipts: [], invoices: [],
    edges: [{ from: { kind: "purchase", id: 17 }, to: { kind: "shipment", id: 42 }, relationship: "purchase_shipment" }],
    costTrace: purchaseCostApplicationsFixture(), limitations: [],
  };
}
export const emptyDashboard = {
  stockouts: 0, orderNow: 0, draftPoCount: 0, inTransitCount: 0, openPoValueCents: 0, noVendorCount: 0,
  stockoutItems: [], draftPos: [], inFlightPos: [], noVendorItems: [], orderNowItems: [],
  healthBreakdown: { stockout: 0, order_now: 0, order_soon: 0, on_order: 0, ok: 0, no_movement: 0, total: 0 },
  spend: { totalReceivedCents: 0, openPoValueCents: 0, avgPoCents: 0, topSupplierName: null, topSupplierCents: 0, activeSupplierCount: 0 },
  lastAutoDraftRun: null,
};

export const postedOtherCostWarning = "Landed costs are posted. 1 lot still has a provisional cost flag; review remaining cost evidence before treating the complete lot cost as final.";
export function postedHealth() {
  return { status: "healthy", scannedShipments: 1, critical: 0, warning: 0,
    counts: { allocationBlockers: 0, allocationWarnings: 0, pendingFinalization: 0, finalizedNotPushed: 0,
      staleProvisionalLots: 0, postingReviewRequired: 0, provisionalOtherCosts: 0 }, items: [] };
}
export function postedWithOtherProvisionalCosts() {
  return { status: "warning", scannedShipments: 1, critical: 0, warning: 1,
    counts: { ...postedHealth().counts, provisionalOtherCosts: 1 },
    items: [{ id: "provisional-other-costs:42", type: "provisional_other_costs", severity: "warning", shipmentId: 42,
      shipmentNumber: "TEST-COST-42", shipmentStatus: "closed", detail: postedOtherCostWarning,
      action: "review_cost_evidence", provisionalLotCount: 1 }] };
}
export function unresolvedHealth() {
  return { status: "critical", scannedShipments: 1, critical: 1, warning: 0,
    counts: { ...postedHealth().counts, postingReviewRequired: 1 },
    items: [{ id: "posting-review:42", type: "posting_review_required", severity: "critical", shipmentId: 42,
      shipmentNumber: "TEST-COST-42", shipmentStatus: "closed", detail: currentCostIssue.message,
      action: "review_cost_evidence" }] };
}
export function reconciledCosts() {
  const costs = ordinaryPostedCosts(), review = ordinaryPostedReview();
  const exception = {
    state: "open" as const, fingerprint: "b".repeat(64), kind: "unexplained_quantity" as const,
    currency: "USD", allocatedMills: 1000000, amountMills: 100000, lotsUpdated: 1, cogsRowsUpdated: 0,
    issues: [originalCostIssue], decision: null,
    reconciliation: { status: "posted" as const, postedMills: 100000, unassignedMills: 0, destination: "historical_cogs" as const },
  };
  costs.lines[0] = { ...costs.lines[0], issues: [originalCostIssue], exceptionReview: exception };
  review.lines[0] = { ...review.lines[0], exceptionReview: exception,
    application: { ...review.lines[0].application!, status: "review_required", issues: [originalCostIssue] } };
  return { costs, review };
}

export function reconciledHistoryWorkspace(): PurchaseWorkspace {
  const data = historyWorkspace(), trace = data.costTrace!;
  trace.receiptCostRequests = [];
  const revision = trace.applicationHistory!.revisions[0];
  revision.shipmentLineId = 23;
  revision.component = "landed";
  revision.source = { ...revision.source!, component: "landed", totalMills: 1000000, basePieces: 100, evidence: "estimated",
    packagingTreatment: "not_applicable",
    scope: { kind: "shipment_line", purchaseOrderId: 17, purchaseOrderLineId: 171, inboundShipmentId: 42, inboundShipmentLineId: 23 },
    sources: [{ kind: "shipment_cost", documentId: 42, lineId: 71, version: "b".repeat(64) }] };
  revision.applications[0] = { ...revision.applications[0], status: "review_required", evidenceState: "review_required", resolvedByCurrentPosting: true,
    issues: [originalCostIssue], outcome: { lotsUpdated: 1, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 }, lotChanges: [],
    reportingEvent: { id: 41, contractVersion: 1, recordedAt: "2026-10-15T12:00:00Z", evidenceState: "verified_record", externalDelivery: "not_verified" } };
  revision.currentResolution = {
    sourceRevisionId: 11, sourceFingerprint: "a".repeat(64), applicationId: 21, currency: "USD",
    destination: "historical_cogs", postedMills: 100000,
    postings: [{ id: 901, approvalId: 81, applicationId: 21, sourceRevisionId: 11, destination: "historical_cogs",
      beforeMills: 0, afterMills: 100000, deltaMills: 100000, actorName: "Test administrator",
      reason: "Historical sale evidence reviewed and approved.", recordedAt: "2026-10-15T12:00:00Z" }],
  };
  return data;
}
