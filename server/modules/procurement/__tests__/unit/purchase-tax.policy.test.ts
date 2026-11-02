import { describe, expect, it } from "vitest";
import { allocatePurchaseTax, purchaseTaxAmounts, purchaseTaxApprovalTime } from "../../domain/purchase-tax";
import { resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import { purchaseTaxEntriesSchema, purchaseTaxDocumentSchema, purchaseTaxTypeInputSchema } from "@shared/procurement/purchase-tax";
import { shipmentCostCreateSchema } from "@shared/procurement/shipment-cost-command";

const tax = (treatment: "inventory" | "recoverable" | "unclassified", amountMills = 10000) => ({ taxTypeId: treatment === "unclassified" ? null : 1, treatment, amountMills, source: "test-tax" });
function source() {
  return { purchaseOrderLine: { id: 2, purchase_order_id: 1, line_type: "product", status: "open", order_qty: 100, received_qty: 0,
    total_product_cost_cents: 1000, packaging_cost_cents: 100, discount_cents: 0, tax_cents: 100, currency: "USD" } as Record<string, unknown>,
    approvedInvoices: [] as Record<string, unknown>[] };
}
function invoiced(treatment: "inventory" | "recoverable") {
  const data = source();
  data.approvedInvoices = [{ id: 3, vendor_invoice_id: 4, qty_invoiced: 100, line_total_cents: 1300, currency: "USD",
    cost_component_evidence: { contractVersion: 1, packagingTreatment: "separate", productMills: 110000, packagingMills: 10000, adjustmentMills: 10000, source: "operator_review" },
    tax_cost_evidence: [tax(treatment)] }];
  return data;
}

describe("shared purchase tax treatment", () => {
  it("uses the injected clock and preserves monotonic source versions without mutating dates", () => {
    const now = new Date("2026-11-01T10:00:00Z"), later = new Date("2026-11-01T10:00:01Z");
    expect(purchaseTaxApprovalTime(now, [null, later.toISOString()]).toISOString()).toBe("2026-11-01T10:00:01.001Z");
    expect(purchaseTaxApprovalTime(now, []).toISOString()).toBe(now.toISOString());
    expect(later.toISOString()).toBe("2026-11-01T10:00:01.000Z");
    expect(() => purchaseTaxApprovalTime(now, ["invalid"])).toThrow();
    expect(() => purchaseTaxApprovalTime(new Date("invalid"), [])).toThrow();
  });
  it.each(["inventory", "recoverable"] as const)("applies configured %s PO tax without changing the billed amount or inputs", treatment => {
    const input = source(); input.purchaseOrderLine.tax_cost_evidence = [tax(treatment)];
    const before = structuredClone(input), result = resolvePurchaseCostSource(input);
    expect(result[0]).toMatchObject({ component: "product", evidence: "estimated", totalMills: treatment === "inventory" ? 110000 : 100000 });
    expect(result[1].totalMills).toBe(10000); expect(input).toEqual(before);
  });
  it("does not infer eligibility for an unclassified tax", () => {
    const input = source(); input.purchaseOrderLine.tax_cost_evidence = [tax("unclassified")];
    expect(resolvePurchaseCostSource(input)[0]).toMatchObject({ evidence: "review_required", issue: { code: "PURCHASE_TAX_TYPE_REQUIRED" } });
  });
  it.each(["inventory", "recoverable"] as const)("uses actual invoice %s tax instead of adding the PO tax again", treatment => {
    const input = invoiced(treatment), before = structuredClone(input), result = resolvePurchaseCostSource(input);
    expect(result[0]).toMatchObject({ evidence: "confirmed", totalMills: treatment === "inventory" ? 120000 : 110000 });
    expect(result[1].totalMills).toBe(10000); expect(input).toEqual(before);
  });
  it("requires every invoice adjustment to be explained by its named tax", () => {
    const input = invoiced("recoverable");
    input.approvedInvoices[0].tax_cost_evidence = [tax("recoverable", 9000)];
    expect(resolvePurchaseCostSource(input)[0]).toMatchObject({ evidence: "review_required", issue: { code: "INVOICE_COMPONENT_TOTAL_REVIEW" } });
  });
  it("does not promote partially invoiced quantities because tax was configured", () => {
    const input = invoiced("recoverable"); input.approvedInvoices[0].qty_invoiced = 50;
    expect(resolvePurchaseCostSource(input)[0].evidence).toBe("review_required");
  });
  it("separates multiple included, recoverable and unclassified amounts exactly", () => {
    expect(purchaseTaxAmounts([tax("inventory", 101), tax("recoverable", 299), tax("unclassified", 100)]))
      .toEqual({ taxMills: 500, inventoryMills: 101, recoverableMills: 299, unclassifiedMills: 100 });
  });
  it("conserves a cent residual and makes allocation independent of input order", () => {
    const weights = [{ id: 3, goodsCents: 100 }, { id: 1, goodsCents: 100 }, { id: 2, goodsCents: 100 }];
    const expected = [{ lineId: 1, amountMills: 100 }, { lineId: 2, amountMills: 0 }, { lineId: 3, amountMills: 0 }];
    expect(allocatePurchaseTax(1, weights).sort((a, b) => a.lineId - b.lineId)).toEqual(expected);
    expect(allocatePurchaseTax(1, weights.reverse()).sort((a, b) => a.lineId - b.lineId)).toEqual(expected);
  });
  it.each([{ lines: [] }, { lines: [{ id: 1, goodsCents: 0 }] }])("does not invent a tax allocation when the goods basis is absent", ({ lines }) => {
    expect(() => allocatePurchaseTax(100, lines)).toThrow(expect.objectContaining({ code: "PURCHASE_TAX_ALLOCATION_REQUIRED" }));
  });
  it("rejects a duplicate tax type and a fractional-cent document tax", () => {
    expect(purchaseTaxEntriesSchema.safeParse([{ taxTypeId: 1, amountMills: 100 }, { taxTypeId: 1, amountMills: 100 }]).success).toBe(false);
    expect(purchaseTaxEntriesSchema.safeParse([{ taxTypeId: 1, amountMills: 101 }]).success).toBe(false);
    expect(purchaseTaxEntriesSchema.safeParse([{ taxTypeId: 1, amountMills: 0 }]).success).toBe(true);
  });
  it("handles explicit zero tax without inventing a nonzero goods basis", () => {
    expect(allocatePurchaseTax(0, [])).toEqual([]);
    expect(allocatePurchaseTax(0, [{ id: 1, goodsCents: 0 }])).toEqual([{ lineId: 1, amountMills: 0 }]);
    expect(() => allocatePurchaseTax(0, [{ id: 1, goodsCents: 1 }, { id: 1, goodsCents: 1 }])).toThrow();
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "100"])("rejects invalid money %s", value => {
    expect(() => purchaseTaxAmounts([{ ...tax("inventory"), amountMills: value }])).toThrow();
  });
  it("rejects aggregate overflow instead of rounding its inventory value", () => {
    expect(() => purchaseTaxAmounts([tax("inventory", Number.MAX_SAFE_INTEGER), tax("inventory", 1)])).toThrow();
  });
  it("validates explicit tax treatment and document conservation", () => {
    expect(purchaseTaxTypeInputSchema.safeParse({ code: "VAT", name: "VAT", treatment: "guess" }).success).toBe(false);
    expect(purchaseTaxDocumentSchema.safeParse({ kind: "purchase_order", id: 1, reference: "PO", currency: "USD", taxMills: 100, inventoryMills: 100, recoverableMills: 100, unclassifiedMills: 0 }).success).toBe(false);
  });
  it.each(["tax", "duty"])("requires a configured type on each new %s charge without assuming a credit allocation", costType => {
    expect(shipmentCostCreateSchema.safeParse({ costType, actualCents: 100 }).success).toBe(false);
    expect(shipmentCostCreateSchema.safeParse({ costType, actualCents: 100, taxTypeId: 1 }).success).toBe(true);
    expect(shipmentCostCreateSchema.safeParse({ costType, actualCents: -100, taxTypeId: 1 }).success).toBe(false);
  });
});
