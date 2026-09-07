import { recordCostRevision } from "./cost-source-revision.repository";
import { sql } from "drizzle-orm";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
export { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { costFingerprint, costInteger, lockInventoryCostGraph, type CostEvidenceTransaction, type RecordedCostRevision } from "../inventory/infrastructure/cost-evidence.repository";
import { applyCostRevision, type CostComponentWriter, type CostRevisionApplicationResult } from "../inventory/application/apply-cost-revision";

/** AP approval establishes document authority; component evidence establishes
 * what may replace inventory product/packaging. Historical residuals are never
 * silently classified as packaging, freight or a discount. */
export async function recordPurchaseCostRevisions(
  tx: CostEvidenceTransaction, purchaseOrderLineId: number, actorId: string, now: Date,
): Promise<RecordedCostRevision[]> {
  costInteger(purchaseOrderLineId, "purchaseOrderLineId", 1);
  await lockInventoryCostGraph(tx);
  const sourceResult = await tx.execute(sql`
    SELECT line.id,line.purchase_order_id,line.line_type,line.order_qty,line.received_qty,line.status,line.total_product_cost_cents,line.packaging_cost_cents,
      line.discount_cents,line.tax_cents,po.currency
    FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.id=${purchaseOrderLineId}
  `);
  const line = sourceResult.rows[0];
  if (!line || line.line_type !== "product") return [];
  const approved = await tx.execute(sql`
    SELECT invoice_line.id,invoice_line.vendor_invoice_id,invoice_line.qty_invoiced,invoice_line.line_total_cents,
      invoice_line.cost_component_evidence,invoice.currency
    FROM procurement.vendor_invoice_lines invoice_line
    JOIN procurement.vendor_invoices invoice ON invoice.id=invoice_line.vendor_invoice_id
    WHERE invoice_line.purchase_order_line_id=${purchaseOrderLineId}
      AND invoice.status IN ('approved','partially_paid','paid') ORDER BY invoice_line.id
  `);
  const qty = costInteger(line.order_qty, "orderQty", 1);
  const coverageQty = ["received", "closed"].includes(line.status) ? costInteger(line.received_qty, "receivedQty") : qty;
  const approvedQty = approved.rows.reduce((sum, row) => sum + BigInt(costInteger(row.qty_invoiced, "qtyInvoiced")), BigInt(0));
  const parsed = approved.rows.map((row) => invoiceCostComponentEvidenceSchema.safeParse(row.cost_component_evidence));
  let issue: { code: string; message: string } | null = null;
  if (approved.rows.length > 0 && ((coverageQty === 0 || approvedQty !== BigInt(coverageQty)) || parsed.some((result) => !result.success))) {
    issue = { code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Approved invoices need complete quantity coverage and explicit product/packaging evidence before replacing the quoted inventory costs." };
  }
  const actual = approved.rows.length > 0 && issue === null;
  let productMills = costInteger((BigInt(costInteger(line.total_product_cost_cents, "productCostCents")) * BigInt(100)).toString(), "productMills");
  let packagingMills = costInteger((BigInt(costInteger(line.packaging_cost_cents, "packagingCostCents")) * BigInt(100)).toString(), "packagingMills");
  let packagingTreatment: "separate" | "included_in_product" = "separate";
  if (actual) {
    let product = BigInt(0), packaging = BigInt(0);
    for (let index = 0; index < parsed.length; index++) {
      const evidence = parsed[index];
      if (!evidence.success) throw new Error("Validated invoice evidence changed in memory");
      const components = evidence.data;
      const total = BigInt(components.productMills) + BigInt(components.packagingMills) + BigInt(components.adjustmentMills);
      if (total !== BigInt(costInteger(approved.rows[index].line_total_cents, "invoice.lineTotalCents")) * BigInt(100)
        || components.adjustmentMills !== 0 || (components.packagingTreatment === "included_in_product" && components.packagingMills !== 0)) {
        issue = { code: "INVOICE_COMPONENT_TOTAL_REVIEW", message: "The recorded invoice components do not have a supported, exact reconciliation to the document total." };
      }
      product += BigInt(components.productMills); packaging += BigInt(components.packagingMills);
      if (components.packagingTreatment === "included_in_product") packagingTreatment = "included_in_product";
    }
    productMills = costInteger(product.toString(), "invoice.productMills");
    packagingMills = costInteger(packaging.toString(), "invoice.packagingMills");
  } else if (costInteger(line.discount_cents ?? 0, "discountCents") !== 0 || costInteger(line.tax_cents ?? 0, "taxCents") !== 0) {
    issue ??= { code: "PURCHASE_ADJUSTMENT_REVIEW", message: "The purchase has a discount or tax requiring an explicit cost component disposition." };
  }
  const currency = actual
    ? approved.rows.every((row) => row.currency === "USD") ? "USD" : null
    : line.currency === "USD" ? "USD" : null;
  const sources = actual ? approved.rows.map((row) => ({ kind: "vendor_invoice_line" as const,
    documentId: costInteger(row.vendor_invoice_id, "invoiceId", 1), lineId: costInteger(row.id, "invoiceLineId", 1), version: costFingerprint(row) }))
    : [{ kind: "purchase_order_line" as const, documentId: costInteger(line.purchase_order_id, "purchaseOrderId", 1), lineId: purchaseOrderLineId, version: costFingerprint(line) }];
  const revisions: RecordedCostRevision[] = [];
  for (const [component, amount] of [["product", productMills], ["packaging", packagingMills]] as const) {
    const revision = await recordCostRevision(tx, {
      contractVersion: 1, component, scope: { kind: "purchase_order_line", purchaseOrderId: Number(line.purchase_order_id), purchaseOrderLineId },
      sources, currency, totalMills: costInteger(amount, "amount"), basePieces: actual ? coverageQty : qty,
      evidence: issue ? "review_required" : actual ? "confirmed" : "estimated",
      // Explicit inclusion is represented as product with a separately confirmed
      // zero packaging layer. The source history still records the treatment.
      packagingTreatment, issue, manualOverride: null,
    }, actorId, now, { purchaseOrderLine: line, approvedInvoices: approved.rows });
    revisions.push(revision);
  }
  return revisions;
}

export async function reconcilePurchaseCostEvidence(
  tx: CostEvidenceTransaction, purchaseOrderLineId: number, writer: CostComponentWriter, actorId: string, now: Date,
): Promise<{ lotsUpdated: number; cogsRowsUpdated: number; totalCogsDeltaCents: number; costApplications: CostRevisionApplicationResult[]; costSources: RecordedCostRevision[] }> {
  const revisions = await recordPurchaseCostRevisions(tx, purchaseOrderLineId, actorId, now);
  const applications: CostRevisionApplicationResult[] = [];
  for (const revision of revisions) applications.push(await applyCostRevision(tx, revision, writer, actorId, now));
  return { lotsUpdated: applications.reduce((sum, result) => sum + result.lotsUpdated, 0),
    cogsRowsUpdated: applications.reduce((sum, result) => sum + result.cogsRowsUpdated, 0),
    totalCogsDeltaCents: costInteger(applications.reduce((sum, result) => sum + BigInt(result.totalCogsDeltaCents), BigInt(0)).toString(), "totalCogsDeltaCents", -Number.MAX_SAFE_INTEGER), costApplications: applications, costSources: revisions };
}
