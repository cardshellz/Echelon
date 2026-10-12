import { describe, expect, it } from "vitest";
import { invoiceAmountPerPiece, invoiceQuantityApprovalRequestSchema, invoiceQuantityPreviewRequestSchema } from "@shared/procurement/invoice-quantity-correction";
import { invoiceQuantityContext, planInvoiceQuantityCorrection, assertInvoiceQuantityAuthority } from "../../invoice-quantity-correction.policy";
import type { InvoiceCorrectionFacts } from "../../invoice-quantity-correction.policy";
import type { AmendmentFacts } from "../../po-quantity-amendment.policy";
import type { PurchaseApprovalActor } from "../../../identity/domain/purchase-approval-authority";

const version = "a".repeat(64);
const admin: PurchaseApprovalActor = { userId: "admin-user", active: true, roles: [{ id: 1, name: "Administrator", isSystem: true }], approvalGrantIds: [1], hasScopedApprovalGrant: false };
function facts(): AmendmentFacts {
  return {
    header: { id: 17, physicalStatus: "received", status: "received", closedAt: null, cancelledAt: null },
    lines: [{ id: 18, lineNumber: 1, lineType: "product", productId: 1, status: "received", orderQty: 25000, receivedQty: 25000, unitCostMills: 5023, unitCostCents: 50, cancelledQty: 0, returnedQty: 0 }],
    invoices: [{ id: 71, status: "paid", currency: "USD", invoicedAmountCents: 669375, paidAmountCents: 669375, balanceCents: 0 }],
    invoiceLines: [{ id: 72, vendorInvoiceId: 71, purchaseOrderLineId: 18, lineNumber: 1, qtyInvoiced: 12500, unitCostMills: 5023, unitCostCents: 50, lineTotalCents: 669375, productName: "Synthetic product", costComponentEvidence: null }],
    recommendationOwned: false,
  } as unknown as AmendmentFacts;
}
const request = (quantityPieces = 25000) => invoiceQuantityPreviewRequestSchema.parse({ sourceVersion: version, quantityPieces });
describe("invoice quantity correction defaults and exact impact", () => {
  it("suggests the agreed received quantity, shows exact averages and preserves all money and input facts", () => {
    const source = facts(), original = structuredClone(source);
    const context = invoiceQuantityContext(source, 72, admin, version);
    expect(context).toMatchObject({ canApprove: true, suggestedQuantity: 25000, suggested: {
      beforeQuantity: 12500, afterQuantity: 25000, invoiceLineAmountCents: 669375, invoiceAmountCents: 669375,
      paidAmountCents: 669375, balanceCents: 0, recordedUnitCostMills: 5023,
      beforeAmountPerPiece: "0.535500", afterAmountPerPiece: "0.267750", beforeMatch: "qty_discrepancy", afterMatch: "matched", remainingIssues: [],
    } });
    expect(planInvoiceQuantityCorrection(source, 72, request())).toEqual(context.suggested);
    expect(source).toEqual(original);
  });
  it("subtracts other invoice coverage instead of defaulting each split line to the entire PO", () => {
    const source = facts(); source.invoiceLines.push({ ...source.invoiceLines[0], id: 73, qtyInvoiced: 5000 });
    expect(invoiceQuantityContext(source, 72, admin, version)).toMatchObject({ suggestedQuantity: 20000, suggested: { otherInvoicedQuantity: 5000, afterMatch: "matched" } });
  });
  it("does not invent a default when the PO and receipt disagree", () => {
    const source = facts(); source.lines[0].receivedQty = 20000;
    expect(invoiceQuantityContext(source, 72, admin, version)).toMatchObject({ suggestedQuantity: null, suggested: null });
    expect(planInvoiceQuantityCorrection(source, 72, request())).toMatchObject({ afterMatch: "over_billed", warnings: expect.arrayContaining([expect.stringContaining("will not clear")]) });
  });
  it("does not mislabel zero counts as an agreed suggested quantity", () => {
    const source = facts(); source.lines[0].orderQty = 0; source.lines[0].receivedQty = 0;
    expect(invoiceQuantityContext(source, 72, admin, version)).toMatchObject({ suggestedQuantity: null, suggestionReason: expect.stringContaining("without a positive PO") });
  });
  it.each([0, 25000, 30000])("does not suggest invalid remaining coverage after %s other pieces", (quantity) => {
    const source = facts(); source.invoiceLines.push({ ...source.invoiceLines[0], id: 73, qtyInvoiced: quantity });
    const context = invoiceQuantityContext(source, 72, admin, version);
    expect(context.suggestedQuantity).toBe(quantity === 0 ? 25000 : null);
  });
  it("allows an explicit override while displaying the unresolved match and unchanged money", () => {
    expect(planInvoiceQuantityCorrection(facts(), 72, request(10000))).toMatchObject({ afterQuantity: 10000, afterMatch: "qty_discrepancy", invoiceLineAmountCents: 669375 });
  });
  it("shows other unmapped invoices that will still block the PO", () => {
    const source = facts(); source.invoices.push({ ...source.invoices[0], id: 73 });
    expect(planInvoiceQuantityCorrection(source, 72, request())).toMatchObject({ afterMatch: "matched", warnings: expect.arrayContaining([expect.stringContaining("no mapped lines")]) });
  });
  it("rejects unchanged quantity", () => { expect(() => planInvoiceQuantityCorrection(facts(), 72, request(12500))).toThrow(/different/); });
  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER])("rejects invalid piece quantity %s", (quantityPieces) => {
    expect(invoiceQuantityPreviewRequestSchema.safeParse({ sourceVersion: version, quantityPieces }).success).toBe(false);
  });
  it("supports the maximum PostgreSQL quantity without changing money", () => { expect(planInvoiceQuantityCorrection(facts(), 72, request(2_147_483_647)).afterQuantity).toBe(2_147_483_647); });
  it.each(["closed", "cancelled", "short_closed"])("blocks a %s PO", (status) => {
    const source = facts(); source.header.physicalStatus = status;
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_BLOCKED" }));
  });
  it("blocks closed legacy header status even without a closure timestamp", () => {
    const source = facts(); source.header.status = "closed";
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/Reopen/);
  });
  it("blocks a voided invoice", () => {
    const source = facts(); source.invoices[0].status = "voided";
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/voided/);
  });
  it("blocks returns and non-product lines", () => {
    const source = facts(); source.lines[0].returnedQty = 1;
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/return/);
    source.lines[0].returnedQty = 0; source.lines[0].lineType = "service";
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/product/);
  });
  it("requires current system administrator authority and an unrestricted grant", () => {
    expect(() => assertInvoiceQuantityAuthority(admin)).not.toThrow();
    for (const actor of [{ ...admin, active: false }, { ...admin, approvalGrantIds: [] }, { ...admin, roles: [{ id: 1, name: "Administrator", isSystem: false }] }, { ...admin, roles: [{ id: 1, name: "Team Lead", isSystem: true }] }]) {
      expect(() => assertInvoiceQuantityAuthority(actor)).toThrow(/Administrator/);
    }
  });
  it("rejects invalid recorded amounts and missing links", () => {
    const source = facts(); source.invoiceLines[0].lineTotalCents = -1;
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/amount/);
    expect(() => planInvoiceQuantityCorrection(facts(), 999, request())).toThrow(/linked/);
  });
  it("classifies malformed canonical match facts as source errors rather than retryable writes", () => {
    const source = facts(); source.lines[0].receivedQty = -1;
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_SOURCE_INVALID" }));
  });
  it("requires explicit confirmation, a reason and a strict source version", () => {
    const value = { ...request(), reason: "Supplier quantity correction", approvalConfirmed: true };
    expect(invoiceQuantityApprovalRequestSchema.safeParse(value).success).toBe(true);
    for (const invalid of [{ ...value, reason: "" }, { ...value, approvalConfirmed: false }, { ...value, sourceVersion: "old" }, { ...value, amount: 100 }]) expect(invoiceQuantityApprovalRequestSchema.safeParse(invalid).success).toBe(false);
  });
  it("calculates display averages with integer rounding at zero and safe money limits", () => {
    expect(invoiceAmountPerPiece(0, 25000)).toBe("0.000000");
    expect(invoiceAmountPerPiece(1, 3)).toBe("0.003333");
    expect(invoiceAmountPerPiece(1, 6)).toBe("0.001667");
    expect(invoiceAmountPerPiece(Number.MAX_SAFE_INTEGER, 1)).toBe("90071992547409.910000");
  });
});

function billingFacts(): InvoiceCorrectionFacts {
  const source = facts();
  return { ...source, billing: { invoiceId: 71, purchaseOrderIds: [17], purchaseAllocations: [{ purchaseOrderId: 17, amountCents: null }], allInvoiceLines: structuredClone(source.invoiceLines),
    allocations: [{ invoiceId: 71, amountCents: 669375, paymentStatus: "completed", currency: "USD" }] } };
}
const financialRequest = (fields = {}) => invoiceQuantityPreviewRequestSchema.parse({ sourceVersion: version, quantityPieces: 25000, unitCostMills: 5355, lineTotalCents: 1338750, ...fields });
describe("reviewed invoice line economics", () => {
  it("preserves the supplier piece price, doubles the bill and exposes the resulting unpaid balance without mutating facts", () => {
    const source = billingFacts(), before = structuredClone(source);
    const preview = planInvoiceQuantityCorrection(source, 72, financialRequest());
    expect(preview).toMatchObject({ beforeQuantity: 12500, afterQuantity: 25000, afterUnitCostMills: 5355,
      invoiceLineAmountCents: 669375, afterLineAmountCents: 1338750, invoiceAmountCents: 669375, afterInvoiceAmountCents: 1338750,
      paidAmountCents: 669375, afterBalanceCents: 669375, beforeInvoiceStatus: "paid", afterInvoiceStatus: "partially_paid", afterAmountPerPiece: "0.535500",
      afterMatch: "price_discrepancy" });
    expect(source).toEqual(before);
  });
  it("allows a price and amount change without changing the piece count", () => {
    expect(planInvoiceQuantityCorrection(billingFacts(), 72, financialRequest({ quantityPieces: 12500 }))).toMatchObject({ afterQuantity: 12500, afterLineAmountCents: 1338750 });
  });
  it("requires explicit billing approval for closed purchases while retaining the goods closure", () => {
    const source = billingFacts(); source.header.status = "closed"; source.header.closedAt = new Date("2026-10-01");
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_BLOCKED" }));
    expect(planInvoiceQuantityCorrection(source, 72, financialRequest({ closedPurchaseOrderConfirmed: true }))).toMatchObject({ closedPurchaseOrder: true, afterBalanceCents: 669375 });
    expect(source.header.status).toBe("closed");
  });
  it("does not let the explicit closed-PO flag override cancellations or returns", () => {
    const source = billingFacts(); source.header.cancelledAt = new Date();
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest({ closedPurchaseOrderConfirmed: true }))).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_BLOCKED" }));
  });
  it("requires complete reconciled invoice and payment evidence", () => {
    expect(() => planInvoiceQuantityCorrection(facts(), 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_CORRECTION_BILLING_REQUIRED" }));
    for (const field of ["invoicedAmountCents", "paidAmountCents", "balanceCents"] as const) {
      const source = billingFacts(); source.invoices[0][field] += 1;
      expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_SOURCE_INVALID" }));
    }
  });
  it("rejects payment currency and invoice scope mismatches", () => {
    const source = billingFacts(); source.billing!.allocations[0].currency = "EUR";
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_SOURCE_INVALID" }));
    source.billing!.allocations[0].currency = "USD"; source.billing!.allInvoiceLines[0].vendorInvoiceId = 99;
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_QUANTITY_SOURCE_INVALID" }));
  });
  it("requires the allocation owner when changing amounts on a multi-PO bill", () => {
    const source = billingFacts(); source.billing!.purchaseOrderIds.push(99);
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_CORRECTION_ALLOCATION_REVIEW_REQUIRED" }));
  });
  it("rejects reducing the bill below recorded payments", () => {
    expect(() => planInvoiceQuantityCorrection(billingFacts(), 72, financialRequest({ lineTotalCents: 0 }))).toThrow(expect.objectContaining({ code: "INVOICE_CORRECTION_PAYMENT_REVIEW_REQUIRED" }));
  });
  it("preserves existing credit lines when reviewing the net invoice amount", () => {
    const source = billingFacts();
    const discount = { ...source.lines[0], id: 19, lineNumber: 2, lineType: "discount", orderQty: 1, receivedQty: 0, unitCostMills: -10000, unitCostCents: -100 };
    source.lines.push(discount);
    const credit = { ...source.invoiceLines[0], id: 73, purchaseOrderLineId: 19, qtyInvoiced: 1, unitCostMills: -10000, unitCostCents: -100, lineTotalCents: -100 };
    source.invoiceLines.push(credit); source.billing!.allInvoiceLines.push(credit);
    source.invoices[0].invoicedAmountCents -= 100; source.invoices[0].paidAmountCents -= 100; source.billing!.allocations[0].amountCents -= 100;
    expect(planInvoiceQuantityCorrection(source, 72, financialRequest())).toMatchObject({ afterInvoiceAmountCents: 1338650, paidAmountCents: 669275, afterBalanceCents: 669375 });
    expect(credit.lineTotalCents).toBe(-100);
  });
  it("updates a full single-PO allocation in the preview and rejects partial allocations", () => {
    const source = billingFacts(); source.billing!.purchaseAllocations[0].amountCents = 669375;
    expect(planInvoiceQuantityCorrection(source, 72, financialRequest())).toMatchObject({ beforeAllocatedToPoCents: 669375, afterAllocatedToPoCents: 1338750 });
    source.billing!.purchaseAllocations[0].amountCents = 100;
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest())).toThrow(expect.objectContaining({ code: "INVOICE_CORRECTION_ALLOCATION_REVIEW_REQUIRED" }));
  });
  it("ignores voided allocations in the same way as the AP ledger owner", () => {
    const source = billingFacts(); source.billing!.allocations.push({ invoiceId: 71, amountCents: 99, currency: "USD", paymentStatus: "voided" });
    expect(planInvoiceQuantityCorrection(source, 72, financialRequest()).afterBalanceCents).toBe(669375);
  });
  it("supports zero-price and zero-amount corrections on an unpaid bill", () => {
    const source = billingFacts(); source.invoices[0].paidAmountCents = 0; source.invoices[0].balanceCents = 669375; source.invoices[0].status = "approved"; source.billing!.allocations = [];
    expect(planInvoiceQuantityCorrection(source, 72, financialRequest({ unitCostMills: 0, lineTotalCents: 0 }))).toMatchObject({ afterInvoiceAmountCents: 0, afterBalanceCents: 0, afterInvoiceStatus: "paid" });
  });
  it.each(["unitCostMills", "lineTotalCents"])("rejects malformed or partial %s fields", field => {
    for (const invalid of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(invoiceQuantityPreviewRequestSchema.safeParse({ ...financialRequest(), [field]: invalid }).success).toBe(false);
    const partial = { ...financialRequest() }; delete partial[field as "unitCostMills" | "lineTotalCents"];
    expect(invoiceQuantityPreviewRequestSchema.safeParse(partial).success).toBe(false);
  });
  it("accepts safe integer limits and rejects a total that exceeds them", () => {
    expect(planInvoiceQuantityCorrection(billingFacts(), 72, financialRequest({ lineTotalCents: Number.MAX_SAFE_INTEGER })).afterInvoiceAmountCents).toBe(Number.MAX_SAFE_INTEGER);
    const source = billingFacts(); source.invoiceLines.push({ ...source.invoiceLines[0], id: 73, lineTotalCents: 1 }); source.billing!.allInvoiceLines.push(source.invoiceLines[1]); source.invoices[0].invoicedAmountCents++; source.invoices[0].balanceCents = 1;
    expect(() => planInvoiceQuantityCorrection(source, 72, financialRequest({ lineTotalCents: Number.MAX_SAFE_INTEGER }))).toThrow(expect.objectContaining({ code: "INVOICE_CORRECTION_AMOUNT_INVALID" }));
  });
});
