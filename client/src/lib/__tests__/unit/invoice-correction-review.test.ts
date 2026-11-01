import { describe, expect, it } from "vitest";
import { invoiceCorrectionMatchesRequest } from "../../invoice-correction-review";
import { invoiceCostComponentsFromForm, invoiceCostReviewForm } from "../../invoice-cost-review-form";
import { invoiceQuantityPreviewSchema, type InvoiceQuantityApprovalRequest } from "@shared/procurement/invoice-quantity-correction";

const version = "a".repeat(64), impactVersion = "b".repeat(64);
const components = { packagingTreatment: "separate" as const, productMills: 101, packagingMills: 99, adjustmentMills: 0 };
function fixture() {
  const request: InvoiceQuantityApprovalRequest = { sourceVersion: version, previewVersion: impactVersion, quantityPieces: 100,
    unitCostMills: 1, lineTotalCents: 2, costComponents: components, approvalConfirmed: true, reason: "Supplier amounts checked" };
  const preview = invoiceQuantityPreviewSchema.parse({ invoiceId: 71, invoiceLineId: 72, purchaseOrderId: 10, sourceVersion: version,
    beforeQuantity: 50, afterQuantity: 100, orderedQuantity: 100, receivedQuantity: 100, otherInvoicedQuantity: 0,
    invoiceLineAmountCents: 1, invoiceAmountCents: 1, paidAmountCents: 0, balanceCents: 1, recordedUnitCostMills: 1,
    beforeAmountPerPiece: "0.000200", afterAmountPerPiece: "0.000200", afterLineAmountCents: 2, afterUnitCostMills: 1,
    beforeMatch: "qty_discrepancy", afterMatch: "matched", remainingIssues: [], warnings: [], previewVersion: impactVersion,
    afterCostComponents: { ...components, contractVersion: 1, source: "operator_review" }, costComponentsReviewed: true,
    costing: { purchaseOrderLineId: 18, needsReview: false, reviewTasks: [], lots: [], inventoryValues: [], orderCosts: [], historicalCosts: [],
      sourceAmounts: (["product", "packaging"] as const).map(component => ({ component,
        before: { totalMills: null, basePieces: 100, evidence: "unknown" }, after: { totalMills: component === "product" ? 101 : 99, basePieces: 100, evidence: "confirmed" } })),
      applications: (["product", "packaging"] as const).map(component => ({ component, purchaseOrderLineId: 18, shipmentId: null,
        status: "applied", lotsUpdated: 0, orderCostsUpdated: 0, orderCostDeltaCents: 0, issues: [] })),
    },
  });
  return { request, preview };
}

describe("invoice correction reviewed intent", () => {
  it("accepts the exact measured invoice and supplier amounts", () => {
    const { request, preview } = fixture(); expect(invoiceCorrectionMatchesRequest(preview, request)).toBe(true);
  });
  it.each(["sourceVersion", "quantityPieces", "unitCostMills", "lineTotalCents", "previewVersion"] as const)("rejects a changed %s", field => {
    const { request, preview } = fixture();
    const changed = { ...request, [field]: field.endsWith("Version") ? "c".repeat(64) : 999 };
    expect(invoiceCorrectionMatchesRequest(preview, changed)).toBe(false);
  });
  it.each(["productMills", "packagingMills", "adjustmentMills", "packagingTreatment"] as const)("rejects changed supplier %s", field => {
    const { request, preview } = fixture();
    const changed = { ...request, costComponents: { ...components, [field]: field === "packagingTreatment" ? "included_in_product" as const : 1 } };
    expect(invoiceCorrectionMatchesRequest(preview, changed)).toBe(false);
  });
  it("requires the complete measured receipt for a new bound confirmation", () => {
    const { request, preview } = fixture(); delete preview.costing;
    expect(invoiceCorrectionMatchesRequest(preview, request)).toBe(false);
  });
  it("does not accept supplier edits the operator never requested", () => {
    const { request, preview } = fixture(); delete request.costComponents;
    expect(invoiceCorrectionMatchesRequest(preview, request)).toBe(false);
  });
  it("decodes a committed legacy receipt without granting any new cost approval", () => {
    const { request, preview } = fixture();
    delete request.previewVersion; delete request.costComponents;
    delete preview.previewVersion; delete preview.costing; delete preview.afterCostComponents; delete preview.costComponentsReviewed;
    expect(invoiceCorrectionMatchesRequest(preview, request)).toBe(true);
  });
});

describe("supplier amounts shared by invoice review and correction", () => {
  it("preserves exact sub-cent component amounts", () => {
    expect(invoiceCostComponentsFromForm({ packagingTreatment: "separate", product: "0.0101", packaging: "0.0099", adjustment: "0", reason: "" }, 2)).toEqual(components);
  });
  it("leaves an unknown supplier breakdown blank instead of defaulting it to zero", () => {
    const form = invoiceCostReviewForm(null);
    expect(form.product).toBe(""); expect(form.packaging).toBe(""); expect(form.adjustment).toBe("");
    expect(() => invoiceCostComponentsFromForm(form, 0)).toThrow();
  });
  it("requires an exact document reconciliation and explicit packaging evidence", () => {
    expect(() => invoiceCostComponentsFromForm({ packagingTreatment: "separate", product: "0.0100", packaging: "0.0099", adjustment: "0", reason: "" }, 2)).toThrow(/exactly/);
    expect(() => invoiceCostComponentsFromForm({ packagingTreatment: "included_in_product", product: "0.0101", packaging: "0.0099", adjustment: "0", reason: "" }, 2)).toThrow(/zero/);
  });
  it("supports an explicitly confirmed zero-price document", () => {
    expect(invoiceCostComponentsFromForm({ packagingTreatment: "included_in_product", product: "0", packaging: "0", adjustment: "0", reason: "" }, 0))
      .toEqual({ packagingTreatment: "included_in_product", productMills: 0, packagingMills: 0, adjustmentMills: 0 });
  });
});
