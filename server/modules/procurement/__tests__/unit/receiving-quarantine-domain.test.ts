import { describe, expect, it } from "vitest";
import { assertCustodyResolution, assertReviewedCustodyConversion, custodyQuantities } from "../../domain/receiving-quarantine";
import { receivingQuarantineIntakeSchema, prepareQuarantineAcceptanceSchema } from "@shared/procurement/receiving-quarantine";

const balance = { observedQty: 10, awaitingReceiptQty: 3, receivedQty: 2, returnedQty: 1, version: 4 };
describe("pending receiving custody conservation", () => {
  it("keeps pending acceptances physically held and unavailable for another resolution", () => {
    expect(custodyQuantities(balance)).toEqual({ physicalHeldQty: 7, unallocatedQty: 4 });
    expect(() => assertCustodyResolution(balance, 4, 4)).not.toThrow();
    expect(() => assertCustodyResolution(balance, 4, 5)).toThrow(/quantity still available/);
  });
  it("reads only the balance fields from a complete observation record", () => {
    const observation = { ...balance, receivingLineId: null, reason: "Observed custody" };
    expect(custodyQuantities(observation)).toEqual({ physicalHeldQty: 7, unallocatedQty: 4 });
  });
  it.each([0, -1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])("rejects invalid resolution quantity %s", quantity => {
    expect(() => assertCustodyResolution(balance, 4, quantity)).toThrow();
  });
  it("requires current revision even when quantity remains available", () => {
    expect(() => assertCustodyResolution(balance, 3, 1)).toThrow(/Refresh/);
  });
  it("refuses version overflow", () => {
    expect(() => assertCustodyResolution({ ...balance, version: 2_147_483_647 }, 2_147_483_647, 1)).toThrow(/version limit/);
  });
  it.each([
    { ...balance, observedQty: 0 }, { ...balance, awaitingReceiptQty: 8 }, { ...balance, returnedQty: -1 },
    { ...balance, receivedQty: 2.5 }, { ...balance, version: Number.NaN },
  ])("rejects corrupt stored balance %j", value => expect(() => custodyQuantities(value)).toThrow());
});
describe("reviewed quarantine unit conversion", () => {
  const conversion = { observedProductId: 10, observedUnitsPerVariant: 12, observationQty: 2,
    targetProductId: 10, targetUnitsPerVariant: 1, acceptedVariantQty: 24 };
  it("preserves exact physical pieces across receiving pack changes", () => expect(() => assertReviewedCustodyConversion(conversion)).not.toThrow());
  it("rejects another product", () => expect(() => assertReviewedCustodyConversion({ ...conversion, targetProductId: 11 })).toThrow(/does not match/));
  it("rejects a lost or added piece", () => expect(() => assertReviewedCustodyConversion({ ...conversion, acceptedVariantQty: 25 })).toThrow(/exact piece count/));
  it("permits explicit observed-container mapping only for unidentified goods", () => {
    expect(() => assertReviewedCustodyConversion({ ...conversion, observedProductId: null, observedUnitsPerVariant: null, acceptedVariantQty: 25 })).not.toThrow();
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid pack %s", units => {
    expect(() => assertReviewedCustodyConversion({ ...conversion, targetUnitsPerVariant: units })).toThrow(/positive whole/);
  });
  it("rejects piece counts exceeding safe integer persistence", () => expect(() => assertReviewedCustodyConversion({
    ...conversion, targetUnitsPerVariant: 2_147_483_647, acceptedVariantQty: 2_147_483_647,
  })).toThrow(/supported piece count/));
});
describe("custody input boundary", () => {
  const intake = { kind: "receipt_line", receivingLineId: 1, expectedUnitVersion: "a".repeat(64),
    acceptedQty: 0, heldQty: 2, countsReviewed: true, holdingLocationId: 1, condition: "damaged", reason: "Observed torn packaging", evidenceReference: "photo-12" };
  it("allows an explicitly reviewed all-held receipt", () => expect(receivingQuarantineIntakeSchema.safeParse(intake).success).toBe(true));
  it.each([{ countsReviewed: false }, { acceptedQty: -1 }, { heldQty: 0 }, { reason: " " }, { evidenceReference: "" }, { damagedQty: 2 }])
    ("rejects missing review, invalid count or legacy arithmetic %j", patch => expect(receivingQuarantineIntakeSchema.safeParse({ ...intake, ...patch }).success).toBe(false));
  it("requires exact reviewed template identity and explicit unit review", () => {
    expect(prepareQuarantineAcceptanceSchema.safeParse({ expectedVersion: 0, observationQty: 1, targetReceivingOrderId: null,
      productVariantId: 1, expectedUnitsPerVariant: 1, acceptedVariantQty: 1, purchaseOrderLineId: null,
      inboundShipmentLineId: null, putawayLocationId: 1, reason: "Inspected", countConversionReviewed: true }).success).toBe(false);
  });
});
