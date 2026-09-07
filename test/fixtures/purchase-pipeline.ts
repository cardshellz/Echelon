import { emptySupplierProgress } from "../../shared/procurement/purchase-pipeline";
import type { PipelineEvidence } from "../../server/modules/procurement/purchase-pipeline.service";
export const pipelineTime = new Date("2026-09-07T12:00:00.000Z");
export function pipelineLine(overrides: Partial<PipelineEvidence["lines"][number]> = {}): PipelineEvidence["lines"][number] {
  return { id: 11, purchaseOrderId: 1, poNumber: "TEST-PO-1", vendorName: "Test supplier", poStatus: "acknowledged", status: "open", sku: "TEST-ITEM", productName: "Test item", currency: "USD",
    ordered: 100, received: 0, cancelled: 0, pricingBasis: "per_piece", quotedUnitMills: "10000", quotedTotalCents: null, purchaseUomQuantity: null, piecesPerPurchaseUom: null, packagingCents: "1000", quoteReference: "TEST-QUOTE", expectedDate: "2026-10-17T12:00:00.000Z", promisedDate: null, confirmedDate: null, purchaseExpectedDate: null, progress: emptySupplierProgress(), ...overrides };
}
export function pipelineShipment(overrides: Partial<PipelineEvidence["shipments"][number]> = {}): PipelineEvidence["shipments"][number] {
  return { id: 111, shipmentId: 7, purchaseOrderId: 1, purchaseOrderLineId: 11, shipmentNumber: "TEST-SHIP-7", status: "in_transit", quantity: 60, eta: "2026-09-27T12:00:00.000Z", deliveredAt: null, ...overrides };
}
export function pipelineEvidence(): PipelineEvidence {
  return { lines: [pipelineLine()], shipments: [], receipts: [], postings: [], reversals: [], revisions: [] };
}
export function pipelinePartialReceipt(): PipelineEvidence {
  const data = pipelineEvidence();
  data.lines[0].progress = { revision: 1, report: { startedPieces: 100, completedPieces: 70, asOf: "2026-09-06T12:00:00.000Z", reference: "Supplier report A", notes: "" }, recordedBy: "test-operator", recordedAt: "2026-09-06T12:00:00.000Z" };
  data.shipments.push(pipelineShipment());
  data.receipts.push({ id: 31, receivingOrderId: 3, purchaseOrderId: 1, purchaseOrderLineId: 11, shipmentId: 7, shipmentLineId: 111, received: 2, reversed: 0, units: 10, status: "closed" });
  return data;
}
