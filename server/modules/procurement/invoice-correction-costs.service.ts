import { invoiceCorrectionCostImpactSchema } from "@shared/procurement/invoice-correction-cost-impact";
import { supplierCostReviewTasks } from "@shared/procurement/cost-review-tasks";
import { purchaseLineNeedsCostReview } from "@shared/procurement/purchase-cost-status";
import { COGSService } from "../inventory/cogs.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { buildCostDestinationImpact } from "./cost-change-impact";
import { resolvePurchaseCostSource } from "./domain/purchase-cost-source";
import { InvoiceQuantityCorrectionError } from "./invoice-quantity-correction.policy";
import { reconcilePurchaseCostEvidence } from "./purchase-cost-application.service";
import { readPurchaseCostStatus } from "./purchase-cost-status.repository";
import { readPoAmendmentDependencies, type PoAmendmentDependencies } from "./po-amendment-dependencies.repository";
import { projectPoAmendmentReturnedCosts } from "./po-amendment-return-impact";
import { readPurchaseCostSource, type PurchaseCostSource } from "./purchase-cost-source.repository";
import type { AmendmentTransaction } from "./po-quantity-amendment.repository";
import { readInvoiceCorrectionInventoryValues, type InvoiceCorrectionInventoryValues } from "./invoice-correction-cost-values";

function selectedAmounts(source: PurchaseCostSource | null | undefined) {
  if (!source) throw new CostEvidenceError("INVOICE_CORRECTION_COST_SOURCE_MISSING", "The invoice's purchase cost source could not be read.");
  return resolvePurchaseCostSource(source).map(input => ({
    component: input.component,
    // A rejected legacy source retains the quote as diagnostic evidence. It is
    // not selected inventory money and must not be shown as a confirmed amount.
    totalMills: ["estimated", "confirmed"].includes(input.evidence) ? input.totalMills : null,
    basePieces: input.basePieces,
    evidence: input.evidence,
  }));
}

export async function readInvoiceCorrectionCostDependencies(tx: AmendmentTransaction, purchaseOrderLineId: number) {
  const dependencies = await readPoAmendmentDependencies(tx, [purchaseOrderLineId]);
  // The common reader locks the complete shared-shipment scope. This command
  // changes only supplier costs for the edited line, not other POs' costs.
  return { ...dependencies, evidence: dependencies.evidence.filter(row => row.id === purchaseOrderLineId) };
}

/** Invoice edits use the same source, application and status owners as supplier
 * review. All calls occur under the correction's graph lock and transaction.
 * This service never changes physical quantities or chooses an expense. */
export async function applyInvoiceCorrectionCosts(
  tx: AmendmentTransaction, purchaseOrderLineId: number, before: PoAmendmentDependencies,
  beforeValues: InvoiceCorrectionInventoryValues, actorId: string, at: Date,
) {
  const currentSource = await readPurchaseCostSource(tx, purchaseOrderLineId);
  if (!currentSource) throw new CostEvidenceError("INVOICE_CORRECTION_COST_SOURCE_MISSING", "The invoice's purchase cost source could not be read.");
  if (!currentSource.receiptCosting && currentSource.approvedInvoices.length > 1 && resolvePurchaseCostSource(currentSource).some(input => input.evidence === "confirmed")) {
    // The confirmed policy keeps each receipt's own invoice cost. Until the
    // receipt-allocation adapter exists, a new correction cannot invoke the
    // legacy whole-line aggregate and silently introduce averaged costs.
    throw new InvoiceQuantityCorrectionError(
      "Several supplier invoice lines cover this purchase line. It needs receipt-specific cost allocation, which this editor does not support yet. No averaged inventory cost was saved.",
      "INVOICE_CORRECTION_RECEIPT_ALLOCATION_REQUIRED",
    );
  }
  const beforeAmounts = selectedAmounts(before.evidence.find(row => row.id === purchaseOrderLineId)?.source);
  const application = await reconcilePurchaseCostEvidence(tx, purchaseOrderLineId, new COGSService(tx), actorId, at);
  const status = await readPurchaseCostStatus(tx, [purchaseOrderLineId]);
  const line = status.lines.find(row => row.purchaseOrderLineId === purchaseOrderLineId);
  if (!line) throw new CostEvidenceError("INVOICE_CORRECTION_COST_RESULT_MISSING", "The supplier cost update has no complete status result.");
  const after = await readInvoiceCorrectionCostDependencies(tx, purchaseOrderLineId);
  const afterAmounts = selectedAmounts(after.evidence.find(row => row.id === purchaseOrderLineId)?.source);
  const afterValues = new Map((await readInvoiceCorrectionInventoryValues(tx, after)).map(row => [row.lotId, row]));
  const impact = invoiceCorrectionCostImpactSchema.parse({
    purchaseOrderLineId,
    needsReview: purchaseLineNeedsCostReview(line) || afterAmounts.some(row => row.evidence !== "confirmed"),
    reviewTasks: supplierCostReviewTasks(line).map(({ id, title, explanation }) => ({ id, title, explanation })),
    sourceAmounts: beforeAmounts.map(previous => {
      const next = afterAmounts.find(row => row.component === previous.component);
      if (!next) throw new CostEvidenceError("INVOICE_CORRECTION_COST_RESULT_MISSING", "A supplier cost component is missing from the corrected source.");
      return { component: previous.component,
        before: { totalMills: previous.totalMills, basePieces: previous.basePieces, evidence: previous.evidence },
        after: { totalMills: next.totalMills, basePieces: next.basePieces, evidence: next.evidence } };
    }),
    inventoryValues: beforeValues.map(previous => {
      const next = afterValues.get(previous.lotId);
      if (!next || next.onHandUnits !== previous.onHandUnits) throw new CostEvidenceError("INVOICE_CORRECTION_STOCK_CHANGED", "Invoice costing cannot change recorded stock quantities.");
      return { lotId: previous.lotId, lotNumber: previous.lotNumber, onHandUnits: previous.onHandUnits,
        originalLotTotalMills: { before: previous.originalLotTotalMills, after: next.originalLotTotalMills },
        onHandValueMills: { before: previous.onHandValueMills, after: next.onHandValueMills }, valueReviewReason: next.valueReviewReason };
    }),
    ...buildCostDestinationImpact(before, after),
    applications: application.costApplications.map((result, index) => {
      const revision = application.costSources[index];
      if (!revision) throw new CostEvidenceError("INVOICE_CORRECTION_COST_RESULT_MISSING", "A supplier cost application has no matching source revision.");
      const component = revision.contract.component;
      const current = line.components.find(row => row.component === component);
      if (!current) throw new CostEvidenceError("INVOICE_CORRECTION_COST_RESULT_MISSING", "A supplier cost application has no current status.");
      return {
        purchaseOrderLineId, shipmentId: null, component,
        status: current.status === "pending" ? "pending_finalization" : current.status,
        lotsUpdated: result.replayed ? 0 : result.lotsUpdated,
        orderCostsUpdated: result.replayed ? 0 : result.cogsRowsUpdated,
        orderCostDeltaCents: result.replayed ? 0 : result.totalCogsDeltaCents,
        ...projectPoAmendmentReturnedCosts(result),
        issues: current.issues.length || current.status === "applied" ? current.issues : [{
          code: "INVOICE_CORRECTION_COST_PENDING",
          message: "Supplier costs are saved. Inventory costing is waiting for the linked receipt or its cost evidence.",
        }],
      };
    }),
  });
  return { impact, application };
}
