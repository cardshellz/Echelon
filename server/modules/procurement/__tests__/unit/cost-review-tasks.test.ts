import { describe, expect, it } from "vitest";
import { buildCostReviewGroups, costReviewSummary, shipmentCostReviewTasks, supplierCostReviewTasks, type CostReviewShipmentLine } from "@shared/procurement/cost-review-tasks";
import { purchaseCostReviewFacts, resolvePurchaseCostSource } from "../../domain/purchase-cost-source";
import type { PurchaseLineCostStatus } from "@shared/procurement/purchase-cost-status";
import { costFingerprint } from "../../../inventory/infrastructure/cost-evidence-values";

const evidence = { contractVersion: 1, packagingTreatment: "included_in_product", productMills: 1000000, packagingMills: 0, adjustmentMills: 0, source: "operator_review" };
function source() { return { purchaseOrderLine: { id: 21, purchase_order_id: 10, order_qty: 200, received_qty: 100, status: "received", total_product_cost_cents: 10000, packaging_cost_cents: 0, currency: "USD" },
  approvedInvoices: [{ id: 72, vendor_invoice_id: 71, qty_invoiced: 100, line_total_cents: 10000, currency: "USD", cost_component_evidence: evidence }] }; }
function line(): PurchaseLineCostStatus {
  return { purchaseOrderId: 10, purchaseOrderLineId: 21, sku: "SAME-SKU", reviewFacts: purchaseCostReviewFacts(source()),
    components: ["product", "packaging"].map(component => ({ component: component as "product" | "packaging", status: "review_required", sourceEvidence: "review_required", sourceCurrent: false, sourceRevisionId: null, applicationId: null,
      issues: [{ code: "INVOICE_COMPONENT_REVIEW_REQUIRED", message: "Legacy combined source check" }] })),
    invoices: [{ invoiceId: 71, invoiceNumber: "TEST-INVOICE", lineId: 72, lineNumber: 1 }], receipts: [], lots: [] };
}
function shipment(): CostReviewShipmentLine { return { lineId: 11, purchaseOrderLineId: 21, shipmentId: 1, shipmentNumber: "TEST-SHIPMENT", sku: "SAME-SKU", posted: false, amountCents: 5000, currency: "USD", recordedAt: null, issues: [] }; }

describe("shared human-readable cost tasks", () => {
  it("reports an actual quantity difference without claiming packaging is missing", () => {
    const current = line(); current.reviewFacts = { ...current.reviewFacts!, invoicedPieces: 50, quantityMatches: false };
    expect(supplierCostReviewTasks(current)).toEqual([expect.objectContaining({ action: "invoice_quantity", title: "Invoice quantity differs", explanation: expect.stringContaining("Invoice: 50 pieces. Received: 100 pieces.") })]);
  });
  it("reports missing amounts without inventing a quantity mismatch or two component tasks", () => {
    const current = line(); current.reviewFacts!.missingAmountLineIds = [72];
    expect(supplierCostReviewTasks(current)).toHaveLength(1);
    expect(supplierCostReviewTasks(current)[0]).toMatchObject({ action: "invoice_amounts", invoiceLineId: 72 });
  });
  it("shows both independent problems when both checks fail", () => {
    const current = line(); current.reviewFacts = { ...current.reviewFacts!, invoicedPieces: 50, quantityMatches: false, missingAmountLineIds: [72] };
    expect(supplierCostReviewTasks(current).map(task => task.action)).toEqual(["invoice_quantity", "invoice_amounts"]);
  });
  it("does not guess which combined check failed on an older response", () => {
    const current = line(); delete current.reviewFacts;
    expect(supplierCostReviewTasks(current)).toEqual([expect.objectContaining({ action: "invoice_amounts", explanation: expect.stringContaining("exact invoice check is unavailable") })]);
  });
  it("does not turn an approved posting's old issues into new tasks", () => {
    expect(shipmentCostReviewTasks({ ...shipment(), posted: true, issues: [{ code: "COST_HISTORICAL_LINEAGE_MISSING", message: "Original historical gap" }] })).toEqual([]);
    const current = line(); current.components = current.components.map(component => ({ ...component, status: "applied", sourceEvidence: "confirmed", issues: [] }));
    expect(supplierCostReviewTasks(current)).toEqual([]);
  });
  it("keeps supplier confirmation separate from a successfully posted estimate", () => {
    const current = line(); current.invoices = []; current.components = current.components.map(component => ({ ...component, status: "applied", sourceEvidence: "estimated", issues: [] }));
    expect(supplierCostReviewTasks(current)).toEqual([expect.objectContaining({ action: "record_invoice" })]);
  });
  it("groups supplier and split shipping tasks by the PO line, never by SKU", () => {
    const first = line(), second = { ...line(), purchaseOrderId: 20, purchaseOrderLineId: 22 };
    const groups = buildCostReviewGroups({ lines: [first, second] }, [shipment(), { ...shipment(), lineId: 12, shipmentId: 2 }, { ...shipment(), lineId: 13, purchaseOrderLineId: 22 }]);
    expect(groups).toHaveLength(2);
    expect(groups[0].shipments.map(row => row.lineId)).toEqual([11, 12]);
    expect(groups[1].shipments.map(row => row.lineId)).toEqual([13]);
    expect(groups[0].shipments.map(row => row.amountCents)).toEqual([5000, 5000]);
  });
  it("keeps unknown relationships visible rather than attaching a matching SKU", () => {
    const groups = buildCostReviewGroups({ lines: [line()] }, [{ ...shipment(), purchaseOrderLineId: null }]);
    expect(groups).toHaveLength(2); expect(groups[1].supplier).toBeUndefined();
  });
  it("has one count for supplier and shipping tasks without mutating inputs", () => {
    const inputs = { supplier: { lines: [line()] }, shipments: [shipment()] }, before = structuredClone(inputs);
    expect(costReviewSummary(buildCostReviewGroups(inputs.supplier, inputs.shipments))).toBe("2 items need attention");
    expect(inputs).toEqual(before);
    expect(costReviewSummary([])).toBe("Costs are up to date");
  });
  it("does not offer another stock-link approval when links were already reviewed", () => {
    const current = { ...shipment(), issues: [{ code: "COST_UNRESOLVED_QUANTITY_RETAINED", message: "Movement missing", costLinksAlreadyReviewed: true as const }] };
    expect(shipmentCostReviewTasks(current)[0]).toMatchObject({ action: "review_history", title: "Some stock movements are missing" });
  });
  it("keeps an unknown recorded failure visible rather than promising a retry fixes it", () => {
    expect(shipmentCostReviewTasks({ ...shipment(), issues: [{ code: "NEW_ACCOUNTING_REVIEW", message: "Exact saved reason" }] })[0]).toMatchObject({ action: "accounting", explanation: "Exact saved reason" });
  });
});

describe("display facts do not revise financial authority", () => {
  it("uses received coverage after completion and ordered coverage before completion", () => {
    expect(purchaseCostReviewFacts(source())).toMatchObject({ quantityBasis: "received", expectedPieces: 100, invoicedPieces: 100, quantityMatches: true, missingAmountLineIds: [] });
    const current = source(); current.purchaseOrderLine.status = "open";
    expect(purchaseCostReviewFacts(current)).toMatchObject({ quantityBasis: "ordered", expectedPieces: 200, quantityMatches: false });
  });
  it("separates missing evidence from differing quantities using the exact saved values", () => {
    const current = source(); current.approvedInvoices[0].cost_component_evidence = null as unknown as typeof evidence;
    expect(purchaseCostReviewFacts(current)).toMatchObject({ quantityMatches: true, missingAmountLineIds: [72], invoiceAmountCents: 10000 });
    current.approvedInvoices[0].qty_invoiced = 50;
    expect(purchaseCostReviewFacts(current)).toMatchObject({ expectedPieces: 100, invoicedPieces: 50, quantityMatches: false });
  });
  it("does not change the existing cost source or fingerprint while explaining it", () => {
    const current = source(), before = structuredClone(current), resolved = resolvePurchaseCostSource(current), fingerprint = costFingerprint(resolved);
    purchaseCostReviewFacts(current);
    expect(current).toEqual(before); expect(costFingerprint(resolvePurchaseCostSource(current))).toBe(fingerprint);
    expect(resolved).toMatchObject([{ component: "product", evidence: "confirmed", basePieces: 100, totalMills: 1000000 }, { component: "packaging", totalMills: 0 }]);
    expect(JSON.stringify(resolved)).not.toContain("reviewFacts");
  });
  it("rejects unsafe totals instead of displaying a rounded quantity or amount", () => {
    const current = source(); current.approvedInvoices = [{ ...current.approvedInvoices[0], line_total_cents: Number.MAX_SAFE_INTEGER }, { ...current.approvedInvoices[0], id: 73, line_total_cents: 1 }];
    expect(() => purchaseCostReviewFacts(current)).toThrow();
  });
});
