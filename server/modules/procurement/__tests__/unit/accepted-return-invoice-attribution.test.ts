import { describe, expect, it } from "vitest";
import { acceptedReturnInvoiceAttribution, intersectReturnedIntervals, type ReturnInvoiceAssignment } from "../../domain/accepted-return-invoice-attribution";
import { projectReturnCreditReview } from "../../domain/supplier-return-credit-review";
import type { SupplierReturnSourceProof } from "@shared/procurement/supplier-return";

function source() {
  const proof: SupplierReturnSourceProof = { contractVersion: 1, origin: { inventoryLotId: 1, receivingLineId: 101, receivingOrderId: 10, purchaseOrderLineId: 21,
    purchaseOrderId: 20, vendorId: 5, productId: 1, productVariantId: 2, unitsPerVariant: 50, receivedVariantQuantity: 4,
    purchaseStartBasePiece: 500, inboundShipmentLineId: 11, shipmentStartBasePiece: 0 }, transfers: [] };
  return { sourceProof: proof, unitsPerVariant: 50 };
}
const assignments: ReturnInvoiceAssignment[] = [
  { receivingLineId: 101, invoiceLineId: 72, receiptStartPiece: 0, invoiceStartPiece: 20, pieces: 100 },
  { receivingLineId: 101, invoiceLineId: 82, receiptStartPiece: 100, invoiceStartPiece: 0, pieces: 100 },
];
describe("accepted return attribution to original receipt invoices", () => {
  it("separates two invoices on the same PO by their actual received pieces", () => {
    const input = source(), copy = structuredClone(input);
    expect(acceptedReturnInvoiceAttribution(input, [{ start: 0, quantity: 4 }], 500, assignments.slice(0, 1))).toEqual({
      eligibleIntervals: [{ start: 0, quantity: 2 }], parts: [{ receivingLineId: 101, receiptStartPiece: 0, invoiceStartPiece: 20, pieces: 100 }] });
    expect(acceptedReturnInvoiceAttribution(input, [{ start: 0, quantity: 4 }], 500, assignments.slice(1)).eligibleIntervals).toEqual([{ start: 2, quantity: 2 }]);
    expect(input).toEqual(copy);
  });
  it("traces a transfer's immutable source intervals to the original receipt", () => {
    const input = source(); input.sourceProof.transfers.push({ contributionId: 1, sourceLotId: 1, outputLotId: 2, sourceQuantity: 2, outputQuantity: 2,
      outputStartQuantity: 0, allocationId: 1, intervals: [{ start: 1, quantity: 2 }] });
    const first = acceptedReturnInvoiceAttribution(input, [{ start: 0, quantity: 2 }], 500, assignments.slice(0, 1));
    expect(first).toEqual({ eligibleIntervals: [{ start: 0, quantity: 1 }], parts: [{ receivingLineId: 101, receiptStartPiece: 50, invoiceStartPiece: 70, pieces: 50 }] });
    const second = acceptedReturnInvoiceAttribution(input, [{ start: 0, quantity: 2 }], 500, assignments.slice(1));
    expect(second.parts).toEqual([{ receivingLineId: 101, receiptStartPiece: 100, invoiceStartPiece: 0, pieces: 50 }]);
  });
  it("retains exact invoice pieces when one physical stock unit spans two bills", () => {
    const rows = [{ ...assignments[0], pieces: 20 }, { ...assignments[1], receiptStartPiece: 20, pieces: 30 }];
    const first = acceptedReturnInvoiceAttribution(source(), [{ start: 0, quantity: 1 }], 500, rows.slice(0, 1));
    const second = acceptedReturnInvoiceAttribution(source(), [{ start: 0, quantity: 1 }], 500, rows.slice(1));
    expect(first.eligibleIntervals).toEqual([{ start: 0, quantity: 1 }]);
    expect(second.eligibleIntervals).toEqual(first.eligibleIntervals);
    expect(first.parts[0].pieces).toBe(20); expect(second.parts[0].pieces).toBe(30);
  });
  it("never assigns a return to another receipt merely because it shares a PO", () => {
    expect(acceptedReturnInvoiceAttribution(source(), [{ start: 0, quantity: 4 }], 500, assignments.map(row => ({ ...row, receivingLineId: 999 })))).toEqual({ eligibleIntervals: [], parts: [] });
    expect(() => acceptedReturnInvoiceAttribution(source(), [{ start: 0, quantity: 4 }], 501, assignments)).toThrow(/precedes/);
  });
  it("reserves only free returned units within the selected invoice's proven scope", () => {
    expect(intersectReturnedIntervals([{ start: 0, quantity: 1 }, { start: 2, quantity: 2 }], [{ start: 0, quantity: 2 }])).toEqual([{ start: 0, quantity: 1 }]);
  });
  it.each(["inventory", "recoverable"] as const)("keeps %s returned tax separate without changing the supplier refund or recording an expense", treatment => {
    const links = [
      { id: 1, creditId: 1, creditLineId: 1, sourceInvoiceId: 71, supplierReference: "GOODS", status: "approved" as const, entitlementId: 1, quantity: 1, component: "product" as const, amountCents: 1000, attributionComponents: [] },
      { id: 2, creditId: 1, creditLineId: 2, sourceInvoiceId: 71, supplierReference: "TAX", status: "approved" as const, entitlementId: 1, quantity: 1, component: "product" as const, amountCents: 100,
        taxTypeId: 1, taxSourceKey: "invoice_line:72:1", taxTreatment: treatment, attributionComponents: [] },
    ];
    const snapshot = structuredClone(links), productMills = treatment === "inventory" ? 110000 : 100000;
    const result = projectReturnCreditReview({ entitlementId: 1, returnId: 1, returnLineId: 1, quantity: 1, intervals: [{ start: 0, quantity: 1 }],
      currentCosts: { productMills, packagingMills: 0, landedMills: 0, totalMills: productMills }, costEntryIds: [1, 2, 3], links, history: [] });
    expect(result.review.differences).toEqual({ productMills: 0, packagingMills: 0, landedMills: 0, totalMills: 0, unassignedCreditCents: 0 });
    expect(links).toEqual(snapshot);
  });
});
