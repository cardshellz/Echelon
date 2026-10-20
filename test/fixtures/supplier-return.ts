import { supplierReturnCreditReviewSchema, type SupplierReturnCreditReviewInput, type SupplierReturnCreditReview, type SupplierReturnCreditReviewCommandResult } from "../../shared/procurement/supplier-return-credit";
import { supplierReturnPreviewSchema, supplierReturnDetailSchema, type SupplierReturnStockOptions, type SupplierReturnStockPreviewLine, type SupplierReturnRecordInput, type SupplierReturnCommandResult } from "../../shared/procurement/supplier-return";
export const returnFingerprint = "a".repeat(64);
export function returnOption(inventoryLotId = 501): SupplierReturnStockOptions["items"][number] {
  return { inventoryLotId, inventoryLevelId: inventoryLotId + 100, warehouseLocationId: 801, warehouseId: 1, productId: 10, productVariantId: 101,
    lotNumber: `LOT-${inventoryLotId}`, sku: "TOP-C10", locationCode: "A-01", unitLabel: "10 pieces per lot unit", purchaseOrderId: 17, receivingOrderId: 31, purchaseOrderLineId: 171,
    availableQuantity: 10, unitsPerVariant: 10, eligible: true, issues: [] };
}
export function returnPreviewLine(inventoryLotId = 501, quantity = 2): SupplierReturnStockPreviewLine {
  const option = returnOption(inventoryLotId);
  return { inventoryLotId, inventoryLevelId: option.inventoryLevelId!, warehouseLocationId: option.warehouseLocationId, warehouseId: 1, productId: 10, productVariantId: 101,
    lotNumber: option.lotNumber, sku: option.sku, locationCode: option.locationCode, unitLabel: option.unitLabel, quantity, availableQuantity: 10, levelAvailableQuantity: 10,
    unitsPerVariant: 10, basePieces: quantity * 10, sourceProof: { contractVersion: 1, origin: { inventoryLotId, receivingLineId: 311, receivingOrderId: 31, purchaseOrderLineId: 171, purchaseOrderId: 17,
      vendorId: 2, productId: 10, productVariantId: 101, unitsPerVariant: 10, receivedVariantQuantity: 10, purchaseStartBasePiece: 0, inboundShipmentLineId: null, shipmentStartBasePiece: null }, transfers: [] },
    intervals: [{ start: 0, quantity }], costs: { productMills: quantity * 10001, packagingMills: quantity * 100, landedMills: quantity * 50, totalMills: quantity * 10151 }, costProvisional: true };
}
export function returnPreview(lines = [returnPreviewLine()]) {
  const totals = { productMills: 0, packagingMills: 0, landedMills: 0, totalMills: 0 };
  for (const line of lines) for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += line.costs[key];
  return supplierReturnPreviewSchema.parse({ vendorId: 2, currency: "USD", sourceFingerprint: returnFingerprint, lines, totals, costProvisional: lines.some(line => line.costProvisional) });
}
export function returnRequest(): SupplierReturnRecordInput {
  return { vendorId: 2, lines: [{ inventoryLotId: 501, quantity: 2 }], expectedSourceFingerprint: returnFingerprint, returnCalendarDate: "2026-10-20", evidenceReference: "COLLECT-17", reason: "Supplier collected damaged packaging", supplierReference: "RMA-17" };
}
export function returnResult(request = returnRequest(), preview = returnPreview(), actorId = "ap-reader", key = "return-key-1"): SupplierReturnCommandResult {
  const at = "2026-10-20T15:00:00.000Z";
  const receiptLines = preview.lines.map((line, index) => ({ returnLineId: 91 + index, returnAllocationId: 191 + index, inventoryTransactionId: 291 + index,
    inventoryLotId: line.inventoryLotId, productVariantId: line.productVariantId, warehouseLocationId: line.warehouseLocationId, quantity: line.quantity, costQuantityAllocationId: 391 + index,
    initialCostEntryIds: { product: 491 + index * 3, packaging: 492 + index * 3, landed: 493 + index * 3 } }));
  const detail = supplierReturnDetailSchema.parse({ id: 9, vendorId: 2, vendorName: "Test supplier", status: "recorded", supplierReference: request.supplierReference ?? null,
    returnCalendarDate: request.returnCalendarDate, evidenceReference: request.evidenceReference, reason: request.reason, sourceFingerprint: preview.sourceFingerprint, recordedBy: actorId, recordedAt: at,
    inventoryReceipt: { returnId: 9, commandKey: key, sourceFingerprint: preview.sourceFingerprint, actorId, occurredAt: at, lines: receiptLines, replayed: false },
    lines: preview.lines.map((source, index) => ({ id: receiptLines[index].returnLineId, source, currentCosts: source.costs, creditState: "unmatched", creditIssues: [], creditLinks: [], sourceInvoices: [{ sourceInvoiceId: 71, invoiceLineId: 701, invoiceNumber: "INV-71", components: ["product", "packaging"] }],
      costEntries: (["product", "packaging", "landed"] as const).map(component => ({ id: receiptLines[index].initialCostEntryIds[component], returnAllocationId: receiptLines[index].returnAllocationId, component,
        previousMills: 0, nextMills: source.costs[`${component}Mills`], deltaMills: source.costs[`${component}Mills`], postingKey: `return:9:${index}:${component}`, reason: request.reason, sourceRevisionId: null, applicationId: null, recordedBy: actorId, recordedAt: at })) })) });
  return { command: "record", actorId, idempotencyKey: key, request, returnId: 9, return: detail };
}

export function returnCreditReview(amountCents = 200): SupplierReturnCreditReview {
  return supplierReturnCreditReviewSchema.parse({ entitlementId: 111, returnId: 9, returnLineId: 91, quantity: 2, version: "b".repeat(64),
    currentCosts: { productMills: 20000, packagingMills: 2000, landedMills: 0, totalMills: 22000 },
    creditLinks: [{ id: 41, creditId: 19, creditLineId: 191, sourceInvoiceId: 71, supplierReference: "CN-COMBINED", status: "approved", entitlementId: 111, quantity: 2, component: "unassigned", amountCents, attributionComponents: ["product", "packaging"] }],
    differences: { productMills: 20000, packagingMills: 2000, landedMills: 0, totalMills: 22000 - amountCents * 100, unassignedCreditCents: amountCents }, latestReview: null, reviewHistory: [], reviewCurrent: false });
}
export function returnCreditReviewRequest(): SupplierReturnCreditReviewInput { return { expectedVersion: "b".repeat(64), reason: "Reviewed supplier note and collection evidence", evidenceReference: "SUPPLIER-MESSAGE-17", disposition: "awaiting_supplier_note", assignments: [{ creditLinkId: 41, productCents: 190, packagingCents: 10, landedCents: 0 }] }; }
export function returnCreditReviewResult(request = returnCreditReviewRequest(), before = returnCreditReview(), actorId = "ap-reader", key = "review-key-1"): SupplierReturnCreditReviewCommandResult {
  const review = structuredClone(before), id = 201 + before.reviewHistory.length;
  const entry = { id, sourceFingerprint: "c".repeat(64), expectedVersion: request.expectedVersion, disposition: request.disposition, assignments: request.assignments,
    evidenceReference: request.evidenceReference, reason: request.reason, recordedBy: actorId, recordedAt: "2026-10-20T16:00:00.000Z" };
  review.latestReview = entry; review.reviewHistory.push(entry); review.reviewCurrent = true; review.version = id.toString(16).padStart(64, "0");
  let product = 0, packaging = 0, landed = 0, unassigned = 0;
  for (const link of review.creditLinks.filter(row => row.status === "approved")) {
    const assigned = request.assignments.find(row => row.creditLinkId === link.id);
    if (link.component === "product") product += link.amountCents * 100;
    else if (link.component === "packaging") packaging += link.amountCents * 100;
    else if (link.component === "landed") landed += link.amountCents * 100;
    else if (assigned) { product += assigned.productCents * 100; packaging += assigned.packagingCents * 100; landed += assigned.landedCents * 100; }
    else unassigned += link.amountCents;
  }
  review.differences = { productMills: review.currentCosts.productMills - product, packagingMills: review.currentCosts.packagingMills - packaging, landedMills: review.currentCosts.landedMills - landed,
    totalMills: review.currentCosts.totalMills - product - packaging - landed - unassigned * 100, unassignedCreditCents: unassigned };
  return { command: "review_credit_difference", entitlementId: 111, actorId, idempotencyKey: key, request, review };
}
