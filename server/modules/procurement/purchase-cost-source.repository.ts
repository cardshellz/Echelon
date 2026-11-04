import { readReceiptCostingEvidence } from "./receipt-invoice-costs.repository";
import type { ReceiptCostingEvidence } from "./domain/receipt-invoice-costs";
import { sql } from "drizzle-orm";
import {
  costInteger,
  CostEvidenceError,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import { readSupplierCreditCostRows } from "./supplier-credit-source.repository";
import type { SupplierCreditCostRow } from "./domain/supplier-credit-source";
import { readPoTaxEvidence } from "./purchase-tax-evidence.repository";
import { purchaseTaxEvidenceSchema } from "@shared/procurement/purchase-tax";
import { readIntegerMills } from "@shared/money-read";
import { readSupplierHeaderSources, supplierHeaderTargetKey } from "./supplier-header-cost-source.repository";
import { supplierHeaderLineEvidence, supplierHeaderSourceFingerprint, supplierHeaderAmounts } from "./domain/supplier-header-costs";

export interface PurchaseCostSource {
  purchaseOrderLine: Record<string, unknown>;
  approvedInvoices: Record<string, unknown>[];
  supplierCredits?: SupplierCreditCostRow[];
  receiptCosting?: ReceiptCostingEvidence;
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
      line.receipt_costing_enabled AS __receipt_costing,
      line.discount_cents,line.tax_cents,po.currency,
      (COALESCE(po.discount_cents,0)<>0 OR COALESCE(po.shipping_cost_cents,0)<>0 OR COALESCE(line.discount_cents,0)<>0
        OR EXISTS(SELECT 1 FROM procurement.purchase_order_lines adjustment WHERE adjustment.purchase_order_id=po.id
          AND adjustment.line_type NOT IN ('product','tax') AND adjustment.status<>'cancelled')
        OR EXISTS(SELECT 1 FROM procurement.supplier_header_cost_reviews reviewed WHERE reviewed.purchase_order_id=po.id)) AS __header_possible,
      (COALESCE(po.tax_cents,0)<>0 OR po.tax_type_id IS NOT NULL OR line.tax_type_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM procurement.purchase_order_lines tax_line WHERE tax_line.purchase_order_id=po.id
          AND tax_line.line_type='tax' AND tax_line.status<>'cancelled')) AS __tax_possible
    FROM procurement.purchase_order_lines line JOIN procurement.purchase_orders po ON po.id=line.purchase_order_id
    WHERE line.id=ANY(${sql.param(ids)}::int[]) ORDER BY line.id
  `);
  const possibleQuoteTaxes = new Set<number>();
  const possibleQuoteHeaders = new Set<number>();
  const receiptScoped = new Set<number>();
  for (const raw of sourceResult.rows) {
    const { __tax_possible: taxPossible, __header_possible: headerPossible, __receipt_costing: receiptCosting, ...line } = raw;
    if (headerPossible === true) possibleQuoteHeaders.add(costInteger(line.purchase_order_id, "header PO", 1));
    if (costInteger(receiptCosting ?? 0, "receipt invoice policy") === 1) receiptScoped.add(costInteger(line.id, "purchaseOrderLineId", 1));
    if (taxPossible === true || costInteger(line.tax_cents ?? 0, "line tax") !== 0) possibleQuoteTaxes.add(costInteger(line.purchase_order_id, "purchaseOrderId", 1));
    if (line.line_type === "product")
      result.set(costInteger(line.id, "purchaseOrderLineId", 1), {
        purchaseOrderLine: line,
        approvedInvoices: [],
      });
  }
  if (result.size === 0) return result;
  const approved = await tx.execute(sql`
    WITH selected_invoices AS (
      SELECT DISTINCT invoice.id,invoice.invoiced_amount_cents FROM procurement.vendor_invoices invoice
      JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
      WHERE line.purchase_order_line_id=ANY(${sql.param([...result.keys()])}::int[])
        AND invoice.status IN ('approved','partially_paid','paid')
    ), header_amounts AS (
      SELECT invoice.id,invoice.invoiced_amount_cents-COALESCE(sum(line.line_total_cents),0) AS difference,
        EXISTS(SELECT 1 FROM procurement.supplier_header_cost_reviews reviewed WHERE reviewed.vendor_invoice_id=invoice.id) AS has_review
      FROM selected_invoices invoice LEFT JOIN procurement.vendor_invoice_lines line ON line.vendor_invoice_id=invoice.id
      GROUP BY invoice.id,invoice.invoiced_amount_cents
    )
    SELECT invoice_line.id,invoice_line.vendor_invoice_id,invoice_line.qty_invoiced,invoice_line.line_total_cents,
      invoice_line.cost_component_evidence,invoice.currency,invoice_line.purchase_order_line_id AS source_line_id,
      (header_amounts.difference<>0 OR header_amounts.has_review) AS __header_possible,
      (SELECT jsonb_agg(jsonb_build_object('taxTypeId',tax.tax_type_id,'treatment',kind.treatment,'amountMills',tax.amount_mills::text)
        ORDER BY tax.tax_type_id) FROM procurement.vendor_invoice_line_taxes tax
        JOIN procurement.purchase_tax_types kind ON kind.id=tax.tax_type_id WHERE tax.vendor_invoice_line_id=invoice_line.id) AS __tax_entries
    FROM procurement.vendor_invoice_lines invoice_line
    JOIN procurement.vendor_invoices invoice ON invoice.id=invoice_line.vendor_invoice_id
    JOIN header_amounts ON header_amounts.id=invoice.id
    WHERE invoice_line.purchase_order_line_id=ANY(${sql.param([...result.keys()])}::int[])
      AND invoice.status IN ('approved','partially_paid','paid') ORDER BY invoice_line.id LIMIT 10001
  `);
  if (approved.rows.length > 10000)
    throw new CostEvidenceError(
      "COST_REVIEW_LIMIT",
      "The complete supplier invoice evidence exceeds 10000 lines.",
    );
  const invoiceHeaderIds = new Set<number>();
  for (const row of approved.rows) {
    const { source_line_id, __header_possible: headerPossible, __tax_entries: taxEntries, ...invoice } = row;
    if (headerPossible === true) invoiceHeaderIds.add(costInteger(invoice.vendor_invoice_id, "header invoice", 1));
    const taxes = Array.isArray(taxEntries) && taxEntries.length ? taxEntries.map(entry => purchaseTaxEvidenceSchema.parse({
      ...entry, amountMills: readIntegerMills(entry.amountMills, "invoice tax"), source: `invoice_line:${invoice.id}`,
    })).filter(entry => entry.amountMills !== 0) : [];
    result
      .get(costInteger(source_line_id, "purchaseOrderLineId", 1))!
      .approvedInvoices.push(taxes.length ? { ...invoice, tax_cost_evidence: taxes } : invoice);
  }
  // Only selected tax evidence enters source identity. A quote's tax policy is
  // superseded by a complete approved invoice, just like its product price.
  const quoteIds = [...result.values()].filter(source => (source.approvedInvoices.length === 0 || receiptScoped.has(Number(source.purchaseOrderLine.id))))
    .map(source => costInteger(source.purchaseOrderLine.purchase_order_id, "purchaseOrderId", 1)).filter(id => possibleQuoteTaxes.has(id));
  const quoteTaxes = await readPoTaxEvidence(tx, quoteIds);
  for (const [lineId, source] of result) {
    if ((!source.approvedInvoices.length || receiptScoped.has(lineId)) && quoteTaxes.has(lineId)) source.purchaseOrderLine = { ...source.purchaseOrderLine, tax_cost_evidence: quoteTaxes.get(lineId) };
  }
  const quoteHeaderIds = [...new Set([...result.values()].filter(source => !source.approvedInvoices.length || receiptScoped.has(costInteger(source.purchaseOrderLine.id, "PO line", 1)))
    .map(source => costInteger(source.purchaseOrderLine.purchase_order_id, "PO header", 1)).filter(id => possibleQuoteHeaders.has(id)))];
  const headers = await readSupplierHeaderSources(tx, [
    ...quoteHeaderIds.map(id => ({ kind: "purchase_order" as const, id })), ...[...invoiceHeaderIds].map(id => ({ kind: "invoice" as const, id })),
  ]);
  const attachHeader = (row: Record<string, unknown>, kind: "purchase_order" | "invoice", documentId: number) => {
    const selected = headers.get(supplierHeaderTargetKey({ kind, id: documentId }));
    if (!selected) return row;
    if (selected.issue) return { ...row, header_cost_issue: selected.issue,
      header_cost_source: { target: selected.source.target, amountMills: selected.source.expectedMills, fingerprint: supplierHeaderSourceFingerprint(selected.source) } };
    const shares = supplierHeaderLineEvidence(selected.shares, costInteger(row.id, "allocated header line", 1));
    if (!shares.length && !selected.current?.evidence.entries.length) return row;
    const taxes = supplierHeaderAmounts(shares).taxes;
    return { ...row, header_cost_evidence: shares,
      ...(taxes.length ? { header_tax_cost_evidence: taxes } : {}),
    };
  };
  for (const source of result.values()) {
    if (!source.approvedInvoices.length || receiptScoped.has(costInteger(source.purchaseOrderLine.id, "PO line", 1)))
      source.purchaseOrderLine = attachHeader(source.purchaseOrderLine, "purchase_order", costInteger(source.purchaseOrderLine.purchase_order_id, "PO header", 1));
    source.approvedInvoices = source.approvedInvoices.map(row => attachHeader(row, "invoice", costInteger(row.vendor_invoice_id, "invoice header", 1)));
  }
  const credits = await readSupplierCreditCostRows(tx, { purchaseOrderLineIds: [...result.keys()] });
  for (const row of credits) {
    const source = result.get(costInteger(row.purchase_order_line_id, "purchaseOrderLineId", 1));
    if (source) (source.supplierCredits ??= []).push(row);
  }
  for (const id of receiptScoped) { const source = result.get(id); if (source) source.receiptCosting = await readReceiptCostingEvidence(tx, id); }
  return result;
}
