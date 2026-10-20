import { describe, expect, it } from "vitest";
import { pricePreservedOrderDiscounts } from "../../domain/order-edit-preserved-discounts";
import { priceOrderEditPreviewItems } from "../../domain/order-edit-preview-pricing";
import {
  previewContext,
  PREVIEW_LINE,
  PREVIEW_VARIANT,
} from "../fixtures/order-edit-preview.fixture";
import { toOrderEditPreviewPricingInput } from "../../application/order-edit-preview-pricing-input";

const input = () => ({
  rules: [{ key: "code:reward", label: "Reward" }],
  originals: [{ id: "original", quantity: 1 }],
  allocations: [
    { lineId: "original", ruleKey: "code:reward", amountCents: 279 },
  ],
  lines: [
    {
      id: "native-1",
      originalLineId: "original",
      quantity: 1,
      subtotalCents: 279,
    },
    { id: "native-2", originalLineId: null, quantity: 1, subtotalCents: 449 },
  ],
});
describe("preserved native checkout allocations", () => {
  it("keeps 279 cents on the original item and does not spend the reward again on additions", () => {
    const original = input();
    const result = pricePreservedOrderDiscounts(original);
    expect(result.subtotalAfterOrderDiscountsCents).toBe(449);
    expect(result.allocations).toEqual([
      { lineId: "native-1", ruleKey: "code:reward", amountCents: 279 },
    ]);
    expect(result.unusedFixedCredits).toEqual([]);
    expect(original).toEqual(input());
  });
  it("does not move the discount to another item when the original is removed", () => {
    const evidence = input();
    evidence.lines[0].quantity = 0;
    evidence.lines[0].subtotalCents = 0;
    expect(
      pricePreservedOrderDiscounts(evidence).subtotalAfterOrderDiscountsCents,
    ).toBe(449);
  });
  it("rejects provider overuse, changed distribution, duplicate or missing financial evidence", () => {
    for (const observations of [
      [
        { lineId: "native-1", ruleKey: "code:reward", amountCents: 279 },
        { lineId: "native-2", ruleKey: "code:reward", amountCents: 444 },
      ],
      [
        { lineId: "native-1", ruleKey: "code:reward", amountCents: 278 },
        { lineId: "native-2", ruleKey: "code:reward", amountCents: 1 },
      ],
      [],
      [
        { lineId: "native-1", ruleKey: "code:reward", amountCents: 279 },
        { lineId: "native-1", ruleKey: "code:reward", amountCents: 0 },
      ],
    ])
      expect(() =>
        pricePreservedOrderDiscounts({ ...input(), observations }),
      ).toThrow();
  });
  it("requires exact proration and treats increased quantities as new items", () => {
    const evidence = input();
    evidence.originals[0].quantity = 2;
    expect(() => pricePreservedOrderDiscounts(evidence)).toThrow();
    evidence.allocations[0].amountCents = 278;
    expect(pricePreservedOrderDiscounts(evidence).orderDiscountCents).toBe(139);
    evidence.lines[0].quantity = 3;
    expect(() => pricePreservedOrderDiscounts(evidence)).toThrow();
  });
  it("previews an original fixed reward at its actual allocation regardless of face value", () => {
    const context = previewContext();
    context.snapshot.discountRules![1].value = {
      type: "fixed",
      amountCents: 72300,
    };
    const result = priceOrderEditPreviewItems(
      toOrderEditPreviewPricingInput(context),
      {
        changes: [{ lineItemId: PREVIEW_LINE, quantity: 2 }],
        additions: [],
      },
    );
    expect(
      result.discounts.find((discount) => discount.key === "code:Reward")
        ?.amountCents,
    ).toBe(1900);
    expect(
      result.lines.find((line) => line.id === PREVIEW_LINE)?.netCents,
    ).toBe(10099);
    expect(
      result.lines.find((line) => line.id !== PREVIEW_LINE)?.netCents,
    ).toBe(11999);
    expect(
      result.lines.every((line) => line.variantId === PREVIEW_VARIANT),
    ).toBe(true);
  });
});
