import { describe, expect, it } from "vitest";
import { readShopifyOrderEditTaxLines, shopifyOrderEditTaxLineSchema } from "../../infrastructure/shopify-order-edit-taxes";

const taxLine = (ratePercentage: number | null = 6) => ({
  title: "State tax", ratePercentage,
  priceSet: { shopMoney: { amount: "8.77", currencyCode: "USD" as const }, presentmentMoney: { amount: "8.77", currencyCode: "USD" as const } },
});
describe("Shopify tax rate adapter", () => {
  it.each([null, 0, 6, 8.875])("preserves the native percentage %s and exact cents without inferring a rate", rate => {
    const input = taxLine(rate);
    const before = structuredClone(input);
    expect(readShopifyOrderEditTaxLines([shopifyOrderEditTaxLineSchema.parse(input)])).toEqual([{title: "State tax", ratePercentage: rate, amountCents: 877}]);
    expect(input).toEqual(before);
    expect(readShopifyOrderEditTaxLines(undefined)).toBeUndefined();
  });
  it("rejects converted or fractional-cent tax evidence", () => {
    const converted = taxLine();
    converted.priceSet.presentmentMoney.amount = "8.78";
    expect(() => readShopifyOrderEditTaxLines([converted])).toThrowError("The tax amounts do not match");
    const fractional = taxLine();
    fractional.priceSet.shopMoney.amount = "8.775";
    expect(() => readShopifyOrderEditTaxLines([fractional])).toThrowError("The amount cannot be represented exactly");
  });
  it.each([-1, 101, NaN, Infinity, "6", undefined])("rejects invalid native rates %s", ratePercentage => {
    expect(shopifyOrderEditTaxLineSchema.safeParse({...taxLine(), ratePercentage}).success).toBe(false);
  });
});
