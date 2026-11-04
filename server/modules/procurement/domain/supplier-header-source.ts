import type { SupplierHeaderSource, SupplierHeaderTarget } from "@shared/procurement/supplier-header-costs";
import { invoiceCostComponentEvidenceSchema } from "@shared/procurement/invoice-cost-evidence";
import { readIntegerMills } from "@shared/money-read";
import { costInteger, CostEvidenceError } from "../../inventory/infrastructure/cost-evidence-values";
type Raw = Record<string, unknown>;

export function buildPurchaseOrderHeaderSource(target: SupplierHeaderTarget, rows: Raw[], types: SupplierHeaderSource["types"]): SupplierHeaderSource {
  const first = rows[0], products = rows.filter(row => row.id != null && row.line_type === "product");
  const facts: SupplierHeaderSource["facts"] = [];
  const add = (key: string, label: string, category: "discount" | "supplier_freight" | "other", amount: bigint, lineIds: number[] = []) => {
    if (amount !== BigInt(0)) facts.push({ key, label, category, amountMills: readIntegerMills(amount * BigInt(100), "PO adjustment", true), lineIds });
  };
  add("po_discount", "PO discount", "discount", -BigInt(costInteger(first.header_discount_cents ?? 0, "PO discount")));
  add("po_shipping", "Freight charged on the PO", "supplier_freight", BigInt(costInteger(first.header_shipping_cents ?? 0, "PO shipping")));
  for (const row of rows.filter(row => row.id != null)) {
    const lineId = costInteger(row.id, "PO source line", 1);
    if (row.line_type === "product") add(`line_discount_${lineId}`, `Line ${row.line_number} discount`, "discount", -BigInt(costInteger(row.discount_cents ?? 0, "line discount")), [lineId]);
    else if (row.line_type !== "tax") add(`po_line_${lineId}`, String(row.description || `PO adjustment ${row.line_number}`),
      ["discount", "rebate"].includes(String(row.line_type)) ? "discount" : "other",
      BigInt(costInteger(row.line_total_cents, "PO adjustment", -Number.MAX_SAFE_INTEGER)), row.parent_line_id == null ? [] : [costInteger(row.parent_line_id, "adjustment parent", 1)]);
  }
  return { target, reference: String(first.document_reference), currency: first.currency as "USD", types, facts,
    expectedMills: readIntegerMills(facts.reduce((sum, row) => sum + BigInt(row.amountMills), BigInt(0)), "PO header total", true),
    lines: products.map((row): SupplierHeaderSource["lines"][number] => ({ id: costInteger(row.id, "PO product line", 1), purchaseOrderLineId: costInteger(row.id, "PO product line", 1),
      kind: "product", freightCostId: null, inboundShipmentId: null, name: String(row.product_name || row.sku || row.description || `Line ${row.line_number}`),
      basisMills: readIntegerMills((BigInt(costInteger(row.total_product_cost_cents, "PO product")) + BigInt(costInteger(row.packaging_cost_cents, "PO packaging"))
        - BigInt(costInteger(row.discount_cents ?? 0, "PO discount"))) * BigInt(100), "PO allocation basis"), packagingTreatment: "separate" })),
  };
}

export function buildInvoiceHeaderSource(target: SupplierHeaderTarget, rows: Raw[], types: SupplierHeaderSource["types"]): SupplierHeaderSource {
  const first = rows[0], lines = rows.filter(row => row.id != null);
  const issues: string[] = [];
  const source: SupplierHeaderSource = { target, reference: String(first.document_reference), currency: first.currency as "USD", types, facts: [],
    expectedMills: readIntegerMills((BigInt(costInteger(first.invoiced_amount_cents, "supplier bill")) - lines.reduce((sum, row) =>
      sum + BigInt(costInteger(row.line_total_cents, "invoice line", -Number.MAX_SAFE_INTEGER)), BigInt(0))) * BigInt(100), "invoice header difference", true),
    lines: lines.map((row): SupplierHeaderSource["lines"][number] => {
      const purchaseOrderLineId = row.purchase_order_line_id == null ? null : costInteger(row.purchase_order_line_id, "invoice PO line", 1);
      const freightCostId = row.freight_cost_id == null ? null : costInteger(row.freight_cost_id, "invoice shipment charge", 1);
      if (purchaseOrderLineId !== null && (row.po_vendor_id == null || costInteger(row.po_vendor_id, "PO vendor", 1) !== costInteger(row.vendor_id, "invoice vendor", 1)))
        issues.push("Restore the invoice line's original supplier and PO relationship before allocating its header.");
      if (purchaseOrderLineId !== null && freightCostId !== null)
        issues.push("An invoice line cannot own both product and shipment charge costs. Restore its original source relationship.");
      if (freightCostId !== null && (row.charge_invoice_id == null || costInteger(row.charge_invoice_id, "charge invoice", 1) !== target.id))
        issues.push("Restore the original shipment charge's invoice link before allocating its header.");
      if (freightCostId !== null) {
        const qty = costInteger(row.qty_invoiced, "billed shipment charge quantity", 1);
        const unit = row.unit_cost_mills == null ? BigInt(costInteger(row.unit_cost_cents, "billed shipment charge price")) * BigInt(100)
          : BigInt(costInteger(row.unit_cost_mills, "billed shipment charge price"));
        if (row.charge_vendor_id == null || costInteger(row.charge_vendor_id, "charge supplier", 1) !== costInteger(row.vendor_id, "invoice supplier", 1)
          || row.charge_currency !== first.currency || (unit * BigInt(qty) + BigInt(50)) / BigInt(100) !== BigInt(costInteger(row.line_total_cents, "billed shipment charge amount")))
          issues.push("The shipment charge must match its original supplier, currency, billed quantity, price and line amount.");
      }
      const components = invoiceCostComponentEvidenceSchema.safeParse(row.cost_component_evidence);
      const cents = costInteger(row.line_total_cents, "invoice allocation basis", -Number.MAX_SAFE_INTEGER);
      return { id: costInteger(row.id, "invoice source line", 1), purchaseOrderLineId, freightCostId,
        inboundShipmentId: row.inbound_shipment_id == null ? null : costInteger(row.inbound_shipment_id, "charge shipment", 1),
        kind: freightCostId !== null && purchaseOrderLineId === null ? "shipment_charge" : purchaseOrderLineId !== null && row.po_line_type === "product" ? "product" : "unlinked",
        name: String(row.product_name || row.description || row.sku || `Invoice line ${row.line_number}`),
        basisMills: readIntegerMills(BigInt(cents < 0 ? 0 : cents) * BigInt(100), "invoice allocation basis"),
        packagingTreatment: components.success ? components.data.packagingTreatment : "unknown",
      };
    }),
  };
  return { ...source, ...(issues.length ? { issues: [...new Set(issues)] } : {}) };
}
