import { describe, expect, it } from "vitest";
import { invoiceAmountPerPiece, invoiceQuantityApprovalRequestSchema, invoiceQuantityPreviewRequestSchema } from "@shared/procurement/invoice-quantity-correction";
import { invoiceQuantityContext, planInvoiceQuantityCorrection, assertInvoiceQuantityAuthority } from "../../invoice-quantity-correction.policy";
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
    expect(() => planInvoiceQuantityCorrection(source, 72, request())).toThrow(/Reopen/);
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
