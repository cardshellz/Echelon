import type { CostIssue } from "./cost-source-contracts";
import type { PurchaseCostStatus, PurchaseLineCostStatus } from "./purchase-cost-status";
import { purchaseLineNeedsCostReview } from "./purchase-cost-status";
import { formatShipmentExceptionAmount, type ShipmentCostException } from "./shipment-cost-exception";

export type CostReviewAction = "invoice_amounts" | "invoice_quantity" | "record_invoice" | "apply_supplier"
  | "repair_origin" | "repair_links" | "review_history" | "update_shipment" | "measurements" | "accounting";
export interface CostReviewTask {
  id: string;
  title: string;
  explanation: string;
  action: CostReviewAction;
  invoiceLineId?: number;
  lotId?: number;
  shipment?: CostReviewShipmentLine;
  issues: readonly CostIssue[];
  facts?: readonly string[];
}
export interface CostReviewShipmentLine {
  lineId: number;
  purchaseOrderLineId: number | null;
  shipmentId: number;
  shipmentNumber: string | null;
  sku: string | null;
  posted: boolean;
  amountCents: number | null;
  currency: string | null;
  recordedAt: string | null;
  issues: readonly CostIssue[];
  exceptionReview?: ShipmentCostException | null;
}
export interface CostReviewGroup {
  key: string;
  sku: string | null;
  purchaseOrderId: number | null;
  poNumber?: string | null;
  supplier?: PurchaseLineCostStatus;
  shipments: CostReviewShipmentLine[];
  tasks: CostReviewTask[];
}

const quantity = (value: number) => value.toLocaleString("en-US");
const historyCodes = new Set(["COST_HISTORICAL_LINEAGE_MISSING", "COST_LINEAGE_UNPROVEN", "COST_UNRESOLVED_QUANTITY_RETAINED", "COST_GRAPH_INCOMPLETE"]);
const oldRoundingCodes = new Set(["COST_UNIFORM_LOT_RESIDUAL_REVIEW", "COST_TRANSFORM_RESIDUAL_REVIEW", "COST_GRAPH_INCOMPLETE"]);

/** Task classification explains the existing posting status. It never grants
 * approval, clears an issue, or decides where a historical expense belongs. */
export function supplierCostReviewTasks(line: PurchaseLineCostStatus): CostReviewTask[] {
  if (!purchaseLineNeedsCostReview(line)) return [];
  const tasks: CostReviewTask[] = [];
  const issues = [...new Map(line.components.flatMap(component => component.issues).map(issue => [issue.code + issue.message, issue])).values()];
  const facts = line.reviewFacts;
  const add = (task: Omit<CostReviewTask, "id" | "issues">, key: string) => tasks.push({ ...task, id: `supplier:${line.purchaseOrderLineId}:${key}`, issues });
  if (issues.some(issue => issue.code === "CREDIT_FULL_QUARANTINE_RETURN_COST_REVIEW")) {
    add({ title: "Check the supplier return", explanation: "The recorded return could not be verified against its cost records. There is no automatic cost retry for this case; review the saved return and invoice evidence.", action: "accounting" }, "return");
    return tasks;
  }
  if (!line.invoices.length && line.components.some(component => component.sourceEvidence !== "confirmed")) {
    add({ title: "Record the supplier invoice", explanation: "The supplier invoice has not been approved for this product. Saved PO prices may still be used as estimates.", action: "record_invoice" }, "invoice");
  } else {
    if (facts && !facts.quantityMatches && issues.some(issue => issue.code === "INVOICE_COMPONENT_REVIEW_REQUIRED")) {
      add({ title: "Invoice quantity differs", explanation: `Invoice: ${quantity(facts.invoicedPieces)} pieces${facts.creditedPieces ? " after supplier returns" : ""}. ${facts.quantityBasis === "received" ? "Received" : "Ordered"}: ${quantity(facts.expectedPieces)} pieces. Check the supplier document before changing either count.`, action: "invoice_quantity", invoiceLineId: line.invoices[0]?.lineId }, "quantity");
    }
    for (const lineId of facts?.missingAmountLineIds ?? []) {
      add({ title: "Confirm the supplier amounts", explanation: "The invoice total is saved. Confirm the product amount and whether packaging is included or billed separately.", action: "invoice_amounts", invoiceLineId: lineId }, `amounts:${lineId}`);
    }
    const invoiceIssue = issues.find(issue => issue.code.startsWith("INVOICE_") || issue.code === "PURCHASE_ADJUSTMENT_REVIEW");
    if (tasks.length === 0 && (invoiceIssue || line.components.some(component => component.sourceEvidence !== "confirmed"))) {
      add({ title: invoiceIssue?.code === "INVOICE_COMPONENT_TOTAL_REVIEW" ? "Invoice amounts need checking" : "Confirm the supplier amounts",
        explanation: invoiceIssue?.code === "INVOICE_COMPONENT_TOTAL_REVIEW" ? "The saved product, packaging or adjustment amounts cannot yet be applied as the final inventory cost. Review them against the invoice."
          : facts ? "Check the supplier's product and packaging amounts against the saved invoice."
          : "The exact invoice check is unavailable in this response. Reload the costs before deciding what to correct.", action: "invoice_amounts", invoiceLineId: line.invoices[0]?.lineId }, "amounts");
    }
  }
  for (const lot of line.lots.filter(lot => lot.origin === "unproven")) {
    add({ title: "Connect the original receipt", explanation: `${lot.lotNumber} has no verified receipt or transfer cost link. Review the existing history before approving a repair.`, action: "repair_origin", lotId: lot.id }, `origin:${lot.id}`);
  }
  if (issues.some(issue => historyCodes.has(issue.code)) && !tasks.some(task => task.action === "repair_origin")) {
    add({ title: "Check missing stock history", explanation: "Some stock movements cannot be traced through the receipt, transfer or repacking records. Review the recorded history; a missing link does not prove a sale.", action: "review_history" }, "history");
  }
  const otherIssues = issues.filter(issue => !issue.code.startsWith("INVOICE_") && issue.code !== "PURCHASE_ADJUSTMENT_REVIEW" && !historyCodes.has(issue.code));
  if (otherIssues.length) add({ title: "Check the recorded cost", explanation: otherIssues.map(issue => issue.message).join(" "), action: "accounting" }, "record");
  if (!tasks.length) add({ title: "Apply the supplier costs", explanation: "The supplier amounts are recorded. Apply them to the remaining stock and verified sales; review the saved result afterwards.", action: "apply_supplier" }, "apply");
  return tasks;
}

export function shipmentCostReviewTasks(line: CostReviewShipmentLine): CostReviewTask[] {
  if (line.posted) return [];
  const codes = new Set(line.issues.map(issue => issue.code));
  const previousRoundingFailure = codes.has("COST_UNIFORM_LOT_RESIDUAL_REVIEW") && [...codes].every(code => oldRoundingCodes.has(code));
  let title: string, explanation: string, action: CostReviewAction;
  if ([...codes].some(code => code.includes("DIMENSION") || code === "LANDED_PHYSICAL_VALUES_MISSING")) {
    title = "Check the saved box measurements"; explanation = "Shipping costs cannot be split using the saved weights or dimensions. Review this shipment's measurements and the cost changes before saving."; action = "measurements";
  } else if (line.exceptionReview?.reconciliation?.status === "review_required" || codes.has("COST_UPDATE_OUTDATED") || [...codes].some(code => code.startsWith("LANDED_ALLOCATION"))) {
    title = "Update the shipping costs"; explanation = "The shipment costs or their split changed after the last saved result. Update the costs before reviewing any remaining history gaps."; action = "update_shipment";
  } else if (!previousRoundingFailure && line.issues.some(issue => historyCodes.has(issue.code))) {
    const reviewed = line.issues.filter(issue => historyCodes.has(issue.code)).every(issue => issue.costLinksAlreadyReviewed);
    title = reviewed ? "Some stock movements are missing" : "Check receipt, transfer and repacking links";
    explanation = reviewed ? "The transfer and repacking links were already reviewed. The remaining stock movements still need evidence; approving those links again will not resolve them."
      : "This shipping cost cannot yet be traced through all recorded stock movements. Review the existing receipt, transfer and repacking links before deciding how to resolve it.";
    action = reviewed ? "review_history" : "repair_links";
  } else if (line.exceptionReview) {
    title = "Review the remaining shipping cost"; explanation = "Part of this shipping cost has not been assigned. Review the saved history and exact amount before an administrator approves its treatment."; action = "review_history";
  } else if (previousRoundingFailure || line.issues.length === 0 || [...codes].every(code => code.startsWith("LANDED_ALLOCATION") || ["COST_UPDATE_OUTDATED", "COST_UPDATE_NOT_RECORDED"].includes(code))) {
    title = "Update the shipping costs"; explanation = "The current shipment costs still need to be applied to stock and verified sales. Recalculate using the saved shipment details."; action = "update_shipment";
  } else {
    title = "Check the shipping cost record"; explanation = line.issues.map(issue => issue.message).join(" "); action = "accounting";
  }
  const unresolved = [...new Map(line.issues.flatMap(issue => issue.unresolvedQuantity ? [[issue.unresolvedQuantity.allocationId, issue.unresolvedQuantity] as const] : [])).values()];
  const facts = unresolved.map(row => `${row.lotNumber}: ${quantity(row.quantity)} received stock units have no recorded movement.${line.currency ? ` Cost to resolve: ${formatShipmentExceptionAmount(row.amountMills, line.currency)}.` : ""}`);
  if (unresolved.length) explanation += " Retrying costs cannot supply the missing movements. Stock counts are not changed by this cost review.";
  return [{ id: `shipment:${line.lineId}`, title, explanation, action, shipment: line, issues: line.issues, facts }];
}

/** Group by actual PO line identity. Matching SKUs on different POs and split
 * shipments remain separate records; supplier and freight tasks share a group. */
export function buildCostReviewGroups(supplier: PurchaseCostStatus | undefined, shipments: readonly CostReviewShipmentLine[] = []): CostReviewGroup[] {
  const groups = new Map<string, CostReviewGroup>();
  for (const line of supplier?.lines ?? []) groups.set(`purchase:${line.purchaseOrderLineId}`, {
    key: `purchase:${line.purchaseOrderLineId}`, sku: line.sku, purchaseOrderId: line.purchaseOrderId, poNumber: line.poNumber,
    supplier: line, shipments: [], tasks: supplierCostReviewTasks(line),
  });
  for (const line of shipments) {
    const key = line.purchaseOrderLineId === null ? `shipment:${line.lineId}` : `purchase:${line.purchaseOrderLineId}`;
    const group = groups.get(key) ?? { key, sku: line.sku, purchaseOrderId: null, shipments: [], tasks: [] };
    group.shipments.push(line); group.tasks.push(...shipmentCostReviewTasks(line)); groups.set(key, group);
  }
  return [...groups.values()];
}

export function costReviewSummary(groups: readonly CostReviewGroup[], scope: "all" | "shipping" = "all"): string {
  const count = groups.reduce((sum, group) => sum + group.tasks.length, 0);
  return count ? `${count} ${count === 1 ? "item needs" : "items need"} attention` : scope === "shipping" ? "Shipping costs applied" : "Costs are up to date";
}
