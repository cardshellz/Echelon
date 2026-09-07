import type { PurchaseCostTrace } from "../../shared/procurement/purchase-cost-trace";

/** Synthetic source-only evidence for browser/rendering acceptance. */
export function purchaseCostTraceFixture(): PurchaseCostTrace {
  return {
    version: 1,
    applicationEvidence: "not_verified",
    purchaseLines: [{
      id: 171, sku: "TEST-SKU", lineType: "product", status: "partially_received", currency: "USD",
      pricingBasis: "extended_total", pricingSource: "manual", quoteReference: "TEST-QUOTE",
      orderedPieces: 150, receivedPieces: 50, cancelledPieces: 0,
      productCents: 10000, packagingCents: 1800, discountCents: 0, taxCents: 0, lineTotalCents: 11800,
      productUnitMills: 6667, pricingRemainderMills: -50,
      outstandingPieces: 100, unreceivedQuoteCents: 7867,
      expectedArrivalDate: "2026-10-01T12:00:00Z", arrivalDateSource: "purchase_expected", issues: [],
    }],
    invoiceLines: [{
      id: 711, invoiceId: 71, purchaseOrderLineId: 171, quantity: 150,
      unitCostCents: 67, unitCostMills: 6667, lineTotalCents: 11800, matchStatus: "matched", componentEvidence: "unclassified",
    }],
    shipmentCharges: [{
      id: 501, shipmentId: 42, costType: "ocean_freight", description: "Synthetic shared container cost",
      currency: "EUR", exchangeRate: "1.1000", estimatedCents: 1000, actualCents: 0,
      recordedStatus: "finalized", amountEvidence: "actual_recorded", invoiceId: 71,
      amountScope: "whole_shipment_charge",
      allocations: [{ id: 5011, shipmentLineId: 42, purchaseOrderLineId: 171, allocatedCents: 0, basisValue: "50.000000", basisTotal: "100.000000", currency: null }],
    }],
    receiptLines: [{
      id: 311, receiptId: 31, purchaseOrderLineId: 171, shipmentId: 42, shipmentLineId: 42,
      receivedUnits: 1, reversedUnits: 0, frozenPiecesPerUnit: 50,
      unitEvidence: "frozen_receipt", lineageEvidence: "original_receipt_proven", issues: [],
      postings: [{
        id: 3001, variantQuantity: 1, postedAt: "2026-09-03T12:00:00Z", voidedAt: null,
        lot: { id: 901, lotNumber: "TEST-LOT-901", variantId: 91, locationId: 9,
          onHandUnits: 1, reservedUnits: 0, pickedUnits: 0, productUnitMills: 333350, packagingUnitMills: 60000,
          landedUnitMills: 25000, totalUnitMills: 418350, recordedProvisional: false, currency: null },
      }],
    }],
    limitations: ["Synthetic source preview. Application and sold COGS are not verified."],
  };
}
