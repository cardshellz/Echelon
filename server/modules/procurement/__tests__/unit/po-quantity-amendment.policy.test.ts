import { describe, expect, it } from "vitest";
import { poQuantityApprovalRequestSchema, poQuantityPreviewRequestSchema, poLineAmountCents } from "@shared/procurement/po-quantity-amendment";
import { buildQuantityAmendmentContext, hasQuantityAmendmentAuthority, planQuantityAmendment, quantityAmendmentBlockedReason, quantityAmendmentTimestamp, type AmendmentFacts } from "../../po-quantity-amendment.policy";
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
const edit = (patch: Record<string, unknown> = {}) => poQuantityPreviewRequestSchema.parse({ sourceVersion: "a".repeat(64), reason: "Supplier confirmed the corrected line amounts", changes: [{
  lineId: 11, quantityPieces: 10, priceTreatment: "edit_line", pricing: { basis: "per_piece", quantityPieces: 10, unitCostMills: 20000 }, packagingCostCents: 100, discountCents: 0, taxCents: 0, ...patch,
}] });

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
  it("keeps a cancelled zero-quantity legacy line visible without blocking other edits", () => {
    const source = facts();
    source.lines.push({ ...source.lines[0], id: 12, lineNumber: 2, orderQty: 0, receivedQty: 0, status: "cancelled", pricingBasis: "legacy_unknown", quotedUnitCostMills: null, totalProductCostCents: 0, packagingCostCents: 0, lineTotalCents: 0 });
    expect(buildQuantityAmendmentContext(source, admin, "a".repeat(64)).lines[1]).toMatchObject({ orderQty: 0, pricing: null, blockedReason: "Closed or cancelled lines cannot be amended." });
    expect(planQuantityAmendment(source, edit()).preview.afterTotalCents).toBe(2100);
  });
  it("edits price without requiring a quantity change and keeps receipts and invoices intact", () => {
    const source = facts(), before = structuredClone(source);
    const plan = planQuantityAmendment(source, edit());
    expect(plan.preview).toMatchObject({ beforeTotalCents: 1100, afterTotalCents: 2100, lines: [{ before: { orderQty: 10, unitCostMills: 10000 }, after: { orderQty: 10, unitCostMills: 20000, packagingCostCents: 100, lineTotalCents: 2100 } }] });
    expect(source).toEqual(before);
  });
  it("preserves per-piece price when increasing quantity and permits explicit packaging, discount and tax overrides", () => {
    const plan = planQuantityAmendment(facts(), edit({ quantityPieces: 20, pricing: { basis: "per_piece", quantityPieces: 20, unitCostMills: 10000 }, packagingCostCents: 200, discountCents: 100, taxCents: 50 }));
    expect(plan.patches[0].patch).toMatchObject({ orderQty: 20, unitCostMills: 10000, totalProductCostCents: 2000, packagingCostCents: 200, discountCents: 100, taxCents: 50, lineTotalCents: 2150 });
    expect(plan.preview.afterTotalCents).toBe(2150);
  });
  it("repairs a legacy component gap with explicit amounts without doubling an already-correct PO total", () => {
    const source = facts();
    Object.assign(source.lines[0], { orderQty: 25000, receivedQty: 25000, pricingBasis: "legacy_unknown", quotedUnitCostMills: null, unitCostMills: 5023, totalProductCostCents: 1255750, packagingCostCents: 41500, lineTotalCents: 1338750 });
    source.header.subtotalCents = source.header.totalCents = 1338750;
    const context = buildQuantityAmendmentContext(source, admin, "a".repeat(64));
    expect(context.lines[0]).toMatchObject({ orderQty: 25000, lineTotalCents: 1338750, componentTotalCents: 1297250, packagingCostCents: 41500 });
    expect(() => planQuantityAmendment(source, request(30000, "keep_quoted_rate"))).toThrow(/reconcile/);
    const plan = planQuantityAmendment(source, edit({ quantityPieces: 25000, pricing: { basis: "per_piece", quantityPieces: 25000, unitCostMills: 5023 }, packagingCostCents: 83000 }));
    expect(plan.preview).toMatchObject({ beforeTotalCents: 1338750, afterTotalCents: 1338750, lines: [{ after: { packagingCostCents: 83000, lineTotalCents: 1338750, componentTotalCents: 1338750 } }] });
    expect(plan.preview.warnings.some(warning => warning.includes("inconsistent total"))).toBe(true);
  });
  it("keeps extended totals and purchase-unit quotes exact when explicitly edited", () => {
    const totalPlan = planQuantityAmendment(facts(), edit({ quantityPieces: 3, pricing: { basis: "extended_total", quantityPieces: 3, quotedTotalCents: 1000 } }));
    expect(totalPlan.patches[0].patch).toMatchObject({ unitCostMills: 33333, pricingRemainderMills: 1, totalProductCostCents: 1000 });
    const uomPlan = planQuantityAmendment(facts(), edit({ quantityPieces: 20, pricing: { basis: "per_purchase_uom", purchaseUom: "case", uomQuantity: 4, piecesPerUom: 5, quotedCostMillsPerUom: 150000 } }));
    expect(uomPlan.patches[0].patch).toMatchObject({ orderQty: 20, purchaseUomQuantity: 4, piecesPerPurchaseUom: 5, unitCostMills: 30000, totalProductCostCents: 6000 });
    expect(() => planQuantityAmendment(facts(), edit({ quantityPieces: 19, pricing: { basis: "per_purchase_uom", purchaseUom: "case", uomQuantity: 4, piecesPerUom: 5, quotedCostMillsPerUom: 150000 } }))).toThrow(/match the corrected/);
  });
  it("requires every remaining active line to reconcile rather than preserving a second corrupt line", () => {
    const source = facts(); source.lines.push({ ...source.lines[0], id: 12, lineNumber: 2, packagingCostCents: 0 }); source.header.subtotalCents = source.header.totalCents = 2200;
    expect(() => planQuantityAmendment(source, edit())).toThrow(/Line 2.*reconcile/);
  });
  it("supports zero-valued pricing, but rejects a negative product line total and unsafe amounts", () => {
    expect(planQuantityAmendment(facts(), edit({ pricing: { basis: "per_piece", quantityPieces: 10, unitCostMills: 0 }, packagingCostCents: 0 })).preview.afterTotalCents).toBe(0);
    expect(() => planQuantityAmendment(facts(), edit({ discountCents: 99999 }))).toThrow(/nonnegative supported/);
    expect(() => planQuantityAmendment(facts(), edit({ pricing: { basis: "per_piece", quantityPieces: 10, unitCostMills: Number.MAX_SAFE_INTEGER } }))).toThrow(/safe integer range/);
    expect(() => poLineAmountCents(Number.MAX_SAFE_INTEGER, 1, 0, 0)).toThrow(/range/);
  });
  it.each(["fee", "tax", "discount", "rebate", "adjustment"])("edits a %s amount using its own signed taxonomy", (lineType) => {
    const source = facts(), credit = ["discount", "rebate"].includes(lineType), amount = credit ? -100 : 100;
    source.lines.push({ ...source.lines[0], id: 12, lineNumber: 2, productId: null, lineType, orderQty: lineType === "fee" ? 2 : 1, receivedQty: 0, totalProductCostCents: 0, packagingCostCents: 0, lineTotalCents: amount, unitCostMills: amount * 100, status: "open" });
    source.header.subtotalCents = source.header.totalCents = 1100 + amount;
    const charge = { sourceVersion: "a".repeat(64), reason: "Supplier corrected the charge amount", changes: [{ lineId: 12, quantityPieces: source.lines[1].orderQty, priceTreatment: "edit_charge", chargeTotalCents: amount * 2 }] };
    const plan = planQuantityAmendment(source, poQuantityPreviewRequestSchema.parse(charge));
    expect(plan.preview.afterTotalCents).toBe(1100 + amount * 2);
    expect(plan.patches[0].patch).toMatchObject({ orderQty: source.lines[1].orderQty, lineTotalCents: amount * 2, pricingBasis: "not_applicable", totalProductCostCents: 0 });
    if (lineType !== "adjustment") expect(() => planQuantityAmendment(source, poQuantityPreviewRequestSchema.parse({ ...charge, changes: [{ ...charge.changes[0], chargeTotalCents: -amount }] }))).toThrow(/negative amount/);
  });
  it("rejects unchanged values and incomplete or mixed financial edits", () => {
    expect(() => planQuantityAmendment(facts(), edit({ pricing: { basis: "per_piece", quantityPieces: 10, unitCostMills: 10000 } }))).toThrow(/Change a quantity or amount/);
    for (const patch of [{ packagingCostCents: undefined }, { taxCents: null }, { discountCents: "0" }, { pricing: undefined }, { chargeTotalCents: 1 }]) expect(() => edit(patch)).toThrow();
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), changes: [{ ...request().changes[0], packagingCostCents: 1 }] }).success).toBe(false);
  });
});
