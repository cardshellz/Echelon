import { describe, expect, it } from "vitest";
import { projectPurchaseTaxCosts, projectTaxedShipmentSupplierCost } from "../../domain/purchase-tax-costs";
import { projectPoLineLandedCosts } from "@shared/procurement/po-line-landed-cost";
import { purchaseTaxSettingsChanges } from "@shared/procurement/purchase-tax-settings";
import type { PurchaseTaxContext } from "@shared/procurement/purchase-tax";

const make = () => {
  const tax = { taxTypeId: 1, treatment: "recoverable", amountMills: 100000, source: "invoice_line:3" };
  const source = { purchaseOrderLine: { id: 1, purchase_order_id: 10, line_type: "product", status: "received", order_qty: 100, received_qty: 100,
    total_product_cost_cents: 10000, packaging_cost_cents: 1000, tax_cents: 0, currency: "USD" },
    approvedInvoices: [{ id: 3, vendor_invoice_id: 2, qty_invoiced: 100, line_total_cents: 13000, currency: "USD", tax_cost_evidence: [tax],
      cost_component_evidence: { contractVersion: 1, source: "operator_review", packagingTreatment: "separate", productMills: 1100000, packagingMills: 100000, adjustmentMills: 100000 } }] };
  const records = [{ id: 1, order_qty: 100, line_type: "product", line_total_cents: 11000, tax_type_id: null, header_tax_type_id: null, header_discount_cents: 0, header_shipping_cents: 0 }];
  const shipping = { complete: true, lines: [{ lineId: 11, purchaseOrderLineId: 1, allocatedCents: 1000 }, { lineId: 12, purchaseOrderLineId: 1, allocatedCents: 1000 }], recoverableByShipmentLine: new Map([[11, 200], [12, 300]]) };
  return { source, records, shipping };
};
describe("selected tax-cost display projection", () => {
  it("conserves split-shipment shares and invoice precedence without mutating any inputs", () => {
    const input = make(), before = structuredClone(input);
    const result = projectPurchaseTaxCosts(input.records, [input.source], input.shipping);
    expect(result).toMatchObject({ supplierInventoryCents: 12000, shipmentInventoryCents: 1500, inventoryLandedCents: 13500, recoverableSupplierTaxCents: 1000, recoverableShipmentTaxCents: 500,
      lines: [{ purchaseOrderLineId: 1, supplierInventoryCents: 12000, shipmentInventoryCents: 1500, inventoryLandedCents: 13500 }] });
    expect(input).toEqual(before);
    expect(projectPoLineLandedCosts({ poHeader: { totalCents: 11000 }, poLines: [{ id: 1, orderQty: 100, lineTotalCents: 11000 }],
      costs: { taxCosts: result, summary: { poAmountCents: 11000, totalCents: 2000, combinedCostCents: 13000 }, lines: input.shipping.lines } }))
      .toMatchObject({ status: "complete", lines: [{ totalCents: 13500 }] });
  });
  it("rejects missing sources, duplicate charge shares and another PO's line rather than dropping money", () => {
    const { source, records, shipping } = make();
    expect(() => projectPurchaseTaxCosts(records, [], shipping)).toThrow(/sources/);
    expect(() => projectPurchaseTaxCosts(records, [source], { ...shipping, lines: [shipping.lines[0], shipping.lines[0]] })).toThrow(/unique/);
    expect(() => projectPurchaseTaxCosts(records, [source], { ...shipping, lines: [{ ...shipping.lines[0], purchaseOrderLineId: 2 }] })).toThrow(/purchase line/);
  });
  it("leaves an incomplete shipment or unknown supplier amount visibly incomplete", () => {
    const { source, records, shipping } = make();
    expect(projectPurchaseTaxCosts(records, [source], { ...shipping, complete: false })).toMatchObject({ inventoryLandedCents: null, shipmentInventoryCents: null, reason: expect.stringMatching(/allocation/) });
    const unknown = { ...source, approvedInvoices: [{ ...source.approvedInvoices[0], cost_component_evidence: null }] };
    expect(projectPurchaseTaxCosts(records, [unknown], shipping)).toMatchObject({ inventoryLandedCents: null, supplierInventoryCents: null });
  });
  it("uses the same supplier amounts in shipment landed rates, including packaging and tax", () => {
    const { source } = make();
    expect(projectTaxedShipmentSupplierCost(source, 40, true)).toEqual({ unitCostMills: 12000, reason: null });
    const included = structuredClone(source); included.approvedInvoices[0].tax_cost_evidence[0].treatment = "inventory";
    expect(projectTaxedShipmentSupplierCost(included, 40, true)?.unitCostMills).toBe(13000);
  });
  it("does not average multiple invoices or apply a receipt's price to uncovered shipped pieces", () => {
    const { source } = make();
    expect(projectTaxedShipmentSupplierCost({ ...source, approvedInvoices: [...source.approvedInvoices, { ...source.approvedInvoices[0], id: 4 }] }, 40, true)?.unitCostMills).toBeNull();
    expect(projectTaxedShipmentSupplierCost(source, 101, true)?.unitCostMills).toBeNull();
  });
  it("keeps unrelated untaxed display behavior unchanged", () => {
    const { source, records } = make(), plain = { ...source, approvedInvoices: [] };
    expect(projectTaxedShipmentSupplierCost(plain, 100, false)).toBeUndefined();
    expect(projectPurchaseTaxCosts(records, [plain], { complete: true, lines: [], recoverableByShipmentLine: new Map() })).toBeUndefined();
  });
  it("shows the actual rule before and after even when no goods have been received", () => {
    const context: Pick<PurchaseTaxContext, "current" | "types" | "lines" | "invoice"> = {
      current: { kind: "tax_type", id: 1, code: "VAT", name: "Supplier VAT", treatment: "inventory" }, types: [], lines: [], invoice: null };
    expect(purchaseTaxSettingsChanges(context, { ...context.current!, kind: "tax_type", id: 1, code: "VAT", name: "Supplier VAT", treatment: "recoverable" }))
      .toEqual([{ label: "Tax treatment", before: "Inventory cost", after: "Recoverable tax" }]);
  });
  it("retains saved invoice taxes when supplier component evidence is still missing", () => {
    const context: Pick<PurchaseTaxContext, "current" | "types" | "lines" | "invoice"> = { current: null,
      types: [{ id: 1, code: "VAT", name: "Supplier VAT", treatment: "recoverable", revision: 1 }], lines: [],
      invoice: { totalCents: 12000, currency: "USD", taxes: [{ taxTypeId: 1, amountMills: 100000 }], components: null } };
    const before = structuredClone(context);
    expect(purchaseTaxSettingsChanges(context, { kind: "invoice_line", id: 1, taxes: [{ taxTypeId: 1, amountMills: 50000 }],
      components: { contractVersion: 1, source: "operator_review", packagingTreatment: "separate", productMills: 1100000, packagingMills: 50000, adjustmentMills: 50000 } }))
      .toEqual([{ label: "VAT · Supplier VAT · Recoverable tax", before: "10.00 USD", after: "5.00 USD" }]);
    expect(context).toEqual(before);
  });
});
