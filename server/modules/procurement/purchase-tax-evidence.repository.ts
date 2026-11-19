import { sql } from "drizzle-orm";
import { z } from "zod";
import { readIntegerCents, readIntegerMills } from "@shared/money-read";
import { purchaseTaxTypeSchema, type PurchaseTaxEvidence, type PurchaseTaxType } from "@shared/procurement/purchase-tax";
import { costInteger, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { allocatePurchaseTax, PurchaseTaxError } from "./domain/purchase-tax";

export async function readPurchaseTaxTypes(tx: CostEvidenceTransaction): Promise<PurchaseTaxType[]> {
  const rows = (await tx.execute(sql`SELECT id,code,name,treatment,revision FROM procurement.purchase_tax_types ORDER BY code LIMIT 1001`)).rows;
  if (rows.length > 1000) throw new PurchaseTaxError("Tax types exceed the complete review limit.", "PURCHASE_TAX_LIMIT");
  return z.array(purchaseTaxTypeSchema).parse(rows);
}
function evidence(typeId: unknown, amountMills: number, source: string, types: ReadonlyMap<number, PurchaseTaxType>): PurchaseTaxEvidence {
  const taxTypeId = typeId == null ? null : costInteger(typeId, "taxTypeId", 1), type = taxTypeId === null ? null : types.get(taxTypeId);
  if (taxTypeId !== null && !type) throw new PurchaseTaxError("A saved tax type is missing. No costs were changed.", "PURCHASE_TAX_TYPE_MISSING");
  return { taxTypeId, treatment: type?.treatment ?? "unclassified", amountMills, source };
}

export async function readPoTaxEvidence(tx: CostEvidenceTransaction, purchaseOrderIds: readonly number[]) {
  const ids = [...new Set(purchaseOrderIds.map(id => costInteger(id, "purchaseOrderId", 1)))];
  const result = new Map<number, PurchaseTaxEvidence[]>();
  if (!ids.length) return result;
  const rows = (await tx.execute(sql`SELECT line.id,po.id AS purchase_order_id,line.line_type,line.parent_line_id,line.status,
    line.total_product_cost_cents,line.packaging_cost_cents,line.discount_cents,line.tax_cents,line.line_total_cents,line.tax_type_id,
    po.tax_type_id AS header_tax_type_id,po.tax_cents AS header_tax_cents
    FROM procurement.purchase_orders po LEFT JOIN procurement.purchase_order_lines line ON po.id=line.purchase_order_id
    WHERE po.id=ANY(${sql.param(ids)}::int[]) ORDER BY po.id,line.id LIMIT 10001`)).rows;
  if (rows.length > 10000) throw new PurchaseTaxError("Purchase tax allocation exceeds the complete review limit.", "PURCHASE_TAX_LIMIT");
  const hasTyped = rows.some(row => row.tax_type_id != null || row.header_tax_type_id != null);
  const types = new Map((hasTyped ? await readPurchaseTaxTypes(tx) : []).map(type => [type.id, type]));
  for (const poId of ids) {
    const lines = rows.filter(row => costInteger(row.purchase_order_id, "purchaseOrderId", 1) === poId && row.status !== "cancelled");
    const products = lines.filter(row => row.line_type === "product");
    const targets = products.map(row => ({ id: costInteger(row.id, "lineId", 1), goodsCents: readIntegerCents(
      BigInt(readIntegerCents(row.total_product_cost_cents, "product")) + BigInt(readIntegerCents(row.packaging_cost_cents, "packaging"))
      - BigInt(readIntegerCents(row.discount_cents ?? 0, "discount")), "tax allocation goods") }));
    const add = (lineId: number, entry: PurchaseTaxEvidence) => {
      if (entry.amountMills !== 0) result.set(lineId, [...(result.get(lineId) ?? []), entry]);
    };
    for (const product of products) add(costInteger(product.id, "lineId", 1), evidence(product.tax_type_id ?? product.header_tax_type_id,
      readIntegerMills(BigInt(readIntegerCents(product.tax_cents ?? 0, "line tax")) * BigInt(100), "line tax"), `po_line:${product.id}`, types));
    const split = (typeId: unknown, cents: number, source: string, selected = targets) => {
      if (cents === 0) return;
      for (const share of allocatePurchaseTax(cents, selected)) add(share.lineId, evidence(typeId, share.amountMills, source, types));
    };
    if (lines[0]) split(lines[0].header_tax_type_id, readIntegerCents(lines[0].header_tax_cents ?? 0, "header tax"), `po_header:${poId}`);
    for (const line of lines.filter(row => row.line_type === "tax")) {
      const selected = line.parent_line_id == null ? targets : targets.filter(target => target.id === costInteger(line.parent_line_id, "tax parent line", 1));
      split(line.tax_type_id ?? line.header_tax_type_id, readIntegerCents(line.line_total_cents, "tax line"), `po_tax_line:${line.id}`, selected);
    }
  }
  return result;
}

export async function readInvoiceTaxEvidence(tx: CostEvidenceTransaction, invoiceLineIds: readonly number[]) {
  const ids = [...new Set(invoiceLineIds.map(id => costInteger(id, "invoiceLineId", 1)))];
  const result = new Map<number, PurchaseTaxEvidence[]>();
  if (!ids.length) return result;
  const rows = (await tx.execute(sql`SELECT tax.vendor_invoice_line_id,tax.tax_type_id,tax.amount_mills,kind.treatment
    FROM procurement.vendor_invoice_line_taxes tax JOIN procurement.purchase_tax_types kind ON kind.id=tax.tax_type_id
    WHERE tax.vendor_invoice_line_id=ANY(${sql.param(ids)}::int[]) ORDER BY tax.vendor_invoice_line_id,tax.tax_type_id LIMIT 10001`)).rows;
  if (rows.length > 10000) throw new PurchaseTaxError("Invoice tax evidence exceeds the complete review limit.", "PURCHASE_TAX_LIMIT");
  for (const row of rows) {
    const lineId = costInteger(row.vendor_invoice_line_id, "invoiceLineId", 1);
    const entry: PurchaseTaxEvidence = { taxTypeId: costInteger(row.tax_type_id, "taxTypeId", 1),
      treatment: z.enum(["inventory", "recoverable"]).parse(row.treatment), amountMills: readIntegerMills(row.amount_mills, "invoice tax"), source: `invoice_line:${lineId}` };
    result.set(lineId, [...(result.get(lineId) ?? []), entry]);
  }
  return result;
}

export async function readShipmentTaxEvidence(tx: CostEvidenceTransaction, shipmentIds: readonly number[]) {
  const ids = [...new Set(shipmentIds.map(id => costInteger(id, "shipmentId", 1)))];
  if (!ids.length) return new Map<number, PurchaseTaxEvidence>();
  const rows = (await tx.execute(sql`SELECT cost.id,cost.tax_type_id,cost.cost_type,cost.actual_cents,cost.estimated_cents,kind.treatment
    FROM procurement.inbound_freight_costs cost JOIN procurement.purchase_tax_types kind ON kind.id=cost.tax_type_id
    WHERE cost.inbound_shipment_id=ANY(${sql.param(ids)}::int[]) ORDER BY cost.id LIMIT 10001`)).rows;
  if (rows.length > 10000) throw new PurchaseTaxError("Shipment tax evidence exceeds the complete review limit.", "PURCHASE_TAX_LIMIT");
  return new Map(rows.map(row => {
    if (!["tax", "duty"].includes(String(row.cost_type))) throw new PurchaseTaxError("Only a tax or duty shipment charge can have a tax treatment.", "PURCHASE_TAX_SOURCE_INVALID");
    const id = costInteger(row.id, "chargeId", 1);
    return [id, { taxTypeId: costInteger(row.tax_type_id, "taxTypeId", 1), treatment: z.enum(["inventory", "recoverable"]).parse(row.treatment),
      amountMills: readIntegerMills(BigInt(readIntegerCents(row.actual_cents ?? row.estimated_cents, "shipment tax")) * BigInt(100), "shipment tax"), source: `shipment_charge:${id}` }];
  }));
}

/** Financial charge shares remain gross. Only the inventory-valued share is
 * excluded; allocation, AP amount, measurements and stock counts are preserved. */
export async function readShipmentRecoverableTaxAllocations(tx: CostEvidenceTransaction, shipmentId: number,
  knownCosts?: readonly { taxTypeId?: number | null }[]) {
  // Callers already reading the complete charge list need no extra SQL for an
  // untaxed shipment. Undefined on older in-memory DTOs is the nullable field.
  if (knownCosts && knownCosts.every(cost => cost.taxTypeId == null)) return new Map<number, number>();
  const taxes = await readShipmentTaxEvidence(tx, [shipmentId]);
  const excluded = [...taxes].filter(([, tax]) => tax.treatment === "recoverable").map(([id]) => id);
  const amounts = new Map<number, number>();
  if (!excluded.length) return amounts;
  const rows = (await tx.execute(sql`SELECT inbound_shipment_line_id,SUM(allocated_cents)::text AS cents
    FROM procurement.inbound_freight_allocations WHERE shipment_cost_id=ANY(${sql.param(excluded)}::int[])
    GROUP BY inbound_shipment_line_id ORDER BY inbound_shipment_line_id LIMIT 10001`)).rows;
  if (rows.length > 10000) throw new PurchaseTaxError("Shipment tax shares exceed the complete review limit.", "PURCHASE_TAX_LIMIT");
  for (const row of rows) amounts.set(costInteger(row.inbound_shipment_line_id, "shipmentLineId", 1), readIntegerCents(row.cents, "recoverable tax share"));
  return amounts;
}
