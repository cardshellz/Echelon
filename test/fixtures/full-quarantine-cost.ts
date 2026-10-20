import { supplierCreditDetailSchema } from "../../shared/procurement/supplier-credit";
import { supplierCreditFixture } from "./supplier-credit";
import { costInventoryEffectSchema, type CostInventoryEffect } from "../../shared/procurement/cost-source-contracts";
import { purchaseCostStatusSchema, type PurchaseCostStatus } from "../../shared/procurement/purchase-cost-status";
import { purchaseCostApplicationHistorySchema } from "../../shared/procurement/purchase-cost-applications";
import { historyWorkspace } from "./shipment-cost-cross-screen";

/** Synthetic read projections. Database acceptance separately verifies the source,
 * inventory absence and reporting proofs which permit these API outcomes. */
export function fullQuarantineInventoryEffect(): CostInventoryEffect {
  return costInventoryEffectSchema.parse({ kind: "none", reason: "full_quarantine_return", returnedBasePieces: 150,
    returns: [{ supplierCreditLineId: 91, returnDispositionId: 41, observationId: 51,
      receivingLineId: 311, quantity: 15, unitsPerVariant: 10 }] });
}
export function fullQuarantineCostStatus(): PurchaseCostStatus {
  return purchaseCostStatusSchema.parse({ lines: [{ purchaseOrderId: 17, purchaseOrderLineId: 171, sku: "TEST-COST-SKU",
    components: (["product", "packaging"] as const).map((component, index) => ({ component,
      status: "applied", sourceEvidence: "confirmed", sourceCurrent: true, sourceRevisionId: 11 + index,
      applicationId: 21 + index, issues: [], inventoryEffect: fullQuarantineInventoryEffect() })),
    invoices: [{ invoiceId: 71, invoiceNumber: "TEST-INV-71", lineId: 711, lineNumber: 1 }],
    receipts: [{ receiptId: 31, receiptNumber: "TEST-RCV-31", status: "closed" }], lots: [] }] });
}
export function fullQuarantineWorkspace() {
  const workspace = historyWorkspace(), trace = workspace.costTrace!;
  const history = trace.applicationHistory!;
  const revision = history.revisions[0], source = revision.source!;
  source.basePieces = 0; source.totalMills = 0; source.inventoryEffect = fullQuarantineInventoryEffect();
  source.sources.push({ kind: "supplier_credit_line", documentId: 9, lineId: 91, version: "c".repeat(64) });
  const application = revision.applications[0];
  application.inventoryEffect = fullQuarantineInventoryEffect(); application.lotChanges = [];
  application.outcome = { lotsUpdated: 0, cogsRowsUpdated: 0, totalCogsDeltaCents: 0 };
  trace.applicationHistory = purchaseCostApplicationHistorySchema.parse(history);
  trace.currentCosts = fullQuarantineCostStatus();
  trace.receiptLines = [];
  const request = trace.receiptCostRequests![0];
  request.currentCosts = trace.currentCosts.lines[0]; request.state = "applied"; request.recordedState = "review_required";
  request.attempts[0].state = "review_required";
  request.attempts[0].issues = [{ code: "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW", message: "Original return evidence required review." }];
  return workspace;
}

export function fullQuarantineSupplierCredit() {
  return supplierCreditDetailSchema.parse(supplierCreditFixture({ costStatus: "posted", costIssues: [],
    lines: [{ id: 91, invoiceLineId: 711, label: "Returned cases", amountCents: 10000,
      disposition: { kind: "quarantine_return", returnDispositionId: 41, quantity: 15, evidenceReference: "RMA-41" },
      sourceEvidence: {}, costState: "posted", costIssues: [], inventoryEffect: fullQuarantineInventoryEffect() }] }));
}
