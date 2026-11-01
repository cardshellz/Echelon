import { sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import type { CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { readPurchaseCostSources, type PurchaseCostSource } from "./purchase-cost-source.repository";
import { PurchaseTaxError } from "./domain/purchase-tax";
import { projectPurchaseTaxCosts, projectTaxedShipmentSupplierCost, type PurchaseTaxShippingCosts } from "./domain/purchase-tax-costs";

/** Scope aggregation of the same selected extended amounts that the cost writer
 * uses. Recoverable tax is not reconstructed from a rounded unit price or the PO
 * amount after an actual invoice has taken ownership. */
export async function readPurchaseTaxCosts(tx: CostEvidenceTransaction, poId: number, shipping: PurchaseTaxShippingCosts) {
  const records = (await tx.execute(sql`SELECT line.id,line.order_qty,line.line_type,line.line_total_cents,line.tax_type_id,
    po.tax_type_id AS header_tax_type_id,po.discount_cents AS header_discount_cents,po.shipping_cost_cents AS header_shipping_cents
    FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.purchase_order_id=${poId} AND line.status<>'cancelled' ORDER BY line.id LIMIT 10001`)).rows;
  if (records.length > 10000) throw new PurchaseTaxError("Purchase tax costs exceed the complete read limit.", "PURCHASE_TAX_LIMIT");
  const products = records.filter(row => row.line_type === "product");
  const sources = await readPurchaseCostSources(tx, products.map(row => readIntegerCents(row.id, "lineId")));
  return projectPurchaseTaxCosts(records, [...sources.values()], shipping);
}

export async function readTaxedShipmentSupplierCosts(tx: CostEvidenceTransaction,
  lines: readonly { id: number; purchaseOrderLineId: number | null; qtyShipped: number }[], shipmentHasTax: boolean) {
  const ids = [...new Set(lines.flatMap(line => line.purchaseOrderLineId == null ? [] : [line.purchaseOrderLineId]))];
  const sources = new Map<number, PurchaseCostSource>();
  const SOURCE_READ_BATCH_SIZE = 500; // The existing supplier source owner's complete-read limit.
  for (let offset = 0; offset < ids.length; offset += SOURCE_READ_BATCH_SIZE) {
    for (const [id, source] of await readPurchaseCostSources(tx, ids.slice(offset, offset + SOURCE_READ_BATCH_SIZE))) sources.set(id, source);
  }
  const values = new Map<number, { unitCostMills: number | null; reason: string | null }>();
  for (const line of lines) {
    const source = line.purchaseOrderLineId == null ? null : sources.get(line.purchaseOrderLineId);
    if (!source) continue; // The existing product-source validation owns the missing link.
    const result = projectTaxedShipmentSupplierCost(source, line.qtyShipped, shipmentHasTax);
    if (result) values.set(line.id, result);
  }
  return values;
}
