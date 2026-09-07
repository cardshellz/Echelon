import { describe, expect, it } from "vitest";
import type { PurchaseWorkspace } from "@shared/procurement/purchase-workspace";
import { projectPurchaseCostTrace, type PurchaseCostEvidence } from "../../purchase-cost-trace.service";

const purchase: PurchaseWorkspace["purchase"] = {
  id: 17, poNumber: "PO-17", status: "in_transit", physicalStatus: "in_transit", financialStatus: "paid",
  currency: "USD", vendorName: "Fixture vendor", totalCents: 11800,
  invoicedTotalCents: null, paidTotalCents: null, outstandingCents: null,
  expectedDeliveryDate: "2026-10-03T12:00:00Z", confirmedDeliveryDate: null, actualDeliveryDate: null, lines: [],
};

function evidence(): PurchaseCostEvidence {
  return {
    purchaseLines: [{
      id: 171, sku: "SYNTHETIC-SKU", lineType: "product", status: "partially_received",
      pricingBasis: "extended_total", pricingSource: "manual", quoteReference: "Q-EXAMPLE",
      orderedQty: 150, receivedQty: 50, cancelledQty: 0,
      productCents: 10000, packagingCents: 1800, discountCents: 100, taxCents: 200, lineTotalCents: 11900,
      productUnitMills: 6667, pricingRemainderMills: -50,
      promisedDate: null, expectedDeliveryDate: null,
    }],
    invoiceLines: [{
      id: 401, invoiceId: 40, purchaseOrderLineId: 171, quantity: 150, unitCostCents: 67, unitCostMills: 6667,
      lineTotalCents: 11800, matchStatus: "matched",
    }],
    shipmentCharges: [{
      id: 51, shipmentId: 5, costType: "ocean_freight", description: null, currency: "EUR", exchangeRate: "1.1000",
      estimatedCents: 1000, actualCents: null, recordedStatus: "finalized", invoiceId: 40,
    }],
    allocations: [{
      id: 511, chargeId: 51, chargeShipmentId: 5, shipmentId: 5, shipmentLineId: 501,
      purchaseOrderLineId: 171, purchaseOrderId: 17, allocatedCents: 500, basisValue: "1.000000", basisTotal: "2.000000",
    }],
    receiptLines: [{
      id: 301, receiptId: 30, purchaseOrderLineId: 171, receiptStatus: "closed", receiptPurchaseOrderId: 17,
      receiptVariantId: 91, receiptProductId: 90, purchaseLineProductId: 90,
      shipmentId: 5, shipmentLineId: 501, sourceShipmentId: 5, sourcePurchaseOrderId: 17, sourcePurchaseOrderLineId: 171,
      receivedUnits: 1, reversedUnits: 0, frozenPiecesPerUnit: 50,
    }],
    postings: [{
      id: 3001, receivingLineId: 301, receivingOrderId: 30, variantId: 91,
      variantQuantity: 1, postedAt: "2026-09-03T12:00:00Z", voidedAt: null,
      lot: {
        id: 70, lotNumber: "LOT-SYNTHETIC", variantId: 91, locationId: 7, onHandUnits: 1, reservedUnits: 0, pickedUnits: 0,
        productUnitMills: 333350, packagingUnitMills: 60000, landedUnitMills: 25000, totalUnitMills: 418350,
        recordedProvisional: false, receivingOrderId: 30, purchaseOrderId: 17, purchaseOrderLineId: 171, shipmentId: 5,
      },
    }],
  };
}

describe("purchase cost source projection", () => {
  it("keeps source component totals, invoice composition and current lot balances separate", () => {
    const input = evidence();
    const before = structuredClone(input);
    const result = projectPurchaseCostTrace(input, purchase);
    expect(result.applicationEvidence).toBe("not_verified");
    expect(result.purchaseLines[0]).toMatchObject({ productCents: 10000, packagingCents: 1800, lineTotalCents: 11900 });
    expect(result.invoiceLines[0]).toMatchObject({ lineTotalCents: 11800, componentEvidence: "unclassified" });
    expect(result.receiptLines[0]).toMatchObject({ lineageEvidence: "original_receipt_proven", unitEvidence: "frozen_receipt" });
    expect(result.receiptLines[0].postings[0].lot).toMatchObject({ totalUnitMills: 418350, currency: null, recordedProvisional: false });
    expect(result.shipmentCharges[0].allocations[0]).toMatchObject({ shipmentLineId: 501, allocatedCents: 500, currency: null });
    expect(input).toEqual(before);
  });

  it("uses authoritative extended quotes for a single proportional cents rounding", () => {
    expect(projectPurchaseCostTrace(evidence(), purchase).purchaseLines[0]).toMatchObject({
      outstandingPieces: 100, unreceivedQuoteCents: 7867, productUnitMills: 6667, pricingRemainderMills: -50,
    });
    const input = evidence();
    Object.assign(input.purchaseLines[0], { orderedQty: 2, receivedQty: 1, productCents: 1, packagingCents: 0 });
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0].unreceivedQuoteCents).toBe(1);
  });

  it("preserves actual zero, signed credits, estimates and missing amounts independently of status", () => {
    const input = evidence();
    input.shipmentCharges = [
      input.shipmentCharges[0],
      { ...input.shipmentCharges[0], id: 52, actualCents: 0 },
      { ...input.shipmentCharges[0], id: 53, actualCents: -400 },
      { ...input.shipmentCharges[0], id: 54, estimatedCents: null },
    ];
    expect(projectPurchaseCostTrace(input, purchase).shipmentCharges.map((row) => [row.actualCents, row.amountEvidence])).toEqual([
      [null, "estimated"], [0, "actual_recorded"], [-400, "actual_recorded"], [null, "unknown"],
    ]);
  });

  it("does not assign a whole shipment charge to this PO when no exact allocation exists", () => {
    const input = evidence(); input.allocations = [];
    expect(projectPurchaseCostTrace(input, purchase).shipmentCharges[0]).toMatchObject({
      amountScope: "whole_shipment_charge", estimatedCents: 1000, allocations: [],
    });
  });

  it.each([null, -1, 200])("exposes invalid/missing received count %s as review without inventing supply", (receivedQty) => {
    const input = evidence(); input.purchaseLines[0].receivedQty = receivedQty;
    const result = projectPurchaseCostTrace(input, purchase).purchaseLines[0];
    expect(result.outstandingPieces).toBeNull(); expect(result.unreceivedQuoteCents).toBeNull(); expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each(["closed", "cancelled"])("excludes unreceived %s line remainder from expected supply", (status) => {
    const input = evidence(); input.purchaseLines[0].status = status;
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0]).toMatchObject({ outstandingPieces: 0, unreceivedQuoteCents: 0 });
  });

  it("keeps non-product lines outside piece and supply calculations", () => {
    const input = evidence(); input.purchaseLines[0].lineType = "discount";
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0]).toMatchObject({ orderedPieces: null, outstandingPieces: null, unreceivedQuoteCents: null });
  });

  it("does not reconstruct a legacy unknown quote basis", () => {
    const input = evidence(); input.purchaseLines[0].pricingBasis = "legacy_unknown";
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0]).toMatchObject({ outstandingPieces: 100, unreceivedQuoteCents: null });
  });

  it("keeps safe integer boundaries exact and exposes derived overflow rather than rounding", () => {
    const input = evidence();
    Object.assign(input.purchaseLines[0], { orderedQty: 1, receivedQty: 0, productCents: Number.MAX_SAFE_INTEGER, packagingCents: 0 });
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0].unreceivedQuoteCents).toBe(Number.MAX_SAFE_INTEGER);
    input.purchaseLines[0].packagingCents = 1;
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0].unreceivedQuoteCents).toBeNull();
  });

  it("uses recorded arrival dates with explicit source priority and preserves missing dates", () => {
    const input = evidence();
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0].arrivalDateSource).toBe("purchase_expected");
    input.purchaseLines[0].expectedDeliveryDate = "2026-10-05T12:00:00Z";
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0].arrivalDateSource).toBe("line_expected");
    input.purchaseLines[0].promisedDate = "2026-10-06T12:00:00Z";
    expect(projectPurchaseCostTrace(input, purchase).purchaseLines[0]).toMatchObject({ expectedArrivalDate: "2026-10-06T12:00:00Z", arrivalDateSource: "line_promise" });
    input.purchaseLines[0].promisedDate = null; input.purchaseLines[0].expectedDeliveryDate = null;
    expect(projectPurchaseCostTrace(input, { ...purchase, expectedDeliveryDate: null }).purchaseLines[0]).toMatchObject({ expectedArrivalDate: null, arrivalDateSource: null });
  });

  it.each([null, 0, -1])("does not substitute live units for missing/invalid frozen units %s", (frozenPiecesPerUnit) => {
    const input = evidence(); input.receiptLines[0].frozenPiecesPerUnit = frozenPiecesPerUnit;
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0]).toMatchObject({ frozenPiecesPerUnit: null, unitEvidence: "unknown", lineageEvidence: "review_required" });
  });

  it.each(["receiptPurchaseOrderId", "receiptProductId", "sourceShipmentId", "sourcePurchaseOrderId", "sourcePurchaseOrderLineId"] as const)("requires exact agreeing source identity for %s", (field) => {
    const input = evidence(); input.receiptLines[0][field] = 999;
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0].lineageEvidence).toBe("review_required");
  });

  it("never pools the same PO line across separate shipment lines", () => {
    const input = evidence();
    input.receiptLines.push({ ...input.receiptLines[0], id: 302, receiptId: 31, shipmentId: 6, shipmentLineId: 601, sourceShipmentId: 6 });
    const result = projectPurchaseCostTrace(input, purchase);
    expect(result.receiptLines[0].postings).toHaveLength(1);
    expect(result.receiptLines[1]).toMatchObject({ shipmentLineId: 601, postings: [], lineageEvidence: "review_required" });
  });

  it("retains voided postings without treating them as active original receipt proof", () => {
    const input = evidence(); input.postings[0].voidedAt = "2026-09-04T12:00:00Z";
    const line = projectPurchaseCostTrace(input, purchase).receiptLines[0];
    expect(line.lineageEvidence).toBe("review_required"); expect(line.postings[0].voidedAt).not.toBeNull();
  });

  it("detects ambiguous transactions, missing lots and conflicting current cost components", () => {
    const input = evidence(); input.postings.push({ ...input.postings[0], id: 3002 });
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0].issues.join(" ")).toContain("More than one");
    input.postings.pop(); input.postings[0].lot!.totalUnitMills = 123;
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0].issues.join(" ")).toContain("do not equal");
    input.postings[0].lot = null;
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0].issues.join(" ")).toContain("no surviving lot");
  });

  it("shows a valid unposted draft as awaiting posting without calling it available or applied", () => {
    const input = evidence(); input.postings = []; input.receiptLines[0].receiptStatus = "draft";
    expect(projectPurchaseCostTrace(input, purchase).receiptLines[0].lineageEvidence).toBe("awaiting_posting");
  });

  it("rejects a cross-shipment allocation instead of reporting a false PO cost", () => {
    const input = evidence(); input.allocations[0].shipmentId = 99;
    expect(() => projectPurchaseCostTrace(input, purchase)).toThrow("conflicting shipment or purchase");
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN])("rejects invalid financial input %s before projection", (amount) => {
    const input = evidence(); input.purchaseLines[0].productCents = amount;
    expect(() => projectPurchaseCostTrace(input, purchase)).toThrow();
  });
});

describe("explicit invoice component evidence", () => {
  it.each(["separate", "included_in_product"] as const)("shows %s only when the exact components reconcile", (packagingTreatment) => {
    const input = evidence();
    const components = { contractVersion: 1, packagingTreatment, productMills: packagingTreatment === "separate" ? 1000000 : 1180000,
      packagingMills: packagingTreatment === "separate" ? 180000 : 0, adjustmentMills: 0, source: "operator_review" };
    input.invoiceLines[0].costComponentEvidence = components;
    const line = projectPurchaseCostTrace(input, purchase).invoiceLines[0];
    expect(line).toMatchObject({ componentEvidence: "explicit_recorded", components, componentIssues: [] });
  });
  it.each(["unsupported", "mismatch", "included_nonzero", "adjustment", "unsafe"])("requires review for %s composition without inferring a replacement", (kind) => {
    const input = evidence();
    const components = { contractVersion: 1, packagingTreatment: "separate", productMills: 1000000, packagingMills: 180000, adjustmentMills: 0, source: "operator_review" };
    if (kind === "unsupported") components.contractVersion = 2;
    if (kind === "mismatch") components.packagingMills = 180001;
    if (kind === "included_nonzero") components.packagingTreatment = "included_in_product";
    if (kind === "adjustment") { components.adjustmentMills = -100; components.packagingMills = 180100; }
    if (kind === "unsafe") components.productMills = Number.MAX_SAFE_INTEGER + 1;
    input.invoiceLines[0].costComponentEvidence = components;
    const line = projectPurchaseCostTrace(input, purchase).invoiceLines[0];
    expect(line.componentEvidence).toBe("review_required");
    expect(line.componentIssues!.length).toBeGreaterThan(0);
    expect(line.lineTotalCents).toBe(11800);
  });
});