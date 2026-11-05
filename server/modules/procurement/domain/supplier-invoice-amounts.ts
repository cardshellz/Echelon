import { invoiceCostComponentEvidenceSchema, invoiceGoodsAmounts } from "@shared/procurement/invoice-cost-evidence";
import { purchaseTaxEvidence, purchaseTaxAmounts, taxTreatmentIssue } from "./purchase-tax";
import { supplierHeaderAmounts } from "./supplier-header-costs";
import { costInteger, CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";
import { readIntegerMills, readIntegerCents } from "@shared/money-read";

/** One selector for supplier amount ownership. Original line components conserve
 * the original line bill; approved header shares are additional, never folded
 * into that reconciliation or allocated twice. */
export function supplierInvoiceAmounts(row: Record<string, unknown>) {
  costInteger(row.qty_invoiced, "original billed quantity", 1);
  if (row.header_cost_issue) throw new CostEvidenceError("SUPPLIER_HEADER_ALLOCATION_REQUIRED", "Review this invoice's original header amounts.");
  const header = supplierHeaderAmounts(row.header_cost_evidence);
  const lineTaxes = purchaseTaxEvidence(row.tax_cost_evidence);
  const headerTaxes = row.header_tax_cost_evidence == null ? header.taxes : purchaseTaxEvidence(row.header_tax_cost_evidence);
  const taxes = [...lineTaxes, ...headerTaxes].map(tax => ({ ...tax, key: `${tax.source}:${tax.taxTypeId ?? "unknown"}` }));
  const taxIssue = taxTreatmentIssue(taxes);
  if (taxIssue) throw new CostEvidenceError(taxIssue.code, taxIssue.message);
  const lineMills = BigInt(costInteger(row.line_total_cents, "original invoice line amount")) * BigInt(100);
  let productMills = 0, packagingMills = 0, packagingTreatment: "separate" | "included_in_product" | "combined" | "not_applicable" = "not_applicable";
  if (row.freight_cost_id == null) {
    const components = invoiceCostComponentEvidenceSchema.parse(row.cost_component_evidence);
    const goods = invoiceGoodsAmounts(components);
    if (BigInt(components.productMills) + BigInt(components.packagingMills) + BigInt(components.adjustmentMills) !== lineMills
      || BigInt(components.adjustmentMills) !== BigInt(goods.adjustmentMills) + BigInt(purchaseTaxAmounts(lineTaxes).taxMills)
      || header.landedMills !== 0) throw new CostEvidenceError("INVOICE_COMPONENT_TOTAL_REVIEW", "Supplier goods, adjustments and tax must reconcile to the original billed line.");
    productMills = readIntegerMills(BigInt(goods.productMills) + BigInt(header.productMills), "supplier goods after header");
    packagingMills = readIntegerMills(BigInt(goods.packagingMills) + BigInt(header.packagingMills), "supplier packaging after header");
    packagingTreatment = components.packagingTreatment;
  }
  const capacityCents = readIntegerCents((lineMills + BigInt(header.totalMills)) / BigInt(100), "allocated supplier bill");
  return { productMills, packagingMills, packagingTreatment, taxes, capacityCents,
    inventoryTaxMills: purchaseTaxAmounts([...lineTaxes, ...headerTaxes]).inventoryMills,
    originalLineCents: costInteger(row.line_total_cents, "original supplier line") };
}

export function supplierInvoiceTaxSource(row: Record<string, unknown>, key: string) {
  if (row.header_cost_issue) return undefined;
  const header = supplierHeaderAmounts(row.header_cost_evidence);
  return [...purchaseTaxEvidence(row.tax_cost_evidence), ...(row.header_tax_cost_evidence == null ? header.taxes : purchaseTaxEvidence(row.header_tax_cost_evidence))]
    .map(tax => ({ ...tax, key: `${tax.source}:${tax.taxTypeId ?? "unknown"}` })).find(tax => tax.key === key);
}
