import { describe, expect, it } from "vitest";
import { reviewRfqQuantity, rfqQuantityReviewMessage } from "@shared/procurement/rfq-quantity-review";

const rules = { vendorProductId: 6, minimumOrderPieces: 100, piecesPerPurchaseUom: null, packSize: 50 };

describe("RFQ quantity review against preserved and current supplier rules", () => {
  it("requires no extra reason when valid saved rules and quoted quantity remain compatible", () => {
    expect(reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 150 })).toMatchObject({ issues: [], requiresReason: false, canConvert: true, evaluatedPieces: 150 });
  });
  it("requires review of changed MOQ even when quoted quantity still satisfies it", () => {
    const review = reviewRfqQuantity({ recommendationRules: rules, currentRules: { ...rules, minimumOrderPieces: 125 }, quotedPieces: 150 });
    expect(review.issues).toEqual(["supplier_rules_changed"]);
    expect(review.requiresReason).toBe(true);
  });
  it("retains an exact vendor quote below MOQ and outside the current multiple", () => {
    const review = reviewRfqQuantity({ recommendationRules: rules, currentRules: { ...rules, minimumOrderPieces: 200, packSize: 100 }, quotedPieces: 150 });
    expect(review.issues).toEqual(["supplier_rules_changed", "below_current_moq", "outside_current_order_multiple"]);
    expect(review.evaluatedPieces).toBe(150);
    expect(rfqQuantityReviewMessage("below_current_moq", review)).toContain("150 pieces are below the current MOQ of 200");
  });
  it("requires review of an incompatible quote even when catalog rules did not drift", () => {
    expect(reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces: 75 }).issues).toEqual(["below_current_moq", "outside_current_order_multiple"]);
  });
  it.each([null, {}, { minimumOrderPieces: 100 }, { ...rules, packSize: 0 }])("keeps missing or invalid historical rule evidence explicit", (recommendationRules) => {
    expect(reviewRfqQuantity({ recommendationRules, currentRules: rules, quotedPieces: 150 })).toMatchObject({ recommendationRules: null, requiresReason: true, canConvert: true, issues: ["recommendation_rules_unavailable"] });
  });
  it.each([null, { ...rules, packSize: 0 }, { ...rules, minimumOrderPieces: -1 }, { ...rules, piecesPerPurchaseUom: 1.5 }, { ...rules, minimumOrderPieces: "100" }])("blocks malformed current rules even with an operator reason", (currentRules) => {
    expect(reviewRfqQuantity({ recommendationRules: rules, currentRules, quotedPieces: 150 })).toMatchObject({ currentRules: null, canConvert: false, issues: ["current_rules_invalid"] });
  });
  it("uses the engine's authoritative purchase-unit factor ahead of its fallback pack", () => {
    const purchaseRules = { ...rules, piecesPerPurchaseUom: 25, packSize: 100 };
    const review = reviewRfqQuantity({ recommendationRules: purchaseRules, currentRules: { ...purchaseRules, packSize: 200 }, quotedPieces: 150 });
    expect(review.currentRules).toMatchObject({ orderMultiplePieces: 25, orderMultipleSource: "purchase_uom" });
    expect(review.issues).toEqual([]);
  });
  it("keeps explicitly unstated MOQ and pack distinct from missing historical evidence", () => {
    const unspecified = { ...rules, minimumOrderPieces: null, piecesPerPurchaseUom: null, packSize: null };
    expect(reviewRfqQuantity({ recommendationRules: unspecified, currentRules: unspecified, quotedPieces: 1 })).toMatchObject({ issues: [], currentRules: { minimumOrderPieces: null, orderMultiplePieces: 1, orderMultipleSource: "base_piece" } });
  });
  it("records a change in the authoritative multiple source even with equal numeric value", () => {
    expect(reviewRfqQuantity({ recommendationRules: rules, currentRules: { ...rules, piecesPerPurchaseUom: 50 }, quotedPieces: 150 }).issues).toEqual(["supplier_rules_changed"]);
  });
  it.each([0, -1, 1.5, 2_147_483_648])("rejects invalid quoted pieces %s", (quotedPieces) => {
    expect(() => reviewRfqQuantity({ recommendationRules: rules, currentRules: rules, quotedPieces })).toThrow();
  });
});
