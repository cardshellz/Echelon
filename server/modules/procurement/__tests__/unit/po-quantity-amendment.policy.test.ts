import { describe, expect, it } from "vitest";
import { poQuantityApprovalRequestSchema, poQuantityPreviewRequestSchema } from "@shared/procurement/po-quantity-amendment";
import { hasQuantityAmendmentAuthority, planQuantityAmendment, quantityAmendmentBlockedReason, quantityAmendmentTimestamp, type AmendmentFacts } from "../../po-quantity-amendment.policy";
import type { PurchaseApprovalActor } from "../../../identity/domain/purchase-approval-authority";

function facts(): AmendmentFacts {
  // The domain uses these explicit commercial facts; DB defaults/constraints
  // and full row snapshots are separately exercised by the PostgreSQL suite.
  return {
    header: { id: 1, status: "received", physicalStatus: "received", currency: "USD", totalCents: 1100, subtotalCents: 1100, discountCents: 0, taxCents: 0, shippingCostCents: 0, closedAt: null, cancelledAt: null },
    lines: [{ id: 11, purchaseOrderId: 1, lineNumber: 1, productId: 1, productName: "Test product", lineType: "product", parentLineId: null, orderQty: 10, receivedQty: 20, cancelledQty: 0, returnedQty: 0, status: "received", unitCostCents: 100, unitCostMills: 10000, totalProductCostCents: 1000, packagingCostCents: 100, discountCents: 0, taxCents: 0, lineTotalCents: 1100, pricingBasis: "per_piece", quotedUnitCostMills: 10000 }],
    invoices: [{ id: 71, status: "paid" }],
    invoiceLines: [{ id: 81, vendorInvoiceId: 71, purchaseOrderLineId: 11, qtyInvoiced: 10, unitCostCents: 100, unitCostMills: 10000 }],
    recommendationOwned: false,
  } as unknown as AmendmentFacts;
}
const request = (qty = 20, treatment: "keep_product_total" | "keep_quoted_rate" = "keep_product_total") => poQuantityPreviewRequestSchema.parse({ sourceVersion: "a".repeat(64), changes: [{ lineId: 11, quantityPieces: qty, priceTreatment: treatment }], reason: "Supplier confirmed incorrect purchased quantity" });
const admin: PurchaseApprovalActor = { userId: "admin", active: true, roles: [{ id: 1, name: "Administrator", isSystem: true }], approvalGrantIds: [1], hasScopedApprovalGrant: false };

describe("audited PO quantity amendment policy", () => {
  it("requires current system administrator membership and unrestricted purchasing approval", () => {
    expect(hasQuantityAmendmentAuthority(admin)).toBe(true);
    for (const actor of [{ ...admin, active: false }, { ...admin, roles: [{ id: 1, name: "Administrator", isSystem: false }] }, { ...admin, roles: [{ id: 2, name: "Team Lead", isSystem: true }] }, { ...admin, approvalGrantIds: [], hasScopedApprovalGrant: true }]) expect(hasQuantityAmendmentAuthority(actor)).toBe(false);
  });
  it("preserves the agreed total while deriving a new exact unit price, without changing source facts", () => {
    const source = facts(); const original = structuredClone(source);
    const plan = planQuantityAmendment(source, request());
    expect(plan.preview).toMatchObject({ beforeTotalCents: 1100, afterTotalCents: 1100, afterStatus: "received", lines: [{ after: { orderQty: 20, receivedQty: 20, invoicedQty: 10, unitCostMills: 5000 } }] });
    expect(plan.patches[0].patch).toMatchObject({ pricingBasis: "extended_total", pricingSource: "manual", quotedTotalCents: 1000, totalProductCostCents: 1000, lineTotalCents: 1100 });
    expect(plan.preview.invoiceMatches[0].after).toBe("price_discrepancy");
    expect(source).toEqual(original);
  });
  it("preserves the quote rate, recomputes total and leaves invoice quantity differences visible", () => {
    const plan = planQuantityAmendment(facts(), request(20, "keep_quoted_rate"));
    expect(plan.preview).toMatchObject({ afterTotalCents: 2100, lines: [{ after: { unitCostMills: 10000, totalProductCostCents: 2000 } }] });
    expect(plan.preview.invoiceMatches[0].after).toBe("qty_discrepancy");
  });
  it("uses exact rounding and preserves quote residuals", () => {
    const plan = planQuantityAmendment(facts(), request(3));
    expect(plan.patches[0].patch).toMatchObject({ unitCostMills: 33333, pricingRemainderMills: 1, totalProductCostCents: 1000 });
  });
  it("preserves purchase UOM provenance when keeping its quote rate", () => {
    const source = facts(); Object.assign(source.lines[0], { pricingBasis: "per_purchase_uom", purchaseUom: "case", piecesPerPurchaseUom: 5, purchaseUomQuantity: 2, quotedUnitCostMills: 50000 });
    expect(planQuantityAmendment(source, request(20, "keep_quoted_rate")).patches[0].patch).toMatchObject({ pricingBasis: "per_purchase_uom", purchaseUom: "case", purchaseUomQuantity: 4, piecesPerPurchaseUom: 5, quotedUnitCostMills: 50000, totalProductCostCents: 2000 });
    expect(() => planQuantityAmendment(source, request(13, "keep_quoted_rate"))).toThrow(/whole number/);
  });
  it("marks additional unreceived quantity as receiving, without rewriting received quantity", () => {
    expect(planQuantityAmendment(facts(), request(30)).preview).toMatchObject({ beforeStatus: "received", afterStatus: "partially_received", lines: [{ after: { receivedQty: 20, orderQty: 30, status: "partially_received" } }] });
  });
  it("warns about overreceipt instead of inventing receipt corrections", () => {
    expect(planQuantityAmendment(facts(), request(5)).preview.warnings).toContain("Line 1 remains over-received: 20 received against 5 ordered.");
  });
  it("allows explicit zero cost and fails safely on money overflow", () => {
    const source = facts(); Object.assign(source.lines[0], { unitCostMills: 0, unitCostCents: 0, quotedUnitCostMills: 0, totalProductCostCents: 0, lineTotalCents: 100 }); source.header.subtotalCents = source.header.totalCents = 100;
    expect(planQuantityAmendment(source, request(20, "keep_quoted_rate")).preview.afterTotalCents).toBe(100);
    source.lines[0].quotedUnitCostMills = Number.MAX_SAFE_INTEGER;
    expect(() => planQuantityAmendment(source, request(2_147_483_647, "keep_quoted_rate"))).toThrow(/range/);
  });
  it.each(["draft", "pending_approval", "closed", "cancelled", "short_closed"])("blocks unsupported PO status %s", (status) => { const source = facts(); source.header.status = status; expect(quantityAmendmentBlockedReason(source)).not.toBeNull(); expect(() => planQuantityAmendment(source, request())).toThrow(); });
  it("keeps accepted recommendation economics immutable", () => { const source = facts(); source.recommendationOwned = true; expect(() => planQuantityAmendment(source, request())).toThrow(/immutable/); });
  it.each([{ returnedQty: 1 }, { cancelledQty: 1 }, { status: "closed" }, { parentLineId: 2 }, { lineType: "fee" }])("blocks unsupported line ownership/activity %j", (patch) => { const source = facts(); Object.assign(source.lines[0], patch); expect(() => planQuantityAmendment(source, request())).toThrow(); });
  it("rejects foreign lines, no-op quantities and unreconciled source amounts", () => {
    const foreign = request(); foreign.changes[0].lineId = 12;
    expect(() => planQuantityAmendment(facts(), foreign)).toThrow(/belong/);
    expect(() => planQuantityAmendment(facts(), request(10))).toThrow(/different/);
    const source = facts(); source.lines[0].totalProductCostCents = 0; expect(() => planQuantityAmendment(source, request())).toThrow(/reconcile/);
    source.header.subtotalCents = 1101; expect(() => planQuantityAmendment(source, request())).toThrow(/reconcile/);
  });
  it("validates duplicate lines, fractions, zero, PG overflow, unsupported prices and explicit approval", () => {
    for (const quantityPieces of [0, -1, 1.5, 2_147_483_648, NaN]) expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), changes: [{ ...request().changes[0], quantityPieces }] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), changes: [request().changes[0], request().changes[0]] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), changes: [{ ...request().changes[0], priceTreatment: "guess" }] }).success).toBe(false);
    expect(poQuantityApprovalRequestSchema.safeParse(request()).success).toBe(false);
    expect(poQuantityApprovalRequestSchema.safeParse({ ...request(), approvalConfirmed: true, actorId: "forged" }).success).toBe(false);
  });
  it("plans multiple corrections together and recomputes aggregate receiving status", () => {
    const source = facts(); source.lines.push({ ...source.lines[0], id: 12, lineNumber: 2 }); source.header.subtotalCents = source.header.totalCents = 2200;
    const correction = request(); correction.changes.push({ lineId: 12, quantityPieces: 30, priceTreatment: "keep_product_total" });
    const plan = planQuantityAmendment(source, correction);
    expect(plan.patches).toHaveLength(2); expect(plan.receivedLineCount).toBe(1); expect(plan.preview).toMatchObject({ afterTotalCents: 2200, afterStatus: "partially_received" });
  });
  it("keeps approval coverage at or after every line version when the injected clock shares a tick", () => {
    const source = facts(); source.header.updatedAt = new Date("2026-10-08T12:00:00Z"); source.lines[0].updatedAt = new Date("2026-10-08T12:00:00.002Z");
    const clock = new Date("2026-10-08T12:00:00Z");
    expect(quantityAmendmentTimestamp(source, clock).toISOString()).toBe("2026-10-08T12:00:00.003Z");
    expect(clock.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });
});
