import { describe, expect, it } from "vitest";
import { poQuantityPreviewRequestSchema, type PoLineProductIdentity } from "@shared/procurement/po-quantity-amendment";
import {
  buildQuantityAmendmentContext, lineProductChangeBlockedReason, planQuantityAmendment,
  type AmendmentFacts, type PreparedPoProductChange, type ProductIdentityPatch,
} from "../../po-quantity-amendment.policy";
import type { PurchaseApprovalActor } from "../../../identity/domain/purchase-approval-authority";

const admin: PurchaseApprovalActor = { userId: "admin", active: true, roles: [{ id: 1, name: "Administrator", isSystem: true }], approvalGrantIds: [1], hasScopedApprovalGrant: false };

/** One received line and one untouched, invoiced line on an archived product
 * (the PO-20260602-001 line 6 shape: open, nothing received, paid invoice). */
function facts(): AmendmentFacts {
  const received = { id: 11, purchaseOrderId: 1, lineNumber: 1, productId: 1, productVariantId: null, expectedReceiveVariantId: 1, expectedReceiveUnitsPerVariant: 1,
    vendorProductId: null, vendorSku: null, sku: "RECEIVED-SKU", productName: "Received product", lineType: "product", parentLineId: null,
    orderQty: 10, receivedQty: 10, damagedQty: 0, cancelledQty: 0, returnedQty: 0, status: "received", unitCostCents: 100, unitCostMills: 10000,
    totalProductCostCents: 1000, packagingCostCents: 100, discountCents: 0, taxCents: 0, lineTotalCents: 1100, pricingBasis: "per_piece", pricingSource: "manual", quotedUnitCostMills: 10000 };
  const untouched = { ...received, id: 12, lineNumber: 2, productId: 7, expectedReceiveVariantId: 14, expectedReceiveUnitsPerVariant: 1000, vendorProductId: 30,
    sku: "OLD-SKU", productName: "Archived toploader", orderQty: 5000, receivedQty: 0, status: "open", unitCostCents: 1, unitCostMills: 100,
    totalProductCostCents: 5000, packagingCostCents: 0, lineTotalCents: 5000, pricingBasis: "legacy_unknown", pricingSource: "legacy", quotedUnitCostMills: null };
  return {
    header: { id: 1, vendorId: 2, status: "partially_received", physicalStatus: "receiving", currency: "USD", totalCents: 6100, subtotalCents: 6100, receivedLineCount: 1,
      discountCents: 0, taxCents: 0, shippingCostCents: 0, closedAt: null, cancelledAt: null },
    lines: [received, untouched],
    invoices: [{ id: 71, status: "paid", invoiceNumber: "TEST-INV-71", currency: "USD" }],
    invoiceLines: [{ id: 82, lineNumber: 2, lineTotalCents: 5000, productName: "Archived toploader", sku: null, description: null, vendorInvoiceId: 71,
      purchaseOrderLineId: 12, qtyInvoiced: 5000, unitCostCents: 1, unitCostMills: 100 }],
    recommendationOwned: false,
  } as unknown as AmendmentFacts;
}

const identity = (overrides: Partial<ProductIdentityPatch> = {}): ProductIdentityPatch => ({
  productId: 8, productVariantId: 16, expectedReceiveVariantId: 16, expectedReceiveUnitsPerVariant: 1000, vendorProductId: null, vendorSku: null,
  sku: "NEW-SKU", productName: "Replacement toploader", unitOfMeasure: "case", unitsPerUom: 1000, ...overrides,
});
const view = (values: ProductIdentityPatch): PoLineProductIdentity => ({ productId: values.productId, sku: values.sku, name: values.productName ?? "",
  receiveVariantId: values.expectedReceiveVariantId, receiveVariantSku: null, receiveVariantName: "Case of 1000", receiveUnitsPerVariant: values.expectedReceiveUnitsPerVariant,
  vendorProductId: values.vendorProductId, vendorSku: values.vendorSku });
const prepared = (values = identity()): PreparedPoProductChange => ({ lineId: 12, values,
  before: view(identity({ productId: 7, expectedReceiveVariantId: 14, productVariantId: null, vendorProductId: 30, sku: "OLD-SKU", productName: "Archived toploader" })),
  after: view(values), sourceFingerprint: "c".repeat(64) });
const request = (change: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => poQuantityPreviewRequestSchema.parse({
  sourceVersion: "a".repeat(64), changes: [], reason: "The ordered product was archived; supplier ships the replacement SKU",
  productChanges: [{ lineId: 12, productId: 8, expectedReceiveVariantId: 16, expectedReceiveUnitsPerVariant: 1000, vendorProductId: null, vendorSku: null, ...change }], ...extra,
});

describe("PO line product correction policy", () => {
  it("re-points an untouched, invoiced line without changing quantities, money, receipts or invoice evidence", () => {
    const source = facts(), before = structuredClone(source);
    const plan = planQuantityAmendment(source, request(), [], [prepared()]);
    expect(plan.patches).toEqual([]);
    expect(plan.productChanges).toEqual([{ id: 12, patch: identity() }]);
    expect(plan.preview).toMatchObject({ beforeTotalCents: 6100, afterTotalCents: 6100, beforeStatus: "partially_received", afterStatus: "partially_received", lines: [],
      productChanges: [{ lineId: 12, lineNumber: 2, before: { sku: "OLD-SKU", productId: 7 }, after: { sku: "NEW-SKU", productId: 8 },
        invoiceLines: [{ invoiceId: 71, invoiceNumber: "TEST-INV-71", invoiceLineId: 82, description: "Archived toploader" }] }] });
    expect(plan.preview.warnings).toContain("Line 2: invoice TEST-INV-71 keeps its recorded supplier description and stays matched to this line.");
    expect(plan.preview.invoiceMatches.every(match => match.before === match.after)).toBe(true);
    expect(source).toEqual(before);
  });

  it("shows each line's identity and whether its product may still change", () => {
    const context = buildQuantityAmendmentContext(facts(), admin, "a".repeat(64));
    expect(context.vendorId).toBe(2);
    expect(context.lines[1]).toMatchObject({ sku: "OLD-SKU", productId: 7, receiveVariantId: 14, receiveUnitsPerVariant: 1000, vendorProductId: 30, productChangeBlockedReason: null });
    expect(context.lines[0].productChangeBlockedReason).toMatch(/received/);
  });

  it("keeps the product while shipment, receipt or inventory documents name it", () => {
    const source = facts();
    source.productChangeBlocks = { 12: "This line is on shipment TEST-SHIP. Correct or remove it on the shipment before changing its product." };
    expect(buildQuantityAmendmentContext(source, admin, "a".repeat(64)).lines[1].productChangeBlockedReason).toMatch(/TEST-SHIP/);
    expect(() => planQuantityAmendment(source, request(), [], [prepared()])).toThrow(/TEST-SHIP/);
  });

  it.each([
    [{ receivedQty: 1, status: "partially_received" }, /received/], [{ receivedQty: 5000, status: "received" }, /received/], [{ damagedQty: 1 }, /received/],
    [{ cancelledQty: 1 }, /cancellations/], [{ returnedQty: 1 }, /returns/], [{ parentLineId: 11 }, /dependent/], [{ productId: null }, /no linked product/],
    [{ status: "cancelled" }, /cannot be amended/], [{ lineType: "fee" }, /Only product lines/],
  ])("blocks a line with %j", (patch, message) => {
    const source = facts(); Object.assign(source.lines[1], patch);
    // A cancelled line leaves active totals; keep the header reconciled so the
    // product rule, not a total mismatch, is what refuses the change.
    if ("status" in patch && patch.status === "cancelled") source.header.subtotalCents = source.header.totalCents = 1100;
    expect(lineProductChangeBlockedReason(source.lines[1], source)).toMatch(message);
    expect(() => planQuantityAmendment(source, request(), [], [prepared()])).toThrow(message);
  });

  it("never changes a product on a closed or recommendation-owned PO", () => {
    const closed = facts(); closed.header.status = "closed"; closed.header.closedAt = new Date("2026-10-01");
    expect(() => planQuantityAmendment(closed, request({}, { closedPurchaseOrderConfirmed: true }), [], [prepared()])).toThrow(/closed/);
    const owned = facts(); owned.recommendationOwned = true;
    expect(() => planQuantityAmendment(owned, request(), [], [prepared()])).toThrow(/immutable/);
  });

  it("rejects unverified, stale and no-op product changes", () => {
    expect(() => planQuantityAmendment(facts(), request(), [], [])).toThrow(/verified/);
    expect(() => planQuantityAmendment(facts(), request({ expectedReceiveVariantId: 17 }), [], [prepared()])).toThrow(/verified/);
    expect(() => planQuantityAmendment(facts(), request({ vendorSku: "SUPPLIER-1" }), [], [prepared()])).toThrow(/verified/);
    const unchanged = identity({ productId: 7, productVariantId: 14, expectedReceiveVariantId: 14, vendorProductId: 30, sku: "OLD-SKU", productName: "Archived toploader" });
    expect(() => planQuantityAmendment(facts(), request({ productId: 7, expectedReceiveVariantId: 14, vendorProductId: 30 }), [], [prepared(unchanged)])).toThrow(/different product/);
    const foreign = request({ lineId: 99 });
    expect(() => planQuantityAmendment(facts(), foreign, [], [{ ...prepared(), lineId: 99 }])).toThrow(/belong/);
  });

  it("records supplier-catalog pricing as manual once its supplier item no longer applies", () => {
    const source = facts(); Object.assign(source.lines[1], { pricingBasis: "per_piece", pricingSource: "vendor_catalog", quotedUnitCostMills: 100 });
    const plan = planQuantityAmendment(source, request(), [], [prepared()]);
    expect(plan.productChanges?.[0].patch).toMatchObject({ pricingSource: "manual", vendorProductId: null });
    expect(plan.preview.warnings).toContain("Line 2's price came from the previous supplier item. It is kept as a manually approved price.");
    // Same product and supplier item, new receiving unit: catalog provenance stays.
    const unitOnly = identity({ productId: 7, productVariantId: 13, expectedReceiveVariantId: 13, expectedReceiveUnitsPerVariant: 100, vendorProductId: 30, sku: "OLD-SKU", productName: "Archived toploader" });
    const kept = planQuantityAmendment(source, request({ productId: 7, expectedReceiveVariantId: 13, expectedReceiveUnitsPerVariant: 100, vendorProductId: 30 }), [], [prepared(unitOnly)]);
    expect(kept.productChanges?.[0].patch).not.toHaveProperty("pricingSource");
  });

  it("combines with a price edit on the same line but never with its removal or a duplicate", () => {
    const combined = request({}, { changes: [{ lineId: 12, quantityPieces: 5000, priceTreatment: "edit_line",
      pricing: { basis: "per_piece", quantityPieces: 5000, unitCostMills: 200 }, packagingCostCents: 0, discountCents: 0, taxCents: 0 }] });
    const plan = planQuantityAmendment(facts(), combined, [], [prepared()]);
    expect(plan.patches[0].patch).toMatchObject({ totalProductCostCents: 10000, lineTotalCents: 10000 });
    expect(plan.preview).toMatchObject({ afterTotalCents: 11100, lines: [{ after: { sku: "NEW-SKU", productId: 8, orderQty: 5000 } }] });
    const change = request().productChanges![0];
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), removals: [12] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), productChanges: [change, change] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), productChanges: [{ ...change, vendorSku: "" }] }).success).toBe(false);
    expect(poQuantityPreviewRequestSchema.safeParse({ ...request(), productChanges: [{ ...change, guessedField: 1 }] }).success).toBe(false);
  });
});
