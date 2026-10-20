import { sql } from "drizzle-orm";
import {
  costInteger,
  CostEvidenceError,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import { readSupplierCreditCostRows } from "./supplier-credit-source.repository";
import type { SupplierCreditCostRow } from "./domain/supplier-credit-source";

export interface PurchaseCostSource {
  purchaseOrderLine: Record<string, unknown>;
  approvedInvoices: Record<string, unknown>[];
  supplierCredits?: SupplierCreditCostRow[];
}

/** These selected fields are part of the persisted source fingerprint contract.
 * Reads share the caller's snapshot and never create a revision. */
export async function readPurchaseCostSource(
  tx: CostEvidenceTransaction,
  purchaseOrderLineId: number,
) {
  costInteger(purchaseOrderLineId, "purchaseOrderLineId", 1);
  return (
    (await readPurchaseCostSources(tx, [purchaseOrderLineId])).get(
      purchaseOrderLineId,
    ) ?? null
  );
}

/** Batch the two source reads for a costing workspace; preserve exactly the
 * source fields used by existing persisted revision fingerprints. */
export async function readPurchaseCostSources(
  tx: CostEvidenceTransaction,
  lineIds: readonly number[],
): Promise<Map<number, PurchaseCostSource>> {
  const ids = [
    ...new Set(lineIds.map((id) => costInteger(id, "purchaseOrderLineId", 1))),
  ];
  const result = new Map<number, PurchaseCostSource>();
  if (ids.length === 0) return result;
  if (ids.length > 500)
    throw new CostEvidenceError(
      "COST_REVIEW_LIMIT",
      "The purchase cost source review exceeds 500 lines.",
    );
  const sourceResult = await tx.execute(sql`
    SELECT line.id,line.purchase_order_id,line.line_type,line.order_qty,line.received_qty,line.status,line.total_product_cost_cents,line.packaging_cost_cents,
      line.discount_cents,line.tax_cents,po.currency
    FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.id=ANY(${sql.param(ids)}::int[]) ORDER BY line.id
  `);
  for (const line of sourceResult.rows) {
    if (line.line_type === "product")
      result.set(costInteger(line.id, "purchaseOrderLineId", 1), {
        purchaseOrderLine: line,
        approvedInvoices: [],
      });
  }
  if (result.size === 0) return result;
  const approved = await tx.execute(sql`
    SELECT invoice_line.id,invoice_line.vendor_invoice_id,invoice_line.qty_invoiced,invoice_line.line_total_cents,
      invoice_line.cost_component_evidence,invoice.currency,invoice_line.purchase_order_line_id AS source_line_id
    FROM procurement.vendor_invoice_lines invoice_line
    JOIN procurement.vendor_invoices invoice ON invoice.id=invoice_line.vendor_invoice_id
    WHERE invoice_line.purchase_order_line_id=ANY(${sql.param([...result.keys()])}::int[])
      AND invoice.status IN ('approved','partially_paid','paid') ORDER BY invoice_line.id LIMIT 10001
  `);
  if (approved.rows.length > 10000)
    throw new CostEvidenceError(
      "COST_REVIEW_LIMIT",
      "The complete supplier invoice evidence exceeds 10000 lines.",
    );
  for (const row of approved.rows) {
    const { source_line_id, ...invoice } = row;
    result
      .get(costInteger(source_line_id, "purchaseOrderLineId", 1))!
      .approvedInvoices.push(invoice);
  }
  const credits = await readSupplierCreditCostRows(tx, { purchaseOrderLineIds: [...result.keys()] });
  for (const row of credits) {
    const source = result.get(costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1));
    if (source) (source.supplierCredits ??= []).push(row);
  }
  return result;
}
